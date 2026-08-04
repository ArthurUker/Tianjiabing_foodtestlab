// N1/N2/N3: 检测频率阈值 / 检测日历 / 检测月报 前端模块
// - 每日登录提示今日检测项目(N2)
// - Dashboard 风险警告卡片 + 月报摘要(N1 + N3)
// - 检测日历配置页(manager+)(N2) + 频率阈值配置(manager+)(N1)
import { UINotification } from '../utils/UINotification.js';

const API_BASE = window.API_BASE || '';

function authHeaders() {
    const token = localStorage.getItem('auth_token') || localStorage.getItem('auth_token__' + extractSchoolCode()) || '';
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

function extractSchoolCode() {
    try {
        const m = location.pathname.match(/\/([^/]+)\/index\.html/);
        return m ? m[1] : '';
    } catch (e) { return ''; }
}

function currentUser() {
    try {
        const raw = localStorage.getItem('current_user') || localStorage.getItem('current_user__' + extractSchoolCode());
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function isManagerOrAbove() {
    const u = currentUser();
    return u && (u.role === 'manager' || u.role === 'admin');
}

// ========== N2: 每日登录提示今日检测项目 ==========
export async function showTodayDetectionHint() {
    try {
        const resp = await fetch(`${API_BASE}/api/frequency/today`, { headers: authHeaders() });
        const json = await resp.json();
        if (!json.success) return;
        const items = (json.data && json.data.items) || [];
        if (!items.length) return;
        // 当日已有记录则不再提示(避免重复打扰)
        const todayKey = `today_hint_${extractSchoolCode()}_${new Date().toISOString().slice(0, 10)}`;
        if (sessionStorage.getItem(todayKey)) return;
        sessionStorage.setItem(todayKey, '1');
        const names = items.map(i => i.name).join('、');
        setTimeout(() => {
            UINotification.info(`📅 今日待检测: ${names}`);
        }, 1200);
    } catch (e) {
        console.warn('今日检测提示获取失败:', e.message);
    }
}

// ========== N1 + N3: 渲染 Dashboard 风险警告 + 月报摘要 ==========
export async function renderFrequencyCards(container) {
    try {
        const resp = await fetch(`${API_BASE}/api/frequency/overview`, { headers: authHeaders() });
        const json = await resp.json();
        if (!json.success) return;
        const { items, trend } = json.data || { items: [], trend: [] };

        // 风险警告卡片(N1)
        const warnings = items.filter(i => i.warning);
        const warningHtml = warnings.length
            ? warnings.map(w => `
                <div class="flex items-center justify-between px-4 py-2 bg-red-50 border-l-4 border-red-500 rounded-r">
                    <div class="flex items-center gap-2">
                        <i class="fas fa-exclamation-triangle text-red-500"></i>
                        <span class="text-sm text-red-700">${w.name} 本周 ${w.week_count} 次 < 目标 ${w.weekly_target} 次</span>
                    </div>
                    <span class="text-xs text-red-500 font-semibold">检测频率不足</span>
                </div>`).join('')
            : `<div class="px-4 py-2 bg-green-50 border-l-4 border-green-500 rounded-r">
                    <span class="text-sm text-green-700"><i class="fas fa-check-circle mr-1"></i>本周各项目检测频率均达标</span>
               </div>`;

        // 月报摘要表(N3)
        const rowsHtml = items.map(i => {
            const chg = i.change_pct > 0 ? `<span class="text-green-600">↑ ${i.change_pct}%</span>`
                : i.change_pct < 0 ? `<span class="text-red-600">↓ ${Math.abs(i.change_pct)}%</span>`
                : `<span class="text-gray-500">→ 0%</span>`;
            const warn = i.warning ? '<i class="fas fa-exclamation-triangle text-red-500 ml-1" title="本周不达标"></i>' : '';
            return `<tr>
                <td class="px-3 py-1.5 text-sm text-gray-700">${i.name}${warn}</td>
                <td class="px-3 py-1.5 text-sm text-gray-700 text-center">${i.this_month}</td>
                <td class="px-3 py-1.5 text-sm text-gray-700 text-center">${i.prev_month}</td>
                <td class="px-3 py-1.5 text-sm text-center">${chg}</td>
                <td class="px-3 py-1.5 text-sm text-gray-500 text-center">${i.weekly_target}</td>
            </tr>`;
        }).join('');

        // 趋势图(近6个月, 手绘 SVG 折线)
        let trendSvg = '';
        if (trend.length >= 2) {
            const types = ['tableware', 'pesticide', 'oil', 'lean_meat', 'pathogen'];
            const W = 560, H = 180, pad = 30;
            const months = trend.map(t => t.month);
            const maxVal = Math.max(5, ...trend.flatMap(t => types.map(tp => t.counts[tp] || 0)));
            const color = { tableware: '#3b82f6', pesticide: '#10b981', oil: '#f59e0b', lean_meat: '#ef4444', pathogen: '#8b5cf6' };
            const paths = types.map(tp => {
                const pts = trend.map((t, i) => {
                    const x = pad + (i * (W - 2 * pad)) / Math.max(1, trend.length - 1);
                    const y = H - pad - ((t.counts[tp] || 0) / maxVal) * (H - 2 * pad);
                    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
                }).join(' ');
                return `<path d="${pts}" fill="none" stroke="${color[tp]}" stroke-width="2" />`;
            }).join('');
            const monthLabels = months.map((m, i) => {
                const x = pad + (i * (W - 2 * pad)) / Math.max(1, trend.length - 1);
                return `<text x="${x}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6b7280">${m}</text>`;
            }).join('');
            const legend = types.map(tp => `<span class="inline-flex items-center gap-1 mr-3 text-xs text-gray-600"><span style="width:10px;height:10px;background:${color[tp]};display:inline-block;border-radius:2px"></span>${({tableware:'餐具',pesticide:'农残',oil:'油',lean_meat:'肉蛋',pathogen:'病原'})[tp]}</span>`).join('');
            trendSvg = `<div class="mt-4">
                <div class="text-xs text-gray-500 font-semibold mb-1">近 6 个月检测次数趋势</div>
                <div class="mb-1">${legend}</div>
                <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto">
                    ${paths}${monthLabels}
                </svg>
            </div>`;
        }

        container.innerHTML = `
            <div class="mb-3">
                <h3 class="text-sm font-bold text-gray-700 mb-2"><i class="fas fa-chart-line text-blue-600 mr-1"></i>检测频率与月报</h3>
                ${warningHtml}
            </div>
            <div class="overflow-x-auto">
                <table class="min-w-full text-left border border-gray-200 rounded overflow-hidden">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-3 py-2 text-xs font-semibold text-gray-600">项目</th>
                            <th class="px-3 py-2 text-xs font-semibold text-gray-600 text-center">本月次数</th>
                            <th class="px-3 py-2 text-xs font-semibold text-gray-600 text-center">上月次数</th>
                            <th class="px-3 py-2 text-xs font-semibold text-gray-600 text-center">环比</th>
                            <th class="px-3 py-2 text-xs font-semibold text-gray-600 text-center">周目标</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">${rowsHtml}</tbody>
                </table>
            </div>
            ${trendSvg}`;
    } catch (e) {
        console.warn('检测频率卡片渲染失败:', e.message);
        container.innerHTML = '<div class="text-sm text-gray-400">检测频率数据加载失败</div>';
    }
}

// ========== N1 + N2: 检测频率与日历配置页(manager+) ==========
export function initFrequencySettings() {
    if (!isManagerOrAbove()) return;
    const panel = document.getElementById('frequency-settings-panel');
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

            // 阈值编辑(每项目一行)
            const thRows = thresholds.map(t => `
                <tr>
                    <td class="px-3 py-2 text-sm text-gray-700">${({tableware:'餐具洁净度',pesticide:'果蔬农残',oil:'食用油',lean_meat:'肉蛋农残',pathogen:'病原体'})[t.test_type] || t.test_type}</td>
                    <td class="px-3 py-2">
                        <input type="number" min="1" max="100" value="${t.weekly_target}"
                               class="w-20 px-2 py-1 border border-gray-300 rounded text-sm th-input" data-type="${t.test_type}">
                    </td>
                </tr>`).join('');

            // 日历编辑(项目 x 周几 勾选)
            const days = [{v:1,n:'周一'},{v:2,n:'周二'},{v:3,n:'周三'},{v:4,n:'周四'},{v:5,n:'周五'},{v:6,n:'周六'},{v:7,n:'周日'}];
            const types = ['tableware','pesticide','oil','lean_meat','pathogen'];
            const typeNames = {tableware:'餐具洁净度',pesticide:'果蔬农残',oil:'食用油',lean_meat:'肉蛋农残',pathogen:'病原体'};
            const calSet = new Set(calendar.filter(c => c.enabled).map(c => `${c.test_type}_${c.day_of_week}`));
            const calRows = types.map(tp => `
                <tr>
                    <td class="px-3 py-1.5 text-sm text-gray-700">${typeNames[tp]}</td>
                    ${days.map(d => `
                        <td class="px-1 py-1.5 text-center">
                            <input type="checkbox" class="cal-cb" data-type="${tp}" data-day="${d.v}" ${calSet.has(`${tp}_${d.v}`) ? 'checked' : ''}>
                        </td>`).join('')}
                </tr>`).join('');
            const dayHeader = days.map(d => `<th class="px-1 py-2 text-xs font-semibold text-gray-600 text-center">${d.n}</th>`).join('');

            panel.innerHTML = `
                <div class="space-y-6">
                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-bullseye text-blue-600 mr-1"></i>每周检测频率阈值</h3>
                        <p class="text-xs text-gray-500 mb-3">某项目当周实际检测次数低于目标时,主界面出现风险警告。</p>
                        <table class="min-w-full text-left border border-gray-200 rounded overflow-hidden">
                            <thead class="bg-gray-50"><tr>
                                <th class="px-3 py-2 text-xs font-semibold text-gray-600">项目</th>
                                <th class="px-3 py-2 text-xs font-semibold text-gray-600">每周目标次数</th>
                            </tr></thead>
                            <tbody class="divide-y divide-gray-100">${thRows}</tbody>
                        </table>
                        <button id="btnSaveThresholds" class="mt-3 px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition">保存阈值</button>
                    </div>

                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <h3 class="text-sm font-bold text-gray-700 mb-3"><i class="fas fa-calendar-alt text-green-600 mr-1"></i>每周检测日历</h3>
                        <p class="text-xs text-gray-500 mb-3">安排各检测项目在每周哪几天执行;每日登录自动提示今日项目。</p>
                        <table class="min-w-full text-left border border-gray-200 rounded overflow-hidden">
                            <thead class="bg-gray-50"><tr>
                                <th class="px-3 py-2 text-xs font-semibold text-gray-600">项目</th>
                                ${dayHeader}
                            </tr></thead>
                            <tbody class="divide-y divide-gray-100">${calRows}</tbody>
                        </table>
                        <button id="btnSaveCalendar" class="mt-3 px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition">保存日历</button>
                    </div>
                </div>`;

            // 事件绑定
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

export default { showTodayDetectionHint, renderFrequencyCards, initFrequencySettings };
