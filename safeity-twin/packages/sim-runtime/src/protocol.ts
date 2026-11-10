import type { HazardSpec, Scenario, SiteDataset } from '@twin/twin-schema';
import type { DebrisZone, SimEvent } from '@twin/hazard-sdk';
import type { EvacKpis } from '@twin/crowd';
import type { Assignment, IncidentList, RescueOpView, ResourceStatus } from '@twin/dispatch';
import type { PlaybookView, Recommendation } from '@twin/advisor';
import type { HazardZone, PlanSet } from '@twin/routing';

export interface StartOptions {
  launchedOnly: boolean;
}

export type ToWorker =
  | { type: 'init'; ds: SiteDataset }
  | { type: 'start'; scenario: Scenario; options: StartOptions }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'speed'; value: number }
  | { type: 'inject'; spec: HazardSpec }
  | { type: 'alertAll' }
  | { type: 'focus'; wing: number | null }
  | { type: 'rescue'; incident: string }
  | { type: 'rescueStop'; op: string }
  | { type: 'stop' };

export interface Snapshot {
  t: number;
  running: boolean;
  speed: number;
  spaces: { ids: Int32Array; soot: Float32Array; temp: Float32Array; burn: Uint8Array; damage: Uint8Array };
  wingDamage: Uint8Array;
  groups: Float32Array;
  /** evacuation flow segments: E1,N1,z1,E2,N2,z2,people,congestion per segment, in walking direction */
  flows: Float32Array;
  resources: { id: string; kind: string; status: ResourceStatus; E: number; N: number; route: [number, number, number][] }[];
  events: SimEvent[];
  recommendations: Recommendation[];
  assignments: Assignment[];
  pending: { task: string; label: string; reason: string; people: number }[];
  evac: EvacKpis;
  fire: { burningRooms: number; hrr_MW: number; smokeSpaces: number };
  damage: number[];
  blockedStreets: number[];
  debris: DebrisZone[];
  /** outdoor hazard zones (fall zones, cordons, fire exposure, plumes, debris) */
  zones: HazardZone[];
  /** evacuation and rescue plans; only present when they changed since the last snapshot */
  plans?: PlanSet;
  /** live response playbook; only present when it changed */
  playbook?: PlaybookView;
  /** ground-shaking intensity now (0 = still) */
  shaking: number;
  /** places where something is wrong; only present when the list changed */
  incidents?: IncidentList;
  /** rescues the user started, with where everyone is */
  ops: RescueOpView[];
  hazards: { type: string; label: string; summary: Record<string, number | string> }[];
  liftsOn: boolean;
  powerOn: boolean;
  stepMs: number;
}

export type FromWorker =
  | { type: 'ready'; stats: { spaces: number; flats: number; navNodes: number; navEdges: number; buildMs: number } }
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'error'; message: string };
