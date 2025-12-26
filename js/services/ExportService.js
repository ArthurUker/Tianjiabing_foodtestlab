import { StorageService } from '../core/Storage.js';  // ✅ 添加导入

export class ExportService {
    constructor() {
        console.log('🔧 ExportService 初始化');
        
        // ✅ 创建 StorageService 实例（与其他模块保持一致）
        this.storage = {
            tableware: new StorageService('tableware'),
            pesticide: new StorageService('pesticide'),
            oil: new StorageService('oil'),
            leanMeat: new StorageService('leanMeat'),
            pathogen: new StorageService('pathogen')
        };
        
        // 初始化时检查所有数据
        console.log('\n=== 数据检查 ===');
        const types = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
        types.forEach(type => {
            const data = this.storage[type].getAll();
            console.log(`${type}: ${data.length} 条记录`);
        });
    }

    init() {
        console.log('🔧 ExportService init 开始');
        const container = document.getElementById('export-data');
        
        if (!container) {
            console.error('❌ 容器未找到');
            return;
        }
        
        console.log('✅ 找到容器');
        
        try {
            const html = this.renderUI();
            console.log('✅ renderUI 完成，长度:', html.length);
            
            container.innerHTML = html;
            console.log('✅ innerHTML 设置完成');
            
            this.attachEventListeners();
            console.log('✅ 事件监听器绑定完成');
        } catch (error) {
            console.error('❌ init 过程出错:', error);
        }
    }

