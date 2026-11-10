/**
 * @twin/nav — the multi-layer navigation graph and search algorithms.
 * Layers: indoor (flats, corridors, stairs, lifts, exits) for every wing, and the
 * outdoor street network extracted from the master plan (pedestrian + vehicle).
 * Edge costs are supplied by the caller, so the same graph serves evacuation
 * (hazard-aware convenience cost) and dispatch (vehicle travel time).
 */
import { distPointSegment, localToEN, polylineLength, type Vec2 } from '@twin/core';
import type { Twin } from '@twin/twin-data';
import { wingStoreyTemplate } from '@twin/twin-data';

export type NodeKind = 'flat' | 'flatdoor' | 'corridor' | 'stair' | 'lift' | 'lobby' | 'exit' | 'street' | 'assembly' | 'gate';
export type EdgeKind = 'walk' | 'door' | 'stair' | 'lift' | 'road' | 'link';

export interface NavNode {
  id: number;
  kind: NodeKind;
  E: number;
  N: number;
  z: number;
  wing: number;
  storey: number;
  space: number;
  flat: number;
  ref?: string;
}

export interface NavEdge {
  id: number;
  a: number;
  b: number;
  len: number;
  kind: EdgeKind;
  width: number;
  capacity: number; // persons per second
  vehicles: boolean;
  space: number;
  space2: number;
  street: number;
  wing: number;
  pts?: Vec2[]; // polyline for road edges (a -> b)
}

export class NavGraph {
  nodes: NavNode[] = [];
  edges: NavEdge[] = [];
  adj: number[][] = [];
  flatNode: Int32Array = new Int32Array(0);
  assembly: Map<string, number> = new Map();
  gates: Map<string, number> = new Map();
  wingExits: number[][] = [];

  addNode(n: Omit<NavNode, 'id'>): number {
    const id = this.nodes.length;
    this.nodes.push({ ...n, id });
    this.adj.push([]);
    return id;
  }
  addEdge(e: Omit<NavEdge, 'id'>): number {
    const id = this.edges.length;
    this.edges.push({ ...e, id });
    this.adj[e.a].push(id);
    this.adj[e.b].push(id);
    return id;
  }
  other(e: NavEdge, n: number): number {
    return e.a === n ? e.b : e.a;
  }
  /** Insert a node on the nearest outdoor edge to (E, N) and return it. */
  attach(E: number, N: number, opts: { vehiclesOnly?: boolean; kind?: NodeKind; ref?: string } = {}): number {
    let best = { d: Infinity, e: -1, seg: 0, t: 0, q: [0, 0] as Vec2, s: 0 };
    for (const e of this.edges) {
      if (e.kind !== 'road' || !e.pts) continue;
      if (opts.vehiclesOnly && !e.vehicles) continue;
      let acc = 0;
      for (let i = 1; i < e.pts.length; i++) {
        const r = distPointSegment([E, N], e.pts[i - 1], e.pts[i]);
        const segLen = Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]);
        if (r.d < best.d) best = { d: r.d, e: e.id, seg: i, t: r.t, q: r.q, s: acc + r.t * segLen };
        acc += segLen;
      }
    }
    if (best.e < 0) throw new Error('no outdoor edge to attach to');
    const e = this.edges[best.e];
    const pts = e.pts!;
    const mid = this.addNode({ kind: 'street', E: best.q[0], N: best.q[1], z: 0, wing: -1, storey: 0, space: -1, flat: -1 });
    // split the edge: shrink e to (a -> mid) and add (mid -> b)
    const first = pts.slice(0, best.seg).concat([best.q]);
    const second = [best.q as Vec2].concat(pts.slice(best.seg));
    const oldB = e.b;
    this.adj[oldB] = this.adj[oldB].filter((x) => x !== e.id);
    e.b = mid;
    e.pts = first;
    e.len = Math.max(0.1, polylineLength(first));
    this.adj[mid].push(e.id);
    this.addEdge({ a: mid, b: oldB, len: Math.max(0.1, polylineLength(second)), kind: 'road', width: e.width, capacity: e.capacity, vehicles: e.vehicles, space: -1, space2: -1, street: e.street, wing: -1, pts: second });
    if (best.d < 0.5 && !opts.kind) return mid;
    const n = this.addNode({ kind: opts.kind ?? 'street', E, N, z: 0, wing: -1, storey: 0, space: -1, flat: -1, ref: opts.ref });
    this.addEdge({ a: n, b: mid, len: Math.max(0.5, best.d), kind: 'link', width: 3, capacity: 4, vehicles: !!opts.vehiclesOnly, space: -1, space2: -1, street: -1, wing: -1, pts: [[E, N], best.q] });
    return n;
  }
}

