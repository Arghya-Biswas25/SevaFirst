import { memo, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { TwinRenderer, type PickResult } from '@twin/render';
import { CameraController } from '@twin/interaction';
import { twin } from '../app/core';

export interface ViewportApi {
  r: TwinRenderer;
  cam: CameraController;
}

export interface ViewportHandlers {
  onHover: (p: PickResult | null, x: number, y: number) => void;
  onSelect: (p: PickResult | null) => void;
  onContext: (p: PickResult | null, x: number, y: number) => void;
  onWalk: (p: PickResult) => void;
  onCamera: (cam: CameraController) => void;
  onReady: (api: ViewportApi) => void;
}

/**
 * The 3D canvas. Owns the renderer and camera controller for its lifetime and
 * turns pointer input into picks. React never re-renders it; the app talks to it
 * through the ViewportApi handed out in onReady.
 */
export const Viewport = memo(function Viewport(props: ViewportHandlers) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const h = useRef(props);
  h.current = props;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const r = new TwinRenderer(canvas, twin);
    const maxStorey = Math.max(...twin.wings.map((w) => w.storeys)) - 1;
    // frame the whole site: bounding box of the boundary, viewed from the south-east
    const b = twin.ds.site.boundary;
    const E0 = Math.min(...b.map((p) => p[0]));
    const E1 = Math.max(...b.map((p) => p[0]));
    const N0 = Math.min(...b.map((p) => p[1]));
    const N1 = Math.max(...b.map((p) => p[1]));
    const target = new THREE.Vector3((E0 + E1) / 2, 0, -(N0 + N1) / 2);
    const span = Math.max(E1 - E0, N1 - N0);
    const home = { target, position: target.clone().add(new THREE.Vector3(0.36, 0.7, 0.62).normalize().multiplyScalar(span * 1.02)) };
    const cam = new CameraController(r.camera, canvas, { storeyH: twin.storeyH, maxStorey, colliders: () => r.colliders(), home });
    cam.onChange = () => h.current.onCamera(cam);
    let last = performance.now();
    const look = new THREE.Vector3();
    const focus = new THREE.Vector3();
    r.onFrame = () => {
      const now = performance.now();
      cam.update((now - last) / 1000);
      last = now;
      // interiors are drawn around what the camera is looking at
      if (cam.mode === 'orbit') {
        const d = r.camera.position.distanceTo(cam.orbit.target);
        r.setInteriorFocus(cam.orbit.target, THREE.MathUtils.clamp(d * 0.6, 50, 170));
      } else if (cam.mode === 'walk') r.setInteriorFocus(r.camera.position, 45);
      else {
        r.camera.getWorldDirection(look);
        r.setInteriorFocus(focus.copy(r.camera.position).addScaledVector(look, 25), 80);
      }
    };
    r.start();
    const ro = new ResizeObserver(() => r.resize());
    ro.observe(canvas);

    // NDC for the main camera; null over the inside pane of a split rescue view
    const ndc = (e: { clientX: number; clientY: number }) => r.toNdc(e.clientX, e.clientY);
    let down: { x: number; y: number; b: number } | null = null;
    let pending: PointerEvent | null = null;
    let lastPick = 0;
    const hoverTimer = setInterval(() => {
      const e = pending;
      if (!e) return;
      pending = null;
      const now = performance.now();
      if (now - lastPick < 60) return;
      lastPick = now;
      const q = ndc(e);
      const p = q ? r.pick(q[0], q[1]) : null;
      r.setHover(p);
      h.current.onHover(p, e.clientX, e.clientY);
    }, 70);
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return; // no hover picking while dragging
      pending = e;
    };
    const onLeave = () => {
      pending = null;
      r.setHover(null);
      h.current.onHover(null, 0, 0);
    };
    // touch screens have no right button: a 550 ms press without moving opens the menu
    let press: ReturnType<typeof setTimeout> | null = null;
    const cancelPress = () => {
      if (press) clearTimeout(press);
      press = null;
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, b: e.button };
      cancelPress();
      if (e.pointerType === 'touch') {
        const { clientX, clientY } = e;
        press = setTimeout(() => {
          press = null;
          down = null;
          const q = ndc({ clientX, clientY });
          if (q) h.current.onContext(r.pick(q[0], q[1]), clientX, clientY);
        }, 550);
      }
    };
    const onTouchMove = (e: PointerEvent) => {
      if (press && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) cancelPress();
    };
    const onUp = (e: PointerEvent) => {
      cancelPress();
      if (!down || e.button !== 0 || down.b !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const q = ndc(e);
      if (!q) return;
      const p = r.pick(q[0], q[1]);
      h.current.onSelect(p && p.kind !== 'outdoor' ? p : null);
    };
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      const q = ndc(e);
      if (q) h.current.onContext(r.pick(q[0], q[1]), e.clientX, e.clientY);
    };
    const onDbl = (e: MouseEvent) => {
      const q = ndc(e);
      const p = q ? r.pick(q[0], q[1]) : null;
      if (p) h.current.onWalk(p);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointermove', onTouchMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('contextmenu', onCtx);
    canvas.addEventListener('dblclick', onDbl);
    h.current.onReady({ r, cam });
    // handle for automated UI tests and the browser console
    (window as unknown as { __twin: unknown }).__twin = { r, cam, twin, THREE };
    return () => {
      clearInterval(hoverTimer);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointermove', onTouchMove);
      cancelPress();
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('dblclick', onDbl);
      ro.disconnect();
      r.stop();
      cam.dispose();
      r.renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="viewport" tabIndex={0} />;
});
