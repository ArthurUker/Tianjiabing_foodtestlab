// ====== 学校管理 / 学校配置 / 回收站 / 字段选项 / 学校用户路由（P1-5 拆路由 Step 2）======
// 从 server.js 抽取。静态依赖直接 import；运行时依赖（prisma、中间件）经工厂函数注入。
import express from 'express'
import crypto from 'crypto'
import bcryptjs from 'bcryptjs'
import { provisionSchool, isValidSchoolCode } from '../lib/tenantProvisioner.js'
import { createTenantClient, schemaNameOf } from '../lib/tenantClient.js'
import {
    listFieldOptions, buildFieldCascade, ensureFieldOptionSeeds,
    replaceFieldOptions, createFieldOption, updateFieldOption, deleteFieldOption,
} from '../lib/fieldOptionService.js'
import { sanitizeFieldOptionsForClient, validateCustomizationPayload, HEX_COLOR_RE } from '../lib/customizationValidate.js'
import { isSafeLogoUrl } from '../lib/securityGuards.js'
import { writeAdminOpsLog } from '../lib/auditLog.js'

// 定制配置的全部 JSON 列（与 schema.prisma SchoolCustomization 对齐）
const CUSTOMIZATION_COLUMNS = [
    'visible_types', 'visible_menu_items', 'canteens', 'field_labels', 'hidden_fields', 'theme_config', 'field_rules',
    'field_options', 'field_order', 'custom_fields', 'test_types', 'field_types'
]

// 兼容辅助：回收站快照中 jsonb 字段曾被 raw SQL 序列化为字符串（历史 double-encode 数据），
// 恢复时需还原为对象/数组再交给 Model API；parse 失败（脏数据）降级为 null。
function safeParseJson(val) {
    try { return JSON.parse(val) } catch (_) { return null }
}

const RECYCLE_KEEP_DAYS = 90 // 3 个月

const SCHOOL_USER_ROLES = ['manager', 'operator', 'viewer']
const isSchoolUserRole = (r) => SCHOOL_USER_ROLES.includes(r)
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/
const PHONE_RE = /^[0-9+\-\s]{5,20}$/

