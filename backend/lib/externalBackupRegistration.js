// externalBackupRegistration.js — 受控**外部备份注册**（P3-W3-CROSS-REG-R1 / R9 :12,:20）
//
// 目的：把**非本实例产生**的备份产物（如灾备/源库 A 的新备份）以受控方式登记进本实例
// （目标 B）的 `BackupRun`，使其可被既有的恢复入口引用；**不**放宽 `restore-from-upload`
// 的 runId 防伪造链（本模块是独立入口，不修改该链）。
//
// 设计边界（最小受控）：
//   · 仅离线管理 CLI 或平台超管 API 调用（本模块自身不做鉴权——由入口层强制）；
//   · **来源 fail-closed（R10 :12/:19）**：必须提供**显式来源 runId**（`expectSourceRunId`；
//     CLI `--source-run-id` / API `sourceRunId` **必填**），且 `meta.runId` 必须存在并与其一致；
//     缺失/不一致/旧格式（无 runId）一律**拒绝**——不写 `external:unknown`，不默默标"来源已验证"；
//   · 产物路径必须限定在目标 `BACKUP_DIR`（rootDir）内：拒绝符号链接、路径穿越；
//   · 强校验：sha256（解密后明文 vs meta.sha256）、大小（stat vs meta.fileSize）、
//     scope/school 一致性 + **目标实例学校身份校核**（`prisma.school.findUnique`，不能仅信任
//     meta.schoolCode）、表计数与结构快照（复用 `verifyBackupFile`）；
//   · 落 `BackupRun`（`run_type='external_import'`、`created_by='external:<sourceRunId>'`）
//     与**独立审计**（`[admin-audit] backup_external_registered`）——同一事务，二者同生共死；
//   · 拒绝重复/冲突注册（`file_path` 唯一 / 同 checksum+scope+school 已注册）。
//
// 旧产物格式（无 `runId`）：**拒绝注册**（`REG_META_SOURCE_MISSING`）。若确需接入旧格式，
// 必须走独立受控方案（独立入口 + 显式人工确认 + 明确审计"来源未验证"的标记），不得复用本
// 通道伪装为已验证来源——该方案需单独评审，本模块/本包不实现。
//
// 契约说明（如实）：现有 `BackupRun` 无专用 external 来源列——本模块用 `run_type='external_import'`
// + `created_by='external:<sourceRunId>'` + 独立审计事件表达来源，**不伪装为本实例产生的备份**；
// 若未来需要 UI/契约一等公民（筛选/图标/来源字段），建议走 schema 加列（本包不改 schema）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyBackupFile } from './backupVerify.js'
import { writeAdminOpsLog } from './auditLog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')
const TAG = '[register-external-backup]'

export const EXTERNAL_RUN_TYPE = 'external_import'
export const EXTERNAL_AUDIT_ACTION = 'backup_external_registered'

/** 与 backupService.backupRootDir() 同规则（不从其 import，避免模块环）；调用方亦可显式传 rootDir。 */
export function defaultBackupRootDir() {
  return process.env.BACKUP_DIR || path.join(BACKEND_DIR, 'backups')
}

export class ExternalRegistrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ExternalRegistrationError'
    this.code = code
  }
}
const fail = (code, message) => { throw new ExternalRegistrationError(code, message) }

/** 学校代码归一（与 tenantClient.schemaNameOf 同规则：`-` → `_`）。 */
function normalizeCode(code) { return String(code).replace(/-/g, '_') }
function schemaNameOf(code) { return `school_${normalizeCode(code)}` }

/**
 * 路径安全：必须存在、非符号链接（本体）、realpath 后位于 rootDir 内（防穿越/防链接逃逸）。
 * @returns {string} realpath
 */
function assertSafeArtifactPath(p, { rootReal, label }) {
  if (!p || typeof p !== 'string') fail('REG_PATH_MISSING', `${label} 路径缺失`)
  if (!fs.existsSync(p)) fail('REG_PATH_MISSING', `${label} 不存在: ${p}`)
  const lst = fs.lstatSync(p)
  if (lst.isSymbolicLink()) fail('REG_PATH_SYMLINK', `${label} 是符号链接，拒绝（防链接逃逸/替换）: ${p}`)
  if (!lst.isFile()) fail('REG_PATH_NOT_FILE', `${label} 不是普通文件: ${p}`)
  const real = fs.realpathSync(p)
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    fail('REG_PATH_OUTSIDE_ROOT', `${label} 不在备份根目录内（拒绝路径穿越/越界）: ${real} ∉ ${rootReal}`)
  }
  return real
}

