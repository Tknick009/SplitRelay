// The settings file (data\config.json) and every change the control panel can make to it. Changes are built on a copy
// and validated before they replace the live config, so a rejected edit leaves nothing half-applied; error messages
// are written for the timer at the laptop, not for a programmer. A file that was hand-edited or damaged is repaired
// (missing fields filled, ids made) rather than refused, because Split Relay must start on race day.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { COLUMN_TYPES, DEFAULT_INPUT_FORMAT } from './input.js';
import { parseGun, matchKey, eventKey as eventKeyOf } from './engine.js';
import { parseRaceTime } from './timefmt.js';
import { writeFileAtomic, fileStamp } from './store.js';
import { fullPathProblem } from './lif.js';

export const CONFIG_VERSION = 1;
export const DEFAULT_INPUT_PORT = 5565;
export const DEFAULT_PANEL_PORT = 5590;
export const OUTPUT_MODES = Object.freeze(['tcp-client', 'tcp-server', 'udp']);
/** The most splits a settings file keeps per race: a hand-edited file is never cut shorter than this. */
const MAX_SPLITS = 50;
/**
 * The most splits the panel and the API set (DESIGN 9.15 L5: the panel's "Number of splits" goes from 1 to 20). An edit
 * that leaves the splits alone is not checked, so a race from an older file can still be renamed or paused.
 */
export const MAX_SPLITS_SET = 20;
/** One RR12 exporter per port; a meet with more overlapping races than this is not a thing. */
export const MAX_INPUT_PORTS = 10;
// Below 1024 Windows keeps the ports for its own services, and a typo there ("556") is the usual way to get one.
const MIN_INPUT_PORT = 1024;
/** TrackScore's web page (its PORT, else 5000): where "Set up from TrackScore" reads the meet's Race Setup. */
export const DEFAULT_TRACKSCORE_WEB_PORT = 5000;
/** The longest meet name: it becomes a file name in data\meets (DESIGN 9.22 M2). */
export const MAX_MEET_NAME = 80;

const COLUMN_LABELS = {
  location: 'Timing point name', bib: 'Bib', time: 'Time of day', contest: 'Contest', first: 'First name',
  last: 'Last name', team: 'Team / club', gender: 'Gender', ignore: 'Ignore',
};

/**
 * A change the operator asked for that cannot be made; `message` is one or more plain-English sentences.
 * `status` is the HTTP status the control panel answers with.
 */
export class ConfigError extends Error {
  /** @param {string | string[]} messages @param {number} [status] */
  constructor(messages, status = 400) {
    const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
    super(list.join(' '));
    this.name = 'ConfigError';
    this.errors = list;
    this.status = status;
  }
}

/**
 * A new id: 'r_' races, 's_' splits, 'o_' outputs. Lower case only, so two ids can never become the same file name on
 * Windows' case-insensitive disks.
 * @param {'r_'|'s_'|'o_'} prefix
 */
export function newId(prefix) {
  return prefix + crypto.randomBytes(5).toString('hex');
}

/**
 * A fresh config: no races and no outputs, because the panel walks the operator through adding them.
 * @returns {any}
 */
export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    // ports: one listener each; RR12 sends each overlapping race through its own exporter to its own port (9.15 L2)
    input: { ports: [DEFAULT_INPUT_PORT], delimiter: DEFAULT_INPUT_FORMAT.delimiter, tag: DEFAULT_INPUT_FORMAT.tag,
      columns: [...DEFAULT_INPUT_FORMAT.columns] },
    // startIgnoreSec: reads this soon after the gun are runners leaving the start (over the finish mats), not splits
    filter: { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 60 },
    names: { pplPath: '' },
    lif: { enabled: false, inputDir: '', outputDir: '', fillPlaces: false },
    panel: { port: DEFAULT_PANEL_PORT, allowLan: false },
    // the meet (DESIGN 9.22): its name (the meet file's name), and where TrackScore's web page is for "Set up from
    // TrackScore" (the host is the TrackScore output's)
    meet: { name: '', trackScoreWebPort: DEFAULT_TRACKSCORE_WEB_PORT },
    races: [],
    outputs: [],
  };
}

/**
 * A new race's fields before the operator's values go on top (DESIGN.md section 3). inputPort: the RR12 input port
 * whose reads it takes (null = none: by contest only); addRace gives a new race the first input port (9.15 L3).
 */
export function defaultRace() {
  return {
    id: '', name: '', eventNumber: '', round: '1', heat: '1', distance: '', contests: [], inputPort: null, gun: '',
    splits: [], finishSources: [], active: true,
  };
}

/** A new output's fields: TrackScore XC on this PC, the most common first output. */
export function defaultOutput() {
  return {
    id: '', name: '', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: 5555, script: '', stage: 'results',
    races: [], eventNumber: 'race', precision: 3, mid: '',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v)).trim();
const clone = (v) => structuredClone(v);

/** `"C:\Lynx\XCScore.lss"` as Explorer's "Copy as path" gives it -> without the quotes. */
function cleanPath(v) {
  const p = text(v);
  return p.length >= 2 && p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).trim() : p;
}

