/**
 * 访客导出申请路由
 * 处理访客导出权限申请和管理员审批
 */

import express from 'express';
import { supabase } from '../config/supabaseClient.js';
import { validateToken } from '../middleware/validationMiddleware.js';

const router = express.Router();

/**
 * 访客提交导出申请
 * POST /api/guest-export-request/submit
 */
router.post('/submit', validateToken, async (req, res) => {
    try {
        // 验证是否是访客
        if (req.user.type !== 'guest') {
            return res.status(403).json({ error: '仅访客可提交申请' });
        }

        // 检查访客类型
        if (req.user.guest_type !== 'export_applicant') {
            return res.status(403).json({ error: '您的访客类型不支持导出申请' });
        }

        const { request_type, request_reason, request_data } = req.body;

        if (!request_type || !request_reason) {
            return res.status(400).json({ error: '申请类型和申请原因不能为空' });
        }

        // 检查是否有未审批的申请
        const { data: pendingRequest } = await supabase
            .from('guest_export_requests')
            .select('id')
            .eq('guest_id', req.user.guestId)
            .eq('status', 'pending')
            .single();

        if (pendingRequest) {
            return res.status(409).json({ error: '您还有未审批的申请，请等待审批结果' });
        }

        // 创建申请记录
        const { data: request, error: insertError } = await supabase
            .from('guest_export_requests')
            .insert([{
                guest_id: req.user.guestId,
                request_type,
                request_reason,
                request_data: request_data || {},
                status: 'pending',
                requested_at: new Date()
            }])
            .select()
            .single();

        if (insertError) {
            console.error('插入申请记录错误:', insertError);
            return res.status(500).json({ error: '提交失败: ' + insertError.message });
        }

        res.status(201).json({
            success: true,
            message: '申请已提交，请等待管理员审批',
            request: {
                id: request.id,
                status: request.status,
                requested_at: request.requested_at
            }
        });
    } catch (error) {
        console.error('提交导出申请错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 获取访客的申请记录
 * GET /api/guest-export-request/my-requests
 */
router.get('/my-requests', validateToken, async (req, res) => {
    try {
        // 验证是否是访客
        if (req.user.type !== 'guest') {
            return res.status(403).json({ error: '仅访客可查看申请记录' });
        }

        const { data: requests, error: queryError } = await supabase
            .from('guest_export_requests')
            .select(`
                id,
                request_type,
                request_reason,
                request_data,
                status,
                approval_comment,
                approval_date,
                permission_valid_until,
                requested_at,
                updated_at
            `)
            .eq('guest_id', req.user.guestId)
            .order('requested_at', { ascending: false });

        if (queryError) {
            return res.status(500).json({ error: '查询失败: ' + queryError.message });
        }

        res.json({
            success: true,
            requests
        });
    } catch (error) {
        console.error('获取申请记录错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 获取所有导出申请（管理员用）
 * GET /api/guest-export-request/list
 */
router.get('/list', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可访问' });
        }

        const status = req.query.status || 'pending'; // 默认获取待审批
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        let query = supabase
            .from('guest_export_requests')
            .select(`
                id,
                guest_id,
                guests:guest_id (
                    id,
                    username,
                    email,
                    full_name,
                    guest_type
                ),
                request_type,
                request_reason,
                request_data,
                status,
                approval_comment,
                approval_date,
                permission_valid_until,
                requested_at,
                updated_at
            `, { count: 'exact' })
            .order('requested_at', { ascending: false });

        if (status !== 'all') {
            query = query.eq('status', status);
        }

        const { data: requests, error: queryError, count } = await query
            .range(offset, offset + limit - 1);

        if (queryError) {
            return res.status(500).json({ error: '查询失败: ' + queryError.message });
        }

        res.json({
            success: true,
            data: requests,
            total: count,
            page,
            limit
        });
    } catch (error) {
        console.error('获取申请列表错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 批准导出申请（管理员用）
 * PUT /api/guest-export-request/:requestId/approve
 */
router.put('/:requestId/approve', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可操作' });
        }

        const { requestId } = req.params;
        const { approval_comment, permission_days = 30 } = req.body;

        // 获取申请记录
        const { data: request, error: queryError } = await supabase
            .from('guest_export_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (queryError || !request) {
            return res.status(404).json({ error: '申请记录不存在' });
        }

        // 计算权限过期时间
        const permission_valid_until = new Date();
        permission_valid_until.setDate(permission_valid_until.getDate() + permission_days);

        // 更新申请记录
        const { data: updatedRequest, error: updateError } = await supabase
            .from('guest_export_requests')
            .update({
                status: 'approved',
                approved_by: req.user.userId,
                approval_comment: approval_comment || '',
                approval_date: new Date(),
                permission_valid_until: permission_valid_until,
                updated_at: new Date()
            })
            .eq('id', requestId)
            .select()
            .single();

        if (updateError) {
            return res.status(500).json({ error: '更新失败: ' + updateError.message });
        }

        // 更新访客的导出权限
        const { error: guestUpdateError } = await supabase
            .from('guests')
            .update({
                has_export_permission: true,
                updated_at: new Date()
            })
            .eq('id', request.guest_id);

        if (guestUpdateError) {
            console.error('更新访客权限错误:', guestUpdateError);
            // 继续处理，但记录错误
        }

        res.json({
            success: true,
            message: '申请已批准，访客已获得导出权限',
            request: updatedRequest
        });
    } catch (error) {
        console.error('批准申请错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 拒绝导出申请（管理员用）
 * PUT /api/guest-export-request/:requestId/reject
 */
router.put('/:requestId/reject', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可操作' });
        }

        const { requestId } = req.params;
        const { approval_comment } = req.body;

        // 获取申请记录
        const { data: request, error: queryError } = await supabase
            .from('guest_export_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (queryError || !request) {
            return res.status(404).json({ error: '申请记录不存在' });
        }

        // 更新申请记录
        const { data: updatedRequest, error: updateError } = await supabase
            .from('guest_export_requests')
            .update({
                status: 'rejected',
                approved_by: req.user.userId,
                approval_comment: approval_comment || '',
                approval_date: new Date(),
                updated_at: new Date()
            })
            .eq('id', requestId)
            .select()
            .single();

        if (updateError) {
            return res.status(500).json({ error: '更新失败: ' + updateError.message });
        }

        res.json({
            success: true,
            message: '申请已拒绝',
            request: updatedRequest
        });
    } catch (error) {
        console.error('拒绝申请错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 检查访客是否有导出权限
 * GET /api/guest-export-request/check-permission
 */
router.get('/check-permission', validateToken, async (req, res) => {
    try {
        // 验证是否是访客
        if (req.user.type !== 'guest') {
            return res.status(403).json({ error: '仅访客可查询权限' });
        }

        // 从 token 中直接获取权限状态
        const has_export_permission = req.user.has_export_permission || false;

        // 如果已有权限，检查是否过期
        if (has_export_permission) {
            const { data: latestRequest } = await supabase
                .from('guest_export_requests')
                .select('permission_valid_until, status')
                .eq('guest_id', req.user.guestId)
                .eq('status', 'approved')
                .order('approval_date', { ascending: false })
                .single();

            if (latestRequest) {
                const now = new Date();
                const valid_until = new Date(latestRequest.permission_valid_until);

                if (valid_until < now) {
                    // 权限已过期，更新访客状态
                    await supabase
                        .from('guests')
                        .update({ has_export_permission: false })
                        .eq('id', req.user.guestId);

                    return res.json({
                        has_export_permission: false,
                        reason: 'permission_expired'
                    });
                }

                return res.json({
                    has_export_permission: true,
                    valid_until: latestRequest.permission_valid_until
                });
            }
        }

        res.json({
            has_export_permission: false,
            reason: 'no_permission'
        });
    } catch (error) {
        console.error('检查权限错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

export default router;
