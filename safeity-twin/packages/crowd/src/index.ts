/**
 * @twin/crowd — population and evacuation movement (PRD Section 9.4).
 *
 * One agent per household group. Groups wait out a pre-movement delay, then walk
 * a hazard-aware route (convenience cost) to an assembly point, queue at doors and
 * stairs (SFPE specific flow), slow down in smoke and darkness, re-plan when the
 * hazard field changes, and shelter in place when no tenable route exists.
 */
import { enToLocal, pointInPolygon, type Rng } from '@twin/core';
import type { FieldStore, SimContext } from '@twin/hazard-sdk';
import { multiSourceCosts, type NavEdge, type NavGraph } from '@twin/nav';
import { CLOSE_RISK, DEBRIS_SLOW, edgeTenability, UNTENABLE, walkSpeed, type EdgeRisk, type RecommendedField } from '@twin/routing';
import type { OccupancyProfile, SiteDataset } from '@twin/twin-schema';
import type { Twin } from '@twin/twin-data';

export type GroupStatus = 'idle' | 'waiting' | 'moving' | 'queued' | 'sheltering' | 'trapped' | 'casualty' | 'safe' | 'rescued';
export const STATUS_CODES: GroupStatus[] = ['idle', 'waiting', 'moving', 'queued', 'sheltering', 'trapped', 'casualty', 'safe', 'rescued'];
const code = (s: GroupStatus) => STATUS_CODES.indexOf(s);

export interface Group {
  id: number;
  flat: number;
  wing: number;
  storey: number;
  size: number;
  vulnerable: boolean;
  assist: boolean;
  status: GroupStatus;
  node: number;
  path: number[];
  pathNodes: number[];
  k: number;
  s: number;
  startAt: number;
  nextPlan: number;
  dose: number;
  goal: number;
  E: number;
  N: number;
  z: number;
  outAt: number;
  /** earliest time this group may switch to another assembly point */
  nextReroute?: number;
  /** a rescue operation is coming for this group: it stays put and waits */
  claimed?: string | null;
  /** being brought out by a rescue crew: its position is driven by the operation */
  escorted?: boolean;
}

export interface AssemblyStatus {
  id: string;
  name: string;
  persons: number;
  capacity: number;
  /** people on their way there */
  inbound: number;
  open: boolean;
  /** why it is closed */
  reason?: string;
}

export interface EvacKpis {
  persons: number;
  alerted: number;
  byStatus: Record<GroupStatus, number>;
  inside: number;
  wingsAlerted: number;
  assembly: AssemblyStatus[];
  wingClear: { wing: string; alerted: number; inside: number; clearedAt: number | null }[];
}

/** Outdoor walking time multiplier per unit of zone risk (fall zones, plumes, cordons). */
const ZONE_WEIGHT = 4;

