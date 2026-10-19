import { projectByLabel, PROJECTS, resultText, newEntryId } from './contract.js';
import { resolveSyncScope } from '../core/SyncScope.js';
import { collectCustomFieldValues, getSchoolCustomization } from '../utils/schoolCustomization.js';
import { extractSchoolCode } from '../utils/schoolCode.js';

const el = (tag, text = '', attrs = {}) => {
    const node = document.createElement(tag); node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
};
const field = (caption, input) => { const label = el('label', caption); label.append(input); return label; };
const button = (caption, action) => { const b = el('button', caption, { type: 'button' }); b.addEventListener('click', action); return b; };
const options = pairs => { const s = el('select'); for (const [value, text] of pairs) s.append(el('option', text, { value })); return s; };
const messages = { negative: '阴性（合格）', positive: '阳性（不合格）', invalid: '检测无效' };
const biological = { negative: '阴性', positive: '阳性', invalid: '无效' };
const statusNames = { ok: '图像识别完成', partial: '部分通道未完成', board_not_detected: '未找到定位板',
    localization_failed: '窗口定位失败', structure_mismatch: '卡片结构不匹配', orientation_failed: '方向无法确认',
    quality_failed: '图像质量不足', profile_required: '卡型尚未配置', engine_error: '识别运行异常',
    decode_failed: '原照片无法解码', runtime_timeout: '本机识别超时', interrupted: '识别未确认完成', upload_failed: '原照片上传失败' };
function channelDescription(c) {
    if (c.status !== 'ok') return '无法判读';
    if (c.rule_status === 'outside_time') return `超出判读时限（图像候选：${biological[c.image_result] || '未知'}）`;
    if (!c.final_result) return `${biological[c.image_result] || '未知'}图像候选（时间未核实）`;
    return messages[c.final_result] || '无法判读';
}
let browserBusy = false;

