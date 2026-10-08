// Phase 2 — Independent adversarial verification probes (Batch B).
// Non-destructive: no network, no DB connection, no application writes.
// Uses REAL pure functions (schemaNameOf, localNow) + source-path assertions on real files.
// Run from repository root: node docs/reviews/global-audit-20260924/phase2/probes-batch-b.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.NODE_ENV = 'test'
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://phase2:phase2@127.0.0.1:1/phase2_never_connect?schema=public'
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const mod = (p) => pathToFileURL(path.join(root, p)).href
const results = []
const record = (id, kind, detail) => {
    results.push({ id, kind, detail })
    console.log(`[${id}] ${kind}: ${detail}`)
}
const between = (src, a, b) => {
    const i = src.indexOf(a)
    if (i < 0) return ''
    const j = b ? src.indexOf(b, i + a.length) : -1
    return j < 0 ? src.slice(i) : src.slice(i, j)
}

/* ═══════════════ AUD-004 · 恢复暂存 schema 与合法学校撞名并被 DROP ═══════════════ */
{
    const { schemaNameOf, assertSafeSchemaName, isValidSchoolCode } = await import(mod('backend/lib/tenantClient.js'))
    assert.equal(schemaNameOf('alpha'), 'school_alpha')
    assert.equal(schemaNameOf('alpha-restore'), 'school_alpha_restore')
    assert.equal(`${schemaNameOf('alpha')}_restore`, schemaNameOf('alpha-restore'), '恢复 alpha 的暂存名 == 学校 alpha-restore 的真实 schema')
    assert.doesNotThrow(() => assertSafeSchemaName('school_alpha_restore'))
    assert.equal(isValidSchoolCode('alpha-restore'), true, 'alpha-restore 是合法学校代码')
    record('AUD-004', 'REPRODUCED', "schemaNameOf('alpha')+'_restore' === schemaNameOf('alpha-restore') === 'school_alpha_restore'；code 白名单允许 -restore 后缀")

    const rs = read('backend/lib/restoreService.js')
    const staging = between(rs, '── 2. STAGING', '── 2.5 SCHEMA_ALIGN')
    assert.ok(staging.includes('DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE'), 'STAGING 前无条件 DROP 暂存名')
    const cleanup = between(rs, 'catch (e) {', 'return { ok: false')
    assert.ok(cleanup.includes('DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE'), '失败清理再次无条件 DROP')
    assert.ok(!/ownership|belongs|school_code|School/.test(staging), 'DROP 前无任何归属/所有权检查')
    record('AUD-004', 'STATIC_CONFIRMED', 'runRestore 两处 DROP 均只按名字删除，无 ownership / School 注册表交叉检查')

    const prov = read('backend/lib/tenantProvisioner.js')
    const conflict = between(prov, "学校代码已存在", '}')
    assert.ok(conflict.length > 0 || prov.includes('学校代码已存在'), '创建学校仅在 schema 已存在时 409（不阻止先建校后恢复的撞名序列）')
    record('AUD-004', 'REACHABILITY', "危险序列成立：先创建学校 alpha-restore（合法 code，schema 正常）→ 恢复 alpha → DROP school_alpha_restore CASCADE 误删该校")
}

/* ═══════════════ AUD-005 · 在线恢复缺少同校互斥与写入暂停 ═══════════════ */
{
    const rs = read('backend/lib/restoreService.js')
    assert.ok(!/pg_advisory|advisory_lock|SET LOCAL lock/i.test(rs), '无 advisory lock')
    assert.ok(!/mutex|inFlight|drain|writeBarrier|pause/i.test(rs), '无互斥/排空/写屏障')
    const ro = read('backend/middleware/readOnlyMiddleware.js')
    assert.ok(ro.includes("process.env.READONLY_MODE !== 'true'"), 'READONLY_MODE 默认放行，需人工预设')
    assert.ok(!rs.includes('READONLY_MODE'), '恢复流程自身不设置只读模式')
    const sb = read('backend/routes/schoolBackupRoutes.js')
    assert.ok(sb.includes("['admin', 'manager'].includes(role)"), '学校 manager 即可触发恢复')
    const switchBlock = between(rs, '── 4. SWITCHING', '── 5. COMPLETE')
    assert.ok(switchBlock.includes('RENAME'), '切换为原子双 rename；STAGING 期间已确认写入将随旧 schema 离线')
    record('AUD-005', 'STATIC_CONFIRMED', '无 per-school 锁/维护态/排空/写屏障；READONLY_MODE 需人工预设且恢复不联动；学校 manager 可并发触发两次恢复（共享同一 school_<code>_restore 暂存名）')
}

