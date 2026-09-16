// ===== 检测记录归一化 / 哈希 / 载荷构建（从 server.js 抽取，P1-5 拆路由 Step 1）=====
import crypto from 'crypto'
import { sanitizeObjectKeys, safeParseJson } from './sanitize.js'
import { writeTenantAuditLog } from './auditLog.js'

const RECORD_ROUTE_TYPES = new Set([
    'tableware',
    'pathogen',
    'leanMeat',
    'oil',
    'pesticide'
])

const TEST_TYPE_LABELS = {
    tableware: '餐具洁净度检测',
    pathogen: '病原体检测',
    leanMeat: '肉、蛋农残检测',
    oil: '食用油品质检测',
    pesticide: '果蔬农残检测'
}

function normalizeRecordType(tableName) {
    return RECORD_ROUTE_TYPES.has(tableName) ? tableName : null
}

function buildRecordPayload(record) {
    // D-06: 展开前净化，防止 __proto__ 等键随响应传播到前端造成原型链污染
    const sampleInfo = sanitizeObjectKeys(safeParseJson(record.sample_info, {}))
    const resultData = sanitizeObjectKeys(safeParseJson(record.result_data, {}))

    // 服务端元字段必须最后展开（最高优先级）：result_data/sample_info 中可能残留
    // 用户提交或历史脏数据写入的 version/status/record_code 等键（见 buildRecordWriteData
    // 的剥离与 FIX-409 记录），若由 ...resultData 覆盖会返回错误 version，
    // 前端乐观锁重试时永远 409。
    const merged = {
        ...sampleInfo,
        ...resultData,
        id: record.id,
        record_code: record.record_code,
        test_type: record.test_type,
        test_name: record.test_name,
        status: record.status,
        version: record.version || 0,
        created_at: record.created_at,
        updated_at: record.updated_at
    }
    // 上下文三键以 sample_info（权威位置）为准，仅在权威位置**缺失**（undefined/null）时
    // 才回退到 result_data 内的历史同义副本（2026-09-16 审阅 M1：原实现让副本覆盖权威值，
    // 与"以顶层为准"契约相反，并会把 sample_info-only 的修复在前端隐藏）。
    // 注意：权威位置为**空字符串**时视为"显式清空"，不得让旧副本复活。
    for (const f of CONTEXT_FIELDS) {
        const v = sampleInfo[f]
        if (v !== undefined && v !== null) merged[f] = v
    }
    return merged
}

// ───────────────────── 上下文三键与写入归一（2026-09-16 审阅 H1/H2/H3/M5 统一定稿）─────────────────────
//
// 三键 = 业务检测日期 / 食堂 / 检测人。平台不变量：**必填、非空**（看板按 canteen 分组，
// 员工端 stats 与开放接口统计均按 sample_info.testDate 过滤业务日期），因此**不允许清空**。
//
// 口径（写入与读取共用，任何入口不得偏离）：
//   · 权威位置 = `TestRecord.sample_info`（读时展开为顶层）；`result_data` 内出现同义键 = 历史副本。
//   · **请求内优先级：顶层 > sample_info > result_data**。理由（依真实调用方）：顶层是"读取后展开"
//     的形态 —— Web 客户端（`core/Storage.js` 送扁平对象）与 App 都直接操作它；`sample_info` /
//     `result_data` 是存储细节，冲突时视为客户端携带的陈旧副本。
//   · **本次请求任一处提交的值优先于数据库旧值**；局部更新时未提交的字段保留旧值。
//   · `null` / 空字符串 / 缺键：三键统一视为"未提交"（因不允许清空）。整对象替换入口由
//     `validateRecordPayload` 返回 400；局部更新入口保留旧值。
//   · 读取（`buildRecordPayload`）：权威位置有值（含空串）即用权威值，仅**缺失**（undefined/null）
//     时才回退旧副本 —— 显式清空不得让副本复活。
const CONTEXT_FIELDS = ['testDate', 'canteen', 'inspector']

