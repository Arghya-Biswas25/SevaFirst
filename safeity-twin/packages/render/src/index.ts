/**
 * @twin/render — the three.js scene for the township twin.
 *
 * Coordinates: X = east, Y = up, Z = -north (site ENU metres). Buildings are GPU
 * instances of 7 typology shells; interiors are instanced per storey; hazard state,
 * people, vehicles, routes and debris are overlay layers fed by simulation
 * snapshots. The renderer never simulates anything.
 */
import * as THREE from 'three';
import { enToLocal, poseYaw } from '@twin/core';
import { findSpaceAt, spaceLabel, wingStoreyTemplate, type Twin, type WingModel } from '@twin/twin-data';
import { buildInterior, buildShell, flatPolygon, ribbon, BoxBatch, TYPOLOGY_COLORS } from '@twin/geometry';
import type { Snapshot } from '@twin/sim-runtime';
import type { PickOrigin } from '@twin/twin-schema';
import type { PlanRoute, PlanSet, RouteLabel } from '@twin/routing';
import { FlowLayer, PeopleLayer, RouteLayer, setLineResolution, ZoneLayer, type DrawRoute } from './overlays';
import { RescueLayer } from './rescue';

/** A pane of the split rescue view, in CSS pixels relative to the canvas. */
export interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayerName = 'labels' | 'streets' | 'people' | 'hazards' | 'routes' | 'vehicles' | 'assembly' | 'flows' | 'zones';

/** Route colours by label (Routes tab and 3D view share them). */
export const ROUTE_COLORS: Record<RouteLabel, string> = {
  recommended: '#22c55e', fastest: '#f59e0b', safest: '#3b82f6', alternative: '#94a3b8', avoid: '#ef4444',
};
export const RESCUE_COLORS = { approach: '#e11d48', entry: '#06b6d4', extraction: '#a855f7' } as const;

export interface RouteView {
  /** overview: best route of the critical floor of each planned wing; detail: every option of one floor */
  mode: 'overview' | 'detail';
  wing: number | null;
  storey: number | null;
  /** route id or rescue plan id to emphasise */
  highlight: string | null;
}

export const STATUS_COLORS = ['#9aa4ad', '#4aa3ff', '#2ecc71', '#f5a623', '#ff8a3d', '#e5484d', '#b15cff', '#9da7b0', '#7ad3ff'];
const DAMAGE_TINT = ['#ffffff', '#fff1a8', '#ffc07a', '#ff7f70', '#8a7a70'];

interface ShellGroup {
  code: string;
  mesh: THREE.InstancedMesh;
  wings: number[];
}
interface InteriorGroup {
  mesh: THREE.InstancedMesh;
  slots: { wing: number; storey: number }[];
  /** instance index -> slot index (only visible slots are packed into the buffer) */
  visible: number[];
}

interface Particle {
  life: number;
  age: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
  s1: number;
}

const FX_VERT = `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`;
const FX_FRAG = `varying float vA; uniform vec3 uColor; uniform float uSoft;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; if (r > 1.0) discard; float f = pow(1.0 - r, uSoft); gl_FragColor = vec4(uColor, vA * f); }`;

