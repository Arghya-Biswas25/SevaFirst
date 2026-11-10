/**
 * @twin/dispatch — Uber-style responder matching (PRD Section 10).
 *
 * Every 5 s (and on new incidents) the dispatcher rebuilds the task list from the
 * live state, values each task (people at risk x probability of saving them by
 * the arrival time, plus spread and escalation risk), and solves an assignment of
 * resources to task slots with the Hungarian algorithm. Hysteresis keeps units on
 * their current job unless switching gains at least 25 %. Vehicles drive the live
 * street graph (debris-blocked streets crossed on foot); off-site units are called in
 * and enter at the site gate after their ETA.
 *
 * Safe approach (docs/RESPONSE_DESIGN.md §3): staging points are chosen outside hazard
 * zones and upwind of fires, and drive routes carry a penalty for crossing zones, with
 * the plain fastest route kept as the explained alternative.
 */
import type { FieldStore, SimContext } from '@twin/hazard-sdk';
import { astar, pathPolyline, type NavEdge, type NavGraph } from '@twin/nav';
import type { ResourceSpec, SiteDataset } from '@twin/twin-schema';
import type { Twin } from '@twin/twin-data';
import type { Evacuation } from '@twin/crowd';
import { wingFire, type EdgeRisk, type RescueInput, type Wind } from '@twin/routing';

export type ResourceStatus = 'offsite' | 'called' | 'standby' | 'enroute' | 'onscene';
export type TaskKind = 'fire' | 'rescue' | 'medical' | 'lift' | 'traffic' | 'welfare';

export interface Approach {
  pts: number[];
  eta_s: number;
  via: string;
  alt?: string;
}

export interface ResourceState {
  spec: ResourceSpec;
  status: ResourceStatus;
  node: number;
  E: number;
  N: number;
  route: [number, number, number][];
  routeLen: number;
  routePos: number;
  task: string | null;
  arriveAt: number;
  calledAt: number;
  onSceneAt: number;
  workDone: number;
  approach: Approach | null;
  /** taken by a rescue operation: the optimiser leaves it alone until released */
  lock: { op: string; node: number; label: string; wing: number } | null;
}

export interface Task {
  id: string;
  kind: TaskKind;
  wing: number;
  label: string;
  value: number;
  tau: number;
  needs: string[];
  slots: number;
  node: number;
  reason: string;
  people: number;
  /** where on site the people (or the fire) are, for the entry path */
  target: number;
  stagingNote: string;
}

export interface Assignment {
  resource: string;
  resourceName: string;
  kind: string;
  task: string;
  taskLabel: string;
  status: ResourceStatus;
  eta_s: number;
  score: number;
  reason: string;
  runnerUp?: string;
}

/** Hungarian algorithm (min cost) for an n x m matrix, n <= m allowed by padding. */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  if (!n) return [];
  const m = Math.max(n, cost[0].length);
  const a: number[][] = [];
  for (let i = 0; i < m; i++) {
    a.push([]);
    for (let j = 0; j < m; j++) a[i].push(i < n && j < cost[0].length ? cost[i][j] : 0);
  }
  const u = new Array(m + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] - 1 < n && j - 1 < cost[0].length) res[p[j] - 1] = j - 1;
  return res;
}

const ZONE_PENALTY = 3;
const fmt = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** "Fire tender 1 (standby at south gate)" -> "Fire tender 1" */
export const shortName = (s: string) => s.replace(/\s*\(.*\)\s*$/, '');

interface Travel {
  edges: number[];
  nodes: number[];
  cost: number;
  /** plain travel time (no zone penalty), s */
  time: number;
}

