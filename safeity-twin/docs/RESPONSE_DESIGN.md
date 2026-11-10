# Response, evacuation and rescue routing — system design

This document is the design for Milestone 1.1: turning the hazard simulator into a response trainer that shows
**how to handle** each crisis, **which way** to evacuate or reach people, and **why** that way, while keeping the
3D view smooth. It was written before the code and the code follows it.

## 1. Goals

| # | Goal | Measured by |
| --- | --- | --- |
| G1 | For every affected building and floor, show the evacuation options: the **recommended**, the **fastest** and the **safest** route, plus any route that must be **avoided**, with time, distance, hazard exposure and a risk score | Routes tab, 3D route overlay |
| G2 | For every responder task, show the **fastest safe approach** (drive), where to **stage**, the **entry path** to the people (which stair) and the **extraction route** back out | Routes tab → Rescue, cyan rescue paths |
| G3 | Make outdoor danger real: people and vehicles avoid **fall zones**, **collapse cordons**, **fire exposure** and **smoke plumes**, not only debris | Edge-risk field shared by crowd, planner and dispatch |
| G4 | Show the **procedure** for each hazard as a live playbook (phases, steps, status, timestamps, what to do) | Plan tab |
| G5 | Make each hazard model more faithful (sprinklers, shaking phase and drop-cover-hold, cordons, assembly-point safety, welfare in blackouts) | Hazard plugins, crowd |
| G6 | Keep 60 fps class rendering: no per-frame allocation, GPU-side animation, throttled React | Frame time with 16k people and flows on |

## 2. Layers after this change

```
twin-data ─► nav ─► routing (NEW) ─► crowd ─► dispatch ─► advisor (+ playbook)
                       ▲                │          │
 hazard plugins ─► FieldStore ──────────┴──────────┘
                                         sim-runtime: engine → snapshot (plans, zones, flows, playbook)
                                         render: flow layer, route layer, zone layer, smooth people & vehicles
                                         web: Plan tab, Routes tab, incident HUD
```

`@twin/routing` depends only on `core`, `nav`, `hazard-sdk` and `twin-data`. It never imports the crowd or
dispatch; they import it. Plugins still only write the `FieldStore`.

## 3. Hazard zones and the edge-risk field (`routing/risk.ts`)

Plugins write per-space state (smoke, heat, burn, damage) and per-wing damage. Outdoors, danger is derived from
that state every 2 s of simulated time into **hazard zones** (ENU polygons) and then into a per-edge risk array.

| Zone | Source | Shape | Risk |
| --- | --- | --- | --- |
| `collapse` cordon | wing with complete damage / collapsed spaces | footprint grown by 1.0 × height (USAR collapse zone) | 0.85 |
| `fall` zone | earthquake damage moderate / extensive | footprint grown by 0.3 H / 0.6 H (parapets, glass, cladding) | 0.25 / 0.5 |
| `fire` exposure | wing with burning rooms | footprint grown by 6–10 m (radiant heat, falling glass) | 0.35–0.7 by heat release |
| `plume` | wing with burning rooms | downwind sector 70 m long, ±18°, | 0.3 × wind factor |
| `debris` | collapse debris polygons | as written by the collapse plugin | blocked (×6 time, as before) |

`EdgeRisk` holds, for every nav edge, `risk ∈ [0,1]` and the id of the worst zone. Outdoor edges are sampled every
4 m once at start-up; an update tests samples only against zones whose bounding box they fall in. Indoor edges
take their risk from tenability: `1 − min(tenability(space), tenability(space2))`.

Every consumer uses the same field:

* **crowd:** outdoor walking time is multiplied by `1 + 4·risk`, so evacuees walk around fall zones and plumes;
  an assembly point with point risk ≥ 0.45 is closed and its arrivals are re-routed.
* **dispatch:** staging points are chosen outside zones and upwind of fires; vehicle routes get a `1 + 3·risk`
  penalty and the plain fastest route is kept as the alternative.
* **planner:** the risk score of each route (section 4).

## 4. Route planner (`routing/planner.ts`)

### Cost models

| Model | Edge cost (seconds) | Meaning |
| --- | --- | --- |
| `fastest` | walk time at hazard-reduced speed; untenable (< 0.25) and collapsed edges impassable | least time, accepts smoke |
| `safest` | walk time × (1 + 25·h²) + 40·h, h = edge hazard (indoor 1−tenability, outdoor zone risk) | least exposure, accepts detours |
| `recommended` | the crowd's own convenience cost (hazard, congestion, assembly-point capacity) | what the model sends people along |

