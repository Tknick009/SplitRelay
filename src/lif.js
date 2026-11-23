// Merged .lif files. FinishLynx now sees finish passings only, so its .lif files carry no splits; this module
// rebuilds the file FinishLynx would have written (its own rows plus the relay's splits) in a folder of our own, and
// TrackScore, XC-Analytics and the web results read that folder instead of the Lynx one.
//
// Row layout, verified on 10 real files (4 440 rows): 0 place, 1 bib, 2 lane, 3 last, 4 first, 5 team, 6 time,
// 7 licence (M/F), 8 delta, 9 blank, 10 splits, 11 start time of day, 12-14 user, 15-16 gaps, 17 blank, 18 average lap.

import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { encodeCp1252, decodeCp1252 } from './cp1252.js';
import { formatLynxTod, formatRaceTime, parseRaceTime, parseTod } from './timefmt.js';

const ROW_FIELDS = 19;
const F_PLACE = 0, F_BIB = 1, F_LAST = 3, F_FIRST = 4, F_TEAM = 5, F_TIME = 6, F_LICENCE = 7, F_SPLITS = 10,
  F_START = 11, F_AVG = 18;

/**
 * @typedef {{ line: string, fields: string[] }} LifHeader
 * @typedef {{ line: string, fields: string[], bib: string, place: string, time: string }} LifRow
 * @typedef {{ first?: string, last?: string, team?: string, gender?: string, splits: (number | null)[] }} RelayRunner
 *   splits: race time (ticks since the gun) at each split, in course order; null where the mat missed the runner
 * @typedef {{ splitCount: number, gun: number | null, runners: Map<string, RelayRunner> }} RaceData
 * @typedef {{ name: string, eventNumber: string, round: string, heat: string, raceId: string | null,
 *   raceName: string, lynxName: string | null, rows: number, splitsAdded: number, writtenAt: number | null,
 *   copiedOnly: boolean, synthesized: boolean, error: string | null, note: string | null }} LifFileStatus
 *   lynxName: the event name in the FinishLynx file's header (null for a file we made up), so the panel can say
 *   when the race is called something else in Split Relay. note: why the file is not being updated right now.
 * @typedef {{ enabled: boolean, inputDir: string, outputDir: string, state: 'off' | 'ok' | 'error' | 'waiting',
 *   error: string | null, message: string | null, lastScanAt: number | null, files: LifFileStatus[] }} LifStatus
 *   'waiting': the FinishLynx folder is readable but has no .lif file that can be used yet, and no race has splits to
 *   write a file of its own; `message` says which ("No FinishLynx .lif files in C:\Lynx\Meet yet."). A folder that
 *   can't be read is an 'error' with the folder problem in `error`.
 */

// ---------------------------------------------------------------------------------------------------------------
// Paths

/**
 * What kind of path the operator typed, by Windows rules (the config is written on Windows). There '\Lynx\Merged'
 * is not a network path but "the root of the drive Split Relay started on", so a UNC path that lost one backslash
 * would silently become C:\192.168.0.5\..., and 'C:Lynx' is relative to drive C's current folder.
 * @param {unknown} p
 * @param {string} [platform] tests pass 'win32' to get the Windows answer on any OS
 * @returns {'empty' | 'drive' | 'unc' | 'posix' | 'unc-incomplete' | 'root-relative' | 'drive-relative' | 'relative'}
 */
export function pathKind(p, platform = process.platform) {
  const s = String(p ?? '').trim();
  if (!s) return 'empty';
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'drive';
  if (/^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(s)) return 'unc';
  if (/^[\\/]{2}/.test(s)) return 'unc-incomplete';
  // A Linux or Mac test box has no drive letters; '/home/x' is its only full path.
  if (s.startsWith('/') && platform !== 'win32') return 'posix';
  if (/^[\\/]/.test(s)) return 'root-relative';
  if (/^[A-Za-z]:/.test(s)) return 'drive-relative';
  return 'relative';
}

/**
 * Why a path the operator typed cannot be used, in plain words, or null when it is a full path (drive letter or
 * \\server\share). An empty path is not a problem here: whether one is needed is the caller's business.
 * @param {unknown} p
 * @param {string} what e.g. 'the merged .lif folder'
 * @param {string} example e.g. 'C:\\Lynx\\Merged'
 * @param {string} [platform]
 * @returns {string | null}
 */
export function fullPathProblem(p, what, example, platform = process.platform) {
  const s = String(p ?? '').trim();
  switch (pathKind(s, platform)) {
    case 'empty':
    case 'drive':
    case 'unc':
    case 'posix':
      return null;
    case 'root-relative':
      return `"${s}" starts with a single ${s.startsWith('/') ? 'slash' : 'backslash'}. A network path starts with two backslashes ` +
        `(for example \\\\192.168.0.5\\Lynx\\Meet), and a folder on this PC starts with its drive letter (C:\\...). ` +
        `Type the full path of ${what}, for example ${example}.`;
    case 'unc-incomplete':
      return `"${s}" is missing the shared folder's name. A network path looks like \\\\192.168.0.5\\Lynx\\Meet. ` +
        `Type the full path of ${what}, for example ${example}.`;
    default:
      return `Type the full path of ${what}, for example ${example}.`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** Fields of one line with their quotes kept, so a field we do not change goes back out exactly as it came in. */
function splitRaw(line) {
  const out = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out;
}

/** A raw field's value: quotes removed, a doubled quote inside quotes kept as one. */
function unquote(raw) {
  if (!raw.includes('"')) return raw;
  let s = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '"') s += c;
    else if (quoted && raw[i + 1] === '"') {
      s += '"';
      i++;
    } else quoted = !quoted;
  }
  return s;
}

/**
 * A .lif file's text -> its header and rows. The header is the first non-blank line when its first-name field is
 * empty (it carries the event name in the last-name column), the rule both TrackScore and XC-Analytics use; a
 * 19-field line is always a row, so a first runner without a first name is not mistaken for it.
 * @param {string} text
 * @returns {{ header: LifHeader | null, rows: LifRow[] }}
 */