export class Evacuation {
  groups: Group[] = [];
  private bucket: Float32Array;
  private assemblyLoad = new Map<number, number>();
  private assemblyCap = new Map<number, number>();
  private closedAssembly = new Set<number>();
  private fullReported = new Set<number>();
  private wingAlertAt = new Map<number, number>();
  private wingClearedAt = new Map<number, number>();
  private profile: OccupancyProfile;
  private risk: EdgeRisk | null;
  /** signed people per edge: + travelling a->b, - travelling b->a (for the flow overlay) */
  private edgeFlow: Float32Array;
  private apReason = new Map<number, string>();
  constructor(private twin: Twin, private nav: NavGraph, ds: SiteDataset, profileId: string, private rng: Rng, opts: { launchedOnly?: boolean; risk?: EdgeRisk } = {}) {
    this.risk = opts.risk ?? null;
    this.profile = ds.occupancy.profiles[profileId] ?? Object.values(ds.occupancy.profiles)[0];
    const vul = ds.occupancy.vulnerableShare;
    for (const ap of ds.amenities.assemblyPoints) {
      const n = nav.assembly.get(ap.id)!;
      this.assemblyCap.set(n, ap.capacity);
      this.assemblyLoad.set(n, 0);
    }
    for (const f of twin.flats) {
      const w = twin.wings[f.wing];
      if (opts.launchedOnly && w.status !== 'launched') continue;
      if (!rng.chance(this.profile.occupancyRate)) continue;
      const unit = ds.typologies.units[f.unit];
      const size = Math.max(1, Math.round((unit?.personsNominal ?? 3) * this.profile.personsFactor * rng.lognormal(1, 0.3)));
      const node = nav.flatNode[f.id];
      const n = nav.nodes[node];
      this.groups.push({
        id: this.groups.length, flat: f.id, wing: f.wing, storey: f.storey, size,
        vulnerable: rng.chance(vul * size * 0.6), assist: rng.chance(0.012 * size), status: 'idle', node, path: [], pathNodes: [],
        k: 0, s: 0, startAt: Infinity, nextPlan: 0, dose: 0, goal: -1, E: n.E, N: n.N, z: n.z, outAt: -1,
      });
    }
    this.bucket = new Float32Array(nav.edges.length);
    nav.edges.forEach((e, i) => (this.bucket[i] = e.capacity * 2));
    this.edgeLoad = new Float32Array(nav.edges.length);
    this.edgeFlow = new Float32Array(nav.edges.length);
  }

  get persons() {
    return this.groups.reduce((a, g) => a + g.size, 0);
  }

  alert(wings: number[], t: number, delay: number): void {
    const set = new Set(wings);
    for (const w of wings) if (!this.wingAlertAt.has(w)) this.wingAlertAt.set(w, t + delay);
    for (const g of this.groups) {
      if (g.status !== 'idle' || !set.has(g.wing)) continue;
      this.start(g, t + delay);
    }
  }

  alertAll(t: number, delay: number): void {
    this.alert(this.twin.wings.map((w) => w.idx), t, delay);
  }

  private start(g: Group, at: number) {
    const pm = this.rng.lognormal(this.profile.preMovement_s.median, this.profile.preMovement_s.sigma);
    const awake = this.rng.chance(this.profile.awake);
    g.startAt = at + pm * (awake ? 0.6 : 1.2);
    g.status = 'waiting';
  }

  /** Convenience cost (seconds) for an evacuee; Infinity when blocked or untenable. */
  private cost = (f: FieldStore, g: Group) => (e: NavEdge): number => {
    if (e.kind === 'lift') return Infinity;
    const debrisFactor = e.street >= 0 && f.blockedStreet[e.street] ? DEBRIS_SLOW : 1;
    const ten = edgeTenability(f, e);
    if (ten < UNTENABLE) return Infinity;
    if (g.assist && e.kind === 'stair') return Infinity;
    const v = walkSpeed(e, f, ten, g.vulnerable);
    const zone = this.risk ? this.risk.risk[e.id] : 0;
    const time = (e.len / v) * debrisFactor * (1 + ZONE_WEIGHT * zone);
    return time * (1 + 6 * (1 - ten) ** 2);
  };

  private speed(e: NavEdge, g: Group, f: FieldStore, ten: number): number {
    return walkSpeed(e, f, ten, g.vulnerable);
  }

