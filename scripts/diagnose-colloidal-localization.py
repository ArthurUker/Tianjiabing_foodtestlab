"""Offline localization evidence for the pinned reader; never writes business data.

Usage: python scripts/diagnose-colloidal-localization.py --original ORIGINAL
  --project carbofuran --output .cache/diagnostic --expected-sha256 SHA

Requires the existing reader Python dependencies. Production core files are
expanded, hash checked and imported from a temporary directory. Experimental
card-outline evidence is separate and never supplies an automatic verdict.
"""
import argparse
import base64
import hashlib
import html
import importlib
import json
from pathlib import Path
import sys
import tempfile
from collections import Counter

import cv2
import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def ordered_box(box):
    b = np.asarray(box, np.float32).reshape(-1, 2)
    return np.array([b[np.argmin(b.sum(1))], b[np.argmin(b[:, 1]-b[:, 0])],
                     b[np.argmax(b.sum(1))], b[np.argmax(b[:, 1]-b[:, 0])]], np.float32)


def rounded(value):
    return np.asarray(value).round(3).tolist()


def contour_audit(slot, geometry, normalized):
    # Exact operations and first-rejection order from window_candidates.
    gray = geometry.geometry_gray(slot, normalized)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 20, 60)
    edges[:160] = 0; edges[570:] = 0; edges[:, :20] = 0; edges[:, 280:] = 0
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    rows = []
    for index, contour in enumerate(contours):
        rect = cv2.minAreaRect(contour)
        (cx, cy), (width, height), _ = rect
        short, long = sorted((width, height))
        area = abs(cv2.contourArea(contour)); box = ordered_box(cv2.boxPoints(rect))
        reason = 'accepted'
        if not (8 <= short <= 100 and 60 <= long <= 300 and 2.2 <= long/max(short, 1e-9) <= 9): reason = 'size_or_aspect'
        elif not (30 <= cx <= 270 and 200 <= cy <= 530): reason = 'center'
        elif area < short*long*.5: reason = 'area_fill'
        elif len(np.unique(box, axis=0)) != 4: reason = 'corner_order'
        else:
            v = (box[2]+box[3]-box[0]-box[1])/2
            if abs(v[0]) > abs(v[1])*.45: reason = 'angle'
        rows.append(dict(id=index, center=rounded([cx, cy]), size=rounded([short, long]),
            contour_area=round(area, 3), fill=round(area/max(short*long, 1e-9), 6),
            first_rejection=reason, polygon=rounded(box)))
    candidates = geometry.window_candidates(slot, normalized)
    return dict(normalized=normalized, contour_count=len(rows), candidates=len(candidates),
        rejected_by=dict(Counter(r['first_rejection'] for r in rows)), contours=rows), edges


def outline_audit(slot, geometry, normalized):
    # Read actual function locals on return; thresholds/inputs are untouched.
    captured = {}
    previous = sys.getprofile()
    def profile(frame, event, value):
        if event == 'return' and frame.f_code is geometry.outline_window.__code__:
            captured.update(ranked=frame.f_locals['ranked'])
    try:
        sys.setprofile(profile)
        selected = geometry.outline_window(slot, 150, normalize_exposure=normalized, expanded_search=True)
    finally:
        sys.setprofile(previous)
    ranked = captured.get('ranked', [])
    return dict(normalized=normalized, templates=len(ranked), matched=selected is not None,
        max_accepted_cost=1.25, cost_passing=sum(raw <= 1.25 for _, raw, _ in ranked),
        selected_polygon=rounded(selected) if selected is not None else None,
        best_by_original_score=[dict(score=round(float(score), 6), raw_cost=round(float(raw), 6),
            polygon=rounded(ordered_box(box))) for score, raw, box in ranked[:3]])


