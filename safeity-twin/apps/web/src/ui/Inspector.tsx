import { memo, useState } from 'react';
import { Icon } from '@twin/ui-kit';
import { spaceKind, wingStoreyTemplate } from '@twin/twin-data';
import type { PickResult } from '@twin/render';
import type { Snapshot } from '@twin/sim-runtime';
import { ds, twin } from '../app/core';
import { fmtInt, fmtTime } from '../app/format';

const DAMAGE = ['No damage', 'Slight damage', 'Moderate damage', 'Severe damage', 'Collapsed'];

export function wingPersons(wi: number): number {
  const w = twin.wings[wi];
  let n = 0;
  for (const f of w.flatIds) n += ds.typologies.units[twin.flats[f].unit]?.personsNominal ?? 0;
  return n;
}

interface Props {
  sel: PickResult;
  snap: Snapshot | null;
  running: boolean;
  onWalk: (p: PickResult) => void;
  onFly: (p: PickResult) => void;
  onCut: (storey: number | null) => void;
  onSimulate: (p: PickResult) => void;
  onRoutes?: (wing: number) => void;
  onClose: () => void;
}

/** A small card about the building or room you clicked, with what you can do there. */
export const SelectionCard = memo(function SelectionCard({ sel, snap, running, onWalk, onFly, onCut, onSimulate, onRoutes, onClose }: Props) {
  const [more, setMore] = useState(false);
  if (sel.wing === undefined) return null;
  const w = twin.wings[sel.wing];
  const g = sel.spaceId;
  const st = g !== undefined ? wingStoreyTemplate(w, sel.storey ?? 0).spaces[twin.space.t[g]] : null;
  const live = (() => {
    if (!snap || g === undefined) return null;
    const ids = snap.spaces.ids;
    for (let k = 0; k < ids.length; k++) if (ids[k] === g) return { temp: snap.spaces.temp[k], soot: snap.spaces.soot[k], burn: snap.spaces.burn[k], damage: snap.spaces.damage[k] };
    return { temp: 20, soot: 0, burn: 0, damage: 0 };
  })();
  const vis = live ? (live.soot * 8.7 < 0.01 ? 300 : Math.min(300, 3 / (8.7 * live.soot))) : 300;
  const flat = g !== undefined && twin.space.flat[g] >= 0 ? twin.flats[twin.space.flat[g]] : null;
  const unit = flat ? ds.typologies.units[flat.unit] : null;
  const clear = snap?.evac.wingClear.find((c) => c.wing === w.id);
  const wd = snap ? snap.wingDamage[w.idx] : 0;
  const floors = w.storeys === 8 ? 'Ground + 7' : 'Ground + 5';
  const stairs = w.tpl.typical.stairs.length;
  return (
    <div className="sel-card" role="dialog" aria-label={`${w.id} details`}>
      <header>
        <div className="sel-id">{w.id}</div>
        <div className="sel-name">
          <b>{w.typology.name}</b>
          <span>{floors} · {w.status === 'launched' ? 'occupied' : w.status}</span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={14} /></button>
      </header>
      {g !== undefined && st && (
        <div className="sel-room">
          <div className="sel-room-name">{st.name}{flat ? `, flat ${flat.num}` : ''} · {sel.storey === 0 ? 'ground floor' : `floor ${sel.storey}`}</div>
          {flat && unit && <div className="sel-sub">{unit.name}, {flat.reraCarpet_m2.toFixed(0)} m²</div>}
          {running && live && (
            <div className="sel-live">
              <span className={live.temp > 60 ? 'bad' : live.temp > 40 ? 'warn' : ''}>{live.temp.toFixed(0)} °C</span>
              <span className={vis < 5 ? 'bad' : vis < 10 ? 'warn' : ''}>{vis >= 300 ? 'Clear air' : `Smoke, ${vis.toFixed(1)} m visibility`}</span>
              {(live.burn === 1 || live.burn === 2) && <span className="bad">On fire</span>}
              {live.damage > 0 && <span className={live.damage >= 3 ? 'bad' : 'warn'}>{DAMAGE[live.damage]}</span>}
            </div>
          )}
        </div>
      )}
      <dl className="sel-facts">
        <div><dt>Flats</dt><dd>{w.flatIds.length || '—'}</dd></div>
        <div><dt>People (typical)</dt><dd>{w.flatIds.length ? fmtInt(wingPersons(w.idx)) : '—'}</dd></div>
        <div><dt>Stairs</dt><dd>{stairs}{stairs === 1 ? ' (only one)' : ''}</dd></div>
      </dl>
      {running && snap && (
        <div className="sel-status">
          {wd > 0 && <span className={wd >= 3 ? 'bad' : 'warn'}>{DAMAGE[wd]}</span>}
          {clear && <span>{clear.inside ? `${clear.inside} still inside` : clear.clearedAt !== null ? `Empty since ${fmtTime(clear.clearedAt)}` : 'Everyone out'}</span>}
        </div>
      )}
      <div className="sel-actions">
        {!w.massingOnly && <button className="btn" onClick={() => onWalk(sel)}><Icon name="walk" size={14} /> Walk in</button>}
        {running && onRoutes && !w.massingOnly && <button className="btn" onClick={() => onRoutes(w.idx)}><Icon name="route" size={14} /> Ways out</button>}
        <button className="btn primary" onClick={() => onSimulate(sel)}><Icon name="fire" size={14} /> Start an incident</button>
      </div>
      <button className="link sel-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'} details</button>
      {more && (
        <div className="sel-extra">
          <div><span>Size</span>{w.L.toFixed(0)} × {w.W.toFixed(0)} m, {w.height.toFixed(0)} m tall</div>
          {g !== undefined && <div><span>Space</span>{spaceKind(twin, g)}, {twin.space.area[g].toFixed(1)} m²</div>}
          <div><span>Lifts</span>{w.tpl.typical.lifts.length}</div>
          <div><span>Data</span>From the developer's brochure plans ({ds.site.dataLevel})</div>
          <div className="sel-extra-btns">
            <button className="link" onClick={() => onFly(sel)}>Zoom to it</button>
            {!w.massingOnly && sel.storey !== undefined && <button className="link" onClick={() => onCut(sel.storey!)}>Cut the view at this floor</button>}
          </div>
        </div>
      )}
    </div>
  );
});
