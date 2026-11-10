/**
 * Live response playbook (docs/RESPONSE_DESIGN.md §5). For each active hazard type, the
 * standard procedure as phases → steps. Every step has a condition evaluated against
 * the live simulation; the first simulated time it is met is recorded, so the panel
 * reads like an incident log of what was done, when, and what is still open.
 */
import type { FieldStore } from '@twin/hazard-sdk';
import type { Twin } from '@twin/twin-data';

export type StepStatus = 'pending' | 'active' | 'done' | 'late' | 'missed' | 'skipped' | 'info';

export interface PlaybookStep {
  id: string;
  title: string;
  detail: string;
  who: string;
  status: StepStatus;
  /** simulated time the step was completed (or missed) */
  at: number | null;
  /** target, seconds after the hazard started */
  target?: number;
  metric?: string;
}

export interface PlaybookPhase {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'done';
  steps: PlaybookStep[];
}

export interface PlaybookTrack {
  hazard: string;
  label: string;
  strategy: string;
  startedAt: number;
  phases: PlaybookPhase[];
}

export interface PlaybookView {
  version: number;
  /** headline: the current phase of the first track */
  phase: string;
  tracks: PlaybookTrack[];
}

export interface PlaybookInput {
  t: number;
  twin: Twin;
  field: FieldStore;
  hazards: { type: string; params: Record<string, unknown>; t0: number; wing?: string; storey?: number }[];
  /** first simulated time each event type was emitted */
  firstSeen: Map<string, number>;
  evac: {
    persons: number;
    alerted: number;
    inside: number;
    byStatus: Record<string, number>;
    assembly: { id: string; open: boolean; persons: number; capacity: number }[];
  };
  needs: { sheltering: number; trapped: number; casualties: number };
  dispatch: { kind: string; status: string; taskKind: string | null; taskId: string | null }[];
  zones: { kind: string; label: string }[];
  plans: { wing: string; shelterFloors: number; floors: number; strategy: string }[];
}

/** info = guidance the model does not simulate (shown, never scored) */
type Res = { s: 'done' | 'missed' | 'open' | 'na' | 'info'; metric?: string };
interface Ctx extends PlaybookInput {
  t0: number;
  since: number;
  seen: (type: string) => number | null;
  out: number;
  moving: number;
  burning: number;
  onScene: (pred: (d: PlaybookInput['dispatch'][number]) => boolean) => boolean;
  assigned: (pred: (d: PlaybookInput['dispatch'][number]) => boolean) => boolean;
  /** has this ever been true (sticky flags per track) */
  ever: (key: string, now: boolean) => boolean;
  params: Record<string, unknown>;
  wing?: string;
}

interface StepDef {
  id: string;
  title: string;
  detail: string;
  who: string;
  target?: number;
  ev: (c: Ctx) => Res;
}
interface PhaseDef {
  id: string;
  title: string;
  steps: StepDef[];
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : '—');
const done = (metric?: string): Res => ({ s: 'done', metric });
const open = (metric?: string): Res => ({ s: 'open', metric });

/** Steps shared by several hazards. */
const S = {
  rescue: (title: string, detail: string, who = 'Rescue teams, fire service'): StepDef => ({
    id: 'rescue', title, detail, who,
    ev: (c) => {
      const n = c.needs.sheltering + c.needs.trapped;
      const had = c.ever('needed-rescue', n > 0);
      if (n > 0) return open(`${n} waiting · ${c.evac.byStatus.rescued ?? 0} brought out`);
      if (had) return done(`${c.evac.byStatus.rescued ?? 0} brought out`);
      return c.since > 600 ? { s: 'na', metric: 'nobody needed rescue' } : open('none waiting so far');
    },
  }),
  medical: (): StepDef => ({
    id: 'medical', title: 'Treat the injured and take them to hospital',
    detail: 'Set up START triage at the nearest open assembly point, keep one ambulance lane open, hand over to hospital.', who: 'Ambulance crews, first aiders',
    ev: (c) => {
      const n = c.needs.casualties;
      const had = c.ever('casualties', n > 0);
      if (n > 0) return open(`${n} casualties waiting`);
      if (had) return done('all casualties transported');
      return c.since > 900 ? { s: 'na', metric: 'no casualties' } : open('no casualties so far');
    },
  }),
  headcount: (): StepDef => ({
    id: 'headcount', title: 'Count everyone at the assembly points',
    detail: 'Wardens check names against the building lists and report anyone missing.', who: 'Wardens',
    ev: (c) => {
      const accounted = c.out;
      if (c.evac.alerted > 0 && c.evac.inside === 0) return done(`${accounted} accounted for`);
      return open(`${pct(accounted, c.evac.alerted)} of alerted accounted for`);
    },
  }),
};

