/**
 * Building collapse (PRD Section 7.3), fast mode.
 *
 * Structural bays follow the floor-plate segment lines (column lines). Removing a
 * column fails the bays either side of it on that storey and every storey above
 * (no alternate load path assumed in the L1 model); "progressive" lets failure
 * propagate to further bays with a probability per bay. A gas explosion fails a
 * radius around the origin. Debris extends from the failed facade by half the
 * collapsed height and blocks streets and paths it covers.
 */
import { enToLocal, localToEN, polylineLength, type Vec2 } from '@twin/core';
import type { HazardInstance, HazardPlugin, SimContext } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';
import type { Twin, WingModel } from '@twin/twin-data';
import { wingStoreyTemplate } from '@twin/twin-data';

function columnLines(w: WingModel): number[] {
  const xs = new Set<number>([-w.L / 2, w.L / 2]);
  for (const side of ['N', 'S'] as const) {
    let x = -w.L / 2;
    for (const g of w.typology.sides[side]) {
      x += g.w;
      xs.add(Math.round(x * 100) / 100);
    }
  }
  return [...xs].sort((a, b) => a - b);
}

export interface CollapseResult {
  wing: number;
  fromStorey: number;
  x0: number;
  x1: number;
  spaces: number;
  debris: Vec2[];
}

/** Shared by the earthquake plugin: fail a span of a wing from a storey upward. */
export function collapseSpan(ctx: SimContext, w: WingModel, x0: number, x1: number, fromStorey: number, reason: string): CollapseResult {
  const f = ctx.field;
  const twin = ctx.twin;
  let n = 0;
  for (let s = fromStorey; s < w.storeys; s++) {
    const st = wingStoreyTemplate(w, s);
    const off = w.storeyOffsets[s];
    for (const sp of st.spaces) {
      const cx = (sp.rect[0] + sp.rect[2]) / 2;
      const g = off + sp.i;
      if (cx >= x0 - 0.01 && cx <= x1 + 0.01) {
        f.damage[g] = 4;
        n++;
      } else if (cx >= x0 - 4 && cx <= x1 + 4 && f.damage[g] < 3) {
        f.damage[g] = 3;
      }
    }
  }
  f.wingDamage[w.idx] = Math.max(f.wingDamage[w.idx], 4);
  f.activeWings.add(w.idx);
  // debris: both long facades, half the collapsed height outward
  const h = (w.storeys - fromStorey) * twin.storeyH;
  const reach = 0.5 * h + 2;
  const debris: Vec2[] = [
    localToEN(w.pose, x0 - 1, -w.W / 2 - reach),
    localToEN(w.pose, x1 + 1, -w.W / 2 - reach),
    localToEN(w.pose, x1 + 1, w.W / 2 + reach),
    localToEN(w.pose, x0 - 1, w.W / 2 + reach),
  ];
  f.debris.push({ id: `D${f.debris.length + 1}`, wing: w.idx, poly: debris, height: Math.min(6, 0.25 * h) });
  // block streets covered by debris
  let blocked = 0;
  twin.ds.streets.features.forEach((sf, i) => {
    if (f.blockedStreet[i]) return;
    const pts = sf.geometry.coordinates;
    const L = polylineLength(pts);
    const samples = Math.max(2, Math.ceil(L / 3));
    for (let k = 0; k <= samples; k++) {
      const p = pointAt(pts, (k / samples) * L);
      const [u, v] = enToLocal(w.pose, p[0], p[1]);
      if (u >= x0 - 1 && u <= x1 + 1 && Math.abs(v) <= w.W / 2 + reach) {
        f.blockedStreet[i] = 1;
        blocked++;
        break;
      }
    }
  });
  ctx.emit({
    type: 'collapse', level: 'critical', wing: w.idx,
    text: `${reason}: ${w.id} fails over ${(x1 - x0).toFixed(0)} m from ${fromStorey === 0 ? 'ground' : `floor ${fromStorey}`} up; ${blocked} street segment${blocked === 1 ? '' : 's'} blocked by debris`,
    data: { spaces: n, blockedStreets: blocked },
  });
  return { wing: w.idx, fromStorey, x0, x1, spaces: n, debris };
}