export class PhotoEntry {
    constructor(module, point) {
        this.module = module; this.point = point; this.form = point.closest('form');
        this.scope = resolveSyncScope().scopeId; this.entry = null; this.attemptId = null; this.result = null;
        this.busy = false; this.mode = 'manual'; this.timer = null; this.file = null; this.timeSource = 'operator_reported';
        this.projectSelect = point.querySelector('select[name="batchNo"],select[name="batchNo[]"]');
        this.resultSelect = point.querySelector('select[name="result"],select[name="result[]"]');
        if (!this.projectSelect || !this.resultSelect) return;
        if (module.moduleName === 'leanMeat' && ![...this.projectSelect.options].some(o => o.value === PROJECTS.at(-1).label)) this.projectSelect.add(new Option(PROJECTS.at(-1).label, PROJECTS.at(-1).label));
        this.panel = el('section', '', { class: 'colloidal-panel', 'data-colloidal-panel': '' });
        this.panel.append(el('strong', '结果录入方式'));
        this.modeSelect = options([['manual', '手工录入'], ['auto', '拍照／上传识别']]);
        this.modeSelect.addEventListener('change', () => { this.mode = this.modeSelect.value; this.update(); });
        this.panel.append(this.modeSelect);
        this.autoBox = el('div', '', { class: 'colloidal-controls' });
        this.fileInput = el('input', '', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif' });
        this.cameraInput = el('input', '', { type: 'file', accept: 'image/*', capture: 'environment' });
        this.fileInput.hidden = true; this.cameraInput.hidden = true;
        this.fileInput.addEventListener('change', () => this.choose(this.fileInput.files[0], 'upload'));
        this.cameraInput.addEventListener('change', () => this.choose(this.cameraInput.files[0], 'camera'));
        this.elapsedInput = el('input', '', { type: 'number', min: '0', step: 'any', placeholder: '不知道请留空' });
        this.inputMode = options([['auto', '自动判断拍摄方式'], ['closeup', '完整单卡近照'], ['board', '当前v5定位板']]);
        this.timerText = el('span');
        this.autoBox.append(button('拍照', () => this.cameraInput.click()), button('选择照片', () => this.fileInput.click()), this.fileInput, this.cameraInput,
            field('拍摄时距加样（分钟）', this.elapsedInput), field('拍摄方式', this.inputMode),
            button('开始加样计时', () => { this.timer = performance.now(); this.timerText.textContent = '计时已开始；请在拍照时记录计时值。'; }),
            button('记录当前计时值', () => { if (this.timer !== null) { this.elapsedInput.value = ((performance.now() - this.timer) / 60000).toFixed(3); this.timeSource = 'capture_timer'; this.timerText.textContent = '已记录本次人工点击的计时值，应与实际拍照时刻对应。'; this.invalidateResult(); } }), this.timerText);
        this.preview = el('img', '', { alt: '原始上传照片预览', class: 'colloidal-preview' }); this.preview.hidden = true;
        this.fileLabel = el('span'); this.runButton = button('开始识别', () => this.recognize());
        this.autoBox.append(this.preview, this.fileLabel, this.runButton,
            el('small', '识别在本机浏览器执行。只留存原始上传照片；时间未知时仅给候选结果。请拍完整单卡，或使用当前v5支持的定位板。'));
        this.manualChannels = el('div', '', { class: 'colloidal-controls' });
        this.notice = el('p', '', { role: 'status', 'aria-live': 'polite' });
        this.panel.append(this.autoBox, this.manualChannels, this.notice);
        const ordinal = [...this.form.querySelectorAll('[data-test-point]')].indexOf(point);
        this.recoveryKey = `colloidal-entry::${this.scope}::${module.moduleName}::${ordinal}`;
        this.restoreButton = button('恢复上次未完成的照片录入', () => this.restore());
        this.restoreButton.hidden = !sessionStorage.getItem(this.recoveryKey);
        this.panel.append(this.restoreButton);
        point.append(this.panel);
        this.projectChangeHandler = () => this.update();
        this.projectSelect.addEventListener('change', this.projectChangeHandler);
        // School customization may rebuild options after module construction.
        // Keep the new triplex capability available without removing or
        // rewriting any existing school-defined options/configuration.
        if (module.moduleName === 'leanMeat') {
            this.optionObserver = new MutationObserver(() => {
                if (![...this.projectSelect.options].some(o => o.value === PROJECTS.at(-1).label)) this.projectSelect.add(new Option(PROJECTS.at(-1).label, PROJECTS.at(-1).label));
                this.update();
            });
            this.optionObserver.observe(this.projectSelect, { childList: true });
        }
        for (const input of [this.elapsedInput, this.inputMode]) input.addEventListener('change', () => this.invalidateResult());
        this.elapsedInput.addEventListener('change', () => { this.timeSource = 'operator_reported'; });
        this.update();
    }
    get project() { return projectByLabel(this.module.moduleName, this.projectSelect.value); }
    async api(suffix, options = {}) {
        if (resolveSyncScope().scopeId !== this.scope) throw new Error('账号或学校已改变，请刷新后继续');
        return this.module.storage.requestOnlineResource('/api/colloidal' + suffix, options);
    }
    context() {
        const data = {};
        for (const key of ['testDate', 'canteen', 'inspector']) data[key] = this.form.querySelector(`[name="${key}"]`)?.value || '';
        for (const key of ['meatType', 'vegetableType', 'remark']) {
            const input = this.point.querySelector(`[name="${key}"],[name="${key}[]"]`);
            if (input) data[key] = input.value;
        }
        data.customFields = collectCustomFieldValues(this.form, getSchoolCustomization(extractSchoolCode()));
        return data;
    }
    signature() { return JSON.stringify({ projectId: this.project?.id, context: this.context() }); }
    invalidateResult() {
        this.result = null; this.attemptId = null;
        if (this.mode === 'auto') this.resultSelect.value = '';
    }
    update() {
        if (this.busy) return;
        const project = this.project;
        this.panel.hidden = !project;
        this.autoBox.hidden = this.mode !== 'auto';
        this.resultSelect.disabled = !!project && (this.mode === 'auto' || project.channels.length === 3);
        this.resultSelect.required = !this.resultSelect.disabled;
        const previousProject = this.lastProject;
        if (previousProject !== project?.id) {
            this.invalidateResult(); this.entry = null; this.pendingEntryId = null; this.manualChannels.replaceChildren();
            for (const c of project?.channels || []) if (project.channels.length === 3) this.manualChannels.append(field(c.name, options([['', '请选择'], ['合格', '合格'], ['不合格', '不合格']])));
            this.lastProject = project?.id;
        }
        this.manualChannels.hidden = this.mode !== 'manual' || project?.channels.length !== 3;
        if (this.mode === 'auto' && !this.result) this.resultSelect.value = '';
    }
    choose(file, source) {
        if (!file || this.busy) return;
        if (file.size === 0 || file.size > 15 * 1024 * 1024) { this.notice.textContent = '请选择15MB以内的原始照片。'; return; }
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        if (this.file) { this.elapsedInput.value = ''; this.timeSource = 'operator_reported'; }
        this.file = file; this.source = source; this.invalidateResult();
        this.previewUrl = URL.createObjectURL(file); this.preview.src = this.previewUrl; this.preview.hidden = false;
        this.fileLabel.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
        this.notice.textContent = '照片已选择，点击开始识别。';
    }
    async ensureEntry() {
        if (!this.project) throw new Error('该项目暂不支持照片识别');
        if (!this.entry || this.entrySignature !== this.signature()) {
            if (this.pendingSignature !== this.signature()) {
                this.pendingEntryId = null;
                this.pendingSignature = this.signature();
            }
            const id = this.pendingEntryId ||= newEntryId();
            sessionStorage.setItem(this.recoveryKey, id);
            this.restoreButton.hidden = false;
            this.entry = (await this.api('/entries', { method: 'POST', body: JSON.stringify({ id, projectId: this.project.id, context: this.context() }) })).entry;
            this.entrySignature = this.signature();
            sessionStorage.setItem(this.recoveryKey, this.entry.id);
        }
        return this.entry;
    }
    async recognize() {
        if (this.busy || !this.file) return;
        if (browserBusy) { this.notice.textContent = '本机已有照片正在识别，请稍候再试。'; return; }
        if (!this.elapsedInput.checkValidity()) { this.elapsedInput.reportValidity(); return; }
        browserBusy = true;
        this.busy = true; this.runButton.disabled = true; this.notice.textContent = '正在保存原照片并加载识别组件…';
        const signature = this.signature();
        const projectId = this.project?.id;
        const inputMode = this.inputMode.value;
        this.projectSelect.disabled = true;
        let attemptId;
        try {
            await this.ensureEntry();
            attemptId = newEntryId();
            const elapsed = this.elapsedInput.value === '' ? null : Number(this.elapsedInput.value) * 60;
            await this.api(`/entries/${this.entry.id}/attempts`, { method: 'POST', body: JSON.stringify({ id: attemptId, inputMode, source: this.source || 'upload', elapsedSeconds: elapsed, timeSource: this.timeSource, filename: this.file.name }) });
            await this.api(`/attempts/${attemptId}/photo`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: this.file });
            this.notice.textContent = '浏览器正在识别，首次加载可能需要较长时间…';
            const result = await runWorker(await this.file.arrayBuffer(), projectId, elapsed, inputMode);
            result.client = { userAgent: navigator.userAgent };
            const saved = await this.api(`/attempts/${attemptId}/result`, { method: 'PUT', body: JSON.stringify(result) });
            if (signature !== this.signature()) { this.notice.textContent = '项目或样本已改变，原识别尝试已保留，请重新识别。'; this.invalidateResult(); return; }
            this.result = saved.result; this.attemptId = attemptId; this.resultSignature = signature;
            this.showResult();
        } catch (error) {
            this.result = null;
            let retained = false;
            if (attemptId) {
                try { await this.api(`/attempts/${attemptId}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: String(error.message).slice(0, 240), channels: [] }) }); retained = true; } catch { /* Existing immutable result or unavailable network; recovery queries server. */ }
            }
            this.notice.textContent = `${error.message}。${retained ? '未完成的识别记录已保留，可切换手工录入。' : '请检查网络并恢复该次录入后继续；尚未确认日志保存成功。'}`;
        } finally { browserBusy = false; this.busy = false; this.runButton.disabled = false; this.projectSelect.disabled = false; this.update(); }
    }
    showResult() {
        const r = this.result;
        const channels = r.channels.map(c => `${this.project.channels.find(p => p.id === c.id)?.name || c.id}：${channelDescription(c)}`);
        this.notice.textContent = [channels.join('；'), r.error, r.eligible ? '识别完成，点击表单保存即可。' : '当前没有可保存的自动结果，可重拍或切换手工录入；识别尝试已保留。'].filter(Boolean).join(' ');
        this.resultSelect.value = r.eligible && r.channels.length === 1 ? resultText(r.channels[0].final_result) : '';
    }
    async restore() {
        try {
            const id = sessionStorage.getItem(this.recoveryKey); if (!id) return;
            const { entry, attempts } = await this.api(`/entries/${id}`);
            if (entry.status === 'completed') { sessionStorage.removeItem(this.recoveryKey); this.notice.textContent = '上次检测已保存，请刷新列表查看。'; return; }
            for (const [key, value] of Object.entries({ ...entry.context.customFields, ...entry.context })) {
                if (key === 'customFields') continue;
                const input = this.point.querySelector(`[name="${key}"],[name="${key}[]"]`) || this.form.querySelector(`[name="${key}"]`);
                if (input) input.value = value;
            }
            this.projectSelect.value = PROJECTS.find(p => p.id === entry.project_id).label;
            this.mode = 'manual'; this.modeSelect.value = 'manual'; this.update();
            this.entry = entry; this.pendingEntryId = entry.id; this.pendingSignature = this.signature(); this.entrySignature = this.signature();
            for (const attempt of attempts) if (!attempt.completed_at) await this.api(`/attempts/${attempt.id}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: '页面重新打开，原识别未确认完成', channels: [] }) });
            const last = attempts.at(-1);
            if (last?.result?.eligible) { this.result = last.result; this.attemptId = last.id; this.resultSignature = this.signature(); this.mode = 'auto'; this.modeSelect.value = 'auto'; this.update(); this.showResult(); }
            else this.notice.textContent = '上次照片及识别尝试已恢复，可继续手工录入或重新拍照。';
        } catch (error) { this.notice.textContent = error.message; }
    }
    async saveIfNeeded() {
        this.update();
        if (!this.project || (this.mode === 'manual' && !this.entry && this.project.channels.length === 1)) return null;
        if (this.busy) throw new Error('照片还在识别，请稍候');
        if (this.entry && this.entrySignature !== this.signature()) throw new Error('样本信息已改变，请重新识别或重新建立录入，避免关联错误照片');
        if (this.mode === 'auto' && (!this.result?.eligible || this.resultSignature !== this.signature())) throw new Error('没有可保存的自动结果，请重拍或选择手工录入');
        const manualResults = {};
        if (this.mode === 'manual') this.project.channels.forEach((c, i) => { manualResults[c.id] = this.project.channels.length === 1 ? this.resultSelect.value : this.manualChannels.querySelectorAll('select')[i].value; });
        await this.ensureEntry();
        const response = await this.api(`/entries/${this.entry.id}/finalize`, { method: 'POST', body: JSON.stringify({ mode: this.mode, attemptId: this.mode === 'auto' ? this.attemptId : null, manualResults }) });
        sessionStorage.removeItem(this.recoveryKey);
        return response.records;
    }
    destroy() { this.projectSelect?.removeEventListener('change', this.projectChangeHandler); this.optionObserver?.disconnect(); if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.panel.remove(); }
}

