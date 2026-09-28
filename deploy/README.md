# 通用部署方案说明（deploy/）

## 目标
把原来写死在 `deploy.ps1`（Windows、珠海一中专用）的部署逻辑，改成：
- **一份通用脚本 `deploy.sh`**：只负责部署流程，不含任何学校名 / 端口 / 路径硬编码。
- **一份适配文件 `deploy.<系统名>.conf`**：只描述“这一套环境长什么样”。换用户、换服务器、换系统，只改适配文件。

## 文件清单
| 文件 | 作用 |
|------|------|
| `deploy.sh` | 通用部署脚本（bash，适配 Ubuntu 22.04/24.04） |
| `deploy.adapter.example.conf` | 适配文件模板，复制后改名填写 |
| `README.md` | 本说明 |

> 旧的 `deploy.ps1` 保留不动，仅用于原有 Windows 服务器。新 CVM（Linux）用 `deploy.sh`。

## 技术选型（依据你的选择）
- 操作系统：Ubuntu 22.04/24.04 LTS
- 反向代理：Caddy（有域名自动申请 Let's Encrypt HTTPS；无域名先监听 `:80`）
- 进程托管：**systemd**（Linux 原生，开机自启；已确定不用 PM2）
- 数据库：PostgreSQL（单实例，多学校按 schema 隔离；开发/测试/生产统一）
- 运行时：脚本自动安装（NVM 装 Node 20 LTS + Caddy + Git）

## ⚠️ 部署前置（必须手动完成，脚本无法代劳）
1. **腾讯云安全组**：脚本只管 OS 内部监听，不碰云平台网络。请登录腾讯云控制台，确认实例安全组已放行 **TCP 22 / 80**（补域名后还需 **443**）。漏配会导致「本机 `curl 127.0.0.1` 健康检查通过，但外部浏览器访问超时」的假阳性。
2. **数据盘持久化挂载**：若 `DATA_DIR` 指向独立数据盘（如 `/mnt/datadisk0`），请确认它已写入 `/etc/fstab` 持久化。脚本会检查该挂载点是否存在，未挂载则**直接中止**（不静默写回系统盘）。
   ```bash
   grep datadisk0 /etc/fstab || echo "未配置持久化挂载，重启会丢失挂载点"
   ```
3. **外网出站**：脚本启动即预检 `github.com` 与 `registry.npmjs.org` 连通性，不通会提前中止，避免跑到一半才发现拉不到代码/依赖。

## 多用户同机部署（不同端口访问）
同一台服务器可以给多个用户 / 多套系统各自独立部署，互不干扰：
- 每个用户一份独立适配文件 `deploy.<用户>.conf`，其中 **`FRONTEND_PORT`（公网访问端口）与 `API_PORT`（后端端口）必须全服务器唯一**。
- 目录天然隔离：`REPO_ROOT` / `DATA_DIR` / `LOG_DIR` 都按 `SYSTEM_NAME` 区分。
- systemd 服务按 `APP_NAME` 区分，互不影响。
- Caddy 采用 **主配置 `import` 站点目录** 模式：每个用户一份 `/etc/caddy/sites/<APP_NAME>.caddy` 片段，互不覆盖；新增 / 重跑某用户不会冲掉其它用户的站点。
- 脚本会**预检端口冲突**（扫描已有 Caddy 站点片段与监听端口），撞端口直接中止。
- 每个用户的 `FRONTEND_PORT` 都需在腾讯云安全组单独放行。

新增一个用户只需：复制适配文件 → 改 `SYSTEM_NAME` / `FRONTEND_PORT` / `API_PORT` / 各目录 → 重跑 `sudo bash deploy.sh deploy.<新用户>.conf`。

## 最小分发清单（必须保持相对路径）

部署包 = **3 项**（放在 `/opt/deploy/` 之类稳定目录，**不要放进代码仓库目录**）：

| 相对分发包根的路径 | 作用 | 来源 |
|---|---|---|
| `deploy.sh` | 部署主脚本 | 仓库 `deploy/deploy.sh` |
| `lib/jwt-config.sh` | JWT 共享库；`deploy.sh` 启动时强制检查其存在/可读/加载/必需函数 | 仓库 `deploy/lib/jwt-config.sh` |
| `deploy.<系统>.conf` | 本环境的适配文件（不含真实密钥） | 由 `deploy.adapter.example.conf` 复制填写 |

