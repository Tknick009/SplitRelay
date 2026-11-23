// FinishLynx scoreboard scripts (.lss). Split Relay renders the user's own scripts for split crossings, so TrackScore
// and live results receive exactly the packets they already parse from FinishLynx. The language is in DESIGN.md
// section 5. Nothing here may throw on a script: a timer edits these files by hand, often on race morning, and a bad
// line must cost a warning, never the relay.

import { decodeCp1252, encodeCp1252 } from './cp1252.js';

/** Byte -> the windows-1252 character encodeCp1252 turns back into that byte, so `\80` really sends 0x80. */
const BYTE_CHAR = decodeCp1252(Uint8Array.from({ length: 256 }, (_, i) => i));

const G_INIT = 0x10;
const G_TIME = 0x11;
const G_WIND = 0x12;
const G_HEADER = 0x13;
const G_ROW = 0x14;
const G_MSG_HEADER = 0x15;
const G_MSG = 0x16;
const G_ANY = 0x17;

const HEAD = [G_HEADER, G_ANY];
const BODY = [G_HEADER, G_ROW, G_ANY];
const MSG_HEAD = [G_HEADER, G_MSG_HEADER, G_ANY];

/** Known sections: the group a legacy one-byte line gets, and the groups FinishLynx accepts there. */
const SECTIONS = {
  initialization: { title: 'Initialization', group: G_INIT, valid: [G_INIT, G_HEADER, G_ANY] },
  wind: { title: 'Wind', group: G_WIND, valid: [G_WIND, G_HEADER, G_ANY] },
  startlistheader: { title: 'StartListHeader', group: G_HEADER, valid: HEAD },
  startlist: { title: 'StartList', group: G_ROW, valid: BODY },
  startlisttrailer: { title: 'StartListTrailer', group: G_HEADER, valid: HEAD },
  startedheader: { title: 'StartedHeader', group: G_HEADER, valid: HEAD },
  started: { title: 'Started', group: G_ROW, valid: BODY },
  startedtrailer: { title: 'StartedTrailer', group: G_HEADER, valid: HEAD },
  resultsheader: { title: 'ResultsHeader', group: G_HEADER, valid: HEAD },
  results: { title: 'Results', group: G_ROW, valid: BODY },
  resultstrailer: { title: 'ResultsTrailer', group: G_HEADER, valid: HEAD },
  messageheader: { title: 'MessageHeader', group: G_HEADER, valid: MSG_HEAD },
  message: { title: 'Message', group: G_MSG, valid: [G_HEADER, G_MSG_HEADER, G_MSG, G_ANY] },
  messagetrailer: { title: 'MessageTrailer', group: G_HEADER, valid: MSG_HEAD },
};

/** Where each stage looks for its sections, in fall-back order. */
const CHAINS = { results: ['results'], started: ['started', 'startlist', 'results'], startlist: ['startlist', 'results'] };

/** One `%[-][width][.prec]s` must never be able to allocate megabytes (a typo like %99999s, or fuzz). */
const MAX_FIELD = 1024;

const OPS = '=*/#+-<>&|^~';
const COMMANDS = 'UXLRBDIOSFP' + OPS;

/**
 * @typedef {{ kind: 'text', text: string }} TextToken
 * @typedef {{ kind: 'value', left: boolean, width: number, prec: number | null, next: string, extra: boolean }} ValueToken
 *   `next` is the first non-space character after the %s on its line ('' = end of line); `extra` marks a second %s.
 * @typedef {{ kind: 'cmd', cmd: string, n: number, flag: boolean }} CommandToken
 *   `flag` is the `i` of \Ui / \Xi or the `c` of \Ic.
 * @typedef {TextToken | ValueToken | CommandToken} Token
 * @typedef {{ lineNo: number, source: string, group: number | null, variable: number, tokens: Token[], text: string,
 *   skip: boolean, usesCommands: boolean }} Line
 *   One format line. `skip` lines are kept (so a section's line count matches the file) but never rendered.
 * @typedef {{ sections: Record<string, Line[]>, titles: Record<string, string>, warnings: string[] }} Script
 *   `sections` is keyed by lower-case name in file order; `titles` holds the name to show the user.
 * @typedef {Record<number, string> | Map<number, string>} Values  LSS variable code -> value
 * @typedef {{ stage?: 'results' | 'started' | 'startlist', header?: Values, rows?: Values[], json?: 'auto' | boolean,
 *   skipEmpty?: number[] }} RenderOptions
 *   skipEmpty: row variables (group ) whose line is left out entirely when the row's value is empty.
 * @typedef {{ text: string, warnings: string[], isJson: boolean, jsonErrors: string[] }} RenderResult
 *   `text` holds windows-1252 characters: encodeCp1252(text) is the packet.
 */

