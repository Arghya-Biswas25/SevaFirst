# Architecture

## Layers

```
data/sites/<site>/*.json ──► twin-schema (types, validation)
                              │
                              ▼
                         twin-data  ── typology templates → rooms, doors, stairs, lifts, flats
                         │        │
              main thread│        │worker
                         ▼        ▼
     geometry → render ← interaction       sim-runtime (engine, 0.5 s fixed tick)
         ▲                                  ├─ nav        (pedestrian + vehicle graph)
         │ snapshots (10 Hz, transferable)  ├─ hazards/*  (plugins write the FieldStore)
         │                                  ├─ routing    (hazard zones, edge risk, route planner)
         └──────────────────────────────────├─ crowd      (evacuation)
                                            ├─ dispatch   (responder optimiser, safe staging)
                                            └─ advisor    (recommendations, live playbook)
apps/web: React shell (docks, context menu, simulation window) wiring render ⇄ SimClient
```

Rules that keep it extensible:

* Packages only depend downward. The renderer never simulates; the simulation never imports three.js.
* Hazard plugins never call each other, the crowd model or dispatch. They read and write the shared
  `FieldStore` (temperature, soot, heat release, burn state, damage, blocked streets, debris, power, lifts)
  and emit events. Everything downstream reacts to the field, so a new hazard needs no changes elsewhere.
* Plugins can spawn other hazards through `ctx.spawn` (the earthquake spawns collapses and gas fires).
* Every random draw comes from a seeded `Rng`, so a scenario replays identically.

## Threads

The engine runs in a Web Worker (`packages/sim-runtime/src/worker.ts`). The main thread renders and handles
input only. The worker advances the engine on a fixed 0.5 s tick scaled by the speed control and posts a
snapshot about 10 times a second; typed arrays (space states, people, wing damage) are transferred, not
copied. If a host forbids workers, `SimClient` falls back to running the same `Runner` on the main thread.

Per tick the engine runs: hazards → tenability → hazard zones and edge risk (every 2 s) → crowd → dispatch →
advisor (2 s) → route planner (every `max(4 s, 0.4 s × speed)`) → playbook (1 s). The design of the routing,
planner and playbook layer is in `docs/RESPONSE_DESIGN.md`.

## Coordinates

* Site frame: local ENU metres, origin at the centre of The Blu lagoon, +E east, +N north.
* Bearings: degrees clockwise from north. A wing's local +x runs along its axis.
* `localToEN(pose, x, y)`: `E = E0 + x·sinβ − y·cosβ`, `N = N0 + x·cosβ + y·sinβ`.
* three.js: `X = E`, `Y = up`, `Z = −N`; instance yaw `= 90° − bearing`.
* Storey height 3.0 m. Residential wings are G+5 (flats on floors 1–5); mixed-use blocks are G+7 with shops
  on the ground and first floors.

## Performance budget

| Item | Approach | Measured (this repo) |
| --- | --- | --- |
| Buildings | one `InstancedMesh` per typology shell; damage tint per instance | 54 wings in ~20 draw calls |
| Interiors | one instanced mesh per typology and storey kind; only wings near the camera focus are packed into the draw (`count`) | ~85 draw calls with interiors on |
| Hazard field | per-room boxes with a per-instance RGBA attribute, one draw | up to 8,000 rooms |
| Smoke and flames | two `Points` pools with a soft-sprite shader | 1,200 particles, 2 draws |
| People | instanced capsules, up to 5 per household group; previous and next positions in instance attributes, interpolated in the vertex shader (one uniform per frame) | up to 16,000 |
| Evacuation flow | `LineSegments2` in three width buckets, dashes scrolled on the GPU; geometry rebuilt at most 3×/s | ~4,000 segments in an MCE quake |
| Routes and zones | `Line2` wide lines and translucent fills rebuilt only when the plan, selection or zone set changes | 6.5 ms per frame to render the MCE quake with 6,300 people (Chromium, integrated GPU) |
| Twin build | typed arrays | ~100 ms for 20,838 spaces |
| Navigation graph | ~9,600 nodes, ~10,600 edges | ~170 ms |
| Simulation step | cost-to-safety field refreshed every 4 s; groups descend it in O(path) | ~15 ms average in a site-wide MCE earthquake (Node), ~2.4 ms in the two-fires case |
| Route planner | outdoor-only fastest/safest fields cached until zones change; per-floor local searches with stamp arrays | ~9 ms per plan for two burning wings |

## Evacuation, routing and dispatch in one paragraph each

**Hazard zones.** Every 2 s the field is turned into outdoor zones (collapse cordon one building height around a
collapsed wing, fall zones around earthquake damage, fire exposure around burning wings, a downwind smoke plume,
debris). Each street edge carries the mean zone risk along it. The crowd multiplies outdoor walking time by
`1 + 4·risk`, an assembly point inside a zone with risk ≥ 0.45 is closed, and dispatch stages vehicles outside
zones and upwind of fires.

**Route planner.** For each focus wing and occupied floor the planner builds the recommended, fastest and safest
routes plus one route per stair, and reports a stair that cannot be used with the reason. Each route is walked with
the crowd's speed model (time, queueing, distance, smoke dose, visibility, heat, damage, zones) and given a risk
score `100·(1 − e^−H)`. Recommended is the best time–risk balance, so it is never beaten on both. For every unit on a
task it plans the approach, staging, entry path on foot (breathing apparatus) and extraction.

**Evacuation.** Each household is a group with a pre-movement delay. A multi-source Dijkstra from every safe
assembly point builds a cost-to-safety field over a *convenience* cost: walking time, plus penalties for smoke,
heat and damage (untenable edges are impassable), plus congestion from people already committed to each edge,
with doors and stairs limited by SFPE flow capacities. Assembly points look further away as they fill, so
people spread over the open spaces by capacity. Groups with no tenable route shelter in place and become
rescue tasks.

**Dispatch.** Every 5 s the dispatcher lists tasks (fire attack, first attack, assisted evacuation, search and
rescue, casualties, lift rescue, traffic control), values each by the people it protects, discounts by arrival
time (`value · exp(−eta/τ)`), and solves the unit-to-slot assignment with the Hungarian algorithm. Current
assignments get a 25% bonus so units do not flap. Routes use the street graph; debris-blocked streets are
crossed on foot at a fraction of the speed. Off-site units are called in as mutual aid and stood down after
three quiet minutes. Every assignment carries its reason and the next-best alternative; unserved tasks are
listed with why.
