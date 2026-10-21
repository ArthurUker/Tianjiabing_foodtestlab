"""I/O adapter for the frozen v5 core. All intermediate images stay in WASM RAM.

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
    try:
        with Image.open(io.BytesIO(bytes(raw))) as photo:
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
    except Exception as exc:
        return json.dumps(dict(status='decode_failed', error='无法解码原照片，请使用JPG、PNG或WebP', channels=[]), ensure_ascii=False)
    with tempfile.TemporaryDirectory(prefix='reader-') as directory:
        result = recognize(image, project, elapsed_seconds, directory, mode)
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
        version=result['version'], elapsed_ms=result['elapsed_ms'], core_patch=CORE_PATCH, channels=channels),
        ensure_ascii=False, allow_nan=False)
