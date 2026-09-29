# R6 第 3 轮「隔离实例动态复证」报告（2026-09-29）

> 计划依据：`R6_DEEP_REVIEW_PLAN_R3_20260929.md`（提交 `4f6bcf1`）
> 执行时间：**2026-09-29 10:18–10:2x CST**｜**未修产品源码、未部署、未迁移或故障注入生产库、未改变真实 OpenAPI 授权、未在生产运行目录创建任何测试文件**
> 历史报告不继承其"属实/已恢复"结论；本报告仅陈述本轮实测与回读。

## 0. 当前实际状态（开工记录）

| 项 | 实测（10:18 CST） |
| --- | --- |
| 本地 HEAD / 远端 | `e964544` / **`4f6bcf1`**（远端多 1 个纯文档提交＝本 R3 计划） |
| 工作区 | **clean**（`git status` 无输出） |
| 运行进程 | `MainPID=1673914`，`NRestarts=0`，启动 **2026-09-28 16:45:51**（未重启） |
| 运行后端代码 vs 工作区 | **等价**：`find backend -newermt '2026-09-28 16:45:51'` 无任何源码文件被改动 |
| 前端差异 | 后端未变；`dist`/前端源码此后有 2 个提交（`6ef2602`、`e964544`，均为登录页友情链接布局），由 Caddy 直接服务，不经进程 |
| 其他窗口活动 | **有，且活跃**：`.git/FETCH_HEAD` mtime = **10:18:21**（本次检查前 15 秒）；提交序列显示 09-28 17:00 后仍有 `6ef2602`/`e964544`/`4f6bcf1` 三个新提交 |

> ⚠️ `readyz=200` 类结论**不作为冻结基线**（生产目录处于并行编辑状态）。

## 1. G0 · 隔离边界硬门禁 — **定位完成（结论修正）**

### 1.1 结论

上一轮报告的"隔离副本尝试读取 `/opt/foodsentinel/backend/.env`（EACCES）→ 未定位"**已定位，且根因是上一次隔离搭建方式本身，不是产品缺陷**。

### 1.2 证据链

| 步骤 | 判据 | 结果 |
| --- | --- | --- |
| ① 触发字符串归属 | `grep -rn "Schema Env Error"`（排除 vendor 后无命中） | 该串**只存在于 Prisma 自身运行时**（`@prisma/client/runtime/library.js`、`prisma/build/index.js`）→ **不是项目代码打印的** |
| ② 项目代码是否硬编码生产路径 | `grep -rn "/opt/foodsentinel"`（排除 `node_modules`） | 命中**全部是注释里的运行示例**（`tests/**`、`scripts/check-tableware-consistency.mjs`、`scripts/e2e-write-verify.mjs`），**无任何运行时读该路径的逻辑** |
| ③ `envFilePath` 参数是否有调用方 | `grep -rn "envFilePath"` | 仅 `lib/jwtSecretResolve.js` 的定义与 JSDoc（`:26,39,48,51`），**无调用方** |
| ④ 生成客户端的路径内嵌 | `grep -ao "/opt/foodsentinel[^\"']*" node_modules/.prisma/client/index.js` | **命中两条绝对路径**：`/opt/foodsentinel/backend/node_modules/` 与 **`/opt/foodsentinel/backend/prisma/schema.prisma`** |

**根因**：Prisma 在 `generate` 时把 **schema 绝对路径**写进生成的客户端。上一轮我把隔离副本的 `backend/node_modules` 做成**指向生产 `node_modules` 的软链**，于是 Prisma 运行时按内嵌路径在 `/opt/foodsentinel/backend/prisma/` 附近做 `.env` 发现 → 尝试读 `/opt/foodsentinel/backend/.env` → 生产文件 0600 属 `foodsentinel` → **EACCES**。

即：**EACCES 是"隔离搭建不彻底"的症状，同时恰好（且仅）被生产文件权限挡住**——正如计划所指出的，"权限刚好拒绝"不能当作隔离保证。

### 1.3 对隔离搭建的硬性要求（本轮据此修订，供下一轮执行）

