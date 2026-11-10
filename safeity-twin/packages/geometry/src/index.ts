/**
 * @twin/geometry — procedural meshes from typology templates, in metres.
 *
 * Local building frame: X along the wing's long axis, Y up, Z = -local y (so the
 * template's "N" side is -Z). One shell geometry per typology and one interior
 * geometry per (typology, storey kind) are built once and instanced per wing and
 * per storey by the renderer — 52 wings come from 7 templates.
 */
import * as THREE from 'three';
import type { StoreyTemplate, TypologyTemplate, Rect } from '@twin/twin-data';
import type { Typology } from '@twin/twin-schema';

export const TYPOLOGY_COLORS: Record<string, string> = {
  'PR-X6': '#45b04f', 'PR-C6': '#1d7d64', 'PR-C8': '#1d7d64', 'S-8': '#4b87c5', 'GR-4': '#4152a3',
  'EC-8': '#dcc23f', 'UNK-8': '#6e50a9', 'MU-E': '#4dbad8', 'MU-N': '#4dbad8', HOTEL: '#a8509f',
};

const FACADE = new THREE.Color('#ece5d8');
const GLASS = new THREE.Color('#3a4756');
const SLAB = new THREE.Color('#cfc7b8');
const RAIL = new THREE.Color('#7f7263');
const COLUMN = new THREE.Color('#bdb5a6');

