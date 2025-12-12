import { StorageService } from '../core/Storage.js';

const services = {
    tableware: new StorageService('tableware'),
    pesticide: new StorageService('pesticide'),
    oil: new StorageService('oil'),
    leanMeat: new StorageService('leanMeat'),
    pathogen: new StorageService('pathogen')
};

// 全局图表对象
let trendChart, canteenChart;
// 统一配色（洋红 / 绿色 / 蓝色），后续按索引复用
const CAN_COLOR_PALETTE = ['#ff00a0', '#4daf4a', '#377eb8', '#8b5cf6', '#ef4444', '#06b6d4', '#a3e635'];

export function initDashboard() {
    // 创建增强版看板的HTML结构
    createDashboardStructure();
    
    // 设置当前日期
    const now = new Date();
    document.getElementById('currentDate').textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    
    // 初始化日期选择器默认值
    document.getElementById('dayFilter').valueAsDate = now;
    document.getElementById('monthFilter').value = now.toISOString().substring(0, 7);
    
    // 绑定事件处理器
    document.getElementById('dateFilterType').addEventListener('change', updateDateFilterOptions);
    document.getElementById('btnFilterDashboard').addEventListener('click', loadDashboardData);
    
    // 初始化图表
    initCharts();
    
    // 加载初始数据
    loadDashboardData();
    
    // 监听数据变化
    document.addEventListener('dataChanged', loadDashboardData);
    
    // 绑定详情链接
    document.querySelectorAll('a[data-target]').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const target = this.getAttribute('data-target');
            document.querySelector(`button.nav-btn[data-target="${target}"]`).click();
        });
    });
    // 绑定导出看板按钮
    const btnExportDashboard = document.getElementById('btnExportDashboardPDF');
    if (btnExportDashboard) {
        btnExportDashboard.onclick = exportDashboardToPDF;
    }
}

// 导出看板为PDF
async function exportDashboardToPDF() {
    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
        alert('PDF库加载中，请稍后再试...');
        return;
    }

    const element = document.getElementById('dashboard-capture-area');
    if (!element) {
        alert('未找到要导出的内容');
        return;
    }

    try {
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
        
        alert('✅ PDF导出成功！');
    } catch (error) {
        console.error('PDF导出失败:', error);
        alert('❌ PDF导出失败');
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
                    <select id="dateFilterType" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
                        <option value="all">全部数据</option>
                        <option value="day">按日</option>
                        <option value="month">按月</option>
                        <option value="range">时间段</option>
                    </select>
                    <div id="dayFilterContainer" class="hidden filter-option">
                        <input type="date" id="dayFilter" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
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
            <!-- 1. 统计卡片区域 (保持原样) -->
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
                <!-- 瘦肉精 -->
                <div class="bg-gradient-to-br from-red-400 to-red-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">瘦肉精快检</p>
                            <p class="text-3xl font-bold" id="card_lean_count">0</p>
                            <p class="text-xs mt-1">合格率: <span id="card_lean_pass">0%</span></p>
                        </div>
                        <i class="fas fa-drumstick-bite text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 病原体 -->
                <div class="bg-gradient-to-br from-purple-400 to-purple-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">食源性细菌/病毒</p>
                            <p class="text-3xl font-bold" id="card_pathogen_count">0</p>
                            <p class="text-xs mt-1">阳性数: <span id="card_pathogen_positive">0</span></p>
                        </div>
                        <i class="fas fa-virus text-4xl opacity-50"></i>
                    </div>
                </div>
                <!-- 总数 -->
                <div class="bg-gradient-to-br from-orange-400 to-orange-600 rounded-lg p-4 text-white shadow">
                    <div class="flex items-center justify-between">
                        <div>
                            <p class="text-sm opacity-90">总检测数</p>
                            <p class="text-3xl font-bold" id="card_total_count">0</p>
                            <p class="text-xs mt-1" id="date_range_text">全部数据</p>
                        </div>
                        <i class="fas fa-clipboard-list text-4xl opacity-50"></i>
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
                <div class="bg-white border rounded-lg p-4">
                    <h3 class="font-semibold text-gray-800 mb-3">瘦肉精概览 (最新5条)</h3>
                    <ul id="list_lean_overview" class="text-sm text-gray-700 space-y-2"></ul>
                </div>
                <div class="bg-white border rounded-lg p-4 col-span-1 md:col-span-2">
                    <h3 class="font-semibold text-gray-800 mb-3">病原体检测概览</h3>
                    <ul id="list_pathogen_overview" class="text-sm text-gray-700 space-y-2"></ul>
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
        case 'month':
            document.getElementById('monthFilterContainer').classList.remove('hidden');
            break;
        case 'range':
            document.getElementById('rangeFilterContainer').classList.remove('hidden');
            break;
    }
}