function assertMetaShape(meta) {
  if (!meta || typeof meta !== 'object') fail('REG_META_INVALID', 'meta.json 不是对象')
  if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.sha256)) {
    fail('REG_META_INVALID', 'meta.sha256 缺失或不是 64 位 hex（拒绝：无完整性基线）')
  }
  if (!Number.isInteger(meta.fileSize) || meta.fileSize <= 0) {
    fail('REG_META_INVALID', 'meta.fileSize 缺失或非正整数（拒绝：无法交叉校验大小）')
  }
  if (meta.scope !== 'all' && meta.scope !== 'single') {
    fail('REG_META_INVALID', `meta.scope 非法（${String(meta.scope)}；仅允许 all|single）`)
  }
  const tc = meta.tableCounts
  const tcObj = tc && typeof tc === 'object' && !Array.isArray(tc) ? tc : null
  if (!tcObj || Object.keys(tcObj).length === 0) {
    fail('REG_META_INVALID', 'meta.tableCounts 缺失或为空（拒绝：无行数基线，无法核对完整性）')
  }
  if (meta.scope === 'single' && (typeof meta.schoolCode !== 'string' || !meta.schoolCode.trim())) {
    fail('REG_META_INVALID', 'scope=single 但 meta.schoolCode 缺失（拒绝：无法归属学校）')
  }
  if (meta.scope === 'all' && meta.schoolCode != null && meta.schoolCode !== '') {
    fail('REG_META_INVALID', `scope=all 但 meta.schoolCode=${meta.schoolCode}（拒绝：全库备份不应带学校归属）`)
  }
  if (typeof meta.runId !== 'string' || !meta.runId.trim()) {
    fail('REG_META_SOURCE_MISSING', 'meta.runId 缺失或为空（拒绝：外部产物必须携带来源 runId；旧格式须走独立受控方案，不得标记为已验证来源）')
  }
  if (meta.countsCrossCheck && meta.countsCrossCheck.result !== 'passed') {
    fail('REG_META_INVALID', `meta.countsCrossCheck.result=${meta.countsCrossCheck.result}（备份时交叉核对未通过）`)
  }
}

/**
 * 受控注册外部备份产物。
 *
 * @param {object} p
 * @param {object} p.prisma  目标实例的 Prisma 单例（连 public）
 * @param {string} p.aesPath 产物路径（`.sql.gz.aes`）
 * @param {string} [p.metaPath] meta.json 路径（缺省：aesPath 同目录同名 `.meta.json`）
 * @param {string} [p.expectSchoolCode] 期望学校（scope=single 时必须一致；scope=all 时记录）
 * @param {string} [p.expectSourceRunId] 期望来源（meta.runId 必须一致）
 * @param {object} [p.actor] 审计 actor（API=req.user；CLI=offline 标签）
 * @param {string} [p.rootDir] 目标备份根目录（缺省 defaultBackupRootDir()）
 * @param {boolean} [p.dryRun] 只校验不落库
 * @param {(m:string)=>void} [p.log]
 * @returns {Promise<object>} { ok, dryRun, runId, scope, schoolCode, schemaName, sha256, sizeBytes, sourceRunId, verifyChecks, warnings }
 */
