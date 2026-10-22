import { newEntryId } from './contract.js';
import { SAMPLING_PLANS, SAMPLING_WINDOW, captureInSlot, formatElapsed } from './sampling.js';
import { CameraView } from './CameraView.js';
import { cameraEvent } from './ProcessLog.js';

let activeCamera = null;
const node = (tag, text = '', className = '') => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
const action = (text, handler) => { const n = node('button', text, 'colloidal-action'); n.type = 'button'; n.addEventListener('click', handler); return n; };

// A timed camera acquisition session, independent of server recognition latency.
// No production speed-up parameter: tests control browser time instead.
export class TimedSampling {
    constructor({ host, validate, prepare, start, sample, finish, report, lock, describe = () => '' }) {
        Object.assign(this, { host, validate, prepare, startRemote: start, sampleRemote: sample, finishRemote: finish, report, lock, describe });
        this.state = 'idle'; this.jobs = []; this.slots = []; this.token = 0;
        this.root = node('section', '', 'colloidal-timed'); this.root.dataset.colloidalTimed = '';
        this.openButton = action('开始自动检测（3次采样）', () => this.open());
        this.planSelect = node('select'); this.planSelect.setAttribute('aria-label', '自动采样时点');
        for (const p of Object.values(SAMPLING_PLANS)) this.planSelect.add(new Option(p.label, p.id));
        const label = node('label', '自动采样：'); label.append(this.planSelect);
        this.intro = node('p', '当前v5试用窗口：加样后5–8分钟。先填写信息，再预览相机；确认已加样后开始计时。请核对本次卡片说明书。');
        this.preview = node('div', '', 'colloidal-timed-preview'); this.preview.hidden = true;
        this.video = node('video', '', 'colloidal-timed-video'); this.video.autoplay = true; this.video.muted = true; this.video.playsInline = true;
        this.cameraView = new CameraView(this.video);
        this.startButton = action('已完成加样，开始计时', () => this.begin()); this.startButton.disabled = true;
        this.stopButton = action('结束本次自动采样', () => this.stop('操作者结束自动采样'));
        this.progress = node('p'); this.progress.setAttribute('role', 'status'); this.progress.setAttribute('aria-live', 'polite');
        this.list = node('ol');
        this.preview.append(this.cameraView.root, node('p', '保持检测卡和相机固定、光线均匀，保持页面在前台。三次都会自动拍照，无需逐张点快门。'), this.startButton, this.stopButton);
        this.root.append(label, this.openButton, this.intro, this.preview, this.progress, this.list); host.append(this.root);
        this.onVisibility = () => { if (document.hidden && this.needsCamera) this.stop('页面切到后台或锁屏，自动采样已中断'); };
        this.onPageHide = () => { if (this.needsCamera) this.stop('页面离开，自动采样已中断'); };
        document.addEventListener('visibilitychange', this.onVisibility);
        window.addEventListener('pagehide', this.onPageHide);
        this.removalObserver = new MutationObserver(() => { if (!this.host.isConnected) this.destroy(); });
        this.removalObserver.observe(document.body, { childList: true, subtree: true });
    }
    get active() { return ['opening', 'preview', 'starting', 'running', 'settling'].includes(this.state); }
    get needsCamera() { return this.active && (this.state !== 'settling' || this.slots.some(s => ['waiting', 'capturing'].includes(s.state))); }
    async open() {
        if (this.state !== 'idle') return;
        this.cancelReason = null; this.id = null; this.finishing = null; this.jobs = [];
        this.cameraEvents = [cameraEvent('camera_requested')];
        try { this.validate(); } catch (e) { this.progress.textContent = e.message; return; }
        if (activeCamera && activeCamera !== this) { this.progress.textContent = '已有检测在使用自动采样，请先完成或结束。'; return; }
        if (!navigator.mediaDevices?.getUserMedia) { this.progress.textContent = '自动采样需要HTTPS页面和浏览器相机权限，请改用拍照／上传或手工录入。'; return; }
        activeCamera = this; this.state = 'opening'; this.openButton.disabled = true; this.planSelect.disabled = true; this.lock(true);
        this.preview.hidden = false; this.progress.textContent = '正在准备检测单和相机…';
        const token = ++this.token;
        try {
            await this.prepare();
            if (token !== this.token) return;
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
            if (token !== this.token) { stream.getTracks().forEach(t => t.stop()); return; }
            this.stream = stream; this.video.srcObject = stream;
            if (document.hidden || !this.host.getClientRects().length) throw new Error('相机准备期间页面或点位已离开');
            this.monitor = setInterval(() => {
                if (this.needsCamera && (document.hidden || !this.host.getClientRects().length)) this.stop('页面或检测点位已离开');
            }, 500);
            for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => this.stop('相机连接中断，自动采样已结束'), { once: true });
            await this.video.play();
            await this.freshFrame();
            if (token !== this.token) return;
            this.state = 'preview'; this.startButton.disabled = false;
            this.cameraView.update(); this.cameraEvents.push(cameraEvent('camera_ready', { width: this.video.videoWidth, height: this.video.videoHeight }));
            this.progress.textContent = '相机已就绪。完成加样后立即点击确认按钮，以点击时刻作为计时零点。';
        } catch (e) {
            if (token !== this.token) return;
            this.progress.textContent = `无法准备自动采样：${e.message}。可继续使用拍照／上传或手工录入。`;
            this.release(); this.state = 'idle'; this.openButton.disabled = false; this.planSelect.disabled = false; this.preview.hidden = true; this.lock(false);
            if (activeCamera === this) activeCamera = null;
        }
    }
    async begin() {
        if (this.state !== 'preview') return;
        try { this.validate(); } catch (e) { this.progress.textContent = e.message; return; }
        if (document.hidden || !this.stream?.active) { this.stop('相机或页面未就绪'); return; }
        this.state = 'starting'; this.startButton.disabled = true;
        this.startMono = performance.now(); this.startWall = Date.now(); this.id = newEntryId();
        this.cameraEvents.push(cameraEvent('sampling_started'));
        this.plan = SAMPLING_PLANS[this.planSelect.value];
        this.slots = this.plan.seconds.map((seconds, i) => ({ index: i + 1, seconds, state: 'waiting' })); this.render();
        try {
            await this.startRemote({ id: this.id, planId: this.plan.id, startedAt: new Date(this.startWall).toISOString() });
            if (this.cancelReason) { await this.complete(); return; }
            this.state = 'running';
            this.interval = setInterval(() => this.poll(), 250); this.poll();
            // Optional wake-lock acquisition must never delay the first shot;
            // a late permission response after cancellation is released.
            if (navigator.wakeLock?.request) navigator.wakeLock.request('screen').then(lock => {
                if (this.needsCamera && !this.cancelReason) this.wakeLock = lock;
                else lock.release().catch(() => {});
            }).catch(() => {});
        } catch (e) { this.cancelReason ||= `加样计时登记未确认：${e.message}`; await this.complete(); }
    }
    elapsed() {
        const mono = (performance.now() - this.startMono) / 1000;
        const wall = (Date.now() - this.startWall) / 1000;
        if (Math.abs(mono - wall) > 3 || mono < 0) throw new Error('系统时间或页面计时异常，请重新检测');
        return Math.max(mono, wall);
    }
    poll() {
        if (this.state !== 'running') return;
        try {
            this.validate();
            if (!this.host.isConnected || !this.host.getClientRects().length || document.hidden || !this.stream?.active || this.video.paused || this.stream.getVideoTracks().some(t => t.muted)) throw new Error('相机、页面或检测点位已中断');
            const elapsed = this.elapsed();
            for (const slot of this.slots) {
                if (slot.state !== 'waiting' || elapsed < slot.seconds) continue;
                slot.state = 'capturing';
                const job = this.acquire(slot, elapsed > slot.seconds + SAMPLING_WINDOW.maxDelay);
                this.jobs.push(job);
            }
            this.render(elapsed);
            if (this.slots.every(s => s.state !== 'waiting')) this.complete();
        } catch (e) { this.stop(e.message); }
    }
    async acquire(slot, missed) {
        let capture;
        const events = [...this.cameraEvents, cameraEvent('capture_started', { sampleIndex: slot.index, ...this.cameraView.settings })];
        try {
            if (missed) throw new Error('未在计划时点拍照，未补拍替代');
            await this.freshFrame();
            if (this.cancelReason) throw new Error(this.cancelReason);
            const elapsed = this.elapsed();
            if (!captureInSlot(this.plan.id, slot.index, elapsed)) throw new Error('已错过本次采样时点，未补拍替代');
            const canvas = document.createElement('canvas');
            canvas.width = this.video.videoWidth; canvas.height = this.video.videoHeight;
            if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40_000_000) throw new Error('相机没有有效画面或分辨率过大');
            canvas.getContext('2d').drawImage(this.video, 0, 0);
            // This frame is the camera original: no crop, overlay or rescale.
            const capturedAt = new Date(this.startWall + elapsed * 1000).toISOString();
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
            canvas.width = 0; canvas.height = 0;
            if (!blob || !blob.size || blob.size > 15 * 1024 * 1024) throw new Error('相机照片生成失败或超过15MiB');
            capture = { file: new File([blob], `auto-${this.id}-${slot.index}.jpg`, { type: 'image/jpeg' }), elapsedSeconds: elapsed, capturedAt };
            events.push({ ...cameraEvent('photo_captured', { bytes: blob.size, width: this.video.videoWidth, height: this.video.videoHeight, elapsedSeconds: elapsed, ...this.cameraView.settings }), at: capturedAt });
            slot.state = 'processing'; slot.elapsed = elapsed; this.render();
        } catch (e) { capture = { file: null, elapsedSeconds: null, capturedAt: null, error: e.message }; events.push(cameraEvent('capture_failed')); slot.state = 'processing'; }
        if (this.slots.every(s => !['waiting', 'capturing'].includes(s.state))) this.release();
        try {
            const result = await this.sampleRemote({ ...capture, sampleIndex: slot.index, samplingId: this.id, clientEvents: events });
            slot.state = result?.eligible ? 'ready' : 'failed'; slot.error = result?.error || capture.error; slot.result = result;
        } catch (e) { slot.state = 'failed'; slot.error = `上传或识别未确认：${e.message}`; }
        this.render();
    }
    freshFrame() {
        return new Promise((resolve, reject) => {
            let frame, raf;
            const timeout = setTimeout(() => done(new Error('相机未提供新的画面')), 5000);
            const done = error => { clearTimeout(timeout); if (frame !== undefined) this.video.cancelVideoFrameCallback?.(frame); if (raf !== undefined) cancelAnimationFrame(raf); error ? reject(error) : resolve(); };
            if (this.video.requestVideoFrameCallback) frame = this.video.requestVideoFrameCallback(() => done());
            else {
                const previous = this.video.currentTime;
                const check = () => { if (this.video.readyState >= 2 && this.video.currentTime > previous) done(); else raf = requestAnimationFrame(check); };
                raf = requestAnimationFrame(check);
            }
        });
    }
    stop(reason) {
        if (!this.active) return;
        this.cancelReason ||= reason;
        ++this.token; this.release();
        if (!this.id) {
            this.state = 'idle'; this.openButton.disabled = false; this.planSelect.disabled = false; this.preview.hidden = true; this.lock(false);
            if (activeCamera === this) activeCamera = null;
            this.progress.textContent = reason; return;
        }
        // Starting request must settle before a finish request can refer to it.
        if (this.state !== 'starting') this.complete();
    }
    async complete() {
        if (this.finishing) return this.finishing;
        clearInterval(this.interval); this.interval = null; this.state = 'settling';
        this.finishing = (async () => {
            this.progress.textContent = this.cancelReason || '采样已结束，正在保存照片并等待三次识别…';
            await Promise.allSettled(this.jobs);
            this.release();
            try {
                const response = await this.finishRemote({ id: this.id, state: this.cancelReason ? 'interrupted' : 'completed', reason: this.cancelReason || null });
                for (const receipt of response.summary?.samples || []) {
                    const slot = this.slots[receipt.index - 1];
                    if (slot) Object.assign(slot, { state: receipt.eligible ? 'ready' : 'failed', elapsed: receipt.elapsedSeconds ?? undefined, error: receipt.error,
                        result: { channels: receipt.channels, eligible: receipt.eligible } });
                }
                this.render();
                this.report(response); this.state = 'finished';
                this.progress.textContent = response.summary?.eligible ? `三次中${response.summary.agreeCount}次有效且一致，可以保存自动结果。${response.summary.hasDisagreement ? '另一次结论不同，已保留供分析。' : ''}`
                    : `本次自动检测未取得至少两次有效且一致的采样。请重测或手工录入；三次过程保留。`;
            } catch (e) { this.state = 'finished'; this.progress.textContent = `采样已停止，但服务器结束状态未确认：${e.message}。请恢复本次录入后处理，不能直接采用自动结果。`; }
            this.preview.hidden = true; this.lock(false); this.stopButton.disabled = true;
            if (activeCamera === this) activeCamera = null;
        })();
        return this.finishing;
    }
    render(elapsed) {
        if (elapsed !== undefined) this.progress.textContent = `已加样 ${formatElapsed(elapsed)}；自动采样 ${this.plan.label}；判读窗口5:00–8:00。`;
        this.list.replaceChildren(...this.slots.map(s => node('li', `第${s.index}次 · 计划${formatElapsed(s.seconds)}${s.elapsed !== undefined ? ` · 实拍${formatElapsed(s.elapsed)}` : ''} · ${{ waiting: '等待', capturing: '拍照中', processing: '已拍照，上传识别中', ready: '识别有效', failed: '未取得有效结果' }[s.state]}${s.error ? `：${s.error}` : ''}${s.result ? `；${this.describe(s.result)}` : ''}`)));
    }
    release() {
        clearInterval(this.interval); this.interval = null;
        clearInterval(this.monitor); this.monitor = null;
        this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; this.video.srcObject = null;
        this.wakeLock?.release().catch(() => {}); this.wakeLock = null;
    }
    destroy() {
        this.cameraView.destroy();
        this.removalObserver.disconnect();
        this.stop('检测点位或页面已关闭'); this.release();
        document.removeEventListener('visibilitychange', this.onVisibility); window.removeEventListener('pagehide', this.onPageHide);
        this.root.remove();
    }
}
