# Safeity Digital — Urban & Township All-Hazards Digital Twin & Emergency Simulator *(Current Release: Milestone 1.2)*

A browser-based, to-scale 3D **all-hazards digital twin, evacuation route planner, responder dispatcher, and rescue simulator**—starting at the **township level** with **Safeity Digital** (calibrated township layout, Provident Housing / Puravankara, Chicalim–Dabolim, South Goa, India) as its working vertical slice, and engineered to scale into a **whole-city emergency digital twin** covering townships, marketplaces, shopping districts, business districts, offices, malls, and government complexes.

> **Current Status:** **Milestone 1.2 Delivered (Township Wedge)** — A complete, interactive vertical slice of the platform running on calibrated **L1** data for the Safeity Digital township (`ePlan.pdf`), packaged into a zero-backend TypeScript monorepo and a single self-contained HTML artifact (`LWM/safeity-digital-twin.html`). All **26 automated tests across 6 Vitest suites pass**.

---

## Table of Contents

1. [What the Product Is Currently](#1-what-the-product-is-currently)
2. [The Main Problem It Solves](#2-the-main-problem-it-solves)
3. [What It Aims to Build (City-Scale Vision & Roadmap)](#3-what-it-aims-to-build-city-scale-vision--roadmap)
4. [How Much Is Already Built](#4-how-much-is-already-built)
5. [Features & Main (Hero) Features](#5-features--main-hero-features)
6. [Existing Market Solutions & Why This Is Different and Better](#6-existing-market-solutions--why-this-is-different-and-better)
7. [Architecture & Tech Stack (In Detail & Rationale)](#7-architecture--tech-stack-in-detail--rationale)
8. [Workspace Layout](#8-workspace-layout)
9. [How to Install, Run, and Use It](#9-how-to-install-run-and-use-it)
10. [Extending the Simulator (Plugins, New Districts & Data Upgrades)](#10-extending-the-simulator-plugins-new-districts--data-upgrades)
11. [Accuracy, Calibration & Known Limits](#11-accuracy-calibration--known-limits)

---

## 1. What the Product Is Currently

Today, **Safeity Digital — Emergency Simulator** (`LWM/safeity-twin`) is the **first working township-scale deployment** of the platform. It is a live, interactive 3D web application that models an entire ~32-acre multi-building coastal township—spanning residential wings, mixed-use commercial/shop blocks, hotel arms, internal streets, and open grounds—down to every individual room, doorway, staircase, lift shaft, and road segment:

* **Full Township Scale:** **56 buildings** (52 residential wings, 2 mixed-use retail+residential blocks `MU-E` / `MU-N`, and 2 hotel arms), **1,912 flats** (992 launched across 28 launched buildings, plus 26 future and 2 proposed buildings), **20,838 rooms and spaces**, and **29,860 openings, stairs, and lifts**, plus **231 street centrelines**, **5 assembly points**, and **2 site gates** centred around *The Blu* lagoon (`3,108 m²`).
* **Interactive Hazard Sandbox:** Users can right-click any room, building, or open ground to trigger a **Fire**, **Building Collapse**, **Earthquake**, or **Power Failure**, inject additional hazards mid-simulation, or launch **6 ready-made scenarios**—including cascading multi-hazard emergencies.
* **Live Operational Command Center:** While hazards evolve, the engine simulates thousands of occupants evacuating along tenable routes, optimizes fire/rescue/medical vehicle dispatch via the Hungarian algorithm, computes floor-by-floor **Best / Fastest / Safest / Don't use** evacuation plans, ticks off a live SOP **Response Checklist**, and lets users command **real-time stair or aerial-ladder rescues** through a split-screen **Outside / Inside** follow camera.
* **Single-File Portable Delivery:** Compiles into a single static HTML bundle (`apps/web/dist/index.html` / `LWM/safeity-digital-twin.html`) with no server-side database or installation required.

---

## 2. The Main Problem It Solves

Across rapidly urbanizing cities—whether in gated residential townships, dense marketplaces, shopping malls, corporate business districts, or government complexes—emergency preparedness suffers from four systemic blind spots:

1. **Structural & Egress Bottlenecks Are Invisible on Paper:** High-density developments mix multi-staircase towers, single-staircase residential wings (e.g., `R17-B`, where 40 flats and ~80 typical residents depend on a single staircase), mixed-use retail podiums (`MU-E`, `MU-N`), and stilt ground storeys (soft-storey vulnerability in Seismic Zone III). A single fire on Floor 2 or a left-open flat door can turn that sole staircase smoke-logged within minutes—stranding every floor above. At city scale, crowded bazaars, multi-level malls, high-rise office cores, and busy government campuses amplify these bottlenecks exponentially.
2. **Static Evacuation PDFs Break Under Dynamic Hazards:** Printed fire escape maps assume every corridor is passable, every street is clear for fire engines, and every assembly point is safe. They cannot answer what happens when:
   * Corridor visibility drops below `1.5 m` or temperatures exceed `76 °C`–`80 °C`;
   * Collapsed facades drop debris across narrow township loop roads or market lanes, blocking fire tender access;
   * Wind blows a toxic smoke plume directly over an outdoor assembly point, forcing closure and mid-evacuation rerouting;
   * Population shifts drastically by time of day—for example, sleeping **Weekday night** residential occupancy (`35%` awake, `240 s` median pre-movement delay) vs. **Weekday day** office/commercial peaks or **Holiday peak** crowds (`92%` occupancy, `1.2×` population, `600` visitors at The Blu) where total evacuees exceed nominal assembly capacity.
3. **Resource Scarcity & Triage Blindness Across Districts:** Neither townships nor cities have infinite emergency units. Safeity Digital's current township model has **1 on-site standby fire tender (`FT-1`)** and on-foot wardens/QRT, while mutual-aid fire tenders (`FT-2`, `18 min` ETA), ambulances (`12–20 min` ETA), and USAR teams (`30 min` ETA) must drive in from off-site. Incident commanders, municipal disaster agencies, and facility teams lack a shared tool to rehearse **who gets rescued first, why a unit prioritizes one block over another, where vehicles must stage upwind, and when a window ladder rescue is required instead of stairs**.
4. **Disconnected Engineering & GIS Silos:** Traditional fire CFD software, pedestrian microsimulators, and city GIS dashboards live in separate specialist silos. Single-building CFD tools ignore city road networks and dispatch, while city-scale GIS viewers lack indoor room/stair physics and tenability math—making neither suitable for rapid, interactive operational drills.

---

## 3. What It Aims to Build (City-Scale Vision & Roadmap)

Our long-term goal is to build an **all-hazards, room-accurate Emergency Digital Twin for an entire city**—starting from the **township level** (`Safeity Digital`) and scaling horizontally across every urban zone and building type:

### A. From Township Wedge to Full City Coverage
Starting with the validated **Safeity Digital** township engine, the platform aims to encompass **every major functional zone of a city** within one interconnected digital twin:
* **Residential Townships & Housing Colonies:** High-rise towers, mid-rise wings, villa clusters, single-stair blocks, and clubhouse/lagoon precincts (proven today in Milestone 1.2).
* **Marketplaces & High-Density Shopping Districts:** Open-air bazaars, street markets, narrow vendor lanes, congested pedestrian precincts, and densely packed older commercial blocks where crowd crush, LPG cylinder fires, and blocked fire-lane access are critical risks.
* **Shopping Malls & Entertainment Venues:** Multi-storey atrium buildings, basements/parking decks, food courts, cinema halls, and escalators/egress cores requiring complex multi-floor crowd flow and smoke-control simulation.
* **Business Districts, Corporate Offices & IT Parks:** High-rise glass office towers, multi-tenant campuses, basement server/electrical rooms, and rush-hour vertical evacuation planning.
* **Government Offices, Civic Campuses & Public Infrastructure:** Secretariat buildings, municipal headquarters, courthouses, transit hubs, hospitals, and emergency operations centres requiring continuity-of-operations planning, VIP/vulnerable occupant welfare, and coordinated public safety response.

### B. Architectural & Capability Expansion Roadmap
* **Multi-District Streaming & City-Wide Road Networks:** Extending the current single-site loader (`data/sites/<site>/`) into streamed urban tiles and interconnected municipal arterial street graphs so municipal fire brigades, police, and ambulances can dispatch dynamically across neighborhoods and jurisdictions.
* **Precision Data Progression (`L1` → `L2` → `L3`):** Built with a strict schema boundary (`@twin/twin-schema`) so replacing L1 brochure/map-calibrated JSONs with **L2 sanctioned architectural/structural CAD & BIM** or **L3 as-built survey / LiDAR coordinates** (anchored globally via **UTM / `EPSG:32643`** Ground Control Points) upgrades 3D geometry, interior partitions, and routing graphs with **zero simulation code changes**.
* **Full 13+ Hazard Multi-Risk Coverage:** Expanding beyond the 4 active v1 hazards (`fire`, `collapse`, `earthquake`, `power`) to 9 urban, weather, medical, and public-crowd hazards already stubbed in `packages/sim-runtime/src/registry.ts`—essential for marketplaces, malls, business districts, and coastal cities:
  * **v1 Roadmap:** `flood` (urban DEM & stormwater drain waterlogging), `cyclone` (IMD wind fields, tree fall, facade glazing failure), `gas` (LPG/pipeline leak dispersion & explosion), `medical` (mass-casualty START triage at plazas & assembly points).
  * **v1.1 Roadmap:** `lightning` (strike probability & protection coverage), `heatwave` (urban heat island index & vulnerable occupants), `chemical` (plant-room chlorine / industrial hazmat release), `drowning` (waterfront / lagoon lifeguard response), `crowd` (density levels of service & crowd crush in malls, marketplaces, and public gatherings).
* **Calibrated Engineering & Regulatory Verification:** Replacing placeholder seismic fragility medians with curves signed off by structural engineers for diverse urban typologies (RCC frames, steel towers, unreinforced market structures), verifying the **NBC 2016 Part 4** rule pack (`data/sites/safeity-digital/rules/nbc-2016-part4.json`), adding counterfactual "fork scoring" in the Advisor, and enabling optional **Tier B** FDS/CFD export for critical rooms/atriums.
* **Collaborative City Command & Training (PRD Milestones 2–3):** Persistent saved scenarios, shareable drill links/replays, active marshal/warden redirection of evacuating crowds, and multi-user inter-agency command exercises (fire brigade, municipal disaster management, facility security, and medical dispatch).

---

## 4. How Much Is Already Built

The project has completed **Milestones 1, 1.1, and 1.2** on the first township site (**Safeity Digital**)—already proving both residential wings (`52` wings) and mixed-use retail/commercial blocks (`MU-E`, `MU-N`) plus hotel massing (`HOTEL`), alongside the complete simulation, routing, dispatch, rescue, and playbook architecture needed to scale city-wide:

### Completed & Verified (Milestones 1 → 1.2)

| Area | Implemented Capability | Verification |
| :--- | :--- | :--- |
| **3D Digital Twin Engine** | 56 buildings (54 detailed residential + mixed-use commercial wings + 2 hotel massing arms), 1,912 flats, 20,838 rooms/spaces, 29,860 openings/stairs/lifts, 231 streets, 5 assembly points, lagoon, boundary. Windows & balcony parapets rendered as true openings. | Verified by `tests/twin.test.ts` (all flats within ±15% of RERA carpet area; 0 schema errors). |
| **Camera & Inspection** | **Overview** (orbit), **Fly** (ghost or solid wall collision), **Walk** (1.6 m eye-level with wall collision & floor stepping), **See-through** (X-ray), **Rooms** (interiors), **Floor cut** (`All floors` down to `Ground`), hover readouts, live room temperature/visibility/burn/damage card. | Verified in Chromium at desktop & portrait widths. |
| **v1 Hazard Plugins** | **Fire** (t² growth, ventilation/fuel caps, sprinklers @ 68 °C NIST decay, smoke/heat door leakage, stair buoyancy, window-plume vertical spread), **Earthquake** (Zone III DBE/MCE + custom M/R/depth, shaking phase, soft-storey factor, vertex-shader building sway, cascading collapses & post-quake kitchen gas fires, seismic lift stops), **Collapse** (column loss, gas explosion, construction failure, progressive bay propagation, facade debris blocking streets), **Power failure** (lift entrapment, emergency lighting vs. dark corridors, backup generator pass/fail, grid restoration). | Verified by `tests/sim.test.ts` & `tests/routing.test.ts`. |
| **Crowd Evacuation** | Per-household/group agents (up to 16,000 GPU-interpolated), occupancy profiles (`weekday-night`, `weekday-day`, `holiday-peak`), lognormal pre-movement delays, smoke/darkness speed reduction, SFPE door/stair capacity queueing, dynamic outdoor zone avoidance, capacity-aware assembly points (closure on hazard risk ≥ 0.45), shelter-in-place fallback. | Verified in MCE earthquake & two-fires simulations. |
| **Route Planner** | Reverse multi-source Dijkstra fields + per-floor local stamp-array search producing **Best**, **Fastest**, **Safest**, **Per-stair**, and **Don't use** routes with time, queueing, distance, stairs, min visibility, FED-style smoke dose, risk score (`0–100`), and reasons. Includes responder **Approach / Staging / Entry / Extraction** plans. | Verified by `tests/routing.test.ts` & `tests/nav.test.ts`. |
| **Responder Optimiser** | 9 configured resource units (on-site `FT-1`, `QRT-1`, `WARDEN-W`, `WARDEN-E`, `LIFT-1`; off-site `FT-2`, `AMB-1`, `AMB-2`, `USAR-1`). Hungarian assignment every `5 s` with `25%` hysteresis, upwind/outside-zone staging, mutual-aid call-in & 3-minute stand-down, explainable reasons & runner-up scores. | Verified on PRD *"Two fires, one tender"* test in `tests/sim.test.ts`. |
| **Incidents & Split Rescue View** | Urgency-sorted Incidents panel + `RescueOps` state machine (`Drive` → `Set up` → `Go in` → `Find` → `Bring out` → `Hand over`). Chooses stairs if tenable or aerial/carried ladder to a balcony/window if blocked. Scissored dual-viewport **Outside** (with cutaway above crew) + **Inside** (follow-cam with smoke fog), progress strip, and `Auto speed` (`30×`/`5×`). Lift-entrapment releases included. | Verified by 5 tests in `tests/rescue.test.ts`. |
| **Response Playbook & Advisor** | Stateful phase-by-phase SOP checklists (`Fire`, `Earthquake`, `Collapse`, `Power`) auto-evaluated live (`pending`, `active`, `done`, `late`, `missed`, `skipped`) with timestamps, plus prioritized commander recommendations citing rule sources. | Verified in `tests/routing.test.ts`. |

### Automated Test Verification
Running `npm test` inside `LWM/safeity-twin` executes **6 test files / 26 tests** (observed passing in ~22 s):
* `tests/twin.test.ts` (5 tests) — Dataset schema validation, 56 buildings, 992 launched flats, ENU round-trip math, space labeling, ±15% RERA carpet check.
* `tests/runtime.test.ts` (3 tests) — Worker/inline runner lifecycle (`boot`, `run`, `pause`, `reset`), snapshot protocol.
* `tests/nav.test.ts` (3 tests) — Pedestrian & vehicle nav graph connectivity (every flat reaches an assembly point without lifts).
* `tests/routing.test.ts` (6 tests) — Hazard zones, assembly point closure, fastest vs. safest route consistency, smoke-logged stair avoidance, earthquake drop-cover-hold, fire sprinklers, blackout welfare tasks.
* `tests/rescue.test.ts` (5 tests) — Incident listing, ladder-at-window rescue when fire blocks front door, stair-flight entry path, stopping rescues, lift release.
* `tests/sim.test.ts` (4 tests) — Full end-to-end PRD *"two fires, one fire engine"* scenario (`FT-1` prioritizes `R17-B` over `R13` due to 39 residents relying on 1 stair; mutual aid `FT-2` reassigned) and Design-Basis Earthquake with cascades.

### What Is Not Built Yet (City Expansion & Remaining Roadmap)
* **City-Scale Urban Expansion:** Multi-township / multi-district tile streaming, city-wide road & transit graphs, and dedicated architectural typologies for **open-air marketplaces, shopping districts, business districts, high-rise corporate offices, shopping malls, and government complexes** (currently only the Safeity Digital township dataset with residential, `MU-E`/`MU-N` retail+residential, and `HOTEL` massing is ingested).
* **9 Planned Hazard Plugins:** Currently visible as disabled stubs (`flood`, `cyclone`, `gas`, `medical`, `lightning`, `heatwave`, `chemical`, `drowning`, `crowd`).
* **L2 CAD / L3 Survey Ingestion:** Only L1 brochure/plan ingestion (`tools/ingest-eplan/`) is built so far.
* **Verified Structural & Code Packs:** Calibrated structural fragility curves and consultant-verified NBC 2016 Part 4 rule pack.
* **Multi-User & Collaboration (PRD Milestones 2–3):** Persistent saved scenarios, run sharing, multi-agency sessions, active warden crowd redirection, stair-climbing animation in Walk mode (`PgUp`/`PgDn` switches floors), and Tier B CFD/FDS export.

---

## 5. Features & Main (Hero) Features

### Main (Hero) Features

1. **Interactive 3D Digital Twin (`Overview`, `Fly`, `Walk` + `See-through` & `Rooms`)**
   * Inspect all 56 buildings and walk inside any flat, commercial ground floor, or corridor at `1.6 m` eye height.
   * Toggle **See-through** (`X`), **Rooms** (`I`), and **Up to floor N** cutaway dropdown to peel back roofs/slabs and inspect stair cores, lift shafts, and room layouts in real time.
   * Click any room or wing to open the **Selection Card** with flat count, typical occupancy, stair count (flagging `"1 (only one)"` wings), live temperature (`°C`), smoke visibility (`m`), burn status, and damage state.

2. **Right-Click Anywhere Simulation & Cascading Multi-Hazards**
   * Right-click (or long-press on mobile/touch) a specific room, building facade, or open ground to open a target-aware **Context Menu** and **Simulation Window** with parameter sliders generated straight from `@twin/hazard-sdk`.
   * Stack multiple incidents with staggered start offsets (`Start after N s`), inject new hazards into a live run, customize wind speed/direction, occupancy time-of-day, built-only filter, available crews, and deterministic random seeds.
   * Launch **6 built-in presets**: *Two fires, one fire engine*, *Kitchen fire above the shops*, *Moderate earthquake*, *Strong earthquake*, *Building collapse*, and *Power cut at night*.

3. **Urgency-Ranked Incidents & Dual-Angle Split-Screen Rescue View (`Start rescue`)**
   * Every active emergency—burning flats, collapses, stranded damage victims, trapped lifts, injured casualties—is grouped and ranked by urgency in the **Incidents** tab with headcount needing help.
   * Clicking **Start rescue** dispatches an available crew and splits the 3D viewport into two simultaneous live cameras:
     * **Outside Pane:** Tracks the fire engine driving to the site, staging outside hazard zones, repositioning beneath the target balcony/window when needed, extending the aerial/carried ladder, and cutting away building floors above the crew while they operate inside.
     * **Inside Pane:** Places a live follow-camera inside the residents' room while they wait, trails firefighters through doorways and stair flights or up the ladder, and applies dynamic smoke visibility fog matching the actual room soot density.
   * Includes a 6-step progress strip (`Drive` → `Set up` → `Go in` → `Find` → `Bring out` → `Hand over`), **`Auto speed`** pacing (`30×` during travel, automatically slowing to `5×` when crews/residents are moving), **`Swap`**, and **`Stop rescue`**.

4. **Floor-by-Floor Evacuation & Rescue Route Planner (`Evacuation` Tab)**
   * For every occupied floor of affected buildings, computes and color-codes **Best** (green), **Fastest** (amber), **Safest** (blue), **Other** (slate), and **Don't use** (red) routes.
   * Each route card reports walking time, queue delay, distance, stair flights, minimum visibility, FED-style smoke dose (`% of harmful`), risk score (`0–100` across Low/Moderate/High/Severe bands), and plain-English explanations (e.g., why a stair is smoke-logged or too hot).
   * Hovering a card highlights the exact 3D path; clicking flies the camera to it. If all exits are untenable, issues explicit **Stay inside and wait for rescue** instructions. Also exposes responder **Approach**, **Staging**, **Entry**, and **Extraction** routes.

5. **Explainable Hungarian Responder Optimiser (`Response` Tab)**
   * Automatically scores tasks by lives at risk, exponential arrival-time survival decay, and fire escalation risk, assigning on-site and mutual-aid units every `5 s` via the **Hungarian algorithm** (with `25%` switching hysteresis so units don't flap).
   * Explains *why* every crew was sent to its target and lists the next-best alternative, plus any unserved tasks waiting for a free unit.

6. **Self-Ticking Response Checklist (Live Playbook) & Crowd Physics**
   * Evaluates SOP phases (`Detect and alarm` → `Evacuate and confine` → `Attack and rescue` → `Recover`, plus hazard-specific tracks for earthquake, collapse, and power) against live simulation state—marking steps `done` (with exact timestamp), `late`, `missed`, or `not needed`.
   * Simulates thousands of evacuees simultaneously using pre-movement distributions, SFPE door/stair capacity bottlenecks, outdoor zone risk avoidance (`fall` zones, `collapse` cordons, `fire` exposure, `plume` sectors, `debris`), and automatic assembly-point closure/re-routing.

### Supporting Features
* **Live Incident HUD:** Displays simulation clock `T+MM:SS`, current response phase, live tallies (`out`, `inside`, `sheltering`, `trapped`, `casualties`, `units on scene / en route`, `closed assembly points`), and an animated shaking banner during earthquakes.
* **Interactive Event Log:** Reverse-chronological plain-English narrative (`Fire`, `Sprinkler`, `Crew sent`, `Smoke`, `Collapse`, `Rescue`, `Lifts`, etc.); clicking any entry flies the camera straight to that wing.
* **9 Toggleable Map Layers & Key (`Layers` Tab):** Toggle `People`, `Which way people are walking` (congestion-colored scrolling dashes), `Planned routes`, `Fire engines and crews`, `Fire and smoke`, `Danger zones`, `Assembly points`, `Streets`, and `Building names`.
* **Responsive Desktop & Mobile/Touch Support:** Adapts automatically between a 3-pane desktop workstation (`Left Dock` + `3D Stage` + `Right Dock`) and a stacked touch-friendly mobile layout (supporting long-press for the context menu and stacked split rescue panes).

---

## 6. Existing Market Solutions & Why This Is Different and Better

| Dimension | Fire & Egress Engineering Software *(e.g., NIST FDS / PyroSim, Pathfinder, MassMotion)* | Enterprise BIM / City GIS Twins *(e.g., Autodesk Tandem, Bentley iTwin, Esri ArcGIS Urban)* | Static PDF Plans & Custom VR Drills | **Safeity Digital** *(Township Wedge → City Twin)* |
| :--- | :--- | :--- | :--- | :--- |
| **Scale vs. Interior Fidelity** | Single-building focus; rarely handles 50+ buildings, multi-district roads, and municipal dispatch together | City-wide 3D massing & GIS layers, **but no room-by-room indoor navigation graph or stair/corridor fire physics** | Single building or static campus map | **Bridges both worlds:** Room-accurate indoor physics (doors, stairs, corridors) connected directly to multi-building outdoor street graphs and responder routing |
| **Simulation Scope** | Single-discipline (CFD smoke *or* pedestrian movement; external coupling required) | Passive 3D/GIS viewer + telemetry dashboards; no live emergency physics engine | No dynamic physics; fixed scripts or static diagrams | **Unified multi-hazard loop:** Fire + collapse + seismic cascades + power/lifts + crowd + responder dispatch + rescue ops |
| **Interactivity & Speed** | Offline batch runs taking minutes to hours; cannot inject hazards mid-run | Real-time viewing, not live incident simulation | Zero interactivity (PDF) or pre-baked trigger scripts (VR) | **Real-time interactive WebGL (~2.4–15 ms sim step):** right-click anywhere, inject mid-run, scrub speeds `1×`–`60×` |
| **Rescue & Dispatch Modeling** | Rarely models fire-tender street routing, upwind staging, or ladder vs. stair decisions | Asset tracking only; no responder optimisation | None | **Built-in Hungarian dispatcher + RescueOps:** auto-selects stair vs. window aerial ladder with split-screen follow-cam |
| **Explainability & SOP Grading** | Raw engineering plots / particle slices requiring specialist interpretation | Sensor alerts without tactical route trade-offs | Manual human grading on clipboards | **Explainable UI:** compares *Best / Fastest / Safest / Don't use* routes with reasons, dispatch runner-ups, and a **self-ticking SOP checklist** |
| **Deployment & Cost** | Heavy desktop installs, expensive per-seat licenses, specialist operators | Cloud SaaS / enterprise licensing, complex BIM setup | Printouts or expensive VR headsets/GPUs | **Zero-install single HTML file (`~1.5 MB`):** runs in any modern browser on laptop or mobile via static hosting |
| **Data Upgradeability** | Re-meshing and manual CAD cleanup required on every layout change | Heavy BIM pipeline tied to proprietary formats | Manual re-authoring | **L1 → L2 → L3 schema separation:** start today from brochure/GIS plans (`L1`), swap in CAD (`L2`) or survey (`L3`) JSON with zero code changes |

### Summary of Key Competitive Advantages
1. **Unifying Macro City Scale with Micro Room Physics:** City GIS tools stop at building exteriors; single-building FDS/Pathfinder models stop at the lobby door. Our architecture links room-level smoke/heat/door tenability directly to outdoor hazard zones, street closures, and fire-tender street graphs—essential when scaling from a single township to marketplaces, malls, office districts, and government campuses.
2. **Decisions, Not Just Visuals:** Most 3D digital twins stop at displaying geometry or red alert pins. This platform turns live physics into concrete tactical decisions: *"39 people above Floor 2 in R17-B rely on 1 stair → send Fire Tender 1 here first; Stair S1 is smoke-logged (1.4 m visibility, 96 °C) → take Stair S2 or rescue by aerial ladder to the Floor 2 balcony."*
3. **True Cascading Multi-Hazard Realism:** In an earthquake preset, seismic switches stop lifts, soft-storey wings suffer higher fragility damage, complete collapses block specific street links with facade debris, damaged kitchens spawn delayed gas-cylinder fires, and evacuees wait out the shaking (`Drop, Cover, Hold`) before navigating around outdoor fall zones.
4. **Accessible to Both Urban Planners and Field Responders:** Built on clean TypeScript modules with a 1-file plugin registration model (`HazardPlugin`) and site-agnostic JSON schemas (`data/sites/<site>/`), yet usable by non-technical marshals and municipal officers via plain-English explanations.

---

## 7. Architecture & Tech Stack (In Detail & Rationale)

### Layered System Architecture

```text
data/sites/<site>/*.json ──► @twin/twin-schema (site-agnostic types & validation)
                                  │
                                  ▼
                             @twin/twin-data (typology templates → rooms, openings, typed arrays)
                             │             │
                Main Thread  │             │  Web Worker (0.5 s fixed tick)
                             ▼             ▼
  @twin/geometry ──► @twin/render ◄── @twin/interaction     @twin/sim-runtime
                       ▲                                     ├─ @twin/nav        (indoor + outdoor street graph)
                       │  10 Hz Snapshots (Transferables)    ├─ @twin/hazards/*  (read/write FieldStore)
                       │                                     ├─ @twin/routing    (zones, edge risk, planner)
                       └─────────────────────────────────────├─ @twin/crowd      (evacuation & SFPE queues)
                                                             ├─ @twin/dispatch   (Hungarian optimiser & RescueOps)
                                                             └─ @twin/advisor    (recommendations & Playbook)
apps/web: React 19 UI shell (throttled ≤ 4 Hz) wiring Viewport ⇄ SimClient
```

Strict architectural invariants make this engine scalable from a township to city districts:
* **Downward-Only Dependencies:** Simulation packages never import `three`, and `@twin/render` never executes simulation logic.
* **Site-Agnostic Data Layer (`data/sites/<site>/`):** Buildings, street graphs, typologies (residential, retail/commercial, office, civic), occupancy profiles, and local resources live purely in validated JSON/GeoJSON—meaning adding a shopping district, mall, business park, or government complex does not require rewriting the engine.
* **Shared `FieldStore` Bus:** Hazard plugins never import or call each other, `@twin/crowd`, or `@twin/dispatch`. They read/write flat typed arrays in `FieldStore` (`temp`, `soot`, `hrr`, `burn`, `damage`, `wingDamage`, `blockedStreet`, `debris`, `powerOn`, `liftsOn`, `darkness`, `shaking`, `trappedLifts`) and emit events. Everything downstream reacts automatically.

---

### Detailed Tech Stack & Why Each Technology Was Chosen

| Layer | Technology / Library | Why We Chose It (Especially for Scaling Township → City) |
| :--- | :--- | :--- |
| **Language & Repo Structure** | **TypeScript `5.8.3`** (strict mode) + **npm Workspaces Monorepo** (`18` path-mapped packages under `packages/*`) | Guarantees type-safe contracts across geometry, physics, routing, worker IPC, and React UI (`tsc --noEmit`). Path-mapped packages enforce clean separation between headless simulation (testable in Node.js or future cloud workers) and WebGL rendering. |
| **3D Graphics Engine** | **Three.js `0.172.0`** (`InstancedMesh`, custom GLSL shaders, `Line2` / `LineSegments2`, scissored multi-pass rendering) | **Why Three.js directly instead of React-Three-Fiber or Unity/Unreal WebGL:** Direct WebGL buffer control keeps an MCE earthquake with 6,300+ evacuees at **~6.5 ms/frame** (~60 fps class) and lays the groundwork for large-district streaming:<br>• **Instanced Shells & Selective Interiors:** 54 wings share 7 typology geometries rendered in ~20 draw calls; interiors pack only buildings near camera focus into instance buffers (`~85` draw calls)—a crucial pattern when scaling to hundreds of city blocks.<br>• **Zero-Allocation People Shader (`PeopleLayer`):** Previous/next agent positions live in GPU instance attributes and interpolate via **one uniform per frame**, supporting up to 16,000 agents without 16k CPU matrix writes.<br>• **GPU Sway & Animated Flows:** Earthquake sway runs in a vertex shader; evacuation flow dashes scroll via `dashOffset` on the GPU.<br>• **Split-Screen Rescue View:** Renders two scissored passes in one WebGL context (outside cutaway view + inside smoke-fogged follow-cam) with zero extra canvas overhead. |
| **UI Framework & Styling** | **React `19.1.0`** + **Custom Dependency-Free `@twin/ui-kit`** + **Vanilla CSS** (`Barlow`, `Barlow Condensed`, `IBM Plex Mono`) | Keeps bundle size tiny, eliminates heavy component-library runtime overhead, and allows **asymmetric update throttling**: the Three.js renderer applies every 10 Hz worker snapshot immediately, while React panels (`TopBar`, `IncidentsPanel`, `RoutesPanel`, `ResponsePanel`, `Hud`) throttle re-renders to **≤ 4 Hz (`UI_MS = 250 ms`)** and use `React.memo` so DOM reconciliation never drops 3D frames. |
| **Concurrency & Determinism** | **Web Workers** (`@twin/sim-runtime/worker.ts`) with **Transferable Typed Arrays** + **Inline `Runner` Fallback** + **Seeded PRNG (`@twin/core`)** | Heavy routing, crowd steps (`~2.4–15 ms`), and Hungarian optimization run off the main thread so camera panning stays smooth. Typed arrays (`spaces`, `people`, `flows`, `wingDamage`) transfer via zero-copy ownership transfer at 10 Hz. If a browser environment restricts blob workers, `SimClient` transparently falls back to running the exact same `Runner` inline. Deterministic seeded `Rng` guarantees identical replay for drills and regression tests. |
| **Routing & Physics Engines** | **Custom TypeScript Graph & Engineering Solvers** (`@twin/nav`, `@twin/routing`, `@twin/crowd`, `@twin/dispatch`, `@twin/hazards/*`) | • **Multi-Source Dijkstra & Stamp-Array Local Search:** Pre-computes reverse cost-to-safety fields over ~9,600 nodes / ~10,600 edges (~5 ms) and per-floor local subgraphs (~150 nodes) without heap garbage—making floor-by-floor search O(local nodes) even as outdoor city graphs grow.<br>• **Hungarian Algorithm:** Globally optimal unit-to-task matching with 25% hysteresis to stop units oscillating.<br>• **SFPE / ISO 13571 / IS 1893 Engineering Models:** Real-time t² fire growth, McCaffrey–Quintiere–Harkleroad hot-layer correlation, FED smoke dose, SFPE door/stair capacity flow, and Zone III seismic fragility without external cloud API latency. |
| **Bundler & Single-File Delivery** | **Vite `6.3.5`** + **Custom `twin-single-file` Rollup Plugin** (`apps/web/vite.config.ts`) | Vite provides instant HMR in development and tree-shaken ES2022 builds in production. Our custom post-build Rollup plugin inlines JS, CSS, and the IIFE-bundled Web Worker (`?worker&inline`) into **a single standalone HTML file** (`dist/index.html` / `safeity-digital-twin.html`) for instant browser distribution. |
| **Testing & Validation** | **Vitest `3.2.4`** (Node environment, headless `SimEngine`) | Runs fast headless end-to-end simulations (`26` tests in ~22 s) to verify geometry tolerances, nav connectivity, dispatch priorities, route monotonicity, rescue state machines, and hazard cascades on every change. |
| **Site Data Ingestion (`L1`)** | **Python 3** (`PyMuPDF / fitz`, `Pillow`, `NumPy`, `SciPy`, `Matplotlib`, `scikit-image`) in `tools/ingest-eplan/` | Automates plan measurement: segments building footprints/bearings from PDFs (`0.64 m/px` calibration cross-checked 4 ways), skeletonizes paving into `streets.geojson` (`skimage.morphology.skeletonize`), and outputs schema-validated site JSONs ready for future district/city ingestion pipelines. |

---

## 8. Workspace Layout

```text
D:\LWM\LWM\
├── README.md                              # Comprehensive product & architecture guide (this file)
├── safeity-digital-twin.html              # Pre-built self-contained single-file HTML production app
├── safeity-twin-source.zip                # Source archive snapshot
├── adora_township_seed.json               # Seed coordinates & calibration metadata from ePlan
├── ePlan.pdf                              # Developer master plan & floor-plan brochure (L1 source)
└── safeity-twin/                          # Primary application monorepo
    ├── package.json                       # Workspace root scripts (dev, build, test, typecheck, check)
    ├── tsconfig.json                      # Strict TS config & @twin/* path aliases
    ├── vitest.config.ts                   # Headless Node test runner configuration
    ├── apps/web/                          # React shell: Viewport, TopBar, Left/Right Docks, SimWindow, RescueView
    ├── packages/
    │   ├── core/                          # Seeded RNG, ENU/local coordinate math, fixed clock, event bus
    │   ├── twin-schema/                   # TypeScript dataset & scenario schemas + validateDataset()
    │   ├── twin-data/                     # Typology templates → 20,838 spaces, 1,912 flats, typed arrays
    │   ├── geometry/                      # Procedural shell & interior meshes, colours, BoxBatch
    │   ├── render/                        # Three.js scene, GPU instancing, picking, overlays, scissored RescueLayer
    │   ├── interaction/                   # Orbit / Fly / Walk camera controller with wall/slab collision
    │   ├── nav/                           # Indoor + outdoor pedestrian/vehicle graph (~9.6k nodes, A*, Dijkstra)
    │   ├── routing/                       # Outdoor hazard zones, EdgeRisk, multi-criteria floor & rescue planner
    │   ├── hazard-sdk/                    # HazardPlugin contract, parameter form schema, shared FieldStore
    │   ├── hazards/{fire,collapse,earthquake,power}/   # v1 active hazard simulation plugins
    │   ├── crowd/                         # Household evacuation, SFPE queues, shelter-in-place, assembly status
    │   ├── dispatch/                      # Hungarian responder optimiser + RescueOps commanded rescue FSM
    │   ├── advisor/                       # Rule-based commander recommendations + stateful SOP Playbook
    │   ├── sim-runtime/                   # SimEngine, Web Worker, transferable snapshot protocol, hazard registry
    │   └── ui-kit/                        # Dependency-free React primitives & SVG icons
    ├── data/sites/safeity-digital/        # First site dataset (site, typologies, buildings, streets, amenities, resources, occupancy, NBC rules)
    ├── tools/ingest-eplan/                # Python scripts that calibrated ePlan.pdf and built the JSON dataset
    ├── tools/publish/                     # Single-file HTML artifact wrapper (make-artifact.mjs)
    ├── tests/                             # 6 Vitest suites (26 tests)
    └── docs/                              # ARCHITECTURE.md, RESPONSE_DESIGN.md, DATA.md, PLUGIN_GUIDE.md, STATUS.md
```

---

## 9. How to Install, Run, and Use It

### Prerequisites
* **Node.js 20 or newer** (required for running Vite, TypeScript, and Vitest).
* A modern WebGL2-capable browser (Chrome, Edge, Firefox, Safari).
* *(Optional)* **Python 3** with `pymupdf`, `pillow`, `numpy`, `scipy`, `matplotlib`, `scikit-image` only if you want to regenerate the site JSON dataset from `ePlan.pdf` via `tools/ingest-eplan/build_dataset.py`.

### Installation & Running Locally

All application commands are run from `LWM/safeity-twin/`:

```bash
cd LWM/safeity-twin

# 1. Install workspace dependencies
npm install

# 2. Start the development server (http://localhost:5173)
npm run dev
```

### Build, Test & Static Hosting

```bash
# Typecheck, run all 26 Vitest tests, and build production single-file HTML
npm run check

# Individual scripts:
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm test             # Runs all 6 Vitest suites
npm run validate     # Runs dataset & RERA tolerance tests (tests/twin.test.ts)
npm run build        # Outputs single-file apps/web/dist/index.html
npm run preview      # Serves production build at http://localhost:4173
```

> **Important Hosting Note:** Do **not** open `safeity-digital-twin.html` or `apps/web/dist/index.html` directly via `file://` in your browser—browsers restrict module/blob Web Workers on the `file://` protocol. Always serve the HTML file over any static HTTP server (e.g., `npm run preview`, `npx serve`, `python -m http.server`, or Nginx/S3/GitHub Pages).

---

### Controls & Keyboard Shortcuts

| Action | Control / Shortcut |
| :--- | :--- |
| **Overview (Orbit) mode** | Key **`1`** or Top Bar **Overview** · Left-drag to rotate, `Shift` + left-drag (or middle-drag) to pan, scroll wheel to zoom |
| **Fly mode** | Key **`2`** or Top Bar **Fly** · Left-drag to look, **`W A S D`** to fly, **`Q`** / **`E`** down/up, `Shift` faster, **`G`** toggle *Through walls* (ghost) vs. *Stop at walls* (solid) |
| **Walk mode (1.6 m eye height)** | Key **`3`**, Top Bar **Walk**, or **double-click** any room · Left-drag to look, **`W A S D`** to walk through doorways, **`PgUp` / `PgDn`** (or **`R` / `F`**) to change floors, `Shift` to run |
| **Reset camera to whole site** | Key **`H`** or Home icon in Top Bar (Top-down plan icon switches to aerial plan view) |
| **Toggle See-through (X-ray)** | Key **`X`** or Top Bar **See-through** |
| **Toggle Rooms (Interiors)** | Key **`I`** or Top Bar **Rooms** |
| **Floor Cutaway** | Top Bar dropdown (**All floors** → **Up to ground floor / floor 1–7**) |
| **Inspect room / building** | **Left-click** any building or room to open its Selection Card |
| **Trigger emergency anywhere** | **Right-click** (desktop) or **long-press** (touch/mobile) any room, building, or outdoor space |
| **Play / Pause simulation** | Key **`P`** or Top Bar Play/Pause icon · Switch speed **`1×` `5×` `10×` `30×` `60×`** · **`Alarm all`** sounds site-wide alarm |

---

### User Workflow Walkthrough

1. **Explore the Site (`Buildings` Tab & Viewing Controls):**
   * Open **Buildings** on the left dock and search (e.g., `R17-B`) to locate any wing across Rows, *Shops and flats* (`MU-E`, `MU-N`), or *Hotel*.
   * Click a building to fly to it and open its **Selection Card** (showing storeys, flats, typical occupancy, number of staircases, and buttons to **Walk in**, check **Ways out**, or **Start an incident**).
   * Turn on **See-through (`X`)** and **Rooms (`I`)**, or pick **Up to floor 2** to inspect individual flats, corridors, and stair cores inside.

2. **Start a Ready-Made or Custom Scenario (`Scenarios` Tab or Right-Click):**
   * **Quick start:** On the left **Scenarios** tab, click any of the 6 presets (e.g., *Two fires, one fire engine* or *Strong earthquake*), or click **Edit before running** to customize parameters.
   * **Custom incident:** Right-click a specific room (e.g., *R17-B · Floor 2 · Flat 203 · Living/dining*), pick **Fire**, adjust growth rate, door state (`Fire flat door left open`), sprinklers, alarm delay, occupancy profile (`Weekday night`, `Weekday day`, `Holiday peak`), wind, or random seed, and click **Start** (or **Add to setup** to compose multi-hazard timelines, or **Start it now** while a simulation is already running).

3. **Monitor Incidents & Command Split-Screen Rescues (`Incidents` Tab):**
   * Watch the right-hand **Incidents** tab populate with urgency-ranked emergencies (`critical` / `serious` / `minor`), people needing help, and heat/MW output.
   * Click any card to locate it on the 3D map, then press **Start rescue**.
   * The viewport automatically enters **Split Rescue View** (`Outside` + `Inside`), tracking the crew through `Drive` → `Set up` → `Go in` → `Find` → `Bring out` → `Hand over`. Watch the engine automatically use an aerial ladder to the balcony/window when corridor fire blocks the flat door, toggle **Auto speed** (`30×`/`5×`), **Swap** panes, or **Stop rescue**.

4. **Analyze Evacuation & Rescue Routes (`Evacuation` Tab):**
   * View live headcount (`out safely`, `still inside`, `waiting for rescue`, `hurt`), assembly point capacity bars (and closed-point alerts), and the *Buildings emptied* clearance table.
   * Switch between affected buildings and colour-coded floors to inspect **Best**, **Fastest**, **Safest**, **Other**, and **Don't use** exit routes with exact walking/queue durations, smoke dose, visibility, and risk scores. Hover any card to preview the route in 3D, or expand **How the crews get there** to inspect responder drive, staging, entry, and extraction legs.

5. **Track Live SOP Compliance & Crews (`Response` & `Log` Tabs):**
   * Open **Response** to watch the **Checklist** (Playbook) tick steps off automatically with timestamps (`done`, `late`, `missed`), review live **Crews** status, read **Advice** cards, and check **Why each crew was sent** (including runner-up comparisons).
   * Open **Log** for a timestamped, clickable event stream.

---

## 10. Extending the Simulator (Plugins, New Districts & Data Upgrades)

### Adding a New Hazard Plugin
All hazards implement the `HazardPlugin` interface from `packages/hazard-sdk/src/index.ts` (see `LWM/safeity-twin/docs/PLUGIN_GUIDE.md` for a full template):
1. Create a package under `packages/hazards/<id>` implementing `HazardPlugin` and `HazardInstance`.
2. In `step(dt, ctx)`, read/write consequences into `ctx.field` (`FieldStore`), use `ctx.rng` (never `Math.random`) for deterministic replay, call `ctx.activeWings.add(w)` for modified wings, and emit plain-language `ctx.emit(...)` events or cascading `ctx.spawn(...)` hazards.
3. Register the plugin with one line (`hazards.register(...)`) in `packages/sim-runtime/src/registry.ts` and add its workspace path to `package.json`, `tsconfig.json`, and `vitest.config.ts`.
4. The right-click **Context Menu** and **Simulation Window** parameter form automatically generate UI controls from `plugin.params`, and routing/evacuation/dispatch react automatically via `FieldStore`.

### Adding New Sites / Districts & Upgrading Data (`L1` → `L2` → `L3`)
Because all geometry, street networks, amenities, occupancy profiles, and responder specs live as schema-validated data inside `LWM/safeity-twin/data/sites/<site>/` (`site.json`, `typologies.json`, `buildings.json`, `streets.geojson`, `amenities.json`, `resources.json`, `occupancy.json`):
* **Upgrading Precision:** Replace L1 files with L2 sanctioned CAD or L3 as-built survey data, set `site.dataLevel` (`"L2"` or `"L3"`), and run `npm run validate` with zero application code changes.
* **Onboarding New Urban Districts:** Modeling new townships, shopping districts, malls, marketplaces, business districts, offices, and government campuses begins by authoring new datasets under `data/sites/<site>/` conforming to `@twin/twin-schema` (and scaling to tiled multi-district loading in future city milestones).

---

## 11. Accuracy, Calibration & Known Limits

* **L1 Geometry Tolerances (Current Township Dataset):** Building footprints, centres, and bearings were calibrated from `ePlan.pdf` (`~0.64 m/px`, cross-checked 4 ways against floor plans, the `32,000 sq ft` lagoon, `32`-acre site boundary, and `1,902` published unit count vs. `1,912` inferred units). Positions are accurate to within **±5 m**, bearings to **±2°**, and modelled flat carpet areas within **±15%** of RERA carpet area (`tests/twin.test.ts`). Coordinates are local ENU metres relative to The Blu lagoon centre (`geoAnchorHint` is a map pin, not a surveyed GCP).
* **Simplified Engineering Physics:**
  * Fire uses a real-time network zone model (hot layer, soot, door/window spread), **not** 3D CFD/FDS.
  * Structural seismic fragility medians are placeholders until calibrated against structural engineering drawings.
  * The NBC 2016 Part 4 rule pack (`data/sites/safeity-digital/rules/nbc-2016-part4.json`) is marked draft/unverified for consultant review.
  * Outdoor hazard zones grow wing footprints by guidance offsets rather than computing physical debris-throw ballistics; outdoor smoke plumes are a fixed `70 m`, `±18°` downwind sector.
* **Known Behavioral & UX Constraints:**
  * **Single-site scope today:** Only the Safeity Digital township dataset is currently bundled and loaded; city-wide district streaming and commercial/civic typology packs (malls, open markets, offices, government campuses) are upcoming roadmap work.
  * **Holiday-peak overflow:** Holiday-peak population exceeds the 5 assembly points' combined nominal capacity (`5,200`); the simulator distributes overflow and the Advisor flags the deficit.
  * **Walk mode floors:** Walk mode changes floors via `PgUp`/`PgDn` (`R`/`F`) rather than physically walking up 3D stair steps.
  * **Commanded rescue vs. crowd agents:** A household claimed by a manual **Start rescue** stays in place waiting for the crew even if a corridor later clears; animated rescue figures do not collide with background crowd capsules.
  * **Warden redirection:** The Routes tab indicates when evacuees should be redirected (`"most people go this way"`), though simulated warden agents do not yet actively redirect moving crowd agents in 3D.
