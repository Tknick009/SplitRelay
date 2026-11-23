// DESIGN 9.27: swapped bibs. Two athletes ran with each other's chips: every read of one chip counts for the other
// bib, in every race, for the reads already in and the ones to come; the journal keeps each read as it came in, so
// removing the swap puts everything back. The engine on two synthetic races of one day: bibs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { loadEntryFiles, noStartLists } from '../src/entries.js';
import { parseTod, formatRaceTime, TICKS_PER_SEC } from '../src/timefmt.js';

const S = TICKS_PER_SEC;
const T0 = new Date(2026, 10, 21, 10, 0, 0).getTime();
const HEAD = 'NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE';
const entryFile = (bibs, event, sex = 'M') => [HEAD, ...bibs.map((b) => `${b};Runner;N${b};${sex};SO;T${event};Team ${event};;;${event};`), ''].join('\r\n');
const range = (a, n) => Array.from({ length: n }, (_, i) => String(a + i));

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
/**
 * Women's Race (event 1, bibs 100-119, gun 10:00) and Men's Race (event 2, bibs 200-219, gun 11:00). The ports are
 * numbers in the settings only: nothing listens. Athlete 105 ran with the chip of bib 205, and athlete 205 with the
 * chip of bib 105: the women's race reads "205" where 105 ran, the men's race "105" where 205 ran.
 */
const RACES = {
  women: { id: 'rw', name: "Women's Race", eventNumber: '1', port: 6450, gun: '10:00:00.000', bibs: range(100, 20) },
  men: { id: 'rm', name: "Men's Race", eventNumber: '2', port: 6451, gun: '11:00:00.000', bibs: range(200, 20) },
};
const CHIP = { 105: '205', 205: '105' };
const LISTS = () => loadEntryFiles(noStartLists(), [{ name: '1.txt', text: entryFile(RACES.women.bibs, 1, 'F') }, { name: '2.txt', text: entryFile(RACES.men.bibs, 2) }], { now: T0 }).lists;

function setup({ lists = null, store = memStore(), clock = fakeClock(), config: given = null, outputs = OUTPUTS, active = true, lynx = null, holdSec = 0 } = {}) {
  const config = given ?? {
    version: 1, filter: { tagWindowSec: 10, holdSec, startIgnoreSec: 60 },
    races: Object.values(RACES).map((r) => ({ id: r.id, name: r.name, eventNumber: r.eventNumber, round: '1', heat: '1', distance: '', contests: [], inputPort: r.port,
      gun: r.gun, splits: lapSplits(r.id, 4), finishSources: [], active })),
    outputs, lif: { enabled: true },
  };
  const box = { value: lists };
  /** FinishLynx's finishers per race id: Map<bib, finish ticks>, the place by the order */
  const fin = { value: lynx ?? {} };
  const sends = [];
  const via = [];
  const logs = [];
  const engine = new Engine({ getConfig: () => config, store, clock, log: (l) => logs.push(l), startLists: () => box.value,
    finishers: (id) => (fin.value[id] ? new Map(fin.value[id]) : null),
    finishPlaces: (id) => (fin.value[id] ? new Map(fin.value[id].map(([bib], i) => [bib, i + 1])) : null),
    deliver: (id, packet, ack) => {
      sends.push(packet);
      via.push(id);
      ack(true);
      return true;
    } });
  engine.on('config-patch', ({ raceId, patch }) => Object.assign(config.races.find((r) => r.id === raceId), patch));
  clock.advance(0);
  const s = { engine, config, clock, store, sends, via, logs, lists: box, fin };
  /** one read: `chip` over a mat of `race`, `sec` seconds after its gun (the clock moves there) */
  s.read = (race, chip, sec) => {
    const at = T0 + (parseTod(race.gun) - parseTod('10:00:00')) / S * 1000 + Math.round(sec * 1000);
    if (at > clock.now()) clock.advance(at - clock.now());
    return engine.handleRead({ location: '', bib: String(chip), tod: parseTod(race.gun) + Math.round(sec * S), contest: '', first: '', last: '', team: '', gender: '' },
      { receivedAt: clock.now(), connId: 1, port: race.port });
  };
  /** The time of the i-th runner of a race at split k (1-based): the leader runs 3:00 a kilometre, each next one 2 % slower. */
  s.at = (i, k) => 180 * k * (1 + 0.02 * i);
  /**
   * A race run: its 20 runners over the four mats, each read coming in as the chip the athlete carried (CHIP), in time
   * order, from `after` up to `upTo` seconds after the gun.
   */
  s.run = (race, { after = -Infinity, upTo = Infinity, extra = [] } = {}) => {
    const reads = [...extra];
    race.bibs.forEach((bib, i) => { for (let k = 1; k <= 4; k++) reads.push([CHIP[bib] ?? bib, s.at(i, k)]); });
    for (const [chip, t] of reads.filter(([, t]) => t > after && t <= upTo).sort((a, b) => a[1] - b[1])) s.read(race, chip, t);
  };
  s.restart = () => {
    engine.stop();
    engine.markCleanStop();
    return setup({ lists: box.value, store, clock, config, lynx: fin.value });
  };
  /** the lines an output got for a race since `from`: [bib, split, time, place, reason] */
  s.lines = (race, { out = 'o1', from = 0, bib = null } = {}) => sends.map((p, i) => [p, via[i]]).slice(from)
    .filter(([p, o]) => o === out && p.raceId === race.id && (bib === null || p.bib === String(bib)))
    .map(([p]) => [p.bib, p.splitName, p.csTicks === null ? '' : formatRaceTime(p.csTicks, 1), p.place, p.reason]);
  return s;
}
const journalOf = (s) => s.store.journal.map((l) => JSON.parse(l));
/** A race as the engine holds it: every crossing that counts, "bib|split|time|place|held|source". */
const held = (s, race) => (s.engine.crossings(race.id) ?? []).map((c) => `${c.bib}|${c.splitName}|${c.raceTicks}|${c.place}|${c.held ?? ''}|${c.source}`).sort();
/** One runner's splits in a race: "1K 3:18.0, 2K 6:36.0" ('' for a runner the race does not have). */
const splitsOf = (s, race, bib) => (s.engine.crossings(race.id) ?? []).filter((c) => c.bib === String(bib)).sort((a, b) => a.raceTicks - b.raceTicks)
  .map((c) => `${c.splitName} ${formatRaceTime(c.raceTicks, 1)}`).join(', ');
