// The Race Result 12 stream in. RR12's exporter is the TCP client: it dials us and sends one text line per passing,
// built from the "Export Data" expression we give the operator. We only ever listen — RR never expects a reply and a
// stray byte back could confuse it — so nothing here writes to a socket.
//
// Two shapes of line arrive (DESIGN 9.15), told apart line by line so the operator never has to pick a setting:
// the FinishLynx LapTime line RR12's FinishLynx exporter already sends ("\x01S,15:17:44.215,254": a bib and a time of
// day, nothing else), and Split Relay's own SR|... line with timing point names, contests and names (advanced).

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { parseTod } from './timefmt.js';
import { eventKey } from './engine.js';

/** @typedef {'location'|'bib'|'time'|'contest'|'first'|'last'|'team'|'gender'|'ignore'} ColumnType */

/**
 * The input format (Config.input). Missing or unusable values fall back to the defaults.
 * @typedef {{ delimiter?: string, tag?: string, columns?: string[] }} InputFormat
 */

/**
 * One passing from the stream. Every text field is trimmed; gender is 'M', 'F' or ''. A FinishLynx LapTime read has
 * location '' and contest '' (the line carries neither) and `event`: '3-1-1' (event-round-heat, leading zeros dropped)
 * when the line carried FinishLynx's event fields, else ''.
 * @typedef {{ location: string, bib: string, tod: number, contest: string, first: string, last: string,
 *             team: string, gender: string, event?: string }} Read
 */

/**
 * `format`: which shape the line had ('laptime' = FinishLynx LapTime, 'sr' = SR|..., 'json' = [RD_RecordJSON]).
 * kind 'ignored': a LapTime command line that is not a passing (Z, T): logged, nothing else.
 * @typedef {{ ok: true, read: Read, format: 'laptime'|'sr'|'json' }
 *         | { ok: false, kind: 'empty'|'hello'|'error'|'ignored', message: string, format?: 'laptime'|'sr'|'json' }} ParseResult
 */

/** The RR12 Export Data expression of the FinishLynx LapTime line (what RR12's own FinishLynx exporter uses). */
export const LAPTIME_EXPRESSION = 'chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]';

/** @type {readonly ColumnType[]} */
export const COLUMN_TYPES = Object.freeze(['location', 'bib', 'time', 'contest', 'first', 'last', 'team', 'gender', 'ignore']);

/** RR12 expression for each column. `format(...;"hh:mm:ss.kkk")` because raw [RD_Time] is seconds since midnight. */
export const COLUMN_EXPRESSIONS = Object.freeze({
  location: '[RD_TimingPoint]',
  bib: '[RD_IDBib]',
  time: 'format([RD_Time];"hh:mm:ss.kkk")',
  contest: '[Contest.Name]',
  first: '[Firstname]',
  last: '[Lastname]',
  team: '[Club]',
  gender: '[Gender]',
  ignore: '""',
});

/** What a fresh config uses (DESIGN.md section 3). */
export const DEFAULT_INPUT_FORMAT = Object.freeze({
  delimiter: '|',
  tag: 'SR',
  columns: Object.freeze(['location', 'bib', 'time', 'contest', 'first', 'last', 'team', 'gender']),
});

/**
 * Settle a format so a half-edited config can never make parsing throw. The delimiter may not contain CR, LF or TAB
 * (those end a line before parseLine sees it) nor `"` (it would end RR's string literal); the tag loses quotes and
 * control characters for the same reasons. Unknown column names count as 'ignore' so field positions stay right.
 * @param {InputFormat | undefined | null} format
 */
function normalizeFormat(format) {
  // Every line is parsed with the same settings until they are changed: worked out once, not 40,000 times in a Replay.
  // Per format object (the input server and main.js may each hold their own copy of the same settings).
  const f = format ?? {};
  const key = format && typeof format === 'object' ? format : NO_FORMAT;
  const c = formatCache.get(key);
  if (c && c.delimiter === f.delimiter && c.tag === f.tag && c.columns === f.columns && sameItems(c.copy, f.columns)) return c.result;
  const result = normalizeFormatNow(f);
  formatCache.set(key, { delimiter: f.delimiter, tag: f.tag, columns: f.columns,
    copy: Array.isArray(f.columns) ? [...f.columns] : f.columns, result });
  return result;
}

const NO_FORMAT = {};

/** Whether a column list still holds what it held (a list edited in place is noticed). */
function sameItems(copy, columns) {
  if (!Array.isArray(columns)) return copy === columns;
  if (!Array.isArray(copy) || copy.length !== columns.length) return false;
  for (let i = 0; i < copy.length; i++) if (copy[i] !== columns[i]) return false;
  return true;
}

/** @type {WeakMap<object, { delimiter: any, tag: any, columns: any, copy: any, result: ReturnType<typeof normalizeFormatNow> }>} */
const formatCache = new WeakMap();

