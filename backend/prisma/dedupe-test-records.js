import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'

const prisma = new PrismaClient()
const shouldApply = process.argv.includes('--apply')

function normalizeObject(value) {
  if (Array.isArray(value)) {
    const normalizedItems = value.map(normalizeObject)
    return normalizedItems.sort((a, b) => {
      const left = JSON.stringify(a)
      const right = JSON.stringify(b)
      return left.localeCompare(right)
    })
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalizeObject(value[key])
        return acc
      }, {})
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

function safeParseJson(value, fallback = {}) {
  if (!value) return fallback

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function buildRecordFingerprint(record) {
  const sampleInfo = safeParseJson(record.sample_info, {})
  const resultData = safeParseJson(record.result_data, {})

  // Keep this consistent with backend buildRecordHash strategy.
  const mergedPayload = {
    ...sampleInfo,
    ...resultData
  }
  const sanitized = stripVolatileFields(mergedPayload)
  const normalized = normalizeObject(sanitized)
  const raw = `${record.test_type || ''}::${JSON.stringify(normalized)}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

async function main() {
  const records = await prisma.testRecord.findMany({
    select: {
      id: true,
      test_type: true,
      test_name: true,
      sample_info: true,
      result_data: true,
      created_at: true,
      updated_at: true
    },
    orderBy: {
      created_at: 'asc'
    }
  })

  const byFingerprint = new Map()

  for (const record of records) {
    const fp = buildRecordFingerprint(record)
    const list = byFingerprint.get(fp) || []
    list.push(record)
    byFingerprint.set(fp, list)
  }

  const duplicateGroups = []
  const deleteIds = []

  for (const [, group] of byFingerprint) {
    if (group.length <= 1) continue

    const sorted = [...group].sort((a, b) => {
      const aTime = new Date(a.updated_at || a.created_at).getTime()
      const bTime = new Date(b.updated_at || b.created_at).getTime()
      const diff = bTime - aTime
      if (diff !== 0) return diff
      return b.id.localeCompare(a.id)
    })

    const keep = sorted[0]
    const remove = sorted.slice(1)

    duplicateGroups.push({
      keep,
      remove
    })

    remove.forEach(item => deleteIds.push(item.id))
  }

  console.log('=== TestRecord 去重预览 ===')
  console.log(`总记录数: ${records.length}`)
  console.log(`重复组数: ${duplicateGroups.length}`)
  console.log(`可删除重复数: ${deleteIds.length}`)

  if (duplicateGroups.length > 0) {
    console.log('\n示例（最多显示前10组）:')
    duplicateGroups.slice(0, 10).forEach((group, idx) => {
      const table = group.keep.test_type
      const keepId = group.keep.id
      const removeIds = group.remove.map(r => r.id).join(', ')
      console.log(`${idx + 1}. type=${table} keep=${keepId} remove=[${removeIds}]`)
    })
  }

  if (!shouldApply) {
    console.log('\n当前为预览模式，未执行删除。')
    console.log('执行删除请运行: npm run dedupe:apply')
    return
  }

  if (deleteIds.length === 0) {
    console.log('\n没有可删除的重复记录。')
    return
  }

  const result = await prisma.testRecord.deleteMany({
    where: {
      id: {
        in: deleteIds
      }
    }
  })

  console.log(`\n已删除重复记录: ${result.count}`)
}

main()
  .catch(error => {
    console.error('去重执行失败:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