    renderUI() {
        return `
            <div class="bg-white rounded-lg shadow-md p-6">
                <h2 class="text-2xl font-bold mb-6 text-gray-800 border-b pb-3">
                    <i class="fas fa-file-export mr-2 text-blue-600"></i>数据导出报告
                </h2>

                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    
                    <!-- 左侧：配置面板 -->
                    <div class="space-y-6">
                        
                        <!-- 日期范围选择 -->
                        <div class="border rounded-lg p-4 bg-gray-50">
                            <h3 class="font-semibold mb-3 text-gray-700">
                                <i class="far fa-calendar-alt mr-2"></i>选择日期范围
                            </h3>
                            <div class="grid grid-cols-2 gap-3 mb-3">
                                <div>
                                    <label class="block text-sm text-gray-600 mb-1">开始日期</label>
                                    <input type="date" id="exportStartDate" class="w-full border p-2 rounded">
                                </div>
                                <div>
                                    <label class="block text-sm text-gray-600 mb-1">结束日期</label>
                                    <input type="date" id="exportEndDate" class="w-full border p-2 rounded">
                                </div>
                            </div>
                            <div class="flex gap-2 flex-wrap">
                                <button class="quick-date-btn px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200" data-days="0">今日</button>
                                <button class="quick-date-btn px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200" data-days="7">近7天</button>
                                <button class="quick-date-btn px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200" data-days="30">近30天</button>
                                <button class="quick-date-btn px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200" data-days="90">近3个月</button>
                            </div>
                        </div>

                        <!-- 食堂选择 & 检测类型选择 (并排) -->
                        <div class="grid grid-cols-2 gap-4">
                            
                            <!-- 食堂选择 -->
                            <div class="border rounded-lg p-4 bg-gray-50">
                                <h3 class="font-semibold mb-3 text-gray-700 text-sm">
                                    <i class="fas fa-building mr-2"></i>选择食堂
                                </h3>
                                <div class="space-y-2">
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="canteen-checkbox mr-2" value="all" checked>
                                        <span class="font-medium">全部食堂</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="canteen-checkbox mr-2" value="一食堂">
                                        <span>一食堂</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="canteen-checkbox mr-2" value="二食堂">
                                        <span>二食堂</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="canteen-checkbox mr-2" value="三食堂">
                                        <span>三食堂</span>
                                    </label>
                                </div>
                            </div>

                            <!-- 检测类型选择 -->
                            <div class="border rounded-lg p-4 bg-gray-50">
                                <h3 class="font-semibold mb-3 text-gray-700 text-sm">
                                    <i class="fas fa-clipboard-check mr-2"></i>选择检测类型
                                </h3>
                                <div class="space-y-2">
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="test-type-checkbox mr-2" value="tableware" checked>
                                        <span>餐具洁净度</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="test-type-checkbox mr-2" value="pesticide" checked>
                                        <span>果蔬农残</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="test-type-checkbox mr-2" value="oil" checked>
                                        <span>食用油品质</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="test-type-checkbox mr-2" value="leanMeat" checked>
                                        <span>肉、蛋农残</span>
                                    </label>
                                    <label class="flex items-center text-sm">
                                        <input type="checkbox" class="test-type-checkbox mr-2" value="pathogen" checked>
                                        <span>病原体检测</span>
                                    </label>
                                </div>
                            </div>
                            
                        </div>

                        <!-- 报告配置 -->
                        <div class="border rounded-lg p-4 bg-gray-50">
                            <h3 class="font-semibold mb-3 text-gray-700">
                                <i class="fas fa-cog mr-2"></i>报告配置
                            </h3>
                            <div class="space-y-3">
                                <div>
                                    <label class="block text-sm text-gray-600 mb-1">报告标题</label>
                                    <input type="text" id="reportTitle" class="w-full border p-2 rounded" 
                                           placeholder="食品安全检测报告" value="食品安全检测报告">
                                </div>
                                <div>
                                    <label class="block text-sm text-gray-600 mb-1">备注说明</label>
                                    <textarea id="reportNotes" class="w-full border p-2 rounded" rows="2" 
                                              placeholder="可选：添加备注信息"></textarea>
                                </div>
                            </div>
                        </div>

                        <!-- 操作按钮 -->
                        <div class="flex gap-3">
                            <button id="btnPreviewReport" class="flex-1 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                                <i class="fas fa-eye mr-2"></i>预览报告
                            </button>
                            <button id="btnExportPDF" class="flex-1 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition">
                                <i class="fas fa-download mr-2"></i>导出PDF
                            </button>
                        </div>
                    </div>

                    <!-- 右侧：预览区域 -->
                    <div class="border rounded-lg p-4 bg-gray-50">
                        <h3 class="font-semibold mb-3 text-gray-700">
                            <i class="far fa-file-alt mr-2"></i>报告预览
                        </h3>
                        <div id="reportPreview" class="bg-white border rounded p-4 min-h-96 text-sm overflow-auto" style="max-height: 600px;">
                            <p class="text-gray-400 text-center py-12">
                                <i class="fas fa-info-circle text-4xl mb-3 block"></i>
                                点击"预览报告"查看导出内容
                            </p>
                        </div>
                    </div>

                </div>
            </div>
        `;
    }

    attachEventListeners() {
        console.log('🔧 开始绑定事件监听器');
        
        // 快速日期选择
        const quickDateBtns = document.querySelectorAll('.quick-date-btn');
        quickDateBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const days = parseInt(e.currentTarget.dataset.days, 10);
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - days);
                
                document.getElementById('exportStartDate').valueAsDate = startDate;
                document.getElementById('exportEndDate').valueAsDate = endDate;
                
