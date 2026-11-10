/**
 * @twin/interaction — camera modes for the twin.
 *
 *  orbit  site/building overview. Left-drag rotates, middle-drag or Shift+left pans,
 *         wheel zooms to the cursor. Right button is left free for the context menu.
 *  fly    "hover" through and around buildings. Left-drag looks, WASD moves along
 *         the view, Q/E down/up, Shift is faster, wheel changes speed. Ghost mode
 *         passes through walls; solid mode stops at walls and slabs.
 *  walk   eye height 1.6 m on a storey. WASD walks, left-drag looks, PgUp/PgDn (or
 *         R/F) change storey. Walls stop you; door openings let you through.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type CameraMode = 'orbit' | 'fly' | 'walk';

export interface ControllerOptions {
  storeyH: number;
  maxStorey: number;
  /** Meshes that block movement in solid fly mode and in walk mode. */
  colliders: () => THREE.Object3D[];
  /** Overview framing: orbit target and camera position (three.js coordinates). */
  home: { target: THREE.Vector3; position: THREE.Vector3 };
}

interface Tween {
  t: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
}

const EYE = 1.6;
const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export const KEY_HELP: Record<CameraMode, string> = {
  orbit: 'Drag to turn · Shift-drag to move · Scroll to zoom · Right-click to start an incident · Double-click to walk in',
  fly: 'Drag to look · W A S D to fly · Q and E down and up · Shift for speed · G to go through walls or not',
  walk: 'Drag to look · W A S D to walk · Page Up and Page Down (or R and F) to change floor · Shift to run',
};

export class CameraController {
  mode: CameraMode = 'orbit';
  readonly orbit: OrbitControls;
  /** Fly mode passes through geometry when true. */
  ghost = true;
  flySpeed = 14;
  storey = 0;
  onChange: () => void = () => undefined;
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private tween: Tween | null = null;
  private ray = new THREE.Raycaster();
  private disposers: (() => void)[] = [];

