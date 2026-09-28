// sync-tenant-schemas.mjs — 把全部非删除学校的租户 schema **按版本化迁移链推进到链尾**（P3-W2-T02-R2）
//
// 语义（RC-04）：
//   · 这是**唯一会写租户结构的显式命令**；服务启动（任何 AUTO_SYNC_TENANTS 取值）都只做只读证明。
//   · 结构来源 = `prisma/migrations/*`（版本化链，仅追加）；逐租户**按链顺序回放**
//     （`search_path=<schema>` 限定；文件内"扫全库"语句投影剔除并计数），每个迁移在租户台账
//     `"<schema>"."_tenant_migrations"` 记录 name / checksum / status / projection / skipped_sweeps。
//   · public 走 `prisma migrate deploy`（部署段）；本脚本只推进租户 schema，不修改 public。
//   · 六类历史库：空库（全链回放）/ 正常旧链 / runtime db push 演进库（台账缺失 → 结构见证探测
//     版本前缀 → 受控 baseline + 回放其后）/ failed（台账或 public 记录 → 阻断，不自动 resolve）/
//     曾 resolve 的库（rolled-back 且未重放 → 视为 pending）/ disabled 学校（同样纳入）。
//   · 见证不一致、部分执行、无法证明 → **fail-closed**（不 db push、不盲目 resolve、不自动 DROP 额外对象）。
//   · 失败的迁移记入台账 status='failed' + 脱敏原因；默认不自动重试，需显式 `--retry-tenant-migrations`。
//
// 用法：
//   node backend/sync-tenant-schemas.mjs                       # 推进（显式写租户结构）
//   node backend/sync-tenant-schemas.mjs --check               # **只读**证明（0=全部就绪 / 1=有阻断 / 2=配置缺失）
//   node backend/sync-tenant-schemas.mjs --retry-tenant-migrations   # 显式重试失败的迁移（人工核实后）
//   node backend/sync-tenant-schemas.mjs --rebuild-empty-schema <code>  # 受控重建（仅当该 schema 所有表为空）
// 或（package.json 已加）：`npm run db:sync`（部署 §6.55；SKIP_PRISMA_GENERATE=1 可跳过 generate）
//
// 退出码语义（0/1/2 契约不变；deploy.sh §6.55 依赖 `|| fail` 中止部署）：
//   0  全部非删除学校在链尾（--check 时 public+租户均证明通过）
//   1  任一学校/步骤失败或存在阻断（失败清单逐条打印；绝无"假成功"汇总）
//   2  配置缺失：DATABASE_URL 未设置（或 DB_SYNC_ENV_FILE 显式指向的 env 文件不存在/无效）
//
// env 文件：默认读 backend/.env（dotenv，不覆盖已存在变量）；DB_SYNC_ENV_FILE=<path> 可显式指定。

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { syncAllTenantSchemas, chainManifest, migrationChainDigest } from './lib/tenantSync.js'
import {
  provisionSchool, parseDbUrl, buildBaselineProof, baselineTenantFromProof,
  readTenantMigrationLedger, migrationClassificationRegistry, buildTenantProjection, chainManifest as _chain,
  listTenantMigrationLocks, readTenantMigrationLock, forceReleaseTenantMigrationLock, sqlExecutorInFlight,
  resolveBaselineSchoolTarget,
} from './lib/tenantProvisioner.js'
import { ensureFieldOptionSeeds } from './lib/fieldOptionService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const EXIT_OK = 0
const EXIT_SYNC_FAILED = 1
const EXIT_CONFIG_MISSING = 2
const CHECK_ONLY = process.argv.includes('--check')
const RETRY_FAILED = process.argv.includes('--retry-tenant-migrations')
const REBUILD_REQUESTED = process.argv.includes('--rebuild-empty-schema')
const argAfter = (flag) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? (process.argv[i + 1] || '') : ''
}
const BASELINE_PLAN_CODE = argAfter('--baseline-plan')
const BASELINE_APPLY_CODE = argAfter('--baseline-apply')
const EVIDENCE_PATH = argAfter('--evidence')
const FORCE_UNLOCK_CODE = argAfter('--force-unlock')
const FORCE_UNLOCK_OWNER = argAfter('--owner')
const FORCE_UNLOCK_FENCING = argAfter('--fencing')

