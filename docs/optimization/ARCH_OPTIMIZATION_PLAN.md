# 架构优化整改执行计划

> 本文档用于**防止执行过程中丢失任务目标**，记录两轮架构审阅后确定的整改项、执行顺序、验收标准与实时进度。
> 每次完成一项后，更新对应条目的「状态」与「完成时间」。

## 一、背景

经过两轮架构审阅，共发现 9 项 R2 级发现 + 9 项第一轮结论。其中 **4 项 P1 级已在本轮先行修复**（见 §五），剩余整改项按成本/风险/收益重新评估后排序执行。

## 二、执行总览

| 优先级 | 编号 | 任务 | 预估工时 | 风险 | 状态 |
|---|---|---|---|---|---|
| P0 | P2-6 | 删除 Backup 弃用模型 | 0.5-1h | 极低 | ✅ 完成 |
| P0 | R2-07 | 补幂等并发 + 越权回归测试 | 4-6h | 零 | ✅ 完成 |
| P2 | P2-8 | xss/sql 规则抽单一事实源 | 2-3h | 低 | ✅ 完成 |
| P1 | P1-1 | server.js 拆路由 | 8-12h | 中 | ✅ 完成（2535→398 行） |
| 关闭 | P1-3 | 引入 Redis | 0.5h | — | ✅ 文档化单实例假设 |
| P1 | P1-2 | 全部 JSON 字段统一 jsonb（SchoolCustomization 12 列 + TestRecord/AuditLog/SystemLog/BackupRun/GuestExportRequest 6 字段） | 8-12h | **高** | ✅ 完成 |
| 推迟 | P2-4 | 检测模块继承重构 | 15-25h | 高 | ⏳ 业务稳定后 |

## 三、逐项执行细节

### P0-1：删除 Backup 弃用模型（P2-6）

**目标**：删除 `schema.prisma` 中无任何代码写入的 `Backup` 旧模型及 `User.backups` 关系，消除死代码。

**证据依据**：
- `schema.prisma:173-176` 注释自证「全库无任何代码写入」。
- 全库 grep 确认实际代码 100% 使用 `BackupRun`（`backupService.js`、`adminBackupRoutes.js`、`restoreService.js`）。
- `baseline/migration.sql:128-139` 已创建 `Backup` 表（含外键 296 行、索引 254/257 行）。

**执行步骤**：
1. 删除 `schema.prisma:39` 的 `backups Backup[]` 关系。
2. 删除 `schema.prisma:173-192` 的 `Backup` 模型定义（含注释）。
3. 生成 migration：`npx prisma migrate dev --name remove_backup_model`（自动产出 DROP TABLE + DROP 索引 + DROP 外键）。
4. 校验：`npx prisma generate` 后全库 grep `prisma.backup`、`\bBackup\b` 确认零引用。

**验收标准**：`prisma migrate deploy` 成功；`Backup` 表已从数据库移除；全库无 `Backup`（旧模型）引用；服务正常启动、备份模块（`BackupRun`）功能不受影响。

**回滚方案**：migration 为可回滚结构，如需恢复可重建模型（数据本为空表，无数据损失）。

---

### P0-2：补幂等并发 + 越权回归测试（R2-07）

**目标**：为已修复的 3 个 P1 建立回归护栏，锁定正确行为。

**证据依据**：本轮已修复 `idempotencyMiddleware`（TOCTOU pending 占位）、`isTokenRevoked`（fail-open→throw）、`requireEditorOrAbove`（统一工厂版白名单）。

**执行步骤**：
1. **幂等并发测试**（新增 `tests/idempotencyConcurrency.test.js`）：
   - 构造：并发 N 个相同 `Idempotency-Key` + 相同 body 的 POST 请求。
   - 断言：仅 1 条记录落库；其余返回 409 或复用同一结果。
2. **越权回归测试**（新增 `tests/roleAuthorization.test.js`）：
   - 注意：当前 `SCHOOL_CODES=""`（public 单 schema 共享模式），多租户 schema 隔离未启用。
   - 故写「单 schema 下的 role 越权」：viewer/guest 写接口 → 403；非法 token 角色（`root`/`superuser`）→ 被白名单拒绝。
3. 接入 `package.json` 的 jest 配置（`jest.config.cjs`）。