const SFPE_DOOR = 1.3; // persons / s / m of clear width
const SFPE_STAIR = 1.0;

export function buildNavGraph(twin: Twin): NavGraph {
  const g = new NavGraph();
  const ds = twin.ds;
  // ---------------------------------------------------------------- outdoor
  const streetNode = ds.streets.nodes.map(([E, N]) => g.addNode({ kind: 'street', E, N, z: 0, wing: -1, storey: 0, space: -1, flat: -1 }));
  ds.streets.features.forEach((f, i) => {
    const p = f.properties;
    const pts = f.geometry.coordinates;
    g.addEdge({ a: streetNode[p.from], b: streetNode[p.to], len: Math.max(0.5, polylineLength(pts)), kind: 'road', width: p.width_m, capacity: SFPE_DOOR * p.width_m, vehicles: p.vehicles, space: -1, space2: -1, street: i, wing: -1, pts });
  });
  for (const ap of ds.amenities.assemblyPoints) g.assembly.set(ap.id, g.attach(ap.E, ap.N, { kind: 'assembly', ref: ap.id }));
  for (const gt of ds.amenities.gates) g.gates.set(gt.id, g.attach(gt.E, gt.N, { kind: 'gate', ref: gt.id, vehiclesOnly: gt.vehicles }));
  // ---------------------------------------------------------------- indoor
  g.flatNode = new Int32Array(twin.flats.length).fill(-1);
  const H = twin.storeyH;
  for (const w of twin.wings) {
    g.wingExits.push([]);
    if (w.massingOnly) continue;
    const stairNodes = new Map<string, number[]>();
    const liftNodes = new Map<string, number[]>();
    for (let s = 0; s < w.storeys; s++) {
      const st = wingStoreyTemplate(w, s);
      const off = w.storeyOffsets[s];
      const z = s * H;
      const nodeOfSpace = new Map<number, number>();
      const mk = (kind: NodeKind, gSpace: number) => {
        const id = g.addNode({ kind, E: twin.space.E[gSpace], N: twin.space.N[gSpace], z, wing: w.idx, storey: s, space: gSpace, flat: -1 });
        nodeOfSpace.set(gSpace, id);
        return id;
      };
      for (const ci of st.corridors) mk(st.kind === 'flats' ? 'corridor' : 'lobby', off + ci);
      for (const sp of st.spaces) {
        if (sp.kind === 'lobby' || sp.kind === 'terrace' || sp.kind === 'ground' || sp.kind === 'commercial') {
          if (!nodeOfSpace.has(off + sp.i)) mk('lobby', off + sp.i);
        }
      }
      for (const stair of st.stairs) {
        const id = mk('stair', off + stair.space);
        if (!stairNodes.has(stair.id)) stairNodes.set(stair.id, []);
        stairNodes.get(stair.id)![s] = id;
      }
      for (const lift of st.lifts) {
        const id = mk('lift', off + lift.space);
        if (!liftNodes.has(lift.id)) liftNodes.set(lift.id, []);
        liftNodes.get(lift.id)![s] = id;
      }
      // horizontal links from the template openings
      for (const c of st.conns) {
        const a = nodeOfSpace.get(off + c.a);
        if (c.b < 0) {
          if (c.kind === 'exit' && a !== undefined) {
            // exit node 1.5 m outside the facade, later attached to the street network
            const ga = off + c.a;
            const ox = c.alongX ? 0 : Math.sign(c.x) * 1.5;
            const oy = c.alongX ? Math.sign(c.y) * 1.5 : 0;
            const [E, N] = localToEN(w.pose, c.x + ox, c.y + oy);
            const ex = g.addNode({ kind: 'exit', E, N, z: 0, wing: w.idx, storey: s, space: ga, flat: -1 });
            g.addEdge({ a, b: ex, len: Math.hypot(g.nodes[a].E - E, g.nodes[a].N - N) + 0.5, kind: 'door', width: c.width, capacity: SFPE_DOOR * c.width, vehicles: false, space: ga, space2: -1, street: -1, wing: w.idx });
            g.wingExits[w.idx].push(ex);
          }
          continue;
        }
        const b = nodeOfSpace.get(off + c.b);
        if (a === undefined || b === undefined) continue;
        const kind: EdgeKind = c.kind === 'open' ? 'walk' : 'door';
        const na = g.nodes[a];
        const nb = g.nodes[b];
        g.addEdge({ a, b, len: Math.hypot(na.E - nb.E, na.N - nb.N) + 0.3, kind, width: c.width, capacity: SFPE_DOOR * c.width, vehicles: false, space: off + c.b, space2: off + c.a, street: -1, wing: w.idx });
      }
      // flats: occupant node (living room) -> flat door -> corridor
      if (st.kind === 'flats') {
        for (const fl of st.flats) {
          const fid = twin.flatByKey.get(`${w.id}/${s}${fl.num}`)!;
          const fm = twin.flats[fid];
          const living = off + fl.rooms[0];
          const fn = g.addNode({ kind: 'flat', E: twin.space.E[living], N: twin.space.N[living], z, wing: w.idx, storey: s, space: living, flat: fid });
          const dn = g.addNode({ kind: 'flatdoor', E: fm.door[0], N: fm.door[1], z, wing: w.idx, storey: s, space: fm.foyer, flat: fid });
          g.flatNode[fid] = fn;
          g.addEdge({ a: fn, b: dn, len: Math.hypot(g.nodes[fn].E - fm.door[0], g.nodes[fn].N - fm.door[1]) + 2, kind: 'walk', width: 0.9, capacity: 1.2, vehicles: false, space: living, space2: fm.foyer, street: -1, wing: w.idx });
          const cn = nodeOfSpace.get(fm.corridor)!;
          g.addEdge({ a: dn, b: cn, len: Math.hypot(fm.door[0] - g.nodes[cn].E, fm.door[1] - g.nodes[cn].N) + 0.3, kind: 'door', width: 1.0, capacity: SFPE_DOOR * 1.0, vehicles: false, space: fm.corridor, space2: fm.foyer, street: -1, wing: w.idx });
        }
      }
    }
    // vertical: stairs and lifts
    for (const nodes of stairNodes.values()) {
      for (let s = 0; s + 1 < nodes.length; s++) {
        if (nodes[s] === undefined || nodes[s + 1] === undefined) continue;
        g.addEdge({ a: nodes[s], b: nodes[s + 1], len: 9.2, kind: 'stair', width: 1.2, capacity: SFPE_STAIR * (1.2 - 0.3), vehicles: false, space: g.nodes[nodes[s + 1]].space, space2: g.nodes[nodes[s]].space, street: -1, wing: w.idx });
      }
    }
    for (const nodes of liftNodes.values()) {
      for (let s = 0; s + 1 < nodes.length; s++) {
        if (nodes[s] === undefined || nodes[s + 1] === undefined) continue;
        g.addEdge({ a: nodes[s], b: nodes[s + 1], len: H, kind: 'lift', width: 1.0, capacity: 13 / 60, vehicles: false, space: g.nodes[nodes[s + 1]].space, space2: g.nodes[nodes[s]].space, street: -1, wing: w.idx });
      }
    }
    // exits -> street network
    for (const ex of g.wingExits[w.idx]) {
      const n = g.nodes[ex];
      const street = g.attach(n.E, n.N);
      g.addEdge({ a: ex, b: street, len: Math.max(1, Math.hypot(n.E - g.nodes[street].E, n.N - g.nodes[street].N)), kind: 'link', width: 3, capacity: 4, vehicles: false, space: -1, space2: -1, street: -1, wing: -1, pts: [[n.E, n.N], [g.nodes[street].E, g.nodes[street].N]] });
    }
  }
  return g;
}

