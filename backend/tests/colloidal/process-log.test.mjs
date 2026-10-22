import test from 'node:test';
import assert from 'node:assert/strict';
import { clientProcessEvents, algorithmProcessEvents } from '../../lib/colloidalProcessLog.js';

test('capture logs are labelled browser reports and cannot forge server or algorithm events', () => {
    const at = new Date().toISOString();
    const events = clientProcessEvents([
        { at, stage: 'photo_captured', origin: 'server', details: { width: 1920, height: 1080, previewRotation: 90, previewMirrorX: true, token: 'secret', photo: 'pixels' } },
        { at, stage: 'measurement', details: { c: 999 } }, { at: 'invalid', stage: 'camera_ready' },
    ]);
    assert.equal(events.length, 1); assert.equal(events[0].origin, 'browser');
    assert.deepEqual(events[0].details, { width: 1920, height: 1080, previewRotation: 90, previewMirrorX: true });
    assert.equal(clientProcessEvents(Array.from({ length: 1000 }, () => ({ at, stage: 'camera_ready' }))).length, 16);
});

test('algorithm diagnostics preserve compact geometry and numeric thresholds, with bounded events', () => {
    const input = { at: new Date().toISOString(), stage: 'measurement', state: 'warning', elapsed_ms: 12, details: { c: 2.436, threshold: 3, c_present: false, raw_profile: [1, 2, 3], path: '/private/runtime', measurement_lines_source: [{ label: 'C', points: [[1, 2], [3, 4]] }] } };
    const event = algorithmProcessEvents([input])[0];
    assert.equal(event.origin, 'algorithm'); assert.equal(event.details.threshold, 3);
    assert.deepEqual(event.details.measurement_lines_source[0].points, [[1, 2], [3, 4]]);
    assert.equal('raw_profile' in event.details, false); assert.equal('path' in event.details, false);
    assert.equal(algorithmProcessEvents(Array(1000).fill(input)).length, 160);
    assert.equal(algorithmProcessEvents(undefined)[0].stage, 'algorithm_log_unavailable');
});
