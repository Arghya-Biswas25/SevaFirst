/// <reference lib="webworker" />
/**
 * Simulation worker: the main thread only renders. The runner advances the engine
 * on a fixed 0.5 s tick, scaled by the chosen speed, and posts snapshots at ~10 Hz
 * with their typed arrays transferred (zero-copy).
 */
import { Runner } from './runner';
import type { ToWorker } from './protocol';

const runner = new Runner((m, transfer = []) => (self as unknown as Worker).postMessage(m, transfer));
self.onmessage = (ev: MessageEvent<ToWorker>) => runner.handle(ev.data);