/**
 * Everything the tests compare before and after: both races' crossings, the Review list (what is missing, held, made
 * up, not in the race), and the two runners as the runner editor has them: every column, pass, typed time and change.
 * Not what the scoreboards were given meanwhile (a cell they still show, a line that is out of date): that is the
 * boards' own history, which nothing takes back.
 */
const snapshot = (s) => JSON.stringify(Object.values(RACES).map((r) => {
  const rv = s.engine.review(r.id);
  return [held(s, r), rv.counts, rv.missing.map((m) => `${m.bib} ${m.splitName}`), rv.checks.map((c) => `${c.bib} ${c.fromName}`), rv.manual.map((m) => `${m.bib} ${m.splitName} ${m.timeText} ${m.state}`),
    (rv.away ?? []).map((x) => x.bib), (rv.off ?? []).map((x) => x.bib),
    ['105', '205'].map((bib) => {
      const v = s.engine.runner(r.id, bib);
      return { found: v.found, finished: v.finished, place: v.place, swap: v.swap ? v.swap.text : null, sending: v.sending?.off ?? null,
        columns: v.columns.map((c) => [c.splitName, c.timeText, c.place, c.source, c.held, c.kind, c.how]),
        passes: v.passes.map((p) => [p.todText, p.timeText, p.splitName, p.how, p.pinned, p.readAs ?? null]),
        manual: v.manual.map((m) => [m.splitName, m.timeText, m.state]), changes: v.changes.map((c) => [c.fix, c.text, c.undone, c.undoable]) };
    })];
}));
/** Where two snapshots differ, as paths ("[0][2][1].changes[0].undoable: true != false"), for a failure's message. */
function differences(a, b, path = '', out = []) {
  if (out.length >= 8) return out;
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}
const sameSnapshot = (now, before, message) => assert.deepEqual(differences(JSON.parse(now), JSON.parse(before)), [], message);
const W = RACES.women;
const M = RACES.men;
/** The four splits of the women's 6th runner (index 5) and of the men's 6th: what bibs 105 and 205 ran. */
const RAN = '1K 3:18.0, 2K 6:36.0, 3K 9:54.0, 4K 13:12.0';

test('9.27 the rules: both bibs, not the same one ("0458" is 458), a bib in one swap only, removing one that is not there', () => {
  const s = setup();
  const bad = (body, status, message) => assert.throws(() => s.engine.addSwap(body), (e) => {
    assert.deepEqual([e.status, e.message], [status, message]);
    return true;
  });
  bad({}, 400, 'Type both bib numbers.');
  bad({ bib: '105' }, 400, 'Type both bib numbers.');
  bad({ bib: '105', other: '000' }, 400, '"000" is not a bib number.');
  bad({ bib: '105', other: '2|5' }, 400, '"2|5" is not a bib number.');
  bad({ bib: '458', other: '0458' }, 400, "Bib 458 can't be swapped with itself. Type the bib whose chip it ran with.");
  const r = s.engine.addSwap({ bib: '0105', other: ' 205 ' });
  assert.deepEqual([r.text, r.swap.a, r.swap.b, r.swap.text, r.removed, r.races], ['Bibs 105 and 205 are swapped.', '105', '205', 'Bib 105 and bib 205 are swapped', false, []]);
  bad({ bib: '205', other: '105' }, 409, 'Bibs 205 and 105 are swapped already.');
  bad({ bib: '105', other: '300' }, 409, 'Bib 105 is swapped with bib 205 already, and a bib can be in one swap only. Remove that swap first.');
  bad({ bib: '300', other: '0205' }, 409, 'Bib 205 is swapped with bib 105 already, and a bib can be in one swap only. Remove that swap first.');
  assert.throws(() => s.engine.swapPreview({ bib: '300', other: '205' }), /Bib 205 is swapped with bib 105 already/);
  assert.throws(() => s.engine.removeSwap({ bib: '300' }), (e) => e.status === 404 && /Bib 300 is not swapped with another bib/.test(e.message));
  assert.deepEqual(s.engine.swaps().map((x) => [x.a, x.b, x.races]), [['105', '205', []]]);
  // either bib removes it
  assert.equal(s.engine.removeSwap({ bib: '0205' }).text, 'The swap of bibs 105 and 205 was removed.');
  assert.deepEqual(s.engine.swaps(), []);
  assert.deepEqual(journalOf(s).filter((r) => /swap/.test(r.t)).map((r) => [r.t, r.a, r.b]), [['swap', '105', '205'], ['unswap', '105', '205']]);
});

