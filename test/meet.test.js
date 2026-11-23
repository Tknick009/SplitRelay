// Meet files and the meet load (src/meet.js, DESIGN 9.22): the file Save writes, what a hand-edited file may hold, the
// merge rules a load keeps over races that have reads, and Set up from TrackScore's mapping. Pure: no server, no disk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildMeet, meetText, meetFileName, parseMeet, planMeet, looseKey, trackScoreHost, trackScoreToMeet, meetPaths, meetSummary,
  raceSummary, outputSummary, MeetError, DELETED_RACE, raceRunning, raceClockMs, meetFileOf,
} from '../src/meet.js';
import { defaultConfig, normalizeConfig, addRace, addOutput, updateSettings } from '../src/config.js';

const fixture = (f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), 'utf8'));
/** The user's race-day settings (2026-10-21), paths made generic: Womens Race (gun, Active) and Mens Race on 5565. */
const liveConfig = () => normalizeConfig(fixture('live-config.json')).config;
const TS_RACE = fixture('trackscore-race.json');
const TS_SCHEDULE = fixture('trackscore-schedule.json');
const TS_OLD = fixture('trackscore-schedule-nomeetid.json');
const texts = (items) => items.map((i) => i.text);
const NOW = new Date(2026, 9, 21, 15, 0, 0).getTime();

/** A config on RR12 ports 17565/17566 with the races and outputs given, built through config.js as the panel builds it. */
function setup({ races = [], outputs = [], ports = [17565, 17566], filter } = {}) {
  let c = updateSettings(defaultConfig(), { input: { ports }, panel: { port: 17590 }, ...(filter ? { filter } : {}) });
  for (const r of races) c = addRace(c, r).config;
  // (no loop check: a setup from before Outputs refused an output into this PC's RR12 ports may have one)
  for (const o of outputs) c = addOutput(c, { enabled: false, port: 6555, ...o }, { loopCheck: false }).config;
  return c;
}
const girls = (extra = {}) => ({ name: 'Girls 5K', eventNumber: '3', inputPort: 17565, splits: [{ name: '1K' }, { name: '2K' }, { name: '3K' }], ...extra });
const boys = (extra = {}) => ({ name: 'Boys 5K', eventNumber: '4', inputPort: 17566, splits: [{ name: '1K' }, { name: '3K' }], ...extra });
/** A meet file as a person would write it, through parseMeet. */
const meetOf = (m) => parseMeet({ splitRelayMeet: 1, name: 'Fall Classic 2026', ...m }).meet;
const inUse = (c, name, s = { reads: 40, crossings: 30 }) => new Map([[c.races.find((r) => r.name === name).id, s]]);

