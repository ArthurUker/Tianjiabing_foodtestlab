/**
 * 访客界面模块
 * 为访客提供只读的数据查看和导出申请功能
 */

import guestAuthService from '../services/GuestAuthService.js';
import { UINotification } from '../utils/UINotification.js';
import { extractSchoolCode } from '../utils/schoolCode.js';
import { escapeHtml } from '../utils/schoolCustomization/shared.js';
import {
    ensureSchoolConfig,
    getSchoolCustomization,
    applySchoolCustomizationToTitles,
    applySchoolBranding,
} from '../utils/schoolCustomization.js';

export class GuestDashboard {
    constructor() {
        this.moduleName = '访客中心';
        this.currentGuest = null;
        this.exportRequests = [];
        this._abortCtrl = null;   // TD-EventLeak-Phase2
        // RK31: 快速导航 data-nav-target → visible_types 模块 code 映射（dashboard 恒显示）
        this._navToModule = {
            'tableware-test': 'tableware',
            'pesticide-test': 'pesticide',
            'oil-test': 'oil',
            'lean-meat-test': 'leanMeat',
        };
    }

    /**
     * RK31: 拉取并应用学校定制（访客端与师生端一致）。
     * 带 3 秒超时降级：后端不可达时不阻塞页面，继续用 localStorage 旧缓存。
     */
    async applySchoolCustomization() {
        const schoolCode = extractSchoolCode();
        if (!schoolCode) {
            console.warn('⚠️ 访客端无法解析 schoolCode，跳过学校定制应用');
            return {};
        }
        let customization = {};
        try {
            const fetched = await Promise.race([
                ensureSchoolConfig(schoolCode),
                new Promise((resolve) => setTimeout(() => resolve(undefined), 3000)),
            ]);
            customization = fetched === undefined
                ? (getSchoolCustomization(schoolCode) || {})
                : (fetched || {});
            if (fetched === undefined) console.warn('⚠️ 访客端学校定制拉取超时（3s），以缓存继续');
            applySchoolCustomizationToTitles(customization);
            applySchoolBranding(schoolCode);
        } catch (e) {
            console.error('❌ 访客端学校定制应用失败:', e);
        }
        return customization;
    }

