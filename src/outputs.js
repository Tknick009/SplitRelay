// Split crossings go out as the packets FinishLynx would have sent, rendered with the user's own .lss scripts, to every
// output (TrackScore XC, live results, ...). Each output owns its connection and its copy of its script. Nothing here
// may throw into the engine: a TrackScore that is down costs that output a queue, a script half-saved in Notepad costs a
// warning on its card, and neither stops the other outputs or the relay.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { stat, readFile } from 'node:fs/promises';
import { encodeCp1252 } from './cp1252.js';
import { formatLynxTod, formatRaceTime, parseTod } from './timefmt.js';
import { parseScript, renderUpdate, describeScript, escapeForDisplay } from './lss.js';

const MAX_QUEUE = 5000;
const RETRY_MS = [1000, 2000, 3000, 4000, 5000];
// Windows waits ~21 s before giving up on a host that never answers; the operator should see "no answer" sooner.
const CONNECT_TIMEOUT_MS = 5000;
const SCRIPT_POLL_MS = 2000;
const KEEPALIVE_MS = 10_000;
// A .lss is a few KB. Anything this big is the wrong file, and reading it every poll would be wasteful.
const MAX_SCRIPT_BYTES = 1024 * 1024;
// A scoreboard client that stops reading would otherwise make Node buffer every packet for it, forever.
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 1000;
// Nothing written to a socket can be held back later. A slow output (live results over a tent uplink) gets at most
// this much waiting in its socket; the rest waits in the link's own queue, where a packet that went out of date
// meanwhile (the runner finished: TrackScore would replace their finish place) is dropped before it is written, and
// the backlog shows as "behind" instead of hiding in the socket.
const SOCKET_BACKLOG_BYTES = 8 * 1024;
// "Written" only means this PC's network stack took the bytes. A TrackScore that stopped reading (hung, or busy) and
// then reset the connection never read what sat in the buffers meanwhile, and a connection dropped by the network
// loses what was in flight. So after a connection that was up drops, what it took in its last minute goes out again
// once it is back; a repeated split changes nothing in TrackScore (same place, same time).
const REDELIVER_MS = 60_000;
/** On a tcp-client socket: bytes written to it whose write has not called back yet. */
const IN_SOCKET = Symbol('bytes in the socket');
const MODES = ['tcp-client', 'tcp-server', 'udp'];
/** Body sections each stage can render, in lss.js's fall-back order. */
const BODY_SECTIONS = { results: ['results'], started: ['started', 'startlist', 'results'] };
const STAGE_NEEDS = { results: ';;Results', started: ';;Started, ;;StartList or ;;Results' };
const HAS_MID = /"MID"\s*:\s*\d+/;
const ALL_MIDS = /"MID"\s*:\s*\d+/g;
const LAYOUT = /Command=LayoutDraw;Name=([^;\r\n]*)/gi;

/**
 * @typedef {import('./engine.js').SplitPacket} SplitPacket
 *
 * @typedef {object} Output  one entry of config.outputs (DESIGN.md section 3)
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {'tcp-client'|'tcp-server'|'udp'} mode
 * @property {string} host  target address, or the bind address for tcp-server (default 0.0.0.0)
 * @property {number} port
 * @property {string} script  path of the .lss file
 * @property {'results'|'started'} stage
 * @property {string[]} races  race ids this output sends; [] = all
 * @property {'race'|'blank'} eventNumber
 * @property {1|2|3} precision
 * @property {string} mid  replaces "MID":<digits> in rendered packets when set
 *
 * @typedef {object} OutputStatus  DESIGN.md section 6, plus the fields marked (extra)
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {Output['mode']} mode
 * @property {string} target  'host:port'
 * @property {'connected'|'connecting'|'disconnected'|'listening'|'disabled'|'error'} state
 * @property {number} clients
 * @property {number} sent
 * @property {number} queued
 * @property {number|null} lastSentAt  wall ms
 * @property {string|null} lastError
 * @property {boolean} scriptOk
 * @property {string|null} scriptError
 * @property {{ sections: { name: string, lines: number }[], mid: string|null, usesCommands: boolean }} scriptInfo
 * @property {string} script  (extra) the script path in use
 * @property {number|null} scriptLoadedAt  (extra) wall ms
 * @property {string[]} scriptWarnings  (extra) parse warnings of the script, to show once on the card
 * @property {string[]} warnings  (extra) things the operator should fix, e.g. a Start List layout command
 * @property {number} dropped  (extra) packets this output could not send (script error, no client, queue full)
 * @property {number} refused  packets refused because they must never be sent: laps to go below 1 or above the race's
 *   split count, or a finish time in \14\06 (DESIGN 9.15 L6); each is logged as an error
 * @property {string|null} refusedReason  the last refusal in words (also first in `warnings`)
 * @property {string|null} refusal  (extra) why it last turned a packet away (switched off, a script error, not
 *   connected), null once it takes packets again; the engine names it in a feed row no output took (9.16 F3)
 * @property {number|null} localPort  (extra) bound port: tcp-server's listening port, the client's local port
 * @property {number|null} nextRetryAt  (extra) wall ms of the next connect/listen attempt
 * @property {number} behind  packets taken but not yet written to the network (queued, waiting for the script, or
 *   still in the socket's buffer)
 * @property {number} lagSec  age of the oldest of those, in seconds (0 when there are none); over 5 s the target is
 *   not keeping up
 *
 * @typedef {{ text: string, display: string, isJson: boolean, jsonErrors: string[], warnings: string[] }} Preview
 *
 * @typedef {{ seq: number, bytes: Buffer, display: string, at: number, ack: (ok: boolean) => void,
 *   current: () => boolean }} Item  one rendered packet; `ack` is called once, `current` says whether it is still
 *   worth sending (a packet that waited in a queue may have been replaced, or its runner may have finished)
 */

const str = (v) => (v == null || typeof v === 'symbol' ? '' : String(v));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function precisionOf(v) {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : 3;
}

function raceTime(ticks, precision) {
  return typeof ticks === 'number' && Number.isFinite(ticks) ? formatRaceTime(ticks, precision) : '';
}

/**
 * The LSS variable values FinishLynx has for this split crossing (DESIGN.md 4.7), all strings, ready for renderUpdate.
 * @param {SplitPacket} packet
 * @param {Partial<Output>} [output]
 * @returns {{ header: Record<number, string>, rows: Record<number, string>[] }}
 */
export function packetVariables(packet, output = {}) {
  const p = packet && typeof packet === 'object' ? packet : /** @type {any} */ ({});
  const race = p.race && typeof p.race === 'object' ? p.race : {};
  const o = output && typeof output === 'object' ? output : {};
  const precision = precisionOf(o.precision);
  const gun = typeof p.gunTicks === 'number' && Number.isFinite(p.gunTicks) ? formatLynxTod(p.gunTicks) : '';
  const header = {
    0x01: 'UNOFFICIAL',
    0x02: str(race.name),
    0x03: '',
    // '' never switches TrackScore's live race; a different event number that exists in its meet program wipes it
    0x04: o.eventNumber === 'blank' ? '' : str(race.eventNumber).trim(),
    0x05: str(race.round).trim(),
    0x06: str(race.heat).trim(),
    0x07: 'AUTO',
    0x08: str(p.runnerCount),
    0x09: 'RUNNING',
    0x0a: str(race.distance),
    0x0b: '',
    0x0c: '',
    // a time of day truncates (as formatTod does); only race times round up
    0x0d: gun,
    0x0e: gun.slice(0, -1),
    0x0f: gun.slice(0, -2),
  };
  /** @type {Record<number, string>} */
  const row = {};
  for (let code = 0x01; code <= 0x18; code++) row[code] = '';
  const gender = str(p.gender).trim().toUpperCase();
  const lapsToGo = p.lapsToGo ?? (Number.isInteger(p.splitCount) && Number.isInteger(p.splitIndex) ? p.splitCount - p.splitIndex : '');
  Object.assign(row, {
    0x01: str(p.place),
    0x03: str(p.bib),
    0x04: str(p.last), // FinishLynx's Name variable sends the last name
    0x05: str(p.team),
    // 0x06 (time) stays '': any value makes TrackScore treat the runner as a finisher
    0x08: raceTime(p.csTicks, precision),
    0x09: raceTime(p.lsTicks, precision),
    0x0a: str(lapsToGo),
    0x0b: gender === 'M' || gender === 'F' ? gender : '',
    0x17: str(p.first),
    0x18: str(p.last),
  });
  return { header, rows: [row] };
}

