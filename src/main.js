// Split Relay's entry point. Wires the RR12 input, the engine, the outputs, the merged .lif files and the control panel
// together, keeps a daily log of everything that came in and went out, and applies settings changes while running:
// on race day the relay is never restarted to change a port or a folder.
//
//   node src\main.js [--data <folder>] [--port <panel port>] [--no-open]

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InputServer, parseLine, buildExpression, LAPTIME_EXPRESSION } from './input.js';
import { NamesFile } from './ppl.js';
import { Engine } from './engine.js';
import { OutputManager } from './outputs.js';
import { LifSync } from './lif.js';
import { RaceStore, raceFileName, writeFileAtomic, fileStamp } from './store.js';
import { PanelServer, HttpError } from './server.js';
import { formatTod, formatRaceTime, TICKS_PER_SEC } from './timefmt.js';
import {
  ConfigFile, ConfigError, DEFAULT_PANEL_PORT, updateSettings, addRace, updateRace, deleteRace, patchRace, addOutput,
  updateOutput, deleteOutput, settleConflicts, activateRace, restoreRace, inputPorts, setSplitSending, webPortProblem,
  inputPortProblem,
} from './config.js';
import {
  buildMeet, meetText, meetFileName, meetFileOf, parseMeet, planMeet, meetPaths, meetSummary, trackScoreHost, trackScoreToMeet,
  raceRunning, RUNNING_READ_MS, MeetError,
} from './meet.js';
import { readTrackScore, TrackScoreError } from './trackscore.js';
import { noStartLists, normalizeStartLists, loadEntryFiles, removeStartList, startListsView } from './entries.js';
import { Updater, RESTART_CODE, GITHUB_API } from './update.js';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DATA_DIR = path.join(APP_DIR, 'data');

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