const hex2 = (n) => n.toString(16).padStart(2, '0');
const isHex = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
const isDigit = (c) => c >= '0' && c <= '9';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v';

/** Script warnings, one per kind, with where it happened: "... (lines 7, 52)". */
class Notes {
  constructor() {
    /** @type {Map<string, { message: string, lines: number[], count: number }>} */
    this.kinds = new Map();
  }

  add(key, message, lineNo) {
    let k = this.kinds.get(key);
    if (!k) this.kinds.set(key, (k = { message, lines: [], count: 0 }));
    if (lineNo && k.lines.at(-1) !== lineNo) {
      k.count++;
      if (k.lines.length < 4) k.lines.push(lineNo);
    }
  }

  list() {
    return [...this.kinds.values()].map(({ message, lines, count }) => {
      if (!lines.length) return message;
      const more = count > lines.length ? ` and ${count - lines.length} more` : '';
      return `${message} (line${count > 1 ? 's' : ''} ${lines.join(', ')}${more})`;
    });
  }
}

/** The byte a script character stands for, for reading line codes. */
function byteOf(item) {
  return item.byte ?? encodeCp1252(item.ch)[0] ?? 0x3f;
}

function sectionInfo(key, name) {
  if (Object.hasOwn(SECTIONS, key)) return SECTIONS[key];
  if (key.startsWith('time')) return { title: name, group: G_TIME, valid: [G_TIME, G_HEADER, G_ANY] };
  return null;
}

/**
 * `;;Name` / `;;Name[n]` -> the section, or null for a separator such as `;;;;;;;;` (a name must start with a letter,
 * otherwise a row of semicolons between sections would swallow every line after it).
 */
function parseSectionHeader(rest) {
  let name = rest.trim();
  let page = 0;
  const m = /\[\s*(\d*)\s*\]$/.exec(name);
  if (m) {
    page = Number(m[1] || 0);
    name = name.slice(0, m.index).trim();
  }
  if (!/^[A-Za-z]/.test(name)) return null;
  let key = name.toLowerCase();
  if (key === 'result') key = 'results';
  const info = sectionInfo(key, name);
  return { key, name, page, info, title: info ? info.title : name };
}

/**
 * Escape decoding: one format line -> characters and commands. `\hh` needs lowercase hex because `\A`-`\Z` are
 * commands; a backslash before anything else emits nothing (XCScore.lss relies on `\,` emitting nothing).
 * @returns {Array<{ ch: string, byte?: number } | { cmd: string, n: number, flag: boolean }>}
 */
function scanLine(raw, lineNo, notes) {
  const items = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== '\\') {
      items.push({ ch: c });
      i++;
      continue;
    }
    const d = raw[i + 1];
    if (isHex(d) && isHex(raw[i + 2])) {
      const b = parseInt(raw.slice(i + 1, i + 3), 16);
      items.push({ ch: BYTE_CHAR[b], byte: b });
      i += 3;
      continue;
    }
    if (d === undefined) {
      notes.add('trailing', 'A \\ at the end of a line emits nothing', lineNo);
      i++;
      continue;
    }
    if ((d >= 'A' && d <= 'Z') || OPS.includes(d)) {
      i = scanCommand(raw, i, items, lineNo, notes);
      continue;
    }
    const e = raw[i + 2];
    if (isDigit(d) && e >= 'A' && e <= 'F') {
      notes.add('upper-hex', `\\${d}${e} is not a byte: hex escapes must be lowercase (\\${d}${e.toLowerCase()}), ` +
        `so only the ${e} is sent`, lineNo);
    } else {
      notes.add(`escape:${d}`, `\\${d} is not an escape FinishLynx knows; it emits nothing`, lineNo);
    }
    i += 2;
  }
  return items;
}