    /**
     * RK31: 按 visible_types 隐藏访客快速导航中不可见的模块按钮。
     */
    applyVisibleTypes(customization) {
        try {
            const raw = customization && customization.visible_types;
            const visible = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!Array.isArray(visible) || !visible.length) return;
            const nav = document.getElementById('guestQuickNav');
            if (!nav) return;
            nav.querySelectorAll('[data-nav-target]').forEach(btn => {
                const moduleCode = this._navToModule[btn.dataset.navTarget];
                if (moduleCode && !visible.includes(moduleCode)) {
                    btn.style.display = 'none';
                }
            });
        } catch (e) {
            console.warn('⚠️ 访客端 visible_types 应用失败:', e);
        }
    }

    /**
     * 初始化模块
     */
    async init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');

        this.currentGuest = guestAuthService.getCurrentGuest();
        
        if (!this.currentGuest) {
            console.warn('⚠️ 未登录');
            return false;
        }

        // RK31: 渲染前应用学校定制（标题/品牌/模块可见性）
        const customization = await this.applySchoolCustomization();

        this.renderUI();
        this.applyVisibleTypes(customization);
        this.bindEvents();
        this.loadExportRequests();
        this.loadStats(); // BS-09: 异步加载汇总统计，不阻塞初始化

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 渲染访客界面
     */
    renderUI() {
        const container = document.getElementById('guest-dashboard');
        
        if (!container) {
            console.warn('⚠️ 找不到 id="guest-dashboard" 的容器');
            return;
        }

        const guest = this.currentGuest;
        const isQuickAccess = guestAuthService.isQuickAccessMode();
        const guestTypeLabel = guest.guest_type === 'viewer' ? '只读访客' : '导出申请访客';
        const permissionStatus = guest.has_export_permission 
            ? '<span class="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">✓ 已获得导出权限</span>'
            : '<span class="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded">⏳ 待审批</span>';

        // 快速访问模式显示标签
        const quickAccessBadge = isQuickAccess ? `
            <div class="mb-4 p-3 bg-blue-100 border border-blue-300 rounded-lg text-blue-800 text-sm flex items-center">
                <i class="fas fa-info-circle mr-2"></i>
                您正在使用<strong>快速查看模式</strong>，仅可查看数据，无法进行任何操作
            </div>
        ` : '';

        container.innerHTML = `
            <div class="space-y-6">
                ${quickAccessBadge}
                
                <!-- 欢迎横幅 -->
                <div class="bg-gradient-to-r from-blue-500 to-blue-700 rounded-lg shadow-lg p-6 text-white">
                    <div class="flex justify-between items-start">
                        <div>
                            <h2 class="text-2xl font-bold mb-2">
                                <i class="fas fa-user-circle mr-2"></i>欢迎${isQuickAccess ? ' (快速查看)' : ''}，${escapeHtml(guest.full_name || guest.username)}
                            </h2>
                            <p class="text-blue-100">访客类型: ${guestTypeLabel}</p>
                            ${!isQuickAccess ? `<p class="text-blue-100 text-sm">访问有效期: 至 ${new Date(guest.valid_until).toLocaleDateString()}</p>` : ''}
                        </div>
                        <div class="text-right">
                            ${!isQuickAccess ? permissionStatus : '<span class="px-2 py-1 bg-gray-200 text-gray-800 text-xs rounded">临时访问</span>'}
                        </div>
                    </div>
                </div>

                <!-- 功能说明 -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <!-- 可用功能 -->
                    <div class="bg-white rounded-lg shadow p-6">
                        <h3 class="text-lg font-semibold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-check-circle text-green-600 mr-2"></i>可用功能
                        </h3>
                        <ul class="space-y-2 text-gray-600">
                            <li class="flex items-center">
                                <i class="fas fa-chart-line text-blue-500 mr-2"></i>查看数据看板
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-microscope text-blue-500 mr-2"></i>查看检测数据
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-eye text-blue-500 mr-2"></i>查看测试结果
                            </li>
                            ${!isQuickAccess && guest.guest_type === 'export_applicant' ? `
                            <li class="flex items-center ${guest.has_export_permission ? 'text-green-600' : 'text-yellow-600'}">
                                <i class="fas fa-file-export mr-2"></i>申请/导出报告
                            </li>
                            ` : ''}
                        </ul>
                    </div>

                    <!-- 限制功能 -->
                    <div class="bg-white rounded-lg shadow p-6">
                        <h3 class="text-lg font-semibold text-gray-800 mb-4 flex items-center">
                            <i class="fas fa-ban text-red-600 mr-2"></i>禁用功能
                        </h3>
                        <ul class="space-y-2 text-gray-600">
                            <li class="flex items-center">
                                <i class="fas fa-plus-circle text-gray-400 mr-2"></i>创建新记录
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-edit text-gray-400 mr-2"></i>编辑现有数据
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-trash text-gray-400 mr-2"></i>删除数据
                            </li>
                            <li class="flex items-center">
                                <i class="fas fa-cog text-gray-400 mr-2"></i>系统设置
                            </li>
                        </ul>
                    </div>
                </div>

                <!-- BS-09: 数据概览（后端 /api/guest/stats 聚合，仅汇总不含明细） -->
                <div class="bg-white rounded-lg shadow p-6">
                    <h3 class="text-lg font-semibold text-gray-800 mb-4">
                        <i class="fas fa-chart-bar text-blue-600 mr-2"></i>数据概览
                    </h3>
                    <div id="guestStatsCards" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                        <div class="col-span-full text-center py-4 text-gray-400 text-sm">
                            <i class="fas fa-spinner fa-spin mr-2"></i>统计加载中...
                        </div>
                    </div>
                </div>

                ${!isQuickAccess && guest.guest_type === 'export_applicant' ? this.renderExportSection() : ''}

                <!-- 快速链接 -->
                <div class="bg-white rounded-lg shadow p-6">
                    <h3 class="text-lg font-semibold text-gray-800 mb-4">
                        <i class="fas fa-link mr-2"></i>快速导航
                    </h3>
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-2" id="guestQuickNav">
                        <button class="p-2 bg-blue-50 text-blue-600 rounded hover:bg-blue-100 text-sm font-medium flex items-center justify-center transition"
                            data-nav-target="dashboard">
                            <i class="fas fa-chart-pie mr-1"></i>数据看板
                        </button>
                        <button class="p-2 bg-green-50 text-green-600 rounded hover:bg-green-100 text-sm font-medium flex items-center justify-center transition"
                            data-nav-target="tableware-test">
                            <i class="fas fa-utensils mr-1"></i>餐具洁净度
                        </button>
                        <button class="p-2 bg-lime-50 text-lime-600 rounded hover:bg-lime-100 text-sm font-medium flex items-center justify-center transition"
                            data-nav-target="pesticide-test">
                            <i class="fas fa-leaf mr-1"></i>果蔬农残
                        </button>
                        <button class="p-2 bg-yellow-50 text-yellow-600 rounded hover:bg-yellow-100 text-sm font-medium flex items-center justify-center transition"
                            data-nav-target="oil-test">
                            <i class="fas fa-flask mr-1"></i>食用油品质
                        </button>
                        <button class="p-2 bg-orange-50 text-orange-600 rounded hover:bg-orange-100 text-sm font-medium flex items-center justify-center transition"
                            data-nav-target="lean-meat-test">
                            <i class="fas fa-drumstick-bite mr-1"></i>肉蛋农残
                        </button>
                        <!-- ❌ 访客无权访问病原体检测 - 已移除快速链接 -->
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * BS-09: 加载访客汇总统计（总记录数 / 各可见模块计数 / 合格率）。
     * 后端已按该校 visible_types 白名单聚合并强制排除 pathogen，前端只做渲染。
     */
    async loadStats() {
        const container = document.getElementById('guestStatsCards');
        if (!container) return;
        try {
            const token = guestAuthService.getToken();
            if (!token) throw new Error('未登录');
            const resp = await fetch('/api/guest/stats', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) {
                throw new Error(data.error || `HTTP ${resp.status}`);
            }
            this.renderStats(data.data || {});
        } catch (err) {
            console.warn('⚠️ 访客统计加载失败:', err);
            container.innerHTML = '<div class="col-span-full text-center py-4 text-gray-400 text-sm">统计数据暂不可用</div>';
        }
    }

    /**
     * BS-09: 渲染汇总统计卡片（总数卡 + 各可见模块卡，含合格率）
     */
    renderStats(stats) {
        const container = document.getElementById('guestStatsCards');
        if (!container) return;

        const byType = stats.byType || {};
        const typeCards = Object.entries(byType).map(([code, item]) => {
            const rateHtml = (item.passRate === null || item.passRate === undefined)
                ? '<p class="text-xs text-gray-400 mt-1">—</p>'
                : `<p class="text-xs mt-1 ${item.passRate >= 90 ? 'text-green-600' : 'text-yellow-600'}">合格率 ${item.passRate}%</p>`;
            return `
                <div class="border rounded-lg p-3 text-center bg-gray-50">
                    <p class="text-xs text-gray-500 truncate" title="${escapeHtml(item.label || code)}">${escapeHtml(item.label || code)}</p>
                    <p class="text-xl font-bold text-gray-800 mt-1">${item.count ?? 0}</p>
                    ${rateHtml}
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="border rounded-lg p-3 text-center bg-blue-50">
                <p class="text-xs text-blue-600">总记录数</p>
                <p class="text-xl font-bold text-blue-700 mt-1">${stats.total ?? 0}</p>
                <p class="text-xs text-blue-400 mt-1">可见模块合计</p>
            </div>
            ${typeCards || '<div class="col-span-full text-center py-4 text-gray-400 text-sm">暂无可见模块</div>'}
        `;
    }

    /**
     * 渲染导出申请部分
     */
    renderExportSection() {
        return `
            <div class="bg-white rounded-lg shadow p-6">
                <h3 class="text-lg font-semibold text-gray-800 mb-4">
                    <i class="fas fa-file-export text-blue-600 mr-2"></i>导出权限申请
                </h3>
                
                ${!this.currentGuest.has_export_permission ? `
                <div class="bg-yellow-50 border border-yellow-200 rounded p-4 mb-4">
                    <p class="text-yellow-800 text-sm">
                        <i class="fas fa-info-circle mr-2"></i>
                        您还未获得导出权限。请提交申请，管理员审批后即可获得导出功能。
                    </p>
                </div>

                <div class="space-y-3">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">申请原因</label>
                        <textarea id="exportReason" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" 
                            rows="3" placeholder="请说明您需要导出报告的原因..."></textarea>
                    </div>
                    <button id="btnSubmitExportRequest" class="w-full bg-blue-600 text-white py-2 rounded-lg hover:bg-blue-700 transition font-medium">
                        <i class="fas fa-paper-plane mr-2"></i>提交申请
                    </button>
                </div>
                ` : `
                <div class="bg-green-50 border border-green-200 rounded p-4">
                    <p class="text-green-800 text-sm">
                        <i class="fas fa-check-circle mr-2"></i>
                        您已获得导出权限！可在各个检测模块中导出报告。
                    </p>
                </div>
                `}

                <!-- 申请历史 -->
                <div class="mt-6 pt-6 border-t">
                    <h4 class="font-semibold text-gray-800 mb-3">申请历史</h4>
                    <div id="exportRequestsList" class="space-y-2">
                        <div class="text-center py-4 text-gray-500">
                            <i class="fas fa-spinner fa-spin mr-2"></i>加载中...
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 加载导出申请记录
     */
    async loadExportRequests() {
        if (this.currentGuest.guest_type !== 'export_applicant') {
            return;
        }

        const container = document.getElementById('exportRequestsList');
        try {
            const result = await guestAuthService.getMyRequests();
        
            if (result.success) {
                this.exportRequests = result.requests || [];
                this.renderExportRequests();
            } else if (container) {
                container.innerHTML = '<div class="text-center py-4 text-gray-500">暂无申请记录</div>';
            }
        } catch (err) {
            console.error('加载导出申请失败:', err);
            if (container) {
                container.innerHTML = '<div class="text-center py-4 text-gray-500">暂无申请记录</div>';
            }
            UINotification.error('加载导出申请失败，请稍后重试');
        }
    }

    /**
     * 渲染导出申请列表
     */
    renderExportRequests() {
        const container = document.getElementById('exportRequestsList');
        
        if (!container) return;

        if (this.exportRequests.length === 0) {
            container.innerHTML = '<div class="text-center py-4 text-gray-500">暂无申请记录</div>';
            return;
        }

        container.innerHTML = this.exportRequests.map(req => {
            const statusMap = {
                'pending': { label: '待审批', color: 'yellow' },
                'approved': { label: '已批准', color: 'green' },
                'rejected': { label: '已拒绝', color: 'red' },
                'expired': { label: '已过期', color: 'gray' }
            };

            const status = statusMap[req.status] || { label: req.status, color: 'gray' };
            const colorClasses = {
                'yellow': 'bg-yellow-100 text-yellow-800',
                'green': 'bg-green-100 text-green-800',
                'red': 'bg-red-100 text-red-800',
                'gray': 'bg-gray-100 text-gray-800'
            };

            return `
                <div class="border rounded p-3">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <span class="font-medium">${escapeHtml(req.request_type)}</span>
                            <p class="text-sm text-gray-600">${escapeHtml(req.request_reason)}</p>
                        </div>
                        <span class="px-2 py-1 text-xs rounded ${colorClasses[status.color]}">
                            ${status.label}
                        </span>
                    </div>
                    <p class="text-xs text-gray-500">
                        申请时间: ${new Date(req.requested_at).toLocaleString()}
                    </p>
                    ${req.approval_comment ? `
                    <p class="text-xs text-gray-600 mt-1">
                        <i class="fas fa-comment mr-1"></i>审批意见: ${escapeHtml(req.approval_comment)}
                    </p>
                    ` : ''}
                    ${req.permission_valid_until ? `
                    <p class="text-xs text-green-600 mt-1">
                        <i class="fas fa-calendar mr-1"></i>权限有效期: ${new Date(req.permission_valid_until).toLocaleDateString()}
                    </p>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // TD-EventLeak-Phase2: 重新绑定前先取消上一次监听，避免累加
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();

        // 提交导出申请
        const btnSubmit = document.getElementById('btnSubmitExportRequest');
        if (btnSubmit) {
            btnSubmit.addEventListener('click', () => this.submitExportRequest(), { signal: this._abortCtrl.signal });
        }

        // P2-10 阶段B：快速导航按钮改事件委托，派发 app:navigate 事件（不再依赖 window.handleNavigation）
        const quickNav = document.getElementById('guestQuickNav');
        if (quickNav) {
            quickNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-nav-target]');
                if (!btn) return;
                document.dispatchEvent(new CustomEvent('app:navigate', {
                    detail: { target: btn.dataset.navTarget }
                }));
            }, { signal: this._abortCtrl.signal });
        }
    }

    /**
     * 提交导出申请
     */
    async submitExportRequest() {
        const reasonEl = document.getElementById('exportReason');
        const reason = reasonEl ? reasonEl.value.trim() : '';

        if (!reason) {
            UINotification.error('请输入申请原因');
            return;
        }

        const btnSubmit = document.getElementById('btnSubmitExportRequest');
        if (btnSubmit) btnSubmit.disabled = true;

        UINotification.loading('正在提交申请...');

        try {
            const result = await guestAuthService.submitExportRequest(
                'report_export',
                reason,
                { request_date: new Date().toISOString() }
            );

            if (result.success) {
                UINotification.success('申请已提交，请等待管理员审批');
                if (reasonEl) reasonEl.value = '';
                await this.loadExportRequests();
            } else {
                UINotification.error('提交失败: ' + result.error);
            }
        } catch (err) {
            console.error('提交导出申请失败:', err);
            UINotification.error('提交导出申请失败，请稍后重试');
        } finally {
            if (btnSubmit) btnSubmit.disabled = false;
        }
    }
}

export const guestDashboard = new GuestDashboard();
