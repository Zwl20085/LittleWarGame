// app://game/ request handling, kept free of Electron so tests/appProtocol.test.ts can drive it.
// Every response (files, 400/403/404 errors alike) carries the CSP; hostile path shapes that
// are meaningful to Windows (alternate data streams, trailing dot/space aliasing) are refused.
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const GAME_HOST = 'game';

/** Resolve a request URL to a file under `root`: { file } or { status, text }. */
function resolveAppPath(rawUrl, root) {
  let decoded;
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== GAME_HOST) return { status: 404, text: 'Not found' };
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return { status: 400, text: 'Bad request' };
  }
  if (decoded.includes(':') || decoded.includes('\\') || decoded.includes('\0')) return { status: 400, text: 'Bad request' };
  if (decoded.split('/').some((seg) => /[. ]$/.test(seg))) return { status: 400, text: 'Bad request' };
  const file = path.normalize(path.join(root, decoded));
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403, text: 'Forbidden' };
  return { file };
}

function withCsp(res, csp) {
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', csp);
  return new Response(res.body, { status: res.status, headers });
}

/** `fetchFile(fileUrl)` is Electron's net.fetch (or a stub in tests). */
async function handleAppRequest(req, { root, fetchFile, csp }) {
  const r = resolveAppPath(req.url, root);
  if (!r.file) return withCsp(new Response(r.text, { status: r.status }), csp);
  let res;
  try {
    res = await fetchFile(pathToFileURL(r.file).toString());
  } catch {
    res = new Response('Not found', { status: 404 });
  }
  return withCsp(res, csp);
}

module.exports = { resolveAppPath, handleAppRequest, GAME_HOST };
