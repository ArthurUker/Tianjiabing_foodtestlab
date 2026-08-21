import { StorageService } from '../core/Storage.js';
import guestAuthService from '../services/GuestAuthService.js';

// TD-EventLeak / TD-EventLeak-Phase2: 模块级 AbortController 与 sync 监听句柄，
// 在 init 重新执行时先注销旧监听，避免监听器随导航/重渲染累加
let _dashboardAbortCtrl = null;
let _dashboardSyncHandlers = [];
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { calculatePathogenRisk } from '../utils/pathogenRisk.js';
import { auditService } from '../services/AuditService.js';
import { isRecordQualifiedByCustomFields, getVisibleTypes, getSchoolCustomization, getSchoolCanteens } from '../utils/schoolCustomization.js';
import { extractSchoolCode } from '../utils/schoolCode.js';
import { getLocalDateStr, getLocalMonthStr, startOfLocalDay, endOfLocalDay } from '../utils/dateUtil.js';

const services = {
    tableware: new StorageService('tableware'),
    pesticide: new StorageService('pesticide'),
    oil: new StorageService('oil'),
    leanMeat: new StorageService('leanMeat'),
    pathogen: new StorageService('pathogen')
};

const DEFAULT_CANTEENS = ['一食堂', '二食堂', '三食堂'];

// RK3：看板应尊重该校 visible_types——未开启的模块不显示统计卡片且不计入总计。
// 缺省回退到全部 5 个模块（与注册中心默认可见集一致）。
function getDashboardVisibleTypes() {
    try {
        const types = getVisibleTypes(getSchoolCustomization(extractSchoolCode()));
        return Array.isArray(types) && types.length ? types : ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    } catch (e) {
        return ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    }
}

// 全局图表对象
let trendChart, canteenChart;
// 趋势图当前指标：'rate' = 合格率，'volume' = 检测量
let trendMetric = 'rate';
// 记录最近一次趋势图的计算范围，供指标切换时重算
let _lastTrendRange = null;
// 统一配色（洋红 / 绿色 / 蓝色），后续按索引复用
const CAN_COLOR_PALETTE = ['#ff00a0', '#4daf4a', '#377eb8', '#8b5cf6', '#ef4444', '#06b6d4', '#a3e635'];
// ✅ 各食堂线型（虚线模式），与颜色叠加区分，避免多条线贴近 100% 时难以分辨
const CAN_DASH_PATTERNS = [[], [8, 4], [2, 4], [7, 3, 2, 3], [10, 3, 2, 3], [4, 4], [1, 3]];
const CANTEEN_TARGET_RATE = 90; // 合格率合格基准线（可按实际要求调整）

export function initDashboard() {
    console.log('📊 Dashboard.initDashboard() 开始执行');
    
    try {
        // 创建增强版看板的HTML结构
        console.log('🔧 调用 createDashboardStructure()...');
        createDashboardStructure();
        console.log('✅ createDashboardStructure() 完成');
        
        // 设置当前日期
        const now = new Date();
        const currentDateEl = document.getElementById('currentDate');
        if (currentDateEl) {
            currentDateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
        }
        
        // 初始化日期选择器默认值
        const dayFilterEl = document.getElementById('dayFilter');
        if (dayFilterEl) {
            dayFilterEl.valueAsDate = now;
        }
        
        const monthFilterEl = document.getElementById('monthFilter');
        if (monthFilterEl) {
            monthFilterEl.value = getLocalMonthStr(now);
        }
        
        // ✅ 初始化周选择器默认值
        const weekValue = getWeekString(now);
        const weekFilterEl = document.getElementById('weekFilter');
        if (weekFilterEl) {
            weekFilterEl.value = weekValue;
        }
        
        // ✅ 初始化食堂选择器
        console.log('🔧 初始化食堂筛选...');
        initCanteenFilter();
        
        // 绑定事件处理器
        // TD-EventLeak: 重新初始化时先注销上一次的监听，避免监听器累加
        _dashboardAbortCtrl?.abort();
        _dashboardAbortCtrl = new AbortController();
        const _dashSignal = _dashboardAbortCtrl.signal;

        const dateFilterType = document.getElementById('dateFilterType');
        if (dateFilterType) {
            dateFilterType.addEventListener('change', updateDateFilterOptions, { signal: _dashSignal });
        }
        
        const btnFilterDashboard = document.getElementById('btnFilterDashboard');
        if (btnFilterDashboard) {
            btnFilterDashboard.addEventListener('click', loadDashboardData, { signal: _dashSignal });
        }

        // ✅ 食堂下拉直接触发过滤，无需点筛选按钮
        const canteenFilterEl = document.getElementById('canteenFilter');
        if (canteenFilterEl) {
            canteenFilterEl.addEventListener('change', loadDashboardData, { signal: _dashSignal });
        }

        // ✅ 趋势图指标切换（合格率 / 检测量）
        const trendMetricRate = document.getElementById('trendMetricRate');
        const trendMetricVolume = document.getElementById('trendMetricVolume');
        const syncTrendMetricBtns = () => {
            [['rate', trendMetricRate], ['volume', trendMetricVolume]].forEach(([m, btn]) => {
                if (!btn) return;
                const active = trendMetric === m;
                btn.classList.toggle('bg-blue-600', active);
                btn.classList.toggle('text-white', active);
                btn.classList.toggle('bg-white', !active);
                btn.classList.toggle('text-gray-600', !active);
            });
        };
        const applyTrendMetric = (m) => {
            trendMetric = m;
            syncTrendMetricBtns();
            if (_lastTrendRange) {
                updateCharts(_lastTrendRange.start, _lastTrendRange.end, _lastTrendRange.canteen);
            }
        };
        if (trendMetricRate) trendMetricRate.addEventListener('click', () => applyTrendMetric('rate'), { signal: _dashSignal });
        if (trendMetricVolume) trendMetricVolume.addEventListener('click', () => applyTrendMetric('volume'), { signal: _dashSignal });
        syncTrendMetricBtns();
        
        // 初始化图表
        console.log('🔧 初始化图表...');
        initCharts();
        
        // 加载初始数据
        console.log('🔧 加载初始数据...');
        // TD-DashboardZero: 首次进入看板前强制 force-sync 各 StorageService，绕过 30s cooldown，
        // 否则冷却期内 getAll() 永远返回上次的 localStorage 缓存，新会话登录会看到一片 0
        // 访客/快速访问模式跳过 pathogen：该模块对访客始终不可见（后端亦返回 403），避免无效请求
        const isGuestLikeForSync = guestAuthService.isLoggedIn() || guestAuthService.isQuickAccessMode();
        const syncServices = isGuestLikeForSync
            ? Object.values(services).filter(s => s.tableName !== 'pathogen')
            : Object.values(services);
        Promise.allSettled(syncServices.map((s) => s._syncFromApi(true))).then(() => {
            loadDashboardData()
        })
        // 即便 Promise.allSettled 触发延迟，也立即同步渲染一次（使用本地缓存）
        loadDashboardData();
        
        // ✨ 快速访问模式：添加后备数据加载
        const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
        if (isQuickAccess) {
            console.log('🎯 Dashboard 快速访问模式：延迟加载统计数据');
            setTimeout(() => {
                console.log('🎯 Dashboard 快速访问模式：执行延迟加载');
                loadDashboardData();
            }, 2500);
        }
        
        // 监听数据变化（用户手动增删改时触发）
        document.addEventListener('dataChanged', loadDashboardData, { signal: _dashSignal });
        
        // P1-20: 使用 CustomEvent 替代 window 全局函数，供导航时刷新调用
        document.addEventListener('dashboard:refresh', () => loadDashboardData(), { signal: _dashSignal });

        // P1-20: 合并多个 StorageService 的 sync 事件，防抖避免 5 次重复刷新看板
        // TD-EventLeak: 先注销上一轮的 sync 监听，再重新注册，避免累加
        _dashboardSyncHandlers.forEach(({ s, fn }) => s.off('sync', fn));
        _dashboardSyncHandlers = [];
        let _syncRefreshTimer = null;
        Object.values(services).forEach(s => {
            const fn = () => {
                if (_syncRefreshTimer) clearTimeout(_syncRefreshTimer);
                _syncRefreshTimer = setTimeout(() => {
                    initCanteenFilter();
                    loadDashboardData();
                }, 200);
            };
            s.on('sync', fn);
            _dashboardSyncHandlers.push({ s, fn });
        });
        
        // 绑定详情链接
        document.querySelectorAll('a[data-target]').forEach(link => {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                const target = this.getAttribute('data-target');
                document.querySelector(`button.nav-btn[data-target="${target}"]`).click();
            }, { signal: _dashSignal });
        });
        
        // 绑定导出看板按钮
        const btnExportDashboard = document.getElementById('btnExportDashboardPDF');
        if (btnExportDashboard) {
            btnExportDashboard.onclick = exportDashboardToPDF;
        }
        
        console.log('✅ Dashboard.initDashboard() 执行完成');
        return true;
    } catch (error) {
        console.error('❌ Dashboard.initDashboard() 执行失败:', error.message, error.stack);
        return false;
    }
}

