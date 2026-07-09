/**
 * AuditLogService - 审计日志前端服务
 * 与后端 API 交互，获取和记录审计日志
 */

import { authService } from './AuthService.js';

export class AuditLogService {
    constructor(apiBaseUrl = '') {
        this.apiBaseUrl = apiBaseUrl || '';
    }

    /**
     * 记录操作日志
     * @param {string} action - 操作类型
     * @param {string} table_name - 表名
     * @param {number} record_id - 记录ID (可选)
     * @param {string} details - 操作详情 (可选)
     */
    async logOperation(action, table_name, record_id = null, details = '') {
        try {
            const token = authService.getToken();
            if (!token) {
                console.warn('⚠️ 用户未登录，无法记录审计日志');
                return { success: false, message: '未登录' };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                // P1-28: body 字段名对齐后端解构（resource_type/resource_id），
                // 方法签名参数名 table_name/record_id 保持不变以零影响 11 处调用方
                body: JSON.stringify({
                    action,
                    resource_type: table_name,
                    resource_id: record_id,
                    details
                })
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn('⚠️ 记录审计日志失败:', data.error);
                return { success: false, message: data.error };
            }

            console.log('✅ 审计日志已记录:', data);
            return { success: true, data: data.data };
        } catch (error) {
            console.warn('⚠️ 记录审计日志异常:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取审计日志列表
     * @param {number} limit - 每页数量
     * @param {number} offset - 偏移量
     * @param {string} user_id - 用户ID过滤 (可选)
     * @param {string} action - 操作类型过滤 (可选)
     * @param {string} table_name - 表名过滤 (可选)
     */
    async getLogs(limit = 50, offset = 0, filters = {}) {
        try {
            const token = authService.getToken();
            if (!token) {
                console.warn('⚠️ 用户未登录');
                return { success: false, data: [], total: 0, message: '未登录' };
            }

            // 构建查询参数
            const params = new URLSearchParams({
                limit,
                offset,
                ...filters
            });

            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs?${params}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                console.error('❌ 获取审计日志失败:', data.error);
                return { success: false, data: [], total: 0, message: data.error };
            }

            return {
                success: true,
                data: data.data || [],
                total: data.total || 0,
                limit: data.limit || limit,
                offset: data.offset || offset
            };
        } catch (error) {
            console.error('❌ 获取审计日志异常:', error.message);
            return { success: false, data: [], total: 0, message: error.message };
        }
    }

    /**
     * 获取指定日期的审计日志统计
     * @param {string} date - 日期 (YYYY-MM-DD)
     */
    async getStats(date) {
        try {
            const token = authService.getToken();
            if (!token) {
                return { success: false, stats: {}, message: '未登录' };
            }

            // P1-27: URL 从 /stats/${date} 改为 /stats/summary，date 转为 query param 对齐后端
            const params = new URLSearchParams();
            if (date) params.append('date', date);
            const queryString = params.toString() ? '?' + params.toString() : '';

            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs/stats/summary${queryString}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                console.error('❌ 获取统计失败:', data.error);
                return { success: false, stats: {}, message: data.error };
            }

            // P1-27: 后端返回 { success, data: {...} }，字段名修正 data.stats → data.data
            return {
                success: true,
                stats: data.data || {}
            };
        } catch (error) {
            console.error('❌ 获取统计异常:', error.message);
            return { success: false, stats: {}, message: error.message };
        }
    }

    /**
     * 导出审计日志 (CSV)
     * @param {string} start_date - 开始日期 (YYYY-MM-DD, 可选)
     * @param {string} end_date - 结束日期 (YYYY-MM-DD, 可选)
     */
    async exportLogs(start_date = '', end_date = '') {
        try {
            const token = authService.getToken();
            if (!token) {
                alert('❌ 用户未登录');
                return;
            }

            const params = new URLSearchParams();
            if (start_date) params.append('start_date', start_date);
            if (end_date) params.append('end_date', end_date);

            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs/export?${params}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                const error = await response.json();
                alert(`❌ 导出失败: ${error.error}`);
                return;
            }

            // 创建下载链接
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `audit_logs_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);

            console.log('✅ 审计日志已导出');
        } catch (error) {
            console.error('❌ 导出异常:', error.message);
            alert(`❌ 导出失败: ${error.message}`);
        }
    }

    /**
     * 清理旧审计日志 (仅90天内)
     */
    async cleanup() {
        try {
            const token = authService.getToken();
            if (!token) {
                return { success: false, message: '未登录' };
            }

            // P1-27: HTTP 方法从 POST 改为 DELETE，对齐后端 DELETE /api/audit-logs/cleanup
            const response = await fetch(`${this.apiBaseUrl}/api/audit-logs/cleanup`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                console.error('❌ 清理失败:', data.error);
                return { success: false, message: data.error };
            }

            console.log('✅ 审计日志已清理:', data);
            return { success: true, message: data.message };
        } catch (error) {
            console.error('❌ 清理异常:', error.message);
            return { success: false, message: error.message };
        }
    }
}

// 导出单例
import { getApiBaseUrl } from './AuthService.js';
export const auditLogService = new AuditLogService(getApiBaseUrl());
