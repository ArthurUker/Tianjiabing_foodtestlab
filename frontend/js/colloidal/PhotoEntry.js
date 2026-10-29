import { projectByLabel, PROJECTS, resultText, newEntryId } from './contract.js';
import { resolveSyncScope } from '../core/SyncScope.js';
import { collectCustomFieldValues, getSchoolCustomization } from '../utils/schoolCustomization.js';
import { extractSchoolCode } from '../utils/schoolCode.js';
import { TimedSampling } from './TimedSampling.js';
import { formatElapsed, samplingPlan } from './sampling.js';
import { CameraView } from './CameraView.js';
import { cameraEvent, processLogPanel } from './ProcessLog.js';

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
    decode_failed: '原照片无法解码', runtime_timeout: '识别超时', interrupted: '识别未确认完成', upload_failed: '原照片上传失败', sample_missed: '未在计划时点采样', capture_failed: '相机采样失败' };
const CONTEXT_LABELS = { testDate: '检测日期', canteen: '食堂', inspector: '检测员', vegetableType: '蔬菜品种', meatType: '肉类' };

function channelDescription(c) {
    if (c.status !== 'ok') return '无法判读';
    if (c.rule_status === 'outside_time') return `超出判读时限（图像候选：${biological[c.image_result] || '未知'}）`;
    if (!c.final_result) return `${biological[c.image_result] || '未知'}图像候选（时间未核实）`;
    return messages[c.final_result] || '无法判读';
}
// iPhone / iPad 上的 Chrome 也是 WebKit 内核，行为与 Safari 一致。
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 浏览器相机不可用时仍保留系统相机／文件选择的回退入口。

const el = (tag, text = '', attrs = {}) => {
    const node = document.createElement(tag); node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
};
let browserBusy = false;

