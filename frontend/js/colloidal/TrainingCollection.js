import { authService } from '../services/AuthService.js';

const $ = id => document.getElementById(id);
const prefix = location.pathname.replace(/\/[^/]*$/, '');
const apiRoot = '/api/colloidal/training';
const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6]&15)|64; b[8] = (b[8]&63)|128;
    const s = [...b].map(n => n.toString(16).padStart(2, '0')).join('');
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
};
let token, db, uploading = false, latestId = null, previewUrl = null;
const verification = new URLSearchParams(location.search).get('verification') === '1';
let sessionId = localStorage.getItem('colloidal-training-session') || uuid();
localStorage.setItem('colloidal-training-session', sessionId);
$('physical-card').value = localStorage.getItem('colloidal-training-card') || '';
$('background').value = localStorage.getItem('colloidal-training-background') || '白纸';
$('batch').textContent = sessionId.slice(0, 8);
$('physical-card').oninput = () => localStorage.setItem('colloidal-training-card', $('physical-card').value);
$('background').onchange = () => localStorage.setItem('colloidal-training-background', $('background').value);
$('new-batch').onclick = () => { sessionId = uuid(); localStorage.setItem('colloidal-training-session', sessionId); $('batch').textContent = sessionId.slice(0, 8); };

function notice(message, bad = false) { $('notice').textContent = message; $('connection').parentElement.classList.toggle('error', bad); }
function openQueue() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('colloidal-training-capture-queue', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
}
function queueTransaction(mode, operation) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('captures', mode); const request = operation(transaction.objectStore('captures'));
        transaction.oncomplete = () => resolve(request.result); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
}
async function login() {
    authService._getDeviceHeader(); const device = authService._getDeviceHeader();
    const r = await fetch(prefix+'/local-test-session', { method: 'POST', headers: { 'X-Colloidal-Local-Entry': '1', ...(device ? { 'X-Device-Id': device } : {}) } });
    const result = await r.json();
    if (!r.ok || !result.token) throw new Error(result.message || '本地测试环境未就绪');
    token = result.token;
}
async function api(suffix, options = {}, retry = true) {
    const response = await fetch(apiRoot+suffix, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if (response.status === 401 && retry) { await login(); return api(suffix, options, false); }
    if (options.photo && response.ok) return response.blob();
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || body.message || `请求失败 ${response.status}`);
    return body;
}
async function display(blob, prediction) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    const image = new Image(); image.src = previewUrl; await image.decode();
    const canvas = $('preview'); const scale = Math.min(1, 1000/Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth*scale); canvas.height = Math.round(image.naturalHeight*scale);
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (prediction) {
        const sx = canvas.width/prediction.original_width, sy = canvas.height/prediction.original_height;
        const polygon = (points, color) => { context.strokeStyle = color; context.lineWidth = 2; context.beginPath(); points.forEach(([x,y],i) => i ? context.lineTo(x*sx,y*sy) : context.moveTo(x*sx,y*sy)); context.closePath(); context.stroke(); };
        for (const card of prediction.card_instances || []) { polygon(card.card.polygon, '#3077ff'); for (const window of card.windows) polygon(window.polygon, '#00bd9b'); }
    }
    $('latest').hidden = false;
}
async function acceptFiles(files, source) {
    for (const file of files) {
        if (!file.size || file.size > 15*1024*1024) { notice(`${file.name} 未加入：请选择15MB以内的照片。`, true); continue; }
        const capture = { id: uuid(), file, metadata: { source, filename: file.name, capturedAt: new Date().toISOString(),
            sessionId, physicalCardGroup: $('physical-card').value.trim(), background: $('background').value,
            ...(verification ? { purpose: 'verification' } : {}) } };
        try { await queueTransaction('readwrite', store => store.put(capture)); }
        catch { notice('手机无法保存待上传照片，请保留相册原图并重试。', true); return; }
        latestId = capture.id;
        $('latest-status').textContent = '已保存在本手机队列，等待原图上传确认…';
        await display(file).catch(() => {});
    }
    $('camera-file').value = ''; $('upload-file').value = '';
    await refresh().catch(() => {}); drain();
}
async function drain() {
    if (uploading || !token || !db) return;
    uploading = true;
    try {
        for (const capture of await queueTransaction('readonly', store => store.getAll())) {
            notice('正在保存原照片，请保持页面打开…');
            try {
                const receipt = await api(`/captures/${capture.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream',
                    'X-Capture-Metadata': encodeURIComponent(JSON.stringify(capture.metadata)) }, body: capture.file });
                if (!receipt.originalSaved || receipt.capture.bytes !== capture.file.size) throw new Error('尚未收到完整原图保存确认');
                await queueTransaction('readwrite', store => store.delete(capture.id));
                notice('原图已保存到 Mac，AI 定位正在排队。可以继续拍下一张。');
                if (latestId === capture.id) $('latest-status').textContent = '原图已保存 · AI 定位处理中';
            } catch (e) { notice(`${e.message}；原图仍保留在本手机队列，联网后点“重试”。`, true); break; }
        }
    } finally { uploading = false; await refresh().catch(() => {}); }
}
const stateText = r => r.ai_state === 'completed' ? `AI候选：${r.ai_prediction?.card_instances?.length || 0} 张卡 / ${(r.ai_prediction?.card_instances || []).reduce((n,c)=>n+c.windows.length,0)} 个膜窗（待审核）`
    : r.ai_state === 'failed' ? 'AI未完成，原图仍已保存' : 'AI定位处理中';
async function refresh() {
    const queued = db ? (await queueTransaction('readonly', store => store.getAll())).length : 0;
    const data = await api('/captures');
    $('counts').textContent = `Mac 已保存 ${data.trainingCaptures} 张采集记录 · 本手机待上传 ${queued} 张`;
    $('history').replaceChildren();
    for (const row of data.captures.filter(r => r.purpose !== 'verification').slice(0, 30)) {
        const section = document.createElement('div'); section.className = 'history-row';
        const label = document.createElement('strong'); label.textContent = `${new Date(row.received_at).toLocaleTimeString()} · ${row.background} · ${row.physical_card_group || '卡片编号未填'}`;
        const state = document.createElement('small'); state.textContent = `原图已保存 · ${stateText(row)} · ${(row.bytes/1024/1024).toFixed(2)} MB`;
        const button = document.createElement('button'); button.textContent = '查看照片与定位';
        button.onclick = async () => { latestId = row.capture_id; $('latest-status').textContent = '原图已保存 · '+stateText(row); await display(await api(`/captures/${row.capture_id}/photo`, { photo: true }), row.ai_prediction); $('latest').scrollIntoView({ behavior: 'smooth' }); };
        section.append(label, state, button); $('history').append(section);
    }
    const latest = data.captures.find(r => r.capture_id === latestId);
    if (latest) {
        $('latest-status').textContent = '原图已保存 · '+stateText(latest);
        if (latest.ai_state === 'completed' && $('preview').dataset.predictionId !== latest.capture_id) {
            await display(await api(`/captures/${latest.capture_id}/photo`, { photo: true }), latest.ai_prediction);
            $('preview').dataset.predictionId = latest.capture_id;
        }
    }
}
$('camera').onclick = () => $('camera-file').click(); $('upload').onclick = () => $('upload-file').click();
$('camera-file').onchange = () => acceptFiles([...$('camera-file').files], 'camera');
$('upload-file').onchange = () => acceptFiles([...$('upload-file').files], 'upload');
$('retry').onclick = () => drain().then(refresh).catch(e => notice(e.message, true));
window.addEventListener('online', () => drain());
async function start() {
    try { db = await openQueue(); await login(); await refresh(); $('connection').textContent = '已连接 Mac · 原图留存开启'; $('camera').disabled = false; $('upload').disabled = false; drain(); }
    catch (e) { $('connection').textContent = '暂未连接'; notice(e.message, true); }
}
start(); setInterval(() => { if (token) refresh().catch(() => {}); }, 2500);
