// P3-LIFECYCLE-AB-R3 · 为契约租户（t02a-<runId>-a）建 schema 并回放全链（含 M1）
// 用途：让 openapi-http 等"契约租户"定点在自有隔离实例上可运行（不依赖 t02c 口令 fixture）。
import { PrismaClient } from '@prisma/client'
import { listMigrationFiles, applyTenantChain, parseDbUrl } from '../../lib/tenantProvisioner.js'
import { schemaNameOf } from '../../lib/tenantClient.js'

const ADMIN_URL = process.env.ADMIN_DATABASE_URL
const RUN_ID = process.env.RUN_ID
const TEST_URL = process.env.TEST_DATABASE_URL
if (!ADMIN_URL || !RUN_ID || !TEST_URL) { console.error('缺 ADMIN_DATABASE_URL/RUN_ID/TEST_DATABASE_URL'); process.exit(2) }

const tenantCode = `t02a-${RUN_ID}-a`
const schema = schemaNameOf(tenantCode)
const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
const testRole = new URL(TEST_URL.replace('postgresql://', 'http://')).username
const conn = parseDbUrl(ADMIN_URL)

const main = async () => {
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  const r = await applyTenantChain({ prisma: admin, conn, schema, chainFiles: listMigrationFiles(), log: () => {} })
  await admin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${testRole}"`)
  await admin.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${testRole}"`)
  await admin.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${testRole}"`)
  console.log(JSON.stringify({ ok: true, tenantCode, schema, applied: r.applied.length, skippedPublicOnly: r.skippedPublicOnly.length, status: r.status }))
  await admin.$disconnect()
}
main().catch(async (e) => { console.error('setup 失败:', e); await admin.$disconnect(); process.exit(1) })