**验收标准**：`npx jest tests/idempotencyConcurrency.test.js tests/roleAuthorization.test.js` 全绿。

---

### P2-3：xss/sql 规则抽单一事实源（P2-8 降级）

**目标**：将前端 `FormValidator.js:85-116` 与后端 `validationMiddleware.js:50-102` 重复维护的 xss/sqlInjection 两规则收敛为单一事实源。

**执行步骤**：
1. 后端 `detectSqlInjection`/`detectXss` 已为后端权威实现，前端改为**文档化对齐 + 注释锚点**（前后端语言不同，无法直接共享代码）。
2. 在 `FormValidator.js` 的 xss/sql 规则处补充「同步自 `backend/middleware/validationMiddleware.js:50/199`」注释锚点，避免改一处忘另一处。

**验收标准**：两处规则注释互相指向对方行号，形成可追踪锚点。

---

### P1-4：JSON 字段迁移 `Json?`（P1-2，功能空档期）

**目标**：将 17+ 个 `String?` 存 JSON 的字段迁移为 Prisma 原生 `Json?`，消除 `::jsonb` cast 补丁。

**执行步骤**（空档期一次性做）：
1. `schema.prisma` 字段改型（`SchoolCustomization` 10 列 + `AuditLog.details/context` + `TestRecord.sample_info/result_data` + `BackupRun.table_counts` + `GuestExportRequest.request_data` + `SystemLog.context`）。
2. 生成 migration 并编写数据迁移 SQL（`ALTER COLUMN ... TYPE JSONB USING column::jsonb`）。
3. 删除 `server.js` 中 5 处手写 `$N::jsonb` cast 补丁。
4. 全链路回归（学校定制增删改查 + 检测记录读写 + 备份行数对比 + 审计日志）。

**验收标准**：无手写 `::jsonb` cast 残留；相关接口回归通过。

---

### P1-5：server.js 拆路由（P1-1，功能空档期）

**目标**：将 `server.js`（2509 行）39 个内联端点按域拆到 `routes/`。

**执行步骤**：
1. 抽取共享工具层：`sanitizeFieldOptionsForClient`/`sanitizeObjectKeys`/`parseJsonField` 等 → `lib/sanitize.js` + `lib/recordNormalize.js`（约 500 行）。
2. 拆分 3 个 router：`schoolsRoutes`（22 端点）、`recordRoutes`（11 端点）、`miscRoutes`（3 端点）。
3. `server.js` 只保留中间件装配与 `app.use()`。

**验收标准**：`server.js` 缩减至 <800 行；全量接口回归通过。

---

### 关闭项：Redis（P1-3）

**决策**：**不引入**。单实例部署形态（以 `deploy.foodtestlab.conf` 为示例适配文件，行 22-25），内存 Map 方案够用。改为在 `.env`/部署文档显式声明「单实例假设」。

---

### 推迟项：检测模块继承重构（P2-4）

**决策**：**推迟到业务稳定后**。三模块 import 高度一致（10+ 相同依赖），但 `Tableware` 独有色度识别、`Pathogen` 独有风险评估，业务差异大，大重构会阻塞功能开发。

---

## 四、执行顺序（防丢失目标）

1. **P0-1** 删 Backup 模型 → **P0-2** 补测试 → **P2-3** 规则锚点 → （空档期）**P1-4** JSON 迁移 → **P1-5** 拆路由。

## 五、已完成记录（本轮先行修复）