/**
 * result_data 内绝不落库的控制/传输字段。
 * 背景：历史实现用整个请求体当 result_data（`data.result_data || data`），导致 status / created_by /
 * id / record_code 等被写进结果 JSON（审阅 A7/L2 实测：客户端还能把 `status='archived'` 塞进结果对象、
 * `result_data:null` 会把字面键写进去）。此处统一剔除。
 */
const CONTROL_KEYS = new Set([
    'id', '_status', 'status', 'version', 'record_code', 'test_type', 'test_name',
    'created_at', 'updated_at', 'createdAt', 'updatedAt', 'completed_at',
    'created_by', 'createdBy', 'expected_updated_at', 'sync_time', 'last_sync_at',
    'sample_info', 'result_data',
    'action', 'store', 'syncId', 'timestamp',
    ...CONTEXT_FIELDS,
])

/** 可写状态白名单：archived（归档）属管理动作，editor 不可设置。 */
const WRITABLE_STATUS_EDITOR = new Set(['pending', 'completed', 'failed'])
const WRITABLE_STATUS_MANAGER = new Set(['pending', 'completed', 'failed', 'archived'])

function isPlainObject(v) {
    return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 解析「本次请求提交的上下文三键」（按 顶层 > sample_info > result_data 取第一个有效值）。
 * @returns {{ values: object, missing: string[] }}
 */
function resolveContextValues({ payload = {}, sampleInfo, resultData } = {}) {
    const values = {}
    for (const f of CONTEXT_FIELDS) {
        for (const src of [payload, sampleInfo, resultData]) {
            if (!isPlainObject(src)) continue
            if (!Object.prototype.hasOwnProperty.call(src, f)) continue
            const raw = src[f]
            if (raw === undefined || raw === null) continue
            const s = typeof raw === 'string' ? raw.trim() : String(raw)
            if (s === '') continue
            values[f] = s
            break
        }
    }
    return { values, missing: CONTEXT_FIELDS.filter((f) => values[f] === undefined) }
}

/** result_data 落库前剔除控制字段与上下文副本（仅顶层，不递归）。 */
function stripControlKeys(source) {
    const out = {}
    if (!isPlainObject(source)) return out
    for (const [k, v] of Object.entries(source)) {
        if (CONTROL_KEYS.has(k)) continue
        out[k] = v
    }
    return out
}

/**
 * 写入归一：所有入口共用的唯一实现。
 *
 * @param {object} o
 *   - payload            请求体（扁平形态来源；create 时作为 result_data 的兜底来源）
 *   - resultData         请求中显式提交的 result_data
 *   - sampleInfo         请求中显式提交的 sample_info
 *   - existingSampleInfo 数据库旧 sample_info；**null = 整对象替换（create）**；对象 = 局部更新的合并基座
 *   - mode               'create' | 'update'
 * @returns {{ok:true, sampleInfo:object, resultData:object|undefined, provided:string[], sourceKind:string}
 *          |{ok:false, code:string, message:string}}
 */
function normalizeWriteJson({ payload = {}, resultData, sampleInfo, existingSampleInfo = null, mode = 'update' } = {}) {
    if (resultData !== undefined && resultData !== null && !isPlainObject(resultData)) {
        return { ok: false, code: 'INVALID_RESULT_DATA', message: 'result_data 必须是 JSON 对象（不接受字符串/数组）' }
    }
    if (sampleInfo !== undefined && sampleInfo !== null && !isPlainObject(sampleInfo)) {
        return { ok: false, code: 'INVALID_SAMPLE_INFO', message: 'sample_info 必须是 JSON 对象' }
    }

    const { values, missing } = resolveContextValues({ payload, sampleInfo, resultData })
    if (mode === 'create' && missing.length) {
        return {
            ok: false,
            code: 'MISSING_CONTEXT_FIELDS',
            message: `缺少必填字段：${missing.join('、')}（检测日期 / 食堂 / 检测人不可为空）`,
        }
    }

    // sample_info：整对象替换 → 仅三键；局部更新 → 以旧值为基座，只覆盖本次提交的键
    const sampleInfoOut = existingSampleInfo === null
        ? { testDate: values.testDate ?? null, canteen: values.canteen ?? null, inspector: values.inspector ?? null }
        : { ...(isPlainObject(existingSampleInfo) ? existingSampleInfo : {}), ...values }

    // result_data：
    //   显式提交的非空对象 → 用它（nested）；
    //   create 且显式为空/未提交 → 用扁平 payload 兜底（flat，剔控制字段）；
    //   update 且显式为空/未提交 → **不改动**（历史实现会写入整条请求体、或在 `{}` 时清空已有结果）
    let resultDataOut
    let sourceKind = 'none'
    const explicitProvided = resultData !== undefined && resultData !== null
    if (explicitProvided && Object.keys(resultData).length > 0) {
        resultDataOut = stripControlKeys(resultData)
        sourceKind = 'nested'
    } else if (mode === 'create') {
        resultDataOut = stripControlKeys(payload)
        sourceKind = 'flat'
        if (Object.keys(resultDataOut).length === 0) {
            return { ok: false, code: 'EMPTY_RESULT_DATA', message: '结果数据为空：请至少提交一个检测业务字段' }
        }
    } else {
        resultDataOut = undefined
        if (explicitProvided) sourceKind = 'empty-object-noop'
    }

    return {
        ok: true,
        sampleInfo: sampleInfoOut,
        resultData: resultDataOut,
        provided: Object.keys(values),
        sourceKind,
    }
}

/**
 * 状态白名单：editor 只能写 pending/completed/failed；archived 属管理动作（manager/admin）。
 * 例外：记录**当前已是** archived 时允许原样保持（避免编辑归档记录被拒）。
 * @returns {{ok:true, status:string|undefined}|{ok:false, message:string}}
 */
function resolveWritableStatus({ requested, role, currentStatus } = {}) {
    if (requested === undefined || requested === null || requested === '') return { ok: true, status: undefined }
    const s = String(requested)
    const allowed = (role === 'admin' || role === 'manager') ? WRITABLE_STATUS_MANAGER : WRITABLE_STATUS_EDITOR
    if (!allowed.has(s) && !(s === 'archived' && currentStatus === 'archived')) {
        return { ok: false, message: `状态「${s}」不允许由当前角色设置（可写：${[...allowed].join(' / ')}）` }
    }
    return { ok: true, status: s }
}

/**
 * 整对象替换入口的写库数据（POST /api/records/:tableName、PUT /api/records/:tableName/:id、
 * bulk-upsert）：上下文三键只落 sample_info，result_data 剔除控制字段与历史副本。
 *
 * 幂等键不受影响：record_code 由**入参 payload** 计算（`buildDeterministicRecordCode`），
 * 与写库形态无关。
 *
 * @returns {{ok:true, data:object}|{ok:false, code:string, message:string}}
 */
function buildRecordWriteData(tableName, payload = {}) {
    // D-06: 写库前净化用户可控 JSON 键（防 __proto__ 等原型链污染）
    const clean = sanitizeObjectKeys({ ...(isPlainObject(payload) ? payload : {}) })
    const norm = normalizeWriteJson({
        payload: clean,
        resultData: clean.result_data,
        sampleInfo: clean.sample_info,
        existingSampleInfo: null,
        mode: 'create',
    })
    if (!norm.ok) return norm
    return {
        ok: true,
        data: {
            test_type: tableName,
            test_name: TEST_TYPE_LABELS[tableName] || tableName,
            // P1-4: sample_info/result_data 升级为 Json（jsonb），直接传对象（Prisma 自动序列化）
            sample_info: norm.sampleInfo,
            result_data: norm.resultData,
            status: typeof clean.status === 'string' && clean.status ? clean.status : 'completed',
        },
    }
}

// TD-Recheck-Sync: 提取记录「最新一次复检是否通过」的结论（通用，与学校租户无关）。
// 兼容三种检测模块的复检数据结构：
//   - GenericTest（果蔬/油/肉蛋）: recheckRecords[0].isPassed
//   - Tableware（餐具）           : recheckRecords[0].isPassed（顶层，points 为点位明细）
//   - Pathogen（病原体）          : recheckReports[0].isPassed
// 无法判定（无复检 / 结构未知 / isPassed 非布尔）时返回 null，调用方据此跳过自愈。
function getLatestRecheckPassed(resultData) {
    const recs = Array.isArray(resultData?.recheckRecords) ? resultData.recheckRecords : []
    if (recs.length > 0) {
        const latest = recs[0]
        if (latest && typeof latest.isPassed === 'boolean') return latest.isPassed
    }
    const reports = Array.isArray(resultData?.recheckReports) ? resultData.recheckReports : []
    if (reports.length > 0) {
        const latest = reports[0]
        if (latest && typeof latest.isPassed === 'boolean') return latest.isPassed
    }
    return null
}

// P2-07: 记录字段 Schema 验证 — 校验 testDate/canteen/inspector 必填且为非空字符串
function validateRecordPayload(tableName, payload) {
    const errors = []
    const requiredFields = ['testDate', 'canteen', 'inspector']
    for (const field of requiredFields) {
        const val = payload[field]
        if (val === undefined || val === null || String(val).trim() === '') {
            errors.push(`字段 "${field}" 不能为空`)
        }
    }
    if (!RECORD_ROUTE_TYPES.has(tableName)) {
        errors.push(`未知的记录类型: ${tableName}`)
    }
    return { valid: errors.length === 0, errors }
}

// P2-02: 审计日志写入辅助函数 — 记录 CRUD 操作到数据库（db 为请求级租户客户端）
// 委派给统一审计门面（TD-P2-13），保持原 7 参签名以最小改动调用方。
async function writeRecordAuditLog(db, userId, action, resourceType, resourceId, details, ip) {
    try {
        await writeTenantAuditLog(db, { actorId: userId, action, resourceType, resourceId, details, ip })
    } catch (e) {
        console.error('❌ 审计日志写入失败:', e.message)
    }
}

function normalizeForHash(value) {
    if (Array.isArray(value)) {
        const normalizedItems = value.map(item => normalizeForHash(item))
        // Use order-insensitive array normalization so semantically identical
        // payloads with different item order still map to the same record code.
        return normalizedItems.sort((a, b) => {
            const left = JSON.stringify(a)
            const right = JSON.stringify(b)
            return left.localeCompare(right)
        })
    }

    if (value && typeof value === 'object') {
        const sorted = {}
        Object.keys(value).sort().forEach(key => {
            sorted[key] = normalizeForHash(value[key])
        })
        return sorted
    }

    return value
}

function stripVolatileFields(value) {
    const volatileKeys = new Set([
        'id',
        '_status',
        'status',
        'record_code',
        'created_at',
        'updated_at',
        'createdAt',
        'updatedAt',
        'sync_time',
        'last_sync_at',
        'modificationLogs',
        'recheckRecords',
        'recheckReports',
        'importTime',
        'importUser',
        'lastModified'
    ])

    if (Array.isArray(value)) {
        return value.map(item => stripVolatileFields(item))
    }

    if (value && typeof value === 'object') {
        const clean = {}
        Object.keys(value).forEach(key => {
            if (volatileKeys.has(key)) return
            clean[key] = stripVolatileFields(value[key])
        })
        return clean
    }

    return value
}

function buildRecordHash(tableName, payload) {
    const sanitized = stripVolatileFields(payload || {})
    const normalized = normalizeForHash(sanitized)
    const raw = `${tableName}::${JSON.stringify(normalized)}`
    return crypto.createHash('sha256').update(raw).digest('hex')
}

function buildDeterministicRecordCode(tableName, payload) {
    const hash = buildRecordHash(tableName, payload)
    return `RC-${tableName}-${hash}`
}

export {
    RECORD_ROUTE_TYPES,
    TEST_TYPE_LABELS,
    CONTEXT_FIELDS,
    CONTROL_KEYS,
    normalizeWriteJson,
    resolveContextValues,
    resolveWritableStatus,
    stripControlKeys,
    normalizeRecordType,
    buildRecordPayload,
    buildRecordWriteData,
    getLatestRecheckPassed,
    validateRecordPayload,
    writeRecordAuditLog,
    normalizeForHash,
    stripVolatileFields,
    buildRecordHash,
    buildDeterministicRecordCode,
}
