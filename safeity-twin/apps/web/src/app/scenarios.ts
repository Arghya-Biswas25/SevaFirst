/**
 * Preset scenarios. Each one is plain data (a Scenario); presets only help build
 * origins from wing ids so they stay valid when the dataset is regenerated.
 */
import type { PickOrigin, Scenario } from '@twin/twin-schema';
import { spaceLabel, wingStoreyTemplate, type Twin } from '@twin/twin-data';

export function roomOrigin(twin: Twin, wingId: string, storey: number, role: 'living' | 'kitchen' | 'bedroom' = 'living', nth = 0): PickOrigin {
  const wi = twin.wingById.get(wingId);
  if (wi === undefined) throw new Error(`no wing ${wingId}`);
  const w = twin.wings[wi];
  const st = wingStoreyTemplate(w, storey);
  const rooms = st.spaces.filter((s) => s.roomRole === role);
  const sp = rooms[Math.min(nth, rooms.length - 1)] ?? st.spaces[0];
  const g = w.storeyOffsets[storey] + sp.i;
  return { kind: 'space', E: twin.space.E[g], N: twin.space.N[g], up: storey * twin.storeyH, buildingId: w.id, storey, spaceId: g, label: spaceLabel(twin, g) };
}

export function wingOrigin(twin: Twin, wingId: string, storey = 0, along = 0): PickOrigin {
  const w = twin.wings[twin.wingById.get(wingId)!];
  const b = (w.pose.bearing * Math.PI) / 180;
  // a point `along` metres from the centre on the wing axis
  return { kind: 'building', E: w.pose.E + along * Math.sin(b), N: w.pose.N + along * Math.cos(b), up: storey * twin.storeyH, buildingId: w.id, storey, label: `${w.id} · ${w.typology.name}` };
}

export interface Preset {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  focus?: string;
  build: (twin: Twin) => Scenario;
}

export const PRESETS: Preset[] = [
  {
    id: 'two-fires-one-tender',
    title: 'Two fires, one fire engine',
    icon: 'fire',
    blurb: 'Flats in R17-B and R13 catch fire two minutes apart and only one fire engine is on site.',
    focus: 'R17-B',
    build: (twin) => ({
      id: 'two-fires-one-tender', version: 1, seed: 42, occupancy: 'weekday-night',
      hazards: [
        { type: 'fire', params: { growth: 'fast' }, origin: roomOrigin(twin, 'R17-B', 2), t: 0 },
        { type: 'fire', params: { growth: 'medium' }, origin: roomOrigin(twin, 'R13', 4), t: 120 },
      ],
    }),
  },
  {
    id: 'mixed-use-night-fire',
    title: 'Kitchen fire above the shops',
    icon: 'fire',
    blurb: 'A fast kitchen fire at night on the 4th floor of the east block.',
    focus: 'MU-E',
    build: (twin) => ({
      id: 'mixed-use-night-fire', version: 1, seed: 11, occupancy: 'weekday-night',
      hazards: [{ type: 'fire', params: { growth: 'ultrafast', fireFlatDoorOpen: true }, origin: roomOrigin(twin, 'MU-E', 4, 'kitchen'), t: 0 }],
    }),
  },
  {
    id: 'quake-dbe',
    title: 'Moderate earthquake',
    icon: 'earthquake',
    blurb: 'A weekday afternoon. Light damage, the lifts stop and everyone gathers outside.',
    build: () => ({
      id: 'quake-dbe', version: 1, seed: 7, occupancy: 'weekday-day',
      hazards: [{ type: 'earthquake', params: { preset: 'DBE', aftershocks: false }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0, label: 'Site' }, t: 0 }],
    }),
  },
  {
    id: 'quake-mce',
    title: 'Strong earthquake',
    icon: 'earthquake',
    blurb: 'A busy holiday weekend. Buildings collapse, streets are blocked, fires break out and aftershocks follow.',
    build: () => ({
      id: 'quake-mce', version: 1, seed: 7, occupancy: 'holiday-peak',
      hazards: [{ type: 'earthquake', params: { preset: 'MCE', aftershocks: true, softStoreyFactor: 0.85 }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0, label: 'Site' }, t: 0 }],
    }),
  },
  {
    id: 'column-loss',
    title: 'Building collapse',
    icon: 'collapse',
    blurb: 'A ground-floor column gives way in R03-C and the collapse spreads along the building.',
    focus: 'R03-C',
    build: (twin) => ({
      id: 'column-loss', version: 1, seed: 5, occupancy: 'weekday-night',
      hazards: [{ type: 'collapse', params: { trigger: 'column-loss', extent: 'progressive', propagation: 0.5 }, origin: wingOrigin(twin, 'R03-C', 0, 4), t: 0 }],
    }),
  },
  {
    id: 'power-cut',
    title: 'Power cut at night',
    icon: 'power',
    blurb: '90 minutes without power and the generators fail to start. People are stuck in lifts.',
    build: () => ({
      id: 'power-cut', version: 1, seed: 3, occupancy: 'weekday-night',
      hazards: [{ type: 'power', params: { duration_min: 90, backupGenerators: false, emergencyLighting: true, entrapmentProbability: 0.35 }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0, label: 'Site' }, t: 0 }],
    }),
  },
];