export class Dispatcher {
  resources: ResourceState[] = [];
  tasks: Task[] = [];
  assignments: Assignment[] = [];
  private next = 0;
  private staging: number[] = [];
  /** per wing: drivable street nodes near it, nearest first (staging candidates) */
  private stagingCands: { node: number; d: number }[][] = [];
  private stagingCache = new Map<number, { key: string; node: number; note: string }>();
  private entry: number;
  private gateS: number;
  private reported = new Set<string>();
  private liftWork = new Map<string, number>();
  private welfareDone = new Set<string>();
  private corridorNode = new Map<number, number>();
  private risk: EdgeRisk | null;
  private wind: Wind = { speed_ms: 0, fromDeg: 0 };
  constructor(private twin: Twin, private nav: NavGraph, ds: SiteDataset, opts: { disabled?: string[]; etaOverride?: Record<string, number>; risk?: EdgeRisk } = {}) {
    this.risk = opts.risk ?? null;
    this.entry = nav.gates.get('ENTRY-SW')!;
    this.gateS = nav.gates.get('GATE-S') ?? this.entry;
    for (const spec of ds.resources.resources) {
      if (opts.disabled?.includes(spec.id)) continue;
      const s = { ...spec, eta_s: opts.etaOverride?.[spec.id] ?? spec.eta_s };
      const base = nav.gates.get(s.base) ?? nav.assembly.get(s.base) ?? this.gateS;
      const n = nav.nodes[base];
      this.resources.push({ spec: s, status: s.onSite ? 'standby' : 'offsite', node: base, E: n.E, N: n.N, route: [], routeLen: 0, routePos: 0, task: null, arriveAt: 0, calledAt: -1, onSceneAt: -1, workDone: 0, approach: null, lock: null });
    }
    // staging candidates per wing: street nodes that a vehicle can actually reach from the
    // site entry (small isolated road stubs in the extracted network are skipped)
    const reach = new Set<number>([this.entry]);
    const queue = [this.entry];
    while (queue.length) {
      const u = queue.pop()!;
      for (const ei of nav.adj[u]) {
        const e = nav.edges[ei];
        if (!e.vehicles || (e.kind !== 'road' && e.kind !== 'link')) continue;
        const v = nav.other(e, u);
        if (!reach.has(v)) {
          reach.add(v);
          queue.push(v);
        }
      }
    }
    const vehNodes = nav.nodes.filter((nd) => nd.kind === 'street' && reach.has(nd.id) && nav.adj[nd.id].some((ei) => nav.edges[ei].vehicles && nav.edges[ei].kind === 'road'));
    for (const w of twin.wings) {
      const cands = vehNodes
        .map((nd) => ({ node: nd.id, d: Math.hypot(nd.E - w.pose.E, nd.N - w.pose.N) }))
        .sort((a, b) => a.d - b.d);
      const near = cands.filter((c) => c.d <= cands[0].d + 70).slice(0, 30);
      this.stagingCands.push(near);
      this.staging.push(near[0]?.node ?? this.gateS);
    }
    for (const n of nav.nodes) {
      if (n.kind !== 'corridor' && n.kind !== 'lobby') continue;
      const key = n.wing * 32 + n.storey;
      if (!this.corridorNode.has(key)) this.corridorNode.set(key, n.id);
    }
  }

