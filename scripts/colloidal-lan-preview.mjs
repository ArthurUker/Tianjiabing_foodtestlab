// Local trial only: a LAN-bound HTTPS proxy and certificate setup page.
// No tunnel, production config, system trust store or database changes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const arg = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
const host = arg('--host');
if (!host || !Object.values(os.networkInterfaces()).flat().some(n => n?.address === host && n.family === 'IPv4' && !n.internal)) throw new Error('--host must be an IPv4 address assigned to a local LAN interface');
if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error('Only private LAN interfaces are allowed');
const port = Number(arg('--https-port', '55543')), setupPort = Number(arg('--setup-port', '55538')), upstream = Number(arg('--upstream-port', '55539'));
for (const p of [port, setupPort, upstream]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Invalid unprivileged port');
const dir = path.resolve(arg('--runtime-dir', '.cache/colloidal-lan-preview'));
if (!dir.startsWith(path.resolve('.cache') + path.sep)) throw new Error('Runtime certificates must live under this checkout .cache');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = name => path.join(dir, name);
const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
if (!fs.existsSync(file('ca.key'))) {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-subj', '/CN=Colloidal LAN Trial CA 20261022',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout', file('ca.key'), '-out', file('ca.pem'));
}
const dns = os.hostname().replace(/\.local$/, '') + '.local';
fs.writeFileSync(file('leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${host},IP:127.0.0.1,DNS:localhost,DNS:${dns}\n`);
openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-keyout', file('server.key'), '-out', file('server.csr'));
openssl('x509', '-req', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-out', file('server.pem'), '-days', '30', '-sha256', '-extfile', file('leaf.ext'));
openssl('x509', '-in', file('ca.pem'), '-outform', 'der', '-out', file('colloidal-lan-ca.cer'));
for (const name of ['ca.key', 'server.key']) fs.chmodSync(file(name), 0o600);
const cert = fs.readFileSync(file('colloidal-lan-ca.cer'));
const fingerprint = crypto.createHash('sha256').update(cert).digest('hex').match(/../g).join(':');
const target = `https://${host}:${port}/reader-local-1022/login.html`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>胶体金局域网测试设置</title><body style="font:17px sans-serif;line-height:1.7;max-width:800px;margin:30px auto;padding:18px;overflow-wrap:anywhere"><h1>胶体金局域网测试</h1><p>本页面仅提供证书设置。独立本地测试后端启用免密码入口后，打开HTTPS系统即可进入测试。</p><p><a href="/colloidal-lan-ca.cer">下载本次局域网测试根证书</a></p><p>证书名称：Colloidal LAN Trial CA 20261022；有效期30天。仅在参与本次测试的设备安装，测试结束后可移除。此页面不会自动安装或信任证书。</p><p>iPhone / iPad：下载后在“设置 → 通用 → VPN与设备管理”安装描述文件，再到“设置 → 通用 → 关于本机 → 证书信任设置”启用该根证书的完全信任。</p><p>安卓：下载证书后，在系统设置中查找“安装证书／CA证书”，选择该文件；不同品牌入口不同。</p><p>电脑：将该证书导入本机受信任的根证书存储；macOS可用“钥匙串访问”导入并设置信任。无需安装任何证书私钥。</p><p>完成后：<a href="${target}">打开HTTPS测试系统</a>，按浏览器提示允许相机。</p><p>同一局域网的IP：${host}。打不开时检查两台设备是否在相同网络、路由器是否开启客户端隔离、Mac是否允许Node接收入站连接。</p><p>根证书SHA256：${fingerprint}</p><p><a href="https://support.apple.com/zh-cn/102390">Apple证书信任说明</a> · <a href="https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia">浏览器相机HTTPS要求</a></p></body></html>`;
const setup = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/colloidal-lan-ca.cer') {
        res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="colloidal-lan-ca.cer"' }); res.end(cert);
    } else if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
    else { res.writeHead(404); res.end('Not found'); }
});
const proxy = https.createServer({ key: fs.readFileSync(file('server.key')), cert: fs.readFileSync(file('server.pem')), minVersion: 'TLSv1.2' }, (req, res) => {
    const forwarded = http.request({ hostname: '127.0.0.1', port: upstream, path: req.url, method: req.method,
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': req.socket.remoteAddress }, timeout: 240000 }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Local trial backend unavailable'); });
    forwarded.on('timeout', () => forwarded.destroy()); req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded);
});
setup.on('error', e => { console.error(e.message); process.exit(1); }); proxy.on('error', e => { console.error(e.message); process.exit(1); });
setup.listen(setupPort, host, () => console.log(`Certificate setup: http://${host}:${setupPort}/`));
proxy.listen(port, host, () => console.log(`LAN trial: ${target}\nCA SHA256: ${fingerprint}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { setup.close(); proxy.close(); setTimeout(() => process.exit(0), 1000).unref(); });
