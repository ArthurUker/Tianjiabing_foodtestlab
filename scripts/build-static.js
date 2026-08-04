/**
 * 构建脚本：生成 dist/ 目录（纯文件拷贝，无 webpack/rollup 编译）。
 *
 * RK42 提醒：本脚本仅在每次 source 变更后手动执行 `node scripts/build-static.js`
 * 才会更新 dist/。若未重建，dist/ 中可能是旧版本代码（缺少新增的 ES module 函数）。
 * 生产环境 Caddy 若直接 serve dist/，请确保部署前重建：node scripts/build-static.js
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const filesToCopy = [
  'index.html',
  'login.html',
  'admin-schools.html',
  'super-admin-login.html',
  'help.html'
];

const dirsToCopy = [
  'css',
  'js',
  'vendor'
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
