/**
 * Runner — drives a SimEngine from protocol messages. The worker wraps it, and the
 * inline fallback (used when a host forbids workers) wraps the same code, so both
 * paths behave identically.
 */
import { FixedStep } from '@twin/core';
import { SimEngine, TICK } from './engine';
import type { FromWorker, ToWorker } from './protocol';

export type Post = (m: FromWorker, transfer?: Transferable[]) => void;

export class Runner {
  engine: SimEngine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clock = new FixedStep(TICK, 400);
  private last = 0;
  private lastPost = 0;

  constructor(private post: Post, private postEveryMs = 100) {}

  private publish() {
    if (!this.engine) return;
    const snap = this.engine.snapshot();
    this.post({ type: 'snapshot', snap }, [snap.spaces.ids.buffer, snap.spaces.soot.buffer, snap.spaces.temp.buffer, snap.spaces.burn.buffer, snap.spaces.damage.buffer, snap.groups.buffer, snap.flows.buffer, snap.wingDamage.buffer]);
  }

  private loop() {
    if (this.timer) clearInterval(this.timer);
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const wall = (now - this.last) / 1000;
      this.last = now;
      const e = this.engine;
      if (e?.running) this.clock.advance(wall * e.speed, (dt) => e.step(dt));
      if (e?.running && now - this.lastPost > this.postEveryMs) {
        this.lastPost = now;
        this.publish();
      }
    }, 33);
  }

  handle(m: ToWorker) {
    try {
      const e = this.engine;
      switch (m.type) {
        case 'init': {
          const ng = new SimEngine(m.ds);
          this.engine = ng;
          this.post({ type: 'ready', stats: { spaces: ng.twin.nSpaces, flats: ng.twin.flats.length, navNodes: ng.nav.nodes.length, navEdges: ng.nav.edges.length, buildMs: Math.round(ng.buildMs) } });
          this.loop();
          break;
        }
        case 'start':
          e?.start(m.scenario, m.options);
          this.publish();
          break;
        case 'pause':
          if (e) e.running = false;
          this.publish();
          break;
        case 'resume':
          if (e) e.running = true;
          break;
        case 'speed':
          if (e) e.speed = m.value;
          break;
        case 'inject':
          e?.inject(m.spec);
          break;
        case 'alertAll':
          e?.evac.alertAll(e.t, 30);
          break;
        case 'focus':
          if (e) {
            e.focus(m.wing);
            this.publish();
          }
          break;
        case 'rescue':
          if (e) {
            e.startRescue(m.incident);
            this.publish();
          }
          break;
        case 'rescueStop':
          if (e) {
            e.stopRescue(m.op);
            this.publish();
          }
          break;
        case 'stop':
          if (e) {
            e.running = false;
            e.reset(null, { launchedOnly: false });
          }
          this.publish();
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: (err as Error).message });
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
