"""Register actual aperture boundaries, using color only to propose centers.

A proposal is never a C/T assignment. End caps and both flanks must match
neutral edges independently of the proposed colored bands.
"""
import itertools
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

SEARCH_MM = (60., 105., 150., 192.)


def color_proposals(image, ppm):
    b, g, r = np.moveaxis(image.astype(np.float32), 2, 0)
    chroma = (r+b)*.5-g
    detail = chroma-gaussian_filter(chroma, (max(3., 2*ppm), .5))
    mask = (detail > 3.).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((1, 3), np.uint8))
    _, _, stats, centers = cv2.connectedComponentsWithStats(mask)
    proposals = []
    for (x, y, width, height, area), (cx, cy) in zip(stats[1:], centers[1:]):
        physical_y = cy/ppm+SEARCH_MM[1]
        if not (130 <= physical_y <= 160 and 1.2 <= width/ppm <= 5.2
                and .12 <= height/ppm <= 2 and width/height >= 2.5
                and area/(width*height) >= .5):
            continue
        proposals.append(dict(x=float(cx), y=float(cy), width=float(width), height=float(height)))
    return proposals, cv2.dilate(mask, np.ones((3, 3), np.uint8))


def edge_field(image, colored):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enhanced = cv2.createCLAHE(2., (8, 8)).apply(gray)
    edge = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 8, 24)
    edge |= cv2.Canny(cv2.GaussianBlur(enhanced, (3, 3), 0), 15, 45)
    edge[colored > 0] = 0
    return cv2.distanceTransform(255-edge, cv2.DIST_L2, 3)


