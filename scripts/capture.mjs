// Records cinematic gameplay clips from the game canvas (no HUD) for the trailer and README GIFs.
// Usage: node scripts/capture.mjs [shotName ...]   (dev server must run on :5173)
// Output: media/clips/<shot>.webm  (media/ is gitignored)
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'media/clips';
mkdirSync(OUT, { recursive: true });

/**
 * Each shot: seed/url, warm-up seconds, a camera "setup" (runs once in the page, may pick a
 * hotspot) and a per-frame "move" (orbit/drift), recorded for `secs` seconds.
 * Page helpers are defined in PRELUDE below.
 */
const SHOTS = {
  overview: { url: '?quick&map=gen&spectate&seed=4242', warm: 300, secs: 9, speed: 2,
    setup: 'cam.setElevation(58); cam.setZoom(0.42); cam.lookAt(W.terrain.width/2, W.terrain.depth/2);',
    move: 'cam.rotate(-0.0016);' },
  front: { url: '?quick&map=gen&spectate&seed=4242', warm: 330, secs: 9, speed: 1,
    setup: 'const h = hotspot(1); cam.lookAt(h.x, h.z); cam.setElevation(36); cam.setZoom(2.4);',
    move: 'cam.rotate(0.0012); cam.zoomBy(1.0006);' },
  river: { url: '?quick&map=gen&spectate&seed=4242', warm: 300, secs: 9, speed: 1,
    setup: 'const b = busyBridge(); cam.lookAt(b.x, b.z); cam.setElevation(40); cam.setZoom(2.0);',
    move: 'cam.rotate(-0.001);' },
  city: { url: '?quick&map=gen&spectate&seed=4242', warm: 420, secs: 9, speed: 1,
    setup: 'const h = cityFight(); cam.lookAt(h.x, h.z); cam.setElevation(42); cam.setZoom(1.9);',
    move: 'cam.rotate(0.0011);' },
  artillery: { url: '?quick&map=gen&spectate&seed=4242', warm: 480, secs: 9, speed: 1,
    setup: 'const h = shellHotspot(); cam.lookAt(h.x, h.z); cam.setElevation(34); cam.setZoom(1.5);',
    move: 'cam.rotate(-0.0009);' },
  convoy: { url: '?quick&map=gen&spectate&seed=4242', warm: 260, secs: 9, speed: 1,
    setup: 'followTruck(); cam.setElevation(48); cam.setZoom(2.2);',
    move: '' },
  duel1v1: { url: '?quick&map=1v1&spectate&seed=11', warm: 200, secs: 9, speed: 1,
    setup: 'const h = hotspot(1); cam.lookAt(h.x, h.z); cam.setElevation(38); cam.setZoom(2.6);',
    move: 'cam.rotate(0.0013);' },
};

const PRELUDE = `
  const g = window.__game; const W = g.match.world; const cam = g.ctx.renderer.rig;
  const hostiles = (u, r) => W.spatial.query(u.pos.x, u.pos.z, r).filter((o) => o.hp > 0 && W.isHostile(u.owner, o.owner)).length;
  const hotspot = (k) => { let best = null, bs = -1; for (const u of W.units.values()) { if (u.fixed) continue; const s = hostiles(u, 160) * k + W.spatial.query(u.pos.x, u.pos.z, 120).length * 0.2; if (s > bs) { bs = s; best = u; } } return best ? best.pos : { x: W.terrain.width / 2, z: W.terrain.depth / 2 }; };
  const busyBridge = () => { let best = W.terrain.bridges[0], bs = -1; for (const b of W.terrain.bridges) { const n = W.spatial.query(b.x, b.z, 140).length; if (n > bs) { bs = n; best = b; } } return best; };
  const cityFight = () => { let best = null, bs = -1; for (const t of W.map.towns) { if (t.buildings < 60) continue; const n = W.spatial.query(t.x, t.z, t.r + 60).filter((u) => u.hp > 0).length; const owners = new Set(W.spatial.query(t.x, t.z, t.r + 60).map((u) => u.owner)).size; const s = n * owners; if (s > bs) { bs = s; best = t; } } return best ?? hotspot(1); };
  const shellHotspot = () => { const ps = W.projectiles.filter((p) => p.kind === 'shell'); if (!ps.length) return hotspot(1); let sx = 0, sz = 0; for (const p of ps) { sx += p.pos.x; sz += p.pos.z; } return { x: sx / ps.length, z: sz / ps.length }; };
  const followTruck = () => { const t = [...W.units.values()].find((u) => u.def.id === 'supply_truck' && u.truckState === 'out') ?? [...W.units.values()].find((u) => u.def.id === 'supply_truck'); if (!t) return; cam.follow = () => { const u = W.units.get(t.id); return u ? { x: u.pos.x, y: u.y, z: u.pos.z } : null; }; };
`;

async function record(page, name, shot) {
  await page.goto(`http://localhost:5173/${shot.url}`);
  await page.waitForFunction(() => window.__game && window.__game.match, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.evaluate(async (s) => { const g = window.__game; g.ctx.hudHidden = true; await g.fastForward(s.warm, 300000); g.ctx.speed = s.speed; }, shot);
  await page.evaluate(`(() => { ${PRELUDE} ${shot.setup} })()`);
  await page.waitForTimeout(1800); // let the camera settle and effects populate
  const b64 = await page.evaluate(async ({ secs, move, prelude }) => {
    eval(prelude.replace(/const /g, 'var '));
    const canvas = document.querySelector('canvas.view');
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 14_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let on = true;
    const tick = () => { if (!on) return; try { eval(move); } catch (e) { /* camera move is best-effort */ } requestAnimationFrame(tick); };
    rec.start(500);
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, secs * 1000));
    on = false;
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, { secs: shot.secs, move: shot.move, prelude: PRELUDE });
  const file = `${OUT}/${name}.webm`;
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log(`${name}: ${(b64.length * 0.75 / 1e6).toFixed(1)} MB -> ${file}`);
}

const browser = await chromium.launch({
  executablePath: EDGE,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
const wanted = process.argv.slice(2);
for (const [name, shot] of Object.entries(SHOTS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  try {
    await record(page, name, shot);
  } catch (err) {
    console.error(`${name} failed:`, err.message);
  }
}
await browser.close();
