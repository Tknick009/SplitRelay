// The control panel's web server (DESIGN.md section 6): the JSON API, the live event stream and the files in public\.
// It owns no race logic; every request goes to the `app` object main.js builds. Anything that changes something is
// accepted only from this PC, because the panel can also be watched from other computers on the timing network, and
// a click on a laptop across the tent must not move a gun time.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** @typedef {import('./engine.js').FeedEntry} FeedEntry */

/**
 * What the server needs from the rest of Split Relay (main.js implements it). Methods that change something may
 * throw an Error with a plain-English message and a `status` (400 bad input, 404 unknown id).
 * @typedef {object} PanelApp
 * @property {() => any} state  the State of section 6
 * @property {() => boolean} allowLan  whether other computers may watch
 * @property {(patch: any) => void} checkSettings  throws what updateSettings would, changes nothing
 * @property {(patch: any) => Promise<void>} updateSettings
 * @property {(body: any) => Promise<void>} addRace
 * @property {(id: string, body: any) => Promise<void>} updateRace
 * @property {(id: string) => Promise<void>} deleteRace  the only thing that takes a race's reads out of use (DESIGN 9.2
 *   R2); also takes a missing race (R6: it has reads but is not in the settings)
 * @property {(body: any) => any} planRace  body { id?, race?, delete?, activate? } -> RoutePlan & { raceId, unticked? }:
 *   what saving, deleting or switching to the race would do to the reads so far (DESIGN 9.2, 9.15); changes nothing
 * @property {(id: string) => Promise<{ raceId: string, raceName: string, why: string }[]>} activateRace  tick Active,
 *   untick the Active races that want the same reads (DESIGN 9.15 L3); resolves to the races unticked
 * @property {(id: string) => Promise<{ raceId: string, raceName: string, active: boolean, renamedFrom: string|null,
 *   why: string|null }>} restoreRace  put a missing race back from its race file (DESIGN 9.15 V2)
 * @property {(id: string, body: any) => Promise<void>} setGun  body { gun } (only a typed time)
 * @property {(id: string, opts: { includeFinished: boolean, force: boolean }) =>
 *   ({ sent: number, skippedFinished: number, outputs: any } | number | Promise<any>)} resendRace
 *   throws an Error with status 409 for a race that is not active, unless force
 * @property {(id: string) => Promise<void>} clearRace
 * @property {(id: string) => any[]} crossings
 * @property {(id: string, splitId: string, body: any) => Promise<void>} setSplitSending  body { on: boolean }: pause or
 *   play one split (DESIGN 9.17 P1)
 * @property {(id: string) => any} review  the race's Review list (DESIGN 9.17)
 * @property {(id: string, bib: string) => any} runner  one runner's columns, passes and estimates (DESIGN 9.17)
 * @property {(id: string, body: any) => any} assign  Move or Keep a pass whose column is in doubt (DESIGN 9.17 P2)
 * @property {(id: string, body: any) => any} addManual  send a made-up time (DESIGN 9.17 P3)
 * @property {(id: string, body: any) => any} removeManual  take a made-up time back (DESIGN 9.17 P3)
 * @property {(id: string, body: any) => any} sendFinished  "Send with finish place" (DESIGN 9.17 P4)
 * @property {(body: any) => Promise<void>} addOutput
 * @property {(id: string, body: any) => Promise<void>} updateOutput
 * @property {(id: string) => Promise<void>} deleteOutput
 * @property {(id: string) => Promise<any>} previewOutput
 * @property {(id: string) => Promise<void>} reconnectOutput
 * @property {() => string} expression
 * @property {() => Promise<{ dir: string, files: any[] }>} meetFiles  the meet files in data\meets (DESIGN 9.22)
 * @property {() => Promise<{ name: string, fileName: string, path: string, text: string, replaced: boolean }>} saveMeet
 *   the meet setup to data\meets\<meet name>.json; the panel downloads `text` too
 * @property {(body: any) => Promise<any>} previewMeet  body { meet, fileName? } | { saved } | { trackscore: true }, and
 *   removeOthers? -> MeetPreview (what a load would do; changes nothing)
 * @property {(body: any) => Promise<{ applied: any }>} applyMeet  body { meet, mode, base, removeOthers? }: the load,
 *   as ONE settings change; 409 when the setup changed since the preview
 * @property {(body: any) => Promise<any>} newMeet  body { confirm: true }: Start a new meet (9.22 M9)
 */