def card_outline_candidate(context):
    """Development-only contour evidence; no OCR, sample labels or C/T input.

    This is deliberately not connected to the production locator. A quadrilateral
    candidate on a printed photo cannot establish real-card/product/direction
    validity, especially when card and board have little boundary contrast.
    """
    gray = cv2.cvtColor(context, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 10, 30)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        area = abs(cv2.contourArea(contour))
        poly = cv2.approxPolyDP(contour, .02*cv2.arcLength(contour, True), True)
        if len(poly) != 4 or not cv2.isContourConvex(poly) or not 28800 <= area <= 360000: continue
        box = ordered_box(poly)
        if len(np.unique(box, axis=0)) != 4: continue
        if cv2.pointPolygonTest(box, (300., 500.), False) < 0: continue
        rect = cv2.minAreaRect(contour); short, long = sorted(rect[1])
        if not short or not 2.0 <= long/short <= 4.5 or area/(short*long) < .75: continue
        if np.any(box < 5) or np.any(box[:, 0] >= context.shape[1]-5) or np.any(box[:, 1] >= context.shape[0]-5): continue
        axis = (box[2]+box[3]-box[0]-box[1])/2
        angle = float(np.degrees(np.arctan2(axis[0], axis[1])))
        boundary = contour.reshape(-1, 2)
        candidates.append(dict(polygon_context=rounded(box), center_context=rounded(box.mean(axis=0)),
            contour_area=round(area, 3), aspect=round(long/short, 3), tilt_from_board_degrees=round(angle, 3),
            bounds_context=list(cv2.boundingRect(contour)),
            boundary_points_outside_legacy_slot=int(np.sum((boundary[:, 0] < 150) | (boundary[:, 0] > 449) | (boundary[:, 1] < 100) | (boundary[:, 1] > 899)))))
    # Nested contours of the same border are one observation, not independent
    # evidence. Distinct central quadrilaterals remain ambiguous.
    unique = []
    for c in sorted(candidates, key=lambda c: -c['contour_area']):
        if not any(np.mean(np.linalg.norm(np.array(c['polygon_context'])-np.array(v['polygon_context']), axis=1)) < 12 for v in unique): unique.append(c)
    return dict(status='candidate_unvalidated' if len(unique) == 1 else 'ambiguous' if unique else 'not_detected',
        candidates=unique, physical_card_validated=False, product_identity_validated=False,
        direction_basis='board prior only; shell top/bottom not independently verified',
        method='offline_contour_quad_v1', production_connected=False)


def panel(image, title, lines=()):
    width = max(image.shape[1], 380)
    top = 38+24*len(lines)
    result = np.full((image.shape[0]+top, width, 3), 248, np.uint8)
    result[top:top+image.shape[0], :image.shape[1]] = image
    cv2.putText(result, title, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, .57, (25, 35, 45), 1, cv2.LINE_AA)
    for i, line in enumerate(lines): cv2.putText(result, line, (10, 49+i*24), cv2.FONT_HERSHEY_SIMPLEX, .42, (45, 55, 65), 1, cv2.LINE_AA)
    return result


def row(panels):
    height = max(p.shape[0] for p in panels)
    padded = [cv2.copyMakeBorder(p, 0, height-p.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(248, 248, 248)) for p in panels]
    return np.hstack(padded)


