/**
 * Simulation overlays built for smooth animation (docs/RESPONSE_DESIGN.md §8):
 *
 * - PeopleLayer: previous and next positions live in GPU instance attributes and the
 *   vertex shader interpolates them with one uniform, so a frame costs one uniform
 *   update, not 16k matrix writes.
 * - FlowLayer: evacuation flow as thick dashed segments in three width buckets; dashes
 *   scroll at walking speed in the walking direction (GPU, via dashOffset).
 * - RouteLayer: wide-line routes with a dark outline and start/end markers, rebuilt
 *   only when the route set changes; dashes animate on the GPU.
 * - ZoneLayer: hazard zones as translucent fills with marching dashed outlines.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { flatPolygon } from '@twin/geometry';
import type { HazardZone } from '@twin/routing';

const resolution = new THREE.Vector2(800, 600);
const materials = new Set<LineMaterial>();

/** Every wide-line material needs the viewport size; call on resize. */
export function setLineResolution(w: number, h: number) {
  resolution.set(w, h);
  for (const m of materials) m.resolution.copy(resolution);
}

/** Keep a wide-line material sized with the viewport (or stop doing so). */
export function trackLineMaterial(m: LineMaterial, on = true) {
  if (on) {
    m.resolution.copy(resolution);
    materials.add(m);
  } else materials.delete(m);
}

function lineMat(p: { color?: string; width: number; dashed?: boolean; dash?: number; gap?: number; opacity?: number; onTop?: boolean; vertexColors?: boolean }): LineMaterial {
  const m = new LineMaterial({
    color: p.vertexColors ? 0xffffff : new THREE.Color(p.color ?? '#ffffff').getHex(),
    linewidth: p.width,
    vertexColors: !!p.vertexColors,
    dashed: !!p.dashed,
    dashSize: p.dash ?? 3,
    gapSize: p.gap ?? 2,
    transparent: true,
    opacity: p.opacity ?? 1,
    depthTest: !p.onTop,
    depthWrite: false,
    worldUnits: false,
  });
  m.resolution.copy(resolution);
  materials.add(m);
  return m;
}

function disposeMat(m: THREE.Material) {
  if (m instanceof LineMaterial) materials.delete(m);
  m.dispose();
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const any = c as THREE.Mesh;
    if (any.geometry) any.geometry.dispose();
    const mat = any.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMat);
    else if (mat) {
      const sm = mat as THREE.SpriteMaterial;
      if (sm.map) sm.map.dispose();
      disposeMat(mat);
    }
  });
}

/** ENU flattened [E, N, z, ...] -> three.js [x, y, z, ...] lifted by `lift`. */
function toThree(pts: number[], lift: number): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 3) {
    out[i] = pts[i];
    out[i + 1] = pts[i + 2] + lift;
    out[i + 2] = -pts[i + 1];
  }
  return out;
}

// ------------------------------------------------------------------ people
export class PeopleLayer {
  readonly mesh: THREE.InstancedMesh;
  private aPrev: THREE.InstancedBufferAttribute;
  private aNext: THREE.InstancedBufferAttribute;
  private aOff: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private uK = { value: 1 };
  private uScale = { value: 1 };
  /** per group: displayed position at the last update (from) and target (to) */
  private from = new Float32Array(0);
  private to = new Float32Array(0);
  private tSnap = 0;
  private interval = 110;
  private rgb: number[][];

  constructor(private cap: number, statusColors: string[]) {
    this.rgb = statusColors.map((c) => new THREE.Color(c).toArray());
    const geo = new THREE.CapsuleGeometry(0.28, 1.1, 2, 6);
    geo.translate(0, 0.85, 0);
    this.aPrev = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aNext = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aOff = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    for (const a of [this.aPrev, this.aNext, this.aOff]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPrev', this.aPrev);
    geo.setAttribute('aNext', this.aNext);
    geo.setAttribute('aOff', this.aOff);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uK = this.uK;
      sh.uniforms.uScale = this.uScale;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aPrev;\nattribute vec3 aNext;\nattribute vec2 aOff;\nuniform float uK;\nuniform float uScale;')
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position) * uScale + mix(aPrev, aNext, uK) + vec3(aOff.x, 0.0, aOff.y) * uScale;');
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.color.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.color;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }

