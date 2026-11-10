/**
 * @twin/hazard-sdk — the contract every hazard plugin implements.
 *
 * Plugins never talk to each other or to routing/dispatch directly. They write
 * into the shared FieldStore (per-space temperature, smoke, heat release, damage,
 * blocked streets...) and emit events. Routing, crowd, dispatch and the advisor
 * read the field. Registering a plugin makes it appear in the right-click menu
 * and the simulation window automatically (its `params` drive the form).
 */
import type { Rng } from '@twin/core';
import type { HazardSpec } from '@twin/twin-schema';
import type { Twin } from '@twin/twin-data';

export interface ParamField {
  key: string;
  label: string;
  type: 'number' | 'select' | 'boolean';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  default: number | string | boolean;
  options?: { value: string; label: string }[];
  help?: string;
}

export type Level = 'info' | 'warn' | 'critical';
export interface SimEvent {
  t: number;
  type: string;
  level: Level;
  text: string;
  wing?: number;
  space?: number;
  data?: Record<string, unknown>;
}

/** A debris footprint (site ENU polygon) that blocks streets and paths. */
export interface DebrisZone {
  id: string;
  wing: number;
  poly: [number, number][];
  height: number;
}

export class FieldStore {
  readonly n: number;
  temp: Float32Array;
  soot: Float32Array; // g / m^3
  hrr: Float32Array; // kW
  burn: Uint8Array; // 0 none, 1 growing, 2 fully developed, 3 out
  damage: Uint8Array; // 0 none .. 4 collapsed
  tenability: Float32Array; // 1 fine .. 0 untenable
  wingDamage: Uint8Array;
  wingSuppression_kW: Float32Array;
  blockedStreet: Uint8Array;
  debris: DebrisZone[] = [];
  liftsOn = true;
  powerOn = true;
  darkness = 0;
  /** ground-shaking intensity right now (0 none .. ~1.5), drives drop-cover-hold and building sway */
  shaking = 0;
  trappedLifts: { wing: number; lift: string; persons: number; t: number; resolved: boolean }[] = [];
  activeWings = new Set<number>();
  /** Last simulated time each wing's smoke was transported (shared by all fire instances). */
  smokeT: Float64Array;

  constructor(twin: Twin) {
    this.n = twin.nSpaces;
    this.temp = new Float32Array(this.n).fill(20);
    this.soot = new Float32Array(this.n);
    this.hrr = new Float32Array(this.n);
    this.burn = new Uint8Array(this.n);
    this.damage = new Uint8Array(this.n);
    this.tenability = new Float32Array(this.n).fill(1);
    this.wingDamage = new Uint8Array(twin.wings.length);
    this.wingSuppression_kW = new Float32Array(twin.wings.length);
    this.blockedStreet = new Uint8Array(twin.ds.streets.features.length);
    this.smokeT = new Float64Array(twin.wings.length).fill(-1);
  }

  /** Visibility in metres from soot density (light-reflecting signs, K = 3). */
  visibility(i: number): number {
    const K = 8.7 * this.soot[i]; // m^-1, specific extinction 8.7 m^2/g
    return K < 0.01 ? 300 : Math.min(300, 3 / K);
  }

  /** Recompute tenability from smoke, heat and structural state. */
  updateTenability(rules = { visMin: 10, tempMax: 60 }): void {
    for (let i = 0; i < this.n; i++) {
      if (this.damage[i] >= 4) {
        this.tenability[i] = 0;
        continue;
      }
      const vis = this.visibility(i);
      const tv = vis >= rules.visMin ? 1 : Math.max(0, (vis - 2) / (rules.visMin - 2));
      const T = this.temp[i];
      const tt = T <= 40 ? 1 : T >= rules.tempMax + 20 ? 0 : 1 - (T - 40) / (rules.tempMax + 20 - 40);
      const td = this.damage[i] === 3 ? 0.45 : 1;
      const tb = this.burn[i] === 1 || this.burn[i] === 2 ? 0 : 1;
      this.tenability[i] = Math.min(tv, tt, td, tb);
    }
  }
}

export interface SimContext {
  twin: Twin;
  field: FieldStore;
  rng: Rng;
  t: number;
  wind: { speed_ms: number; fromDeg: number };
  emit(ev: Omit<SimEvent, 't'>): void;
  spawn(spec: HazardSpec): void;
  /** Ask the crowd model to alert people in these wings (alarm raised). */
  alert(wings: number[], reason: string, delay_s?: number): void;
  /** Site-wide evacuation to open ground (earthquake, explosion). */
  alertAll(reason: string, delay_s?: number): void;
}

export interface HazardInstance {
  step(dt: number, ctx: SimContext): void;
  done?(): boolean;
  summary?(): Record<string, number | string>;
}

export interface HazardPlugin {
  id: string;
  label: string;
  description: string;
  release: 'v1' | 'v1.1' | 'v2';
  pinned?: boolean;
  enabled: boolean;
  /** Which right-click targets make sense: inside a building, on a building, outdoors. */
  targets: ('space' | 'building' | 'outdoor')[];
  params: ParamField[];
  create(ctx: SimContext, spec: HazardSpec): HazardInstance;
}

export class HazardRegistry {
  private map = new Map<string, HazardPlugin>();
  register(p: HazardPlugin): void {
    if (this.map.has(p.id)) throw new Error(`hazard ${p.id} registered twice`);
    this.map.set(p.id, p);
  }
  get(id: string): HazardPlugin | undefined {
    return this.map.get(id);
  }
  list(): HazardPlugin[] {
    return [...this.map.values()];
  }
}

export function defaultParams(p: Pick<HazardPlugin, 'params'>): Record<string, number | string | boolean> {
  return Object.fromEntries(p.params.map((f) => [f.key, f.default]));
}

/** Descriptor-only entries for hazards on the roadmap (shown disabled in the UI). */
export function plannedHazard(id: string, label: string, release: HazardPlugin['release'], description: string): HazardPlugin {
  return {
    id, label, release, description, enabled: false, targets: ['space', 'building', 'outdoor'], params: [],
    create: () => ({ step: () => undefined, done: () => true }),
  };
}