> - **`lib/jwt-config.sh` 不能漏传**：缺失 / 是目录 / 不可读 / 加载失败 / 缺必需函数，都会让 `deploy.sh`
>   在**任何部署副作用（读适配配置、装运行时、动系统服务/数据库、clone 代码）之前**以固定原因非零退出。
> - 后端 JS 模块（`backend/lib/jwtSecretConfig.js`、`backend/lib/jwtSecretResolve.js`、
>   `backend/scripts/validate-jwt-secrets.mjs`）由脚本 `§4` clone 到的代码版本提供，**不需要**放进分发包。
> - 分发包中**不得**包含任何真实密钥；JWT 值经环境变量或 `backend/.env`（0600）流转，不进入 argv/日志。

## 在腾讯云新 CVM 上的使用步骤
1. 买好 CVM，安全组放行 **22**（SSH）、**80**（HTTP；若用域名还要 **443**）。
2. SSH 登录，把分发包按上面的「最小分发清单」传上去（保持 `deploy.sh` 与 `lib/` 的相对位置）：
   ```bash
   scp -r deploy/deploy.sh deploy/lib deploy/deploy.adapter.example.conf root@<公网IP>:/opt/deploy/
   # 若目标目录已存在旧包，请同步更新 lib/jwt-config.sh（与 deploy.sh 同版本）
   ```
3. 复制并填写适配文件（`<系统>` 为你的系统标识，如按 `SYSTEM_NAME` 命名）：
   ```bash
   cd /opt/deploy
   cp deploy.adapter.example.conf deploy.<系统>.conf
   vim deploy.<系统>.conf   # 至少确认 SYSTEM_NAME / REPO_URL / DEPLOY_BRANCH / API_PORT
   ```
4. 一键部署：
   ```bash
   sudo bash deploy.sh /opt/deploy/deploy.<系统>.conf
   ```

## 适配文件关键字段
| 字段 | 含义 |
|------|------|
| `SYSTEM_NAME` | 系统标识，驱动目录/服务名/用户名（生产为 `foodsentinel` → `/opt/foodsentinel`、`foodsentinel-api.service`、用户 `foodsentinel`；本生产的该文件位于服务器 `/opt/deploy/deploy.foodsentinel.conf`，含密钥不入仓库） |
| `REPO_URL` / `DEPLOY_BRANCH` | 代码来源与分支 |
| `API_PORT` | 后端内部端口（127.0.0.1），Caddy 反代到此 |
| `FRONTEND_PORT` | 用户公网访问端口（Caddy 对外监听），全服务器必须唯一 |
| `DOMAIN` / `TLS_EMAIL` | 留空 = 仅 HTTP `:80`；填了 = 自动 HTTPS |
| `JWT_SECRET` / `SEED_*_PASSWORD` | 留空则脚本自动生成强随机值 |
| `INSTALL_RUNTIME` | `true` 时脚本自动装 Node/Caddy/Git |
| `ENABLE_SWAP` | `true` 强制开 / `false` 不开 / `auto` 内存<2G 自动开 |
| `SERVICE_MEMORY_MAX` | 后端内存上限(MB)；留空=按服务器内存自适应 |
| `REQUIRED_MOUNT` | 数据盘挂载点；非空时未挂载则中止，防止数据静默写回系统盘 |
| `ACCEPT_DATA_LOSS` | ⚠️ **已废弃（dead config）**：脚本读取后无任何消费方——public 结构演进走 `prisma migrate deploy`；租户结构自 P3-W2-T02-R2 起改为**按版本化迁移链逐租户回放 + 逐租户台账**（无 `db push`、无 accept-data-loss 通道），**不读该字段**。保留仅为兼容既有适配文件，改它不改变行为 |
| `PROVISION_TENANTS` | `true` 时首部署初始化多租户：为每个学校建 `school_<code>` schema、按版本化迁移链回放业务表、写 `public` 系统记录、建租户 admin |
| `SCHOOL_CODES` | 逗号分隔的学校代码；留空 = 仅用 `public` 共享 schema（最简模式，开发/测试或单校试用） |
| `SCHOOL_NAME_<code>` | 可选，学校显示名 |

## 按服务器性能自适应（无需手动调参）
脚本启动即探测内存/CPU，自动决定资源规划（适配文件可覆盖）：

| 服务器内存 | 是否开 swap | 后端 MemoryMax | Node 堆上限 |
|-----------|------------|----------------|-------------|
| ≤ 1G      | 自动开     | 384M           | 288M        |
| ≤ 2G      | 自动开     | 768M           | 576M        |
| ≤ 4G      | 否         | 1024M          | 768M        |
| > 4G      | 否         | 1536M          | 1152M       |

