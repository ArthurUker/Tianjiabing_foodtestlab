import { StorageService } from '../core/Storage.js';
import { auth } from '../core/Auth.js';
import { FormValidator } from '../utils/FormValidator.js';
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { GuestAuthService } from '../services/GuestAuthService.js';

const storage = new StorageService('tableware');
let currentPage = 1;
let recordsPerPage = 10;
let sortOrder = 'desc'; 
let selectedCanteenFilter = 'all'; // ✅ 新增：食堂筛选状态

export function initTableware() {
    // ✨ 检查是否处于快速访问模式 - 优先检查 URL 参数
    const urlParams = new URLSearchParams(window.location.search);
    let isQuickAccess = urlParams.get('quickAccess') === 'true';
    
    // 如果 URL 中没有找到，则检查 GuestAuthService
    if (!isQuickAccess) {
        const guestAuthService = new GuestAuthService();
        isQuickAccess = guestAuthService.isQuickAccessMode();
    }
    
    console.log('📍 Tableware 初始化 - 快速访问模式:', isQuickAccess, 'URL参数:', urlParams.get('quickAccess'));
    
    const form = document.getElementById('tablewareTestForm');
    console.log('🎯 查找 tablewareTestForm:', form ? 'found' : 'NOT FOUND');
    
    // 🎯 修改：即使form为null,也要执行快速访问模式的初始化逻辑
    if (form) {
        form.removeAttribute('onsubmit');
        
        // 在快速访问模式下，隐藏整个表单区域，只显示数据表格
        if (isQuickAccess) {
            // 隐藏表单
            form.style.display = 'none';
            form.classList.add('hidden-in-quick-access');
            
            console.log('✅ 快速访问模式：表单已隐藏，仅显示数据表格');
            
            // ✅ 访客模式同样需要创建筛选控件和分页容器
            updateFormStructure();
            
            window.renderTablewareData = () => {
                renderTable();
            };
        } else {
            form.addEventListener('submit', handleFormSubmit);
            updateFormStructure();
            document.getElementById('btnAddAtpPoint')?.addEventListener('click', addAtpPoint);
        }
    }
    
    // 事件委托
    document.getElementById('tablewareRecords')?.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.btn-delete');
        if (deleteBtn) {
            auth.verify('删除检测记录', (user) => {
                handleDeleteRecord(deleteBtn.dataset.id);
            });
        }
        
        const editBtn = e.target.closest('.btn-edit');
        if (editBtn) {
            auth.verify('编辑/整改记录', (user) => {
                handleEditRecord(editBtn.dataset.id, user);
            });
        }
        
        const resultSpan = e.target.closest('.result-value');
        if (resultSpan) {
            showTablewareDetail(resultSpan.dataset.id);
        }
    });

    document.getElementById('atpPointsContainer')?.addEventListener('click', (e) => {
        if (e.target.closest('.btn-remove-point')) {
            e.target.closest('.atp-point').remove();
        }
    });

    setupPaginationListeners();
    
    if (isQuickAccess) {
        renderTable();
    } else {
        renderTable();
    }
    
    // 监听数据变化事件（快速访问模式 + 普通模式均需要）
    document.addEventListener('dataChanged', (e) => {
        if (!e.detail || e.detail.table === 'tableware') {
            setTimeout(renderTable, 100);
        }
    });

    // 数据从 Supabase 同步完成后重新渲染表格
    storage.on('sync', () => renderTable());
}

// --- 核心业务逻辑：编辑与整改 ---