// ✅ 新增：初始化食堂筛选器
function initCanteenFilter() {
    // TD-CanteenFromConfig: 数据看板的食堂下拉必须先从学校定制配置读取
    // （管理端新增的食堂不可能立刻就有检测记录覆盖），仅从 records 提取会导致
    // 「管理端加了 2 个食堂、看板下拉只显示 1 个」之类的不一致。
    // 优先级：学校定制配置（field_options.canteen / canteens）> records 中实际出现过的食堂 > DEFAULT_CANTEENS。
    const ordered = [];
    const seen = new Set();
    // 1) 先放学校管理控制台配置的食堂（保持管理端排序）
    getSchoolCanteens(extractSchoolCode(), DEFAULT_CANTEENS).forEach(c => {
        const v = String(c || '').trim();
        if (v && !seen.has(v)) { ordered.push(v); seen.add(v); }
    });
    const types = getDashboardVisibleTypes();
    const canteenFilter = document.getElementById('canteenFilter');
    const selectedBefore = canteenFilter?.value || 'all';

    const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';

    // 2) 收集所有出现过的食堂，追加到配置列表（保留历史数据用过的食堂名）
    types.forEach(type => {
        let records;

        if (isQuickAccess) {
            try {
                const cacheKey = `cache_${type}`;
                const cacheData = localStorage.getItem(cacheKey);
                records = cacheData ? JSON.parse(cacheData).data || [] : [];
            } catch (e) {
                console.error('❌ 读取缓存失败:', e);
                records = services[type].getAll();
            }
        } else {
            records = services[type].getAll();
        }

        records.forEach(r => {
            const canteen = getRecordCanteen(r);
            if (canteen && !seen.has(canteen)) { ordered.push(canteen); seen.add(canteen); }
        });
    });

    // 3) 兜底：连配置都没有时使用 DEFAULT_CANTEENS
    if (!ordered.length) DEFAULT_CANTEENS.forEach(c => { if (!seen.has(c)) { ordered.push(c); seen.add(c); } });

    if (canteenFilter) {
        // 添加"全部食堂"选项
        canteenFilter.innerHTML = '<option value="all">全部食堂</option>';

        // 添加实际存在的食堂
        ordered.forEach(canteen => {
            const option = document.createElement('option');
            option.value = canteen;
            option.textContent = canteen;
            canteenFilter.appendChild(option);
        });

        canteenFilter.value = ordered.includes(selectedBefore) ? selectedBefore : 'all';
    }
}

function getRecordCanteen(record) {
    if (!record || typeof record !== 'object') return '';
    // ⚠️ 不再回退 record.location：location 是餐具检测中的"检测点位"（如餐具表面、砧板表面），
    // 不是食堂名称。若 canteen 为空而 location 有值，会把检测点位误当作食堂显示在合格率对比图中。
    return (
        record.canteen ||
        record.canteenName ||
        record.diningHall ||
        ''
    ).toString().trim();
}

function getRecordDateTime(record) {
    if (!record || typeof record !== 'object') return null;

    // 优先使用用户填写的检测日期 testDate，避免 timestamp（入库时间）干扰排序
    const raw = record.testDate || record.timestamp;
    if (!raw) return null;

    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
}

function sortByRecordDateDesc(records = []) {
    return [...records].sort((a, b) => {
        const ta = getRecordDateTime(a)?.getTime() || 0;
        const tb = getRecordDateTime(b)?.getTime() || 0;
        return tb - ta;
    });
}

