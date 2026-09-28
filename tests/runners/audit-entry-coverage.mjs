#!/usr/bin/env node
/**
 * P3-CLOSE-B-R1（AUD-040）— 入口覆盖审计（**防漏跑**；离线、不连库）。
 *
 * 检查项（任一失败 → rc=1，fail-closed）：
 *   A. 文件集事实源唯一：`tests/runners/entry-sets.cjs` 的声明 == 独立递归枚举结果；
 *   B. root 面完备：unit ∪ db == `tests/*.test.js`；unit ∩ db == ∅；
 *   C. unit 面**零** DB 指示符（Prisma/pg/门禁/真实事务 API）→ unit 入口离线可跑的前提可审计；
 *   D. db 面每个文件**至少一条** DB 指示符（防“被误归 unit 而静默失去门禁”）；
 *   E. Jest 配置与事实源一致：unit/db 配置的 testMatch == 声明清单；**unit 配置不得有 setupFiles**（否则又回到全局门禁绑定）；db 配置必须挂门禁 setupFiles；
 *   F. package.json 脚本指向正确的配置/runner（unit/db/integration/isolation/frontend/backend）；
 *   G. backend 入口：runner 用递归枚举（任意深度），报告与旧 shell 单层 glob 的差集（漏跑风险实证）。
 *
 * 用法：node tests/runners/audit-entry-coverage.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sets = require('./entry-sets.cjs')
const ROOT = sets.ROOT
const jsonOut = process.argv.includes('--json')

const DB_INDICATORS = [
  /new\s+PrismaClient\s*\(/,
  /@prisma\/client/,
  /require\(\s*['"]pg['"]\s*\)/,
  /from\s+['"]pg['"]/,
  /\bpg\.Client\b/,
  /connectGuarded\s*\(/,
  /withVerifiedTenantTx\s*\(/,
  /TEST_DATABASE_URL/,
]

const stripComments = (src) => src
  .split('\n')
  .map((l) => (l.trim().startsWith('//') || l.trim().startsWith('*') || l.trim().startsWith('/*') ? '' : l))
  .join('\n')

const dbHits = (rel) => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  return DB_INDICATORS.filter((re) => re.test(src)).map((re) => String(re))
}

const walkWhere = (rel, predicate, acc = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) walkWhere(child, predicate, acc)
    else if (e.isFile() && predicate(e.name)) acc.push(child)
  }
  return acc.sort()
}
const walk = (rel, ext, acc = []) => walkWhere(rel, (n) => n.endsWith(ext), acc)

const results = []
const add = (name, ok, detail) => results.push({ check: name, ok, detail })
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// ── A. 事实源 vs 独立递归枚举 ──
const actualRootFlat = fs.readdirSync(path.join(ROOT, 'tests'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.js')).map((e) => `tests/${e.name}`).sort()
const actualIntegration = walk('tests/integration', '.test.js')
const actualIsolation = walk('tests/isolation', '.test.cjs')
const actualBackend = walkWhere('backend/tests', sets.isBackendEntryFile)
add('A1 entry-sets.ROOT_FLAT_ALL == tests/*.test.js', sameSet(sets.ROOT_FLAT_ALL, actualRootFlat), { declared: sets.ROOT_FLAT_ALL.length, actual: actualRootFlat.length })
add('A2 entry-sets.INTEGRATION_FILES == 递归枚举 tests/integration/**/*.test.js', sameSet(sets.INTEGRATION_FILES, actualIntegration), { declared: sets.INTEGRATION_FILES.length, actual: actualIntegration.length })
add('A3 entry-sets.ISOLATION_FILES == 递归枚举 tests/isolation/**/*.test.cjs', sameSet(sets.ISOLATION_FILES, actualIsolation), { declared: sets.ISOLATION_FILES.length, actual: actualIsolation.length })
add('A4 entry-sets.BACKEND_FILES == 递归枚举 backend/tests/**/*.test.mjs', sameSet(sets.BACKEND_FILES, actualBackend), { declared: sets.BACKEND_FILES.length, actual: actualBackend.length })

// ── B. root 面完备（unit ∪ db == root；互斥） ──
const union = [...sets.ROOT_UNIT_FILES, ...sets.ROOT_DB_FILES].sort()
add('B1 unit ∪ db == root 面', sameSet(union, sets.ROOT_FLAT_ALL), { unit: sets.ROOT_UNIT_FILES.length, db: sets.ROOT_DB_FILES.length, root: sets.ROOT_FLAT_ALL.length })
add('B2 unit ∩ db == ∅', sets.ROOT_UNIT_FILES.every((f) => !sets.ROOT_DB_FILES.includes(f)), {})
add('B3 db 清单文件均存在', sets.ROOT_DB_FILES.every((f) => fs.existsSync(path.join(ROOT, f))), { db: sets.ROOT_DB_FILES })

