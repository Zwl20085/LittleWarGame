/// <reference lib="webworker" />
/**
 * Builds the deterministic sound bank off the main thread and streams each buffer back
 * (transferred, zero-copy) so synthesis never costs a rendered frame.
 */
import { impulse, RECIPES, SOUND_IDS, type SoundId } from './recipes';

export interface BankRequest {
  readonly rate: number;
  readonly irRate: number;
}

export type BankMessage =
  | { readonly t: 'ir'; readonly which: 'sfx' | 'music'; readonly l: Float32Array; readonly r: Float32Array }
  | { readonly t: 'sound'; readonly id: SoundId; readonly v: number; readonly data: Float32Array }
  | { readonly t: 'done' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<BankRequest>) => {
  const { rate, irRate } = e.data;
  const send = (m: BankMessage, transfer: Transferable[]): void => ctx.postMessage(m, transfer);
  const [sl, sr] = impulse(irRate, 1.4, 31, 3000);
  send({ t: 'ir', which: 'sfx', l: sl, r: sr }, [sl.buffer, sr.buffer]);
  const [ml, mr] = impulse(irRate, 3.2, 77, 2400);
  send({ t: 'ir', which: 'music', l: ml, r: mr }, [ml.buffer, mr.buffer]);
  for (const id of SOUND_IDS) {
    for (let v = 0; v < RECIPES[id].variants; v++) {
      const data = RECIPES[id].make(rate, v);
      send({ t: 'sound', id, v, data }, [data.buffer]);
    }
  }
  send({ t: 'done' }, []);
};