function pointAt(pts: Vec2[], s: number): Vec2 {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + seg >= s) {
      const t = seg ? (s - acc) / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

class CollapseInstance implements HazardInstance {
  private result: CollapseResult[] = [];
  private pending: { t: number; x0: number; x1: number; s: number }[] = [];
  private w: WingModel;
  constructor(twin: Twin, ctx: SimContext, spec: HazardSpec) {
    const o = spec.origin;
    const wi = o.buildingId ? twin.wingById.get(o.buildingId) : undefined;
    if (wi === undefined) throw new Error('collapse needs a building');
    this.w = twin.wings[wi];
    if (this.w.massingOnly) throw new Error('no structural model for a massing-only building');
    const [x] = enToLocal(this.w.pose, o.E, o.N);
    const storey = Math.max(0, Math.min(this.w.storeys - 1, o.storey ?? 0));
    const trigger = String(spec.params.trigger ?? 'column-loss');
    const lines = columnLines(this.w);
    let x0: number;
    let x1: number;
    if (trigger === 'explosion') {
      const r = Number(spec.params.blastRadius_m ?? 6);
      x0 = Math.max(-this.w.L / 2, x - r);
      x1 = Math.min(this.w.L / 2, x + r);
    } else if (trigger === 'seismic') {
      // spawned by the earthquake plugin: a fraction of the wing length fails
      const frac = Math.max(0.15, Math.min(1, Number(spec.params.spanFrac ?? 0.5)));
      const half = (frac * this.w.L) / 2;
      const c = Math.max(-this.w.L / 2 + half, Math.min(this.w.L / 2 - half, x));
      x0 = c - half;
      x1 = c + half;
    } else {
      // nearest column line, fail one bay either side
      let k = 0;
      for (let i = 0; i < lines.length; i++) if (Math.abs(lines[i] - x) < Math.abs(lines[k] - x)) k = i;
      x0 = lines[Math.max(0, k - 1)];
      x1 = lines[Math.min(lines.length - 1, k + 1)];
    }
    const fromStorey = trigger === 'construction' ? Math.max(1, storey) : storey;
    const reason = trigger === 'explosion' ? 'Gas explosion and partial collapse' : trigger === 'seismic' ? 'Earthquake collapse' : trigger === 'construction' ? 'Construction failure' : 'Column loss';
    this.result.push(collapseSpan(ctx, this.w, x0, x1, fromStorey, reason));
    ctx.alert([this.w.idx, ...this.w.neighbors], 'structural collapse', 30);
    const cordon = Math.round(Math.min(20, this.w.height));
    ctx.emit({ type: 'cordon', level: 'warn', wing: this.w.idx, text: `Cordon: keep ${cordon} m clear of ${this.w.id} (one building height); no entry without shoring; ${this.w.neighbors.length} neighbouring wings alerted` });
    if (String(spec.params.extent ?? 'local') === 'progressive') {
      const p = Number(spec.params.propagation ?? 0.45);
      let left = lines.indexOf(x0);
      let right = lines.indexOf(x1);
      let t = ctx.t;
      while (left > 0 && ctx.rng.chance(p)) {
        t += ctx.rng.range(4, 12);
        this.pending.push({ t, x0: lines[left - 1], x1: lines[left], s: fromStorey });
        left--;
      }
      t = ctx.t;
      while (right < lines.length - 1 && ctx.rng.chance(p)) {
        t += ctx.rng.range(4, 12);
        this.pending.push({ t, x0: lines[right], x1: lines[right + 1], s: fromStorey });
        right++;
      }
    }
  }
  step(_dt: number, ctx: SimContext): void {
    for (const p of this.pending.filter((q) => q.t <= ctx.t)) {
      this.result.push(collapseSpan(ctx, this.w, p.x0, p.x1, p.s, 'Progressive collapse'));
    }
    this.pending = this.pending.filter((q) => q.t > ctx.t);
  }
  done() {
    return this.pending.length === 0;
  }
  summary() {
    return { wing: this.w.id, failedSpans: this.result.length, failedSpaces: this.result.reduce((a, r) => a + r.spaces, 0) };
  }
}

export const collapsePlugin: HazardPlugin = {
  id: 'collapse',
  label: 'Building collapse',
  description: 'Column loss, gas explosion or construction failure with debris and blocked streets',
  release: 'v1',
  pinned: true,
  enabled: true,
  targets: ['space', 'building'],
  params: [
    { key: 'trigger', label: 'Trigger', type: 'select', default: 'column-loss', options: [
      { value: 'column-loss', label: 'Column loss at the clicked point' },
      { value: 'explosion', label: 'Gas explosion' },
      { value: 'construction', label: 'Construction failure (upper floors)' }] },
    { key: 'extent', label: 'Extent', type: 'select', default: 'local', options: [
      { value: 'local', label: 'Local (bays either side)' }, { value: 'progressive', label: 'Progressive' }] },
    { key: 'propagation', label: 'Propagation probability per bay', type: 'number', min: 0, max: 0.95, step: 0.05, default: 0.45 },
    { key: 'blastRadius_m', label: 'Blast radius (explosion)', type: 'number', unit: 'm', min: 2, max: 20, step: 1, default: 6 },
  ],
  create: (ctx, spec) => new CollapseInstance(ctx.twin, ctx, spec),
};
