// P3-B1B3 定点**集成**测试（真实隔离 PG；fail-closed，不 skip）
//
// 运行（隔离库必须存在且库名以 `_baseline_proof_test` 结尾）：
//   BASELINE_PROOF_TEST_DATABASE_URL=postgresql://<user>:<pwd>@127.0.0.1:5432/fs_baseline_proof_test \
//     node --test --test-concurrency=1 backend/tests/tenant-sync/b1b3-baseline-proof.integration.test.mjs
//
// 夹具与真实部署同构：`public` = 迁移链末（CLI 的参照系），探针 schema = 链前缀（生产旧结构形态，缺 AuditPrincipal）。
//
// 判别目标：
//   B1 旧结构 → `--baseline-plan` 产出**失败计划**（不崩溃）且**零写入**（不建表、不写台账）；
//      人工修复到链末后 → 计划证明通过。
//   B3 nullable 唯一列（User.email）多行 NULL → 不得报重复（真实 PG 语义），证明仍通过。
//   计划门禁：`proofOk=false` 的计划、**现场摘要不一致（过期）** 的计划，均不得 `--baseline-apply`（零台账写入）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')

const RAW_URL = String(process.env.BASELINE_PROOF_TEST_DATABASE_URL || '').split('?')[0]
const DB_NAME = (() => { try { return decodeURIComponent(new URL(RAW_URL).pathname.replace(/^\//, '')) } catch { return '' } })()

const gate = (() => {
  if (!RAW_URL) return { ok: false, reason: '缺少 BASELINE_PROOF_TEST_DATABASE_URL' }
  if (!/^postgres(ql)?:\/\//.test(RAW_URL)) return { ok: false, reason: '连接串必须以 postgresql:// 开头' }
  if (!/_baseline_proof_test$/.test(DB_NAME)) return { ok: false, reason: `库名必须以 _baseline_proof_test 结尾（实际 "${DB_NAME}"）→ 拒绝在非隔离库运行` }
  return { ok: true }
})()

if (!gate.ok) {
  test('baseline 证明集成测试：[隔离库缺失/不合规] 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[BASELINE-PROOF-REFUSED] ${gate.reason}；需 BASELINE_PROOF_TEST_DATABASE_URL（库名 *_baseline_proof_test）`)
  })
} else {
  const PROBE = 'school_b3probe'
  const CODE = 'b3probe'
  const PREFIX_BOUNDARY = '20260915120000_open_api_tables' // 此前的 11 条 = 生产旧结构形态

  const url = new URL(RAW_URL)
  const runPsql = (sql) => new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], {
      env: {
        ...process.env,
        PGHOST: url.hostname, PGPORT: url.port || '5432',
        PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: DB_NAME,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`psql rc=${code}: ${String(err || out).slice(0, 300)}`))))
    child.stdin.end(sql)
  })
  const q1 = async (sql) => Number(((await runPsql(sql)).match(/(\d+)/) || [])[1] || 0)

  const runCli = (args, extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'backend', 'sync-tenant-schemas.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: RAW_URL, SKIP_PRISMA_GENERATE: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })

  test('B1/B3 集成：旧结构失败计划（零写入）→ 修复后证明通过 → 计划门禁拒绝不通过/过期计划', async () => {
    const { PrismaClient } = await import('@prisma/client')
    const { buildBaselineProof, listMigrationFiles, buildTenantProjection, readExpectedTenantTables } = await import('../../lib/tenantProvisioner.js')

    const files = listMigrationFiles()
    assert.ok(files.length >= 16, `迁移链应至少 16 条（实际 ${files.length}）`)
    const applyRange = async (schema, list) => {
      for (const f of list) {
        const sql = fs.readFileSync(f.file, 'utf8')
        const p = buildTenantProjection({ name: f.name, sql })
        if (!p.sql.trim()) continue // @scope: public → 租户投影为空（此处按目标 schema 回放）
        await runPsql(`SET search_path TO "${schema}";\n${p.sql}`)
      }
    }
    // B4（本次**另行登记**，不属 B1–B3 修复范围）：链内 `20260726100000_add_customization_columns_if_missing`
    // 的 FieldOption 自引用外键守卫**未限定 schema** —— 任一其它 schema 已有同名约束时，后建的 schema 会
    // **静默跳过**创建该 FK（上游只对 public 侧做了前向修复）。这里仅**夹具归一**（按链内同一 DDL 补建），
    // 不改变被测证明逻辑；若上游将来修好该守卫，本归一自动变成 no-op。
    const normalizeFieldOptionFk = async (schema) => {
      const n = await q1(
        `SELECT count(*) FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace ` +
        `WHERE n.nspname='${schema}' AND t.relname='FieldOption' AND con.conname='FieldOption_parent_option_id_fkey';`)
      if (n === 0) {
        console.error(`[fixture] ${schema}: 缺 FieldOption 自引用外键（链内跨 schema 守卫缺陷 B4）→ 按迁移定义补建以归一夹具`)
        await runPsql(`SET search_path TO "${schema}"; ALTER TABLE "FieldOption" ADD CONSTRAINT "FieldOption_parent_option_id_fkey" ` +
          `FOREIGN KEY ("parent_option_id") REFERENCES "FieldOption"("id") ON UPDATE CASCADE ON DELETE CASCADE;`)
      }
    }

    const splitAt = files.findIndex((f) => f.name === PREFIX_BOUNDARY)
    assert.ok(splitAt > 0, '未找到链前缀边界')
    const prefixFiles = files.slice(0, splitAt + 1)

    const prisma = new PrismaClient({ datasources: { db: { url: RAW_URL } } })
    const tmpBad = path.join(os.tmpdir(), `b1b3-plan-bad-${process.pid}.json`)
    const tmpOk = path.join(os.tmpdir(), `b1b3-plan-ok-${process.pid}.json`)
    const ledgerCount = () => q1(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${PROBE}' AND table_name='_tenant_migrations';`)

    try {
      // ── 夹具：public = 链末参照；探针 = 链前缀（旧结构）──
      // 夹具复位（隔离库专用）：public 上的契约表先清空，保证 `public` 可从零回放链（可重复运行）。
      const dropPublic = [...readExpectedTenantTables().tables].map((t) => `DROP TABLE IF EXISTS public."${t}" CASCADE;`).join('\n')
      await runPsql(`
        DROP SCHEMA IF EXISTS "${PROBE}" CASCADE;
        CREATE SCHEMA "${PROBE}";
        ${dropPublic}
      `)
      await applyRange('public', files)
      await normalizeFieldOptionFk('public')
      await runPsql(`
        INSERT INTO public."School" ("id","code","name","status","created_at","updated_at")
        VALUES ('s-${CODE}','${CODE}','B3 探针学校','active',now(),now())
        ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name";
      `)
      await applyRange(PROBE, prefixFiles)
      await normalizeFieldOptionFk(PROBE)

      // ── B1：旧结构 → 失败计划（不崩溃、零写入）──
      const before = await q1(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${PROBE}' AND table_type='BASE TABLE';`)
      const proofOld = await buildBaselineProof({ prisma, schema: PROBE })
      const checksOld = Object.fromEntries(proofOld.checks.map((c) => [c.id, c.ok]))
      assert.equal(proofOld.ok, false, '旧结构必须证明不通过')
      assert.equal(checksOld['tables.contract.present'], false, '缺契约表必须显式不通过')
      assert.equal(checksOld['data.semantics'], false, '未扫描项必须显式不通过')
      assert.match(proofOld.checks.find((c) => c.id === 'tables.contract.present').detail, /AuditPrincipal/)
      assert.equal(
        await q1(`SELECT count(*) FROM information_schema.tables WHERE table_schema='${PROBE}' AND table_type='BASE TABLE';`), before,
        '证明必须零写入（表数不变）',
      )
      assert.equal(await ledgerCount(), 0, '证明不得创建台账')

      // ── 计划门禁①：proofOk=false 的计划不得 apply ──
      const planBad = await runCli(['--baseline-plan', CODE, '--out', tmpBad])
      assert.notEqual(planBad.code, 0, `旧结构下 --baseline-plan 必须非零退出；输出=${planBad.out.slice(-500)}`)
      assert.ok(fs.existsSync(tmpBad), '即使证明不通过，也必须产出计划文件（B1）')
      assert.equal(JSON.parse(fs.readFileSync(tmpBad, 'utf8')).proofOk, false)
      const applyBad = await runCli(['--baseline-apply', CODE, '--evidence', tmpBad])
      assert.notEqual(applyBad.code, 0, `proofOk=false 的计划必须拒绝 apply；输出=${applyBad.out.slice(-500)}`)
      assert.match(applyBad.out, /证明未通过|proofOk=false/, '必须给出明确拒绝原因')
      assert.equal(await ledgerCount(), 0, '拒绝后不得写入台账')

      // ── 人工修复：探针推进到链末 ──
      await applyRange(PROBE, files.slice(splitAt + 1))

      // ── B3：nullable 唯一列（email）多行 NULL → 不误报重复 ──
      await runPsql(`
        SET search_path TO "${PROBE}";
        INSERT INTO "User" ("id","username","password_hash","role","created_at","updated_at")
        VALUES ('u1','u1','x','manager',now(),now()), ('u2','u2','x','manager',now(),now());
      `)
      const proofFixed = await buildBaselineProof({ prisma, schema: PROBE })
      assert.equal(proofFixed.ok, true, `修复后证明必须通过；未通过=${JSON.stringify(proofFixed.checks.filter((c) => !c.ok))}`)
      assert.equal(
        Object.fromEntries(proofFixed.checks.map((c) => [c.id, c.ok]))['data.semantics'], true,
        '多行 NULL 的 nullable 唯一列不得被误报为重复（B3）',
      )

      // ── 计划门禁②：现场摘要不一致（过期/漂移）的计划不得 apply ──
      const planOk = await runCli(['--baseline-plan', CODE, '--out', tmpOk])
      assert.equal(planOk.code, 0, `结构达标后 --baseline-plan 必须通过；输出=${planOk.out.slice(-700)}`)
      assert.equal(JSON.parse(fs.readFileSync(tmpOk, 'utf8')).proofOk, true)
      await runPsql(`SET search_path TO "${PROBE}"; ALTER TABLE "User" ADD COLUMN "probe_extra" text;`) // 制造漂移
      const applyStale = await runCli(['--baseline-apply', CODE, '--evidence', tmpOk])
      assert.notEqual(applyStale.code, 0, `过期计划必须拒绝 apply；输出=${applyStale.out.slice(-500)}`)
      assert.match(applyStale.out, /现场证明未通过|计划已过期/, '必须给出明确拒绝原因')
      assert.equal(await ledgerCount(), 0, '过期计划拒绝后不得写入台账')

      // 复原：漂移消除后证明恢复通过（确认拒绝原因确为"漂移/过期"）
      await runPsql(`SET search_path TO "${PROBE}"; ALTER TABLE "User" DROP COLUMN "probe_extra";`)
      assert.equal((await buildBaselineProof({ prisma, schema: PROBE })).ok, true)
    } finally {
      await prisma.$disconnect().catch(() => {})
      for (const f of [tmpBad, tmpOk]) await fs.promises.rm(f, { force: true }).catch(() => {})
      await runPsql(`DROP SCHEMA IF EXISTS "${PROBE}" CASCADE; DELETE FROM public."School" WHERE "code"='${CODE}';`)
        .catch((e) => console.error('[cleanup] 清理失败（需人工确认）:', String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '<redacted>').slice(0, 200)))
    }
  })
}
