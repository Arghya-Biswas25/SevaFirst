/**
 * Earthquake (PRD Section 7.4).
 *
 * Ground motion: design-basis presets for Seismic Zone III (IS 1893 (Part 1):2016,
 * Z = 0.16: DBE PGA = Z/2, MCE PGA = Z) or a magnitude-distance scenario through a
 * generic attenuation form, ln PGA = c0 + 0.75 (M - 6) - ln(sqrt(R^2 + h^2) + 10),
 * calibrated to ~0.1 g at M6.5 / 30 km, with lognormal intra-event scatter.
 *
 * Damage: lognormal fragility per wing (slight, moderate, extensive, complete).
 * PLACEHOLDER medians for mid-rise RCC frames with a soft (stilt) ground storey —
 * to be replaced by curves signed off by a structural engineer (PRD Section 18).
 *
 * Cascades go through the registry: complete damage spawns 'collapse', damaged
 * kitchens spawn 'fire' (gas cylinders). Lifts stop site-wide (seismic switch).
 */
import { normCdf } from '@twin/core';
import type { HazardInstance, HazardPlugin, SimContext } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';
import { wingStoreyTemplate, type Twin, type WingModel } from '@twin/twin-data';

const STATES = ['none', 'slight', 'moderate', 'extensive', 'complete'] as const;
const BASE_MEDIANS = [0.1, 0.2, 0.4, 0.75]; // g, PLACEHOLDER
const BETA = 0.6;

function typologyFactor(w: WingModel, softStorey: number): number {
  let f = 1;
  if (w.storeys >= 8) f *= 0.85; // taller G+7 block
  if (w.L > 50) f *= 0.95; // long blocks without expansion joints in the L1 model
  if (w.storeyKinds[0] === 'ground') f *= softStorey; // stilt ground storey
  return f;
}

class QuakeInstance implements HazardInstance {
  private pga = 0;
  private schedule: { t: number; kind: 'fire' | 'aftershock'; wing: number; pga?: number }[] = [];
  private counts = [0, 0, 0, 0, 0];
  /** shaking windows: main shock and aftershocks */
  private windows: { start: number; end: number; level: number; main: boolean; ended: boolean }[] = [];
  private shakingNow = false;
  readonly duration: number;
  constructor(private twin: Twin, ctx: SimContext, private spec: HazardSpec) {
    const p = spec.params;
    const preset = String(p.preset ?? 'DBE');
    const soil = { rock: 1.0, medium: 1.2, soft: 1.45 }[String(p.soil ?? 'medium')] ?? 1.2;
    if (preset === 'DBE') this.pga = 0.08 * soil;
    else if (preset === 'MCE') this.pga = 0.16 * soil;
    else {
      const M = Number(p.magnitude ?? 6.5);
      const R = Number(p.distance_km ?? 30);
      const h = Number(p.depth_km ?? 10);
      this.pga = Math.exp(1.05 + 0.75 * (M - 6) - Math.log(Math.sqrt(R * R + h * h) + 10)) * soil;
    }
    // significant shaking duration: design presets, or grows with magnitude for a scenario
    this.duration = preset === 'DBE' ? 15 : preset === 'MCE' ? 25 : Math.max(5, Math.min(60, Math.round(5 + 6 * (Number(p.magnitude ?? 6.5) - 5))));
    this.windows.push({ start: ctx.t, end: ctx.t + this.duration, level: this.level(this.pga), main: true, ended: false });
    ctx.emit({ type: 'quake', level: 'critical', text: `Earthquake: site PGA ${this.pga.toFixed(2)} g (${preset === 'custom' ? `M${p.magnitude} at ${p.distance_km} km` : `${preset}, Zone III`})` });
    ctx.field.liftsOn = false;
    ctx.emit({ type: 'lifts', level: 'warn', text: 'Seismic switches stop all lifts' });
    this.shake(ctx, this.pga, true);
    ctx.emit({ type: 'shaking', level: 'critical', text: `Strong shaking for about ${this.duration} s: drop, cover and hold on; do not run outside while it shakes` });
    // people leave only once the shaking stops (plus a moment to collect themselves)
    ctx.alertAll('earthquake', this.duration + 10);
    if (p.aftershocks) {
      const n = 2;
      for (let k = 0; k < n; k++) this.schedule.push({ t: ctx.t + ctx.rng.range(240, 1500), kind: 'aftershock', wing: -1, pga: this.pga * ctx.rng.range(0.35, 0.6) });
    }
  }

  private shake(ctx: SimContext, pga: number, main: boolean) {
    const soft = Number(this.spec.params.softStoreyFactor ?? 0.85);
    const f = ctx.field;
    for (const w of this.twin.wings) {
      if (w.massingOnly) continue;
      const local = pga * Math.exp(0.3 * ctx.rng.normal());
      const fac = typologyFactor(w, soft);
      const u = ctx.rng.next();
      let ds = 0;
      for (let k = 0; k < 4; k++) {
        const med = BASE_MEDIANS[k] * fac * (f.wingDamage[w.idx] >= k + 1 ? 0.8 : 1);
        const P = normCdf(Math.log(local / med) / BETA);
        if (u < P) ds = k + 1;
      }
      if (ds <= f.wingDamage[w.idx]) continue;
      f.wingDamage[w.idx] = ds;
      f.activeWings.add(w.idx);
      // structural effects per state
      if (ds === 4) {
        const frac = ctx.rng.range(0.3, 0.8);
        ctx.spawn({ type: 'collapse', params: { trigger: 'seismic', spanFrac: frac, extent: 'local' }, origin: { kind: 'building', E: w.pose.E, N: w.pose.N, up: 0, buildingId: w.id, storey: 0 }, t: ctx.t });
      } else if (ds === 3) {
        for (let s = 0; s < w.storeys; s++) {
          const st = wingStoreyTemplate(w, s);
          for (const stair of st.stairs) if (ctx.rng.chance(0.25)) f.damage[w.storeyOffsets[s] + stair.space] = 3;
        }
      }
      if (ds >= 2 && ctx.rng.chance(0.06 * ds)) this.schedule.push({ t: ctx.t + ctx.rng.range(60, 600), kind: 'fire', wing: w.idx });
    }
    this.counts = [0, 0, 0, 0, 0];
    for (const w of this.twin.wings) if (!w.massingOnly) this.counts[f.wingDamage[w.idx]]++;
    const msg = this.counts.map((c, k) => (k > 0 && c ? `${c} ${STATES[k]}` : '')).filter(Boolean).join(', ') || 'no structural damage';
    ctx.emit({ type: main ? 'damage' : 'aftershock', level: this.counts[4] || this.counts[3] ? 'critical' : 'warn', text: `${main ? 'Damage survey' : 'Aftershock'}: ${msg}`, data: { counts: this.counts } });
  }