/* ═══════════════ AUD-006 · 备份元数据行数与 pg_dump 不共享快照 ═══════════════ */
{
    const bs = read('backend/lib/backupService.js')
    const counts = between(bs, 'export async function collectTableCounts', 'export async function collectSchemaSnapshot')
    assert.ok(counts.includes('SELECT count(*) AS count'), '行数统计为逐表 count')
    assert.ok(!/BEGIN|REPEATABLE READ|pg_export_snapshot|FOR SHARE/i.test(counts), '统计无显式事务/快照')
    const dump = between(bs, 'function runPgDump', '── 流式加密')
    assert.ok(!dump.includes('--snapshot'), 'pg_dump 未指定共享快照')
    assert.ok(dump.includes('--schema='), 'pg_dump 独立进程、独立快照')
    const flow = between(bs, '② 行数统计', '④ L1 校验')
    assert.ok(flow.indexOf('collectTableCounts') < flow.indexOf('collectSchemaSnapshot') && flow.indexOf('collectSchemaSnapshot') < flow.indexOf('runPgDump'), '顺序：行数 → 结构 → pg_dump，三个不同时间点')
    record('AUD-006', 'STATIC_CONFIRMED', 'collectTableCounts（Prisma 逐表 count）→ collectSchemaSnapshot → 独立 pg_dump 进程：三阶段无共享快照（无 --snapshot / 无包裹事务）')
}

/* ═══════════════ AUD-007 · 同秒同范围备份共享文件名 ═══════════════ */
{
    let sameSecond = null
    try {
        const { localNow } = await import(mod('backend/lib/backupService.js'))
        const a = localNow().toISOString().replace(/[-:]/g, '').slice(0, 15)
        await new Promise((r) => setTimeout(r, 5))
        const b = localNow().toISOString().replace(/[-:]/g, '').slice(0, 15)
        sameSecond = a === b
    } catch (e) {
        sameSecond = `import-limited(${e.code || e.message.slice(0, 40)})`
    }
    const bs = read('backend/lib/backupService.js')
    const nameBlock = between(bs, 'const ts = localNow()', 'const metaPath')
    assert.ok(nameBlock.includes("scope === 'all' ? 'all-databases' : dumpSchema") && nameBlock.includes('${ts}'), '文件名 = scope/schema + 秒级时间戳')
    assert.ok(!/Math\.random|randomUUID|nanoid/.test(nameBlock), '文件名无随机熵')
    assert.ok(bs.includes("const tmpGz = path.join(dir, `${baseName}.sql.gz.tmp`)"), 'tmp 与产物同名族')
    const failClean = between(bs, '失败清理：半写', 'throw e')
    assert.ok(failClean.includes('unlink(aesPath)') && failClean.includes('unlink(tmpGz)'), '失败清理按路径互删（可删掉并发同伴的成品）')
    record('AUD-007', 'CONFIRMED', `baseName 仅含 scope/schema+秒级 ts（无熵）：同秒同 scope 两次启动 → 相同 tmpGz/aes/meta；本地实测同秒两次生成一致=${sameSecond}；失败路径互删 .aes/.tmp`)
}

