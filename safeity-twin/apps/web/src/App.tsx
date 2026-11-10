import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Tabs } from '@twin/ui-kit';
import { SimClient, type Snapshot } from '@twin/sim-runtime';
// bundled into the page as a blob worker, so the built app is a single HTML file
import SimWorker from '@twin/sim-runtime/worker?worker&inline';
import type { SimEvent } from '@twin/hazard-sdk';
import type { HazardSpec, Scenario } from '@twin/twin-schema';
import type { PlanSet } from '@twin/routing';
import type { PlaybookView } from '@twin/advisor';
import type { Incident, IncidentList, RescueOpView } from '@twin/dispatch';
import type { LayerName, PaneRect, PickResult } from '@twin/render';
import { KEY_HELP, type CameraMode } from '@twin/interaction';
import { ds, twin, twinBuildMs } from './app/core';
import type { Preset } from './app/scenarios';
import { Viewport, type ViewportApi } from './ui/Viewport';
import { TopBar, type SimStatus } from './ui/TopBar';
import { BuildingsTab, LayersTab, ScenariosTab, type ViewState } from './ui/LeftDock';
import { SelectionCard } from './ui/Inspector';
import { ClearanceTable, EvacSummary, LogPanel, ResponsePanel } from './ui/LivePanels';
import { ContextMenu } from './ui/ContextMenu';
import { SimWindow, type RunSettings } from './ui/SimWindow';
import { RoutesPanel } from './ui/RoutesPanel';
import { IncidentsPanel } from './ui/IncidentsPanel';
import { RescueView } from './ui/RescueView';
import { Hud } from './ui/Hud';

type LeftTab = 'scenarios' | 'buildings' | 'layers';
type RightTab = 'incidents' | 'evacuation' | 'response' | 'log';
interface Toast { id: number; text: string; level: string }
interface RouteSel { wing: number | null; storey: number | null; highlight: string | null }
/** React re-renders the panels at most this often; the 3D view takes every snapshot. */
const UI_MS = 250;
/** Auto speed while watching a rescue: quick while driving and setting up, slower when people move. */
const PACE_FAST = 30;
const PACE_SLOW = 5;

const DEFAULT_VIEW: ViewState = {
  xray: false, interiors: false, cut: null,
  layers: { labels: true, streets: true, people: true, hazards: true, routes: true, vehicles: true, assembly: true, flows: true, zones: true },
};

let toastSeq = 0;

