import { StorageService } from '../core/Storage.js';
import { operationGuard } from '../core/Auth.js';
import { FormValidator } from '../utils/FormValidator.js';
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { GuestAuthService } from '../services/GuestAuthService.js';
import { calculatePathogenRisk, isPositiveResult } from '../utils/pathogenRisk.js';
import { auditLogService } from '../services/AuditLogService.js';
import { permissionService } from '../services/PermissionService.js';

const storage = new StorageService('pathogen');
let currentPage = 1;
let recordsPerPage = 10;
let sortOrder = 'desc';
let selectedCanteenFilter = 'all'; // ✅ 新增：食堂筛选状态

export function initPathogen() {
    // 🔒 权限检查：访客无权访问病原体检测模块
    const guestAuthService = new GuestAuthService();
    const isGuest = guestAuthService.isLoggedIn();
    const isQuickAccess = guestAuthService.isQuickAccessMode();
    
    // P1-18: 基于权限矩阵，访客（含快速访问模式）无 module:pathogen 权限，禁止初始化病原体模块
    // 原守卫 if (isGuest && !isQuickAccess) 放行快速访问访客，与权限矩阵矛盾
    if (isGuest || isQuickAccess) {
        console.warn('⛔ 访客无权访问病原体检测模块');
        UINotification.warning('您无权访问病原体检测模块');
        return; // 访客无权访问，直接返回
    }
    
    const btnImport = document.getElementById('btnImportPathogen');
    const fileInput = document.getElementById('pathogenFileInput');
    
    // 在快速访问模式下隐藏导入行，只显示数据表格
    if (isQuickAccess) {
        // 只隐藏导入操作行（.flex容器本身），不隐藏其父元素（否则整张卡片包括表格都不显示）
        const importRow = fileInput?.closest('.flex');
        if (importRow) {
            importRow.style.display = 'none';
        }
        console.log('✅ 快速访问模式：已隐藏病原体检测的导入操作行，仅显示数据表格');
    } else {
        if (btnImport && fileInput) {
            btnImport.addEventListener('click', () => {
                if (!fileInput.files.length) return alert('请选择文件');
                handleFileImport(fileInput.files[0]);
            });
        }

        document.getElementById('btnDownloadTemplate')?.addEventListener('click', () => {
            const link = document.createElement('a');
            link.href = './templates/pathogen_template.docx';
            link.download = 'pathogen_template.docx';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }

    document.getElementById('pathogenRecords')?.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.btn-delete');
        if (deleteBtn) {
            // P1-06: 按钮点击层权限前置拦截（视觉层隐藏不可信）
            if (!permissionService.hasPermission('records:delete')) {
              UINotification.error('权限不足：您没有删除记录的权限');
              return;
            }
            operationGuard.verify('删除病原体检测记录', (user) => {
                handleDeleteRecord(deleteBtn.dataset.id);
            });
            return;
        }

        const editBtn = e.target.closest('.btn-edit');
        if (editBtn) {
            operationGuard.verify('编辑病原体检测记录', (user) => {
                handleEditRecord(editBtn.dataset.id, user);
            });
            return;
        }

        const resultSpan = e.target.closest('.result-value');
        if (resultSpan) {
            showDetailModal(resultSpan.dataset.id);
        }
    });

    loadMammothJS();
    setupPaginationListeners();
    renderTable();

    // 数据从服务器同步完成后重新渲染表格
    storage.on('sync', () => renderTable());
}

function loadMammothJS() {
    if (window.mammoth) return;
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.21/mammoth.browser.min.js';
    // P2-16: 添加 SRI 完整性校验，防止 CDN 篡改攻击
    script.integrity = 'sha512-bGuEL2NBSooMeQLM6bf6Xdywje4PWKegNTuKpghz2xgFXtRjEs4B3X1ql7nghiCvt8gXBAks5S3KN3Jp3Jgtow==';
    script.crossOrigin = 'anonymous';
    script.async = true;
    document.head.appendChild(script);
}

function handleFileImport(file) {
    if (!file.name.endsWith('.docx')) {
        UINotification.error('❌ 请选择 Word 文档(.docx 格式)');
        return;
    }
    
    const importButton = document.getElementById('btnImportPathogen');
    const originalText = importButton.textContent;
    importButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';
    importButton.disabled = true;
    
    if (!window.mammoth) {
        importButton.innerHTML = originalText;
        importButton.disabled = false;
        UINotification.error('❌ 解析库尚未加载，请稍后重试');
        return;
    }
    
    try {
        const reader = new FileReader();
        reader.onload = function(event) {
            try {
                const arrayBuffer = event.target.result;
                
                window.mammoth.extractRawText({arrayBuffer: arrayBuffer})
                    .then(function(result) {
                        try {
                            const text = result.value;
                            console.log('提取的原始文本:', text);
                            
                            const record = parseDetectionReport(text);
                            
                            if (!record) {
                                UINotification.error('❌ 未能识别报告格式，请确保上传的是标准的检测报告');
                            } else {
                                storage.save(record);
                                UINotification.success(
                                    `✅ 导入成功！\n` +
                                    `样本：${record.sampleId}\n` +
                                    `阳性项：${record.positiveItems}\n` +
                                    `风险等级：${record.riskLevel}`
                                );
                                renderTable();
                                document.dispatchEvent(new Event('dataChanged'));
                            }
                        } catch (parseError) {
                            console.error('报告解析错误:', parseError);
                            UINotification.error('❌ 报告解析失败: ' + parseError.message);
                        } finally {
                            importButton.innerHTML = originalText;
                            importButton.disabled = false;
                        }
                    })
                    .catch(function(error) {
                        console.error('文档提取失败:', error);
                        UINotification.error('❌ 文档提取失败: ' + error.message);
                        importButton.innerHTML = originalText;
                        importButton.disabled = false;
                    });
            } catch (error) {
                console.error('文件读取错误:', error);
                UINotification.error('❌ 文件读取失败: ' + error.message);
                importButton.innerHTML = originalText;
                importButton.disabled = false;
            }
        };
        
        reader.onerror = function(error) {
            console.error('FileReader 错误:', error);
            UINotification.error('❌ 文件读取错误');
            importButton.innerHTML = originalText;
            importButton.disabled = false;
        };
        
        reader.readAsArrayBuffer(file);
    } catch (error) {
        console.error('导入流程错误:', error);
        UINotification.error('❌ 导入失败: ' + error.message);
        importButton.innerHTML = originalText;
        importButton.disabled = false;
    }
}

