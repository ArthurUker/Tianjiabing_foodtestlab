// 文件路径: js/modules/BackupRestore.js
import { UINotification } from '../utils/UINotification.js';
import { NetworkHelper } from '../utils/NetworkHelper.js';
import { auditLogService } from '../services/AuditLogService.js';

export class BackupRestoreService {
    constructor() {
        this.moduleName = '数据备份与恢复';
        // 定义系统所有需要备份的业务表名
        this.targetTables = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
        // 添加同步状态追踪
        this.syncStatus = {
            inProgress: false,
            lastSync: null,
            serverConnected: null,
            results: {}
        };
    }

    init() {
        this.renderUI();
        this.bindEvents();
        this.startConnectionMonitor();
        // 检查是否有上次恢复后的同步结果
        this.checkPreviousSyncResult();
    }

    startConnectionMonitor() {
        NetworkHelper.watchNetworkStatus(
            () => this.checkSyncStatus({ silent: true }),
            () => {
                this.syncStatus.serverConnected = false;
                this.updateSyncStatusIndicator();
            }
        );

        // 定时刷新连接状态，确保服务器重启后能快速感知。
        setInterval(() => {
            this.checkSyncStatus({ silent: true });
        }, 30000);
    }

    // 检查上次同步结果
    checkPreviousSyncResult() {
        const syncResult = localStorage.getItem('last_sync_result');
        if (syncResult) {
            try {
                const result = JSON.parse(syncResult);
                if (result.timestamp && (Date.now() - result.timestamp < 3600000)) { // 1小时内的结果
                    this.displaySyncResult(result);
                }
                // 清除旧结果
                localStorage.removeItem('last_sync_result');
            } catch (e) {
                console.error('无法解析同步结果', e);
            }
        }
    }

    // 显示同步结果通知
    displaySyncResult(result) {
        const isSuccess = result.success;
        const notificationDiv = document.createElement('div');
        notificationDiv.className = `fixed top-4 right-4 ${isSuccess ? 'bg-green-100 border-green-400 text-green-800' : 'bg-red-100 border-red-400 text-red-800'} px-4 py-3 rounded shadow-lg z-50`;
        
        notificationDiv.innerHTML = `
            <div class="flex items-center">
                <div class="py-1"><i class="fas ${isSuccess ? 'fa-check-circle' : 'fa-exclamation-circle'} mr-2"></i></div>
                <div>
                    <p class="font-bold">${isSuccess ? '同步成功' : '同步失败'}</p>
                    <p class="text-sm">${result.message}</p>
                    <p class="text-xs mt-1">时间：${new Date(result.timestamp).toLocaleString()}</p>
                </div>
                <button class="ml-6 text-gray-500 hover:text-gray-700" id="close-sync-notification">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            ${result.details ? `<div class="mt-2 text-xs border-t pt-2">${result.details}</div>` : ''}
        `;
        
        document.body.appendChild(notificationDiv);
        
        // 自动消失
        setTimeout(() => {
            notificationDiv.remove();
        }, 10000);
        
        document.getElementById('close-sync-notification')?.addEventListener('click', () => {
            notificationDiv.remove();
        });
    }