- 内存上限通过 `systemd MemoryMax` + `NODE_OPTIONS=--max-old-space-size` 双重约束，低配机不会因构建/`prisma generate` 把内存吃爆。
- 若服务器挂了独立数据盘，把适配文件里的 `DATA_DIR` 指向数据盘挂载点（如 `/data/<名>`）。脚本在 PostgreSQL 启动后会**自动把 PG 数据目录迁移到 `$DATA_DIR/pgdata`**（用软链替还原路径，对 PG 透明），系统盘只放代码。仅当配置了 `REQUIRED_MOUNT` 时才迁移。

## 后续加域名（切 HTTPS）
在适配文件填 `DOMAIN=你的域名`、`TLS_EMAIL=你的邮箱`，重跑：
```bash
sudo bash deploy.sh /opt/deploy/deploy.<系统>.conf
```
脚本会生成带 `email` 全局块的 Caddyfile 并自动签发证书（需域名 A 记录指向公网 IP、安全组放行 443）。

## 重新部署 / 更新代码
同一台机器上重跑同一个命令即可：脚本会 `git fetch + reset` 拉最新代码、重装依赖、重建前端、平滑重启服务。`backend/.env` 会被保留（不在 `git clean` 范围），但部署会按适配文件重写关键变量。

## 数据库结构演进（prisma migrate）——AUD-008 / RC-04 纪律

**唯一入口**：`public` 结构变更只允许走 `backend/prisma/migrations/`（部署时由 `deploy.sh` 执行 `npx prisma migrate deploy`）。
禁止再用运行时 DDL / `db push` 改 `public`（历史上由此产生的漂移已由补丁迁移
`20260726100000_add_customization_columns_if_missing` 沉淀回链，链末状态与 `schema.prisma` 零差异）。

- **部署时的迁移段行为**（`deploy.sh` §6，**P3-W2-T01-R2 / RC-04 现行契约**）：
  1. `prisma migrate deploy` 的 stdout/stderr **全部保留**在部署日志（不加任何重定向）；
  2. 迁移成功 → 继续部署；
  3. 迁移失败（**任何情况**，含首部署）→ **保留现场、非零停止**：不自动 `migrate resolve`（`--rolled-back` / `--applied` 均不自动执行）、不清理 failed 记录、不 `db push`、不传 `--accept-data-loss`；旧版本继续服役；
  4. 失败后只做**只读诊断**（不改任何数据），按现场分类并指向处置手册：
     - **A 全新空库**：无迁移历史且 `public` 无表；
     - **B 既有库未接入迁移链**（疑似 P3005）：无迁移历史但已有表；
     - **C failed migration**（P3009）：存在未完成记录，并给出**部分执行**的已执行步数提示；
     - **D 普通迁移失败**：迁移历史存在、无 failed 记录。

     处置入口 = **`deploy/MIGRATION_FAILURE_RUNBOOK.md`**：先人工只读核实（尤其部分执行的实际效果），再按场景选择人工命令；重跑部署前不得跳过迁移；
  5. 注意：「`public."User"` 不存在」仅用于 seed 门禁与诊断提示，**不得**当作「数据库为空 / 可以回退重建」的证据（既有库可能未登记迁移链，或只有部分结构）。

### 既有库接入迁移链（P3005，人工核实后执行）

老库（此前由 `db push` 演进）若从未登记迁移链，`migrate deploy` 会以 **P3005**（`The database schema is not empty`）拒绝执行。
**部署脚本不会自动接入**（失败即非零停止，诊断场景 B）；接入属人工决策，步骤详见 `deploy/MIGRATION_FAILURE_RUNBOOK.md` §3-B：

1. 先备份；人工核对现有结构与数据是否与 `20260726000000_baseline` 语义一致（含列类型/默认值/约束——`IF NOT EXISTS` 只解决名称存在，不证明语义一致）；
2. 一致 → 人工执行下面两条；不一致 → 按 RC-04 走 bridge/repair 流程，**不得**直接 `--applied` 强行跳过：

```bash
cd /opt/<SYSTEM_NAME>/backend
npx prisma migrate resolve --applied 20260726000000_baseline   # 仅登记，不重复建表（人工核实后）
npx prisma migrate deploy                                      # 之后按链应用增量（本仓库链已可空库全量回放）
```

### failed migration（P3009，人工核实后解除）