test('9.27 after both races: each runner gets the reads of the chip it carried, nothing is left under the wrong bib, no other runner changes; removing it puts back exactly what was', () => {
  const s = setup();
  s.run(W);
  s.run(M);
  s.clock.advance(5000);
  // as it came in: "205" ran the women's race and "105" the men's
  assert.deepEqual([splitsOf(s, W, 205), splitsOf(s, W, 105), splitsOf(s, M, 105), splitsOf(s, M, 205)], [RAN, '', RAN, '']);
  const before = snapshot(s);
  const others = (race) => held(s, race).filter((c) => !/^(105|205)\|/.test(c));
  const [wOthers, mOthers] = [others(W), others(M)];
  const journal = s.store.journal.length;
  const plan = s.engine.swapPreview({ bib: '105', other: '205' });
  assert.deepEqual([plan.title, plan.confirm, plan.remove], ['Swap bibs 105 and 205?', 'Swap bibs', false]);
  assert.deepEqual(plan.races.map((r) => [r.raceName, r.lines]), [
    ["Women's Race", ["Bib 205's 4 splits (3:18.0 to 13:12.0) become bib 105's.", 'They go out again under bib 105.',
      "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell."]],
    ["Men's Race", ["Bib 105's 4 splits (3:18.0 to 13:12.0) become bib 205's.", 'They go out again under bib 205.',
      "The boards still show 4 splits under bib 105 (sent before): a packet can't empty a cell."]]]);
  sameSnapshot(snapshot(s), before, 'a preview changes nothing');
  assert.equal(s.store.journal.length, journal);
  const at = s.sends.length;
  const r = s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  assert.deepEqual([splitsOf(s, W, 105), splitsOf(s, W, 205), splitsOf(s, M, 205), splitsOf(s, M, 105)], [RAN, '', RAN, '']);
  assert.deepEqual([others(W), others(M)], [wOthers, mOthers], 'no other runner changed');
  // the places are the same ones: the runner is the 6th at every split, under its own bib now
  assert.deepEqual(held(s, W).filter((c) => c.startsWith('105|')).map((c) => c.split('|')[3]), ['6', '6', '6', '6']);
  // the boards: the four splits go out under the right bib, in course order, to both outputs; nobody else's line goes again
  assert.deepEqual(s.lines(W, { from: at }), [['105', '1K', '3:18.0', 6, 'new'], ['105', '2K', '6:36.0', 6, 'new'], ['105', '3K', '9:54.0', 6, 'new'], ['105', '4K', '13:12.0', 6, 'new']]);
  assert.deepEqual(s.lines(M, { from: at, out: 'o2' }).map((l) => l.slice(0, 2).join(' ')), ['205 1K', '205 2K', '205 3K', '205 4K']);
  assert.equal(s.sends.length - at, 16);
  assert.deepEqual(r.races.map((x) => [x.raceName, x.sentTo, x.resent.lines, x.leftover.length, x.lines]), [
    ["Women's Race", ['TrackScore', 'Karmarush'], 0, 4, ["4 splits are bib 105's now; bib 205 has none here.", 'Sent to TrackScore and Karmarush.',
      "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell."]],
    ["Men's Race", ['TrackScore', 'Karmarush'], 0, 4, ["4 splits are bib 205's now; bib 105 has none here.", 'Sent to TrackScore and Karmarush.',
      "The boards still show 4 splits under bib 105 (sent before): a packet can't empty a cell."]]]);
  assert.deepEqual(s.engine.swaps().map((x) => x.races.map((y) => y.text)), [[
    "Women's Race: bib 105 has 4 splits (3:18.0 to 13:12.0) read as bib 205", "Men's Race: bib 205 has 4 splits (3:18.0 to 13:12.0) read as bib 105"]]);
  // the merged .lif: the right row has the splits, the other bib has no row
  const lif = s.engine.raceData(W.id).runners;
  assert.deepEqual([lif.get('105').splits.map((t) => formatRaceTime(t, 1)).join(' '), lif.has('205')], ['3:18.0 6:36.0 9:54.0 13:12.0', false]);
  // the runner's view says so, and each pass says what it was read as; Find finds the runner under its own bib
  const v = s.engine.runner(W.id, '105');
  assert.deepEqual([v.swap.other, v.swap.text, v.passes.map((p) => p.readAs)],
    ['205', 'Swapped bibs: bib 105 ran with the chip of bib 205. Its reads here came in as bib 205.', ['205', '205', '205', '205']]);
  assert.equal(s.engine.runner(W.id, '205').found, false);
  assert.deepEqual(s.engine.find('105').matches.map((m) => [m.raceName, m.bib, m.filled, m.readAs]), [["Women's Race", '105', 4, '205']]);
  // the journal keeps the reads as they came in
  assert.deepEqual(journalOf(s).filter((x) => x.t === 'read' && x.raceId === W.id && (x.bib === '105' || x.bib === '205')).map((x) => x.bib), ['205', '205', '205', '205']);
  // removing it: what the preview says, then exactly the state before
  const back = s.engine.swapPreview({ bib: '205', remove: true });
  assert.deepEqual([back.title, back.confirm, back.races[0].lines], ['Remove the swap of bibs 105 and 205?', 'Remove swap',
    ["Bib 105's 4 splits (3:18.0 to 13:12.0), read as bib 205, go back to bib 205.", 'They go out again under bib 205.',
      "The boards still show 4 splits under bib 105 (sent before): a packet can't empty a cell."]]);
  const at2 = s.sends.length;
  const gone = s.engine.removeSwap({ bib: '105' });
  s.clock.advance(5000);
  sameSnapshot(snapshot(s), before);
  // the boards have bib 205's women's splits already (sent before the swap, the same times and places): nothing goes again
  assert.equal(s.sends.length, at2);
  assert.deepEqual(gone.races.map((x) => x.lines), [
    ["4 splits are bib 205's now; bib 105 has none here.", "The boards still show 4 splits under bib 105 (sent before): a packet can't empty a cell."],
    ["4 splits are bib 105's now; bib 205 has none here.", "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell."]]);
});

