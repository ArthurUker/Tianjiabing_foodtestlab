// Real PG, isolated loopback fixture only. This file never loads backend/.env.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { createColloidalRoutes } from '../../routes/colloidalRoutes.js';
import { provisionSchool, compareTenantStructureToPublic } from '../../lib/tenantProvisioner.js';
import { createTenantClient, disconnectAllTenantClients, schemaNameOf } from '../../lib/tenantClient.js';
import { createAuthMiddleware } from '../../middleware/authMiddleware.js';
import { PIPELINE, PROJECTS } from '../../lib/colloidalReader.js';
import { purgeOriginals } from '../../lib/colloidalRetention.js';
import { createRecordRoutes } from '../../routes/recordRoutes.js';
import { appendProcessEvents, processEvent } from '../../lib/colloidalProcessLog.js';

const dbUrl = process.env.COLLOIDAL_TEST_DATABASE_URL;
const enabled = Boolean(dbUrl);
let prisma, server, base, root, users = {}, dbs = {}, codes;
let browser;
// Camera/UI workflow tests use deterministic recognizer receipts; optical
// equivalence is a separate Python-core check, not a claim about these frames.
let recognitionOverride = null;
const rawResult = projectId => ({ status: 'ok', version: PIPELINE, channels: PROJECTS.find(p => p.id === projectId).channels.map(c => ({ id: c.id, status: 'ok', c: 10, t: 20, c_present: true })) });
const context = { testDate: '2026-10-19', canteen: '一食堂', inspector: '测试员', meatType: '鱼、虾', vegetableType: '白菜', remark: '', customFields: { sampleNo: 'S-1' } };
const png = Buffer.from('89504e470d0a1a0a112233445566', 'hex');
const id = () => randomUUID();
async function request(endpoint, body, { tenant = 'a', role = 'operator', method = body === undefined ? 'GET' : 'POST', binary = false, anonymous = false } = {}) {
    const response = await fetch(base + endpoint, { method, headers: { ...(anonymous ? {} : { 'X-Fixture-Tenant': tenant, 'X-Fixture-Role': role }), 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
    const data = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data };
}
async function entry(projectId = 'lead') {
    const entryId = id();
    const r = await request('/entries', { id: entryId, projectId, context }); assert.equal(r.status, 201, JSON.stringify(r.data));
    return entryId;
}
async function attempt(entryId, { project = 'lead', elapsed = 360, report, upload = true } = {}) {
    const attemptId = id();
    assert.equal((await request(`/entries/${entryId}/attempts`, { id: attemptId, inputMode: 'closeup', source: 'upload', elapsedSeconds: elapsed, timeSource: 'operator_reported', filename: '客户原图.png' })).status, 201);
    if (upload) assert.equal((await request(`/attempts/${attemptId}/photo`, png, { method: 'PUT', binary: true })).status, 200);
    const result = report || { status: 'ok', version: PIPELINE, channels: [{ id: project, status: 'ok', c: 10, t: 20, c_present: true }] };
    assert.equal((await request(`/attempts/${attemptId}/result`, result, { method: 'PUT' })).status, 200);
    return attemptId;
}

before(async () => {
    if (!enabled) return;
    const url = new URL(dbUrl);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/colloidal_fixture');
    process.env.DATABASE_URL = dbUrl;
    // eslint-disable-next-line no-restricted-syntax -- Isolated fixture base client after explicit loopback/database admission checks; tenant clients use the shared factory.
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const [{ data_directory: directory }] = await prisma.$queryRawUnsafe('SHOW data_directory');
    assert.ok(directory.includes('/.cache/colloidal-integration-'), 'Refuse a database outside this task fixture');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'colloidal-photo-fixture-'));
    const stamp = crypto.randomBytes(4).toString('hex'); codes = { a: `cg-a-${stamp}`, b: `cg-b-${stamp}` };
    for (const [key, code] of Object.entries(codes)) {
        await provisionSchool({ prisma, code, name: `胶体金隔离测试${key}`, adminUsername: 'fixturemanager', adminPassword: crypto.randomBytes(24).toString('hex'), databaseUrl: dbUrl });
        dbs[key] = createTenantClient(prisma, code);
        users[key] = await dbs[key].user.create({ data: { username: 'fixtureoperator', password_hash: 'fixture-only', role: 'operator', school_code: code } });
    }
    const guards = createAuthMiddleware({}, prisma);
    const authenticateUser = (req, res, next) => {
        const browserFixture = req.get('authorization') === 'Bearer local-colloidal-fixture';
        const tenant = req.get('X-Fixture-Tenant') || (browserFixture ? 'a' : null), role = req.get('X-Fixture-Role') || (browserFixture ? 'operator' : null);
        if (!dbs[tenant] || !role) return res.status(401).json({ error: 'unauthorized' });
        req.db = dbs[tenant]; req.userId = users[tenant].id;
        req.tenantSchema = schemaNameOf(codes[tenant]); req.user = { userId: req.userId, role, schoolCode: codes[tenant] }; next();
    };
    const app = express(); app.use(express.json({ limit: '32kb' }));
    const routeOptions = { authenticateUser, authorizeRoles: guards.authorizeRoles, requireEditorOrAbove: guards.requireEditorOrAbove, requireGuestReadOnly: (req, res, next) => { req.guestVisibleTypes = ['pesticide', 'leanMeat']; next(); }, storageRoot: () => root,
        recognizer: () => ({ enqueue: async ({ projectId, onEvent }) => {
            await onEvent?.('algorithm_dispatched', 'started', { wait_ms: 1 });
            return recognitionOverride ? recognitionOverride(projectId) : rawResult(projectId);
        }, status: () => ({ fixture: true }) }) };
    app.use('/api/colloidal', createColloidalRoutes(routeOptions));
    app.use(createRecordRoutes({ ...routeOptions, idempotencyMiddleware: (req, res, next) => next() }));
    if (process.env.COLLOIDAL_BROWSER_MODULE) {
        app.get('/ui', (req, res) => res.type('html').send(fixturePage(codes.a)));
        app.get('/ui-lean', (req, res) => res.type('html').send(fixturePage(codes.a).replaceAll('pesticide', 'leanMeat').replaceAll('克百威', '恩诺沙星').replaceAll('水胺硫磷', '氟苯尼考').replace('<input name="vegetableType" value="白菜">', '<select name="meatType"><option>鱼、虾</option></select>')));
        app.use('/fixtures', express.static(path.resolve('.cache/colloidal-integration-20261019')));
        app.use(express.static(path.resolve('frontend')));
        const playwright = await import(process.env.COLLOIDAL_BROWSER_MODULE);
        const executablePath = process.env.COLLOIDAL_CHROMIUM_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
        browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
            args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    }
    // Legacy fixture URLs stay available for direct HTTP assertions.
    app.use(createColloidalRoutes(routeOptions));
    app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    if (!enabled) return;
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await disconnectAllTenantClients();
    if (prisma) await prisma.$disconnect();
    if (root) await fs.rm(root, { recursive: true, force: true });
});
const check = (name, fn) => test(name, { skip: !enabled }, fn);

