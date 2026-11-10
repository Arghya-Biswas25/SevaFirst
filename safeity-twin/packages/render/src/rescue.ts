/**
 * Rescue operations in 3D: firefighters and residents as small animated figures that
 * walk the operation's path (through doorways, up the stair flights, up and down the
 * ladder), the ladder itself, the path being followed, and a marker over the person
 * being brought out. Positions come from the simulation as a path plus a distance
 * along it; between snapshots the distance is interpolated so movement is continuous.
 * `cameraGoal` tells the inside camera where to be: in the residents' room while they
 * wait, then trailing the person being rescued, outside when they are on the ladder.
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { RescueOpView } from '@twin/dispatch';
import { trackLineMaterial } from './overlays';

type V3 = [number, number, number];
const toThree = (p: V3, out = new THREE.Vector3()) => out.set(p[0], p[2], -p[1]);

const matCache = new Map<string, THREE.MeshLambertMaterial>();
const mat = (c: string) => {
  let m = matCache.get(c);
  if (!m) matCache.set(c, (m = new THREE.MeshLambertMaterial({ color: c })));
  return m;
};
const BOX = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(1, 14, 10);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 12);

/** A simple person: legs and arms swing from hips and shoulders. */
class Figure {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legs: THREE.Object3D[] = [];
  private arms: THREE.Object3D[] = [];
  private walked = 0;
  private last = new THREE.Vector3(NaN, 0, 0);
  heading = 0;

  constructor(kind: 'crew' | 'resident', variant = 0) {
    const part = (g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, parent: THREE.Object3D = this.body) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.scale.set(sx, sy, sz);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };
    const crew = kind === 'crew';
    const shirt = crew ? '#1f2a44' : ['#2f6fb3', '#8a3b5a', '#3d7a4a', '#b5762a'][variant % 4];
    const legsC = crew ? '#1f2a44' : ['#2b2f3a', '#4a3d33', '#30353f', '#3b3b46'][variant % 4];
    const skin = ['#c68e65', '#a8714c', '#d9a37f', '#8d5a3b'][variant % 4];
    const band = '#d8f04a';
    for (const sx of [-0.1, 0.1]) {
      const hip = new THREE.Group();
      hip.position.set(sx, 0.9, 0);
      part(BOX, mat(legsC), 0.15, 0.86, 0.17, 0, -0.43, 0, hip);
      if (crew) part(BOX, mat(band), 0.16, 0.05, 0.18, 0, -0.62, 0, hip);
      part(BOX, mat('#1a1a1a'), 0.16, 0.08, 0.26, 0, -0.84, 0.04, hip);
      this.body.add(hip);
      this.legs.push(hip);
    }
    part(BOX, mat(shirt), 0.44, 0.62, 0.26, 0, 1.2, 0);
    if (crew) {
      part(BOX, mat(band), 0.45, 0.05, 0.27, 0, 1.0, 0);
      part(BOX, mat(band), 0.45, 0.05, 0.27, 0, 1.36, 0);
      part(CYL, mat('#b9c2c9'), 0.09, 0.52, 0.09, 0, 1.22, -0.2); // breathing set
    }
    for (const sx of [-0.28, 0.28]) {
      const sh = new THREE.Group();
      sh.position.set(sx, 1.47, 0);
      part(BOX, mat(shirt), 0.12, 0.62, 0.13, 0, -0.3, 0, sh);
      part(SPHERE, mat(crew ? '#1a1a1a' : skin), 0.06, 0.06, 0.06, 0, -0.63, 0, sh);
      this.body.add(sh);
      this.arms.push(sh);
    }
    part(SPHERE, mat(skin), 0.12, 0.13, 0.12, 0, 1.66, 0);
    if (crew) {
      part(SPHERE, mat('#f2c40f'), 0.15, 0.1, 0.16, 0, 1.73, 0);
      part(BOX, mat('#f2c40f'), 0.3, 0.02, 0.3, 0, 1.69, -0.02);
    } else part(SPHERE, mat('#1d1712'), 0.125, 0.07, 0.125, 0, 1.74, -0.01);
    this.root.add(this.body);
  }

  /** Place at `p` (three.js) facing `heading`; `climb` for ladder poses, `idle` to stand. */
  pose(p: THREE.Vector3, heading: number, mode: 'walk' | 'climb' | 'idle', t: number) {
    if (Number.isNaN(this.last.x)) this.last.copy(p);
    this.walked += Math.min(2, p.distanceTo(this.last));
    this.last.copy(p);
    this.root.position.copy(p);
    let d = heading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * (mode === 'climb' ? 1 : 0.25);
    this.root.rotation.y = this.heading;
    const ph = (this.walked / 1.35) * Math.PI * 2;
    if (mode === 'walk') {
      const s = Math.sin(ph);
      this.legs[0].rotation.x = s * 0.55;
      this.legs[1].rotation.x = -s * 0.55;
      this.arms[0].rotation.x = -s * 0.45;
      this.arms[1].rotation.x = s * 0.45;
      this.body.position.y = Math.abs(Math.cos(ph)) * 0.035;
    } else if (mode === 'climb') {
      const s = Math.sin(ph * 1.6);
      this.legs[0].rotation.x = -0.6 + s * 0.35;
      this.legs[1].rotation.x = -0.6 - s * 0.35;
      this.arms[0].rotation.x = -2.6 + s * 0.3;
      this.arms[1].rotation.x = -2.6 - s * 0.3;
      this.body.position.y = 0;
    } else {
      const b = Math.sin(t * 1.7 + this.root.id) * 0.04;
      this.legs[0].rotation.x = this.legs[1].rotation.x = 0;
      this.arms[0].rotation.x = 0.08 + b;
      this.arms[1].rotation.x = 0.08 - b;
      this.body.position.y = 0;
    }
  }
}