  /**
   * Assembly points that are not safe to gather at: inside a hazard zone (fall zone,
   * collapse cordon, fire exposure, debris), or, without a risk field, too close to a
   * burning or badly damaged wing.
   */
  private unsafeAssembly(f: FieldStore): Set<number> {
    const bad = new Set<number>(this.closedAssembly);
    this.apReason.clear();
    for (const [n] of this.assemblyCap) {
      const node = this.nav.nodes[n];
      if (this.risk) {
        const pr = this.risk.pointRisk(node.E, node.N);
        if (pr.risk >= CLOSE_RISK && pr.zone) {
          bad.add(n);
          this.apReason.set(n, pr.zone.label);
        }
        continue;
      }
      for (const w of f.activeWings) {
        const wing = this.twin.wings[w];
        if (!(f.wingDamage[w] >= 3 || this.burningWing(f, w))) continue;
        // distance from the wing's footprint, not its centre: keep one building height clear
        const [u, v] = enToLocal(wing.pose, node.E, node.N);
        const d = Math.hypot(Math.max(0, Math.abs(u) - wing.L / 2), Math.max(0, Math.abs(v) - wing.W / 2));
        if (d < Math.max(12, wing.height)) {
          bad.add(n);
          this.apReason.set(n, `within ${Math.round(d)} m of ${wing.id}`);
        }
      }
      for (const d of f.debris) {
        if (pointInPolygon([node.E, node.N], d.poly)) {
          bad.add(n);
          this.apReason.set(n, 'covered by debris');
        }
      }
    }
    // never leave people with nowhere to go: if every point is unsafe, use the least bad
    if (bad.size >= this.assemblyCap.size) {
      const open = [...this.assemblyCap.keys()].filter((n) => !this.closedAssembly.has(n));
      for (const n of open.length ? open : [...this.assemblyCap.keys()]) {
        bad.delete(n);
        this.apReason.delete(n);
      }
    }
    return bad;
  }

  private burnCache = new Map<number, boolean>();
  private burningWing(f: FieldStore, w: number): boolean {
    if (this.burnCache.has(w)) return this.burnCache.get(w)!;
    const wing = this.twin.wings[w];
    let b = false;
    const start = wing.storeyOffsets[0] ?? 0;
    for (let i = start; i < start + wing.spaceCount; i++) if (f.burn[i] === 1 || f.burn[i] === 2) { b = true; break; }
    this.burnCache.set(w, b);
    return b;
  }

  private toGo: Float64Array | null = null;
  private toGoAt = -Infinity;
  private toGoCost: (e: NavEdge) => number = () => Infinity;
  private toGoGoals: number[] = [];
  private toGoOffsets: number[] = [];
  private safeGoals = new Set<number>();
  /** assembly points at or over capacity (counting people already heading there) */
  private overGoals = new Set<number>();

  /**
   * Capacity-aware choice of assembly point: a point looks further away as it fills
   * (arrived + inbound people), so crowds spread over the open spaces in proportion
   * to their capacity instead of all piling into the nearest one. Units are seconds.
   */
  private apPenalty(n: number, inbound: Map<number, number>): number {
    const cap = this.assemblyCap.get(n) ?? Infinity;
    const r = ((this.assemblyLoad.get(n) ?? 0) + (inbound.get(n) ?? 0)) / cap;
    if (r < 0.6) return 0;
    if (r < 1) return (240 * (r - 0.6)) / 0.4;
    return 240 + 600 * (r - 1);
  }
  private edgeLoad: Float32Array | null = null;

  /**
   * Cost-to-safety field: one multi-source Dijkstra from every safe assembly point
   * over the hazard-aware convenience cost plus current congestion. Refreshed every
   * 4 s of simulated time; each group then descends the field in O(path length).
   */
  private refreshField(f: FieldStore, t: number, force = false) {
    if (!force && this.toGo && t - this.toGoAt < 4) return;
    const bad = this.unsafeAssembly(f);
    const goals = [...this.assemblyCap.keys()].filter((n) => !bad.has(n));
    this.safeGoals = new Set(goals);
    const inbound = new Map<number, number>();
    for (const g of this.groups) if ((g.status === 'moving' || g.status === 'queued') && g.goal >= 0) inbound.set(g.goal, (inbound.get(g.goal) ?? 0) + g.size);
    const offsets = goals.map((n) => this.apPenalty(n, inbound));
    this.overGoals = new Set(goals.filter((_, i) => offsets[i] >= 240));
    const base: Group = { vulnerable: false, assist: false } as Group;
    const c = this.cost(f, base);
    const load = this.edgeLoad!;
    const withLoad = (e: NavEdge) => {
      const v = c(e);
      if (!(v < Infinity)) return v;
      return v + (load[e.id] > 0 ? load[e.id] / Math.max(0.3, e.capacity) : 0);
    };
    this.toGo = multiSourceCosts(this.nav, goals, withLoad, offsets);
    this.toGoCost = withLoad;
    this.toGoGoals = goals;
    this.toGoOffsets = offsets;
    this.toGoAt = t;
  }

