import os

# 项目根目录
BASE_DIR = "food-safety-system"

# 文件内容定义
file_contents = {}

# ==========================================
# 0. 外部库引用 (HTML中使用)
# ==========================================
# 我们将在 index.html 中自动注入 html2canvas 和 jspdf

# ==========================================
# 1. CSS 内容
# ==========================================
file_contents["css/style.css"] = """
/* 基础样式 */
.nav-btn.active { background-color: #1d4ed8; color: white; } /* Tailwind blue-700 */
.hidden { display: none; }
.pdf-capture-mode { background-color: #ffffff !important; }

/* 页面加载防抖动 */
body { opacity: 0; transition: opacity 0.3s; }
body.loaded { opacity: 1; }

/* 表格样式微调 */
td, th { vertical-align: middle; }

/* 加载遮罩层 */
.loading-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(255,255,255,0.8);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 9999;
}
"""

# ==========================================
# 2. JS Core: Storage.js
# ==========================================
file_contents["js/core/Storage.js"] = """
/**
 * 数据持久化层
 */
export class StorageService {
    constructor(moduleName) {
        this.key = `${moduleName}Records`;
    }

    getAll() {
        try {
            return JSON.parse(localStorage.getItem(this.key) || '[]');
        } catch (e) {
            console.error(`Error reading storage ${this.key}`, e);
            return [];
        }
    }

    save(data) {
        const records = this.getAll();
        const newRecord = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...data
        };
        records.unshift(newRecord);
        localStorage.setItem(this.key, JSON.stringify(records));
        return newRecord;
    }

    delete(id) {
        let records = this.getAll();
        records = records.filter(r => r.id !== Number(id) && r.id !== String(id));
        localStorage.setItem(this.key, JSON.stringify(records));
    }
}
"""

# ==========================================
# 3. JS Services: ExportService.js (新增)
# ==========================================
file_contents["js/services/ExportService.js"] = """
/**
 * 导出服务 - 封装 PDF 生成逻辑
 */
export class ExportService {
    static async generatePDF(elementId, title = '检测报告') {
        const element = document.getElementById(elementId);
        if (!element) {
            alert('未找到导出内容区域');
            return;
        }

        // 简单的加载提示
        const originalText = document.body.style.cursor;
        document.body.style.cursor = 'wait';
        
        try {
            // 检查库是否加载
            if (!window.html2canvas || !window.jspdf) {
                alert('导出组件正在加载中，请稍后再试...');
                return;
            }

            // 1. 截图
            const canvas = await window.html2canvas(element, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff' // 强制白色背景
            });

            // 2. 生成 PDF
            const imgData = canvas.toDataURL('image/png');
            const { jsPDF } = window.jspdf;
            
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = pdf.internal.pageSize.getHeight();
            
            const imgProps = pdf.getImageProperties(imgData);
            const imgHeight = (imgProps.height * pdfWidth) / imgProps.width;
            
            // 简单处理：如果内容过长，只截取第一页，或者缩放适应
            // 这里采用简单的单页/多页逻辑
            let heightLeft = imgHeight;
            let position = 0;

            pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
            heightLeft -= pdfHeight;

            while (heightLeft >= 0) {
                position = heightLeft - imgHeight;
                pdf.addPage();
                pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
                heightLeft -= pdfHeight;
            }

            const dateStr = new Date().toISOString().split('T')[0];
            pdf.save(`${title}_${dateStr}.pdf`);
            
        } catch (error) {
            console.error('PDF Export Error:', error);
            alert('导出失败，请检查控制台日志');
        } finally {
            document.body.style.cursor = originalText;
        }
    }
}
"""

# ==========================================
# 4. JS Utils: UIHelper.js
# ==========================================
file_contents["js/utils/UIHelper.js"] = """
export class UIHelper {
    static setupNavigation() {
        const buttons = document.querySelectorAll('.nav-btn');
        const sections = document.querySelectorAll('.content-section');

        buttons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = btn.dataset.target;
                if (!targetId) return;

                buttons.forEach(b => b.classList.remove('active', 'bg-blue-700'));
                btn.classList.add('active', 'bg-blue-700');

                sections.forEach(s => s.classList.add('hidden'));
                const targetSection = document.getElementById(targetId);
                if (targetSection) targetSection.classList.remove('hidden');
            });
        });
    }
}
"""

