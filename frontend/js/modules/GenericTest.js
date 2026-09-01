import { StorageService } from '../core/Storage.js';
import { operationGuard } from '../core/Auth.js';
import { FormValidator } from '../utils/FormValidator.js';
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { GuestAuthService } from '../services/GuestAuthService.js';
import { permissionService } from '../services/PermissionService.js';
import { collectCustomFieldValues, getSchoolCustomization, getSchoolCanteens } from '../utils/schoolCustomization.js';
// TD-CascadeFieldOption: collectCustomFieldValues 内部会从 customization.hidden_fields
// 过滤"已隐藏的自定义字段"；若 getSchoolCustomization 不传 schoolCode 则恒为 {}，
// 隐藏规则失效，被管理端隐藏的字段会随提交再次落库。
import { extractSchoolCode } from '../utils/schoolCode.js';
import { escapeHtml } from '../utils/schoolCustomization/shared.js';
import { getLocalDateStr } from '../utils/dateUtil.js';

export class GenericTestModule {
    constructor(config) {
        this.moduleName = config.moduleName;
        this.formId = config.formId;
        this.tableId = config.tableId;
        this.storage = new StorageService(this.moduleName);
        this.currentPage = 1;
        this.recordsPerPage = 10;
        this.sortOrder = 'desc';
        this.selectedCanteenFilter = 'all';
        this.selectedMeatTypes = [];

        // TD-EventLeak-Phase2: 用于绑定事件时 abort 清理，避免重复 init 时监听器堆积
        this._abortCtrl = null;
        this._syncHandler = null;

        // ✨ 检查是否处于快速访问模式
        const guestAuthService = new GuestAuthService();
        this.isQuickAccess = guestAuthService.isQuickAccessMode();
        
        this.init();
    }

    init() {
        // TD-EventLeak-Phase2: 重置控制器，abort 掉上一次 init 绑定的监听器（重复进入页面时防止堆积）
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();
        const { signal } = this._abortCtrl;

        const form = document.getElementById(this.formId);
        if (form) {
            form.removeAttribute('onsubmit');

            // 在快速访问模式下，隐藏整个表单区域，只显示数据表格
            if (this.isQuickAccess) {
                form.style.display = 'none';
                console.log(`✅ 快速访问模式：${this.moduleName} 表单已隐藏，仅显示数据表格`);
                // ✅ 访客模式同样需要创建筛选控件和分页容器
                this.updateFormStructure();
            } else {
                form.addEventListener('submit', (e) => this.handleSubmit(e), { signal });
                this.updateFormStructure();
                this.setDefaultTestDate();

                if (this.moduleName === 'oil') {
                    this.initOilQualityAutoUpdate();
                }
            }
        }

        document.getElementById(this.tableId)?.addEventListener('click', async (e) => {
            const deleteBtn = e.target.closest('.btn-delete');
            if (deleteBtn) {
                // P1-06: 按钮点击层权限前置拦截（视觉层隐藏不可信）
                if (!permissionService.hasPermission('records:delete')) {
                  UINotification.error('权限不足：您没有删除记录的权限');
                  return;
                }
                // P1-2: operationGuard.verify 已异步化，需 await
                await operationGuard.verify('删除检测记录', () => {
                    this.handleDeleteRecord(deleteBtn.dataset.id);
                });
                return;
            }

            const editBtn = e.target.closest('.btn-edit');
            if (editBtn) {
                // P1-2: await 异步确认（编辑操作无确认弹窗，行为不变）
                await operationGuard.verify('编辑/整改记录', (user) => {
                    this.handleEditRecord(editBtn.dataset.id, user);
                });
                return;
            }

            const detailBtn = e.target.closest('.btn-detail');
            if (detailBtn) {
                this.showDetailModal(detailBtn.dataset.id);
                return;
            }
        }, { signal });

        document.getElementById(`btnAdd${this.moduleName}Point`)?.addEventListener('click', () => {
            this.addTestPoint();
        }, { signal });

        this.setupPaginationListeners();
        this.render();

        // 数据从服务器同步完成后重新渲染表格
        // TD-EventLeak: 跟踪 sync 处理器，重新 init 时先 off 移除旧处理器，避免重复绑定
        if (this._syncHandler) {
            this.storage.off('sync', this._syncHandler);
        }
        this._syncHandler = () => this.render();
        this.storage.on('sync', this._syncHandler);
    }

    // TD-CanteenFromConfig: 食堂筛选下拉按学校管理控制台配置动态生成；只在第一次调用时生成
    // （dataset.rendered 标记），保留用户当前选择。
    renderCanteenFilterOptions(sel) {
        if (!sel || sel.dataset.rendered === '1') return;
        const configured = getSchoolCanteens(extractSchoolCode(), ['一食堂', '二食堂', '三食堂']);
        const seen = new Set();
        const optsHtml = ['<option value="all">全部</option>'];
        configured.forEach(c => {
            const v = String(c || '').trim();
            if (v && !seen.has(v)) { seen.add(v); optsHtml.push(`<option value="${v}">${v}</option>`); }
        });
        sel.innerHTML = optsHtml.join('');
        sel.dataset.rendered = '1';
    }

