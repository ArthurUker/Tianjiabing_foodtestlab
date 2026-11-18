"""Direct original-pixel membrane sampling and independent line features.

No labels, assay result or human geometry enters these functions. Native C/T
intensity is retained, while learned classification is a separate output.
"""
import sys
import os
from pathlib import Path
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

ROOT=Path(__file__).resolve().parents[2]
CORE=Path(os.environ.get('COLLOIDAL_OPTICAL_CORE',ROOT/'.cache/colloidal-local-trial-20261022/recognizer/core'))
sys.path.insert(0,str(CORE))
from lab.reader_measurement import local_measure


def direct_window(image,quad):
    q=np.asarray(quad,np.float32)
    if q.shape!=(4,2) or not np.isfinite(q).all():raise ValueError('invalid window')
    if np.any(q[:,0]<0) or np.any(q[:,1]<0) or np.any(q[:,0]>=image.shape[1]) or np.any(q[:,1]>=image.shape[0]):
        raise ValueError('window outside original image')
    width=float((np.linalg.norm(q[1]-q[0])+np.linalg.norm(q[2]-q[3]))/2)
    height=float((np.linalg.norm(q[3]-q[0])+np.linalg.norm(q[2]-q[1]))/2)
    if width<9 or height<35:raise ValueError('insufficient ORIGINAL pixels')
    w,h=int(round(width)),int(round(height))
    m=cv2.getPerspectiveTransform(q,np.float32([[0,0],[w-1,0],[w-1,h-1],[0,h-1]]))
    full=cv2.warpPerspective(image,m,(w,h));ix=max(1,round(w*.12));iy=max(1,round(h*.08))
    window=cv2.transpose(full[iy:h-iy,ix:w-ix].copy())
    meta=dict(original_width=width,original_height=height,sampled_width=w,sampled_height=h,trim_x=ix,trim_y=iy,
        full_to_source=np.linalg.inv(m).tolist(),canonical_downsampling=False)
    return window,meta


def position_in_full_quad(position,meta):
    h=meta['sampled_height'];iy=meta['trim_y'];n=h-2*iy
    return (iy+float(position)*(n-1))/(h-1)


def legacy_sampling_meta(quad,source_shape):
    q=np.asarray(quad,float);width=(np.linalg.norm(q[1]-q[0])+np.linalg.norm(q[2]-q[3]))/2
    height=(np.linalg.norm(q[3]-q[0])+np.linalg.norm(q[2]-q[1]))/2
    native_scale=max(source_shape[1]/300,source_shape[0]/800);ratio=min(1,4/native_scale)
    w=max(9,round(width*ratio));h=max(35,round(height*ratio))
    return dict(sampled_width=w,sampled_height=h,trim_x=max(1,round(w*.12)),trim_y=max(1,round(h*.08)),source_ratio=ratio)


def measure_direct(image,quad,project):
    window,meta=direct_window(image,quad)
    try:
        m=local_measure(window,project)
        keep=['c','t','c_present','t_present','decision_quality','decision_reason','band_support','noise','background_level','positions','threshold','acquisition_quality']
        result={k:m.get(k) for k in keep};result['status']='ok'
        result['positions_native_crop']=result['positions']
        result['positions_quad']=[position_in_full_quad(p,meta) for p in result['positions']]
    except Exception as exc:result=dict(status='failed',error=f'{type(exc).__name__}: {exc}',c_present=None,t_present=None)
    return result,window,meta


def optical_features(window,native,meta,position_prior=None):
    pixels=window.astype(float);green=pixels[:,:,1];raw=np.median(green,axis=0)
    if raw.size<20:raise ValueError('insufficient effective samples')
    bg=gaussian_filter1d(raw,max(3,len(raw)/12));dark=bg-raw
    noise=max(.5,float(1.4826*np.median(np.abs(raw-gaussian_filter1d(raw,1)))))
    peaks=[];data=[]
    for low,high in [(.06,.46),(.52,.94)]:
        lo=max(1,int(low*len(raw)));hi=min(len(raw)-1,int(high*len(raw)))
        score=dark[lo:hi]
        if low>.5 and position_prior is not None:
            expected=peaks[0]+position_prior['ct_delta']
            positions=np.array([position_in_full_quad(k/(len(raw)-1),meta) for k in range(lo,hi)])
            score=np.maximum(score,0)*np.exp(-.5*((positions-expected)/position_prior['sigma'])**2)
        i=lo+int(np.argmax(score));radius=max(1,int(round(.02*len(raw))))
        center=green[:,max(0,i-radius//2):min(len(raw),i+radius//2+1)]
        left=green[:,max(0,i-5*radius):max(1,i-2*radius)]
        right=green[:,min(len(raw)-1,i+2*radius):min(len(raw),i+5*radius+1)]
        depth=np.minimum(np.median(left,axis=1),np.median(right,axis=1))-np.median(center,axis=1)
        red=pixels[:,:,2]-pixels[:,:,1]
        chroma=(pixels[:,:,0]+pixels[:,:,2])*.5-pixels[:,:,1]
        bands=[]
        for channel in [red,chroma]:
            mid=np.median(channel[:,max(0,i-radius//2):min(len(raw),i+radius//2+1)],axis=1)
            edge=np.maximum(np.median(channel[:,max(0,i-5*radius):max(1,i-2*radius)],axis=1),np.median(channel[:,min(len(raw)-1,i+2*radius):min(len(raw),i+5*radius+1)],axis=1))
            bands.append(mid-edge)
        peaks.append(position_in_full_quad(i/(len(raw)-1),meta))
        data.extend([float(dark[i]/noise),float(np.median(depth)/noise),float(np.mean(depth>=max(2,3*noise))),
            float(np.mean(depth>=max(1,1.5*noise))),float(np.median(bands[0])),float(np.median(bands[1])),float(np.mean((bands[0]>=2)&(bands[1]>=2)))])
    support=native.get('band_support') or {}
    def at(key,j):
        v=support.get(key) or [0,0]
        return float(v[j]) if len(v)>j else 0.
    values=data+[float(np.median(raw)/255),float(np.mean(raw>=253)),float(np.mean(raw<=2)),noise,
        float(native.get('c') or 0)/max(1,float(native.get('background_level') or 255)),
        float(native.get('t') or 0)/max(1,float(native.get('background_level') or 255)),
        float(native.get('t') or 0)/max(1,float(native.get('c') or 1)),
        at('transverse_coverage',1),at('weak_transverse_coverage',1),at('color_coverage',1),at('local_depth',1),
        float(native.get('status')=='ok'),float(native.get('t_present') is True),float(native.get('t_present') is None),
        np.log1p(meta['original_width']),np.log1p(meta['original_height'])]
    names=[f'{band}_{name}' for band in ['C','T'] for name in ['peak_snr','depth_snr','coverage','weak_coverage','red_depth','chroma_depth','color_coverage']]
    names+=['background','bright_fraction','dark_fraction','local_noise','native_c_relative','native_t_relative','native_tc_ratio',
        'native_t_coverage','native_t_weak_coverage','native_t_color_coverage','native_t_depth','native_available','native_t_present','native_t_unknown','log_width','log_height']
    x=np.asarray(values,float)
    if not np.isfinite(x).all():raise ValueError('non-finite optical evidence')
    return names,x.tolist(),dict(peak_positions_quad=peaks,profile_length=len(raw),source_pixels=meta,learned_position_prior=position_prior)
