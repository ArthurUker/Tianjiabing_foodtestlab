// Reproducible release packaging. Only the selected v5 core is read from Git.
// No photographs, lab database, benchmark adapters or weights are included.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'frontend/vendor/colloidal');
const commit = 'a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex >= 0) {
  const source = process.argv[sourceIndex + 1];
  if (!source) throw new Error('--source requires a checkout path');
  const files = {};
  const names = ['__init__.py', 'reader.py', 'reader_config.py', 'reader_geometry.py',
    'reader_measurement.py', 'reader_optical_audit.py', 'reader_learning.py', 'rules.py'];
  for (const name of names) files[`lab/${name}`] = execFileSync('git', ['-C', source, 'show', `${commit}:lab/${name}`], { encoding: 'utf8' });
  const license = execFileSync('git', ['-C', source, 'show', `${commit}:LICENSE`], { encoding: 'utf8' });
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(path.join(assets, 'core.json'), JSON.stringify({
    repository: 'ArthurUker/colloidal-gold-reader-lab', commit,
    pipeline: 'project-marker-quality-20261018-v5', license,
    hashes: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])), files,
  }, null, 2) + '\n');
  console.log('Packaged selected v5 core from ' + commit);
}
if (!process.argv.includes('--core-only')) {
  const lock = JSON.parse(await fs.readFile(path.join(assets, 'runtime-lock.json'), 'utf8'));
  const destination = path.join(assets, 'runtime');
  await fs.mkdir(destination, { recursive: true });
  for (const asset of lock.assets) {
    const target = path.join(destination, asset.name);
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && sha(existing) === asset.sha256) continue;
    const response = await fetch(asset.url || lock.baseUrl + asset.name, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`${asset.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== asset.sha256) throw new Error(`${asset.name}: SHA256 mismatch`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target + '.tmp', bytes);
    await fs.rename(target + '.tmp', target);
    console.log(`Prepared ${asset.name} (${bytes.length} bytes)`);
  }
  console.log('Pinned browser runtime ready; all assets served from this site.');
}
