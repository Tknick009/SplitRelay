// Meet files (DESIGN 9.22): the whole meet setup (races, outputs and settings) in one JSON file a person can read and
// edit, saved with one click and loaded again, from that file or from TrackScore's Race Setup. Everything here is pure:
// main.js reads and writes the files, asks TrackScore and the engine, and makes the plan live with ONE settings change.
//
// A load may run on race day, over races that have reads, so it keeps five rules (DESIGN 9.22):
// R1 it never removes and never empties: races not in the source stay (removing the ones with no reads is opt-in);
// R2 ids, reads, guns, Pause and Active belong to this Split Relay, never to a file;
// R3 a race in use (reads, crossings, a gun, reads waiting for it) changes only its split names;
// R4 settings that change how reads are worked out stay while races have reads; outputs stay while a race runs;
// R5 one preview, then one change, built through config.js's own functions, so their checks and words apply.
// Together they mean a load sends nothing to any output by itself.

import { matchKey, eventKey, parseGun } from './engine.js';
import { raceTicks, TICKS_PER_SEC } from './timefmt.js';
// the panel's and Split Relay's one rule for a running race (the panel can load only what is in public\)
import { RUNNING_CLOCK_MS, RUNNING_READ_MS, clockRunning, runningNow } from '../public/running.js';
import {
  ConfigError, normalizeConfig, updateSettings, addRace, updateRace, addOutput, updateOutput, deleteRace, raceClashes,
  inputPorts, inputPortProblem, isThisPcHost, MAX_SPLITS_SET, MAX_INPUT_PORTS, MAX_MEET_NAME, sentSplits,
} from './config.js';

// Outputs' own check for an output into this PC's RR12 ports is left to the plan: loopsBack knows this PC's names and
// says it in the load's words (O34)
const NO_LOOP_CHECK = { loopCheck: false };

/** The meet file's format version (`splitRelayMeet`). A newer one is refused rather than half-read. */
export const MEET_FORMAT = 1;
/**
 * The most races and outputs a meet file may hold (R12): every settings change clones the whole config and checks each
 * race against the others, so thousands of races would hold up the reads and the outputs for seconds.
 */
export const MAX_MEET_RACES = 100;
export const MAX_MEET_OUTPUTS = 20;
/** An output's race whose race was deleted (config.js deleteRace keeps a lone dangling id): what the file says. */
export const DELETED_RACE = '(deleted race)';
export const MEET_ABOUT = 'Split Relay meet setup: races, outputs and settings. Never in it: gun times, reads, Pause. ' +
  'Load it with Load meet file on the Races page, or drop it on the page.';
/**
 * 9.26: a split as a meet file has it. A split with no timing points, no earliest time and that is sent is just its
 * name ("800M"); one that is counted but not sent says so: { "name": "4.2K", "collectOnly": true }.
 */
const fileSplit = (s) => (!(s.sources ?? []).length && !text(s.earliest) && s.collectOnly !== true ? s.name
  : { name: s.name, ...((s.sources ?? []).length || text(s.earliest) ? { sources: [...(s.sources ?? [])], earliest: text(s.earliest) } : {}),
    ...(s.collectOnly === true ? { collectOnly: true } : {}) });

const NOT_MEET = 'This is not a Split Relay meet file: it has no "splitRelayMeet" line. Save one with Save meet setup.';
const CONFIG_NOTE = 'This is a Split Relay settings file (config.json), not a meet file. Its races, outputs and settings ' +
  'are loaded; its gun times and ids are not.';
const GUN_NOTE = 'Gun times are never loaded from a file: type each gun on race day.';

/** A meet file that can't be loaded at all; `status` is the HTTP status the panel gets. */
export class MeetError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'MeetError';
    this.status = status;
  }
}

/**
 * One line of the preview (MeetPreview's lists, DESIGN 9.22 M3). tone: 'bad' (Problem), 'warn' (Check), 'info' (Note)
 * for Needs your attention; raceId gives it an "Open race" link, href an "Open" link (Settings, Outputs).
 * @typedef {{ kind: string, name: string, text: string, tone?: 'bad'|'warn'|'info', raceId?: string, outputId?: string,
 *   href?: string }} Item
 */

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v)).trim();
const has = (o, k) => isObj(o) && Object.hasOwn(o, k);
const sameTexts = (a, b) => JSON.stringify((a ?? []).map(matchKey)) === JSON.stringify((b ?? []).map(matchKey));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function listText(names, max = 4) {
  const l = names.filter(Boolean);
  if (l.length <= 1) return l[0] ?? '';
  if (l.length > max) return `${l.slice(0, max - 1).join(', ')} and ${l.length - max + 1} more`;
  return `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`;
}

/** Numbers become strings ("eventNumber": 3); text is trimmed; anything else stays as typed so validation names it. */
const scalar = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : v);
/** "5565" -> 5565; anything else as typed (validation says what is wrong with it). */
const portValue = (v) => (typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : v);
const textList = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : v);

/**
 * Names compared loosely: lower case, letters and digits only, accents dropped. TrackScore has "Women's Race" where
 * FinishLynx (and so Split Relay) has "Womens Race": the same race (DESIGN 9.22 M4).
 * @param {unknown} s
 */
export function looseKey(s) {
  return matchKey(s).normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/** The event number alone ("3" for 3-1-1): TrackScore has no round or heat. '' when there is none. */
function enKey(v) {
  const k = eventKey(v);
  return k ? k.slice(0, k.indexOf('-')) : '';
}

const raceEvent = (r) => eventKey(r.eventNumber, r.round, r.heat);
const portWord = (p) => (Number.isInteger(p) ? String(p) : p === null ? 'none (by contest only)' : String(p));
const fmtSec = (s) => (Number.isFinite(Number(s)) && s !== '' && s !== null ? `${Math.round(Number(s) * 1000) / 1000} s` : JSON.stringify(s));
/** Every split name of a race or a source race, in order: the preview shows them all (the names are what is checked). */
// (9.26: a split that is counted but not sent says so: "4K, 4.2K (not sent), 5K")
const splitName = (s) => (s.collectOnly === true ? `${s.name} (not sent)` : s.name);
const splitNames = (r) => (Array.isArray(r) ? r : r?.splits ?? []).map(splitName).join(', ');

/**
 * true / false as a person may type them in a file (true, "false", "yes", 0 …); undefined for anything else, which the
 * caller names in a note rather than guessing ("active": "false" is not Active).
 */
function boolOf(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(s)) return true;
    if (['false', 'no', 'off', '0'].includes(s)) return false;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Running races

// A race runs while its clock is under 30 minutes, or while reads keep arriving: public/running.js, the one rule the
// panel's isRunning uses too.
export { RUNNING_CLOCK_MS, RUNNING_READ_MS };

/**
 * The race clock now in ms: this PC's time of day minus the gun, wrapped at midnight as race times are (engine.js), so
 * a gun later in the day than now (an earlier day's) is negative. null with no gun; NaN for one that can't be read.
 * @param {any} race
 * @param {number} now
 */
export function raceClockMs(race, now = Date.now()) {
  let ticks;
  try {
    ticks = parseGun(race?.gun).gunTicks;
  } catch {
    return NaN;
  }
  if (ticks === null) return null;
  const d = new Date(now);
  const tod = ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * TICKS_PER_SEC + d.getMilliseconds() * 10;
  return raceTicks(tod, ticks) / (TICKS_PER_SEC / 1000);
}

/** The clock of a race with a gun is between the gun and 30 minutes after it (a gun that can't be read counts too). */
const raceClockRunning = (race, now) => clockRunning(raceClockMs(race, now));

/**
 * Whether a race is running now (DESIGN 9.22 M9): Active with a gun, and its clock under 30 minutes (a gun typed a
 * moment ago, before the first split) or a read in the last 20 minutes. A gun left from an earlier day, or from a race
 * long over, is not running: Start a new meet and the Races list go by this. The rule is public/running.js runningNow,
 * the panel's own (public/app.js isRunning), so the panel never offers what this refuses.
 * @param {any} race
 * @param {number|null|undefined} lastReadAt when its last read arrived (ms), if it has one
 * @param {number} [now]
 */
export function raceRunning(race, lastReadAt, now = Date.now()) {
  if (!race) return false;
  return runningNow({ active: race.active, gun: !!text(race.gun), clockMs: raceClockMs(race, now), lastReadAt }, now);
}

// ---------------------------------------------------------------------------------------------------------------
// The file

/**
 * The meet file for a config (DESIGN 9.22 M1). Built from the RAW settings (main.js `this.config`, never State.config,
 * which carries a read-only input.port and the --port override). Left out: gun times (only ever typed on race day,
 * 9.21), Pause (a race-day state), ids (they key this install's stored data), reads and deliveries, and the settings of
 * this PC (the control panel, TrackScore's web port).
 * @param {any} config
 * @param {{ name?: string, savedAt?: string, savedBy?: string, savedOn?: string }} [header]
 */
export function buildMeet(config, { name = '', savedAt, savedBy, savedOn } = {}) {
  const races = config?.races ?? [];
  const nameOf = new Map(races.map((r) => [r.id, r.name]));
  const meet = { splitRelayMeet: MEET_FORMAT, name: text(name) };
  if (savedAt) meet.savedAt = savedAt;
  if (savedBy) meet.savedBy = savedBy;
  if (savedOn) meet.savedOn = savedOn;
  meet.about = MEET_ABOUT;
  meet.races = races.map((r) => {
    const out = {
      name: r.name, eventNumber: r.eventNumber, round: r.round, heat: r.heat, distance: r.distance,
      inputPort: Number.isInteger(r.inputPort) ? r.inputPort : null, active: r.active !== false,
      // a split with no timing points and no earliest time is just its name: "splits": ["800M", "1500M"]
      splits: (r.splits ?? []).map(fileSplit),
    };
    if ((r.contests ?? []).length) out.contests = [...r.contests];
    if ((r.finishSources ?? []).length) out.finishSources = [...r.finishSources];
    return out;
  });
  meet.outputs = (config?.outputs ?? []).map((o) => ({
    name: o.name, enabled: o.enabled, mode: o.mode, host: o.host, port: o.port, script: o.script, stage: o.stage,
    // by name: ids are per install. An output whose only race was deleted says so, as it does today.
    races: [...new Set((o.races ?? []).map((id) => nameOf.get(id) ?? DELETED_RACE))],
    eventNumber: o.eventNumber, precision: o.precision, mid: o.mid,
  }));
  // every race's port is listed, so the file is complete in itself (a race may keep a port that was removed since)
  const ports = [...inputPorts(config)];
  for (const r of meet.races) if (Number.isInteger(r.inputPort) && !ports.includes(r.inputPort)) ports.push(r.inputPort);
  const i = config?.input ?? {};
  meet.input = { ports, delimiter: i.delimiter, tag: i.tag, columns: [...(i.columns ?? [])] };
  const f = config?.filter ?? {};
  meet.filter = { tagWindowSec: f.tagWindowSec, holdSec: f.holdSec, startIgnoreSec: f.startIgnoreSec };
  meet.names = { pplPath: config?.names?.pplPath ?? '' };
  const l = config?.lif ?? {};
  meet.lif = { enabled: !!l.enabled, inputDir: l.inputDir ?? '', outputDir: l.outputDir ?? '', fillPlaces: !!l.fillPlaces };
  return meet;
}

/**
 * The file's text: JSON with two spaces and CRLF, readable in Notepad, except that a list of only names or numbers
 * stays on one line while that line is at most 120 characters ("splits": ["800M", "1500M", …]). No BOM.
 * @param {any} meet
 */
export function meetText(meet) {
  return `${printJson(meet, '', 0)}\n`.replace(/\n/g, '\r\n');
}

function printJson(v, indent, lead) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      const one = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      // the line: indent, the key, the list, and the comma that may follow it
      if (indent.length + lead + one.length + 1 <= 120) return one;
    }
    const inner = `${indent}  `;
    return `[\n${v.map((x) => inner + printJson(x, inner, 0)).join(',\n')}\n${indent}]`;
  }
  if (isObj(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return '{}';
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => {
      const key = `${JSON.stringify(k)}: `;
      return inner + key + printJson(v[k], inner, key.length);
    }).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The file name a meet is saved under in data\meets: "Fall Classic 2026.json". Characters Windows refuses become "-",
 * a reserved device name gets "Meet " before it, an empty name is "Meet".
 * @param {unknown} name
 */
export function meetFileName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '-');
  s = s.replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  s = s.slice(0, MAX_MEET_NAME).replace(/[.\s]+$/g, '');
  if (!s) s = 'Meet';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = `Meet ${s}`;
  return `${s}.json`;
}