def draw_polygon(image, points, color, width=2):
    cv2.polylines(image, [np.rint(points).astype(np.int32)], True, color, width, cv2.LINE_AA)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original', required=True); parser.add_argument('--project', required=True)
    parser.add_argument('--output', required=True); parser.add_argument('--expected-sha256')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if not output.is_relative_to(ROOT / '.cache'): raise ValueError('Diagnostic outputs must remain in the private checkout .cache')
    output.mkdir(parents=True, exist_ok=True)
    original = Path(args.original).resolve(); raw = original.read_bytes(); sha = hashlib.sha256(raw).hexdigest()
    if args.expected_sha256 and sha != args.expected_sha256: raise ValueError('Original SHA256 mismatch')
    with Image.open(original) as photo:
        exif = photo.getexif().get(274, 1)
        image = cv2.cvtColor(np.asarray(ImageOps.exif_transpose(photo).convert('RGB')), cv2.COLOR_RGB2BGR)
    bundle = json.loads((ROOT/'frontend/vendor/colloidal/core.json').read_text())
    with tempfile.TemporaryDirectory(prefix='colloidal-localization-core-') as directory:
        for name, source in bundle['files'].items():
            if hashlib.sha256(source.encode()).hexdigest() != bundle['hashes'][name]: raise ValueError('Core checksum mismatch')
            if not name.startswith('lab/') or '..' in Path(name).parts: raise ValueError('Invalid core path')
            target = Path(directory)/name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(source)
        sys.path.insert(0, directory)
        geometry = importlib.import_module('lab.reader_geometry')
        config = importlib.import_module('lab.reader_config')
        reader = importlib.import_module('lab.reader')
        project = config.get_project(args.project)
        if not project: raise ValueError('Unknown project')
        with tempfile.TemporaryDirectory(prefix='reader-replay-') as artifacts:
            replay = reader.recognize(image, project, None, artifacts, 'auto')
        scale = min(1., 1800/max(image.shape[:2]))
        preview = cv2.resize(image, None, fx=scale, fy=scale) if scale < 1 else image
        markers, ids, _ = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)).detectMarkers(preview)
        if ids is None: raise ValueError('No board markers; board-specific diagnostic cannot continue')
        factors = np.array([image.shape[1]/preview.shape[1], image.shape[0]/preview.shape[0]])
        points = [(p+.5)*factors-.5 for p in markers]
        slot, _, transform, native, meta = geometry.board_slot(image, (points, ids))
        slot_poly = cv2.perspectiveTransform(np.float32([[[0, 0], [299, 0], [299, 799], [0, 799]]]), np.linalg.inv(transform))[0]
        search_poly = cv2.perspectiveTransform(np.float32([[[20, 160], [279, 160], [279, 569], [20, 569]]]), np.linalg.inv(transform))[0]
        annotated = image.copy(); cv2.aruco.drawDetectedMarkers(annotated, points, ids)
        draw_polygon(annotated, slot_poly, (0, 220, 255), 3); draw_polygon(annotated, search_poly, (255, 80, 220), 2)
        first = panel(annotated, '1. Original frame, detected markers and board-derived slot',
            ['Yellow = SLOT PRIOR, not detected card; magenta = window search mask.', 'Source coordinates only; browser preview rotation/mirrors are not applied.'])
        cv2.imwrite(str(output/'01-original-markers-slot.png'), first)
        extra = np.float64([[1, 0, 150], [0, 1, 100], [0, 0, 1]])
        context = cv2.warpPerspective(image, extra@transform, (600, 1000))
        card = card_outline_candidate(context)
        context_view = context.copy(); draw_polygon(context_view, [[150, 100], [449, 100], [449, 899], [150, 899]], (0, 210, 255))
        slot_view = slot.copy(); normalized = None; normalized_check = None
        if card['status'] == 'candidate_unvalidated':
            quad = np.float32(card['candidates'][0]['polygon_context'])
            draw_polygon(context_view, quad, (80, 220, 30), 3)
            draw_polygon(slot_view, quad-[150, 100], (80, 220, 30), 2)
            card['candidates'][0]['polygon_source'] = rounded(cv2.perspectiveTransform(quad[None], np.linalg.inv(extra@transform))[0])
            card['candidates'][0]['outside_legacy_slot'] = card['candidates'][0]['boundary_points_outside_legacy_slot'] > 0
            matrix = cv2.getPerspectiveTransform(quad, np.float32([[0, 0], [299, 0], [299, 799], [0, 799]]))
            normalized = cv2.warpPerspective(context, matrix, (300, 800))
            normalized_check = []
            for norm in [False, True]:
                try:
                    boxes = geometry.choose_windows(normalized, len(project['channels']), require_upper=True, normalize_exposure=norm, expanded_search=True)
                    state = 'windows_returned_not_optically_verified'
                except geometry.ReaderFailure as error:
                    boxes = []; state = error.status
                normalized_check.append(dict(edge_normalized=norm, status=state, count=len(boxes)))
        second_panels = [panel(slot_view, '2A. Existing 300 x 800 slot', ['Green = OFFLINE quad candidate.', 'Inspect actual body coverage.']),
            panel(context_view, '2B. Expanded planar context', ['Yellow = old slot; green = offline body candidate.', 'Not a production card detector; no identity/direction acceptance.'])]
        if normalized is not None: second_panels.append(panel(normalized, '2C. Candidate normalization', ['Development-only transform.', 'Window results: ' + ','.join(str(c['count']) for c in normalized_check)]))
        cv2.imwrite(str(output/'02-slot-card-outline.png'), row(second_panels))
        contour_reports, outlines, edges = [], [], []
        for norm in [False, True]:
            audit, edge = contour_audit(slot, geometry, norm); contour_reports.append(audit); edges.append(edge)
            outlines.append(outline_audit(slot, geometry, norm))
        search_view = slot.copy(); draw_polygon(search_view, [[20, 160], [279, 160], [279, 569], [20, 569]], (255, 80, 220))
        views = [panel(search_view, '3A. Window search in slot', ['Magenta = exact old search mask.', 'Inspect actual window coverage.'])]
        for audit, edge in zip(contour_reports, edges):
            view = cv2.cvtColor(edge, cv2.COLOR_GRAY2BGR)
            for c in audit['contours']:
                if c['first_rejection'] == 'area_fill':
                    draw_polygon(view, c['polygon'], (255, 80, 220))
                    cv2.putText(view, f"R{c['id']} fill={c['fill']:.3f}", (35, int(c['center'][1])-15), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 80, 220), 1)
            views.append(panel(view, '3B. Edges' if not audit['normalized'] else '3C. Normalized edges',
                [f"Contours={audit['contour_count']}; accepted={audit['candidates']}", 'Magenta boxes were REJECTED.']))
        best_view = slot.copy(); top = outlines[1]['best_by_original_score']; selected = outlines[1]['selected_polygon']
        if top: draw_polygon(best_view, selected if selected is not None else top[0]['polygon'], (80, 220, 30) if selected is not None else (30, 30, 240))
        views.append(panel(best_view, '3D. Normalized capsule audit',
            [f"Best-score cost={top[0]['raw_cost'] if top else 'none'}; gate=1.25", 'Green = core accepted, coverage unverified.' if selected is not None else 'Red = REJECTED, not a found window.']))
        cv2.imwrite(str(output/'03-window-search.png'), row(views))
        report = dict(source_sha256=sha, original_size=[image.shape[1], image.shape[0]], exif_orientation=exif,
            project_id=args.project, pipeline=config.PIPELINE_VERSION, core_patch=config.CORE_PATCH,
            core_commit=bundle['commit'], core_bundle_sha256=hashlib.sha256((ROOT/'frontend/vendor/colloidal/core.json').read_bytes()).hexdigest(),
            runtime=dict(python=sys.version.split()[0], opencv=cv2.__version__, numpy=np.__version__),
            coordinate_space='exif_corrected_original_pixels', browser_preview_transform_applied=False,
            replay=dict(status=replay['status'], channels=[dict(id=c['id'], status=c['status'],
                image_result=c.get('image_result'), final_result=c.get('final_result'),
                measurement={k: (c.get('measurement') or {}).get(k) for k in ['c', 't', 'c_present', 'threshold']}) for c in replay['channels']], error=replay.get('error')),
            board=meta, slot_polygon_source=rounded(slot_poly), window_search_polygon_source=rounded(search_poly),
            card_body_diagnostic=card, normalized_card_window_check=normalized_check,
            window_contours=contour_reports, outline_search=outlines,
            production_algorithm_modified=False, database_modified=False, diagnostic_only=True,
            final_verdict_generated=False, physical_card_acceptance=False)
        (output/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
        body_caption = ('左：旧裁区。中：扩大卡位周边后，离线轮廓实验自动得到绿色四边形候选。右：按该候选校正的卡片图像。候选尚未验证真实卡壳、产品身份或独立上下方向，不参与业务判读。' if normalized is not None else '未取得唯一卡壳候选。黄色仅是旧槽位；本图不构成卡壳已定位的证据。')
        captions = [
            ('原始帧与定位板', '绿色为识别到的标记；黄色是按布局推算的槽位，不是实际卡边界；紫色是旧窗口搜索区。使用板坐标做透视校正，未应用浏览器预览变换。'),
            ('槽位、周边与卡壳候选', body_caption),
            ('窗口搜索的实际证据', '左起依次为旧搜索区域、原始边缘、归一化后的边缘、轮廓补救审查图。紫框是被面积条件拒绝的边缘片段；红框是被拒绝的审查对象，绿框仅表示该独立补救调用接受了位置，均不证明真实窗口覆盖正确。原核心返回状态：'+replay['status']+'；通道数：'+str(len(replay['channels']))+'。')]
        pictures = []
        for (title, caption), name in zip(captions, ['01-original-markers-slot.png', '02-slot-card-outline.png', '03-window-search.png']):
            data = base64.b64encode((output/name).read_bytes()).decode()
            pictures.append(f'<section><h2>{title}</h2><p>{caption}</p><a href="{name}">打开完整调试图</a><img src="data:image/png;base64,{data}" alt="{title}"></section>')
        document = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>检测卡定位离线诊断</title><style>body{font:16px/1.7 system-ui;max-width:1400px;margin:24px auto;padding:16px;color:#243446}img{width:100%;height:auto;border:1px solid #ccd5df}section{margin:30px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:16px}code{overflow-wrap:anywhere}</style><h1>检测卡定位离线诊断</h1><p>只读复放；调试图隔离存储；不修改业务记录或算法。</p><p>原图SHA256：<code>'+sha+'</code></p>'+''.join(pictures)+'<details><summary>完整数值报告</summary><pre>'+html.escape(json.dumps(report, ensure_ascii=False, indent=2))+'</pre></details></html>'
        (output/'report.html').write_text(document)
        print(json.dumps(dict(status=replay['status'], board_rms_mm=meta['rms_mm'], card_candidate_status=card['status'],
            candidate_counts=[x['candidates'] for x in contour_reports], outline_costs=[x['best_by_original_score'][0]['raw_cost'] if x['best_by_original_score'] else None for x in outlines], report=str(output/'report.html')), ensure_ascii=False))


if __name__ == '__main__':
    main()
