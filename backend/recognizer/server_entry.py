"""Server I/O adapter for the frozen v5 core. Temporary diagnostics are removed.

The core sources are packaged verbatim from the pinned upstream commit. This
adapter only decodes original bytes and reduces the response; it does not alter
geometry, optical thresholds, classification, or diagnostic execution.
"""
import io
import json
import tempfile
import numpy as np
import cv2
from PIL import Image, ImageOps
from lab.reader import recognize
from lab.reader_config import CORE_PATCH, get_project
from process_log import ProcessLog

Image.MAX_IMAGE_PIXELS = 40_000_000


def image_metadata(raw):
    with Image.open(io.BytesIO(bytes(raw))) as photo:
        if photo.width * photo.height > 40_000_000:
            raise ValueError('照片超过4000万像素')
        return json.dumps(dict(format=photo.format, width=photo.width, height=photo.height))


def recognize_original(raw, project_id, elapsed_seconds_json, mode, rgba=None, width=0, height=0):
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
            result = recognize(image, project, elapsed_seconds, directory, mode)
    except Exception:
        trace.add('core_finished', 'failed', status='engine_error', reason='算法执行异常')
        return json.dumps(dict(status='engine_error', error='算法执行异常，请查看过程日志', channels=[], process_log=trace.events), ensure_ascii=False)
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
            'c_present': measurement.get('c_present'),
        })
    return json.dumps(dict(status=result['status'], error=result.get('error'),
        version=result['version'], elapsed_ms=result['elapsed_ms'], core_patch=CORE_PATCH, channels=channels, process_log=trace.events),
        ensure_ascii=False, allow_nan=False)
