import { describe, expect, it } from 'vitest';
import { SimEngine } from '@twin/sim-runtime';
import type { RescueOpView } from '@twin/dispatch';
import type { HazardSpec, Scenario } from '@twin/twin-schema';
import { loadDataset } from './fixtures';

const engine = new SimEngine(loadDataset());
const twin = engine.twin;

function fire(wingId: string, storey: number): HazardSpec {
  const w = twin.wings[twin.wingById.get(wingId)!];
  const sp = w.tpl.typical.spaces.find((s) => s.roomRole === 'living')!;
  const g = w.storeyOffsets[storey] + sp.i;
  return { type: 'fire', params: { growth: 'fast', fireFlatDoorOpen: true }, origin: { kind: 'space', E: twin.space.E[g], N: twin.space.N[g], up: storey * 3, buildingId: w.id, storey, spaceId: g }, t: 0 };
}
const scenario = (hazards: HazardSpec[], extra: Partial<Scenario> = {}): Scenario => ({ id: 't', version: 1, seed: 42, occupancy: 'weekday-night', hazards, ...extra });

/** Step until `stop` says so (or the step budget runs out); returns every phase seen. */
function follow(op: string, stop: (v: RescueOpView) => boolean, maxSteps: number) {
  const phases: string[] = [];
  const methods = new Set<string>();
  let last: RescueOpView | undefined;
  for (let i = 0; i < maxSteps; i++) {
    engine.step(0.5);
    const v = engine.ops.views().find((o) => o.id === op);
    if (!v) break;
    last = v;
    if (phases[phases.length - 1] !== v.phase) phases.push(v.phase);
    methods.add(v.method);
    if (stop(v)) break;
  }
  return { phases, methods, last: last! };
}

describe('incidents', () => {
  it('lists a burning flat with the people who need help and a crew that can go', { timeout: 60000 }, () => {
    engine.start(scenario([fire('R13', 2)], { resources: { disabled: ['WARDEN-E', 'WARDEN-W', 'QRT-1'] } }), { launchedOnly: false });
    for (let i = 0; i < 160; i++) engine.step(0.5);
    const inc = engine.ops.incidents.items.find((i) => i.kind === 'fire' && i.active)!;
    expect(inc).toBeDefined();
    expect(inc.place).toContain('R13');
    expect(inc.people).toBeGreaterThan(0);
    expect(inc.rescue.can).toBe(true);
    expect(inc.rescue.unit).toBe('FT-1');
  });
});

describe('rescue operations', () => {
  it('uses the ladder at a window when fire blocks the way to the flat door, and brings people out', { timeout: 60000 }, () => {
    const inc = engine.ops.incidents.items.find((i) => i.kind === 'fire' && i.active)!;
    const res = engine.startRescue(inc.id);
    expect(res.ok).toBe(true);
    const first = engine.ops.views().find((o) => o.id === res.op)!;
    // the household is told to stay put and shown in its room straight away
    expect(first.victimAt).not.toBeNull();
    expect(first.roomView).not.toBeNull();
    const { phases, methods, last } = follow(res.op!, (v) => v.rescued > 0, 3000);
    expect(methods.has('window')).toBe(true);
    expect(last.rescued).toBeGreaterThan(0);
    // it went through the whole sequence in order
    const order = ['dispatch', 'setup', 'entry', 'search', 'extract', 'handover'];
    const seen = phases.filter((p) => order.includes(p));
    for (const p of order) expect(seen).toContain(p);
    expect(seen.indexOf('entry')).toBeLessThan(seen.indexOf('extract'));
    // the people brought out are recorded as rescued
    expect(engine.evac.kpis().byStatus.rescued).toBeGreaterThanOrEqual(last.rescued);
  });

  it('hands the crew back to the dispatcher when the rescue is stopped', { timeout: 60000 }, () => {
    const op = engine.ops.views().find((o) => !o.done)!;
    expect(engine.dispatch.resources.find((r) => r.spec.id === op.unit)!.lock).not.toBeNull();
    engine.stopRescue(op.id);
    expect(engine.dispatch.resources.find((r) => r.spec.id === op.unit)!.lock).toBeNull();
    expect(engine.evac.groups.some((g) => g.claimed === op.id)).toBe(false);
    expect(engine.ops.views().find((o) => o.id === op.id)!.done).toBe(true);
  });

  it('walks in by the stairs: the path climbs the stair flights through doorways', { timeout: 120000 }, () => {
    engine.start(scenario([{ type: 'earthquake', params: { preset: 'MCE', aftershocks: false }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }], { seed: 7, occupancy: 'holiday-peak' }), { launchedOnly: false });
    for (let i = 0; i < 500; i++) engine.step(0.5);
    const inc = engine.ops.incidents.items.find((i) => i.kind === 'damage' && i.rescue.can)!;
    expect(inc).toBeDefined();
    const res = engine.startRescue(inc.id);
    expect(res.ok).toBe(true);
    let entry: RescueOpView | undefined;
    const { last } = follow(res.op!, (v) => {
      if (v.phase === 'entry' && v.method === 'stairs' && !entry) entry = v;
      return v.phase === 'extract';
    }, 2500);
    expect(entry).toBeDefined();
    const z = [];
    for (let i = 2; i < entry!.path.length; i += 3) z.push(entry!.path[i]);
    // goes up the flights: points between floor levels (the half landings), not a vertical jump
    expect(Math.max(...z)).toBeGreaterThan(3);
    const landings = z.filter((h) => {
      const r = (((h - 0.24) % 3) + 3) % 3;
      return r > 0.5 && r < 2.5;
    });
    expect(landings.length).toBeGreaterThan(0);
    expect(last.phase).toBe('extract');
  });

  it('frees people from a stuck lift', { timeout: 60000 }, () => {
    engine.start(scenario([{ type: 'power', params: { duration_min: 90, backupGenerators: false, entrapmentProbability: 0.35 }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }], { seed: 3 }), { launchedOnly: false });
    for (let i = 0; i < 20; i++) engine.step(0.5);
    const inc = engine.ops.incidents.items.find((i) => i.kind === 'lift')!;
    expect(inc).toBeDefined();
    const res = engine.startRescue(inc.id);
    const { last } = follow(res.op!, (v) => v.done, 3000);
    expect(last.phase).toBe('complete');
    expect(last.rescued).toBe(inc.people);
    const [, w, lift] = inc.id.split(':');
    expect(engine.field.trappedLifts.find((x) => x.wing === Number(w) && x.lift === lift)!.resolved).toBe(true);
  });
});