const FIRE: PhaseDef[] = [
  {
    id: 'detect', title: 'Raise the alarm', steps: [
      { id: 'alarm', title: 'Raise the alarm in the building', detail: 'Press the nearest fire alarm or shout "Fire!" so every flat in the building leaves.', who: 'First person to notice', target: 180,
        ev: (c) => (c.evac.alerted > 0 ? done(`${c.evac.alerted} people alerted`) : open()) },
      { id: 'call', title: 'Call the fire brigade (101) and the security desk', detail: 'Give the building, floor and flat number. The desk sends the fire engine on site and calls for more help.', who: 'Security desk', target: 60,
        ev: (c) => (c.seen('assign') !== null || c.seen('call') !== null ? done() : open()) },
    ],
  },
  {
    id: 'evacuate', title: 'Get out and keep the fire in', steps: [
      { id: 'confine', title: 'Close the door of the fire flat behind you', detail: 'A closed door keeps smoke out of the corridor and stairs for 20 minutes or more.', who: 'Occupants of the fire flat',
        ev: (c) => (c.params.fireFlatDoorOpen === false ? done('door shut') : { s: 'missed', metric: 'door left open: smoke reaches the corridor' }) },
      { id: 'leave', title: 'Leave by the stairs, never the lift', detail: 'The fire floor and the floors above go first, by the stairs that are clear of smoke.', who: 'Residents, wardens',
        ev: (c) => {
          const p = c.plans.find((x) => x.wing === c.wing);
          const m = p ? `${p.floors - p.shelterFloors}/${p.floors} floors have a tenable route` : undefined;
          return c.moving + c.out > 0 ? done(m) : open(m);
        } },
      { id: 'shelter', title: 'If the way out is full of smoke, stay inside', detail: 'Shut the door, block the gaps with wet cloth, wave from the balcony and phone the desk with your flat number.', who: 'Residents',
        ev: (c) => {
          const p = c.plans.find((x) => x.wing === c.wing);
          if (p && p.shelterFloors > 0) return open(`${p.shelterFloors} floor${p.shelterFloors === 1 ? '' : 's'} must shelter`);
          return c.since > 300 ? { s: 'na', metric: 'every floor has a way out' } : open();
        } },
    ],
  },
  {
    id: 'attack', title: 'Fight the fire and rescue people', steps: [
      { id: 'first', title: 'Use an extinguisher while the fire is small', detail: 'Only if it is smaller than a waste bin and the exit is behind you. Otherwise close the door and leave.', who: 'Wardens, quick response team', target: 300,
        ev: (c) => (c.onScene((d) => d.taskId?.startsWith('first-') ?? false) ? done() : c.seen('flashover') !== null ? { s: 'missed', metric: 'room flashed over first' } : c.seen('fire-out') !== null ? { s: 'na', metric: 'fire out before a first attack' } : open()) },
      { id: 'tender', title: 'Fire engine arrives and attacks the fire', detail: 'Firefighters take a hose up the stairs nearest the fire and keep residents on the other stairs. Water is on the fire about 2 minutes after they arrive.', who: 'Fire service', target: 600,
        ev: (c) => (c.onScene((d) => d.kind === 'fire_tender' && d.taskKind === 'fire') ? done() : c.assigned((d) => d.kind === 'fire_tender' && d.taskKind === 'fire') ? open('tender on the way') : open('no tender assigned')) },
      S.rescue('Rescue people sheltering or trapped', 'Ladder or escort out the floors that could not leave, highest risk first (Routes tab → Rescue).'),
      S.medical(),
    ],
  },
  {
    id: 'recover', title: 'Recover', steps: [
      { id: 'out', title: 'Fire out, clear the smoke', detail: 'Open the vents at the top of the stairs and the corridor windows, and check the floors above.', who: 'Fire service',
        ev: (c) => (c.seen('fire-out') !== null ? done() : open(`${c.burning} rooms burning`)) },
      S.headcount(),
    ],
  },
];

