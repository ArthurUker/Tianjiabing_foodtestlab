'use strict'
/**
 * P3-CLOSE-B-R1（AUD-040）— 各测试入口的**唯一文件集事实源**（CommonJS，供 Jest 配置与审计 runner 复用）。
 *
 * 目的：入口不再依赖 shell `**` 展开（`sh` 下 `**` ≡ `*`，只匹配一层；顶层文件或两层嵌套会**静默漏跑**），
 * 改为「Node 递归枚举 + 显式路径清单」：配置里的 testMatch 是逐文件绝对化路径，runner 把逐文件路径直接
 * 交给 `node --test`。任何新增文件若未被分类，`tests/runners/audit-entry-coverage.mjs` 会失败（fail-closed）。
 *
 * 分类（AUD-040）：
 *   · ROOT_UNIT_FILES —— 离线 unit 面（**不需要** PG、**不挂** DB 门禁 setupFiles）；
 *   · ROOT_DB_FILES   —— root 面里需要真库的文件（显式清单；缺 TEST_* 由门禁非零拒绝）；
 *   · ROOT_FLAT_ALL   —— 两者之并 = 现行 root Jest 语义（`tests/*.test.js`），用于等价性核对。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

const listFlat = (rel, ext) => fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(ext))
  .map((e) => e.name)
  .sort()

/** 递归枚举（覆盖任意深度；不依赖 shell glob）。 */
const walkDirWhere = (rel, predicate, acc = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) walkDirWhere(child, predicate, acc)
    else if (e.isFile() && predicate(e.name)) acc.push(child)
  }
  return acc.sort()
}
const walkDir = (rel, ext, acc = []) => walkDirWhere(rel, (n) => n.endsWith(ext), acc)

/**
 * P3-CLOSE-B-R3 硬门禁修复：backend 入口必须同时收录 `*.test.mjs` **与** `*.unit.test.cjs`
 * （node:test 原生即可运行 CJS；`backend/tests/harness-check/revocation-contract.unit.test.cjs` 属公共链/夹具合同用例，
 * 既非 known-non-entry、也不得删除/改名/skip）。旧 shell 单层 glob 只匹配 `.test.mjs` → 该类文件会被静默漏跑。
 */
const isBackendEntryFile = (name) => name.endsWith('.test.mjs') || name.endsWith('.unit.test.cjs')

/** 现行 `backend/tests/**\/*.test.mjs` 在 `sh` 下的真实语义（= 单层 `backend/tests/*\/*.test.mjs`），仅用于缺口对照。 */
const shellSingleLevel = (rel, ext) => {
  const out = []
  for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    for (const f of fs.readdirSync(path.join(ROOT, `${rel}/${d.name}`), { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(ext)) out.push(`${rel}/${d.name}/${f.name}`)
    }
  }
  return out.sort()
}

const ROOT_FLAT_ALL = listFlat('tests', '.test.js').map((f) => `tests/${f}`)
// P3-CLOSE-B-R2：integration/isolation 也改**递归**枚举（新增嵌套文件不再漏出声明清单；两配置的 glob 本就能匹配任意深度）
const INTEGRATION_FILES = walkDir('tests/integration', '.test.js')
const ISOLATION_FILES = walkDir('tests/isolation', '.test.cjs')
const BACKEND_FILES = walkDirWhere('backend/tests', isBackendEntryFile)
/** 旧脚本语义（`node --test … backend/tests/**\/*.test.mjs`，shell 单层 + 仅 .mjs）——仅用于漏跑对照。 */
const BACKEND_SHELL_GLOB_FILES = shellSingleLevel('backend/tests', '.test.mjs')

/**
 * 非 npm/Jest 入口承载的测试产物（**显式登记**，须给出理由；新增未登记者 → 审计失败）。
 * 这些不是 node:test/Jest 用例，故不进入任何 testMatch；它们由 deploy 窗口人工运行。
 */
const KNOWN_NON_ENTRY_ARTIFACTS = Object.freeze([
  { pattern: /^backend\/tests\/security\/deploy-(jwt-flow|env-fault-injection|distribution-lifecycle)\.test\.sh$/, reason: 'shell 脚本式部署冒烟（无 node:test/Jest 入口；由部署窗口按文档人工运行）' },
])

/**
 * root 面中需要真库的文件（**显式**清单）。
 * 守护：audit-entry-coverage 对 unit 面做 DB 指示符扫描（必须 0 命中）并对本清单做非 0 命中校验；
 * 出现新的真库文件而未登记 → 审计失败，必须先在此处分类。
 */
const ROOT_DB_FILES = Object.freeze(['tests/p0ProvNoAdminInSchool.test.js'])
const ROOT_UNIT_FILES = Object.freeze(ROOT_FLAT_ALL.filter((p) => !ROOT_DB_FILES.includes(p)))

const asMatch = (pathsArr) => pathsArr.map((p) => `<rootDir>/${p}`)

module.exports = {
  ROOT,
  ROOT_FLAT_ALL,
  ROOT_UNIT_FILES,
  ROOT_DB_FILES,
  INTEGRATION_FILES,
  ISOLATION_FILES,
  BACKEND_FILES,
  BACKEND_SHELL_GLOB_FILES,
  isBackendEntryFile,
  BACKEND_ENTRY_PATTERNS: ['**/*.test.mjs', '**/*.unit.test.cjs'],
  KNOWN_NON_ENTRY_ARTIFACTS,
  /** 所有入口的文件并集（用于“未被任何入口覆盖的测试产物”审计）。 */
  COVERED_FILES: [...new Set([...ROOT_FLAT_ALL, ...INTEGRATION_FILES, ...ISOLATION_FILES, ...BACKEND_FILES])].sort(),
  // Jest testMatch（显式逐文件；无通配 → 无 shell/CWD 依赖）
  JEST_UNIT_TESTMATCH: asMatch(ROOT_UNIT_FILES),
  JEST_DB_TESTMATCH: asMatch(ROOT_DB_FILES),
  JEST_ROOT_ALL_TESTMATCH: asMatch(ROOT_FLAT_ALL),
  facts: {
    rootFlatAll: ROOT_FLAT_ALL.length,
    rootUnit: ROOT_UNIT_FILES.length,
    rootDb: ROOT_DB_FILES.length,
    integration: INTEGRATION_FILES.length,
    isolation: ISOLATION_FILES.length,
    backendRecursive: BACKEND_FILES.length,
    backendShellGlob: BACKEND_SHELL_GLOB_FILES.length,
  },
}
