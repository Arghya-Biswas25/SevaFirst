/**
 * Outdoor hazard zones and the per-edge risk field (design §3).
 *
 * Plugins write per-space state; outdoors, danger is derived from it every 2 s into
 * zones (ENU polygons): collapse cordons, earthquake fall zones, fire exposure around
 * burning wings, downwind smoke plumes and debris. Each outdoor nav edge is sampled
 * every 4 m once; its risk is the mean zone risk over its samples (so a long edge that
 * only grazes a zone is penalised for the part inside it). The crowd, dispatch and the
 * route planner all read this one field.
 */
import { localToEN, pointAlongPolyline, pointInPolygon, polylineLength, type Vec2 } from '@twin/core';
import type { FieldStore } from '@twin/hazard-sdk';
import type { NavGraph } from '@twin/nav';
import type { Twin, WingModel } from '@twin/twin-data';

export type ZoneKind = 'collapse' | 'fall' | 'fire' | 'plume' | 'debris';

export interface HazardZone {
  id: string;
  kind: ZoneKind;
  label: string;
  /** 0..1 — penalty weight for routing; >= CLOSE_RISK closes an assembly point inside it */
  risk: number;
  poly: Vec2[];
  bbox: [number, number, number, number];
  wing: number;
  /** metres the zone extends beyond the building footprint */
  reach: number;
}

export interface Wind {
  speed_ms: number;
  fromDeg: number;
}

/** An assembly point whose location has at least this risk is closed. */
export const CLOSE_RISK = 0.45;
const SAMPLE_M = 4;

function bboxOf(poly: Vec2[]): [number, number, number, number] {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [E, N] of poly) {
    if (E < a) a = E;
    if (N < b) b = N;
    if (E > c) c = E;
    if (N > d) d = N;
  }
  return [a, b, c, d];
}

function grownFootprint(w: WingModel, reach: number): Vec2[] {
  const hx = w.L / 2 + reach;
  const hy = w.W / 2 + reach;
  return [localToEN(w.pose, -hx, -hy), localToEN(w.pose, hx, -hy), localToEN(w.pose, hx, hy), localToEN(w.pose, -hx, hy)];
}

/** Heat release and burning-room count per wing, from the field. */
export function wingFire(twin: Twin, f: FieldStore, w: number): { hrr: number; rooms: number; lowest: number } {
  const wing = twin.wings[w];
  if (wing.massingOnly) return { hrr: 0, rooms: 0, lowest: -1 };
  const start = wing.storeyOffsets[0];
  let hrr = 0;
  let rooms = 0;
  let lowest = 99;
  for (let i = start; i < start + wing.spaceCount; i++) {
    if (f.burn[i] === 1 || f.burn[i] === 2) {
      rooms++;
      hrr += f.hrr[i];
      if (twin.space.storey[i] < lowest) lowest = twin.space.storey[i];
    }
  }
  return { hrr, rooms, lowest: rooms ? lowest : -1 };
}

/** Derive the current outdoor hazard zones from the field. */
export function deriveZones(twin: Twin, f: FieldStore, wind: Wind): HazardZone[] {
  const zones: HazardZone[] = [];
  const add = (z: Omit<HazardZone, 'bbox'>) => zones.push({ ...z, bbox: bboxOf(z.poly) });
  const seen = new Set<number>(f.activeWings);
  for (const w of twin.wings) if (f.wingDamage[w.idx] >= 2) seen.add(w.idx);
  for (const wi of seen) {
    const w = twin.wings[wi];
    const d = f.wingDamage[wi];
    if (d >= 4) {
      const reach = Math.min(20, w.height);
      add({ id: `collapse-${w.id}`, kind: 'collapse', label: `Collapse cordon ${w.id} (${reach.toFixed(0)} m)`, risk: 0.85, poly: grownFootprint(w, reach), wing: wi, reach });
    } else if (d === 3) {
      const reach = 0.75 * w.height;
      add({ id: `fall-${w.id}`, kind: 'fall', label: `Fall zone ${w.id}: extensive damage (${reach.toFixed(0)} m)`, risk: 0.5, poly: grownFootprint(w, reach), wing: wi, reach });
    } else if (d === 2) {
      const reach = 0.35 * w.height;
      add({ id: `fall-${w.id}`, kind: 'fall', label: `Fall zone ${w.id}: moderate damage (${reach.toFixed(0)} m)`, risk: 0.25, poly: grownFootprint(w, reach), wing: wi, reach });
    }
    const fire = wingFire(twin, f, wi);
    if (fire.rooms) {
      const k = Math.min(1, fire.hrr / 5000);
      const reach = 6 + 6 * k;
      add({ id: `fire-${w.id}`, kind: 'fire', label: `Fire exposure ${w.id}: radiant heat, falling glass`, risk: 0.35 + 0.35 * k, poly: grownFootprint(w, reach), wing: wi, reach });
      if (wind.speed_ms >= 1) {
        const b = ((wind.fromDeg + 180) * Math.PI) / 180; // downwind bearing
        const dE = Math.sin(b);
        const dN = Math.cos(b);
        const pE = Math.cos(b);
        const pN = -Math.sin(b);
        const len = Math.min(100, Math.max(40, 35 + 8 * wind.speed_ms));
        const bw = Math.max(8, w.W / 2 + 4);
        const fw = bw + len * Math.tan((18 * Math.PI) / 180);
        const { E, N } = w.pose;
        add({
          id: `plume-${w.id}`, kind: 'plume', label: `Smoke plume from ${w.id} (downwind)`, risk: 0.12 + 0.2 * Math.min(1, fire.hrr / 4000),
          poly: [[E + pE * bw, N + pN * bw], [E + dE * len + pE * fw, N + dN * len + pN * fw], [E + dE * len - pE * fw, N + dN * len - pN * fw], [E - pE * bw, N - pN * bw]],
          wing: wi, reach: len,
        });
      }
    }
  }
  for (const d of f.debris) add({ id: `debris-${d.id}`, kind: 'debris', label: `Debris from ${twin.wings[d.wing]?.id ?? 'collapse'}`, risk: 0.9, poly: d.poly, wing: d.wing, reach: 0 });
  return zones;
}

