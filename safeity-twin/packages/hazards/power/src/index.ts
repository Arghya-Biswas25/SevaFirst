/**
 * Power failure (PRD Section 8): lifts stop, some cars stall between floors,
 * corridors go dark (slower walking) until generators or the grid return.
 */
import type { HazardInstance, HazardPlugin, SimContext } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';
import { wingStoreyTemplate } from '@twin/twin-data';

class PowerInstance implements HazardInstance {
  private end: number;
  private dgAt: number;
  private restored = false;
  private dgFailAt: number;
  constructor(ctx: SimContext, spec: HazardSpec) {
    const p = spec.params;
    this.end = ctx.t + Number(p.duration_min ?? 60) * 60;
    this.dgAt = p.backupGenerators ? ctx.t + 45 : Infinity;
    this.dgFailAt = p.backupGenerators ? Infinity : ctx.t + 45;
    const f = ctx.field;
    f.powerOn = false;
    f.liftsOn = false;
    f.darkness = p.emergencyLighting ? 0.3 : 0.8;
    const pEnt = Number(p.entrapmentProbability ?? 0.25);
    let n = 0;
    for (const w of ctx.twin.wings) {
      if (w.massingOnly) continue;
      const st = wingStoreyTemplate(w, 1);
      for (const lift of st.lifts) {
        if (ctx.rng.chance(pEnt)) {
          const persons = ctx.rng.int(1, 6);
          f.trappedLifts.push({ wing: w.idx, lift: lift.id, persons, t: ctx.t, resolved: false });
          n++;
        }
      }
    }
    ctx.emit({ type: 'power', level: 'critical', text: `Power failure across the site; lifts stopped; ${n} lift car${n === 1 ? '' : 's'} with people inside` });
  }
  step(_dt: number, ctx: SimContext): void {
    const f = ctx.field;
    if (!this.restored && ctx.t >= this.dgAt) {
      f.darkness = 0;
      ctx.emit({ type: 'generators', level: 'info', text: 'Backup generators carry common lighting; lifts stay locked out until inspected' });
      this.dgAt = Infinity;
    }
    if (!this.restored && ctx.t >= this.dgFailAt) {
      this.dgFailAt = Infinity;
      ctx.emit({ type: 'generators-failed', level: 'warn', text: f.darkness > 0.5 ? 'Backup generators did not start: corridors and stairs are dark' : 'Backup generators did not start: emergency lighting only' });
    }
    if (!this.restored && ctx.t >= this.end) {
      this.restored = true;
      f.powerOn = true;
      f.darkness = 0;
      if (f.trappedLifts.every((x) => x.resolved)) f.liftsOn = true;
      ctx.emit({ type: 'power-restored', level: 'info', text: 'Grid power restored; lifts return to service after inspection' });
    }
  }
  done() {
    return this.restored;
  }
}

export const powerPlugin: HazardPlugin = {
  id: 'power',
  label: 'Power failure',
  description: 'Site blackout: lifts stop, people trapped in cars, dark corridors',
  release: 'v1',
  enabled: true,
  targets: ['space', 'building', 'outdoor'],
  params: [
    { key: 'duration_min', label: 'Outage duration', type: 'number', unit: 'min', min: 5, max: 600, step: 5, default: 60 },
    { key: 'backupGenerators', label: 'Backup generators', type: 'boolean', default: true },
    { key: 'emergencyLighting', label: 'Emergency lighting in corridors', type: 'boolean', default: true },
    { key: 'entrapmentProbability', label: 'Chance a lift car is occupied', type: 'number', min: 0, max: 1, step: 0.05, default: 0.25 },
  ],
  create: (ctx, spec: HazardSpec) => new PowerInstance(ctx, spec),
};