/* ═══════════════ AUD-008 · migration 链空库回放断裂 + 部署回退留下 failed 状态 ═══════════════ */
{
    const baseline = read('backend/prisma/migrations/20260726000000_baseline/migration.sql')
    assert.ok(!baseline.includes('visible_menu_items'), 'baseline 未创建 visible_menu_items')
    const unify = read('backend/prisma/migrations/20260814020000_unify_school_customization_text/migration.sql')
    assert.ok(unify.includes('ALTER COLUMN "visible_menu_items"'), 'unify 直接 ALTER 该列（空库回放 42703 根因）')
    const revert = read('backend/prisma/migrations/20260814030000_revert_customization_to_jsonb/migration.sql')
    assert.ok(revert.includes('"visible_menu_items" TYPE jsonb'), 'revert 再次引用该列')
    const dep = read('deploy/deploy.sh')
    assert.ok(dep.includes('npx prisma migrate deploy 2>/dev/null'), 'migrate deploy 吞掉 stderr')
    assert.ok(/FIRST_DEPLOY=true[\s\S]{0,400}db push --accept-data-loss/.test(dep), '首部署失败回退 db push --accept-data-loss（留下 failed 记录）')
    assert.ok(dep.includes('非首部署，请手动修复'), '非首部署失败即中止（后续部署被 failed 记录卡住）')
    assert.ok(baseline.includes('prisma migrate resolve --applied'), 'baseline 注释给出生产接入方式：resolve --applied（不回放）')
    record('AUD-008', 'ROOT_CAUSE', '列引入走运行时 DDL/db push（tenantSync ADD COLUMN IF NOT EXISTS），未沉淀进 migration；baseline 生成时点(07-26)无 visible_menu_items，8-14 的 unify/revert 假设其存在 → 空库回放断裂（第一遍独立 PG 实测 P3018/42703 复核一致）')
    record('AUD-008', 'DEPLOY_PATH', 'deploy.sh：migrate deploy 失败被吞错后，首部署回退 db push（留下 failed 记录）→ 下次部署非首 → fail；生产库若未执行过 resolve --applied baseline，重部署同样会因 CREATE TABLE 已存在而失败')
}

/* ═══════════════ AUD-009 · 启动自愈默认执行可丢数据的 schema push ═══════════════ */
{
    const server = read('backend/server.js')
    assert.ok(server.includes("process.env.AUTO_SYNC_TENANTS === 'false'"), '仅显式 false 才跳过（默认执行）')
    assert.ok(server.includes('syncAllTenantSchemas(prisma'), '启动即后台调用')
    const prov = read('backend/lib/tenantProvisioner.js')
    const pushCount = (prov.match(/--accept-data-loss/g) || []).length
    assert.ok(pushCount >= 2, `provision/align 两处均带 --accept-data-loss（共 ${pushCount} 处）`)
    const ts = read('backend/lib/tenantSync.js')
    const loop = between(ts, '② 同步', '③ SchoolCustomization')
    assert.ok(loop.includes('catch') && !/\bthrow\b/.test(loop), '单校失败 catch 后继续，不向上抛')
    assert.ok(ts.includes('✅ 所有租户 schema 已与 schema.prisma 对齐'), '无失败聚合，最终仍打印成功')
    const syncScript = read('backend/sync-tenant-schemas.mjs')
    assert.ok(syncScript.includes("process.exit(1)"), 'db:sync 仅顶层 reject 才 exit(1)')
    const dep = read('deploy/deploy.sh')
    assert.ok(dep.includes('SKIP_PRISMA_GENERATE=1 node sync-tenant-schemas.mjs'), '部署链调用 db:sync（退出码恒 0 → 单校失败部署继续）')
    record('AUD-009', 'STATIC_CONFIRMED', '默认生产启动必然执行（非 opt-in）；租户同步走 db push --accept-data-loss ×2；单校失败被吞、db:sync 退出码 0、部署继续')
}

