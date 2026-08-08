// N1/N2/N3: 检测频率阈值、检测日历、检测月报
// 权限: 阈值/日历配置 = manager 及以上(学校端)
import { Router } from 'express'

const router = Router()

// 检测项目 code -> 名称映射(与前端模块 test_type 对应)
// ⚠️ 命名约定：test_type 必须与 TestRecord.test_type 存储值完全一致
// （RECORD_ROUTE_TYPES / server.js TEST_TYPE_LABELS 统一用驼峰 leanMeat）。
// 历史上 frequency 模块曾误用下划线 lean_meat 导致月报统计恒为 0，此处已统一。
const TEST_TYPES = {
    tableware: { name: '餐具洁净度' },
    pesticide: { name: '果蔬农残' },
    oil: { name: '食用油' },
    leanMeat: { name: '肉蛋农残' },
    pathogen: { name: '病原体' }
}

// N1 默认周目标(餐具 5 次/周,其余 3 次/周)
const DEFAULT_WEEKLY_TARGET = { tableware: 5, pesticide: 3, oil: 3, leanMeat: 3, pathogen: 3 }

// N2 默认周计划(周一~周五轮排)
const DEFAULT_WEEKLY_PLAN = [
    { day_of_week: 1, test_type: 'tableware' },
    { day_of_week: 2, test_type: 'pesticide' },
    { day_of_week: 3, test_type: 'oil' },
    { day_of_week: 4, test_type: 'leanMeat' },
    { day_of_week: 5, test_type: 'pathogen' }
]

function requireManagerOrAbove(req, res, next) {
    const role = req.user?.role ?? req.userRole
    if (!role || (role !== 'manager' && role !== 'admin')) {
        return res.status(403).json({ error: '❌ 仅学校管理员可进行此操作' })
    }
    next()
}

/**
 * 确保某租户已初始化 N1 阈值与 N2 日历(幂等):
 * - 缺失的 test_type 阈值用默认值补齐
 * - 日历为空时写入默认周计划
 */
async function ensureSeed(db, schoolCode) {
    const code = schoolCode || 'default'

    // ⚠️ 历史数据迁移：旧版 frequency 模块误用下划线 lean_meat 存储阈值/日历，
    // 与 TestRecord.test_type=leanMeat 不一致导致月报统计恒为 0。此处幂等迁移：
    // 若租户存在旧的 lean_meat 阈值/日历行，改写为 leanMeat（防止重复 seed + 保持统计口径一致）。
    const legacyTypes = await db.frequencyThreshold.findMany({ where: { school_code: code, test_type: 'lean_meat' } })
    for (const row of legacyTypes) {
        await db.frequencyThreshold.update({
            where: { id: row.id },
            data: { test_type: 'leanMeat' }
        })
    }
    const legacyCal = await db.detectionCalendar.findMany({ where: { school_code: code, test_type: 'lean_meat' } })
    for (const row of legacyCal) {
        await db.detectionCalendar.update({
            where: { id: row.id },
            data: { test_type: 'leanMeat' }
        })
    }

    const thresholds = await db.frequencyThreshold.findMany({ where: { school_code: code } })
    const existingTypes = new Set(thresholds.map(t => t.test_type))
    for (const [type, target] of Object.entries(DEFAULT_WEEKLY_TARGET)) {
        if (!existingTypes.has(type)) {
            await db.frequencyThreshold.create({ data: { school_code: code, test_type: type, weekly_target: target } })
        }
    }

    const calCount = await db.detectionCalendar.count({ where: { school_code: code } })
    if (calCount === 0) {
        for (const item of DEFAULT_WEEKLY_PLAN) {
            await db.detectionCalendar.create({
                data: { school_code: code, test_type: item.test_type, day_of_week: item.day_of_week, enabled: true }
            })
        }
    }
}

// GET /api/frequency/overview —— N3 检测月报聚合
// 返回: 各项目本月次数、上月次数、环比变化、达标状态(对照阈值)、近6个月趋势
router.get('/overview', async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        await ensureSeed(db, schoolCode)

        const thresholds = await db.frequencyThreshold.findMany({ where: { school_code: schoolCode } })
        const thresholdMap = Object.fromEntries(thresholds.map(t => [t.test_type, t.weekly_target]))

        // 计算当月与上月各项目检测次数(基于 TestRecord.created_at)
        const now = new Date()
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)

        const [thisMonthRows, prevMonthRows] = await Promise.all([
            db.$queryRawUnsafe(
                `SELECT test_type, COUNT(*) AS cnt FROM "TestRecord"
                 WHERE created_at >= $1 AND created_at < $2 GROUP BY test_type`,
                monthStart, monthEnd
            ),
            db.$queryRawUnsafe(
                `SELECT test_type, COUNT(*) AS cnt FROM "TestRecord"
                 WHERE created_at >= $1 AND created_at < $2 GROUP BY test_type`,
                prevMonthStart, monthStart
            )
        ])

        const thisMonthMap = Object.fromEntries(thisMonthRows.map(r => [r.test_type, Number(r.cnt)]))
        const prevMonthMap = Object.fromEntries(prevMonthRows.map(r => [r.test_type, Number(r.cnt)]))

        // 近 6 个月趋势(按月)
        const trend = []
        for (let i = 5; i >= 0; i--) {
            const s = new Date(now.getFullYear(), now.getMonth() - i, 1)
            const e = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
            const rows = await db.$queryRawUnsafe(
                `SELECT test_type, COUNT(*) AS cnt FROM "TestRecord"
                 WHERE created_at >= $1 AND created_at < $2 GROUP BY test_type`,
                s, e
            )
            trend.push({
                month: `${s.getMonth() + 1}月`,
                counts: Object.fromEntries(rows.map(r => [r.test_type, Number(r.cnt)]))
            })
        }

        // 当前周(周一~周日)次数,用于 N1 风险判定
        const day = now.getDay() === 0 ? 7 : now.getDay() // 周一=1...周日=7
        const weekStart = new Date(now)
        weekStart.setDate(now.getDate() - (day - 1))
        weekStart.setHours(0, 0, 0, 0)
        const weekEnd = new Date(weekStart)
        weekEnd.setDate(weekStart.getDate() + 7)
        const weekRows = await db.$queryRawUnsafe(
            `SELECT test_type, COUNT(*) AS cnt FROM "TestRecord"
             WHERE created_at >= $1 AND created_at < $2 GROUP BY test_type`,
            weekStart, weekEnd
        )
        const weekMap = Object.fromEntries(weekRows.map(r => [r.test_type, Number(r.cnt)]))

        const items = []
        for (const [type, meta] of Object.entries(TEST_TYPES)) {
            const thisCnt = thisMonthMap[type] || 0
            const prevCnt = prevMonthMap[type] || 0
            const change = prevCnt === 0 ? (thisCnt > 0 ? 100 : 0) : Math.round(((thisCnt - prevCnt) / prevCnt) * 100)
            const target = thresholdMap[type] ?? DEFAULT_WEEKLY_TARGET[type]
            const weekCnt = weekMap[type] || 0
            items.push({
                test_type: type,
                name: meta.name,
                this_month: thisCnt,
                prev_month: prevCnt,
                change_pct: change,
                weekly_target: target,
                week_count: weekCnt,
                warning: weekCnt < target
            })
        }

        res.json({ success: true, data: { items, trend } })
    } catch (error) {
        console.error('❌ Frequency overview error:', error)
        res.status(500).json({ error: '获取检测频率统计失败' })
    }
})