若某次 `migrate deploy` 中途失败，Prisma 会在 `_prisma_migrations` 留下 failed 记录，之后所有 `migrate deploy` 都被 **P3009** 阻断。
**部署脚本不会自动 resolve**（旧版「首部署自动回退」已按 RC-04 整体移除）：失败即非零停止 + 只读诊断（场景 C）；处置详见 `deploy/MIGRATION_FAILURE_RUNBOOK.md` §3-C：

1. 先备份；读 failed 记录明细，并**逐项核实该 migration 在库中的实际效果**（要建/改的对象是否已存在、数据是否已改）；
2. 结论分流：
   - 确认未产生实际效果（或残留可安全消除）→ 人工执行下面两条命令；
   - **已产生部分真实效果** → **不得** rolled-back 了当跳过，须先人工对齐到完成态（或编写承接 migration）后再处置；

```bash
psql -h <host> -U <user> -d <db> -c \
  "SELECT migration_name, applied_steps_count FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"
npx prisma migrate resolve --rolled-back <migration_name>   # 标记为已回滚 → 下次 deploy 会重新应用（人工核实后）
```

3. 台账登记：迁移名 / `applied_steps_count` / 核实人 / 结论。

### 租户 schema 同步（§6.55, `npm run db:sync`）

> **实施状态（2026-09-26，R7 复审后）**：逐租户版本化推进由两段构成——**P3-W2-T02-R3 的迁移分类协议**
> （文件头 `-- @scope: both|public` 必需、无缺省；语句级 `-- @tenant-skip:` / `-- @tenant-scoped:`；
> 含 catalog 引用且未分类的语句 → `TENANT_PROJECTION_UNCLASSIFIED` fail-closed）与
> **P3-W2-T02-R4 的运行语义**（移除 `TENANT_READINESS_ATTESTED` 等声明式放行；`AUTO_SYNC_TENANTS=false`、
> 分类失败、public 未知额外对象一律**阻断租户流量**；无台账**不再**自动 baseline；`--rebuild-empty-schema` 撤下）。
> **R7 总控复审仍判 W2-T02-R4 = REWORK**：迁移锁对“父进程死亡但 `psql`/PG 会话仍在执行”的接管边界、
> 人工 `--force-unlock` 的 CAS/TOCTOU、`--baseline-apply` 事后校验失败的边界、`public._tenant_migration_locks`
> 的版本归属，四项均**返工中（W2-R5）**。
> **因此本节描述的是当前实现现状，不构成 RC-04 的完整验收；R4 的自报 `PASS_LOCAL` 不等于总控 PASS。**

`deploy.sh` 在发布前对**全部非删除学校（active + disabled）**推进租户结构，失败即中止部署（旧版本继续运行）。
结构来源 = `backend/prisma/migrations/*` **版本化链（仅追加）**：逐租户**按链顺序回放**（`search_path` 限定目标
schema；文件内跨 schema「扫全库」语句按投影剔除并计数），每个迁移在**逐租户台账** `"<schema>"."_tenant_migrations"`
记录 `name / checksum / status / projection / skipped_sweeps`；回放后再与 public 逐项自证
（表/列/主键/唯一/外键）。**运行期无 `prisma db push`、无末态 diff SQL、不用 public 迁移状态冒充逐租户执行。**

