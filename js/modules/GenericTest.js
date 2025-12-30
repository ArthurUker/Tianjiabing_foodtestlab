import { StorageService } from '../core/Storage.js';
import { auth } from '../core/Auth.js';

export class GenericTestModule {
    constructor(config) {
        this.moduleName = config.moduleName;
        this.formId = config.formId;
        this.tableId = config.tableId;
        this.storage = new StorageService(this.moduleName);
        this.currentPage = 1;
        this.recordsPerPage = 10;
        this.sortOrder = 'desc';
        this.selectedCanteenFilter = 'all'; // ✅ 食堂筛选状态
        this.selectedMeatTypes = []; // ✅ 新增：肉类品种筛选状态（仅用于肉蛋农残模块）
        this.init();
    }

    init() {
        const form = document.getElementById(this.formId);
        if (form) {
            form.removeAttribute('onsubmit');
            form.addEventListener('submit', (e) => this.handleSubmit(e));
            
            // 添加检测点位信息抬头、增加检测点位按钮以及分页控件
            this.updateFormStructure();
            
            // 🔥 如果是油品检测模块，初始化油品质量自动判断
            if (this.moduleName === 'oil') {
                this.initOilQualityAutoUpdate();
            }
        }

        // 事件委托：处理删除、编辑、详情查看
        document.getElementById(this.tableId)?.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.btn-delete');
            if (deleteBtn) {
                auth.verify('删除检测记录', (user) => {
                    this.handleDeleteRecord(deleteBtn.dataset.id);
                });
                return;
            }
            
            const editBtn = e.target.closest('.btn-edit');
            if (editBtn) {
                auth.verify('编辑/整改记录', (user) => {
                    this.handleEditRecord(editBtn.dataset.id, user);
                });
                return;
            }
            
            const detailBtn = e.target.closest('.btn-detail');
            if (detailBtn) {
                this.showDetailModal(detailBtn.dataset.id);
                return;
            }
        });

        // 点位添加按钮事件监听
        document.getElementById(`btnAdd${this.moduleName}Point`)?.addEventListener('click', () => {
            this.addTestPoint();
        });

        // 🔥 初始化分页监听器
        this.setupPaginationListeners();

        this.render();
    }

    // ✅ 修改：设置分页监听器（增加食堂筛选和肉类品种筛选）
    setupPaginationListeners() {
        const container = document.getElementById(`${this.moduleName}_pagination`);
        
        // 检查是否已绑定，防止重复触发
        if (!container || container.dataset.listenersAttached === 'true') return;

        // 1. 分页点击 (上一页/下一页/数字)
        container.addEventListener('click', (e) => {
            const pageBtn = e.target.closest('.page-btn');
            if (pageBtn) {
                this.currentPage = parseInt(pageBtn.dataset.page);
                this.render();
            }
            if (e.target.closest(`#${this.moduleName}_prevPage`) && this.currentPage > 1) {
                this.currentPage--;
                this.render();
            }
            if (e.target.closest(`#${this.moduleName}_nextPage`)) {
                const filteredRecords = this.getFilteredRecords();
                const totalPages = Math.ceil(filteredRecords.length / this.recordsPerPage);
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.render();
                }
            }
        });

        // ✅ 新增：肉类品种筛选事件（仅用于肉蛋农残模块）
        if (this.moduleName === 'leanMeat') {
            const meatTypeCheckboxes = document.querySelectorAll(`input[name="${this.moduleName}_meatTypeFilter"]`);
            meatTypeCheckboxes.forEach(checkbox => {
                if (!checkbox.dataset.listenerAttached) {
                    checkbox.addEventListener('change', () => {
                        // 收集所有选中的肉类品种
                        this.selectedMeatTypes = Array.from(meatTypeCheckboxes)
                            .filter(cb => cb.checked)
                            .map(cb => cb.value);
                        
                        this.currentPage = 1; // 重置到第一页
                        this.render();
                    });
                    checkbox.dataset.listenerAttached = 'true';
                }
            });
        }

        // ✅ 食堂筛选事件
        const canteenFilterSelect = document.getElementById(`${this.moduleName}_canteenFilter`);
        if (canteenFilterSelect && !canteenFilterSelect.dataset.listenerAttached) {
            canteenFilterSelect.addEventListener('change', (e) => {
                this.selectedCanteenFilter = e.target.value;
                this.currentPage = 1; // 重置到第一页
                this.render();
            });
            canteenFilterSelect.dataset.listenerAttached = 'true';
        }

        // 2. 每页数量改变
        const perPageSelect = document.getElementById(`${this.moduleName}_recordsPerPage`);
        if (perPageSelect && !perPageSelect.dataset.listenerAttached) {
            perPageSelect.addEventListener('change', (e) => {
                this.recordsPerPage = parseInt(e.target.value);
                this.currentPage = 1;
                this.render();
            });
            perPageSelect.dataset.listenerAttached = 'true';
        }

        // 3. 排序按钮
        const sortBtn = document.getElementById(`${this.moduleName}_sortBtn`);
        if (sortBtn && !sortBtn.dataset.listenerAttached) {
            sortBtn.addEventListener('click', (e) => {
                const btn = e.currentTarget;
                this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
                
                const textSpan = btn.querySelector('.sort-text');
                const icon = btn.querySelector('i');
                if (textSpan) textSpan.textContent = this.sortOrder === 'desc' ? '最新' : '最早';
                if (icon) icon.className = this.sortOrder === 'desc' ? 'fas fa-sort-amount-down mr-1' : 'fas fa-sort-amount-up mr-1';
                
                this.render();
            });
            sortBtn.dataset.listenerAttached = 'true';
        }

        // 4. 跳转表单
        const jumpForm = document.getElementById(`${this.moduleName}_jumpForm`);
        if (jumpForm && !jumpForm.dataset.listenerAttached) {
            jumpForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = document.getElementById(`${this.moduleName}_jumpInput`);
                if (input) {
                    const pageNum = parseInt(input.value);
                    const filteredRecords = this.getFilteredRecords();
                    const totalPages = Math.ceil(filteredRecords.length / this.recordsPerPage);
                    if (pageNum >= 1 && pageNum <= totalPages) {
                        this.currentPage = pageNum;
                        this.render();
                    }
                }
            });
            jumpForm.dataset.listenerAttached = 'true';
        }

        // 标记已绑定
        container.dataset.listenersAttached = 'true';
    }

    // ✅ 新增：统一的筛选逻辑
    getFilteredRecords() {
        const allRecords = this.storage.getAll();
        let filteredRecords = allRecords;

        // 食堂筛选
        if (this.selectedCanteenFilter !== 'all') {
            filteredRecords = filteredRecords.filter(record => record.canteen === this.selectedCanteenFilter);
        }

        // 肉类品种筛选（仅用于肉蛋农残模块）
        if (this.moduleName === 'leanMeat' && this.selectedMeatTypes.length > 0) {
            filteredRecords = filteredRecords.filter(record => 
                this.selectedMeatTypes.includes(record.meatType)
            );
        }

        return filteredRecords;
    }

    // 🔥 更新分页UI显示 (页码按钮)
    updatePaginationUI(start, end, total, pages) {
        const info = document.getElementById(`${this.moduleName}_paginationInfo`);
        if (info) info.textContent = total > 0 ? `显示 ${start + 1}-${end} 条，共 ${total} 条` : '暂无记录';

        const btnContainer = document.getElementById(`${this.moduleName}_pageButtons`);
        if (btnContainer) {
            let html = '';
            let startPage = Math.max(1, this.currentPage - 2);
            let endPage = Math.min(pages, startPage + 4);
            if (endPage - startPage < 4 && pages > 4) startPage = Math.max(1, endPage - 4);

            for (let i = startPage; i <= endPage; i++) {
                html += `<button class="page-btn px-3 py-1 ${i === this.currentPage ? 'bg-blue-500 text-white' : 'bg-gray-100 hover:bg-gray-200'} rounded" data-page="${i}">${i}</button>`;
            }
            btnContainer.innerHTML = html;
        }
    }
    
    // 🔥 删除记录
    handleDeleteRecord(recordId) {
        if (!confirm('确定删除该记录吗？此操作不可恢复！')) return;
        
        const success = this.storage.delete(recordId);
        if (success) {
            alert('删除成功');
            this.render();
            document.dispatchEvent(new Event('dataChanged'));
        } else {
            alert('删除失败');
        }
    }
    
    // 🔥 编辑记录（整改与复检）
    handleEditRecord(recordId, currentUser) {
        const records = this.storage.getAll();
        const record = records.find(r => r.id === parseInt(recordId));
        
        if (!record) {
            alert('错误：未找到该记录，可能已被删除。');
            this.render();
            return;
        }

        this.showEditModal(record, currentUser);
    }
    
    // 🔥 显示编辑/整改模态框
    showEditModal(record, currentUser) {
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
                    <div class="text-gray-700">${rec.description || '无描述'}</div>
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
                                <div class="mb-4">
                                    <label class="block text-sm font-medium text-gray-700 mb-2">复检结果</label>
                                    <select id="recheckResult" class="w-full border border-gray-300 rounded p-2">
                                        <option value="合格">合格</option>
                                        <option value="不合格">不合格</option>
                                    </select>
                                </div>
                                <div class="mb-4">
                                    <label class="block text-sm font-medium text-gray-700 mb-2">复检说明</label>
                                    <textarea id="recheckDescription" class="w-full border border-gray-300 rounded p-2" rows="3" placeholder="请输入复检情况说明..."></textarea>
                                </div>
                                <div class="flex justify-end">
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

            const success = this.storage.update(record.id, record);
            
            if (success) {
                document.getElementById('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
                this.render(); 
                document.dispatchEvent(new Event('dataChanged')); 
                alert('日志已保存');
            } else {
                alert('保存失败，请检查存储空间');
            }
        };

        // 保存复检结果
        document.getElementById('btnSaveRecheck').onclick = () => {
            const result = document.getElementById('recheckResult').value;
            const description = document.getElementById('recheckDescription').value.trim();
            
            if (!description) {
                alert('请输入复检说明');
                return;
            }
            
            const newRecheck = {
                time: new Date().toLocaleString(),
                user: currentUser,
                isPassed: result === '合格',
                description: description
            };
            
            record.recheckRecords = record.recheckRecords || [];
            record.recheckRecords.unshift(newRecheck);
            
            // 如果复检合格，更新主记录的结果状态
            if (newRecheck.isPassed) {
                record.result = '合格';
            }

            const success = this.storage.update(record.id, record);
            
            if (success) {
                document.getElementById('recheckHistoryList').innerHTML = renderRecheckHistory(record.recheckRecords);
                document.getElementById('recheckDescription').value = '';
                this.render(); 
                document.dispatchEvent(new Event('dataChanged')); 
                alert('复检结果已保存');
            } else {
                alert('保存失败，请检查存储空间');
            }
        };
    }
    
    // 🔥 显示详情模态框
    showDetailModal(recordId) {
        const records = this.storage.getAll();
        const record = records.find(r => r.id === parseInt(recordId));
        
        if (!record) {
            alert('未找到该记录');
            return;
        }

        document.getElementById('detailModal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'detailModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';
        
        // 根据不同模块生成详情内容
        let detailContent = '';
        if (this.moduleName === 'pesticide') {
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">蔬菜品种：</span>${record.vegetableType}</div>
                    <div><span class="font-medium">检测项目：</span>${record.batchNo}</div>
                    <div><span class="font-medium">检测结果：</span><span class="px-2 py-1 rounded ${record.result === '合格' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${record.result}</span></div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${record.remark}</div>` : ''}
                </div>
            `;
        } else if (this.moduleName === 'oil') {
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">油温：</span>${record.oilTemp}℃</div>
                    <div><span class="font-medium">TPM值：</span>${record.tpmValue} g/100g</div>
                    <div><span class="font-medium">品质等级：</span><span class="px-2 py-1 rounded ${record.colorLevel === '合格' ? 'bg-green-100 text-green-800' : record.colorLevel === '警戒' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}">${record.colorLevel}</span></div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${record.remark}</div>` : ''}
                </div>
            `;
        } else if (this.moduleName === 'leanMeat') {
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">肉类品种：</span>${record.meatType}</div>
                    <div><span class="font-medium">检测项目：</span>${record.batchNo}</div>
                    <div><span class="font-medium">检测结果：</span><span class="px-2 py-1 rounded ${record.result === '合格' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${record.result}</span></div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${record.remark}</div>` : ''}
                </div>
            `;
        }

        modal.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl w-11/12 md:w-2/3 max-h-[90vh] overflow-y-auto">
                <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                    <h3 class="font-bold text-lg text-gray-800"><i class="fas fa-info-circle text-blue-600 mr-2"></i>检测记录详情</h3>
                    <button id="closeDetailModal" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
                </div>
                <div class="p-6">
                    ${detailContent}
                    ${record.correctiveAction ? `
                        <div class="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
                            <div class="font-medium text-gray-700 mb-1">整改措施：</div>
                            <div class="text-gray-600">${record.correctiveAction}</div>
                        </div>
                    ` : ''}
                    ${record.recheckRecords && record.recheckRecords.length > 0 ? `
                        <div class="mt-4 p-3 bg-blue-50 border border-blue-200 rounded">
                            <div class="font-medium text-gray-700 mb-2">复检记录：</div>
                            ${record.recheckRecords.map(rec => `
                                <div class="text-sm mb-1">
                                    <span class="font-medium ${rec.isPassed ? 'text-green-600' : 'text-red-600'}">[${rec.isPassed ? '合格' : '不合格'}]</span>
                                    ${rec.time} - ${rec.description}
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.getElementById('closeDetailModal').onclick = () => modal.remove();
    }
    
    // 🔥 初始化油品质量自动判断功能
    initOilQualityAutoUpdate() {
        const colorSelect = document.getElementById('oilColor');
        if (colorSelect) {
            // 移除 HTML 中的 onchange 属性（如果存在）
            colorSelect.removeAttribute('onchange');
            
            // 绑定事件监听器
            colorSelect.addEventListener('change', () => {
                this.updateOilQuality(colorSelect);
            });
            
            // 页面加载时初始化一次
            this.updateOilQuality(colorSelect);
        }
    }
    
    // 🔥 油品质量自动判断方法
    updateOilQuality(colorSelect) {
        // 找到相关元素（支持原始表单和克隆的点位）
        const container = colorSelect.closest('.grid');
        const qualityInput = container.querySelector('input[name="colorLevel"], input[name="colorLevel[]"]');
        const tpmReference = container.querySelector('.text-xs span');
        const tpmValue = parseFloat(colorSelect.value);
        
        // 更新参考值显示
        if (tpmReference) {
            tpmReference.textContent = tpmValue.toFixed(2) + ' g/100g';
        }
        
        // 根据颜色值自动判断品质等级
        if (qualityInput) {
            if (tpmValue <= 0.13) {
                qualityInput.value = '合格';
                qualityInput.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm bg-green-50 text-green-700';
            } else if (tpmValue <= 0.25) {
                qualityInput.value = '警戒';
                qualityInput.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm bg-yellow-50 text-yellow-700';
            } else {
                qualityInput.value = '不合格';
                qualityInput.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm bg-red-50 text-red-700';
            }
        }
    }
    
    // ✅ 修改：更新表单结构，添加食堂筛选和肉类品种筛选
    updateFormStructure() {
        const form = document.getElementById(this.formId);
        if (!form) return;
        
        // --- 1. 处理表单输入区域 (保持原有逻辑) ---
        const dataSection = form.querySelector('.grid-cols-2') || 
                           form.querySelector('.grid:nth-child(2)');
                           
        if (dataSection && !dataSection.previousElementSibling?.classList.contains('test-info-header')) {
            // 创建检测点位信息抬头
            const sectionTitle = document.createElement('div');
            sectionTitle.className = 'flex justify-between items-center mt-6 mb-3 test-info-header';
            
            let titleText = '检测点位信息';
            if (this.moduleName === 'pesticide') titleText = '果蔬农残检测信息';
            else if (this.moduleName === 'oil') titleText = '食用油品质检测信息';
            else if (this.moduleName === 'leanMeat') titleText = '肉蛋农残检测信息';
            
            sectionTitle.innerHTML = `<h3 class="font-medium text-gray-800">${titleText}</h3>`;
            dataSection.parentNode.insertBefore(sectionTitle, dataSection);
            
            dataSection.id = `${this.moduleName}DataSection`;
            
            const pointsContainer = document.createElement('div');
            pointsContainer.id = `${this.moduleName}PointsContainer`;
            pointsContainer.className = 'space-y-4';
            
            dataSection.parentNode.insertBefore(pointsContainer, dataSection);
            pointsContainer.appendChild(dataSection);
            
            this.addRemarkField(dataSection);
            
            const submitBtnContainer = form.querySelector('button[type="submit"]').closest('div');
            if (submitBtnContainer) {
                submitBtnContainer.className = 'flex gap-3 mt-6 justify-end';
                
                const addPointBtn = document.createElement('button');
                addPointBtn.id = `btnAdd${this.moduleName}Point`;
                addPointBtn.type = 'button';
                addPointBtn.className = 'px-4 py-2 bg-green-600 text-white rounded-md shadow hover:bg-green-700 transition flex items-center';
                addPointBtn.innerHTML = '<i class="fas fa-plus mr-2"></i>添加检测点位';
                
                submitBtnContainer.insertBefore(addPointBtn, submitBtnContainer.firstChild);
                
                const submitBtn = submitBtnContainer.querySelector('button[type="submit"]');
                if (submitBtn) {
                    submitBtn.className = 'px-6 py-2 bg-blue-600 text-white rounded-md shadow hover:bg-blue-700 transition flex items-center';
                    if (!submitBtn.querySelector('i')) {
                        submitBtn.innerHTML = '<i class="fas fa-save mr-2"></i>' + submitBtn.textContent;
                    }
                }
            }
        }

        // --- 2. [核心修复] 分页控件插入位置修正 + 增加筛选器 ---
        const tbody = document.getElementById(this.tableId);
        if (tbody) {
            const tableElement = tbody.closest('table');
            
            if (tableElement) {
                // 2.1 插入头部控件 -> 放在 table 标签之前
                if (!document.getElementById(`${this.moduleName}_header_controls`)) {
                    const headerControls = document.createElement('div');
                    headerControls.id = `${this.moduleName}_header_controls`;
                    headerControls.className = 'flex flex-col md:flex-row justify-between items-start md:items-center mt-8 mb-3';
                    
                    // ✅ 修改：根据模块类型生成不同的筛选器
                    let filterHTML = '';
                    
                    if (this.moduleName === 'leanMeat') {
                        // ✅ 肉蛋农残模块：肉类品种多选 + 食堂筛选
                        filterHTML = `
                            <!-- ✅ 新增：肉类品种多选筛选 -->
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">品种:</label>
                                <div class="flex flex-wrap gap-2 bg-gray-50 border border-gray-300 rounded px-3 py-2">
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="猪肉" class="mr-1">
                                        猪肉
                                    </label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="牛肉" class="mr-1">
                                        牛肉
                                    </label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="羊肉" class="mr-1">
                                        羊肉
                                    </label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="禽肉" class="mr-1">
                                        禽肉
                                    </label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="鱼肉" class="mr-1">
                                        鱼肉
                                    </label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded">
                                        <input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="禽蛋" class="mr-1">
                                        禽蛋
                                    </label>
                                </div>
                            </div>
                            <!-- 食堂筛选 -->
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">食堂:</label>
                                <select id="${this.moduleName}_canteenFilter" class="border border-gray-300 rounded px-3 py-1 text-sm">
                                    <option value="all">全部</option>
                                    <option value="一食堂">一食堂</option>
                                    <option value="二食堂">二食堂</option>
                                    <option value="三食堂">三食堂</option>
                                </select>
                            </div>
                        `;
                    } else {
                        // 其他模块：只有食堂筛选
                        filterHTML = `
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">食堂:</label>
                                <select id="${this.moduleName}_canteenFilter" class="border border-gray-300 rounded px-3 py-1 text-sm">
                                    <option value="all">全部</option>
                                    <option value="一食堂">一食堂</option>
                                    <option value="二食堂">二食堂</option>
                                    <option value="三食堂">三食堂</option>
                                </select>
                            </div>
                        `;
                    }
                    
                    headerControls.innerHTML = `
                        <h3 class="font-medium text-gray-800 flex items-center mb-2 md:mb-0">
                            <i class="fas fa-table text-blue-600 mr-2"></i>历史检测记录
                        </h3>
                        <div class="flex flex-wrap items-center gap-2">
                            ${filterHTML}
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">每页:</label>
                                <select id="${this.moduleName}_recordsPerPage" class="border border-gray-300 rounded px-2 py-1 text-sm">
                                    <option value="5">5</option>
                                    <option value="10" selected>10</option>
                                    <option value="20">20</option>
                                </select>
                            </div>
                            <button id="${this.moduleName}_sortBtn" class="flex items-center bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1 rounded text-sm">
                                <i class="fas fa-sort-amount-down mr-1"></i><span class="sort-text">最新</span>
                            </button>
                        </div>
                    `;
                    // 插入到 table 元素的前面
                    tableElement.parentNode.insertBefore(headerControls, tableElement);
                }

                // 2.2 插入底部控件 (分页条 + 跳转) -> 放在 table 标签之后
                if (!document.getElementById(`${this.moduleName}_pagination`)) {
                    const paginationContainer = document.createElement('div');
                    paginationContainer.id = `${this.moduleName}_pagination`;
                    paginationContainer.className = 'flex flex-wrap justify-between items-center mt-4 mb-8';
                    paginationContainer.innerHTML = `
                        <div class="flex items-center text-sm text-gray-600"><span id="${this.moduleName}_paginationInfo">...</span></div>
                        <div class="flex items-center space-x-1">
                            <button id="${this.moduleName}_prevPage" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200"><i class="fas fa-chevron-left"></i></button>
                            <div id="${this.moduleName}_pageButtons" class="flex items-center space-x-1"></div>
                            <button id="${this.moduleName}_nextPage" class="px-3 py-1 bg-gray-100 rounded hover:bg-gray-200"><i class="fas fa-chevron-right"></i></button>
                        </div>
                        <form id="${this.moduleName}_jumpForm" class="flex items-center ml-2">
                            <input type="number" id="${this.moduleName}_jumpInput" min="1" class="border border-gray-300 rounded w-16 px-2 py-1 text-sm" placeholder="页">
                            <button type="submit" class="ml-1 px-2 py-1 bg-blue-500 text-white rounded text-sm"><i class="fas fa-arrow-right"></i></button>
                        </form>
                    `;
                    // 插入到 table 元素的后面
                    tableElement.parentNode.insertBefore(paginationContainer, tableElement.nextSibling);
                }
            }
        }
    }

    
    // 添加备注字段
    addRemarkField(container) {
        if (!container) return;
        
        // 如果已经有备注字段，则不再添加
        if (container.querySelector('.remark-field')) return;
        
        // 设置不同模块的备注提示文本
        let remarkLabel = '备注';
        let remarkPlaceholder = '请输入整改措施、检测意见等信息...';
        
        if (this.moduleName === 'pesticide') {
            remarkLabel = '果蔬农残备注';
            remarkPlaceholder = '请输入果蔬农残检测相关的整改措施、检测意见等...';
        } else if (this.moduleName === 'oil') {
            remarkLabel = '食用油品质备注';
            remarkPlaceholder = '请输入食用油品质相关的整改措施、检测意见等...';
        } else if (this.moduleName === 'leanMeat') {
            remarkLabel = '肉蛋农残备注';
            remarkPlaceholder = '请输入肉蛋农残检测相关的整改措施、检测意见等...';
        }
        
        // 创建备注字段容器 - 使用 col-span-3 来占据整行
        const remarkField = document.createElement('div');
        remarkField.className = 'col-span-3 remark-field';
        
        // 创建备注标签和输入框布局
        remarkField.innerHTML = `
            <label class="block text-sm font-medium text-gray-700 mb-1">${remarkLabel}</label>
            <textarea name="remark" rows="3" class="w-full border border-gray-300 p-2 rounded-md shadow-sm" 
                placeholder="${remarkPlaceholder}"></textarea>
        `;
        
        // 添加到容器中（会自动占据下一行的完整宽度）
        container.appendChild(remarkField);
    }
    
    // 添加新的检测点位
    addTestPoint() {
        // 获取点位容器
        const pointsContainer = document.getElementById(`${this.moduleName}PointsContainer`);
        if (!pointsContainer) return;
        
        // 找到第一个数据输入区域
        const originalSection = document.getElementById(`${this.moduleName}DataSection`);
        if (!originalSection) return;
        
        // 创建一个包装器，用于添加删除按钮
        const pointWrapper = document.createElement('div');
        pointWrapper.className = 'relative';
        
        // 克隆原始输入区域
        const newSection = originalSection.cloneNode(true);
        newSection.id = ''; // 移除ID以避免重复
        
        // 将克隆的节点添加到包装器中
        pointWrapper.appendChild(newSection);
        
        // 添加删除按钮 (右上角的叉叉圆圈)
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'absolute -right-2 -top-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center shadow hover:bg-red-600 transition z-10';
        deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
        deleteBtn.title = '删除此检测点位';
        deleteBtn.onclick = function() {
            this.closest('.space-y-4 > div.relative').remove();
        };
        
        // 将删除按钮添加到包装器
        pointWrapper.appendChild(deleteBtn);
        
        // 清空克隆的表单字段
        const inputs = newSection.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            if (input.type !== 'radio' && input.type !== 'checkbox') {
                input.value = '';
            } else {
                input.checked = false;
            }
            
            // 为多点位数据收集修改name属性
            if (input.name && !input.name.endsWith('[]')) {
                input.name = input.name + '[]';
            }
        });
        
        // 🔥 如果是油品检测模块，为新的油品颜色选择框绑定事件
        if (this.moduleName === 'oil') {
            const colorSelect = newSection.querySelector('select[name="tpmValue[]"]');
            if (colorSelect) {
                // 移除原有的 onchange 属性
                colorSelect.removeAttribute('onchange');
                
                // 添加事件监听器
                colorSelect.addEventListener('change', () => {
                    this.updateOilQuality(colorSelect);
                });
                
                // 初始化时触发一次
                this.updateOilQuality(colorSelect);
            }
        }
        
        // 添加到容器
        pointsContainer.appendChild(pointWrapper);
    }

    handleSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        
        // 🔥 区分基本信息和检测点位数据
        const baseInfo = {
            testDate: formData.get('testDate'),
            canteen: formData.get('canteen'),
            inspector: formData.get('inspector')
        };
        
        // 🔥 获取所有检测点位的容器
        const pointsContainer = document.getElementById(`${this.moduleName}PointsContainer`);
        if (!pointsContainer) {
            alert('未找到检测点位容器');
            return;
        }
        
        const allPoints = pointsContainer.querySelectorAll('.grid');
        
        if (allPoints.length === 0) {
            alert('没有检测点位数据');
            return;
        }
        
        let savedCount = 0;
        
        // 🔥 遍历每个检测点位，生成独立的记录
        allPoints.forEach((point, index) => {
            const pointData = { ...baseInfo }; // 复制基本信息
            
            // 🔥 根据不同模块提取点位特定数据
            if (this.moduleName === 'pesticide') {
                const vegetableType = point.querySelector('input[name="vegetableType"], input[name="vegetableType[]"]')?.value;
                const batchNo = point.querySelector('select[name="batchNo"], select[name="batchNo[]"]')?.value;
                const result = point.querySelector('select[name="result"], select[name="result[]"]')?.value;
                const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;
                
                if (!vegetableType || !batchNo || !result) {
                    console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                    return;
                }
                
                pointData.vegetableType = vegetableType;
                pointData.batchNo = batchNo;
                pointData.result = result;
                pointData.remark = remark || '';
                
            } else if (this.moduleName === 'oil') {
                const oilTemp = point.querySelector('input[name="oilTemp"], input[name="oilTemp[]"]')?.value;
                const tpmValue = point.querySelector('select[name="tpmValue"], select[name="tpmValue[]"]')?.value;
                const colorLevel = point.querySelector('input[name="colorLevel"], input[name="colorLevel[]"]')?.value;
                const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;
                
                if (!oilTemp || !tpmValue || !colorLevel) {
                    console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                    return;
                }
                
                pointData.oilTemp = oilTemp;
                pointData.tpmValue = tpmValue;
                pointData.colorLevel = colorLevel;
                pointData.remark = remark || '';
                
            } else if (this.moduleName === 'leanMeat') {
                const meatType = point.querySelector('select[name="meatType"], select[name="meatType[]"]')?.value;
                const batchNo = point.querySelector('select[name="batchNo"], select[name="batchNo[]"]')?.value;
                const result = point.querySelector('select[name="result"], select[name="result[]"]')?.value;
                const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;
                
                if (!meatType || !batchNo || !result) {
                    console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                    return;
                }
                
                pointData.meatType = meatType;
                pointData.batchNo = batchNo;
                pointData.result = result;
                pointData.remark = remark || '';
            }
            
            // 🔥 保存单条记录
            const success = this.storage.save(pointData);
            if (success) {
                savedCount++;
            }
        });
        
        // 🔥 根据保存结果显示不同的提示
        if (savedCount > 0) {
            alert(`成功保存 ${savedCount} 条检测记录`);
            e.target.reset();
            
            // 清空所有动态添加的点位，只保留第一个
            const firstPoint = pointsContainer.children[0];
            pointsContainer.innerHTML = '';
            pointsContainer.appendChild(firstPoint);
            
            // 🔥 如果是油品检测，重新初始化第一个点位的自动判断
            if (this.moduleName === 'oil') {
                const colorSelect = firstPoint.querySelector('select[name="tpmValue"]');
                if (colorSelect) {
                    this.updateOilQuality(colorSelect);
                }
            }
            
            this.render();
            document.dispatchEvent(new Event('dataChanged'));
        } else {
            alert('保存失败，请检查数据完整性');
        }
    }

    // ✅ 修改：render 函数使用统一的筛选逻辑
    render() {
        const tbody = document.getElementById(this.tableId);
        if (!tbody) return;

        // 1. 使用统一的筛选方法获取数据
        const filteredRecords = this.getFilteredRecords();
        
        // 2. 排序
        const sortedRecords = [...filteredRecords].sort((a, b) => {
            const dateA = new Date(a.testDate || '1970-01-01');
            const dateB = new Date(b.testDate || '1970-01-01');
            return this.sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        });

        // 3. 计算分页
        const totalRecords = sortedRecords.length;
        const totalPages = Math.max(1, Math.ceil(totalRecords / this.recordsPerPage));
        this.currentPage = Math.max(1, Math.min(this.currentPage, totalPages));

        const startIndex = (this.currentPage - 1) * this.recordsPerPage;
        // 切片获取当前页数据
        const currentRecords = sortedRecords.slice(startIndex, startIndex + this.recordsPerPage);

        // 4. 更新分页控件
        this.updatePaginationUI(startIndex, Math.min(startIndex + this.recordsPerPage, totalRecords), totalRecords, totalPages);

        // 5. 渲染表格
        if (currentRecords.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-gray-500">暂无数据</td></tr>`;
            return;
        }

        tbody.innerHTML = currentRecords.map(r => {
            const result = r.result || r.colorLevel || '未知';
            const isPass = '合格' === result || result.includes('合格');
            
            // 添加备注信息显示
            const remarkInfo = r.remark ? 
                `<div class="text-xs text-gray-500 mt-1" title="${r.remark}">备注: ${r.remark.length > 15 ? r.remark.substring(0, 15) + '...' : r.remark}</div>` : '';
            
            // 根据不同模块生成不同的列
            let dataColumns = '';
            if (this.moduleName === 'pesticide') {
                dataColumns = `
                    <td class="border px-4 py-2">${r.vegetableType || '-'}</td>
                    <td class="border px-4 py-2">${r.batchNo || '-'}</td>
                `;
            } else if (this.moduleName === 'oil') {
                dataColumns = `
                    <td class="border px-4 py-2">${r.oilTemp || '-'}℃</td>
                    <td class="border px-4 py-2">TPM: ${r.tpmValue || '-'}</td>
                `;
            } else if (this.moduleName === 'leanMeat') {
                dataColumns = `
                    <td class="border px-4 py-2">${r.meatType || '-'}</td>
                    <td class="border px-4 py-2">${r.batchNo || '-'}</td>
                `;
            }

            return `
            <tr class="border-b hover:bg-gray-50">
                <td class="border px-4 py-2">${r.testDate}</td>
                <td class="border px-4 py-2">${r.canteen}</td>
                ${dataColumns}
                <td class="border px-4 py-2">
                    <span class="px-2 py-1 rounded-full text-xs cursor-pointer btn-detail ${isPass ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}" data-id="${r.id}">
                        ${result}
                    </span>
                    ${remarkInfo}
                </td>
                <td class="border px-4 py-2">${r.inspector || '-'}</td>
                <td class="border px-4 py-2">
                    <div class="flex gap-2 justify-center">
                        <button class="text-blue-600 hover:text-blue-800 btn-edit" data-id="${r.id}" title="整改/复检">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="text-green-600 hover:text-green-800 btn-detail" data-id="${r.id}" title="查看详情">
                            <i class="fas fa-info-circle"></i>
                        </button>
                        <button class="text-red-600 hover:text-red-800 btn-delete" data-id="${r.id}" title="删除">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }
}
