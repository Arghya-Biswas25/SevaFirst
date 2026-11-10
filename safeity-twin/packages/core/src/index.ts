/**
 * @twin/core — shared primitives used by every engine.
 * Event bus, seeded RNG, geometry helpers, fixed-step scheduler, unit constants.
 * Nothing in here knows about buildings or hazards.
 */

export const SQFT_TO_M2 = 0.09290304;
export const G = 9.81;

// ------------------------------------------------------------------ events
export type Handler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<any>>>();
  on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers.get(type)?.forEach((fn) => fn(payload));
  }
  clear(): void {
    this.handlers.clear();
  }
}

// ------------------------------------------------------------------ RNG
/** Deterministic PRNG (mulberry32). Same seed => same run on every machine. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Lognormal with given median and log-standard-deviation. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt + 0x9e3779b9, 2654435761)) >>> 0);
  }
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ------------------------------------------------------------------ geometry
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Pose of a wing: centre (E, N) in metres and long-axis bearing in degrees clockwise from north. */
export interface Pose {
  E: number;
  N: number;
  bearing: number;
}

/** Local wing coordinates (x along the long axis, y toward the "N" side) -> site ENU. */
export function localToEN(pose: Pose, x: number, y: number): Vec2 {
  const b = deg2rad(pose.bearing);
  const s = Math.sin(b);
  const c = Math.cos(b);
  return [pose.E + x * s - y * c, pose.N + x * c + y * s];
}

/** Site ENU -> local wing coordinates. */
export function enToLocal(pose: Pose, E: number, N: number): Vec2 {
  const b = deg2rad(pose.bearing);
  const s = Math.sin(b);
  const c = Math.cos(b);
  const dE = E - pose.E;
  const dN = N - pose.N;
  return [dE * s + dN * c, -dE * c + dN * s];
}

/** Rotation about +Y (three.js, Y-up, X=E, Z=-N) that aligns local X with the wing axis. */
export function poseYaw(pose: Pose): number {
  return deg2rad(90 - pose.bearing);
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSegment(p: Vec2, a: Vec2, b: Vec2): { d: number; t: number; q: Vec2 } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy || 1e-9;
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
  const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), t, q };
}

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist2(pts[i - 1], pts[i]);
  return L;
}

export function pointAlongPolyline(pts: Vec2[], s: number): Vec2 {
  if (pts.length === 1) return pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist2(pts[i - 1], pts[i]);
    if (acc + seg >= s) {
      const t = seg > 0 ? (s - acc) / seg : 0;
      return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
    }
    acc += seg;
  }
  return pts[pts.length - 1];
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a / 2);
}

// ------------------------------------------------------------------ scheduler
/** Fixed-timestep accumulator: feed it wall-clock deltas, it calls `step` with a constant dt. */
export class FixedStep {
  private acc = 0;
  constructor(public readonly dt: number, private maxSteps = 240) {}
  advance(elapsed: number, step: (dt: number) => void): number {
    this.acc += elapsed;
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      step(this.dt);
      this.acc -= this.dt;
      n++;
    }
    if (n === this.maxSteps) this.acc = 0; // drop backlog rather than spiral
    return n;
  }
}

// ------------------------------------------------------------------ formatting
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `T+${String(m).padStart(2, '0')}:${ss}`;
}

export function round(v: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
