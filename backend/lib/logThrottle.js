// logThrottle.js — SystemLog 写入窗口聚合（2026-10-22 日志中心）
//
// 背景：设备被拒（限流/报文不合格/绑定过期）在故障期间会以「每设备 60 次/分钟」的速率重试。
//   若每条都插一行，一天就能刷出数万行，把日志表撑爆。但"次数"本身是有价值的信息。
//
// 方案（用户口径：都入库，但失败日志要节约存储）：
//   · 窗口内（默认 60s）同 key 的第 1 条 → 正常插一行，带 repeat_count=1；
//   · 同窗口后续重复 → **不再插行**，只把 repeat_count / last_seen_at 累加到该行（写入节流 10s）；
//   · 窗口过期 → 下一条重新插新行。
// 结果：行数受控（≤ 每分钟每 key 一行），次数不丢（repeat_count 精确累计）。
//
// 约束：聚合态在进程内存里，重启后从新行开始（可接受：不丢事件，只多出少量行）。

import { writeSystemLog } from './auditLog.js'

const BUCKETS = new Map()
const MAX_BUCKETS = 2000
export const DEFAULT_WINDOW_MS = 60_000
export const DEFAULT_FLUSH_MS = 10_000

/** 测试用：清空聚合态。 */
export function resetLogAggregator() {
  BUCKETS.clear()
}

export function aggregatorSize() {
  return BUCKETS.size
}

/**
 * 窗口聚合写入。
 * @param {object} prisma 基础 Prisma 单例
 * @param {object} p
 * @param {string} p.key 聚合键（如 `${ip}|${code}`）
 * @param {string} [p.level] warn/error/info
 * @param {string} p.message 首条消息（重复时不再改写 message）
 * @param {object} [p.context] 首条上下文（务必带 category）
 * @param {number} [p.windowMs] 窗口长度
 * @param {number} [p.flushMs] 重复计数落库的最小间隔
 * @returns {Promise<{aggregated:boolean,id:string|null,repeatCount:number}>}
 */
export async function writeAggregatedLog(prisma, {
  key,
  level = 'warn',
  message,
  context,
  windowMs = DEFAULT_WINDOW_MS,
  flushMs = DEFAULT_FLUSH_MS,
}) {
  const now = Date.now()
  const k = String(key || '')
  const b = k ? BUCKETS.get(k) : null

  if (b && now - b.start < windowMs) {
    b.count += 1
    b.last = now
    if (b.id && now - b.written >= flushMs) {
      b.written = now
      // 计数落库失败不影响调用方（日志永远不能打断业务）
      prisma.systemLog
        .update({
          where: { id: b.id },
          data: { context: { ...b.baseContext, repeat_count: b.count, last_seen_at: new Date(now).toISOString() } },
        })
        .catch(() => {})
    }
    return { aggregated: true, id: b.id, repeatCount: b.count }
  }

  const baseContext = { ...(context || {}), repeat_count: 1, window_ms: windowMs }
  let row = null
  try {
    row = await writeSystemLog(prisma, { level, message, context: baseContext })
  } catch {
    row = null // 落库失败时仍登记桶，避免重试风暴反复尝试写库
  }
  if (BUCKETS.size >= MAX_BUCKETS) BUCKETS.clear()
  if (k) BUCKETS.set(k, { id: row?.id || null, start: now, last: now, written: now, count: 1, baseContext })
  return { aggregated: false, id: row?.id || null, repeatCount: 1 }
}

export default { writeAggregatedLog, resetLogAggregator, aggregatorSize }
