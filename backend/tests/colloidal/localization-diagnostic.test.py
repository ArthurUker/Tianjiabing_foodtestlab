"""Offline diagnostic checks. No database, webcam or real specimen required."""
import importlib.util
from pathlib import Path
import unittest
import cv2
import numpy as np

path = Path(__file__).resolve().parents[3]/'scripts/diagnose-colloidal-localization.py'
spec = importlib.util.spec_from_file_location('diagnostic', path)
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class CardEvidenceTests(unittest.TestCase):
    def test_blank_has_no_card_outline(self):
        result = diagnostic.card_outline_candidate(np.full((1000, 600, 3), 150, np.uint8))
        self.assertEqual(result['status'], 'not_detected')
        self.assertFalse(result['production_connected'])

    def test_quad_remains_an_unvalidated_candidate(self):
        image = np.full((1000, 600, 3), (65, 85, 105), np.uint8)
        cv2.fillConvexPoly(image, np.int32([[190, 180], [370, 185], [410, 820], [210, 825]]), (180, 180, 180))
        result = diagnostic.card_outline_candidate(image)
        self.assertEqual(result['status'], 'candidate_unvalidated')
        self.assertEqual(len(result['candidates']), 1)
        self.assertFalse(result['physical_card_validated'])
        self.assertFalse(result['product_identity_validated'])
        self.assertFalse(result['production_connected'])
        self.assertIn('not independently verified', result['direction_basis'])

    def test_marker_based_coordinate_roundtrip_handles_source_rotation(self):
        # The source frame need not be upright; a full homography preserves
        # coordinates without applying UI preview rotations a second time.
        transform = np.float64([[.01, -1.7, 1060], [1.69, .03, -1130], [.00001, .00006, 1]])
        slot = np.float32([[[0, 0], [299, 0], [299, 799], [0, 799]]])
        source = cv2.perspectiveTransform(slot, np.linalg.inv(transform))
        returned = cv2.perspectiveTransform(source, transform)
        np.testing.assert_allclose(returned, slot, atol=.001)


if __name__ == '__main__':
    unittest.main()
