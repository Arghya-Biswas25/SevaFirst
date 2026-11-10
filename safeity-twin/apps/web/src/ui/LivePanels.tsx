import { memo, useState, type ReactNode } from 'react';
import { Icon } from '@twin/ui-kit';
import type { Snapshot } from '@twin/sim-runtime';
import type { SimEvent } from '@twin/hazard-sdk';
import type { PlaybookStep, PlaybookView } from '@twin/advisor';
import type { RescueOpView } from '@twin/dispatch';
import { ds } from '../app/core';
import { fmtEta, fmtInt, fmtTime } from '../app/format';

const KIND_ICON: Record<string, string> = { fire_tender: 'truck', ambulance: 'medical', rescue_team: 'collapse', security_team: 'people', warden_team: 'bell', technician: 'power' };
const unitName = (n: string) => n.replace(/\s*\(.*\)\s*$/, '');

function Block({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="block">
      <header><h3>{title}</h3>{right && <span className="block-right">{right}</span>}</header>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ response
const STEP_ICON: Record<PlaybookStep['status'], string> = { done: 'check', late: 'check', missed: 'close', skipped: 'minus', info: 'info', active: 'target', pending: 'target' };

function Checklist({ playbook }: { playbook: PlaybookView | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<string | null>(null);
  if (!playbook || !playbook.tracks.length) return <p className="muted">The checklist appears when an incident starts.</p>;
  return (
    <div className="checklist">
      {playbook.tracks.map((t) => (
        <div key={t.hazard} className="cl-track">
          {playbook.tracks.length > 1 && <h4>{t.label}</h4>}
          <p className="cl-plan">{t.strategy}</p>
          {t.phases.map((ph) => {
            const key = `${t.hazard}:${ph.id}`;
            const isOpen = open[key] ?? ph.status === 'active';
            const done = ph.steps.filter((s) => s.status === 'done' || s.status === 'late' || s.status === 'skipped' || s.status === 'info').length;
            return (
              <div key={ph.id} className={`cl-phase ${ph.status}`}>
                <button className="cl-phase-head" onClick={() => setOpen({ ...open, [key]: !isOpen })} aria-expanded={isOpen}>
                  <span className="cl-dot" />
                  <span className="cl-phase-title">{ph.title}</span>
                  <span className="cl-phase-count">{done}/{ph.steps.length}</span>
                </button>
                {isOpen && (
                  <ul>
                    {ph.steps.map((s) => {
                      const id = `${key}:${s.id}`;
                      return (
                        <li key={s.id} className={`cl-step ${s.status}`}>
                          <button onClick={() => setDetail(detail === id ? null : id)} aria-expanded={detail === id}>
                            <span className="cl-ico"><Icon name={STEP_ICON[s.status]} size={11} /></span>
                            <span className="cl-title">{s.title}</span>
                            <span className="cl-when">
                              {s.status === 'late' ? `late, ${fmtTime(s.at ?? 0)}` : s.status === 'missed' ? 'missed' : s.status === 'skipped' ? 'not needed' : s.at !== null && s.status === 'done' ? fmtTime(s.at) : ''}
                            </span>
                          </button>
                          {s.metric && s.status !== 'skipped' && <div className="cl-metric">{s.metric}</div>}
                          {detail === id && <div className="cl-detail">{s.detail} <em>{s.who}</em></div>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function unitStatus(r: Snapshot['resources'][number], a: Snapshot['assignments'][number] | undefined, op: RescueOpView | undefined): string {
  if (op) return `Rescue at ${op.place}`;
  if (r.status === 'offsite') return 'Off site';
  if (r.status === 'called') return `Called in${a ? `, ${fmtEta(a.eta_s)}` : ''}`;
  if (r.status === 'enroute') return `On the way${a ? `, ${fmtEta(a.eta_s)}` : ''}`;
  if (r.status === 'onscene') return 'On scene';
  return 'Ready';
}

export const ResponsePanel = memo(function ResponsePanel({ snap, playbook, onFocusWing }: { snap: Snapshot | null; playbook: PlaybookView | null; onFocusWing: (wing: number) => void }) {
  if (!snap) {
    return (
      <div className="empty-state">
        <Icon name="checklist" size={22} />
        <p>When an incident starts you'll see the response checklist here, what each crew is doing, and advice for the incident commander.</p>
      </div>
    );
  }
  const specs = new Map(ds.resources.resources.map((r) => [r.id, r]));
  const assigned = new Map(snap.assignments.map((a) => [a.resource, a]));
  const opByUnit = new Map(snap.ops.filter((o) => !o.done).map((o) => [o.unit, o]));
  const recs = [...snap.recommendations].sort((a, b) => a.priority - b.priority);
  return (
    <div className="panel">
      <Block title="Checklist">
        <Checklist playbook={playbook} />
      </Block>
      <Block title="Crews" right={`${snap.resources.filter((r) => r.status === 'onscene').length} on scene`}>
        <ul className="crews">
          {snap.resources.map((r) => {
            const a = assigned.get(r.id);
            const op = opByUnit.get(r.id);
            const job = op ? null : a?.taskLabel;
            return (
              <li key={r.id} className={`crew s-${op ? 'rescue' : r.status}`}>
                <Icon name={KIND_ICON[r.kind] ?? 'truck'} size={15} />
                <div>
                  <div className="crew-name">{unitName(specs.get(r.id)?.name ?? r.id)}</div>
                  <div className="crew-job">{unitStatus(r, a, op)}{job ? ` · ${job}` : ''}</div>
                  {a && !op && <div className="crew-why">{a.reason}</div>}
                </div>
              </li>
            );
          })}
        </ul>
        {snap.pending.length > 0 && (
          <div className="waiting-list">
            <h4>Still waiting for a crew</h4>
            <ul>
              {snap.pending.slice(0, 6).map((p) => <li key={p.task}><b>{p.label}</b> <span>{p.reason.split(' · ')[1] ?? p.reason}</span></li>)}
            </ul>
          </div>
        )}
      </Block>
      <Block title="Advice">
        {recs.length === 0 && <p className="muted">Nothing to flag right now.</p>}
        <ul className="advice">
          {recs.map((r) => (
            <li key={r.id} className={r.priority === 1 ? 'urgent' : ''}>
              <div className="adv-title">{r.priority === 1 && <span className="tag-urgent">Urgent</span>}{r.title}</div>
              <div className="adv-detail">{r.detail}</div>
            </li>
          ))}
        </ul>
      </Block>
      {snap.assignments.length > 0 && (
        <Block title="Why each crew was sent">
          <ul className="reasons">
            {snap.assignments.map((a) => (
              <li key={a.resource + a.task} onClick={() => { const m = a.taskLabel.match(/R\d+(-[A-Z])?|MU-[EW]/); const w = m ? ds.buildings.buildings.findIndex((b) => b.id === m[0]) : -1; if (w >= 0) onFocusWing(w); }}>
                <b>{unitName(a.resourceName)}</b> → {a.taskLabel}
                {a.runnerUp && <span className="muted"> (next best: {a.runnerUp.replace(/ \(\d+% of this score\)/, '')})</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
});

// ------------------------------------------------------------------ evacuation
export const EvacSummary = memo(function EvacSummary({ snap }: { snap: Snapshot }) {
  const e = snap.evac;
  const b = e.byStatus;
  const out = b.safe + b.rescued;
  const waiting = b.sheltering + b.trapped;
  return (
    <>
      <div className="numbers">
        <div className="num good"><b>{fmtInt(out)}</b><span>out safely</span></div>
        <div className="num"><b>{fmtInt(e.inside)}</b><span>still inside</span></div>
        <div className={`num${waiting ? ' warn' : ''}`}><b>{fmtInt(waiting)}</b><span>waiting for rescue</span></div>
        <div className={`num${b.casualty ? ' bad' : ''}`}><b>{fmtInt(b.casualty)}</b><span>hurt</span></div>
      </div>
      <Block title="Assembly points">
        <ul className="aps">
          {e.assembly.map((a) => {
            const pct = Math.min(100, (100 * (a.persons + a.inbound)) / Math.max(1, a.capacity));
            return (
              <li key={a.id} className={a.open ? '' : 'closed'}>
                <div className="ap-top">
                  <b>{a.name}</b>
                  <span>{a.open ? `${fmtInt(a.persons)} here${a.inbound ? `, ${fmtInt(a.inbound)} coming` : ''}` : 'Closed'}</span>
                </div>
                <div className="ap-bar"><i style={{ width: `${pct}%` }} className={pct > 95 ? 'full' : pct > 80 ? 'busy' : ''} /></div>
                {!a.open && <div className="ap-why">{a.reason}</div>}
              </li>
            );
          })}
        </ul>
      </Block>
    </>
  );
});

export const ClearanceTable = memo(function ClearanceTable({ snap }: { snap: Snapshot }) {
  const e = snap.evac;
  if (!e.wingClear.length) return null;
  return (
    <details className="clearance">
      <summary>Buildings emptied: {e.wingClear.filter((w) => w.clearedAt !== null).length} of {e.wingClear.length}</summary>
      <table>
        <thead><tr><th>Building</th><th>Alerted</th><th>Inside</th><th>Empty at</th></tr></thead>
        <tbody>
          {[...e.wingClear].sort((x, y) => y.inside - x.inside).slice(0, 40).map((w) => (
            <tr key={w.wing}><td>{w.wing}</td><td>{w.alerted}</td><td className={w.inside ? 'warn' : ''}>{w.inside}</td><td>{w.clearedAt !== null ? fmtTime(w.clearedAt) : '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </details>
  );
});

// ------------------------------------------------------------------ log
const TAG: Record<string, string> = {
  ignition: 'Fire', spread: 'Fire', flashover: 'Fire', extinguished: 'Fire out', burnout: 'Fire out', 'fire-out': 'Fire out', sprinkler: 'Sprinkler',
  assign: 'Crew sent', call: 'Called in', arrival: 'Arrived', onscene: 'On scene', standdown: 'Stood down', rescued: 'Rescued', transport: 'Hospital',
  'rescue-start': 'Rescue', 'rescue-done': 'Rescue', 'rescue-stopped': 'Rescue', 'rescue-error': 'Rescue',
  quake: 'Earthquake', damage: 'Damage', shaking: 'Shaking', 'shaking-stopped': 'Shaking', aftershock: 'Aftershock', collapse: 'Collapse', cordon: 'Cordon',
  trapped: 'Trapped', shelter: 'Sheltering', casualty: 'Injured', 'wing-clear': 'Building empty', 'assembly-full': 'Assembly point',
  power: 'Power', generators: 'Power', 'generators-failed': 'Power', 'power-restored': 'Power', lifts: 'Lifts', 'lift-freed': 'Lifts', welfare: 'Welfare',
  'stair-smoke': 'Smoke', 'corridor-untenable': 'Smoke', error: 'Note',
};

export const LogPanel = memo(function LogPanel({ events, onFocusWing }: { events: SimEvent[]; onFocusWing: (wing: number) => void }) {
  if (!events.length) {
    return (
      <div className="empty-state">
        <Icon name="log" size={22} />
        <p>Everything that happens is written down here as it happens.</p>
      </div>
    );
  }
  return (
    <ul className="log">
      {[...events].reverse().slice(0, 300).map((e, i) => (
        <li key={i} className={`lv-${e.level}${e.wing !== undefined ? ' clickable' : ''}`} onClick={() => e.wing !== undefined && onFocusWing(e.wing)}>
          <time>{fmtTime(e.t)}</time>
          <span className="tag">{TAG[e.type] ?? e.type.replace(/[-_]/g, ' ')}</span>
          <span className="txt">{e.text}</span>
        </li>
      ))}
    </ul>
  );
});
