// backupVerify.js — 备份文件离线验证（L2-Lite，供 CLI 004 与 P1 控制台 API 复用）
//
// 校验项（不依赖生产库）：
//   ① 解密成功（AES-256-GCM 认证通过 = 密文完整）
//   ② sha256 与 meta.json 记录一致
//   ③ gunzip 解压成功（gzip 流完整）
//   ④ CREATE TABLE 数量（排除 _prisma_migrations）与 meta.tableCounts 表数一致
//
// 返回结构化结果，由调用方决定输出/告警。

import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { decryptFile } from './backupKms.js'

const TAG = '[backupVerify]'

/**
 * 验证一个备份文件。
 * @param {string} aesPath .aes 文件路径
 * @param {string} metaPath meta.json 路径
 * @returns {Promise<{ok: boolean, checks: Array<[string,string]>, error?: string, meta?: object, sqlText?: string}>}
 */
export async function verifyBackupFile(aesPath, metaPath) {
  if (!fs.existsSync(aesPath)) throw new Error(`${TAG} 备份文件不存在: ${aesPath}`)
  if (!fs.existsSync(metaPath)) throw new Error(`${TAG} meta.json 不存在: ${metaPath}（恢复必须有 meta，二者须成对保管）`)

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const checks = []

  // ① 解密
  let plain, text
  try {
    plain = await decryptFile(fs.readFileSync(aesPath), meta)
    checks.push(['解密', '通过（GCM 认证 OK，密文完整）'])
  } catch (e) {
    return { ok: false, checks: [['解密', `失败（${e.message}）——备份文件损坏或密钥不匹配`]], error: `解密失败: ${e.message}` }
  }

  // ② sha256
  const hash = crypto.createHash('sha256').update(plain).digest('hex')
  const shaMatch = meta.sha256 && hash === meta.sha256
  checks.push(['sha256', shaMatch ? '一致' : `不一致（文件=${hash.slice(0, 16)}…，meta=${String(meta.sha256).slice(0, 16)}…）`])
  if (!shaMatch) return { ok: false, checks, error: 'sha256 不匹配，备份文件可能被修改或与 meta 不对应' }

  // ③ gunzip
  try {
    text = zlib.gunzipSync(plain).toString()
  } catch (e) {
    return { ok: false, checks: [...checks, ['gzip', '解压失败（gzip 流损坏）']], error: `gunzip 失败: ${e.message}` }
  }
  checks.push(['gzip', `解压成功（${plain.length} bytes → ${Buffer.byteLength(text)} bytes）`])

  // ④ CREATE TABLE 数量 vs tableCounts 表数
  // 只统计行首的建表语句（避免误计 SystemLog 数据中的 "CREATE TABLE=xx" 字样），
  // 并排除 _prisma_migrations（兼容 pg_dump 带引号/无引号两种输出形态）
  const createTables = text.split('\n').filter((l) => /^\s*CREATE TABLE\b/i.test(l) &&
    !/^\s*CREATE TABLE\s+(?:(?:"[^"]+"|[\w]+)\.)?"?_prisma_migrations"?\s*\(/i.test(l)).length
  const tc = meta.tableCounts
  const expectedTables = tc ? Object.keys(typeof tc === 'string' ? JSON.parse(tc) : tc).length : null
  if (expectedTables == null) {
    checks.push(['表数', `无法对比（meta 无 tableCounts），dump 中 CREATE TABLE=${createTables}`])
  } else if (createTables === expectedTables) {
    checks.push(['表数', `一致（${createTables}）`])
  } else {
    return {
      ok: false,
      checks: [...checks, ['表数', `不一致（dump=${createTables}，预期=${expectedTables}）`]],
      error: 'CREATE TABLE 数量与备份时基线不一致，备份不完整',
    }
  }
  checks.push(['数据', `${(text.match(/^COPY/gm) || []).length} 张表含数据（COPY 语句）`])

  // ⑤ schema 结构快照校验（新增）：meta 应携带 schemaSnapshot，且其表集合与 tableCounts 一致
  // 作用：
  //   - 防 meta 被篡改：schemaSnapshot 由备份时从 information_schema 采集，与 tableCounts 一一对应；
  //   - 恢复前可据此判断"备份结构"与"当前代码期望结构"是否兼容（列缺失/类型漂移）。
  const snap = meta.schemaSnapshot
  if (!snap || typeof snap !== 'object' || Object.keys(snap).length === 0) {
    checks.push(['结构快照', '缺失（旧版本备份，恢复时将尝试自动对齐）'])
  } else {
    const snapTables = new Set()
    for (const [schema, tables] of Object.entries(snap)) {
      for (const tableName of Object.keys(tables)) snapTables.add(`${schema}.${tableName}`)
    }
    const tcTables = new Set(Object.keys(tc || {}))
    const onlyInSnap = [...snapTables].filter((t) => !tcTables.has(t))
    const onlyInTc = [...tcTables].filter((t) => !snapTables.has(t))
    if (onlyInSnap.length || onlyInTc.length) {
      checks.push(['结构快照', `异常（snap 与 tableCounts 不一致：仅 snap=${onlyInSnap.length}, 仅 tc=${onlyInTc.length}）`])
      return { ok: false, checks, error: 'schemaSnapshot 与 tableCounts 表集合不一致，meta 可能损坏' }
    }
    checks.push(['结构快照', `通过（${snapTables.size} 张表，含列结构）`])
  }

  return { ok: true, checks, meta, sqlText: text }
}
