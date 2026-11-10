import { useEffect, useRef, useState } from 'react';
import { Icon } from '@twin/ui-kit';
import type { PickResult } from '@twin/render';
import { hazards, HAZARD_ICONS } from '../app/core';

interface Props {
  p: PickResult | null;
  x: number;
  y: number;
  running: boolean;
  onSimulate: (hazardId: string) => void;
  onInspect: () => void;
  onWalk: () => void;
  onFlyTo: () => void;
  onClose: () => void;
}

/** Right-click menu. Hazards come straight from the registry, filtered by what was clicked. */
export function ContextMenu({ p, x, y, running, onSimulate, onInspect, onWalk, onFlyTo, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y, more]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const kind = p?.kind ?? 'outdoor';
  const all = hazards.list();
  const enabled = all.filter((h) => h.enabled && h.targets.includes(kind));
  const unavailable = all.filter((h) => h.enabled && !h.targets.includes(kind));
  const planned = all.filter((h) => !h.enabled);
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()} role="menu">
      <div className="ctx-head">
        <div className="ctx-title">{p?.label ?? 'Sky'}</div>
        {p && p.storey !== undefined && <div className="ctx-sub">{p.storey === 0 ? 'Ground floor' : `Floor ${p.storey}`}</div>}
      </div>
      <div className="ctx-group">{running ? 'Start another incident here' : 'Start an incident here'}</div>
      {enabled.map((h) => (
        <button key={h.id} className="ctx-item" role="menuitem" onClick={() => onSimulate(h.id)} disabled={!p}>
          <Icon name={HAZARD_ICONS[h.id] ?? 'hazard'} className={`hz-${h.id}`} />
          <span>{h.label}</span>
          <kbd>…</kbd>
        </button>
      ))}
      {unavailable.map((h) => (
        <button key={h.id} className="ctx-item" disabled title={`Pick ${h.targets.join(' or ')} for ${h.label.toLowerCase()}`}>
          <Icon name={HAZARD_ICONS[h.id] ?? 'hazard'} />
          <span>{h.label}</span>
          <small>{h.id === 'fire' ? 'click a room' : 'click a building'}</small>
        </button>
      ))}
      <button className="ctx-item ctx-more" onClick={() => setMore(!more)}>
        <Icon name="plus" />
        <span>{more ? 'Hide' : 'Coming later'} ({planned.length})</span>
      </button>
      {more && planned.map((h) => (
        <button key={h.id} className="ctx-item" disabled title={h.description}>
          <Icon name={HAZARD_ICONS[h.id] ?? 'hazard'} />
          <span>{h.label}</span>
          <small>{h.release}</small>
        </button>
      ))}
      <div className="ctx-sep" />
      {p && p.kind !== 'outdoor' && (
        <button className="ctx-item" onClick={onInspect}><Icon name="info" /><span>Details</span></button>
      )}
      {p && (
        <button className="ctx-item" onClick={onWalk}><Icon name="walk" /><span>{p.kind === 'outdoor' ? 'Walk from here' : 'Walk in here'}</span></button>
      )}
      {p && (
        <button className="ctx-item" onClick={onFlyTo}><Icon name="target" /><span>Zoom to</span></button>
      )}
    </div>
  );
}
