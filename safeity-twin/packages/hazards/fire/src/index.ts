/**
 * Fire and smoke — Tier A real-time network zone model (PRD Section 7.2).
 *
 * - Heat release grows as t^2 (alpha by growth class) to the lower of a
 *   ventilation limit (1500 * Av * sqrt(Hv) kW) and a fuel-surface limit.
 * - Hot-layer temperature from the McCaffrey-Quintiere-Harkleroad correlation;
 *   flashover at ~600 C.
 * - Soot production 0.015 g/g at 20 MJ/kg; smoke and heat exchange through open
 *   doors, leakage through closed doors, buoyant flow up stairs, lift shafts and
 *   ventilation shafts, venting through windows.
 * - Flame spread to rooms inside the flat, by window plume to the room above, and
 *   through flat doors after their fire resistance when the corridor is hot.
 * - Suppression from responders on scene reduces heat release (kW absorbed).
 * Tier B (FDS export) is out of scope for this module.
 */
import type { HazardInstance, HazardPlugin, SimContext } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';
import { spaceKind, spaceTemplate, type Twin, type ConnModel } from '@twin/twin-data';

const ALPHA: Record<string, number> = { slow: 0.00293, medium: 0.01172, fast: 0.0469, ultrafast: 0.1876 };
const HK = 0.035; // kW/m2K, thermally thick lining
const SOOT_PER_KW = 0.015 / 20000 * 1000; // g of soot per kJ released
const AMB = 20;

interface WingCache {
  conns: number[];
  spaces: number[];
}

class FireInstance implements HazardInstance {
  private alpha: number;
  private peak: number;
  private tIgn = new Map<number, number>(); // space -> ignition time
  private tFull = new Map<number, number>(); // space -> time of flashover
  private fuel = new Map<number, number>(); // space -> MJ left
  private wingCache = new Map<number, WingCache>();
  private reported = new Set<string>();
  private origin: number;
  private flatDoorOpen: boolean;
  private stairLeak: number;
  private doorResist_s: number;
  private peakTotal = 0;
  private extinguishedAt = -1;
  private wings = new Set<number>();
  private sprinklers: boolean;
  /** space -> sprinkler activation (time, heat release at activation) */
  private sprinklerAt = new Map<number, { t: number; q: number }>();

  constructor(private twin: Twin, ctx: SimContext, private spec: HazardSpec) {
    const p = spec.params;
    this.alpha = ALPHA[String(p.growth ?? 'fast')] ?? ALPHA.fast;
    this.peak = Number(p.peakRoom_kW ?? 3000);
    this.flatDoorOpen = Boolean(p.fireFlatDoorOpen ?? true);
    this.stairLeak = Boolean(p.stairDoorsSelfClosing ?? true) ? 0.12 : 1.0;
    this.doorResist_s = Number(p.flatDoorResistance_min ?? 20) * 60;
    this.sprinklers = Boolean(p.sprinklers ?? false);
    let g = spec.origin.spaceId ?? -1;
    if (g < 0 || g >= twin.nSpaces) throw new Error('fire needs a point inside a building');
    // a fire "in a corridor" starts in the nearest room of the flat if possible
    this.origin = g;
    this.ignite(g, ctx.t, ctx);
    ctx.emit({ type: 'ignition', level: 'critical', text: `Fire starts: ${spec.origin.label ?? 'selected room'}`, wing: twin.space.wing[g], space: g });
    const w = twin.space.wing[g];
    ctx.alert([w], 'fire alarm', Number(p.alarmDelay_s ?? 120));
  }

  private cache(w: number): WingCache {
    let c = this.wingCache.get(w);
    if (!c) {
      const wing = this.twin.wings[w];
      const spaces: number[] = [];
      for (let s = 0; s < wing.storeys; s++) {
        const off = wing.storeyOffsets[s];
        const next = s + 1 < wing.storeys ? wing.storeyOffsets[s + 1] : off + (wing.spaceCount - (off - wing.storeyOffsets[0]));
        for (let i = off; i < next; i++) spaces.push(i);
      }
      const set = new Set<number>();
      for (const sp of spaces) for (const ci of this.twin.adj[sp]) set.add(ci);
      c = { conns: [...set], spaces };
      this.wingCache.set(w, c);
    }
    return c;
  }

  private ignite(g: number, t: number, ctx: SimContext) {
    if (this.tIgn.has(g)) return;
    const f = ctx.field;
    if (f.burn[g] === 3) return;
    const area = this.twin.space.area[g];
    const kind = spaceKind(this.twin, g);
    const load = kind === 'room' ? 780 : kind === 'commercial' ? 900 : kind === 'balcony' ? 200 : 60; // MJ/m2
    this.tIgn.set(g, t);
    this.fuel.set(g, load * area);
    f.burn[g] = 1;
    f.activeWings.add(this.twin.space.wing[g]);
    this.wings.add(this.twin.space.wing[g]);
  }

