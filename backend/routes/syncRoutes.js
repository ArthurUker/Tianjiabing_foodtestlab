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

export function createSyncRoutes(userManager, prisma) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin, requireEditorOrAbove } = createAuthMiddleware(userManager, prisma)

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
                    result = await req.db.testRecord.create({
                        data: {
                            record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                            test_type: store,
                            test_name: data.test_name || store,
                            sample_info: data.sample_info || {},
                            result_data: data.result_data || data,
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
                    const existingUpdate = await req.db.testRecord.findUnique({ where: { id: data.id } })
                    if (!existingUpdate) {
                        return res.status(404).json({ success: false, error: '记录不存在' })
                    }
                    if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existingUpdate)) {
                        return res.status(403).json({ success: false, error: '无权限修改该记录' })
                    }
                    result = await req.db.testRecord.update({
                        where: { id: data.id },
                        data: {
                            test_name: data.test_name,
                            sample_info: data.sample_info ? data.sample_info : undefined,
                            result_data: data.result_data ? data.result_data : undefined,
                            status: data.status
                        }
                    })
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
                    if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existingDelete)) {
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
            if (error.code === 'P2002' && action === 'add' && data.record_code) {
                const existing = await req.db.testRecord.findUnique({ where: { record_code: data.record_code } })
                if (existing) {
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
                        case 'add':
                            result = await req.db.testRecord.create({
                                data: {
                                    record_code: data.record_code || `SYNC-${store}-${Date.now()}`,
                                    test_type: store,
                                    test_name: data.test_name || store,
                                    sample_info: data.sample_info || {},
                                    result_data: data.result_data || data,
                                    status: data.status || 'completed',
                                    created_by: req.user.userId
                                }
                            })
                            break
                        case 'update': {
                            const existing = await req.db.testRecord.findUnique({ where: { id: data.id } })
                            if (!existing) throw new Error('记录不存在')
                            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                                throw new Error('无权限修改该记录')
                            }
                            result = await req.db.testRecord.update({
                                where: { id: data.id },
                                data: {
                                    test_name: data.test_name,
                                    sample_info: data.sample_info ? data.sample_info : undefined,
                                    result_data: data.result_data ? data.result_data : undefined,
                                    status: data.status
                                }
                            })
                            break
                        }
                        case 'delete': {
                            const existing = await req.db.testRecord.findUnique({ where: { id: data.id } })
                            if (!existing) throw new Error('记录不存在')
                            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
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
                                results.push({ syncId, action, store, success: true, data: existing, idempotent: true })
                                continue
                            }
                        } catch (e) { /* 回查失败走 errors */ }
                    }
                    errors.push({ syncId: op.syncId, store: op.store, error: error.message || '同步失败' })
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
