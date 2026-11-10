/**
 * SimEngine — runs inside a Web Worker (or in Node for tests). Owns the twin, the
 * navigation graph, the shared hazard field and every engine, and advances them on
 * a fixed 0.5 s tick. Deterministic for a given scenario seed.
 *
 * Per tick: hazards write the field → tenability → outdoor hazard zones and edge risk
 * (every 2 s) → crowd → dispatch → advisor (2 s) → route planner (every planning
 * interval) → playbook (1 s). See docs/RESPONSE_DESIGN.md.
 */
import { Rng } from '@twin/core';
import { FieldStore, type HazardInstance, type HazardPlugin, type SimContext, type SimEvent } from '@twin/hazard-sdk';
import type { HazardSpec, Scenario, SiteDataset } from '@twin/twin-schema';
import { buildTwin, type Twin } from '@twin/twin-data';
import { buildNavGraph, type NavGraph } from '@twin/nav';
import { Evacuation } from '@twin/crowd';
import { Dispatcher, RescueOps } from '@twin/dispatch';
import { Playbook, recommend, type Recommendation } from '@twin/advisor';
import { EdgeRisk, Planner, wingFire } from '@twin/routing';
import { hazards } from './registry';
import type { Snapshot, StartOptions } from './protocol';

export const TICK = 0.5;
const DAMAGE_WORD = ['', 'slightly damaged', 'damaged', 'badly damaged', 'collapsed'];

export class SimEngine {
  readonly twin: Twin;
  readonly nav: NavGraph;
  field!: FieldStore;
  evac!: Evacuation;
  dispatch!: Dispatcher;
  /** incidents and the rescues the user starts on them */
  ops!: RescueOps;
  readonly risk: EdgeRisk;
  readonly planner: Planner;
  readonly playbook = new Playbook();
  rng = new Rng(1);
  t = 0;
  running = false;
  speed = 1;
  scenario: Scenario | null = null;
  /** wing the user is looking at: always planned */
  focusWing: number | null = null;
  private active: { spec: HazardSpec; plugin: HazardPlugin; inst: HazardInstance; startedAt: number }[] = [];
  private queue: HazardSpec[] = [];
  private events: SimEvent[] = [];
  private outbox: SimEvent[] = [];
  private firstSeen = new Map<string, number>();
  private recs: Recommendation[] = [];
  private nextAdvice = 0;
  private nextPlan = 0;
  private nextPlaybook = 0;
  private sentPlan = -1;
  private sentPlaybook = -1;
  private sentIncidents = -1;
  private lastStepMs = 0;
  readonly buildMs: number;

  constructor(readonly ds: SiteDataset) {
    const t0 = performance.now();
    this.twin = buildTwin(ds);
    this.nav = buildNavGraph(this.twin);
    this.risk = new EdgeRisk(this.twin, this.nav);
    this.planner = new Planner(this.twin, this.nav);
    this.buildMs = performance.now() - t0;
    this.reset(null, { launchedOnly: false });
  }

  private get wind() {
    return this.scenario?.wind ?? { speed_ms: 4, fromDeg: 250 };
  }

  private ctx(): SimContext {
    return {
      twin: this.twin,
      field: this.field,
      rng: this.rng,
      t: this.t,
      wind: this.wind,
      emit: (ev) => {
        const e = { ...ev, t: this.t };
        this.events.push(e);
        this.outbox.push(e);
        if (!this.firstSeen.has(e.type)) this.firstSeen.set(e.type, this.t);
      },
      spawn: (spec) => this.queue.push({ ...spec, t: Math.max(spec.t, this.t) }),
      alert: (wings, _reason, delay = 120) => this.evac.alert(wings, this.t, delay),
      alertAll: (_reason, delay = 60) => this.evac.alertAll(this.t, delay),
    };
  }

  reset(scenario: Scenario | null, options: StartOptions): void {
    this.scenario = scenario;
    this.rng = new Rng(scenario?.seed ?? 1);
    this.t = 0;
    this.field = new FieldStore(this.twin);
    this.risk.reset();
    this.evac = new Evacuation(this.twin, this.nav, this.ds, scenario?.occupancy ?? 'weekday-night', this.rng.fork(7), { ...options, risk: this.risk });
    this.dispatch = new Dispatcher(this.twin, this.nav, this.ds, { ...(scenario?.resources ?? {}), risk: this.risk });
    this.ops = new RescueOps(this.twin, this.nav, this.dispatch, this.evac);
    this.sentIncidents = -1;
    this.active = [];
    this.queue = scenario ? [...scenario.hazards] : [];
    this.events = [];
    this.outbox = [];
    this.firstSeen.clear();
    this.recs = [];
    this.nextAdvice = 0;
    this.nextPlan = 0;
    this.nextPlaybook = 0;
    this.planner.clear();
    this.playbook.reset();
  }

  start(scenario: Scenario, options: StartOptions): void {
    this.reset(scenario, options);
    this.running = true;
  }

