"""Generate a vector A5 inner-marker trial board, with no specimen imagery.

Requires reportlab. Marker matrices are exported/verified with the same OpenCV
DICT_4X4_50 used by the frozen reader and stored in the layout JSON.
"""
import json
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.units import mm

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'frontend/vendor/colloidal/boards'
NAME = 'CG-A5-INNER-V0.1'


def main():
    layout = json.loads((OUT / (NAME + '.json')).read_text())
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    pdf = canvas.Canvas(str(OUT / (NAME + '.pdf')), pagesize=(148*mm, 210*mm), pageCompression=1)
    pdf.setTitle('A5单检定位试用板 - 实体卡尺寸待确认')
    pdf.setAuthor('Tianjiabing foodtestlab - development trial')
    svg = ['<svg xmlns="http://www.w3.org/2000/svg" width="148mm" height="210mm" viewBox="0 0 148 210">',
           '<rect width="148" height="210" fill="white"/>']

    def text(x, y, value, size=2.8, color='#334155'):
        pdf.setFont('STSong-Light', size*mm)
        pdf.setFillColor(color)
        pdf.drawCentredString(x*mm, (210-y)*mm, value)
        svg.append(f'<text x="{x}" y="{y}" text-anchor="middle" font-family="PingFang SC,Noto Sans CJK SC,sans-serif" font-size="{size}" fill="{color}">{value.replace("&", "&amp;").replace("<", "&lt;")}</text>')

    def rect(x, y, width, height, fill, stroke=None, dash=False):
        if fill:
            pdf.setFillColor(fill)
        if stroke:
            pdf.setStrokeColor(stroke)
        pdf.setLineWidth(.2*mm)
        pdf.setDash([1.5*mm, 1*mm] if dash else [])
        pdf.rect(x*mm, (210-y-height)*mm, width*mm, height*mm, fill=int(bool(fill)), stroke=int(bool(stroke)))
        svg.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width=".2"' + (' stroke-dasharray="1.5 1"' if dash else '') + '/>')

    text(74, 10, 'A5 单检定位试用板', 4.5, '#173d35')
    text(74, 16, NAME + ' / 148 x 210 mm / 实际大小100%', 2.6)
    for marker in layout['markers']:
        x, y, size = marker['x_mm'], marker['y_mm'], marker['size_mm']
        # Explicit white quiet zone; labels stay outside it.
        rect(x-3, y-3, size+6, size+6, 'white')
        bits = marker['matrix_6x6']
        for row in range(6):
            for col in range(6):
                if bits[row][col] == 0:
                    rect(x+col*size/6, y+row*size/6, size/6, size/6, 'black')
        text(x+size/2, y+size+6, f'ID {marker["id"]}', 2.4)

    text(74, 37, '项目名称朝上', 2.8)
    x, y, w, h = layout['legacy_search_region_mm']
    rect(x, y, w, h, None, '#64748b', True)
    text(74, 124, '加样孔朝下', 2.8)
    text(74, 152, '虚线为现有v5搜索区 30 x 80 mm', 2.8)
    text(74, 158, '不是该产品卡壳尺寸；实体卡适配待实测确认', 2.8, '#92400e')
    text(74, 164, '勿缩放、拉伸或裁剪真实卡来迁就虚线框', 2.6)
    # 50mm print check; vector geometry, not an estimated on-screen ruler.
    pdf.setStrokeColor('black'); pdf.setDash([]); pdf.setLineWidth(.25*mm)
    pdf.line(49*mm, (210-174)*mm, 99*mm, (210-174)*mm)
    svg.append('<path d="M49 174 H99" fill="none" stroke="black" stroke-width=".25"/>')
    for tick in range(6):
        xx = 49+10*tick
        pdf.line(xx*mm, (210-172)*mm, xx*mm, (210-176)*mm)
        svg.append(f'<path d="M{xx} 172 V176" fill="none" stroke="black" stroke-width=".25"/>')
    text(74, 182, '打印后用尺核对：上方横线应为50 mm', 2.7)
    text(74, 190, 'A5纸 / 100% / 关闭适应纸张 / 不镜像打印', 2.6)
    text(74, 196, '保留四个内圈码；拍摄时至少清晰拍入三个及完整卡位', 2.5)
    text(74, 203, '仅研发定位试用；未完成真实打印、实体卡和判读验收', 2.5)
    pdf.showPage(); pdf.save()
    svg.append('</svg>')
    (OUT / (NAME + '.svg')).write_text('\n'.join(svg))


if __name__ == '__main__':
    main()
