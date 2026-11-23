// DESIGN 9.25: start lists (the meet's entry files, src/entries.js) and the athletes who are not in the race that reads
// them. The reader on files as the timer has them (made-up names: the real ones are never in the repository), and the
// engine on two synthetic races of one day: bibs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, LIST_RULES, listFits, listMisfitText } from '../src/engine.js';
import { parseEntries, loadEntryFiles, noStartLists, normalizeStartLists, removeStartList, startListsView, sharedBibs, eventOfFileName, eventKeyOf, entryBib,
  decodeEntries } from '../src/entries.js';
import { parseTod, parseRaceTime, formatRaceTime, TICKS_PER_SEC } from '../src/timefmt.js';

const S = TICKS_PER_SEC;
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const HEAD = 'NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE';
/** An entry file as the timer's are: semicolons, CRLF, 11 fields, a blank last line; made-up names. */
const entryFile = (bibs, event, sex = 'M') => [HEAD, ...bibs.map((b) => `${b};Runner;N${b};${sex};SO;T${event};Team ${event};;;${event};`), ''].join('\r\n');
const range = (a, n) => Array.from({ length: n }, (_, i) => String(a + i));

// ---- the reader ----------------------------------------------------------------------------------------------------

test('9.25 an entry file as the timer has it: the bibs of its event, from the EVENT column; the sentence the operator reads', () => {
  const p = parseEntries(entryFile(range(1, 108), 1), '1.txt');
  assert.deepEqual([p.file, p.header, p.rows, p.skipped, p.nameEvent, p.columnEvents, p.empty], ['1.txt', true, 108, 0, '1', ['1'], false]);
  assert.deepEqual([p.events.length, p.events[0].event, p.events[0].bibs.length, p.events[0].bibs[0], p.events[0].bibs.at(-1)], [1, '1', 108, '1', '108']);
  const races = [{ id: 'a', name: "Men's 8K", eventNumber: '1' }, { id: 'b', name: "Women's 6K", eventNumber: '02' }];
  const r = loadEntryFiles(noStartLists(), [{ name: '1.txt', text: entryFile(range(1, 108), 1) }, { name: 'C:\\meet\\2.txt', text: entryFile(range(111, 104), 2, 'F') }], { races, now: 5 });
  assert.deepEqual(r.results.map((x) => [x.ok, x.text]), [
    [true, "1.txt: 108 athletes entered in event 1 (Men's 8K)."],
    [true, "2.txt: 104 athletes entered in event 2 (Women's 6K)."]]);
  assert.deepEqual(r.notes, []);
  // what is kept: the bibs of each event, the file, when; never a name
  assert.deepEqual(Object.keys(r.lists.events), ['1', '2']);
  assert.deepEqual([r.lists.events['2'].file, r.lists.events['2'].loadedAt, r.lists.events['2'].bibs.length], ['2.txt', 5, 104]);
  assert.equal(/Runner|Team/.test(JSON.stringify(r.lists)), false);
  // the Races page: each event with its races, the races without a list
  assert.deepEqual(startListsView(r.lists, [...races, { id: 'c', name: 'JV', eventNumber: '3' }]), {
    events: [{ event: '1', file: '1.txt', loadedAt: 5, entered: 108, races: [{ id: 'a', name: "Men's 8K" }] }, { event: '2', file: '2.txt', loadedAt: 5, entered: 104, races: [{ id: 'b', name: "Women's 6K" }] }],
    without: [{ id: 'c', name: 'JV' }] });
});

test('9.25 reading is tolerant: commas and tabs, any case of the header, the bib column by its name or first, no header, a BOM, UTF-8 and cp1252, quotes', () => {
  const bibs = (text, name = '4.txt') => parseEntries(text, name).events.map((e) => [e.event, e.bibs.join(' ')]);
  assert.deepEqual(bibs('Bib,First,Last\n301,a,b\n302,c,d\n'), [['4', '301 302']]);
  assert.deepEqual(bibs('first\tlast\tbib#\tevent\na\tb\t7\t4\nc\td\t8\t4\n', 'x.tsv'), [['4', '7 8']]);
  assert.deepEqual(bibs('name;ID;team\r\nx;0041;t\r\ny;42;t\r\n'), [['4', '41 42']], '"0041" is 41, as FinishLynx writes it');
  assert.deepEqual(bibs('701\n702\n0703\n', '7.txt'), [['7', '701 702 703']], 'no header: the first column');
  assert.deepEqual(bibs('"NO.";"LAST NAME"\r\n"12";"O;Neil"\r\n'), [['4', '12']], 'a quoted field may hold the separator');
  // a BOM, UTF-8 and Windows-1252 bytes all read (the field with the accent is never kept)
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('NO.;NAME;EVENT\r\n9;Xé;4\r\n')]);
  const cp1252 = Buffer.from([0x4e, 0x4f, 0x2e, 0x3b, 0x4e, 0x41, 0x4d, 0x45, 0x0d, 0x0a, 0x39, 0x30, 0x31, 0x3b, 0x58, 0xe9, 0x0d, 0x0a]);
  assert.deepEqual(bibs(utf8), [['4', '9']]);
  assert.deepEqual(bibs(cp1252), [['4', '901']]);
  assert.equal(decodeEntries(cp1252).includes('Xé'), true);
  assert.equal(decodeEntries('\uFEFFNO.').charCodeAt(0), 0x4e);
  // the event a file's name says
  assert.deepEqual(['1.txt', '02.TXT', 'event 3.csv', 'Evt-12 entries.txt', 'girls 4 entries.txt', 'entries 2026-10-31.txt', 'C:\\x\\5.txt', 'entries.txt'].map(eventOfFileName),
    ['1', '2', '3', '12', '4', '', '5', '']);
  assert.deepEqual([eventKeyOf(' 01 '), eventKeyOf('3A'), eventKeyOf(null), entryBib('0142'), entryBib(' A7 ')], ['1', '3a', '', '142', 'A7']);
});