  /**
   * Where to park for a wing: the nearest drivable point that is outside hazard zones
   * (collapse cordon, fall zone, fire exposure) and, for a fire, upwind of it.
   */
  private stagingFor(w: number, f: FieldStore, burning: boolean): { node: number; note: string } {
    const key = `${this.risk?.version ?? 0}|${burning ? 1 : 0}|${Math.round(this.wind.fromDeg)}`;
    const c = this.stagingCache.get(w);
    if (c && c.key === key) return c;
    const wing = this.twin.wings[w];
    const cands = this.stagingCands[w];
    const b = ((this.wind.fromDeg + 180) * Math.PI) / 180;
    const down = [Math.sin(b), Math.cos(b)];
    let best = cands[0];
    let bestScore = Infinity;
    let bestRisk = 0;
    let bestDown = 0;
    let nearestRisk = 0;
    for (const [i, cand] of cands.entries()) {
      const n = this.nav.nodes[cand.node];
      const r = this.risk ? this.risk.pointRisk(n.E, n.N).risk : 0;
      if (i === 0) nearestRisk = r;
      const dE = n.E - wing.pose.E;
      const dN = n.N - wing.pose.N;
      const L = Math.hypot(dE, dN) || 1;
      const dw = burning && this.wind.speed_ms >= 1 ? Math.max(0, (dE * down[0] + dN * down[1]) / L) : 0;
      const s = cand.d + 160 * r + 30 * dw;
      if (s < bestScore) {
        bestScore = s;
        best = cand;
        bestRisk = r;
        bestDown = dw;
      }
    }
    const node = best?.node ?? this.staging[w];
    const n = this.nav.nodes[node];
    const bearing = ((Math.atan2(n.E - wing.pose.E, n.N - wing.pose.N) * 180) / Math.PI + 360) % 360;
    const side = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(bearing / 45) % 8];
    const parts = [`Stage ${Math.round(best?.d ?? 0)} m ${side} of ${wing.id}`];
    if (nearestRisk > 0.2 && bestRisk < nearestRisk) parts.push('outside the hazard zone that covers the nearest kerb');
    else if (bestRisk > 0.2) parts.push('inside a hazard zone (no safer kerb within reach): keep the crew briefed');
    if (burning && this.wind.speed_ms >= 1) parts.push(bestDown < 0.3 ? 'upwind of the smoke' : 'crosswind: watch the smoke');
    const out = { key, node, note: parts.join(', ') };
    this.stagingCache.set(w, out);
    return out;
  }

  // Debris-blocked streets are not impassable for crews: the vehicle stops and the crew
  // carries kit over the rubble on foot, at a fraction of the speed.
  private vehicleTime = (f: FieldStore) => (e: NavEdge) =>
    (e.kind === 'road' && e.vehicles) || (e.kind === 'link' && e.vehicles) ? (e.street >= 0 && f.blockedStreet[e.street] ? e.len / 0.45 : e.len / 5.5) : Infinity;
  private footTime = (f: FieldStore) => (e: NavEdge) =>
    e.kind === 'road' || e.kind === 'link' ? (e.street >= 0 && f.blockedStreet[e.street] ? e.len / 0.5 : e.len / 1.7) : Infinity;
  /** Tasks that no unit is working on, with the reason (shown to the incident commander). */
  pending: { task: string; label: string; reason: string; people: number }[] = [];
  private idleSince = new Map<string, number>();
  private viaDebris(p: { edges: number[] } | null, f: FieldStore): boolean {
    if (!p) return false;
    return p.edges.some((ei) => {
      const e = this.nav.edges[ei];
      return e.street >= 0 && f.blockedStreet[e.street] === 1;
    });
  }

  private travel(r: ResourceState, to: number, f: FieldStore, safe = true): Travel | null {
    const plain = r.spec.foot ? this.footTime(f) : this.vehicleTime(f);
    const risk = this.risk;
    const cost = safe && risk ? (e: NavEdge) => plain(e) * (1 + ZONE_PENALTY * risk.risk[e.id]) : plain;
    const p = astar(this.nav, r.node, (n) => n === to, (e) => cost(e), undefined, 40000);
    if (!p) return null;
    let time = 0;
    for (const ei of p.edges) time += plain(this.nav.edges[ei]);
    return { edges: p.edges, nodes: p.nodes, cost: p.cost, time };
  }

  private buildTasks(ctx: SimContext, evac: Evacuation): Task[] {
    const f = ctx.field;
    const twin = this.twin;
    const tasks: Task[] = [];
    const burning = new Map<number, { rooms: number; hrr: number; lowest: number }>();
    for (const w of f.activeWings) {
      const wf = wingFire(twin, f, w);
      if (wf.rooms) burning.set(w, wf);
    }
    const stage = (w: number) => this.stagingFor(w, f, burning.has(w));
    for (const [w, b] of burning) {
      const wing = twin.wings[w];
      const inside = evac.peopleInside(w);
      const above = evac.peopleAbove(w, b.lowest);
      const single = wing.typology.stairs <= 1;
      const value = 40 + 2.5 * inside + 20 * b.rooms + (single ? 4 : 1.5) * above;
      const why = [
        single && above ? `${above} people above floor ${b.lowest} depend on the only stair` : above ? `${above} people above the fire floor` : `${inside} people inside`,
        `${b.rooms} room${b.rooms === 1 ? '' : 's'} burning (${(b.hrr / 1000).toFixed(1)} MW)`,
      ].join('; ');
      const st = stage(w);
      const target = this.corridorNode.get(w * 32 + b.lowest) ?? -1;
      tasks.push({ id: `fire-${wing.id}`, kind: 'fire', wing: w, label: `Fire attack ${wing.id}`, value, tau: 600, needs: ['fire_attack'], slots: 2, node: st.node, reason: why, people: inside, target, stagingNote: st.note });
      if (b.hrr < 700) tasks.push({ id: `first-${wing.id}`, kind: 'fire', wing: w, label: `First attack ${wing.id} (extinguishers, hose reel)`, value: value * 0.6, tau: 240, needs: ['extinguisher'], slots: 1, node: st.node, reason: `fire still small (${Math.round(b.hrr)} kW): early attack can stop it`, people: inside, target, stagingNote: st.note });
    }
    for (const nd of evac.needs()) {
      const wing = twin.wings[nd.wing];
      const st = stage(nd.wing);
      if (nd.sheltering + nd.trapped > 0) {
        const heavy = nd.trapped > 0;
        tasks.push({
          id: `rescue-${wing.id}`, kind: 'rescue', wing: nd.wing, label: `${heavy ? 'Search and rescue' : 'Assisted evacuation'} ${wing.id}`,
          value: 50 + 8 * nd.sheltering + 12 * nd.trapped, tau: heavy ? 1800 : 900, needs: heavy ? ['search_rescue', 'heavy_rescue', 'search', 'rescue_ladder'] : ['search', 'rescue_ladder', 'search_rescue'],
          slots: Math.min(3, 1 + Math.floor((nd.sheltering + nd.trapped) / 12)), node: st.node,
          reason: `${nd.sheltering ? `${nd.sheltering} sheltering` : ''}${nd.sheltering && nd.trapped ? ', ' : ''}${nd.trapped ? `${nd.trapped} trapped in debris` : ''}`, people: nd.sheltering + nd.trapped,
          target: evac.needNode(nd.groups, heavy ? ['trapped', 'sheltering'] : ['sheltering', 'trapped']), stagingNote: st.note,
        });
      }
      if (nd.casualties > 0) {
        tasks.push({ id: `med-${wing.id}`, kind: 'medical', wing: nd.wing, label: `Casualties ${wing.id}`, value: 60 + 15 * nd.casualties, tau: 1200, needs: ['casualty_transport', 'triage', 'first_aid'], slots: 2, node: st.node, reason: `${nd.casualties} casualties need treatment and transport`, people: nd.casualties, target: evac.needNode(nd.groups, ['casualty']), stagingNote: st.note });
      }
    }
    for (const tl of f.trappedLifts) {
      if (tl.resolved) continue;
      const wing = twin.wings[tl.wing];
      const st = stage(tl.wing);
      tasks.push({ id: `lift-${wing.id}-${tl.lift}`, kind: 'lift', wing: tl.wing, label: `Lift rescue ${wing.id} ${tl.lift}`, value: 30 + 5 * tl.persons, tau: 1800, needs: ['lift_rescue'], slots: 1, node: st.node, reason: `${tl.persons} people in a stalled lift car`, people: tl.persons, target: this.corridorNode.get(tl.wing * 32 + 1) ?? -1, stagingNote: st.note });
    }
    // blackout: wardens check vulnerable residents upstairs (no lifts, no light, medical devices)
    if (!f.powerOn) {
      for (const half of ['west', 'east'] as const) {
        const id = `welfare-${half}`;
        if (this.welfareDone.has(id)) continue;
        let people = 0;
        let worst = -1;
        let worstN = 0;
        for (const w of twin.wings) {
          if (w.massingOnly || (half === 'west') !== w.pose.E < 0) continue;
          const v = evac.vulnerableUpstairs(w.idx);
          people += v;
          if (v > worstN) {
            worstN = v;
            worst = w.idx;
          }
        }
        if (!people || worst < 0) continue;
        const st = stage(worst);
        tasks.push({ id, kind: 'welfare', wing: worst, label: `Welfare checks, ${half} rows`, value: 20 + 0.8 * people, tau: 2400, needs: ['guidance', 'search'], slots: 1, node: st.node, reason: `${people} vulnerable residents on upper floors without lifts or light`, people, target: this.corridorNode.get(worst * 32 + 2) ?? -1, stagingNote: st.note });
      }
    }
    if (burning.size || f.debris.length) {
      tasks.push({ id: 'traffic', kind: 'traffic', wing: -1, label: 'Gate and traffic control', value: 18, tau: 3600, needs: ['traffic_control'], slots: 1, node: this.gateS, reason: 'keep the approach clear for incoming units', people: 0, target: -1, stagingNote: 'At the south forecourt gate' });
    }
    return tasks;
  }

  private canDo(r: ResourceState, t: Task): number {
    const caps = r.spec.capabilities;
    const k = t.needs.findIndex((n) => caps.includes(n));
    return k < 0 ? 0 : 1 - 0.15 * k;
  }

  step(dt: number, ctx: SimContext, evac: Evacuation): void {
    const f = ctx.field;
    const t = ctx.t;
    this.wind = ctx.wind;
    if (t >= this.next) {
      this.next = t + 5;
      this.tasks = this.buildTasks(ctx, evac);
      this.solve(ctx);
    }
    // movement and on-scene work
    for (const r of this.resources) {
      if (r.status === 'called' && t >= r.arriveAt) {
        r.node = this.entry;
        const n = this.nav.nodes[this.entry];
        r.E = n.E;
        r.N = n.N;
        ctx.emit({ type: 'arrival', level: 'info', text: `${shortName(r.spec.name)} arrives at the site entry` });
        if (r.lock) {
          r.status = this.routeTo(r, r.lock.node, f) ? 'enroute' : 'onscene';
        } else {
          const ok = r.task ? this.routeTo(r, this.tasks.find((x) => x.id === r.task)?.node ?? this.gateS, f) : false;
          r.status = ok ? 'enroute' : 'standby';
          if (!ok) r.task = null;
        }
      }
      if (r.status === 'enroute') {
        r.routePos += r.spec.speed_ms * dt;
        if (r.routePos >= r.routeLen) {
          r.status = 'onscene';
          r.onSceneAt = t;
          const last = r.route[r.route.length - 1];
          if (last) {
            r.E = last[0];
            r.N = last[1];
          }
          const task = this.tasks.find((x) => x.id === r.task);
          if (r.lock) {
            r.node = r.lock.node;
          } else if (task) {
            r.node = task.node;
            ctx.emit({ type: 'onscene', level: 'info', text: `${shortName(r.spec.name)} on scene: ${task.label}`, wing: task.wing >= 0 ? task.wing : undefined, data: { kind: r.spec.kind, task: task.kind, taskId: task.id } });
          }
        } else {
          const p = alongPolyline(r.route, r.routePos);
          r.E = p[0];
          r.N = p[1];
        }
      }
      if (r.status === 'onscene' && !r.lock) this.work(r, dt, ctx, evac);
    }
    // suppression is recomputed from tenders working each tick
    f.wingSuppression_kW.fill(0);
    for (const r of this.resources) {
      if (r.status !== 'onscene' || !r.task) continue;
      const task = this.tasks.find((x) => x.id === r.task);
      if (!task || task.kind !== 'fire') continue;
      const setup = r.spec.kind === 'fire_tender' ? 120 : 30;
      if (t - r.onSceneAt < setup) continue;
      f.wingSuppression_kW[task.wing] += r.spec.kind === 'fire_tender' ? 2500 : 350;
    }
  }

  private work(r: ResourceState, dt: number, ctx: SimContext, evac: Evacuation) {
    const task = this.tasks.find((x) => x.id === r.task);
    if (!task) return;
    r.workDone += dt;
    if (task.kind === 'rescue') {
      const heavy = r.spec.capabilities.includes('heavy_rescue');
      const need = evac.needs().find((n) => n.wing === task.wing);
      if (!need || !need.groups.length) return;
      // heavy rescue takes trapped people first; everyone else clears the quick cases first
      const gs = need.groups.map((id) => evac.groups[id]);
      const g = heavy ? gs.find((x) => x.status === 'trapped') ?? gs[0] : gs.find((x) => x.status !== 'trapped') ?? gs[0];
      const per = g.status === 'trapped' ? (heavy ? 300 : 900) : 75;
      if (r.workDone >= per) {
        r.workDone = 0;
        evac.rescue(g.id);
        ctx.emit({ type: 'rescued', level: 'info', text: `${shortName(r.spec.name)} brings ${g.size} people out of ${this.twin.flats[g.flat].key}`, wing: g.wing });
      }
    } else if (task.kind === 'medical') {
      const need = evac.needs().find((n) => n.wing === task.wing);
      const cas = need?.groups.filter((id) => evac.groups[id].status === 'casualty') ?? [];
      if (!cas.length || !r.spec.capabilities.includes('casualty_transport')) return;
      if (r.workDone >= 240) {
        r.workDone = 0;
        for (const id of cas.slice(0, 2)) evac.rescue(id);
        ctx.emit({ type: 'transport', level: 'info', text: `${shortName(r.spec.name)} takes casualties from ${this.twin.wings[task.wing].id} to hospital` });
      }
    } else if (task.kind === 'lift') {
      const tl = ctx.field.trappedLifts.find((x) => !x.resolved && `lift-${this.twin.wings[x.wing].id}-${x.lift}` === task.id);
      if (!tl) return;
      const key = task.id;
      this.liftWork.set(key, (this.liftWork.get(key) ?? 0) + dt);
      if ((this.liftWork.get(key) ?? 0) >= 600) {
        tl.resolved = true;
        ctx.emit({ type: 'lift-freed', level: 'info', text: `${tl.persons} people released from ${this.twin.wings[tl.wing].id} lift ${tl.lift}` });
        if (ctx.field.powerOn && ctx.field.trappedLifts.every((x) => x.resolved)) ctx.field.liftsOn = true;
      }
    } else if (task.kind === 'welfare') {
      if (r.workDone >= 900 && !this.welfareDone.has(task.id)) {
        this.welfareDone.add(task.id);
        ctx.emit({ type: 'welfare', level: 'info', text: `${shortName(r.spec.name)}: welfare checks done, ${task.people} vulnerable residents visited (${task.label.replace('Welfare checks, ', '')})` });
      }
    }
  }

  private routeTo(r: ResourceState, node: number, f: FieldStore) {
    const p = this.travel(r, node, f, true);
    if (!p) {
      r.route = [];
      r.routeLen = 0;
      r.routePos = 0;
      r.approach = null;
      return false;
    }
    r.route = pathPolyline(this.nav, p);
    r.routeLen = 0;
    for (let i = 1; i < r.route.length; i++) r.routeLen += Math.hypot(r.route[i][0] - r.route[i - 1][0], r.route[i][1] - r.route[i - 1][1]);
    r.routePos = 0;
    // explain the approach against the plain fastest one
    const debris = this.viaDebris(p, f);
    const zonesOn = new Set<string>();
    const zonesFast = new Set<string>();
    for (const ei of p.edges) {
      const z = this.risk?.zoneLabel(ei);
      if (z) zonesOn.add(z);
    }
    let alt: string | undefined;
    if (this.risk && this.risk.zones.length) {
      const fast = this.travel(r, node, f, false);
      if (fast && fast.edges.join() !== p.edges.join()) {
        for (const ei of fast.edges) {
          const z = this.risk.zoneLabel(ei);
          if (z && !zonesOn.has(z)) zonesFast.add(z);
        }
        const dt = p.time - fast.time;
        if (zonesFast.size) alt = `Direct route is ${fmt(Math.max(0, dt))} quicker but crosses ${lcFirst([...zonesFast][0])}; taking the safer approach.`;
      }
    }
    const len = Math.round(r.routeLen);
    const via = `${len} m ${r.spec.foot ? 'on foot' : 'by road'}${debris ? ', last stretch on foot over debris' : ''}${zonesOn.size ? `; passes ${lcFirst([...zonesOn][0])}` : ''}`;
    r.approach = { pts: r.route.flatMap(([E, N]) => [Math.round(E * 10) / 10, Math.round(N * 10) / 10, 1.2]), eta_s: Math.round(p.time), via, alt };
    return true;
  }

  private solve(ctx: SimContext) {
    const f = ctx.field;
    const t = ctx.t;
    const slots: { task: Task; k: number }[] = [];
    for (const task of this.tasks) for (let k = 0; k < task.slots; k++) slots.push({ task, k });
    // units on a commanded rescue are not the optimiser's to move
    const rows = this.resources.filter((r) => !r.lock);
    // mutual aid that is no longer needed is stood down instead of driving in for nothing
    const standDown = (r: ResourceState) => {
      if (r.status !== 'called' || t - r.calledAt < 120) return false;
      if (this.tasks.some((x) => this.canDo(r, x) > 0)) {
        this.idleSince.delete(r.spec.id);
        return false;
      }
      // only stand down after three quiet minutes, so a lull between cascades does not recall units
      const since = this.idleSince.get(r.spec.id) ?? t;
      this.idleSince.set(r.spec.id, since);
      if (t - since < 180) return false;
      this.idleSince.delete(r.spec.id);
      r.status = 'offsite';
      r.task = null;
      r.calledAt = -1;
      ctx.emit({ type: 'standdown', level: 'info', text: `${shortName(r.spec.name)} stood down: no task left for it` });
      return true;
    };
    if (!slots.length) {
      for (const r of rows) {
        if (standDown(r)) continue;
        if (r.status === 'enroute' || r.status === 'onscene') r.status = 'standby';
        if (r.status !== 'called') r.task = null;
      }
      this.assignments = [];
      this.pending = [];
      return;
    }
    const arrival: number[][] = [];
    const paths = new Map<string, Travel | null>();
    const score: number[][] = rows.map((r, i) => {
      arrival.push([]);
      return slots.map(({ task, k }) => {
        const cap = this.canDo(r, task);
        if (!cap) {
          arrival[i].push(Infinity);
          return -1e6;
        }
        let eta: number;
        if (r.status === 'offsite') eta = 60 + r.spec.eta_s + 60;
        else if (r.status === 'called') eta = Math.max(0, r.arriveAt - t) + 60;
        else if (r.task === task.id && (r.status === 'onscene' || r.status === 'enroute')) eta = r.status === 'onscene' ? 0 : Math.max(0, (r.routeLen - r.routePos) / r.spec.speed_ms);
        else {
          const key = `${i}|${task.node}`;
          let p = paths.get(key);
          if (p === undefined) {
            p = this.travel(r, task.node, f, true);
            paths.set(key, p);
          }
          eta = p ? p.time : Infinity;
        }
        arrival[i].push(eta);
        if (!(eta < Infinity)) return -1e6;
        const slotPenalty = 1 - 0.3 * k;
        // value decays with arrival time; the tiny linear term only breaks ties, so a far
        // task with people at risk is still worth sending a unit to
        let s = task.value * cap * slotPenalty * Math.exp(-eta / task.tau) - 1e-4 * eta;
        if (r.task === task.id) s *= 1.25; // hysteresis
        return s;
      });
    });
    const assign = hungarian(score.map((row) => row.map((v) => -v)));
    const out: Assignment[] = [];
    rows.forEach((r, i) => {
      const j = assign[i];
      const sc = j >= 0 ? score[i][j] : -1e6;
      if (j < 0 || sc <= 0) {
        if (standDown(r)) return;
        if (r.task && (r.status === 'onscene' || r.status === 'enroute')) {
          r.status = 'standby';
          r.task = null;
        }
        return;
      }
      const { task } = slots[j];
      // runner-up: best other task for this resource
      let ru = -1;
      for (let jj = 0; jj < slots.length; jj++) if (slots[jj].task.id !== task.id && (ru < 0 || score[i][jj] > score[i][ru])) ru = jj;
      const runner = ru >= 0 && score[i][ru] > 0 ? `${slots[ru].task.label} (${Math.round((100 * score[i][ru]) / sc)}% of this score)` : undefined;
      if (r.task !== task.id) {
        r.task = task.id;
        r.workDone = 0;
        if (r.status === 'offsite') {
          r.status = 'called';
          r.calledAt = t;
          r.arriveAt = t + 60 + r.spec.eta_s;
          ctx.emit({ type: 'call', level: 'warn', text: `Mutual aid called: ${shortName(r.spec.name)}, ETA ${Math.round((60 + r.spec.eta_s) / 60)} min`, data: { kind: r.spec.kind } });
        } else if (r.status !== 'called') {
          if (this.routeTo(r, task.node, f)) r.status = 'enroute';
        }
        const key = `${r.spec.id}->${task.id}`;
        if (!this.reported.has(key)) {
          this.reported.add(key);
          ctx.emit({ type: 'assign', level: 'info', text: `${shortName(r.spec.name)} → ${task.label}: ${task.reason}`, wing: task.wing >= 0 ? task.wing : undefined, data: { kind: r.spec.kind, task: task.kind } });
        }
      }
      const debris = this.viaDebris(paths.get(`${i}|${task.node}`) ?? null, f);
      out.push({ resource: r.spec.id, resourceName: r.spec.name, kind: r.spec.kind, task: task.id, taskLabel: task.label, status: r.status, eta_s: Math.round(arrival[i][j]), score: Math.round(sc), reason: debris ? `${task.reason}; route crosses debris, last stretch on foot` : task.reason, runnerUp: runner });
    });
    this.assignments = out;
    const covered = new Set(out.map((a) => a.task));
    this.pending = this.tasks.filter((x) => !covered.has(x.id)).map((x) => {
      const able = rows.filter((r) => this.canDo(r, x) > 0);
      const reason = !able.length ? 'no unit on the roster has the skills for this' : able.every((r) => r.task && covered.has(r.task)) ? `all ${able.length} capable units are busy on higher-value tasks` : 'capable units cannot reach it in time';
      return { task: x.id, label: x.label, reason: `${x.reason} · ${reason}`, people: x.people };
    });
  }

  // ---------------------------------------------------------------- commanded rescues
  /**
   * Take a unit for a rescue operation: it is sent to `node` (called in first if it is
   * off site) and stays there, out of the optimiser's hands, until released.
   */
  lock(unitId: string, op: string, node: number, label: string, wing: number, ctx: SimContext): ResourceState | null {
    const r = this.resources.find((x) => x.spec.id === unitId);
    if (!r) return null;
    r.lock = { op, node, label, wing };
    r.task = null;
    r.workDone = 0;
    if (r.status === 'offsite') {
      r.status = 'called';
      r.calledAt = ctx.t;
      r.arriveAt = ctx.t + 60 + r.spec.eta_s;
      ctx.emit({ type: 'call', level: 'warn', text: `${shortName(r.spec.name)} called in for ${label}, about ${Math.round((60 + r.spec.eta_s) / 60)} min away`, data: { kind: r.spec.kind } });
    } else if (r.status !== 'called') {
      this.sendTo(r, node, ctx.field);
    }
    this.assignments = this.assignments.filter((a) => a.resource !== unitId);
    return r;
  }

  /** Move a locked unit to another spot (e.g. to put its ladder at another window). */
  relocate(unitId: string, node: number, f: FieldStore): boolean {
    const r = this.resources.find((x) => x.spec.id === unitId);
    if (!r || !r.lock) return false;
    r.lock.node = node;
    if (r.status === 'called') return true;
    return this.sendTo(r, node, f);
  }

  private sendTo(r: ResourceState, node: number, f: FieldStore): boolean {
    if (r.node === node && (r.status === 'onscene' || r.status === 'standby')) {
      r.status = 'onscene';
      r.route = [];
      return true;
    }
    if (this.routeTo(r, node, f)) {
      r.status = 'enroute';
      return true;
    }
    return false;
  }

  /** Hand a unit back to the optimiser. */
  unlock(unitId: string): void {
    const r = this.resources.find((x) => x.spec.id === unitId);
    if (!r || !r.lock) return;
    r.lock = null;
    if (r.status === 'onscene' || r.status === 'enroute') r.status = 'standby';
    this.next = 0; // re-solve on the next step
  }

  /** Where to park for a wing (outside hazard zones, upwind of fire). */
  stagingNode(w: number, f: FieldStore): { node: number; note: string } {
    return this.stagingFor(w, f, wingFire(this.twin, f, w).rooms > 0);
  }

  /** The drivable street point nearest (E, N) among the kerbs around a wing. */
  nearestDrivable(E: number, N: number, wing: number): { node: number; d: number } {
    let best = { node: this.staging[wing] ?? this.gateS, d: Infinity };
    for (const c of this.stagingCands[wing] ?? []) {
      const n = this.nav.nodes[c.node];
      const d = Math.hypot(n.E - E, n.N - N);
      if (d < best.d) best = { node: c.node, d };
    }
    return best;
  }

  /** What the rescue planner needs about every unit working a task with people in it. */
  rescueInputs(t: number): RescueInput[] {
    const out: RescueInput[] = [];
    for (const r of this.resources) {
      if (r.lock) continue;
      if (!r.task || (r.status !== 'enroute' && r.status !== 'onscene' && r.status !== 'called')) continue;
      const task = this.tasks.find((x) => x.id === r.task);
      if (!task || task.kind === 'traffic') continue;
      out.push({
        unit: r.spec.id, unitName: r.spec.name, kind: r.spec.kind, status: r.status, heavy: r.spec.capabilities.includes('heavy_rescue'),
        task: { id: task.id, kind: task.kind, label: task.label, wing: task.wing, people: task.people },
        staging: task.node, stagingNote: task.stagingNote, target: task.target,
        approach: r.status === 'called' ? { pts: [], eta_s: Math.max(0, Math.round(r.arriveAt - t)), via: 'called in: drives to the site entry, then to staging' } : r.approach,
      });
    }
    return out;
  }

  pack(): { id: string; kind: string; status: ResourceStatus; E: number; N: number; route: [number, number, number][] }[] {
    return this.resources.map((r) => ({ id: r.spec.id, kind: r.spec.kind, status: r.status, E: r.E, N: r.N, route: r.status === 'enroute' ? r.route : [] }));
  }
}

function alongPolyline(pts: [number, number, number][], s: number): [number, number] {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= s) {
      const t = seg ? (s - acc) / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    acc += seg;
  }
  const l = pts[pts.length - 1];
  return [l[0], l[1]];
}
export * from './operations';