export function App() {
  const api = useRef<ViewportApi | null>(null);
  const sim = useRef<SimClient | null>(null);
  const activeRef = useRef<Scenario | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const [vpReady, setVpReady] = useState(false);
  const [simReady, setSimReady] = useState(false);
  const [simMode, setSimMode] = useState('worker');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<SimEvent[]>([]);
  const [status, setStatus] = useState<SimStatus>('booting');
  const [speed, setSpeedState] = useState(10);
  const [hover, setHover] = useState<{ p: PickResult; x: number; y: number } | null>(null);
  const [sel, setSel] = useState<PickResult | null>(null);
  const [menu, setMenu] = useState<{ p: PickResult | null; x: number; y: number } | null>(null);
  const [win, setWin] = useState<{ hazard: string; origin: PickResult; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<HazardSpec[]>([]);
  const [settings, setSettings] = useState<RunSettings>({ occupancy: 'weekday-night', seed: 42, launchedOnly: false, disabled: [], windSpeed: 4, windFrom: 250 });
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [cam, setCam] = useState<{ mode: CameraMode; ghost: boolean; storey: number }>({ mode: 'orbit', ghost: true, storey: 0 });
  const [left, setLeft] = useState<LeftTab>('scenarios');
  const [right, setRight] = useState<RightTab>('incidents');
  const [fps, setFps] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [plans, setPlans] = useState<PlanSet | null>(null);
  const [playbook, setPlaybook] = useState<PlaybookView | null>(null);
  const [incidents, setIncidents] = useState<IncidentList | null>(null);
  const [routeSel, setRouteSel] = useState<RouteSel>({ wing: null, storey: null, highlight: null });
  const [hoverRoute, setHoverRoute] = useState<string | null>(null);
  // rescue view
  const [watch, setWatch] = useState<string | null>(null);
  const [pendingWatch, setPendingWatch] = useState<string | null>(null);
  const [swap, setSwap] = useState(false);
  const [autoPace, setAutoPace] = useState(true);
  const [insideLabel, setInsideLabel] = useState('');
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const speedBeforeWatch = useRef<number | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const lastUi = useRef(0);
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((text: string, level = 'info') => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-3), { id, text, level }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    sim.current?.setSpeed(s);
  }, []);

  // ---------------------------------------------------------------- simulation client
  useEffect(() => {
    const c = new SimClient(ds, { createWorker: () => new SimWorker({ name: 'twin-sim' }) });
    sim.current = c;
    c.onReady = (_stats, mode) => {
      setSimReady(true);
      setSimMode(mode);
      setStatus('idle');
      if (mode === 'inline') toast('This browser blocks background workers, so the simulation shares the page and may feel slower.', 'warn');
    };
    c.onSnapshot = (s) => {
      if (!activeRef.current) return;
      api.current?.r.applySnapshot(s);
      if (s.plans) setPlans(s.plans);
      if (s.playbook) setPlaybook(s.playbook);
      if (s.incidents) setIncidents(s.incidents);
      // panels refresh at most every UI_MS so the main thread stays free for rendering
      latest.current = s;
      const now = performance.now();
      if (!s.running || now - lastUi.current >= UI_MS) {
        lastUi.current = now;
        setSnap(s);
      } else if (!uiTimer.current) {
        uiTimer.current = setTimeout(() => {
          uiTimer.current = null;
          lastUi.current = performance.now();
          if (activeRef.current && latest.current) setSnap(latest.current);
        }, UI_MS - (now - lastUi.current));
      }
      if (s.events.length) {
        setEvents((ev) => [...ev, ...s.events].slice(-800));
        const shown = s.events.filter((x) => x.level === 'critical' || x.type === 'rescue-error' || x.type === 'rescue-done').slice(0, 2);
        for (const e of shown) toast(e.text, e.type === 'rescue-done' ? 'info' : e.level);
      }
    };
    c.onError = (m) => toast(m, 'warn');
    return () => c.dispose();
  }, [toast]);

  useEffect(() => {
    const id = setInterval(() => setFps(api.current?.r.fps ?? 0), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- view state -> renderer
  useEffect(() => {
    const r = api.current?.r;
    if (!r) return;
    r.setXray(view.xray);
    r.setInteriors(view.interiors);
    r.setCut(view.cut);
    for (const [k, on] of Object.entries(view.layers)) r.setLayer(k as LayerName, on);
  }, [view, vpReady]);

  // ---------------------------------------------------------------- route view -> renderer and planner
  useEffect(() => {
    const r = api.current?.r;
    if (!r) return;
    if (right === 'evacuation') r.setRouteView({ mode: 'detail', wing: routeSel.wing ?? plans?.wings[0]?.wing ?? null, storey: routeSel.storey, highlight: hoverRoute ?? routeSel.highlight });
    else r.setRouteView({ mode: 'overview', wing: null, storey: null, highlight: null });
  }, [right, routeSel, hoverRoute, plans, vpReady]);

  useEffect(() => {
    if ((status === 'running' || status === 'paused') && right === 'evacuation' && routeSel.wing !== null) sim.current?.focus(routeSel.wing);
  }, [routeSel.wing, right, status]);

  useEffect(() => {
    if (right === 'evacuation' && routeSel.wing === null && plans?.wings.length) setRouteSel((r) => ({ ...r, wing: plans.wings[0].wing }));
  }, [right, routeSel.wing, plans]);

  // ---------------------------------------------------------------- camera helpers
  const flyTo = useCallback((p: PickResult) => {
    const a = api.current;
    if (!a) return;
    if (p.wing !== undefined && p.spaceId === undefined) {
      const w = twin.wings[p.wing];
      a.cam.flyTo(new THREE.Vector3(w.pose.E, w.height * 0.4, -w.pose.N), Math.max(45, w.L * 1.4));
    } else a.cam.flyTo(new THREE.Vector3(p.E, p.up, -p.N), p.kind === 'outdoor' ? 80 : 32);
  }, []);

  const focusWing = useCallback((wi: number) => {
    const w = twin.wings[wi];
    if (!w) return;
    const p: PickResult = { kind: 'building', E: w.pose.E, N: w.pose.N, up: 0, buildingId: w.id, wing: wi, label: `${w.id} · ${w.typology.name}` };
    setSel(p);
    api.current?.r.setSelection(p);
    flyTo(p);
  }, [flyTo]);

  const flyToPts = useCallback((pts: number[]) => {
    const a = api.current;
    if (!a || pts.length < 3) return;
    let e0 = Infinity;
    let e1 = -Infinity;
    let n0 = Infinity;
    let n1 = -Infinity;
    let z1 = 0;
    for (let i = 0; i < pts.length; i += 3) {
      e0 = Math.min(e0, pts[i]);
      e1 = Math.max(e1, pts[i]);
      n0 = Math.min(n0, pts[i + 1]);
      n1 = Math.max(n1, pts[i + 1]);
      z1 = Math.max(z1, pts[i + 2]);
    }
    const ext = Math.max(e1 - e0, n1 - n0, 20);
    a.cam.flyTo(new THREE.Vector3((e0 + e1) / 2, z1 * 0.4, -(n0 + n1) / 2), Math.max(50, ext * 1.3));
  }, []);

  const showRoutes = useCallback((wing: number) => {
    setRouteSel({ wing, storey: null, highlight: null });
    setRight('evacuation');
  }, []);

  const walkIn = useCallback((p: PickResult) => {
    const a = api.current;
    if (!a) return;
    let E = p.E;
    let N = p.N;
    if (p.spaceId !== undefined) {
      E = twin.space.E[p.spaceId];
      N = twin.space.N[p.spaceId];
    }
    // face along the building (corridors run along it)
    const yaw = p.wing !== undefined ? -THREE.MathUtils.degToRad(twin.wings[p.wing].pose.bearing) : undefined;
    setView((v) => ({ ...v, interiors: true, xray: false, cut: null }));
    a.cam.walkAt(E, N, p.storey ?? 0, yaw);
  }, []);

  const setCamMode = useCallback((m: CameraMode) => {
    const a = api.current;
    if (!a) return;
    if (m === 'walk') {
      const t = a.cam.orbit.target;
      setView((v) => ({ ...v, interiors: true }));
      a.cam.walkAt(t.x, -t.z, 0);
    } else a.cam.setMode(m);
  }, []);

  // ---------------------------------------------------------------- rescue view
  const watchOp: RescueOpView | null = useMemo(() => (watch ? snap?.ops.find((o) => o.id === watch) ?? null : null), [watch, snap]);

  const panes = useMemo<{ outside: PaneRect; inside: PaneRect } | null>(() => {
    if (!watch) return null;
    const strip = stage.w > 760 ? 108 : 172;
    const w = stage.w;
    const h = Math.max(120, stage.h - strip);
    const g = 2;
    let a: PaneRect;
    let b: PaneRect;
    if (w >= h * 1.15) {
      const half = Math.floor(w / 2);
      a = { x: 0, y: 0, w: half - g, h };
      b = { x: half + g, y: 0, w: w - half - g, h };
    } else {
      const half = Math.floor(h / 2);
      a = { x: 0, y: 0, w, h: half - g };
      b = { x: 0, y: half + g, w, h: h - half - g };
    }
    return swap ? { outside: b, inside: a } : { outside: a, inside: b };
  }, [watch, stage, swap]);

  const frameOp = useCallback((op: RescueOpView) => {
    const a = api.current;
    if (!a) return;
    const lead = a.r.rescue.leadPosition(op.id, performance.now());
    const w = twin.wings[op.wing];
    const target = lead ?? (op.victimAt ? new THREE.Vector3(op.victimAt[0], op.victimAt[2], -op.victimAt[1]) : w ? new THREE.Vector3(w.pose.E, w.height / 2, -w.pose.N) : null);
    if (!target) return;
    const from = op.facing ? new THREE.Vector3(op.facing[0], 0.7, -op.facing[1]) : new THREE.Vector3(0.5, 0.65, 0.6);
    a.cam.flyTo(target.clone().add(new THREE.Vector3(0, 1.5, 0)), 46, from.normalize());
  }, []);

  useEffect(() => {
    const r = api.current?.r;
    if (!r) return;
    r.onInsideLabel = setInsideLabel;
    if (watch && panes) r.setRescueView({ op: watch, wing: watchOp?.wing ?? -1, outside: panes.outside, inside: panes.inside });
    else r.setRescueView(null);
  }, [watch, panes, watchOp?.wing, vpReady]);

  // a rescue the user just started: watch it as soon as it exists
  useEffect(() => {
    if (!pendingWatch || !snap) return;
    const op = snap.ops.find((o) => o.incident === pendingWatch && !o.done);
    if (!op) return;
    setPendingWatch(null);
    setWatch(op.id);
    setSel(null);
    api.current?.r.setSelection(null);
    if (speedBeforeWatch.current === null) speedBeforeWatch.current = speed;
    setTimeout(() => frameOp(op), 50);
  }, [pendingWatch, snap, frameOp, speed]);

  // re-frame the outside view when the crew switches to a ladder at a window
  const facingKey = watchOp?.facing ? watchOp.facing.join(',') : '';
  useEffect(() => {
    if (watchOp && facingKey) frameOp(watchOp);
  }, [facingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto speed: quick through the driving and set-up, watchable when people move
  useEffect(() => {
    if (!watchOp || !autoPace || watchOp.done || status !== 'running') return;
    const slow = watchOp.phase === 'entry' || watchOp.phase === 'search' || watchOp.phase === 'extract' || watchOp.phase === 'handover';
    const want = slow ? PACE_SLOW : PACE_FAST;
    if (want !== speed) setSpeed(want);
  }, [watchOp?.phase, watchOp?.done, autoPace, status, speed, setSpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeWatch = useCallback(() => {
    setWatch(null);
    setPendingWatch(null);
    if (speedBeforeWatch.current !== null) {
      setSpeed(speedBeforeWatch.current);
      speedBeforeWatch.current = null;
    }
  }, [setSpeed]);

  const startRescue = useCallback((i: Incident) => {
    sim.current?.startRescue(i.id);
    setPendingWatch(i.id);
    if (status === 'paused') {
      sim.current?.resume();
      setStatus('running');
    }
  }, [status]);

  const watchExisting = useCallback((op: string) => {
    if (speedBeforeWatch.current === null) speedBeforeWatch.current = speed;
    setWatch(op);
    setSel(null);
    api.current?.r.setSelection(null);
    const o = snap?.ops.find((x) => x.id === op);
    if (o) setTimeout(() => frameOp(o), 50);
  }, [snap, frameOp, speed]);

  const stopRescue = useCallback((op: string) => {
    sim.current?.stopRescue(op);
    if (watch === op) closeWatch();
  }, [watch, closeWatch]);

  const locate = useCallback((i: Incident) => {
    const a = api.current;
    if (!a) return;
    if (i.wing >= 0) {
      const w = twin.wings[i.wing];
      const p: PickResult = { kind: 'building', E: w.pose.E, N: w.pose.N, up: 0, buildingId: w.id, wing: i.wing, label: w.id };
      setSel(p);
      a.r.setSelection(p);
    }
    a.cam.flyTo(new THREE.Vector3(i.E, i.z + 2, -i.N), i.wing >= 0 ? 55 : 300);
  }, []);

  // ---------------------------------------------------------------- scenario control
  const run = useCallback((scn: Scenario, launchedOnly: boolean) => {
    const c = sim.current;
    if (!c) return;
    api.current?.r.resetOverlays();
    activeRef.current = scn;
    setEvents([]);
    setSnap(null);
    setPlans(null);
    setPlaybook(null);
    setIncidents(null);
    setWatch(null);
    setPendingWatch(null);
    const restore = speedBeforeWatch.current;
    speedBeforeWatch.current = null;
    if (restore !== null) setSpeedState(restore);
    setRouteSel({ wing: null, storey: null, highlight: null });
    c.setSpeed(restore ?? speed);
    c.start(scn, { launchedOnly });
    api.current?.r.setWind(scn.wind?.speed_ms ?? 4, scn.wind?.fromDeg ?? 250);
    setStatus('running');
    setRight('incidents');
  }, [speed]);

  const buildScenario = useCallback((hz: HazardSpec[]): Scenario => ({
    id: `custom-${Date.now().toString(36)}`, version: 1, seed: settings.seed, occupancy: settings.occupancy, hazards: hz,
    resources: { disabled: settings.disabled }, wind: { speed_ms: settings.windSpeed, fromDeg: settings.windFrom },
  }), [settings]);

  const runPreset = useCallback((p: Preset) => {
    const scn = p.build(twin);
    scn.resources = { ...(scn.resources ?? {}), disabled: settings.disabled };
    setDraft(scn.hazards);
    setSettings((s) => ({ ...s, occupancy: scn.occupancy, seed: scn.seed }));
    run(scn, settings.launchedOnly);
    if (p.focus) focusWing(twin.wingById.get(p.focus)!);
    else api.current?.cam.view('home');
  }, [run, settings, focusWing]);

  const stop = useCallback(() => {
    sim.current?.stop();
    activeRef.current = null;
    setStatus('idle');
    setSnap(null);
    setPlans(null);
    setPlaybook(null);
    setIncidents(null);
    setWatch(null);
    setPendingWatch(null);
    if (speedBeforeWatch.current !== null) {
      setSpeed(speedBeforeWatch.current);
      speedBeforeWatch.current = null;
    }
    api.current?.r.resetOverlays();
  }, [setSpeed]);

  const playPause = useCallback(() => {
    if (!activeRef.current) return;
    if (status === 'running') {
      sim.current?.pause();
      setStatus('paused');
    } else {
      sim.current?.resume();
      setStatus('running');
    }
  }, [status]);

  const openSim = useCallback((p: PickResult, hazard?: string, x?: number, y?: number) => {
    const h = hazard ?? (p.kind === 'space' ? 'fire' : p.kind === 'building' ? 'collapse' : 'earthquake');
    setMenu(null);
    setWin({ hazard: h, origin: p, x: x ?? Math.max(16, window.innerWidth - 820), y: y ?? 96 });
  }, []);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (menu) setMenu(null);
        else if (win) setWin(null);
        else if (watch) closeWatch();
        else if (cam.mode !== 'orbit') setCamMode('orbit');
        else {
          setSel(null);
          api.current?.r.setSelection(null);
        }
      }
      if (cam.mode === 'orbit' || !['w', 'a', 's', 'd', 'q', 'e', 'r', 'f', 'g'].includes(k)) {
        if (k === '1') setCamMode('orbit');
        if (k === '2') setCamMode('fly');
        if (k === '3') setCamMode('walk');
        if (k === 'x') setView((v) => ({ ...v, xray: !v.xray }));
        if (k === 'i') setView((v) => ({ ...v, interiors: !v.interiors }));
        if (k === 'p') playPause();
        if (k === 'h') api.current?.cam.view('home');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, win, watch, cam.mode, setCamMode, playPause, closeWatch]);

  const live = status === 'running' || status === 'paused';
  const urgent = snap?.recommendations.filter((r) => r.priority === 1).length ?? 0;
  const activeIncidents = incidents?.items.filter((i) => i.active && i.kind !== 'power').length ?? 0;
  const hoverLive = (() => {
    if (!hover || !snap || hover.p.spaceId === undefined) return null;
    const ids = snap.spaces.ids;
    for (let k = 0; k < ids.length; k++) {
      if (ids[k] !== hover.p.spaceId) continue;
      const soot = snap.spaces.soot[k];
      const vis = soot * 8.7 < 0.01 ? 300 : Math.min(300, 3 / (8.7 * soot));
      return `${snap.spaces.temp[k].toFixed(0)} °C · ${vis >= 300 ? 'clear air' : `smoke, ${vis.toFixed(1)} m visibility`}${snap.spaces.burn[k] === 1 || snap.spaces.burn[k] === 2 ? ' · on fire' : ''}`;
    }
    return null;
  })();

  return (
    <div className="app">
      <TopBar
        cam={cam.mode} ghost={cam.ghost} storey={cam.storey} view={view} status={status} simT={snap?.t ?? 0} speed={speed}
        onCam={setCamMode}
        onGhost={() => {
          const c = api.current?.cam;
          if (!c) return;
          c.ghost = !c.ghost;
          setCam((s) => ({ ...s, ghost: c.ghost }));
        }}
        onHome={() => api.current?.cam.view('home')}
        onTop={() => api.current?.cam.view('top')}
        onView={setView}
        onPlayPause={playPause}
        onStop={stop}
        onSpeed={(s) => {
          setAutoPace(false);
          setSpeed(s);
        }}
        onEvacuateAll={() => {
          sim.current?.alertAll();
          toast('Alarm sounded in every building');
        }}
      />
      <aside className="dock left">
        <Tabs value={left} onChange={setLeft} tabs={[
          { id: 'scenarios', label: 'Scenarios', icon: 'fire' },
          { id: 'buildings', label: 'Buildings', icon: 'building' },
          { id: 'layers', label: 'Map', icon: 'layers' },
        ]} />
        <div className="dock-body">
          {left === 'scenarios' && (
            <ScenariosTab running={live} draft={draft}
              onPreset={runPreset}
              onLoadPreset={(p) => {
                const scn = p.build(twin);
                setDraft(scn.hazards);
                setSettings((s) => ({ ...s, occupancy: scn.occupancy, seed: scn.seed }));
                if (p.focus) focusWing(twin.wingById.get(p.focus)!);
                toast(`"${p.title}" is ready to edit. Right-click the map to add more.`);
              }}
              onRunDraft={() => run(buildScenario(draft), settings.launchedOnly)}
              onRemoveDraft={(i) => setDraft((d) => d.filter((_, j) => j !== i))}
              onClearDraft={() => setDraft([])}
            />
          )}
          {left === 'buildings' && <BuildingsTab selected={sel?.wing} onPick={focusWing} />}
          {left === 'layers' && <LayersTab view={view} onView={setView} />}
        </div>
      </aside>
      <main className="stage" ref={stageRef}>
        <Viewport
          onReady={(a) => {
            api.current = a;
            setVpReady(true);
          }}
          onHover={(p, x, y) => setHover(p ? { p, x, y } : null)}
          onSelect={(p) => {
            setSel(p);
            api.current?.r.setSelection(p);
          }}
          onContext={(p, x, y) => {
            setHover(null);
            setMenu({ p, x, y });
          }}
          onWalk={walkIn}
          onCamera={(c) => setCam({ mode: c.mode, ghost: c.ghost, storey: c.storey })}
        />
        {hover && !menu && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 16 }}>
            <div>{hover.p.label}</div>
            {hoverLive && <div className="tt-live">{hoverLive}</div>}
          </div>
        )}
        {watch && watchOp && panes && (
          <RescueView op={watchOp} outside={panes.outside} inside={panes.inside} insideLabel={insideLabel} simT={snap?.t ?? 0}
            autoPace={autoPace} speed={speed}
            onAutoPace={setAutoPace}
            onSwap={() => setSwap((s) => !s)}
            onReframe={() => frameOp(watchOp)}
            onClose={closeWatch}
            onStop={() => stopRescue(watchOp.id)}
          />
        )}
        {sel && !watch && sel.wing !== undefined && (
          <SelectionCard sel={sel} snap={snap} running={live} onWalk={walkIn} onFly={flyTo} onSimulate={(p) => openSim(p)}
            onCut={(s) => setView((v) => ({ ...v, cut: s, interiors: true }))} onRoutes={showRoutes}
            onClose={() => {
              setSel(null);
              api.current?.r.setSelection(null);
            }} />
        )}
        {live && !watch && <Hud snap={snap} phase={playbook?.phase ?? ''} />}
        {!simReady && (
          <div className="boot">
            <div className="spinner" />
            <div>
              <b>Getting the simulation ready…</b>
              <div className="muted small">{twin.wings.length} buildings and {twin.nSpaces.toLocaleString('en-IN')} rooms loaded in {twinBuildMs} ms.</div>
            </div>
          </div>
        )}
        <div className="toasts">
          {toasts.map((t) => <div key={t.id} className={`toast lv-${t.level}`}>{t.text}</div>)}
        </div>
        {!watch && (
          <div className="statusbar">
            <span className="sb-help">{KEY_HELP[cam.mode]}</span>
            {cam.mode === 'fly' && <span>{Math.round(api.current?.cam.flySpeed ?? 14)} m/s · {cam.ghost ? 'through walls' : 'stops at walls'}</span>}
            <span className="sb-perf" title={simMode === 'worker' ? 'The simulation runs in the background' : 'The simulation shares the page'}>{fps} fps</span>
          </div>
        )}
      </main>
      <aside className="dock right">
        <Tabs value={right} onChange={setRight} tabs={[
          { id: 'incidents', label: 'Incidents', icon: 'bell', badge: activeIncidents || undefined },
          { id: 'evacuation', label: 'Evacuation', icon: 'route' },
          { id: 'response', label: 'Response', icon: 'checklist', badge: urgent || undefined },
          { id: 'log', label: 'Log', icon: 'log' },
        ]} />
        <div className="dock-body">
          {right === 'incidents' && (
            <IncidentsPanel list={incidents} ops={snap?.ops ?? []} running={live} simT={snap?.t ?? 0} watching={watch}
              onStart={startRescue} onWatch={watchExisting} onStop={stopRescue} onLocate={locate} />
          )}
          {right === 'evacuation' && (
            <div className="panel">
              {snap ? <EvacSummary snap={snap} /> : null}
              <section className="block">
                <header><h3>Ways out, floor by floor</h3></header>
                <RoutesPanel plans={plans} running={live} wing={routeSel.wing} storey={routeSel.storey} highlight={routeSel.highlight} selectedWing={sel?.wing}
                  onWing={(w) => setRouteSel({ wing: w, storey: null, highlight: null })}
                  onStorey={(s) => setRouteSel((r) => ({ ...r, wing: r.wing ?? plans?.wings[0]?.wing ?? null, storey: s, highlight: null }))}
                  onHighlight={(id, pts) => {
                    setRouteSel((r) => ({ ...r, wing: r.wing ?? plans?.wings[0]?.wing ?? null, highlight: id }));
                    if (id && pts) flyToPts(pts);
                  }}
                  onHover={setHoverRoute} />
              </section>
              {snap ? <ClearanceTable snap={snap} /> : null}
            </div>
          )}
          {right === 'response' && <ResponsePanel snap={snap} playbook={playbook} onFocusWing={focusWing} />}
          {right === 'log' && <LogPanel events={events} onFocusWing={focusWing} />}
        </div>
      </aside>
      {menu && (
        <ContextMenu p={menu.p} x={menu.x} y={menu.y} running={live}
          onClose={() => setMenu(null)}
          onSimulate={(h) => menu.p && openSim(menu.p, h, menu.x + 12, menu.y - 20)}
          onInspect={() => {
            if (!menu.p) return;
            setSel(menu.p);
            api.current?.r.setSelection(menu.p);
            setMenu(null);
          }}
          onWalk={() => {
            if (menu.p) walkIn(menu.p);
            setMenu(null);
          }}
          onFlyTo={() => {
            if (menu.p) flyTo(menu.p);
            setMenu(null);
          }}
        />
      )}
      {win && (
        <SimWindow
          hazardId={win.hazard} origin={win.origin} x={win.x} y={win.y} running={live} simT={snap?.t ?? 0} draft={draft} settings={settings}
          onHazard={(h) => setWin({ ...win, hazard: h })}
          onAdd={(spec) => {
            setDraft((d) => [...d, spec]);
            toast(`Added to your setup (${draft.length + 1} ${draft.length ? 'incidents' : 'incident'}).`);
            setLeft('scenarios');
          }}
          onRun={(spec) => {
            const hz = spec ? [...draft, spec] : draft;
            setDraft(hz);
            run(buildScenario(hz), settings.launchedOnly);
            setWin(null);
          }}
          onInject={(spec) => {
            sim.current?.inject(spec);
            toast(`Started at ${spec.origin.label ?? 'the site'}`);
            setWin(null);
          }}
          onRemoveDraft={(i) => setDraft((d) => d.filter((_, j) => j !== i))}
          onSettings={setSettings}
          onClose={() => setWin(null)}
        />
      )}
    </div>
  );
}