test('9.25 the odd files: the EVENT column wins over the name and says so; no bib, twice, two events; empty, header only, no event at all; again; Remove', () => {
  const races = [{ id: 'a', name: "Men's 8K", eventNumber: '1' }, { id: 'b', name: "Women's 6K", eventNumber: '2' }];
  const load = (lists, name, text) => loadEntryFiles(lists, [{ name, text }], { races, now: 9 });
  const first = load(noStartLists(), '1.txt', entryFile(range(1, 108), 1));
  // the women's file under the men's name: its EVENT column says 2
  const col = load(first.lists, '1.txt', entryFile(range(111, 104), 2, 'F'));
  assert.equal(col.results[0].text, "1.txt: 104 athletes entered in event 2 (Women's 6K). Its EVENT column says event 2, its name says 1: the column was used.");
  assert.deepEqual(Object.entries(col.lists.events).map(([e, l]) => [e, l.bibs.length]), [['1', 108], ['2', 104]]);
  // no EVENT column: the name says it; a line without a bib is skipped, a bib listed twice counts once
  const odd = load(first.lists, 'event 3.csv', 'Bib,First,Last\n301,a,b\n302,c,d\n302,c,d\n,x,y\n');
  assert.equal(odd.results[0].text, 'event 3.csv: 2 athletes entered in event 3, which has no race here. 1 line listed a bib again: counted once. 1 line without a bib skipped.');
  // nothing in it: nothing changes, and it says why
  for (const [name, text, why] of [['3.txt', '', 'the file is empty'], ['3.txt', `${HEAD}\r\n`, 'only a header line'], ['3.txt', `${HEAD}\r\n;a;b\r\n`, 'no line has a bib']]) {
    const r = load(first.lists, name, text);
    assert.deepEqual([r.results[0].ok, r.results[0].text, r.lists], [false, `3.txt: no athletes in it (${why}). Nothing was loaded.`, first.lists]);
  }
  const none = load(first.lists, 'entries.txt', 'bib\tname\n5\tx\n');
  assert.equal(none.results[0].text, 'entries.txt: 1 athlete, but nothing says which event: the file has no EVENT column and its name has no event number. Name it by its event number (3.txt) and load it again.');
  assert.deepEqual(none.lists, first.lists);
  // one file with two events loads both; a bib entered in two events is said, and counts in both
  const two = load(first.lists, 'all.txt', 'NO.;EVENT\r\n50;1\r\n150;1\r\n150;2\r\n151;2\r\n');
  assert.equal(two.results[0].text, "all.txt: 2 athletes entered in event 1 (Men's 8K) (in place of the 108 from 1.txt); 2 athletes entered in event 2 (Women's 6K).");
  assert.deepEqual(two.notes, ['Bib 150 (events 1 and 2) is entered in two events: counted in both.']);
  assert.deepEqual(sharedBibs(two.lists), [{ bib: '150', events: ['1', '2'] }]);
  // the same file again replaces that event's list with the same one
  const again = load(first.lists, '1.txt', entryFile(range(1, 108), 1));
  assert.equal(again.results[0].text, "1.txt: 108 athletes entered in event 1 (Men's 8K) (in place of the 108 from 1.txt).");
  assert.deepEqual(again.lists.events['1'].bibs, first.lists.events['1'].bibs);
  // Remove; what a damaged file holds is no list
  assert.deepEqual([removeStartList(first.lists, '01').removed.bibs.length, removeStartList(first.lists, '01').lists.events, removeStartList(first.lists, '9').removed], [108, {}, null]);
  assert.deepEqual(normalizeStartLists({ events: { 1: { file: 'x.txt', bibs: ['01', '1', 2] }, 2: { bibs: 'no' }, '': { bibs: ['3'] } } }),
    { version: 1, events: { 1: { file: 'x.txt', loadedAt: 0, bibs: ['1', '2'] } } });
  assert.deepEqual(normalizeStartLists('nonsense'), noStartLists());
});

// ---- the engine: two races of one day -----------------------------------------------------------------------------

function fakeClock(start = T0) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextId = null;
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.at)) [nextId, next] = [id, t];
        if (!next) break;
        timers.delete(nextId);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = end;
    },
  };
}

function memStore() {
  const data = new Map();
  const journal = [];
  return {
    data, journal,
    load: (id) => (data.has(id) ? JSON.parse(data.get(id)) : null),
    save: (id, d) => data.set(id, JSON.stringify(d)),
    remove: (id) => data.delete(id),
    appendJournal: (rec) => journal.push(JSON.stringify(rec)),
    loadJournal: () => journal.map((l) => JSON.parse(l)),
  };
}