/** `\hh` (lowercase) or a single digit at raw[j]. */
function argAt(raw, j) {
  if (raw[j] === '\\' && isHex(raw[j + 1]) && isHex(raw[j + 2])) return { n: parseInt(raw.slice(j + 1, j + 3), 16), end: j + 3 };
  if (isDigit(raw[j])) return { n: raw.charCodeAt(j) - 48, end: j + 1 };
  return null;
}

/** A command at raw[i] (the backslash). Pushes it when usable; returns where scanning continues. */
function scanCommand(raw, i, items, lineNo, notes) {
  const cmd = raw[i + 1];
  // \0D-style uppercase hex lands here as \D, \F, \A ... — say so, it is the likeliest mistake
  const hint = /^[0-9A-F][0-9A-Fa-f]$/.test(raw.slice(i + 1, i + 3)) && /[A-F]/.test(raw.slice(i + 1, i + 3))
    ? ` (for the byte write \\${raw.slice(i + 1, i + 3).toLowerCase()}: hex escapes must be lowercase)` : '';
  if (!COMMANDS.includes(cmd)) {
    notes.add(`cmd:${cmd}`, `\\${cmd} is not a command Split Relay supports; ignored${hint}`, lineNo);
    return i + 2;
  }
  let j = i + 2;
  const flag = ((cmd === 'U' || cmd === 'X') && raw[j] === 'i') || (cmd === 'I' && raw[j] === 'c');
  if (flag) j++;
  const a = argAt(raw, j);
  if (!a) {
    notes.add(`arg:${cmd}`, `\\${cmd} needs an argument (one digit or \\hh); ignored${hint}`, lineNo);
    return i + 2;
  }
  const n = a.n;
  const register = OPS.includes(cmd) || cmd === 'O' || cmd === 'S' || ((cmd === 'U' || cmd === 'X') && flag);
  if (register && n > 9) {
    notes.add('register', `There are only registers 0-9; \\${cmd}${flag ? raw[i + 2] : ''} with ${n} is ignored`, lineNo);
  } else if (cmd === 'F' && (n < 1 || n > 4)) {
    notes.add('checksum', `\\F${n} is not a checksum (1 XOR, 2 ADD, 3 CRC-16, 4 CRC-32); ignored`, lineNo);
  } else if (cmd === 'P' && n !== 0) {
    notes.add('reverse', `Only \\P0 (reverse the line) is supported; \\P${n} ignored`, lineNo);
  } else {
    items.push({ cmd, n, flag });
  }
  return a.end;
}

function field(digits, lineNo, notes) {
  const n = Number(digits);
  if (n <= MAX_FIELD) return n;
  notes.add('wide', `A %s width or precision above ${MAX_FIELD} is cut to ${MAX_FIELD}`, lineNo);
  return MAX_FIELD;
}

/** Variable 0: the rest of the line goes out as written, `%` included. */
function plainTokens(items) {
  /** @type {Token[]} */
  const tokens = [];
  let text = '';
  for (const it of items) {
    if (!('cmd' in it)) {
      text += it.ch;
      continue;
    }
    if (text) tokens.push({ kind: 'text', text });
    text = '';
    tokens.push({ kind: 'cmd', cmd: it.cmd, n: it.n, flag: it.flag });
  }
  if (text) tokens.push({ kind: 'text', text });
  return tokens;
}

/** Variable != 0: a printf format with one `%[-][width][.prec]s`; `%%` is a percent sign. */
function formatTokens(items, lineNo, notes) {
  /** @type {Token[]} */
  const tokens = [];
  let text = '';
  let values = 0;
  const flush = () => {
    if (text) tokens.push({ kind: 'text', text });
    text = '';
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if ('cmd' in it) {
      flush();
      tokens.push({ kind: 'cmd', cmd: it.cmd, n: it.n, flag: it.flag });
      continue;
    }
    if (it.ch !== '%') {
      text += it.ch;
      continue;
    }
    let ahead = '';
    for (let j = i; j < items.length && j < i + 24 && !('cmd' in items[j]); j++) ahead += items[j].ch;
    const m = /^%(?:(%)|(-?)(\d*)(?:\.(\d*))?s)/.exec(ahead);
    if (!m) {
      notes.add('percent', 'A % that is not part of %s or %% is sent as a plain %', lineNo);
      text += '%';
      continue;
    }
    i += m[0].length - 1;
    if (m[1]) {
      text += '%';
      continue;
    }
    flush();
    tokens.push({
      kind: 'value', left: m[2] === '-', width: field(m[3] || '0', lineNo, notes),
      prec: m[4] === undefined ? null : field(m[4] || '0', lineNo, notes), next: '', extra: values > 0,
    });
    values++;
  }
  flush();
  if (values === 0) notes.add('no-value', 'A line with a variable code but no %s never shows the value', lineNo);
  if (values > 1) notes.add('many-values', 'A line can show its variable once; a second %s stays empty', lineNo);
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === 'value') tok.next = nextNonSpace(tokens, t + 1);
  }
  return tokens;
}

