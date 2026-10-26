// 日志中心（2026-10-22）· 无 DB 单测：
//   ① 分类派生规则（device/auth/security/admin/system）
//   ② 失败日志窗口聚合（首条落库 + 窗口内重复只累加 repeat_count）
//   ③ 保留策略读写（文件）+ 压缩/清理（dryRun 与实删）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { deriveLogCategory, writeSystemLog } from '../../lib/auditLog.js'
import { writeAggregatedLog, resetLogAggregator, DEFAULT_WINDOW_MS } from '../../lib/logThrottle.js'
import {
  readRetention, writeRetention, applyRetention, compressCategory, DEFAULT_RULES, categoryWhere,
} from '../../lib/logRetention.js'

// ─────────── ① 分类派生 ───────────
test('分类派生：设备/认证/安全/平台操作/系统 五类各自归位', () => {
  assert.equal(deriveLogCategory({ actionType: 'pathogen_device_upload_ok' }), 'device')
  assert.equal(deriveLogCategory({ actionType: 'pathogen_device_denied' }), 'device')
  assert.equal(deriveLogCategory({ actionType: 'pathogen_platform_key_create' }), 'device')
  assert.equal(deriveLogCategory({ actionType: 'openapi_call' }), 'openapi')
  assert.equal(deriveLogCategory({ actionType: 'openapi_denied' }), 'openapi')
  assert.equal(deriveLogCategory({ actionType: 'disk_logs_delete' }), 'admin')
  assert.equal(deriveLogCategory({ actionType: 'backup_run' }), 'admin')
  assert.equal(deriveLogCategory({ actionType: 'log_retention_run' }), 'admin')
  assert.equal(deriveLogCategory({ message: '[admin-audit] user_delete target=x' }), 'admin')
  assert.equal(deriveLogCategory({ message: 'SECURITY:REFRESH_TOKEN_REPLAY ip=1.2.3.4' }), 'security')
  assert.equal(deriveLogCategory({ actionType: 'login_success' }), 'auth')
  assert.equal(deriveLogCategory({ actionType: 'refresh_token' }), 'auth')
  assert.equal(deriveLogCategory({ actionType: 'something_else', level: 'error' }), 'system')
})

test('writeSystemLog：未显式给 category 时自动补进 context（并保留 canonical 键）', async () => {
  const rows = []
  const prisma = { systemLog: { async create({ data }) { rows.push(data); return { id: 'l1', ...data } } } }
  await writeSystemLog(prisma, { level: 'info', message: 'PATHOGEN_DEVICE_UPLOAD_OK X', context: { action_type: 'pathogen_device_upload_ok', device_no: 'D1' } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].context.category, 'device')
  assert.equal(rows[0].context.device_no, 'D1')
  assert.ok(rows[0].context.ts, 'canonical ts 必须补齐')
  // 显式指定则不覆盖
  await writeSystemLog(prisma, { level: 'warn', message: 'whatever', context: { action_type: 'x', category: 'security' } })
  assert.equal(rows[1].context.category, 'security')
})

// ─────────── ② 窗口聚合 ───────────
function aggStub() {
  const rows = new Map()
  let seq = 0
  return {
    rows,
    prisma: {
      systemLog: {
        async create({ data }) { const id = `r${++seq}`; rows.set(id, { id, ...data }); return { id, ...data } },
        async update({ where, data }) { const r = rows.get(where.id); if (!r) throw new Error('not found'); Object.assign(r, data); return r },
      },
    },
  }
}

