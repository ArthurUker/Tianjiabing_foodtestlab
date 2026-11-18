"""Deployable geometric decoding; no annotations or cached predictions are read."""
import cv2
import numpy as np
from common import input_tensor
from infer import components
from delivery_metrics import card_roi, ordered_window, polygon_iou
from delivery_relations import pair_direction


def select_card(prediction):
    candidates=sorted(prediction.get('card_instances') or [],key=lambda c:c['card']['model_pixels'],reverse=True)
    if not candidates:return None,dict(status='no_card',candidate_count=0)
    chosen=candidates[0];area=chosen['card']['model_pixels']
    ambiguous=bool(prediction.get('candidate_overflow')) or any(
        c['card']['model_pixels']>=.5*area and polygon_iou(c['card']['polygon'],chosen['card']['polygon'])<.2 for c in candidates[1:])
    return chosen['card']['polygon'],dict(status='multiple_cards' if ambiguous else 'card_selected',
        candidate_count=len(candidates),ambiguous=ambiguous,truncated=chosen.get('truncated',False))


def roi_regions(session,image,card):
    box=card_roi(card,image.shape);x0,y0,x1,y1=box
    tensor,t=input_tensor(image[y0:y1,x0:x1],512)
    logits=session.run(None,{'image':tensor})[0][0]
    prob=1/(1+np.exp(-np.clip(logits,-30,30)));groups=[];raws=[]
    for channel in [1,2]:
        raw=components(prob[channel],t,minimum_area=16,offset=(x0,y0),close_gaps=True)
        kept=[]
        for r in raw:
            p=np.asarray(r['polygon']);s=np.linalg.norm(np.roll(p,-1,axis=0)-p,axis=1);ratio=s.max()/max(s.min(),1)
            if r['score']<.5 or raw and r['model_pixels']<.08*raw[0]['model_pixels']:continue
            if channel==1 and ratio<2.3 or channel==2 and ratio>2.6:continue
            kept.append(r)
        groups.append(kept);raws.append(raw)
    # Direction selection deliberately includes all raw port candidates, just
    # as the frozen axial-pair baseline does.
    return groups[0],raws[1],box


def local_patch(image,polygon):
    p=np.asarray(polygon,float);v=np.linalg.eigh((p-p.mean(0)).T@(p-p.mean(0)))[1][:,-1]
    if v[1]<0 or abs(v[1])<1e-6 and v[0]<0:v=-v
    p=np.asarray(ordered_window(p,v),np.float32);center=p.mean(0)
    basis=np.stack([[v[1],-v[0]],v],axis=1)
    expanded=((p-center)@basis*np.array([3.,1.5]))@basis.T+center
    transform=cv2.getPerspectiveTransform(expanded.astype(np.float32),np.float32([[0,0],[95,0],[95,255],[0,255]]))
    crop=cv2.warpPerspective(image,transform,(96,256),borderMode=cv2.BORDER_REFLECT_101)
    coarse=np.zeros((256,96),np.float32)
    cv2.fillPoly(coarse,[np.rint(cv2.perspectiveTransform(p[None],transform)[0]).astype(np.int32)],1)
    return np.concatenate([crop.astype(np.float32).transpose(2,0,1)/255,coarse[None]],0),np.linalg.inv(transform)


def polygon_from_probability(prob,inverse):
    count,lab,stats,_=cv2.connectedComponentsWithStats((prob>=.5).astype(np.uint8))
    ids=[i for i in range(1,count) if stats[i,cv2.CC_STAT_AREA]>=16]
    if not ids:return None
    yy,xx=np.where(lab==max(ids,key=lambda i:stats[i,cv2.CC_STAT_AREA]))
    p=cv2.boxPoints(cv2.minAreaRect(np.stack([xx,yy],1).astype(np.float32)))
    return cv2.perspectiveTransform(p[None],inverse)[0].astype(float).tolist()


def geometry(image,primary,roi,refiner):
    prediction=primary.locate(image);card,selection=select_card(prediction)
    result=dict(status='no_card',card=card,windows=[],wells=[],direction=dict(status='unverified'),selection=selection)
    if card is None:return result
    if selection['ambiguous']:result['status']='multiple_cards';return result
    coarse,wells,box=roi_regions(roi,image,card)
    d=pair_direction(coarse,wells)
    if d['status']=='verified_from_well_geometry':
        coarse=[dict(polygon=ordered_window(coarse[i]['polygon'],d['down']),score=coarse[i]['score']) for i in d['window_order']]
    refined=[]
    for w in coarse:
        x,inverse=local_patch(image,w['polygon'])
        logits=refiner.run(None,{'image':x[None]})[0][0,0]
        p=polygon_from_probability(1/(1+np.exp(-np.clip(logits,-30,30))),inverse)
        if p is not None:refined.append(dict(polygon=p,score=w['score']))
    d=pair_direction(refined,wells)
    windows=[ordered_window(refined[i]['polygon'],d['down']) for i in d['window_order']] if d['status']=='verified_from_well_geometry' else [w['polygon'] for w in refined]
    result.update(status='geometry_ready' if d['status']=='verified_from_well_geometry' else 'direction_or_structure_unverified',
        windows=windows,wells=[w['polygon'] for w in wells],direction=d,roi_xyxy=box)
    return result
