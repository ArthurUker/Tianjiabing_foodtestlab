# 数据备份与恢复模块 · 部署与运维手册（P0）

> 适用：田家炳食品检验系统（腾讯云 CVM，Ubuntu 22.04，PostgreSQL 14，Schema-per-tenant）。
> 本文档对应 P0 备份引擎（`backend/lib/backupService.js` + `backend/scripts/003_backup-now.mjs`）。
> 完整设计见方案文档（RPO/RTO、逻辑备份选型、影子恢复等，P1+ 阶段实施）。

---

## 1. 总体架构（P0 落地形态）

```
生产库 PostgreSQL ──pg_dump(02:00)──► .sql.gz ──AES-256-GCM 信封加密──► .aes + meta.json
   （数据盘）                            （系统盘 /var/backups/foodtestlab）
                                                 │
                              ┌──────────────────┴─────────────────┐
                    备份文件（防数据盘故障）               云硬盘定期快照（防整机故障，控制台配置）
                                                 │
                              （P3 可选：COS 长期归档 30 天）
```

- **第一层**：每日 02:00 全库逻辑备份（本模块实现，systemd timer 驱动）。
- **第二层**：腾讯云数据盘定期快照（控制台开启，见第 4 节）——开箱即用、零代码。
- 两层互补：逻辑备份支持单校恢复 / 跨版本；物理快照恢复整机最快。

---

## 2. 部署集成（deploy.sh 已内置）

`deploy.sh` 已新增 §8.5：自动写入 `systemd` 备份 timer 并启用。

```
/etc/systemd/system/<name>-backup.service   # oneshot：node scripts/003_backup-now.mjs --all
/etc/systemd/system/<name>-backup.timer     # 每日 02:00 + Persistent + 随机延迟 300s
```

默认配置（可被部署适配文件覆盖）：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/<system_name>` | **系统盘**（与数据盘物理分离） |
| `BACKUP_KEEP_DAYS` | `7` | 本地保留天数，过期自动清理 |

**部署后检查**：

```bash
systemctl list-timers | grep backup          # timer 是否启用
sudo -u <system_name> journalctl -u <name>-backup -n 30   # 查看最近一次备份日志
ls -la /var/backups/<system_name>/<YYYY-MM-DD>/           # 产物 .aes + .meta.json
```

---

## 3. 加密主密钥配置（必做，fail-closed）

备份引擎无密钥**拒绝执行**（不产生明文备份）。生产环境必须配置其一：

### 模式 A（生产推荐）：腾讯云 KMS 信封加密

1. 开通 [KMS 控制台](https://console.cloud.tencent.com/kms)，创建对称 CMK，记下 **KeyId** 与 **地域**（如 `ap-guangzhou`）。
2. 创建 CAM 子账号，授权最小权限 `kms:Encrypt` + `kms:Decrypt`，获取 **SecretId / SecretKey**。
3. 安装 SDK：`cd backend && npm i tencentcloud-sdk-nodejs`。
4. 在 `backend/.env`（生产由 deploy.sh 生成后手动补写，注意 `chmod 600`）：

```bash
TENCENT_SECRET_ID=xxxx
TENCENT_SECRET_KEY=xxxx
TENCENT_KMS_REGION=ap-guangzhou
TENCENT_KMS_KEY_ID=xxxx
```

> ⚠️ **重要**：`deploy.sh` 每次重新部署会**重写 `backend/.env`**（覆盖模式），
> 运维补写的 `TENCENT_*` / `BACKUP_MASTER_KEY` 在重部署后**需重新补写**。建议把密钥单独保存
> 在部署机的 `/root/.foodtestlab-backup-secrets.env` 并纳入自己的部署后置脚本，避免重复录入。

### 模式 B（仅开发/过渡）：本地主密钥

```bash
BACKUP_MASTER_KEY=$(openssl rand -base64 32)   # 写入 backend/.env（务必持久化保存）
```

> ⚠️ 模式 B 主密钥以明文存在于服务器，仅限本地/无 KMS 的过渡期；生产上线前必须切换模式 A。
> **密钥必须持久化**：`BACKUP_MASTER_KEY` 是解密的唯一凭证，若未写入 `.env`（仅 shell 临时变量）且进程退出后丢失，
> 已生成的备份将**永远无法解密**。用 `.env` 持久化（勿提交仓库）。

---

## 4. 腾讯云数据盘定期快照（防整机故障）

> 属于云平台能力，与代码无关，控制台操作约 5 分钟，投入产出比最高。

1. 登录[云服务器控制台](https://console.cloud.tencent.com/cvm) → **存储 → 快照**。
2. 创建**定期快照策略**：
   - 执行时间：每日 02:30（避开业务高峰；如与 pg_dump 冲突可错开）；
   - 保留规则：按数量保留最近 7 份（或按天 30 天）；
   - 关联云硬盘：选择**数据盘**（PostgreSQL 数据所在盘）。
3. 计费：按快照存储量计费（增量快照，日常成本极低）。
4. 验证：策略生效后等待一次执行，在快照列表确认状态为"已创建"。

> 说明：云硬盘快照是整盘块级副本，**不能单校恢复**；单校恢复能力由第 1 节的 pg_dump 逻辑备份提供。

---

## 5. 手动触发与校验

```bash
# 全库备份（与 timer 相同）
cd backend && node scripts/003_backup-now.mjs --all

