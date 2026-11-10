import { describe, expect, it } from 'vitest';
import { SimEngine } from '@twin/sim-runtime';
import { CLOSE_RISK, deriveZones, type PlanRoute } from '@twin/routing';
import { enToLocal } from '@twin/core';
import type { HazardSpec, Scenario } from '@twin/twin-schema';
import { loadDataset } from './fixtures';

const engine = new SimEngine(loadDataset());
const twin = engine.twin;

function fire(wingId: string, storey: number, params: HazardSpec['params'] = {}): HazardSpec {
  const w = twin.wings[twin.wingById.get(wingId)!];
  const sp = w.tpl.typical.spaces.find((s) => s.roomRole === 'living')!;
  const g = w.storeyOffsets[storey] + sp.i;
  return { type: 'fire', params: { growth: 'fast', ...params }, origin: { kind: 'space', E: twin.space.E[g], N: twin.space.N[g], up: storey * 3, buildingId: w.id, storey, spaceId: g, label: `${wingId} floor ${storey}` }, t: 0 };
}
const scenario = (hazards: HazardSpec[], occupancy = 'weekday-night', seed = 42): Scenario => ({ id: 't', version: 1, seed, occupancy, hazards });
const run = (steps: number) => {
  for (let i = 0; i < steps; i++) engine.step(0.5);
};

describe('hazard zones and the edge-risk field', () => {
  it('puts a collapse cordon around a collapsed wing and closes an assembly point inside it', () => {
    engine.start(scenario([]), { launchedOnly: false });
    const f = engine.field;
    // the wing whose footprint is nearest an assembly point
    const aps = twin.ds.amenities.assemblyPoints;
    let best = { w: -1, ap: aps[0], d: Infinity };
    for (const w of twin.wings) {
      if (w.massingOnly) continue;
      for (const ap of aps) {
        const [u, v] = enToLocal(w.pose, ap.E, ap.N);
        const d = Math.hypot(Math.max(0, Math.abs(u) - w.L / 2), Math.max(0, Math.abs(v) - w.W / 2));
        if (d < best.d) best = { w: w.idx, ap, d };
      }
    }
    expect(best.d).toBeLessThan(20);
    f.wingDamage[best.w] = 4;
    f.activeWings.add(best.w);
    const zones = deriveZones(twin, f, { speed_ms: 0, fromDeg: 0 });
    const cordon = zones.find((z) => z.kind === 'collapse' && z.wing === best.w)!;
    expect(cordon).toBeDefined();
    engine.risk.update(f, engine.t, { speed_ms: 0, fromDeg: 0 }, true);
    expect(engine.risk.pointRisk(twin.wings[best.w].pose.E, twin.wings[best.w].pose.N).risk).toBeGreaterThanOrEqual(CLOSE_RISK);
    expect(engine.risk.pointRisk(best.ap.E, best.ap.N).risk).toBeGreaterThanOrEqual(CLOSE_RISK);
    // some street edges now carry risk, so routing avoids them
    expect(engine.risk.risk.some((r) => r > 0)).toBe(true);
    engine.evac.toSafety(f, engine.t + 10);
    const ap = engine.evac.kpis().assembly.find((a) => a.id === best.ap.id)!;
    expect(ap.open).toBe(false);
    expect(ap.reason).toContain('Collapse cordon');
  });
});

