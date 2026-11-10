import numpy as np, json, math
from PIL import Image
from scipy import ndimage
from matplotlib.colors import rgb_to_hsv
S_M=0.64
seg = json.load(open('mp_segments.json')); blu = json.load(open('blu.json'))
bx0,by0,_,_ = seg['img']['bbox']; sx,sy = seg['img']['sx'], seg['img']['sy']
CX,CY = blu['cx'], blu['cy']
im = Image.open('imgs/x197.jpeg').convert('RGB'); a = np.asarray(im).astype(float)/255
hsv = rgb_to_hsv(a); H,S,V = hsv[...,0]*360, hsv[...,1], hsv[...,2]
yy,xx = np.mgrid[0:a.shape[0],0:a.shape[1]]
sat=(S>0.40)&(V>0.30)
R = np.hypot(xx-CX, yy-CY); TH = np.degrees(np.arctan2(-(yy-CY), xx-CX))  # CCW from east
def topx(x,y): return ((x-bx0)*sx,(y-by0)*sy)
out=[]
def do_ring(row, labels, mask, rlo, rhi):
    az = []
    for w,x,y in labels:
        X,Y = topx(x,y); az.append((w, math.degrees(math.atan2(-(Y-CY), X-CX))))
    m = mask & (R>rlo) & (R<rhi)
    th = TH[m]; xs = xx[m]; ys = yy[m]
    azs = np.array([z for _,z in az])
    # angular distance
    dif = np.abs(((th[:,None]-azs[None,:])+180)%360-180)
    k = np.argmin(dif,1)
    for i,(w,z) in enumerate(az):
        sel = (k==i) & (dif[np.arange(len(k)),k] < 40)
        if sel.sum()<30: print(row,w,'few'); continue
        X = xs[sel].astype(float); Y = ys[sel].astype(float)
        cxp, cyp = X.mean(), Y.mean()
        rr = np.hypot(X-CX, Y-CY); tt = np.radians(TH[ys[sel],xs[sel]])
        tc = math.atan2(-(cyp-CY), cxp-CX)
        # tangential/radial extents
        rc = math.hypot(cxp-CX, cyp-CY)
        tang = (np.degrees(((np.degrees(tt) - math.degrees(tc)+180)%360-180)))  # deg
        tang_m = np.radians(np.percentile(np.degrees(np.radians(tang)),[0.5,99.5]))
        Lm = (np.percentile(((np.degrees(tt)-math.degrees(tc)+180)%360-180),99.5)-np.percentile(((np.degrees(tt)-math.degrees(tc)+180)%360-180),0.5))*math.pi/180*rc*S_M
        Wm = (np.percentile(rr,99.5)-np.percentile(rr,0.5))*S_M
        E=(cxp-CX)*S_M; N=-(cyp-CY)*S_M
        bearing_center = (90 - math.degrees(tc))%360
        axis_bearing = (bearing_center+90)%180
        out.append(dict(row=row, wing=w, E=round(E,1), N=round(N,1), radius_m=round(rc*S_M,1), az_bearing=round(bearing_center,1), L_m=round(Lm,1), W_m=round(Wm,1), axis_bearing=round(axis_bearing,1), px=int(sel.sum())))
lg = sat&(H>=95)&(H<132)
dg = sat&(H>=160)&(H<186)
do_ring('18', [('A',308.1,485.3),('B',297.3,453.8),('C',310.2,423.9),('D',339.9,409.7),('E',370.3,418.5),('F',388.4,448.1),('G',381.2,482.7)], lg, 60, 112)
do_ring('17', [('A',315.2,384.1),('B',343.3,379.0),('C',372.2,384.8)], dg, 98, 140)
for o in out: print(o)
json.dump(out, open('rings_raw.json','w'), indent=1)
# R18 & R17 radial stats
print('R18 radial p5/50/95', np.percentile(R[lg&(R>60)&(R<112)],[5,50,95]).round(1)*S_M)
print('R17 radial p5/50/95', np.percentile(R[dg&(R>98)&(R<140)&(yy<CY)],[5,50,95]).round(1)*S_M)