    renderUI() {
        const content = document.getElementById('backup-restore');
        
        if (!content) {
            console.error('未找到 id="backup-restore" 的容器，请检查 index.html');
            return;
        }

        content.innerHTML = `
            <div class="bg-white rounded-lg shadow-md p-6">
                <h2 class="text-2xl font-bold mb-6 border-b pb-2 text-gray-800">
                    <i class="fas fa-history mr-2 text-blue-600"></i>系统数据备份与恢复
                </h2>

                <!-- 3列布局 -->
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                    
                    <!-- 1. 本地备份卡片 -->
                    <div class="border border-gray-200 rounded-lg p-6 bg-gray-50 hover:shadow-md transition duration-200 flex flex-col">
                        <div class="flex items-center mb-4">
                            <div class="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mr-3">
                                <i class="fas fa-download"></i>
                            </div>
                            <h3 class="text-lg font-bold text-gray-800">本地导出</h3>
                        </div>
                        <p class="text-sm text-gray-600 mb-4 flex-grow">
                            将当前浏览器数据打包为 JSON 文件下载。
                        </p>
                        <button id="btn-backup-download" class="w-full py-2 px-4 bg-blue-600 text-white rounded hover:bg-blue-700 transition font-medium">
                            <i class="fas fa-file-export mr-2"></i>导出到本地
                        </button>
                    </div>

                    <!-- 2. 本地恢复卡片 -->
                    <div class="border border-gray-200 rounded-lg p-6 bg-gray-50 hover:shadow-md transition duration-200 flex flex-col">
                        <div class="flex items-center mb-4">
                            <div class="w-10 h-10 rounded-full bg-yellow-100 text-yellow-600 flex items-center justify-center mr-3">
                                <i class="fas fa-folder-open"></i>
                            </div>
                            <h3 class="text-lg font-bold text-gray-800">本地导入</h3>
                        </div>
                        <p class="text-sm text-gray-600 mb-4 flex-grow">
                            选择本地 JSON 备份文件进行恢复。
                        </p>
                        <div id="restore-drop-zone" class="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:bg-blue-50 transition bg-white">
                            <input type="file" id="file-restore-input" accept=".json" class="hidden">
                            <div class="text-xs text-gray-500">点击或拖拽文件</div>
                        </div>
                    </div>

                    <!-- 3. 云端恢复卡片 -->
                    <div class="border border-purple-200 rounded-lg p-6 bg-purple-50 hover:shadow-md transition duration-200 flex flex-col">
                        <div class="flex items-center mb-4">
                            <div class="w-10 h-10 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center mr-3">
                                <i class="fas fa-cloud-download-alt"></i>
                            </div>
                            <h3 class="text-lg font-bold text-gray-800">云端同步</h3>
                        </div>
                        <p class="text-sm text-gray-600 mb-4 flex-grow">
                            从服务器拉取最新的业务数据。
                        </p>
                        <button id="btn-cloud-restore" class="w-full py-2 px-4 bg-purple-600 text-white rounded hover:bg-purple-700 transition font-medium">
                            <i class="fas fa-sync-alt mr-2"></i>从服务器同步
                        </button>
                    </div>
                </div>

                <!-- 恢复状态提示 -->
                <div id="restore-status" class="mb-6 hidden"></div>

                <!-- 3. 同步状态与控制 -->
                <div class="mt-6 border border-blue-200 rounded-lg p-4 bg-blue-50">
                    <h3 class="text-lg font-semibold text-blue-800 mb-2 flex items-center">
                        <i class="fas fa-sync-alt mr-2"></i>同步状态控制
                    </h3>
                    <div class="flex flex-wrap items-center gap-4">
                        <button id="btn-check-sync" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm transition">
                            <i class="fas fa-server mr-1"></i> 检查同步状态
                        </button>
                        <button id="btn-force-sync" class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-sm transition">
                            <i class="fas fa-cloud-upload-alt mr-1"></i> 强制同步到服务器
                        </button>
                        <button id="btn-pause-sync" class="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-sm transition">
                            <i class="fas fa-pause mr-1"></i> 暂停同步
                        </button>
                        <div class="text-sm text-blue-700 flex items-center ml-auto" id="sync-status-indicator">
                            <span class="inline-block w-3 h-3 rounded-full bg-gray-300 mr-2"></span>
                            同步状态: 未知
                        </div>
                    </div>
                </div>

                <!-- 4. 危险区域 -->
                <div class="mt-8 border border-red-200 rounded-lg p-4 bg-red-50 flex flex-col md:flex-row justify-between items-center gap-4">
                    <div class="text-red-800 text-sm flex items-center">
                        <i class="fas fa-skull-crossbones text-xl mr-3"></i>
                        <div>
                            <strong>危险区域：</strong>
                            清空所有本地缓存数据。
                        </div>
                    </div>
                    <button id="btn-clear-local" class="px-4 py-2 bg-white border border-red-300 text-red-600 rounded hover:bg-red-600 hover:text-white text-sm transition whitespace-nowrap">
                        <i class="fas fa-trash-alt mr-1"></i> 清空本地缓存
                    </button>
                </div>
            </div>
        `;
    }

