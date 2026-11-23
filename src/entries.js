// Start lists (DESIGN 9.25): who is entered in which race, from the entry text files the operator loads in the panel.
//
// RR12 sends a bib and a time of day, nothing about the race, so a read belongs to whichever race is Active on its port:
// an athlete of another race who jogs over a mat becomes a split of the race that is running. There is no FinishLynx
// events file at these meets; the timer has one text file of entries per event, named by the event number ("1.txt",
// "2.txt"): a header line (NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE) and one line per
// athlete (142;…;…;F;FR;…;…;;;2;). Split Relay keeps only what it needs of them: the bibs of each event. Names come
// from the people file, as before.
//
// Pure: text in, lists and sentences out. main.js keeps the lists in the data folder and hands them to the engine.

import { decodeCp1252 } from './cp1252.js';

const text = (v) => String(v ?? '').trim();

/** The header names of the bib column, as registration exports write them (compared in upper case). */
const BIB_HEADERS = new Set(['NO.', 'NO', 'BIB', 'BIB#', 'BIB #', 'BIB NO', 'BIB NO.', 'BIB NUMBER', 'ID', 'NUMBER', '#']);
/** ... and of the event column. */
const EVENT_HEADERS = new Set(['EVENT', 'EVENT NO', 'EVENT NO.', 'EVENT NUMBER', 'EVENT #', 'EVENT#', 'EVT']);
/** Other header names a first line may carry: a line with one of them is a header, not an athlete. */
const OTHER_HEADERS = new Set(['FIRST NAME', 'FIRSTNAME', 'FIRST', 'LAST NAME', 'LASTNAME', 'LAST', 'NAME', 'SEX', 'GENDER', 'YEAR',
  'CODE', 'SCHOOL', 'TEAM', 'AFFILIATION', 'DIV', 'DIVPTS', 'WAVE', 'GRADE', 'AGE']);

/**
 * An event number as it is compared: "01" and " 1 " are 1; anything else by its trimmed lower-case text; '' for none.
 * A race's event number and a list's event are matched on this (round and heat do not matter).
 * @param {unknown} v
 */
export function eventKeyOf(v) {
  const s = text(v);
  if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '');
  return s.toLowerCase();
}

