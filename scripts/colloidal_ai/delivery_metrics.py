"""Original-pixel geometry evaluation; labels never select predictions."""
import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

CONTRACT_VERSION = 'delivery-geometry-v1'


def polygon_iou(left, right):
    a, b = np.asarray(left, np.float32), np.asarray(right, np.float32)
    if a.shape != (4, 2) or b.shape != (4, 2) or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError('four finite original-space points required')
    a, b = cv2.convexHull(a), cv2.convexHull(b)
    aa, ab = abs(cv2.contourArea(a)), abs(cv2.contourArea(b))
    if min(aa, ab) <= 1e-8:
        return 0.0
    inter, _ = cv2.intersectConvexConvex(a, b)
    return float(np.clip(inter / max(aa + ab - inter, 1e-8), 0, 1))


def match_instances(predicted, reference, threshold=.5):
    """Maximize qualifying one-to-one matches before total IoU."""
    n, m = len(predicted), len(reference)
    matrix = np.zeros((n, m), np.float64)
    for i, p in enumerate(predicted):
        for j, r in enumerate(reference):
            matrix[i, j] = polygon_iou(p, r)
    assignments = []
    if n and m:
        score = matrix + (matrix >= threshold) * (min(n, m) + 1)
        ii, jj = linear_sum_assignment(-score)
        assignments = [dict(pred=int(i), reference=int(j), iou=float(matrix[i,j]),
                            qualified=bool(matrix[i,j] >= threshold)) for i,j in zip(ii,jj)]
    tp = sum(p['qualified'] for p in assignments)
    return dict(threshold=threshold, predicted=n, reference=m, tp=tp, fp=n-tp, fn=m-tp,
                precision=tp/n if n else None, recall=tp/m if m else None,
                exact_count=n == m, all_matched=bool(m and n == m and tp == m),
                assignments=assignments,
                mean_best_iou=float(sum(p['iou'] for p in assignments)/m) if m else None)


def card_roi(card, shape, margin=.12):
    pts = np.asarray(card, np.float64)
    if pts.shape != (4,2) or not np.isfinite(pts).all():
        raise ValueError('invalid card polygon')
    low, high = pts.min(0), pts.max(0)
    pad = np.maximum((high-low)*margin, 8)
    lo = np.maximum(np.floor(low-pad), 0).astype(int)
    hi = np.minimum(np.ceil(high+pad), [shape[1], shape[0]]).astype(int)
    if np.any(hi <= lo):
        raise ValueError('empty clipped card ROI')
    return [*lo.tolist(), *hi.tolist()]


def inverse_letterbox(points, transform, origin):
    t = transform
    scale = np.array([t['original_width']/t['width'], t['original_height']/t['height']])
    return (np.asarray(points, np.float64)-[t['x'], t['y']])*scale + origin


def ordered_window(polygon, down):
    """C edge first. Inference down must come from MODEL geometry."""
    p, down = np.asarray(polygon,np.float64), np.asarray(down,np.float64)
    norm = np.linalg.norm(down)
    if norm < 1e-8:
        raise ValueError('undefined direction')
    down = down/norm
    center = p.mean(0)
    _, v = np.linalg.eigh((p-center).T@(p-center))
    axis = v[:,-1]
    if axis@down < 0:
        axis = -axis
    right = np.array([axis[1], -axis[0]])
    along, across = (p-center)@axis, (p-center)@right
    top = sorted(np.argsort(along)[:2], key=lambda i: across[i])
    bottom = sorted(np.argsort(along)[2:], key=lambda i: across[i])
    return p[[top[0], top[1], bottom[1], bottom[0]]].tolist()


def direction_evaluation(predicted, human_direction, predicted_windows, reference_windows):
    if not predicted or predicted.get('status') != 'verified_from_well_geometry':
        return dict(status='unverified', angle_deg=None, order_correct=None)
    down = np.asarray(predicted['down'],np.float64)
    human_down = np.asarray(human_direction[1])-np.asarray(human_direction[0])
    human_down = human_down/np.linalg.norm(human_down)
    angle = float(np.degrees(np.arccos(np.clip(down@human_down,-1,1))))
    matches = match_instances(predicted_windows,reference_windows)
    order = None
    if matches['all_matched']:
        order = [p['reference'] for p in sorted(matches['assignments'],key=lambda x:x['pred'])] == list(range(len(reference_windows)))
    return dict(status='verified',angle_deg=angle,polarity_correct=angle<90,
                direction_within_15deg=angle<=15,order_correct=order)