  private ventArea(g: number): { Av: number; Hv: number } {
    let Av = 0;
    for (const ci of this.twin.adj[g]) {
      const c = this.twin.conns[ci];
      if (c.kind === 'window') Av += c.width * 1.2;
      else if (c.kind === 'door' || c.kind === 'open') Av += c.width * 2.0 * 0.5;
      else if (c.kind === 'flatdoor' && this.flatDoorOpen) Av += c.width * 2.0;
    }
    return { Av: Math.max(0.6, Av), Hv: 1.6 };
  }

  private connFlow(c: ConnModel, f: SimContext['field']): number {
    // volumetric exchange rate (m3/s) through an opening
    const ta = f.temp[c.a];
    const tb = c.b >= 0 ? f.temp[c.b] : AMB;
    const buoy = 1 + Math.sqrt(Math.abs(ta - tb) / 300);
    switch (c.kind) {
      case 'open': return 0.5 * c.width * 2.0 * 0.6 * buoy;
      case 'door': return 0.35 * c.width * 2.0 * 0.6 * buoy;
      case 'flatdoor': return (this.flatDoorOpen && this.isFireFlat(c.a) ? 1 : 0.01) * c.width * 2.0 * 0.6 * buoy;
      case 'stairdoor': return this.stairLeak * c.width * 2.0 * 0.5 * buoy;
      case 'window': return 0.4 * c.width * 1.2 * buoy;
      case 'exit': return 0.5 * c.width * 2.0 * buoy;
      case 'stairflight': return 0.9 * buoy;
      case 'liftshaft': return 0.15 * buoy;
      case 'shaftlink': return 1.5 * buoy;
      default: return 0;
    }
  }

  private isFireFlat(g: number) {
    const fl = this.twin.space.flat[g];
    return fl >= 0 && fl === this.twin.space.flat[this.origin];
  }

