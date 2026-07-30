/**
 * SECURITY:* 安全事件最小告警闭环（第六轮·检查项 2）
 *
 * 背景：logSecurityEvent 把 REVOCATION_WRITE_FAILED / REFRESH_TOKEN_REPLAY /
 * REFRESH_CONCURRENT_ROTATION / TENANT_SCHEMA_MISMATCH 等事件以
 * `SECURITY:<CODE>` 前缀写入 public.SystemLog（level=error），但此前全库
 * 没有任何读取方（仅 seed.js 一处无关的幂等检查）——属于「写了但沉睡」
 * 的第三个死代码点（前两个：logFailedLogin、must_change_password）。
 *
 * 本模块提供最小可行的主动推送：
 *   - 定时扫描（默认每 5 分钟）SystemLog 中新增的 SECURITY:* 事件；
 *   - 有新增 → console.error 高声汇总（journald/journalctl 可采集），并在配置了
 *     SECURITY_ALERT_WEBHOOK_URL 时推送企业微信群机器人兼容格式
 *     （{msgtype:'text',text:{content}}；钉钉自定义机器人同构，亦可直接使用）；
 *   - 扫描游标仅存进程内存：进程重启后回看 LOOKBACK_MS（默认 1h），宁可重报不漏报；
 *   - 所有异常吞掉并告警自身（告警系统故障绝不能影响业务可用性）。
 *
 * 环境变量：
 *   SECURITY_ALERT_WEBHOOK_URL   企业微信/钉钉机器人 webhook（不配则仅 console.error）
 *   SECURITY_ALERT_INTERVAL_MS   扫描间隔（默认 300000 = 5min）
 *   SECURITY_ALERT_LOOKBACK_MS   启动回看窗口（默认 3600000 = 1h）
 *   SECURITY_ALERT_DISABLED=true 完全关闭（测试/本地开发）
 *
 * ⚠️【架构限制声明 · 单实例假设】⚠️
 * 本模块假设【单实例运行】（当前部署形态：deploy.sh 写入的 systemd 单进程，
 * 见 deploy/README.md "进程托管：systemd（已确定不用 PM2）"）。
 * 扫描游标（state.lastScanAt，即"已处理到哪条 SystemLog"）保存在【进程内存】，
 * 未落共享存储。若未来切换为 PM2 cluster 模式或多机部署：
 *   - 每个实例会各自独立扫描同一张 public.SystemLog 并各自推送 →
 *     同一批安全事件被重复告警 N 次（N=实例数），造成告警疲劳，
 *     长期反而掩盖真正需要关注的信号；
 *   - 【改造要求】必须先把扫描游标改造为共享存储协调，推荐方案：
 *     数据库租约表（如 alert_scanner_lease：id / holder_id / lease_expires_at，
 *     用 INSERT ... ON CONFLICT DO UPDATE ... WHERE lease_expires_at < NOW()
 *     原子抢占过期租约，仅持有者执行扫描+推送，TTL 取扫描间隔的 2-3 倍并定期续约）。
 * 触发条件与详细说明见 deploy/README.md「已知限制」一节。
 * 这与本项目一贯原则同源：跨请求/跨进程判断状态的数据（token 吊销、登录失败计数）
 * 必须放数据库或 Redis 等共享存储，不能用进程内存 Map/变量。
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000
const MAX_EVENTS_PER_SCAN = 200

/**
 * 事件码 → 运维处置注释（第三步·告警可辨识度增强）。
 * 目的：让运维在收到告警时能快速判断处理优先级，而非把所有 SECURITY 事件一视同仁。
 * 特别是区分「REFRESH_CONCURRENT_ROTATION（30s 良性并发宽限）」与
 * 「REFRESH_TOKEN_REPLAY（宽限期外真重放，已触发全量吊销）」：
 * 前者通常是多标签页正常刷新；但若攻击者恰在合法刷新后 30s 内重放窃取的 token，
 * 也会被归入前者——故文案中明确提示"单用户频次异常升高需核查"。
 */
const EVENT_NOTES = {
  REFRESH_TOKEN_REPLAY:
    '⛔ 高优先级：宽限期外的 refresh token 重放（已触发该用户全量会话吊销）。'
    + '疑似 token 泄露，请立即核查该用户近期登录 IP 与设备（SystemLog context 含 userId/ip/jti）。',
  REFRESH_CONCURRENT_ROTATION:
    'ℹ️ routine：多标签页正常刷新行为（30s 良性并发宽限期内），通常无需人工介入。'
    + '⚠️ 注意：若攻击者恰在合法用户刷新后 30s 内重放窃取的 token，也会落入此类而不触发全量吊销；'
    + '若短时间内单用户此类事件频次异常升高，建议核查其 SystemLog context（userId/ip/jti）。',
  REVOCATION_WRITE_FAILED:
    '⛔ 高优先级：吊销记录写入失败，相关会话可能无法被强制下线，请检查数据库可用性。',
  TENANT_SCHEMA_MISMATCH:
    '⛔ 高优先级：JWT 租户与请求 schema 不匹配，可能为越权访问尝试，请核查来源 IP。',
}