// ── C/D. DB 指示符分类守护 ──
const unitViolations = sets.ROOT_UNIT_FILES.map((f) => ({ f, hits: dbHits(f) })).filter((x) => x.hits.length > 0)
add('C1 unit 面零 DB 指示符（离线前提）', unitViolations.length === 0, { violations: unitViolations })
const dbMissing = sets.ROOT_DB_FILES.filter((f) => dbHits(f).length === 0)
add('D1 db 面每个文件 ≥1 DB 指示符', dbMissing.length === 0, { missing: dbMissing })

// ── E. Jest 配置一致性 ──
const unitCfg = require(path.join(ROOT, 'jest.unit.config.cjs'))
const dbCfg = require(path.join(ROOT, 'jest.db.config.cjs'))
add('E1 unit 配置 testMatch == 声明清单', sameSet(unitCfg.testMatch, sets.JEST_UNIT_TESTMATCH), { n: unitCfg.testMatch.length })
add('E2 unit 配置不得挂 DB 门禁 setup（db-isolation-setup）', !Array.isArray(unitCfg.setupFiles) || unitCfg.setupFiles.every((p) => !p.includes('db-isolation')), { setupFiles: unitCfg.setupFiles || null })
add('E3 db 配置 testMatch == 声明清单', sameSet(dbCfg.testMatch, sets.JEST_DB_TESTMATCH), { n: dbCfg.testMatch.length })
add('E4 db 配置挂门禁 setupFiles（db-isolation-setup）', Array.isArray(dbCfg.setupFiles) && dbCfg.setupFiles.some((p) => p.includes('db-isolation-setup.cjs')), { setupFiles: dbCfg.setupFiles })
add('E5 两配置 passWithNoTests=false（防空跑伪装通过）', unitCfg.passWithNoTests === false && dbCfg.passWithNoTests === false, {})
const rootCfg = require(path.join(ROOT, 'jest.config.cjs'))
add('E6 root 配置 testMatch == root 面清单（保留门禁 setupFiles）', sameSet(rootCfg.testMatch, sets.JEST_ROOT_ALL_TESTMATCH) && Array.isArray(rootCfg.setupFiles) && rootCfg.setupFiles.some((p) => p.includes('db-isolation-setup.cjs')), { n: rootCfg.testMatch.length, setupFiles: rootCfg.setupFiles })

// ── F. package.json 脚本指向 ──
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const scripts = pkg.scripts || {}
const expectScript = {
  'test:unit': 'jest.unit.config.cjs',
  'test:db': 'jest.db.config.cjs',
  'test:integration': 'tests/integration/jest.integration.config.cjs',
  'test:isolation': 'tests/isolation/jest.isolation.config.cjs',
  'test:frontend': 'jest.frontend.config.cjs',
  'test:backend': 'tests/runners/run-backend-tests.mjs',
}
const scriptProblems = Object.entries(expectScript).filter(([k, needle]) => !String(scripts[k] || '').includes(needle)).map(([k, needle]) => ({ script: k, expectedToContain: needle, actual: scripts[k] || null }))
add('F1 入口脚本指向正确配置/runner', scriptProblems.length === 0, { problems: scriptProblems })
// 顺序要求：DB 门禁面**先**跑（缺配置时 fail-closed 且零连接尝试，T02B-R2 `npm_test` 观测契约），unit 面随后。
add('F2 `npm test` = db && unit（串行；无 shell `**`；缺配置时 DB 面先拒绝）', String(scripts.test || '') === 'npm run test:db && npm run test:unit', { test: scripts.test || null })