# ==========================================
# 5. JS Modules: Tableware.js
# ==========================================
file_contents["js/modules/Tableware.js"] = """
import { StorageService } from '../core/Storage.js';

const storage = new StorageService('tableware');

export function initTableware() {
    const form = document.getElementById('tablewareTestForm');
    if (form) {
        form.removeAttribute('onsubmit');
        form.addEventListener('submit', handleFormSubmit);
    }

    document.getElementById('btnAddAtpPoint')?.addEventListener('click', addAtpPoint);
    
    // 事件委托处理删除
    document.getElementById('tablewareRecords')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-delete');
        if (btn && confirm('确定删除?')) {
            storage.delete(btn.dataset.id);
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
        }
    });

    document.getElementById('atpPointsContainer')?.addEventListener('click', (e) => {
        if (e.target.closest('.btn-remove-point')) {
            e.target.closest('.atp-point').remove();
        }
    });

    renderTable();
}

function handleFormSubmit(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    const points = [];
    document.querySelectorAll('.atp-point').forEach(div => {
        points.push({
            loc: div.querySelector('[name="location"]').value,
            rlu: div.querySelector('[name="rluValue"]').value,
            res: div.querySelector('[name="result"]').value
        });
    });
    data.atpPoints = points;

    storage.save(data);
    alert('保存成功');
    e.target.reset();
    document.getElementById('atpPointsContainer').innerHTML = getPointTemplate();
    renderTable();
    document.dispatchEvent(new Event('dataChanged'));
}

function renderTable() {
    const records = storage.getAll();
    const tbody = document.getElementById('tablewareRecords');
    if (!tbody) return;

    if (records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-gray-500">暂无数据</td></tr>`;
        return;
    }

    tbody.innerHTML = records.map(record => {
        const points = record.atpPoints || [];
        if (!points.length) return '';
        return points.map((p, idx) => `
            <tr class="border-b hover:bg-gray-50">
                ${idx === 0 ? `<td rowspan="${points.length}" class="border px-4 py-2 bg-white">${record.testDate}</td>` : ''}
                ${idx === 0 ? `<td rowspan="${points.length}" class="border px-4 py-2 bg-white">${record.canteen}</td>` : ''}
                <td class="border px-4 py-2">${p.loc}</td>
                <td class="border px-4 py-2">${p.rlu}</td>
                <td class="border px-4 py-2"><span class="px-2 py-1 rounded-full text-xs ${p.res === '合格' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${p.res}</span></td>
                ${idx === 0 ? `<td rowspan="${points.length}" class="border px-4 py-2 bg-white">${record.inspector}</td>` : ''}
                ${idx === 0 ? `<td rowspan="${points.length}" class="border px-4 py-2 bg-white"><button class="text-red-600 btn-delete" data-id="${record.id}"><i class="fas fa-trash"></i></button></td>` : ''}
            </tr>
        `).join('');
    }).join('');
}

function addAtpPoint() {
    const div = document.createElement('div');
    div.className = 'border border-gray-200 rounded-lg p-4 bg-gray-50 atp-point mb-4';
    div.innerHTML = getPointTemplate(true);
    document.getElementById('atpPointsContainer').appendChild(div);
}

function getPointTemplate(removable = false) {
    return `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div><label class="block text-sm mb-1">点位</label><select name="location" class="w-full border p-2 rounded"><option>餐具表面</option><option>操作台</option></select></div>
            <div><label class="block text-sm mb-1">RLU</label><input type="number" name="rluValue" class="w-full border p-2 rounded"></div>
            <div><label class="block text-sm mb-1">结果</label><select name="result" class="w-full border p-2 rounded"><option>合格</option><option>不合格</option></select></div>
            <div class="flex items-end">${removable ? '<button type="button" class="btn-remove-point bg-red-500 text-white px-3 py-2 rounded text-sm">删除</button>' : '<span class="text-xs text-gray-400">默认</span>'}</div>
        </div>`;
}
"""