  step(dt: number, ctx: SimContext): void {
    const f = ctx.field;
    const twin = this.twin;
    const t = ctx.t;
    let total = 0;
    // 1. heat release in burning spaces
    for (const [g, t0] of this.tIgn) {
      if (f.burn[g] === 3) continue;
      const w = twin.space.wing[g];
      const area = twin.space.area[g];
      const { Av, Hv } = this.ventArea(g);
      const qVent = 1500 * Av * Math.sqrt(Hv);
      const qCap = Math.min(this.peak * Math.max(0.5, area / 15), qVent, 250 * area + 200);
      let q = f.burn[g] === 2 ? qCap : Math.min(qCap, this.alpha * (t - t0) ** 2 + 5);
      const fuel = this.fuel.get(g)! - (q * dt) / 1000;
      this.fuel.set(g, fuel);
      const full = this.fuel.get(g)! / Math.max(1, 780 * area);
      if (full < 0.2) q *= Math.max(0, full / 0.2);
      // sprinkler: activates when the hot layer reaches 68 C, then the fire decays
      // exponentially (NIST suppression model, Q(t) = Q_act exp(-0.023 (t - t_act)))
      const spr = this.sprinklerAt.get(g);
      if (spr) q = Math.min(q, spr.q * Math.exp(-0.023 * (t - spr.t)));
      else if (this.sprinklers && f.temp[g] >= 68) {
        this.sprinklerAt.set(g, { t, q });
        this.once(`spr-${g}`, ctx, 'sprinkler', 'info', `Sprinkler activates at ${Math.round(q)} kW: ${labelOf(twin, g)}`, g);
      }
      // suppression on scene is spread over the wing's burning spaces
      const sup = f.wingSuppression_kW[w];
      if (sup > 0) {
        const burningInWing = this.countBurning(w, f);
        q = Math.max(0, q - sup / Math.max(1, burningInWing));
      }
      f.hrr[g] = q;
      total += q;
      // MQH upper-layer temperature
      const H = twin.storeyH;
      const L = Math.sqrt(area);
      const AT = 2 * area + 4 * L * H - Av;
      const dT = 6.85 * Math.cbrt((q * q) / (Av * Math.sqrt(Hv) * HK * Math.max(10, AT)));
      f.temp[g] = Math.max(f.temp[g], Math.min(1100, AMB + dT));
      if (f.burn[g] === 1 && f.temp[g] >= 600 && !this.sprinklerAt.has(g)) {
        f.burn[g] = 2;
        this.tFull.set(g, t);
        this.once(`fo-${g}`, ctx, 'flashover', 'critical', `Flashover: ${labelOf(twin, g)}`, g);
      }
      if (fuel <= 0 || (q < 1 && t - t0 > 60)) {
        f.burn[g] = 3;
        f.hrr[g] = 0;
        const by = sup > 0 ? 'Extinguished' : this.sprinklerAt.has(g) ? 'Controlled by sprinkler' : 'Burnt out';
        this.once(`out-${g}`, ctx, sup > 0 || this.sprinklerAt.has(g) ? 'extinguished' : 'burnout', 'info', `${by}: ${labelOf(twin, g)}`, g);
      }
      f.soot[g] += (SOOT_PER_KW * q * dt) / Math.max(1, twin.space.volume[g]);
    }
    this.peakTotal = Math.max(this.peakTotal, total);
    // 2. transport of smoke and heat within this fire's wings (once per wing per tick)
    for (const w of this.wings) {
      if (f.smokeT[w] === t) continue;
      f.smokeT[w] = t;
      const c = this.cache(w);
      for (const ci of c.conns) {
        const cn = twin.conns[ci];
        const F = this.connFlow(cn, f) * dt;
        if (F <= 0) continue;
        const a = cn.a;
        const Va = twin.space.volume[a];
        if (cn.b < 0) {
          // venting to outside
          const out = Math.min(f.soot[a], (F / Va) * f.soot[a]);
          f.soot[a] -= out;
          f.temp[a] -= Math.min(f.temp[a] - AMB, (F / Va) * (f.temp[a] - AMB) * 0.5);
          continue;
        }
        const b = cn.b;
        const Vb = twin.space.volume[b];
        const vertical = cn.kind === 'stairflight' || cn.kind === 'shaftlink' || cn.kind === 'liftshaft';
        if (vertical) {
          // buoyant: lower (a) -> upper (b), plus weaker exchange back down
          const up = Math.min(f.soot[a] * Va, F * f.soot[a] * 1.0);
          f.soot[a] -= up / Va;
          f.soot[b] += up / Vb;
          const dTup = Math.max(0, f.temp[a] - f.temp[b]) * Math.min(1, F / Vb) * 0.8;
          f.temp[b] += dTup;
          const back = Math.min(f.soot[b] * Vb, F * 0.1 * f.soot[b]);
          f.soot[b] -= back / Vb;
          f.soot[a] += back / Va;
        } else {
          const dc = f.soot[a] - f.soot[b];
          const m = F * dc * 0.5;
          const mm = Math.max(-f.soot[b] * Vb, Math.min(f.soot[a] * Va, m));
          f.soot[a] -= mm / Va;
          f.soot[b] += mm / Vb;
          const dTm = (f.temp[a] - f.temp[b]) * Math.min(0.5, F / Math.min(Va, Vb)) * 0.5;
          if (f.burn[b] === 0) f.temp[b] += dTm;
          if (f.burn[a] === 0) f.temp[a] -= dTm * (Vb / Va) * 0.3;
        }
      }
      // wall losses for non-burning spaces
      for (const g of c.spaces) {
        if (f.burn[g] !== 1 && f.burn[g] !== 2) f.temp[g] = AMB + (f.temp[g] - AMB) * Math.exp(-dt / 240);
        if (f.soot[g] > 0 && spaceKind(twin, g) === 'shaft') f.soot[g] *= Math.exp(-dt / 45); // shafts vent at the top
      }
    }
    // 3. flame spread
    for (const [g] of this.tFull) {
      if (f.burn[g] !== 2) continue;
      const tf = this.tFull.get(g)!;
      for (const ci of twin.adj[g]) {
        const cn = twin.conns[ci];
        const o = cn.a === g ? cn.b : cn.a;
        if (o < 0 || this.tIgn.has(o)) continue;
        const kind = spaceKind(twin, o);
        if (cn.kind === 'door' && (kind === 'room' || kind === 'balcony') && t - tf > 75) this.spreadTo(o, ctx, 'Fire spreads to');
        if (cn.kind === 'flatdoor' && t - tf > (this.flatDoorOpen ? 240 : this.doorResist_s)) this.spreadTo(o, ctx, 'Fire enters');
      }
      // window plume to the room above
      const w = twin.wings[twin.space.wing[g]];
      const s = twin.space.storey[g];
      const tIdx = twin.space.t[g];
      const hasWindow = twin.adj[g].some((ci) => twin.conns[ci].kind === 'window' && twin.conns[ci].b < 0);
      if (hasWindow && s + 1 < w.storeys && w.storeyKinds[s + 1] === w.storeyKinds[s] && t - tf > 360) {
        const above = w.storeyOffsets[s + 1] + tIdx;
        if (!this.tIgn.has(above) && ctx.rng.chance(0.004 * dt)) this.spreadTo(above, ctx, 'Window plume ignites floor above:');
      }
    }
    // 4. thresholds worth telling people about
    for (const w of this.wings) {
      const wing = twin.wings[w];
      for (let s = 0; s < wing.storeys; s++) {
        const st = wing.storeyKinds[s];
        void st;
        const off = wing.storeyOffsets[s];
        const tpl = s === 0 ? wing.tpl.ground : wing.storeyKinds[s] === 'flats' ? wing.tpl.typical : wing.tpl.commercial;
        for (const stair of tpl.stairs) {
          const g = off + stair.space;
          if (f.visibility(g) < 10) this.once(`stair-${g}`, ctx, 'stair-smoke', 'warn', `Smoke in ${wing.id} Stair ${stair.id}, floor ${s}: visibility ${f.visibility(g).toFixed(0)} m`, g);
        }
        for (const ci of tpl.corridors) {
          const g = off + ci;
          if (f.tenability[g] < 0.3) this.once(`corr-${w}-${s}`, ctx, 'corridor-untenable', 'warn', `${wing.id} floor ${s} corridor untenable`, g);
        }
      }
    }
    if (total < 1 && this.tIgn.size > 0 && this.extinguishedAt < 0 && [...this.tIgn.keys()].every((g) => f.burn[g] === 3)) {
      this.extinguishedAt = t;
      ctx.emit({ type: 'fire-out', level: 'info', text: 'All fire spaces extinguished or burnt out' });
    }
  }