/** What follows a %s on its line, for spotting unquoted JSON values; '' = nothing (end of line). */
function nextNonSpace(tokens, from) {
  for (let t = from; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === 'value') return '%';
    if (tok.kind !== 'text') continue;
    for (const c of tok.text) if (!isSpace(c)) return c;
  }
  return '';
}

function buildLine(raw, lineNo, section, notes) {
  /** @type {Line} */
  const line = { lineNo, source: raw, group: null, variable: 0, tokens: [], text: '', skip: true, usesCommands: false };
  const items = scanLine(raw, lineNo, notes);
  if (!items.length) return line; // "\," and friends: nothing to send
  if ('cmd' in items[0]) {
    notes.add('no-code', 'A format line must start with a code such as \\14\\01 or \\00, not a command; skipped', lineNo);
    return line;
  }
  const first = byteOf(items[0]);
  let rest = 1;
  if (first >= 0x10) {
    line.group = first;
    if (items[1] && !('cmd' in items[1])) {
      line.variable = byteOf(items[1]);
      rest = 2;
    }
  } else {
    line.variable = first;
    line.group = section.info ? section.info.group : null;
  }
  if (!section.info) return line; // unknown section: warned once at its header, never rendered
  if (!section.info.valid.includes(line.group)) {
    if (line.group >= G_INIT && line.group <= G_ANY) {
      notes.add(`group:${section.key}:${line.group}`,
        `Group \\${hex2(line.group)} is not used in ;;${section.title}; those lines are skipped`, lineNo);
    } else {
      notes.add('not-code', 'A format line must start with a code such as \\14\\01 or \\00; lines starting with ' +
        `"${escapeForDisplay(items[0].ch)}" are skipped`, lineNo);
    }
    return line;
  }
  const after = items.slice(rest);
  line.tokens = line.variable === 0 ? plainTokens(after) : formatTokens(after, lineNo, notes);
  line.text = line.tokens.map((t) => (t.kind === 'text' ? t.text : '')).join('');
  line.usesCommands = line.tokens.some((t) => t.kind === 'cmd');
  line.skip = false;
  return line;
}

/**
 * A .lss script -> its sections. Never throws; problems are listed in `warnings` in plain English with line numbers.
 * Accepts the file's text (decode it with decodeCp1252: FinishLynx scripts are windows-1252) or its raw bytes.
 * @param {string | Uint8Array} text
 * @returns {Script}
 */
export function parseScript(text) {
  /** @type {Script} */
  const script = { sections: {}, titles: {}, warnings: [] };
  const notes = new Notes();
  try {
    let src = text instanceof Uint8Array ? decodeCp1252(text) : String(text ?? '');
    // a UTF-8 BOM, whether it arrives decoded or as the three windows-1252 characters it looks like
    src = src.replace(/^(?:\uFEFF|\u00EF\u00BB\u00BF)/, '');
    let current = null;
    const lines = src.split(/\r\n|\r|\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const raw = lines[idx];
      const lineNo = idx + 1;
      if (!raw.trim()) continue;
      const lead = raw.trimStart();
      if (lead.startsWith(';')) {
        if (!lead.startsWith(';;')) continue;
        const head = parseSectionHeader(lead.slice(2));
        if (!head) continue;
        if (!Object.hasOwn(script.sections, head.key)) {
          script.sections[head.key] = [];
          script.titles[head.key] = head.title;
        }
        if (!head.info) notes.add(`unknown:${head.key}`, `;;${head.name} is not a section Split Relay knows; its lines are never sent`, lineNo);
        if (head.page !== 0) {
          notes.add(`page:${head.key}`, `Page numbers are ignored: ;;${head.name}[${head.page}] is used as part of ;;${head.title}`, lineNo);
        }
        current = { key: head.key, info: head.info, title: head.title };
        continue;
      }
      if (!current) {
        notes.add('orphan', 'Lines before the first ;;Section are ignored', lineNo);
        continue;
      }
      script.sections[current.key].push(buildLine(raw, lineNo, current, notes));
    }
  } catch (err) {
    notes.add('internal', `Split Relay could not read part of this script (${err?.message ?? err})`);
  }
  script.warnings = notes.list();
  return script;
}