check('recognition process log preserves acquisition, queue, algorithm and verdict, across manual fallback and tenant boundaries', async () => {
    const e = await entry('carbofuran'), a = id(), at = new Date().toISOString();
    const made = await request(`/entries/${e}/attempts`, { id: a, inputMode: 'auto', source: 'camera', elapsedSeconds: 360, timeSource: 'operator_reported', filename: 'log-check.png',
        clientEvents: [{ at, stage: 'photo_captured', details: { width: 1920, height: 1080, previewRotation: 90, token: 'secret' } }, { at, stage: 'measurement' }] });
    assert.equal(made.status, 201);
    assert.equal((await request(`/attempts/${a}/photo`, png, { method: 'PUT', binary: true })).status, 200);
    recognitionOverride = () => ({ status: 'ok', version: PIPELINE, channels: [{ id: 'carbofuran', status: 'ok', c: 2.436, t: 2.869, c_present: false }],
        process_log: [{ at, stage: 'window_candidates', state: 'warning', elapsed_ms: 5, details: { count: 0 } },
            { at, stage: 'measurement', state: 'warning', elapsed_ms: 15, details: { c: 2.436, threshold: 3, c_present: false } }] });
    try {
        const recognized = await request(`/attempts/${a}/recognize`, {}); assert.equal(recognized.status, 200, JSON.stringify(recognized.data));
        assert.equal(recognized.data.result.eligible, false);
        const log = recognized.data.processLog;
        assert.deepEqual(log.map(x => x.stage), ['photo_captured', 'attempt_registered', 'photo_upload_started', 'photo_stored', 'recognition_queued', 'algorithm_dispatched', 'window_candidates', 'measurement', 'verdict']);
        assert.equal(JSON.stringify(log).includes('secret'), false); assert.equal(log[0].origin, 'browser');
        assert.equal(log.find(x => x.stage === 'measurement').details.threshold, 3);
        const repeated = await request(`/attempts/${a}/recognize`, {}); assert.deepEqual(repeated.data.processLog, log);
        await Promise.all(Array.from({ length: 5 }, (_, i) => appendProcessEvents(dbs.a, a, [processEvent('fixture_concurrency', 'ok', { index: i })])));
        const row = (await request(`/entries/${e}`)).data.attempts[0]; assert.equal(row.process_log.length, log.length + 5);
        const saved = await request(`/entries/${e}/finalize`, { mode: 'manual', manualResults: { carbofuran: '合格' } }); assert.equal(saved.status, 200);
        const recordId = saved.data.records[0].id;
        const details = await request(`/records/${recordId}`, undefined, { role: 'viewer' }); assert.equal(details.data.attempts[0].process_log.length, log.length + 5);
        assert.equal((await request(`/records/${recordId}`, undefined, { tenant: 'b' })).status, 404);
    } finally { recognitionOverride = null; }
});

check('migration replay creates identical public and both tenant structures', async () => {
    for (const code of Object.values(codes)) {
        const parity = await compareTenantStructureToPublic(prisma, { schema: schemaNameOf(code) });
        assert.equal(parity.ok, true, JSON.stringify(parity));
    }
});