test('9.27 a restart rebuilds the swap from the journal; a line RR12 sends again is still a repeat; Start a new meet forgets the swap', () => {
  const s = setup();
  s.run(W);
  s.run(M);
  s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  const before = snapshot(s);
  const r = s.restart();
  r.clock.advance(20000);
  sameSnapshot(snapshot(r), before);
  assert.deepEqual(r.engine.swaps().map((x) => [x.a, x.b, x.at]), s.engine.swaps().map((x) => [x.a, x.b, x.at]));
  assert.equal(r.sends.length, 0, 'a restart sends nothing again');
  // a read that comes now counts for the other bib too, and its row says what it came in as
  const late = r.read(M, '105', 900);
  assert.deepEqual([late.bib, late.readAs, late.raceName], ['205', '105', "Men's Race"]);
  // an RR12 Replay of a line that is in already: the same line, whatever runner it counts for
  const again = r.read(W, '205', r.at(5, 1));
  assert.deepEqual([again.status, again.bib, again.readAs], ['duplicate', '105', '205']);
  assert.equal(splitsOf(r, W, 105), RAN);
  // Start a new meet: the old meet's swap goes with its reads
  r.engine.newMeet();
  assert.deepEqual(r.engine.swaps(), []);
  const n = r.restart();
  assert.deepEqual(n.engine.swaps(), []);
  n.clock.advance(1000);
  const fresh = n.read(W, '205', n.at(5, 1));
  assert.deepEqual([fresh.bib, fresh.readAs, fresh.status === 'duplicate'], ['205', undefined, false]);
});

test('9.27 entered before the gun, with start lists: the reads count for the right bib as they come in; nothing is held as Not in this race, nothing ever goes out under the chip', () => {
  const s = setup({ lists: LISTS() });
  const plan = s.engine.swapPreview({ bib: '105', other: '205' });
  assert.deepEqual([plan.races, plan.notes], [[], ['Neither bib has been read yet. The swap is ready for the reads to come: check the two numbers.']]);
  s.engine.addSwap({ bib: '105', other: '205' });
  s.run(W);
  s.run(M);
  s.clock.advance(5000);
  assert.deepEqual([s.lines(W, { bib: 205 }), s.lines(M, { bib: 105 })], [[], []]);
  assert.deepEqual(s.lines(W, { bib: 105 }), [['105', '1K', '3:18.0', 6, 'new'], ['105', '2K', '6:36.0', 6, 'new'], ['105', '3K', '9:54.0', 6, 'new'], ['105', '4K', '13:12.0', 6, 'new']]);
  assert.deepEqual(s.lines(M, { bib: 205, out: 'o2' }).map((l) => `${l[1]} ${l[3]} ${l[4]}`), ['1K 6 new', '2K 6 new', '3K 6 new', '4K 6 new']);
  for (const race of [W, M]) {
    const rv = s.engine.review(race.id);
    assert.deepEqual([rv.away, rv.unlisted, rv.flags, rv.checks], [undefined, undefined, [], []]);
  }
  // the live feed: the row is the runner's, and says what it was read as
  const rows = s.engine.feed(1000).filter((e) => e.readAs);
  assert.deepEqual([...new Set(rows.map((e) => `${e.raceName} ${e.bib} read as ${e.readAs}`))].sort(), ["Men's Race 205 read as 105", "Women's Race 105 read as 205"]);
  assert.equal(rows.length, 8);
  // without the swap the start lists hold both athletes off the boards: that is where the timer first sees it
  s.engine.removeSwap({ bib: '105' });
  assert.deepEqual([s.engine.review(W.id).away.map((x) => [x.bib, x.why]), s.engine.review(M.id).away.map((x) => [x.bib, x.why])],
    [[['205', "entered in Men's Race"]], [['105', "entered in Women's Race"]]]);
});

