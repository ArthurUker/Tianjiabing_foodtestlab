import { StorageService } from '../core/Storage.js';

// TD-EventLeak / TD-EventLeak-Phase2: 模块级 AbortController 与 sync 监听句柄，
// 在 init 重新执行时先注销旧监听，避免监听器随导航/重渲染累加
let _dashboardAbortCtrl = null;
let _dashboardSyncHandlers = [];
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { calculatePathogenRisk } from '../utils/pathogenRisk.js';
import { auditService } from '../services/AuditService.js';

const services = {
    tableware: new StorageService('tableware'),
    pesticide: new StorageService('pesticide'),
    oil: new StorageService('oil'),
    leanMeat: new StorageService('leanMeat'),
    pathogen: new StorageService('pathogen')
};

const DEFAULT_CANTEENS = ['一食堂', '二食堂', '三食堂'];

// 全局图表对象
let trendChart, canteenChart;
// 统一配色（洋红 / 绿色 / 蓝色），后续按索引复用
const CAN_COLOR_PALETTE = ['#ff00a0', '#4daf4a', '#377eb8', '#8b5cf6', '#ef4444', '#06b6d4', '#a3e635'];

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
            monthFilterEl.value = now.toISOString().substring(0, 7);
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
        
        // 初始化图表
        console.log('🔧 初始化图表...');
        initCharts();
        
        // 加载初始数据
        console.log('🔧 加载初始数据...');
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
    const canteenSet = new Set();
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    const canteenFilter = document.getElementById('canteenFilter');
    const selectedBefore = canteenFilter?.value || 'all';
    
    const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
    
    // 收集所有出现过的食堂
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
            if (canteen) canteenSet.add(canteen);
        });
    });

    if (canteenSet.size === 0) {
        DEFAULT_CANTEENS.forEach(c => canteenSet.add(c));
    }

    if (canteenFilter) {
        // 添加"全部食堂"选项
        canteenFilter.innerHTML = '<option value="all">全部食堂</option>';
        
        // 添加实际存在的食堂
        Array.from(canteenSet).sort().forEach(canteen => {
            const option = document.createElement('option');
            option.value = canteen;
            option.textContent = canteen;
            canteenFilter.appendChild(option);
        });

        canteenFilter.value = Array.from(canteenSet).includes(selectedBefore) ? selectedBefore : 'all';
    }
}