const QUAKE: PhaseDef[] = [
  {
    id: 'shaking', title: 'While it shakes', steps: [
      { id: 'dch', title: 'Drop, cover and hold on', detail: 'Get under a sturdy table or against an inside wall, away from windows and balconies, until it stops. Do not run outside.', who: 'Everyone',
        ev: (c) => (c.seen('shaking-stopped') !== null ? done('shaking over') : open('shaking now')) },
      { id: 'lifts', title: 'Lifts stop at the nearest floor', detail: 'Never use a lift after an earthquake; they stay locked out until inspected.', who: 'Building systems',
        ev: (c) => (!c.field.liftsOn ? done('all lifts locked out') : open()) },
    ],
  },
  {
    id: 'getout', title: 'Get out to open ground', steps: [
      { id: 'leave', title: 'When it stops, walk out to open ground', detail: 'Take keys, phone, shoes and medicines; help neighbours who need it; do not stop on balconies or stairs.', who: 'Residents',
        ev: (c) => (c.moving + c.out > 0 ? done(`${pct(c.out, c.evac.persons)} out`) : open()) },
      { id: 'clear', title: 'Keep away from damaged buildings', detail: 'Stay outside the marked zones (up to one building height). Glass and parapets fall in aftershocks.', who: 'Wardens',
        ev: (c) => {
          const n = c.zones.filter((z) => z.kind === 'fall' || z.kind === 'collapse').length;
          const closed = c.evac.assembly.filter((a) => !a.open).length;
          return done(`${n} fall or collapse zones marked${closed ? ` · ${closed} assembly point${closed === 1 ? '' : 's'} closed` : ''}`);
        } },
      { id: 'gas', title: 'Turn off the gas and watch for fires', detail: 'Turn off LPG regulators on the way out; report the smell of gas; the first fires usually start in kitchens within minutes.', who: 'Residents, wardens',
        ev: (c) => {
          const fires = c.seen('ignition');
          if (c.burning > 0) return open(`${c.burning} rooms burning after the quake`);
          if (fires !== null) return done('post-quake fires out');
          return c.since > 900 ? done('no fires') : open('watching');
        } },
    ],
  },
  {
    id: 'assess', title: 'Check buildings and rescue', steps: [
      { id: 'survey', title: 'Mark each building safe, restricted or closed', detail: 'Closed: nobody goes in. Restricted: only with a crew. Safe: checked. Report collapses and trapped people.', who: 'Structural engineer, wardens',
        ev: (c) => {
          const d = [0, 0, 0, 0, 0];
          for (const w of c.twin.wings) if (!w.massingOnly) d[c.field.wingDamage[w.idx]]++;
          return c.seen('damage') !== null ? done(`${d[3] + d[4]} closed · ${d[2]} restricted · ${d[0] + d[1]} safe`) : open();
        } },
      { id: 'usar', title: 'Call the heavy rescue team for collapses', detail: 'They prop up and cut into collapsed floors, searching near the stairs first.', who: 'Incident commander',
        ev: (c) => {
          const collapses = c.seen('collapse') !== null;
          if (!collapses) return c.since > 120 ? { s: 'na', metric: 'no collapse' } : open();
          return c.assigned((d) => d.kind === 'rescue_team') || c.onScene((d) => d.kind === 'rescue_team') ? done() : open('USAR not yet assigned');
        } },
      S.rescue('Search and rescue: trapped people first, then those sheltering', 'Work from the most survivable voids; every hour lowers the survival rate of trapped people.'),
      S.medical(),
    ],
  },
  {
    id: 'stabilise', title: 'Afterwards', steps: [
      S.headcount(),
      { id: 'aftershock', title: 'Expect aftershocks, keep unsafe buildings closed', detail: 'Keep people at the assembly points; arrange shelter, water and toilets for a long stay.', who: 'Incident commander',
        ev: (c) => (c.seen('aftershock') !== null ? done('aftershock felt; unsafe buildings still closed') : c.params.aftershocks ? open('aftershocks expected') : { s: 'info', metric: 'no aftershocks in this scenario' }) },
    ],
  },
];

