// 006_audit_principal_gate.mjs — P3-LIFECYCLE-AB-R3 · Release B 两段部署之间的**只读强门禁**
//
// 判据（全部通过才允许进入 B2 = 生成/激活 B 版 required client）：
//   G2 全租户 AuditLog.principal_id IS NULL 计数 = 0
//   G7 全租户 AuditLog.principal_id 列 attnotnull = true
//   G8 全租户 CHECK "AuditLog_principal_id_required_new" 存在且 convalidated = true
//   G3 系统主体每 schema 恰 1 行（kind='system'）
//   G3③ 系统主体不得承载**语义非空**快照的行（count=0）
//   G3④ 无主体且**语义空**快照的行不得落到人类主体（count=0）
//
// R13-3（空快照口径统一，代码与文档一致性由 git diff --check + 本文件头 + R4 RESULT §R13-3 共同固定）：
//   "语义空快照" := actor_snapshot IS NULL OR actor_snapshot IN ('null'::jsonb, '{}'::jsonb)
//     · 三种形态都表示"没有可用的人类主体快照"（SQL NULL / JSONB null / 空对象）；
//     · hasSemanticSnapshot := NOT 语义空 —— G3③ 用它判"系统行不得携带人类证据"，
//       G3④ 用它判"人类行必须携带人类证据锚点"。两条判据共用同一谓词，不再出现不对称。
//   局限（本门禁**不**覆盖，如实列出）：
//     ① P-2 映射证据的归属正确性（属 004 预校验 + 人工证据链，DB 侧无法判定）；
//     ② actor_snapshot 内其它字段（role/school_code/username）与主体的一致性；
//     ③ AuditPrincipal 复合唯一/索引存在性（M1 已建，写入路径会暴露缺失，但本门禁不逐一断言）；
//     ④ 跨 schema 主体串味（由 scope_key = current_schema() 约束，单 schema 查询不可见）。
//
// 用法：DATABASE_URL=<管理连接串> node backend/scripts/006_audit_principal_gate.mjs [--json <out>]
// 仅读；任一租户不达标 ⇒ 打印未达标租户清单并以非零退出。
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { schemaNameOf } from '../lib/tenantClient.js'

const args = process.argv.slice(2)
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const JSON_OUT = val('--json')
const BASE_URL = process.env.DATABASE_URL
if (!BASE_URL) { console.error('需要 DATABASE_URL（只读门禁）'); process.exit(2) }
const admin = new PrismaClient({ datasources: { db: { url: BASE_URL } } })

const main = async () => {
  const rows = await admin.$queryRawUnsafe(`SELECT code, status FROM public."School" ORDER BY code`)
  const schemas = rows.map((r) => ({ code: r.code, status: r.status, schema: schemaNameOf(r.code) })).filter((r) => r.schema)
  const report = { task: 'P3-LIFECYCLE-AB-R3', gate: '006_audit_principal_gate', at: new Date().toISOString(), tenants: [], failed: [] }
  for (const t of schemas) {
    const per = { code: t.code, status: t.status, schema: t.schema, G2: null, G7: null, G8: null, systemPrincipals: null, G3_3: null, G3_4: null, ok: false, problems: [] }
    try {
      const g2 = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t.schema}"."AuditLog" WHERE "principal_id" IS NULL`)
      per.G2 = g2[0].n
      const g7 = await admin.$queryRawUnsafe(`SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id' AND a.attnum>0`, t.schema)
      per.G7 = g7[0] ? g7[0].attnotnull === true : null
      const g8 = await admin.$queryRawUnsafe(`SELECT convalidated FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=$1 AND c.conname='AuditLog_principal_id_required_new'`, t.schema)
      per.G8 = g8[0] ? g8[0].convalidated === true : null
      const sys = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t.schema}"."AuditPrincipal" WHERE kind='system'`)
      per.systemPrincipals = sys[0].n
      // R13-3：统一空快照谓词（语义空 := SQL NULL / JSONB null / 空对象）；G3③/G3④ 共用
      const SEMANTIC_EMPTY = `(a."actor_snapshot" IS NULL OR a."actor_snapshot" IN ('null'::jsonb, '{}'::jsonb))`
      const HAS_SEMANTIC = `(a."actor_snapshot" IS NOT NULL AND a."actor_snapshot" NOT IN ('null'::jsonb, '{}'::jsonb))`
      const g33 = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t.schema}"."AuditLog" a JOIN "${t.schema}"."AuditPrincipal" p ON p.id=a."principal_id" WHERE p.kind='system' AND ${HAS_SEMANTIC}`)
      per.G3_3 = g33[0].n
      const g34 = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t.schema}"."AuditLog" a JOIN "${t.schema}"."AuditPrincipal" p ON p.id=a."principal_id" WHERE p.kind='user' AND a."user_id" IS NULL AND ${SEMANTIC_EMPTY}`)
      per.G3_4 = g34[0].n
      if (per.G2 !== 0) per.problems.push(`G2：仍有 ${per.G2} 行 principal_id IS NULL`)
      if (per.G7 !== true) per.problems.push('G7：principal_id.attnotnull 非 true')
      if (per.G8 !== true) per.problems.push('G8：CHECK 缺失或未 validated')
      if (per.systemPrincipals !== 1) per.problems.push(`系统主体数=${per.systemPrincipals}（应恰 1）`)
      if (per.G3_3 !== 0) per.problems.push(`G3③：系统主体承载语义非空快照行 ${per.G3_3} 条`)
      if (per.G3_4 !== 0) per.problems.push(`G3④：无主体且语义空快照的行落到人类主体 ${per.G3_4} 条`)
      per.ok = per.problems.length === 0
    } catch (e) {
      per.problems.push(`查询失败：${String(e.message).slice(0, 120)}`)
      per.ok = false
    }
    report.tenants.push(per)
    if (!per.ok) report.failed.push(t.schema)
  }
  report.verdict = report.failed.length === 0 ? 'GATE_PASS' : 'GATE_FAIL'
  report.semantics = {
    semanticEmptySnapshot: "actor_snapshot IS NULL OR actor_snapshot IN ('null'::jsonb, '{}'::jsonb)",
    G3_3: 'kind=system 且 快照语义非空 的行数必须为 0',
    G3_4: 'kind=user 且 user_id IS NULL 且 快照语义空 的行数必须为 0',
  }
  report.limitations = [
    'P-2 映射证据归属正确性（004 预校验 + 人工证据链；DB 门禁不可判定）',
    'actor_snapshot 内其它字段与主体一致性（无断言）',
    'AuditPrincipal 复合唯一/索引存在性（由 M1 建立；本门禁不逐一断言）',
    '跨 schema 主体串味（scope_key=current_schema() 约束；单 schema 查询不可见）',
  ]
  const text = JSON.stringify(report, null, 2)
  console.log(text)
  if (JSON_OUT) fs.writeFileSync(path.resolve(JSON_OUT), text)
  await admin.$disconnect()
  if (report.failed.length) {
    console.error(`GATE_FAIL：未达标租户（禁止激活 B2）：${report.failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`GATE_PASS：全租户 ${report.tenants.length} 个均满足 G2/G7/G8/G3`)
  process.exit(0)
}
main().catch(async (e) => { console.error('006 门禁失败:', e.message); try { await admin.$disconnect() } catch { /* noop */ } process.exit(2) })
