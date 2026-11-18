"""Independent negative controls for color proposals and spatial band checks."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import cv2
import numpy as np

spec = importlib.util.spec_from_file_location('card_tests', Path(__file__).with_name('card-geometry.test.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
from membrane_geometry import locate_membranes
from lab.reader_config import get_project
from lab.reader_measurement import local_measure
from lab.reader_geometry import ReaderFailure
from lab.reader import recognize


def card(missing_c=False, ports=True):
    image = helpers.board_crop()
    for i, x in enumerate((340, 450, 560)):
        if not (missing_c and i == 1):
            cv2.line(image, (x-16, 370), (x+16, 370), (140, 120, 160), 4)
        cv2.line(image, (x-16, 435), (x+16, 435), (155, 140, 175), 4)
        if ports:
            cv2.circle(image, (x, 665), 40, (215,)*3, -1)
            cv2.ellipse(image, (x, 665), (15, 28), 0, 0, 360, (160,)*3, -1)
    return image


def window(c=True, t=True, early=False, clipped=False, spot=False):
    x = np.linspace(0, 1, 240)
    values = np.full((40, 240), 255. if clipped else 230.)
    if c:
        dip = 65*np.exp(-.5*((x-(.08 if early else .28))/.018)**2)
        if spot:
            values[:5] -= dip
        else:
            values -= dip
    if t:
        values -= 35*np.exp(-.5*((x-.72)/.022)**2)
    return np.repeat(values[:,:,None],3,axis=2).clip(0,255).astype('uint8')


class VisualFeatureRegression(unittest.TestCase):
    def test_registration_needs_apertures_and_sample_ports(self):
        result = locate_membranes(card(), 10., 3)
        self.assertIsNotNone(result)
        centers = np.asarray(result[0]).mean(1)
        np.testing.assert_allclose(centers[:,0], [340,450,560], atol=5.)
        self.assertIsNone(locate_membranes(card(ports=False), 10., 3))
        self.assertIsNone(locate_membranes(card(), 10., 1))

    def test_missing_middle_c_is_never_invented_from_t(self):
        image = card(missing_c=True)
        result = locate_membranes(image, 10., 3)
        self.assertIsNotNone(result)
        project = get_project('lean_meat_triplex')
        project['band_evidence_mode'] = 'spatial'
        with tempfile.TemporaryDirectory() as directory:
            observed = recognize(image, project, None, directory, 'closeup', fixed_windows=result[0])
        self.assertEqual(len(observed['channels']), 3)
        self.assertFalse(observed['channels'][1]['measurement']['c_present'])
        self.assertEqual(observed['channels'][1]['image_result'], 'invalid')

    def test_color_and_printed_lines_without_a_window_are_rejected(self):
        image = np.full((870,900,3),230,np.uint8)
        for x in (340,450,560):
            for y in (370,435):
                cv2.line(image,(x-16,y),(x+16,y),(140,120,160),4)
        self.assertIsNone(locate_membranes(image,10.,3))

    def test_early_c_and_transverse_continuity(self):
        project = dict(get_project('carbofuran'),band_evidence_mode='spatial')
        measured = local_measure(window(early=True),project)
        self.assertTrue(measured['c_present'] and measured['t_present'])
        self.assertLess(measured['positions'][0],.15)
        spot = local_measure(window(spot=True,t=False),project)
        self.assertFalse(spot['c_present'])
        ramp = np.tile(np.linspace(190,235,240),(40,1))
        plain = local_measure(np.repeat(ramp[:,:,None],3,2).astype('uint8'),project)
        self.assertFalse(plain['c_present'] or plain['t_present'])

    def test_weak_continuous_band_does_not_become_absence(self):
        project = dict(get_project('lean_meat_triplex'),band_evidence_mode='spatial')
        image = window(t=False).astype(float)
        x = np.linspace(0,1,240)
        image -= 3.5*np.exp(-.5*((x-.72)/.022)**2)[None,:,None]
        measured = local_measure(image.clip(0,255).astype('uint8'),project)
        self.assertTrue(measured['c_present'])
        self.assertIsNone(measured['t_present'])
        self.assertEqual(measured['decision_quality'],'unobservable')
        self.assertEqual(measured['decision_reason'],'weak_continuous_band')

    def test_weak_colored_transverse_band_has_independent_color_evidence(self):
        project = dict(get_project('lean_meat_triplex'),band_evidence_mode='spatial')
        image = window(t=False).astype(float)
        x = np.linspace(0,1,240)
        dip = np.exp(-.5*((x-.72)/.022)**2)[None,:]
        image[:,:,1] -= 3.5*dip
        image[:,:,0] -= .5*dip
        measured = local_measure(image.clip(0,255).astype('uint8'),project)
        self.assertTrue(measured['c_present'] and measured['t_present'])
        self.assertEqual(measured['decision_quality'],'measurable')
        self.assertGreaterEqual(measured['band_support']['color_coverage'][1],.6)

    def test_weak_blue_mark_is_not_promoted_to_red_band(self):
        project = dict(get_project('lean_meat_triplex'),band_evidence_mode='spatial')
        image = window(t=False).astype(float)
        x = np.linspace(0,1,240)
        dip = np.exp(-.5*((x-.72)/.022)**2)[None,:]
        image[:,:,1] -= 3.5*dip
        image[:,:,2] -= 7*dip
        image[:,:,0] += 4*dip
        measured = local_measure(image.clip(0,255).astype('uint8'),project)
        self.assertIsNot(measured['t_present'], True)
        self.assertEqual(measured['decision_quality'],'unobservable')

    def test_clipped_missing_t_retains_c_but_refuses_interpretation(self):
        project = dict(get_project('lean_meat_triplex'),band_evidence_mode='spatial')
        measured = local_measure(window(t=False,clipped=True),project)
        self.assertTrue(measured['c_present'])
        self.assertIsNone(measured['t_present'])
        self.assertEqual(measured['decision_quality'],'unobservable')
        missing_c = local_measure(window(c=False,clipped=True),project)
        self.assertIsNone(missing_c['c_present'])
        self.assertEqual(missing_c['decision_quality'],'unobservable')


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        helpers.CORE.cleanup()
