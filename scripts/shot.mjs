// Usage: node scripts/shot.mjs <url> <out.png> [waitMs] [actions-json]
import { chromium } from 'playwright-core';
const [, , url, out, waitMs = '4000', actions = '[]'] = process.argv;
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForTimeout(Number(waitMs));
for (const a of JSON.parse(actions)) {
  if (a.eval) logs.push('[eval] ' + JSON.stringify(await page.evaluate(a.eval)));
  if (a.key) await page.keyboard.press(a.key);
  if (a.click) await page.mouse.click(a.click[0], a.click[1], { button: a.button ?? 'left' });
  if (a.wait) await page.waitForTimeout(a.wait);
  if (a.shot) await page.screenshot({ path: a.shot });
}
await page.screenshot({ path: out });
console.log(logs.slice(-40).join('\n'));
await browser.close();