function handleEditRecord(recordId, currentUser) {
    const records = storage.getAll();
    const record = records.find(r => r.id === parseInt(recordId));
    
    if (!record) {
        UINotification.error('❌ 未找到该记录，可能已被删除');
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
    
    // 辅助函数：生成日志列表HTML
    const renderLogs = (logs) => {
        if (!logs || logs.length === 0) return '<div class="text-gray-400 text-sm italic">暂无整改日志</div>';
        return logs.map(log => `
            <div class="text-xs border-l-2 border-blue-400 pl-2 mb-2 bg-gray-50 p-1 rounded-r">
                <div class="flex justify-between text-gray-500">
                    <span>${log.time}</span>
                    <span>${log.user}</span>
                </div>
                <div class="text-gray-800 font-medium mt-1">${log.action}: ${log.content || '内容已隐藏'}</div>
            </div>
        `).join('');
    };

    // 辅助函数：生成复检历史HTML
    const renderRecheckHistory = (rechecks) => {
        if (!rechecks || rechecks.length === 0) return '<div class="text-gray-400 text-sm italic p-2">暂无复检记录</div>';
        return rechecks.map(rec => `
            <div class="border border-gray-200 rounded p-2 mb-2 bg-white text-xs">
                <div class="flex justify-between border-b pb-1 mb-1">
                    <span class="font-bold ${rec.isPassed ? 'text-green-600' : 'text-red-600'}">
                        ${rec.isPassed ? '复检合格' : '复检不合格'}
                    </span>
                    <span class="text-gray-500">${rec.time}</span>
                </div>
                <div>
                    ${rec.points.map(p => `<span class="mr-2">${p.loc}:${p.rlu}</span>`).join('')}
                </div>
            </div>
        `).join('');
    };

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl w-11/12 md:w-3/4 max-h-[90vh] overflow-y-auto flex flex-col">
            <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                <h3 class="font-bold text-lg text-gray-800"><i class="fas fa-edit text-blue-600 mr-2"></i>整改与复检管理</h3>
                <button id="closeEditModal" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
            </div>
            
            <div class="p-6 overflow-y-auto">
                <!-- 选项卡 -->
                <div class="flex border-b mb-4">
                    <button class="px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium" id="tabBtnCorrective">整改措施记录</button>
                    <button class="px-4 py-2 text-gray-500 hover:text-blue-500" id="tabBtnRecheck">复检录入</button>
                </div>

                <!-- Tab 1: 整改措施 -->
                <div id="tabCorrective" class="block">
                    <div class="mb-4">
                        <label class="block text-sm font-medium text-gray-700 mb-2">新增/更新整改措施</label>
                        <textarea id="newCorrectiveAction" class="w-full border border-gray-300 rounded p-3 focus:ring-2 focus:ring-blue-500" rows="3" placeholder="请输入针对不合格项的整改措施...">${record.correctiveAction || ''}</textarea>
                    </div>
                    <div class="flex justify-end mb-6">
                        <button id="btnSaveLog" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 shadow-sm flex items-center">
                            <i class="fas fa-save mr-1"></i> 更新并记录日志
                        </button>
                    </div>
                    
                    <div class="bg-gray-50 p-4 rounded border border-gray-200">
                        <h4 class="text-sm font-bold text-gray-700 mb-3">历史操作日志 (Audit Trail)</h4>
                        <div id="auditLogsList" class="max-h-40 overflow-y-auto">
                            ${renderLogs(record.modificationLogs)}
                        </div>
                    </div>
                </div>

                <!-- Tab 2: 复检录入 -->
                <div id="tabRecheck" class="hidden">
                    <div class="flex flex-col md:flex-row gap-4">
                        <!-- 左侧：录入区 -->
                        <div class="flex-1">
                            <div class="bg-yellow-50 border border-yellow-200 p-3 rounded mb-4 text-sm text-yellow-800">
                                <i class="fas fa-info-circle mr-1"></i> 新录入的复检数据
                            </div>
                            <div id="recheckPointsContainer" class="space-y-3 mb-4">
                                <!-- 动态生成复检点位输入框 -->
                            </div>
                            <div class="flex justify-between items-center mt-4">
                                <button id="btnAddRecheckPoint" class="text-blue-600 text-sm hover:underline"><i class="fas fa-plus"></i> 增加点位</button>
                                <button id="btnSaveRecheck" class="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 shadow-sm">
                                    <i class="fas fa-check-circle mr-1"></i> 提交复检结果
                                </button>
                            </div>
                        </div>
                        
                        <!-- 右侧：历史区 -->
                        <div class="w-full md:w-1/3 border-l pl-4">
                            <h4 class="text-sm font-bold text-gray-700 mb-3">已录入的复检记录</h4>
                            <div id="recheckHistoryList" class="max-h-60 overflow-y-auto bg-gray-50 rounded p-2">
                                ${renderRecheckHistory(record.recheckRecords)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 绑定关闭事件
    document.getElementById('closeEditModal').onclick = () => modal.remove();

    // Tab切换逻辑
    const tabCorrective = document.getElementById('tabCorrective');
    const tabRecheck = document.getElementById('tabRecheck');
    const btnTabCorrective = document.getElementById('tabBtnCorrective');
    const btnTabRecheck = document.getElementById('tabBtnRecheck');

    btnTabCorrective.onclick = () => {
        tabCorrective.classList.remove('hidden');
        tabRecheck.classList.add('hidden');
        btnTabCorrective.className = "px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium";
        btnTabRecheck.className = "px-4 py-2 text-gray-500 hover:text-blue-500";
    };

    btnTabRecheck.onclick = () => {
        tabCorrective.classList.add('hidden');
        tabRecheck.classList.remove('hidden');
        btnTabCorrective.className = "px-4 py-2 text-gray-500 hover:text-blue-500";
        btnTabRecheck.className = "px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium";
        
        const container = document.getElementById('recheckPointsContainer');
        if (container.children.length === 0 && record.atpPoints) {
            record.atpPoints.forEach(p => {
                const div = document.createElement('div');
                div.className = 'border p-3 rounded bg-white shadow-sm recheck-point';
                div.innerHTML = getSimplePointTemplate(p.loc);
                container.appendChild(div);
                bindRluCalc(div);
            });
        }
    };

    // 保存整改日志
    document.getElementById('btnSaveLog').onclick = () => {
        const content = document.getElementById('newCorrectiveAction').value.trim();
        if (!content) {
            alert('请输入整改内容');
            return;
        }
        
        const newLog = {
            time: new Date().toLocaleString(),
            user: currentUser,
            action: '更新整改措施',
            content: content
        };
        
        record.modificationLogs = record.modificationLogs || [];
        record.modificationLogs.unshift(newLog);
        record.correctiveAction = content; 

        const success = storage.update(record.id, record);
        
        if (success) {
            document.getElementById('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
            renderTable(); 
            document.dispatchEvent(new Event('dataChanged')); 
            alert('日志已保存');
        } else {
            alert('保存失败，请检查存储空间');
        }
    };

    // 增加复检点位
    document.getElementById('btnAddRecheckPoint').onclick = () => {
        const div = document.createElement('div');
        div.className = 'border p-3 rounded bg-white shadow-sm recheck-point';
        div.innerHTML = getSimplePointTemplate('');
        document.getElementById('recheckPointsContainer').appendChild(div);
        bindRluCalc(div);
    };

    // 保存复检逻辑
    document.getElementById('btnSaveRecheck').onclick = () => {
        const pointEls = document.querySelectorAll('.recheck-point');
        const points = [];
        let allPassed = true;

        pointEls.forEach(el => {
            const loc = el.querySelector('[name="loc"]').value;
            const rlu = el.querySelector('[name="rlu"]').value;
            const res = el.querySelector('[name="res"]').value;
            
            if(loc && rlu) {
                points.push({ loc, rlu, res });
                if (!res.includes('合格')) allPassed = false;
            }
        });

        if (points.length === 0) {
            alert('请至少录入一个有效的复检点位');
            return;
        }

        const recheckRecord = {
            id: Date.now(),
            time: new Date().toLocaleString(),
            user: currentUser,
            points: points,
            isPassed: allPassed
        };

        record.recheckRecords = record.recheckRecords || [];
        record.recheckRecords.unshift(recheckRecord);
        
        let logContent = '';
        if (allPassed) {
            record.finalStatus = '整改后复检合格';
            logContent = '复检全部合格，状态更新为[整改后复检合格]';
        } else {
            record.finalStatus = '复检不合格';
            logContent = '复检未通过，仍存在不合格项，状态更新为[复检不合格]';
        }

        record.modificationLogs = record.modificationLogs || [];
        record.modificationLogs.unshift({
            time: new Date().toLocaleString(),
            user: currentUser,
            action: '复检录入',
            content: logContent
        });

        const success = storage.update(record.id, record);

        if (success) {
            document.getElementById('recheckHistoryList').innerHTML = renderRecheckHistory(record.recheckRecords);
            document.getElementById('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
            renderTable();
            document.dispatchEvent(new Event('dataChanged'));
            alert('复检记录已保存');
        } else {
            alert('保存失败');
        }
    };
}

// 简化的点位模板（用于复检弹窗）
function getSimplePointTemplate(defaultLoc) {
    return `
        <div class="grid grid-cols-3 gap-2">
            <input type="text" name="loc" value="${defaultLoc}" placeholder="点位名称" class="border p-2 rounded text-sm w-full">
            <input type="number" name="rlu" placeholder="RLU值" class="border p-2 rounded text-sm w-full">
            <input type="text" name="res" readonly placeholder="结果" class="border p-2 rounded text-sm bg-gray-100 w-full">
        </div>
    `;
}

// 修复：bindRluCalc 中的逻辑顺序
function bindRluCalc(container) {
    const input = container.querySelector('[name="rlu"]');
    const output = container.querySelector('[name="res"]');
    input.addEventListener('input', () => {
        const val = parseInt(input.value) || 0;
        output.value = determineResult(val);
        // 优先判断不合格
        if(output.value.includes('不合格')) output.className = "border p-2 rounded text-sm bg-red-100 text-red-800 w-full";
        else if(output.value.includes('警戒')) output.className = "border p-2 rounded text-sm bg-yellow-100 text-yellow-800 w-full";
        else output.className = "border p-2 rounded text-sm bg-green-100 text-green-800 w-full";
    });
}

// --- 基础功能函数 ---

function determineResult(rluValue) {
    if (isNaN(rluValue)) return '';
    if (rluValue < 200) return '合格 (<200)';
    if (rluValue <= 500) return '警戒 (200-500)';
    return '不合格 (>500)';
}

// 修复：调整判断顺序，先判断"不合格"
function getResultIcon(result) {
    if (!result) return '';
    if (result.includes('不合格')) return 'fas fa-times-circle'; // 红色叉号
    if (result.includes('警戒')) return 'fas fa-exclamation-circle';
    if (result.includes('合格')) return 'fas fa-check-circle';
    return '';
}

// 修复：调整判断顺序，先判断"不合格"
function updateResultFieldStyle(resultField) {
    const value = resultField.value;
    resultField.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500';
    if (value.includes('不合格')) resultField.classList.add('bg-red-50', 'text-red-800');
    else if (value.includes('警戒')) resultField.classList.add('bg-yellow-50', 'text-yellow-800');
    else if (value.includes('合格')) resultField.classList.add('bg-green-50', 'text-green-800');
}

function updateFormStructure() {
    const form = document.getElementById('tablewareTestForm');
    if (!form) return;
    
    form.className = 'space-y-6 mb-8';
    
    // 头部说明
    const formHeader = document.createElement('div');
    formHeader.className = 'bg-blue-50 border-l-4 border-blue-500 p-4 mb-4 rounded';
    formHeader.innerHTML = `
        <div class="flex items-center">
            <i class="fas fa-info-circle text-blue-500 mr-2"></i>
            <p class="text-sm text-blue-700">
                请填写餐具洁净度检测信息。带<span class="text-red-500">*</span>为必填项。
            </p>
        </div>
    `;
    form.insertBefore(formHeader, form.firstChild);
    
    // 顶部字段
    const topFieldsContainer = form.querySelector('.grid.grid-cols-3');
    if (topFieldsContainer) {
        topFieldsContainer.className = 'grid grid-cols-1 md:grid-cols-3 gap-6 p-5 bg-gray-50 rounded-lg border border-gray-200';
        topFieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">检测日期 <span class="text-red-500">*</span></label>
                <input type="date" name="testDate" required class="w-full border border-gray-300 p-2 rounded-md shadow-sm">
            </div>
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">食堂编号 <span class="text-red-500">*</span></label>
                <select name="canteen" class="w-full border border-gray-300 p-2 rounded-md shadow-sm" required>
                    <option value="一食堂">一食堂</option>
                    <option value="二食堂">二食堂</option>
                    <option value="三食堂">三食堂</option>
                </select>
            </div>
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">检测员 <span class="text-red-500">*</span></label>
                <input type="text" name="inspector" placeholder="输入姓名" required class="w-full border border-gray-300 p-2 rounded-md shadow-sm">
            </div>
        `;
    }
    
    // 点位容器
    const pointsContainer = document.getElementById('atpPointsContainer');
    if (pointsContainer) {
        const pointsTitle = document.createElement('div');
        pointsTitle.className = 'flex justify-between items-center mt-6 mb-3';
        pointsTitle.innerHTML = `<h3 class="font-medium text-gray-800">检测点位信息</h3>`;
        pointsContainer.parentNode.insertBefore(pointsTitle, pointsContainer);
        
        pointsContainer.className = 'space-y-4';
        if (!pointsContainer.children.length || (pointsContainer.children.length === 1 && !pointsContainer.querySelector('.btn-remove-point'))) {
            const defaultPoint = document.createElement('div');
            defaultPoint.className = 'border border-gray-200 rounded-lg p-5 bg-gray-50 atp-point';
            defaultPoint.innerHTML = getPointTemplate();
            pointsContainer.innerHTML = '';
            pointsContainer.appendChild(defaultPoint);
            bindPointEvents(defaultPoint);
        }
    }

    // 【恢复】添加整改措施和复检结果字段 (初次录入用)
    const actionSection = document.createElement('div');
    actionSection.className = 'mt-8 border-t pt-5';
    actionSection.innerHTML = `
        <h3 class="font-medium text-gray-800 mb-4 flex items-center">
            <i class="fas fa-clipboard-check text-yellow-600 mr-2"></i>整改记录（如有不合格项）
        </h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 bg-gray-50 p-5 rounded-lg border border-gray-200">
            <div>
                <label for="correctiveAction" class="block text-sm font-medium text-gray-700 mb-1">整改措施</label>
                <textarea id="correctiveAction" name="correctiveAction" class="w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-yellow-500 focus:border-yellow-500" rows="3" placeholder="请输入整改措施（不合格时填写）"></textarea>
            </div>
            <div>
                <label for="recheckResult" class="block text-sm font-medium text-gray-700 mb-1">复检结果备注</label>
                <textarea id="recheckResult" name="recheckResult" class="w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-green-500 focus:border-green-500" rows="3" placeholder="请输入复检结果备注（如有）"></textarea>
            </div>
        </div>
    `;
    
    // 检查是否已存在，不存在则添加
    if (!form.querySelector('#correctiveAction')) {
        const submitBtnContainer = form.querySelector('.flex.gap-2');
        if (submitBtnContainer) {
            submitBtnContainer.className = 'flex gap-3 mt-6 justify-end';
            
            const addPointBtn = submitBtnContainer.querySelector('#btnAddAtpPoint');
            if (addPointBtn) {
                addPointBtn.className = 'px-4 py-2 bg-green-600 text-white rounded-md shadow hover:bg-green-700 transition flex items-center';
                addPointBtn.innerHTML = '<i class="fas fa-plus mr-2"></i>添加点位';
            }
            
            const submitBtn = submitBtnContainer.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.className = 'px-6 py-2 bg-blue-600 text-white rounded-md shadow hover:bg-blue-700 transition flex items-center';
                submitBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存数据';
            }
            
            form.insertBefore(actionSection, submitBtnContainer);
        } else {
            form.appendChild(actionSection);
        }
    }
    
    // ✅ 修改：表格头部和分页
    const tableContainer = form.parentNode.querySelector('table');
    if (tableContainer) {
        // 确保不重复添加头部
        if (!form.parentNode.querySelector('.table-header-container')) {
            const tableHeaderContainer = document.createElement('div');
            tableHeaderContainer.className = 'table-header-container flex flex-col md:flex-row justify-between items-start md:items-center mt-8 mb-3';
            
            // ✅ 修改：表格头部增加食堂筛选
            tableHeaderContainer.innerHTML = `
                <h3 class="font-medium text-gray-800 flex items-center mb-2 md:mb-0"><i class="fas fa-table text-blue-600 mr-2"></i>历史检测记录</h3>
                <div class="flex flex-wrap items-center gap-2">
                    <!-- ✅ 新增：食堂筛选 -->
                    <div class="flex items-center">
                        <label class="text-sm text-gray-600 mr-2">食堂:</label>
                        <select id="canteenFilterSelect" class="border border-gray-300 rounded px-3 py-1 text-sm">
                            <option value="all">全部</option>
                            <option value="一食堂">一食堂</option>
                            <option value="二食堂">二食堂</option>
                            <option value="三食堂">三食堂</option>
                        </select>
                    </div>
                    <div class="flex items-center">
                        <label class="text-sm text-gray-600 mr-2">每页:</label>
                        <select id="recordsPerPageSelect" class="border border-gray-300 rounded px-2 py-1 text-sm">
                            <option value="5">5</option>
                            <option value="10" selected>10</option>
                            <option value="20">20</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                        </select>
                    </div>
                    <button id="sortOrderBtn" class="flex items-center bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1 rounded text-sm">
                        <i class="fas fa-sort-amount-down mr-1"></i><span id="sortOrderText">最新</span>
                    </button>
                </div>
            `;
            form.parentNode.insertBefore(tableHeaderContainer, tableContainer);
        }

        // 确保不重复添加分页
        if (!document.getElementById('tablePaginationContainer')) {
            const paginationContainer = document.createElement('div');
            paginationContainer.id = 'tablePaginationContainer';
            paginationContainer.className = 'flex flex-wrap justify-between items-center mt-4 mb-8';
            paginationContainer.innerHTML = `
                <div class="flex items-center text-sm text-gray-600"><span id="paginationInfo">...</span></div>
                <div class="flex items-center space-x-1">
                    <button id="prevPageBtn" class="px-3 py-1 bg-gray-100 rounded"><i class="fas fa-chevron-left"></i></button>
                    <div id="pageButtonsContainer" class="flex items-center space-x-1"></div>
                    <button id="nextPageBtn" class="px-3 py-1 bg-gray-100 rounded"><i class="fas fa-chevron-right"></i></button>
                </div>
                <form id="pageJumpForm" class="flex items-center ml-2">
                    <input type="number" id="pageJumpInput" min="1" class="border border-gray-300 rounded w-16 px-2 py-1 text-sm" placeholder="页">
                    <button type="submit" class="ml-1 px-2 py-1 bg-blue-500 text-white rounded text-sm"><i class="fas fa-arrow-right"></i></button>
                </form>
            `;
            tableContainer.parentNode.insertBefore(paginationContainer, tableContainer.nextSibling);
        }
        
        tableContainer.className = 'w-full text-sm border-collapse border border-gray-200 rounded-lg overflow-hidden';
    }
}

async function handleDeleteRecord(recordId) {
    const confirmed = await UINotification.confirm(
        '权限认证通过。确定要永久删除此记录吗？',
        '确认删除'
    );
    
    if (!confirmed) return;

    try {
        const success = storage.delete(recordId);
        if (success) {
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

function handleFormSubmit(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());

    // 验证基础信息
    const baseValidationSchema = {
        testDate: ['required', 'dateNotFuture'],
        canteen: ['required'],
        inspector: ['required']
    };

    const baseErrors = FormValidator.validate(data, baseValidationSchema);
    if (baseErrors) {
        FormValidator.showErrors(e.target, baseErrors);
        UINotification.warning('⚠️ 请填写完整的基础信息');
        return;
    }

    const points = [];
    const pointElements = document.querySelectorAll('.atp-point');
    let skippedCount = 0;
    
    for (let i = 0; i < pointElements.length; i++) {
        try {
            const div = pointElements[i];
            const locationEl = div.querySelector('[name="location"]');
            const rluEl = div.querySelector('[name="rluValue"]');
            const typeEl = div.querySelector('[name="testType"]');
            const testType = typeEl ? typeEl.value : 'atp';
            
            if (locationEl?.value && rluEl?.value) {
                let res = div.querySelector('[name="result"]').value;
                if (!res) {
                    if (testType === 'detergent') {
                        const v = parseFloat(rluEl.value);
                        res = isNaN(v) ? '' : (v <= 0.005 ? '合格 (≤0.005)' : '不合格 (>0.005)');
                    } else {
                        res = determineResult(parseInt(rluEl.value) || 0);
                    }
                }
                points.push({
                    loc: locationEl.value,
                    rlu: rluEl.value,
                    res: res,
                    testType: testType
                });
            } else {
                skippedCount++;
            }
        } catch (error) {
            console.error(`处理点位 ${i + 1} 出错:`, error);
            skippedCount++;
        }
    }
    
    if (points.length === 0) {
        UINotification.warning('⚠️ 请至少添加一个有效的检测点位');
        return;
    }
    
    try {
        data.atpPoints = points;
        data.modificationLogs = []; 
        data.recheckRecords = [];

        storage.save(data);
        
        let message = `✅ 成功保存 ${points.length} 个 ATP 检测点位`;
        if (skippedCount > 0) {
            message += `，${skippedCount} 条数据不完整被跳过`;
        }
        UINotification.success(message);
        
        e.target.reset();
        FormValidator.clearErrors(e.target);
        
        // 重置点位
        const pointsContainer = document.getElementById('atpPointsContainer');
        if (pointsContainer) {
            pointsContainer.innerHTML = '';
            addAtpPoint();
        }
        renderTable();
        document.dispatchEvent(new Event('dataChanged'));
    } catch (error) {
        console.error('保存失败:', error);
        UINotification.error('❌ 保存失败: ' + error.message);
    }
}

// ✅ 修改：renderTable 函数增加食堂筛选逻辑
function renderTable() {
    // ✨ 设置调试标志
    window.renderTableExecuted = (window.renderTableExecuted || 0) + 1;
    console.log('🎯 renderTable() 被调用 - 第', window.renderTableExecuted, '次');
    
    // ✨ 快速访问模式：直接从localStorage读取，绕过StorageService缓存
    let allRecords;
    const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
    
    console.log('📊 renderTable: isQuickAccess =', isQuickAccess);
    
    if (isQuickAccess) {
        try {
            const cacheData = localStorage.getItem('cache_tableware');
            const parsed = JSON.parse(cacheData || '{}');
            allRecords = parsed.data || [];
            console.log('📖 快速访问模式：从localStorage读取', allRecords.length, '条记录');
            if (allRecords.length > 0) {
                console.log('📋 第一条记录ID:', allRecords[0].id, '日期:', allRecords[0].testDate);
            }
        } catch (e) {
            console.error('❌ 读取缓存失败:', e);
            allRecords = storage.getAll();
        }
    } else {
        allRecords = storage.getAll();
        console.log('📖 普通模式：从StorageService读取', allRecords.length, '条记录');
    }
    
    const tbody = document.getElementById('tablewareRecords');
    window.lastTableRenderDebug = {
        called: true,
        tbodyFound: !!tbody,
        allRecordsCount: allRecords.length,
        isQuickAccess: isQuickAccess
    };
    console.log('🎯 获取tbody元素:', tbody ? 'found' : 'not found', '记录数:', allRecords.length);
    if (!tbody) {
        console.error('❌ tablewareRecords 元素不存在!');
        return;
    }

    // 表头
    const thead = tbody.parentElement.querySelector('thead');
    if (thead) {
        thead.innerHTML = `
            <tr>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">日期</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">食堂</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200">检测点位</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">检测项目</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">数值</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200">结果</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">检测员</th>
                <th class="px-4 py-3 text-left font-medium text-gray-700 border border-gray-200 text-center">操作</th>
            </tr>
        `;
    }

    // ✅ 新增：食堂筛选逻辑
    let filteredRecords = allRecords;
    if (selectedCanteenFilter !== 'all') {
        filteredRecords = allRecords.filter(record => record.canteen === selectedCanteenFilter);
    }

    // 排序
    const sortedRecords = [...filteredRecords].sort((a, b) => {
        const dateA = new Date(a.testDate || '1970-01-01');
        const dateB = new Date(b.testDate || '1970-01-01');
        return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
    });
    
    // 分页
    const totalRecords = sortedRecords.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / recordsPerPage));
    currentPage = Math.max(1, Math.min(currentPage, totalPages));
    
    const startIndex = (currentPage - 1) * recordsPerPage;
    const currentRecords = sortedRecords.slice(startIndex, startIndex + recordsPerPage);

    updatePagination(startIndex, Math.min(startIndex + recordsPerPage, totalRecords), totalRecords, totalPages);

    console.log('🎯 渲染前检查 - currentRecords.length:', currentRecords.length, ', totalRecords:', totalRecords);
    
    if (!currentRecords || currentRecords.length === 0) {
        console.log('⚠️ 没有当前记录要显示，显示空消息');
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-gray-500 bg-gray-50">暂无检测数据记录</td></tr>`;
        return;
    }

    let tableContent = '';
    
    currentRecords.forEach((record, idx) => {
        console.log(`🎯 处理第${idx + 1}条记录:`, record.id, record.testDate);
        
        const points = Array.isArray(record.atpPoints) ? record.atpPoints : [];
        const rowSpan = Math.max(1, points.length);
        
        console.log(`  - atpPoints数量: ${points.length}`);
        
        // 状态显示逻辑
        let displayStatusHtml = '';
        if (record.finalStatus === '整改后复检合格') {
            displayStatusHtml = `<span class="px-2 py-1 rounded-full text-xs font-bold bg-green-100 text-green-700 border border-green-200 mt-1 inline-block"><i class="fas fa-check-double mr-1"></i>复检合格</span>`;
        } else if (record.finalStatus === '复检不合格') {
            displayStatusHtml = `<span class="px-2 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200 mt-1 inline-block"><i class="fas fa-times-circle mr-1"></i>复检不合格</span>`;
        }

        if (!points.length) {
            // 兼容无点位数据的旧记录
            tableContent += `
                <tr class="border-b hover:bg-gray-50">
                    <td class="border px-4 py-3 text-center align-middle">${record.testDate}</td>
                    <td class="border px-4 py-3 text-center align-middle">${record.canteen}</td>
                    <td class="border px-4 py-3 text-gray-500" colspan="4">无数据</td>
                    <td class="border px-4 py-3 text-center align-middle">${record.inspector}</td>
                    <td class="border px-4 py-3 text-center align-middle">
                        <button class="px-3 py-1.5 bg-red-50 text-red-700 rounded btn-delete" data-id="${record.id}">删除</button>
                    </td>
                </tr>`;
            return;
        }

        points.forEach((p, idx) => {
            const isDetergent = p.testType === 'detergent';
            const typeLabel = isDetergent ? '洗涤剂残留' : '表面清洁度';
            const typeClass = isDetergent ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700';
            const valueDisplay = isDetergent
                ? `${p.rlu} <span class="text-xs text-gray-500">mg/100cm<sup>2</sup></span>`
                : p.rlu;
            tableContent += `
                <tr class="border-b hover:bg-gray-50 transition duration-150">
                    ${idx === 0 ? `<td rowspan="${rowSpan}" class="border px-4 py-3 bg-white align-middle text-center">${record.testDate}</td>` : ''}
                    ${idx === 0 ? `<td rowspan="${rowSpan}" class="border px-4 py-3 bg-white align-middle text-center">${record.canteen}</td>` : ''}
                    <td class="border px-4 py-3 align-middle">${p.loc}</td>
                    <td class="border px-4 py-3 align-middle text-center">
                        <span class="px-2 py-0.5 rounded-full text-xs font-medium ${typeClass}">${typeLabel}</span>
                    </td>
                    <td class="border px-4 py-3 align-middle text-center">${valueDisplay}</td>
                    <td class="border px-4 py-3 align-middle">
                        <div class="flex flex-col items-start">
                            <span class="result-value px-3 py-1 rounded-full text-xs font-medium ${getResultClass(p.res)} cursor-pointer hover:opacity-80" 
                                  data-id="${record.id}" title="点击查看详情">
                                <i class="${getResultIcon(p.res)} mr-1"></i>${p.res}
                            </span>
                            ${idx === 0 && displayStatusHtml ? displayStatusHtml : ''}
                        </div>
                    </td>
                    ${idx === 0 ? `<td rowspan="${rowSpan}" class="border px-4 py-3 bg-white align-middle text-center">${record.inspector}</td>` : ''}
                    ${idx === 0 ? `<td rowspan="${rowSpan}" class="border px-4 py-3 bg-white align-middle text-center">
                        <div class="flex flex-row gap-2 justify-center">
                            <button class="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition btn-edit flex items-center justify-center" data-id="${record.id}">
                                <i class="fas fa-edit text-xs mr-1"></i>编辑
                            </button>
                            <button class="px-3 py-1.5 bg-red-50 text-red-700 rounded-md hover:bg-red-100 transition btn-delete flex items-center justify-center" data-id="${record.id}">
                                <i class="fas fa-trash text-xs mr-1"></i>删除
                            </button>
                        </div>
                    </td>` : ''}
                </tr>
            `;
        });
    });
    
    console.log('✅ 表格内容生成完成，长度:', tableContent.length, '字节');
    console.log('✅ 设置tbody.innerHTML，包含', (tableContent.match(/<tr/g) || []).length, '行');
    tbody.innerHTML = tableContent;
    console.log('✅ 表格已渲染，当前tbody包含', tbody.querySelectorAll('tr').length, '行');
}

// ✅ 修改：setupPaginationListeners 函数增加食堂筛选事件
function setupPaginationListeners() {
    const paginationContainer = document.getElementById('tablePaginationContainer');
    const perPageSelect = document.getElementById('recordsPerPageSelect');
    const sortBtn = document.getElementById('sortOrderBtn');
    const jumpForm = document.getElementById('pageJumpForm');
    const canteenFilterSelect = document.getElementById('canteenFilterSelect'); // ✅ 新增

    if (paginationContainer && paginationContainer.dataset.listenersAttached === 'true') {
        console.log('分页事件监听器已存在，跳过绑定');
        return; 
    }

    // 绑定分页点击事件
    if (paginationContainer) {
        paginationContainer.addEventListener('click', (e) => {
            const pageBtn = e.target.closest('.page-btn');
            if (pageBtn) {
                currentPage = parseInt(pageBtn.dataset.page);
                renderTable();
            }
            if (e.target.closest('#prevPageBtn') && currentPage > 1) {
                currentPage--;
                renderTable();
            }
            if (e.target.closest('#nextPageBtn')) {
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
    
    // 绑定每页显示数量更改事件
    if (perPageSelect && !perPageSelect.dataset.listenerAttached) {
        perPageSelect.addEventListener('change', (e) => {
            recordsPerPage = parseInt(e.target.value);
            currentPage = 1;
            renderTable();
        });
        perPageSelect.dataset.listenerAttached = 'true';
    }
    
    // 绑定排序按钮事件
    if (sortBtn && !sortBtn.dataset.listenerAttached) {
        sortBtn.addEventListener('click', function() {
            sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
            
            const sortText = document.getElementById('sortOrderText');
            const sortIcon = this.querySelector('i');
            
            if (sortText) sortText.textContent = sortOrder === 'desc' ? '最新' : '最早';
            if (sortIcon) sortIcon.className = sortOrder === 'desc' ? 'fas fa-sort-amount-down mr-1' : 'fas fa-sort-amount-up mr-1';
            
            renderTable();
        });
        sortBtn.dataset.listenerAttached = 'true';
    }
    
    // 绑定页面跳转表单事件
    if (jumpForm && !jumpForm.dataset.listenerAttached) {
        jumpForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('pageJumpInput');
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
    const info = document.getElementById('paginationInfo');
    if(info) info.textContent = total > 0 ? `显示 ${start+1}-${end} 条，共 ${total} 条` : '暂无记录';
    
    const container = document.getElementById('pageButtonsContainer');
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

// 修复：调整判断顺序，先判断"不合格"
function getResultClass(result) {
    if (!result) return 'bg-gray-100 text-gray-800';
    if (result.includes('不合格')) return 'bg-red-100 text-red-800'; // 红色
    if (result.includes('警戒')) return 'bg-yellow-100 text-yellow-800';
    if (result.includes('合格')) return 'bg-green-100 text-green-800';
    return 'bg-gray-100 text-gray-800';
}

function addAtpPoint() {
    const div = document.createElement('div');
    div.className = 'border border-gray-200 rounded-lg p-5 bg-gray-50 atp-point';
    div.innerHTML = getPointTemplate(true);
    document.getElementById('atpPointsContainer').appendChild(div);
    bindPointEvents(div);
}

function getLocationOptionsByType(type) {
    if (type === 'detergent') {
        return [
            { value: '', label: '请选择点位' },
            { value: '不锈钢餐具', label: '不锈钢餐具' },
            { value: '密胺类餐具', label: '密胺类餐具' }
        ];
    }

    return [
        { value: '', label: '请选择点位' },
        { value: '餐具表面', label: '餐具表面' },
        { value: '砧板表面', label: '砧板表面' },
        { value: '操作台面', label: '操作台面' },
        { value: '餐桌表面', label: '餐桌表面' },
        { value: '其他接触面', label: '其他接触面' }
    ];
}

// 统一绑定点位事件（支持ATP和洗涤剂两种类型）
function bindPointEvents(pointDiv) {
    const typeSelect = pointDiv.querySelector('[name="testType"]');
    const locationSelect = pointDiv.querySelector('[name="location"]');
    const rluInput = pointDiv.querySelector('[name="rluValue"]');
    const resultField = pointDiv.querySelector('[name="result"]');
    const valueLabel = pointDiv.querySelector('.value-label');
    const unitLabel = pointDiv.querySelector('.unit-label');

    function updateForType(type) {
        if (locationSelect) {
            const currentValue = locationSelect.value;
            const options = getLocationOptionsByType(type);
            locationSelect.innerHTML = options
                .map(opt => `<option value="${opt.value}">${opt.label}</option>`)
                .join('');

            const hasCurrentOption = options.some(opt => opt.value === currentValue);
            locationSelect.value = hasCurrentOption ? currentValue : '';
        }

        if (type === 'detergent') {
            if (valueLabel) valueLabel.innerHTML = '洗涤剂浓度值 <span class="text-red-500">*</span>';
            if (rluInput) {
                rluInput.placeholder = '输入浓度值';
                rluInput.step = '0.001';
                rluInput.min = '0';
            }
            if (unitLabel) {
                unitLabel.textContent = 'mg/100cm²';
                unitLabel.classList.remove('hidden');
            }
        } else {
            if (valueLabel) valueLabel.innerHTML = 'RLU读数 <span class="text-red-500">*</span>';
            if (rluInput) {
                rluInput.placeholder = '输入RLU读数';
                rluInput.step = '1';
                rluInput.removeAttribute('min');
            }
            if (unitLabel) {
                unitLabel.textContent = '';
                unitLabel.classList.add('hidden');
            }
        }
        if (rluInput && rluInput.value) {
            recalcResult(type, rluInput.value, resultField);
        } else if (resultField) {
            resultField.value = '';
            updateResultFieldStyle(resultField);
        }
    }

    function recalcResult(type, val, field) {
        if (!field) return;
        if (type === 'detergent') {
            const v = parseFloat(val);
            if (isNaN(v) || val === '') {
                field.value = '';
            } else {
                field.value = v <= 0.005 ? '合格 (≤0.005)' : '不合格 (>0.005)';
            }
        } else {
            field.value = determineResult(parseInt(val) || 0);
        }
        updateResultFieldStyle(field);
    }

    if (typeSelect) {
        typeSelect.addEventListener('change', () => {
            updateForType(typeSelect.value);
        });
        // 初始化
        updateForType(typeSelect.value);
    }

    if (rluInput) {
        rluInput.addEventListener('input', () => {
            const type = typeSelect ? typeSelect.value : 'atp';
            recalcResult(type, rluInput.value, resultField);
        });
    }
}

function getPointTemplate(removable = false) {
    return `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 atp-point-content">
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">检测项目 <span class="text-red-500">*</span></label>
                <select name="testType" class="w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 point-test-type">
                    <option value="atp">表面清洁度</option>
                    <option value="detergent">洗涤剂残留</option>
                </select>
            </div>
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">检测点位 <span class="text-red-500">*</span></label>
                <select name="location" class="w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" required>
                    <option value="">请选择点位</option>
                    <option>餐具表面</option>
                    <option>砧板表面</option>
                    <option>操作台面</option>
                    <option>餐桌表面</option>
                    <option>其他接触面</option>
                </select>
            </div>
            <div class="value-input-col">
                <label class="block text-sm font-medium text-gray-700 mb-1 value-label">RLU读数 <span class="text-red-500">*</span></label>
                <div class="flex items-center gap-1">
                    <input type="number" name="rluValue" class="w-full border border-gray-300 p-2 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500" required placeholder="输入RLU读数">
                    <span class="unit-label text-xs text-gray-500 whitespace-nowrap hidden"></span>
                </div>
            </div>
            <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">判定结果 <span class="text-blue-500">(自动)</span></label>
                <input type="text" name="result" readonly class="w-full border border-gray-300 p-2 rounded-md shadow-sm bg-gray-50 cursor-not-allowed" value="">
            </div>
        </div>
        <div class="flex justify-end mt-2">
            ${removable ? 
                '<button type="button" class="btn-remove-point bg-red-500 text-white px-3 py-1.5 rounded-md shadow-sm hover:bg-red-600 transition flex items-center text-sm"><i class="fas fa-trash-alt mr-1"></i>删除点位</button>' : 
                '<div class="text-xs text-gray-500 bg-blue-50 px-2 py-1 rounded-md border border-blue-100 flex items-center"><i class="fas fa-info-circle mr-1 text-blue-400"></i>默认检测点位</div>'}
        </div>
    `;
}

// 详情页展示（包含日志和复检）
window.showTablewareDetail = function(recordId) {
    const records = storage.getAll();
    const record = records.find(r => r.id === parseInt(recordId));
    if (!record) return;
    
    const modal = document.createElement('div');
    modal.id = 'tablewareDetailModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    // 复检历史HTML
    let recheckHtml = '';
    if (record.recheckRecords && record.recheckRecords.length > 0) {
        recheckHtml = `<div class="mt-6 border-t pt-4">
            <h4 class="font-bold text-gray-800 mb-3"><i class="fas fa-history text-green-600 mr-2"></i>复检记录追踪</h4>
            <div class="space-y-3">
                ${record.recheckRecords.map(rec => `
                    <div class="bg-green-50 border border-green-200 rounded p-3 text-sm">
                        <div class="flex justify-between mb-2 border-b border-green-200 pb-1">
                            <span class="font-medium text-green-800">复检时间: ${rec.time}</span>
                            <span class="text-green-700">操作人: ${rec.user}</span>
                        </div>
                        <table class="w-full text-left">
                            ${rec.points.map(p => `
                                <tr>
                                    <td class="py-1 w-1/3">${p.loc}</td>
                                    <td class="py-1 w-1/3">RLU: ${p.rlu}</td>
                                    <td class="py-1 w-1/3 font-bold ${p.res.includes('合格')?'text-green-600':'text-red-600'}">${p.res}</td>
                                </tr>
                            `).join('')}
                        </table>
                        <div class="mt-2 text-right font-bold ${rec.isPassed ? 'text-green-600' : 'text-red-600'}">
                            结论: ${rec.isPassed ? '复检通过' : '复检未通过'}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    }

    // 日志HTML
    let logsHtml = '';
    if (record.modificationLogs && record.modificationLogs.length > 0) {
        logsHtml = `<div class="mt-6 border-t pt-4">
            <h4 class="font-bold text-gray-800 mb-3"><i class="fas fa-clipboard-list text-blue-600 mr-2"></i>操作审计日志</h4>
            <ul class="text-sm space-y-2 bg-gray-50 p-3 rounded max-h-40 overflow-y-auto">
                ${record.modificationLogs.map(log => `
                    <li class="flex flex-col border-b border-gray-200 pb-2 last:border-0">
                        <span class="text-xs text-gray-500">${log.time} | ${log.user}</span>
                        <span class="text-gray-800 font-medium">${log.action}</span>
                        ${log.content ? `<span class="text-gray-600 mt-1 bg-white p-1 rounded border border-gray-100">${log.content}</span>` : ''}
                    </li>
                `).join('')}
            </ul>
        </div>`;
    }

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl w-11/12 md:w-3/4 lg:w-2/3 max-h-[90vh] overflow-y-auto p-6">
            <div class="flex justify-between items-center border-b pb-3 mb-5">
                <h3 class="text-xl font-bold text-gray-800">检测详情档案 #${record.id}</h3>
                <button onclick="document.getElementById('tablewareDetailModal').remove()" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times text-xl"></i></button>
            </div>
            
            <!-- 原始数据 -->
            <div class="mb-6">
                <h4 class="font-bold text-gray-700 mb-2">原始检测数据</h4>
                <div class="grid grid-cols-3 gap-4 mb-4 text-sm bg-gray-50 p-3 rounded">
                    <div>日期: <span class="font-medium">${record.testDate}</span></div>
                    <div>食堂: <span class="font-medium">${record.canteen}</span></div>
                    <div>检测员: <span class="font-medium">${record.inspector}</span></div>
                </div>
                <table class="w-full text-sm border-collapse border border-gray-200">
                    <thead class="bg-gray-100">
                        <tr><th class="border p-2 text-left">点位</th><th class="border p-2 text-left">RLU</th><th class="border p-2 text-left">结果</th></tr>
                    </thead>
                    <tbody>
                        ${record.atpPoints.map(p => `
                            <tr>
                                <td class="border p-2">${p.loc}</td>
                                <td class="border p-2">${p.rlu}</td>
                                <td class="border p-2 ${p.res.includes('不合格')?'text-red-600 font-bold':''}"><i class="${getResultIcon(p.res)} mr-1"></i>${p.res}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            
            <!-- 当前整改措施 -->
            <div class="mt-5">
                <h4 class="font-medium text-gray-700 mb-3 flex items-center"><i class="fas fa-clipboard-check text-yellow-500 mr-2"></i>当前整改记录</h4>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="border border-yellow-200 bg-yellow-50 p-4 rounded-lg shadow-sm">
                        <p class="text-xs font-medium text-yellow-800 mb-1">整改措施</p>
                        <p class="text-sm">${record.correctiveAction || '无'}</p>
                    </div>
                    <div class="border border-green-200 bg-green-50 p-4 rounded-lg shadow-sm">
                        <p class="text-xs font-medium text-green-800 mb-1">复检结果备注</p>
                        <p class="text-sm">${record.recheckResult || '无'}</p>
                    </div>
                </div>
            </div>

            ${recheckHtml}
            ${logsHtml}
        </div>
    `;
    document.body.appendChild(modal);
};

// 导出初始化函数
window.initTableware = initTableware;