function runWorker(bytes, projectId, elapsedSeconds, inputMode) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./reader.worker.js', import.meta.url), { type: 'module' });
        const finish = result => { clearTimeout(timer); worker.terminate(); resolve(result); };
        const timer = setTimeout(() => finish({ status: 'runtime_timeout', error: '本机识别超时，请重拍或手工录入', channels: [] }), 180000);
        worker.onmessage = e => finish(e.data.result);
        worker.onerror = () => finish({ status: 'engine_error', error: '浏览器识别组件加载失败，请检查网络或手工录入', channels: [] });
        worker.postMessage({ id: newEntryId(), bytes, projectId, elapsedSeconds, inputMode }, [bytes]);
    });
}

export function attachPhotoEntries(module) {
    if (!['pesticide', 'leanMeat'].includes(module.moduleName) || module.isQuickAccess) return;
    const container = document.getElementById(`${module.moduleName}PointsContainer`);
    if (!container) return;
    module.photoEntries ||= new WeakMap();
    for (const point of container.querySelectorAll('[data-test-point]')) {
        if (!module.photoEntries.has(point)) {
            point.querySelector('[data-colloidal-panel]')?.remove();
            module.photoEntries.set(point, new PhotoEntry(module, point));
        }
    }
}

export function addPhotoDetails(modal, record, storage) {
    if (record.resultSource) modal.querySelector('.p-6')?.append(el('p', `结果录入来源：${record.resultSource === 'photo_auto' ? '照片自动识别' : '手工录入'}`));
    if (!record.photoRecognition) return;
    const detail = el('details', '', { class: 'colloidal-panel' });
    detail.append(el('summary', '原始照片与结果录入过程'));
    const content = el('div'); detail.append(content); modal.querySelector('.p-6')?.append(detail);
    let loaded = false;
    const urls = [];
    const observer = new MutationObserver(() => { if (!modal.isConnected) { urls.forEach(u => URL.revokeObjectURL(u)); observer.disconnect(); } });
    observer.observe(document.body, { childList: true });
    detail.addEventListener('toggle', async () => {
        if (!detail.open || loaded) return;
        content.textContent = '正在读取…';
        try {
            const data = await storage.requestOnlineResource(`/api/colloidal/records/${encodeURIComponent(record.id)}`);
            loaded = true; content.replaceChildren();
            const meta = record.photoRecognition;
            content.append(el('p', `最终结果来源：${meta.resultSource === 'photo_auto' ? '照片自动识别' : '手工录入'}；录入过程：${({ direct_manual: '直接手工录入', auto_success: '自动识别成功', manual_after_auto_failure: '识别未完成有效判读后转手工', manual_after_photo: '照片识别后选择手工', manual_edit_after_photo: '照片录入后手工修改' })[meta.entryPath] || meta.entryPath}`));
            for (const attempt of data.attempts) {
                const r = attempt.result;
                content.append(el('p', `${new Date(attempt.created_at).toLocaleString('zh-CN')} · ${attempt.photo_name || '照片'} · ${statusNames[r?.status] || '未确认完成'}${r?.error ? '：' + r.error : ''}`));
                if (r?.channels?.length) content.append(el('p', r.channels.map(c => `${PROJECTS.find(p => p.id === data.entry.project_id)?.channels.find(p => p.id === c.id)?.name || c.id}：${channelDescription(c)}`).join('；')));
                if (attempt.photo_state === 'present') {
                    let photo;
                    try { photo = await storage.requestOnlineResource(`/api/colloidal/records/${encodeURIComponent(record.id)}/photos/${attempt.id}`, { responseType: 'blob' }); }
                    catch (error) { content.append(el('p', error.status === 410 ? '原照片已按留存策略清理' : '原照片暂时无法读取')); continue; }
                    const url = URL.createObjectURL(photo); urls.push(url);
                    const image = el('img', '', { src: url, alt: '原始上传照片', class: 'colloidal-preview' });
                    const link = el('a', '下载原始照片', { href: url, download: attempt.photo_name || 'photo' }); content.append(image, link);
                } else if (attempt.photo_state === 'purged' || attempt.photo_state === 'purging') content.append(el('p', '原照片已按留存策略清理，识别记录保留。'));
                else content.append(el('p', '原照片上传未完成。'));
            }
        } catch (error) { content.textContent = error.message; }
    });
}
