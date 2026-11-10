/**
 * @twin/twin-schema — the typed contract for every dataset, scenario and result.
 * Data files under data/sites/<id>/ must satisfy these types; `validateDataset`
 * reports problems with a path and a message so the pipeline can gate releases.
 */
import type { Pose, Vec2 } from '@twin/core';

export type DataLevel = 'L1' | 'L2' | 'L3';

export interface Site {
  id: string;
  name: string;
  developer?: string;
  location?: string;
  dataLevel: DataLevel;
  crs: { frame: string; geoAnchorHint?: { lat: number; lon: number; note?: string }; utm?: string };
  calibration?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  tolerance?: Record<string, number>;
  boundary: Vec2[];
  lagoon: Vec2[];
  storeyHeight_m: number;
  groundStoreyHeight_m: number;
  parapet_m: number;
  hazardContext?: Record<string, unknown>;
  source?: string;
}

export type SegmentKind = 'flat' | 'stair' | 'lift' | 'shaft' | 'lobby' | 'terrace';
export interface Segment {
  kind: SegmentKind;
  w: number;
  unit?: string;
  num?: string;
  id?: string;
}

export interface UnitType {
  name: string;
  carpet_sqft: number;
  balcony_sqft: number;
  bedrooms: number;
  toilets: number;
  livingShare: number;
  personsNominal: number;
}

export interface Typology {
  code: string;
  name: string;
  L_m: number;
  W_m: number;
  corridor_m: number;
  storeys: number;
  flatFloors: number[];
  commercialFloors: number[];
  flatsPerFloor: number;
  stairs: number;
  lifts: number;
  liftCapacity_persons: number;
  sides: { N: Segment[]; S: Segment[] };
  massingOnly?: boolean;
  source?: string;
  confidence?: string;
}

export type BuildingStatus = 'launched' | 'future' | 'proposed';
export interface Building {
  id: string;
  row: number;
  wing: string;
  typology: string;
  status: BuildingStatus;
  pose: Pose;
  storeys: number;
  flatFloors: number[];
  lengthOverride_m?: number;
  source?: string;
  confidence?: string;
}

export interface StreetFeature {
  type: 'Feature';
  id: string;
  properties: {
    from: number;
    to: number;
    class: 'perimeter' | 'street' | 'promenade';
    width_m: number;
    length_m: number;
    vehicles: boolean;
    parkingBothSides?: boolean;
    source?: string;
    confidence?: string;
  };
  geometry: { type: 'LineString'; coordinates: Vec2[] };
}
export interface Streets {
  type: 'FeatureCollection';
  nodes: Vec2[];
  features: StreetFeature[];
}

export interface AssemblyPoint { id: string; name: string; E: number; N: number; capacity: number; shelter: boolean }
export interface Gate { id: string; name: string; E: number; N: number; vehicles: boolean; external: boolean }
export interface Amenities {
  assemblyPoints: AssemblyPoint[];
  gates: Gate[];
  features: { id: string; name: string; kind: string; E: number; N: number; area_m2?: number }[];
}

export type ResourceKind = 'fire_tender' | 'ambulance' | 'rescue_team' | 'security_team' | 'warden_team' | 'technician';
export interface ResourceSpec {
  id: string;
  kind: ResourceKind;
  name: string;
  base: string;
  onSite: boolean;
  eta_s: number;
  crew: number;
  speed_ms: number;
  foot?: boolean;
  water_l?: number;
  patients?: number;
  capabilities: string[];
}

export interface OccupancyProfile {
  label: string;
  occupancyRate: number;
  personsFactor: number;
  awake: number;
  preMovement_s: { median: number; sigma: number };
  bluVisitors: number;
}

export interface RulePack {
  pack: string;
  version: string;
  status: string;
  rules: Record<string, unknown>[];
}

export interface SiteDataset {
  site: Site;
  typologies: { units: Record<string, UnitType>; typologies: Record<string, Typology> };
  buildings: { buildings: Building[] };
  streets: Streets;
  amenities: Amenities;
  resources: { resources: ResourceSpec[] };
  occupancy: { profiles: Record<string, OccupancyProfile>; vulnerableShare: number };
  rules: RulePack;
}

// ------------------------------------------------------------------ scenarios
/** Where a hazard starts: whatever the right-click hit. */
export interface PickOrigin {
  kind: 'space' | 'building' | 'outdoor';
  E: number;
  N: number;
  up: number;
  buildingId?: string;
  storey?: number;
  spaceId?: number;
  label?: string;
}

export interface HazardSpec {
  type: string; // plugin id, e.g. 'fire'
  params: Record<string, number | string | boolean>;
  origin: PickOrigin;
  t: number; // start time, s
}

export interface Scenario {
  id: string;
  version: 1;
  seed: number;
  occupancy: string;
  hazards: HazardSpec[];
  resources?: { disabled?: string[]; etaOverride?: Record<string, number> };
  wind?: { speed_ms: number; fromDeg: number };
}

// ------------------------------------------------------------------ validation
export interface Issue { path: string; message: string; level: 'error' | 'warning' }

export function validateDataset(ds: SiteDataset): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, level: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, level: 'warning' });
  if (!ds.site?.boundary || ds.site.boundary.length < 3) err('site.boundary', 'needs at least 3 vertices');
  const T = ds.typologies.typologies;
  for (const [code, t] of Object.entries(T)) {
    for (const side of ['N', 'S'] as const) {
      const sum = t.sides[side].reduce((s, g) => s + g.w, 0);
      if (Math.abs(sum - t.L_m) > 0.05) err(`typologies.${code}.sides.${side}`, `segments sum to ${sum.toFixed(2)} m, expected ${t.L_m} m`);
      for (const g of t.sides[side]) if (g.kind === 'flat' && !ds.typologies.units[g.unit ?? '']) err(`typologies.${code}`, `unknown unit type ${g.unit}`);
    }
    const flats = t.sides.N.concat(t.sides.S).filter((g) => g.kind === 'flat').length;
    if (!t.massingOnly && flats !== t.flatsPerFloor) warn(`typologies.${code}`, `${flats} flat segments but flatsPerFloor=${t.flatsPerFloor}`);
  }
  const ids = new Set<string>();
  for (const b of ds.buildings.buildings) {
    if (ids.has(b.id)) err(`buildings.${b.id}`, 'duplicate id');
    ids.add(b.id);
    if (!T[b.typology]) err(`buildings.${b.id}`, `unknown typology ${b.typology}`);
  }
  for (const f of ds.streets.features) {
    if (f.geometry.coordinates.length < 2) err(`streets.${f.id}`, 'needs at least 2 points');
    if (f.properties.from >= ds.streets.nodes.length || f.properties.to >= ds.streets.nodes.length) err(`streets.${f.id}`, 'node index out of range');
  }
  return issues;
}
