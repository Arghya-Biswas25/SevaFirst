/**
 * Allocation-free graph search for the planner. `SearchSpace` keeps distance,
 * predecessor and stamp arrays sized to the graph and resets them lazily (a node's
 * entry is valid only when its stamp matches the current search), so a local search
 * inside one wing costs only the ~150 nodes it touches, not the 10k in the graph.
 */
import type { NavEdge, NavGraph } from '@twin/nav';

export type EdgeCost = (e: NavEdge, from: number) => number;

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  clear() {
    this.k.length = 0;
    this.v.length = 0;
  }
  peekKey() {
    return this.k[0];
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && k[r] < k[l] ? r : l;
        if (k[m] >= lk) break;
        k[i] = k[m];
        v[i] = v[m];
        i = m;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

export interface SearchResult {
  /** node where the search ended (its terminal cost was added) */
  goal: number;
  /** path cost to `goal` (without the terminal cost) */
  cost: number;
  /** path cost plus the terminal cost at `goal` */
  total: number;
  edges: number[];
  nodes: number[];
}

export class SearchSpace {
  private dist: Float64Array;
  private prev: Int32Array;
  private stamp: Uint32Array;
  private done: Uint32Array;
  private cur = 0;
  private heap = new MinHeap();
  constructor(private g: NavGraph) {
    const N = g.nodes.length;
    this.dist = new Float64Array(N);
    this.prev = new Int32Array(N);
    this.stamp = new Uint32Array(N);
    this.done = new Uint32Array(N);
  }

  /**
   * Find the node minimising `cost(start → n) + terminal(n)`. `terminal` returns
   * Infinity for non-goals. With a heuristic `h` (admissible toward the goals) the
   * search is A*. Stops when the cheapest open key cannot beat the best total found.
   */
  run(start: number, cost: EdgeCost, terminal: (n: number) => number, h: (n: number) => number = () => 0, maxExpand = 60000): SearchResult | null {
    const g = this.g;
    const st = ++this.cur;
    const dist = this.dist;
    const prev = this.prev;
    const stamp = this.stamp;
    const done = this.done;
    const heap = this.heap;
    heap.clear();
    dist[start] = 0;
    prev[start] = -1;
    stamp[start] = st;
    heap.push(h(start), start);
    let best = Infinity;
    let bestNode = -1;
    let expanded = 0;
    while (heap.size) {
      if (heap.peekKey() >= best) break;
      const u = heap.pop();
      if (done[u] === st) continue;
      done[u] = st;
      const du = dist[u];
      const term = terminal(u);
      if (du + term < best) {
        best = du + term;
        bestNode = u;
      }
      if (++expanded > maxExpand) break;
      for (const ei of g.adj[u]) {
        const e = g.edges[ei];
        const v = e.a === u ? e.b : e.a;
        if (done[v] === st) continue;
        const c = cost(e, u);
        if (!(c < Infinity)) continue;
        const nd = du + c;
        if (stamp[v] !== st || nd < dist[v]) {
          stamp[v] = st;
          dist[v] = nd;
          prev[v] = ei;
          heap.push(nd + h(v), v);
        }
      }
    }
    if (bestNode < 0) return null;
    const nodes = [bestNode];
    const edges: number[] = [];
    let x = bestNode;
    while (x !== start) {
      const ei = prev[x];
      if (ei < 0) break;
      edges.push(ei);
      const e = g.edges[ei];
      x = e.a === x ? e.b : e.a;
      nodes.push(x);
    }
    nodes.reverse();
    edges.reverse();
    return { goal: bestNode, cost: dist[bestNode], total: best, edges, nodes };
  }
}

/**
 * Follow a cost-to-goal field downhill from `start` (O(path)): at each node take the
 * edge minimising `cost(e) + field[next]`. Same rule the crowd uses, so a descent of
 * the crowd's field is exactly the route a group would be given.
 */
export function descend(g: NavGraph, start: number, field: Float64Array, cost: EdgeCost, isGoal: (n: number) => boolean, maxSteps = 900): { edges: number[]; nodes: number[]; goal: number } | null {
  if (!(field[start] < Infinity)) return null;
  const edges: number[] = [];
  const nodes: number[] = [start];
  const seen = new Set<number>([start]);
  let u = start;
  for (let k = 0; k < maxSteps && !isGoal(u); k++) {
    let best = -1;
    let bv = Infinity;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei];
      const v = e.a === u ? e.b : e.a;
      if (seen.has(v)) continue;
      const val = cost(e, u) + field[v];
      if (val < bv) {
        bv = val;
        best = ei;
      }
    }
    if (best < 0 || !(bv < Infinity)) return null;
    const e = g.edges[best];
    const v = e.a === u ? e.b : e.a;
    edges.push(best);
    nodes.push(v);
    seen.add(v);
    u = v;
  }
  return isGoal(u) ? { edges, nodes, goal: u } : null;
}

/** Flattened [E, N, z, E, N, z, ...] points along a node/edge path, for drawing. */
export function pathPoints(g: NavGraph, nodes: number[], edges: number[], lift = 0.35): number[] {
  const out: number[] = [];
  const push = (E: number, N: number, z: number) => {
    const n = out.length;
    if (n >= 3 && Math.abs(out[n - 3] - E) < 0.05 && Math.abs(out[n - 2] - N) < 0.05 && Math.abs(out[n - 1] - z) < 0.05) return;
    out.push(Math.round(E * 10) / 10, Math.round(N * 10) / 10, Math.round(z * 10) / 10);
  };
  for (let i = 0; i < edges.length; i++) {
    const e = g.edges[edges[i]];
    const from = nodes[i];
    const a = g.nodes[from];
    if (e.pts && e.pts.length > 1) {
      const pts = e.a === from ? e.pts : [...e.pts].reverse();
      for (const [E, N] of pts) push(E, N, lift);
    } else push(a.E, a.N, a.z + lift);
  }
  const last = g.nodes[nodes[nodes.length - 1]];
  if (last) push(last.E, last.N, last.z + lift);
  return out;
}