check('draft original visualization requires owner, editor role and matching tenant; purged originals return 410', async () => {
    const e = await entry('carbofuran'), a = await attempt(e, { project: 'carbofuran' });
    const photo = await request(`/attempts/${a}/photo`); assert.equal(photo.status, 200); assert.deepEqual(photo.data, png);
    assert.equal((await request(`/attempts/${a}/photo`, undefined, { anonymous: true })).status, 401);
    assert.equal((await request(`/attempts/${a}/photo`, undefined, { role: 'viewer' })).status, 403);
    assert.equal((await request(`/attempts/${a}/photo`, undefined, { tenant: 'b' })).status, 404);
    const other = await dbs.a.user.create({ data: { username: 'other-visualization-owner', password_hash: 'fixture-only', role: 'operator', school_code: codes.a } });
    await dbs.a.colloidalEntry.update({ where: { id: e }, data: { created_by: other.id } });
    assert.equal((await request(`/attempts/${a}/photo`)).status, 404);
    await dbs.a.colloidalEntry.update({ where: { id: e }, data: { created_by: users.a.id } });
    await dbs.a.colloidalAttempt.update({ where: { id: a }, data: { photo_state: 'purged' } });
    assert.equal((await request(`/attempts/${a}/photo`)).status, 410);
});
check('unauthenticated and read-only roles cannot submit photos or records', async () => {
    assert.equal((await request('/entries', { id: id() }, { anonymous: true })).status, 401);
    for (const role of ['guest', 'viewer']) assert.equal((await request('/entries', { id: id() }, { role })).status, 403);
});
check('auto single is atomic, idempotent and stores original bytes only', async () => {
    const e = await entry(), a = await attempt(e);
    const r = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a }); assert.equal(r.status, 200, JSON.stringify(r.data));
    const record = r.data.records[0]; assert.equal(record.result, '合格'); assert.equal(record.resultSource, 'photo_auto'); assert.equal(record.sampleNo, 'S-1');
    assert.equal((await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a })).data.deduplicated, true);
    const raw = await request(`/records/${record.id}/photos/${a}`, undefined, { role: 'viewer' }); assert.deepEqual(raw.data, png);
    const details = await request(`/records/${record.id}`, undefined, { role: 'viewer' });
    assert.equal(details.data.attempts[0].photo_sha256, crypto.createHash('sha256').update(png).digest('hex'));
    assert.equal('photo_key' in details.data.attempts[0], false);
    const files = await fs.readdir(root, { recursive: true }); assert.equal(files.filter(v => v.endsWith(`${a}.png`)).length, 1); assert.ok(!files.some(v => /overlay|window|bands/.test(v)));
    assert.equal((await request(`/records/${record.id}`, undefined, { tenant: 'b' })).status, 404);
    assert.equal((await request(`/attempts/${a}/result`, {}, { method: 'PUT', tenant: 'b' })).status, 404);
});
check('failure then manual keeps failure/photograph and labels manual source', async () => {
    const e = await entry(), a = await attempt(e, { report: { status: 'quality_failed', error: '曝光不足', channels: [] } });
    assert.equal((await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a })).status, 400);
    const r = await request(`/entries/${e}/finalize`, { mode: 'manual', manualResults: { lead: '不合格' } }); assert.equal(r.status, 200);
    assert.equal(r.data.records[0].resultSource, 'manual'); assert.equal(r.data.records[0].entryPath, 'manual_after_auto_failure');
    const detail = await request(`/records/${r.data.records[0].id}`); assert.equal(detail.data.attempts[0].result.error, '曝光不足');
});
check('unknown-time candidate cannot finalize automatically; failed/abandoned attempt remains without a record', async () => {
    const e = await entry(), a = await attempt(e, { elapsed: null });
    const r = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a }); assert.equal(r.status, 400);
    const row = await dbs.a.colloidalEntry.findUnique({ where: { id: e } }); assert.equal(row.status, 'open'); assert.deepEqual(row.record_ids, []);
    assert.equal((await dbs.a.colloidalAttempt.findUnique({ where: { id: a } })).status, 'candidate');
});
check('triplex all-or-nothing and concurrent submits create exactly three linked records', async () => {
    const e = await entry('lean_meat_triplex');
    const a = await attempt(e, { report: { status: 'ok', version: PIPELINE, channels: ['clenbuterol', 'ractopamine', 'salbutamol'].map((id, i) => ({ id, status: 'ok', c: 10, t: i === 2 ? 0 : 20, c_present: true })) } });
    const responses = await Promise.all(Array.from({ length: 3 }, () => request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a })));
    assert.ok(responses.every(r => r.status === 200), JSON.stringify(responses));
    assert.equal(new Set(responses.flatMap(r => r.data.records.map(v => v.id))).size, 3);
    const { record_ids: ids } = await dbs.a.colloidalEntry.findUnique({ where: { id: e } }); assert.equal(ids.length, 3);
    assert.deepEqual(responses[0].data.records.map(v => v.result), ['合格', '合格', '不合格']);
    const m = await entry('lean_meat_triplex');
    assert.equal((await request(`/entries/${m}/finalize`, { mode: 'manual', manualResults: { clenbuterol: '合格' } })).status, 400);
    assert.deepEqual((await dbs.a.colloidalEntry.findUnique({ where: { id: m } })).record_ids, []);
});
check('retries cannot overwrite original photo or immutable channel results', async () => {
    const e = await entry(), a = await attempt(e);
    assert.equal((await request(`/attempts/${a}/photo`, png, { method: 'PUT', binary: true })).status, 200);
    const changed = Buffer.concat([png, Buffer.from('different')]);
    assert.equal((await request(`/attempts/${a}/photo`, changed, { method: 'PUT', binary: true })).status, 409);
    assert.equal((await request(`/attempts/${a}/result`, { status: 'ok', version: PIPELINE, channels: [{ id: 'lead', status: 'ok', c: 100, t: 0, c_present: true }] }, { method: 'PUT' })).status, 409);
});
check('rolling cleanup dry-run and apply retain metadata and record linkage', async () => {
    const e = await entry(), a = await attempt(e);
    const r = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a }); const recordId = r.data.records[0].id;
    await dbs.a.colloidalAttempt.update({ where: { id: a }, data: { created_at: new Date('2020-01-01') } });
    const e2 = await entry(), a2 = await attempt(e2);
    await dbs.a.colloidalAttempt.update({ where: { id: a2 }, data: { created_at: new Date('2020-01-01') } });
    const dry = await purgeOriginals({ db: dbs.a, root, days: 30, batchSize: 1 }); assert.equal(dry.examined, 2); assert.equal(dry.purged, 0);
    assert.equal((await request(`/records/${recordId}/photos/${a}`)).status, 200);
    assert.equal((await purgeOriginals({ db: dbs.a, root, days: 30, apply: true, batchSize: 1 })).purged, 2);
    assert.equal((await request(`/records/${recordId}/photos/${a}`)).status, 410);
    const details = await request(`/records/${recordId}`); assert.equal(details.data.attempts[0].photo_state, 'purged'); assert.ok(details.data.attempts[0].photo_sha256);
    assert.equal((await dbs.a.testRecord.findUnique({ where: { id: recordId } })).result_data.result, '合格');
});

