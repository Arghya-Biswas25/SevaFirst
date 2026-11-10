# Writing a hazard plugin

A hazard is a package under `packages/hazards/<id>` that exports a `HazardPlugin`
(`packages/hazard-sdk/src/index.ts`). Registering it makes it appear in the right-click menu and the
simulation window; its `params` become the form.

```ts
import type { HazardPlugin, HazardInstance, SimContext } from '@twin/hazard-sdk';
import type { HazardSpec } from '@twin/twin-schema';

class FloodInstance implements HazardInstance {
  private depth = 0;
  constructor(private spec: HazardSpec) {}
  step(dt: number, ctx: SimContext) {
    const rate = Number(this.spec.params.rain_mm_h) / 3600 / 1000; // m/s
    this.depth += rate * dt;
    // write consequences into the shared field; downstream engines react to it
    if (this.depth > 0.3) {
      ctx.field.liftsOn = false;                     // lifts are isolated in pits
      // ...mark ground-floor spaces damaged, streets blocked, etc.
    }
    if (this.depth > 0.15 && !this.alerted) {
      this.alerted = true;
      ctx.emit({ type: 'flood', level: 'warn', text: 'Water over 15 cm on the ring road' });
      ctx.alertAll('flooding', 300);                 // site-wide move to high ground
    }
  }
  private alerted = false;
  summary() { return { depth_m: Math.round(this.depth * 100) / 100 }; }
}

export const floodPlugin: HazardPlugin = {
  id: 'flood',
  label: 'Flood and waterlogging',
  description: 'Rainfall accumulation on the site with lift isolation and blocked streets',
  release: 'v1',
  enabled: true,
  targets: ['outdoor', 'building', 'space'],
  params: [
    { key: 'rain_mm_h', label: 'Rainfall', type: 'number', unit: 'mm/h', min: 10, max: 300, step: 10, default: 100 },
  ],
  create: (_ctx, spec) => new FloodInstance(spec),
};
```

Then, in `packages/sim-runtime/src/registry.ts`, replace the planned entry with `hazards.register(floodPlugin)`
and add the package to the workspace (`package.json`, `tsconfig.json` paths, `vitest.config.ts` alias).

## What a plugin can use

| `SimContext` member | Use |
| --- | --- |
| `twin` | rooms, openings, flats, wings, poses (`@twin/twin-data`) |
| `field` | shared state: `temp`, `soot`, `hrr`, `burn`, `damage` per space; `wingDamage`; `blockedStreet`; `debris`; `liftsOn`, `powerOn`, `darkness`; `activeWings` |
| `rng` | seeded random numbers (never use `Math.random`) |
| `t`, `wind` | simulated time and wind |
| `emit(event)` | log line, toast for `critical`, and input to the advisor |
| `spawn(spec)` | start another hazard (cascades) |
| `alert(wings)`, `alertAll()` | sound alarms; the crowd model starts pre-movement |

Add `activeWings.add(w)` for any wing you change so the snapshot ships its rooms to the renderer.

## Checklist

* Deterministic: the same seed gives the same run.
* Bounded cost: keep `step` under a few milliseconds for the whole site.
* Explain: emit events in plain words; the log is the user's narrative.
* Test: add a case to `tests/sim.test.ts` that runs the plugin headless through `SimEngine`.
