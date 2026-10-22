import test from 'node:test';
import assert from 'node:assert/strict';
import { recognitionGeometry } from '../../../frontend/js/colloidal/RecognitionImages.js';

const space = 'exif_corrected_original_pixels';
const event = (stage, details, state = 'ok') => ({ stage, details, state, origin: 'algorithm' });
const box = [[858.365, 528.658], [858.337, 510.618], [972.953, 509.892], [973.138, 527.924]];

test('render coordinates from the final original-space receipt, preserving an incorrectly located window', () => {
    const lines = [{ label: 'C', points: [[904.694, 526.237], [904.624, 512.444]] }];
    const result = recognitionGeometry([
        event('decode', { decoded_width: 1920, decoded_height: 1080 }),
        event('board_geometry', { coordinate_space: space, slot_polygon_source: box }),
        event('localization', { coordinate_space: space, window_polygons_source: [box], measurement_polygons_source: [box] }),
        event('measurement', { channel_id: 'carbofuran', c_present: false, measurement_lines_source: lines }, 'warning'),
        { ...event('localization', { coordinate_space: space, window_polygons_source: [[[1, 1], [2, 1], [2, 2], [1, 2]]] }), origin: 'browser' },
    ]);
    assert.deepEqual(result.windows, [box]); assert.deepEqual(result.lines[0].points, lines[0].points);
    assert.equal(result.lines[0].present, false); assert.equal(result.width, 1920);
});

test('failed localization never fabricates a window or C/T lines from slot candidates', () => {
    const result = recognitionGeometry([
        event('board_geometry', { coordinate_space: space, slot_polygon_source: box }),
        event('window_selection', { polygons_slot: [box] }),
        event('localization', { coordinate_space: space, window_polygons_source: [box] }, 'failed'),
        event('measurement', { measurement_lines_source: [{ label: 'C', points: [[1, 2], [3, 4]] }] }),
    ]);
    assert.deepEqual(result.slot, box); assert.deepEqual(result.windows, []); assert.deepEqual(result.lines, []);
});

test('unknown coordinate space and malformed points are excluded from overlays', () => {
    assert.deepEqual(recognitionGeometry([event('localization', { coordinate_space: 'slot', window_polygons_source: [box] })]).windows, []);
    assert.deepEqual(recognitionGeometry([event('localization', { coordinate_space: space, window_polygons_source: [[[NaN, 1], [1, 2], [2, 3], [3, 4]]] })]).windows, []);
    assert.equal(recognitionGeometry(null).slot, null);
});
