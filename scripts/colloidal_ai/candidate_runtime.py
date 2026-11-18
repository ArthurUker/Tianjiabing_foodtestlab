"""Versioned, annotation-free D1 reader. Business project is an explicit input."""
import argparse,hashlib,json,os,sys,time
from pathlib import Path
import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image,ImageOps
from infer import Locator
from candidate_geometry import geometry


def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def learned_probability(model,values):
    x=np.asarray(values)[model['feature_indices']]
    z=np.clip((x-np.asarray(model['mean']))/model['scale'],-8,8)
    logit=float(z@np.asarray(model['coef'])+model['intercept'])
    return float(1/(1+np.exp(-np.clip(logit,-700,700))))


def channel_rule(native,project,t_present,elapsed,classify):
    # Uncertain acquisition / C must not silently become absence or invalidity.
    if native.get('status')!='ok' or native.get('decision_quality')!='measurable' or native.get('c_present') is None or t_present is None:
        return dict(image_result=None,final_result=None,rule_status='unmeasurable')
    tolerance=max(2*float(native.get('noise') or 0),.03*max(native['c'],native['t']))
    return classify(native['c'],native['t'],native['c_present'],elapsed,method=project['rule_method'],
        t_present=t_present,read_window=project.get('read_window'),tolerance=tolerance)


def key_region_evidence(geometry_result, shape):
    direction = geometry_result['direction']
    windows = geometry_result['windows']
    if direction.get('status') != 'verified_from_well_geometry':
        return dict(status='unverified', reason=direction.get('reason', 'direction_unverified'))
    indices = direction.get('well_indices', [])
    wells = geometry_result['wells']
    if len(indices) != len(windows) or len(set(indices)) != len(windows) or any(
        index < 0 or index >= len(wells) for index in indices
    ):
        return dict(status='unverified', reason='required_well_pairs_unverified')
    for name, polygons in (('window', windows), ('well', [wells[index] for index in indices])):
        for polygon in polygons:
            points = np.asarray(polygon, dtype=float)
            if (points.shape != (4, 2) or not np.isfinite(points).all() or
                    np.any(points < 0) or np.any(points >= np.array([shape[1], shape[0]]))):
                return dict(status='unverified', reason=f'{name}_outside_original')
    return dict(status='localized', reason='window_and_well_pairs_in_frame')


class CandidateReader:
    def __init__(self,bundle):
        self.bundle=Path(bundle).resolve();self.manifest=json.loads((self.bundle/'bundle.json').read_text())
        for name,expected in self.manifest['files'].items():
            if digest(self.bundle/name)!=expected:raise ValueError('bundle hash mismatch: '+name)
        os.environ['COLLOIDAL_OPTICAL_CORE']=str(self.bundle/'core')
        sys.path.insert(0,str(self.bundle/'core'))
        from original_band_sampling import measure_direct,optical_features
        from lab.rules import classify
        self.measure=measure_direct;self.features=optical_features;self.classify=classify
        self.projects={p['id']:p for p in json.loads((self.bundle/'projects.json').read_text())['projects']}
        self.primary=Locator(self.bundle/'weights/card.onnx',allow_experimental=True)
        options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        self.roi=ort.InferenceSession(str(self.bundle/'weights/roi.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
        self.refiner=ort.InferenceSession(str(self.bundle/'weights/refiner.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
        self.visibility=json.loads((self.bundle/'weights/visibility.json').read_text())

    def inspect(self,image,project_id=None,elapsed_seconds=None):
        started=time.perf_counter()
        if not isinstance(image,np.ndarray) or image.ndim!=3 or image.shape[2]!=3:raise ValueError('RGB image required')
        if project_id is not None and project_id not in self.projects:raise ValueError('unknown selected project')
        project=self.projects.get(project_id)
        result=dict(schema_version=1,bundle_id=self.manifest['id'],production_approved=False,
            selected_project_id=project_id,project_identity_source='business_selection' if project else 'unknown_family_probe',
            original_size=[image.shape[1],image.shape[0]],coordinate_space='EXIF corrected original pixels',
            human_geometry_used=False,ocr_project_used=False,board_used=False,channels=[],final_result=None,
            independent_acceptance=False)
        g=geometry(image,self.primary,self.roi,self.refiner);result['geometry']=g;result['status']=g['status']
        regions=key_region_evidence(g,image.shape)
        result['key_regions']=regions
        if g['status']=='geometry_ready' and regions['status']!='localized':
            result.update(status='key_regions_unverified',error='未能确认识别窗和加样口，请露出这些区域后重拍')
        if result['status']=='geometry_ready':
            count=len(g['windows'])
            if project and len(project['channels'])!=count:
                result.update(status='structure_mismatch',error='所选项目的窗数与照片不一致，请核对单检/三联卡')
            else:
                # Family probe selects only an optical profile. It never infers
                # project identity or permits assay interpretation.
                optical=dict(project or self.projects['carbofuran' if count==1 else 'lean_meat_triplex'],band_evidence_mode='spatial')
                bgr=cv2.cvtColor(image,cv2.COLOR_RGB2BGR)
                for j,quad in enumerate(g['windows']):
                    ch=dict(index=j+1,status='unavailable',image_result=None,final_result=None)
                    if project:ch.update(project['channels'][j])
                    try:
                        native,window,meta=self.measure(bgr,quad,optical)
                        names,x,photo=self.features(window,native,meta,self.visibility.get('position_prior'))
                        if [names[i] for i in self.visibility['feature_indices']]!=self.visibility['feature_names']:raise ValueError('feature contract mismatch')
                        p=learned_probability(self.visibility,x)
                        observable=native.get('decision_quality')=='measurable' and native.get('c_present') is not None
                        ch.update(status=('measured' if observable else 'quality_unverified') if native.get('status')=='ok' else 'measurement_failed',
                            measurement=native,source_sampling=meta,t_visible=p>=self.visibility['threshold'] if observable else None,
                            t_visibility_score=p,score_is_calibrated_probability=False,
                            learned_peak_positions_quad=photo['peak_positions_quad'])
                        if project:
                            preview=channel_rule(native,optical,ch['t_visible'],elapsed_seconds,self.classify)
                            preview['rule_final_preview']=preview.get('final_result')
                            preview['final_result']=None
                            ch.update(preview)
                        else:ch['rule_status']='project_not_selected'
                    except Exception as exc:ch.update(status='quality_failed',error=f'{type(exc).__name__}: {exc}',rule_status='unmeasurable')
                    result['channels'].append(ch)
                result['status']='measured' if all(c['status']=='measured' for c in result['channels']) else 'partial_measurement'
        result['elapsed_ms']=round((time.perf_counter()-started)*1000,2)
        result['decision_scope']='研发图像解释；独立实体卡和强度校准验收未完成，不批准业务合格结论'
        return result


def read_image(path):
    with Image.open(path) as im:return np.asarray(ImageOps.exif_transpose(im).convert('RGB'))


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--bundle',required=True,type=Path)
    ap.add_argument('--image',required=True,type=Path);ap.add_argument('--project');ap.add_argument('--elapsed',type=float)
    ap.add_argument('--output',type=Path);a=ap.parse_args()
    r=CandidateReader(a.bundle).inspect(read_image(a.image),a.project,a.elapsed);r['photo_sha256']=digest(a.image)
    text=json.dumps(r,ensure_ascii=False,indent=2,allow_nan=False)
    if a.output:a.output.write_text(text+'\n')
    print(text)

if __name__=='__main__':main()
