/// <reference lib="webworker" />
/**
 * Renders the score's sampled orchestra off the main thread and streams each sample back
 * (transferred, zero-copy). Calm-score instruments come first so the title theme starts fast.
 */
import { renderSample, sampleKeys, type MusicSample } from './orchestra';

export type MusicBankMessage = { readonly t: 'sample'; readonly s: MusicSample } | { readonly t: 'done' };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = () => {
  for (const k of sampleKeys()) {
    const s = renderSample(k);
    const m: MusicBankMessage = { t: 'sample', s };
    ctx.postMessage(m, [s.data.buffer]);
  }
  ctx.postMessage({ t: 'done' } satisfies MusicBankMessage);
};
