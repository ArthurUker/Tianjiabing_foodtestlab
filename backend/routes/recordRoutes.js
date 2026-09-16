// ====== 检测记录路由（/api/test-records + /api/records，P1-5 拆路由 Step 2）======
// 从 server.js 抽取。req.db 由 authenticateUser 注入；幂等中间件经参数传入。
import express from 'express'
import { normalizeRecordType, buildRecordPayload, buildRecordWriteData, normalizeWriteJson, resolveWritableStatus, validateRecordPayload, writeRecordAuditLog, getLatestRecheckPassed, buildDeterministicRecordCode, RECORD_ROUTE_TYPES } from '../lib/recordNormalize.js'
import { sanitizeObjectKeys, safeParseJson } from '../lib/sanitize.js'
import { canModifyRecord, maskGuestSensitiveFields } from '../lib/securityGuards.js'

const VALID_TEST_RECORD_STATUSES = new Set(['pending', 'completed', 'failed', 'archived'])

// A+B 修复（2026-09-14）：列表接口单次返回上限。
// 原为 500，但前端 Storage 的同步窗口（maxSyncRows）已提升到 1000 —— 若后端仍卡 500，
// 单模块超过 500 条时前端永远拉不全（田家炳补导后 leanMeat 481 条即接近该阈值）。
const MAX_RECORDS_LIMIT = 2000

