# Data

`data/sites/safeity-digital/` holds the whole site as plain JSON (types in `packages/twin-schema`):

| File | Contents |
| --- | --- |
| `site.json` | frame, calibration, cross-checks, tolerances, boundary and lagoon polygons, storey heights, hazard context (seismic zone III) |
| `typologies.json` | unit types (RERA carpet, balcony, bedrooms, persons) and building typologies as ordered segments along each side |
| `buildings.json` | 56 building records (52 residential wings, 2 mixed-use blocks, 2 hotel arms) with pose, storeys, flat floors, status, source |
| `streets.geojson` | 231 street centrelines with class, width and whether vehicles can use them |
| `amenities.json` | 5 assembly points with capacities, 2 gates (site entry and south gate) |
| `resources.json` | responders: base, on site or ETA, crew, speed, capabilities |
| `occupancy.json` | profiles (weekday night, weekday day, holiday peak) with occupancy, awake share, pre-movement |
| `rules/nbc-2016-part4.json` | rule pack used by the advisor (marked unverified) |

## How it was made (L1)

`tools/ingest-eplan/build_dataset.py` writes every file above from measurements of `ePlan.pdf`:

* The master plan was calibrated at about 0.64 m per image pixel and checked four independent ways
  (wing dimensions against floor plans, lagoon area against the published 32,000 sq ft, site area against the
  published 32 acres, unit count against the published total).
* Wing centres and bearings come from segmenting the master plan; typologies come from the floor-plan pages.
* Streets were extracted by skeletonising the paving, merging junctions and healing small gaps.
* Interiors are generated per typology from the published unit plans and sized to RERA carpet area
  (tests keep every flat within 15%).

## Upgrading to L2 or L3

Keep the schema, replace the values: sanctioned CAD (L2) or an as-built survey (L3) can feed the same files,
with interiors supplied as explicit rooms instead of templates. Set `site.dataLevel` accordingly; the UI shows
it. Run `npm run validate` after any change.

Positions are relative to the lagoon centre. `site.crs.geoAnchorHint` holds the developer's map pin, which is
not a survey point; tying the frame to UTM 43N needs at least three ground control points.
