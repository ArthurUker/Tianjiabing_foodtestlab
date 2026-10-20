import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROJECTS, PIPELINE, CORE_COMMIT, projectById, uuid, fail, digest, canonical, normalizeContext, photoType, compactResult, elapsedValue, readRetentionDays } from '../lib/colloidalReader.js';
import { buildRecordPayload } from '../lib/recordNormalize.js';
import { finalizeColloidalEntry } from '../modules/ColloidalEntryService.js';
import { colloidalRecognizer } from '../lib/colloidalRecognizer.js';

export const photoRoot = () => path.resolve(process.env.COLLOIDAL_PHOTO_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../uploads/colloidal-originals'));
const safe = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e.status) res.status(e.status).json({ error: e.message, code: e.code }); else next(e); } };
const owner = async (req, id) => {
    if (!uuid(id)) throw fail(404, 'NOT_FOUND', '检测不存在');
    const entry = await req.db.colloidalEntry.findFirst({ where: { id, created_by: req.userId } });
    if (!entry) throw fail(404, 'NOT_FOUND', '检测不存在');
    return entry;
};
const attemptOwner = async (req, id) => {
    if (!uuid(id)) throw fail(404, 'NOT_FOUND', '识别尝试不存在');
    const attempt = await req.db.colloidalAttempt.findUnique({ where: { id } });
    if (!attempt) throw fail(404, 'NOT_FOUND', '识别尝试不存在');
    const entry = await owner(req, attempt.entry_id);
    return { attempt, entry };
};