/**
 * 扫描一次并（如有新事件）推送告警。可注入 fetchImpl/logger 便于单元测试。
 * @returns {Promise<{scanned: number, alerted: boolean}>}
 */
export async function scanAndAlertSecurityEvents(prisma, state, {
  webhookUrl = process.env.SECURITY_ALERT_WEBHOOK_URL || '',
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => new Date(),
} = {}) {
  const since = state.lastScanAt
  const events = await prisma.systemLog.findMany({
    where: {
      message: { startsWith: 'SECURITY:' },
      created_at: { gt: since },
    },
    orderBy: { created_at: 'asc' },
    take: MAX_EVENTS_PER_SCAN,
  })

  // 游标前移：以本批最后一条为准（不足一批时推进到扫描时刻，防止边界重复）
  state.lastScanAt = events.length === MAX_EVENTS_PER_SCAN
    ? events[events.length - 1].created_at
    : now()

  if (events.length === 0) return { scanned: 0, alerted: false }

  // 按事件码聚合，避免告警风暴（单条消息汇总本窗口全部事件）
  const byCode = new Map()
  for (const e of events) {
    const code = e.message.replace(/^SECURITY:/, '')
    byCode.set(code, (byCode.get(code) || 0) + 1)
  }
  const summaryLines = [...byCode.entries()].flatMap(([code, n]) => {
    const lines = [`  - ${code} × ${n}`]
    if (EVENT_NOTES[code]) lines.push(`    ${EVENT_NOTES[code]}`)
    return lines
  })
  const text = [
    `🚨 [foodtestlab] 检测到 ${events.length} 条新安全事件（SECURITY:*）`,
    ...summaryLines,
    `窗口: ${since.toISOString()} ~ ${state.lastScanAt.toISOString()}`,
    `排查: SELECT * FROM public."SystemLog" WHERE message LIKE 'SECURITY:%' ORDER BY created_at DESC;`,
  ].join('\n')

  // 通道 1：进程日志（journalctl -u <app> 可见，永远可用）
  logger.error(`\n${'!'.repeat(60)}\n${text}\n${'!'.repeat(60)}`)

  // 通道 2：webhook（企业微信群机器人格式；钉钉同构）
  if (webhookUrl && typeof fetchImpl === 'function') {
    try {
      await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      })
    } catch (e) {
      logger.error(`⚠️ [security-alerts] webhook 推送失败（事件已落 SystemLog 未丢失）: ${e.message}`)
    }
  }
  return { scanned: events.length, alerted: true }
}

let _timer = null

/**
 * 启动定时扫描（每进程一个定时器；unref 不阻塞退出；异常自吞）。
 * 返回控制柄便于测试关停。
 */
export function startSecurityEventAlerting(prisma, {
  intervalMs = Number(process.env.SECURITY_ALERT_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  lookbackMs = Number(process.env.SECURITY_ALERT_LOOKBACK_MS || DEFAULT_LOOKBACK_MS),
} = {}) {
  if (process.env.SECURITY_ALERT_DISABLED === 'true') {
    console.log('ℹ️  SECURITY_ALERT_DISABLED=true，安全事件告警扫描已关闭')
    return null
  }
  if (_timer) return _timer

  const state = { lastScanAt: new Date(Date.now() - lookbackMs) }
  const run = () => scanAndAlertSecurityEvents(prisma, state).catch((e) =>
    console.error(`⚠️ [security-alerts] 扫描失败（下轮重试）: ${e.message}`))

  run() // 启动即扫一次（覆盖上次进程存活期间漏掉的窗口）
  _timer = setInterval(run, intervalMs)
  if (typeof _timer.unref === 'function') _timer.unref()
  console.log(`🛡️  安全事件告警扫描已启动（间隔 ${Math.round(intervalMs / 1000)}s，webhook: ${process.env.SECURITY_ALERT_WEBHOOK_URL ? '已配置' : '未配置，仅进程日志'}）`)
  return _timer
}

export function stopSecurityEventAlerting() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

export default { scanAndAlertSecurityEvents, startSecurityEventAlerting, stopSecurityEventAlerting }