    setupPaginationListeners() {
        const container = document.getElementById(`${this.moduleName}_pagination`);
        if (!container || container.dataset.listenersAttached === 'true') return;

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

        if (this.moduleName === 'leanMeat') {
            const meatTypeCheckboxes = document.querySelectorAll(`input[name="${this.moduleName}_meatTypeFilter"]`);
            meatTypeCheckboxes.forEach(checkbox => {
                if (!checkbox.dataset.listenerAttached) {
                    checkbox.addEventListener('change', () => {
                        this.selectedMeatTypes = Array.from(meatTypeCheckboxes)
                            .filter(cb => cb.checked)
                            .map(cb => cb.value);
                        this.currentPage = 1;
                        this.render();
                    });
                    checkbox.dataset.listenerAttached = 'true';
                }
            });
        }

        const canteenFilterSelect = document.getElementById(`${this.moduleName}_canteenFilter`);
        // TD-CanteenFromConfig: 从学校管理控制台保存的 customization 动态生成 option
        this.renderCanteenFilterOptions(canteenFilterSelect);
        if (canteenFilterSelect && !canteenFilterSelect.dataset.listenerAttached) {
            canteenFilterSelect.addEventListener('change', (e) => {
                this.selectedCanteenFilter = e.target.value;
                this.currentPage = 1;
                this.render();
            });
            canteenFilterSelect.dataset.listenerAttached = 'true';
        }

        const perPageSelect = document.getElementById(`${this.moduleName}_recordsPerPage`);
        if (perPageSelect && !perPageSelect.dataset.listenerAttached) {
            perPageSelect.addEventListener('change', (e) => {
                this.recordsPerPage = parseInt(e.target.value);
                this.currentPage = 1;
                this.render();
            });
            perPageSelect.dataset.listenerAttached = 'true';
        }

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

        container.dataset.listenersAttached = 'true';
    }

    getFilteredRecords() {
        // ✨ 快速访问模式：直接从localStorage读取，绕过StorageService缓存
        let allRecords;
        const isQuickAccess = new URLSearchParams(window.location.search).get('quickAccess') === 'true';
        
        if (isQuickAccess) {
            try {
                const cacheKey = `cache_${this.moduleName}`;
                const cacheData = localStorage.getItem(cacheKey);
                allRecords = cacheData ? JSON.parse(cacheData).data || [] : [];
                console.log(`📖 快速访问模式: ${this.moduleName} 从localStorage读取`, allRecords.length, '条记录');
            } catch (e) {
                console.error('❌ 读取缓存失败:', e);
                allRecords = this.storage.getAll();
            }
        } else {
            allRecords = this.storage.getAll();
        }
        
        let filteredRecords = allRecords;

        if (this.selectedCanteenFilter !== 'all') {
            filteredRecords = filteredRecords.filter(record => this.getRecordCanteen(record) === this.selectedCanteenFilter);
        }

        if (this.moduleName === 'leanMeat' && this.selectedMeatTypes.length > 0) {
            filteredRecords = filteredRecords.filter(record => this.selectedMeatTypes.includes(record.meatType));
        }

        return filteredRecords;
    }

    getRecordCanteen(record) {
        if (!record || typeof record !== 'object') return '';
        // ⚠️ 不再回退 record.location：location 是检测点位而非食堂名称，避免误显示
        return (
            record.canteen ||
            record.canteenName ||
            record.diningHall ||
            ''
        ).toString().trim();
    }

    getRecordDate(record) {
        if (!record || typeof record !== 'object') return null;
        // 优先使用用户填写的检测日期 testDate，避免 timestamp（入库时间）干扰排序
        const raw = record.testDate || record.timestamp;
        if (!raw) return null;
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

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

    async handleDeleteRecord(recordId) {
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
            const success = this.storage.delete(recordId);
            if (success) {
                UINotification.success('✅ 删除成功');
                this.render();
                document.dispatchEvent(new Event('dataChanged'));
            } else {
                UINotification.error('❌ 删除失败，请重试');
            }
        } catch (error) {
            UINotification.error('❌ 删除出错: ' + error.message);
        }
    }

    handleEditRecord(recordId, currentUser) {
        const records = this.storage.getAll();
        const record = records.find(r => String(r.id) === String(recordId));

        if (!record) {
            UINotification.error('❌ 未找到该记录，可能已被删除');
            this.render();
            return;
        }

        this.showEditModal(record, currentUser);
    }