# ==========================================
# 6. JS Modules: GenericTest.js
# ==========================================
file_contents["js/modules/GenericTest.js"] = """
import { StorageService } from '../core/Storage.js';

export class GenericTestModule {
    constructor(config) {
        this.moduleName = config.moduleName;
        this.formId = config.formId;
        this.tableId = config.tableId;
        this.storage = new StorageService(this.moduleName);
        this.init();
    }

    init() {
        const form = document.getElementById(this.formId);
        if (form) {
            form.removeAttribute('onsubmit');
            form.addEventListener('submit', (e) => this.handleSubmit(e));
        }

        document.getElementById(this.tableId)?.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-delete');
            if (btn && confirm('确定删除?')) {
                this.storage.delete(btn.dataset.id);
                this.render();
                document.dispatchEvent(new Event('dataChanged'));
            }
        });

        this.render();
    }

    handleSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        this.storage.save(Object.fromEntries(formData.entries()));
        alert('保存成功');
        e.target.reset();
        this.render();
        document.dispatchEvent(new Event('dataChanged'));
    }

    render() {
        const records = this.storage.getAll();
        const tbody = document.getElementById(this.tableId);
        if (!tbody) return;

        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-gray-500">暂无数据</td></tr>`;
            return;
        }

        tbody.innerHTML = records.map(r => {
            const result = r.result || r.colorLevel || '未知';
            const isPass = '合格' === result || result.includes('合格');
            
            let infoCol = '';
            if (this.moduleName === 'pesticide') infoCol = `<td>${r.vegetableType}</td><td>${r.batchNo}</td>`;
            else if (this.moduleName === 'oil') infoCol = `<td>TPM:${r.tpmValue||'-'}</td><td>${r.oilTemp}℃</td>`;
            else if (this.moduleName === 'leanMeat') infoCol = `<td>${r.meatType}</td><td>${r.batchNo}</td>`;

            return `
            <tr class="border-b hover:bg-gray-50">
                <td class="border px-4 py-2">${r.testDate}</td>
                <td class="border px-4 py-2">${r.canteen}</td>
                ${infoCol}
                <td class="border px-4 py-2"><span class="px-2 py-1 rounded-full text-xs ${isPass ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${result}</span></td>
                <td class="border px-4 py-2">${r.inspector}</td>
                <td class="border px-4 py-2"><button class="text-red-600 btn-delete" data-id="${r.id}"><i class="fas fa-trash"></i></button></td>
            </tr>`;
        }).join('');
    }
}
"""

