/**
 * Expands a SiteDataset into the global twin model shared by renderer and simulator:
 * every wing, storey, space (room, corridor, stair...), flat and opening gets a
 * stable global index. Built deterministically, so the main thread and the
 * simulation worker hold identical models.
 */
import { localToEN, enToLocal, type Pose, SQFT_TO_M2 } from '@twin/core';
import type { Building, SiteDataset, Typology } from '@twin/twin-schema';
import {
  buildTypologyTemplate, rectArea, rectCenter, SPACE_KIND_CODE,
  type ConnKind, type SpaceKind, type StoreyTemplate, type TypologyTemplate,
} from './template';

export type GlobalConnKind = ConnKind | 'stairflight' | 'shaftlink' | 'liftshaft';

export interface WingModel {
  idx: number;
  id: string;
  building: Building;
  typology: Typology;
  tpl: TypologyTemplate;
  pose: Pose;
  L: number;
  W: number;
  storeys: number;
  flatFloors: number[];
  status: Building['status'];
  massingOnly: boolean;
  storeyKinds: StoreyTemplate['kind'][];
  storeyOffsets: number[];
  spaceCount: number;
  height: number;
  neighbors: number[];
  flatIds: number[];
}

export interface FlatModel {
  id: number;
  key: string; // e.g. "R13/304"
  label: string;
  wing: number;
  storey: number;
  num: string;
  unit: string;
  spaces: number[];
  foyer: number;
  corridor: number;
  door: [number, number]; // E, N
  carpet_m2: number;
  reraCarpet_m2: number;
}

export interface ConnModel {
  a: number;
  b: number; // -1 = exterior
  kind: GlobalConnKind;
  width: number;
  E: number;
  N: number;
  z: number;
  wing: number;
}

export interface Twin {
  ds: SiteDataset;
  storeyH: number;
  wings: WingModel[];
  wingById: Map<string, number>;
  nSpaces: number;
  space: {
    wing: Int32Array;
    storey: Int16Array;
    t: Int32Array;
    kind: Uint8Array;
    area: Float32Array;
    volume: Float32Array;
    E: Float32Array;
    N: Float32Array;
    z: Float32Array;
    flat: Int32Array;
  };
  flats: FlatModel[];
  flatByKey: Map<string, number>;
  conns: ConnModel[];
  adj: number[][]; // space -> conn indices
}

export const KIND_BY_CODE: SpaceKind[] = Object.entries(SPACE_KIND_CODE).sort((a, b) => a[1] - b[1]).map(([k]) => k as SpaceKind);

function storeyTemplate(w: Pick<WingModel, 'tpl' | 'storeyKinds'>, s: number): StoreyTemplate {
  const k = w.storeyKinds[s];
  return k === 'flats' ? w.tpl.typical : k === 'commercial' ? w.tpl.commercial : w.tpl.ground;
}

export function wingStoreyTemplate(w: WingModel, s: number): StoreyTemplate {
  return storeyTemplate(w, s);
}