// 识别模块未配置的项目（如二氧化硫快速检测试剂盒）必须保留人工判读入口。
// manual 模式只给合格/不合格，不提供照片识别，避免上传后才提示项目不支持。
export function resultOptionsFor(project) {
    const mode = !project ? 'manual' : project.channels.length === 3 ? 'triplex' : 'single';
    if (mode === 'triplex') return { mode, selected: MANUAL_TRIPLEX, items: [[MANUAL_TRIPLEX, '手工录入三项']] };
    const items = [['', '请选择'], ...RESULT_VALUES.map(value => [value, value])];
    if (mode === 'single') items.push(...PHOTO_OPTIONS);
    return { mode, selected: '', items };
}

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
        this.buildTimedSampling();
        this.buildProcessLog();
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
    // · 单检：请选择 / 合格 / 不合格 / 上传照片识别 / 拍照识别
    // · 人工判读：请选择 / 合格 / 不合格（项目没有照片识别配置时）
    // · 三联：没有单一合格性，字段整块隐藏，改用通道区里明确的“上传照片 / 拍照”按钮
    syncResultOptions(project) {
        const options = resultOptionsFor(project);
        if (this.optionsMode === options.mode) return;
        this.optionsMode = options.mode;
        this.resultSelect.replaceChildren(...options.items.map(([value, text]) => new Option(text, value)));
        this.resultSelect.value = options.selected;
        this.previousValue = this.resultSelect.value;
    }

    buildControls() {
        const inline = el('div', '', { class: 'colloidal-inline', 'data-colloidal-inline': '' });
        this.inline = inline;
        this.thumb = el('img', '', { alt: '原始上传照片预览', class: 'colloidal-thumb' }); this.thumb.hidden = true;
        this.status = el('small', '', { role: 'status', 'aria-live': 'polite', class: 'colloidal-status' });
        // iOS(WebKit) 会忽略 display:none 文件输入的 click()，必须“视觉隐藏”而不是 hidden。
        this.fileInput = el('input', '', { type: 'file', accept: 'image/*', class: 'colloidal-file-input' });
        this.cameraInput = el('input', '', { type: 'file', accept: 'image/*', capture: 'environment', class: 'colloidal-file-input' });
        this.fallbackButton = el('button', '', { type: 'button', class: 'colloidal-fallback' });
        this.fallbackButton.hidden = true;
        this.fallbackButton.addEventListener('click', () => {
            const target = this.fallbackSource === 'camera' ? this.cameraInput : this.fileInput;
            this.fallbackButton.hidden = true; this.say('');
            target.click();
        });
        this.fileInput.addEventListener('change', () => this.choose(this.fileInput.files[0], 'upload'));
        this.cameraInput.addEventListener('change', () => this.choose(this.cameraInput.files[0], 'camera'));
        // 取消选择时把下拉恢复到原来的结果，避免停在“上传照片识别”这种没有结果的状态。
        const resetPick = () => { if (PHOTO_OPTIONS.some(([v]) => v === this.resultSelect.value)) this.resultSelect.value = this.previousValue || ''; };
        this.fileInput.addEventListener('cancel', resetPick);
        this.cameraInput.addEventListener('cancel', resetPick);
        inline.append(this.thumb, this.status, this.fallbackButton, this.fileInput, this.cameraInput);
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
        this.resultChangeHandler = () => {
            const value = this.resultSelect.value;
            if (!PHOTO_OPTIONS.some(([v]) => v === value)) { this.previousValue = value; return; }
            // 选完照片选项后先打开选择框，等真正选到文件再回退下拉，避免“刚选就跳回去”的错觉。
            this.pick(value === PHOTO_CAMERA ? 'camera' : 'upload', true);
        };
        this.resultFocusHandler = () => { this.previousValue = this.resultSelect.value; };
        this.resultSelect.addEventListener('change', this.resultChangeHandler);
        this.resultSelect.addEventListener('focus', this.resultFocusHandler);
    }

    buildTimedSampling() {
        this.timedResults = new Map();
        this.timed = new TimedSampling({
            host: this.point,
            describe: result => result?.channels?.map(c => `${this.project?.channels.find(p => p.id === c.id)?.name || c.id}：${channelDescription(c)}${Number.isFinite(c.c) && Number.isFinite(c.t) ? `（C=${c.c.toFixed(2)}，T=${c.t.toFixed(2)}）` : ''}`).join('；') || '',
            validate: () => {
                if (resolveSyncScope().scopeId !== this.scope) throw new Error('账号或学校已改变，自动采样不能继续');
                if (!this.project) throw new Error('所选项目暂不支持自动采样');
                const missing = this.missingContext(); if (missing) throw new Error(`请先填写${missing}`);
                if (this.timedSignature && this.signature() !== this.timedSignature) throw new Error('样本信息已改变，请重新检测');
                if (this.busy) throw new Error('请先完成当前照片识别');
            },
            prepare: async () => {
                if (browserBusy) throw new Error('请先完成其他照片识别');
                await this.ensureEntry();
                if (this.entry.sampling) throw new Error('本次已有定时采样记录，请新增检测点位');
                this.invalidateResult(); this.timedResults.clear();
            },
            start: async body => { this.entry = (await this.api(`/entries/${this.entry.id}/sampling/start`, { method: 'POST', body: JSON.stringify(body) })).entry; },
            sample: body => this.recognizeTimedSample(body),
            finish: async body => {
                try { return await this.api(`/entries/${this.entry.id}/sampling/finish`, { method: 'POST', body: JSON.stringify(body) }); }
                catch (e) {
                    if (e.status !== 409 || body.state !== 'completed') throw e;
                    return this.api(`/entries/${this.entry.id}/sampling/finish`, { method: 'POST', body: JSON.stringify({ ...body, state: 'interrupted', reason: '存在未确认完成的识别尝试' }) });
                }
            },
            report: data => {
                this.entry = data.entry; this.samplingSummary = data.summary;
                this.invalidateResult();
                if (data.summary?.eligible) {
                    const last = data.summary.samples.find(s => s.attemptId === data.summary.adoptedAttemptId);
                    this.result = this.timedResults.get(last.attemptId) || { eligible: true, channels: last.channels };
                    this.attemptId = last.attemptId; this.resultSignature = this.signature(); this.showResult();
                } else this.say('未取得至少两次有效且一致的采样，请重测或手工选择结果。采样与原照片保留。');
            },
            lock: active => {
                if (active) {
                    this.closeWebcam(); this.timedSignature = this.signature(); this.timedDisabled = new Map();
                    const controls = [...this.point.querySelectorAll('input,select,textarea'), this.form.querySelector('button[type=submit]'), ...['testDate', 'canteen', 'inspector'].map(name => this.form.querySelector(`[name="${name}"]`))];
                    for (const control of new Set(controls)) if (control && !control.closest('[data-colloidal-timed]')) { this.timedDisabled.set(control, control.disabled); control.disabled = true; }
                } else {
                    for (const [control, disabled] of this.timedDisabled || []) control.disabled = disabled;
                    this.timedDisabled = null; this.timedSignature = null; this.update();
                }
            },
        });
    }

    buildProcessLog() {
        this.processPanel = el('details', '', { class: 'colloidal-panel colloidal-process', 'data-colloidal-process': '' });
        this.processPanel.hidden = true;
        const refresh = el('button', '刷新过程日志', { type: 'button', class: 'colloidal-link' });
        refresh.addEventListener('click', () => this.loadProcessLog());
        this.processContent = el('div');
        this.processPanel.append(el('summary', '拍照与算法识别过程日志'), refresh, this.processContent); this.point.append(this.processPanel);
        this.processPanel.addEventListener('toggle', () => { if (this.processPanel.open) this.loadProcessLog(); });
        this.processTicker = setInterval(() => { if (this.processPanel.open && (this.busy || this.timed?.active)) this.loadProcessLog(); }, 2000);
    }

    async loadProcessLog() {
        if (!this.entry || !this.processPanel?.isConnected) return;
        if (this.loadingProcess) { this.reloadProcess = true; return; }
        this.loadingProcess = true; const entryId = this.entry.id;
        try {
            const data = await this.api(`/entries/${entryId}`);
            if (this.entry?.id !== entryId || !this.processPanel.isConnected) return;
            this.processPanel.hidden = false;
            const opened = new Set([...this.processContent.querySelectorAll('details[open]')].map(d => d.dataset.attemptId));
            const existing = new Map([...this.processContent.querySelectorAll('[data-attempt-id]')].map(p => [p.dataset.attemptId, p]));
            this.processContent.replaceChildren(...data.attempts.map(a => {
                const previous = existing.get(a.id), snapshot = JSON.stringify([a.process_log, a.result, a.photo_state]);
                if (previous?.processSnapshot === snapshot) return previous;
                const open = opened.has(a.id) || data.attempts.length === 1;
                const panel = processLogPanel(a, { open, imagesOpen: previous?.querySelector('[data-recognition-images]')?.open ?? open,
                    loadPhoto: () => this.api(`/attempts/${a.id}/photo`, { responseType: 'blob' }) });
                panel.dataset.attemptId = a.id; panel.processSnapshot = snapshot; return panel;
            }));
            if (!data.attempts.length) this.processContent.textContent = '等待首次拍照；拍照后会显示原图上传和算法各步骤。';
        } catch (e) { this.processContent.textContent = `日志暂时无法读取：${e.message}`; }
        finally { this.loadingProcess = false; if (this.reloadProcess) { this.reloadProcess = false; this.loadProcessLog(); } }
    }

    async recognizeTimedSample(capture) {
        const attemptId = newEntryId();
        let registered = false;
        try {
            await this.api(`/entries/${this.entry.id}/attempts`, { method: 'POST', body: JSON.stringify({ id: attemptId,
                sampleIndex: capture.sampleIndex, samplingId: capture.samplingId, capturedAt: capture.capturedAt,
                elapsedSeconds: capture.elapsedSeconds, timeSource: 'scheduled_camera', inputMode: 'auto', source: 'camera', filename: capture.file?.name || `sample-${capture.sampleIndex}-missed`, clientEvents: capture.clientEvents }) });
            registered = true;
            this.processPanel.hidden = false; this.loadProcessLog();
            let result;
            if (capture.file) {
                await this.api(`/attempts/${attemptId}/photo`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: capture.file });
                result = (await this.api(`/attempts/${attemptId}/recognize`, { method: 'POST', timeout: 180000, body: JSON.stringify({ client: { userAgent: navigator.userAgent } }) })).result;
            } else result = (await this.api(`/attempts/${attemptId}/result`, { method: 'PUT', body: JSON.stringify({ status: 'sample_missed', error: capture.error, channels: [] }) })).result;
            this.timedResults.set(attemptId, result); return result;
        } catch (e) {
            if (registered) {
                try { await this.api(`/attempts/${attemptId}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: String(e.message).slice(0, 240), channels: [] }) }); } catch { /* Restore/finish reconciles an immutable or unconfirmed result. */ }
            }
            throw e;
        } finally { this.loadProcessLog(); }
    }

    // 拍照/上传随时可选：检测单允许先建后补信息（服务端已支持），
    // 缺必填项在“保存”时统一提示，避免下拉选项看起来点了没反应。
    // fromSelect=true 表示由「检测结果」下拉触发。iOS 上 select 的 change 不提供用户手势，
    // 系统会静默拦截 file input 的 click()，因此补一个真实按钮让用户再点一次。
    pick(source, fromSelect = false) {
        if (this.timed?.active || this.entry?.sampling) { this.say('本次已进入定时采样。请完成、结束或新建检测点位，不能追加照片替代原采样。'); return; }
        if (this.busy) { this.say('照片正在识别，请稍候。'); return; }
        this.source = source;
        this.captureEvents = source === 'camera' ? [cameraEvent('camera_requested')] : [];
        this.fallbackSource = source;
        this.fallbackButton.hidden = true;
        // 可用时统一使用浏览器预览，手机也可旋转／镜像显示。
        if (source === 'camera' && navigator.mediaDevices?.getUserMedia) {
            this.openWebcam();
            return;
        }
        const target = source === 'camera' ? this.cameraInput : this.fileInput;
        try { target.click(); } catch { /* 少数浏览器直接抛错，走下面的回退按钮 */ }
        if (fromSelect && isIOS()) {
            this.fallbackButton.textContent = source === 'camera' ? '轻触打开相机' : '轻触选择照片';
            this.fallbackButton.hidden = false;
            this.say(`iPhone 需再点一次“${this.fallbackButton.textContent}”才能打开${source === 'camera' ? '相机' : '相册'}。`);
        }
    }

    // 桌面端摄像头拍照：预览 → 快门 → canvas 转 JPEG → 走与上传相同的识别流程。
    // 无摄像头或权限被拒时自动退回文件选择，不阻塞录入。
    async openWebcam() {
        if (this.camOverlay) return;
        const overlay = el('div', '', { class: 'colloidal-cam', role: 'dialog', 'aria-modal': 'true', 'aria-label': '摄像头拍照' });
        const panel = el('div', '', { class: 'colloidal-cam-panel' });
        const video = el('video', '', { class: 'colloidal-cam-video', playsinline: '', autoplay: '' });
        this.camView = new CameraView(video);
        video.muted = true;
        const hint = el('p', '对准检测卡，保持光线均匀，点击“拍照”。', { class: 'colloidal-cam-hint' });
        const actions = el('div', '', { class: 'colloidal-cam-actions' });
        const cancel = el('button', '取消', { type: 'button', class: 'colloidal-cam-cancel' });
        const shutter = el('button', '拍照', { type: 'button', class: 'colloidal-cam-shutter' });
        actions.append(cancel, shutter);
        panel.append(this.camView.root, hint, actions);
        overlay.append(panel);
        document.body.append(overlay);
        this.camOverlay = overlay;
        this.camStream = null;

        const close = () => this.closeWebcam();
        this._camKeyHandler = event => { if (event.key === 'Escape') close(); };
        document.addEventListener('keydown', this._camKeyHandler);
        cancel.addEventListener('click', close);
        overlay.addEventListener('click', event => { if (event.target === overlay) close(); });

        try {
            // 尽量要摄像头支持的最高分辨率：定位板模式需要 ≥6 px/mm，1080p 拍整张 A4 只有约 3.6 px/mm。
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
            });
            if (this.camOverlay !== overlay) { stream.getTracks().forEach(track => track.stop()); return; }
            this.camStream = stream;
            video.srcObject = this.camStream;
            await video.play().catch(() => {});
            if (this.camOverlay !== overlay) return;
            this.camView?.update();
            this.captureEvents.push(cameraEvent('camera_ready', { width: video.videoWidth, height: video.videoHeight }));
        } catch (error) {
            if (this.camOverlay !== overlay) return;
            this.closeWebcam();
            const reason = error?.name === 'NotAllowedError' ? '摄像头权限被拒绝'
                : error?.name === 'NotFoundError' ? '未检测到摄像头' : (error?.message || '无法打开摄像头');
            this.say(`${reason}，已切换为选择照片。`);
            try { this.fileInput.click(); } catch { /* 用户可再点一次 */ }
            return;
        }

        const track = this.camStream?.getVideoTracks?.()[0];
        const settings = track?.getSettings?.() || {};
        const camW = settings.width || video.videoWidth || 0;
        const camH = settings.height || video.videoHeight || 0;
        if (camW && camH) {
            hint.textContent = `当前摄像头 ${camW}×${camH}。拍整张定位板请改用手机；用电脑请把检测卡拍满画面。`;
        }

        shutter.addEventListener('click', () => {
            if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) { hint.textContent = '相机画面尚未就绪，请稍候再拍。'; return; }
            shutter.disabled = true;
            const previewSettings = this.camView.settings;
            this.captureEvents.push(cameraEvent('capture_started', previewSettings));
            const width = video.videoWidth;
            const height = video.videoHeight;
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(video, 0, 0, width, height);
            canvas.toBlob(blob => {
                if (this.camOverlay !== overlay) return;
                if (!blob) { this.say('拍照失败，请重试或改用上传照片。'); shutter.disabled = false; return; }
                const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
                this.captureEvents.push(cameraEvent('photo_captured', { width, height, bytes: file.size, ...previewSettings }));
                this.closeWebcam();
                // 分辨率过低时先说清原因，避免用户以为是“识别算法坏了”。
                this.lowResNote = width < 2000
                    ? `当前摄像头分辨率 ${width}×${height} 偏低，整张定位板通常无法识别：请改用手机拍定位板，或把检测卡拍满画面（单卡近照）。`
                    : '';
                this.choose(file, 'camera');
            }, 'image/jpeg', 0.92);
        });
    }

    closeWebcam() {
        this.camView?.destroy(); this.camView = null;
        if (this._camKeyHandler) { document.removeEventListener('keydown', this._camKeyHandler); this._camKeyHandler = null; }
        if (this.camStream) { for (const track of this.camStream.getTracks()) { try { track.stop(); } catch { /* ignore */ } } this.camStream = null; }
        this.camOverlay?.remove();
        this.camOverlay = null;
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
        if (this.busy || this.timed?.active) return;
        const project = this.project;
        if (this.timed) this.timed.root.hidden = !project;
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
        // 人工判读（project 为 null）仍必须明确选择合格/不合格。
        this.resultSelect.required = !triplex;
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
        if (this.timed?.active || this.entry?.sampling) return;
        // 允许重复选择同一张照片（部分浏览器对相同文件不再触发 change）。
        this.fileInput.value = ''; this.cameraInput.value = '';
        this.fallbackButton.hidden = true;
        if (source !== 'camera') this.lowResNote = '';
        if (!file) return;
        if (this.busy) return;
        if (file.size === 0 || file.size > 15 * 1024 * 1024) { this.say('请选择15MB以内的原始照片。'); return; }
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.file = file; this.source = source; this.invalidateResult();
        this.captureEvents = [...(source === 'camera' ? this.captureEvents || [] : []), cameraEvent('file_selected', { bytes: file.size })];
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
                id: attemptId, inputMode: 'auto', source: this.source, elapsedSeconds: null, timeSource: 'within_window', filename: file.name, clientEvents: this.captureEvents }) });
            this.processPanel.hidden = false; this.loadProcessLog();
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
            this.loadProcessLog();
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
            this.say([lines.join('；'), this.lowResNote, r.error, '未获得可用的自动结果，请直接手工选择合格／不合格；本次照片与识别过程已保留。'].filter(Boolean).join(' '));
        }
    }

    async restore() {
        if (this.timed?.active) { this.say('请先完成或结束本次自动采样，再恢复记录。'); return; }
        try {
            const id = sessionStorage.getItem(this.recoveryKey); if (!id) return;
            let { entry, attempts, samplingSummary } = await this.api(`/entries/${id}`);
            if (entry.status === 'completed') { sessionStorage.removeItem(this.recoveryKey); this.say('上次检测已保存，请刷新列表查看。'); return; }
            for (const [key, value] of Object.entries({ ...entry.context.customFields, ...entry.context })) {
                if (key === 'customFields') continue;
                const input = this.point.querySelector(`[name="${key}"],[name="${key}[]"]`) || this.form.querySelector(`[name="${key}"]`);
                if (input) input.value = value;
            }
            this.projectSelect.value = PROJECTS.find(p => p.id === entry.project_id).label;
            this.update();
            this.entry = entry; this.pendingEntryId = entry.id; this.pendingSignature = this.signature(); this.entrySignature = this.signature();
            if (entry.sampling?.state === 'running') {
                const ended = await this.api(`/entries/${id}/sampling/finish`, { method: 'POST', body: JSON.stringify({ id: entry.sampling.id, state: 'interrupted', reason: '页面重新打开，原定时采样不能确认连续完成' }) });
                this.entry = ended.entry; samplingSummary = ended.summary;
                attempts = (await this.api(`/entries/${id}`)).attempts;
            }
            this.samplingSummary = samplingSummary;
            this.processPanel.hidden = false; this.loadProcessLog();
            for (const attempt of attempts) if (!attempt.completed_at) await this.api(`/attempts/${attempt.id}/result`, { method: 'PUT', body: JSON.stringify({ status: 'interrupted', error: '页面重新打开，原识别未确认完成', channels: [] }) });
            const last = attempts.at(-1);
            if (entry.sampling ? samplingSummary?.eligible : last?.result?.eligible) {
                const adopted = entry.sampling ? attempts.find(a => a.id === samplingSummary.adoptedAttemptId) : last;
                this.result = adopted.result; this.attemptId = adopted.id; this.resultSignature = this.signature(); this.showResult();
            }
            else this.say('上次照片及识别尝试已恢复，可直接手工选择结果或重新拍照。');
        } catch (error) { this.say(error.message); }
    }

    // 返回 null 表示本点位不使用照片链路，交给原有手工保存流程。
    async saveIfNeeded() {
        if (this.timed?.active) throw new Error('请先完成或结束本次自动采样');
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
        this.timed?.destroy();
        clearInterval(this.ticker); this.ticker = null;
        clearInterval(this.processTicker); this.processPanel?.remove();
        this.closeWebcam();
        this.projectSelect?.removeEventListener('change', this.projectChangeHandler);
        this.resultSelect?.removeEventListener('change', this.resultChangeHandler);
        this.resultSelect?.removeEventListener('focus', this.resultFocusHandler);
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
            point.querySelectorAll('[data-colloidal-timed]').forEach(node => node.remove());
            point.querySelectorAll('[data-colloidal-process]').forEach(node => node.remove());
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
            content.append(el('p', `最终结果来源：${meta.resultSource === 'photo_auto' ? '照片自动识别' : '手工录入'}；录入过程：${({ direct_manual: '直接手工录入', auto_success: '自动识别成功', manual_after_auto_failure: '识别未完成有效判读后转手工', manual_after_photo: '照片识别后选择手工', manual_edit_after_photo: '照片录入后手工修改', auto_two_of_three_consistent: '三次中至少两次自动采样有效且一致', manual_after_sampling: '自动采样后转手工' })[meta.entryPath] || meta.entryPath}`));
            if (data.entry.sampling) {
                const s = data.entry.sampling;
                content.append(el('p', `三次采样：${samplingPlan(s.planId)?.label || s.planId}；状态：${({ consistent: '至少两次有效且一致', inconsistent: '有效结果未达到两次一致', incomplete: '有效采样不足', interrupted: '采样中断', running: '未确认结束' })[data.samplingSummary?.status] || '未知'}；有效 ${data.samplingSummary?.validCount || 0}/3；一致 ${data.samplingSummary?.agreeCount || 0}/3${data.samplingSummary?.hasDisagreement ? '；存在不同结论，已保留' : ''}${s.reason ? `；${s.reason}` : ''}`));
            }
            for (const attempt of data.attempts) {
                const r = attempt.result;
                let photoPromise;
                const loadPhoto = () => photoPromise ||= storage.requestOnlineResource(`/api/colloidal/records/${encodeURIComponent(record.id)}/photos/${attempt.id}`, { responseType: 'blob' }).catch(error => { photoPromise = null; throw error; });
                content.append(processLogPanel(attempt, { loadPhoto }));
                content.append(el('p', `${new Date(attempt.created_at).toLocaleString('zh-CN')} · ${attempt.photo_name || '照片'} · ${statusNames[r?.status] || '未确认完成'}${r?.error ? '：' + r.error : ''}`));
                if (attempt.sample_index) content.append(el('p', `第${attempt.sample_index}次采样 · 计划${formatElapsed(samplingPlan(data.entry.sampling?.planId)?.seconds[attempt.sample_index - 1] || 0)} · ${attempt.captured_at ? `实拍${formatElapsed(attempt.elapsed_seconds)}（${new Date(attempt.captured_at).toLocaleString('zh-CN')}）` : '未取得实际拍摄照片'}。`));
                if (r?.channels?.length) content.append(el('p', r.channels.map(c => `${PROJECTS.find(p => p.id === data.entry.project_id)?.channels.find(p => p.id === c.id)?.name || c.id}：${channelDescription(c)}`).join('；')));
                if (attempt.sample_index && r?.channels?.length) content.append(el('p', r.channels.filter(c => Number.isFinite(c.c) && Number.isFinite(c.t)).map(c => `${c.id}：C=${c.c.toFixed(2)}，T=${c.t.toFixed(2)}`).join('；')));
                if (attempt.photo_state === 'present') {
                    let photo;
                    try { photo = await loadPhoto(); }
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
