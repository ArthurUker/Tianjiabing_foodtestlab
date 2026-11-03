/**
 * 设备原始报文归档（2026-11-03，方案 B）单元测试
 * 覆盖：写入/读回、gzip、sha256、超限不归档、路径穿越防护、过期清理
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import 模块前设置，模块在加载时读取环境变量
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-archive-'))
process.env.DEVICE_PAYLOAD_DIR = TMP
process.env.DEVICE_PAYLOAD_MAX_BYTES = '4096'
process.env.DEVICE_PAYLOAD_RETENTION_DAYS = '90'

const { archiveDevicePayload, readArchivedPayload, pruneArchivedPayloads, PAYLOAD_DIR } =
  await import('../../lib/devicePayloadArchive.js')

const payload = {
  DeviceNo: '20250106010005',
  ChipNumber: '20261022010042',
  DetectionNumber: '1',
  SampleStr: '一食堂 餐盘涂抹样',
  DetectionDateTime: '2026-11-03 09:00:00',
}

test('归档写入 → 读出内容完全一致（gzip 往返）', async () => {
  const r = await archiveDevicePayload({ payload, schoolCode: 'tjb', deviceNo: payload.DeviceNo, chipNumber: payload.ChipNumber, status: 200, code: 'OK' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(r.path.startsWith(PAYLOAD_DIR), '应落在归档目录内')
  assert.equal(r.bytes, Buffer.byteLength(JSON.stringify(payload)))
  assert.ok(r.gzBytes < r.bytes, 'gzip 后应更小')
  assert.match(r.sha256, /^[0-9a-f]{64}$/)

  const text = await readArchivedPayload(r.path)
  assert.deepEqual(JSON.parse(text), payload, '读回内容必须与原始报文一致')
})

test('文件名包含芯片号/状态/业务码，按天分目录', async () => {
  const r = await archiveDevicePayload({ payload, chipNumber: 'CHIP-X1', status: 403, code: 'DEVICE_BINDING_EXPIRED' })
  assert.ok(r.ok)
  const rel = r.path.slice(PAYLOAD_DIR.length + 1)
  assert.match(rel, /^\d{4}-\d{2}-\d{2}[\\/]/, '应按 年-月-日 分目录')
  assert.ok(rel.includes('CHIP-X1'), '文件名应含芯片号')
  assert.ok(rel.includes('403') && rel.includes('DEVICE_BINDING_EXPIRED'), '应含状态与业务码')
})

test('超过大小上限 → 不归档，返回 too_large（不影响主流程）', async () => {
  const big = { ...payload, OptimizationDataLists: { 'FAM-1': Array.from({ length: 2000 }, (_, i) => i) } }
  const r = await archiveDevicePayload({ payload: big, status: 200, code: 'OK' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too_large')
  assert.ok(r.bytes > 4096)
})

test('读取越界路径 → 拒绝（防路径穿越）', async () => {
  await assert.rejects(() => readArchivedPayload('/etc/passwd'), /非法归档路径/)
  await assert.rejects(() => readArchivedPayload(path.join(TMP, '..', 'x.json.gz')), /非法归档路径/)
})

test('清理：超过保留天数的日目录被删除，新的保留', async () => {
  const oldDir = path.join(TMP, '2000-01-01')
  await fs.mkdir(oldDir, { recursive: true })
  await fs.writeFile(path.join(oldDir, 'x.json.gz'), 'old')
  const past = new Date('2000-01-01T00:00:00Z')
  await fs.utimes(oldDir, past, past)

  const dry = await pruneArchivedPayloads({ days: 90, dryRun: true })
  assert.ok(dry.removed >= 1, 'dry-run 也应统计出待删除')
  assert.ok(await fs.stat(oldDir).then(() => true).catch(() => false), 'dry-run 不得真的删除')

  const real = await pruneArchivedPayloads({ days: 90 })
  assert.ok(real.removed >= 1)
  assert.equal(await fs.stat(oldDir).then(() => true).catch(() => false), false, '过期目录应被删除')
  // 今天写入的目录必须还在
  const today = new Date()
  const todayDir = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  assert.ok(await fs.stat(path.join(TMP, todayDir)).then(() => true).catch(() => false), '当天目录不得删除')
})
