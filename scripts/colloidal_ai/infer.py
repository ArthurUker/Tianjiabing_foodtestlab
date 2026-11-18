"""CPU-only ONNX geometric proposals. No training framework or result decision.

Returns candidate regions in EXIF-corrected original pixels, never a clinical/
assay interpretation. Experimental weights require explicit opt-in.
"""
import argparse
import json
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from common import WORK, digest, input_tensor, read_rgb, region_crop
from geometry_gate import direction_from_wells


def components(probability, transform, minimum_area=16, offset=(0, 0), close_gaps=False):
    binary = (probability >= .5).astype(np.uint8)
    if close_gaps:
        binary=cv2.morphologyEx(binary,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    t = transform
    scale = np.array([t['original_width']/t['width'], t['original_height']/t['height']])
    regions = []
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] < minimum_area:
            continue
        ys, xs = np.where(labels == label)
        # Remove letterbox-only predictions before any coordinate clipping.
        keep = (xs >= t['x']) & (xs < t['x']+t['width']) & (ys >= t['y']) & (ys < t['y']+t['height'])
        if keep.sum() < minimum_area:
            continue
        points = np.stack([xs[keep], ys[keep]], 1).astype(np.float32)
        rectangle = cv2.boxPoints(cv2.minAreaRect(points))
        polygon = (rectangle-np.array([t['x'], t['y']]))*scale + np.array(offset)
        polygon[:, 0] = np.clip(polygon[:, 0], offset[0], offset[0]+t['original_width']-1)
        polygon[:, 1] = np.clip(polygon[:, 1], offset[1], offset[1]+t['original_height']-1)
        regions.append(dict(polygon=polygon.round(3).tolist(),
                            score=float(probability[ys[keep], xs[keep]].mean()),
                            model_pixels=int(keep.sum())))
    return sorted(regions, key=lambda r: r['model_pixels'], reverse=True)


class Locator:
    def __init__(self, model_path, allow_experimental=False):
        model_path = Path(model_path)
        self.metadata = json.loads(model_path.with_suffix('.json').read_text())
        if not self.metadata.get('production_approved') and not allow_experimental:
            raise ValueError('Experimental model: set allow_experimental for offline evaluation only')
        actual_hash = digest(model_path)
        if actual_hash != self.metadata['onnx_sha256']:
            raise ValueError('Model SHA256 mismatch')
        if self.metadata.get('classes') not in [['card','membrane'],['card','membrane','sample_well']]:
            raise ValueError('Unsupported class ordering')
        code_hashes=self.metadata.get('inference_code_hashes',{})
        if len(self.metadata['classes'])==3 and set(code_hashes)!={'infer.py','common.py','geometry_gate.py'}:
            raise ValueError('Three-region model requires a versioned inference implementation')
        for name,expected in code_hashes.items():
            if name not in {'infer.py','common.py','geometry_gate.py'} or digest(Path(__file__).parent/name)!=expected:
                raise ValueError('Inference source SHA256 mismatch')
        self.sha256 = actual_hash
        self.size = self.metadata['input_size']
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        self.session = ort.InferenceSession(str(model_path), sess_options=options,
                                           providers=['CPUExecutionProvider'])

    def probability(self, image):
        tensor, transform = input_tensor(image, self.size)
        logits = self.session.run(None, {'image': tensor})[0][0]
        probability = 1/(1+np.exp(-np.clip(logits, -30, 30)))
        return probability, transform

    def locate(self, image):
        started = time.perf_counter()
        coarse, transform = self.probability(image)
        cards = components(coarse[0], transform, minimum_area=32)
        if len(self.metadata['classes'])==3 and cards:
            cards=[r for r in cards if r['model_pixels']>=.05*cards[0]['model_pixels']]
        candidates = []
        for card in cards[:4]:  # bounded work, with explicit overflow below
            crop = region_crop(card['polygon'], image.shape, padding=.2)
            x0, y0, x1, y1 = crop
            if x1-x0 < 4 or y1-y0 < 4:
                continue
            fine, local_transform = self.probability(image[y0:y1, x0:x1])
            advanced=len(self.metadata['classes'])==3
            windows = components(fine[1], local_transform, minimum_area=16, offset=(x0, y0),close_gaps=advanced)
            wells=components(fine[2],local_transform,minimum_area=16,offset=(x0,y0),close_gaps=True) if advanced else []
            if advanced:
                if windows:windows=[r for r in windows if r['model_pixels']>=.08*windows[0]['model_pixels']]
                if wells:wells=[r for r in wells if r['model_pixels']>=.08*wells[0]['model_pixels']]
            direction=direction_from_wells(windows,wells) if advanced else dict(status='unverified',reason='该模型尚无加样孔目标')
            if direction['status']=='verified_from_well_geometry':
                windows=[windows[i]for i in direction['window_order']]
            points=np.asarray(card['polygon'])
            truncated=bool((points[:,0]<3).any() or (points[:,1]<3).any() or
                           (points[:,0]>image.shape[1]-4).any() or (points[:,1]>image.shape[0]-4).any())
            candidates.append(dict(card=card, crop=crop, windows=windows,
                                   observed_window_count=len(windows),
                                   sample_wells=wells,direction=direction,truncated=truncated,
                                   channel_order='geometry_only_not_product_identity', orientation=direction['status']))
        return dict(status='candidates' if candidates else 'localization_failed',
                    card_instances=candidates, candidate_overflow=len(cards)>4,
                    coordinate_space='exif_corrected_original_pixels',
                    model_sha256=self.sha256, production_approved=False,
                    locator_revision='three-region-bg-v2' if len(self.metadata['classes'])==3 else 'two-region-v1',
                    interpretation=None, elapsed_ms=round((time.perf_counter()-started)*1000, 2))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', type=Path, default=WORK/'runs/prototype-v1/model.onnx')
    p.add_argument('--image', type=Path, required=True)
    p.add_argument('--allow-experimental', action='store_true')
    args = p.parse_args()
    locator = Locator(args.model, allow_experimental=args.allow_experimental)
    result = locator.locate(read_rgb(args.image))
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