const envFile = process.env.DB_SYNC_ENV_FILE || path.join(__dirname, '.env')
if (process.env.DB_SYNC_ENV_FILE && !fs.existsSync(envFile)) {
  console.error(`❌ db:sync 配置缺失：DB_SYNC_ENV_FILE 指向的文件不存在: ${envFile}`)
  process.exit(EXIT_CONFIG_MISSING)
}
dotenv.config({ path: envFile })

if (!process.env.DATABASE_URL || String(process.env.DATABASE_URL).trim() === '') {
  console.error('❌ db:sync 配置缺失：DATABASE_URL 未设置（backend/.env 或环境变量）；退出码 2')
  process.exit(EXIT_CONFIG_MISSING)
}
if (!/^postgres(ql)?:\/\//.test(String(process.env.DATABASE_URL).trim())) {
  console.error('❌ db:sync 配置无效：DATABASE_URL 必须以 postgresql:// 或 postgres:// 开头；退出码 2')
  process.exit(EXIT_CONFIG_MISSING)
}

const adminPassword = process.env.SEED_ADMIN_PASSWORD || process.env.SEED_OPERATOR_PASSWORD || ''
const prisma = new PrismaClient()

let exitCode = EXIT_SYNC_FAILED
try {
  const chain = chainManifest()
  console.log(`🧬 迁移链：${chain.length} 个文件；摘要 ${migrationChainDigest().slice(0, 16)}`)
  for (const m of chain) console.log(`   - ${m.name}  ${m.checksum.slice(0, 12)}  ${m.bytes}B`)

  if (CHECK_ONLY) {
    // ── 只读证明（不写任何结构）──
    const r = await syncAllTenantSchemas(prisma, { mode: 'check', log: (m) => console.log(m) })
    console.log('\n—— 迁移分类协议（作用域/语句级）——')
    for (const c of migrationClassificationRegistry()) {
      const proj = buildTenantProjection({ name: c.name, sql: fs.readFileSync(path.join(__dirname, 'prisma', 'migrations', c.name, 'migration.sql'), 'utf8'), checksum: c.checksum })
      console.log(`  scope=${proj.scope}  skip=${proj.skipped}  exec=${proj.kept}  ${c.name}`)
    }
    console.log('\n—— 逐校状态 ——')
    for (const [code, info] of Object.entries(r.schoolStatuses || {})) {
      const v = info.version || {}
      console.log(`  ${info.status.padEnd(34)} ${code}${info.schoolStatus === 'disabled' ? '(disabled)' : ''}  version=${v.at || '(none)'} applied=${v.appliedCount ?? 0}/${v.chainCount ?? chain.length} baselined=${info.migration?.baselined ?? 0}${info.migration?.pending?.length ? ` pending=${info.migration.pending.length}` : ''}`)
      for (const f of info.migration?.failed || []) console.log(`      ⛔ failed: ${f.name} — ${f.detail}`)
      for (const e of info.structure?.extraDiffs || []) console.log(`      ⚠️ 额外对象: ${e}`)
    }
    if (r.globalBlockers?.length) {
      console.log('—— 全局阻断（public 迁移层）——')
      for (const g of r.globalBlockers) console.log(`  ${g.code}${g.trafficBlocking === false ? '（不阻断流量）' : '（阻断租户流量）'} ${g.detail || ''}`)
    }
    if (r.publicExtraObjects?.extraTables?.length) {
      console.log(`—— public 未知额外表（不自动 DROP；阻断租户流量）—— ${r.publicExtraObjects.extraTables.join(', ')}`)
    }
    {
      const locks = (await listTenantMigrationLocks({ prisma })).filter((l) => l.schema_name.startsWith('school_'))
      if (locks.length) {
        console.log('—— 迁移互斥锁（崩溃锁用 --force-unlock <code> --owner <o> --fencing <n> --yes 清除：需展示过的 CAS 凭据）——')
        for (const l of locks) {
          const inFlight = await sqlExecutorInFlight({ prisma, schema: l.schema_name }).catch(() => null)
          console.log(`  ${l.schema_name} owner=${l.owner} fencing=${l.fencing_token} hostname=${l.hostname || '(未记录)'} pid=${l.pid ?? '(未记录)'} 心跳=${l.heartbeat_age_s}s 前 执行中SQL会话=${inFlight === null ? '未知' : inFlight ? '有' : '无'}`)
        }
      }
    }
    if (r.ok) {
      console.log(`\n✅ db:check 通过：${r.checked} 所学校（active+disabled）迁移台账/结构与版本化链一致（只读，未写任何结构）。`)
      exitCode = EXIT_OK
    } else {
      console.error(`\n❌ db:check 未通过：TENANT_SCHEMA_CHECK=${r.status}（globalBlockers=${(r.globalBlockers || []).map((g) => g.code).join(',') || 'none'}；blockingSchools=[${(r.blockedSchools || []).join(',')}]）`)
      console.error('   处置：npm run db:sync（逐租户版本化回放）；public 迁移问题按 runbook 人工核实（不自动 resolve、不执行结构推送）。')
      exitCode = EXIT_SYNC_FAILED
    }
  } else if (REBUILD_REQUESTED) {
    // R5 ⑤：`--rebuild-empty-schema` 的自动 DROP SCHEMA CASCADE **已撤下**（"表零行"不足以证明
    // 物化视图/序列/函数/类型/跨 schema 依赖/ACL 可安全删除，也没有失败回滚的原子边界）。
    // 人工处置 runbook：evidence/P3-W2-T02-R3/REPAIR_RUNBOOK.md
    console.error('❌ --rebuild-empty-schema 已撤下（自动 DROP SCHEMA 不再可用）。')
    console.error('   人工路径：先 `--baseline-plan <code>` 生成离线证明计划 → 按 evidence/P3-W2-T02-R3/REPAIR_RUNBOOK.md')
    console.error('   人工备份/修复（或经审批后人工重建）→ 证明通过后 `--baseline-apply <code> --evidence <plan.json>`。')
    exitCode = EXIT_SYNC_FAILED
  } else if (BASELINE_PLAN_CODE) {
    // ── 离线受控 baseline：**只读**证明计划（结构+默认值+约束+索引+未知对象+数据语义）──
    // B2：位置参数必须是**经校验的 School.code**（schema 形态 / 未知 code / staging 一律拒绝）。
    const target = await resolveBaselineSchoolTarget({ prisma, raw: BASELINE_PLAN_CODE })
    if (!target.ok) {
      console.error(`❌ --baseline-plan 目标不合法：${target.reason}`)
      console.error(`   ${target.hint}`)
      exitCode = EXIT_SYNC_FAILED
    } else {
      const { code, schema } = target
      // B1：缺契约表时**仍产出完整计划**（proofOk=false + 明确的不通过项），不崩溃、不写任何东西。
      const proof = await buildBaselineProof({ prisma, schema })
      const ledgerInfo = await readTenantMigrationLedger(prisma, schema)
      const plan = {
        kind: 'tenant-baseline-plan', at: new Date().toISOString(), school: code, schema,
        ledgerExists: ledgerInfo.exists, ledgerRows: ledgerInfo.rows.length,
        proofOk: proof.ok, proofDigest: proof.proofDigest, counts: proof.counts,
        checks: proof.checks,
        instructions: [
          '人工核对下列不通过项并按 REPAIR_RUNBOOK.md 修复（或备份后经审批重建 schema）。',
          `修复后重新生成计划：node backend/sync-tenant-schemas.mjs --baseline-plan ${code}`,
          `证明全部通过且摘要一致后：node backend/sync-tenant-schemas.mjs --baseline-apply ${code} --evidence <plan.json>`,
        ],
      }
      const outPath = argAfter('--out') || null
      if (outPath) { fs.writeFileSync(outPath, JSON.stringify(plan, null, 2)); console.log(`计划已写入 ${outPath}`) }
      console.log(`—— baseline 证明：${schema}（school.code=${code}；ledger=${ledgerInfo.exists ? `${ledgerInfo.rows.length} 行` : '缺失'}）——`)
      for (const c of proof.checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.id}${c.detail ? ` — ${c.detail}` : ''}`)
      console.log(`  proofDigest=${String(proof.proofDigest).slice(0, 24)}…  counts=${JSON.stringify(proof.counts)}`)
      if (proof.ok) { console.log('✅ 证明通过：可执行 --baseline-apply（人工动作；不执行迁移 SQL、不改结构/数据）'); exitCode = EXIT_OK }
      else { console.error('❌ 证明未通过：按上面不通过项修复后再行（当前状态**不得**记 baseline）'); exitCode = EXIT_SYNC_FAILED }
    }
  } else if (BASELINE_APPLY_CODE) {
    // ── 离线受控 baseline：**显式人工动作**（要求证明文件；现场重算且摘要一致才落台账）──
    const target = await resolveBaselineSchoolTarget({ prisma, raw: BASELINE_APPLY_CODE })
    if (!target.ok) {
      console.error(`❌ --baseline-apply 目标不合法：${target.reason}`)
      console.error(`   ${target.hint}`)
      exitCode = EXIT_SYNC_FAILED
    } else {
      const { code, schema } = target
      if (!EVIDENCE_PATH || !fs.existsSync(EVIDENCE_PATH)) {
        console.error('❌ --baseline-apply 需要 --evidence <plan.json>（由 --baseline-plan 生成）→ 拒绝（fail-closed）')
        exitCode = EXIT_SYNC_FAILED
      } else {
        let plan = null
        try {
          plan = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'))
        } catch (e) {
          console.error(`❌ 计划文件无法解析（${EVIDENCE_PATH}）：${String(e.message).slice(0, 160)} → 拒绝`)
        }
        // 计划门禁：来源/目标一致 + **证明必须通过且摘要齐备**（不通过或过期的计划不得落台账）
        if (!plan) {
          exitCode = EXIT_SYNC_FAILED
        } else if (plan.kind !== 'tenant-baseline-plan' || plan.schema !== schema || (plan.school != null && plan.school !== code)) {
          console.error(`❌ 计划文件与目标不匹配（kind=${plan.kind} school=${plan.school} schema=${plan.schema}；目标 school=${code} schema=${schema}）→ 拒绝`)
          exitCode = EXIT_SYNC_FAILED
        } else if (plan.proofOk !== true || !plan.proofDigest) {
          console.error('❌ 计划为"证明未通过"（proofOk=false）或缺少 proofDigest → 拒绝记 baseline（须先修复后重新生成计划）')
          exitCode = EXIT_SYNC_FAILED
        } else {
          // 现场重算：不通过或摘要不一致（计划过期/结构已漂移）→ 拒绝
          const live = await buildBaselineProof({ prisma, schema })
          if (!live.ok) {
            console.error('❌ 现场证明未通过（结构与数据语义未达标）→ 拒绝记 baseline')
            for (const c of live.checks.filter((c) => !c.ok)) console.error(`   ❌ ${c.id} — ${c.detail}`)
            exitCode = EXIT_SYNC_FAILED
          } else if (live.proofDigest !== plan.proofDigest) {
            console.error('❌ 计划已过期（现场摘要与计划摘要不一致）→ 拒绝记 baseline；请重新生成计划')
            exitCode = EXIT_SYNC_FAILED
          } else {
            const conn = parseDbUrl(String(process.env.DATABASE_URL).split('?')[0])
            if (!conn) { console.error('❌ DATABASE_URL 解析失败'); exitCode = EXIT_CONFIG_MISSING } else {
              // R6 ④：**先证明、后写台账**（不再预先建台账）；证明与全链写入在同一把迁移锁 + 同一事务内完成，
              // **提交前**失败 → 整体回滚（不会留下半套 baselined）；**提交后**复证失败 → 已提交（不可回滚）→ 标记 failed 待人工复核。
              const r = await baselineTenantFromProof({ prisma, conn, schema, expectedProofDigest: plan.proofDigest, log: (m) => console.log(m) })
              console.log(`✅ 离线 baseline 完成：${schema}（${r.baselined.length} 条 baselined；proof=${String(r.proofDigest).slice(0, 16)}…；指纹=${String(r.fingerprint).slice(0, 12)}…；postcheck=${r.postcheck}；锁=${r.lockOwner}#${r.fencingToken}）`)
              console.log('   语义：**提交前**（会话互斥 + 事务内结构指纹 + 前置断言）任一步失败 → 整体回滚、台账零写入；')
              console.log('        **提交后**复证通过 → 才把非终态 baseline_pending **提升**为 baselined（唯一放开阻断的写入）；')
              console.log('        复证失败或提升失败 → 台账已提交（不可回滚）且保持非终态 → 该校按 TENANT_MIGRATIONS_PENDING 持续阻断（与失败留痕是否写入无关）。')
              console.log('   后续：`--check` 复核；结构演进仍走版本化链（本条只声明"当前结构与链末一致"）。')
              exitCode = EXIT_OK
            }
          }
        }
      }
    }
  } else if (FORCE_UNLOCK_CODE) {
    // ── 人工清除崩溃锁（R6 ③ 通道；R7 ② 改为 owner+fencing **CAS**）──
    const code = FORCE_UNLOCK_CODE
    const schema = `school_${String(code).replace(/-/g, '_')}`
    const holder = await readTenantMigrationLock({ prisma, schema })
    if (!holder) {
      console.log(`ℹ️  ${schema}: 无迁移互斥锁（无需清除）`)
      exitCode = EXIT_OK
    } else {
      const inFlight = await sqlExecutorInFlight({ prisma, schema }).catch(() => null)
      console.log('—— 当前锁（**请以此行展示的 owner + fencing 作为 CAS 凭据**）——')
      console.log(`  schema=${holder.schema_name} owner=${holder.owner} fencing=${holder.fencing_token} hostname=${holder.hostname || '(未记录)'} pid=${holder.pid ?? '(未记录)'} 心跳=${holder.heartbeat_age_s}s 前`)
      console.log(`  执行中的迁移 SQL 会话：${inFlight === null ? '(探测失败/未知)' : inFlight ? '**有**（advisory 互斥被占用）' : '无'}`)
      if (inFlight === true) {
        console.error('❌ 该 schema 仍有执行中的迁移 SQL 会话（psql 子进程/PG backend 可能正在跑长 SQL）→ 拒绝清除。')
        console.error('   先确认其结束（psql 退出或 pg_terminate_backend 后 advisory 锁会自动释放）再重试。')
        exitCode = EXIT_SYNC_FAILED
      } else if (!process.argv.includes('--yes')) {
        console.error('❌ --force-unlock 需要显式 --yes 确认（请先确认该进程确已退出/失联）。')
        exitCode = EXIT_SYNC_FAILED
      } else if (!FORCE_UNLOCK_OWNER || !FORCE_UNLOCK_FENCING) {
        console.error('❌ --force-unlock 需要携带上面展示的 CAS 凭据：--owner <owner> --fencing <n>')
        console.error(`   示例：node backend/sync-tenant-schemas.mjs --force-unlock ${code} --owner ${holder.owner} --fencing ${holder.fencing_token} --yes`)
        exitCode = EXIT_SYNC_FAILED
      } else {
        // R8 ③：清除动作必须在**与执行批相同的 advisory 互斥事务**内完成（上面的 inFlight 只用于展示；
        // 真正的原子边界是下面这个 psql 单事务批：拿不到 advisory 就整体拒绝，未删除任何锁）。
        const unlockConn = parseDbUrl(String(process.env.DATABASE_URL).split('?')[0])
        if (!unlockConn) { console.error('❌ DATABASE_URL 解析失败'); exitCode = EXIT_CONFIG_MISSING }
        else {
          const r = await forceReleaseTenantMigrationLock({
            prisma, conn: unlockConn, schema,
            expectOwner: FORCE_UNLOCK_OWNER,
            expectFencingToken: Number(FORCE_UNLOCK_FENCING),
            preDeleteDelayMs: Number(process.env.TENANT_FORCE_UNLOCK_PRE_DELETE_DELAY_MS || 0),
          })
          if (r.outcome === 'RELEASED') {
            console.log(`✅ 已按 CAS 清除迁移锁 ${schema}（原子边界：${r.atomic}；owner=${r.previous?.owner} fencing=${r.previous?.fencing_token} hostname=${r.previous?.hostname || '(未记录)'} pid=${r.previous?.pid ?? '(未记录)'}）`)
            console.log('   后续：运行 npm run db:sync（逐租户版本化回放）或按 runbook 处置；该动作不清台账、不改结构。')
            exitCode = EXIT_OK
          } else if (r.outcome === 'SQL_IN_PROGRESS') {
            console.error('❌ 该 schema 仍有执行中的迁移 SQL 会话（**同一 advisory 互斥**被占用）→ 整个事务回滚，未删除任何锁。')
            console.error('   先确认会话结束（psql 退出或 pg_terminate_backend 后 advisory 自动释放）再重试。')
            exitCode = EXIT_SYNC_FAILED
          } else if (r.outcome === 'CAS_MISMATCH' || r.outcome === 'RELEASED_BY_OTHER') {
            console.error(`❌ CAS 不匹配（outcome=${r.outcome}）——**未删除任何锁**。锁可能已被原持有者释放，或已被另一执行者以新 fencing 取得。`)
            if (r.current) {
              console.error('   当前锁（请用这一行重新执行 CAS）：')
              console.error(`   schema=${r.current.schema_name} owner=${r.current.owner} fencing=${r.current.fencing_token} hostname=${r.current.hostname || '(未记录)'} pid=${r.current.pid ?? '(未记录)'} 心跳=${r.current.heartbeat_age_s}s 前`)
            } else {
              console.error('   当前已无锁行（无需清除）。')
            }
            exitCode = EXIT_SYNC_FAILED
          } else {
            console.error(`❌ 清锁批执行异常（outcome=${r.outcome}）——未删除任何锁。${r.error ? `详情：${r.error}` : ''}`)
            exitCode = EXIT_SYNC_FAILED
          }
        }
      }
    }
  } else {
    // ── 默认：显式升级（**唯一会写结构的路径**；RC-04 / P3-W2-T01-R2 契约）──
    const skipGenerate = ['1', 'true'].includes(String(process.env.SKIP_PRISMA_GENERATE || ''))
    const result = await syncAllTenantSchemas(prisma, {
      mode: 'apply', adminPassword, skipGenerate, retryFailed: RETRY_FAILED,
    })
    const mainFailures = (result.failed || []).map((f) => ({ scope: 'main', code: f.code, step: f.step, message: f.message }))

    // 逐校复核：把每校再按链回放一遍（幂等；noop 即通过）——任一失败 → 退出码 1
    console.log('\n🔍 逐校复核（台账证明 + 回放幂等；任一失败 → 退出码 1）...')
    const recheckFailures = []
    const rows = await prisma.school.findMany({ where: { status: { not: 'deleted' } }, select: { code: true } })
    for (const r of rows.filter((x) => x.code)) {
      try {
        await provisionSchool({ prisma, code: r.code, adminPassword, log: () => {}, allowExisting: true, acceptDataLoss: RETRY_FAILED })
      } catch (e) {
        const message = `${e.code ? `[${e.code}] ` : ''}${e.message}`
        console.log(`  ❌ [db:sync 复核] ${r.code} provisionSchool - ${message}`)
        recheckFailures.push({ scope: 'recheck', code: r.code, step: 'provisionSchool', message })
      }
    }
    // 终态证明（只读）：推进后必须整链一致，否则视为未完成
    const postVerify = []
    const finalCheck = await syncAllTenantSchemas(prisma, { mode: 'check', log: () => {} })
    if (finalCheck.ok !== true) {
      console.log(`  ❌ [db:sync 终态证明] 未通过：TENANT_SCHEMA_CHECK=${finalCheck.status}（blockingSchools=[${(finalCheck.blockedSchools || []).join(',')}]）`)
      postVerify.push({ scope: 'main', code: '*', step: 'postVerify', message: `推进后证明未通过：TENANT_SCHEMA_CHECK=${finalCheck.status}` })
    }
    const failures = [...mainFailures, ...recheckFailures, ...postVerify]
    if (!failures.length) {
      console.log(`\n✅ db:sync 完成：${result.total} 所非删除学校（含 disabled）均已推进到迁移链尾并落台账（主轮 ${result.succeeded}/${result.total}）。`)
      exitCode = EXIT_OK
    } else {
      const schoolItems = failures.filter((f) => f.code !== '*').length
      console.log(`\n❌ db:sync 未通过：${failures.length} 项未完成（学校 ${schoolItems} 所）→ 退出码 1`)
      for (const f of failures) console.log(`   - [${f.scope}] ${f.code} · ${f.step} · ${f.message}`)
      exitCode = EXIT_SYNC_FAILED
    }
  }

} catch (e) {
  console.error('❌ 同步失败:', e.code ? `[${e.code}] ` : '', e.message)
  exitCode = EXIT_SYNC_FAILED
} finally {
  await prisma.$disconnect().catch(() => {})
}
process.exit(exitCode)
