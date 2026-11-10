/**
 * Incidents and commanded rescue operations.
 *
 * `listIncidents` turns the live state into the places where something is wrong right
 * now (a burning flat, a collapse, people stranded by damage, a stuck lift, the injured),
 * each with the people who need help there.
 *
 * `RescueOps` runs a rescue the user starts on one of them: a crew is sent (drive), sets
 * up (breathing apparatus or a ladder), goes in by the stairs or up a ladder through a
 * window when fire or heat blocks the way to the flat door, finds the residents, brings
 * them out to the casualty point beside the vehicle, and repeats household by household.
 * Every leg is a walkable polyline (through doorways, up the stair flights, up the ladder)
 * with a speed per segment, so the renderer can show and follow the people exactly.
 */
import { enToLocal, localToEN } from '@twin/core';
import type { FieldStore, SimContext } from '@twin/hazard-sdk';
import type { NavEdge, NavGraph } from '@twin/nav';
import { spaceKind, spaceTemplate, wingStoreyTemplate, type Twin } from '@twin/twin-data';
import type { Evacuation, Group } from '@twin/crowd';
import { responderTime, SearchSpace, wingFire } from '@twin/routing';
import type { Dispatcher, ResourceState } from './index';

// ------------------------------------------------------------------ public types
export type IncidentKind = 'fire' | 'collapse' | 'damage' | 'lift' | 'casualty' | 'power';
export type Severity = 'critical' | 'serious' | 'minor';

export interface Incident {
  id: string;
  kind: IncidentKind;
  /** "Kitchen fire" */
  title: string;
  /** "R17-B, flat 204, floor 2" */
  place: string;
  /** "Fully developed, 1.8 MW" */
  detail: string;
  wing: number;
  storey: number;
  E: number;
  N: number;
  z: number;
  severity: Severity;
  /** people who need a crew to get out */
  people: number;
  since: number;
  active: boolean;
  resolvedAt?: number;
  rescue: { can: boolean; reason?: string; unit?: string; eta_s?: number };
  op: string | null;
}

export interface IncidentList {
  version: number;
  items: Incident[];
}

export type OpPhase = 'dispatch' | 'reposition' | 'setup' | 'entry' | 'search' | 'extract' | 'handover' | 'waiting' | 'complete' | 'stopped';
export type OpMethod = 'stairs' | 'window' | 'lift';
export type Vec3 = [number, number, number];

export interface RescueOpView {
  id: string;
  incident: string;
  title: string;
  place: string;
  unit: string;
  unitName: string;
  unitKind: string;
  wing: number;
  storey: number;
  phase: OpPhase;
  /** 0 drive, 1 set up, 2 go in, 3 find, 4 bring out, 5 hand over */
  step: number;
  /** what is happening now, in plain words */
  text: string;
  method: OpMethod;
  /** current leg as flattened E, N, z, and how far along it the lead person is */
  path: number[];
  pathId: number;
  s: number;
  leg: 'entry' | 'extract' | 'none';
  crew: number;
  victims: number;
  /** where the residents wait (room), shown before they are brought out */
  victimAt: Vec3 | null;
  /** a point in the residents' room to look from (towards them) */
  roomView: Vec3 | null;
  ladder: { base: Vec3; top: Vec3; ext: number; ground: boolean } | null;
  /** outward facade direction at the window being used */
  facing: [number, number] | null;
  vis: number;
  temp: number;
  rescued: number;
  left: number;
  startedAt: number;
  log: { t: number; text: string }[];
  done: boolean;
}

// ------------------------------------------------------------------ internals
const FLOOR = 0.24;
const STEP_OF: Record<OpPhase, number> = { dispatch: 0, reposition: 0, setup: 1, waiting: 1, entry: 2, search: 3, extract: 4, handover: 5, complete: 5, stopped: 5 };
const fmt = (s: number) => (s < 90 ? `${Math.max(0, Math.round(s))} s` : `${Math.round(s / 60)} min`);
const shortName = (s: string) => s.replace(/\s*\(.*\)\s*$/, '');
const floorName = (s: number) => (s === 0 ? 'ground floor' : `floor ${s}`);

interface Leg {
  pts: number[];
  spd: number[];
  cum: number[];
  len: number;
  kind: 'entry' | 'extract';
}

/** Speeds (m/s) along the drawn path. */
const V = {
  crew: { flat: 1.1, smoke: 0.7, dark: 0.45, stair: 0.55, out: 1.5, ladder: 0.35, debris: 0.4 },
  escort: { flat: 0.8, smoke: 0.55, dark: 0.4, stair: 0.42, out: 1.1, ladder: 0.22, debris: 0.3 },
};

interface WindowSpot {
  space: number;
  E: number;
  N: number;
  n: [number, number];
  sill: number;
  balcony: boolean;
  truck: number;
  aerial: boolean;
}

interface Victim {
  group: number;
  size: number;
  room: number;
  at: Vec3;
}

interface Op {
  id: string;
  incident: string;
  kind: IncidentKind;
  title: string;
  place: string;
  wing: number;
  storey: number;
  unit: ResourceState;
  method: OpMethod;
  phase: OpPhase;
  phaseStart: number;
  phaseEnd: number;
  /** what the operation does once a reposition or setup finishes */
  after: 'entry' | 'extract';
  leg: Leg | null;
  s: number;
  pathId: number;
  victim: Victim | null;
  win: WindowSpot | null;
  ladder: { base: Vec3; top: Vec3; ext: number; ground: boolean } | null;
  ladderFor: number;
  truck: number;
  rescued: number;
  startedAt: number;
  log: { t: number; text: string }[];
  text: string;
  vis: number;
  temp: number;
  lift?: { wing: number; lift: string; persons: number; node: number };
  done: boolean;
  usedCrew: number;
  /** breathing sets on (first trip takes longer to get ready) */
  baOn: boolean;
  retryAt: number;
}

export class RescueOps {
  ops = new Map<string, Op>();
  incidents: IncidentList = { version: 0, items: [] };
  private seq = 0;
  private space: SearchSpace;
  private flatDoorNode = new Map<number, number>();
  private firstSeen = new Map<string, number>();
  private resolved = new Map<string, Incident>();
  private sig = '';

  constructor(private twin: Twin, private nav: NavGraph, private dispatch: Dispatcher, private evac: Evacuation) {
    this.space = new SearchSpace(nav);
    for (const n of nav.nodes) if (n.kind === 'flatdoor' && n.flat >= 0) this.flatDoorNode.set(n.flat, n.id);
  }

  // ================================================================ incidents
  /** Who needs a crew at an incident (groups), most urgent first. */
  private victimsOf(inc: { kind: IncidentKind; wing: number; storey: number; flat?: number }, op?: string, pool?: Group[]): Group[] {
    const out: Group[] = [];
    for (const g of pool ?? this.evac.groups) {
      if (g.wing !== inc.wing) continue;
      if (g.claimed && g.claimed !== op) continue;
      if (g.escorted) continue;
      const s = g.status;
      const needs = s === 'sheltering' || s === 'trapped' || s === 'casualty';
      const inFireFlat = inc.kind === 'fire' && inc.flat !== undefined && g.flat === inc.flat && (s === 'waiting' || s === 'idle');
      if (!needs && !inFireFlat) continue;
      if (inc.kind === 'casualty' && s !== 'casualty') continue;
      out.push(g);
    }
    const rank = (g: Group) => (g.status === 'casualty' ? 0 : g.status === 'trapped' ? 1 : g.status === 'sheltering' ? 2 : 3);
    out.sort((a, b) => Math.abs(a.storey - inc.storey) - Math.abs(b.storey - inc.storey) || rank(a) - rank(b) || b.size - a.size);
    return out;
  }

