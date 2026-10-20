import { projectByLabel, PROJECTS, resultText, newEntryId } from './contract.js';
import { resolveSyncScope } from '../core/SyncScope.js';
import { collectCustomFieldValues, getSchoolCustomization } from '../utils/schoolCustomization.js';
import { extractSchoolCode } from '../utils/schoolCode.js';

// 结果录入方式收敛到原有“检测结果”下拉：手工（合格/不合格）+ 两个照片选项。
// 识别在服务端执行（Node 队列 + 常驻 Python 进程），浏览器只负责上传原图与展示回执。
const PHOTO_UPLOAD = '__photo_upload__';
const PHOTO_CAMERA = '__photo_camera__';
const MANUAL_TRIPLEX = '__manual_triplex__';
const PHOTO_OPTIONS = [[PHOTO_UPLOAD, '上传照片识别'], [PHOTO_CAMERA, '拍照识别']];
const RESULT_VALUES = ['合格', '不合格'];
const messages = { negative: '阴性（合格）', positive: '阳性（不合格）', invalid: '检测无效' };
const biological = { negative: '阴性', positive: '阳性', invalid: '无效' };
const statusNames = { ok: '图像识别完成', partial: '部分通道未完成', board_not_detected: '未找到定位板',
    localization_failed: '窗口定位失败', structure_mismatch: '卡片结构不匹配', orientation_failed: '方向无法确认',
    quality_failed: '图像质量不足', profile_required: '卡型尚未配置', engine_error: '识别运行异常',
    decode_failed: '原照片无法解码', runtime_timeout: '本机识别超时', interrupted: '识别未确认完成', upload_failed: '原照片上传失败' };
const CONTEXT_LABELS = { testDate: '检测日期', canteen: '食堂', inspector: '检测员', vegetableType: '蔬菜品种', meatType: '肉类' };

function channelDescription(c) {
    if (c.status !== 'ok') return '无法判读';
    if (c.rule_status === 'outside_time') return `超出判读时限（图像候选：${biological[c.image_result] || '未知'}）`;
    if (!c.final_result) return `${biological[c.image_result] || '未知'}图像候选（时间未核实）`;
    return messages[c.final_result] || '无法判读';
}
const el = (tag, text = '', attrs = {}) => {
    const node = document.createElement(tag); node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
};
let browserBusy = false;

export class PhotoEntry {
    constructor(module, point) {
        this.module = module; this.point = point; this.form = point.closest('form');
        this.scope = resolveSyncScope().scopeId;
        this.entry = null; this.attemptId = null; this.result = null; this.busy = false;
        this.file = null; this.source = 'upload';
        this.projectSelect = point.querySelector('select[name="batchNo"],select[name="batchNo[]"]');
        this.resultSelect = point.querySelector('select[name="result"],select[name="result[]"]');
        if (!this.projectSelect || !this.resultSelect) return;
        if (module.moduleName === 'leanMeat' && ![...this.projectSelect.options].some(o => o.value === PROJECTS.at(-1).label)) {
            this.projectSelect.add(new Option(PROJECTS.at(-1).label, PROJECTS.at(-1).label));
        }
        this.resultField = this.resultSelect.closest('div') || this.resultSelect.parentElement;
        this.buildControls();
        this.projectChangeHandler = () => this.update();
        this.projectSelect.addEventListener('change', this.projectChangeHandler);
        // 学校定制可能在模块构造后重建选项：保持三联可选，不覆盖学校既有配置。
        if (module.moduleName === 'leanMeat') {
            this.optionObserver = new MutationObserver(() => {
                if (![...this.projectSelect.options].some(o => o.value === PROJECTS.at(-1).label)) this.projectSelect.add(new Option(PROJECTS.at(-1).label, PROJECTS.at(-1).label));
                this.update();
            });
            this.optionObserver.observe(this.projectSelect, { childList: true });
        }
        this.update();
    }

    get project() { return projectByLabel(this.module.moduleName, this.projectSelect.value); }