    showEditModal(record, currentUser) {
        document.getElementById('editModal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'editModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';

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
                    ${rec.recheckInspector ? `<div class="text-gray-500 mb-1"><i class="fas fa-user mr-1"></i>复检人：${escapeHtml(rec.recheckInspector)}</div>` : ''}
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
                    <div class="flex border-b mb-4">
                        <button class="px-4 py-2 border-b-2 border-blue-500 text-blue-600 font-medium" id="tabBtnCorrective">整改措施记录</button>
                        <button class="px-4 py-2 text-gray-500 hover:text-blue-500" id="tabBtnRecheck">复检录入</button>
                    </div>

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

                    <div id="tabRecheck" class="hidden">
                        <div class="flex flex-col md:flex-row gap-4">
                            <div class="flex-1">
                                <div class="bg-yellow-50 border border-yellow-200 p-3 rounded mb-4 text-sm text-yellow-800">
                                    <i class="fas fa-info-circle mr-1"></i> 新录入的复检数据
                                </div>
                                <!-- TD-RecheckInspector: 默认值=原检验员（record.inspector），允许用户改写为实际复检人 -->
                                <div class="mb-4">
                                    <label class="block text-sm font-medium text-gray-700 mb-2">
                                        复检人员 <span class="text-gray-400 text-xs font-normal">(默认与首次录入一致)</span>
                                    </label>
                                    <input id="recheckInspector" type="text"
                                        class="w-full border border-gray-300 rounded p-2"
                                        value="${record.inspector || ''}"
                                        placeholder="请输入复检人员姓名">
                                </div>
                                <div class="mb-4">
                                    <label class="block text-sm font-medium text-gray-700 mb-2">复检结果</label>
                                    <select id="recheckResult" class="w-full border border-gray-300 rounded p-2">
                                        <option value="合格" data-is-passed="true">合格</option>
                                        <option value="不合格" data-is-passed="false">不合格</option>
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

        // TD-Q1-Recheck-IDConflict: 弹窗内所有元素查询限定在 modal 范围内，
        // 避免 Tableware 主表单的 id="recheckResult" textarea 抢占 getElementById
        // 导致复检 isPassed 永远为 false（"填合格反馈不合格"根因）。
        const $el = (id) => modal.querySelector(`#${id}`);

        $el('closeEditModal').onclick = () => modal.remove();

        const tabCorrective = $el('tabCorrective');
        const tabRecheck = $el('tabRecheck');
        const btnTabCorrective = $el('tabBtnCorrective');
        const btnTabRecheck = $el('tabBtnRecheck');

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

        $el('btnSaveLog').onclick = () => {
            const content = $el('newCorrectiveAction').value.trim();
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
                $el('auditLogsList').innerHTML = renderLogs(record.modificationLogs);
                this.render();
                document.dispatchEvent(new Event('dataChanged'));
                alert('日志已保存');
            } else {
                alert('保存失败，请检查存储空间');
            }
        };

        $el('btnSaveRecheck').onclick = () => {
            const selectEl = $el('recheckResult');
            // TD-Q1-Recheck-Robust: 优先用 selectedIndex + dataset.isPassed 判定（不受扩展污染
            // select.value 字符串的影响）；回退到 value 字符串。两者都失败时拒绝保存。
            let isPassed = null;
            let displayValue = '';
            if (selectEl && selectEl.selectedIndex >= 0) {
                const opt = selectEl.options[selectEl.selectedIndex];
                if (opt && opt.dataset) {
                    const flag = opt.dataset.isPassed;
                    if (flag === 'true') isPassed = true;
                    else if (flag === 'false') isPassed = false;
                }
                displayValue = selectEl.value || (opt && opt.textContent) || '';
            }
            if (isPassed === null) {
                isPassed = displayValue === '合格';
            }
            const description = $el('recheckDescription').value.trim();

            // TD-RecheckInspector: 用户未填时回退到原检验员（record.inspector），避免留空
            const recheckInspector = ($el('recheckInspector').value || '').trim() || (record.inspector || '');

            console.log('[复检诊断] isPassed=', isPassed, '| value=', JSON.stringify(displayValue),
                '| selectedIndex=', selectEl ? selectEl.selectedIndex : -1,
                '| recheckInspector=', JSON.stringify(recheckInspector));

            if (!description) {
                alert('请输入复检说明');
                return;
            }

            const newRecheck = {
                time: new Date().toLocaleString(),
                user: currentUser,
                isPassed: isPassed,
                description: description,
                recheckInspector: recheckInspector
            };

            record.recheckRecords = record.recheckRecords || [];
            record.recheckRecords.unshift(newRecheck);

            // TD-Q1-Recheck: 复检"合格/不合格"双向都同步 result，避免后续操作依赖
            // 列表/统计的 result 与最新一次复检结论不一致（"填合格反馈不合格"）。
            // 失败时 result 仍按用户当前选择落库，确保 UI 与服务器最终一致。
            record.result = newRecheck.isPassed ? '合格' : '不合格';

            const success = this.storage.update(record.id, record);

            if (success) {
                // TD-Q1-Recheck-UI: 不再依赖闭包 record（可能是 getAll() 返回的副本，
                // 更新期间引用可能变化导致 recheckRecords 看似为空）；统一从 storage
                // 重新拉取最新缓存，确保弹窗与列表/服务端一致。
                const fresh = this.storage.getAll().find(r => String(r.id) === String(record.id)) || record;
                $el('recheckHistoryList').innerHTML = renderRecheckHistory(fresh.recheckRecords);
                $el('recheckDescription').value = '';
                this.render();
                document.dispatchEvent(new Event('dataChanged'));
                alert('复检结果已保存');
            } else {
                alert('保存失败，请检查存储空间');
            }
        };

        // TD-Q1-Recheck-PUT-Fail: 监听 Storage 错误事件，PUT 上传失败（如 409 永久耗尽）
        // 时主动刷新弹窗历史并提示用户，让 UI 与服务器保持一致，避免"本地显示合格
        // 刷新后变不合格"的乐观更新幻觉。
        const onStorageError = (evt) => {
            if (!evt || !evt.request) return;
            if (evt.request.type !== 'update') return;
            if (String(evt.request.recordId) !== String(record.id)) return;
            const fresh = this.storage.getAll().find(r => String(r.id) === String(record.id));
            if (!fresh) return;
            // 同步弹窗历史与最新缓存
            const historyEl = $el('recheckHistoryList');
            if (historyEl) historyEl.innerHTML = renderRecheckHistory(fresh.recheckRecords);
            this.render();
            // 弹窗存在时提示用户（避免与正在显示的 alert 冲突）
            if (document.getElementById('editModal')) {
                UINotification.error('复检上传失败：' + (evt.error?.message || '版本冲突，请稍后重试') +
                    '。已刷新至最新状态，请重试。');
            }
        };
        this.storage.on('error', onStorageError);
        // 关闭弹窗时移除监听，避免内存泄漏
        $el('closeEditModal').onclick = () => {
            this.storage.off('error', onStorageError);
            modal.remove();
        };
    }

