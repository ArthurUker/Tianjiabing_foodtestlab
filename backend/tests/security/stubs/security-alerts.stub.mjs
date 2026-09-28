// P3-W0-T01 — securityAlerts 测试替身：不启动扫描定时器、不查库、不外发通知。
import { record } from './stub-record.mjs'

export function startSecurityEventAlerting() {
    record('startSecurityEventAlerting')
    return null
}
