import { memo } from 'react';
import { Icon } from '@twin/ui-kit';
import type { Snapshot } from '@twin/sim-runtime';
import { fmtInt, fmtTime } from '../app/format';

/** Incident HUD over the 3D view: phase, clock, headline numbers, shaking warning. */
export const Hud = memo(function Hud({ snap, phase }: { snap: Snapshot | null; phase: string }) {
  if (!snap) return null;
  const b = snap.evac.byStatus;
  const out = b.safe + b.rescued;
  const units = snap.resources.filter((r) => r.status === 'onscene').length;
  const moving = snap.resources.filter((r) => r.status === 'enroute').length;
  const closed = snap.evac.assembly.filter((a) => !a.open).length;
  return (
    <div className="hud" aria-live="polite">
      {snap.shaking > 0.05 && (
        <div className="hud-shake"><Icon name="earthquake" /> Shaking — drop, cover and hold on</div>
      )}
      <div className="hud-row">
        <span className="hud-clock">T+{fmtTime(snap.t)}</span>
        {phase && <span className="hud-phase">{phase}</span>}
      </div>
      <div className="hud-row hud-nums">
        <span title="Out and safe or rescued"><i className="g" />{fmtInt(out)} out</span>
        <span title="Alerted and still inside"><i className="w" />{fmtInt(snap.evac.inside)} inside</span>
        {b.sheltering > 0 && <span title="Sheltering in place"><i className="o" />{fmtInt(b.sheltering)} sheltering</span>}
        {b.trapped > 0 && <span title="Trapped"><i className="r" />{fmtInt(b.trapped)} trapped</span>}
        {b.casualty > 0 && <span title="Casualties"><i className="p" />{fmtInt(b.casualty)} casualties</span>}
        <span title="Units on scene / on the way"><Icon name="truck" size={12} />{units} on scene{moving ? ` · ${moving} en route` : ''}</span>
        {closed > 0 && <span className="hud-warn" title="Assembly points closed because they lie in a hazard zone">{closed} assembly point{closed === 1 ? '' : 's'} closed</span>}
      </div>
    </div>
  );
});
