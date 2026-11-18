"""Explicit unmarked mode cannot consult marker geometry on either outcome."""
import io,json,os,sys,unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import numpy as np
ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'.cache/colloidal-local-trial-20261022/recognizer/core'))
sys.path.insert(0,str(ROOT/'backend/recognizer'))
import server_entry


class StrictUnmarkedTests(unittest.TestCase):
    def test_no_marker_access_on_rejection_or_success(self):
        image=io.BytesIO();Image.new('RGB',(200,400),'white').save(image,format='PNG')
        env={'NODE_ENV':'test','COLLOIDAL_LEARNED_EXPERIMENTAL':'1','COLLOIDAL_STRICT_UNMARKED':'1'}
        evidence=dict(experimental_patch='ai4',locator='test-pose',version='c'*64)
        for ok in [False,True]:
            geometry=dict(ok=ok,evidence=evidence,status='localization_failed',error='test reject')
            if ok:geometry.update(prepared=np.zeros((400,200,3),np.uint8),windows=[[[50,120],[70,120],[70,220],[50,220]]],crop_to_source=np.eye(3))
            def measured(*args,**kwargs):return dict(status='ok',version='test-core',elapsed_ms=1.,channels=[])
            with patch.dict(os.environ,env),patch.object(server_entry,'board_frame',side_effect=AssertionError('marker access')),patch.object(server_entry,'locate_for_measurement',return_value=geometry),patch.object(server_entry,'recognize',side_effect=measured):
                result=json.loads(server_entry.recognize_original(image.getvalue(),'carbofuran','null','auto'))
            self.assertNotEqual(result['status'],'engine_error')
            self.assertEqual(result['status'],'partial'if ok else'localization_failed')
            if ok:self.assertTrue(result['core_patch'].endswith('+ai4'))

    def test_native_learned_card_quad_is_not_transformed_twice(self):
        quad=[[100.,200.],[200.,200.],[200.,400.],[100.,400.]]
        events=[dict(stage='card_geometry',details=dict(card_polygon_source=quad)),
                dict(stage='localization',details=dict(window_polygons_source=[[[1.,2.],[3.,2.],[3.,4.],[1.,4.]]]))]
        transform=np.float64([[2.,0.,10.],[0.,3.,20.],[0.,0.,1.]])
        server_entry.original_coordinates(events,transform,skip_native_card=True)
        self.assertEqual(events[0]['details']['card_polygon_source'],quad)
        self.assertEqual(events[1]['details']['window_polygons_source'][0][0],[12.,26.])


if __name__=='__main__':unittest.main()
