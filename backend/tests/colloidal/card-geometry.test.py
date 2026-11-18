"""Geometry, clipped-presence safety and coordinate regression; no user photos."""
import hashlib
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CORE = tempfile.TemporaryDirectory(prefix='colloidal-core-test-')
bundle = json.loads((ROOT/'frontend/vendor/colloidal/core.json').read_text())
for name, source in bundle['files'].items():
    assert hashlib.sha256(source.encode()).hexdigest() == bundle['hashes'][name]
    target = Path(CORE.name)/name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source)
sys.path[:0] = [CORE.name, str(ROOT/'backend/recognizer')]
from card_geometry import locate_triplex
from lab.reader_config import get_project
from lab.reader_measurement import local_measure
from lab.reader_geometry import ReaderFailure
from server_entry import original_coordinates
from process_log import ProcessLog


def board_crop(round_shell=True, bands=False):
    im = np.full((870, 900, 3), 205, np.uint8)
    if round_shell:
        cv2.rectangle(im, (250+70, 80), (650-70, 780), (242,)*3, -1)
        cv2.rectangle(im, (250, 80+70), (650, 780-70), (242,)*3, -1)
        for x in (320, 580):
            for y in (150, 710):
                cv2.circle(im, (x, y), 70, (242,)*3, -1)
    else:
        cv2.rectangle(im, (250, 80), (650, 780), (242,)*3, -1)
    for x in (340, 450, 560):
        cv2.rectangle(im, (x-20, 325), (x+20, 495), (180,)*3, -1)
        cv2.rectangle(im, (x-17, 328), (x+17, 492), (230,)*3, -1)
        if bands:
            for y in (370, 435):
                cv2.line(im, (x-16, y), (x+16, y), (140, 120, 160), 3)
    return im


def profile(c=True, t=True):
    x = np.linspace(0, 1, 240)
    raw = np.full_like(x, 255.)
    if c:
        raw -= 70*np.exp(-.5*((x-.3)/.025)**2)
    if t:
        raw -= 35*np.exp(-.5*((x-.65)/.025)**2)
    return np.repeat(raw[None, :, None], 30, axis=0).repeat(3, axis=2).clip(0, 255).astype('uint8')


class CardGeometryRegression(unittest.TestCase):
    def test_window_geometry_does_not_depend_on_biological_bands(self):
        absent = locate_triplex(board_crop(), 10.)
        visible = locate_triplex(board_crop(bands=True), 10.)
        self.assertIsNotNone(absent)
        self.assertIsNotNone(visible)
        np.testing.assert_allclose(absent[0], visible[0], atol=1.)
        for offset in (0, -8, 8):
            matrix = cv2.getRotationMatrix2D((450, 435), offset, 1.)
            im = cv2.warpAffine(board_crop(), matrix, (900, 870), borderValue=(205,)*3)
            result = locate_triplex(im, 10.)
            self.assertIsNotNone(result)

    def test_blank_paper_rectangle_and_truncated_shell_are_not_shell_evidence(self):
        self.assertIsNone(locate_triplex(np.full((870, 900, 3), 240, np.uint8), 10.))
        self.assertIsNone(locate_triplex(board_crop(round_shell=False), 10.))
        self.assertIsNone(locate_triplex(board_crop()[100:700], 10.))

    def test_clipped_background_never_establishes_missing_band(self):
        project = get_project('lean_meat_triplex')
        for c, t in ((False, False), (True, False), (False, True)):
            with self.subTest(c=c, t=t):
                measured = local_measure(profile(c, t), project)
                self.assertEqual(measured['decision_quality'], 'unobservable')
                self.assertIsNone(measured['c_present'] if not c else measured['t_present'])
        measured = local_measure(profile(), project)
        self.assertTrue(measured['c_present'] and measured['t_present'])
        self.assertEqual(measured['acquisition_quality']['status'], 'both_bands_visible_on_clipped_background')
        with self.assertRaises(ReaderFailure):
            local_measure(profile(), get_project('carbofuran'))

    def test_crop_mapping_preserves_original_coordinates_and_slot_coordinates(self):
        transform = np.float64([[2., 0., 10.], [0., 3., 20.], [0., 0., 1.]])
        event = dict(details=dict(coordinate_space='triplex_crop_pixels',
            window_polygons_source=[[[1., 2.], [3., 2.], [3., 4.], [1., 4.]]],
            measurement_lines_source=[dict(label='C', points=[[1., 2.], [3., 2.]])],
            polygons_slot=[[[1., 2.]]]))
        original_coordinates([event], transform)
        self.assertEqual(event['details']['measurement_lines_source'][0]['points'], [[12., 26.], [16., 26.]])
        self.assertEqual(event['details']['polygons_slot'], [[[1., 2.]]])
        self.assertEqual(event['details']['coordinate_space'], 'exif_corrected_original_pixels')

    def test_retry_resets_measurement_channel_index(self):
        trace = ProcessLog(get_project('lean_meat_triplex'))
        trace.channel = 3
        trace.located((), {}, ([], None, {}), 0.)
        self.assertEqual(trace.channel, 0)


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        CORE.cleanup()
