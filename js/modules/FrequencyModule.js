// N1/N2/N3: 检测频率阈值 / 检测日历 / 检测月报 前端模块
// - 每日登录提示今日检测项目(N2)
// - 「检测频率与月报」页: 风险警告 + 月报统计表 + 趋势图(N1 + N3, 所有登录用户可看)
// - 「检测频率与日历设置」页: 阈值编辑 + 日历勾选(manager+)
//
// 设计语言与其他模块(餐具/果蔬/食用油/肉蛋/病原体)完全一致:
//   glass 主容器(毛玻璃) + glass-panel 子面板 + text-2xl font-bold mb-4 border-b pb-2 标题
//   + bg-blue-50 border border-blue-200 提示框 + 标准蓝色按钮
import { UINotification } from '../utils/UINotification.js';
import { authService } from '../services/AuthService.js';

const API_BASE = window.API_BASE || '';

function authHeaders() {
    const token = authService.getToken() || '';
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

function currentUser() {
    try { return authService.getUser() || null; } catch (e) { return null; }
}

function extractSchoolCode() {
    try {
        const m = location.pathname.match(/\/([^/]+)\/index\.html/);
        return m ? m[1] : '';
    } catch (e) { return ''; }
}

function isManagerOrAbove() {
    const u = currentUser();
    return u && (u.role === 'manager' || u.role === 'admin');
}

const TYPE_NAMES = {
    tableware: '餐具洁净度',
    pesticide: '果蔬农残',
    oil: '食用油',
    leanMeat: '肉蛋农残',
    pathogen: '病原体'
};

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatTodayText(json) {
    const now = new Date(json.data.date || new Date());
    const weekDay = DAY_NAMES[now.getDay()];
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
    const items = (json.data && json.data.items) || [];
    const names = items.map(i => TYPE_NAMES[i.test_type] || i.name || i.test_type);
    const prefix = `📅 ${dateStr} ${weekDay} | 今日待检测：`;
    if (!names.length) {
        return `${prefix} ✅ 已全部完成 / 暂无安排`;
    }
    return `${prefix}${names.join('、')}`;
}

// ========== N2: 每日登录提示今日检测项目 ==========
export async function showTodayDetectionHint() {
    try {
        const resp = await fetch(`${API_BASE}/api/frequency/today`, { headers: authHeaders() });
        const json = await resp.json();
        if (!json.success) return;
        const todayKey = `today_hint_${extractSchoolCode()}_${new Date().toISOString().slice(0, 10)}`;
        if (sessionStorage.getItem(todayKey)) return;
        sessionStorage.setItem(todayKey, '1');
        const msg = formatTodayText(json);
        setTimeout(() => {
            UINotification.info(msg, 5000);
        }, 1200);
    } catch (e) {
        console.warn('今日检测提示获取失败:', e.message);
    }
}

// ========== 顶部滚动提醒条：今日待检测项目（排除已完成的）==========
export async function loadDailyReminderBar() {
    try {
        const bar = document.getElementById('dailyReminderBar');
        const contentEl = document.getElementById('dailyReminderContent');
        if (!bar || !contentEl) return;

        const resp = await fetch(`${API_BASE}/api/frequency/today`, { headers: authHeaders() });
        const json = await resp.json();
        if (!json.success || !json.data) {
            bar.classList.add('hidden');
            return;
        }

        const line = formatTodayText(json);
        // 构建滚动内容：用两份相同内容实现无缝循环滚动
        const scrollText = `${line}　　　　${line}　　　　`;

        contentEl.textContent = scrollText;
        bar.classList.remove('hidden');
    } catch (e) {
        console.warn('每日提醒条加载失败:', e.message);
        const bar = document.getElementById('dailyReminderBar');
        if (bar) bar.classList.add('hidden');
    }
}

// 提供手动刷新方法（完成检测后调用）
export function refreshDailyReminderBar() {
    loadDailyReminderBar();
}

// ========== N1 + N3: 渲染「检测频率与月报」页(所有登录用户可看) ==========
export async function renderFrequencyCards(container) {
    // 页面骨架(与其他模块一致: glass 主容器 + 标题 + 子面板)
    container.innerHTML = `
        <div class="space-y-4">
            <div class="glass p-6">
                <div class="flex items-center justify-between mb-4 border-b pb-2">
                    <h2 class="text-2xl font-bold flex items-center">
                        <i class="fas fa-chart-line text-blue-600 mr-2"></i>检测频率与月报
                    </h2>
                    <button id="btnRefreshFrequency" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm flex items-center">
                        <i class="fas fa-sync-alt mr-2"></i>刷新
                    </button>
                </div>
                <div class="bg-blue-50 border border-blue-200 p-4 rounded text-sm text-blue-800">
                    各检测项目本周达标情况、本月与上月次数对比、近 6 个月检测频率趋势(检测频率不足时提示风险警告)
                </div>
            </div>
            <div id="frequency-content">
                <div class="glass p-8 flex justify-center text-gray-400">
                    <i class="fas fa-spinner fa-spin mr-2"></i>正在加载检测频率数据...
                </div>
            </div>
        </div>`;

    const content = container.querySelector('#frequency-content');

    const load = async () => {
        try {
            const resp = await fetch(`${API_BASE}/api/frequency/overview`, { headers: authHeaders() });
            const json = await resp.json();
            if (!json.success) throw new Error(json.error || '加载失败');
            const { items, trend } = json.data || { items: [], trend: [] };

            // 风险警告:每条独立成大块面(不再嵌套,平铺)
            const warnings = items.filter(i => i.warning);
            const warningHtml = warnings.length
                ? `<div class="space-y-3">
                        <div class="glass p-5">
                            <div class="text-base font-bold text-gray-700 mb-4 flex items-center">
                                <i class="fas fa-exclamation-triangle text-red-500 mr-2 text-lg"></i>本周检测频率风险警告
                            </div>
                            <div class="space-y-3">
                                ${warnings.map(w => `
                                    <div class="bg-red-50 border border-red-300 p-4 rounded-lg flex items-center justify-between">
                                        <div class="flex items-center gap-4">
                                            <i class="fas fa-exclamation-triangle text-red-500 text-xl"></i>
                                            <span class="text-red-700 font-semibold text-base">${w.name}</span>
                                            <span class="text-gray-700">本周 ${w.week_count} 次</span>
                                            <span class="text-gray-500">目标 ${w.weekly_target} 次/周</span>
                                        </div>
                                        <span class="text-sm bg-red-500 text-white px-3 py-1 rounded-full font-semibold">检测频率不足</span>
                                    </div>`).join('')}
                            </div>
                        </div>
                    </div>`
                : `<div class="glass p-5 flex items-center gap-3">
                        <i class="fas fa-check-circle text-green-500 text-xl"></i>
                        <span class="text-base text-green-700">本周各项目检测频率均达标</span>
                    </div>`;

            // 月报统计表(N3)
            const rowsHtml = items.map(i => {
                const chg = i.change_pct > 0
                    ? `<span class="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-700">↑ ${i.change_pct}%</span>`
                    : i.change_pct < 0
                    ? `<span class="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-700">↓ ${Math.abs(i.change_pct)}%</span>`
                    : `<span class="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-100 text-gray-500">→ 0%</span>`;
                const warn = i.warning
                    ? '<i class="fas fa-exclamation-triangle text-red-500 ml-1" title="本周检测频率不达标"></i>'
                    : '<i class="fas fa-check-circle text-green-500 ml-1" title="本周达标"></i>';
                return `<tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td class="px-4 py-3 text-sm font-medium text-gray-800">${i.name}${warn}</td>
                    <td class="px-4 py-3 text-sm text-gray-700 text-center">${i.this_month}</td>
                    <td class="px-4 py-3 text-sm text-gray-700 text-center">${i.prev_month}</td>
                    <td class="px-4 py-3 text-sm text-center">${chg}</td>
                    <td class="px-4 py-3 text-sm text-gray-500 text-center">${i.weekly_target}</td>
                    <td class="px-4 py-3 text-sm text-center font-semibold ${i.week_count >= i.weekly_target ? 'text-green-600' : 'text-red-600'}">${i.week_count}/${i.weekly_target}</td>
                </tr>`;
            }).join('');

            const tableHtml = `
                <div class="glass p-5">
                    <div class="text-base font-bold text-gray-700 mb-4 flex items-center border-b pb-3">
                        <i class="fas fa-table text-blue-600 mr-2 text-lg"></i>检测月报统计（${new Date().getFullYear()} 年 ${new Date().getMonth() + 1} 月）
                    </div>
                    <div class="overflow-x-auto">
                        <table class="min-w-full text-left">
                            <thead>
                                <tr class="bg-gray-50 border-b border-gray-200">
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600">项目</th>
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600 text-center">本月次数</th>
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600 text-center">上月次数</th>
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600 text-center">环比</th>
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600 text-center">周目标</th>
                                    <th class="px-4 py-3 text-xs font-semibold text-gray-600 text-center">本周进度</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>`;

            // 趋势图(近6个月)
            let trendHtml = '';
            if (trend.length >= 2) {
                const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
                const W = 560, H = 200, pad = 32;
                const months = trend.map(t => t.month);
                const maxVal = Math.max(5, ...trend.flatMap(t => types.map(tp => t.counts[tp] || 0)));
                const color = { tableware: '#3b82f6', pesticide: '#10b981', oil: '#f59e0b', leanMeat: '#ef4444', pathogen: '#8b5cf6' };
                const paths = types.map(tp => {
                    const pts = trend.map((t, i) => {
                        const x = pad + (i * (W - 2 * pad)) / Math.max(1, trend.length - 1);
                        const y = H - pad - ((t.counts[tp] || 0) / maxVal) * (H - 2 * pad);
                        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
                    }).join(' ');
                    return `<path d="${pts}" fill="none" stroke="${color[tp]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
                }).join('');
                const monthLabels = months.map((m, i) => {
                    const x = pad + (i * (W - 2 * pad)) / Math.max(1, trend.length - 1);
                    return `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6b7280">${m}</text>`;
                }).join('');
                const legend = types.map(tp => `
                    <span class="inline-flex items-center gap-1.5 mr-4 text-xs text-gray-600">
                        <span style="width:12px;height:3px;background:${color[tp]};display:inline-block;border-radius:2px"></span>${TYPE_NAMES[tp]}
                    </span>`).join('');
                trendHtml = `
                    <div class="glass p-5">
                        <div class="text-base font-bold text-gray-700 mb-4 flex items-center border-b pb-3">
                            <i class="fas fa-chart-line text-blue-600 mr-2 text-lg"></i>近 6 个月检测次数趋势
                        </div>
                        <div class="flex flex-wrap items-center mb-3">${legend}</div>
                        <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto bg-gray-50 rounded-lg">
                            ${paths}${monthLabels}
                        </svg>
                    </div>`;
            }

            content.innerHTML = warningHtml + tableHtml + trendHtml;
        } catch (e) {
            console.warn('检测频率卡片渲染失败:', e.message);
            content.innerHTML = '<div class="glass p-6 text-center text-base text-red-500">检测频率数据加载失败: ' + e.message + '</div>';
        }
    };

    await load();

    const refreshBtn = container.querySelector('#btnRefreshFrequency');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            content.innerHTML = '<div class="glass-panel p-8 flex justify-center text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>正在刷新...</div>';
            load();
        });
    }
}

