import { describe, expect, it } from 'vitest';
import { hungarian } from '@twin/dispatch';
import { Runner, type FromWorker } from '@twin/sim-runtime';
import { loadDataset } from './fixtures';

describe('dispatch optimiser', () => {
  it('finds the minimum-cost assignment', () => {
    // three units, three tasks; greedy would pick 1 for row 0 and lose overall
    const cost = [
      [1, 2, 9],
      [2, 9, 9],
      [9, 9, 1],
    ];
    expect(hungarian(cost)).toEqual([1, 0, 2]);
  });
  it('handles more tasks than units', () => {
    const a = hungarian([[5, 1, 3]]);
    expect(a).toEqual([1]);
  });
});

describe('runner protocol (shared by the worker and the inline fallback)', () => {
  it('boots, runs, pauses and resets through messages', { timeout: 60000 }, async () => {
    const got: FromWorker[] = [];
    const r = new Runner((m) => got.push(m), 0);
    r.handle({ type: 'init', ds: loadDataset() });
    expect(got[0].type).toBe('ready');
    r.handle({
      type: 'start',
      options: { launchedOnly: true },
      scenario: { id: 'p', version: 1, seed: 3, occupancy: 'weekday-night', hazards: [{ type: 'power', params: { duration_min: 30, backupGenerators: false }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }] },
    });
    r.handle({ type: 'speed', value: 60 });
    await new Promise((res) => setTimeout(res, 1500));
    r.handle({ type: 'pause' });
    const snaps = got.filter((m) => m.type === 'snapshot');
    const last = snaps[snaps.length - 1];
    expect(last.type === 'snapshot' && last.snap.running).toBe(false);
    expect(last.type === 'snapshot' && last.snap.t).toBeGreaterThan(10);
    expect(last.type === 'snapshot' && last.snap.powerOn).toBe(false);
    r.handle({ type: 'stop' });
    const reset = got[got.length - 1];
    expect(reset.type === 'snapshot' && reset.snap.t).toBe(0);
    r.dispose();
  });
});