function handleRecheckImport(file, originalRecord, currentUser, callback) {
    if (!file.name.endsWith('.docx')) {
        alert('请选择Word文档(.docx格式)');
        return;
    }
    
    if (!window.mammoth) {
        alert('解析库尚未加载，请稍后重试');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(event) {
        const arrayBuffer = event.target.result;
        
        window.mammoth.extractRawText({arrayBuffer: arrayBuffer})
            .then(function(result) {
                const text = result.value;
                const recheckData = parseDetectionReport(text);
                
                if (!recheckData) {
                    alert('未能识别复检报告格式');
                    return;
                }
                
                const recheckRecord = {
                    id: Date.now(),
                    importTime: new Date().toLocaleString(),
                    importUser: currentUser,
                    testDate: recheckData.testDate,
                    sampleId: recheckData.sampleId,
                    positiveItems: recheckData.positiveItems,
                    positiveDetails: recheckData.positiveDetails,
                    riskLevel: recheckData.riskLevel,
                    riskReason: recheckData.riskReason,
                    allTestItems: recheckData.allTestItems,
                    inspector: recheckData.inspector,
                    isPassed: recheckData.riskLevel === '无风险'
                };
                
                originalRecord.recheckReports = originalRecord.recheckReports || [];
                originalRecord.recheckReports.unshift(recheckRecord);
                
                if (recheckRecord.isPassed) {
                    originalRecord.finalStatus = '复检通过';
                    originalRecord.riskLevel = '无风险';
                } else {
                    originalRecord.finalStatus = `复检${recheckRecord.riskLevel}`;
                    originalRecord.riskLevel = recheckRecord.riskLevel;
                }
                
                originalRecord.modificationLogs = originalRecord.modificationLogs || [];
                originalRecord.modificationLogs.unshift({
                    time: new Date().toLocaleString(),
                    user: currentUser,
                    action: '导入复检报告',
                    content: `样本 ${recheckData.sampleId}，${recheckData.riskReason}，状态更新为[${originalRecord.finalStatus}]`
                });
                
                if (storage.update(originalRecord.id, originalRecord)) {
                    alert(`复检报告导入成功！\n样本：${recheckData.sampleId}\n风险等级：${recheckData.riskLevel}\n${recheckData.riskReason}`);
                    if (callback) callback(originalRecord);
                } else {
                    alert('保存失败');
                }
            })
            .catch(function(error) {
                console.error('复检报告解析错误:', error);
                alert('文档解析失败：' + error.message);
            });
    };
    
    reader.readAsArrayBuffer(file);
}

function parseDetectionReport(text) {
    if (!text.includes('检测报告') && !text.includes('检测数据')) return null;

    // --- 1. 基础信息提取 ---
    const dateMatch = text.match(/检测开始时间[：:]\s*(\d{4}[-年/]\d{1,2}[-月/]\d{1,2})/);
    const idMatch = text.match(/样本编号\s*([A-Za-z0-9-]+)/);
    const inspectorMatch = text.match(/检测人员\s*(\S+)/);
    const infoMatch = text.match(/样本信息\s*([^\n]+)/);
    const projectMatch = text.match(/检测项目\s*([^\n]+)/);
    const projectName = projectMatch ? projectMatch[1].trim() : '未知项目';

    // --- 2. 文本清洗与预处理 ---
    // 移除空行，确保索引连续有效
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // --- 3. 动态计算列偏移量 (Header Mapping) ---
    // 默认偏移量 (兜底策略：25项的结构)
    let offsetCt = 1;      // 通道下一行是Ct
    let offsetResult = 2;  // 通道下两行是结果
    
    // 寻找数据区的起始位置
    let dataStartIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('[检测数据]')) {
            dataStartIndex = i;
            break;
        }
    }

    if (dataStartIndex !== -1) {
        // 在数据区开始后的前20行内扫描表头关键字
        // 我们寻找 "通道" 和 "Ct" 在 lines 数组中的相对距离
        let headerChannelIndex = -1;
        let headerCtIndex = -1;
        let headerResultIndex = -1;

        // 扫描范围：数据区标题后，直到遇到第一个具体数据(FAM/HEX)之前
        for (let i = dataStartIndex; i < Math.min(lines.length, dataStartIndex + 20); i++) {
            const line = lines[i];
            
            // 如果遇到了具体数据，停止表头扫描
            if (/^(FAM|HEX|ROX|CY5|Cy5)-/i.test(line)) break;

            if (line === '通道' || line.includes('通道')) headerChannelIndex = i;
            // 兼容 "Ct"、"Ct值"、"CT"
            if (/^Ct/i.test(line) || line === 'Ct值') headerCtIndex = i;
            if (line === '结果' || line.includes('结果')) headerResultIndex = i;
        }

        // 如果成功找到了表头，计算动态偏移量
        if (headerChannelIndex !== -1 && headerCtIndex !== -1) {
            offsetCt = headerCtIndex - headerChannelIndex;
            console.log(`[系统自适应] 识别到表格结构: Ct列偏移量 = ${offsetCt}`);
        }
        if (headerChannelIndex !== -1 && headerResultIndex !== -1) {
            offsetResult = headerResultIndex - headerChannelIndex;
            console.log(`[系统自适应] 识别到表格结构: 结果列偏移量 = ${offsetResult}`);
        }
    }

    // --- 4. 数据解析循环 ---
    const allTestItems = [];
    const positiveList = [];
    const channelRegex = /^(FAM|HEX|ROX|CY5|Cy5)-[\d\w]+$/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 锚点：找到荧光通道 (如 FAM-1)
        if (channelRegex.test(line)) {
            const channel = line;
            
            // 1. 获取病原体名称 (通常在通道的前一行)
            // 防御性检查：如果前一行是数字(序号)，则取前两行
            let pathogen = lines[i - 1];
            if (/^\d+$/.test(pathogen)) {
                pathogen = lines[i - 2] || '未知靶标';
            }

            // 2. 利用计算出的偏移量获取 Ct 和 结果
            // 必须进行边界检查，防止数组越界
            const ctRaw = (i + offsetCt < lines.length) ? lines[i + offsetCt] : '-';
            const result = (i + offsetResult < lines.length) ? lines[i + offsetResult] : '未知';

            // 3. 数据清洗与存储
            const isInternalControl = /内标|内参|control|ic/i.test(pathogen);
            
            allTestItems.push({
                no: allTestItems.length + 1,
                pathogen: pathogen,
                channel: channel,
                ct: ctRaw,
                result: result,
                isInternalControl: isInternalControl
            });

            // 4. 阳性判定（支持"阳性"和"+"两种格式）
            if (isPositiveResult(result) && !isInternalControl) {
                const ctValue = parseFloat(ctRaw);
                positiveList.push({
                    pathogen: pathogen,
                    ct: isNaN(ctValue) ? 999 : ctValue,
                    ctRaw: ctRaw
                });
            }
        }
    }

    // --- 5. 后续逻辑 (风险计算、食堂判定等) ---
    // ... (保持原有的食堂判定逻辑)
    let canteen = '未知';
    const rawInfo = infoMatch ? infoMatch[1].trim() : '';
    const canteenList = ['一食堂', '二食堂', '三食堂', '四食堂', '教工食堂', '混样检测'];
    for (const c of canteenList) {
        if (rawInfo.includes(c)) {
            canteen = c;
            break;
        }
    }
    if (canteen === '未知' && rawInfo) canteen = rawInfo.split(/\s+/)[0];

    const internalControlStatus = allTestItems
        .filter(item => item.isInternalControl)
        .map(item => `${item.pathogen}: ${item.result}`)
        .join(', ');

    const riskAssessment = calculatePathogenRisk(positiveList, allTestItems);

    return {
        testDate: dateMatch ? formatDateStandard(dateMatch[1]) : new Date().toISOString().split('T')[0],
        sampleId: idMatch ? idMatch[1] : `Unknown-${Date.now()}`,
        canteen: canteen,
        sampleType: projectName.includes('水') ? '水样' : '食品/环境样本',
        sampleInfo: rawInfo || '未知',
        positiveItems: riskAssessment.positiveItemsDisplay,
        positiveDetails: riskAssessment.positiveDetails,
        riskLevel: riskAssessment.riskLevel,
        riskReason: riskAssessment.riskReason,
        inspector: inspectorMatch ? inspectorMatch[1] : '(未识别)', // P2-27: 改用明确"未识别"标记，避免伪装成真实检测员
        allTestItems: allTestItems,
        internalControlStatus: internalControlStatus || '无内标数据',
        modificationLogs: [],
        traceabilityRecords: [],
        recheckReports: []
    };
}
function formatDateStandard(dateStr) {
    const date = new Date(dateStr.replace(/年|月/g, '-').replace(/日/g, ''));
    if (isNaN(date.getTime())) return dateStr;
    return date.toISOString().split('T')[0];
}