const RACE_KEYS = new Set(['name', 'eventNumber', 'round', 'heat', 'distance', 'inputPort', 'active', 'splits', 'contests',
  'finishSources', 'trackScore']);
const SPLIT_KEYS = new Set(['name', 'sources', 'earliest', 'collectOnly']);
const OUTPUT_KEYS = new Set(['name', 'enabled', 'mode', 'host', 'port', 'script', 'stage', 'races', 'eventNumber', 'precision', 'mid']);
// leftOut: the races a file had but that could not be read (parseMeet), carried from the preview to the apply so they
// are never offered for removal
const TOP_KEYS = new Set(['splitRelayMeet', 'name', 'savedAt', 'savedBy', 'savedOn', 'about', 'races', 'outputs', 'input',
  'filter', 'names', 'lif', 'leftOut']);
const SECTION_KEYS = {
  input: new Set(['ports', 'port', 'delimiter', 'tag', 'columns']),
  filter: new Set(['tagWindowSec', 'holdSec', 'startIgnoreSec']),
  names: new Set(['pplPath']),
  lif: new Set(['enabled', 'inputDir', 'outputDir', 'fillPlaces']),
};
/** Keys a file may have that are never used, without a word: this install's own (ids, guns, Pause). */
const IGNORED_KEYS = new Set(['id', 'gun', 'sending']);

/**
 * A meet file (or a Split Relay config.json) as the browser read it -> the meet to plan from, and notes for the
 * preview. Throws a MeetError for a file that can't be loaded at all. A race or an output that can't be read is left
 * out with a note; the rest loads. Fields a file leaves out stay as they are on a race or output it matches (and take
 * the defaults on a new one), except that a new output with no "enabled" comes in switched off (R11).
 * Idempotent: parseMeet(parseMeet(x).meet).meet deep-equals parseMeet(x).meet (apply re-parses what the preview sent).
 * @param {any} raw
 * @returns {{ meet: any, notes: Item[] }}
 */
export function parseMeet(raw) {
  const notes = [];
  const note = (tone, t) => notes.push({ kind: 'file', name: '', text: t, tone });
  let src = raw;
  if (!isObj(src)) throw new MeetError(400, NOT_MEET);
  if (!has(src, 'splitRelayMeet')) {
    // the way out for "the other copy has my races": load that copy's data\config.json
    if (Array.isArray(src.races) && ['version', 'input', 'outputs'].some((k) => has(src, k))) {
      const cfg = normalizeConfig(src).config;
      src = buildMeet(cfg, { name: cfg.meet?.name || '' });
      note('info', CONFIG_NOTE);
    } else throw new MeetError(400, NOT_MEET);
  }
  let version = src.splitRelayMeet;
  // "1" typed by hand is 1; anything else that is not a format number is said as it is, not "it has no line"
  if (typeof version === 'string' && /^\s*\d{1,6}\s*$/.test(version)) version = Number(version);
  if (!Number.isInteger(version) || version < 1) {
    throw new MeetError(400, `The meet file's "splitRelayMeet" line must be ${MEET_FORMAT} (it is ${JSON.stringify(src.splitRelayMeet) ?? 'empty'}).`);
  }
  if (version > MEET_FORMAT) {
    throw new MeetError(400, `This meet file was saved by a newer Split Relay (format ${version}). Update Split Relay to load it.`);
  }
  for (const k of ['races', 'outputs']) {
    if (has(src, k) && !Array.isArray(src[k])) throw new MeetError(400, `The meet file's "${k}" must be a list.`);
  }
  const rawRaces = src.races ?? [];
  const rawOutputs = src.outputs ?? [];
  if (rawRaces.length > MAX_MEET_RACES) {
    throw new MeetError(400, `This meet file has ${rawRaces.length} races. Split Relay loads at most ${MAX_MEET_RACES}.`);
  }
  if (rawOutputs.length > MAX_MEET_OUTPUTS) {
    throw new MeetError(400, `This meet file has ${rawOutputs.length} outputs. Split Relay loads at most ${MAX_MEET_OUTPUTS}.`);
  }
  if (!rawRaces.length && !rawOutputs.length && !Object.keys(SECTION_KEYS).some((k) => has(src, k))) {
    throw new MeetError(400, 'The meet file has nothing to load: no races, no outputs, no settings.');
  }

  // unknown keys, one note per key and kind of item ("12 races in the file have …")
  const unknown = new Map();
  const seeUnknown = (o, known, kind, label) => {
    for (const k of Object.keys(o)) {
      if (known.has(k) || IGNORED_KEYS.has(k)) continue;
      const key = `${kind}\u0000${k}`;
      const u = unknown.get(key) ?? { kind, key: k, labels: [] };
      u.labels.push(label);
      unknown.set(key, u);
    }
  };
  seeUnknown(src, TOP_KEYS, 'top', '');
  let gunSeen = false;
  const gunIn = (o) => {
    if (isObj(o) && text(o.gun)) gunSeen = true;
  };

  const races = [];
  // the races of the file that can't be read: a race here of that name is said to stay, and never offered for removal
  const leftOut = Array.isArray(src.leftOut) ? src.leftOut.map(text).filter(Boolean) : [];
  const leaveOut = (name, t) => {
    if (!leftOut.includes(name)) leftOut.push(name);
    note('warn', t);
  };
  rawRaces.forEach((r, i) => {
    if (!isObj(r)) return note('warn', `Race ${i + 1} in the file is not a race: it is left out.`);
    const name = text(r.name);
    if (!name) return note('warn', `Race ${i + 1} has no name: it is left out.`);
    gunIn(r);
    if (!Array.isArray(r.splits)) return leaveOut(name, `"${name}": its splits must be a list, so the race is left out.`);
    if (r.splits.length > MAX_SPLITS_SET) {
      return leaveOut(name, `"${name}" has ${r.splits.length} splits. Split Relay takes at most ${MAX_SPLITS_SET}, so the race is left out.`);
    }
    const splits = [];
    for (const [j, s] of r.splits.entries()) {
      gunIn(s);
      const sname = typeof s === 'string' ? s.trim() : isObj(s) ? text(s.name) : '';
      if (!sname) {
        leaveOut(name, `"${name}": split ${j + 1} has no name, so the race is left out. Give every split its name in the file.`);
        return undefined;
      }
      if (isObj(s)) seeUnknown(s, SPLIT_KEYS, 'split', `"${name}" split ${j + 1}`);
      // 9.26: "collectOnly": true = counted, not sent (anything unclear is said, and the split is sent as usual)
      const quiet = isObj(s) && has(s, 'collectOnly') ? boolOf(s.collectOnly) : false;
      if (quiet === undefined) note('warn', `"${name}" split ${sname}: "collectOnly" must be true or false (it is ${JSON.stringify(s.collectOnly)}): the split is sent.`);
      splits.push({
        name: sname,
        sources: isObj(s) && Array.isArray(s.sources) ? s.sources.map(text).filter(Boolean) : [],
        earliest: isObj(s) && has(s, 'earliest') ? scalar(s.earliest) ?? '' : '',
        ...(quiet === true ? { collectOnly: true } : {}),
      });
    }
    seeUnknown(r, RACE_KEYS, 'race', `"${name}"`);
    const race = { name };
    if (has(r, 'eventNumber')) race.eventNumber = scalar(r.eventNumber) ?? '';
    race.round = has(r, 'round') && r.round !== null ? scalar(r.round) : '1';
    race.heat = has(r, 'heat') && r.heat !== null ? scalar(r.heat) : '1';
    if (has(r, 'distance')) race.distance = scalar(r.distance) ?? '';
    // no "inputPort" at all: the first RR12 port, as a new race in the panel; only null means "by contest only" (R11)
    if (has(r, 'inputPort')) race.inputPort = r.inputPort === null || r.inputPort === '' ? null : portValue(r.inputPort);
    // only a new race takes it, as a wish (R2); "false" typed in quotes is false, anything unclear is not Active
    race.active = has(r, 'active') ? boolOf(r.active) ?? false : true;
    if (has(r, 'active') && boolOf(r.active) === undefined) {
      note('warn', `"${name}": "active" must be true or false (it is ${JSON.stringify(r.active)}): it comes in not Active.`);
    }
    race.splits = splits;
    if (has(r, 'contests')) race.contests = textList(r.contests);
    if (has(r, 'finishSources')) race.finishSources = textList(r.finishSources);
    if (isObj(r.trackScore)) race.trackScore = { id: text(r.trackScore.id), live: r.trackScore.live === true, status: text(r.trackScore.status) };
    races.push(race);
  });

  const outputs = [];
  rawOutputs.forEach((o, i) => {
    if (!isObj(o)) return note('warn', `Output ${i + 1} in the file is not an output: it is left out.`);
    const name = text(o.name);
    if (!name) return note('warn', `Output ${i + 1} has no name: it is left out.`);
    // an output with no port would be TrackScore's 5555 on this PC (the default): never guessed (R11)
    if (!has(o, 'port') || o.port === null || o.port === '') {
      return note('warn', `Output "${name}" has no port: it is left out. Type its "port" in the file.`);
    }
    seeUnknown(o, OUTPUT_KEYS, 'output', `Output "${name}"`);
    const out = { name };
    if (has(o, 'enabled')) {
      // anything unclear is not taken: a new output then comes in switched off (R11), one here stays as it is
      if (boolOf(o.enabled) === undefined) note('warn', `Output "${name}": "enabled" must be true or false (it is ${JSON.stringify(o.enabled)}): it was ignored.`);
      else out.enabled = boolOf(o.enabled);
    }
    for (const k of ['mode', 'host', 'script', 'stage', 'eventNumber', 'mid']) if (has(o, k)) out[k] = scalar(o[k]);
    out.port = portValue(o.port);
    if (has(o, 'precision')) out.precision = portValue(o.precision);
    if (has(o, 'races')) {
      if (Array.isArray(o.races)) out.races = o.races.map(text).filter(Boolean);
      else {
        note('warn', `Output "${name}": its races must be a list of race names: its races are left as they are.`);
      }
    }
    outputs.push(out);
  });

  const meet = { splitRelayMeet: MEET_FORMAT, name: text(src.name).replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_MEET_NAME).trim() };
  for (const k of ['savedAt', 'savedBy', 'savedOn']) if (text(src[k])) meet[k] = text(src[k]);
  meet.races = races;
  meet.outputs = outputs;
  for (const [sec, known] of Object.entries(SECTION_KEYS)) {
    if (!has(src, sec)) continue;
    const s = src[sec];
    if (!isObj(s)) {
      note('warn', `The file's "${sec}" must be a group of settings ({ … }): it was ignored.`);
      continue;
    }
    seeUnknown(s, known, 'section', `"${sec}"`);
    const part = {};
    for (const k of known) {
      if (!has(s, k) || k === 'port') continue;
      const v = s[k];
      if (k === 'ports') part.ports = Array.isArray(v) ? v.map(portValue) : v;
      else if (k === 'columns') part.columns = Array.isArray(v) ? v.map(text) : v;
      else if (sec === 'filter') {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : NaN;
        if (Number.isFinite(n)) part[k] = n;
        else note('warn', `The file's "filter" has ${k} ${JSON.stringify(v)}, which is not a number of seconds: it was ignored.`);
      } else if (sec === 'lif' && (k === 'enabled' || k === 'fillPlaces')) {
        if (boolOf(v) === undefined) note('warn', `The file's "lif" has ${k} ${JSON.stringify(v)}, which is not true or false: it was ignored.`);
        else part[k] = boolOf(v);
      } else part[k] = typeof v === 'string' ? v.trim() : v;
    }
    // a file from before revision 7 has one port
    if (sec === 'input' && !has(s, 'ports') && has(s, 'port')) part.ports = [portValue(s.port)];
    meet[sec] = part;
  }
  // every race's port is an RR12 port of the meet, as buildMeet writes it
  const racePorts = races.map((r) => r.inputPort).filter((p) => Number.isInteger(p));
  if (racePorts.length) {
    const ports = Array.isArray(meet.input?.ports) ? [...meet.input.ports] : [];
    for (const p of racePorts) if (!ports.includes(p)) ports.push(p);
    meet.input = { ...(meet.input ?? {}), ports };
  }

  if (leftOut.length) meet.leftOut = leftOut;

  for (const u of unknown.values()) {
    const n = u.labels.length;
    const what = { race: ['race', 'races'], split: ['split', 'splits'], output: ['output', 'outputs'] }[u.kind];
    const t = u.kind === 'top' ? `The file has "${u.key}", which Split Relay doesn't know: it was ignored.`
      : u.kind === 'section' ? `The file's ${u.labels[0]} has "${u.key}", which Split Relay doesn't know: it was ignored.`
        : n === 1 ? `${u.labels[0]} has "${u.key}", which Split Relay doesn't know: it was ignored.`
          : `${n} ${what[1]} in the file have "${u.key}", which Split Relay doesn't know: it was ignored.`;
    note('info', t);
  }
  if (gunSeen) note('info', GUN_NOTE);
  return { meet, notes };
}

