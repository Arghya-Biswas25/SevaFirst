import { memo, useState } from 'react';
import { Icon } from '@twin/ui-kit';
import type { Incident, IncidentList, RescueOpView } from '@twin/dispatch';
import { fmtTime } from '../app/format';

const KIND_ICON: Record<Incident['kind'], string> = {
  fire: 'fire', collapse: 'collapse', damage: 'earthquake', lift: 'lift', casualty: 'medical', power: 'power',
};
export const STEPS = ['Drive', 'Set up', 'Go in', 'Find', 'Bring out', 'Hand over'];

function Steps({ step, done }: { step: number; done: boolean }) {
  return (
    <ol className="steps" aria-label="Rescue progress">
      {STEPS.map((s, i) => (
        <li key={s} className={done || i < step ? 'done' : i === step ? 'now' : ''} title={s} />
      ))}
    </ol>
  );
}

interface Props {
  list: IncidentList | null;
  ops: RescueOpView[];
  running: boolean;
  simT: number;
  watching: string | null;
  onStart: (i: Incident) => void;
  onWatch: (op: string) => void;
  onStop: (op: string) => void;
  onLocate: (i: Incident) => void;
}

/**
 * Every place where something is wrong right now, most urgent first, with a button to
 * send a crew. A rescue in progress shows where it is up to and can be watched.
 */
export const IncidentsPanel = memo(function IncidentsPanel(p: Props) {
  const [showResolved, setShowResolved] = useState(false);
  if (!p.running) {
    return (
      <div className="empty-state">
        <Icon name="bell" size={22} />
        <p><b>Nothing is happening yet.</b></p>
        <p>Pick a scenario on the left, or right-click a building and start a fire, a collapse or an earthquake. Every emergency shows up here.</p>
      </div>
    );
  }
  const items = p.list?.items ?? [];
  const active = items.filter((i) => i.active);
  const resolved = items.filter((i) => !i.active);
  const opOf = (i: Incident) => p.ops.find((o) => o.incident === i.id && !o.done) ?? null;
  const finished = p.ops.filter((o) => o.done);
  return (
    <div className="incidents">
      {active.length === 0 && (
        <div className="empty-state small">
          <Icon name="check" size={20} />
          <p>No emergencies right now.</p>
        </div>
      )}
      <ul className="inc-list">
        {active.map((i) => {
          const op = opOf(i);
          return (
            <li key={i.id} className={`inc ${i.severity}${op ? ' has-op' : ''}`}>
              <button className="inc-main" onClick={() => p.onLocate(i)} title="Show on the map">
                <span className={`inc-icon k-${i.kind}`}><Icon name={KIND_ICON[i.kind]} size={18} /></span>
                <span className="inc-text">
                  <span className="inc-title">{i.title}</span>
                  <span className="inc-place">{i.place}</span>
                  <span className="inc-detail">{i.detail} · {fmtTime(p.simT - i.since)} ago</span>
                </span>
                {i.people > 0 && <span className="inc-people"><b>{i.people}</b> {i.people === 1 ? 'person' : 'people'}<br />need help</span>}
              </button>
              {op ? (
                <div className="inc-op">
                  <div className="inc-op-top">
                    <span className="inc-unit"><Icon name={op.unitKind === 'technician' ? 'power' : 'truck'} size={14} /> {op.unitName}</span>
                    <span className="inc-count">{op.rescued} out{op.left ? ` · ${op.left} to go` : ''}</span>
                  </div>
                  <Steps step={op.step} done={op.done} />
                  <div className="inc-now">{op.text}</div>
                  <div className="inc-actions">
                    <button className="btn primary" onClick={() => p.onWatch(op.id)} disabled={p.watching === op.id}>
                      <Icon name="target" size={14} /> {p.watching === op.id ? 'Watching' : 'Watch'}
                    </button>
                    <button className="btn quiet" onClick={() => p.onStop(op.id)}>Stop</button>
                  </div>
                </div>
              ) : i.kind !== 'power' ? (
                <div className="inc-actions">
                  <button className="btn rescue" onClick={() => p.onStart(i)} disabled={!i.rescue.can}>
                    <Icon name="ladder" size={15} /> Start rescue
                  </button>
                  {i.rescue.reason && <span className="inc-why">{i.rescue.reason}</span>}
                </div>
              ) : (
                <div className="inc-actions"><span className="inc-why">{i.rescue.reason}</span></div>
              )}
            </li>
          );
        })}
      </ul>
      {finished.length > 0 && (
        <section className="inc-finished">
          <h3>Finished rescues</h3>
          <ul>
            {finished.map((o) => (
              <li key={o.id}>
                <Icon name="check" size={14} />
                <span><b>{o.place}</b> · {o.unitName} · {o.rescued} brought out</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {resolved.length > 0 && (
        <section className="inc-resolved">
          <button className="link" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
          </button>
          {showResolved && (
            <ul>
              {resolved.map((i) => (
                <li key={i.id}>
                  <Icon name={KIND_ICON[i.kind]} size={14} />
                  <span>{i.title}, {i.place}</span>
                  <em>ended {fmtTime(i.resolvedAt ?? 0)}</em>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
});
