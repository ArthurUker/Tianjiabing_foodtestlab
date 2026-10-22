// Render the coordinates actually reported by the algorithm, never a new locator.
import { PROJECTS } from './contract.js';

const SPACE = 'exif_corrected_original_pixels';
const colors = { slot: '#eab308', window: '#16a34a', region: '#0891b2', C: '#9333ea', T: '#e11d48' };
const node = (tag, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };
const points = (value, count) => Array.isArray(value) && value.length === count && value.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) < 1e6)) ? value : null;
// Reject an invalid group together, so triplex channel indexes never shift.
const polygons = value => Array.isArray(value) && value.length <= 3 && value.every(p => points(p, 4)) ? value : [];

export function recognitionGeometry(events) {
    const algorithm = (Array.isArray(events) ? events : []).filter(e => e.origin === 'algorithm');
    const last = stage => algorithm.filter(e => e.stage === stage && e.state === 'ok').at(-1)?.details || {};
    const decode = last('decode'), board = last('board_geometry'), located = last('localization');
    const windows = located.coordinate_space === SPACE ? polygons(located.window_polygons_source) : [];
    return { width: decode.decoded_width, height: decode.decoded_height,
        slot: board.coordinate_space === SPACE ? points(board.slot_polygon_source, 4) : null,
        windows, regions: located.coordinate_space === SPACE ? polygons(located.measurement_polygons_source) : [],
        lines: windows.length ? algorithm.filter(e => e.stage === 'measurement').flatMap(e =>
            (Array.isArray(e.details?.measurement_lines_source) ? e.details.measurement_lines_source : []).slice(0, 2)
                .filter(l => ['C', 'T'].includes(l.label) && points(l.points, 2))
                .map(l => ({ ...l, channel: e.details.channel_id, present: e.details.c_present }))).slice(0, 6) : [],
    };
}

function bounds(polys, width, height, padding = 0) {
    const all = polys.flat();
    const x0 = Math.max(0, Math.floor(Math.min(...all.map(p => p[0])) - padding));
    const y0 = Math.max(0, Math.floor(Math.min(...all.map(p => p[1])) - padding));
    const x1 = Math.min(width, Math.ceil(Math.max(...all.map(p => p[0])) + padding));
    const y1 = Math.min(height, Math.ceil(Math.max(...all.map(p => p[1])) + padding));
    return x1 > x0 && y1 > y0 ? [x0, y0, x1-x0, y1-y0] : null;
}