export class EdgeRisk {
  /** mean zone risk along each edge (0 for indoor edges) */
  readonly risk: Float32Array;
  /** index into `zones` of the worst zone the edge crosses, or -1 */
  readonly zoneOf: Int16Array;
  zones: HazardZone[] = [];
  /** bumps whenever the zones or the edge risks change */
  version = 0;
  private edgeIds: Int32Array;
  private sStart: Int32Array;
  private sCount: Int32Array;
  private sE: Float32Array;
  private sN: Float32Array;
  private eBox: Float32Array;
  private nextAt = -Infinity;
  private sig = '';

  constructor(private twin: Twin, private nav: NavGraph) {
    const nE = nav.edges.length;
    this.risk = new Float32Array(nE);
    this.zoneOf = new Int16Array(nE).fill(-1);
    const ids: number[] = [];
    const starts: number[] = [];
    const counts: number[] = [];
    const E: number[] = [];
    const N: number[] = [];
    const box: number[] = [];
    for (const e of nav.edges) {
      if (!e.pts || e.pts.length < 2) continue;
      const L = polylineLength(e.pts);
      const n = Math.max(2, Math.ceil(L / SAMPLE_M) + 1);
      ids.push(e.id);
      starts.push(E.length);
      counts.push(n);
      let a = Infinity;
      let b = Infinity;
      let c = -Infinity;
      let d = -Infinity;
      for (let k = 0; k < n; k++) {
        const p = pointAlongPolyline(e.pts, (k / (n - 1)) * L);
        E.push(p[0]);
        N.push(p[1]);
        a = Math.min(a, p[0]);
        b = Math.min(b, p[1]);
        c = Math.max(c, p[0]);
        d = Math.max(d, p[1]);
      }
      box.push(a, b, c, d);
    }
    this.edgeIds = Int32Array.from(ids);
    this.sStart = Int32Array.from(starts);
    this.sCount = Int32Array.from(counts);
    this.sE = Float32Array.from(E);
    this.sN = Float32Array.from(N);
    this.eBox = Float32Array.from(box);
  }

  reset(): void {
    this.risk.fill(0);
    this.zoneOf.fill(-1);
    this.zones = [];
    this.sig = '';
    this.nextAt = -Infinity;
    this.version++;
  }

  /** Re-derive zones (every 2 s of simulated time, or now with `force`). Returns true if anything changed. */
  update(f: FieldStore, t: number, wind: Wind, force = false): boolean {
    if (!force && t < this.nextAt) return false;
    this.nextAt = t + 2;
    const zones = deriveZones(this.twin, f, wind);
    const sig = zones.map((z) => `${z.id}:${z.risk.toFixed(2)}:${z.reach.toFixed(1)}`).join('|');
    if (sig === this.sig) return false;
    this.sig = sig;
    this.zones = zones;
    this.risk.fill(0);
    this.zoneOf.fill(-1);
    if (zones.length) {
      const near: HazardZone[] = [];
      const nearIdx: number[] = [];
      for (let k = 0; k < this.edgeIds.length; k++) {
        const bx0 = this.eBox[k * 4];
        const by0 = this.eBox[k * 4 + 1];
        const bx1 = this.eBox[k * 4 + 2];
        const by1 = this.eBox[k * 4 + 3];
        near.length = 0;
        nearIdx.length = 0;
        zones.forEach((z, zi) => {
          if (z.bbox[0] <= bx1 && z.bbox[2] >= bx0 && z.bbox[1] <= by1 && z.bbox[3] >= by0) {
            near.push(z);
            nearIdx.push(zi);
          }
        });
        if (!near.length) continue;
        const s0 = this.sStart[k];
        const n = this.sCount[k];
        let sum = 0;
        let worst = -1;
        let worstR = 0;
        for (let s = s0; s < s0 + n; s++) {
          const p: Vec2 = [this.sE[s], this.sN[s]];
          let r = 0;
          let zi = -1;
          for (let j = 0; j < near.length; j++) {
            const z = near[j];
            if (z.risk <= r) continue;
            if (p[0] < z.bbox[0] || p[0] > z.bbox[2] || p[1] < z.bbox[1] || p[1] > z.bbox[3]) continue;
            if (pointInPolygon(p, z.poly)) {
              r = z.risk;
              zi = nearIdx[j];
            }
          }
          sum += r;
          if (r > worstR) {
            worstR = r;
            worst = zi;
          }
        }
        const e = this.edgeIds[k];
        this.risk[e] = sum / n;
        this.zoneOf[e] = worst;
      }
    }
    this.version++;
    return true;
  }

  /** Highest zone risk at a point and the zone it comes from. */
  pointRisk(E: number, N: number): { risk: number; zone: HazardZone | null } {
    let r = 0;
    let best: HazardZone | null = null;
    for (const z of this.zones) {
      if (z.risk <= r) continue;
      if (E < z.bbox[0] || E > z.bbox[2] || N < z.bbox[1] || N > z.bbox[3]) continue;
      if (pointInPolygon([E, N], z.poly)) {
        r = z.risk;
        best = z;
      }
    }
    return { risk: r, zone: best };
  }

  zoneLabel(edge: number): string | null {
    const zi = this.zoneOf[edge];
    return zi >= 0 ? this.zones[zi]?.label ?? null : null;
  }
}
