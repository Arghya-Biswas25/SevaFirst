"""Build data/sites/safeity-digital from the ePlan seed and the extracted street graph.

Usage:  python3 tools/ingest-eplan/build_dataset.py
Inputs: tools/ingest-eplan/adora_township_seed.json, tools/ingest-eplan/roads_raw.json
Output: data/sites/safeity-digital/*.json, streets.geojson

Every record keeps `source` and `confidence` so an L2 (sanctioned CAD) import can
replace it without code changes. All lengths in metres, bearings in degrees
clockwise from north, positions in the local ENU frame (origin = centre of The Blu).
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'data', 'sites', 'safeity-digital')
os.makedirs(os.path.join(OUT, 'rules'), exist_ok=True)

seed = json.load(open(os.path.join(HERE, 'adora_township_seed.json')))
roads = json.load(open(os.path.join(HERE, 'roads_raw.json')))

def w(name, obj):
    with open(os.path.join(OUT, name), 'w') as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)

# ---------------------------------------------------------------- site
site = {
    "id": "safeity-digital",
    "name": "Safeity Digital",
    "developer": "Provident Housing (Puravankara)",
    "location": "Chicalim-Dabolim, South Goa, India",
    "dataLevel": "L1",
    "crs": {
        "frame": "local ENU metres; origin = centre of The Blu lagoon; +E east, +N north",
        "geoAnchorHint": seed["meta"]["geo_anchor_hint"],
        "utm": "EPSG:32643",
    },
    "calibration": seed["meta"]["scale"],
    "checks": seed["meta"]["checks"],
    "tolerance": seed["meta"]["tolerance"],
    "boundary": seed["site_boundary"],
    "lagoon": seed["blu_lagoon"],
    "storeyHeight_m": 3.0,
    "groundStoreyHeight_m": 3.0,
    "parapet_m": 1.0,
    "hazardContext": {
        "seismicZone": "III", "zoneFactorZ": 0.16,
        "cycloneSeason": "May-June and October-November (Arabian Sea)",
        "airportDistance_km": 3.5,
    },
    "source": "ePlan.pdf (floor plan brochure) calibrated; see PRD Section 2",
}
w('site.json', site)

# ---------------------------------------------------------------- typologies
# Side layouts: segments along the wing's long axis (local x from -L/2 to +L/2).
# N side = +y, S side = -y; a 1.5 m corridor runs along y = 0.
F = lambda unit, num, width: {"kind": "flat", "unit": unit, "num": num, "w": width}
ST = lambda sid, width: {"kind": "stair", "id": sid, "w": width}
LI = lambda lid, width: {"kind": "lift", "id": lid, "w": width}
SH = lambda width: {"kind": "shaft", "w": width}
LO = lambda width: {"kind": "lobby", "w": width}
TE = lambda width: {"kind": "terrace", "w": width}

units = {
    "MC":  {"name": "Manhattan Condo (1BHK)", "carpet_sqft": 351, "balcony_sqft": 35, "bedrooms": 1, "toilets": 1, "livingShare": 0.47, "personsNominal": 2},
    "1BHK": {"name": "1 BHK", "carpet_sqft": 351, "balcony_sqft": 35, "bedrooms": 1, "toilets": 1, "livingShare": 0.47, "personsNominal": 2},
    "MS":  {"name": "Manhattan Suite (2BHK)", "carpet_sqft": 517, "balcony_sqft": 66, "bedrooms": 2, "toilets": 2, "livingShare": 0.40, "personsNominal": 3},
    "2BC": {"name": "2 BHK Comfort", "carpet_sqft": 514, "balcony_sqft": 60, "bedrooms": 2, "toilets": 2, "livingShare": 0.40, "personsNominal": 3},
    "RMS": {"name": "Royal Manhattan Suite (3BHK)", "carpet_sqft": 760, "balcony_sqft": 62, "bedrooms": 3, "toilets": 2, "livingShare": 0.34, "personsNominal": 4},
    "3BC": {"name": "3 BHK Comfort", "carpet_sqft": 738, "balcony_sqft": 94, "bedrooms": 3, "toilets": 2, "livingShare": 0.34, "personsNominal": 4},
    "2BS": {"name": "2 BHK Comfort (in 3BHK row)", "carpet_sqft": 518, "balcony_sqft": 63, "bedrooms": 2, "toilets": 2, "livingShare": 0.40, "personsNominal": 3},
    "GR":  {"name": "3 BHK Grand / Presidential Suite", "carpet_sqft": 976, "balcony_sqft": 115, "bedrooms": 3, "toilets": 3, "livingShare": 0.32, "personsNominal": 5},
}

def typ(code, name, L, W, north, south, pages, stairs, lifts, upf, flatFloors=(1, 2, 3, 4, 5), storeys=6, commercialFloors=()):
    for side in (north, south):
        tot = sum(s["w"] for s in side)
        assert abs(tot - L) < 0.05, f"{code}: side sums to {tot} not {L}"
    return {"code": code, "name": name, "L_m": L, "W_m": W, "corridor_m": 1.5,
            "storeys": storeys, "flatFloors": list(flatFloors), "commercialFloors": list(commercialFloors),
            "flatsPerFloor": upf, "stairs": stairs, "lifts": lifts, "liftCapacity_persons": 13,
            "sides": {"N": north, "S": south}, "source": pages, "confidence": "L1-parametric"}

T = {}
T["PR-C6"] = typ("PR-C6", "Park Condo-6", 23.5, 16.4,
    [F("MC", "02", 6.6), ST("S1", 3.4), F("MC", "03", 6.6), F("MC", "04", 6.9)],
    [F("MC", "01", 6.6), LI("L1", 3.4), F("MC", "06", 6.6), F("MC", "05", 6.9)], "ePlan p8, p10", 1, 1, 6)
T["PR-C8"] = typ("PR-C8", "Condo-8", 31.0, 16.5,
    [F("MC", "03", 6.9), F("MC", "04", 6.9), ST("S1", 3.4), F("MC", "05", 6.9), F("MC", "06", 6.9)],
    [F("MC", "02", 6.9), F("MC", "01", 6.9), LI("L1", 3.4), F("MC", "08", 6.9), F("MC", "07", 6.9)], "ePlan p9, p13, p14, p19, p26", 1, 1, 8)
T["PR-X6"] = typ("PR-X6", "Combo-6 (Row 18 ring)", 37.5, 18.8,
    [F("MS", "02", 10.3), F("MC", "03", 6.8), SH(3.3), F("MC", "04", 6.8), F("MS", "05", 10.3)],
    [F("RMS", "01", 13.95), ST("S1", 3.4), LI("L1", 2.8), ST("S2", 3.4), F("RMS", "06", 13.95)], "ePlan p11-12", 2, 1, 6)
T["S-8"] = typ("S-8", "Suite / 2BHK-8", 54.5, 15.8,
    [F("2BC", "06", 12.025), F("2BC", "07", 12.025), SH(3.0), F("2BC", "08", 12.025), LI("L1", 3.4), F("2BC", "01", 12.025)],
    [F("2BC", "05", 11.175), ST("S1", 3.4), F("2BC", "04", 11.175), SH(3.0), F("2BC", "03", 11.175), ST("S2", 3.4), F("2BC", "02", 11.175)],
    "ePlan p15, p18, p34-37", 2, 1, 8)
T["GR-4"] = typ("GR-4", "Grand-4", 37.0, 21.5,
    [F("GR", "02", 15.2), ST("S1", 3.3), LI("L1", 3.3), F("GR", "03", 15.2)],
    [F("GR", "01", 15.2), ST("S2", 3.3), LO(3.3), F("GR", "04", 15.2)], "ePlan p16-17, p28-29, p32-33", 2, 1, 4)
T["EC-8"] = typ("EC-8", "Comfort-8", 59.0, 19.0,
    [F("3BC", "06", 13.0), F("3BC", "07", 13.0), ST("S1", 3.5), F("3BC", "08", 13.0), SH(3.5), F("3BC", "01", 13.0)],
    [F("3BC", "05", 13.0), SH(3.0), F("2BS", "04", 10.0), LI("L1", 3.5), F("2BS", "03", 10.0), ST("S2", 3.5), SH(3.0), F("3BC", "02", 13.0)],
    "ePlan p27, p30, p31", 2, 1, 8)
T["UNK-8"] = typ("UNK-8", "Unconfirmed (violet on master plan)", 47.0, 18.0,
    [F("MS", "06", 11.0), F("MS", "07", 11.0), ST("S1", 3.0), F("MS", "08", 11.0), F("MS", "01", 11.0)],
    [F("MS", "05", 11.0), F("MS", "04", 11.0), LI("L1", 3.0), F("MS", "03", 11.0), F("MS", "02", 11.0)], "master plan colour only", 1, 1, 8)
T["UNK-8"]["confidence"] = "assumed"
T["MU-E"] = typ("MU-E", "Mixed-use block, ESE arm", 52.0, 14.0,
    [LI("L1", 4.0), F("MS", "01", 9.0), F("MS", "02", 9.0), F("MS", "03", 9.0), TE(17.0), ST("S2", 4.0)],
    [ST("S1", 4.0), F("MC", "09", 6.5), F("MS", "08", 8.5), F("MC", "07", 6.5), F("MC", "06", 6.5), F("MC", "05", 6.5), F("MC", "04", 6.5), TE(7.0)],
    "ePlan p20-21", 2, 1, 9, flatFloors=(2, 3, 4, 5, 6, 7), storeys=8, commercialFloors=(0, 1))
T["MU-N"] = typ("MU-N", "Mixed-use block, NNE arm", 46.0, 14.0,
    [F("MC", "10", 6.5), F("MC", "11", 6.5), F("MC", "12", 6.5), F("MC", "13", 6.5), F("MC", "14", 6.5), F("MC", "15", 6.5), ST("S3", 7.0)],
    [LO(10.0), F("MS", "17", 9.0), F("MS", "16", 9.0), TE(18.0)],
    "ePlan p20-21", 1, 0, 8, flatFloors=(2, 3, 4, 5, 6, 7), storeys=8, commercialFloors=(0, 1))
T["HOTEL"] = {"code": "HOTEL", "name": "Proposed hotel / service apartments (massing only)", "L_m": 70.0, "W_m": 14.0,
              "corridor_m": 1.5, "storeys": 5, "flatFloors": [], "commercialFloors": [], "flatsPerFloor": 0,
              "stairs": 2, "lifts": 2, "liftCapacity_persons": 13, "sides": {"N": [TE(70.0)], "S": [TE(70.0)]},
              "massingOnly": True, "source": "master plan p2", "confidence": "assumed (no plans; storeys unknown)"}
w('typologies.json', {"units": units, "typologies": T})

# ---------------------------------------------------------------- buildings
B = []
for b in seed["buildings"]:
    B.append({
        "id": b["id"], "row": b["row"], "wing": b["wing"], "typology": b["typology"], "status": b["status"],
        "pose": {"E": b["E_m"], "N": b["N_m"], "bearing": b["axis_bearing_deg"]},
        "storeys": 6, "flatFloors": [1, 2, 3, 4, 5],
        "source": b["source"], "confidence": "L1" if b["status"] == "launched" else "L1-inferred",
    })
# Mixed-use arms and hotel arms (read from the master plan at 1 px = 0.64 m)
B.append({"id": "MU-E", "row": 0, "wing": "E", "typology": "MU-E", "status": "launched",
          "pose": {"E": 161.0, "N": -69.0, "bearing": 109.2}, "storeys": 8, "flatFloors": [2, 3, 4, 5, 6, 7],
          "source": "ePlan p2, p20-21", "confidence": "L1-approx"})
B.append({"id": "MU-N", "row": 0, "wing": "N", "typology": "MU-N", "status": "launched",
          "pose": {"E": 144.0, "N": -46.0, "bearing": 20.0}, "storeys": 8, "flatFloors": [2, 3, 4, 5, 6, 7],
          "source": "ePlan p2, p20-21", "confidence": "L1-approx"})
B.append({"id": "HOTEL-W", "row": 0, "wing": "W", "typology": "HOTEL", "status": "proposed",
          "pose": {"E": 193.5, "N": -49.0, "bearing": 145.3}, "storeys": 5, "flatFloors": [],
          "lengthOverride_m": 75.0, "source": "master plan p2", "confidence": "assumed"})
B.append({"id": "HOTEL-E", "row": 0, "wing": "E", "typology": "HOTEL", "status": "proposed",
          "pose": {"E": 242.5, "N": -58.5, "bearing": 43.8}, "storeys": 5, "flatFloors": [],
          "lengthOverride_m": 65.0, "source": "master plan p2", "confidence": "assumed"})
w('buildings.json', {"buildings": B})

# ---------------------------------------------------------------- streets
bnd = seed["site_boundary"]
def dist_to_boundary(p):
    best = 1e9
    for i in range(len(bnd)):
        a, b = bnd[i], bnd[(i + 1) % len(bnd)]
        ax, ay, bx, by = a[0], a[1], b[0], b[1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1
        t = max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(p[0] - qx, p[1] - qy))
    return best
# merge skeleton junction clusters: nodes closer than 4.5 m become one node
nodes = [list(n) for n in roads["nodes"]]
parent = list(range(len(nodes)))
def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i
for i in range(len(nodes)):
    for j in range(i + 1, len(nodes)):
        if math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]) < 4.5:
            parent[find(i)] = find(j)
for e in roads["edges"]:  # very short edges also collapse their endpoints
    if e["length_m"] < 4.5:
        parent[find(e["a"])] = find(e["b"])
groups = {}
for i in range(len(nodes)):
    groups.setdefault(find(i), []).append(i)
new_id = {}
merged = []
for root, members in groups.items():
    cx = sum(nodes[m][0] for m in members) / len(members)
    cy = sum(nodes[m][1] for m in members) / len(members)
    for m in members:
        new_id[m] = len(merged)
    merged.append([round(cx, 1), round(cy, 1)])
edges2 = []
seen_pairs = set()
for e in roads["edges"]:
    a, b = new_id[e["a"]], new_id[e["b"]]
    if a == b:
        continue
    key = (min(a, b), max(a, b), round(e["length_m"]))
    if key in seen_pairs:
        continue
    seen_pairs.add(key)
    pts = [list(p) for p in e["pts"]]
    pts[0] = merged[a]
    pts[-1] = merged[b]
    edges2.append({**e, "a": a, "b": b, "pts": pts})
roads = {"nodes": merged, "edges": edges2}

# heal small gaps left by the skeleton: connect stray components to the main network
def components(edges, n, ok):
    adj = [[] for _ in range(n)]
    for e in edges:
        if ok(e):
            adj[e["a"]].append(e["b"]); adj[e["b"]].append(e["a"])
    comp = [-1] * n
    c = 0
    for s0 in range(n):
        if comp[s0] >= 0 or not adj[s0]:
            continue
        stack = [s0]; comp[s0] = c
        while stack:
            u = stack.pop()
            for v in adj[u]:
                if comp[v] < 0:
                    comp[v] = c; stack.append(v)
        c += 1
    return comp
def is_vehicle(e):
    return e.get("healed") or (max(math.hypot(*p) for p in e["pts"]) >= 47 and e["width_m"] >= 5.0)
healed = 0
for _ in range(30):
    comp = components(roads["edges"], len(roads["nodes"]), is_vehicle)
    sizes = {}
    for cc in comp:
        if cc >= 0: sizes[cc] = sizes.get(cc, 0) + 1
    if len(sizes) <= 1: break
    main = max(sizes, key=sizes.get)
    best = None
    for cid, sz in sizes.items():
        if cid == main: continue
        for i, ci in enumerate(comp):
            if ci != cid: continue
            for j, cj in enumerate(comp):
                if cj != main: continue
                d = math.hypot(roads["nodes"][i][0] - roads["nodes"][j][0], roads["nodes"][i][1] - roads["nodes"][j][1])
                if best is None or d < best[0]: best = (d, i, j)
    if best is None or best[0] > 25: break
    d, i, j = best
    roads["edges"].append({"a": i, "b": j, "pts": [roads["nodes"][i], roads["nodes"][j]], "width_m": 6.0, "length_m": round(d, 1), "healed": True})
    healed += 1
print("healed gaps", healed)

features = []
for i, e in enumerate(roads["edges"]):
    pts = e["pts"]
    near_b = sum(dist_to_boundary(p) < 14 for p in pts) / len(pts)
    rmax = max(math.hypot(*p) for p in pts)
    if rmax < 47:
        cls = "promenade"
    elif near_b > 0.6:
        cls = "perimeter"
    else:
        cls = "street"
    width = e["width_m"] if cls != "perimeter" else max(9.0, min(e["width_m"], 11.0))
    features.append({"type": "Feature", "id": f"S{i:03d}",
        "properties": {"from": e["a"], "to": e["b"], "class": cls, "width_m": round(width, 1), "length_m": e["length_m"],
                       "vehicles": cls != "promenade" and (width >= 5.0 or bool(e.get("healed"))), "narrow": width < 6.0, "healed": bool(e.get("healed")), "parkingBothSides": cls == "street" and width >= 9,
                       "source": "skeleton of master-plan paving", "confidence": "L1-extracted"},
        "geometry": {"type": "LineString", "coordinates": pts}})
streets = {"type": "FeatureCollection", "name": "streets", "crs": "local ENU metres",
           "nodes": roads["nodes"], "features": features}
w('streets.geojson', streets)

# ---------------------------------------------------------------- amenities, gates, assembly points
amen = {
    "assemblyPoints": [
        {"id": "AP-S", "name": "Forecourt south of The Blu", "E": 5.6, "N": -56.0, "capacity": 900, "shelter": False},
        {"id": "AP-W", "name": "West lawn (south-west corner)", "E": -195.0, "N": 15.0, "capacity": 2500, "shelter": False},
        {"id": "AP-NW", "name": "Tennis court", "E": -151.0, "N": 134.0, "capacity": 600, "shelter": False},
        {"id": "AP-N", "name": "Sports court by the amphitheatre", "E": -93.5, "N": 248.0, "capacity": 500, "shelter": False},
        {"id": "AP-E", "name": "East green by the ring road", "E": 136.0, "N": 46.0, "capacity": 700, "shelter": False},
    ],
    "gates": [
        {"id": "ENTRY-SW", "name": "Site entry (south-west approach road)", "E": -258.0, "N": -114.0, "vehicles": True, "external": True},
        {"id": "GATE-S", "name": "South forecourt gate", "E": 6.5, "N": -70.0, "vehicles": True, "external": False},
    ],
    "features": [
        {"id": "BLU", "name": "The Blu lagoon", "kind": "water", "E": 0, "N": 0, "area_m2": 3108},
        {"id": "DECK", "name": "Blu deck / clubhouse frontage", "kind": "amenity", "E": 4.4, "N": -31.3},
        {"id": "TENNIS", "name": "Tennis court", "kind": "court", "E": -151.0, "N": 134.0},
        {"id": "COURT-N", "name": "Red sports court", "kind": "court", "E": -93.5, "N": 248.3},
        {"id": "AMPHI", "name": "Amphitheatre steps", "kind": "amenity", "E": -101.0, "N": 279.0},
    ],
    "source": "read from ePlan master plan; positions approximate (L1)",
}
w('amenities.json', amen)

# ---------------------------------------------------------------- resources
res = {"resources": [
    {"id": "FT-1", "kind": "fire_tender", "name": "Fire tender 1 (standby at south gate)", "base": "GATE-S", "onSite": True, "eta_s": 0, "crew": 6, "water_l": 4500, "speed_ms": 5.5, "capabilities": ["fire_attack", "rescue_ladder", "water"]},
    {"id": "FT-2", "kind": "fire_tender", "name": "Fire tender 2 (mutual aid)", "base": "ENTRY-SW", "onSite": False, "eta_s": 1080, "crew": 6, "water_l": 4500, "speed_ms": 5.5, "capabilities": ["fire_attack", "water"]},
    {"id": "AMB-1", "kind": "ambulance", "name": "Ambulance 1", "base": "ENTRY-SW", "onSite": False, "eta_s": 720, "crew": 2, "patients": 2, "speed_ms": 6.0, "capabilities": ["casualty_transport", "triage"]},
    {"id": "AMB-2", "kind": "ambulance", "name": "Ambulance 2", "base": "ENTRY-SW", "onSite": False, "eta_s": 1200, "crew": 2, "patients": 2, "speed_ms": 6.0, "capabilities": ["casualty_transport", "triage"]},
    {"id": "USAR-1", "kind": "rescue_team", "name": "Urban search and rescue team", "base": "ENTRY-SW", "onSite": False, "eta_s": 1800, "crew": 10, "speed_ms": 5.0, "capabilities": ["search_rescue", "heavy_rescue"]},
    {"id": "QRT-1", "kind": "security_team", "name": "Township quick response team", "base": "GATE-S", "onSite": True, "eta_s": 0, "crew": 4, "speed_ms": 1.8, "foot": True, "capabilities": ["first_aid", "extinguisher", "traffic_control", "search"]},
    {"id": "WARDEN-W", "kind": "warden_team", "name": "Fire wardens, west rows", "base": "AP-W", "onSite": True, "eta_s": 0, "crew": 3, "speed_ms": 1.6, "foot": True, "capabilities": ["extinguisher", "search", "guidance"]},
    {"id": "WARDEN-E", "kind": "warden_team", "name": "Fire wardens, east rows", "base": "AP-E", "onSite": True, "eta_s": 0, "crew": 3, "speed_ms": 1.6, "foot": True, "capabilities": ["extinguisher", "search", "guidance"]},
    {"id": "LIFT-1", "kind": "technician", "name": "Lift technician", "base": "GATE-S", "onSite": True, "eta_s": 300, "crew": 1, "speed_ms": 1.5, "foot": True, "capabilities": ["lift_rescue", "power_isolation"]},
], "note": "Scenario defaults from PRD Section 10.3; replace with confirmed station travel times."}
w('resources.json', res)

# ---------------------------------------------------------------- occupancy
occ = {"profiles": {
    "weekday-night": {"label": "Weekday night (21:00-06:00)", "occupancyRate": 0.70, "personsFactor": 1.0, "awake": 0.35, "preMovement_s": {"median": 240, "sigma": 0.5}, "bluVisitors": 20},
    "weekday-day": {"label": "Weekday day", "occupancyRate": 0.55, "personsFactor": 0.7, "awake": 1.0, "preMovement_s": {"median": 90, "sigma": 0.45}, "bluVisitors": 150},
    "holiday-peak": {"label": "Holiday peak (Dec-Jan weekend)", "occupancyRate": 0.92, "personsFactor": 1.2, "awake": 0.9, "preMovement_s": {"median": 120, "sigma": 0.5}, "bluVisitors": 600},
}, "vulnerableShare": 0.08, "note": "Assumed; calibrate with society records and drills."}
w('occupancy.json', occ)

# ---------------------------------------------------------------- rules (to be verified clause by clause)
rules = {"pack": "nbc-2016-part4", "version": "0.1.0-draft", "status": "UNVERIFIED - placeholder values for review by a fire consultant",
  "rules": [
    {"id": "HIGHRISE", "clause": "NBC 2016 Part 4 (definitions)", "check": "building height >= 15 m => high-rise provisions", "threshold_m": 15},
    {"id": "TWO-STAIRS", "clause": "NBC 2016 Part 4 (means of egress)", "check": "high-rise residential should have at least two staircases", "minStairs": 2},
    {"id": "TENDER-DRIVEWAY", "clause": "NBC 2016 Part 4 (fire tender access)", "check": "clear driveway width for tender access", "minWidth_m": 6.0},
    {"id": "TENABILITY", "clause": "ISO 13571 / SFPE (design guidance)", "visibilityMin_m": 10, "temperatureMax_C": 60, "radiantMax_kWm2": 2.5},
    {"id": "NO-LIFTS", "clause": "standard fire / earthquake practice", "check": "lifts excluded from egress unless designated fire lifts"},
  ]}
w('rules/nbc-2016-part4.json', rules)

print('typologies', len(T), 'buildings', len(B), 'streets', len(features))
from collections import Counter
print(Counter(f['properties']['class'] for f in features))