    showDetailModal(recordId) {
        const records = this.storage.getAll();
        const record = records.find(r => String(r.id) === String(recordId));

        if (!record) {
            alert('未找到该记录');
            return;
        }

        document.getElementById('detailModal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'detailModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';

        // TD-RecheckBadge: 检测详情弹窗中，最近一次复检为合格 → "复检合格"（蓝底描边）
        const latestRecheck = Array.isArray(record.recheckRecords) && record.recheckRecords.length > 0 ? record.recheckRecords[0] : null;
        const isRecheckPassed = !!(latestRecheck && latestRecheck.isPassed === true);
        const recheckBadgeText = isRecheckPassed ? '复检合格' : null;
        const recheckBadgeClass = isRecheckPassed
            ? 'bg-blue-50 text-blue-700 border border-blue-300'
            : null;
        const resultBadge = (text, colorClass) =>
            `<span class="px-2 py-1 rounded ${colorClass}">${escapeHtml(text)}</span>`;
        const standardBadgeClass = (val, okVal, warnVal) =>
            val === okVal ? 'bg-green-100 text-green-800'
            : val === warnVal ? 'bg-yellow-100 text-yellow-800'
            : 'bg-red-100 text-red-800';

        let detailContent = '';
        if (this.moduleName === 'pesticide') {
            const displayResult = recheckBadgeText || record.result || '';
            const badgeClass = recheckBadgeClass || standardBadgeClass(record.result, '合格');
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">蔬菜品种：</span>${record.vegetableType}</div>
                    <div><span class="font-medium">检测项目：</span>${record.batchNo}</div>
                    <div><span class="font-medium">检测结果：</span>${resultBadge(displayResult, badgeClass)}</div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${escapeHtml(record.remark)}</div>` : ''}
                </div>
            `;
        } else if (this.moduleName === 'oil') {
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">油温：</span>${record.oilTemp}℃</div>
                    <div><span class="font-medium">预估氧化值(TPM)：</span>${record.tpmValue} g/100g</div>
                    <div><span class="font-medium">预估酸价值：</span>${record.acidValue || '-'} mg/g</div>
                    <div><span class="font-medium">食用油品质等级：</span><span class="px-2 py-1 rounded ${standardBadgeClass(record.colorLevel, '合格', '警戒')}">${record.colorLevel}</span></div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${escapeHtml(record.remark)}</div>` : ''}
                </div>
            `;
        } else if (this.moduleName === 'leanMeat') {
            const displayResult = recheckBadgeText || record.result || '';
            const badgeClass = recheckBadgeClass || standardBadgeClass(record.result, '合格');
            detailContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><span class="font-medium">检测日期：</span>${record.testDate}</div>
                    <div><span class="font-medium">食堂：</span>${record.canteen}</div>
                    <div><span class="font-medium">检测员：</span>${record.inspector}</div>
                    <div><span class="font-medium">肉类品种：</span>${record.meatType}</div>
                    <div><span class="font-medium">检测项目：</span>${record.batchNo}</div>
                    <div><span class="font-medium">检测结果：</span>${resultBadge(displayResult, badgeClass)}</div>
                    ${record.remark ? `<div class="col-span-2"><span class="font-medium">备注：</span>${escapeHtml(record.remark)}</div>` : ''}
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
                                    ${rec.recheckInspector ? `复检人：${escapeHtml(rec.recheckInspector)} | ` : ''}
                                    ${rec.time} - ${escapeHtml(rec.description || '')}
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

    // ======== 油品双比色逻辑 ========

    initOilQualityAutoUpdate() {
        const oxidationSelect = document.getElementById('oilColor') || document.querySelector('select[name="tpmValue"]');
        if (oxidationSelect) {
            oxidationSelect.removeAttribute('onchange');
            oxidationSelect.addEventListener('change', () => this.updateOilQuality(oxidationSelect));
            this.updateOilQuality(oxidationSelect);
        }

        const acidSelect = document.getElementById('acidValue') || document.querySelector('select[name="acidValue"]');
        if (acidSelect) {
            acidSelect.removeAttribute('onchange');
            acidSelect.addEventListener('change', () => this.updateAcidQuality(acidSelect));
            this.updateAcidQuality(acidSelect);
        }
    }

    getAcidLevel(acidValue) {
        const v = parseFloat(acidValue);
        if (isNaN(v)) return '';
        if (v < 2.5) return '合格';
        if (v < 5.0) return '警戒'; 
        return '不合格';
    }


    getTpmLevel(tpmValue) {
        const v = parseFloat(tpmValue);
        if (isNaN(v)) return '';
        if (v <= 0.13) return '合格';
        if (v <= 0.25) return '警戒';
        return '不合格';
    }

    getWorstLevel(levelA, levelB) {
        const rank = { '合格': 1, '警戒': 2, '不合格': 3 };
        const a = rank[levelA] || 0;
        const b = rank[levelB] || 0;
        return a >= b ? levelA : levelB;
    }

    // 统一重算：任一异常即异常
    recomputeOilFinalQuality(container) {
        if (!container) return;
        const qualityInput = container.querySelector('input[name="colorLevel"], input[name="colorLevel[]"]');
        if (!qualityInput) return;

        const tpmSelect = container.querySelector('select[name="tpmValue"], select[name="tpmValue[]"]');
        const acidSelect = container.querySelector('select[name="acidValue"], select[name="acidValue[]"]');

        const tpmLevel = tpmSelect ? this.getTpmLevel(tpmSelect.value) : '';
        const acidLevel = acidSelect ? this.getAcidLevel(acidSelect.value) : '';
        const finalLevel = (tpmLevel && acidLevel) ? this.getWorstLevel(tpmLevel, acidLevel) : (tpmLevel || acidLevel || '');

        qualityInput.value = finalLevel;
        qualityInput.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm ' +
            (finalLevel === '合格' ? 'bg-green-50 text-green-700' :
             finalLevel === '警戒' ? 'bg-yellow-50 text-yellow-700' :
             finalLevel === '不合格' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-500');
    }

    updateOilQuality(colorSelect) {
        const container = colorSelect.closest('.grid');
        if (!container) return;

        const tpmReference = container.querySelector('.text-xs span');
        const tpmValue = parseFloat(colorSelect.value);

        if (tpmReference) {
            tpmReference.textContent = isNaN(tpmValue) ? '-' : `${tpmValue.toFixed(2)} g/100g`;
        }

        this.recomputeOilFinalQuality(container);
    }

    updateAcidQuality(acidSelect) {
        const container = acidSelect.closest('.grid');
        if (!container) return;

        const acidReference = container.querySelector('.acid-reference span');
        const acidValue = parseFloat(acidSelect.value);

        if (acidReference) {
            acidReference.textContent = isNaN(acidValue) ? '-' : `${acidValue.toFixed(1)} mg/g`;
        }

        this.recomputeOilFinalQuality(container);
    }

    addOilAcidFields(container) {
        if (!container) return;
        if (container.querySelector('.acid-field-group')) return;

        const qualityLabel = container.querySelector('input[name="colorLevel"]')?.closest('div')?.querySelector('label')
            || container.querySelector('input[name="colorLevel[]"]')?.closest('div')?.querySelector('label');
        const qualityWrap = container.querySelector('input[name="colorLevel"]')?.closest('div')
            || container.querySelector('input[name="colorLevel[]"]')?.closest('div');

        if (qualityLabel) qualityLabel.textContent = '食用油品质等级 *';
        if (qualityWrap) qualityWrap.classList.add('col-span-3');

        const acidWrap = document.createElement('div');
        acidWrap.className = 'acid-field-group';
        acidWrap.innerHTML = `
            <label class="block text-sm font-medium text-gray-700 mb-1">酸价值检测卡显色 *</label>
            <select name="acidValue" id="acidValue" class="w-full border border-gray-300 p-2 rounded-md shadow-sm">
                <option value="">请选择</option>
                <option value="0">深绿色</option>
                <option value="0.3">绿色</option>
                <option value="0.5">浅绿色</option>
                <option value="1.5">黄绿色</option>
                <option value="2.5">浅黄色</option>
                <option value="3.0">黄色</option>
                <option value="5.0">深黄色</option>
            </select>
            <div class="text-xs text-gray-500 mt-1 acid-reference">预估酸价值: <span>-</span></div>
        `;

        const tpmWrap = container.querySelector('select[name="tpmValue"]')?.closest('div')
            || container.querySelector('select[name="tpmValue[]"]')?.closest('div');

        if (tpmWrap && tpmWrap.parentNode) {
            tpmWrap.parentNode.insertBefore(acidWrap, tpmWrap.nextSibling);
        } else {
            container.appendChild(acidWrap);
        }

        const acidSelect = acidWrap.querySelector('select[name="acidValue"]');
        if (acidSelect) {
            acidSelect.addEventListener('change', () => this.updateAcidQuality(acidSelect));
        }
    }

    updateFormStructure() {
        const form = document.getElementById(this.formId);
        if (!form) return;

        const dataSection = form.querySelector('.grid-cols-2') || form.querySelector('.grid:nth-child(2)');

        if (dataSection && !dataSection.previousElementSibling?.classList.contains('test-info-header')) {
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

            if (this.moduleName === 'oil') {
                this.addOilAcidFields(dataSection);

                const labels = dataSection.querySelectorAll('label');
                labels.forEach(lb => {
                    if ((lb.textContent || '').includes('油品颜色')) {
                        lb.innerHTML = lb.innerHTML.replace('油品颜色', '氧化值检测卡显色');
                    }
                });
            }

            const submitBtnContainer = form.querySelector('button[type="submit"]')?.closest('div');
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

        const tbody = document.getElementById(this.tableId);
        if (tbody) {
            const tableElement = tbody.closest('table');

            if (tableElement) {
                if (!document.getElementById(`${this.moduleName}_header_controls`)) {
                    const headerControls = document.createElement('div');
                    headerControls.id = `${this.moduleName}_header_controls`;
                    headerControls.className = 'flex flex-col md:flex-row justify-between items-start md:items-center mt-8 mb-3';

                    let filterHTML = '';

                    if (this.moduleName === 'leanMeat') {
                        filterHTML = `
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">品种:</label>
                                <div class="flex flex-wrap gap-2 bg-gray-50 border border-gray-300 rounded px-3 py-2">
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="猪肉" class="mr-1">猪肉</label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="牛肉" class="mr-1">牛肉</label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="羊肉" class="mr-1">羊肉</label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="禽肉" class="mr-1">禽肉</label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="鱼肉" class="mr-1">鱼肉</label>
                                    <label class="flex items-center text-sm cursor-pointer hover:bg-gray-100 px-2 py-1 rounded"><input type="checkbox" name="${this.moduleName}_meatTypeFilter" value="禽蛋" class="mr-1">禽蛋</label>
                                </div>
                            </div>
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">食堂:</label>
                                <!-- TD-CanteenFromConfig: option 不再硬编码；由 renderGenericCanteenFilter() 从学校配置动态生成 -->
                                <select id="${this.moduleName}_canteenFilter" class="border border-gray-300 rounded px-3 py-1 text-sm" data-source="configurable">
                                    <option value="all">全部</option>
                                </select>
                            </div>
                        `;
                    } else {
                        filterHTML = `
                            <div class="flex items-center">
                                <label class="text-sm text-gray-600 mr-2">食堂:</label>
                                <!-- TD-CanteenFromConfig: 同上 -->
                                <select id="${this.moduleName}_canteenFilter" class="border border-gray-300 rounded px-3 py-1 text-sm" data-source="configurable">
                                    <option value="all">全部</option>
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
                    tableElement.parentNode.insertBefore(headerControls, tableElement);
                }

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
                    tableElement.parentNode.insertBefore(paginationContainer, tableElement.nextSibling);
                }
            }
        }
    }

    setDefaultTestDate() {
        const form = document.getElementById(this.formId);
        if (!form) return;
        const dateInput = form.querySelector('input[name="testDate"]');
        if (dateInput && !dateInput.value) {
            dateInput.value = getLocalDateStr();
        }
    }

    getRecordDate(record) {
        if (!record || typeof record !== 'object') return null;
        const raw = record.testDate || record.timestamp;
        if (!raw) return null;
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    addRemarkField(container) {
        if (!container) return;
        if (container.querySelector('.remark-field')) return;

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

        const remarkField = document.createElement('div');
        remarkField.className = 'col-span-3 remark-field';
        remarkField.innerHTML = `
            <label class="block text-sm font-medium text-gray-700 mb-1">${remarkLabel}</label>
            <textarea name="remark" rows="3" class="w-full border border-gray-300 p-2 rounded-md shadow-sm"
                placeholder="${remarkPlaceholder}"></textarea>
        `;

        container.appendChild(remarkField);
    }

    addTestPoint() {
        const pointsContainer = document.getElementById(`${this.moduleName}PointsContainer`);
        if (!pointsContainer) return;

        const originalSection = document.getElementById(`${this.moduleName}DataSection`);
        if (!originalSection) return;

        const pointWrapper = document.createElement('div');
        pointWrapper.className = 'relative';

        const newSection = originalSection.cloneNode(true);
        newSection.id = '';

        pointWrapper.appendChild(newSection);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'absolute -right-2 -top-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center shadow hover:bg-red-600 transition z-10';
        deleteBtn.innerHTML = '<i class="fas fa-times"></i>';
        deleteBtn.title = '删除此检测点位';
        deleteBtn.onclick = function() {
            this.closest('.space-y-4 > div.relative')?.remove();
        };

        pointWrapper.appendChild(deleteBtn);

        const inputs = newSection.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
            if (input.type !== 'radio' && input.type !== 'checkbox') {
                input.value = '';
            } else {
                input.checked = false;
            }

            if (input.name && !input.name.endsWith('[]')) {
                input.name = input.name + '[]';
            }
        });

        // Q4: 若学校定制了该模块 batchNo(检测项目)的 options,则覆盖克隆出的静态选项,
        // 让"界面定制-新增检测项目"在学校端录入表单中显示;无定制时回退静态默认(向后兼容)。
        // P2-定制修复：内置字段 batchNo 的定制选项实际存于 field_options（顶层或 theme_config.field_options），
        // 而非 custom_fields（仅含自定义字段）。此处两种来源都读取，解决"新增检测项目后录入端无显示"。
        try {
            const customization = getSchoolCustomization(extractSchoolCode());
            let batchOptions = null;
            if (customization) {
                // 1) field_options 来源（内置字段 batchNo 定制选项）
                const parseFO = (src) => {
                    if (!src || typeof src !== 'object') return null;
                    // FIX-11: 用 in 判断键是否存在，区分「未配置」(null，回退默认) 与「显式清空」([]，覆盖默认)。
                    // 原实现 `list.length ? list : null` 把空数组当未配置，导致删光选项后录入端仍回退硬编码默认项。
                    if (!('batchNo' in src) && !('testType' in src)) return null;
                    const list = src.batchNo ?? src.testType;
                    return Array.isArray(list) ? list : null;
                };
                batchOptions = parseFO(customization.field_options);
                if (!batchOptions) {
                    const themeCfg = (typeof customization.theme_config === 'string')
                        ? (() => { try { return JSON.parse(customization.theme_config) } catch { return null } })()
                        : customization.theme_config;
                    if (themeCfg && typeof themeCfg === 'object') batchOptions = parseFO(themeCfg.field_options);
                }
                // 2) custom_fields 来源（兼容旧版/自定义字段误配）
                if (!batchOptions) {
                    const moduleCustom = (customization.custom_fields && customization.custom_fields[this.moduleName]) || [];
                    const batchNoCfg = Array.isArray(moduleCustom) ? moduleCustom.find(f => f.name === 'batchNo' || f.name === 'testType') : null;
                    if (batchNoCfg && Array.isArray(batchNoCfg.options) && batchNoCfg.options.length) {
                        batchOptions = batchNoCfg.options;
                    }
                }
            }
            if (Array.isArray(batchOptions)) {
                const batchSelect = newSection.querySelector('select[name="batchNo[]"], select[name="batchNo"]');
                if (batchSelect) {
                    batchSelect.innerHTML = '';
                    if (batchOptions.length > 0) {
                        batchOptions.forEach(opt => {
                            const o = document.createElement('option');
                            o.value = String(opt);
                            o.textContent = String(opt);
                            batchSelect.appendChild(o);
                        });
                    } else {
                        // FIX-11: 显式清空时覆盖默认项，渲染占位选项（"请选择"），而非回退硬编码默认列表
                        const o = document.createElement('option');
                        o.value = '';
                        o.textContent = '请选择';
                        batchSelect.appendChild(o);
                    }
                }
            }
        } catch (e) {
            console.warn('Q4: 应用检测项目自定义选项失败:', e.message);
        }

        if (this.moduleName === 'oil') {
            const colorSelect = newSection.querySelector('select[name="tpmValue[]"]');
            if (colorSelect) {
                colorSelect.removeAttribute('onchange');
                colorSelect.addEventListener('change', () => this.updateOilQuality(colorSelect));
                this.updateOilQuality(colorSelect);
            }

            const acidSelect = newSection.querySelector('select[name="acidValue[]"]');
            if (acidSelect) {
                acidSelect.removeAttribute('onchange');
                acidSelect.addEventListener('change', () => this.updateAcidQuality(acidSelect));
                this.updateAcidQuality(acidSelect);
            }
        }

        pointsContainer.appendChild(pointWrapper);
    }

    handleSubmit(e) {
        e.preventDefault();
        // FIX-15: viewer/guest 越权新增检测记录拦截（事件处理层纵深防御）。
        // 视觉层隐藏"新增"入口不可信，这里在提交前再次校验 records:create 权限。
        if (!permissionService.hasPermission('records:create')) {
            UINotification.error('权限不足：您没有创建检测记录的权限');
            return;
        }
        const formData = new FormData(e.target);

        const baseInfo = {
            testDate: formData.get('testDate'),
            canteen: formData.get('canteen'),
            inspector: formData.get('inspector'),
            // 层级A：学校自定义字段（整单级，随每条点位记录一并存入 result_data）
        };
        try {
            // TD-CascadeFieldOption: 传 schoolCode 才会读到本校 customization（hidden_fields 等）。
            const customFields = collectCustomFieldValues(e.target, getSchoolCustomization(extractSchoolCode()))
            Object.assign(baseInfo, customFields)
        } catch (err) {
            console.warn('⚠️ 自定义字段收集失败，继续提交基础字段:', err.message)
        }

        // 验证基础信息
        const baseValidationSchema = {
            testDate: ['required', 'dateNotFuture'],
            canteen: ['required'],
            inspector: ['required']
        };

        const baseErrors = FormValidator.validate(baseInfo, baseValidationSchema);
        if (baseErrors) {
            FormValidator.showErrors(e.target, baseErrors);
            UINotification.warning('⚠️ 请填写完整的基础信息');
            return;
        }

        const pointsContainer = document.getElementById(`${this.moduleName}PointsContainer`);
        if (!pointsContainer) {
            UINotification.error('❌ 未找到检测点位容器');
            return;
        }

        const allPoints = pointsContainer.querySelectorAll('.grid');
        if (allPoints.length === 0) {
            UINotification.warning('⚠️ 请至少添加一个检测点位');
            return;
        }

        let savedCount = 0;
        let skippedCount = 0;

        allPoints.forEach((point, index) => {
            const pointData = { ...baseInfo };

            try {
                if (this.moduleName === 'pesticide') {
                    const vegetableType = point.querySelector('input[name="vegetableType"], input[name="vegetableType[]"]')?.value;
                    const batchNo = point.querySelector('select[name="batchNo"], select[name="batchNo[]"]')?.value;
                    const result = point.querySelector('select[name="result"], select[name="result[]"]')?.value;
                    const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;

                    if (!vegetableType || !batchNo || !result) {
                        console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                        skippedCount++;
                        return;
                    }

                    pointData.vegetableType = vegetableType;
                    pointData.batchNo = batchNo;
                    pointData.result = result;
                    pointData.remark = remark || '';
                } else if (this.moduleName === 'oil') {
                    const oilTemp = point.querySelector('input[name="oilTemp"], input[name="oilTemp[]"]')?.value;
                    const tpmValue = point.querySelector('select[name="tpmValue"], select[name="tpmValue[]"]')?.value;
                    const acidValue = point.querySelector('select[name="acidValue"], select[name="acidValue[]"]')?.value;
                    const colorLevel = point.querySelector('input[name="colorLevel"], input[name="colorLevel[]"]')?.value;
                    const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;

                    if (!oilTemp || !tpmValue || !acidValue || !colorLevel) {
                        console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                        skippedCount++;
                        return;
                    }

                    pointData.oilTemp = oilTemp;
                    pointData.tpmValue = tpmValue;
                    pointData.acidValue = acidValue;
                    pointData.colorLevel = colorLevel;
                    pointData.remark = remark || '';
                } else if (this.moduleName === 'leanMeat') {
                    const meatType = point.querySelector('select[name="meatType"], select[name="meatType[]"]')?.value;
                    const batchNo = point.querySelector('select[name="batchNo"], select[name="batchNo[]"]')?.value;
                    const result = point.querySelector('select[name="result"], select[name="result[]"]')?.value;
                    const remark = point.querySelector('textarea[name="remark"], textarea[name="remark[]"]')?.value;

                    if (!meatType || !batchNo || !result) {
                        console.warn(`检测点位 ${index + 1} 数据不完整，跳过`);
                        skippedCount++;
                        return;
                    }

                    pointData.meatType = meatType;
                    pointData.batchNo = batchNo;
                    pointData.result = result;
                    pointData.remark = remark || '';
                }

                const success = this.storage.save(pointData);
                if (success) savedCount++;
            } catch (error) {
                console.error(`保存点位 ${index + 1} 出错:`, error);
                skippedCount++;
            }
        });

        // 结果提示
        if (savedCount > 0) {
            let message = `✅ 成功保存 ${savedCount} 条检测记录`;
            if (skippedCount > 0) {
                message += `，${skippedCount} 条数据不完整被跳过`;
            }
            UINotification.success(message);
            
            e.target.reset();
            FormValidator.clearErrors(e.target);
            this.setDefaultTestDate();

            const firstPoint = pointsContainer.children[0];
            pointsContainer.innerHTML = '';
            pointsContainer.appendChild(firstPoint);

            if (this.moduleName === 'oil') {
                const colorSelect = firstPoint.querySelector('select[name="tpmValue"]');
                if (colorSelect) this.updateOilQuality(colorSelect);

                const acidSelect = firstPoint.querySelector('select[name="acidValue"]');
                if (acidSelect) this.updateAcidQuality(acidSelect);
            }

            this.render();
            document.dispatchEvent(new Event('dataChanged'));
        } else {
            UINotification.error('❌ 保存失败，请检查数据完整性');
        }
    }

    render() {
        const tbody = document.getElementById(this.tableId);
        if (!tbody) return;

        // P1-06: viewer 等只读角色在列表"操作"栏仅保留查看，隐藏编辑/删除入口（视觉层收敛）
        const canUpdate = permissionService.hasPermission('records:update');
        const canDelete = permissionService.hasPermission('records:delete');

        const filteredRecords = this.getFilteredRecords();

        const sortedRecords = [...filteredRecords].sort((a, b) => {
            const dateA = this.getRecordDate(a) || new Date('1970-01-01');
            const dateB = this.getRecordDate(b) || new Date('1970-01-01');
            return this.sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        });

        const totalRecords = sortedRecords.length;
        const totalPages = Math.max(1, Math.ceil(totalRecords / this.recordsPerPage));
        this.currentPage = Math.max(1, Math.min(this.currentPage, totalPages));

        const startIndex = (this.currentPage - 1) * this.recordsPerPage;
        const currentRecords = sortedRecords.slice(startIndex, startIndex + this.recordsPerPage);

        this.updatePaginationUI(startIndex, Math.min(startIndex + this.recordsPerPage, totalRecords), totalRecords, totalPages);

        if (currentRecords.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-gray-500">暂无数据</td></tr>`;
            return;
        }

        tbody.innerHTML = currentRecords.map(r => {
            const result = r.result || r.colorLevel || '未知';
            // TD-RecheckBadge: 最近一次复检为合格 → "复检合格"（蓝底描边），区别于首次检验合格的纯绿
            const latestRecheck = Array.isArray(r.recheckRecords) && r.recheckRecords.length > 0 ? r.recheckRecords[0] : null;
            const isRecheckPassed = !!(latestRecheck && latestRecheck.isPassed === true);
            const displayResult = isRecheckPassed ? '复检合格' : result;
            // P2-24: 列表颜色改为三元判定（合格绿/警戒黄/不合格红），与详情弹窗 showDetailModal 一致
            const resultColorClass = isRecheckPassed
                ? 'bg-blue-50 text-blue-700 border border-blue-300'
                : result === '合格' ? 'bg-green-100 text-green-800'
                : result === '警戒' ? 'bg-yellow-100 text-yellow-800'
                : 'bg-red-100 text-red-800';

            const remarkInfo = r.remark
                ? `<div class="text-xs text-gray-500 mt-1" title="${r.remark}">备注: ${r.remark.length > 15 ? r.remark.substring(0, 15) + '...' : r.remark}</div>`
                : '';

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
                    <td class="border px-4 py-2">AV: ${r.acidValue || '-'}</td>
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
                    <span class="px-2 py-1 rounded-full text-xs cursor-pointer btn-detail ${resultColorClass}" data-id="${r.id}">
                        ${displayResult}
                    </span>
                    ${remarkInfo}
                </td>
                <td class="border px-4 py-2">${r.inspector || '-'}</td>
                <td class="border px-4 py-2">
                    <div class="flex gap-2 justify-center">
                        ${canUpdate ? `<button class="text-blue-600 hover:text-blue-800 btn-edit" data-id="${r.id}" title="整改/复检"><i class="fas fa-edit"></i></button>` : ''}
                        <button class="text-green-600 hover:text-green-800 btn-detail" data-id="${r.id}" title="查看详情">
                            <i class="fas fa-info-circle"></i>
                        </button>
                        ${canDelete ? `<button class="text-red-600 hover:text-red-800 btn-delete" data-id="${r.id}" title="删除"><i class="fas fa-trash"></i></button>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');
    }
}
