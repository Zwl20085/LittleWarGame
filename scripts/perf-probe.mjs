// Isolates main-thread render cost by toggling scene parts live and timing WebGLRenderer.render.
// Usage: PERF_URL=http://localhost:4174 node scripts/perf-probe.mjs [seed=7] [ffSeconds=300]
import { chromium } from 'playwright-core';

const [, , seedArg = '7', ffArg = '300'] = process.argv;
const base = process.env.PERF_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${base}/?quick&map=gen&seed=${seedArg}&spectate`);
await page.waitForFunction(() => window.__game && window.__game.host && window.__game.host.ready, null, { timeout: 120000 });
await page.evaluate((s) => window.__game.fastForward(s, 240000), Number(ffArg));
await page.evaluate(() => { window.__game.ctx.speed = 4; });
await page.waitForTimeout(1000);

const census = await page.evaluate(() => {
  const r = window.__game.renderer;
  let objects = 0; let meshes = 0; let shadowCasters = 0; let instanced = 0; let instances = 0; const byName = {};
  r.scene.traverse((o) => {
    objects++;
    if (o.isMesh) { meshes++; if (o.castShadow) shadowCasters++; }
    if (o.isInstancedMesh) { instanced++; instances += o.count; }
  });
  for (const c of r.scene.children) {
    let n = 0; c.traverse(() => n++);
    const key = c.name || c.type;
    byName[key] = (byName[key] ?? 0) + n;
  }
  return { objects, meshes, shadowCasters, instanced, instances, children: r.scene.children.length, byName };
});
console.log('scene census', JSON.stringify(census));

async function timeRender(label, frames = 120) {
  const ms = await page.evaluate(async (n) => {
    const r = window.__game.renderer;
    const gl = r.renderer;
    const samples = [];
    const orig = gl.render.bind(gl);
    gl.render = (...a) => { const t = performance.now(); orig(...a); samples.push(performance.now() - t); };
    await new Promise((res) => { let k = 0; const loop = () => (++k < n ? requestAnimationFrame(loop) : res()); requestAnimationFrame(loop); });
    gl.render = orig;
    samples.sort((a, b) => a - b);
    return { avg: samples.reduce((a, b) => a + b, 0) / samples.length, p95: samples[Math.floor(samples.length * 0.95)] };
  }, frames);
  console.log(`${label.padEnd(34)} gl.render avg ${ms.avg.toFixed(2)} ms p95 ${ms.p95.toFixed(2)} ms`);
}

async function withToggle(label, on, off) {
  await page.evaluate(on);
  await page.waitForTimeout(300);
  await timeRender(label);
  await page.evaluate(off);
}

for (const [view, setup] of [
  ['overview', () => { const g = window.__game; const w = g.match.world; g.renderer.rig.lookAt(w.terrain.width / 2, w.terrain.depth / 2); g.renderer.rig.setZoom(0.5); }],
  ['front z3', () => { const g = window.__game; const w = g.match.world; let best = null; let bn = -1; for (const u of w.units.values()) { let n = 0; for (const o of w.spatial.query(u.pos.x, u.pos.z, 150)) if (o.owner !== u.owner) n++; if (n > bn) { bn = n; best = u; } } if (best) g.renderer.rig.lookAt(best.pos.x, best.pos.z); g.renderer.rig.setZoom(3); }],
]) {
  await page.evaluate(setup);
  await page.waitForTimeout(800);
  console.log(`--- ${view} ---`);
  await timeRender('baseline');
  await withToggle('no shadow map', () => { window.__game.renderer.renderer.shadowMap.enabled = false; }, () => { window.__game.renderer.renderer.shadowMap.enabled = true; });
  await withToggle('shadow map static (no autoUpdate)', () => { window.__game.renderer.renderer.shadowMap.autoUpdate = false; }, () => { window.__game.renderer.renderer.shadowMap.autoUpdate = true; });
  await withToggle('units hidden', () => { window.__game.renderer.units.group.visible = false; }, () => { window.__game.renderer.units.group.visible = true; });
  await withToggle('terrain hidden', () => { window.__game.renderer.terrainView.group.visible = false; }, () => { window.__game.renderer.terrainView.group.visible = true; });
  await withToggle('scatter hidden', () => { window.__game.renderer.terrainView.scatter.visible = false; window.__game.renderer.terrainView.scatter.__force = true; }, () => { window.__game.renderer.terrainView.scatter.__force = false; });
  await withToggle('effects hidden', () => { window.__game.renderer.effects.group.visible = false; }, () => { window.__game.renderer.effects.group.visible = true; });
  await withToggle('fieldworks+arrows hidden', () => { const r = window.__game.renderer; r.fieldWorks.group.visible = false; r.opArrows.mesh.visible = false; }, () => { const r = window.__game.renderer; r.fieldWorks.group.visible = true; r.opArrows.mesh.visible = true; });
  await withToggle('objective markers hidden', () => { window.__game.renderer.objectiveMarkers.group.visible = false; }, () => { window.__game.renderer.objectiveMarkers.group.visible = true; });
  await withToggle('matrixAutoUpdate off (scene)', () => { window.__game.renderer.scene.traverse((o) => { o.__mau = o.matrixAutoUpdate; o.matrixAutoUpdate = false; }); }, () => { window.__game.renderer.scene.traverse((o) => { if (o.__mau !== undefined) o.matrixAutoUpdate = o.__mau; }); });
}
await browser.close();
