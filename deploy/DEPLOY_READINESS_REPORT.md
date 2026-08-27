# 部署就绪度报告 — 食品检验系统（代码仓库标识 `foodtestlab`）

基线：`main` 分支（本地工作区含未提交修改） · 自查日期 2026-07-30
目标：聚焦"能否顺利跑起来"——配置完整性、依赖可用性、初始化链路正确性、部署脚本可执行性。
（非重新安全审查；此前已完成七轮独立安全审查。）

---

## 一、环境变量完整性 —— ✅ 就绪（1 处黄色风险）

全仓扫描（排除 `node_modules`，仅 `*.js/*.mjs/*.cjs`）共发现 **43 个** `process.env.*` 变量。关键分类：

| 变量 | 用途 | 缺失行为 |
|---|---|---|
| `JWT_SECRET` | JWT 签名 | **fail-fast**：缺失或命中弱密钥黑名单 → `process.exit(1)`（`server.js:58-76`） |
| `DATABASE_URL` | PG 连接串 | **fail-fast**：Prisma 初始化失败；`provisionSchool` 显式 throw |
| `CORS_ORIGIN` | 跨域白名单 | 含 `*` → **fail-fast** 退出；**缺失 → 静默回退 localhost 白名单**（生产漏配表现为浏览器跨域报错，不崩溃）⚠️ |
| `SEED_ADMIN/OPERATOR/VIEWER_PASSWORD` | 种子账号 | **fail-fast**：seed.js 三项缺一即 `exit(1)`；生产还需 `SEED_ALLOW_PROD=true` |
| `JWT_REFRESH_SECRET` | 刷新令牌密钥 | ⚠️ 静默派生为 `"<JWT_SECRET>:refresh"`（`UserManager.js:102`），非独立密钥 |
| `SCHOOL_CODES` | 租户初始化 | 为空 → `[SKIP]` 跳过多租户初始化（明示日志，非静默） |
| `ALLOW_INSECURE_TENANT_PASSWORD` | 弱密码回退 | 默认关闭；显式 `true` 才允许，且打高危日志 + 强制 `must_change_password=true` |
| 其余（PORT=3002、BODY_LIMIT=8mb、限流/锁定/告警/租户连接池等） | — | 均有合理代码内默认值 |

**结论**：无"静默使用不安全默认值"的必填项，安全关口均 fail-fast。旧 `.env.example` 严重过时（含约 15 个代码从不读取的变量如 `CACHE_*`/`FEATURE_*`/`LOG_LEVEL`，且缺失 `JWT_REFRESH_SECRET`、`SCHOOL_CODES`、限流等约 25 个真实变量），**已重写为与代码一一对应的新版**（见仓库根目录 `.env.example`，含必填/可选/缺失行为标注）——即下方"附录 A 模板"。

---

## 二、数据库初始化链路 —— ✅ 就绪

**Schema 一致性**：`schema.prisma`（provider=postgresql，12 个 model）确有 `must_change_password Boolean @default(false)`；迁移目录含 `20260726000000_baseline` 与 `20260729000000_add_must_change_password`（`ADD COLUMN IF NOT EXISTS` 写法），代码读取字段与 schema/迁移一致。

**全新部署执行顺序**（由 `deploy.sh` §6~§6.7 驱动）：

1. `npx prisma generate`（失败中止）
2. 首部署判定：`public."User"` 表是否存在
3. `prisma migrate deploy` 建 public 全表（失败时仅首部署允许 `db push` 回退，非首部署中止）
4. 仅首部署：`SEED_ALLOW_PROD=true node prisma/seed.js` → public 三账号（admin/operator/viewer）+ School 记录
5. §6.5 `provision-tenants.js`：遍历 `SCHOOL_CODES`，对每校执行 `provisionSchool` → ① `CREATE SCHEMA IF NOT EXISTS school_<code>` ② `prisma db push --schema=?schema=` 推业务表 ③ public 系统记录 ④ 租户 manager 账号（失败**中止部署**）
6. §6.55 `sync-tenant-schemas.mjs`：读 `public."School"` **全部**学校（含控制台 UI 新建的）逐个幂等 db push，防 P2022 漂移（失败**中止部署**，旧版本继续服役）
7. §6.6 `syncBootstrapPasswords.js`：库内 bootstrap 账号密码对齐 `.env` 当前值（失败仅 warn）
8. §6.7 `SchoolCustomization` 跨 schema 增量补列 + NULL 回填（DO 块，幂等）
9. 运行期兜底：`server.js` 启动后非阻塞自愈同步（`AUTO_SYNC_TENANTS=false` 可关）