| 编号 | 修复项 | 状态 |
|---|---|---|
| R2-01 | 统一 `requireEditorOrAbove`（删本地版 + 补解构） | ✅ 完成 |
| R2-03 | `isTokenRevoked` fail-open → throw | ✅ 完成 |
| R2-02 | 幂等中间件 TOCTOU（pending 占位） | ✅ 完成 |
| R2-04 | `deploy.sh` CORS 兜底 `*` → 回环 + 告警 | ✅ 完成 |
| R2-05/06 | 文档漂移（8mb、req.db 挂载点） | ✅ 完成 |
| R2-09 | userRoutes catch 补日志 | ✅ 完成 |
| P2-5 | `escapeHtml` 收口（3 处 import 共享） | ✅ 完成 |
| R2-08 | `npm audit` 核验（0 漏洞） | ✅ 完成 |
| — | 登录限流开发期放宽至 500 次 | ✅ 完成 |
| — | 修复 login.html Enter 重复提交 bug | ✅ 完成 |
| P2-6 | 删除 Backup 弃用模型（migration `20260814000000_remove_backup_model`） | ✅ 完成 |
| R2-07 | 补幂等并发 + 越权回归测试（新增 2 个测试文件，10 用例） | ✅ 完成 |
| P2-8 | xss/sql 规则抽单一事实源（补齐前端 SQL 规则 + 双向锚点） | ✅ 完成 |
| P1-3 | 文档化单实例假设（在 `deploy.foodtestlab.conf` 示例适配文件顶部加架构约束注释） | ✅ 完成 |
| P1-1 | server.js 拆路由（2535→398 行，抽 3 lib + 2 routes） | ✅ 完成 |
| P1-2 | 全部 JSON 字段统一 jsonb（SchoolCustomization 12 列 + 6 字段） | ✅ 完成 |

## 六、进度日志

- 2026-08-14：创建本计划；完成 P0-1（删 Backup 模型）、P0-2（补测试）、P2-3（规则收敛）。
  - P2-6：删除 `Backup` 模型 + `User.backups` 关系，生成并应用 migration，`prisma generate` 通过，全库零引用，服务重启正常，备份 KMS 测试 6/6 通过。
  - R2-07：新增 `tests/idempotencyConcurrency.test.js`（5 用例）与 `tests/roleAuthorization.test.js`（5 用例），验证 TOCTOU pending 占位与角色白名单；完整套件 218/219 通过（唯一失败为预先存在的 `authSession` DS3-M2）。
  - P2-8：发现并修复前后端 SQL 注入规则漂移（前端 5 pattern → 补齐后端权威 8 pattern），XSS 规则本就一致；前后端加双向注释锚点。
  - 重要发现：`migrate diff` 显示数据库与 schema.prisma 存在既有漂移（jsonb vs String、孤儿表 `revoked_tokens`/`recycle_bin` 等）。
- 2026-08-14（续）：完成 P1-3（文档化单实例假设）、P1-1（拆路由）。
  - P1-3：在 `deploy.foodtestlab.conf` 示例适配文件顶部加架构约束注释，声明限流/幂等/安全游标三处内存存储依赖单实例，多实例前须先迁 Redis。
  - P1-1 拆路由（分 3 步，每步验证）：
    1. **Step1 抽取工具函数**：`lib/sanitize.js`（48 行）、`lib/customizationValidate.js`（238 行）、`lib/recordNormalize.js`（212 行），server.js 2535→2087 行；修复抽取遗漏的 `HEX_COLOR_RE` import。
    2. **Step2 抽取 schoolRoutes**：`routes/schoolRoutes.js`（1003 行，25 端点 + /api/school/config），`requirePlatformSuperAdmin` 提升为共享守卫（server.js 定义、schoolRoutes/adminBackupRoutes 共用）；更新 `window2AdminAudit`/`auditUnificationRegression` 两个硬编码 `server.js` 路径的静态回归测试指向新文件。
    3. **Step3 抽取 recordRoutes**：`routes/recordRoutes.js`（685 行，11 端点 + 幂等挂载），server.js 最终 398 行（达成 <800 目标）。
  - 验收：`node --check` 全通过、lint 0 错误、服务重启正常、健康检查 200、各端点鉴权 401/404 正确、完整测试 218/219 通过。
