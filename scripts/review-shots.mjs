// Visual review set: the same camera setups on the same war, for before/after comparisons.
// Usage: node scripts/review-shots.mjs <baseUrl> <outDir> [seed=7] [ffSeconds=900]
//   e.g. node scripts/review-shots.mjs http://localhost:4174 media/review/v22/after 7 900
// Views: overview, front battle (z3), close battle (z6), largest town (z5 / z6 low angle),
// armour close-up, river crossing, works, and the overview with the HUD.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [, , base = 'http://localhost:5173', outDir = 'media/review/shots', seedArg = '7', ffArg = '900'] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/?quick&map=gen&seed=${seedArg}&spectate`);
await page.waitForFunction(() => window.__game && window.__game.host && window.__game.host.ready, null, { timeout: 120000 });
await page.evaluate((s) => window.__game.fastForward(s, 240000), Number(ffArg));
// Let the battle animate for a moment at 1x so smoke, tracers and shells are in flight.
await page.evaluate(() => { const g = window.__game; g.ctx.speed = 1; g.ctx.hudHidden = true; });
await page.waitForTimeout(2500);

/** Places of interest, found once (deterministic for a seed and time). */
const spots = await page.evaluate(() => {
  const g = window.__game; const w = g.match.world; const t = w.terrain;
  let battle = null; let bn = -1;
  for (const u of w.units.values()) {
    let n = 0;
    for (const o of w.spatial.query(u.pos.x, u.pos.z, 150)) if (o.owner !== u.owner) n++;
    if (n > bn) { bn = n; battle = u; }
  }
  const towns = w.objectives.filter((o) => o.kind !== 'point').sort((a, b) => b.radius - a.radius);
  const town = towns[0];
  const village = towns[Math.min(towns.length - 1, Math.floor(towns.length / 2))];
  const tanks = [...w.units.values()].filter((u) => u.def.kind === 'vehicle' && /tank|panzer|assault|td|halftrack|armou?r/i.test(u.def.id));
  let tank = tanks[0] ?? null; let tn = -1;
  for (const u of tanks) {
    let n = 0;
    for (const o of w.spatial.query(u.pos.x, u.pos.z, 60)) if (o.owner === u.owner && o.def.kind === 'vehicle') n++;
    if (n > tn) { tn = n; tank = u; }
  }
  // Water nearest the map centre (ground code 4 = water in Ground enum order is not assumed:
  // use the water surface grid instead).
  let water = null; let wd = Infinity;
  for (let j = 0; j < t.nz; j += 2) for (let i = 0; i < t.nx; i += 2) {
    if (Number.isNaN(t.waterSurface[j * t.nx + i])) continue;
    const x = i * t.cell; const z = j * t.cell;
    const d = Math.hypot(x - t.width / 2, z - t.depth / 2);
    if (d < wd) { wd = d; water = { x, z }; }
  }
  const fort = w.forts.find((f) => f.hp > 0 && (f.kind === 'pillbox' || f.kind === 'bunker')) ?? w.forts.find((f) => f.hp > 0);
  const p = (o) => (o ? { x: o.pos ? o.pos.x : o.x, z: o.pos ? o.pos.z : o.z } : null);
  return { battle: p(battle), town: p(town), village: p(village), tank: p(tank), water, fort: p(fort), w: t.width, d: t.depth };
});
console.log(JSON.stringify(spots));

async function shot(name, setup, settleMs = 1200) {
  await page.evaluate(setup);
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('shot', name);
}
const cam = (spot, zoom, elev = 45, yaw = null) => `(() => { const g = window.__game; const r = g.renderer.rig; const s = ${JSON.stringify(spot)}; if (!s) return; r.lookAt(s.x, s.z); r.setZoom(${zoom}); r.setElevation(${elev}); ${yaw === null ? '' : `r.yaw = ${yaw}; r.faceHeading(${yaw} - Math.PI, true);`} })()`;

await shot('01-overview', cam({ x: spots.w / 2, z: spots.d / 2 }, 0.3, 60));
await shot('02-front-z1', cam(spots.battle, 1.2));
await shot('03-front-z3', cam(spots.battle, 3));
await shot('04-close-z6', cam(spots.battle, 6));
await shot('05-close-z6-low', cam(spots.battle, 6, 35));
await shot('06-town-z2', cam(spots.town, 2));
await shot('07-town-z5', cam(spots.town, 5));
await shot('08-town-z6-low', cam(spots.town, 6, 35));
await shot('09-village-z4', cam(spots.village, 4));
await shot('10-armour-z6', cam(spots.tank, 6));
await shot('11-river-z3', cam(spots.water, 3));
await shot('12-river-z6', cam(spots.water, 6, 40));
await shot('13-works-z5', cam(spots.fort, 5));
// Shellfire: follow an artillery / mortar round to its target and shoot the impact and smoke.
for (let tries = 0; tries < 40; tries++) {
  const at = await page.evaluate(() => {
    const w = window.__game.match.world;
    for (const p of w.projectiles) {
      if (p.kind !== 'shell') continue;
      // Landing point of the ballistic arc (g = 9.81 m/s²) on the ground under it.
      const g = 9.81;
      const gy = w.terrain.heightAt(p.pos.x, p.pos.z);
      const t = (p.vel.y + Math.sqrt(Math.max(0, p.vel.y * p.vel.y + 2 * g * (p.pos.y - gy)))) / g;
      return { x: p.pos.x + p.vel.x * t, z: p.pos.z + p.vel.z * t };
    }
    return null;
  });
  if (at) {
    await page.evaluate((s) => { const r = window.__game.renderer.rig; r.lookAt(s.x, s.z); r.setZoom(3.5); r.setElevation(45); }, at);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: `${outDir}/15-shellfire-a.png` });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${outDir}/16-shellfire-b.png` });
    console.log('shot shellfire');
    break;
  }
  await page.waitForTimeout(500);
}
await page.evaluate(() => { window.__game.ctx.hudHidden = false; });
await shot('14-overview-hud', cam({ x: spots.w / 2, z: spots.d / 2 }, 0.5, 50));
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