/** What the saved-meets list shows of a meet file. @param {any} meet */
export function meetSummary(meet) {
  return { name: text(meet?.name), savedAt: text(meet?.savedAt) || null, savedOn: text(meet?.savedOn) || null,
    races: (meet?.races ?? []).length, outputs: (meet?.outputs ?? []).length };
}

/**
 * A parsed meet (parseMeet) as a meet file again: the copy Split Relay keeps in data\meets of a file loaded with the
 * file chooser or a drop, so that it is one click next time (DESIGN 9.22 M2). It reads back as the same meet.
 * @param {any} meet parsed
 */
export function meetFileOf(meet) {
  const out = { splitRelayMeet: MEET_FORMAT, name: text(meet?.name) };
  for (const k of ['savedAt', 'savedBy', 'savedOn']) if (text(meet?.[k])) out[k] = text(meet[k]);
  out.about = MEET_ABOUT;
  out.races = (meet?.races ?? []).map(({ trackScore, ...r }) => ({
    ...r,
    splits: (r.splits ?? []).map(fileSplit),
  }));
  out.outputs = (meet?.outputs ?? []).map((o) => ({ ...o }));
  for (const k of ['input', 'filter', 'names', 'lif']) if (isObj(meet?.[k])) out[k] = structuredClone(meet[k]);
  return out;
}

/**
 * The paths a load would set that differ from the ones in use: checked on this PC before the plan (DESIGN 9.22 M7).
 * @param {any} config
 * @param {any} meet parsed
 * @returns {{ path: string, kind: 'file'|'dir' }[]}
 */
export function meetPaths(config, meet) {
  const out = [];
  const add = (p, kind) => {
    const v = text(p);
    if (v && !out.some((x) => x.path === v)) out.push({ path: v, kind });
  };
  const ppl = text(meet?.names?.pplPath);
  if (ppl && ppl !== text(config?.names?.pplPath)) add(ppl, 'file');
  const dir = text(meet?.lif?.inputDir);
  if (dir && dir !== text(config?.lif?.inputDir)) add(dir, 'dir');
  const scripts = new Set((config?.outputs ?? []).map((o) => text(o.script)));
  for (const o of meet?.outputs ?? []) if (text(o.script) && !scripts.has(text(o.script))) add(o.script, 'file');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// TrackScore

/**
 * Where TrackScore is: the host of the TrackScore output (a TCP client or UDP output with no MID and no Karmarush
 * script whose name or script says TrackScore or XCScore, else one on port 5555), or this PC.
 * @param {any} config
 * @returns {{ host: string, outputName: string|null, outputId: string|null, outputPort: number|null }}
 */
export function trackScoreHost(config) {
  const outs = (config?.outputs ?? []).filter((o) => o.mode !== 'tcp-server' && !text(o.mid) && !/karmarush/i.test(text(o.script)));
  const pick = outs.find((o) => /trackscore|xcscore/i.test(`${o.name} ${o.script}`)) ?? outs.find((o) => o.port === 5555) ?? null;
  if (!pick) return { host: '127.0.0.1', outputName: null, outputId: null, outputPort: null };
  // TrackScore listens on IPv4 (0.0.0.0): "localhost" may be tried as ::1 first
  const host = !text(pick.host) || /^localhost$/i.test(text(pick.host)) ? '127.0.0.1' : text(pick.host);
  return { host, outputName: pick.name, outputId: pick.id, outputPort: pick.port };
}

/** TrackScore's event number as FinishLynx has it: "003" -> "3" (TrackScore compares them so). */
function tsEvent(v) {
  const s = text(v);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=.)/, '') : s;
}

/**
 * TrackScore's Race Setup for its live meet -> a meet (DESIGN 9.22 M8): one race per TrackScore race, in program
 * order, with its name, event number, distance and one split per split point (hidden ones too: TrackScore's columns
 * count them), so the split columns always match TrackScore's. Never a gun time, from anything.
 * @param {{ raceSnap: any, schedule: any, meetName?: string, meetId?: string, host?: string, port?: number,
 *   outputName?: string|null }} input
 * @returns {{ meet: any, notes: Item[], source: any }} source.shownElsewhere: the race TrackScore's boards show when it
 *   is not in the list TrackScore sent ('' when the boards don't name it); absent otherwise
 */
