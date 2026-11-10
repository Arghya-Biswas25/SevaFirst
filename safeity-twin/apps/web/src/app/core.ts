/**
 * App-level singletons: the dataset, the main-thread twin (for rendering and
 * picking) and the hazard registry. The simulation keeps its own twin in the worker.
 */
import { buildTwin, type Twin } from '@twin/twin-data';
import { hazards } from '@twin/sim-runtime';
import { loadDataset } from '../dataset';

export const ds = loadDataset();
const t0 = performance.now();
export const twin: Twin = buildTwin(ds);
export const twinBuildMs = Math.round(performance.now() - t0);
export { hazards };

export const HAZARD_ICONS: Record<string, string> = {
  fire: 'fire', collapse: 'collapse', earthquake: 'earthquake', power: 'power', flood: 'flood', cyclone: 'cyclone',
  gas: 'gas', medical: 'medical', lightning: 'power', heatwave: 'hazard', chemical: 'gas', drowning: 'flood', crowd: 'people',
};

export const OCCUPANCY = Object.entries(ds.occupancy.profiles).map(([id, p]) => ({ id, label: p.label }));
