"""Opt-in research worker bridge; keeps the established measurement environment."""
import atexit
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
import uuid
import cv2
import numpy as np

_worker=None


def close_worker():
    global _worker
    if _worker is not None:
        if _worker.poll()is None:
            _worker.terminate()
            try:_worker.wait(timeout=3)
            except subprocess.TimeoutExpired:_worker.kill();_worker.wait()
        _worker=None


atexit.register(close_worker)


def locate(image,project,native_geometry=None):
    global _worker
    if os.environ.get('NODE_ENV')!='test' or os.environ.get('COLLOIDAL_OPEN_MODEL')not in('a','b','c','hybrid'):
        raise ValueError('Open model experiment is not enabled')
    if _worker is None or _worker.poll()is not None:
        script=Path(os.environ['COLLOIDAL_LEARNED_CODE'])/'open_geometry_worker.py'
        _worker=subprocess.Popen([os.environ['COLLOIDAL_OPEN_PYTHON'],str(script),'--round',os.environ['COLLOIDAL_OPEN_MODEL'],
            '--ocr',os.environ.get('COLLOIDAL_OPEN_OCR','v5')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,text=True,bufsize=1)
    wire=None
    if native_geometry is not None:
        wire={k:native_geometry[k]for k in ['ok','status','error','evidence']if k in native_geometry}
        if native_geometry['ok']:
            native=native_geometry;h,w=native['prepared'].shape[:2]
            inverse=native['crop_to_source']
            wire.update(quad_source=native['evidence']['card_polygon_source'],crop_size=[w,h],windows=native['windows'],
                windows_source=[cv2.perspectiveTransform(np.float32(p)[None],inverse)[0].tolist()for p in native['windows']],crop_to_source=inverse.tolist())
    with tempfile.TemporaryDirectory(prefix='card-model-')as folder:
        path=Path(folder)/'decoded.npy';np.save(path,image,allow_pickle=False);ident=str(uuid.uuid4())
        _worker.stdin.write(json.dumps(dict(id=ident,path=str(path),project=project.get('id'),native_geometry=wire))+'\n');_worker.stdin.flush()
        readable,_,_=select.select([_worker.stdout],[],[],20)
        if not readable:close_worker();raise TimeoutError('Local pretrained reader timed out')
        result=json.loads(_worker.stdout.readline())
        if result.get('id')!=ident or 'error'in result:
            reason=result.get('error','Mismatched worker response')
            close_worker();raise ValueError('Local pretrained reader: '+str(reason)[:240])
    result=result['result']
    if not result['ok']:return result
    if result.get('use_native_geometry'):
        if native_geometry is None or not native_geometry['ok']:raise ValueError('Missing native measurement geometry')
        return dict(native_geometry,evidence=result['evidence'])
    width,height=result['crop_size'];source=np.float32(result['quad_source'])
    transform=cv2.getPerspectiveTransform(source,np.float32([[0,0],[width-1,0],[width-1,height-1],[0,height-1]]))
    prepared=cv2.warpPerspective(image,transform,(width,height),borderValue=(255,255,255))
    # Source-space landmarks survive different OpenCV versions in the sidecar.
    windows=[cv2.perspectiveTransform(np.float32(p)[None],transform)[0].tolist()for p in result['windows_source']]
    return dict(ok=True,prepared=prepared,windows=windows,crop_to_source=np.linalg.inv(transform),evidence=result['evidence'])