class ParticlePool {
  readonly points: THREE.Points;
  private ps: Particle[] = [];
  private pos: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  constructor(readonly max: number, color: string, additive: boolean, soft: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: FX_VERT, fragmentShader: FX_FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 400 }, uColor: { value: new THREE.Color(color) }, uSoft: { value: soft } },
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    for (let i = 0; i < max; i++) this.ps.push({ life: 0, age: 1, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, s0: 0, s1: 0 });
  }
  set scale(v: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = v;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number) {
    const p = this.ps[this.next];
    this.next = (this.next + 1) % this.max;
    Object.assign(p, { life, age: 0, x, y, z, vx, vy, vz, s0, s1 });
  }
  update(dt: number, wind: THREE.Vector3, peak: number, buoyancyDecay: number) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      const p = this.ps[i];
      if (p.age >= p.life) {
        this.alpha[i] = 0;
        continue;
      }
      any = true;
      p.age += dt;
      const k = Math.min(1, p.age / p.life);
      p.vy *= Math.exp(-buoyancyDecay * dt);
      p.x += (p.vx + wind.x * k) * dt;
      p.y += p.vy * dt;
      p.z += (p.vz + wind.z * k) * dt;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.size[i] = p.s0 + (p.s1 - p.s0) * Math.sqrt(k);
      this.alpha[i] = peak * Math.min(1, p.age / 0.6) * (1 - k);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    this.points.visible = any;
  }
  clear() {
    for (const p of this.ps) p.age = p.life = 0;
    this.alpha.fill(0);
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

export interface PickResult extends PickOrigin {
  wing?: number;
}

export class TwinRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private shells: ShellGroup[] = [];
  private wingSlot = new Map<number, { group: ShellGroup; index: number }>();
  private interiors: InteriorGroup[] = [];
  private interiorRoot = new THREE.Group();
  private ground!: THREE.Mesh;
  private layers: Record<LayerName, THREE.Group> = {
    labels: new THREE.Group(), streets: new THREE.Group(), people: new THREE.Group(), hazards: new THREE.Group(),
    routes: new THREE.Group(), vehicles: new THREE.Group(), assembly: new THREE.Group(), flows: new THREE.Group(), zones: new THREE.Group(),
  };
  private shellMat: THREE.MeshLambertMaterial;
  private interiorMat: THREE.MeshLambertMaterial;
  private clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  private cutStorey: number | null = null;
  private xray = false;
  private interiorsOn = false;
  private hazardBoxes: THREE.InstancedMesh;
  private hazardColor: THREE.InstancedBufferAttribute;
  private people = new PeopleLayer(16000, STATUS_COLORS);
  private flows = new FlowLayer();
  private planRoutes = new RouteLayer();
  private unitRoutes = new RouteLayer();
  private zones: ZoneLayer;
  private plans: PlanSet | null = null;
  private routeView: RouteView = { mode: 'overview', wing: null, storey: null, highlight: null };
  private vehicleMeshes = new Map<string, THREE.Object3D>();
  private vehicles = new Map<string, { obj: THREE.Object3D; from: THREE.Vector3; to: THREE.Vector3; beacons: THREE.Mesh[]; active: boolean; phase: number }>();
  private vehT0 = 0;
  private snapInterval = 110;
  private lastSnapAt = 0;
  private apDiscs = new Map<string, { disc: THREE.Mesh; mat: THREE.MeshLambertMaterial; ring: THREE.Mesh; closed: boolean }>();
  private sway = { uShake: { value: 0 }, uTime: { value: 0 } };
  /** rescue figures, ladders and paths */
  readonly rescue = new RescueLayer();
  /** second camera for the inside view of a rescue */
  readonly insideCam = new THREE.PerspectiveCamera(76, 1, 0.08, 900);
  private insideLook = new THREE.Vector3();
  private insideReady = false;
  private insideFog = new THREE.Fog('#c9d3d8', 1, 220);
  private split: { op: string; outside: PaneRect; inside: PaneRect } | null = null;
  private forcedWings = new Set<number>();
  /** what the inside camera shows now (changes are reported to onInsideLabel) */
  insideLabel = '';
  onInsideLabel: (label: string) => void = () => undefined;
  private shakeTarget = 0;
  private blockedLayer = new THREE.Group();
  private debrisLayer = new THREE.Group();
  private collapsed = new Map<number, { key: string; obj: THREE.Object3D }>();
  private highlight: THREE.LineSegments;
  private selectionBox: THREE.LineSegments;
  private dummy = new THREE.Object3D();
  private smoke = new ParticlePool(900, '#55595e', false, 1.4);
  private flame = new ParticlePool(300, '#ff7a1a', true, 1.1);
  private emitters: { x: number; y: number; z: number; burn: number; acc: number; facc: number }[] = [];
  private wind = new THREE.Vector3(3.4, 0, -1.2);
  private lastFrame = performance.now();
  private frames = 0;
  private fpsT = performance.now();
  fps = 0;
  onFrame: () => void = () => undefined;

  constructor(private canvas: HTMLCanvasElement, readonly twin: Twin) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor('#d6e2ea');
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.3, 6000);
    this.camera.position.set(260, 420, 520);
    this.camera.lookAt(0, 0, -60);
    this.scene.fog = new THREE.Fog('#d6e2ea', 1100, 3200);
    this.scene.add(new THREE.HemisphereLight('#f4f7ff', '#8a8170', 1.05));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.35);
    sun.position.set(-300, 600, 200);
    this.scene.add(sun);
    this.shellMat = new THREE.MeshLambertMaterial({ vertexColors: true, clippingPlanes: [this.clip] });
    this.interiorMat = new THREE.MeshLambertMaterial({ vertexColors: true, clippingPlanes: [this.clip] });
    // earthquake: buildings sway in the vertex shader, more at the top, driven by one uniform
    for (const m of [this.shellMat, this.interiorMat]) {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uShake = this.sway.uShake;
        sh.uniforms.uTime = this.sway.uTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uShake;\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 swayP = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 swayP = vec3(0.0);
          #endif
          float swayH = max(0.0, transformed.y + swayP.y);
          transformed.x += uShake * swayH * 0.016 * sin(uTime * 11.0 + swayP.x * 0.31);
          transformed.z += uShake * swayH * 0.012 * sin(uTime * 8.5 + swayP.z * 0.27 + 1.3);`);
      };
    }
    this.zones = new ZoneLayer((text, color, at) => this.textSprite(text, color, 0.022, at));
    for (const l of Object.values(this.layers)) this.scene.add(l);
    this.scene.add(this.interiorRoot, this.blockedLayer, this.debrisLayer);
    this.interiorRoot.visible = false;
    this.buildSite();
    this.buildBuildings();
    this.buildLabels();
    // hazard overlay boxes with per-instance RGBA
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.hazardColor = new THREE.InstancedBufferAttribute(new Float32Array(8000 * 4), 4);
    boxGeo.setAttribute('aColor', this.hazardColor);
    const hazMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `attribute vec4 aColor; varying vec4 vC; void main(){ vC = aColor; vec4 p = vec4(position,1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p; }`,
      fragmentShader: `varying vec4 vC; void main(){ if (vC.a < 0.01) discard; gl_FragColor = vC; }`,
    });
    this.hazardBoxes = new THREE.InstancedMesh(boxGeo, hazMat, 8000);
    this.hazardBoxes.count = 0;
    this.hazardBoxes.frustumCulled = false;
    this.layers.hazards.add(this.hazardBoxes, this.smoke.points, this.flame.points);
    this.layers.people.add(this.people.mesh);
    // people respect the floor cut, so cutaway views do not leave them floating
    (this.people.mesh.material as THREE.Material).clippingPlanes = [this.clip];
    this.layers.flows.add(this.flows.group);
    this.layers.routes.add(this.planRoutes.group, this.unitRoutes.group);
    this.layers.zones.add(this.zones.group);
    this.scene.add(this.rescue.group);
    // hover and selection outlines
    const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.highlight = new THREE.LineSegments(unit, new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.9 }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 10;
    this.selectionBox = new THREE.LineSegments(unit, new THREE.LineBasicMaterial({ color: '#ffd400', depthTest: false }));
    this.selectionBox.visible = false;
    this.selectionBox.renderOrder = 11;
    this.scene.add(this.highlight, this.selectionBox);
    this.resize();
  }

  // ------------------------------------------------------------------ site
  private buildSite() {
    const ds = this.twin.ds;
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#cfd3c4' }));
    outer.position.y = -0.05;
    this.scene.add(outer);
    this.ground = new THREE.Mesh(flatPolygon(ds.site.boundary, 0), new THREE.MeshLambertMaterial({ color: '#a9bf8c' }));
    this.ground.name = 'ground';
    this.scene.add(this.ground);
    const lag = new THREE.Mesh(flatPolygon(ds.site.lagoon, 0.08), new THREE.MeshLambertMaterial({ color: '#2f8fd8', emissive: '#0a3a66', emissiveIntensity: 0.25 }));
    this.scene.add(lag);
    const deck = new THREE.Mesh(new THREE.RingGeometry(33, 44, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#d9cdb5' }));
    deck.position.y = 0.04;
    this.scene.add(deck);
    const colors = { perimeter: '#4b4f55', street: '#9a9ea3', promenade: '#d3c7ad' } as const;
    const mats = Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, new THREE.MeshLambertMaterial({ color: c })])) as Record<string, THREE.Material>;
    for (const f of ds.streets.features) {
      const m = new THREE.Mesh(ribbon(f.geometry.coordinates, f.properties.class === 'perimeter' ? 10 : Math.min(9, Math.max(5, f.properties.width_m * 0.75)), f.properties.class === 'perimeter' ? 0.06 : 0.05), mats[f.properties.class]);
      this.layers.streets.add(m);
    }
    for (const ap of ds.amenities.assemblyPoints) {
      const mat = new THREE.MeshLambertMaterial({ color: '#21b35b', transparent: true, opacity: 0.55 });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 0.3, 32), mat);
      disc.position.set(ap.E, 0.2, -ap.N);
      const pin = new THREE.Mesh(new THREE.ConeGeometry(1.6, 5, 12), mat);
      pin.rotation.x = Math.PI;
      pin.position.set(ap.E, 9, -ap.N);
      const ring = new THREE.Mesh(new THREE.RingGeometry(9.5, 11, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#e5484d', transparent: true, opacity: 0.8, depthWrite: false }));
      ring.position.set(ap.E, 0.4, -ap.N);
      ring.visible = false;
      this.apDiscs.set(ap.id, { disc, mat, ring, closed: false });
      this.layers.assembly.add(disc, pin, ring, this.textSprite(ap.id, '#0f5a2d', 0.03, [ap.E, 14, -ap.N]));
    }
    for (const g of ds.amenities.gates) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 3), new THREE.MeshLambertMaterial({ color: g.external ? '#d35400' : '#e67e22' }));
      m.position.set(g.E, 2, -g.N);
      this.layers.assembly.add(m, this.textSprite(g.id, '#7a3000', 0.024, [g.E, 8, -g.N]));
    }
  }

  // ------------------------------------------------------------------ buildings
  private poseMatrix(w: WingModel, y = 0, out = new THREE.Matrix4()): THREE.Matrix4 {
    this.dummy.position.set(w.pose.E, y, -w.pose.N);
    this.dummy.rotation.set(0, poseYaw(w.pose), 0);
    this.dummy.scale.set(1, 1, 1);
    this.dummy.updateMatrix();
    return out.copy(this.dummy.matrix);
  }

  private buildBuildings() {
    const twin = this.twin;
    const H = twin.storeyH;
    const byCode = new Map<string, number[]>();
    for (const w of twin.wings) {
      const key = `${w.typology.code}|${w.storeys}|${w.L}`;
      if (!byCode.has(key)) byCode.set(key, []);
      byCode.get(key)!.push(w.idx);
    }
    const m = new THREE.Matrix4();
    for (const [key, wings] of byCode) {
      const w0 = twin.wings[wings[0]];
      const geo = buildShell(w0.typology, w0.tpl, w0.storeys, H, w0.L);
      const mesh = new THREE.InstancedMesh(geo, this.shellMat, wings.length);
      mesh.name = `shell:${key}`;
      const group: ShellGroup = { code: w0.typology.code, mesh, wings };
      wings.forEach((wi, i) => {
        mesh.setMatrixAt(i, this.poseMatrix(twin.wings[wi], 0, m));
        mesh.setColorAt(i, new THREE.Color(twin.wings[wi].status === 'future' ? '#f4f1ea' : '#ffffff'));
        this.wingSlot.set(wi, { group, index: i });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      this.shells.push(group);
      // interiors: one geometry per storey kind, instanced per (wing, storey)
      if (w0.massingOnly) continue;
      const kinds = new Map<string, { wing: number; storey: number }[]>();
      for (const wi of wings) {
        const w = twin.wings[wi];
        for (let s = 0; s < w.storeys; s++) {
          const k = w.storeyKinds[s];
          if (!kinds.has(k)) kinds.set(k, []);
          kinds.get(k)!.push({ wing: wi, storey: s });
        }
      }
      for (const [k, slots] of kinds) {
        const st = k === 'flats' ? w0.tpl.typical : k === 'commercial' ? w0.tpl.commercial : w0.tpl.ground;
        const im = new THREE.InstancedMesh(buildInterior(st, H), this.interiorMat, slots.length);
        im.name = `interior:${key}:${k}`;
        this.interiors.push({ mesh: im, slots, visible: [] });
        this.interiorRoot.add(im);
      }
    }
    this.updateInteriorMatrices();
  }

  /**
   * Interiors are drawn only for wings near the camera's focus. Visible storeys are
   * packed at the front of each instance buffer and `count` trims the draw, so a
   * site of 20,000 rooms costs only what is on screen.
   */
  private updateInteriorMatrices() {
    const m = new THREE.Matrix4();
    const f = this.focus;
    for (const ig of this.interiors) {
      ig.visible.length = 0;
      let n = 0;
      ig.slots.forEach((sl, i) => {
        const w = this.twin.wings[sl.wing];
        if (this.cutStorey !== null && sl.storey > this.cutStorey) return;
        if (this.collapsed.has(sl.wing)) return;
        const dx = w.pose.E - f.x;
        const dz = -w.pose.N - f.z;
        const r = this.focusR + w.L / 2;
        if (!this.forcedWings.has(sl.wing) && dx * dx + dz * dz > r * r) return;
        ig.mesh.setMatrixAt(n, this.poseMatrix(w, sl.storey * this.twin.storeyH, m));
        ig.visible.push(i);
        n++;
      });
      ig.mesh.count = n;
      ig.mesh.instanceMatrix.needsUpdate = true;
      ig.mesh.computeBoundingSphere();
    }
  }

  private focus = new THREE.Vector3(0, 0, -100);
  private focusR = 160;
  /** Where interiors should be shown (orbit target, or the walker's position). */
  setInteriorFocus(p: THREE.Vector3, radius: number) {
    if (p.distanceToSquared(this.focus) < 64 && Math.abs(radius - this.focusR) < 4) return;
    this.focus.copy(p);
    this.focusR = radius;
    if (this.interiorRoot.visible) this.updateInteriorMatrices();
  }

  private textSprite(text: string, color: string, size: number, at: [number, number, number]): THREE.Sprite {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 44px system-ui, sans-serif';
    const w = Math.ceil(ctx.measureText(text).width) + 28;
    c.width = w;
    c.height = 64;
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, 64, 14);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 14, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true, sizeAttenuation: false }));
    // size is a fraction of the viewport height (constant on screen at any zoom)
    s.scale.set((size * w) / 64, size, 1);
    s.position.set(...at);
    return s;
  }

  private buildLabels() {
    for (const w of this.twin.wings) {
      const color = TYPOLOGY_COLORS[w.typology.code] ?? '#333333';
      const s = this.textSprite(w.id.replace(/^R0?/, ''), new THREE.Color(color).multiplyScalar(0.7).getStyle(), 0.024, [w.pose.E, w.height + 4, -w.pose.N]);
      s.name = `label:${w.id}`;
      s.userData.wing = w.idx;
      this.layers.labels.add(s);
    }
  }

  // ------------------------------------------------------------------ view state
  setLayer(name: LayerName, on: boolean) {
    this.layers[name].visible = on;
    if (name === 'streets') this.blockedLayer.visible = on;
  }
  setXray(on: boolean) {
    this.xray = on;
    this.shellMat.transparent = on;
    this.shellMat.opacity = on ? 0.14 : 1;
    this.shellMat.depthWrite = !on;
    this.shellMat.needsUpdate = true;
    this.refreshInteriorVisibility();
  }
  setInteriors(on: boolean) {
    this.interiorsOn = on;
    this.refreshInteriorVisibility();
  }
  /** Hide everything above storey s (null = no cut). */
  setCut(s: number | null) {
    this.cutStorey = s;
    this.clip.constant = s === null ? 1e6 : (s + 1) * this.twin.storeyH - 0.05;
    for (const l of this.layers.labels.children) {
      const w = this.twin.wings[l.userData.wing as number];
      if (w) l.position.y = (s === null ? w.height : Math.min(w.height, (s + 1) * this.twin.storeyH)) + 4;
    }
    this.updateInteriorMatrices();
    this.refreshInteriorVisibility();
  }
  private refreshInteriorVisibility() {
    this.interiorRoot.visible = this.xray || this.interiorsOn || this.cutStorey !== null;
  }

  resize() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const k = h * 0.5 * this.camera.projectionMatrix.elements[5] * Math.min(window.devicePixelRatio, 2);
    this.smoke.scale = k;
    this.flame.scale = k;
    setLineResolution(w, h);
  }

  /** Wind for smoke drift: speed in m/s, direction it blows FROM (degrees from north). */
  setWind(speed_ms: number, fromDeg: number) {
    const b = ((fromDeg + 180) * Math.PI) / 180;
    this.wind.set(Math.sin(b) * speed_ms, 0, -Math.cos(b) * speed_ms);
  }

  // ------------------------------------------------------------------ picking
  pick(ndcX: number, ndcY: number): PickResult | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const targets: THREE.Object3D[] = [];
    if (this.interiorRoot.visible) targets.push(...this.interiors.map((i) => i.mesh));
    if (!this.xray) targets.push(...this.shells.map((s) => s.mesh));
    targets.push(...this.collapsedObjects(), this.ground);
    const hits = this.raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => !(this.cutStorey !== null && h.point.y > (this.cutStorey + 1) * this.twin.storeyH));
    if (!hit) return null;
    const E = hit.point.x;
    const N = -hit.point.z;
    const up = hit.point.y;
    const obj = hit.object as THREE.InstancedMesh;
    let wing: number | undefined;
    let storey: number | undefined;
    if (obj.name.startsWith('shell:') && hit.instanceId !== undefined) {
      const g = this.shells.find((s) => s.mesh === obj)!;
      wing = g.wings[hit.instanceId];
    } else if (obj.name.startsWith('interior:') && hit.instanceId !== undefined) {
      const ig = this.interiors.find((i) => i.mesh === obj)!;
      const sl = ig.slots[ig.visible[hit.instanceId]];
      wing = sl.wing;
      storey = sl.storey;
    } else if (obj.userData.wing !== undefined) {
      wing = obj.userData.wing;
    }
    if (wing === undefined) return { kind: 'outdoor', E, N, up: 0, label: `Outdoors · E ${E.toFixed(0)} m, N ${N.toFixed(0)} m` };
    const w = this.twin.wings[wing];
    if (storey === undefined) {
      const nudged = up - (hit.face && hit.face.normal.y > 0.5 ? 0.3 : 0);
      storey = Math.max(0, Math.min(w.storeys - 1, Math.floor(nudged / this.twin.storeyH)));
    }
    if (w.massingOnly) return { kind: 'building', E, N, up, buildingId: w.id, wing, storey, label: `${w.id} · ${w.typology.name}` };
    const [x, y] = enToLocal(w.pose, E, N);
    const cx = Math.max(-w.L / 2 + 0.05, Math.min(w.L / 2 - 0.05, x));
    const cy = Math.max(-w.W / 2 + 0.05, Math.min(w.W / 2 - 0.05, y));
    const g = findSpaceAt(this.twin, wing, storey, cx, cy);
    if (g < 0) return { kind: 'building', E, N, up, buildingId: w.id, wing, storey, label: `${w.id} · floor ${storey}` };
    return { kind: 'space', E, N, up, buildingId: w.id, wing, storey, spaceId: g, label: spaceLabel(this.twin, g) };
  }

  private collapsedObjects(): THREE.Object3D[] {
    return [...this.collapsed.values()].map((c) => c.obj);
  }

  /** Outline the space (or wing) under the cursor. */
  setHover(p: PickResult | null) {
    this.outline(this.highlight, p);
  }
  setSelection(p: PickResult | null) {
    this.outline(this.selectionBox, p);
  }
  private outline(box: THREE.LineSegments, p: PickResult | null) {
    if (!p || p.wing === undefined) {
      box.visible = false;
      return;
    }
    const w = this.twin.wings[p.wing];
    const H = this.twin.storeyH;
    let cx = 0;
    let cy = 0;
    let sx = w.L;
    let sz = w.W;
    let y0 = 0;
    let sy = w.height;
    if (p.spaceId !== undefined && p.spaceId >= 0) {
      const st = wingStoreyTemplate(w, p.storey!);
      const sp = st.spaces[this.twin.space.t[p.spaceId]];
      cx = (sp.rect[0] + sp.rect[2]) / 2;
      cy = (sp.rect[1] + sp.rect[3]) / 2;
      sx = sp.rect[2] - sp.rect[0];
      sz = sp.rect[3] - sp.rect[1];
      y0 = p.storey! * H;
      sy = H;
    }
    const m = this.poseMatrix(w, 0);
    const local = new THREE.Matrix4().compose(new THREE.Vector3(cx, y0 + sy / 2, -cy), new THREE.Quaternion(), new THREE.Vector3(sx + 0.1, sy + 0.05, sz + 0.1));
    box.matrixAutoUpdate = false;
    box.matrix.copy(m.multiply(local));
    box.visible = true;
  }

  /** Meshes that block walking / solid flying. */
  colliders(): THREE.Object3D[] {
    const out: THREE.Object3D[] = this.shells.map((s) => s.mesh);
    if (this.interiorRoot.visible) out.push(...this.interiors.map((i) => i.mesh));
    out.push(...this.collapsedObjects());
    return out;
  }

  /** Camera target helpers for UI search. */
  wingCenter(id: string): THREE.Vector3 | null {
    const wi = this.twin.wingById.get(id);
    if (wi === undefined) return null;
    const w = this.twin.wings[wi];
    return new THREE.Vector3(w.pose.E, w.height / 2, -w.pose.N);
  }

  // ------------------------------------------------------------------ simulation overlays
  applySnapshot(s: Snapshot) {
    const twin = this.twin;
    const H = twin.storeyH;
    // hazard boxes
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = this.hazardColor.array as Float32Array;
    let n = 0;
    const cap = this.hazardBoxes.instanceMatrix.count;
    for (let k = 0; k < s.spaces.ids.length && n < cap; k++) {
      const g = s.spaces.ids[k];
      const burn = s.spaces.burn[k];
      const soot = s.spaces.soot[k];
      const temp = s.spaces.temp[k];
      const dmg = s.spaces.damage[k];
      if (dmg >= 4) continue;
      let r = 0.45;
      let gg = 0.47;
      let b = 0.5;
      let a = Math.min(0.72, soot * 3.2);
      if (burn === 1 || burn === 2) {
        r = 1;
        gg = burn === 2 ? 0.32 : 0.55;
        b = 0.08;
        a = 0.85;
      } else if (temp > 70) {
        r = 0.85;
        gg = 0.42;
        b = 0.25;
        a = Math.max(a, 0.35);
      } else if (dmg === 3) {
        r = 0.55;
        gg = 0.36;
        b = 0.22;
        a = Math.max(a, 0.25);
      }
      if (a < 0.04) continue;
      const w = twin.wings[twin.space.wing[g]];
      const st = wingStoreyTemplate(w, twin.space.storey[g]);
      const sp = st.spaces[twin.space.t[g]];
      const cx = (sp.rect[0] + sp.rect[2]) / 2;
      const cy = (sp.rect[1] + sp.rect[3]) / 2;
      const yaw = poseYaw(w.pose);
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      // local (cx, -cy) rotated about Y then translated
      const lx = cx;
      const lz = -cy;
      pos.set(w.pose.E + lx * c + lz * sn, twin.space.storey[g] * H + H * 0.5, -w.pose.N - lx * sn + lz * c);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      scl.set(Math.max(0.3, sp.rect[2] - sp.rect[0] - 0.1), H * 0.86, Math.max(0.3, sp.rect[3] - sp.rect[1] - 0.1));
      m.compose(pos, q, scl);
      this.hazardBoxes.setMatrixAt(n, m);
      col[n * 4] = r;
      col[n * 4 + 1] = gg;
      col[n * 4 + 2] = b;
      col[n * 4 + 3] = a;
      n++;
    }
    this.hazardBoxes.count = n;
    this.hazardBoxes.instanceMatrix.needsUpdate = true;
    this.hazardColor.needsUpdate = true;
    // smoke and flame emitters at the facade outside each burning room
    const old = this.emitters;
    this.emitters = [];
    for (let k = 0; k < s.spaces.ids.length && this.emitters.length < 24; k++) {
      const burn = s.spaces.burn[k];
      if (burn !== 1 && burn !== 2) continue;
      const g = s.spaces.ids[k];
      const w = twin.wings[twin.space.wing[g]];
      const sp = wingStoreyTemplate(w, twin.space.storey[g]).spaces[twin.space.t[g]];
      const cx = (sp.rect[0] + sp.rect[2]) / 2;
      const cy = (sp.rect[1] + sp.rect[3]) / 2;
      const fy = (cy >= 0 ? 1 : -1) * (w.W / 2 + 0.4);
      const yaw = poseYaw(w.pose);
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const lz = -fy;
      const x = w.pose.E + cx * c + lz * sn;
      const z = -w.pose.N - cx * sn + lz * c;
      const y = twin.space.storey[g] * H + 1.9;
      const prev = old.find((e) => Math.abs(e.x - x) < 0.5 && Math.abs(e.z - z) < 0.5 && Math.abs(e.y - y) < 0.5);
      this.emitters.push({ x, y, z, burn, acc: prev?.acc ?? 0, facc: prev?.facc ?? 0 });
    }
    // damage tint per wing
    for (const [wi, slot] of this.wingSlot) {
      const d = s.wingDamage[wi] ?? 0;
      const w = twin.wings[wi];
      slot.group.mesh.setColorAt(slot.index, new THREE.Color(d ? DAMAGE_TINT[d] : w.status === 'future' ? '#f4f1ea' : '#ffffff'));
    }
    for (const g of this.shells) if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
    this.updateCollapses(s);
    const now = performance.now();
    const gap = now - this.lastSnapAt;
    if (this.lastSnapAt > 0 && gap > 30 && gap < 1000) this.snapInterval = 0.7 * this.snapInterval + 0.3 * Math.min(320, Math.max(60, gap));
    this.lastSnapAt = now;
    // people: positions go to the GPU once per snapshot, interpolated there every frame
    this.people.update(s.groups, now);
    this.flows.set(s.flows);
    this.zones.set(s.zones);
    if (s.plans) this.setPlans(s.plans);
    this.updateAssembly(s);
    this.shakeTarget = s.shaking;
    // vehicles and responder routes
    this.updateVehicles(s, now);
    this.updateUnitRoutes(s);
    this.updateBlocked(s);
    this.rescue.update(s.ops ?? [], now);
  }

  // ------------------------------------------------------------------ rescue view
  /**
   * Split the view for a rescue: `outside` shows the main (orbit) camera, `inside` a
   * camera that follows the person being rescued through the building. null ends it.
   */
  setRescueView(v: { op: string; wing: number; outside: PaneRect; inside: PaneRect } | null) {
    const was = this.split;
    this.split = v ? { op: v.op, outside: v.outside, inside: v.inside } : null;
    this.forcedWings.clear();
    if (v && v.wing >= 0) this.forcedWings.add(v.wing);
    if (!v || !was || was.op !== v.op) this.insideReady = false;
    this.updateInteriorMatrices();
    if (!v) this.resize();
  }

  /** Where to look from for the outside view of a rescue: the target, and the side to view it from. */
  rescueFraming(op: string): { target: THREE.Vector3; from: THREE.Vector3 } | null {
    const p = this.rescue.leadPosition(op, performance.now());
    if (!p) return null;
    return { target: p.clone().add(new THREE.Vector3(0, 2, 0)), from: new THREE.Vector3(0.45, 0.55, 0.7) };
  }

  /** Canvas client coordinates to NDC for the main camera (null over the inside pane). */
  toNdc(clientX: number, clientY: number): [number, number] | null {
    const b = this.canvas.getBoundingClientRect();
    let x = clientX - b.left;
    let y = clientY - b.top;
    let w = b.width;
    let h = b.height;
    if (this.split) {
      const o = this.split.outside;
      if (x < o.x || x > o.x + o.w || y < o.y || y > o.y + o.h) return null;
      x -= o.x;
      y -= o.y;
      w = o.w;
      h = o.h;
    }
    return [(x / w) * 2 - 1, -(y / h) * 2 + 1];
  }

  private renderSplit(dt: number, now: number) {
    const sp = this.split!;
    const r = this.renderer;
    const H = this.canvas.clientHeight || 600;
    const o = sp.outside;
    const i = sp.inside;
    r.setScissorTest(true);
    // outside: the user's camera
    const aspectO = o.w / Math.max(1, o.h);
    if (Math.abs(this.camera.aspect - aspectO) > 1e-3) {
      this.camera.aspect = aspectO;
      this.camera.updateProjectionMatrix();
    }
    r.setViewport(o.x, H - o.y - o.h, o.w, o.h);
    r.setScissor(o.x, H - o.y - o.h, o.w, o.h);
    const lead = this.rescue.leadInfo(sp.op, now);
    const dist = lead ? this.camera.position.distanceTo(lead.pos) : 60;
    this.rescue.setFigureScale(THREE.MathUtils.clamp(dist / 28, 1, 2.6));
    this.rescue.setOverview(true);
    // while the crew is inside, cut away the floors above them so the outside view sees in
    const keepClip = this.clip.constant;
    const keepInteriors = this.interiorRoot.visible;
    if (lead?.indoor) {
      const H = this.twin.storeyH;
      const storey = Math.max(0, Math.floor((lead.pos.y + 0.2) / H));
      this.clip.constant = Math.min(keepClip, (storey + 1) * H - 0.05);
      this.interiorRoot.visible = true;
    }
    r.render(this.scene, this.camera);
    this.clip.constant = keepClip;
    this.interiorRoot.visible = keepInteriors;
    // inside: follow the rescue
    const goal = this.rescue.cameraGoal(sp.op, now);
    if (goal) {
      if (!this.insideReady || this.insideCam.position.distanceTo(goal.pos) > 30) {
        this.insideCam.position.copy(goal.pos);
        this.insideLook.copy(goal.look);
        this.insideReady = true;
      } else {
        this.insideCam.position.lerp(goal.pos, 1 - Math.exp(-dt * 3.2));
        this.insideLook.lerp(goal.look, 1 - Math.exp(-dt * 5));
      }
      this.insideCam.lookAt(this.insideLook);
      if (goal.label !== this.insideLabel) {
        this.insideLabel = goal.label;
        this.onInsideLabel(goal.label);
      }
    }
    const aspectI = i.w / Math.max(1, i.h);
    if (Math.abs(this.insideCam.aspect - aspectI) > 1e-3) {
      this.insideCam.aspect = aspectI;
      this.insideCam.updateProjectionMatrix();
    }
    // smoke where they are: fog closes in with the visibility
    const c = this.rescue.conditions(sp.op);
    const vis = c ? c.vis : 300;
    const indoor = this.insideCam.position.y > 1.9 || (goal?.look.y ?? 0) > 1.3;
    const far = vis >= 300 ? (indoor ? 60 : 260) : THREE.MathUtils.clamp(vis * 1.6, 3, 80);
    const fog = this.insideFog;
    fog.far += (far - fog.far) * (1 - Math.exp(-dt * 2));
    fog.near = Math.min(fog.far * 0.15, 4);
    const hot = c && c.temp > 60;
    fog.color.set(vis < 30 ? (hot ? '#4a3427' : '#43474b') : indoor ? '#b9c2c8' : '#cdd7dd');
    const keep = {
      interiors: this.interiorRoot.visible, clip: this.clip.constant, fog: this.scene.fog, labels: this.layers.labels.visible, routes: this.layers.routes.visible,
      zones: this.layers.zones.visible, assembly: this.layers.assembly.visible, opacity: this.shellMat.opacity, depthWrite: this.shellMat.depthWrite, clear: r.getClearColor(new THREE.Color()),
    };
    this.interiorRoot.visible = true;
    this.clip.constant = 1e6;
    this.scene.fog = fog;
    this.layers.labels.visible = false;
    this.layers.routes.visible = false;
    this.layers.zones.visible = false;
    this.layers.assembly.visible = false;
    this.shellMat.opacity = 1;
    this.shellMat.depthWrite = true;
    r.setClearColor(fog.color);
    this.rescue.setFigureScale(1);
    this.rescue.setOverview(false);
    r.setViewport(i.x, H - i.y - i.h, i.w, i.h);
    r.setScissor(i.x, H - i.y - i.h, i.w, i.h);
    r.render(this.scene, this.insideCam);
    this.interiorRoot.visible = keep.interiors;
    this.clip.constant = keep.clip;
    this.scene.fog = keep.fog;
    this.layers.labels.visible = keep.labels;
    this.layers.routes.visible = keep.routes;
    this.layers.zones.visible = keep.zones;
    this.layers.assembly.visible = keep.assembly;
    this.shellMat.opacity = keep.opacity;
    this.shellMat.depthWrite = keep.depthWrite;
    r.setClearColor(keep.clear);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.canvas.clientWidth || 800, H);
  }

  private updateAssembly(s: Snapshot) {
    for (const a of s.evac.assembly) {
      const d = this.apDiscs.get(a.id);
      if (!d) continue;
      const load = (a.persons + a.inbound) / Math.max(1, a.capacity);
      d.mat.color.set(!a.open ? '#e5484d' : load >= 0.95 ? '#f97316' : load >= 0.8 ? '#f2b705' : '#21b35b');
      d.closed = !a.open;
      d.ring.visible = !a.open;
    }
  }

  private updateVehicles(s: Snapshot, now: number) {
    const seen = new Set<string>();
    for (const r of s.resources) {
      if (r.status === 'offsite' || r.status === 'called') continue;
      seen.add(r.id);
      let v = this.vehicles.get(r.id);
      const target = new THREE.Vector3(r.E, 0, -r.N);
      if (!v) {
        const obj = this.makeVehicle(r.kind);
        obj.add(this.textSprite(r.id, '#222222', 0.02, [0, 6, 0]));
        const beacons: THREE.Mesh[] = [];
        if (r.kind === 'fire_tender' || r.kind === 'ambulance' || r.kind === 'rescue_team') {
          const top = r.kind === 'fire_tender' ? 3.5 : r.kind === 'ambulance' ? 3.0 : 2.5;
          for (const [x, c] of [[-0.6, '#ff2a2a'], [0.6, '#2a6bff']] as const) {
            const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), new THREE.MeshBasicMaterial({ color: c }));
            b.position.set(x, top, r.kind === 'fire_tender' ? 3.2 : 2.2);
            obj.add(b);
            beacons.push(b);
          }
        }
        obj.position.copy(target);
        this.vehicleMeshes.set(r.id, obj);
        this.layers.vehicles.add(obj);
        v = { obj, from: target.clone(), to: target.clone(), beacons, active: true, phase: Math.random() * 6 };
        this.vehicles.set(r.id, v);
      }
      // continue from where it is drawn now; teleports (arrival at the gate) snap
      if (!v.obj.visible || v.obj.position.distanceTo(target) > 60) v.obj.position.copy(target);
      v.from.copy(v.obj.position);
      v.to.copy(target);
      v.active = r.status === 'enroute' || r.status === 'onscene';
    }
    this.vehT0 = now;
    for (const [id, v] of this.vehicles) v.obj.visible = seen.has(id);
  }

  private animateVehicles(dt: number, now: number) {
    const k = Math.min(1, (now - this.vehT0) / this.snapInterval);
    const turn = 1 - Math.exp(-dt * 6);
    for (const v of this.vehicles.values()) {
      if (!v.obj.visible) continue;
      v.obj.position.lerpVectors(v.from, v.to, k);
      const dx = v.to.x - v.from.x;
      const dz = v.to.z - v.from.z;
      if (dx * dx + dz * dz > 0.0025) {
        const target = Math.atan2(dx, dz);
        let d = target - v.obj.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.obj.rotation.y += d * turn;
      }
      const on = Math.sin(now * 0.014 + v.phase) > 0;
      v.beacons.forEach((b, i) => (b.visible = v.active && (i === 0 ? on : !on)));
    }
  }

  // ------------------------------------------------------------------ plans and routes
  /** Latest evacuation and rescue plans from the simulation. */
  setPlans(p: PlanSet | null) {
    this.plans = p;
    this.rebuildPlanRoutes();
  }

  setRouteView(v: RouteView) {
    this.routeView = v;
    this.rebuildPlanRoutes();
  }

  private rebuildPlanRoutes() {
    const p = this.plans;
    const v = this.routeView;
    if (!p) {
      this.planRoutes.clear();
      return;
    }
    const out: DrawRoute[] = [];
    const color = (r: PlanRoute) => ROUTE_COLORS[r.labels[0]] ?? '#94a3b8';
    const rescue = (rp: PlanSet['rescues'][number], strong: boolean, onTop: boolean) => {
      const w = strong ? 6 : 3;
      if (rp.approach && rp.approach.pts.length >= 6) out.push({ id: `${rp.id}:a`, pts: rp.approach.pts, color: RESCUE_COLORS.approach, width: w, dashed: true, onTop, opacity: strong ? 1 : 0.8, ends: strong });
      if (rp.entry) out.push({ id: `${rp.id}:e`, pts: rp.entry.pts, color: RESCUE_COLORS.entry, width: w, dashed: true, onTop, opacity: strong ? 1 : 0.85, ends: strong });
      if (rp.extraction && strong) out.push({ id: `${rp.id}:x`, pts: rp.extraction.pts, color: RESCUE_COLORS.extraction, width: w - 1, dashed: true, onTop, opacity: 0.95, ends: true });
    };
    if (v.mode === 'detail' && v.wing !== null) {
      const wp = p.wings.find((w) => w.wing === v.wing);
      const fp = wp?.floors.find((f) => f.storey === (v.storey ?? wp.critical)) ?? wp?.floors.find((f) => f.storey === wp.critical);
      const hl = v.highlight;
      const rescueHl = p.rescues.find((r) => r.id === hl);
      if (fp) {
        const routes = [...fp.routes].sort((a, b) => (a.id === hl ? 1 : 0) - (b.id === hl ? 1 : 0));
        for (const r of routes) {
          const strong = hl ? r.id === hl : r.id === fp.best;
          out.push({ id: r.id, pts: r.pts, color: color(r), width: strong ? 7 : 3.5, dashed: true, onTop: true, opacity: rescueHl ? 0.25 : strong ? 1 : 0.55, ends: strong });
        }
      }
      for (const rp of p.rescues) if (rp.wing === v.wing || rp.id === hl) rescue(rp, rp.id === hl, true);
    } else {
      for (const wp of p.wings) {
        const fp = wp.floors.find((f) => f.storey === wp.critical);
        const best = fp?.routes.find((r) => r.id === fp.best);
        if (best) out.push({ id: best.id, pts: best.pts, color: color(best), width: 5, dashed: true, onTop: false, opacity: 0.95, ends: true });
      }
      for (const rp of p.rescues) rescue(rp, false, false);
    }
    this.planRoutes.set(out, `${p.version}|${v.mode}|${v.wing}|${v.storey}|${v.highlight}`);
  }

  /** Responder drive routes (enroute units), rebuilt only when they change. */
  private updateUnitRoutes(s: Snapshot) {
    const list = s.resources.filter((r) => r.route.length >= 2);
    const sig = list.map((r) => `${r.id}:${r.route.length}:${r.route[r.route.length - 1][0].toFixed(0)}`).join('|');
    this.unitRoutes.set(
      list.map((r) => ({ id: r.id, pts: r.route.flatMap(([E, N]) => [E, N, 1.0]), color: RESCUE_COLORS.approach, width: 3, dashed: true, opacity: 0.85 })),
      sig,
    );
  }

  private makeVehicle(kind: string): THREE.Object3D {
    const g = new THREE.Group();
    if (kind === 'fire_tender') {
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.0, 8), new THREE.MeshLambertMaterial({ color: '#d7261e' }));
      b.position.y = 1.6;
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 7), new THREE.MeshLambertMaterial({ color: '#e0e0e0' }));
      l.position.y = 3.3;
      g.add(b, l);
    } else if (kind === 'ambulance') {
      const b = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.7, 6), new THREE.MeshLambertMaterial({ color: '#f5f5f5' }));
      b.position.y = 1.45;
      const s = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.35, 6.05), new THREE.MeshLambertMaterial({ color: '#d32f2f' }));
      s.position.y = 1.6;
      g.add(b, s);
    } else {
      const c = kind === 'technician' ? '#f2b705' : kind === 'rescue_team' ? '#ff6f00' : '#1565c0';
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 16), new THREE.MeshLambertMaterial({ color: c }));
      m.position.y = 1.1;
      g.add(m);
    }
    return g;
  }

  private blockedKey = '';
  private updateBlocked(s: Snapshot) {
    const key = s.blockedStreets.join(',') + '|' + s.debris.length;
    if (key === this.blockedKey) return;
    this.blockedKey = key;
    this.blockedLayer.clear();
    this.debrisLayer.clear();
    const mat = new THREE.MeshBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.75 });
    for (const i of s.blockedStreets) {
      const f = this.twin.ds.streets.features[i];
      this.blockedLayer.add(new THREE.Mesh(ribbon(f.geometry.coordinates, 3, 0.12), mat));
    }
    const dmat = new THREE.MeshLambertMaterial({ color: '#8d7b68', transparent: true, opacity: 0.85 });
    for (const d of s.debris) this.debrisLayer.add(new THREE.Mesh(flatPolygon(d.poly, 0.1), dmat));
  }

  /** Replace instanced wings that have collapsed spaces with a broken massing + rubble. */
  private updateCollapses(s: Snapshot) {
    const twin = this.twin;
    const H = twin.storeyH;
    const byWing = new Map<number, Set<number>>();
    for (let k = 0; k < s.spaces.ids.length; k++) {
      if (s.spaces.damage[k] < 4) continue;
      const g = s.spaces.ids[k];
      const w = twin.space.wing[g];
      if (!byWing.has(w)) byWing.set(w, new Set());
      byWing.get(w)!.add(g);
    }
    let changed = false;
    for (const [wi, set] of byWing) {
      const key = String(set.size);
      if (this.collapsed.get(wi)?.key === key) continue;
      const old = this.collapsed.get(wi);
      if (old) this.scene.remove(old.obj);
      const w = twin.wings[wi];
      const b = new BoxBatch();
      const concrete = new THREE.Color('#bdb6a8');
      const rubble = new THREE.Color('#857869');
      const failedCells: [number, number, number][] = [];
      for (let st = 0; st < w.storeys; st++) {
        const tpl = wingStoreyTemplate(w, st);
        for (const sp of tpl.spaces) {
          const g = w.storeyOffsets[st] + sp.i;
          if (set.has(g)) {
            if (st === 0 || ![...set].some((x) => twin.space.storey[x] === st - 1 && twin.space.t[x] === sp.i)) failedCells.push([sp.rect[0], sp.rect[2], st]);
            continue;
          }
          b.rect([sp.rect[0] + 0.05, sp.rect[1] + 0.05, sp.rect[2] - 0.05, sp.rect[3] - 0.05], st * H + 0.2, st * H + H - 0.1, concrete);
        }
      }
      // rubble pile across failed spans
      let seed = wi * 9973;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const spans = failedCells.slice(0, 400);
      for (const [x0, x1] of spans) {
        for (let k = 0; k < 3; k++) {
          const cx = x0 + rnd() * (x1 - x0);
          const cz = (rnd() - 0.5) * (w.W + 6);
          const h = 0.8 + rnd() * 3.5;
          b.box(cx, h / 2, cz, 1 + rnd() * 3, h, 1 + rnd() * 3, rubble);
        }
      }
      const mesh = new THREE.Mesh(b.geometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.applyMatrix4(this.poseMatrix(w, 0));
      mesh.userData.wing = wi;
      this.scene.add(mesh);
      this.collapsed.set(wi, { key, obj: mesh });
      const slot = this.wingSlot.get(wi);
      if (slot) {
        slot.group.mesh.setMatrixAt(slot.index, new THREE.Matrix4().makeScale(0, 0, 0));
        slot.group.mesh.instanceMatrix.needsUpdate = true;
      }
      changed = true;
    }
    // restore wings whose collapse was reset
    for (const [wi, c] of [...this.collapsed]) {
      if (byWing.has(wi)) continue;
      this.scene.remove(c.obj);
      this.collapsed.delete(wi);
      const slot = this.wingSlot.get(wi)!;
      slot.group.mesh.setMatrixAt(slot.index, this.poseMatrix(this.twin.wings[wi], 0));
      slot.group.mesh.instanceMatrix.needsUpdate = true;
      changed = true;
    }
    if (changed) this.updateInteriorMatrices();
  }

  private animateFx(dt: number) {
    for (const e of this.emitters) {
      const strong = e.burn === 2;
      e.acc += dt * (strong ? 9 : 4);
      e.facc += dt * (strong ? 16 : 7);
      while (e.acc >= 1) {
        e.acc -= 1;
        const j = () => (Math.random() - 0.5) * 1.6;
        this.smoke.emit(e.x + j(), e.y + 0.6, e.z + j(), j() * 0.3, 2.6 + Math.random() * 1.4, j() * 0.3, 11 + Math.random() * 6, strong ? 3.2 : 2.2, strong ? 19 : 12);
      }
      while (e.facc >= 1) {
        e.facc -= 1;
        const j = () => (Math.random() - 0.5) * 1.2;
        this.flame.emit(e.x + j(), e.y - 0.4, e.z + j(), j() * 0.4, 2.2 + Math.random() * 1.6, j() * 0.4, 0.55 + Math.random() * 0.4, strong ? 2.6 : 1.6, 0.6);
      }
    }
    this.smoke.update(dt, this.wind, 0.5, 0.18);
    this.flame.update(dt, this.wind.clone().multiplyScalar(0.2), 0.85, 0.5);
  }

  resetOverlays() {
    this.emitters = [];
    this.smoke.clear();
    this.flame.clear();
    this.hazardBoxes.count = 0;
    this.people.clear();
    this.flows.clear();
    this.zones.clear();
    this.planRoutes.clear();
    this.unitRoutes.clear();
    this.plans = null;
    this.rescue.clear();
    this.setRescueView(null);
    this.shakeTarget = 0;
    this.sway.uShake.value = 0;
    for (const d of this.apDiscs.values()) {
      d.mat.color.set('#21b35b');
      d.ring.visible = false;
      d.closed = false;
    }
    for (const [, v] of this.vehicleMeshes) v.visible = false;
    this.blockedLayer.clear();
    this.debrisLayer.clear();
    this.blockedKey = '';
    const empty = { ids: new Int32Array(0), soot: new Float32Array(0), temp: new Float32Array(0), burn: new Uint8Array(0), damage: new Uint8Array(0) };
    this.updateCollapses({ spaces: empty } as unknown as Snapshot);
    for (const [wi, slot] of this.wingSlot) slot.group.mesh.setColorAt(slot.index, new THREE.Color(this.twin.wings[wi].status === 'future' ? '#f4f1ea' : '#ffffff'));
    for (const g of this.shells) if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ loop
  private running = false;
  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.onFrame();
      const now0 = performance.now();
      const dt = Math.min(0.1, (now0 - this.lastFrame) / 1000);
      this.lastFrame = now0;
      if (this.layers.hazards.visible) this.animateFx(dt);
      this.people.frame(now0, THREE.MathUtils.clamp(this.camera.position.y / 50, 1, 4));
      if (this.layers.flows.visible) this.flows.frame(dt, now0);
      this.planRoutes.frame(dt);
      this.unitRoutes.frame(dt);
      if (this.layers.zones.visible) this.zones.frame(dt);
      this.animateVehicles(dt, now0);
      this.rescue.frame(dt, now0);
      // building sway eases in and out with the shaking
      this.sway.uShake.value += (this.shakeTarget - this.sway.uShake.value) * (1 - Math.exp(-dt * 4));
      if (this.sway.uShake.value < 0.002 && this.shakeTarget === 0) this.sway.uShake.value = 0;
      this.sway.uTime.value = now0 / 1000;
      const pulse = 1 + 0.12 * Math.sin(now0 * 0.006);
      for (const d of this.apDiscs.values()) if (d.closed) d.ring.scale.setScalar(pulse);
      if (this.split) this.renderSplit(dt, now0);
      else {
        this.rescue.setFigureScale(THREE.MathUtils.clamp(this.camera.position.y / 30, 1, 2.6));
        this.rescue.setOverview(true);
        this.renderer.render(this.scene, this.camera);
      }
      this.frames++;
      const now = performance.now();
      if (now - this.fpsT > 1000) {
        this.fps = Math.round((this.frames * 1000) / (now - this.fpsT));
        this.frames = 0;
        this.fpsT = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() {
    this.running = false;
  }
  stats() {
    const info = this.renderer.info;
    return { fps: this.fps, calls: info.render.calls, triangles: info.render.triangles };
  }
}