  /**
   * The routing field the crowd is using right now (cost to safety from the open
   * assembly points, with congestion and capacity), for the planner's "recommended" routes.
   */
  toSafety(f: FieldStore, t: number): RecommendedField {
    // reuse the crowd's own field while it is fresh enough for planning (8 s)
    if (!this.toGo || t - this.toGoAt >= 8) this.refreshField(f, t, true);
    return { field: this.toGo!, cost: this.toGoCost, goals: this.toGoGoals, offsets: this.toGoOffsets };
  }

  /** Committed people per edge (planned, not yet walked). */
  get load(): Float32Array {
    return this.edgeLoad!;
  }

  /** Remove a group's remaining path from the edge loads and flows. */
  private release(g: Group) {
    for (let k = g.k; k < g.path.length; k++) this.unload(g, k);
  }

  private unload(g: Group, k: number) {
    const ei = g.path[k];
    if (ei === undefined || !this.edgeLoad) return;
    this.edgeLoad[ei] = Math.max(0, this.edgeLoad[ei] - g.size);
    const fwd = this.nav.edges[ei].a === g.pathNodes[k];
    this.edgeFlow[ei] -= fwd ? g.size : -g.size;
  }

  private plan(g: Group, f: FieldStore, t = 0): boolean {
    this.refreshField(f, t);
    const d = this.toGo!;
    if (!(d[g.node] < Infinity)) return false;
    const nav = this.nav;
    const cost = this.cost(f, g);
    const edges: number[] = [];
    const nodes: number[] = [g.node];
    let u = g.node;
    const seen = new Set<number>([u]);
    for (let k = 0; k < 600 && !this.safeGoals.has(u); k++) {
      let best = -1;
      let bv = Infinity;
      for (const ei of nav.adj[u]) {
        const e = nav.edges[ei];
        const v = nav.other(e, u);
        if (seen.has(v)) continue;
        const val = cost(e) + d[v];
        if (val < bv) {
          bv = val;
          best = ei;
        }
      }
      if (best < 0 || !(bv < Infinity)) return false;
      const v = nav.other(nav.edges[best], u);
      edges.push(best);
      nodes.push(v);
      seen.add(v);
      u = v;
    }
    if (!this.safeGoals.has(u)) return false;
    if (this.edgeLoad) {
      this.release(g);
      const load = this.edgeLoad;
      edges.forEach((ei, k) => {
        load[ei] += g.size;
        this.edgeFlow[ei] += nav.edges[ei].a === nodes[k] ? g.size : -g.size;
      });
    }
    g.path = edges;
    g.pathNodes = nodes;
    g.k = 0;
    g.s = 0;
    g.goal = u;
    return true;
  }