    bindEvents() {
        const btnDownload = document.getElementById('btn-backup-download');
        if (btnDownload) {
            btnDownload.addEventListener('click', () => this.handleBackup());
        }

        const dropZone = document.getElementById('restore-drop-zone');
        const fileInput = document.getElementById('file-restore-input');

        if (dropZone && fileInput) {
            dropZone.addEventListener('click', () => fileInput.click());
            
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('border-blue-500', 'bg-blue-50');
            });
            dropZone.addEventListener('dragleave', (e) => {
                e.preventDefault();
                dropZone.classList.remove('border-blue-500', 'bg-blue-50');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('border-blue-500', 'bg-blue-50');
                if (e.dataTransfer.files.length) {
                    this.handleFileRestore(e.dataTransfer.files[0]);
                }
            });

            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    this.handleFileRestore(e.target.files[0]);
                }
            });
        }

        // 云端恢复
        document.getElementById('btn-cloud-restore')?.addEventListener('click', () => this.handleCloudRestore());

        // 绑定同步控制按钮
        document.getElementById('btn-check-sync')?.addEventListener('click', () => this.checkSyncStatus());
        document.getElementById('btn-force-sync')?.addEventListener('click', () => this.forceSync());
        document.getElementById('btn-pause-sync')?.addEventListener('click', () => this.pauseSync());

        document.getElementById('btn-clear-local')?.addEventListener('click', async () => {
            const confirmed = await UINotification.confirm(
                '⚠️ 严重警告\n确定要清空本地所有缓存吗？此操作不可逆，所有未同步到服务器的数据将永久丢失！',
                '确认清空'
            );
            
            if (confirmed) {
                try {
                    this.targetTables.forEach(table => localStorage.removeItem(`cache_${table}`));
                    localStorage.removeItem(`pending_requests`);
                    UINotification.success('🗑️ 本地缓存已清空，页面将刷新');
                    setTimeout(() => location.reload(), 1500);
                } catch (error) {
                    UINotification.error('❌ 清空缓存失败: ' + error.message);
                }
            }
        });

        // 初始化同步状态显示
        this.updateSyncStatusIndicator();
    }

    // 更新同步状态指示器
    updateSyncStatusIndicator(extraText = '') {
        const indicator = document.getElementById('sync-status-indicator');
        if (!indicator) return;

        const statusDot = indicator.querySelector('span');
        let statusText = '未知';
        let statusColor = 'bg-gray-300';

        if (this.syncStatus.serverConnected === false) {
            statusText = '服务器离线';
            statusColor = 'bg-red-500';
        } else if (localStorage.getItem('block_data_sync') === 'true') {
            statusText = '已暂停';
            statusColor = 'bg-yellow-500';
        } else if (localStorage.getItem('force_data_sync') === 'true') {
            statusText = '强制同步中';
            statusColor = 'bg-green-500';
        } else if (this.syncStatus.inProgress) {
            statusText = '同步中...';
            statusColor = 'bg-blue-500 animate-pulse';
        } else if (this.syncStatus.lastSync) {
            statusText = '已同步';
            statusColor = 'bg-green-500';
        }

        statusDot.className = `inline-block w-3 h-3 rounded-full ${statusColor} mr-2`;
        indicator.innerHTML = `
            <span class="inline-block w-3 h-3 rounded-full ${statusColor} mr-2"></span>
            同步状态: ${statusText}${extraText ? `（${extraText}）` : ''}
        `;
    }

    // 检查同步状态
    async checkSyncStatus(options = {}) {
        const { silent = false } = options;
        this.syncStatus.inProgress = true;
        this.updateSyncStatusIndicator('检查中');

        try {
            await NetworkHelper.fetchWithTimeout('/api/health', { timeout: 5000, cache: 'no-store' });

            const pendingCount = this.targetTables.reduce((sum, table) => {
                const pending = JSON.parse(localStorage.getItem(`pending_${table}`) || '[]');
                return sum + pending.length;
            }, 0);

            this.syncStatus.serverConnected = true;
            this.syncStatus.lastSync = Date.now();
            this.updateSyncStatusIndicator(`待同步 ${pendingCount} 条`);

            if (!silent) {
                UINotification.success(`✅ 连接正常，当前待同步 ${pendingCount} 条`);
            }
        } catch (error) {
            this.syncStatus.serverConnected = false;
            this.updateSyncStatusIndicator('无法连接服务器');
            if (!silent) {
                UINotification.error(`❌ 连接失败：${error.message}`);
            }
        } finally {
            this.syncStatus.inProgress = false;
            this.updateSyncStatusIndicator();
        }
    }

    // [关键修复] 强制同步数据到服务器
    forceSync() {
        if (this.syncStatus.inProgress) return;
        
        // 1. 安全检查：检查是否有本地数据未进入上传队列
        // 如果直接刷新，Storage.js 会认为本地数据是旧的，直接用服务器空数据覆盖
        let hasUnsyncedData = false;
        this.targetTables.forEach(table => {
            const cache = JSON.parse(localStorage.getItem(`cache_${table}`) || '{"data":[]}');
            const pending = JSON.parse(localStorage.getItem(`pending_${table}`) || '[]');
            // 如果有缓存数据，但等待上传的队列是空的，说明这些数据还没准备好上传
            if (cache.data && cache.data.length > 0 && pending.length === 0) {
                hasUnsyncedData = true;
            }
        });

        if (hasUnsyncedData) {
            const confirmMsg = "⚠️ 检测到本地有数据但未列入上传队列。\n\n如果不加入队列，强制同步将会用服务器数据（可能为空）覆盖本地数据，导致数据丢失。\n\n是否将本地数据加入上传队列？";
            if (confirm(confirmMsg)) {
                this._queueAllLocalDataForUpload();
                alert('✅ 已将本地数据加入上传队列。');
            } else {
                if (!confirm("⚠️ 您选择了不上传。点击确定将继续同步（可能导致本地数据丢失），点击取消中止操作。")) {
                    return;
                }
            }
        }
        
        this.syncStatus.inProgress = true;
        this.updateSyncStatusIndicator();
        
        localStorage.removeItem('block_data_sync');
        localStorage.setItem('force_data_sync', 'true');
        
        alert('🔄 开始强制同步数据到服务器...\n\n页面将刷新以启动同步过程。');
        localStorage.setItem('sync_started', Date.now().toString());
        location.reload();
    }

    // [辅助方法] 将所有本地数据转换为待上传请求
    _queueAllLocalDataForUpload() {
        this.targetTables.forEach(table => {
            const cacheKey = `cache_${table}`;
            const pendingKey = `pending_${table}`;
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '{"data":[]}');
            
            if (cache.data && cache.data.length > 0) {
                const uniqueRecords = this._dedupeRecordsByFingerprint(cache.data);
                // 已有正式ID的记录优先走 update，避免恢复时重复 create。
                const requests = uniqueRecords.map(record => {
                    const baseReq = {
                        id: `sync_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        data: { ...record, _status: 'pending' },
                        timestamp: Date.now()
                    };

                    if (this._canUseUpdate(record.id)) {
                        return {
                            ...baseReq,
                            type: 'update',
                            recordId: record.id
                        };
                    }

                    return {
                        ...baseReq,
                        type: 'create',
                        tempId: record.id
                    };
                });
                localStorage.setItem(pendingKey, JSON.stringify(requests));
            }
        });
    }

    async pauseSync() {
        const confirmed = await UINotification.confirm(
            '确定要暂停数据同步吗？',
            '确认暂停'
        );
        
        if (confirmed) {
            try {
                localStorage.setItem('block_data_sync', 'true');
                localStorage.removeItem('force_data_sync');
                this.updateSyncStatusIndicator();
                UINotification.success('⏸️ 数据同步已暂停');
            } catch (error) {
                UINotification.error('❌ 暂停同步失败: ' + error.message);
            }
        }
    }

    async handleBackup() {
        try {
            const backupData = {
                version: '2.0',
                timestamp: new Date().toISOString(),
                tables: {}
            };

            let count = 0;
            this.targetTables.forEach(tableName => {
                const key = `cache_${tableName}`;
                const rawData = localStorage.getItem(key);
                if (rawData) {
                    try {
                        const parsed = JSON.parse(rawData);
                        backupData.tables[tableName] = parsed;
                        count += (parsed.data || []).length;
                    } catch (e) {
                        console.warn(`解析 ${tableName} 缓存失败:`, e);
                    }
                }
            });

            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lab_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            UINotification.success(`✅ 备份成功！共导出 ${count} 条记录`);
            // 记录审计日志
            await auditLogService.logOperation(
                'export',
                'system',
                'backup',
                `导出数据备份：共 ${count} 条记录`
            );
        } catch (error) {
            console.error('备份失败:', error);
            UINotification.error('❌ 备份失败: ' + error.message);
        }
    }

    handleFileRestore(file) {
        this.showStatus('正在解析文件...', 'blue');
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const backupData = JSON.parse(e.target.result);
                this.processRestoreData(backupData, '本地文件');
            } catch (err) {
                this.showStatus(`❌ 文件解析失败: ${err.message}`, 'red');
            }
        };
        reader.readAsText(file);
    }

    // ============================================================
    // 【核心修改区域】
    // 替换了原有的逻辑，改为直接从 5 个业务表拉取数据
    // 解决了 406 Not Acceptable (system_backups 表不存在) 的问题
    // ============================================================
    async handleCloudRestore() {
        const confirmed = await UINotification.confirm(
            '确定要从服务器重新加载所有数据吗？⚠️ 注意：这将覆盖本地当前的缓存数据',
            '确认恢复'
        );
        
        if (!confirmed) return;

        this.showStatus('⏳ 正在连接服务器获取最新数据...', 'purple');
        const btn = document.getElementById('btn-cloud-restore');
        if(btn) btn.disabled = true;

        const token = localStorage.getItem('auth_token') || localStorage.getItem('guest_token');
        if (!token || token.startsWith('temp-token-')) {
            this.showStatus('❌ 云端同步需要登录有效账号后再执行', 'red');
            UINotification.error('请先使用有效账号登录后再执行云端同步');
            if (btn) btn.disabled = false;
            return;
        }

        try {
            // 使用 Promise.all 并行拉取 5 张表
            const promises = this.targetTables.map(async (tableName) => {
                const response = await fetch(`/api/records/${tableName}?limit=1000&offset=0`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    }
                });

                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || `获取 ${tableName} 失败`);
                }

                const data = Array.isArray(result) ? result : (result.data || []);
                
                // 数据清洗：确保格式统一
                const processedData = data.map(row => {
                    // 兼容历史数据中的 data 嵌套结构
                    const content = (row.data && typeof row.data === 'object') ? row.data : row;
                    // 标记为已同步
                    return { ...content, id: row.id, _status: 'synced' };
                });

                // 直接写入缓存
                localStorage.setItem(`cache_${tableName}`, JSON.stringify({ data: processedData }));
                return processedData.length;
            });

            await Promise.all(promises);

            this.showStatus('✅ 云端同步成功！页面即将刷新...', 'green');
            // 记录审计日志
            await auditLogService.logOperation(
                'import',
                'system',
                'backup',
                `从服务器云端恢复数据：已加载 5 个数据表`
            );
            UINotification.success('✅ 同步成功！本地数据已更新为服务器最新状态');
            setTimeout(() => window.location.reload(), 1500);

        } catch (err) {
            console.error(err);
            this.showStatus(`❌ 云端同步失败: ${err.message}`, 'red');
            UINotification.error('❌ 无法从服务器下载数据，请检查网络或联系管理员');
            if(btn) btn.disabled = false;
        }
    }

    // [核心修复] 统一恢复逻辑
    async processRestoreData(backupData, sourceName) {
        try {
            // 1. 格式检测
            const isStandardFormat = backupData.tables && backupData.version;
            const isSimpleFormat = !isStandardFormat && Object.keys(backupData).length > 0;
            
            if (!isStandardFormat && !isSimpleFormat) throw new Error('无效的数据格式');

            // 2. 确认提示
            let confirmMessage = `检测到来自 [${sourceName}] 的数据\n`;
            if (isStandardFormat) confirmMessage += `版本: ${backupData.version}\n`;
            confirmMessage += '\n⚠️ 警告：当前本地的同名数据将被覆盖！确定要恢复吗？';
            
            if (!confirm(confirmMessage)) {
                this.showStatus('操作已取消', 'gray');
                return;
            }
            
            // 3. 同步选项
            const shouldSyncToServer = confirm(`同步控制选项:\n\n是否将恢复的数据同步到服务器？\n\n• 点击"确定"：恢复数据并自动加入上传队列\n• 点击"取消"：仅恢复到本地`);

            let restoreCount = 0;
            const restoredTableRecords = {};
            
            // 4. 执行恢复
            const processTable = (tableName, data) => {
                const cacheKey = `cache_${tableName}`;
                const pendingKey = `pending_${tableName}`;
                
                // 写入缓存 (标记为 pending)
                let records = Array.isArray(data) ? data : (data.data || []);
                records = this._dedupeRecordsByFingerprint(records);
                if (shouldSyncToServer) {
                    records = records.map(r => ({ ...r, _status: 'pending' }));
                }

                restoredTableRecords[tableName] = records;

                const dataObj = { data: records, timestamp: Date.now() };
                localStorage.setItem(cacheKey, JSON.stringify(dataObj));
                
                localStorage.setItem(pendingKey, JSON.stringify([]));
                restoreCount++;
            };

            if (isStandardFormat) {
                Object.keys(backupData.tables).forEach(t => {
                    if (this.targetTables.includes(t)) processTable(t, backupData.tables[t]);
                });
            } else {
                Object.keys(backupData).forEach(t => {
                    if (this.targetTables.includes(t)) {
                        let d = backupData[t];
                        if (typeof d === 'string') try { d = JSON.parse(d); } catch(e){}
                        processTable(t, d);
                    }
                });
            }
            
            // 5. 结果处理
            if (shouldSyncToServer) {
                let uploadedSummary = null;
                try {
                    uploadedSummary = await this.uploadRestoredDataToServer(restoredTableRecords);
                } catch (uploadError) {
                    console.warn('批量上传失败，回退到本地队列同步:', uploadError);
                    this.queueRestoredDataForSync(restoredTableRecords);
                    localStorage.setItem('force_data_sync', 'true');
                }

                localStorage.removeItem('block_data_sync');
                // 记录审计日志
                await auditLogService.logOperation(
                    'import',
                    'system',
                    'backup',
                    `导入数据恢复：来自 ${sourceName}，已恢复 ${restoreCount} 个表${uploadedSummary ? '并完成服务器批量同步' : '，已加入同步队列'}`
                );

                if (uploadedSummary) {
                    alert(`✅ 恢复成功！\n已恢复 ${restoreCount} 个表，并已上传到服务器。\n\n创建 ${uploadedSummary.created} 条，更新 ${uploadedSummary.updated} 条，失败 ${uploadedSummary.failed} 条。`);
                } else {
                    alert(`✅ 恢复成功！\n已恢复 ${restoreCount} 个表。\n\n批量上传失败，已回退为本地上传队列，页面刷新后将自动重试同步。`);
                }
            } else {
                localStorage.setItem('block_data_sync', 'true');
                // 记录审计日志
                await auditLogService.logOperation(
                    'import',
                    'system',
                    'backup',
                    `导入数据恢复（本地模式）：来自 ${sourceName}，已恢复 ${restoreCount} 个表`
                );
                alert(`✅ 恢复成功！\n已设置为本地模式。`);
            }
            
            location.reload();

        } catch (err) {
            console.error(err);
            this.showStatus(`❌ 恢复失败: ${err.message}`, 'red');
        }
    }

    showStatus(msg, color) {
        const el = document.getElementById('restore-status');
        if (el) {
            el.style.display = 'block';
            el.innerHTML = msg;
            el.className = `mb-6 p-3 rounded text-center font-medium text-sm bg-${color}-50 text-${color}-700 border border-${color}-200`;
        }
    }

    _canUseUpdate(id) {
        return typeof id === 'string' &&
            id.length > 0 &&
            !id.startsWith('temp_') &&
            !id.startsWith('restore_') &&
            !id.startsWith('sync_');
    }

    _buildRecordFingerprint(record) {
        if (!record || typeof record !== 'object') return '';

        const clone = { ...record };
        delete clone.id;
        delete clone._status;
        delete clone.created_at;
        delete clone.updated_at;
        delete clone.record_code;

        const normalize = (value) => {
            if (Array.isArray(value)) return value.map(normalize);
            if (value && typeof value === 'object') {
                return Object.keys(value).sort().reduce((acc, key) => {
                    acc[key] = normalize(value[key]);
                    return acc;
                }, {});
            }
            return value;
        };

        return JSON.stringify(normalize(clone));
    }

    _dedupeRecordsByFingerprint(records) {
        const seen = new Set();
        const unique = [];

        (records || []).forEach(record => {
            const fingerprint = this._buildRecordFingerprint(record);
            if (!fingerprint || seen.has(fingerprint)) return;
            seen.add(fingerprint);
            unique.push(record);
        });

        return unique;
    }

    queueRestoredDataForSync(restoredTableRecords) {
        Object.keys(restoredTableRecords).forEach(tableName => {
            const pendingKey = `pending_${tableName}`;
            const records = Array.isArray(restoredTableRecords[tableName]) ? restoredTableRecords[tableName] : [];
            const requests = [];
            const queuedFingerprints = new Set();

            records.forEach(record => {
                const fingerprint = this._buildRecordFingerprint(record);
                if (!fingerprint || queuedFingerprints.has(fingerprint)) return;

                const baseReq = {
                    id: `restore_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                    data: { ...record, _status: 'pending' },
                    timestamp: Date.now()
                };

                if (this._canUseUpdate(record.id)) {
                    requests.push({
                        ...baseReq,
                        type: 'update',
                        recordId: record.id
                    });
                } else {
                    requests.push({
                        ...baseReq,
                        type: 'create',
                        tempId: record.id
                    });
                }

                queuedFingerprints.add(fingerprint);
            });

            localStorage.setItem(pendingKey, JSON.stringify(requests));
        });
    }

    async uploadRestoredDataToServer(restoredTableRecords) {
        const token = localStorage.getItem('auth_token') || localStorage.getItem('guest_token');
        if (!token || token.startsWith('temp-token-')) {
            throw new Error('缺少有效登录态，无法上传到服务器');
        }

        const summary = { created: 0, updated: 0, failed: 0 };

        for (const tableName of this.targetTables) {
            const records = Array.isArray(restoredTableRecords[tableName]) ? restoredTableRecords[tableName] : [];
            if (!records.length) continue;

            const payload = records.map(record => {
                const clean = { ...record };
                delete clean.id;
                delete clean._status;
                return clean;
            });

            const response = await NetworkHelper.post(`/api/records/${tableName}/bulk-upsert`, {
                records: payload
            }, {
                timeout: 20000,
                retries: 2,
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            const result = response?.data || {};
            summary.created += result.created || 0;
            summary.updated += result.updated || 0;
            summary.failed += result.failed || 0;

            const cacheKey = `cache_${tableName}`;
            const cacheData = JSON.parse(localStorage.getItem(cacheKey) || '{"data":[]}');
            const syncedData = (cacheData.data || []).map(item => ({ ...item, _status: 'synced' }));
            localStorage.setItem(cacheKey, JSON.stringify({ ...cacheData, data: syncedData, timestamp: Date.now() }));
            localStorage.setItem(`pending_${tableName}`, JSON.stringify([]));
        }

        return summary;
    }
}