test('9.27 entered mid-race: the splits already out under the chip go out under the right bib, the later ones follow; with a start list, what was held off the boards goes out and the places behind it go out again', () => {
  // no start list: bib "205" is on the women's boards with 1K and 2K when the timer sees it
  const s = setup();
  s.run(W, { upTo: 400 });
  s.clock.advance(3000);
  assert.deepEqual(s.lines(W, { bib: 205 }).map((l) => `${l[1]} ${l[3]}`), ['1K 6', '2K 6']);
  let at = s.sends.length;
  const r = s.engine.addSwap({ bib: '105', other: '205' });
  assert.deepEqual(s.lines(W, { from: at }), [['105', '1K', '3:18.0', 6, 'new'], ['105', '2K', '6:36.0', 6, 'new']]);
  assert.deepEqual(r.races.map((x) => x.lines), [["2 splits are bib 105's now; bib 205 has none here.", 'Sent to TrackScore and Karmarush.',
    "The boards still show 2 splits under bib 205 (sent before): a packet can't empty a cell."]]);
  at = s.sends.length;
  s.run(W, { after: 400 });
  s.clock.advance(3000);
  assert.deepEqual([s.lines(W, { from: at, bib: 105 }).map((l) => `${l[1]} ${l[3]} ${l[4]}`), s.lines(W, { from: at, bib: 205 })], [['3K 6 new', '4K 6 new'], []]);
  assert.equal(splitsOf(s, W, 105), RAN);
  // the race view counts the cells the boards keep under the chip's bib (9.16 F1): the existing words
  assert.deepEqual([s.engine.raceView(W.id).leftover.count, s.engine.raceView(W.id).leftover.runners], [2, ['205']]);

  // with start lists: "205" is entered in the men's race, so the women's race keeps it off the boards
  const l = setup({ lists: LISTS() });
  l.run(W, { upTo: 400 });
  l.clock.advance(3000);
  assert.deepEqual([l.lines(W, { bib: 205 }), l.engine.review(W.id).away.map((x) => x.bib)], [[], ['205']]);
  // (the runners behind it at 1K had the places without it: 106 was 6th)
  assert.deepEqual(l.lines(W, { bib: 106 }).map((x) => `${x[1]} ${x[3]}`), ['1K 6']);
  at = l.sends.length;
  const p = l.engine.swapPreview({ bib: '205', other: '105' });
  assert.deepEqual(p.races.map((x) => x.lines), [["Bib 205's 2 splits (3:18.0 to 6:36.0) become bib 105's.", 'They go out again under bib 105.']]);
  const res = l.engine.addSwap({ bib: '205', other: '105' });
  l.clock.advance(3000);
  assert.deepEqual(l.lines(W, { from: at, bib: 105 }), [['105', '1K', '3:18.0', 6, 'new'], ['105', '2K', '6:36.0', 6, 'new']]);
  // 106 and everyone behind is a place further back at the splits bib 105 crossed before them: their lines go out again
  assert.deepEqual(l.lines(W, { from: at, bib: 106 }).map((x) => `${x[1]} ${x[3]} ${x[4]}`), ['1K 7 place-update']);
  assert.equal(res.races[0].resent.lines > 0, true);
  assert.match(res.races[0].lines.join(' '), /lines of other runners went out again with their new places\./);
  assert.equal(l.engine.review(W.id).away, undefined);
  assert.deepEqual(res.races[0].leftover, []);
});