const lapSplits = (id, n) => Array.from({ length: n }, (_, i) => ({ id: `${id}s${i + 1}`, name: `${i + 1}K`, sources: [], earliest: '' }));
const OUTPUTS = [{ id: 'o1', name: 'TrackScore', enabled: true, races: [] }, { id: 'o2', name: 'Karmarush', enabled: true, races: [] }];
/** Girls 5K (event 1, bibs 100-119, gun 10:00) and Boys 5K (event 2, bibs 200-219, gun 11:00), each on its own RR12 port. */
const RACES = {
  girls: { id: 'rg', name: 'Girls 5K', eventNumber: '1', port: 5565, gun: '10:00:00.000', bibs: range(100, 20) },
  boys: { id: 'rb', name: 'Boys 5K', eventNumber: '2', port: 5566, gun: '11:00:00.000', bibs: range(200, 20) },
};
const LISTS = () => loadEntryFiles(noStartLists(), [{ name: '1.txt', text: entryFile(RACES.girls.bibs, 1, 'F') }, { name: '2.txt', text: entryFile(RACES.boys.bibs, 2) }], { now: T0 }).lists;

function setup({ lists = null, setting = null, store = memStore(), clock = fakeClock(), config: given = null, outputs = OUTPUTS } = {}) {
  const config = given ?? {
    version: 1, filter: { tagWindowSec: 10, holdSec: 0, startIgnoreSec: 60 },
    races: Object.values(RACES).map((r) => ({ id: r.id, name: r.name, eventNumber: r.eventNumber, round: '1', heat: '1', distance: '', contests: [], inputPort: r.port,
      gun: r.gun, splits: lapSplits(r.id, 4), finishSources: [], active: true })),
    outputs, lif: { enabled: true }, ...(setting === 'send' ? { entries: { otherRace: 'send' } } : {}),
  };
  const box = { value: lists };
  const sends = [];
  const via = [];
  const logs = [];
  const engine = new Engine({ getConfig: () => config, store, clock, log: (l) => logs.push(l), startLists: () => box.value,
    deliver: (id, packet, ack) => {
      sends.push(packet);
      via.push(id);
      ack(true);
      return true;
    } });
  engine.on('config-patch', ({ raceId, patch }) => Object.assign(config.races.find((r) => r.id === raceId), patch));
  clock.advance(0);
  const s = { engine, config, clock, store, sends, via, logs, lists: box };
  /** one read: the bib over a mat of `race`, `sec` seconds after its gun (the clock moves there) */
  s.read = (race, bib, sec) => {
    const at = T0 + (parseTod(race.gun) - parseTod('10:00:00')) / S * 1000 + Math.round(sec * 1000);
    if (at > clock.now()) clock.advance(at - clock.now());
    engine.handleRead({ location: '', bib: String(bib), tod: parseTod(race.gun) + Math.round(sec * S), contest: '', first: '', last: '', team: '', gender: '' },
      { receivedAt: clock.now(), connId: 1, port: race.port });
  };
  /**
   * A race run: its 20 runners over the four mats (the i-th at 1 + 0.02 i of the leader's 3:00 a kilometre), and the
   * `extra` reads ([bib, seconds after the gun]) of athletes who are not its own, in time order, from `after` up to `upTo`.
   */
  s.run = (race, { extra = [], after = -Infinity, upTo = Infinity } = {}) => {
    const reads = [...extra];
    race.bibs.forEach((bib, i) => { for (let k = 1; k <= 4; k++) reads.push([bib, 180 * k * (1 + 0.02 * i)]); });
    for (const [bib, t] of reads.filter(([, t]) => t > after && t <= upTo).sort((a, b) => a[1] - b[1])) s.read(race, bib, t);
  };
  s.restart = () => {
    engine.stop();
    engine.markCleanStop();
    return setup({ lists: box.value, store, clock, config });
  };
  /** the lines an output got for a race since `from`: [bib, split, time, place, reason] */
  s.lines = (race, { out = 'o1', from = 0, bib = null } = {}) => sends.map((p, i) => [p, via[i]]).slice(from)
    .filter(([p, o]) => o === out && p.raceId === race.id && (bib === null || p.bib === String(bib)))
    .map(([p]) => [p.bib, p.splitName, formatRaceTime(p.csTicks, 1), p.place, p.reason]);
  return s;
}
/** What the boards show at the end: the last line of each runner's split, [bib, split, place]. */
const boards = (s, race, out = 'o1') => {
  const m = new Map();
  for (const [bib, split, , place] of s.lines(race, { out })) m.set(`${bib}|${split}`, [bib, split, place]);
  return [...m.values()].sort((a, b) => a[1].localeCompare(b[1]) || a[2] - b[2]);
};
const journalOf = (s) => s.store.journal.map((l) => JSON.parse(l));
/** Two girls jog over the boys' mats: 105 two minutes after the boys' gun (before anybody), 110 at 3:30 and 7:00 (10th there). */
const STRAY = [['105', 120], ['110', 210], ['110', 420]];