// -------------------------------------------------------------------- search
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface PathResult {
  nodes: number[];
  edges: number[];
  cost: number;
}

/**
 * A* over the graph. `cost(edge, fromNode)` returns seconds (or Infinity when the edge
 * is blocked); `h(node)` must not over-estimate. `isGoal` allows multi-target search.
 */
export function astar(
  g: NavGraph,
  start: number,
  isGoal: (n: number) => boolean,
  cost: (e: NavEdge, from: number) => number,
  h: (n: number) => number = () => 0,
  maxExpand = 200000,
): PathResult | null {
  const N = g.nodes.length;
  const gs = new Float64Array(N).fill(Infinity);
  const prevE = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new Heap();
  gs[start] = 0;
  heap.push(h(start), start);
  let expanded = 0;
  while (heap.size) {
    const [, u] = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (isGoal(u)) {
      const nodes = [u];
      const edges: number[] = [];
      let x = u;
      while (prevE[x] >= 0) {
        const e = g.edges[prevE[x]];
        edges.push(e.id);
        x = g.other(e, x);
        nodes.push(x);
      }
      nodes.reverse();
      edges.reverse();
      return { nodes, edges, cost: gs[u] };
    }
    if (++expanded > maxExpand) break;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei];
      const v = g.other(e, u);
      if (closed[v]) continue;
      const c = cost(e, u);
      if (!(c < Infinity)) continue;
      const nd = gs[u] + c;
      if (nd < gs[v]) {
        gs[v] = nd;
        prevE[v] = ei;
        heap.push(nd + h(v), v);
      }
    }
  }
  return null;
}

