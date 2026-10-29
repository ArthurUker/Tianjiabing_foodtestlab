"""Generate the A4 board matching the frozen reader's CG-A4-DEMO layout.

Development-only dependencies: reportlab and OpenCV. The generated PDF/SVG are
static product assets; neither dependency is required in production.
"""
import html
import json
from pathlib import Path

import cv2
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'frontend/vendor/colloidal/boards'
NAME = 'CG-A4-DEMO-V0.1'
PAGE_W, PAGE_H = 210, 297
LAYOUT = {
    'id': 'CG-A4-DEMO',
    'version': '0.1',
    'page_mm': [PAGE_W, PAGE_H],
    'dictionary': 'DICT_4X4_50',
    'slot_mm': [90, 110, 30, 80],
    'actual_card_dimensions_validated': False,
    'physical_print_validated': False,
    'markers': [
        {'id': 0, 'x_mm': 15, 'y_mm': 15, 'size_mm': 20},
        {'id': 1, 'x_mm': 175, 'y_mm': 15, 'size_mm': 20},
        {'id': 2, 'x_mm': 175, 'y_mm': 262, 'size_mm': 20},
        {'id': 3, 'x_mm': 15, 'y_mm': 262, 'size_mm': 20},
        {'id': 10, 'x_mm': 57, 'y_mm': 92, 'size_mm': 15},
        {'id': 11, 'x_mm': 138, 'y_mm': 92, 'size_mm': 15},
        {'id': 12, 'x_mm': 138, 'y_mm': 195, 'size_mm': 15},
        {'id': 13, 'x_mm': 57, 'y_mm': 195, 'size_mm': 15},
    ],
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    for marker in LAYOUT['markers']:
        bits = cv2.aruco.generateImageMarker(dictionary, marker['id'], 6)
        marker['matrix_6x6'] = bits.tolist()
    (OUT / f'{NAME}.json').write_text(
        json.dumps(LAYOUT, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    pdf = canvas.Canvas(str(OUT / f'{NAME}.pdf'), pagesize=(PAGE_W*mm, PAGE_H*mm), pageCompression=1)
    pdf.setTitle('A4胶体金定位卡 CG-A4-DEMO V0.1')
    pdf.setAuthor('FoodSentinel')
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}mm" height="{PAGE_H}mm" viewBox="0 0 {PAGE_W} {PAGE_H}">',
        f'<rect width="{PAGE_W}" height="{PAGE_H}" fill="white"/>',
    ]

    def text(x, y, value, size=2.8, color='#334155'):
        pdf.setFont('STSong-Light', size*mm)
        pdf.setFillColor(color)
        pdf.drawCentredString(x*mm, (PAGE_H-y)*mm, value)
        svg.append(
            f'<text x="{x}" y="{y}" text-anchor="middle" '
            f'font-family="PingFang SC,Noto Sans CJK SC,sans-serif" font-size="{size}" fill="{color}">'
            f'{html.escape(value)}</text>')

    def rect(x, y, width, height, fill, stroke=None, dash=False):
        if fill:
            pdf.setFillColor(fill)
        if stroke:
            pdf.setStrokeColor(stroke)
        pdf.setLineWidth(.2*mm)
        pdf.setDash([1.5*mm, 1*mm] if dash else [])
        pdf.rect(x*mm, (PAGE_H-y-height)*mm, width*mm, height*mm,
                 fill=int(bool(fill)), stroke=int(bool(stroke)))
        svg.append(
            f'<rect x="{x}" y="{y}" width="{width}" height="{height}" '
            f'fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width=".2"'
            + (' stroke-dasharray="1.5 1"' if dash else '') + '/>')

    text(105, 52, 'A4 胶体金定位卡', 5, '#173d35')
    text(105, 60, 'CG-A4-DEMO / V0.1 / 210 x 297 mm / 实际大小100%', 2.8)
    text(105, 74, '项目名称朝上，加样孔朝下；检测卡放入中央虚线区域', 3)

    for marker in LAYOUT['markers']:
        x, y, size = marker['x_mm'], marker['y_mm'], marker['size_mm']
        rect(x-3, y-3, size+6, size+6, 'white')
        bits = marker['matrix_6x6']
        for row in range(6):
            for col in range(6):
                if bits[row][col] == 0:
                    rect(x+col*size/6, y+row*size/6, size/6, size/6, 'black')
        text(x+size/2, y+size+6, f'ID {marker["id"]}', 2.4)

    x, y, w, h = LAYOUT['slot_mm']
    rect(x, y, w, h, None, '#64748b', True)
    text(105, 224, '中央虚线为算法搜索区 30 x 80 mm，不是卡壳裁切线', 2.8)

    pdf.setStrokeColor('black')
    pdf.setDash([])
    pdf.setLineWidth(.25*mm)
    pdf.line(80*mm, (PAGE_H-234)*mm, 130*mm, (PAGE_H-234)*mm)
    svg.append('<path d="M80 234 H130" fill="none" stroke="black" stroke-width=".25"/>')
    for tick in range(6):
        xx = 80 + 10*tick
        pdf.line(xx*mm, (PAGE_H-232)*mm, xx*mm, (PAGE_H-236)*mm)
        svg.append(f'<path d="M{xx} 232 V236" fill="none" stroke="black" stroke-width=".25"/>')
    text(105, 242, '打印后用尺核对：上方横线应为 50 mm', 2.7)
    text(105, 249, 'A4纸 / 100% / 关闭适应纸张 / 不镜像打印', 2.6)
    text(105, 256, '拍摄时保留完整卡位及至少三个清晰定位码，优先拍入全部标记', 2.5)
    text(105, 291, '仅用于照片几何定位；实体卡适配与判读须按系统提示核验', 2.4, '#92400e')

    pdf.showPage()
    pdf.save()
    svg.append('</svg>')
    (OUT / f'{NAME}.svg').write_text('\n'.join(svg) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
