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
  'help.html',
  'test-report.html',
  'detergent-image-demo.html'
];

const dirsToCopy = [
  'css',
  'js',
  'vendor',
];

// 可选目录：docs/test-results/latest 是运行时由 testReportSync 生成的中间源，
// 全新 clone 部署（仓库未收录该产物）时可能尚不存在，跳过即可，等有测试数据提交后自动生成。
const optionalDirsToCopy = [
  'docs/test-results/latest',
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

// 复制可选目录：源不存在时仅跳过（打印日志），保证全新部署不因缺 docs 中间源而失败。
function copyDirRelativeOptional(relPath) {
  const src = path.join(root, relPath);
  if (!fs.existsSync(src)) {
    console.log(`Skip missing optional directory: ${relPath}`);
    return;
  }
  copyDirRelative(relPath);
}

function main() {
  ensureCleanDist();

  for (const relFile of filesToCopy) {
    copyFileRelative(relFile);
  }

  for (const relDir of dirsToCopy) {
    copyDirRelative(relDir);
  }

  for (const relDir of optionalDirsToCopy) {
    copyDirRelativeOptional(relDir);
  }

  console.log('Build completed: dist/ generated successfully');
}

main();