  private countBurning(w: number, f: SimContext['field']) {
    let n = 0;
    for (const [g] of this.tIgn) if (this.twin.space.wing[g] === w && (f.burn[g] === 1 || f.burn[g] === 2)) n++;
    return n;
  }

  private spreadTo(g: number, ctx: SimContext, msg: string) {
    this.ignite(g, ctx.t, ctx);
    ctx.emit({ type: 'spread', level: 'critical', text: `${msg} ${labelOf(this.twin, g)}`, wing: this.twin.space.wing[g], space: g });
  }

  private once(key: string, ctx: SimContext, type: string, level: 'info' | 'warn' | 'critical', text: string, space?: number) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    ctx.emit({ type, level, text, space, wing: space !== undefined ? this.twin.space.wing[space] : undefined });
  }

  done(): boolean {
    return this.extinguishedAt >= 0;
  }

  summary() {
    return { burningSpaces: [...this.tIgn.keys()].length, peakHRR_kW: Math.round(this.peakTotal), sprinklers: this.sprinklerAt.size, origin: this.spec.origin.label ?? '' };
  }
}

function labelOf(twin: Twin, g: number): string {
  const w = twin.wings[twin.space.wing[g]];
  const s = twin.space.storey[g];
  const fl = twin.space.flat[g];
  const name = spaceTemplate(twin, g).name;
  return fl >= 0 ? `${w.id} flat ${twin.flats[fl].num} ${name.toLowerCase()}` : `${w.id} floor ${s} ${name.toLowerCase()}`;
}

export const firePlugin: HazardPlugin = {
  id: 'fire',
  label: 'Fire',
  description: 'Room fire with smoke spread through corridors, stairs and shafts',
  release: 'v1',
  pinned: true,
  enabled: true,
  targets: ['space'],
  params: [
    { key: 'growth', label: 'Growth rate', type: 'select', default: 'fast', options: [
      { value: 'slow', label: 'Slow (alpha 0.003)' }, { value: 'medium', label: 'Medium (0.012)' },
      { value: 'fast', label: 'Fast (0.047) — furnished room' }, { value: 'ultrafast', label: 'Ultra-fast (0.188)' }], help: 't-squared growth, kW/s^2 (SFPE)' },
    { key: 'peakRoom_kW', label: 'Peak heat release per 15 m2 room', type: 'number', unit: 'kW', min: 500, max: 8000, step: 250, default: 3000, help: 'Capped by ventilation (1500 Av sqrt Hv) and 250 kW/m2' },
    { key: 'fireFlatDoorOpen', label: 'Fire flat door left open', type: 'boolean', default: true, help: 'Occupants often leave it open; it is the main smoke path to the corridor' },
    { key: 'stairDoorsSelfClosing', label: 'Stair doors self-closing', type: 'boolean', default: true },
    { key: 'flatDoorResistance_min', label: 'Flat door fire resistance', type: 'number', unit: 'min', min: 5, max: 120, step: 5, default: 20 },
    { key: 'sprinklers', label: 'Sprinklers in flats', type: 'boolean', default: false, help: 'Head opens at a 68 °C hot layer; the fire then decays (NIST) and cannot flash over' },
    { key: 'alarmDelay_s', label: 'Alarm to rest of wing', type: 'number', unit: 's', min: 0, max: 900, step: 15, default: 120, help: 'Manual alarm by default; 30-60 s with smoke detection' },
  ],
  create: (ctx, spec) => new FireInstance(ctx.twin, ctx, spec),
};
