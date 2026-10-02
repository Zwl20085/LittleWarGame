// Records whole-page clips (HTML overlays included) for the README: the animated title screen
// and the in-game HUD. Canvas-only gameplay clips come from capture.mjs.
// Usage: node scripts/capture-page.mjs [hero|hud ...] [--lang en|zh]   (dev server on :5173)
// Output: media/page/<shot>-<lang>.webm  (media/ is gitignored)
import { chromium } from 'playwright-core';
import { mkdirSync, renameSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'media/page';
const SIZE = { width: 1600, height: 900 };
const args = process.argv.slice(2);
const lang = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'en';
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang');

/** Each shot: URL, a page-side setup (async), and how long to keep recording afterwards. */
const SHOTS = {
  // Title screen over its live background battle.
  hero: { url: '/', warmMs: 26000, recordMs: 9000, setup: null },
  // In-game HUD around a contested town: high-command card, group cards, event log.
  hud: {
    url: '/?quick&map=gen&seed=42', warmMs: 9000, recordMs: 10000,
    setup: `(async () => {
      const g = window.__game; await g.fastForward(420, 300000);
      const W = g.match.world; const f = W.factions[g.ctx.playerId];
      const d = f.command.directives.find((x) => x.kind === 'defend') ?? f.command.directives[0];
      const p = d ? d.pos : W.hqPos(f.id);
      g.ctx.renderer.rig.lookAt(p.x, p.z); g.ctx.renderer.rig.setZoom(1.6); g.ctx.renderer.rig.setElevation(42);
      g.ctx.speed = 2;
    })()`,
  },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EDGE, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [name, shot] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE } });
  await context.addInitScript((l) => localStorage.setItem('lwg.lang', l), lang);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const t0 = Date.now();
  await page.goto(`http://localhost:5173${shot.url}`);
  await page.waitForTimeout(shot.warmMs);
  if (shot.setup) await page.evaluate(shot.setup);
  const start = (Date.now() - t0) / 1000;
  await page.waitForTimeout(shot.recordMs);
  const video = page.video();
  await context.close();
  const file = `${OUT}/${name}-${lang}.webm`;
  renameSync(await video.path(), file);
  // The clip worth keeping starts at `start` seconds (trim when converting to GIF).
  console.log(`${name}: ${file} keep from ${start.toFixed(1)}s for ${shot.recordMs / 1000}s`);
}
await browser.close();