test('窗口聚合：同 key 首条落库，窗口内重复只累加 repeat_count（不新增行）', async () => {
  resetLogAggregator()
  const { prisma, rows } = aggStub()
  const ctx = { action_type: 'pathogen_device_denied', category: 'device', code: 'RATE_LIMITED', ip: '1.1.1.1' }

  const a = await writeAggregatedLog(prisma, { key: '1.1.1.1|RATE_LIMITED', message: 'PATHOGEN_DEVICE_DENIED RATE_LIMITED', context: ctx, flushMs: 0 })
  assert.equal(a.aggregated, false)
  assert.equal(rows.size, 1)
  assert.equal([...rows.values()][0].context.repeat_count, 1)

  // 窗口内连续 3 次重复：不插新行
  for (let i = 0; i < 3; i++) {
    const r = await writeAggregatedLog(prisma, { key: '1.1.1.1|RATE_LIMITED', message: 'PATHOGEN_DEVICE_DENIED RATE_LIMITED', context: ctx, flushMs: 0 })
    assert.equal(r.aggregated, true)
  }
  assert.equal(rows.size, 1, '窗口内不得新增行')
  assert.equal([...rows.values()][0].context.repeat_count, 4, '次数必须累计，不能丢')
  assert.equal([...rows.values()][0].context.category, 'device')

  // 不同 key（不同错误码）→ 独立成行
  await writeAggregatedLog(prisma, { key: '1.1.1.1|VALIDATION_ERROR', message: 'PATHOGEN_DEVICE_DENIED VALIDATION_ERROR', context: { ...ctx, code: 'VALIDATION_ERROR' } })
  assert.equal(rows.size, 2)
})

test('窗口聚合：窗口过期后重新插新行（不把历史压成一行）', async () => {
  resetLogAggregator()
  const { prisma, rows } = aggStub()
  const ctx = { category: 'device', code: 'X' }
  await writeAggregatedLog(prisma, { key: 'k', message: 'm', context: ctx, windowMs: 10 })
  await new Promise((r) => setTimeout(r, 25))
  await writeAggregatedLog(prisma, { key: 'k', message: 'm', context: ctx, windowMs: 10 })
  assert.equal(rows.size, 2)
  assert.equal(DEFAULT_WINDOW_MS, 60_000)
})