export function createColloidalRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, authorizeRoles, storageRoot = photoRoot }) {
    const router = express.Router();
    router.use(authenticateUser);
    router.get('/state', safe(async (req, res) => {
        res.json({ projects: PROJECTS, pipeline: PIPELINE, coreCommit: CORE_COMMIT, maxPhotoBytes: 15 * 1024 * 1024, runtime: 'browser', retentionDays: readRetentionDays() });
    }));
    router.post('/entries', requireEditorOrAbove, safe(async (req, res) => {
        const { id, projectId, context } = req.body || {};
        const project = projectById(projectId);
        if (!uuid(id) || !project) throw fail(400, 'INVALID_ENTRY', '检测标识或项目无效');
        // 建单不再要求上下文完整（现场可能先拍照、后补检测员等）；完整性在 finalize 校验。
        const normalized = normalizeContext(context, project, { requireComplete: false });
        const existing = await req.db.colloidalEntry.findUnique({ where: { id } });
        if (existing) {
            if (existing.created_by !== req.userId) throw fail(404, 'NOT_FOUND', '检测不存在');
            if (existing.project_id !== projectId) throw fail(409, 'ENTRY_CONFLICT', '该检测已绑定其他项目或样本');
            if (existing.status !== 'open') throw fail(409, 'ENTRY_COMPLETED', '该检测已保存');
            if (canonical(existing.context) === canonical(normalized)) return res.json({ entry: existing });
            // 同一张卡在保存前补充/修正样本信息：就地更新，避免因上下文变化另建孤儿检测。
            const entry = await req.db.colloidalEntry.update({ where: { id: existing.id }, data: { context: normalized } });
            return res.json({ entry });
        }
        try {
            const entry = await req.db.colloidalEntry.create({ data: { id, project_id: projectId, module_code: project.module, context: normalized, created_by: req.userId } });
            res.status(201).json({ entry });
        } catch (e) { if (e.code === 'P2002') throw fail(409, 'ENTRY_RETRY', '检测正在建立，请使用相同标识重试'); throw e; }
    }));
    router.post('/entries/:id/attempts', requireEditorOrAbove, safe(async (req, res) => {
        const entry = await owner(req, req.params.id);
        if (entry.status !== 'open') throw fail(409, 'ENTRY_COMPLETED', '该检测已保存');
        const body = req.body || {};
        if (!uuid(body.id) || !['auto', 'board', 'closeup'].includes(body.inputMode) || !['camera', 'upload'].includes(body.source)) throw fail(400, 'INVALID_ATTEMPT', '拍照参数无效');
        const elapsed = elapsedValue(body.elapsedSeconds);
        // 现场确认拍摄处于说明书判读时限内时记 within_window（不伪造具体秒数）；
        // 其余情况沿用显式时距或 unknown。
        const requested = body.timeSource;
        const timeSource = elapsed === null ? (requested === 'within_window' ? 'within_window' : 'unknown') : requested;
        if (!['unknown', 'operator_reported', 'capture_timer', 'within_window'].includes(timeSource)) throw fail(400, 'INVALID_TIME_SOURCE', '时间来源无效');
        const data = { id: body.id, entry_id: entry.id, elapsed_seconds: elapsed, time_source: timeSource, input_mode: body.inputMode,
            source: body.source, photo_name: String(body.filename || 'photo').replace(/[\\/\r\n]/g, '_').slice(0, 150), pipeline: PIPELINE, core_commit: CORE_COMMIT };
        const previous = await req.db.colloidalAttempt.findUnique({ where: { id: body.id } });
        if (previous) {
            if (Object.keys(data).some(k => data[k] !== previous[k])) throw fail(409, 'ATTEMPT_CONFLICT', '相同识别标识对应不同输入');
            return res.json({ attempt: previous });
        }
        if (await req.db.colloidalAttempt.count({ where: { entry_id: entry.id } }) >= 30) throw fail(429, 'TOO_MANY_ATTEMPTS', '该检测的重拍次数过多，请重新建立检测');
        res.status(201).json({ attempt: await req.db.colloidalAttempt.create({ data }) });
    }));
    router.put('/attempts/:id/photo', requireEditorOrAbove, express.raw({ type: 'application/octet-stream', limit: '15mb' }), safe(async (req, res) => {
        const { attempt, entry } = await attemptOwner(req, req.params.id);
        const bytes = req.body;
        const kind = photoType(bytes), hash = digest(bytes);
        if (attempt.photo_sha256) {
            if (attempt.photo_sha256 !== hash) throw fail(409, 'PHOTO_CONFLICT', '该识别尝试已经绑定其他照片');
            if (attempt.photo_state !== 'present') throw fail(410, 'PHOTO_EXPIRED', '原照片已清理');
            return res.json({ sha256: hash });
        }
        if (entry.status !== 'open' || attempt.status !== 'uploading') throw fail(409, 'ATTEMPT_CLOSED', '识别尝试已结束');
        const scope = digest(req.tenantSchema || req.user?.schoolCode || 'public').slice(0, 24);
        const key = `${scope}/${attempt.id}.${kind.ext}`;
        const target = path.join(storageRoot(), key);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        try { await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code !== 'EEXIST') throw e; if (digest(await fs.readFile(target)) !== hash) throw fail(409, 'PHOTO_CONFLICT', '原照片内容冲突'); }
        const updated = await req.db.colloidalAttempt.updateMany({ where: { id: attempt.id, photo_sha256: null }, data: {
            photo_key: key, photo_mime: kind.mime, photo_sha256: hash, photo_size: bytes.length, photo_state: 'present',
        } });
        if (!updated.count) {
            const latest = await req.db.colloidalAttempt.findUnique({ where: { id: attempt.id } });
            if (latest?.photo_sha256 !== hash) throw fail(409, 'PHOTO_CONFLICT', '照片状态已改变，请查询当前识别尝试');
        }
        // A simultaneous interruption must not be reverted to running.
        await req.db.colloidalAttempt.updateMany({ where: { id: attempt.id, status: 'uploading', completed_at: null }, data: { status: 'running' } });
        res.json({ sha256: hash });
    }));
    const persistResult = async (db, attempt, entry, body) => {
        const result = compactResult(body, projectById(entry.project_id), attempt.elapsed_seconds, { assumeWithinTime: attempt.time_source === 'within_window' });
        if (attempt.result) {
            if (canonical(attempt.result) !== canonical(result)) throw fail(409, 'RESULT_IMMUTABLE', '原始识别结果不可覆盖');
            return attempt.result;
        }
        if (entry.status !== 'open') throw fail(409, 'ENTRY_COMPLETED', '该检测已保存');
        if (!attempt.photo_sha256 && !['upload_failed', 'interrupted', 'runtime_timeout', 'engine_error'].includes(result.status)) throw fail(409, 'PHOTO_REQUIRED', '请先保存原照片');
        const updated = await db.colloidalAttempt.updateMany({ where: { id: attempt.id, completed_at: null }, data: { result, status: result.eligible ? 'ready' : result.status === 'ok' ? 'candidate' : result.status === 'interrupted' ? 'interrupted' : 'failed', completed_at: new Date() } });
        if (!updated.count) throw fail(409, 'RESULT_IMMUTABLE', '识别结果已提交，请查询当前状态');
        return result;
    };
    router.put('/attempts/:id/result', requireEditorOrAbove, safe(async (req, res) => {
        const { attempt, entry } = await attemptOwner(req, req.params.id);
        res.json({ result: await persistResult(req.db, attempt, entry, req.body) });
    }));
    // 服务端识别：Node 队列串行调用常驻 Python 进程，前端不再运行识别代码。
    router.post('/attempts/:id/recognize', requireEditorOrAbove, safe(async (req, res) => {
        const { attempt, entry } = await attemptOwner(req, req.params.id);
        if (attempt.result) return res.json({ result: attempt.result, cached: true });
        if (entry.status !== 'open') throw fail(409, 'ENTRY_COMPLETED', '该检测已保存');
        if (!attempt.photo_sha256 || attempt.photo_state !== 'present' || !attempt.photo_key) throw fail(409, 'PHOTO_REQUIRED', '请先保存原照片');
        let recognized;
        try {
            recognized = await colloidalRecognizer().enqueue({
                photoPath: path.join(storageRoot(), attempt.photo_key),
                projectId: entry.project_id,
                mode: 'auto',
            });
        } catch (error) {
            if (error.status) throw fail(error.status, error.code || 'RECOGNIZER_BUSY', error.message);
            throw fail(503, error.code || 'RECOGNIZER_DOWN', `识别服务暂时不可用：${error.message}`);
        }
        const result = await persistResult(req.db, attempt, entry, recognized);
        res.json({ result, queue: colloidalRecognizer().status() });
    }));
    router.get('/recognition', authorizeRoles('manager', 'admin'), safe(async (req, res) => {
        res.json({ ...colloidalRecognizer().status(), runtime: process.env.COLLOIDAL_RECOGNIZER_HOME || '/mnt/datadisk0/foodsentinel/recognizer' });
    }));
    router.get('/entries/:id', requireEditorOrAbove, safe(async (req, res) => {
        const entry = await owner(req, req.params.id);
        const attempts = await req.db.colloidalAttempt.findMany({ where: { entry_id: entry.id }, orderBy: { created_at: 'asc' } });
        res.json({ entry, attempts: attempts.map(publicAttempt) });
    }));
    router.post('/entries/:id/finalize', requireEditorOrAbove, safe(async (req, res) => {
        const body = req.body || {};
        if (!['manual', 'auto'].includes(body.mode)) throw fail(400, 'INVALID_MODE', '结果录入方式无效');
        const response = await finalizeColloidalEntry({ db: req.db, entryId: req.params.id, userId: req.userId, body, ip: req.ip });
        res.json({ success: true, deduplicated: response.deduplicated, records: response.records.map(buildRecordPayload) });
    }));
    const recordEntry = async req => {
        const record = await req.db.testRecord.findUnique({ where: { id: req.params.recordId } });
        if (!record || (req.user?.role === 'guest' && !req.guestVisibleTypes?.includes(record.test_type))) throw fail(404, 'NOT_FOUND', '记录不存在');
        const entry = await req.db.colloidalEntry.findFirst({ where: { record_ids: { has: record.id } } });
        if (!entry) throw fail(404, 'NOT_FOUND', '该记录没有照片识别过程');
        return entry;
    };
    router.get('/records/:recordId', requireGuestReadOnly, safe(async (req, res) => {
        const entry = await recordEntry(req);
        const attempts = await req.db.colloidalAttempt.findMany({ where: { entry_id: entry.id }, orderBy: { created_at: 'asc' } });
        res.json({ entry, attempts: attempts.map(publicAttempt) });
    }));
    router.get('/records/:recordId/photos/:attemptId', requireGuestReadOnly, safe(async (req, res) => {
        const entry = await recordEntry(req);
        const attempt = await req.db.colloidalAttempt.findFirst({ where: { id: req.params.attemptId, entry_id: entry.id } });
        if (!attempt || attempt.photo_state === 'absent') throw fail(404, 'NOT_FOUND', '没有原照片');
        if (attempt.photo_state !== 'present') throw fail(410, 'PHOTO_EXPIRED', '原照片已按留存策略清理');
        if (!/^[a-f0-9]{24}\/[a-f0-9-]{36}\.(jpg|png|webp|heic)$/i.test(attempt.photo_key || '')) throw fail(500, 'INVALID_PHOTO_KEY', '照片索引无效');
        res.setHeader('Content-Type', attempt.photo_mime);
        res.setHeader('Content-Disposition', `inline; filename="original.${attempt.photo_key.split('.').pop()}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(await fs.readFile(path.join(storageRoot(), attempt.photo_key)));
    }));
    router.get('/storage', authorizeRoles('manager', 'admin'), safe(async (req, res) => {
        const [storage, states, entries, reasons, recordSources, dailyUploads] = await Promise.all([
            req.db.colloidalAttempt.aggregate({ where: { photo_state: 'present' }, _sum: { photo_size: true }, _count: true }),
            req.db.colloidalAttempt.groupBy({ by: ['status'], _count: true }),
            req.db.colloidalEntry.groupBy({ by: ['entry_path'], _count: true }),
            req.db.$queryRawUnsafe(`SELECT e.project_id, a.pipeline, COALESCE(a.result->>'status', 'unconfirmed') AS reason, COUNT(*)::int AS count
                FROM "ColloidalAttempt" a JOIN "ColloidalEntry" e ON e.id = a.entry_id
                GROUP BY e.project_id, a.pipeline, COALESCE(a.result->>'status', 'unconfirmed')`),
            req.db.$queryRawUnsafe(`SELECT COALESCE(result_data->>'resultSource', 'legacy_or_unspecified') AS source, COUNT(*)::int AS records
                FROM "TestRecord" WHERE test_type IN ('pesticide', 'leanMeat') GROUP BY COALESCE(result_data->>'resultSource', 'legacy_or_unspecified')`),
            req.db.$queryRawUnsafe(`SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*)::int AS photos, SUM(photo_size)::float8 AS bytes
                FROM "ColloidalAttempt" WHERE photo_sha256 IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
                GROUP BY DATE_TRUNC('day', created_at) ORDER BY day`),
        ]);
        res.json({ originals: storage._count, bytes: storage._sum.photo_size || 0, states, entries, reasons, recordSources, dailyUploads, retentionDays: readRetentionDays() });
    }));
    router.use((err, req, res, next) => {
        if (err.type === 'entity.too.large') return res.status(413).json(req.path.endsWith('/photo') ? { code: 'PHOTO_SIZE', error: '照片超过15MB' } : { code: 'METADATA_SIZE', error: '识别元数据超过32KB' });
        next(err);
    });
    return router;
}

function publicAttempt(a) {
    const { photo_key, ...rest } = a;
    return rest;
}
