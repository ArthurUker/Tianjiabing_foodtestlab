// Opt-in local research capture archive. Never enables itself in production.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const validId = value => /^[a-f0-9-]{36}$/i.test(value || '');
const clean = (value, limit = 120) => String(value || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, limit);
const error = (status, message) => Object.assign(new Error(message), { status });

export function localTrainingConfig(env = process.env) {
    if (!env.COLLOIDAL_TRAINING_ARCHIVE_DIR) return null;
    const db = new URL(env.DATABASE_URL || 'file:///disabled');
    const root = path.resolve(env.COLLOIDAL_TRAINING_ARCHIVE_DIR);
    if (env.NODE_ENV !== 'test' || !['postgres:', 'postgresql:'].includes(db.protocol) ||
        db.hostname !== '127.0.0.1' || db.port !== '55439' || db.pathname !== '/colloidal_fixture' ||
        !root.startsWith(path.join(repo, '.cache')+path.sep)) throw new Error('Training collection requires the isolated local fixture');
    return { root, python: env.COLLOIDAL_TRAINING_PYTHON,
        model: env.COLLOIDAL_TRAINING_MODEL,
        worker: path.join(repo, 'scripts/colloidal_ai/collection_worker.py') };
}

export class TrainingArchive {
    constructor(config, predict = null) {
        this.config = config; this.predictOverride = predict; this.locks = new Map();
        this.queue = []; this.queued = new Set(); this.running = false; this.child = null;
        this.pending = new Map(); this.session = randomUUID();
    }
    scope(identity) { return sha(Buffer.from(`${identity.tenant}:${identity.userId}`)).slice(0, 24); }
    capturePath(identity, id) {
        if (!validId(id)) throw error(400, '照片标识无效');
        return path.join(this.config.root, 'captures', this.scope(identity), `${id}.json`);
    }
    async atomicJson(file, record) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${randomUUID()}.tmp`;
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(record, null, 2)+'\n'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temp, file);
    }
    async locked(key, operation) {
        const previous = this.locks.get(key) || Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        this.locks.set(key, result);
        try { return await result; } finally { if (this.locks.get(key) === result) this.locks.delete(key); }
    }
    async get(identity, id) {
        try { return JSON.parse(await fs.readFile(this.capturePath(identity, id), 'utf8')); }
        catch (e) { if (e.code === 'ENOENT') throw error(404, '没有该照片记录'); throw e; }
    }
    async save({ identity, id, bytes, mime, ext, metadata = {} }) {
        const target = this.capturePath(identity, id);
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 15*1024*1024) throw error(400, '照片须为15MB以内的非空文件');
        return this.locked(target, async () => {
            const hash = sha(bytes);
            let existing;
            try { existing = JSON.parse(await fs.readFile(target, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            if (existing) {
                if (existing.photo_sha256 !== hash) throw error(409, '同一拍照标识已保存其他内容，请勿替换');
                if (['pending', 'processing'].includes(existing.ai_state)) this.enqueue(target);
                return { record: existing, reused: true };
            }
            const objectKey = `objects/${hash.slice(0, 2)}/${hash}.${/^(jpg|png|webp|heic|bin)$/.test(ext) ? ext : 'bin'}`;
            const object = path.join(this.config.root, objectKey);
            await fs.mkdir(path.dirname(object), { recursive: true, mode: 0o700 });
            let handle;
            try { handle = await fs.open(object, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); }
            catch (e) { if (e.code !== 'EEXIST') throw e; if (sha(await fs.readFile(object)) !== hash) throw error(500, '原图哈希校验失败'); }
            finally { if (handle) await handle.close(); }
            const captured = new Date(metadata.capturedAt || 'invalid');
            const record = {
                schema_version: 1, capture_id: id, photo_sha256: hash, object_key: objectKey,
                bytes: bytes.length, mime, received_at: new Date().toISOString(),
                captured_at_client: Number.isFinite(captured.getTime()) ? captured.toISOString() : null,
                capture_time_authority: 'client_reported_not_verified',
                capture_session_id: clean(metadata.sessionId) || this.session,
                physical_card_group: clean(metadata.physicalCardGroup) || null,
                background: clean(metadata.background) || '未注明',
                source: clean(metadata.source, 40) || 'upload',
                filename: clean(metadata.filename, 150),
                selected_project_metadata_only: clean(metadata.projectId, 80) || null,
                business_entry_id: clean(metadata.entryId, 40) || null,
                purpose: metadata.purpose === 'verification' ? 'verification' : 'training',
                original_bytes_preserved: true, annotation_status: 'unreviewed',
                training_assignment: 'unassigned', human_reviewed_labels: null,
                ai_state: 'pending', ai_prediction: null, production_approved: false,
            };
            await this.atomicJson(target, record);
            this.enqueue(target);
            return { record, reused: false };
        });
    }
    enqueue(file) {
        if (this.queued.has(file)) return;
        this.queued.add(file); this.queue.push(file);
        setImmediate(() => this.drain().catch(() => {}));
    }
    async resume() {
        const root = path.join(this.config.root, 'captures');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        for (const scope of await fs.readdir(root)) {
            if (!/^[a-f0-9]{24}$/.test(scope)) continue;
            for (const file of await fs.readdir(path.join(root, scope))) {
                if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
                const full = path.join(root, scope, file);
                const row = JSON.parse(await fs.readFile(full, 'utf8'));
                if (['pending', 'processing'].includes(row.ai_state)) this.enqueue(full);
            }
        }
    }
    async list(identity) {
        const dir = path.dirname(this.capturePath(identity, randomUUID()));
        let names; try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
        const rows = await Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/i.test(n)).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
        return rows.sort((a, b) => b.received_at.localeCompare(a.received_at));
    }
    publicRecord(record) {
        const { object_key, ...publicRow } = record;
        return publicRow;
    }
    async predict(file) {
        if (this.predictOverride) return this.predictOverride(file);
        if (!this.child) {
            const child = spawn(this.config.python, [this.config.worker, '--model', this.config.model], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PYTHONUNBUFFERED: '1' } });
            this.child = child;
            let diagnostic = '';
            child.stderr.on('data', b => { diagnostic = (diagnostic+b.toString()).slice(-800); });
            readline.createInterface({ input: child.stdout }).on('line', line => {
                try {
                    const message = JSON.parse(line); const pending = this.pending.get(message.id);
                    if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
                } catch { /* Only bounded JSON responses are used. */ }
            });
            const ended = () => {
                if (this.child === child) this.child = null;
                for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(diagnostic || '本地AI进程退出，原照片已保存')); }
                this.pending.clear();
            };
            child.on('error', ended); child.on('exit', ended);
        }
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); this.child?.kill('SIGTERM'); reject(new Error('AI定位超时，原照片已保存')); }, 90000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, path: file })+'\n', e => { if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } });
        });
    }
    async drain() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                const file = this.queue.shift();
                try {
                    let record = JSON.parse(await fs.readFile(file, 'utf8'));
                    record.ai_state = 'processing'; await this.atomicJson(file, record);
                    try {
                        record.ai_prediction = await this.predict(path.join(this.config.root, record.object_key));
                        record.ai_state = 'completed';
                    } catch (e) { record.ai_state = 'failed'; record.ai_error = clean(e.message, 300); }
                    record.ai_completed_at = new Date().toISOString();
                    await this.atomicJson(file, record);
                } finally { this.queued.delete(file); }
            }
        } finally { this.running = false; }
    }
}

let singleton;
export function trainingArchive() {
    if (singleton) return singleton;
    const config = localTrainingConfig();
    if (!config) return null;
    singleton = new TrainingArchive(config);
    singleton.resume().catch(e => console.warn('[local-training] archive resume:', e.message));
    return singleton;
}
