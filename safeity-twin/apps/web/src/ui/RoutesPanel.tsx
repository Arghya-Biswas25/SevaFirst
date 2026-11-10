import { memo } from 'react';
import { Button, Chip, Empty, Icon } from '@twin/ui-kit';
import type { FloorPlan, PlanRoute, PlanSet, RescuePlan, RiskBand, RouteLabel } from '@twin/routing';
import { RESCUE_COLORS, ROUTE_COLORS } from '@twin/render';
import { ds, twin } from '../app/core';
import { fmtEta, fmtInt } from '../app/format';

const LABEL: Record<RouteLabel, string> = { recommended: 'Best', fastest: 'Fastest', safest: 'Safest', alternative: 'Other', avoid: "Don't use" };
const BAND_TONE: Record<RiskBand, 'good' | 'warn' | 'bad' | 'info'> = { low: 'good', moderate: 'info', high: 'warn', severe: 'bad' };
const KIND_ICON: Record<string, string> = { fire_tender: 'truck', ambulance: 'medical', rescue_team: 'collapse', security_team: 'people', warden_team: 'bell', technician: 'power' };
const apName = new Map(ds.amenities.assemblyPoints.map((a) => [a.id, a.name]));
const floorName = (s: number) => (s === 0 ? 'G' : String(s));

export const dur = (s: number) => {
  const v = Math.max(0, Math.round(s));
  return v < 60 ? `${v} s` : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')} min`;
};

interface Props {
  plans: PlanSet | null;
  running: boolean;
  wing: number | null;
  storey: number | null;
  highlight: string | null;
  /** building selected in the Inspector, offered for planning */
  selectedWing?: number;
  onWing: (w: number) => void;
  onStorey: (s: number) => void;
  onHighlight: (id: string | null, pts?: number[]) => void;
  onHover: (id: string | null) => void;
}

function floorTone(fp: FloorPlan): string {
  if (fp.advice === 'shelter') return 'shelter';
  const best = fp.routes.find((r) => r.id === fp.best);
  return best ? best.m.band : 'low';
}

