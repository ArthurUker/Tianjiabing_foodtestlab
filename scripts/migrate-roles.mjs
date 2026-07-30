/**
 * 一次性数据迁移脚本
 * ---------------------------------------------------------------
 * 1) 将冗余的 user 角色归并到 operator（检测员）。
 *    —— user 原本与 operator 同义，且因前端权限矩阵漏定义 user 而成为"废号"。
 * 2) 将 Guest.guest_type 的 'viewer' 改名为 'readonly'，
 *    避免与 User.role='viewer'（查看者）撞名造成概念混淆。
 *
 * 覆盖所有 school_* 租户 schema（及 EXTRA_SCHEMAS 指定的其它 schema，如 dev）。
 * 幂等：重复执行安全（WHERE 子句已限定旧值）。
 *
 * 运行：
 *   DATABASE_URL=postgresql://user:pass@host:5432/db node scripts/migrate-roles.mjs
 *   EXTRA_SCHEMAS=dev node scripts/migrate-roles.mjs
 * 若未设置 DATABASE_URL，脚本会尝试从 backend/.env 自动读取。
 */

import { Pool } from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadDatabaseUrlFromEnvFile() {
  const candidates = [
    path.resolve(__dirname, '..', 'backend', '.env'),
    path.resolve(__dirname, '..', '.env'),
  ]
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue
    const content = fs.readFileSync(f, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/)
      if (m) return m[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return null
}

const DATABASE_URL = process.env.DATABASE_URL || loadDatabaseUrlFromEnvFile()
if (!DATABASE_URL) {
  console.error('❌ 未找到 DATABASE_URL，请设置环境变量或在 backend/.env 中配置后重试。')
  process.exit(1)
}

const EXTRA_SCHEMAS = (process.env.EXTRA_SCHEMAS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const pool = new Pool({ connectionString: DATABASE_URL })

async function getSchemas() {
  const { rows } = await pool.query(`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'school_%'
  `)
  const schemas = rows.map((r) => r.schema_name)
  for (const s of EXTRA_SCHEMAS) {
    if (!schemas.includes(s)) schemas.push(s)
  }
  return schemas
}

async function tableExists(schema, table) {
  const { rows } = await pool.query(`SELECT to_regclass($1) AS t`, [`"${schema}"."${table}"`])
  return !!rows[0]?.t
}

async function main() {
  const schemas = await getSchemas()
  console.log(`🔍 目标 schema 数：${schemas.length} -> ${schemas.join(', ') || '(无)'}`) // eslint-disable-line

  let totalUser = 0
  let totalGuest = 0

  for (const schema of schemas) {
    if (await tableExists(schema, 'User')) {
      const r = await pool.query(
        `UPDATE "${schema}"."User" SET "role" = 'operator' WHERE "role" = 'user'`,
      )
      if (r.rowCount > 0) {
        totalUser += r.rowCount
        console.log(`  ✅ ${schema}.User  迁移 ${r.rowCount} 行 (user -> operator)`)
      }
    }
    if (await tableExists(schema, 'Guest')) {
      const r = await pool.query(
        `UPDATE "${schema}"."Guest" SET "guest_type" = 'readonly' WHERE "guest_type" = 'viewer'`,
      )
      if (r.rowCount > 0) {
        totalGuest += r.rowCount
        console.log(`  ✅ ${schema}.Guest 迁移 ${r.rowCount} 行 (viewer -> readonly)`)
      }
    }
  }

  console.log(`\n🎉 迁移完成：User ${totalUser} 行，Guest ${totalGuest} 行。`)
  await pool.end()
}

main().catch(async (e) => {
  console.error('❌ 迁移失败:', e.message)
  try {
    await pool.end()
  } catch (_) {
    /* ignore */
  }
  process.exit(1)
})
