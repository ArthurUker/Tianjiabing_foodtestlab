import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto, { randomUUID } from 'node:crypto';
import { PROJECTS, PIPELINE } from '../../../frontend/js/colloidal/contract.js';
import { samplingSummary, captureInSlot } from '../../../frontend/js/colloidal/sampling.js';
import { samplingCaptureData } from '../../lib/colloidalSampling.js';
import { compactResult } from '../../lib/colloidalReader.js';
import { buildTenantProjection } from '../../lib/tenantProvisioner.js';

const project = PROJECTS[0];
const session = { id: randomUUID(), planId: 'minutes_5_6_7', startedAt: '2026-10-22T00:00:00.000Z', state: 'completed' };
const rows = (p = project) => [300, 360, 420].map((elapsed, i) => ({
    id: randomUUID(), sample_index: i + 1, time_source: 'scheduled_camera', elapsed_seconds: elapsed,
    captured_at: new Date(Date.parse(session.startedAt) + elapsed * 1000), completed_at: new Date(), photo_state: 'present',
    result: compactResult({ status: 'ok', version: PIPELINE, channels: p.channels.map(c => ({ id: c.id, status: 'ok', c: 10, t: 20, c_present: true })) }, p, elapsed),
}));
test('three valid original samples adopt the last result only after the session ends', () => {
    const attempts = rows();
    const summary = samplingSummary(session, attempts, project);
    assert.equal(summary.eligible, true); assert.equal(summary.validCount, 3); assert.equal(summary.adoptedAttemptId, attempts[2].id);
    assert.equal(samplingSummary({ ...session, state: 'running' }, attempts, project).eligible, false);
});
test('two matching valid samples win, while a contradictory third remains visible', () => {
    const attempts = rows(); attempts[1].result.channels[0].final_result = 'positive';
    const s = samplingSummary(session, attempts, project);
    assert.equal(s.status, 'consistent'); assert.equal(s.validCount, 3); assert.equal(s.eligible, true);
    assert.equal(s.agreeCount, 2); assert.equal(s.hasDisagreement, true); assert.equal(s.adoptedAttemptId, attempts[2].id);
});
test('triplex compares all channels, without creating nine formal tests', () => {
    const p = PROJECTS.at(-1), attempts = rows(p);
    assert.equal(samplingSummary(session, attempts, p).eligible, true);
    attempts[2].result.channels[2].final_result = 'positive';
    assert.equal(samplingSummary(session, attempts, p).adoptedAttemptId, attempts[1].id);
    attempts[1].result.channels[1].final_result = 'positive';
    assert.equal(samplingSummary(session, attempts, p).eligible, false);
});
test('fewer than two valid samples and assumed time cannot auto-save', () => {
    for (const mutate of [a => { a[0].photo_state = 'absent'; a[1].photo_state = 'absent'; }, a => { a[0].result.eligible = false; a[1].result.eligible = false; },
        a => { a[0].result.channels[0].rule_status = 'within_time_assumed'; a[1].result.channels[0].rule_status = 'within_time_assumed'; }, a => { a.pop(); a.pop(); }]) {
        const attempts = rows(); mutate(attempts); assert.equal(samplingSummary(session, attempts, project).eligible, false);
    }
    assert.equal(samplingSummary({ ...session, state: 'interrupted' }, rows().slice(0, 1), project).eligible, false);
});
test('ending early after two valid matching captures preserves their usable result', () => {
    const attempts = rows().slice(0, 2);
    const s = samplingSummary({ ...session, state: 'interrupted' }, attempts, project);
    assert.equal(s.eligible, true); assert.equal(s.agreeCount, 2); assert.equal(s.state, 'interrupted');
    assert.equal(s.adoptedAttemptId, attempts[1].id);
});
test('a failed third sample does not discard two valid matching snapshots', () => {
    const attempts = rows(); attempts[2].result = { status: 'quality_failed', eligible: false, channels: [] };
    const s = samplingSummary(session, attempts, project);
    assert.equal(s.eligible, true); assert.equal(s.validCount, 2); assert.equal(s.adoptedAttemptId, attempts[1].id);
});
test('later original-photo retention does not erase historical recognition statistics', () => {
    const attempts = rows();
    for (const a of attempts) { a.photo_state = 'purged'; a.photo_sha256 = 'a'.repeat(64); }
    assert.equal(samplingSummary(session, attempts, project).validCount, 3);
});
test('no catch-up bursts: each snapshot has a 15-second acquisition tolerance inside the IFU window', () => {
    assert.equal(captureInSlot(session.planId, 1, 300), true); assert.equal(captureInSlot(session.planId, 1, 315), true);
    for (const elapsed of [299.99, 315.001, 360, 481]) assert.equal(captureInSlot(session.planId, 1, elapsed), false);
    assert.equal(captureInSlot(session.planId, 3, 420), true);
    assert.equal(captureInSlot(session.planId, 4, 450), false);
});
test('a scheduled photo binds session, camera source, actual monotonic elapsed and wall time', () => {
    const entry = { sampling: { ...session, state: 'running' } };
    const body = { samplingId: session.id, sampleIndex: 1, source: 'camera', timeSource: 'scheduled_camera', elapsedSeconds: 301,
        capturedAt: '2026-10-22T00:05:01.000Z' };
    assert.equal(samplingCaptureData(entry, body).captured_at.toISOString(), body.capturedAt);
    for (const change of [{ samplingId: randomUUID() }, { source: 'upload' }, { elapsedSeconds: 360 },
        { capturedAt: '2026-10-22T00:00:00.000Z' }, { capturedAt: null }, { sampleIndex: 0 }]) assert.throws(() => samplingCaptureData(entry, { ...body, ...change }));
    assert.equal(samplingCaptureData(entry, { ...body, capturedAt: null, elapsedSeconds: null }).captured_at, null);
});
test('sampling migration is append-only and classified for public plus every tenant', () => {
    const name = '20261022120000_colloidal_timed_sampling';
    const sql = fs.readFileSync(`backend/prisma/migrations/${name}/migration.sql`, 'utf8');
    const projection = buildTenantProjection({ name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
    assert.equal(projection.scope, 'both'); assert.equal(projection.classification.stmtCount, 4);
});