- 存量库（**无台账**）：**不按见证自动 baseline**。台账缺失且 schema 非空 → `TENANT_MIGRATION_STATE_UNPROVABLE`
  （fail-closed、零写入；结构见证只用于**诊断**，不作为版本证据）；接入须走**离线受控证明**：
  `node backend/sync-tenant-schemas.mjs --baseline-plan <code> --out <plan.json>`（只读生成：列类型/可空性/**默认值**、
  主键/唯一/外键/**CHECK 含 `convalidated`**、**全部索引**、视图/物化视图/触发器/函数/序列、额外表、数据语义）
  → 人工按失败项修复 → 重新生成计划直至 `proofOk=true` → `--baseline-apply <code> --evidence <plan.json>`
  （持锁后**现场重算**证明 + 摘要一致才写 `baselined`；现场已变化 → 拒绝重放旧计划）；
- 额外对象：**public 白名单外未知表 = 全局阻断**（`PUBLIC_EXTRA_OBJECTS`；`/api/readyz` 503 **且真实租户 API 503
  `TENANT_MIGRATION_NOT_READY`**）；租户额外表/列/索引/约束 = 阻断该校（`TENANT_EXTRA_OBJECTS`）；
  额外对象**检查自身失败** = `CANNOT_CHECK`（同样阻断）。**任何路径都不自动 DROP**，交人工或 migration 处置；
- 失败即记入台账（`status='failed'` + 脱敏原因）并上抛，**绝不打印成功汇总**；默认不自动重试。

退出码语义（`0/1/2` 契约不变）：`0` 全部推进到链尾 / `1` 任一学校或步骤失败（失败清单逐条打印）/ `2` 配置缺失（`DATABASE_URL` 未设置）。
手工排查：`cd backend && SKIP_PRISMA_GENERATE=1 node sync-tenant-schemas.mjs`；
**只读体检**：`node sync-tenant-schemas.mjs --check`（0 全部就绪 / 1 有阻断 / 2 配置缺失；会列出当前迁移锁）；
人工核实后显式重试失败迁移：`--retry-tenant-migrations`；离线接入：`--baseline-plan <code> --out <plan.json>` /
`--baseline-apply <code> --evidence <plan.json>`；崩溃锁人工清除：`--force-unlock <code> --yes`
（**CAS 语义返工中**：R7 认定展示信息与删除之间可能删到新持有者的锁，见下方“返工中”声明）。
`--rebuild-empty-schema` **已撤下**：仅打印拒绝与人工路径，不再执行任何自动 `DROP SCHEMA`。

#### 启动侧行为（`AUTO_SYNC_TENANTS`，P3-W2-T02-R4 现状；R7 复审：锁/baseline 边界返工中 / RC-04）

| 取值 | 行为 | 是否写库 |
|---|---|---|
| 未设置（**默认**） | 启动**只做只读检测**：public 迁移证明（`_prisma_migrations` pending/failed/checksum）+ 各非删除学校的**逐租户台账**（`_tenant_migrations` name/checksum/status）+ 结构/额外对象（表/列/主键/唯一/外键 vs 迁移链末端）；结果进 `TENANT_SCHEMA_CHECK=OK|DRIFT|INCOMPLETE|CANNOT_CHECK|MIGRATIONS_PENDING|MIGRATION_FAILED` | **不写**（只有 SELECT） |
| `true`（**历史值，语义已废止**） | **同样只做只读检测**（不再启动对齐）；启动日志打印兼容提示 | **不写** |
| `false` | 跳过检测（**仅维护/诊断窗口使用**）：readiness=`NOT_VERIFIED`（`/api/readyz` 503）**且真实租户 API 503 `TENANT_MIGRATION_NOT_READY`**——`false` **不构成放行通道**；声明式放行（`TENANT_READINESS_ATTESTED` 等）已由 R4 移除 | 不写 |

就绪与阻断（RC-04）：**存在 traffic-blocking 全局阻断时（public 迁移 pending/failed/checksum 异常、作用域未声明/
分类失败、public 白名单外未知表、额外对象检查自身失败 `CANNOT_CHECK`、检测超时、`AUTO_SYNC_TENANTS=false`）→
未豁免的租户入口一律 503 `TENANT_MIGRATION_NOT_READY`，且 `/api/readyz` 503**；按校阻断（结构漂移 / 该校额外对象 /
台账缺失或 failed）→ 该校租户请求 503 `TENANT_SCHEMA_NOT_READY`；无法确认学校归属的租户入口 → 503 `TENANT_NOT_ATTRIBUTED`。
豁免清单固定：`/api/health`、`/api/readyz`、`/api/admin/**`、`super-admin/**` 与静态资源。
（`/api/health` 保持 liveness 200，但携带 `ready:false` 摘要，不声称健康。）
修复后每 60s 只读复检（`TENANT_READINESS_RECHECK_MS`）自动放开，无需重启。

#### 租户结构的破坏性边界（P3-W2-T02-R2 / RC-04）

- **破坏性变更没有自动通道**：`db:sync` 只按版本化链回放；失败 / 无台账未证明 / 分类失败 / 额外对象 → fail-closed
  （退出码 1、部署中止，旧版本继续服役），绝不静默丢数据、不自动 DROP 任何对象；
- 需要删除 / 改类型 / 重建时：沉淀为 `prisma migrate`（租户侧见 `20260814040000_json_fields_to_jsonb`
  的 DO 块先例）；`--rebuild-empty-schema`（自动 `DROP SCHEMA CASCADE`）**已撤下**——人工重建须先备份并经审批，
  按 `evidence/P3-W2-T02-R3/REPAIR_RUNBOOK.md` 执行，完成后用 `--baseline-plan` / `--baseline-apply` 登记台账；
- **历史入口已封存**：运行期无 `prisma db push`；`buildTenantPushArgs` 仅为历史签名兼容保留（静态护栏
  测试断言产品路径零调用），`TENANT_DB_PUSH_ACCEPT_DATA_LOSS` / `TENANT_ALIGN_ACCEPT_DESTRUCTIVE`
  均已无产品路径消费方、不再是可用开关；
- 启动侧（任何 `AUTO_SYNC_TENANTS` 取值）**永不写结构**，不存在「重启即对齐」的隐式通道。

> ⚠️ **R7 总控返工中 —— 不要据此判定 RC-04 已闭合**（W2-R5 处理，复审通过前本节不更新结论）：
> ① **迁移锁接管**：当前接管判据只看“同主机 + pid 不存在”，未覆盖“Node 父进程已死但独立 `psql` 子进程 /
> PG 后端仍在执行 SQL”的窗口，也没有会话级 SQL 期 fence；最保守可用 `TENANT_MIGRATION_LOCK_STALE_TAKEOVER=off`。
> ② **人工清锁 CAS**：`--force-unlock` 展示信息与删除之间存在 TOCTOU（原锁释放后可能删到新持有者的锁），
> 目标语义是 `owner + fencing_token` 比对成功才删。
> ③ **baseline 提交边界**：`--baseline-apply` 在台账事务**提交之后**还会重读整链并做结构证明；该阶段失败属
> **“已提交、待人工复核”**，**不得**表述为“任一步失败全事务回滚”（提交前的失败才是回滚）。
> ④ **锁表版本归属**：`public._tenant_migration_locks` 目前仍由运行路径创建/升级，**尚未进入版本化迁移链**。
> 上述四项均以总控复审与 W2-R5 证据为准；本文件其余段落若与之冲突，以本声明为准。

## 故障排查
- 后端起不来：`journalctl -u <APP_NAME> -n 50`
- Caddy 配置有误：`caddy validate --config /etc/caddy/Caddyfile`
- 健康检查失败但没报错：后端可能还在启动，等一会再 `curl http://127.0.0.1:<API_PORT>/api/health`
- 部署日志出现 **P3005**（`database schema is not empty`）：既有库未登记迁移链 → 人工核实后按 `deploy/MIGRATION_FAILURE_RUNBOOK.md` §3-B 接入基线（部署脚本不会自动接入）
- 部署日志出现 **P3009**（`found failed migrations ... will not be applied`）：按 `deploy/MIGRATION_FAILURE_RUNBOOK.md` §3-C 人工核实（含「部分执行」的实际效果）后解除并重跑（部署脚本不会自动 resolve）
- 日志出现「全量租户 schema 同步失败——已中止部署」：按 `sync-tenant-schemas.mjs` 输出的失败清单修复对应学校（`school`/`step`/`message`），修好后重跑部署

## ⚠️ 已知限制（切换多实例部署前必读）

### 安全事件告警扫描器假设单实例运行
- **位置**：`backend/lib/securityAlerts.js`（`SECURITY:*` 事件定时扫描 + webhook 推送）。
- **限制**：扫描游标（"已处理到 SystemLog 哪条记录"）保存在**进程内存**，未落共享存储。
- **当前无影响**：本部署方案为 systemd 单进程托管（已确定不用 PM2），单实例下行为完全正确。
- **触发条件（何时必须处理）**：当决定引入 **PM2 cluster 模式**或**多机 / 多进程部署**时，
  **必须先**把扫描游标改造为共享存储协调，否则每个实例都会各自扫描同一张
  `public.SystemLog` 并各自推送，同一批安全事件被重复告警 N 次（N=实例数），
  造成告警疲劳，反而掩盖真正需要关注的信号。
- **推荐改造方案**：新建极简数据库租约表（如 `alert_scanner_lease`：
  `id` / `holder_id` / `lease_expires_at`），实例扫描前用
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_expires_at < NOW()`
  原子抢占过期租约，仅租约持有者执行扫描与推送；租约 TTL 取扫描间隔的 2-3 倍并定期续约。
- **由谁审视**：执行多实例改造的开发/运维负责人，在改动进程托管方式（systemd 单元、
  引入 PM2、加实例数）的评审阶段主动检索本节；`securityAlerts.js` 模块顶部注释有同样声明作双保险。
- **同源原则**：任何跨请求/跨进程判断状态的数据（token 吊销记录、登录失败计数、本扫描游标）
  必须放数据库或 Redis 等共享存储，不能用进程内存 Map/变量（参见 TD-P2-14 / TD-P2-15）。
