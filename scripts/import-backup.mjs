import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', 'backend', '.env') })

const prisma = new PrismaClient()

const backupPath = process.argv[2]
if (!backupPath) {
    console.error('用法: node scripts/import-backup.mjs <backup.json>')
    process.exit(1)
}

const raw = readFileSync(backupPath, 'utf8')
const backup = JSON.parse(raw)
const tables = backup.tables || {}

// 目标 schoolCode（与 .env 的 SCHOOL_CODES 第一个一致）
const schoolCode = 'demo'
// 通过 raw SQL 直接插入 school_demo schema
const schema = 'school_demo'
// 数据所有者 UUID（种子创建的 admin）
const ADMIN_ID = 'u_demo_admin'

function hash(s) { return createHash('sha256').update(s).digest('hex').slice(0, 12) }

// ---- 旧格式 → 新格式 字段映射 ----

function mapTableware(rec) {
    const testDate = rec.testDate || ''
    const canteen = rec.canteen || ''
    const sampleKey = `${testDate}::${canteen}::${rec.inspector || ''}`
    return {
        record_code: `RC-tableware-${hash(sampleKey)}`,
        test_type: 'tableware',
        test_name: `餐具洁净度检测 - ${canteen}`,
        sample_info: JSON.stringify({ canteen, location: rec.location || '', inspector: rec.inspector || '' }),
        result_data: JSON.stringify({
            result: rec.result || '',
            rluValue: rec.rluValue || '',
            testType: rec.testType || 'atp',
            atpPoints: rec.atpPoints || [],
            recheckResult: rec.recheckResult || '',
            correctiveAction: rec.correctiveAction || '',
            testDate
        }),
        status: 'completed',
        version: 0,
        data_version: 1,
        created_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
        completed_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
    }
}

function mapPesticide(rec) {
    const testDate = rec.testDate || ''
    const canteen = rec.canteen || ''
    const sampleKey = `${testDate}::${canteen}::${rec.inspector || ''}`
    return {
        record_code: `RC-pesticide-${hash(sampleKey)}`,
        test_type: 'pesticide',
        test_name: `果蔬农残检测 - ${canteen}`,
        sample_info: JSON.stringify({ canteen, vegetableType: rec.vegetableType || '', batchNo: rec.batchNo || '', inspector: rec.inspector || '' }),
        result_data: JSON.stringify({
            result: rec.result || '',
            remark: rec.remark || '',
            testDate
        }),
        status: 'completed',
        version: 0,
        data_version: 1,
        created_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
        completed_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
    }
}

function mapOil(rec) {
    const testDate = rec.testDate || ''
    const canteen = rec.canteen || ''
    const sampleKey = `${testDate}::${canteen}::${rec.inspector || ''}`
    // oil 没有传统 result 字段，用 colorLevel / tpmValue 标记状态
    const overallStatus = (rec.colorLevel && rec.colorLevel.includes('不合格')) ? 'failed' : 'completed'
    return {
        record_code: `RC-oil-${hash(sampleKey)}`,
        test_type: 'oil',
        test_name: `食用油品质检测 - ${canteen}`,
        sample_info: JSON.stringify({ canteen, inspector: rec.inspector || '' }),
        result_data: JSON.stringify({
            oilTemp: rec.oilTemp || '',
            tpmValue: rec.tpmValue || '',
            acidValue: rec.acidValue || '',
            colorLevel: rec.colorLevel || '',
            remark: rec.remark || '',
            testDate
        }),
        status: overallStatus,
        version: 0,
        data_version: 1,
        created_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
        completed_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
    }
}

function mapLeanMeat(rec) {
    const testDate = rec.testDate || ''
    const canteen = rec.canteen || ''
    const sampleKey = `${testDate}::${canteen}::${rec.inspector || ''}::${rec.meatType || ''}`
    return {
        record_code: `RC-leanMeat-${hash(sampleKey)}`,
        test_type: 'leanMeat',
        test_name: `肉蛋农残检测 - ${canteen}`,
        sample_info: JSON.stringify({ canteen, meatType: rec.meatType || '', batchNo: rec.batchNo || '', inspector: rec.inspector || '' }),
        result_data: JSON.stringify({
            result: rec.result || '',
            remark: rec.remark || '',
            testDate
        }),
        status: 'completed',
        version: 0,
        data_version: 1,
        created_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
        completed_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
    }
}

function mapPathogen(rec) {
    const testDate = rec.testDate || ''
    const canteen = rec.canteen || ''
    const sampleKey = `${testDate}::${canteen}::${rec.sampleId || ''}`
    const hasPositive = (rec.positiveItems && Array.isArray(rec.positiveItems) && rec.positiveItems.length > 0)
    return {
        record_code: `RC-pathogen-${hash(sampleKey)}`,
        test_type: 'pathogen',
        test_name: `致病菌检测 - ${canteen}`,
        sample_info: JSON.stringify({ canteen, sampleId: rec.sampleId || '', sampleType: rec.sampleType || '', inspector: rec.inspector || '' }),
        result_data: JSON.stringify({
            riskLevel: rec.riskLevel || '',
            riskReason: rec.riskReason || '',
            sampleInfo: rec.sampleInfo || '',
            allTestItems: rec.allTestItems || [],
            positiveItems: rec.positiveItems || [],
            internalControlStatus: rec.internalControlStatus || '',
            testDate
        }),
        status: hasPositive ? 'failed' : 'completed',
        version: 0,
        data_version: 1,
        created_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
        completed_at: testDate ? new Date(testDate + 'T00:00:00+08:00') : new Date(),
    }
}

const mappers = {
    tableware: mapTableware,
    pesticide: mapPesticide,
    oil: mapOil,
    leanMeat: mapLeanMeat,
    pathogen: mapPathogen,
}

// ---- 执行导入 ----

let total = 0
let inserted = 0
let skipped = 0
let errors = 0

for (const [tableName, mapper] of Object.entries(mappers)) {
    const records = tables[tableName]?.data || []
    if (!records.length) { console.log(`[跳过] ${tableName}: 0 条`); continue }

    console.log(`[导入] ${tableName}: ${records.length} 条 ...`)
    total += records.length

    for (const rec of records) {
        try {
            const mapped = mapper(rec)
            // 检查是否已存在（按 record_code 去重）
            const exist = await prisma.$queryRawUnsafe(
                `SELECT "id" FROM "${schema}"."TestRecord" WHERE "record_code" = $1 LIMIT 1`,
                mapped.record_code
            )
            if (exist.length > 0) {
                skipped++
                continue
            }

            await prisma.$executeRawUnsafe(
                `INSERT INTO "${schema}"."TestRecord"
                 ("id","record_code","test_type","test_name","sample_info","result_data","status",
                  "created_by","created_at","updated_at","version","data_version","completed_at")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                require('crypto').randomUUID(),
                mapped.record_code,
                mapped.test_type,
                mapped.test_name,
                mapped.sample_info,
                mapped.result_data,
                mapped.status,
                ADMIN_ID,
                mapped.created_at,
                new Date(),
                mapped.version,
                mapped.data_version,
                mapped.completed_at
            )
            inserted++
        } catch (err) {
            console.error(`  ❌ 失败: ${tableName} #${rec.id || '?'} - ${err.message}`)
            errors++
        }
    }
}

console.log(`\n✅ 导入完成: 总计 ${total} 条, 插入 ${inserted} 条, 跳过(已存在) ${skipped} 条, 失败 ${errors} 条`)
await prisma.$disconnect()
