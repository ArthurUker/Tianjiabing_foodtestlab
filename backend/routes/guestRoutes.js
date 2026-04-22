/**
 * 访客管理路由
 * 处理访客登录、注册、导出申请等功能
 */

import express from 'express';
import bcryptjs from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabaseClient.js';
import { validateToken } from '../middleware/validationMiddleware.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'food-lab-secret-key-guest';
const JWT_EXPIRE = '7d';

/**
 * 快速访客访问 - 无需账号密码直接访问
 * POST /api/guest/quick-access
 * 用于 "数据查看访客" - 只能查看数据，不能编辑
 */
router.post('/quick-access', async (req, res) => {
    try {
        console.log('🔓 处理快速访客访问请求...');
        
        // 生成临时访客令牌
        const tempGuestId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        // 生成 JWT Token - 用于快速访问模式
        const token = jwt.sign(
            {
                guestId: tempGuestId,
                username: '快速查看访客',
                email: 'quick-view@local',
                type: 'guest',
                guest_type: 'viewer',  // 只读访客
                has_export_permission: false,
                is_quick_access: true,  // 标记为快速访问
                created_at: new Date().toISOString()
            },
            JWT_SECRET,
            { expiresIn: '4h' }  // 快速访问4小时有效期
        );

        // 记录快速访问（如果需要审计日志）
        console.log('✅ 快速访客令牌已生成:', tempGuestId);

        res.json({
            success: true,
            token,
            guest: {
                id: tempGuestId,
                username: '快速查看访客',
                full_name: '数据查看访客',
                guest_type: 'viewer',
                has_export_permission: false,
                is_quick_access: true,
                expires_in: '4 hours'
            }
        });
    } catch (error) {
        console.error('快速访客访问错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 访客自助注册（只读访客或导出申请访客）
 * POST /api/guest/register
 */
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, full_name, guest_type = 'viewer', valid_days = 30 } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: '用户名、邮箱和密码不能为空' });
        }

        if (!['viewer', 'export_applicant'].includes(guest_type)) {
            return res.status(400).json({ error: '无效的访客类型' });
        }

        // 检查用户名和邮箱是否已存在
        const { data: existingGuest } = await supabase
            .from('guests')
            .select('id')
            .or(`username.eq.${username},email.eq.${email}`)
            .single();

        if (existingGuest) {
            return res.status(409).json({ error: '用户名或邮箱已被使用' });
        }

        // 创建密码哈希
        const password_hash = await bcryptjs.hash(password, 10);
        const valid_until = new Date();
        valid_until.setDate(valid_until.getDate() + valid_days);

        // 插入访客记录
        const { data: guest, error: insertError } = await supabase
            .from('guests')
            .insert([{
                username,
                email,
                password_hash,
                full_name: full_name || username,
                guest_type,
                status: 'active',
                has_export_permission: false,
                valid_from: new Date(),
                valid_until: valid_until,
                remark: `自助注册的${guest_type === 'viewer' ? '只读' : '导出申请'}访客`
            }])
            .select()
            .single();

        if (insertError) {
            console.error('插入访客记录错误:', insertError);
            return res.status(500).json({ error: '注册失败: ' + insertError.message });
        }

        // 生成 JWT Token
        const token = jwt.sign(
            {
                guestId: guest.id,
                username: guest.username,
                email: guest.email,
                type: 'guest',
                guest_type: guest.guest_type,
                has_export_permission: guest.has_export_permission
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRE }
        );

        res.status(201).json({
            success: true,
            message: '注册成功',
            token,
            guest: {
                id: guest.id,
                username: guest.username,
                email: guest.email,
                full_name: guest.full_name,
                guest_type: guest.guest_type,
                has_export_permission: guest.has_export_permission,
                valid_until: guest.valid_until
            }
        });
    } catch (error) {
        console.error('访客注册错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 访客登录
 * POST /api/guest/login
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: '用户名和密码不能为空' });
        }

        // 查询访客
        const { data: guest, error: queryError } = await supabase
            .from('guests')
            .select('*')
            .eq('username', username)
            .single();

        if (queryError || !guest) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // 检查访客状态
        if (guest.status !== 'active') {
            return res.status(403).json({ error: '访客账号已被禁用或已过期' });
        }

        // 检查有效期
        const now = new Date();
        if (new Date(guest.valid_until) < now) {
            // 更新状态为过期
            await supabase
                .from('guests')
                .update({ status: 'expired' })
                .eq('id', guest.id);
            return res.status(403).json({ error: '访客账号已过期' });
        }

        // 验证密码
        const passwordMatch = await bcryptjs.compare(password, guest.password_hash);
        if (!passwordMatch) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }

        // 更新最后登录时间
        await supabase
            .from('guests')
            .update({ last_login: new Date() })
            .eq('id', guest.id);

        // 记录登录日志
        await supabase
            .from('guest_login_logs')
            .insert([{
                guest_id: guest.id,
                status: 'success',
                ip_address: req.ip,
                user_agent: req.get('user-agent')
            }]);

        // 生成 JWT Token
        const token = jwt.sign(
            {
                guestId: guest.id,
                username: guest.username,
                email: guest.email,
                type: 'guest',
                guest_type: guest.guest_type,
                has_export_permission: guest.has_export_permission
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRE }
        );

        res.json({
            success: true,
            token,
            guest: {
                id: guest.id,
                username: guest.username,
                email: guest.email,
                full_name: guest.full_name,
                guest_type: guest.guest_type,
                has_export_permission: guest.has_export_permission,
                valid_until: guest.valid_until
            }
        });
    } catch (error) {
        console.error('访客登录错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 验证访客 Token
 * POST /api/guest/verify-token
 */
router.post('/verify-token', (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ valid: false, error: '令牌缺失' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.type !== 'guest') {
            return res.status(401).json({ valid: false, error: '无效的访客令牌' });
        }

        res.json({
            valid: true,
            guestId: decoded.guestId,
            username: decoded.username,
            guest_type: decoded.guest_type,
            has_export_permission: decoded.has_export_permission
        });
    } catch (error) {
        res.status(401).json({ valid: false, error: '令牌验证失败: ' + error.message });
    }
});