function picture(image, crop, shapes, filename, label = '') {
    const [x, y, w, h] = crop;
    const scale = Math.min(4, 1400 / Math.max(w, h));
    const canvas = node('canvas'); canvas.width = Math.max(1, Math.round(w*scale)); canvas.height = Math.max(1, Math.round(h*scale));
    canvas.setAttribute('aria-label', filename); canvas.setAttribute('role', 'img');
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
    const mapped = p => [(p[0]-x)*canvas.width/w, (p[1]-y)*canvas.height/h];
    for (const shape of shapes) {
        const p = shape.points.map(mapped);
        if (Math.max(...p.map(v => v[0])) < 0 || Math.max(...p.map(v => v[1])) < 0 ||
            Math.min(...p.map(v => v[0])) > canvas.width || Math.min(...p.map(v => v[1])) > canvas.height) continue;
        ctx.strokeStyle = shape.color; ctx.lineWidth = Math.max(1.5, Math.min(3, canvas.width/400));
        ctx.setLineDash(shape.dashed ? [8, 5] : []); ctx.beginPath(); ctx.moveTo(...p[0]);
        for (const point of p.slice(1)) ctx.lineTo(...point);
        if (p.length > 2) ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
        if (shape.label) {
            ctx.font = 'bold 14px sans-serif';
            const labelX = Math.max(2, Math.min(p[0][0], canvas.width-35)), labelY = Math.max(17, p[0][1]-5);
            ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.strokeText(shape.label, labelX, labelY);
            ctx.fillStyle = shape.color; ctx.fillText(shape.label, labelX, labelY);
        }
    }
    const wrapper = node('div'); wrapper.className = 'colloidal-diagnostic-picture';
    if (label) wrapper.append(node('p', label));
    wrapper.append(canvas);
    const download = node('button', '下载此图'); download.type = 'button'; download.className = 'colloidal-link';
    download.addEventListener('click', () => canvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = filename + '.png'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png'));
    wrapper.append(download); return wrapper;
}

export function recognitionImages(attempt, loadPhoto, { open = false } = {}) {
    const root = node('details'); root.className = 'colloidal-recognition-images'; root.dataset.recognitionImages = ''; root.open = open;
    root.append(node('summary', '识别过程标注图：原图 → 卡位 → 观察窗与 C/T 测量区域'));
    const content = node('div'); root.append(content);
    let loading = false, loaded = false;
    async function load() {
        if (!root.open || !root.isConnected || loading || loaded) return;
        if (attempt.photo_state !== 'present' || !loadPhoto) {
            content.textContent = ['purged', 'purging'].includes(attempt.photo_state) ? '原照片已清理，无法绘制标注图；文字日志仍保留。' : '原照片暂不可用，无法绘制标注图。';
            return;
        }
        loading = true; content.textContent = '正在读取原图并绘制本次算法坐标…';
        let url;
        try {
            const blob = await loadPhoto(); url = URL.createObjectURL(blob);
            const image = new Image(); image.src = url; await image.decode();
            if (!root.isConnected) return;
            content.replaceChildren();
            const model = recognitionGeometry(attempt.process_log), width = image.naturalWidth, height = image.naturalHeight;
            const figure = (title, note, pictures) => {
                const section = node('section'); section.append(node('h4', title), node('p', note));
                const grid = node('div'); grid.className = 'colloidal-diagnostic-grid'; grid.append(...pictures); section.append(grid); content.append(section);
            };
            if ((model.width && model.width !== width) || (model.height && model.height !== height)) {
                figure('原始照片', '浏览器解码尺寸与算法日志不同，停止叠加，避免坐标错位。', [picture(image, [0, 0, width, height], [], attempt.id+'-original')]);
                loaded = true; return;
            }
            const shapes = [
                ...(model.slot ? [{ points: model.slot, color: colors.slot, dashed: true }] : []),
                ...model.windows.map((p, i) => ({ points: p, color: colors.window, label: 'W'+(i+1) })),
                ...model.regions.map(p => ({ points: p, color: colors.region })),
                ...model.lines.map(l => ({ points: l.points, color: colors[l.label], label: l.label })),
            ];
            const legend = node('p'); legend.className = 'colloidal-diagnostic-legend';
            for (const [label, color] of [['黄虚线：推算卡位', colors.slot], ['绿框：算法选窗', colors.window], ['青框：实际测量区', colors.region], ['紫线：C测量位置', colors.C], ['红线：T测量位置', colors.T]]) {
                const item = node('span', label); item.style.borderLeft = '5px solid '+color; legend.append(item);
            }
            content.append(legend, node('p', '标注来自本次算法日志，不代表位置已经正确。当前日志未提供独立检测卡外壳边界，不能将推算卡位当成卡壳识别成功；C/T线表示测量位置，不代表已检出显色线。'));
            figure('1．原始照片与算法定位', '标注使用原图坐标，与拍照预览的旋转／镜像设置无关。',
                [picture(image, [0, 0, width, height], shapes, attempt.id+'-overview')]);
            const card = model.slot && bounds([model.slot], width, height, 20);
            if (card) figure('2．卡位局部：卡壳尚未独立验证', '此图按定位板推算卡位放大，请核对真实检测卡是否位于框内。',
                [picture(image, card, shapes, attempt.id+'-slot')]);
            else content.append(node('p', '2．本次日志没有可绘制的原图卡位边界，无法展示卡壳定位结果。'));
            if (!model.windows.length) content.append(node('p', attempt.completed_at ?
                '3．本次没有可绘制的观察窗口原图坐标，可能未定位成功或旧日志未记录此步骤。未补画窗口或 C/T 线，请展开文字日志查看原因。' :
                '3．识别尚未返回观察窗口原图坐标，完成后可刷新日志查看。未补画推测窗口或 C/T 线。'));
            model.windows.forEach((polygon, i) => {
                const crop = bounds([polygon, ...(model.regions[i] ? [model.regions[i]] : [])], width, height, 32);
                if (!crop) return;
                figure(`3.${i+1}．观察窗口 W${i+1} 与 C/T 测量区`, '同一区域提供无标注和算法标注两张对照图。请核对青框是否覆盖膜面和可见色带，是否偏到塑料边缘。',
                    [picture(image, crop, [], attempt.id+`-window-${i+1}-original`, '原始局部（无标注）'), picture(image, crop, shapes, attempt.id+`-window-${i+1}-marked`, '本次算法标注')]);
            });
            if (model.windows.length && !model.lines.length) content.append(node('p', '本次没有可绘制的 C/T 测量线坐标，未补造线位。'));
            for (const c of attempt.result?.channels || []) {
                const name = PROJECTS.flatMap(p => p.channels).find(channel => channel.id === c.id)?.name || c.id;
                content.append(node('p', `${name}（所选检测通道）：C=${Number.isFinite(c.c) ? c.c.toFixed(3) : '未测量'}，T=${Number.isFinite(c.t) ? c.t.toFixed(3) : '未测量'}；C线${c.c_present === true ? '已检出' : c.c_present === false ? '未检出' : '状态未知'}。请结合标注核对测量位置，项目名称不代表图像已验证产品身份。`));
            }
            loaded = true;
        } catch (error) {
            if (!root.isConnected) return;
            content.replaceChildren(node('p', error.status === 410 ? '原照片已清理，不能绘制标注图。' : '原照片暂时无法读取或浏览器不支持该图片格式。'));
            const retry = node('button', '重试加载标注图'); retry.type = 'button'; retry.className = 'colloidal-link'; retry.addEventListener('click', load); content.append(retry);
        } finally { if (url) URL.revokeObjectURL(url); loading = false; }
    }
    root.addEventListener('toggle', load); queueMicrotask(load); return root;
}