test('9.27 by the rules of a Resend: a race that is not Active gets its merged .lif only; a finisher is not sent by itself (Finished: not sent live); a paused split waits', () => {
  // not Active: nothing goes out, the merged .lif data follows
  const s = setup();
  s.run(W);
  s.run(M);
  s.clock.advance(5000);
  s.config.races[0].active = false;
  s.engine.configChanged();
  const at = s.sends.length;
  const plan = s.engine.swapPreview({ bib: '105', other: '205' });
  assert.deepEqual(plan.races[0].lines, ["Bib 205's 4 splits (3:18.0 to 13:12.0) become bib 105's.",
    "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell.", "Women's Race is not Active: nothing is sent. Its merged .lif file follows by itself."]);
  const r = s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  assert.deepEqual(s.lines(W, { from: at }), []);
  assert.deepEqual(r.races[0].lines, ["4 splits are bib 105's now; bib 205 has none here.", "Not sent: Women's Race is not Active. Its merged .lif file follows by itself.",
    "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell."]);
  assert.deepEqual([s.engine.raceData(W.id).runners.has('105'), s.engine.raceData(W.id).runners.has('205')], [true, false]);
  assert.equal(s.lines(M, { from: at, bib: 205 }).length, 4, "the men's race is Active: its splits go out");

  // FinishLynx has the right bibs: the women's race has finished with bib 105 in it, 6th
  const f = setup();
  f.run(W);
  f.clock.advance(5000);
  f.fin.value = { rw: W.bibs.map((bib, i) => [bib, Math.round(f.at(i, 5) * S)]) };
  f.engine.converge();
  const from = f.sends.length;
  const fp = f.engine.swapPreview({ bib: '105', other: '205' });
  assert.deepEqual(fp.races[0].lines.slice(0, 2), ["Bib 205's 4 splits (3:18.0 to 13:12.0) become bib 105's.",
    "Bib 105 has finished, so they are not sent by themselves: TrackScore keeps FinishLynx's place. Review lists them under Finished: not sent live, with Send with finish place."]);
  const fr = f.engine.addSwap({ bib: '105', other: '205' });
  f.clock.advance(5000);
  assert.deepEqual(f.lines(W, { from }), []);
  assert.deepEqual(fr.races[0].lines, ["4 splits are bib 105's now; bib 205 has none here.",
    '4 splits of bib 105 were not sent: bib 105 has finished. Review lists them under Finished: not sent live (Send with finish place).',
    "The boards still show 4 splits under bib 205 (sent before): a packet can't empty a cell."]);
  assert.deepEqual(f.engine.review(W.id).finishedNotSent.map((x) => `${x.bib} ${x.splitName} ${x.finishPlace}`), ['105 1K 6', '105 2K 6', '105 3K 6', '105 4K 6']);
  // Send with finish place sends them, with FinishLynx's place
  f.engine.sendFinished(W.id, { bib: '105' });
  assert.deepEqual(f.lines(W, { from }).map((l) => `${l[0]} ${l[1]} ${l[3]}`), ['105 1K 6', '105 2K 6', '105 3K 6', '105 4K 6']);
  assert.deepEqual(f.engine.raceData(W.id).runners.get('105').splits.length, 4);

  // a paused split is not sent by the swap either
  const p = setup();
  p.run(W, { upTo: 400 });
  p.clock.advance(3000);
  p.config.races[0].splits[1].sending = false;
  p.engine.configChanged();
  const pa = p.sends.length;
  const pr = p.engine.addSwap({ bib: '105', other: '205' });
  assert.deepEqual(p.lines(W, { from: pa }), [['105', '1K', '3:18.0', 6, 'new']]);
  assert.match(pr.races[0].lines.join(' '), /1 split of bib 105 was not sent: 2K is paused\./);
});

/** A women's race in which the mats read chip 205 where 105 ran, but not at split `missed` (1-based). */
function womenWithout(s, missed) {
  const reads = W.bibs.flatMap((bib, i) => [1, 2, 3, 4].map((k) => [CHIP[bib] ?? bib, s.at(i, k), k]));
  for (const [chip, t] of reads.filter(([chip, , k]) => !(chip === '205' && k === missed)).sort((a, b) => a[1] - b[1])) s.read(W, chip, t);
}

test('9.27 typed times and the swap: a time typed for the right bib (the hand fix) gives way to the real read of its split, and is back when the swap is removed', () => {
  // the women's race is over; FinishLynx has bib 105 in it; the mats read its chip as 205. The timer typed 105's splits
  // by hand, each a second off, and 3K for a mat that never read the chip.
  const s = setup();
  womenWithout(s, 3);
  s.clock.advance(5000);
  s.fin.value = { rw: W.bibs.map((bib, i) => [bib, Math.round(s.at(i, 5) * S)]) };
  s.engine.converge();
  for (const [k, time] of [[1, '3:19.0'], [2, '6:37.0'], [3, '9:53.0'], [4, '13:13.0']]) s.engine.addManual(W.id, { bib: '105', splitId: `rws${k}`, time });
  s.clock.advance(5000);
  assert.deepEqual(s.engine.runner(W.id, '105').columns.map((c) => `${c.timeText} ${c.source}`), ['3:19.0 typed', '6:37.0 typed', '9:53.0 typed', '13:13.0 typed']);
  const before = snapshot(s);
  const plan = s.engine.swapPreview({ bib: '105', other: '205' });
  assert.equal(plan.races[0].lines.at(-1),
    'What you changed for bib 105 here (4 typed or made-up times) stays with bib 105: they are not carried over to bib 205. A real read takes the place of a typed or made-up time of its split.');
  s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  // the real reads where the mats read the chip, the typed time where they did not; nothing under 205
  const v = s.engine.runner(W.id, '105');
  assert.deepEqual(v.columns.map((c) => `${c.timeText} ${c.source}`), ['3:18.0 read', '6:36.0 read', '9:53.0 typed', '13:12.0 read']);
  assert.deepEqual(v.manual.map((m) => `${m.splitName} ${m.timeText} ${m.state}`), ['1K 3:19.0 replaced', '2K 6:37.0 replaced', '3K 9:53.0 active', '4K 13:13.0 replaced']);
  assert.match(v.problems.map((p) => p.text).join(' '), /2K: the typed time 6:37.0 is not used \(a real read replaced it\)/);
  assert.equal(splitsOf(s, W, 205), '');
  // removing the swap: the typed times count again, exactly as before
  s.engine.removeSwap({ bib: '105' });
  s.clock.advance(5000);
  sameSnapshot(snapshot(s), before);
  // a restart with the swap in: the same
  s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  const mid = snapshot(s);
  const r = s.restart();
  r.clock.advance(20000);
  sameSnapshot(snapshot(r), mid);
});