# 单校备份
node scripts/003_backup-now.mjs --school demo

# 只预览计划（不执行）
node scripts/003_backup-now.mjs --all --dry-run

# 离线验证备份文件可恢复性（P0 自动验证闭环，不依赖生产库）
node scripts/004_backup-verify.mjs /var/backups/<system_name>/<date>/school_demo.xxx.sql.gz.aes
```

**校验产物**：

```bash
# ① 文件结构
ls -la /var/backups/<system_name>/$(date +%F)/

# ② BackupRun 记录（public schema）
psql -U <user> -d <db> -c 'SELECT id, scope, school_code, file_size, status, verify_status, created_at FROM public."BackupRun" ORDER BY created_at DESC LIMIT 5;'

# ③ 离线验证（004_backup-verify.mjs）：解密 + sha256 + gunzip + 表数对比
```

**预期输出**：
- 备份：`L1 校验通过（gzip 完整，CREATE TABLE=N）`、`BackupRun` 记录 `status=ok, verify_status=passed`。
- 验证：`004_backup-verify ✅ 验证通过：该备份文件可解密、可解压、结构完整`。

**备份失败告警**：失败自动写入 `public.SystemLog`（`SECURITY:BACKUP_FAILED`，level=error），
由现有安全告警扫描器（每 5 分钟）推送企业微信/钉钉 webhook——无需额外配置。

---

## 6. 恢复（P1 影子恢复上线前的应急流程）

> ⚠️ 以下为应急手动恢复，P1 将提供控制台 + 影子恢复（临时 schema 校验后原子切换）。

```bash
# 1. 解密 .aes → .sql.gz（需 meta.json 同目录；用部署时的主密钥）
#    恢复工具脚本（P1 提供）或手动：
#    node --input-type=module -e "import fs from'node:fs';import{decryptFile}from'./lib/backupKms.js';..."

# 2. 恢复到临时 schema 校验（不直接覆盖）
psql -U <user> -d <db> -c 'CREATE SCHEMA IF NOT EXISTS "school_<code>_restore";'
#    将 .sql.gz 解压后把 CREATE SCHEMA "school_<code>" 替换为 "school_<code>_restore"，再执行
psql -U <user> -d <db> -f restored.sql

# 3. 校验行数（对照 meta.tableCounts）
# 4. 原子切换（单事务，零窗口）
psql -U <user> -d <db> -c 'BEGIN; ALTER SCHEMA "school_<code>" RENAME TO "school_<code>_old_<ts>"; ALTER SCHEMA "school_<code>_restore" RENAME TO "school_<code>"; COMMIT;'

# 5. 验证连通后清理旧 schema（保留 24h 观察）
```

---

## 7. 常见问题

| 现象 | 原因与处理 |
|---|---|
| timer 到点但无备份文件 | 检查 `journalctl -u <name>-backup`：多为未配置加密主密钥（fail-closed 拒绝） |
| `pg_dump 失败（exit=1）` | `DATABASE_URL` 缺失/错误；或 pg_dump 与 PG 版本不匹配（生产用 `/usr/lib/postgresql/14/bin/pg_dump`，`PG_DUMP_BIN` 可指定） |
| `L1 校验失败：CREATE TABLE 数量不符` | 备份了空库/半库，检查数据库连接与 schema 状态；此备份标记失败，不应用它恢复 |
| 本地磁盘空间告警 | `BACKUP_KEEP_DAYS` 调小；或把 `BACKUP_DIR` 指向更大容量盘；观察 `df -h` |
| meta.json 缺失 | 恢复必须有 meta.json（含 DEK 密文），丢失则无法解密 → 备份文件与 meta 必须成对保管 |

---

## 8. 已知约束与待确认项

**已确认（部署适配文件）**：
- 服务器：腾讯云 CVM **2 vCPU / 3.5GiB 内存**，系统盘 49G（备份目录所在）+ 数据盘 /mnt/datadisk0 49G。
- **验证策略**：因内存仅 3.5G，**不启动独立 PG 验证实例**。P0 采用「离线验证」（004_backup-verify.mjs：解密+sha256+gunzip+表数对比，零 DB 依赖）；
  完整恢复演练（影子恢复）在 P1 落地，届时在生产库内临时 schema 做，并保留 `school_*_restore` 白名单命名与失败自动 DROP 的兜底。

**待确认项**：
- [ ] 生产各校实际数据量（校准 RPO/RTO 与备份窗口）
- [ ] KMS / COS 控制台开通状态（KMS 为本模块生产加密前置）
- [ ] PostgreSQL 具体小版本（如 14.11）

**跨版本恢复限制（PG 18 实测发现）**：`pg_dump 18+` 生成的 dump 头部含 `\restrict <token>` psql 元命令，
**PG 14 的 psql 不识别会报错**。生产链路（PG14 的 pg_dump → PG14 的 psql）不受影响；
但任何跨机器/跨版本搬运备份时，必须保证**恢复端 psql 版本 ≥ 备份端 pg_dump 版本**。

## 9. 阶段路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 备份引擎 + timer + 加密 + L1 校验 + BackupRun | ✅ 本模块（已实现） |
| P1 | 控制台 UI + 恢复 API + 影子恢复 + 维护模式 | 待排期 |
| P2 | WAL 归档（RPO 15min）+ 业务快照 + 跨校克隆 | 待排期 |
| P3 | COS 归档 + HTTPS 化 + 演练报告 | 待排期 |
