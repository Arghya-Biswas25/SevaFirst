import { useMemo, useState } from 'react';
import { Icon, Toggle } from '@twin/ui-kit';
import type { HazardSpec } from '@twin/twin-schema';
import type { LayerName } from '@twin/render';
import { RESCUE_COLORS, ROUTE_COLORS, STATUS_COLORS } from '@twin/render';
import { TYPOLOGY_COLORS } from '@twin/geometry';
import { ds, hazards, HAZARD_ICONS, twin } from '../app/core';
import { PRESETS, type Preset } from '../app/scenarios';
import { fmtInt, fmtTime } from '../app/format';
import { wingPersons } from './Inspector';

export interface ViewState {
  xray: boolean;
  interiors: boolean;
  cut: number | null;
  layers: Record<LayerName, boolean>;
}

const LAYER_LABELS: [LayerName, string][] = [
  ['people', 'People'], ['flows', 'Which way people are walking'], ['routes', 'Planned routes'], ['vehicles', 'Fire engines and crews'],
  ['hazards', 'Fire and smoke'], ['zones', 'Danger zones'], ['assembly', 'Assembly points'], ['streets', 'Streets'], ['labels', 'Building names'],
];

export function ScenariosTab({ running, draft, onPreset, onLoadPreset, onRunDraft, onRemoveDraft, onClearDraft }: {
  running: boolean;
  draft: HazardSpec[];
  onPreset: (p: Preset) => void;
  onLoadPreset: (p: Preset) => void;
  onRunDraft: () => void;
  onRemoveDraft: (i: number) => void;
  onClearDraft: () => void;
}) {
  return (
    <div className="panel">
      <p className="intro">Pick a ready-made emergency, or right-click any building or room to start your own.</p>
      <ul className="presets">
        {PRESETS.map((p) => (
          <li key={p.id}>
            <button className="preset-main" onClick={() => onPreset(p)} title="Run this scenario">
              <span className={`preset-icon hz-${p.icon}`}><Icon name={p.icon} size={17} /></span>
              <span>
                <b>{p.title}</b>
                <span>{p.blurb}</span>
              </span>
              <Icon name="play" size={13} className="preset-go" />
            </button>
            <button className="link preset-edit" onClick={() => onLoadPreset(p)}>Edit before running</button>
          </li>
        ))}
      </ul>
      {draft.length > 0 && (
        <section className="block">
          <header><h3>Your setup</h3><span className="block-right">{draft.length} {draft.length === 1 ? 'incident' : 'incidents'}</span></header>
          <ul className="draft">
            {draft.map((d, i) => (
              <li key={i}>
                <Icon name={HAZARD_ICONS[d.type] ?? 'hazard'} className={`hz-${d.type}`} size={14} />
                <span>{hazards.get(d.type)?.label} · {d.origin.label ?? 'whole site'}</span>
                {d.t > 0 && <em>after {fmtTime(d.t)}</em>}
                <button className="icon-btn" onClick={() => onRemoveDraft(i)} aria-label="Remove"><Icon name="close" size={12} /></button>
              </li>
            ))}
          </ul>
          <div className="row-btns">
            <button className="btn primary" onClick={onRunDraft}><Icon name="play" size={13} /> {running ? 'Restart with this setup' : 'Run'}</button>
            <button className="btn quiet" onClick={onClearDraft}>Clear</button>
          </div>
        </section>
      )}
    </div>
  );
}

