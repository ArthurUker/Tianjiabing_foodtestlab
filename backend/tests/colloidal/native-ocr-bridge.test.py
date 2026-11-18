"""OCR approval reuses original prepared pixels/windows without rewarping."""
import io,json,os,sys,unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
ROOT=Path(__file__).resolve().parents[3];sys.path.insert(0,str(ROOT/'backend/recognizer'))
import open_model_bridge as bridge


class NativeBridgeTests(unittest.TestCase):
    def test_ocr_success_returns_the_exact_native_measurement_objects(self):
        class Worker:
            def __init__(self):self.stdin=self;self.stdout=self
            def poll(self):return None
            def write(self,line):self.job=json.loads(line)
            def flush(self):pass
            def readline(self):return json.dumps(dict(id=self.job['id'],result=dict(ok=True,use_native_geometry=True,evidence={'observed_project':'carbofuran'})))+'\n'
        worker=Worker();pixels=np.arange(120*80*3,dtype=np.uint8).reshape(120,80,3)
        windows=[[[10,20],[20,20],[20,70],[10,70]]];inverse=np.eye(3)
        native=dict(ok=True,prepared=pixels,windows=windows,crop_to_source=inverse,evidence={'card_polygon_source':[[0,0],[79,0],[79,119],[0,119]]})
        with patch.dict(os.environ,{'NODE_ENV':'test','COLLOIDAL_OPEN_MODEL':'hybrid'}),patch.object(bridge,'_worker',worker),patch.object(bridge.select,'select',return_value=([worker.stdout],[],[])):
            result=bridge.locate(pixels,{'id':'carbofuran'},native_geometry=native)
        self.assertIs(result['prepared'],pixels);self.assertIs(result['windows'],windows);self.assertIs(result['crop_to_source'],inverse)
        self.assertEqual(result['evidence']['observed_project'],'carbofuran')
        self.assertNotIn('prepared',worker.job['native_geometry'])


if __name__=='__main__':unittest.main()