function asScript(script) {
  if (typeof script === 'string' || script instanceof Uint8Array) return parseScript(script);
  if (script && typeof script === 'object' && script.sections && typeof script.sections === 'object') return script;
  return null;
}

function linesOf(script, key) {
  if (!Object.hasOwn(script.sections, key)) return null;
  const lines = script.sections[key];
  return Array.isArray(lines) ? lines : [];
}

/** The sections a stage renders, after the Started -> StartList -> Results fall-backs. */
function planStage(script, stage, warnings) {
  let key = String(stage ?? 'results').toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'result') key = 'results';
  if (!Object.hasOwn(CHAINS, key)) {
    warnings.add(`Unknown stage "${stage}"; using the Results sections`);
    key = 'results';
  }
  const chain = CHAINS[key];
  const pick = (suffix) => {
    for (const base of chain) {
      const lines = linesOf(script, base + suffix);
      if (lines) return lines;
    }
    return null;
  };
  const body = pick('');
  if (!body) {
    warnings.add(`The script has no ${chain.map((b) => ';;' + SECTIONS[b].title).join(' or ')} section, ` +
      'so no runner lines are sent');
  }
  return { key, header: pick('header') ?? [], body: body ?? [], trailer: pick('trailer') ?? [] };
}

function valueOf(map, code) {
  if (!map || typeof map !== 'object') return '';
  const v = map instanceof Map ? map.get(code) : map[code];
  if (v == null || typeof v === 'symbol' || typeof v === 'function') return '';
  return String(v);
}

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const UNSAFE = /["\\{}\u0000-\u001f\u007f]/g;

/**
 * Commands (DESIGN.md section 5; neither target script uses them, so this is best effort):
 * - registers r0-r9 are unsigned 32-bit and live for one update; r0 is set to the row index (0-based) before each row.
 * - \U / \X set U and X (\Ui / \Xi: from a register); both reset after the next other command and at each new line.
 * - operand of \= \* \/ \# \+ \- \< \> \& \| \^ = r[U], else X, else 1. \/ and \# by 0 leave the register alone.
 * - \L \R move the cursor; \B deletes before it, \D at it; \I inserts spaces, \Ic copies of character X; text, %s and
 *   \I insert at the cursor and move it past what they inserted.
 * - \On writes r[n] at the cursor, method U (default 0): 0/1 binary little/big endian in X bytes (default 1);
 *   2-5 decimal padded to at least X characters: 2 spaces left, 3 zeros left, 4 spaces right, 5 zeros right.
 * - \Fn checksums the line from the cursor to the end (as windows-1252 bytes) into r[U] (default r0):
 *   1 XOR, 2 ADD (sum), 3 CRC-16/ARC (seed 0), 4 CRC-32 (IEEE, seed and final xor 0xffffffff).
 * - \Sn reads the decimal number at the cursor (leading spaces skipped) into r[n] and moves past it.
 * - \P0 reverses the whole line.
 */
function runCommand(tok, st, ctx) {
  const { regs } = ctx;
  const n = tok.n;
  switch (tok.cmd) {
    case 'U':
      st.U = tok.flag ? regs[n] : n;
      return;
    case 'X':
      st.X = tok.flag ? regs[n] : n;
      return;
    case 'L':
      st.cur = n === 0 ? 0 : Math.max(0, st.cur - n);
      break;
    case 'R':
      st.cur = n === 0 ? st.buf.length : Math.min(st.buf.length, st.cur + n);
      break;
    case 'B': {
      const from = n === 0 ? 0 : Math.max(0, st.cur - n);
      st.buf = st.buf.slice(0, from) + st.buf.slice(st.cur);
      st.cur = from;
      break;
    }
    case 'D': {
      const to = n === 0 ? st.buf.length : Math.min(st.buf.length, st.cur + n);
      st.buf = st.buf.slice(0, st.cur) + st.buf.slice(to);
      break;
    }
    case 'I':
      insert(st, (tok.flag && st.X != null ? BYTE_CHAR[st.X & 0xff] : ' ').repeat(n));
      break;
    case 'O':
      insert(st, outputNumber(regs[n], st.U ?? 0, st.X ?? 1, ctx));
      break;
    case 'S': {
      let i = st.cur;
      while (st.buf[i] === ' ') i++;
      const m = /^\d+/.exec(st.buf.slice(i, i + 20));
      regs[n] = m ? (Number(m[0]) % 2 ** 32) >>> 0 : 0;
      st.cur = m ? i + m[0].length : st.cur;
      break;
    }
    case 'F': {
      const dest = st.U ?? 0;
      if (dest > 9) ctx.warnings.add(`\\F: register ${dest} does not exist (r0-r9); checksum not stored`);
      else regs[dest] = checksum(n, encodeCp1252(st.buf.slice(st.cur)));
      break;
    }
    case 'P':
      st.buf = [...st.buf].reverse().join('');
      st.cur = st.buf.length - st.cur;
      break;
    default:
      regs[n] = arithmetic(tok.cmd, regs[n], operand(st, ctx), ctx);
  }
  st.U = null;
  st.X = null;
}

function operand(st, ctx) {
  if (st.U != null) {
    if (st.U <= 9) return ctx.regs[st.U];
    ctx.warnings.add(`\\U: register ${st.U} does not exist (r0-r9); 0 used`);
    return 0;
  }
  return st.X ?? 1;
}

function arithmetic(op, r, o, ctx) {
  switch (op) {
    case '=': return o >>> 0;
    case '*': return Math.imul(r, o) >>> 0;
    case '/':
    case '#':
      if (o === 0) {
        ctx.warnings.add(`\\${op} by zero; the register is left unchanged`);
        return r;
      }
      return (op === '/' ? Math.floor(r / o) : r % o) >>> 0;
    case '+': return (r + o) >>> 0;
    case '-': return (r - o) >>> 0;
    case '<': return o >= 32 ? 0 : (r << o) >>> 0;
    case '>': return o >= 32 ? 0 : r >>> o;
    case '&': return (r & o) >>> 0;
    case '|': return (r | o) >>> 0;
    case '^': return (r ^ o) >>> 0;
    case '~': return ~r >>> 0;
    default: return r;
  }
}

function outputNumber(value, method, count, ctx) {
  let size = count;
  if (size > MAX_FIELD) {
    ctx.warnings.add(`\\O: a size above ${MAX_FIELD} is cut to ${MAX_FIELD}`);
    size = MAX_FIELD;
  }
  const v = value >>> 0;
  if (method === 0 || method === 1) {
    let s = '';
    for (let k = 0; k < size; k++) s += BYTE_CHAR[k < 4 ? (v >>> (8 * k)) & 0xff : 0];
    return method === 0 ? s : [...s].reverse().join('');
  }
  const digits = String(v);
  switch (method) {
    case 2: return digits.padStart(size, ' ');
    case 3: return digits.padStart(size, '0');
    case 4: return digits.padEnd(size, ' ');
    case 5: return digits.padEnd(size, '0');
    default:
      ctx.warnings.add(`\\O: output method ${method} does not exist (0-5); nothing written`);
      return '';
  }
}

function checksum(type, bytes) {
  let c = 0;
  if (type === 1) for (const b of bytes) c ^= b;
  else if (type === 2) for (const b of bytes) c += b;
  else if (type === 3) {
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    }
  } else {
    c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    c ^= 0xffffffff;
  }
  return c >>> 0;
}

