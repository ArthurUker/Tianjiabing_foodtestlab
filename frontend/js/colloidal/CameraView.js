// Display-only orientation. Captures always draw the untouched video frame.
const PREVIEW_SETTINGS_KEY = 'colloidal_camera_preview_v1';

export class CameraView {
    constructor(video) {
        this.video = video; this.rotation = 0; this.mirrorX = false; this.mirrorY = false;
        this.restoreSettings();
        this.root = document.createElement('div'); this.root.className = 'colloidal-camera-view';
        this.stage = document.createElement('div'); this.stage.className = 'colloidal-camera-stage'; this.stage.append(video);
        this.controls = document.createElement('div'); this.controls.className = 'colloidal-camera-controls';
        const button = (label, change, toggle = null) => {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'colloidal-action'; b.textContent = label;
            if (toggle) b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', () => {
                change(); this.update();
                try { localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(this.settings)); }
                catch (_) { /* Preview controls remain usable if persistence is unavailable. */ }
            }); this.controls.append(b); return b;
        };
        button('左转90°', () => { this.rotation = (this.rotation + 270) % 360; });
        button('右转90°', () => { this.rotation = (this.rotation + 90) % 360; });
        this.horizontal = button('左右镜像', () => { this.mirrorX = !this.mirrorX; }, true);
        this.vertical = button('上下翻转', () => { this.mirrorY = !this.mirrorY; }, true);
        button('复位', () => { this.rotation = 0; this.mirrorX = false; this.mirrorY = false; });
        this.caption = document.createElement('p'); this.caption.className = 'colloidal-hint';
        this.root.append(this.stage, this.controls, this.caption);
        this.onResize = () => this.update(); this.observer = new ResizeObserver(this.onResize); this.observer.observe(this.root);
        video.addEventListener('loadedmetadata', this.onResize); video.addEventListener('resize', this.onResize);
        window.addEventListener('resize', this.onResize); this.update();
    }
    restoreSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY));
            this.rotation = saved && [0, 90, 180, 270].includes(saved.previewRotation) ? saved.previewRotation : 0;
            this.mirrorX = saved?.previewMirrorX === true;
            this.mirrorY = saved?.previewMirrorY === true;
        } catch (_) { /* Storage unavailable or invalid: keep the current preview. */ }
    }
    get settings() { return { previewRotation: this.rotation, previewMirrorX: this.mirrorX, previewMirrorY: this.mirrorY }; }
    update() {
        const vw = this.video.videoWidth || 1920, vh = this.video.videoHeight || 1080;
        const rotated = this.rotation % 180 !== 0;
        const available = this.root.clientWidth || 300;
        const height = Math.min(available * (rotated ? vw / vh : vh / vw), window.innerHeight * .48);
        this.stage.style.height = `${Math.max(100, height)}px`;
        const scale = Math.min(available / (rotated ? vh : vw), Math.max(100, height) / (rotated ? vw : vh));
        Object.assign(this.video.style, { width: `${vw * scale}px`, height: `${vh * scale}px`,
            transform: `translate(-50%, -50%) scaleX(${this.mirrorX ? -1 : 1}) scaleY(${this.mirrorY ? -1 : 1}) rotate(${this.rotation}deg)` });
        this.horizontal.setAttribute('aria-pressed', String(this.mirrorX)); this.vertical.setAttribute('aria-pressed', String(this.mirrorY));
        this.caption.textContent = `预览旋转${this.rotation}°${this.mirrorX ? ' · 左右镜像' : ''}${this.mirrorY ? ' · 上下翻转' : ''}。完整显示画面；仅调整预览，识别与原图保存使用相机原始方向。`;
    }
    destroy() {
        this.observer.disconnect(); this.video.removeEventListener('loadedmetadata', this.onResize); this.video.removeEventListener('resize', this.onResize);
        window.removeEventListener('resize', this.onResize); this.root.remove();
    }
}
