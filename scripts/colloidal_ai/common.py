"""Shared geometry for the isolated learning experiment (never business truth)."""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / '.cache/colloidal-ai-20261110'
PHOTOS = ROOT / '.cache/colloidal-local-trial-20261022/originals'
CLASSES = ['card', 'membrane']  # independent sigmoid channels; regions overlap
MEAN = np.array([.485, .456, .406], np.float32)[:, None, None]
STD = np.array([.229, .224, .225], np.float32)[:, None, None]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_rgb(path):
    with Image.open(path) as image:
        return np.array(ImageOps.exif_transpose(image).convert('RGB'))


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def letterbox(image, size, mask=False):
    h, w = image.shape[:2]
    ratio = min(size / w, size / h)
    nw, nh = max(1, round(w * ratio)), max(1, round(h * ratio))
    x, y = (size - nw) // 2, (size - nh) // 2
    output = np.zeros((size, size, *image.shape[2:]), dtype=image.dtype)
    output[y:y+nh, x:x+nw] = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_NEAREST if mask else cv2.INTER_LINEAR)
    return output, dict(x=x, y=y, width=nw, height=nh, original_width=w, original_height=h)


def restore_map(probabilities, transform):
    t = transform
    crop = probabilities[t['y']:t['y']+t['height'], t['x']:t['x']+t['width']]
    return cv2.resize(crop, (t['original_width'], t['original_height']), interpolation=cv2.INTER_LINEAR)


def input_tensor(image, size):
    boxed, transform = letterbox(image, size)
    array = (boxed.astype(np.float32).transpose(2, 0, 1) / 255 - MEAN) / STD
    return np.ascontiguousarray(array[None]), transform


def region_crop(points, shape, padding=.3):
    points = np.asarray(points).reshape(-1, 2)
    low, high = points.min(0), points.max(0)
    pad = np.maximum((high-low)*padding, 16)
    h, w = shape[:2]
    low, high = np.maximum(0, low-pad).astype(int), np.minimum([w, h], high+pad).astype(int)
    return [int(low[0]), int(low[1]), int(high[0]), int(high[1])]

