# 生产环境部署方案 · 最终汇总与执行清单

> 本文档由「问答式部署前分析流程」汇总而成。
> 范围：**仅分析与配置准备，不修改代码、不执行服务器操作**。
> 适用：当前 dev/test 与生产环境同在 **同一台服务器**，要求严格隔离。

---

## 一、已确认的架构决策（问答结论）

| 项 | 决策 | 依据 |
|---|---|---|
| 子域/租户 | 单子域 + 路径租户（`/<school_code>/...`），超管与租户同域同代码 | Q1–Q3 |
| HTTPS | Caddy 自动签发 + 自动续期 Let's Encrypt（90 天透明） | Q4 |
| 具体域名 | 部署前再定，变量预留不阻塞 | Q5 |
| CORS | 填具体子域 Origin（单值即可，代码拒绝 `*`） | Q5 |
| 多租户 | 首批少量 + 运营中后台动态加，每校独立 `school_<code>` schema | Q6 |
| 备份 | 本地主密钥 `BACKUP_MASTER_KEY`（部署自动生成，fail-closed） | Q7 |
| 日志 | 数据盘 + 大小上限轮转 + 接近上限告警 | Q8 |
| 实例 | 单实例 systemd（进程内存状态有效） | Q9 |
| 数据盘 | `/mnt/datadisk0`（已确认挂载 + fstab 持久化） | Q10 |
| 安全组 | 22/80/443 公网；8080 仅内网；5432 绝不公网 | Q11/Q12 |
| JWT | 独立生产实例 + 自动生成全新密钥 | Q13 |
| 隔离 | 生产 `SYSTEM_NAME=foodtestlabprod` 独立目录/库/服务 | Q13 |
| 监控 | 基础够用（systemd 重启 + 备份告警 + 日志告警） | Q14 |
| 验证 | 五项全做 | Q15 |

---

## 二、最终判定

**🟢 可部署（配置就绪，部署前补齐下方清单）。无 🔴 阻断项。**

---

## 三、部署前准备清单（纯配置/运维，不动代码）

### 1. 决定生产子域名
- 部署前确定，例如 `app.foodtest.com`。
- 填到生产适配文件的 `DOMAIN`、`TLS_EMAIL`、`CORS_ORIGIN`。

### 2. 新建生产适配文件 `deploy.foodtestlabprod.conf`
- 复制 `deploy/deploy.adapter.example.conf` 或现有 `deploy.foodtestlab.conf`。
- **关键：与 dev/test 错开，避免同机冲突**：

| 字段 | dev/test（现状） | 生产（建议） |
|---|---|---|
| `SYSTEM_NAME` | `foodtestlab` | `foodtestlabprod` |
| `REPO_ROOT` | `/opt/foodtestlab` | `/opt/foodtestlabprod` |
| `DATA_DIR` | `/mnt/datadisk0/foodtestlab/data` | `/mnt/datadisk0/foodtestlabprod/data` |
| `LOG_DIR` | `/mnt/datadisk0/foodtestlab/logs` | `/mnt/datadisk0/foodtestlabprod/logs` |
| `API_PORT` | `3000` | `3001`（错开） |
| `FRONTEND_PORT` | `8080`（明文） | `443`（HTTPS，填 DOMAIN 后脚本自动用 443） |
| `PG_DB_NAME` | `foodtestlab` | `foodtestlabprod` |
| `PG_USER` | `foodtestlab` | `foodtestlabprod` |
| `APP_NAME` | `foodtestlab-api` | `foodtestlabprod-api` |
| `DOMAIN` | `""` | `app.foodtest.com` |
| `TLS_EMAIL` | `""` | `你的邮箱` |
| `CORS_ORIGIN` | 自动推断 | `https://app.foodtest.com` |
| `SCHOOL_CODES` | `""` | 逗号分隔首批代码，如 `tianjiabing,shiyan` |
| `REQUIRED_MOUNT` | `/mnt/datadisk0` | 同左（已确认存在） |
| `BACKUP_DIR` | 默认 | `/var/backups/foodtestlabprod` |

> ⚠️ `SCHOOL_CODES` 必须**逗号**分隔（代码 `seed.js`/`server.js` 按逗号切分），`deploy.sh` 注释写的"空格"是错误示例，勿照抄。

### 3. 云安全组（控制台操作）
- 放行：**22**（SSH）、**80**（Let's Encrypt 签发/重定向）、**443**（HTTPS）。
- **不放**：8080、3000、3001、5432。后端仅经 Caddy 内网 `127.0.0.1` 反代可达。