    // 检测结果下拉按项目形态切换：
    // · 单检：合格 / 不合格 / 上传照片识别 / 拍照识别
    // · 三联：没有单一合格性，字段整块隐藏，改用通道区里明确的“上传照片 / 拍照”按钮
    syncResultOptions(project) {
        const mode = !project ? 'none' : project.channels.length === 3 ? 'triplex' : 'single';
        if (this.optionsMode === mode) return;
        this.optionsMode = mode;
        const items = mode === 'single' ? [['合格', '合格'], ['不合格', '不合格'], ...PHOTO_OPTIONS]
            : mode === 'triplex' ? [[MANUAL_TRIPLEX, '手工录入三项']] : [];
        this.resultSelect.replaceChildren(...items.map(([value, text]) => new Option(text, value)));
        this.resultSelect.value = mode === 'triplex' ? MANUAL_TRIPLEX : '';
        this.previousValue = this.resultSelect.value;
    }

    buildControls() {
        const inline = el('div', '', { class: 'colloidal-inline', 'data-colloidal-inline': '' });
        this.inline = inline;
        this.thumb = el('img', '', { alt: '原始上传照片预览', class: 'colloidal-thumb' }); this.thumb.hidden = true;
        this.status = el('small', '', { role: 'status', 'aria-live': 'polite', class: 'colloidal-status' });
        this.fileInput = el('input', '', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif' });
        this.cameraInput = el('input', '', { type: 'file', accept: 'image/*', capture: 'environment' });
        this.fileInput.hidden = true; this.cameraInput.hidden = true;
        this.fileInput.addEventListener('change', () => this.choose(this.fileInput.files[0], 'upload'));
        this.cameraInput.addEventListener('change', () => this.choose(this.cameraInput.files[0], 'camera'));
        // 取消选择时把下拉恢复到原来的结果，避免停在“上传照片识别”这种没有结果的状态。
        const resetPick = () => { if (PHOTO_OPTIONS.some(([v]) => v === this.resultSelect.value)) this.resultSelect.value = this.previousValue || ''; };
        this.fileInput.addEventListener('cancel', resetPick);
        this.cameraInput.addEventListener('cancel', resetPick);
        inline.append(this.thumb, this.status, this.fileInput, this.cameraInput);
        this.resultField?.append(inline);

        // 三联：一次实体卡对应三条记录，通道选择与拍照触发都留在原表单区域内。
        this.channelRow = el('div', '', { class: 'colloidal-channels col-span-3', 'data-colloidal-inline': '' });
        this.channelSelects = new Map();
        this.channelRow.hidden = true;
        this.point.append(this.channelRow);

        const ordinal = [...this.form.querySelectorAll('[data-test-point]')].indexOf(this.point);
        this.recoveryKey = `colloidal-entry::${this.scope}::${this.module.moduleName}::${ordinal}`;
        this.restoreButton = el('button', '恢复上次未完成的照片录入', { type: 'button', class: 'colloidal-link' });
        this.restoreButton.addEventListener('click', () => this.restore());
        this.restoreButton.hidden = !sessionStorage.getItem(this.recoveryKey);
        inline.append(this.restoreButton);
        this.resultSelect.addEventListener('change', () => {
            const value = this.resultSelect.value;
            if (!PHOTO_OPTIONS.some(([v]) => v === value)) { this.previousValue = value; return; }
            // 选完照片选项后先打开选择框，等真正选到文件再回退下拉，避免“刚选就跳回去”的错觉。
            this.pick(value === PHOTO_CAMERA ? 'camera' : 'upload');
        });
        this.resultSelect.addEventListener('focus', () => { this.previousValue = this.resultSelect.value; });
    }

    // 拍照/上传随时可选：检测单允许先建后补信息（服务端已支持），
    // 缺必填项在“保存”时统一提示，避免下拉选项看起来点了没反应。
    pick(source) {
        if (this.busy) { this.say('照片正在识别，请稍候。'); return; }
        this.source = source;
        (source === 'camera' ? this.cameraInput : this.fileInput).click();
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

    missingContext() {
        const context = this.context();
        const keys = ['testDate', 'canteen', 'inspector', this.module.moduleName === 'pesticide' ? 'vegetableType' : 'meatType'];
        const missing = keys.find(key => !String(context[key] || '').trim());
        return missing ? CONTEXT_LABELS[missing] : null;
    }

    invalidateResult() {
        this.result = null; this.attemptId = null; this.resultSignature = null;
        if (this.optionsMode === 'triplex') this.resultSelect.value = MANUAL_TRIPLEX;
        else this.resultSelect.value = '';
        for (const select of this.channelSelects.values()) select.value = '';
    }

    update() {
        if (this.busy) return;
        const project = this.project;
        const triplex = project?.channels.length === 3;
        this.syncResultOptions(project);
        if (this.lastProject !== project?.id) {
            this.invalidateResult(); this.entry = null; this.pendingEntryId = null;
            this.lastProject = project?.id;
            if (this.previewUrl) { URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
            this.thumb.hidden = true; this.status.textContent = ''; this.file = null;
            this.fileInput.value = ''; this.cameraInput.value = '';
        }
        this.syncChannelRow(project, triplex);
        this.resultSelect.disabled = false;
        // 三联该字段整块隐藏，不能再参与原生必填校验（隐藏的 required 会阻止提交）。
        this.resultSelect.required = !!project && !triplex;
        // 三联没有单一“合格/不合格”：整块隐藏检测结果字段，状态/预览移到通道区。
        this.resultField.hidden = !!triplex;
        if (triplex) this.channelRow.appendChild(this.inline);
        else this.resultField?.append(this.inline);
    }

    syncChannelRow(project, triplex) {
        if (!triplex) { this.channelRow.hidden = true; return; }
        this.channelRow.hidden = false;
        const signature = project.channels.map(c => c.name).join('|');
        if (this.channelSignature === signature && this.channelRow.childElementCount) return;
        this.channelSignature = signature;
        this.channelSelects.clear();
        const controls = el('div', '', { class: 'colloidal-channel-controls', 'data-channel-controls': '' });
        controls.append(el('span', '三联通道结果：', { class: 'colloidal-hint' }));
        for (const channel of project.channels) {
            const select = el('select');
            select.append(new Option('请选择', ''), new Option('合格', '合格'), new Option('不合格', '不合格'));
            this.channelSelects.set(channel.id, select);
            const label = el('label', channel.name); label.append(select);
            controls.append(label);
        }
        const camera = el('button', '拍照识别', { type: 'button', class: 'colloidal-action' });
        camera.addEventListener('click', () => this.pick('camera'));
        const upload = el('button', '上传照片识别', { type: 'button', class: 'colloidal-action' });
        upload.addEventListener('click', () => this.pick('upload'));
        controls.append(camera, upload);
        this.channelStatus = el('small', '', { class: 'colloidal-channel-status', role: 'status', 'aria-live': 'polite' });
        this.channelRow.replaceChildren(controls, this.channelStatus);
    }

    say(text) {
        this.status.textContent = text;
        if (this.channelStatus) this.channelStatus.textContent = text;
    }

    choose(file, source) {
        // 允许重复选择同一张照片（部分浏览器对相同文件不再触发 change）。
        this.fileInput.value = ''; this.cameraInput.value = '';
        if (!file) return;
        if (this.busy) return;
        if (file.size === 0 || file.size > 15 * 1024 * 1024) { this.say('请选择15MB以内的原始照片。'); return; }
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.file = file; this.source = source; this.invalidateResult();
        this.previewUrl = URL.createObjectURL(file); this.thumb.src = this.previewUrl; this.thumb.hidden = false;
        this.say(`已选择 ${file.name}（${(file.size / 1024 / 1024).toFixed(2)} MB），正在识别…`);
        this.recognize();
    }

    async api(suffix, options = {}) {
        if (resolveSyncScope().scopeId !== this.scope) throw new Error('账号或学校已改变，请刷新后继续');
        return this.module.storage.requestOnlineResource('/api/colloidal' + suffix, options);
    }

    async ensureEntry() {
        if (!this.project) throw new Error('该项目暂不支持照片识别');
        if (!this.entry || this.entrySignature !== this.signature()) {
            // 同一张卡沿用原检测单；服务端在 open 状态下更新上下文，不再因补充检测员而另建孤儿单。
            const id = this.entry?.id || this.pendingEntryId || newEntryId();
            this.pendingEntryId = id; this.pendingSignature = this.signature();
            sessionStorage.setItem(this.recoveryKey, id);
            this.restoreButton.hidden = false;
            this.entry = (await this.api('/entries', { method: 'POST', body: JSON.stringify({ id, projectId: this.project.id, context: this.context() }) })).entry;
            this.entrySignature = this.signature();
            sessionStorage.setItem(this.recoveryKey, this.entry.id);
        }
        return this.entry;
    }

    renderProgress() {
        if (!this.busy) return;
        const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
        this.say(`服务器正在识别…已用 ${seconds} 秒`);
    }

    async recognize() {
        if (this.busy || !this.file) return;
        if (browserBusy) { this.say('已有照片正在识别，请稍候再试。'); return; }
        browserBusy = true;
        this.busy = true;
        this.resultSelect.disabled = true;
        const file = this.file;
        const signature = this.signature();
        let attemptId;
        this.startedAt = Date.now();
        this.renderProgress();
        this.ticker = setInterval(() => this.renderProgress(), 1000);
        try {
            await this.ensureEntry();
            attemptId = newEntryId();
            // 现场已确认拍摄处于说明书判读时限内，不再采集/推算加样时距。
            await this.api(`/entries/${this.entry.id}/attempts`, { method: 'POST', body: JSON.stringify({
                id: attemptId, inputMode: 'auto', source: this.source, elapsedSeconds: null, timeSource: 'within_window', filename: file.name }) });
            await this.api(`/attempts/${attemptId}/photo`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
            // 识别在服务端队列中执行；这里只等回执（通常 1–3 秒）。
            const saved = await this.api(`/attempts/${attemptId}/recognize`, { method: 'POST', body: JSON.stringify({ client: { userAgent: navigator.userAgent } }) });
            if (signature !== this.signature()) { this.say('项目或样本已改变，原识别尝试已保留，请重新识别。'); this.invalidateResult(); return; }
            this.result = saved.result; this.attemptId = attemptId; this.resultSignature = signature;
            this.showResult();
        } catch (error) {
            this.result = null;
            let retained = false;
            if (attemptId) {
                try { await this.api(`/attempts/${attemptId}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: String(error.message).slice(0, 240), channels: [] }) }); retained = true; } catch { /* 已有不可变结果或网络不可用 */ }
            }
            this.say(`${error.message}。${retained ? '本次识别尝试与原照片已保留，可直接手工选择结果。' : '请检查网络后重试，或直接手工选择结果。'}`);
        } finally {
            clearInterval(this.ticker); this.ticker = null;
            browserBusy = false; this.busy = false; this.update();
        }
    }

    showResult() {
        const r = this.result;
        const lines = r.channels.map(c => `${this.project.channels.find(p => p.id === c.id)?.name || c.id}：${channelDescription(c)}`);
        if (r.eligible) {
            if (this.project.channels.length === 1) this.resultSelect.value = resultText(r.channels[0].final_result);
            else {
                for (const channel of this.project.channels) {
                    const item = r.channels.find(c => c.id === channel.id);
                    const value = resultText(item?.final_result);
                    if (value) this.channelSelects.get(channel.id).value = value;
                }
                this.resultSelect.value = MANUAL_TRIPLEX;
            }
            this.say([lines.join('；'), '识别完成，结果已填入检测结果，可直接保存；如需修改请手工改选。'].join(' '));
        } else {
            this.resultSelect.value = this.optionsMode === 'triplex' ? MANUAL_TRIPLEX : '';
            this.say([lines.join('；'), r.error, '未获得可用的自动结果，请直接手工选择合格／不合格；本次照片与识别过程已保留。'].filter(Boolean).join(' '));
        }
    }

    async restore() {
        try {
            const id = sessionStorage.getItem(this.recoveryKey); if (!id) return;
            const { entry, attempts } = await this.api(`/entries/${id}`);
            if (entry.status === 'completed') { sessionStorage.removeItem(this.recoveryKey); this.say('上次检测已保存，请刷新列表查看。'); return; }
            for (const [key, value] of Object.entries({ ...entry.context.customFields, ...entry.context })) {
                if (key === 'customFields') continue;
                const input = this.point.querySelector(`[name="${key}"],[name="${key}[]"]`) || this.form.querySelector(`[name="${key}"]`);
                if (input) input.value = value;
            }
            this.projectSelect.value = PROJECTS.find(p => p.id === entry.project_id).label;
            this.update();
            this.entry = entry; this.pendingEntryId = entry.id; this.pendingSignature = this.signature(); this.entrySignature = this.signature();
            for (const attempt of attempts) if (!attempt.completed_at) await this.api(`/attempts/${attempt.id}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: '页面重新打开，原识别未确认完成', channels: [] }) });
            const last = attempts.at(-1);
            if (last?.result?.eligible) { this.result = last.result; this.attemptId = last.id; this.resultSignature = this.signature(); this.showResult(); }
            else this.say('上次照片及识别尝试已恢复，可直接手工选择结果或重新拍照。');
        } catch (error) { this.say(error.message); }
    }

    // 返回 null 表示本点位不使用照片链路，交给原有手工保存流程。
    async saveIfNeeded() {
        const project = this.project;
        if (!project) return null;
        if (this.busy) throw new Error('照片还在识别，请稍候');
        const triplex = project.channels.length === 3;
        if (!this.entry && !triplex) return null;
        const missing = this.missingContext();
        if (missing) throw new Error(`请先填写${missing}再保存`);
        if (PHOTO_OPTIONS.some(([v]) => v === this.resultSelect.value)) throw new Error('请先完成照片识别，或直接选择合格／不合格');
        const manualResults = {};
        let mode = 'manual';
        if (triplex) {
            for (const channel of project.channels) {
                const value = this.channelSelects.get(channel.id)?.value;
                if (!RESULT_VALUES.includes(value)) throw new Error(`请选择${channel.name}的合格／不合格结果`);
                manualResults[channel.id] = value;
            }
            const autoMatches = this.result?.eligible && this.resultSignature === this.signature()
                && project.channels.every(c => manualResults[c.id] === resultText(this.result.channels.find(x => x.id === c.id)?.final_result));
            mode = autoMatches ? 'auto' : 'manual';
        } else {
            const value = this.resultSelect.value;
            if (!RESULT_VALUES.includes(value)) throw new Error('请选择检测结果');
            const autoValue = this.result?.eligible && this.resultSignature === this.signature() ? resultText(this.result.channels[0].final_result) : null;
            mode = autoValue && value === autoValue ? 'auto' : 'manual';
            manualResults[project.channels[0].id] = value;
        }
        await this.ensureEntry();
        const response = await this.api(`/entries/${this.entry.id}/finalize`, { method: 'POST', body: JSON.stringify({ mode, attemptId: mode === 'auto' ? this.attemptId : null, manualResults, context: this.context() }) });
        sessionStorage.removeItem(this.recoveryKey);
        this.restoreButton.hidden = true;
        return response.records;
    }

    destroy() {
        clearInterval(this.ticker); this.ticker = null;
        this.projectSelect?.removeEventListener('change', this.projectChangeHandler);
        this.optionObserver?.disconnect();
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.resultField?.querySelector('[data-colloidal-inline]')?.remove();
        this.channelRow.remove();
    }
}

export function attachPhotoEntries(module) {
    if (!['pesticide', 'leanMeat'].includes(module.moduleName) || module.isQuickAccess) return;
    const container = document.getElementById(`${module.moduleName}PointsContainer`);
    if (!container) return;
    module.photoEntries ||= new WeakMap();
    for (const point of container.querySelectorAll('[data-test-point]')) {
        if (!module.photoEntries.has(point)) {
            point.querySelectorAll('[data-colloidal-inline]').forEach(node => node.remove());
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