const COLLAPSE: PhaseDef[] = [
  {
    id: 'alarm', title: 'Alarm and keep back', steps: [
      { id: 'alarm', title: 'Sound the alarm here and next door', detail: 'Neighbours leave too: falling debris or a second collapse can reach them.', who: 'Security desk', target: 60,
        ev: (c) => (c.evac.alerted > 0 ? done(`${c.evac.alerted} alerted`) : open()) },
      { id: 'cordon', title: 'Keep everyone one building height away', detail: 'Only rescue teams go inside the cordon. Vehicles park outside it.', who: 'Quick response team',
        ev: (c) => (c.zones.some((z) => z.kind === 'collapse') ? done(c.zones.find((z) => z.kind === 'collapse')!.label) : open()) },
      { id: 'utilities', title: 'Cut the gas and power to the building', detail: 'Prevents fires and electrocution in the rubble.', who: 'Technician',
        ev: () => ({ s: 'info', metric: 'not simulated: confirm on the ground' }) },
    ],
  },
  {
    id: 'evacuate', title: 'Clear the neighbours', steps: [
      { id: 'leave', title: 'Neighbours leave away from the rubble', detail: 'The ways out avoid the cordon and blocked streets.', who: 'Residents, wardens',
        ev: (c) => (c.moving + c.out > 0 ? done(`${pct(c.out, c.evac.alerted)} of alerted out`) : open()) },
      { id: 'traffic', title: 'Keep traffic off blocked streets', detail: 'Hold one clear lane for ambulances; re-route by the ring road.', who: 'Quick response team',
        ev: (c) => (c.assigned((d) => d.taskKind === 'traffic') || c.onScene((d) => d.taskKind === 'traffic') ? done() : open()) },
    ],
  },
  {
    id: 'sar', title: 'Search and rescue', steps: [
      S.rescue('Free the people easiest to reach, then search the rubble', 'People lightly trapped or cut off come out first; the heavy rescue team props up and cuts into the rubble for those deeper in.'),
      S.medical(),
    ],
  },
  {
    id: 'stabilise', title: 'Afterwards', steps: [
      S.headcount(),
      { id: 'secondary', title: 'Watch for a second collapse', detail: 'A spotter watches the remaining structure; any movement means everyone out of the cordon.', who: 'Structural engineer',
        ev: () => ({ s: 'info', metric: 'not simulated: spotter on the ground' }) },
    ],
  },
];

const POWER: PhaseDef[] = [
  {
    id: 'assess', title: 'Assess', steps: [
      { id: 'lighting', title: 'Check the emergency lights and generators', detail: 'Generators should carry stair and corridor lighting within a minute.', who: 'Technician',
        ev: (c) => (c.seen('generators') !== null ? done('generators running') : c.seen('generators-failed') !== null ? { s: 'missed', metric: 'generators failed to start' } : open()) },
      { id: 'stay', title: 'Residents stay home', detail: 'Use torches, not candles; keep fridges shut; unplug appliances to avoid a surge when power returns.', who: 'Residents',
        ev: () => ({ s: 'info', metric: 'shelter in place' }) },
    ],
  },
  {
    id: 'rescue', title: 'Lifts and welfare', steps: [
      { id: 'lift', title: 'Get people out of stuck lifts', detail: 'Keep voice contact through the intercom; the technician lowers each car manually to the nearest floor.', who: 'Lift technician',
        ev: (c) => {
          const all = c.field.trappedLifts.length;
          const left = c.field.trappedLifts.filter((x) => !x.resolved).length;
          if (!all) return { s: 'na', metric: 'no occupied cars' };
          return left ? open(`${all - left}/${all} cars freed`) : done(`${all} cars freed`);
        } },
      { id: 'welfare', title: 'Check on elderly and unwell residents upstairs', detail: 'Elderly, disabled and people on oxygen or other powered medical devices first; arrange a move to a powered space if needed.', who: 'Wardens',
        ev: (c) => (c.seen('welfare') !== null ? done() : c.onScene((d) => d.taskKind === 'welfare') ? open('wardens on rounds') : c.assigned((d) => d.taskKind === 'welfare') ? open('wardens on the way') : open('waiting for a warden')) },
    ],
  },
  {
    id: 'restore', title: 'Restore', steps: [
      { id: 'restore', title: 'Bring the power back, test the lifts', detail: 'Switch loads back in stages; the technician releases each lift after a test run.', who: 'Technician, utility',
        ev: (c) => (c.seen('power-restored') !== null ? done() : open()) },
    ],
  },
];

const DEFS: Record<string, { label: string; phases: PhaseDef[]; strategy: (c: Ctx) => string }> = {
  fire: {
    label: 'Fire', phases: FIRE,
    strategy: (c) => {
      const p = c.plans.find((x) => x.wing === c.wing);
      return `Get everyone out of ${c.wing ?? 'the building'} by the stairs that are clear of smoke${p?.strategy ? ` (${p.strategy.toLowerCase()})` : ''}. Neighbours stay home unless smoke reaches them. Firefighters go up the stairs nearest the fire.`;
    },
  },
  earthquake: { label: 'Earthquake', phases: QUAKE, strategy: () => 'Drop, cover and hold on while it shakes. Then everyone goes to open ground, away from damaged buildings. Crews search collapsed buildings, and badly damaged ones stay closed.' },
  collapse: { label: 'Building collapse', phases: COLLAPSE, strategy: (c) => `Clear ${c.wing ?? 'the building'} and its neighbours, keep everyone well back from the rubble, free the people easiest to reach first, then search the rubble.` },
  power: { label: 'Power failure', phases: POWER, strategy: () => 'No one needs to leave. Free the people stuck in lifts, check on elderly and unwell residents upstairs, and bring the power back.' },
};

