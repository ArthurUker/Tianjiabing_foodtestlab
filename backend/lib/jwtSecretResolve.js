/**
 * P3-W0-T01-R1 — JWT 配置"选择段"（CLI 与测试共用；deploy §5.1 经 CLI 调用同一代码）。
 *
 * 语义（总控确定）：
 *  - 来自真实进程环境（含适配文件合并结果）的字符串**已经是有效值**，不再按 dotenv 去引号/删注释。
 *  - 来自旧 `.env` 文件的值必须先经共享子集解析器得到**运行时有效值**，再进入同一强度规则。
 *  - 优先级：非空环境值 > 旧文件有效值 > （且仅当确实缺失时）生成。
 *  - 文件不存在 = 无文件值（允许首次部署）；不可读 / 解析失败 / 重复键 / 歧义 = 明确拒绝，
 *    绝不当成"缺失"从而触发非预期轮换。
 *  - deployWrite=true 时额外做部署表示检查（未加引号写回 .env 的无损性），该检查**不**作用于
 *    直接进程环境的合法值。
 *
 * 本模块不读 process.env（值由调用方传入）、不连接任何服务，可在依赖安装前用 node 运行。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { validateJwtConfig, parseJwtEnvFileContent, assertDeploySerializable } from './jwtSecretConfig.js'

export const RESOLVE_EXIT = { OK: 0, REJECTED: 1, USAGE_OR_FILE: 2 }

const isNonEmptyString = (v) => typeof v === 'string' && v !== ''

/**
 * @param {{
 *   envAccess?: unknown, envRefresh?: unknown,
 *   envFilePath?: string | null,
 *   allowGenerate?: boolean, deployWrite?: boolean,
 *   generateAccess?: () => string,
 * }} [input]
 * @returns {{
 *   ok: boolean, exitCode: number, errors: Array<{field:string, code:string, reason:string}>,
 *   accessSecret?: string, effectiveRefreshSecret?: string, refreshSource?: 'explicit'|'derived',
 *   generatedAccess?: boolean, sourceTrace: object,
 * }} 失败分支不含任何秘密内容。
 */
export function resolveJwtConfig({
    envAccess,
    envRefresh,
    envFilePath = null,
    allowGenerate = false,
    deployWrite = false,
    generateAccess = () => crypto.randomBytes(48).toString('base64'),
} = {}) {
    const sourceTrace = { envAccessUsed: false, envRefreshUsed: false, fileAccessUsed: false, fileRefreshUsed: false, filePresent: false }

    // ── 1) 旧文件有效值解析 ──
    let fileValues = {}
    if (envFilePath) {
        let content = null
        try {
            content = fs.readFileSync(envFilePath, 'utf8')
            sourceTrace.filePresent = true
        } catch (e) {
            if (e && e.code === 'ENOENT') {
                // 文件不存在：等价于"没有旧文件值"，允许后续生成
            } else {
                return {
                    ok: false,
                    exitCode: RESOLVE_EXIT.USAGE_OR_FILE,
                    errors: [{ field: 'JWT_SECRET', code: 'ENV_FILE_UNREADABLE', reason: `cannot read env file (${(e && e.code) || (e && e.name) || 'UNKNOWN'})` }],
                    sourceTrace,
                }
            }
        }
        if (content !== null) {
            const parsed = parseJwtEnvFileContent(content)
            if (!parsed.ok) {
                return {
                    ok: false,
                    exitCode: RESOLVE_EXIT.USAGE_OR_FILE,
                    errors: parsed.errors.map((x) => ({ field: x.key || 'JWT_SECRET', code: x.code, reason: x.reason })),
                    sourceTrace,
                }
            }
            fileValues = parsed.values
        }
    }

    // ── 2) 选择（非空环境值 > 文件有效值 > 缺省）──
    sourceTrace.envAccessUsed = isNonEmptyString(envAccess)
    sourceTrace.envRefreshUsed = isNonEmptyString(envRefresh)
    sourceTrace.fileAccessUsed = !sourceTrace.envAccessUsed && isNonEmptyString(fileValues.JWT_SECRET)
    sourceTrace.fileRefreshUsed = !sourceTrace.envRefreshUsed && isNonEmptyString(fileValues.JWT_REFRESH_SECRET)

    let access = sourceTrace.envAccessUsed ? envAccess : (sourceTrace.fileAccessUsed ? fileValues.JWT_SECRET : undefined)
    const refresh = sourceTrace.envRefreshUsed ? envRefresh : (sourceTrace.fileRefreshUsed ? fileValues.JWT_REFRESH_SECRET : undefined)

    // ── 3) 确实缺失才生成 ──
    let generatedAccess = false
    if (access === undefined) {
        if (!allowGenerate) {
            return {
                ok: false,
                exitCode: RESOLVE_EXIT.REJECTED,
                errors: [{ field: 'JWT_SECRET', code: 'MISSING', reason: 'access secret is missing and generation is not allowed in this mode' }],
                sourceTrace,
            }
        }
        access = generateAccess()
        generatedAccess = true
    }

    // ── 4) 共享强度校验 ──
    const validated = validateJwtConfig({ accessSecret: access, refreshSecret: refresh })
    if (!validated.ok) {
        return { ok: false, exitCode: RESOLVE_EXIT.REJECTED, errors: validated.errors, generatedAccess, sourceTrace }
    }

    // ── 5) 部署表示检查（仅写回路径）──
    if (deployWrite) {
        const targets = [{ field: 'JWT_SECRET', value: validated.accessSecret }]
        if (validated.refreshSource === 'explicit') {
            targets.push({ field: 'JWT_REFRESH_SECRET', value: validated.effectiveRefreshSecret })
        }
        for (const t of targets) {
            const check = assertDeploySerializable(t.value, { field: t.field })
            if (!check.ok) {
                return {
                    ok: false,
                    exitCode: RESOLVE_EXIT.REJECTED,
                    errors: [{ field: check.field, code: check.code, reason: check.reason }],
                    generatedAccess,
                    sourceTrace,
                }
            }
        }
    }

    return {
        ok: true,
        exitCode: RESOLVE_EXIT.OK,
        errors: [],
        accessSecret: validated.accessSecret,
        effectiveRefreshSecret: validated.effectiveRefreshSecret,
        refreshSource: validated.refreshSource,
        generatedAccess,
        sourceTrace,
    }
}
