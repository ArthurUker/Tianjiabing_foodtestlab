"""Opt-in local geometric experiment: ONNX regions -> native-pixel measurement.

The result cannot approve an assay. Business project context supplies identity;
image geometry independently validates card family and orientation.
No model dependency is imported when the explicit local experiment is disabled.
"""
import os
import sys
import cv2
import numpy as np

_locator=None
_fallback_locator=None
_selected_pipeline=None


def enabled():
    return os.environ.get('NODE_ENV')=='test' and os.environ.get('COLLOIDAL_LEARNED_EXPERIMENTAL')=='1'


def locate_for_measurement(image,project):
    global _locator,_fallback_locator,_selected_pipeline
    if not enabled():return None
    # Business requests already carry a resolved project. It is authoritative;
    # do not require OCR to confirm it. Legacy automatic-project experiments
    # with no project id remain separate, and can explicitly request legacy_ocr.
    source=os.environ.get('COLLOIDAL_PROJECT_SOURCE')
    business_context=isinstance(project,dict) and bool(project.get('id'))
    if source=='selected' or (source in (None,'') and business_context):
        if _selected_pipeline is None:
            sys.path.insert(0,os.environ['COLLOIDAL_LEARNED_CODE'])
            from selected_project_pipeline import SelectedProjectPipeline
            _selected_pipeline=SelectedProjectPipeline(os.environ['COLLOIDAL_LEARNED_MODEL'],
                os.environ.get('COLLOIDAL_LEARNED_FALLBACK_MODEL'))
        return _selected_pipeline.locate(image,project)
    if os.environ.get('COLLOIDAL_OPEN_MODEL')in('a','b','c','hybrid'):
        from open_model_bridge import locate
        native=_locate_cached(image,None)if os.environ.get('COLLOIDAL_OPEN_MODEL')=='hybrid'else None
        return locate(image,project,native_geometry=native)
    return _locate_cached(image,project)


def _locate_cached(image,project):
    global _locator,_fallback_locator
    if _locator is None:
        _locator=_load_locator(os.environ['COLLOIDAL_LEARNED_MODEL'])
    primary=_locate_with_locator(image,project,_locator)
    # A selected-project mismatch must never trigger model shopping. Only an
    # unavailable geometric solution can request an independently gated backup.
    fallback=os.environ.get('COLLOIDAL_LEARNED_FALLBACK_MODEL')
    if project is None and primary['evidence'].get('complete_candidate_count',0)>1:return primary
    if primary['ok'] or primary['status']!='localization_failed' or not fallback:
        return primary
    if _fallback_locator is None:_fallback_locator=_load_locator(fallback)
    backup=_locate_with_locator(image,project,_fallback_locator)
    if backup['ok']:
        backup['evidence'].update(fallback_used=True,
            primary_model_version=primary['evidence']['version'],
            primary_model_run=primary['evidence']['model_run'],
            primary_failure_reason=primary['error'],
            model_selection='primary localization failed; backup passed identical geometric gates')
        return backup
    primary['evidence']['fallback_attempt']=dict(version=backup['evidence']['version'],
        model_run=backup['evidence']['model_run'],status=backup['status'],reason=backup['error'])
    return primary


def _load_locator(path):
    sys.path.insert(0,os.environ['COLLOIDAL_LEARNED_CODE'])
    from infer import Locator
    locator=Locator(path,allow_experimental=True)
    if locator.metadata['classes']!=['card','membrane','sample_well']:
        raise ValueError('Unmarked-card measurement requires a sample-well model')
    return locator


def _local_rotated_rect(points, down):
    """Per-window rectangle along its own long axis; polarity follows card down.

    Experimental window variant (COLLOIDAL_WINDOW_VARIANT=v3). Default code path
    below is unchanged when the variable is unset.
    """
    p = np.asarray(points, np.float64)
    edges = [p[(i + 1) % 4] - p[i] for i in range(4)]
    lengths = [float(np.linalg.norm(e)) for e in edges]
    axis = edges[int(np.argmax(lengths))]
    axis = axis / max(float(np.linalg.norm(axis)), 1e-9)
    if float(axis @ np.asarray(down, np.float64)) < 0:
        axis = -axis
    right = np.asarray([axis[1], -axis[0]], np.float64)
    x, y = p @ right, p @ axis
    return np.float32([right * x.min() + axis * y.min(), right * x.max() + axis * y.min(),
                       right * x.max() + axis * y.max(), right * x.min() + axis * y.max()])