/** @param {InputFormat} f */
function normalizeFormatNow(f) {
  let delimiter = typeof f.delimiter === 'string' ? f.delimiter : DEFAULT_INPUT_FORMAT.delimiter;
  if (!delimiter || /[\r\n\t"]/.test(delimiter)) delimiter = DEFAULT_INPUT_FORMAT.delimiter;
  const tag = f.tag === undefined ? DEFAULT_INPUT_FORMAT.tag : String(f.tag ?? '').replace(/["\x00-\x1f\x7f]/g, '').trim();
  const columns = Array.isArray(f.columns) && f.columns.length
    ? f.columns.map((c) => {
      const t = String(c ?? '').trim().toLowerCase();
      return /** @type {ColumnType} */ (COLUMN_TYPES.includes(/** @type {ColumnType} */ (t)) ? t : 'ignore');
    })
    : [...DEFAULT_INPUT_FORMAT.columns];
  // A tag that itself contains the delimiter spans several fields; compare it part by part.
  const tagParts = tag ? tag.split(delimiter).map((p) => p.trim().toLowerCase()) : [];
  return { delimiter, tag, columns, tagParts, tagDelimLower: (tag + delimiter).toLowerCase() };
}

/**
 * The RR12 "Export Data" expression that produces lines parseLine reads with the same format, e.g.
 * `"SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk") & ...`.
 * @param {InputFormat} [format]
 * @returns {string}
 */
export function buildExpression(format) {
  const { delimiter, tag, columns } = normalizeFormat(format);
  const parts = tag ? [`"${tag}${delimiter}"`] : [];
  columns.forEach((c, i) => {
    if (i > 0) parts.push(`"${delimiter}"`);
    parts.push(COLUMN_EXPRESSIONS[c]);
  });
  return parts.join(' & ');
}

const GENDER_WORDS = new Map([
  ...['m', 'male', 'man', 'men', 'mens', 'boy', 'boys', 'b', 'gents', 'herren', 'männlich'].map((w) => [w, 'M']),
  // 'w' is RR12's own code in German installs (weiblich).
  ...['f', 'female', 'woman', 'women', 'womens', 'girl', 'girls', 'g', 'w', 'ladies', 'damen', 'weiblich'].map((w) => [w, 'F']),
]);

/**
 * Whatever a registration system calls a gender -> 'M', 'F' or '' (FinishLynx's licence field only knows M/F, and
 * TrackScore treats anything else as "no gender").
 * @param {unknown} value
 * @returns {'M'|'F'|''}
 */
export function normalizeGender(value) {
  const raw = String(value ?? '');
  // a meet has a handful of spellings; each is worked out once
  let g = genderCache.get(raw);
  if (g === undefined) {
    g = GENDER_WORDS.get(raw.trim().toLowerCase().replace(/[^a-zäöü]/g, '')) ?? '';
    if (genderCache.size > 1000) genderCache.clear();
    genderCache.set(raw, g);
  }
  return /** @type {'M'|'F'|''} */ (g);
}

const genderCache = new Map();

const EDGE_JUNK = /^[\s\x00-\x1f\x7f]+|[\s\x00-\x1f\x7f]+$/g;
/** A FinishLynx LapTime line: one letter (the command), then a comma, or nothing at all ("Z"). */
const LAPTIME_HEAD = /^([A-Za-z])\s*(?:,|$)/;
/** SOH / STX: FinishLynx's start of a record. Inside a line it means records glued together (RR12 "Line end: none"). */
const SOT = /[\x01\x02]/;

const fail = (message, format) => /** @type {ParseResult} */ (format ? { ok: false, kind: 'error', message, format } : { ok: false, kind: 'error', message });

/**
 * One line from RR12 -> a read, or why not. Never throws. The shape is told from the line itself (DESIGN 9.15 L1):
 * a FinishLynx LapTime line, an SR|... line in the column order of `format`, or an [RD_RecordJSON] object.
 * @param {string} line
 * @param {InputFormat} [format]
 * @returns {ParseResult}
 */
export function parseLine(line, format) {
  const fmt = normalizeFormat(format);
  const raw = String(line ?? '');
  const startsWithControl = /^\s*[\x01\x02]/.test(raw); // \s includes a BOM
  const text = raw.replace(EDGE_JUNK, '');
  if (!text) return { ok: false, kind: 'empty', message: '' };

  const lap = parseLapTime(text, startsWithControl, fmt);
  if (lap) return lap;

  const json = jsonBody(text, fmt);
  if (json !== null) return withFormat(parseJsonRecord(json), 'json');
  return withFormat(parseSr(text, fmt, format), 'sr');
}

/** @param {ParseResult} r @param {'sr'|'json'} format */
function withFormat(r, format) {
  // 'empty' says nothing about the format; everything else does (a bad SR line is still an SR line)
  if (r.ok || r.kind !== 'empty') r.format = format;
  return r;
}

/**
 * The FinishLynx LapTime line RR12's FinishLynx exporter sends: "<SOH>S,<time of day>,<bib>[,event,round,heat]". Only
 * S is a passing; Z and T are FinishLynx commands that are logged and ignored. Returns null when the line is not a
 * LapTime line at all.
 * @param {string} text the line without its leading SOH/STX and trailing line end
 * @param {boolean} framed it started with SOH/STX (then it is FinishLynx's, whatever follows)
 * @param {ReturnType<typeof normalizeFormat>} fmt
 * @returns {ParseResult | null}
 */
function parseLapTime(text, framed, fmt) {
  const head = LAPTIME_HEAD.exec(text);
  if (!head) return null;
  const fields = text.split(',').map((f) => f.trim());
  const op = head[1].toUpperCase();
  if (!framed) {
    // Without SOH, "S,..." could also be an SR line: one whose tag is a letter, or one with commas between fields
    // whose timing point is called "S". A LapTime line has its own shape: 1 to 6 fields, the second a time of day.
    if (fmt.tagParts.length === 1 && fmt.tagParts[0] === op.toLowerCase() && fmt.delimiter === ',') return null;
    // A line with the SR separator in it ("A,1|254|...") is an SR line whose first field has a comma: a LapTime line
    // holds only letters, digits, ':', '.' and ','.
    if (!/[\d\s:.,]/.test(fmt.delimiter) && text.includes(fmt.delimiter)) return null;
    if (fmt.delimiter === ',') {
      if (fields.length > 6 || fields.length === fmt.columns.length || fields.length === fmt.columns.length + fmt.tagParts.length) return null;
      if (op === 'S' && parseTod(fields[1]) === null) return null;
    }
    if (fields.length === 1 && op !== 'Z' && op !== 'T') return null;
  }
  // "\x01S,...,254\x01S,...,255": two records and no line end between them (InputServer splits them itself)
  if (SOT.test(text)) {
    const n = text.split(SOT).filter((p) => p.trim()).length;
    return fail(`This line holds ${n} FinishLynx LapTime reads with no line end between them, so none of them was used. `
      + "In RR12, set the exporter's Line end to CRLF", 'laptime');
  }
  if (op === 'Z' || op === 'T') {
    return { ok: false, kind: 'ignored', format: 'laptime',
      message: `FinishLynx LapTime command "${op}" (not a passing): ignored` };
  }
  if (op !== 'S') {
    return fail(`This looks like a FinishLynx LapTime line, but it starts with "${head[1]}". Split Relay uses the S lines `
      + '(S,time,bib), for example S,15:17:44.215,254', 'laptime');
  }
  // a trailing comma (an expression that ends in "," & ...) leaves empty fields: they carry nothing
  while (fields.length > 3 && fields[fields.length - 1] === '') fields.pop();
  if (fields.length < 3 || !fields[1] || !fields[2]) {
    if (fields.length >= 2 && fields[1] && parseTod(fields[1]) === null) return fail(lapTimeBadTime(fields[1]), 'laptime');
    if (fields.length >= 3 && !fields[2]) return fail('No bib in this FinishLynx LapTime line — RR12 has no participant for this chip', 'laptime');
    return fail('This FinishLynx LapTime line is cut short: expected S,time,bib, for example S,15:17:44.215,254. '
      + 'Check the Export Data expression in RR12', 'laptime');
  }
  if (fields.length > 6) {
    return fail(`This FinishLynx LapTime line has ${fields.length} fields: expected S,time,bib (and, if RR12 adds them, `
      + "event,round,heat). Check the Export Data expression in RR12, and that the exporter's Line end is CRLF", 'laptime');
  }
  const [, time, bib, event = '', round = '', heat = ''] = fields;
  if (/^0+$/.test(bib)) return fail('Bib 0 — RR12 has no participant for this chip', 'laptime');
  const tod = parseTod(time);
  if (tod === null) return fail(lapTimeBadTime(time), 'laptime');
  if (/[\x00-\x1f\x7f]/.test(bib + event + round + heat)) {
    return fail('This FinishLynx LapTime line has control characters inside it: check the Export Data expression in RR12', 'laptime');
  }
  return {
    ok: true,
    format: 'laptime',
    read: { location: '', bib, tod, contest: '', first: '', last: '', team: '', gender: '', event: eventKey(event, round, heat) },
  };
}

const lapTimeBadTime = (t) => `Can't read the time "${t}" in this FinishLynx LapTime line — expected a time of day like `
  + '15:17:44.215. In RR12 use format([RD_Time];"hh:mm:ss.kkk")';

/**
 * Records glued by RR12's "Line end: none" when each starts with SOH/STX (the LapTime line does): every record on its
 * own. A line without a second SOH/STX is returned as it is.
 * @param {string} line
 * @returns {string[]}
 */
export function splitFramed(line) {
  const s = String(line ?? '');
  // the first SOH/STX may follow a BOM or spaces; only a later one starts another record
  const first = s.search(SOT);
  if (first < 0 || !SOT.test(s.slice(first + 1))) return [s];
  const out = [];
  const head = s.slice(0, first);
  for (const piece of s.slice(first).split(/(?=[\x01\x02])/)) {
    if (piece.replace(EDGE_JUNK, '')) out.push(out.length ? piece : head + piece);
  }
  return out.length ? out : [s];
}

/** An SR|... line (or the same columns without the tag). */
function parseSr(text, fmt, format) {
  const fields = text.split(fmt.delimiter);
  for (let i = 0; i < fields.length; i++) fields[i] = fields[i].trim();
  const k = fmt.tagParts.length;
  const tagged = k > 0 && fields.length >= k && fmt.tagParts.every((p, i) => fields[i].length === p.length && fields[i].toLowerCase() === p);
  if (tagged) fields.splice(0, k);

  if (fields[0]?.length === 5 && fields[0].toUpperCase() === 'HELLO') {
    const rest = fields.slice(1).filter(Boolean).join(' ');
    return { ok: false, kind: 'hello', message: rest ? `Connect message: ${rest}` : 'Connect message' };
  }
  if (!fields.length || fields.every((f) => !f)) {
    return tagged ? fail('The line has the tag but no data') : { ok: false, kind: 'empty', message: '' };
  }

  const n = fmt.columns.length;
  if (fields.length > n) {
    if (k > 0 && !tagged && fields.length === n + k) {
      return fail(`The line starts with "${fields.slice(0, k).join(fmt.delimiter)}" instead of the tag "${fmt.tag}" — `
        + 'check the Export Data expression in RR12');
    }
    const glued = splitGlued(text, format);
    if (glued) {
      return fail(`This line holds ${glued.length} reads with no line end between them, so none of them was used. `
        + "In RR12, set the exporter's Line end to CRLF");
    }
    return fail(`The line has ${fields.length} fields but the column order has ${n} — check that the Export Data `
      + "expression in RR12 matches the column order in Settings, and that the exporter's Line end is CRLF");
  }
  // RR12's expression always gives every column, empty or not, so a short line is a cut-off one: reading it would
  // turn "10:05:00.215" cut after the seconds into an earlier, wrong time.
  if (fields.length < n) {
    return fail(`Expected ${n} fields separated by ${fmt.delimiter}, got ${fields.length}: check the Export Data `
      + 'expression in RR12');
  }

  const values = emptyValues();
  fmt.columns.forEach((c, i) => {
    // The first non-empty column of a type wins, so a duplicated column cannot blank a value.
    if (c !== 'ignore' && !values[c] && fields[i]) values[c] = fields[i];
  });
  if (!fmt.columns.includes('bib')) return fail('The column order in Settings has no Bib column');
  if (!fmt.columns.includes('time')) return fail('The column order in Settings has no Time column');
  return toRead(values);
}

/**
 * Records glued into one line, or null. With RR12's Line end set to "none", reads that arrive closer together than
 * the quiet time come in as one line: "SR|1K-A|401|...|F" + "SR|1K-A|402|...|F" gives "...|FSR|1K-A|402|...", where
 * the next tag is stuck to the last value. A record always has the tag plus one field per column, so the line is split
 * only when every record has exactly that shape; anything else is left for parseLine to report.
 * @param {string} line
 * @param {InputFormat} [format]
 * @returns {string[] | null} the records, each starting with the tag
 */
export function splitGlued(line, format) {
  const fmt = normalizeFormat(format);
  const k = fmt.tagParts.length;
  if (k === 0 || fmt.tagParts.some((p) => !p)) return null; // nothing marks where a record starts
  const r = k + fmt.columns.length; // fields per record
  // Every line comes through here: one with no more separators than a single record is told by counting them.
  const raw = String(line ?? '');
  const d = fmt.delimiter;
  let seps = 0;
  for (let at = raw.indexOf(d); at >= 0 && seps < r; at = raw.indexOf(d, at + d.length)) seps++;
  if (seps < r) return null;
  const text = raw.replace(EDGE_JUNK, '');
  const parts = text.split(fmt.delimiter);
  // m records share m - 1 boundary fields ("F" + "SR"): parts = m * r - (m - 1)
  if (parts.length <= r || (parts.length - 1) % (r - 1) !== 0) return null;
  const m = (parts.length - 1) / (r - 1);
  const tag0 = fmt.tagParts[0];
  const records = [];
  let head = parts[0].trim();
  for (let j = 0; j < m; j++) {
    const base = j * (r - 1);
    if (head.toLowerCase() !== tag0) return null;
    for (let i = 1; i < k; i++) if (parts[base + i].trim().toLowerCase() !== fmt.tagParts[i]) return null;
    const fields = [head, ...parts.slice(base + 1, base + r - 1)];
    let last = parts[base + r - 1];
    if (j < m - 1) {
      const t = last.trimEnd();
      if (!t.toLowerCase().endsWith(tag0)) return null;
      head = t.slice(t.length - tag0.length);
      last = t.slice(0, t.length - tag0.length);
    }
    fields.push(last);
    records.push(fields.join(fmt.delimiter));
  }
  return records;
}

function emptyValues() {
  return { location: '', bib: '', time: '', contest: '', first: '', last: '', team: '', gender: '' };
}

/** @param {ReturnType<typeof emptyValues>} v @returns {ParseResult} */
function toRead(v) {
  if (v.bib === '' || /^0+$/.test(v.bib)) {
    return fail(`${v.bib === '' ? 'No bib' : 'Bib 0'} — RR12 has no participant for this chip`);
  }
  if (v.time === '') return fail('The read has no time');
  const tod = parseTod(v.time);
  if (tod === null) return fail(`Can't read the time "${v.time}" — expected 15:17:44.215 or seconds since midnight`);
  return {
    ok: true,
    read: { location: v.location, bib: v.bib, tod, contest: v.contest, first: v.first, last: v.last, team: v.team,
      gender: normalizeGender(v.gender) },
  };
}

/** The JSON text when the line is an [RD_RecordJSON] object, bare or after the tag; otherwise null. */
function jsonBody(text, fmt) {
  if (text.startsWith('{')) return text;
  if (!fmt.tag) return null;
  // Nearly every line is a plain one without a brace: that is told without cutting the line up.
  const n = fmt.tag.length + fmt.delimiter.length;
  if (text.indexOf('{', n) < 0) return null;
  if (text.slice(0, n).toLowerCase() !== fmt.tagDelimLower) return null;
  const rest = text.slice(n).trim();
  return rest.startsWith('{') ? rest : null;
}

// Several spellings because RR12's record JSON and hand-written expressions name things differently.
const JSON_KEYS = {
  location: ['timingpoint', 'timingpointname', 'location', 'point'],
  bib: ['bib', 'idbib', 'bibnumber'],
  time: ['time', 'tod', 'timeofday'],
  contest: ['contest', 'contestname', 'contest.name'],
  first: ['firstname', 'first'],
  last: ['lastname', 'last'],
  team: ['club', 'team', 'affiliation', 'school'],
  gender: ['gender', 'sex'],
};

/** @param {string} body @returns {ParseResult} */
function parseJsonRecord(body) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    return fail("Can't read the JSON record (the line is not valid JSON)");
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('The JSON record is not an object');
  const lower = new Map(Object.entries(obj).map(([key, val]) => [key.toLowerCase(), val]));
  const values = emptyValues();
  for (const [field, keys] of Object.entries(JSON_KEYS)) {
    for (const key of keys) {
      const val = lower.get(key);
      if (typeof val === 'string' || typeof val === 'number') {
        const s = String(val).trim();
        if (s) { values[field] = s; break; }
      }
    }
  }
  return toRead(values);
}

// ---------------------------------------------------------------------------------------------------------------
// TCP listener

/**
 * @typedef {{ id: number, remote: string, connectedAt: number, lines: number, lastLineAt: number | null,
 *             dropped: number }} ConnectionStatus
 * @typedef {{ listening: boolean, port: number, error: string | null, connections: ConnectionStatus[],
 *             totalLines: number, lastLineAt: number | null, totalDropped: number }} InputStatus
 * @typedef {{ connId: number, remote: string, receivedAt: number }} LineMeta
 */

const TERMINATOR = /\r\n|\r|\n|\t/;
// How long one event-loop turn may spend on RR12 reads before the connection pauses for the next turn (see #slice).
const SLICE_MS = 40;

/** Friendly words for the status pill; the operator should know what to do without looking anything up. */
function listenErrorMessage(err, port, host) {
  const code = err && err.code;
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use by another program (is Split Relay already running?). `
      + 'Close that program or choose another port.';
  }
  if (code === 'EACCES') return `Windows refused port ${port} (access denied). Choose another port.`;
  if (code === 'EADDRNOTAVAIL') return `The address ${host} does not belong to this computer.`;
  if (code === 'ERR_SOCKET_BAD_PORT' || err instanceof RangeError) {
    return `Port ${port} is not a valid port number (use a number from 1 to 65535).`;
  }
  return `Can't listen on port ${port}: ${err && err.message ? err.message : String(err)}`;
}

/** "5565" from a form field -> 5565; anything else is kept so listen() can report it in words. */
function toPort(port) {
  return typeof port === 'string' && /^\s*\d+\s*$/.test(port) ? Number(port) : port;
}

function remoteOf(socket) {
  const addr = String(socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
  return addr.includes(':') ? `[${addr}]:${socket.remotePort}` : `${addr}:${socket.remotePort}`;
}

/**
 * Listens for RR12's exporter. Several connections at once are fine (RR reconnects, a backup PC, a test client).
 * Emits 'line' (text, LineMeta) for every non-blank line, 'status' (InputStatus) when anything the panel shows
 * changes, and 'dropped' ({ connId, remote, length, receivedAt, reason, message, text }) for a line that is not
 * passed on: reason 'too-long' (over the length limit) or 'unterminated' (the end of a connection that uses line
 * ends, cut off before its line end). `message` says it in words for the log.
 */
export class InputServer extends EventEmitter {
  #port;
  #host;
  #quietFlushMs;
  #retryMs;
  #maxLine;
  /** The input format, to split reads glued together by RR12's "Line end: none". */
  #format;
  /** @type {net.Server | null} */
  #server = null;
  #listening = false;
  #boundPort = null;
  #error = null;
  /** True between start() and stop(): a failed listen keeps retrying only while the operator wants it running. */
  #wanted = false;
  #retryTimer = null;
  #starting = null;
  #conns = new Map();
  /** Connection ids: shared by every port's listener (main.js), so "#3" names one connection in the log. */
  #connIds;
  #totalLines = 0;
  #totalDropped = 0;
  #lastLineAt = null;
  #sliceMs;
  /** performance.now() of the first read of this event-loop turn, or null */
  #turnStart = null;

  /**
   * @param {{ port?: number, host?: string, quietFlushMs?: number, retryMs?: number, maxLineLength?: number,
   *   format?: InputFormat, sliceMs?: number, connIds?: () => number }} [opts]
   *   port 0 picks a free port (status().port tells which). retryMs: how often a failed listen (port busy) is tried
   *   again, 0 = never. format: Config.input (the default format when not given); see setFormat. sliceMs: how long
   *   one event-loop turn may spend on reads before the connection pauses until the next turn. connIds: hands out
   *   connection ids (one counter for several listeners); default 1, 2, 3 ... per listener.
   */
  constructor({ port = 5565, host = '0.0.0.0', quietFlushMs = 300, retryMs = 5000, maxLineLength = 4096,
    format = DEFAULT_INPUT_FORMAT, sliceMs = SLICE_MS, connIds = null } = {}) {
    super();
    this.#port = toPort(port);
    this.#host = host;
    this.#quietFlushMs = quietFlushMs;
    this.#retryMs = retryMs;
    this.#maxLine = maxLineLength;
    this.#format = format;
    this.#sliceMs = sliceMs > 0 ? sliceMs : SLICE_MS;
    let next = 1;
    this.#connIds = typeof connIds === 'function' ? connIds : () => next++;
  }

  /**
   * The input format changed in Settings. Only used to split glued reads; a line whose shape does not fit the format
   * is passed on whole, so a stale format can never cut a line in the wrong place.
   * @param {InputFormat} format
   */
  setFormat(format) {
    this.#format = format ?? DEFAULT_INPUT_FORMAT;
  }

  /**
   * Start listening. Never rejects: a busy or invalid port shows up as status().error (and is retried every retryMs),
   * because a crash here would take the whole relay down with it.
   * @returns {Promise<InputStatus>}
   */
  start() {
    this.#wanted = true;
    this.#clearRetry();
    if (!this.#starting) this.#starting = this.#listen().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  /**
   * Stop listening and close every connection (RR12 will retry until we are back). Partial lines are delivered first.
   * @returns {Promise<InputStatus>}
   */
  async stop() {
    this.#wanted = false;
    this.#clearRetry();
    if (this.#starting) await this.#starting;
    const server = this.#server;
    this.#server = null;
    for (const conn of [...this.#conns.values()]) this.#closeConn(conn, true);
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
    this.#listening = false;
    this.#boundPort = null;
    this.#error = null;
    this.#emitStatus();
    return this.status();
  }

  /**
   * Stop, then start again — on `port` when given (0 = any free port), else on the same port.
   * @param {number} [port]
   * @returns {Promise<InputStatus>}
   */
  async restart(port) {
    await this.stop();
    if (port !== undefined && port !== null) this.#port = toPort(port);
    return this.start();
  }

  /** @returns {InputStatus} */
  status() {
    return {
      listening: this.#listening,
      port: this.#listening ? this.#boundPort : this.#port,
      error: this.#error,
      connections: [...this.#conns.values()].map((c) => ({
        id: c.id, remote: c.remote, connectedAt: c.connectedAt, lines: c.lines, lastLineAt: c.lastLineAt, dropped: c.dropped,
      })),
      totalLines: this.#totalLines,
      lastLineAt: this.#lastLineAt,
      totalDropped: this.#totalDropped,
    };
  }

  #listen() {
    if (this.#server) return Promise.resolve(this.status());
    return new Promise((resolve) => {
      const server = net.createServer({ allowHalfOpen: false }, (socket) => this.#accept(socket));
      this.#server = server;
      const failed = (err) => {
        if (this.#server === server) this.#server = null;
        server.close(() => {});
        this.#listening = false;
        this.#boundPort = null;
        this.#error = listenErrorMessage(err, this.#port, this.#host);
        if (!(err instanceof RangeError)) this.#scheduleRetry();
        this.#emitStatus();
        resolve(this.status());
      };
      server.once('error', failed);
      try {
        server.listen({ port: this.#port, host: this.#host }, () => {
          server.off('error', failed);
          server.on('error', (err) => this.#serverError(server, err));
          const addr = server.address();
          this.#boundPort = addr && typeof addr === 'object' ? addr.port : this.#port;
          this.#listening = true;
          this.#error = null;
          this.#emitStatus();
          resolve(this.status());
        });
      } catch (err) {
        server.off('error', failed);
        failed(err);
      }
    });
  }

  /** An error after we were listening. Accept errors (e.g. out of handles) leave the server up; anything else retries. */
  #serverError(server, err) {
    if (this.#server !== server) return;
    this.#error = listenErrorMessage(err, this.#boundPort ?? this.#port, this.#host);
    if (!server.listening) {
      this.#server = null;
      this.#listening = false;
      this.#boundPort = null;
      server.close(() => {});
      this.#scheduleRetry();
    }
    this.#emitStatus();
  }

  #scheduleRetry() {
    this.#clearRetry();
    if (!this.#wanted || !(this.#retryMs > 0)) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#wanted && !this.#server && !this.#starting) this.start();
    }, this.#retryMs);
    this.#retryTimer.unref?.();
  }

  #clearRetry() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** @param {net.Socket} socket */
  #accept(socket) {
    if (!this.#server) {
      socket.destroy();
      return;
    }
    const conn = {
      id: this.#connIds(),
      socket,
      remote: remoteOf(socket),
      connectedAt: Date.now(),
      lines: 0,
      dropped: 0,
      lastLineAt: null,
      // Per connection, so a UTF-8 character split across two TCP chunks is reassembled instead of becoming U+FFFD.
      decoder: new StringDecoder('utf8'),
      buf: '',
      /** Inside an over-long line: everything up to its terminator is thrown away, not delivered as a fragment. */
      discarding: false,
      /**
       * A line end has come in on this connection, so RR12 ends its lines. Then a line without one is incomplete
       * (the rest is still on its way, or never comes), never a read of its own.
       */
      terminated: false,
      timer: null,
      lastChunkAt: 0,
      closed: false,
      /** paused until the next event-loop turn (#slice) */
      paused: false,
    };
    this.#conns.set(conn.id, conn);
    // TCP keepalive probes carry no data; they let a vanished RR PC drop off the connection list.
    socket.setKeepAlive(true, 10_000);
    socket.on('data', (chunk) => this.#onData(conn, chunk));
    socket.on('error', () => { /* RR resets the connection when the exporter stops; 'close' follows */ });
    socket.on('close', () => this.#closeConn(conn, false));
    this.#emitStatus();
  }

  #onData(conn, chunk) {
    if (conn.closed) return;
    this.#slice(conn);
    conn.lastChunkAt = Date.now();
    this.#clearFlush(conn);
    this.#deliver(conn, this.#split(conn, conn.decoder.write(chunk)));
    // RR12 can be set to send no line end at all; without this the last read would wait for the next passing. Only
    // on a connection that has never sent a line end: on one that has, an unterminated rest is the first part of a
    // line whose next TCP segment is late (a retransmit on Wi-Fi takes 300 ms or more), and flushing it would send a
    // cut-off, earlier time.
    if (conn.buf && !conn.terminated) {
      conn.timer = setTimeout(() => this.#quietFlush(conn), this.#quietFlushMs);
      conn.timer.unref?.();
    }
  }

  /**
   * Node reads a socket that has a lot waiting (an RR12 Replay of a whole meet: megabytes at once) chunk after chunk
   * without coming up for air, so the hold timers, the outputs and the control panel would wait until all of it was
   * processed. Once this event-loop turn has spent SLICE_MS on reads, the connection pauses until the next turn: the
   * rest stays in the socket, in order, and everything else gets its turn in between.
   */
  #slice(conn) {
    const now = performance.now();
    if (this.#turnStart === null) {
      this.#turnStart = now;
      setImmediate(() => { this.#turnStart = null; });
    }
    if (now - this.#turnStart < this.#sliceMs || conn.paused) return;
    conn.paused = true;
    conn.socket.pause();
    setImmediate(() => {
      conn.paused = false;
      if (!conn.closed) conn.socket.resume();
    });
  }

  /** Complete lines from what has arrived so far; the unterminated rest stays in conn.buf. */
  #split(conn, text) {
    const parts = (conn.buf + text).split(TERMINATOR);
    conn.buf = parts.pop() ?? '';
    if (parts.length > 0) conn.terminated = true;
    // FinishLynx LapTime records start with SOH (or STX). In the rest still waiting for its line end, everything
    // before the last SOH is whole records (RR12 "Line end: none" glues them): they go now, not after a quiet gap,
    // which a busy start may never leave. Only before a later SOH: the record after it may still be on its way.
    const at = Math.max(conn.buf.lastIndexOf('\x01'), conn.buf.lastIndexOf('\x02'));
    if (at > 0 && conn.buf.slice(0, at).replace(EDGE_JUNK, '')) {
      parts.push(conn.buf.slice(0, at));
      conn.buf = conn.buf.slice(at);
    }
    const lines = [];
    for (const part of parts) {
      if (conn.discarding) {
        conn.discarding = false; // the tail of a line already counted as dropped
        continue;
      }
      if (part.length > this.#maxLine) {
        this.#drop(conn, part.length);
        continue;
      }
      // A CRLF split across chunks leaves an empty "line" between CR and LF; blank lines carry nothing anyway.
      if (part.trim()) lines.push(part);
    }
    if (conn.buf.length > this.#maxLine) {
      if (!conn.discarding) this.#drop(conn, conn.buf.length);
      conn.discarding = true;
      conn.buf = '';
    }
    return lines;
  }

  #quietFlush(conn) {
    conn.timer = null;
    if (conn.closed) return;
    const rest = conn.buf;
    conn.buf = '';
    if (conn.discarding) {
      conn.discarding = false;
      return;
    }
    if (rest.trim()) this.#deliver(conn, [rest]);
  }

  /**
   * @param {'too-long' | 'unterminated'} [reason]
   * @param {string} [text] the start of what was dropped, for the log
   */
  #drop(conn, length, reason = 'too-long', text = '') {
    conn.dropped++;
    this.#totalDropped++;
    const message = reason === 'too-long'
      ? `a line of ${length} characters was too long and was dropped. Check the RR12 Export Data expression.`
      : `the connection closed in the middle of a line, so its last ${length} characters were not used (the rest ` +
        'of that read never came): ' + text.slice(0, 200);
    this.#safeEmit('dropped', { connId: conn.id, remote: conn.remote, length, receivedAt: conn.lastChunkAt || Date.now(),
      reason, message, text: text.slice(0, 200) });
  }

  #deliver(conn, lines, announce = true) {
    if (!lines.length) return;
    // The arrival of the chunk that completed the line, not when a quiet-flush timer fired.
    const receivedAt = conn.lastChunkAt || Date.now();
    for (const line of lines) {
      // Reads glued together by "Line end: none" become separate lines again, so no read is lost to its neighbour:
      // LapTime records by their SOH, SR records by their tag.
      for (const text of splitFramed(line).flatMap((rec) => splitGlued(rec, this.#format) ?? [rec])) {
        conn.lines++;
        conn.lastLineAt = receivedAt;
        this.#totalLines++;
        this.#lastLineAt = receivedAt;
        this.#safeEmit('line', text, { connId: conn.id, remote: conn.remote, receivedAt });
      }
    }
    if (announce) this.#emitStatus();
  }

  #closeConn(conn, destroy) {
    if (conn.closed) return;
    this.#clearFlush(conn);
    const tail = this.#split(conn, conn.decoder.end());
    const rest = conn.discarding ? '' : conn.buf;
    conn.buf = '';
    conn.discarding = false;
    // With no line ends at all (RR12 "Line end: none"), what arrived before the close is a whole read. On a
    // connection that ends its lines, it is a line cut off by the close: dropped, and said in the log.
    const cutOff = rest.trim() && conn.terminated ? rest : '';
    if (rest.trim() && !cutOff) tail.push(rest);
    conn.closed = true;
    this.#deliver(conn, tail, false);
    if (cutOff) this.#drop(conn, cutOff.length, 'unterminated', cutOff);
    this.#conns.delete(conn.id);
    if (destroy) conn.socket.destroy();
    this.#emitStatus();
  }

  #clearFlush(conn) {
    if (conn.timer) clearTimeout(conn.timer);
    conn.timer = null;
  }

  #emitStatus() {
    this.#safeEmit('status', this.status());
  }

  /** A throwing listener must not kill the socket handler (and with it the process) in the middle of a race. */
  #safeEmit(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch (err) {
      if (event !== 'error' && this.listenerCount('error') > 0) {
        try { this.emit('error', err); } catch { /* nothing more we can do */ }
      } else {
        console.error(`[input] '${event}' listener failed:`, err);
      }
    }
  }
}