export function trackScoreToMeet({ raceSnap, schedule, meetName = '', meetId = '', host = '127.0.0.1', port = 5000, outputName = null }) {
  const notes = [];
  const note = (tone, t) => notes.push({ kind: 'trackscore', name: '', text: t, tone });
  const all = Array.isArray(schedule?.races) ? schedule.races.filter(isObj) : [];
  const activeId = text(schedule?.activeRaceId) || null;
  const races = [];
  const byEvent = new Map();
  for (const r of all) {
    const name = text(r.name) || `Event ${tsEvent(r.filterEventNumber) || '?'}`;
    const points = Array.isArray(r.splitPoints) ? r.splitPoints.filter(isObj) : [];
    if (text(r.rtrtCategory)) {
      note('info', `TrackScore's "${name}" takes its splits from RTRT.me: it is left out.`);
      continue;
    }
    if (!points.length) {
      note('warn', `TrackScore's "${name}" has no split points: it is left out. Add its split points in TrackScore Race Setup, then set up again.`);
      continue;
    }
    if (points.length > MAX_SPLITS_SET) {
      note('warn', `TrackScore's "${name}" has ${points.length} split points; Split Relay takes at most ${MAX_SPLITS_SET}: it is left out.`);
      continue;
    }
    let en = tsEvent(r.filterEventNumber);
    if (en === '0') en = '';
    if (en && byEvent.has(en)) {
      note('bad', `TrackScore's "${byEvent.get(en)}" and "${name}" both use event ${en}: "${name}" is left out. Give each race its own event number in TrackScore Race Setup.`);
      continue;
    }
    if (en) byEvent.set(en, name);
    else {
      note('bad', `TrackScore's "${name}" has no event number: it comes in without one and not Active. Type FinishLynx's event number in TrackScore Race Setup and on the race here.`);
    }
    // one split per point, hidden ones too (TrackScore's column = its split count - laps to go)
    const splits = [];
    const seen = new Map();
    let hidden = 0;
    for (const [k, p] of points.entries()) {
      if (p.hidden === true) hidden++;
      const label = text(p.label) || text(p.distance) || `Split ${k + 1}`;
      let sname = label;
      if (seen.has(matchKey(sname))) {
        const first = seen.get(matchKey(sname));
        const dist = text(p.distance);
        sname = dist && matchKey(dist) !== matchKey(first.distance) && !seen.has(matchKey(`${label} (${dist})`)) ? `${label} (${dist})` : '';
        for (let n = 2; !sname; n++) if (!seen.has(matchKey(`${label} (${n})`))) sname = `${label} (${n})`;
        note('warn', `"${name}" has two split points called "${label}": here they are "${first.name}" and "${sname}". Check TrackScore Race Setup: two points at one place can't be told apart.`);
      }
      seen.set(matchKey(sname), { name: sname, distance: text(p.distance) });
      splits.push({ name: sname, sources: [], earliest: '' });
    }
    if (hidden) {
      note('info', `"${name}" has ${plural(hidden, 'split point')} hidden on TrackScore's boards: ${hidden === 1 ? 'it is still a split' : 'they are still splits'}, and Split Relay sends ${hidden === 1 ? 'it' : 'them'}.`);
    }
    if (text(r.watchFile)) note('warn', `TrackScore's "${name}" reads a results file: it ignores the live splits while it does.`);
    const live = !!activeId && text(r.id) === activeId;
    if (live) {
      // G12: what the boards run with now can differ from Race Setup until the race is played again
      const cfg = isObj(raceSnap?.config) ? raceSnap.config : {};
      const total = Number(cfg.totalSplits);
      if (Number.isInteger(total) && total !== points.length) {
        note('warn', `TrackScore's boards run "${name}" with ${total} splits, but its Race Setup has ${points.length}. Splits are filed by ${total} until the race is played again in TrackScore.`);
      }
      if (has(cfg, 'filterEventNumber') && tsEvent(cfg.filterEventNumber) !== tsEvent(r.filterEventNumber)) {
        note('warn', `TrackScore's boards run "${name}" with event ${tsEvent(cfg.filterEventNumber) || 'none'}, but its Race Setup has event ${tsEvent(r.filterEventNumber) || 'none'}. Splits are filed by the boards' event until the race is played again in TrackScore.`);
      }
    }
    races.push({
      name, eventNumber: en, round: '1', heat: '1', distance: text(r.finishDistance), splits,
      trackScore: { id: text(r.id), live, status: text(r.status) },
    });
  }
  if (text(schedule?.lynxDir)) {
    note('warn', `TrackScore reads results from a folder for this meet (${text(schedule.lynxDir)}): while it does, it ignores the live splits on port 5555.`);
  }
  if (schedule?.autoSwitch === false) {
    note('info', 'TrackScore\'s "Follow FinishLynx" is off: it won\'t switch to a race on Split Relay\'s splits. Press Play in TrackScore for each race.');
  }
  // G15: the meet is today's when TrackScore shows one of its races. TrackScore can answer a meet's id with another
  // meet's list: then the race its boards show is not in it
  const ids = new Set(all.map((r) => text(r.id)));
  const shown = text(raceSnap?.config?.scheduledRaceId);
  const confirmed = (!!activeId && ids.has(activeId)) || (!!shown && ids.has(shown));
  const which = text(meetName) ? ` "${text(meetName)}"` : '';
  // O36: the race TrackScore's boards show when it is not in this list ('' when the boards don't name it): the source line
  // says it too, never "not showing a race now" above this Problem
  const elsewhere = !confirmed && (shown || activeId) ? text(raceSnap?.config?.raceName) : null;
  if (elsewhere !== null) {
    note('bad', `TrackScore's boards show ${elsewhere ? `"${elsewhere}"` : 'a race'}, which is not in the races TrackScore sent for its meet${which}: ` +
      'these may be another meet\'s races. Check every race below against TrackScore\'s Race Setup before you press Apply.');
  } else if (!confirmed) {
    note('warn', `TrackScore is not showing a race of its meet${which} now, so Split Relay can't tell it is this meet. ` +
      'Check the races below are this meet\'s before you press Apply.');
  }
  const liveRace = all.find((r) => activeId && text(r.id) === activeId);
  return {
    meet: { splitRelayMeet: MEET_FORMAT, name: text(meetName), races, outputs: [] },
    notes,
    source: { kind: 'trackscore', host, port, meetId: text(meetId), meetName: text(meetName), liveRace: liveRace ? text(liveRace.name) : null,
      confirmed, outputName, races: all.length, ...(elsewhere !== null ? { shownElsewhere: elsewhere } : {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tue 14 Oct" (with the year when it is another year's), local time. */
export function dayText(ms, now = Date.now()) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${y}`;
}

const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * "Mens Race · Event 1-1-1 · 8 splits: 800M, 1500M, 2500M, 3500M, 4500M, 5500M, 6400M, 7100M · 8K · port 5565 · Active":
 * every split name, so each one can be checked before Apply (race day 2026-10-21: two names did not match TrackScore's).
 */
export function raceSummary(r) {
  const names = (r.splits ?? []).map(splitName);
  // (9.26: "9 splits + 2 not sent: 1K, ..., 4K, 4.2K (not sent), 5K, ...": the number TrackScore and Karmarush need first)
  const quiet = (r.splits ?? []).filter((s) => s.collectOnly === true).length;
  const count = quiet ? `${plural(names.length - quiet, 'split')} + ${quiet} not sent` : plural(names.length, 'split');
  const ev = raceEvent(r);
  return [r.name, ev ? `Event ${ev}` : 'no event', names.length ? `${count}: ${names.join(', ')}` : 'no splits',
    text(r.distance), Number.isInteger(r.inputPort) ? `port ${r.inputPort}` : 'by contest only', r.active ? 'Active' : 'not Active']
    .filter(Boolean).join(' · ');
}

/** "Karmarush live results · 192.168.0.30:4000 · on" */
export function outputSummary(o) {
  const where = o.mode === 'tcp-server' ? `listens on port ${o.port}` : `${o.host}:${o.port}`;
  return `${o.name} · ${where} · ${o.enabled ? 'on' : 'switched off'}`;
}

function lifWords(l) {
  const parts = [l.enabled ? 'on' : 'off'];
  if (text(l.inputDir)) parts.push(`FinishLynx folder ${l.inputDir}`);
  if (text(l.outputDir)) parts.push(`merged folder ${l.outputDir}`);
  if (l.fillPlaces) parts.push('fill in places');
  return parts.join('; ');
}

/**
 * What a meet load would do (DESIGN 9.22 M3-M6), worked out on a copy through config.js's own changes, so every check
 * and message is the panel's. Changes nothing.
 * @param {any} config the current settings (main.js `this.config`)
 * @param {any} meet parsed (parseMeet / trackScoreToMeet)
 * @param {{ mode?: 'file'|'trackscore', races?: Map<string, { reads: number, crossings: number, waiting: number,
 *   lastReadAt?: number|null }>, noRaceReads?: number, connections?: number, sentTo?: Map<string, number>,
 *   paths?: Map<string, 'yes'|'no'|'unknown'>, removeOthers?: boolean, thisPc?: string, thisPcAddresses?: string[],
 *   panelPort?: number|null,
 *   notes?: Item[], now?: number, waitingByPort?: Map<number, { raceId: string, count: number }[]>,
 *   busyPorts?: Set<number>, mergedRecent?: { dir: string, at: number } | null, lynxNames?: Map<string, string>,
 *   undo?: { at: number } | null }} [ctx] races: what each race holds (engine RaceViews); noRaceReads: reads in no
 *   race; connections: RR12 connections open; sentTo: output id -> splits in its ledgers; paths: meetPaths checked on
 *   this PC; notes: the file's or TrackScore's, shown with the rest; waitingByPort: reads on a port that wait for a race
 *   that is not Active; busyPorts: new RR12 ports another program on this PC listens on; mergedRecent: the newest .lif
 *   in the merged folder a load would start writing to; lynxNames: FinishLynx's event names of today's .lif files
 *   ("3-1-1" -> name); undo: the source is the copy kept before a load (R14); thisPc and thisPcAddresses: this PC's
 *   computer name and network addresses (an output sent there sends to this PC)
 * @returns {{ next: any, deleted: string[], added: Item[], changed: Item[], kept: Item[], attention: Item[],
 *   removable: { id: string, name: string }[], removed: Item[], nothing: boolean, offOutputs: string[],
 *   leftover: { races: string[], outputs: string[], ports: number[] } | null }}
 *   offOutputs: new outputs that came in switched off although the file had them on or did not say; leftover (undo
 *   only): what the load after that copy added and stays after this one (R1), null when nothing is left over
 */
export function planMeet(config, meet, ctx = {}) {
  const mode = ctx.mode === 'trackscore' ? 'trackscore' : 'file';
  const fromFile = mode === 'file';
  const where = fromFile ? 'in the file' : 'in TrackScore';
  const srcName = (n) => (fromFile ? `"${n}" in the file` : `TrackScore's "${n}"`);
  const stats = ctx.races instanceof Map ? ctx.races : new Map();
  const st = (id) => ({ reads: 0, crossings: 0, waiting: 0, ...(stats.get(id) ?? {}) });
  const gunOf = (r) => text(r?.gun);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const inUse = (r) => {
    const s = st(r.id);
    return s.reads > 0 || s.crossings > 0 || s.waiting > 0 || gunOf(r) !== '';
  };
  const hasData = (r) => {
    const s = st(r.id);
    return s.reads > 0 || s.crossings > 0 || s.waiting > 0;
  };
  const why = (r) => {
    const s = st(r.id);
    return s.reads > 0 || s.crossings > 0 ? 'has reads' : gunOf(r) ? 'has its gun time' : 'has reads waiting for it';
  };
  // a gun with nothing behind it: no reads, and no clock running (a gun left from an earlier day, or a race long over)
  const staleGun = (r) => gunOf(r) !== '' && !hasData(r) && !(r.active !== false && raceClockRunning(r, now));
  // R2: running = Active with a gun, from the gun on (before the first split too), while it has splits to send or its
  // clock is under 30 minutes; a gun from an earlier day with no reads holds nothing back (O20)
  const running = config.races.filter((r) => r.active !== false && gunOf(r) && !staleGun(r));
  const runningWords = () => {
    const names = listText(running.map((r) => r.name));
    if (running.every((r) => raceRunning(r, st(r.id).lastReadAt, now))) return `${names} ${running.length === 1 ? 'is' : 'are'} running`;
    return running.length === 1 ? `${names} has its gun time and reads` : `${names} have their gun times and reads`;
  };
  const paths = ctx.paths instanceof Map ? ctx.paths : new Map();
  const pathState = (p) => paths.get(p) ?? 'yes';
  // R16: reads on a port that wait for a race that is not Active go to the race made Active there
  const waitingOn = (port, exceptId = null) => (Number.isInteger(port) && ctx.waitingByPort instanceof Map
    ? (ctx.waitingByPort.get(port) ?? []).filter((w) => w.count > 0 && w.raceId !== exceptId) : []);
  const waitingWords = (port, w) => {
    const n = w.reduce((x, y) => x + y.count, 0);
    const names = listText([...new Set(w.map((y) => config.races.find((r) => r.id === y.raceId)?.name ?? y.raceName ?? 'a race'))]);
    return `${plural(n, 'read')} on port ${port} ${n === 1 ? 'waits' : 'wait'} for ${names}, which ${w.length === 1 ? 'is' : 'are'} not Active`;
  };

  let next = structuredClone(config);
  /** @type {Item[]} */ const added = [];
  /** @type {Item[]} */ const changed = [];
  /** @type {Item[]} */ const kept = [];
  /** @type {Item[]} */ const attention = [...(ctx.notes ?? [])];
  /** @type {Item[]} */ const removed = [];
  const deleted = [];
  const noChange = [];
  const say = (tone, t, extra = {}) => attention.push({ kind: 'note', name: '', ...extra, text: t, tone });
  const attempt = (fn, fail) => {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      fail(err.errors.join(' '));
    }
  };
  // this PC by its name and network addresses too: an output sent there reaches this PC's own ports
  const pcNames = [ctx.thisPc, ...(Array.isArray(ctx.thisPcAddresses) ? ctx.thisPcAddresses : [])].filter((n) => text(n));
  const pathNote = (p, what) => (pathState(p) === 'unknown'
    ? `Split Relay couldn't check ${p} (no answer in 1.5 s).`
    : what === 'folder' ? `The FinishLynx folder ${p} can't be reached from this PC.` : `The names file ${p} is not on this PC.`);

  // what holds settings back (R4, R7): a race in use for the tag filter, the .lif settings and the names file (not a gun
  // left with no reads: there is nothing to work out again); any read or an RR12 connection for the SR line format
  const used = config.races.filter((r) => inUse(r) && !staleGun(r));
  const usedWhy = () => (used.length === 1 ? `${used[0].name} ${why(used[0])}` : `${used.length} races here have reads or a gun time`);
  const raceReads = config.races.reduce((n, r) => n + st(r.id).reads, 0);
  const srWhy = raceReads > 0 ? usedWhy()
    : (ctx.noRaceReads ?? 0) > 0 ? `Split Relay has ${plural(ctx.noRaceReads, 'read')} in no race`
      : (ctx.connections ?? 0) > 0 ? 'RR12 is connected' : '';

  // ---- settings ----------------------------------------------------------------------------------------------
  const wantName = text(meet.name);
  const curName = text(next.meet?.name);
  if (wantName && wantName !== curName && (fromFile || !curName)) {
    attempt(() => {
      next = updateSettings(next, { meet: { name: wantName } });
      changed.push({ kind: 'setting', name: 'Meet name', text: `Meet name: ${wantName} (was ${curName || 'none'})` });
    }, (e) => say('warn', `The meet name was not changed: ${e}`));
  }

  if (fromFile && Array.isArray(meet.input?.ports)) {
    const cur = inputPorts(next);
    const want = [];
    for (const p of meet.input.ports) if (!cur.includes(p) && !want.includes(p)) want.push(p);
    const panelPort = Number.isInteger(ctx.panelPort) ? ctx.panelPort : null;
    for (const p of want.filter((x) => x === panelPort)) {
      say('bad', `The RR12 input port and the control panel port are both ${p}. Use two different ports.`, { kind: 'port', name: String(p) });
    }
    const usersOf = (p) => meet.races.filter((r) => r.inputPort === p).map((r) => r.name);
    // R18: never TrackScore's timing ports or a port an output sends to on this PC (config.js says why, as Settings does)
    const refused = new Set();
    for (const p of want) {
      const why = p === panelPort ? null : inputPortProblem(next, p, { names: pcNames });
      if (!why) continue;
      refused.add(p);
      const users = usersOf(p);
      say('bad', `${why} It is not added${users.length ? `, so ${listText(users)} ${users.length === 1 ? 'is' : 'are'} left out` : ''}. Choose another port in the file.`,
        { kind: 'port', name: String(p) });
    }
    const add = want.filter((p) => p !== panelPort && !refused.has(p));
    if (add.length && cur.length + add.length > MAX_INPUT_PORTS) {
      say('bad', `The file needs RR12 ports ${add.join(', ')}; Split Relay listens on at most ${MAX_INPUT_PORTS}: they are not added. ` +
        'Races on them are left out.', { kind: 'port', name: '' });
    } else if (add.length) {
      attempt(() => {
        next = updateSettings(next, { input: { ports: [...cur, ...add] } });
        for (const p of add) {
          const users = usersOf(p);
          added.push({ kind: 'port', name: String(p), text: `RR12 input port ${p}${users.length ? ` (${listText(users)} ${users.length === 1 ? 'reads' : 'read'} from it)` : ''}` });
          // R17: another program (another copy of Split Relay?) listens there: RR12's reads would not reach this one
          if (ctx.busyPorts instanceof Set && ctx.busyPorts.has(p)) {
            say('bad', `Port ${p} is already in use by another program on this PC: Split Relay can't receive RR12 reads on it. ` +
              'Is another copy of Split Relay running? Close it first, then load again.', { kind: 'port', name: String(p), href: '#inputs' });
          }
        }
      }, (e) => say('warn', `The RR12 input ports were not changed: ${e}`, { href: '#settings/input' }));
    }
  }

  if (fromFile && isObj(meet.input)) {
    const sr = {};
    for (const k of ['delimiter', 'tag', 'columns']) {
      if (has(meet.input, k) && JSON.stringify(meet.input[k]) !== JSON.stringify(next.input[k])) sr[k] = meet.input[k];
    }
    if (Object.keys(sr).length) {
      if (srWhy) {
        say('warn', `${srWhy}, so the RR12 SR line format stays as it is: changed now, the lines coming in would be bad lines. ` +
          'Change it on the Inputs page if you mean to.', { href: '#settings/sr' });
      } else {
        attempt(() => {
          next = updateSettings(next, { input: sr });
          changed.push({ kind: 'setting', name: 'SR line format', text: 'RR12 SR line format (advanced)' });
        }, (e) => say('warn', `The RR12 SR line format was not changed: ${e}`, { href: '#settings/sr' }));
      }
    }
  }

  if (fromFile && isObj(meet.filter)) {
    const f = next.filter;
    const diff = {};
    for (const k of ['tagWindowSec', 'holdSec', 'startIgnoreSec']) if (has(meet.filter, k) && meet.filter[k] !== f[k]) diff[k] = meet.filter[k];
    if (Object.keys(diff).length) {
      const w = { ...f, ...diff };
      if (used.length) {
        say('warn', `${usedWhy()}, so the tag filter stays as it is (here: window ${fmtSec(f.tagWindowSec)}, hold ${fmtSec(f.holdSec)}, ` +
          `start ${fmtSec(f.startIgnoreSec)}; in the file: ${fmtSec(w.tagWindowSec)}, ${fmtSec(w.holdSec)}, ${fmtSec(w.startIgnoreSec)}). ` +
          'Change it in Settings if you mean to.', { href: '#settings/filter' });
      } else {
        attempt(() => {
          next = updateSettings(next, { filter: diff });
          const words = { tagWindowSec: 'window', holdSec: 'hold', startIgnoreSec: 'start area' };
          changed.push({ kind: 'setting', name: 'Tag filter', text: `Tag filter: ${Object.keys(diff).map((k) => `${words[k]} ${fmtSec(next.filter[k])} (was ${fmtSec(f[k])})`).join(', ')}` });
        }, (e) => say('warn', `The tag filter was not changed: ${e}`, { href: '#settings/filter' }));
      }
    }
  }

  if (fromFile && isObj(meet.lif)) {
    const l = next.lif;
    const diff = {};
    for (const k of ['enabled', 'inputDir', 'outputDir', 'fillPlaces']) if (has(meet.lif, k) && meet.lif[k] !== l[k]) diff[k] = meet.lif[k];
    if (Object.keys(diff).length) {
      const dir = text(diff.inputDir);
      if (used.length) {
        say('warn', `${usedWhy()}, so the merged .lif settings stay as they are (here: ${lifWords(l)}; in the file: ${lifWords({ ...l, ...diff })}). ` +
          'Change them in Settings if you mean to.', { href: '#settings/lif' });
      } else if (dir && pathState(dir) !== 'yes' && text(l.inputDir)) {
        say('warn', `${pathNote(dir, 'folder')} ${l.inputDir} stays, and so do the other merged .lif settings.`, { href: '#settings/lif' });
      } else {
        attempt(() => {
          next = updateSettings(next, { lif: diff });
          changed.push({ kind: 'setting', name: 'Merged .lif files', text: `Merged .lif files: ${lifWords(next.lif)} (was ${lifWords(l)})` });
          if (dir && pathState(dir) !== 'yes') say('warn', `${pathNote(dir, 'folder')} It is set anyway: choose the right one in Settings.`, { href: '#settings/lif' });
          // R15: last year's folder can still be on this laptop: its finishers would get no more splits today
          if (dir && pathState(dir) === 'yes') {
            say('warn', `The FinishLynx folder ${dir} comes from the meet file: make sure it is this meet's. FinishLynx's ` +
              'results there tell Split Relay who has finished, and those bibs get no more splits.', { href: '#settings/lif' });
          }
          // R17: a merged folder another copy of Split Relay writes to: the two would write over each other's files
          const out = text(next.lif.outputDir);
          const m = ctx.mergedRecent;
          if (next.lif.enabled && out && !(l.enabled && text(l.outputDir) === out) && m && m.dir === out && Number.isFinite(m.at)) {
            const mins = Math.max(0, Math.round((now - m.at) / 60_000));
            say('warn', `A merged .lif file in ${out} was written ${mins < 1 ? 'less than a minute' : plural(mins, 'minute')} ago, not by this Split Relay. ` +
              'If another copy of Split Relay writes there, the two write over each other\'s files: close the other copy first.', { href: '#settings/lif' });
          }
        }, (e) => say('warn', `The merged .lif settings were not changed: ${e}`, { href: '#settings/lif' }));
      }
    }
  }

  if (fromFile && has(meet.names, 'pplPath')) {
    const want = text(meet.names.pplPath);
    const cur = text(next.names.pplPath);
    if (want !== cur) {
      if (cur && used.length) {
        say('warn', `The names file stays ${cur} (the file has ${want || 'none'}). Choose it in Settings if you mean to.`, { href: '#settings/names' });
      } else if (want && pathState(want) !== 'yes' && cur) {
        say('warn', `${pathNote(want, 'file')} ${cur} stays.`, { href: '#settings/names' });
      } else {
        attempt(() => {
          next = updateSettings(next, { names: { pplPath: want } });
          changed.push({ kind: 'setting', name: 'Names file', text: `Names file: ${want || 'none'} (was ${cur || 'none'})` });
          if (want && pathState(want) !== 'yes') say('warn', `${pathNote(want, 'file')} It is set anyway: choose the right one in Settings.`, { href: '#settings/names' });
          if (want && pathState(want) === 'yes') say('warn', `The names file ${want} comes from the meet file: make sure it is this meet's.`, { href: '#settings/names' });
        }, (e) => say('warn', `The names file was not changed: ${e}`, { href: '#settings/names' }));
      }
    }
  }

  // ---- races: match first (name AND event must agree on one race), then change the matched ones, then add -----------
  const existing = config.races;
  const keyOf = (r) => (fromFile ? raceEvent(r) : enKey(r.eventNumber));
  const claims = new Map();
  const conflictIds = new Set();
  /** @type {{ S: any, M: any, by: 'both'|'name'|'event' }[]} */
  const matched = [];
  const fresh = [];
  for (const S of meet.races) {
    const lk = looseKey(S.name);
    const N = lk ? existing.filter((r) => looseKey(r.name) === lk) : [];
    const sk = has(S, 'eventNumber') ? keyOf(S) : '';
    const E = sk ? existing.filter((r) => keyOf(r) === sk) : [];
    const U = [...new Set([...N, ...E])];
    if (!U.length) {
      fresh.push(S);
      continue;
    }
    const conflict = (t) => {
      for (const r of U) conflictIds.add(r.id);
      say('bad', t, { kind: 'race', name: S.name });
    };
    const evWords = (r) => (raceEvent(r) ? `Event ${raceEvent(r)}` : 'no event');
    if (U.length === 1) {
      const M = U[0];
      const byName = N.includes(M);
      const byEvent = E.includes(M);
      if (!fromFile && byName && !byEvent && sk && enKey(M.eventNumber) && enKey(M.eventNumber) !== sk) {
        conflict(`TrackScore's "${S.name}" is event ${sk}, but Split Relay's "${M.name}" is ${evWords(M)}. It is left out: make the ` +
          'event numbers agree (FinishLynx\'s is the right one), then set up again.');
      } else if (claims.has(M.id)) {
        say('bad', `${srcName(claims.get(M.id).name)} and "${S.name}" both fit "${M.name}" here: "${S.name}" is left out.`, { kind: 'race', name: S.name, raceId: M.id });
      } else {
        claims.set(M.id, S);
        matched.push({ S, M, by: byName && byEvent ? 'both' : byName ? 'name' : 'event' });
      }
      continue;
    }
    if (N.length === 1 && E.length === 1) {
      const [A] = N;
      const [B] = E;
      conflict(fromFile
        ? `"${S.name}" in the file is Event ${sk}, but here "${A.name}" is ${evWords(A)} and Event ${sk} is "${B.name}". It is left out: ` +
          'fix the name or the event of one of them, then load again.'
        : `TrackScore's "${S.name}" is event ${sk}, but Split Relay's "${A.name}" is ${evWords(A)} and event ${sk} is "${B.name}" here. ` +
          'It is left out: make the event numbers agree (FinishLynx\'s is the right one), then set up again.');
    } else {
      conflict(`${fromFile ? `"${S.name}" in the file` : `TrackScore's "${S.name}"`} fits ${U.length} races here ` +
        `(${U.map((r) => `"${r.name}"`).join(', ')}). It is left out: rename one of them, then ${fromFile ? 'load' : 'set up'} again.`);
    }
  }

  /** source race -> its race id here, for the outputs' race names */
  const idOf = new Map();
  for (const { S, M, by } of matched) {
    idOf.set(S, M.id);
    const use = inUse(M);
    const body = {};
    const changes = [];
    const heldBack = [];
    /** Check lines about this race, said after what is held back */
    const checks = [];
    let countDiffers = false;
    if (fromFile && S.name !== M.name) {
      // R3: a race in use keeps its name: every packet and its merged .lif carry it, and it may be FinishLynx's own
      if (use) heldBack.push(`name "${S.name}" ${where}`);
      else {
        body.name = S.name;
        changes.push(`name "${S.name}" (was "${M.name}")`);
      }
    }
    if (has(S, 'distance') && S.distance !== M.distance && (fromFile || text(S.distance))) {
      if (use) heldBack.push(`distance ${text(S.distance) || 'none'} ${where}`);
      else {
        body.distance = S.distance;
        changes.push(`distance ${text(S.distance) || 'none'} (was ${text(M.distance) || 'none'})`);
      }
    }
    const hadTiming = M.splits.some((m) => (m.sources ?? []).length || text(m.earliest));
    // 9.26: TrackScore knows only the splits that are sent: its split points are compared with, and map in order onto,
    // the race's SENT splits; the ones that are counted but not sent stay where they are (after the same sent split).
    // A meet file says for every split whether it is sent, so it is compared with all of them.
    const quiet = fromFile ? [] : M.splits.filter((m) => m.collectOnly === true);
    const Mx = fromFile ? M.splits : sentSplits(M);
    /** a split of this race as a complete split for the race editor's list (config.js raceFromBody) */
    const asBody = (m) => ({ id: m.id, name: m.name, sources: [...(m.sources ?? [])], earliest: m.earliest ?? '', collectOnly: m.collectOnly === true });
    if (quiet.length && S.splits.length) {
      const one = quiet.length === 1;
      checks.push(`${M.name}: ${listText(quiet.map((m) => m.name), 6)} ${one ? 'is' : 'are'} counted, not sent, so TrackScore has no split point for ${one ? 'it' : 'them'}: ` +
        `${one ? 'it stays where it is' : 'they stay where they are'}, and TrackScore's ${plural(S.splits.length, 'split point')} are compared with the ${plural(Mx.length, 'split')} that ${Mx.length === 1 ? 'is' : 'are'} sent.`);
    }
    if (!S.splits.length) {
      // O12: a race with no splits sends nothing; a file that has none for it keeps the ones here
      if (M.splits.length) {
        checks.push(`${srcName(S.name)} has no splits: ${M.name} keeps its ${plural(M.splits.length, 'split')} (${splitNames(M)}). ` +
          `Give the race its splits ${fromFile ? 'in the file' : "in TrackScore's Race Setup"} if that is a mistake.`);
      }
    } else if (S.splits.length === Mx.length) {
      // a rename keeps each split's id (its crossings, deliveries and Pause) by position; the names are the source's,
      // exactly (O4: "800m" here and "800M" in TrackScore become "800M", so the list is not half one way, half the other)
      const renames = [];
      const cased = [];
      let moved = false;
      let timing = false;
      let early = false;
      // (9.26: a file that sends a split this race only counts, or the other way round)
      let sentChange = false;
      let at = 0;
      const splits = M.splits.map((m, k) => {
        // (9.26: from TrackScore, a split that is not sent has no split point there: it stays as it is, where it is)
        if (!fromFile && m.collectOnly === true) return asBody(m);
        const s = S.splits[at++];
        if (fromFile && (s.collectOnly === true) !== (m.collectOnly === true)) sentChange = true;
        if (s.name !== m.name) {
          if (matchKey(s.name) === matchKey(m.name)) cased.push(s.name);
          else {
            renames.push(`split ${k + 1} ${m.name} → ${s.name}`);
            // O9: a name another split has here: the source has the splits in another order
            if (M.splits.some((o, j) => j !== k && matchKey(o.name) === matchKey(s.name))) moved = true;
          }
        }
        if (fromFile && !sameTexts(s.sources, m.sources)) timing = true;
        if (fromFile && text(s.earliest) !== text(m.earliest)) early = true;
        // complete splits: the race editor's list replaces the old one wholesale (config.js raceFromBody)
        return { ...asBody(m), name: s.name };
      });
      /** the source's split for a split of the list (a not-sent one from TrackScore has none) */
      const srcOf = new Map();
      {
        let i = 0;
        splits.forEach((x, k) => { if (fromFile || M.splits[k].collectOnly !== true) srcOf.set(x, S.splits[i++]); });
      }
      let named = renames.length > 0 || cased.length > 0;
      if (moved && use) {
        // its reads would be shown under the wrong names (crossings, Review, the merged .lif): held, with a Check
        named = false;
        splits.forEach((x, k) => { x.name = M.splits[k].name; });
        heldBack.push(`the split names (${where} they are in another order: ${splitNames(S)}; its reads would show under the wrong names)`);
      } else {
        if (moved) {
          checks.push(`${srcName(S.name)} has the split names in another order (${splitNames(S)}; here ${splitNames(M)}): ` +
            `check ${fromFile ? 'the file' : "TrackScore's Race Setup"}. Split 1 is always the first pass over the mats.`);
        }
        if (renames.length) changes.push(renames.join(', '));
        if (cased.length) changes.push(`split names written as ${fromFile ? 'in the file' : 'in TrackScore'}: ${cased.join(', ')}`);
      }
      if ((timing || early) && use) {
        if (timing) heldBack.push('timing points');
        if (early) heldBack.push('earliest times');
      } else if (timing || early) {
        for (const [x, src] of srcOf) {
          x.sources = [...src.sources];
          x.earliest = src.earliest;
        }
        if (timing) changes.push('timing points');
        if (early) changes.push('earliest times');
      }
      // 9.26: which splits are sent changes the laps to go of the others: like the number of splits, it stays on a race
      // in use (the race's page asks first)
      if (sentChange && use) {
        countDiffers = true;
        heldBack.push(`which splits are sent (here: ${splitNames(M)}; ${where}: ${splitNames(S)})`);
      } else if (sentChange) {
        const now = [];
        const back = [];
        for (const [x, src] of srcOf) {
          const q = src.collectOnly === true;
          if (q !== x.collectOnly) (q ? now : back).push(x.name);
          x.collectOnly = q;
        }
        if (now.length) changes.push(`${listText(now, 6)} counted, not sent`);
        if (back.length) changes.push(`${listText(back, 6)} sent again`);
      }
      if (named || ((timing || early || sentChange) && !use)) body.splits = splits;
    } else if (use) {
      countDiffers = true;
      heldBack.push(quiet.length
        ? `the number of splits and their names (${Mx.length} sent here: ${splitNames(Mx)}; ${S.splits.length} ${where}: ${splitNames(S)})`
        : `the number of splits and their names (${M.splits.length} here: ${splitNames(M)}; ${S.splits.length} ${where}: ${splitNames(S)})`);
    } else {
      // R4: an old split's id, Pause, timing points and earliest time go to the new split with its name, never by
      // position: a point inserted in TrackScore would otherwise get the next point's mats and earliest time
      const free = [...Mx];
      const bare = [];
      const list = S.splits.map((s) => {
        const i = free.findIndex((m) => matchKey(m.name) === matchKey(s.name));
        const old = i >= 0 ? free.splice(i, 1)[0] : null;
        if (fromFile) return { ...(old ? { id: old.id } : {}), name: s.name, sources: [...s.sources], earliest: s.earliest, collectOnly: s.collectOnly === true };
        if (old) return { ...asBody(old), name: s.name };
        bare.push(s.name);
        return { name: s.name, sources: [], earliest: '', collectOnly: false };
      });
      // 9.26: from TrackScore, each split that is counted but not sent goes back after the sent split it came after
      // (the nearest one before it that is still in the list; first when there is none)
      const after = new Map();
      M.splits.forEach((m, k) => {
        if (!quiet.includes(m)) return;
        let a = '';
        for (let i = k - 1; i >= 0 && !a; i--) if (M.splits[i].collectOnly !== true && list.some((x) => x.id === M.splits[i].id)) a = M.splits[i].id;
        (after.get(a) ?? after.set(a, []).get(a)).push(asBody(m));
      });
      body.splits = [...(after.get('') ?? [])];
      for (const x of list) body.splits.push(x, ...(x.id ? after.get(x.id) ?? [] : []));
      // O25: every name, old and new: a split renamed while another is added is seen here
      changes.push(quiet.length
        ? `${plural(S.splits.length, 'split')}: ${splitNames(S)} (was ${Mx.length} sent: ${splitNames(Mx)}); ${listText(quiet.map((m) => m.name), 6)} still counted, not sent: ${splitNames(body.splits)}`
        : `${plural(S.splits.length, 'split')}: ${splitNames(S)} (was ${M.splits.length}: ${splitNames(M)})`);
      if (!fromFile && hadTiming && bare.length) changes.push(`timing points and earliest times cleared on ${listText(bare, 6)}`);
    }
    if (fromFile && has(S, 'eventNumber')) {
      const sk = raceEvent(S);
      const mk = raceEvent(M);
      if (sk !== mk) {
        if (use) heldBack.push(`event (${mk || 'none'} here, ${sk || 'none'} ${where})`);
        else {
          Object.assign(body, { eventNumber: S.eventNumber, round: S.round, heat: S.heat });
          changes.push(`Event ${sk || 'none'} (was ${mk || 'none'})`);
        }
      }
    } else if (!fromFile && !enKey(M.eventNumber) && enKey(S.eventNumber)) {
      if (use) heldBack.push(`event (none here, ${S.eventNumber} ${where})`);
      else {
        body.eventNumber = S.eventNumber;
        changes.push(`Event ${eventKey(S.eventNumber, M.round, M.heat)} (was none)`);
      }
    }
    if (fromFile && has(S, 'inputPort') && S.inputPort !== M.inputPort) {
      const waits = M.active !== false ? waitingOn(S.inputPort, M.id) : [];
      if (use) heldBack.push(`RR12 port (${portWord(M.inputPort)} here, ${portWord(S.inputPort)} ${where})`);
      else if (Number.isInteger(S.inputPort) && !inputPorts(next).includes(S.inputPort)) {
        say('warn', `${M.name} stays on port ${portWord(M.inputPort)}: port ${S.inputPort} is not an RR12 input port here.`, { kind: 'race', name: M.name, raceId: M.id });
      } else if (waits.length) {
        // R16: Active on that port, it would take reads that wait for another race
        checks.push(`${M.name} stays on port ${portWord(M.inputPort)}: ${waitingWords(S.inputPort, waits)}, and ${M.name} (Active) would take them. ` +
          'Change its port on its page when you know whose they are.');
      } else {
        body.inputPort = S.inputPort;
        changes.push(`RR12 port ${portWord(S.inputPort)} (was ${portWord(M.inputPort)})`);
      }
    }
    for (const [k, word] of [['contests', 'contests'], ['finishSources', 'finish timing points']]) {
      if (!fromFile || !has(S, k)) continue;
      if (Array.isArray(S[k]) && sameTexts(S[k], M[k])) continue;
      if (use) heldBack.push(word);
      else {
        body[k] = S[k];
        changes.push(k === 'contests' && Array.isArray(S[k])
          ? `contests ${S[k].join(', ') || 'none'} (was ${(M.contests ?? []).join(', ') || 'none'})` : word);
      }
    }
    if (heldBack.length) {
      say('warn', `${M.name} ${why(M)}, so these stay as they are: ${heldBack.join(', ')}. Change them on the race's page: it asks first.` +
        (countDiffers ? ' Until the numbers of splits agree, TrackScore puts this race\'s splits in the wrong columns.' : '') +
        // O8: a gun left from an earlier day holds the race as if it ran
        (staleGun(M) ? ` If its gun time ${gunOf(M)} is an earlier day's, clear it on the race's page, then load again: the rest changes too.` : ''),
      { kind: 'race', name: M.name, raceId: M.id });
    }
    // R9: a match that is not by name AND event is said, so the operator sees which race here is changed (O10: from a
    // file too: event numbers repeat every meet, and the name must be exactly FinishLynx's event name)
    if (!fromFile && by !== 'both') {
      const ev = (r) => (enKey(r.eventNumber) ? `event ${enKey(r.eventNumber)}` : 'no event number');
      checks.push(`TrackScore's "${S.name}" (${ev(S)}) is set up on "${M.name}" here (${ev(M)}): ` +
        `${changes.length ? 'its splits change, its name stays' : 'nothing changes on it'}.`);
    } else if (fromFile && by === 'event') {
      checks.push(`"${S.name}" in the file is loaded onto "${M.name}" here: the same event (${raceEvent(M)}), another name. ` +
        (body.name ? `Its name becomes "${S.name}": it must be exactly FinishLynx's event name.` : `Its name stays "${M.name}".`));
    } else if (fromFile && by === 'name' && has(S, 'eventNumber') && raceEvent(S) !== raceEvent(M)) {
      checks.push(`"${S.name}" in the file is loaded onto "${M.name}" here: the same name, another event (${raceEvent(S) || 'none'} in the file, ` +
        `${raceEvent(M) || 'none'} here). ${body.eventNumber !== undefined ? 'Its event changes: it must be FinishLynx\'s.' : 'Its event stays.'}`);
    }
    for (const t of checks) say('warn', t, { kind: 'race', name: M.name, raceId: M.id });
    let same = false;
    if (Object.keys(body).length) {
      attempt(() => {
        next = updateRace(next, M.id, body).config;
        changed.push({ kind: 'race', name: M.name, raceId: M.id, text: `${M.name}: ${changes.join('; ')}` });
      }, (e) => say('warn', `${M.name} was not changed: ${e}`, { kind: 'race', name: M.name, raceId: M.id }));
    } else same = !heldBack.length && !checks.length;
    const s = st(M.id);
    const keeps = s.reads > 0 || gunOf(M)
      ? [s.reads > 0 ? `its ${s.reads === 1 ? '1 read' : `${s.reads.toLocaleString('en-US')} reads`}` : '', gunOf(M) ? `its gun ${gunOf(M)}` : ''].filter(Boolean).join(' and ')
      : s.waiting > 0 ? `the ${plural(s.waiting, 'read')} waiting for it` : '';
    // O29: one line for a race, not "keeps its reads" and again under "No change"
    if (keeps) kept.push({ kind: 'race', name: M.name, raceId: M.id, text: same ? `${M.name}: no change, and it keeps ${keeps}.` : `${M.name} keeps ${keeps}.` });
    else if (same) noChange.push(M.name);
  }

  // New races. TrackScore's live race is made Active first, then the upcoming ones in program order (one Active race
  // per port); they are added in program order all the same.
  const isLive = (S) => S.trackScore?.live === true;
  const upcoming = (S) => !isLive(S) && S.trackScore?.status === 'upcoming';
  const order = fromFile ? fresh : [...fresh.filter(isLive), ...fresh.filter(upcoming), ...fresh.filter((S) => !isLive(S) && !upcoming(S))];
  // O19: the port most races here read from, when it is an RR12 port, else the first RR12 port
  const usual = (() => {
    const ports = inputPorts(next);
    const count = new Map();
    for (const r of next.races) if (ports.includes(r.inputPort)) count.set(r.inputPort, (count.get(r.inputPort) ?? 0) + 1);
    let best = ports[0] ?? null;
    for (const [p, n] of count) if (n > (count.get(best) ?? 0)) best = p;
    return best;
  })();
  const addedItems = new Map();
  /** TrackScore's races named as FinishLynx's file names them (O3), and the ones that keep TrackScore's name */
  const lynxNamed = [];
  const tsNamed = [];
  for (const S of order) {
    let name = S.name;
    if (!fromFile) {
      // O3: FinishLynx's own name for the event when its file of today is there ("Mens Race", not "Men's Race"), unless
      // a race here already has that name
      const lynx = ctx.lynxNames instanceof Map && enKey(S.eventNumber) ? text(ctx.lynxNames.get(eventKey(S.eventNumber, '1', '1'))) : '';
      if (lynx && lynx !== S.name && !next.races.some((r) => looseKey(r.name) === looseKey(lynx))) {
        name = lynx;
        lynxNamed.push({ name, ts: S.name, event: enKey(S.eventNumber) });
      } else tsNamed.push(S.name);
    }
    // (9.26: a file says which splits are counted but not sent; TrackScore's split points are all sent)
    const body = { name, round: S.round, heat: S.heat, splits: S.splits.map((s) => ({ name: s.name, sources: [...s.sources], earliest: s.earliest, collectOnly: s.collectOnly === true })) };
    for (const k of ['eventNumber', 'distance', 'contests', 'finishSources']) if (has(S, k)) body[k] = S[k];
    let port;
    if (has(S, 'inputPort')) port = body.inputPort = S.inputPort;
    else {
      port = usual;
      if (port !== (inputPorts(next)[0] ?? null)) body.inputPort = port;
    }
    const wish = fromFile ? S.active !== false : true;
    let notActive = '';
    // O27: the button the operator sees ("Switch to Mens Race…" on the Dashboard)
    const switchWords = `Press “Switch to ${name}…” when it starts.`;
    if (wish) {
      const waits = waitingOn(port);
      if (!fromFile && !enKey(S.eventNumber)) notActive = 'it has no event number.';
      // O12: a race with no splits sends nothing, and Active it would take its port's reads
      else if (!S.splits.length) notActive = `it has no splits ${where}. Add its splits on its page first.`;
      // R16: Active, it would take reads that wait for a race that is not Active (say one with its gun)
      else if (waits.length) notActive = `${waitingWords(port, waits)}, and an Active ${name} would take them. Make the right race Active when you know whose they are.`;
      else {
        const candidate = { contests: Array.isArray(S.contests) ? S.contests : [], inputPort: Number.isInteger(port) ? port : null,
          eventNumber: S.eventNumber ?? '', round: S.round, heat: S.heat };
        for (const r of next.races) {
          if (r.active === false) continue;
          const c = raceClashes(candidate, r);
          if (!c.length) continue;
          const k = c[0];
          notActive = k.kind === 'port' ? `port ${k.port} already feeds the Active race '${r.name}'. ${switchWords}`
            : k.kind === 'contest' ? `contest "${k.contest}" already belongs to the Active race '${r.name}'. ${switchWords}`
              : k.kind === 'every' ? `the Active race '${r.name}' already takes every contest. ${switchWords}`
                : `the Active race '${r.name}' already uses Event ${k.event}.`;
          break;
        }
      }
    }
    body.active = wish && !notActive;
    attempt(() => {
      const r = addRace(next, body);
      next = r.config;
      idOf.set(S, r.race.id);
      addedItems.set(S, { kind: 'race', name, text: raceSummary(r.race) });
      // a Check when it is about its reads or its splits; a Note when another race simply has the port now
      if (wish && notActive) say(waitingOn(port).length || !S.splits.length ? 'warn' : 'info', `${name} comes in not Active: ${notActive}`, { kind: 'race', name });
      else if (!S.splits.length) say('warn', `${name} has no splits ${where}: it sends nothing until its splits are added on its page.`, { kind: 'race', name });
    }, (e) => say('warn', `${name} is left out: ${e}`, { kind: 'race', name }));
  }
  const newIds = fresh.map((S) => idOf.get(S)).filter(Boolean);
  if (!fromFile && newIds.length) {
    // in TrackScore's program order, after the races that were here
    const set = new Set(newIds);
    next.races = [...next.races.filter((r) => !set.has(r.id)), ...newIds.map((id) => next.races.find((r) => r.id === id))];
  }
  for (const S of fresh) if (addedItems.has(S)) added.push(addedItems.get(S));
  if (!fromFile && newIds.length) {
    for (const x of lynxNamed) {
      say('info', `"${x.name}" is TrackScore's "${x.ts}", named as in FinishLynx's file for event ${x.event}.`, { kind: 'race', name: x.name });
    }
    // in program order
    const named = fresh.filter((S) => idOf.has(S) && tsNamed.includes(S.name)).map((S) => S.name);
    if (named.length) {
      say('info', `${listText(named)} ${named.length === 1 ? 'takes' : 'take'} TrackScore's name${named.length === 1 ? '' : 's'}. ` +
        `Each must be exactly FinishLynx's event name: rename ${named.length === 1 ? 'it' : 'them'} on ${named.length === 1 ? 'its' : 'their'} page if not.`);
    }
    const ts = trackScoreHost(next);
    const out = ts.outputId ? next.outputs.find((o) => o.id === ts.outputId) : null;
    if (out && out.races.length) {
      const names = out.races.map((id) => next.races.find((r) => r.id === id)?.name).filter(Boolean);
      say('info', `The output ${out.name} sends only ${listText(names) || 'a race that was deleted'}: the new races are not sent to it until you add them in Outputs.`,
        { kind: 'output', name: out.name, outputId: out.id, href: `#outputs/${out.id}` });
    }
  }

  // ---- outputs (a meet file only) ----------------------------------------------------------------------------
  const savedAt = Date.parse(meet.savedAt ?? '');
  const earlierDay = Number.isFinite(savedAt) && startOfDay(savedAt) < startOfDay(now);
  // the day it was saved, when not today: an old file may have last meet's MID
  const savedWhen = earlierDay ? ` (saved ${dayText(savedAt, now)})` : '';
  const midCheck = (name, mid) => say('warn', `${name} meet number ${mid} comes from the file${savedWhen}: make sure it is this meet's.`, { kind: 'output', name });
  const racesWord = (ids) => {
    if (!ids.length) return 'every race';
    const names = ids.map((id) => next.races.find((r) => r.id === id)?.name).filter(Boolean);
    return names.length ? `${listText(names)} only` : 'no race (its race was deleted)';
  };
  const racesShort = (ids) => (ids.length ? listText(ids.map((id) => next.races.find((r) => r.id === id)?.name ?? DELETED_RACE)) : 'all');
  const enWord = (v) => (v === 'blank' ? 'blank' : "the race's");
  const stageWord = (v) => (v === 'started' ? 'Started' : 'Results');
  const fileWord = (p) => text(p).split(/[\\/]/).pop() || 'none';
  const outFieldText = (k, v, was) => ({
    name: () => `name "${v}" (was "${was}")`,
    enabled: () => (v ? 'switched on (was off)' : 'switched off (was on)'),
    mode: () => `mode ${v} (was ${was})`,
    host: () => `host ${v} (was ${was})`,
    port: () => `port ${v} (was ${was})`,
    script: () => `script ${v}`,
    stage: () => `sections ${v} (was ${was})`,
    eventNumber: () => `event number ${enWord(v)} (was ${enWord(was)})`,
    precision: () => `${v} decimals (was ${was})`,
    mid: () => `MID ${v || 'none'} (was ${was || 'none'})`,
    races: () => `races ${racesShort(v)} (was ${racesShort(was)})`,
  })[k]();
  const outsTouched = [];
  /** outputs the file does not have: listed after the races */
  const keptOutputs = [];
  /** O6: new outputs that came in switched off although the file had them on, or did not say */
  const offOutputs = [];
  // O34: an output that sends to this PC on a port where Split Relay listens for RR12 (one here, or one this file adds)
  // would feed Split Relay's own splits back in as RR12 reads: never added, never moved there, never switched on there
  // (ports are planned first, so every RR12 port after the load is known)
  const loopsBack = (o) => o.mode !== 'tcp-server' && isThisPcHost(o.host, pcNames) && inputPorts(next).includes(o.port);
  const loopWords = (o, name, after, fix = 'Choose another port in the file.') => `Port ${o.port} is an RR12 input port of this Split Relay` +
    `${inputPorts(config).includes(o.port) ? '' : ' (the file adds it)'}: the output "${name}" would send Split Relay's own splits to it ` +
    `on this PC, and they would come back in as RR12 reads. ${after} ${fix}`;
  if (fromFile) {
    const raceIdByName = (n) => {
      for (const S of meet.races) if (matchKey(S.name) === matchKey(n) && idOf.has(S)) return idOf.get(S);
      return next.races.find((r) => matchKey(r.name) === matchKey(n))?.id ?? null;
    };
    const claimed = new Set();
    for (const O of meet.outputs) {
      const omode = text(O.mode || 'tcp-client').toLowerCase();
      const host = text(O.host ?? '127.0.0.1').toLowerCase();
      let M = config.outputs.find((o) => matchKey(o.name) === matchKey(O.name));
      let byAddress = false;
      if (!M) {
        // the same address: two outputs would feed one TrackScore
        const same = config.outputs.filter((o) => o.mode === omode && text(o.host).toLowerCase() === host && o.port === O.port);
        if (same.length === 1) {
          M = same[0];
          byAddress = true;
        }
      }
      if (M && claimed.has(M.id)) {
        say('warn', `Output "${O.name}" in the file is the same output as another one in the file ("${M.name}" here): it is left out.`, { kind: 'output', name: O.name });
        continue;
      }
      // what is said of a new output waits until it is added (O13: never "comes in switched off", then "left out")
      const pending = [];
      const later = (tone, t, extra) => (M ? say(tone, t, extra) : pending.push([tone, t, extra]));
      // its races, by name
      let ids = null;
      let raceTrouble = '';
      if (Array.isArray(O.races)) {
        const names = O.races.filter((n) => n !== DELETED_RACE);
        const unknown = [];
        ids = [];
        for (const n of names) {
          const id = raceIdByName(n);
          if (id && !ids.includes(id)) ids.push(id);
          else if (!id) unknown.push(n);
        }
        if (O.races.length && !names.length) raceTrouble = M ? 'keep' : 'none';
        else if (names.length && !ids.length) raceTrouble = 'none';
        else if (unknown.length) {
          later('info', `${O.name}'s race${unknown.length === 1 ? '' : 's'} ${listText(unknown.map((n) => `"${n}"`))} ${unknown.length === 1 ? 'is' : 'are'} not in this setup: ` +
            `${unknown.length === 1 ? 'it is' : 'they are'} left out of its list.`, { kind: 'output', name: O.name });
        }
        if (raceTrouble === 'none') {
          const missing = names.filter((n) => !raceIdByName(n));
          later('warn', `${O.name} lists races that are not in this setup (${listText(missing.length ? missing : [DELETED_RACE])}): ` +
            (M ? 'its races stay as they are.' : 'it comes in switched off with no race chosen. Choose its races in Outputs before you switch it on.'),
          { kind: 'output', name: O.name, ...(M ? { outputId: M.id, href: `#outputs/${M.id}` } : {}) });
        }
      }
      if (M) {
        claimed.add(M.id);
        const cur = next.outputs.find((o) => o.id === M.id);
        const body = {};
        for (const k of ['name', 'enabled', 'mode', 'host', 'port', 'script', 'stage', 'eventNumber', 'precision', 'mid']) {
          if (!has(O, k)) continue;
          const v = k === 'mode' ? text(O[k]).toLowerCase() : O[k];
          if (v !== cur[k]) body[k] = v;
        }
        if (ids && !raceTrouble && JSON.stringify(ids) !== JSON.stringify(cur.races)) body.races = ids;
        if (has(body, 'script') && text(body.script) && pathState(text(body.script)) !== 'yes' && text(cur.script)) {
          say('warn', `${cur.name}'s script ${body.script} is not on this PC. ${cur.script} stays.`, { kind: 'output', name: cur.name, outputId: cur.id, href: `#outputs/${cur.id}` });
          delete body.script;
        }
        if (!Object.keys(body).length) {
          noChange.push(cur.name);
          if (text(cur.mid) && text(O.mid) === text(cur.mid) && earlierDay) midCheck(cur.name, cur.mid);
          continue;
        }
        const extra = { kind: 'output', name: cur.name, outputId: cur.id, href: `#outputs/${cur.id}` };
        // O10: not matched by its name: which output here it lands on
        if (byAddress) {
          say('warn', `Output "${O.name}" in the file is loaded onto "${cur.name}" here: the same address (${cur.host}:${cur.port}), another name. ` +
            `${has(body, 'name') ? `Its name becomes "${O.name}"` : 'Its name stays'}${has(body, 'script') ? ` and its script becomes ${fileWord(body.script)}` : ''}: make sure it is the same output.`, extra);
        }
        if (running.length) {
          // R2/R4: from the gun on, an output changes only when the operator changes it
          say('warn', `${runningWords()}, so ${cur.name} stays as it is ` +
            `(${where}: ${Object.keys(body).map((k) => outFieldText(k, body[k], cur[k]).replace(/ \(was .*\)$/, '')).join(', ')}). ` +
            'Change it in Outputs when the race is over.', extra);
          continue;
        }
        const sent = ctx.sentTo instanceof Map ? ctx.sentTo.get(cur.id) ?? 0 : 0;
        if (sent > 0 && ['mode', 'host', 'port'].some((k) => has(body, k))) {
          // its deliveries are kept by output id: at a new address it would never be sent what the old one has
          say('warn', `${cur.name} stays at ${cur.host}:${cur.port}: Split Relay has sent it ${plural(sent, 'split')}. Change the address in Outputs, then Resend.`, extra);
          delete body.mode;
          delete body.host;
          delete body.port;
          if (!Object.keys(body).length) continue;
        }
        if (['mode', 'host', 'port', 'enabled'].some((k) => has(body, k))) {
          // O34: the output as Outputs would save it (a change that can't be saved is said below)
          const probe = () => {
            try {
              return updateOutput(next, cur.id, body, NO_LOOP_CHECK).output;
            } catch (err) {
              if (!(err instanceof ConfigError)) throw err;
              return null;
            }
          };
          let to = probe();
          if (to && loopsBack(to) && ['mode', 'host', 'port'].some((k) => has(body, k))) {
            say('bad', loopWords(to, cur.name, `It stays at ${cur.host}:${cur.port}.`), extra);
            delete body.mode;
            delete body.host;
            delete body.port;
            to = Object.keys(body).length ? probe() : null;
          }
          // its address here already sends there: switched on by a load, it would start doing so
          if (to && loopsBack(to) && to.enabled && !cur.enabled) {
            say('bad', loopWords(to, cur.name, 'It stays switched off.', 'Change its port in Outputs first.'), extra);
            delete body.enabled;
          }
          if (!Object.keys(body).length) continue;
        }
        if (has(body, 'script') && text(body.script) && pathState(text(body.script)) !== 'yes') {
          say('warn', `${cur.name}'s script ${body.script} is not on this PC. It sends nothing until you choose the script in Outputs.`, extra);
        }
        attempt(() => {
          const r = updateOutput(next, cur.id, body, NO_LOOP_CHECK);
          next = r.config;
          const o = r.output;
          outsTouched.push(o);
          changed.push({ kind: 'output', name: o.name, outputId: o.id, text: `${cur.name}: ${Object.keys(body).map((k) => outFieldText(k, o[k], cur[k])).join('; ')}` });
          // R10: what changes on TrackScore or the live results
          const ex = { kind: 'output', name: o.name, outputId: o.id, href: `#outputs/${o.id}` };
          if (has(body, 'enabled')) {
            say('warn', o.enabled ? `${o.name} is switched on by this load: it sends ${racesWord(o.races)} once a race has its gun time.`
              : `${o.name} is switched off by this load: it sends nothing more until you switch it on.`, ex);
          }
          if (['mode', 'host', 'port'].some((k) => has(body, k))) say('warn', `${o.name} sends to ${o.host}:${o.port} from now on (was ${cur.host}:${cur.port}).`, ex);
          if (has(body, 'eventNumber')) {
            say('warn', o.eventNumber === 'blank' ? `${o.name} sends a blank event number from now on: TrackScore no longer switches to each race's event.`
              : `${o.name} sends each race's event number from now on: TrackScore switches to the race of each split, and clears the race it was showing.`, ex);
          }
          if (has(body, 'races')) say('warn', `${o.name} sends ${racesWord(o.races)} from now on (was ${racesWord(cur.races)}).`, ex);
          // O15: the script, its sections and the decimals change what the board shows, from the next split on
          if (has(body, 'script') && !byAddress && pathState(text(body.script)) === 'yes') {
            say('warn', `${o.name} uses the script ${fileWord(o.script)} from now on (was ${fileWord(cur.script)}): what ${o.name} shows changes with the next split.`, ex);
          }
          if (has(body, 'stage')) {
            say('warn', `${o.name} sends the script's ${stageWord(o.stage)} sections from now on (was ${stageWord(cur.stage)}): what ${o.name} shows changes with the next split.`, ex);
          }
          if (has(body, 'precision')) {
            say('warn', `${o.name} sends times with ${plural(o.precision, 'decimal')} from now on (was ${cur.precision}): the times it shows change with the next split.`, ex);
          }
          if (text(o.mid) && (has(body, 'mid') || earlierDay)) midCheck(o.name, o.mid);
        }, (e) => say('warn', `${cur.name} was not changed: ${e}`, { kind: 'output', name: cur.name, outputId: cur.id }));
        continue;
      }
      // a new output: switched off unless the file says on (R11), never on a running race (R2)
      const body = { name: O.name, enabled: O.enabled === true };
      for (const k of ['mode', 'host', 'port', 'script', 'stage', 'eventNumber', 'precision', 'mid']) if (has(O, k)) body[k] = O[k];
      body.races = ids && !raceTrouble ? ids : [];
      if (raceTrouble) body.enabled = false;
      if (text(body.script) && pathState(text(body.script)) !== 'yes') {
        later('warn', `${O.name}'s script ${body.script} is not on this PC. It sends nothing until you choose the script in Outputs.`, { kind: 'output', name: O.name });
      }
      if (body.enabled) {
        const takes = running.filter((r) => !body.races.length || body.races.includes(r.id));
        if (takes.length) {
          body.enabled = false;
          const n = takes.reduce((x, r) => x + st(r.id).crossings, 0);
          const whose = takes.length === 1 ? `${takes[0].name}'s` : `${listText(takes.map((r) => r.name))}'s`;
          later('warn', `${O.name} comes in switched off: switched on now, it would send ${whose} ${n ? `${n.toLocaleString('en-US')} splits at once` : 'splits from now on'}. ` +
            'Switch it on in Outputs when you mean to.', { kind: 'output', name: O.name });
        }
      }
      attempt(() => {
        const r = addOutput(next, body, NO_LOOP_CHECK);
        // O34: not added, and nothing else is said of it (O13)
        if (loopsBack(r.output)) return say('bad', loopWords(r.output, O.name, 'It is not added.'), { kind: 'output', name: O.name });
        next = r.config;
        const o = r.output;
        outsTouched.push(o);
        added.push({ kind: 'output', name: o.name, outputId: o.id, text: outputSummary(o) });
        for (const [tone, t, extra] of pending) say(tone, t, extra);
        if (o.enabled) {
          // (no link: what the load adds has its id only once it is applied, which plans it again)
          say('warn', `${o.name} is added switched on: it sends ${racesWord(o.races)} once a race has its gun time.`, { kind: 'output', name: o.name });
        } else if (O.enabled !== false) offOutputs.push(o.name);
        if (text(o.mid)) midCheck(o.name, o.mid);
      }, (e) => say('warn', `Output ${O.name} is left out: ${e}`, { kind: 'output', name: O.name }));
    }
    for (const o of config.outputs) {
      if (!claimed.has(o.id)) keptOutputs.push({ kind: 'output', name: o.name, outputId: o.id, text: `${o.name} is not ${ctx.undo ? 'in that copy' : 'in the file'}: it stays.` });
    }
    // O14: two outputs that would send to one place
    const target = (o) => `${o.mode}|${text(o.host).toLowerCase()}|${o.port}`;
    for (const o of outsTouched) {
      const twin = next.outputs.find((x) => x.id !== o.id && x.enabled && o.enabled && x.mode !== 'tcp-server' && target(x) === target(o));
      if (twin) say('warn', `${o.name} and ${twin.name} both send to ${o.host}:${o.port}: that program would get every split twice.`, { kind: 'output', name: o.name, outputId: o.id });
    }
    // O16: another PC's addresses
    const pc = text(meet.savedOn);
    if (pc && text(ctx.thisPc) && pc.toLowerCase() !== text(ctx.thisPc).toLowerCase()) {
      say('info', `Saved on ${pc}: the paths in it are checked on this PC.`);
      const hosts = [...new Set(outsTouched.filter((o) => o.mode !== 'tcp-server').map((o) => o.host))];
      if (hosts.length) say('warn', `Its outputs send to ${listText(hosts)}, addresses from ${pc}: check them in Outputs.`, { href: '#outputs' });
    }
  }

  // ---- removals: opt-in, and only races with nothing in them (R1) --------------------------------------------------
  // O2: the copy kept before a load offers the races that load added even when the copy had no race
  const others = meet.races.length > 0 || !!ctx.undo;
  // O13: a race the file has but that could not be read is never offered for removal, nor said to be "not in the file"
  const unread = new Set((Array.isArray(meet.leftOut) ? meet.leftOut : []).map(looseKey));
  const removable = [];
  for (const r of config.races) {
    if (claims.has(r.id) || unread.has(looseKey(r.name))) continue;
    if (others && !conflictIds.has(r.id) && !inUse(r)) removable.push({ id: r.id, name: r.name });
  }
  const gone = new Set();
  if (ctx.removeOthers) {
    for (const r of removable) {
      attempt(() => {
        next = deleteRace(next, r.id);
        deleted.push(r.id);
        gone.add(r.id);
        removed.push({ kind: 'race', name: r.name, raceId: r.id, text: `${r.name} is removed (it has no reads).` });
      }, (e) => say('warn', `${r.name} was not removed: ${e}`, { kind: 'race', name: r.name, raceId: r.id }));
    }
    // O11: an output that sent only removed races sends nothing after
    for (const o of next.outputs) {
      const was = config.outputs.find((x) => x.id === o.id)?.races ?? [];
      if (!was.length || !was.some((id) => gone.has(id)) || o.races.some((id) => next.races.some((r) => r.id === id))) continue;
      const names = was.map((id) => config.races.find((r) => r.id === id)?.name).filter(Boolean);
      say('warn', `${o.name} sends only ${listText(names)}: with ${names.length === 1 ? 'it' : 'them'} removed, ${o.name} sends nothing until you choose its races in Outputs.`,
        { kind: 'output', name: o.name, outputId: o.id, href: `#outputs/${o.id}` });
    }
  }
  for (const r of config.races) {
    if (claims.has(r.id) || gone.has(r.id)) continue;
    if (unread.has(looseKey(r.name))) {
      kept.push({ kind: 'race', name: r.name, raceId: r.id, text: `${r.name} stays as it is: its race in the file can't be read (see above).` });
    } else if (others) {
      kept.push({ kind: 'race', name: r.name, raceId: r.id, text: `${r.name} is not ${fromFile ? (ctx.undo ? 'in that copy' : 'in the file') : "in TrackScore's meet"}: it stays.` });
    }
  }
  kept.push(...keptOutputs);
  if (noChange.length) kept.push({ kind: 'nochange', name: '', text: `No change: ${noChange.join(', ')}.` });

  // O31: a port the load moved every race off stays an RR12 port: said, so a "waiting" light there is no surprise
  for (const p of inputPorts(config)) {
    if (!inputPorts(next).includes(p) || !config.races.some((r) => r.inputPort === p) || next.races.some((r) => r.inputPort === p)) continue;
    say('info', `RR12 port ${p} stays, with no race on it now. Remove it on the Inputs page if RR12 no longer sends there.`, { kind: 'port', name: String(p), href: '#inputs' });
  }

  // O2: what the copy kept before a load can't take back (R1)
  let leftover = null;
  if (ctx.undo) {
    const extraRaces = config.races.filter((r) => !claims.has(r.id) && !gone.has(r.id)).map((r) => r.name);
    const extraOutputs = fromFile ? keptOutputs.map((o) => o.name) : [];
    const want = Array.isArray(meet.input?.ports) ? meet.input.ports : null;
    const extraPorts = want ? inputPorts(config).filter((p) => !want.includes(p)) : [];
    // the panel says it again where it would otherwise say "Nothing to change" (a load added it; this does not undo it)
    if (extraRaces.length || extraOutputs.length || extraPorts.length) leftover = { races: extraRaces, outputs: extraOutputs, ports: extraPorts };
    const parts = [
      extraRaces.length ? `${listText(extraRaces)} (${removable.length ? 'tick the box below to remove the races with no reads' : 'a race with reads is never removed'})` : '',
      extraOutputs.length ? `the output${extraOutputs.length === 1 ? '' : 's'} ${listText(extraOutputs)} (delete ${extraOutputs.length === 1 ? 'it' : 'them'} in Outputs)` : '',
      extraPorts.length ? `RR12 ${extraPorts.length === 1 ? 'port' : 'ports'} ${listText(extraPorts.map(String))} (Inputs page)` : '',
    ].filter(Boolean);
    say(parts.length ? 'warn' : 'info', `This puts back what that copy has, as it was before the load at ${new Date(ctx.undo.at ?? now).toTimeString().slice(0, 5)}. ` +
      (parts.length ? `What the load added stays: ${parts.join('; ')}.` : 'Nothing the load added is left over.'));
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  attention.sort((a, b) => (rank[a.tone] ?? 2) - (rank[b.tone] ?? 2));
  return { next, deleted, added, changed, kept, attention, removable, removed, offOutputs, leftover,
    nothing: !added.length && !changed.length && !removed.length };
}
