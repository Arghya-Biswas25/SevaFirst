# usage: gridcrop.py page(1-based) x0 y0 x1 y1 (pt) out.png [dpi] [step_pt]
import sys, pymupdf as fitz
from PIL import Image, ImageDraw
pdf = '/mnt/user-data/uploads/LWM/ePlan.pdf'
pg = int(sys.argv[1]); x0,y0,x1,y1 = map(float, sys.argv[2:6]); out = sys.argv[6]
dpi = int(sys.argv[7]) if len(sys.argv)>7 else 300
step = float(sys.argv[8]) if len(sys.argv)>8 else 10
doc = fitz.open(pdf); p = doc[pg-1]
clip = fitz.Rect(x0,y0,x1,y1)
pix = p.get_pixmap(dpi=dpi, clip=clip)
im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
d = ImageDraw.Draw(im)
s = dpi/72
import math
gx = math.ceil(x0/step)*step
while gx <= x1:
    X = (gx-x0)*s
    major = abs(gx/ (step*5) - round(gx/(step*5))) < 1e-6
    d.line([(X,0),(X,im.height)], fill=(255,0,0) if major else (255,170,170), width=1)
    if major: d.text((X+2,2), f'{gx:.0f}', fill=(255,0,0))
    gx += step
gy = math.ceil(y0/step)*step
while gy <= y1:
    Y = (gy-y0)*s
    major = abs(gy/(step*5) - round(gy/(step*5))) < 1e-6
    d.line([(0,Y),(im.width,Y)], fill=(0,0,255) if major else (170,170,255), width=1)
    if major: d.text((2,Y+2), f'{gy:.0f}', fill=(0,0,255))
    gy += step
im.save(out); print(out, im.size)