test('9.25 a start list in use: an athlete entered in another race is kept off the boards (no line, no place taken, not in the .lif), counted quietly, listed in Review', () => {
  const s = setup({ lists: LISTS() });
  s.run(RACES.girls);
  const at = s.sends.length;
  s.run(RACES.boys, { extra: STRAY });
  s.clock.advance(5000);
  // nothing of 105 or 110 went out in the boys' race, on either output; the boys' places are their own
  assert.deepEqual(s.lines(RACES.boys, { bib: 105 }), []);
  assert.deepEqual(s.lines(RACES.boys, { bib: 110, out: 'o2' }), []);
  assert.deepEqual(s.lines(RACES.boys).slice(0, 2), [['200', '1K', '3:00.0', 1, 'new'], ['201', '1K', '3:03.6', 2, 'new']]);
  assert.deepEqual(boards(s, RACES.boys).filter(([, split]) => split === '1K').map(([bib, , place]) => [bib, place]), RACES.boys.bibs.map((b, i) => [b, i + 1]));
  assert.deepEqual(boards(s, RACES.boys, 'o2'), boards(s, RACES.boys));
  assert.equal(s.sends.slice(at).some((p) => !RACES.boys.bibs.includes(p.bib)), false);
  // the merged .lif has the boys only; the girls' race is as it was
  assert.deepEqual([...s.engine.raceData('rb').runners.keys()].sort(), RACES.boys.bibs);
  assert.equal(s.engine.raceData('rg').runners.size, 20);
  // read, counted and shown: the crossings are there, held as 'away', with no place among the boys
  assert.deepEqual(s.engine.crossings('rb').filter((c) => c.held).map((c) => [c.bib, c.splitName, formatRaceTime(c.raceTicks, 1), c.held]),
    [['105', '1K', '2:00.0', 'away'], ['110', '1K', '3:30.0', 'away'], ['110', '2K', '7:00.0', 'away']]);
  // the race tile: the start list, the runners of others counted apart (per split too); nothing to alarm
  const v = s.engine.raceView('rb');
  assert.deepEqual(v.startList, { event: '2', file: '2.txt', loadedAt: T0, entered: 20, used: true, on: 20, through: 22, text: '20 entered, from 2.txt', warn: null });
  assert.deepEqual([v.runners, v.splits.map((x) => [x.crossings, x.away ?? 0]), v.review.away, v.review.strange ?? 0, v.review.flagged, v.review.checks], [22, [[22, 2], [21, 1], [20, 0], [20, 0]], 2, 0, 0, 0]);
  assert.equal(s.engine.raceView('rg').review.away, undefined);
  // Review: one row per athlete, with the race they are entered in and their passes here; no other story about them
  const rv = s.engine.review('rb');
  assert.deepEqual(rv.away.map((a) => [a.bib, a.by, a.why, a.raceName, a.passes.map((p) => `${p.splitName} ${p.timeText}`), a.passes.some((p) => p.onBoards)]),
    [['105', 'list', 'entered in Girls 5K', 'Girls 5K', ['1K 2:00.0'], false], ['110', 'list', 'entered in Girls 5K', 'Girls 5K', ['1K 3:30.0', '2K 7:00.0'], false]]);
  assert.deepEqual([rv.checks, rv.flags, rv.missing.filter((m) => ['105', '110'].includes(m.bib)), rv.unlisted], [[], [], [], undefined]);
  // the runner editor, the grid and the feed say it
  const r = s.engine.runner('rb', '110');
  assert.deepEqual([r.place, r.columns.map((c) => c.held).slice(0, 2), r.columns[0].place],
    [{ kind: 'away', why: 'entered in Girls 5K', text: 'Not in this race (entered in Girls 5K): read and counted here, not sent, not in the merged .lif file.' }, ['away', 'away'], 10]);
  const row = s.engine.grid('rb').rows.find((x) => x.bib === '110');
  assert.deepEqual([row.away, row.cells[0].held, row.problems], ['Not in this race (entered in Girls 5K)', 'away', []]);
  const feed = s.engine.feed(1000).filter((f) => f.raceId === 'rb' && f.bib === '105');
  assert.deepEqual(feed.map((f) => [f.status, f.detail]), [['not-in-race', 'Not in this race (entered in Girls 5K): read and counted here, not sent, not in the merged .lif file. Review lists the runner under Not in this race, with "Count them here".']]);
  // a restart has the same (main.js keeps the lists in the data folder)
  const again = s.restart();
  again.clock.advance(5000);
  assert.deepEqual(again.engine.review('rb').away.map((a) => a.bib), ['105', '110']);
  assert.equal(again.sends.length, 0, 'and sends nothing');
});