// ✅ 辅助函数：获取日期的周字符串（格式：2024-W52）
function getWeekString(date) {
    const year = date.getFullYear();
    const oneJan = new Date(year, 0, 1);
    const numberOfDays = Math.floor((date - oneJan) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((numberOfDays + oneJan.getDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

// 导出看板为PDF（浏览器原生打印：质量最高、最接近网页直出）
// 说明：html2canvas 无法渲染 backdrop-filter（磨砂玻璃）且会把文字栅格化发虚；
// 原生打印使用与屏幕一致的真实渲染引擎、矢量文字、真实极光背景、自动精准分页。
// 唯一无法重现的是 backdrop-filter 的模糊层（浏览器打印亦不支持），故打印时玻璃卡改为半透明白透出极光。
async function exportDashboardToPDF() {
    try {
        // 确保数据已加载，避免打印时内容为空。
        // 修复：原代码引用了不存在的 dashboardState.hasLoaded 与 loadAllDashboardData()，
        // 实际加载函数为 loadDashboardData()（幂等，重复调用仅重渲染，无副作用）。
        UINotification.loading('⏳ 正在准备看板数据...');
        await loadDashboardData();
        UINotification.hideLoading();
        // 等待图表绘制完成，避免打印时图表空白
        await new Promise(resolve => setTimeout(resolve, 400));

        // 记录审计日志（失败不影响导出）
        try {
            await auditService.log('export', 'dashboard', 'pdf', '导出数据看板为 PDF');
        } catch (e) { /* 忽略审计失败 */ }

        // 填充打印专用页眉（机构名 + 报告标题 + 动态导出日期）。
        // 页眉置于 createDashboardStructure 生成的 <thead class="print-doc-head"> 内，
        // 借助浏览器对 table-header-group 的原生能力：每页自动重复 + 自动预留顶部空间，
        // 从根本上避免 fixed 页眉跨页遮挡内容的问题。该元素屏幕端隐藏、打印态显示。
        // 页脚页码由 css/style.css 的 @page margin box 实现（Firefox 生效；
        // Chrome/Edge 不支持 @page margin box，可在其打印对话框保留"页眉和页脚"以获得页码，
        // 或用 Firefox 导出以同时获得自定义页眉与页码）。
        const printHeaderEl = document.getElementById('dashboard-print-header');
        if (printHeaderEl) {
            const exp = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const expStr = `${exp.getFullYear()}-${pad(exp.getMonth() + 1)}-${pad(exp.getDate())} ${pad(exp.getHours())}:${pad(exp.getMinutes())}`;
            printHeaderEl.innerHTML =
                '<span class="dh-org">珠海市第一中学</span>' +
                '<span class="dh-title">数据看板导出报告</span>' +
                '<span class="dh-date">导出日期：' + expStr + '</span>';
        }

        // 调起打印/另存为 PDF。请在对话框选择「目标：另存为 PDF」，
        // 并勾选「背景图形 / Background graphics」以保留极光与玻璃卡底色。
        // 同步重绘图表到打印宽度：在 window.print() 之前主动设容器宽度并 resize()，
        // 确保光栅化捕获的是已重绘完成的 canvas（消除异步竞态，避免折线断裂/柱缺失）。
        fitChartsToPrintWidth();

        UINotification.info('ℹ️ 正在打开打印窗口，请选择「另存为 PDF」并勾选「背景图形」');
        window.print();
    } catch (error) {
        console.error('PDF导出失败:', error);
        UINotification.error('❌ PDF 导出失败: ' + (error && error.message ? error.message : error));
    }
}


function createDashboardStructure() {
    const dashboardSection = document.getElementById('dashboard');

    // 访客/快速访问模式不渲染打印导出按钮（避免绕过导出权限）
    const isGuestLike = guestAuthService.isLoggedIn() || guestAuthService.isQuickAccessMode();
    const exportButtonHtml = isGuestLike ? '' : `
        <!-- 🆕 导出按钮 -->
        <button id="btnExportDashboardPDF" class="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm">
            <i class="fas fa-print mr-1"></i>打印 / 另存为 PDF
        </button>
    `;

    // 创建增强版看板HTML
    dashboardSection.innerHTML = `
        <table class="print-doc">
            <thead class="print-doc-head">
                <tr><td><div id="dashboard-print-header"></div></td></tr>
            </thead>
            <tbody>
                <tr><td>
        <div id="dashboard-capture-area" class="glass p-6 mb-6">
            <div class="flex flex-col md:flex-row items-center justify-between gap-4">
                <h2 class="text-2xl font-bold text-gray-800">
                    <i class="fas fa-chart-line text-blue-600 mr-2"></i>数据看板（分类）
                </h2>
                <!-- 筛选控制区 -->
                <div class="flex flex-wrap items-center gap-2" data-html2canvas-ignore="true">
                    <!-- ✅ 食堂筛选 -->
                    <select id="canteenFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        <option value="all">全部食堂</option>
                    </select>
                    
                    <select id="dateFilterType" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        <option value="all">全部数据</option>
                        <option value="day">按日</option>
                        <option value="week">按周</option>
                        <option value="month">按月</option>
                        <option value="range">时间段</option>
                    </select>
                    <div id="dayFilterContainer" class="hidden filter-option">
                        <input type="date" id="dayFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    </div>
                    <div id="weekFilterContainer" class="hidden filter-option">
                        <input type="week" id="weekFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    </div>
                    <div id="monthFilterContainer" class="hidden filter-option">
                        <input type="month" id="monthFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    </div>
                    <div id="rangeFilterContainer" class="hidden filter-option flex items-center">
                        <input type="date" id="startDateFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="开始">
                        <span class="mx-1">-</span>
                        <input type="date" id="endDateFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="结束">
                    </div>
                    <button id="btnFilterDashboard" class="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm">
                        <i class="fas fa-filter mr-1"></i>筛选
                    </button>
                    ${exportButtonHtml}
                </div>
            </div>
            <!-- 1. 统计卡片区域 -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6 mb-6 print-cards">
                <!-- 餐具 -->
                <div class="glass-panel p-4" data-module-card="tableware">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90" data-title-key="dash_tableware">餐具洁净度检测</p>
                            <p class="text-3xl font-bold" id="card_tableware_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_tableware_pass">0%</span></p>
                        </div>
                        <i class="fas fa-utensils text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 农残 -->
                <div class="glass-panel p-4" data-module-card="pesticide">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90" data-title-key="dash_pesticide">果蔬农残检测</p>
                            <p class="text-3xl font-bold" id="card_pesticide_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_pesticide_pass">0%</span></p>
                        </div>
                        <i class="fas fa-leaf text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 食用油 -->
                <div class="glass-panel p-4" data-module-card="oil">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90" data-title-key="dash_oil">食用油品质快检</p>
                            <p class="text-3xl font-bold" id="card_oil_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_oil_pass">0%</span></p>
                        </div>
                        <i class="fas fa-oil-can text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 病原体 -->
                <div class="glass-panel p-4" data-module-card="pathogen">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90" data-title-key="dash_pathogen">食源性细菌/病毒</p>
                            <p class="text-3xl font-bold" id="card_pathogen_count">0</p>
                            <p class="text-xs mt-1">
                                阳性数: <span id="card_pathogen_positive">0</span>
                                <span class="text-xs opacity-75 ml-2" title="Ct≥35通常为环境残留核酸，无需特殊处置">
                                    <i class="fas fa-info-circle"></i>
                                </span>
                            </p>
                        </div>
                        <i class="fas fa-virus text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- ✅ 总数卡片 - 增加总合格率显示 -->
                <div class="glass-panel p-4">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">总检测数</p>
                            <p class="text-3xl font-bold" id="card_total_count">0</p>
                            <p class="text-xs mt-1">
                                <span id="date_range_text">全部数据</span>
                                <br>
                                总合格率: <span id="card_total_pass">0%</span>
                            </p>
                        </div>
                        <i class="fas fa-clipboard-list text-4xl opacity-50"></i>
                    </div>
                </div>
            </div>
            
            <!-- 肉蛋农残分类统计卡片 -->
            <div class="mb-6" data-module-card="leanMeat">
                <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_leanMeat">肉、蛋农残检测</h3>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 print-cards">
                    <!-- 猪肉 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">猪肉</p>
                            <p class="text-2xl font-bold" id="card_lean_pork_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_pork_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 羊肉 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">羊肉</p>
                            <p class="text-2xl font-bold" id="card_lean_mutton_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_mutton_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 牛肉 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">牛肉</p>
                            <p class="text-2xl font-bold" id="card_lean_beef_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_beef_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 禽肉 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">禽肉</p>
                            <p class="text-2xl font-bold" id="card_lean_poultry_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_poultry_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 鱼肉 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">鱼肉</p>
                            <p class="text-2xl font-bold" id="card_lean_fish_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_fish_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 禽蛋 -->
                    <div class="glass-panel p-3">
                        <div class="text-center">
                            <p class="text-xs opacity-90">禽蛋</p>
                            <p class="text-2xl font-bold" id="card_lean_egg_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_egg_pass">0%</span></p>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 2. 概览列表区域 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6 print-grid-2">
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_tableware_overview">餐具洁净度概览 (最新5条)</h3>
                    <ul id="list_tableware_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_pesticide_overview">果蔬农残概览 (最新5条)</h3>
                    <ul id="list_pesticide_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_oil_overview">食用油品质概览 (最新5条)</h3>
                    <ul id="list_oil_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <!-- ✅ 病原体检测概览移到右边 -->
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_pathogen_overview">病原体检测概览 (最新5条)</h3>
                    <ul id="list_pathogen_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
            </div>
            
            <!-- 肉蛋农残分类概览 -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6 print-cards">
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_pork_overview">猪肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_pork_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_mutton_overview">羊肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_mutton_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_beef_overview">牛肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_beef_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_poultry_overview">禽肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_poultry_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_fish_overview">鱼肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_fish_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="glass-panel p-4">
                    <h3 class="font-semibold text-gray-800 mb-3" data-title-key="dash_lean_egg_overview">禽蛋检测概览 (最新5条)</h3>
                    <ul id="list_lean_egg_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
            </div>
            
            <!-- 风险提醒 -->
            <div class="mb-6">
                <h3 class="font-semibold text-gray-800 mb-3">风险提醒</h3>
                <ul id="riskAlerts" class="text-sm text-gray-700 space-y-1 bg-red-50 border border-red-100 p-3 rounded-lg">
                    <li>暂无风险提示</li>
                </ul>
            </div>
            
            <!-- 3. 图表区域 -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 print-grid-3">
                <div class="glass-panel p-4 md:col-span-2">
                    <div class="flex items-center justify-between mb-3 gap-3">
                        <h3 class="font-semibold text-gray-700" id="trendChartTitle">检测趋势</h3>
                        <div class="flex items-center gap-3 flex-wrap justify-end">
                            <div id="trendChartLegend" class="flex items-center gap-3 flex-wrap text-xs text-gray-600"></div>
                            <div class="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs" data-html2canvas-ignore="true">
                                <button id="trendMetricRate" type="button" class="trend-metric-btn px-3 py-1 bg-blue-600 text-white">合格率</button>
                                <button id="trendMetricVolume" type="button" class="trend-metric-btn px-3 py-1 bg-white text-gray-600 hover:bg-gray-100">检测量</button>
                            </div>
                        </div>
                    </div>
                    <p class="text-xs text-gray-400 mb-2" id="trend_chart_caption"></p>
                    <div class="h-96">
                        <canvas id="trendChart"></canvas>
                    </div>
                </div>
                <div class="glass-panel p-4 md:col-span-1">
                    <h3 class="font-semibold mb-3 text-gray-700">各食堂合格率对比</h3>
                    <p class="text-xs text-gray-400 mb-2" id="canteen_chart_caption"></p>
                    <div class="h-96">
                        <canvas id="canteenChart"></canvas>
                    </div>
                </div>
            </div>
            
            <!-- 隐藏当前日期显示，但保留元素以兼容JS -->
            <div class="hidden" id="currentDate"></div>
                </div>
            </td></tr>
            </tbody>
        </table>
    `;
}

// 处理日期筛选选项的显示/隐藏
function updateDateFilterOptions() {
    const filterType = document.getElementById('dateFilterType').value;
    
    // 隐藏所有选项
    document.querySelectorAll('.filter-option').forEach(el => el.classList.add('hidden'));
    
    // 显示选中的选项
    switch (filterType) {
        case 'day':
            document.getElementById('dayFilterContainer').classList.remove('hidden');
            break;
        case 'week':
            document.getElementById('weekFilterContainer').classList.remove('hidden');
            break;
        case 'month':
            document.getElementById('monthFilterContainer').classList.remove('hidden');
            break;
        case 'range':
            document.getElementById('rangeFilterContainer').classList.remove('hidden');
            break;
    }
}

// ✅ 修改：加载看板数据（增加食堂筛选）
function loadDashboardData() {
    // 获取筛选日期范围
    const filterType = document.getElementById('dateFilterType').value;
    let startDate, endDate;
    
    const now = new Date();
    
    switch (filterType) {
        case 'day':
            const day = document.getElementById('dayFilter').value || getLocalDateStr(now);
            // CR-14：以本地时区当日边界为准，避免 YYYY-MM-DD 被按 UTC 解析导致跨天错位
            startDate = startOfLocalDay(new Date(day));
            endDate = endOfLocalDay(new Date(day));
            document.getElementById('date_range_text').textContent = `${day} 当日`;
            break;
            
        case 'week':
            const weekValue = document.getElementById('weekFilter').value || getWeekString(now);
            const weekRange = getWeekRange(weekValue);
            startDate = weekRange.start;
            endDate = weekRange.end;
            document.getElementById('date_range_text').textContent = `${weekRange.text}`;
            break;
            
        case 'month':
            const month = document.getElementById('monthFilter').value || getLocalMonthStr(now);
            startDate = startOfLocalDay(new Date(month + '-01'));
            endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + 1);
            endDate.setDate(0);
            endDate = endOfLocalDay(endDate);
            document.getElementById('date_range_text').textContent = `${month} 月`;
            break;
            
        case 'range':
            const start = document.getElementById('startDateFilter').value;
            const end = document.getElementById('endDateFilter').value;
            if(start && end) {
                // CR-14：区间起止按本地时区当日边界处理
                startDate = startOfLocalDay(new Date(start));
                endDate = endOfLocalDay(new Date(end));
                document.getElementById('date_range_text').textContent = `${start} 至 ${end}`;
            } else {
                startDate = new Date(0);
                endDate = new Date(2099, 11, 31);
            }
            break;
            
        default: // all
            startDate = new Date(0);
            endDate = new Date(2099, 11, 31);
            document.getElementById('date_range_text').textContent = `全部数据`;
    }

    // ✅ 趋势图标题随筛选范围动态变化（避免写死"本月"却显示全部数据造成误解）
    {
        const rangeText = (document.getElementById('date_range_text')?.textContent || '全部数据').trim();
        const trendTitleEl = document.getElementById('trendChartTitle');
        if (trendTitleEl) trendTitleEl.textContent = `检测趋势（${rangeText}）`;
    }

    // ✅ 获取食堂筛选条件
    const selectedCanteen = document.getElementById('canteenFilter')?.value || 'all';

    // RK3：依据 visible_types 显隐看板模块卡片（未开启的模块不显示统计）
    const visibleTypes = getDashboardVisibleTypes();
    ['tableware', 'pesticide', 'oil', 'pathogen', 'leanMeat'].forEach((code) => {
        const card = document.querySelector(`[data-module-card="${code}"]`);
        if (card) card.classList.toggle('hidden', !visibleTypes.includes(code));
    });

    // 统计各模块数据（传入食堂筛选参数）
    const stats = {
        tableware: getStats('tableware', startDate, endDate, selectedCanteen),
        pesticide: getStats('pesticide', startDate, endDate, selectedCanteen),
        oil: getStats('oil', startDate, endDate, selectedCanteen),
        leanMeat: getStats('leanMeat', startDate, endDate, selectedCanteen),
        pathogen: getStats('pathogen', startDate, endDate, selectedCanteen)
    };
    
    // 🎯 DEBUG
    console.log('🎯 Dashboard stats:', stats);

    // 更新卡片显示
    updateCard('tableware', stats.tableware);
    updateCard('pesticide', stats.pesticide);
    updateCard('oil', stats.oil);
    
    // 病原体特殊处理
    const pathogenCountEl = document.getElementById('card_pathogen_count');
    const pathogenPositiveEl = document.getElementById('card_pathogen_positive');
    if(pathogenCountEl) pathogenCountEl.textContent = stats.pathogen.count;
    if(pathogenPositiveEl) pathogenPositiveEl.textContent = stats.pathogen.positiveCount;

    // 获取肉蛋农残分类统计
    const leanMeatByType = getLeanMeatStatsByType(startDate, endDate, selectedCanteen);
    
    // 更新肉蛋农残分类卡片
    updateLeanMeatCards(leanMeatByType);
    
    // 更新肉蛋农残分类概览列表（使用全局数据，不受日期筛选影响）
    const leanMeatByTypeAllTime = getLeanMeatStatsByType(new Date(0), new Date(2099, 11, 31), selectedCanteen);
    updateLeanMeatOverviewLists(leanMeatByTypeAllTime);

    // ✅ 计算总检测数和总合格率（RK3：仅累加可见模块，避免隐藏模块污染总计）
    let totalCount = 0;
    let totalPassed = 0;
    ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']
        .filter((t) => visibleTypes.includes(t))
        .forEach((t) => {
            totalCount += stats[t].count;
            totalPassed += stats[t].passCount;
        });

    const totalPassRate = totalCount > 0 ? Math.round((totalPassed / totalCount) * 100) : null;
    
    document.getElementById('card_total_count').textContent = totalCount;
    document.getElementById('card_total_pass').textContent = totalPassRate !== null ? `${totalPassRate}%` : '—';

    // 更新概览列表（始终显示全局最新5条，不受日期筛选影响，仅受食堂筛选影响）
    const OVERVIEW_START = new Date(0);
    const OVERVIEW_END = new Date(2099, 11, 31);
    updateOverviewList('tableware', getStats('tableware', OVERVIEW_START, OVERVIEW_END, selectedCanteen).records);
    updateOverviewList('pesticide', getStats('pesticide', OVERVIEW_START, OVERVIEW_END, selectedCanteen).records);
    updateOverviewList('oil', getStats('oil', OVERVIEW_START, OVERVIEW_END, selectedCanteen).records);
    updateOverviewList('pathogen', getStats('pathogen', OVERVIEW_START, OVERVIEW_END, selectedCanteen).records);

    // 更新风险提示
    updateRiskAlerts(stats, leanMeatByType);

    // 更新图表
    updateCharts(startDate, endDate, selectedCanteen);
}

// ✅ 修改：获取肉蛋农残分类统计（增加食堂筛选）
function getLeanMeatStatsByType(startDate, endDate, selectedCanteen = 'all') {
    const records = services.leanMeat.getAll();
    const filtered = records.filter(r => {
        const d = getRecordDateTime(r);
        if (!d) return false;

        if (d < startDate || d > endDate) return false;
        
        // ✅ 食堂筛选
        const canteen = getRecordCanteen(r);
        if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return false;
        
        return true;
    });
    
    // 定义肉类类型
    const meatTypes = {
        '猪肉': { count: 0, passCount: 0, records: [] },
        '羊肉': { count: 0, passCount: 0, records: [] },
        '牛肉': { count: 0, passCount: 0, records: [] },
        '禽肉': { count: 0, passCount: 0, records: [] },
        '鱼肉': { count: 0, passCount: 0, records: [] },
        '禽蛋': { count: 0, passCount: 0, records: [] }
    };
    
    filtered.forEach(r => {
        const meatType = r.meatType;
        if (meatTypes[meatType]) {
            meatTypes[meatType].count++;
            meatTypes[meatType].records.push(r);
            
            // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
            // RK21: 统一走 isQualified，含学校自定义字段判定
            if (isQualified('leanMeat', r)) {
                meatTypes[meatType].passCount++;
            }
        }
    });
    
    // 计算合格率，数据为0时返回 null
    Object.keys(meatTypes).forEach(type => {
        const stats = meatTypes[type];
        if (stats.count === 0) {
            stats.passRate = null;
        } else {
            stats.passRate = Math.round((stats.passCount / stats.count) * 100);
        }
    });
    
    return meatTypes;
}

// 修改：更新肉蛋农残分类卡片，数据为0时显示"无"
function updateLeanMeatCards(leanMeatByType) {
    const typeMapping = {
        '猪肉': 'pork',
        '羊肉': 'mutton',
        '牛肉': 'beef',
        '禽肉': 'poultry',
        '鱼肉': 'fish',
        '禽蛋': 'egg'
    };
    
    Object.keys(typeMapping).forEach(cnType => {
        const enType = typeMapping[cnType];
        const stats = leanMeatByType[cnType];
        
        const countEl = document.getElementById(`card_lean_${enType}_count`);
        const passEl = document.getElementById(`card_lean_${enType}_pass`);
        
        if(countEl) countEl.textContent = stats.count;
        if(passEl) {
            if (stats.passRate === null) {
                passEl.textContent = '无';
            } else {
                passEl.textContent = `${stats.passRate}%`;
            }
        }
    });
}

// 新增：更新肉蛋农残分类概览列表
function updateLeanMeatOverviewLists(leanMeatByType) {
    const typeMapping = {
        '猪肉': 'pork',
        '羊肉': 'mutton',
        '牛肉': 'beef',
        '禽肉': 'poultry',
        '鱼肉': 'fish',
        '禽蛋': 'egg'
    };
    
    Object.keys(typeMapping).forEach(cnType => {
        const enType = typeMapping[cnType];
        const records = sortByRecordDateDesc(leanMeatByType[cnType].records);
        
        const listEl = document.getElementById(`list_lean_${enType}_overview`);
        if(!listEl) return;
        
        if (!records.length) {
            listEl.innerHTML = '<li>暂无数据</li>';
            return;
        }
        
        listEl.innerHTML = '';
        const recent = records.slice(0, 5);
        recent.forEach(r => {
            const li = document.createElement('li');
            li.textContent = `${r.testDate} ${getRecordCanteen(r) || '未知食堂'} ${r.result}`;
            listEl.appendChild(li);
        });
    });
}

// ✅ 辅助函数：根据周字符串计算起止日期
function getWeekRange(weekString) {
    const [yearStr, weekStr] = weekString.split('-W');
    const year = parseInt(yearStr);
    const week = parseInt(weekStr);
    
    const jan1 = new Date(year, 0, 1);
    const jan1Day = jan1.getDay() || 7;
    const firstMonday = new Date(year, 0, 1 + (8 - jan1Day) % 7);
    
    const targetMonday = new Date(firstMonday);
    targetMonday.setDate(firstMonday.getDate() + (week - 1) * 7);
    
    const targetSunday = new Date(targetMonday);
    targetSunday.setDate(targetMonday.getDate() + 6);
    targetSunday.setHours(23, 59, 59, 999);
    
    const startStr = `${targetMonday.getMonth() + 1}-${targetMonday.getDate()}`;
    const endStr = `${targetSunday.getMonth() + 1}-${targetSunday.getDate()}`;
    
    return {
        start: targetMonday,
        end: targetSunday,
        text: `第${week}周 (${startStr} 至 ${endStr})`
    };
}

// ✅ 食用油合格率判定（2026-07-23 业务方裁定）：
//    按"品质等级"(colorLevel) 判定，仅"不合格"为不合格；
//    其余（合格 / 警戒 / 其它等级）均视为合格。
//    无 colorLevel 时（如联调测试记录）以 result 兜底。
function isOilQualified(record) {
    const colorLevel = (record.colorLevel || '').toString().trim();
    if (colorLevel) {
        return !colorLevel.includes('不合格');
    }
    const result = (record.result || '').toString().trim();
    return result.includes('合格') && !result.includes('不合格');
}

// ✅ 统一合格率判定（所有统计函数共用，避免各模块口径分叉导致趋势图/卡片/总合格率不一致）
// 业务口径（2026-07-02 业务方裁定）：仅"合格"计为合格；"不合格""警戒"等其余结果均计为不合格
// 注意："不合格"包含"合格"子串，必须先排除"不合格"
function isQualified(type, record) {
    // RK21: 学校自定义字段判定（statRole='result'）与模块原有判定取 AND；
    // 无相关自定义字段配置时恒为 true，不改变原有口径。
    const customVerdict = isRecordQualifiedByCustomFields(type, record);
    if (type === 'tableware') {
        const result = (record.result || '').toString().trim();
        return result.includes('合格') && !result.includes('不合格') && customVerdict;
    }
    if (type === 'pathogen') {
        // ✅ 实时算法，与卡片/风险提示/对比图完全一致（不复用可能过期的 positiveItems 字符串）
        const risk = calculatePathogenRisk(record.positiveDetails || [], record.allTestItems || []);
        return risk.riskLevel === '无风险' && customVerdict;
    }
    if (type === 'oil') {
        return isOilQualified(record) && customVerdict;
    }
    // pesticide / leanMeat / 其它通用类型：仅按 result 判定
    const result = (record.result || '').toString().trim();
    return result.includes('合格') && !result.includes('不合格') && customVerdict;
}

// ✅ 修改：通用统计函数 - 增加食堂筛选参数
function getStats(type, startDate, endDate, selectedCanteen = 'all') {
  // ✨ 快速访问模式：直接从localStorage读取，绕过StorageService缓存
  let records;
  const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
  
  if (isQuickAccess) {
      try {
          const cacheKey = `cache_${type}`;
          const cacheData = localStorage.getItem(cacheKey);
          records = cacheData ? JSON.parse(cacheData).data || [] : [];
          console.log(`📖 快速访问模式: ${type} 从localStorage读取`, records.length, '条记录');
      } catch (e) {
          console.error('❌ 读取缓存失败:', e);
          records = services[type].getAll();
      }
  } else {
      records = services[type].getAll();
  }
  
  const filtered = records.filter(r => {
      const d = getRecordDateTime(r);
      if (!d) return false;

      if (d < startDate || d > endDate) return false;
      
      // ✅ 食堂筛选
            const canteen = getRecordCanteen(r);
            if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return false;
      
      return true;
  });
    const sortedRecords = sortByRecordDateDesc(filtered);

  let count = 0;
  let passCount = 0;
  let positiveCount = 0;

  if (type === 'tableware') {
      // ✅ 修正：与其它类型一致，按"记录(次检测)"计数，而非按 ATP 子点位计数，
      //        避免"检测总数/合格率"单位混用（餐具按点位、其余按记录）
      sortedRecords.forEach(r => {
          count++;
          // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
          // RK21: 统一走 isQualified，含学校自定义字段判定
          if (isQualified('tableware', r)) {
              passCount++;
          }
      });
  } else if (type === 'pathogen') {
      count = sortedRecords.length;
      
      const riskLevels = {
          '高风险': 0,
          '中风险': 0,
          '低风险': 0,
          '极低风险': 0
      };
      
      sortedRecords.forEach(r => {
          const riskAssessment = calculatePathogenRisk(r.positiveDetails || [], r.allTestItems || []);

          // 统一覆盖为算法实时结果，避免历史缓存字段不一致
          r.riskLevel = riskAssessment.riskLevel;
          r.riskReason = riskAssessment.riskReason;
          r.positiveItems = riskAssessment.positiveItemsDisplay;
          r.positiveDetails = riskAssessment.positiveDetails;

          if (riskAssessment.riskLevel !== '无风险') {
              positiveCount++;
          }

          if (r.riskLevel && riskLevels[r.riskLevel] !== undefined) {
              riskLevels[r.riskLevel]++;
          }
      });
      
      passCount = count - positiveCount;
      
      return { 
          count, 
          passCount,
          positiveCount, 
          passRate: count > 0 ? Math.round((passCount / count) * 100) : null,
          records: sortedRecords,
          riskLevels
      };
  } else if (type === 'oil') {
      // ✅ 食用油：按品质等级判定，仅"不合格"为不合格，其余(合格/警戒/其它等级)均合格
      // RK21: 统一走 isQualified，含学校自定义字段判定
      count = sortedRecords.length;
      passCount = sortedRecords.filter(r => isQualified('oil', r)).length;
  } else {
      // ✅ 统一口径：使用 isQualified()，与卡片/对比图/趋势图一致（默认仅"合格"计合格，不依赖 colorLevel 误判）
      count = sortedRecords.length;
      passCount = sortedRecords.filter(r => isQualified(type, r)).length;
  }

  const passRate = count > 0 ? Math.round((passCount / count) * 100) : null;
  return { count, passCount, positiveCount, passRate, records: sortedRecords };
}


function updateCard(type, stats) {
    const countEl = document.getElementById(`card_${type}_count`);
    const passEl = document.getElementById(`card_${type}_pass`);
    if(countEl) countEl.textContent = stats.count;
    if(passEl) passEl.textContent = stats.passRate !== null ? `${stats.passRate}%` : '—';
}

function updateOverviewList(type, records) {
    const listEl = document.getElementById(`list_${type}_overview`);
    if(!listEl) return;

    if (!records.length) {
        listEl.innerHTML = '<li>暂无数据</li>';
        return;
    }

    listEl.innerHTML = '';
    const recent = sortByRecordDateDesc(records).slice(0, 5);
    recent.forEach(r => {
        const li = document.createElement('li');
        let text = '';
        if(type === 'tableware') text = `${r.testDate} ${getRecordCanteen(r) || '未知食堂'} 检测${r.atpPoints?.length || 0}点位`;
        else if(type === 'pesticide') text = `${r.testDate} ${r.vegetableType} ${r.result}`;
        else if(type === 'oil') text = `${r.testDate} ${getRecordCanteen(r) || '未知食堂'} TPM:${r.tpmValue}%`;
        else if(type === 'lean' || type === 'leanMeat') text = `${r.testDate} ${r.meatType} ${r.result}`;
        // ✅ 修改：病原体显示增加食堂信息
        else if(type === 'pathogen') {
            const canteenInfo = getRecordCanteen(r) || '混样检测';
            const positiveInfo = r.positiveItems || '无';
            text = `${r.testDate} ${canteenInfo} ${r.sampleId} ${positiveInfo}`;
        }
        
        li.textContent = text;
        listEl.appendChild(li);
    });
}


// ✅ 修改：更新风险提示函数（增加食堂信息显示）
function updateRiskAlerts(stats, leanMeatByType) {
    const alerts = [];
    
    if (stats.tableware.passRate !== null && stats.tableware.passRate < 90 && stats.tableware.count > 0) {
        alerts.push(`餐具洁净度合格率偏低(${stats.tableware.passRate}%)`);
    }
    
    if (stats.pesticide.passRate !== null && stats.pesticide.passRate < 100 && stats.pesticide.count > 0) {
        alerts.push(`存在农药残留超标蔬果`);
    }
    
    if (stats.oil.passRate !== null && stats.oil.passRate < 95 && stats.oil.count > 0) {
        alerts.push(`食用油品质不合格率较高`);
    }
    
    Object.keys(leanMeatByType).forEach(meatType => {
        const typeStats = leanMeatByType[meatType];
        if (typeStats.passRate !== null && typeStats.passRate < 100 && typeStats.count > 0) {
            alerts.push(`警告：${meatType}检出肉蛋农残阳性样本`);
        }
    });
    
    // ✅ 修改：病原体风险提示 - 增加食堂信息显示
    if (stats.pathogen.positiveCount > 0) {
        const pathogenRecords = stats.pathogen.records || [];
        const pathogenDetails = [];
        
        pathogenRecords.forEach(record => {
            if (record.riskLevel === '无风险') return;
            const positiveDetails = record.positiveDetails || [];
            
            positiveDetails.forEach(detail => {
                pathogenDetails.push({
                    pathogen: detail.pathogen,
                    ct: detail.ct,
                    ctRaw: detail.ctRaw,
                    riskLevel: record.riskLevel,
                    sampleId: record.sampleId,
                    canteen: getRecordCanteen(record) || '混样检测', // ✅ 默认为混样检测
                    testDate: record.testDate
                });
            });
        });
        
        pathogenDetails.sort((a, b) => a.ct - b.ct);
        
        const riskGroups = {
            '高风险': [],
            '中风险': [],
            '低风险': [],
            '极低风险': []
        };
        
        pathogenDetails.forEach(detail => {
            if (riskGroups.hasOwnProperty(detail.riskLevel)) {
                riskGroups[detail.riskLevel].push(detail);
            }
        });
        
        // ✅ 修改：高风险提示格式
        if (riskGroups['高风险'].length > 0) {
            const items = riskGroups['高风险']
                .map(d => `${d.pathogen}(Ct=${d.ctRaw}, ${d.canteen}, ${d.testDate})`)
                .join('；');
            alerts.push(`🔴 高风险警告：${items} - 需立即处置`);
        }
        
        // ✅ 修改：中风险提示格式
        if (riskGroups['中风险'].length > 0) {
            const items = riskGroups['中风险']
                .map(d => `${d.pathogen}(Ct=${d.ctRaw}, ${d.canteen}, ${d.testDate})`)
                .join('；');
            alerts.push(`🟠 中风险提示：${items} - 建议加强消毒`);
        }
        
        // ✅ 修改：低风险提示格式
        if (riskGroups['低风险'].length > 0) {
            const items = riskGroups['低风险']
                .map(d => `${d.pathogen}(Ct=${d.ctRaw}, ${d.canteen})`)
                .join('；');
            alerts.push(`🟡 低风险提示：${items} - 常规消毒即可`);
        }
        
        // ✅ 修改：极低风险提示格式
        if (riskGroups['极低风险'].length > 0) {
            const count = riskGroups['极低风险'].length;
            
            // 按食堂分组统计
            const canteenGroups = {};
            riskGroups['极低风险'].forEach(d => {
                if (!canteenGroups[d.canteen]) {
                    canteenGroups[d.canteen] = [];
                }
                canteenGroups[d.canteen].push(d);
            });
            
            // 生成分食堂的提示信息
            const canteenSummaries = Object.keys(canteenGroups).map(canteen => {
                const items = canteenGroups[canteen];
                const pathogenList = items.slice(0, 2).map(d => `${d.pathogen}(Ct=${d.ctRaw})`).join('、');
                const suffix = items.length > 2 ? ` 等${items.length}项` : '';
                return `${canteen}: ${pathogenList}${suffix}`;
            }).join('；');
            
            alerts.push(`ℹ️ 监测信息：检出微量核酸片段 ${canteenSummaries} - 通常为环境残留，无需特殊处置`);
        }
    }

    const el = document.getElementById('riskAlerts');
    if (alerts.length) {
        el.innerHTML = alerts.map(a => {
            const colorClass = a.includes('🔴') ? 'text-red-700' : 
                              a.includes('🟠') ? 'text-orange-600' : 
                              a.includes('🟡') ? 'text-yellow-600' : 
                              a.includes('ℹ️') ? 'text-blue-600' : 'text-red-700';
            return `<li class="${colorClass} font-bold">• ${a}</li>`;
        }).join('');
    } else {
        el.innerHTML = '<li class="text-green-600">• 暂无风险提示</li>';
    }
}




// ================= 图表逻辑 =================

let dashedPointPluginRegistered = false; // P2-10 阶段A：原 window._dashedPointPluginRegistered 本地化，避免全局暴露
let canteenChartPluginRegistered = false; // "各食堂合格率对比"专用插件（数值标签+基准线）注册标记
let trendTargetLinePluginRegistered = false; // 趋势图：合格基准线 + 空状态提示 插件注册标记

function initCharts() {
    const trendCtx = document.getElementById('trendChart')?.getContext('2d');
    if (window.Chart && !dashedPointPluginRegistered) {
        const dashedPointPlugin = {
            id: 'dashedPointPlugin',
            afterDatasetsDraw(chart) {
                const ctx = chart.ctx;
                chart.data.datasets.forEach((dataset, dsIndex) => {
                    const meta = chart.getDatasetMeta(dsIndex);
                    if (!meta || !meta.data) return;
                    meta.data.forEach((elem, idx) => {
                        const isMissing = dataset._missing && dataset._missing[idx];
                        if (isMissing) {
                            const x = elem.x;
                            const y = elem.y;
                            const r = (Array.isArray(dataset.pointRadius) ? dataset.pointRadius[idx] : (dataset.pointRadius || 3)) || 3;
                            ctx.save();
                            ctx.setLineDash([6, 6]);
                            ctx.strokeStyle = dataset.borderColor || '#000';
                            ctx.lineWidth = 1.5;
                            ctx.beginPath();
                            ctx.arc(x, y, r, 0, Math.PI * 2);
                            ctx.stroke();
                            ctx.restore();
                        }
                    });
                });
            }
        };
        Chart.register(dashedPointPlugin);
        dashedPointPluginRegistered = true;
    }

    // 注册"各食堂合格率对比"专用插件：横向条尾数值标签 + 合格基准线
    if (window.Chart && !canteenChartPluginRegistered) {
        const canteenChartPlugin = {
            id: 'canteenChartPlugin',
            afterDatasetsDraw(chart) {
                const canvas = chart.canvas;
                if (!canvas || canvas.id !== 'canteenChart') return;
                const ctx = chart.ctx;
                const meta = chart.getDatasetMeta(0);
                if (!meta || !meta.data || !meta.data.length) return;
                ctx.save();
                // 条尾数值标签
                ctx.font = 'bold 12px sans-serif';
                ctx.fillStyle = '#374151';
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                meta.data.forEach((bar, i) => {
                    const value = chart.data.datasets[0].data[i];
                    if (value == null) return;
                    ctx.fillText(value + '%', bar.x + 6, bar.y);
                });
                // 合格基准线
                const target = CANTEEN_TARGET_RATE;
                const xPos = chart.scales.x.getPixelForValue(target);
                if (xPos != null && !Number.isNaN(xPos)) {
                    ctx.strokeStyle = '#ef4444';
                    ctx.setLineDash([4, 4]);
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(xPos, chart.chartArea.top);
                    ctx.lineTo(xPos, chart.chartArea.bottom);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#ef4444';
                    ctx.textAlign = 'center';
                    ctx.font = '10px sans-serif';
                    ctx.fillText(`合格线 ${target}%`, xPos, chart.chartArea.top + 10);
                }
                ctx.restore();
            }
        };
        Chart.register(canteenChartPlugin);
        canteenChartPluginRegistered = true;
    }

    // 注册趋势图专用插件：合格率视图绘制 90% 合格基准线；无数据时居中提示
    if (window.Chart && !trendTargetLinePluginRegistered) {
        const trendTargetLinePlugin = {
            id: 'trendTargetLinePlugin',
            afterDatasetsDraw(chart) {
                const canvas = chart.canvas;
                if (!canvas || canvas.id !== 'trendChart') return;
                const ctx = chart.ctx;
                const hasData = chart.data.labels && chart.data.labels.length > 0 &&
                    chart.data.datasets.some(ds => ds.data && ds.data.some(v => v !== null));
                if (!hasData) {
                    ctx.save();
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '13px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('暂无检测数据', (chart.chartArea.left + chart.chartArea.right) / 2, (chart.chartArea.top + chart.chartArea.bottom) / 2);
                    ctx.restore();
                    return;
                }
                if (trendMetric !== 'rate') return;
                const target = CANTEEN_TARGET_RATE;
                const yPos = chart.scales.y.getPixelForValue(target);
                if (yPos == null || Number.isNaN(yPos)) return;
                ctx.save();
                ctx.strokeStyle = '#ef4444';
                ctx.setLineDash([4, 4]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(chart.chartArea.left, yPos);
                ctx.lineTo(chart.chartArea.right, yPos);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ef4444';
                ctx.textAlign = 'left';
                ctx.font = '10px sans-serif';
                ctx.fillText(`合格线 ${target}%`, chart.chartArea.left + 4, yPos - 4);
                ctx.restore();
            }
        };
        Chart.register(trendTargetLinePlugin);
        trendTargetLinePluginRegistered = true;
    }
    if (trendCtx) {
        trendChart = new Chart(trendCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: []
            },
            options: { 
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const ds = context.dataset || {};
                                const val = context.parsed && context.parsed.y !== undefined ? context.parsed.y : context.raw;
                                const missing = ds._missing && ds._missing[context.dataIndex];
                                if (missing || val === null || val === undefined) return `${ds.label}: 无检测`;
                                if (ds._metric === 'volume') return `${ds.label}: ${val} 次检测`;
                                const n = ds._totals ? (ds._totals[context.dataIndex] || 0) : 0;
                                return `${ds.label}: ${val}% （检测 ${n} 次）`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { autoSkip: true, autoSkipPadding: 16, maxRotation: 0, minRotation: 0 }
                    },
                    y: { 
                        beginAtZero: true, 
                        max: 110,
                        ticks: {
                            callback: function(value) { return (value <= 100) ? value : null; }
                        }
                    }
                }
            }
        });
    }

    const canteenCtx = document.getElementById('canteenChart')?.getContext('2d');
    if (canteenCtx) {
        canteenChart = new Chart(canteenCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{ label: '合格率%', data: [], backgroundColor: [], borderColor: [], borderWidth: [] }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y', // 横向条形图，更适配窄列、更易读
                layout: { padding: { right: 38 } }, // 给条尾数值标签留空间
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const v = context.parsed && context.parsed.x !== undefined ? context.parsed.x : context.raw;
                                return `合格率: ${v}%`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        max: 110,
                        ticks: { callback: function(value) { return value <= 100 ? value : null; } }
                    },
                    y: { grid: { display: false } }
                }
            }
        });
    }

    // 打印态图表尺寸：主重绘路径在 exportDashboardToPDF 内【同步】完成（见 fitChartsToPrintWidth），
    // 此处仅注册 afterprint 恢复屏幕态 + matchMedia('print') 兜底（覆盖用户直接 Ctrl/Cmd+P 的场景）。
    // 不再使用 beforeprint + setTimeout：setTimeout 是宏任务，不保证在打印引擎光栅化前执行 → 竞态致图表残缺。
    // resize 只重绘 canvas 位图，不影响 DOM 结构/页眉重复(table-header-group)/卡片居中/末页空白。
    if (!initCharts._printBound) {
        window.addEventListener('afterprint', restoreChartsToScreen);
        if (window.matchMedia) {
            const mql = window.matchMedia('print');
            const onMql = (e) => { if (e.matches) fitChartsToPrintWidth(); else restoreChartsToScreen(); };
            if (mql.addEventListener) mql.addEventListener('change', onMql);
            else if (mql.addListener) mql.addListener(onMql);
        }
        initCharts._printBound = true;
    }
}

