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
    return {
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
}

function buildRecordWriteData(tableName, payload) {
    // D-06: 写库前净化用户可控 JSON 键
    const baseData = sanitizeObjectKeys({ ...payload })
    delete baseData.id
    delete baseData._status
    // 服务端管理字段不落入 result_data：若写入，经 buildRecordPayload 的
    // ...resultData 展开会覆盖真实服务端值，前端拿到旧 version 后乐观锁
    // 重试永远 409（历史脏数据已存在，由 buildRecordPayload 兜底修正）。
    delete baseData.version
    delete baseData.record_code
    delete baseData.test_type
    delete baseData.test_name
    delete baseData.created_at
    delete baseData.updated_at
    delete baseData.completed_at

    const testDate = baseData.testDate || null
    const canteen = baseData.canteen || null
    const inspector = baseData.inspector || null

    return {
        test_type: tableName,
        test_name: TEST_TYPE_LABELS[tableName] || tableName,
        // P1-4: sample_info/result_data 升级为 Json（jsonb），直接传对象（Prisma 自动序列化）
        sample_info: {
            testDate,
            canteen,
            inspector
        },
        result_data: baseData,
        status: baseData.status || 'completed'
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