  step(dt: number, ctx: SimContext): void {
    const f = ctx.field;
    const t = ctx.t;
    const nav = this.nav;
    this.burnCache.clear();
    for (let i = 0; i < this.bucket.length; i++) {
      const cap = nav.edges[i].capacity;
      this.bucket[i] = Math.min(cap * Math.max(2.5, 6), this.bucket[i] + cap * dt);
    }
    // self-alert from cues: smoke at the flat or a collapse around you
    for (const w of f.activeWings) {
      const wing = this.twin.wings[w];
      if (wing.massingOnly) continue;
      for (const fid of wing.flatIds) {
        const fl = this.twin.flats[fid];
        if (f.visibility(fl.foyer) < 20 || f.burn[fl.spaces[0]] > 0 || f.damage[fl.foyer] >= 3) {
          for (const g of this.groupsOfFlat(fid)) if (g.status === 'idle') this.start(g, t);
        }
      }
    }
    for (const g of this.groups) {
      if (g.claimed || g.escorted) continue; // waiting for, or with, a rescue crew
      if (g.status === 'idle' || g.status === 'safe' || g.status === 'rescued' || g.status === 'casualty' || g.status === 'trapped') continue;
      // structural entrapment
      const here = nav.nodes[g.node];
      if (here.space >= 0 && f.damage[here.space] >= 4 && g.status !== 'moving') {
        this.release(g);
        g.path = [];
        g.pathNodes = [];
        g.k = 0;
        g.status = 'trapped';
        ctx.emit({ type: 'trapped', level: 'critical', text: `${g.size} people trapped in ${this.twin.flats[g.flat].key}`, wing: g.wing });
        continue;
      }
      if (g.status === 'waiting') {
        if (t < g.startAt) continue;
        if (g.assist && g.storey > 0) {
          g.status = 'sheltering';
          g.nextPlan = Infinity;
          continue;
        }
        if (!this.plan(g, f, t)) {
          g.status = 'sheltering';
          g.nextPlan = t + 15;
          continue;
        }
        g.status = 'moving';
        g.nextPlan = t + 6 + (g.id % 6);
      }
      if (g.status === 'sheltering') {
        if (t >= g.nextPlan) {
          if (!g.assist && this.plan(g, f, t)) g.status = 'moving';
          else g.nextPlan = t + 15;
        }
        continue;
      }
      // moving or queued
      if (t >= g.nextPlan) {
        g.nextPlan = t + 6;
        const e = nav.edges[g.path[g.k]];
        const c = e ? this.cost(f, g)(e) : Infinity;
        const remainingBad = g.path.slice(g.k + 1, g.k + 8).some((ei) => !(this.cost(f, g)(nav.edges[ei]) < Infinity));
        if (!(c < Infinity) || remainingBad) {
          // step back to the start node of the current edge and re-plan from there
          g.s = 0;
          if (!this.plan(g, f, t)) {
            this.release(g);
            g.path = g.path.slice(0, g.k);
            g.status = 'sheltering';
            g.nextPlan = t + 15;
            ctx.emit({ type: 'shelter', level: 'warn', text: `${this.twin.flats[g.flat].key}: no tenable route, ${g.size} people sheltering`, wing: g.wing });
            continue;
          }
        }
      }
      let remaining = dt;
      while (remaining > 0 && g.k < g.path.length) {
        const e = nav.edges[g.path[g.k]];
        let ten = 1;
        if (e.space >= 0) ten = Math.min(ten, f.tenability[e.space]);
        if (e.space2 >= 0) ten = Math.min(ten, f.tenability[e.space2]);
        if (ten < 0.5) g.dose += (remaining * (1 - ten)) / 90;
        if (g.dose >= 1) {
          this.release(g);
          g.path = g.path.slice(0, g.k);
          g.status = 'casualty';
          ctx.emit({ type: 'casualty', level: 'critical', text: `${g.size} people overcome by smoke in ${this.twin.wings[g.wing].id}`, wing: g.wing });
          break;
        }
        const v = this.speed(e, g, f, ten);
        const left = e.len - g.s;
        const tNeed = left / v;
        if (tNeed > remaining) {
          g.s += v * remaining;
          remaining = 0;
          g.status = 'moving';
        } else {
          remaining -= tNeed;
          // arrive at next node; capacity check for the following edge
          const nextNode = g.pathNodes[g.k + 1];
          const following = g.path[g.k + 1];
          if (following !== undefined) {
            const need = Math.min(g.size, nav.edges[following].capacity * 4);
            if (this.bucket[following] < need) {
              g.s = e.len;
              g.status = 'queued';
              remaining = 0;
              break;
            }
            this.bucket[following] -= need;
          }
          this.unload(g, g.k);
          g.k++;
          g.s = 0;
          g.node = nextNode;
          g.status = 'moving';
          const nn = nav.nodes[nextNode];
          if (nn.kind === 'exit' && g.outAt < 0) g.outAt = t;
          // heading for a point that has filled up: re-route at this node if somewhere better exists
          if (this.overGoals.has(g.goal) && t >= (g.nextReroute ?? 0) && g.k < g.path.length) {
            g.nextReroute = t + 20;
            this.refreshField(f, t);
            this.plan(g, f, t);
          }
        }
      }
      if (g.k >= g.path.length && g.status === 'moving') {
        g.status = 'safe';
        this.assemblyLoad.set(g.goal, (this.assemblyLoad.get(g.goal) ?? 0) + g.size);
        const cap = this.assemblyCap.get(g.goal) ?? Infinity;
        if ((this.assemblyLoad.get(g.goal) ?? 0) > 0.95 * cap && !this.fullReported.has(g.goal)) {
          this.fullReported.add(g.goal);
          ctx.emit({ type: 'assembly-full', level: 'warn', text: `Assembly point ${nav.nodes[g.goal].ref} is full; people still on the way are re-routed to other open space` });
        }
      }
      this.updatePos(g);
    }
    // wing clearance times
    for (const [w] of this.wingAlertAt) {
      if (this.wingClearedAt.has(w)) continue;
      const inWing = this.groups.filter((g) => g.wing === w && g.status !== 'idle');
      if (inWing.length && inWing.every((g) => g.outAt >= 0 || g.status === 'safe' || g.status === 'rescued')) {
        this.wingClearedAt.set(w, t);
        ctx.emit({ type: 'wing-clear', level: 'info', text: `${this.twin.wings[w].id} clear of residents at ${Math.round(t)} s` });
      }
    }
  }

