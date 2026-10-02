/// <reference lib="webworker" />
import { loadGameData } from '../data';
import { CommandBus, type Command } from './commands';
import { createMatch, step, type Match } from './sim';
import { makeSnapshot, newCursor } from './snapshot';
import type { MatchConfig } from './types';

/**
 * Simulation worker: owns the authoritative Match on its own core. The main thread sends
 * commands and "advance N ticks" requests and receives compact snapshots back.
 */
export type ToWorker =
  | { t: 'init'; config: MatchConfig }
  | { t: 'cmd'; actor: number; cmd: Command }
  | { t: 'advance'; ticks: number }
  | { t: 'ff'; seconds: number; budgetMs: number };

let match: Match | null = null;
const bus = new CommandBus();
const cursor = newCursor();
let observer = 0;

const post = (msg: unknown, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

bus.onResult = (env, out) => post({ t: 'cmdResult', env, out });

function send(ran: number): void {
  if (!match) return;
  const snap = makeSnapshot(match, cursor, observer);
  const transfer: Transferable[] = [snap.units.buffer];
  if (snap.front) transfer.push(snap.front.owner.buffer);
  if (snap.frontView) transfer.push(snap.frontView.owner.buffer);
  post({ t: 'snap', snap, ran }, transfer);
}

self.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data;
  try {
    switch (msg.t) {
      case 'init':
        match = createMatch(loadGameData(), msg.config);
        observer = msg.config.playerSlot;
        post({ t: 'ready' });
        send(0);
        break;
      case 'cmd':
        if (match) bus.issue(match, msg.actor, msg.cmd);
        break;
      case 'advance': {
        if (!match) return;
        let n = 0;
        for (; n < msg.ticks && !match.world.result; n++) {
          bus.flush(match);
          step(match);
        }
        send(n);
        break;
      }
      case 'ff': {
        if (!match) return;
        const w = match.world;
        const target = w.tick + Math.round(msg.seconds * w.tickHz);
        const t0 = performance.now();
        let n = 0;
        while (w.tick < target && !w.result && performance.now() - t0 < msg.budgetMs) {
          bus.flush(match);
          step(match);
          if (w.fx.length > 3000) w.fx.length = 0;
          n++;
        }
        w.fx.length = 0;
        send(n);
        break;
      }
    }
  } catch (err: unknown) {
    post({ t: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