function insert(st, s) {
  st.buf = st.buf.slice(0, st.cur) + s + st.buf.slice(st.cur);
  st.cur += s.length;
}

/** The value a %s prints, after JSON safety. */
function expand(line, tok, st, ctx) {
  const map = line.group === G_HEADER ? ctx.header : line.group === G_ROW ? ctx.row : null;
  let v = tok.extra ? '' : valueOf(map, line.variable);
  if (ctx.json) v = v.replace(UNSAFE, '');
  if (tok.prec !== null) v = v.slice(0, tok.prec);
  if (v.length < tok.width) v = tok.left ? v.padEnd(tok.width) : v.padStart(tok.width);
  if (ctx.json && !JSON_NUMBER.test(v.trim())) {
    let prev = ctx.last;
    for (let i = st.cur - 1; i >= 0; i--) {
      if (!isSpace(st.buf[i])) {
        prev = st.buf[i];
        break;
      }
    }
    // "EN":%s, with a blank or non-numeric event number would be invalid JSON and TrackScore drops the packet
    if ((prev === ':' || prev === '[' || prev === ',') && (tok.next === '' || ',}]'.includes(tok.next))) v = `"${v}"`;
  }
  return v;
}

function renderLines(lines, ctx) {
  for (const line of lines) {
    if (!line || line.skip || !Array.isArray(line.tokens)) continue;
    // "LICENCE":"" in a split packet would clear the gender FinishLynx gave the runner: leave the line out instead.
    if (line.group === G_ROW && ctx.skipEmpty.has(line.variable) && valueOf(ctx.row, line.variable) === '') continue;
    const st = { buf: '', cur: 0, U: null, X: null };
    for (const tok of line.tokens) {
      if (tok.kind === 'text') insert(st, tok.text);
      else if (tok.kind === 'value') insert(st, expand(line, tok, st, ctx));
      else if (tok.kind === 'cmd') runCommand(tok, st, ctx);
    }
    if (!st.buf) continue;
    ctx.parts.push(st.buf);
    for (let i = st.buf.length - 1; i >= 0; i--) {
      if (!isSpace(st.buf[i])) {
        ctx.last = st.buf[i];
        break;
      }
    }
  }
}