function makeLadder(len: number, aerial: boolean): THREE.Group {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  const rail = mat(aerial ? '#e6e8ea' : '#c9a227');
  for (const x of [-0.24, 0.24]) {
    const m = new THREE.Mesh(BOX, rail);
    m.scale.set(0.07, len, 0.07);
    m.position.set(x, len / 2, 0);
    inner.add(m);
  }
  const rungs = Math.max(2, Math.floor(len / 0.33));
  for (let i = 1; i < rungs; i++) {
    const m = new THREE.Mesh(BOX, rail);
    m.scale.set(0.48, 0.035, 0.035);
    m.position.set(0, (i / rungs) * len, 0);
    inner.add(m);
  }
  g.add(inner);
  if (aerial) {
    const turn = new THREE.Mesh(CYL, mat('#c0392b'));
    turn.scale.set(0.9, 0.5, 0.9);
    turn.position.y = -0.25;
    g.add(turn);
  }
  g.userData.inner = inner;
  return g;
}

interface OpVis {
  view: RescueOpView;
  group: THREE.Group;
  crew: Figure[];
  victims: Figure[];
  ladder: THREE.Group | null;
  ladderKey: string;
  line: Line2 | null;
  lineMat: LineMaterial | null;
  pathId: number;
  path: Float32Array;
  cum: Float32Array;
  prevS: number;
  nextS: number;
  marker: THREE.Mesh;
  bob: number;
}

export class RescueLayer {
  readonly group = new THREE.Group();
  private ops = new Map<string, OpVis>();
  private tSnap = 0;
  private interval = 110;
  /** figures are drawn larger in the overview so they can be found; 1 in the inside view */
  figureScale = 1;

