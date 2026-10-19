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
import { PIPELINE } from '../../lib/colloidalReader.js';
import { purgeOriginals } from '../../lib/colloidalRetention.js';
import { createRecordRoutes } from '../../routes/recordRoutes.js';

const dbUrl = process.env.COLLOIDAL_TEST_DATABASE_URL;
const enabled = Boolean(dbUrl);
let prisma, server, base, root, users = {}, dbs = {}, codes;
let browser;
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
    const routeOptions = { authenticateUser, authorizeRoles: guards.authorizeRoles, requireEditorOrAbove: guards.requireEditorOrAbove, requireGuestReadOnly: (req, res, next) => { req.guestVisibleTypes = ['pesticide', 'leanMeat']; next(); }, storageRoot: () => root };
    app.use('/api/colloidal', createColloidalRoutes(routeOptions));
    app.use(createRecordRoutes({ ...routeOptions, idempotencyMiddleware: (req, res, next) => next() }));
    if (process.env.COLLOIDAL_BROWSER_MODULE) {
        app.get('/ui', (req, res) => res.type('html').send(fixturePage(codes.a)));
        app.get('/ui-lean', (req, res) => res.type('html').send(fixturePage(codes.a).replaceAll('pesticide', 'leanMeat').replaceAll('克百威', '恩诺沙星').replaceAll('水胺硫磷', '氟苯尼考').replace('<input name="vegetableType" value="白菜">', '<select name="meatType"><option>鱼、虾</option></select>')));
        app.use('/fixtures', express.static(path.resolve('.cache/colloidal-integration-20261019')));
        app.use(express.static(path.resolve('frontend')));
        const playwright = await import(process.env.COLLOIDAL_BROWSER_MODULE);
        const executablePath = process.env.COLLOIDAL_CHROMIUM_EXECUTABLE || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
        browser = await playwright.chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
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

check('migration replay creates identical public and both tenant structures', async () => {
    for (const code of Object.values(codes)) {
        const parity = await compareTenantStructureToPublic(prisma, { schema: schemaNameOf(code) });
        assert.equal(parity.ok, true, JSON.stringify(parity));
    }
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
    const files = await fs.readdir(root, { recursive: true }); assert.equal(files.filter(v => v.endsWith('.png')).length, 1); assert.ok(!files.some(v => /overlay|window|bands/.test(v)));
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

test('browser form: photo failure → manual save → original photo in details', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    await page.locator('[data-colloidal-panel] > select').selectOption('auto');
    await page.locator('[data-colloidal-panel] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/triplex-valid.png'));
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-colloidal-panel] [role=status]').textContent.includes('识别尝试已保留'), null, { timeout: 180000 });
    const entryId = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
    await page.locator('[data-colloidal-panel] > select').selectOption('manual');
    await page.locator('select[name=result]').selectOption('合格');
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(() => window.fixtureModule.storage.getAll().some(r => r.photoRecognition?.entryPath === 'manual_after_auto_failure'));
    const entryRow = await dbs.a.colloidalEntry.findUnique({ where: { id: entryId } });
    assert.equal(entryRow.status, 'completed');
    await page.locator(`span.btn-detail[data-id="${entryRow.record_ids[0]}"]`).click();
    await page.getByText('原始照片与结果录入过程', { exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#detailModal .colloidal-preview')?.complete);
    assert.ok((await page.locator('#detailModal').textContent()).includes('识别未完成有效判读后转手工'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '.cache/colloidal-integration-20261019/manual-fallback-detail.png', fullPage: true });
    assert.deepEqual(errors, []); await page.close();
});

test('browser form: selected v5 auto result reaches database and ordinary manual entry still works', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/ui?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    await page.locator('[data-colloidal-panel] > select').selectOption('auto');
    await page.locator('[data-colloidal-panel] input[type=number]').fill('6');
    await page.locator('[data-colloidal-panel] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/single-valid.png'));
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
    await page.waitForFunction(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).result?.eligible, null, { timeout: 180000 });
    const entryId = await page.evaluate(() => window.fixtureModule.photoEntries.get(document.querySelector('[data-test-point]')).entry.id);
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(id => window.fixtureModule.storage.getAll().some(r => r.photoRecognition?.entryId === id), entryId);
    const entryRow = await dbs.a.colloidalEntry.findUnique({ where: { id: entryId } }); assert.equal(entryRow.result_source, 'photo_auto');
    await page.locator('input[name=vegetableType]').fill('手工样本');
    await page.locator('select[name=result]').selectOption('不合格');
    // Changing project after resetting the auto entry must not trigger a stale
    // component listener and clear the manually chosen result.
    await page.locator('select[name=batchNo]').selectOption('水胺硫磷-胶体金检测卡');
    await page.locator('#pesticideTestForm button[type=submit]').click();
    await page.waitForFunction(() => window.fixtureModule.storage.getAll().some(r => r.vegetableType === '手工样本' && r._status === 'synced'));
    const manual = await dbs.a.testRecord.findFirst({ where: { result_data: { path: ['vegetableType'], equals: '手工样本' } } });
    assert.equal(manual.result_data.resultSource, 'manual'); assert.equal(manual.result_data.photoRecognition, undefined);
    assert.equal(manual.result_data.batchNo, '水胺硫磷-胶体金检测卡');
    await page.close();
});

test('browser triplex form saves three channels and shares one original photo', { skip: !enabled || !process.env.COLLOIDAL_BROWSER_MODULE }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/ui-lean?school=${codes.a}`); await page.waitForFunction(() => window.fixtureModule);
    assert.equal(await page.evaluate(() => {
        const point = document.querySelector('[data-test-point]');
        return point.querySelector('[data-colloidal-panel]').getBoundingClientRect().width >= point.getBoundingClientRect().width * .9;
    }), true, 'Photo entry must use the full mobile form width');
    await page.locator('select[name=batchNo]').selectOption('瘦肉精三联-胶体金检测卡');
    await page.locator('[data-colloidal-panel] > select').selectOption('auto');
    await page.locator('[data-colloidal-panel] input[type=number]').fill('6');
    await page.locator('[data-colloidal-panel] input[type=file]').first().setInputFiles(path.resolve('.cache/colloidal-integration-20261019/triplex-all-valid.png'));
    await page.getByRole('button', { name: '开始识别', exact: true }).click();
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

function fixturePage(school) {
    return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/style.css"><link rel="stylesheet" href="/css/colloidal.css"></head><body>
    <form id="pesticideTestForm"><div class="grid grid-cols-1"><input name="testDate" type="date" value="2020-01-01"><select name="canteen"><option>一食堂</option></select><input name="inspector" value="测试员"></div>
    <div class="grid grid-cols-1"><input name="vegetableType" value="白菜"><select name="batchNo"><option>克百威-胶体金检测卡</option><option>水胺硫磷-胶体金检测卡</option></select><select name="result"><option>合格</option><option>不合格</option></select></div><div><button type="submit">保存</button></div></form>
    <div style="max-width:100%;overflow-x:auto"><table><tbody id="pesticideRecords"></tbody></table></div>
    <script type="module">localStorage.setItem('auth_token__${school}','local-colloidal-fixture');localStorage.setItem('current_user__${school}',JSON.stringify({id:'fixture-user',role:'operator'}));
    const {permissionService}=await import('/js/services/PermissionService.js');permissionService.hasPermission=()=>true;
    const {GenericTestModule}=await import('/js/modules/GenericTest.js');window.fixtureModule=new GenericTestModule({moduleName:'pesticide',formId:'pesticideTestForm',tableId:'pesticideRecords'});</script></body></html>`;
}