- P1-2（JSON 迁移）完成（2026-08-14 续二）。**关键修正**：经 `information_schema` 精确核实，真实漂移是「public 的 `SchoolCustomization` 12 列为 jsonb（历史正确方向）vs 租户 schema 同表为 text（`tenantSync.js` 用 `ADD COLUMN ... TEXT` 建的漂移）」。正确方向是**把租户升为 jsonb 与 public 对齐**，而非把 public 降为 text。
  - 执行内容：
    1. 撤销上一轮误写的 `20260814020000_unify_school_customization_text`（public jsonb→text 的错误降级），新 migration `20260814030000_revert_customization_to_jsonb` 恢复 public 为 jsonb。
    2. `schema.prisma` 的 `SchoolCustomization` 12 字段 `String?` → `Json?`（Prisma `Json` 映射 PostgreSQL jsonb）。
    3. 一次性 DO 块脚本：遍历全部含该表的 schema，将 12 列 text → jsonb（`USING col::jsonb`），**全库 144 列（12 schema × 12 列）全部统一为 jsonb**。
    4. `tenantSync.js` 漂移源头修正：`ADD COLUMN IF NOT EXISTS ... TEXT` → `JSONB`（5 处），并更新过时的"双类型兼容"注释。
    5. `tenantProvisioner.js` INSERT 修正：`visible_types = $3` → `$3::jsonb`（消除 PG 42804 隐患）。
    6. `seed.js` 修正：`theme_config: JSON.stringify(...)` → 直接传对象（Prisma `Json` 自动序列化）。
  - 重要结论：代码中的 `$N::jsonb` cast **不是补丁，而是 jsonb 列写入的正确语法**（Prisma 传 text 参数，赋 jsonb 列必须显式 cast），统一 jsonb 后这些 cast 保持不变。
  - 验收：全库 0 残留 text 列；读取端点（`/api/schools/dmyz/config`）返回对象/数组而非字符串；事务内 UPDATE 写 jsonb + `->>` 查询正常；218/219 测试通过（唯一失败仍为预先存在的 authSession DS3-M2）；服务 active。
  - 范围说明：本次仅统一有漂移的 `SchoolCustomization` 12 列。其余 JSON 字段（`TestRecord.sample_info/result_data`、`AuditLog.details/context`、`BackupRun.table_counts` 等）全库均为 text、无漂移，且与 schema.prisma `String` 一致，本次未动；如需一并升级 jsonb 属另一可选优化。
- P1-2（JSON 迁移阶段2）完成（2026-08-14 续三）：将剩余 6 个 JSON 字段（`TestRecord.sample_info/result_data`、`AuditLog.details`、`SystemLog.context`、`BackupRun.table_counts`、`GuestExportRequest.request_data`）从 text 升级为 jsonb。
  - 关键前提核实：经 `information_schema` 精确查询，这 6 字段全库均为 text、**无 jsonb/text 混合**（与 SchoolCustomization 不同）。
  - 执行内容：
    1. `sanitize.js` 的 `safeParseJson` 改造为**兼容对象**（Prisma model 读取 jsonb 列返回对象），字符串输入仍走 `JSON.parse`（raw SQL 返回字符串），向后兼容。
    2. `schema.prisma` 6 字段 `String` → `Json`。
    3. 写入点去 `JSON.stringify`（Prisma `Json` 字段直接传对象）：`auditLog.js`（details/context）、`recordNormalize.js`（sample_info/result_data）、`recordRoutes.js`（5 处）、`syncRoutes.js`（4 处）、`backupService.js`（table_counts）、`guestRoutes.js`（request_data）。
    4. 读取点处理对象：`auditRoutes.js` CSV 导出 `details` 兼容对象（`typeof === 'object'` 时 JSON.stringify）。
    5. migration `20260814040000_json_fields_to_jsonb`：public 6 字段 + DO 块遍历租户 schema。**踩坑**：`TestRecord.sample_info/result_data` 带 `DEFAULT '{}'`，PG 无法自动 cast 默认值到 jsonb（42804），须先 `DROP DEFAULT` → `TYPE jsonb` → `SET DEFAULT '{}'::jsonb`。
    6. 迁移失败回滚后 `migrate resolve --rolled-back` 恢复；同时发现 `20260814020000/migration.sql` 文件丢失（目录空），已按 applied 内容精确重建恢复 checksum 校验。
  - 验收：全库 61 列（6 字段 × 各 schema）全部 jsonb、0 残留 text；`school_dmyz`(26)/`school_tjb`(46)/`school_zhyz`(22) 记录 sample_info/result_data 均为合法 jsonb；更新 `auditUnificationRegression` 测试的 `JSON.parse` 断言为兼容 `parseJsonField`；完整测试 218/219 通过（唯一失败仍为预先存在的 authSession DS3-M2）；服务 active、健康检查 200。
  - 前端影响评估：前端 `Storage.js:499`/`BackupRestore.js:694` 已做 `typeof === 'object'` 兼容判断，升级后详情接口返回对象不破坏前端。
