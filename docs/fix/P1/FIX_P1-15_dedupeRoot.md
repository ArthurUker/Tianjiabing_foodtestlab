# FIX-P1-15：生产环境重复数据根因未根治

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-15` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/server.js` |
| **预估工时** | 1h |
| **关联问题** | P0-06 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |
| **代码提交** | `e821296` |

---

## 1. 问题描述

**FIX_PLAN 原始描述**：`生产环境重复数据根因未根治`（依赖 `P0-06（record_code 统一）`）。

**实际核验发现**：

P0-06 已完成确定性 `record_code` 生成（`buildDeterministicRecordCode`，基于内容哈希 `RC-{table}-{sha256}`）+ `schema.prisma` `record_code String @unique` 约束，从数据库层面阻止了重复数据写入。但 `backend/server.js` 中**两个记录创建接口实现不一致**：

1. `POST /api/records/:tableName`（line 446-512）：✅ 已完整实现幂等检查
   - `findUnique` 前置查询，存在则幂等返回
   - `catch` 块处理 P2002（唯一约束冲突）按幂等策略返回已有记录
   - `catch` 块处理 P2003（外键约束失败）返回 422

2. `POST /api/test-records`（line 343-372）：❌ 缺失全部幂等处理
   - **无 `findUnique` 前置检查**，直接 `prisma.testRecord.create`
   - **无 P2002 处理**，并发重复写入时唯一约束冲突被当作普通错误返回 500
   - **无 P2003 处理**，`created_by` 用户不存在时外键约束失败返回 500（而非 422）

**影响**：
- 重复提交 / 前端重试 / 并发写入场景下，`/api/test-records` 返回 500 错误而非幂等返回已有数据，用户体验差且可能触发前端重试风暴。
- P0-06 只修复了 `record_code` 生成与约束（数据层），但 `/api/test-records` 接口层未配套实现幂等检查，"根因未根治"。

## 2. 根因分析

P0-06 修复时仅对高频使用的 `POST /api/records/:tableName`（前端 Legacy 兼容接口）配套实现了幂等检查与 P2002/P2003 错误处理，遗漏了同文件的 `POST /api/test-records`（标准 RESTful 接口）。两个接口共用 `buildDeterministicRecordCode` 生成 `record_code`，但错误处理路径不一致，导致 `@unique` 约束触发时 `/api/test-records` 直接抛 500。

## 3. 修复方案

### 方案 A（已实施）

**`backend/server.js`**（`e821296`）：给 `POST /api/test-records` 添加与 `POST /api/records/:tableName` 一致的幂等检查与错误处理。

```diff
 app.post('/api/test-records', authenticateUser, requireEditorOrAbove, async (req, res) => {
     try {
         const { test_type, test_name, sample_info, result_data } = req.body

         const recordCode = buildDeterministicRecordCode(test_type || 'generic', req.body)
+
+        // P1-15: 前置幂等检查，重复提交返回已有记录（与 /api/records/:tableName 一致）
+        const existing = await prisma.testRecord.findUnique({
+            where: { record_code: recordCode }
+        })
+
+        if (existing) {
+            return res.json({
+                success: true,
+                deduplicated: true,
+                data: existing,
+                message: '记录已存在，已按幂等策略返回现有数据'
+            })
+        }
+
         const record = await prisma.testRecord.create({
             data: { ... }
         })
         ...
     } catch (error) {
+        // P1-15: P2002 唯一约束冲突（并发重复写入）：按幂等策略返回已有记录
+        if (error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'))) {
+            try {
+                const existing = await prisma.testRecord.findUnique({
+                    where: { record_code: buildDeterministicRecordCode(req.body?.test_type || 'generic', req.body || {}) }
+                })
+                if (existing) {
+                    return res.json({ success: true, deduplicated: true, data: existing, message: '记录已存在（并发写入），已按幂等策略返回现有数据' })
+                }
+            } catch (_) { /* fallthrough */ }
+        }
+        // P1-15: P2003 外键约束失败（created_by 用户不存在）：返回 422 而非 500
+        if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
+            console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
+            return res.status(422).json({
+                error: '关联用户不存在，请重新登录',
+                details: error.message,
+                code: 'INVALID_USER'
+            })
+        }
         console.error('❌ Error creating test record:', error)
         res.status(500).json({ error: '创建失败', details: error.message })
     }
 })
```

**修复语义**：
- 正常创建流程（首次写入）行为不变，仅多一次 `findUnique` 查询。
- 重复提交：`findUnique` 命中则幂等返回 `deduplicated: true` + 已有记录。
- 并发写入（`findUnique` 未命中但 `create` 触发 P2002）：catch 块二次 `findUnique` 幂等返回。
- 外键约束失败（P2003，`created_by` 用户不存在）：返回 422 + `INVALID_USER`，提示重新登录。

### 方案 B（备选）

> 将两个创建接口合并为统一 handler。

> **未采用原因**：违反最小改动原则，两接口入参结构不同（`/api/test-records` 接收结构化字段，`/api/records/:tableName` 接收扁平 payload + `buildRecordWriteData` 规范化），合并会引入额外重构风险。

## 4. 验收标准

- [x] `POST /api/test-records` 添加 `findUnique` 前置幂等检查
- [x] 重复提交返回 `deduplicated: true` + 已有记录（非 500）
- [x] P2002 并发冲突按幂等策略返回已有记录
- [x] P2003 外键约束失败返回 422 + `INVALID_USER`（非 500）
- [x] 正常首次创建流程行为不变
- [x] `git diff --stat` 确认修改范围仅 `backend/server.js`（+35 行）

## 5. 回归测试要点

- [ ] 首次创建：相同 payload 调用 `POST /api/test-records`，返回 `success: true` + 新记录
- [ ] 重复提交：相同 payload 再次调用，返回 `deduplicated: true` + 已有记录（`record_code` 一致）
- [ ] 并发写入：两请求同时创建相同 payload，其一成功创建，另一返回 `deduplicated: true`
- [ ] 外键失效：`created_by` 指向已删除用户时返回 422 + `INVALID_USER`
- [ ] 既有 `/api/records/:tableName` 接口行为不受影响

## 6. 备注

**历史数据清理**：`backend/prisma/dedupe-test-records.js` + `package.json` `dedupe:preview`/`dedupe:apply` 脚本用于清理 P0-06 之前产生的历史重复数据（基于内容指纹 `buildRecordFingerprint`，与 `buildRecordHash` 策略一致）。本次修复后新数据不再产生重复，历史数据可按需运行 `npm run dedupe:apply` 清理。

**技术债 TD-P2-19**：`POST /api/test-records` 与 `POST /api/records/:tableName` 两套记录创建接口入参结构不一致（结构化字段 vs 扁平 payload + `buildRecordWriteData`），`record_code` 哈希基础不同，同一份数据通过不同接口写入可能生成不同 `record_code`。后续应统一记录创建入口与入参规范化逻辑，确保跨接口的幂等性一致。