/** Dijkstra from many sources at once (used for distance-to-safety fields). */
export function multiSourceCosts(g: NavGraph, sources: number[], cost: (e: NavEdge, from: number) => number, offsets?: number[]): Float64Array {
  const N = g.nodes.length;
  const d = new Float64Array(N).fill(Infinity);
  const heap = new Heap();
  sources.forEach((s, i) => {
    // an offset makes a source look further away (used to spread people by capacity)
    const o = offsets?.[i] ?? 0;
    if (o >= d[s]) return;
    d[s] = o;
    heap.push(o, s);
  });
  while (heap.size) {
    const [du, u] = heap.pop();
    if (du > d[u]) continue;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei];
      const v = g.other(e, u);
      const c = cost(e, v); // traversal toward the source
      if (!(c < Infinity)) continue;
      if (du + c < d[v]) {
        d[v] = du + c;
        heap.push(d[v], v);
      }
    }
  }
  return d;
}

/** Points along a found path for drawing (E, N, z). */
export function pathPolyline(g: NavGraph, p: PathResult): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < p.edges.length; i++) {
    const e = g.edges[p.edges[i]];
    const from = p.nodes[i];
    if (e.pts && e.pts.length > 1) {
      const pts = e.a === from ? e.pts : [...e.pts].reverse();
      for (const [E, N] of pts) out.push([E, N, 0.3]);
    } else {
      const n = g.nodes[from];
      out.push([n.E, n.N, n.z + 0.3]);
    }
  }
  const last = g.nodes[p.nodes[p.nodes.length - 1]];
  out.push([last.E, last.N, last.z + 0.3]);
  return out;
}

export const nodeDist = (g: NavGraph, a: number, b: number) => {
  const A = g.nodes[a];
  const B = g.nodes[b];
  return Math.hypot(A.E - B.E, A.N - B.N, A.z - B.z);
};