export function BuildingsTab({ selected, onPick }: { selected?: number; onPick: (wing: number) => void }) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const w of twin.wings) {
      const key = w.building.row ? `Row ${w.building.row}` : w.id.startsWith('MU') ? 'Shops and flats' : 'Hotel';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(w.idx);
    }
    return [...m.entries()];
  }, []);
  const ql = q.trim().toLowerCase();
  return (
    <div className="panel">
      <div className="search">
        <Icon name="search" size={15} />
        <input placeholder="Find a building, e.g. R17-B" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a building" />
      </div>
      <p className="muted small">{twin.wings.length} buildings, {fmtInt(twin.flats.length)} flats</p>
      {rows.map(([row, wings]) => {
        const list = wings.filter((wi) => !ql || twin.wings[wi].id.toLowerCase().includes(ql));
        if (!list.length) return null;
        return (
          <div key={row} className="b-row">
            <div className="b-row-h">{row}</div>
            {list.map((wi) => {
              const w = twin.wings[wi];
              return (
                <button key={wi} className={`b-item${selected === wi ? ' on' : ''}`} onClick={() => onPick(wi)}>
                  <i style={{ background: TYPOLOGY_COLORS[w.typology.code] }} />
                  <b>{w.id}</b>
                  <span className="muted">{w.flatIds.length ? `${w.flatIds.length} flats, about ${wingPersons(wi)} people` : 'not modelled inside'}</span>
                  {w.status !== 'launched' && <em>planned</em>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function LayersTab({ view, onView }: { view: ViewState; onView: (v: ViewState) => void }) {
  return (
    <div className="panel">
      <section className="block">
        <header><h3>Show on the map</h3></header>
        <div className="toggles">
          {LAYER_LABELS.map(([k, l]) => (
            <Toggle key={k} checked={view.layers[k]} label={l} onChange={(on) => onView({ ...view, layers: { ...view.layers, [k]: on } })} />
          ))}
        </div>
      </section>
      <section className="block">
        <header><h3>Key</h3></header>
        <div className="legend">
          <h4>People</h4>
          {[['Getting ready to leave', 1], ['Walking out', 2], ['Queueing', 3], ['Waiting for rescue', 4], ['Trapped', 5], ['Hurt', 6], ['Safe', 7], ['Rescued', 8]].map(([l, i]) => (
            <div key={l as string} className="lg"><i className="dot" style={{ background: STATUS_COLORS[i as number] }} /><span>{l}</span></div>
          ))}
          <h4>Routes</h4>
          <div className="lg"><i className="line" style={{ background: ROUTE_COLORS.recommended }} /><span>Best way out</span></div>
          <div className="lg"><i className="line" style={{ background: ROUTE_COLORS.fastest }} /><span>Fastest way out</span></div>
          <div className="lg"><i className="line" style={{ background: ROUTE_COLORS.safest }} /><span>Safest way out</span></div>
          <div className="lg"><i className="line" style={{ background: ROUTE_COLORS.avoid }} /><span>Do not use</span></div>
          <div className="lg"><i className="line dash" style={{ color: RESCUE_COLORS.entry }} /><span>Rescue crew going in</span></div>
          <div className="lg"><i className="line dash" style={{ color: RESCUE_COLORS.extraction }} /><span>Bringing people out</span></div>
          <div className="lg"><i className="line dash" style={{ color: '#4ade80' }} /><span>People walking (red where it's crowded)</span></div>
          <h4>Danger</h4>
          <div className="lg"><i style={{ background: '#ff8c14' }} /><span>Room on fire</span></div>
          <div className="lg"><i style={{ background: '#73787f' }} /><span>Smoke</span></div>
          <div className="lg"><i style={{ background: '#f97316', opacity: 0.6 }} /><span>Falling debris zone</span></div>
          <div className="lg"><i style={{ background: '#dc2626', opacity: 0.6 }} /><span>Keep out (collapse or fire)</span></div>
          <div className="lg"><i className="dot" style={{ background: '#e5484d' }} /><span>Assembly point closed</span></div>
        </div>
      </section>
      <details className="about">
        <summary>About this model</summary>
        <p>{ds.site.name} by {ds.site.developer}, {ds.site.location}. Buildings, flats and streets are measured from the developer's brochure plans, accurate to about 5 m. Fire, collapse and earthquake models are simplified engineering estimates for training and planning, not certified analyses.</p>
      </details>
    </div>
  );
}