  private k(now: number) {
    return Math.min(1, Math.max(0, (now - this.tSnap) / this.interval));
  }

  /** New snapshot of groups (E, N, z, status, size per group). */
  update(groups: Float32Array, now: number) {
    const G = groups.length / 5;
    const k = this.k(now);
    if (this.to.length !== G * 3) {
      this.from = new Float32Array(G * 3);
      this.to = new Float32Array(G * 3);
      for (let i = 0; i < G; i++) {
        this.to[i * 3] = groups[i * 5];
        this.to[i * 3 + 1] = groups[i * 5 + 2] + 0.22;
        this.to[i * 3 + 2] = -groups[i * 5 + 1];
      }
      this.from.set(this.to);
    }
    const dt = now - this.tSnap;
    if (this.tSnap > 0 && dt > 30 && dt < 1000) this.interval = 0.7 * this.interval + 0.3 * Math.min(320, Math.max(60, dt));
    this.tSnap = now;
    const from = this.from;
    const to = this.to;
    const P = this.aPrev.array as Float32Array;
    const Nx = this.aNext.array as Float32Array;
    const O = this.aOff.array as Float32Array;
    const C = this.color.array as Float32Array;
    let n = 0;
    for (let i = 0; i < G; i++) {
      const o = i * 3;
      // where this group is drawn right now, so motion continues without a jump
      const cx = from[o] + (to[o] - from[o]) * k;
      const cy = from[o + 1] + (to[o + 1] - from[o + 1]) * k;
      const cz = from[o + 2] + (to[o + 2] - from[o + 2]) * k;
      const nx = groups[i * 5];
      const ny = groups[i * 5 + 2] + 0.22;
      const nz = -groups[i * 5 + 1];
      const jump = Math.abs(nx - cx) + Math.abs(nz - cz) + Math.abs(ny - cy) > 40;
      from[o] = jump ? nx : cx;
      from[o + 1] = jump ? ny : cy;
      from[o + 2] = jump ? nz : cz;
      to[o] = nx;
      to[o + 1] = ny;
      to[o + 2] = nz;
      const status = groups[i * 5 + 3];
      if (status === 0) continue; // idle people stay hidden inside their flats
      const size = Math.min(5, groups[i * 5 + 4]);
      const rgb = this.rgb[status] ?? this.rgb[0];
      for (let s = 0; s < size && n < this.cap; s++) {
        const ang = (s / Math.max(1, size)) * Math.PI * 2 + i;
        const rad = size > 1 ? 0.45 : 0;
        P[n * 3] = from[o];
        P[n * 3 + 1] = from[o + 1];
        P[n * 3 + 2] = from[o + 2];
        Nx[n * 3] = nx;
        Nx[n * 3 + 1] = ny;
        Nx[n * 3 + 2] = nz;
        O[n * 2] = Math.cos(ang) * rad;
        O[n * 2 + 1] = Math.sin(ang) * rad;
        C[n * 3] = rgb[0];
        C[n * 3 + 1] = rgb[1];
        C[n * 3 + 2] = rgb[2];
        n++;
      }
    }
    this.mesh.count = n;
    for (const [a, w] of [[this.aPrev, 3], [this.aNext, 3], [this.aOff, 2], [this.color, 3]] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n * w));
      a.needsUpdate = true;
    }
    this.uK.value = 0;
  }

  /** Per frame: one uniform. */
  frame(now: number, scale: number) {
    this.uK.value = this.k(now);
    this.uScale.value = scale;
  }

  clear() {
    this.mesh.count = 0;
    this.from = new Float32Array(0);
    this.to = new Float32Array(0);
    this.tSnap = 0;
  }
}

