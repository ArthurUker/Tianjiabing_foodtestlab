import crypto from 'node:crypto';
import { PROJECTS, PIPELINE, CORE_COMMIT, CORE_PATCH, projectById, resultText } from '../../frontend/js/colloidal/contract.js';
export { PROJECTS, PIPELINE, CORE_COMMIT, CORE_PATCH, projectById };
export const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
    return v;
}
const text = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';

const CONTEXT_LABELS = { testDate: '检测日期', canteen: '食堂', inspector: '检测员', vegetableType: '蔬菜品种', meatType: '肉类' };

// requireComplete=false 时允许先建单后补上下文（照片识别在填检测员之前也可能开始），
// 保存记录前必须用默认的 requireComplete=true 复核。
export function normalizeContext(input, project, { requireComplete = true } = {}) {
    const value = {};
    for (const key of ['testDate', 'canteen', 'inspector', project.module === 'pesticide' ? 'vegetableType' : 'meatType']) {
        value[key] = text(input?.[key]);
        if (!value[key] && requireComplete) throw fail(400, 'MISSING_CONTEXT', `请先填写${CONTEXT_LABELS[key] || key}`);
    }
    if (value.testDate && (!/^\d{4}-\d{2}-\d{2}$/.test(value.testDate) || !Number.isFinite(Date.parse(value.testDate)) || new Date(value.testDate).toISOString().slice(0, 10) !== value.testDate))
        throw fail(400, 'INVALID_DATE', '检测日期无效');
    value.remark = text(input?.remark, 1000);
    const custom = input?.customFields || {};
    if (typeof custom !== 'object' || Array.isArray(custom) || Buffer.byteLength(JSON.stringify(custom)) > 8192) throw fail(400, 'INVALID_CUSTOM_FIELDS', '自定义字段格式错误');
    const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'photoRecognition', 'resultSource', 'entryPath', 'result', 'status', 'version', 'batchNo', 'testDate', 'canteen', 'inspector', 'meatType', 'vegetableType']);
    value.customFields = {};
    for (const [key, v] of Object.entries(custom)) {
        if (forbidden.has(key)) throw fail(400, 'INVALID_CUSTOM_FIELDS', '自定义字段包含保留键');
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v) && !(Array.isArray(v) && v.length <= 50 && v.every(x => typeof x === 'string'))) throw fail(400, 'INVALID_CUSTOM_FIELDS', '自定义字段值无效');
        value.customFields[key] = v;
    }
    return value;
}

export function photoType(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 15 * 1024 * 1024) throw fail(400, 'PHOTO_SIZE', '照片为空或超过15MB');
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mime: 'image/png' };
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (bytes.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(bytes.toString('ascii', 8, 12))) return { ext: 'heic', mime: 'image/heic' };
    throw fail(400, 'PHOTO_FORMAT', '请选择JPG、PNG、WebP或HEIC原始照片');
}

const failureStates = new Set(['board_not_detected', 'localization_failed', 'structure_mismatch', 'orientation_failed',
    'quality_failed', 'profile_required', 'engine_error', 'decode_failed', 'runtime_timeout', 'interrupted', 'upload_failed', 'sample_missed', 'capture_failed']);

// Client-computed measurements are labelled as such. Server derives IFU/time
// semantics and refuses incomplete/mismatched channels; no pixel arrays persist.
export function compactResult(input, project, elapsed, { assumeWithinTime = false } = {}) {
    if (!input || typeof input !== 'object') throw fail(400, 'INVALID_RESULT', '识别结果格式错误');
    const status = input.status;
    if (!['ok', 'partial', ...failureStates].includes(status)) throw fail(400, 'INVALID_RESULT', '未知识别状态');
    if (['ok', 'partial'].includes(status) && input.version !== PIPELINE) throw fail(400, 'CORE_VERSION', '识别核心版本不一致');
    const raw = Array.isArray(input.channels) ? input.channels : [];
    if ((status === 'ok' || status === 'partial') && (raw.length !== project.channels.length || raw.some((v, i) => v.id !== project.channels[i].id)))
        throw fail(400, 'CHANNEL_MISMATCH', '识别通道与所选项目不一致');
    if (raw.length > project.channels.length) throw fail(400, 'CHANNEL_MISMATCH', '识别通道过多');
    const withinTime = assumeWithinTime || (elapsed !== null && elapsed >= 300 && elapsed <= 480);
    const channels = raw.map((item, i) => {
        if (item.id !== project.channels[i].id) throw fail(400, 'CHANNEL_MISMATCH', '识别通道顺序不一致');
        if (item.status !== 'ok') return { id: item.id, status: 'quality_failed', error: text(item.error, 240), image_result: null, final_result: null, rule_status: 'unmeasurable' };
        if (![item.c, item.t].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0) || typeof item.c_present !== 'boolean')
            throw fail(400, 'INVALID_MEASUREMENT', 'C/T测量数据无效');
        const image = !item.c_present ? 'invalid' : item.t >= item.c ? 'negative' : 'positive';
        return { id: item.id, status: 'ok', c: item.c, t: item.t, c_present: item.c_present,
            image_result: image, final_result: withinTime ? image : elapsed === null ? null : 'invalid',
            rule_status: assumeWithinTime ? 'within_time_assumed' : elapsed === null ? 'time_unverified' : withinTime ? 'within_time' : 'outside_time' };
    });
    if (status === 'ok' && channels.some(c => c.status !== 'ok')) throw fail(400, 'INVALID_RESULT', '完成状态与通道状态不一致');
    return { status, error: text(input.error, 240), version: PIPELINE, core_commit: CORE_COMMIT,
        computed_at: 'browser', elapsed_ms: typeof input.elapsed_ms === 'number' && Number.isFinite(input.elapsed_ms) ? Math.max(0, input.elapsed_ms) : null,
        time_basis: assumeWithinTime ? 'within_window_confirmed' : elapsed === null ? 'unknown' : 'measured',
        client: { userAgent: text(input.client?.userAgent, 300) },
        runtime: text(input.runtime, 80), decoder: text(input.decoder, 80),
        core_patch: text(input.core_patch ?? CORE_PATCH, 20),
        channels, eligible: status === 'ok' && withinTime && channels.length === project.channels.length && channels.every(c => resultText(c.final_result)) };
}

export function elapsedValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86400 * 365) throw fail(400, 'INVALID_ELAPSED', '拍摄时距加样时间无效');
    return value;
}

export function readRetentionDays() {
    const raw = process.env.COLLOIDAL_PHOTO_RETENTION_DAYS;
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw fail(500, 'RETENTION_CONFIG', '照片留存期限配置无效');
    return n;
}