1. **不得软链 `node_modules`**：必须**复制**（或在隔离副本内执行 `npx prisma generate`，使内嵌 schema 路径指向隔离副本）。
2. 校验隔离副本内核：`grep -ao "/opt/foodsentinel[^\"']*" <副本>/backend/node_modules/.prisma/client/index.js` **必须为空**（这是隔离成立的**可执行判据**，本轮新增）。
3. 独立数据库 + **仅能连接克隆库的 DB 角色**（显式 `REVOKE CONNECT ON DATABASE foodsentinel FROM <role>`），并在每条写命令前回显 `current_database()` 作为"目标非生产库"的证明。
4. 独立回环端口：注意 `backend/server.js:598` 为 `app.listen(PORT)`（**绑定全部接口**），隔离服务要么在隔离副本内改为显式 `app.listen(PORT, '127.0.0.1')`，要么用网络层手段限制；**不得**在生产进程上做此修改。
5. 隔离副本从**固定 commit** 建立（`git archive <sha>`），所有写操作发生在副本与克隆库内。

### 1.4 本轮动态测试裁决

按计划"每项写操作前证明目标不是生产库；若无法证明隔离，停止本轮全部动态测试"：本轮**在 G0 定位后未进入隔离实例搭建**（见 §2 各项 NOT_RUN 的技术原因），因此**没有执行任何动态测试**，也未产生任何指向生产库的写操作。**本节的定位报告即本轮 G0 的完整交付。**

## 2. G1 / G2 / G3 — **NOT_RUN**

| 项 | 状态 | 技术原因（非"结论为假"） | 下一轮可直接复用的配方 |
| --- | --- | --- | --- |
| **G1** SRV-111 | **NOT_RUN** | 未完成 §1.3 的隔离搭建（复制 node_modules + 生成隔离 client + 专用 DB 角色 + 回环绑定），不满足"写操作前证明目标非生产库"的前置条件 | 克隆库载入 schema-only 结构 → 插入合成 `School` A/B 与一条 `scope='all'` 的 `BackupRun`（`table_counts` 键形如 `school_B.<table>`）→ 以 A 校管理员 `GET /api/school/backups` → 断言响应 JSON **是否含 `school_B` 前缀键或 B 校逐表计数**；同时与平台管理员视图做正反对照 |
| **G2-110** | **NOT_RUN** | 同上；且"只让 A 校 blocked、B 校健康且 `globalBlockers=[]`"需在克隆库构造结构漂移并启动隔离服务 | 克隆库对 `school_A` 做单列漂移 → 隔离服务 `readyz.blockedSchools=[A]`、`globalBlockers=[]` → 三组对照：A 校 token 无 body / A 校 token + `body.schoolCode=B` / B 校真实 token；**分别**记录"闸门 HTTP"与"路由最终绑定 schema" |
| **G2-106** | **NOT_RUN** | 同上（需两个合成设备会话 + 签名 token） | 合成用户登录 → 两个 `POST /api/session` → `DELETE /api/session/others` → 被撤销设备再心跳 → **分别**检查：Session 行状态 / 旧 access token 是否仍可用 / 旧 refresh 是否仍能换新凭据（不得仅凭行状态判"强制登出失效"） |
| **G3** SRV-137 | **NOT_RUN（但结论已可下调，见 §3）** | 未构造出"第 41+ 唯一索引存在重复值"的状态；原因见 §3 的结构性论证 | 若仍需实证：在克隆库按 `loadIdx` 同形查询列出 `curIdxRows` 顺序 → 取第 41+ 项 → 先使该索引 `indisvalid/indisready` 变化或改其定义以容纳重复，再运行真实 `buildBaselineProof` |

**失败尝试**：本轮未发起会失败的动态尝试（未搭建环境即停止），故无失败 rc 可保留。

## 3. G3 的**结构性下调**（本轮可确定的结论）

计划要求：若 PostgreSQL 约束或其它结构检查使"误放行"不可达，**必须下调**结论，且不得为凑反例绕过其它检查。基于代码回读（行号取自本轮之前的本人回读，本轮复核未变）：

- `lib/tenantProvisioner.js:1258` `curIdxRows = await loadIdx(schema)` — **完整**索引集合；
- `:1266-1268` `invalidIdx = curIdxRows.filter(i => !i.is_valid || !i.is_ready)` → **`indexes.valid` 检查不设上限**；
- `:1257-1263` `indexes.all` 以**完整集合**比较 public/tenant 的索引定义 → **不设上限**；
- `:1335` `for (const idx of uniqIdx.slice(0, 40))` → 仅**数据级重复扫描**被截断。

