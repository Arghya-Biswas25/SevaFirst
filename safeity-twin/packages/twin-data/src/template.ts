/**
 * Typology -> storey templates (local wing coordinates, one storey).
 * x runs along the wing's long axis (-L/2..L/2); y points to the "N" side; a
 * corridor of width c runs along y = 0. Rooms are axis-aligned rectangles.
 * This is the L1 parametric interior: flats, rooms, cores and openings follow the
 * ePlan floor plates in order and size; exact walls arrive with L2 CAD data.
 */
import type { Segment, Typology, UnitType } from '@twin/twin-schema';

export type SpaceKind =
  | 'room' | 'balcony' | 'corridor' | 'stair' | 'lift' | 'lobby' | 'shaft' | 'terrace' | 'ground' | 'commercial';

export const SPACE_KIND_CODE: Record<SpaceKind, number> = {
  room: 0, balcony: 1, corridor: 2, stair: 3, lift: 4, lobby: 5, shaft: 6, terrace: 7, ground: 8, commercial: 9,
};

export type Rect = [number, number, number, number]; // x0, y0, x1, y1

export interface SpaceT {
  i: number;
  kind: SpaceKind;
  name: string;
  rect: Rect;
  side?: 'N' | 'S';
  flat?: number; // index into StoreyTemplate.flats
  roomRole?: 'living' | 'bedroom' | 'kitchen' | 'toilet' | 'foyer' | 'balcony';
  stairId?: string;
  liftId?: string;
}

export type ConnKind = 'door' | 'flatdoor' | 'stairdoor' | 'open' | 'window' | 'exit';
export interface ConnT {
  a: number;
  b: number; // -1 = exterior
  kind: ConnKind;
  x: number;
  y: number;
  width: number;
  /** true when the opening lies on a wall line parallel to x (otherwise parallel to y). */
  alongX: boolean;
}

export interface FlatT {
  idx: number;
  num: string; // suffix, e.g. "04" -> flat 304 on storey 3
  unit: string;
  side: 'N' | 'S';
  rect: Rect;
  rooms: number[];
  foyer: number;
  corridor: number;
  door: [number, number];
}

export interface StoreyTemplate {
  kind: 'flats' | 'ground' | 'commercial';
  spaces: SpaceT[];
  conns: ConnT[];
  flats: FlatT[];
  corridors: number[];
  stairs: { id: string; space: number; side: 'N' | 'S'; x: number }[];
  lifts: { id: string; space: number; side: 'N' | 'S'; x: number }[];
  shafts: number[];
}

export interface TypologyTemplate {
  code: string;
  L: number;
  W: number;
  c: number;
  massingOnly: boolean;
  typical: StoreyTemplate;
  ground: StoreyTemplate;
  commercial: StoreyTemplate;
}

const EPS = 1e-6;

function makeBuilder(kind: StoreyTemplate['kind']) {
  const t: StoreyTemplate = { kind, spaces: [], conns: [], flats: [], corridors: [], stairs: [], lifts: [], shafts: [] };
  const add = (s: Omit<SpaceT, 'i'>) => {
    const sp = { ...s, i: t.spaces.length } as SpaceT;
    t.spaces.push(sp);
    return sp.i;
  };
  const conn = (a: number, b: number, kind: ConnKind, x: number, y: number, width: number, alongX: boolean) =>
    t.conns.push({ a, b, kind, x, y, width, alongX });
  return { t, add, conn };
}