function RouteCard({ r, on, onHighlight, onHover }: { r: PlanRoute; on: boolean; onHighlight: Props['onHighlight']; onHover: Props['onHover'] }) {
  const main = r.labels[0];
  const m = r.m;
  const avoid = main === 'avoid';
  return (
    <li className={`route-card ${main}${on ? ' on' : ''}`} style={{ ['--rc' as string]: ROUTE_COLORS[main] }}
      onMouseEnter={() => onHover(r.id)} onMouseLeave={() => onHover(null)} onClick={() => onHighlight(on ? null : r.id, r.pts)}>
      <div className="rc-top">
        {r.labels.map((l) => <span key={l} className={`rc-label ${l}`}>{l === 'safest' && <Icon name="shield" size={11} />}{l === 'fastest' && <Icon name="power" size={11} />}{l === 'recommended' && <Icon name="check" size={11} />}{LABEL[l]}</span>)}
        {r.current && <span className="rc-now" title="Most people on this floor are going this way">most people go this way</span>}
        {!avoid && <span className="rc-time">{dur(m.time_s)}</span>}
      </div>
      <div className="rc-via">{r.via}{r.goal && apName.get(r.goal) ? <span className="muted"> · {apName.get(r.goal)}</span> : null}</div>
      {!avoid && (
        <>
          <div className="rc-risk">
            <span>Risk</span>
            <div className="rc-bar"><i className={m.band} style={{ width: `${Math.max(3, m.risk)}%` }} /></div>
            <Chip tone={BAND_TONE[m.band]}>{m.risk} · {m.band}</Chip>
          </div>
          <dl className="rc-m">
            <div><dt>Walk</dt><dd>{dur(m.walk_s)}</dd></div>
            <div><dt>Queue</dt><dd>{dur(m.queue_s)}</dd></div>
            <div><dt>Distance</dt><dd>{fmtInt(m.dist_m)} m</dd></div>
            <div><dt>Stairs</dt><dd>{m.stairs} flight{m.stairs === 1 ? '' : 's'}</dd></div>
            <div><dt>Visibility</dt><dd className={m.minVis_m < 10 ? 'bad' : ''}>{m.minVis_m >= 300 ? 'clear' : `${m.minVis_m} m`}</dd></div>
            <div><dt>Smoke</dt><dd className={m.dose > 0.1 ? 'bad' : m.dose > 0.02 ? 'warn' : ''}>{m.dose > 0.02 ? `${Math.round(m.dose * 100)} % of harmful` : 'none'}</dd></div>
          </dl>
        </>
      )}
      {r.notes.length > 0 && <ul className="rc-notes">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </li>
  );
}

function RescueCard({ p, on, onHighlight, onHover }: { p: RescuePlan; on: boolean; onHighlight: Props['onHighlight']; onHover: Props['onHover'] }) {
  const pts = [...(p.approach?.pts ?? []), ...(p.entry?.pts ?? [])];
  return (
    <li className={`rescue-card${on ? ' on' : ''}`} onMouseEnter={() => onHover(p.id)} onMouseLeave={() => onHover(null)} onClick={() => onHighlight(on ? null : p.id, pts)}>
      <div className="rs-top">
        <Icon name={KIND_ICON[p.kind] ?? 'truck'} />
        <b>{p.unitName.replace(/\s*\(.*\)$/, '')}</b>
        <Chip tone={p.status === 'onscene' ? 'good' : p.status === 'called' ? 'warn' : 'info'}>{p.status === 'onscene' ? 'on scene' : p.status}</Chip>
      </div>
      <div className="rs-task">→ {p.taskLabel}{p.people ? ` · ${p.people} people` : ''}</div>
      <ol className="rs-legs">
        <li style={{ ['--lc' as string]: RESCUE_COLORS.approach }}>
          <b>Approach</b>
          <span>{p.approach ? `${p.approach.via} · ETA ${fmtEta(p.approach.time_s)}` : 'on scene'}</span>
          {p.approach?.alt && <em>{p.approach.alt}</em>}
        </li>
        <li style={{ ['--lc' as string]: '#94a3b8' }}>
          <b>Staging</b>
          <span>{p.staging.note}</span>
        </li>
        {p.entry && (
          <li style={{ ['--lc' as string]: RESCUE_COLORS.entry }}>
            <b>Entry</b>
            <span>{p.entry.via} · {dur(p.entry.time_s)} on foot</span>
            {p.entry.notes.map((n, i) => <em key={i}>{n}</em>)}
          </li>
        )}
        {p.extraction && (
          <li style={{ ['--lc' as string]: RESCUE_COLORS.extraction }}>
            <b>Extraction</b>
            <span>{p.extraction.via} · about {dur(p.extraction.time_s)}</span>
            {p.extraction.notes.map((n, i) => <em key={i}>{n}</em>)}
          </li>
        )}
      </ol>
    </li>
  );
}

/**
 * Routes tab: for a building and floor, the recommended, fastest and safest ways out,
 * the routes to avoid and why; and, for every responder, how it gets to the people
 * and brings them out. Hover a card to see it in 3D, click to fly to it.
 */
export const RoutesPanel = memo(function RoutesPanel(p: Props) {
  const { plans } = p;
  if (!p.running && !plans?.wings.length) {
    return <Empty icon="route">Once an incident starts, you'll see the ways out of each affected building, floor by floor.</Empty>;
  }
  const wings = plans?.wings ?? [];
  const wp = wings.find((w) => w.wing === p.wing) ?? wings[0];
  const storey = p.storey ?? wp?.critical ?? null;
  const fp = wp?.floors.find((f) => f.storey === storey) ?? wp?.floors.find((f) => f.storey === wp.critical);
  const selOffer = p.selectedWing !== undefined && !twin.wings[p.selectedWing].massingOnly && !wings.some((w) => w.wing === p.selectedWing) ? p.selectedWing : undefined;
  const rescues = plans?.rescues ?? [];
  return (
    <div className="routes">
      <div className="rt-wings">
        {wings.map((w) => {
          const shelter = w.floors.filter((f) => f.advice === 'shelter').length;
          return (
            <button key={w.wing} className={w.wing === wp?.wing ? 'on' : ''} onClick={() => p.onWing(w.wing)} title={w.why}>
              <b>{w.id}</b>
              {shelter > 0 && <em className="rt-shelter">{shelter} {shelter === 1 ? 'floor' : 'floors'} stuck</em>}
            </button>
          );
        })}
        {selOffer !== undefined && <Button small icon="plus" onClick={() => p.onWing(selOffer)}>Add {twin.wings[selOffer].id}</Button>}
      </div>
      {!wp && <p className="muted small">No building needs to be evacuated yet. Click a building on the map to check its ways out.</p>}
      {wp && (
        <>
          <div className="rt-strategy">
            <div className="rt-why">{wp.id} · {wp.why}</div>
            <div><Icon name="stairs" size={14} /> {wp.strategy}</div>
          </div>
          <div className="rt-floors" role="radiogroup" aria-label="Floor">
            {[...wp.floors].reverse().map((f) => (
              <button key={f.storey} role="radio" aria-checked={f === fp} className={`${floorTone(f)}${f === fp ? ' on' : ''}`} onClick={() => p.onStorey(f.storey)} title={f.summary}>
                <b>{floorName(f.storey)}</b>
                <span>{f.people ? `${f.people}p` : '—'}</span>
              </button>
            ))}
          </div>
          {fp && (
            <>
              <div className={`rt-advice ${fp.advice}`}>
                <Icon name={fp.advice === 'shelter' ? 'home' : 'route'} />
                <div>
                  <b>{fp.storey === 0 ? 'Ground floor' : `Floor ${floorName(fp.storey)}`}: {fp.advice === 'shelter' ? 'stay inside and wait for rescue' : 'get out'}</b>
                  <div>{fp.summary}</div>
                  <div className="muted small">{fp.people} {fp.people === 1 ? 'person' : 'people'} still on this floor</div>
                </div>
              </div>
              <ul className="route-cards">
                {fp.routes.map((r) => <RouteCard key={r.id} r={r} on={p.highlight === r.id} onHighlight={p.onHighlight} onHover={p.onHover} />)}
              </ul>
            </>
          )}
        </>
      )}
      {rescues.length > 0 && (
        <details className="crew-routes">
          <summary><Icon name="truck" size={14} /> How the crews get there ({rescues.length})</summary>
          <ul className="rescue-cards">
            {rescues.map((r) => <RescueCard key={r.id} p={r} on={p.highlight === r.id} onHighlight={p.onHighlight} onHover={p.onHover} />)}
          </ul>
        </details>
      )}
      <div className="rt-legend">
        {(['recommended', 'fastest', 'safest', 'avoid'] as RouteLabel[]).map((l) => <span key={l}><i style={{ background: ROUTE_COLORS[l] }} />{LABEL[l]}</span>)}
        <span><i style={{ background: RESCUE_COLORS.approach }} />Crew driving in</span>
        <span><i style={{ background: RESCUE_COLORS.entry }} />Crew going in</span>
        <span><i style={{ background: RESCUE_COLORS.extraction }} />Bringing people out</span>
      </div>
    </div>
  );
});
