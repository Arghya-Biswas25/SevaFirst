import json, math
W = json.load(open('wings_raw.json')); Rg = json.load(open('rings_raw.json'))
sp = json.load(open('special_polys.json')); site = json.load(open('site_poly.json'))
TYP = {
 'PR-C6': dict(name='Park Condo-6', upf=6, mix='6 x Manhattan Condo (1BHK, 351 sq ft carpet)', L=23.5, W=16.4, stairs=1, lifts=1, units=30),
 'PR-C8': dict(name='Condo-8', upf=8, mix='8 x Manhattan Condo / 1BHK (351 sq ft carpet)', L=31.0, W=16.5, stairs=1, lifts=1, units=40),
 'PR-X6': dict(name='Combo-6 (Row 18 ring)', upf=6, mix='2 x Royal Manhattan Suite (760) + 2 x Manhattan Suite (517) + 2 x Manhattan Condo (351)', L=37.5, W=18.8, stairs=2, lifts=1, units=30),
 'S-8':   dict(name='Suite / 2BHK-8', upf=8, mix='8 x Manhattan Suite or 2BHK Comfort (514 sq ft carpet)', L=54.5, W=15.8, stairs=2, lifts=1, units=40),
 'GR-4':  dict(name='Grand-4', upf=4, mix='4 x 3BHK Grand / Presidential Suite (972-1027 sq ft carpet)', L=37.0, W=21.5, stairs=2, lifts=1, units=20),
 'EC-8':  dict(name='Comfort-8', upf=8, mix='6 x 3BHK Comfort (738) + 2 x 2BHK Comfort (518)', L=59.0, W=19.0, stairs=2, lifts=1, units=40),
 'UNK-8': dict(name='Unconfirmed (violet on master plan)', upf=8, mix='not in brochure; assumed 8 units/floor', L=47.0, W=24.8, stairs=None, lifts=None, units=40),
}
launched = {('2','A'):('S-8',18),('2','B'):('PR-C8',19),('3','A'):('PR-C8',13),('3','B'):('PR-C8',14),('3','C'):('S-8',15),('3','D'):('GR-4','16-17'),
 ('10','A'):('PR-C8',26),('10','B'):('EC-8',27),('10','C'):('GR-4','28-29'),('11','-'):('EC-8',30),('12','A'):('EC-8',31),('12','B'):('GR-4','32-33'),
 ('13','-'):('S-8',34),('14','-'):('S-8',35),('15','-'):('S-8',36),('16','-'):('S-8',37),('17','A'):('PR-C6',8),('17','B'):('PR-C8',9),('17','C'):('PR-C6',10)}
for w in 'ABCDEFG': launched[('18',w)] = ('PR-X6', 11 if w in 'ADEF' else 12)
color_typ = {'indigo':'GR-4','yellow':'EC-8','blue2':'S-8','dgreen':'PR-C8','violet':'UNK-8'}
rows=[]
for r in W + Rg:
    key=(r['row'], r['wing'])
    if key in launched:
        t,pg = launched[key]; status='launched'; src=f'ePlan p{pg} floor plate'
    else:
        dom = r.get('colors',[['?']])[0][0]
        t = color_typ.get(dom,'UNK-8'); status='future'; src=f'inferred from master-plan colour ({dom})'
    T = TYP[t]
    E,N = float(r['E']), float(r['N'])
    rid = f"R{int(r['row']):02d}" + ('' if r['wing']=='-' else '-'+r['wing'])
    rows.append(dict(id=rid, row=int(r['row']), wing=r['wing'], typology=t, status=status, floors_residential=5, storeys='G+5',
        units_per_floor=T['upf'], units=T['units'], footprint_L_m=T['L'], footprint_W_m=T['W'], stairs=T['stairs'], lifts=T['lifts'],
        E_m=round(E,1), N_m=round(N,1), dist_from_blu_m=round(math.hypot(E,N),1), bearing_from_blu_deg=round(math.degrees(math.atan2(E,N))%360,1),
        axis_bearing_deg=float(r['axis_bearing']), source=src, measured_on_masterplan_m=[float(r['L_m']), float(r['W_m'])]))
rows.sort(key=lambda z:(z['row'], z['wing']))
# special buildings
mu = dict(id='MU', name='Mixed-Use Block', typology='MU-17', status='launched', storeys='G+7 (residential floors 2-7, 17 units/floor)', units=102,
          footprint='V-shaped, two arms ~50-55 m, envelope ~53 x 60 m, plate ~1,075 m2', polygon_partial=sp['mixed_use'], source='ePlan p20-21; master plan p2', E_m=155.3, N_m=-57.9)
ho = dict(id='HOTEL', name='Proposed Hotel / Service Apartments (Zone by The Park)', status='proposed', storeys='unknown', units=None,
          footprint='V-shaped, envelope ~77 x 77 m', polygon=sp['hotel'], source='master plan p2', E_m=219.3, N_m=-46.2)
tot_l = sum(r['units'] for r in rows if r['status']=='launched') + mu['units']
tot_f = sum(r['units'] for r in rows if r['status']=='future')
meta = dict(project='Safeity Digital (Provident Housing), Dabolim/Chicalim, South Goa', source_pdf='ePlan.pdf (Floor Plan Brochure, 40 pages)',
  crs='Local ENU metres; origin = centre of The Blu lagoon; +E east, +N north (north arrow on master plan assumed = grid north)',
  geo_anchor_hint=dict(lat=15.395749, lon=73.863315, note='project pin from developer brochure; not a surveyed point - replace with >=3 GCPs'),
  scale=dict(masterplan_m_per_image_px=0.64, masterplan_m_per_page_pt=round(0.64*1.3892,3), floorplan_calibration='1.5 m corridors, 230 mm walls, plate area vs RERA saleable area'),
  checks=dict(row18_wing_masterplan_m=[38.6,19.3], row18_wing_floorplan_m=[37.5,18.8], blu_lagoon_m2=3108, blu_published_sqft=32000, site_area_acres_measured=32.95, site_area_published_acres=32, units_inferred_total=tot_l+tot_f, units_published_total=1902),
  tolerance=dict(position_m=5, bearing_deg=2, footprint_pct=5), units_launched=tot_l, units_future_inferred=tot_f)
seed = dict(meta=meta, typologies=TYP, site_boundary=site, blu_lagoon=sp['lagoon'], buildings=rows, special_buildings=[mu,ho],
  pois=[dict(id='GATE-S', kind='main gate (security cabins)', E_m=6.5, N_m=-70.0), dict(id='POOL-DECK', kind='Blu deck / clubhouse frontage', E_m=4.4, N_m=-31.3),
        dict(id='UTIL-N', kind='small structure on perimeter (utility/security, unconfirmed)', E_m=-7.2, N_m=274.3), dict(id='UTIL-NE', kind='small structure (unconfirmed)', E_m=95.8, N_m=214.9),
        dict(id='UTIL-NW', kind='small structure (unconfirmed)', E_m=-185.6, N_m=212.6), dict(id='COURT-N', kind='red sports court (basketball/skating)', E_m=-93.5, N_m=248.3)])
json.dump(seed, open('adora_township_seed.json','w'), indent=1)
print('wings', len(rows), 'launched units', tot_l, 'future', tot_f, 'total', tot_l+tot_f)
for r in rows: print(r['id'], r['typology'], r['status'], r['units'], r['E_m'], r['N_m'], r['dist_from_blu_m'], r['bearing_from_blu_deg'], r['axis_bearing_deg'], r['measured_on_masterplan_m'])