/** Collects axis-aligned boxes into one non-indexed geometry with normals and colours. */
export class BoxBatch {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  private static FACES: [number[], number[][]][] = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]]],
    [[0, 0, -1], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]]],
  ];
  /** Box centred at (cx, cy, cz) with full sizes (sx, sy, sz). `skipBottom` drops the hidden face. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: THREE.Color, skipBottom = true) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    for (const [n, quad] of BoxBatch.FACES) {
      if (skipBottom && n[1] === -1) continue;
      const v = quad.map(([a, b, d]) => [cx + (a * sx) / 2, cy + (b * sy) / 2, cz + (d * sz) / 2]);
      for (const k of [0, 1, 2, 0, 2, 3]) {
        this.pos.push(v[k][0], v[k][1], v[k][2]);
        this.nor.push(n[0], n[1], n[2]);
        this.col.push(c.r, c.g, c.b);
      }
    }
  }
  /** Box from local plan rectangle (x0, y0, x1, y1) between heights y0h and y1h. */
  rect(r: Rect, h0: number, h1: number, c: THREE.Color, skipBottom = true) {
    const cx = (r[0] + r[2]) / 2;
    const cz = -(r[1] + r[3]) / 2;
    this.box(cx, (h0 + h1) / 2, cz, r[2] - r[0], h1 - h0, r[3] - r[1], c, skipBottom);
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function segmentsX(t: Typology, side: 'N' | 'S') {
  const out: { x0: number; x1: number; kind: string }[] = [];
  let x = -t.L_m / 2;
  for (const s of t.sides[side]) {
    out.push({ x0: x, x1: x + s.w, kind: s.kind });
    x += s.w;
  }
  return out;
}

/**
 * Exterior shell for a typology: slabs, facades with window bands, balconies,
 * stilt columns on an open ground storey, parapet and core headrooms on the roof.
 */
export function buildShell(t: Typology, tpl: TypologyTemplate, storeys: number, H: number, lengthOverride?: number): THREE.BufferGeometry {
  const b = new BoxBatch();
  const L = lengthOverride ?? t.L_m;
  const W = t.W_m;
  const accent = new THREE.Color(TYPOLOGY_COLORS[t.code] ?? '#999999');
  const roofCol = accent.clone().lerp(new THREE.Color('#ffffff'), 0.15);
  const wall = 0.23;
  if (tpl.massingOnly) {
    for (let s = 0; s < storeys; s++) {
      b.box(0, s * H + H / 2, 0, L, H - 0.25, W, s % 2 ? FACADE : FACADE.clone().multiplyScalar(0.97));
      b.box(0, s * H + 1.5, 0, L + 0.06, 1.1, W + 0.06, GLASS);
    }
    b.box(0, storeys * H + 0.1, 0, L, 0.2, W, roofCol);
    b.box(0, storeys * H + 0.6, 0, L, 1.0, W, accent.clone().multiplyScalar(0.8));
    return b.geometry();
  }
  for (let s = 0; s < storeys; s++) {
    const y0 = s * H;
    b.box(0, y0 + 0.1, 0, L, 0.2, W, SLAB, s === 0);
    const isGround = s === 0 || (t.commercialFloors.includes(s) && s === 0);
    const isCommercial = t.commercialFloors.includes(s);
    for (const side of ['N', 'S'] as const) {
      const zf = side === 'N' ? -W / 2 : W / 2;
      for (const seg of segmentsX(t, side)) {
        const w = seg.x1 - seg.x0;
        const cx = (seg.x0 + seg.x1) / 2;
        if (isGround && !isCommercial && seg.kind === 'flat') {
          // stilt: columns at bay ends, open between
          b.box(seg.x0 + 0.25, y0 + H / 2, zf, 0.45, H, 0.45, COLUMN);
          b.box(seg.x1 - 0.25, y0 + H / 2, zf, 0.45, H, 0.45, COLUMN);
          continue;
        }
        // solid wall below and above the window band
        b.box(cx, y0 + 0.2 + 0.45, zf, w, 0.9, wall, FACADE);
        b.box(cx, y0 + 2.45 + (H - 2.45) / 2, zf, w, H - 2.45, wall, FACADE);
        const core = seg.kind === 'stair' || seg.kind === 'lift' || seg.kind === 'shaft';
        if (core) {
          b.box(cx, y0 + 1.75, zf, w, 1.5, wall, seg.kind === 'stair' ? FACADE.clone().multiplyScalar(0.92) : FACADE);
          if (seg.kind === 'stair') b.box(cx, y0 + 1.75, zf + (side === 'N' ? -0.02 : 0.02), Math.min(1.2, w * 0.4), 1.2, wall + 0.02, GLASS);
        } else {
          b.box(cx, y0 + 1.75, zf, w, 1.5, wall * 0.5, GLASS);
          const piers = Math.max(1, Math.round(w / 3.2));
          for (let k = 0; k <= piers; k++) b.box(seg.x0 + (w * k) / piers, y0 + 1.75, zf, 0.3, 1.5, wall + 0.04, FACADE);
        }
      }
      // balconies: projecting slab + railing in front of balcony spaces
      if (!isGround && !isCommercial) {
        for (const sp of tpl.typical.spaces) {
          if (sp.kind !== 'balcony' || sp.side !== side) continue;
          const bx0 = sp.rect[0];
          const bx1 = sp.rect[2];
          const out = side === 'N' ? -1 : 1;
          b.box((bx0 + bx1) / 2, y0 + 0.1, zf + out * 0.6, bx1 - bx0, 0.18, 1.2, SLAB);
          b.box((bx0 + bx1) / 2, y0 + 0.65, zf + out * 1.18, bx1 - bx0, 1.0, 0.06, RAIL);
        }
      }
    }
    // end walls
    for (const xe of [-L / 2, L / 2]) {
      if (isGround && !isCommercial) {
        b.box(xe, y0 + H / 2, -W / 2 + 0.25, 0.45, H, 0.45, COLUMN);
        b.box(xe, y0 + H / 2, W / 2 - 0.25, 0.45, H, 0.45, COLUMN);
        continue;
      }
      b.box(xe, y0 + H / 2, 0, wall, H, W, FACADE);
      b.box(xe + Math.sign(xe) * 0.02, y0 + 1.75, 0, wall, 1.4, 1.2, GLASS);
    }
    // accent band at each slab edge
    b.box(0, y0 + 0.12, -W / 2 - 0.02, L, 0.24, 0.05, accent.clone().lerp(FACADE, 0.55));
    b.box(0, y0 + 0.12, W / 2 + 0.02, L, 0.24, 0.05, accent.clone().lerp(FACADE, 0.55));
  }
  // cores on the ground storey are enclosed
  for (const st of tpl.ground.stairs.concat(tpl.ground.lifts as never[])) {
    const sp = tpl.ground.spaces[(st as { space: number }).space];
    b.rect(sp.rect, 0.2, H, FACADE.clone().multiplyScalar(0.95));
  }
  // roof, parapet, headrooms over stairs and lifts
  const top = storeys * H;
  b.box(0, top + 0.1, 0, L, 0.2, W, roofCol);
  b.box(0, top + 0.6, -W / 2, L, 1.0, 0.2, accent);
  b.box(0, top + 0.6, W / 2, L, 1.0, 0.2, accent);
  b.box(-L / 2, top + 0.6, 0, 0.2, 1.0, W, accent);
  b.box(L / 2, top + 0.6, 0, 0.2, 1.0, W, accent);
  for (const st of tpl.typical.stairs) b.rect(tpl.typical.spaces[st.space].rect, top, top + 3, FACADE);
  for (const li of tpl.typical.lifts) b.rect(tpl.typical.spaces[li.space].rect, top, top + 3.6, FACADE.clone().multiplyScalar(0.96));
  return b.geometry();
}

const FLOOR_COLORS: Record<string, THREE.Color> = {
  room: new THREE.Color('#d8c3a0'), balcony: new THREE.Color('#b89f86'), corridor: new THREE.Color('#bcc0c4'),
  stair: new THREE.Color('#8b8f94'), lift: new THREE.Color('#9aa0a6'), lobby: new THREE.Color('#c7c3bb'),
  shaft: new THREE.Color('#5b6168'), terrace: new THREE.Color('#c9c2b0'), ground: new THREE.Color('#b9b4a8'), commercial: new THREE.Color('#d2c7b6'),
};
const ROLE_COLORS: Record<string, THREE.Color> = {
  kitchen: new THREE.Color('#e1d7c6'), toilet: new THREE.Color('#c8d6df'), foyer: new THREE.Color('#d3c4ab'), bedroom: new THREE.Color('#cdb48f'), living: new THREE.Color('#d8c3a0'),
};
const WALL = new THREE.Color('#f4f1ea');

/**
 * Interior of one storey (local storey frame, floor at y = 0): coloured floors per
 * space, partition walls with door gaps at flat, stair and room doors, stair
 * flights, lift cars. Instanced per wing storey by the renderer.
 */
export function buildInterior(st: StoreyTemplate, H: number): THREE.BufferGeometry {
  const b = new BoxBatch();
  const wallH = H - 0.25;
  // floors
  for (const sp of st.spaces) {
    const c = (sp.roomRole && ROLE_COLORS[sp.roomRole]) || FLOOR_COLORS[sp.kind] || FLOOR_COLORS.room;
    if (sp.kind === 'shaft') continue;
    b.rect([sp.rect[0] + 0.03, sp.rect[1] + 0.03, sp.rect[2] - 0.03, sp.rect[3] - 0.03], 0.2, 0.24, c);
  }
  // walls: every space edge, deduplicated, with door gaps and window openings (sill + lintel)
  const doors = st.conns.filter((c) => c.kind === 'flatdoor' || c.kind === 'stairdoor' || c.kind === 'door' || c.kind === 'open' || c.kind === 'exit' || c.kind === 'window');
  const balconyIdx = new Set(st.spaces.filter((s) => s.kind === 'balcony').map((s) => s.i));
  const seen = new Set<string>();
  const key = (a: number, b2: number, c: number, d: number) => [a, b2, c, d].map((v) => v.toFixed(2)).join(',');
  const edge = (x0: number, y0: number, x1: number, y1: number, kind: string) => {
    const k1 = key(x0, y0, x1, y1);
    const k2 = key(x1, y1, x0, y0);
    if (seen.has(k1) || seen.has(k2)) return;
    seen.add(k1);
    const alongX = Math.abs(y1 - y0) < 1e-6;
    const lo = alongX ? Math.min(x0, x1) : Math.min(y0, y1);
    const hi = alongX ? Math.max(x0, x1) : Math.max(y0, y1);
    const fixed = alongX ? y0 : x0;
    // gaps where an opening sits on this line
    const gaps: [number, number][] = [];
    const windows: [number, number, number][] = [];
    for (const d of doors) {
      const onLine = alongX ? Math.abs(d.y - fixed) < 0.08 && d.x > lo && d.x < hi : Math.abs(d.x - fixed) < 0.08 && d.y > lo && d.y < hi;
      if (!onLine) continue;
      const p = alongX ? d.x : d.y;
      const half = d.kind === 'open' ? Math.min(d.width, hi - lo) / 2 : d.width / 2;
      gaps.push([p - half, p + half]);
      // a window keeps a sill (a parapet on balconies) and a lintel
      if (d.kind === 'window') windows.push([p - half, p + half, balconyIdx.has(d.a) ? 1.1 : 0.9]);
    }
    gaps.sort((a, b2) => a[0] - b2[0]);
    let cur = lo;
    const pieces: [number, number][] = [];
    for (const [g0, g1] of gaps) {
      if (g0 > cur) pieces.push([cur, g0]);
      cur = Math.max(cur, g1);
    }
    if (cur < hi) pieces.push([cur, hi]);
    const thick = kind === 'corridor' ? 0.2 : 0.12;
    for (const [a, c] of pieces) {
      if (c - a < 0.05) continue;
      if (alongX) b.box((a + c) / 2, 0.2 + wallH / 2, -fixed, c - a, wallH, thick, WALL);
      else b.box(fixed, 0.2 + wallH / 2, -(a + c) / 2, thick, wallH, c - a, WALL);
    }
    const lintel = 2.15;
    for (const [a, c, sill] of windows) {
      const w = c - a;
      const top = wallH - lintel;
      if (alongX) {
        b.box((a + c) / 2, 0.2 + sill / 2, -fixed, w, sill, thick, WALL);
        if (top > 0.05) b.box((a + c) / 2, 0.2 + lintel + top / 2, -fixed, w, top, thick, WALL);
      } else {
        b.box(fixed, 0.2 + sill / 2, -(a + c) / 2, thick, sill, w, WALL);
        if (top > 0.05) b.box(fixed, 0.2 + lintel + top / 2, -(a + c) / 2, thick, top, w, WALL);
      }
    }
  };
  for (const sp of st.spaces) {
    const [x0, y0, x1, y1] = sp.rect;
    edge(x0, y0, x1, y0, sp.kind);
    edge(x1, y0, x1, y1, sp.kind);
    edge(x1, y1, x0, y1, sp.kind);
    edge(x0, y1, x0, y0, sp.kind);
  }
  // stair flights: two ramps per storey (dog-leg)
  for (const s of st.stairs) {
    const r = st.spaces[s.space].rect;
    const w = r[2] - r[0];
    const d = r[3] - r[1];
    const flightW = Math.min(1.2, w / 2 - 0.1);
    const steps = 10;
    for (let k = 0; k < steps; k++) {
      const u = (k + 0.5) / steps;
      b.box(r[0] + 0.1 + flightW / 2, 0.24 + (u * H) / 2, -(r[1] + 0.8 + u * (d - 1.6)), flightW, 0.16, (d - 1.6) / steps, FLOOR_COLORS.stair);
      b.box(r[2] - 0.1 - flightW / 2, 0.24 + H / 2 + (u * H) / 2, -(r[3] - 0.8 - u * (d - 1.6)), flightW, 0.16, (d - 1.6) / steps, FLOOR_COLORS.stair);
    }
  }
  for (const l of st.lifts) {
    const r = st.spaces[l.space].rect;
    const cx = (r[0] + r[2]) / 2;
    const yy = l.side === 'N' ? r[3] - 1.1 : r[1] + 1.1;
    b.box(cx, 0.2 + wallH / 2, -yy, 1.6, wallH, 1.8, new THREE.Color('#9da6ae'));
  }
  return b.geometry();
}

/** Thin ribbon along a polyline at height y (site ENU in, three.js out). */
export function ribbon(pts: [number, number][], width: number, y: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, an] = pts[i - 1];
    const [bx, bn] = pts[i];
    const dx = bx - ax;
    const dn = bn - an;
    const L = Math.hypot(dx, dn) || 1;
    const px = (-dn / L) * (width / 2);
    const pn = (dx / L) * (width / 2);
    const A = [ax + px, an + pn];
    const B = [ax - px, an - pn];
    const C = [bx - px, bn - pn];
    const D = [bx + px, bn + pn];
    for (const v of [A, B, C, A, C, D]) {
      pos.push(v[0], y, -v[1]);
      nor.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Flat polygon (site ENU) at height y. */
export function flatPolygon(poly: [number, number][], y: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(poly.map(([E, N]) => new THREE.Vector2(E, N)));
  const g = new THREE.ShapeGeometry(shape, 1);
  // ShapeGeometry is in XY; rotate so that (E, N) -> (X, -Z)
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}
