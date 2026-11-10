import json
from PIL import Image
import numpy as np
from scipy import ndimage
T = json.load(open('transforms.json'))
res={}
for x,t in T.items():
    im = Image.open(f'comp/x{x}.png').convert('RGB'); a = np.asarray(im).astype(int)
    nonwhite = (a.min(axis=2) < 232)
    opened = ndimage.binary_opening(nonwhite, structure=np.ones((5,5)))
    lab, n = ndimage.label(opened)
    sizes = ndimage.sum(opened, lab, range(1,n+1))
    k = int(np.argmax(sizes))+1
    comp = lab==k
    # restore detail near component: dilate a bit and AND with nonwhite, then fill holes
    near = ndimage.binary_dilation(comp, iterations=4) & nonwhite
    near = ndimage.binary_closing(near, iterations=2)
    lab2,n2 = ndimage.label(near); s2 = ndimage.sum(near, lab2, range(1,n2+1)); comp2 = lab2==(int(np.argmax(s2))+1)
    filled = ndimage.binary_fill_holes(comp2)
    ys,xs = np.where(filled)
    s = (t['pt_per_px_x']+t['pt_per_px_y'])/2
    res[x] = dict(page=t['page'], rot=t['rot'], L_px=int(xs.max()-xs.min()+1), W_px=int(ys.max()-ys.min()+1), area_px=int(filled.sum()), holes_px=int(filled.sum()-comp2.sum()))
    Image.fromarray((filled*255).astype(np.uint8)).save(f'mask2_x{x}.png')
    print(x, res[x])
json.dump(res, open('plan_px.json','w'), indent=1)
