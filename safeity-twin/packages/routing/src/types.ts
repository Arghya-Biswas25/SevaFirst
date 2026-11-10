/** Plan data shipped to the UI (design §4 and §7). Plain data, structured-clone friendly. */
import type { HazardZone } from './risk';

export type RouteLabel = 'recommended' | 'fastest' | 'safest' | 'alternative' | 'avoid';
export type RiskBand = 'low' | 'moderate' | 'high' | 'severe';

export interface RouteMetrics {
  /** walk + expected queueing, s */
  time_s: number;
  walk_s: number;
  queue_s: number;
  dist_m: number;
  /** smoke dose as a fraction of an incapacitating dose (FED-style) */
  dose: number;
  minVis_m: number;
  maxTemp_C: number;
  /** 0..100 */
  risk: number;
  band: RiskBand;
  stairs: number;
  debris: number;
  /** edges through structurally damaged spaces (cracked stairs, fallen ceilings) */
  damaged: number;
  zones: string[];
}

export interface PlanRoute {
  id: string;
  labels: RouteLabel[];
  /** "Stair S2 → NW exit → AP-W" */
  via: string;
  stair: string | null;
  exit: string | null;
  goal: string | null;
  /** flattened E, N, z */
  pts: number[];
  m: RouteMetrics;
  notes: string[];
  /** the way residents on this floor are heading now (crowd model) */
  current?: boolean;
}

export interface FloorPlan {
  storey: number;
  people: number;
  advice: 'evacuate' | 'shelter';
  best: string | null;
  summary: string;
  routes: PlanRoute[];
}

export interface WingPlan {
  wing: number;
  id: string;
  why: string;
  critical: number;
  strategy: string;
  floors: FloorPlan[];
}

export interface RescueLeg {
  pts: number[];
  time_s: number;
  via: string;
  notes: string[];
}

export interface RescuePlan {
  id: string;
  unit: string;
  unitName: string;
  kind: string;
  status: string;
  task: string;
  taskKind: string;
  taskLabel: string;
  wing: number;
  people: number;
  approach: (RescueLeg & { alt?: string }) | null;
  staging: { E: number; N: number; note: string };
  entry: (RescueLeg & { stair: string | null; storey: number }) | null;
  extraction: RescueLeg | null;
}

export interface PlanSet {
  version: number;
  t: number;
  wings: WingPlan[];
  rescues: RescuePlan[];
  zones: HazardZone[];
}

export const LABEL_ORDER: RouteLabel[] = ['recommended', 'fastest', 'safest', 'alternative', 'avoid'];

export function riskBand(r: number): RiskBand {
  return r < 15 ? 'low' : r < 40 ? 'moderate' : r < 70 ? 'high' : 'severe';
}
