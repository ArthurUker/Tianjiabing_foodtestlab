// P3-W0-T01 — schoolRoutes 部分替身：保留真实路由工厂（re-export），
// 仅把启动期的 ensureRecycleBinInfra（运行时建表）替换为记录型替身。
// `?real` 旁路确保 re-export 不会再次命中替身注册器（避免递归）。
export * from '../../../routes/schoolRoutes.js?real'
import { record } from './stub-record.mjs'

export async function ensureRecycleBinInfra() {
    record('ensureRecycleBinInfra')
    return { created: true }
}