// ---------------------------------------------------------------------------------------------------------------
// Daily log

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Control characters shown as \0d etc., so one log line is one received line. */
function printable(text, max = 2000) {
  const s = String(text ?? '').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * data\logs\YYYY-MM-DD.log: one file per local day, each line stamped with the local time to the millisecond, so a
 * protest can be answered from the log alone ("what did RR12 send for bib 254, and what went to TrackScore?").
 * A full disk or a locked file costs the log, never the relay.
 */
export class DailyLog {
  #dir;
  #stream = null;
  #day = '';
  #failedAt = 0;
  #warn;
  /** Lines not handed to the file yet: written together at the end of this event-loop turn (or at 64 KB). */
  #pending = '';
  #flushTimer = null;
  /** The last Date.now() and its day and time stamp: thousands of lines share one millisecond in a Replay. */
  #stampMs = -1;
  #stampDay = '';
  #stamp = '';

  /** @param {{ dir: string, warn?: (line: string) => void }} opts warn: where a problem with the log itself goes */
  constructor({ dir, warn = (line) => console.error(line) }) {
    this.#dir = dir;
    this.#warn = warn;
  }

  get dir() {
    return this.#dir;
  }

  /** @param {string} line */
  write(line) {
    const ms = Date.now();
    if (ms !== this.#stampMs) {
      const d = new Date(ms);
      this.#stampMs = ms;
      this.#stampDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      this.#stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }
    if (this.#stampDay !== this.#day || !this.#stream) {
      this.#flush(); // what is waiting belongs to the previous day's file
      this.#open(this.#stampDay);
    }
    const s = String(line);
    this.#pending += `${this.#stamp} ${s.includes('\n') ? s.replace(/\r?\n/g, ' | ') : s}\r\n`;
    // One write per event-loop turn, not one per line: an RR12 Replay logs two lines for each of 40,000 reads.
    if (this.#pending.length >= 64 * 1024) this.#flush();
    else if (!this.#flushTimer) {
      this.#flushTimer = setImmediate(() => {
        this.#flushTimer = null;
        this.#flush();
      });
      this.#flushTimer.unref?.();
    }
  }

  #flush() {
    const text = this.#pending;
    this.#pending = '';
    if (!text || !this.#stream) return;
    try {
      this.#stream.write(text);
    } catch {
      // reported by the stream's 'error' handler
    }
  }

  #open(day) {
    if (this.#stream) this.#stream.end();
    this.#stream = null;
    this.#day = day;
    if (Date.now() - this.#failedAt < 10_000) return; // do not retry a broken disk on every line
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      const stream = fs.createWriteStream(path.join(this.#dir, `${day}.log`), { flags: 'a' });
      stream.on('error', (err) => {
        if (this.#stream === stream) this.#stream = null;
        this.#failedAt = Date.now();
        this.#warn(`Split Relay could not write its log file in ${this.#dir}: ${err?.message ?? err}`);
      });
      this.#stream = stream;
    } catch (err) {
      this.#failedAt = Date.now();
      this.#warn(`Split Relay could not open its log file in ${this.#dir}: ${err?.message ?? err}`);
    }
  }

  /** Flush and close the current file. */
  close() {
    if (this.#flushTimer) clearImmediate(this.#flushTimer);
    this.#flushTimer = null;
    this.#flush();
    const s = this.#stream;
    this.#stream = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => s.end(() => resolve(undefined)));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** Local time of day in ticks: RR12 and the gun are local wall-clock times. */
function localTod(ms = Date.now()) {
  const d = new Date(ms);
  return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * TICKS_PER_SEC + d.getMilliseconds() * 10;
}

/** This PC's IPv4 addresses, private LAN addresses first: what the operator types into RR12. */
function ipv4Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  const rank = (ip) => (/^(192\.168|10)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 0 : /^169\.254\./.test(ip) ? 2 : 1);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
}

const notFound = (what, id) => new HttpError(404, `There is no ${what} with id "${id}". It may have been deleted: reload the page.`);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- meet setup (DESIGN 9.22) -----------------------------------------------------------------------------------

/** A meet file bigger than this is not read (the panel refuses more than 1 MB too). */
const MAX_MEET_BYTES = 1024 * 1024;
/** The meet files the saved-meets list shows, newest first. */
const MAX_MEET_FILES = 50;
/** How long a path check may take (a dead \\server\share can hang for a minute), and how long its answer is reused. */
const PATH_CHECK_MS = 1500;
const PATH_CACHE_MS = 60_000;
/** data\meets\before-load\<stamp>.json: the setup as it was before a load (R14); the .config.json beside it is a copy. */
const BEFORE_LOAD_FILE = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.json$/;
const STALE_PREVIEW = 'The setup changed while the preview was open (a race was saved or a read came in). Look at the preview again.';
const BUSY = 'A meet change is already under way. Try again in a moment.';

/** "2026-10-21", local. */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The drive or \\server\share a path is on: one check at a time per share (R13). */
function shareOf(p) {
  const s = String(p);
  const unc = /^\\\\([^\\/]+)[\\/]([^\\/]+)/.exec(s);
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`.toLowerCase();
  const drive = /^([A-Za-z]):/.exec(s);
  return drive ? `${drive[1].toLowerCase()}:` : '';
}

/**
 * Whether a file or folder is on this PC: 'yes', 'no', or 'unknown' (no answer in PATH_CHECK_MS: a share that hangs).
 * @param {string} p
 * @param {'file'|'dir'} kind
 * @returns {Promise<'yes'|'no'|'unknown'>}
 */
function checkPathOnDisk(p, kind) {
  let timer;
  return Promise.race([
    fsp.stat(p).then((st) => ((kind === 'dir' ? st.isDirectory() : st.isFile()) ? 'yes' : 'no'), () => 'no'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('unknown'), PATH_CHECK_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

const meetHttpError = (err) => (err instanceof MeetError || err instanceof TrackScoreError ? new HttpError(err.status, err.message) : err);

/**
 * Whether another program on this PC listens on `port` (DESIGN 9.22 R17: another copy of Split Relay with the same meet
 * file): a listen that fails with EADDRINUSE, closed at once. It never connects anywhere; a connection that lands in the
 * moment it listens is closed (an RR12 exporter just tries again).
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portTakenOnPc(port) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.destroy());
    let timer;
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    timer = setTimeout(() => {
      server.close();
      done(false);
    }, 1000);
    timer.unref?.();
    server.once('error', (err) => done(err?.code === 'EADDRINUSE'));
    try {
      server.listen({ port, host: '0.0.0.0', exclusive: true }, () => server.close(() => done(false)));
    } catch {
      done(false);
    }
  });
}

/**
 * When the newest .lif file in a folder was written (ms), or null: none, no folder, or no answer in time (a share).
 * @param {string} dir
 */
async function newestLif(dir) {
  const run = (async () => {
    let newest = null;
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !/\.lif$/i.test(e.name)) continue;
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (st && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
    }
    return newest;
  })().catch(() => null);
  return (await withTimeout(run, PATH_CHECK_MS)) ?? null;
}

// The most reads handed to the engine together (see SplitRelay #queueRead); each batch is one journal write.
const READ_BATCH = 500;

// Revision 10: how long Play (and a Review send) waits at most for a fresh read of FinishLynx's folder, and how long
// one such read serves the next request (the panel sends "Send all with finish place" one split at a time).
const FRESH_SCAN_MS = 3000;
const FRESH_REUSE_MS = 1000;

// Log lines from the modules that also deserve the console window (the rest is file-only).
const PROBLEM = /\b(error|failed|fail|could not|couldn't|can't|cannot|refused|damaged|not saved|unexpected|denied)\b/i;

// ---------------------------------------------------------------------------------------------------------------
// The app

/**
 * Everything running together. `startApp()` builds and starts one; tests run several side by side on port 0.
 * Emits 'line' (console line) for anything the operator should see in the window.
 */
export class SplitRelay extends EventEmitter {
  #dataDir;
  /** 9.25: the start lists the operator loaded: the bibs of each event (data\startlists.json), never a name */
  #startLists = noStartLists();
  #publicDir;
  #panelPortOption;
  #inputOverride;
  #quiet;
  /** @type {DailyLog} */ #log;
  /** @type {ConfigFile} */ #cfg;
  /** @type {RaceStore} */ #store;
  /** @type {NamesFile} */ #names;
  /** @type {OutputManager} */ #outputs;
  /** @type {Engine} */ #engine;
  /** @type {LifSync} */ #lif;
  /**
   * One listener per RR12 input port (DESIGN 9.15 L2), in the order of the settings: configured port -> its listener
   * and what came in on it. Each overlapping race has its own RR12 exporter sending to its own port.
   * @type {Map<number, { server: InputServer, format: 'laptime'|'sr'|'json'|null, sig: string }>}
   */
  #inputs = new Map();
  /** One counter for every port's connections, so "#3" names one connection in the log. */
  #connSeq = 0;
  /** @type {PanelServer} */ #panel;
  /**
   * DESIGN 9.15 V1: races whose Active was unticked at start because they wanted the same reads as an Active race
   * before them in the settings. Shown in red on the Live tab until the operator saves or switches one of the two.
   * @type {import('./config.js').Unticked[]}
   */
  #startConflicts = [];
  /** How the settings were found at start (9.15 V2): whether config.json was put back from its backup. */
  #configLoad = { source: 'file', brokenFile: null, brokenFiles: [] };
  #ready = false;
  #stopping = null;
  #addresses = { at: 0, list: [] };
  #seenConns = new Set();
  #outputSigs = new Map();
  #namesSig = '';
  #lifError = null;
  /** Reads of the TCP chunk being split into lines, handed to the engine together (#queueRead). */
  #readBatch = [];
  /**
   * Splits whose Play is reading the FinishLynx folder first (revision 10, "Playing…"): "raceId|splitId". Shown as
   * RaceView.splits[].playing, so every panel watching says so.
   */
  #playing = new Set();
  /** race id|split id -> a counter a Pause raises, so a Play still reading FinishLynx's folder knows it was cancelled. */
  #playGen = new Map();
  /** When the last fresh read of FinishLynx's folder ended settled (Date.now()), 0 for none (#freshFinishers). */
  #freshAt = 0;
  /** 9.22: how a path is checked on this PC, and the answers of the last minute ('file|path' -> { at, state }) */
  #checkPath;
  #pathCache = new Map();
  /** 9.22: how TrackScore is asked (http.get; tests pass a stand-in) */
  #trackScoreGet;
  /** 9.22 R17: whether another program on this PC listens on a port (tests pass a stand-in) */
  #portTaken;
  /** 9.22: the saved-meets list's summaries, by file: read again only when a file's size or time changes */
  #meetCache = new Map();
  /** 9.22 (O6): a meet load or a new meet is under way: a second one is refused until it is done */
  #meetBusy = false;
  /** 9.28: the update check (GitHub releases) and its options */
  #updater = null;
  #updateOpts;

  /**
   * @param {{ dataDir?: string, panelPort?: number, inputPort?: number, publicDir?: string, quiet?: boolean,
   *   checkPath?: (p: string, kind: 'file'|'dir') => Promise<'yes'|'no'|'unknown'>, trackScoreGet?: typeof http.get,
   *   portTaken?: (port: number) => Promise<boolean> }} [opts]
   *   panelPort / inputPort override the saved settings for this run only (0 = any free port, for tests). With
   *   inputPort, the first RR12 input port listens there and every other one on a free port; the reads still count as
   *   from the configured ports (inputPortOf tells where each really listens). quiet: no console output (tests).
   *   checkPath, trackScoreGet, portTaken: for tests (a meet file's paths, Set up from TrackScore, a port in use).
   *   update (9.28): { check: ask GitHub for a newer release at start (off unless Split Relay is started from the
   *   command line), restartsItself: the launcher runs it, apiBase / fetchImpl / appDir: for tests }.
   */
  constructor({ dataDir = DEFAULT_DATA_DIR, panelPort, inputPort, publicDir, quiet = false, checkPath = checkPathOnDisk,
    trackScoreGet = http.get, portTaken = portTakenOnPc, update = {} } = {}) {
    super();
    this.#dataDir = path.resolve(dataDir);
    this.#publicDir = publicDir;
    this.#panelPortOption = panelPort ?? null;
    this.#inputOverride = inputPort ?? null;
    this.#quiet = quiet;
    this.#checkPath = checkPath;
    this.#trackScoreGet = trackScoreGet;
    this.#portTaken = portTaken;
    this.#updateOpts = isObj(update) ? update : {};
  }

  get dataDir() {
    return this.#dataDir;
  }

  get logDir() {
    return path.join(this.#dataDir, 'logs');
  }

  get config() {
    return this.#cfg?.config ?? null;
  }

  /** The panel's address on this PC. */
  get panelUrl() {
    return `http://localhost:${this.#panel?.port}/`;
  }

  get panelPort() {
    return this.#panel?.port ?? null;
  }

  /** The port RR12 should dial for the first RR12 input (the one actually bound). */
  get inputPort() {
    const first = this.#inputs.values().next().value;
    return first ? first.server.status().port : null;
  }

  /**
   * Where the listener of a configured RR12 input port really listens (the same port, unless a test asked for any
   * free port), or null when there is no such input.
   * @param {number} port
   */
  inputPortOf(port) {
    return this.#inputs.get(port)?.server.status().port ?? null;
  }

  /**
   * Every RR12 input port together (State.input): listening (all of them), port (the first one's real port, as before
   * revision 7), ports, listeningCount, error (the first), connections, totalLines, lastLineAt, totalDropped.
   */
  inputStatus() {
    return this.#aggregateInput(this.inputsStatus());
  }

  /**
   * State.inputs (DESIGN 9.15 L2): one entry per RR12 input port, in the settings' order. `port` is the configured
   * port (what a race chooses), `boundPort` where it really listens, `format` what its last line was.
   * @returns {{ port: number, boundPort: number|null, listening: boolean, error: string|null, connections: any[],
   *   totalLines: number, lastLineAt: number|null, totalDropped: number, format: 'laptime'|'sr'|'json'|null }[]}
   */
  inputsStatus() {
    return [...this.#inputs].map(([port, inp]) => {
      const st = inp.server.status();
      return { ...st, port, boundPort: st.listening ? st.port : null, connections: st.connections.map((c) => ({ ...c, port })),
        format: inp.format };
    });
  }

  /** State.input: every port together, as the top bar's pill shows it ("Receiving on 2 ports"). */
  #aggregateInput(list) {
    const first = list[0];
    const lastLineAt = list.reduce((m, i) => (i.lastLineAt !== null && (m === null || i.lastLineAt > m) ? i.lastLineAt : m), null);
    return {
      listening: list.length > 0 && list.every((i) => i.listening),
      // the first input's real port, as before revision 7 (tests and the console banner dial it)
      port: first?.boundPort ?? first?.port ?? null,
      ports: list.map((i) => i.port),
      listeningCount: list.filter((i) => i.listening).length,
      error: list.find((i) => i.error)?.error ?? null,
      connections: list.flatMap((i) => i.connections),
      totalLines: list.reduce((n, i) => n + i.totalLines, 0),
      lastLineAt,
      totalDropped: list.reduce((n, i) => n + (i.totalDropped ?? 0), 0),
    };
  }

  /**
   * Start everything. The panel's port is claimed first: it doubles as the "only one Split Relay" lock, so a second
   * copy started by a double double-click stops before it touches the data folder. Rejects with an error whose code is
   * 'ALREADY_RUNNING' (with .url) in that case.
   */
  async start() {
    fs.mkdirSync(this.#dataDir, { recursive: true });
    const configFile = path.join(this.#dataDir, 'config.json');
    // The lock comes before anything is read or written in the data folder, so a second copy changes nothing there.
    this.#panel = new PanelServer({ app: this, publicDir: this.#publicDir, log: (l) => this.#moduleLine(l) });
    const panelPort = this.#panelPortOption ?? savedPanelPort(configFile);
    try {
      await this.#panel.listen(panelPort);
    } catch (err) {
      const url = `http://localhost:${panelPort}/`;
      if (panelPort && (await isSplitRelayAt(panelPort))) {
        throw Object.assign(new Error(`Split Relay is already running: its control panel is at ${url}`), { code: 'ALREADY_RUNNING', url });
      }
      throw Object.assign(new Error(`${err.message} Start Split Relay with --port <another port> to use a different one.`), { code: 'PANEL_PORT' });
    }

    this.#log = new DailyLog({ dir: this.logDir, warn: (line) => this.#say(line) });
    this.#line(`---- Split Relay ${VERSION} starting (data folder ${this.#dataDir})`);
    this.#cfg = new ConfigFile({ file: configFile, log: (l) => this.#moduleLine(l) });
    const loaded = this.#cfg.load();
    if (loaded.created) this.#line(`[config] new settings file ${this.#cfg.file}`);
    for (const n of loaded.notes) this.#say(n);
    // only a start renames a damaged config.json, so the list is read once, here
    let brokenFiles = [];
    try {
      brokenFiles = fs.readdirSync(this.#dataDir).filter((n) => /^config\.broken-.*\.json$/i.test(n)).sort().reverse();
    } catch {
      // only a hint for the panel
    }
    this.#configLoad = { source: loaded.source ?? 'file', brokenFile: loaded.brokenFile ?? null, brokenFiles };
    // 9.15 V1: two Active races that want the same reads (a hand edit, an older config.json put back) are never split
    // silently: the first keeps them, the later ones are unticked, and the Live tab says so in red.
    const settled = settleConflicts(this.#cfg.config);
    if (settled.unticked.length) {
      this.#startConflicts = settled.unticked;
      for (const u of settled.unticked) {
        this.#say(`[config] '${u.raceName}' was switched off (Active unticked): it and '${u.keptName}' ${u.why}, and only one Active race can take those reads`);
      }
      this.#cfg.set(settled.config).catch(() => { /* logged by ConfigFile; the change is in use */ });
    }

    this.#store = new RaceStore({ dir: path.join(this.#dataDir, 'races'), journalFile: path.join(this.#dataDir, 'reads.jsonl'),
      log: (l) => this.#moduleLine(l) });
    const getConfig = () => this.#cfg.config;

    this.#names = new NamesFile({ path: this.config.names.pplPath });
    this.#names.on('change', (st) => this.#onNames(st));

    // Outputs before the engine: the engine hands its packets to them. Every status change (connected, a script
    // loaded or fixed, a packet acknowledged) lets the engine deliver what an output is missing.
    this.#outputs = new OutputManager({ getConfig, log: (l) => this.#log.write(l) });
    this.#outputs.on('status', (list) => {
      this.#onOutputs(list);
      this.#engine?.converge(list);
    });
    this.#outputs.sync();

    // 9.25: the start lists the operator loaded are in the data folder: the engine is told who is entered where
    this.#startLists = this.#readStartLists();
    // The engine replays the read journal now, but delivers nothing until FinishLynx's files have been read: a
    // restart must never send a split to a runner FinishLynx has already finished.
    this.#engine = new Engine({
      startLists: () => this.#startLists,
      getConfig, names: this.#names, store: this.#store, log: (l) => this.#moduleLine(l), autoStart: false,
      deliver: (outputId, packet, ack) => this.#outputs.deliver(outputId, packet, ack),
      finishers: (raceId) => (typeof this.#lif?.lynxFinishers === 'function' ? this.#lif.lynxFinishers(raceId) : null),
      // a made-up split of a runner who finished goes out with the FinishLynx place, so TrackScore keeps it (9.17 P4)
      finishPlaces: (raceId) => (typeof this.#lif?.lynxPlaces === 'function' ? this.#lif.lynxPlaces(raceId) : null),
    });
    this.#engine.on('feed', (e) => this.#onFeed(e));
    this.#engine.on('race', (id) => {
      this.#lif?.markDirty(id);
      this.#panel.notify();
    });
    this.#engine.on('config-patch', ({ raceId, patch }) => this.#onConfigPatch(raceId, patch));

    this.#lif = new LifSync({ getConfig, getRaceData: (id) => this.#engine.raceData(id), log: (l) => this.#log.write(l) });
    this.#lif.on('status', (st) => this.#onLif(st));
    this.#lif.on('finishers', () => this.#engine.converge());
    const lifRead = this.config.lif?.inputDir
      ? new Promise((resolve) => {
        this.#lif.once('status', resolve);
        this.#lif.once('finishers', resolve);
      })
      : null;
    this.#lif.start();

    // Names may sit on a slow share; reads use RR12's names until the file is in. FinishLynx's folder may be slow too.
    await Promise.all([withTimeout(this.#names.start(), 3000), lifRead && withTimeout(lifRead, 3000)]);
    // the outputs' state as it is now (their first 'status' events came before the engine): a split no output can take
    // says why on the feed from the start (DESIGN 9.16 F3)
    this.#engine.converge(this.#outputs.status());
    this.#engine.start();

    // 9.28: the update check. Nothing of it can stop Split Relay from starting.
    const u = this.#updateOpts;
    this.#updater = new Updater({ appDir: u.appDir ?? APP_DIR, dataDir: this.#dataDir, version: VERSION, apiBase: u.apiBase ?? GITHUB_API,
      ...(u.fetchImpl ? { fetchImpl: u.fetchImpl } : {}), restartsItself: u.restartsItself === true, log: (l) => this.#line(l), onChange: () => this.#panel?.notify() });

    // The inputs open last, so RR12's queued reads find everything wired.
    this.#ready = true;
    await this.#syncInputs(inputPorts(this.config));
    this.#line(`---- running: panel ${this.panelUrl}, RR12 input port${this.#inputs.size === 1 ? '' : 's'} ` +
      `${[...this.#inputs.keys()].map((p) => this.inputPortOf(p) ?? p).join(', ')}`);
    // 9.28: Split Relay is up: an update put in place before this start is in for good (the launcher no longer takes
    // it back), and GitHub is asked once, in the background, whether there is a newer version
    try {
      this.#updater.confirmStarted();
      if (u.check === true) this.#updater.check().catch(() => {});
    } catch (err) {
      this.#line(`[update] ${err?.message ?? err}`);
    }
    return this;
  }

  /**
   * One listener per RR12 input port (9.15 L2): ports no longer in the settings stop, new ones start, the others keep
   * their connections. Never rejects: a busy port shows as that input's error, and is retried.
   * @param {number[]} ports
   */
  async #syncInputs(ports) {
    const wanted = new Set(ports);
    const stops = [];
    for (const [port, inp] of this.#inputs) {
      if (wanted.has(port)) continue;
      this.#inputs.delete(port);
      this.#say(`[in] no longer listening for RR12 on port ${port}`);
      stops.push(inp.server.stop());
    }
    await Promise.all(stops);
    const starts = [];
    const order = new Map();
    ports.forEach((port, i) => {
      if (!this.#inputs.has(port)) {
        // a test's override: the first port on the port asked for, the others on any free port
        const listen = this.#inputOverride === null ? port : i === 0 ? this.#inputOverride : 0;
        const server = new InputServer({ port: listen, format: this.config.input, connIds: () => ++this.#connSeq });
        const inp = { server, format: null, sig: '' };
        server.on('line', (text, meta) => this.#onLine(text, meta, port));
        server.on('status', (st) => this.#onInput(st, port));
        server.on('dropped', (d) => this.#say(`[in #${d.connId} ${d.remote} port ${port}] ${d.message ?? `a line of ${d.length} characters was too long and was dropped. Check the RR12 Export Data expression.`}`));
        server.on('error', (err) => this.#say(`[in] ${err?.stack ?? err}`));
        this.#inputs.set(port, inp);
        starts.push(server.start());
      }
      order.set(port, this.#inputs.get(port));
    });
    // the settings' order: State.inputs lists them as the Settings tab does
    this.#inputs = order;
    await Promise.all(starts);
  }

  /** Stop everything, save what is unsaved, close every socket. Safe to call twice. */
  stop() {
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      this.#line('---- Split Relay stopping');
      this.#ready = false;
      const step = async (what, fn) => {
        try {
          await fn();
          return true;
        } catch (err) {
          this.#line(`[main] stopping ${what} failed: ${err?.stack ?? err}`);
          return false;
        }
      };
      await step('the RR12 input', () => Promise.all([...this.#inputs.values()].map((i) => i.server.stop())));
      await step('the engine', () => this.#engine?.stop());
      // Said in the window, not only the log: an operator who sees "stopped" must know these were not delivered.
      for (const o of this.#outputs?.undelivered() ?? []) {
        this.#say(`[out ${o.name}] ${o.behind === 1 ? '1 split was' : `${o.behind} splits were`} not delivered yet. ` +
          'They are sent when Split Relay starts again and the output is reachable.');
      }
      const outputsClosed = await step('the outputs', () => this.#outputs?.stop());
      // The outputs acknowledged what they wrote while closing: save that too, so a restart does not send it again.
      await step('the race files', async () => {
        this.#engine?.flush();
        // Closed connections still deliver what this PC's network stack held. Only after a stop like this does the
        // next start trust the outputs' acknowledgements; after a kill or a crash it sends their last minute again.
        if (outputsClosed) this.#engine?.markCleanStop();
        await this.#store?.flush();
        this.#store?.closeJournal();
      });
      await step('the settings file', () => this.#cfg?.flush());
      await step('the .lif files', () => this.#lif?.stop());
      await step('the names file', () => this.#names?.stop());
      await step('the control panel', () => this.#panel?.close());
      this.#line('---- Split Relay stopped');
      await this.#log?.close();
    })();
    return this.#stopping;
  }

  // ---- State (DESIGN.md section 6) ----------------------------------------------------------------------------

  /** Everything the panel paints. */
  state() {
    if (!this.#ready && !this.#stopping) throw new HttpError(503, 'Split Relay is still starting. Try again in a moment.');
    const cfg = this.config;
    const port = this.#panel.port;
    // The panel shows the port it is really on (it differs from the saved one with --port). input.port: the first RR12
    // input port, read-only, for a panel from before revision 7 (input.ports is the setting, 9.15 L2).
    const config = { ...cfg, input: { ...cfg.input, port: inputPorts(cfg)[0] ?? null },
      ...(port && port !== cfg.panel.port ? { panel: { ...cfg.panel, port } } : {}) };
    const lif = this.#lif.status();
    const races = [];
    for (const r of cfg.races) {
      const view = this.#engine.raceView(r.id);
      if (!view) continue;
      view.lynxStart = this.#lif.lynxStart(r.id);
      view.lynxName = this.#lynxName(r.id, lif);
      // revision 10: Play reads the FinishLynx folder before what the split held goes out ("Playing…")
      for (const s of view.splits) s.playing = this.#playing.has(`${r.id}|${s.id}`);
      races.push(view);
    }
    const inputs = this.inputsStatus();
    const deletedBack = this.#engine.deletedBack();
    return {
      version: cfg.version,
      // 9.28: this copy's version, and the update check: what GitHub has, whether Install is possible now
      app: { version: VERSION },
      update: { ...this.#updater.status(), blocked: this.#updateBlocked() },
      now: Date.now(),
      config,
      // the data folder this copy of Split Relay uses (9.22 M10): a second copy started by mistake has another one
      dataDir: this.#dataDir,
      addresses: this.#ipv4(),
      // every RR12 input port together (the pill); clockLagSec: how far RR12's times are behind this PC's clock ("Set
      // to now" uses this PC's clock)
      input: { ...this.#aggregateInput(inputs), clockLagSec: this.#engine.clockLagSec() },
      // one per RR12 input port, in the settings' order, with the format its lines have (9.15 L2)
      inputs,
      // the Export Data expressions for RR12: the FinishLynx LapTime line (the normal one) and SR|... (advanced)
      expressions: { laptime: LAPTIME_EXPRESSION, sr: buildExpression(cfg.input) },
      outputs: this.#outputs.status(),
      names: this.#names.status(),
      lif,
      races,
      seen: this.#engine.seen(),
      // contests whose reads are not used: their race was deleted or stopped listing them (DESIGN 9.2)
      setAside: this.#engine.setAside(),
      // races with reads that are not in the settings and were not deleted: config.json was restored or edited (R6)
      // `file`: where its settings and deliveries are kept, for the panel's "put it back" instruction
      missingRaces: this.#engine.missingRaces().map((m) => ({ ...m, file: `races\\${raceFileName(m.raceId)}` })),
      // the reads in no race now, per contest and why: what the panel counts, not what was ever read
      noRace: this.#engine.noRace(),
      // 9.15 V2: where the settings came from at start, for the missing-race instructions (config.broken-*.json)
      configRecovery: this.#configRecovery(),
      // 9.15 V1: races switched off at start because an Active race before them wants the same reads
      startConflicts: this.#liveConflicts(),
      // 9.15 V5: races deleted earlier that are back in the settings (config.json put back from its backup)
      deletedBack: deletedBack.map((d) => ({ ...d,
        text: `'${d.raceName}' was deleted${d.deletedAt ? ` at ${formatTod(localTod(d.deletedAt), 0)}` : ''}, but it is back in ` +
          'the settings (config.json was put back from its backup, or edited). The reads it had when it was deleted stay ' +
          'out of use; new reads count in it. Delete it again if it should be gone, or save it on the Races tab to keep it.' })),
      // 9.25: the start lists loaded (per event: how many entered, from which file, its races) and the races without
      // one; only when any is loaded
      ...(Object.keys(this.#startLists.events).length ? { startLists: startListsView(this.#startLists, cfg.races) } : {}),
      // 9.27: the pairs of swapped bibs (who has whose reads, per race), oldest first; only when there is one
      ...((swaps) => (swaps.length ? { swaps } : {}))(this.#engine.swaps()),
      // 9.15 L8: LapTime lines carry bibs only; without FinishLynx's people file the boards show no names
      namesNeeded: !String(cfg.names?.pplPath ?? '').trim() && (inputs.some((i) => i.format === 'laptime') || this.#engine.passesSeen()),
      feed: this.#engine.feed(200),
    };
  }

  /**
   * 9.15 V2: how the settings were found at start, and the damaged copies kept next to them, so a missing race's
   * warning can point at them ("config.broken-....json").
   * @returns {{ source: 'file'|'backup'|'new'|'empty', fellBack: boolean, brokenFile: string|null, brokenFiles: string[] }}
   */
  #configRecovery() {
    const { source, brokenFile, brokenFiles } = this.#configLoad;
    return { source, fellBack: source === 'backup', brokenFile, brokenFiles: [...brokenFiles] };
  }

  /** The start's unticked races (V1) that are still not Active, with the warning in words. */
  #liveConflicts() {
    const races = new Map(this.config.races.map((r) => [r.id, r]));
    return this.#startConflicts.filter((u) => races.has(u.raceId) && !races.get(u.raceId).active).map((u) => ({
      ...u,
      text: `'${u.raceName}' was switched off when Split Relay started: it and '${u.keptName}' ${u.why}, and only one ` +
        `Active race can take those reads. Its reads are kept. If '${u.raceName}' is the race that is running, switch to it ` +
        '(Races tab).',
    }));
  }

  /** The operator has acted on one of the start's conflicts (saved, switched or deleted a race in it): it is done. */
  #doneConflict(...ids) {
    this.#startConflicts = this.#startConflicts.filter((u) => !ids.includes(u.raceId) && !ids.includes(u.keptId));
  }

  /** The event name in the race's FinishLynx .lif header, so the panel can warn when the race is called otherwise. */
  #lynxName(raceId, lifStatus) {
    try {
      if (typeof this.#lif.lynxName === 'function') return this.#lif.lynxName(raceId) ?? null;
      const f = (lifStatus?.files ?? []).find((x) => x?.raceId === raceId && !x.synthesized && typeof x.lynxName === 'string');
      return f ? f.lynxName : null;
    } catch {
      return null;
    }
  }

  allowLan() {
    return !!this.config?.panel?.allowLan;
  }

  expression() {
    return buildExpression(this.config.input);
  }

  // ---- changes from the panel ----------------------------------------------------------------------------------

  /** @param {any} patch */
  checkSettings(patch) {
    this.#settingsFor(patch);
  }

  /** @param {any} patch */
  async updateSettings(patch) {
    const next = this.#settingsFor(patch);
    this.#line(`[config] settings changed: ${Object.keys(patch).join(', ')}`);
    await this.#apply(next);
  }

  /**
   * The config validates the saved ports; the ports really in use can differ (--port, a test's port 0), and a new
   * port must not land on the other listener's live one.
   */
  #settingsFor(patch) {
    const next = updateSettings(this.config, patch);
    const panelPort = this.#panel.port;
    const clash = (n) => new ConfigError(`The RR12 input port and the control panel port are both ${n}. Use two different ports.`);
    const before = inputPorts(this.config);
    for (const p of inputPorts(next)) if (!before.includes(p) && p === panelPort) throw clash(panelPort);
    // the ports the inputs really listen on (they differ from the saved ones only in tests)
    const listening = [...this.#inputs.keys()].map((p) => this.inputPortOf(p)).filter((p) => p !== null);
    if (next.panel.port !== panelPort && listening.includes(next.panel.port)) throw clash(next.panel.port);
    return next;
  }

  async addRace(body) {
    const { config, race } = addRace(this.config, body);
    this.#line(`[config] race added: ${race.name} (${race.id}), ${race.splits.length} splits`);
    await this.#apply(config);
  }

  async updateRace(id, body) {
    const { config, race } = updateRace(this.config, id, body);
    this.#line(`[config] race changed: ${race.name} (${race.id}): ${JSON.stringify(race)}`);
    this.#doneConflict(id);
    await this.#apply(config);
    // a race deleted earlier that came back with an older config.json: saving it is keeping it (9.15 V5)
    this.#engine.keepRace(id);
  }

  /**
   * POST /api/races/:id/activate (9.15 L3): tick Active on the race and untick the Active races that want the same
   * reads (same port, a shared contest, both taking every contest, the same event). They keep their reads (9.2 R1).
   * @param {string} id
   * @returns {Promise<{ raceId: string, raceName: string, why: string }[]>} the races unticked
   */
  async activateRace(id) {
    this.#race(id);
    const { config, race, unticked } = activateRace(this.config, id);
    this.#line(`[config] race made Active: ${race.name} (${race.id})` +
      (unticked.length ? `; switched off: ${unticked.map((u) => `${u.raceName} (${u.why})`).join(', ')}` : ''));
    this.#doneConflict(id, ...unticked.map((u) => u.raceId));
    await this.#apply(config);
    this.#engine.keepRace(id);
    return unticked;
  }

  /**
   * POST /api/races/:id/restore (9.15 V2, "Put it back"): a missing race comes back with the settings its race file
   * keeps (data\races\<id>.json), checked as a start checks them (V1): it comes back not Active when it would want the
   * reads of an Active race. Its reads are in it again at once.
   * @param {string} id
   * @returns {Promise<{ raceId: string, raceName: string, active: boolean, renamedFrom: string|null, why: string|null }>}
   */
  async restoreRace(id) {
    if (this.config.races.some((r) => r.id === id)) throw new HttpError(409, 'That race is in the settings already. Reload the page.');
    const missing = this.#engine.missingRaces().find((m) => m.raceId === id);
    let saved = null;
    try {
      saved = this.#store.load(id)?.race ?? null;
    } catch {
      // said below
    }
    if (!missing && !saved) throw notFound('race', id);
    const { config, race, renamedFrom, why } = restoreRace(this.config, saved, id);
    this.#line(`[config] race put back from races\\${raceFileName(id)}: ${race.name} (${id})${why ? `, not Active: ${why}` : ''}`);
    await this.#apply(config);
    return { raceId: race.id, raceName: race.name, active: race.active, renamedFrom, why };
  }

  /**
   * DELETE /api/races/:id: the only thing that takes a race's reads out of use (DESIGN 9.2 R2). A race that is missing
   * (it has reads but is not in the settings, R6) can be deleted too: that is how the operator lets its reads go.
   * @param {string} id
   */
  async deleteRace(id) {
    const race = this.config.races.find((r) => r.id === id);
    if (!race) {
      const missing = this.#engine.missingRaces().find((m) => m.raceId === id);
      if (!missing) throw notFound('race', id);
      this.#line(`[config] missing race deleted: ${missing.raceName || '(no name)'} (${id}); its reads are no longer used, its race file was moved to races\\deleted`);
      try {
        this.#engine.configChanged({ deleted: [id] });
      } finally {
        this.#panel.notify();
      }
      return;
    }
    const next = deleteRace(this.config, id);
    this.#line(`[config] race deleted: ${race.name} (${id}); its reads are no longer used, its race file was moved to races\\deleted`);
    this.#doneConflict(id);
    await this.#apply(next, { deleted: [id] });
  }

  /**
   * What saving a race (new or changed) or deleting one would do to the reads received so far (DESIGN 9.2), without
   * changing anything: the panel's dialogs say it before the operator confirms. The settings are checked exactly as
   * the save would check them, so a plan is only ever made for a change that can be saved.
   * @param {any} body { id?: string, race?: Partial<Race>, delete?: true }: no id = a new race
   * @returns {import('./engine.js').RoutePlan & { raceId: string }} raceId = the race the plan is about ("this race")
   */
  planRace(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    if (!b) throw new HttpError(400, 'Send { "id": "...", "race": { ... } }, { "race": { ... } } for a new race, or { "id": "...", "delete": true }.');
    const id = typeof b.id === 'string' ? b.id : '';
    let next;
    let raceId = id;
    let deleted = [];
    let unticked;
    if (b.activate === true) {
      // what "Switch to <race>" would do (POST /api/races/:id/activate): this race Active, the clashing ones not
      this.#race(id);
      const a = activateRace(this.config, id);
      next = a.config;
      unticked = a.unticked;
    } else if (b.delete === true) {
      deleted = [id];
      // a missing race (R6) is not in the settings: deleting it changes nothing there
      if (this.config.races.some((r) => r.id === id)) next = deleteRace(this.config, id);
      else if (this.#engine.missingRaces().some((m) => m.raceId === id)) next = this.config;
      else throw notFound('race', id);
    } else if (id) {
      this.#race(id);
      next = updateRace(this.config, id, b.race ?? {}).config;
    } else {
      const added = addRace(this.config, b.race ?? {});
      next = added.config;
      raceId = added.race.id;
    }
    const plan = { raceId, ...this.#engine.planChange(next, { deleted }) };
    return unticked ? { ...plan, unticked } : plan;
  }

  /**
   * The gun is exactly the time the operator typed: never this PC's clock or a file's time (race day 2026-10-21,
   * "Set to now" put the PC's clock in over a typed gun, so { now } and { fromLynx } are gone).
   * @param {string} id
   * @param {any} body { gun: '10:00:00.000' } (null or '' clears it)
   */
  async setGun(id, body) {
    this.#race(id);
    const b = body && typeof body === 'object' ? body : {};
    if (!('gun' in b) || !(typeof b.gun === 'string' || b.gun === null)) {
      throw new HttpError(400, 'Type the gun time: send { "gun": "10:00:00.000" }.');
    }
    const gunText = b.gun ?? '';
    try {
      this.#engine.setGun(id, gunText);
    } catch (err) {
      throw new HttpError(400, err?.message ?? String(err));
    }
    await this.#cfg.flush();
    if (this.#cfg.lastError) throw new HttpError(500, this.#cfg.lastError);
  }

  /**
   * @param {string} id
   * @param {any} [body] { includeFinished?: boolean, force?: boolean }
   * @returns {{ sent: number, skippedFinished: number, outputs: number }}
   */
  resendRace(id, body) {
    const race = this.#race(id);
    const b = body && typeof body === 'object' ? body : {};
    let r;
    try {
      r = this.#engine.resendRace(id, { includeFinished: b.includeFinished === true, force: b.force === true });
    } catch (err) {
      // A race TrackScore is not showing would make it switch to that event and wipe the race it is showing.
      if (err?.code === 'RACE_INACTIVE') throw new HttpError(409, err.message);
      throw err;
    }
    this.#line(`[main] resend of ${race.name}: ${r.sent} splits sent again to ${r.outputs} output${r.outputs === 1 ? '' : 's'}` +
      `${r.skippedFinished ? `, ${r.skippedFinished} of finished runners skipped` : ''}${b.force === true ? ' (race not active, sent anyway)' : ''}`);
    return r;
  }

  async clearRace(id) {
    const race = this.#race(id);
    this.#engine.clearRace(id);
    this.#lif.markDirty(id);
    this.#line(`[main] ${race.name}: race data cleared; the reads it held are no longer used, new reads count as usual`);
  }

  crossings(id) {
    this.#race(id);
    return this.#engine.crossings(id);
  }

  // ---- Review (DESIGN 9.17) ------------------------------------------------------------------------------------

  /**
   * POST /api/races/:id/splits/:splitId/sending { on } (9.17 P1): pause a split (kept and shown, not sent to any
   * output nor the merged .lif) or play it again (what it held goes out).
   * @param {string} id
   * @param {string} splitId
   * @param {any} body { on: boolean }
   */
  async setSplitSending(id, splitId, body) {
    const b = body && typeof body === 'object' ? body : {};
    // Revision 11: a Pause that arrives while a Play is still reading FinishLynx's folder cancels that Play. The split is
    // still paused in the settings then, so the Pause by itself would change nothing and the Play would go ahead.
    const playKey = `${String(id ?? '').trim()}|${String(splitId ?? '').trim()}`;
    if (b.on === false) this.#playGen.set(playKey, (this.#playGen.get(playKey) ?? 0) + 1);
    const gen = this.#playGen.get(playKey) ?? 0;
    let { config, race, split, changed } = setSplitSending(this.config, id, splitId, b.on);
    if (!changed) return;
    if (b.on === true) {
      // Revision 10: FinishLynx may have finished some of the held runners seconds ago, and the relay reads its folder
      // once a second. A held split sent to them now would carry the split place and replace their finish place in
      // TrackScore, so the folder is read first (at most 3 s; the panel says "Playing…" meanwhile). Held splits of
      // runners who have finished then wait in Review (Send with finish place) as always.
      const key = `${race.id}|${split.id}`;
      this.#playing.add(key);
      this.#panel?.notify();
      try {
        await this.#freshFinishers(`play ${race.name} ${split.name}`);
      } finally {
        this.#playing.delete(key);
      }
      if ((this.#playGen.get(playKey) ?? 0) !== gen) {
        this.#line(`[config] ${race.name} ${split.name}: Play cancelled, it was paused again while FinishLynx's folder was read`);
        this.#panel?.notify();
        return;
      }
      // the settings as they are now (they may have changed while the folder was read)
      ({ config, race, split, changed } = setSplitSending(this.config, id, splitId, b.on));
      if (!changed) {
        this.#panel?.notify();
        return;
      }
    }
    this.#line(`[config] ${race.name} ${split.name}: ${b.on ? 'played: what it held is sent now' : 'paused: its splits are kept, not sent'}`);
    await this.#apply(config);
  }

  /**
   * Revision 10: read FinishLynx's folder now, before something goes out that depends on who has finished and with
   * which place (Play, the Review's sends). The engine takes the new finishers on LifSync's 'finishers' event, during
   * the read. At most FRESH_SCAN_MS: a file FinishLynx is still writing, or a slow share, does not hold things up longer.
   * @param {string} what for the log
   */
  async #freshFinishers(what) {
    if (typeof this.#lif?.freshScan !== 'function') return null;
    // the panel's "Send all with finish place" sends one request per split: one read of the folder serves a second
    if (this.#freshAt && Date.now() - this.#freshAt < FRESH_REUSE_MS) return null;
    let r = null;
    try {
      r = await this.#lif.freshScan({ timeoutMs: FRESH_SCAN_MS });
    } catch (err) {
      this.#line(`[lif] ${what}: reading the FinishLynx folder first failed: ${err?.message ?? err}`);
      return null;
    }
    if (r.scanned && !r.settled) {
      this.#line(`[lif] ${what}: FinishLynx was still writing its file after ${r.ms} ms; went ahead with the finishes read so far`);
    }
    this.#freshAt = r.settled ? Date.now() : 0;
    return r;
  }

  /** GET /api/races/:id/review (9.17): missing splits with estimates, column checks, finished-not-sent, made-up times. */
  review(id) {
    this.#race(id);
    return this.#engine.review(id);
  }

  /** GET /api/races/:id/runners/:bib (9.17): one runner's columns, passes and estimates ("Find runner"). */
  runner(id, bib) {
    this.#race(id);
    return this.#engine.runner(id, bib);
  }

  /** POST /api/races/:id/assign (9.17 P2): Move a pass to a split, or Keep it where counting put it. */
  assign(id, body) {
    this.#race(id);
    return this.#reviewCall(() => this.#engine.assign(id, body));
  }

  /**
   * POST /api/races/:id/manual (9.17 P3): send a made-up (or typed) time for a missing split, or { all: true }.
   * FinishLynx's folder is read first (revision 10): a made-up split of a runner who has just finished must go with
   * the finish place, not the split place.
   */
  async addManual(id, body) {
    this.#race(id);
    await this.#freshFinishers('Review: made-up times');
    return this.#reviewCall(() => this.#engine.addManual(id, body));
  }

  /** DELETE /api/races/:id/manual { bib, splitId } (9.17 P3): take a made-up time back. */
  removeManual(id, body) {
    this.#race(id);
    return this.#reviewCall(() => this.#engine.removeManual(id, body));
  }

  /**
   * POST /api/races/:id/send-finished (9.17 P4): real splits of finishers, sent with the FinishLynx finish place (read
   * from FinishLynx's folder first, revision 10, so a place FinishLynx changed a moment ago is the one sent).
   */
  async sendFinished(id, body) {
    this.#race(id);
    await this.#freshFinishers('Review: send with finish place');
    return this.#reviewCall(() => this.#engine.sendFinished(id, body));
  }

  /**
   * POST /api/races/:id/runners/:bib/move (9.23 F2): Move a pass (with the later ones, or only it), Not a split, This
   * is the finish, Let Split Relay count it, It's right. FinishLynx's folder is read first: a runner who has just
   * finished is never sent a split place.
   */
  async movePass(id, bib, body) {
    this.#race(id);
    await this.#freshFinishers('Review: change a pass');
    return this.#reviewCall(() => this.#engine.movePass(id, bib, body));
  }

  /**
   * POST /api/races/:id/runners/:bib/missed (9.23 F13): "Missed 2400m: add it", the pass in that split and the later
   * ones one column on and the missed split filled, as one change. FinishLynx's folder is read first: a runner who has
   * just finished gets the finish place.
   */
  async addMissed(id, bib, body) {
    this.#race(id);
    await this.#freshFinishers('Review: add a missed split');
    return this.#reviewCall(() => this.#engine.addMissed(id, bib, body));
  }

  /** POST /api/races/:id/undo { fix, confirm? } (9.23 F3): undo (or redo) one change. */
  async undo(id, body) {
    this.#race(id);
    await this.#freshFinishers('Review: undo');
    return this.#reviewCall(() => this.#engine.undo(id, body));
  }

  /** POST /api/races/:id/runners/:bib/send (9.23 F4): "Send bib 586 again". */
  async sendRunner(id, bib) {
    this.#race(id);
    await this.#freshFinishers('Review: send a runner again');
    return this.#reviewCall(() => this.#engine.sendRunner(id, bib));
  }

  /** POST /api/races/:id/runners/:bib/stop (9.24): "Stop sending this runner", from its first pass in question or after its last. */
  async stopRunner(id, bib, body) {
    this.#race(id);
    await this.#freshFinishers('Review: stop sending a runner');
    return this.#reviewCall(() => this.#engine.stopRunner(id, bib, body));
  }

  /** POST /api/races/:id/runners/:bib/resume (9.24): "Send this runner again". */
  async resumeRunner(id, bib) {
    this.#race(id);
    await this.#freshFinishers('Review: send a runner again');
    return this.#reviewCall(() => this.#engine.resumeRunner(id, bib));
  }

  /**
   * POST /api/races/:id/runners/:bib/place (9.25): "Not in this race" ({ say: 'away' }), "Count them here" or "It's
   * right" ({ say: 'here' }).
   */
  async placeRunner(id, bib, body) {
    this.#race(id);
    await this.#freshFinishers('Review: where a runner runs');
    return this.#reviewCall(() => this.#engine.placeRunner(id, bib, body));
  }

  // ---- swapped bibs (DESIGN 9.27) -----------------------------------------------------------------------------

  /** GET /api/swaps (9.27): the pairs of swapped bibs, oldest first. */
  swaps() {
    return { swaps: this.#engine.swaps() };
  }

  /**
   * POST /api/swaps/preview (9.27): what entering the swap of two bibs ({ bib, other }), or removing the one a bib is
   * in ({ bib, remove: true }), would do, in words. Changes nothing. FinishLynx's folder is read first, so the preview
   * says of a runner who has just finished that its splits wait for Send with finish place.
   */
  async swapPreview(body) {
    await this.#freshFinishers('Swapped bibs: preview');
    return this.#reviewCall(() => this.#engine.swapPreview(isObj(body) ? body : {}));
  }

  /**
   * POST /api/swaps (9.27): bib `bib` ran with the chip of bib `other`, for the whole meet. FinishLynx's folder is read
   * first: a runner who has just finished is never sent a split place.
   */
  async addSwap(body) {
    await this.#freshFinishers('Swapped bibs');
    const r = this.#reviewCall(() => this.#engine.addSwap(isObj(body) ? body : {}));
    this.#say(`[swap] ${r.text} ${r.races.map((x) => `${x.raceName}: ${x.lines.join(' ')}`).join(' ')}`.trim());
    return r;
  }

  /** DELETE /api/swaps/:bib (9.27): remove the swap this bib is in (either bib of the pair). */
  async removeSwap(bib) {
    await this.#freshFinishers('Swapped bibs: remove');
    const r = this.#reviewCall(() => this.#engine.removeSwap({ bib }));
    this.#say(`[swap] ${r.text} ${r.races.map((x) => `${x.raceName}: ${x.lines.join(' ')}`).join(' ')}`.trim());
    return r;
  }

  // ---- updates from GitHub (DESIGN 9.28) ----------------------------------------------------------------------

  /** Why an update can't be installed this minute, in words, or null: a race is running (the rule of Start a new meet). */
  #updateBlocked() {
    const now = Date.now();
    for (const r of this.config.races) {
      if (raceRunning(r, this.#engine.raceView(r.id)?.lastReadAt ?? null, now)) {
        return `${r.name} is running. Installing restarts Split Relay, so it waits until the race is over (20 minutes after its last read), or until its Active is turned off.`;
      }
    }
    return null;
  }

  /** POST /api/update/check: ask GitHub now. Never fails: what went wrong is in the state's update.error. */
  async checkUpdate() {
    await this.#updater.check();
    return this.state();
  }

  /**
   * POST /api/update/install: download the newest release, check it and put it in place. Refused while a race is
   * running. Afterwards Split Relay stops and its launcher starts the new version ('restart' is emitted for main());
   * started without the launcher, it says to close and start it again.
   */
  async installUpdate() {
    const blocked = this.#updateBlocked();
    if (blocked) throw new HttpError(409, blocked);
    let done;
    try {
      done = await this.#updater.install();
    } catch (err) {
      throw Number.isInteger(err?.status) ? new HttpError(err.status, err.message) : err;
    }
    const restarts = this.#updater.status().restartsItself;
    this.#say(`[update] Split Relay ${done.to} is installed (this was ${done.from}). ${restarts ? 'Starting it…' : 'Close this window and start Split Relay again to use it.'}`);
    // after the answer has gone out to the panel
    if (restarts) setTimeout(() => this.emit('restart', done), 400);
    return { ...this.state(), updateDone: { ...done, restarts } };
  }

  /** POST /api/update/dismiss: hide the note that an update was taken back. */
  dismissUpdateNote() {
    this.#updater.dismissRolledBack();
    return this.state();
  }

  // ---- start lists (DESIGN 9.25) ------------------------------------------------------------------------------

  get #startListsFile() {
    return path.join(this.#dataDir, 'startlists.json');
  }

  /** The start lists kept in the data folder; none when there is no file, or it can't be read (said in the window). */
  #readStartLists() {
    const file = this.#startListsFile;
    try {
      if (!fs.existsSync(file)) return noStartLists();
      return normalizeStartLists(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    } catch (err) {
      this.#say(`[startlist] startlists.json can't be read (${err?.code ?? err?.message ?? err}): no start list is in use. Load the entry files again (Races tab).`);
      return noStartLists();
    }
  }

  /** Written before the lists are used: a restart has what the operator was told. No lists: no file. */
  async #saveStartLists(lists) {
    try {
      if (Object.keys(lists.events).length) await writeFileAtomic(this.#startListsFile, `${JSON.stringify(lists)}\n`);
      else await fsp.rm(this.#startListsFile, { force: true });
    } catch (err) {
      throw new HttpError(500, `Split Relay could not save the start lists in its data folder (${err?.code ?? err?.message ?? err}). Nothing was changed.`);
    }
  }

  /**
   * POST /api/startlists (9.25): the entry files the operator dropped on the Races tab, { files: [{ name, text }] }
   * (src/entries.js reads them: one file per event, named by its event number). Each event a file holds replaces that
   * event's list. Only the bibs are kept, in the data folder (startlists.json), so a restart has them; "Start a new
   * meet" puts them away with the old meet.
   * @returns {{ results: { file: string, ok: boolean, events: string[], entered: number, text: string }[], notes: string[],
   *   resent: number, held: any[] }} results: one sentence per file; resent, held: what it did to the boards (engine
   *   startListsChanged)
   */
  async loadStartLists(body) {
    // (a meet has a file per event: 200 a request is far more than any; the panel sends them in requests of 600 KB)
    const files = isObj(body) && Array.isArray(body.files) ? body.files.filter(isObj).slice(0, 200) : [];
    if (!files.length) throw new HttpError(400, 'Send { "files": [{ "name": "1.txt", "text": "<the text of the file>" }] }: the entry files to load.');
    const { lists, results, notes } = loadEntryFiles(this.#startLists,
      files.map((f) => ({ name: String(f.name ?? ''), text: typeof f.text === 'string' ? f.text : '' })), { races: this.config.races, now: Date.now() });
    let boards = { resent: 0, held: [] };
    if (results.some((r) => r.ok)) {
      await this.#saveStartLists(lists);
      this.#startLists = lists;
      boards = this.#engine.startListsChanged();
    }
    for (const line of [...results.map((r) => r.text), ...notes]) this.#say(`[startlist] ${line}`);
    this.#panel.notify();
    return { results, notes, ...boards };
  }

  /** DELETE /api/startlists/:event (9.25): remove one event's start list, or every list ('all'). */
  async removeStartList(event) {
    const all = String(event) === 'all';
    const had = Object.keys(this.#startLists.events).length;
    const { lists, removed } = all ? { lists: noStartLists(), removed: had ? { file: '', bibs: [] } : null } : removeStartList(this.#startLists, event);
    if (!removed) throw new HttpError(404, all ? 'There is no start list to remove.' : `There is no start list for event ${event}. It may have been removed already: reload the page.`);
    await this.#saveStartLists(lists);
    this.#startLists = lists;
    const boards = this.#engine.startListsChanged();
    const text = all ? `${had === 1 ? 'The start list was' : `All ${had} start lists were`} removed.`
      : `The start list of event ${event} (${removed.bibs.length.toLocaleString('en-US')} athletes, from ${removed.file}) was removed.`;
    this.#say(`[startlist] ${text}`);
    this.#panel.notify();
    return { text, ...boards };
  }

  /** GET /api/races/:id/grid[?since=rev] (9.23 F8): the race as a grid of runners by splits. */
  grid(id, since = null) {
    this.#race(id);
    return this.#engine.grid(id, { since });
  }

  /** GET /api/find?q= (9.23 F1): runners of every race by bib, name or team. */
  find(q) {
    return this.#engine.find(q);
  }

  /** A Review action: the engine's plain-English refusals keep their status (404, 409, 400); the panel shows them. */
  #reviewCall(fn) {
    try {
      return fn();
    } catch (err) {
      if (Number.isInteger(err?.status)) {
        // 9.23 F3: an Undo that would empty a cell a scoreboard keeps says which (the panel asks first)
        const extra = err.code === 'UNDO_LEAVES' ? { body: { code: err.code, leaves: err.leaves } } : {};
        throw Object.assign(new HttpError(err.status, err.message), extra);
      }
      throw err;
    } finally {
      // the engine's 'race' event marks the race's merged .lif for rewriting; the panel shows the change at once
      this.#panel.notify();
    }
  }

  async addOutput(body) {
    const { config, output } = addOutput(this.config, body);
    this.#line(`[config] output added: ${output.name} (${output.id}): ${JSON.stringify(output)}`);
    await this.#apply(config);
  }

  async updateOutput(id, body) {
    const { config, output } = updateOutput(this.config, id, body);
    this.#line(`[config] output changed: ${output.name} (${output.id}): ${JSON.stringify(output)}`);
    await this.#apply(config);
  }

  async deleteOutput(id) {
    const out = this.#output(id);
    const next = deleteOutput(this.config, id);
    this.#line(`[config] output deleted: ${out.name} (${id})`);
    await this.#apply(next);
  }

  async previewOutput(id) {
    this.#output(id);
    try {
      await this.#outputs.checkScripts(id);
      return this.#outputs.preview(id, null);
    } catch (err) {
      if (err?.code === 'ENOOUTPUT') throw notFound('output', id);
      throw err;
    }
  }

  async reconnectOutput(id) {
    this.#output(id);
    try {
      this.#outputs.reconnect(id);
    } catch (err) {
      if (err?.code === 'ENOOUTPUT') throw notFound('output', id);
      throw err;
    }
  }

  // ---- meet setup (DESIGN 9.22) ------------------------------------------------------------------------------------

  /**
   * GET /api/meet/files: the meet files in data\meets (newest first), and on top the setup as it was before the last
   * load (data\meets\before-load, R14). A file is read again only when its size or time changed.
   * @returns {Promise<{ dir: string, files: any[] }>}
   */
  async meetFiles() {
    const dir = path.join(this.#dataDir, 'meets');
    const list = async (folder, only = null) => {
      let entries;
      try {
        entries = await fsp.readdir(folder, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        if (!e.isFile() || !/\.json$/i.test(e.name) || (only && !only.test(e.name))) continue;
        try {
          const st = await fsp.stat(path.join(folder, e.name));
          out.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* gone meanwhile */ }
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    };
    const summary = async (folder, f, prefix = '') => {
      const key = prefix + f.name;
      const c = this.#meetCache.get(key);
      if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) return c.entry;
      let entry = { fileName: key, mtimeMs: f.mtimeMs };
      try {
        if (f.size > MAX_MEET_BYTES) throw new Error('too big');
        const raw = JSON.parse((await fsp.readFile(path.join(folder, f.name), 'utf8')).replace(/^﻿/, ''));
        entry = { ...entry, ...meetSummary(parseMeet(raw).meet) };
      } catch {
        entry.error = 'not a meet file';
      }
      this.#meetCache.set(key, { size: f.size, mtimeMs: f.mtimeMs, entry });
      return entry;
    };
    const files = [];
    for (const f of (await list(dir)).slice(0, MAX_MEET_FILES)) files.push(await summary(dir, f));
    const at = (e) => Date.parse(e.savedAt ?? '') || e.mtimeMs;
    files.sort((a, b) => at(b) - at(a));
    const before = (await list(path.join(dir, 'before-load'), BEFORE_LOAD_FILE))[0];
    if (before) files.unshift({ ...(await summary(path.join(dir, 'before-load'), before, 'before-load/')), beforeLoad: true });
    return { dir, files };
  }

  /**
   * POST /api/meet/save: the whole meet setup to data\meets\<meet name>.json (no gun times, reads or Pause: 9.22 M1);
   * the panel downloads the text too. A meet saved again replaces its file; the one replaced is kept in data\meets\old.
   */
  async saveMeet() {
    await this.#cfg.flush();
    const now = new Date();
    const name = this.config.meet?.name || `Meet ${localDate(now)}`;
    const meet = buildMeet(this.config, { name, savedAt: now.toISOString(), savedBy: `Split Relay ${VERSION}`, savedOn: os.hostname() });
    const text = meetText(meet);
    const dir = path.join(this.#dataDir, 'meets');
    const fileName = meetFileName(name);
    const file = path.join(dir, fileName);
    let replaced = false;
    try {
      await fsp.mkdir(dir, { recursive: true });
      replaced = await fsp.stat(file).then((st) => st.isFile(), () => false);
      if (replaced) {
        // O8: the copy it replaces stays, in case it was another meet of the same name
        await fsp.mkdir(path.join(dir, 'old'), { recursive: true });
        await fsp.copyFile(file, path.join(dir, 'old', `${fileName.replace(/\.json$/i, '')} ${fileStamp()}.json`));
      }
      await writeFileAtomic(file, text);
    } catch (err) {
      throw new HttpError(500, `Split Relay could not save the meet file in ${dir} (${err?.code ?? err?.message ?? err}).`);
    }
    this.#line(`[meet] meet setup saved: ${file} (${meet.races.length} races, ${meet.outputs.length} outputs)${replaced ? ', it replaced the copy saved before' : ''}`);
    return { name, fileName, path: file, text, replaced };
  }

  /**
   * POST /api/meet/preview (9.22 M3): what loading a meet file, a saved meet or TrackScore's Race Setup would do.
   * Changes nothing, writes nothing, sends nothing.
   * @param {any} body { meet, fileName? } | { saved } | { trackscore: true }, and removeOthers?
   */
  async previewMeet(body) {
    const from = await this.#meetFrom(body);
    const removeOthers = body?.removeOthers === true;
    const paths = await this.#checkPaths(meetPaths(this.config, from.meet));
    // R17: what another copy of Split Relay on this PC would clash with (said only; the plan is the same without them)
    const busyPorts = await this.#busyPorts(from);
    const mergedRecent = await this.#mergedRecent(from);
    // from here on nothing waits: the plan and its base describe the same moment
    const ctx = this.#meetContext(from.mode);
    const undo = from.source.beforeLoad ? { at: Date.parse(from.meet.savedAt ?? '') || Date.now() } : null;
    const plan = planMeet(this.config, from.meet, { ...ctx, mode: from.mode, paths, removeOthers, notes: from.notes, busyPorts, mergedRecent,
      undo });
    const readsPlan = this.#engine.planChange(plan.next, { deleted: plan.deleted });
    const ts = from.source.kind === 'trackscore';
    return {
      mode: from.mode, meet: from.meet, base: this.#meetBase(ctx), removeOthers, undo: !!undo,
      title: ts ? `TrackScore: ${from.source.meetName || 'meet'}` : from.meet.name || from.source.fileName || 'Meet file',
      source: from.source,
      added: plan.added, changed: plan.changed, kept: plan.kept, attention: plan.attention, removable: plan.removable,
      removed: plan.removed, readsPlan, newMeet: this.#oldReads(), nothing: plan.nothing,
      // O33: the copy kept before a load: what the load added that stays (the panel never says "Nothing to change" then)
      ...(undo ? { leftover: plan.leftover } : {}),
    };
  }

  /**
   * POST /api/meet/apply (9.22 M3): the preview's meet, planned again from the setup as it is now and made live with
   * ONE settings change, or 409 when the setup changed since the preview. Sends nothing by itself. A file the browser
   * brought (keep: the file chooser or a drop) is kept in data\meets afterwards, so it is one click next time (O5).
   * @param {any} body { meet, mode, base, removeOthers?, undo?, keep?, fileName? }
   */
  async applyMeet(body) {
    const b = isObj(body) ? body : null;
    if (!b || b.meet === undefined || typeof b.base !== 'string') throw new HttpError(400, 'Send the meet and base from a preview.');
    const mode = b.mode ?? 'file';
    if (mode !== 'file' && mode !== 'trackscore') throw new HttpError(400, 'Send the mode the preview had: "file" or "trackscore".');
    let meet;
    try {
      meet = parseMeet(b.meet).meet;
    } catch (err) {
      throw meetHttpError(err);
    }
    // the preview's answers, reused (R13); awaited BEFORE the base is checked
    const paths = await this.#checkPaths(meetPaths(this.config, meet));
    if (this.#meetBusy) throw new HttpError(409, BUSY);
    // R1: from the base check until the change is live nothing waits, so a gun typed or a first read that arrives
    // meanwhile can never be planned around: it changes the base, and the operator sees the preview again
    const ctx = this.#meetContext(mode);
    if (this.#meetBase(ctx) !== b.base) throw new HttpError(409, STALE_PREVIEW);
    const undo = mode === 'file' && b.undo === true ? { at: Date.parse(meet.savedAt ?? '') || Date.now() } : null;
    const plan = planMeet(this.config, meet, { ...ctx, mode, paths, removeOthers: b.removeOthers === true, notes: [], undo });
    const name = mode === 'trackscore' ? meet.name || 'TrackScore' : meet.name || 'the meet file';
    // O33: the copy kept before a load puts the setup back: the toast says so, not "<meet name> loaded"
    const back = undo ? { undo: { at: undo.at } } : {};
    if (plan.nothing) return { applied: { nothing: true, name, mode, ...back } };
    const beforeLoad = this.#keepBeforeLoad();
    const at = new Date(undo?.at ?? 0);
    const source = mode === 'trackscore' ? 'TrackScore' : undo ? `the copy of the setup kept before the load at ${pad(at.getHours())}:${pad(at.getMinutes())}`
      : `the meet file "${meet.name || '(no name)'}"`;
    const count = (items, kind) => items.filter((i) => i.kind === kind).length;
    const races = (n) => `${n} race${n === 1 ? '' : 's'}`;
    const settings = plan.changed.filter((i) => i.kind === 'setting').map((i) => i.name);
    this.#line(`[meet] loaded from ${source}: ${races(count(plan.added, 'race'))} added, ${count(plan.changed, 'race')} changed, ` +
      `${plan.removed.length} removed; outputs: ${count(plan.added, 'output')} added, ${count(plan.changed, 'output')} changed; ` +
      `settings: ${settings.join(', ') || 'none'}; the setup before is in data\\meets\\${beforeLoad.fileName.replace('/', '\\')}`);
    for (const i of [...plan.added, ...plan.changed, ...plan.removed]) this.#line(`[meet]   ${i.text}`);
    for (const i of plan.attention) this.#line(`[meet]   ${i.tone === 'bad' ? 'problem' : i.tone === 'warn' ? 'check' : 'note'}: ${i.text}`);
    this.#doneConflict(...[...plan.changed, ...plan.added].map((i) => i.raceId).filter(Boolean));
    this.#meetBusy = true;
    try {
      await this.#apply(plan.next, { deleted: plan.deleted });
    } finally {
      this.#meetBusy = false;
    }
    const keptAs = mode === 'file' && b.keep === true && !undo ? await this.#keepLoadedMeet(meet, typeof b.fileName === 'string' ? b.fileName : '') : null;
    return {
      applied: {
        name, mode, beforeLoad, keptAs, ...back,
        // O6: only outputs that came in off although the file had them on or did not say; one off on purpose is not nudged
        outputsOff: plan.offOutputs,
        added: count(plan.added, 'race'), outputsAdded: count(plan.added, 'output'),
        // O27: what changed, by kind (the meet name is a setting, not a race)
        changed: plan.changed.length, racesChanged: count(plan.changed, 'race'), outputsChanged: count(plan.changed, 'output'), settings,
        removed: plan.removed.length,
      },
    };
  }

  /**
   * O5: a meet file loaded with the file chooser or a drop, kept in data\meets under its meet name (as Save would keep
   * it: the copy it replaces goes to data\meets\old), so the saved-meets list offers it next time. A copy started by
   * mistake with an empty data folder loads its first meet this way. Best effort: the load is done either way.
   * @returns {Promise<string|null>} the file name in data\meets, or null
   */
  async #keepLoadedMeet(meet, fileName) {
    const base = path.basename(String(fileName).replace(/\\/g, '/')).replace(/\.json$/i, '');
    const name = meet.name || (base && !/^config(\.json)?$/i.test(base) ? base : '') || `Meet ${localDate()}`;
    const keepName = meetFileName(name);
    const dir = path.join(this.#dataDir, 'meets');
    const file = path.join(dir, keepName);
    const text = meetText(meetFileOf({ ...meet, name }));
    try {
      await fsp.mkdir(dir, { recursive: true });
      const old = await fsp.readFile(file, 'utf8').catch(() => null);
      if (old === text) return keepName;
      if (old !== null) {
        await fsp.mkdir(path.join(dir, 'old'), { recursive: true });
        await fsp.copyFile(file, path.join(dir, 'old', `${keepName.replace(/\.json$/i, '')} ${fileStamp()}.json`));
      }
      await writeFileAtomic(file, text);
    } catch (err) {
      this.#line(`[meet] the loaded meet file could not be kept in ${dir} (${err?.code ?? err?.message ?? err})`);
      return null;
    }
    this.#line(`[meet] the loaded meet file is kept as ${file}`);
    return keepName;
  }

  /** R17: the RR12 ports a meet file adds that another program on this PC listens on (another copy of Split Relay?). */
  async #busyPorts(from) {
    const want = from.mode === 'file' && Array.isArray(from.meet.input?.ports) ? from.meet.input.ports : [];
    const cur = inputPorts(this.config);
    // never a port the load refuses anyway (TrackScore's 5555, an output's): nothing listens there for a moment
    const names = [os.hostname(), ...this.#ipv4()];
    const ports = [...new Set(want)].filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535 && !cur.includes(p) && p !== this.#panel.port &&
      inputPortProblem(this.config, p, { names }) === null);
    const out = new Set();
    await Promise.all(ports.map(async (p) => {
      if (await this.#portTaken(p).catch(() => false)) out.add(p);
    }));
    return out;
  }

  /** R17: when a merged .lif file was last written in the folder a load would start writing to, or null. */
  async #mergedRecent(from) {
    const l = from.mode === 'file' && isObj(from.meet.lif) ? from.meet.lif : null;
    const dir = String(l?.outputDir ?? this.config.lif?.outputDir ?? '').trim();
    const on = l?.enabled ?? this.config.lif?.enabled;
    if (!l || !on || !dir || (this.config.lif?.enabled && String(this.config.lif.outputDir ?? '').trim() === dir)) return null;
    const at = await newestLif(dir);
    return at === null ? null : { dir, at };
  }

  /**
   * POST /api/meet/new (9.22 M9): the data folder is copied to data\archive\<stamp>, then every read so far goes out of
   * use (kept in reads.jsonl) and every gun time, Pause and the meet name are cleared. Races, outputs and settings stay.
   * Nothing is deleted and nothing is sent. Refused while a race runs.
   * @param {any} body { confirm: true }
   */
  async newMeet(body) {
    if (!isObj(body) || body.confirm !== true) throw new HttpError(400, 'Send { "confirm": true } to start a new meet.');
    this.#refuseWhileRunning();
    if (this.#meetBusy) throw new HttpError(409, BUSY);
    this.#meetBusy = true;
    try {
      this.#engine.flush();
      await this.#store.flush();
      await this.#cfg.flush();
      const root = path.join(this.#dataDir, 'archive');
      const stamp = fileStamp();
      let dir = path.join(root, stamp);
      for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `${stamp}-${n}`);
      const rel = `data\\archive\\${path.basename(dir)}`;
      const copyFailed = (err) => new HttpError(500, `Split Relay could not copy the data folder to data\\archive (${err?.code ?? err?.message ?? err}). Nothing was changed.`);
      try {
        await fsp.mkdir(dir, { recursive: true });
        const races = path.join(this.#dataDir, 'races');
        if (fs.existsSync(races)) await fsp.cp(races, path.join(dir, 'races'), { recursive: true });
      } catch (err) {
        throw copyFailed(err);
      }
      // the merged .lif files stay where they are (they are written again when FinishLynx writes this meet's files):
      // copies go along
      let mergedCopied = 0;
      let mergedNote = null;
      const merged = String(this.config.lif?.outputDir ?? '').trim();
      if (merged) {
        try {
          mergedCopied = await withTimeout((async () => {
            let n = 0;
            const names = (await fsp.readdir(merged, { withFileTypes: true })).filter((e) => e.isFile() && /\.lif$/i.test(e.name));
            if (names.length) await fsp.mkdir(path.join(dir, 'merged'), { recursive: true });
            for (const e of names) {
              await fsp.copyFile(path.join(merged, e.name), path.join(dir, 'merged', e.name));
              n++;
            }
            return n;
          })(), 3000);
          if (mergedCopied === undefined) {
            mergedCopied = 0;
            mergedNote = `${merged} did not answer within 3 seconds`;
          }
        } catch (err) {
          mergedNote = `${err?.code ?? err?.message ?? err}`;
        }
      }
      try {
        const d = new Date();
        await fsp.writeFile(path.join(dir, 'about.txt'), `Copy of Split Relay's data folder, taken when "Start a new meet" was ` +
          `pressed on ${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}. Nothing in Split Relay reads it.\r\n`);
      } catch { /* the copy is there; the note is a nicety */ }
      // checked again: a gun may have been typed while the folder was copied
      this.#refuseWhileRunning();
      // O20: the settings and the read journal are copied in the same synchronous step as newMeet() (the journal is
      // written synchronously), so the copy holds exactly the reads that go out of use: one that arrives now waits for
      // the next turn and counts in the new meet
      this.#engine.flush();
      try {
        for (const f of ['config.json', 'config.json.bak', 'reads.jsonl', 'startlists.json']) {
          const from = path.join(this.#dataDir, f);
          if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
        }
      } catch (err) {
        throw copyFailed(err);
      }
      const withReads = this.config.races.filter((r) => (this.#engine.raceView(r.id)?.lastReadAt ?? null) !== null).map((r) => r.name);
      const guns = this.config.races.filter((r) => r.gun).length;
      const { reads } = this.#engine.newMeet();
      // 9.25: the start lists were the old meet's (the copy has them): the new meet's entry files are loaded again
      const startLists = Object.keys(this.#startLists.events).length;
      if (startLists) {
        await fsp.rm(this.#startListsFile, { force: true }).catch((err) => this.#say(`[startlist] startlists.json could not be removed (${err?.code ?? err?.message ?? err})`));
        this.#startLists = noStartLists();
        this.#engine.startListsChanged();
      }
      // R6: the race files say at once that their deliveries are gone (a kill now must not bring them back)
      this.#engine.flush();
      await this.#store.flush();
      const next = structuredClone(this.config);
      for (const r of next.races) {
        r.gun = '';
        for (const s of r.splits) s.sending = true;
      }
      // R6: a new name, or the next Save would replace the last meet's file
      next.meet = { ...next.meet, name: '' };
      await this.#apply(next);
      this.#say(`[meet] new meet started: ${reads.toLocaleString('en-US')} reads of the last meet are out of use (kept in reads.jsonl); ` +
        `guns cleared on ${guns} race${guns === 1 ? '' : 's'}; copy in ${rel}${mergedNote ? ` (the merged .lif files were not copied: ${mergedNote})` : ''}`);
      return { archive: rel, reads, races: withReads, guns, mergedCopied, ...(mergedNote ? { mergedNote } : {}), ...(startLists ? { startLists } : {}) };
    } finally {
      this.#meetBusy = false;
    }
  }

  /**
   * R6: never under a running race (meet.js raceRunning, the panel's rule too): Active with a gun, and its clock under
   * 30 minutes (O19: a gun typed a moment ago, before the first read) or a read in the last 20 minutes. A gun left from
   * an earlier day does not count: clearing it is what a new meet is for.
   */
  #refuseWhileRunning() {
    const now = Date.now();
    for (const r of this.config.races) {
      const last = this.#engine.raceView(r.id)?.lastReadAt ?? null;
      if (!raceRunning(r, last, now)) continue;
      const d = new Date(last ?? 0);
      const when = last !== null && now - last < RUNNING_READ_MS ? `last read ${pad(d.getHours())}:${pad(d.getMinutes())}` : `gun ${r.gun}`;
      throw new HttpError(409, `${r.name} is running (${when}). Start a new meet once it is over, or turn off its Active (on its page) first.`);
    }
  }

  /** The meet a preview is about: from the browser, a saved file, or TrackScore. */
  async #meetFrom(body) {
    const b = isObj(body) ? body : null;
    const kinds = b ? ['meet', 'saved', 'trackscore'].filter((k) => b[k] !== undefined && b[k] !== false && b[k] !== null) : [];
    if (kinds.length !== 1 || (kinds[0] === 'saved' && typeof b.saved !== 'string') || (kinds[0] === 'trackscore' && b.trackscore !== true)) {
      throw new HttpError(400, 'Send { "meet": … } (a meet file), { "saved": "<file name>" } or { "trackscore": true }.');
    }
    if (kinds[0] === 'trackscore') return this.#meetFromTrackScore();
    let raw = b.meet;
    let kind = 'file';
    let fileName = typeof b.fileName === 'string' ? path.basename(b.fileName.replace(/\\/g, '/')) : '';
    if (kinds[0] === 'saved') {
      const file = await this.#savedMeetFile(b.saved);
      try {
        raw = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
      } catch {
        throw new HttpError(400, `${b.saved} can't be read as a meet file.`);
      }
      kind = 'saved';
      fileName = b.saved;
    }
    let parsed;
    try {
      parsed = parseMeet(raw);
    } catch (err) {
      throw meetHttpError(err);
    }
    if (isObj(raw) && !Object.hasOwn(raw, 'splitRelayMeet')) kind = 'config';
    const savedOn = parsed.meet.savedOn ?? null;
    // O2: the copy kept before a load (R14): it can put races back, and offers to remove what that load added
    const beforeLoad = kind === 'saved' && /^before-load\//i.test(fileName);
    return {
      meet: parsed.meet, mode: 'file', notes: parsed.notes,
      source: { kind, fileName, savedAt: parsed.meet.savedAt ?? null, savedOn,
        otherPc: !!savedOn && savedOn.toLowerCase() !== os.hostname().toLowerCase(), ...(beforeLoad ? { beforeLoad: true } : {}) },
    };
  }

  /**
   * A saved meet by its name in the list: found among the files really in data\meets (or before-load), never by
   * building a path from what was sent (O17), so nothing outside the folder, and no device name, can be opened.
   */
  async #savedMeetFile(saved) {
    const notThere = new HttpError(404, `There is no saved meet file called "${saved}". It may have been deleted: reload the page.`);
    const m = /^(?:(before-load)\/)?([^\\/]+)$/i.exec(saved);
    if (!m || !/\.json$/i.test(m[2])) throw notThere;
    const folder = path.join(this.#dataDir, 'meets', ...(m[1] ? ['before-load'] : []));
    let names;
    try {
      names = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      throw notThere;
    }
    const hit = names.find((e) => e.isFile() && e.name.toLowerCase() === m[2].toLowerCase());
    if (!hit || (m[1] && !BEFORE_LOAD_FILE.test(hit.name))) throw notThere;
    const st = await fsp.stat(path.join(folder, hit.name)).catch(() => null);
    if (!st || st.size > MAX_MEET_BYTES) throw new HttpError(400, `${saved} is too big to be a meet file (more than 1 MB).`);
    return path.join(folder, hit.name);
  }

  /** "Set up from TrackScore" (9.22 M8): TrackScore's live meet read by this server (GETs only), as a meet. */
  async #meetFromTrackScore() {
    const { host, outputName } = trackScoreHost(this.config);
    const port = this.config.meet?.trackScoreWebPort ?? 5000;
    const listening = [...this.#inputs.keys()].map((p) => this.inputPortOf(p)).filter((p) => p !== null);
    const refuse = (p) => webPortProblem(this.config, p, { panelPort: this.#panel.port, listening });
    let r;
    try {
      r = await readTrackScore({ host, port, refuse, get: this.#trackScoreGet });
    } catch (err) {
      this.#line(`[meet] reading TrackScore at ${host}:${port} failed: ${err?.message ?? err}`);
      throw meetHttpError(err);
    }
    const ts = trackScoreToMeet({ raceSnap: r.raceSnap, schedule: r.schedule, meetName: r.meetName, meetId: r.meetId, host, port, outputName });
    // O27: what to do about it, not only what was done
    if (!outputName) {
      ts.notes.unshift({ kind: 'trackscore', name: '', tone: 'info', href: '#outputs',
        text: 'There is no TrackScore output yet, so Split Relay read TrackScore on this PC (127.0.0.1). If TrackScore runs on another PC, add the TrackScore output in Outputs first, then set up again.' });
    }
    this.#line(`[meet] read TrackScore at ${host}:${port}: meet ${r.meetId}${r.meetName ? ` "${r.meetName}"` : ''}, ` +
      `${r.schedule.races.length} races in Race Setup${ts.source.liveRace ? `, showing ${ts.source.liveRace}` : ''}`);
    return { meet: ts.meet, mode: 'trackscore', notes: ts.notes, source: ts.source };
  }

  /**
   * The paths a load would set, checked on this PC (9.22 M7, R13): one check at a time per drive or share, and when one
   * gets no answer the rest of that share is 'unknown' without a check, so a dead share never ties up the threads the
   * FinishLynx folder reads and the settings writes need. Answers are reused for a minute (an apply after its preview).
   * @param {{ path: string, kind: 'file'|'dir' }[]} list
   * @returns {Promise<Map<string, 'yes'|'no'|'unknown'>>}
   */
  async #checkPaths(list) {
    const out = new Map();
    const byShare = new Map();
    for (const { path: p, kind } of list) {
      const c = this.#pathCache.get(`${kind}|${p}`);
      if (c && Date.now() - c.at < PATH_CACHE_MS) {
        out.set(p, c.state);
        continue;
      }
      const share = shareOf(p);
      if (!byShare.has(share)) byShare.set(share, []);
      byShare.get(share).push({ p, kind });
    }
    await Promise.all([...byShare.values()].map(async (queue) => {
      let dead = false;
      for (const { p, kind } of queue) {
        let state = 'unknown';
        if (!dead) {
          try {
            state = await this.#checkPath(p, kind);
          } catch {
            state = 'unknown';
          }
        }
        if (state === 'unknown') dead = true;
        out.set(p, state);
        this.#pathCache.set(`${kind}|${p}`, { at: Date.now(), state });
      }
    }));
    return out;
  }

  /**
   * What the plan needs to know about the reads (9.22 M5): what each race holds (in use = reads, crossings, a gun, or
   * reads waiting for it), the reads in no race, RR12's connections, and what each output has been sent.
   */
  #meetContext(mode = 'file') {
    const waiting = new Map();
    /** R16: port -> the reads on it that wait for a race that is not Active */
    const waitingByPort = new Map();
    let noRaceReads = 0;
    for (const n of this.#engine.noRace()) {
      noRaceReads += n.count;
      if (n.status === 'paused' && n.raceId) waiting.set(n.raceId, (waiting.get(n.raceId) ?? 0) + n.count);
      if (n.status === 'paused' && n.raceId && n.via === 'port' && Number.isInteger(n.port)) {
        waitingByPort.set(n.port, [...(waitingByPort.get(n.port) ?? []), { raceId: n.raceId, raceName: n.raceName, count: n.count }]);
      }
    }
    const races = new Map();
    for (const r of this.config.races) {
      const v = this.#engine.raceView(r.id);
      races.set(r.id, {
        reads: (v?.contestsSeen ?? []).reduce((n, c) => n + (c.count || 0), 0),
        crossings: (v?.splits ?? []).reduce((n, s) => n + (s.crossings || 0), 0),
        waiting: waiting.get(r.id) ?? 0,
        lastReadAt: v?.lastReadAt ?? null,
      });
    }
    const connections = this.inputsStatus().reduce((n, i) => n + i.connections.length, 0);
    // O3: FinishLynx's event names from its files of today (Set up from TrackScore names new races as FinishLynx does)
    let lynxNames = null;
    if (mode === 'trackscore' && typeof this.#lif?.lynxEventNames === 'function') {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      lynxNames = this.#lif.lynxEventNames(midnight.getTime());
    }
    // O34: thisPc and its addresses: an output sent there reaches this PC's own RR12 ports
    return { races, noRaceReads, connections, sentTo: this.#engine.sentCounts(), thisPc: os.hostname(), thisPcAddresses: this.#ipv4(),
      panelPort: this.#panel.port, now: Date.now(), waitingByPort, lynxNames };
  }

  /**
   * The setup a preview was made for: the settings, which races are in use, whether any read or RR12 connection holds
   * the SR line format, and which outputs have been sent splits. More reads in a race already in use change nothing.
   */
  #meetBase(ctx) {
    const inUse = [...ctx.races].filter(([, s]) => s.reads > 0 || s.crossings > 0 || s.waiting > 0).map(([id]) => id).sort();
    const srBusy = ctx.noRaceReads > 0 || ctx.connections > 0 || inUse.length > 0;
    const sent = [...ctx.sentTo.keys()].sort();
    const lynx = ctx.lynxNames instanceof Map ? [...ctx.lynxNames] : null;
    return crypto.createHash('sha1').update(JSON.stringify([this.config, inUse, srBusy, sent, ...(lynx ? [lynx] : [])])).digest('hex');
  }

  /**
   * R5: reads that arrived before today, per race and in no race. Reads have a time of day and no date: once today's gun
   * is typed, yesterday's reads at a later time of day become splits. The preview then offers "Start a new meet" first.
   * @returns {{ races: { id: string, name: string, reads: number, lastReadAt: number|null }[], noRace: number } | null}
   */
  #oldReads() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const { byRace, noRace } = this.#engine.readsBefore(midnight.getTime());
    if (!byRace.size && !noRace) return null;
    const names = new Map(this.#engine.missingRaces().map((m) => [m.raceId, m.raceName || 'a race not in the settings']));
    for (const r of this.config.races) names.set(r.id, r.name);
    return {
      races: [...byRace].map(([id, reads]) => ({ id, name: names.get(id) ?? id, reads, lastReadAt: this.#engine.raceView(id)?.lastReadAt ?? null })),
      noRace,
    };
  }

  /**
   * R14: the setup as it is, kept just before a load changes it: data\meets\before-load\<stamp>.json (a meet file the
   * saved-meets list offers at the top) and an exact copy of config.json beside it. Written synchronously (two small
   * files), so nothing can change between this copy and the load. Refused, changing nothing, when it can't be written.
   */
  #keepBeforeLoad() {
    const dir = path.join(this.#dataDir, 'meets', 'before-load');
    const now = new Date();
    let stamp = fileStamp(now);
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (let n = 2; fs.existsSync(path.join(dir, `${stamp}.json`)); n++) stamp = `${fileStamp(now)}-${n}`;
      const meet = buildMeet(this.config, { name: this.config.meet?.name ?? '', savedAt: now.toISOString(), savedBy: `Split Relay ${VERSION}`, savedOn: os.hostname() });
      fs.writeFileSync(path.join(dir, `${stamp}.json`), meetText(meet));
      if (fs.existsSync(this.#cfg.file)) fs.copyFileSync(this.#cfg.file, path.join(dir, `${stamp}.config.json`));
    } catch (err) {
      throw new HttpError(500, `Split Relay could not keep a copy of the setup before the load in data\\meets\\before-load ` +
        `(${err?.code ?? err?.message ?? err}). Nothing was changed.`);
    }
    return { fileName: `before-load/${stamp}.json`, at: now.getTime() };
  }

  #race(id) {
    const race = this.config.races.find((r) => r.id === id);
    if (!race) throw notFound('race', id);
    return race;
  }

  #output(id) {
    const out = this.config.outputs.find((o) => o.id === id);
    if (!out) throw notFound('output', id);
    return out;
  }

  /**
   * Make a new config live, then bring every module in line with it. The change is live even when the file cannot be
   * written; the error says so.
   * @param {any} next
   * @param {{ fromEngine?: boolean, deleted?: string[] }} [opts] deleted = the races the operator deleted (R2)
   */
  async #apply(next, { fromEngine = false, deleted = [] } = {}) {
    const prev = this.config;
    const saving = this.#cfg.set(next);
    const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
    try {
      // Outputs first, so a fixed output can take what the engine sends it straight away. The engine re-reads the
      // config itself after its own gun patch; otherwise it re-applies races, outputs (enabled, races filter) and the
      // tag filter to every read so far.
      if (changed('races') || changed('outputs')) this.#outputs.sync();
      // only a DELETE takes a race's reads out of use; a race gone any other way is missing (DESIGN 9.2 R2, R6)
      // (9.25: and the start lists' setting: who is kept off the boards is worked out again)
      if ((changed('races') || changed('outputs') || changed('filter') || changed('entries')) && !fromEngine) this.#engine.configChanged({ deleted });
      if (changed('input')) for (const inp of this.#inputs.values()) inp.server.setFormat(next.input);
      if (changed('races') || changed('lif') || changed('names')) this.#lif.markDirty();
      if (prev.names.pplPath !== next.names.pplPath) {
        this.#line(`[names] names file is now ${next.names.pplPath || '(none)'}`);
        await withTimeout(this.#names.setPath(next.names.pplPath), 3000);
      }
      if (JSON.stringify(inputPorts(prev)) !== JSON.stringify(inputPorts(next))) {
        this.#say(`[in] RR12 input ports are now ${inputPorts(next).join(', ')}`);
        await this.#syncInputs(inputPorts(next));
      }
    } finally {
      this.#panel.notify();
    }
    await saving;
  }

  /** The engine's gun change: applied synchronously, as setGun needs; the file is written in the background. */
  #onConfigPatch(raceId, patch) {
    const next = patchRace(this.config, raceId, patch);
    const race = next.races.find((r) => r.id === raceId);
    this.#line(`[config] gun time of ${race?.name ?? raceId} set to ${patch?.gun || '(cleared)'}`);
    this.#apply(next, { fromEngine: true }).catch(() => { /* logged by ConfigFile; setGun reports it */ });
  }

  // ---- module events -------------------------------------------------------------------------------------------

  /**
   * @param {string} text
   * @param {import('./input.js').LineMeta} meta
   * @param {number} port the configured RR12 input port it came in on: a LapTime read's race goes by it (9.15 L3)
   */
  #onLine(text, meta, port) {
    this.#log.write(`[in #${meta.connId} ${meta.remote}] ${printable(text)}`);
    let r;
    try {
      r = parseLine(text, this.config.input);
    } catch (err) {
      r = { ok: false, kind: 'error', message: `Split Relay could not read this line (${err?.message ?? err})` };
    }
    // what the Settings tab says this port receives ("FinishLynx LapTime: bib + time")
    const inp = this.#inputs.get(port);
    if (inp && r.format && (r.ok || r.kind === 'ignored') && inp.format !== r.format) {
      inp.format = r.format;
      this.#panel.notify();
    }
    const m = { receivedAt: meta.receivedAt, raw: text, connId: meta.connId, port };
    if (r.ok) this.#queueRead({ read: r.read, meta: m });
    else if (r.kind === 'hello') this.#say(`[in #${meta.connId} ${meta.remote}] RR12 says hello (${r.message})`);
    else if (r.kind === 'ignored') this.#line(`[in #${meta.connId} ${meta.remote}] ${r.message}`);
    else if (r.kind === 'error') this.#queueRead({ read: null, meta: { ...m, error: r.message } });
  }

  /**
   * The lines of one TCP chunk arrive one 'line' event after another, synchronously; they go to the engine together
   * once the chunk is done (a microtask runs before anything else can happen), or every READ_BATCH lines, so the
   * engine journals them with one write and delivers once. A live read on its own is still processed at once.
   */
  #queueRead(item) {
    this.#readBatch.push(item);
    // At most READ_BATCH at a time: a batch's reads, feed rows and journal records are all alive until it is done, and
    // a few thousand of them at once would outlive the young heap and be kept until a full garbage collection.
    if (this.#readBatch.length >= READ_BATCH) this.#flushReads();
    else if (this.#readBatch.length === 1) queueMicrotask(() => this.#flushReads());
  }

  #flushReads() {
    const items = this.#readBatch;
    this.#readBatch = [];
    if (!items.length) return;
    try {
      this.#engine.handleReads(items);
    } catch (err) {
      this.#say(`[main] processing ${items.length === 1 ? 'a read' : `${items.length} reads`} failed: ${err?.stack ?? err}`);
    }
  }

  #onFeed(e) {
    // one line per read, built without throw-away arrays: an RR12 Replay logs tens of thousands of these
    const loc = e.location && e.location !== e.splitName ? `(${e.location})` : '';
    const where = e.splitName ? (loc ? `${e.splitName} ${loc}` : e.splitName) : loc;
    const time = e.raceTicks !== null && e.raceTicks !== undefined ? ` ${formatRaceTime(e.raceTicks, 3)}` : '';
    const place = e.place ? ` place ${e.place}` : '';
    this.#log.write(`[read] ${e.status} bib ${e.bib || '?'} ${where}${time}${place}${e.raceName ? ` [${e.raceName}]` : ''}: ${e.detail}`);
    this.#panel.feed(e);
    this.#panel.notify();
  }

  #onInput(st, port) {
    // connection ids are unique over every port (#connSeq), so one set tells which are new or gone
    const ids = new Set(st.connections.map((c) => c.id));
    for (const c of st.connections) {
      if (!this.#seenConns.has(c.id)) this.#say(`[in] RR12 connected from ${c.remote} to port ${port} (connection #${c.id})`);
    }
    const mine = this.#connsOf.get(port) ?? new Set();
    for (const id of mine) if (!ids.has(id)) this.#say(`[in] connection #${id} (port ${port}) closed`);
    this.#connsOf.set(port, ids);
    this.#seenConns = new Set([...this.#connsOf.values()].flatMap((s) => [...s]));
    const inp = this.#inputs.get(port);
    const sig = `${st.listening}|${st.port}|${st.error}`;
    if (inp && sig !== inp.sig) {
      inp.sig = sig;
      if (st.error) this.#say(`[in] ${st.error}`);
      else if (st.listening) this.#line(`[in] listening for RR12 on port ${st.port}${st.port !== port ? ` (for input port ${port})` : ''}`);
    }
    this.#panel.notify();
  }

  /** port -> the ids of its open connections */
  #connsOf = new Map();

  #onOutputs(list) {
    for (const o of list) {
      const sig = `${o.state}|${o.lastError ?? ''}|${o.clients}`;
      if (this.#outputSigs.get(o.id) === sig) continue;
      this.#outputSigs.set(o.id, sig);
      const words = {
        connected: `connected to ${o.target}`, connecting: `connecting to ${o.target}…`, listening: `listening on ${o.target} (${o.clients} connected)`,
        disabled: 'switched off', error: 'cannot send', disconnected: 'not connected',
      };
      this.#say(`[out ${o.name}] ${words[o.state] ?? o.state}${o.lastError ? ` (${o.lastError})` : ''}`);
    }
    this.#panel.notify();
  }

  #onNames(st) {
    const sig = `${st.path}|${st.count}|${st.error}`;
    if (sig !== this.#namesSig) {
      this.#namesSig = sig;
      if (st.error) this.#say(`[names] ${st.error}`);
      else if (st.loaded) this.#say(`[names] ${st.count} athletes loaded from ${st.path}`);
    }
    this.#lif?.markDirty();
    this.#panel?.notify();
  }

  #onLif(st) {
    if (st.error !== this.#lifError) {
      this.#lifError = st.error;
      if (st.error) this.#say(`[lif] ${st.error}`);
      else if (st.enabled) this.#say(`[lif] merged .lif files: ${st.state}`);
    }
    this.#panel.notify();
  }

  #ipv4() {
    if (Date.now() - this.#addresses.at > 5000) this.#addresses = { at: Date.now(), list: ipv4Addresses() };
    return this.#addresses.list;
  }

  // ---- logging -------------------------------------------------------------------------------------------------

  /**
   * Write a line to the daily log and the console window.
   * @param {string} text
   */
  report(text) {
    this.#say(text);
  }

  /** File only. */
  #line(text) {
    this.#log?.write(text);
  }

  /** File and console window. */
  #say(text) {
    this.#log?.write(text);
    if (!this.#quiet) console.log(`${clock()} ${text}`);
    this.emit('line', text);
  }

  /** A module's log line: file, plus the console when it reports a problem. */
  #moduleLine(text) {
    if (PROBLEM.test(text)) this.#say(text);
    else this.#line(text);
  }
}

function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The panel port in the settings file, read without changing anything (the file may belong to a running copy). */
function savedPanelPort(file) {
  try {
    const port = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))?.panel?.port;
    const n = typeof port === 'string' ? Number(port) : port;
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PANEL_PORT;
  } catch {
    return DEFAULT_PANEL_PORT;
  }
}

/** Whether the program answering on this port is a Split Relay (then a second copy just opens its panel). */
function isSplitRelayAt(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/expression', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(typeof JSON.parse(body)?.expression === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/**
 * Build and start Split Relay.
 * @param {ConstructorParameters<typeof SplitRelay>[0]} [opts]
 */
export async function startApp(opts) {
  const app = new SplitRelay(opts);
  try {
    await app.start();
  } catch (err) {
    await app.stop().catch(() => {});
    throw err;
  }
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

/** Open the panel in the default browser. Failing to is not an error: the banner shows the address. */
export function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      // `start "" <url>`: the empty title stops start taking the URL as the window title. Verbatim, because Node's
      // quoting of "" would reach cmd as \"\".
      child = spawn('cmd.exe', ['/d', '/c', `start "" "${url}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: true });
    } else {
      child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch {
    // the banner has the address
  }
}

const USAGE = `Split Relay ${VERSION}

  node src\\main.js [--data <folder>] [--port <panel port>] [--no-open]

  --data <folder>   where settings, race files and logs are kept (default: the "data" folder next to src)
  --port <number>   control panel port for this run (default: the one in Settings, normally 5590)
  --no-open         do not open the control panel in the browser
`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { dataDir: DEFAULT_DATA_DIR, panelPort: undefined, open: true, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === '--data') {
      const v = value();
      if (!v) opts.errors.push('--data needs a folder, for example --data D:\\SplitRelayData');
      else opts.dataDir = path.resolve(v);
    } else if (flag === '--port') {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 1 || v > 65535) opts.errors.push('--port needs a port number from 1 to 65535, for example --port 5591');
      else opts.panelPort = v;
    } else if (flag === '--no-open') opts.open = false;
    else if (flag === '--help' || flag === '-h' || flag === '/?') opts.help = true;
    else opts.errors.push(`Unknown option "${a}".`);
  }
  return opts;
}

function banner(app) {
  const addrs = ipv4Addresses();
  const where = (port) => (addrs.length ? addrs.map((a) => `${a}:${port}`).join('  or  ') : `127.0.0.1:${port}`);
  const rr = app.inputsStatus().map((st) => (st.listening ? where(st.boundPort ?? st.port) : `port ${st.port} NOT LISTENING: ${st.error}`));
  const line = '='.repeat(72);
  console.log([
    '', line,
    `  Split Relay ${VERSION} is running. Keep this window open during the meet.`,
    line,
    `  Control panel:     ${app.panelUrl}`,
    ...rr.map((r, i) => `  ${i === 0 ? 'RR12 exporter:    ' : '                  '} TCP/IP to ${r}`),
    `  Settings and logs: ${app.dataDir}`,
    '  To stop:           press Ctrl+C in this window',
    line, '',
  ].join('\n'));
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.errors.length) {
    console.error(`${opts.errors.join('\n')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  process.title = 'Split Relay';
  let app;
  try {
    // 9.28: GitHub is asked for a newer version at start; SPLITRELAY_UPDATE_API names a stand-in for GitHub (tests)
    app = await startApp({ dataDir: opts.dataDir, panelPort: opts.panelPort,
      update: { check: process.env.SPLITRELAY_UPDATE_CHECK !== '0', restartsItself: process.env.SPLITRELAY_LAUNCHER === '1',
        ...(process.env.SPLITRELAY_UPDATE_API ? { apiBase: process.env.SPLITRELAY_UPDATE_API } : {}) } });
  } catch (err) {
    if (err?.code === 'ALREADY_RUNNING') {
      console.log(`\n  ${err.message}\n  ${opts.open ? 'Opening it in the browser. ' : ''}This window closes by itself.\n`);
      if (opts.open) openBrowser(err.url);
      setTimeout(() => process.exit(0), 4000);
      return;
    }
    console.error(`\n  Split Relay could not start: ${err?.message ?? err}\n`);
    if (err?.code !== 'PANEL_PORT') console.error(err?.stack ?? err);
    process.exitCode = 1;
    return;
  }
  banner(app);
  if (opts.open) openBrowser(app.panelUrl);

  // Last line of defence on race day: an unexpected bug is logged and the relay keeps running. Every module already
  // catches its own socket and file errors; this is for the ones nobody thought of.
  const fatal = (err) => {
    try {
      app.report(`[main] unexpected error (Split Relay keeps running): ${err?.stack ?? err}`);
    } catch {
      console.error(err);
    }
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) {
      console.log('Stopping now.');
      process.exit(1);
    }
    stopping = true;
    console.log(`\n${clock()} Stopping Split Relay (${signal})… saving the races.`);
    const force = setTimeout(() => {
      console.error('Split Relay took too long to stop; closing now.');
      process.exit(1);
    }, 8000);
    force.unref();
    app.stop().then(() => {
      // Splits an output had not received were listed just above; they go out at the next start.
      console.log(`${clock()} Split Relay stopped. Every read is saved.`);
      process.exit(0);
    }, () => process.exit(1));
  };
  // 9.28: an update was installed: save and stop as for Ctrl+C, with the code that makes the launcher start the new version
  app.on('restart', (done) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${clock()} Split Relay ${done?.to ?? ''} is installed. Stopping this version… saving the races.`);
    const force = setTimeout(() => process.exit(RESTART_CODE), 8000);
    force.unref();
    app.stop().then(() => process.exit(RESTART_CODE), () => process.exit(RESTART_CODE));
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(sig, () => shutdown(sig));
    } catch { /* that signal does not exist on this OS */ }
  }
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const run = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === run.toLowerCase() : me === run;
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.stack ?? err);
    process.exitCode = 1;
  });
}