// 打印态图表尺寸同步控制：用 JS 主动把图表容器宽度设为目标打印宽度(内联 style)，
// 再【同步】调用 chart.resize()（Chart.js 的 resize 同步重绘，含 afterDatasetsDraw 插件标签），
// 确保 window.print() 触发光栅化时捕获的是【已重绘完成】的 canvas（彻底消除异步竞态）。
// 若不主动设宽，resize 时容器仍是屏幕宽，打印态又被 @media print 缩放 → 仍压扁/残缺，故必须此处内联设宽。
function fitChartsToPrintWidth() {
    const W = 318; // A4 纵向双列网格下单卡图表目标宽度(px)，使 canvas 位图宽高比≈显示宽高比(≈1:1)
    [trendChart, canteenChart].forEach((ch) => {
        if (!ch || !ch.canvas) return;
        const wrap = ch.canvas.parentNode; // .h-96 容器
        if (wrap) { wrap.style.width = W + 'px'; ch.resize(); }
    });
}
function restoreChartsToScreen() {
    [trendChart, canteenChart].forEach((ch) => {
        if (!ch || !ch.canvas) return;
        const wrap = ch.canvas.parentNode;
        if (wrap) { wrap.style.width = ''; ch.resize(); }
    });
}

// ✅ 修改：更新图表（增加食堂筛选参数）
function updateCharts(startDate, endDate, selectedCanteen = 'all') {
    if (!startDate || !endDate) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        startDate = new Date(currentYear, currentMonth, 1);
        endDate = new Date(currentYear, currentMonth + 1, 0);
        endDate.setHours(23, 59, 59, 999);
    }

    // 记录本次范围，供指标切换时重算
    _lastTrendRange = { start: startDate, end: endDate, canteen: selectedCanteen };

    const trendData = calculateCanteenTrends(startDate, endDate, selectedCanteen, trendMetric);
    if (trendChart) {
        trendChart.data.labels = trendData.labels;

        const palette = CAN_COLOR_PALETTE;
        const canteenNames = Object.keys(trendData.datasets || {});
        trendChart.data.datasets = canteenNames.map((name, idx) => {
            const color = palette[idx % palette.length];
            const values = trendData.datasets[name] || [];
            const totals = (trendData.totals && trendData.totals[name]) || values.map(() => 0);
            const missingFlags = (trendData.missing && trendData.missing[name]) || values.map(v => v === null);
            return {
                label: name,
                data: values,
                borderColor: color,
                backgroundColor: color + '22',
                borderWidth: 2.5,
                // ✅ 线型区分：每条食堂线叠加不同虚线模式，贴近 100% 时也能分辨
                borderDash: CAN_DASH_PATTERNS[idx % CAN_DASH_PATTERNS.length],
                tension: 0.3,
                fill: false,
                spanGaps: true,
                segment: {
                    borderDash: ctx => {
                        try {
                            const p0idx = ctx.p0.index;
                            const p1idx = ctx.p1.index;
                            const m0 = ctx.dataset._missing && ctx.dataset._missing[p0idx];
                            const m1 = ctx.dataset._missing && ctx.dataset._missing[p1idx];
                            if (m0 || m1) return [6, 6];
                        } catch (e) {}
                        return undefined;
                    }
                },
                // ✅ 点更小、更清爽；无检测点不绘制。合格率视图下样本量<n的桶点略小，提示读者谨慎采信
                pointRadius: values.map((v, i) => {
                    if (v === null) return 0;
                    if (trendMetric === 'volume') return 2.5;
                    const n = totals[i] || 0;
                    return (n > 0 && n < 5) ? 2 : 3;
                }),
                pointHoverRadius: values.map(v => (v === null ? 0 : 5)),
                pointHitRadius: values.map(v => (v === null ? 8 : 6)),
                _missing: missingFlags,
                _totals: totals,
                _metric: trendMetric
            };
        });

        // ✅ 自定义 HTML 图例（带圆点的各食堂），放在标题栏切换按钮左侧，随数据集同步
        const legendContainer = document.getElementById('trendChartLegend');
        if (legendContainer) {
            legendContainer.innerHTML = canteenNames.map((name, idx) => {
                const color = palette[idx % palette.length];
                return `<span class="inline-flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-full" style="background:${color}"></span>${name}</span>`;
            }).join('');
        }

        // ✅ 根据指标切换 y 轴（合格率 0~110；检测量 从 0 自适应）
        const yScale = trendChart.options.scales.y;
        if (trendMetric === 'rate') {
            yScale.beginAtZero = true;
            yScale.min = 0;
            yScale.max = 110;
            yScale.ticks.callback = function(value) { return (value <= 100) ? value : null; };
        } else {
            yScale.beginAtZero = true;
            yScale.min = 0;
            yScale.max = undefined;
            yScale.ticks.callback = function(value) { return value; };
        }

        trendChart.update();
    }

    // ✅ 在趋势图下方标注当前聚合粒度，让"平滑"被理解为区间聚合而非原始日数据
    const captionEl = document.getElementById('trend_chart_caption');
    if (captionEl) {
        const g = trendData.granularity;
        const gText = g === 'daily' ? '按日聚合，每点 = 当日合格率'
            : (g === 'weekly' ? '按周聚合，每点 = 当周合格率' : '按月聚合，每点 = 当月合格率');
        captionEl.textContent = `${gText}（悬停查看样本量与具体数值）`;
    }

    // 在"各食堂合格率对比"图上方标注当前时间范围（复用总卡片的 date_range_text）
    const canteenCaptionEl = document.getElementById('canteen_chart_caption');
    if (canteenCaptionEl) {
        const rangeText = document.getElementById('date_range_text')?.textContent || '';
        canteenCaptionEl.textContent = rangeText ? `${rangeText} · 按当前范围汇总` : '按当前范围汇总';
    }

    const canteenResult = calculateCanteenPassRate(startDate, endDate, selectedCanteen);
    if(canteenChart) {
        // 按合格率降序排序，便于直观排名
        const paired = canteenResult.labels.map((name, i) => ({ name, rate: canteenResult.data[i] }));
        paired.sort((a, b) => b.rate - a.rate);
        const sortedLabels = paired.map(p => p.name);
        const sortedData = paired.map(p => p.rate);

        canteenChart.data.labels = sortedLabels;
        canteenChart.data.datasets[0].data = sortedData;
        // 选中具体食堂时仍展示全部食堂，仅高亮所选；否则用调色板原色
        const selected = canteenResult.selected;
        canteenChart.data.datasets[0].backgroundColor = sortedLabels.map((name, i) => {
            const base = CAN_COLOR_PALETTE[i % CAN_COLOR_PALETTE.length];
            return (selected !== 'all' && name === selected) ? base : base + '40';
        });
        canteenChart.data.datasets[0].borderColor = sortedLabels.map((name, i) => {
            const base = CAN_COLOR_PALETTE[i % CAN_COLOR_PALETTE.length];
            return (selected !== 'all' && name === selected) ? base : base + '99';
        });
        canteenChart.data.datasets[0].borderWidth = sortedLabels.map((name) =>
            (selected !== 'all' && name === selected) ? 3 : 1
        );
        canteenChart.update();
    }
}


