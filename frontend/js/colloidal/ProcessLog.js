const names = {
    camera_requested: '请求打开相机', camera_ready: '相机预览就绪', capture_started: '开始取得画面',
    photo_captured: '相机照片生成', file_selected: '收到所选照片（拍摄时间未知）', sampling_started: '操作者确认加样并开始计时', capture_failed: '未取得采样照片',
    attempt_registered: '服务端登记识别尝试', photo_upload_started: '服务端开始接收原图', photo_stored: '原图保存完成', recognition_queued: '进入识别队列',
    algorithm_dispatched: '任务交给Python识别进程', worker_retry: '识别进程重试', recognition_failed: '识别服务失败',
    decode: '原图解码与EXIF方向处理', core_started: '开始运行固定v5算法', board_geometry: '定位板／完整单卡几何定位',
    window_candidates: '搜索观察窗口边缘候选', outline_search: '尝试胶囊形窗口轮廓补救', window_selection: '选定观察窗口',
    localization: '窗口提取与坐标映射', measurement: '局部C/T显色测量', core_finished: '算法计算结束', verdict: '时间规则与最终可用性判定',
    image_classification: '按C/T规则生成图像候选', optical_audit: 'RGB敏感性诊断旁路', learning_shadow: '学习模型诊断旁路（不参与主判读）',
    algorithm_log_unavailable: '该次识别未提供内部日志（旧版识别适配器）',
};
const fields = { at: '时间', duration_ms: '本步骤耗时ms', elapsed_ms: '算法累计耗时ms', wait_ms: '排队耗时ms',
    marker_ids: '识别标记ID', inliers: '几何内点数', rms_mm: '标记拟合误差mm', rms_gate_mm: '允许误差mm',
    count: '边缘候选数', centers_slot: '候选中心（卡位坐标）', polygon_slot: '窗口轮廓（卡位坐标）',
    polygons_slot: '选定窗口（卡位坐标）', slot_polygon_source: '预设卡位在原图中的坐标',
    window_polygons_source: '窗口在原图中的坐标', measurement_polygons_source: '实际测量区域在原图中的坐标',
    measurement_lines_source: 'C/T测量线在原图中的坐标', window_shapes: '测量图像尺寸',
    c: 'C线信号', t: 'T线信号', threshold: 'C线存在阈值', noise: '噪声', c_present: '是否测到C线',
    rule_status: '时间规则状态', final_result: '最终候选', image_result: '图像候选', eligible: '能否自动录入',
    time_basis: '时间依据', time_source: '时间来源', elapsed_seconds: '拍照时距加样秒数', captured_at: '实际拍照时间',
    width: '原始宽度', height: '原始高度', decoded_width: '解码后宽度', decoded_height: '解码后高度',
    previewRotation: '预览旋转角度', previewMirrorX: '预览左右镜像', previewMirrorY: '预览上下翻转',
};
export const cameraEvent = (stage, details = {}) => ({ at: new Date().toISOString(), stage, details });
const node = (tag, text = '') => { const n = document.createElement(tag); n.textContent = text; return n; };

export function processLogPanel(attempt, { open = false } = {}) {
    const panel = node('details'); panel.className = 'colloidal-process-attempt'; panel.open = open;
    const events = Array.isArray(attempt.process_log) ? attempt.process_log : [];
    panel.append(node('summary', `${attempt.sample_index ? `第${attempt.sample_index}次采样 · ` : ''}${attempt.photo_name || '识别尝试'} · ${events.length}条过程日志`));
    panel.append(node('p', `识别ID：${attempt.id}。浏览器时间由设备报告；服务器和算法时间由服务端记录，跨设备时钟可能存在偏差。`));
    if (!events.length) panel.append(node('p', attempt.result?.status === 'sample_missed' ? `该采样时点没有取得可用照片，未执行图像识别。${attempt.result.error || ''}` : '这是增加日志前的记录，没有详细过程日志；重新拍照后会自动记录。'));
    const list = node('ol');
    for (const event of events) {
        const item = node('li');
        item.append(node('strong', `${new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false, fractionalSecondDigits: 3 })} · ${names[event.stage] || event.stage} · ${{ ok: '完成', warning: '需关注', failed: '失败', started: '开始', observed: '设备报告' }[event.state] || event.state}`));
        item.append(node('small', `来源：${({ browser: '浏览器', server: '服务端', algorithm: '算法' })[event.origin] || event.origin}${Number.isFinite(event.elapsed_ms) ? `；算法累计${event.elapsed_ms}ms` : ''}`));
        const details = node('div');
        for (const [key, value] of Object.entries(event.details || {})) details.append(node('div', `${fields[key] || key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}`));
        item.append(details); list.append(item);
    }
    panel.append(list);
    const download = node('button', '下载本次过程日志JSON'); download.type = 'button'; download.className = 'colloidal-link';
    download.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ attemptId: attempt.id, photoName: attempt.photo_name, result: attempt.result, processLog: events }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = `recognition-${attempt.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    panel.append(download); return panel;
}