/** An error the panel shows as written. */
export class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// Browsers refuse a module script served with the wrong type, so .js must be text/javascript.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const MAX_BODY = 1024 * 1024;
// A browser tab that stopped reading (a sleeping laptop) must not make us buffer the whole race for it.
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;
const FS_TIMEOUT_MS = 8000;
const DRIVE_TIMEOUT_MS = 1500;
const MAX_ENTRIES = 5000;
// Folders Windows keeps at a drive's root that nobody picks a script from.
const HIDDEN_NAMES = new Set(['system volume information', '$recycle.bin', 'config.msi', 'recovery', '$winreagent',
  'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'dumpstack.log']);
// Keys left out when deciding whether State changed: they move every time it is built.
const VOLATILE_KEYS = new Set(['now', 'elapsedTicks', 'lastScanAt']);
// The panel keeps the newest 600 feed rows (public/app.js FeedStore): more in one batch would be thrown away there.
const FEED_KEEP = 600;
// While reads keep coming, feed events go out in batches at most this often: quick enough to look live.
const FEED_GAP_MS = 200;

/**
 * Whether a socket address is this PC: IPv4 127.x, IPv6 ::1, or an IPv4 loopback mapped into IPv6.
 * @param {string | undefined} address
 */
export function isLoopback(address) {
  const a = String(address ?? '').toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * This PC's DNS suffixes (the domain part of its full name, e.g. "lan" in timing-1.lan): from the host name itself,
 * USERDNSDOMAIN, and on Windows the TCP/IP settings (primary, per-adapter and DHCP suffixes, search list). Filled by
 * loadDnsSuffixes(); until then only the host name's own suffix is known.
 * @type {Set<string>}
 */
const dnsSuffixes = new Set();
let suffixLoad = null;

function addSuffix(s) {
  const v = String(s ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (v && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(v)) dnsSuffixes.add(v);
}

/**
 * Reads this PC's DNS suffixes once (later calls return the same promise). Never rejects: without them a full name
 * such as timing-1.lan is refused and the panel still opens at localhost, an IP address or the bare computer name.
 * @returns {Promise<void>}
 */
export function loadDnsSuffixes() {
  if (suffixLoad) return suffixLoad;
  const host = os.hostname().toLowerCase();
  if (host.includes('.')) addSuffix(host.slice(host.indexOf('.') + 1));
  addSuffix(process.env.USERDNSDOMAIN);
  suffixLoad = process.platform !== 'win32' ? Promise.resolve() : new Promise((resolve) => {
    // reg.exe by its full path, so nothing else called "reg" on the PATH can be run instead.
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFile(reg, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters', '/s'],
      { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (!err) {
          for (const m of String(stdout).matchAll(/^\s*(Domain|NV Domain|DhcpDomain|SearchList|NV SearchList)\s+REG_SZ\s+(.+?)\s*$/gim)) {
            for (const s of m[2].split(/[,\s]+/)) addSuffix(s);
          }
        }
        resolve(undefined);
      });
  });
  return suffixLoad;
}

/**
 * Whether a Host header names this PC in a way a person would type: localhost (or *.localhost), an IP address, this
 * computer's name, or its name with one of the PC's own DNS suffixes. Anything else means a web page tricked the
 * browser into calling us through a borrowed domain name (DNS rebinding: "timing-1.evil.example" pointed at 127.0.0.1),
 * so the request is refused.
 * @param {string | undefined} hostHeader
 * @param {{ hostname?: string, suffixes?: Iterable<string> }} [opts] for tests; default this PC
 */
export function hostAllowed(hostHeader, { hostname = os.hostname(), suffixes = dnsSuffixes } = {}) {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (!h) return true; // HTTP/1.0 tools; browsers always send Host
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return false;
    return /^[0-9a-f:.]+$/.test(h.slice(1, end));
  }
  const name = h.replace(/:\d+$/, '').replace(/\.$/, ''); // "timing-1.lan." is the same name as "timing-1.lan"
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  const me = String(hostname ?? '').trim().toLowerCase();
  if (!me) return false;
  const short = me.split('.')[0];
  if (name === me || name === short) return true;
  // <name>.local is this PC's own multicast-DNS name (what a Mac or phone on the timing network uses); .local cannot
  // be registered in public DNS, so it cannot be borrowed for rebinding from the internet.
  if (name === `${short}.local`) return true;
  for (const s of suffixes) if (name === `${short}.${String(s).toLowerCase()}`) return true;
  return false;
}

/** Promise with a deadline: a network share that never answers must not hang the request. */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
      timer.unref?.();
    }),
  ]);
}

function friendlyListenError(err, port) {
  if (err?.code === 'EADDRINUSE') {
    return `Port ${port} is already in use by another program (is Split Relay already running?). Close that program or choose another port.`;
  }
  if (err?.code === 'EACCES') return `Windows refused port ${port} (access denied). Choose another port.`;
  return `Can't open the control panel on port ${port}: ${err?.message ?? err}`;
}

