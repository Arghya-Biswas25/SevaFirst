/**
 * Walking model shared by the crowd, the route planner and the rescue planner, so a
 * route's displayed time is the time the simulated people actually take.
 */
import type { FieldStore } from '@twin/hazard-sdk';
import type { NavEdge } from '@twin/nav';

/** Unimpeded walking speeds (m/s) by edge kind: SFPE horizontal and stair-descent values. */
export const BASE_SPEED = { walk: 1.2, door: 1.0, stair: 0.65, lift: 1.0, road: 1.25, link: 1.2 } as const;
/** Below this tenability an edge is impassable for an evacuee. */
export const UNTENABLE = 0.25;
/** Walking time multiplier on a debris-covered street (climbing over rubble). */
export const DEBRIS_SLOW = 6;

/** Worst tenability of the spaces an edge passes through (1 fine .. 0 untenable). */
export function edgeTenability(f: FieldStore, e: NavEdge): number {
  let ten = 1;
  if (e.space >= 0) ten = Math.min(ten, f.tenability[e.space]);
  if (e.space2 >= 0) ten = Math.min(ten, f.tenability[e.space2]);
  return ten;
}

/** Tenability from smoke and heat only (structural damage excluded), same rules as FieldStore. */
export function smokeTenability(f: FieldStore, space: number, visMin = 10, tempMax = 60): number {
  const vis = f.visibility(space);
  const tv = vis >= visMin ? 1 : Math.max(0, (vis - 2) / (visMin - 2));
  const T = f.temp[space];
  const tt = T <= 40 ? 1 : T >= tempMax + 20 ? 0 : 1 - (T - 40) / (tempMax + 20 - 40);
  return Math.min(tv, tt);
}

export function edgeSmokeTenability(f: FieldStore, e: NavEdge): number {
  let t = 1;
  if (e.space >= 0) t = Math.min(t, smokeTenability(f, e.space));
  if (e.space2 >= 0) t = Math.min(t, smokeTenability(f, e.space2));
  return t;
}

/** Visibility (m) along an edge: the worse of its two spaces. */
export function edgeVisibility(f: FieldStore, e: NavEdge): number {
  let v = 300;
  if (e.space >= 0) v = Math.min(v, f.visibility(e.space));
  if (e.space2 >= 0) v = Math.min(v, f.visibility(e.space2));
  return v;
}

export function edgeTemp(f: FieldStore, e: NavEdge): number {
  let T = 20;
  if (e.space >= 0) T = Math.max(T, f.temp[e.space]);
  if (e.space2 >= 0) T = Math.max(T, f.temp[e.space2]);
  return T;
}

export function edgeDamage(f: FieldStore, e: NavEdge): number {
  let d = 0;
  if (e.space >= 0) d = Math.max(d, f.damage[e.space]);
  if (e.space2 >= 0) d = Math.max(d, f.damage[e.space2]);
  return d;
}

/** Walking speed (m/s) for an evacuee on an edge with the given tenability. */
export function walkSpeed(e: NavEdge, f: FieldStore, ten: number, vulnerable = false): number {
  let v: number = BASE_SPEED[e.kind];
  if (vulnerable) v *= e.kind === 'stair' ? 0.55 : 0.6;
  if (ten < 1) v *= 0.35 + 0.65 * ten;
  if (f.darkness > 0 && e.wing >= 0) v *= 1 - 0.4 * f.darkness;
  return Math.max(0.15, v);
}

/** Plain walking time (s) on an edge, Infinity when impassable for evacuees. */
export function walkTime(f: FieldStore, e: NavEdge, vulnerable = false): number {
  if (e.kind === 'lift') return Infinity;
  const ten = edgeTenability(f, e);
  if (ten < UNTENABLE) return Infinity;
  const debris = e.street >= 0 && f.blockedStreet[e.street] ? DEBRIS_SLOW : 1;
  return (e.len / walkSpeed(e, f, ten, vulnerable)) * debris;
}

/**
 * Responder on foot with breathing apparatus: tolerates smoke (slower in it), stops at
 * heat over 120 °C and at collapsed spaces (unless heavy rescue, who shore and breach).
 */
export function responderTime(f: FieldStore, e: NavEdge, heavy = false): number {
  if (e.kind === 'lift') return Infinity;
  const dmg = edgeDamage(f, e);
  if (dmg >= 4 && !heavy) return Infinity;
  if (edgeTemp(f, e) > 120) return Infinity;
  let v = BASE_SPEED[e.kind] * 0.85;
  const vis = edgeVisibility(f, e);
  if (vis < 5) v *= 0.55;
  else if (vis < 10) v *= 0.75;
  if (f.darkness > 0 && e.wing >= 0) v *= 1 - 0.3 * f.darkness;
  let t = e.len / Math.max(0.2, v);
  if (dmg >= 4) t *= 4;
  if (e.street >= 0 && f.blockedStreet[e.street]) t *= 3;
  return t;
}
