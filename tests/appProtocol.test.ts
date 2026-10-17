import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { handleAppRequest } = require('../electron/appProtocol.cjs') as {
  handleAppRequest: (req: { url: string }, o: { root: string; fetchFile: (u: string) => Promise<Response>; csp: string }) => Promise<Response>;
};

const ROOT = join(process.cwd(), 'dist-fake');
const CSP = "default-src 'self'";
const ok = (): Promise<Response> => Promise.resolve(new Response('body', { status: 200 }));
const call = (url: string, fetchFile: (u: string) => Promise<Response> = ok) => handleAppRequest({ url }, { root: ROOT, fetchFile, csp: CSP });

describe('app:// handler', () => {
  it('adds the CSP to every response, not just html', async () => {
    for (const url of ['app://game/index.html', 'app://game/assets/main.js', 'app://game/a.png']) {
      const r = await call(url);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe(CSP);
    }
    const missing = await call('app://game/x.js', () => Promise.reject(new Error('nope')));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-security-policy')).toBe(CSP);
    const bad = await call('app://game/a:b');
    expect(bad.headers.get('content-security-policy')).toBe(CSP);
  });

  it('refuses colons (ADS), trailing dot/space segments and backslashes with 400', async () => {
    for (const p of ['index.html:stream', 'a%3Ab', 'dir./x.js', 'x.js.', 'x.js%20', 'a%20/b.js', 'a%5Cb.js']) {
      expect((await call(`app://game/${p}`)).status, p).toBe(400);
    }
  });

  it('404s any host other than game', async () => {
    expect((await call('app://evil/index.html')).status).toBe(404);
    expect((await call('app://game.evil/index.html')).status).toBe(404);
  });

  it('never leaves the bundle root', async () => {
    let fetched = false;
    const r = await call('app://game/%2e%2e%2f%2e%2e/x', () => { fetched = true; return ok(); });
    expect([400, 403]).toContain(r.status);
    expect(fetched).toBe(false);
  });
});
