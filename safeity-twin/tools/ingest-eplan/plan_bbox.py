import sys, json
from PIL import Image
import numpy as np
from scipy import ndimage
place = json.loads(sys.argv[1])
for x,bb in place.items():
    im = Image.open(f'comp/x{x}.png').convert('RGB'); a = np.asarray(im).astype(int)
    nonwhite = (a.min(axis=2) < 230)
    nonwhite = ndimage.binary_closing(nonwhite, iterations=2)
    lab, n = ndimage.label(nonwhite)
    sizes = ndimage.sum(nonwhite, lab, range(1,n+1))
    k = int(np.argmax(sizes))+1
    comp = lab==k
    comp = ndimage.binary_fill_holes(comp)
    ys,xs = np.where(comp)
    W,H = im.size
    sx = (bb[2]-bb[0])/W; sy=(bb[3]-bb[1])/H
    x0,x1,y0,y1 = xs.min(),xs.max(),ys.min(),ys.max()
    area_pt2 = comp.sum()*sx*sy
    # oriented bbox via PCA
    pts = np.stack([xs*sx, ys*sy],1); c = pts.mean(0); u,s,vt = np.linalg.svd(pts-c, full_matrices=False)
    proj = (pts-c)@vt.T
    L = proj[:,0].max()-proj[:,0].min(); Wd = proj[:,1].max()-proj[:,1].min()
    ang = np.degrees(np.arctan2(-vt[0,1], vt[0,0]))
    print(json.dumps(dict(xref=x, bbox_pt_w=round((x1-x0)*sx,1), bbox_pt_h=round((y1-y0)*sy,1), area_pt2=round(area_pt2,0), obb_L=round(L,1), obb_W=round(Wd,1), axis_deg=round(ang,1))))
    Image.fromarray((comp*255).astype(np.uint8)).save(f'mask_x{x}.png')