test("9.27 what was changed for the chip's bib before the swap stays with that bib and is set aside: a made-up time, Not a split, Stop sending; all back when the swap is removed", () => {
  // the women's race, read as "205" where 105 runs; the 2K mat missed that chip
  const s = setup();
  womenWithout(s, 2);
  // a stray pass of the chip long after the race, set aside as Not a split
  s.read(W, '205', 1500);
  s.clock.advance(5000);
  const stray = s.engine.runner(W.id, '205').passes.at(-1);
  s.engine.movePass(W.id, '205', { tod: stray.tod, to: 'none' });
  // the timer fills in the 2K the mat missed, for "205"
  const hint = s.engine.runner(W.id, '205');
  if (hint.missedHint) s.engine.addMissed(W.id, '205', { splitId: hint.missedHint.splitId, passTod: hint.columns.find((c) => c.splitId === hint.missedHint.splitId)?.passTod });
  else s.engine.addManual(W.id, { bib: '205', splitId: 'rws2' });
  s.clock.advance(5000);
  const was = s.engine.runner(W.id, '205');
  assert.deepEqual(was.columns.map((c) => c.source), ['read', 'made-up', 'read', 'read']);
  assert.equal(was.passes.at(-1).how, 'ignored');
  const before = snapshot(s);
  const plan = s.engine.swapPreview({ bib: '105', other: '205' });
  assert.match(plan.races[0].lines.join(' '), /What you changed for bib 205 here \((\d+ changed pass(es)?) and 1 typed or made-up time\) stays with bib 205: they are not carried over to bib 105\./);
  s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  // nothing counts under 205: its made-up 2K was made from reads that are 105's now, and is set aside
  assert.equal(splitsOf(s, W, 205), '');
  const left = s.engine.runner(W.id, '205');
  assert.deepEqual(left.manual.map((m) => `${m.splitName} ${m.state}`), ['2K swapped']);
  assert.match(left.problems.map((p) => p.text).join(' '), /2K: the made-up time \S+ is not used \(it was made from reads that count for another bib now: swapped bibs\)/);
  // removing the swap: the made-up time and Not a split are 205's again
  s.engine.removeSwap({ bib: '205' });
  s.clock.advance(5000);
  sameSnapshot(snapshot(s), before);

  // Stop sending stays with the bib it was said of
  const o = setup();
  o.run(W, { upTo: 400 });
  o.clock.advance(3000);
  o.engine.stopRunner(W.id, '205', {});
  const at = o.sends.length;
  const op = o.engine.swapPreview({ bib: '105', other: '205' });
  assert.match(op.races[0].lines.join(' '), /What you changed for bib 205 here \(Stop sending this runner\) stays with bib 205: it is not carried over to bib 105\./);
  o.engine.addSwap({ bib: '105', other: '205' });
  o.run(W, { after: 400 });
  o.clock.advance(3000);
  assert.deepEqual(o.lines(W, { from: at, bib: 105 }).map((l) => `${l[1]} ${l[4]}`), ['1K new', '2K new', '3K new', '4K new']);
  o.engine.removeSwap({ bib: '105' });
  assert.equal(o.engine.runner(W.id, '205').sending.off !== null, true, 'bib 205 is stopped again');
});

test('9.27 both chips in one race: the two runners change places with each other, the corrected lines go out whatever the minute, the others keep theirs', () => {
  const s = setup();
  // 103 and 104 of the women's race carried each other's chips: nothing else is wrong
  s.run(W);
  s.clock.advance(120000);
  const others = () => held(s, W).filter((c) => !/^(103|104)\|/.test(c));
  const was = others();
  assert.deepEqual([splitsOf(s, W, 103).split(', ')[0], splitsOf(s, W, 104).split(', ')[0]], ['1K 3:10.8', '1K 3:14.4']);
  const at = s.sends.length;
  const plan = s.engine.swapPreview({ bib: '103', other: '104' });
  assert.deepEqual(plan.races[0].lines, ["Bib 103's 4 splits (3:10.8 to 12:43.2) become bib 104's.", 'They go out again under bib 104.',
    "Bib 104's 4 splits (3:14.4 to 12:57.6) become bib 103's.", 'They go out again under bib 103.']);
  const r = s.engine.addSwap({ bib: '103', other: '104' });
  s.clock.advance(5000);
  assert.deepEqual([splitsOf(s, W, 103).split(', ')[0], splitsOf(s, W, 104).split(', ')[0]], ['1K 3:14.4', '1K 3:10.8']);
  assert.deepEqual(others(), was);
  assert.deepEqual(s.lines(W, { from: at, bib: 103 }), [['103', '1K', '3:14.4', 5, 'correction'], ['103', '2K', '6:28.8', 5, 'correction'], ['103', '3K', '9:43.2', 5, 'correction'], ['103', '4K', '12:57.6', 5, 'correction']]);
  assert.deepEqual(s.lines(W, { from: at, bib: 104 }).map((l) => `${l[1]} ${l[2]} ${l[3]} ${l[4]}`), ['1K 3:10.8 4 correction', '2K 6:21.6 4 correction', '3K 9:32.4 4 correction', '4K 12:43.2 4 correction']);
  assert.equal(s.sends.length - at, 16);
  assert.deepEqual([r.races[0].leftover, r.races[0].lines], [[], ["4 splits are bib 103's now; 4 splits are bib 104's now.", 'Sent to TrackScore and Karmarush.']]);
  assert.equal(s.engine.raceView(W.id).stale.count, 0);
});

