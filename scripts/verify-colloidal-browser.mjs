// Isolated desktop browser equivalence probe. Not physical phone acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
if (!arg('--playwright') || !arg('--fixtures')) throw new Error('Use --playwright /path/to/playwright-core/index.mjs --fixtures /path/to/native-fixtures [--engine webkit] [--chromium /path/to/Chrome]');
const playwright = await import(pathToFileURL(path.resolve(arg('--playwright'))).href);
const fixtures = path.resolve(arg('--fixtures'));
const expected = JSON.parse(await fs.readFile(path.join(fixtures, 'native-results.json')));
const frontend = path.resolve('frontend');
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Selected v5 runtime verification</title>'); }
        const base = url.pathname.startsWith('/fixtures/') ? fixtures : frontend;
        const file = path.resolve(base, url.pathname.startsWith('/fixtures/') ? path.basename(url.pathname) : '.' + url.pathname);
        if (!file.startsWith(base + path.sep)) throw new Error('path');
        res.setHeader('Content-Type', /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = arg('--engine') || 'chromium';
let browser;
try {
    browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' && arg('--chromium') ? { executablePath: arg('--chromium') } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const observed = await page.evaluate(async cases => {
        const worker = new Worker('/js/colloidal/reader.worker.js', { type: 'module' });
        const results = [];
        try {
            for (const [id, c] of cases.entries()) {
                const bytes = await (await fetch('/fixtures/' + (c.filename || c.name + '.png'))).arrayBuffer();
                const start = performance.now();
                const result = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('runtime timeout')), 180000);
                    worker.onmessage = e => { clearTimeout(timer); resolve(e.data.result); };
                    worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
                    worker.postMessage({ id, bytes, projectId: c.projectId, elapsedSeconds: c.elapsedSeconds, inputMode: c.inputMode || 'closeup' }, [bytes]);
                });
                results.push({ name: c.name, wall_ms: performance.now() - start, result });
            }
        } finally { worker.terminate(); }
        return results;
    }, expected);
    const report = { engine, browserVersion: browser.version(), fixtureKind: 'synthetic', physicalPhoneAcceptance: false, cases: observed };
    // Preserve observations even when a regression assertion fails.
    await fs.writeFile(path.join(fixtures, `${engine}-verification.json`), JSON.stringify(report, null, 2));
    for (const [i, observedCase] of observed.entries()) {
        const reference = expected[i];
        assert.equal(observedCase.result.status, reference.status, reference.name);
        assert.deepEqual(observedCase.result.channels.map(c => [c.id, c.status, c.image_result, c.final_result]), reference.channels.map(c => [c.id, c.status, c.image_result, c.final_result]), reference.name);
        // Different native/WASM library versions may differ numerically. The
        // bound is a regression check on these fixtures, not an optical margin.
        reference.channels.forEach((c, j) => {
            for (const key of ['c', 't']) if (c[key] !== null) assert.ok(Math.abs(c[key] - observedCase.result.channels[j][key]) < 0.05, `${reference.name} ${key}: native=${c[key]} wasm=${observedCase.result.channels[j][key]}`);
        });
    }
    console.log(JSON.stringify({ engine, cases: observed.length, equivalent: true, coldWallMs: observed[0].wall_ms, warmWallMs: observed.slice(1).map(c => c.wall_ms) }));
} finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
}