// 加载看板数据
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
                // 默认全部
                startDate = new Date(0);
                endDate = new Date(2099, 11, 31);
            }
            break;
        default: // all
            startDate = new Date(0);
            endDate = new Date(2099, 11, 31);
            document.getElementById('date_range_text').textContent = `全部数据`;
    }

    // 统计各模块数据
    const stats = {
        tableware: getStats('tableware', startDate, endDate),
        pesticide: getStats('pesticide', startDate, endDate),
        oil: getStats('oil', startDate, endDate),
        leanMeat: getStats('leanMeat', startDate, endDate),
        pathogen: getStats('pathogen', startDate, endDate)
    };

    // 更新卡片显示
    updateCard('tableware', stats.tableware);
    updateCard('pesticide', stats.pesticide);
    updateCard('oil', stats.oil);
    updateCard('lean', stats.leanMeat);
    
    // 病原体特殊处理
    const pathogenCountEl = document.getElementById('card_pathogen_count');
    const pathogenPositiveEl = document.getElementById('card_pathogen_positive');
    if(pathogenCountEl) pathogenCountEl.textContent = stats.pathogen.count;
    if(pathogenPositiveEl) pathogenPositiveEl.textContent = stats.pathogen.positiveCount;

    // 更新总数
    const total = stats.tableware.count + stats.pesticide.count + stats.oil.count + stats.leanMeat.count + stats.pathogen.count;
    document.getElementById('card_total_count').textContent = total;

    // 更新概览列表
    updateOverviewList('tableware', stats.tableware.records);
    updateOverviewList('pesticide', stats.pesticide.records);
    updateOverviewList('oil', stats.oil.records);
    updateOverviewList('lean', stats.leanMeat.records);
    updateOverviewList('pathogen', stats.pathogen.records);

    // 更新风险提示
    updateRiskAlerts(stats);

    // 更新图表
    updateCharts(startDate, endDate);
}

// 通用统计函数 - 支持按日期过滤
function getStats(type, startDate, endDate) {
    const records = services[type].getAll();
    const filtered = records.filter(r => {
        const testDate = r.testDate || (r.timestamp ? r.timestamp.split('T')[0] : null);
        if (!testDate) return false;
        
        const d = new Date(testDate);
        return d >= startDate && d <= endDate;
    });

    let count = 0;
    let passCount = 0;
    let positiveCount = 0;

    if (type === 'tableware') {
        filtered.forEach(r => {
            if (r.atpPoints) {
                count += r.atpPoints.length;
                passCount += r.atpPoints.filter(p => {
                    const result = p.result || p.res;
                    return result === '合格';
                }).length;
            }
        });
    } else if (type === 'pathogen') {
        count = filtered.length;
        positiveCount = filtered.filter(r => r.positiveItems && r.positiveItems !== '无').length;
    } else {
        count = filtered.length;
        passCount = filtered.filter(r => r.result?.includes('合格') || r.colorLevel === '合格').length;
    }

    const passRate = count > 0 ? Math.round((passCount / count) * 100) : 100;

    return { count, passCount, positiveCount, passRate, records: filtered };
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
    const recent = records.slice(0, 5);  // 显示最新5条
    recent.forEach(r => {
        const li = document.createElement('li');
        let text = '';
        if(type === 'tableware') text = `${r.testDate} ${r.canteen} 检测${r.atpPoints?.length || 0}点位`;
        else if(type === 'pesticide') text = `${r.testDate} ${r.vegetableType} ${r.result}`;
        else if(type === 'oil') text = `${r.testDate} ${r.canteen} TPM:${r.tpmValue}%`;
        else if(type === 'lean' || type === 'leanMeat') text = `${r.testDate} ${r.meatType} ${r.result}`;
        else if(type === 'pathogen') text = `${r.testDate} ${r.sampleId} ${r.positiveItems || '无'}`;
        
        li.textContent = text;
        listEl.appendChild(li);
    });
}

function updateRiskAlerts(stats) {
    const alerts = [];
    if (stats.tableware.passRate < 90 && stats.tableware.count > 0) alerts.push(`餐具洁净度合格率偏低(${stats.tableware.passRate}%)`);
    if (stats.pesticide.passRate < 100 && stats.pesticide.count > 0) alerts.push(`存在农药残留超标蔬果`);
    if (stats.oil.passRate < 95 && stats.oil.count > 0) alerts.push(`食用油品质不合格率较高`);
    if (stats.leanMeat.passRate < 100 && stats.leanMeat.count > 0) alerts.push(`警告：检出瘦肉精阳性样本`);
    if (stats.pathogen.positiveCount > 0) alerts.push(`警告：检出食源性病原体`);

    const el = document.getElementById('riskAlerts');
    if (alerts.length) {
        el.innerHTML = alerts.map(a => `<li class="text-red-700 font-bold">• ${a}</li>`).join('');
    } else {
        el.innerHTML = '<li>• 暂无风险提示</li>';
    }
}