def _locate_with_locator(image,project,locator):
    prediction=locator.locate(cv2.cvtColor(image,cv2.COLOR_BGR2RGB))
    model_run=getattr(locator,'metadata',{}).get('run','prototype-v2-bg')
    experimental_patch='ai3' if model_run=='prototype-v3-hard' else 'ai2'
    evidence=dict(locator='onnx-card-membrane-well-v'+experimental_patch[2:],version=prediction['model_sha256'],
                  model_run=model_run,experimental_patch=experimental_patch,
                  coordinate_space='exif_corrected_original_pixels',
                  identity_check='selected_project_only_not_OCR_verified',
                  decision_role='experimental_geometry_only',profile_validation='development_only')
    if os.environ.get('COLLOIDAL_TRACE_ALL_CANDIDATES')=='1':
        def _candidate_reasons(c):
            reasons=[]
            if c.get('truncated'): reasons.append('truncated')
            if c.get('orientation')!='verified_from_well_geometry': reasons.append('orientation')
            if c.get('observed_window_count') not in (1,3): reasons.append('window_count')
            if len(c.get('sample_wells') or [])!=c.get('observed_window_count'): reasons.append('well_pairing')
            if c.get('quality_failed'): reasons.append('quality_failed')
            return reasons
        evidence['all_card_instances']=[dict(
            truncated=c.get('truncated'),orientation=c.get('orientation'),
            observed_window_count=c.get('observed_window_count'),
            well_count=len(c.get('sample_wells') or []),
            wells=[w.get('polygon') for w in (c.get('sample_wells') or [])],
            card_polygon=(c.get('card') or {}).get('polygon'),
            windows=[w.get('polygon') for w in (c.get('windows') or [])],
            direction=c.get('direction'),card_score=(c.get('card') or {}).get('score'),
            reasons=_candidate_reasons(c))
            for c in prediction['card_instances']]
        evidence['candidate_cache_note']='post-filter candidate list; pre-NMS components are not exposed'
    candidates=[c for c in prediction['card_instances'] if not c['truncated'] and c['orientation']=='verified_from_well_geometry']
    evidence['complete_candidate_count']=len(candidates)
    if len(candidates)!=1:
        evidence['reason']='AI未取得唯一、完整且方向可靠的卡片/膜窗/加样孔组合'
        evidence['count']=len(prediction['card_instances'])
        evidence['candidate_structures']=[dict(windows=c['observed_window_count'],
            wells=len(c.get('sample_wells',[])),truncated=c['truncated'],
            direction_reason=c.get('direction',{}).get('reason'))for c in prediction['card_instances']]
        if len(prediction['card_instances'])==1:
            c=prediction['card_instances'][0]
            evidence['reason']+=f"（膜窗{c['observed_window_count']}个、加样孔{len(c.get('sample_wells',[]))}个；{c.get('direction',{}).get('reason','方向不可靠')}）"
        return dict(ok=False,status='localization_failed',error=evidence['reason'],evidence=evidence)
    candidate=candidates[0]
    if project is not None and candidate['observed_window_count']!=len(project['channels']):
        reason=f"AI观察到{candidate['observed_window_count']}个膜窗，所选项目需要{len(project['channels'])}个，请核对项目与卡片"
        return dict(ok=False,status='structure_mismatch',error=reason,evidence=dict(evidence,reason=reason))
    direction=candidate['direction'];down=np.array(direction['down']);right=np.array(direction['right'])
    shell=np.array(candidate['card']['polygon']);horizontal=shell@right;vertical=shell@down
    xmin,xmax=horizontal.min(),horizontal.max();ymin,ymax=vertical.min(),vertical.max()
    source=np.float32([right*xmin+down*ymin,right*xmax+down*ymin,right*xmax+down*ymax,right*xmin+down*ymax])
    width,height=int(round(xmax-xmin)),int(round(ymax-ymin))
    if min(width,height)<80:
        return dict(ok=False,status='quality_failed',error='AI卡片区域原生分辨率不足',evidence=evidence)
    transform=cv2.getPerspectiveTransform(source,np.float32([[0,0],[width-1,0],[width-1,height-1],[0,height-1]]))
    prepared=cv2.warpPerspective(image,transform,(width,height),borderValue=(255,255,255))
    variant=os.environ.get('COLLOIDAL_WINDOW_VARIANT') or 'v1_uniform_axis'
    windows=[]
    for item in candidate['windows']:
        points=np.array(item['polygon'])
        if variant=='v3':
            quad=_local_rotated_rect(points,down)
        else:
            xx,yy=points@right,points@down
            quad=np.float32([right*xx.min()+down*yy.min(),right*xx.max()+down*yy.min(),right*xx.max()+down*yy.max(),right*xx.min()+down*yy.max()])
        local=cv2.perspectiveTransform(quad[None],transform)[0]
        if (local[:,0]<0).any() or (local[:,1]<0).any() or (local[:,0]>=width).any() or (local[:,1]>=height).any():
            return dict(ok=False,status='quality_failed',error='AI膜窗越出完整卡片范围',evidence=evidence)
        windows.append(local.tolist())
    evidence.update(card_polygon_source=source.tolist(),direction_basis='AI膜窗至独立加样孔的几何方向',
                    sample_port_support=[True]*len(candidate['sample_wells']),
                    geometry_score=float(min(w['score']for w in candidate['windows'])),
                    window_variant=variant,
                    note='无定位板实验；只提供原图几何和测量证据，不批准业务判读')
    return dict(ok=True,prepared=prepared,windows=windows,crop_to_source=np.linalg.inv(transform),evidence=evidence)