/** Names matched the way the engine matches them, so the duplicate checks agree with what the engine would do. */
function uniqueTexts(v) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(v) ? v : []) {
    const t = text(item);
    const k = matchKey(t);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** A whole number from a form field or JSON ("5565", 5565), or null. */
function wholeNumber(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = text(v);
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
}

/** Seconds from a form field ("2,5" on a European keyboard works too), or null. */
function seconds(v) {
  // a negative number of seconds is never a setting (the text form already refuses a minus sign)
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const s = text(v).replace(',', '.');
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

function bool(v, dflt) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return dflt;
}

/** Usable as an id: kept as written so crossings saved under it stay linked. */
function usableId(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 100 && !/[\x00-\x1f\x7f]/.test(s) ? s : '';
}

function insideOrSame(child, parent) {
  const c = path.resolve(child).replace(/[\\/]+$/, '').toLowerCase();
  const p = path.resolve(parent).replace(/[\\/]+$/, '').toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/** "003" and "3" are the same event to FinishLynx and to the .lif file names; round and heat default to 1. */
function eventKey(race) {
  return eventKeyOf(race.eventNumber, race.round, race.heat);
}

/** A race's input port (number) or null. */
function portOf(race) {
  return Number.isInteger(race?.inputPort) ? race.inputPort : null;
}

/**
 * Whether a race takes every contest that no race lists (DESIGN 9.2): it lists no contest and takes no port. A race
 * with a port takes that port's reads, not everything (9.15 L3), so two LapTime races on two ports are no clash.
 * @param {any} race
 */
export function takesEveryContest(race) {
  return !(race?.contests ?? []).length && portOf(race) === null;
}

/**
 * Why two races can't both be Active: they would want the same reads (DESIGN 9.15 L3, V1). The engine would give them
 * to the first, so the second would get nothing without a word.
 * @param {any} a
 * @param {any} b
 * @returns {{ kind: 'every'|'port'|'contest'|'event', port?: number, contest?: string, event?: string }[]}
 */
export function raceClashes(a, b) {
  const out = [];
  if (takesEveryContest(a) && takesEveryContest(b)) out.push({ kind: 'every' });
  const p = portOf(a);
  if (p !== null && p === portOf(b)) out.push({ kind: 'port', port: p });
  const theirs = new Set((b?.contests ?? []).map(matchKey));
  for (const c of a?.contests ?? []) if (theirs.has(matchKey(c))) out.push({ kind: 'contest', contest: text(c) });
  const ek = eventKey(a);
  if (ek && ek === eventKey(b)) out.push({ kind: 'event', event: ek });
  return out;
}

/** "both take port 5565", "both list contest 'Girls'", ... for the warnings and the activate answer. */
function clashText(clashes) {
  return clashes.map((c) => (c.kind === 'every' ? 'both take every contest'
    : c.kind === 'port' ? `both take port ${c.port}`
      : c.kind === 'contest' ? `both list contest '${c.contest}'` : `both use Event ${c.event}`)).join(', and ');
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation: fill missing fields and repair what can be repaired. Never throws.

/**
 * The input ports: `ports` as written, else the single `port` of a settings file from before revision 7, else 5565.
 * Unusable entries and repeats are dropped, so a hand edit can never stop Split Relay from listening at all.
 */
function normalizePorts(r) {
  const out = [];
  for (const v of Array.isArray(r.ports) ? r.ports : []) {
    const n = wholeNumber(v);
    if (validPort(n) && !out.includes(n)) out.push(n);
  }
  if (!out.length) {
    const port = wholeNumber(r.port);
    out.push(validPort(port) ? port : DEFAULT_INPUT_PORT);
  }
  return out.slice(0, MAX_INPUT_PORTS);
}

/** @param {any} raw */
function normalizeInput(raw) {
  const d = defaultConfig().input;
  const r = isObj(raw) ? raw : {};
  let delimiter = typeof r.delimiter === 'string' ? r.delimiter : d.delimiter;
  if (!delimiter || /[\r\n\t"]/.test(delimiter)) delimiter = d.delimiter;
  const columns = Array.isArray(r.columns) && r.columns.length
    ? r.columns.map((c) => (COLUMN_TYPES.includes(text(c).toLowerCase()) ? text(c).toLowerCase() : 'ignore'))
    : d.columns;
  return {
    ports: normalizePorts(r),
    delimiter,
    // as in input.js: a missing tag means the default; null or '' means the lines carry no tag
    tag: r.tag === undefined ? d.tag : text(r.tag).replace(/["\x00-\x1f\x7f]/g, ''),
    columns,
  };
}

/** @param {any} raw */
function normalizeFilter(raw) {
  const d = defaultConfig().filter;
  const r = isObj(raw) ? raw : {};
  const w = seconds(r.tagWindowSec);
  const h = seconds(r.holdSec);
  const a = seconds(r.startIgnoreSec);
  return {
    tagWindowSec: w !== null && w <= 600 ? w : d.tagWindowSec,
    holdSec: h !== null && h <= 60 ? h : d.holdSec,
    startIgnoreSec: a !== null && a <= 1800 ? a : d.startIgnoreSec,
  };
}

/** @param {any} raw */
function normalizeNames(raw) {
  return { pplPath: cleanPath(isObj(raw) ? raw.pplPath : '') };
}

/** @param {any} raw */
function normalizeLif(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    enabled: bool(r.enabled, false), inputDir: cleanPath(r.inputDir), outputDir: cleanPath(r.outputDir),
    fillPlaces: bool(r.fillPlaces, false),
  };
}

/** @param {any} raw */
function normalizePanel(raw) {
  const r = isObj(raw) ? raw : {};
  const port = wholeNumber(r.port);
  return { port: validPort(port) ? port : DEFAULT_PANEL_PORT, allowLan: bool(r.allowLan, false) };
}

/** @param {any} raw */
function normalizeMeet(raw) {
  const r = isObj(raw) ? raw : {};
  const port = wholeNumber(r.trackScoreWebPort);
  return {
    name: text(r.name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_MEET_NAME).trim(),
    trackScoreWebPort: validPort(port) ? port : DEFAULT_TRACKSCORE_WEB_PORT,
  };
}

/**
 * 9.25, the start lists: what happens to an athlete a start list enters in another race than the one that reads them:
 * 'keep' (kept off the boards: the default) or 'send' (sent as any runner, and flagged). Stored only when it is 'send'.
 * @param {any} raw
 */
function normalizeEntries(raw) {
  const r = isObj(raw) ? raw : {};
  return { otherRace: r.otherRace === 'send' ? 'send' : 'keep' };
}

/**
 * @param {any} raw
 * @param {Set<string>} usedIds ids already taken in this config (races, splits and outputs share one namespace)
 * @param {number} index for a name when the race has none
 * @param {string[]} notes repairs worth telling the operator about
 */
function normalizeRace(raw, usedIds, index, notes) {
  const r = isObj(raw) ? raw : {};
  const d = defaultRace();
  let id = usableId(r.id);
  if (!id || usedIds.has(id)) id = freshId('r_', usedIds);
  usedIds.add(id);
  const name = text(r.name) || `Race ${index + 1}`;
  let gun = '';
  if (text(r.gun)) {
    try {
      gun = parseGun(r.gun).gun;
    } catch {
      notes.push(`The gun time "${text(r.gun)}" of ${name} could not be read, so it was cleared. Set it again.`);
    }
  }
  const splits = (Array.isArray(r.splits) ? r.splits : []).filter(isObj).slice(0, MAX_SPLITS).map((s, i) => {
    let sid = usableId(s.id);
    if (!sid || usedIds.has(sid)) sid = freshId('s_', usedIds);
    usedIds.add(sid);
    const sname = text(s.name) || `Split ${i + 1}`;
    // earliest: the race time before which a pass can't be this split (9.15 L4); '' = none
    let earliest = text(s.earliest);
    if (earliest && earliestTicks(earliest) === null) {
      notes.push(`The earliest time "${earliest}" of ${name} ${sname} could not be read, so it was cleared.`);
      earliest = '';
    }
    // collectOnly (9.26): a split point that is counted but not sent (a mat a little after a K marker): it takes passes
    // like any split, so the later passes land in their own splits, and nothing of it goes to an output or the merged
    // .lif. Kept in the settings only when it is set: absent = sent, as every split was before. It is not the Pause.
    const collectOnly = bool(s.collectOnly, false);
    // sending: false = paused by the operator (9.17 P1): its crossings are kept and shown, but not sent. A split that is
    // not sent has nothing to pause.
    return { id: sid, name: sname, sources: uniqueTexts(s.sources), earliest, sending: collectOnly ? true : bool(s.sending, true),
      ...(collectOnly ? { collectOnly: true } : {}) };
  });
  return {
    id,
    name,
    eventNumber: r.eventNumber === undefined || r.eventNumber === null ? d.eventNumber : text(r.eventNumber),
    round: r.round === undefined || r.round === null ? d.round : text(r.round),
    heat: r.heat === undefined || r.heat === null ? d.heat : text(r.heat),
    distance: text(r.distance),
    contests: uniqueTexts(r.contests),
    // a settings file from before revision 7 has none: by contest only, exactly as the race worked then
    inputPort: inputPortOf(r.inputPort),
    gun,
    splits,
    finishSources: uniqueTexts(r.finishSources),
    active: bool(r.active, true),
  };
}

/** @param {any} raw @param {Set<string>} usedIds @param {number} index */
function normalizeOutput(raw, usedIds, index) {
  const r = isObj(raw) ? raw : {};
  const d = defaultOutput();
  let id = usableId(r.id);
  if (!id || usedIds.has(id)) id = freshId('o_', usedIds);
  usedIds.add(id);
  const mode = OUTPUT_MODES.includes(text(r.mode).toLowerCase()) ? text(r.mode).toLowerCase() : d.mode;
  const port = wholeNumber(r.port);
  const precision = wholeNumber(r.precision);
  return {
    id,
    name: text(r.name) || `Output ${index + 1}`,
    enabled: bool(r.enabled, true),
    mode,
    host: text(r.host) || (mode === 'tcp-server' ? '0.0.0.0' : d.host),
    port: port !== null && port <= 65535 ? port : d.port,
    script: cleanPath(r.script),
    stage: text(r.stage).toLowerCase() === 'started' ? 'started' : 'results',
    races: [...new Set((Array.isArray(r.races) ? r.races : []).map(usableId).filter(Boolean))],
    eventNumber: r.eventNumber === 'blank' ? 'blank' : 'race',
    precision: precision === 1 || precision === 2 || precision === 3 ? precision : d.precision,
    mid: text(r.mid),
    // DESIGN 9.24: "Send a clearing line when a split is taken back" (the runner's row with an empty time and place, for
    // a receiver that can blank a cell). Off for every output unless ticked: kept in the settings only when on
    ...(bool(r.clearLines, false) ? { clearLines: true } : {}),
  };
}

/** A race's inputPort as stored: a port number, or null (none; also for anything unusable). */
function inputPortOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = wholeNumber(v);
  return validPort(n) ? n : null;
}

/**
 * A split's earliest time ("8:00", "8:00.5", "1:02:03") in ticks of race time, or null. Minutes and seconds only, as
 * the panel asks for them: a bare "8" could be 8 seconds or 8 minutes, and a wrong guess shifts every later split.
 */
function earliestTicks(v) {
  const s = text(v);
  if (!/^(?:\d+:)?\d+:\d{2}(?:[.,]\d+)?$/.test(s)) return null;
  const t = parseRaceTime(s);
  return t !== null && t >= 0 ? t : null;
}

function freshId(prefix, usedIds) {
  let id;
  do id = newId(prefix); while (usedIds.has(id));
  return id;
}

/**
 * Any parsed config.json (or nothing) -> a complete Config. Unknown fields are dropped, missing ones filled, bad
 * values replaced by defaults, missing or duplicated ids generated.
 * @param {any} raw
 * @returns {{ config: any, notes: string[] }} notes: repairs the operator should hear about
 */
export function normalizeConfig(raw) {
  const r = isObj(raw) ? raw : {};
  const notes = [];
  const used = new Set();
  const races = (Array.isArray(r.races) ? r.races : []).filter(isObj).map((x, i) => normalizeRace(x, used, i, notes));
  const outputs = (Array.isArray(r.outputs) ? r.outputs : []).filter(isObj).map((x, i) => normalizeOutput(x, used, i));
  return {
    config: {
      version: CONFIG_VERSION,
      input: normalizeInput(r.input),
      filter: normalizeFilter(r.filter),
      names: normalizeNames(r.names),
      lif: normalizeLif(r.lif),
      panel: normalizePanel(r.panel),
      meet: normalizeMeet(r.meet),
      ...(normalizeEntries(r.entries).otherRace === 'send' ? { entries: { otherRace: 'send' } } : {}),
      races,
      outputs,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation: what an edit from the panel must satisfy. Each returns plain-English sentences, [] when fine.

function checkPort(v, what) {
  const n = wholeNumber(v);
  return validPort(n) ? null : `${what} must be a whole number from 1 to 65535.`;
}

/**
 * A path must be a full one: a drive letter (C:\...) or a network path (\\server\share\...). '\192.168.0.5\Lynx' (one
 * backslash lost) would otherwise be taken as a folder on this PC's own drive, created there, and reported as fine
 * while every other program watches the real share.
 */
function checkFolder(v, what, example) {
  return fullPathProblem(cleanPath(v), what, example);
}

/** @param {any} input */
function validateInput(input) {
  const errs = [];
  const r = isObj(input) ? input : {};
  errs.push(...validateInputPorts(r.ports));
  if (typeof r.delimiter !== 'string' || r.delimiter === '') errs.push('Type the separator RR12 puts between fields (usually |).');
  else if (/[\r\n\t"]/.test(r.delimiter)) errs.push("The separator can't be a line break, a tab or a double quote. Use | (recommended).");
  if (r.tag !== undefined && r.tag !== null && typeof r.tag !== 'string') errs.push('The tag must be text, for example SR.');
  else if (typeof r.tag === 'string' && /["\x00-\x1f\x7f]/.test(r.tag)) errs.push("The tag can't contain double quotes or control characters.");
  if (!Array.isArray(r.columns) || r.columns.length === 0) {
    errs.push('The column order is empty. Use Timing point name, Bib, Time of day, Contest, First name, Last name, Team, Gender.');
  } else {
    const count = new Map();
    for (const c of r.columns) {
      const k = text(c).toLowerCase();
      if (!COLUMN_TYPES.includes(k)) {
        errs.push(`"${text(c)}" is not a column Split Relay knows. Use one of: ${COLUMN_TYPES.join(', ')}.`);
        continue;
      }
      if (k !== 'ignore') count.set(k, (count.get(k) ?? 0) + 1);
    }
    for (const need of ['location', 'bib', 'time']) {
      if (!count.has(need)) errs.push(`Add a "${COLUMN_LABELS[need]}" column. Split Relay can't work without it.`);
    }
    for (const [k, n] of count) if (n > 1) errs.push(`"${COLUMN_LABELS[k]}" is in the column order ${n} times. Keep one.`);
  }
  return errs;
}

/** The RR12 input ports as the panel sends them (DESIGN 9.15 L2). */
function validateInputPorts(ports) {
  if (!Array.isArray(ports) || !ports.length) return ['Keep at least one RR12 input port (5565 is the usual one).'];
  const errs = [];
  const seen = new Set();
  for (const v of ports) {
    const n = wholeNumber(v);
    if (n === null || n < MIN_INPUT_PORT || n > 65535) {
      errs.push(`"${text(v)}" can't be an RR12 input port: use a whole number from ${MIN_INPUT_PORT} to 65535, for example 5565.`);
    } else if (seen.has(n)) {
      errs.push(`Port ${n} is in the list of RR12 input ports twice. List each port once.`);
    } else seen.add(n);
  }
  if (ports.length > MAX_INPUT_PORTS) errs.push(`Split Relay listens on at most ${MAX_INPUT_PORTS} RR12 input ports.`);
  return errs;
}

/** @param {any} filter */
function validateFilter(filter) {
  const errs = [];
  const r = isObj(filter) ? filter : {};
  const w = seconds(r.tagWindowSec);
  if (w === null || w > 600) errs.push('The tag filter window must be a number of seconds from 0 to 600.');
  const h = seconds(r.holdSec);
  if (h === null || h > 60) errs.push('The hold must be a number of seconds from 0 to 60.');
  // missing in a settings file from before it existed: the default applies
  if (r.startIgnoreSec !== undefined) {
    const a = seconds(r.startIgnoreSec);
    if (a === null || a > 1800) errs.push('"Ignore reads in the first … s" must be a number of seconds from 0 to 1800 (0 = off).');
  }
  return errs;
}

/** @param {any} names */
function validateNames(names) {
  const e = checkFolder(isObj(names) ? names.pplPath : '', 'the names file', 'C:\\Lynx\\Lynx.ppl');
  return e ? [e] : [];
}

/** @param {any} lif */
function validateLif(lif) {
  const errs = [];
  const r = isObj(lif) ? lif : {};
  const inputDir = cleanPath(r.inputDir);
  const outputDir = cleanPath(r.outputDir);
  const inErr = checkFolder(inputDir, 'the FinishLynx folder', 'C:\\Lynx\\Meet or \\\\192.168.0.5\\Lynx\\Meet');
  const outErr = checkFolder(outputDir, 'the merged .lif folder', 'C:\\Lynx\\Merged');
  if (inErr) errs.push(inErr);
  if (outErr) errs.push(outErr);
  if (bool(r.enabled, false)) {
    if (!inputDir) errs.push('Choose the FinishLynx folder (where FinishLynx writes its .lif files).');
    if (!outputDir) errs.push('Choose a folder for the merged .lif files.');
  }
  if (!inErr && !outErr && inputDir && outputDir && insideOrSame(outputDir, inputDir)) {
    errs.push("The merged .lif folder can't be the FinishLynx folder or a folder inside it: Split Relay never writes " +
      'where FinishLynx writes. Pick a separate folder, for example one next to it.');
  }
  return errs;
}

/** @param {any} panel */
function validatePanel(panel) {
  const e = checkPort(isObj(panel) ? panel.port : undefined, 'The control panel port');
  return e ? [e] : [];
}

/** @param {any} meet */
function validateMeet(meet) {
  const errs = [];
  const r = isObj(meet) ? meet : {};
  if (text(r.name).length > MAX_MEET_NAME) errs.push(`Keep the meet name to ${MAX_MEET_NAME} characters.`);
  const e = checkPort(r.trackScoreWebPort, "TrackScore's web port");
  if (e) errs.push(e);
  return errs;
}

/**
 * TrackScore's timing listeners (its timing-ports.ts: 4554-4569, 5555 the XC splits, 5556 the clock). An HTTP request
 * sent there would be read as timing data by a live TrackScore.
 */
export const TRACKSCORE_TIMING_PORTS = Object.freeze([...Array.from({ length: 16 }, (_, i) => 4554 + i), 5555, 5556]);

/**
 * Why `port` can't be TrackScore's web page (DESIGN 9.22 M8), or null. "Set up from TrackScore" sends HTTP GETs there,
 * and a GET into a port that takes timing data would feed its request lines into that program: TrackScore's timing
 * ports, any output's port (Karmarush's live results would ingest it), this Split Relay's RR12 ports (logged as bad
 * reads) and its control panel. Settings refuses such a port with the same words as the read itself.
 * @param {any} config
 * @param {number} port
 * @param {{ panelPort?: number|null, listening?: number[] }} [live] the ports really in use (--port, a test's port 0)
 * @returns {string|null} the first sentence; the caller says where to change it
 */
export function webPortProblem(config, port, { panelPort = null, listening = [] } = {}) {
  if (port === 5555) return 'Port 5555 is where TrackScore takes the splits, not its web page.';
  if (port === 5556) return "Port 5556 is TrackScore's clock port, not its web page.";
  if (TRACKSCORE_TIMING_PORTS.includes(port)) return `Port ${port} is one of TrackScore's timing ports, not its web page.`;
  const out = (config?.outputs ?? []).find((o) => o.port === port);
  if (out) return `Port ${port} is where the output "${out.name}" sends its splits, not TrackScore's web page.`;
  if (inputPorts(config).includes(port) || listening.includes(port)) {
    return `Port ${port} is an RR12 input port of this Split Relay, not TrackScore's web page.`;
  }
  if (port === wholeNumber(config?.panel?.port) || (panelPort !== null && port === panelPort)) {
    return `Port ${port} is this Split Relay's control panel, not TrackScore's web page.`;
  }
  return null;
}

/** An output's host that is this PC: its port there is taken by the program the output sends to. */
const THIS_PC_HOST = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|\[::1\]|0\.0\.0\.0|)$/i;

/**
 * Whether an output's host is this PC: a loopback address, localhost, none, or one of `names` (this PC's computer name
 * and network addresses, where the caller knows them).
 * @param {unknown} host
 * @param {unknown[]} [names]
 */
export function isThisPcHost(host, names = []) {
  const h = text(host).toLowerCase();
  return THIS_PC_HOST.test(h) || (Array.isArray(names) && names.some((n) => text(n) && text(n).toLowerCase() === h));
}

/**
 * The output that sends its splits to `port` on this PC (a TCP client or UDP output), or undefined: RR12 can't send
 * to Split Relay on that port, and Split Relay listening there would read its own splits back as reads.
 * @param {any[]} outputs
 * @param {number} port
 * @param {unknown[]} [names] this PC's computer name and addresses (isThisPcHost)
 */
export function outputOnThisPcPort(outputs, port, names = []) {
  return (outputs ?? []).find((o) => o.port === port && o.mode !== 'tcp-server' && isThisPcHost(o.host, names));
}

/**
 * Why `port` can't become an RR12 input port (DESIGN 9.22 R18), or null: one of TrackScore's timing ports (a TrackScore
 * started later could not take its splits there, or would hand them to Split Relay), or a port an output sends to on
 * this PC (Split Relay would take that program's port, or read its own splits back as reads). Only a port being added
 * is checked, so a setup that has one still starts. The panel's Inputs page checks the same (public/app.js).
 * @param {any} config
 * @param {number} port
 * @param {{ names?: unknown[] }} [opts] names: this PC's computer name and addresses (a meet load knows them)
 * @returns {string|null}
 */
export function inputPortProblem(config, port, { names = [] } = {}) {
  if (!Number.isInteger(port)) return null;
  if (port === 5555) return "Port 5555 is where TrackScore takes the splits: Split Relay can't listen for RR12 there.";
  if (TRACKSCORE_TIMING_PORTS.includes(port)) return `Port ${port} is one of TrackScore's timing ports: Split Relay can't listen for RR12 there.`;
  if (port === wholeNumber(config?.meet?.trackScoreWebPort ?? DEFAULT_TRACKSCORE_WEB_PORT)) {
    return `Port ${port} is TrackScore's web page (Settings → Meet setup): Split Relay can't listen for RR12 there.`;
  }
  const out = outputOnThisPcPort(config?.outputs, port, names);
  if (out) return `Port ${port} is where the output "${out.name}" sends its splits on this PC: RR12 can't send to Split Relay there too.`;
  return null;
}

/** Checks that involve more than one section or item. */
function validatePorts(config) {
  const errs = [];
  const panelPort = wholeNumber(config.panel?.port);
  if (panelPort !== null && inputPorts(config).includes(panelPort)) {
    errs.push(`The RR12 input port and the control panel port are both ${panelPort}. Use two different ports.`);
  }
  return errs;
}

/** The meet's TrackScore web port against every other port in the settings (R8). */
function validateWebPort(config) {
  const web = wholeNumber(config.meet?.trackScoreWebPort);
  const why = web !== null ? webPortProblem(config, web) : null;
  return why ? [`${why} TrackScore's web page is usually on port ${DEFAULT_TRACKSCORE_WEB_PORT}.`] : [];
}

/**
 * The RR12 input ports of a config, in its order.
 * @param {any} config
 * @returns {number[]}
 */
export function inputPorts(config) {
  const p = config?.input?.ports;
  return Array.isArray(p) ? p.filter((n) => Number.isInteger(n)) : [];
}

/**
 * 9.26: why a race can't have every split set to "Not sent", in the operator's words (the race editor says the same
 * before a save: public/app.js).
 * @param {unknown} name the race's name
 */
export function allNotSentText(name) {
  return `Every split of ${text(name) || 'this race'} is set to Not sent, so nothing would go to TrackScore or Karmarush. ` +
    'Switch Send on for at least one split.';
}

/**
 * The splits of a race that are sent (9.26: not the ones that are counted only), in course order: what TrackScore and
 * Karmarush are set up with, and what the laps to go count.
 * @param {any} race
 * @returns {any[]}
 */
export function sentSplits(race) {
  return (Array.isArray(race?.splits) ? race.splits : []).filter((s) => s && s.collectOnly !== true);
}

/**
 * @param {any} config the whole config the race would be part of
 * @param {any} race normalised race
 * @param {{ checkEvent?: boolean, checkPort?: boolean }} [opts] checkEvent: false for an edit that leaves the event,
 *   round and heat as they were, so a settings file from before this check can still have a race paused or renamed.
 *   checkPort: whether the race's inputPort must be one of the RR12 input ports (a new race, a port chosen, a race made
 *   Active); a race that is not Active may keep a port that was removed since, so it can still be renamed.
 *   activating: the race is made Active by this change: then it may not share its event with an Active race even when
 *   the event is not checked otherwise (FinishLynx's event in a LapTime line picks the race: 9.15 L3).
 * @returns {string[]}
 */
export function validateRace(config, race, { checkEvent = true, checkPort = true, activating = true } = {}) {
  const errs = [];
  if (!text(race.name)) errs.push('Give the race a name.');
  const others = (config.races ?? []).filter((r) => r.id !== race.id);
  if (text(race.name) && others.some((r) => matchKey(r.name) === matchKey(race.name))) {
    errs.push(`There is already a race called "${text(race.name)}". Give each race its own name.`);
  }
  // TrackScore files a split under its event number, and a merged .lif file is matched on event, round and heat:
  // two races on one event would send their runners into each other's race and only the first would get its file.
  const key = checkEvent ? eventKey(race) : '';
  const twin = key ? others.find((r) => eventKey(r) === key) : null;
  if (twin) {
    const show = (v) => text(v).replace(/^0+(?=.)/, '') || '1';
    errs.push(`"${text(race.name) || 'This race'}" and "${twin.name}" both use Event ` +
      `${show(race.eventNumber)}-${show(race.round)}-${show(race.heat)}: ` +
      "TrackScore and the .lif files can't tell them apart. Give each race its own event number, round or heat, as " +
      'FinishLynx has them.');
  }
  if (race.splits.length > MAX_SPLITS) errs.push(`A race can have at most ${MAX_SPLITS} splits.`);
  // 9.26: a race whose every split is "Not sent" would count its runners and show nothing anywhere
  if (race.splits.length && race.splits.every((s) => s.collectOnly === true)) errs.push(allNotSentText(race.name));
  const names = new Set();
  race.splits.forEach((s, i) => {
    if (!text(s.name)) errs.push(`Split ${i + 1} needs a name (for example 1K).`);
    else if (names.has(matchKey(s.name))) errs.push(`Two splits are called "${text(s.name)}". Give each split its own name.`);
    names.add(matchKey(s.name));
  });
  // A timing point under two splits would always score at the first one: almost certainly a slip in the editor.
  const used = new Map();
  const claim = (src, where) => {
    const k = matchKey(src);
    if (used.has(k) && used.get(k) !== where) {
      errs.push(`Timing point "${text(src)}" is used by ${used.get(k)} and ${where}. A timing point can belong to one split only.`);
    } else used.set(k, where);
  };
  race.splits.forEach((s, i) => s.sources.forEach((src) => claim(src, `split ${i + 1} (${text(s.name) || 'no name'})`)));
  race.finishSources.forEach((src) => claim(src, 'the finish'));
  // A pass gets the split whose earliest time it has reached (9.15 L4): times that went down would skip a split.
  let prevEarliest = null;
  race.splits.forEach((s, i) => {
    const t = text(s.earliest);
    if (!t) return;
    const ticks = earliestTicks(t);
    if (ticks === null) {
      errs.push(`The earliest time of ${text(s.name) || `split ${i + 1}`}, "${t}", is not a race time. Type it like 8:00 ` +
        '(minutes:seconds), or leave it empty.');
      return;
    }
    // equal times too: a pass at that time skips to the later split, so the earlier one could never be reached
    if (prevEarliest && ticks <= prevEarliest.ticks) {
      errs.push(`The earliest time of ${text(s.name) || `split ${i + 1}`} (${t}) is ${ticks === prevEarliest.ticks ? 'the same as' : 'before'} ` +
        `the earliest time of ${prevEarliest.name} (${prevEarliest.text}). Earliest times must go up in course order.`);
    }
    prevEarliest = { ticks, text: t, name: text(s.name) || `split ${i + 1}` };
  });
  const port = portOf(race);
  if (port !== null && checkPort && !inputPorts(config).includes(port)) {
    const list = inputPorts(config);
    errs.push(`Port ${port} is not one of the RR12 input ports (${list.join(', ') || 'none'}). Choose one of them for ` +
      'this race, or add the port in Settings first.');
  }
  // Two active races that both want a read: the engine gives it to the first, so the second would silently get
  // nothing (or, worse, the wrong race would score it). Paused races may overlap: yesterday's race, a spare copy.
  if (race.active) {
    for (const o of others.filter((r) => r.active !== false)) {
      for (const c of raceClashes(race, o)) {
        if (c.kind === 'every') {
          errs.push(`The race "${o.name}" is active and already takes every contest (it lists no contest and no port). ` +
            'Choose the contests or the port of this race, or untick Active on one of the two until its race starts.');
        } else if (c.kind === 'port') {
          errs.push(`Port ${c.port} already feeds the active race '${o.name}'. Untick Active on one of them, or give ` +
            'this race its own port.');
        } else if (c.kind === 'contest') {
          errs.push(`Contest "${c.contest}" already belongs to the active race "${o.name}". A contest can belong to one ` +
            'active race only: remove it from one of them, or untick Active on one race.');
        } else if (c.kind === 'event' && !checkEvent && activating) {
          // refused above for every race when the event is checked; an older settings file may still have two races on
          // one event, which can be renamed or paused, but not both be Active
          errs.push(`"${text(race.name)}" and "${o.name}" both use Event ${c.event}: only one of them can be Active. Give ` +
            'each race its own event number, round or heat, as FinishLynx has them, or untick Active on one of them.');
        }
      }
    }
  }
  if (race.gun !== '' && race.gun !== undefined) {
    try {
      parseGun(race.gun);
    } catch (err) {
      errs.push(err.message);
    }
  }
  return errs;
}

/**
 * @param {any} config the whole config the output would be part of
 * @param {any} out normalised output
 * @param {any} given the fields the request sent: those are checked as typed (normalising would quietly turn a typo
 *   into a default), the rest were valid before. An output whose only race was deleted can then still be switched
 *   off without first fixing its race list.
 * @returns {string[]}
 */
export function validateOutput(config, out, given = {}, { loopCheck = true } = {}) {
  const errs = [];
  const sent = (k) => Object.hasOwn(given, k);
  if (!text(out.name)) errs.push('Give the output a name (for example TrackScore).');
  const others = (config.outputs ?? []).filter((o) => o.id !== out.id);
  if (text(out.name) && others.some((o) => matchKey(o.name) === matchKey(out.name))) {
    errs.push(`There is already an output called "${text(out.name)}". Give each output its own name.`);
  }
  if (sent('mode') && !OUTPUT_MODES.includes(text(given.mode).toLowerCase())) {
    errs.push('Choose how to connect: TCP client (TrackScore, live results), TCP server or UDP.');
  }
  if (sent('host') && out.mode !== 'tcp-server' && !text(given.host)) {
    errs.push('Type the IP address of the computer to send to (127.0.0.1 is this PC).');
  } else if (text(out.host) && !/^[A-Za-z0-9.\-:[\]%_]+$/.test(out.host)) {
    errs.push(`"${out.host}" is not an IP address or computer name. Type it like 192.168.0.20 (127.0.0.1 is this PC).`);
  }
  const portErr = checkPort(sent('port') ? given.port : out.port, 'The port');
  if (portErr) errs.push(portErr);
  else if (out.mode === 'tcp-server' && (sent('port') || sent('mode') || sent('enabled'))) {
    const port = out.port;
    if (inputPorts(config).includes(port)) errs.push(`Port ${port} is an RR12 input port. Choose another port for this output.`);
    else if (port === wholeNumber(config.panel?.port)) errs.push(`Port ${port} is the control panel port. Choose another port for this output.`);
    const clash = others.find((o) => o.mode === 'tcp-server' && o.port === port);
    if (clash) errs.push(`The output "${clash.name}" already listens on port ${port}. Choose another port.`);
  } else if (loopCheck && out.mode !== 'tcp-server' && (sent('port') || sent('host') || sent('mode') || sent('enabled'))
    && isThisPcHost(out.host, [os.hostname()]) && inputPorts(config).includes(out.port)) {
    // the same loop a meet load refuses (DESIGN 9.22 O34): Split Relay would read its own splits back as RR12 reads
    errs.push(`Port ${out.port} is an RR12 input port of this Split Relay: sending there on this PC would feed Split Relay's own splits back in as RR12 reads. Choose another port (TrackScore takes splits on 5555).`);
  }
  const scriptErr = sent('script') && checkFolder(out.script, 'the .lss script', 'C:\\Lynx\\XCScore.lss');
  if (scriptErr) errs.push(scriptErr);
  if (sent('stage') && !['results', 'started'].includes(text(given.stage).toLowerCase())) {
    errs.push('Sections must be "results" (recommended) or "started".');
  }
  if (sent('precision') && ![1, 2, 3].includes(wholeNumber(given.precision))) errs.push('Decimals must be 1, 2 or 3.');
  if (sent('eventNumber') && !['race', 'blank'].includes(given.eventNumber)) {
    errs.push('Event number must be "race" (send the race\'s event number) or "blank".');
  }
  if (sent('mid') && out.mid && !/^\d+$/.test(out.mid)) {
    errs.push('The MID is the live-results meet number: digits only (for example 8132).');
  }
  if (sent('races')) {
    const known = new Set((config.races ?? []).map((r) => r.id));
    if (!Array.isArray(given.races)) errs.push('Races must be a list of race ids ([] sends all races).');
    else if (out.races.some((id) => !known.has(id))) {
      errs.push('This output is set to send a race that no longer exists. Reload the page and choose its races again.');
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------------------------------------------
// Changes. Each takes the current config and returns a new one, or throws a ConfigError; the input is never touched.

/** @param {any} e */
function validateEntries(e) {
  return e.otherRace === undefined || e.otherRace === 'keep' || e.otherRace === 'send' ? []
    : ['Athletes entered in another race: choose "keep" (keep them off the boards) or "send" (send and flag).'];
}

const SETTINGS = {
  input: { normalize: normalizeInput, validate: validateInput },
  filter: { normalize: normalizeFilter, validate: validateFilter },
  names: { normalize: normalizeNames, validate: validateNames },
  lif: { normalize: normalizeLif, validate: validateLif },
  panel: { normalize: normalizePanel, validate: validatePanel },
  meet: { normalize: normalizeMeet, validate: validateMeet },
  // (9.25: entries.otherRace, 'keep' or 'send')
  entries: { normalize: normalizeEntries, validate: validateEntries },
};

/**
 * PUT /api/settings: each section given is merged into the current one field by field.
 * @param {any} config
 * @param {any} patch { input?, filter?, names?, lif?, panel?, meet?, entries? }
 * @returns {any} the new config
 */
export function updateSettings(config, patch) {
  if (!isObj(patch)) throw new ConfigError('Send the settings to change as an object, for example { "filter": { "holdSec": 2 } }.');
  const unknown = Object.keys(patch).filter((k) => !(k in SETTINGS));
  if (unknown.length) {
    throw new ConfigError(`Split Relay has no setting called "${unknown[0]}". The settings are: ${Object.keys(SETTINGS).join(', ')}.`);
  }
  const next = clone(config);
  const errs = [];
  for (const [key, given] of Object.entries(patch)) {
    if (!isObj(given)) {
      errs.push(`The "${key}" settings must be an object.`);
      continue;
    }
    let part = given;
    if (key === 'input' && 'port' in part && !('ports' in part)) {
      // a panel from before revision 7 sends one port: it replaces the first, the others stay
      const { port, ...rest } = part;
      part = { ...rest, ports: [port, ...inputPorts(next).slice(1).filter((n) => n !== wholeNumber(port))] };
    }
    const merged = { ...next[key], ...part };
    if (key === 'input') delete merged.port;
    const e = SETTINGS[key].validate(merged);
    if (e.length) errs.push(...e);
    else next[key] = SETTINGS[key].normalize(merged);
    // (kept only when it says something: a settings file without it means "keep them off the boards")
    if (key === 'entries' && next.entries?.otherRace !== 'send') delete next.entries;
  }
  if (!errs.length) errs.push(...validatePorts(next));
  if (!errs.length && 'meet' in patch) errs.push(...validateWebPort(next));
  if (!errs.length && ('input' in patch || 'panel' in patch)) {
    // a tcp-server output and RR12 cannot share a port
    const ports = inputPorts(next);
    const clash = next.outputs.find((o) => o.enabled && o.mode === 'tcp-server' && (ports.includes(o.port) || o.port === next.panel.port));
    if (clash) errs.push(`The output "${clash.name}" already listens on port ${clash.port}. Choose another port.`);
  }
  if (!errs.length && 'input' in patch) {
    // R18: a port being added that TrackScore or an output on this PC uses
    const before = inputPorts(config);
    for (const p of inputPorts(next)) {
      const why = before.includes(p) ? null : inputPortProblem(next, p);
      if (why) errs.push(`${why} Choose another port.`);
    }
  }
  if (!errs.length && 'input' in patch) {
    // a port that feeds a race that is running can't go: that race would get nothing more, without a word
    const ports = inputPorts(next);
    for (const r of next.races) {
      const p = portOf(r);
      if (r.active && p !== null && !ports.includes(p) && inputPorts(config).includes(p)) {
        errs.push(`Port ${p} feeds the active race '${r.name}'. Give that race another port, or untick its Active, before you remove the port.`);
      }
    }
  }
  if (errs.length) throw new ConfigError(errs);
  return next;
}

function usedIdsOf(config, except = null) {
  const used = new Set();
  for (const r of config.races) {
    if (r.id === except) continue;
    used.add(r.id);
    for (const s of r.splits) used.add(s.id);
  }
  for (const o of config.outputs) if (o.id !== except) used.add(o.id);
  return used;
}

function bodyOf(body, what) {
  if (body === undefined || body === null) return {};
  if (!isObj(body)) throw new ConfigError(`Send the ${what} as an object.`);
  return body;
}

function findRace(config, id) {
  const race = config.races.find((r) => r.id === id);
  if (!race) throw new ConfigError(`There is no race with id "${id}". It may have been deleted: reload the page.`, 404);
  return race;
}

function findOutput(config, id) {
  const out = config.outputs.find((o) => o.id === id);
  if (!out) throw new ConfigError(`There is no output with id "${id}". It may have been deleted: reload the page.`, 404);
  return out;
}

/** Split ids from the panel are kept only when they are this race's own; anything else becomes a new split. */
function raceFromBody(base, body, used) {
  const ownSplits = new Set(base.splits.map((s) => s.id));
  const merged = { ...base, ...body, id: base.id };
  if ('splits' in body) {
    if (!Array.isArray(body.splits)) throw new ConfigError('Splits must be a list.');
    const before = new Map(base.splits.map((s) => [s.id, s]));
    merged.splits = body.splits.map((s) => {
      if (!isObj(s)) return s;
      const id = ownSplits.has(usableId(s.id)) ? usableId(s.id) : '';
      // A split the race editor sends back without saying whether it is paused keeps what it was (9.17 P1): editing a
      // race's names or earliest times must not quietly play a split the operator paused.
      const sending = 'sending' in s ? s.sending : id ? before.get(id)?.sending : undefined;
      // 9.26: the same for "Not sent" (collectOnly): a split sent back without it keeps what it was, so a panel from
      // before (or a script) that edits a name never starts sending a split point that is counted only
      const collectOnly = 'collectOnly' in s ? s.collectOnly : id ? before.get(id)?.collectOnly : undefined;
      if ('collectOnly' in s && typeof s.collectOnly !== 'boolean') {
        throw new ConfigError(`Say whether ${text(s.name) || 'the split'} is sent with "collectOnly": true (counted, not sent) or false (sent).`);
      }
      return { ...s, id, ...(sending === undefined ? {} : { sending }), ...(collectOnly === undefined ? {} : { collectOnly }) };
    });
  }
  for (const key of ['contests', 'finishSources']) {
    if (key in body && !Array.isArray(body[key])) throw new ConfigError(`${key === 'contests' ? 'Contests' : 'Finish timing points'} must be a list.`);
  }
  if ('splits' in body) for (const s of merged.splits) if (!isObj(s)) throw new ConfigError('Each split must be an object with a name and its timing points.');
  const notes = [];
  // gun goes through parseGun inside normalizeRace; validate it first so a typo is reported, not silently cleared
  if ('gun' in body && text(body.gun)) {
    try {
      parseGun(body.gun);
    } catch (err) {
      throw new ConfigError(err.message);
    }
  }
  if ('name' in body && !text(body.name)) throw new ConfigError('Give the race a name.');
  // normalizeRace turns anything unusable into "no port"; from the panel that would be a silent change of route
  if ('inputPort' in body && inputPortOf(body.inputPort) === null && !(body.inputPort === null || body.inputPort === '')) {
    throw new ConfigError('Choose the RR12 input port this race takes its reads from (one of the ports in Settings), or none.');
  }
  const splitNames = Array.isArray(merged.splits) ? merged.splits : [];
  splitNames.forEach((s, i) => {
    if (isObj(s) && 'name' in s && !text(s.name)) throw new ConfigError(`Split ${i + 1} needs a name (for example 1K).`);
    // normalizeRace clears an earliest time it can't read; typed in the panel, that would be a silent change
    if (isObj(s) && text(s.earliest) && earliestTicks(s.earliest) === null) {
      throw new ConfigError(`The earliest time of ${text(s.name) || `split ${i + 1}`}, "${text(s.earliest)}", is not a race ` +
        'time. Type it like 8:00 (minutes:seconds), or leave it empty.');
    }
  });
  if ('splits' in body && body.splits.length > MAX_SPLITS_SET) throw new ConfigError(`A race can have at most ${MAX_SPLITS_SET} splits.`);
  return normalizeRace(merged, used, 0, notes);
}

/**
 * POST /api/races. Ids are always new: a race copied in the panel must not share split ids with its original.
 * @param {any} config
 * @param {any} body Partial<Race>
 * @returns {{ config: any, race: any }}
 */
export function addRace(config, body) {
  const b = bodyOf(body, 'race');
  if (!text(b.name)) throw new ConfigError('Give the race a name.');
  const next = clone(config);
  const used = usedIdsOf(next);
  const fields = { ...b };
  delete fields.id;
  if (Array.isArray(fields.splits)) fields.splits = fields.splits.map((s) => (isObj(s) ? { ...s, id: '' } : s));
  // a new race takes the reads of the first RR12 input port unless the panel says otherwise (9.15 L3)
  const base = { ...defaultRace(), id: freshId('r_', used), inputPort: inputPorts(next)[0] ?? null };
  const race = raceFromBody(base, fields, used);
  const errs = validateRace(next, race);
  if (errs.length) throw new ConfigError(errs);
  next.races.push(race);
  return { config: next, race };
}

/**
 * PUT /api/races/:id: only the fields given change.
 * @param {any} config
 * @param {string} id
 * @param {any} body Partial<Race>
 * @returns {{ config: any, race: any }}
 */
export function updateRace(config, id, body) {
  const b = bodyOf(body, 'race');
  const next = clone(config);
  const old = findRace(next, id);
  const used = usedIdsOf(next, id);
  for (const s of old.splits) used.delete(s.id);
  const race = raceFromBody(old, b, used);
  const errs = validateRace(next, race, {
    checkEvent: ['eventNumber', 'round', 'heat'].some((k) => k in b),
    checkPort: 'inputPort' in b || (race.active && !old.active),
    activating: race.active && !old.active,
  });
  if (errs.length) throw new ConfigError(errs);
  next.races[next.races.indexOf(old)] = race;
  return { config: next, race };
}

/**
 * DELETE /api/races/:id. An output that listed this race among others stops listing it; one that sent ONLY this race
 * keeps the id (and says it sends nothing) rather than falling back to [] = every race.
 * @param {any} config
 * @param {string} id
 */
export function deleteRace(config, id) {
  const next = clone(config);
  findRace(next, id);
  next.races = next.races.filter((r) => r.id !== id);
  for (const o of next.outputs) {
    if (o.races.includes(id) && o.races.length > 1) o.races = o.races.filter((x) => x !== id);
  }
  return next;
}

/**
 * @typedef {{ raceId: string, raceName: string, keptId: string, keptName: string, why: string }} Unticked
 *   a race whose Active was unticked because it and the Active race `kept` want the same reads; why: "both take
 *   port 5565", "both list contest 'Girls'", "both take every contest", "both use Event 3-1-1"
 */

/**
 * DESIGN 9.15 V1: a settings file can hold two Active races that want the same reads (two on one port, contest or
 * event, two that take every contest): config.json edited by hand, or a race put back from an older copy. The engine
 * would give the reads to the first and the second would get none without a word, so the first one (in the settings'
 * order) stays Active and the later ones are unticked. The caller saves the result and warns in red.
 * @param {any} config a normalised config
 * @returns {{ config: any, unticked: Unticked[] }}
 */
export function settleConflicts(config) {
  const next = clone(config);
  const unticked = [];
  const kept = [];
  for (const r of next.races) {
    if (!r.active) continue;
    let clash = null;
    for (const k of kept) {
      const c = raceClashes(r, k);
      if (c.length) {
        clash = { k, c };
        break;
      }
    }
    if (!clash) {
      kept.push(r);
      continue;
    }
    r.active = false;
    unticked.push({ raceId: r.id, raceName: r.name, keptId: clash.k.id, keptName: clash.k.name, why: clashText(clash.c) });
  }
  return { config: next, unticked };
}

/**
 * POST /api/races/:id/activate (9.15 L3): tick Active on this race and untick it on every other Active race that wants
 * the same reads (the same port, a contest both list, both taking every contest, the same event), so the panel can
 * offer a one-click "Switch to Boys 5K" instead of an error. Those races keep their reads (9.2 R1).
 * @param {any} config
 * @param {string} id
 * @returns {{ config: any, race: any, unticked: { raceId: string, raceName: string, why: string }[] }}
 */
export function activateRace(config, id) {
  const next = clone(config);
  const race = findRace(next, id);
  const wasActive = race.active;
  race.active = true;
  const unticked = [];
  for (const o of next.races) {
    if (o === race || !o.active) continue;
    const c = raceClashes(race, o);
    if (!c.length) continue;
    o.active = false;
    unticked.push({ raceId: o.id, raceName: o.name, why: clashText(c) });
  }
  const errs = validateRace(next, race, { checkEvent: false, checkPort: !wasActive });
  if (errs.length) throw new ConfigError(errs);
  return { config: next, race, unticked };
}

/**
 * POST /api/races/:id/restore (9.15 V2, "Put it back"): a race missing from the settings (config.json put back from
 * its backup, or edited) comes back with the settings its race file keeps. Checked as a start checks the settings
 * (V1): when it would want the reads of an Active race, it comes back not Active, and says why. A name another race
 * has meanwhile gets " (put back)".
 * @param {any} config
 * @param {any} saved the race's settings from its race file (data\races\<id>.json, field `race`)
 * @param {string} id the missing race's id (the race file's)
 * @returns {{ config: any, race: any, renamedFrom: string|null, why: string|null }} why: it came back not Active, and why
 */
export function restoreRace(config, saved, id) {
  if (!isObj(saved)) {
    throw new ConfigError("This race's file in data\\races has no settings saved (it was written by an older Split Relay). " +
      'Add the race again on the Races tab, with the same event number, round and heat.', 409);
  }
  const next = clone(config);
  if (next.races.some((r) => r.id === id)) throw new ConfigError('That race is in the settings already. Reload the page.', 409);
  const used = usedIdsOf(next);
  const notes = [];
  const race = normalizeRace({ ...saved, id }, used, next.races.length, notes);
  if (race.id !== id) throw new ConfigError(`The race id "${id}" can't be used. Add the race again on the Races tab.`, 409);
  let renamedFrom = null;
  const taken = (name) => next.races.some((r) => matchKey(r.name) === matchKey(name));
  if (taken(race.name)) {
    renamedFrom = race.name;
    let n = 1;
    do race.name = `${renamedFrom} (put back${n > 1 ? ` ${n}` : ''})`; while (taken(race.name) && ++n < 100);
  }
  let why = null;
  if (race.active) {
    for (const o of next.races) {
      if (!o.active) continue;
      const c = raceClashes(race, o);
      if (c.length) {
        why = `it and '${o.name}' ${clashText(c)}, and '${o.name}' is Active`;
        break;
      }
    }
    const p = portOf(race);
    if (!why && p !== null && !inputPorts(next).includes(p)) why = `its port ${p} is not an RR12 input port any more`;
    if (why) race.active = false;
  }
  if (!why) {
    const twin = next.races.find((o) => eventKey(o) && eventKey(o) === eventKey(race));
    if (twin) why = `it and '${twin.name}' both use Event ${eventKey(race)}: give one of them its own event, round or heat`;
    if (twin && race.active) race.active = false;
  }
  next.races.push(race);
  return { config: next, race, renamedFrom, why };
}

/**
 * POST /api/races/:id/splits/:splitId/sending (DESIGN 9.17 P1): pause a split (on: false) or play it again (true).
 * Only that one flag changes, so nothing is worked out again: the split's crossings stay as they are, and what a pause
 * held goes out when it is played.
 * @param {any} config
 * @param {string} raceId
 * @param {string} splitId
 * @param {unknown} on
 * @returns {{ config: any, race: any, split: any, changed: boolean }}
 */
export function setSplitSending(config, raceId, splitId, on) {
  if (typeof on !== 'boolean') throw new ConfigError('Send { "on": true } to play the split, or { "on": false } to pause it.');
  const next = clone(config);
  const race = findRace(next, raceId);
  const split = race.splits.find((s) => s.id === splitId);
  if (!split) throw new ConfigError(`${race.name} has no split with id "${splitId}". It may have been changed: reload the page.`, 404);
  // 9.26: a split that is counted but not sent has nothing to pause or play
  if (split.collectOnly === true) {
    throw new ConfigError(`${split.name} is set to Not sent: it is counted, and nothing of it goes out, so there is nothing to pause or play. ` +
      `To send it, switch Send on for ${split.name} on the race's page.`, 409);
  }
  const changed = split.sending !== on;
  split.sending = on;
  return { config: next, race, split, changed };
}

/**
 * The engine's 'config-patch' ({ gun }). The engine has validated the value already; this only stores it.
 * @param {any} config
 * @param {string} raceId
 * @param {any} patch
 */
export function patchRace(config, raceId, patch) {
  const next = clone(config);
  const race = findRace(next, raceId);
  if (isObj(patch) && 'gun' in patch) race.gun = text(patch.gun);
  return next;
}

/**
 * POST /api/outputs.
 * @param {any} config
 * @param {any} body Partial<Output>
 * @returns {{ config: any, output: any }}
 */
export function addOutput(config, body, opts = {}) {
  const b = bodyOf(body, 'output');
  const next = clone(config);
  const used = usedIdsOf(next);
  const fields = { ...b };
  delete fields.id;
  if (!text(fields.name)) throw new ConfigError('Give the output a name (for example TrackScore).');
  const merged = { ...defaultOutput(), ...fields };
  if (text(merged.mode).toLowerCase() === 'tcp-server' && !('host' in fields)) merged.host = '0.0.0.0';
  const out = normalizeOutput(merged, used, next.outputs.length);
  const errs = validateOutput(next, out, fields, opts);
  if (errs.length) throw new ConfigError(errs);
  next.outputs.push(out);
  return { config: next, output: out };
}

/**
 * PUT /api/outputs/:id: only the fields given change.
 * @param {any} config
 * @param {string} id
 * @param {any} body Partial<Output>
 * @returns {{ config: any, output: any }}
 */
export function updateOutput(config, id, body, opts = {}) {
  const b = bodyOf(body, 'output');
  const next = clone(config);
  const old = findOutput(next, id);
  if ('name' in b && !text(b.name)) throw new ConfigError('Give the output a name (for example TrackScore).');
  const merged = { ...old, ...b, id: old.id };
  const used = usedIdsOf(next, id);
  const out = normalizeOutput(merged, used, next.outputs.indexOf(old));
  const errs = validateOutput(next, out, b, opts);
  if (errs.length) throw new ConfigError(errs);
  next.outputs[next.outputs.indexOf(old)] = out;
  return { config: next, output: out };
}

/** DELETE /api/outputs/:id. @param {any} config @param {string} id */
export function deleteOutput(config, id) {
  const next = clone(config);
  findOutput(next, id);
  next.outputs = next.outputs.filter((o) => o.id !== id);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// The file

/**
 * data\config.json: loaded once at start (synchronously, before anything else needs it), saved after every change.
 * Saves are atomic and run one at a time; several changes in quick succession cost one write. After every good load
 * a copy is kept as config.json.bak, so a file broken by a hand edit falls back to the last version that started.
 */
export class ConfigFile {
  #file;
  #log;
  #config = null;
  #version = 0;
  #written = 0;
  #queue = Promise.resolve();
  /** @type {string | null} */
  lastError = null;

  /** @param {{ file: string, log?: (line: string) => void }} opts */
  constructor({ file, log = () => {} }) {
    this.#file = path.resolve(file);
    this.#log = typeof log === 'function' ? log : () => {};
  }

  get file() {
    return this.#file;
  }

  /** The live config. Replaced (never mutated) by set(). */
  get config() {
    return this.#config;
  }

  /**
   * Read the file, repair what is missing, and write it back when it was missing or repaired.
   * `source`: where the settings came from: 'file' (config.json), 'backup' (config.json was damaged or missing, so
   * config.json.bak was used), 'new' (a first start: nothing to read) or 'empty' (config.json was damaged and there was
   * no usable backup). `brokenFile`: the name the damaged config.json was moved to, or null.
   * @returns {{ config: any, created: boolean, notes: string[], source: 'file'|'backup'|'new'|'empty', brokenFile: string|null }}
   */
  load() {
    const notes = [];
    let raw = null;
    let created = false;
    let needsSave = false;
    /** @type {'file'|'backup'|'new'|'empty'} */
    let source = 'file';
    let brokenFile = null;
    const bak = this.#file + '.bak';
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const readBackup = () => {
      try {
        return read(bak);
      } catch {
        return null; // no usable backup
      }
    };
    try {
      raw = read(this.#file);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // A config.json that is gone while its backup is there was lost, not never made: the backup has the races.
        const backup = fs.existsSync(bak) ? readBackup() : null;
        needsSave = true;
        if (backup) {
          raw = backup;
          source = 'backup';
          notes.push(`The settings file ${this.#file} is missing. Using the copy saved when Split Relay last started (config.json.bak).`);
        } else {
          created = true;
          source = 'new';
        }
      } else {
        const aside = this.#file.replace(/\.json$/i, '') + `.broken-${fileStamp()}.json`;
        let moved = false;
        try {
          fs.renameSync(this.#file, aside);
          moved = true;
          brokenFile = path.basename(aside);
        } catch { /* reported below */ }
        const why = err instanceof SyntaxError ? `it is not valid JSON (${err.message})` : (err?.message ?? String(err));
        const backup = readBackup();
        raw = backup;
        source = backup ? 'backup' : 'empty';
        needsSave = true;
        notes.push(`The settings file ${this.#file} could not be read: ${why}. ` +
          (moved ? `It was renamed to ${path.basename(aside)}. ` : '') +
          (backup ? 'Using the copy saved when Split Relay last started (config.json.bak).' : 'Starting with empty settings.'));
      }
    }
    const { config, notes: repairs } = normalizeConfig(raw);
    notes.push(...repairs);
    if (raw && JSON.stringify(config) !== JSON.stringify(raw)) needsSave = true;
    this.#config = config;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    if (needsSave) {
      this.#writeSync(config);
    }
    // The backup is the copy of the last settings that started well. A start that fell back to it (or found nothing
    // usable) must not overwrite it: it may be the only copy of the races the operator wants back (9.15 V2).
    if (source === 'file' || (source === 'new' && !fs.existsSync(bak))) {
      try {
        fs.copyFileSync(this.#file, bak);
      } catch (err) {
        this.#log(`[config] could not keep a backup copy of the settings: ${err?.message ?? err}`);
      }
    }
    for (const n of notes) this.#log(`[config] ${n}`);
    return { config, created, notes, source, brokenFile };
  }

  /**
   * Make `next` the live config now (synchronously, which the engine's gun patch needs) and save it.
   * The returned promise rejects with a plain-English error when the file cannot be written; the change is live
   * either way.
   * @param {any} next
   * @returns {Promise<void>}
   */
  set(next) {
    this.#config = next;
    this.#version++;
    return this.save();
  }

  /** Write the live config if it changed since the last write. */
  save() {
    const run = this.#queue.catch(() => {}).then(async () => {
      if (this.#written === this.#version) return;
      const version = this.#version;
      try {
        await writeFileAtomic(this.#file, serialize(this.#config));
        this.#written = version;
        if (this.lastError) this.#log('[config] settings saved again');
        this.lastError = null;
      } catch (err) {
        this.lastError = `The change is in use now, but Split Relay could not save it to ${this.#file} ` +
          `(${err?.code ?? err?.message ?? err}). It will be lost when Split Relay restarts.`;
        this.#log(`[config] ${this.lastError}`);
        throw new ConfigError(this.lastError, 500);
      }
    });
    this.#queue = run;
    // A caller that does not wait (the engine's gun patch) must not turn a disk error into an unhandled rejection,
    // which would stop the process; the error is logged and kept in lastError.
    run.catch(() => {});
    return run;
  }

  /** Resolves when every save asked for has finished. Never rejects. */
  flush() {
    return this.#queue.catch(() => {});
  }

  #writeSync(config) {
    const tmp = `${this.#file}.~${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, serialize(config));
      fs.renameSync(tmp, this.#file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      this.#log(`[config] could not write ${this.#file}: ${err?.message ?? err}`);
    }
  }
}

/** Pretty-printed with CRLF, so the file reads well in Notepad when someone looks at it on race day. */
function serialize(config) {
  return JSON.stringify(config, null, 2).replace(/\n/g, '\r\n') + '\r\n';
}