async function handleDeleteRecord(recordId) {
    // P1-06: 事件处理层纵深防御（防止函数被其他路径直接调用）
    if (!permissionService.hasPermission('records:delete')) {
      UINotification.error('权限不足：您没有删除记录的权限');
      return;
    }
    const confirmed = await UINotification.confirm(
        '确定要永久删除此记录吗？此操作不可恢复。',
        '确认删除'
    );
    
    if (!confirmed) return;

    try {
        const record = storage.getAll().find(r => String(r.id) === String(recordId));
        const success = storage.delete(recordId);
        if (success) {
            // 记录审计日志
            const sampleId = record?.sampleId || recordId;
            await auditLogService.logOperation(
                'delete',
                'pathogen',
                recordId,
                `删除病原体检测记录：样本 ${sampleId}`
            );
            UINotification.success('✅ 删除成功');
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
        } else {
            UINotification.error('❌ 删除失败，请重试');
        }
    } catch (error) {
        UINotification.error('❌ 删除出错: ' + error.message);
    }
}

function handleEditRecord(recordId, currentUser) {
    const records = storage.getAll();
    const record = records.find(r => String(r.id) === String(recordId));
    
    if (!record) {
        UINotification.error('❌ 未找到该记录');
        renderTable();
        return;
    }

    showEditModal(record, currentUser);
}