describe('route planner', () => {
  it('gives every floor of a burning wing recommended, fastest and safest routes that are consistent', { timeout: 60000 }, () => {
    engine.start(scenario([fire('R13', 2)]), { launchedOnly: false });
    run(500);
    engine.focus(twin.wingById.get('R13')!);
    const wp = engine.planner.plans.wings.find((w) => w.id === 'R13')!;
    expect(wp).toBeDefined();
    expect(wp.floors.length).toBeGreaterThanOrEqual(5);
    let avoid = 0;
    for (const fp of wp.floors) {
      const open = fp.routes.filter((r) => !r.labels.includes('avoid'));
      avoid += fp.routes.length - open.length;
      if (fp.advice === 'shelter') {
        expect(open.length).toBe(0);
        continue;
      }
      const by = (l: PlanRoute['labels'][number]) => open.find((r) => r.labels.includes(l))!;
      const rec = by('recommended');
      const fast = by('fastest');
      const safe = by('safest');
      expect(rec && fast && safe).toBeTruthy();
      expect(fast.m.time_s).toBeLessThanOrEqual(safe.m.time_s);
      expect(safe.m.risk).toBeLessThanOrEqual(fast.m.risk);
      // never recommend a route that another route beats on both time and risk
      expect(open.some((r) => r.m.time_s < rec.m.time_s && r.m.risk < rec.m.risk)).toBe(false);
      expect(fp.best).toBe(rec.id);
      for (const r of open) {
        expect(r.pts.length).toBeGreaterThanOrEqual(6);
        expect(r.goal).toMatch(/^AP-/);
      }
    }
    // the stair next to the fire is reported, with the reason, on at least one floor
    expect(avoid).toBeGreaterThan(0);
    const reason = wp.floors.flatMap((f) => f.routes).find((r) => r.labels.includes('avoid'))!.notes[0];
    expect(reason).toMatch(/smoke|hot|fire|untenable/);
  });

  it('plans the approach, entry and extraction for a rescue unit', { timeout: 60000 }, () => {
    const rescues = engine.planner.plans.rescues;
    expect(rescues.length).toBeGreaterThan(0);
    const r = rescues.find((x) => x.entry)!;
    expect(r).toBeDefined();
    expect(r.staging.note).toMatch(/Stage \d+ m/);
    expect(r.entry!.pts.length).toBeGreaterThanOrEqual(6);
    expect(r.entry!.time_s).toBeGreaterThan(0);
    if (r.taskKind === 'rescue') expect(r.extraction).not.toBeNull();
  });
});

describe('hazard upgrades and the playbook', () => {
  it('earthquake: people drop, cover and hold during the shaking and leave after it', { timeout: 60000 }, () => {
    engine.start(scenario([{ type: 'earthquake', params: { preset: 'DBE', aftershocks: false }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }], 'weekday-day', 7), { launchedOnly: false });
    run(10);
    expect(engine.field.shaking).toBeGreaterThan(0);
    expect(engine.evac.kpis().byStatus.moving).toBe(0);
    run(30);
    expect(engine.field.shaking).toBe(0);
    const pb = engine.playbook.view.tracks[0];
    expect(pb.hazard).toBe('earthquake');
    const dch = pb.phases[0].steps.find((s) => s.id === 'dch')!;
    expect(dch.status).toBe('done');
    expect(dch.at).toBeGreaterThanOrEqual(15);
    run(300);
    expect(engine.evac.kpis().byStatus.moving + engine.evac.kpis().byStatus.safe).toBeGreaterThan(0);
  });

  it('fire: sprinklers stop a room fire before flashover', { timeout: 60000 }, () => {
    engine.start(scenario([fire('R13', 3, { sprinklers: true })]), { launchedOnly: false });
    run(600);
    const types = new Set(engine.allEvents().map((e) => e.type));
    expect(types.has('sprinkler')).toBe(true);
    expect(types.has('flashover')).toBe(false);
    const fireStep = engine.playbook.view.tracks[0].phases.flatMap((p) => p.steps).find((s) => s.id === 'alarm')!;
    expect(fireStep.status === 'done' || fireStep.status === 'late').toBe(true);
  });

  it('power failure: residents shelter in place and wardens get welfare checks', { timeout: 60000 }, () => {
    engine.start(scenario([{ type: 'power', params: { duration_min: 60, backupGenerators: false, emergencyLighting: false }, origin: { kind: 'outdoor', E: 0, N: 0, up: 0 }, t: 0 }]), { launchedOnly: false });
    run(100); // generators are reported 45 s in
    expect(engine.evac.kpis().alerted).toBe(0);
    expect(engine.dispatch.tasks.some((t) => t.kind === 'welfare')).toBe(true);
    const steps = engine.playbook.view.tracks[0].phases.flatMap((p) => p.steps);
    expect(steps.find((s) => s.id === 'lighting')!.status).toBe('missed');
  });
});
