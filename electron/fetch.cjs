// HTTPS GET for the updater over Electron's `net` (Chromium networking, so system proxies
// work). Every hop, redirects included, must pass the host allow-list; bodies are capped.
'use strict';

const { isAllowedUrl } = require('./updateLogic.cjs');

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 30000;

/**
 * GET `url`. With `onChunk` the body is streamed to it and the result has no `body`;
 * otherwise the whole body is returned as a Buffer. Resolves { status, size, body? }.
 */
function httpGet(net, url, opts) {
  const { allowLocal = false, maxBytes, accept = '*/*', onChunk, onProgress } = opts;
  return new Promise((resolve, reject) => {
    if (!isAllowedUrl(url, { allowLocal })) {
      reject(new Error(`blocked host: ${safeHost(url)}`));
      return;
    }
    let redirects = 0;
    let done = false;
    let timer = null;
    const req = net.request({ method: 'GET', url, redirect: 'manual', credentials: 'omit', useSessionCookies: false, cache: 'no-store' });
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        try {
          req.abort();
        } catch {
          // already closed
        }
        reject(err);
      } else {
        resolve(value);
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error('download timed out')), IDLE_TIMEOUT_MS);
    };
    req.setHeader('Accept', accept);
    req.on('redirect', (_status, _method, next) => {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) return finish(new Error('too many redirects'));
      if (!isAllowedUrl(next, { allowLocal })) return finish(new Error(`blocked redirect to ${safeHost(next)}`));
      arm();
      req.followRedirect();
      return undefined;
    });
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        finish(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      if (total > maxBytes) {
        finish(new Error('response too large'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (done) return;
        arm();
        size += chunk.length;
        if (size > maxBytes) {
          finish(new Error('response too large'));
          return;
        }
        try {
          if (onChunk) onChunk(chunk);
          else chunks.push(chunk);
        } catch (err) {
          finish(err);
          return;
        }
        if (onProgress) onProgress(size, total);
      });
      res.on('end', () => finish(null, { status: res.statusCode, size, body: onChunk ? undefined : Buffer.concat(chunks) }));
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    arm();
    req.end();
  });
}

function safeHost(raw) {
  try {
    return new URL(raw).host;
  } catch {
    return '(invalid url)';
  }
}

module.exports = { httpGet };
