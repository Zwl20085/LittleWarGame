// Click-reliability check for the supreme-HQ UI (2.2 bug: "assigning commands by click sometimes
// does not work"). Plays a quick match in Edge at ×4 speed, then N times: presses a directive button,
// clicks (or for Fortify drags) the map, and opens a front card — each press held ~110 ms like a
// human click while the HUD keeps refreshing at 5 Hz. Every click must register: the command is
// issued, the simulation applies it (or refuses it with a toast), the card opens.
//
//   npx vite --port 5173            (dev server)
//   node scripts/clickcheck.mjs [url] [N=25] [--noguard] [--shot out.png]
//
// --noguard switches the panel's PressGuard off (A/B: shows the lost clicks the guard prevents).
// Exit code 1 when any click was lost.
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--shot'));
const url = pos[0] ?? 'http://localhost:5173/?quick&map=gen&seed=7';
const N = Number(pos[1] ?? 25);
const PRESS_MS = 110;

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.waitForFunction(() => !!window.__game?.hud, null, { timeout: 90_000 });
await page.evaluate((noguard) => {
  const g = window.__game;
  g.ctx.speed = 4;
  window.__cmds = [];
  window.__outs = [];
  window.__toasts = [];
  const issue = g.ctx.issue.bind(g.ctx);
  g.ctx.issue = (cmd) => { window.__cmds.push(cmd); issue(cmd); };
  // Every toast (game.ts shows command refusals through the HUD directly).
  const toast = g.hud.toast.bind(g.hud);
  g.hud.toast = (text, sev) => { window.__toasts.push({ text, sev }); toast(text, sev); };
  const host = g.host;
  const res = host ? host.onCommandResult : g.bus.onResult;
  const wrap = (env, out) => { window.__outs.push({ type: env.cmd.type, ok: out.ok, reason: out.ok ? null : out.reason }); res?.(env, out); };
  if (host) host.onCommandResult = wrap; else g.bus.onResult = wrap;
  if (noguard) Object.defineProperty(g.hud.fronts.guard, 'held', { get: () => false });
}, flag('--noguard'));
// Let the war start so the cards and staff notes churn.
await page.waitForTimeout(20_000);

const box = async (sel) => {
  for (let k = 0; k < 100; k++) {
    const b = await page.locator(sel).first().boundingBox().catch(() => null);
    if (b) return b;
    await page.waitForTimeout(20);
  }
  throw new Error(`no ${sel}`);
};
const press = async (x, y, to = null) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (to) await page.mouse.move(to[0], to[1], { steps: 6 });
  await page.waitForTimeout(PRESS_MS);
  await page.mouse.up();
  await page.waitForTimeout(40);
};
const count = () => page.evaluate(() => window.__cmds.length);
/** Wait until the sim answered command #i: applied (ok) or refused (a toast with the reason). */
const outcome = async (i) => {
  for (let k = 0; k < 150; k++) {
    const o = await page.evaluate((j) => window.__outs[j] ?? null, i);
    if (o) return o;
    await page.waitForTimeout(20);
  }
  return null;
};

const KINDS = ['offensive', 'defend', 'fortify', 'advance', 'contract'];
const PLACED = new Set(['offensive', 'defend', 'fortify']);
const tally = { palette: 0, paletteOk: 0, map: 0, mapOk: 0, cards: 0, cardsOk: 0, reaims: 0, refused: {}, lost: [] };
let outIdx = await page.evaluate(() => window.__outs.length);
for (let i = 0; i < N; i++) {
  const kind = KINDS[i % KINDS.length];
  // 1. Directive button.
  const b = await box(`.directive-palette .obtn[data-directive="${kind}"]`);
  const c0 = await count();
  await press(b.x + b.width / 2, b.y + b.height / 2);
  tally.palette++;
  const c1 = await count();
  const o1 = c1 > c0 ? await outcome(outIdx) : null;
  if (c1 > c0) outIdx = c1;
  const applied = o1 && (o1.ok ? await page.waitForFunction((k) => window.__game.match.world.factions[window.__game.ctx.playerId].directive.kind === k, kind, { timeout: 5000 }).then(() => true, () => false) : true);
  if (c1 > c0 && applied) tally.paletteOk++;
  else tally.lost.push({ i, what: `button ${kind}`, issued: c1 > c0, outcome: o1 });
  // 2. Map: the axis (or for Fortify every other time a dragged line).
  if (PLACED.has(kind)) {
    const mode = await page.evaluate(() => window.__game.ctx.mode.kind);
    const x = 700 + ((i * 97) % 300);
    const y = 300 + ((i * 53) % 220);
    const drag = kind === 'fortify' && i % 2 === 1 ? [x + 320, y + 60] : null;
    const m0 = await count();
    const w0 = await page.evaluate(() => window.__toasts.filter((t) => t.sev === 'warn').length);
    await press(x, y, drag);
    tally.map++;
    const m1 = await count();
    const o2 = m1 > m0 ? await outcome(outIdx) : null;
    if (m1 > m0) outIdx = m1;
    if (o2 && !o2.ok) tally.refused[o2.reason] = (tally.refused[o2.reason] ?? 0) + 1;
    const toasted = o2 && !o2.ok ? await page.evaluate((n) => window.__toasts.filter((t) => t.sev === 'warn').length > n, w0) : true;
    if (mode === 'directive' && m1 > m0 && o2 && toasted) tally.mapOk++;
    else tally.lost.push({ i, what: `map ${kind}${drag ? ' line' : ''}`, mode, issued: m1 > m0, outcome: o2 });
    // (Esc only while still placing: in normal mode it opens the pause menu.)
    if (await page.evaluate(() => window.__game.ctx.mode.kind === 'directive')) await page.keyboard.press('Escape');
  }
  // 3. Front card: opens / closes the dossier.
  // Aim like a person: the card's title row must be under the pointer when the button goes down
  // (the column can shift while aiming — a staff note or the capital alert appears above the cards).
  let aim = null;
  for (let k = 0; k < 10 && !aim; k++) {
    const cb = await box('.front-card .fc-name');
    const x = cb.x + Math.min(30, cb.width / 2);
    const y = cb.y + cb.height / 2;
    const on = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.front-card .fc-top'), [x, y]);
    if (on) aim = [x, y];
    else tally.reaims++;
  }
  const e0 = await page.evaluate(() => window.__game.hud.fronts.expanded);
  await press(aim[0], aim[1]);
  tally.cards++;
  const e1 = await page.evaluate(() => window.__game.hud.fronts.expanded);
  if (e0 !== e1) tally.cardsOk++;
  else tally.lost.push({ i, what: 'front card' });
}
const shot = opt('--shot', null);
if (shot) await page.screenshot({ path: shot });
await browser.close();
const lost = tally.lost.length;
console.log(JSON.stringify({ url, N, guard: !flag('--noguard'), ...tally, errors }, null, 1));
console.log(lost === 0 ? `OK: all ${tally.palette + tally.map + tally.cards} clicks registered` : `LOST ${lost} clicks`);
process.exit(lost === 0 && errors.length === 0 ? 0 : 1);