/** Lay out one flat's rooms inside its bay. */
function layoutFlat(
  b: ReturnType<typeof makeBuilder>,
  unit: UnitType,
  unitCode: string,
  num: string,
  side: 'N' | 'S',
  x0: number,
  x1: number,
  c: number,
  W: number,
  flatIdx: number,
  carveToward: 'x0' | 'x1',
): FlatT {
  const s = side === 'N' ? 1 : -1;
  const D = W / 2 - c / 2;
  // Size the room program from the RERA carpet area; surplus bay width becomes a
  // light well / ventilation shaft between flat pairs, as drawn on the ePlan plates.
  const SQFT = 0.09290304;
  const need = (unit.carpet_sqft * SQFT) / 0.88 + unit.balcony_sqft * SQFT;
  const bayW = x1 - x0;
  const usedW = bayW * D > need * 1.06 ? Math.max(need / D, 0.55 * bayW) : bayW;
  if (bayW - usedW > 0.6) {
    const r: Rect = carveToward === 'x1' ? [x0 + usedW, 0, x1, 0] : [x0, 0, x1 - usedW, 0];
    const ya = s * (c / 2 + 0.0);
    const yb = s * (c / 2 + D);
    const i = b.add({ kind: 'shaft', name: 'Light well / shaft', rect: [r[0], Math.min(ya, yb), r[2], Math.max(ya, yb)], side });
    b.t.shafts.push(i);
    if (carveToward === 'x1') x1 = x0 + usedW;
    else x0 = x1 - usedW;
  }
  const y = (u: number) => s * (c / 2 + u); // depth u from the corridor wall -> local y
  const R = (xa: number, ua: number, xb: number, ub: number): [number, number, number, number] => {
    const ya = y(ua);
    const yb = y(ub);
    return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
  };
  const wb = x1 - x0;
  const f = Math.min(3.0, Math.max(2.2, 0.36 * D));
  const bal = Math.min(1.5, Math.max(1.1, 0.16 * D));
  const lw = Math.max(unit.livingShare * wb, 2.8);
  const nb = Math.max(1, unit.bedrooms);
  const bw = (wb - lw) / nb;
  const kw = 0.38 * wb;
  const fw = 0.24 * wb;
  const nt = Math.min(2, Math.max(1, unit.toilets));
  const tw = (wb - kw - fw) / nt;
  const rooms: number[] = [];
  const sp = (name: string, role: SpaceT['roomRole'], r: Rect, kind: SpaceKind = 'room') => {
    const i = b.add({ kind, name, rect: r, side, flat: flatIdx, roomRole: role });
    rooms.push(i);
    return i;
  };
  const living = sp('Living/dining', 'living', R(x0, f, x0 + lw, D - bal));
  const balcony = sp('Balcony', 'balcony', R(x0, D - bal, x0 + lw, D), 'balcony');
  const beds: number[] = [];
  for (let k = 0; k < nb; k++) {
    const name = nb === 1 ? 'Bedroom' : k === 0 ? 'Master bedroom' : `Bedroom ${k + 1}`;
    beds.push(sp(name, 'bedroom', R(x0 + lw + k * bw, f, x0 + lw + (k + 1) * bw, D)));
  }
  const kitchen = sp('Kitchen', 'kitchen', R(x0, 0, x0 + kw, f));
  const foyer = sp('Entry foyer', 'foyer', R(x0 + kw, 0, x0 + kw + fw, f));
  const toilets: number[] = [];
  for (let k = 0; k < nt; k++) {
    toilets.push(sp(nt === 1 ? 'Toilet' : `Toilet ${k + 1}`, 'toilet', R(x0 + kw + fw + k * tw, 0, x0 + kw + fw + (k + 1) * tw, f)));
  }
  // internal doors (positions on shared edges where they exist)
  const yf = y(f);
  b.conn(foyer, kitchen, 'door', x0 + kw, y(f / 2), 0.9, false);
  b.conn(foyer, toilets[0], 'door', x0 + kw + fw, y(f / 2), 0.75, false);
  b.conn(foyer, living, 'door', Math.min(x0 + kw + fw / 2, x0 + lw - 0.6), yf, 1.0, true);
  beds.forEach((bed, k) => b.conn(living, bed, 'door', x0 + lw + k * bw, y(f + 0.6), 0.85, false));
  if (toilets[1] !== undefined) b.conn(toilets[1], beds[0] ?? living, 'door', x0 + kw + fw + 1.5 * tw, yf, 0.75, true);
  b.conn(living, balcony, 'door', x0 + lw / 2, y(D - bal), 1.2, true);
  // windows to the exterior on the facade
  const yF = y(D);
  b.conn(balcony, -1, 'window', x0 + lw / 2, yF, Math.min(2.4, lw * 0.6), true);
  beds.forEach((bed, k) => b.conn(bed, -1, 'window', x0 + lw + (k + 0.5) * bw, yF, Math.min(1.5, bw * 0.5), true));
  const door: [number, number] = [x0 + kw + fw / 2, s * (c / 2)];
  return { idx: flatIdx, num, unit: unitCode, side, rect: R(x0, 0, x1, D), rooms, foyer, corridor: -1, door };
}

