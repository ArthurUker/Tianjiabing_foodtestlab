// restoreService.js — 影子恢复引擎（P1）
//
// 目标：把备份文件恢复到目标学校 schema，且【不直接覆盖原 schema】——
// 先在临时 schema（school_<code>_restore）还原并校验，通过后再事务内原子切换（双 rename）。
// 版本漂移/数据错误只会停留在临时 schema，原数据零影响。
//
// 状态机：PREPARING → STAGING → VALIDATING → SWITCHING → COMPLETE
//                 （任一步失败 → CLEANUP（DROP 临时 schema）→ FAILED，原数据不受影响）
//
// 前提与约束：
//   - 目标学校必须已注册（public.School 存在且 status 不限，停用学校也可恢复）
//   - 恢复端 psql 版本必须 ≥ 备份端 pg_dump 版本（PG18 dump 含 \restrict，需 psql ≥ 18）
//   - 恢复是重操作：建议业务低峰执行；切换窗口毫秒级（单事务原子）
//   - 恢复操作必须由平台超管触发（路由层 requirePlatformSuperAdmin 保障）

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, assertSafeSchemaName } from './tenantClient.js'
import { verifyBackupFile } from './backupVerify.js'
import { writeAdminOpsLog } from './auditLog.js'
import { rewriteSchemaNames, extractSchemaSegment } from './restoreSqlUtils.js'

const TAG = '[restoreService]'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')

/** 探测 psql 二进制路径（与 backupService.detectPgDumpBin 同策略）。 */
export function detectPsqlBin() {
  if (process.env.PG_DUMP_BIN) return process.env.PG_DUMP_BIN.replace(/pg_dump$/, 'psql')
  try {
    const dirs = fs.readdirSync('/usr/lib/postgresql').map((v) => Number(v)).filter((v) => v > 0).sort((a, b) => b - a)
    if (dirs.length) return `/usr/lib/postgresql/${dirs[0]}/bin/psql`
  } catch { /* 非 Linux，回落 PATH */ }
  return 'psql'
}

function cleanDatabaseUrl() {
  const url = (process.env.DATABASE_URL || '').split('?')[0]
  if (!url) throw new Error(`${TAG} 缺少 DATABASE_URL`)
  return url
}

/** 执行 psql。mode='file' 用 -f 执行 SQL 文件；mode='cmd' 用 -c 执行单条命令（多语句可含 BEGIN/COMMIT）。 */
function runPsql({ sqlPath, command, log = console.log }) {
  return new Promise((resolve, reject) => {
    const args = [`--dbname=${cleanDatabaseUrl()}`, '-v', 'ON_ERROR_STOP=1']
    if (sqlPath) args.push('-f', sqlPath)
    else if (command) args.push('-c', command)
    else return reject(new Error('必须提供 sqlPath 或 command'))
    const child = spawn(detectPsqlBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`psql 失败（exit=${code}）: ${(stderr || stdout).slice(0, 800)}`))
    })
  })
}

// rewriteSchemaNames 已拆分至 ./restoreSqlUtils.js（纯函数，便于单元测试）

/**
 * 执行一次影子恢复。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma 基础单例（连 public）
 * @param {object} opts.backup BackupRun 记录（含 file_path / checksum / table_counts 等）
 * @param {string} opts.targetSchoolCode 目标学校代码
 * @param {object} [opts.actor] { userId, username, role, schoolCode, ip }（审计）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{ok: boolean, schema: string, restoreSchema: string, checks: Array<[string,string]>, error?: string}>}
 */
