# Build status — Milestone 1

## Delivered

* **Twin:** 54 wings, 2 hotel arms (massing), 1,912 flats (992 launched), 20,838 rooms and spaces, 29,860
  openings, stairs and lifts, from L1 data. Exterior shells with windows, balconies, stilts and roof headrooms;
  interiors with coloured floors, walls with door openings, stair flights and lift cars.
* **Viewing:** orbit, hover (ghost or solid), walk with collisions and floor changes, X-ray, interiors, storey
  cut, hover read-out of any room, inspector with live conditions.
* **Right-click simulation:** fire, building collapse, earthquake and power failure, with forms generated from
  plugin parameters, multi-hazard scenarios, injection into a running simulation, run settings (occupancy,
  launched phases only, responders available, wind, seed). Nine roadmap hazards are listed and disabled.
* **Evacuation:** every household routed by convenience (smoke, heat, damage, congestion, door and stair
  capacity), capacity-aware assembly points, shelter-in-place when no tenable route exists.
* **Dispatch:** Hungarian assignment re-solved every 5 s with reasons, next-best alternatives, mutual aid
  call-in and stand-down, debris crossing on foot, and a list of tasks waiting for a unit.
* **Advice:** prioritised recommendations with the reason and source.
* **Engineering:** simulation in a Web Worker with an inline fallback, deterministic seeds, 15 tests.

## Verified

* PRD example "two fires, one tender": the on-site tender goes to R17-B first because 39 people above the
  fire floor depend on its only stair; mutual aid is called and later reassigned to R13.
* MCE earthquake, holiday peak: damage, blocked streets, post-quake gas fires, rescues; average step 7–10 ms.
* Production build renders in headless Chromium (software GL) at desktop and phone widths without horizontal
  overflow.

## Milestone 1.1 — response, evacuation and rescue routing

* **Routes per floor:** recommended, fastest and safest evacuation routes for every occupied floor of each affected
  wing, a route per stair, and the routes to avoid with the reason ("Corridor 4, floor 2 too hot: 76 °C"). Each
  shows time, queueing, distance, risk score, visibility and smoke dose. Floors with no tenable route are told to
  shelter in place, with instructions. Routes tab; hover a card to see it in 3D, click to fly to it.
* **Rescue routes:** for every responder on a task, the drive approach (zone-avoiding, with the faster direct route
  as the explained alternative), the staging point (outside hazard zones, upwind of fires), the entry path on foot
  naming the stair, and the extraction route.
* **Outdoor danger:** collapse cordons, fall zones, fire exposure, smoke plumes and debris drawn on the ground and
  used by the crowd, the planner and dispatch; assembly points inside a zone close and show why.
* **Playbook:** the standard procedure for fire, earthquake, collapse and power failure as phases and steps, ticked
  off live with the time each was done, late or missed (Plan tab). Strategy line per hazard. Incident HUD.
* **Hazards:** fire sprinklers (68 °C activation, NIST decay, no flashover); earthquake shaking phase with drop,
  cover and hold and building sway; collapse cordon event; power failure with generator failure, welfare checks
  for vulnerable residents and power-restored events.
* **Smoothness:** GPU interpolation of people, interpolated vehicles with beacons, GPU-animated flow and routes,
  React panels throttled to 4 Hz.
* **Tests:** 21 (6 new for zones, planner consistency, rescue plans, shaking, sprinklers, blackout welfare).

## Milestone 1.2 — incidents, watchable rescues, simpler UI

* **Incidents:** every place where something is wrong (a burning flat, a collapse, people stranded in a damaged
  building, injured people, a stuck lift, a power cut), most urgent first, with how many people need help and
  whether a crew is free. Resolved incidents are kept below.
* **Start rescue:** a commanded operation takes the best free crew (on site first), holds the household in place,
  and runs drive → set up → go in → find → bring out → hand over, household by household. It goes in by the
  stairs when the way to the flat door is passable, and by the aerial ladder (or a carried ladder up to three floors)
  to a window or balcony when fire, heat or collapse blocks it, repositioning the fire engine under the window.
  Paths go through real doorways and up the stair flights. Lift rescues release the car and lead people out.
* **Rescue view:** split screen. Outside: the building with the fire engine, the extending ladder and the crew;
  the floors above the crew are cut away while they are inside. Inside: a camera in the residents' room while they
  wait, then trailing the crew in and the residents out (side-on during ladder climbs), with smoke fog matching
  the visibility where they are. Progress strip, auto speed, swap and stop.
* **Interiors:** windows are openings with sills (parapets on balconies) instead of solid walls.
* **UI:** four right-hand tabs (Incidents, Evacuation, Response, Log); building details in a card over the map;
  sentence-case labels; plain wording in panels, checklist, advice, route notes and controls.
* **Tests:** 26 (5 new for incidents, ladder and stairs rescues, stopping, and lift release).

## Known limits

* L1 geometry: positions ±5 m, bearings ±2°, interiors generated from unit types rather than drawn plans.
* Fire is a zone model (hot layer, soot, door and window spread), not CFD. Structural fragility medians for the
  earthquake are placeholders until calibrated against the structural drawings. The NBC rule pack is unverified.
* Holiday-peak population exceeds the five assembly points' combined capacity; the model spreads the overflow
  and the advisor flags it.
* Walk mode changes floor with PgUp/PgDn rather than climbing the stair flights.
* No saved scenarios, sharing of runs, or multi-user sessions yet (PRD milestones 2–3).
* Frame rates were measured in Chromium on an integrated GPU (60 fps, MCE quake); check on the target hardware.
* Rescue figures are simple animated people, not crowd agents: other residents can pass through them.
* A household waiting for a commanded rescue stays put even if its way out clears; this is deliberate (they were
  told to wait) but differs from the automatic dispatcher, which lets people leave on their own.
* Residents follow the crowd model's convenience route; where the planner's recommended route is clearly better,
  the Routes tab says so ("wardens should redirect them"), but simulated wardens do not yet redirect people.
* Zones use the wing footprint grown by a distance; fall and collapse distances are guidance values, not a
  debris-throw model. Smoke plume outdoors is a fixed downwind sector.
