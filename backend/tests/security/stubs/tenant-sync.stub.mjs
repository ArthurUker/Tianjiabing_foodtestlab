// P3-W0-T01 — tenantSync 测试替身：启动自愈不执行任何数据库 DDL。
import { record } from './stub-record.mjs'

export async function syncAllTenantSchemas() {
    record('syncAllTenantSchemas')
    return { synced: 0 }
}