function buildStorey(typ: Typology, units: Record<string, UnitType>, kind: StoreyTemplate['kind']): StoreyTemplate {
  const L = typ.L_m;
  const W = typ.W_m;
  const c = typ.corridor_m;
  const b = makeBuilder(kind);
  const D = W / 2 - c / 2;
  // corridor split points = union of segment boundaries on both sides
  const cuts = new Set<number>([-L / 2, L / 2]);
  for (const side of ['N', 'S'] as const) {
    let x = -L / 2;
    for (const g of typ.sides[side]) {
      x += g.w;
      cuts.add(Math.round(x * 1000) / 1000);
    }
  }
  const xs = [...cuts].sort((a, c2) => a - c2).filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.8);
  if (xs[xs.length - 1] < L / 2 - EPS) xs.push(L / 2);
  const corrIdx: number[] = [];
  for (let k = 0; k < xs.length - 1; k++) {
    const i = b.add({ kind: kind === 'flats' ? 'corridor' : 'lobby', name: kind === 'flats' ? `Corridor ${k + 1}` : `Ground lobby ${k + 1}`, rect: [xs[k], -c / 2, xs[k + 1], c / 2] });
    corrIdx.push(i);
    if (k > 0) b.conn(corrIdx[k - 1], i, 'open', xs[k], 0, c, false);
  }
  b.t.corridors = corrIdx;
  const corridorAt = (x: number) => {
    for (let k = 0; k < xs.length - 1; k++) if (x >= xs[k] - EPS && x <= xs[k + 1] + EPS) return corrIdx[k];
    return corrIdx[corrIdx.length - 1];
  };
  // corridor ends: windows on flat floors, exits on the ground storey
  b.conn(corrIdx[0], -1, kind === 'flats' ? 'window' : 'exit', -L / 2, 0, c, false);
  b.conn(corrIdx[corrIdx.length - 1], -1, kind === 'flats' ? 'window' : 'exit', L / 2, 0, c, false);

  for (const side of ['N', 'S'] as const) {
    const s = side === 'N' ? 1 : -1;
    const yC = s * (c / 2);
    const yF = s * (W / 2);
    let x = -L / 2;
    for (const g of typ.sides[side] as Segment[]) {
      const x0 = x;
      const x1 = x + g.w;
      x = x1;
      const xm = (x0 + x1) / 2;
      const rect: [number, number, number, number] = [x0, Math.min(yC, yF), x1, Math.max(yC, yF)];
      if (g.kind === 'flat') {
        if (kind === 'flats') {
          const unit = units[g.unit!];
          const segs = typ.sides[side];
          const k = segs.indexOf(g);
          const nextFlat = segs[k + 1]?.kind === 'flat';
          const prevFlat = segs[k - 1]?.kind === 'flat';
          const carve: 'x0' | 'x1' = nextFlat && !prevFlat ? 'x1' : prevFlat && !nextFlat ? 'x0' : k % 2 === 0 ? 'x1' : 'x0';
          const fl = layoutFlat(b, unit, g.unit!, g.num!, side, x0, x1, c, W, b.t.flats.length, carve);
          fl.corridor = corridorAt(fl.door[0]);
          b.conn(fl.foyer, fl.corridor, 'flatdoor', fl.door[0], fl.door[1], 1.0, true);
          b.t.flats.push(fl);
        } else {
          const i = b.add({ kind: kind === 'ground' ? 'ground' : 'commercial', name: kind === 'ground' ? 'Stilt / lobby bay' : 'Commercial unit', rect, side });
          b.conn(i, corridorAt(xm), 'open', xm, yC, Math.min(4, g.w * 0.6), true);
          b.conn(i, -1, kind === 'ground' ? 'exit' : 'window', xm, yF, Math.min(4, g.w * 0.6), true);
        }
      } else if (g.kind === 'stair') {
        const i = b.add({ kind: 'stair', name: `Stair ${g.id}`, rect, side, stairId: g.id });
        b.conn(i, corridorAt(xm), 'stairdoor', xm, yC, 1.2, true);
        if (kind !== 'flats') b.conn(i, -1, 'exit', xm, yF, 1.2, true);
        b.t.stairs.push({ id: g.id!, space: i, side, x: xm });
      } else if (g.kind === 'lift') {
        const i = b.add({ kind: 'lift', name: `Lift lobby ${g.id}`, rect, side, liftId: g.id });
        b.conn(i, corridorAt(xm), 'open', xm, yC, 1.5, true);
        b.t.lifts.push({ id: g.id!, space: i, side, x: xm });
      } else if (g.kind === 'shaft') {
        const i = b.add({ kind: 'shaft', name: 'Ventilation shaft', rect, side });
        b.t.shafts.push(i);
      } else if (g.kind === 'lobby') {
        const i = b.add({ kind: 'lobby', name: 'Lobby', rect, side });
        b.conn(i, corridorAt(xm), 'open', xm, yC, Math.min(3, g.w), true);
      } else if (g.kind === 'terrace') {
        const i = b.add({ kind: 'terrace', name: 'Terrace / open', rect, side });
        b.conn(i, corridorAt(xm), 'open', xm, yC, Math.min(3, g.w), true);
      }
    }
  }
  // shafts connect to neighbouring front-band rooms (kitchens/toilets open onto them)
  for (const si of b.t.shafts) {
    const sr = b.t.spaces[si].rect;
    for (const sp of b.t.spaces) {
      if (sp.kind !== 'room' || (sp.roomRole !== 'kitchen' && sp.roomRole !== 'toilet')) continue;
      const touchesX = Math.abs(sp.rect[2] - sr[0]) < 0.05 || Math.abs(sp.rect[0] - sr[2]) < 0.05;
      const overlapY = Math.min(sp.rect[3], sr[3]) - Math.max(sp.rect[1], sr[1]) > 0.5;
      if (touchesX && overlapY) {
        const xw = Math.abs(sp.rect[2] - sr[0]) < 0.05 ? sr[0] : sr[2];
        b.conn(sp.i, si, 'window', xw, (Math.max(sp.rect[1], sr[1]) + Math.min(sp.rect[3], sr[3])) / 2, 0.6, false);
      }
    }
  }
  void D;
  return b.t;
}

export function buildTypologyTemplate(typ: Typology, units: Record<string, UnitType>): TypologyTemplate {
  if (typ.massingOnly) {
    const empty: StoreyTemplate = { kind: 'ground', spaces: [], conns: [], flats: [], corridors: [], stairs: [], lifts: [], shafts: [] };
    return { code: typ.code, L: typ.L_m, W: typ.W_m, c: typ.corridor_m, massingOnly: true, typical: empty, ground: empty, commercial: empty };
  }
  return {
    code: typ.code,
    L: typ.L_m,
    W: typ.W_m,
    c: typ.corridor_m,
    massingOnly: false,
    typical: buildStorey(typ, units, 'flats'),
    ground: buildStorey(typ, units, 'ground'),
    commercial: buildStorey(typ, units, 'commercial'),
  };
}

export const rectArea = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
export const rectCenter = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