  inject(spec: HazardSpec): void {
    this.queue.push({ ...spec, t: this.t });
  }

  /** Start a rescue at an incident; the result is also reported as an event. */
  startRescue(incident: string): { ok: boolean; reason?: string; op?: string } {
    if (!this.scenario) return { ok: false, reason: 'No simulation running' };
    const ctx = this.ctx();
    this.ops.update(ctx);
    const res = this.ops.start(incident, ctx);
    if (!res.ok) ctx.emit({ type: 'rescue-error', level: 'warn', text: `Can't start that rescue: ${res.reason}` });
    this.ops.update(ctx);
    return res;
  }

  stopRescue(op: string): void {
    if (!this.scenario) return;
    const ctx = this.ctx();
    this.ops.stop(op, ctx);
    this.ops.update(ctx);
  }

  /** Plan this wing from now on (null: automatic focus only) and re-plan immediately. */
  focus(wing: number | null): void {
    this.focusWing = wing;
    if (this.scenario) {
      this.risk.update(this.field, this.t, this.wind, true);
      this.replan();
    }
  }

  private spawnDue(ctx: SimContext) {
    const due = this.queue.filter((q) => q.t <= this.t);
    this.queue = this.queue.filter((q) => q.t > this.t);
    for (const spec of due) {
      const plugin = hazards.get(spec.type);
      if (!plugin || !plugin.enabled) {
        ctx.emit({ type: 'error', level: 'warn', text: `Hazard "${spec.type}" is not available yet` });
        continue;
      }
      try {
        const inst = plugin.create(ctx, spec);
        this.active.push({ spec, plugin, inst, startedAt: this.t });
      } catch (e) {
        ctx.emit({ type: 'error', level: 'warn', text: `${plugin.label}: ${(e as Error).message}` });
      }
    }
  }

  /** Wings worth planning: burning, damaged, with people waiting for rescue, or alerted. */
  private focusWings(): { wing: number; why: string }[] {
    const f = this.field;
    const twin = this.twin;
    const cand = new Map<number, { why: string[]; score: number }>();
    const add = (w: number, why: string, score: number) => {
      const c = cand.get(w) ?? { why: [], score: 0 };
      if (!c.why.includes(why)) c.why.push(why);
      c.score += score;
      cand.set(w, c);
    };
    for (const w of f.activeWings) {
      if (twin.wings[w].massingOnly) continue;
      const fire = wingFire(twin, f, w);
      if (fire.rooms) add(w, `fire on floor ${fire.lowest === 0 ? 'G' : fire.lowest}`, 2000);
      const d = f.wingDamage[w];
      if (d >= 2) add(w, DAMAGE_WORD[d], 300 * d);
    }
    for (const n of this.evac.needs()) {
      if (n.trapped) add(n.wing, `${n.trapped} trapped`, 1500);
      if (n.sheltering) add(n.wing, `${n.sheltering} waiting for rescue`, 1200);
    }
    for (const w of this.evac.alertedWings()) if (!twin.wings[w].massingOnly) add(w, 'alarm on', 50);
    for (const [w, c] of cand) c.score += this.evac.peopleInside(w);
    const ranked = [...cand.entries()].filter(([w, c]) => c.score > 60 || this.evac.peopleInside(w) > 0).sort((a, b) => b[1].score - a[1].score).slice(0, 6);
    if (this.focusWing !== null && !ranked.some(([w]) => w === this.focusWing) && !twin.wings[this.focusWing]?.massingOnly) {
      ranked.push([this.focusWing, cand.get(this.focusWing) ?? { why: ['selected'], score: 0 }]);
    }
    return ranked.map(([wing, c]) => ({ wing, why: c.why.join(', ') }));
  }

  private replan() {
    const focus = this.focusWings();
    const rescues = this.dispatch.rescueInputs(this.t);
    if (!focus.length && !rescues.length && !this.planner.plans.wings.length && !this.planner.plans.rescues.length) return;
    this.planner.plan({
      t: this.t, field: this.field, risk: this.risk, rec: this.evac.toSafety(this.field, this.t), load: this.evac.load,
      inside: this.evac.insideByFloor(), focus, rescues,
    });
  }

  private updatePlaybook() {
    const k = this.evac.kpis();
    const needs = { sheltering: 0, trapped: 0, casualties: 0 };
    for (const n of this.evac.needs(true)) {
      needs.sheltering += n.sheltering;
      needs.trapped += n.trapped;
      needs.casualties += n.casualties;
    }
    const tasks = new Map(this.dispatch.tasks.map((t) => [t.id, t]));
    this.playbook.update({
      t: this.t, twin: this.twin, field: this.field,
      hazards: this.active.map((h) => ({
        type: h.spec.type, params: h.spec.params, t0: h.startedAt, wing: h.spec.origin.buildingId, storey: h.spec.origin.storey,
      })),
      firstSeen: this.firstSeen,
      evac: { persons: k.persons, alerted: k.alerted, inside: k.inside, byStatus: k.byStatus, assembly: k.assembly },
      needs,
      dispatch: this.dispatch.resources.map((r) => ({ kind: r.spec.kind, status: r.status, taskId: r.task, taskKind: r.task ? tasks.get(r.task)?.kind ?? null : null })),
      zones: this.risk.zones,
      plans: this.planner.plans.wings.map((w) => ({ wing: w.id, floors: w.floors.length, shelterFloors: w.floors.filter((x) => x.advice === 'shelter').length, strategy: w.strategy })),
    });
  }

