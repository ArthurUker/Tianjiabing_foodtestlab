// P3-W0-T01 — tenantClient 测试替身：schema 归一/租户客户端创建不触库。
// 导出面与 backend/lib/tenantClient.js 的启动路径相关部分保持一致，避免 import 失败。
import { record } from './stub-record.mjs'

export const DEFAULT_SCHEMA = 'public'

export function isValidSchoolCode(code) {
    return typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code)
}
export function schemaNameOf(code) {
    return code ? `school_${code}` : null
}
export function resolveSchemaName() {
    return 'public'
}
export function assertSafeSchemaName(name) {
    return name
}
export function createTenantClient(prisma) {
    record('createTenantClient')
    return prisma
}
export function getTenantClientCacheSize() {
    return 0
}
export async function disconnectAllTenantClients() {
    record('disconnectAllTenantClients')
    return { disconnected: 0 }
}