export function parseLif(text) {
  /** @type {LifHeader | null} */
  let header = null;
  /** @type {LifRow[]} */
  const rows = [];
  for (const line of String(text ?? '').split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    const fields = splitRaw(line).map(unquote);
    if (!header && rows.length === 0 && (fields[F_FIRST] ?? '').trim() === '' && fields.length < ROW_FIELDS) {
      header = { line, fields };
      continue;
    }
    const at = (i) => (fields[i] ?? '').trim();
    rows.push({ line, fields, bib: at(F_BIB), place: at(F_PLACE), time: at(F_TIME) });
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Names and matching

/** "003" and "3" are the same event to FinishLynx; letters compare without case. A UTF-8 byte-order mark (read as
 * windows-1252) is not part of the event number. */
function normId(v) {
  return String(v ?? '').replace(/^(?:﻿|ï»¿)/, '').trim().replace(/^0+(?=.)/, '').toLowerCase();
}

/** Round and heat default to 1, as FinishLynx numbers them and as an operator leaving them blank means. */
const normRoundHeat = (v) => normId(v) || '1';

/** Characters Windows refuses in a file name; an event "3/4" must not become a sub-folder. */
const BAD_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function namePart(v, fallback, width) {
  let s = String(v ?? '').replace(BAD_NAME_CHARS, '').trim() || fallback;
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  return s.padStart(width, '0');
}

/**
 * The name FinishLynx gives an event's results file: event 3, round 1, heat 1 -> "003-1-01.lif". TrackScore guesses
 * this same name when it watches a race ahead of the first finish.
 * @param {string | number} eventNumber
 * @param {string | number} [round]
 * @param {string | number} [heat]
 */
export function lifFileName(eventNumber, round, heat) {
  return `${namePart(eventNumber, '0', 3)}-${namePart(round, '1', 1)}-${namePart(heat, '1', 2)}.lif`;
}

function headerMatches(race, header) {
  if (!race || !header) return false;
  const en = normId(race.eventNumber);
  const f = header.fields;
  return en !== '' && en === normId(f[0]) && normRoundHeat(race.round) === normRoundHeat(f[1]) &&
    normRoundHeat(race.heat) === normRoundHeat(f[2]);
}

/** The event name FinishLynx wrote in a header (field 3), or null. */
function lynxEventName(header) {
  const name = String(header?.fields?.[3] ?? '').trim();
  return name || null;
}

/** "3-1-1" for messages: the event as the operator would say it. */
function eventLabel(race) {
  return `${normId(race?.eventNumber) || '?'}-${normRoundHeat(race?.round)}-${normRoundHeat(race?.heat)}`;
}

/** Bibs as FinishLynx and RR12 may print them ("0571" / "571") refer to the same runner. */
function bibKey(bib) {
  const s = String(bib ?? '').trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s.toLowerCase();
}

/** A bib for other modules: as RR12 sends it, so numbers lose leading zeros but letters keep their case. */
function plainBib(bib) {
  const s = String(bib ?? '').trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

/**
 * The finishers in a FinishLynx file: rows with a numeric place and a finish time. DNF, DQ and blank places are not
 * finishers, whatever their time says.
 * @param {string} text
 * @returns {{ map: Map<string, number>, places: Map<string, number> }} bib -> finish race ticks, bib -> place
 */
function finishersOf(text) {
  const map = new Map();
  const places = new Map();
  for (const row of parseLif(text).rows) {
    if (!/^\d+$/.test(row.place) || Number(row.place) < 1) continue;
    const ticks = parseRaceTime(row.time);
    const bib = plainBib(row.bib);
    if (ticks === null || !bib || map.has(bib)) continue;
    map.set(bib, ticks);
    places.set(bib, Number(row.place));
  }
  return { map, places };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

/**
 * A text value for a .lif field. FinishLynx's readers toggle on every '"', so a quote inside a name would swallow
 * the rest of the row: it becomes an apostrophe. Control characters would end the row.
 */
function textField(v) {
  const s = String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/"/g, "'").trim();
  return s.includes(',') ? `"${s}"` : s;
}

/** FinishLynx quotes the splits only when they hold a comma: a single entry is written bare. */
const splitsField = (s) => (s.includes(',') ? `"${s}"` : s);

/** A runner's start time of day as FinishLynx writes it on each row: hour without a leading zero, thousandths rounded
 * up ("12:58:49.2595" in the header -> "12:58:49.260"; "13:29:12.1181" -> "13:29:12.119"). */
function rowStartTod(gun) {
  if (gun === null || gun === undefined || !Number.isFinite(gun)) return '';
  return formatLynxTod(Math.ceil(gun / 10) * 10).slice(0, -1);
}

/**
 * A runner's split slots as they go into the file: each time rounded up to the thousandth FinishLynx prints, and
 * only the slots that can be true. A split must come after the start and before the next split this runner has (or
 * the finish): a runner who missed a mat in the race and walked over it later, or a backup read from a mat crossed
 * after finishing, would otherwise put a split after the finish, which TrackScore then shows as that runner's split
 * and XC-Analytics rejects as "splits are not increasing". Walking back from the finish keeps the later, trusted
 * time and drops the stray one, which is what the engine's own out-of-order rule does, so the file and the live
 * packets agree on which crossing counts.
 * @param {(number | null)[]} splits race ticks, course order
 * @param {number} n split count
 * @param {number | null} finishTicks FinishLynx's finish time for the row, if it has one
 * @returns {(number | null)[]} n slots, null = empty
 */
function cleanSlots(splits, n, finishTicks) {
  const slots = [];
  for (let i = 0; i < n; i++) {
    const t = splits?.[i];
    slots.push(typeof t === 'number' && Number.isFinite(t) ? Math.ceil(t / 10) * 10 : null);
  }
  let limit = typeof finishTicks === 'number' && Number.isFinite(finishTicks) ? finishTicks : Infinity;
  for (let i = n - 1; i >= 0; i--) {
    const t = slots[i];
    if (t === null) continue;
    if (t > 0 && t < limit) limit = t;
    else slots[i] = null;
  }
  return slots;
}

/**
 * Field 10 and field 18 for one runner. Each split is a slot (empty where the mat missed the runner, so readers that
 * understand by-mat lists keep every read on its own mat); the finish follows when there is one; trailing empty slots
 * say nothing and are dropped. Legs are worked out from the printed (rounded) cumulatives, as FinishLynx does: from
 * the unrounded ones the finish leg came out 1 ms long whenever the gun had a 0.1 ms digit. FinishLynx's average lap
 * is the last cumulative over the number of entries, truncated to the millisecond and then rounded up to hundredths:
 * that reproduces all 4 440 rows of the reference files.
 * @param {(number | null)[]} slots from cleanSlots
 * @param {{ text: string, ticks: number } | null} finish
 */
function buildSplits(slots, finish) {
  const entries = [];
  let prev = null;
  let count = 0;
  let added = 0;
  for (const t of slots) {
    if (t === null) {
      entries.push('');
      continue;
    }
    entries.push(`${formatRaceTime(t, 3)} (${formatRaceTime(prev === null ? t : t - prev, 3)})`);
    prev = t;
    count++;
    added++;
  }
  if (finish) {
    // The finish leg has the finish time's own precision: a hand time "32:20.85" gets "(12:18.36)".
    const decimals = Math.min(4, /[.,](\d+)$/.exec(finish.text)?.[1].length ?? 0);
    entries.push(`${finish.text} (${formatRaceTime(prev === null ? finish.ticks : finish.ticks - prev, decimals)})`);
    prev = finish.ticks;
    count++;
  }
  while (entries.length > 0 && entries[entries.length - 1] === '') entries.pop();
  const avg = count > 0 ? formatRaceTime(Math.floor(prev / count / 10) * 10, 2) : '';
  return { splits: entries.join(','), avg, added };
}

/** The relay's runners that have at least one split, keyed by bibKey. Accepts a Map or a plain object. */
function relayRunners(runners, n) {
  const out = new Map();
  const entries = runners instanceof Map ? runners.entries() : Object.entries(runners ?? {});
  for (const [bib, r] of entries) {
    const splits = Array.isArray(r?.splits) ? r.splits : [];
    if (!splits.slice(0, n).some((t) => typeof t === 'number' && Number.isFinite(t))) continue;
    const key = bibKey(bib);
    if (key && !out.has(key)) out.set(key, { ...r, bib: String(bib).trim(), splits });
  }
  return out;
}

/** Furthest split reached first, then who got there first: how FinishLynx lists runners still on the course. */
function progress(slots) {
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i] !== null) return { i, t: slots[i] };
  return { i: -1, t: Infinity };
}

function compareBibs(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function synthHeader(race, gun) {
  const tod = gun === null || gun === undefined || !Number.isFinite(gun) ? '' : formatLynxTod(gun);
  const id = (v, fallback) => textField(v) || fallback;
  const event = `${id(race?.eventNumber, '')},${id(race?.round, '1')},${id(race?.heat, '1')}`;
  return `${event},${textField(race?.name)},,,,,,,${tod}`;
}

/**
 * mergeLif plus what the status line wants to show.
 * @returns {{ text: string, rows: number, splitsAdded: number }}
 */
function mergeDetailed({ lynxText, race, gunTicks, splitCount, runners, fillPlaces = false }) {
  const parsed = lynxText ? parseLif(lynxText) : { header: null, rows: [] };
  const n = Number.isInteger(splitCount) && splitCount >= 0 ? splitCount : maxSplitLength(runners);
  const relay = relayRunners(runners, n);
  const lines = [parsed.header ? parsed.header.line : synthHeader(race, gunTicks)];
  const used = new Set();
  let splitsAdded = 0;
  let finisherInFile = false;

  for (const row of parsed.rows) {
    const finishTicks = parseRaceTime(row.time);
    if (finishTicks !== null) finisherInFile = true;
    const key = bibKey(row.bib);
    const runner = key ? relay.get(key) : undefined;
    if (!runner) {
      lines.push(row.line);
      continue;
    }
    used.add(key);
    const slots = cleanSlots(runner.splits, n, finishTicks);
    const built = buildSplits(slots, finishTicks === null ? null : { text: row.time, ticks: finishTicks });
    splitsAdded += built.added;
    const raw = splitRaw(row.line);
    if (built.splits === unquote(raw[F_SPLITS] ?? '').trim()) {
      lines.push(row.line);
      continue;
    }
    while (raw.length < ROW_FIELDS) raw.push('');
    raw[F_SPLITS] = splitsField(built.splits);
    raw[F_AVG] = built.avg;
    lines.push(raw.join(','));
  }

  const rest = [...relay.entries()].filter(([key]) => !used.has(key))
    .map(([, r]) => {
      const slots = cleanSlots(r.splits, n, null);
      return { r, slots, p: progress(slots) };
    })
    .filter((x) => x.p.i >= 0); // nothing usable left: a row would say nothing
  rest.sort((a, b) => b.p.i - a.p.i || a.p.t - b.p.t || compareBibs(a.r.bib, b.r.bib));
  const start = rowStartTod(gunTicks);
  rest.forEach(({ r, slots }, i) => {
    const built = buildSplits(slots, null);
    splitsAdded += built.added;
    const f = new Array(ROW_FIELDS).fill('');
    if (fillPlaces && !finisherInFile) f[F_PLACE] = String(i + 1);
    f[F_BIB] = textField(r.bib);
    f[F_LAST] = textField(r.last);
    f[F_FIRST] = textField(r.first);
    f[F_TEAM] = textField(r.team);
    f[F_LICENCE] = textField(r.gender);
    f[F_SPLITS] = splitsField(built.splits);
    f[F_START] = start;
    f[F_AVG] = built.avg;
    lines.push(f.join(','));
  });

  return { text: lines.map((l) => l + '\r\n').join(''), rows: lines.length - 1, splitsAdded };
}

function maxSplitLength(runners) {
  let n = 0;
  const values = runners instanceof Map ? runners.values() : Object.values(runners ?? {});
  for (const r of values) if (Array.isArray(r?.splits)) n = Math.max(n, r.splits.length);
  return n;
}

/**
 * The .lif FinishLynx would have written had it seen the splits: its own file with field 10 (and the average lap,
 * field 18) rebuilt for every runner the relay has splits for, plus a row per runner FinishLynx has not seen yet.
 * Everything else is left exactly as FinishLynx wrote it. Without a Lynx file the header is made from the race.
 * @param {{ lynxText?: string | null, race?: { eventNumber?: string, round?: string, heat?: string, name?: string },
 *   gunTicks?: number | null, splitCount?: number, runners?: Map<string, RelayRunner>, fillPlaces?: boolean }} args
 * @returns {string} CRLF line endings, the last line included
 */
export function mergeLif(args) {
  return mergeDetailed(args).text;
}

// ---------------------------------------------------------------------------------------------------------------
// LifSync: the folder-to-folder service

const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MAX_LIF_BYTES = 25 * 1024 * 1024;
const REPEAT_LOG_MS = 60_000;

const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

const lower = (s) => s.toLowerCase();
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** FinishLynx always ends its files with CRLF, so a file that does not is most likely still being written. */
const looksComplete = (buf) => buf[buf.length - 1] === 0x0a || buf[buf.length - 1] === 0x0d;

/** The header of a file still being written, when its first line is already complete. */
function firstLineHeader(buf) {
  if (!buf) return null;
  const end = buf.findIndex((b) => b === 0x0a || b === 0x0d);
  return end < 0 ? null : parseLif(decodeCp1252(buf.subarray(0, end))).header;
}

/** path.relative compares without case on Windows, which is what the file system does. */
function samePlaceOrInside(dir, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function folderError(what, dir, err) {
  const code = err?.code;
  if (code === 'ENOENT') {
    return `${what} not found: ${dir}. Check the path, and that the computer it is on is switched on and sharing it.`;
  }
  if (code === 'ENOTDIR') return `${what} is not a folder: ${dir}`;
  if (code === 'EACCES' || code === 'EPERM') return `No permission to use the ${lower(what)}: ${dir}`;
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'UNKNOWN'].includes(code)) {
    return `Can't reach the ${lower(what)}: ${dir} (${code}). Is the network share available?`;
  }
  return `Can't use the ${lower(what)} ${dir}: ${err?.message ?? err}`;
}

function writeError(name, err) {
  const code = err?.code;
  const hint = RENAME_RETRY_CODES.has(code) ? ' (another program has it open; trying again)'
    : code === 'ENOSPC' ? ' (the disk is full)' : '';
  return `Couldn't write ${name}: ${code ?? err?.message ?? err}${hint}`;
}

/**
 * Keeps a folder of merged .lif files in step with the FinishLynx folder and the relay's crossings.
 * Polls rather than watching (network shares drop change notifications), reads each changed file twice before
 * trusting it, writes temp + rename, and writes only when the bytes differ, so the programs watching the folder
 * re-import real changes only. Never writes inside the FinishLynx folder.
 * Emits 'status' (LifStatus) when what the panel shows changes, and 'finishers' (raceId) when the runners FinishLynx
 * has finished in a race change (see lynxFinishers).
 */
export class LifSync extends EventEmitter {
  /**
   * @param {{ getConfig: () => any, getRaceData: (raceId: string) => RaceData | null | undefined,
   *   log?: (line: string) => void, clock?: { now: () => number, setTimeout: Function, clearTimeout: Function },
   *   pollMs?: number, settleMs?: number, debounceMs?: number, backoffMs?: number, refreshMs?: number,
   *   staleMs?: number, renameRetries?: number, renameRetryMs?: number, quietMs?: number, fs?: typeof nodeFs }} opts
   *   Everything after pollMs is there for tests; the defaults are the design's figures. refreshMs: how often every
   *   file is re-read and every output rebuilt and compared with the disk, whatever the change tracking says.
   *   staleMs: how long a file that does not end in a line break must stay unchanged before it is believed.
   *   quietMs: how long freshScan waits for nothing new once FinishLynx is seen saving (revision 10; 2 x settleMs:
   *   a longer wait only moves the moment of sending, it can't know a finish FinishLynx has not saved yet).
   */
  constructor({ getConfig, getRaceData, log = () => {}, clock = defaultClock, pollMs = 1000, settleMs = 200,
    debounceMs = 1000, backoffMs = 10_000, refreshMs = 30 * pollMs, staleMs = 5 * pollMs, renameRetries = 10,
    renameRetryMs = 100, quietMs = 2 * settleMs, fs = nodeFs } = /** @type {any} */ ({})) {
    super();
    Object.assign(this, { getConfig, getRaceData, log, clock, fs, pollMs, settleMs, debounceMs, backoffMs, refreshMs,
      staleMs, renameRetries, renameRetryMs, quietMs });
    /** FinishLynx files by lower-case name: { name, sig, buf, text, header, mtimeMs, version, missing } */
    this._inputs = new Map();
    /** Files not yet believed complete: lower-case name -> { sig, since } */
    this._unsettled = new Map();
    /** Files in the folder with no usable version yet, from the last scan: lower-case name -> { name, header } */
    this._pending = new Map();
    /** Files whose change the last scan could not use yet (being written): lower-case names (freshScan waits for them) */
    this._changing = new Set();
    /** What each output file holds as far as we know: lower-case name -> { name, buf } */
    this._written = new Map();
    /** What each output was last built from, so unchanged races cost nothing: lower-case name -> key */
    this._builtFrom = new Map();
    /** Outputs we made up for races FinishLynx has no file for yet: lower-case name -> raceId */
    this._synth = new Map();
    /** @type {Map<string, LifFileStatus>} */
    this._files = new Map();
    this._dirty = new Set();
    this._allDirty = true;
    this._version = 0;
    this._inputKey = null;
    this._outputKey = null;
    this._lastRefresh = -Infinity;
    this._state = /** @type {LifStatus['state']} */ ('off');
    this._error = null;
    this._message = null;
    this._lastScanAt = null;
    this._lastEmitted = '';
    this._lastErrorLogged = null;
    this._recentLines = new Map();
    this._stopped = true;
    this._busy = null;
    this._again = false;
    this._pollTimer = null;
    this._dirtyTimer = null;
    this._tmpSeq = 0;
    /** Who FinishLynx has finished, per race: raceId -> { from, map, sig } (from: which file version it came from) */
    this._finishers = new Map();
    /** The by-identity "is the output inside the FinishLynx folder" answer for a pair of folders, see _guardCheck */
    this._guard = { key: '', inside: false };
    /** @type {WeakMap<Buffer, number>} */
    this._splitCounts = new WeakMap();
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._allDirty = true;
    this._kick();
  }

  /** Stops polling. The promise settles once a scan already under way has finished (tests wait for it). */
  stop() {
    this._stopped = true;
    if (this._pollTimer) this.clock.clearTimeout(this._pollTimer);
    if (this._dirtyTimer) this.clock.clearTimeout(this._dirtyTimer);
    this._pollTimer = this._dirtyTimer = null;
    return this._busy ?? Promise.resolve();
  }

  /**
   * The race's crossings changed. Its file is rebuilt at most debounceMs from the first call; calls inside that
   * window ride along instead of pushing it back, so a race with a read every 100 ms is still rewritten every second.
   * @param {string} [raceId] omitted = every race
   */
  markDirty(raceId) {
    if (raceId === undefined || raceId === null) this._allDirty = true;
    else this._dirty.add(raceId);
    if (this._dirtyTimer || this._stopped) return;
    this._dirtyTimer = this.clock.setTimeout(() => {
      this._dirtyTimer = null;
      this._kick();
    }, this.debounceMs);
  }

  /**
   * Read the FinishLynx folder NOW, before something is sent that depends on who has finished (DESIGN 9.18, revision
   * 10: Play on a paused split, and the Review's sends). FinishLynx may have finished runners seconds ago, and the
   * next poll would come too late: a split packet sent for them in between would replace their finish place in
   * TrackScore. The folder is read until it is settled: no file still being written, and either the first read found
   * nothing new, or nothing new came for quietMs (FinishLynx saving one finisher after another keeps it reading:
   * a finish it has sent to TrackScore may reach its file a moment later), for at most `timeoutMs`; a folder on a
   * slow share does not hold the caller up longer than that either. Never rejects. By the time it resolves,
   * 'finishers' has been emitted for every race whose finishers changed.
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ scanned: boolean, settled: boolean, ms: number }>} scanned: the folder was read (false when no
   *   FinishLynx folder is set, or LifSync is stopped); settled: the folder was quiet when it ended
   */
  async freshScan({ timeoutMs = 3000 } = {}) {
    const start = this.clock.now();
    const done = (scanned, settled) => ({ scanned, settled, ms: this.clock.now() - start });
    if (this._stopped || !String(this._config().lif?.inputDir ?? '').trim()) return done(false, true);
    const end = start + Math.max(0, timeoutMs);
    let scanned = false;
    let lastNew = null; // when a read last found something new
    for (;;) {
      const left = end - this.clock.now();
      if (left <= 0) return done(scanned, false);
      const version = this._version;
      let timedOut = false;
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = this.clock.setTimeout(() => {
          timedOut = true;
          resolve();
        }, left);
      });
      try {
        await Promise.race([this._kick(), timeout]);
      } catch {
        // _kick never rejects; a failing scan says so in the status
      } finally {
        this.clock.clearTimeout(timer);
      }
      if (timedOut) return done(scanned, false);
      scanned = true;
      if (this._stopped) return done(true, true);
      const now = this.clock.now();
      if (this._version !== version) lastNew = now;
      // settled: no file being written (one that changed but could not be used yet), and nothing new: at the first
      // read, or for quietMs since the last read that found something
      if (!this._changing.size && (lastNew === null || now - lastNew >= this.quietMs)) return done(true, true);
      const wait = Math.min(this.settleMs, end - this.clock.now());
      if (wait <= 0) return done(true, false);
      await this._sleep(wait);
    }
  }

  /**
   * Start time of day from the header of the race's FinishLynx file (the newest if several match), for the
   * gun box (the FinishLynx button only fills it, DESIGN 9.21). Available whenever the FinishLynx folder is set, even with merging off.
   * @param {string} raceId
   * @returns {number | null}
   */
  lynxStart(raceId) {
    const best = this._lynxInput(raceId);
    if (!best) return null;
    const f = best.header.fields;
    return parseTod(f[f.length - 1]);
  }

  /**
   * The event name in the header of the race's FinishLynx file, or null when there is none. TrackScore treats a
   * results file whose name changes as a new race, so the panel warns when Split Relay calls the race something else
   * (its made-up file carries Split Relay's name until FinishLynx writes the real one).
   * @param {string} raceId
   * @returns {string | null}
   */
  lynxName(raceId) {
    const best = this._lynxInput(raceId);
    return best ? lynxEventName(best.header) : null;
  }

  /**
   * FinishLynx's event names, from the headers of its .lif files changed since `sinceMs` (DESIGN 9.22 O3): event-round-
   * heat ("3-1-1", leading zeros dropped, as engine.js eventKey writes it) -> name, the newest file first. Set up from
   * TrackScore names a new race as FinishLynx does when FinishLynx has written that event's file today (an older file
   * may be last meet's: event numbers repeat).
   * @param {number} [sinceMs]
   * @returns {Map<string, string>}
   */
  lynxEventNames(sinceMs = 0) {
    const files = [...this._inputs.values()].filter((inp) => !inp.missing && inp.mtimeMs >= sinceMs && lynxEventName(inp.header))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out = new Map();
    for (const inp of files) {
      const f = inp.header.fields;
      const key = `${normId(f[0])}-${normRoundHeat(f[1])}-${normRoundHeat(f[2])}`;
      if (normId(f[0]) && !out.has(key)) out.set(key, lynxEventName(inp.header));
    }
    return out;
  }

  /**
   * Who FinishLynx has already finished in this race: the rows of its matching .lif with a numeric place and a time,
   * as bib -> finish race time in ticks (field 6, measured from FinishLynx's own start). Numeric bibs are given
   * without leading zeros ("0458" -> "458"), as RR12 sends them. With this the relay knows who has finished even when
   * no finish timing point is set up, and stops sending them split packets that would overwrite their finish place
   * in TrackScore. A new Map on every call; 'finishers' (raceId) is emitted whenever it changes.
   * @param {string} raceId
   * @returns {Map<string, number>}
   */
  lynxFinishers(raceId) {
    return new Map(this._finishers.get(raceId)?.map ?? []);
  }

  /**
   * The places FinishLynx gave its finishers in this race (DESIGN 9.17 P4): bib -> place, the same bibs as
   * lynxFinishers. A made-up split of a runner who has finished goes out with this place, so TrackScore keeps it.
   * A new Map on every call; 'finishers' is emitted when a place changes too.
   * @param {string} raceId
   * @returns {Map<string, number>}
   */
  lynxPlaces(raceId) {
    return new Map(this._finishers.get(raceId)?.places ?? []);
  }

  /** The race's FinishLynx file: one that is there now beats one that vanished, then the newest. */
  _lynxInput(raceId) {
    const race = this._races().find((r) => r?.id === raceId);
    if (!race) return null;
    let best = null;
    for (const inp of this._inputs.values()) {
      if (!headerMatches(race, inp.header)) continue;
      if (!best || (best.missing && !inp.missing) || (best.missing === inp.missing && inp.mtimeMs > best.mtimeMs)) best = inp;
    }
    return best;
  }

  /** @returns {LifStatus} */
  status() {
    const lif = this._config().lif ?? {};
    return {
      enabled: !!lif.enabled,
      inputDir: String(lif.inputDir ?? ''),
      outputDir: String(lif.outputDir ?? ''),
      state: this._state,
      error: this._error,
      // 'waiting' in words: "No FinishLynx .lif files in C:\Lynx\Meet yet." (9.16 F5)
      message: this._message ?? null,
      lastScanAt: this._lastScanAt,
      files: [...this._files.values()].sort(byName).map((f) => ({ ...f })),
    };
  }

  // --- internals ------------------------------------------------------------------------------------------------

  _config() {
    try {
      return this.getConfig() ?? {};
    } catch (err) {
      this._note(`[lif] could not read the settings: ${err?.message ?? err}`);
      return {};
    }
  }

  _races() {
    const races = this._config().races;
    return Array.isArray(races) ? races.filter((r) => r && r.id) : [];
  }

  _log(line) {
    try {
      this.log(line);
    } catch {
      // a failing logger must not stop the files
    }
  }

  /** A warning that would otherwise repeat every poll: logged once a minute at most. */
  _note(line) {
    const now = this.clock.now();
    const at = this._recentLines.get(line);
    if (at !== undefined && now - at < REPEAT_LOG_MS) return;
    if (this._recentLines.size > 200) this._recentLines.clear();
    this._recentLines.set(line, now);
    this._log(line);
  }

  _sleep(ms) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  _schedule(ms) {
    if (this._stopped) return;
    if (this._pollTimer) this.clock.clearTimeout(this._pollTimer);
    this._pollTimer = this.clock.setTimeout(() => {
      this._pollTimer = null;
      this._kick();
    }, ms);
  }

  /** One scan at a time; asking during a scan runs another straight after it. */
  _kick() {
    if (this._stopped) return Promise.resolve();
    if (this._busy) {
      this._again = true;
      return this._busy;
    }
    this._busy = (async () => {
      let delay = this.pollMs;
      try {
        do {
          this._again = false;
          delay = await this._scan();
        } while (this._again && !this._stopped);
      } catch (err) {
        // A bug in here must not take the relay down on race day: say so, try again later, rebuild everything then.
        this._allDirty = true;
        this._setState('error', `Merged .lif files stopped on an unexpected error: ${err?.message ?? err}`);
        delay = this.backoffMs;
      } finally {
        this._busy = null;
        this._schedule(delay);
      }
    })();
    return this._busy;
  }

  _setState(state, error = null, message = null) {
    this._state = state;
    this._error = error;
    this._message = message;
    if (error && error !== this._lastErrorLogged) this._log(`[lif] ${error}`);
    this._lastErrorLogged = error;
    const { lastScanAt, ...rest } = this.status();
    const sig = JSON.stringify(rest);
    if (sig === this._lastEmitted) return;
    this._lastEmitted = sig;
    try {
      this.emit('status', this.status());
    } catch (err) {
      this._note(`[lif] a status listener failed: ${err?.message ?? err}`);
    }
  }

  /** Forget everything about the output folder, so the next build compares every file with the disk again. */
  _forgetOutputs() {
    this._written.clear();
    this._builtFrom.clear();
    this._synth.clear();
    this._files.clear();
    this._outputKey = null;
  }

  /** @returns {Promise<number>} the delay before the next scan */
  async _scan() {
    const cfg = this._config();
    const lif = cfg.lif ?? {};
    const inputDir = String(lif.inputDir ?? '').trim();
    const outputDir = String(lif.outputDir ?? '').trim();
    const now = this.clock.now();
    this._lastScanAt = now;
    const refresh = now - this._lastRefresh >= this.refreshMs;
    if (refresh) this._lastRefresh = now;
    if (!lif.enabled) this._forgetOutputs();

    // A path that is not a full one (a UNC path that lost a backslash) points at a folder on this PC's own drive:
    // reading or writing there would look fine while every other program watches the real share.
    const inputProblem = inputDir ? fullPathProblem(inputDir, 'the FinishLynx folder', 'C:\\Lynx\\Meet') : null;
    if (!inputDir || inputProblem) {
      this._inputs.clear();
      this._pending.clear();
      this._changing.clear();
      this._inputKey = null;
      this._updateFinishers();
      if (!lif.enabled) this._setState('off');
      else this._setState('error', inputProblem ?? 'Choose the FinishLynx folder (where FinishLynx writes its .lif files) in Settings.');
      return this.pollMs;
    }

    const inputKey = lower(path.resolve(inputDir));
    if (inputKey !== this._inputKey) {
      this._inputs.clear();
      this._unsettled.clear();
      this._pending.clear();
      this._inputKey = inputKey;
    }
    // Read even with merging off: lynxStart() serves the gun-time button from these headers, and lynxFinishers()
    // tells the engine who has finished.
    let inputError = null;
    try {
      await this._readInputs(inputDir, refresh);
    } catch (err) {
      inputError = folderError('FinishLynx folder', inputDir, err);
      this._changing = new Set(); // nothing to wait for: the folder itself can't be read (its status says so)
    }
    this._updateFinishers();

    if (!lif.enabled) {
      this._setState('off');
      return inputError ? this.backoffMs : this.pollMs;
    }
    if (inputError) {
      this._setState('error', inputError);
      return this.backoffMs;
    }
    if (!outputDir) {
      this._setState('error', 'Choose a folder for the merged .lif files in Settings.');
      return this.pollMs;
    }
    const outputProblem = fullPathProblem(outputDir, 'the merged .lif folder', 'C:\\Lynx\\Merged');
    if (outputProblem) {
      this._forgetOutputs();
      this._setState('error', outputProblem);
      return this.pollMs;
    }
    // By name first (cheap), then by identity: \\localhost\C$\Lynx\Meet, a mapped drive or a second share of the same
    // folder all name the FinishLynx folder without looking like it.
    if (samePlaceOrInside(outputDir, inputDir) || (await this._guardCheck(inputDir, outputDir, refresh))) {
      this._forgetOutputs();
      this._setState('error', 'The merged .lif folder must not be the FinishLynx folder or a folder inside it. ' +
        `Pick a separate folder, for example one next to ${inputDir}.`);
      return this.pollMs;
    }

    const outputKey = lower(path.resolve(outputDir));
    if (outputKey !== this._outputKey) {
      this._forgetOutputs();
      this._outputKey = outputKey;
    }
    const folderProblem = await this._ensureOutputDir(outputDir);
    if (folderProblem) {
      this._setState('error', folderProblem);
      return this.backoffMs;
    }

    const failures = await this._produce(cfg, outputDir, !!lif.fillPlaces, refresh);
    if (failures.length > 0) this._setState('error', failures.join(' '));
    else if (this._files.size > 0) this._setState('ok');
    else this._setState('waiting', null, this._waitingText(inputDir));
    return this.pollMs;
  }

  /**
   * What 'waiting' means in words (DESIGN 9.16 F5): the FinishLynx folder is there and readable (a folder that is not
   * is an error, "not found: check the path"), but nothing in it can be used yet.
   * @param {string} inputDir
   */
  _waitingText(inputDir) {
    const writing = [...this._pending.values()].map((p) => p.name).sort();
    if (writing.length) {
      return `Waiting for FinishLynx to finish writing ${writing.length === 1 ? writing[0] : `${writing.length} .lif files`} ` +
        `in ${inputDir}.`;
    }
    return `No FinishLynx .lif files in ${inputDir} yet. They appear when FinishLynx saves a race; a race with splits and ` +
      'a gun time gets a merged file of its own before that.';
  }

  /**
   * Whether the output folder is the FinishLynx folder or inside it, by file-system identity (volume and file id)
   * rather than by name: the output folder and each folder above it is compared with the FinishLynx folder. Asked
   * again when either folder changes and at every full refresh (a share can be re-mapped); one stat per level, so a
   * deep path on a slow share is not checked every poll.
   * @returns {Promise<boolean>}
   */
  async _guardCheck(inputDir, outputDir, refresh) {
    const key = `${lower(path.resolve(inputDir))}|${lower(path.resolve(outputDir))}`;
    if (!refresh && this._guard.key === key) return this._guard.inside;
    let inside = false;
    let input = null;
    try {
      input = await this.fs.stat(inputDir, { bigint: true });
    } catch {
      input = null; // unreadable now: the next scan reports the FinishLynx folder itself
    }
    // A file system without file ids (all zero) cannot tell folders apart this way; the name check has to do.
    if (input && typeof input.ino === 'bigint' && input.ino !== 0n) {
      let p = path.resolve(outputDir);
      for (let depth = 0; depth < 128; depth++) {
        const st = await this.fs.stat(p, { bigint: true }).catch(() => null); // not there yet, or not ours to see
        if (st && st.ino === input.ino && st.dev === input.dev) {
          inside = true;
          break;
        }
        const parent = path.dirname(p);
        if (parent === p) break;
        p = parent;
      }
    }
    this._guard = { key, inside };
    return inside;
  }

  /**
   * Makes the output folder when it is missing, but only its last level: a typo in the middle of the path then shows
   * up as an error instead of a new folder tree nobody watches.
   * @returns {Promise<string | null>} what is wrong, or null when the folder is ready
   */
  async _ensureOutputDir(outputDir) {
    try {
      const st = await this.fs.stat(outputDir);
      return st.isDirectory() ? null : folderError('Merged .lif folder', outputDir, { code: 'ENOTDIR' });
    } catch (err) {
      if (err?.code !== 'ENOENT') return folderError('Merged .lif folder', outputDir, err);
    }
    const full = path.resolve(outputDir);
    const parent = path.dirname(full);
    try {
      const st = await this.fs.stat(parent);
      if (!st.isDirectory()) return `${parent} is a file, not a folder. Check the path of the merged .lif folder.`;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        return `The folder ${parent} does not exist, so Split Relay can't make the merged .lif folder ` +
          `${path.basename(full)} in it. Check the path for a typo. Split Relay only makes the last folder of the path.`;
      }
      return folderError('Merged .lif folder', parent, err);
    }
    try {
      await this.fs.mkdir(full);
      this._log(`[lif] made the merged .lif folder ${full}`);
    } catch (err) {
      if (err?.code !== 'EEXIST') return folderError('Merged .lif folder', outputDir, err);
    }
    return null;
  }

  /**
   * Re-reads who has finished in each race when its FinishLynx file (or which file matches it) changed, and emits
   * 'finishers' (raceId) for each race whose finishers are now different.
   */
  _updateFinishers() {
    const races = this._races();
    const changed = [];
    const ids = new Set();
    for (const race of races) {
      ids.add(race.id);
      const inp = this._lynxInput(race.id);
      const from = inp ? `${lower(inp.name)}|${inp.version}` : '';
      const known = this._finishers.get(race.id);
      if (known && known.from === from) continue;
      const { map, places } = inp ? finishersOf(inp.text) : { map: new Map(), places: new Map() };
      // the places are in it too: a made-up split of a finisher goes out with the finish place (9.17 P4)
      const sig = [...map].map(([b, t]) => `${b}:${t}:${places.get(b) ?? ''}`).sort().join(',');
      this._finishers.set(race.id, { from, map, places, sig });
      if ((known?.sig ?? '') !== sig) changed.push(race.id);
    }
    for (const id of [...this._finishers.keys()]) if (!ids.has(id)) this._finishers.delete(id);
    for (const id of changed) {
      try {
        this.emit('finishers', id);
      } catch (err) {
        this._note(`[lif] a finishers listener failed: ${err?.message ?? err}`);
      }
    }
  }

  /** Brings this._inputs up to date with the folder. Throws only when the folder itself cannot be listed. */
  async _readInputs(dir, force) {
    const entries = (await this.fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => /\.lif$/i.test(e.name) && !e.isDirectory());
    // In parallel: on a network share each stat is a round trip.
    const stats = await Promise.all(entries.map((e) => this.fs.stat(path.join(dir, e.name)).catch(() => null)));
    const present = new Set();
    const changed = [];
    // Files in the folder we have no usable version of yet. While FinishLynx is writing a race's first file, that
    // race must not get a made-up file under the same name: TrackScore would see the finishers come and go.
    const pending = new Map();
    this._pending = pending;
    const changing = new Set();
    this._changing = changing;
    for (const [i, e] of entries.entries()) {
      const st = stats[i];
      if (!st || !st.isFile()) continue; // gone between the listing and the stat: the next scan will know
      const key = lower(e.name);
      present.add(key);
      const sig = `${st.size}:${st.mtimeMs}`;
      const known = this._inputs.get(key);
      if (!force && known && !known.missing && known.sig === sig) continue;
      if (st.size === 0 || st.size > MAX_LIF_BYTES) {
        // empty: being rewritten from scratch, nothing in it to use yet
        if (st.size > 0) this._note(`[lif] ${e.name} is larger than 25 MB and is ignored`);
        else changing.add(key);
        if (!known || known.missing) pending.set(key, { name: e.name, header: null });
        continue;
      }
      changed.push({ name: e.name, key, sig, mtimeMs: st.mtimeMs });
    }

    // A file that vanished keeps its last contents: a writer that deletes and re-creates must not cost a race its
    // finishers for a scan, and the merged file must not fall back to a made-up one.
    for (const [key, inp] of this._inputs) if (!present.has(key)) inp.missing = true;
    for (const key of this._unsettled.keys()) if (!present.has(key)) this._unsettled.delete(key);
    if (changed.length === 0) return;

    const read = async (c) => {
      try {
        return await this.fs.readFile(path.join(dir, c.name));
      } catch {
        return null; // locked or gone: next scan
      }
    };
    // Everything changed is read, then read again settleMs later; only identical reads are used, because
    // FinishLynx may be half way through writing a file.
    const first = await Promise.all(changed.map(read));
    await this._sleep(this.settleMs);
    const second = await Promise.all(changed.map((c, i) => (first[i] ? read(c) : null)));
    const now = this.clock.now();

    changed.forEach((c, i) => {
      const a = first[i];
      const b = second[i];
      const known = this._inputs.get(c.key);
      const notYet = () => {
        changing.add(c.key);
        if (!known || known.missing) pending.set(c.key, { name: c.name, header: firstLineHeader(a) });
      };
      if (!a || !b || a.length === 0 || !a.equals(b)) return notYet();
      if (known && known.buf.equals(a)) {
        Object.assign(known, { sig: c.sig, mtimeMs: c.mtimeMs, missing: false });
        this._unsettled.delete(c.key);
        return;
      }
      if (!looksComplete(a)) {
        // Steady for staleMs without a final line break: believe it (not every .lif comes from FinishLynx).
        const u = this._unsettled.get(c.key);
        if (!u || u.sig !== c.sig) {
          this._unsettled.set(c.key, { sig: c.sig, since: now });
          return notYet();
        }
        if (now - u.since < this.staleMs) return notYet();
      }
      this._unsettled.delete(c.key);
      const text = decodeCp1252(a);
      this._inputs.set(c.key, { name: c.name, sig: c.sig, buf: a, text, header: parseLif(text).header,
        mtimeMs: c.mtimeMs, version: ++this._version, missing: false });
    });
  }

  /**
   * The race's crossings, or why there are none to use. The engine gives null while the race has no gun time:
   * writing the file then would take every split out of it (TrackScore's file watch, XC-Analytics and the web results
   * would lose them all) until a gun is set again, so the file is left as it is instead.
   * @returns {{ rd: RaceData } | { rd: null, note: string }}
   */
  _raceData(race) {
    try {
      const rd = this.getRaceData(race.id);
      if (rd) return { rd };
      return { rd: null, note: 'Not updated while the race has no gun time. Set the gun time to update it.' };
    } catch (err) {
      this._note(`[lif] no crossings available for ${race.name || race.id}: ${err?.message ?? err}`);
      return { rd: null, note: "Not updated: Split Relay could not get this race's splits (the details are in the log)." };
    }
  }

  /** Decides which outputs exist, rebuilds the ones that may have changed, writes those whose bytes differ.
   * @returns {Promise<string[]>} one message per output that could not be written */
  async _produce(cfg, outputDir, fillPlaces, refresh) {
    const races = Array.isArray(cfg.races) ? cfg.races.filter((r) => r && r.id) : [];
    const dirty = this._dirty;
    const allDirty = this._allDirty || refresh;
    this._dirty = new Set();
    this._allDirty = false;
    const isDirty = (id) => allDirty || dirty.has(id);

    const jobs = [];
    const claimed = new Set();
    const inputs = [...this._inputs.values()].sort(byName);
    // A present file beats a vanished one for the same race (FinishLynx renamed it).
    const matches = inputs.map((inp) => {
      const all = races.filter((r) => headerMatches(r, inp.header));
      if (all.length > 1) {
        // Settings refuse this now; an older settings file may still have it.
        this._note(`[lif] ${all.map((r) => `"${r.name || r.id}"`).join(' and ')} all use event ${eventLabel(all[0])}, ` +
          `so ${inp.name} is merged with "${all[0].name || all[0].id}" only. Give each race its own event, round or heat.`);
      }
      return all[0] ?? null;
    });
    const presentRaces = new Set();
    inputs.forEach((inp, i) => {
      if (!inp.missing && matches[i]) presentRaces.add(matches[i].id);
    });
    inputs.forEach((inp, i) => {
      const race = matches[i];
      if (inp.missing && (!race || presentRaces.has(race.id))) {
        this._inputs.delete(lower(inp.name));
        return;
      }
      if (race) {
        claimed.add(race.id);
        const key = `merge|${inp.version}|${JSON.stringify(race)}|${fillPlaces}`;
        jobs.push({ kind: 'merge', name: inp.name, race, inp, key });
      } else {
        jobs.push({ kind: 'copy', name: inp.name, race: null, inp, key: `copy|${inp.version}` });
      }
    });

    const taken = new Set(jobs.map((j) => lower(j.name)));
    const pendingNames = new Set();
    const pendingRaces = new Set();
    for (const p of this._pending.values()) {
      pendingNames.add(lower(p.name));
      const race = p.header && races.find((r) => headerMatches(r, p.header));
      if (race) pendingRaces.add(race.id);
    }
    for (const race of races) {
      if (claimed.has(race.id) || !String(race.eventNumber ?? '').trim()) continue; // no event number: no name either
      const name = lifFileName(race.eventNumber, race.round, race.heat);
      // FinishLynx is writing this race's file (or one by that name): do not start making one up now. One we
      // already made carries on until the real file can be read.
      if (!this._synth.has(lower(name)) && (pendingRaces.has(race.id) || pendingNames.has(lower(name)))) continue;
      if (taken.has(lower(name))) {
        this._note(`[lif] ${race.name || race.id}: ${name} is already another event's file, so this race gets no ` +
          'merged file until FinishLynx writes one for it');
        continue;
      }
      taken.add(lower(name));
      jobs.push({ kind: 'synth', name, race, inp: null, key: `synth|${JSON.stringify(race)}|${fillPlaces}` });
    }

    // A made-up file whose race now has a FinishLynx file under another name (or is gone) would sit there as a
    // stale duplicate, and TrackScore keeps watching the guessed name while it exists: remove it, if it still holds
    // our bytes.
    for (const key of [...this._synth.keys()]) {
      if (jobs.some((j) => j.kind === 'synth' && lower(j.name) === key)) continue;
      this._synth.delete(key);
      if (!taken.has(key)) await this._removeOurFile(outputDir, key);
    }

    const failures = [];
    for (const job of jobs) {
      const key = lower(job.name);
      const raceId = job.race?.id ?? null;
      if (this._builtFrom.get(key) === job.key && !(raceId !== null && isDirty(raceId)) && !refresh) continue;
      const built = this._build(job, fillPlaces);
      if (built.held || (built.plain && !(await this._holdsNoMoreSplits(outputDir, job.name, built.buf, refresh)))) {
        // No crossings to use right now (no gun time): the file keeps the splits it has. Asked again every scan, so
        // the file catches up as soon as the race has its gun time again.
        const prev = this._files.get(key);
        if (prev) this._files.set(key, { ...prev, note: built.note });
        if (raceId !== null) this._dirty.add(raceId);
        continue;
      }
      if (built.skip) {
        this._builtFrom.set(key, job.key); // a race without crossings yet: nothing to write
        this._files.delete(key);
        continue;
      }
      const entry = { name: job.name, ...built.info, writtenAt: this._files.get(key)?.writtenAt ?? null, error: null,
        note: built.plain ? built.note : null };
      try {
        if (await this._writeIfChanged(outputDir, job.name, built.buf, refresh)) {
          entry.writtenAt = this.clock.now();
          this._log(job.kind === 'copy'
            ? `[lif] copied ${job.name} (no race matches its event ${entry.eventNumber}-${entry.round}-${entry.heat})`
            : built.plain ? `[lif] copied ${job.name} as FinishLynx wrote it: ${job.race.name || raceId} has no gun time yet`
              : `[lif] wrote ${job.name}: ${entry.rows} rows, ${entry.splitsAdded} splits` +
                (job.kind === 'synth' ? ' (FinishLynx has no file for this race yet)' : ''));
        } else if (entry.writtenAt === null) {
          // Already up to date on disk, from before a restart or a change of folder: its own time is when it was
          // written, and "not yet" would suggest the merged files are not being made.
          const st = await this.fs.stat(path.join(outputDir, job.name)).catch(() => null);
          if (st) entry.writtenAt = Math.floor(Number(st.mtimeMs));
        }
        if (built.plain) {
          if (raceId !== null) this._dirty.add(raceId); // the real merge follows once the gun time is set
        } else this._builtFrom.set(key, job.key);
        if (job.kind === 'synth') this._synth.set(key, raceId);
      } catch (err) {
        entry.error = writeError(job.name, err);
        this._builtFrom.delete(key);
        if (raceId !== null) this._dirty.add(raceId);
      }
      this._files.set(key, entry);
    }

    const wanted = new Set(jobs.map((j) => lower(j.name)));
    for (const key of [...this._files.keys()]) if (!wanted.has(key)) this._files.delete(key);
    for (const f of this._files.values()) if (f.error) failures.push(`${f.error}.`);
    return failures;
  }

  /**
   * What one output file should hold now.
   * - { buf, info }: write these bytes. With `plain`, they are FinishLynx's own file because the race has no
   *   crossings to add right now; written only when that takes no split out of the file (see _holdsNoMoreSplits).
   * - { held, note }: leave the file as it is (no crossings to use, nothing of FinishLynx's to pass on).
   * - { skip }: a made-up file for a race without crossings yet: nothing to write.
   * @returns {{ buf?: Buffer, info?: object, skip?: boolean, held?: boolean, plain?: boolean, note?: string }}
   */
  _build(job, fillPlaces) {
    if (job.kind === 'copy') {
      const h = job.inp.header?.fields ?? [];
      return {
        buf: job.inp.buf,
        info: { eventNumber: h[0] ?? '', round: h[1] ?? '', heat: h[2] ?? '', raceId: null, raceName: h[3] ?? '',
          lynxName: lynxEventName(job.inp.header), rows: parseLif(job.inp.text).rows.length, splitsAdded: 0,
          copiedOnly: true, synthesized: false },
      };
    }
    const race = job.race;
    const info = (rows, splitsAdded) => ({
      eventNumber: String(race.eventNumber ?? ''), round: String(race.round ?? ''), heat: String(race.heat ?? ''),
      raceId: race.id, raceName: String(race.name ?? ''), lynxName: job.inp ? lynxEventName(job.inp.header) : null,
      rows, splitsAdded, copiedOnly: false, synthesized: job.kind === 'synth' });
    const got = this._raceData(race);
    if (!got.rd) {
      // FinishLynx's finishes still reach the programs watching this folder while the race has no gun time; only
      // the splits wait for it.
      if (job.kind === 'merge') {
        return { buf: job.inp.buf, info: info(parseLif(job.inp.text).rows.length, 0), plain: true, note: got.note };
      }
      return { held: true, note: got.note };
    }
    const rd = got.rd;
    const key = lower(job.name);
    if (job.kind === 'synth' && !this._synth.has(key) && relayRunners(rd.runners, rd.splitCount ?? 0).size === 0) {
      return { skip: true };
    }
    const m = mergeDetailed({ lynxText: job.inp ? job.inp.text : null, race, gunTicks: rd.gun ?? null,
      splitCount: rd.splitCount, runners: rd.runners, fillPlaces });
    return { buf: encodeCp1252(m.text), info: info(m.rows, m.splitsAdded) };
  }

  /**
   * Whether replacing the output file with `next` takes no split out of it: true when there is no file yet, or the
   * one there has no more split entries than `next` (FinishLynx's own file, laps = 1, has none). A file that holds
   * the relay's splits is left alone until the race has crossings to merge again.
   */
  async _holdsNoMoreSplits(outputDir, name, next, verify) {
    const key = lower(name);
    let current = verify ? null : this._written.get(key)?.buf ?? null;
    if (!current) {
      current = await this.fs.readFile(path.join(outputDir, name)).catch(() => null);
      if (!current) return true;
      this._written.set(key, { name, buf: current });
    }
    return current.equals(next) || this._splitEntries(current) <= this._splitEntries(next);
  }

  /** Split entries in a .lif file's bytes: field-10 entries other than a finisher's finish entry. Remembered per
   * buffer, because a file held back is looked at again every scan. */
  _splitEntries(buf) {
    let n = this._splitCounts.get(buf);
    if (n !== undefined) return n;
    n = 0;
    for (const row of parseLif(decodeCp1252(buf)).rows) {
      const entries = String(row.fields[F_SPLITS] ?? '').split(',').filter((e) => e.trim()).length;
      n += Math.max(0, entries - (parseRaceTime(row.time) !== null ? 1 : 0));
    }
    this._splitCounts.set(buf, n);
    return n;
  }

  /** Deletes an output only when it still holds exactly what we last wrote there. */
  async _removeOurFile(outputDir, key) {
    const ours = this._written.get(key);
    this._written.delete(key);
    this._builtFrom.delete(key);
    this._files.delete(key);
    if (!ours) return;
    const file = path.join(outputDir, ours.name);
    try {
      if ((await this.fs.readFile(file)).equals(ours.buf)) {
        await this.fs.unlink(file);
        this._log(`[lif] removed ${ours.name}: it was made up for a race that now has its own FinishLynx file ` +
          '(or no longer exists)');
      }
    } catch {
      // already gone, or unreadable: leave it
    }
  }

  /**
   * @param {boolean} verify compare with the disk rather than with what we believe is there (someone may have
   *   deleted or edited the file)
   * @returns {Promise<boolean>} true when written, false when the file already held these bytes
   */
  async _writeIfChanged(outputDir, name, buf, verify) {
    const key = lower(name);
    const dest = path.join(outputDir, name);
    let known = verify ? null : this._written.get(key)?.buf;
    if (!known) {
      try {
        known = await this.fs.readFile(dest); // after a restart, an identical file is left alone
      } catch {
        known = null;
      }
    }
    if (known && known.equals(buf)) {
      this._written.set(key, { name, buf: known });
      return false;
    }
    await this._writeAtomic(dest, buf);
    this._written.set(key, { name, buf });
    return true;
  }

  /** Temp file beside the target (a rename cannot cross volumes), then rename over it. While a reader has the target
   * open Windows refuses the rename, so that is retried. The temp name does not end in .lif, so no watcher takes it. */
  async _writeAtomic(dest, buf) {
    const tmp = `${dest}.~${process.pid}-${++this._tmpSeq}.tmp`;
    try {
      await this.fs.writeFile(tmp, buf);
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => {}); // a share that dropped mid-write leaves half a file
      throw err;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await this.fs.rename(tmp, dest);
        return;
      } catch (err) {
        if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= this.renameRetries) {
          await this.fs.unlink(tmp).catch(() => {});
          throw err;
        }
        await this._sleep(this.renameRetryMs);
      }
    }
  }
}
