// Isolated synthetic optical/adapter regression. Never connects to a database.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { ColloidalRecognizer } from '../backend/lib/colloidalRecognizer.js';
import { compactResult, projectById } from '../backend/lib/colloidalReader.js';

const arg = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };
if (!arg('--python') || !arg('--fixtures')) throw new Error('Use --python /absolute/path/to/isolated/python --fixtures /path/to/synthetic-fixtures');
const fixtures = path.resolve(arg('--fixtures'));
const expected = JSON.parse(await fs.readFile(path.join(fixtures, 'native-results.json')));
const bundle = JSON.parse(await fs.readFile('frontend/vendor/colloidal/core.json'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'colloidal-server-regression-'));
let recognizer;
const observed = [];
try {
    for (const [name, source] of Object.entries(bundle.files)) {
        assert.equal(crypto.createHash('sha256').update(source).digest('hex'), bundle.hashes[name]);
        assert.ok(/^lab\/[a-z_]+\.py$/.test(name));
        const target = path.join(home, 'core', name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, source);
    }
    await fs.copyFile('backend/recognizer/server_entry.py', path.join(home, 'core/server_entry.py'));
    await fs.copyFile('backend/recognizer/worker.py', path.join(home, 'worker.py'));
    process.env.COLLOIDAL_RECOGNIZER_HOME = home;
    process.env.COLLOIDAL_RECOGNIZER_PYTHON = path.resolve(arg('--python'));
    recognizer = new ColloidalRecognizer();
    for (const reference of expected) {
        const raw = await recognizer.enqueue({ photoPath: path.join(fixtures, reference.filename || reference.name + '.png'), projectId: reference.projectId, mode: reference.inputMode || 'closeup' });
        const result = compactResult(raw, projectById(reference.projectId), reference.elapsedSeconds);
        observed.push({ name: reference.name, raw, result });
        assert.equal(raw.status, reference.status, reference.name);
        assert.deepEqual(raw.channels.map(c => [c.id, c.status, c.image_result]), reference.channels.map(c => [c.id, c.status, c.image_result]), reference.name);
        assert.deepEqual(result.channels.map(c => c.final_result), reference.channels.map(c => c.final_result), reference.name);
        reference.channels.forEach((channel, i) => {
            for (const key of ['c', 't']) if (channel[key] !== null) assert.ok(Math.abs(channel[key] - raw.channels[i][key]) < 0.000001, `${reference.name} ${key}`);
        });
    }
    console.log(JSON.stringify({ cases: observed.length, equivalent: true, pipeline: bundle.pipeline, patch: bundle.patch, fixtureKind: 'synthetic', physicalCardAccuracy: 'not_measured' }));
} finally {
    recognizer?.shutdown();
    await fs.writeFile(path.join(fixtures, 'server-verification.json'), JSON.stringify({ fixtureKind: 'synthetic', physicalCardAcceptance: false, cases: observed }, null, 2));
    await fs.rm(home, { recursive: true, force: true });
}
