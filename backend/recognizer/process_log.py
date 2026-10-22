"""Observe the frozen core without changing geometry, pixels or decisions.

The resident worker is single-threaded. Wrappers exist only for one recognition
and are restored in finally. Output is bounded scalars and geometry, never
profiles, image bytes, crops, labels or local filesystem paths.
"""
from datetime import datetime, timezone
import time
import cv2
import numpy as np
from lab import reader, reader_geometry as geometry


class ProcessLog:
    def __init__(self, project):
        self.project = project
        self.started = time.perf_counter()
        self.events = []
        self.restores = []
        self.frame = None
        self.channel = 0
        self.channel_maps = []

    def add(self, stage, state="ok", **details):
        if len(self.events) < 160:
            self.events.append(dict(at=datetime.now(timezone.utc).isoformat(),
                origin="algorithm", stage=stage, state=state,
                elapsed_ms=round((time.perf_counter()-self.started)*1000, 2), details=details))

    def patch(self, module, name, observer):
        original = getattr(module, name)
        def observed(*args, **kwargs):
            started = time.perf_counter()
            try:
                result = original(*args, **kwargs)
            except Exception as exc:
                self.add(observer[0], "failed", reason=str(exc)[:240] if isinstance(exc, geometry.ReaderFailure) else "算法步骤异常",
                    status=getattr(exc, "status", "engine_error"), duration_ms=round((time.perf_counter()-started)*1000, 2))
                if observer[0] == 'measurement':
                    self.channel += 1
                raise
            # An observer must never change a successful algorithm result.
            try:
                observer[1](args, kwargs, result, round((time.perf_counter()-started)*1000, 2))
            except Exception:
                self.add(observer[0], "warning", reason="diagnostic_receipt_unavailable")
            return result
        setattr(module, name, observed)
        self.restores.append((module, name, original))

    def __enter__(self):
        self.patch(geometry, "board_slot", ("board_geometry", self.board))
        self.patch(geometry, "closeup_slot", ("board_geometry", self.closeup))
        self.patch(geometry, "window_candidates", ("window_candidates", self.candidates))
        self.patch(geometry, "outline_window", ("outline_search", self.outline))
        self.patch(geometry, "choose_windows", ("window_selection", self.selection))
        self.patch(reader, "locate", ("localization", self.located))
        self.patch(reader, "local_measure", ("measurement", self.measured))
        self.patch(reader, "classify", ("image_classification", self.classified))
        self.patch(reader, "optical_audit", ("optical_audit", self.diagnostic))
        self.patch(reader, "shadow_predict", ("learning_shadow", self.diagnostic))
        return self

    def __exit__(self, *args):
        for module, name, original in reversed(self.restores):
            setattr(module, name, original)

    @staticmethod
    def points(points):
        return np.asarray(points).round(3).tolist()

    def board(self, args, kwargs, result, duration):
        self.frame = result
        meta = result[-1]
        self.add("board_geometry", duration_ms=duration, mode="board",
            marker_ids=meta.get("marker_ids"), inliers=meta.get("inliers"),
            rms_mm=meta.get("rms_mm"), rms_gate_mm=meta.get("rms_gate_mm"),
            px_per_mm=meta.get("px_per_mm"), layout_id=meta.get("layout_id"),
            layout_version=meta.get("layout_version"), geometry_patch=meta.get("geometry_patch"),
            slot_polygon_source=self.source_points([[0, 0], [299, 0], [299, 799], [0, 799]]),
            coordinate_space="exif_corrected_original_pixels", physical_layout_validated=False)

    def closeup(self, args, kwargs, result, duration):
        self.frame = result[:5]
        self.add("board_geometry", duration_ms=duration, mode="closeup",
            rotation_quarters=result[4].get("rotation_quarters"), direction_basis=result[4].get("direction_basis"),
            coordinate_space="exif_corrected_original_pixels")

    def source_points(self, points, matrix=None):
        if self.frame is None:
            return None
        _, source, transform, _, meta = self.frame
        mapped = cv2.perspectiveTransform(np.float32(points)[None], np.linalg.inv(transform if matrix is None else matrix))[0]
        # closeup_slot rotates the source. Undo that rotation for one common
        # coordinate space: the EXIF-corrected original decoded image.
        height, width = source.shape[:2]
        q = meta.get("rotation_quarters", 0)
        x, y = mapped[:, 0].copy(), mapped[:, 1].copy()
        if q == 1:
            mapped[:, 0], mapped[:, 1] = y, width-1-x
        elif q == 2:
            mapped[:, 0], mapped[:, 1] = width-1-x, height-1-y
        elif q == 3:
            mapped[:, 0], mapped[:, 1] = height-1-y, x
        return self.points(mapped)

    def candidates(self, args, kwargs, result, duration):
        self.add("window_candidates", "ok" if result else "warning", duration_ms=duration,
            count=len(result), edge_exposure_normalized=bool(kwargs.get("normalize_exposure", args[1] if len(args) > 1 else False)),
            centers_slot=[self.points(c["center"]) for c in result[:12]],
            note="Edge candidates only; not proof of the true membrane window")

    def outline(self, args, kwargs, result, duration):
        self.add("outline_search", "ok" if result is not None else "warning", duration_ms=duration,
            expected_center_x=args[1], matched=result is not None,
            expanded_search=bool(kwargs.get("expanded_search", False)),
            polygon_slot=self.points(result) if result is not None else None,
            note="Capsule outline fallback; a match alone does not verify C/T coverage")

    def selection(self, args, kwargs, result, duration):
        self.add("window_selection", duration_ms=duration, expected_count=args[1], selected_count=len(result),
            polygons_slot=[self.points(p) for p in result], require_upper=bool(kwargs.get("require_upper", False)))

    def located(self, args, kwargs, result, duration):
        windows, _, meta = result
        self.channel_maps = []
        details = dict(duration_ms=duration, input_kind=meta.get("input_kind"),
            window_shapes=meta.get("window_shapes"), marker_refinement=meta.get("marker_refinement"),
            edge_exposure_normalized=meta.get("edge_exposure_normalized"),
            expanded_outline_search=meta.get("expanded_outline_search"),
            geometry_fallbacks=meta.get("geometry_fallbacks"),
            coordinate_space="exif_corrected_original_pixels",
            note="Geometry passed; optical coverage still needs validation")
        polygons, regions = [], []
        if self.frame is not None:
            _, _, transform, native, _ = self.frame
            for raw_box in meta.get("window_polygons_slot", []):
                box = np.float32(raw_box)
                width = (np.linalg.norm(box[1]-box[0])+np.linalg.norm(box[2]-box[3]))/2
                height = (np.linalg.norm(box[3]-box[0])+np.linalg.norm(box[2]-box[1]))/2
                w, h = max(9, round(width*min(native, 4.))), max(35, round(height*min(native, 4.)))
                ix, iy = max(1, round(w*.12)), max(1, round(h*.08))
                matrix = cv2.getPerspectiveTransform(box, np.float32([[0, 0], [w-1, 0], [w-1, h-1], [0, h-1]])) @ transform
                self.channel_maps.append((matrix, ix, iy, w, h))
                polygons.append(self.source_points(box))
                regions.append(self.source_points([[ix, iy], [w-ix-1, iy], [w-ix-1, h-iy-1], [ix, h-iy-1]], matrix))
        details.update(window_polygons_source=polygons, measurement_polygons_source=regions)
        self.add("localization", **details)

    def measured(self, args, kwargs, result, duration):
        index = self.channel
        self.channel += 1
        lines = []
        if index < len(self.channel_maps):
            matrix, ix, iy, w, _ = self.channel_maps[index]
            for label, position in zip(["C", "T"], result.get("indices", [])):
                lines.append(dict(label=label, points=self.source_points([[ix, iy+position], [w-ix-1, iy+position]], matrix)))
        values = {k: result.get(k) for k in ["c", "t", "c_present", "threshold", "noise", "positions", "indices", "method", "acquisition_quality", "fit_evaluations", "transverse_rows"]}
        self.add("measurement", "ok" if result.get("c_present") else "warning", duration_ms=duration,
            channel_id=self.project["channels"][min(index, len(self.project["channels"])-1)]["id"],
            measurement_lines_source=lines, **values)

    def classified(self, args, kwargs, result, duration):
        self.add('image_classification', duration_ms=duration,
            channel_id=self.project['channels'][max(0, self.channel-1)]['id'],
            c_present=bool(args[2]), image_result=result.get('image_result'),
            rule_status=result.get('rule_status'), note='图像候选；业务时间有效性由Node按拍照时距单独校验')

    def diagnostic(self, args, kwargs, result, duration):
        is_rgb = 'channels' in result
        self.add('optical_audit' if is_rgb else 'learning_shadow', duration_ms=duration,
            status=result.get('status', 'completed'), version=result.get('version'),
            decision_role='diagnostic_only', note='原核心诊断旁路，不接管主判读')