  step(dt = TICK): void {
    const t0 = performance.now();
    this.t += dt;
    const ctx = this.ctx();
    this.spawnDue(ctx);
    for (const h of this.active) h.inst.step(dt, ctx);
    this.field.updateTenability();
    this.risk.update(this.field, this.t, this.wind);
    this.evac.step(dt, ctx);
    this.dispatch.step(dt, ctx, this.evac);
    this.ops.step(dt, ctx);
    if (this.t >= this.nextAdvice) {
      this.nextAdvice = this.t + 2;
      this.recs = recommend({ twin: this.twin, field: this.field, t: this.t, evac: this.evac, dispatch: this.dispatch, hazards: this.active.map((h) => h.spec.type) });
    }
    if (this.t >= this.nextPlan) {
      // at most ~2.5 plans per wall-clock second whatever the speed
      this.nextPlan = this.t + Math.max(4, 0.4 * this.speed);
      this.replan();
    }
    if (this.t >= this.nextPlaybook) {
      this.nextPlaybook = this.t + 1;
      this.updatePlaybook();
      this.ops.update(ctx);
    }
    this.lastStepMs = performance.now() - t0;
  }

  snapshot(): Snapshot {
    const f = this.field;
    const ids: number[] = [];
    for (const w of f.activeWings) {
      const wing = this.twin.wings[w];
      if (wing.massingOnly) continue;
      const start = wing.storeyOffsets[0];
      for (let i = start; i < start + wing.spaceCount; i++) {
        if (f.soot[i] > 0.02 || f.burn[i] > 0 || f.damage[i] > 0 || f.temp[i] > 45) ids.push(i);
      }
    }
    const n = ids.length;
    const spaces = { ids: Int32Array.from(ids), soot: new Float32Array(n), temp: new Float32Array(n), burn: new Uint8Array(n), damage: new Uint8Array(n) };
    let burning = 0;
    let hrr = 0;
    let smoky = 0;
    ids.forEach((g, k) => {
      spaces.soot[k] = f.soot[g];
      spaces.temp[k] = f.temp[g];
      spaces.burn[k] = f.burn[g];
      spaces.damage[k] = f.damage[g];
      if (f.burn[g] === 1 || f.burn[g] === 2) burning++;
      hrr += f.hrr[g];
      if (f.visibility(g) < 10) smoky++;
    });
    const damage = [0, 0, 0, 0, 0];
    for (const w of this.twin.wings) if (!w.massingOnly) damage[f.wingDamage[w.idx]]++;
    const blocked: number[] = [];
    f.blockedStreet.forEach((b, i) => b && blocked.push(i));
    const events = this.outbox;
    this.outbox = [];
    let plans: Snapshot['plans'];
    if (this.planner.version !== this.sentPlan) {
      this.sentPlan = this.planner.version;
      plans = this.planner.plans;
    }
    let incidents: Snapshot['incidents'];
    if (this.ops.incidents.version !== this.sentIncidents) {
      this.sentIncidents = this.ops.incidents.version;
      incidents = this.ops.incidents;
    }
    let playbook: Snapshot['playbook'];
    if (this.playbook.view.version !== this.sentPlaybook) {
      this.sentPlaybook = this.playbook.view.version;
      playbook = this.playbook.view;
    }
    return {
      t: this.t,
      running: this.running,
      speed: this.speed,
      spaces,
      wingDamage: Uint8Array.from(f.wingDamage),
      groups: this.evac.pack(),
      flows: this.evac.flows(),
      resources: this.dispatch.pack(),
      events,
      recommendations: this.recs,
      assignments: this.dispatch.assignments,
      pending: this.dispatch.pending,
      evac: this.evac.kpis(),
      fire: { burningRooms: burning, hrr_MW: Math.round(hrr / 100) / 10, smokeSpaces: smoky },
      damage,
      blockedStreets: blocked,
      debris: f.debris,
      zones: this.risk.zones,
      plans,
      playbook,
      incidents,
      ops: this.ops.views(),
      shaking: Math.round(f.shaking * 100) / 100,
      hazards: this.active.map((h) => ({ type: h.spec.type, label: h.plugin.label, summary: h.inst.summary?.() ?? {} })),
      liftsOn: f.liftsOn,
      powerOn: f.powerOn,
      stepMs: Math.round(this.lastStepMs * 10) / 10,
    };
  }

  allEvents(): SimEvent[] {
    return this.events;
  }
}
