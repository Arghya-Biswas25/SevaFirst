/**
 * Route planner (design §4): for every focus wing and occupied floor, the recommended,
 * fastest and safest evacuation routes, a route per stair, and the routes to avoid
 * with the reason; for every responder task, the approach, staging, entry path and
 * extraction route. Runs in the simulation worker every planning interval.
 */
import { enToLocal } from '@twin/core';
import type { FieldStore } from '@twin/hazard-sdk';
import { multiSourceCosts, type NavEdge, type NavGraph } from '@twin/nav';
import { spaceTemplate, type Twin } from '@twin/twin-data';
import { BASE_SPEED, edgeDamage, edgeSmokeTenability, edgeTemp, edgeTenability, edgeVisibility, responderTime, walkSpeed, walkTime, DEBRIS_SLOW, UNTENABLE } from './model';
import type { EdgeRisk } from './risk';
import { descend, pathPoints, SearchSpace, type EdgeCost } from './search';
import { LABEL_ORDER, riskBand, type FloorPlan, type PlanRoute, type PlanSet, type RescueLeg, type RescuePlan, type RouteLabel, type RouteMetrics, type WingPlan } from './types';

/** The crowd's own routing field, handed in so "recommended" is exactly what people are told. */
export interface RecommendedField {
  field: Float64Array;
  cost: EdgeCost;
  goals: number[];
  offsets: number[];
}

export interface RescueInput {
  unit: string;
  unitName: string;
  kind: string;
  status: string;
  heavy: boolean;
  task: { id: string; kind: string; label: string; wing: number; people: number };
  staging: number;
  stagingNote: string;
  /** node of the people (or the fire floor) the unit is working toward */
  target: number;
  approach: { pts: number[]; eta_s: number; via: string; alt?: string } | null;
}