// ================= 图表逻辑 =================

function initCharts() {
    const trendCtx = document.getElementById('trendChart')?.getContext('2d');
    // 注册用于绘制虚线圆点的插件（只注册一次）
    if (window.Chart && !window._dashedPointPluginRegistered) {
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
        window._dashedPointPluginRegistered = true;
    }
    if (trendCtx) {
        // 动态数据集：初始化为空，后续根据实际食堂生成数据集
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
        // 初始化为空，后续由 updateCharts 动态填充标签、数据与配色
        canteenChart = new Chart(canteenCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{ label: '合格率%', data: [], backgroundColor: [] }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: { legend: { display: 'false' } },
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

function updateCharts(startDate, endDate) {
    // 如果未传入范围，默认使用当前月份
    if (!startDate || !endDate) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        startDate = new Date(currentYear, currentMonth, 1);
        endDate = new Date(currentYear, currentMonth + 1, 0);
        endDate.setHours(23, 59, 59, 999);
    }

    const trendData = calculateCanteenTrends(startDate, endDate);
    if (trendChart) {
        trendChart.data.labels = trendData.labels;

        // 根据返回的食堂名称动态生成/更新数据集
        // 使用模块常量的统一配色
        const palette = CAN_COLOR_PALETTE;
        const canteenNames = Object.keys(trendData.datasets || {}).filter(name => {
            // 使用 missing 标记判断该食堂是否有真实数据（非缺失）的点
            const missing = (trendData.missing && trendData.missing[name]) || [];
            // 如果 missing 数组为空，则保守包含该食堂
            if (!missing.length) return true;
            // 包含当且仅当存在至少一个非缺失点
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
                // 当与缺失点相连的线段使用虚线样式
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
                // 隐藏缺失点的默认圆点，由插件绘制虚线圆圈
                pointRadius: missingFlags.map(m => (m ? 0 : 4)),
                // 增强缺失点的可交互区域（即使 radius 为 0 也可 hover），hover 显示 tooltip
                pointHoverRadius: missingFlags.map(m => 6),
                pointHitRadius: missingFlags.map(m => (m ? 10 : 6)),
                // 将缺失标记附在 dataset 上，供 plugin 和 tooltip 使用
                _missing: missingFlags
            };
        });

        trendChart.update();
    }

    // 基于真实数据更新食堂合格率对比
    const canteenResult = calculateCanteenPassRate();
    if(canteenChart) {
        // 更新标签与数据
        canteenChart.data.labels = canteenResult.labels;
        canteenChart.data.datasets[0].data = canteenResult.data;
        // 为每个食堂分配统一配色（洋红/绿/蓝）循环使用
        canteenChart.data.datasets[0].backgroundColor = canteenResult.labels.map((_, i) => CAN_COLOR_PALETTE[i % CAN_COLOR_PALETTE.length]);
        canteenChart.data.datasets[0].borderColor = canteenChart.data.datasets[0].backgroundColor;
        canteenChart.update();
    }
}

// 计算各食堂趋势数据（支持智能空窗压缩）
function calculateCanteenTrends(startDate, endDate) {
    // 1. 准备基础数据容器
    const rawDates = []; // 原始日期字符串
    const rawLabels = []; // 原始X轴标签
    
    // 准备食堂数据结构
    const canteenData = {
        '一食堂': {},
        '二食堂': {},
        '三食堂': {}
    };

    // 2. 收集并统计所有原始数据（这一步逻辑不变，先拿到全量数据）
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    
    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(record => {
            const recordDate = record.testDate || (record.timestamp ? record.timestamp.split('T')[0] : null);
            if (!recordDate) return;
            
            const testDate = new Date(recordDate);
            if (testDate < startDate || testDate > endDate) return;
            
            // 不排除周末，包含所有有数据的时间点
            
            const canteen = record.canteen || '未知食堂';
            if (!canteenData[canteen]) canteenData[canteen] = {};
            if (!canteenData[canteen][recordDate]) {
                canteenData[canteen][recordDate] = { passed: 0, total: 0 };
            }
            
            // 统计合格数
            if (type === 'tableware' && record.atpPoints) {
                record.atpPoints.forEach(point => {
                    canteenData[canteen][recordDate].total++;
                    if ((point.result === '合格') || (point.res === '合格')) canteenData[canteen][recordDate].passed++;
                });
            } else if (type === 'pathogen') {
                canteenData[canteen][recordDate].total++;
                if (!record.positiveItems || record.positiveItems === '无') canteenData[canteen][recordDate].passed++;
            } else {
                canteenData[canteen][recordDate].total++;
                if (record.result?.includes('合格') || record.colorLevel === '合格') canteenData[canteen][recordDate].passed++;
            }
        });
    });

    // 3. 生成完整的自然日历序列（仅工作日：周一~周五）
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

    // 4. 构建原始数据集（用于判断是否有数据）
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

    // 记录每个食堂在每个工作日是否为“缺失”（即当天没有任何检测）
    const rawMissing = {};
    canteens.forEach(canteen => {
        rawMissing[canteen] = rawDates.map(dateStr => {
            const daily = canteenData[canteen][dateStr];
            return !(daily && daily.total > 0);
        });
    });

    // ==========================================
    // 核心算法：智能空窗压缩 (Smart Gap Compression)
    // ==========================================
    
    const finalLabels = [];
    const finalDatasets = {};
    const finalMissing = {};
    canteens.forEach(c => {
        finalDatasets[c] = [];
        finalMissing[c] = [];
    });

    // 标记每一天是否有任意食堂有数据
    const hasDataFlags = rawDates.map((_, index) => {
        return canteens.some(c => rawDatasets[c][index] !== null);
    });

    // 统计总数据点数
    const dataPointCount = hasDataFlags.filter(Boolean).length;

    // 只有当数据点至少有3个时，才启用压缩逻辑，否则保持原样以免图表太窄
    const enableCompression = dataPointCount >= 3;

    let emptyCounter = 0;
    // 允许的最大连续空天数。设置为1意味着：数据-空-空-空-数据 -> 数据-空-数据
    // 这样能极大压缩空窗期，接近你想要的8:2效果
    const MAX_CONSECUTIVE_EMPTY = 1; 

    for (let i = 0; i < rawDates.length; i++) {
        const hasData = hasDataFlags[i];

        if (hasData) {
            // 情况A：这一天有数据 -> 必须保留
            finalLabels.push(rawLabels[i]);
            canteens.forEach(c => {
                finalDatasets[c].push(rawDatasets[c][i]);
                finalMissing[c].push(rawMissing[c][i]);
            });
            emptyCounter = 0; // 重置空窗计数器
        } else {
            // 情况B：这一天没数据
            if (!enableCompression) {
                // 不压缩：照常添加空点
                finalLabels.push(rawLabels[i]);
                    canteens.forEach(c => {
                    finalDatasets[c].push(100); // 缺失点显示为100
                    finalMissing[c].push(true);
                });
            } else {
                // 启用压缩：检查是否超过了允许的空窗长度
                if (emptyCounter < MAX_CONSECUTIVE_EMPTY) {
                    // 还没超过限制，保留这个空位作为分隔符
                    finalLabels.push(rawLabels[i]);
                    canteens.forEach(c => {
                        finalDatasets[c].push(100); // 缺失点显示为100
                        finalMissing[c].push(true);
                    });
                    emptyCounter++;
                } else {
                    // 超过限制（例如已经是第2个空天了），直接丢弃该点
                    // 从而实现视觉上的“折叠”
                    continue;
                }
            }
        }
    }

    return { labels: finalLabels, datasets: finalDatasets, missing: finalMissing };
}


