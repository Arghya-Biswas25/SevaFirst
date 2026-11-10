import { describe, expect, it } from 'vitest';
import { validateDataset } from '@twin/twin-schema';
import { buildTwin, findSpaceAt, spaceLabel, twinStats } from '@twin/twin-data';
import { enToLocal, localToEN } from '@twin/core';
import { loadDataset } from './fixtures';

const ds = loadDataset();

describe('dataset', () => {
  it('validates without errors', () => {
    const errors = validateDataset(ds).filter((i) => i.level === 'error');
    expect(errors).toEqual([]);
  });
});

describe('twin expansion', () => {
  const twin = buildTwin(ds);
  it('creates every wing and the launched flat count from the ePlan tables', () => {
    const st = twinStats(twin);
    expect(st.buildings).toBe(56);
    // 26 launched wings + mixed-use arms; ePlan unit tables give 992 launched flats
    expect(st.launchedFlats).toBe(992);
  });
  it('round-trips local and site coordinates', () => {
    const pose = { E: 12, N: -40, bearing: 66.3 };
    const [E, N] = localToEN(pose, 10, 3);
    const [x, y] = enToLocal(pose, E, N);
    expect(x).toBeCloseTo(10, 6);
    expect(y).toBeCloseTo(3, 6);
  });
  it('labels a picked space', () => {
    const w = twin.wingById.get('R13')!;
    const g = findSpaceAt(twin, w, 3, 0, 0);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(spaceLabel(twin, g)).toContain('R13 · Floor 3');
  });
  it('keeps modelled carpet within 15% of RERA carpet for every flat (L1 parametric)', () => {
    const bad = twin.flats.filter((f) => Math.abs(f.carpet_m2 / f.reraCarpet_m2 - 1) > 0.15);
    expect(bad.map((f) => `${f.key} ${f.carpet_m2.toFixed(1)}/${f.reraCarpet_m2.toFixed(1)}`)).toEqual([]);
  });
});
