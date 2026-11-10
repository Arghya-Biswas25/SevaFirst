import numpy as np, json, math
from PIL import Image
from scipy import ndimage
from matplotlib.colors import rgb_to_hsv
S_M = 0.64  # metres per master-plan image pixel (calibrated)
seg = json.load(open('mp_segments.json')); blu = json.load(open('blu.json'))
bx0,by0,_,_ = seg['img']['bbox']; sx,sy = seg['img']['sx'], seg['img']['sy']
CX,CY = blu['cx'], blu['cy']
im = Image.open('imgs/x197.jpeg').convert('RGB'); a = np.asarray(im).astype(float)/255
hsv = rgb_to_hsv(a); H,S,V = hsv[...,0]*360, hsv[...,1], hsv[...,2]
yy,xx = np.mgrid[0:a.shape[0],0:a.shape[1]]
sat = (S>0.40)&(V>0.30)
classes = {'blue2':(198,216),'indigo':(216,246),'violet':(246,275),'purple':(280,330),'yellow':(38,65),'lgreen':(95,132),'mgreen':(132,160),'dgreen':(160,186),'cyan':(186,198)}
cmap = np.full(a.shape[:2], '', dtype=object)
B = np.zeros(a.shape[:2], bool)
for k,(lo,hi) in classes.items():
    m = sat&(H>=lo)&(H<hi)
    cmap[m] = k; B |= m
R = np.hypot(xx-CX, yy-CY)
water = (R < 66) | ((cmap=='cyan') & (R<75))  # lagoon + curved pool
B &= ~water
B = ndimage.binary_closing(B, iterations=1)
# labels -> px
L = seg['labels']
def px(l): return ((l['cx']-bx0)*sx, (l['cy']-by0)*sy)
rows = {
 '1':[('A',247.6,519.9),('B',188.8,499.2)], '2':[('A',226.8,478.1),('B',182.1,462.9)],
 '3':[('A',239.9,449.8),('B',208.9,436.8),('C',161.6,418.2),('D',115.0,402.4)],
 '4':[('A',250.2,421.4),('B',222.1,403.8),('C',176.9,375.8),('D',132.8,348.6)],
 '5':[('A',259.4,384.6),('B',217.1,336.5),('C',177.3,291.5),('D',143.1,257.0)],
 '6':[('A',271.0,352.9),('B',254.5,322.0),('C',232.1,280.5),('D',201.6,225.6),('E',175.5,180.8)],
 '7':[('A',293.8,322.3),('B',277.0,261.0),('C',259.6,197.7),('D',244.8,150.0)],
 '8':[('A',329.3,333.7),('B',327.0,291.8),('C',324.2,228.1),('D',319.5,174.2)],
 '9':[('A',391.1,317.5),('B',395.6,253.4),('C',402.0,194.3)],
 '10':[('A',420.4,340.3),('B',432.2,296.5),('C',449.0,239.5)],
 '11':[('-',452.6,290.0)], '12':[('A',433.5,384.9),('B',475.8,347.7)],
 '13':[('-',441.1,408.0)], '14':[('-',452.3,440.1)], '15':[('-',452.1,470.7)], '16':[('-',440.1,505.4)],
}
angles = {'1':-18.3,'2':-18.3,'3':-21.4,'4':-32.0,'5':-47.3,'6':-62.3,'7':-74.6,'8':-87.0,'9':86.2,'10':76.6,'11':67.7,'12':42.8,'13':23.7,'14':9.9,'15':5.1,'16':4.3}
def topx(xp,yp): return ((xp-bx0)*sx, (yp-by0)*sy)
assigned = np.zeros(B.shape, np.int32)-1
out=[]
for r,wl in rows.items():
    ang = math.radians(angles[r]); d = np.array([math.cos(ang), -math.sin(ang)])  # image coords
    nrm = np.array([-d[1], d[0]])
    P = np.array([topx(x,y) for _,x,y in wl])
    p0 = P.mean(0)
    t_lab = (P-p0)@d
    tmin,tmax = t_lab.min()-45, t_lab.max()+45
    pts = np.stack([xx[B],yy[B]],1).astype(float)
    rel = pts-p0; t = rel@d; o = rel@nrm
    band = (t>tmin)&(t<tmax)&(np.abs(o)<40)
    # lateral offset histogram -> nearest dense cluster
    hist,edges = np.histogram(o[band], bins=80, range=(-40,40))
    centers = (edges[:-1]+edges[1:])/2
    dens = hist > max(8, hist.max()*0.25)
    # cluster closest to 0
    best=None
    i=0
    clusters=[]
    while i<len(dens):
        if dens[i]:
            j=i
            while j<len(dens) and dens[j]: j+=1
            w = hist[i:j]; c = (centers[i:j]*w).sum()/w.sum(); clusters.append((abs(c), c, centers[i], centers[j-1], w.sum())); i=j
        else: i+=1
    clusters.sort()
    if not clusters: print('row',r,'no cluster'); continue
    _,oc,olo,ohi,_ = clusters[0]
    sel = band & (o>olo-6) & (o<ohi+6)
    # split by wing midpoints along t
    order = np.argsort(t_lab)
    cuts = [-1e9] + [ (t_lab[order[k]]+t_lab[order[k+1]])/2 for k in range(len(order)-1)] + [1e9]
    for k,idx in enumerate(order):
        w = wl[idx][0]
        m = sel & (t>cuts[k]) & (t<=cuts[k+1])
        q = pts[m]
        if len(q)<30: print('row',r,w,'few px',len(q)); continue
        c = q.mean(0)
        tq = (q-c)@d; oq = (q-c)@nrm
        Lpx = np.percentile(tq,99.5)-np.percentile(tq,0.5); Wpx = np.percentile(oq,99.5)-np.percentile(oq,0.5)
        cols = {}
        for (x_,y_) in q.astype(int): cols[cmap[y_,x_]] = cols.get(cmap[y_,x_],0)+1
        dom = sorted(cols.items(), key=lambda z:-z[1])
        E = (c[0]-CX)*S_M; N = -(c[1]-CY)*S_M
        bearing = (90 - angles[r]) % 180  # axis bearing from north, degrees (0-180)
        out.append(dict(row=r, wing=w, E=round(E,1), N=round(N,1), L_m=round(Lpx*S_M,1), W_m=round(Wpx*S_M,1), axis_bearing=round(bearing,1), px=int(len(q)), colors=dom[:3]))
        assigned[(yy[B])[m].astype(int)*0+0, 0] = 0
for o_ in out: print(o_)
json.dump(out, open('wings_raw.json','w'), indent=1)