def sample_ports(image, ppm):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    enhanced = cv2.createCLAHE(2., (8, 8)).apply(gray)
    ports = []
    for level, thresholds in ((gray, (8,24)), (enhanced,(40,120))):
        edge = cv2.Canny(cv2.GaussianBlur(level,(3,3),0),*thresholds)
        edge = cv2.morphologyEx(edge,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
        contours,_ = cv2.findContours(edge,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            (x,y),(w,h),_ = cv2.minAreaRect(contour)
            short,long = sorted(np.asarray([w,h])/ppm)
            if not (155 < y/ppm+SEARCH_MM[1] < 178 and short > 1.8 and long < 12.5 and long > 3.):
                continue
            if not (short < 6.5 or long/short < 1.6):
                continue
            if cv2.contourArea(contour) < .6*w*h:
                continue
            point=np.array([x,y])
            if not any(np.linalg.norm(point-p)<2*ppm for p in ports):
                ports.append(point)
    return ports


def port_triplets(ports, ppm):
    groups=[]
    for group in itertools.combinations(sorted(ports,key=lambda p:p[0]),3):
        p=np.asarray(group);gaps=np.diff(p[:,0])/ppm
        if min(gaps)<8 or max(gaps)>14 or abs(gaps[0]-gaps[1])>2.5:continue
        slope,offset=np.polyfit(p[:,0],p[:,1],1)
        if abs(slope)>.35 or max(abs(p[:,1]-(p[:,0]*slope+offset)))>1.5*ppm:continue
        groups.append(p)
    return groups


def _fit_aperture(distance, center_x, center_y, band_width, ppm, angle=0.):
    # Work in physical units. Width includes a small border outside the band.
    widths = np.arange(max(2.3, band_width/ppm-.3), min(5.2, band_width/ppm+1.3)+.01, .3)*ppm
    heights = np.arange(14., 21.1, .5)*ppm
    offsets_y = np.arange(-4., 4.01, .25)*ppm
    offsets_x = np.arange(-.3, .31, .15)*ppm
    combinations = np.array(list(itertools.product(widths, heights, offsets_y, offsets_x)))
    w, h, dy, dx = combinations.T
    local = np.stack([np.stack([-w/2, -h/2],1), np.stack([w/2,-h/2],1),
                      np.stack([w/2,h/2],1), np.stack([-w/2,h/2],1)],1)
    rotation = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
    boxes = local @ rotation.T + np.stack([center_x+dx, center_y+dy],1)[:,None,:]
    fractions = np.linspace(.15,.85,25)[None,:,None]
    supports, costs = [], []
    for side in range(4):
        points = boxes[:,side,None,:]*(1-fractions)+boxes[:,(side+1)%4,None,:]*fractions
        xx = np.rint(points[:,:,0]).astype(int); yy = np.rint(points[:,:,1]).astype(int)
        inside = (xx>=0)&(xx<distance.shape[1])&(yy>=0)&(yy<distance.shape[0])
        values = distance[np.clip(yy,0,distance.shape[0]-1),np.clip(xx,0,distance.shape[1]-1)]/ppm
        values[~inside] = 10.
        supports.append(np.mean(values < .45,axis=1))
        costs.append(np.mean(np.minimum(values,1.5),axis=1))
    supports = np.asarray(supports).T
    costs = np.asarray(costs).T
    feasible = np.all(supports>=.5,axis=1) & (np.mean(supports,axis=1)>=.75)
    if not np.any(feasible):
        return None
    score = costs.mean(1)+.015*abs(h/ppm-17.)+.015*abs(dy/ppm)
    score[~feasible]=np.inf
    winner = int(np.argmin(score))
    if score[winner] > .4:
        return None
    return dict(box=boxes[winner], score=float(score[winner]), support=supports[winner].tolist())


def fit_aperture(distance, center_x, center_y, band_width, ppm, angle=0.):
    candidates=[]
    for degrees in (-2., -1., 0., 1., 2.):
        fit=_fit_aperture(distance,center_x,center_y,band_width,ppm,angle+np.deg2rad(degrees))
        if fit is not None:candidates.append(fit)
    return min(candidates,key=lambda f:f['score']) if candidates else None


def locate_membranes(image, ppm, count):
    proposals, colored = color_proposals(image, ppm)
    clusters=[]
    for p in sorted(proposals,key=lambda p:p['x']):
        match=next((c for c in clusters if abs(np.mean([v['x'] for v in c])-p['x'])<1.5*ppm),None)
        if match is None:clusters.append([p])
        else:match.append(p)
    if len(clusters)<min(count,2):return None
    if count == 1:
        triple = locate_membranes(image, ppm, 3)
        if triple is not None:
            triple_centers = [np.asarray(box).mean(0) for box in triple[0]]
            clusters = [cluster for cluster in clusters if not any(
                abs(np.mean([p['x'] for p in cluster])-center[0]) < 2*ppm
                for center in triple_centers)]
            if not clusters:
                return None
    ports=sample_ports(image,ppm)
    port_rows=port_triplets(ports,ppm)
    if count==3 and port_rows:
        # Two neighboring apertures plus an independent row of three sample
        # ports can propose a missing middle WINDOW, never a missing band.
        extra=[]
        for left,right in itertools.combinations(clusters,2):
            lx,rx=np.mean([p['x'] for p in left]),np.mean([p['x'] for p in right])
            if not 16*ppm<rx-lx<28*ppm:continue
            positions=np.array([lx,(lx+rx)/2,rx])
            if not any(np.max(abs(row[:,0]-positions))<3*ppm for row in port_rows):continue
            widths=[p['width'] for c in (left,right) for p in c]
            extra.append([dict(x=float(positions[1]), y=float(np.median([min(p['y'] for p in c) for c in (left,right)])),
                               width=float(np.median(widths)),height=ppm,inferred=True)])
        clusters+=extra
        clusters.sort(key=lambda c:np.mean([p['x'] for p in c]))
    if len(clusters)<count:return None
    distance=edge_field(image,colored)
    fits=[]
    for group in itertools.combinations(clusters,count):
        xs=np.array([np.mean([p['x'] for p in c]) for c in group])
        if count==1 and max(p['width'] for p in group[0]) < 2.*ppm:
            continue
        if count==1 and any(np.min(abs(row[:,0]-xs[0]))<3*ppm for row in port_rows):
            continue
        ys=np.array([min(p['y'] for p in c) for c in group])
        if count==3:
            gap=np.diff(xs)/ppm
            if min(gap)<8 or max(gap)>14 or abs(gap[0]-gap[1])>1.5:continue
            # Missing C in one aperture may leave only a lower T proposal.
            slope=np.polyfit(xs,ys,1)[0] if np.ptp(ys)<2.5*ppm else 0.
            if abs(slope)>.2:continue
            angle=float(np.arctan(slope))
        else:angle=0.
        # The aperture center is typically below the upper band, but the
        # full end-cap search and identity regions remain independent checks.
        cy=float(np.median(ys)+3.7*ppm)
        fitted=[]
        for cluster,x in zip(group,xs):
            fit=fit_aperture(distance,x,cy,float(np.median([p['width'] for p in cluster])),ppm,angle)
            if fit is None:break
            box=fit['box'];v=(box[2]+box[3]-box[0]-box[1])/2
            top=(box[0]+box[1])/2
            width=max(p['width'] for p in cluster)
            trusted=[p for p in cluster if not p.get('inferred') and p['width']>=.6*width]
            fractions=[np.dot(np.array([p['x'],p['y']])-top,v)/np.dot(v,v) for p in trusted]
            if fractions and (min(fractions)<.04 or max(fractions)>.96):
                break
            fitted.append(fit)
        if len(fitted)!=count:continue
        associations=[]
        for fit in fitted:
            box=fit['box']; center=box.mean(0)
            v=(box[2]+box[3]-box[0]-box[1])/2
            v=v/np.linalg.norm(v); u=np.array([v[1],-v[0]])
            matching=[p for p in ports if 17*ppm<np.dot(p-center,v)<34*ppm and abs(np.dot(p-center,u))<4*ppm]
            associations.append(bool(matching))
        required_ports = 1
        if count==3 and (any(p.get('inferred') for cluster in group for p in cluster)
                         or np.mean([f['score'] for f in fitted])>.2):
            required_ports=2
        if sum(associations)<required_ports:continue
        centers=np.array([f['box'].mean(0) for f in fitted])
        if count==3 and np.ptp(centers[:,1]-slope*centers[:,0])>1.5*ppm:continue
        score=float(np.mean([f['score'] for f in fitted]))
        fits.append((score,fitted,associations))
    if not fits:return None
    fits.sort(key=lambda f:f[0]);score,selected,associations=fits[0]
    return [f['box'].tolist() for f in selected],dict(locator='neutral-aperture-boundaries-v1',
        window_boundary_support=[f['support'] for f in selected],geometry_score=round(score,4), sample_port_support=associations,
        proposal_role='color_centers_only_not_C_or_T_identity',identity_check='not_performed')