  private level(pga: number) {
    return Math.max(0.35, Math.min(1.6, pga / 0.12));
  }

  private updateShaking(ctx: SimContext) {
    const t = ctx.t;
    let s = 0;
    for (const w of this.windows) {
      if (t >= w.start && t <= w.end) {
        const dur = w.end - w.start;
        const env = Math.min(1, (t - w.start) / 2) * Math.min(1, (w.end - t) / (0.3 * dur));
        s = Math.max(s, w.level * env);
      } else if (t > w.end && !w.ended) {
        w.ended = true;
        if (w.main) ctx.emit({ type: 'shaking-stopped', level: 'warn', text: 'Shaking stopped: leave by the stairs (never the lifts) to open ground, clear of the marked fall zones' });
      }
    }
    if (s > 0) {
      ctx.field.shaking = Math.max(ctx.field.shaking, s);
      this.shakingNow = true;
    } else if (this.shakingNow) {
      ctx.field.shaking = 0;
      this.shakingNow = false;
    }
  }

  step(_dt: number, ctx: SimContext): void {
    if (this.shakingNow) ctx.field.shaking = 0;
    this.updateShaking(ctx);
    const due = this.schedule.filter((x) => x.t <= ctx.t);
    this.schedule = this.schedule.filter((x) => x.t > ctx.t);
    for (const d of due) {
      if (d.kind === 'aftershock') {
        this.windows.push({ start: ctx.t, end: ctx.t + 6, level: this.level(d.pga!), main: false, ended: false });
        this.shake(ctx, d.pga!, false);
      }
      else {
        const w = this.twin.wings[d.wing];
        // ignite a kitchen on a random flat storey
        const s = w.flatFloors[Math.floor(ctx.rng.next() * w.flatFloors.length)] ?? 1;
        const st = wingStoreyTemplate(w, s);
        const kitchens = st.spaces.filter((sp) => sp.roomRole === 'kitchen');
        if (!kitchens.length) continue;
        const k = kitchens[Math.floor(ctx.rng.next() * kitchens.length)];
        const g = w.storeyOffsets[s] + k.i;
        if (ctx.field.damage[g] >= 4) continue;
        ctx.spawn({ type: 'fire', params: { growth: 'fast', alarmDelay_s: 30 }, origin: { kind: 'space', E: this.twin.space.E[g], N: this.twin.space.N[g], up: s * 3, buildingId: w.id, storey: s, spaceId: g, label: `${w.id} kitchen, floor ${s} (gas cylinder after the quake)` }, t: ctx.t });
      }
    }
  }
  done() {
    return this.schedule.length === 0 && this.windows.every((w) => w.ended);
  }
  summary() {
    return { pga_g: Math.round(this.pga * 100) / 100, shaking_s: this.duration, complete: this.counts[4], extensive: this.counts[3], moderate: this.counts[2], slight: this.counts[1] };
  }
}

export const earthquakePlugin: HazardPlugin = {
  id: 'earthquake',
  label: 'Earthquake',
  description: 'Zone III design events or a magnitude-distance scenario; damage, collapse, fires, lifts',
  release: 'v1',
  pinned: true,
  enabled: true,
  targets: ['space', 'building', 'outdoor'],
  params: [
    { key: 'preset', label: 'Ground motion', type: 'select', default: 'DBE', options: [
      { value: 'DBE', label: 'Design basis, Zone III (PGA 0.08 g)' },
      { value: 'MCE', label: 'Maximum considered, Zone III (PGA 0.16 g)' },
      { value: 'custom', label: 'Scenario: magnitude and distance' }] },
    { key: 'magnitude', label: 'Magnitude (scenario)', type: 'number', min: 4, max: 8.5, step: 0.1, default: 6.5 },
    { key: 'distance_km', label: 'Epicentral distance (scenario)', type: 'number', unit: 'km', min: 1, max: 300, step: 1, default: 30 },
    { key: 'depth_km', label: 'Focal depth (scenario)', type: 'number', unit: 'km', min: 2, max: 60, step: 1, default: 10 },
    { key: 'soil', label: 'Site soil', type: 'select', default: 'medium', options: [
      { value: 'rock', label: 'Rock / hard soil' }, { value: 'medium', label: 'Medium soil (assumed)' }, { value: 'soft', label: 'Soft soil' }] },
    { key: 'softStoreyFactor', label: 'Soft-storey factor (stilt ground floor)', type: 'number', min: 0.5, max: 1, step: 0.05, default: 0.85, help: 'Multiplies fragility medians where the ground storey is open' },
    { key: 'aftershocks', label: 'Aftershocks', type: 'boolean', default: true },
  ],
  create: (ctx, spec) => new QuakeInstance(ctx.twin, ctx, spec),
};