describe('the meet file (DESIGN 9.22 M1)', () => {
  test('buildMeet: no ids, guns, Pause, panel or version; plain splits as names; races by name; every race port listed', () => {
    const c = liveConfig();
    c.races[0].splits[1].sending = false; // a paused split: never in a file
    c.outputs.push({ ...c.outputs[0], id: 'o_two', name: 'Karmarush', races: ['r_gone'] });
    c.outputs.push({ ...c.outputs[0], id: 'o_three', name: 'Board', races: ['r_d125f1e39f'] });
    const m = buildMeet(c, { name: 'Meet 2026-10-21', savedAt: '2026-10-21T15:02:11.512Z', savedBy: 'Split Relay 0.1.0', savedOn: 'TIMING-1' });
    assert.deepEqual(Object.keys(m), ['splitRelayMeet', 'name', 'savedAt', 'savedBy', 'savedOn', 'about', 'races', 'outputs', 'input', 'filter', 'names', 'lif']);
    const json = JSON.stringify(m);
    for (const k of ['"id"', '"gun"', '"sending"', '"panel"', '"version"', '16:28:00.455', 'r_4137246fdc', 'o_62e82ddd5d']) assert.ok(!json.includes(k), k);
    assert.deepEqual(m.races[0], { name: 'Womens Race', eventNumber: '2', round: '1', heat: '1', distance: '6K', inputPort: 5565, active: true,
      splits: ['800m', '1500m', '2400m', '3100m', '4200m', '4400m', '5300m'] });
    assert.deepEqual(m.outputs.map((o) => o.races), [[], [DELETED_RACE], ['Mens Race']]);
    assert.deepEqual(m.input.ports, [15565, 5565], 'the races read from 5565, which is listed too');
    assert.deepEqual([m.filter, m.names, m.lif.enabled], [{ tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, { pplPath: 'C:\\Lynx\\Meet.ppl' }, false]);
    // a split with timing points or an earliest time keeps them
    c.races[0].splits[2] = { ...c.races[0].splits[2], sources: ['2K-A', '2K-B'], earliest: '5:30' };
    assert.deepEqual(buildMeet(c).races[0].splits[2], { name: '2400m', sources: ['2K-A', '2K-B'], earliest: '5:30' });
  });

  test('meetText: CRLF, two spaces, a short list of names on one line, and it reads back as the same meet', () => {
    const c = liveConfig();
    const t = meetText(buildMeet(c, { name: 'Meet 2026-10-21' }));
    assert.ok(t.endsWith('}\r\n') && !t.replace(/\r\n/g, '').includes('\n'), 'CRLF only');
    assert.ok(!t.startsWith('\uFEFF'));
    assert.match(t, /\r\n {6}"splits": \["800m", "1500m", "2400m", "3100m", "4200m", "4400m", "5300m"\]/);
    assert.match(t, /"columns": \["location", "bib", "time", "contest", "first", "last", "team", "gender"\]/);
    assert.match(t, /"ports": \[15565, 5565\]/);
    assert.ok(t.split('\r\n').every((l) => l.length <= 120 || l.includes('"about"')), 'lines of at most 120 characters');
    // a list with an object in it is printed one item per line
    c.races[0].splits[1] = { ...c.races[0].splits[1], sources: ['1K-A'] };
    assert.match(meetText(buildMeet(c)), /"splits": \[\r\n {8}"800m",\r\n {8}\{\r\n {10}"name": "1500m",\r\n {10}"sources": \["1K-A"\],/);
    const back = parseMeet(JSON.parse(t));
    assert.deepEqual(back.notes, []);
    assert.deepEqual(parseMeet(buildMeet(c)).meet, parseMeet(JSON.parse(meetText(buildMeet(c)))).meet, 'parseMeet(buildMeet(c)) round-trips');
    // a long list goes one per line
    const long = { splitRelayMeet: 1, races: [{ name: 'X', splits: Array.from({ length: 20 }, (_, i) => `Split number ${i + 1}`) }] };
    assert.match(meetText(long), /"splits": \[\r\n {8}"Split number 1",/);
  });

  test('meetFileName', () => {
    assert.equal(meetFileName("Women's/Men's: 5K?"), "Women's-Men's- 5K-.json");
    assert.equal(meetFileName('CON'), 'Meet CON.json');
    assert.equal(meetFileName('com1.txt'), 'Meet com1.txt.json');
    assert.equal(meetFileName(''), 'Meet.json');
    assert.equal(meetFileName('  ..Fall   Classic.. '), 'Fall Classic.json');
    assert.equal(meetFileName('a\u0001b'), 'a-b.json');
    assert.equal(meetFileName('x'.repeat(100)).length, 85);
  });

  test('parseMeet refuses what is not a meet file, in words', () => {
    const err = (raw, re) => assert.throws(() => parseMeet(raw), (e) => e instanceof MeetError && e.status === 400 && re.test(e.message));
    const NOT = /^This is not a Split Relay meet file: it has no "splitRelayMeet" line\. Save one with Save meet setup\.$/;
    err(null, NOT);
    err([], NOT);
    err({ races: [] }, NOT);
    // O13: a format line that is there but wrong is said as it is
    err({ splitRelayMeet: 0, races: [] }, /^The meet file's "splitRelayMeet" line must be 1 \(it is 0\)\.$/);
    err({ splitRelayMeet: 1.5, races: [] }, /^The meet file's "splitRelayMeet" line must be 1 \(it is 1\.5\)\.$/);
    err({ splitRelayMeet: null, races: [] }, /^The meet file's "splitRelayMeet" line must be 1 \(it is null\)\.$/);
    assert.equal(parseMeet({ splitRelayMeet: '1', races: [{ name: 'A', splits: ['1K'] }] }).meet.races.length, 1, '"1" typed by hand is 1');
    err({ splitRelayMeet: 2, races: [] }, /^This meet file was saved by a newer Split Relay \(format 2\)\. Update Split Relay to load it\.$/);
    err({ splitRelayMeet: 1, races: {} }, /^The meet file's "races" must be a list\.$/);
    err({ splitRelayMeet: 1, outputs: 'x' }, /^The meet file's "outputs" must be a list\.$/);
    err({ splitRelayMeet: 1, name: 'x' }, /^The meet file has nothing to load: no races, no outputs, no settings\.$/);
    err({ splitRelayMeet: 1, races: Array.from({ length: 101 }, (_, i) => ({ name: `R${i}`, splits: [] })) }, /has 101 races\. Split Relay loads at most 100\./);
    err({ splitRelayMeet: 1, outputs: Array.from({ length: 21 }, (_, i) => ({ name: `O${i}`, port: 6000 + i })) }, /has 21 outputs\. Split Relay loads at most 20\./);
    assert.ok(parseMeet({ splitRelayMeet: 1, filter: { holdSec: 1 } }).meet, 'settings only is a meet');
  });

  test('parseMeet: a Split Relay config.json is taken, without its gun times and ids', () => {
    const { meet, notes } = parseMeet(fixture('live-config.json'));
    assert.deepEqual(texts(notes), ['This is a Split Relay settings file (config.json), not a meet file. Its races, outputs and settings are loaded; its gun times and ids are not.']);
    assert.deepEqual(meet.races.map((r) => r.name), ['Womens Race', 'Mens Race']);
    assert.ok(!JSON.stringify(meet).includes('16:28:00.455'));
    assert.ok(!JSON.stringify(meet).includes('r_4137246fdc'));
  });

  test('parseMeet: races left out with a note, mixed splits, numbers as text, unknown keys said once, one gun note', () => {
    const { meet, notes } = parseMeet({
      splitRelayMeet: 1, foo: 1,
      races: [
        'nonsense',
        { eventNumber: 3, splits: [] },
        { name: 'No splits', splits: 'x' },
        { name: 'Too many', splits: Array.from({ length: 21 }, (_, i) => `S${i}`) },
        { name: 'Blank split', splits: ['1K', ''] },
        { name: 'Girls 5K', id: 'r_abc', gun: '10:00:00', evntNumber: '3', eventNumber: 3, distance: 5000, inputPort: '17565',
          splits: ['1K', { name: '2K', sources: ['2K-A', '2K-B'], earliest: '5:30', id: 's_1', sending: false, gun: 'x' }, { name: '3K', foo: 1 }] },
        { name: 'Boys 5K', evntNumber: '4', inputPort: null, splits: ['1K'] },
        { name: 'JV', splits: ['1K'] },
      ],
      outputs: [{ name: 'Karmarush', port: '6400', races: ['Girls 5K'] }, { name: 'No port' }, 7],
      filter: { tagWindowSec: '25', bogus: 1 },
    });
    assert.deepEqual(meet.races.map((r) => r.name), ['Girls 5K', 'Boys 5K', 'JV']);
    const g = meet.races[0];
    assert.deepEqual([g.eventNumber, g.round, g.heat, g.distance, g.inputPort, g.active], ['3', '1', '1', '5000', 17565, true]);
    assert.deepEqual(g.splits, [{ name: '1K', sources: [], earliest: '' }, { name: '2K', sources: ['2K-A', '2K-B'], earliest: '5:30' }, { name: '3K', sources: [], earliest: '' }]);
    assert.equal(meet.races[1].inputPort, null, 'null: by contest only');
    assert.ok(!('inputPort' in meet.races[2]), 'no inputPort: the first RR12 port (R11)');
    assert.ok(!('eventNumber' in meet.races[2]) && !('distance' in meet.races[2]));
    assert.deepEqual(meet.outputs, [{ name: 'Karmarush', port: 6400, races: ['Girls 5K'] }]);
    assert.deepEqual(meet.filter, { tagWindowSec: 25 });
    assert.deepEqual(meet.input, { ports: [17565] }, "every race's port is a port of the meet");
    assert.deepEqual(texts(notes), [
      'Race 1 in the file is not a race: it is left out.',
      'Race 2 has no name: it is left out.',
      '"No splits": its splits must be a list, so the race is left out.',
      '"Too many" has 21 splits. Split Relay takes at most 20, so the race is left out.',
      '"Blank split": split 2 has no name, so the race is left out. Give every split its name in the file.',
      'Output "No port" has no port: it is left out. Type its "port" in the file.',
      'Output 3 in the file is not an output: it is left out.',
      'The file has "foo", which Split Relay doesn\'t know: it was ignored.',
      '"Girls 5K" split 3 has "foo", which Split Relay doesn\'t know: it was ignored.',
      '2 races in the file have "evntNumber", which Split Relay doesn\'t know: it was ignored.',
      'The file\'s "filter" has "bogus", which Split Relay doesn\'t know: it was ignored.',
      'Gun times are never loaded from a file: type each gun on race day.',
    ]);
    assert.deepEqual(meet.leftOut, ['No splits', 'Too many', 'Blank split'], 'the races that could not be read, by name');
    assert.deepEqual(parseMeet(meet).meet, meet, 'idempotent: apply re-parses what the preview sent');
    assert.deepEqual(parseMeet(meet).notes, []);
  });

  test('looseKey: "Women\'s Race" is "Womens Race"', () => {
    assert.equal(looseKey("Women's Race"), looseKey('Womens Race'));
    assert.equal(looseKey('  womens   RACE '), 'womensrace');
    assert.equal(looseKey('Fémina'), 'femina');
    assert.equal(looseKey('...'), '');
  });

  test('meetSummary and meetPaths', () => {
    const c = setup({ outputs: [{ name: 'TrackScore', script: 'C:\\Lynx\\XCScore.lss' }] });
    const m = meetOf({ races: [{ name: 'A', splits: ['1K'] }], outputs: [{ name: 'TrackScore', port: 6555, script: 'C:\\Lynx\\XCScore.lss' }, { name: 'K', port: 6400, script: 'D:\\K.lss' }],
      names: { pplPath: 'D:\\Meet\\Lynx.ppl' }, lif: { inputDir: '\\\\TIMER\\Lynx\\Meet', outputDir: 'C:\\Merged' } });
    assert.deepEqual(meetSummary(m), { name: 'Fall Classic 2026', savedAt: null, savedOn: null, races: 1, outputs: 2 });
    assert.deepEqual(meetPaths(c, m), [{ path: 'D:\\Meet\\Lynx.ppl', kind: 'file' }, { path: '\\\\TIMER\\Lynx\\Meet', kind: 'dir' }, { path: 'D:\\K.lss', kind: 'file' }]);
  });
});

describe('planMeet into an empty setup', () => {
  test('everything is added: races (one Active per port), outputs by race name, ports added, the meet name; nothing deleted', () => {
    const file = meetOf({
      races: [girls({ inputPort: 17567 }), { ...girls(), name: 'JV Girls', eventNumber: '5', inputPort: 17567 }, boys({ inputPort: 17568 })],
      outputs: [{ name: 'TrackScore', port: 6555, races: ['Girls 5K'], enabled: true }, { name: 'Karmarush', port: 6400, host: '10.0.0.9' }],
      filter: { tagWindowSec: 25, holdSec: 0 },
    });
    const c = setup();
    const p = planMeet(c, file, { mode: 'file', now: NOW });
    assert.deepEqual(texts(p.added), [
      'RR12 input port 17567 (Girls 5K and JV Girls read from it)', 'RR12 input port 17568 (Boys 5K reads from it)',
      'Girls 5K · Event 3-1-1 · 3 splits: 1K, 2K, 3K · port 17567 · Active',
      'JV Girls · Event 5-1-1 · 3 splits: 1K, 2K, 3K · port 17567 · not Active',
      'Boys 5K · Event 4-1-1 · 2 splits: 1K, 3K · port 17568 · Active',
      'TrackScore · 127.0.0.1:6555 · on',
      'Karmarush · 10.0.0.9:6400 · switched off',
    ]);
    assert.deepEqual(texts(p.changed), ['Meet name: Fall Classic 2026 (was none)', 'Tag filter: window 25 s (was 10 s), hold 0 s (was 2 s)']);
    assert.ok(texts(p.attention).includes("JV Girls comes in not Active: port 17567 already feeds the Active race 'Girls 5K'. Press “Switch to JV Girls…” when it starts."));
    assert.ok(texts(p.attention).includes('TrackScore is added switched on: it sends Girls 5K only once a race has its gun time.'));
    assert.deepEqual(p.next.input.ports, [17565, 17566, 17567, 17568]);
    assert.equal(p.next.meet.name, 'Fall Classic 2026');
    const gid = p.next.races.find((r) => r.name === 'Girls 5K').id;
    assert.deepEqual(p.next.outputs.map((o) => [o.name, o.enabled, o.races]), [['TrackScore', true, [gid]], ['Karmarush', false, []]]);
    assert.ok(p.next.races.every((r) => r.gun === '' && r.splits.every((s) => s.sending)));
    assert.deepEqual([p.deleted, p.removed, p.nothing], [[], [], false]);
    // loaded again over itself: nothing changes and nothing is added twice
    const again = planMeet(p.next, file, { mode: 'file', now: NOW });
    assert.equal(again.nothing, true, JSON.stringify([again.added, again.changed]));
    assert.deepEqual(texts(again.kept), ['No change: Girls 5K, JV Girls, Boys 5K, TrackScore, Karmarush.']);
  });

  test('R11: a race with no inputPort takes the first RR12 port; an output with no "enabled" comes in off', () => {
    const p = planMeet(setup(), meetOf({ races: [{ name: 'Open', splits: ['1K'] }], outputs: [{ name: 'Board', port: 6600 }] }), { mode: 'file' });
    const r = p.next.races[0];
    assert.deepEqual([r.inputPort, r.active, r.contests], [17565, true, []]);
    assert.equal(p.next.outputs[0].enabled, false);
  });

  test('a port that is the control panel port, or more than 10 ports, is not added', () => {
    let p = planMeet(setup(), meetOf({ input: { ports: [17590, 17570] } }), { mode: 'file', panelPort: 17590 });
    assert.deepEqual(p.next.input.ports, [17565, 17566, 17570]);
    assert.ok(texts(p.attention).includes('The RR12 input port and the control panel port are both 17590. Use two different ports.'));
    p = planMeet(setup(), meetOf({ input: { ports: Array.from({ length: 9 }, (_, i) => 18000 + i) } }), { mode: 'file' });
    assert.deepEqual(p.next.input.ports, [17565, 17566]);
    assert.match(p.attention[0].text, /^The file needs RR12 ports 18000, .*18008; Split Relay listens on at most 10: they are not added\./);
  });
});

describe('matching a race: name and event must agree on one race (M4)', () => {
  test('by name; by event when the name differs (a file renames it); "Women\'s Race" is "Womens Race"', () => {
    const c = setup({ races: [girls(), boys()] });
    const ids = c.races.map((r) => r.id);
    let p = planMeet(c, meetOf({ races: [girls({ distance: '5K' })] }), { mode: 'file' });
    assert.deepEqual(texts(p.changed), ['Meet name: Fall Classic 2026 (was none)', 'Girls 5K: distance 5K (was none)']);
    p = planMeet(c, meetOf({ races: [girls({ name: 'Girls Varsity' })] }), { mode: 'file' });
    assert.ok(texts(p.changed).includes('Girls 5K: name "Girls Varsity" (was "Girls 5K")'));
    assert.deepEqual(p.next.races.map((r) => r.id), ids, 'the id is kept');
    const w = setup({ races: [{ name: 'Womens Race', eventNumber: '2', splits: [{ name: '1K' }] }] });
    p = planMeet(w, meetOf({ races: [{ name: "Women's Race", eventNumber: '2', splits: ['1K'] }] }), { mode: 'trackscore' });
    assert.equal(p.next.races.length, 1);
    assert.deepEqual(p.next.races[0].name, 'Womens Race', 'Set up from TrackScore never renames: FinishLynx\'s name stays');
  });

  test('conflicts are left out and said: name and event on two races, a name that fits two races, two in the file on one race', () => {
    const c = setup({ races: [girls(), boys(), { name: 'Race A', eventNumber: '7', splits: [{ name: '1K' }], active: false }, { name: 'Race-A', eventNumber: '8', splits: [{ name: '1K' }], active: false }] });
    const p = planMeet(c, meetOf({ races: [
      girls({ eventNumber: '4' }),
      { name: 'Race a', splits: ['1K'] },
      { name: 'Boys 5K', eventNumber: '4', splits: ['1K', '3K'] },
      { name: 'Boys5k', splits: ['1K', '3K'] },
    ] }), { mode: 'file' });
    assert.deepEqual(texts(p.attention.filter((a) => a.tone === 'bad')), [
      '"Girls 5K" in the file is Event 4-1-1, but here "Girls 5K" is Event 3-1-1 and Event 4-1-1 is "Boys 5K". It is left out: fix the name or the event of one of them, then load again.',
      '"Race a" in the file fits 2 races here ("Race A", "Race-A"). It is left out: rename one of them, then load again.',
      '"Boys 5K" in the file and "Boys5k" both fit "Boys 5K" here: "Boys5k" is left out.',
    ]);
    assert.equal(p.next.races.length, 4, 'nothing added for a conflict');
    assert.deepEqual(p.removable, [], 'a race in a conflict is never offered for removal');
  });

  test('TrackScore: a name match whose event numbers differ is a conflict, not a guess', () => {
    const c = setup({ races: [{ name: 'Womens Race', eventNumber: '3', splits: [{ name: '1K' }] }] });
    const p = planMeet(c, meetOf({ races: [{ name: "Women's Race", eventNumber: '2', splits: ['1K', '2K'] }] }), { mode: 'trackscore' });
    assert.deepEqual(texts(p.attention), ['TrackScore\'s "Women\'s Race" is event 2, but Split Relay\'s "Womens Race" is Event 3-1-1. It is left out: make the event numbers agree (FinishLynx\'s is the right one), then set up again.']);
    assert.equal(p.next.races.length, 1);
  });

  test('R9: TrackScore matched on the event alone says which race it changes', () => {
    const c = setup({ races: [{ name: 'JV Boys', eventNumber: '3', splits: [{ name: '1K' }] }] });
    const p = planMeet(c, meetOf({ races: [{ name: 'Varsity Girls', eventNumber: '3', splits: ['1K', '2K'] }] }), { mode: 'trackscore' });
    assert.ok(texts(p.attention).includes('TrackScore\'s "Varsity Girls" (event 3) is set up on "JV Boys" here (event 3): its splits change, its name stays.'));
    assert.deepEqual([p.next.races[0].name, p.next.races[0].splits.length], ['JV Boys', 2]);
  });
});

describe('a race in use changes only its split names (R3)', () => {
  // matched on its event (3-1-1): the name differs too
  const file = meetOf({ races: [girls({ name: 'Girls Varsity', distance: '6000m', inputPort: 17566,
    splits: [{ name: '1k' }, { name: '2.5K', sources: ['2K-A'], earliest: '6:00' }, { name: 'Three K' }] })] });

  for (const [what, ctxOf, gun] of [
    ['reads', (c) => inUse(c, 'Girls 5K')],
    ['a gun only', () => new Map(), '10:00:00.000'],
    ['reads waiting for it', (c) => inUse(c, 'Girls 5K', { waiting: 3 })],
  ]) {
    test(`with ${what}`, () => {
      const c = setup({ races: [girls({ active: false, ...(gun ? { gun } : {}) })] });
      c.races[0].splits[2].sending = false;
      c.races[0].splits[0].sources = ['1K-A'];
      const before = structuredClone(c.races[0]);
      const p = planMeet(c, file, { mode: 'file', races: ctxOf(c) });
      const r = p.next.races[0];
      assert.deepEqual([r.id, r.name, r.distance, r.eventNumber, r.inputPort, r.gun, r.active], [before.id, 'Girls 5K', '', '3', 17565, before.gun, false]);
      assert.deepEqual(r.splits, [
        { ...before.splits[0], name: '1k' },
        { ...before.splits[1], name: '2.5K' },
        { ...before.splits[2], name: 'Three K' },
      ], 'complete splits: ids, timing points, earliest times and Pause kept; the names are the file\'s, exactly');
      assert.deepEqual(texts(p.changed).filter((t) => t.startsWith('Girls')), ['Girls 5K: split 2 2K → 2.5K, split 3 3K → Three K; split names written as in the file: 1k']);
      const why = gun && what === 'a gun only' ? 'has its gun time' : what === 'reads' ? 'has reads' : 'has reads waiting for it';
      // a race that is not Active, with a gun and no reads: the gun may be an earlier day's
      const stale = what === 'a gun only' ? " If its gun time 10:00:00.000 is an earlier day's, clear it on the race's page, then load again: the rest changes too." : '';
      assert.deepEqual(texts(p.attention.filter((a) => a.raceId)), [`Girls 5K ${why}, so these stay as they are: name "Girls Varsity" in the file, ` +
        'distance 6000m in the file, timing points, earliest times, RR12 port (17565 here, 17566 in the file). ' +
        `Change them on the race's page: it asks first.${stale}`,
      // O10: matched on its event alone: said
      '"Girls Varsity" in the file is loaded onto "Girls 5K" here: the same event (3-1-1), another name. Its name stays "Girls 5K".']);
    });
  }

  test('matched on its name, its event stays', () => {
    const c = setup({ races: [girls()] });
    const p = planMeet(c, meetOf({ races: [girls({ eventNumber: '9' })] }), { mode: 'file', races: inUse(c, 'Girls 5K') });
    assert.equal(p.next.races[0].eventNumber, '3');
    assert.ok(texts(p.attention).includes("Girls 5K has reads, so these stay as they are: event (3-1-1 here, 9-1-1 in the file). Change them on the race's page: it asks first."));
  });

  test('a different number of splits is held, and so are its names; the line says the columns are off', () => {
    const c = setup({ races: [girls()] });
    const p = planMeet(c, meetOf({ races: [girls({ splits: ['1K', '1.5K', '2K', '3K'] })] }), { mode: 'trackscore', races: inUse(c, 'Girls 5K') });
    assert.deepEqual(p.next.races[0].splits, c.races[0].splits);
    assert.ok(texts(p.attention).includes("Girls 5K has reads, so these stay as they are: the number of splits and their names (3 here: 1K, 2K, 3K; 4 in TrackScore: 1K, 1.5K, 2K, 3K). Change them on the race's page: it asks first. " +
      "Until the numbers of splits agree, TrackScore puts this race's splits in the wrong columns."));
    assert.deepEqual(texts(p.kept), ['Girls 5K keeps its 40 reads.']);
  });
});

describe('a race not in use (M5)', () => {
  test('7 -> 8 splits keeps the first splits\' ids and Pause; the event changes; gun and Active stay', () => {
    const c = setup({ races: [boys({ active: false, splits: [{ name: '1K' }, { name: '2K' }] })] });
    c.races[0].splits[1].sending = false;
    const before = c.races[0];
    const p = planMeet(c, meetOf({ races: [{ name: 'Boys 5K', eventNumber: '6', splits: ['1K', '2K', '3K'] }] }), { mode: 'file' });
    const r = p.next.races[0];
    assert.deepEqual(r.splits.slice(0, 2).map((s) => [s.id, s.sending]), [[before.splits[0].id, true], [before.splits[1].id, false]]);
    assert.ok(r.splits[2].id && !before.splits.some((s) => s.id === r.splits[2].id));
    assert.deepEqual([r.eventNumber, r.active, r.gun, r.id], ['6', false, '', before.id]);
    assert.ok(texts(p.changed).includes('Boys 5K: 3 splits: 1K, 2K, 3K (was 2: 1K, 2K); Event 6-1-1 (was 4-1-1)'));
  });

  test('R4: a split point inserted in TrackScore takes no other split\'s timing points or earliest time', () => {
    const c = setup({ races: [girls({ splits: [{ name: '1K', sources: ['1K-A'], earliest: '3:00' }, { name: '2K', sources: ['2K-A'], earliest: '6:00' },
      { name: '3K', sources: ['3K-A'], earliest: '9:00' }] })] });
    const old = c.races[0].splits;
    const p = planMeet(c, meetOf({ name: '', races: [{ name: 'Girls 5K', eventNumber: '3', splits: ['1K', '1.5K', '2K', '3K'] }] }), { mode: 'trackscore' });
    assert.deepEqual(p.next.races[0].splits.map((s) => [s.name, s.sources, s.earliest, old.find((o) => o.id === s.id)?.name ?? 'new']), [
      ['1K', ['1K-A'], '3:00', '1K'], ['1.5K', [], '', 'new'], ['2K', ['2K-A'], '6:00', '2K'], ['3K', ['3K-A'], '9:00', '3K'],
    ]);
    assert.deepEqual(texts(p.changed), ['Girls 5K: 4 splits: 1K, 1.5K, 2K, 3K (was 3: 1K, 2K, 3K); timing points and earliest times cleared on 1.5K']);
  });
});

describe('settings while races have reads (R4, R7)', () => {
  const file = meetOf({ filter: { tagWindowSec: 25, holdSec: 0 }, lif: { enabled: true, inputDir: 'C:\\Lynx\\Meet', outputDir: 'C:\\Lynx\\Merged' },
    input: { delimiter: ';' }, names: { pplPath: 'C:\\Lynx\\New.ppl' } });

  test('no reads: all of it is set', () => {
    const p = planMeet(setup({ races: [girls()] }), file, { mode: 'file' });
    assert.deepEqual(texts(p.changed), ['Meet name: Fall Classic 2026 (was none)', 'RR12 SR line format (advanced)', 'Tag filter: window 25 s (was 10 s), hold 0 s (was 2 s)',
      'Merged .lif files: on; FinishLynx folder C:\\Lynx\\Meet; merged folder C:\\Lynx\\Merged (was off)', 'Names file: C:\\Lynx\\New.ppl (was none)']);
    // R15: the folder and the names file from a file are checked
    assert.ok(texts(p.attention).some((t) => t.startsWith("The FinishLynx folder C:\\Lynx\\Meet comes from the meet file: make sure it is this meet's.")));
    assert.ok(texts(p.attention).includes("The names file C:\\Lynx\\New.ppl comes from the meet file: make sure it is this meet's."));
  });

  test('a race in use: the tag filter and the .lif settings stay; the names file is filled in only where none is chosen', () => {
    const c = setup({ races: [girls()] });
    let p = planMeet(c, file, { mode: 'file', races: inUse(c, 'Girls 5K') });
    assert.deepEqual(texts(p.changed), ['Meet name: Fall Classic 2026 (was none)', 'Names file: C:\\Lynx\\New.ppl (was none)']);
    assert.ok(texts(p.attention).includes('Girls 5K has reads, so the tag filter stays as it is (here: window 10 s, hold 2 s, start 60 s; in the file: 25 s, 0 s, 60 s). Change it in Settings if you mean to.'));
    assert.ok(texts(p.attention).some((t) => /^Girls 5K has reads, so the merged \.lif settings stay as they are \(here: off; in the file: on;/.test(t)));
    assert.ok(texts(p.attention).includes('Girls 5K has reads, so the RR12 SR line format stays as it is: changed now, the lines coming in would be bad lines. Change it on the Inputs page if you mean to.'));
    const named = updateSettings(c, { names: { pplPath: 'C:\\Lynx\\Old.ppl' } });
    p = planMeet(named, file, { mode: 'file', races: inUse(named, 'Girls 5K') });
    assert.ok(texts(p.attention).includes('The names file stays C:\\Lynx\\Old.ppl (the file has C:\\Lynx\\New.ppl). Choose it in Settings if you mean to.'));
  });

  test('R7: reads in no race hold only the SR line format, worded by why', () => {
    const p = planMeet(setup(), file, { mode: 'file', noRaceReads: 37 });
    assert.ok(texts(p.changed).includes('Tag filter: window 25 s (was 10 s), hold 0 s (was 2 s)'));
    assert.ok(texts(p.attention).includes('Split Relay has 37 reads in no race, so the RR12 SR line format stays as it is: changed now, the lines coming in would be bad lines. Change it on the Inputs page if you mean to.'));
    const q = planMeet(setup(), file, { mode: 'file', connections: 1 });
    assert.ok(texts(q.attention).some((t) => t.startsWith('RR12 is connected, so the RR12 SR line format stays')));
  });

  test('paths not on this PC: set where nothing is set, kept otherwise, said both ways; another PC said', () => {
    const paths = new Map([['C:\\Lynx\\New.ppl', 'no'], ['C:\\Lynx\\Meet', 'unknown']]);
    let p = planMeet(setup(), file, { mode: 'file', paths });
    assert.equal(p.next.names.pplPath, 'C:\\Lynx\\New.ppl');
    assert.ok(texts(p.attention).includes('The names file C:\\Lynx\\New.ppl is not on this PC. It is set anyway: choose the right one in Settings.'));
    assert.ok(texts(p.attention).includes("Split Relay couldn't check C:\\Lynx\\Meet (no answer in 1.5 s). It is set anyway: choose the right one in Settings."));
    const set = updateSettings(setup(), { names: { pplPath: 'C:\\Lynx\\Old.ppl' }, lif: { inputDir: 'C:\\Lynx\\Here', outputDir: 'C:\\Merged' } });
    p = planMeet(set, { ...file, savedOn: 'TIMING-2' }, { mode: 'file', paths, thisPc: 'TIMING-1' });
    assert.deepEqual([p.next.names.pplPath, p.next.lif.inputDir], ['C:\\Lynx\\Old.ppl', 'C:\\Lynx\\Here']);
    assert.ok(texts(p.attention).includes('The names file C:\\Lynx\\New.ppl is not on this PC. C:\\Lynx\\Old.ppl stays.'));
    assert.ok(texts(p.attention).includes("Split Relay couldn't check C:\\Lynx\\Meet (no answer in 1.5 s). C:\\Lynx\\Here stays, and so do the other merged .lif settings."));
    assert.ok(texts(p.attention).includes('Saved on TIMING-2: the paths in it are checked on this PC.'));
  });
});

describe('outputs (M5)', () => {
  const ts = { name: 'TrackScore', host: '127.0.0.1', port: 6555, script: 'C:\\Lynx\\XCScore.lss' };

  test('matched by name keeps its id; by address when the name differs; changes are Checks with their effect', () => {
    const c = setup({ races: [girls()], outputs: [ts] });
    const id = c.outputs[0].id;
    let p = planMeet(c, meetOf({ outputs: [{ ...ts, enabled: true, port: 6556, races: ['Girls 5K'] }] }), { mode: 'file' });
    assert.equal(p.next.outputs[0].id, id);
    assert.deepEqual(texts(p.changed).slice(1), ['TrackScore: switched on (was off); port 6556 (was 6555); races Girls 5K (was all)']);
    assert.deepEqual(texts(p.attention), [
      'TrackScore is switched on by this load: it sends Girls 5K only once a race has its gun time.',
      'TrackScore sends to 127.0.0.1:6556 from now on (was 127.0.0.1:6555).',
      'TrackScore sends Girls 5K only from now on (was every race).',
    ]);
    p = planMeet(c, meetOf({ outputs: [{ ...ts, name: 'TS', stage: 'started' }] }), { mode: 'file' });
    assert.deepEqual([p.next.outputs.length, p.next.outputs[0].id, p.next.outputs[0].name], [1, id, 'TS']);
  });

  test('R2: from the gun on (no split yet) an output stays exactly as it is; a new output on the running race comes in off', () => {
    const c = setup({ races: [girls({ gun: '10:00:00.000' })], outputs: [ts] });
    // 10:05: five minutes after the gun, before its first split
    const p = planMeet(c, meetOf({ outputs: [{ ...ts, enabled: true, port: 5556 }, { name: 'Karmarush', port: 6400, enabled: true }] }), { mode: 'file', now: new Date(2026, 9, 21, 10, 5).getTime() });
    assert.deepEqual(p.next.outputs[0], c.outputs[0]);
    assert.deepEqual(p.next.outputs[1].enabled, false);
    assert.deepEqual(texts(p.attention), [
      'Girls 5K is running, so TrackScore stays as it is (in the file: switched on, port 5556). Change it in Outputs when the race is over.',
      "Karmarush comes in switched off: switched on now, it would send Girls 5K's splits from now on. Switch it on in Outputs when you mean to.",
    ]);
  });

  test('R2: an output that has been sent splits keeps its address', () => {
    const c = setup({ races: [girls()], outputs: [ts] });
    const p = planMeet(c, meetOf({ outputs: [{ ...ts, port: 5555, precision: 2 }] }), { mode: 'file', sentTo: new Map([[c.outputs[0].id, 412]]) });
    assert.deepEqual([p.next.outputs[0].port, p.next.outputs[0].precision], [6555, 2]);
    assert.ok(texts(p.attention).includes('TrackScore stays at 127.0.0.1:6555: Split Relay has sent it 412 splits. Change the address in Outputs, then Resend.'));
  });

  test('race names it does not know: switched off with no race chosen; some known: the others left out; "(deleted race)" is no change', () => {
    const c = setup({ races: [girls()], outputs: [{ ...ts, name: 'Board', port: 6900 }] });
    const p = planMeet(c, meetOf({ outputs: [
      { name: 'Karmarush', port: 6400, enabled: true, races: ['JV Race'] },
      { name: 'Live', port: 6401, races: ['Girls 5K', 'JV Race'] },
      { name: 'Board', port: 6900, host: '127.0.0.1', races: [DELETED_RACE] },
    ] }), { mode: 'file' });
    const g = p.next.races[0].id;
    assert.deepEqual(p.next.outputs.map((o) => [o.name, o.enabled, o.races]), [['Board', false, []], ['Karmarush', false, []], ['Live', false, [g]]]);
    assert.deepEqual(texts(p.attention), [
      'Karmarush lists races that are not in this setup (JV Race): it comes in switched off with no race chosen. Choose its races in Outputs before you switch it on.',
      'Live\'s race "JV Race" is not in this setup: it is left out of its list.',
    ]);
    assert.ok(texts(p.kept).includes('No change: Board.'));
  });

  test('R10: a MID from the file is always checked; R11: an output with no port never comes in', () => {
    const p = planMeet(setup(), meetOf({ savedAt: '2026-10-14T15:02:00.000Z', outputs: [{ name: 'Karmarush', port: 6400, mid: '8132' }] }), { mode: 'file', now: NOW });
    assert.ok(texts(p.attention).includes("Karmarush meet number 8132 comes from the file (saved Wed 14 Oct): make sure it is this meet's."));
    assert.equal(parseMeet({ splitRelayMeet: 1, outputs: [{ name: 'TrackScore', enabled: true }] }).meet.outputs.length, 0);
  });

  test('outputs not in the file stay', () => {
    const p = planMeet(setup({ outputs: [ts] }), meetOf({ races: [girls()] }), { mode: 'file' });
    assert.ok(texts(p.kept).includes('TrackScore is not in the file: it stays.'));
  });
});

describe('removals are opt-in (R1)', () => {
  test('only races with nothing in them are offered; removing them trims the outputs\' lists as Delete does', () => {
    let c = setup({ races: [girls(), boys(), { name: 'JV', eventNumber: '8', splits: [{ name: '1K' }], inputPort: 17565, active: false }] });
    const [, b, jv] = c.races;
    c = addOutput(c, { name: 'TS', port: 6555, enabled: false, races: [b.id, jv.id] }).config;
    const file = meetOf({ races: [girls()] });
    let p = planMeet(c, file, { mode: 'file', races: inUse(c, 'Boys 5K') });
    assert.deepEqual(p.removable, [{ id: jv.id, name: 'JV' }]);
    assert.deepEqual(texts(p.kept), ['Boys 5K is not in the file: it stays.', 'JV is not in the file: it stays.', 'TS is not in the file: it stays.', 'No change: Girls 5K.']);
    p = planMeet(c, file, { mode: 'file', races: inUse(c, 'Boys 5K'), removeOthers: true });
    assert.deepEqual([p.deleted, texts(p.removed)], [[jv.id], ['JV is removed (it has no reads).']]);
    assert.deepEqual(p.next.outputs[0].races, [b.id]);
    assert.deepEqual(p.next.races.map((r) => r.name), ['Girls 5K', 'Boys 5K']);
  });
});

describe('Set up from TrackScore (M8)', () => {
  const ts = (schedule = TS_SCHEDULE, raceSnap = TS_RACE) => trackScoreToMeet({ raceSnap, schedule, meetId: 'meet-fixture-1', host: '127.0.0.1', port: 5000 });

  test('the live meet: event numbers, distances, and every split point named and counted as TrackScore has them; no gun', () => {
    const { meet, notes, source } = ts();
    assert.deepEqual(meet.races.map((r) => [r.name, r.eventNumber, r.round, r.heat, r.distance, r.splits.map((s) => s.name), r.trackScore.live]), [
      ["Men's Race", '1', '1', '1', '8K', ['800M', '1500M', '2500M', '3500M', '4500M', '5500M', '6400M', '7100M'], false],
      ["Women's Race", '2', '1', '1', '6K', ['800M', '1500M', '2400M', '3100M', '4200M', '4500M', '5400M'], true],
    ]);
    assert.ok(!JSON.stringify(meet).includes('gun') && !JSON.stringify(meet).includes('9:30'));
    assert.deepEqual(notes, []);
    assert.deepEqual(source, { kind: 'trackscore', host: '127.0.0.1', port: 5000, meetId: 'meet-fixture-1', meetName: '', liveRace: "Women's Race", confirmed: true, outputName: null, races: 2 });
  });

  test('worked example (9.3.9): on the race-day settings only split names and a distance change; nothing is sent', () => {
    const c = liveConfig();
    const { meet, notes } = ts();
    const p = planMeet(c, parseMeet(meet).meet, { mode: 'trackscore', notes, races: new Map([['r_4137246fdc', { reads: 412, crossings: 300 }]]) });
    // O4: every split name as TrackScore writes it, not half one way and half the other
    assert.deepEqual(texts(p.changed), ['Mens Race: distance 8K (was none); split names written as in TrackScore: 800M, 1500M, 2500M, 3500M, 4500M, 5500M, 6400M, 7100M',
      'Womens Race: split 6 4400m → 4500M, split 7 5300m → 5400M; split names written as in TrackScore: 800M, 1500M, 2400M, 3100M, 4200M']);
    assert.deepEqual(texts(p.kept), ['Womens Race keeps its 412 reads and its gun 16:28:00.455.']);
    assert.deepEqual([p.added, p.attention, p.removed, p.removable], [[], [], [], []]);
    const [w, m] = p.next.races;
    assert.deepEqual([w.id, w.gun, w.active, w.inputPort, m.active, m.gun], ['r_4137246fdc', '16:28:00.455', true, 5565, false, '']);
    assert.deepEqual(w.splits.map((s) => s.id), c.races[0].splits.map((s) => s.id));
    assert.deepEqual(p.next.outputs, c.outputs);
  });

  test('new races: the live race Active first; the TrackScore output that sends one race says the new ones are not sent', () => {
    const c = setup({ outputs: [{ name: 'TrackScore', port: 6555, script: 'C:\\Lynx\\XCScore.lss' }] });
    const c2 = addRace(c, { name: 'Other', eventNumber: '9', splits: [{ name: '1K' }], active: false }).config;
    c2.outputs[0].races = [c2.races[0].id];
    const p = planMeet(c2, ts().meet, { mode: 'trackscore' });
    assert.deepEqual(p.next.races.map((r) => [r.name, r.active]), [['Other', false], ["Men's Race", false], ["Women's Race", true]]);
    assert.ok(texts(p.attention).includes("Men's Race comes in not Active: port 17565 already feeds the Active race 'Women's Race'. Press “Switch to Men's Race…” when it starts."));
    assert.ok(texts(p.attention).includes("Men's Race and Women's Race take TrackScore's names. Each must be exactly FinishLynx's event name: rename them on their page if not."));
    assert.ok(texts(p.attention).includes('The output TrackScore sends only Other: the new races are not sent to it until you add them in Outputs.'));
    assert.deepEqual(texts(p.kept), ['Other is not in TrackScore\'s meet: it stays.']);
  });

  test('G1-G8, G12, G15, RTRT and "003"', () => {
    const point = (label, distance = label, extra = {}) => ({ label, distance, ...extra });
    const r = (id, name, en, points, extra = {}) => ({ id, name, filterEventNumber: en, finishDistance: '5K', splitPoints: points, status: 'upcoming', ...extra });
    const { meet, notes, source } = ts({
      races: [
        r('a', 'Hidden', '003', [point('1K'), point('2K', '2K', { hidden: true })]),
        r('b', 'Twins', '4', [point('1K', '1000M'), point('1K', '1500M'), point('1K', '1500M')]),
        r('c', 'Open Race', '5', []),
        r('d', 'No event', '0', [point('1K')]),
        r('e', 'Same event', '3', [point('1K')]),
        r('f', 'Big', '7', Array.from({ length: 24 }, (_, i) => point(`${i}K`))),
        r('g', 'RTRT', '8', [point('1K')], { rtrtCategory: 'elite' }),
        r('h', 'Watched', '9', [point('1K')], { watchFile: 'C:\\Lynx\\009-1-01.lif' }),
        r('i', 'Live', '10', [point('1K'), point('2K')]),
      ],
      activeRaceId: 'i', lynxDir: 'C:\\Lynx\\Meet', autoSwitch: false,
    }, { meetId: 'x', config: { totalSplits: 3, filterEventNumber: '11', scheduledRaceId: 'i' } });
    assert.deepEqual(meet.races.map((x) => [x.name, x.eventNumber, x.splits.map((s) => s.name)]), [
      ['Hidden', '3', ['1K', '2K']], ['Twins', '4', ['1K', '1K (1500M)', '1K (2)']], ['No event', '', ['1K']],
      ['Watched', '9', ['1K']], ['Live', '10', ['1K', '2K']],
    ]);
    assert.deepEqual(texts(notes), [
      '"Hidden" has 1 split point hidden on TrackScore\'s boards: it is still a split, and Split Relay sends it.',
      '"Twins" has two split points called "1K": here they are "1K" and "1K (1500M)". Check TrackScore Race Setup: two points at one place can\'t be told apart.',
      '"Twins" has two split points called "1K": here they are "1K" and "1K (2)". Check TrackScore Race Setup: two points at one place can\'t be told apart.',
      'TrackScore\'s "Open Race" has no split points: it is left out. Add its split points in TrackScore Race Setup, then set up again.',
      'TrackScore\'s "No event" has no event number: it comes in without one and not Active. Type FinishLynx\'s event number in TrackScore Race Setup and on the race here.',
      'TrackScore\'s "Hidden" and "Same event" both use event 3: "Same event" is left out. Give each race its own event number in TrackScore Race Setup.',
      'TrackScore\'s "Big" has 24 split points; Split Relay takes at most 20: it is left out.',
      'TrackScore\'s "RTRT" takes its splits from RTRT.me: it is left out.',
      'TrackScore\'s "Watched" reads a results file: it ignores the live splits while it does.',
      'TrackScore\'s boards run "Live" with 3 splits, but its Race Setup has 2. Splits are filed by 3 until the race is played again in TrackScore.',
      'TrackScore\'s boards run "Live" with event 11, but its Race Setup has event 10. Splits are filed by the boards\' event until the race is played again in TrackScore.',
      'TrackScore reads results from a folder for this meet (C:\\Lynx\\Meet): while it does, it ignores the live splits on port 5555.',
      'TrackScore\'s "Follow FinishLynx" is off: it won\'t switch to a race on Split Relay\'s splits. Press Play in TrackScore for each race.',
    ]);
    assert.equal(source.liveRace, 'Live');
    // a race with no event number never comes in Active
    const p = planMeet(setup(), meet, { mode: 'trackscore' });
    assert.deepEqual(p.next.races.map((x) => [x.name, x.active]), [['Hidden', false], ['Twins', false], ['No event', false], ['Watched', false], ['Live', true]]);
    assert.ok(texts(p.attention).includes('No event comes in not Active: it has no event number.'));
    // G15 (O14): TrackScore's boards show a race that is not in the list it sent for its meet: another meet's list
    let g = ts({ races: TS_SCHEDULE.races, activeRaceId: null }, { meetId: 'x', config: { scheduledRaceId: 'elsewhere', raceName: 'Varsity' } });
    assert.deepEqual(g.notes.map((n) => [n.tone, n.text]), [['bad', 'TrackScore\'s boards show "Varsity", which is not in the races TrackScore sent for its meet: ' +
      "these may be another meet's races. Check every race below against TrackScore's Race Setup before you press Apply."]]);
    assert.equal(g.source.confirmed, false);
    // ...or no race at all
    g = trackScoreToMeet({ raceSnap: { meetId: 'x', config: {} }, schedule: { races: TS_SCHEDULE.races }, meetName: 'Fall Classic' });
    assert.deepEqual(g.notes.map((n) => [n.tone, n.text]), [['warn', 'TrackScore is not showing a race of its meet "Fall Classic" now, so Split Relay can\'t tell it is this meet. ' +
      "Check the races below are this meet's before you press Apply."]]);
  });

  test('the old meet-less list is a different meet: nothing of it is used here', () => {
    // readTrackScore never passes it on (test/trackscore.test.js); planned anyway, it would bring other races
    assert.notDeepEqual(ts(TS_OLD).meet.races.map((r) => r.splits.length), ts().meet.races.map((r) => r.splits.length));
  });

  test('trackScoreHost: the TrackScore output, else one on 5555, never Karmarush or a server; localhost is 127.0.0.1', () => {
    const o = (name, extra = {}) => ({ id: name, name, mode: 'tcp-client', host: '192.168.0.9', port: 6000, script: '', mid: '', ...extra });
    assert.deepEqual(trackScoreHost({ outputs: [] }), { host: '127.0.0.1', outputName: null, outputId: null, outputPort: null });
    assert.equal(trackScoreHost({ outputs: [o('Karmarush', { script: 'C:\\Lynx\\Karmarush-Track.lss', port: 5555 }), o('TS board', { script: 'C:\\Lynx\\XCScore.lss' })] }).outputName, 'TS board');
    assert.equal(trackScoreHost({ outputs: [o('A', { port: 5555, host: 'localhost' })] }).host, '127.0.0.1');
    assert.equal(trackScoreHost({ outputs: [o('TrackScore', { mode: 'tcp-server' })] }).outputName, null);
    assert.equal(trackScoreHost({ outputs: [o('TrackScore', { mid: '8132' })] }).outputName, null);
  });

  test('item words', () => {
    assert.equal(raceSummary({ name: 'X', eventNumber: '', splits: [], inputPort: null, active: false, distance: '' }), 'X · no event · no splits · by contest only · not Active');
    assert.equal(outputSummary({ name: 'S', mode: 'tcp-server', port: 4001, enabled: true }), 'S · listens on port 4001 · on');
  });
});

// ---- what the checkers found on the first build (DESIGN 9.22, O2-O31) ---------------------------------------------

describe('a load keeps its rules on a hand-edited file, another meet, and a gun from an earlier day', () => {
  const at = (h, m) => new Date(2026, 9, 21, h, m).getTime();
  const ts = { name: 'TrackScore', host: '127.0.0.1', port: 6555, script: 'C:\\Lynx\\XCScore.lss' };

  test('raceRunning: Active with a gun, and its clock under 30 minutes or a read in the last 20; an earlier day\'s gun is not', () => {
    const r = { active: true, gun: '12:59:30.000' };
    assert.equal(raceRunning(r, null, at(13, 0)), true, 'a gun typed 30 s ago, before the first read (O19)');
    assert.equal(raceRunning(r, null, at(13, 40)), false);
    assert.equal(raceRunning(r, at(13, 30), at(13, 40)), true, 'reads keep arriving');
    assert.equal(raceRunning({ active: true, gun: '16:28:00.455' }, null, at(12, 55)), false, "a gun later in the day than now: an earlier day's (O8)");
    assert.equal(raceRunning({ ...r, active: false }, null, at(13, 0)), false);
    assert.equal(raceRunning({ active: true, gun: '' }, at(12, 59), at(13, 0)), false);
    assert.equal(raceClockMs({ gun: '12:59:30.000' }, at(13, 0)), 30_000);
  });

  test('O8: a gun left from an earlier day, with no reads, holds back neither the settings nor the outputs; a running one does', () => {
    const c = setup({ races: [girls({ gun: '16:28:00.455' })], outputs: [ts] });
    const file = meetOf({ outputs: [{ ...ts, enabled: true }, { name: 'Karmarush', port: 6400, enabled: true }], filter: { tagWindowSec: 25 },
      races: [girls({ splits: ['1K', '2K', '3K', '4K'] })] });
    // the next morning: the gun is later in the day than now
    let p = planMeet(c, file, { mode: 'file', now: at(9, 0) });
    assert.deepEqual(p.next.outputs.map((o) => [o.name, o.enabled]), [['TrackScore', true], ['Karmarush', true]]);
    assert.ok(texts(p.changed).includes('Tag filter: window 25 s (was 10 s)'));
    assert.ok(texts(p.attention).some((t) => t.startsWith('Girls 5K has its gun time, so these stay as they are: the number of splits') &&
      t.endsWith(" If its gun time 16:28:00.455 is an earlier day's, clear it on the race's page, then load again: the rest changes too.")), texts(p.attention).join('\n'));
    // five minutes after that gun: the race runs, and all of it is held
    p = planMeet(c, file, { mode: 'file', now: at(16, 33) });
    assert.deepEqual(p.next.outputs.map((o) => [o.name, o.enabled]), [['TrackScore', false], ['Karmarush', false]]);
    assert.ok(texts(p.attention).some((t) => t.startsWith('Girls 5K has its gun time, so the tag filter stays as it is')));
    assert.ok(texts(p.attention).some((t) => t.startsWith('Girls 5K is running, so TrackScore stays as it is')));
    // yesterday's splits behind that gun: held too (an output switched on would send them at once), and said so
    p = planMeet(c, file, { mode: 'file', now: at(9, 0), races: inUse(c, 'Girls 5K') });
    assert.ok(texts(p.attention).some((t) => t.startsWith('Girls 5K has its gun time and reads, so TrackScore stays as it is')));
    assert.deepEqual(p.next.outputs.map((o) => [o.name, o.enabled]), [['TrackScore', false], ['Karmarush', false]]);
  });

  test('O9: split names in another order are held on a race with reads, and a Check on one without', () => {
    const c = setup({ races: [girls()] });
    const file = meetOf({ races: [girls({ splits: ['2K', '1K', '3K'] })] });
    let p = planMeet(c, file, { mode: 'file', races: inUse(c, 'Girls 5K') });
    assert.deepEqual(p.next.races[0].splits.map((s) => s.name), ['1K', '2K', '3K']);
    assert.ok(texts(p.attention).includes('Girls 5K has reads, so these stay as they are: the split names (in the file they are in another order: 2K, 1K, 3K; ' +
      "its reads would show under the wrong names). Change them on the race's page: it asks first."));
    assert.ok(!texts(p.changed).some((t) => t.startsWith('Girls 5K')));
    p = planMeet(c, file, { mode: 'file' });
    assert.deepEqual(p.next.races[0].splits.map((s) => s.name), ['2K', '1K', '3K']);
    assert.ok(texts(p.attention).includes('"Girls 5K" in the file has the split names in another order (2K, 1K, 3K; here 1K, 2K, 3K): check the file. ' +
      'Split 1 is always the first pass over the mats.'));
  });

  test('O10/O30: a race matched on its event alone, and an output matched on its address, are Checks that name both', () => {
    const c = setup({ races: [{ name: 'JV Race', eventNumber: '3', splits: [{ name: '1K' }, { name: '2K' }], active: false }],
      outputs: [{ name: 'Late Out', port: 6904, script: 'C:\\Lynx\\XCScore.lss' }] });
    const p = planMeet(c, meetOf({ races: [{ name: 'Varsity Boys', eventNumber: '3', splits: ['1K', '2K'] }],
      outputs: [{ name: 'Karmarush', port: 6904, host: '127.0.0.1', script: 'C:\\Lynx\\Karmarush-Track.lss' }] }), { mode: 'file' });
    assert.equal(p.next.races[0].name, 'Varsity Boys');
    assert.ok(texts(p.attention).includes('"Varsity Boys" in the file is loaded onto "JV Race" here: the same event (3-1-1), another name. ' +
      'Its name becomes "Varsity Boys": it must be exactly FinishLynx\'s event name.'));
    assert.ok(texts(p.attention).includes('Output "Karmarush" in the file is loaded onto "Late Out" here: the same address (127.0.0.1:6904), another name. ' +
      'Its name becomes "Karmarush" and its script becomes Karmarush-Track.lss: make sure it is the same output.'));
  });

  test('O11: removing the race an output sends alone says the output then sends nothing', () => {
    let c = setup({ races: [girls(), { name: 'Womens Race', eventNumber: '2', splits: [{ name: '1K' }], inputPort: 17566 }] });
    const w = c.races[1];
    c = addOutput(c, { name: 'Karmarush', port: 6400, enabled: false, races: [w.id] }).config;
    const p = planMeet(c, meetOf({ races: [girls()] }), { mode: 'file', removeOthers: true });
    assert.deepEqual(p.deleted, [w.id]);
    assert.ok(texts(p.attention).includes('Karmarush sends only Womens Race: with it removed, Karmarush sends nothing until you choose its races in Outputs.'));
  });

  test('O12: a race with no splits: one here keeps its splits; a new one comes in not Active', () => {
    const c = setup({ races: [girls({ name: 'Port A', eventNumber: '7' })] });
    const p = planMeet(c, meetOf({ races: [{ name: 'Port A', eventNumber: '7', splits: [] }, { name: 'Zero', eventNumber: '8', inputPort: 17566, splits: [] }] }), { mode: 'file' });
    assert.deepEqual(p.next.races[0].splits.map((s) => s.name), ['1K', '2K', '3K']);
    assert.ok(texts(p.attention).includes('"Port A" in the file has no splits: Port A keeps its 3 splits (1K, 2K, 3K). Give the race its splits in the file if that is a mistake.'));
    assert.equal(p.next.races.find((r) => r.name === 'Zero').active, false);
    assert.ok(texts(p.attention).includes('Zero comes in not Active: it has no splits in the file. Add its splits on its page first.'));
  });

  test('O13: true and false as text; a race that can\'t be read is never removed; a filter that is not a number; nothing said of an output left out', () => {
    const { meet, notes } = parseMeet({ splitRelayMeet: 1, races: [
      { name: 'Str Active', eventNumber: '9', active: 'false', splits: ['1K'] },
      { name: 'Odd Active', eventNumber: '10', active: 'maybe', splits: ['1K'] },
      { name: 'Boys 5K', eventNumber: '4', splits: ['', '3K'] },
    ], outputs: [{ name: 'Out Y', port: 6800, enabled: 'yes', precision: 5 }, { name: 'Out Z', port: 6801, enabled: 'maybe' }],
    filter: { tagWindowSec: 'ten', holdSec: '1,5' }, lif: { enabled: 'false' } });
    assert.deepEqual(meet.races.map((r) => [r.name, r.active]), [['Str Active', false], ['Odd Active', false]]);
    assert.deepEqual(meet.outputs.map((o) => [o.name, o.enabled]), [['Out Y', true], ['Out Z', undefined]]);
    assert.deepEqual([meet.filter, meet.lif, meet.leftOut], [{ holdSec: 1.5 }, { enabled: false }, ['Boys 5K']]);
    assert.deepEqual(texts(notes), [
      '"Odd Active": "active" must be true or false (it is "maybe"): it comes in not Active.',
      '"Boys 5K": split 1 has no name, so the race is left out. Give every split its name in the file.',
      'Output "Out Z": "enabled" must be true or false (it is "maybe"): it was ignored.',
      'The file\'s "filter" has tagWindowSec "ten", which is not a number of seconds: it was ignored.',
    ]);
    const c = setup({ races: [girls({ gun: '10:00:00.000' }), boys()] });
    const p = planMeet(c, meet, { mode: 'file', removeOthers: true, now: at(10, 5) });
    assert.deepEqual(p.removable, [], 'Boys 5K could not be read from the file: never offered for removal');
    assert.ok(texts(p.kept).includes("Boys 5K stays as it is: its race in the file can't be read (see above)."));
    assert.ok(texts(p.attention).includes('Output Out Y is left out: Decimals must be 1, 2 or 3.'));
    assert.ok(!texts(p.attention).some((t) => t.startsWith('Out Y comes in switched off')), 'nothing said of an output that is not added');
    assert.deepEqual(p.offOutputs, ['Out Z']);
  });

  test('O15: an output\'s script, sections and decimals from a file are Checks: what it shows changes', () => {
    const c = setup({ races: [girls()], outputs: [ts] });
    const p = planMeet(c, meetOf({ outputs: [{ ...ts, stage: 'started', precision: 1, script: 'C:\\Lynx\\Other.lss' }] }), { mode: 'file' });
    assert.deepEqual(texts(p.attention), [
      'TrackScore uses the script Other.lss from now on (was XCScore.lss): what TrackScore shows changes with the next split.',
      "TrackScore sends the script's Started sections from now on (was Results): what TrackScore shows changes with the next split.",
      'TrackScore sends times with 1 decimal from now on (was 3): the times it shows change with the next split.',
    ]);
  });

  test('O16: a new race on a port where reads wait for a race that is not Active comes in not Active', () => {
    const c = setup({ races: [girls({ active: false, gun: '13:00:00.000' })] });
    const waitingByPort = new Map([[17565, [{ raceId: c.races[0].id, count: 3 }]]]);
    const p = planMeet(c, meetOf({ races: [boys({ inputPort: 17565 })] }), { mode: 'file', races: inUse(c, 'Girls 5K', { waiting: 3 }), waitingByPort });
    assert.equal(p.next.races.find((r) => r.name === 'Boys 5K').active, false);
    assert.ok(texts(p.attention).includes('Boys 5K comes in not Active: 3 reads on port 17565 wait for Girls 5K, which is not Active, and an Active Boys 5K ' +
      'would take them. Make the right race Active when you know whose they are.'));
  });

  test('O17/O31: a port another program listens on, a merged folder another copy writes to, a port left with no race', () => {
    const c = setup({ races: [girls({ inputPort: 17566 })] });
    const p = planMeet(c, meetOf({ input: { ports: [17570] }, races: [girls({ inputPort: 17570 })],
      lif: { enabled: true, inputDir: 'C:\\Lynx\\Meet', outputDir: 'C:\\Lynx\\Merged' } }),
    { mode: 'file', busyPorts: new Set([17570]), mergedRecent: { dir: 'C:\\Lynx\\Merged', at: NOW - 5 * 60_000 }, now: NOW });
    assert.ok(texts(p.attention).includes("Port 17570 is already in use by another program on this PC: Split Relay can't receive RR12 reads on it. " +
      'Is another copy of Split Relay running? Close it first, then load again.'));
    assert.ok(texts(p.attention).includes('A merged .lif file in C:\\Lynx\\Merged was written 5 minutes ago, not by this Split Relay. ' +
      "If another copy of Split Relay writes there, the two write over each other's files: close the other copy first."));
    assert.ok(texts(p.attention).includes('RR12 port 17566 stays, with no race on it now. Remove it on the Inputs page if RR12 no longer sends there.'));
  });

  test('O18: a file never adds TrackScore\'s port 5555, a timing port, or a port an output on this PC sends to', () => {
    const c = setup({ outputs: [{ name: 'TrackScore', host: '127.0.0.1', port: 6903 }] });
    const p = planMeet(c, meetOf({ input: { ports: [5555, 4560, 6903, 17571] }, races: [{ name: 'P', splits: ['1K'], inputPort: 6903 }] }), { mode: 'file' });
    assert.deepEqual(p.next.input.ports, [17565, 17566, 17571]);
    assert.deepEqual(texts(p.attention.filter((a) => a.tone === 'bad')), [
      "Port 5555 is where TrackScore takes the splits: Split Relay can't listen for RR12 there. It is not added. Choose another port in the file.",
      "Port 4560 is one of TrackScore's timing ports: Split Relay can't listen for RR12 there. It is not added. Choose another port in the file.",
      'Port 6903 is where the output "TrackScore" sends its splits on this PC: RR12 can\'t send to Split Relay there too. It is not added, so P is left out. ' +
        'Choose another port in the file.',
    ]);
    // TrackScore's web page is not an RR12 port either
    assert.deepEqual(texts(planMeet(c, meetOf({ input: { ports: [5000] } }), { mode: 'file' }).attention),
      ["Port 5000 is TrackScore's web page (Settings → Meet setup): Split Relay can't listen for RR12 there. It is not added. Choose another port in the file."]);
    // Settings says the same; a setup that already has such a port still loads and saves
    assert.throws(() => updateSettings(c, { input: { ports: [17565, 5555] } }), /^ConfigError: Port 5555 is where TrackScore takes the splits/);
    const old = normalizeConfig({ input: { ports: [5555] } }).config;
    assert.deepEqual(updateSettings(old, { filter: { holdSec: 1 } }).input.ports, [5555]);
    assert.deepEqual(updateSettings(old, { input: { ports: [5555, 17565] } }).input.ports, [5555, 17565]);
  });

  test('O2: the copy kept before a load offers to remove what the load added and says what it can\'t take back', () => {
    const before = parseMeet(buildMeet(setup(), { name: '' })).meet;
    const c = setup({ races: [girls(), boys()], outputs: [{ name: 'Karmarush', port: 6400 }], ports: [17565, 17566, 17567] });
    const p = planMeet(c, before, { mode: 'file', undo: { at: at(12, 52) }, races: inUse(c, 'Boys 5K') });
    assert.deepEqual(p.removable.map((r) => r.name), ['Girls 5K']);
    assert.ok(texts(p.kept).includes('Girls 5K is not in that copy: it stays.'));
    assert.ok(texts(p.attention).includes('This puts back what that copy has, as it was before the load at 12:52. What the load added stays: ' +
      'Girls 5K and Boys 5K (tick the box below to remove the races with no reads); the output Karmarush (delete it in Outputs); RR12 port 17567 (Inputs page).'));
  });

  test('O3: Set up from TrackScore names a new race as FinishLynx\'s file of today does', () => {
    const { meet } = trackScoreToMeet({ raceSnap: TS_RACE, schedule: TS_SCHEDULE, meetId: 'm' });
    const p = planMeet(setup(), meet, { mode: 'trackscore', lynxNames: new Map([['1-1-1', 'Mens Race']]) });
    assert.deepEqual(p.next.races.map((r) => r.name), ['Mens Race', "Women's Race"]);
    assert.ok(texts(p.attention).includes('"Mens Race" is TrackScore\'s "Men\'s Race", named as in FinishLynx\'s file for event 1.'));
    assert.ok(texts(p.attention).includes("Women's Race takes TrackScore's name. Each must be exactly FinishLynx's event name: rename it on its page if not."));
  });

  test('O6: the new outputs that came in switched off although the file had them on, or did not say', () => {
    const p = planMeet(setup({ races: [girls({ gun: '10:00:00.000' })] }), meetOf({ outputs: [
      { name: 'A', port: 6401, enabled: true }, { name: 'B', port: 6402 }, { name: 'C', port: 6403, enabled: false }] }), { mode: 'file', now: at(10, 5) });
    assert.deepEqual(p.offOutputs, ['A', 'B']);
  });

  test('O29: a race with no change and reads is said once', () => {
    const c = setup({ races: [girls()] });
    const p = planMeet(c, meetOf({ races: [girls()] }), { mode: 'file', races: inUse(c, 'Girls 5K') });
    assert.deepEqual(texts(p.kept), ['Girls 5K: no change, and it keeps its 40 reads.']);
  });

  test('O5: a loaded file kept as a meet file reads back as the same meet', () => {
    const { meet } = parseMeet({ splitRelayMeet: 1, name: 'Fall Classic', races: [girls({ splits: ['1K', { name: '2K', sources: ['2K-A'] }] })],
      outputs: [{ name: 'TS', port: 6555 }], filter: { holdSec: 1 } });
    const file = meetFileOf(meet);
    assert.deepEqual(file.races[0].splits, ['1K', { name: '2K', sources: ['2K-A'], earliest: '' }]);
    assert.deepEqual(parseMeet(JSON.parse(meetText(file))).meet, meet);
  });
});

// ---- what a re-check of the build found (DESIGN 9.22, O33-O37) ------------------------------------------------------

describe('the re-check: the copy kept before a load, outputs into this PC\'s RR12 ports, TrackScore\'s boards, running', () => {
  const at = (h, m) => new Date(2026, 9, 21, h, m).getTime();
  const loop = (port, name, after, adds = false) => `Port ${port} is an RR12 input port of this Split Relay${adds ? ' (the file adds it)' : ''}: ` +
    `the output "${name}" would send Split Relay's own splits to it on this PC, and they would come back in as RR12 reads. ${after} Choose another port in the file.`;

  test('O33: the copy kept before a load says what that load left behind; its outputs are "not in that copy" as its races are', () => {
    const before = parseMeet(buildMeet(setup({ outputs: [{ name: 'TrackScore', port: 6555 }] }), { name: '' })).meet;
    const c = setup({ races: [girls(), boys()], outputs: [{ name: 'TrackScore', port: 6555 }, { name: 'Loop', port: 6400 }], ports: [17565, 17566, 17567] });
    let p = planMeet(c, before, { mode: 'file', undo: { at: at(14, 2) }, races: inUse(c, 'Boys 5K') });
    // nothing that copy has changes: what the load added is all that differs, and it is said, not "Nothing to change"
    assert.equal(p.nothing, true);
    assert.deepEqual(p.leftover, { races: ['Girls 5K', 'Boys 5K'], outputs: ['Loop'], ports: [17567] });
    assert.deepEqual(p.removable.map((r) => r.name), ['Girls 5K']);
    assert.deepEqual(texts(p.kept), ['Girls 5K is not in that copy: it stays.', 'Boys 5K is not in that copy: it stays.', 'Loop is not in that copy: it stays.',
      'No change: TrackScore.']);
    // the box ticked: Girls 5K goes; what can't be taken back is still said
    p = planMeet(c, before, { mode: 'file', undo: { at: at(14, 2) }, races: inUse(c, 'Boys 5K'), removeOthers: true });
    assert.deepEqual([p.nothing, texts(p.removed), p.leftover], [false, ['Girls 5K is removed (it has no reads).'], { races: ['Boys 5K'], outputs: ['Loop'], ports: [17567] }]);
    // a meet file is still "the file", and has no leftover
    p = planMeet(c, meetOf({ races: [girls()] }), { mode: 'file' });
    assert.deepEqual([p.leftover, texts(p.kept).filter((t) => t.startsWith('Loop'))], [null, ['Loop is not in the file: it stays.']]);
  });

  test('O34: an output to this PC on an RR12 port (one here, or one the same file adds) is never added, nor moved there', () => {
    const c = setup({ outputs: [{ name: 'Board', host: '10.0.0.9', port: 6555 }] });
    const p = planMeet(c, meetOf({ input: { ports: [17570] }, races: [{ name: 'P', splits: ['1K'], inputPort: 17570 }], outputs: [
      { name: 'Loop', mode: 'tcp-client', host: '127.0.0.1', port: 17570, enabled: true },
      { name: 'Self', host: 'localhost', port: 17565 },
      { name: 'Udp', mode: 'udp', host: '::1', port: 17566 },
      { name: 'NoHost', port: 17565 },
      { name: 'ByName', host: 'timing-1', port: 17565 },
      { name: 'ByAddress', host: '192.168.0.21', port: 17566 },
      { name: 'Live', host: '10.0.0.9', port: 17565 },
      { name: 'Board', host: '127.0.0.1', port: 17566, stage: 'started' },
    ] }), { mode: 'file', thisPc: 'TIMING-1', thisPcAddresses: ['192.168.0.21'] });
    assert.deepEqual(p.next.input.ports, [17565, 17566, 17570], 'the port is added: its race reads from it');
    assert.deepEqual(p.next.outputs.map((o) => [o.name, `${o.host}:${o.port}`, o.stage]), [['Board', '10.0.0.9:6555', 'started'], ['Live', '10.0.0.9:17565', 'results']]);
    assert.deepEqual(texts(p.attention.filter((a) => a.tone === 'bad')), [
      loop(17570, 'Loop', 'It is not added.', true),
      loop(17565, 'Self', 'It is not added.'),
      loop(17566, 'Udp', 'It is not added.'),
      loop(17565, 'NoHost', 'It is not added.'),
      loop(17565, 'ByName', 'It is not added.'),
      loop(17566, 'ByAddress', 'It is not added.'),
      loop(17566, 'Board', 'It stays at 10.0.0.9:6555.'),
    ]);
    // nothing else is said of an output that is not added (O13): Loop was asked for switched on
    assert.ok(!texts(p.attention).some((t) => /Loop is added|Loop comes in/.test(t)) && !p.offOutputs.includes('Loop'));
    assert.deepEqual(texts(p.added).filter((t) => !t.startsWith('P ·')), ['RR12 input port 17570 (P reads from it)', 'Live · 10.0.0.9:17565 · switched off']);
    // an output here that already sends there, switched off: a load does not switch it on (left as it is, it is not said)
    const d = setup({ outputs: [{ name: 'Dormant', host: '127.0.0.1', port: 17565 }] });
    let r = planMeet(d, meetOf({ outputs: [{ name: 'Dormant', host: '127.0.0.1', port: 17565, enabled: true, stage: 'started' }] }), { mode: 'file' });
    assert.deepEqual(r.next.outputs.map((o) => [o.name, o.enabled, o.stage]), [['Dormant', false, 'started']]);
    assert.deepEqual(texts(r.attention.filter((a) => a.tone === 'bad')), [loop(17565, 'Dormant', 'It stays switched off.').replace('Choose another port in the file.', 'Change its port in Outputs first.')]);
    r = planMeet(d, meetOf({ outputs: [{ name: 'Dormant', host: '127.0.0.1', port: 17565 }] }), { mode: 'file' });
    assert.deepEqual([texts(r.attention), texts(r.kept)], [[], ['No change: Dormant.']]);
    // a port the file adds where an output here sends, on this PC by its name: the port is not added (O18)
    const q = planMeet(setup({ outputs: [{ name: 'Named', host: 'timing-1', port: 17572 }] }), meetOf({ input: { ports: [17572] } }), { mode: 'file', thisPc: 'TIMING-1' });
    assert.deepEqual(q.next.input.ports, [17565, 17566]);
    assert.deepEqual(texts(q.attention), ['Port 17572 is where the output "Named" sends its splits on this PC: RR12 can\'t send to Split Relay there too. ' +
      'It is not added. Choose another port in the file.']);
  });

  test('O36: TrackScore\'s boards on a race that is not in the list it sent: the source names it, as the Problem line does', () => {
    let g = trackScoreToMeet({ raceSnap: { meetId: 'x', config: { scheduledRaceId: 'xcr-old', raceName: "Women's Race" } },
      schedule: { races: TS_SCHEDULE.races, activeRaceId: 'xcr-old' }, meetId: 'x' });
    assert.deepEqual([g.source.confirmed, g.source.liveRace, g.source.shownElsewhere], [false, null, "Women's Race"]);
    assert.match(g.notes[0].text, /^TrackScore's boards show "Women's Race", which is not in the races TrackScore sent for its meet/);
    g = trackScoreToMeet({ raceSnap: { meetId: 'x', config: { scheduledRaceId: 'xcr-old' } }, schedule: { races: TS_SCHEDULE.races }, meetId: 'x' });
    assert.equal(g.source.shownElsewhere, '');
    // a race of the list shown, or none at all: nothing of the kind
    assert.ok(!('shownElsewhere' in trackScoreToMeet({ raceSnap: TS_RACE, schedule: TS_SCHEDULE }).source));
    assert.ok(!('shownElsewhere' in trackScoreToMeet({ raceSnap: { config: {} }, schedule: { races: TS_SCHEDULE.races } }).source));
  });

  test('O37: running is public/running.js\'s rule: reads still arriving under a gun later in the day are a running race', () => {
    assert.equal(raceRunning({ active: true, gun: '16:28:00.455' }, at(12, 50), at(12, 55)), true);
    assert.equal(raceRunning({ active: true, gun: '16:28:00.455' }, at(12, 30), at(12, 55)), false, 'the last read 25 minutes ago');
    assert.equal(raceRunning(null, at(12, 50), at(12, 55)), false);
  });
});

describe('split points that are counted but not sent (DESIGN 9.26)', () => {
  const men = (extra = {}) => ({ name: 'Mens Race', eventNumber: '1', inputPort: 17565,
    splits: [{ name: '3K' }, { name: '4K' }, { name: '4.2K', collectOnly: true }, { name: '5K' }], ...extra });
  const tsRace = (splits, extra = {}) => meetOf({ name: '', races: [{ name: 'Mens Race', eventNumber: '1', splits, ...extra }] });

  test('the meet file says which splits are counted only, and reads back as the same meet', () => {
    const c = setup({ races: [men({ splits: [{ name: '4K' }, { name: '4.2K', collectOnly: true }, { name: '5K', sources: ['5K-A'], earliest: '14:00', collectOnly: true }, { name: '6K' }] })] });
    const m = buildMeet(c, { name: 'Close mats' });
    assert.deepEqual(m.races[0].splits, ['4K', { name: '4.2K', collectOnly: true }, { name: '5K', sources: ['5K-A'], earliest: '14:00', collectOnly: true }, '6K']);
    const back = parseMeet(JSON.parse(meetText(m)));
    assert.deepEqual(back.notes, []);
    assert.deepEqual(back.meet.races[0].splits, [{ name: '4K', sources: [], earliest: '' }, { name: '4.2K', sources: [], earliest: '', collectOnly: true },
      { name: '5K', sources: ['5K-A'], earliest: '14:00', collectOnly: true }, { name: '6K', sources: [], earliest: '' }]);
    assert.deepEqual(parseMeet(back.meet).meet, back.meet, 'idempotent');
    assert.deepEqual(meetFileOf(back.meet).races[0].splits, m.races[0].splits);
    // typed by hand: "yes" is true; anything unclear is said and the split is sent
    const hand = parseMeet({ splitRelayMeet: 1, races: [{ name: 'R', splits: [{ name: 'a', collectOnly: 'yes' }, { name: 'b', collectOnly: 'maybe' }, { name: 'c', collectOnly: false }] }] });
    assert.deepEqual(hand.meet.races[0].splits.map((s) => s.collectOnly ?? false), [true, false, false]);
    assert.deepEqual(texts(hand.notes), ['"R" split b: "collectOnly" must be true or false (it is "maybe"): the split is sent.']);
    assert.equal(raceSummary(c.races[0]), 'Mens Race · Event 1-1-1 · 2 splits + 2 not sent: 4K, 4.2K (not sent), 5K (not sent), 6K · port 17565 · Active');
    // a new race from the file comes in with them
    const p = planMeet(setup(), back.meet, { mode: 'file' });
    assert.deepEqual(p.next.races[0].splits.map((s) => [s.name, s.collectOnly ?? false]), [['4K', false], ['4.2K', true], ['5K', true], ['6K', false]]);
  });

  test('Set up from TrackScore: its split points map in order onto the SENT splits; the ones that are counted only stay where they are, and the preview says so', () => {
    const c = setup({ races: [men()] });
    const old = c.races[0].splits;
    // TrackScore has the three sent ones, one renamed
    const p = planMeet(c, tsRace(['3K', '4K', '5000m']), { mode: 'trackscore' });
    assert.deepEqual(p.next.races[0].splits.map((s) => [s.name, s.collectOnly ?? false, s.id]),
      [['3K', false, old[0].id], ['4K', false, old[1].id], ['4.2K', true, old[2].id], ['5000m', false, old[3].id]]);
    assert.deepEqual(texts(p.changed), ['Mens Race: split 4 5K → 5000m']);
    assert.ok(texts(p.attention).includes("Mens Race: 4.2K is counted, not sent, so TrackScore has no split point for it: it stays where it is, and TrackScore's 3 split points are compared with the 3 splits that are sent."));
    // nothing to change: said all the same, and the race is as it was
    const same = planMeet(c, tsRace(['3K', '4K', '5K']), { mode: 'trackscore' });
    assert.deepEqual([same.next.races[0].splits, texts(same.changed)], [old, []]);
    assert.equal(texts(same.attention).filter((t) => /counted, not sent/.test(t)).length, 1);
  });

  test('Set up from TrackScore with another number of split points: the race not in use is rebuilt around its not-sent splits; one in use stays, by the sent count', () => {
    const c = setup({ races: [men({ splits: [{ name: '3K' }, { name: '4K' }, { name: '4.2K', collectOnly: true }, { name: '5K' }, { name: '8K' }, { name: '8.2K', collectOnly: true }] })] });
    const old = c.races[0].splits;
    // TrackScore has a 6K and a 7K more, and no 3K any more
    const p = planMeet(c, tsRace(['4K', '5K', '6K', '7K', '8K']), { mode: 'trackscore' });
    assert.deepEqual(p.next.races[0].splits.map((s) => [s.name, s.collectOnly ?? false, old.find((o) => o.id === s.id)?.name ?? 'new']),
      [['4K', false, '4K'], ['4.2K', true, '4.2K'], ['5K', false, '5K'], ['6K', false, 'new'], ['7K', false, 'new'], ['8K', false, '8K'], ['8.2K', true, '8.2K']]);
    assert.deepEqual(texts(p.changed), ['Mens Race: 5 splits: 4K, 5K, 6K, 7K, 8K (was 4 sent: 3K, 4K, 5K, 8K); 4.2K and 8.2K still counted, not sent: 4K, 4.2K (not sent), 5K, 6K, 7K, 8K, 8.2K (not sent)']);
    // its sent split is gone from TrackScore: the not-sent one goes after the nearest sent split before it that is left, or first
    const gone = planMeet(c, tsRace(['3K', '5K', '8K', '9K', '10K']), { mode: 'trackscore' });
    assert.deepEqual(gone.next.races[0].splits.map((s) => s.name), ['3K', '4.2K', '5K', '8K', '8.2K', '9K', '10K']);
    const first = planMeet(setup({ races: [men({ splits: [{ name: '1K' }, { name: '1.2K', collectOnly: true }, { name: '2K' }] })] }), tsRace(['2K', '3K', '4K']), { mode: 'trackscore' });
    assert.deepEqual(first.next.races[0].splits.map((s) => [s.name, s.collectOnly ?? false]), [['1.2K', true], ['2K', false], ['3K', false], ['4K', false]]);
    // in use: nothing changes, and the numbers compared are the sent ones
    const used = planMeet(c, tsRace(['4K', '5K', '6K', '7K', '8K']), { mode: 'trackscore', races: inUse(c, 'Mens Race') });
    assert.deepEqual(used.next.races[0].splits, old);
    assert.ok(texts(used.attention).includes("Mens Race has reads, so these stay as they are: the number of splits and their names (4 sent here: 3K, 4K, 5K, 8K; 5 in TrackScore: 4K, 5K, 6K, 7K, 8K). Change them on the race's page: it asks first. " +
      "Until the numbers of splits agree, TrackScore puts this race's splits in the wrong columns."));
    // the same number as the sent ones is no difference at all, with reads too
    const fits = planMeet(c, tsRace(['3K', '4K', '5K', '8K']), { mode: 'trackscore', races: inUse(c, 'Mens Race') });
    assert.deepEqual([fits.next.races[0].splits, texts(fits.changed)], [old, []]);
    assert.equal(texts(fits.attention).some((t) => /stay as they are/.test(t)), false);
  });

  test('a meet file that sends a split this race only counts (or the other way round): changed on a race not in use, held on one with reads', () => {
    const c = setup({ races: [men()] });
    const file = meetOf({ races: [{ name: 'Mens Race', eventNumber: '1', inputPort: 17565, splits: ['3K', { name: '4K', collectOnly: true }, '4.2K', '5K'] }] });
    const p = planMeet(c, file, { mode: 'file' });
    assert.deepEqual(p.next.races[0].splits.map((s) => [s.name, s.collectOnly ?? false]), [['3K', false], ['4K', true], ['4.2K', false], ['5K', false]]);
    assert.ok(texts(p.changed).includes('Mens Race: 4K counted, not sent; 4.2K sent again'));
    const used = planMeet(c, file, { mode: 'file', races: inUse(c, 'Mens Race') });
    assert.deepEqual(used.next.races[0].splits, c.races[0].splits);
    assert.ok(texts(used.attention).includes("Mens Race has reads, so these stay as they are: which splits are sent (here: 3K, 4K, 4.2K (not sent), 5K; in the file: 3K, 4K (not sent), 4.2K, 5K). Change them on the race's page: it asks first. " +
      "Until the numbers of splits agree, TrackScore puts this race's splits in the wrong columns."));
    // the same file as the race: no change
    const same = planMeet(c, parseMeet(buildMeet(c, { name: 'x' })).meet, { mode: 'file' });
    assert.deepEqual([same.next.races[0].splits, texts(same.changed).filter((t) => /Mens Race/.test(t))], [c.races[0].splits, []]);
  });
});
