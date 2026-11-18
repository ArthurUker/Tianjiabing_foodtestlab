import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { photoType } from '../lib/colloidalReader.js';
import { trainingArchive } from '../lib/colloidalTrainingArchive.js';

export const captureIdentity = req => ({ tenant: req.tenantSchema || req.user?.schoolCode || 'public', userId: req.userId });
const safe = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); } };

export function createColloidalTrainingRoutes({ requireEditorOrAbove }) {
    const archive = trainingArchive();
    if (!archive) return null;
    const router = express.Router();
    router.use(requireEditorOrAbove);
    router.use((req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    router.get('/captures', safe(async (req, res) => {
        const rows = await archive.list(captureIdentity(req));
        res.json({ enabled: true, captures: rows.map(r => archive.publicRecord(r)),
            trainingCaptures: rows.filter(r => r.purpose === 'training').length,
            verificationCaptures: rows.filter(r => r.purpose === 'verification').length });
    }));
    router.post('/captures/:id', express.raw({ type: 'application/octet-stream', limit: '15mb' }), safe(async (req, res) => {
        let metadata = {};
        try { metadata = JSON.parse(decodeURIComponent(String(req.headers['x-capture-metadata'] || '%7B%7D'))); }
        catch { return res.status(400).json({ error: '拍摄信息格式无效' }); }
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return res.status(400).json({ error: '拍摄信息须为对象' });
        let type;
        try { type = photoType(req.body); } catch { type = { mime: 'application/octet-stream', ext: 'bin' }; }
        const saved = await archive.save({ identity: captureIdentity(req), id: req.params.id,
            bytes: req.body, mime: type.mime, ext: type.ext, metadata });
        res.status(saved.reused ? 200 : 201).json({ capture: archive.publicRecord(saved.record),
            originalSaved: true, annotationStatus: 'unreviewed' });
    }));
    router.get('/captures/:id', safe(async (req, res) => res.json({ capture: archive.publicRecord(await archive.get(captureIdentity(req), req.params.id)) })));
    router.get('/captures/:id/photo', safe(async (req, res) => {
        const row = await archive.get(captureIdentity(req), req.params.id);
        res.setHeader('Content-Type', row.mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(await fs.readFile(path.join(archive.config.root, row.object_key)));
    }));
    return router;
}