export class Playbook {
  view: PlaybookView = { version: 0, phase: '', tracks: [] };
  private doneAt = new Map<string, number>();
  private doneMetric = new Map<string, string | undefined>();
  private flags = new Set<string>();
  private sig = '';

  reset(): void {
    this.doneAt.clear();
    this.doneMetric.clear();
    this.flags.clear();
    this.sig = '';
    this.view = { version: this.view.version + 1, phase: '', tracks: [] };
  }

  update(inp: PlaybookInput): boolean {
    const tracks: PlaybookTrack[] = [];
    const seenTypes = new Set<string>();
    const out = (inp.evac.byStatus.safe ?? 0) + (inp.evac.byStatus.rescued ?? 0);
    const moving = (inp.evac.byStatus.moving ?? 0) + (inp.evac.byStatus.queued ?? 0);
    let burning = 0;
    for (let i = 0; i < inp.field.n; i++) if (inp.field.burn[i] === 1 || inp.field.burn[i] === 2) burning++;
    for (const h of inp.hazards) {
      if (seenTypes.has(h.type)) continue;
      seenTypes.add(h.type);
      const def = DEFS[h.type];
      if (!def) continue;
      const key = (s: string) => `${h.type}:${s}`;
      const c: Ctx = {
        ...inp, t0: h.t0, since: inp.t - h.t0, out, moving, burning, params: h.params, wing: h.wing,
        seen: (type) => {
          const v = inp.firstSeen.get(type);
          return v !== undefined && v >= h.t0 - 0.01 ? v : null;
        },
        onScene: (pred) => inp.dispatch.some((d) => d.status === 'onscene' && pred(d)),
        assigned: (pred) => inp.dispatch.some((d) => (d.status === 'enroute' || d.status === 'called') && pred(d)),
        ever: (k, now) => {
          if (now) this.flags.add(key(k));
          return this.flags.has(key(k));
        },
      };
      const phases: PlaybookPhase[] = [];
      let prevResolved = true;
      for (const ph of def.phases) {
        const steps: PlaybookStep[] = ph.steps.map((sd) => {
          const r = sd.ev(c);
          const k = key(`${ph.id}.${sd.id}`);
          let at = this.doneAt.get(k) ?? null;
          if ((r.s === 'done' || r.s === 'missed') && at === null) {
            at = inp.t;
            this.doneAt.set(k, at);
          }
          if (r.s === 'done' || r.s === 'missed') this.doneMetric.set(k, r.metric);
          let status: StepStatus = r.s === 'done' ? (sd.target !== undefined && at !== null && at - h.t0 > sd.target ? 'late' : 'done') : r.s === 'missed' ? 'missed' : r.s === 'na' ? 'skipped' : r.s === 'info' ? 'info' : 'pending';
          // a step that was done stays done (its metric may move on)
          let metric = r.metric;
          if (r.s === 'open' && this.doneAt.has(k) && sd.id !== 'rescue' && sd.id !== 'medical' && sd.id !== 'headcount') {
            status = sd.target !== undefined && at !== null && at - h.t0 > sd.target ? 'late' : 'done';
            metric = this.doneMetric.get(k);
          }
          return { id: sd.id, title: sd.title, detail: sd.detail, who: sd.who, status, at: status === 'pending' ? null : at, target: sd.target, metric };
        });
        const resolved = steps.every((s) => s.status !== 'pending');
        const anyResolved = steps.some((s) => s.status !== 'pending');
        const active = prevResolved || anyResolved;
        for (const s of steps) if (s.status === 'pending' && active) s.status = 'active';
        phases.push({ id: ph.id, title: ph.title, status: resolved ? 'done' : active ? 'active' : 'pending', steps });
        prevResolved = anyResolved;
      }
      tracks.push({ hazard: h.type, label: def.label, strategy: def.strategy(c), startedAt: h.t0, phases });
    }
    const first = tracks[0];
    const cur = first?.phases.find((p) => p.status === 'active') ?? first?.phases[first.phases.length - 1];
    const phase = first ? `${first.label}: ${cur?.title ?? ''}` : '';
    const sig = JSON.stringify(tracks.map((t) => [t.strategy, t.phases.map((p) => [p.status, p.steps.map((s) => [s.status, s.metric, s.at])])]));
    if (sig === this.sig) return false;
    this.sig = sig;
    this.view = { version: this.view.version + 1, phase, tracks };
    return true;
  }
}