**幂等性**：✅ 全链路可安全重跑——migrate deploy 天然幂等；seed `ensureUser` 已存在即跳过；`CREATE SCHEMA IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`；重部署时复用旧 `.env` 中 `PG_PASSWORD/JWT_SECRET/SEED_*`（`deploy.sh:370-394`），避免"重跑后密码不匹配"经典故障。

---

## 三、部署脚本可执行性 —— ✅ 就绪（2 处需注意）

`deploy/deploy.sh`（711 行，`set -o pipefail`，无 `set -e`，每步显式 `|| fail`(中止) 或 `|| warn`(继续)，全程彩色日志）：

| § | 步骤 | 失败处理 |
|---|---|---|
| 0 | 读适配文件 + 机密环境变量优先覆盖（DS-19）+ 必填项校验（SYSTEM_NAME/REPO_URL/DEPLOY_BRANCH/API_PORT/FRONTEND_PORT） | 中止 |
| 1 | root 校验、仅支持 apt 系、内存自适应（MemoryMax/heap）、外网出站预检（github/npmjs） | 中止 |
| 2 | 装运行时：Caddy（cloudsmith 源）、Node 20（tarball→`/usr/local/bin` 软链）、PostgreSQL（apt）；`INSTALL_RUNTIME=false` 则只校验存在 | 中止 |
| 3 | 建系统用户（nologin）、目录、PG 库/角色（密码复用防 P1000） | 中止 |
| 4 | git clone / reset --hard + clean（保留 `.env`） | 中止 |
| 5 | 生成 `backend/.env`（chmod 600、密钥复用、CORS 自动取公网 IP） | — |
| 6~6.7 | 见第二节；seed 失败仅 **warn** ⚠ | 混合 |
| 7 | `node scripts/build-static.js` → `dist/` | 中止 |
| 8 | 写 systemd 单元并 restart | 中止 |
| 9 | Caddy 站点片段（import 模式多用户隔离）+ 端口冲突预检 + `caddy validate` | 中止 |
| 10 | 健康检查（30×2s 轮询 `/api/health`），超时仅 **warn** ⚠ | 继续 |
| 11 | 收尾报告（打印验证命令与初始账号提示） | — |

**前置安装说明**：`deploy/README.md` 有"⚠️ 部署前置"章节（安全组、数据盘 fstab、外网出站）；软件本身由脚本自装，无需手动预装清单之外的东西。

**硬编码盘点**（换服务器时的雷点）：
- `deploy.foodsentinel.conf`（位于服务器 `/opt/deploy/`，含密钥不入仓库）：`REQUIRED_MOUNT="/mnt/datadisk0"` —— **新服务器若无此挂载点，部署直接中止**（刻意的防呆，但换机必改）；`DATA_DIR/LOG_DIR` 同样指向数据盘。
- systemd 单元 `ExecStart=/usr/local/bin/node`：依赖脚本自建的软链；若 `INSTALL_RUNTIME=false` 且 node 装在别处（如 nvm 路径）会启动失败。
- 脚本本身无用户名/绝对路径硬编码（均由 conf 派生），仅支持 **apt 系发行版**。

---

## 四、进程管理与反向代理 —— ✅ 就绪（注意：是 systemd + Caddy，不是 PM2 + Nginx）

> 📌 **现网对照**：以下 78~80 行是装机前的预检记录。现网实际形态此后有演进——启用域名 HTTPS（入口 `https://foodsentinel.digifluidic.com`，监听 443），后端实际 `API_PORT=3002`（见服务器 `/opt/deploy/deploy.foodsentinel.conf`）。排查线上问题时以 Caddy 当前配置 `/etc/caddy/sites/foodsentinel-api.caddy` 为准。

