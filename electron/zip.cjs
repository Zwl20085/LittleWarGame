// Minimal ZIP writer and a defensive ZIP reader (node built-ins only). The writer is used by
// scripts/release/pack.mjs; the reader by the shell to unpack downloaded game bundles. The
// reader treats the archive as hostile: it rejects absolute paths, `..` segments, drive letters,
// symlinks, encryption, ZIP64, unknown compression and anything over the size limits, and it
// checks every entry's CRC-32 and inflated size against the central directory.
'use strict';

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** Windows device names: opening `con.txt` or `aux` hits the device, with or without extension. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxNameLength: 240,
});

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Normalise an archive entry name to a safe relative POSIX path, or return null when it could
 * escape the destination (absolute, drive letter, UNC, `..`, NUL, empty segments, too long).
 */
function safeEntryPath(name, maxLen = DEFAULT_LIMITS.maxNameLength) {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLen) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return null;
  const p = name.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  const isDir = parts[parts.length - 1] === '';
  if (isDir) parts.pop();
  if (parts.length === 0) return null;
  for (const seg of parts) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (/[<>:"|?*]/.test(seg)) return null; // not representable on Windows (and ':' = ADS)
    if (/[. ]$/.test(seg)) return null; // Windows silently strips these: aliasing risk
    if (RESERVED_NAME.test(seg.split('.')[0].replace(/ +$/, ''))) return null;
  }
  return parts.join('/') + (isDir ? '/' : '');
}

/** Build a ZIP (deflate) from [{ name, data: Buffer, mode? }] entries. Deterministic timestamps. */
function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  for (const e of entries) {
    const name = safeEntryPath(e.name);
    if (!name || name.endsWith('/')) throw new Error(`zip: bad entry name ${JSON.stringify(e.name)}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix, so the mode bits below are meaningful
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((e.mode ?? (S_IFREG | 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

class ZipError extends Error {}

function fail(msg) {
  throw new ZipError(msg);
}

function findEnd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_END) return i;
  return fail('zip: no end of central directory');
}

function inflateEntry(body, method, usize, name) {
  if (method === 0) return body;
  try {
    return zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, usize) });
  } catch {
    return fail(`zip: corrupt or oversized entry ${name}`);
  }
}

function readCentral(buf, p, endAt) {
  if (p + 46 > endAt || buf.readUInt32LE(p) !== SIG_CENTRAL) fail('zip: bad central directory entry');
  const flags = buf.readUInt16LE(p + 8);
  const nlen = buf.readUInt16LE(p + 28);
  return {
    madeBy: buf.readUInt16LE(p + 4) >> 8,
    flags,
    method: buf.readUInt16LE(p + 10),
    crc: buf.readUInt32LE(p + 16),
    csize: buf.readUInt32LE(p + 20),
    usize: buf.readUInt32LE(p + 24),
    extAttr: buf.readUInt32LE(p + 38),
    lho: buf.readUInt32LE(p + 42),
    rawName: buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x0800 ? 'utf8' : 'latin1'),
    next: p + 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32),
  };
}

/**
 * Parse and fully validate an archive held in memory. Returns [{ path, dir, data }] with every
 * file inflated and CRC-checked; throws ZipError on anything suspicious.
 */
function readZip(buf, limits = DEFAULT_LIMITS) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('zip: too short');
  const endAt = findEnd(buf);
  const count = buf.readUInt16LE(endAt + 10);
  const cdSize = buf.readUInt32LE(endAt + 12);
  const cdOffset = buf.readUInt32LE(endAt + 16);
  if (buf.readUInt16LE(endAt + 4) !== 0 || buf.readUInt16LE(endAt + 6) !== 0) fail('zip: multi-disk archives are not supported');
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) fail('zip: ZIP64 is not supported');
  if (count > lim.maxEntries) fail('zip: too many entries');
  if (cdOffset + cdSize > endAt) fail('zip: central directory out of range');
  const out = [];
  const seen = new Set();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    const c = readCentral(buf, p, endAt);
    p = c.next;
    if (c.flags & 0x0001) fail(`zip: encrypted entry ${c.rawName}`);
    if (c.madeBy === 3 && ((c.extAttr >>> 16) & S_IFMT) === S_IFLNK) fail(`zip: symlink entry ${c.rawName}`);
    if (c.madeBy !== 3 && c.extAttr & 0x400) fail(`zip: reparse point entry ${c.rawName}`); // FILE_ATTRIBUTE_REPARSE_POINT
    const safe = safeEntryPath(c.rawName, lim.maxNameLength);
    if (!safe) fail(`zip: unsafe entry path ${JSON.stringify(c.rawName)}`);
    const key = safe.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) fail(`zip: duplicate entry ${safe}`);
    seen.add(key);
    if (c.usize > lim.maxEntryBytes) fail(`zip: entry too large ${safe}`);
    total += c.usize;
    if (total > lim.maxTotalBytes) fail('zip: archive too large when unpacked');
    if (safe.endsWith('/')) {
      out.push({ path: safe.slice(0, -1), dir: true, data: null });
      continue;
    }
    if (c.method !== 0 && c.method !== 8) fail(`zip: unsupported compression ${c.method}`);
    if (c.lho + 30 > cdOffset || buf.readUInt32LE(c.lho) !== SIG_LOCAL) fail(`zip: bad local header ${safe}`);
    const dataAt = c.lho + 30 + buf.readUInt16LE(c.lho + 26) + buf.readUInt16LE(c.lho + 28);
    if (dataAt + c.csize > cdOffset) fail(`zip: entry data out of range ${safe}`);
    const data = inflateEntry(buf.subarray(dataAt, dataAt + c.csize), c.method, c.usize, safe);
    if (data.length !== c.usize) fail(`zip: size mismatch ${safe}`);
    if (crc32(data) !== c.crc) fail(`zip: CRC mismatch ${safe}`);
    out.push({ path: safe, dir: false, data });
  }
  return out;
}

module.exports = { crc32, safeEntryPath, writeZip, readZip, ZipError, DEFAULT_LIMITS, S_IFLNK, S_IFREG };