export async function registerExternalBackup({
  prisma,
  aesPath,
  metaPath = null,
  expectSchoolCode = null,
  expectSourceRunId = null,
  actor = null,
  rootDir = null,
  dryRun = false,
  log = () => {},
} = {}) {
  if (!prisma) fail('REG_PRISMA_REQUIRED', '缺少 prisma（目标实例连接）')
  // 来源 fail-closed：显式来源 runId 必填（CLI/API/服务层统一，落在任何文件/DB 操作之前）
  if (typeof expectSourceRunId !== 'string' || !expectSourceRunId.trim()) {
    fail('REG_SOURCE_REQUIRED', '未提供显式来源 runId（--source-run-id / sourceRunId 必填）：外部产物必须可溯源，拒绝未知来源')
  }
  const root = rootDir || defaultBackupRootDir()
  if (!fs.existsSync(root)) fail('REG_ROOT_MISSING', `备份根目录不存在: ${root}`)
  const rootReal = fs.realpathSync(root)

  const warnings = []
  // ── 1. 路径安全（aes + meta）──
  const aesReal = assertSafeArtifactPath(aesPath, { rootReal, label: '产物' })
  const metaCandidate = metaPath || aesReal.replace(/\.sql\.gz\.aes$/, '.meta.json')
  const metaReal = assertSafeArtifactPath(metaCandidate, { rootReal, label: 'meta' })
  log(`${TAG} 产物=${aesReal}`)
  log(`${TAG} meta=${metaReal}`)

  // ── 2. meta 形状 + 大小 + scope/school/来源 ──
  let meta
  try { meta = JSON.parse(fs.readFileSync(metaReal, 'utf8')) } catch (e) {
    fail('REG_META_INVALID', `meta.json 解析失败: ${e.message}`)
  }
  assertMetaShape(meta)

  const size = fs.statSync(aesReal).size
  if (size !== meta.fileSize) {
    fail('REG_META_MISMATCH', `大小不一致：文件 ${size} bytes ≠ meta.fileSize ${meta.fileSize} bytes（拒绝：防截断/拼接）`)
  }
  if (meta.scope === 'single' && expectSchoolCode &&
      normalizeCode(meta.schoolCode) !== normalizeCode(expectSchoolCode)) {
    fail('REG_META_MISMATCH', `学校不一致：meta.schoolCode=${meta.schoolCode} ≠ 期望 ${expectSchoolCode}`)
  }
  if (meta.runId !== expectSourceRunId) {
    fail('REG_META_MISMATCH', `来源不一致：meta.runId=${meta.runId} ≠ 显式来源 ${expectSourceRunId}`)
  }
  if (!meta.countsCrossCheck) warnings.push('meta.countsCrossCheck 缺失（旧格式；表计数以 verifyBackupFile 复核为准）')
  if (!meta.schemaSnapshot) warnings.push('meta.schemaSnapshot 缺失（结构快照校验降级为"缺失"提示）')

  // ── 2.5 目标实例学校身份校核（R10：不能仅信任 meta.schoolCode）──
  let schoolStatus = null
  if (meta.scope === 'single') {
    const school = await prisma.school.findUnique({ where: { code: meta.schoolCode } })
    if (!school) fail('REG_SCHOOL_UNKNOWN', `目标实例中不存在学校 code=${meta.schoolCode}（拒绝：注册目标须为本实例在册学校）`)
    if (!school.status || typeof school.status !== 'string') {
      fail('REG_SCHOOL_UNKNOWN', `学校 ${meta.schoolCode} 状态异常（status=${String(school.status)}）`)
    }
    schoolStatus = school.status
    log(`${TAG} 学校校核通过：${meta.schoolCode}（status=${schoolStatus}）`)
  }

  // ── 3. 完整性：解密 + sha256 + gunzip + 表数 + 结构快照（复用既有实现）──
  const v = await verifyBackupFile(aesReal, metaReal)
  if (!v.ok) fail('REG_VERIFY_FAILED', `产物完整性校验未通过：${v.error || 'unknown'}（${JSON.stringify(v.checks || [])}）`)
  const verifyChecks = (v.checks || []).map(([k, s]) => `${k}: ${s}`)
  log(`${TAG} 完整性校验通过（sha256/大小/scope/school/表计数/结构快照）`)

  // ── 4. 冲突/重复注册检测 ──
  const schoolCode = meta.scope === 'single' ? meta.schoolCode : null
  const schemaName = meta.scope === 'single' ? schemaNameOf(meta.schoolCode) : null
  const dupPath = await prisma.backupRun.findUnique({ where: { file_path: aesReal } })
  if (dupPath) fail('REG_DUPLICATE_PATH', `该产物路径已注册（run=${dupPath.id}）：${aesReal}`)
  const dupChecksum = await prisma.backupRun.findFirst({
    where: { checksum: meta.sha256, scope: meta.scope, school_code: schoolCode },
  })
  if (dupChecksum) fail('REG_DUPLICATE_CHECKSUM', `同 checksum+scope+school 已注册（run=${dupChecksum.id}）；拒绝重复注册`)

  const summary = {
    ok: true,
    dryRun: Boolean(dryRun),
    runId: null,
    scope: meta.scope,
    schoolCode,
    schemaName,
    sha256: meta.sha256,
    sizeBytes: size,
    sourceRunId: meta.runId,
    schoolStatus,
    snapshotMode: meta.snapshotMode || null,
    tableCount: Object.keys(meta.tableCounts).length,
    verifyChecks,
    warnings,
  }
  if (dryRun) { log(`${TAG} --dry-run：校验全部通过，未落库/未审计`); return summary }

  // ── 5. 落 BackupRun + 独立 external 审计（同一事务：同生共死）──
  const createdBy = `external:${meta.runId}`
  const rec = await prisma.$transaction(async (tx) => {
    const created = await tx.backupRun.create({
      data: {
        run_type: EXTERNAL_RUN_TYPE, // 如实标记：外部导入（非本实例产生）
        scope: meta.scope,
        schema_name: schemaName,
        school_code: schoolCode,
        file_path: aesReal,
        file_size: size,
        table_counts: meta.tableCounts,
        schema_snapshot: meta.schemaSnapshot ?? null,
        checksum: meta.sha256,
        encrypted: true,
        status: 'ok',
        verify_status: 'passed',
        created_by: createdBy,
      },
    })
    await writeAdminOpsLog(tx, {
      action: EXTERNAL_AUDIT_ACTION,
      actor: actor || { userId: null, username: 'offline-cli', role: 'offline-admin', schoolCode: null, ip: null },
      targetId: created.id,
      targetSchoolCode: schoolCode,
      details: {
        origin: 'external',
        aesPath: aesReal,
        metaPath: metaReal,
        sha256: meta.sha256,
        sizeBytes: size,
        scope: meta.scope,
        schoolCode,
        schemaName,
        schoolStatus,
        sourceRunId: meta.runId,
        snapshotMode: meta.snapshotMode || null,
        tableCount: Object.keys(meta.tableCounts).length,
        verify: 'passed',
        warnings,
      },
      level: 'warn',
    })
    return created
  })

  summary.runId = rec.id
  log(`${TAG} ✅ 已注册外部备份：run=${rec.id}（run_type=${EXTERNAL_RUN_TYPE}，scope=${meta.scope}${schoolCode ? `，school=${schoolCode}` : ''}）`)
  log(`${TAG} 审计：${EXTERNAL_AUDIT_ACTION}（sourceRunId=${meta.runId}）`)
  return summary
}