function getRecordCanteen(record) {
    if (!record || typeof record !== 'object') return '';
    return (
        record.canteen ||
        record.location ||
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

// 导出看板为PDF
async function exportDashboardToPDF() {
    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
        UINotification.warning('⚠️ PDF库正在加载中，请稍后再试');
        return;
    }

    const element = document.getElementById('dashboard-capture-area');
    if (!element) {
        UINotification.error('❌ 未找到要导出的内容');
        return;
    }

    try {
        UINotification.info('ℹ️ 正在生成 PDF，请稍候...');
        
        const canvas = await html2canvas(element, {
            scale: 2,
            useCORS: true,
            logging: false
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        
        const imgWidth = 210;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const imgData = canvas.toDataURL('image/png');
        
        pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
        pdf.save(`数据看板_${new Date().toISOString().split('T')[0]}.pdf`);
        
        // 记录审计日志
        await auditService.log(
            'export',
            'dashboard',
            'pdf',
            '导出数据看板为 PDF'
        );
        
        UINotification.success('✅ PDF 导出成功！');
    } catch (error) {
        console.error('PDF导出失败:', error);
        UINotification.error('❌ PDF 导出失败: ' + error.message);
    }
}


function createDashboardStructure() {
    const dashboardSection = document.getElementById('dashboard');
    
    // 创建增强版看板HTML
    dashboardSection.innerHTML = `
        <div id="dashboard-capture-area" class="bg-white rounded-lg shadow-md p-6 mb-6">
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
                    <!-- 🆕 导出按钮 -->
                    <button id="btnExportDashboardPDF" class="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm">
                        <i class="fas fa-download mr-1"></i>导出看板PDF
                    </button>
                </div>
            </div>
            <!-- 1. 统计卡片区域 -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6 mb-6">
                <!-- 餐具 -->
                <div class="bg-gradient-to-br from-blue-400 to-blue-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">餐具洁净度检测</p>
                            <p class="text-3xl font-bold" id="card_tableware_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_tableware_pass">0%</span></p>
                        </div>
                        <i class="fas fa-utensils text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 农残 -->
                <div class="bg-gradient-to-br from-green-400 to-green-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">果蔬农残检测</p>
                            <p class="text-3xl font-bold" id="card_pesticide_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_pesticide_pass">0%</span></p>
                        </div>
                        <i class="fas fa-leaf text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 食用油 -->
                <div class="bg-gradient-to-br from-yellow-400 to-yellow-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">食用油品质快检</p>
                            <p class="text-3xl font-bold" id="card_oil_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_oil_pass">0%</span></p>
                        </div>
                        <i class="fas fa-oil-can text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 病原体 -->
                <div class="bg-gradient-to-br from-purple-400 to-purple-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">食源性细菌/病毒</p>
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
                <div class="bg-gradient-to-br from-orange-400 to-orange-600 rounded-lg p-4 text-white shadow">
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
            
            <!-- 瘦肉精分类统计卡片 -->
            <div class="mb-6">
                <h3 class="font-semibold text-gray-800 mb-3">肉、蛋农残检测</h3>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <!-- 猪肉 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">猪肉</p>
                            <p class="text-2xl font-bold" id="card_lean_pork_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_pork_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 羊肉 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">羊肉</p>
                            <p class="text-2xl font-bold" id="card_lean_mutton_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_mutton_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 牛肉 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">牛肉</p>
                            <p class="text-2xl font-bold" id="card_lean_beef_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_beef_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 禽肉 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">禽肉</p>
                            <p class="text-2xl font-bold" id="card_lean_poultry_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_poultry_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 鱼肉 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">鱼肉</p>
                            <p class="text-2xl font-bold" id="card_lean_fish_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_fish_pass">0%</span></p>
                        </div>
                    </div>
                    <!-- 禽蛋 -->
                    <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-3 text-white shadow">
                        <div class="text-center">
                            <p class="text-xs opacity-90">禽蛋</p>
                            <p class="text-2xl font-bold" id="card_lean_egg_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_egg_pass">0%</span></p>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 2. 概览列表区域 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">餐具洁净度概览 (最新5条)</h3>
                    <ul id="list_tableware_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">果蔬农残概览 (最新5条)</h3>
                    <ul id="list_pesticide_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">食用油品质概览 (最新5条)</h3>
                    <ul id="list_oil_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <!-- ✅ 病原体检测概览移到右边 -->
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">病原体检测概览 (最新5条)</h3>
                    <ul id="list_pathogen_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
            </div>
            
            <!-- 瘦肉精分类概览 -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">猪肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_pork_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">羊肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_mutton_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">牛肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_beef_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">禽肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_poultry_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">鱼肉检测概览 (最新5条)</h3>
                    <ul id="list_lean_fish_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">禽蛋检测概览 (最新5条)</h3>
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
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div class="bg-gray-50 rounded-lg p-4 md:col-span-2">
                    <h3 class="font-semibold mb-3 text-gray-700">本月检测趋势</h3>
                    <div class="h-64">
                        <canvas id="trendChart"></canvas>
                    </div>
                </div>
                <div class="bg-gray-50 rounded-lg p-4 md:col-span-1">
                    <h3 class="font-semibold mb-3 text-gray-700">各食堂合格率对比</h3>
                    <div class="h-64">
                        <canvas id="canteenChart"></canvas>
                    </div>
                </div>
            </div>
            
            <!-- 隐藏当前日期显示，但保留元素以兼容JS -->
            <div class="hidden" id="currentDate"></div>
        </div>
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
            const day = document.getElementById('dayFilter').value || now.toISOString().split('T')[0];
            startDate = new Date(day);
            endDate = new Date(day);
            endDate.setHours(23, 59, 59, 999);
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
            const month = document.getElementById('monthFilter').value || now.toISOString().substring(0, 7);
            startDate = new Date(month + '-01');
            endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + 1);
            endDate.setDate(0);
            endDate.setHours(23, 59, 59, 999);
            document.getElementById('date_range_text').textContent = `${month} 月`;
            break;
            
        case 'range':
            const start = document.getElementById('startDateFilter').value;
            const end = document.getElementById('endDateFilter').value;
            if(start && end) {
                startDate = new Date(start);
                endDate = new Date(end);
                endDate.setHours(23, 59, 59, 999);
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

    // ✅ 获取食堂筛选条件
    const selectedCanteen = document.getElementById('canteenFilter')?.value || 'all';

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

    // 获取瘦肉精分类统计
    const leanMeatByType = getLeanMeatStatsByType(startDate, endDate, selectedCanteen);
    
    // 更新瘦肉精分类卡片
    updateLeanMeatCards(leanMeatByType);
    
    // 更新瘦肉精分类概览列表（使用全局数据，不受日期筛选影响）
    const leanMeatByTypeAllTime = getLeanMeatStatsByType(new Date(0), new Date(2099, 11, 31), selectedCanteen);
    updateLeanMeatOverviewLists(leanMeatByTypeAllTime);

    // ✅ 计算总检测数和总合格率
    let totalCount = 0;
    let totalPassed = 0;
    
    // 餐具：按点位计数
    totalCount += stats.tableware.count;
    totalPassed += stats.tableware.passCount;
    
    // 其他模块：按记录计数
    totalCount += stats.pesticide.count;
    totalPassed += stats.pesticide.passCount;
    
    totalCount += stats.oil.count;
    totalPassed += stats.oil.passCount;
    
    totalCount += stats.leanMeat.count;
    totalPassed += stats.leanMeat.passCount;
    
    totalCount += stats.pathogen.count;
    totalPassed += stats.pathogen.passCount;
    
    const totalPassRate = totalCount > 0 ? Math.round((totalPassed / totalCount) * 100) : 100;
    
    document.getElementById('card_total_count').textContent = totalCount;
    document.getElementById('card_total_pass').textContent = `${totalPassRate}%`;

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

// ✅ 修改：获取瘦肉精分类统计（增加食堂筛选）
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
            
            const result = (r.result || '').toString().trim();
            // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
            // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
            // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"，否则会把不合格误判为合格
            if (result.includes('合格') && !result.includes('不合格')) {
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

// 修改：更新瘦肉精分类卡片，数据为0时显示"无"
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

// 新增：更新瘦肉精分类概览列表
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
      sortedRecords.forEach(r => {
          if (r.atpPoints && Array.isArray(r.atpPoints)) {
              r.atpPoints.forEach(point => {
                  count++;
                  const result = (point.result || point.res || '').toString().trim();
                  // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
                  // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
                  // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"，否则会把不合格误判为合格
                  if (result.includes('合格') && !result.includes('不合格')) {
                      passCount++;
                  }
              });
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
          passRate: count > 0 ? Math.round((passCount / count) * 100) : 100,
          records: sortedRecords,
          riskLevels
      };
  } else {
      count = sortedRecords.length;
      passCount = sortedRecords.filter(r => {
          const result = (r.result || '').toString().trim();
          const colorLevel = (r.colorLevel || '').toString().trim();
          // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
          // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
          // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"
          return (result.includes('合格') && !result.includes('不合格')) || colorLevel === '合格';
      }).length;
  }

  const passRate = count > 0 ? Math.round((passCount / count) * 100) : 100;
  return { count, passCount, positiveCount, passRate, records: sortedRecords };
}


function updateCard(type, stats) {
    const countEl = document.getElementById(`card_${type}_count`);
    const passEl = document.getElementById(`card_${type}_pass`);
    if(countEl) countEl.textContent = stats.count;
    if(passEl) passEl.textContent = `${stats.passRate}%`;
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
    
    if (stats.tableware.passRate < 90 && stats.tableware.count > 0) {
        alerts.push(`餐具洁净度合格率偏低(${stats.tableware.passRate}%)`);
    }
    
    if (stats.pesticide.passRate < 100 && stats.pesticide.count > 0) {
        alerts.push(`存在农药残留超标蔬果`);
    }
    
    if (stats.oil.passRate < 95 && stats.oil.count > 0) {
        alerts.push(`食用油品质不合格率较高`);
    }
    
    Object.keys(leanMeatByType).forEach(meatType => {
        const typeStats = leanMeatByType[meatType];
        if (typeStats.passRate !== null && typeStats.passRate < 100 && typeStats.count > 0) {
            alerts.push(`警告：${meatType}检出瘦肉精阳性样本`);
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
                plugins: {
                    legend: { display: true, position: 'bottom' },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const ds = context.dataset || {};
                                const val = context.parsed && context.parsed.y !== undefined ? context.parsed.y : context.raw;
                                const missing = ds._missing && ds._missing[context.dataIndex];
                                if (missing) return `${ds.label}: ${val}% （无检测记录）`;
                                return `${ds.label}: ${val}%`;
                            }
                        }
                    }
                },
                scales: {
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
                datasets: [{ label: '合格率%', data: [], backgroundColor: [] }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { 
                    y: { 
                        beginAtZero: true, 
                        max: 110,
                        ticks: {
                            callback: function(value) {
                                return value <= 100 ? value : null;
                            }
                        }
                    } 
                } 
            }
        });
    }
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

    const trendData = calculateCanteenTrends(startDate, endDate, selectedCanteen);
    if (trendChart) {
        trendChart.data.labels = trendData.labels;

        const palette = CAN_COLOR_PALETTE;
        const canteenNames = Object.keys(trendData.datasets || {}).filter(name => {
            const missing = (trendData.missing && trendData.missing[name]) || [];
            if (!missing.length) return true;
            return missing.some(m => m === false);
        });
        trendChart.data.datasets = canteenNames.map((name, idx) => {
            const color = palette[idx % palette.length];
            const values = trendData.datasets[name] || [];
            const missingFlags = (trendData.missing && trendData.missing[name]) || values.map(v => v === null);
            return {
                label: name,
                data: values,
                borderColor: color,
                backgroundColor: color + '33',
                tension: 0.4,
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
                pointRadius: missingFlags.map(m => (m ? 0 : 4)),
                pointHoverRadius: missingFlags.map(m => 6),
                pointHitRadius: missingFlags.map(m => (m ? 10 : 6)),
                _missing: missingFlags
            };
        });

        trendChart.update();
    }

    const canteenResult = calculateCanteenPassRate(startDate, endDate, selectedCanteen);
    if(canteenChart) {
        canteenChart.data.labels = canteenResult.labels;
        canteenChart.data.datasets[0].data = canteenResult.data;
        canteenChart.data.datasets[0].backgroundColor = canteenResult.labels.map((_, i) => CAN_COLOR_PALETTE[i % CAN_COLOR_PALETTE.length]);
        canteenChart.data.datasets[0].borderColor = canteenChart.data.datasets[0].backgroundColor;
        canteenChart.update();
    }
}


// ✅ 修改：计算食堂趋势（增加食堂筛选）
function calculateCanteenTrends(startDate, endDate, selectedCanteen = 'all') {
  const rawDates = [];
  const rawLabels = [];
  
  const canteenData = {
      '一食堂': {},
      '二食堂': {},
      '三食堂': {}
  };

  const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
  
  types.forEach(type => {
      const records = services[type].getAll();
      records.forEach(record => {
          const recordDate = record.testDate || (record.timestamp ? record.timestamp.split('T')[0] : null);
          if (!recordDate) return;
          
          const testDate = new Date(recordDate);
          if (testDate < startDate || testDate > endDate) return;
          
          // ✅ 食堂筛选
          const canteen = getRecordCanteen(record) || '未知食堂';
          if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return;
          
          if (!canteenData[canteen]) canteenData[canteen] = {};
          if (!canteenData[canteen][recordDate]) {
              canteenData[canteen][recordDate] = { passed: 0, total: 0 };
          }
          
          if (type === 'tableware' && record.atpPoints) {
              record.atpPoints.forEach(point => {
                  canteenData[canteen][recordDate].total++;
                  const result = (point.result || point.res || '').toString().trim();
                  // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
                  // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
                  // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"
                  if (result.includes('合格') && !result.includes('不合格')) {
                      canteenData[canteen][recordDate].passed++;
                  }
              });
          } else if (type === 'pathogen') {
              canteenData[canteen][recordDate].total++;
              if (!record.positiveItems || record.positiveItems === '无') {
                  canteenData[canteen][recordDate].passed++;
              }
          } else {
              canteenData[canteen][recordDate].total++;
              const result = (record.result || '').toString().trim();
              const colorLevel = (record.colorLevel || '').toString().trim();
              // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
              // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
              // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"
              if ((result.includes('合格') && !result.includes('不合格')) || colorLevel === '合格') {
                  canteenData[canteen][recordDate].passed++;
              }
          }
      });
  });

  let currentDate = new Date(startDate);
  while (currentDate <= endDate) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek > 0 && dayOfWeek < 6) {
          const dateStr = currentDate.toISOString().split('T')[0];
          const day = currentDate.getDate();
          const month = currentDate.getMonth() + 1;
          rawDates.push(dateStr);
          rawLabels.push(`${month}-${day}`);
      }
      currentDate.setDate(currentDate.getDate() + 1);
  }

  const rawDatasets = {};
  const canteens = Object.keys(canteenData);
  canteens.forEach(canteen => {
      rawDatasets[canteen] = rawDates.map(dateStr => {
          const daily = canteenData[canteen][dateStr];
          if (daily && daily.total > 0) {
              return Math.round((daily.passed / daily.total) * 100);
          }
          return null;
      });
  });

  const rawMissing = {};
  canteens.forEach(canteen => {
      rawMissing[canteen] = rawDates.map(dateStr => {
          const daily = canteenData[canteen][dateStr];
          return !(daily && daily.total > 0);
      });
  });

  const finalLabels = [];
  const finalDatasets = {};
  const finalMissing = {};
  canteens.forEach(c => {
      finalDatasets[c] = [];
      finalMissing[c] = [];
  });

  const hasDataFlags = rawDates.map((_, index) => {
      return canteens.some(c => rawDatasets[c][index] !== null);
  });

  const dataPointCount = hasDataFlags.filter(Boolean).length;
  const enableCompression = dataPointCount >= 3;

  let emptyCounter = 0;
  const MAX_CONSECUTIVE_EMPTY = 1; 

  for (let i = 0; i < rawDates.length; i++) {
      const hasData = hasDataFlags[i];

      if (hasData) {
          finalLabels.push(rawLabels[i]);
          canteens.forEach(c => {
              finalDatasets[c].push(rawDatasets[c][i]);
              finalMissing[c].push(rawMissing[c][i]);
          });
          emptyCounter = 0;
      } else {
          if (!enableCompression) {
              finalLabels.push(rawLabels[i]);
              canteens.forEach(c => {
                  finalDatasets[c].push(100);
                  finalMissing[c].push(true);
              });
          } else {
              if (emptyCounter < MAX_CONSECUTIVE_EMPTY) {
                  finalLabels.push(rawLabels[i]);
                  canteens.forEach(c => {
                      finalDatasets[c].push(100);
                      finalMissing[c].push(true);
                  });
                  emptyCounter++;
              } else {
                  continue;
              }
          }
      }
  }
  return { labels: finalLabels, datasets: finalDatasets, missing: finalMissing };
}


// ✅ 修改：计算食堂合格率（增加食堂筛选）
function calculateCanteenPassRate(startDate, endDate, selectedCanteen = 'all') {
    const canteenSet = new Set();
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    
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
            if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return;

            if (canteen) canteenSet.add(canteen);
        });
    });

    const canteens = canteenSet.size ? Array.from(canteenSet) : DEFAULT_CANTEENS;

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
            
            // ✅ 食堂筛选
            const canteen = getRecordCanteen(record);
            if (selectedCanteen !== 'all' && canteen !== selectedCanteen) return;

            if (!canteen || !stats[canteen]) return;

            if (type === 'tableware') {
                if (record.atpPoints && Array.isArray(record.atpPoints)) {
                    record.atpPoints.forEach(point => {
                        stats[canteen].total++;
                        const result = (point.result || point.res || '').toString().trim();
                        // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
                        // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
                        // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"
                        if (result.includes('合格') && !result.includes('不合格')) {
                            stats[canteen].passed++;
                        }
                    });
                }
            } else if (type === 'pathogen') {
                stats[canteen].total++;
                if (!record.positiveItems || record.positiveItems === '无') {
                    stats[canteen].passed++;
                }
            } else {
                stats[canteen].total++;
                const result = (record.result || '').toString().trim();
                const colorLevel = (record.colorLevel || '').toString().trim();
                // 业务口径（2026-07-02业务方裁定）：仅"合格"计为合格，"警戒""不合格"等其余结果均计为不合格
                // 当前表达式已满足该口径：警戒类结果不含"合格"子串，自动归入不合格分支，请勿改为宽松匹配
                // ⚠️ 注意："不合格"也包含"合格"子串，必须先排除"不合格"
                if ((result.includes('合格') && !result.includes('不合格')) || colorLevel === '合格') {
                    stats[canteen].passed++;
                }
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

    return { labels, data };
}

// P1-20: 移除 window.initDashboard 全局暴露，main.js 已通过 import 使用