export async function runRestore({ prisma, backup, targetSchoolCode, actor, log = console.log }) {
  const schema = schemaNameOf(targetSchoolCode)
  if (!schema) throw new Error(`${TAG} 非法学校代码: ${targetSchoolCode}`)
  assertSafeSchemaName(schema)
  const restoreSchema = `${schema}_restore`
  assertSafeSchemaName(restoreSchema) // school_x_restore 满足 /^school_[a-z0-9_]+$/

  const checks = []
  const step = (name, msg) => { checks.push([name, msg]); log(`${TAG} ${name}: ${msg}`) }

  try {
    // ── 0. 目标 schema 必须存在（School 注册表指向的 schema）──
    const exists = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`, schema
    )
    if (!exists.length) throw new Error(`目标 schema 不存在: ${schema}（学校 ${targetSchoolCode} 未初始化）`)

    // ── 1. PREPARING：定位并加载备份文件 ──
    const aesPath = backup.file_path
    if (!aesPath || !fs.existsSync(aesPath)) throw new Error(`备份文件不存在: ${aesPath}`)
    const metaPath = aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')
    step('PREPARING', `加载备份 ${path.basename(aesPath)}`)
    const v = await verifyBackupFile(aesPath, metaPath)
    if (!v.ok) throw new Error(`备份文件验证未通过: ${v.error}`)
    const { meta, sqlText } = v
    if (meta.tableCounts && typeof meta.tableCounts === 'string') meta.tableCounts = JSON.parse(meta.tableCounts)

    // ── 2. STAGING：恢复到临时 schema ──
    // 清理可能残留的影子 schema（上次失败中断）
    await runPsql({ command: `DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE` })
    // 方案B：备份可能是全库（scope='all'，含多个租户 schema + public），
    // 恢复时只提取【目标学校】的 schema 段，其它 schema 的表/数据不进入临时 schema，
    // 保证学校侧恢复不触及其他学校数据（租户隔离底线）。
    let sqlSource = sqlText
    let expectedTables = null // 行数校验基线（null = 用 meta.tableCounts 全部）
    if (backup.scope === 'all') {
      const seg = extractSchemaSegment(sqlText, schema)
      if (!seg.trim()) throw new Error(`全库备份中未找到 schema ${schema} 的段，无法恢复`)
      sqlSource = seg
      // 全库备份的 tableCounts 覆盖所有 schema，行数校验只需比对目标 schema 的表
      const tc = meta.tableCounts || {}
      expectedTables = Object.entries(tc).filter(([k]) => k.split('.')[0] === schema)
      if (!expectedTables.length) throw new Error(`meta 中缺少 schema ${schema} 的表计数，拒绝恢复`)
      step('PREPARING', `全库备份 → 仅提取 ${schema} 段（${expectedTables.length} 张表）`)
    }
    const sql = rewriteSchemaNames(sqlSource, schema, restoreSchema)
    const tmpFile = path.join(os.tmpdir(), `restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sql`)
    await fsp.writeFile(tmpFile, sql, { mode: 0o600 })
    try {
      await runPsql({ sqlPath: tmpFile })
    } finally {
      await fsp.unlink(tmpFile).catch(() => {})
    }
    const restoredCount = expectedTables ? expectedTables.length : Object.keys(meta.tableCounts || {}).length
    step('STAGING', `已恢复 ${restoredCount} 张表到临时 schema ${restoreSchema}`)

    // ── 3. VALIDATING：行数对比（meta.tableCounts 基线 vs 影子 schema 实际行数）──
    let mismatches = []
    const countEntries = expectedTables || Object.entries(meta.tableCounts || {})
    if (countEntries.length) {
      for (const [k, expected] of countEntries) {
        const table = k.split('.').pop() // 取表名（跳过源 schema 前缀）
        try {
          const [{ count }] = await prisma.$queryRawUnsafe(
            `SELECT count(*) AS count FROM "${restoreSchema}"."${table}"`
          )
          if (Number(count) !== Number(expected)) mismatches.push(`${table}: 备份=${expected} 恢复=${count}`)
        } catch (e) {
          mismatches.push(`${table}: 校验失败 ${e.message}`)
        }
      }
      if (mismatches.length) {
        throw new Error(`行数校验不一致（${mismatches.length} 处，如 ${mismatches.slice(0, 3).join('; ')}）`)
      }
    }
    step('VALIDATING', `行数校验通过（${countEntries.length} 张表全一致）`)

    // ── 4. SWITCHING：单事务原子双 rename（零窗口）──
    const oldSchema = `${schema}_old_${Date.now()}`
    const switchSql =
      `BEGIN;` +
      `ALTER SCHEMA "${schema}" RENAME TO "${oldSchema}";` +
      `ALTER SCHEMA "${restoreSchema}" RENAME TO "${schema}";` +
      `COMMIT;`
    await runPsql({ command: switchSql })
    step('SWITCHING', `已原子切换：${schema} ← ${restoreSchema}（旧数据保留于 ${oldSchema}）`)

    // ── 5. COMPLETE：清理旧 schema ──
    // FIX-06：原实现无论 RESTORE_DROP_OLD 为何值都【只打印日志、从不真正 DROP】，导致旧 schema
    //   （school_<code>_old_<ts>）无限残留。现按环境变量语义真正执行清理：
    //   - RESTORE_DROP_OLD=drop  → 切换成功（事务已提交、新数据已生效）后立即 DROP 旧 schema，避免残留；
    //   - 其它/未设置（默认安全）→ 保留旧 schema，仅日志提示运维确认后手动清理（支持回滚）。
    const dropOld = process.env.RESTORE_DROP_OLD === 'drop'
    if (dropOld) {
      await runPsql({ command: `DROP SCHEMA "${oldSchema}" CASCADE` })
      step('COMPLETE', `恢复完成，目标 schema=${schema}（旧 schema ${oldSchema} 已清理）`)
    } else {
      log(`${TAG} 旧 schema 保留: ${oldSchema}（确认无误后手动 DROP SCHEMA "${oldSchema}" CASCADE 清理）`)
      step('COMPLETE', `恢复完成，目标 schema=${schema}，旧 schema=${oldSchema}（待人工清理）`)
    }

    // 审计（平台级操作）
    try {
      await writeAdminOpsLog(prisma, {
        action: 'backup_restore',
        actor,
        targetId: backup.id,
        targetSchoolCode,
        details: { schema, oldSchema, files: path.basename(aesPath), checkedTables: Object.keys(meta.tableCounts || {}).length },
        level: 'warn',
      })
    } catch (e) { log(`${TAG} ⚠️ 审计写入失败: ${e.message}`) }

    return { ok: true, schema, restoreSchema, oldSchema, checks }
  } catch (e) {
    // 失败清理：DROP 临时 schema（原数据零影响）
    await runPsql({ command: `DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE` }).catch(() => {})
    step('FAILED', e.message)
    try {
      await writeAdminOpsLog(prisma, {
        action: 'backup_restore_failed',
        actor,
        targetId: backup.id,
        targetSchoolCode,
        details: { schema, error: e.message },
        level: 'error',
      })
    } catch (err) { /* 忽略审计失败 */ }
    return { ok: false, schema, restoreSchema, checks, error: e.message }
  }
}