check('storage reporting includes compact failure reasons, daily bytes and source counts', async () => {
    assert.equal((await request('/storage')).status, 403);
    const r = await request('/storage', undefined, { role: 'manager' });
    assert.equal(r.status, 200); assert.equal(r.data.retentionDays, null);
    assert.ok(r.data.bytes > 0); assert.ok(r.data.reasons.some(row => row.reason === 'quality_failed'));
    assert.ok(r.data.recordSources.some(row => row.source === 'photo_auto'));
    assert.ok(r.data.dailyUploads.length);
    const b = await request('/storage', undefined, { role: 'manager', tenant: 'b' }); assert.equal(b.data.bytes, 0);
});

async function timedEntry(projectId = 'lead') {
    const e = await entry(projectId), sampling = { id: id(), planId: 'minutes_5_6_7', startedAt: new Date().toISOString() };
    const response = await request(`/entries/${e}/sampling/start`, sampling); assert.equal(response.status, 200, JSON.stringify(response.data));
    return { e, sampling };
}
async function timedAttempt(e, sampling, index) {
    const elapsed = [300, 360, 420][index - 1], a = id();
    const body = { id: a, sampleIndex: index, samplingId: sampling.id, capturedAt: new Date(Date.parse(sampling.startedAt) + elapsed * 1000).toISOString(),
        elapsedSeconds: elapsed, timeSource: 'scheduled_camera', inputMode: 'auto', source: 'camera', filename: `original-${index}.png` };
    const response = await request(`/entries/${e}/attempts`, body); assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal((await request(`/entries/${e}/attempts`, body)).status, 200);
    assert.equal((await request(`/attempts/${a}/photo`, png, { method: 'PUT', binary: true })).status, 200);
    const result = await request(`/attempts/${a}/recognize`, {}); assert.equal(result.status, 200, JSON.stringify(result.data));
    return a;
}
check('sampling API: session finishes three slots, with one final single record', async () => {
    const { e, sampling } = await timedEntry();
    assert.equal((await request(`/entries/${e}/sampling/start`, sampling)).status, 200);
    const a = await timedAttempt(e, sampling, 1);
    assert.equal((await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a })).status, 409);
    assert.equal((await request(`/entries/${e}/attempts`, { id: id(), inputMode: 'auto', source: 'upload', elapsedSeconds: 360, timeSource: 'within_window' })).status, 409);
    await timedAttempt(e, sampling, 2); const last = await timedAttempt(e, sampling, 3);
    const ended = await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'completed' });
    assert.equal(ended.data.summary.eligible, true); assert.equal(ended.data.summary.validCount, 3);
    assert.equal((await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: a })).status, 400);
    const saved = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: last });
    assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.records.length, 1);
    assert.equal(saved.data.records[0].entryPath, 'auto_two_of_three_consistent');
    const detail = await request(`/records/${saved.data.records[0].id}`);
    assert.equal(detail.data.attempts.length, 3); assert.equal(detail.data.samplingSummary.status, 'consistent');
    assert.ok(detail.data.attempts.every(a => a.result.computed_at === 'server'));
});
check('sampling API: two matching receipts allow auto-save and preserve the minority result', async () => {
    const { e, sampling } = await timedEntry();
    await timedAttempt(e, sampling, 1);
    recognitionOverride = p => { const raw = rawResult(p); raw.channels[0].t = 0; return raw; };
    try { await timedAttempt(e, sampling, 2); } finally { recognitionOverride = null; }
    const last = await timedAttempt(e, sampling, 3);
    const r = await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'completed' });
    assert.equal(r.data.summary.status, 'consistent'); assert.equal(r.data.summary.agreeCount, 2); assert.equal(r.data.summary.hasDisagreement, true);
    const saved = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: last });
    assert.equal(saved.status, 200); assert.equal(saved.data.records[0].photoRecognition.sampling.hasDisagreement, true);
});
check('sampling API: interruption preserves empty slots, forbids resume and freezes sample identity', async () => {
    const { e, sampling } = await timedEntry(); await timedAttempt(e, sampling, 1);
    assert.equal((await request('/entries', { id: e, projectId: 'lead', context: { ...context, inspector: '换样本' } })).status, 409);
    assert.equal((await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'interrupted', reason: '锁屏' })).status, 200);
    const detail = await request(`/entries/${e}`);
    assert.equal(detail.data.attempts.length, 3); assert.equal(detail.data.samplingSummary.validCount, 1);
    assert.equal(detail.data.attempts.filter(a => a.photo_state === 'absent').length, 2);
    assert.equal((await request(`/entries/${e}/sampling/start`, { ...sampling, id: id() })).status, 409);
    assert.equal((await request(`/entries/${e}/attempts`, { id: id(), inputMode: 'auto', source: 'camera', timeSource: 'scheduled_camera', elapsedSeconds: null, sampleIndex: 2, samplingId: sampling.id, capturedAt: null })).status, 409);
    assert.equal((await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'completed' })).data.summary.status, 'interrupted');
});
check('sampling API: snapshot index, capture time, server result and tenant ownership cannot be bypassed', async () => {
    const { e, sampling } = await timedEntry();
    const a = id(), body = { id: a, inputMode: 'auto', source: 'camera', timeSource: 'scheduled_camera', elapsedSeconds: 300, sampleIndex: 1, samplingId: sampling.id,
        capturedAt: new Date(Date.parse(sampling.startedAt) + 300000).toISOString() };
    assert.equal((await request(`/entries/${e}/attempts`, { ...body, elapsedSeconds: 360 })).status, 400);
    assert.equal((await request(`/entries/${e}/attempts`, body)).status, 201);
    assert.equal((await request(`/entries/${e}/attempts`, { ...body, id: id() })).status, 409);
    assert.equal((await request(`/attempts/${a}/result`, rawResult('lead'), { method: 'PUT' })).status, 403);
    assert.equal((await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'interrupted' }, { tenant: 'b' })).status, 404);
    assert.equal((await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'interrupted' }, { role: 'viewer' })).status, 403);
    await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'interrupted' });
});
check('sampling API: two matching photos survive third failure; two different photos do not', async () => {
    for (const disagreement of [false, true]) {
        const { e, sampling } = await timedEntry(); await timedAttempt(e, sampling, 1);
        if (disagreement) recognitionOverride = p => { const raw = rawResult(p); raw.channels[0].t = 0; return raw; };
        let second;
        try { second = await timedAttempt(e, sampling, 2); } finally { recognitionOverride = null; }
        const r = await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'completed' });
        assert.equal(r.data.summary.validCount, 2); assert.equal(r.data.summary.eligible, !disagreement);
        const saved = await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: second }); assert.equal(saved.status, disagreement ? 400 : 200);
        if (disagreement) assert.equal((await request(`/entries/${e}/finalize`, { mode: 'manual', manualResults: { lead: '不合格' } })).data.records[0].entryPath, 'manual_after_sampling');
    }
});
check('sampling API: interrupted third slot retains two completed matching measurements', async () => {
    const { e, sampling } = await timedEntry();
    await timedAttempt(e, sampling, 1); const adopted = await timedAttempt(e, sampling, 2);
    const ended = await request(`/entries/${e}/sampling/finish`, { id: sampling.id, state: 'interrupted', reason: '结束第三次采样' });
    assert.equal(ended.data.summary.eligible, true); assert.equal(ended.data.entry.sampling.state, 'interrupted');
    assert.equal((await request(`/entries/${e}/finalize`, { mode: 'auto', attemptId: adopted })).status, 200);
});