// ------------------------------------------------------------------ evacuation flow
const FLOW_BUCKETS = [
  { max: 8, width: 2.2 },
  { max: 40, width: 3.6 },
  { max: Infinity, width: 5.4 },
];
const C_FREE = new THREE.Color('#4ade80');
const C_BUSY = new THREE.Color('#facc15');
const C_JAM = new THREE.Color('#f87171');

export class FlowLayer {
  readonly group = new THREE.Group();
  private lines: LineSegments2[] = [];
  private lastBuild = 0;
  private pending: Float32Array | null = null;
  constructor() {
    for (const b of FLOW_BUCKETS) {
      const mat = lineMat({ width: b.width, vertexColors: true, dashed: true, dash: 2.4, gap: 1.8, opacity: 0.92 });
      const l = new LineSegments2(new LineSegmentsGeometry(), mat);
      l.visible = false;
      l.frustumCulled = false;
      l.renderOrder = 3;
      this.lines.push(l);
      this.group.add(l);
    }
  }

  set(flows: Float32Array) {
    this.pending = flows;
  }

  private build(flows: Float32Array) {
    const n = flows.length / 8;
    const pos: number[][] = FLOW_BUCKETS.map(() => []);
    const col: number[][] = FLOW_BUCKETS.map(() => []);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      const people = flows[o + 6];
      const cong = flows[o + 7];
      const b = FLOW_BUCKETS.findIndex((x) => people < x.max);
      if (cong < 0.5) c.lerpColors(C_FREE, C_BUSY, cong / 0.5);
      else c.lerpColors(C_BUSY, C_JAM, Math.min(1, (cong - 0.5) / 0.5));
      pos[b].push(flows[o], flows[o + 2] + 0.45, -flows[o + 1], flows[o + 3], flows[o + 5] + 0.45, -flows[o + 4]);
      col[b].push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    this.lines.forEach((l, i) => {
      const old = l.geometry;
      if (!pos[i].length) {
        l.visible = false;
        return;
      }
      const g = new LineSegmentsGeometry();
      g.setPositions(pos[i]);
      g.setColors(col[i]);
      l.geometry = g;
      old.dispose();
      l.computeLineDistances();
      l.visible = true;
    });
  }

  frame(dt: number, now: number) {
    for (const l of this.lines) (l.material as LineMaterial).dashOffset -= dt * 1.3;
    // geometry refresh at most 3 times a second; the dashes keep moving in between
    if (this.pending && now - this.lastBuild > 330) {
      this.lastBuild = now;
      this.build(this.pending);
      this.pending = null;
    }
  }

  clear() {
    this.pending = null;
    for (const l of this.lines) l.visible = false;
  }
}

// ------------------------------------------------------------------ routes
export interface DrawRoute {
  id: string;
  pts: number[];
  color: string;
  width: number;
  dashed?: boolean;
  onTop?: boolean;
  opacity?: number;
  /** draw start/end markers */
  ends?: boolean;
}

export class RouteLayer {
  readonly group = new THREE.Group();
  private sig = '';
  private dashed: LineMaterial[] = [];

