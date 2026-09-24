/**
 * syncRoutes.js — 离线数据同步路由
 *
 * 修复记录（P0-01）：
 * - 从 CommonJS 迁移至 ES Module（fix: CommonJS 与后端体系不兼容）
 * - 所有路由添加 authenticateUser 认证保护（fix: 原路由完全公开无认证）
 * - 所有写操作改为操作 Prisma 数据库（fix: 原操作只写内存，重启后丢失）
 *
 * 端点：
 *   POST   /api/sync/records        — 同步单条检测记录（需认证）
 *   POST   /api/sync/batch          — 批量同步检测记录（需认证）
 *   GET    /api/sync/status         — 获取同步状态统计（需认证）
 *   DELETE /api/sync/queue          — 清空已完成的同步日志（需 admin）
 */

import express from 'express'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { canModifyRecord } from '../lib/securityGuards.js'
import { safeParseJson } from '../lib/sanitize.js'
import { normalizeWriteJson, resolveWritableStatus } from '../lib/recordNormalize.js'

export function createSyncRoutes(userManager, prisma) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin, requireEditorOrAbove } = createAuthMiddleware(userManager, prisma)

    /**
     * 同步端的并发语义（2026-09-17 P1-3 定稿）—— **App 离线优先 = 最后写入胜出（LWW）**：
     *   · 客户端携带 `expected_version`（或 `version`）→ 走**原子 CAS**：`where { id, version }`，
     *     条件不满足抛 P2025 → 映射为 409 VERSION_CONFLICT（不覆盖别人的新数据）。
     *   · 未携带 → 保留 LWW（离线队列无法保证版本新鲜度），但 version **原子 +1** 并回传，
     *     使其它入口/客户端的版本判断仍然有效；同时打日志提示。
     *   ⚠️ 不要把这个端点的 version 当锁：默认语义是 LWW，已在 docs/OPEN_API_INTEGRATION.md 与
     *      客户端示例中写明；要强一致请传 expected_version。
     */
    async function updateRecordLwwOrCas(db, id, updateFields, data) {
        const expectedRaw = data?.expected_version ?? data?.version
        const hasExpected = expectedRaw !== undefined && expectedRaw !== null && expectedRaw !== ''
        const expected = hasExpected ? Number(expectedRaw) : null
        if (hasExpected && !Number.isFinite(expected)) {
            const e = new Error('expected_version 必须是数字')
            e.code = 'INVALID_EXPECTED_VERSION'
            throw e
        }
        const payload = { ...updateFields, version: { increment: 1 } }
        try {
            if (hasExpected) {
                return await db.testRecord.update({ where: { id, version: expected }, data: payload })
            }
            console.warn(`[SYNC LWW] 未携带 expected_version，按最后写入胜出处理：id=${id}`)
            return await db.testRecord.update({ where: { id }, data: payload })
        } catch (err) {
            if (err?.code === 'P2025') {
                const e = new Error('版本冲突：记录已被其他人修改，请重新获取后重试')
                e.code = 'VERSION_CONFLICT'
                throw e
            }
            throw err
        }
    }

    // ====== POST /sync/records — 同步单条检测记录 ======
    // NB-10: 仅 editor 及以上角色可写入，防止 viewer 只读角色通过 sync 端点写数据
    router.post('/records', authenticateUser, requireEditorOrAbove, async (req, res) => {
        const { action, store, data, syncId, timestamp } = req.body
        try {
            if (!action || !data || !store) {
                return res.status(400).json({ success: false, error: '缺少必要参数：action / store / data' })
            }

            // 仅支持 testRecord 同步
            const SUPPORTED_STORES = new Set(['tableware', 'pathogen', 'leanMeat', 'oil', 'pesticide'])
            if (!SUPPORTED_STORES.has(store)) {
                return res.status(400).json({ success: false, error: `不支持的 store 类型：${store}` })
            }

            let result

            switch (action) {
                case 'add': {
                    // 2026-09-16 审阅修复（H2/M5）：统一归一 —— 上下文三键只落 sample_info、result_data 剔
                    // 控制字段与副本，并**拒绝**空结果 / 非法结构（原先 `data.result_data || data` 在 `{}` 时
                    // 会把整条记录写成空对象且 HTTP 200）。状态走白名单。
                    const norm = normalizeWriteJson({
                        payload: data,
                        resultData: data.result_data,
                        sampleInfo: data.sample_info,
                        existingSampleInfo: null,
                        mode: 'create',
                        testType: store,
                    })
                    if (!norm.ok) {
                        return res.status(400).json({ success: false, error: `❌ ${norm.message}`, code: norm.code })
                    }
                    const statusCheck = resolveWritableStatus({ requested: data.status, role: req.user?.role, currentStatus: null })
                    if (!statusCheck.ok) {
                        return res.status(400).json({ success: false, error: `❌ ${statusCheck.message}`, code: 'STATUS_NOT_ALLOWED' })
                    }
                    result = await req.db.testRecord.create({
                        data: {
                            record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                            test_type: store,
                            test_name: data.test_name || store,
                            sample_info: norm.sampleInfo,
                            result_data: norm.resultData,
                            status: statusCheck.status || 'completed',
                            created_by: req.user.userId
                        }
                    })
                    break
                }
                case 'update': {
                    if (!data.id) {
                        return res.status(400).json({ success: false, error: 'update 操作需要提供 data.id' })
                    }
                    const existingUpdate = await req.db.testRecord.findUnique({ where: { id: data.id } })
                    if (!existingUpdate) {
                        return res.status(404).json({ success: false, error: '记录不存在' })
                    }
                    if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existingUpdate)) {
                        return res.status(403).json({ success: false, error: '无权限修改该记录' })
                    }
                    // 2026-09-16 审阅修复（H1）：统一归一。**只提交 result_data（内含食堂/日期/检测人）时，
                    // 这三键会合并写回 sample_info** —— 原实现在此静默丢弃它们（用户改动丢失，无 400 无日志）。
                    // 未提交的字段保持不变；显式 `{}` = 不改动 result_data；状态走白名单。
                    const normUpdate = normalizeWriteJson({
                        payload: data,
                        resultData: data.result_data,
                        sampleInfo: data.sample_info,
                        existingSampleInfo: safeParseJson(existingUpdate.sample_info, {}),
                        // 2026-09-17 P0-1：本端点是**局部更新**（离线队列只送变更字段）→ 默认 merge；
                        // 未提交的业务键保留旧值；只提交上下文键时不再写回 {} 清空结果。
                        existingResultData: safeParseJson(existingUpdate.result_data, {}) || {},
                        resultDataMode: data.result_data_mode === 'replace' ? 'replace' : 'merge',
                        mode: 'update',
                        testType: store,
                    })
                    if (!normUpdate.ok) {
                        return res.status(400).json({ success: false, error: `❌ ${normUpdate.message}`, code: normUpdate.code })
                    }
                    const statusCheckUpdate = resolveWritableStatus({ requested: data.status, role: req.user?.role, currentStatus: existingUpdate.status })
                    if (!statusCheckUpdate.ok) {
                        return res.status(400).json({ success: false, error: `❌ ${statusCheckUpdate.message}`, code: 'STATUS_NOT_ALLOWED' })
                    }
                    const updateFields = { test_name: data.test_name }
                    if (statusCheckUpdate.status) updateFields.status = statusCheckUpdate.status
                    if (normUpdate.resultData !== undefined) updateFields.result_data = normUpdate.resultData
                    if (normUpdate.provided.length) updateFields.sample_info = normUpdate.sampleInfo
                    result = await updateRecordLwwOrCas(req.db, data.id, updateFields, data)
                    break
                }
                case 'delete': {
                    if (!data.id) {
                        return res.status(400).json({ success: false, error: 'delete 操作需要提供 data.id' })
                    }
                    const existingDelete = await req.db.testRecord.findUnique({ where: { id: data.id } })
                    if (!existingDelete) {
                        return res.status(404).json({ success: false, error: '记录不存在' })
                    }
                    if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existingDelete)) {
                        return res.status(403).json({ success: false, error: '无权限删除该记录' })
                    }
                    result = await req.db.testRecord.delete({
                        where: { id: data.id }
                    })
                    break
                }
                default:
                    return res.status(400).json({ success: false, error: `未知操作类型：${action}` })
            }

            res.json({
                success: true,
                syncId,
                action,
                store,
                data: result,
                syncedAt: new Date()
            })
        } catch (error) {
            // 2026-09-17 P1-3：并发语义显式化 —— 条件 CAS 失败 → 409；参数非法 → 400（原先一律 500 或静默覆盖）
            if (error.code === 'VERSION_CONFLICT') {
                return res.status(409).json({ success: false, error: `❌ ${error.message}`, code: 'VERSION_CONFLICT' })
            }
            if (error.code === 'INVALID_EXPECTED_VERSION') {
                return res.status(400).json({ success: false, error: `❌ ${error.message}`, code: 'INVALID_EXPECTED_VERSION' })
            }
            if (error.code === 'P2002' && action === 'add' && data.record_code) {
                const existing = await req.db.testRecord.findUnique({ where: { record_code: data.record_code } })
                if (existing) {
                    // 2026-09-16 审阅 M5：record_code 冲突**不等于**合法幂等重试。仅当本次调用者本就
                    // 有权修改该记录（自己的记录 / manager+）时才按幂等返回；否则视为记录码冲突，
                    // 不回显他人记录（原实现无条件回显，且静默丢弃本次提交的数据）。
                    if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existing)) {
                        return res.status(409).json({
                            success: false,
                            error: '❌ record_code 冲突：该记录码已被其他用户的记录占用，请更换记录码或改用 update',
                            code: 'RECORD_CODE_CONFLICT',
                        })
                    }
                    return res.json({ success: true, action, store, data: existing, syncedAt: new Date(), idempotent: true })
                }
            }
            console.error('[SYNC ERROR] /records:', error)
            res.status(500).json({ success: false, error: '同步失败' })
        }
    })

    // ====== POST /sync/batch — 批量同步 ======
    // NB-10: 仅 editor 及以上角色可写入
    router.post('/batch', authenticateUser, requireEditorOrAbove, async (req, res) => {
        try {
            const { operations } = req.body

            if (!Array.isArray(operations) || operations.length === 0) {
                return res.status(400).json({ success: false, error: 'operations 必须是非空数组' })
            }

            const results = []
            const errors = []

            for (const op of operations) {
                // 解构提到 try 外，使 catch 块能访问 action/data（修复 P2002 幂等回查时的 ReferenceError）
                const { action, store, data, syncId } = op
                try {
                    if (!action || !data || !store) {
                        throw new Error('缺少必要参数：action / store / data')
                    }

                    let result
                    switch (action) {
                        case 'add': {
                            // 同 /records：统一归一（拒绝空结果/非法结构）+ 状态白名单
                            const norm = normalizeWriteJson({
                                payload: data,
                                resultData: data.result_data,
                                sampleInfo: data.sample_info,
                                existingSampleInfo: null,
                                mode: 'create',
                                testType: store,
                            })
                            if (!norm.ok) { const e = new Error(norm.message); e.code = norm.code; throw e }
                            const statusCheck = resolveWritableStatus({ requested: data.status, role: req.user?.role, currentStatus: null })
                            if (!statusCheck.ok) { const e = new Error(statusCheck.message); e.code = 'STATUS_NOT_ALLOWED'; throw e }
                            result = await req.db.testRecord.create({
                                data: {
                                    record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                                    test_type: store,
                                    test_name: data.test_name || store,
                                    sample_info: norm.sampleInfo,
                                    result_data: norm.resultData,
                                    status: statusCheck.status || 'completed',
                                    created_by: req.user.userId
                                }
                            })
                            break
                        }
                        case 'update': {
                            const existing = await req.db.testRecord.findUnique({ where: { id: data.id } })
                            if (!existing) throw new Error('记录不存在')
                            if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existing)) {
                                throw new Error('无权限修改该记录')
                            }
                            // 同 /records：统一归一（H1：result_data 内的上下文三键合并写回 sample_info）
                            const normU = normalizeWriteJson({
                                payload: data,
                                resultData: data.result_data,
                                sampleInfo: data.sample_info,
                                existingSampleInfo: safeParseJson(existing.sample_info, {}),
                                existingResultData: safeParseJson(existing.result_data, {}) || {},
                                resultDataMode: data.result_data_mode === 'replace' ? 'replace' : 'merge',
                                mode: 'update',
                                testType: store,
                            })
                            if (!normU.ok) { const e = new Error(normU.message); e.code = normU.code; throw e }
                            const statusCheckU = resolveWritableStatus({ requested: data.status, role: req.user?.role, currentStatus: existing.status })
                            if (!statusCheckU.ok) { const e = new Error(statusCheckU.message); e.code = 'STATUS_NOT_ALLOWED'; throw e }
                            const updateFields = { test_name: data.test_name }
                            if (statusCheckU.status) updateFields.status = statusCheckU.status
                            if (normU.resultData !== undefined) updateFields.result_data = normU.resultData
                            if (normU.provided.length) updateFields.sample_info = normU.sampleInfo
                            result = await updateRecordLwwOrCas(req.db, data.id, updateFields, data)
                            break
                        }
                        case 'delete': {
                            const existing = await req.db.testRecord.findUnique({ where: { id: data.id } })
                            if (!existing) throw new Error('记录不存在')
                            if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existing)) {
                                throw new Error('无权限删除该记录')
                            }
                            result = await req.db.testRecord.delete({ where: { id: data.id } })
                            break
                        }
                        default:
                            throw new Error(`未知操作类型：${action}`)
                    }

                    results.push({ syncId, action, store, success: true, data: result })
                } catch (error) {
                    if (error.code === 'P2002' && action === 'add' && data.record_code) {
                        try {
                            const existing = await req.db.testRecord.findUnique({ where: { record_code: data.record_code } })
                            if (existing) {
                                // 审阅 M5：冲突不等于合法幂等重试 —— 无权限覆盖时按冲突上报（不回显他人记录）
                                if (!canModifyRecord({ role: req.user?.role, userId: req.user?.userId }, existing)) {
                                    errors.push({ syncId, store, error: 'record_code 冲突：该记录码已被其他用户的记录占用', code: 'RECORD_CODE_CONFLICT' })
                                    continue
                                }
                                results.push({ syncId, action, store, success: true, data: existing, idempotent: true })
                                continue
                            }
                        } catch (e) { /* 回查失败走 errors */ }
                    }
                    errors.push({ syncId: op.syncId, store: op.store, error: error.message || '同步失败', code: error.code || undefined })
                }
            }

            res.json({
                success: errors.length === 0,
                total: operations.length,
                succeeded: results.length,
                failed: errors.length,
                results,
                errors
            })
        } catch (error) {
            console.error('[SYNC ERROR] /batch:', error)
            res.status(500).json({ success: false, error: '同步失败' })
        }
    })

    // ====== GET /sync/status — 同步状态统计 ======
    router.get('/status', authenticateUser, async (req, res) => {
        try {
            const total = await req.db.testRecord.count()
            const byType = await req.db.testRecord.groupBy({
                by: ['test_type'],
                _count: { id: true }
            })

            res.json({
                success: true,
                status: 'ok',
                timestamp: new Date(),
                summary: {
                    totalRecords: total,
                    byType: byType.reduce((acc, item) => {
                        acc[item.test_type] = item._count.id
                        return acc
                    }, {})
                }
            })
        } catch (error) {
            console.error('[SYNC ERROR] /status:', error)
            res.status(500).json({ success: false, error: '同步失败' })
        }
    })

    // ====== DELETE /sync/queue — 清空已完成记录（仅 admin）======
    router.delete('/queue', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            // 清空 completed 状态的记录（谨慎操作，仅清理已归档数据）
            const deleted = await req.db.testRecord.deleteMany({
                where: { status: 'archived' }
            })

            res.json({
                success: true,
                message: `已清空 ${deleted.count} 条已归档记录`
            })
        } catch (error) {
            console.error('[SYNC ERROR] /queue:', error)
            res.status(500).json({ success: false, error: '同步失败' })
        }
    })

    return router
}
