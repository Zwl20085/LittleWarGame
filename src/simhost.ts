import type { Command, CommandEnvelope, CommandOutcome } from './sim/commands';
import type { Match } from './sim/sim';
import { applySnapshot, type Snapshot } from './sim/snapshot';
import type { MatchConfig } from './sim/types';
import type { ToWorker } from './sim/sim.worker';

/**
 * Main-thread side of the simulation worker. `match` is a read-only mirror updated from
 * snapshots; rendering and the HUD read it exactly as they read a local simulation.
 */
export class SimHost {
  private readonly worker: Worker;
  private inflight = false;
  ready = false;
  /** performance.now() when the latest snapshot arrived (for interpolation). */
  lastSnapAt = 0;
  lastBatch = 1;
  onCommandResult: ((env: CommandEnvelope, out: CommandOutcome) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  private ffResolve: (() => void) | null = null;

  constructor(readonly match: Match, config: MatchConfig, private readonly observer: number) {
    this.worker = new Worker(new URL('./sim/sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.onError?.(e.message);
    this.post({ t: 'init', config });
  }

  private post(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private onMessage(msg: { t: string; snap?: Snapshot; ran?: number; env?: CommandEnvelope; out?: CommandOutcome; message?: string }): void {
    switch (msg.t) {
      case 'ready':
        this.ready = true;
        break;
      case 'snap':
        applySnapshot(this.match, msg.snap!, this.observer);
        this.inflight = false;
        this.lastSnapAt = performance.now();
        this.lastBatch = Math.max(1, msg.ran ?? 1);
        if (this.ffResolve) {
          const r = this.ffResolve;
          this.ffResolve = null;
          r();
        }
        break;
      case 'cmdResult':
        this.onCommandResult?.(msg.env!, msg.out!);
        break;
      case 'error':
        this.onError?.(msg.message ?? 'simulation error');
        break;
    }
  }

  get busy(): boolean {
    return this.inflight || !this.ready;
  }

  issue(actor: number, cmd: Command): void {
    this.post({ t: 'cmd', actor, cmd });
  }

  /** Ask the worker for `ticks` more ticks; ignored while a batch is still in flight. */
  advance(ticks: number): boolean {
    if (this.busy || ticks <= 0) return false;
    this.inflight = true;
    this.post({ t: 'advance', ticks });
    return true;
  }

  /** Fast-forward up to `seconds` of game time within `budgetMs` of worker time. */
  fastForward(seconds: number, budgetMs = 1500): Promise<void> {
    return new Promise((resolve) => {
      const go = (): void => {
        this.inflight = true;
        this.ffResolve = resolve;
        this.post({ t: 'ff', seconds, budgetMs });
      };
      if (this.ready && !this.inflight) go();
      else {
        const wait = (): void => (this.ready && !this.inflight ? go() : void setTimeout(wait, 20));
        wait();
      }
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
