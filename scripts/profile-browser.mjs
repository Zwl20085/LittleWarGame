// Main-thread CPU profile of the real game in headless Edge: fast-forwards into the war, sets a
// camera view and speed, samples the main thread with the DevTools profiler and prints the
// hottest functions by self time (and inclusive time for the renderer's own methods).
// Usage: PERF_URL=http://localhost:4174 node scripts/profile-browser.mjs [seed=7] [ff=1200] [seconds=10] [speed=8] [view=front|overview|close]
// Use a `vite build` (sourcemaps off: names stay readable because vite keeps class/method names
// only partly — build with `--minify false` for exact names).
import { chromium } from 'playwright-core';

const [, , seedArg = '7', ffArg = '1200', secArg = '10', speedArg = '8', view = 'front'] = process.argv;
const base = process.env.PERF_URL ?? 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`${base}/?quick&map=gen&seed=${seedArg}&spectate`);
await page.waitForFunction(() => window.__game && window.__game.host && window.__game.host.ready, null, { timeout: 120000 });
await page.evaluate((s) => window.__game.fastForward(s, 240000), Number(ffArg));
await page.evaluate((v) => {
  const g = window.__game; const w = g.match.world;
  if (v === 'overview') { g.renderer.rig.lookAt(w.terrain.width / 2, w.terrain.depth / 2); g.renderer.rig.setZoom(0.5); return; }
  let best = null; let bn = -1;
  for (const u of w.units.values()) {
    let n = 0;
    for (const o of w.spatial.query(u.pos.x, u.pos.z, 150)) if (o.owner !== u.owner) n++;
    if (n > bn) { bn = n; best = u; }
  }
  if (best) g.renderer.rig.lookAt(best.pos.x, best.pos.z);
  g.renderer.rig.setZoom(v === 'close' ? 8 : 3);
}, view);
await page.evaluate((s) => { window.__game.ctx.speed = s; }, Number(speedArg));
await page.waitForTimeout(1500);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.waitForTimeout(Number(secArg) * 1000);
const { profile } = await cdp.send('Profiler.stop');
await browser.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const selfUs = new Map();
const dts = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + (dts[i] ?? 0));
const key = (n) => {
  const cf = n.callFrame;
  const file = cf.url ? cf.url.split('/').pop() : '';
  return `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
};
const self = new Map();
const incl = new Map();
let total = 0;
for (const [id, us] of selfUs) {
  total += us;
  const n = byId.get(id);
  self.set(key(n), (self.get(key(n)) ?? 0) + us);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const k = key(byId.get(cur));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + us);
  }
}
const secs = Number(secArg);
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => `${(us / 1000 / secs).toFixed(2).padStart(7)} ms/s  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`).join('\n');
console.log(`main thread, ${secs} s, view ${view}, speed ${speedArg}x; total sampled ${(total / 1000 / secs).toFixed(1)} ms/s`);
console.log('--- self ---\n' + fmt(self));
console.log('--- inclusive ---\n' + fmt(incl));

// CALLERS=fnName: who calls a hot function (first frame outside three.js / native code,
// plus the full stack of the heaviest paths).
if (process.env.CALLERS) {
  const target = process.env.CALLERS;
  const stacks = new Map();
  for (const [id, us] of selfUs) {
    const chain = [];
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) chain.push(byId.get(cur));
    const at = chain.findIndex((n) => n.callFrame.functionName === target);
    if (at < 0) continue;
    const path = chain.slice(at, at + 9).map(key).join(' < ');
    stacks.set(path, (stacks.get(path) ?? 0) + us);
  }
  console.log(`--- callers of ${target} ---\n` + fmt(stacks));
}