test('browser camera preview rotates and mirrors without rotating or mirroring the captured original', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
        await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
        await page.evaluate(() => {
            const draw = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function (...args) {
                if (args[0] instanceof HTMLVideoElement) { const m = this.getTransform(); window.fixtureCaptureMatrix = [m.a, m.b, m.c, m.d, m.e, m.f]; }
                return draw.apply(this, args);
            };
        });
        await page.locator('select[name=result]').selectOption('__photo_camera__');
        await page.waitForFunction(() => document.querySelector('.colloidal-cam video')?.videoWidth > 0);
        const size = await page.locator('.colloidal-cam video').evaluate(v => [v.videoWidth, v.videoHeight]);
        await page.locator('.colloidal-cam').getByRole('button', { name: '右转90°', exact: true }).click();
        await page.locator('.colloidal-cam').getByRole('button', { name: '左右镜像', exact: true }).click();
        await page.locator('.colloidal-cam').getByRole('button', { name: '上下翻转', exact: true }).click();
        assert.equal(await page.locator('.colloidal-cam').getByRole('button', { name: '左右镜像', exact: true }).getAttribute('aria-pressed'), 'true');
        const box = await page.locator('.colloidal-cam video').boundingBox(); assert.ok(box.height > box.width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: '.cache/colloidal-local-trial-20261022/camera-controls-mobile.png', fullPage: true });
        await page.locator('.colloidal-cam').getByRole('button', { name: '拍照', exact: true }).click();
        await page.waitForFunction(() => { const p = window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')); return p.result && !p.busy; });
        const original = await page.evaluate(async () => {
            const p = window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]'));
            const image = new Image(); image.src = p.previewUrl; await image.decode(); return { size: [image.naturalWidth, image.naturalHeight], entryId: p.entry.id };
        });
        assert.deepEqual(original.size, size);
        assert.deepEqual(await page.evaluate(() => window.fixtureCaptureMatrix), [1, 0, 0, 1, 0, 0]);
        const attempt = (await request(`/entries/${original.entryId}`)).data.attempts[0];
        const event = attempt.process_log.find(e => e.stage === 'photo_captured');
        assert.equal(event.details.previewRotation, 90); assert.equal(event.details.previewMirrorX, true); assert.equal(event.details.previewMirrorY, true);
    } finally { await page.close(); }
});

