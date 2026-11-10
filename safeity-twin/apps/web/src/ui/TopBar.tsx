import { Icon, Segmented } from '@twin/ui-kit';
import type { CameraMode } from '@twin/interaction';
import { ds } from '../app/core';
import { fmtTime } from '../app/format';
import type { ViewState } from './LeftDock';

export type SimStatus = 'booting' | 'idle' | 'running' | 'paused';
const SPEEDS = [1, 5, 10, 30, 60];
const STATUS: Record<SimStatus, string> = { booting: 'Loading', idle: 'Ready', running: 'Running', paused: 'Paused' };

interface Props {
  cam: CameraMode;
  ghost: boolean;
  storey: number;
  view: ViewState;
  status: SimStatus;
  simT: number;
  speed: number;
  onCam: (m: CameraMode) => void;
  onGhost: () => void;
  onHome: () => void;
  onTop: () => void;
  onView: (v: ViewState) => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSpeed: (s: number) => void;
  onEvacuateAll: () => void;
}

export function TopBar(p: Props) {
  const live = p.status === 'running' || p.status === 'paused';
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo" aria-hidden="true"><Icon name="building" size={17} /></div>
        <div>
          <div className="brand-name">{ds.site.name}</div>
          <div className="brand-sub">Emergency simulator</div>
        </div>
      </div>
      <nav className="tb-group" aria-label="Camera">
        <Segmented value={p.cam} onChange={p.onCam} options={[
          { value: 'orbit', label: 'Overview', icon: 'orbit', title: 'Look around the site (1)' },
          { value: 'fly', label: 'Fly', icon: 'fly', title: 'Fly through buildings (2)' },
          { value: 'walk', label: 'Walk', icon: 'walk', title: 'Walk a floor at eye level (3)' },
        ]} />
        {p.cam === 'fly' && <button className="btn quiet small" onClick={p.onGhost} title="G">{p.ghost ? 'Through walls' : 'Stop at walls'}</button>}
        {p.cam === 'walk' && <span className="pill">{p.storey === 0 ? 'Ground floor' : `Floor ${p.storey}`}</span>}
        <button className="icon-btn" onClick={p.onHome} title="Whole site (H)" aria-label="Whole site"><Icon name="home" size={16} /></button>
        <button className="icon-btn" onClick={p.onTop} title="View from above" aria-label="View from above"><Icon name="plan" size={16} /></button>
      </nav>
      <div className="tb-group" aria-label="What to show">
        <button className={`btn quiet small${p.view.xray ? ' on' : ''}`} onClick={() => p.onView({ ...p.view, xray: !p.view.xray })} title="See through outer walls (X)" aria-pressed={p.view.xray}>
          <Icon name="xray" size={14} /> See-through
        </button>
        <button className={`btn quiet small${p.view.interiors ? ' on' : ''}`} onClick={() => p.onView({ ...p.view, interiors: !p.view.interiors })} title="Show rooms and stairs inside (I)" aria-pressed={p.view.interiors}>
          <Icon name="layers" size={14} /> Rooms
        </button>
        <label className="floors" title="Hide everything above a floor">
          <span className="sr-only">Floors shown</span>
          <select value={p.view.cut === null ? '' : String(p.view.cut)} onChange={(e) => p.onView({ ...p.view, cut: e.target.value === '' ? null : Number(e.target.value) })}>
            <option value="">All floors</option>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((s) => <option key={s} value={s}>Up to {s === 0 ? 'ground floor' : `floor ${s}`}</option>)}
          </select>
        </label>
      </div>
      <div className="tb-group sim" aria-label="Simulation">
        <span className={`status s-${p.status}`}>{STATUS[p.status]}</span>
        <span className="clock" title="Time since the incident began">{fmtTime(p.simT)}</span>
        <button className="icon-btn" disabled={!live} onClick={p.onPlayPause} title="Pause or resume (P)" aria-label={p.status === 'running' ? 'Pause' : 'Resume'}>
          <Icon name={p.status === 'running' ? 'pause' : 'play'} size={15} />
        </button>
        <button className="icon-btn" disabled={!live} onClick={p.onStop} title="Stop and reset" aria-label="Stop"><Icon name="stop" size={14} /></button>
        <Segmented size="sm" value={String(p.speed)} onChange={(v) => p.onSpeed(Number(v))} options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×`, title: `${s} times real time` }))} />
        <button className="btn alarm small" disabled={!live} onClick={p.onEvacuateAll} title="Sound the alarm in every building">
          <Icon name="bell" size={14} /> Alarm all
        </button>
      </div>
    </header>
  );
}
