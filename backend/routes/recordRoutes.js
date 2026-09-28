// ====== 检测记录路由（/api/test-records + /api/records，P1-5 拆路由 Step 2）======
// 从 server.js 抽取。req.db 由 authenticateUser 注入；幂等中间件经参数传入。
import express from 'express'
import fs from 'node:fs'
import { normalizeRecordType, buildRecordPayload, buildRecordWriteData, normalizeWriteJson, resolveWritableStatus, validateRecordPayload, writeRecordAuditLog, getLatestRecheckPassed, buildDeterministicRecordCode, RECORD_ROUTE_TYPES } from '../lib/recordNormalize.js'
// P3-W5-RECORD-T01（AUD-020 / RC-07）：完整读取契约（分页元数据 / keyset 游标 / 超限显式拒绝）
import { parsePageQuery, cursorWhere, mergeWhere, pageMeta } from '../lib/readContract.js'
// P3-W5-RECORD-T01（AUD-020 / RC-07）：权威导出作业（服务端快照 + 流式私有产物 + 原子发布）
import { createExportJob, getExportJob, runExportJob, requestCancel, isDownloadable, cleanupExpiredJobs, publicExportJobView, exportJobArtifactPath, EXPORT_JOB_STATES } from '../lib/exportJobs.js'
// P3-W5-RECORD-T01（AUD-002 / RC-01）：幂等作用域（tenant/subject）—— 与中间件同一实现
import { tenantScopeOf, subjectScopeOf } from '../middleware/idempotencyMiddleware.js'
import { sanitizeObjectKeys, safeParseJson } from '../lib/sanitize.js'
import { canModifyRecord, maskGuestSensitiveFields } from '../lib/securityGuards.js'
// 餐具「记录级结论」规则（顶层 result 为空时回退 atpPoints[].res）：
// 与 openApiScope / openApiRoutes / 前端 Dashboard 同一条规则，定义见 lib/tablewareVerdict.js
import { TABLEWARE_PASS_SQL } from '../lib/tablewareVerdict.js'
// 肉蛋品种归类（鱼、虾 → 鱼肉 等）：看板子卡由服务端聚合驱动，避免本地缓存漂移
import { MEAT_CARD_KEYS, toMeatCardKey } from '../lib/leanMeatCategory.js'
// 油脂结论口径的 SQL 等价物（唯一事实源 lib/conclusionVerdict.js；本文件只消费，不复制规则）
import { oilVerdictSql } from '../lib/conclusionVerdict.js'

const VALID_TEST_RECORD_STATUSES = new Set(['pending', 'completed', 'failed', 'archived'])

// A+B 修复（2026-09-14）：列表接口单次返回上限。
// 原为 500，但前端 Storage 的同步窗口（maxSyncRows）已提升到 1000 —— 若后端仍卡 500，
// 单模块超过 500 条时前端永远拉不全（田家炳补导后 leanMeat 481 条即接近该阈值）。
const MAX_RECORDS_LIMIT = 2000