                console.log(`📅 快速选择: ${days}天, ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
            });
        });

        // 全选食堂逻辑
        const allCanteenCheckbox = document.querySelector('.canteen-checkbox[value="all"]');
        const canteenCheckboxes = document.querySelectorAll('.canteen-checkbox:not([value="all"])');
        
        allCanteenCheckbox?.addEventListener('change', (e) => {
            canteenCheckboxes.forEach(cb => cb.checked = e.target.checked);
        });

        // 预览报告
        const btnPreview = document.getElementById('btnPreviewReport');
        if (btnPreview) {
            btnPreview.addEventListener('click', () => {
                this.previewReport();
            });
        }

        // 导出PDF
        const btnExport = document.getElementById('btnExportPDF');
        if (btnExport) {
            btnExport.addEventListener('click', () => {
                this.exportToPDF();
            });
        }

        // ✅ 初始化日期为近30天（避免第一次为空）
        const today = new Date();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(today.getDate() - 30);
        
        const startInput = document.getElementById('exportStartDate');
        const endInput = document.getElementById('exportEndDate');
        
        if (startInput) startInput.valueAsDate = thirtyDaysAgo;
        if (endInput) endInput.valueAsDate = today;
    }

    getExportConfig() {
        const startDate = document.getElementById('exportStartDate').value;
        const endDate = document.getElementById('exportEndDate').value;
        
        const canteens = Array.from(document.querySelectorAll('.canteen-checkbox:checked'))
            .map(cb => cb.value)
            .filter(v => v !== 'all');
        
        const testTypes = Array.from(document.querySelectorAll('.test-type-checkbox:checked'))
            .map(cb => cb.value);
        
        const title = document.getElementById('reportTitle').value || '食品安全检测报告';
        const notes = document.getElementById('reportNotes').value;
        
        return { startDate, endDate, canteens, testTypes, title, notes };
    }

    // ✅ 修改：使用 StorageService 的 getAll() 方法
    collectData(config) {
        const data = {};

        const hasStart = !!config.startDate;
        const hasEnd = !!config.endDate;

        const start = hasStart ? new Date(config.startDate + 'T00:00:00') : null;
        const end = hasEnd ? new Date(config.endDate + 'T23:59:59.999') : null;

        const startMs = start ? start.getTime() : null;
        const endMs = end ? end.getTime() : null;

        console.log('🔍 筛选条件:', {
            start: start ? start.toString() : '(无限制)',
            end: end ? end.toString() : '(无限制)',
            canteens: config.canteens.length ? config.canteens : '(全部)'
        });

        config.testTypes.forEach(type => {
            // ✅ 使用 StorageService 的 getAll() 方法
            const records = this.storage[type].getAll();

            let matchedLogCount = 0;

            data[type] = records.filter(record => {
                const raw = record?.testDate;
                if (!raw) return false;

                const t = new Date(raw).getTime();
                if (Number.isNaN(t)) {
                    if (matchedLogCount < 3) {
                        console.warn(`⚠️ 无法解析的日期:`, raw, record);
                    }
                    return false;
                }

                const inDateRange =
                    (!startMs || t >= startMs) &&
                    (!endMs || t <= endMs);

                const inCanteen =
                    config.canteens.length === 0 ||
                    config.canteens.includes(record.canteen);

                const ok = inDateRange && inCanteen;

                if (ok && matchedLogCount < 3) {
                    console.log(`  ✓ 命中样例(${type}):`, {
                        testDate: record.testDate,
                        canteen: record.canteen
                    });
                    matchedLogCount++;
                }

                return ok;
            });

            console.log(`  📊 ${type}: 原始 ${records.length} 条 -> 筛选后 ${data[type].length} 条`);
        });

        return data;
    }

    previewReport() {
        console.log('\n=== 开始生成报告预览 ===');
        
        const config = this.getExportConfig();
        console.log('📋 配置信息:', config);
        
        const data = this.collectData(config);
        console.log('📊 收集到的数据:', data);
        
        // 统计数据
        let totalCount = 0;
        Object.keys(data).forEach(type => {
            const count = data[type].length;
            totalCount += count;
        });
        console.log(`总计: ${totalCount} 条记录`);
        
        if (totalCount === 0) {
            console.warn('⚠️ 警告：没有找到任何数据！');
            console.log('请检查：');
            console.log('1. 日期范围是否正确？');
            console.log('2. 是否有录入过数据？');
            console.log('3. localStorage 中的 key 名称是否匹配？');
        }
        
        const html = this.generateReportHTML(data, config);
        document.getElementById('reportPreview').innerHTML = html;
    }
    
    generateReportHTML(data, config) {
        let html = `
            <div class="report-content" id="pdfContent">
                <div class="text-center mb-6 pb-4 border-b-2">
                    <h2 class="text-2xl font-bold mb-2">${config.title}</h2>
                    <p class="text-sm text-gray-600">
                        报告日期：${config.startDate} 至 ${config.endDate}
                    </p>
                    <p class="text-xs text-gray-500 mt-1">
                        生成时间：${new Date().toLocaleString('zh-CN')}
                    </p>
                </div>
        `;
        
        html += this.generateStatisticsSummary(data, config);
        
        const typeNames = {
            tableware: '餐具洁净度检测',
            pesticide: '果蔬农残检测',
            oil: '食用油品质检测',
            leanMeat: '肉、蛋农残检测',
            pathogen: '病原体检测'
        };
        
        let totalRecords = 0;
        config.testTypes.forEach(type => {
            const records = data[type] || [];
            totalRecords += records.length;
            
            html += `
                <div class="mb-6 page-break-inside-avoid">
                    <h3 class="font-bold text-lg mb-3 pb-2 border-b bg-gray-100 px-2 py-1">
                        ${typeNames[type]}
                    </h3>
                    <p class="text-sm text-gray-600 mb-3 px-2">
                        检测记录数：<span class="font-semibold text-blue-600">${records.length}</span> 条
                    </p>
            `;
            
            if (records.length > 0) {
                html += this.generateTableForType(type, records);
            } else {
                html += '<p class="text-gray-400 text-sm px-2 py-4 bg-gray-50 rounded">暂无数据</p>';
            }
            
            html += '</div>';
        });
        
        html += `
            <div class="mt-6 p-4 bg-blue-50 border border-blue-200 rounded">
                <h4 class="font-bold mb-2">📊 数据汇总</h4>
                <p class="text-sm">总检测记录数：<span class="font-bold text-blue-600">${totalRecords}</span> 条</p>
                <p class="text-sm">检测类型数：<span class="font-bold text-blue-600">${config.testTypes.length}</span> 类</p>
                <p class="text-sm">涉及食堂：<span class="font-bold text-blue-600">${config.canteens.length || '全部'}</span></p>
            </div>
        `;
        
        if (config.notes) {
            html += `
                <div class="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
                    <p class="text-sm"><strong>📝 备注：</strong>${config.notes}</p>
                </div>
            `;
        }
        
        html += '</div>';
        return html;
    }

    generateTableForType(type, records) {
        let html = '<div class="overflow-x-auto"><table class="w-full text-xs border-collapse border"><thead class="bg-gray-200"><tr>';
        
        const headers = this.getTableHeaders(type);
        headers.forEach(h => html += `<th class="border border-gray-300 p-2 font-semibold">${h}</th>`);
        html += '</tr></thead><tbody>';
        
        records.forEach((record, index) => {
            const bgClass = index % 2 === 0 ? 'bg-white' : 'bg-gray-50';
            html += `<tr class="${bgClass}">`;
            const values = this.getTableValues(type, record);
            values.forEach(v => html += `<td class="border border-gray-300 p-2">${v || '-'}</td>`);
            html += '</tr>';
        });
        
        html += '</tbody></table></div>';
        return html;
    }

    generateStatisticsSummary(data, config) {
        const typeNames = {
            tableware: '餐具洁净度',
            pesticide: '果蔬农残',
            oil: '食用油品质',
            leanMeat: '瘦肉精检测',
            pathogen: '病原体检测'
        };
        
        let html = `
            <div class="mb-6 p-5 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg border-2 border-blue-200">
                <h3 class="text-lg font-bold mb-4 text-gray-800 border-b-2 border-blue-300 pb-2">
                    📊 检测统计数据
                </h3>
                <div class="space-y-2">
        `;
        
        config.testTypes.forEach(type => {
            const records = data[type] || [];
            const total = records.length;
            
            let displayText = '';
            
            if (type === 'pathogen') {
                // ✅ 病原体检测：统计阳性数量
                const positiveCount = records.filter(r => {
                    const items = r.positiveItems;
                    if (Array.isArray(items) && items.length > 0) return true;
                    if (typeof items === 'string' && items && items !== '无' && items.trim() !== '') return true;
                    return false;
                }).length;
                displayText = `检测 <strong>${total}</strong> 次，阳性 <strong class="${positiveCount > 0 ? 'text-red-600' : 'text-green-600'}">${positiveCount}</strong> 次`;
            
            } else {
                // ✅ 其他类型：统一使用与数据看板相同的判断逻辑
                const passCount = records.filter(r => {
                    // 与 Dashboard.js 第 193 行保持一致
                    return r.result?.includes('合格') || r.colorLevel === '合格';
                }).length;
                
                const passRate = total > 0 ? ((passCount / total) * 100).toFixed(0) + '%' : '100%';
                
                displayText = `检测 <strong>${total}</strong> 次，合格率 <strong class="${passRate === '100%' ? 'text-green-600' : 'text-orange-600'}">${passRate}</strong>`;
            }
            
            html += `
                <div class="flex justify-between items-center py-2 px-3 bg-white rounded border border-gray-200 text-sm">
                    <span class="font-medium text-gray-700">${typeNames[type]}</span>
                    <span>${displayText}</span>
                </div>
            `;
        });
        
        html += `
                </div>
            </div>
        `;
        
        const risks = this.analyzeRisks(data);
        html += `
            <div class="mb-6 p-4 ${risks.length > 0 ? 'bg-yellow-50 border-yellow-300' : 'bg-green-50 border-green-300'} rounded-lg border-2">
                <h3 class="font-bold mb-2 text-gray-800 text-base">
                    ${risks.length > 0 ? '⚠️ 风险提示' : '✅ 风险提示'}
                </h3>
                ${risks.length > 0 ? 
                    '<ul class="list-disc list-inside space-y-1 text-sm">' + 
                    risks.map(r => `<li class="text-orange-700">${r}</li>`).join('') + 
                    '</ul>' 
                    : 
                    '<p class="text-sm text-green-700">• 暂无风险提示</p>'
                }
            </div>
        `;
        
        html += `
            <div class="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-300">
                <h3 class="font-bold mb-2 text-gray-800 text-base">📝 备注</h3>
                <p class="text-sm ${config.notes ? 'text-gray-700' : 'text-gray-400'}">
                    ${config.notes || '无'}
                </p>
            </div>
        `;
        
        return html;
    }

    analyzeRisks(data) {
        const risks = [];
        
        if (data.tableware && data.tableware.length > 0) {
            const highRLU = data.tableware.filter(r => {
                const rlu = parseInt(r.rluValue);
                return !isNaN(rlu) && rlu > 100;
            });
            if (highRLU.length > 0) {
                risks.push(`餐具洁净度检测发现 ${highRLU.length} 次RLU值超标（>100）`);
            }
        }
        
        if (data.pesticide && data.pesticide.length > 0) {
            const failed = data.pesticide.filter(r => {
                const result = (r.result || '').toString().toLowerCase();
                return result.includes('不合格') || result.includes('超标') || result.includes('阳性');
            });
            if (failed.length > 0) {
                risks.push(`果蔬农残检测发现 ${failed.length} 次不合格`);
            }
        }
        
        if (data.oil && data.oil.length > 0) {
            const poorQuality = data.oil.filter(r => {
                const tpm = parseFloat(r.tpmValue);
                return !isNaN(tpm) && tpm > 24;
            });
            if (poorQuality.length > 0) {
                risks.push(`食用油品质检测发现 ${poorQuality.length} 次TPM值偏高（>24%）`);
            }
        }
        
        if (data.leanMeat && data.leanMeat.length > 0) {
            const positive = data.leanMeat.filter(r => {
                const result = (r.result || '').toString().toLowerCase();
                return result.includes('阳性') || result.includes('不合格') || result.includes('检出');
            });
            if (positive.length > 0) {
                risks.push(`瘦肉精检测发现 ${positive.length} 次阳性结果`);
            }
        }
        
        if (data.pathogen && data.pathogen.length > 0) {
            const positive = data.pathogen.filter(r => {
                const items = r.positiveItems;
                if (Array.isArray(items) && items.length > 0) return true;
                if (typeof items === 'string' && items && items !== '无' && items.trim() !== '') return true;
                return false;
            });
            if (positive.length > 0) {
                risks.push(`病原体检测发现 ${positive.length} 次阳性样本`);
            }
        }
        
        return risks;
    }

    getTableHeaders(type) {
        const headers = {
            tableware: ['日期', '食堂', '点位', 'RLU值', '结果', '检测员'],
            pesticide: ['日期', '食堂', '蔬菜品种', '检测项目', '结果', '检测员'],
            oil: ['日期', '食堂', '油温(℃)', 'TPM值(%)', '品质等级', '检测员'],
            leanMeat: ['日期', '食堂', '肉类品种', '检测项目', '结果', '检测员'],
            pathogen: ['日期', '样本ID', '食堂', '类型', '阳性项', '风险等级', '检测员']
        };
        return headers[type] || [];
    }

    getTableValues(type, record) {
        const formatPositiveItems = (items) => {
            if (!items) return '无';
            if (Array.isArray(items)) return items.join(', ') || '无';
            if (typeof items === 'string') return items || '无';
            return '无';
        };
        
        const values = {
            tableware: [
                record.testDate || '-', 
                record.canteen || '-', 
                record.location || '-', 
                record.rluValue || '-', 
                record.result || '-', 
                record.inspector || '-'
            ],
            pesticide: [
                record.testDate || '-', 
                record.canteen || '-', 
                record.vegetableType || '-', 
                record.batchNo || '-', 
                record.result || '-', 
                record.inspector || '-'
            ],
            oil: [
                record.testDate || '-', 
                record.canteen || '-', 
                record.oilTemp || '-', 
                record.tpmValue || '-', 
                record.colorLevel || record.qualityLevel || '-', 
                record.inspector || '-'
            ],
            leanMeat: [
                record.testDate || '-', 
                record.canteen || '-', 
                record.meatType || '-', 
                record.batchNo || record.testItem || '-', 
                record.result || '-', 
                record.inspector || '-'
            ],
            pathogen: [
                record.testDate || '-', 
                record.sampleId || '-', 
                record.canteen || '-', 
                record.sampleType || '-', 
                formatPositiveItems(record.positiveItems),
                record.riskLevel || record.result || '-', 
                record.inspector || '-'
            ]
        };
        
        return values[type] || [];
    }

    async exportToPDF() {
        if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
            alert('PDF库加载中，请稍后再试...');
            return;
        }

        const preview = document.getElementById('reportPreview');
        const content = preview.querySelector('#pdfContent');
        
        if (!content) {
            alert('请先点击"预览报告"生成报告内容');
            return;
        }

        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'pdfLoadingOverlay';
        loadingDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
        loadingDiv.innerHTML = `
            <div style="background:white;border-radius:8px;padding:32px;text-align:center;">
                <i class="fas fa-spinner fa-spin" style="font-size:48px;color:#3b82f6;margin-bottom:16px;"></i>
                <p style="color:#4b5563;font-size:18px;">正在生成高清PDF，请稍候...</p>
                <p style="color:#9ca3af;font-size:14px;margin-top:8px;">正在智能分页处理...</p>
            </div>
        `;
        document.body.appendChild(loadingDiv);

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            
            const pageWidth = 210;
            const pageHeight = 297;
            const margin = 10;
            const contentWidth = pageWidth - (margin * 2);
            const contentHeight = pageHeight - (margin * 2);
            
            const sections = content.querySelectorAll('.mb-6, .report-content > div');
            
            let currentY = margin;
            let pageNumber = 1;
            
            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];
                
                const tempContainer = document.createElement('div');
                tempContainer.style.cssText = `
                    position: absolute;
                    left: -9999px;
                    top: 0;
                    width: ${contentWidth}mm;
                    padding: 10px;
                    background: white;
                    box-sizing: border-box;
                `;
                tempContainer.innerHTML = section.outerHTML;
                document.body.appendChild(tempContainer);
                
                await new Promise(resolve => setTimeout(resolve, 50));
                
                const canvas = await html2canvas(tempContainer, {
                    scale: 3,
                    useCORS: true,
                    allowTaint: true,
                    logging: false,
                    backgroundColor: '#ffffff',
                    windowWidth: tempContainer.scrollWidth,
                    windowHeight: tempContainer.scrollHeight
                });
                
                document.body.removeChild(tempContainer);
                
                const imgData = canvas.toDataURL('image/png', 1.0);
                const imgWidth = contentWidth;
                const imgHeight = (canvas.height * imgWidth) / canvas.width;
                
                if (currentY + imgHeight > pageHeight - margin) {
                    if (currentY > margin + 10) {
                        pdf.addPage();
                        pageNumber++;
                        currentY = margin;
                    } else {
                        const availableHeight = pageHeight - currentY - margin;
                        
                        if (availableHeight > 50) {
                            const ratio = availableHeight / imgHeight;
                            const cropHeight = canvas.height * ratio;
                            
                            const croppedCanvas = document.createElement('canvas');
                            croppedCanvas.width = canvas.width;
                            croppedCanvas.height = cropHeight;
                            const ctx = croppedCanvas.getContext('2d');
                            ctx.drawImage(canvas, 0, 0);
                            
                            const croppedImgData = croppedCanvas.toDataURL('image/png', 1.0);
                            pdf.addImage(croppedImgData, 'PNG', margin, currentY, imgWidth, availableHeight);
                            
                            pdf.addPage();
                            pageNumber++;
                            currentY = margin;
                            
                            const remainingCanvas = document.createElement('canvas');
                            remainingCanvas.width = canvas.width;
                            remainingCanvas.height = canvas.height - cropHeight;
                            const ctx2 = remainingCanvas.getContext('2d');
                            ctx2.drawImage(canvas, 0, -cropHeight);
                            
                            const remainingImgData = remainingCanvas.toDataURL('image/png', 1.0);
                            const remainingHeight = imgHeight - availableHeight;
                            pdf.addImage(remainingImgData, 'PNG', margin, currentY, imgWidth, remainingHeight);
                            currentY += remainingHeight;
                        } else {
                            pdf.addPage();
                            pageNumber++;
                            currentY = margin;
                            pdf.addImage(imgData, 'PNG', margin, currentY, imgWidth, imgHeight);
                            currentY += imgHeight;
                        }
                        continue;
                    }
                }
                
                pdf.addImage(imgData, 'PNG', margin, currentY, imgWidth, imgHeight);
                currentY += imgHeight + 5;
                
                const progressText = loadingDiv.querySelector('p:last-child');
                if (progressText) {
                    progressText.textContent = `正在处理第 ${i + 1}/${sections.length} 个区块...`;
                }
            }
            
            const config = this.getExportConfig();
            const filename = `${config.title}_${config.startDate}_${config.endDate}.pdf`;
            
            pdf.save(filename);
            
            document.body.removeChild(loadingDiv);
            
            this.showToast('✅ 高清PDF导出成功！', 'success');

        } catch (error) {
            console.error('PDF导出失败:', error);
            
            const overlay = document.getElementById('pdfLoadingOverlay');
            if (overlay && overlay.parentNode) {
                document.body.removeChild(overlay);
            }
            
            this.showToast('❌ PDF导出失败：' + error.message, 'error');
        }
    }

    showToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `fixed top-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${
            type === 'success' ? 'bg-green-500' : 
            type === 'error' ? 'bg-red-500' : 'bg-blue-500'
        } text-white`;
        toast.innerHTML = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 3000);
    }

    static async generatePDF(elementId, filename) {
        if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
            alert('PDF库加载中，请稍后再试...');
            return;
        }

        const element = document.getElementById(elementId);
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
            pdf.save(`${filename}_${new Date().toISOString().split('T')[0]}.pdf`);
            
            alert('✅ PDF导出成功！');
        } catch (error) {
            console.error('PDF导出失败:', error);
            alert('❌ PDF导出失败');
        }
    }
}