test('browser form: photo failure → manual save → original photo in details', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    recognitionOverride = () => ({ status: 'structure_mismatch', error: '结构不匹配', channels: [] });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    await page.locator('[data-colloidal-inline] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/triplex-valid.png'));
    await page.waitForFunction(() => { const entry = window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')); return entry.result?.status === 'structure_mismatch' && !entry.busy; });
    const entryId = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
    await page.locator('[data-colloidal-process] > summary').click();
    await page.waitForFunction(() => document.querySelector('[data-colloidal-process]')?.textContent.includes('时间规则与最终可用性判定'));
    assert.ok((await page.locator('[data-colloidal-process]').textContent()).includes('原图保存完成'));
    await page.locator('select[name=result]').selectOption('合格');
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(id => window.fixtureModule.storage.getAll().some(r => r.photoRecognition?.entryId === id && r.photoRecognition?.entryPath === 'manual_after_auto_failure'), entryId);
    const entryRow = await dbs.a.colloidalEntry.findUnique({ where: { id: entryId } });
    assert.equal(entryRow.status, 'completed');
    await page.locator(`span.btn-detail[data-id="${entryRow.record_ids[0]}"]`).click();
    await page.getByText('原始照片与结果录入过程', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#detailModal .colloidal-preview')?.complete);
    assert.ok((await page.locator('#detailModal').textContent()).includes('识别未完成有效判读后转手工'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '.cache/colloidal-integration-20261019/manual-fallback-detail.png', fullPage: true });
    assert.deepEqual(errors, []); await page.close(); recognitionOverride = null;
});

test('browser form: server auto result reaches database and ordinary manual entry still works', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    recognitionOverride = null;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    await page.locator('[data-colloidal-inline] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/single-valid.png'));
    await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).result?.eligible, null, { timeout: 180000 });
    const entryId = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(id => window.fixtureModule.storage.getAll().some(r => r.photoRecognition?.entryId === id), entryId);
    const entryRow = await dbs.a.colloidalEntry.findUnique({ where: { id: entryId } }); assert.equal(entryRow.result_source, 'photo_auto');
    await page.locator('input[name=vegetableType]').fill('手工样本');
    await page.locator('select[name=batchNo]').selectOption('水胺硫磷-胶体金检测卡');
    await page.locator('select[name=result]').selectOption('不合格');
    // A fresh manual point must not keep the prior photo entry or its listeners.
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(() => window.fixtureModule.storage.getAll().some(r => r.vegetableType === '手工样本' && r._status === 'synced'));
    const manual = await dbs.a.testRecord.findFirst({ where: { result_data: { path: ['vegetableType'], equals: '手工样本' } } });
    assert.equal(manual.result_data.resultSource, 'manual'); assert.equal(manual.result_data.photoRecognition, undefined);
    assert.equal(manual.result_data.batchNo, '水胺硫磷-胶体金检测卡');
    await page.close();
});

test('browser triplex form saves three channels and shares one original photo', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    recognitionOverride = null;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/ui-lean?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    assert.equal(await page.evaluate(() => {
        const point = document.querySelector('[data-test-point]');
        return point.querySelector('[data-colloidal-timed]').getBoundingClientRect().width >= point.getBoundingClientRect().width * .9;
    }), true, 'Photo entry must use the full mobile form width');
    await page.locator('select[name=batchNo]').selectOption('瘦肉精三联-胶体金检测卡');
    await page.locator('[data-colloidal-inline] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/triplex-all-valid.png'));
    await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).result?.eligible, null, { timeout: 180000 });
    const entryId = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
    await page.locator('#leanMeatTestForm button[type=submit]').click();
    await page.waitForFunction(id => window.fixtureModule.storage.getAll().filter(r => r.photoRecognition?.entryId === id).length === 3, entryId);
    const row = await dbs.a.colloidalEntry.findUnique({ where: { id: entryId }, include: { attempts: true } });
    assert.equal(row.record_ids.length, 3); assert.equal(row.attempts.length, 1); assert.equal(row.attempts[0].photo_state, 'present');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '.cache/colloidal-integration-20261019/triplex-form.png', fullPage: true });
    await page.close();
});