// 计算食堂合格率
function calculateCanteenPassRate() {
    // 收集所有出现过的食堂名称
    const canteenSet = new Set();
    const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
    
    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(r => {
            if (r && r.canteen) canteenSet.add(r.canteen);
        });
    });

    // 如果没有任何食堂记录，使用默认食堂
    const defaultCanteens = ['一食堂', '二食堂', '三食堂'];
    const canteens = canteenSet.size ? Array.from(canteenSet) : defaultCanteens;

    const stats = {};
    canteens.forEach(canteen => {
        stats[canteen] = { passed: 0, total: 0 };
    });

    // 计算每个食堂的合格率
    types.forEach(type => {
        const records = services[type].getAll();
        records.forEach(record => {
            const canteen = record.canteen;
            if (!canteen || !stats[canteen]) return;

            if (type === 'tableware') {
                if (record.atpPoints && record.atpPoints.length) {
                    record.atpPoints.forEach(point => {
                        stats[canteen].total++;
                        if ((point.result === '合格') || (point.res === '合格')) stats[canteen].passed++;
                    });
                }
            } else if (type === 'pathogen') {
                stats[canteen].total++;
                if (!record.positiveItems || record.positiveItems === '无') stats[canteen].passed++;
            } else {
                stats[canteen].total++;
                if (record.result?.includes('合格') || record.colorLevel === '合格') {
                    stats[canteen].passed++;
                }
            }
        });
    });

    // 计算合格率
    const labels = [];
    const data = [];
    canteens.forEach(canteen => {
        labels.push(canteen);
        const rate = stats[canteen].total > 0 ? Math.round((stats[canteen].passed / stats[canteen].total) * 100) : 0;
        data.push(rate);
    });

    return { labels, data };
}