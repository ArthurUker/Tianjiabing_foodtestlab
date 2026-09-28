// P3-W0-T02A-R1 — 共享门禁的 ESM 薄包装（逻辑仍在 db-isolation.cjs，单一实现，不复制规则）。
//
// 扩展名用 `.js`：根 package.json 为 `type: module`（Node 下即 ESM），且可被 Jest transform 转译。
// 不使用 `import.meta` / `createRequire`（Jest CJS 目标不支持前者，后者在本仓库路径含空格时易出错）。
import gate from './db-isolation.cjs'

export default gate
export const {
  CODES,
  ALLOWED_QUERY_PARAMS,
  ALLOWED_HOSTS,
  FORBIDDEN_ROLE_ATTRS,
  DEFAULT_PG_PORTS,
  FIXTURE_CONTRACT,
  IsolationError,
  checkIsolationConfig,
  assertIsolationConfigOrThrow,
  describeRefusal,
  derivedNamespace,
  verifyRuntimeIdentity,
  assertTargetAllowed,
  connectGuarded,
  createRegistry,
  cleanupRegistered,
  settleAll,
  tenantCodeFor,
  quoteIdent,
  quoteQualified,
  isBusinessLikeName,
} = gate
