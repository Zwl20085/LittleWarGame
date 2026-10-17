// 3.0 camera review set: one screenshot per camera mode (free, orbit, follow unit, follow front,
// battle cam before / after a cut, overview) and the time-of-day drift (dawn, noon, dusk).
// Usage: node scripts/camera-shots.mjs <baseUrl> <outDir> [seed=7] [ffSeconds=600]
// The player slot plays (not spectating) so the HUD mode strip and the front cards are real.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [, , base = 'http://localhost:5173', outDir = 'media/review/v30-camera', seedArg = '7', ffArg = '600'] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?quick&map=gen&seed=${seedArg}`);
await page.waitForFunction(() => window.__game && window.__game.host && window.__game.host.ready, null, { timeout: 120000 });
await page.evaluate((s) => window.__game.fastForward(s, 240000), Number(ffArg));
await page.evaluate(() => { const g = window.__game; g.ctx.speed = 1; g.renderer.setQualityMode('high'); });
await page.waitForTimeout(2000);

const shot = async (name, ms = 1500) => {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  const mode = await page.evaluate(() => window.__game.camera.modes.mode);
  console.log('shot', name, 'mode', mode);
};
const key = (k) => page.keyboard.press(k);

await shot('01-free');
await key('o');
await shot('02-orbit', 3000);
await key('Escape');
// Follow: select the player's unit nearest the fighting, press F.
await page.evaluate(() => {
  const g = window.__game; const w = g.match.world;
  let best = null; let bn = -1;
  for (const u of w.units.values()) {
    if (u.owner !== g.ctx.playerId || u.fixed) continue;
    let n = 0;
    for (const o of w.spatial.query(u.pos.x, u.pos.z, 200)) if (o.owner !== u.owner) n++;
    if (n > bn) { bn = n; best = u; }
  }
  g.renderer.units.selected.clear();
  if (best) g.renderer.units.selected.add(best.id);
});
await key('f');
await shot('03-follow-unit', 3500);
await key('Escape');
await page.evaluate(() => window.__game.renderer.units.selected.clear());
// Follow a front: expand the first card and press F (same as double-clicking the card).
await page.evaluate(() => {
  const g = window.__game; const f = g.match.world.factions[g.ctx.playerId];
  if (f?.fronts[0]) g.ctx.camera.followFront(f.fronts[0].id);
});
await shot('04-follow-front', 4000);
await key('Escape');
await key('k');
await shot('05-battle-a', 3000);
// Force the next cut now (dip to black, new fight) instead of waiting 12-20 s.
await page.evaluate(() => { const m = window.__game.camera.modes; if (m.shot) m.shot.t = m.shot.duration - 0.5; });
await shot('06-battle-b', 2500);
await key('Escape');
await key('Tab');
await shot('07-overview', 2500);
await key('Tab');
await shot('08-overview-back', 2500);
// Time-of-day drift at the same close-in battle view (HUD hidden).
await page.evaluate(() => { window.__game.ctx.hudHidden = true; });
await key('k');
await page.waitForTimeout(2500);
for (const [name, t] of [['09-dawn', 0], ['10-noon', 1600], ['11-dusk', 3600]]) {
  await page.evaluate((time) => {
    const r = window.__game.renderer; const day = r.day;
    if (!day.__orig) day.__orig = day.update.bind(day);
    day.update = () => day.__orig(time);
    const m = window.__game.camera.modes; if (m.shot) m.shot.t = 0; // hold the shot
  }, t);
  await shot(name, 800);
}
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