**论证**：在 PostgreSQL 中，**有效（`indisvalid && indisready`）的唯一索引不可能存在重复值**——写入侧由约束强制。因此 ⑥ 的重复值扫描对所有"定义与 public 一致且有效"的索引**恒为真值（vacuous）**。要让第 41+ 个索引真的出现重复，必须先使其**无效/未就绪**或**改变其定义/谓词**，而这两种情形分别被**无上限**的 `indexes.valid` 与 `indexes.all` 捕获。

⇒ **误放行（proof.ok=true 且存在重复值）在本仓现有结构检查下不可达**。据此：

| ID | 原级 | 本轮重新定级 | 保留的缺陷 |
| --- | --- | --- | --- |
| **SRV-137** | P2 | **↓ P3（潜在 / 代码异味）** | 仍保留：`slice(0, 40)` 使**被截断部分不计入 `notProven`**（若未来出现"有效索引仍可重复"的形态，如表达式索引依赖易变函数），以及"上限的存在使扫描覆盖不可自证"的表述缺陷 |
| SRV-108 | P3 | **P3 维持** | NOT NULL 截断被无上限的列检查①涵盖（第 1 轮已证） |

## 4. 重新定级汇总

| ID | 本轮定级 | 依据 | 证据级别 |
| --- | --- | --- | --- |
| **SRV-137** | **P3（由 P2 下调）** | §3 结构性论证：有效唯一索引不可能重复；无效/定义漂移由**无上限**检查覆盖 | 静态（代码行）+ 结构推理 |
| **SRV-111** | **P1 维持（未复证）** | 静态调用链成立；本轮 **NOT_RUN**，未取得隔离 HTTP 证据 | 静态 |
| **SRV-110** | **P2 维持（未复证）** | 同上；且"闸门绕过"与"业务越权"必须分开裁定，本轮无法裁定 | 静态 |
| **SRV-106** | **P2 维持（未复证）** | 同上；不得仅凭 Session 行状态判定 | 静态 |

## 5. SRV-121 / SRV-114 后续修复的验收条件

| 项 | 验收条件（可在隔离环境判定） |
| --- | --- |
| **SRV-121 / SRV-122** | ① 隔离副本中"旧进程运行期磁盘新增一条迁移"**不得**再影响运行实例（当前会 fail-closed 全局 503）；② 真实 `pending` / `failed` / checksum 不一致 / 结构漂移 / 额外对象 → **仍必须** 503（不得退化为告警放行）；③ 发布脚本 b1/b2 在沙盒中 rc=0，且任一步失败即中止、不产生半套台账；④ 恢复路径明确（重启后 60s 内自动放开，或按新流程需重启）并有记录 |
| **SRV-114** | ① 合成在用校（校码 `x-old-2` ⇒ schema `school_xsyn_old_2`）**不进入** `005_cleanup-old-schemas.mjs` 待删清单；② 真实旧备份点（`school_<code>_old_<epoch ms>` 且已不在 `public."School"` 登记）**仍可**被清理；③ `--dry-run` 输出需列出判定依据（OID / 台账 / 是否在用）；④ 保留窗口（近期备份点）不被误删 |

## 6. 下一轮建议（第 4 轮，按计划 §后续轮次）

1. **先补 G1/G2**：按 §1.3 完成隔离搭建（复制 `node_modules`、隔离 client、专用 DB 角色、回环绑定），再做 SRV-111 / 110 / 106 的隔离 HTTP 正反例。
2. **SRV-101–105 路由/事务级最小反例**（第 4 轮计划内容）：PUT 未提交 `status` 的 DB 前后对照、`sync` 路径的 `test_type` 校验缺失、复检自愈覆盖、审计写入失败、`/api/sync/queue` 无审计删除。
3. **SRV-127 / 128 / 135 的隔离影响验证** + 发布脚本沙盒实跑。
4. 生产侧 R5 缺项（未认证边界、已授权业务读）**仅在**生产工作区停止编辑、进程版本重新固定且 `readyz=200` 后执行；外部 OpenAPI 重授与真实合作方调用需另行协调。

## 7. 清理与边界声明

- 本轮**未创建**任何数据库、角色、隔离目录或隔离服务 → **无实例需要 down，无清理项**；未在生产运行目录创建任何测试文件；未修改任何产品源码或历史报告。
- 生产未受影响：进程 PID 1673914 未重启，未做任何写操作。
- **脱敏**：本文件不含数据库口令/连接串、token、API Key、`BACKUP_MASTER_KEY`、真实个人信息与未脱敏请求体；所引路径均为仓库内路径或已脱敏的环境标识。