test('9.25 "Count them here" sends the athlete\'s passes like any runner\'s, to both outputs; Undo takes them back; both hold across a restart', () => {
  const s = setup({ lists: LISTS() });
  s.run(RACES.girls);
  s.run(RACES.boys, { extra: STRAY });
  s.clock.advance(5000);
  const at = s.sends.length;
  const r = s.engine.placeRunner('rb', '110', { say: 'here' });
  assert.deepEqual([r.change.kind, r.change.text, r.change.sentTo, r.change.undoable], ['here', 'Counted in this race', ['TrackScore', 'Karmarush'], true]);
  // its two passes, with the places they have among the boys (10th at both), and the boys behind it again
  assert.deepEqual(s.lines(RACES.boys, { from: at, bib: 110 }), [['110', '1K', '3:30.0', 10, 'new'], ['110', '2K', '7:00.0', 10, 'new']]);
  assert.deepEqual(s.lines(RACES.boys, { from: at, bib: 110, out: 'o2' }), s.lines(RACES.boys, { from: at, bib: 110 }));
  assert.equal(r.change.resent.lines, 22, 'the eleven boys behind it at 1K and at 2K went out again with their new places');
  assert.deepEqual(boards(s, RACES.boys).filter(([, split]) => split === '2K').map(([bib, , place]) => `${bib}:${place}`).slice(8, 12), ['208:9', '110:10', '209:11', '210:12']);
  assert.deepEqual(s.engine.review('rb').away.map((a) => a.bib), ['105']);
  assert.deepEqual(s.engine.runner('rb', '110').place, { kind: 'here', why: 'entered in Girls 5K', text: 'Counted in this race (entered in Girls 5K): you said so.' });
  assert.equal(s.engine.raceData('rb').runners.has('110'), true);
  assert.deepEqual(journalOf(s).filter((x) => x.t === 'runner-say').map((x) => [x.raceId, x.bib, x.say, x.fixKind, x.fixText]), [['rb', '110', 'here', 'here', 'Counted in this race']]);
  assert.throws(() => s.engine.placeRunner('rb', '110', { say: 'here' }), /^Error: Bib 110 counts in Boys 5K already\.$/);
  assert.throws(() => s.engine.placeRunner('rb', '105', { say: 'away' }), /^Error: Bib 105 is not in Boys 5K already\.$/);
  assert.throws(() => s.engine.placeRunner('rb', '110', {}), /Send \{ "say": "away" \}/);
  // a restart keeps it
  const s2 = s.restart();
  assert.deepEqual([s2.engine.review('rb').away.map((a) => a.bib), s2.engine.runner('rb', '110').place.kind], [['105'], 'here']);
  // Undo: off the boards again; what went out stays there (a packet can't empty a cell), and the boys' places go out again
  const at2 = s2.sends.length;
  const u = s2.engine.undo('rb', { fix: r.change.fix });
  assert.deepEqual([u.change.text, u.change.leftover.map((x) => [x.bib, x.splitName, x.text, x.away]), u.change.resent.lines],
    ['Undone: bib 110 is not in this race again', [['110', '1K', '3:30.0', true], ['110', '2K', '7:00.0', true]], 22]);
  assert.deepEqual(s2.lines(RACES.boys, { from: at2, bib: 110 }), []);
  const row = s2.engine.review('rb').away.find((a) => a.bib === '110');
  assert.deepEqual(row.passes.map((p) => [p.splitName, p.onBoards]), [['1K', '3:30.0'], ['2K', '7:00.0']], 'Review says what the boards still show');
  assert.equal(s2.engine.raceData('rb').runners.has('110'), false);
  const s3 = s2.restart();
  assert.deepEqual(s3.engine.review('rb').away.map((a) => a.bib), ['105', '110']);
});

