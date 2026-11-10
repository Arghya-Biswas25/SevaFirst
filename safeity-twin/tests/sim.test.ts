import { describe, expect, it } from 'vitest';
import { SimEngine } from '@twin/sim-runtime';
import { findSpaceAt } from '@twin/twin-data';
import type { Scenario } from '@twin/twin-schema';
import { loadDataset } from './fixtures';

const ds = loadDataset();

function fireIn(engine: SimEngine, wingId: string, storey: number, roomRole = 'living') {
  const w = engine.twin.wings[engine.twin.wingById.get(wingId)!];
  const st = w.tpl.typical;
  const sp = st.spaces.find((s) => s.roomRole === roomRole)!;
  const g = w.storeyOffsets[storey] + sp.i;
  return { kind: 'space' as const, E: engine.twin.space.E[g], N: engine.twin.space.N[g], up: storey * 3, buildingId: w.id, storey, spaceId: g, label: `${wingId} floor ${storey} ${sp.name}` };
}

describe('simulation engine', () => {
  const engine = new SimEngine(ds);
  it('builds quickly enough for a worker', () => {
    expect(engine.buildMs).toBeLessThan(8000);
  });

  it('runs the PRD two-fires-one-tender case end to end', { timeout: 60000 }, () => {
    const scn: Scenario = {
      id: 'two-fires', version: 1, seed: 42, occupancy: 'weekday-night',
      hazards: [
        { type: 'fire', params: { growth: 'fast' }, origin: fireIn(engine, 'R17-B', 2), t: 0 },
        { type: 'fire', params: { growth: 'medium' }, origin: fireIn(engine, 'R13', 4), t: 120 },
      ],
    };
    engine.start(scn, { launchedOnly: false });
    let maxStep = 0;
    for (let i = 0; i < 1800; i++) {
      engine.step(0.5);
      if (i % 20 === 0) maxStep = Math.max(maxStep, engine.snapshot().stepMs);
    }
    const snap = engine.snapshot();
    const evs = engine.allEvents();
    const types = new Set(evs.map((e) => e.type));
    console.log('events', evs.length, [...types].join(','));
    console.log(evs.filter((e) => e.type === 'assign' || e.type === 'call').slice(0, 8).map((e) => `${e.t.toFixed(0)}s ${e.text}`).join('\n'));
    console.log('evac', JSON.stringify(snap.evac.byStatus), 'inside', snap.evac.inside, 'max step ms', maxStep);
    console.log('recs', snap.recommendations.map((r) => r.title).join(' | '));
    expect(types.has('ignition')).toBe(true);
    expect(types.has('assign')).toBe(true);
    expect(snap.evac.byStatus.safe).toBeGreaterThan(0);
    // first tender goes to the single-stair wing
    const first = evs.find((e) => e.type === 'assign' && e.text.startsWith('Fire tender 1'));
    expect(first?.text).toContain('R17-B');
  });

  it('runs a design-basis earthquake with cascades', { timeout: 60000 }, () => {
    const scn: Scenario = {
      id: 'quake', version: 1, seed: 7, occupancy: 'holiday-peak',
      hazards: [{ type: 'earthquake', params: { preset: 'MCE', aftershocks: true, softStoreyFactor: 0.85 }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }],
    };
    engine.start(scn, { launchedOnly: false });
    for (let i = 0; i < 1200; i++) engine.step(0.5);
    const snap = engine.snapshot();
    console.log('damage', snap.damage, 'blocked', snap.blockedStreets.length, 'evac', JSON.stringify(snap.evac.byStatus));
    expect(snap.damage.reduce((a, b) => a + b, 0)).toBe(54);
    expect(snap.evac.byStatus.safe).toBeGreaterThan(0);
  });

  it('picks the same space for the same click', () => {
    const w = engine.twin.wingById.get('R13')!;
    expect(findSpaceAt(engine.twin, w, 2, 5, 0)).toBe(findSpaceAt(engine.twin, w, 2, 5, 0));
  });
});