# ==========================================
# 7. JS Modules: Pathogen.js (新增)
# ==========================================
file_contents["js/modules/Pathogen.js"] = """
import { StorageService } from '../core/Storage.js';

const storage = new StorageService('pathogen');

export function initPathogen() {
    const btnImport = document.getElementById('btnImportPathogen');
    const fileInput = document.getElementById('pathogenFileInput');
    
    if (btnImport && fileInput) {
        btnImport.addEventListener('click', () => {
            if (!fileInput.files.length) return alert('请选择文件');
            handleFileImport(fileInput.files[0]);
        });
    }

    document.getElementById('btnDownloadTemplate')?.addEventListener('click', () => {
        const data = [{ "testDate": "2025-01-01", "sampleId": "S001", "canteen": "一食堂", "sampleType": "留样", "positiveItems": "无", "riskLevel": "低", "inspector": "张三" }];
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'template.json'; a.click();
    });

    document.getElementById('pathogenRecords')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-delete');
        if (btn && confirm('确定删除?')) {
            storage.delete(btn.dataset.id);
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
        }
    });

    renderTable();
}

function handleFileImport(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            let data = [];
            if (file.name.endsWith('.json')) {
                const json = JSON.parse(e.target.result);
                data = Array.isArray(json) ? json : [json];
            } else {
                return alert('仅支持 JSON 格式');
            }
            
            data.forEach(item => storage.save(item));
            alert(`导入 ${data.length} 条记录`);
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
        } catch (err) {
            alert('文件解析失败');
        }
    };
    reader.readAsText(file);
}

function renderTable() {
    const records = storage.getAll();
    const tbody = document.getElementById('pathogenRecords');
    if (!tbody) return;
    
    if (!records.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-gray-500">暂无数据</td></tr>`;
        return;
    }

    tbody.innerHTML = records.map(r => `
        <tr class="border-b hover:bg-gray-50">
            <td class="border px-4 py-2">${r.testDate || '-'}</td>
            <td class="border px-4 py-2">${r.sampleId || '-'}</td>
            <td class="border px-4 py-2">${r.canteen || '-'}</td>
            <td class="border px-4 py-2">${r.sampleType || '-'}</td>
            <td class="border px-4 py-2 text-red-600">${r.positiveItems || '无'}</td>
            <td class="border px-4 py-2">${r.riskLevel || '-'}</td>
            <td class="border px-4 py-2">${r.inspector || '-'}</td>
            <td class="border px-4 py-2"><button class="text-red-600 btn-delete" data-id="${r.id}"><i class="fas fa-trash"></i></button></td>
        </tr>
    `).join('');
}
"""
# ==========================================
# 8. JS Modules: Dashboard.js
# ==========================================
file_contents["js/modules/Dashboard.js"] = """
import { StorageService } from '../core/Storage.js';

const services = {
    tableware: new StorageService('tableware'),
    pesticide: new StorageService('pesticide'),
    oil: new StorageService('oil'),
    leanMeat: new StorageService('leanMeat'),
    pathogen: new StorageService('pathogen')
};

export function initDashboard() {
    updateDashboard();
    document.addEventListener('dataChanged', updateDashboard);
}

export function updateDashboard() {
    const stats = {
        tableware: calcStats(services.tableware.getAll(), 'tableware'),
        pesticide: calcStats(services.pesticide.getAll(), 'pesticide'),
        oil: calcStats(services.oil.getAll(), 'oil'),
        leanMeat: calcStats(services.leanMeat.getAll(), 'leanMeat')
    };

    updateCard('tableware', stats.tableware);
    updateCard('pesticide', stats.pesticide);
    updateCard('oil', stats.oil);
    updateCard('lean', stats.leanMeat);

    // 计算总数
    let total = 0;
    Object.values(stats).forEach(s => total += s.count);
    total += services.pathogen.getAll().length; // 加上病原体
    
    const totalEl = document.getElementById('card_total_count');
    if (totalEl) totalEl.textContent = total;
}

function calcStats(records, type) {
    let count = 0;
    let passCount = 0;

    if (type === 'tableware') {
        records.forEach(r => {
            if (r.atpPoints) {
                count += r.atpPoints.length;
                passCount += r.atpPoints.filter(p => p.res === '合格').length;
            }
        });
    } else {
        count = records.length;
        passCount = records.filter(r => {
            const res = r.result || r.colorLevel || '';
            return res.includes('合格');
        }).length;
    }
    const passRate = count > 0 ? Math.round((passCount / count) * 100) : 100;
    return { count, passRate };
}

function updateCard(type, stat) {
    const c = document.getElementById(`card_${type}_count`);
    const p = document.getElementById(`card_${type}_pass`);
    if(c) c.textContent = stat.count;
    if(p) p.textContent = `${stat.passRate}%`;
}
"""

# ==========================================
# 9. JS Main Entry: main.js
# ==========================================
file_contents["js/main.js"] = """
import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';

document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('loaded');
    
    // 1. UI 初始化
    UIHelper.setupNavigation();

    // 2. 业务模块初始化
    initTableware();
    initPathogen();
    
    new GenericTestModule({ moduleName: 'pesticide', formId: 'pesticideTestForm', tableId: 'pesticideRecords' });
    new GenericTestModule({ moduleName: 'oil', formId: 'oilTestForm', tableId: 'oilRecords' });
    new GenericTestModule({ moduleName: 'leanMeat', formId: 'leanMeatTestForm', tableId: 'leanMeatRecords' });

    // 3. 看板初始化
    initDashboard();

    // 4. 导出功能绑定
    document.getElementById('btnExportPDF')?.addEventListener('click', () => {
        // 先切换到看板视图，确保截图内容可见
        const dashboardBtn = document.querySelector('[data-target="dashboard"]');
        if(dashboardBtn) dashboardBtn.click();
        
        // 稍微延迟等待DOM渲染
        setTimeout(() => {
            ExportService.generatePDF('dashboard', '食品安全日报');
        }, 500);
    });
});
"""

# ==========================================
# 10. HTML: index.html (完整版)
# ==========================================
file_contents["index.html"] = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>食品安全检验管理系统 (Pro)</title>
    <!-- 样式库 -->
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
    <link rel="stylesheet" href="./css/style.css">
    
    <!-- 脚本库 (defer 延迟加载) -->
    <script src="https://cdn.jsdelivr.net/npm/chart.js" defer></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" defer></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" defer></script>
