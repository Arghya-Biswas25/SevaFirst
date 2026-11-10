import numpy as np, json, math
from PIL import Image, ImageDraw
from scipy import ndimage
from matplotlib.colors import rgb_to_hsv
from skimage.morphology import skeletonize, remove_small_objects
S_M = 0.64
blu = json.load(open('blu.json')); CX,CY = blu['cx'], blu['cy']
pav = np.load('pav.npy'); ring = np.load('ring.npy'); inside = np.load('site_inside.npy')
im = Image.open('imgs/x197.jpeg').convert('RGB'); a = np.asarray(im).astype(float)/255
hsv = rgb_to_hsv(a); H,S,V = hsv[...,0]*360, hsv[...,1], hsv[...,2]
sat = (S>0.40)&(V>0.30)
bld = ndimage.binary_dilation(sat, iterations=1)
road = (pav | ring) & ~bld
road = ndimage.binary_closing(road, iterations=2) & ~bld
road = remove_small_objects(road, 400)
dt = ndimage.distance_transform_edt(road)
# vehicle-capable: width >= 5 m -> half-width >= 2.5 m -> >= 3.9 px; keep cores then regrow
core = dt >= 3.9
core = remove_small_objects(core, 60)
veh = ndimage.binary_dilation(core, iterations=3) & road
sk = skeletonize(veh)
# graph from skeleton pixels
ys,xs = np.nonzero(sk)
idx = -np.ones(sk.shape, int); idx[ys,xs] = np.arange(len(xs))
nbrs = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
deg = np.zeros(len(xs), int); adj = [[] for _ in range(len(xs))]
for i,(y,x) in enumerate(zip(ys,xs)):
    for dy,dx in nbrs:
        yy,xx = y+dy, x+dx
        if 0<=yy<sk.shape[0] and 0<=xx<sk.shape[1] and idx[yy,xx]>=0:
            adj[i].append(idx[yy,xx])
    deg[i] = len(adj[i])
# prune spurs iteratively (endpoints chains shorter than L px)
alive = np.ones(len(xs), bool)
def prune(L=14, rounds=3):
    for _ in range(rounds):
        ends = [i for i in range(len(xs)) if alive[i] and sum(alive[j] for j in adj[i])==1]
        for e in ends:
            chain=[e]; prev=-1; cur=e
            while True:
                nx=[j for j in adj[cur] if alive[j] and j!=prev and j not in chain]
                if len(nx)!=1 or sum(alive[j] for j in adj[cur])>2: break
                prev,cur = cur,nx[0]; chain.append(cur)
                if len(chain)>L: break
            if len(chain)<=L:
                for c in chain[:-1]: alive[c]=False
prune(16, 4)
# nodes: junctions (deg>=3) and endpoints (deg==1) among alive
def adeg(i): return sum(alive[j] for j in adj[i])
key = [i for i in range(len(xs)) if alive[i] and adeg(i)!=2]
keyset=set(key)
# trace edges between key nodes
visited=set(); edges=[]
for k in key:
    for n in adj[k]:
        if not alive[n] or (k,n) in visited: continue
        path=[k,n]; prev=k; cur=n
        while cur not in keyset:
            nx=[j for j in adj[cur] if alive[j] and j!=prev]
            if not nx: break
            prev,cur=cur,nx[0]; path.append(cur)
            if len(path)>5000: break
        for p,q in zip(path[:-1],path[1:]): visited.add((p,q)); visited.add((q,p))
        if path[-1] in keyset and path[0]!=path[-1]:
            edges.append(path)
# merge nearby key nodes (junction clusters) by snapping
pts = {i:(xs[i],ys[i]) for i in key}
# simplify edges (Douglas-Peucker) & widths
def dp(P, eps):
    if len(P)<3: return P
    a_,b_ = np.array(P[0],float), np.array(P[-1],float)
    d = b_-a_; L=np.hypot(*d) or 1
    dists=[abs(d[0]*(p[1]-a_[1]) - d[1]*(p[0]-a_[0]))/L for p in P[1:-1]]
    i=int(np.argmax(dists))+1
    if dists[i-1]>eps: return dp(P[:i+1],eps)[:-1]+dp(P[i:],eps)
    return [P[0],P[-1]]
nodes={}; E=[]
def nid(i):
    if i not in nodes: nodes[i]=len(nodes)
    return nodes[i]
seen=set()
for path in edges:
    a0,b0 = path[0], path[-1]
    k=(min(a0,b0),max(a0,b0),len(path))
    if k in seen: continue
    seen.add(k)
    P=[(int(xs[i]),int(ys[i])) for i in path]
    Ps=dp(P, 1.5)
    w = float(np.median([dt[ys[i],xs[i]] for i in path]))*2*S_M
    length = sum(math.hypot(P[j+1][0]-P[j][0],P[j+1][1]-P[j][1]) for j in range(len(P)-1))*S_M
    if length < 4: continue
    E.append(dict(a=nid(a0), b=nid(b0), pts=[[round((x-CX)*S_M,1), round(-(y-CY)*S_M,1)] for x,y in Ps], width_m=round(w,1), length_m=round(length,1)))
N=[None]*len(nodes)
for i,j in nodes.items(): N[j]=[round((xs[i]-CX)*S_M,1), round(-(ys[i]-CY)*S_M,1)]
json.dump(dict(nodes=N, edges=E), open('roads_raw.json','w'))
print('nodes', len(N), 'edges', len(E), 'total length km', round(sum(e['length_m'] for e in E)/1000,2))
ws=[e['width_m'] for e in E]; print('width p10/50/90', np.percentile(ws,[10,50,90]).round(1))
# draw
base = Image.blend(im, Image.new('RGB', im.size, (255,255,255)), 0.5).resize((1106*2,738*2))
d = ImageDraw.Draw(base)
for e in E:
    P=[((x/S_M+CX)*2, (-y/S_M+CY)*2) for x,y in e['pts']]
    col=(220,0,0) if e['width_m']>=6 else (0,90,220)
    d.line(P, fill=col, width=3)
for x,y in N:
    X,Y=((x/S_M+CX)*2, (-y/S_M+CY)*2); d.ellipse([X-3,Y-3,X+3,Y+3], fill=(0,0,0))
base.crop((100,100,1800,1450)).resize((1275,1012)).save('roads_overlay.png')