test('9.27 a time made up while the swap is in force is the right bib\'s, made from the other chip\'s reads: journaled so, set aside when the swap is removed, back with the swap and after a restart', () => {
  const s = setup();
  womenWithout(s, 2);
  s.clock.advance(5000);
  s.engine.addSwap({ bib: '105', other: '205' });
  s.clock.advance(5000);
  // the timer fills in bib 105's 2K, which the mat missed ("Missed 2K: add it": the passes after it move on a split)
  const hint = s.engine.runner(W.id, '105');
  assert.deepEqual(hint.columns.map((c) => c.source), ['read', 'read', 'read', null]);
  s.engine.addMissed(W.id, '105', { splitId: hint.missedHint.splitId, passTod: hint.columns.find((c) => c.splitId === hint.missedHint.splitId)?.passTod });
  s.clock.advance(5000);
  assert.deepEqual(s.engine.runner(W.id, '105').columns.map((c) => c.source), ['read', 'made-up', 'read', 'read']);
  const rec = journalOf(s).findLast((x) => x.t === 'manual');
  assert.deepEqual([rec.bib, rec.chip], ['105', '205']);
  const during = snapshot(s);
  // the swap removed: the reads are 205's again; 105's made-up time was made from them and counts for nobody
  s.engine.removeSwap({ bib: '105' });
  s.clock.advance(5000);
  assert.deepEqual([splitsOf(s, W, 105), s.engine.runner(W.id, '105').manual.map((m) => `${m.splitName} ${m.state}`), splitsOf(s, W, 205).split(', ').length], ['', ['2K swapped'], 3]);
  assert.deepEqual(s.engine.raceData(W.id).runners.has('105'), false);
  // the swap again: as it was; and after a restart
  s.engine.addSwap({ bib: '205', other: '105' });
  s.clock.advance(5000);
  sameSnapshot(snapshot(s), during);
  const r = s.restart();
  r.clock.advance(20000);
  sameSnapshot(snapshot(r), during);
  // an Undo of the made-up time, then of that Undo, keeps what it was made with
  const fix = r.engine.runner(W.id, '105').changes[0].fix;
  r.engine.undo(W.id, { fix, confirm: true });
  assert.deepEqual([r.engine.runner(W.id, '105').columns.map((c) => c.source), r.engine.runner(W.id, '105').manual], [['read', 'read', 'read', null], []]);
  r.engine.undo(W.id, { fix: r.engine.runner(W.id, '105').changes[0].fix, confirm: true });
  assert.deepEqual(r.engine.runner(W.id, '105').columns.map((c) => c.source), ['read', 'made-up', 'read', 'read']);
  assert.equal(journalOf(r).findLast((x) => x.t === 'manual').chip, '205');
});

test('9.27 with start lists, the words say who stays off the boards: removing a swap sends the reads back to bibs that are not in the race', () => {
  const s = setup({ lists: LISTS() });
  s.engine.addSwap({ bib: '105', other: '205' });
  s.run(W, { upTo: 400 });
  s.clock.advance(3000);
  const plan = s.engine.swapPreview({ bib: '105', remove: true });
  assert.deepEqual(plan.races.map((r) => r.lines), [["Bib 105's 2 splits (3:18.0 to 6:36.0), read as bib 205, go back to bib 205.",
    "They stay off the boards: bib 205 is not in this race (entered in Men's Race).", "The boards still show 2 splits under bib 105 (sent before): a packet can't empty a cell."]]);
  const at = s.sends.length;
  const r = s.engine.removeSwap({ bib: '105' });
  s.clock.advance(3000);
  assert.deepEqual(r.races[0].lines.slice(0, 2), ["2 splits are bib 205's now; bib 105 has none here.", "Bib 205 is not in this race (entered in Men's Race): nothing of it goes out. Review, Not in this race."]);
  assert.match(r.races[0].lines.join(' '), /The boards still show 2 splits under bib 105 \(sent before\): a packet can't empty a cell\./);
  assert.deepEqual([s.lines(W, { from: at, bib: 205 }), s.engine.review(W.id).away.map((x) => x.bib), r.pair], [[], ['205'], ['105', '205']]);
  // the runner editor of a bib that is one of a pair and has no read here says so
  s.engine.addSwap({ bib: '105', other: '205' });
  const v = s.engine.runner(W.id, '205');
  assert.deepEqual([v.found, v.swap.other, v.swap.text], [false, '105', 'Swapped bibs: bib 205 ran with the chip of bib 105. That chip has not been read in this race.']);
  // a journal edited by hand: a pair that breaks the rules is left out at a start, the rest stands
  s.store.journal.push(JSON.stringify({ t: 'swap', a: '105', b: '300', at: 5 }), JSON.stringify({ t: 'swap', a: '7', b: '07', at: 5 }), JSON.stringify({ t: 'swap', a: '301', b: '302', at: 6 }),
    JSON.stringify({ t: 'unswap', a: '301', b: '999', at: 7 }));
  const again = s.restart();
  assert.deepEqual(again.engine.swaps().map((x) => `${x.a}-${x.b}`), ['105-205', '301-302']);
});