/** A bib as it is compared ("0142" is 142), as the engine compares bibs with FinishLynx's. */
export function entryBib(v) {
  const s = text(v);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

/**
 * The event a file's name says: "1.txt" and "02.TXT" are 1 and 2, "event 3.csv" and "Evt-12 entries.txt" 3 and 12, a
 * name with exactly one number that number ("girls 4 entries.txt"); '' when the name says none.
 * @param {unknown} fileName
 */
export function eventOfFileName(fileName) {
  const base = text(fileName).replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  if (/^\d+$/.test(base)) return eventKeyOf(base);
  const named = /(?:event|evt)\s*[-_#.]?\s*(\d+)/i.exec(base);
  if (named) return eventKeyOf(named[1]);
  const numbers = base.match(/\d+/g) ?? [];
  return numbers.length === 1 ? eventKeyOf(numbers[0]) : '';
}

/**
 * A file's bytes or text as text: UTF-8 when the bytes are valid UTF-8 (a BOM is dropped), else windows-1252, which
 * FinishLynx and most registration exports write. A string is taken as it is (its BOM dropped).
 * @param {string | Buffer | Uint8Array} input
 */
export function decodeEntries(input) {
  if (typeof input === 'string') return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const buf = Buffer.from(input ?? []);
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    s = decodeCp1252(buf);
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** One line -> its fields on `delimiter`; a quoted field may hold the delimiter, "" inside quotes is a quote. */
function splitLine(line, delimiter) {
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      fields.push(cur);
      cur = '';
    } else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/** The separator of a file by its first line: a semicolon, else a tab, else a comma. */
function delimiterOf(line) {
  if (line.includes(';')) return ';';
  if (line.includes('\t')) return '\t';
  return ',';
}

/**
 * @typedef {{ event: string, bibs: string[], twice: number }} EntryEvent  one event of a file: its bibs (each once, file
 *   order), and how many lines listed a bib again
 * @typedef {{ file: string, events: EntryEvent[], rows: number, skipped: number, header: boolean, nameEvent: string,
 *   columnEvents: string[], noEvent: number, empty: boolean }} EntryFile
 *   rows: athlete lines read; skipped: lines without a bib; nameEvent: the event the file name says ('' none);
 *   columnEvents: the events its EVENT column says; noEvent: athletes with no event at all (no column value, no number
 *   in the file name): not loaded; empty: no line at all, or only a header
 */

/**
 * One entry file read (tolerant): the separator is a semicolon, a tab or a comma; the header's names are compared in any
 * case; the bib is the column called NO. / NO / BIB / BIB# / ID / NUMBER, else the first column; the event of a line is
 * its EVENT column when there is one and it says something, else the event of the file name. Lines without a bib are
 * skipped, a bib listed twice in one event counts once. A file without a header line (its first line starts with a
 * number) is read the same way, the bib first.
 * @param {string | Buffer | Uint8Array} input the file's text or bytes
 * @param {string} [fileName]
 * @returns {EntryFile}
 */
export function parseEntries(input, fileName = '') {
  const file = text(fileName).replace(/^.*[\\/]/, '') || 'entries';
  const nameEvent = eventOfFileName(file);
  const lines = decodeEntries(input).split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  const out = { file, events: [], rows: 0, skipped: 0, header: false, nameEvent, columnEvents: [], noEvent: 0, empty: true };
  if (!lines.length) return out;
  const delimiter = delimiterOf(lines[0]);
  const head = splitLine(lines[0], delimiter).map((h) => h.toUpperCase().replace(/\s+/g, ' '));
  let bibCol = head.findIndex((h) => BIB_HEADERS.has(h));
  let eventCol = head.findIndex((h) => EVENT_HEADERS.has(h));
  // a header line: it names a bib or an event column, or any other column of an entries file, and its first field is
  // no number (an athlete line starts with the bib)
  out.header = bibCol >= 0 || eventCol >= 0 || (!/^\d+$/.test(head[0]) && head.some((h) => OTHER_HEADERS.has(h)));
  if (!out.header) eventCol = -1;
  if (bibCol < 0) bibCol = 0;
  const byEvent = new Map();
  const columnEvents = new Set();
  for (const line of out.header ? lines.slice(1) : lines) {
    const f = splitLine(line, delimiter);
    const bib = entryBib(f[bibCol]);
    if (!bib) {
      out.skipped++;
      continue;
    }
    out.rows++;
    const said = eventCol >= 0 ? eventKeyOf(f[eventCol]) : '';
    if (said) columnEvents.add(said);
    const event = said || nameEvent;
    if (!event) {
      out.noEvent++;
      continue;
    }
    let e = byEvent.get(event);
    if (!e) byEvent.set(event, (e = { event, bibs: [], seen: new Set(), twice: 0 }));
    if (e.seen.has(bib)) e.twice++;
    else {
      e.seen.add(bib);
      e.bibs.push(bib);
    }
  }
  out.events = [...byEvent.values()].map(({ event, bibs, twice }) => ({ event, bibs, twice }));
  out.columnEvents = [...columnEvents];
  out.empty = out.rows === 0;
  return out;
}

/**
 * @typedef {{ file: string, loadedAt: number, bibs: string[] }} StartList  one event's list: the file it came from, when
 *   it was loaded (ms), its bibs
 * @typedef {{ version: 1, events: Record<string, StartList> }} StartLists  by event (eventKeyOf)
 */

/** No lists at all. */
export const noStartLists = () => ({ version: 1, events: {} });

/** What a start-lists file holds, repaired: only events with a file name and bibs; anything else is no lists. */
export function normalizeStartLists(raw) {
  const out = noStartLists();
  const events = raw && typeof raw === 'object' && raw.events && typeof raw.events === 'object' ? raw.events : {};
  for (const [k, v] of Object.entries(events)) {
    const event = eventKeyOf(k);
    if (!event || !v || typeof v !== 'object' || !Array.isArray(v.bibs)) continue;
    const bibs = [...new Set(v.bibs.map(entryBib).filter(Boolean))];
    out.events[event] = { file: text(v.file) || 'entries', loadedAt: Number.isFinite(v.loadedAt) ? v.loadedAt : 0, bibs };
  }
  return out;
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const listWords = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Load entry files into the lists: each event a file holds replaces that event's list (loading again is how a list is
 * corrected). One sentence per file says what happened, in the operator's words; a file that holds nothing changes
 * nothing. Bibs entered in two events are said once, after the files.
 * @param {StartLists} lists
 * @param {{ name: string, text: string | Buffer | Uint8Array }[]} files
 * @param {{ races?: { name: string, eventNumber: unknown }[], now?: number }} [opts] races: the settings' races, for
 *   their names
 * @returns {{ lists: StartLists, results: { file: string, ok: boolean, events: string[], entered: number, text: string }[],
 *   notes: string[] }}
 */
export function loadEntryFiles(lists, files, { races = [], now = Date.now() } = {}) {
  const next = normalizeStartLists(lists);
  const raceOf = (event) => races.filter((r) => eventKeyOf(r?.eventNumber) === event).map((r) => text(r.name) || 'a race');
  const where = (event) => {
    const names = raceOf(event);
    return names.length ? `event ${event} (${listWords(names)})` : `event ${event}`;
  };
  const results = [];
  for (const f of Array.isArray(files) ? files : []) {
    const p = parseEntries(f?.text ?? '', f?.name);
    if (p.empty) {
      results.push({ file: p.file, ok: false, events: [], entered: 0,
        text: `${p.file}: no athletes in it (${p.skipped ? 'no line has a bib' : p.header ? 'only a header line' : 'the file is empty'}). Nothing was loaded.` });
      continue;
    }
    if (!p.events.length) {
      results.push({ file: p.file, ok: false, events: [], entered: 0,
        text: `${p.file}: ${plural(p.rows, 'athlete')}, but nothing says which event: the file has no EVENT column and its name has no event number. Name it by its event number (3.txt) and load it again.` });
      continue;
    }
    const parts = [];
    for (const e of p.events) {
      const was = next.events[e.event];
      next.events[e.event] = { file: p.file, loadedAt: now, bibs: e.bibs };
      const none = raceOf(e.event).length ? '' : ', which has no race here';
      const replaced = was ? ` (in place of the ${was.bibs.length.toLocaleString('en-US')} from ${was.file})` : '';
      parts.push(`${plural(e.bibs.length, 'athlete')} entered in ${where(e.event)}${none}${replaced}`);
    }
    const tail = [];
    // the EVENT column and the file's name disagree: the column wins, and the operator hears it
    if (p.nameEvent && p.columnEvents.length && !p.columnEvents.includes(p.nameEvent)) {
      tail.push(`Its EVENT column says ${p.columnEvents.length === 1 ? `event ${p.columnEvents[0]}` : `events ${listWords(p.columnEvents)}`}, its name says ${p.nameEvent}: the column was used.`);
    }
    const twice = p.events.reduce((n, e) => n + e.twice, 0);
    if (twice) tail.push(`${plural(twice, 'line')} listed a bib again: counted once.`);
    if (p.skipped) tail.push(`${plural(p.skipped, 'line')} without a bib skipped.`);
    if (p.noEvent) tail.push(`${plural(p.noEvent, 'athlete')} with no event left out.`);
    results.push({ file: p.file, ok: true, events: p.events.map((e) => e.event), entered: p.events.reduce((n, e) => n + e.bibs.length, 0),
      text: `${p.file}: ${parts.join('; ')}.${tail.length ? ` ${tail.join(' ')}` : ''}` });
  }
  // a bib entered in two events is treated as entered in both: said, because it is usually a mistake in the files
  const notes = [];
  const shared = sharedBibs(next);
  if (shared.length) {
    const first = shared.slice(0, 5).map((x) => `${x.bib} (events ${listWords(x.events)})`);
    notes.push(`${shared.length === 1 ? 'Bib' : 'Bibs'} ${listWords(first)}${shared.length > 5 ? ` and ${shared.length - 5} more` : ''} ${shared.length === 1 ? 'is' : 'are'} entered in two events: counted in both.`);
  }
  return { lists: next, results, notes };
}

/** The bibs entered in more than one event: [{ bib, events }], by bib. */
export function sharedBibs(lists) {
  const where = new Map();
  for (const [event, l] of Object.entries(lists?.events ?? {})) {
    for (const bib of l.bibs) {
      const e = where.get(bib);
      if (e) e.push(event);
      else where.set(bib, [event]);
    }
  }
  return [...where].filter(([, e]) => e.length > 1).map(([bib, events]) => ({ bib, events }))
    .sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }));
}