</head>
<body class="bg-gray-50">

    <!-- 顶部导航 -->
    <nav class="bg-blue-600 text-white shadow-lg">
        <div class="container mx-auto px-4 py-3 flex justify-between items-center">
            <div class="flex items-center space-x-3">
                <i class="fas fa-shield-alt text-2xl"></i>
                <h1 class="text-xl font-bold">田家炳中学食品安全检验管理系统</h1>
            </div>
            <div class="text-sm"><i class="far fa-user"></i> 郭博 (管理员)</div>
        </div>
    </nav>

    <!-- 主容器 -->
    <div class="container mx-auto px-4 py-6 flex gap-6">
        
        <!-- 左侧菜单 -->
        <div class="bg-gray-800 text-white w-64 flex-shrink-0 hidden md:block rounded-lg shadow-lg h-screen sticky top-4">
            <div class="p-4 border-b border-gray-700">
                <h1 class="text-xl font-bold">检测系统</h1>
                <p class="text-xs text-gray-400 mt-1">Version 2.0 (Modular)</p>
            </div>
            <nav class="p-2 space-y-1">
                <button class="nav-btn active w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="dashboard">
                    <i class="fas fa-tachometer-alt mr-3 w-5"></i>数据看板
                </button>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="tableware-test">
                    <i class="fas fa-utensils mr-3 w-5"></i>餐具洁净度
                </button>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="pesticide-test">
                    <i class="fas fa-seedling mr-3 w-5"></i>果蔬农残
                </button>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="oil-test">
                    <i class="fas fa-oil-can mr-3 w-5"></i>食用油品质
                </button>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="lean-meat-test">
                    <i class="fas fa-drumstick-bite mr-3 w-5"></i>瘦肉精检测
                </button>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="pathogen-test">
                    <i class="fas fa-virus mr-3 w-5"></i>病原体检测
                </button>
                <div class="border-t border-gray-700 my-2"></div>
                <button class="nav-btn w-full text-left px-4 py-2 rounded hover:bg-blue-700 flex items-center" data-target="export-data">
                    <i class="fas fa-file-export mr-3 w-5"></i>数据导出
                </button>
            </nav>
        </div>

        <!-- 右侧内容 -->
        <div class="flex-1 min-w-0">
            
            <!-- 1. 看板 -->
            <div id="dashboard" class="content-section">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-6 text-gray-800">实时数据概览</h2>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                        <div class="bg-blue-500 rounded-lg p-4 text-white shadow">
                            <p class="opacity-90 text-sm">餐具洁净度</p>
                            <p class="text-3xl font-bold" id="card_tableware_count">0</p>
                            <p class="text-xs">合格率: <span id="card_tableware_pass">0%</span></p>
                        </div>
                        <div class="bg-green-500 rounded-lg p-4 text-white shadow">
                            <p class="opacity-90 text-sm">果蔬农残</p>
                            <p class="text-3xl font-bold" id="card_pesticide_count">0</p>
                            <p class="text-xs">合格率: <span id="card_pesticide_pass">0%</span></p>
                        </div>
                        <div class="bg-yellow-500 rounded-lg p-4 text-white shadow">
                            <p class="opacity-90 text-sm">食用油品质</p>
                            <p class="text-3xl font-bold" id="card_oil_count">0</p>
                            <p class="text-xs">合格率: <span id="card_oil_pass">0%</span></p>
                        </div>
                        <div class="bg-red-500 rounded-lg p-4 text-white shadow">
                            <p class="opacity-90 text-sm">瘦肉精</p>
                            <p class="text-3xl font-bold" id="card_lean_count">0</p>
                            <p class="text-xs">合格率: <span id="card_lean_pass">0%</span></p>
                        </div>
                    </div>
                    <div class="text-right text-gray-500">
                        总检测样本数: <span id="card_total_count" class="font-bold text-xl text-gray-800">0</span>
                    </div>
                </div>
            </div>

            <!-- 2. 餐具检测 -->
            <div id="tableware-test" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-4 border-b pb-2">餐具洁净度检测 (ATP)</h2>
                    <form id="tablewareTestForm" class="space-y-4 mb-6">
                        <div class="grid grid-cols-3 gap-4">
                            <input type="date" name="testDate" required class="border p-2 rounded">
                            <select name="canteen" class="border p-2 rounded"><option>一食堂</option><option>二食堂</option></select>
                            <input type="text" name="inspector" placeholder="检测员" required class="border p-2 rounded">
                        </div>
                        <div id="atpPointsContainer">
                            <div class="border p-4 bg-gray-50 atp-point rounded mb-2">
                                <div class="grid grid-cols-4 gap-4">
                                    <select name="location" class="border p-2 rounded"><option>餐具表面</option><option>操作台</option></select>
                                    <input type="number" name="rluValue" placeholder="RLU值" class="border p-2 rounded">
                                    <select name="result" class="border p-2 rounded"><option>合格</option><option>不合格</option></select>
                                    <span class="text-xs text-gray-400 pt-3">默认</span>
                                </div>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <button type="button" id="btnAddAtpPoint" class="px-4 py-2 bg-green-500 text-white rounded">添加点位</button>
                            <button type="submit" class="px-6 py-2 bg-blue-600 text-white rounded">保存</button>
                        </div>
                    </form>
                    <table class="w-full text-sm"><thead class="bg-gray-100"><tr><th class="p-2 border">日期</th><th class="p-2 border">食堂</th><th class="p-2 border">点位</th><th class="p-2 border">RLU</th><th class="p-2 border">结果</th><th class="p-2 border">操作</th></tr></thead><tbody id="tablewareRecords"></tbody></table>
                </div>
            </div>

            <!-- 3. 农残检测 -->
            <div id="pesticide-test" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-4 border-b pb-2">果蔬农残检测</h2>
                    <form id="pesticideTestForm" class="space-y-4 mb-6">
                        <div class="grid grid-cols-4 gap-4">
                            <input type="date" name="testDate" required class="border p-2 rounded">
                            <select name="canteen" class="border p-2 rounded"><option>一食堂</option><option>二食堂</option></select>
                            <input type="text" name="vegetableType" placeholder="蔬菜品种" required class="border p-2 rounded">
                            <input type="text" name="batchNo" placeholder="批次号" required class="border p-2 rounded">
                            <select name="result" class="border p-2 rounded"><option>合格</option><option>不合格</option></select>
                            <input type="text" name="inspector" placeholder="检测员" required class="border p-2 rounded">
                        </div>
                        <button type="submit" class="px-6 py-2 bg-blue-600 text-white rounded">保存</button>
                    </form>
                    <table class="w-full text-sm"><thead class="bg-gray-100"><tr><th class="p-2 border">日期</th><th class="p-2 border">食堂</th><th class="p-2 border">品种</th><th class="p-2 border">批次</th><th class="p-2 border">结果</th><th class="p-2 border">操作</th></tr></thead><tbody id="pesticideRecords"></tbody></table>
                </div>
            </div>

            <!-- 4. 食用油检测 -->
            <div id="oil-test" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-4 border-b pb-2">食用油品质检测</h2>
                    <form id="oilTestForm" class="space-y-4 mb-6">
                        <div class="grid grid-cols-4 gap-4">
                            <input type="date" name="testDate" required class="border p-2 rounded">
                            <select name="canteen" class="border p-2 rounded"><option>一食堂</option><option>二食堂</option></select>
                            <input type="number" name="oilTemp" placeholder="油温" required class="border p-2 rounded">
                            <input type="number" name="tpmValue" placeholder="TPM值" class="border p-2 rounded">
                            <select name="colorLevel" class="border p-2 rounded"><option>合格</option><option>警戒</option><option>不合格</option></select>
                            <input type="text" name="inspector" placeholder="检测员" required class="border p-2 rounded">
                        </div>
                        <button type="submit" class="px-6 py-2 bg-blue-600 text-white rounded">保存</button>
                    </form>
                    <table class="w-full text-sm"><thead class="bg-gray-100"><tr><th class="p-2 border">日期</th><th class="p-2 border">食堂</th><th class="p-2 border">TPM</th><th class="p-2 border">油温</th><th class="p-2 border">结果</th><th class="p-2 border">操作</th></tr></thead><tbody id="oilRecords"></tbody></table>
                </div>
            </div>

            <!-- 5. 瘦肉精检测 -->
            <div id="lean-meat-test" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-4 border-b pb-2">瘦肉精检测</h2>
                    <form id="leanMeatTestForm" class="space-y-4 mb-6">
                        <div class="grid grid-cols-4 gap-4">
                            <input type="date" name="testDate" required class="border p-2 rounded">
                            <select name="canteen" class="border p-2 rounded"><option>一食堂</option><option>二食堂</option></select>
                            <select name="meatType" class="border p-2 rounded"><option>猪肉</option><option>牛肉</option></select>
                            <input type="text" name="batchNo" placeholder="批次号" required class="border p-2 rounded">
                            <select name="result" class="border p-2 rounded"><option>合格</option><option>不合格</option></select>
                            <input type="text" name="inspector" placeholder="检测员" required class="border p-2 rounded">
                        </div>
                        <button type="submit" class="px-6 py-2 bg-blue-600 text-white rounded">保存</button>
                    </form>
                    <table class="w-full text-sm"><thead class="bg-gray-100"><tr><th class="p-2 border">日期</th><th class="p-2 border">食堂</th><th class="p-2 border">品种</th><th class="p-2 border">批次</th><th class="p-2 border">结果</th><th class="p-2 border">操作</th></tr></thead><tbody id="leanMeatRecords"></tbody></table>
                </div>
            </div>

            <!-- 6. 病原体检测 (Pathogen) - 新增 -->
            <div id="pathogen-test" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6">
                    <h2 class="text-2xl font-bold mb-4 border-b pb-2">食源性细菌/病毒检测 (导入)</h2>
                    <div class="bg-blue-50 border border-blue-200 p-4 rounded mb-4 text-sm text-blue-800">
                        支持导入 PCR 仪导出的 JSON 格式数据。
                    </div>
                    <div class="flex gap-4 items-end mb-6 border p-4 rounded bg-gray-50">
                        <div class="flex-1">
                            <label class="block text-sm mb-1">选择文件 (.json)</label>
                            <input type="file" id="pathogenFileInput" accept=".json" class="w-full border p-2 rounded bg-white">
                        </div>
                        <button id="btnImportPathogen" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">导入</button>
                        <button id="btnDownloadTemplate" class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">下载模板</button>
                    </div>
                    <table class="w-full text-sm"><thead class="bg-gray-100"><tr><th class="p-2 border">日期</th><th class="p-2 border">样本ID</th><th class="p-2 border">食堂</th><th class="p-2 border">类型</th><th class="p-2 border">阳性项</th><th class="p-2 border">风险</th><th class="p-2 border">检测员</th><th class="p-2 border">操作</th></tr></thead><tbody id="pathogenRecords"></tbody></table>
                </div>
            </div>

            <!-- 7. 数据导出 - 新增 -->
            <div id="export-data" class="content-section hidden">
                <div class="bg-white rounded-lg shadow-md p-6 text-center">
                    <h2 class="text-2xl font-bold mb-8">数据导出中心</h2>
                    <div class="border-2 border-dashed border-gray-300 rounded-lg p-12">
                        <i class="fas fa-file-pdf text-6xl text-red-500 mb-6"></i>
                        <p class="text-gray-600 mb-6">将当前看板数据生成为 PDF 日报文件</p>
                        <button id="btnExportPDF" class="px-8 py-3 bg-green-600 text-white rounded-lg text-lg shadow hover:bg-green-700 transition">
                            <i class="fas fa-download mr-2"></i>生成并下载日报
                        </button>
                    </div>
                </div>
            </div>

        </div>
    </div>

    <!-- 模块入口 -->
    <script type="module" src="./js/main.js"></script>
</body>
</html>
"""

# ==========================================
# 执行文件生成
# ==========================================
def create_project():
    if not os.path.exists(BASE_DIR):
        os.makedirs(BASE_DIR)
        print(f"Created directory: {BASE_DIR}")

    for file_path, content in file_contents.items():
        full_path = os.path.join(BASE_DIR, file_path)
        
        # 确保子目录存在
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        
        # 写入文件
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content.strip())
        
        print(f"Generated: {file_path}")

    print("-" * 50)
    print("✅ 项目骨架生成成功！")
    print(f"位置: {os.path.abspath(BASE_DIR)}")
    print("请使用 VS Code 打开该文件夹，并使用 Live Server 运行 index.html")

if __name__ == "__main__":
    create_project()