  set(routes: DrawRoute[], sig: string) {
    if (sig === this.sig) return;
    this.sig = sig;
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      disposeTree(c);
    }
    this.dashed = [];
    routes.forEach((r, i) => {
      if (r.pts.length < 6) return;
      const p = toThree(r.pts, 0.25);
      const order = r.onTop ? 30 + i * 2 : 5 + i * 2;
      const under = new Line2(new LineGeometry().setPositions(p), lineMat({ color: '#0b1220', width: r.width + 3, opacity: 0.45 * (r.opacity ?? 1), onTop: r.onTop }));
      under.computeLineDistances();
      under.renderOrder = order;
      const mat = lineMat({ color: r.color, width: r.width, dashed: r.dashed, dash: 3.2, gap: 1.8, opacity: r.opacity ?? 1, onTop: r.onTop });
      const line = new Line2(new LineGeometry().setPositions(p), mat);
      line.computeLineDistances();
      line.renderOrder = order + 1;
      under.frustumCulled = false;
      line.frustumCulled = false;
      this.group.add(under, line);
      if (r.dashed) this.dashed.push(mat);
      if (r.ends) {
        const mk = (x: number, y: number, z: number, rad: number, color: string) => {
          const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 16, 10), new THREE.MeshBasicMaterial({ color, depthTest: !r.onTop, transparent: true, opacity: r.opacity ?? 1 }));
          m.position.set(x, y, z);
          m.renderOrder = order + 1;
          this.group.add(m);
        };
        mk(p[0], p[1], p[2], 0.9, r.color);
        const L = p.length;
        mk(p[L - 3], p[L - 2] + 0.4, p[L - 1], 1.5, r.color);
      }
    });
  }

  frame(dt: number) {
    for (const m of this.dashed) m.dashOffset -= dt * 4;
  }

  clear() {
    this.set([], '');
  }
}

// ------------------------------------------------------------------ hazard zones
const ZONE_STYLE: Record<string, { color: string; fill: number }> = {
  collapse: { color: '#dc2626', fill: 0.24 },
  fall: { color: '#f97316', fill: 0.16 },
  fire: { color: '#ef4444', fill: 0.2 },
  plume: { color: '#64748b', fill: 0.16 },
  debris: { color: '#92400e', fill: 0 },
};

export class ZoneLayer {
  readonly group = new THREE.Group();
  private sig = '';
  private outlines: LineMaterial[] = [];
  constructor(private label: (text: string, color: string, at: [number, number, number]) => THREE.Object3D) {}

  set(zones: HazardZone[]) {
    const sig = zones.map((z) => `${z.id}:${z.reach.toFixed(1)}:${z.risk.toFixed(2)}`).join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      disposeTree(c);
    }
    this.outlines = [];
    const labelled = zones.length <= 10;
    zones.forEach((z, i) => {
      const st = ZONE_STYLE[z.kind] ?? ZONE_STYLE.fall;
      const y = 0.14 + (i % 8) * 0.012; // avoid z-fighting between overlapping zones
      if (st.fill > 0) {
        const fill = new THREE.Mesh(flatPolygon(z.poly, y), new THREE.MeshBasicMaterial({ color: st.color, transparent: true, opacity: st.fill * (0.6 + 0.6 * z.risk), depthWrite: false, side: THREE.DoubleSide }));
        fill.renderOrder = 2;
        this.group.add(fill);
      }
      const p: number[] = [];
      for (const [E, N] of [...z.poly, z.poly[0]]) p.push(E, y + 0.05, -N);
      const mat = lineMat({ color: st.color, width: z.kind === 'plume' ? 1.5 : 2.2, dashed: true, dash: 2.5, gap: 1.5, opacity: 0.9 });
      const line = new Line2(new LineGeometry().setPositions(p), mat);
      line.computeLineDistances();
      line.renderOrder = 2;
      this.group.add(line);
      this.outlines.push(mat);
      if (z.kind === 'collapse' || z.kind === 'fire' || (labelled && z.kind === 'fall')) {
        // on the zone boundary (its centre is inside the building)
        const [a, b] = [z.poly[0], z.poly[1]];
        const short = z.kind === 'collapse' ? `KEEP OUT · ${z.label.replace('Collapse cordon ', '')}` : z.kind === 'fire' ? `Fire exposure · ${z.label.split(':')[0].replace('Fire exposure ', '')}` : `Fall zone · ${z.label.split(':')[0].replace('Fall zone ', '')}`;
        this.group.add(this.label(short, st.color, [(a[0] + b[0]) / 2, 3, -(a[1] + b[1]) / 2]));
      }
    });
  }

  frame(dt: number) {
    for (const m of this.outlines) m.dashOffset -= dt * 1.5;
  }

  clear() {
    this.set([]);
  }
}