export interface PlanInput {
  t: number;
  field: FieldStore;
  risk: EdgeRisk;
  rec: RecommendedField;
  /** committed people per edge (for queue estimates) */
  load?: Float32Array;
  /** people still inside, key `wing * 32 + storey` */
  inside: Map<number, number>;
  focus: { wing: number; why: string }[];
  rescues: RescueInput[];
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const fmt = (s: number) => {
  const v = Math.max(0, Math.round(s));
  return v < 60 ? `${v} s` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

interface Candidate {
  model: 'recommended' | 'fastest' | 'safest' | 'stair' | 'avoid';
  edges: number[];
  nodes: number[];
  blockedReason?: string;
}

export class Planner {
  version = 0;
  plans: PlanSet = { version: 0, t: 0, wings: [], rescues: [], zones: [] };
  private space: SearchSpace;
  /** corridor node of each (wing, storey), key wing*32+storey */
  private corridorOf = new Map<number, number>();
  /** stair id of each stair node */
  private stairOf = new Map<number, string>();
  private stairsOfWing: string[][] = [];
  /** outdoor fastest/safest fields, reused until the zones, open goals or their load change */
  private fieldCache: { key: string; fast: Float64Array; safe: Float64Array } | null = null;

  constructor(private twin: Twin, private nav: NavGraph) {
    this.space = new SearchSpace(nav);
    for (const w of twin.wings) this.stairsOfWing.push([]);
    // the corridor node nearest each floor's centre represents the floor
    const bestD = new Map<number, number>();
    for (const n of nav.nodes) {
      if (n.wing < 0) continue;
      if (n.kind === 'stair' && n.space >= 0) {
        const id = spaceTemplate(twin, n.space).stairId ?? 'S?';
        this.stairOf.set(n.id, id);
        if (!this.stairsOfWing[n.wing].includes(id)) this.stairsOfWing[n.wing].push(id);
      }
      if (n.kind !== 'corridor' && n.kind !== 'lobby') continue;
      const w = twin.wings[n.wing];
      const [x] = enToLocal(w.pose, n.E, n.N);
      const key = n.wing * 32 + n.storey;
      const d = Math.abs(x);
      if (d < (bestD.get(key) ?? Infinity)) {
        bestD.set(key, d);
        this.corridorOf.set(key, n.id);
      }
    }
    for (const s of this.stairsOfWing) s.sort();
  }

  // ---------------------------------------------------------------- cost models
  private fastCost = (f: FieldStore): EdgeCost => (e) => walkTime(f, e);
  private safeCost = (f: FieldStore, risk: EdgeRisk): EdgeCost => (e) => {
    const t = walkTime(f, e);
    if (!(t < Infinity)) return Infinity;
    const h = Math.max(1 - edgeTenability(f, e), risk.risk[e.id]);
    return t * (1 + 25 * h * h) + 40 * h;
  };
  /** geometry only: used to find where an impassable stair is blocked */
  private geomCost: EdgeCost = (e) => (e.kind === 'lift' ? Infinity : e.len / BASE_SPEED[e.kind]);

  private stairOfEdge(e: NavEdge): string | null {
    if (e.kind !== 'stair') return null;
    return this.stairOf.get(e.a) ?? this.stairOf.get(e.b) ?? null;
  }

  private exitLabel(node: number): string {
    const n = this.nav.nodes[node];
    if (n.wing < 0) return 'exit';
    const w = this.twin.wings[n.wing];
    const [x, y] = enToLocal(w.pose, n.E, n.N);
    let nx = 0;
    let ny = 0;
    if (Math.abs(x) > w.L / 2 - 0.2) nx = Math.sign(x);
    else ny = Math.sign(y) || 1;
    const b = (w.pose.bearing * Math.PI) / 180;
    const dE = nx * Math.sin(b) - ny * Math.cos(b);
    const dN = nx * Math.cos(b) + ny * Math.sin(b);
    const deg = ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360;
    return `${COMPASS[Math.round(deg / 45) % 8]} exit`;
  }

  // ---------------------------------------------------------------- evaluation
  /** Walk a path with the crowd's speed model and report what an evacuee meets on it. */
  evaluate(f: FieldStore, risk: EdgeRisk, edges: number[], load?: Float32Array): RouteMetrics {
    const nav = this.nav;
    let walk = 0;
    let queue = 0;
    let dist = 0;
    let dose = 0;
    let minVis = 300;
    let maxT = 20;
    let stairs = 0;
    let debris = 0;
    let damaged = 0;
    let H = 0;
    const zones = new Set<string>();
    for (const ei of edges) {
      const e = nav.edges[ei];
      const ten = edgeTenability(f, e);
      const v = walkSpeed(e, f, ten);
      const blocked = e.street >= 0 && f.blockedStreet[e.street] === 1;
      const te = (e.len / v) * (blocked ? DEBRIS_SLOW : 1);
      walk += te;
      dist += e.len;
      if (load && (e.kind === 'door' || e.kind === 'stair')) queue += Math.min(300, (0.5 * load[ei]) / Math.max(0.3, e.capacity));
      const h = Math.max(1 - ten, risk.risk[ei]);
      H += (te * h) / 60;
      // smoke dose counts smoke and heat only; damage is in H and reported separately
      const st = edgeSmokeTenability(f, e);
      if (st < 0.5) dose += (te * (1 - st)) / 90;
      if (edgeDamage(f, e) === 3) damaged++;
      minVis = Math.min(minVis, edgeVisibility(f, e));
      maxT = Math.max(maxT, edgeTemp(f, e));
      if (e.kind === 'stair') stairs++;
      if (blocked) debris++;
      const z = risk.zoneLabel(ei);
      if (z) zones.add(z);
    }
    const r = Math.round(100 * (1 - Math.exp(-(H + 3 * dose + 0.4 * debris))));
    return {
      time_s: Math.round(walk + queue), walk_s: Math.round(walk), queue_s: Math.round(queue), dist_m: Math.round(dist), dose: Math.round(dose * 1000) / 1000,
      minVis_m: Math.round(minVis * 10) / 10, maxTemp_C: Math.round(maxT), risk: r, band: riskBand(r), stairs, debris, damaged, zones: [...zones],
    };
  }

  /** Why an edge is impassable for evacuees, in plain words. */
  private blockReason(f: FieldStore, e: NavEdge): string {
    // name the worst of the edge's two spaces ("Corridor 2, floor 2"), not just the edge
    const sp = [e.space, e.space2].filter((s) => s >= 0);
    if (!sp.length) return 'blocked';
    const worst = sp.reduce((a, b) => (f.tenability[b] < f.tenability[a] ? b : a), sp[0]);
    const storey = this.twin.space.storey[worst];
    const where = `${spaceTemplate(this.twin, worst).name}, floor ${storey === 0 ? 'G' : storey}`;
    if (f.damage[worst] >= 4) return `${where} collapsed`;
    if (f.burn[worst] === 1 || f.burn[worst] === 2) return `${where} on fire`;
    const vis = f.visibility(worst);
    const T = f.temp[worst];
    const what = vis < 10 && T > 60 ? 'full of hot smoke' : vis < 10 ? 'full of smoke' : T > 60 ? 'too hot' : f.damage[worst] >= 3 ? 'badly damaged' : 'unsafe';
    return `${where} ${what}: visibility ${vis >= 300 ? 'clear' : `${vis.toFixed(1)} m`}, ${Math.round(T)} °C`;
  }

  /**
   * Indoor leg by a local search inside the wing (ending at any exit, plus the field's
   * cost from there), then the outdoor leg by descending the field.
   */
  private wingRoute(origin: number, wing: number, field: Float64Array, cost: EdgeCost, goals: Set<number>, indoorCost: EdgeCost = cost) {
    const nav = this.nav;
    const local = this.space.run(origin, (e, u) => (e.wing === wing ? indoorCost(e, u) : Infinity), (n) => (nav.nodes[n].kind === 'exit' && nav.nodes[n].wing === wing ? field[n] : Infinity));
    if (!local || !(local.total < Infinity)) return null;
    const out = descend(nav, local.goal, field, cost, (n) => goals.has(n));
    if (!out) return null;
    return { edges: [...local.edges, ...out.edges], nodes: [...local.nodes, ...out.nodes.slice(1)], goal: out.goal };
  }

  // ---------------------------------------------------------------- one floor
  private floorPlan(inp: PlanInput, w: number, storey: number, fields: { fast: Float64Array; safe: Float64Array; goals: Set<number> }): FloorPlan | null {
    const origin = this.corridorOf.get(w * 32 + storey);
    if (origin === undefined) return null;
    const f = inp.field;
    const nav = this.nav;
    const people = inp.inside.get(w * 32 + storey) ?? 0;
    const inWing = (c: EdgeCost): EdgeCost => (e, u) => (e.wing === w ? c(e, u) : Infinity);
    const models: { model: Candidate['model']; field: Float64Array; cost: EdgeCost }[] = [
      { model: 'recommended', field: inp.rec.field, cost: inp.rec.cost },
      { model: 'fastest', field: fields.fast, cost: this.fastCost(f) },
      { model: 'safest', field: fields.safe, cost: this.safeCost(f, inp.risk) },
    ];
    const cands: Candidate[] = [];
    const full = (model: Candidate['model'], field: Float64Array, cost: EdgeCost, indoorCost: EdgeCost) => {
      const r = this.wingRoute(origin, w, field, cost, fields.goals, indoorCost);
      if (!r) return false;
      cands.push({ model, edges: r.edges, nodes: r.nodes });
      return true;
    };
    for (const m of models) full(m.model, m.field, m.cost, m.cost);
    // one route per stair (the others closed), and the reason a stair cannot be used
    const stairs = this.stairsOfWing[w];
    for (const s of stairs) {
      const only: EdgeCost = (e, u) => {
        const id = this.stairOfEdge(e);
        return id && id !== s ? Infinity : inp.rec.cost(e, u);
      };
      if (full('stair', inp.rec.field, inp.rec.cost, only)) continue;
      // blocked: find the geometry with hazards ignored and the first impassable edge on it
      const geomOnly: EdgeCost = (e, u) => {
        const id = this.stairOfEdge(e);
        return id && id !== s ? Infinity : this.geomCost(e, u);
      };
      const g = this.space.run(origin, inWing(geomOnly), (n) => (nav.nodes[n].kind === 'exit' && nav.nodes[n].wing === w ? 0 : Infinity));
      if (!g) continue;
      const bad = g.edges.find((ei) => !(walkTime(f, nav.edges[ei]) < Infinity));
      if (bad === undefined) continue; // usable only via another stair segment; covered by the others
      cands.push({ model: 'avoid', edges: g.edges, nodes: g.nodes, blockedReason: this.blockReason(f, nav.edges[bad]) });
    }
    // merge identical routes, evaluate, label
    const byKey = new Map<string, { c: Candidate; models: Set<Candidate['model']> }>();
    for (const c of cands) {
      const key = c.edges.join(',');
      const ex = byKey.get(key);
      if (ex) ex.models.add(c.model);
      else byKey.set(key, { c, models: new Set([c.model]) });
    }
    const routes: (PlanRoute & { _models: Set<Candidate['model']> })[] = [];
    for (const [key, { c, models: ms }] of byKey) {
      const m = this.evaluate(f, inp.risk, c.edges, inp.load);
      const stairE = c.edges.map((ei) => nav.edges[ei]).find((e) => e.kind === 'stair');
      const stair = stairE ? this.stairOfEdge(stairE) : null;
      const exitNode = c.nodes.find((n) => nav.nodes[n].kind === 'exit' && nav.nodes[n].wing === w);
      const exit = exitNode !== undefined ? this.exitLabel(exitNode) : null;
      const last = nav.nodes[c.nodes[c.nodes.length - 1]];
      const goal = last.kind === 'assembly' ? last.ref ?? null : null;
      const blocked = ms.has('avoid');
      const via = blocked
        ? `Stair ${stair ?? '?'} — blocked`
        : [stair ? `Stair ${stair}` : storey === 0 ? 'Ground floor' : 'Stairs', exit, goal].filter(Boolean).join(' → ');
      routes.push({
        id: `${w}:${storey}:${hash(key)}`, labels: [], via, stair, exit, goal, pts: pathPoints(nav, c.nodes, c.edges), m,
        notes: c.blockedReason ? [c.blockedReason] : [], _models: ms,
      });
    }
    const open = routes.filter((r) => !r._models.has('avoid'));
    // where the crowd model is sending residents now
    const crowd = open.find((r) => r._models.has('recommended'));
    if (crowd) crowd.current = true;
    // recommended = best balance of time and risk: J = time x (1 + risk / 50), so a route that
    // is both slower and riskier than another can never be recommended
    const J = (r: PlanRoute) => r.m.time_s * (1 + r.m.risk / 50);
    let fastest = open[0];
    let safest = open[0];
    let rec = open[0];
    for (const r of open) {
      if (r.m.time_s < fastest.m.time_s || (r.m.time_s === fastest.m.time_s && r.m.risk < fastest.m.risk)) fastest = r;
      if (r.m.risk < safest.m.risk || (r.m.risk === safest.m.risk && r.m.time_s < safest.m.time_s)) safest = r;
      if (J(r) < J(rec) - 0.5 || (Math.abs(J(r) - J(rec)) <= 0.5 && r === crowd)) rec = r;
    }
    for (const r of routes) {
      if (r._models.has('avoid')) r.labels.push('avoid');
      else {
        if (r === rec) r.labels.push('recommended');
        if (r === fastest) r.labels.push('fastest');
        if (r === safest) r.labels.push('safest');
        if (!r.labels.length) r.labels.push('alternative');
      }
    }
    // notes comparing against the recommended route
    const offsetOf = new Map(inp.rec.goals.map((g, i) => [nav.nodes[g].ref ?? '', inp.rec.offsets[i] ?? 0]));
    for (const r of open) {
      const n = r.notes;
      if (r === rec) {
        n.push(r === fastest && r === safest ? 'Quickest and safest way out.' : 'Best mix of speed and safety.');
        // only worth a warden's attention when the crowd's choice is clearly worse
        if (crowd && crowd !== r && (crowd.m.risk - r.m.risk >= 10 || J(crowd) > 1.25 * J(r))) n.push(`Most people here are going ${crowd.via} instead. Wardens should send them this way.`);
      } else if (rec) {
        if (r === crowd) n.push('The way most people are going now.');
        const dt = rec.m.time_s - r.m.time_s;
        if (dt > 3) n.push(`${fmt(dt)} quicker${r.m.risk > rec.m.risk ? ', but more dangerous' : ''}.`);
        else if (dt < -3) n.push(`${fmt(-dt)} slower${r.m.risk < rec.m.risk ? ', but safer' : ''}.`);
        if (r.goal && r.goal !== rec.goal && (offsetOf.get(r.goal) ?? 0) > 0) n.push(`${r.goal} is filling up.`);
      }
      if (r.m.minVis_m < 10) n.push(`Smoky: you can see about ${Math.max(1, Math.round(r.m.minVis_m))} m.`);
      if (r.m.maxTemp_C > 45) n.push(`Hot air, up to ${r.m.maxTemp_C} °C.`);
      for (const z of r.m.zones.slice(0, 2)) n.push(`Passes ${z.charAt(0).toLowerCase()}${z.slice(1).replace(/: .*$/, '')}.`);
      if (r.m.damaged) n.push('Goes through damaged parts of the building.');
      if (r.m.debris) n.push('Climbs over rubble in the street.');
      if (r.m.queue_s > 20) n.push(`About ${fmt(r.m.queue_s)} of queueing at doors and stairs.`);
    }
    routes.sort((a, b) => LABEL_ORDER.indexOf(a.labels[0]) - LABEL_ORDER.indexOf(b.labels[0]) || a.m.time_s - b.m.time_s);
    const out: PlanRoute[] = routes.map(({ _models, ...r }) => r);
    const best = rec ?? safest;
    if (best) {
      return { storey, people, advice: 'evacuate', best: best.id, summary: `${best.via} · ${fmt(best.m.time_s)} · ${best.m.band} risk`, routes: out };
    }
    const avoid = out.find((r) => r.labels.includes('avoid'));
    const corridorBad = nav.nodes[origin].space >= 0 && f.tenability[nav.nodes[origin].space] < UNTENABLE;
    const why = avoid?.notes[0] ?? (corridorBad ? `the corridor on floor ${storey} is full of smoke` : 'no safe way down');
    return { storey, people, advice: 'shelter', best: null, summary: `No safe way out (${why.charAt(0).toLowerCase()}${why.slice(1)}). Stay in the flat with the door shut, block the gaps with wet cloth and wave from the balcony.`, routes: out };
  }

  // ---------------------------------------------------------------- rescue
  private rescuePlan(inp: PlanInput, r: RescueInput, safe: Float64Array, goals: Set<number>): RescuePlan {
    const nav = this.nav;
    const f = inp.field;
    const st = nav.nodes[r.staging];
    const plan: RescuePlan = {
      id: `${r.unit}>${r.task.id}`, unit: r.unit, unitName: r.unitName, kind: r.kind, status: r.status, task: r.task.id, taskKind: r.task.kind,
      taskLabel: r.task.label, wing: r.task.wing, people: r.task.people, approach: r.approach ? { ...r.approach, time_s: r.approach.eta_s, notes: [] } : null,
      staging: { E: st.E, N: st.N, note: r.stagingNote }, entry: null, extraction: null,
    };
    if (r.target < 0) return plan;
    const T = nav.nodes[r.target];
    const h = (n: number) => {
      const a = nav.nodes[n];
      // admissible: no responder moves faster than 1.25 x 0.85 m/s
      return Math.hypot(a.E - T.E, a.N - T.N, a.z - T.z) / 1.07;
    };
    const cost: EdgeCost = (e) => responderTime(f, e, r.heavy);
    const p = this.space.run(r.staging, cost, (n) => (n === r.target ? 0 : Infinity), h, 30000);
    if (p) {
      const stairE = p.edges.map((ei) => nav.edges[ei]).find((e) => e.kind === 'stair');
      const stair = stairE ? this.stairOfEdge(stairE) : null;
      let minVis = 300;
      let maxT = 20;
      let debris = 0;
      for (const ei of p.edges) {
        const e = nav.edges[ei];
        minVis = Math.min(minVis, edgeVisibility(f, e));
        maxT = Math.max(maxT, edgeTemp(f, e));
        if (e.street >= 0 && f.blockedStreet[e.street]) debris++;
      }
      const notes: string[] = [];
      if (r.task.kind === 'fire' && stair) notes.push(`Attack stair: Stair ${stair}, nearest the fire; keep residents on the other stair where there is one.`);
      if (minVis < 10) notes.push(`Breathing apparatus: visibility ${minVis.toFixed(1)} m on the way in.`);
      if (maxT > 60) notes.push(`Hot gas up to ${Math.round(maxT)} °C: hose line before entry.`);
      if (debris) notes.push(`Kit carried over debris on ${debris} street segment${debris === 1 ? '' : 's'}.`);
      if (r.heavy && p.edges.some((ei) => edgeDamage(f, nav.edges[ei]) >= 4)) notes.push('Shoring and breaching through collapsed bays.');
      plan.entry = { pts: pathPoints(nav, p.nodes, p.edges), time_s: Math.round(p.cost), via: `${stair ? `Stair ${stair}` : 'ground floor'} to floor ${T.storey}`, notes, stair, storey: T.storey };
      if (r.task.kind === 'medical') {
        plan.extraction = { pts: pathPoints(nav, [...p.nodes].reverse(), [...p.edges].reverse()), time_s: Math.round(p.cost * 1.6), via: 'stretcher back to the ambulance at staging', notes: [] };
      }
    }
    if (r.task.kind === 'rescue' || r.task.kind === 'lift' || r.task.kind === 'welfare') {
      const sc = this.safeCost(f, inp.risk);
      const tw = nav.nodes[r.target].wing;
      const out = tw >= 0 ? this.wingRoute(r.target, tw, safe, sc, goals) : descend(nav, r.target, safe, sc, (n) => goals.has(n));
      if (out) {
        const m = this.evaluate(f, inp.risk, out.edges, inp.load);
        const last = nav.nodes[out.goal];
        plan.extraction = { pts: pathPoints(nav, out.nodes, out.edges), time_s: Math.round(m.walk_s * 1.4), via: `escorted out to ${last.ref ?? 'the assembly point'} by the safest route`, notes: m.zones.slice(0, 1).map((z) => `Crosses ${z.charAt(0).toLowerCase()}${z.slice(1)}`) };
      } else if (p) {
        // no tenable walking route from the flat: bring them out the way the crew came in
        // (escape hoods through the smoke), then on from staging by the safest route
        const back = descend(nav, r.staging, safe, sc, (n) => goals.has(n));
        const nodes = [...p.nodes].reverse();
        const edges = [...p.edges].reverse();
        let pts = pathPoints(nav, nodes, edges);
        let tail = 0;
        let to = 'staging';
        if (back) {
          pts = pts.concat(pathPoints(nav, back.nodes, back.edges));
          tail = this.evaluate(f, inp.risk, back.edges).walk_s;
          to = nav.nodes[back.goal].ref ?? 'the assembly point';
        }
        plan.extraction = { pts, time_s: Math.round(p.cost * 1.5 + tail), via: `escorted with escape hoods back along the entry path, then to ${to}`, notes: ['No tenable walking route from the flat: residents need escape hoods or a ladder.'] };
      }
    }
    return plan;
  }

  // ---------------------------------------------------------------- entry point
  plan(inp: PlanInput): PlanSet {
    const f = inp.field;
    const goals = inp.rec.goals;
    const goalSet = new Set(goals);
    // Indoor legs come from local searches, so these fields only cover the outdoor network
    // (streets, links, exits); outdoors the cost depends only on zones and debris, so the
    // fields are reused until the zones, the open assembly points or their load change.
    const offsets = inp.rec.offsets.map((o) => o * 0.5);
    const key = `${inp.risk.version}|${goals.join(',')}|${offsets.map((o) => Math.round(o / 10)).join(',')}`;
    if (!this.fieldCache || this.fieldCache.key !== key) {
      const outdoor = (c: EdgeCost): EdgeCost => (e, u) => (e.kind === 'road' || e.kind === 'link' ? c(e, u) : Infinity);
      this.fieldCache = {
        key,
        fast: multiSourceCosts(this.nav, goals, outdoor(this.fastCost(f))),
        safe: multiSourceCosts(this.nav, goals, outdoor(this.safeCost(f, inp.risk)), offsets),
      };
    }
    const { fast, safe } = this.fieldCache;
    const wings: WingPlan[] = [];
    for (const { wing, why } of inp.focus) {
      const w = this.twin.wings[wing];
      if (!w || w.massingOnly) continue;
      const floors: FloorPlan[] = [];
      for (let s = 0; s < w.storeys; s++) {
        if (w.storeyKinds[s] === 'ground') continue;
        const fp = this.floorPlan(inp, wing, s, { fast, safe, goals: goalSet });
        if (fp) floors.push(fp);
      }
      if (!floors.length) continue;
      const score = (fp: FloorPlan) => (fp.advice === 'shelter' ? 1000 : fp.routes.find((r) => r.id === fp.best)?.m.risk ?? 0) + (fp.people ? 0.5 : 0);
      const critical = floors.reduce((a, b) => (score(b) > score(a) ? b : a), floors[0]).storey;
      wings.push({ wing, id: w.id, why, critical, strategy: strategyOf(floors), floors });
    }
    const rescues = inp.rescues.map((r) => this.rescuePlan(inp, r, safe, goalSet));
    this.version++;
    this.plans = { version: this.version, t: inp.t, wings, rescues, zones: inp.risk.zones };
    return this.plans;
  }

  /** Empty plan set (scenario reset). */
  clear(): void {
    this.fieldCache = null;
    this.version++;
    this.plans = { version: this.version, t: 0, wings: [], rescues: [], zones: [] };
  }
}

/** "Floors 1–3 via Stair S1 · Floors 4–5 via Stair S2 · Floor 2 shelter in place" */
function strategyOf(floors: FloorPlan[]): string {
  const groups: { key: string; floors: number[] }[] = [];
  for (const fp of floors) {
    const best = fp.routes.find((r) => r.id === fp.best);
    const key = fp.advice === 'shelter' ? 'stay inside' : best?.stair ? `via Stair ${best.stair}` : 'out at ground level';
    const g = groups.find((x) => x.key === key);
    if (g) g.floors.push(fp.storey);
    else groups.push({ key, floors: [fp.storey] });
  }
  return groups
    .map((g) => {
      const fl = g.floors.sort((a, b) => a - b);
      const name = (s: number) => (s === 0 ? 'G' : String(s));
      const span = fl.length === 1 ? `Floor ${name(fl[0])}` : contiguous(fl) ? `Floors ${name(fl[0])}–${name(fl[fl.length - 1])}` : `Floors ${fl.map(name).join(', ')}`;
      return `${span} ${g.key}`;
    })
    .join(' · ');
}

function contiguous(a: number[]): boolean {
  for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1] + 1) return false;
  return true;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export type { RescueLeg, RouteLabel };