### Algorithm

1. Every planning interval (`max(4 s, 0.4 s × speed)` of simulated time, so at most ~2.5 plans per wall second)
   build two reverse multi-source Dijkstra fields from the open assembly points (`fastest`, `safest`) and reuse the
   crowd's field for `recommended`. ~5 ms each on 9.6k nodes.
2. **Focus wings**: burning, damaged (≥ moderate), with sheltering or trapped people, plus the wing the user is
   looking at. Ranked by people inside, at most 6 + the requested one.
3. For each occupied floor of a focus wing, from the floor's corridor node:
   * one **local search** per cost model over the wing's own subgraph, ending at any wing exit with terminal cost
     `field[exit]`, then a descent of that field to an assembly point (O(path));
   * one local search **per stair** with the other stairs closed, giving "via Stair S2" alternatives;
   * if a stair is unusable, a search that ignores tenability finds its geometry and the first untenable edge
     becomes the **avoid** route with the reason (e.g. "S1 smoke-logged at floor 2: visibility 1.4 m, 96 °C").
   Local searches use pre-allocated stamp arrays, so each costs only the nodes it touches (~150).
4. Routes with identical edge lists are merged and their labels combined ("Recommended · Safest").
5. Each route is **evaluated** edge by edge with the crowd's speed model: time (walk + expected queue at doors and
   stairs from committed load), distance, smoke dose (fraction of an incapacitating dose, FED-style, /90 s),
   minimum visibility, maximum temperature, stairs, debris crossings and zones crossed.
   **Risk score** = `100 · (1 − exp(−H))`, `H = Σ t_e·h_e / 60 + 3·dose + 0.4·debris`; bands Low < 15,
   Moderate < 40, High < 70, Severe ≥ 70.
6. Floor advice: **evacuate** (best route and its time), or **shelter in place** when no tenable route exists
   (with instructions), which also raises a rescue task in dispatch as before.

### Rescue plans

For every unit assigned to a fire, rescue, medical or lift task:

* **Approach**: the drive route it is on, its ETA, and the alternative (plain fastest vs zone-avoiding) with the
  time difference and the reason.
* **Staging**: the node chosen (outside zones, upwind for fire) and why.
* **Entry**: a responder path on foot from staging to the people (smoke tolerated with breathing apparatus, heat
  over 120 °C and collapsed spaces impassable), naming the stair. For fires the attack stair is the one nearest
  the fire; residents are guided to the other.
* **Extraction**: the safest route from the people to an assembly point or the ambulance.

## 5. Playbook (`advisor/playbook.ts`)

A stateful `Playbook` holds the standard procedure for each active hazard type as phases → steps. Each step has a
condition evaluated against the live state (events seen, evacuation figures, dispatch, field) and records the
simulated time it was first met. Statuses: `pending`, `active` (its phase has started), `done`, `late` (done after
its target time) and `missed` (condition can no longer be met, e.g. the fire flat door was left open).

| Hazard | Phases |
| --- | --- |
| Fire | Detect and alarm → Evacuate and confine → Attack and rescue → Recover |
| Earthquake | Shaking: drop, cover, hold → Get out to open ground → Assess and rescue → Stabilise |
| Collapse | Alarm and cordon → Evacuate neighbours → Search and rescue → Stabilise |
| Power failure | Assess → Lift rescue and welfare → Restore |

Each hazard also gets a **strategy** line ("Full evacuation of R17-B; neighbours stay unless smoke reaches them"),
shown above the checklist.

## 6. Hazard model upgrades

* **Fire:** optional **sprinklers** (activation at 68 °C hot layer; heat release then decays as
  `Q_act · exp(−0.023 (t − t_act))`, no flashover in that room) and **smoke detection** that shortens the alarm.
* **Earthquake:** a **shaking phase** whose duration follows the event (DBE 15 s, MCE 25 s, scenario
  `5 + 6 (M − 5)` s). Residents drop, cover and hold during shaking and start leaving only after it ends;
  `field.shaking` drives building sway in the renderer.
* **Collapse:** cordon zone derived from the failed span; adjacent wings alerted; secondary-collapse watch in the
  playbook.
* **Power:** welfare checks for vulnerable residents on upper floors become a warden task.
* **Crowd:** assembly-point status (open, filling, full, closed with reason); signed edge flows (people heading
  each way along each edge) for the flow overlay.