// ✅ 重写：计算食堂趋势（自适应粒度 + 统一合格率口径 + 空桶留空不填 100）
// metric: 'rate' = 合格率(%)，'volume' = 检测量(次数)
function calculateCanteenTrends(startDate, endDate, selectedCanteen = 'all', metric = 'rate') {
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];

    // 1) 按时间范围选择聚合粒度，减少点数、降低线密度
    const spanDays = Math.round((endDate - startDate) / 86400000) + 1;
    const granularity = spanDays <= 31 ? 'daily' : (spanDays <= 150 ? 'weekly' : 'monthly');

    function bucketOf(dateStr) {
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) return null;
        const y = d.getFullYear();
        if (granularity === 'daily') {
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return { key: `${y}-${m}-${day}`, label: `${d.getMonth() + 1}-${d.getDate()}` };
        }
        if (granularity === 'weekly') {
            const oneJan = new Date(y, 0, 1);
            const week = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
            return { key: `${y}-W${String(week).padStart(2, '0')}`, label: `${y}第${week}周` };
        }
        const m = String(d.getMonth() + 1).padStart(2, '0');
        return { key: `${y}-${m}`, label: `${y}-${d.getMonth() + 1}` };
    }

    const canteenData = {};   // canteen -> periodKey -> { passed, total }
    const periodMeta = {};    // periodKey -> label

    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(record => {
            const recordDate = record.testDate || (record.timestamp ? record.timestamp.split('T')[0] : null);
            if (!recordDate) return;

            const testDate = new Date(recordDate + 'T00:00:00');
            if (testDate < startDate || testDate > endDate) return;

            const canteen = getRecordCanteen(record) || '未知食堂';
            if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return;

            const bucket = bucketOf(recordDate);
            if (!bucket) return;
            periodMeta[bucket.key] = bucket.label;

            if (!canteenData[canteen]) canteenData[canteen] = {};
            if (!canteenData[canteen][bucket.key]) canteenData[canteen][bucket.key] = { passed: 0, total: 0 };

            canteenData[canteen][bucket.key].total++;
            if (isQualified(type, record)) {
                canteenData[canteen][bucket.key].passed++;
            }
        });
    });

    // TD-CanteenFromConfig: 趋势图同样要把「学校管理端配置的食堂」纳入画图范围，否则
    // 新增的食堂在没产生数据前不会出现在折线中，与下拉筛选形成不一致。
    const configuredCanteens = getSchoolCanteens(extractSchoolCode(), DEFAULT_CANTEENS);
    const allCanteens = Array.from(new Set([...configuredCanteens, ...Object.keys(canteenData)]));
    const canteens = allCanteens.length ? allCanteens : DEFAULT_CANTEENS;

    // 2) 仅保留"至少一家食堂有检测"的时间桶，避免空轴与 100% 平板假象
    const periodKeys = Array.from(new Set(
        canteens.flatMap(c => Object.keys(canteenData[c] || {}))
    )).sort();

    const finalLabels = periodKeys.map(k => periodMeta[k]);
    const finalDatasets = {};
    const finalMissing = {};
    const finalTotals = {};   // ✅ 每个桶的检测次数（样本量），供 tooltip 展示、避免"n=1 的 100%"被误读为稳健
    canteens.forEach(c => {
        finalDatasets[c] = periodKeys.map(k => {
            const b = canteenData[c] && canteenData[c][k];
            if (!b || b.total === 0) return null;
            return metric === 'rate'
                ? Math.round((b.passed / b.total) * 100)
                : b.total;
        });
        finalMissing[c] = periodKeys.map(k => !(canteenData[c] && canteenData[c][k] && canteenData[c][k].total > 0));
        finalTotals[c] = periodKeys.map(k => {
            const b = canteenData[c] && canteenData[c][k];
            return (b && b.total > 0) ? b.total : 0;
        });
    });

    return { labels: finalLabels, datasets: finalDatasets, missing: finalMissing, totals: finalTotals, metric, granularity };
}