### 4. logrotate 规则（部署后放 `/etc/logrotate.d/foodtestlabprod`）
> 作用：数据盘日志按大小轮转 + 压缩 + 保留，防盘满。
```
/mnt/datadisk0/foodtestlabprod/logs/*.log {
    size 200M
    rotate 10
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su foodtestlabprod foodtestlabprod
}
```
> 说明：`copytruncate` 兼容正在 append 的 systemd 文件日志；`su` 用生产系统用户避免权限问题。部署后 `logrotate -d /etc/logrotate.d/foodtestlabprod`  dry-run 验证。

### 5. 日志接近上限告警脚本（部署后放，cron 每小时跑）
保存为 `/opt/foodtestlabprod/scripts/log-size-alert.sh`，crontab `0 * * * * bash /opt/foodtestlabprod/scripts/log-size-alert.sh`：
```bash
#!/usr/bin/env bash
# 日志目录接近上限告警：超过阈值（默认 5G）即写日志 + 可选 webhook
LOG_DIR="/mnt/datadisk0/foodtestlabprod/logs"
THRESHOLD_GB=5
WEBHOOK="${LOG_ALERT_WEBHOOK:-}"   # 可选：企业微信/钉钉机器人
USED_GB=$(du -sG "$LOG_DIR" 2>/dev/null | awk '{print $1}')
if [ -n "$USED_GB" ] && [ "$USED_GB" -ge "$THRESHOLD_GB" ]; then
  MSG="[告警] 生产日志目录 $LOG_DIR 已用 ${USED_GB}G，超过阈值 ${THRESHOLD_GB}G，请检查 logrotate 是否生效"
  echo "$(date '+%F %T') $MSG" >> "$LOG_DIR/alert.log"
  [ -n "$WEBHOOK" ] && curl -s -X POST "$WEBHOOK" -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$MSG\"}}" >/dev/null 2>&1
fi
```

### 6. 清理旧 Caddy 片段
- 生产机（若为全新机可忽略）；当前 dev 机 `/etc/caddy/sites/` 有多份 `.caddy.bak-*`，若复用本机部署生产，**只保留 `foodtestlabprod-api.caddy`**，其余 `.bak` 移走，避免 `import *.caddy` 误加载。

### 7. 备份密钥异地保存
- 部署后，**把生产 `.env` 里的 `BACKUP_MASTER_KEY` 单独抄一份存到安全地方**（密码管理器/离线）。一旦丢失，已加密 `.aes` 备份永久无法解密。

---

## 四、上线后验证清单（Q15 全选，必须逐条过）

1. ✅ 真实账号登录：用 seed 的 admin/operator/viewer 各登一次。
2. ✅ 访客只读验证：访客快速进入，确认无导出/病原体/注册入口（前轮重构收敛）。
3. ✅ 路径租户验证：访问 `/<school_code>/login` 确认多租户路径识别正常。
4. ✅ 备份手动跑一次：`node backend/scripts/003_backup-now.mjs --all` 确认加密备份成功。
5. ✅ 后端日志无报错：`journalctl -u foodtestlabprod-api -n 50`。

---

## 五、部署命令（你来执行，脚本已支持）

```bash
# 1. 上传/放置生产适配文件
sudo bash deploy.sh /opt/deploy/deploy.foodtestlabprod.conf

# 2. 部署后补 logrotate + 日志告警（见第三节 4/5）
# 3. 逐条验证（见第四节）
```

> 重部署（更新代码）只需重跑同一条命令，幂等：保留 `.env`、跳过 seed、租户增量同步。

---

## 六、已知风险备忘（黄项，不阻断）

- **单实例约束**：限流/幂等/安全告警游标存进程内存，单实例正确；未来多实例必须先迁 Redis。
- **健康检查超时仅 warn**：部署脚本健康检查失败不阻断，务必手动走第四节验证。
- **seed 失败仅 warn**：可能出现"服务健康但登录不了"，验证第 1 条必做。
- **系统盘已用 63%**：当前 dev 机 `/` 占用偏高，生产实例目录/构建在系统盘，留意别撑爆（数据在独立盘）。
- **同机端口错开**：生产与 dev 同机，务必按第三节 2 错开端口，否则冲突中止。

---

_文档生成于问答式分析流程结束，作为生产部署前的配置与执行参考。不涉及代码改动与服务器操作。_