## 7. Snapshot protocol

| Field | Size | Frequency |
| --- | --- | --- |
| `flows: Float32Array` — `[E1,N1,z1,E2,N2,z2,people,congestion]` per edge with flow, oriented in travel direction | ≤ 8k × 8 floats, transferred | every snapshot |
| `zones: HazardZone[]` | tens of polygons | every snapshot (small) |
| `plans?: PlanSet` | per focus wing and floor, routes as flat point arrays | **only when its version changes** |
| `playbook?: PlaybookView` | ~40 steps | only when it changes |
| `shaking: number` | scalar | every snapshot |

New message to the worker: `{ type: 'focus', wing }` — plan this wing now (works while paused).

## 8. Rendering and smoothness

| Item | Before | After |
| --- | --- | --- |
| People | new `Float32Array` and `setColorAt` for every person every frame | colours written once per snapshot; per frame only translation entries written into the instance buffer; interpolation over the measured snapshot interval |
| Vehicles | jumped to each 10 Hz position | interpolated between snapshots with smoothed heading; flashing beacons |
| Routes | new geometry and two materials every snapshot | persistent `Line2` routes rebuilt only when the plan or selection changes; animated dashes by `dashOffset` (GPU) |
| Evacuation flow | 14 sample polylines | `LineSegments2` in three width buckets coloured by congestion, dashes scrolling in the walking direction; geometry refreshed at most 3×/s |
| Zones | none | fill + dashed outline + label per zone, rebuilt only when the zone set changes |
| Assembly points | static green | coloured by status, pulsing ring when closed |
| Earthquake | none | vertex-shader building sway driven by one uniform |
| React | every snapshot re-rendered the whole app | renderer gets every snapshot; React state at ≤ 4 Hz; panels memoised |

## 9. UI

* **Plan tab:** strategy per hazard, phase timeline, checklist with status, time and what to do.
* **Routes tab:** wing and floor picker (floors coloured by best-route risk), route cards with labels, metrics
  and reasons; hover highlights a route in 3D, click flies to it. Rescue section with approach, staging, entry and
  extraction per unit.
* **Incident HUD:** phase, clock, people out / inside / trapped, units on scene, shaking indicator.
* Layers: new toggles for evacuation flow and hazard zones; legend updated.

## 10. Incidents and commanded rescues (Milestone 1.2)

`dispatch/operations.ts` adds two things on top of the optimiser:

* **Incidents** (`RescueOps.update`, every simulated second): fires grouped per flat, collapses and badly damaged
  buildings with people stranded, the injured, stuck lifts and power cuts. People who need a crew (sheltering,
  trapped, injured, and the occupants of a burning flat) belong to the nearest fire in their building, else to the
  building's collapse or damage incident.
* **Operations** (`RescueOps.start/step/stop`): the chosen crew is locked in the dispatcher (the optimiser no longer
  moves it) and driven by a state machine: dispatch → (reposition) → setup → entry → search → extract → handover,
  per household. Access is decided twice, going in and coming out: the stairs if the way from the vehicle to the
  flat door is passable (for residents coming out: no fire, under 80 °C, not collapsed), else a ladder to a window
  or balcony of the flat that is not burning and can be reached through unburnt rooms (aerial ladder within 24 m of
  a drivable kerb, carried ladder up to three floors). Legs are polylines with a speed per segment, built through
  doorway positions and along the dog-leg stair flights, so the renderer can move people exactly.

The renderer (`render/rescue.ts`) interpolates the distance along each leg between snapshots, poses walking,
climbing and idle figures, raises the ladder, and computes the inside camera. The split view renders the scene twice
per frame with scissored viewports: the outside pass uses the user's camera (with a cutaway above the crew's floor
while they are inside), the inside pass a follow camera with interiors forced on for that building, the cut and
x-ray lifted, labels and route overlays hidden, and fog set from the visibility where the person is.

## 11. Tests

* zones: a collapsed wing yields a collapse cordon containing its own footprint; an AP inside a zone is closed.
* planner: on a fire with smoke in one stair, fastest time ≤ safest time and safest risk ≤ fastest risk; the
  smoke-logged stair is reported as avoid or high risk.
* rescue: a sheltering group yields a rescue plan with approach, entry and extraction.
* existing suites unchanged (two fires, one tender still sends the first tender to R17-B).