/**
 * DESIGN 9.15 L6: why a split packet must never go out, or null. TrackScore and Karmarush file a split in the column
 * "number of splits - laps to go": laps to go 0 means FINISHED there (the runner's place would become the split
 * place), more than the race's splits is no column at all, and any finish time (\14\06) makes the runner a finisher.
 * The engine never builds such a packet; this is the last check before the wire, so a bug can't reach a scoreboard.
 * @param {any} packet
 * @param {{ rows: Record<number, string>[] }} vars packetVariables(packet)
 * @returns {string | null}
 */
export function packetProblem(packet, vars) {
  const l2g = packet?.lapsToGo;
  const count = packet?.splitCount;
  // (9.26: the race's splits that are sent: a split that is counted only has no column on a scoreboard)
  const raceCount = Array.isArray(packet?.race?.splits) ? packet.race.splits.filter((s) => s?.collectOnly !== true).length : count;
  const who = `bib ${str(packet?.bib) || '?'}${packet?.splitName ? ` at ${packet.splitName}` : ''}`;
  if (!Number.isInteger(l2g)) return `laps to go "${str(l2g)}" is not a whole number (${who})`;
  if (l2g < 1) return `laps to go ${l2g} would mean "finished" to TrackScore and Karmarush (${who})`;
  if (!Number.isInteger(count) || l2g > count || l2g > raceCount) {
    return `laps to go ${l2g} is more than the race's ${Number.isInteger(raceCount) ? raceCount : '?'} splits (${who})`;
  }
  if (vars.rows.some((r) => str(r[0x06]) !== '')) return `the packet has a finish time, which would make the runner a finisher (${who})`;
  return null;
}

const SAMPLE_RACE = { id: '', name: 'Sample Race 5K', eventNumber: '1', round: '1', heat: '1', distance: '', gun: '', splits: [] };

/**
 * The packet "Preview packet" shows when there is no real one: an invented runner at split 2 of the first race this
 * output sends (so event number, name and split count are the real ones), else of a made-up race.
 * @param {object | null | undefined} config
 * @param {Partial<Output>} [output]
 * @returns {SplitPacket}
 */
export function samplePacket(config, output = {}) {
  const races = Array.isArray(config?.races) ? config.races.filter((r) => r && typeof r === 'object') : [];
  const wanted = Array.isArray(output?.races) ? output.races.map(String) : [];
  const sends = (r) => wanted.length === 0 || wanted.includes(String(r.id));
  const race = races.find((r) => sends(r) && r.active !== false) ?? races.find(sends) ?? SAMPLE_RACE;
  // (9.26: the splits that are sent: the sample is a packet that could go out)
  const splits = (Array.isArray(race.splits) ? race.splits : []).filter((s) => s?.collectOnly !== true);
  const splitCount = splits.length || 3;
  const splitIndex = Math.min(1, splitCount - 1);
  const gunTicks = parseTod(race.gun) ?? 360_000_000; // 10:00:00
  const csTicks = 3_123_450; // 5:12.345
  return {
    raceId: str(race.id), race, splitId: str(splits[splitIndex]?.id), splitIndex, splitCount,
    splitName: str(splits[splitIndex]?.name) || '2K', bib: '1234', first: 'Ada', last: 'Quill', team: 'Lakeside HS',
    gender: 'F', csTicks, lsTicks: 1_512_340, place: 12, lapsToGo: splitCount - splitIndex, gunTicks,
    tod: gunTicks + csTicks, runnerCount: 40, reason: 'new',
  };
}

/** A network error in words a timer can act on. */
function netError(err, host, port) {
  const target = `${host}:${port}`;
  switch (err?.code) {
    case 'ECONNREFUSED': return `Nothing is listening on ${target} (connection refused)`;
    case 'ETIMEDOUT': return `No answer from ${target} (timed out)`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'ENETDOWN': return `${target} cannot be reached from this PC (check the IP address and the network)`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME': return `Unknown computer name "${host}"`;
    case 'ECONNRESET':
    case 'ECONNABORTED':
    case 'EPIPE': return `${target} closed the connection`;
    case 'EADDRINUSE': return `Port ${port} is already in use by another program on this PC`;
    case 'EACCES': return `This PC does not allow using port ${port}`;
    case 'EADDRNOTAVAIL': return `${host} is not an IP address of this PC`;
    default: return `${target}: ${err?.message ?? err}`;
  }
}

function scriptReadError(err, path) {
  switch (err?.code) {
    case 'ENOENT': return `Script file not found: ${path}`;
    case 'EACCES':
    case 'EPERM': return `Not allowed to read the script file: ${path}`;
    case 'EISDIR': return `The script path is a folder, not a .lss file: ${path}`;
    case 'EBUSY': return `The script file is locked by another program: ${path}`;
    case 'EFBIG': return `${path} is too big to be a scoreboard script (over 1 MB); is it the right file?`;
    default: return `Could not read the script ${path}: ${err?.message ?? err}`;
  }
}

const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-GB');

/** `"C:\Lynx\XCScore.lss"` as Explorer's "Copy as path" gives it. */
function unquote(path) {
  const p = path.trim();
  return p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).trim() : p;
}

/** Config entry -> the values this module uses, plus what is wrong with it (shown as the output's error). */
function normalise(raw, index) {
  const rawMode = str(raw.mode).trim().toLowerCase();
  const mode = rawMode === '' ? 'tcp-client' : rawMode;
  const host = str(raw.host).trim() || (mode === 'tcp-server' ? '0.0.0.0' : '');
  const portText = str(raw.port).trim();
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  let configError = null;
  if (!MODES.includes(mode)) configError = `Unknown connection type "${raw.mode}" (use TCP client, TCP server or UDP)`;
  else if (!host) configError = 'No IP address is set for this output';
  else if (!(port >= (mode === 'tcp-server' ? 0 : 1) && port <= 65535)) configError = `"${portText}" is not a port number (1-65535)`;
  const stage = str(raw.stage).trim().toLowerCase() === 'started' ? 'started' : 'results';
  /** @type {Output} */
  const cfg = {
    id: str(raw.id).trim() || `#${index + 1}`,
    name: str(raw.name).trim() || `Output ${index + 1}`,
    enabled: raw.enabled !== false,
    mode: /** @type {Output['mode']} */ (mode),
    host,
    port,
    script: unquote(str(raw.script)),
    stage,
    races: Array.isArray(raw.races) ? raw.races.map((r) => str(r).trim()).filter(Boolean) : [],
    eventNumber: raw.eventNumber === 'blank' ? 'blank' : 'race',
    precision: /** @type {1|2|3} */ (precisionOf(raw.precision)),
    mid: str(raw.mid).trim(),
    // DESIGN 9.24: the engine sends this output a clearing line for a split that was taken back (off unless set)
    clearLines: raw.clearLines === true,
  };
  return { cfg, configError, portText };
}

const wants = (cfg, packet) => cfg.races.length === 0 || cfg.races.includes(str(packet.raceId));