export function createRecordRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, idempotencyMiddleware }) {
    const router = express.Router()

    // ====== Test Records API ======
    // CR-11: 写接口幂等中间件覆盖（与 /api/records 一致，避免重试导致重复写入）
    router.use('/api/test-records', idempotencyMiddleware)
    router.use('/api/records', idempotencyMiddleware)

    // 创建测试记录
    router.post('/api/test-records', authenticateUser, requireEditorOrAbove, async (req, res) => {
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

            const safeLimit = Math.min(parseInt(limit) || 100, MAX_RECORDS_LIMIT)
            const safeOffset = Math.max(0, parseInt(offset) || 0)

            const records = await req.db.testRecord.findMany({
                where,
                skip: safeOffset,
                take: safeLimit,
                orderBy: { created_at: 'desc' }
            })

            const total = await req.db.testRecord.count({ where })

            // DS3-M6: guest 可见全校汇总数据（统计看板需要），但 PII 字段做部分掩码
            const payloads = records.map(buildRecordPayload)
            res.json({
                success: true,
                data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
                total,
                limit: safeLimit,
                offset: safeOffset
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
    //   oil：colorLevel 非空时按"不含不合格"判定，为空时回退 result 规则
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
                WHEN 'oil' THEN (CASE WHEN COALESCE("result_data"->>'colorLevel','') <> ''
                                      THEN "result_data"->>'colorLevel' NOT LIKE '%不合格%'
                                      ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%'
                                            AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%') END)
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

            res.json({
                success: true,
                data: {
                    total,
                    passCount: passTotal,
                    passRate: total ? Math.round((passTotal / total) * 1000) / 10 : null,
                    byType,
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

    // ====== Legacy Frontend Compatibility: /api/records/:tableName ======

    // 越权修复：guest 只能读取该校 visible_types 白名单模块（强制排除 pathogen），见 requireGuestReadOnly
    router.get('/api/records/:tableName', authenticateUser, requireGuestReadOnly, async (req, res) => {
        try {
            const testType = normalizeRecordType(req.params.tableName)
            if (!testType) {
                return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
            }

            const { limit = 100, offset = 0, status } = req.query
            const safeLimit = Math.min(parseInt(limit) || 100, MAX_RECORDS_LIMIT)
            const safeOffset = Math.max(0, parseInt(offset) || 0)
            const where = { test_type: testType }
            if (status) where.status = status

            const records = await req.db.testRecord.findMany({
                where,
                skip: safeOffset,
                take: safeLimit,
                orderBy: { created_at: 'desc' }
            })

            const total = await req.db.testRecord.count({ where })

            // DS3-M6: guest 读取记录列表时对 PII 字段脱敏（检测结果类字段保持可见）
            const payloads = records.map(buildRecordPayload)
            res.json({
                success: true,
                data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
                total,
                limit: safeLimit,
                offset: safeOffset
            })
        } catch (error) {
            console.error('❌ Error fetching legacy records:', error)
            res.status(500).json({ error: '获取失败' })
        }
    })

    router.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, async (req, res) => {
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

    router.post('/api/records/:tableName/bulk-upsert', authenticateUser, requireEditorOrAbove, async (req, res) => {
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
                        // NB-25: bulk-upsert 默认"最后写入胜出"；客户端可传 expected_updated_at
                        if (payload?.expected_updated_at) {
                            const expected = String(payload.expected_updated_at).trim()
                            const current = existing.updated_at instanceof Date
                                ? existing.updated_at.toISOString()
                                : String(existing.updated_at || '')
                            if (expected && current && expected !== current) {
                                failed.push({
                                    record_code: recordCode,
                                    reason: '乐观锁冲突：该记录已被其他人修改',
                                    skipped: true
                                })
                                continue
                            }
                        }
                        await req.db.testRecord.update({
                            where: { id: existing.id },
                            data: {
                                ...writeData,
                                version: (existing.version || 0) + 1,
                            }
                        })
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

    router.put('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
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

            // P2-07: 更新前进行字段 Schema 验证
            const updateValidation = validateRecordPayload(testType, req.body || {})
            if (!updateValidation.valid) {
                return res.status(400).json({ error: '❌ 字段验证失败', details: updateValidation.errors })
            }

            // 2026-09-16：统一归一 + 状态白名单（archived 属管理动作）
            const built = buildRecordWriteData(testType, req.body || {})
            if (!built.ok) return res.status(400).json({ error: `❌ ${built.message}`, code: built.code })
            const statusCheck = resolveWritableStatus({ requested: req.body?.status, role: req.user?.role, currentStatus: existing.status })
            if (!statusCheck.ok) return res.status(400).json({ error: `❌ ${statusCheck.message}`, code: 'STATUS_NOT_ALLOWED' })
            const writeData = { ...built.data, ...(statusCheck.status ? { status: statusCheck.status } : {}) }

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
            const PROTECTED_FIELDS_COMMON = ['remarks', 'remark', 'result_unit', 'unit']
            const PROTECTED_FIELDS_BY_TYPE = {
                pesticide: [...PROTECTED_FIELDS_COMMON, 'vegetableType', 'batchNo', 'sampleNo', 'limitValue', 'detectionLimit', 'sampleSource'],
                leanMeat: [...PROTECTED_FIELDS_COMMON, 'vegetableType', 'batchNo', 'sampleNo', 'limitValue', 'detectionLimit', 'sampleSource'],
                oil: [...PROTECTED_FIELDS_COMMON, 'oilType', 'sampleNo', 'limitValue', 'sampleSource'],
                tableware: [...PROTECTED_FIELDS_COMMON, 'atpPoints', 'sampleInfo', 'recheckRecords'],
                pathogen: [...PROTECTED_FIELDS_COMMON, 'sampleId', 'sampleType', 'positiveItems', 'positiveDetails', 'riskLevel', 'riskReason', 'allTestItems']
            }
            const PROTECTED_FIELDS = PROTECTED_FIELDS_BY_TYPE[testType] || PROTECTED_FIELDS_BY_TYPE.pesticide
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

            // 版本号乐观锁（如果客户端传了 version 字段）
            if (req.body && typeof req.body.version !== 'undefined' && req.body.version !== existing.version) {
                return res.status(409).json({
                    error: '版本冲突，请获取最新数据后重试',
                    serverVersion: existing.version,
                    clientVersion: req.body.version
                })
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
                    return res.status(409).json({ error: '版本冲突，请获取最新数据后重试', serverVersion: 'stale' })
                }
                throw e
            }

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

    router.delete('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
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
    router.put('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
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
                mode: 'update',
            })
            if (!norm.ok) {
                return res.status(400).json({ error: `❌ ${norm.message}`, code: norm.code })
            }
            if (norm.resultData !== undefined) updateData.result_data = norm.resultData
            if (norm.provided.length) updateData.sample_info = norm.sampleInfo

            // 并发保护（审阅 H3）：客户端提供 version 时走原子条件更新；未提供时保留旧行为，
            // 但在响应中回传服务端 version，并在日志中提示（本端点无仓库内调用方 —— 全仓 grep 仅集成测试用 DELETE）。
            const clientVersion = req.body?.version
            let record
            if (clientVersion !== undefined && clientVersion !== null && clientVersion !== '') {
                record = await req.db.testRecord.update({
                    where: { id, version: Number(clientVersion) },
                    data: updateData,
                })
            } else {
                console.warn(`[PUT /api/test-records/:id] 未携带 version（无并发保护）：id=${id} userId=${req.userId}`)
                record = await req.db.testRecord.update({ where: { id }, data: updateData })
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
    router.delete('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
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
