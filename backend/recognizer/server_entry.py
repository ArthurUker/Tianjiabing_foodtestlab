"""Original-photo adapter with versioned card-relative geometry.

The pinned upstream core plus recorded local patches are packaged in core.json.
New triplex geometry uses a complete shell and membrane boundary evidence;
optical measurements use unenhanced source pixels on that path.
"""
import io
import json
import os
import tempfile
import numpy as np
import cv2
from PIL import Image, ImageOps
from lab.reader import recognize
from lab.reader_config import CORE_PATCH, LAYOUT, get_project, PIPELINE_VERSION
from process_log import ProcessLog
from card_geometry import locate_triplex, TRIPLEX_SEARCH_MM
from membrane_geometry import locate_membranes, SEARCH_MM
from learned_locator import enabled as learned_enabled, locate_for_measurement

Image.MAX_IMAGE_PIXELS = 40_000_000

# 仅本地测试：设置该目录后，把本次识别用的裁位图、窗口框与 C/T 线画出来存盘，
# 供局域网监控页显示。生产不设置该变量，不产生任何派生图。
DEBUG_DIR = os.environ.get('COLLOIDAL_DEBUG_DIR', '').strip()
MAX_DEBUG_WIDTH = 900


def save_debug(job_id, image, result=None, note=None):
    if not DEBUG_DIR or not job_id:
        return
    try:
        os.makedirs(DEBUG_DIR, exist_ok=True)
        vis = image.copy()
        height, width = vis.shape[:2]
        if width > MAX_DEBUG_WIDTH:
            scale = MAX_DEBUG_WIDTH / width
            vis = cv2.resize(vis, (MAX_DEBUG_WIDTH, int(height * scale)))
            scale_back = scale
        else:
            scale_back = 1.0
        # 窗口多边形在过程日志的 localization 事件里（slot 坐标已映射回裁位图像素）。
        events = (result or {}).get('process_log') or []
        located = next((e for e in reversed(events)
                        if e.get('stage') == 'localization' and e.get('state') == 'ok'), None)
        polygons = ((located or {}).get('details') or {}).get('window_polygons_source') \
            or ((result or {}).get('geometry') or {}).get('window_polygons_source') or []
        for index, polygon in enumerate(polygons, 1):
            pts = np.asarray(polygon, dtype=np.float32) * scale_back
            cv2.polylines(vis, [np.int32(pts).reshape(-1, 1, 2)], True, (60, 200, 60), 2)
            cv2.putText(vis, str(index), tuple(np.int32(pts[0]) + [0, -6]),
                        cv2.FONT_HERSHEY_SIMPLEX, .7, (60, 200, 60), 2)
        # C/T 测量线取自过程日志（裁剪图像素坐标）。
        for event in (result or {}).get('process_log') or []:
            if event.get('stage') != 'measurement':
                continue
            for line in (event.get('details') or {}).get('measurement_lines_source') or []:
                points = line.get('points') or []
                if len(points) != 2:
                    continue
                color = (30, 120, 220) if line.get('label') == 'C' else (0, 140, 255)
                a = tuple(int(v * scale_back) for v in points[0])
                b = tuple(int(v * scale_back) for v in points[1])
                cv2.line(vis, a, b, color, 2)
        if note:
            cv2.putText(vis, note[:60], (10, 24), cv2.FONT_HERSHEY_SIMPLEX, .7, (0, 0, 200), 2)
        cv2.imwrite(os.path.join(DEBUG_DIR, f'{job_id}.jpg'), vis, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    except Exception:
        pass

# 定位卡上的卡位与核心固定的 30×80mm 搜索区不一致（单检 20×70、三联 40×70，
# 且双卡位板上两块卡都在搜索区之外）。这里不修改核心：用同一组定位标记把照片
# 映射回纸面毫米坐标，按所选项目裁出对应卡位，再按「单卡近照」交给核心定位。
# 三组框依次尝试：双卡位板 → 旧单卡位板 → 原图逻辑。
CARD_CROPS_MM = {
    'triplex': [(95.0, 108.0, 140.0, 190.0), (81.0, 110.0, 129.0, 190.0)],
    'single': [(68.0, 108.0, 98.0, 190.0)],
}


def board_frame(image):
    """返回 (homography 原图->纸面mm, ppm)；标记不足三个时返回 None。"""
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    points, ids, _ = cv2.aruco.ArucoDetector(dictionary).detectMarkers(image)
    if ids is None:
        return None
    markers = {m['id']: m for m in LAYOUT['markers']}
    found = {int(i): np.asarray(p).reshape(4, 2) for p, i in zip(points, ids.ravel()) if int(i) in markers}
    if len(found) < 3:
        return None
    src, dst, densities = [], [], []
    for mid, corners in found.items():
        m = markers[mid]
        x, y, size = m['x_mm'], m['y_mm'], m['size_mm']
        src.extend([[float(px), float(py)] for px, py in corners])
        dst.extend([[x, y], [x + size, y], [x + size, y + size], [x, y + size]])
        densities.append(float(np.mean(np.linalg.norm(corners - np.roll(corners, 1, axis=0), axis=1)) / size))
    ppm = float(np.median(densities))
    if not 2.0 <= ppm <= 80.0:
        return None
    src, dst = np.float32(src), np.float32(dst)
    homography, _ = cv2.findHomography(src, dst, cv2.RANSAC, max(0.8, 2.0 / ppm))
    if homography is None:
        return None
    return homography, ppm


def detect_card_box(image, target_ratio=None):
    """在裁位图里找检测卡外框。返回 (x0,y0,x1,y1) 像素；找不到返回 None。
    卡片占裁位图大部分面积，因此取面积最大、且长宽比接近卡型的矩形。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    edges = cv2.Canny(cv2.GaussianBlur(enhanced, (3, 3), 0), 20, 60)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = gray.shape[:2]
    best = None
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < width * 0.45 or h < height * 0.45:
            continue
        if w >= width * 0.97 and h >= height * 0.97:
            continue                       # 整幅图边界，不是卡片
        if target_ratio:
            shape = h / w
            if abs(shape - target_ratio) / target_ratio > 0.25:
                continue                   # 长宽比与卡型不符
        area = w * h
        if best is None or area > best[0]:
            best = (area, (float(x), float(y), float(x + w), float(y + h)))
    return None if best is None else best[1]


def windows_from_card(card_box, ratios):
    """按卡片外框与相对比例生成固定尺寸的识别区（四点）。
    卡片摆歪时外框跟着移动，识别区随之平移，尺寸不变。"""
    x0, y0, x1, y1 = card_box
    card_w, card_h = x1 - x0, y1 - y0
    if card_w <= 0 or card_h <= 0:
        return None
    boxes = []
    for rx, ry, rw, rh in ratios:
        cx, cy = x0 + rx * card_w, y0 + ry * card_h
        half_w, half_h = rw * card_w / 2, rh * card_h / 2
        boxes.append([[cx - half_w, cy - half_h], [cx + half_w, cy - half_h],
                      [cx + half_w, cy + half_h], [cx - half_w, cy + half_h]])
    return boxes


def fixed_window_boxes(project, box_mm, ppm):
    """把纸面毫米的窗口坐标换算成裁位图像素四点；未配置时返回 None。
    这样识别区的位置和尺寸完全由卡型决定，不再逐次检测。"""
    boxes = project.get('window_boxes_mm') or []
    if not boxes:
        return None
    x0, y0 = float(box_mm[0]), float(box_mm[1])
    rows = []
    for cx, cy, width, height in boxes:
        px0 = (float(cx) - float(width) / 2 - x0) * ppm
        py0 = (float(cy) - float(height) / 2 - y0) * ppm
        px1 = px0 + float(width) * ppm
        py1 = py0 + float(height) * ppm
        rows.append([[px0, py0], [px1, py0], [px1, py1], [px0, py1]])
    return rows


def enhance_clahe(image):
    """局部对比度增强：白卡上白色观察窗的边缘常常太弱，原图找不到轮廓。
    只增强亮度通道，不改变色相与相对明暗关系，测量仍在增强图上进行。"""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def crop_mm(image, homography, ppm, box_mm):
    """按纸面毫米框裁剪；像素密度取实际标记密度，避免上采样虚增 native_scale。"""
    x0, y0, x1, y1 = box_mm
    transform = np.array([[ppm, 0., -x0 * ppm], [0., ppm, -y0 * ppm], [0., 0., 1.]]) @ homography
    width, height = int(round((x1 - x0) * ppm)), int(round((y1 - y0) * ppm))
    if width < 120 or height < 200:
        return None
    return cv2.warpPerspective(image, transform, (width, height), borderValue=(255, 255, 255))


def card_relative_crop(image, homography, ppm):
    detection_ppm = min(ppm, 10.)
    preview = crop_mm(image, homography, detection_ppm, TRIPLEX_SEARCH_MM)
    if preview is None:
        return None
    located = locate_triplex(preview, detection_ppm)
    if located is None:
        return None
    windows, evidence = located
    native = crop_mm(image, homography, ppm, TRIPLEX_SEARCH_MM)
    scale = ppm / detection_ppm
    shell = np.asarray(evidence['card_polygon_source']) * scale
    x0, y0 = np.maximum(0, np.floor(shell.min(0)-ppm)).astype(int)
    x1, y1 = np.minimum([native.shape[1], native.shape[0]], np.ceil(shell.max(0)+ppm)).astype(int)
    crop = native[y0:y1, x0:x1].copy()
    boxes = [(np.asarray(b)*scale-[x0, y0]).tolist() for b in windows]
    evidence['card_polygon_source'] = (shell-[x0, y0]).tolist()
    sx, sy = TRIPLEX_SEARCH_MM[:2]
    source_to_crop = np.array([[ppm, 0., -sx*ppm-x0],
                               [0., ppm, -sy*ppm-y0], [0., 0., 1.]]) @ homography
    return crop, boxes, evidence, np.linalg.inv(source_to_crop)


def membrane_relative_crop(image, homography, ppm, project):
    detection_ppm = min(ppm, 10.)
    preview = crop_mm(image, homography, detection_ppm, SEARCH_MM)
    if preview is None:
        return None
    located = locate_membranes(preview, detection_ppm, len(project['channels']))
    if located is None:
        return None
    windows, evidence = located
    native = crop_mm(image, homography, ppm, SEARCH_MM)
    scale = ppm / detection_ppm
    points = np.asarray(windows).reshape(-1, 2)*scale
    x0, y0 = np.maximum(0, np.floor(points.min(0)-3*ppm)).astype(int)
    x1, y1 = np.minimum([native.shape[1], native.shape[0]], np.ceil(points.max(0)+3*ppm)).astype(int)
    crop = native[y0:y1, x0:x1].copy()
    boxes = [(np.asarray(b)*scale-[x0, y0]).tolist() for b in windows]
    sx, sy = SEARCH_MM[:2]
    source_to_crop = np.array([[ppm, 0., -sx*ppm-x0],
                               [0., ppm, -sy*ppm-y0], [0., 0., 1.]]) @ homography
    return crop, boxes, evidence, np.linalg.inv(source_to_crop)


def original_coordinates(events, crop_to_source, skip_native_card=False):
    """Map only source-pixel geometry; keep canonical slot coordinates intact."""
    def mapped(points):
        a = np.asarray(points, dtype=np.float32)
        return cv2.perspectiveTransform(a[None], crop_to_source)[0].round(3).tolist()
    for event in events:
        details = event.get('details') or {}
        for key in ('slot_polygon_source', 'card_polygon_source'):
            if skip_native_card and event.get('stage')=='card_geometry' and key=='card_polygon_source':
                continue  # learned locators already provide original-space shell corners
            if details.get(key):
                details[key] = mapped(details[key])
        for key in ('window_polygons_source', 'measurement_polygons_source'):
            if details.get(key):
                details[key] = [mapped(p) for p in details[key]]
        for line in details.get('measurement_lines_source') or []:
            if line.get('points'):
                line['points'] = mapped(line['points'])
        if details.get('coordinate_space'):
            details['coordinate_space'] = 'exif_corrected_original_pixels'


def image_metadata(raw):
    with Image.open(io.BytesIO(bytes(raw))) as photo:
        if photo.width * photo.height > 40_000_000:
            raise ValueError('照片超过4000万像素')
        return json.dumps(dict(format=photo.format, width=photo.width, height=photo.height))


def recognize_original(raw, project_id, elapsed_seconds_json, mode, rgba=None, width=0, height=0, debug_id=None):
    elapsed_seconds = json.loads(elapsed_seconds_json)
    project = get_project(project_id)
    if project is None:
        raise ValueError('未知检测项目')
    trace = ProcessLog(project)
    try:
        with Image.open(io.BytesIO(bytes(raw))) as photo:
            metadata = dict(format=photo.format, width=photo.width, height=photo.height,
                exif_orientation=photo.getexif().get(274, 1), bytes=len(raw))
            if photo.width * photo.height > 40_000_000:
                raise ValueError('照片超过4000万像素，请调整相机分辨率')
            if rgba is not None:
                if width * height != photo.width * photo.height:
                    raise ValueError('JPEG解码尺寸不一致')
                # The pinned JPEG decoder already applies EXIF orientation.
                rgb = Image.frombytes('RGBA', (width, height), bytes(rgba)).convert('RGB')
            else:
                rgb = ImageOps.exif_transpose(photo).convert('RGB')
            image = cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
            trace.add('decode', **metadata, decoded_width=int(image.shape[1]), decoded_height=int(image.shape[0]),
                coordinate_space='exif_corrected_original_pixels')
    except Exception as exc:
        trace.add('decode', 'failed', reason='无法解码原照片或尺寸超限')
        return json.dumps(dict(status='decode_failed', error='无法解码原照片，请使用JPG、PNG或WebP', channels=[], process_log=trace.events), ensure_ascii=False)
    trace.add('core_started', project_id=project_id, core_patch=CORE_PATCH, mode=mode,
        expected_channels=[c['id'] for c in project['channels']])
    try:
        with trace, tempfile.TemporaryDirectory(prefix='reader-') as directory:
            # 有定位标记时先按所选项目裁出卡位（双卡位板或旧板），失败再走核心原逻辑。
            result = None
            used_crop = None
            crop_to_source = None
            selected_start = None
            experimental_used = False
            experimental_patch = 'ai2'
            strict_unmarked=learned_enabled() and (os.environ.get('COLLOIDAL_STRICT_UNMARKED')=='1'
                or os.environ.get('COLLOIDAL_OPEN_MODEL')in('a','b','c','hybrid'))
            frame = None if strict_unmarked else board_frame(image)
            if frame is None and learned_enabled():
                selected_start=len(trace.events)
                learned=locate_for_measurement(image,project)
                trace.add('card_geometry','ok' if learned['ok'] else 'failed',**learned['evidence'])
                if learned['ok']:
                    experimental_patch=learned['evidence']['experimental_patch']
                    used_crop=learned['prepared'];crop_to_source=learned['crop_to_source']
                    project['band_evidence_mode']='spatial'
                    result=recognize(used_crop,project,elapsed_seconds,directory,'closeup',fixed_windows=learned['windows'])
                    result.update(preprocess='card_crop',crop_variant='learned_membrane')
                    experimental_used=True
                else:
                    result=dict(status=learned['status'],error=learned['error'],channels=[],
                                version=PIPELINE_VERSION,elapsed_ms=0.)
            if frame is not None:
                homography, ppm = frame
                # Use a complete shell with margins before legacy slot heuristics.
                relative = membrane_relative_crop(image, homography, ppm, project)
                relative_variant = 'membrane_relative'
                if relative is None:
                    relative = card_relative_crop(image, homography, ppm) if project_id == 'lean_meat_triplex' else None
                    relative_variant = 'card_relative'
                if relative is not None:
                    prepared, windows, evidence, crop_to_source = relative
                    used_crop = prepared
                    selected_start = len(trace.events)
                    trace.add('card_geometry', **evidence, coordinate_space='exif_corrected_original_pixels')
                    if relative_variant == 'membrane_relative':
                        project['band_evidence_mode'] = 'spatial'
                    result = recognize(prepared, project, elapsed_seconds, directory, 'closeup', fixed_windows=windows)
                    result.update(preprocess='card_crop', crop_variant=relative_variant)
                    trace.add('card_crop', crop_mm=list(TRIPLEX_SEARCH_MM), variant=relative_variant,
                              status=result['status'], crop_size=[prepared.shape[1], prepared.shape[0]])
                boxes = [] if result is not None else CARD_CROPS_MM['triplex' if project_id == 'lean_meat_triplex' else 'single']
                crops = [(box, crop_mm(image, homography, ppm, box)) for box in boxes]
                # 顺序很重要：先把所有卡位框按原样试完，全部失败后才做对比度增强重试。
                # 否则增强会让“裁错卡位”的图也勉强识别成功，反而跳过正确的框。
                # 第一轮：先认卡片外框，按固定比例放识别区（尺寸恒定、跟随卡片位置）；
                # 认不出卡框或结果无效时，回退到轮廓/模板检测，最后再试对比度增强。
                ratios = project.get('window_layout_ratio') or []
                target_ratio = float(project.get('card_ratio') or 0)
                # 固定识别区（卡框 + 固定比例）实测不稳定：白卡上卡框边缘弱，框偏后反而
                # 让更多通道无 C 线。暂时关闭，等卡片外框检测稳定后再启用。
                for variant in ('raw', 'clahe'):
                    for box, crop in crops:
                        if crop is None:
                            continue
                        windows = None
                        if variant == 'fixed':
                            continue
                        prepared = crop if variant != 'clahe' else enhance_clahe(crop)
                        used_crop = prepared
                        attempt_start = len(trace.events)
                        attempt = recognize(prepared, project, elapsed_seconds, directory, 'closeup',
                                            fixed_windows=windows)
                        # 固定框偏离膜窗时通常表现为某通道无 C 线，此时回退检测路径。
                        if variant == 'fixed' and (attempt['status'] not in ('ok', 'partial') or any(
                                c.get('status') != 'ok' for c in attempt['channels'])):
                            trace.add('card_crop', 'failed', status=attempt['status'], crop_mm=list(box),
                                      variant='fixed', note='固定识别区未取得全通道有效值，回退检测路径')
                            continue
                        trace.add('card_crop', 'ok' if attempt['status'] in ('ok', 'partial') else 'failed',
                            status=attempt['status'], crop_mm=list(box), variant=variant,
                            crop_size=[int(prepared.shape[1]), int(prepared.shape[0])],
                            note='按定位卡标记裁出卡位后按近照识别；核心阈值与判读未修改')
                        if attempt['status'] in ('ok', 'partial'):
                            attempt['preprocess'] = 'card_crop'
                            attempt['crop_variant'] = variant
                            result = attempt
                            selected_start = attempt_start
                            bx, by = box[:2]
                            crop_to_source = np.linalg.inv(np.array([[ppm, 0., -bx*ppm], [0., ppm, -by*ppm], [0., 0., 1.]]) @ homography)
                            break
                    if result is not None:
                        break
            if result is None:
                used_crop = None
                selected_start = len(trace.events)
                result = recognize(image, project, elapsed_seconds, directory, mode)
    except Exception:
        trace.add('core_finished', 'failed', status='engine_error', reason='算法执行异常')
        return json.dumps(dict(status='engine_error', error='算法执行异常，请查看过程日志', channels=[], process_log=trace.events), ensure_ascii=False)
    if selected_start is not None:
        trace.events = [e for e in trace.events[:selected_start] if e['stage'] in ('decode', 'core_started', 'card_crop')] + trace.events[selected_start:]
    trace.add('core_finished', 'ok' if result['status'] == 'ok' else 'failed', status=result['status'],
        elapsed_ms=result['elapsed_ms'], error=result.get('error'),
        channels=[dict(id=c['id'], status=c['status'], image_result=c.get('image_result')) for c in result['channels']])
    # The temporary directory and every overlay/crop have already been removed.
    channels = []
    for item in result['channels']:
        measurement = item.get('measurement') or {}
        channels.append({
            'id': item['id'], 'status': item['status'],
            'image_result': item.get('image_result'), 'final_result': item.get('final_result'),
            'rule_status': item.get('rule_status'), 'error': item.get('error'),
            'c': measurement.get('c'), 't': measurement.get('t'),
            'c_present': measurement.get('c_present'), 't_present': measurement.get('t_present'),
            'decision_quality':measurement.get('decision_quality'),
            'decision_reason':measurement.get('decision_reason'),
            'band_support':measurement.get('band_support'),
            # 相对识别区背景的增益，供判读复核与诊断展示。
            'background_level': measurement.get('background_level'),
            'c_gain_ratio': measurement.get('c_gain_ratio'),
            't_gain_ratio': measurement.get('t_gain_ratio'),
            # 单检“一样深”的容差，供 Node 按同一口径判读。
            'tolerance': item.get('rule_tolerance'),
        })
    if debug_id:
        note = None
        if experimental_used:
            note = 'AI GEOMETRY: experimental measurement'
        elif frame is None:
            note = 'NO MARKERS: full image'
        elif used_crop is None:
            note = 'CROP FAILED: full image'
        save_debug(debug_id, used_crop if used_crop is not None else image,
                   {'geometry': result.get('geometry'), 'process_log': trace.events}, note)
    if crop_to_source is not None:
        original_coordinates(trace.events, crop_to_source, skip_native_card=experimental_used)
    # 失败时给出可直接操作的提示，而不是统一的“定位补救未取得可靠窗口”。
    error = result.get('error') or ''
    if result['status'] not in ('ok', 'partial'):
        if frame is None and result['status']=='board_not_detected':
            error = '未检测到定位标记（至少需要 3 个完整定位码）。请把整张定位卡拍进画面，避免反光或手指遮挡。'
        elif frame is not None and result.get('status') in ('structure_mismatch', 'localization_failed', 'orientation_failed'):
            error = '已识别到定位卡，但没找到符合所选项目的观察窗。请确认卡片放在对应卡位（单检/三联）、项目名称朝上、加样孔朝下。'
    if experimental_used and result['status'] in ('ok','partial'):
        # Retain real optical measurements; research geometry cannot silently
        # become an eligible food-safety result through Node's time rules.
        result['status']='partial'
        error='AI已定位并测量；实验模型尚未完成独立验收，暂不自动判定合格性'
        for channel in channels:
            channel.update(status='quality_failed',error=error,image_result=None,final_result=None,
                           rule_status='model_unvalidated',decision_quality='unvalidated_model')
        for event in reversed(trace.events):
            if event['stage']=='core_finished':
                event['state']='failed'
                event['details'].update(status='partial',error=error,
                    channels=[dict(id=c['id'],status=c['status'],image_result=None)for c in channels],
                    experimental_patch=experimental_patch)
                break
    payload = dict(status=result['status'], error=error,
        version=result['version'], elapsed_ms=result['elapsed_ms'], core_patch=CORE_PATCH+('+'+experimental_patch if experimental_used else ''), channels=channels, process_log=trace.events)
    if result.get('preprocess'):
        payload['preprocess'] = result['preprocess']
        if result.get('crop_variant'):
            payload['crop_variant'] = result['crop_variant']
    return json.dumps(payload, ensure_ascii=False, allow_nan=False)