test('9.25 the safety valve: a list that does not fit the runners being read does nothing; every line goes out as without a list, and the operator is told', () => {
  // the rule
  assert.deepEqual(LIST_RULES, { runners: 5, share: 0.5, none: 3, days: 6 });
  assert.deepEqual([[0, 0], [0, 2], [0, 3], [1, 3], [2, 4], [2, 5], [3, 5], [4, 5], [12, 40], [88, 110]].map(([on, through]) => listFits(on, through)),
    [true, true, false, true, true, false, true, true, false, true]);
  const plain = setup();
  plain.run(RACES.girls);
  plain.run(RACES.boys, { extra: STRAY });
  plain.clock.advance(5000);
  // (1) the two files swapped: each race has the other's list
  const good = LISTS();
  const swapped = { version: 1, events: { 1: good.events[2], 2: good.events[1] } };
  const s = setup({ lists: swapped });
  s.run(RACES.girls);
  s.run(RACES.boys, { extra: STRAY });
  s.clock.advance(5000);
  for (const race of [RACES.girls, RACES.boys]) {
    assert.deepEqual(boards(s, race), boards(plain, race), `${race.name}: the boards as without a list`);
    assert.deepEqual(boards(s, race, 'o2'), boards(plain, race, 'o2'));
    assert.equal(s.engine.review(race.id).away, undefined);
  }
  // (only the first two through waited, for the third: then they went out with the places they have)
  assert.deepEqual(s.lines(RACES.girls).slice(0, 3), [['100', '1K', '3:00.0', 1, 'new'], ['101', '1K', '3:03.6', 2, 'new'], ['102', '1K', '3:07.2', 3, 'new']]);
  const v = s.engine.raceView('rg').startList;
  assert.deepEqual([v.used, v.on, v.through, v.warn], [false, 0, 20, "The start list does not match Girls 5K (0 of 20 runners are on it): not used. Check the race's event number, or load the right file (Races tab)."]);
  assert.equal(s.engine.raceView('rb').startList.warn, "The start list does not match Boys 5K (2 of 22 runners are on it): not used. Check the race's event number, or load the right file (Races tab).");
  assert.equal(s.logs.filter((l) => /The start list does not match Girls 5K \(0 of 3 runners are on it\): not used/.test(l)).length, 1, 'said once in the log, when it stops fitting');
  // (2) the girls' file loaded for the boys' event by mistake, nothing for the girls: the boys are on no list at all
  const s2 = setup({ lists: { version: 1, events: { 2: good.events[1] } } });
  s2.run(RACES.girls);
  s2.run(RACES.boys, { extra: STRAY });
  s2.clock.advance(5000);
  assert.deepEqual(s2.lines(RACES.boys), plain.lines(RACES.boys), 'every packet of the boys\' race as without a list, in the same order');
  assert.deepEqual(s2.lines(RACES.girls), plain.lines(RACES.girls));
  assert.deepEqual([s2.engine.raceView('rg').startList.text, s2.engine.raceView('rg').startList.warn, s2.engine.raceView('rb').startList.used], ['no start list for event 1', null, false]);
  // (3) a list loaded more than six days ago is not used either: last week's files left in the data folder
  const old = { version: 1, events: Object.fromEntries(Object.entries(good.events).map(([e, l]) => [e, { ...l, loadedAt: T0 - 8 * 86400000 }])) };
  const s3 = setup({ lists: old });
  s3.run(RACES.girls);
  s3.run(RACES.boys, { extra: STRAY });
  s3.clock.advance(5000);
  assert.deepEqual(s3.lines(RACES.boys), plain.lines(RACES.boys));
  assert.match(s3.engine.raceView('rb').startList.warn, /^The start list of Boys 5K was loaded 8 days ago: not used\. Load this meet's entry files \(Races tab\)\.$/);
  assert.equal(listMisfitText('Girls 2A', { old: false, on: 12, through: 40 }), "The start list does not match Girls 2A (12 of 40 runners are on it): not used. Check the race's event number, or load the right file (Races tab).");
});

test('9.25 on no start list (a late entry, a spare chip): sent as always, a quiet row in Review; "Not in this race" takes it off the boards and puts the others\' places right', () => {
  const s = setup({ lists: LISTS() });
  s.run(RACES.girls);
  // chip 3464 over the boys' first mat at 3:10 (it would be 4th there), a late entry 250 running with the field
  s.run(RACES.boys, { extra: [['3464', 190], ['250', 200], ['250', 400], ['250', 600], ['250', 800]] });
  s.clock.advance(5000);
  assert.deepEqual(s.lines(RACES.boys, { bib: 3464 }), [['3464', '1K', '3:10.0', 4, 'new']]);
  assert.deepEqual(s.lines(RACES.boys, { bib: 250 }).map((l) => l[1]), ['1K', '2K', '3K', '4K']);
  const rv = s.engine.review('rb');
  assert.deepEqual(rv.unlisted.map((u) => [u.bib, u.passes.map((p) => `${p.splitName} ${p.timeText}`)]), [['250', ['1K 3:20.0', '2K 6:40.0', '3K 10:00.0', '4K 13:20.0']], ['3464', ['1K 3:10.0']]]);
  assert.deepEqual([rv.away, rv.flags, rv.counts.unlisted, rv.counts.flagged, s.engine.raceView('rb').startList.used], [undefined, [], 2, 0, true]);
  assert.deepEqual(s.engine.runner('rb', '3464').place, { kind: 'unlisted', why: null, text: 'Not on the start list of Boys 5K.' });
  assert.equal(s.engine.grid('rb').rows.find((x) => x.bib === '3464').unlisted, true);
  // It's right: the late entry is a runner like any other, the note goes
  assert.equal(s.engine.placeRunner('rb', '250', { say: 'here' }).change.text, 'Stays in this race');
  assert.deepEqual(s.engine.review('rb').unlisted.map((u) => u.bib), ['3464']);
  // Not in this race: the chip is nobody's
  const at = s.sends.length;
  const r = s.engine.placeRunner('rb', '3464', { say: 'away' });
  assert.deepEqual([r.change.kind, r.change.text, r.change.leftover.map((x) => [x.bib, x.splitName, x.text]), r.change.staleOthers], ['away', 'Not in this race (1K taken back)', [['3464', '1K', '3:10.0']], 0]);
  assert.equal(r.change.resent.lines, 18, 'the 17 boys and the late entry behind it at 1K');
  assert.deepEqual(s.lines(RACES.boys, { from: at }).slice(0, 2), [['203', '1K', '3:10.8', 4, 'place-update'], ['204', '1K', '3:14.4', 5, 'place-update']]);
  assert.deepEqual(s.engine.review('rb').away.map((a) => [a.bib, a.by, a.why]), [['3464', 'you', 'you said so']]);
  assert.equal(s.engine.raceData('rb').runners.has('3464'), false);
  // a later read of it is counted and not sent
  s.read(RACES.boys, '3464', 1200);
  s.clock.advance(5000);
  assert.deepEqual(s.lines(RACES.boys, { from: at, bib: 3464 }), []);
  assert.deepEqual(s.engine.review('rb').away[0].passes.map((p) => p.splitName), ['1K', '2K']);
});

test('9.25 "send and flag": an athlete entered in another race goes out as always, with a row whose one click is Not in this race; no missed-mat story about them', () => {
  const s = setup({ lists: LISTS(), setting: 'send' });
  s.run(RACES.girls);
  // 105 before the field; 110 at 6:30, which the column check would call a missed 1K
  s.run(RACES.boys, { extra: [['105', 120], ['110', 390]] });
  s.clock.advance(5000);
  assert.deepEqual(s.lines(RACES.boys, { bib: 105 }), [['105', '1K', '2:00.0', 1, 'new']]);
  assert.deepEqual(s.lines(RACES.boys, { bib: 110 }), [['110', '1K', '6:30.0', 22, 'new']]);
  const rv = s.engine.review('rb');
  assert.deepEqual(rv.flags.map((f) => [f.bib, f.kind, f.text, f.splitName, f.passes.map((p) => p.timeText), f.stranger]), [
    ['105', 'stranger', 'Bib 105 is entered in Girls 5K: not in this race?', '1K', ['2:00.0'], { by: 'list', raceId: 'rg', raceName: 'Girls 5K' }],
    ['110', 'stranger', 'Bib 110 is entered in Girls 5K: not in this race?', '1K', ['6:30.0'], { by: 'list', raceId: 'rg', raceName: 'Girls 5K' }]]);
  assert.deepEqual([rv.checks, rv.away, rv.counts.strange, rv.counts.strangeBibs, rv.counts.strangeText, rv.counts.flagged],
    [[], undefined, 2, ['105', '110'], 'Bib 105 is entered in Girls 5K: not in this race?', 0]);
  assert.deepEqual(s.engine.runner('rb', '105').place, { kind: 'stranger', why: 'entered in Girls 5K', text: 'Bib 105 is entered in Girls 5K: not in this race?' });
  // the one click: its line is taken back, every boy's 1K place goes out again one better, on both outputs
  const at = s.sends.length;
  const r = s.engine.placeRunner('rb', '105', { say: 'away' });
  assert.deepEqual([r.change.text, r.change.resent, r.change.leftover.map((x) => x.text)], ['Not in this race (1K taken back)', { lines: 21, outputs: ['TrackScore', 'Karmarush'] }, ['2:00.0']], 'the 20 boys, and 110, which is still sent');
  assert.deepEqual(boards(s, RACES.boys).filter(([bib, split]) => split === '1K' && bib !== '105').map(([bib, , place]) => [bib, place]).slice(0, 3), [['200', 1], ['201', 2], ['202', 3]]);
  assert.deepEqual(boards(s, RACES.boys, 'o2'), boards(s, RACES.boys));
  assert.equal(s.lines(RACES.boys, { from: at, bib: 105 }).length, 0);
  assert.deepEqual([s.engine.review('rb').flags.map((f) => f.bib), s.engine.review('rb').away.map((a) => a.bib)], [['110'], ['105']]);
  // the setting put back to "keep them off the boards": 110 goes off the boards too, by the list
  delete s.config.entries;
  s.engine.configChanged();
  assert.deepEqual([s.engine.review('rb').flags, s.engine.review('rb').away.map((a) => [a.bib, a.by])], [[], [['105', 'you'], ['110', 'list']]]);
});

test('9.25 without a start list the day is remembered: a bib that ran another race today is flagged when it is read in this one; nothing is held, every line as before', () => {
  const s = setup();
  // boy 207 jogs over the girls' first mat at 3:30 (a plausible 1K): nothing to say yet, he has run no race
  s.run(RACES.girls, { extra: [['207', 210]] });
  assert.deepEqual([s.engine.review('rg').flags, s.lines(RACES.girls, { bib: 207 })], [[], [['207', '1K', '3:30.0', 10, 'new']]]);
  assert.equal(s.engine.raceView('rg').startList, undefined, 'no start list loaded: nothing about one');
  // the boys' race: girl 105 crosses before anybody (2:00), 110 at 6:30 (the column check holds it: "missed 1K?")
  s.run(RACES.boys, { extra: [['105', 120], ['110', 390]], upTo: 130 });
  // flagged the moment it is read; its line went out as it always did
  assert.deepEqual(s.lines(RACES.boys), [['105', '1K', '2:00.0', 1, 'new']]);
  let rv = s.engine.review('rb');
  assert.deepEqual(rv.flags.map((f) => [f.bib, f.kind, f.text, f.stranger]), [['105', 'stranger', 'Bib 105 ran in Girls 5K today: not in this race?', { by: 'day', raceId: 'rg', raceName: 'Girls 5K' }]]);
  assert.deepEqual([rv.counts.strange, rv.counts.strangeText, s.engine.raceView('rb').review.strange], [1, 'Bib 105 ran in Girls 5K today: not in this race?', 1]);
  s.run(RACES.boys, { extra: [['105', 120], ['110', 390]], after: 130 });
  s.clock.advance(5000);
  // every boy one place down at 1K, as it was before this version: the flag changes nothing by itself
  assert.deepEqual(boards(s, RACES.boys).filter(([, split]) => split === '1K').slice(0, 3), [['105', '1K', 1], ['200', '1K', 2], ['201', '1K', 3]]);
  rv = s.engine.review('rb');
  // 110's held pass says who it is, not "missed 1K?", and Not in this race is its click (the server names it)
  assert.deepEqual(rv.checks.map((c) => [c.bib, c.timeText, c.stranger]), [['110', '6:30.0', { raceName: 'Girls 5K', text: 'Bib 110 ran in Girls 5K today: not in this race?' }]]);
  assert.deepEqual([rv.flags.map((f) => f.bib), rv.counts.strange, rv.counts.strangeBibs, rv.counts.checks], [['105'], 2, ['105', '110'], 1]);
  assert.deepEqual(s.lines(RACES.boys, { bib: 110 }), [], 'held, as before');
  // and the boy read once in the girls' race is flagged there, now that he has run his own
  assert.deepEqual(s.engine.review('rg').flags.map((f) => [f.bib, f.text]), [['207', 'Bib 207 ran in Boys 5K today: not in this race?']]);
  assert.deepEqual(s.engine.review('rb').flags.some((f) => f.bib === '207'), false, 'not in his own race');
  // Not in this race on the held one: nothing of it was out; it is off the boards for good
  const r = s.engine.placeRunner('rb', '110', { say: 'away' });
  assert.deepEqual([r.change.text, r.change.leftover, s.engine.review('rb').checks, s.engine.review('rb').away.map((a) => [a.bib, a.why])], ['Not in this race', [], [], [['110', 'ran in Girls 5K today']]]);
  // It's right silences the other; Undo brings the flag back
  const k = s.engine.placeRunner('rb', '105', { say: 'here' });
  assert.deepEqual([k.change.text, s.engine.review('rb').flags, s.engine.review('rb').counts.strange], ['Stays in this race', [], undefined]);
  assert.equal(s.engine.undo('rb', { fix: k.change.fix }).change.text, 'Undone: bib 105 is sent again');
  assert.deepEqual(s.engine.review('rb').flags.map((f) => f.bib), ['105']);
  // a rebuild from the journal agrees
  const again = s.restart();
  assert.deepEqual([again.engine.review('rb').flags.map((f) => f.bib), again.engine.review('rb').away.map((a) => a.bib), again.engine.review('rg').flags.map((f) => f.bib)], [['105'], ['110'], ['207']]);
});

test('9.25 a meet that numbers each race from 1: when more than half of a race\'s runners ran another race today, the day\'s memory says nothing', () => {
  const s = setup();
  s.run(RACES.girls);
  // the boys' race with the girls' bib numbers (other chips, the same numbers)
  s.run({ ...RACES.boys, bibs: RACES.girls.bibs }, { upTo: 190 });
  // the first three through: still "ran in Girls 5K today" (fewer than five are through)
  assert.equal(s.engine.review('rb').counts.strange, 3);
  s.run({ ...RACES.boys, bibs: RACES.girls.bibs }, { after: 190 });
  s.clock.advance(5000);
  assert.deepEqual([s.engine.review('rb').flags, s.engine.review('rb').counts.strange, s.engine.raceView('rb').review.strange, s.engine.review('rg').flags], [[], undefined, undefined, []]);
  assert.equal(s.lines({ ...RACES.boys }).length, 80, 'and every line went out');
  // with the entries loaded (each bib in both events) nobody is apart either
  s.lists.value = loadEntryFiles(noStartLists(), [{ name: '1.txt', text: entryFile(RACES.girls.bibs, 1) }, { name: '2.txt', text: entryFile(RACES.girls.bibs, 2) }], { now: T0 }).lists;
  s.engine.startListsChanged();
  assert.deepEqual([s.engine.review('rb').away, s.engine.review('rb').flags, s.engine.raceView('rb').startList.used, s.engine.raceView('rb').startList.on], [undefined, [], true, 20]);
});

test('9.25 a start list loaded in the middle of a race: who is not in it comes off the count, the others\' places go out again, the boards\' old line is said; removed, they are sent again', () => {
  const s = setup();
  s.run(RACES.girls);
  s.run(RACES.boys, { extra: [['105', 120]], upTo: 400 });
  s.clock.advance(120_000);
  assert.deepEqual(boards(s, RACES.boys).slice(0, 2), [['105', '1K', 1], ['200', '1K', 2]]);
  const at = s.sends.length;
  s.lists.value = LISTS();
  const res = s.engine.startListsChanged();
  assert.deepEqual([res.resent, res.held], [20, [{ raceId: 'rb', raceName: 'Boys 5K', bib: '105', splitName: '1K', text: '2:00.0' }]]);
  assert.deepEqual(s.lines(RACES.boys, { from: at }).slice(0, 2), [['200', '1K', '3:00.0', 1, 'place-update'], ['201', '1K', '3:03.6', 2, 'place-update']]);
  assert.deepEqual(s.engine.review('rb').away.map((a) => [a.bib, a.passes[0].onBoards]), [['105', '2:00.0']]);
  s.run(RACES.boys, { extra: [['105', 120]], after: 400 });
  s.clock.advance(5000);
  assert.deepEqual(boards(s, RACES.boys).filter(([bib, split]) => split === '1K' && bib !== '105').map(([, , place]) => place), range(1, 20).map(Number));
  // the list removed: the athlete counts again
  s.lists.value = null;
  s.engine.startListsChanged();
  assert.deepEqual([s.engine.review('rb').away, s.engine.raceView('rb').startList, s.engine.review('rb').flags.map((f) => f.text)],
    [undefined, undefined, ['Bib 105 ran in Girls 5K today: not in this race?']]);
  assert.deepEqual(boards(s, RACES.boys).filter(([, split]) => split === '1K').slice(0, 2), [['105', '1K', 1], ['200', '1K', 2]]);
});