  update(views: RescueOpView[], now: number) {
    // where everyone is drawn right now, before the clock moves on to the new snapshot
    const shown = new Map<string, number>();
    for (const [id, o] of this.ops) shown.set(id, this.currentS(o, now));
    const gap = now - this.tSnap;
    if (this.tSnap > 0 && gap > 30 && gap < 1000) this.interval = 0.7 * this.interval + 0.3 * Math.min(320, Math.max(60, gap));
    this.tSnap = now;
    const seen = new Set<string>();
    for (const v of views) {
      seen.add(v.id);
      let o = this.ops.get(v.id);
      if (!o) {
        const group = new THREE.Group();
        const marker = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 14), new THREE.MeshBasicMaterial({ color: '#ff7a1a', depthTest: false, transparent: true }));
        marker.rotation.x = Math.PI;
        marker.renderOrder = 40;
        group.add(marker);
        o = { view: v, group, crew: [], victims: [], ladder: null, ladderKey: '', line: null, lineMat: null, pathId: -1, path: new Float32Array(0), cum: new Float32Array(0), prevS: 0, nextS: 0, marker, bob: 0 };
        this.ops.set(v.id, o);
        this.group.add(group);
      }
      const cur = shown.get(v.id) ?? v.s;
      if (v.pathId !== o.pathId) {
        o.pathId = v.pathId;
        o.path = Float32Array.from(v.path);
        o.cum = new Float32Array(Math.max(1, v.path.length / 3));
        for (let i = 1; i < o.cum.length; i++) {
          const a = (i - 1) * 3;
          const b = i * 3;
          o.cum[i] = o.cum[i - 1] + Math.hypot(v.path[b] - v.path[a], v.path[b + 1] - v.path[a + 1], v.path[b + 2] - v.path[a + 2]);
        }
        o.prevS = v.s;
        o.nextS = v.s;
        this.setLine(o, v);
      } else {
        o.prevS = Math.min(cur, v.s);
        o.nextS = v.s;
      }
      o.view = v;
      while (o.crew.length < v.crew) {
        const f = new Figure('crew');
        o.crew.push(f);
        o.group.add(f.root);
      }
      while (o.victims.length < 3) {
        const f = new Figure('resident', o.victims.length + v.id.length);
        o.victims.push(f);
        o.group.add(f.root);
      }
      const lk = v.ladder ? `${v.ladder.base.join()}|${v.ladder.top.join()}` : '';
      if (lk !== o.ladderKey) {
        if (o.ladder) o.group.remove(o.ladder);
        o.ladder = null;
        o.ladderKey = lk;
        if (v.ladder) {
          const b = toThree(v.ladder.base);
          const t = toThree(v.ladder.top);
          const len = b.distanceTo(t);
          const lad = makeLadder(len, !v.ladder.ground);
          lad.position.copy(b);
          lad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), t.clone().sub(b).normalize());
          o.ladder = lad;
          o.group.add(lad);
        }
      }
    }
    for (const [id, o] of this.ops) {
      if (seen.has(id)) continue;
      this.group.remove(o.group);
      if (o.lineMat) {
        trackLineMaterial(o.lineMat, false);
        o.lineMat.dispose();
      }
      o.line?.geometry.dispose();
      this.ops.delete(id);
    }
  }

  private setLine(o: OpVis, v: RescueOpView) {
    if (o.line) {
      o.group.remove(o.line);
      o.line.geometry.dispose();
    }
    o.line = null;
    if (v.path.length < 6) return;
    const p: number[] = [];
    for (let i = 0; i < v.path.length; i += 3) p.push(v.path[i], v.path[i + 2] + 0.12, -v.path[i + 1]);
    if (!o.lineMat) {
      o.lineMat = new LineMaterial({ color: 0xffffff, linewidth: 4, dashed: true, dashSize: 0.9, gapSize: 0.6, transparent: true, opacity: 0.95, depthTest: false, worldUnits: false });
      trackLineMaterial(o.lineMat);
    }
    o.lineMat.color.set(v.leg === 'extract' ? '#a855f7' : '#06b6d4');
    const line = new Line2(new LineGeometry().setPositions(p), o.lineMat);
    line.computeLineDistances();
    line.renderOrder = 35;
    line.frustumCulled = false;
    o.line = line;
    o.group.add(line);
  }

  private currentS(o: OpVis, now: number) {
    const k = Math.min(1, Math.max(0, (now - this.tSnap) / this.interval));
    return o.prevS + (o.nextS - o.prevS) * k;
  }

  private at(o: OpVis, s: number, out = new THREE.Vector3()): THREE.Vector3 {
    const c = o.cum;
    const P = o.path;
    const n = c.length;
    if (!P.length) return out.set(0, 0, 0);
    if (s <= 0) return out.set(P[0], P[2], -P[1]);
    for (let k = 1; k < n; k++) {
      if (c[k] >= s) {
        const u = c[k] > c[k - 1] ? (s - c[k - 1]) / (c[k] - c[k - 1]) : 1;
        const a = (k - 1) * 3;
        const b = k * 3;
        return out.set(P[a] + (P[b] - P[a]) * u, P[a + 2] + (P[b + 2] - P[a + 2]) * u, -(P[a + 1] + (P[b + 1] - P[a + 1]) * u));
      }
    }
    return out.set(P[(n - 1) * 3], P[(n - 1) * 3 + 2], -P[(n - 1) * 3 + 1]);
  }

  /** Direction of travel at s (three.js), and whether that stretch is a ladder. */
  private dirAt(o: OpVis, s: number): { dir: THREE.Vector3; climb: boolean } {
    const a = this.at(o, Math.max(0, s - 0.4));
    const b = this.at(o, s + 0.4);
    const d = b.sub(a);
    const h = Math.hypot(d.x, d.z);
    const climb = Math.abs(d.y) > 1.2 * h && Math.abs(d.y) > 0.2;
    return { dir: d, climb };
  }

  /** Is a point on the raised ladder? (then people climb, facing the building) */
  private onLadder(o: OpVis, p: THREE.Vector3): { yes: boolean; heading: number } {
    const L = o.view.ladder;
    if (!L || L.ext < 0.9) return { yes: false, heading: 0 };
    const a = toThree(L.base);
    const b = toThree(L.top);
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
    const d = a.clone().addScaledVector(ab, t).distanceTo(p);
    return { yes: d < 0.5 && t > 0.01 && t < 0.995, heading: Math.atan2(ab.x, ab.z) };
  }

  frame(dt: number, now: number) {
    const t = now / 1000;
    const tmp = new THREE.Vector3();
    for (const o of this.ops.values()) {
      const v = o.view;
      const s = this.currentS(o, now);
      const len = o.cum.length ? o.cum[o.cum.length - 1] : 0;
      if (o.lineMat) o.lineMat.dashOffset -= dt * 1.5;
      if (o.ladder) {
        const ext = v.ladder ? 0.06 + 0.94 * v.ladder.ext : 0;
        const inner = o.ladder.userData.inner as THREE.Object3D;
        inner.scale.y += (ext - inner.scale.y) * (1 - Math.exp(-dt * 4));
        o.ladder.visible = inner.scale.y > 0.07;
      }
      const showCrew = !v.done && (v.leg !== 'none' || v.phase === 'handover');
      const moving = v.phase === 'entry' || v.phase === 'extract';
      const facingVictims = v.victimAt ? toThree(v.victimAt, new THREE.Vector3()) : null;
      // crew: lead at s, the second one a step behind (or at the back when bringing people out)
      o.crew.forEach((f, i) => {
        f.root.visible = showCrew;
        if (!showCrew) return;
        // bringing people out: one firefighter leads, the other follows the residents with a gap
        // (where the inside camera rides, so the residents are in view)
        const back = v.leg === 'extract' ? (i === 0 ? 0 : 1.1 + Math.max(0, Math.min(3, v.victims) - 1) * 0.95 + 3.0) : i * 1.3;
        const si = Math.max(0, s - back);
        const p = this.at(o, si, tmp.clone());
        const { dir, climb } = this.dirAt(o, si);
        const lad = this.onLadder(o, p);
        let heading = Math.atan2(dir.x, dir.z);
        let mode: 'walk' | 'climb' | 'idle' = moving && si < len - 0.05 && si > 0.01 ? (climb || lad.yes ? 'climb' : 'walk') : 'idle';
        if (lad.yes) heading = lad.heading;
        else if (climb && v.facing) heading = Math.atan2(-v.facing[0], v.facing[1]);
        if (mode === 'idle' && facingVictims) {
          const d = facingVictims.clone().sub(p);
          if (d.lengthSq() > 0.01) heading = Math.atan2(d.x, d.z);
          // stand beside each other, not inside each other
          p.x += Math.cos(heading) * (i === 0 ? 0.35 : -0.35);
          p.z -= Math.sin(heading) * (i === 0 ? 0.35 : -0.35);
        }
        f.pose(p, heading, mode, t);
      });
      // residents: waiting in their room, then in line behind the lead firefighter
      const nV = Math.min(3, v.victims);
      o.victims.forEach((f, i) => {
        const vis = i < nV && !v.done && (v.leg === 'extract' || v.phase === 'handover' || !!v.victimAt);
        f.root.visible = vis;
        if (!vis) return;
        if (v.leg === 'extract' || (v.phase === 'handover' && !v.victimAt)) {
          const si = Math.max(0, s - 1.1 - i * 0.95);
          const p = this.at(o, si, tmp.clone());
          const { dir, climb } = this.dirAt(o, si);
          const lad = this.onLadder(o, p);
          let heading = Math.atan2(dir.x, dir.z);
          if (lad.yes) heading = lad.heading;
          else if (climb && v.facing) heading = Math.atan2(-v.facing[0], v.facing[1]);
          f.pose(p, heading, v.phase === 'extract' && si < len - 0.05 && si > 0.01 ? (climb || lad.yes ? 'climb' : 'walk') : 'idle', t);
        } else if (v.victimAt) {
          const c = toThree(v.victimAt, tmp.clone());
          const ang = (i / Math.max(1, nV)) * Math.PI * 2 + 0.6;
          c.x += Math.cos(ang) * (nV > 1 ? 0.55 : 0);
          c.z += Math.sin(ang) * (nV > 1 ? 0.55 : 0);
          const look = v.roomView ? toThree(v.roomView, new THREE.Vector3()).sub(c) : new THREE.Vector3(0, 0, 1);
          f.pose(c, Math.atan2(look.x, look.z), 'idle', t);
        }
      });
      o.bob = Math.sin(t * 4) * 0.2;
    }
    this.setFigureScale(this.figureScale);
  }

  /**
   * Figures are drawn larger in the overview so they can be found among the buildings,
   * with a marker over the person being rescued; at true size in the inside view.
   */
  setFigureScale(k: number) {
    this.figureScale = k;
    for (const o of this.ops.values()) {
      for (const f of [...o.crew, ...o.victims]) f.root.scale.setScalar(k);
      const lead = o.victims[0];
      o.marker.visible = !!lead && lead.root.visible && k > 1.01;
      if (o.marker.visible) {
        o.marker.position.copy(lead.root.position).add(new THREE.Vector3(0, 2.6 * k + 0.4 + o.bob, 0));
        o.marker.scale.setScalar(k);
      }
    }
  }

  /** Visibility and temperature where the lead person is (for the inside view's smoke). */
  conditions(id: string): { vis: number; temp: number } | null {
    const o = this.ops.get(id);
    return o ? { vis: o.view.vis, temp: o.view.temp } : null;
  }

  /** Path lines on top of walls in the overview; hidden behind walls in the inside view. */
  setOverview(on: boolean) {
    for (const o of this.ops.values()) {
      if (o.lineMat) o.lineMat.depthTest = !on;
    }
  }

  /**
   * Where the inside camera should be for an operation: in the residents' room while
   * they wait, trailing the person being rescued while they move, outside the window
   * while they are on the ladder.
   */
  cameraGoal(id: string, now: number): { pos: THREE.Vector3; look: THREE.Vector3; label: string } | null {
    const o = this.ops.get(id);
    if (!o) return null;
    const v = o.view;
    const s = this.currentS(o, now);
    const len = o.cum.length ? o.cum[o.cum.length - 1] : 0;
    const roomCam = () => {
      if (!v.victimAt || !v.roomView) return null;
      const target = toThree(v.victimAt).add(new THREE.Vector3(0, 0.8, 0));
      const pos = toThree(v.roomView).add(new THREE.Vector3(0, 2.2, 0));
      return { pos, look: target, label: 'In the room with the residents' };
    };
    if (v.leg === 'none' || v.phase === 'search' || (v.leg === 'entry' && s >= len - 0.05)) {
      const rc = roomCam();
      if (rc) return { ...rc, label: v.phase === 'search' ? 'Crew with the residents' : 'Residents waiting for the crew' };
    }
    if (!o.path.length) return null;
    // the person to watch: the first resident coming out, or the lead firefighter going in
    const lead = v.leg === 'extract' ? Math.max(0, s - 1.1) : s;
    const p = this.at(o, lead);
    const lad = this.onLadder(o, p);
    const { climb } = this.dirAt(o, lead);
    if (lad.yes || climb) {
      // on the ladder: film from the side so the climb, the ladder and the building all show
      // out from the facade and a little to one side (the ladder can be near vertical)
      let side = new THREE.Vector3(4, 0, 0);
      if (v.facing) {
        const n = new THREE.Vector3(v.facing[0], 0, -v.facing[1]).normalize();
        side = n.clone().multiplyScalar(5).add(new THREE.Vector3(-n.z, 0, n.x).multiplyScalar(3.2));
      }
      const pos = p.clone().add(side).add(new THREE.Vector3(0, 0.9, 0));
      return { pos, look: p.clone().add(new THREE.Vector3(0, 0.8, 0)), label: v.leg === 'extract' ? 'Coming down the ladder' : 'Climbing the ladder' };
    }
    // just behind the last person in the group, at head height, looking along the path:
    // the path only goes through doorways and up the flights, so the view does not
    // cut through walls at corners the way aiming straight at the lead would
    const nV = Math.min(3, v.victims);
    const tail = v.leg === 'extract' ? 1.1 + Math.max(0, nV - 1) * 0.95 : o.crew.length > 1 ? 1.3 : 0;
    const camS = s - tail - (v.leg === 'extract' ? 1.4 : 1.5);
    const behind = this.at(o, Math.max(0, camS));
    if (camS < 0) {
      const d = this.dirAt(o, 0.5).dir.setY(0).normalize();
      behind.sub(d.multiplyScalar(Math.min(1.5, -camS)));
    }
    const ahead = this.at(o, Math.min(len, Math.max(0, camS) + 3.4));
    const indoor = behind.y > 0.15;
    const pos = behind.add(new THREE.Vector3(0, indoor ? 1.95 : 2.5, 0));
    const look = ahead.add(new THREE.Vector3(0, indoor ? 1.1 : 0.9, 0));
    return { pos, look, label: v.leg === 'extract' ? 'Following the residents out' : 'Following the crew in' };
  }

  /** Where the person being watched is, and whether they are inside the building (not on a ladder). */
  leadInfo(id: string, now: number): { pos: THREE.Vector3; indoor: boolean } | null {
    const o = this.ops.get(id);
    if (!o) return null;
    const v = o.view;
    if (!o.path.length || v.leg === 'none') {
      return v.victimAt ? { pos: toThree(v.victimAt), indoor: v.victimAt[2] > 0.5 } : null;
    }
    const s = this.currentS(o, now);
    const p = this.at(o, v.leg === 'extract' ? Math.max(0, s - 1.1) : s);
    return { pos: p, indoor: p.y > 0.15 && !this.onLadder(o, p).yes };
  }

  /** Scene position of the lead person (for framing the outside view). */
  leadPosition(id: string, now: number): THREE.Vector3 | null {
    const o = this.ops.get(id);
    if (!o || !o.path.length) return o?.view.victimAt ? toThree(o.view.victimAt) : null;
    return this.at(o, this.currentS(o, now));
  }

  has(id: string) {
    return this.ops.has(id);
  }

  clear() {
    for (const o of this.ops.values()) {
      this.group.remove(o.group);
      if (o.lineMat) {
        trackLineMaterial(o.lineMat, false);
        o.lineMat.dispose();
      }
      o.line?.geometry.dispose();
    }
    this.ops.clear();
  }
}