// GET /api/frequency/thresholds —— N1 读取阈值(所有登录用户可读)
router.get('/thresholds', async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        await ensureSeed(db, schoolCode)
        const rows = await db.frequencyThreshold.findMany({ where: { school_code: schoolCode } })
        res.json({ success: true, data: rows })
    } catch (error) {
        console.error('❌ Get thresholds error:', error)
        res.status(500).json({ error: '获取检测频率阈值失败' })
    }
})

// PUT /api/frequency/thresholds —— N1 更新阈值(manager+)
router.put('/thresholds', requireManagerOrAbove, async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        const { test_type, weekly_target } = req.body
        if (!test_type || !Number.isInteger(weekly_target) || weekly_target < 1 || weekly_target > 100) {
            return res.status(400).json({ error: '参数错误: 需要有效的 test_type 与 1-100 的 weekly_target' })
        }
        await db.frequencyThreshold.upsert({
            where: { school_code_test_type: { school_code: schoolCode, test_type } },
            create: { school_code: schoolCode, test_type, weekly_target },
            update: { weekly_target }
        })
        res.json({ success: true, message: '✅ 检测频率阈值已更新' })
    } catch (error) {
        console.error('❌ Update threshold error:', error)
        res.status(500).json({ error: '更新检测频率阈值失败' })
    }
})

// GET /api/frequency/calendar —— N2 读取日历(所有登录用户可读)
router.get('/calendar', async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        await ensureSeed(db, schoolCode)
        const rows = await db.detectionCalendar.findMany({ where: { school_code: schoolCode }, orderBy: { day_of_week: 'asc' } })
        res.json({ success: true, data: rows })
    } catch (error) {
        console.error('❌ Get calendar error:', error)
        res.status(500).json({ error: '获取检测日历失败' })
    }
})

// PUT /api/frequency/calendar —— N2 更新日历(manager+)
// body: { items: [{ test_type, day_of_week, enabled }] } —— 全量覆盖
router.put('/calendar', requireManagerOrAbove, async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        const { items } = req.body
        if (!Array.isArray(items)) {
            return res.status(400).json({ error: '参数错误: items 需为数组' })
        }
        // 校验
        const validDays = new Set([1,2,3,4,5,6,7])
        for (const it of items) {
            if (!TEST_TYPES[it.test_type] || !validDays.has(Number(it.day_of_week))) {
                return res.status(400).json({ error: `无效的日历项: ${it.test_type} / ${it.day_of_week}` })
            }
        }
        // 全量替换(事务)
        await db.$transaction(async (tx) => {
            await tx.detectionCalendar.deleteMany({ where: { school_code: schoolCode } })
            for (const it of items) {
                await tx.detectionCalendar.create({
                    data: { school_code: schoolCode, test_type: it.test_type, day_of_week: Number(it.day_of_week), enabled: it.enabled !== false }
                })
            }
        })
        res.json({ success: true, message: '✅ 检测日历已更新' })
    } catch (error) {
        console.error('❌ Update calendar error:', error)
        res.status(500).json({ error: '更新检测日历失败' })
    }
})

// GET /api/frequency/today —— N2 每日提示: 今日(按星期几)待检测项目
router.get('/today', async (req, res) => {
    try {
        const db = req.db
        const schoolCode = req.user?.schoolCode || 'default'
        await ensureSeed(db, schoolCode)
        const now = new Date()
        const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay() // 周一=1...周日=7
        const rows = await db.detectionCalendar.findMany({
            where: { school_code: schoolCode, day_of_week: dayOfWeek, enabled: true }
        })
        const items = rows.map(r => ({ test_type: r.test_type, name: (TEST_TYPES[r.test_type] || {}).name || r.test_type }))
        res.json({ success: true, data: { date: now.toISOString(), day_of_week: dayOfWeek, items } })
    } catch (error) {
        console.error('❌ Get today error:', error)
        res.status(500).json({ error: '获取今日检测项目失败' })
    }
})

export default router
