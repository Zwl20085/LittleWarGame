// Main-thread performance harness: runs the real game in headless Edge (GPU on), fast-forwards
// into a big battle, sets 8x speed and measures frame time, renderer phases, snapshot apply cost
// and the achieved simulation rate. Usage:
//   node scripts/perf-browser.mjs [seed=7] [ffSeconds=420] [sampleSeconds=20] [speed=8]
// Requires the dev server (`npm run dev`) on http://localhost:5173.
import { chromium } from 'playwright-core';

const [, , seedArg = '7', ffArg = '420', sampleArg = '20', speedArg = '8'] = process.argv;
const seed = Number(seedArg);
const ff = Number(ffArg);
const sampleSeconds = Number(sampleArg);
const speed = Number(speedArg);

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// PERF_URL lets you point at a static `vite preview` build (no HMR reloads while measuring).
const base = process.env.PERF_URL ?? 'http://localhost:5173';
await page.goto(`${base}/?quick&map=gen&seed=${seed}&spectate`);
await page.waitForFunction(() => window.__game && window.__game.host && window.__game.host.ready, null, { timeout: 120000 });
console.log(`match ready; fast-forwarding ${ff} s of game time…`);
await page.evaluate((s) => window.__game.fastForward(s, 240000), ff);
await page.waitForTimeout(500);

// QUALITY=high|medium|low|auto forces a render quality tier for the measurement.
if (process.env.QUALITY) await page.evaluate((q) => window.__game.renderer.setQualityMode(q), process.env.QUALITY);

/** Measure one camera setup for `seconds` real seconds. */
async function measure(label, setup) {
  await page.evaluate(setup);
  await page.evaluate((spd) => { window.__game.ctx.speed = spd; }, speed);
  await page.waitForTimeout(1500); // settle
  const out = await page.evaluate(async (seconds) => {
    const g = window.__game;
    const w = g.match.world;
    const r = g.renderer;
    const stats = { frame: [], render: [], units: [], fx: [], apply: [], lag: 0, frames: 0, parts: {} };
    const wrap = (obj, key, bucket) => {
      if (!obj || typeof obj[key] !== 'function') return () => {};
      const orig = obj[key].bind(obj);
      obj[key] = (...a) => { const t = performance.now(); const res = orig(...a); bucket.push(performance.now() - t); return res; };
      return () => { obj[key] = orig; };
    };
    const part = (name, obj, key) => { stats.parts[name] = []; return wrap(obj, key, stats.parts[name]); };
    const undo = [
      wrap(r, 'frame', stats.render), wrap(r.units, 'sync', stats.units), wrap(r.effects, 'update', stats.fx),
      part('gl.render', r.renderer, 'render'), part('water', r.terrainView?.water, 'update'), part('paintFront', r, 'paintFront'),
      part('counters', r.counters, 'draw'), part('labels', r.labels, 'draw'), part('opArrows', r.opArrows, 'sync'),
      part('projectiles', r.effects, 'syncProjectiles'), part('forts', r, 'syncForts'), part('objectives', r, 'syncObjectives'),
      part('overlays', r, 'drawOverlays'), part('fxHandle', r.effects, 'handle'), part('rig', r.rig, 'update'),
    ];
    const info = r.renderer.info;
    info.autoReset = true;
    const host = g.host;
    const origMsg = host.worker.onmessage;
    host.worker.onmessage = (e) => { const t = performance.now(); origMsg(e); if (e.data.t === 'snap') stats.apply.push(performance.now() - t); };
    const tick0 = w.tick;
    const t0 = performance.now();
    let last = t0;
    await new Promise((res) => {
      const loop = (now) => {
        stats.frame.push(now - last);
        last = now;
        stats.frames++;
        if (g.lagTicks > 0) stats.lag++;
        if (now - t0 < seconds * 1000) requestAnimationFrame(loop);
        else res();
      };
      requestAnimationFrame(loop);
    });
    const elapsed = (performance.now() - t0) / 1000;
    for (const u of undo) u();
    host.worker.onmessage = origMsg;
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    return {
      units: w.units.size,
      projectiles: w.projectiles.length,
      fps: stats.frames / elapsed,
      frameP50: q(stats.frame, 0.5), frameP95: q(stats.frame, 0.95), frameMax: Math.max(...stats.frame),
      renderAvg: avg(stats.render), renderP95: q(stats.render, 0.95),
      unitsSyncAvg: avg(stats.units), fxAvg: avg(stats.fx),
      applyAvg: avg(stats.apply), applyCount: stats.apply.length, applyTotalPerSec: sum(stats.apply) / elapsed,
      lagFrames: stats.lag / stats.frames,
      achievedSpeed: ((w.tick - tick0) / w.tickHz) / elapsed,
      ppm: r.pixelsPerMetre(),
      parts: Object.fromEntries(Object.entries(stats.parts).map(([k, v]) => [k, (sum(v) / stats.frames)])),
      drawCalls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0,
    };
  }, sampleSeconds);
  console.log(`   per-frame ms: ${Object.entries(out.parts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')} | draw calls ${out.drawCalls} tris ${(out.triangles / 1000).toFixed(0)}k programs ${out.programs}`);
  const f = (x) => x.toFixed(2);
  console.log(`[${label}] units ${out.units} proj ${out.projectiles} ppm ${f(out.ppm)} | fps ${f(out.fps)} frame p50 ${f(out.frameP50)} p95 ${f(out.frameP95)} max ${f(out.frameMax)} ms | render avg ${f(out.renderAvg)} p95 ${f(out.renderP95)} (units.sync ${f(out.unitsSyncAvg)}, fx ${f(out.fxAvg)}) | snapshot apply avg ${f(out.applyAvg)} ms ×${out.applyCount} = ${f(out.applyTotalPerSec)} ms/s | lag frames ${(out.lagFrames * 100).toFixed(0)}% | achieved speed ${f(out.achievedSpeed)}x of ${speed}x`);
  return out;
}

await measure('overview', () => {
  const g = window.__game; const w = g.match.world;
  g.renderer.rig.lookAt(w.terrain.width / 2, w.terrain.depth / 2); g.renderer.rig.setZoom(0.5);
});
await measure('front', () => {
  const g = window.__game; const w = g.match.world;
  // Look at the densest cluster of hostile contact: the unit with the most enemies within 150 m.
  let best = null; let bn = -1;
  for (const u of w.units.values()) {
    let n = 0;
    for (const o of w.spatial.query(u.pos.x, u.pos.z, 150)) if (o.owner !== u.owner) n++;
    if (n > bn) { bn = n; best = u; }
  }
  if (best) g.renderer.rig.lookAt(best.pos.x, best.pos.z);
  g.renderer.rig.setZoom(3);
});
await measure('close', () => { window.__game.renderer.rig.setZoom(8); });
if (errors.length) console.log('page errors:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