  private flatIndex: Map<number, Group[]> | null = null;
  groupsOfFlat(fid: number): Group[] {
    if (!this.flatIndex) {
      this.flatIndex = new Map();
      for (const g of this.groups) {
        if (!this.flatIndex.has(g.flat)) this.flatIndex.set(g.flat, []);
        this.flatIndex.get(g.flat)!.push(g);
      }
    }
    return this.flatIndex.get(fid) ?? [];
  }

  private updatePos(g: Group) {
    const nav = this.nav;
    if (g.k >= g.path.length) {
      const n = nav.nodes[g.node];
      g.E = n.E;
      g.N = n.N;
      g.z = n.z;
      return;
    }
    const e = nav.edges[g.path[g.k]];
    const from = g.pathNodes[g.k];
    const a = nav.nodes[from];
    const b = nav.nodes[nav.other(e, from)];
    const t = e.len > 0 ? Math.min(1, g.s / e.len) : 1;
    if (e.pts && e.pts.length > 2) {
      const pts = e.a === from ? e.pts : [...e.pts].reverse();
      let target = t * e.len;
      for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (target <= seg || i === pts.length - 1) {
          const u = seg ? Math.min(1, target / seg) : 0;
          g.E = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u;
          g.N = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u;
          g.z = 0;
          return;
        }
        target -= seg;
      }
    }
    g.E = a.E + (b.E - a.E) * t;
    g.N = a.N + (b.N - a.N) * t;
    g.z = a.z + (b.z - a.z) * t;
  }

  /**
   * People who need responders: sheltering, trapped, casualties, assisted evacuation.
   * Groups a rescue operation has taken on are left out unless `includeClaimed`.
   */
  needs(includeClaimed = false): { wing: number; sheltering: number; trapped: number; casualties: number; assist: number; groups: number[] }[] {
    const byWing = new Map<number, { wing: number; sheltering: number; trapped: number; casualties: number; assist: number; groups: number[] }>();
    for (const g of this.groups) {
      const need = g.status === 'sheltering' || g.status === 'trapped' || g.status === 'casualty';
      if (!need) continue;
      if (!includeClaimed && (g.claimed || g.escorted)) continue;
      if (!byWing.has(g.wing)) byWing.set(g.wing, { wing: g.wing, sheltering: 0, trapped: 0, casualties: 0, assist: 0, groups: [] });
      const r = byWing.get(g.wing)!;
      if (g.status === 'sheltering') r.sheltering += g.size;
      if (g.status === 'trapped') r.trapped += g.size;
      if (g.status === 'casualty') r.casualties += g.size;
      if (g.assist) r.assist += g.size;
      r.groups.push(g.id);
    }
    return [...byWing.values()];
  }

  /** A responder brings a group out (to `at` if given, else the wing's first exit). */
  rescue(groupId: number, at?: { E: number; N: number }): void {
    const g = this.groups[groupId];
    if (!g) return;
    this.release(g);
    g.path = [];
    g.pathNodes = [];
    g.k = 0;
    g.status = 'rescued';
    g.claimed = null;
    g.escorted = false;
    g.outAt = g.outAt < 0 ? 0 : g.outAt;
    const exits = this.nav.wingExits[g.wing];
    if (at) {
      g.E = at.E;
      g.N = at.N;
      g.z = 0;
    } else if (exits.length) {
      const n = this.nav.nodes[exits[0]];
      g.E = n.E;
      g.N = n.N;
      g.z = 0;
    }
  }

  peopleInside(wing: number): number {
    let n = 0;
    for (const g of this.groups) if (g.wing === wing && g.outAt < 0 && g.status !== 'safe' && g.status !== 'rescued') n += g.size;
    return n;
  }

  peopleAbove(wing: number, storey: number): number {
    let n = 0;
    for (const g of this.groups) if (g.wing === wing && g.storey > storey && g.outAt < 0 && g.status !== 'safe' && g.status !== 'rescued') n += g.size;
    return n;
  }

  kpis(): EvacKpis {
    const byStatus = Object.fromEntries(STATUS_CODES.map((s) => [s, 0])) as Record<GroupStatus, number>;
    let alerted = 0;
    let inside = 0;
    for (const g of this.groups) {
      byStatus[g.status] += g.size;
      if (g.status !== 'idle') alerted += g.size;
      if (g.status !== 'idle' && g.outAt < 0 && g.status !== 'safe' && g.status !== 'rescued') inside += g.size;
    }
    const inbound = new Map<number, number>();
    for (const g of this.groups) if ((g.status === 'moving' || g.status === 'queued') && g.goal >= 0) inbound.set(g.goal, (inbound.get(g.goal) ?? 0) + g.size);
    const assembly = [...this.assemblyCap.entries()].map(([n, cap]): AssemblyStatus => {
      const ap = this.twin.ds.amenities.assemblyPoints.find((a) => a.id === this.nav.nodes[n].ref)!;
      const open = this.toGo ? this.safeGoals.has(n) : true;
      return { id: ap.id, name: ap.name, persons: this.assemblyLoad.get(n) ?? 0, capacity: cap, inbound: inbound.get(n) ?? 0, open, reason: open ? undefined : this.apReason.get(n) ?? 'closed' };
    });
    const per = new Map<number, { alerted: number; inside: number }>();
    for (const g of this.groups) {
      if (g.status === 'idle') continue;
      let r = per.get(g.wing);
      if (!r) per.set(g.wing, (r = { alerted: 0, inside: 0 }));
      r.alerted += g.size;
      if (g.outAt < 0 && g.status !== 'safe' && g.status !== 'rescued') r.inside += g.size;
    }
    const wingClear = [...this.wingAlertAt.keys()].slice(0, 60).map((w) => ({
      wing: this.twin.wings[w].id,
      alerted: per.get(w)?.alerted ?? 0,
      inside: per.get(w)?.inside ?? 0,
      clearedAt: this.wingClearedAt.get(w) ?? null,
    }));
    return { persons: this.persons, alerted, byStatus, inside, wingsAlerted: this.wingAlertAt.size, assembly, wingClear };
  }

  /** Packed positions for the renderer: E, N, z, status code, size per group. */
  pack(): Float32Array {
    const out = new Float32Array(this.groups.length * 5);
    this.groups.forEach((g, i) => {
      out[i * 5] = g.E;
      out[i * 5 + 1] = g.N;
      out[i * 5 + 2] = g.z;
      // groups with a rescue crew are drawn by the rescue layer as figures
      out[i * 5 + 3] = g.claimed || g.escorted ? 0 : code(g.status);
      out[i * 5 + 4] = g.size;
    });
    return out;
  }

  /**
   * Evacuation flow for the renderer: one oriented segment per edge (or per polyline
   * piece of a street) that people are committed to, pointing the way they walk.
   * Layout per segment: E1, N1, z1, E2, N2, z2, people, congestion (0..1).
   */
  flows(max = 8000): Float32Array {
    const nav = this.nav;
    const load = this.edgeLoad!;
    const out = new Float32Array(max * 8);
    let n = 0;
    const put = (E1: number, N1: number, z1: number, E2: number, N2: number, z2: number, people: number, cong: number) => {
      if (n >= max) return;
      const o = n * 8;
      out[o] = E1;
      out[o + 1] = N1;
      out[o + 2] = z1;
      out[o + 3] = E2;
      out[o + 4] = N2;
      out[o + 5] = z2;
      out[o + 6] = people;
      out[o + 7] = cong;
      n++;
    };
    for (let ei = 0; ei < load.length && n < max; ei++) {
      const people = load[ei];
      if (people < 0.5) continue;
      const e = nav.edges[ei];
      if (e.kind === 'lift') continue;
      const fwd = this.edgeFlow[ei] >= 0;
      const cong = Math.min(1, people / (Math.max(0.3, e.capacity) * 45));
      if (e.pts && e.pts.length > 1) {
        const pts = fwd ? e.pts : [...e.pts].reverse();
        for (let k = 1; k < pts.length; k++) put(pts[k - 1][0], pts[k - 1][1], 0, pts[k][0], pts[k][1], 0, people, cong);
      } else {
        const A = nav.nodes[fwd ? e.a : e.b];
        const B = nav.nodes[fwd ? e.b : e.a];
        put(A.E, A.N, A.z, B.E, B.N, B.z, people, cong);
      }
    }
    return out.slice(0, n * 8);
  }

  /** Wings whose alarm has sounded. */
  alertedWings(): number[] {
    return [...this.wingAlertAt.keys()];
  }

  /** People still inside each floor, key `wing * 32 + storey`. */
  insideByFloor(): Map<number, number> {
    const m = new Map<number, number>();
    for (const g of this.groups) {
      if (g.outAt >= 0 || g.status === 'safe' || g.status === 'rescued') continue;
      const key = g.wing * 32 + g.storey;
      m.set(key, (m.get(key) ?? 0) + g.size);
    }
    return m;
  }

  /** Vulnerable residents above the first floor (welfare checks in a blackout). */
  vulnerableUpstairs(wing: number): number {
    let n = 0;
    for (const g of this.groups) if (g.wing === wing && g.vulnerable && g.storey >= 2 && g.status !== 'safe' && g.status !== 'rescued') n += g.size;
    return n;
  }

  /** Node of the most urgent of these groups (by status preference, then size). */
  needNode(groupIds: number[], prefer: GroupStatus[]): number {
    let best = -1;
    let bestRank = Infinity;
    let bestSize = 0;
    for (const id of groupIds) {
      const g = this.groups[id];
      if (!g) continue;
      const rank = prefer.indexOf(g.status);
      const r = rank < 0 ? 99 : rank;
      if (r < bestRank || (r === bestRank && g.size > bestSize)) {
        bestRank = r;
        bestSize = g.size;
        best = g.node;
      }
    }
    return best;
  }
}