- **进程管理**：原生 systemd（`foodsentinel-api.service`，运行用户 `foodsentinel`）。已配置：`Restart=on-failure` + `RestartSec=5`、`MemoryMax` 按机器内存自适应（3.5G 机 → 768M~1024M，heap 为其 3/4）、`EnvironmentFile=backend/.env`、日志 `append:` 到 `/mnt/datadisk0/foodsentinel/logs/app.{out,err}.log`、非 root 用户运行、`After=postgresql.service`。⚠️ **未配置 logrotate**，日志会无限增长。
- **反向代理**：Caddy（非 Nginx）。片段核查：`handle /api/*` 优先反代 `127.0.0.1:3000`（与后端 `/api` 路由前缀一致，含 8MB 请求体上限，与后端 `BODY_LIMIT=8mb` 对齐）；`/health` 反代；其余 SPA 回退 `dist/index.html`；`/<code>/login` 重写到登录页；安全响应头齐全。部署后有 `/api/health` 反代自检防"SPA 吞 API"。**未显式设置 reverse_proxy 超时**（使用 Caddy 默认值，dev/test 可接受）。
- **端口规划**：后端 3000（仅 127.0.0.1）· Caddy 8080（公网，安全组需放行）· PG 5432（本机）。脚本内置双重端口冲突预检（扫描已有 `.caddy` 片段 + `ss -ltn`）。

---

## 五、依赖与运行环境 —— ✅ 就绪

- **npm audit**：`backend/`（生产运行时）**0 漏洞**；根目录全量 audit 有 **26 个 high**，但 `npm audit --omit=dev` = **0 漏洞**——全部位于 devDependencies（jest 工具链 brace-expansion 等），不进入服务器运行时，**无需阻塞部署**。
- **版本**：engines 声明 root `node>=18, npm>=9`、backend `node>=18`；部署脚本安装 Node **20**（conf `NODE_VERSION="20"`），满足声明。本地开发机 v24.15.0 亦兼容。
- **原生模块**：密码哈希用 **bcryptjs（纯 JS）**，无编译风险。Prisma 引擎为平台二进制，但 deploy.sh 在**服务器上**执行 `npm ci + prisma generate`，不复制本地产物 → macOS 开发 / Linux 部署**无跨平台风险**。

---

## 六、测试基线 —— ✅ 已记录

- **Jest 全量**（`npm test`）：**11 套件 / 148 用例，全部通过**。
- **多租户隔离集成测试**（`tests/integration/`，需 live PostgreSQL）：**1 套件 / 10 用例，全部通过**（含并发竞态、跨 schema 泄露检查）。
- **Cypress e2e**：`cypress run` 默认即 headless（Electron），配置已关 video/screenshot，`baseUrl=http://localhost:8080` 与 `FRONTEND_PORT` 一致。但 Linux 服务器需额外安装 Cypress 系统库（libgtk/libnss 等），deploy.sh 与 README **均未包含**该步骤 → 建议 e2e **不在服务器执行**，继续在本地/CI 跑（需要人工决策）。

---

## 服务器初始化清单（脚本自动 vs 人工）

**人工必做（脚本无法代劳）**：
1. 腾讯云安全组放行 TCP **22、8080**（将来加域名再放 443）；**3000 勿对公网开放**
2. 数据盘挂载 `/mnt/datadisk0` 并写入 `/etc/fstab`（未挂载脚本会中止）
3. 服务器可出站访问 `github.com`、`registry.npmjs.org`

**脚本自动安装（`INSTALL_RUNTIME=true`）**：Node 20（软链至 `/usr/local/bin`）、Caddy（cloudsmith apt 源）、PostgreSQL（apt 默认版）、系统用户 `foodtestlab`（nologin）、systemd 单元、swap 2G（conf 已开）。OS 要求：**Ubuntu/Debian（apt 系）+ root**。

---

## 首次部署操作步骤（历史存档：本生产已按此完成首装，仅作追溯）