test('browser access layer discards in-flight response after identity changes', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    const rejected = await page.evaluate(async school => {
        const storage = window.fixtureModule.storage;
        await storage.getAllFresh();
        const originalFetch = window.fetch;
        const key = 'current_user__' + school;
        const originalUser = localStorage.getItem(key);
        let release;
        window.fetch = async (...args) => {
            if (!String(args[0]).endsWith('/api/colloidal/state')) return originalFetch(...args);
            await new Promise(resolve => { release = resolve; });
            return new Response(JSON.stringify({ privateOldActorData: true }), { headers: { 'Content-Type': 'application/json' } });
        };
        try {
            const response = storage.requestOnlineResource('/api/colloidal/state');
            localStorage.setItem(key, JSON.stringify({ id: 'another-account', role: 'operator' }));
            release();
            try { await response; return false; } catch (error) { return error.message.includes('已丢弃原会话响应'); }
        } finally {
            window.fetch = originalFetch;
            localStorage.setItem(key, originalUser);
        }
    }, codes.a);
    assert.equal(rejected, true); await page.close();
});

async function openTimedPage(lean = false) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.clock.install();
    await page.goto(`${base}/${lean ? 'ui-lean' : 'ui'}?school=${codes.a}`);
    await page.waitForFunction(() => window.fixtureModule);
    if (lean) await page.locator('select[name=batchNo]').selectOption('瘦肉精三联-胶体金检测卡');
    await page.getByRole('button', { name: '开始自动检测（3次采样）', exact: true }).click();
    await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'preview');
    await page.getByRole('button', { name: '已完成加样，开始计时', exact: true }).click();
    await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'running');
    return page;
}
async function advanceSample(page, index) {
    await page.clock.fastForward(index === 1 ? 300000 : 60000);
    await page.waitForFunction(i => ['processing', 'ready', 'failed'].includes(window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.slots[i - 1].state), index);
}
const timedBrowserTest = (name, fn) => test(name, { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE, timeout: 60000 }, async () => {
    try { await fn(); } catch (e) { console.error('Timed workflow failure:', name, e.stack); throw e; }
});
timedBrowserTest('browser timed camera: 5/6/7-minute capture continues while recognition waits; 2/3 majority is retained', async () => {
    const releases = [];
    recognitionOverride = p => new Promise(resolve => {
        const raw = rawResult(p); if (releases.length === 2) raw.channels[0].t = 0;
        releases.push(() => resolve(raw));
    });
    let page;
    try {
        page = await openTimedPage();
        for (const index of [1, 2, 3]) {
            await advanceSample(page, index);
            for (let i = 0; i < 100 && releases.length < index; i++) await new Promise(resolve => setTimeout(resolve, 25));
            assert.equal(releases.length, index, 'Original upload has completed before advancing synthetic time');
        }
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        for (let i = 0; i < 100 && releases.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(releases.length, 3, 'Third snapshot uploads even while first recognition request is pending');
        const captured = await dbs.a.colloidalAttempt.findMany({ where: { entry_id: e }, orderBy: { sample_index: 'asc' } });
        assert.equal(captured.length, 3);
        captured.forEach((a, i) => { assert.ok(a.elapsed_seconds >= [300, 360, 420][i] && a.elapsed_seconds < [315, 375, 435][i]); assert.equal(a.photo_mime, 'image/jpeg'); });
        releases.forEach(release => release());
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        const report = await page.locator('[data-colloidal-timed]').textContent();
        assert.ok(report.includes('另一次结论不同'), report + JSON.stringify(await request(`/entries/${e}`)));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: '.cache/colloidal-integration-20261019/timed-majority-20261022.png', fullPage: true });
        await page.locator('#pesticideTestForm button[type=submit]').click();
        await page.waitForFunction(id => window.fixtureModule.storage.getAll().some(r => r.photoRecognition?.entryId === id), e);
        const row = await dbs.a.colloidalEntry.findUnique({ where: { id: e } }); assert.equal(row.record_ids.length, 1);
        assert.equal(row.adopted_attempt_id, captured[1].id);
        const record = await dbs.a.testRecord.findUnique({ where: { id: row.record_ids[0] } });
        assert.equal(record.result_data.photoRecognition.sampling.hasDisagreement, true);
    } finally { releases.forEach(release => release()); recognitionOverride = null; await page?.close(); }
});
timedBrowserTest('browser timed triplex: three original frames yield three formal records, not nine', async () => {
    recognitionOverride = null;
    const page = await openTimedPage(true);
    try {
        for (const index of [1, 2, 3]) {
            await advanceSample(page, index);
            await page.waitForFunction(i => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.slots[i - 1].state === 'ready', index);
        }
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        await page.locator('#leanMeatTestForm button[type=submit]').click();
        await page.waitForFunction(id => window.fixtureModule.storage.getAll().filter(r => r.photoRecognition?.entryId === id).length === 3, e);
        const row = await dbs.a.colloidalEntry.findUnique({ where: { id: e }, include: { attempts: true } });
        assert.equal(row.record_ids.length, 3); assert.equal(row.attempts.length, 3); assert.ok(row.attempts.every(a => a.photo_state === 'present'));
    } finally { await page.close(); }
});
timedBrowserTest('browser timed background interruption keeps the first snapshot and logs two unfilled slots', async () => {
    const page = await openTimedPage();
    try {
        await advanceSample(page, 1);
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.slots[0].state === 'ready');
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        const row = await dbs.a.colloidalEntry.findUnique({ where: { id: e }, include: { attempts: true } });
        assert.equal(row.sampling.state, 'interrupted'); assert.equal(row.attempts.length, 3);
        assert.equal(row.attempts.filter(a => a.photo_state === 'present').length, 1); assert.equal(row.record_ids.length, 0);
    } finally { await page.close(); }
});
timedBrowserTest('browser timed missed deadlines never produce three catch-up photographs', async () => {
    const page = await openTimedPage();
    try {
        await page.clock.fastForward(481000);
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        const attempts = await dbs.a.colloidalAttempt.findMany({ where: { entry_id: e } });
        assert.equal(attempts.length, 3); assert.ok(attempts.every(a => a.photo_state === 'absent' && a.result.status === 'sample_missed'));
    } finally { await page.close(); }
});
timedBrowserTest('browser timed requires complete information and handles camera permission rejection', async () => {
    const page = await browser.newPage();
    try {
        await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
        await page.locator('input[name=inspector]').fill('');
        await page.getByRole('button', { name: '开始自动检测（3次采样）', exact: true }).click();
        assert.ok((await page.locator('[data-colloidal-timed]').textContent()).includes('请先填写检测员'));
        assert.equal(await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry), null);
        await page.locator('input[name=inspector]').fill('测试员');
        await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }; });
        await page.getByRole('button', { name: '开始自动检测（3次采样）', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-colloidal-timed]').textContent.includes('Permission denied'));
        assert.equal(await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state), 'idle');
        assert.equal(await page.locator('input[name=inspector]').isDisabled(), false);
    } finally { await page.close(); }
});
timedBrowserTest('browser restores the second agreeing photo when the last scheduled recognition failed', async () => {
    let calls = 0;
    recognitionOverride = p => ++calls === 3 ? { status: 'quality_failed', error: '第三张曝光不足', channels: [] } : rawResult(p);
    let page;
    try {
        page = await openTimedPage();
        for (const index of [1, 2, 3]) {
            await advanceSample(page, index);
            await page.waitForFunction(i => ['ready', 'failed'].includes(window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.slots[i - 1].state), index);
        }
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        const adopted = (await request(`/entries/${e}`)).data.samplingSummary.adoptedAttemptId;
        await page.reload(); await page.waitForFunction(() => window.fixtureModule);
        await page.getByRole('button', { name: '恢复上次未完成的照片录入', exact: true }).click();
        await page.waitForFunction(id => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).attemptId === id, adopted);
        assert.equal(await page.locator('select[name=result]').inputValue(), '合格');
    } finally { recognitionOverride = null; await page?.close(); }
});
timedBrowserTest('browser can finish after two matching captures and retain the missing-third reason', async () => {
    const page = await openTimedPage();
    try {
        for (const index of [1, 2]) {
            await advanceSample(page, index);
            await page.waitForFunction(i => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.slots[i - 1].state === 'ready', index);
        }
        await page.getByRole('button', { name: '结束本次自动采样', exact: true }).click();
        await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).timed.state === 'finished');
        assert.equal(await page.locator('select[name=result]').inputValue(), '合格');
        const e = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
        const row = await dbs.a.colloidalEntry.findUnique({ where: { id: e }, include: { attempts: true } });
        assert.equal(row.sampling.state, 'interrupted'); assert.equal(row.attempts.filter(a => a.photo_state === 'present').length, 2);
        assert.ok(row.attempts.find(a => a.sample_index === 3).result.error.includes('结束'));
    } finally { await page.close(); }
});