function rectDistance(a: WingModel, b: WingModel): number {
  // sample the outline of a and measure the distance into b's local frame
  let best = Infinity;
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const x = -a.L / 2 + (a.L * i) / 8;
    pts.push([x, -a.W / 2], [x, a.W / 2]);
  }
  for (let j = 0; j <= 4; j++) {
    const y = -a.W / 2 + (a.W * j) / 4;
    pts.push([-a.L / 2, y], [a.L / 2, y]);
  }
  for (const [x, y] of pts) {
    const [E, N] = localToEN(a.pose, x, y);
    const [u, v] = enToLocal(b.pose, E, N);
    const dx = Math.max(0, Math.abs(u) - b.L / 2);
    const dy = Math.max(0, Math.abs(v) - b.W / 2);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

export function buildTwin(ds: SiteDataset): Twin {
  const H = ds.site.storeyHeight_m;
  const tplCache = new Map<string, TypologyTemplate>();
  const wings: WingModel[] = [];
  let offset = 0;
  for (const b of ds.buildings.buildings) {
    const typ = ds.typologies.typologies[b.typology];
    let tpl = tplCache.get(typ.code);
    if (!tpl) tplCache.set(typ.code, (tpl = buildTypologyTemplate(typ, ds.typologies.units)));
    const storeyKinds: StoreyTemplate['kind'][] = [];
    for (let s = 0; s < b.storeys; s++) {
      storeyKinds.push(b.flatFloors.includes(s) ? 'flats' : typ.commercialFloors.includes(s) ? 'commercial' : 'ground');
    }
    const w: WingModel = {
      idx: wings.length, id: b.id, building: b, typology: typ, tpl, pose: b.pose,
      L: b.lengthOverride_m ?? typ.L_m, W: typ.W_m, storeys: b.storeys, flatFloors: b.flatFloors,
      status: b.status, massingOnly: !!typ.massingOnly, storeyKinds, storeyOffsets: [], spaceCount: 0,
      height: b.storeys * H, neighbors: [], flatIds: [],
    };
    if (!w.massingOnly) {
      for (let s = 0; s < b.storeys; s++) {
        w.storeyOffsets.push(offset);
        offset += storeyTemplate(w, s).spaces.length;
      }
    }
    w.spaceCount = offset - (w.storeyOffsets[0] ?? offset);
    wings.push(w);
  }
  const n = offset;
  const space = {
    wing: new Int32Array(n), storey: new Int16Array(n), t: new Int32Array(n), kind: new Uint8Array(n),
    area: new Float32Array(n), volume: new Float32Array(n), E: new Float32Array(n), N: new Float32Array(n),
    z: new Float32Array(n), flat: new Int32Array(n).fill(-1),
  };
  const flats: FlatModel[] = [];
  const flatByKey = new Map<string, number>();
  const conns: ConnModel[] = [];
  for (const w of wings) {
    if (w.massingOnly) continue;
    for (let s = 0; s < w.storeys; s++) {
      const st = storeyTemplate(w, s);
      const off = w.storeyOffsets[s];
      for (const sp of st.spaces) {
        const g = off + sp.i;
        const [cx, cy] = rectCenter(sp.rect);
        const [E, N] = localToEN(w.pose, cx, cy);
        space.wing[g] = w.idx;
        space.storey[g] = s;
        space.t[g] = sp.i;
        space.kind[g] = SPACE_KIND_CODE[sp.kind];
        space.area[g] = rectArea(sp.rect);
        space.volume[g] = rectArea(sp.rect) * H;
        space.E[g] = E;
        space.N[g] = N;
        space.z[g] = s * H;
      }
      for (const fl of st.flats) {
        const id = flats.length;
        const num = `${s}${fl.num}`;
        const unit = ds.typologies.units[fl.unit];
        const carpet = fl.rooms.reduce((acc, r) => acc + (st.spaces[r].kind === 'room' ? rectArea(st.spaces[r].rect) : 0), 0);
        const [dE, dN] = localToEN(w.pose, fl.door[0], fl.door[1]);
        const fm: FlatModel = {
          id, key: `${w.id}/${num}`, label: `${w.id} · flat ${num} · ${unit?.name ?? fl.unit}`, wing: w.idx, storey: s, num,
          unit: fl.unit, spaces: fl.rooms.map((r) => off + r), foyer: off + fl.foyer, corridor: off + fl.corridor,
          door: [dE, dN], carpet_m2: carpet * 0.88, reraCarpet_m2: (unit?.carpet_sqft ?? 0) * SQFT_TO_M2,
        };
        for (const r of fm.spaces) space.flat[r] = id;
        flats.push(fm);
        flatByKey.set(fm.key, id);
        w.flatIds.push(id);
      }
      for (const c of st.conns) {
        const [E, N] = localToEN(w.pose, c.x, c.y);
        conns.push({ a: off + c.a, b: c.b < 0 ? -1 : off + c.b, kind: c.kind, width: c.width, E, N, z: s * H, wing: w.idx });
      }
      if (s + 1 < w.storeys) {
        const up = storeyTemplate(w, s + 1);
        const offUp = w.storeyOffsets[s + 1];
        for (const stair of st.stairs) {
          const other = up.stairs.find((x) => x.id === stair.id);
          if (!other) continue;
          const [E, N] = localToEN(w.pose, stair.x, 0);
          conns.push({ a: off + stair.space, b: offUp + other.space, kind: 'stairflight', width: 1.2, E, N, z: s * H + H / 2, wing: w.idx });
        }
        for (const lift of st.lifts) {
          const other = up.lifts.find((x) => x.id === lift.id);
          if (!other) continue;
          const [E, N] = localToEN(w.pose, lift.x, 0);
          conns.push({ a: off + lift.space, b: offUp + other.space, kind: 'liftshaft', width: 0.3, E, N, z: s * H + H / 2, wing: w.idx });
        }
        st.shafts.forEach((sh, k) => {
          const other = up.shafts[k];
          if (other === undefined) return;
          conns.push({ a: off + sh, b: offUp + other, kind: 'shaftlink', width: 2.5, E: space.E[off + sh], N: space.N[off + sh], z: s * H + H, wing: w.idx });
        });
      }
    }
  }
  const adj: number[][] = Array.from({ length: n }, () => []);
  conns.forEach((c, i) => {
    adj[c.a].push(i);
    if (c.b >= 0) adj[c.b].push(i);
  });
  // neighbours for external fire spread (facade-to-facade within 25 m)
  for (const a of wings) {
    for (const b of wings) {
      if (a === b) continue;
      if (Math.hypot(a.pose.E - b.pose.E, a.pose.N - b.pose.N) > 120) continue;
      if (rectDistance(a, b) < 25) a.neighbors.push(b.idx);
    }
  }
  return { ds, storeyH: H, wings, wingById: new Map(wings.map((w) => [w.id, w.idx])), nSpaces: n, space, flats, flatByKey, conns, adj };
}

/** Which template space of a wing storey contains local point (x, y)? */
export function findSpaceAt(twin: Twin, wingIdx: number, storey: number, x: number, y: number): number {
  const w = twin.wings[wingIdx];
  if (w.massingOnly || storey < 0 || storey >= w.storeys) return -1;
  const st = storeyTemplate(w, storey);
  let best = -1;
  let bestArea = Infinity;
  for (const sp of st.spaces) {
    const r = sp.rect;
    if (x >= r[0] - 0.05 && x <= r[2] + 0.05 && y >= r[1] - 0.05 && y <= r[3] + 0.05) {
      const a = rectArea(r);
      if (a < bestArea) {
        bestArea = a;
        best = sp.i;
      }
    }
  }
  return best < 0 ? -1 : w.storeyOffsets[storey] + best;
}

export function spaceLabel(twin: Twin, g: number): string {
  if (g < 0 || g >= twin.nSpaces) return '';
  const w = twin.wings[twin.space.wing[g]];
  const s = twin.space.storey[g];
  const sp = storeyTemplate(w, s).spaces[twin.space.t[g]];
  const floor = s === 0 ? 'Ground' : `Floor ${s}`;
  const f = twin.space.flat[g];
  if (f >= 0) return `${w.id} · ${floor} · Flat ${twin.flats[f].num} · ${sp.name}`;
  return `${w.id} · ${floor} · ${sp.name}`;
}

export function spaceTemplate(twin: Twin, g: number) {
  const w = twin.wings[twin.space.wing[g]];
  return storeyTemplate(w, twin.space.storey[g]).spaces[twin.space.t[g]];
}

export function spaceKind(twin: Twin, g: number): SpaceKind {
  return KIND_BY_CODE[twin.space.kind[g]];
}

/** Summary numbers for the inspector and validation. */
export function twinStats(twin: Twin) {
  const resWings = twin.wings.filter((w) => !w.massingOnly);
  return {
    wings: resWings.length,
    buildings: twin.wings.length,
    flats: twin.flats.length,
    launchedFlats: twin.flats.filter((f) => twin.wings[f.wing].status === 'launched').length,
    spaces: twin.nSpaces,
    openings: twin.conns.length,
  };
}
