import json, math
import numpy as np
from PIL import Image
from scipy import ndimage
import pymupdf as fitz
from matplotlib.colors import rgb_to_hsv
doc = fitz.open('/mnt/user-data/uploads/LWM/ePlan.pdf')
info = [i for i in doc[1].get_image_info(xrefs=True) if i['xref']==197][0]
bx0,by0,bx1,by1 = info['bbox']
im = Image.open('imgs/x197.jpeg').convert('RGB'); a = np.asarray(im).astype(float)/255
Hh,Ww,_ = a.shape
sx = Ww/(bx1-bx0); sy = Hh/(by1-by0)
hsv = rgb_to_hsv(a); H,S,V = hsv[...,0]*360, hsv[...,1], hsv[...,2]
sat = (S>0.40)&(V>0.30)
cls = {
 'blue2':(198,216),'indigo':(216,246),'violet':(246,275),'purple':(280,330),'yellow':(38,65),
 'lgreen':(95,132),'mgreen':(132,160),'dgreen':(160,186),'cyan':(186,198)}
comps=[]
for k,(lo,hi) in cls.items():
    m = sat&(H>=lo)&(H<hi)
    m = ndimage.binary_closing(m, iterations=1)
    m = ndimage.binary_opening(m, iterations=1)
    lab,n = ndimage.label(m)
    for i in range(1,n+1):
        ys,xs = np.where(lab==i)
        if len(xs) < 40: continue
        pts = np.stack([xs,ys],1).astype(float); c = pts.mean(0)
        u,s,vt = np.linalg.svd(pts-c, full_matrices=False)
        proj = (pts-c)@vt.T
        L = np.ptp(proj[:,0]); W = np.ptp(proj[:,1])
        ang = math.degrees(math.atan2(-vt[0,1], vt[0,0]))
        if ang>90: ang-=180
        if ang<=-90: ang+=180
        comps.append(dict(cls=k, n=int(len(xs)), cx=round(float(c[0]),1), cy=round(float(c[1]),1), L=round(float(L),1), W=round(float(W),1), ang=round(ang,1)))
labels = json.load(open('labels_p2.json'))
for L in labels:
    L['px'] = round((L['cx']-bx0)*sx,1); L['py'] = round((L['cy']-by0)*sy,1)
json.dump(dict(comps=comps, labels=labels, img=dict(bbox=[bx0,by0,bx1,by1], sx=sx, sy=sy)), open('mp_segments.json','w'), indent=0)
print(len(comps), 'components; sx sy', round(sx,4), round(sy,4))
for c in sorted(comps, key=lambda r:(r['cls'], r['cy'])):
    print(c)