function renderPlan(plan, header, rows, json, warnings, skipEmpty = new Set()) {
  const ctx = { parts: [], last: '', regs: new Array(10).fill(0), json, header, row: null, warnings, skipEmpty };
  renderLines(plan.header, ctx);
  rows.forEach((row, i) => {
    ctx.regs[0] = i;
    ctx.row = row;
    renderLines(plan.body, ctx);
  });
  ctx.row = null;
  renderLines(plan.trailer, ctx);
  return ctx.parts.join('');
}

/** @type {WeakMap<object, Map<string, boolean>>} */
const jsonCache = new WeakMap();

/**
 * Whether a stage of this script writes JSON. Decided on a render with every value blank, so an athlete whose name
 * happens to contain `{"` cannot switch a plain scoreboard script into JSON mode.
 */
function emitsJson(script, plan) {
  let byStage = jsonCache.get(script);
  if (!byStage) jsonCache.set(script, (byStage = new Map()));
  let yes = byStage.get(plan.key);
  if (yes === undefined) {
    yes = /\{\s*"/.test(renderPlan(plan, {}, [{}], false, new Set()));
    byStage.set(plan.key, yes);
  }
  return yes;
}

/**
 * A comma left right before } or ] inside a JSON object (outside strings) is removed: a script's last field line ends
 * in "," when the line after it was left out (skipEmpty), or simply by a slip in the script, and TrackScore drops the
 * whole packet over it. Text between objects is not JSON and is left as it is.
 */
function dropTrailingCommas(text) {
  let out = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let comma = -1; // where in `out` the last significant character was a comma, outside strings
  for (const c of text) {
    if (depth === 0) {
      if (c === '{') depth = 1;
      out += c;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      out += c;
      continue;
    }
    if ((c === '}' || c === ']') && comma >= 0) out = out.slice(0, comma) + out.slice(comma + 1);
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    if (!isSpace(c)) comma = c === ',' ? out.length : -1;
    out += c;
  }
  return out;
}

/** Each top-level {...} (brace depth outside strings, text between objects ignored) through JSON.parse. */
function checkJson(text) {
  const errors = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0) {
      if (c === '{') {
        depth = 1;
        start = i;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      n++;
      const obj = text.slice(start, i + 1);
      try {
        JSON.parse(obj);
      } catch (err) {
        const why = escapeForDisplay(String(err?.message ?? err).split('\n')[0]).slice(0, 200);
        const pos = /position (\d+)/.exec(why);
        const at = pos ? Number(pos[1]) : -1;
        const near = at >= 0 ? `, near …${escapeForDisplay(obj.slice(Math.max(0, at - 12), at + 12))}…` : '';
        errors.push(`JSON object ${n} is not valid JSON (${why})${near}`);
      }
    }
  }
  if (depth > 0) {
    errors.push(`JSON object ${n + 1} is never closed: ${escapeForDisplay(text.slice(start, start + 60))}` +
      (text.length - start > 60 ? '…' : ''));
  }
  return errors;
}

