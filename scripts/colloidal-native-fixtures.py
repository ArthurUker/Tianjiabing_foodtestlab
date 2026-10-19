"""Frozen upstream synthetic fixtures. Never reads lab photos or SQLite.

Run with the reader lab's existing Python environment, passing --source and
--output. The function bodies are extracted from the pinned Git test source.
"""
import argparse
import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
source, output = Path(args.source).resolve(), Path(args.output).resolve()
commit = 'a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da'
# Run the release bundle itself rather than whichever HEAD the source later has.
bundle = json.loads((Path(__file__).resolve().parent.parent / 'frontend/vendor/colloidal/core.json').read_text())
if bundle['commit'] != commit:
    raise RuntimeError('unexpected core commit')
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='colloidal-native-') as package:
    for name, text in bundle['files'].items():
        target = Path(package) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    sys.path.insert(0, package)
    import cv2
    import numpy as np
    import scipy
    from lab.reader import recognize
    from lab.reader_config import LAYOUT, get_project
    fixture_source = subprocess.check_output(['git', '-C', str(source), 'show', commit + ':tests/test_reader.py'], text=True)
    for node in ast.parse(fixture_source).body:
        if isinstance(node, ast.FunctionDef) and node.name in ('fixture_card', 'board_image'):
            exec(compile(ast.Module(body=[node], type_ignores=[]), 'frozen-fixture', 'exec'))
    cases = [
        ('single-unknown', fixture_card(absent_test=0), 'lead', None, 'closeup'),
        ('single-valid', fixture_card(), 'enrofloxacin', 360, 'closeup'),
        ('triplex-valid', fixture_card(3, absent_control=1, absent_test=2), 'lean_meat_triplex', 360, 'closeup'),
        ('triplex-all-valid', fixture_card(3), 'lean_meat_triplex', 360, 'closeup'),
        ('wrong-structure', fixture_card(), 'lean_meat_triplex', 360, 'closeup'),
        ('single-board', board_image(fixture_card()), 'carbofuran', 360, 'board'),
    ]
    for project in ['isocarbophos', 'thiamethoxam', 'florfenicol', 'cadmium']:
        cases.append(('single-' + project, fixture_card(), project, 360, 'closeup'))
    results = []
    for name, image, project, elapsed, mode in cases:
        cv2.imwrite(str(output / (name + '.png')), image)
        with tempfile.TemporaryDirectory(prefix='reader-native-output-') as artifacts:
            result = recognize(image, get_project(project), elapsed, artifacts, mode)
        results.append(dict(name=name, projectId=project, elapsedSeconds=elapsed, inputMode=mode,
            status=result['status'], channels=[dict(id=c['id'], status=c['status'], image_result=c.get('image_result'),
                final_result=c.get('final_result'), c=(c.get('measurement') or {}).get('c'), t=(c.get('measurement') or {}).get('t')) for c in result['channels']]))
    from PIL import Image, ImageOps
    rotated = cv2.rotate(fixture_card(), cv2.ROTATE_90_COUNTERCLOCKWISE)
    original = output / 'jpeg-exif.jpg'
    exif = Image.Exif()
    exif[274] = 6
    Image.fromarray(cv2.cvtColor(rotated, cv2.COLOR_BGR2RGB)).save(original, quality=95, exif=exif)
    with Image.open(original) as photo:
        decoded = cv2.cvtColor(np.asarray(ImageOps.exif_transpose(photo).convert('RGB')), cv2.COLOR_RGB2BGR)
    with tempfile.TemporaryDirectory(prefix='reader-native-output-') as artifacts:
        result = recognize(decoded, get_project('lead'), 360, artifacts, 'closeup')
    results.append(dict(name='jpeg-exif', filename='jpeg-exif.jpg', projectId='lead', elapsedSeconds=360, inputMode='closeup',
        status=result['status'], channels=[dict(id=c['id'], status=c['status'], image_result=c.get('image_result'),
            final_result=c.get('final_result'), c=(c.get('measurement') or {}).get('c'), t=(c.get('measurement') or {}).get('t')) for c in result['channels']]))
    (output / 'native-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(dict(native_cases=len(results), opencv=cv2.__version__, numpy=np.__version__, scipy=scipy.__version__)))
