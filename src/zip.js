// A reader for .zip files, for the update check (DESIGN 9.28): the files of a Split Relay release as GitHub serves
// them. Node has no zip reader of its own and Split Relay has no dependencies, so this reads what such a file needs:
// stored and deflated entries, no encryption, no zip64. Every entry's CRC is checked, and a name that would leave the
// folder it is unpacked into is refused.

import zlib from 'node:zlib';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ZIP';
  }
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The most a release may unpack to, and the most files in one: far above a real release, far below a zip bomb. */
export const MAX_UNPACKED = 200 * 1024 * 1024;
export const MAX_ENTRIES = 5000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Uint8Array} buf */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip entry's name as a safe relative path with forward slashes, or null: an absolute path, a drive letter, a
 * backslash, a "..", an empty part, a control character or a name Windows can't keep ("con", a trailing dot or space)
 * is refused, so nothing is ever written outside the folder a release is unpacked into.
 * @param {string} name
 */
export function safeEntryName(name) {
  const n = String(name ?? '');
  if (!n || n.length > 240 || n.startsWith('/') || n.includes('\\') || n.includes(':') || /[\x00-\x1f\x7f<>"|?*]/.test(n)) return null;
  const parts = n.replace(/\/$/, '').split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[. ]$/.test(p)) return null;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) return null;
  }
  return parts.join('/');
}

/**
 * The files of a zip, unpacked in memory: [{ name, data }], folders left out, in the file's order.
 * Throws ZipError in words when the file is not a zip this reader takes, is damaged, or holds an unsafe name.
 * @param {Buffer} buf
 * @returns {{ name: string, data: Buffer }[]}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('The download is not a zip file (it is too short).');
  // the end record is at the very end, before an optional comment of up to 65535 bytes
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('The download is not a zip file, or it was cut short.');
  const count = buf.readUInt16LE(end + 10);
  const dirSize = buf.readUInt32LE(end + 12);
  const dirAt = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirAt === 0xffffffff) throw new ZipError('The zip file is of a kind (zip64) Split Relay does not read.');
  if (count > MAX_ENTRIES) throw new ZipError(`The zip file holds ${count} files: too many for a Split Relay release.`);
  if (dirAt + dirSize > end) throw new ZipError('The zip file is damaged (its list of files is cut short).');
  const out = [];
  const seen = new Set();
  let total = 0;
  let p = dirAt;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError('The zip file is damaged (its list of files is broken).');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new ZipError('The zip file is encrypted: Split Relay does not read that.');
    const isDir = raw.endsWith('/');
    const name = safeEntryName(raw);
    if (!name) throw new ZipError(`The zip file holds a file name that is not safe to unpack: "${raw.slice(0, 80)}".`);
    if (isDir) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError(`The zip file holds "${name}" twice.`);
    seen.add(key);
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" is packed in a way Split Relay does not read (method ${method}).`);
    if (packed === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff) throw new ZipError('The zip file is of a kind (zip64) Split Relay does not read.');
    total += size;
    if (total > MAX_UNPACKED) throw new ZipError('The zip file unpacks to more than a Split Relay release can be.');
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL) throw new ZipError(`The zip file is damaged ("${name}" is not where its list says).`);
    const at = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (at + packed > buf.length) throw new ZipError(`The zip file is damaged ("${name}" is cut short).`);
    const body = buf.subarray(at, at + packed);
    let data;
    try {
      data = method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body, { maxOutputLength: size + 1 });
    } catch {
      throw new ZipError(`The zip file is damaged ("${name}" does not unpack).`);
    }
    if (data.length !== size || crc32(data) !== crc) throw new ZipError(`The zip file is damaged ("${name}" fails its check).`);
    out.push({ name, data });
  }
  return out;
}
