// Explicit Node --require preload for the isolated local fixture only.
// Never imported by backend/server.js or production launchers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const statePath = path.resolve(process.env.COLLOIDAL_LOCAL_STATE_FILE || '/disabled');
const db = new URL(process.env.DATABASE_URL || 'file:///disabled');
if (process.env.NODE_ENV !== 'test' ||
    !statePath.startsWith(path.join(root, '.cache') + path.sep) ||
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    db.hostname !== '127.0.0.1' || db.port !== '55439' || db.pathname !== '/colloidal_fixture') {
    throw new Error('Password-free entry requires the isolated local test fixture');
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
if (state.code !== 'reader-local-1022' || state.username !== 'localreader' || !state.password) {
    throw new Error('Unexpected local trial identity');
}
const origins = new Set((process.env.CORS_ORIGIN || '').split(',').filter(Boolean));
const express = require(path.join(root, 'backend/node_modules/express'));
const prefix = '/reader-local-1022';
const sessionPath = prefix + '/local-test-session';
const pagePaths = new Set([prefix + '/', prefix + '/login', prefix + '/login.html', prefix + '/local-test']);
const init = express.application.init;
express.application.init = function () {
    init.call(this);
    this.use(async (req, res, next) => {
        const pathname = req.url.split('?')[0];
        if (!pagePaths.has(pathname) && pathname !== sessionPath) return next();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        const origin = protocol + '://' + req.headers.host;
        if (!origins.has(origin)) return res.status(403).end('Local trial origin only');
        if (pathname === sessionPath) {
            if (req.method !== 'POST') return res.status(405).end();
            if (req.headers.origin !== origin || req.headers['x-colloidal-local-entry'] !== '1') {
                return res.status(403).end('Same-origin local entry only');
            }
            try {
                const upstream = await fetch('http://127.0.0.1:' + process.env.PORT + '/api/user/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json',
                        'X-Device-Id': String(req.headers['x-device-id'] || '').slice(0, 128) },
                    body: JSON.stringify({ username: state.username, password: state.password, schoolCode: state.code }),
                    signal: AbortSignal.timeout(15000)
                });
                const data = await upstream.json();
                if (!upstream.ok || !data.success || !data.token) {
                    return res.status(503).json({ success: false, message: '本地测试账号暂不可用，请检查测试后端日志。' });
                }
                // Normal issued tokens; no credential, role fabrication or auth bypass.
                return res.json({ success: true, token: data.token, user: data.user,
                    expiresIn: data.expiresIn, refreshToken: data.refreshToken });
            } catch (_) {
                return res.status(503).json({ success: false, message: '本地测试后端暂未就绪，请稍后重试。' });
            }
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
        const nonce = crypto.randomBytes(18).toString('base64');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'nonce-" + nonce + "'; connect-src 'self'; style-src 'nonce-" + nonce + "'; base-uri 'none'; frame-ancestors 'none'");
        return res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进入胶体金本地测试</title>
<style nonce="${nonce}">body{font:18px sans-serif;line-height:1.8;max-width:640px;margin:12vh auto;padding:24px}button{font:inherit;padding:10px 24px}</style>
<h1>胶体金本地测试</h1><p id="status">正在进入独立测试环境，无需输入账号密码……</p><button id="retry" hidden>重新进入测试</button>
<script type="module" nonce="${nonce}">
import { authService } from '${prefix}/js/services/AuthService.js';
const status = document.getElementById('status');
const retry = document.getElementById('retry');
async function enter() {
    retry.hidden = true;
    status.textContent = '正在进入独立测试环境，无需输入账号密码……';
    try {
        // First call may create the cookie; read again to use its stable value,
        // matching subsequent refresh requests from the main application.
        authService._getDeviceHeader();
        const device = authService._getDeviceHeader();
        const response = await fetch('${sessionPath}', { method: 'POST', headers: {
            'X-Colloidal-Local-Entry': '1', ...(device ? { 'X-Device-Id': device } : {})
        } });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || '进入测试失败');
        authService.clearAuth();
        authService.saveToken(data.token, data.expiresIn, true);
        authService.saveUser(data.user, true);
        if (data.refreshToken) authService.saveRefreshToken(data.refreshToken, true);
        location.replace('${prefix}/index.html');
    } catch (error) { status.textContent = error.message; retry.hidden = false; }
}
retry.addEventListener('click', enter);
enter();
</script></html>`);
    });
};
