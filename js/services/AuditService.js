/**
 * AuditService - 统一审计接口（TD-P2-13 收口：单一入口 + 规范字段口径）
 *
 * 所有前端的「写审计 / 查审计 / 导审计」都经本模块，字段口径与后端
 * auditLog 模型、前端离线 AuditLogger 保持一致：
 *   - action        : create | update | delete | login | logout | export | import
 *   - resource_type : 资源类型（表名 / 'auth' / 'user' / ...）
 *   - resource_id   : 资源 ID（可选）
 *   - details       : 操作详情（字符串）
 *
 * 双写策略：
 *   - 离线兜底：始终写 localStorage（js/utils/AuditLogger.js），保证断网/未登录也可追溯；
 *   - 服务端：若已登录（持有 auth_token），异步 POST /api/audit-logs 双写落当前租户 schema。
 *     服务端写入为「尽力而为、不阻塞主流程」——失败仅告警，绝不影响业务。
 */

import { logOperation } from '../utils/AuditLogger.js'
// TD-TenantIsolation：认证态 key 已按学校命名空间隔离，读取需拼 schoolCode 前缀
import { extractSchoolCode } from '../utils/schoolCode.js'

// 与 AuthService 一致：同源部署走相对路径，特殊环境经 window.__API_BASE_URL 覆盖。
function getApiBaseUrl() {
    if (typeof window !== 'undefined' && window.__API_BASE_URL) {
        return window.__API_BASE_URL
    }
    return ''
}

function getAuthToken() {
    try {
        // TD-TenantIsolation：按当前学校命名空间读取（与 AuthService._nsKey 一致）
        const code = extractSchoolCode() || ''
        return localStorage.getItem(code ? `auth_token__${code}` : 'auth_token') || null
    } catch {
        return null
    }
}

export class AuditService {
    constructor(apiBaseUrl = '') {
        this.apiBaseUrl = apiBaseUrl || getApiBaseUrl()
    }

    /**
     * 记录一条审计（统一入口）
     * @param {string} action 操作类型
     * @param {string} [resourceType] 资源类型
     * @param {string|null} [resourceId] 资源 ID
     * @param {string} [details] 详情
     * @returns {Promise<void>}
     */
    async log(action, resourceType = null, resourceId = null, details = '') {
        // 1) 离线兜底：始终写 localStorage（规范字段口径见 AuditLogger.logOperation）
        try {
            logOperation(action, resourceType, resourceId, details)
        } catch (e) {
            console.warn('[AuditService] 本地日志写入失败:', e.message)
        }

        // 2) 服务端双写（尽力而为，不阻塞主流程）
        const token = getAuthToken()
        if (!token) return
        const payload = {
            action,
            resource_type: resourceType || null,
            resource_id: resourceId || null,
            details: typeof details === 'string' ? details : JSON.stringify(details ?? ''),
        }
        fetch(`${this.apiBaseUrl}/api/audit-logs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
        }).catch((err) => {
            console.warn('[AuditService] 服务端审计写入失败（已忽略）:', err.message)
        })
    }

    /**
     * 查询审计日志（分页 + 筛选）
     * @param {number} limit
     * @param {number} offset
     * @param {object} [filters] { user_id, action, start_date, end_date }
     * @returns {Promise<{success:boolean, data?:Array, total?:number, message?:string}>}
     */
    async getLogs(limit = 100, offset = 0, filters = {}) {
        try {
            const token = getAuthToken()
            if (!token) return { success: false, message: '未登录' }

            const params = new URLSearchParams()
            params.set('limit', String(limit))
            params.set('offset', String(offset))
            if (filters.user_id) params.set('userId', filters.user_id)
            if (filters.action) params.set('action', filters.action)
            // 注：后端 GET 当前仅支持 userId/action 过滤，日期区间透传以备扩展。

            const resp = await fetch(`${this.apiBaseUrl}/api/audit-logs?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            const json = await resp.json()
            if (!resp.ok) {
                return { success: false, message: json.error || '查询失败' }
            }
            return { success: true, data: json.data || [], total: json.total || 0 }
        } catch (error) {
            console.error('[AuditService] 查询审计日志异常:', error)
            return { success: false, message: error.message }
        }
    }

    /**
     * 导出审计日志为 CSV（触发浏览器下载）
     * @param {string} [startDate] YYYY-MM-DD
     */
    async exportLogs(startDate) {
        try {
            const token = getAuthToken()
            if (!token) {
                console.warn('[AuditService] 未登录，无法导出')
                return
            }
            const params = new URLSearchParams()
            if (startDate) {
                params.set('start_date', startDate)
                params.set('end_date', startDate)
            }
            const resp = await fetch(`${this.apiBaseUrl}/api/audit-logs/export?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (!resp.ok) {
                console.warn('[AuditService] 导出失败:', resp.status)
                return
            }
            const blob = await resp.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `audit_logs_${startDate || new Date().toISOString().slice(0, 10)}.csv`
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(url)
        } catch (error) {
            console.error('[AuditService] 导出审计日志异常:', error)
        }
    }
}

// 导出单例（供 AuthService / 各业务模块 / AuditLog UI 统一引用）
export const auditService = new AuditService()