function showEditModal(record, currentUser) {
    document.getElementById('editModal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'editModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';
    
    const renderLogs = (logs) => {
        if (!logs || logs.length === 0) return '<div class="text-gray-400 text-sm italic">暂无操作日志</div>';
        return logs.map(log => `
            <div class="text-xs border-l-2 border-blue-400 pl-2 mb-2 bg-gray-50 p-1 rounded-r">
                <div class="flex justify-between text-gray-500">
                    <span>${log.time}</span>
                    <span>${log.user}</span>
                </div>
                <div class="text-gray-800 font-medium mt-1">${log.action}: ${log.content || ''}</div>
            </div>
        `).join('');
    };

    const renderTraceability = (records) => {
        if (!records || records.length === 0) return '<div class="text-gray-400 text-sm italic p-2">暂无溯源记录</div>';
        return records.map(rec => `
            <div class="border border-gray-200 rounded p-2 mb-2 bg-white text-xs">
                <div class="flex justify-between border-b pb-1 mb-1">
                    <span class="font-bold text-blue-600">${rec.time}</span>
                    <span class="text-gray-500">${rec.user}</span>
                </div>
                <div class="text-gray-700">${rec.content}</div>
            </div>
        `).join('');
    };

    const getRecheckColorClass = (riskLevel) => {
        const colorMap = {
            '高风险': 'bg-red-50 border-red-200',
            '中风险': 'bg-orange-50 border-orange-200',
            '低风险': 'bg-yellow-50 border-yellow-200',
            '极低风险': 'bg-green-50 border-green-200',
            '无风险': 'bg-green-50 border-green-200'
        };
        return colorMap[riskLevel] || 'bg-gray-50 border-gray-200';
    };
    
    const getRecheckTextClass = (riskLevel) => {
        const textMap = {
            '高风险': 'text-red-700',
            '中风险': 'text-orange-700',
            '低风险': 'text-yellow-700',
            '极低风险': 'text-green-700',
            '无风险': 'text-green-700'
        };
        return textMap[riskLevel] || 'text-gray-700';
    };

    const renderRecheckReports = (reports) => {
        if (!reports || reports.length === 0) return '<div class="text-gray-400 text-sm italic p-2">暂无复检报告</div>';
        return reports.map(rep => `
            <div class="border rounded p-3 mb-3 ${getRecheckColorClass(rep.riskLevel)}">
                <div class="flex justify-between items-center mb-2 border-b pb-2">
                    <div>
                        <span class="font-bold ${getRecheckTextClass(rep.riskLevel)} text-sm">
                            ${rep.isPassed ? '✓ 复检通过' : '⚠ ' + rep.riskLevel}
                        </span>
                        <span class="text-xs text-gray-500 ml-2">样本: ${rep.sampleId}</span>
                    </div>
                    <span class="text-xs text-gray-500">${rep.importTime}</span>
                </div>
                <div class="grid grid-cols-2 gap-2 text-xs mb-2">
                    <div><span class="text-gray-600">检测日期:</span> ${rep.testDate}</div>
                    <div><span class="text-gray-600">检测员:</span> ${rep.inspector}</div>
                    <div class="col-span-2">
                        <span class="text-gray-600">阳性项:</span> 
                        <span class="font-medium ${getRecheckTextClass(rep.riskLevel)}">${rep.positiveItems}</span>
                    </div>
                    ${rep.riskReason ? `
                        <div class="col-span-2 mt-1 p-2 bg-white rounded border">
                            <i class="fas fa-info-circle text-blue-600 mr-1"></i>
                            <span class="text-gray-700">${rep.riskReason}</span>
                        </div>
                    ` : ''}
                </div>
                <button class="mt-2 text-xs text-blue-600 hover:underline view-recheck-detail" data-recheck='${JSON.stringify(rep).replace(/'/g, "&#39;")}'>
                    <i class="fas fa-eye mr-1"></i>查看完整数据
                </button>
            </div>
        `).join('');
    };

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl w-11/12 md:w-3/4 max-h-[90vh] overflow-y-auto flex flex-col">
            <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                <h3 class="font-bold text-lg text-gray-800"><i class="fas fa-edit text-blue-600 mr-2"></i>病原体检测记录编辑</h3>
                <button id="closeEditModal" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
            </div>
            
            <div class="p-6 overflow-y-auto">
                <div class="flex border-b mb-4">
                    <button class="px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium" id="tabBtnInfo">基本信息</button>
                    <button class="px-4 py-2 text-gray-500 hover:text-blue-500" id="tabBtnTrace">溯源与复检</button>
                </div>

                <div id="tabInfo" class="block">
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">样本编号</label>
                            <input type="text" id="editSampleId" value="${record.sampleId}" class="w-full border p-2 rounded">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">食堂</label>
                            <select id="editCanteen" class="w-full border p-2 rounded">
                                <option value="一食堂" ${record.canteen === '一食堂' ? 'selected' : ''}>一食堂</option>
                                <option value="二食堂" ${record.canteen === '二食堂' ? 'selected' : ''}>二食堂</option>
                                <option value="三食堂" ${record.canteen === '三食堂' ? 'selected' : ''}>三食堂</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">样本类型</label>
                            <input type="text" id="editSampleType" value="${record.sampleType}" class="w-full border p-2 rounded">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">风险等级</label>
                            <select id="editRiskLevel" class="w-full border p-2 rounded">
                                <option value="无风险" ${record.riskLevel === '无风险' ? 'selected' : ''}>无风险</option>
                                <option value="极低风险" ${record.riskLevel === '极低风险' ? 'selected' : ''}>极低风险</option>
                                <option value="低风险" ${record.riskLevel === '低风险' ? 'selected' : ''}>低风险</option>
                                <option value="中风险" ${record.riskLevel === '中风险' ? 'selected' : ''}>中风险</option>
                                <option value="高风险" ${record.riskLevel === '高风险' ? 'selected' : ''}>高风险</option>
                            </select>
                        </div>
                    </div>
                    <div class="mb-4">
                        <label class="block text-sm font-medium text-gray-700 mb-1">样本详细信息</label>
                        <textarea id="editSampleInfo" class="w-full border p-2 rounded" rows="2">${record.sampleInfo || ''}</textarea>
                    </div>
                    <div class="flex justify-end mb-6">
                        <button id="btnSaveBasicInfo" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                            <i class="fas fa-save mr-1"></i> 保存修改
                        </button>
                    </div>
                    
                    <div class="bg-gray-50 p-4 rounded border">
                        <h4 class="text-sm font-bold text-gray-700 mb-3">操作审计日志</h4>
                        <div id="auditLogsList" class="max-h-40 overflow-y-auto">
                            ${renderLogs(record.modificationLogs)}
                        </div>
                    </div>
                </div>

                <div id="tabTrace" class="hidden">
                    <div class="mb-6 pb-6 border-b">
                        <h4 class="font-medium text-gray-800 mb-3 flex items-center">
                            <i class="fas fa-search-location text-blue-600 mr-2"></i>溯源记录
                        </h4>
                        <div class="mb-4">
                            <label class="block text-sm font-medium text-gray-700 mb-2">新增溯源记录</label>
                            <textarea id="newTraceRecord" class="w-full border p-3 rounded" rows="3" placeholder="请输入溯源信息（如：污染源分析、处置措施等）"></textarea>
                        </div>
                        <div class="flex justify-end mb-4">
                            <button id="btnSaveTrace" class="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                                <i class="fas fa-plus mr-1"></i> 添加溯源记录
                            </button>
                        </div>
                        <div class="bg-gray-50 p-4 rounded border">
                            <h5 class="text-sm font-bold text-gray-700 mb-3">历史溯源记录</h5>
                            <div id="traceHistoryList" class="max-h-40 overflow-y-auto">
                                ${renderTraceability(record.traceabilityRecords)}
                            </div>
                        </div>
                    </div>

                    <div>
                        <h4 class="font-medium text-gray-800 mb-3 flex items-center">
                            <i class="fas fa-file-medical text-red-600 mr-2"></i>复检报告管理
                        </h4>
                        <div class="bg-yellow-50 border border-yellow-200 p-3 rounded mb-4 text-sm text-yellow-800">
                            <i class="fas fa-info-circle mr-1"></i> 针对阳性结果的二次检验，导入复检报告后将自动关联并更新风险状态
                        </div>
                        <div class="flex items-center gap-3 mb-4">
                            <input type="file" id="recheckFileInput" accept=".docx" class="hidden">
                            <button id="btnSelectRecheckFile" class="bg-purple-600 text-white px-4 py-2 rounded hover:bg-purple-700 flex items-center">
                                <i class="fas fa-upload mr-2"></i> 选择复检报告
                            </button>
                            <span id="recheckFileName" class="text-sm text-gray-600"></span>
                        </div>
                        <div class="bg-gray-50 p-4 rounded border">
                            <h5 class="text-sm font-bold text-gray-700 mb-3">已导入的复检报告</h5>
                            <div id="recheckReportsList" class="max-h-60 overflow-y-auto">
                                ${renderRecheckReports(record.recheckReports)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    document.getElementById('closeEditModal').onclick = () => modal.remove();

    const tabInfo = document.getElementById('tabInfo');
    const tabTrace = document.getElementById('tabTrace');
    const btnTabInfo = document.getElementById('tabBtnInfo');
    const btnTabTrace = document.getElementById('tabBtnTrace');

    btnTabInfo.onclick = () => {
        tabInfo.classList.remove('hidden');
        tabTrace.classList.add('hidden');
        btnTabInfo.className = "px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium";
        btnTabTrace.className = "px-4 py-2 text-gray-500 hover:text-blue-500";
    };

    btnTabTrace.onclick = () => {
        tabInfo.classList.add('hidden');
        tabTrace.classList.remove('hidden');
        btnTabInfo.className = "px-4 py-2 text-gray-500 hover:text-blue-500";
        btnTabTrace.className = "px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium";
    };

    document.getElementById('btnSaveBasicInfo').onclick = async () => {
        const updates = {
            sampleId: document.getElementById('editSampleId').value,
            canteen: document.getElementById('editCanteen').value,
            sampleType: document.getElementById('editSampleType').value,
            sampleInfo: document.getElementById('editSampleInfo').value,
            riskLevel: document.getElementById('editRiskLevel').value
        };

        Object.assign(record, updates);
        
        record.modificationLogs = record.modificationLogs || [];
        record.modificationLogs.unshift({
            time: new Date().toLocaleString(),
            user: currentUser,
            action: '修改基本信息',
            content: `更新了样本信息`
        });

        if (storage.update(record.id, record)) {
            // 记录审计日志
            const sampleId = record?.sampleId || record.id;
            await auditLogService.logOperation(
                'update',
                'pathogen',
                record.id,
                `修改病原体检测记录：样本 ${sampleId}`
            );
            document.getElementById('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
            alert('保存成功');
        } else {
            alert('保存失败');
        }
    };

    document.getElementById('btnSaveTrace').onclick = () => {
        const content = document.getElementById('newTraceRecord').value.trim();
        if (!content) {
            alert('请输入溯源内容');
            return;
        }

        record.traceabilityRecords = record.traceabilityRecords || [];
        record.traceabilityRecords.unshift({
            time: new Date().toLocaleString(),
            user: currentUser,
            content: content
        });

        record.modificationLogs = record.modificationLogs || [];
        record.modificationLogs.unshift({
            time: new Date().toLocaleString(),
            user: currentUser,
            action: '添加溯源记录',
            content: content
        });

        if (storage.update(record.id, record)) {
            document.getElementById('traceHistoryList').innerHTML = renderTraceability(record.traceabilityRecords);
            document.getElementById('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
            document.getElementById('newTraceRecord').value = '';
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
            alert('溯源记录已保存');
        } else {
            alert('保存失败');
        }
    };

    const recheckFileInput = document.getElementById('recheckFileInput');
    const recheckFileName = document.getElementById('recheckFileName');
    
    document.getElementById('btnSelectRecheckFile').onclick = () => {
        recheckFileInput.click();
    };

    recheckFileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            recheckFileName.textContent = `已选择: ${file.name}`;
            
            const btn = document.getElementById('btnSelectRecheckFile');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> 处理中...';
            btn.disabled = true;
            
            handleRecheckImport(file, record, currentUser, (updatedRecord) => {
                document.getElementById('recheckReportsList').innerHTML = renderRecheckReports(updatedRecord.recheckReports);
                document.getElementById('auditLogsList').innerHTML = renderLogs(updatedRecord.modificationLogs);
                renderTable();
                document.dispatchEvent(new Event('dataChanged'));
                
                btn.innerHTML = '<i class="fas fa-upload mr-2"></i> 选择复检报告';
                btn.disabled = false;
                recheckFileName.textContent = '';
                recheckFileInput.value = '';
            });
        }
    };

    document.getElementById('recheckReportsList').addEventListener('click', (e) => {
        const btn = e.target.closest('.view-recheck-detail');
        if (btn) {
            const recheckData = JSON.parse(btn.dataset.recheck);
            showTestDetailModal(recheckData);
        }
    });
}

function showTestDetailModal(testData) {
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-60 z-[60] flex items-center justify-center';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const testItemsHtml = testData.allTestItems && testData.allTestItems.length > 0 ? `
        <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse border border-gray-300">
                <thead class="bg-gradient-to-r from-gray-100 to-gray-200">
                    <tr>
                        <th class="border border-gray-300 p-3 text-left">序号</th>
                        <th class="border border-gray-300 p-3 text-left">检测靶标</th>
                        <th class="border border-gray-300 p-3 text-center">通道</th>
                        <th class="border border-gray-300 p-3 text-center">Ct值</th>
                        <th class="border border-gray-300 p-3 text-center">结果</th>
                    </tr>
                </thead>
                <tbody>
                    ${testData.allTestItems.map(item => {
                        const isPositive = isPositiveResult(item.result);
                        const isInternalControl = item.isInternalControl;
                        
                        let rowClass = 'hover:bg-gray-50';
                        let resultBadge = item.result;
                        
                        if (isPositive && isInternalControl) {
                            rowClass = 'bg-blue-50';
                            resultBadge = `<span class="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 border border-blue-300">
                                <i class="fas fa-check-circle mr-1"></i>${item.result} (质控正常)
                            </span>`;
                        } else if (isPositive) {
                            rowClass = 'bg-red-50 font-medium';
                            resultBadge = `<span class="px-2 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-300">
                                <i class="fas fa-exclamation-triangle mr-1"></i>${item.result}
                            </span>`;
                        } else {
                            resultBadge = `<span class="text-gray-600">${item.result}</span>`;
                        }
                        
                        return `
                            <tr class="${rowClass}">
                                <td class="border border-gray-300 p-3 text-center">${item.no}</td>
                                <td class="border border-gray-300 p-3">
                                    ${item.pathogen}
                                    ${isInternalControl ? '<span class="ml-2 text-xs text-blue-600">(内标)</span>' : ''}
                                </td>
                                <td class="border border-gray-300 p-3 text-center text-xs text-gray-600">${item.channel}</td>
                                <td class="border border-gray-300 p-3 text-center ${isPositive && !isInternalControl ? 'font-bold text-red-600' : 'text-gray-500'}">${item.ct}</td>
                                <td class="border border-gray-300 p-3 text-center">
                                    ${resultBadge}
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
            
            <div class="mt-4 bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800">
                <i class="fas fa-info-circle mr-1"></i>
                <strong>说明：</strong>内标（Internal Control）用于验证检测系统是否正常工作，内标阳性表示质控正常，不代表病原体阳性。
            </div>
        </div>
    ` : '<p class="text-gray-500 text-center py-6">无详细检测数据</p>';
    
    const getRiskColor = (riskLevel) => {
        const colorMap = {
            '高风险': 'red',
            '中风险': 'orange',
            '低风险': 'yellow',
            '极低风险': 'green',
            '无风险': 'green'
        };
        return colorMap[riskLevel] || 'gray';
    };
    
    const summaryColor = getRiskColor(testData.riskLevel || (testData.isPassed ? '无风险' : '高风险'));
    const summaryBg = `bg-${summaryColor}-50 border-${summaryColor}-300`;
    const summaryIcon = testData.isPassed ? 'fa-check-circle' : 'fa-exclamation-triangle';
    
    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-2xl w-11/12 md:w-4/5 lg:w-3/4 max-h-[90vh] overflow-y-auto">
            <div class="sticky top-0 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-5 rounded-t-lg flex justify-between items-center z-10">
                <div>
                    <h3 class="text-xl font-bold">${testData.title || '检测数据详情'}</h3>
                    <p class="text-sm text-blue-100 mt-1">样本编号: ${testData.sampleId} | 检测日期: ${testData.testDate}</p>
                </div>
                <button onclick="this.closest('.fixed').remove()" class="text-white hover:text-gray-200 text-2xl">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div class="p-6">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm">
                    <div class="bg-gray-50 p-3 rounded border">
                        <span class="text-gray-600 text-xs">检测日期</span>
                        <div class="font-medium text-gray-800 mt-1">${testData.testDate}</div>
                    </div>
                    <div class="bg-gray-50 p-3 rounded border">
                        <span class="text-gray-600 text-xs">样本编号</span>
                        <div class="font-medium text-gray-800 mt-1">${testData.sampleId}</div>
                    </div>
                    <div class="bg-gray-50 p-3 rounded border">
                        <span class="text-gray-600 text-xs">检测员</span>
                        <div class="font-medium text-gray-800 mt-1">${testData.inspector}</div>
                    </div>
                    ${testData.importTime ? `
                        <div class="bg-gray-50 p-3 rounded border">
                            <span class="text-gray-600 text-xs">导入时间</span>
                            <div class="font-medium text-gray-800 mt-1 text-xs">${testData.importTime}</div>
                        </div>
                    ` : '<div></div>'}
                </div>

                <div class="border-2 ${summaryBg} rounded-lg p-4 mb-5">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center">
                            <i class="fas ${summaryIcon} text-${summaryColor}-600 text-2xl mr-3"></i>
                            <div>
                                <div class="text-sm text-gray-600">病原体检测结果</div>
                                <div class="font-bold text-lg text-${summaryColor}-700 mt-1">
                                    ${testData.riskLevel || (testData.isPassed ? '全部未检出' : '检出阳性')}
                                </div>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-xs text-gray-600">阳性病原体</div>
                            <div class="font-bold text-${summaryColor}-600 mt-1">${testData.positiveItems}</div>
                        </div>
                    </div>
                    ${testData.riskReason ? `
                        <div class="mt-3 pt-3 border-t text-sm text-gray-700">
                            <i class="fas fa-info-circle mr-1"></i>${testData.riskReason}
                        </div>
                    ` : ''}
                </div>

                <h4 class="font-bold text-gray-800 mb-3 flex items-center">
                    <i class="fas fa-table text-blue-600 mr-2"></i>
                    完整检测数据（共 ${testData.allTestItems ? testData.allTestItems.length : 0} 项）
                </h4>
                ${testItemsHtml}
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
}

function showDetailModal(recordId) {
    const records = storage.getAll();
    const record = records.find(r => String(r.id) === String(recordId));
    if (!record) return;
    
    const modal = document.createElement('div');
    modal.id = 'detailModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    const getRiskColorClass = (riskLevel) => {
        const colorMap = {
            '高风险': 'bg-red-50 border-red-200',
            '中风险': 'bg-orange-50 border-orange-200',
            '低风险': 'bg-yellow-50 border-yellow-200',
            '极低风险': 'bg-green-50 border-green-200',
            '无风险': 'bg-blue-50 border-blue-200'
        };
        return colorMap[riskLevel] || 'bg-gray-50 border-gray-200';
    };
    
    const getRiskBadgeClass = (riskLevel) => {
        const badgeMap = {
            '高风险': 'bg-red-100 text-red-800',
            '中风险': 'bg-orange-100 text-orange-800',
            '低风险': 'bg-yellow-100 text-yellow-800',
            '极低风险': 'bg-green-100 text-green-800',
            '无风险': 'bg-blue-100 text-blue-800'
        };
        return badgeMap[riskLevel] || 'bg-gray-100 text-gray-800';
    };
    
    const originalTestCard = `
        <div class="border-2 border-blue-300 rounded-lg p-4 bg-blue-50 mb-3">
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center">
                    <span class="bg-blue-600 text-white px-3 py-1 rounded-full text-xs font-bold mr-3">初检</span>
                    <span class="text-sm font-medium text-gray-700">第一次检测（原始数据）</span>
                </div>
                <button class="view-test-detail bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 text-sm flex items-center" 
                        data-test='${JSON.stringify({
                            title: '初检数据',
                            testDate: record.testDate,
                            sampleId: record.sampleId,
                            inspector: record.inspector,
                            positiveItems: record.positiveItems,
                            allTestItems: record.allTestItems,
                            riskLevel: record.riskLevel,
                            riskReason: record.riskReason,
                            isPassed: record.riskLevel === '无风险'
                        }).replace(/'/g, "&#39;")}'>
                    <i class="fas fa-eye mr-1"></i> 查看完整数据
                </button>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div class="bg-white p-2 rounded">
                    <span class="text-gray-500">检测日期</span>
                    <div class="font-medium text-gray-800 mt-1">${record.testDate}</div>
                </div>
                <div class="bg-white p-2 rounded">
                    <span class="text-gray-500">样本编号</span>
                    <div class="font-medium text-gray-800 mt-1">${record.sampleId}</div>
                </div>
                <div class="bg-white p-2 rounded">
                    <span class="text-gray-500">检测员</span>
                    <div class="font-medium text-gray-800 mt-1">${record.inspector}</div>
                </div>
                <div class="bg-white p-2 rounded">
                    <span class="text-gray-500">阳性项</span>
                    <div class="font-bold ${record.positiveItems !== '无' ? 'text-red-600' : 'text-green-600'} mt-1">
                        ${record.positiveItems}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    let recheckCards = '';
    if (record.recheckReports && record.recheckReports.length > 0) {
        recheckCards = record.recheckReports.map((rep, idx) => {
            const recheckNum = record.recheckReports.length - idx;
            const borderColor = rep.isPassed ? 'border-green-300' : 'border-red-300';
            const badgeColor = rep.isPassed ? 'bg-green-600' : 'bg-red-600';
            const textColor = rep.isPassed ? 'text-green-600' : 'text-red-600';
            
            return `
                <div class="border-2 ${borderColor} rounded-lg p-4 ${getRiskColorClass(rep.riskLevel)} mb-3">
                    <div class="flex justify-between items-center mb-3">
                        <div class="flex items-center">
                            <span class="${badgeColor} text-white px-3 py-1 rounded-full text-xs font-bold mr-3">
                                复检 ${recheckNum}
                            </span>
                            <span class="text-sm font-medium ${textColor}">
                                ${rep.isPassed ? '✓ 复检通过' : '⚠ ' + rep.riskLevel}
                            </span>
                            <span class="text-xs text-gray-500 ml-3">导入时间: ${rep.importTime}</span>
                        </div>
                        <button class="view-test-detail ${rep.isPassed ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'} text-white px-4 py-1.5 rounded text-sm flex items-center" 
                                data-test='${JSON.stringify({
                                    title: `复检 ${recheckNum} 数据`,
                                    testDate: rep.testDate,
                                    sampleId: rep.sampleId,
                                    inspector: rep.inspector,
                                    positiveItems: rep.positiveItems,
                                    allTestItems: rep.allTestItems,
                                    riskLevel: rep.riskLevel,
                                    riskReason: rep.riskReason,
                                    isPassed: rep.isPassed,
                                    importTime: rep.importTime,
                                    importUser: rep.importUser
                                }).replace(/'/g, "&#39;")}'>
                            <i class="fas fa-eye mr-1"></i> 查看完整数据
                        </button>
                    </div>
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div class="bg-white p-2 rounded">
                            <span class="text-gray-500">检测日期</span>
                            <div class="font-medium text-gray-800 mt-1">${rep.testDate}</div>
                        </div>
                        <div class="bg-white p-2 rounded">
                            <span class="text-gray-500">样本编号</span>
                            <div class="font-medium text-gray-800 mt-1">${rep.sampleId}</div>
                        </div>
                        <div class="bg-white p-2 rounded">
                            <span class="text-gray-500">检测员</span>
                            <div class="font-medium text-gray-800 mt-1">${rep.inspector}</div>
                        </div>
                        <div class="bg-white p-2 rounded">
                            <span class="text-gray-500">阳性项</span>
                            <div class="font-bold ${rep.isPassed ? 'text-green-600' : 'text-red-600'} mt-1">
                                ${rep.positiveItems}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    const traceHtml = record.traceabilityRecords && record.traceabilityRecords.length > 0 ? `
        <div class="mt-6 border-t pt-4">
            <h4 class="font-bold text-gray-800 mb-3"><i class="fas fa-search-location text-blue-600 mr-2"></i>溯源记录</h4>
            <div class="space-y-2">
                ${record.traceabilityRecords.map(rec => `
                    <div class="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
                        <div class="flex justify-between mb-1 text-xs text-gray-600">
                            <span>${rec.time}</span>
                            <span>${rec.user}</span>
                        </div>
                        <div class="text-gray-800">${rec.content}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    ` : '';

    const statusHtml = record.finalStatus ? `
        <div class="mb-4 p-3 rounded ${record.finalStatus === '复检通过' ? 'bg-green-100 border border-green-300' : 'bg-yellow-100 border border-yellow-300'}">
            <div class="flex items-center">
                <i class="fas fa-flag-checkered mr-2 ${record.finalStatus === '复检通过' ? 'text-green-600' : 'text-yellow-600'}"></i>
                <span class="font-bold text-sm">最终状态: ${record.finalStatus}</span>
            </div>
        </div>
    ` : '';

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl w-11/12 md:w-3/4 lg:w-2/3 max-h-[90vh] overflow-y-auto p-6">
            <div class="flex justify-between items-center border-b pb-3 mb-5">
                <h3 class="text-xl font-bold text-gray-800">
                    <i class="fas fa-file-medical-alt text-blue-600 mr-2"></i>
                    病原体检测详情档案 #${record.id}
                </h3>
                <button onclick="document.getElementById('detailModal').remove()" class="text-gray-500 hover:text-gray-700">
                    <i class="fas fa-times text-xl"></i>
                </button>
            </div>
            
            ${statusHtml}
            
            <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-sm bg-gradient-to-r from-gray-50 to-gray-100 p-4 rounded-lg border">
                <div>
                    <span class="text-gray-600 text-xs">食堂</span>
                    <div class="font-medium text-gray-800 mt-1">${record.canteen}</div>
                </div>
                <div>
                    <span class="text-gray-600 text-xs">样本类型</span>
                    <div class="font-medium text-gray-800 mt-1">${record.sampleType}</div>
                </div>
                <div>
                    <span class="text-gray-600 text-xs">风险等级</span>
                    <div class="mt-1">
                        <span class="px-2 py-1 rounded-full text-xs font-bold ${getRiskBadgeClass(record.riskLevel)}">
                            ${record.riskLevel}
                        </span>
                    </div>
                </div>
                <div>
                    <span class="text-gray-600 text-xs">检测次数</span>
                    <div class="font-medium text-gray-800 mt-1">
                        ${1 + (record.recheckReports ? record.recheckReports.length : 0)} 次
                    </div>
                </div>
            </div>

            ${record.riskReason ? `
                <div class="mb-4 p-3 rounded border ${getRiskColorClass(record.riskLevel)}">
                    <div class="flex items-center text-sm">
                        <i class="fas fa-info-circle mr-2"></i>
                        <span class="font-medium">风险判定依据：</span>
                        <span class="ml-2">${record.riskReason}</span>
                    </div>
                </div>
            ` : ''}

            <div class="mb-4">
                <h4 class="font-bold text-gray-700 mb-2 flex items-center">
                    <i class="fas fa-info-circle text-gray-600 mr-2"></i>样本信息
                </h4>
                <p class="text-sm text-gray-700 bg-gray-50 p-3 rounded border">${record.sampleInfo || '无'}</p>
            </div>

            <div class="mb-4">
                <h4 class="font-bold text-gray-700 mb-3 flex items-center">
                    <i class="fas fa-vials text-purple-600 mr-2"></i>检测数据记录
                    <span class="ml-2 text-xs text-gray-500 font-normal">（点击"查看完整数据"按钮查看详细的 25 项检测结果）</span>
                </h4>
                
                ${originalTestCard}
                
                ${recheckCards ? `
                    <div class="mt-4">
                        <h5 class="text-sm font-bold text-gray-600 mb-2 flex items-center">
                            <i class="fas fa-redo text-gray-500 mr-2"></i>复检记录
                        </h5>
                        ${recheckCards}
                    </div>
                ` : ''}
            </div>

            ${traceHtml}
        </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.querySelectorAll('.view-test-detail').forEach(btn => {
        btn.addEventListener('click', () => {
            const testData = JSON.parse(btn.dataset.test);
            showTestDetailModal(testData);
        });
    });
}

// ✅ 修改：renderTable 函数增加食堂筛选逻辑
function renderTable() {
    const allRecords = storage.getAll();
    const tbody = document.getElementById('pathogenRecords');
    if (!tbody) return;

    // 1. 插入表头和分页控件（如果不存在）
    const tableContainer = tbody.closest('table');
    if (tableContainer) {
        if (!document.getElementById('pathogen-header-controls')) {
            const headerControls = document.createElement('div');
            headerControls.id = 'pathogen-header-controls';
            headerControls.className = 'flex flex-col md:flex-row justify-between items-start md:items-center mt-4 mb-3';
            // ✅ 修改：增加食堂筛选
            headerControls.innerHTML = `
                <h3 class="font-medium text-gray-800 flex items-center mb-2 md:mb-0">
                    <i class="fas fa-list text-blue-600 mr-2"></i>检测记录列表
                </h3>
                <div class="flex flex-wrap items-center gap-2">
                    <!-- ✅ 新增：食堂筛选 -->
                    <div class="flex items-center">
                        <label class="text-sm text-gray-600 mr-2">食堂:</label>
                        <select id="pathogen-canteenFilterSelect" class="border border-gray-300 rounded px-3 py-1 text-sm">
                            <option value="all">全部</option>
                            <option value="一食堂">一食堂</option>
                            <option value="二食堂">二食堂</option>
                            <option value="三食堂">三食堂</option>
                            <option value="混样检测">混样检测</option>
                        </select>
                    </div>
                    <div class="flex items-center">
                        <label class="text-sm text-gray-600 mr-2">每页:</label>
                        <select id="pathogen-recordsPerPageSelect" class="border border-gray-300 rounded px-2 py-1 text-sm">
                            <option value="5">5</option>
                            <option value="10" selected>10</option>
                            <option value="20">20</option>
                            <option value="50">50</option>
                        </select>
                    </div>
                    <button id="pathogen-sortOrderBtn" class="flex items-center bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1 rounded text-sm">
                        <i class="fas fa-sort-amount-down mr-1"></i><span id="pathogen-sortOrderText">最新</span>
                    </button>
                </div>
            `;
            tableContainer.parentNode.insertBefore(headerControls, tableContainer);
        }

        if (!document.getElementById('pathogen-paginationContainer')) {
            const paginationContainer = document.createElement('div');
            paginationContainer.id = 'pathogen-paginationContainer';
            paginationContainer.className = 'flex flex-wrap justify-between items-center mt-4 mb-8';
            paginationContainer.innerHTML = `
                <div class="flex items-center text-sm text-gray-600"><span id="pathogen-paginationInfo">...</span></div>
                <div class="flex items-center space-x-1">
                    <button id="pathogen-prevPageBtn" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200"><i class="fas fa-chevron-left"></i></button>
                    <div id="pathogen-pageButtonsContainer" class="flex items-center space-x-1"></div>
                    <button id="pathogen-nextPageBtn" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200"><i class="fas fa-chevron-right"></i></button>
                </div>
                <form id="pathogen-pageJumpForm" class="flex items-center ml-2">
                    <input type="number" id="pathogen-pageJumpInput" min="1" class="border border-gray-300 rounded w-16 px-2 py-1 text-sm" placeholder="页">
                    <button type="submit" class="ml-1 px-2 py-1 bg-blue-500 text-white rounded text-sm hover:bg-blue-600"><i class="fas fa-arrow-right"></i></button>
                </form>
            `;
            tableContainer.parentNode.insertBefore(paginationContainer, tableContainer.nextSibling);
            
            // 重新绑定事件监听器，因为新元素刚被创建
            setupPaginationListeners();
        }
    }

    // ✅ 新增：食堂筛选逻辑
    let filteredRecords = allRecords;
    if (selectedCanteenFilter !== 'all') {
        filteredRecords = allRecords.filter(record => record.canteen === selectedCanteenFilter);
    }

    // 2. 排序逻辑
    const sortedRecords = [...filteredRecords].sort((a, b) => {
        const dateA = new Date(a.testDate || '1970-01-01');
        const dateB = new Date(b.testDate || '1970-01-01');
        return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });

    // 3. 分页计算
    const totalRecords = sortedRecords.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / recordsPerPage));
    currentPage = Math.max(1, Math.min(currentPage, totalPages));
    
    const startIndex = (currentPage - 1) * recordsPerPage;
    const currentRecords = sortedRecords.slice(startIndex, startIndex + recordsPerPage);

    updatePagination(startIndex, Math.min(startIndex + recordsPerPage, totalRecords), totalRecords, totalPages);

    // 4. 渲染表格内容
    if (currentRecords.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-gray-500">暂无数据，请导入检测报告</td></tr>`;
        return;
    }

    tbody.innerHTML = currentRecords.map(item => {
        const riskAssessment = calculatePathogenRisk(item.positiveDetails || [], item.allTestItems || []);
        const displayPositiveItems = riskAssessment.positiveItemsDisplay;
        const displayRiskLevel = riskAssessment.riskLevel || item.riskLevel;
        const displayRiskReason = riskAssessment.riskReason || item.riskReason;

        let riskClass = 'bg-gray-100 text-gray-800';
        if (displayRiskLevel === '高风险') {
            riskClass = 'bg-red-100 text-red-800';
        } else if (displayRiskLevel === '中风险') {
            riskClass = 'bg-orange-100 text-orange-800';
        } else if (displayRiskLevel === '低风险') {
            riskClass = 'bg-yellow-100 text-yellow-800';
        } else if (displayRiskLevel === '极低风险') {
            riskClass = 'bg-green-100 text-green-800';
        } else if (displayRiskLevel === '无风险') {
            riskClass = 'bg-blue-100 text-blue-800';
        }
        
        const positiveClass = displayPositiveItems !== '无' ? 'text-red-600 font-bold' : 'text-gray-600';
        
        let statusBadge = '';
        if (item.finalStatus) {
            const statusColor = item.finalStatus === '复检通过' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-yellow-100 text-yellow-700 border-yellow-200';
            statusBadge = `<span class="px-2 py-1 rounded-full text-xs font-medium border ${statusColor} ml-2">${item.finalStatus}</span>`;
        }

        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="px-4 py-3 text-center">${item.testDate}</td>
                <td class="px-4 py-3 font-medium">${item.sampleId}</td>
                <td class="px-4 py-3 text-center">${item.canteen}</td>
                <td class="px-4 py-3 text-center">${item.sampleType}</td>
                <td class="px-4 py-3 ${positiveClass} cursor-pointer hover:underline result-value" data-id="${item.id}" title="点击查看详情">
                    ${displayPositiveItems}${statusBadge}
                </td>
                <td class="px-4 py-3 text-center">
                    <span class="px-2 py-1 rounded-full text-xs font-medium ${riskClass}" title="${displayRiskReason || ''}">
                        ${displayRiskLevel}
                    </span>
                </td>
                <td class="px-4 py-3 text-center">${item.inspector}</td>
                <td class="px-4 py-3 text-center">
                    <div class="flex gap-2 justify-center">
                        <button class="px-3 py-1.5 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 btn-edit" data-id="${item.id}">
                            <i class="fas fa-edit text-xs"></i>
                        </button>
                        <button class="px-3 py-1.5 bg-red-50 text-red-700 rounded hover:bg-red-100 btn-delete" data-id="${item.id}">
                            <i class="fas fa-trash text-xs"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ✅ 修改：setupPaginationListeners 函数增加食堂筛选事件
function setupPaginationListeners() {
    const paginationContainer = document.getElementById('pathogen-paginationContainer');
    const perPageSelect = document.getElementById('pathogen-recordsPerPageSelect');
    const sortBtn = document.getElementById('pathogen-sortOrderBtn');
    const jumpForm = document.getElementById('pathogen-pageJumpForm');
    const canteenFilterSelect = document.getElementById('pathogen-canteenFilterSelect'); // ✅ 新增

    // 防止重复绑定
    if (paginationContainer && paginationContainer.dataset.listenersAttached === 'true') {
        return;
    }

    if (paginationContainer) {
        paginationContainer.addEventListener('click', (e) => {
            const pageBtn = e.target.closest('.page-btn');
            if (pageBtn) {
                currentPage = parseInt(pageBtn.dataset.page);
                renderTable();
            }
            if (e.target.closest('#pathogen-prevPageBtn') && currentPage > 1) {
                currentPage--;
                renderTable();
            }
            if (e.target.closest('#pathogen-nextPageBtn')) {
                const records = storage.getAll();
                // ✅ 修改：考虑筛选后的总页数
                const filteredRecords = selectedCanteenFilter === 'all' ? records : records.filter(r => r.canteen === selectedCanteenFilter);
                const totalPages = Math.ceil(filteredRecords.length / recordsPerPage);
                if (currentPage < totalPages) {
                    currentPage++;
                    renderTable();
                }
            }
        });
        paginationContainer.dataset.listenersAttached = 'true';
    }
    
    // ✅ 新增：绑定食堂筛选事件
    if (canteenFilterSelect && !canteenFilterSelect.dataset.listenerAttached) {
        canteenFilterSelect.addEventListener('change', (e) => {
            selectedCanteenFilter = e.target.value;
            currentPage = 1; // 重置到第一页
            renderTable();
        });
        canteenFilterSelect.dataset.listenerAttached = 'true';
    }
    
    if (perPageSelect && !perPageSelect.dataset.listenerAttached) {
        perPageSelect.addEventListener('change', (e) => {
            recordsPerPage = parseInt(e.target.value);
            currentPage = 1;
            renderTable();
        });
        perPageSelect.dataset.listenerAttached = 'true';
    }
    
    if (sortBtn && !sortBtn.dataset.listenerAttached) {
        sortBtn.addEventListener('click', function() {
            sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
            
            const sortText = document.getElementById('pathogen-sortOrderText');
            const sortIcon = this.querySelector('i');
            
            if (sortText) sortText.textContent = sortOrder === 'desc' ? '最新' : '最早';
            if (sortIcon) sortIcon.className = sortOrder === 'desc' ? 'fas fa-sort-amount-down mr-1' : 'fas fa-sort-amount-up mr-1';
            
            renderTable();
        });
        sortBtn.dataset.listenerAttached = 'true';
    }
    
    if (jumpForm && !jumpForm.dataset.listenerAttached) {
        jumpForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('pathogen-pageJumpInput');
            if (input) {
                const pageNum = parseInt(input.value);
                const records = storage.getAll();
                // ✅ 修改：考虑筛选后的总页数
                const filteredRecords = selectedCanteenFilter === 'all' ? records : records.filter(r => r.canteen === selectedCanteenFilter);
                const totalPages = Math.ceil(filteredRecords.length / recordsPerPage);
                if (pageNum >= 1 && pageNum <= totalPages) {
                    currentPage = pageNum;
                    renderTable();
                }
            }
        });
        jumpForm.dataset.listenerAttached = 'true';
    }
}

function updatePagination(start, end, total, pages) {
    const info = document.getElementById('pathogen-paginationInfo');
    if(info) info.textContent = total > 0 ? `显示 ${start+1}-${end} 条，共 ${total} 条` : '暂无记录';
    
    const container = document.getElementById('pathogen-pageButtonsContainer');
    if(container) {
        let html = '';
        let startPage = Math.max(1, currentPage - 2);
        let endPage = Math.min(pages, startPage + 4);
        if (endPage - startPage < 4 && pages > 4) startPage = Math.max(1, endPage - 4);
        
        for (let i = startPage; i <= endPage; i++) {
            html += `<button class="page-btn px-3 py-1 ${i===currentPage?'bg-blue-500 text-white':'bg-gray-100 hover:bg-gray-200'} rounded" data-page="${i}">${i}</button>`;
        }
        container.innerHTML = html;
    }
}

// P2-10 阶段B：initPathogen 已通过 export 导出并由 main.js import 使用，不再挂 window
