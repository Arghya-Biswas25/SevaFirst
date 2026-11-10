# Safeity Digital — Digital Twin

A to-scale 3D digital twin of the Safeity Digital township (Provident Housing, Chicalim–Dabolim, South Goa) with
an all-hazards simulator. Right-click anywhere in the model to start a fire, a building collapse, an earthquake
or a power failure at that spot. The app evacuates every household along the most convenient tenable route,
dispatches fire tenders, ambulances and rescue teams with an optimiser, and explains each decision.

Built from the PRD "Township Digital Twin" (Claude Docs). This repository is Milestone 1: a working vertical
slice of every layer in the PRD, on L1 data calibrated from the developer's floor-plan brochure (`ePlan.pdf`).

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

Production build:

```bash
npm run build        # apps/web/dist
npm run preview      # http://localhost:4173
```

`npm run check` runs the typecheck, the test suite and the production build.

Requires Node 20 or newer. The built app is static files and runs from any web server (it cannot run from
`file://` because browsers block module workers there).

## Using the app

| Action | How |
| --- | --- |
| Look around | **Overview** (key 1): drag to turn, Shift-drag to move, scroll to zoom |
| Fly through buildings | **Fly** (key 2): drag to look, W A S D to fly, Q and E down and up, G to go through walls or not |
| Walk a floor | **Walk** (key 3) or double-click a room: W A S D to walk, Page Up and Page Down to change floor |
| See inside | **Rooms** (I), **See-through** (X), or show only the floors up to a chosen one |
| Start an emergency | Pick a scenario on the left, or right-click a room, building or open ground and choose fire, collapse, earthquake or power cut |
| See every emergency | Right dock → **Incidents**: each burning flat, collapse, group of stranded people and stuck lift, most urgent first, with how many people need help |
| Rescue people | **Start rescue** on an incident. A crew drives there, sets up, goes in by the stairs (or up a ladder to a window or balcony when fire blocks the way to the flat door), finds the residents and brings them out, one household at a time |
| Watch a rescue | Starting a rescue splits the view: **outside** (the building, the fire engine and ladder; floors above the crew are cut away while they are inside) and **inside** (a camera in the residents' room, then following the crew in and the residents out). The strip below shows each step. **Auto speed** fast-forwards the driving and slows down when people move |
| Ways out | Right dock → **Evacuation**: headcount, assembly points, and for each building and floor the best, fastest and safest way out and the ones not to use |
| What to do | Right dock → **Response**: the checklist for each emergency (ticked off as it happens), what each crew is doing, and advice |
| Click a building | A card with its details and buttons to walk in, see its ways out or start an incident there |

## Repository layout

```
apps/web/                  React shell: viewport, docks, context menu, simulation window
packages/
  core/                    RNG, geometry helpers, fixed-step clock, event bus
  twin-schema/             dataset and scenario types + validation
  twin-data/               typology templates → per-room twin (20,838 spaces, 1,912 flats)
  geometry/                shell and interior meshes, ribbons, colours
  render/                  three.js scene: instancing, picking, hazard/people/vehicle overlays
  interaction/             camera modes (orbit, hover/fly, walk) with collision
  nav/                     pedestrian + vehicle navigation graph, A*, multi-source fields
  routing/                 hazard zones, edge-risk field, walking model, evacuation and rescue route planner
  hazard-sdk/              HazardPlugin contract and the shared FieldStore
  hazards/{fire,collapse,earthquake,power}/   v1 hazard plugins
  crowd/                   household evacuation (convenience routing, queues, shelter-in-place)
  dispatch/                responder optimiser (Hungarian assignment, re-solved every 5 s)
  advisor/                 rule-based recommendations with reasons and sources; live response playbook
  sim-runtime/             engine, worker, protocol, hazard registry, inline fallback
  ui-kit/                  shared React primitives
data/sites/safeity-digital/ the site dataset (site, typologies, buildings, streets, amenities, resources, occupancy, rules)
tools/ingest-eplan/        scripts that measured the brochure and generated the dataset
tests/                     Vitest suites (dataset, navigation, simulation, runtime)
docs/                      architecture, plugin guide, data notes, build status
```

## Adding a hazard

Write a `HazardPlugin` in `packages/hazards/<id>`, register it in `packages/sim-runtime/src/registry.ts`, and it
appears in the right-click menu and the simulation window with a form generated from its parameters. Routing,
evacuation, dispatch and advice react to what it writes into the shared field. See `docs/PLUGIN_GUIDE.md`.

## Accuracy

Geometry is L1: building positions, orientations and footprints are measured from the brochure master plan
(about 0.64 m per pixel, cross-checked four ways) and floor plans; interiors are generated from the published
unit types and sized to RERA carpet areas. Positions are within about ±5 m and bearings within about ±2°.
Replacing the files in `data/sites/safeity-digital` with sanctioned CAD (L2) or an as-built survey (L3) upgrades
the twin without code changes. The fire, structural and seismic models are engineering approximations for
planning and training, not certified analyses. See `docs/DATA.md` and `docs/STATUS.md`.