// ── E7/E8. integration / isolation 配置的 glob 必须覆盖声明清单（含未来嵌套文件） ──
const globToRegExp = (glob) => {
  const p = glob.replace(/^<rootDir>\//, '')
  let out = ''
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { out += '(?:[^/]+/)*'; i += 2 } else { out += '.*'; i += 1 }
      } else out += '[^/]*'
    } else if ('.+^${}()|[]\\'.includes(c)) out += `\\${c}`
    else out += c
  }
  return new RegExp(`^${out}$`)
}
const unmatched = (files, patterns) => files.filter((f) => !patterns.some((pat) => globToRegExp(pat).test(f)))
const integrationCfg = require(path.join(ROOT, 'tests/integration/jest.integration.config.cjs'))
const isolationCfg = require(path.join(ROOT, 'tests/isolation/jest.isolation.config.cjs'))
add('E7 integration 配置 glob 覆盖声明清单', unmatched(sets.INTEGRATION_FILES, integrationCfg.testMatch).length === 0, { testMatch: integrationCfg.testMatch, unmatched: unmatched(sets.INTEGRATION_FILES, integrationCfg.testMatch) })
add('E8 isolation 配置 glob 覆盖声明清单', unmatched(sets.ISOLATION_FILES, isolationCfg.testMatch).length === 0, { testMatch: isolationCfg.testMatch, unmatched: unmatched(sets.ISOLATION_FILES, isolationCfg.testMatch) })

// ── G. backend 漏跑风险 ──
const missed = sets.BACKEND_FILES.filter((f) => !sets.BACKEND_SHELL_GLOB_FILES.includes(f))
add('G1 backend runner 逐文件清单非空', sets.BACKEND_FILES.length > 0, { fileCount: sets.BACKEND_FILES.length })
add('G2 旧 shell 单层 glob 差集已量化（漏跑风险可见）', true, { legacyShellGlobCount: sets.BACKEND_SHELL_GLOB_FILES.length, missedByShellGlob: missed, runnerUsesRecursiveList: true })

// ── G3. 未被任何入口覆盖的测试产物（防“新增文件静默不在任何 testMatch”） ──
const artifacts = []
const scanArtifacts = (rel) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) { scanArtifacts(child); continue }
    if (/\.(test|spec)\.[A-Za-z0-9]+$/.test(e.name)) artifacts.push(child)
  }
}
for (const d of ['tests', 'backend', 'frontend']) if (fs.existsSync(path.join(ROOT, d))) scanArtifacts(d)
const covered = new Set(sets.COVERED_FILES)
const uncovered = artifacts.filter((f) => !covered.has(f) && !sets.KNOWN_NON_ENTRY_ARTIFACTS.some((k) => k.pattern.test(f)))
const knownNonEntry = artifacts.filter((f) => !covered.has(f) && sets.KNOWN_NON_ENTRY_ARTIFACTS.some((k) => k.pattern.test(f)))
add('G3 无未被任何入口覆盖的测试产物', uncovered.length === 0, { artifacts: artifacts.length, covered: covered.size, knownNonEntry, uncovered })
add('G4 新增测试（本轮各包）已被 backend 递归枚举收录', ['backend/tests/backup/w3r2cross-register-external.unit.test.mjs', 'backend/tests/session/w1-authInfraMissing.unit.test.mjs', 'backend/tests/tenant-sync/publicInfraChain.unit.test.mjs'].every((f) => sets.BACKEND_FILES.includes(f)), {})
// G5（P3-CLOSE-B-R3 硬门禁）：backend 入口必须同时收录 *.test.mjs 与 *.unit.test.cjs；
//      CJS 合同用例不得被登记为 known-non-entry / 删除 / 改名 / skip。
const CJS_HARD_GATE = 'backend/tests/harness-check/revocation-contract.unit.test.cjs'
add('G5 backend 入口收录 *.unit.test.cjs（revocation-contract 不属 known-non-entry）', sets.BACKEND_FILES.includes(CJS_HARD_GATE) && !sets.KNOWN_NON_ENTRY_ARTIFACTS.some((k) => k.pattern.test(CJS_HARD_GATE)) && fs.existsSync(path.join(ROOT, CJS_HARD_GATE)), { patterns: sets.BACKEND_ENTRY_PATTERNS, inBackendFiles: sets.BACKEND_FILES.includes(CJS_HARD_GATE) })

const failed = results.filter((r) => !r.ok)
const report = {
  task: 'P3-CLOSE-B-R1/AUD-040',
  mode: 'entry-coverage-audit (offline, no DB)',
  entryFacts: sets.facts,
  checks: results,
  failed: failed.length,
  verdict: failed.length === 0 ? 'ENTRY_COVERAGE_OK' : 'ENTRY_COVERAGE_FAIL',
}
if (jsonOut) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.check}${r.ok ? '' : ` :: ${JSON.stringify(r.detail).slice(0, 400)}`}`)
  console.log(`\n${report.verdict}（checks=${results.length} failed=${failed.length}）`)
  console.log(`facts: ${JSON.stringify(sets.facts)}`)
}
process.exit(failed.length === 0 ? 0 : 1)
