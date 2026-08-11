#!/usr/bin/env node
/**
 * sync-test-results-docs.mjs — 手动触发「测试结果 → docs 静态报告」同步
 *
 * 与后端自动同步共用同一引擎 backend/lib/testReportSync.js。
 * 用途：测试人员未触发自动同步 / 想立即刷新 / 归档前手动确认时运行。
 *
 * 用法：
 *   node scripts/sync-test-results-docs.mjs
 *
 * 说明：
 *   - 自动读取 backend/.env 的 DATABASE_URL（无需手动传参）；
 *   - 依赖解析以 backend/ 为基准（@prisma/client 安装在 backend/node_modules）；
 *   - 输出：docs/test-results/latest/（index.html / REPORT.md / snapshot.json / evidence/）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend')

// @prisma/client / dotenv 等依赖以 backend/ 为基准解析（backend 有独立 node_modules）
const require = createRequire(path.join(BACKEND_DIR, 'package.json'))

// 从 backend/.env 加载环境变量（仅补充未设置的，便于传参覆盖）
function loadEnvFile() {
  const f = path.join(BACKEND_DIR, '.env')
  if (!fs.existsSync(f)) return
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/)
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  } catch (e) {
    if (e.code === 'EACCES') {
      console.error(`❌ 无法读取 ${f}（权限不足）。请使用部署用户/root 运行本脚本，或通过环境变量传入 DATABASE_URL。`)
      process.exit(1)
    }
    throw e
  }
}
loadEnvFile()

if (!process.env.DATABASE_URL) {
  console.error('❌ 未找到 DATABASE_URL，请确认 backend/.env 已配置后重试。')
  process.exit(1)
}

const { PrismaClient } = require('@prisma/client')
const { syncTestResultDocs } = await import('../backend/lib/testReportSync.js')

const prisma = new PrismaClient()
try {
  const r = await syncTestResultDocs({ prisma })
  console.log(`✅ 同步完成：${r.itemCount} 项用例（${r.groupCount} 组），复制证据图片 ${r.evidenceCopied} 张`)
  console.log(`   输出目录：docs/test-results/latest/（index.html / REPORT.md / snapshot.json / evidence/）`)
} catch (e) {
  console.error('❌ 同步失败：', e?.message || e)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