export function createSchoolRoutes({ prisma, authenticateUser, clearGuestVisibleTypesCache, rateLimit, requirePlatformSuperAdmin }) {
    const router = express.Router()

    // 确保 SchoolCustomization 记录存在（等价 ON CONFLICT DO NOTHING：已存在则忽略，不刷新 updated_at）。
    // 捕获 P2002 唯一冲突（school_code 唯一索引）实现幂等，避免 findUnique+create 的并发竞态。
    async function ensureCustomizationRow(code) {
        try {
            await prisma.schoolCustomization.create({ data: { school_code: code } })
        } catch (e) {
            if (e?.code !== 'P2002') throw e
        }
    }

    // ====== School Config（外观 / 字段个性化，直连 public 系统表，不受 search_path 影响）======
    router.get('/api/school/config', authenticateUser, async (req, res) => {
        try {
            const code = req.user?.schoolCode || ''
            // 系统表位于 public，使用显式 schema 前缀，确保不依赖 search_path
            const schoolRows = await prisma.$queryRawUnsafe(
                `SELECT "code","name","short_name","theme_color","logo_url","status" FROM public."School" WHERE "code" = $1 LIMIT 1`,
                code
            )
            const customizationRow = await prisma.schoolCustomization.findUnique({
                where: { school_code: code },
                select: Object.fromEntries([...CUSTOMIZATION_COLUMNS, 'updated_at'].map(c => [c, true]))
            })
            const school = schoolRows?.[0] || null
            const customization = customizationRow || null
            // 字段级联配置（FieldOption 表）：合并进 customization 返回（录入端经缓存统一消费）
            if (customization && code) {
                try {
                    customization.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                    customization.field_options = sanitizeFieldOptionsForClient(customization.field_options)
                } catch (_) { /* 表尚未创建时忽略 */ }
            }
            res.json({
                success: true,
                data: {
                    schoolCode: code,
                    school,
                    customization
                }
            })
        } catch (error) {
            // 表尚未创建（如未执行迁移）时优雅降级，返回空配置而非 500
            res.json({
                success: true,
                data: { schoolCode: req.user?.schoolCode || '', school: null, customization: null },
                note: 'school tables not provisioned yet'
            })
        }
    })

    // ====== 学校个性化配置（登录前公开查询，方案A 访问层）======
    // 在用户登录前即可按 schoolCode 返回 Logo / 主题色 / 字段定制，实现登录页个性化。
    // schoolCode 来自 URL 路径前缀（前端 extractSchoolCode），系统表位于 public。
    // DS-04: 公开端点加限速（同 IP 每分钟 ≤ 60 次），防枚举/刷接口
    router.get('/api/schools/:schoolCode/config', rateLimit(60, 60 * 1000), async (req, res) => {
        try {
            const code = req.params.schoolCode
            if (!isValidSchoolCode(code)) {
                return res.status(400).json({ error: '非法学校代码' })
            }
            const schoolRows = await prisma.$queryRawUnsafe(
                `SELECT "code","name","short_name","theme_color","logo_url","status" FROM public."School" WHERE "code" = $1 LIMIT 1`,
                code
            )
            const customizationRow = await prisma.schoolCustomization.findUnique({
                where: { school_code: code },
                select: Object.fromEntries([...CUSTOMIZATION_COLUMNS, 'guest_enabled', 'updated_at'].map(c => [c, true]))
            })
            const school = schoolRows?.[0] || null
            if (!school || school.status !== 'active') {
                return res.status(404).json({ error: '学校不存在或未激活' })
            }
            const customization = customizationRow || null
            // 迁移 Model API：Json 字段返回对象/数组；下方兜底仅针对历史 double-encode 脏数据（jsonb 字符串）
            if (customization) {
                for (const key of ['custom_fields', 'field_labels', 'hidden_fields', 'field_order', 'test_types', 'theme_config', 'field_rules', 'visible_menu_items', 'canteens', 'field_types']) {
                    if (typeof customization[key] === 'string') {
                        try { customization[key] = JSON.parse(customization[key]) } catch (_) { customization[key] = {} }
                    }
                }
                try {
                    customization.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                    customization.field_options = sanitizeFieldOptionsForClient(customization.field_options)
                } catch (_) { /* 租户表未 provision 时忽略 */ }
            }
            res.json({
                success: true,
                data: {
                    schoolCode: code,
                    name: school.name,
                    shortName: school.short_name,
                    themeColor: school.theme_color,
                    logoUrl: school.logo_url,
                    updatedAt: school.updated_at || null,
                    customization
                }
            })
        } catch (error) {
            res.status(500).json({ error: '查询学校配置失败' })
        }
    })

    // ====== School Management (超管：动态新增/列出学校，方案② 运行时建 schema) ======
    // requirePlatformSuperAdmin 由工厂函数注入（与 server.js 的 adminBackupRoutes 共用同一实现）。

    // 列出所有学校
    router.get('/api/admin/schools', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT "code","name","short_name","theme_color","logo_url","status","created_at"
                 FROM public."School" ORDER BY "created_at" DESC`
            )
            res.json({ success: true, data: rows })
        } catch (error) {
            console.error('❌ Error listing schools:', error)
            res.status(500).json({ error: '获取学校列表失败' })
        }
    })

    // 动态新增学校（建 schema + 推表 + 系统记录 + 租户首个 manager 账号）
    router.post('/api/admin/schools', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code, name, adminUsername, adminPassword } = req.body || {}
            if (!isValidSchoolCode(code)) {
                return res.status(400).json({ error: '❌ 非法学校代码（仅允许小写字母、数字、连字符，长度 1~40）' })
            }
            // 初始 manager 用户名：可选，默认 'manager'；提供时必须符合用户名规则
            if (adminUsername != null && adminUsername !== '' && !/^[a-zA-Z0-9_]{3,50}$/.test(String(adminUsername))) {
                return res.status(400).json({ error: '❌ 初始管理员用户名需为 3~50 位字母、数字或下划线' })
            }
            if (!adminPassword || String(adminPassword).length < 8) {
                return res.status(400).json({ error: '❌ 必须提供该校 manager 初始密码（至少 8 位）' })
            }

            const result = await provisionSchool({
                prisma,
                code,
                name,
                adminUsername: adminUsername || 'manager',
                adminPassword,
                log: (m) => console.log(`[provision:${code}] ${m}`)
            })

            // 字段选项种子（FieldOption 表）：新学校开通即带系统默认选项与级联
            try {
                await ensureFieldOptionSeeds(prisma, code, (m) => console.log(`[provision:${code}] ${m}`))
            } catch (e) {
                console.warn(`⚠️ 字段选项种子失败 ${code}:`, e.message)
            }

            res.json({
                success: true,
                message: `学校 ${code} 初始化完成`,
                data: result
            })
        } catch (error) {
            console.error('❌ Error provisioning school:', error)
            res.status(error.status || 500).json({ error: error.status === 409 ? error.message : '学校初始化失败' })
        }
    })

    // 更新学校基本信息（name/short_name/theme_color/logo_url）
    router.put('/api/admin/schools/:code', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const { name, shortName, themeColor, logoUrl, logoStyle, systemTitle, canteens, guestEnabled } = req.body || {}
            // RK8/DS-12: 主题色/Logo 服务器端校验
            if (themeColor != null && !HEX_COLOR_RE.test(themeColor)) {
                return res.status(400).json({ error: '主题色必须为 #RRGGBB 格式' })
            }
            if (logoUrl != null && logoUrl !== '' && !isSafeLogoUrl(logoUrl)) {
                return res.status(400).json({ error: 'Logo 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）' })
            }
            if (name != null && (typeof name !== 'string' || name.length > 100)) {
                return res.status(400).json({ error: '学校名称需为 ≤100 字符的字符串' })
            }
            if (shortName != null && (typeof shortName !== 'string' || shortName.length > 50)) {
                return res.status(400).json({ error: '学校简称需为 ≤50 字符的字符串' })
            }
            // P1-1: 学校简称全校唯一（非空时查重，与 DB UNIQUE 约束 double-check，返回 409）
            if (shortName != null && String(shortName).trim() !== '') {
                const dupShort = await prisma.$queryRawUnsafe(
                    `SELECT 1 FROM public."School" WHERE "short_name" = $1 AND "code" <> $2 LIMIT 1`,
                    String(shortName).trim(), code
                )
                if (dupShort.length) {
                    return res.status(409).json({ error: `学校简称「${shortName}」已被其他学校使用` })
                }
            }
            const exists = await prisma.$queryRawUnsafe(
                `SELECT 1 FROM public."School" WHERE "code" = $1`, code
            )
            if (!exists.length) return res.status(404).json({ error: '学校不存在' })
            const updated = await prisma.$queryRawUnsafe(
                `UPDATE public."School"
                 SET "name" = COALESCE($2, "name"),
                     "short_name" = COALESCE($3, "short_name"),
                     "theme_color" = COALESCE($4, "theme_color"),
                     "logo_url" = COALESCE($5, "logo_url"),
                     "updated_at" = now()
                 WHERE "code" = $1
                 RETURNING "code","name","short_name","theme_color","logo_url","status"`,
                code, name ?? null, shortName ?? null, themeColor ?? null, logoUrl ?? null
            )
            // 校徽排版（logoStyle）与顶部状态栏标题（systemTitle）随基本信息一并保存：
            // 合并写入 SchoolCustomization.theme_config（logo_style / systemTitle），不影响其它定制。
            if (logoStyle !== undefined || systemTitle !== undefined) {
                if (logoStyle !== undefined && logoStyle !== null) {
                    if (typeof logoStyle !== 'object' || Array.isArray(logoStyle)) {
                        return res.status(400).json({ error: 'logoStyle 必须为对象或 null' })
                    }
                    if (logoStyle.croppedUrl && !isSafeLogoUrl(logoStyle.croppedUrl)) {
                        return res.status(400).json({ error: 'logoStyle.croppedUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）' })
                    }
                }
                // 系统标题（顶部状态栏显示内容）基础校验：字符串、≤50 字符、禁止控制字符/换行
                if (systemTitle !== undefined && systemTitle !== null && typeof systemTitle !== 'string') {
                    return res.status(400).json({ error: 'systemTitle 必须为字符串' })
                }
                await ensureCustomizationRow(code)
                const tcRow = await prisma.schoolCustomization.findUnique({
                    where: { school_code: code },
                    select: { theme_config: true }
                })
                let tc = tcRow?.theme_config
                if (typeof tc === 'string') tc = safeParseJson(tc) // 历史 double-encode 脏数据兜底
                if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) tc = {}
                if (logoStyle !== undefined) {
                    if (logoStyle === null) delete tc.logo_style
                    else tc.logo_style = logoStyle
                }
                if (systemTitle !== undefined) {
                    const t = (typeof systemTitle === 'string') ? systemTitle.trim() : ''
                    if (t === '') delete tc.systemTitle
                    else if (t.length <= 50 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) tc.systemTitle = t
                }
                await prisma.schoolCustomization.update({
                    where: { school_code: code },
                    data: { theme_config: tc }
                })
            }
            // 学校食堂信息：写入 SchoolCustomization.canteens，并同步 field_options.canteen，
            // 使录入表单（tableware/pesticide/oil/leanMeat）的食堂下拉自动应用
            if (canteens !== undefined) {
                if (canteens !== null && (!Array.isArray(canteens) || canteens.some(c => typeof c !== 'string' || c.trim().length === 0))) {
                    return res.status(400).json({ error: 'canteens 必须为非空字符串数组' })
                }
                const safeCanteens = Array.isArray(canteens) ? canteens.map(c => c.trim()).filter(Boolean) : []
                if (safeCanteens.length > 50) return res.status(400).json({ error: '食堂数量过多（≤50）' })
                await ensureCustomizationRow(code)
                await prisma.schoolCustomization.update({
                    where: { school_code: code },
                    data: { canteens: safeCanteens }
                })
                // 同步 field_options.canteen（让录入表单下拉自动应用）
                const foRow = await prisma.schoolCustomization.findUnique({
                    where: { school_code: code },
                    select: { field_options: true }
                })
                let fo = foRow?.field_options
                if (typeof fo === 'string') fo = safeParseJson(fo) // 历史 double-encode 脏数据兜底
                if (!fo || typeof fo !== 'object' || Array.isArray(fo)) fo = {}
                if (safeCanteens.length) fo.canteen = safeCanteens
                else delete fo.canteen
                await prisma.schoolCustomization.update({
                    where: { school_code: code },
                    data: { field_options: fo }
                })
            }
            // RBAC 收敛：访客功能开关（guest_enabled）由平台超管按校配置，写入 SchoolCustomization
            if (guestEnabled !== undefined) {
                if (typeof guestEnabled !== 'boolean') {
                    return res.status(400).json({ error: 'guestEnabled 必须为布尔值' })
                }
                await ensureCustomizationRow(code)
                await prisma.schoolCustomization.update({
                    where: { school_code: code },
                    data: { guest_enabled: guestEnabled }
                })
            }
            res.json({ success: true, data: updated[0] })
        } catch (error) {
            console.error('❌ Error updating school:', error)
            res.status(500).json({ error: '更新学校信息失败' })
        }
    })

    // 启用/停用学校
    router.patch('/api/admin/schools/:code/status', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const { status } = req.body || {}
            if (!['active', 'disabled'].includes(status)) {
                return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
            }
            const updated = await prisma.$queryRawUnsafe(
                `UPDATE public."School" SET "status" = $2, "updated_at" = now()
                 WHERE "code" = $1 RETURNING "code","name","status"`,
                code, status
            )
            if (!updated.length) return res.status(404).json({ error: '学校不存在' })
            res.json({ success: true, data: updated[0] })
        } catch (error) {
            res.status(500).json({ error: '更新学校状态失败' })
        }
    })

    // P1: 逻辑删除学校(软删除——仅置 disabled,不做物理删除,数据安全)
    router.delete('/api/admin/schools/:code', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            if (!isValidSchoolCode(code)) return res.status(400).json({ error: '非法学校代码' })
            const updated = await prisma.$queryRawUnsafe(
                `UPDATE public."School" SET "status" = 'disabled', "updated_at" = now()
                 WHERE "code" = $1 AND "status" <> 'disabled'
                 RETURNING "code","name","status"`,
                code
            )
            if (!updated.length) return res.status(404).json({ error: '学校不存在或已停用' })
            res.json({ success: true, message: `学校 ${code} 已停用（逻辑删除，数据保留）`, data: updated[0] })
        } catch (error) {
            console.error('❌ Error deleting school:', error)
            res.status(500).json({ error: '删除学校失败' })
        }
    })

    // ====== S1#1 回收站（垃圾箱）：彻底删除 / 恢复 / 列表 / 手动清除 ======
    // 决策（郭博）：物理删除 + 回收站 schema（路径 B，同库 ALTER SCHEMA RENAME 到 recycle_ 前缀），
    // 必须先停用才能彻底删除；暂存 3 个月可恢复；到期仅提醒、手动清除。

    // 彻底删除：校验已停用 → 快照 School + SchoolCustomization → RENAME schema → 删 School 行 → 记回收站
    router.delete('/api/admin/schools/:code/hard', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            if (!isValidSchoolCode(code)) return res.status(400).json({ error: '非法学校代码' })

            const rows = await prisma.$queryRawUnsafe(
                `SELECT "code","name","short_name","theme_color","logo_url","status"
                 FROM public."School" WHERE "code" = $1`, code
            )
            if (!rows.length) return res.status(404).json({ error: '学校不存在' })
            const school = rows[0]
            if (school.status !== 'disabled') {
                return res.status(409).json({ error: '必须先停用学校（软删除）后才能彻底删除' })
            }

            // 已存在未过期的回收记录（防重复）
            const existing = await prisma.$queryRawUnsafe(
                `SELECT 1 FROM public."recycle_bin" WHERE "original_code" = $1 AND "status" = 'active'`, code
            )
            if (existing.length) return res.status(409).json({ error: '该校已在回收站中，请先恢复或清除' })

            // 快照定制配置（School 行删除会级联删除 SchoolCustomization，恢复时需重建）
            // 迁移 Model API：Json 字段直接返回对象/数组，无需 JSON.parse，快照不再 double-encode
            const customizationRow = await prisma.schoolCustomization.findUnique({
                where: { school_code: code },
                select: Object.fromEntries(CUSTOMIZATION_COLUMNS.map(c => [c, true]))
            })
            const customizationSnapshot = customizationRow ? JSON.stringify(customizationRow) : null

            const recycleSchema = `recycle_${code}_${Date.now().toString(36)}`
            const now = new Date()
            const expiresAt = new Date(now.getTime() + RECYCLE_KEEP_DAYS * 24 * 3600 * 1000)
            const binId = crypto.randomUUID()

            // 事务：RENAME schema + 删 School 行 + 写回收站记录
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`ALTER SCHEMA "school_${code}" RENAME TO "${recycleSchema}"`)
                await tx.$executeRawUnsafe(`DELETE FROM public."School" WHERE "code" = $1`, code)
                await tx.$executeRawUnsafe(
                    `INSERT INTO public."recycle_bin"
                     (id, original_code, original_schema, recycle_schema, name, short_name, theme_color, logo_url,
                      customization, deleted_by, deleted_at, expires_at, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')`,
                    binId, code, `school_${code}`, recycleSchema, school.name, school.short_name,
                    school.theme_color, school.logo_url, customizationSnapshot,
                    req.user?.username || req.user?.userId || 'unknown', now, expiresAt
                )
            })
            res.json({ success: true, message: `学校 ${code} 已彻底删除，移入回收站（${RECYCLE_KEEP_DAYS} 天内可恢复）`, data: { id: binId, recycleSchema, expiresAt } })
        } catch (error) {
            console.error('❌ Error hard deleting school:', error)
            res.status(500).json({ error: '彻底删除学校失败：' + (error.message || '未知错误') })
        }
    })

    // 回收站列表
    router.get('/api/admin/recycle-bin', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const rows = await prisma.$queryRawUnsafe(
                `SELECT id, original_code, original_schema, recycle_schema, name, short_name, theme_color, logo_url,
                        deleted_by, deleted_at, expires_at, status
                 FROM public."recycle_bin" ORDER BY deleted_at DESC`
            )
            const now = new Date()
            const data = rows.map((r) => ({
                ...r,
                keepDays: Math.max(0, Math.ceil((new Date(r.expires_at) - now) / (24 * 3600 * 1000))),
                expired: new Date(r.expires_at) < now
            }))
            res.json({ success: true, data })
        } catch (error) {
            console.error('❌ Error listing recycle bin:', error)
            res.status(500).json({ error: '获取回收站失败' })
        }
    })

    // 恢复学校：RENAME schema 回来 + 重建 School + 重建 SchoolCustomization
    router.post('/api/admin/recycle-bin/:id/restore', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { id } = req.params
            const rows = await prisma.$queryRawUnsafe(
                `SELECT * FROM public."recycle_bin" WHERE "id" = $1`, id
            )
            if (!rows.length) return res.status(404).json({ error: '回收站记录不存在' })
            const bin = rows[0]
            if (bin.status !== 'active') return res.status(409).json({ error: '该记录已恢复或已清除' })
            if (new Date(bin.expires_at) < new Date()) {
                return res.status(409).json({ error: '该学校已超过 3 个月保留期，请先手动清除（数据已到期）' })
            }

            // 目标 schema 是否已被占用（恢复冲突）
            const clash = await prisma.$queryRawUnsafe(
                `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, bin.original_schema
            )
            if (clash.length) return res.status(409).json({ error: `目标 schema ${bin.original_schema} 已存在，无法恢复` })

            let customization = null
            try { customization = bin.customization ? JSON.parse(bin.customization) : null } catch (_) { customization = null }

            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`ALTER SCHEMA "${bin.recycle_schema}" RENAME TO "${bin.original_schema}"`)
                // 重建 School 行
                await tx.$executeRawUnsafe(
                    `INSERT INTO public."School" (id, code, name, short_name, theme_color, logo_url, status, created_at, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,'active',now(),now())`,
                    crypto.randomUUID(), bin.original_code, bin.name, bin.short_name, bin.theme_color, bin.logo_url
                )
                // 重建 SchoolCustomization（如有快照）
                // 迁移 Model API：Json 字段直接传对象/数组，Prisma 自动序列化，
                // 消除 ::jsonb cast 与 double-encode（FIX-08/R01/R15 的根因）。
                if (customization) {
                    const data = { school_code: bin.original_code }
                    for (const c of CUSTOMIZATION_COLUMNS) {
                        const val = customization[c] ?? null
                        // 兼容旧快照（raw SQL 曾把 jsonb 存为字符串）与脏数据：字符串先还原为对象/数组
                        data[c] = val === null ? null : (typeof val === 'string' ? safeParseJson(val) : val)
                    }
                    await tx.schoolCustomization.create({ data })
                }
                await tx.$executeRawUnsafe(`UPDATE public."recycle_bin" SET "status" = 'restored' WHERE "id" = $1`, id)
            })
            res.json({ success: true, message: `学校 ${bin.original_code} 已从回收站恢复`, data: { code: bin.original_code } })
        } catch (error) {
            console.error('❌ Error restoring school:', error)
            res.status(500).json({ error: '恢复学校失败：' + (error.message || '未知错误') })
        }
    })

    // 手动清除：彻底 DROP 回收站 schema + 标记 purged（3 个月到期后）
    router.post('/api/admin/recycle-bin/:id/purge', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { id } = req.params
            const rows = await prisma.$queryRawUnsafe(
                `SELECT * FROM public."recycle_bin" WHERE "id" = $1`, id
            )
            if (!rows.length) return res.status(404).json({ error: '回收站记录不存在' })
            const bin = rows[0]
            if (bin.status !== 'active') return res.status(409).json({ error: '该记录已恢复或已清除' })

            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${bin.recycle_schema}" CASCADE`)
                await tx.$executeRawUnsafe(`UPDATE public."recycle_bin" SET "status" = 'purged' WHERE "id" = $1`, id)
            })
            res.json({ success: true, message: `学校 ${bin.original_code} 已从回收站清除，数据不可恢复` })
        } catch (error) {
            console.error('❌ Error purging school:', error)
            res.status(500).json({ error: '清除回收站记录失败：' + (error.message || '未知错误') })
        }
    })

    // 获取学校定制配置
    router.get('/api/admin/schools/:code/customization', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const row = await prisma.schoolCustomization.findUnique({
                where: { school_code: code },
                select: Object.fromEntries([...CUSTOMIZATION_COLUMNS, 'guest_enabled', 'updated_at'].map(c => [c, true]))
            })
            // 级联配置（FieldOption 表）：合并进 data 一并返回，管理端级联编辑器据此渲染
            const data = row || null
            if (data) {
                try {
                    data.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                    data.field_options = sanitizeFieldOptionsForClient(data.field_options)
                } catch (_) { /* 租户表未 provision 时忽略 */ }
            }
            res.json({ success: true, data })
        } catch (error) {
            res.status(500).json({ error: '获取定制配置失败' })
        }
    })

    // 更新学校定制配置
    // 语义（BS-03）：body 中未出现的字段保持不变；显式传 null 的字段清空为 NULL；其余整体覆盖。
    // 并发（BS-06）：body 可带 expected_updated_at（乐观锁），与 DB 当前 updated_at 不一致时返回 409。
    router.put('/api/admin/schools/:code/customization', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const body = req.body || {}

            // RK8/RK10/RK11/RK12/DS-12/D-06: 服务器端校验 + 净化
            const { valid, errors, normalized } = validateCustomizationPayload(body)
            if (!valid) {
                return res.status(400).json({ error: '定制配置校验失败', details: errors })
            }

            // 确保 SchoolCustomization 记录存在（等价 ON CONFLICT DO NOTHING）
            await ensureCustomizationRow(code)

            // BS-06: 乐观锁（向后兼容——不传 expected_updated_at 时保持旧行为）
            if (Object.prototype.hasOwnProperty.call(body, 'expected_updated_at') && body.expected_updated_at) {
                const cur = await prisma.schoolCustomization.findUnique({
                    where: { school_code: code },
                    select: { updated_at: true }
                })
                const currentUpdatedAt = cur?.updated_at ? new Date(cur.updated_at).toISOString() : null
                const expected = new Date(body.expected_updated_at).toISOString()
                if (currentUpdatedAt && expected !== currentUpdatedAt) {
                    return res.status(409).json({
                        error: 'conflict',
                        message: '定制配置已被其他人修改，请刷新后重试',
                        current_updated_at: currentUpdatedAt
                    })
                }
            }

            // 仅更新 body 中出现的字段：Json 字段直接传对象/数组（Prisma 自动序列化），无需 ::jsonb cast
            const data = {}
            for (const col of CUSTOMIZATION_COLUMNS) {
                if (!Object.prototype.hasOwnProperty.call(normalized, col)) continue
                data[col] = normalized[col] // 对象/数组/null，Prisma 自动 JSON 序列化
            }
            // guest_enabled 为 boolean 列（非 jsonb），单独处理
            if (Object.prototype.hasOwnProperty.call(normalized, 'guest_enabled')) {
                data.guest_enabled = normalized.guest_enabled
            }
            if (Object.keys(data).length === 0) {
                return res.status(400).json({ error: '未提供任何可更新的定制字段' })
            }
            const updated = await prisma.schoolCustomization.update({
                where: { school_code: code },
                data
            })

            // BS-11: 审计（失败不阻断主流程）。
            try {
                await writeAdminOpsLog(prisma, {
                    action: 'update_customization',
                    level: 'info',
                    actor: {
                        userId: req.user?.userId ?? null,
                        username: req.user?.username ?? null,
                        role: req.user?.role ?? null,
                        schoolCode: req.user?.schoolCode ?? null,
                        ip: req.ip ?? null
                    },
                    targetId: code,
                    targetSchoolCode: code,
                    details: { changedFields: Object.keys(normalized) }
                })
            } catch (auditErr) {
                console.error('⚠️ customization audit log failed:', auditErr.message)
            }

            // REG-01/NB-18: 清除访客 visible_types 缓存，使新配置立即对访客生效
            try { clearGuestVisibleTypesCache(code) } catch (e) { console.warn('⚠️ clearGuestVisibleTypesCache failed:', e.message) }

            res.json({ success: true, message: '定制配置已更新', updated_at: updated?.updated_at ?? null })
        } catch (error) {
            console.error('❌ Error updating customization:', error)
            res.status(500).json({ error: '更新定制配置失败' })
        }
    })

    // ====== 字段选项（FieldOption 表）：动态表单级联配置，平台超管专属 ======
    // 数据落在租户 schema（school_<code>）的 FieldOption 表，经 createTenantClient 路由。
    function assertFieldOptionCode(req, res) {
        const { code } = req.params
        if (!isValidSchoolCode(code)) {
            res.status(400).json({ error: '非法学校代码' })
            return null
        }
        return code
    }
    function recordFieldOptionAudit(req, code, action, details) {
        try {
            return writeAdminOpsLog(prisma, {
                action,
                level: 'info',
                actor: {
                    userId: req.user?.userId ?? null,
                    username: req.user?.username ?? null,
                    role: req.user?.role ?? null,
                    schoolCode: req.user?.schoolCode ?? null,
                    ip: req.ip ?? null
                },
                targetId: code,
                targetSchoolCode: code,
                details
            })
        } catch (e) {
            console.error('⚠️ field-options audit log failed:', e.message)
            return Promise.resolve()
        }
    }

    // 1) 列出选项树
    router.get('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        const code = assertFieldOptionCode(req, res)
        if (!code) return
        try {
            const db = createTenantClient(prisma, code)
            const module = req.query.module || undefined
            const field = req.query.field || undefined
            const data = await listFieldOptions(db, { module, field })
            res.json({ success: true, data })
        } catch (e) {
            res.status(400).json({ error: e.message })
        }
    })

    // 2) 创建单条选项
    router.post('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        const code = assertFieldOptionCode(req, res)
        if (!code) return
        try {
            const db = createTenantClient(prisma, code)
            const row = await createFieldOption(db, req.body || {})
            await recordFieldOptionAudit(req, code, 'create_field_option', {
                moduleCode: row.module_code, fieldCode: row.field_code, value: row.value, optionId: row.id
            })
            res.json({ success: true, data: row })
        } catch (e) {
            res.status(400).json({ error: e.message })
        }
    })

    // 3) 整树替换某 (module, field) 的选项
    router.put('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        const code = assertFieldOptionCode(req, res)
        if (!code) return
        try {
            const db = createTenantClient(prisma, code)
            const { module_code, field_code } = req.body || {}
            const result = await replaceFieldOptions(db, req.body || {})
            await recordFieldOptionAudit(req, code, 'replace_field_options', {
                moduleCode: module_code, fieldCode: field_code, created: result.created
            })
            res.json({ success: true, ...result })
        } catch (e) {
            res.status(400).json({ error: e.message })
        }
    })

    // 4) 更新单条选项
    router.patch('/api/admin/schools/:code/field-options/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        const code = assertFieldOptionCode(req, res)
        if (!code) return
        try {
            const db = createTenantClient(prisma, code)
            const row = await updateFieldOption(db, req.params.id, req.body || {})
            await recordFieldOptionAudit(req, code, 'update_field_option', {
                optionId: row.id, moduleCode: row.module_code, fieldCode: row.field_code, value: row.value
            })
            res.json({ success: true, data: row })
        } catch (e) {
            res.status(400).json({ error: e.message })
        }
    })

    // 5) 删除单条选项（有子选项时 400 拒绝——删除保护）
    router.delete('/api/admin/schools/:code/field-options/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        const code = assertFieldOptionCode(req, res)
        if (!code) return
        try {
            const db = createTenantClient(prisma, code)
            await deleteFieldOption(db, req.params.id)
            await recordFieldOptionAudit(req, code, 'delete_field_option', { optionId: req.params.id })
            res.json({ success: true })
        } catch (e) {
            res.status(400).json({ error: e.message })
        }
    })

    // 列出该校用户（跨 schema 查询）
    router.get('/api/admin/schools/:code/users', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            const tenantPrisma = createTenantClient(prisma, code)
            const users = await tenantPrisma.$queryRawUnsafe(
                `SELECT "id","username","role","status","created_at","last_login"
                 FROM "${schema}"."User" ORDER BY "created_at" DESC`
            )
            res.json({ success: true, data: users })
        } catch (error) {
            const msg = error.message || String(error)
            // 学校尚未初始化（schema / User 表不存在）时返回空列表，而不是 500
            const missingTable =
                error.code === '42P01' ||
                error.code === 'P2021' ||
                /does not exist/i.test(msg)
            if (missingTable) {
                console.warn(`⚠️ 学校 ${code} 尚未初始化（缺 User 表），返回空列表`)
                return res.json({
                    success: true,
                    data: [],
                    warning: `学校「${code}」尚未初始化，请点击「重新初始化」或检查 provision`
                })
            }
            console.error('❌ Error listing school users:', error)
            res.status(500).json({ error: '获取用户列表失败' })
        }
    })

    // 重新初始化某学校（幂等：补全 schema / 表结构 / 首个 manager）
    router.post('/api/admin/schools/:code/reprovision', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            if (!isValidSchoolCode(code)) return res.status(400).json({ error: '非法学校代码' })
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            const adminPassword = req.body?.adminPassword || process.env.SEED_ADMIN_PASSWORD
            if (!adminPassword || String(adminPassword).length < 8) {
                return res.status(400).json({ error: '⚠️ 必须提供 adminPassword（至少 8 位）' })
            }
            const result = await provisionSchool({
                prisma,
                code,
                name: req.body?.name,
                adminPassword,
                allowExisting: true   // P2: reprovision 显式重建,允许 schema 已存在
            })
            // 字段选项种子（幂等：已有顶级选项的字段不会被覆盖）
            try {
                await ensureFieldOptionSeeds(prisma, code, () => {})
            } catch (e) {
                console.warn(`⚠️ 字段选项种子失败 ${code}:`, e.message)
            }
            res.json({ success: true, message: `学校「${code}」已重新初始化`, result })
        } catch (error) {
            console.error('❌ Error reprovisioning school:', error)
            res.status(500).json({ error: '重新初始化失败' })
        }
    })

    // 重置该校用户密码
    router.post('/api/admin/schools/:code/users/:userId/reset-password', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code, userId } = req.params
            const { newPassword } = req.body || {}
            if (!newPassword || String(newPassword).length < 8) {
                return res.status(400).json({ error: '新密码至少 8 位' })
            }
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            const hash = await bcryptjs.hash(newPassword, 10)
            const tenantPrisma = createTenantClient(prisma, code)
            const result = await tenantPrisma.$executeRawUnsafe(
                `UPDATE "${schema}"."User" SET "password_hash" = $2, "must_change_password" = true WHERE "id" = $1`,
                userId, hash
            )
            if (!result) return res.status(404).json({ error: '用户不存在' })
            res.json({ success: true, message: '密码已重置' })
        } catch (error) {
            console.error('❌ Error resetting password:', error)
            res.status(500).json({ error: '重置密码失败' })
        }
    })

    // 启用/停用该校用户
    router.patch('/api/admin/schools/:code/users/:userId/status', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code, userId } = req.params
            const { status: newStatus } = req.body
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            if (!['active', 'disabled'].includes(newStatus)) {
                return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
            }
            const tenantPrisma = createTenantClient(prisma, code)
            const result = await tenantPrisma.$executeRawUnsafe(
                `UPDATE "${schema}"."User" SET "status" = $2 WHERE "id" = $1`,
                userId, newStatus
            )
            if (!result) return res.status(404).json({ error: '用户不存在' })
            res.json({ success: true, message: `用户已${newStatus === 'active' ? '启用' : '停用'}` })
        } catch (error) {
            console.error('❌ Error updating user status:', error)
            res.status(500).json({ error: '更新用户状态失败' })
        }
    })

    // 新增用户（平台超管为学校创建用户）
    router.post('/api/admin/schools/:code/users', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code } = req.params
            const { username, full_name, phone, role, password } = req.body || {}
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: '用户名需为 3-32 位字母、数字或下划线' })
            if (!isSchoolUserRole(role)) return res.status(400).json({ error: '用户类别无效（不能为平台管理员 admin）' })
            if (!password || String(password).length < 8) return res.status(400).json({ error: '初始密码至少 8 位' })
            if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式不正确' })
            const tenantPrisma = createTenantClient(prisma, code)
            const exist = await tenantPrisma.$queryRawUnsafe(
                `SELECT "id" FROM "${schema}"."User" WHERE "username" = $1`, username
            )
            if (exist.length) return res.status(409).json({ error: '用户名已存在' })
            // P1-1: 手机号全校唯一（非空时查重；空值允许多个）
            if (phone && String(phone).trim()) {
                const dupPhone = await tenantPrisma.$queryRawUnsafe(
                    `SELECT "id" FROM "${schema}"."User" WHERE "phone" = $1 LIMIT 1`, String(phone).trim()
                )
                if (dupPhone.length) return res.status(409).json({ error: '手机号已被其他用户使用' })
            }
            const hash = await bcryptjs.hash(String(password), 10)
            const id = crypto.randomUUID()
            // M2: 新建用户的「初始密码」属于临时密码，必须置 must_change_password=true
            await tenantPrisma.$executeRawUnsafe(
                `INSERT INTO "${schema}"."User" ("id","username","password_hash","role","full_name","phone","status","school_code","must_change_password","created_at","updated_at")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())`,
                id, username, hash, role, full_name || null, phone || null, 'active', code
            )
            res.status(201).json({
                success: true,
                message: '用户创建成功',
                user: { id, username, role, full_name: full_name || null, phone: phone || null, status: 'active' }
            })
        } catch (error) {
            console.error('❌ Error creating user:', error)
            res.status(500).json({ error: '创建用户失败' })
        }
    })

    // 更新用户（姓名 / 手机号 / 类别 / 状态 / 可选重置密码）
    router.put('/api/admin/schools/:code/users/:userId', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code, userId } = req.params
            const { full_name, phone, role, status, password } = req.body || {}
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            const tenantPrisma = createTenantClient(prisma, code)
            const cur = await tenantPrisma.$queryRawUnsafe(
                `SELECT "id","role","status" FROM "${schema}"."User" WHERE "id" = $1`, userId
            )
            if (!cur.length) return res.status(404).json({ error: '用户不存在' })
            const current = cur[0]
            if (role !== undefined) {
                if (role === 'admin') return res.status(400).json({ error: '不能将学校用户设置为平台管理员' })
                if (!isSchoolUserRole(role)) return res.status(400).json({ error: '用户类别无效' })
            }
            if (phone !== undefined && phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式不正确' })
            // P1-1: 手机号全校唯一（更新场景排除自身；仅对非空值查重）
            if (phone !== undefined && String(phone).trim()) {
                const dupPhone = await tenantPrisma.$queryRawUnsafe(
                    `SELECT "id" FROM "${schema}"."User" WHERE "phone" = $1 AND "id" <> $2 LIMIT 1`,
                    String(phone).trim(), userId
                )
                if (dupPhone.length) return res.status(409).json({ error: '手机号已被其他用户使用' })
            }
            if (status !== undefined && !['active', 'disabled'].includes(status)) {
                return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
            }
            // 防止学校失去唯一可管理人员（仅剩一名在职主管时，禁止停用或降级）
            const becomingNonManager = (role !== undefined && role !== 'manager')
            const willDisable = (status === 'disabled')
            if ((becomingNonManager || willDisable) && current.role === 'manager' && current.status === 'active') {
                const cnt = await tenantPrisma.$queryRawUnsafe(
                    `SELECT COUNT(*)::int AS c FROM "${schema}"."User" WHERE "role"='manager' AND "status"='active'`
                )
                if (Number(cnt[0].c) <= 1) return res.status(409).json({ error: '该校仅剩一名在职主管，无法停用或更改其类别' })
            }
            const sets = []
            const params = [userId]
            let i = 2
            if (full_name !== undefined) { sets.push(`"full_name"=$${i++}`); params.push(full_name || null) }
            if (phone !== undefined) { sets.push(`"phone"=$${i++}`); params.push(phone || null) }
            if (role !== undefined) { sets.push(`"role"=$${i++}`); params.push(role) }
            if (status !== undefined) { sets.push(`"status"=$${i++}`); params.push(status) }
            if (password) {
                if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' })
                const hash = await bcryptjs.hash(String(password), 10)
                sets.push(`"password_hash"=$${i++}`); params.push(hash)
            }
            if (!sets.length) return res.status(400).json({ error: '没有需要更新的字段' })
            sets.push(`"updated_at"=NOW()`)
            await tenantPrisma.$executeRawUnsafe(
                `UPDATE "${schema}"."User" SET ${sets.join(',')} WHERE "id" = $1`, ...params
            )
            res.json({ success: true, message: '用户更新成功' })
        } catch (error) {
            // FIX-14: 不再吞没异常。打印完整堆栈，并把真实错误信息透出。
            console.error('❌ Error updating user:', error)
            console.error('❌ [stack]', error?.stack)
            res.status(500).json({ error: '更新用户失败：' + (error?.message || '未知错误') })
        }
    })

    // 删除用户
    router.delete('/api/admin/schools/:code/users/:userId', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
        try {
            const { code, userId } = req.params
            const schema = schemaNameOf(code)
            if (!schema) return res.status(400).json({ error: '无效的学校代码' })
            const tenantPrisma = createTenantClient(prisma, code)
            const cur = await tenantPrisma.$queryRawUnsafe(
                `SELECT "id","username","role","status" FROM "${schema}"."User" WHERE "id" = $1`, userId
            )
            if (!cur.length) return res.status(404).json({ error: '用户不存在' })
            const current = cur[0]
            if (current.role === 'manager' && current.status === 'active') {
                const cnt = await tenantPrisma.$queryRawUnsafe(
                    `SELECT COUNT(*)::int AS c FROM "${schema}"."User" WHERE "role"='manager' AND "status"='active'`
                )
                if (Number(cnt[0].c) <= 1) return res.status(409).json({ error: '该校仅剩一名在职主管，无法删除' })
            }
            await tenantPrisma.$executeRawUnsafe(`DELETE FROM "${schema}"."User" WHERE "id" = $1`, userId)
            // REG-4: 平台超管删除租户用户必须留痕。
            try {
                await writeAdminOpsLog(prisma, {
                    action: 'admin_delete_school_user',
                    actor: {
                        userId: req.user?.userId ?? null,
                        username: req.user?.username ?? null,
                        role: req.user?.role ?? null,
                        schoolCode: req.user?.schoolCode ?? null,
                        ip: req.ip ?? null
                    },
                    targetId: userId,
                    targetSchoolCode: code,
                    details: {
                        targetUsername: current.username ?? null,
                        targetRole: current.role ?? null,
                        targetStatus: current.status ?? null
                    }
                })
            } catch (auditError) {
                console.error(`❌ 审计写入失败 (admin_delete_school_user target=${userId}): ${auditError.message}`)
            }
            res.json({ success: true, message: '用户已删除' })
        } catch (error) {
            console.error('❌ Error deleting user:', error)
            res.status(500).json({ error: '删除用户失败' })
        }
    })

    return router
}