```bash
# 1.（人工）完成上方安全组/数据盘/出站三项                              【已完成】
# 2. 上传适配文件并按需修改（重点：SCHOOL_CODES 填学校代码，逗号分隔）    【已完成】
mkdir -p /opt/deploy && vim /opt/deploy/deploy.foodsentinel.conf
# 3.（推荐）机密经真实环境变量传入，不写入 conf：
sudo -E PG_PASSWORD='***' JWT_SECRET='***' bash deploy.sh /opt/deploy/deploy.foodsentinel.conf
#    或全部留空由脚本生成强随机值
# 4. 部署完成后立即记录 backend/.env 中的 SEED_*_PASSWORD（chmod 600，仅 root/服务用户可读）
# 5. 验证：systemctl status foodsentinel-api && curl http://127.0.0.1:3000/api/health
#         浏览器访问 http://<公网IP>:8080 并登录
# 6. 首次登录后修改 admin/operator/viewer 密码
```
**日常迭代无需重跑完整部署**：更新代码 → `npm run build`（重建 `dist/`）→ `sudo systemctl restart foodsentinel-api` 即可；完整部署命令仅在搭建全新独立环境时使用。

---

## 红黄绿风险清单

**🔴 红（会导致部署直接失败）**
1. `/mnt/datadisk0` 未挂载 → `REQUIRED_MOUNT` 检查中止（换服务器必查/必改 conf）。
2. 安全组未放行 8080 → 部署"成功"但外部无法访问（README 已标注的假阳性，本质等同失败）。
3. 非 apt 系发行版或无外网出站 → 预检中止。

**🟡 黄（能部署成功但需处理）**
1. **`SCHOOL_CODES=""`（当前 conf 现状）**：多租户初始化被跳过，仅 public 共享 schema——dev/test 若要验证多租户能力，部署前必须填上（需要人工决策）。
2. `CORS_ORIGIN` 缺失时静默回退 localhost 白名单（不崩溃，表现为前端跨域失败）；deploy.sh 靠 `curl ifconfig.me` 自动生成，若该请求失败会落到 `"*"` → 反而触发后端启动拒绝。建议 conf 里显式填 `http://111.231.166.161:8080`。
4. `JWT_REFRESH_SECRET` 默认由 `JWT_SECRET` 派生，建议生产显式配置独立值。
5. seed 失败仅 `warn` 不中止 → 可能出现"服务健康但无法登录"，部署后务必做一次真实登录验证。
6. systemd 日志 append 无 logrotate → 长期运行盘满风险，建议加 logrotate 规则。
7. 每租户连接池 3 × 缓存上限 25 客户端，理论峰值可逼近 PG 默认 `max_connections=100`，租户增多后需调参。

**🟢 绿（后续优化）**
1. 根目录 devDependencies 的 26 个 high 漏洞（jest 链），不影响运行时，可择期 `npm audit fix`。
2. Caddy reverse_proxy 未显式设超时（默认值对 dev/test 足够）。
3. Cypress 服务器端 headless 依赖未纳入部署脚本——维持"本地跑 e2e"策略即可。
4. 健康检查超时仅 warn，可考虑改为非零退出便于 CI 判定。

**总体结论**：六大类均达到"可部署"状态，无阻塞项。部署前只需完成 3 项人工前置 + 决策 `SCHOOL_CODES` 取值（注意用逗号分隔），即可在全新 Ubuntu CVM 上一条命令完成首次部署。

---

## 附录 A — `.env.example` 模板（脱敏，已落地到仓库根目录）

见仓库根目录 `.env.example`（已与代码实际读取的环境变量逐一对应，含必填/可选/缺失行为标注）。核心必填项：
- `DATABASE_URL`（PG 连接串，fail-fast）
- `JWT_SECRET`（fail-fast 弱密钥校验）
- `SEED_ALLOW_PROD=true` + `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD`（seed fail-fast）
- `SCHOOL_CODES`（逗号分隔，留空跳过租户初始化）
- 可选：`CORS_ORIGIN`、`JWT_REFRESH_SECRET`、`PORT`、`BODY_LIMIT`、各限流/锁定/告警/租户连接池参数（均有代码内默认值）
