import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PROJECTS, PIPELINE, compactResult, normalizeContext, photoType } from '../../lib/colloidalReader.js';
import { normalizeWriteJson } from '../../lib/recordNormalize.js';
import { buildTenantProjection } from '../../lib/tenantProvisioner.js';
import { newEntryId } from '../../../frontend/js/colloidal/contract.js';

const project = PROJECTS.find(p => p.id === 'lead');
const result = (c = 10, t = 20) => ({ status: 'ok', version: PIPELINE, channels: [{ id: 'lead', status: 'ok', c, t, c_present: true }] });
for (const seconds of [300, 480]) test(`IFU inclusive boundary ${seconds}s and equality`, () => {
    const value = compactResult(result(10, 10), project, seconds);
    assert.equal(value.eligible, true); assert.equal(value.channels[0].final_result, 'negative');
});
for (const seconds of [null, 299, 481]) test(`unknown/outside time never becomes eligible: ${seconds}`, () => {
    const value = compactResult(result(), project, seconds);
    assert.equal(value.eligible, false);
    assert.equal(value.channels[0].final_result, seconds === null ? null : 'invalid');
});
test('within-window confirmation yields a final result without inventing elapsed seconds', () => {
    const value = compactResult(result(), project, null, { assumeWithinTime: true });
    assert.equal(value.eligible, true);
    assert.equal(value.channels[0].final_result, 'negative');
    assert.equal(value.channels[0].rule_status, 'within_time_assumed');
    assert.equal(value.time_basis, 'within_window_confirmed');
    assert.equal(compactResult(result(), project, 360).time_basis, 'measured');
    assert.equal(compactResult(result(), project, null).time_basis, 'unknown');
});
test('absence of C and localization failure stay distinct', () => {
    const input = result(); input.channels[0].c_present = false;
    assert.equal(compactResult(input, project, 360).channels[0].final_result, 'invalid');
    const r = compactResult({ status: 'localization_failed', channels: [], error: '找不到窗口' }, project, 360);
    assert.deepEqual(r.channels, []); assert.equal(r.eligible, false);
});
test('server derives IFU result instead of accepting claimed negative', () => {
    const input = result(20, 10); input.channels[0].final_result = 'negative';
    assert.equal(compactResult(input, project, 360).channels[0].final_result, 'positive');
});
test('triplex verifies channel IDs/order and preserves all channels', () => {
    const p = PROJECTS.at(-1);
    const input = { status: 'ok', version: PIPELINE, final_result: null, channels: p.channels.map((c, i) => ({ id: c.id, status: 'ok', c: 10, t: i === 2 ? 0 : 20, c_present: true })) };
    assert.deepEqual(compactResult(input, p, 360).channels.map(c => c.final_result), ['negative', 'negative', 'positive']);
    input.channels.reverse(); assert.throws(() => compactResult(input, p, 360), /通道/);
});
test('wrong version/nonfinite/missing channels rejected', () => {
    assert.throws(() => compactResult({ ...result(), version: 'other' }, project, 360), /版本/);
    assert.throws(() => compactResult(result(Infinity), project, 360), /测量/);
    assert.throws(() => compactResult({ ...result(), channels: [] }, project, 360), /通道/);
});
test('compact logs drop profiles, arrays and processed images', () => {
    const input = { ...result(), geometry: Array(1000).fill(1), overlay_url: '/overlay.png' };
    input.channels[0].pixels = Array(1000).fill(20);
    const log = JSON.stringify(compactResult(input, project, 360));
    assert.ok(log.length < 1000); assert.ok(!/pixels|geometry|overlay/.test(log));
});
test('manual provenance explicit, generic callers cannot forge auto provenance', () => {
    const payload = { testDate: '2026-10-19', canteen: '食堂', inspector: '检测员', result: '合格' };
    const normalized = normalizeWriteJson({ payload, mode: 'create', testType: 'pesticide' });
    assert.equal(normalized.resultData.resultSource, 'manual');
    assert.equal(normalized.resultData.entryPath, 'direct_manual');
    for (const forged of [{ ...payload, photoRecognition: { resultSource: 'photo_auto' } }, { ...payload, resultSource: 'photo_auto' }]) assert.equal(normalizeWriteJson({ payload: forged, mode: 'create', testType: 'pesticide' }).ok, false);
});
test('generic update preserves provenance and identifies manual result edits', () => {
    const existing = { result: '不合格', resultSource: 'photo_auto', photoRecognition: { entryId: 'original', resultSource: 'photo_auto', entryPath: 'auto_success' } };
    const r = normalizeWriteJson({ payload: { result: '合格' }, existingSampleInfo: {}, existingResultData: existing, mode: 'update', testType: 'pesticide' });
    assert.equal(r.resultData.resultSource, 'manual'); assert.equal(r.resultData.photoRecognition.entryId, 'original');
    assert.equal(r.resultData.photoRecognition.entryPath, 'manual_edit_after_photo');
    assert.equal(normalizeWriteJson({ payload: { photoRecognition: null }, existingSampleInfo: {}, existingResultData: existing, mode: 'update' }).ok, false);
});
test('entry may open before context is complete but finalize still requires it', () => {
    const partial = normalizeContext({ testDate: '2026-10-19', canteen: '一食堂', vegetableType: '白菜' }, project, { requireComplete: false });
    assert.equal(partial.inspector, '');
    assert.throws(() => normalizeContext(partial, project), /检测员/);
    assert.throws(() => normalizeContext({ testDate: '2026-02-30' }, project, { requireComplete: false }), /日期/);
});
test('context and original magic validation', () => {
    assert.throws(() => normalizeContext({ testDate: '2026-02-30' }, project));
    assert.throws(() => normalizeContext({ testDate: '2026-10-19', canteen: 'A', inspector: 'B', meatType: '鱼', customFields: { result: '合格' } }, project), /保留键/);
    assert.deepEqual(photoType(Buffer.from('ffd8ff001122', 'hex')), { ext: 'jpg', mime: 'image/jpeg' });
    assert.throws(() => photoType(Buffer.from('<script>bad</script>')), /格式|照片/);
});
test('packaged core is exactly the selected commit with no benchmark code', () => {
    const bundle = JSON.parse(fs.readFileSync('frontend/vendor/colloidal/core.json'));
    assert.equal(bundle.commit, 'a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da');
    assert.equal(Object.keys(bundle.files).length, 8);
    for (const [name, source] of Object.entries(bundle.files)) {
        assert.equal(crypto.createHash('sha256').update(source).digest('hex'), bundle.hashes[name]);
        assert.ok(!/engines|store|reader_api|benchmark/.test(name));
    }
});
test('new migration has registered both-schema classification', () => {
    const name = '20261019120000_colloidal_photo_entries';
    const sql = fs.readFileSync(`backend/prisma/migrations/${name}/migration.sql`, 'utf8');
    const p = buildTenantProjection({ name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
    assert.equal(p.scope, 'both');
});

test('HTTP-compatible UUID fallback remains a valid unpredictable v4 identity', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: crypto.webcrypto.getRandomValues.bind(crypto.webcrypto) } });
        const ids = Array.from({ length: 20 }, () => newEntryId());
        assert.equal(new Set(ids).size, 20);
        assert.ok(ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)));
    } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete globalThis.crypto; }
});