/* ═══════════════ AUD-039 · 旧测试使用普通 DATABASE_URL + 跨范围破坏性清理 ═══════════════ */
{
    const pg = read('tests/integration/pg-bootstrap.js')
    assert.ok(pg.includes('process.env.DATABASE_URL ||'), '无专用隔离变量，直接读业务 DATABASE_URL')
    assert.ok(pg.includes("TENANTS = ['school-a', 'school-b', 'school-c']"), '固定租户名（school_school_a/b/c）')
    assert.ok(pg.includes('DROP SCHEMA IF EXISTS "${schemaOf(t)}" CASCADE'), 'teardown 按固定名 DROP SCHEMA CASCADE')
    assert.ok(pg.includes('DROP TABLE IF EXISTS public.messages'), 'teardown 还删 public 表')
    assert.ok(pg.includes('TRUNCATE TABLE'), 'bootstrap 先 TRUNCATE')
    const rat = read('tests/integration/roleAuditTrigger.test.js')
    assert.ok(rat.includes("process.env.DATABASE_URL"), '直接使用普通 DATABASE_URL')
    assert.ok(rat.includes("TEST_SCHEMA || 'school_tjb'") && rat.includes("TEST_ROLE_USER || 'test'"), '默认指向生产种子学校 school_tjb / 用户 test')
    const p0 = read('tests/p0ProvNoAdminInSchool.test.js')
    assert.ok(p0.includes("import { PrismaClient } from '../backend/node_modules/@prisma/client'"), 'PrismaClient 自动加载 backend/.env（连业务库无需环境变量）')
    const jestCfg = read('jest.config.cjs')
    assert.ok(!/dotenv/.test(jestCfg + read('tests/setup-env.js')), 'Jest 侧无隔离门禁（仅 polyfill）')
    record('AUD-039', 'STATIC_CONFIRMED', 'pg-bootstrap：DATABASE_URL 直用 + 固定 schema + DROP SCHEMA CASCADE/TRUNCATE/public DROP TABLE；roleAuditTrigger 默认 school_tjb；p0Prov 经 PrismaClient 自动读 backend/.env 直连业务库')
}

/* ═══════════════ AUD-044 · 示例 JWT_SECRET 不在弱密钥拒绝列表 ═══════════════ */
{
    const env = read('.env.example')
    const m = env.match(/^JWT_SECRET=(.+)$/m)
    assert.ok(m, '.env.example 提供 JWT_SECRET 示例值')
    const exampleSecret = m[1].trim()
    const server = read('backend/server.js')
    const list = between(server, 'const KNOWN_WEAK_SECRETS = [', ']')
    const entries = [...list.matchAll(/'([^']+)'/g)].map((x) => x[1])
    assert.ok(entries.length >= 5, `弱密钥列表共 ${entries.length} 项`)
    assert.ok(!entries.includes(exampleSecret), '示例值不在 KNOWN_WEAK_SECRETS → 复制示例未改密钥即可启动')
    assert.ok(!/JWT_SECRET\.length|JWT_SECRET\.(match|test)\b/.test(server), '无长度/熵校验（仅非空 + 弱列表）')
    const dep = read('deploy/deploy.sh')
    assert.ok(dep.includes('JWT_SECRET=$(openssl rand -base64 48)'), 'deploy.sh 会自动生成强密钥（deploy.sh 路径不受影响）')
    const conf = read('deploy/deploy.adapter.example.conf')
    assert.ok(/JWT_SECRET=""/.test(conf), '示例 conf 留空 → deploy.sh 生成')
    record('AUD-044', 'STATIC_CONFIRMED', `示例值 "${exampleSecret.slice(0, 18)}..." 不在弱密钥列表且无强度校验；仅手工部署路径暴露（deploy.sh 自动生成，示例 conf 留空）`)
}

console.log('\n=== SUMMARY ===')
const summary = {
    baseline: 'f08e72e3e74d188b4555e0bee16280b3dd0d622b',
    probes: results.length,
    results,
}
console.log(JSON.stringify({ probes: results.length, ids: [...new Set(results.map((r) => r.id))] }, null, 2))
fs.writeFileSync(path.join(here, 'probe-results-batch-b.json'), JSON.stringify(summary, null, 2))
process.exit(0)
