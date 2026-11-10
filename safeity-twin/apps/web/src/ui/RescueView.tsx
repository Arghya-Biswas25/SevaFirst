import { memo } from 'react';
import { Icon } from '@twin/ui-kit';
import type { RescueOpView } from '@twin/dispatch';
import type { PaneRect } from '@twin/render';
import { fmtTime } from '../app/format';
import { STEPS } from './IncidentsPanel';

const METHOD: Record<RescueOpView['method'], string> = { stairs: 'By the stairs', window: 'By ladder', lift: 'Lift release' };

interface Props {
  op: RescueOpView;
  outside: PaneRect;
  inside: PaneRect;
  insideLabel: string;
  simT: number;
  autoPace: boolean;
  speed: number;
  onAutoPace: (on: boolean) => void;
  onSwap: () => void;
  onReframe: () => void;
  onClose: () => void;
  onStop: () => void;
}

const box = (r: PaneRect) => ({ left: r.x, top: r.y, width: r.w, height: r.h });

/**
 * Frames and controls over the split rescue view: the outside view on one side, the
 * camera following the rescue on the other, and a strip with what is happening now.
 */
export const RescueView = memo(function RescueView(p: Props) {
  const { op } = p;
  const smoky = op.vis < 30;
  return (
    <div className="rv">
      <div className="rv-pane" style={box(p.outside)}>
        <span className="rv-tag">Outside · {op.place}</span>
        <button className="rv-mini" onClick={p.onReframe} title="Point the outside view at the rescue"><Icon name="target" size={14} /></button>
      </div>
      <div className="rv-pane inside" style={box(p.inside)}>
        <span className="rv-tag"><i className="live" /> Inside · {p.insideLabel || 'Following the rescue'}</span>
        {op.leg !== 'none' && (smoky || op.temp > 40) && (
          <span className={`rv-air${op.vis < 5 ? ' bad' : ''}`}>
            {smoky ? `Smoke, ${op.vis < 1 ? 'under 1' : Math.round(op.vis)} m visibility` : 'Clear air'}{op.temp > 40 ? ` · ${op.temp} °C` : ''}
          </span>
        )}
      </div>
      <div className="rv-strip" role="region" aria-label="Rescue progress">
        <div className="rv-left">
          <div className="rv-head">
            <b>{op.title}</b>
            <span>{op.place}</span>
          </div>
          <div className="rv-sub">
            <Icon name={op.unitKind === 'technician' ? 'power' : 'truck'} size={13} /> {op.unitName}
            <span className="dot" /> {METHOD[op.method]}
            <span className="dot" /> {fmtTime(p.simT - op.startedAt)}
          </div>
        </div>
        <div className="rv-mid">
          <ol className="rv-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={op.done || i < op.step ? 'done' : i === op.step ? 'now' : ''}>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <div className="rv-now" aria-live="polite">{op.text}</div>
        </div>
        <div className="rv-right">
          <div className="rv-count"><b>{op.rescued}</b> out{op.left > 0 ? <> · <b>{op.left}</b> to go</> : null}</div>
          <div className="rv-btns">
            <label className="rv-pace" title="Speeds up the driving and set-up, slows down when people are on the move">
              <input type="checkbox" checked={p.autoPace} onChange={(e) => p.onAutoPace(e.target.checked)} />
              Auto speed {p.autoPace ? `(${p.speed}×)` : ''}
            </label>
            <button className="btn quiet" onClick={p.onSwap} title="Swap the two views"><Icon name="swap" size={14} /> Swap</button>
            <button className="btn quiet" onClick={p.onClose}>Close view</button>
            {!op.done && <button className="btn danger-quiet" onClick={p.onStop}>Stop rescue</button>}
          </div>
        </div>
      </div>
    </div>
  );
});
