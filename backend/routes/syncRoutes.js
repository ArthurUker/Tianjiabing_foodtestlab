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

export function createSyncRoutes(userManager, prisma) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin, requireEditorOrAbove } = createAuthMiddleware(userManager, prisma)

    // ====== POST /sync/records — 同步单条检测记录 ======
    // NB-10: 仅 editor 及以上角色可写入，防止 viewer 只读角色通过 sync 端点写数据
    router.post('/records', authenticateUser, requireEditorOrAbove, async (req, res) => {
        try {
            const { action, store, data, syncId, timestamp } = req.body

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
                    result = await req.db.testRecord.create({
                        data: {
                            record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                            test_type: store,
                            test_name: data.test_name || store,
                            sample_info: JSON.stringify(data.sample_info || {}),
                            result_data: JSON.stringify(data.result_data || data),
                            status: data.status || 'completed',
                            created_by: req.user.userId
                        }
                    })
                    break
                }
                case 'update': {
                    if (!data.id) {
                        return res.status(400).json({ success: false, error: 'update 操作需要提供 data.id' })
                    }
                    result = await req.db.testRecord.update({
                        where: { id: data.id },
                        data: {
                            test_name: data.test_name,
                            sample_info: data.sample_info ? JSON.stringify(data.sample_info) : undefined,
                            result_data: data.result_data ? JSON.stringify(data.result_data) : undefined,
                            status: data.status
                        }
                    })
                    break
                }
                case 'delete': {
                    if (!data.id) {
                        return res.status(400).json({ success: false, error: 'delete 操作需要提供 data.id' })
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
            if (error.code === 'P2002' && action === 'add' && data.record_code) {
                const existing = await req.db.testRecord.findUnique({ where: { record_code: data.record_code } })
                if (existing) {
                    return res.json({ success: true, action, store, data: existing, syncedAt: new Date(), idempotent: true })
                }
            }
            console.error('[SYNC ERROR] /records:', error)
            res.status(500).json({ success: false, error: error.message })
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
                try {
                    // 复用单条同步逻辑：构造一个伪 req/res 对象
                    // 直接调用 Prisma，避免内部 HTTP 调用
                    const { action, store, data, syncId } = op

                    if (!action || !data || !store) {
                        throw new Error('缺少必要参数：action / store / data')
                    }

                    let result
                    switch (action) {
                        case 'add':
                            result = await req.db.testRecord.create({
                                data: {
                                    record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                                    test_type: store,
                                    test_name: data.test_name || store,
                                    sample_info: JSON.stringify(data.sample_info || {}),
                                    result_data: JSON.stringify(data.result_data || data),
                                    status: data.status || 'completed',
                                    created_by: req.user.userId
                                }
                            })
                            break
                        case 'update':
                            result = await req.db.testRecord.update({
                                where: { id: data.id },
                                data: {
                                    test_name: data.test_name,
                                    sample_info: data.sample_info ? JSON.stringify(data.sample_info) : undefined,
                                    result_data: data.result_data ? JSON.stringify(data.result_data) : undefined,
                                    status: data.status
                                }
                            })
                            break
                        case 'delete':
                            result = await req.db.testRecord.delete({ where: { id: data.id } })
                            break
                        default:
                            throw new Error(`未知操作类型：${action}`)
                    }

                    results.push({ syncId, action, store, success: true, data: result })
                } catch (error) {
                    if (error.code === 'P2002' && action === 'add' && data.record_code) {
                        try {
                            const existing = await req.db.testRecord.findUnique({ where: { record_code: data.record_code } })
                            if (existing) {
                                results.push({ syncId, action, store, success: true, data: existing, idempotent: true })
                                continue
                            }
                        } catch (e) { /* 回查失败走 errors */ }
                    }
                    errors.push({ syncId: op.syncId, store: op.store, error: error.message })
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
            res.status(500).json({ success: false, error: error.message })
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
            res.status(500).json({ success: false, error: error.message })
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
            res.status(500).json({ success: false, error: error.message })
        }
    })

    return router
}
