const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const filesToCopy = [
  'index.html',
  'login.html'
];

const dirsToCopy = [
  'css',
  'js'
];

function ensureCleanDist() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
}

function copyFileRelative(relPath) {
  const src = path.join(root, relPath);
  const dst = path.join(dist, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required file: ${relPath}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDirRelative(relPath) {
  const src = path.join(root, relPath);
  const dst = path.join(dist, relPath);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required directory: ${relPath}`);
  }
  fs.cpSync(src, dst, { recursive: true });
}

function main() {
  ensureCleanDist();

  for (const relFile of filesToCopy) {
    copyFileRelative(relFile);
  }

  for (const relDir of dirsToCopy) {
    copyDirRelative(relDir);
  }

  console.log('Build completed: dist/ generated successfully');
}

main();
