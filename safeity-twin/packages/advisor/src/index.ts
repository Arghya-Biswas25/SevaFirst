/**
 * @twin/advisor — ranked, explained recommendations (PRD Section 11).
 * Each rule reads the live state and returns actions with the reason and source.
 * Rules are plain functions so a rule pack can be extended without touching the
 * simulator; the counterfactual fork scoring of the PRD is a later addition.
 */
import type { FieldStore } from '@twin/hazard-sdk';
import { wingStoreyTemplate, type Twin } from '@twin/twin-data';

export * from './playbook';

export interface Recommendation {
  id: string;
  priority: 1 | 2 | 3;
  title: string;
  detail: string;
  reason: string;
  source: string;
}

export interface AdvisorInput {
  twin: Twin;
  field: FieldStore;
  t: number;
  evac: {
    needs(): { wing: number; sheltering: number; trapped: number; casualties: number }[];
    peopleInside(w: number): number;
    kpis(): { assembly: { id: string; name: string; persons: number; capacity: number }[] };
  };
  dispatch: { resources: { spec: { id: string; kind: string; name: string }; status: string }[]; tasks: { kind: string; wing: number }[] };
  hazards: string[];
}

export function recommend(inp: AdvisorInput): Recommendation[] {
  const { twin, field: f, evac, dispatch } = inp;
  const out: Recommendation[] = [];
  const burningWings = new Map<number, number>();
  for (const w of f.activeWings) {
    const wing = twin.wings[w];
    if (wing.massingOnly) continue;
    const start = wing.storeyOffsets[0];
    let low = 99;
    for (let i = start; i < start + wing.spaceCount; i++) if (f.burn[i] === 1 || f.burn[i] === 2) low = Math.min(low, twin.space.storey[i]);
    if (low < 99) burningWings.set(w, low);
  }
  // 1. single-stair wings with fire below occupied floors
  for (const [w, low] of burningWings) {
    const wing = twin.wings[w];
    if (wing.typology.stairs <= 1) {
      out.push({
        id: `single-stair-${wing.id}`, priority: 1, title: `Protect the only stair in ${wing.id}`,
        detail: `Keep the stair door on floor ${low} shut, send the first fire engine here and open the vent at the top of the stairs.`,
        reason: `${wing.id} (${wing.typology.code}) has one staircase; floors above ${low} have no alternative route.`,
        source: 'Twin topology + NBC 2016 Part 4 egress rule pack (unverified)',
      });
    }
  }
  // 2. stair choice per wing: which stairs are tenable on each floor
  for (const [w] of burningWings) {
    const wing = twin.wings[w];
    if (wing.typology.stairs < 2) continue;
    for (let s = 1; s < wing.storeys; s++) {
      const st = wingStoreyTemplate(wing, s);
      const vis = st.stairs.map((x) => ({ id: x.id, v: f.visibility(wing.storeyOffsets[s] + x.space) }));
      const bad = vis.filter((x) => x.v < 10);
      const good = vis.filter((x) => x.v >= 10);
      if (bad.length && good.length) {
        out.push({
          id: `stair-${wing.id}-${s}`, priority: 1, title: `Floor ${s} of ${wing.id}: use Stair ${good[0].id}`,
          detail: `Stair ${bad.map((b) => b.id).join(', ')} is full of smoke (you can see about ${Math.max(1, Math.round(bad[0].v))} m). Send residents to Stair ${good[0].id}.`,
          reason: 'The ways out avoid smoky stairs; wardens on the ground should say the same.',
          source: 'Fire zone model visibility (K = 3)',
        });
        break;
      }
    }
  }
  // 3. sheltering and trapped people
  for (const n of evac.needs()) {
    const wing = twin.wings[n.wing];
    if (n.sheltering > 0) {
      out.push({
        id: `shelter-${wing.id}`, priority: 1, title: `${n.sheltering} people waiting for rescue in ${wing.id}`,
        detail: 'Tell them to keep the flat door shut, block the gaps with wet cloth and wave from the balcony. Start a rescue from the Incidents tab.',
        reason: 'No tenable route exists from their flats right now.', source: 'Evacuation model',
      });
    }
    if (n.trapped > 0) {
      out.push({
        id: `trapped-${wing.id}`, priority: 1, title: `${n.trapped} people trapped in rubble at ${wing.id}`,
        detail: 'Keep everyone back from the rubble, stop traffic on blocked streets and call the heavy rescue team. Search near the stairs first.',
        reason: 'Collapsed spaces contain occupied flats.', source: 'Collapse model + population',
      });
    }
    if (n.casualties > 0) {
      out.push({ id: `casualties-${wing.id}`, priority: 2, title: `${n.casualties} injured at ${wing.id}`, detail: 'Set up a first-aid point at the nearest assembly point and keep one lane clear for ambulances.', reason: 'Smoke exposure dose reached incapacitation.', source: 'FED model' });
    }
  }
  // 4. resources versus demand
  const fireTasks = dispatch.tasks.filter((x) => x.kind === 'fire' && x.wing >= 0);
  const fireWings = new Set(fireTasks.map((x) => x.wing)).size;
  const tendersOnSite = dispatch.resources.filter((r) => r.spec.kind === 'fire_tender' && (r.status === 'standby' || r.status === 'enroute' || r.status === 'onscene')).length;
  if (fireWings > tendersOnSite) {
    out.push({
      id: 'mutual-aid', priority: 1, title: 'Call for more fire engines now',
      detail: `${fireWings} buildings on fire and ${tendersOnSite} fire engine${tendersOnSite === 1 ? '' : 's'} on site. Wardens hold the other fire with hose reels until help arrives.`,
      reason: 'Demand exceeds on-site supply.', source: 'Dispatch optimiser',
    });
  }
  // 5. debris and blocked streets
  const blocked = f.blockedStreet.reduce((a, b) => a + b, 0);
  if (blocked > 0) {
    out.push({ id: 'debris', priority: 2, title: `${blocked} street${blocked === 1 ? '' : 's'} blocked by rubble`, detail: 'Vehicles go round by the ring road. Put a marshal at each blocked junction.', reason: 'Debris footprints overlap the street graph.', source: 'Collapse model' });
  }
  if (!f.liftsOn) {
    out.push({ id: 'no-lifts', priority: 2, title: 'Do not use the lifts', detail: 'Announce it on every floor. Lifts stay off until they are checked.', reason: f.powerOn ? 'Seismic or fire lockout' : 'Power failure', source: 'Standard practice' });
  }
  if (f.trappedLifts.some((x) => !x.resolved)) {
    const n = f.trappedLifts.filter((x) => !x.resolved).reduce((a, x) => a + x.persons, 0);
    out.push({ id: 'lift-rescue', priority: 2, title: `${n} people stuck in lifts`, detail: 'Send the lift technician and keep talking to them over the lift intercom.', reason: 'Power failure stopped cars between floors.', source: 'Power plugin' });
  }
  // 6. assembly point capacity
  for (const ap of evac.kpis().assembly) {
    if (ap.persons > 0.8 * ap.capacity) out.push({ id: `ap-${ap.id}`, priority: 2, title: `${ap.name} at ${Math.round((100 * ap.persons) / ap.capacity)} % capacity`, detail: 'Redirect new arrivals to the next nearest assembly point.', reason: 'Crowding slows headcounts and blocks access lanes.', source: 'Evacuation model' });
  }
  if (inp.hazards.includes('earthquake')) {
    out.push({ id: 'quake-outdoors', priority: 1, title: 'Stay in open ground, away from buildings', detail: 'Keep clear of the marked danger zones (up to one building height around damaged buildings). Expect aftershocks.', reason: 'Falling facades and parapets during aftershocks.', source: 'Earthquake plugin' });
    const red = twin.wings.filter((w) => f.wingDamage[w.idx] >= 3).map((w) => w.id);
    if (red.length) out.push({ id: 'quake-reentry', priority: 2, title: `Nobody goes back into ${red.slice(0, 6).join(', ')}${red.length > 6 ? ` and ${red.length - 6} more` : ''}`, detail: 'Keep these buildings closed until a structural engineer inspects them.', reason: 'Extensive or complete damage state.', source: 'Fragility model (placeholder curves)' });
  }
  return out.sort((a, b) => a.priority - b.priority).slice(0, 8);
}