  constructor(readonly camera: THREE.PerspectiveCamera, readonly dom: HTMLElement, private opts: ControllerOptions) {
    const o = new OrbitControls(camera, dom);
    o.enableDamping = true;
    o.dampingFactor = 0.12;
    o.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    o.screenSpacePanning = false;
    o.maxPolarAngle = Math.PI * 0.495;
    o.minDistance = 3;
    o.maxDistance = 2400;
    o.zoomToCursor = true;
    camera.position.copy(opts.home.position);
    o.target.copy(opts.home.target);
    o.update();
    this.orbit = o;
    camera.rotation.order = 'YXZ';
    const on = <K extends keyof WindowEventMap>(t: EventTarget, type: K, fn: (e: WindowEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(dom, 'pointerdown', (e) => {
      if (this.mode === 'orbit' || e.button !== 0) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    on(window, 'pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.0042;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0042, -1.45, 1.45);
    });
    on(window, 'pointerup', () => (this.dragging = false));
    on(dom, 'wheel', (e) => {
      if (this.mode !== 'fly') return;
      e.preventDefault();
      this.flySpeed = THREE.MathUtils.clamp(this.flySpeed * (e.deltaY > 0 ? 0.85 : 1.18), 1, 120);
      this.onChange();
    });
    on(window, 'keydown', (e) => {
      if (isTyping(e)) return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (this.mode === 'walk' && (k === 'pageup' || k === 'r')) this.changeStorey(1);
      if (this.mode === 'walk' && (k === 'pagedown' || k === 'f')) this.changeStorey(-1);
      if (this.mode === 'fly' && k === 'g') {
        this.ghost = !this.ghost;
        this.onChange();
      }
      if (this.mode !== 'orbit' && ['w', 'a', 's', 'd', 'q', 'e', 'pageup', 'pagedown', ' '].includes(k)) e.preventDefault();
    });
    on(window, 'keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.orbit.dispose();
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;
    this.tween = null;
    if (mode === 'orbit') {
      // orbit around a point ahead of the camera
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const ahead = this.camera.position.clone().add(dir.multiplyScalar(prev === 'walk' ? 25 : 60));
      ahead.y = Math.max(0, Math.min(ahead.y, 24));
      this.orbit.target.copy(ahead);
      if (this.camera.position.y < 4) this.camera.position.y = 30;
      this.orbit.enabled = true;
      this.orbit.update();
    } else {
      this.orbit.enabled = false;
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.yaw = e.y;
      this.pitch = THREE.MathUtils.clamp(e.x, -1.45, 1.45);
      if (mode === 'walk') {
        this.storey = THREE.MathUtils.clamp(Math.floor(this.camera.position.y / this.opts.storeyH), 0, this.opts.maxStorey);
        this.camera.position.y = this.storey * this.opts.storeyH + EYE;
        this.pitch = 0;
      }
    }
    this.onChange();
  }

  /** Stand at a site point (E, N) on a storey, looking along `yaw` (radians, three.js). */
  walkAt(E: number, N: number, storey: number, yaw?: number) {
    this.setMode('walk');
    this.storey = THREE.MathUtils.clamp(storey, 0, this.opts.maxStorey);
    this.camera.position.set(E, this.storey * this.opts.storeyH + EYE, -N);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = 0;
    this.onChange();
  }

  changeStorey(d: number) {
    this.storey = THREE.MathUtils.clamp(this.storey + d, 0, this.opts.maxStorey);
    this.camera.position.y = this.storey * this.opts.storeyH + EYE;
    this.onChange();
  }

  /**
   * Smoothly move the orbit camera to look at `target` from `dist` metres, from the
   * current direction or from `from` (a direction pointing from the target to the camera).
   */
  flyTo(target: THREE.Vector3, dist = 70, from?: THREE.Vector3) {
    if (this.mode !== 'orbit') this.setMode('orbit');
    const dir = from ? from.clone() : this.camera.position.clone().sub(this.orbit.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.55, 0.62, 0.55);
    dir.normalize();
    if (dir.y < 0.35) {
      dir.y = 0.35;
      dir.normalize();
    }
    this.tween = { t: 0, dur: 0.9, fromPos: this.camera.position.clone(), toPos: target.clone().add(dir.multiplyScalar(dist)), fromTarget: this.orbit.target.clone(), toTarget: target.clone() };
  }

  view(preset: 'home' | 'top') {
    if (this.mode !== 'orbit') this.setMode('orbit');
    const h = this.opts.home;
    const target = h.target.clone();
    const span = h.position.distanceTo(h.target);
    const toPos = preset === 'top' ? target.clone().add(new THREE.Vector3(0, span * 1.25, 0.01)) : h.position.clone();
    this.tween = { t: 0, dur: 1.0, fromPos: this.camera.position.clone(), toPos, fromTarget: this.orbit.target.clone(), toTarget: target };
  }

  private blocked(from: THREE.Vector3, dir: THREE.Vector3, dist: number): boolean {
    const colliders = this.opts.colliders();
    if (!colliders.length) return false;
    this.ray.set(from, dir);
    this.ray.near = 0;
    this.ray.far = dist + 0.35;
    return this.ray.intersectObjects(colliders, false).length > 0;
  }

  private moveSolid(delta: THREE.Vector3, probeY: number) {
    const len = delta.length();
    if (len < 1e-6) return;
    const from = this.camera.position.clone();
    from.y = probeY;
    const dir = delta.clone().normalize();
    if (!this.blocked(from, dir, len)) {
      this.camera.position.add(delta);
      return;
    }
    // slide along whichever axis is free
    for (const axis of [new THREE.Vector3(delta.x, 0, 0), new THREE.Vector3(0, 0, delta.z)]) {
      const l = axis.length();
      if (l < 1e-6) continue;
      if (!this.blocked(from, axis.clone().normalize(), l)) {
        this.camera.position.add(axis);
        return;
      }
    }
  }

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      const s = k * k * (3 - 2 * k);
      this.camera.position.lerpVectors(tw.fromPos, tw.toPos, s);
      this.orbit.target.lerpVectors(tw.fromTarget, tw.toTarget, s);
      if (k >= 1) this.tween = null;
    }
    if (this.mode === 'orbit') {
      // keyboard panning on the ground plane
      const k = this.keys;
      const mv = new THREE.Vector3();
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      dir.y = 0;
      if (dir.lengthSq() > 1e-6) dir.normalize();
      const right = new THREE.Vector3(-dir.z, 0, dir.x);
      if (k.has('w') || k.has('arrowup')) mv.add(dir);
      if (k.has('s') || k.has('arrowdown')) mv.sub(dir);
      if (k.has('d') || k.has('arrowright')) mv.add(right);
      if (k.has('a') || k.has('arrowleft')) mv.sub(right);
      if (mv.lengthSq() > 0) {
        const dist = this.camera.position.distanceTo(this.orbit.target);
        mv.normalize().multiplyScalar(dt * Math.max(20, dist * 0.9) * (k.has('shift') ? 2.5 : 1));
        this.camera.position.add(mv);
        this.orbit.target.add(mv);
      }
      this.orbit.update();
      return;
    }
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const k = this.keys;
    const fast = k.has('shift') ? 3 : 1;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (this.mode === 'fly') {
      const look = new THREE.Vector3();
      this.camera.getWorldDirection(look);
      const mv = new THREE.Vector3();
      if (k.has('w')) mv.add(look);
      if (k.has('s')) mv.sub(look);
      if (k.has('d')) mv.add(right);
      if (k.has('a')) mv.sub(right);
      if (k.has('e') || k.has(' ')) mv.y += 1;
      if (k.has('q')) mv.y -= 1;
      if (mv.lengthSq() === 0) return;
      mv.normalize().multiplyScalar(this.flySpeed * fast * dt);
      if (this.ghost) this.camera.position.add(mv);
      else this.moveSolid(mv, this.camera.position.y);
      this.camera.position.y = Math.max(0.6, this.camera.position.y);
      return;
    }
    // walk
    const mv = new THREE.Vector3();
    if (k.has('w') || k.has('arrowup')) mv.add(fwd);
    if (k.has('s') || k.has('arrowdown')) mv.sub(fwd);
    if (k.has('d') || k.has('arrowright')) mv.add(right);
    if (k.has('a') || k.has('arrowleft')) mv.sub(right);
    if (mv.lengthSq() === 0) return;
    mv.normalize().multiplyScalar(1.5 * fast * dt);
    this.moveSolid(mv, this.storey * this.opts.storeyH + 1.1);
    this.camera.position.y = this.storey * this.opts.storeyH + EYE;
  }
}