function describePacket(p) {
  const at = p.splitName ? ` at ${p.splitName}` : '';
  return `bib ${str(p.bib) || '?'}${at}${p.place != null ? `, place ${p.place}` : ''}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Ends a socket politely (pending packets still leave) but never waits on a peer that does not answer. */
function endSocket(sock, graceMs) {
  return new Promise((resolve) => {
    if (sock.closed) {
      resolve();
      return;
    }
    const timer = setTimeout(() => sock.destroy(), graceMs);
    timer.unref?.();
    sock.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (sock.connecting || !sock.writable) sock.destroy();
    else sock.end();
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * @typedef {object} LinkHooks
 * @property {(msg: string) => void} log
 * @property {(item: Item) => void} packet  the packet went out (log it)
 * @property {(item: Item) => void} sent  the bytes were accepted by the socket (acknowledged)
 * @property {(item: Item, waiting: number) => void} queued
 * @property {(item: Item, why: string) => void} unsent  dropped (acknowledged as not delivered)
 * @property {(item: Item) => void} stale  out of date by the time it could go out: not sent
 * @property {(item: Item) => void} drop  dropped without a log line of its own (the output is closing)
 * @property {() => void} changed
 */

/** A queued packet is checked just before it is written; a check that fails to run keeps the packet. */
function stillCurrent(item) {
  try {
    return item.current();
  } catch {
    return true;
  }
}

/** Retry timing shared by the three connection kinds: 1 s, 2 s, 3 s ... then every 5 s. */
class Link {
  /** @param {{ host: string, port: number, retryMs: number[], hooks: LinkHooks }} o */
  constructor(o) {
    this.host = o.host;
    this.port = o.port;
    this.target = `${o.host}:${o.port}`;
    this.retryMs = o.retryMs;
    this.hooks = o.hooks;
    this.state = 'connecting';
    this.error = null;
    this.loggedError = null;
    this.attempts = 0;
    this.timer = null;
    this.nextRetryAt = null;
    this.localPort = null;
    this.closed = false;
  }

  retry(fn) {
    if (this.closed) return;
    this.clearTimer();
    const ms = this.retryMs[Math.min(this.attempts, this.retryMs.length - 1)];
    this.attempts++;
    this.nextRetryAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRetryAt = null;
      fn();
    }, ms);
    this.timer.unref?.();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRetryAt = null;
  }

  /** One log line per distinct failure, not one per retry every 5 s for the whole race. */
  logFailure(prefix) {
    if (this.error === this.loggedError) return;
    this.loggedError = this.error;
    this.hooks.log(`${prefix}${this.error}`);
  }

  info() {
    return { state: this.state, error: this.error, clients: 0, queued: 0, localPort: this.localPort, nextRetryAt: this.nextRetryAt };
  }
}

/** We dial the target (TrackScore XC on :5555). Packets queue while it is down and go out in order once it is back. */
class TcpClientLink extends Link {
  /**
   * @param {{ host: string, port: number, retryMs: number[], hooks: LinkHooks, connectTimeoutMs: number, maxQueue: number,
   *   backlogBytes?: number, queue?: Item[], redeliverMs?: number }} o
   */
  constructor(o) {
    super(o);
    this.connectTimeoutMs = o.connectTimeoutMs;
    this.maxQueue = o.maxQueue;
    this.backlogBytes = o.backlogBytes ?? SOCKET_BACKLOG_BYTES;
    /** @type {Item[]} */
    this.queue = o.queue ?? [];
    this.socket = null;
    this.connected = false;
    /** Sockets let go by reconnect() that are still flushing. */
    this.retiring = new Set();
    this.redeliverMs = o.redeliverMs ?? REDELIVER_MS;
    /** @type {{ item: Item, at: number }[]} what the socket took in the last redeliverMs, oldest first */
    this.recent = [];
    /** @type {Item[]} taken by a connection that dropped since: sent again on the next connect */
    this.again = [];
  }

  /** A packet the socket took: kept for redeliverMs, in case the connection drops before the peer read it. */
  remember(item) {
    const now = Date.now();
    this.recent.push({ item, at: now });
    let drop = 0;
    while (drop < this.recent.length && (now - this.recent[drop].at > this.redeliverMs || this.recent.length - drop > this.maxQueue)) drop++;
    if (drop) this.recent.splice(0, drop);
  }

  /** The connection that was up is gone: what it took in its last redeliverMs goes out again on the next connect. */
  dropped() {
    const cutoff = Date.now() - this.redeliverMs;
    const seen = new Set(this.again.map((x) => x.seq));
    for (const { item, at } of this.recent) {
      if (at < cutoff || seen.has(item.seq)) continue;
      seen.add(item.seq);
      // its own acknowledgement was given long ago: this copy acknowledges nothing
      this.again.push({ ...item, at: Date.now(), ack: () => {}, again: true });
    }
    this.recent = [];
  }

  start() {
    this.dial();
  }

  dial() {
    if (this.closed) return;
    this.clearTimer();
    this.state = 'connecting';
    this.connected = false;
    let sock;
    try {
      sock = net.connect({ host: this.host, port: this.port, noDelay: true, keepAlive: true, keepAliveInitialDelay: KEEPALIVE_MS });
    } catch (err) {
      this.error = netError(err, this.host, this.port);
      this.logFailure('cannot connect: ');
      this.retry(() => this.dial());
      return;
    }
    this.socket = sock;
    let up = false;
    let lastErr = null;
    sock.setTimeout(this.connectTimeoutMs, () => {
      if (up) return;
      lastErr = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      sock.destroy();
    });
    sock.once('connect', () => {
      up = true;
      sock.setTimeout(0);
      if (this.socket !== sock || this.closed) return;
      this.connected = true;
      this.state = 'connected';
      this.error = null;
      this.loggedError = null;
      this.attempts = 0;
      this.localPort = sock.localPort ?? null;
      const n = this.queue.length;
      const again = this.again.length;
      this.hooks.log(`connected to ${this.target}${n ? `; sending ${plural(n, 'queued packet')}` : ''}` +
        (again ? `${n ? ', and' : ';'} sending the ${plural(again, 'packet')} of the minute before the connection dropped again, in case they were never read (a repeated split changes nothing)` : ''));
      if (again) {
        // in their original order, before what was queued meanwhile (newer): the runner's last split stays last
        this.queue = [...this.again, ...this.queue].sort((a, b) => a.seq - b.seq);
        this.again = [];
        this.trim();
      }
      this.pump();
      this.hooks.changed();
    });
    // TrackScore never writes back; a target that does must not fill our receive buffer
    sock.on('data', () => {});
    sock.on('error', (err) => {
      lastErr = err;
    });
    sock.on('close', () => {
      this.retiring.delete(sock);
      if (this.socket !== sock) return;
      this.socket = null;
      this.connected = false;
      this.localPort = null;
      if (this.closed) return;
      this.state = 'connecting';
      if (up) {
        const why = lastErr ? netError(lastErr, this.host, this.port) : 'closed by the other side';
        this.error = `Connection to ${this.target} lost (${why})`;
        this.loggedError = this.error;
        this.hooks.log(`${this.error}; reconnecting, packets are queued until then`);
        this.dropped();
      } else {
        this.error = lastErr ? netError(lastErr, this.host, this.port) : `Could not connect to ${this.target}`;
        this.logFailure('cannot connect: ');
      }
      this.retry(() => this.dial());
      this.hooks.changed();
    });
  }

  write(item) {
    if (!stillCurrent(item)) {
      // A copy sent again after a drop that is out of date by now: the newer packet went (or goes) instead.
      if (item.again) this.hooks.log(`not sent again, out of date (the runner finished, or a newer packet replaced it): ${item.display}`);
      else this.hooks.stale(item);
      return;
    }
    const sock = this.socket;
    const n = item.bytes.length;
    sock[IN_SOCKET] = (sock[IN_SOCKET] ?? 0) + n;
    this.hooks.packet(item);
    sock.write(item.bytes, (err) => {
      sock[IN_SOCKET] -= n;
      if (!err) {
        this.remember(item);
        this.hooks.sent(item);
        this.pump();
      } else this.requeue(item, sock);
    });
  }

  /**
   * Whether the socket may take another packet now: less than backlogBytes handed to it and not called back yet.
   * Counted here rather than read from writableLength, which drops to 0 the moment the OS takes the bytes.
   */
  room() {
    const sock = this.socket;
    return !!(this.connected && sock?.writable && (sock[IN_SOCKET] ?? 0) < this.backlogBytes);
  }

  /** Queued packets into the socket, in order, while it has room. */
  pump() {
    while (this.queue.length && this.room()) this.write(this.queue.shift());
  }

  /** A write the connection died under goes back in the queue, in order, so a reset does not lose the packet. */
  requeue(item, from) {
    if (this.closed) {
      this.hooks.unsent(item, 'output stopped');
      return;
    }
    let i = 0;
    while (i < this.queue.length && this.queue[i].seq < item.seq) i++;
    this.queue.splice(i, 0, item);
    const again = this.connected && this.socket && this.socket !== from;
    this.hooks.log(again ? `sending again (the old connection dropped it): ${item.display}`
      : `will send again (the connection dropped before it was delivered): ${item.display}`);
    this.trim();
    if (again) this.pump();
    this.hooks.changed();
  }

  deliver(item) {
    // Behind earlier packets, or a socket that already holds enough: wait in the queue, in order.
    if (!this.queue.length && this.room()) {
      this.write(item);
      return;
    }
    this.queue.push(item);
    if (!this.connected) this.hooks.queued(item, this.queue.length);
    this.trim();
    if (this.connected) this.pump();
  }

  trim() {
    while (this.queue.length > this.maxQueue) {
      const item = this.queue.shift();
      if (item.again) continue; // a copy of a packet delivered before: dropping it loses nothing new
      this.hooks.unsent(item, `queue full at ${this.maxQueue} packets, the oldest is dropped`);
    }
  }

  /** The queue moves to the replacement link when the operator corrects the IP or port mid-race. */
  takeQueue() {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  reconnect() {
    if (this.closed) return;
    this.attempts = 0;
    this.loggedError = null;
    const old = this.socket;
    // The operator reconnects because the target looks stuck: what it may not have read goes out again.
    if (this.connected) this.dropped();
    this.socket = null;
    this.connected = false;
    if (old) {
      this.retiring.add(old);
      endSocket(old, CLOSE_GRACE_MS).then(() => this.retiring.delete(old));
    }
    this.dial();
  }

  async close() {
    this.closed = true;
    this.clearTimer();
    const socks = new Set([this.socket, ...this.retiring].filter(Boolean));
    this.socket = null;
    this.connected = false;
    this.state = 'disconnected';
    // Not delivered: the engine keeps them as not given to this output, so a later start sends them. (Copies waiting
    // to go out again after a drop were acknowledged before: nothing to report for them.)
    for (const item of this.takeQueue()) if (!item.again) this.hooks.drop(item);
    this.again = [];
    this.recent = [];
    await Promise.all([...socks].map((s) => endSocket(s, CLOSE_GRACE_MS)));
  }

  info() {
    let queued = 0;
    for (const item of this.queue) if (!item.again) queued++;
    return { ...super.info(), clients: this.connected ? 1 : 0, queued };
  }
}

/** Scoreboards dial us; every packet goes to every connected client, nothing is kept for clients that come later. */
class TcpServerLink extends Link {
  constructor(o) {
    super(o);
    this.server = null;
    /** @type {Set<net.Socket>} */
    this.clients = new Set();
    this.restarting = null;
  }

  start() {
    this.listen();
  }

  listen() {
    if (this.closed) return;
    this.clearTimer();
    this.state = 'connecting';
    const server = net.createServer((sock) => this.accept(server, sock));
    this.server = server;
    server.on('error', (err) => this.serverError(server, err));
    try {
      server.listen({ port: this.port, host: this.host }, () => {
        if (this.server !== server || this.closed) return;
        const addr = server.address();
        this.localPort = addr && typeof addr === 'object' ? addr.port : this.port;
        this.state = 'listening';
        this.error = null;
        this.loggedError = null;
        this.attempts = 0;
        this.hooks.log(`listening on ${this.host}:${this.localPort} for scoreboard clients`);
        this.hooks.changed();
      });
    } catch (err) {
      this.serverError(server, err);
    }
  }

  serverError(server, err) {
    if (this.server !== server) return;
    // accept errors (e.g. out of handles) leave the server listening
    if (server.listening) {
      this.hooks.log(`server error: ${err?.message ?? err}`);
      return;
    }
    this.server = null;
    this.localPort = null;
    this.state = 'error';
    this.error = netError(err, this.host, this.port);
    this.logFailure('cannot listen: ');
    closeServer(server);
    this.retry(() => this.listen());
    this.hooks.changed();
  }

  accept(server, sock) {
    if (this.server !== server || this.closed) {
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    sock.setKeepAlive(true, KEEPALIVE_MS);
    sock.on('data', () => {});
    sock.on('error', () => { /* 'close' follows */ });
    const who = `${str(sock.remoteAddress).replace(/^::ffff:/, '')}:${sock.remotePort}`;
    this.clients.add(sock);
    this.hooks.log(`client ${who} connected (${this.clients.size} connected)`);
    sock.on('close', () => {
      if (!this.clients.delete(sock) || this.closed) return;
      this.hooks.log(`client ${who} disconnected (${this.clients.size} connected)`);
      this.hooks.changed();
    });
    this.hooks.changed();
  }

  deliver(item) {
    const socks = [];
    for (const sock of this.clients) {
      if (sock.destroyed || !sock.writable) continue;
      if (sock.writableLength > MAX_CLIENT_BACKLOG) {
        this.hooks.log(`client ${str(sock.remoteAddress).replace(/^::ffff:/, '')}:${sock.remotePort} stopped reading; disconnected it`);
        sock.destroy();
        continue;
      }
      socks.push(sock);
    }
    if (!socks.length) {
      this.hooks.unsent(item, this.state === 'listening' ? 'no client is connected' : this.error ?? 'not listening yet');
      return;
    }
    this.hooks.packet(item);
    // Delivered once one client has taken it; dropped only if every client's write failed.
    let pending = socks.length;
    let done = false;
    for (const sock of socks) {
      sock.write(item.bytes, (err) => {
        pending--;
        if (!err && !done) {
          done = true;
          this.hooks.sent(item);
        } else if (pending === 0 && !done) {
          done = true;
          this.hooks.unsent(item, 'every client dropped the connection before it was written');
        }
      });
    }
  }

  reconnect() {
    if (this.closed) return;
    this.attempts = 0;
    this.loggedError = null;
    this.clearTimer();
    const server = this.server;
    const clients = [...this.clients];
    this.server = null;
    this.clients.clear();
    this.localPort = null;
    this.state = 'connecting';
    // the port is only free again once the old server has really closed; only the latest restart listens
    const restart = Promise.all([closeServer(server), ...clients.map((c) => endSocket(c, CLOSE_GRACE_MS))]).then(() => {
      if (this.restarting !== restart) return;
      this.restarting = null;
      this.listen();
    });
    this.restarting = restart;
  }

  async close() {
    this.closed = true;
    this.clearTimer();
    const server = this.server;
    const clients = [...this.clients];
    this.server = null;
    this.clients.clear();
    this.state = 'disconnected';
    await Promise.all([closeServer(server), ...clients.map((c) => endSocket(c, CLOSE_GRACE_MS)), this.restarting]);
  }

  info() {
    return { ...super.info(), clients: this.clients.size };
  }
}

/** One datagram per packet. Broadcast is allowed because scoreboards are often fed on x.x.x.255. */
class UdpLink extends Link {
  constructor(o) {
    super(o);
    this.socket = null;
  }

  start() {
    this.open();
  }

  open() {
    if (this.closed) return;
    this.clearTimer();
    this.state = 'connecting';
    let sock;
    try {
      sock = dgram.createSocket({ type: net.isIPv6(this.host) ? 'udp6' : 'udp4' });
    } catch (err) {
      this.fail(err);
      return;
    }
    this.socket = sock;
    sock.on('error', (err) => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.localPort = null;
      try {
        sock.close();
      } catch { /* already closed */ }
      this.fail(err);
    });
    sock.bind({ port: 0 }, () => {
      if (this.socket !== sock || this.closed) return;
      try {
        sock.setBroadcast(true);
      } catch { /* IPv6 has no broadcast */ }
      this.localPort = sock.address().port;
      this.state = 'connected';
      this.error = null;
      this.loggedError = null;
      this.attempts = 0;
      this.hooks.log(`sending UDP to ${this.target}`);
      this.hooks.changed();
    });
  }

  fail(err) {
    this.state = 'error';
    this.error = netError(err, this.host, this.port);
    this.logFailure('UDP socket error: ');
    this.retry(() => this.open());
    this.hooks.changed();
  }

  deliver(item) {
    const sock = this.socket;
    if (!sock) {
      this.hooks.unsent(item, this.error ?? 'the UDP socket is not open');
      return;
    }
    this.hooks.packet(item);
    const failed = (err) => {
      this.error = `UDP send failed: ${netError(err, this.host, this.port)}`;
      this.logFailure('');
      this.hooks.unsent(item, this.error);
      this.hooks.changed();
    };
    try {
      // sends made while the socket is still binding are queued by dgram itself
      sock.send(item.bytes, this.port, this.host, (err) => {
        if (err) {
          failed(err);
          return;
        }
        if (this.error && this.state === 'connected') {
          this.error = null;
          this.loggedError = null;
        }
        this.hooks.sent(item);
      });
    } catch (err) {
      failed(err);
    }
  }

  reconnect() {
    if (this.closed) return;
    this.attempts = 0;
    this.loggedError = null;
    const old = this.socket;
    this.socket = null;
    if (old) {
      try {
        old.close();
      } catch { /* already closed */ }
    }
    this.open();
  }

  async close() {
    this.closed = true;
    this.clearTimer();
    const sock = this.socket;
    this.socket = null;
    this.state = 'disconnected';
    if (!sock) return;
    await new Promise((resolve) => {
      try {
        sock.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/**
 * @typedef {object} Entry  one configured output and everything it owns
 * @property {Output} cfg
 * @property {string|null} configError
 * @property {TcpClientLink|TcpServerLink|UdpLink|null} link
 * @property {string} linkSig
 * @property {string} renderSig
 * @property {string|null} scriptPath  null until the first sync, so even an empty path gets checked (and reported)
 * @property {{ path: string, parsed: ReturnType<typeof parseScript>, info: ReturnType<typeof describeScript>,
 *   mtimeMs: number, size: number, loadedAt: number } | null} script
 * @property {string|null} loadError  the script could not be read (and there is no good copy)
 * @property {string|null} checkError  the script was read but renders nothing for this stage
 * @property {string|null} reloadWarning  a re-read failed; the last good copy is still in use
 * @property {boolean} loading  the first read of scriptPath is under way: packets wait in `waiting`
 * @property {{ packet: SplitPacket, ack: (ok: boolean) => void, at: number }[]} waiting
 * @property {Set<Item>} unacked  handed to the connection, not yet acknowledged (behind / lagSec)
 * @property {string|null} refusal  why deliver() last refused a packet (logged once per reason)
 * @property {number} loadSeq
 * @property {Promise<void>|null} checking
 * @property {string[]} sampleNotes
 * @property {Set<string>} sendNotes
 * @property {string|null} packetError
 * @property {number} sent
 * @property {number} dropped
 * @property {number} refused  packets refused as never sendable (laps to go out of range, a finish time: 9.15 L6)
 * @property {string|null} refusedReason  the last such refusal, in words
 * @property {number|null} lastSentAt
 * @property {boolean} removed
 */

/**
 * Sends split packets to the configured outputs (DESIGN.md 4.7, 9.5).
 *
 * `deliver(outputId, packet, ack)` is how the engine sends: one packet to one output, acknowledged once the socket
 * took the bytes, so the engine knows exactly what each output has. Besides the contract: `send(packet)` hands a packet
 * to every output that takes its race without acknowledgements (tools and tests); `checkScripts(outputId?)` re-reads
 * changed scripts now and resolves when done (the panel can await it before a preview); the constructor takes timing
 * knobs so tests can run in milliseconds. `sync()` is cheap and idempotent, and deliver/preview/reconnect call it
 * themselves, so a config change that the owner forgot to sync still takes effect with the next packet.
 *
 * Emits 'status' (OutputStatus[]) at most once per event-loop turn when anything changed, including a connect, a
 * script loaded or fixed, and every acknowledgement: main.js runs the engine's convergence on it.
 */
export class OutputManager extends EventEmitter {
  #getConfig;
  #log;
  #retryMs;
  #connectTimeoutMs;
  #maxQueue;
  #backlogBytes;
  #scriptPollMs;
  #redeliverMs;
  /** @type {Map<string, Entry>} */
  #entries = new Map();
  /** @type {Set<Promise<void>>} links being closed after a config change */
  #closing = new Set();
  #pollTimer = null;
  #statusTimer = null;
  #stopped = false;
  #stopping = null;
  #seq = 0;

  /**
   * @param {{ getConfig: () => any, log?: (line: string) => void, retryMs?: number[], connectTimeoutMs?: number,
   *   maxQueue?: number, socketBacklogBytes?: number, scriptPollMs?: number, redeliverMs?: number }} options
   *   socketBacklogBytes: how much a tcp-client socket may hold at a time (tests make it tiny). redeliverMs: after a
   *   tcp-client connection that was up drops, what it took in this many milliseconds before goes out again.
   */
  constructor({ getConfig, log = () => {}, retryMs = RETRY_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, maxQueue = MAX_QUEUE,
    socketBacklogBytes = SOCKET_BACKLOG_BYTES, scriptPollMs = SCRIPT_POLL_MS, redeliverMs = REDELIVER_MS } = /** @type {any} */ ({})) {
    super();
    this.#getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.#log = typeof log === 'function' ? log : () => {};
    const delays = Array.isArray(retryMs) ? retryMs.filter((ms) => Number.isFinite(ms) && ms >= 0) : [];
    this.#retryMs = delays.length ? delays : RETRY_MS;
    this.#connectTimeoutMs = connectTimeoutMs > 0 ? connectTimeoutMs : CONNECT_TIMEOUT_MS;
    this.#maxQueue = Number.isInteger(maxQueue) && maxQueue > 0 ? maxQueue : MAX_QUEUE;
    this.#backlogBytes = Number.isInteger(socketBacklogBytes) && socketBacklogBytes > 0 ? socketBacklogBytes : SOCKET_BACKLOG_BYTES;
    this.#scriptPollMs = scriptPollMs > 0 ? scriptPollMs : SCRIPT_POLL_MS;
    this.#redeliverMs = redeliverMs >= 0 ? redeliverMs : REDELIVER_MS;
  }

  /** Create, update or close connections to match config.outputs, and (re)load their scripts. */
  sync() {
    if (this.#stopped) return;
    const config = this.#config();
    if (!config) return; // keep running on the last good settings
    const list = Array.isArray(config.outputs) ? config.outputs : [];
    /** @type {Map<string, Entry>} */
    const next = new Map();
    list.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object') return;
      const { cfg, configError } = normalise(raw, i);
      if (next.has(cfg.id)) return; // a duplicated id: the first one wins
      const e = this.#entries.get(cfg.id) ?? this.#newEntry(cfg);
      this.#update(e, cfg, configError);
      next.set(cfg.id, e);
    });
    for (const [id, e] of this.#entries) {
      if (next.has(id)) continue;
      e.removed = true;
      this.#dropWaiting(e, 'output deleted');
      this.#closeLink(e);
      this.#say(e, 'output removed');
    }
    this.#entries = next;
    if (!this.#pollTimer) {
      this.#pollTimer = setInterval(() => this.#poll(), this.#scriptPollMs);
      this.#pollTimer.unref?.();
    }
  }

  /**
   * Hand one split packet to one output. Returns false at once when the output cannot take it now (unknown, disabled,
   * bad settings, script missing or broken); the engine then tries again when this output's status changes. Otherwise
   * the packet is sent or queued, and `ack(true)` follows once the socket accepted the bytes (tcp-client write done,
   * UDP datagram sent, tcp-server written to at least one client) or `ack(false)` when it was dropped (no client, queue
   * full, stopped, disabled, connection type changed, or out of date when its turn came). `ack` is never called
   * synchronously from inside deliver.
   * @param {string} outputId
   * @param {SplitPacket} packet
   * @param {(ok: boolean) => void} [ack]
   * @returns {boolean}
   */
  deliver(outputId, packet, ack) {
    const done = this.#once(ack);
    if (this.#stopped || !packet || typeof packet !== 'object') return false;
    this.sync();
    const e = this.#entries.get(str(outputId));
    if (!e) return false;
    try {
      const problem = packetProblem(packet, packetVariables(packet, e.cfg));
      if (problem) {
        // never on the wire; the engine does not get it back as sent, so it is not in that output's ledger either
        e.refused++;
        e.refusedReason = `Refused a packet that must never be sent: ${problem}. Split Relay has a bug; the log has the details.`;
        this.#say(e, `ERROR refused a packet that must never be sent: ${problem}: ${describePacket(packet)}`);
        this.#changed();
        return false;
      }
      let why = null;
      if (!e.cfg.enabled) why = 'switched off';
      else if (e.configError) why = e.configError;
      else if (e.script && e.checkError) why = e.checkError;
      else if (!e.script && !e.loading) why = `script error: ${e.loadError ?? 'no script loaded'}`;
      if (why) {
        this.#refuse(e, why);
        return false;
      }
      if (!e.script) {
        // The first read of the script is still under way (the relay just started): the packet waits for it.
        e.waiting.push({ packet, ack: done, at: Date.now() });
        while (e.waiting.length > this.#maxQueue) {
          const w = e.waiting.shift();
          this.#notSent(e, `more than ${this.#maxQueue} packets waiting for the script to load`, w.packet);
          w.ack(false);
        }
        this.#changed();
        return true;
      }
      const ok = this.#deliver(e, packet, done);
      if (!ok) return false;
      e.refusal = null;
      this.#changed();
      return true;
    } catch (err) {
      // one output's bug must not keep the packet from the others
      this.#say(e, `internal error while sending ${describePacket(packet)}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Fire and forget: the packet to every enabled output whose races include packet.raceId ([] = all), with nothing
   * acknowledged. For tools and tests; the engine uses deliver(). An output that cannot take it logs why.
   * @param {SplitPacket} packet
   * @returns {number} how many outputs it was meant for
   */
  send(packet) {
    if (this.#stopped || !packet || typeof packet !== 'object') return 0;
    this.sync();
    let n = 0;
    for (const e of this.#entries.values()) {
      if (!e.cfg.enabled || !wants(e.cfg, packet)) continue;
      n++;
      if (!this.deliver(e.cfg.id, packet)) {
        e.dropped++;
        this.#say(e, `not sent (${e.refusal ?? 'the output cannot take packets now'}): ${describePacket(packet)}`);
      }
    }
    this.#changed();
    return n;
  }

  /**
   * Exactly what this output would send for a packet (an invented runner when null), without sending it.
   * Throws when there is no output with that id.
   * @param {string} outputId
   * @param {SplitPacket | null} [packet]
   * @returns {Preview}
   */
  preview(outputId, packet = null) {
    this.sync();
    const e = this.#entry(outputId);
    void this.#check(e); // an edit saved a moment ago shows on the next preview
    if (!e.script) {
      const why = e.loadError ?? (e.loading ? 'The script is still loading; try again in a moment' : 'No script is loaded');
      return { text: '', display: '', isJson: false, jsonErrors: [], warnings: [why] };
    }
    const p = packet && typeof packet === 'object' ? packet : samplePacket(this.#config(), e.cfg);
    const r = this.#render(e, p);
    const warnings = [e.checkError, e.reloadWarning, ...r.notes, ...r.warnings, ...e.script.parsed.warnings]
      .filter((w, i, all) => w && all.indexOf(w) === i);
    return { text: r.text, display: escapeForDisplay(r.text), isJson: r.isJson, jsonErrors: r.jsonErrors, warnings };
  }

  /** Drop the connection (or listener / socket) and open it again now, and re-read the script. */
  reconnect(outputId) {
    if (this.#stopped) return;
    this.sync();
    const e = this.#entry(outputId);
    this.#say(e, 'reconnect requested');
    e.link?.reconnect();
    void this.#check(e, true);
    this.#changed();
  }

  /**
   * Re-read every changed script now (or just this output's) and resolve when that is done.
   * @param {string} [outputId]
   */
  async checkScripts(outputId) {
    const list = outputId == null ? [...this.#entries.values()] : [this.#entries.get(String(outputId))].filter(Boolean);
    await Promise.all(list.map(async (e) => {
      if (e.checking) await e.checking; // that one may have looked before the latest save
      await this.#check(e);
    }));
  }

  /** @returns {OutputStatus[]} in config order */
  status() {
    const config = this.#stopped ? null : this.#config();
    const raceIds = new Set((Array.isArray(config?.races) ? config.races : []).map((r) => str(r?.id)));
    return [...this.#entries.values()].map((e) => this.#statusOf(e, config ? raceIds : null));
  }

  /**
   * Close every connection, listener, socket and timer. What was not delivered is acknowledged as dropped, so the
   * engine sends it after the next start.
   */
  async stop() {
    if (this.#stopping) return this.#stopping;
    this.#stopped = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.#statusTimer) clearImmediate(this.#statusTimer);
    this.#statusTimer = null;
    const closes = [...this.#closing];
    for (const e of this.#entries.values()) {
      e.removed = true;
      const queued = (e.link?.info().queued ?? 0) + e.waiting.length;
      if (queued) this.#say(e, `stopped with ${plural(queued, 'packet')} not sent; they are sent when Split Relay starts again`);
      for (const w of e.waiting.splice(0)) w.ack(false);
      if (e.link) closes.push(e.link.close().catch(() => {}));
      e.link = null;
    }
    this.#stopping = Promise.all(closes).then(() => {});
    return this.#stopping;
  }

  /**
   * Packets taken by an output that are not on the network yet, per output, for the console at shutdown.
   * @returns {{ name: string, behind: number }[]}
   */
  undelivered() {
    return [...this.#entries.values()]
      .map((e) => ({ name: e.cfg.name, behind: e.unacked.size + e.waiting.length }))
      .filter((x) => x.behind > 0);
  }

  // ---------------------------------------------------------------------------------------------------------------

  #config() {
    try {
      const c = this.#getConfig();
      return c && typeof c === 'object' ? c : {};
    } catch (err) {
      this.#line(`[outputs] could not read the settings: ${err?.message ?? err}`);
      return null;
    }
  }

  #entry(outputId) {
    const e = this.#entries.get(str(outputId));
    if (!e) throw Object.assign(new Error(`There is no output with id "${str(outputId)}"`), { code: 'ENOOUTPUT' });
    return e;
  }

  /** @returns {Entry} */
  #newEntry(cfg) {
    return {
      cfg, configError: null, link: null, linkSig: '', renderSig: '', scriptPath: null, script: null, loadError: null,
      checkError: null, reloadWarning: null, loading: false, waiting: [], unacked: new Set(), refusal: null, loadSeq: 0,
      checking: null, sampleNotes: [], sendNotes: new Set(), packetError: null, sent: 0, dropped: 0, lastSentAt: null,
      refused: 0, refusedReason: null, removed: false,
    };
  }

  /** An acknowledgement called at most once, never synchronously, and never able to throw into a socket callback. */
  #once(ack) {
    let called = false;
    return (ok) => {
      if (called || typeof ack !== 'function') return;
      called = true;
      queueMicrotask(() => {
        try {
          ack(ok === true);
        } catch (err) {
          this.#line(`[outputs] an acknowledgement failed: ${err?.stack ?? err}`);
        }
      });
    };
  }

  /** One log line per reason an output turns packets away, not one per packet. */
  #refuse(e, why) {
    if (e.refusal === why) return;
    e.refusal = why;
    this.#say(e, `not taking packets (${why}); what it misses is sent once this is fixed`);
  }

  #update(e, cfg, configError) {
    e.cfg = cfg;
    e.configError = configError;
    const linkSig = !cfg.enabled || configError ? 'off' : `${cfg.mode}|${cfg.host}|${cfg.port}`;
    if (linkSig !== e.linkSig) this.#relink(e, linkSig);
    if (cfg.script !== e.scriptPath) {
      e.scriptPath = cfg.script;
      e.script = null;
      e.loadError = null;
      e.reloadWarning = null;
      e.checkError = null;
      e.sampleNotes = [];
      e.sendNotes.clear();
      e.loading = true;
      e.loadSeq++;
      e.checking = null; // a read of the old path discards itself (loadSeq)
      void this.#check(e);
    }
    const renderSig = `${cfg.stage}|${cfg.mid}`;
    if (renderSig !== e.renderSig) {
      e.renderSig = renderSig;
      this.#validate(e);
    }
  }

  #relink(e, linkSig) {
    const cfg = e.cfg;
    const carried = e.link instanceof TcpClientLink ? e.link.takeQueue() : [];
    this.#closeLink(e);
    e.linkSig = linkSig;
    const keep = linkSig !== 'off' && cfg.mode === 'tcp-client';
    if (carried.length && !keep) {
      const why = cfg.enabled ? 'connection type changed' : 'output disabled';
      this.#say(e, `${plural(carried.length, 'queued packet')} dropped (${why}); they are sent again when it can take them`);
      for (const item of carried) this.#settle(e, item, false);
      e.dropped += carried.length;
    }
    if (linkSig === 'off') return;
    const o = { host: cfg.host, port: cfg.port, retryMs: this.#retryMs, hooks: this.#hooks(e) };
    if (cfg.mode === 'tcp-client') {
      e.link = new TcpClientLink({ ...o, connectTimeoutMs: this.#connectTimeoutMs, maxQueue: this.#maxQueue, backlogBytes: this.#backlogBytes, queue: keep ? carried : [], redeliverMs: this.#redeliverMs });
    } else if (cfg.mode === 'tcp-server') e.link = new TcpServerLink(o);
    else e.link = new UdpLink(o);
    e.link.start();
    this.#changed();
  }

  #closeLink(e) {
    const link = e.link;
    e.link = null;
    if (!link) return;
    const p = link.close().catch(() => {});
    this.#closing.add(p);
    p.then(() => this.#closing.delete(p));
  }

  /** @returns {LinkHooks} */
  #hooks(e) {
    return {
      log: (msg) => this.#say(e, msg),
      packet: (item) => this.#say(e, item.display),
      sent: (item) => {
        e.sent++;
        e.lastSentAt = Date.now();
        this.#settle(e, item, true);
        this.#changed();
      },
      queued: (item, waiting) => this.#say(e, `queued (not connected, ${waiting} waiting): ${item.display}`),
      unsent: (item, why) => {
        e.dropped++;
        this.#say(e, `not sent (${why}): ${item.display}`);
        this.#settle(e, item, false);
        this.#changed();
      },
      stale: (item) => {
        this.#say(e, `not sent, out of date by the time it could go out (the runner finished, or a newer packet replaced it): ${item.display}`);
        this.#settle(e, item, false);
        this.#changed();
      },
      drop: (item) => {
        e.dropped++;
        this.#settle(e, item, false);
      },
      changed: () => this.#changed(),
    };
  }

  #settle(e, item, ok) {
    e.unacked.delete(item);
    item.ack(ok);
  }

  /**
   * Render, apply the MID override, notice problems, hand the bytes to the connection.
   * @returns {boolean} false when this output cannot send it (nothing was queued)
   */
  #deliver(e, packet, ack) {
    if (e.checkError) {
      this.#refuse(e, e.checkError);
      return false;
    }
    if (!e.link) {
      this.#refuse(e, 'output is not connected');
      return false;
    }
    const r = this.#render(e, packet);
    if (!r.text) {
      this.#refuse(e, 'the script renders nothing for a split');
      return false;
    }
    if (r.startList) e.sendNotes.add(r.startList);
    // invalid JSON is still sent (FinishLynx would send it too) but the card says why TrackScore ignores it
    const jsonError = r.jsonErrors.length ? `Packet is not valid JSON, TrackScore will drop it: ${r.jsonErrors[0]}` : null;
    if (jsonError && jsonError !== e.packetError) this.#say(e, jsonError);
    e.packetError = jsonError;
    const current = typeof packet.isCurrent === 'function' ? () => packet.isCurrent() !== false : () => true;
    /** @type {Item} */
    const item = { seq: ++this.#seq, bytes: encodeCp1252(r.text), display: escapeForDisplay(r.text), at: Date.now(),
      ack: typeof ack === 'function' ? ack : () => {}, current };
    e.unacked.add(item);
    e.link.deliver(item);
    return true;
  }

  #render(e, packet) {
    const cfg = e.cfg;
    const { header, rows } = packetVariables(packet, cfg);
    let r = renderUpdate(e.script.parsed, { stage: cfg.stage, header, rows });
    // A blank-but-present "LICENCE" clears the gender FinishLynx gave the runner in TrackScore: with no gender, the
    // line is left out of a JSON packet (lss drops the comma it leaves). Only JSON: a fixed-width scoreboard line
    // would shift.
    if (r.isJson && rows[0][0x0b] === '') r = renderUpdate(e.script.parsed, { stage: cfg.stage, header, rows, skipEmpty: [0x0b] });
    let text = r.text;
    const notes = [];
    if (cfg.mid) {
      if (!/^\d+$/.test(cfg.mid)) notes.push(`The MID override "${cfg.mid}" is not a number, so it is not applied`);
      else if (HAS_MID.test(text)) text = text.replace(ALL_MIDS, `"MID":${cfg.mid}`);
      else notes.push('A MID override is set, but this script has no "MID":<number> to replace');
    }
    // TrackScore XC re-arms (and may wipe) the live race on any layout whose name contains "start"
    let startList = null;
    for (const m of text.matchAll(LAYOUT)) {
      if (!/start/i.test(m[1])) continue;
      startList = `Every packet contains "Command=LayoutDraw;Name=${m[1].trim()}". TrackScore treats that as a re-arm ` +
        'and may wipe the live race: use a script (or stage) without that line for this output';
      notes.unshift(startList);
      break;
    }
    return { text, isJson: r.isJson, jsonErrors: r.jsonErrors, warnings: r.warnings, notes, startList };
  }

  /** Whether the loaded script can send anything for this output's stage, and what the operator should know. */
  #validate(e) {
    e.checkError = null;
    e.sampleNotes = [];
    e.sendNotes.clear();
    e.packetError = null; // it was about a packet rendered with the previous script or stage
    if (!e.script) return;
    const { parsed, info, path } = e.script;
    const keys = BODY_SECTIONS[e.cfg.stage] ?? BODY_SECTIONS.results;
    if (!keys.some((k) => Object.hasOwn(parsed.sections, k))) {
      const found = info.sections.map((s) => `;;${s.name}`).join(', ') || 'no sections at all';
      e.checkError = `${path} has no ${STAGE_NEEDS[e.cfg.stage]} section, so this output would send nothing (the file has ${found})`;
      return;
    }
    const r = this.#render(e, samplePacket(this.#config(), e.cfg));
    if (!r.text) {
      e.checkError = `${path} renders nothing for a split${r.warnings.length ? ` (${r.warnings[0]})` : ''}`;
      return;
    }
    e.sampleNotes = [...r.notes];
    // e.g. XCScore.lss's ;;StartedHeader: say so before the race, not after the first split
    if (r.jsonErrors.length) e.sampleNotes.push(`Packets from this script are not valid JSON, so TrackScore drops them: ${r.jsonErrors[0]}`);
  }

  #poll() {
    if (this.#stopped) return;
    for (const e of this.#entries.values()) void this.#check(e);
  }

  /** Stat the script and re-read it when it changed (or has never been read). Never rejects. */
  #check(e, force = false) {
    if (this.#stopped || e.removed) return Promise.resolve();
    if (e.checking) return e.checking;
    const p = this.#checkScript(e, e.loadSeq, e.scriptPath, force)
      .catch((err) => this.#say(e, `script check failed: ${err?.message ?? err}`))
      .finally(() => {
        if (e.checking === p) e.checking = null;
      });
    e.checking = p;
    return p;
  }

  async #checkScript(e, seq, path, force) {
    const current = () => !this.#stopped && !e.removed && e.loadSeq === seq;
    if (!path) {
      this.#loadFailed(e, 'No script file is chosen for this output');
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let before;
      let buf;
      let after;
      try {
        before = await stat(path);
        if (!current()) return;
        if (!before.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
        const known = e.script;
        if (!force && known && known.mtimeMs === before.mtimeMs && known.size === before.size) {
          if (e.reloadWarning) {
            e.reloadWarning = null; // the file is back as it was
            this.#changed();
          }
          return;
        }
        if (before.size > MAX_SCRIPT_BYTES) throw Object.assign(new Error('too big'), { code: 'EFBIG' });
        buf = await readFile(path);
        if (!current()) return;
        after = await stat(path);
        if (!current()) return;
      } catch (err) {
        if (current()) this.#readFailed(e, path, err);
        return;
      }
      // an editor mid-save: read again in a moment rather than parse half a file
      if (after.mtimeMs === before.mtimeMs && after.size === before.size && buf.length === after.size) {
        this.#loaded(e, path, buf, after);
        return;
      }
      await delay(100);
      if (!current()) return;
    }
    // still changing: the next poll tries again (packets keep waiting if this was the first read)
  }

  #readFailed(e, path, err) {
    const msg = scriptReadError(err, path);
    if (e.script) {
      // keep the copy we have: a script being saved, or a network share that blinked, must not stop the scoreboard
      const w = `Could not re-read the script (${msg}); still using the copy loaded at ${clockTime(e.script.loadedAt)}`;
      if (w !== e.reloadWarning) {
        e.reloadWarning = w;
        this.#say(e, w);
        this.#changed();
      }
      return;
    }
    this.#loadFailed(e, msg);
  }

  #loadFailed(e, msg) {
    const fresh = msg !== e.loadError;
    e.loadError = msg;
    e.loading = false;
    if (fresh) this.#say(e, `script error: ${msg}. This output sends nothing until the script is fixed; what it misses is sent then.`);
    this.#dropWaiting(e, `script error: ${msg}`);
    this.#changed();
  }

  #loaded(e, path, buf, st) {
    const parsed = parseScript(buf);
    const reload = e.script !== null;
    e.script = { path, parsed, info: describeScript(parsed), mtimeMs: st.mtimeMs, size: st.size, loadedAt: Date.now() };
    e.loadError = null;
    e.reloadWarning = null;
    e.loading = false;
    this.#validate(e);
    const sections = e.script.info.sections.map((s) => s.name).join(', ') || 'none';
    const warned = parsed.warnings.length ? `; ${plural(parsed.warnings.length, 'warning')}: ${parsed.warnings.join(' | ')}` : '';
    this.#say(e, `${reload ? 'script changed on disk, reloaded' : 'script loaded'}: ${path} (sections: ${sections})${warned}`);
    if (e.checkError) this.#say(e, `script error: ${e.checkError}`);
    for (const note of e.sampleNotes) this.#say(e, `warning: ${note}`);
    const waiting = e.waiting;
    e.waiting = [];
    for (const w of waiting) {
      let ok = false;
      try {
        ok = e.cfg.enabled && this.#deliver(e, w.packet, w.ack);
      } catch (err) {
        this.#say(e, `internal error while sending ${describePacket(w.packet)}: ${err?.message ?? err}`);
      }
      if (!ok) w.ack(false);
    }
    this.#changed();
  }

  #dropWaiting(e, why) {
    const waiting = e.waiting;
    e.waiting = [];
    for (const w of waiting) {
      this.#notSent(e, why, w.packet);
      w.ack(false);
    }
  }

  #notSent(e, why, packet) {
    e.dropped++;
    this.#say(e, `not sent (${why}): ${describePacket(packet)}`);
  }

  /** @returns {OutputStatus} */
  #statusOf(e, raceIds) {
    const cfg = e.cfg;
    const link = e.link?.info() ?? null;
    const scriptOk = e.script !== null && !e.checkError;
    const scriptError = e.loadError ?? e.checkError ?? null;
    let state;
    if (!cfg.enabled) state = 'disabled';
    else if (e.configError || scriptError) state = 'error';
    else state = link?.state ?? 'disconnected';
    const warnings = [e.refusedReason, e.reloadWarning, ...e.sampleNotes, ...e.sendNotes];
    if (raceIds && cfg.races.length && !cfg.races.some((id) => raceIds.has(id))) {
      warnings.push('This output is set to send only races that no longer exist, so it sends nothing');
    }
    const info = e.script?.info;
    let oldest = Infinity;
    for (const item of e.unacked) if (item.at < oldest) oldest = item.at;
    for (const w of e.waiting) if (w.at < oldest) oldest = w.at;
    const lagSec = oldest === Infinity ? 0 : Math.max(0, Math.round((Date.now() - oldest) / 100) / 10);
    return {
      id: cfg.id,
      name: cfg.name,
      enabled: cfg.enabled,
      mode: cfg.mode,
      target: `${cfg.host}:${Number.isFinite(cfg.port) ? cfg.port : ''}`,
      state,
      clients: link?.clients ?? 0,
      sent: e.sent,
      queued: (link?.queued ?? 0) + e.waiting.length,
      lastSentAt: e.lastSentAt,
      lastError: e.configError ?? scriptError ?? link?.error ?? e.packetError ?? null,
      scriptOk,
      scriptError,
      scriptInfo: { sections: info?.sections ?? [], mid: info?.mid ?? null, usesCommands: info?.usesCommands ?? false },
      script: cfg.script,
      scriptLoadedAt: e.script?.loadedAt ?? null,
      scriptWarnings: e.script ? [...e.script.parsed.warnings] : [],
      warnings: warnings.filter((w, i, all) => w && all.indexOf(w) === i),
      dropped: e.dropped,
      // 9.15 L6: packets that must never be sent (laps to go out of range, a finish time), refused and logged
      refused: e.refused,
      refusedReason: e.refusedReason,
      // why it last turned a packet away ('switched off', 'script error: ...'), for the feed's "no output took it"
      refusal: e.refusal,
      localPort: link?.localPort ?? null,
      nextRetryAt: link?.nextRetryAt ?? null,
      behind: e.unacked.size + e.waiting.length,
      lagSec,
    };
  }

  #say(e, msg) {
    this.#line(`[out ${e.cfg.name}] ${msg}`);
  }

  #line(text) {
    try {
      this.#log(text);
    } catch { /* a broken logger must not stop packets */ }
  }

  #changed() {
    if (this.#stopped || this.#statusTimer) return;
    this.#statusTimer = setImmediate(() => {
      this.#statusTimer = null;
      if (this.#stopped) return;
      try {
        this.emit('status', this.status());
      } catch (err) {
        console.error("[outputs] 'status' listener failed:", err);
      }
    });
    this.#statusTimer.unref?.();
  }
}