/** The lists without one event's (Remove): { lists, removed } (removed: that list, or null when there was none). */
export function removeStartList(lists, event) {
  const next = normalizeStartLists(lists);
  const key = eventKeyOf(event);
  const removed = next.events[key] ?? null;
  delete next.events[key];
  return { lists: next, removed };
}

/**
 * The lists as the panel shows them: one line per event, with the races of that event ("Men's 8K: 108 entered, from
 * 1.txt"), and the races that have none.
 * @param {StartLists} lists
 * @param {{ id: string, name: string, eventNumber: unknown }[]} races
 * @returns {{ events: { event: string, file: string, loadedAt: number, entered: number, races: { id: string, name: string }[] }[],
 *   without: { id: string, name: string }[] }}
 */
export function startListsView(lists, races = []) {
  const all = normalizeStartLists(lists);
  const of = (event) => races.filter((r) => eventKeyOf(r?.eventNumber) === event).map((r) => ({ id: text(r.id), name: text(r.name) || 'Race' }));
  const events = Object.entries(all.events).map(([event, l]) => ({ event, file: l.file, loadedAt: l.loadedAt, entered: l.bibs.length, races: of(event) }))
    .sort((a, b) => a.event.localeCompare(b.event, undefined, { numeric: true }));
  const without = races.filter((r) => !all.events[eventKeyOf(r?.eventNumber)]).map((r) => ({ id: text(r.id), name: text(r.name) || 'Race' }));
  return { events, without };
}
