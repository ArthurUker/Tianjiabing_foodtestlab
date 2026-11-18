"""Card-relative triplex geometry on a marker-rectified search area.

Only shell dimensions, contour shape and membrane boundary edges are used.
C/T intensity, classification, specimen IDs and historical labels never rank
candidates. The search margin is deliberately wider than either printed slot.
"""
import cv2
import numpy as np

# Includes the old central slot and the dual-board right slot, with visible
# paper outside the complete shell. These are search bounds, not window sites.
TRIPLEX_SEARCH_MM = (60., 105., 150., 192.)


def ordered_box(rect):
    box = cv2.boxPoints(rect)
    return np.asarray([box[np.argmin(box.sum(1))],
                       box[np.argmin(box[:, 1]-box[:, 0])],
                       box[np.argmax(box.sum(1))],
                       box[np.argmax(box[:, 1]-box[:, 0])]], np.float32)


def boundary_support(box, distance, radius):
    supports = []
    height, width = distance.shape
    for i in range(4):
        t = np.linspace(.2, .8, 30)[:, None]
        points = box[i]*(1-t) + box[(i+1) % 4]*t
        x, y = np.rint(points).astype(int).T
        if np.any(x < 0) or np.any(x >= width) or np.any(y < 0) or np.any(y >= height):
            return [0.] * 4
        supports.append(float(np.mean(distance[y, x] <= radius)))
    return supports


def locate_triplex(crop, ppm):
    """Return (three source-pixel windows, evidence), or None if uncertain.

    The nominal 40 x 70 mm shell is a development profile. A conservative
    dimension tolerance accommodates perspective residual and printed scale;
    all four sides of every inferred membrane must independently have edges.
    """
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    enhanced = cv2.createCLAHE(2., (8, 8)).apply(gray)
    raw_blur = cv2.GaussianBlur(gray, (3, 3), 0)
    enhanced_blur = cv2.GaussianBlur(enhanced, (3, 3), 0)
    edges = cv2.Canny(raw_blur, 8, 24) | cv2.Canny(enhanced_blur, 15, 45)
    distance = cv2.distanceTransform(255-edges, cv2.DIST_L2, 3)
    candidates = []
    for level in (raw_blur, enhanced_blur):
        for thresholds in ((8, 24), (20, 60), (40, 120)):
            outline = cv2.Canny(level, *thresholds)
            outline = cv2.morphologyEx(outline, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            contours, _ = cv2.findContours(outline, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                rect = cv2.minAreaRect(contour)
                short, long = sorted(np.asarray(rect[1]) / ppm)
                if not (34. < short < 44. and 59.5 < long < 77.):
                    continue
                fill = abs(cv2.contourArea(contour)) / (short * long * ppm**2)
                if fill < .93 or fill > .99 or abs(short / long / (40 / 70) - 1) > .04:
                    continue
                shell = ordered_box(rect)
                if abs(shell[3, 0]-shell[0, 0]) > abs(shell[3, 1]-shell[0, 1])*.25:
                    continue
                # Cropping an image edge cannot establish a complete shell.
                if (shell.min() < 2 or shell[:, 0].max() >= crop.shape[1]-2
                        or shell[:, 1].max() >= crop.shape[0]-2):
                    continue
                transform = cv2.getPerspectiveTransform(
                    np.float32([[0, 0], [40, 0], [40, 70], [0, 70]]), shell)
                cuts = [abs(cv2.pointPolygonTest(contour, tuple(map(float, p)), True))/ppm for p in shell]
                if min(cuts) < 1.:
                    continue
                windows, supports = [], []
                for center_x in (9., 20., 31.):
                    model = np.float32([[[center_x-2, 24.5], [center_x+2, 24.5],
                                         [center_x+2, 41.5], [center_x-2, 41.5]]])
                    window = cv2.perspectiveTransform(model, transform)[0]
                    support = boundary_support(window, distance, max(1.5, .7*ppm))
                    windows.append(window)
                    supports.append(support)
                if min(min(s) for s in supports) < .45:
                    continue
                score = (5*abs(short/long-40/70) + abs(long-70)/70 + 1-fill
                         + .2*(1-float(np.mean(supports))))
                candidates.append((score, shell, windows, supports, short, long, fill, cuts))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    winner = candidates[0]
    # Distinct shells with comparable evidence are ambiguous. Never pick one
    # by which candidate happens to produce more valid or negative channels.
    for other in candidates[1:]:
        if (np.linalg.norm(other[1].mean(0)-winner[1].mean(0)) > 5*ppm
                and other[0] < winner[0]+.15):
            return None
    _, shell, windows, supports, short, long, fill, cuts = winner
    return [w.tolist() for w in windows], dict(
        locator='card-relative-boundary-v1', card_polygon_source=shell.tolist(),
        card_size_mm=[round(float(short), 3), round(float(long), 3)],
        contour_fill=round(float(fill), 4), corner_cut_mm=[round(x,3) for x in cuts],
        window_boundary_support=[[round(v, 3) for v in s] for s in supports],
        identity_check='not_performed', profile_validation='development_only')
