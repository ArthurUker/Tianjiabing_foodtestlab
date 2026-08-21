/**
 * Schema 兼容性工具
 * 用于备份验证/恢复：对比「备份时的 schema 快照」与「当前数据库期望结构」。
 * 2026-08-20 由 can_view_pathogen 恢复后 schema 漂移事故引出。
 */

import { assertSafeSchemaName } from './tenantClient.js'

/**
 * 读取指定 schema 下业务表的列结构（排除 _prisma_migrations）。
 * 返回 {"table": [{column,type}]}。
 */
export async function readCurrentSchemaColumns(prisma, schema) {
  if (schema !== 'public') assertSafeSchemaName(schema)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name != '_prisma_migrations'
     ORDER BY table_name, ordinal_position`,
    schema
  )
  const tables = {}
  for (const r of rows) {
    if (!tables[r.table_name]) tables[r.table_name] = []
    tables[r.table_name].push({ column: r.column_name, type: r.data_type })
  }
  return tables
}

/**
 * 对比「备份时的 schema 快照」与「对齐后影子 schema 的当前列结构」，
 * 生成恢复兼容性报告。
 *
 * 返回 { compatible: boolean, summary: string, details: Array<string> }
 *   - compatible=true：结构与当前代码一致（无需额外处理）
 *   - compatible=false：备份结构偏旧，恢复时已/将自动补齐差异列/表
 */
export function compareSchemaSnapshot(backupSnapshot, currentTables) {
  if (!backupSnapshot || typeof backupSnapshot !== 'object' || Object.keys(backupSnapshot).length === 0) {
    return {
      compatible: false,
      summary: '备份无结构快照（旧版本备份），恢复后将自动对齐',
      details: ['meta.schemaSnapshot 缺失，无法做结构兼容性判断']
    }
  }

  const details = []
  let hasDiff = false

  // 以当前（对齐后）结构为基准，找出备份中缺失的表/列
  for (const [table, currentCols] of Object.entries(currentTables)) {
    const backupCols = backupSnapshot[table]
    if (!backupCols) {
      details.push(`表 ${table} 在备份中不存在，已随当前 schema.prisma 补齐`)
      hasDiff = true
      continue
    }
    const backupColMap = new Map(backupCols.map((c) => [c.column, c.type]))
    for (const { column, type } of currentCols) {
      const backupType = backupColMap.get(column)
      if (backupType === undefined) {
        details.push(`表 ${table} 缺少列 ${column}（类型 ${type}），已自动补齐`)
        hasDiff = true
      } else if (backupType !== type) {
        details.push(`表 ${table} 列 ${column} 类型变更：备份=${backupType} → 当前=${type}，已按当前模型对齐`)
        hasDiff = true
      }
    }
  }

  // 备份中有、但当前模型已删除的表/列
  for (const [table, backupCols] of Object.entries(backupSnapshot)) {
    if (!currentTables[table]) {
      details.push(`表 ${table} 在当前 schema.prisma 中已删除，恢复后不会包含该表`)
      hasDiff = true
      continue
    }
    const currentColMap = new Map(currentTables[table].map((c) => [c.column, c.type]))
    for (const { column } of backupCols) {
      if (!currentColMap.has(column)) {
        details.push(`表 ${table} 列 ${column} 在当前 schema.prisma 中已删除，恢复后不会包含该列`)
        hasDiff = true
      }
    }
  }

  if (hasDiff) {
    return {
      compatible: false,
      summary: `结构不兼容：备份结构偏旧，恢复将自动补齐 ${details.length} 项差异`,
      details
    }
  }
  return {
    compatible: true,
    summary: '结构兼容：备份结构与当前 schema.prisma 一致',
    details: []
  }
}

/**
 * 对一组 schema 批量生成兼容性报告。
 * @param {PrismaClient} prisma
 * @param {Object} schemaSnapshots  { schemaName: { table: [{column,type}] } }
 * @returns {Promise<{compatible:boolean, summary:string, details:string[], reports:Object}>}
 */
export async function compareAllSchemaSnapshots(prisma, schemaSnapshots) {
  if (!schemaSnapshots || Object.keys(schemaSnapshots).length === 0) {
    return {
      compatible: false,
      summary: '无结构快照',
      details: ['备份未记录 schemaSnapshot'],
      reports: {}
    }
  }

  const reports = {}
  let allCompatible = true
  const allDetails = []

  for (const [schema, snapshot] of Object.entries(schemaSnapshots)) {
    if (schema === 'public') {
      // public schema 通常变化较少，也做检查但不阻断
      const current = await readCurrentSchemaColumns(prisma, schema)
      const r = compareSchemaSnapshot(snapshot, current)
      reports[schema] = r
      if (!r.compatible) allCompatible = false
      if (!r.compatible) allDetails.push(`[${schema}] ${r.summary}`, ...r.details.slice(0, 3))
      continue
    }
    const current = await readCurrentSchemaColumns(prisma, schema)
    const r = compareSchemaSnapshot(snapshot, current)
    reports[schema] = r
    if (!r.compatible) allCompatible = false
    if (!r.compatible) allDetails.push(`[${schema}] ${r.summary}`, ...r.details.slice(0, 3))
  }

  return {
    compatible: allCompatible,
    summary: allCompatible
      ? '所有 schema 结构与当前代码一致'
      : `部分 schema 结构偏旧，恢复将自动补齐 ${allDetails.length} 项差异`,
    details: allDetails,
    reports
  }
}