export function createRecordRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, idempotencyMiddleware }) {
    const router = express.Router()

    // ====== Test Records API ======
    // P3-W5-RECORD-T01（AUD-002 / RC-01）：幂等中间件**不再**用 `router.use` 挂在认证之前 ——
    // 旧挂法（`router.use('/api/test-records'|'/api/records', idempotencyMiddleware)`）使未认证/无权限请求
    // 也能命中进程内缓存（跨主体泄漏 + 越权读取他人响应）。
    // 现改为逐写路由挂载，顺序固定为 `authenticateUser → requireEditorOrAbove → idempotencyMiddleware → handler`：
    //   · 身份键由中间件从认证上下文推导（tenant/subject/resource/method/operationId），同 key 同 body 的
    //     不同学校/不同账号不再互相命中；
    //   · 命中必然已通过**当前**认证与授权 → 权限被撤回的请求在命中前即被拒（旧权限缓存不授予新权限）。
    // 覆盖的 7 条写路由：POST /api/test-records、POST /api/records/:tableName、POST …/bulk-upsert、
    //   PUT/DELETE /api/records/:tableName/:id、PUT/DELETE /api/test-records/:id。

    // 创建测试记录
    router.post('/api/test-records', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const { test_type, test_name, sample_info, result_data } = req.body

            const recordCode = buildDeterministicRecordCode(test_type || 'generic', req.body)

            // P1-15: 前置幂等检查，重复提交返回已有记录（与 /api/records/:tableName 一致）
            const existing = await req.db.testRecord.findUnique({
                where: { record_code: recordCode }
            })

            if (existing) {
                return res.json({
                    success: true,
                    deduplicated: true,
                    data: existing,
                    message: '记录已存在，已按幂等策略返回现有数据'
                })
            }

            // 2026-09-16 审阅修复（H2）：改用统一归一 —— 上下文三键只落 sample_info、result_data 剔控制字段，
            // 且**拒绝**空结果/非法结构（原先直接透传 body：既不填 sample_info、也不剥离副本，
            // result_data 为 `{}` 时会静默写出空记录）。
            const norm = normalizeWriteJson({
                payload: sanitizeObjectKeys(req.body || {}),
                resultData: result_data,
                sampleInfo: sample_info,
                existingSampleInfo: null,
                mode: 'create',
                testType: test_type,
            })
            if (!norm.ok) {
                return res.status(400).json({ error: `❌ ${norm.message}`, code: norm.code })
            }
            const record = await req.db.testRecord.create({
                data: {
                    record_code: recordCode,
                    test_type: test_type || 'generic',
                    test_name,
                    sample_info: norm.sampleInfo,
                    result_data: norm.resultData,
                    created_by: req.userId,
                    status: 'pending'
                }
            })

            res.json({
                success: true,
                data: record,
                message: '测试记录创建成功'
            })
        } catch (error) {
            // P1-15: P2002 唯一约束冲突（并发重复写入）：按幂等策略返回已有记录
            if (error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'))) {
                try {
                    const existing = await req.db.testRecord.findUnique({
                        where: { record_code: buildDeterministicRecordCode(req.body?.test_type || 'generic', req.body || {}) }
                    })
                    if (existing) {
                        return res.json({ success: true, deduplicated: true, data: existing, message: '记录已存在（并发写入），已按幂等策略返回现有数据' })
                    }
                } catch (fallbackErr) { console.warn('[warn] POST /api/test-records 幂等降级回查失败:', fallbackErr.message); }
            }
            // P1-15: P2003 外键约束失败（created_by 用户不存在）：返回 422 而非 500
            if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
                console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
                return res.status(422).json({
                    error: '关联用户不存在，请重新登录',
                    code: 'INVALID_USER'
                })
            }
            console.error('❌ Error creating test record:', error)
            res.status(500).json({ error: '创建失败' })
        }
    })

    // 获取所有测试记录
    // 越权修复：guest 令牌原可读取所有模块记录（含 pathogen）。现经 requireGuestReadOnly
    // 注入 req.guestVisibleTypes（该校 visible_types ∩ 非 pathogen），在查询层强制过滤。
    router.get('/api/test-records', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const { limit = 100, offset = 0, test_type, status } = req.query

            const where = {}
            if (test_type) where.test_type = test_type
            if (status) where.status = status

            if (req.user?.role === 'guest') {
                const allowed = req.guestVisibleTypes || []
                if (test_type) {
                    if (!allowed.includes(test_type)) {
                        return res.status(403).json({ error: '❌ 访客无权访问该检测模块' })
                    }
                } else {
                    where.test_type = { in: allowed }
                }
            }

            // P3-W5-RECORD-T01（AUD-020 / RC-07）：明确分页契约 —— cursor 优先、offset 兼容、
            // **超限显式拒绝**（旧实现 `Math.min(limit, 2000)` 把 limit=10000 静默降成 2000）。
            const page = parsePageQuery(req.query)
            if (!page.ok) {
                return res.status(page.status).json({ error: page.error, code: page.code, ...(page.extra || {}) })
            }
            const effectiveWhere = mergeWhere(where, page.cursor ? cursorWhere(page.cursor) : null)

            const records = await req.db.testRecord.findMany({
                where: effectiveWhere,
                ...(page.cursor ? {} : { skip: page.offset }),
                take: page.limit,
                // 稳定顺序（keyset 游标的前提）：created_at 同值时用 id 兜底，避免并发写入下重复/漏行
                orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
            })

            const total = await req.db.testRecord.count({ where })

            // DS3-M6: guest 可见全校汇总数据（统计看板需要），但 PII 字段做部分掩码
            const payloads = records.map(buildRecordPayload)
            res.json({
                success: true,
                data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
                // 分页元数据（hasMore / nextCursor / totalBasis / filters / coverage）
                ...pageMeta({
                    rows: records,
                    total,
                    limit: page.limit,
                    offset: page.offset,
                    cursorUsed: !!page.cursor,
                    filters: {
                        test_type: test_type || null,
                        status: status || null,
                        guestVisibleTypes: req.user?.role === 'guest' ? (req.guestVisibleTypes || []) : null,
                    },
                }),
            })
        } catch (error) {
            console.error('❌ Error fetching test records:', error)
            res.status(500).json({
                error: '获取失败'
            })
        }
    })

    // ── GET /api/test-records/stats — 全校汇总统计（服务端聚合，不返回明细）──
    // 背景（A 方案）：看板原先用前端本地缓存统计，而 Storage 每模块最多同步 maxSyncRows 条
    // （服务端 orderBy created_at desc），数据量超过窗口后 总数/合格率 会漏统计。
    // 2026-09-14 田家炳补导历史数据后暴露：库内 1109 条，看板只显示 703。
    // 本接口在 DB 侧聚合，与前端 Dashboard.isQualified 口径对齐：
    //   tableware / pesticide / leanMeat：result 含"合格"且不含"不合格"
    //   oil（2026-09-25 AUD-025 修复）：等级 ∈ {合格, 警戒} 计合格；其它非空值（不合格 / 未识别）
    //        一律不计合格；仅等级为空时回退 result 规则 —— SQL 由 lib/conclusionVerdict.js
    //        `oilVerdictSql()` 同源生成，与访客统计/对外接口/前端看板逐字一致。
    //        旧实现 `colorLevel NOT LIKE '%不合格%'` 会把未识别等级（如"深绿色"/"foo"）计为合格（fail-open）。
    //   pathogen：riskLevel === '无风险' 计为合格；阳性数 = riskLevel 非空且 ≠ '无风险'
    // ⚠ 前端 isQualified 还含「学校自定义字段判定」(statRole='result')，本接口未复刻该分支；
    //   田家炳/实验中学/一中 field_rules 与 custom_fields 均为空，故当前完全一致。
    // 访客：仅统计 req.guestVisibleTypes（requireGuestReadOnly 注入，pathogen 恒定排除）。
    router.get('/api/test-records/stats', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const isGuest = req.user?.role === 'guest'
            const types = isGuest ? (req.guestVisibleTypes || []) : [...RECORD_ROUTE_TYPES]

            const byType = {}
            for (const t of types) byType[t] = { count: 0, passCount: 0, passRate: null, positiveCount: null }
            if (!types.length) {
                return res.json({
                    success: true,
                    data: { total: 0, passCount: 0, passRate: null, byType, visibleTypes: types, generatedAt: new Date().toISOString() }
                })
            }

            const DATE_EXPR = `(CASE WHEN "sample_info"->>'testDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                                     THEN ("sample_info"->>'testDate')::date END)`
            const PASS_EXPR = `(CASE "test_type"
                WHEN 'pathogen' THEN COALESCE("result_data"->>'riskLevel','') = '无风险'
                WHEN 'tableware' THEN ${TABLEWARE_PASS_SQL}
                WHEN 'oil' THEN ${oilVerdictSql()}
                ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%'
                      AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
            END)`

            const theDayRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
            const start = theDayRe.test(String(req.query.start || '')) ? req.query.start : '1970-01-01'
            const end = theDayRe.test(String(req.query.end || '')) ? req.query.end : '2099-12-31'
            const canteenRaw = typeof req.query.canteen === 'string' ? req.query.canteen.trim() : ''
            const canteen = canteenRaw && canteenRaw !== 'all' ? canteenRaw : null

            // P1-14 口径：与前端 getRecordDateTime 一致 —— testDate 无法解析的记录不计入任何统计
            const rows = await req.db.$queryRawUnsafe(
                `SELECT "test_type",
                        COUNT(*)::int AS "total",
                        COUNT(*) FILTER (WHERE ${PASS_EXPR})::int AS "pass",
                        COUNT(*) FILTER (WHERE "test_type" = 'pathogen'
                                           AND COALESCE("result_data"->>'riskLevel','') NOT IN ('', '无风险'))::int AS "positive"
                   FROM "TestRecord"
                  WHERE "test_type" = ANY($1::text[])
                    AND ${DATE_EXPR} IS NOT NULL
                    AND ${DATE_EXPR} >= $2::date
                    AND ${DATE_EXPR} <= $3::date
                    AND ($4::text IS NULL OR "sample_info"->>'canteen' = $4)
                  GROUP BY "test_type"`,
                types, start, end, canteen
            )

            let total = 0, passTotal = 0
            for (const row of rows) {
                const slot = byType[row.test_type]
                if (!slot) continue
                slot.count = row.total
                slot.passCount = row.pass
                slot.passRate = row.total ? Math.round((row.pass / row.total) * 1000) / 10 : null
                if (row.test_type === 'pathogen') slot.positiveCount = row.positive
                total += row.total
                passTotal += row.pass
            }

            // 肉蛋按品种细分（2026-09-24 修复）：看板子卡此前只读本地缓存、且 `鱼、虾` 归不进去。
            // 现由服务端给出 6 个卡片键的 count/passCount/passRate（键恒定，无数据为 0），前端直接渲染。
            let byMeatType = null
            if (types.includes('leanMeat')) {
                const meatRows = await req.db.$queryRawUnsafe(
                    `SELECT COALESCE("result_data"->>'meatType','') AS "meat_type",
                            COUNT(*)::int AS "total",
                            COUNT(*) FILTER (WHERE ${PASS_EXPR})::int AS "pass"
                       FROM "TestRecord"
                      WHERE "test_type" = 'leanMeat'
                        AND ${DATE_EXPR} IS NOT NULL
                        AND ${DATE_EXPR} >= $1::date
                        AND ${DATE_EXPR} <= $2::date
                        AND ($3::text IS NULL OR "sample_info"->>'canteen' = $3)
                      GROUP BY 1`,
                    start, end, canteen
                )
                byMeatType = {}
                for (const k of MEAT_CARD_KEYS) byMeatType[k] = { count: 0, passCount: 0, passRate: null }
                // 方案 A（2026-09-24）：归不上的品种落「其它」兜底卡，不再静默消失
                // ⇒ byMeatType 各卡合计恒等于肉蛋类型总数（前端可据此自查）。
                for (const row of meatRows) {
                    const key = toMeatCardKey(row.meat_type)
                    byMeatType[key].count += row.total
                    byMeatType[key].passCount += row.pass
                }
                for (const k of MEAT_CARD_KEYS) {
                    const slot = byMeatType[k]
                    slot.passRate = slot.count ? Math.round((slot.passCount / slot.count) * 1000) / 10 : null
                }
            }

            res.json({
                success: true,
                data: {
                    total,
                    passCount: passTotal,
                    passRate: total ? Math.round((passTotal / total) * 1000) / 10 : null,
                    byType,
                    // 肉蛋品种细分（仅当 leanMeat 可见时给出；键恒定为 6 个卡片键）
                    byMeatType,
                    visibleTypes: types,
                    range: { start, end, canteen },
                    generatedAt: new Date().toISOString()
                }
            })
        } catch (error) {
            console.error('❌ Error building test-record stats:', error)
            res.status(500).json({ error: '统计获取失败' })
        }
    })

    // ====== 权威导出作业（P3-W5-RECORD-T01 / AUD-020 / RC-07）======
    // 创建/状态/下载/取消：**注册在本文件所有 `/api/records/:tableName` 通配之前**（否则 'exports' 会被当成 tableName）。
    // 三处入口都重新校验当前主体权限与资源归属：
    //   · `authenticateUser, requireEditorOrAbove` 已按**当前**身份与角色重验（权限撤回 → 在此即被拒）；
    //   · 归属 = tenantScope + subject（学校 + 创建者），不匹配一律 404（不泄露他人作业是否存在）。
    const EXPORT_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']

    /** 导出筛选 → Prisma where（与列表/看板同口径；日期/食堂在 sample_info，品种兼容 sample_info|result_data）。 */
    function buildExportWhere({ testTypes, filters }) {
      const where = { test_type: { in: testTypes } }
      const and = []
      const startDate = String((filters && filters.startDate) || '').trim()
      const endDate = String((filters && filters.endDate) || '').trim()
      if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) and.push({ sample_info: { path: ['testDate'], gte: startDate } })
      if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) and.push({ sample_info: { path: ['testDate'], lte: endDate } })
      const canteens = Array.isArray(filters && filters.canteens) ? filters.canteens.filter(Boolean) : []
      if (canteens.length) {
        and.push({ OR: canteens.map((c) => ({ sample_info: { path: ['canteen'], equals: c } })) })
      }
      const meatTypes = Array.isArray(filters && filters.meatTypes) ? filters.meatTypes.filter(Boolean) : []
      if (meatTypes.length) {
        and.push({
          OR: meatTypes.flatMap((m) => ([
            { sample_info: { path: ['meatType'], equals: m } },
            { result_data: { path: ['meatType'], equals: m } },
          ])),
        })
      }
      if (and.length) where.AND = and
      return where
    }

    function ownershipMatches(req, job) {
      return job.tenantScope === tenantScopeOf(req) && job.subject === subjectScopeOf(req)
    }

    // 创建导出作业：返回 202 + jobId（状态/下载分离，避免"HTTP 200 之后才发现少页"）
    router.post('/api/records/exports', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const filters = (req.body && typeof req.body.filters === 'object' && req.body.filters) ? req.body.filters : {}
            const requested = Array.isArray(filters.testTypes) && filters.testTypes.length ? filters.testTypes : EXPORT_TYPES
            const testTypes = requested.filter((t) => EXPORT_TYPES.includes(t))
            if (!testTypes.length) {
                return res.status(400).json({ error: 'filters.testTypes 非法（合法值：tableware/pesticide/oil/leanMeat/pathogen）', code: 'INVALID_EXPORT_FILTERS' })
            }
            const job = createExportJob({
                tenantScope: tenantScopeOf(req),
                subject: subjectScopeOf(req),
                role: req.user?.role,
                filters: { ...filters, testTypes },
            })
            const where = buildExportWhere({ testTypes, filters })
            // 异步执行：HTTP 立刻返回 jobId；完整性由 expectedCount/exportedCount 与 ID 校验在作业内保证
            runExportJob({ db: req.db, jobId: job.jobId, testTypes, where })
                .catch((e) => console.error('[export] job crashed', job.jobId, e && e.message))
            cleanupExpiredJobs().catch(() => { /* 清理失败不影响作业 */ })
            res.status(202).json({
                success: true,
                jobId: job.jobId,
                state: job.state,
                statusUrl: `/api/records/exports/${job.jobId}`,
                downloadUrl: `/api/records/exports/${job.jobId}/download`,
                manifest: publicExportJobView(job),
            })
        } catch (error) {
            console.error('❌ Error creating export job:', error)
            res.status(500).json({ error: '导出作业创建失败', code: 'EXPORT_CREATE_FAILED' })
        }
    })

    // 查询状态（重新校验权限与归属）
    router.get('/api/records/exports/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
        try {
            const job = getExportJob(req.params.id)
            if (!job || !ownershipMatches(req, job)) {
                return res.status(404).json({ error: '导出作业不存在', code: 'EXPORT_JOB_NOT_FOUND' })
            }
            res.json({ success: true, job: publicExportJobView(job), downloadable: isDownloadable(job) })
        } catch (error) {
            console.error('❌ Error reading export job:', error)
            res.status(500).json({ error: '导出作业查询失败', code: 'EXPORT_STATUS_FAILED' })
        }
    })

    // 下载：仅服务**已完成**产物；未完成/失败 → 明确 409（绝不流式发送残缺内容）
    router.get('/api/records/exports/:id/download', authenticateUser, requireEditorOrAbove, async (req, res) => {
        try {
            const job = getExportJob(req.params.id)
            if (!job || !ownershipMatches(req, job)) {
                return res.status(404).json({ error: '导出作业不存在', code: 'EXPORT_JOB_NOT_FOUND' })
            }
            if (!isDownloadable(job)) {
                return res.status(409).json({
                    error: `导出作业当前不可下载（state=${job.state}）`,
                    code: 'EXPORT_NOT_READY',
                    state: job.state,
                    job: publicExportJobView(job),
                })
            }
            const artifact = exportJobArtifactPath(job.jobId)
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="${job.jobId}.ndjson"`)
            res.setHeader('X-Export-Job-Id', job.jobId)
            res.setHeader('X-Export-Expected-Count', String(job.expectedCount))
            res.setHeader('X-Export-Exported-Count', String(job.exportedCount))
            res.setHeader('X-Export-Checksum-Sha256', String(job.checksum || ''))
            res.setHeader('X-Export-Verify', job.expectedCount === job.exportedCount && job.idDupCount === 0 ? 'complete' : 'incomplete')
            fs.createReadStream(artifact).pipe(res)
        } catch (error) {
            console.error('❌ Error downloading export artifact:', error)
            res.status(500).json({ error: '导出产物下载失败', code: 'EXPORT_DOWNLOAD_FAILED' })
        }
    })

    // 取消（批间协作取消；不发布任何产物）
    router.post('/api/records/exports/:id/cancel', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const job = getExportJob(req.params.id)
            if (!job || !ownershipMatches(req, job)) {
                return res.status(404).json({ error: '导出作业不存在', code: 'EXPORT_JOB_NOT_FOUND' })
            }
            if (job.state === EXPORT_JOB_STATES.COMPLETED) {
                return res.status(409).json({ error: '导出已完成，无法取消', code: 'EXPORT_ALREADY_COMPLETED', state: job.state })
            }
            requestCancel(job.jobId)
            res.json({ success: true, jobId: job.jobId, state: job.state, cancelRequested: true })
        } catch (error) {
            console.error('❌ Error cancelling export job:', error)
            res.status(500).json({ error: '导出取消失败', code: 'EXPORT_CANCEL_FAILED' })
        }
    })

    // ====== Legacy Frontend Compatibility: /api/records/:tableName ======

    // 越权修复：guest 只能读取该校 visible_types 白名单模块（强制排除 pathogen），见 requireGuestReadOnly
    router.get('/api/records/:tableName', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
            }

            const { status } = req.query
            // P3-W5-RECORD-T01（AUD-020 / RC-07）：与 /api/test-records 同一分页契约
            // （cursor 优先 / offset 兼容 / 超限显式拒绝），消费方可统一按 pageMeta 判断覆盖范围。
            const page = parsePageQuery(req.query)
            if (!page.ok) {
                return res.status(page.status).json({ error: page.error, code: page.code, ...(page.extra || {}) })
            }
            const where = { test_type: testType }
            if (status) where.status = status
            const effectiveWhere = mergeWhere(where, page.cursor ? cursorWhere(page.cursor) : null)

            const records = await req.db.testRecord.findMany({
                where: effectiveWhere,
                ...(page.cursor ? {} : { skip: page.offset }),
                take: page.limit,
                // 稳定顺序（keyset 游标前提）
                orderBy: [{ created_at: 'desc' }, { id: 'desc' }]
            })

            const total = await req.db.testRecord.count({ where })

            // DS3-M6: guest 读取记录列表时对 PII 字段脱敏（检测结果类字段保持可见）
            const payloads = records.map(buildRecordPayload)
            res.json({
                success: true,
                data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
                ...pageMeta({
                    rows: records,
                    total,
                    limit: page.limit,
                    offset: page.offset,
                    cursorUsed: !!page.cursor,
                    filters: { test_type: testType, status: status || null },
                }),
            })
        } catch (error) {
            console.error('❌ Error fetching legacy records:', error)
            res.status(500).json({ error: '获取失败' })
        }
    })

    router.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
            }

            console.log(`[POST /api/records/${req.params.tableName}] userId=${req.userId} (请求体不写入日志)`)

            const payload = req.body || {}

            // P2-07: 写入前进行字段 Schema 验证
            const validation = validateRecordPayload(testType, payload)
            if (!validation.valid) {
                return res.status(400).json({ error: '❌ 字段验证失败', details: validation.errors })
            }

            // 2026-09-16：统一归一（返回 {ok,data}）+ 状态白名单（archived 属管理动作，editor 不可写）
            const built = buildRecordWriteData(testType, payload)
            if (!built.ok) return res.status(400).json({ error: `❌ ${built.message}`, code: built.code })
            const statusCheck = resolveWritableStatus({ requested: payload.status, role: req.user?.role, currentStatus: null })
            if (!statusCheck.ok) return res.status(400).json({ error: `❌ ${statusCheck.message}`, code: 'STATUS_NOT_ALLOWED' })
            const writeData = { ...built.data, ...(statusCheck.status ? { status: statusCheck.status } : {}) }
            const recordCode = buildDeterministicRecordCode(testType, payload)

            const existing = await req.db.testRecord.findUnique({
                where: { record_code: recordCode }
            })

            if (existing) {
                return res.json({
                    success: true,
                    deduplicated: true,
                    data: buildRecordPayload(existing),
                    message: '记录已存在，已按幂等策略返回现有数据'
                })
            }

            const record = await req.db.testRecord.create({
                data: {
                    record_code: recordCode,
                    created_by: req.userId,
                    version: 1,
                    ...writeData
                }
            })

            // P2-02: 记录创建操作写入审计日志
            await writeRecordAuditLog(req.db, req.userId, 'create', 'test_record', record.id, {
                test_type: testType,
                record_code: recordCode
            }, req.ip)

            res.json({
                success: true,
                data: buildRecordPayload(record),
                message: '记录创建成功'
            })
        } catch (error) {
            // P2002: 唯一约束冲突（并发重复写入）：按幂等策略返回已有记录
            if (error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'))) {
                try {
                    const existing = await req.db.testRecord.findUnique({ where: { record_code: buildDeterministicRecordCode(normalizeRecordType(req.params.tableName), req.body || {}) } })
                    if (existing) {
                        return res.json({ success: true, deduplicated: true, data: buildRecordPayload(existing), message: '记录已存在（并发写入），已按幂等策略返回现有数据' })
                    }
                } catch (_) { /* fallthrough */ }
            }
            // P2003: 外键约束失败（如 created_by 对应的用户不存在）：返回 422 而非 500
            if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
                console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
                return res.status(422).json({
                    error: '关联用户不存在，请重新登录',
                    code: 'INVALID_USER'
                })
            }
            console.error('❌ Error creating legacy record:', error)
            res.status(500).json({ error: '创建失败', code: error.code || undefined })
        }
    })

    router.post('/api/records/:tableName/bulk-upsert', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(404).json({ error: '记录类型不存在' })
            }

            const records = Array.isArray(req.body?.records) ? req.body.records : []
            if (records.length === 0) {
                return res.status(400).json({ error: 'records 不能为空' })
            }
            if (records.length > 2000) {
                return res.status(400).json({ error: '单次导入记录数不能超过 2000 条' })
            }

            const uniqueByCode = new Map()
            records.forEach(item => {
                const code = buildDeterministicRecordCode(testType, item || {})
                if (!uniqueByCode.has(code)) {
                    uniqueByCode.set(code, item || {})
                }
            })

            let created = 0
            let updated = 0
            const failed = []

            for (const [recordCode, payload] of uniqueByCode.entries()) {
                try {
                    const existing = await req.db.testRecord.findUnique({
                        where: { record_code: recordCode }
                    })

                    // 2026-09-16：统一归一 + 状态白名单；逐条失败进 failed[]，不中断整批
                    const built = buildRecordWriteData(testType, payload)
                    if (!built.ok) {
                        failed.push({ record_code: recordCode, reason: built.message, code: built.code, skipped: true })
                        continue
                    }
                    const statusCheck = resolveWritableStatus({ requested: payload?.status, role: req.user?.role, currentStatus: existing?.status })
                    if (!statusCheck.ok) {
                        failed.push({ record_code: recordCode, reason: statusCheck.message, code: 'STATUS_NOT_ALLOWED', skipped: true })
                        continue
                    }
                    const writeData = { ...built.data, ...(statusCheck.status ? { status: statusCheck.status } : {}) }

                    if (existing) {
                        // DS3-C1（方案甲）: 批量导入命中已有记录时同样执行归属校验
                        if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                            failed.push({
                                record_code: recordCode,
                                reason: '无权覆盖他人创建的记录（仅创建者本人或主管可修改）',
                                skipped: true
                            })
                            continue
                        }
                        // NB-25: bulk-upsert 命中已有记录时默认"最后写入胜出"（导入/恢复为完整记录，replace 口径）；
                        // 客户端可传 expected_updated_at 升级为**原子 CAS**（P1-3：原实现是"先读后比再写"的 TOCTOU）。
                        // 2026-09-17 P0-1：仅提交控制/上下文字段时不再写回 `{}` 清空结果（result_data 保持原值）。
                        const builtUpdate = buildRecordWriteData(testType, payload, {
                            existingSampleInfo: safeParseJson(existing.sample_info, {}) || {},
                            existingResultData: safeParseJson(existing.result_data, {}) || {},
                            resultDataMode: 'replace',
                        })
                        if (!builtUpdate.ok) {
                            failed.push({ record_code: recordCode, reason: builtUpdate.message, code: builtUpdate.code, skipped: true })
                            continue
                        }
                        const updateData = { ...builtUpdate.data, version: { increment: 1 } }
                        if (!builtUpdate.resultDataProvided) delete updateData.result_data
                        const expectedUpdatedAt = payload?.expected_updated_at ? String(payload.expected_updated_at).trim() : ''
                        try {
                            await req.db.testRecord.update({
                                where: expectedUpdatedAt
                                    ? { id: existing.id, updated_at: new Date(expectedUpdatedAt) }
                                    : { id: existing.id },
                                data: updateData,
                            })
                        } catch (e) {
                            if (e?.code === 'P2025') {
                                failed.push({
                                    record_code: recordCode,
                                    reason: '乐观锁冲突：该记录已被其他人修改',
                                    skipped: true
                                })
                                continue
                            }
                            throw e
                        }
                        updated++
                    } else {
                        await req.db.testRecord.create({
                            data: {
                                record_code: recordCode,
                                created_by: req.userId,
                                version: 1,
                                ...writeData
                            }
                        })
                        created++
                    }
                } catch (error) {
                    if (error.code !== 'P2002') {
                        failed.push({
                            record_code: recordCode,
                            reason: '写入失败',
                            code: error.code || undefined
                        })
                    }
                }
            }

            // P2-02: 批量导入操作写入审计日志
            if (created > 0 || updated > 0) {
                await writeRecordAuditLog(req.db, req.userId, 'import', 'test_record', null, {
                    test_type: testType,
                    total: records.length,
                    unique: uniqueByCode.size,
                    created,
                    updated,
                    failed: failed.length
                }, req.ip)
            }

            return res.json({
                success: true,
                message: '批量导入完成',
                data: {
                    received: records.length,
                    unique: uniqueByCode.size,
                    created,
                    updated,
                    failed: failed.length,
                    failedRecords: failed
                }
            })
        } catch (error) {
            console.error('❌ Error bulk upsert legacy records:', error)
            res.status(500).json({
                error: '批量导入失败'
            })
        }
    })

    router.put('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(404).json({ error: '记录类型不存在' })
            }

            const existing = await req.db.testRecord.findUnique({
                where: { id: req.params.id }
            })

            if (!existing || existing.test_type !== testType) {
                return res.status(404).json({ error: '记录不存在' })
            }

            // DS3-C1（方案甲）: operator 仅能修改自己创建的记录（created_by 匹配）
            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可修改该记录' })
            }

            // ===== P3-W4-T01（AUD-022）：stale 重放识别 + 基线声明（helper 见文件末尾，不改中间件顺序）=====
            // 顺序说明：鉴权/归属校验之后、任何字段归一与写库之前 —— 只读比对，不产生写副作用。
            const baselineGuard = evaluateWriteBaseline({ body: req.body, existing, recordId: req.params.id })
            if (baselineGuard.reject) {
                if (baselineGuard.status === 409) setW4ConflictFence(req.params.id)
                return res.status(baselineGuard.status).json(baselineGuard.payload)
            }

            // P2-07: 更新前进行字段 Schema 验证
            const updateValidation = validateRecordPayload(testType, req.body || {})
            if (!updateValidation.valid) {
                return res.status(400).json({ error: '❌ 字段验证失败', details: updateValidation.errors })
            }

            // 2026-09-16：统一归一 + 状态白名单（archived 属管理动作）
            // 2026-09-17 P0-1：本端点契约 = **整对象替换**（validateRecordPayload 已要求三键齐全、客户端送完整记录），
            //   故 result_data 默认 replace；显式 `result_data_mode: 'merge'` 时改为键级合并。
            //   两种语义下，result_data 内仅含上下文/控制字段时都返回 undefined（不改动），不再写回 `{}` 清空结果。
            const built = buildRecordWriteData(testType, req.body || {}, {
                existingSampleInfo: safeParseJson(existing.sample_info, {}) || {},
                existingResultData: safeParseJson(existing.result_data, {}) || {},
                resultDataMode: req.body?.result_data_mode === 'merge' ? 'merge' : 'replace',
            })
            if (!built.ok) return res.status(400).json({ error: `❌ ${built.message}`, code: built.code })
            const statusCheck = resolveWritableStatus({ requested: req.body?.status, role: req.user?.role, currentStatus: existing.status })
            if (!statusCheck.ok) return res.status(400).json({ error: `❌ ${statusCheck.message}`, code: 'STATUS_NOT_ALLOWED' })
            const writeData = { ...built.data, ...(statusCheck.status ? { status: statusCheck.status } : {}) }

            // ⚠️ 以下两个「字段保护/自愈」块只在本次**确实提交了 result_data** 时执行：
            //   否则 safeParseJson(undefined) → `{}` 会把 undefined 变成 `{}` 写回，等于清空结果（P0-1 的一部分）。
            const PROTECTED_FIELDS_COMMON = ['remarks', 'remark', 'result_unit', 'unit']
            const PROTECTED_FIELDS_BY_TYPE = {
                pesticide: [...PROTECTED_FIELDS_COMMON, 'vegetableType', 'batchNo', 'sampleNo', 'limitValue', 'detectionLimit', 'sampleSource'],
                leanMeat: [...PROTECTED_FIELDS_COMMON, 'vegetableType', 'batchNo', 'sampleNo', 'limitValue', 'detectionLimit', 'sampleSource'],
                oil: [...PROTECTED_FIELDS_COMMON, 'oilType', 'sampleNo', 'limitValue', 'sampleSource'],
                tableware: [...PROTECTED_FIELDS_COMMON, 'atpPoints', 'sampleInfo', 'recheckRecords'],
                pathogen: [...PROTECTED_FIELDS_COMMON, 'sampleId', 'sampleType', 'positiveItems', 'positiveDetails', 'riskLevel', 'riskReason', 'allTestItems']
            }
            const PROTECTED_FIELDS = PROTECTED_FIELDS_BY_TYPE[testType] || PROTECTED_FIELDS_BY_TYPE.pesticide
            if (built.resultDataProvided) {
                // TD-Q1-Recheck-SelfHeal: 兜底自愈——以「最新一次复检结论」为准双向同步 result
                try {
                    const incoming = safeParseJson(writeData.result_data, {}) || {}
                    const passed = getLatestRecheckPassed(incoming)
                    if (passed === true && incoming.result !== '合格') {
                        incoming.result = '合格'
                        writeData.result_data = incoming
                    } else if (passed === false && incoming.result !== '不合格') {
                        incoming.result = '不合格'
                        writeData.result_data = incoming
                    }
                } catch (_) { /* 自愈失败不影响主流程 */ }

                // TD-Q1-Recheck-FieldGuard: 复检/编辑时保护原始业务字段。
                try {
                    const incoming = safeParseJson(writeData.result_data, {}) || {}
                    const existingData = safeParseJson(existing?.result_data, {}) || {}
                    for (const k of PROTECTED_FIELDS) {
                        if ((incoming[k] === undefined || incoming[k] === null || incoming[k] === '') &&
                            existingData[k] !== undefined && existingData[k] !== null && existingData[k] !== '') {
                            incoming[k] = existingData[k]
                        }
                    }
                    writeData.result_data = incoming
                } catch (_) { /* 字段保护失败不影响主流程 */ }
            } else {
                delete writeData.result_data   // 交给 Prisma 忽略（undefined），避免写成 {}
            }

            // 版本号乐观锁（如果客户端传了 version 字段）
            // P3-W4-T01（AUD-022）：409 保持既有字段 + 扩展冲突信息（latest/基线/原因），并置冲突栅栏。
            if (req.body && typeof req.body.version !== 'undefined' && req.body.version !== existing.version) {
                setW4ConflictFence(req.params.id)
                return res.status(409).json(buildW4ConflictPayload({
                    existing,
                    testType,
                    declared: readDeclaredBase(req.body),
                    reason: 'version_mismatch',
                    staleReplay: true,
                    clientVersion: req.body.version,
                }))
            }

            // TD-OptimisticLock-Atomic: where 带上 version 做原子条件更新
            let record
            try {
                record = await req.db.testRecord.update({
                    where: { id: req.params.id, version: existing.version },
                    data: {
                        ...writeData,
                        version: (existing.version || 0) + 1
                    }
                })
            } catch (e) {
                if (e?.code === 'P2025') {
                    // P3-W4-T01（AUD-022）：原子 CAS 失败 = 明确的 stale 重放；回读最新行一并下发冲突信息
                    // （回读失败时退回本次读到的 existing，不掩盖冲突语义）。
                    setW4ConflictFence(req.params.id)
                    let fresh = null
                    try { fresh = await req.db.testRecord.findUnique({ where: { id: req.params.id } }) } catch (_) { /* 回读失败不阻断 409 */ }
                    return res.status(409).json(buildW4ConflictPayload({
                        existing: fresh || existing,
                        testType,
                        declared: readDeclaredBase(req.body),
                        reason: 'atomic_cas_lost',
                        staleReplay: true,
                        clientVersion: req.body?.version,
                    }))
                }
                throw e
            }

            // P3-W4-T01（AUD-022）：写成功后清除冲突栅栏（该记录已进入新的服务端基线）
            clearW4ConflictFence(req.params.id)

            // P2-02: 记录更新操作写入审计日志
            await writeRecordAuditLog(req.db, req.userId, 'update', 'test_record', record.id, {
                test_type: testType,
                version: (existing.version || 0) + 1
            }, req.ip)

            res.json({
                success: true,
                data: buildRecordPayload(record),
                message: '更新成功'
            })
        } catch (error) {
            console.error('❌ Error updating legacy record:', error)
            res.status(500).json({
                error: '更新失败'
            })
        }
    })

    router.delete('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(404).json({ error: '记录类型不存在' })
            }

            const existing = await req.db.testRecord.findUnique({
                where: { id: req.params.id }
            })

            if (!existing || existing.test_type !== testType) {
                return res.status(404).json({ error: '记录不存在' })
            }

            // DS3-C1（方案甲）: operator 仅能删除自己创建的记录
            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可删除该记录' })
            }

            await req.db.testRecord.delete({
                where: { id: req.params.id }
            })

            // P3-W4-T01（AUD-022）：记录已删除，冲突栅栏随之失效（防止陈旧栅栏误伤后续同 id 语义）
            clearW4ConflictFence(req.params.id)

            // P2-02: 记录删除操作写入审计日志
            await writeRecordAuditLog(req.db, req.userId, 'delete', 'test_record', req.params.id, {
                test_type: testType,
                record_code: existing.record_code
            }, req.ip)

            res.json({
                success: true,
                message: '删除成功'
            })
        } catch (error) {
            console.error('❌ Error deleting legacy record:', error)
            res.status(500).json({
                error: '删除失败'
            })
        }
    })

    // 越权修复：详情端点与列表同口径，guest 仅可读白名单模块（排除 pathogen）
    router.get('/api/records/:tableName/:id', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(404).json({ error: '记录类型不存在' })
            }

            const existing = await req.db.testRecord.findUnique({
                where: { id: req.params.id }
            })

            if (!existing || existing.test_type !== testType) {
                return res.status(404).json({ error: '记录不存在' })
            }

            // DS3-M6: guest 读取详情时对 PII 字段脱敏
            const payload = buildRecordPayload(existing)
            res.json({
                success: true,
                data: req.user?.role === 'guest' ? maskGuestSensitiveFields(payload) : payload
            })
        } catch (error) {
            console.error('❌ Error getting legacy record by id:', error)
            res.status(500).json({
                error: '获取记录失败'
            })
        }
    })

    // 获取单个测试记录
    // 越权修复：无 :tableName 参数，取回后按 req.guestVisibleTypes 校验 test_type
    router.get('/api/test-records/:id', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const { id } = req.params

            const record = await req.db.testRecord.findUnique({
                where: { id },
                include: {
                    test_items: true,
                    attachments: true,
                    created_user: {
                        select: {
                            id: true,
                            username: true,
                            full_name: true
                        }
                    }
                }
            })

            if (!record) {
                return res.status(404).json({ error: '记录不存在' })
            }

            if (req.user?.role === 'guest' && !(req.guestVisibleTypes || []).includes(record.test_type)) {
                return res.status(403).json({ error: '❌ 访客无权访问该检测模块' })
            }

            // DS3-M6: guest 读取详情时脱敏
            if (req.user?.role === 'guest') {
                const masked = maskGuestSensitiveFields({
                    ...record,
                    sample_info: sanitizeObjectKeys(safeParseJson(record.sample_info, {})),
                    result_data: sanitizeObjectKeys(safeParseJson(record.result_data, {}))
                })
                return res.json({ success: true, data: masked })
            }

            res.json({
                success: true,
                data: record
            })
        } catch (error) {
            console.error('❌ Error fetching test record:', error)
            res.status(500).json({
                error: '获取失败'
            })
        }
    })

    // 更新测试记录
    // NB-13: result_data 需经过 sanitizeObjectKeys 净化；status 白名单校验
    router.put('/api/test-records/:id', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const { id } = req.params
            const { test_name, status, result_data } = req.body

            // DS3-C1（方案甲）: 与 /api/records/:tableName/:id 同口径的归属校验
            const existing = await req.db.testRecord.findUnique({ where: { id } })
            if (!existing) {
                return res.status(404).json({ error: '记录不存在' })
            }
            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可修改该记录' })
            }

            const updateData = {}
            if (test_name) updateData.test_name = test_name

            // 2026-09-16 审阅 M5：状态白名单（archived 属管理动作；editor 不可把记录推入归档态）
            if (status && !VALID_TEST_RECORD_STATUSES.has(String(status))) {
                return res.status(400).json({
                    error: `状态值无效（仅允许: ${[...VALID_TEST_RECORD_STATUSES].join('/')}）`,
                    code: 'INVALID_STATUS',
                })
            }
            const statusCheck = resolveWritableStatus({ requested: status, role: req.user?.role, currentStatus: existing.status })
            if (!statusCheck.ok) {
                return res.status(400).json({ error: `❌ ${statusCheck.message}`, code: 'STATUS_NOT_ALLOWED' })
            }
            if (statusCheck.status) updateData.status = statusCheck.status

            // 2026-09-16 审阅 H3：本路由原先只 sanitize 后**原样写入** result_data —— 副本可由此回流，
            // 且不写 sample_info，导致同一记录在"前端/导出"与"开放接口/统计"下读数不同（口径分叉）。
            // 现改走统一归一：上下文三键以 sample_info 为权威合并写回，result_data 剔控制字段与副本；
            // 显式空对象 `{}` = 不改动（不再清空已有结果）。
            const norm = normalizeWriteJson({
                payload: sanitizeObjectKeys(req.body || {}),
                resultData: result_data,
                sampleInfo: req.body?.sample_info,
                existingSampleInfo: safeParseJson(existing.sample_info, {}) || {},
                // 2026-09-17 P0-1：本端点是**局部编辑**入口 → 默认 merge（未提交的业务键保留旧值），
                // 要整对象替换需显式 `result_data_mode: 'replace'`；只提交上下文键时不再写回 {}。
                existingResultData: safeParseJson(existing.result_data, {}) || {},
                resultDataMode: req.body?.result_data_mode === 'replace' ? 'replace' : 'merge',
                mode: 'update',
                testType: existing?.test_type || req.body?.test_type || null,
            })
            if (!norm.ok) {
                return res.status(400).json({ error: `❌ ${norm.message}`, code: norm.code })
            }
            if (norm.resultData !== undefined) updateData.result_data = norm.resultData
            if (norm.provided.length) updateData.sample_info = norm.sampleInfo

            // 并发保护（审阅 H3）：客户端提供 version 时走原子条件更新；未提供时保留旧行为，
            // 但在响应中回传服务端 version，并在日志中提示（本端点无仓库内调用方 —— 全仓 grep 仅集成测试用 DELETE）。
            const clientVersion = req.body?.version
            // 2026-09-17 P1-3：本端点此前**不推进 version**，导致"改过了但版本号不变"——其它入口的乐观锁
            // 与客户端缓存判断全部失真。统一改为原子 `version: { increment: 1 }`（CAS 用客户端版本做条件）。
            const versionedData = { ...updateData, version: { increment: 1 } }
            let record
            if (clientVersion !== undefined && clientVersion !== null && clientVersion !== '') {
                record = await req.db.testRecord.update({
                    where: { id, version: Number(clientVersion) },
                    data: versionedData,
                })
            } else {
                console.warn(`[PUT /api/test-records/:id] 未携带 version（按最后写入胜出，仍原子递增 version）：id=${id} userId=${req.userId}`)
                record = await req.db.testRecord.update({ where: { id }, data: versionedData })
            }

            res.json({
                success: true,
                data: record,
                version: record.version,
                message: '更新成功'
            })
        } catch (error) {
            // P2025：乐观锁条件不满足（version 不匹配）或记录被删除 → 明确的冲突语义
            if (error.code === 'P2025') {
                return res.status(409).json({
                    error: '❌ 版本冲突：记录已被其他人修改或删除，请重新获取后重试',
                    code: 'VERSION_CONFLICT',
                })
            }
            console.error('❌ Error updating test record:', error)
            res.status(500).json({ error: '更新失败' })
        }
    })

    // 删除测试记录
    router.delete('/api/test-records/:id', authenticateUser, requireEditorOrAbove, idempotencyMiddleware, async (req, res) => {
        try {
            const { id } = req.params

            // DS3-C1（方案甲）: 归属校验（先查记录，顺带把原 P2025→500 修正为 404）
            const existing = await req.db.testRecord.findUnique({ where: { id } })
            if (!existing) {
                return res.status(404).json({ error: '记录不存在' })
            }
            if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可删除该记录' })
            }

            await req.db.testRecord.delete({
                where: { id }
            })

            // DS3-C1 交付要求: 删除操作必须产生审计记录
            await writeRecordAuditLog(req.db, req.userId, 'delete', 'test_record', id, {
                test_type: existing.test_type,
                record_code: existing.record_code
            }, req.ip)

            res.json({
                success: true,
                message: '删除成功'
            })
        } catch (error) {
            console.error('❌ Error deleting test record:', error)
            res.status(500).json({
                error: '删除失败'
            })
        }
    })

    return router
}

// ===================== P3-W4-T01（AUD-022）冲突协议 helper（模块级，append-only）=====================
// 边界声明（不改 schema / 不改认证与授权语义 / 不改 :20-21 的中间件顺序，仅 PUT /api/records/:tableName/:id 使用）：
//   ① 基线声明：PUT 可携带 base_version / base_updated_at（显式基线；version 仍按既有 CAS 语义兼容）。
//      显式基线与当前服务端状态不一致 → 409 + 冲突信息（latest / 原因 / staleReplay），绝不"最后写入胜出"。
//   ② stale 重放识别：本进程对该记录下发过 409 后留下短 TTL「冲突栅栏」；栅栏存续期内，任何**未携带**
//      与当前状态一致的显式基线写入（典型形态：只把 version 换成最新值、payload 仍是旧的整量重放）
//      一律 409（staleReplay=true）—— 即"识别并拒绝"，而不是让它静默覆盖他人内容。
//   ③ 向后兼容：error / serverVersion / clientVersion 三个既有字段保持不变；新增字段旧客户端忽略即可，
//      忽略的结果是重放持续 409（明确失败），不会误判为可重试成功。
//   ④ 残余边界（写入 RESULT）：栅栏为进程内状态（与既有幂等 store 同为进程内实现 NF-A-02），跨实例部署的
//      重放防护依赖 ①（显式基线不匹配即拒绝）与客户端状态机（禁止自动全量重放）。
const W4_CONFLICT_FENCE_TTL_MS = 10 * 60 * 1000
const W4_CONFLICT_FENCE_MAX = 4096
const w4ConflictFences = new Map()   // String(recordId) → { at: epochMs }

function w4ToEpochMs(value) {
    if (value === undefined || value === null || value === '') return null
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
    const t = Date.parse(String(value))
    return Number.isFinite(t) ? t : null
}

function readDeclaredBase(body) {
    const b = body || {}
    const hasBaseVersion = b.base_version !== undefined && b.base_version !== null && b.base_version !== ''
    const hasVersion = b.version !== undefined && b.version !== null && b.version !== ''
    const rawUpdatedAt = b.base_updated_at !== undefined ? b.base_updated_at : b.expected_updated_at
    const hasBaseUpdatedAt = rawUpdatedAt !== undefined && rawUpdatedAt !== null && rawUpdatedAt !== ''
    const baseVersionNum = hasBaseVersion ? Number(b.base_version) : null
    return {
        hasExplicitBase: hasBaseVersion || hasBaseUpdatedAt,
        explicitBaseVersion: hasBaseVersion ? baseVersionNum : null,
        explicitBaseUpdatedAt: hasBaseUpdatedAt ? rawUpdatedAt : null,
        explicitBaseUpdatedAtMs: hasBaseUpdatedAt ? w4ToEpochMs(rawUpdatedAt) : null,
        invalidExplicitBase: (hasBaseVersion && !Number.isFinite(baseVersionNum))
            || (hasBaseUpdatedAt && w4ToEpochMs(rawUpdatedAt) === null)
            || (hasBaseVersion && !Number.isInteger(baseVersionNum)),
        legacyVersion: hasVersion ? b.version : undefined,
    }
}

function setW4ConflictFence(recordId) {
    if (recordId === undefined || recordId === null) return
    const key = String(recordId)
    const now = Date.now()
    if (w4ConflictFences.size >= W4_CONFLICT_FENCE_MAX) {
        for (const [k, f] of w4ConflictFences) {
            if (now - f.at > W4_CONFLICT_FENCE_TTL_MS) w4ConflictFences.delete(k)
        }
        while (w4ConflictFences.size >= W4_CONFLICT_FENCE_MAX) {
            const oldest = w4ConflictFences.keys().next().value
            w4ConflictFences.delete(oldest)
        }
    }
    w4ConflictFences.set(key, { at: now })
}

function getW4ConflictFence(recordId) {
    if (recordId === undefined || recordId === null) return null
    const key = String(recordId)
    const fence = w4ConflictFences.get(key)
    if (!fence) return null
    if (Date.now() - fence.at > W4_CONFLICT_FENCE_TTL_MS) {
        w4ConflictFences.delete(key)
        return null
    }
    return fence
}

function clearW4ConflictFence(recordId) {
    if (recordId === undefined || recordId === null) return
    w4ConflictFences.delete(String(recordId))
}

function buildW4ConflictPayload({ existing, testType, declared, reason, staleReplay, clientVersion }) {
    const serverVersion = existing && existing.version !== undefined ? existing.version : null
    const serverUpdatedAt = existing && existing.updated_at !== undefined ? existing.updated_at : null
    return {
        error: '版本冲突，请基于最新数据合并后重试',
        code: 'VERSION_CONFLICT',
        // —— 既有字段（向后兼容，语义不变）——
        serverVersion,
        clientVersion: clientVersion === undefined ? null : clientVersion,
        // —— 新增字段（旧客户端忽略 = 明确失败，不会误成功）——
        staleReplay: !!staleReplay,
        conflict: {
            reason,
            recordId: existing ? existing.id : null,
            testType: testType || (existing ? existing.test_type : null) || null,
            server: { version: serverVersion, updatedAt: serverUpdatedAt },
            base: {
                version: declared && declared.legacyVersion !== undefined
                    ? declared.legacyVersion
                    : (declared ? declared.explicitBaseVersion : null),
                explicitBaseVersion: declared ? declared.explicitBaseVersion : null,
                updatedAt: declared ? declared.explicitBaseUpdatedAt : null,
            },
            retryable: false,
            guidance: '禁止把 serverVersion 盖回旧 payload 直接重放：请以 latest 为服务端基线做字段级三路合并（base=本地已同步快照 / server=latest / local=本地改动），或先携带 base_version+base_updated_at 声明已重基再提交。',
        },
        // latest 即字段级基线（与 GET 单条同形状的扁平对象：业务字段 + id/version/updated_at）
        latest: existing ? buildRecordPayload(existing) : null,
    }
}

function evaluateWriteBaseline({ body, existing, recordId }) {
    const declared = readDeclaredBase(body)
    const serverVersion = Number(existing && existing.version !== undefined && existing.version !== null ? existing.version : 0)
    const serverUpdatedAtMs = w4ToEpochMs(existing ? existing.updated_at : null)

    if (declared.invalidExplicitBase) {
        return {
            reject: true,
            status: 400,
            payload: {
                error: '❌ 基线字段非法（base_version 必须为整数、base_updated_at 必须为可解析时间）',
                code: 'INVALID_BASE_DECLARATION',
            },
        }
    }
    // ① 显式基线声明与当前服务端状态不一致 → stale（无论栅栏是否存在）
    if (declared.explicitBaseUpdatedAtMs !== null && serverUpdatedAtMs !== null && declared.explicitBaseUpdatedAtMs !== serverUpdatedAtMs) {
        return { reject: true, status: 409, payload: buildW4ConflictPayload({ existing, declared, reason: 'stale_base_updated_at', staleReplay: true, clientVersion: declared.legacyVersion }) }
    }
    if (declared.explicitBaseVersion !== null && Number.isFinite(declared.explicitBaseVersion) && declared.explicitBaseVersion !== serverVersion) {
        return { reject: true, status: 409, payload: buildW4ConflictPayload({ existing, declared, reason: 'stale_base_version', staleReplay: true, clientVersion: declared.legacyVersion }) }
    }
    // ② 既有 CAS 语义（兼容旧客户端）：version 与当前不一致 → 冲突
    if (declared.legacyVersion !== undefined && Number.isFinite(Number(declared.legacyVersion)) && Number(declared.legacyVersion) !== serverVersion) {
        return { reject: true, status: 409, payload: buildW4ConflictPayload({ existing, declared, reason: 'version_mismatch', staleReplay: true, clientVersion: declared.legacyVersion }) }
    }
    // ③ 冲突栅栏：刚下发过 409 → 必须携带"显式且与当前一致"的重基声明（只换 version 的重放被拒绝）
    if (getW4ConflictFence(recordId)) {
        const hasCurrentRebase = (declared.explicitBaseVersion !== null && Number(declared.explicitBaseVersion) === serverVersion)
            || (declared.explicitBaseUpdatedAtMs !== null && serverUpdatedAtMs !== null && declared.explicitBaseUpdatedAtMs === serverUpdatedAtMs)
        if (!hasCurrentRebase) {
            return { reject: true, status: 409, payload: buildW4ConflictPayload({ existing, declared, reason: 'stale_replay_after_conflict', staleReplay: true, clientVersion: declared.legacyVersion }) }
        }
    }
    return { reject: false, declared }
}