function fixturePage(school) {
    return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/colloidal.css"></head><body>
    <form id="pesticideTestForm"><div class="grid grid-cols-1"><input name="testDate" type="date" value="2020-01-01"><select name="canteen"><option>一食堂</option></select><input name="inspector" value="测试员"></div>
    <div class="grid grid-cols-1"><div><input name="vegetableType" value="白菜"></div><div><select name="batchNo"><option>克百威-胶体金检测卡</option><option>水胺硫磷-胶体金检测卡</option></select></div><div><select name="result"><option>合格</option><option>不合格</option></select></div></div><div><button type="submit">保存</button></div></form>
    <div style="max-width:100%;overflow-x:auto"><table><tbody id="pesticideRecords"></tbody></table></div>
    <script type="module">localStorage.setItem('auth_token__${school}','local-colloidal-fixture');localStorage.setItem('current_user__${school}',JSON.stringify({id:'fixture-user',role:'operator'}));
    const {permissionService}=await import('/js/services/PermissionService.js');permissionService.hasPermission=()=>true;
    const {GenericTestModule}=await import('/js/modules/GenericTest.js');window.fixtureModule=new GenericTestModule({moduleName:'pesticide',formId:'pesticideTestForm',tableId:'pesticideRecords'});</script></body></html>`;
}