function fileError(err, dir) {
  switch (err?.code) {
    case 'ENOENT': return new HttpError(404, `The folder ${dir} doesn't exist. Check the path, or that the computer sharing it is switched on.`);
    case 'ENOTDIR': return new HttpError(400, `${dir} is not a folder.`);
    case 'EACCES':
    case 'EPERM': return new HttpError(400, `Windows won't let Split Relay open ${dir} (permission denied).`);
    case 'EBUSY': return new HttpError(400, `${dir} is busy. Try again in a moment.`);
    case 'ETIMEDOUT': return new HttpError(504, `${dir} took too long to answer. Is the network share available?`);
    default: return new HttpError(400, `Can't open ${dir}: ${err?.message ?? err}`);
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Files given their modified time at most (times=1): the panel asks only for its few .ppl files. */
const MAX_TIMED = 100;

/**
 * One folder for the panel's Browse dialog: sub-folders, and the files with the wanted extension. No folder means the
 * list of drives on Windows (home elsewhere). With `times`, the first MAX_TIMED files also get their modified time
 * (`mtimeMs`), so the panel can offer "Use Lynx.ppl (modified today 09:12)"; a file that can't be looked at in time
 * just has none.
 * @param {string} dirParam
 * @param {string} extParam '.lss', 'lss' or '' for every file
 * @param {{ times?: boolean }} [opts]
 * @returns {Promise<{ dir: string, parent: string | null, entries: { name: string, path: string, type: 'dir'|'file', mtimeMs?: number }[], truncated?: boolean }>}
 */
export async function listFolder(dirParam, extParam, { times = false } = {}) {
  let ext = String(extParam ?? '').trim().toLowerCase();
  if (ext && !ext.startsWith('.')) ext = '.' + ext;
  let dir = String(dirParam ?? '').trim();
  if (dir.length >= 2 && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1).trim();
  if (!dir) {
    if (process.platform === 'win32') return { dir: '', parent: null, entries: await driveRoots() };
    dir = os.homedir();
  }
  // "C:" alone is "the current folder on drive C" to Windows; a person typing it means the drive.
  if (/^[A-Za-z]:$/.test(dir)) dir += path.sep;
  dir = path.resolve(dir);
  const timeout = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  let st;
  try {
    st = await withTimeout(fsp.stat(dir), FS_TIMEOUT_MS, timeout);
    // A pasted file path: show the folder it is in.
    if (st.isFile()) dir = path.dirname(dir);
  } catch (err) {
    throw fileError(err, dir);
  }
  let dirents;
  try {
    dirents = await withTimeout(fsp.readdir(dir, { withFileTypes: true }), FS_TIMEOUT_MS, timeout);
  } catch (err) {
    throw fileError(err, dir);
  }
  const entries = [];
  const links = [];
  for (const d of dirents) {
    if (HIDDEN_NAMES.has(d.name.toLowerCase()) || d.name.startsWith('$')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) entries.push({ name: d.name, path: full, type: 'dir' });
    else if (d.isFile()) {
      if (!ext || d.name.toLowerCase().endsWith(ext)) entries.push({ name: d.name, path: full, type: 'file' });
    } else if (d.isSymbolicLink()) links.push({ name: d.name, path: full });
  }
  // Junctions and links (e.g. "My Documents"): follow them to see what they point at; a broken one is left out.
  const resolved = await Promise.all(links.slice(0, 200).map((l) => withTimeout(fsp.stat(l.path), DRIVE_TIMEOUT_MS, timeout)
    .then((s) => (s.isDirectory() ? { ...l, type: 'dir' } : s.isFile() && (!ext || l.name.toLowerCase().endsWith(ext)) ? { ...l, type: 'file' } : null))
    .catch(() => null)));
  for (const r of resolved) if (r) entries.push(/** @type {any} */ (r));
  const dirs = entries.filter((e) => e.type === 'dir').sort(byName);
  const files = entries.filter((e) => e.type === 'file').sort(byName);
  if (times) {
    await Promise.all(files.slice(0, MAX_TIMED).map((f) => withTimeout(fsp.stat(f.path), DRIVE_TIMEOUT_MS, timeout)
      .then((s) => { if (Number.isFinite(s.mtimeMs)) f.mtimeMs = Math.round(s.mtimeMs); })
      .catch(() => { /* no time for this one */ })));
  }
  const all = [...dirs, ...files];
  const parent = path.dirname(dir);
  const out = { dir, parent: parent !== dir ? parent : null, entries: all.slice(0, MAX_ENTRIES) };
  if (all.length > MAX_ENTRIES) out.truncated = true;
  return out;
}

let driveCache = { at: 0, list: /** @type {any[]} */ ([]) };

/** The drive letters that exist. A mapped network drive that is slow to answer is still listed (it is there). */
async function driveRoots() {
  if (Date.now() - driveCache.at < 10_000) return driveCache.list;
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
  const found = await Promise.all(letters.map((l) => {
    const root = `${l}:\\`;
    return withTimeout(fsp.stat(root).then(() => true, () => false), DRIVE_TIMEOUT_MS, () => new Error('slow'))
      .catch(() => true)
      .then((ok) => (ok ? { name: root, path: root, type: 'dir' } : null));
  }));
  const list = found.filter(Boolean).sort(byName);
  driveCache = { at: Date.now(), list };
  return list;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** State without the parts that change every time it is built, to tell whether anything really changed. */
function stateSignature(state) {
  return JSON.stringify(state, (key, value) => (VOLATILE_KEYS.has(key) ? undefined : value));
}

/**
 * State for the live stream: without the feed. The feed is most of State's size (200 rows) and every one of its
 * entries already went out as its own 'feed' event, so sending it twice a second again cost each panel watching over
 * the tent's Wi-Fi about 90 KB/s. GET /api/state still has it, for a page that has just opened or reconnected.
 */
function streamState(state) {
  if (!isObj(state) || !('feed' in state)) return state;
  const { feed: _feed, ...rest } = state;
  return rest;
}

/**
 * The control panel server. Several listeners can be open at once only while the panel moves to a new port.
 * Call notify() whenever anything the panel shows may have changed and feed() for each FeedEntry.
 */
export class PanelServer {
  /** @type {PanelApp} */
  #app;
  #publicDir;
  #log;
  #stateIntervalMs;
  #heartbeatMs;
  #pollMs;
  #host;
  /** @type {Set<http.Server>} */
  #servers = new Set();
  /** @type {http.Server | null} the one new requests should be told about */
  #primary = null;
  /** @type {Set<{ res: http.ServerResponse, server: http.Server }>} */
  #clients = new Set();
  #stateTimer = null;
  #heartbeatTimer = null;
  #pollTimer = null;
  #lastStateAt = 0;
  #lastSig = '';
  #closed = false;
  #feedGapMs;
  /** @type {Map<number, FeedEntry>} feed entries waiting for the next flush */
  #feedPending = new Map();
  #feedTimer = null;
  #lastFeedAt = 0;

  /**
   * @param {{ app: PanelApp, publicDir?: string, log?: (line: string) => void, stateIntervalMs?: number,
   *   heartbeatMs?: number, pollMs?: number, host?: string }} opts
   *   stateIntervalMs: the shortest gap between two 'state' events (2 per second by default). heartbeatMs: an
   *   unnamed message keeps the page's "connection lost" watchdog quiet. pollMs: State is also compared this often,
   *   for the few changes that no module announces. host: IPv4 on every interface, like the RR12 input. A dual-stack
   *   (::) listener could share a port number with an IPv4 program on Windows, and then 127.0.0.1 and ::1 would reach
   *   two different programs; with IPv4 a clash is refused at once. Browsers fall back from ::1 to 127.0.0.1.
   *   feedGapMs: the shortest gap between two batches of 'feed' events while reads keep coming.
   */
  constructor({ app, publicDir = DEFAULT_PUBLIC_DIR, log = () => {}, stateIntervalMs = 500, heartbeatMs = 15_000, pollMs = 2000,
    host = '0.0.0.0', feedGapMs = FEED_GAP_MS }) {
    this.#app = app;
    this.#feedGapMs = feedGapMs >= 0 ? feedGapMs : FEED_GAP_MS;
    this.#publicDir = path.resolve(publicDir);
    this.#log = typeof log === 'function' ? log : () => {};
    this.#stateIntervalMs = stateIntervalMs;
    this.#heartbeatMs = heartbeatMs;
    this.#pollMs = pollMs;
    this.#host = host;
  }

  /** The port the panel is reachable on (the newest listener). */
  get port() {
    const a = this.#primary?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  /** How many browsers are watching the live stream. */
  get clientCount() {
    return this.#clients.size;
  }

  /**
   * Start listening on every interface. Rejects with a plain-English error when the port is taken.
   * @param {number} port 0 = any free port
   * @returns {Promise<number>} the port
   */
  async listen(port) {
    const server = await this.#open(port);
    this.#primary = server;
    this.#startTimers();
    loadDnsSuffixes(); // in the background: only full names like timing-1.lan wait for it
    return this.port;
  }

  /** Something the panel shows may have changed: send a 'state' event soon (at most every stateIntervalMs). */
  notify() {
    if (this.#closed || !this.#clients.size || this.#stateTimer) return;
    const wait = Math.max(0, this.#lastStateAt + this.#stateIntervalMs - Date.now());
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = null;
      this.#pushState();
    }, wait);
    this.#stateTimer.unref?.();
  }

  /**
   * A read was processed (or a held one was sent): pass it on. Entries are gathered until the end of this event-loop
   * turn (and at most every FEED_GAP_MS while reads keep coming), an entry updated twice meanwhile goes once with its
   * newest content, and of a flood only the newest FEED_KEEP go: the panel keeps that many rows, so the rest of an
   * RR12 Replay would only cost the tent's Wi-Fi and the browser. A single read still shows at once.
   * @param {FeedEntry} entry
   */
  feed(entry) {
    if (this.#closed || !this.#clients.size || !entry || entry.id == null) return;
    // a Map keeps the first position, the entry object is the newest version (the engine updates it in place)
    this.#feedPending.set(entry.id, entry);
    // Only the newest FEED_KEEP can be sent: holding the rest of a Replay until the next batch would cost memory.
    if (this.#feedPending.size > FEED_KEEP) this.#feedPending.delete(this.#feedPending.keys().next().value);
    if (this.#feedTimer) return;
    const wait = this.#lastFeedAt + this.#feedGapMs - Date.now();
    const flush = () => {
      this.#feedTimer = null;
      this.#flushFeed();
    };
    if (wait > 0) {
      const t = setTimeout(flush, wait);
      t.unref?.();
      this.#feedTimer = { cancel: () => clearTimeout(t) };
    } else {
      const t = setImmediate(flush);
      t.unref?.();
      this.#feedTimer = { cancel: () => clearImmediate(t) };
    }
  }

  #flushFeed() {
    let list = [...this.#feedPending.values()];
    this.#feedPending.clear();
    if (this.#closed || !this.#clients.size || !list.length) return;
    this.#lastFeedAt = Date.now();
    if (list.length > FEED_KEEP) list = list.sort((a, b) => a.id - b.id).slice(-FEED_KEEP);
    // Written in pieces of about 32 KB: one string for 600 entries would land in the heap's large-object space, which
    // is only freed by a full collection.
    let message = '';
    for (const e of list) {
      try {
        message += `event: feed\ndata: ${JSON.stringify(e)}\n\n`;
      } catch {
        // an entry that cannot be serialised is left out
      }
      if (message.length >= 32 * 1024) {
        this.#broadcast(message);
        message = '';
      }
    }
    if (message) this.#broadcast(message);
  }

  /** Stop listening and drop every connection (the open live streams included). */
  async close() {
    this.#closed = true;
    for (const t of [this.#stateTimer, this.#heartbeatTimer, this.#pollTimer]) if (t) clearTimeout(t);
    this.#stateTimer = this.#heartbeatTimer = this.#pollTimer = null;
    if (this.#feedTimer) this.#feedTimer.cancel();
    this.#feedTimer = null;
    this.#feedPending.clear();
    for (const c of this.#clients) c.res.destroy();
    this.#clients.clear();
    await Promise.all([...this.#servers].map((s) => this.#shut(s)));
    this.#servers.clear();
    this.#primary = null;
  }

  // ---- listeners --------------------------------------------------------------------------------------------

  #open(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.#handle(req, res, server).catch((err) => {
          this.#log(`[panel] request failed: ${err?.stack ?? err}`);
          if (!res.headersSent) this.#json(res, 500, { error: 'Split Relay hit an unexpected problem. The details are in the log file.' });
          else res.destroy();
        });
      });
      // Long-lived event streams must not be cut by Node's request timeout; keep-alive sockets close on their own.
      server.requestTimeout = 0;
      server.headersTimeout = 30_000;
      server.keepAliveTimeout = 5000;
      const failed = (err) => reject(new HttpError(400, friendlyListenError(err, port)));
      server.once('error', failed);
      server.listen({ port, host: this.#host }, () => {
        server.off('error', failed);
        server.on('error', (err) => this.#log(`[panel] server error: ${err?.message ?? err}`));
        server.on('clientError', (err, socket) => socket.destroy());
        this.#servers.add(server);
        resolve(server);
      });
    });
  }

  #shut(server) {
    return new Promise((resolve) => {
      for (const c of [...this.#clients]) {
        if (c.server === server) {
          c.res.destroy();
          this.#clients.delete(c);
        }
      }
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
      this.#servers.delete(server);
    });
  }

  /**
   * Move the panel to another port: the new listener opens first (so a busy port is refused before anything is
   * saved), and the old one closes once the answer to this request has gone out.
   * @param {number} port
   * @param {() => Promise<void>} commit saves the setting; when it throws the new listener closes again
   * @param {http.ServerResponse} res
   */
  async #moveTo(port, commit, res) {
    const old = [...this.#servers];
    const server = await this.#open(port);
    try {
      await commit();
    } catch (err) {
      await this.#shut(server);
      throw err;
    }
    this.#primary = server;
    this.#log(`[panel] the control panel moved to http://localhost:${port}/`);
    res.once('finish', () => {
      const t = setTimeout(() => old.forEach((s) => this.#shut(s)), 300);
      t.unref?.();
    });
  }

  #startTimers() {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => this.#broadcast('data: ping\n\n'), this.#heartbeatMs);
    this.#heartbeatTimer.unref?.();
    this.#pollTimer = setInterval(() => this.notify(), this.#pollMs);
    this.#pollTimer.unref?.();
  }

  // ---- requests ---------------------------------------------------------------------------------------------

  async #handle(req, res, server) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return this.#json(res, 400, { error: 'That address is not valid.' });
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const port = this.port ?? '';
    if (!hostAllowed(req.headers.host)) {
      return this.#refuse(res, isApi, `Open the control panel at http://localhost:${port}/ on the Split Relay PC.`);
    }
    const local = isLoopback(req.socket.remoteAddress);
    if (!local && !this.#allowLan()) {
      return this.#refuse(res, isApi, 'Watching Split Relay from other computers is switched off. On the Split Relay PC, ' +
        "open Settings, Control panel, and tick 'Let other computers on the network open this page'.");
    }
    if (isApi) return this.#api(req, res, url, local, server);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return this.#json(res, 405, { error: `${req.method} is not allowed here.` });
    }
    return this.#static(req, res, url);
  }

  #allowLan() {
    try {
      return !!this.#app.allowLan();
    } catch {
      return false;
    }
  }

  #refuse(res, isApi, message) {
    if (isApi) return this.#json(res, 403, { error: message });
    const body = `<!doctype html><meta charset="utf-8"><title>Split Relay</title><p style="font:16px sans-serif;margin:2em">${message}</p>`;
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  #json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }

  async #api(req, res, url, local, server) {
    const method = req.method ?? 'GET';
    const route = matchRoute(method, url.pathname);
    if (!route) return this.#json(res, 404, { error: `Split Relay has no ${url.pathname}.` });
    if (route.allow) {
      res.setHeader('Allow', route.allow.join(', '));
      return this.#json(res, 405, { error: `${method} is not allowed for ${url.pathname}.` });
    }
    const mutation = method !== 'GET' && method !== 'HEAD';
    if (mutation || route.localOnly) {
      if (!local) {
        const what = mutation ? 'Changes can only be made' : 'Folders can only be browsed';
        return this.#json(res, 403, { error: `${what} on the Split Relay PC itself (http://localhost:${this.port}/). ` +
          'From other computers the control panel is view-only.' });
      }
      // A page on another site can make the browser post to localhost; a real panel page always sends its own origin.
      const origin = req.headers.origin;
      if (mutation && origin !== undefined && !sameOrigin(origin, req.headers.host)) {
        return this.#json(res, 403, { error: 'Split Relay refused a change requested by another web page.' });
      }
    }
    try {
      const body = mutation ? await readBody(req) : undefined;
      await route.handler.call(this, { req, res, url, body, params: route.params, server });
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;
      if (status >= 500 && !(err instanceof HttpError) && err?.name !== 'ConfigError') {
        this.#log(`[panel] ${method} ${url.pathname} failed: ${err?.stack ?? err}`);
        return this.#json(res, 500, { error: `Split Relay hit an unexpected problem (${err?.message ?? err}). The details are in the log file.` });
      }
      // (a refusal may carry more for the panel: 9.23's Undo says which cells the scoreboards keep)
      const more = err?.body && typeof err.body === 'object' ? err.body : {};
      return this.#json(res, status, { ...more, error: String(err?.message ?? err) });
    } finally {
      if (mutation) this.notify();
    }
  }

  /** The answer to most changes: everything the page needs to repaint. */
  #state(res) {
    this.#json(res, 200, this.#app.state());
  }

  // ---- route handlers (called with this = the server) -------------------------------------------------------

  async getState({ res }) {
    this.#state(res);
  }

  async putSettings({ res, body }) {
    const panel = isObj(body) && isObj(body.panel) ? body.panel : null;
    const wanted = panel && 'port' in panel ? Number(panel.port) : NaN;
    let patch = body;
    if (wanted === this.port) {
      // The port the panel is on now is not a change. With --port it differs from the saved one, and the Control
      // panel card sends back the port it shows: saving the card (to tick "allow LAN") must not make a one-run
      // override permanent.
      const { port: _running, ...rest } = panel;
      patch = { ...body, panel: rest };
    }
    if (Number.isInteger(wanted) && wanted >= 1 && wanted <= 65535 && wanted !== this.port) {
      // validate first: "port in use" is the wrong message for a port that clashes with the RR12 input
      this.#app.checkSettings(patch);
      await this.#moveTo(wanted, () => this.#app.updateSettings(patch), res);
    } else {
      await this.#app.updateSettings(patch);
    }
    this.#state(res);
  }

  async postRace({ res, body }) {
    await this.#app.addRace(body);
    this.#state(res);
  }

  /**
   * What saving or deleting a race would do to the reads received so far, so the panel can say it before the operator
   * confirms (DESIGN 9.2). A POST because it carries the unsaved race; it changes nothing.
   */
  async postRacePreview({ res, body }) {
    this.#json(res, 200, await this.#app.planRace(body));
  }

  async putRace({ res, body, params }) {
    await this.#app.updateRace(params[0], body);
    this.#state(res);
  }

  async deleteRace({ res, params }) {
    await this.#app.deleteRace(params[0]);
    this.#state(res);
  }

  /**
   * "Switch to Boys 5K" (DESIGN 9.15 L3): the race is made Active and the Active races that take the same port,
   * contests or event are unticked. The answer is State, with `unticked` (which races were switched off, and why).
   */
  async postActivate({ res, params }) {
    const unticked = await this.#app.activateRace(params[0]);
    this.#json(res, 200, { ...this.#app.state(), unticked });
  }

  /**
   * "Put it back" (DESIGN 9.15 V2): a missing race comes back with the settings its race file keeps. The answer is
   * State, with `restored` ({ raceId, raceName, active, renamedFrom, why }: why = it came back not Active, and why).
   */
  async postRestore({ res, params }) {
    const restored = await this.#app.restoreRace(params[0]);
    this.#json(res, 200, { ...this.#app.state(), restored });
  }

  async postGun({ res, body, params }) {
    await this.#app.setGun(params[0], body);
    this.#state(res);
  }

  /**
   * body { includeFinished?, force? } -> { sent, skippedFinished, outputs }. The app refuses (409, in words) a race
   * that is not active unless force is set: TrackScore would switch to that race's event and wipe the live one.
   */
  async postResend({ res, body, params }) {
    if (body !== undefined && !isObj(body)) {
      throw new HttpError(400, 'Send the resend options as an object, for example { "includeFinished": false }.');
    }
    const opts = { includeFinished: body?.includeFinished === true, force: body?.force === true };
    let result;
    try {
      result = await this.#app.resendRace(params[0], opts);
    } catch (err) {
      // The engine says so with a code; the panel needs a 409 to offer "resend anyway" instead of a crash message.
      if (err?.code === 'RACE_INACTIVE' && !Number.isInteger(err?.status)) throw new HttpError(409, String(err.message));
      throw err;
    }
    this.#json(res, 200, typeof result === 'number' ? { sent: result } : result);
  }

  async postClear({ res, params }) {
    await this.#app.clearRace(params[0]);
    this.#state(res);
  }

  async getCrossings({ res, params }) {
    this.#json(res, 200, this.#app.crossings(params[0]));
  }

  // ---- Review (DESIGN 9.17) ---------------------------------------------------------------------------------

  /** Pause ({ on: false }) or play ({ on: true }) one split. The answer is State. */
  async postSplitSending({ res, body, params }) {
    if (!isObj(body) || typeof body.on !== 'boolean') {
      throw new HttpError(400, 'Send { "on": true } to play the split, or { "on": false } to pause it.');
    }
    await this.#app.setSplitSending(params[0], params[1], body);
    this.#state(res);
  }

  async getReview({ res, params }) {
    this.#json(res, 200, this.#app.review(params[0]));
  }

  async getRunner({ res, params }) {
    const view = this.#app.runner(params[0], params[1]);
    this.#json(res, 200, view);
  }

  /**
   * The answer to a Review action: what it did, and the race's Review list as it is now, so the panel can repaint the
   * list at once (State follows on the live stream).
   */
  #reviewAnswer(res, id, result) {
    this.#json(res, 200, { ...result, review: this.#app.review(id) });
  }

  /**
   * The answer to a change of one runner (DESIGN 9.23): what it did, the runner as it is now (the editor is drawn at
   * once) and the Review list.
   */
  #runnerAnswer(res, id, bib, result) {
    const runner = bib ? this.#app.runner(id, bib) : undefined;
    this.#json(res, 200, { ...result, ...(runner ? { runner } : {}), review: this.#app.review(id) });
  }

  /** GET /api/find?q= (9.23 F1): runners by bib, name or team, in every race. Read-only: LAN viewers can find too. */
  async getFind({ res, url }) {
    this.#json(res, 200, this.#app.find(url.searchParams.get('q') ?? ''));
  }

  /** GET /api/races/:id/grid[?since=rev] (9.23 F8): runners by splits, problems first; { rev, unchanged } when unchanged. */
  async getGrid({ res, url, params }) {
    this.#json(res, 200, this.#app.grid(params[0], url.searchParams.get('since')));
  }

  /** body { tod, to, only?, from? } (9.23 F2) -> { change, runner, review } */
  async postMove({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "tod": <time of day of the pass>, "to": "<split id>" | "none" | "finish" | "count" | "keep" }.');
    this.#runnerAnswer(res, params[0], params[1], await this.#app.movePass(params[0], params[1], body));
  }

  /**
   * "Missed 2400m: add it" (9.23 F13): body { splitId, passTod?, count?, also?, aside?, time? | tod?, basis?, withFinishPlace? }
   * -> { change, added, runner, review }; also (9.23 F16): the other runs of two mats missed apart, [{ splitId, count? }];
   * aside (9.23 F20): stray passes set aside in the same change (Not a split), [<time of day of each>]
   */
  async postMissed({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "splitId": "<the split the mat missed>", "passTod": <time of day of the pass in it> }.');
    this.#runnerAnswer(res, params[0], params[1], await this.#app.addMissed(params[0], params[1], body));
  }

  /** "Send bib 586 again" (9.23 F4) -> { sent, outputs, skipped, runner, review } */
  async postSendRunner({ res, params }) {
    this.#runnerAnswer(res, params[0], params[1], await this.#app.sendRunner(params[0], params[1]));
  }

  /** "Stop sending this runner" (9.24): body { from? } (the time of day of the pass it was pressed on) -> { change, runner, review } */
  async postStopRunner({ res, body, params }) {
    this.#runnerAnswer(res, params[0], params[1], await this.#app.stopRunner(params[0], params[1], isObj(body) ? body : {}));
  }

  /** "Send this runner again" (9.24) -> { change, runner, review } */
  async postResumeRunner({ res, params }) {
    this.#runnerAnswer(res, params[0], params[1], await this.#app.resumeRunner(params[0], params[1]));
  }

  /** "Not in this race" / "Count them here" / "It's right" (9.25): body { say: 'away' | 'here' } -> { change, runner, review } */
  async postPlaceRunner({ res, body, params }) {
    this.#runnerAnswer(res, params[0], params[1], await this.#app.placeRunner(params[0], params[1], isObj(body) ? body : {}));
  }

  /**
   * Load start lists (9.25): body { files: [{ name, text }] } (the entry files, one per event, named by event number)
   * -> the state, with startListLoad: { results: [{ file, ok, text }], notes, resent, held }
   */
  async postStartLists({ res, body }) {
    const startListLoad = await this.#app.loadStartLists(body);
    this.#json(res, 200, { ...this.#app.state(), startListLoad });
  }

  /** Remove one event's start list, or every list ('all') (9.25) -> the state, with startListRemove: { text, resent, held } */
  async deleteStartList({ res, params }) {
    const startListRemove = await this.#app.removeStartList(params[0]);
    this.#json(res, 200, { ...this.#app.state(), startListRemove });
  }

  // ---- Swapped bibs (DESIGN 9.27) ---------------------------------------------------------------------------

  /** GET /api/swaps -> { swaps: [{ a, b, at, atText, text, races: [{ raceId, raceName, text }] }] }, oldest first. Read-only. */
  async getSwaps({ res }) {
    this.#json(res, 200, this.#app.swaps());
  }

  /**
   * What a swap would do, in words; changes nothing. body { bib, other } (to enter it) or { bib, remove: true } (to
   * remove the one that bib is in) -> { a, b, remove, title, lead, confirm, races: [{ raceId, raceName, active, lines }], notes }
   */
  async postSwapPreview({ res, body }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "bib": "11", "other": "510" }: the two bibs whose chips were swapped.');
    this.#json(res, 200, await this.#app.swapPreview(body));
  }

  /**
   * "Swapped bibs": body { bib, other } (bib ran with the chip of other, and the other way round, in every race) ->
   * the state, with swapChange: { swap, removed: false, text, races: [{ raceId, raceName, active, lines, cells, leftover,
   * sentTo, notLive, resent, cleared }] }
   */
  async postSwap({ res, body }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "bib": "11", "other": "510" }: the two bibs whose chips were swapped.');
    const swapChange = await this.#app.addSwap(body);
    this.#json(res, 200, { ...this.#app.state(), swapChange });
  }

  /** "Remove swap": the swap this bib is in (either bib of the pair) -> the state, with swapChange (removed: true) */
  async deleteSwap({ res, params }) {
    const swapChange = await this.#app.removeSwap(params[0]);
    this.#json(res, 200, { ...this.#app.state(), swapChange });
  }

  // ---- Updates from GitHub (DESIGN 9.28) --------------------------------------------------------------------

  /** "Check for updates": asks GitHub now -> the state (update: { current, latest, available, error, ... }) */
  async postUpdateCheck({ res }) {
    this.#json(res, 200, await this.#app.checkUpdate());
  }

  /**
   * "Install update": downloads the newest release, checks it, puts it in place -> the state, with updateDone:
   * { from, to, changed, removed, restarts }. Split Relay then starts again by itself (restarts), or says to be started
   * again. 409 in words while a race is running.
   */
  async postUpdateInstall({ res }) {
    this.#json(res, 200, await this.#app.installUpdate());
  }

  /** Hide the note that an update was taken back -> the state */
  async postUpdateDismiss({ res }) {
    this.#json(res, 200, this.#app.dismissUpdateNote());
  }

  /** body { fix, confirm? } (9.23 F3) -> { change, undone, runner?, review }; 409 { code: 'UNDO_LEAVES', leaves } asks first */
  async postUndo({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "fix": 17 }: the change to undo.');
    const r = await this.#app.undo(params[0], body);
    const bibs = r?.change?.bibs ?? [];
    this.#runnerAnswer(res, params[0], bibs.length === 1 ? bibs[0] : null, r);
  }

  /** body { bib, tod, splitId } (splitId null = Keep) or { bib, all: 'move' | 'keep' } -> { assigned, change, review } */
  async postAssign({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "bib": "254", "tod": <time of day>, "splitId": "..." } (null keeps it), or { "bib": "254", "all": "move" }.');
    this.#reviewAnswer(res, params[0], await this.#app.assign(params[0], body));
  }

  /**
   * body { bib, splitId, time?, tod?, ifEmpty?, basis? }, { items: [...] } or { all: true } -> { added, skipped, change,
   * runner (one runner), review }. 9.23 F5: `tod` is a time of day ("16:36:43.6"), `time` a race time ("8:12.3").
   */
  async postManual({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "bib": "254", "splitId": "...", "time": "6:12.3" } (no time: the estimate), or { "all": true }.');
    const one = typeof body.bib === 'string' || typeof body.bib === 'number' ? String(body.bib) : null;
    this.#runnerAnswer(res, params[0], one, await this.#app.addManual(params[0], body));
  }

  /** body { bib, splitId } -> { removed, wasSent, note, change, runner, review } */
  async deleteManual({ res, body, params }) {
    if (!isObj(body)) throw new HttpError(400, 'Send { "bib": "254", "splitId": "..." }: the made-up time to take back.');
    this.#runnerAnswer(res, params[0], body.bib == null ? null : String(body.bib), await this.#app.removeManual(params[0], body));
  }

  /** body { bib, splitId } (one), { bib } (a runner's) or { all: true }; force for a race that is not Active */
  async postSendFinished({ res, body, params }) {
    if (body !== undefined && !isObj(body)) throw new HttpError(400, 'Send { "bib": "254", "splitId": "..." }, { "bib": "254" } or { "all": true }.');
    this.#reviewAnswer(res, params[0], await this.#app.sendFinished(params[0], body ?? {}));
  }

  async postOutput({ res, body }) {
    await this.#app.addOutput(body);
    this.#state(res);
  }

  async putOutput({ res, body, params }) {
    await this.#app.updateOutput(params[0], body);
    this.#state(res);
  }

  async deleteOutput({ res, params }) {
    await this.#app.deleteOutput(params[0]);
    this.#state(res);
  }

  async postPreview({ res, params }) {
    this.#json(res, 200, await this.#app.previewOutput(params[0]));
  }

  async postReconnect({ res, params }) {
    await this.#app.reconnectOutput(params[0]);
    this.#state(res);
  }

  async getFiles({ res, url }) {
    this.#json(res, 200, await listFolder(url.searchParams.get('dir') ?? '', url.searchParams.get('ext') ?? '',
      { times: url.searchParams.get('times') === '1' }));
  }

  async getExpression({ res }) {
    this.#json(res, 200, { expression: this.#app.expression() });
  }

  // ---- meet setup (DESIGN 9.22) -----------------------------------------------------------------------------

  /** The meet files saved on this PC (a local-only GET: it lists files). */
  async getMeetFiles({ res }) {
    this.#json(res, 200, await this.#app.meetFiles());
  }

  async postMeetSave({ res }) {
    this.#json(res, 200, await this.#app.saveMeet());
  }

  /**
   * What loading a meet would do. A POST: it carries the meet file, and it may dial TrackScore, which a LAN viewer must
   * not be able to make this PC do. It changes nothing.
   */
  async postMeetPreview({ res, body }) {
    this.#json(res, 200, await this.#app.previewMeet(body));
  }

  /** The load: State, with `applied` (what it did, for the toast). */
  async postMeetApply({ res, body }) {
    const { applied } = await this.#app.applyMeet(body);
    this.#json(res, 200, { ...this.#app.state(), applied });
  }

  /** Start a new meet: State, with `newMeet` (the archive folder and what was put away). */
  async postMeetNew({ res, body }) {
    const newMeet = await this.#app.newMeet(body);
    this.#json(res, 200, { ...this.#app.state(), newMeet });
  }

  async getEvents({ req, res, server }) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 10_000);
    const client = { res, server };
    this.#clients.add(client);
    const drop = () => this.#clients.delete(client);
    req.on('close', drop);
    res.on('error', drop);
    res.write('retry: 2000\n\n');
    // The page paints at once; later states only go out when something changed. If State moved on since the last
    // broadcast, everyone gets it now (the others would otherwise wait for the next change).
    let state;
    try {
      state = streamState(this.#app.state());
    } catch (err) {
      this.#log(`[panel] could not build the state: ${err?.message ?? err}`);
      return;
    }
    const sig = stateSignature(state);
    const message = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    if (sig === this.#lastSig) {
      res.write(message);
    } else {
      this.#lastSig = sig;
      this.#lastStateAt = Date.now();
      this.#broadcast(message);
    }
  }

  // ---- event stream -----------------------------------------------------------------------------------------

  #pushState() {
    if (this.#closed || !this.#clients.size) return;
    let state;
    try {
      state = streamState(this.#app.state());
    } catch (err) {
      // "still starting" (503): a panel that reconnected during a start gets the State once the app is ready, so
      // that is no error worth a stack trace in the day's log
      if (err?.status !== 503) this.#log(`[panel] could not build the state: ${err?.stack ?? err}`);
      return;
    }
    // Without the feed in it, a new read alone no longer makes State "changed": its 'feed' event carries it.
    const sig = stateSignature(state);
    if (sig === this.#lastSig) return;
    this.#lastSig = sig;
    this.#lastStateAt = Date.now();
    this.#broadcast(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }

  #broadcast(message) {
    for (const c of [...this.#clients]) {
      if (c.res.destroyed || c.res.writableEnded) {
        this.#clients.delete(c);
        continue;
      }
      if (c.res.writableLength > MAX_CLIENT_BACKLOG) {
        // it reconnects by itself and fetches a fresh State
        this.#clients.delete(c);
        c.res.destroy();
        continue;
      }
      c.res.write(message);
    }
  }

  // ---- static files -----------------------------------------------------------------------------------------

  async #static(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return this.#notFound(res);
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    // Only plain names below public\: no backslashes, drive letters, '..' or hidden files.
    if (/[\\:\0]/.test(rel)) return this.#notFound(res);
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p.startsWith('.'))) return this.#notFound(res);
    const file = path.join(this.#publicDir, ...parts);
    if (!file.startsWith(this.#publicDir + path.sep)) return this.#notFound(res);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return this.#notFound(res);
    }
    if (!st.isFile()) return this.#notFound(res);
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    // index.html is never cached, so a new Split Relay version is picked up by a plain reload; the rest is
    // revalidated every time (cheap: a 304 on loopback).
    const headers = {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (ext !== '.html' && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  #notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Routing

const P = PanelServer.prototype;
const ID = '([^/]+)';
/** [method, pattern, handler, localOnly] */
const ROUTES = [
  ['GET', '/api/state', P.getState],
  ['GET', '/api/events', P.getEvents],
  ['PUT', '/api/settings', P.putSettings],
  ['POST', '/api/races', P.postRace],
  // before the race routes with an id: 'preview' is not a race id (they are r_<random>)
  ['POST', '/api/races/preview', P.postRacePreview],
  ['PUT', `/api/races/${ID}`, P.putRace],
  ['DELETE', `/api/races/${ID}`, P.deleteRace],
  ['POST', `/api/races/${ID}/activate`, P.postActivate],
  ['POST', `/api/races/${ID}/restore`, P.postRestore],
  ['POST', `/api/races/${ID}/gun`, P.postGun],
  ['POST', `/api/races/${ID}/resend`, P.postResend],
  ['POST', `/api/races/${ID}/clear`, P.postClear],
  ['GET', `/api/races/${ID}/crossings`, P.getCrossings],
  // Review (DESIGN 9.17)
  ['POST', `/api/races/${ID}/splits/${ID}/sending`, P.postSplitSending],
  ['GET', `/api/races/${ID}/review`, P.getReview],
  ['GET', `/api/races/${ID}/runners/${ID}`, P.getRunner],
  ['POST', `/api/races/${ID}/assign`, P.postAssign],
  ['POST', `/api/races/${ID}/manual`, P.postManual],
  ['DELETE', `/api/races/${ID}/manual`, P.deleteManual],
  ['POST', `/api/races/${ID}/send-finished`, P.postSendFinished],
  // Fix a runner (DESIGN 9.23)
  ['GET', '/api/find', P.getFind],
  ['GET', `/api/races/${ID}/grid`, P.getGrid],
  ['POST', `/api/races/${ID}/runners/${ID}/move`, P.postMove],
  ['POST', `/api/races/${ID}/runners/${ID}/missed`, P.postMissed],
  ['POST', `/api/races/${ID}/runners/${ID}/send`, P.postSendRunner],
  // Stop sending a runner, send it again (DESIGN 9.24)
  ['POST', `/api/races/${ID}/runners/${ID}/stop`, P.postStopRunner],
  ['POST', `/api/races/${ID}/runners/${ID}/resume`, P.postResumeRunner],
  // Start lists; a runner who is not in this race (DESIGN 9.25)
  ['POST', `/api/races/${ID}/runners/${ID}/place`, P.postPlaceRunner],
  ['POST', '/api/startlists', P.postStartLists],
  ['DELETE', `/api/startlists/${ID}`, P.deleteStartList],
  // Swapped bibs (DESIGN 9.27): 'preview' before the route with a bib
  ['GET', '/api/swaps', P.getSwaps],
  ['POST', '/api/swaps/preview', P.postSwapPreview],
  ['POST', '/api/swaps', P.postSwap],
  ['DELETE', `/api/swaps/${ID}`, P.deleteSwap],
  // Updates from GitHub (DESIGN 9.28)
  ['POST', '/api/update/check', P.postUpdateCheck],
  ['POST', '/api/update/install', P.postUpdateInstall],
  ['POST', '/api/update/dismiss', P.postUpdateDismiss],
  ['POST', `/api/races/${ID}/undo`, P.postUndo],
  ['POST', '/api/outputs', P.postOutput],
  ['PUT', `/api/outputs/${ID}`, P.putOutput],
  ['DELETE', `/api/outputs/${ID}`, P.deleteOutput],
  ['POST', `/api/outputs/${ID}/preview`, P.postPreview],
  ['POST', `/api/outputs/${ID}/reconnect`, P.postReconnect],
  ['GET', '/api/files', P.getFiles, true],
  ['GET', '/api/expression', P.getExpression],
  // meet setup (DESIGN 9.22): the list is local only (files on this PC); the rest are changes, so loopback and same-Origin
  ['GET', '/api/meet/files', P.getMeetFiles, true],
  ['POST', '/api/meet/save', P.postMeetSave],
  ['POST', '/api/meet/preview', P.postMeetPreview],
  ['POST', '/api/meet/apply', P.postMeetApply],
  ['POST', '/api/meet/new', P.postMeetNew],
].map(([method, pattern, handler, localOnly = false]) => ({ method, re: new RegExp(`^${pattern}$`), handler, localOnly }));

/**
 * @returns {{ handler: Function, params: string[], localOnly: boolean, allow?: undefined }
 *   | { allow: string[] } | null}
 */
function matchRoute(method, pathname) {
  const allow = [];
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    let params;
    try {
      params = m.slice(1).map(decodeURIComponent);
    } catch {
      return null;
    }
    if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { handler: r.handler, params, localOnly: r.localOnly };
    allow.push(r.method);
  }
  return allow.length ? { allow } : null;
}

function sameOrigin(origin, host) {
  try {
    return new URL(origin).host.toLowerCase() === String(host ?? '').toLowerCase();
  } catch {
    return false; // 'null' (a sandboxed frame, a file:// page) is never the panel
  }
}

/** The JSON body of a change, or undefined when there is none. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(413, 'The request is too big.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
      failed = true;
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
      if (!text.trim()) return resolve(undefined);
      // Plain forms on other web sites can post text/plain without asking; JSON needs the browser's permission.
      if (!/json/i.test(String(req.headers['content-type'] ?? ''))) {
        return reject(new HttpError(415, 'Send the request body as JSON (Content-Type: application/json).'));
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON.'));
      }
    });
  });
}