// ========== N1 + N2: 检测频率与日历设置页(manager+) ==========
export function initFrequencySettings(panel) {
    if (!isManagerOrAbove()) return;
    if (!panel) return;

    const render = async () => {
        try {
            const [thResp, calResp] = await Promise.all([
                fetch(`${API_BASE}/api/frequency/thresholds`, { headers: authHeaders() }),
                fetch(`${API_BASE}/api/frequency/calendar`, { headers: authHeaders() })
            ]);
            const th = await thResp.json();
            const cal = await calResp.json();
            if (!th.success || !cal.success) { panel.innerHTML = '<p class="text-sm text-red-500">配置加载失败</p>'; return; }

            const thresholds = th.data || [];
            const calendar = cal.data || [];

            // 阈值表格
            const thRows = thresholds.map(t => `
                <tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td class="px-4 py-3 text-sm font-medium text-gray-800">${TYPE_NAMES[t.test_type] || t.test_type}</td>
                    <td class="px-4 py-3 text-sm text-gray-500">${t.test_type}</td>
                    <td class="px-4 py-3">
                        <input type="number" min="1" max="100" value="${t.weekly_target}"
                               class="w-24 border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 th-input"
                               data-type="${t.test_type}">
                    </td>
                    <td class="px-4 py-3 text-xs text-gray-400">${t.updated_at ? new Date(t.updated_at).toLocaleString('zh-CN', { hour12: false }) : '-'}</td>
                </tr>`).join('');

            // 日历编辑(项目 x 周几 勾选)
            const days = [{v:1,n:'周一'},{v:2,n:'周二'},{v:3,n:'周三'},{v:4,n:'周四'},{v:5,n:'周五'},{v:6,n:'周六'},{v:7,n:'周日'}];
            const types = ['tableware','pesticide','oil','leanMeat','pathogen'];
            const calSet = new Set(calendar.filter(c => c.enabled).map(c => `${c.test_type}_${c.day_of_week}`));
            const calRows = types.map(tp => `
                <tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td class="px-4 py-2.5 text-sm font-medium text-gray-800">${TYPE_NAMES[tp]}</td>
                    ${days.map(d => `
                        <td class="px-1 py-2.5 text-center">
                            <input type="checkbox" class="cal-cb w-4 h-4" data-type="${tp}" data-day="${d.v}" ${calSet.has(`${tp}_${d.v}`) ? 'checked' : ''}>
                        </td>`).join('')}
                </tr>`).join('');
            const dayHeader = days.map(d => `<th class="px-1 py-3 text-xs font-semibold text-gray-600 text-center">${d.n}</th>`).join('');

            panel.innerHTML = `
                <div class="space-y-4">
                    <div class="glass p-6">
                        <h2 class="text-2xl font-bold mb-4 border-b pb-2 flex items-center">
                            <i class="fas fa-cog text-blue-600 mr-2"></i>检测频率与日历设置
                        </h2>
                        <div class="bg-blue-50 border border-blue-200 p-4 rounded text-sm text-blue-800">
                            配置各检测项目每周目标频率与每周检测日历。当周实际检测次数低于目标时,「检测频率与月报」页出现风险警告;每日登录自动提示今日项目。
                        </div>
                    </div>

                    <div class="glass p-5">
                        <div class="text-base font-bold text-gray-700 mb-4 flex items-center border-b pb-3">
                            <i class="fas fa-bullseye text-blue-600 mr-2 text-lg"></i>每周检测频率阈值
                        </div>
                        <div class="overflow-x-auto">
                            <table class="min-w-full text-left">
                                <thead>
                                    <tr class="bg-gray-50 border-b border-gray-200">
                                        <th class="px-4 py-3 text-xs font-semibold text-gray-600">项目</th>
                                        <th class="px-4 py-3 text-xs font-semibold text-gray-600">代码</th>
                                        <th class="px-4 py-3 text-xs font-semibold text-gray-600">每周目标次数</th>
                                        <th class="px-4 py-3 text-xs font-semibold text-gray-600">最后更新</th>
                                    </tr>
                                </thead>
                                <tbody>${thRows}</tbody>
                            </table>
                        </div>
                        <div class="pt-4 flex justify-end">
                            <button id="btnSaveThresholds" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center">
                                <i class="fas fa-save mr-2"></i>保存阈值
                            </button>
                        </div>
                    </div>

                    <div class="glass p-5">
                        <div class="text-base font-bold text-gray-700 mb-4 flex items-center border-b pb-3">
                            <i class="fas fa-calendar-alt text-green-600 mr-2 text-lg"></i>每周检测日历
                        </div>
                        <div class="overflow-x-auto">
                            <table class="min-w-full text-left">
                                <thead>
                                    <tr class="bg-gray-50 border-b border-gray-200">
                                        <th class="px-4 py-3 text-xs font-semibold text-gray-600">项目</th>
                                        ${dayHeader}
                                    </tr>
                                </thead>
                                <tbody>${calRows}</tbody>
                            </table>
                        </div>
                        <div class="pt-4 flex justify-end">
                            <button id="btnSaveCalendar" class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 flex items-center">
                                <i class="fas fa-save mr-2"></i>保存日历
                            </button>
                        </div>
                    </div>
                </div>`;

            document.getElementById('btnSaveThresholds').addEventListener('click', async () => {
                const inputs = panel.querySelectorAll('.th-input');
                for (const inp of inputs) {
                    const val = parseInt(inp.value, 10);
                    if (!val || val < 1 || val > 100) {
                        UINotification.error('每周目标次数需为 1-100 的整数');
                        return;
                    }
                    const resp = await fetch(`${API_BASE}/api/frequency/thresholds`, {
                        method: 'PUT', headers: authHeaders(),
                        body: JSON.stringify({ test_type: inp.dataset.type, weekly_target: val })
                    });
                    if (!resp.ok) { const j = await resp.json(); UINotification.error(j.error || '保存失败'); return; }
                }
                UINotification.success('✅ 检测频率阈值已保存');
            });

            document.getElementById('btnSaveCalendar').addEventListener('click', async () => {
                const items = [];
                panel.querySelectorAll('.cal-cb').forEach(cb => {
                    if (cb.checked) items.push({ test_type: cb.dataset.type, day_of_week: Number(cb.dataset.day), enabled: true });
                });
                const resp = await fetch(`${API_BASE}/api/frequency/calendar`, {
                    method: 'PUT', headers: authHeaders(),
                    body: JSON.stringify({ items })
                });
                const j = await resp.json();
                if (!resp.ok) { UINotification.error(j.error || '保存失败'); return; }
                UINotification.success('✅ 检测日历已保存');
            });
        } catch (e) {
            console.error('频率配置渲染失败:', e);
            panel.innerHTML = '<p class="text-sm text-red-500">配置加载失败: ' + e.message + '</p>';
        }
    };

    render();
}

export default { showTodayDetectionHint, renderFrequencyCards, initFrequencySettings, loadDailyReminderBar, refreshDailyReminderBar };