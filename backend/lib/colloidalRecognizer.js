import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 服务端识别调度：单常驻 Python 进程 + FIFO 队列（并发 1）。
// 不监听端口；子进程由后端拉起，退出后自动重启。
const HOME = () => process.env.COLLOIDAL_RECOGNIZER_HOME || '/mnt/datadisk0/foodsentinel/recognizer';
const PYTHON = () => process.env.COLLOIDAL_RECOGNIZER_PYTHON || 'python3';

export class ColloidalRecognizer {
    constructor({ concurrency = 1, maxQueue = 50, timeoutMs = 90000, log = console } = {}) {
        this.concurrency = Math.max(1, Math.min(concurrency, 2));
        this.maxQueue = maxQueue;
        this.timeoutMs = timeoutMs;
        this.log = log;
        this.queue = [];
        this.active = 0;
        this.child = null;
        this.buffer = '';
        this.pending = new Map();
        this.stats = { queued: 0, done: 0, failed: 0, timedOut: 0, restarts: 0, lastMs: null };
    }

    depth() { return this.queue.length + this.active; }

    /** 启动即拉起常驻进程（首次识别少等约 0.6 秒导入时间）。失败不影响服务。 */
    prewarm() {
        try { this._ensureChild(); } catch { /* 首次请求时会重试 */ }
    }

    status() {
        return { concurrency: this.concurrency, depth: this.depth(), pending: this.active, ...this.stats };
    }

    enqueue({ photoPath, projectId, mode = 'auto' }) {
        if (this.depth() >= this.maxQueue) {
            const error = new Error('识别排队已满，请稍后重试');
            error.status = 503; error.code = 'RECOGNIZER_BUSY';
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ id: randomUUID(), photoPath, projectId, mode, resolve, reject, enqueuedAt: Date.now(), tries: 0 });
            this.stats.queued += 1;
            this._pump();
        });
    }

    _pump() {
        while (this.active < this.concurrency && this.queue.length > 0) {
            const job = this.queue.shift();
            this.active += 1;
            this._runJob(job).finally(() => { this.active -= 1; this._pump(); });
        }
    }

    async _runJob(job) {
        const startedAt = Date.now();
        try {
            const message = await this._send({ id: job.id, path: job.photoPath, projectId: job.projectId, mode: job.mode });
            if (message.error) throw Object.assign(new Error(message.error), { code: 'RECOGNIZER_ERROR' });
            if (!message.result) throw Object.assign(new Error('识别未返回结果'), { code: 'RECOGNIZER_EMPTY' });
            this.stats.done += 1;
            this.stats.lastMs = Date.now() - startedAt;
            job.resolve(message.result);
        } catch (error) {
            // 进程级失败重试一次；业务失败（decode/structure）不重试。
            if (!error.status && job.tries < 1 && !error.code) {
                job.tries += 1;
                this.log.warn?.(`[colloidal-recognizer] 重试任务 ${job.id.slice(0, 8)}：${error.message}`);
                this.queue.unshift(job);
                return;
            }
            this.stats.failed += 1;
            job.reject(error);
        }
    }

    _send(payload) {
        return new Promise((resolve, reject) => {
            const child = this._ensureChild();
            if (!child) { reject(Object.assign(new Error('识别进程不可用'), { code: 'RECOGNIZER_DOWN' })); return; }
            const timer = setTimeout(() => {
                this.pending.delete(payload.id);
                this.stats.timedOut += 1;
                this._killChild();
                reject(Object.assign(new Error('识别超时，请重试或手工录入'), { status: 504, code: 'RECOGNIZER_TIMEOUT' }));
            }, this.timeoutMs);
            this.pending.set(payload.id, { resolve, reject, timer });
            try { child.stdin.write(JSON.stringify(payload) + '\n'); }
            catch (error) { clearTimeout(timer); this.pending.delete(payload.id); reject(error); }
        });
    }

    _ensureChild() {
        if (this.child && !this.child.killed) return this.child;
        try {
            const child = spawn(PYTHON(), [path.join(HOME(), 'worker.py')], {
                env: { ...process.env, COLLOIDAL_RECOGNIZER_HOME: HOME(), PYTHONPATH: [path.join(HOME(), 'site-packages'), path.join(HOME(), 'core')].join(path.delimiter), PYTHONUNBUFFERED: '1' },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', chunk => this._onData(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => this.log.warn?.(`[colloidal-recognizer] ${String(chunk).trim().slice(0, 300)}`));
            child.on('exit', (code, signal) => {
                if (this.child === child) this.child = null;
                this.buffer = '';
                for (const [id, entry] of this.pending) {
                    clearTimeout(entry.timer);
                    entry.reject(Object.assign(new Error(`识别进程退出（code=${code}, signal=${signal}）`), { code: 'RECOGNIZER_DOWN' }));
                    this.pending.delete(id);
                }
            });
            this.child = child;
            return child;
        } catch (error) {
            this.log.error?.(`[colloidal-recognizer] 启动失败：${error.message}`);
            return null;
        }
    }

    _onData(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.ready) continue;
            const entry = this.pending.get(message.id);
            if (!entry) continue;
            clearTimeout(entry.timer);
            this.pending.delete(message.id);
            entry.resolve(message);
        }
    }

    _killChild() {
        if (!this.child) return;
        this.stats.restarts += 1;
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
        this.child = null;
    }

    shutdown() {
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Object.assign(new Error('服务正在重启'), { code: 'RECOGNIZER_DOWN' })); }
        this.pending.clear();
        for (const job of this.queue.splice(0)) job.reject(Object.assign(new Error('服务正在重启'), { code: 'RECOGNIZER_DOWN' }));
        this._killChild();
    }
}

let singleton = null;
export function colloidalRecognizer() {
    if (!singleton) {
        singleton = new ColloidalRecognizer({
            concurrency: Number(process.env.COLLOIDAL_RECOGNIZER_CONCURRENCY || 1),
            maxQueue: Number(process.env.COLLOIDAL_RECOGNIZER_MAX_QUEUE || 50),
            timeoutMs: Number(process.env.COLLOIDAL_RECOGNIZER_TIMEOUT_MS || 90000),
        });
    }
    return singleton;
}