/**
 * 获取访客列表（管理员用）
 * GET /api/guest/list
 */
router.get('/list', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可访问' });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const { data: guests, error: queryError, count } = await supabase
            .from('guests')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (queryError) {
            return res.status(500).json({ error: '查询访客列表失败: ' + queryError.message });
        }

        res.json({
            success: true,
            data: guests,
            total: count,
            page,
            limit
        });
    } catch (error) {
        console.error('获取访客列表错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 创建访客（管理员用）
 * POST /api/guest/create
 */
router.post('/create', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可操作' });
        }

        const { username, email, password, full_name, guest_type = 'viewer', valid_days = 30, remark } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: '用户名、邮箱和密码不能为空' });
        }

        if (!['viewer', 'export_applicant'].includes(guest_type)) {
            return res.status(400).json({ error: '无效的访客类型' });
        }

        // 检查用户名和邮箱是否已存在
        const { data: existingGuest } = await supabase
            .from('guests')
            .select('id')
            .or(`username.eq.${username},email.eq.${email}`)
            .single();

        if (existingGuest) {
            return res.status(409).json({ error: '用户名或邮箱已被使用' });
        }

        // 创建密码哈希
        const password_hash = await bcryptjs.hash(password, 10);
        const valid_until = new Date();
        valid_until.setDate(valid_until.getDate() + valid_days);

        // 插入访客记录
        const { data: guest, error: insertError } = await supabase
            .from('guests')
            .insert([{
                username,
                email,
                password_hash,
                full_name: full_name || username,
                guest_type,
                status: 'active',
                has_export_permission: false,
                valid_from: new Date(),
                valid_until: valid_until,
                created_by: req.user.userId,
                remark: remark || `由管理员 ${req.user.username} 创建`
            }])
            .select()
            .single();

        if (insertError) {
            console.error('插入访客记录错误:', insertError);
            return res.status(500).json({ error: '创建失败: ' + insertError.message });
        }

        res.status(201).json({
            success: true,
            message: '访客创建成功',
            guest: {
                id: guest.id,
                username: guest.username,
                email: guest.email,
                full_name: guest.full_name,
                guest_type: guest.guest_type,
                valid_until: guest.valid_until
            }
        });
    } catch (error) {
        console.error('创建访客错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 删除访客（管理员用）
 * DELETE /api/guest/:guestId
 */
router.delete('/:guestId', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可操作' });
        }

        const { guestId } = req.params;

        const { error: deleteError } = await supabase
            .from('guests')
            .delete()
            .eq('id', guestId);

        if (deleteError) {
            return res.status(500).json({ error: '删除失败: ' + deleteError.message });
        }

        res.json({ success: true, message: '访客已删除' });
    } catch (error) {
        console.error('删除访客错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

/**
 * 禁用/启用访客（管理员用）
 * PUT /api/guest/:guestId/status
 */
router.put('/:guestId/status', validateToken, async (req, res) => {
    try {
        // 验证是否是管理员
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: '仅管理员可操作' });
        }

        const { guestId } = req.params;
        const { status } = req.body;

        if (!['active', 'disabled', 'expired'].includes(status)) {
            return res.status(400).json({ error: '无效的状态值' });
        }

        const { data: guest, error: updateError } = await supabase
            .from('guests')
            .update({ status })
            .eq('id', guestId)
            .select()
            .single();

        if (updateError) {
            return res.status(500).json({ error: '更新失败: ' + updateError.message });
        }

        res.json({
            success: true,
            message: `访客状态已更新为 ${status}`,
            guest
        });
    } catch (error) {
        console.error('更新访客状态错误:', error);
        res.status(500).json({ error: '服务器错误: ' + error.message });
    }
});

export default router;
