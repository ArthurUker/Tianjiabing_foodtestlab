"""Source-pixel and direction checks for the opt-in learned experiment."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts/colloidal_ai'))
sys.path.insert(0,str(ROOT/'backend/recognizer'))
from geometry_gate import direction_from_wells
import learned_locator


def region(x,y):
    return dict(polygon=[[x-4,y-20],[x+4,y-20],[x+4,y+20],[x-4,y+20]],score=.9,model_pixels=320)


class LearnedGeometryTests(unittest.TestCase):
    def test_direction_and_channel_order_survive_all_quarter_rotations(self):
        for angle in [0,90,180,270]:
            a=np.deg2rad(angle);rotation=np.array([[np.cos(a),-np.sin(a)],[np.sin(a),np.cos(a)]])
            windows=[region(x,60)for x in [30,60,90]];wells=[region(x,130)for x in [30,60,90]]
            for r in windows+wells:r['polygon']=(np.array(r['polygon'])@rotation.T+[300,300]).tolist()
            d=direction_from_wells(windows[::-1],wells)
            self.assertEqual(d['status'],'verified_from_well_geometry')
            self.assertEqual(d['window_order'],[2,1,0])

    def test_window_fragments_and_missing_wells_do_not_confirm_direction(self):
        self.assertEqual(direction_from_wells([region(30,60)],[])['status'],'unverified')
        windows=[region(30,60),region(31,60),region(32,60)]
        self.assertEqual(direction_from_wells(windows,[region(x,130)for x in [30,31,32]])['status'],'unverified')

    def test_native_card_transform_preserves_order_without_marker_board(self):
        windows=[region(x,60)for x in [30,60,90]];wells=[region(x,130)for x in [30,60,90]]
        direction=direction_from_wells(windows,wells)
        card=dict(truncated=False,orientation=direction['status'],direction=direction,observed_window_count=3,
                  windows=windows,sample_wells=wells,card=dict(polygon=[[10,10],[110,10],[110,190],[10,190]],score=.9))
        class Fake:
            def locate(self,_):return dict(card_instances=[card],model_sha256='a'*64)
        with patch.dict(os.environ,{'NODE_ENV':'test','COLLOIDAL_LEARNED_EXPERIMENTAL':'1'}),patch.object(learned_locator,'_locator',Fake()):
            result=learned_locator.locate_for_measurement(np.zeros((220,150,3),np.uint8),{'channels':[{}, {}, {}]})
        self.assertTrue(result['ok']);self.assertEqual(result['prepared'].shape[:2],(180,100))
        centers=np.asarray(result['windows']).mean(1)
        self.assertTrue(np.all(np.diff(centers[:,0])>0))

    def test_disabled_experiment_does_not_infer(self):
        with patch.dict(os.environ,{'NODE_ENV':'production','COLLOIDAL_LEARNED_EXPERIMENTAL':'1'}):
            self.assertIsNone(learned_locator.locate_for_measurement(None,None))

    def test_v3_rejection_keeps_model_identity_and_actual_region_counts(self):
        class Incomplete:
            metadata={'run':'prototype-v3-hard'}
            def locate(self,_):
                return dict(model_sha256='b'*64,card_instances=[dict(truncated=False,
                    orientation='unverified',observed_window_count=3,sample_wells=[{}],
                    direction={'reason':'膜窗/加样孔数量不完整或不一致'})])
        with patch.dict(os.environ,{'NODE_ENV':'test','COLLOIDAL_LEARNED_EXPERIMENTAL':'1'}),patch.object(learned_locator,'_locator',Incomplete()):
            result=learned_locator.locate_for_measurement(np.zeros((220,150,3),np.uint8),{'channels':[{}, {}, {}]})
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'],'localization_failed')
        self.assertEqual(result['evidence']['experimental_patch'],'ai3')
        self.assertIn('膜窗3个、加样孔1个',result['error'])

    def test_backup_recovers_geometry_but_never_shops_for_project_shape(self):
        windows=[region(x,60)for x in [30,60,90]];wells=[region(x,130)for x in [30,60,90]]
        direction=direction_from_wells(windows,wells)
        card=dict(truncated=False,orientation=direction['status'],direction=direction,
            observed_window_count=3,windows=windows,sample_wells=wells,
            card=dict(polygon=[[10,10],[110,10],[110,190],[10,190]],score=.9))
        class Missing:
            metadata={'run':'prototype-v3-hard'}
            def locate(self,_):return dict(card_instances=[],model_sha256='b'*64)
        class Good:
            metadata={'run':'prototype-v2-bg'}
            calls=0
            def locate(self,_):
                self.calls+=1
                return dict(card_instances=[card],model_sha256='a'*64)
        image=np.zeros((220,150,3),np.uint8);backup=Good()
        env={'NODE_ENV':'test','COLLOIDAL_LEARNED_EXPERIMENTAL':'1','COLLOIDAL_LEARNED_FALLBACK_MODEL':'explicit-test-model'}
        with patch.dict(os.environ,env),patch.object(learned_locator,'_locator',Missing()),patch.object(learned_locator,'_fallback_locator',backup):
            result=learned_locator.locate_for_measurement(image,{'channels':[{}, {}, {}]})
        self.assertTrue(result['ok']);self.assertTrue(result['evidence']['fallback_used'])
        self.assertEqual(result['evidence']['version'],'a'*64)
        self.assertEqual(result['evidence']['primary_model_version'],'b'*64)
        backup.calls=0
        with patch.dict(os.environ,env),patch.object(learned_locator,'_locator',Good()),patch.object(learned_locator,'_fallback_locator',backup):
            result=learned_locator.locate_for_measurement(image,{'channels':[{}]})
        self.assertFalse(result['ok']);self.assertEqual(result['status'],'structure_mismatch')
        self.assertEqual(backup.calls,0)


if __name__=='__main__':unittest.main()