  /** Recompute the incident list; returns true when it changed. */
  update(ctx: SimContext): boolean {
    const f = ctx.field;
    const t = ctx.t;
    const twin = this.twin;
    const items: (Incident & { _flat?: number })[] = [];
    const taken = new Set<number>(); // wings with an incident that owns their stranded people
    // groups that may need a crew, by wing (one pass over everyone)
    const pool = new Map<number, Group[]>();
    for (const g of this.evac.groups) {
      if (g.status === 'safe' || g.status === 'rescued' || g.status === 'moving' || g.status === 'queued') continue;
      let a = pool.get(g.wing);
      if (!a) pool.set(g.wing, (a = []));
      a.push(g);
    }
    // fires, one per burning flat (or per non-flat space)
    const fires = new Map<string, { wing: number; storey: number; flat: number; rooms: Set<string>; hrr: number; full: boolean; g: number }>();
    for (const w of f.activeWings) {
      const wing = twin.wings[w];
      if (wing.massingOnly) continue;
      const start = wing.storeyOffsets[0];
      for (let g = start; g < start + wing.spaceCount; g++) {
        if (f.burn[g] !== 1 && f.burn[g] !== 2) continue;
        const flat = twin.space.flat[g];
        const storey = twin.space.storey[g];
        const key = flat >= 0 ? `fire:f${flat}` : `fire:w${w}:${storey}:${twin.space.t[g]}`;
        let e = fires.get(key);
        if (!e) fires.set(key, (e = { wing: w, storey, flat, rooms: new Set(), hrr: 0, full: false, g }));
        e.rooms.add(spaceTemplate(twin, g).name);
        e.hrr += f.hrr[g];
        if (f.burn[g] === 2) e.full = true;
      }
    }
    // stranded people of a burning wing belong to the nearest fire in it
    const fireByWing = new Map<number, string[]>();
    for (const [k, e] of fires) fireByWing.set(e.wing, [...(fireByWing.get(e.wing) ?? []), k]);
    for (const [k, e] of fires) {
      const wing = twin.wings[e.wing];
      const flatNum = e.flat >= 0 ? twin.flats[e.flat].num : null;
      const rooms = [...e.rooms];
      const title = rooms.length === 1 ? `${rooms[0].replace('Living/dining', 'Living room')} fire` : `Fire in ${rooms.length} rooms`;
      const victims = this.victimsOf({ kind: 'fire', wing: e.wing, storey: e.storey, flat: e.flat >= 0 ? e.flat : undefined }, undefined, pool.get(e.wing) ?? []).filter((g) => {
        const own = fireByWing.get(e.wing)!;
        if (own.length === 1) return true;
        // the nearest fire by storey takes the group
        let best = own[0];
        let bd = Infinity;
        for (const kk of own) {
          const d = Math.abs(fires.get(kk)!.storey - g.storey);
          if (d < bd) {
            bd = d;
            best = kk;
          }
        }
        return best === k;
      });
      const people = victims.reduce((a, g) => a + g.size, 0);
      taken.add(e.wing);
      items.push({
        id: k, kind: 'fire', title, place: `${wing.id}, ${flatNum ? `flat ${flatNum}, ` : ''}${floorName(e.storey)}`,
        detail: `${e.full ? 'Fully alight' : 'Growing'}, ${(e.hrr / 1000).toFixed(1)} MW${rooms.length > 1 ? `: ${rooms.slice(0, 3).join(', ').toLowerCase()}` : ''}`,
        wing: e.wing, storey: e.storey, E: twin.space.E[e.g], N: twin.space.N[e.g], z: e.storey * twin.storeyH,
        severity: people > 0 || e.full ? 'critical' : 'serious', people, since: 0, active: true, rescue: { can: false }, op: null, _flat: e.flat,
      });
    }
    // collapses and badly damaged wings with people stranded
    for (const w of twin.wings) {
      if (w.massingOnly || taken.has(w.idx)) continue;
      const d = f.wingDamage[w.idx];
      if (d < 3) continue;
      const victims = this.victimsOf({ kind: d >= 4 ? 'collapse' : 'damage', wing: w.idx, storey: 0 }, undefined, pool.get(w.idx) ?? []);
      const people = victims.reduce((a, g) => a + g.size, 0);
      if (d >= 4) {
        const trapped = victims.filter((g) => g.status === 'trapped').reduce((a, g) => a + g.size, 0);
        items.push({
          id: `collapse:${w.idx}`, kind: 'collapse', title: 'Building collapse', place: w.id,
          detail: trapped ? `${trapped} trapped in rubble` : people ? 'People cut off on upper floors' : 'No one left inside',
          wing: w.idx, storey: 0, E: w.pose.E, N: w.pose.N, z: 0, severity: 'critical', people, since: 0, active: true, rescue: { can: false }, op: null,
        });
        taken.add(w.idx);
      } else if (d === 3 && people > 0) {
        items.push({
          id: `damage:${w.idx}`, kind: 'damage', title: 'People stranded', place: w.id, detail: 'Badly damaged; stairs may be unsafe',
          wing: w.idx, storey: 0, E: w.pose.E, N: w.pose.N, z: 0, severity: 'serious', people, since: 0, active: true, rescue: { can: false }, op: null,
        });
        taken.add(w.idx);
      }
    }
    // injured people where nothing else is listed
    for (const n of this.evac.needs(true)) {
      if (taken.has(n.wing) || n.casualties <= 0) continue;
      const w = twin.wings[n.wing];
      items.push({
        id: `casualty:${n.wing}`, kind: 'casualty', title: 'Injured people', place: w.id, detail: 'Overcome by smoke',
        wing: n.wing, storey: 0, E: w.pose.E, N: w.pose.N, z: 0, severity: 'critical', people: n.casualties, since: 0, active: true, rescue: { can: false }, op: null,
      });
      taken.add(n.wing);
    }
    // stuck lifts
    for (const tl of f.trappedLifts) {
      if (tl.resolved) continue;
      const w = twin.wings[tl.wing];
      items.push({
        id: `lift:${tl.wing}:${tl.lift}`, kind: 'lift', title: 'Lift stuck', place: `${w.id}, lift ${tl.lift}`, detail: `${tl.persons} ${tl.persons === 1 ? 'person' : 'people'} inside`,
        wing: tl.wing, storey: 1, E: w.pose.E, N: w.pose.N, z: 3, severity: 'serious', people: tl.persons, since: 0, active: true, rescue: { can: false }, op: null,
      });
    }
    if (!f.powerOn) {
      items.push({
        id: 'power', kind: 'power', title: 'Power cut', place: 'Whole site', detail: f.darkness > 0.5 ? 'Stairs and corridors dark' : 'On emergency lighting',
        wing: -1, storey: 0, E: 0, N: 0, z: 0, severity: 'minor', people: 0, since: 0, active: true, rescue: { can: false, reason: 'No rescue needed: residents stay home' }, op: null,
      });
    }
    // timing, rescue availability, operations
    const activeIds = new Set(items.map((i) => i.id));
    for (const i of items) {
      if (!this.firstSeen.has(i.id)) this.firstSeen.set(i.id, t);
      i.since = this.firstSeen.get(i.id)!;
      this.resolved.delete(i.id);
      const op = [...this.ops.values()].find((o) => o.incident === i.id && !o.done);
      i.op = op?.id ?? null;
      if (i.kind !== 'power') i.rescue = op ? { can: false, reason: 'Rescue under way', unit: op.unit.spec.id } : this.availability(i, t);
      delete (i as { _flat?: number })._flat;
    }
    // incidents that just ended stay listed as resolved
    for (const old of this.incidents.items) {
      if (old.active && !activeIds.has(old.id) && !this.resolved.has(old.id)) this.resolved.set(old.id, { ...old, active: false, resolvedAt: t, people: 0, rescue: { can: false }, op: null });
    }
    const sevRank = { critical: 0, serious: 1, minor: 2 } as const;
    items.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.people - a.people || a.since - b.since);
    const all = [...items, ...[...this.resolved.values()].sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 12)];
    const sig = JSON.stringify(all.map((i) => [i.id, i.title, i.detail, i.people, i.severity, i.rescue, i.op, i.active]));
    if (sig === this.sig) return false;
    this.sig = sig;
    this.incidents = { version: this.incidents.version + 1, items: all };
    return true;
  }

  /** Capability preference by incident kind (first match wins), best units first. */
  private unitFor(kind: IncidentKind, t: number, exclude?: string): { r: ResourceState; eta: number } | null {
    const prefs: Record<IncidentKind, ((r: ResourceState) => boolean)[]> = {
      fire: [(r) => r.spec.kind === 'fire_tender' && r.spec.capabilities.includes('rescue_ladder'), (r) => r.spec.kind === 'fire_tender', (r) => r.spec.capabilities.includes('search_rescue')],
      collapse: [(r) => r.spec.capabilities.includes('heavy_rescue'), (r) => r.spec.capabilities.includes('rescue_ladder'), (r) => r.spec.kind === 'fire_tender', (r) => r.spec.capabilities.includes('search')],
      damage: [(r) => r.spec.capabilities.includes('rescue_ladder'), (r) => r.spec.kind === 'fire_tender', (r) => r.spec.capabilities.includes('search_rescue'), (r) => r.spec.capabilities.includes('search')],
      casualty: [(r) => r.spec.capabilities.includes('first_aid'), (r) => r.spec.capabilities.includes('casualty_transport'), (r) => r.spec.kind === 'fire_tender'],
      lift: [(r) => r.spec.capabilities.includes('lift_rescue')],
      power: [],
    };
    const free = this.dispatch.resources.filter((r) => !r.lock && r.spec.id !== exclude);
    const eta = (r: ResourceState) => (r.status === 'offsite' ? 60 + r.spec.eta_s : r.status === 'called' ? Math.max(0, r.arriveAt - t) + 60 : 0);
    for (const ok of prefs[kind]) {
      const c = free.filter(ok).sort((a, b) => eta(a) - eta(b));
      // an on-site unit of a lower preference beats waiting 20 minutes for the ideal one
      const onSite = c.find((r) => r.status !== 'offsite' && r.status !== 'called');
      if (onSite) return { r: onSite, eta: 0 };
    }
    for (const ok of prefs[kind]) {
      const c = free.filter(ok).sort((a, b) => eta(a) - eta(b));
      if (c[0]) return { r: c[0], eta: eta(c[0]) };
    }
    return null;
  }

  private availability(i: Incident, t: number): Incident['rescue'] {
    if (i.people <= 0) return { can: false, reason: i.kind === 'fire' ? 'Everyone has left this flat' : 'No one needs rescuing here' };
    const u = this.unitFor(i.kind, t);
    if (!u) {
      const busy = [...this.ops.values()].filter((o) => !o.done).map((o) => shortName(o.unit.spec.name));
      return { can: false, reason: busy.length ? `No free crew: ${busy.join(', ')} already on a rescue` : 'No crew on the roster can do this' };
    }
    return { can: true, unit: u.r.spec.id, eta_s: u.eta, reason: u.eta ? `${shortName(u.r.spec.name)} comes from off site, about ${fmt(u.eta)}` : undefined };
  }

  // ================================================================ operations
  start(incidentId: string, ctx: SimContext): { ok: boolean; reason?: string; op?: string } {
    const inc = this.incidents.items.find((i) => i.id === incidentId && i.active);
    if (!inc) return { ok: false, reason: 'That incident is over' };
    const existing = [...this.ops.values()].find((o) => o.incident === incidentId && !o.done);
    if (existing) return { ok: true, op: existing.id };
    if (inc.kind === 'power') return { ok: false, reason: 'A power cut needs no rescue' };
    const u = this.unitFor(inc.kind, ctx.t);
    if (!u) return { ok: false, reason: inc.rescue.reason ?? 'No free crew' };
    const id = `op${++this.seq}`;
    const staging = this.dispatch.stagingNode(Math.max(0, inc.wing), ctx.field).node;
    const op: Op = {
      id, incident: inc.id, kind: inc.kind, title: inc.title, place: inc.place, wing: inc.wing, storey: inc.storey, unit: u.r, method: 'stairs',
      phase: 'dispatch', phaseStart: ctx.t, phaseEnd: Infinity, after: 'entry', leg: null, s: 0, pathId: 0, victim: null, win: null, ladder: null, ladderFor: -1,
      truck: staging, rescued: 0, startedAt: ctx.t, log: [], text: '', vis: 300, temp: 20, done: false, usedCrew: u.r.spec.kind === 'technician' ? 1 : 2,
      baOn: false, retryAt: 0,
    };
    if (inc.kind === 'lift') {
      const [, w, lift] = inc.id.split(':');
      const tl = ctx.field.trappedLifts.find((x) => x.wing === Number(w) && x.lift === lift && !x.resolved);
      const node = this.liftNode(Number(w), lift);
      if (!tl || node < 0) return { ok: false, reason: 'Lift not found' };
      op.lift = { wing: tl.wing, lift, persons: tl.persons, node };
      op.method = 'lift';
    }
    this.ops.set(id, op);
    // the first household is told to stay put: help is coming (and the inside view can show them)
    if (inc.kind !== 'lift') {
      const first = this.victimsOf(this.incOf(op), id)[0];
      if (first) {
        first.claimed = id;
        op.victim = this.victimFor(first, ctx.field);
      }
    }
    this.dispatch.lock(u.r.spec.id, id, staging, `${inc.title.toLowerCase()} at ${inc.place}`, inc.wing, ctx);
    this.say(op, ctx.t, `${shortName(u.r.spec.name)} sent to ${inc.place}${u.eta ? ` (from off site, about ${fmt(u.eta)})` : ''}`);
    ctx.emit({ type: 'rescue-start', level: 'warn', wing: inc.wing >= 0 ? inc.wing : undefined, text: `Rescue started at ${inc.place}: ${shortName(u.r.spec.name)} is on the way`, data: { op: id, incident: inc.id } });
    return { ok: true, op: id };
  }

  stop(opId: string, ctx: SimContext): void {
    const op = this.ops.get(opId);
    if (!op || op.done) return;
    this.releaseVictim(op, ctx, true);
    this.finish(op, ctx, 'stopped', 'Rescue stopped');
  }

  private finish(op: Op, ctx: SimContext, phase: 'complete' | 'stopped', text: string) {
    op.phase = phase;
    op.done = true;
    op.leg = null;
    op.text = text;
    op.ladder = op.ladder ? { ...op.ladder, ext: 0 } : null;
    this.dispatch.unlock(op.unit.spec.id);
    this.say(op, ctx.t, text);
    ctx.emit({ type: phase === 'complete' ? 'rescue-done' : 'rescue-stopped', level: 'info', wing: op.wing >= 0 ? op.wing : undefined, text: `${text}: ${op.place} (${op.rescued} ${op.rescued === 1 ? 'person' : 'people'} brought out)`, data: { op: op.id } });
  }

  /** Put a claimed group back if the rescue ends before they are out. */
  private releaseVictim(op: Op, ctx: SimContext, stopping: boolean) {
    const v = op.victim;
    if (!v) return;
    const g = this.evac.groups[v.group];
    if (g && g.status !== 'rescued') {
      if (g.escorted && stopping) {
        // already outside the building: treat as out; otherwise back where they were
        const outside = op.leg ? this.pointAt(op.leg, op.s)[2] < 0.6 : false;
        if (outside) {
          this.evac.rescue(g.id, { E: g.E, N: g.N });
          op.rescued += g.size;
        } else {
          const n = this.nav.nodes[g.node];
          g.E = n.E;
          g.N = n.N;
          g.z = n.z;
        }
      }
      g.claimed = null;
      g.escorted = false;
    }
    op.victim = null;
    void ctx;
  }

  private say(op: Op, t: number, text: string) {
    op.text = text;
    if (op.log[op.log.length - 1]?.text !== text) op.log.push({ t, text });
    if (op.log.length > 12) op.log.shift();
  }

  private setPhase(op: Op, t: number, phase: OpPhase, dur = Infinity) {
    op.phase = phase;
    op.phaseStart = t;
    op.phaseEnd = t + dur;
  }

  step(dt: number, ctx: SimContext): void {
    for (const op of this.ops.values()) {
      if (op.done) continue;
      try {
        this.stepOp(op, dt, ctx);
      } catch (e) {
        this.releaseVictim(op, ctx, true);
        this.finish(op, ctx, 'stopped', `Rescue stopped: ${(e as Error).message}`);
      }
    }
  }

  private stepOp(op: Op, dt: number, ctx: SimContext) {
    const t = ctx.t;
    const f = ctx.field;
    const r = op.unit;
    switch (op.phase) {
      case 'dispatch':
      case 'reposition': {
        if (r.status === 'onscene' && r.lock?.op === op.id && r.lock.node === r.node) {
          op.truck = r.node;
          if (op.phase === 'dispatch') {
            this.say(op, t, `${shortName(r.spec.name)} is on scene`);
            this.nextTrip(op, ctx);
          } else this.beginSetup(op, ctx);
        } else if (r.status === 'called') op.text = `Coming from off site, about ${fmt(Math.max(0, r.arriveAt - t) + 60)}`;
        else if (r.status === 'enroute') op.text = op.phase === 'reposition' ? 'Moving the fire engine under the window' : `Driving there, ${Math.max(0, Math.round(r.routeLen - r.routePos))} m to go`;
        else if (r.lock && t >= op.retryAt) {
          op.retryAt = t + 10;
          if (!this.dispatch.relocate(r.spec.id, r.lock.node, f)) op.text = 'No road through: trying another way';
        }
        break;
      }
      case 'waiting': {
        if (t >= op.phaseEnd) this.nextTrip(op, ctx, true);
        break;
      }
      case 'setup': {
        if (op.ladder && op.method === 'window') op.ladder.ext = Math.min(1, (t - op.phaseStart) / Math.max(1, op.phaseEnd - op.phaseStart));
        if (t >= op.phaseEnd) {
          if (op.ladder) op.ladder.ext = 1;
          if (op.after === 'extract') this.beginExtract(op, ctx);
          else this.beginEntry(op, ctx);
        }
        break;
      }
      case 'entry': {
        if (this.advance(op, dt, f)) {
          const v = op.victim!;
          const search = (op.method === 'lift' ? 300 : 20) + (op.vis < 5 ? 20 : 0) + (this.evac.groups[v.group]?.status === 'trapped' ? (r.spec.capabilities.includes('heavy_rescue') ? 240 : 420) : 0);
          this.setPhase(op, t, 'search', search);
          this.say(op, t, op.method === 'lift' ? 'Winding the lift car down by hand' : this.evac.groups[v.group]?.status === 'trapped' ? 'Shoring and digging people out of the rubble' : `Found ${v.size} ${v.size === 1 ? 'person' : 'people'}, checking them over`);
        }
        break;
      }
      case 'search': {
        if (t >= op.phaseEnd) this.decideExtraction(op, ctx);
        break;
      }
      case 'extract': {
        const g = op.victim ? this.evac.groups[op.victim.group] : null;
        const done = this.advance(op, dt, f);
        if (g && op.leg) {
          const p = this.pointAt(op.leg, Math.max(0, op.s - 1.1));
          g.E = p[0];
          g.N = p[1];
          g.z = Math.max(0, p[2] - FLOOR);
        }
        if (done) {
          this.setPhase(op, t, 'handover', 12);
          this.say(op, t, 'Handing them over at the casualty point');
        }
        break;
      }
      case 'handover': {
        if (t >= op.phaseEnd) {
          const v = op.victim;
          if (v && op.method === 'lift' && op.lift) {
            op.rescued += op.lift.persons;
          } else if (v) {
            const g = this.evac.groups[v.group];
            const at = op.leg ? this.pointAt(op.leg, op.leg.len) : null;
            if (g && g.status !== 'rescued') {
              this.evac.rescue(g.id, at ? { E: at[0], N: at[1] } : undefined);
              op.rescued += g.size;
            }
            ctx.emit({ type: 'rescued', level: 'info', wing: op.wing, text: `${shortName(r.spec.name)} brought ${v.size} ${v.size === 1 ? 'person' : 'people'} out of ${op.place}${op.method === 'window' ? ' by ladder' : ''}` });
          }
          op.victim = null;
          op.leg = null;
          this.nextTrip(op, ctx);
        }
        break;
      }
      default:
        break;
    }
    // conditions where the lead person is
    if (op.leg) {
      const p = this.pointAt(op.leg, op.s);
      const sp = this.spaceNear(op, p);
      if (sp >= 0) {
        op.vis = f.visibility(sp);
        op.temp = f.temp[sp];
      } else {
        op.vis = 300;
        op.temp = 20;
      }
    }
  }

  /** Move along the leg at the speed of the current segment; true when at the end. */
  private advance(op: Op, dt: number, f: FieldStore): boolean {
    const leg = op.leg;
    if (!leg) return true;
    let left = dt;
    while (left > 0 && op.s < leg.len) {
      let k = 0;
      while (k + 1 < leg.cum.length && leg.cum[k + 1] <= op.s) k++;
      const segEnd = leg.cum[Math.min(k + 1, leg.cum.length - 1)];
      let v = leg.spd[k] ?? 1;
      if (f.darkness > 0.5 && leg.pts[k * 3 + 2] > 0.5) v *= 0.8;
      const need = (segEnd - op.s) / v;
      if (need > left) {
        op.s += v * left;
        left = 0;
      } else {
        op.s = segEnd;
        left -= need;
        if (segEnd >= leg.len) break;
      }
    }
    op.s = Math.min(op.s, leg.len);
    return op.s >= leg.len - 1e-6;
  }

  pointAt(leg: Leg, s: number): Vec3 {
    const c = leg.cum;
    if (s <= 0) return [leg.pts[0], leg.pts[1], leg.pts[2]];
    for (let k = 1; k < c.length; k++) {
      if (c[k] >= s) {
        const u = c[k] > c[k - 1] ? (s - c[k - 1]) / (c[k] - c[k - 1]) : 1;
        const a = (k - 1) * 3;
        const b = k * 3;
        return [leg.pts[a] + (leg.pts[b] - leg.pts[a]) * u, leg.pts[a + 1] + (leg.pts[b + 1] - leg.pts[a + 1]) * u, leg.pts[a + 2] + (leg.pts[b + 2] - leg.pts[a + 2]) * u];
      }
    }
    const L = leg.pts.length;
    return [leg.pts[L - 3], leg.pts[L - 2], leg.pts[L - 1]];
  }

  private spaceNear(op: Op, p: Vec3): number {
    if (p[2] < 0.5 && op.phase !== 'search') return -1;
    const w = this.twin.wings[op.wing];
    if (!w || w.massingOnly) return -1;
    const storey = Math.max(0, Math.min(w.storeys - 1, Math.floor((p[2] + 0.2) / this.twin.storeyH)));
    const [x, y] = enToLocal(w.pose, p[0], p[1]);
    if (Math.abs(x) > w.L / 2 || Math.abs(y) > w.W / 2) return -1;
    const st = wingStoreyTemplate(w, storey);
    for (const sp of st.spaces) if (x >= sp.rect[0] && x <= sp.rect[2] && y >= sp.rect[1] && y <= sp.rect[3]) return w.storeyOffsets[storey] + sp.i;
    return -1;
  }

  private incOf(op: Op) {
    return { kind: op.kind, wing: op.wing, storey: op.storey, flat: op.incident.startsWith('fire:f') ? Number(op.incident.slice(6)) : undefined };
  }

  // ================================================================ trips
  private nextTrip(op: Op, ctx: SimContext, retry = false) {
    const t = ctx.t;
    if (op.method === 'lift') {
      if (op.rescued > 0 || !op.lift) return this.finish(op, ctx, 'complete', 'Lift rescue complete');
      const n = this.nav.nodes[op.lift.node];
      op.victim = { group: -1, size: op.lift.persons, room: n.space, at: [n.E, n.N, n.z + FLOOR] };
      this.setPhase(op, t, 'setup', 20);
      op.after = 'entry';
      this.say(op, t, 'Isolating the lift power and taking the lift keys');
      return;
    }
    const list = this.victimsOf(this.incOf(op), op.id);
    if (!list.length) return this.finish(op, ctx, 'complete', op.rescued ? 'Everyone is out' : 'No one left to rescue');
    // the household already told to wait for this crew first, then the first one that can be reached
    const held = op.victim && op.victim.group >= 0 ? this.evac.groups[op.victim.group] : null;
    const order = held && held.claimed === op.id && list.includes(held) ? [held, ...list.filter((g) => g !== held)] : list;
    for (const g of order) {
      const v = this.victimFor(g, ctx.field);
      const access = this.access(op, v, ctx.field, 'entry');
      if (!access) continue;
      if (held && held !== g && held.claimed === op.id && !held.escorted) held.claimed = null;
      g.claimed = op.id;
      op.victim = v;
      op.method = access.method;
      op.win = access.win;
      this.say(op, t, access.why);
      if (access.method === 'window' && access.win && access.win.truck !== op.truck && access.win.aerial) {
        op.after = 'entry';
        this.reposition(op, ctx, access.win.truck);
      } else {
        op.after = 'entry';
        this.beginSetup(op, ctx);
      }
      return;
    }
    // nobody reachable now: wait and try again
    this.setPhase(op, t, 'waiting', 20);
    const why = op.kind === 'collapse' && !op.unit.spec.capabilities.includes('heavy_rescue')
      ? 'Trapped in rubble: this needs the heavy rescue team'
      : op.kind === 'fire' ? 'No safe way in yet: waiting for the fire to be knocked down' : 'No safe way in yet';
    if (!retry) this.say(op, t, why);
    else op.text = `${why}. Trying again shortly`;
  }

  private reposition(op: Op, ctx: SimContext, node: number) {
    this.setPhase(op, ctx.t, 'reposition');
    op.ladder = null;
    this.dispatch.relocate(op.unit.spec.id, node, ctx.field);
  }

  private beginSetup(op: Op, ctx: SimContext) {
    const t = ctx.t;
    const first = !op.baOn && op.method !== 'lift';
    op.baOn = true;
    if (op.method === 'window' && op.win) {
      const win = op.win;
      const same = op.ladder && op.ladderFor === win.space;
      op.ladder = this.ladderFor(op, win);
      op.ladderFor = win.space;
      if (!same) op.ladder.ext = 0;
      this.setPhase(op, t, 'setup', same ? 6 : win.aerial ? 50 : 40);
      if (!same) this.say(op, t, win.aerial ? `Raising the aerial ladder to ${win.balcony ? 'the balcony' : 'the window'} on ${floorName(this.twin.space.storey[win.space])}` : `Pitching a ladder to ${win.balcony ? 'the balcony' : 'the window'} on ${floorName(this.twin.space.storey[win.space])}`);
    } else {
      op.ladder = null;
      this.setPhase(op, t, 'setup', op.method === 'lift' ? 20 : first ? 35 : 8);
      if (op.method !== 'lift') this.say(op, t, first ? 'Putting on breathing sets' : 'Heading back in');
    }
  }

  private beginEntry(op: Op, ctx: SimContext) {
    const t = ctx.t;
    const v = op.victim;
    if (!v) return this.nextTrip(op, ctx);
    const leg = op.method === 'window' && op.win ? this.windowLeg(op, v, op.win, 'entry', ctx.field) : op.method === 'lift' && op.lift ? this.stairsLeg(op, v, 'entry', ctx.field, op.lift.node) : this.stairsLeg(op, v, 'entry', ctx.field);
    if (!leg) {
      this.releaseVictim(op, ctx, false);
      return this.nextTrip(op, ctx);
    }
    this.setLeg(op, leg);
    this.setPhase(op, t, 'entry');
    const st = this.twin.space.storey[v.room] ?? 0;
    this.say(op, t, op.method === 'window' ? `Climbing the ladder to ${floorName(st)}` : op.method === 'lift' ? 'Walking to the lift' : `Going in by the stairs to ${floorName(st)}`);
  }

  private decideExtraction(op: Op, ctx: SimContext) {
    const t = ctx.t;
    const v = op.victim;
    if (op.method === 'lift' && op.lift && v) {
      const tl = ctx.field.trappedLifts.find((x) => x.wing === op.lift!.wing && x.lift === op.lift!.lift);
      if (tl) tl.resolved = true;
      if (ctx.field.powerOn && ctx.field.trappedLifts.every((x) => x.resolved)) ctx.field.liftsOn = true;
      ctx.emit({ type: 'lift-freed', level: 'info', text: `${op.lift.persons} people released from ${this.twin.wings[op.lift.wing].id} lift ${op.lift.lift}` });
      return this.beginExtract(op, ctx);
    }
    const g = v ? this.evac.groups[v.group] : null;
    if (!v || !g || g.status === 'rescued' || g.status === 'safe') {
      this.releaseVictim(op, ctx, false);
      return this.nextTrip(op, ctx);
    }
    // can they walk out the way the crew came in? if fire or heat blocks it, use a window
    const access = this.access(op, v, ctx.field, 'extract');
    if (!access) {
      this.setPhase(op, t, 'search', 15);
      op.text = 'Holding in the room: no safe way out yet';
      return;
    }
    if (access.method !== op.method || (access.win && op.win && access.win.space !== op.win.space)) {
      op.method = access.method;
      op.win = access.win;
      this.say(op, t, access.why);
      op.after = 'extract';
      if (access.method === 'stairs') return this.beginExtract(op, ctx);
      if (access.method === 'window' && access.win && access.win.aerial && access.win.truck !== op.truck) return this.reposition(op, ctx, access.win.truck);
      return this.beginSetup(op, ctx);
    }
    this.beginExtract(op, ctx);
  }

  private beginExtract(op: Op, ctx: SimContext) {
    const t = ctx.t;
    const v = op.victim;
    if (!v) return this.nextTrip(op, ctx);
    const leg = op.method === 'window' && op.win ? this.windowLeg(op, v, op.win, 'extract', ctx.field) : op.method === 'lift' && op.lift ? this.stairsLeg(op, v, 'extract', ctx.field, op.lift.node) : this.stairsLeg(op, v, 'extract', ctx.field);
    if (!leg) {
      this.setPhase(op, t, 'search', 15);
      op.text = 'Holding in the room: no safe way out yet';
      return;
    }
    const g = v.group >= 0 ? this.evac.groups[v.group] : null;
    if (g) g.escorted = true;
    this.setLeg(op, leg);
    this.setPhase(op, t, 'extract');
    const carried = g?.status === 'casualty' || g?.status === 'trapped';
    this.say(op, t, op.method === 'window' ? `Bringing ${v.size === 1 ? 'the resident' : 'them'} down the ladder` : op.method === 'lift' ? `Leading ${v.size} ${v.size === 1 ? 'person' : 'people'} out of the lift` : carried ? 'Carrying them out on a stretcher' : `Leading ${v.size} ${v.size === 1 ? 'person' : 'people'} out by the stairs`);
  }

  private setLeg(op: Op, leg: Leg) {
    op.leg = leg;
    op.s = 0;
    op.pathId++;
  }

  // ================================================================ access planning
  /** Where the residents of a group are: their living room, or the safest room of the flat. */
  private victimFor(g: Group, f: FieldStore): Victim {
    const twin = this.twin;
    const node = this.nav.nodes[g.node];
    let room = node.space;
    if (g.flat >= 0 && node.kind === 'flat') {
      const fl = twin.flats[g.flat];
      const ok = (s: number) => f.burn[s] !== 1 && f.burn[s] !== 2 && f.tenability[s] >= 0.3 && f.damage[s] < 4;
      if (!ok(room)) {
        // they retreat to the best room they can, preferring one with a window
        let best = -1;
        let bs = -Infinity;
        for (const s of fl.spaces) {
          const k = spaceKind(twin, s);
          if (k !== 'room' && k !== 'balcony') continue;
          const hasWin = twin.adj[s].some((ci) => twin.conns[ci].kind === 'window' && twin.conns[ci].b < 0);
          const sc = f.tenability[s] * 2 + (hasWin ? 1 : 0) - (f.burn[s] === 1 || f.burn[s] === 2 ? 10 : 0) - (f.damage[s] >= 4 ? 10 : 0);
          if (sc > bs) {
            bs = sc;
            best = s;
          }
        }
        if (best >= 0) room = best;
      }
    }
    const z = twin.space.storey[room] * twin.storeyH + FLOOR;
    return { group: g.id, size: g.size, room, at: [twin.space.E[room], twin.space.N[room], z] };
  }

  private civilianOk(f: FieldStore, s: number) {
    return f.burn[s] !== 1 && f.burn[s] !== 2 && f.temp[s] <= 80 && f.damage[s] < 4;
  }

  /**
   * How to reach (or bring out) a group: by the stairs if the way to the flat door is
   * passable (for the crew going in; for residents with escape hoods coming out: no
   * fire, under 80 °C, not collapsed), else by a ladder to a window or balcony.
   */
  private access(op: Op, v: Victim, f: FieldStore, phase: 'entry' | 'extract'): { method: OpMethod; win: WindowSpot | null; why: string } | null {
    const heavy = op.unit.spec.capabilities.includes('heavy_rescue');
    const ladder = op.unit.spec.capabilities.includes('rescue_ladder') || op.unit.spec.kind === 'fire_tender';
    const doorPath = this.doorPath(op, v, f, heavy);
    const g = this.evac.groups[v.group];
    const blockedAt = doorPath ? doorPath.spaces.find((s) => !this.civilianOk(f, s)) : undefined;
    const doorOk = doorPath && (phase === 'entry' ? true : blockedAt === undefined);
    // trapped in rubble: only the stairs and breaching work
    if (g?.status === 'trapped') {
      if (doorPath) return { method: 'stairs', win: null, why: heavy ? 'Going in to shore and breach the collapsed bays' : 'Going in to free people from the rubble' };
      return null;
    }
    // the way to the flat door is clear for everyone: stairs
    if (doorPath && blockedAt === undefined) return { method: 'stairs', win: null, why: phase === 'entry' ? 'Stairs are clear. Going in through the flat door' : 'Way out is clear. Taking them down the stairs' };
    const win = ladder ? this.windowFor(op, v, f, phase) : null;
    const where = blockedAt !== undefined ? this.blockedWhy(f, blockedAt) : doorPath ? 'Way to the flat door is blocked' : 'No way in by the stairs';
    if (win) return { method: 'window', win, why: `${where}. Using the ladder to the ${win.balcony ? 'balcony' : 'window'}` };
    if (doorOk) return { method: 'stairs', win: null, why: `${where}, and no ladder can reach. Going through with escape hoods` };
    return null;
  }

  /** "Living room on fire", "Corridor too hot" */
  private blockedWhy(f: FieldStore, s: number): string {
    const raw = spaceTemplate(this.twin, s).name;
    const name = raw.startsWith('Living') ? 'Living room' : raw.startsWith('Corridor') ? 'Corridor' : raw.startsWith('Ground lobby') ? 'Ground-floor lobby' : raw;
    if (f.burn[s] === 1 || f.burn[s] === 2) return `${name} on fire`;
    if (f.damage[s] >= 4) return `${name} collapsed`;
    if (f.temp[s] > 80) return `${name} too hot (${Math.round(f.temp[s])} °C)`;
    return `${name} blocked`;
  }

  /** The crew's way in from the vehicle to the flat door and on to the residents' room. */
  private doorPath(op: Op, v: Victim, f: FieldStore, heavy: boolean, target?: number): { nodes: number[]; edges: number[]; rooms: number[]; spaces: number[] } | null {
    const g = v.group >= 0 ? this.evac.groups[v.group] : null;
    const atHome = !!g && this.nav.nodes[g.node].kind === 'flat';
    const flat = atHome && g ? g.flat : -1;
    const goal = target ?? (flat >= 0 && this.flatDoorNode.has(flat) ? this.flatDoorNode.get(flat)! : g ? g.node : -1);
    if (goal < 0) return null;
    const T = this.nav.nodes[goal];
    const cost = (e: NavEdge) => responderTime(f, e, heavy);
    const p = this.space.run(op.truck, cost, (n) => (n === goal ? 0 : Infinity), (n) => {
      const a = this.nav.nodes[n];
      return Math.hypot(a.E - T.E, a.N - T.N, a.z - T.z) / 1.07;
    }, 40000);
    if (!p) return null;
    const rooms = flat >= 0 && target === undefined ? this.roomPath(this.twin.flats[flat].foyer, v.room) : [];
    if (flat >= 0 && target === undefined && !rooms.length) return null;
    const spaces = new Set<number>();
    for (const ei of p.edges) {
      const e = this.nav.edges[ei];
      if (e.space >= 0) spaces.add(e.space);
      if (e.space2 >= 0) spaces.add(e.space2);
    }
    for (const s of rooms) spaces.add(s);
    // the residents' own room is judged separately (they are already in it)
    spaces.delete(v.room);
    return { nodes: p.nodes, edges: p.edges, rooms, spaces: [...spaces] };
  }

  /** Rooms of a flat from one to another, through the internal doors. */
  private roomPath(from: number, to: number, ok: (s: number) => boolean = () => true): number[] {
    if (from === to) return [from];
    const twin = this.twin;
    const flat = twin.space.flat[from];
    const prev = new Map<number, number>([[from, -1]]);
    const q = [from];
    while (q.length) {
      const u = q.shift()!;
      if (u === to) break;
      for (const ci of twin.adj[u]) {
        const c = twin.conns[ci];
        if (c.kind !== 'door' && c.kind !== 'open') continue;
        const o = c.a === u ? c.b : c.a;
        if (o < 0 || prev.has(o)) continue;
        if (flat >= 0 && twin.space.flat[o] !== flat) continue;
        if (o !== to && !ok(o)) continue;
        prev.set(o, u);
        q.push(o);
      }
    }
    if (!prev.has(to)) return [];
    const out: number[] = [];
    for (let x = to; x !== -1; x = prev.get(x)!) out.push(x);
    return out.reverse();
  }

  private connBetween(a: number, b: number): { E: number; N: number } | null {
    for (const ci of this.twin.adj[a]) {
      const c = this.twin.conns[ci];
      if ((c.a === a && c.b === b) || (c.a === b && c.b === a)) return { E: c.E, N: c.N };
    }
    return null;
  }

  /** A window or balcony of the residents' flat that a ladder can reach, if any. */
  private windowFor(op: Op, v: Victim, f: FieldStore, phase: 'entry' | 'extract' = 'entry'): WindowSpot | null {
    const twin = this.twin;
    const flat = twin.space.flat[v.room];
    const cands = flat >= 0 ? twin.flats[flat].spaces : [v.room];
    const w = twin.wings[op.wing];
    let best: WindowSpot | null = null;
    let bs = Infinity;
    // with the crew beside them (escape hoods), people can cross a hot room but not a burning one
    const limit = phase === 'extract' ? 160 : 100;
    const passable = (s: number) => f.burn[s] !== 1 && f.burn[s] !== 2 && f.damage[s] < 4 && (s === v.room || f.temp[s] <= limit);
    for (const s of cands) {
      if (!passable(s)) continue;
      if (!this.roomPath(v.room, s, passable).length) continue;
      for (const ci of twin.adj[s]) {
        const c = twin.conns[ci];
        if (c.kind !== 'window' || c.b >= 0) continue;
        const [x, y] = enToLocal(w.pose, c.E, c.N);
        const nl: [number, number] = Math.abs(x) > w.L / 2 - 0.3 ? [Math.sign(x), 0] : [0, Math.sign(y) || 1];
        const b = (w.pose.bearing * Math.PI) / 180;
        const n: [number, number] = [nl[0] * Math.sin(b) - nl[1] * Math.cos(b), nl[0] * Math.cos(b) + nl[1] * Math.sin(b)];
        const balcony = spaceKind(twin, s) === 'balcony';
        const storey = twin.space.storey[s];
        const sill = storey * twin.storeyH + FLOOR + (balcony ? 1.1 : 0.9);
        const ideal: [number, number] = [c.E + n[0] * 7, c.N + n[1] * 7];
        const near = this.dispatch.nearestDrivable(ideal[0], ideal[1], op.wing);
        const tn = this.nav.nodes[near.node];
        const dh = Math.hypot(tn.E - c.E, tn.N - c.N);
        const aerial = op.unit.spec.kind === 'fire_tender' && dh <= 24;
        if (!aerial && sill > 10.5) continue; // a ground ladder reaches about three floors
        const score = dh / 6 + (s === v.room ? 0 : 2) + (balcony ? -1.5 : 0) + (1 - f.tenability[s]) * 4 + (aerial ? 0 : 3);
        if (score < bs) {
          bs = score;
          best = { space: s, E: c.E, N: c.N, n, sill, balcony, truck: aerial ? near.node : op.truck, aerial };
        }
      }
    }
    return best;
  }

  private ladderFor(op: Op, win: WindowSpot): { base: Vec3; top: Vec3; ext: number; ground: boolean } {
    const top: Vec3 = [win.E + win.n[0] * 0.45, win.N + win.n[1] * 0.45, win.sill + 0.25];
    if (win.aerial) {
      const tn = this.nav.nodes[win.truck];
      return { base: [tn.E, tn.N, 3.3], top, ext: 0, ground: false };
    }
    const out = 1.2 + win.sill * 0.27;
    return { base: [win.E + win.n[0] * out, win.N + win.n[1] * out, 0], top, ext: 0, ground: true };
  }

  private liftNode(wing: number, lift: string): number {
    let best = -1;
    for (const n of this.nav.nodes) {
      if (n.kind !== 'lift' || n.wing !== wing || n.space < 0) continue;
      if ((spaceTemplate(this.twin, n.space).liftId ?? '') !== lift) continue;
      if (best < 0 || n.storey < this.nav.nodes[best].storey) best = n.id;
    }
    // stand in the lift lobby on the ground floor
    return best;
  }

  // ================================================================ legs
  private leg(points: { p: Vec3; v: number }[], kind: Leg['kind']): Leg | null {
    const pts: number[] = [];
    const spd: number[] = [];
    for (const q of points) {
      const L = pts.length;
      if (L >= 3 && Math.abs(pts[L - 3] - q.p[0]) < 0.02 && Math.abs(pts[L - 2] - q.p[1]) < 0.02 && Math.abs(pts[L - 1] - q.p[2]) < 0.02) {
        spd[spd.length - 1] = q.v;
        continue;
      }
      pts.push(q.p[0], q.p[1], q.p[2]);
      spd.push(q.v);
    }
    if (pts.length < 6) return null;
    const cum = [0];
    for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]));
    return { pts: pts.map((x) => Math.round(x * 100) / 100), spd, cum, len: cum[cum.length - 1], kind };
  }

  /** Nav path to drawable points: through doorways, along the stair flights. */
  private navPoints(nodes: number[], edges: number[], f: FieldStore, sp: typeof V.crew, out: { p: Vec3; v: number }[]) {
    const nav = this.nav;
    const twin = this.twin;
    const H = twin.storeyH;
    const zOf = (n: number) => (nav.nodes[n].wing >= 0 && nav.nodes[n].kind !== 'exit' ? nav.nodes[n].z + FLOOR : 0);
    const indoorV = (e: NavEdge) => {
      const vis = Math.min(e.space >= 0 ? f.visibility(e.space) : 300, e.space2 >= 0 ? f.visibility(e.space2) : 300);
      return vis < 5 ? sp.dark : vis < 10 ? sp.smoke : sp.flat;
    };
    for (let i = 0; i < edges.length; i++) {
      const e = nav.edges[edges[i]];
      const a = nodes[i];
      const b = nodes[i + 1];
      const A = nav.nodes[a];
      const B = nav.nodes[b];
      if (e.pts && e.pts.length > 1) {
        const pts = e.a === a ? e.pts : [...e.pts].reverse();
        const v = e.street >= 0 && f.blockedStreet[e.street] ? sp.debris : sp.out;
        for (const [E, N] of pts) out.push({ p: [E, N, 0], v });
        continue;
      }
      if (e.kind === 'stair') {
        out.push({ p: [A.E, A.N, zOf(a)], v: sp.stair });
        const lo = Math.min(A.storey, B.storey);
        const w = twin.wings[A.wing];
        const st = wingStoreyTemplate(w, lo);
        const sIdx = twin.space.t[A.storey === lo ? A.space : B.space];
        const r = st.spaces[sIdx]?.rect;
        if (r) {
          const wdt = r[2] - r[0];
          const fw = Math.min(1.2, wdt / 2 - 0.1);
          const x1 = r[0] + 0.1 + fw / 2;
          const x2 = r[2] - 0.1 - fw / 2;
          const z0 = lo * H + FLOOR;
          const flight: [number, number, number][] = [
            [x1, r[1] + 0.7, z0], [x1, r[3] - 0.8, z0 + H / 2], [(x1 + x2) / 2, r[3] - 0.45, z0 + H / 2], [x2, r[3] - 0.8, z0 + H / 2], [x2, r[1] + 0.7, z0 + H],
          ];
          if (A.storey > B.storey) flight.reverse();
          for (const [x, y, z] of flight) {
            const [E, N] = localToEN(w.pose, x, y);
            out.push({ p: [E, N, z], v: sp.stair });
          }
        }
        continue;
      }
      out.push({ p: [A.E, A.N, zOf(a)], v: e.wing >= 0 ? indoorV(e) : sp.out });
      // go through the opening between the two spaces, not through the wall
      let door: { E: number; N: number } | null = null;
      if (e.space >= 0 && e.space2 >= 0) door = this.connBetween(e.space, e.space2);
      else if (e.kind === 'door' && e.space >= 0) {
        let bd = Infinity;
        for (const ci of twin.adj[e.space]) {
          const c = twin.conns[ci];
          if (c.kind !== 'exit') continue;
          const d = Math.hypot(c.E - B.E, c.N - B.N) + Math.hypot(c.E - A.E, c.N - A.N);
          if (d < bd) {
            bd = d;
            door = { E: c.E, N: c.N };
          }
        }
      }
      if (door) {
        const z = Math.max(zOf(a), zOf(b));
        out.push({ p: [door.E, door.N, A.wing >= 0 && B.wing >= 0 ? z : Math.min(zOf(a), zOf(b)) || z], v: e.wing >= 0 ? indoorV(e) : sp.out });
      }
    }
    const last = nodes[nodes.length - 1];
    out.push({ p: [nav.nodes[last].E, nav.nodes[last].N, zOf(last)], v: sp.flat });
  }

  /** Room-to-room points inside a flat (centre, doorway, centre ...). */
  private roomPoints(rooms: number[], v: number, out: { p: Vec3; v: number }[]) {
    const twin = this.twin;
    for (let i = 0; i < rooms.length; i++) {
      const s = rooms[i];
      const z = twin.space.storey[s] * twin.storeyH + FLOOR;
      if (i > 0) {
        const d = this.connBetween(rooms[i - 1], s);
        if (d) out.push({ p: [d.E, d.N, z], v });
      }
      out.push({ p: [twin.space.E[s], twin.space.N[s], z], v });
    }
  }

  private truckSide(op: Op): Vec3 {
    const n = this.nav.nodes[op.truck];
    const w = this.twin.wings[op.wing];
    const dx = w ? w.pose.E - n.E : 0;
    const dy = w ? w.pose.N - n.N : 1;
    const L = Math.hypot(dx, dy) || 1;
    return [n.E + (dx / L) * 3.5, n.N + (dy / L) * 3.5, 0];
  }

  private stairsLeg(op: Op, v: Victim, kind: 'entry' | 'extract', f: FieldStore, target?: number): Leg | null {
    const heavy = op.unit.spec.capabilities.includes('heavy_rescue');
    const p = this.doorPath(op, v, f, heavy, target);
    if (!p) return null;
    const sp = kind === 'entry' ? V.crew : V.escort;
    const g = v.group >= 0 ? this.evac.groups[v.group] : null;
    const carried = kind === 'extract' && (g?.status === 'casualty' || g?.status === 'trapped');
    const pts: { p: Vec3; v: number }[] = [];
    pts.push({ p: this.truckSide(op), v: sp.out });
    this.navPoints(p.nodes, p.edges, f, carried ? scale(sp, 0.6) : sp, pts);
    if (p.rooms.length) this.roomPoints(p.rooms, kind === 'entry' ? V.crew.flat * 0.8 : V.escort.flat, pts);
    if (target !== undefined) pts.push({ p: v.at, v: sp.flat });
    if (kind === 'extract') {
      pts.reverse();
      // speeds belong to the segment that starts at each point: shift after reversing
      for (let i = 0; i + 1 < pts.length; i++) pts[i].v = pts[i + 1].v;
    }
    return this.leg(pts, kind);
  }

  private windowLeg(op: Op, v: Victim, win: WindowSpot, kind: 'entry' | 'extract', f: FieldStore): Leg | null {
    const twin = this.twin;
    const ladder = op.ladder ?? this.ladderFor(op, win);
    const sp = kind === 'entry' ? V.crew : V.escort;
    const z = twin.space.storey[win.space] * twin.storeyH + FLOOR;
    const inside: Vec3 = [win.E - win.n[0] * 0.9, win.N - win.n[1] * 0.9, z];
    const pts: { p: Vec3; v: number }[] = [];
    const side = this.truckSide(op);
    pts.push({ p: ladder.ground ? side : [ladder.base[0], ladder.base[1], 0], v: ladder.ground ? sp.out : 0.5 });
    if (ladder.ground) pts.push({ p: [ladder.base[0], ladder.base[1], 0], v: sp.ladder });
    else pts.push({ p: ladder.base, v: sp.ladder });
    pts.push({ p: ladder.top, v: 0.4 });
    pts.push({ p: [win.E, win.N, win.sill], v: 0.4 });
    pts.push({ p: inside, v: sp.flat });
    const passable = (s: number) => f.burn[s] !== 1 && f.burn[s] !== 2 && f.damage[s] < 4;
    const rooms = this.roomPath(win.space, v.room, passable);
    this.roomPoints(rooms.length ? rooms : [win.space], sp.flat, pts);
    if (kind === 'extract') {
      pts.reverse();
      for (let i = 0; i + 1 < pts.length; i++) pts[i].v = pts[i + 1].v;
      // after the ladder, walk to the casualty point beside the engine
      if (!ladder.ground) pts.push({ p: side, v: V.escort.out });
      else pts.push({ p: side, v: V.escort.out });
    }
    return this.leg(pts, kind);
  }

  // ================================================================ views
  views(): RescueOpView[] {
    const out: RescueOpView[] = [];
    for (const op of this.ops.values()) {
      if (op.done && op.phase !== 'complete' && op.phase !== 'stopped') continue;
      const v = op.victim;
      let left = 0;
      if (!op.done && op.method !== 'lift') {
        left = this.victimsOf(this.incOf(op), op.id).reduce((a, x) => a + x.size, 0);
      } else if (!op.done && op.lift) left = op.rescued ? 0 : op.lift.persons;
      const waiting = v && (op.phase === 'dispatch' || op.phase === 'reposition' || op.phase === 'setup' || op.phase === 'entry' || op.phase === 'search' || op.phase === 'waiting');
      const showVictims = waiting && op.method !== 'lift';
      let roomView: Vec3 | null = null;
      if (v && v.room >= 0) {
        // watch the residents from the corner of their room nearest its door (as the crew will come in)
        const twin = this.twin;
        const w = twin.wings[twin.space.wing[v.room]];
        const storey = twin.space.storey[v.room];
        const r = wingStoreyTemplate(w, storey).spaces[twin.space.t[v.room]]?.rect;
        const door = twin.adj[v.room].map((ci) => twin.conns[ci]).find((c) => c.kind === 'door' || c.kind === 'flatdoor' || c.kind === 'open' || c.kind === 'stairdoor');
        if (r) {
          const inset = 0.3;
          const corners = [[r[0] + inset, r[1] + inset], [r[2] - inset, r[1] + inset], [r[2] - inset, r[3] - inset], [r[0] + inset, r[3] - inset]].map(([x, y]) => localToEN(w.pose, x, y));
          let best = corners[0];
          if (door) {
            let bd = Infinity;
            for (const c of corners) {
              const d = Math.hypot(c[0] - door.E, c[1] - door.N);
              if (d < bd) {
                bd = d;
                best = c;
              }
            }
          }
          roomView = [best[0], best[1], v.at[2]];
        }
      }
      out.push({
        id: op.id, incident: op.incident, title: op.title, place: op.place, unit: op.unit.spec.id, unitName: shortName(op.unit.spec.name), unitKind: op.unit.spec.kind,
        wing: op.wing, storey: op.storey, phase: op.phase, step: STEP_OF[op.phase], text: op.text, method: op.method,
        path: op.leg ? op.leg.pts : [], pathId: op.pathId, s: Math.round(op.s * 100) / 100, leg: op.leg ? op.leg.kind : 'none',
        crew: op.usedCrew, victims: v ? Math.min(3, v.size) : 0, victimAt: showVictims && v ? v.at : null, roomView,
        ladder: op.ladder ? { ...op.ladder } : null, facing: op.win && op.method === 'window' ? op.win.n : null,
        vis: Math.round(op.vis * 10) / 10, temp: Math.round(op.temp), rescued: op.rescued, left,
        startedAt: op.startedAt, log: op.log.slice(-8), done: op.done,
      });
    }
    return out;
  }
}

function scale(sp: typeof V.crew, k: number): typeof V.crew {
  return Object.fromEntries(Object.entries(sp).map(([key, v]) => [key, v * k])) as typeof V.crew;
}