// ✅ 修改：计算食堂合格率（增加食堂筛选）
function calculateCanteenPassRate(startDate, endDate, selectedCanteen = 'all') {
    const canteenSet = new Set();
    const types = getDashboardVisibleTypes();
    
    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(r => {
            if (startDate && endDate) {
                const testDate = r.testDate || (r.timestamp ? r.timestamp.split('T')[0] : null);
                if (!testDate) return;
                const d = new Date(testDate);
                if (d < startDate || d > endDate) return;
            }
            
            // ✅ 食堂筛选
            const canteen = getRecordCanteen(r);
            // 对比图始终纳入全部食堂（不受 selectedCanteen 过滤），仅用于高亮所选
            if (canteen) canteenSet.add(canteen);
        });
    });

    // TD-CanteenFromConfig: 对比图也必须把「学校管理端配置的食堂」纳入范围，
    // 与下拉/趋势图保持一致。
    const configuredCanteens = getSchoolCanteens(extractSchoolCode(), DEFAULT_CANTEENS);
    const allCanteens = Array.from(new Set([...configuredCanteens, ...Array.from(canteenSet)]));
    const canteens = allCanteens.length ? allCanteens : DEFAULT_CANTEENS;

    const stats = {};
    canteens.forEach(canteen => {
        stats[canteen] = { passed: 0, total: 0 };
    });

    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(record => {
            if (startDate && endDate) {
                const testDate = record.testDate || (record.timestamp ? record.timestamp.split('T')[0] : null);
                if (!testDate) return;
                const d = new Date(testDate);
                if (d < startDate || d > endDate) return;
            }
            
            const canteen = getRecordCanteen(record);
            if (!canteen || !stats[canteen]) return;

            // ✅ 统一口径（isQualified）：与卡片/趋势图完全一致，避免合格率算法分叉
            stats[canteen].total++;
            if (isQualified(type, record)) {
                stats[canteen].passed++;
            }
        });
    });

    const labels = [];
    const data = [];
    canteens.forEach(canteen => {
        labels.push(canteen);
        const rate = stats[canteen].total > 0 ? Math.round((stats[canteen].passed / stats[canteen].total) * 100) : 0;
        data.push(rate);
    });

    return { labels, data, selected: selectedCanteen };
}

// P1-20: 移除 window.initDashboard 全局暴露，main.js 已通过 import 使用