// ─────────── ③ 保留策略 ───────────
test('保留策略读写：默认值 → 修改 → 落盘 → 再读回（含非法值归一）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logret-'))
  const file = path.join(dir, 'log-retention.json')
  process.env.LOG_RETENTION_FILE = file
  try {
    const d = readRetention()
    assert.deepEqual(d.rules, DEFAULT_RULES)
    assert.equal(d.auto, true)

    writeRetention({ rules: { device: { retentionDays: 30, compressAfterDays: 7 } }, auto: false })
    const r = readRetention()
    assert.equal(r.rules.device.retentionDays, 30)
    assert.equal(r.rules.device.compressAfterDays, 7)
    assert.equal(r.rules.openapi.retentionDays, 180, '开放接口默认保留 180 天')
    assert.equal(r.rules.admin.retentionDays, 0, '未提交的分类保持默认（平台操作永久）')
    assert.equal(r.auto, false)
    assert.ok(fs.existsSync(file))

    // 负数/非数字 → 不回滚用户配置，保留当前值（路由层会先 400 拦掉非法输入）
    writeRetention({ rules: { device: { retentionDays: -5, compressAfterDays: 'abc' } } })
    assert.equal(readRetention().rules.device.retentionDays, 30)
    assert.equal(readRetention().rules.device.compressAfterDays, 7)
  } finally {
    delete process.env.LOG_RETENTION_FILE
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function retentionStub() {
  const now = Date.now()
  const day = 86400_000
  const rows = [
    { id: 'old-device-1', level: 'warn', message: 'PATHOGEN_DEVICE_DENIED RATE_LIMITED', context: { category: 'device', code: 'RATE_LIMITED', repeat_count: 5 }, created_at: new Date(now - 40 * day) },
    { id: 'old-device-2', level: 'warn', message: 'PATHOGEN_DEVICE_DENIED RATE_LIMITED', context: { category: 'device', code: 'RATE_LIMITED', repeat_count: 3 }, created_at: new Date(now - 40 * day) },
    { id: 'ancient-device', level: 'info', message: 'PATHOGEN_DEVICE_UPLOAD_OK', context: { category: 'device' }, created_at: new Date(now - 200 * day) },
    { id: 'fresh-device', level: 'info', message: 'PATHOGEN_DEVICE_UPLOAD_OK', context: { category: 'device' }, created_at: new Date(now - 1 * day) },
  ]
  const match = (r, where = {}) => {
    if (where.created_at?.lt && !(r.created_at < where.created_at.lt)) return false
    if (where.created_at?.gte && !(r.created_at >= where.created_at.gte)) return false
    if (where.level?.in && !where.level.in.includes(r.level)) return false
    const catEq = where.context?.path?.[0] === 'category' ? where.context.equals : undefined
    if (catEq !== undefined && r.context.category !== catEq) return false
    if (where.NOT?.context?.path?.[0] === 'rollup' && r.context.rollup === where.NOT.context.equals) return false
    return true
  }
  let seq = 0
  return {
    rows,
    prisma: {
      systemLog: {
        async create({ data }) { const row = { id: `roll-${++seq}`, ...data }; rows.push(row); return row },
        async findMany({ where }) { return rows.filter((r) => match(r, where)) },
        async count({ where }) { return rows.filter((r) => match(r, where)).length },
        async deleteMany({ where }) {
          const hit = where.id?.in ? rows.filter((r) => where.id.in.includes(r.id)) : rows.filter((r) => match(r, where))
          for (const h of hit) rows.splice(rows.indexOf(h), 1)
          return { count: hit.length }
        },
      },
    },
  }
}

test('保留与压缩：dryRun 只统计不改数据；实跑先聚合成 rollup 行再删明细，最后删超期明细', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logret-'))
  process.env.LOG_RETENTION_FILE = path.join(dir, 'log-retention.json')
  try {
    writeRetention({ rules: { device: { retentionDays: 90, compressAfterDays: 30 } } })
    const { prisma, rows } = retentionStub()

    // dryRun：40 天前的两条失败明细会被压缩成 1 组；200 天前的 1 条会被删；数据不变
    const before = rows.length
    const dry = await applyRetention(prisma, { dryRun: true })
    assert.equal(rows.length, before, 'dryRun 不得改数据')
    assert.equal(dry.categories.device.rollupGroups, 1, '两条同码同日 → 1 个汇总组')
    assert.equal(dry.categories.device.compressedRows, 2)

    // 实跑：生成 rollup 行（count 累加 repeat_count）→ 删明细 → 删超期
    const run = await applyRetention(prisma, { dryRun: false })
    assert.equal(run.categories.device.willDelete, 1, '200 天前那条被保留期清除')
    const rollup = rows.find((r) => r.context?.rollup === true)
    assert.ok(rollup, '必须留下日汇总行')
    assert.equal(rollup.context.count, 8, '5 + 3 次重复都必须计入汇总')
    assert.equal(rollup.context.category, 'device')
    assert.ok(!rows.find((r) => r.id === 'old-device-1'), '明细已删')
    assert.ok(rows.find((r) => r.id === 'fresh-device'), '未过期的明细必须保留')
  } finally {
    delete process.env.LOG_RETENTION_FILE
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('压缩：无 compressAfterDays 的分类直接跳过；categoryWhere 对 system 兼容旧行', async () => {
  const { prisma } = retentionStub()
  const r = await compressCategory(prisma, 'admin', { compressAfterDays: 0 })
  assert.deepEqual(r, { scanned: 0, rollups: 0, deleted: 0 })
  assert.deepEqual(categoryWhere('system'), { context: { path: ['category'], equals: 'system' } })
  assert.deepEqual(categoryWhere('all'), {})
})


test('聚合器：窗口到期时把最终计数/指标刷回旧行，再开新行（不丢尾数）', async () => {
  resetLogAggregator()
  const { prisma, rows } = aggStub()
  const ctx = { category: 'openapi', code: 'OK' }
  // 默认 flushMs 很大，模拟「突发后长时间无新事件」的场景
  for (let i = 0; i < 3; i++) {
    await writeAggregatedLog(prisma, { key: 'k2', message: 'm', context: ctx, metrics: { sum_rows: 2 }, windowMs: 20, flushMs: 999999 })
  }
  assert.equal(rows.size, 1)
  assert.equal([...rows.values()][0].context.repeat_count, 1, '未刷新的行仍停在首条计数')

  await new Promise((r) => setTimeout(r, 30))
  await writeAggregatedLog(prisma, { key: 'k2', message: 'm', context: ctx, metrics: { sum_rows: 2 }, windowMs: 20, flushMs: 999999 })
  assert.equal(rows.size, 2, '新窗口必须开新行')
  const oldRow = [...rows.values()][0]
  assert.equal(oldRow.context.repeat_count, 3, '旧行在到期时必须刷回最终次数')
  assert.equal(oldRow.context.sum_rows, 6, '指标同理刷回最终值')
  assert.ok(oldRow.context.last_seen_at)
})
