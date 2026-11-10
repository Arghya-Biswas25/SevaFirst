import type { HazardSpec, Scenario, SiteDataset } from '@twin/twin-schema';
import type { FromWorker, Snapshot, StartOptions, ToWorker } from './protocol';
import { Runner } from './runner';

export * from './protocol';
export { hazards } from './registry';
export { SimEngine, TICK } from './engine';
export { Runner } from './runner';

type ReadyStats = Extract<FromWorker, { type: 'ready' }>['stats'];

/**
 * Main-thread handle to the simulation. Runs the engine in a Web Worker; if the
 * host refuses workers (strict CSP, file://), it falls back to running the same
 * Runner on the main thread so the app still works, only less smoothly.
 */
export class SimClient {
  mode: 'worker' | 'inline' = 'worker';
  private worker: Worker | null = null;
  private inline: Runner | null = null;
  private ready = false;
  private pending: ToWorker[] = [];
  onSnapshot: (s: Snapshot) => void = () => undefined;
  onReady: (stats: ReadyStats, mode: SimClient['mode']) => void = () => undefined;
  onError: (msg: string) => void = () => undefined;

  /**
   * @param opts.createWorker  starts the worker. With Vite:
   *   `import SimWorker from '@twin/sim-runtime/worker?worker&inline'` then `() => new SimWorker()`,
   *   or `() => new Worker(new URL('@twin/sim-runtime/worker', import.meta.url), { type: 'module' })`.
   *   Without a factory the engine runs on the main thread.
   * @param opts.forceInline   skip the worker and run on the main thread.
   */
  constructor(private ds: SiteDataset, opts: { forceInline?: boolean; createWorker?: () => Worker } = {}) {
    if (opts.forceInline || !opts.createWorker) {
      this.goInline(opts.forceInline ? 'inline mode requested' : 'no worker factory given');
      return;
    }
    try {
      this.worker = opts.createWorker();
      this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.receive(ev.data);
      this.worker.onerror = (e) => {
        if (!this.ready) this.goInline(e.message || 'worker failed to load');
        else this.onError(e.message);
      };
      this.worker.postMessage({ type: 'init', ds } satisfies ToWorker);
    } catch (e) {
      this.goInline((e as Error).message);
    }
  }

  private goInline(reason: string) {
    console.warn(`[sim] running inline: ${reason}`);
    this.worker?.terminate();
    this.worker = null;
    this.mode = 'inline';
    this.inline = new Runner((m) => this.receive(m), 120);
    // let the UI paint before the (synchronous) build
    setTimeout(() => this.inline?.handle({ type: 'init', ds: this.ds }), 30);
  }

  private receive(m: FromWorker) {
    if (m.type === 'snapshot') this.onSnapshot(m.snap);
    else if (m.type === 'ready') {
      this.ready = true;
      this.onReady(m.stats, this.mode);
      const p = this.pending;
      this.pending = [];
      p.forEach((x) => this.send(x));
    } else this.onError(m.message);
  }

  private send(m: ToWorker) {
    if (!this.ready) {
      this.pending.push(m);
      return;
    }
    if (this.worker) this.worker.postMessage(m);
    else this.inline?.handle(m);
  }
  start(scenario: Scenario, options: StartOptions) {
    this.send({ type: 'start', scenario, options });
  }
  pause() {
    this.send({ type: 'pause' });
  }
  resume() {
    this.send({ type: 'resume' });
  }
  setSpeed(value: number) {
    this.send({ type: 'speed', value });
  }
  inject(spec: HazardSpec) {
    this.send({ type: 'inject', spec });
  }
  alertAll() {
    this.send({ type: 'alertAll' });
  }
  /** Send a crew to an incident; watch it in the snapshot's `ops`. */
  startRescue(incident: string) {
    this.send({ type: 'rescue', incident });
  }
  stopRescue(op: string) {
    this.send({ type: 'rescueStop', op });
  }
  /** Ask for evacuation and rescue plans for this wing (works while paused). */
  focus(wing: number | null) {
    this.send({ type: 'focus', wing });
  }
  stop() {
    this.send({ type: 'stop' });
  }
  dispose() {
    this.worker?.terminate();
    this.inline?.dispose();
  }
}