/**
 * Renders one update: the stage's header once, its body once per row, its trailer once.
 * Never throws, whatever the script holds.
 * @param {Script | string} script
 * @param {RenderOptions} [options]
 *   header: values for group \13 (codes 0x01-0x0f); rows: values for group \14 (0x01-0x18), one object per row.
 *   json: 'auto' applies JSON safety when the stage writes a JSON object, true forces it, false turns it off.
 *   skipEmpty: row variable codes whose line is left out when the value is empty (e.g. [0x0b] for LICENCE).
 * @returns {RenderResult}
 */
export function renderUpdate(script, options = {}) {
  const warnings = new Set();
  try {
    const s = asScript(script);
    if (!s) return { text: '', warnings: ['No script is loaded'], isJson: false, jsonErrors: [] };
    const { stage = 'results', header = {}, rows = [], json = 'auto', skipEmpty = [] } = options ?? {};
    const plan = planStage(s, stage, warnings);
    const useJson = json === true || (json !== false && emitsJson(s, plan));
    const list = Array.isArray(rows) ? rows : [];
    const skip = new Set(Array.isArray(skipEmpty) ? skipEmpty.filter(Number.isInteger) : []);
    let text = renderPlan(plan, header, list, useJson, warnings, skip);
    if (useJson) text = dropTrailingCommas(text);
    return { text, warnings: [...warnings], isJson: useJson, jsonErrors: useJson ? checkJson(text) : [] };
  } catch (err) {
    warnings.add(`Split Relay could not render this script (${err?.message ?? err})`);
    return { text: '', warnings: [...warnings], isJson: false, jsonErrors: [] };
  }
}

/**
 * A summary for the control panel: sections in file order with their format-line counts, whether any line uses
 * commands, and the fixed Karmarush meet id (`"MID":8132`) if the script has one, so the panel can offer an override.
 * @param {Script | string} script
 * @returns {{ sections: { name: string, lines: number }[], usesCommands: boolean, mid: string | null }}
 */
export function describeScript(script) {
  const info = { sections: [], usesCommands: false, mid: null };
  try {
    const s = asScript(script);
    if (!s) return info;
    for (const key of Object.keys(s.sections)) {
      const lines = Array.isArray(s.sections[key]) ? s.sections[key] : [];
      info.sections.push({ name: s.titles?.[key] ?? key, lines: lines.length });
      for (const line of lines) {
        if (!line || line.skip) continue;
        if (line.usesCommands) info.usesCommands = true;
        const m = info.mid === null && typeof line.text === 'string' ? /"MID"\s*:\s*(\d+)/.exec(line.text) : null;
        if (m) info.mid = m[1];
      }
    }
  } catch {
    // a summary is a convenience; a malformed script object just describes as far as it got
  }
  return info;
}

/**
 * A packet as a readable one-line string for logs and the preview: control bytes, DEL, the C1 range and backslash
 * become `\hh` (lowercase, as a script writes them: CRLF shows as `\0d\0a`), and characters windows-1252 cannot hold
 * show as the '?' that is actually sent.
 * @param {string | Uint8Array} text  rendered text, or the encoded bytes
 * @returns {string}
 */
export function escapeForDisplay(text) {
  const s = text instanceof Uint8Array ? decodeCp1252(text) : String(text ?? '');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || ch === '\\') out += '\\' + hex2(cp);
    else if (cp > 0xff && encodeCp1252(ch)[0] === 0x3f) out += '?';
    else out += ch;
  }
  return out;
}
