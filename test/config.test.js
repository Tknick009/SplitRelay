import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultConfig, normalizeConfig, newId, updateSettings, addRace, updateRace, deleteRace, patchRace, addOutput,
  updateOutput, deleteOutput, ConfigFile, ConfigError, settleConflicts, activateRace, restoreRace, setSplitSending,
  allNotSentText, sentSplits,
} from '../src/config.js';
import { RaceStore, writeFileAtomic, raceFileName } from '../src/store.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Throws a ConfigError whose message matches. */
function rejects(fn, re, status = 400) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err}`);
    assert.equal(err.status, status);
    assert.match(err.message, re);
    return true;
  });
}

const SCRIPT = String.raw`C:\Lynx\XCScore.lss`;

function withRace(extra = {}) {
  return addRace(defaultConfig(), {
    name: 'Girls Varsity 5K', eventNumber: '3', splits: [{ name: '1K', sources: ['1K-A', '1K-B'] }, { name: '2K', sources: ['2K-A'] }],
    ...extra,
  });
}

describe('defaults and normalisation', () => {
  test('a first-run config is exactly section 3 with no races and no outputs', () => {
    assert.deepEqual(defaultConfig(), {
      version: 1,
      input: { ports: [5565], delimiter: '|', tag: 'SR', columns: ['location', 'bib', 'time', 'contest', 'first', 'last', 'team', 'gender'] },
      filter: { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 60 },
      names: { pplPath: '' },
      lif: { enabled: false, inputDir: '', outputDir: '', fillPlaces: false },
      panel: { port: 5590, allowLan: false },
      meet: { name: '', trackScoreWebPort: 5000 },
      races: [],
      outputs: [],
    });
    assert.deepEqual(normalizeConfig(defaultConfig()).config, defaultConfig());
    assert.deepEqual(normalizeConfig(null).config, defaultConfig());
  });

  test('missing fields are filled and missing or duplicated ids are generated with their prefixes', () => {
    const { config, notes } = normalizeConfig({
      input: { port: '5566' },
      filter: { holdSec: 'x' },
      races: [
        { name: 'A', splits: [{ name: '1K', sources: [' 1K-A ', '1k-a', ''] }, {}] },
        { id: 'r_same', name: 'B', gun: '9:05:00' },
        { id: 'r_same', name: 'C', gun: 'not a time' },
      ],
      outputs: [{ name: 'TS', mode: 'nonsense', port: '5555', precision: 7, script: `"${SCRIPT}"` }, { mode: 'tcp-server', host: '' }],
      unknown: true,
    });
    assert.deepEqual(config.input.ports, [5566], 'the one port of a settings file from before revision 7 becomes the list');
    assert.equal('port' in config.input, false);
    assert.equal(config.input.delimiter, '|');
    assert.equal(config.filter.holdSec, 2);
    assert.equal(config.filter.tagWindowSec, 10);
    assert.equal(config.filter.startIgnoreSec, 60, 'a settings file from before the start area setting gets its default');
    assert.equal('unknown' in config, false);
    const [a, b, c] = config.races;
    assert.match(a.id, /^r_[0-9a-f]{10}$/);
    assert.deepEqual(a.splits.map((s) => s.name), ['1K', 'Split 2']);
    assert.ok(a.splits.every((s) => /^s_[0-9a-f]{10}$/.test(s.id)));
    assert.deepEqual(a.splits[0].sources, ['1K-A'], 'trimmed, blanks dropped, case-insensitive duplicates merged');
    assert.equal(a.round, '1');
    assert.equal(a.heat, '1');
    assert.equal(a.active, true);
    assert.equal(b.id, 'r_same');
    assert.equal(b.gun, '09:05:00.000', 'gun text normalised the way setGun stores it');
    assert.notEqual(c.id, 'r_same', 'a duplicated id gets a new one');
    assert.equal(c.gun, '');
    assert.match(notes.join(' '), /gun time "not a time" of C could not be read/);
    const [o1, o2] = config.outputs;
    assert.match(o1.id, /^o_[0-9a-f]{10}$/);
    assert.equal(o1.mode, 'tcp-client');
    assert.equal(o1.port, 5555);
    assert.equal(o1.precision, 3);
    assert.equal(o1.script, SCRIPT, "Explorer's quotes are removed");
    assert.equal(o2.name, 'Output 2');
    assert.equal(o2.host, '0.0.0.0', 'tcp-server binds to every address by default');
  });

  test('ids are random with the right prefix', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('r_')));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^r_[0-9a-f]{10}$/);
  });
});

describe('changes and validation', () => {
  test('a race is added with defaults, fresh ids and normalised names', () => {
    const { config, race } = withRace({ id: 'r_mine', contests: ['Girls Varsity 5K', 'girls varsity 5k'] });
    assert.notEqual(race.id, 'r_mine', 'POST always makes a new id');
    assert.equal(config.races.length, 1);
    assert.deepEqual(race.contests, ['Girls Varsity 5K']);
    assert.deepEqual({ ...race, id: '', splits: [] }, {
      id: '', name: 'Girls Varsity 5K', eventNumber: '3', round: '1', heat: '1', distance: '', contests: ['Girls Varsity 5K'],
      inputPort: 5565, gun: '', splits: [], finishSources: [], active: true,
    }, 'a new race takes the reads of the first RR12 input port (9.15 L3)');
    assert.deepEqual(race.splits.map((s) => [s.name, s.sources, s.earliest]), [['1K', ['1K-A', '1K-B'], ''], ['2K', ['2K-A'], '']]);
  });

  test('pause and play a split (9.17 P1): sending defaults to true, only that flag changes, and a race edit keeps it', () => {
    const { config, race } = withRace();
    assert.deepEqual(race.splits.map((s) => s.sending), [true, true]);
    assert.deepEqual(normalizeConfig({ races: [{ name: 'Old', splits: [{ name: '1K' }, { name: '2K', sending: false }] }] }).config.races[0].splits
      .map((s) => s.sending), [true, false], 'a settings file from before has every split sending; a paused one stays paused');
    const [s1, s2] = race.splits;
    const p = setSplitSending(config, race.id, s1.id, false);
    assert.deepEqual([p.changed, p.race.splits.map((s) => s.sending)], [true, [false, true]]);
    assert.equal(config.races[0].splits[0].sending, true, 'the input is never touched');
    assert.deepEqual({ ...p.race, splits: null }, { ...race, splits: null }, 'nothing else changes');
    assert.equal(setSplitSending(p.config, race.id, s1.id, false).changed, false);
    // the race editor sends the splits back without "sending": a paused split stays paused (renamed, given an earliest time)
    const edited = updateRace(p.config, race.id, { splits: [{ id: s1.id, name: '1 km', sources: ['1K-A'], earliest: '2:00' }, { id: s2.id, name: '2K', sources: ['2K-A'] }] }).race;
    assert.deepEqual(edited.splits.map((s) => [s.name, s.sending]), [['1 km', false], ['2K', true]]);
    // ...unless it says so, and a new split always sends
    const played = updateRace(p.config, race.id, { splits: [{ id: s1.id, name: '1K', sending: true }, { id: s2.id, name: '2K' }, { name: '3K' }] }).race;
    assert.deepEqual(played.splits.map((s) => s.sending), [true, true, true]);
    rejects(() => setSplitSending(config, race.id, s1.id, 'no'), /Send { "on": true } to play the split, or { "on": false } to pause it/);
    rejects(() => setSplitSending(config, race.id, 's_nope', true), /Girls Varsity 5K has no split with id "s_nope"/, 404);
    rejects(() => setSplitSending(config, 'r_nope', s1.id, true), /There is no race with id "r_nope"/, 404);
  });

  test('a copied race never shares split ids with its original', () => {
    const { config, race } = withRace();
    const copy = addRace(config, { name: 'Copy', contests: ['Other'], inputPort: null, splits: race.splits.map((s) => ({ ...s })) }).race;
    for (const s of copy.splits) assert.ok(!race.splits.some((o) => o.id === s.id));
  });

  test('race edits keep the ids of existing splits and only change the fields given', () => {
    const { config, race } = withRace();
    const [s1, s2] = race.splits;
    const edited = updateRace(config, race.id, {
      splits: [{ id: s2.id, name: '2K', sources: ['2K-A'] }, { id: s1.id, name: '1K', sources: ['1K-A'] }, { id: 's_foreign', name: '3K', sources: ['3K'] }],
    }).race;
    assert.equal(edited.name, 'Girls Varsity 5K');
    assert.equal(edited.eventNumber, '3');
    assert.deepEqual(edited.splits.slice(0, 2).map((s) => s.id), [s2.id, s1.id], 'reordered, ids kept');
    assert.notEqual(edited.splits[2].id, 's_foreign', 'an id that is not this race\'s own becomes a new split');
    const paused = updateRace(config, race.id, { active: false }).race;
    assert.equal(paused.active, false);
    assert.deepEqual(paused.splits, race.splits);
  });

  test('race validation explains the problem in plain words', () => {
    const { config, race } = withRace({ inputPort: null });
    rejects(() => addRace(config, {}), /Give the race a name/);
    rejects(() => addRace(config, { name: 'girls varsity 5k', contests: ['X'] }), /already a race called "girls varsity 5k"/);
    rejects(() => addRace(config, { name: 'Boys 5K', inputPort: null }), /"Girls Varsity 5K" is active and already takes every contest/);
    assert.equal(addRace(config, { name: 'Boys 5K', active: false, inputPort: null }).race.active, false, 'a paused race may overlap');
    rejects(() => updateRace(config, race.id, { splits: [{ name: '1K', sources: ['A'] }, { name: '1k', sources: ['B'] }] }), /Two splits are called "1k"/);
    rejects(() => updateRace(config, race.id, { splits: [{ name: '1K', sources: ['A'] }], finishSources: ['a'] }),
      /Timing point "a" is used by split 1 \(1K\) and the finish/);
    rejects(() => updateRace(config, race.id, { splits: [{ name: '', sources: [] }] }), /Split 1 needs a name/);
    rejects(() => updateRace(config, race.id, { gun: '10' }), /"10" is not a time of day/);
    rejects(() => updateRace(config, 'r_gone', { name: 'X' }), /no race with id "r_gone"/, 404);
    const two = updateRace(config, race.id, { contests: ['Girls Varsity 5K'] }).config;
    rejects(() => addRace(two, { name: 'Also girls', contests: ['GIRLS VARSITY 5K'], inputPort: null }), /Contest "GIRLS VARSITY 5K" already belongs to the active race/);
  });

  test('RR12 input ports (9.15 L2): one listener each; distinct, 1024-65535, not the panel port or a tcp-server output', () => {
    const base = defaultConfig();
    assert.deepEqual(updateSettings(base, { input: { ports: [5565, '5566'] } }).input.ports, [5565, 5566]);
    // a panel from before revision 7 sends one port: it replaces the first, the others stay
    const two = updateSettings(base, { input: { ports: [5565, 5566] } });
    assert.deepEqual(updateSettings(two, { input: { port: 5570 } }).input.ports, [5570, 5566]);
    assert.equal('port' in updateSettings(two, { input: { port: 5570 } }).input, false);
    rejects(() => updateSettings(base, { input: { ports: [] } }), /Keep at least one RR12 input port/);
    rejects(() => updateSettings(base, { input: { ports: [5565, 5565] } }), /Port 5565 is in the list of RR12 input ports twice/);
    rejects(() => updateSettings(base, { input: { ports: [80] } }), /"80" can't be an RR12 input port: use a whole number from 1024 to 65535/);
    rejects(() => updateSettings(base, { input: { ports: [70000] } }), /from 1024 to 65535/);
    rejects(() => updateSettings(base, { input: { ports: ['abc'] } }), /"abc" can't be an RR12 input port/);
    rejects(() => updateSettings(base, { input: { port: 0 } }), /"0" can't be an RR12 input port/);
    rejects(() => updateSettings(base, { input: { ports: [5565, 5590] } }), /RR12 input port and the control panel port are both 5590/);
    const board = addOutput(base, { name: 'Board', mode: 'tcp-server', port: 6000 }).config;
    rejects(() => updateSettings(board, { input: { ports: [5565, 6000] } }), /The output "Board" already listens on port 6000/);
    rejects(() => addOutput(two, { name: 'X', mode: 'tcp-server', port: 5566 }), /Port 5566 is an RR12 input port/);
    // an output sending to an RR12 input port on this PC would feed Split Relay's own splits back in (DESIGN 9.22 O34)
    for (const host of ['127.0.0.1', 'localhost', os.hostname()]) {
      rejects(() => addOutput(two, { name: 'Loop', mode: 'tcp-client', host, port: 5566 }), /Port 5566 is an RR12 input port of this Split Relay: sending there on this PC would feed Split Relay's own splits back in/);
    }
    rejects(() => addOutput(two, { name: 'Loop', mode: 'udp', host: '127.0.0.1', port: 5565 }), /Port 5565 is an RR12 input port of this Split Relay/);
    assert.equal(addOutput(two, { name: 'Other PC', mode: 'tcp-client', host: '192.168.0.20', port: 5566 }).config.outputs.length, 1, 'another PC may use that port');
    const ts = addOutput(two, { name: 'TrackScore', host: '127.0.0.1', port: 5555 }).config;
    rejects(() => updateOutput(ts, ts.outputs[0].id, { port: 5565 }), /Port 5565 is an RR12 input port of this Split Relay/);
    assert.equal(updateOutput(ts, ts.outputs[0].id, { name: 'TS' }).output.name, 'TS', 'an edit that leaves the address alone is not checked again');
    // a port that feeds an Active race can't go; once the race is off (or on another port), it can
    let cfg = addRace(two, { name: 'Boys 5K', inputPort: 5566 }).config;
    const boys = cfg.races[0];
    rejects(() => updateSettings(cfg, { input: { ports: [5565] } }), /Port 5566 feeds the active race 'Boys 5K'\. Give that race another port, or untick its Active/);
    cfg = updateRace(cfg, boys.id, { active: false }).config;
    assert.deepEqual(updateSettings(cfg, { input: { ports: [5565] } }).input.ports, [5565]);
    // normalisation never leaves Split Relay without a port to listen on
    assert.deepEqual(normalizeConfig({ input: { ports: ['x', 5565, 5565, 0] } }).config.input.ports, [5565]);
    assert.deepEqual(normalizeConfig({ input: { ports: [] } }).config.input.ports, [5565]);
    assert.deepEqual(normalizeConfig({ input: { ports: 'nope', port: 5571 } }).config.input.ports, [5571]);
  });

  test('a race takes its reads from one port (9.15 L3): one Active race per port, a port that exists, or none', () => {
    const base = updateSettings(defaultConfig(), { input: { ports: [5565, 5566] } });
    let { config, race: girls } = addRace(base, { name: 'Girls 5K', eventNumber: '1' });
    assert.equal(girls.inputPort, 5565, 'the first RR12 input port');
    rejects(() => addRace(config, { name: 'Boys 5K', eventNumber: '2' }),
      /^Port 5565 already feeds the active race 'Girls 5K'\. Untick Active on one of them, or give this race its own port\.$/);
    const boys = addRace(config, { name: 'Boys 5K', eventNumber: '2', inputPort: 5566 });
    assert.equal(boys.race.inputPort, 5566, 'overlapping races: each on its own port');
    // races that take no port and no contest take every contest: they are the old "catch-all"
    const open = addRace(boys.config, { name: 'Open', eventNumber: '3', inputPort: null });
    assert.equal(open.race.inputPort, null);
    rejects(() => addRace(open.config, { name: 'Open 2', eventNumber: '4', inputPort: null }), /"Open" is active and already takes every contest/);
    // a race that is not Active may share the port (yesterday's race, the next race waiting)
    config = addRace(boys.config, { name: 'Boys JV', eventNumber: '5', active: false }).config;
    const jv = config.races.find((r) => r.name === 'Boys JV');
    assert.equal(jv.inputPort, 5565);
    rejects(() => updateRace(config, jv.id, { active: true }), /Port 5565 already feeds the active race 'Girls 5K'/);
    // the port must be one of the RR12 input ports, and a number
    rejects(() => addRace(base, { name: 'X', inputPort: 5599 }), /Port 5599 is not one of the RR12 input ports \(5565, 5566\)/);
    rejects(() => addRace(base, { name: 'X', inputPort: 'abc' }), /Choose the RR12 input port this race takes its reads from/);
    assert.equal(addRace(base, { name: 'X', inputPort: '5566' }).race.inputPort, 5566);
    // a settings file from before revision 7: its races take no port (by contest only, as they did)
    assert.equal(normalizeConfig({ races: [{ name: 'Old', contests: ['G'] }] }).config.races[0].inputPort, null);
  });

  test('the number of splits (9.15 L5): at most 20 set from the panel or the API; an older file keeps its splits', () => {
    const n = (k) => Array.from({ length: k }, (_, i) => ({ name: `Split ${i + 1}`, sources: [] }));
    assert.equal(addRace(defaultConfig(), { name: 'Twenty', splits: n(20) }).race.splits.length, 20);
    rejects(() => addRace(defaultConfig(), { name: 'Too many', splits: n(21) }), /^A race can have at most 20 splits\.$/);
    // a hand-edited settings file with more: loaded as it is, and an edit that leaves the splits alone still works
    const { config } = normalizeConfig({ races: [{ id: 'r_long', name: 'Long', splits: n(25) }] });
    assert.equal(config.races[0].splits.length, 25);
    assert.equal(updateRace(config, 'r_long', { name: 'Long run', active: false }).race.splits.length, 25);
    rejects(() => updateRace(config, 'r_long', { splits: n(22) }), /at most 20 splits/);
  });

  test("a split's earliest time (9.15 L4): a race time, going up in course order, '' for none", () => {
    const { config, race } = withRace();
    const s = race.splits;
    const ok = updateRace(config, race.id, { splits: [{ ...s[0], earliest: '3:00' }, { ...s[1], earliest: '8:00' }] }).race;
    assert.deepEqual(ok.splits.map((x) => x.earliest), ['3:00', '8:00']);
    assert.deepEqual(updateRace(config, race.id, { splits: [{ ...s[0], earliest: '' }, { ...s[1], earliest: '8:00' }] }).race.splits.map((x) => x.earliest), ['', '8:00']);
    rejects(() => updateRace(config, race.id, { splits: [{ ...s[0], earliest: '8:0x' }, s[1]] }),
      /The earliest time of 1K, "8:0x", is not a race time\. Type it like 8:00 \(minutes:seconds\), or leave it empty\./);
    rejects(() => updateRace(config, race.id, { splits: [{ ...s[0], earliest: '9:00' }, { ...s[1], earliest: '8:00' }] }),
      /The earliest time of 2K \(8:00\) is before the earliest time of 1K \(9:00\)\. Earliest times must go up in course order\./);
    // the same time twice: a pass at it would skip to the later split, so the earlier one could never be reached
    rejects(() => updateRace(config, race.id, { splits: [{ ...s[0], earliest: '8:00' }, { ...s[1], earliest: '8:00' }] }),
      /The earliest time of 2K \(8:00\) is the same as the earliest time of 1K \(8:00\)\. Earliest times must go up/);
    // minutes:seconds, as the panel asks: "8" could be 8 seconds or 8 minutes
    rejects(() => updateRace(config, race.id, { splits: [{ ...s[0], earliest: '8' }, s[1]] }), /The earliest time of 1K, "8", is not a race time/);
    assert.deepEqual(updateRace(config, race.id, { splits: [{ ...s[0], earliest: '1:02:03' }, { ...s[1], earliest: '1:10:00.5' }] }).race.splits.map((x) => x.earliest), ['1:02:03', '1:10:00.5']);
    const { config: fixed, notes } = normalizeConfig({ races: [{ name: 'A', splits: [{ name: '1K', earliest: 'soon' }] }] });
    assert.equal(fixed.races[0].splits[0].earliest, '');
    assert.match(notes.join(' '), /earliest time "soon" of A 1K could not be read, so it was cleared/);
  });

  test('V1: Active races that want the same reads are never split silently: the first keeps them, the later ones are unticked', () => {
    const { config } = normalizeConfig({
      input: { ports: [5565, 5566] },
      races: [
        { id: 'r_a', name: 'Girls 5K', eventNumber: '1', inputPort: 5565 },
        { id: 'r_b', name: 'Boys 5K', eventNumber: '2', inputPort: 5565 },
        { id: 'r_c', name: 'JV', eventNumber: '3', inputPort: 5566, contests: ['JV'] },
        { id: 'r_d', name: 'JV copy', eventNumber: '4', inputPort: null, contests: ['jv'] },
        { id: 'r_e', name: 'Open', eventNumber: '5', inputPort: null },
        { id: 'r_f', name: 'Open copy', eventNumber: '6', inputPort: null },
        { id: 'r_g', name: 'Masters', eventNumber: '1', inputPort: null, contests: ['M'] },
        { id: 'r_h', name: 'Paused twin', eventNumber: '7', inputPort: 5565, active: false },
      ],
    });
    const { config: next, unticked } = settleConflicts(config);
    assert.deepEqual(unticked.map((u) => [u.raceName, u.keptName, u.why]), [
      ['Boys 5K', 'Girls 5K', 'both take port 5565'],
      ['JV copy', 'JV', "both list contest 'jv'"],
      ['Open copy', 'Open', 'both take every contest'],
      ['Masters', 'Girls 5K', 'both use Event 1-1-1'],
    ]);
    assert.deepEqual(next.races.filter((r) => r.active).map((r) => r.name), ['Girls 5K', 'JV', 'Open']);
    assert.equal(config.races[1].active, true, 'the config given is not changed');
    assert.deepEqual(settleConflicts(next).unticked, [], 'settled settings stay as they are');
  });

  test('activate (9.15 L3): "Switch to Boys 5K" ticks Active and unticks the Active races that want the same reads', () => {
    let cfg = updateSettings(defaultConfig(), { input: { ports: [5565, 5566] } });
    cfg = addRace(cfg, { name: 'Girls 5K', eventNumber: '1' }).config;
    cfg = addRace(cfg, { name: 'Boys 5K', eventNumber: '2', active: false }).config;
    cfg = addRace(cfg, { name: 'Other port', eventNumber: '3', inputPort: 5566 }).config;
    const [girls, boys, other] = cfg.races;
    const r = activateRace(cfg, boys.id);
    assert.deepEqual(r.unticked, [{ raceId: girls.id, raceName: 'Girls 5K', why: 'both take port 5565' }]);
    assert.deepEqual(r.config.races.map((x) => [x.name, x.active]), [['Girls 5K', false], ['Boys 5K', true], ['Other port', true]]);
    assert.equal(r.race.id, boys.id);
    assert.deepEqual(activateRace(r.config, boys.id).unticked, [], 'already Active and alone: nothing to switch off');
    assert.equal(other.active, true);
    rejects(() => activateRace(cfg, 'r_gone'), /no race with id "r_gone"/, 404);
    // a port that is not an input any more is refused, not switched to
    const gone = normalizeConfig({ races: [{ id: 'r_x', name: 'Old', inputPort: 5599, active: false }] }).config;
    rejects(() => activateRace(gone, 'r_x'), /Port 5599 is not one of the RR12 input ports/);
  });

  test('restore (9.15 V2, "Put it back"): a missing race comes back from its race file, checked as a start checks it', () => {
    let cfg = updateSettings(defaultConfig(), { input: { ports: [5565, 5566] } });
    cfg = addRace(cfg, { name: 'Girls 5K', eventNumber: '1' }).config;
    const saved = { id: 'r_back', name: 'Boys 5K', eventNumber: '2', inputPort: 5566, contests: [], gun: '10:00:00.000',
      splits: [{ id: 's_b1', name: '1K', sources: [], earliest: '' }], finishSources: [], active: true };
    const r = restoreRace(cfg, saved, 'r_back');
    assert.deepEqual([r.race.id, r.race.name, r.race.active, r.renamedFrom, r.why], ['r_back', 'Boys 5K', true, null, null]);
    assert.equal(r.race.splits[0].id, 's_b1', 'its split ids are kept: what the outputs have stays matched');
    assert.equal(r.config.races.length, 2);
    // it would take the port of an Active race: back, but not Active
    const clash = restoreRace(cfg, { ...saved, inputPort: 5565 }, 'r_back');
    assert.equal(clash.race.active, false);
    assert.equal(clash.why, "it and 'Girls 5K' both take port 5565, and 'Girls 5K' is Active");
    // a name taken meanwhile gets " (put back)"; its event clashing with another race is said
    const twin = restoreRace(cfg, { ...saved, name: 'girls 5k', eventNumber: '1' }, 'r_back');
    assert.deepEqual([twin.race.name, twin.renamedFrom, twin.race.active], ['girls 5k (put back)', 'girls 5k', false]);
    assert.match(twin.why, /both use Event 1-1-1/);
    // the race with its event is not Active: still two races on one event, so it comes back not Active and says why
    const paused = updateRace(cfg, cfg.races[0].id, { active: false }).config;
    const quiet = restoreRace(paused, { ...saved, eventNumber: '1' }, 'r_back');
    assert.deepEqual([quiet.race.active, quiet.why], [false, "it and 'Girls 5K' both use Event 1-1-1: give one of them its own event, round or heat"]);
    assert.throws(() => restoreRace(cfg, null, 'r_back'), (e) => e.status === 409 && /has no settings saved/.test(e.message));
    assert.throws(() => restoreRace(r.config, saved, 'r_back'), (e) => e.status === 409 && /in the settings already/.test(e.message));
  });

  test('deleting a race takes it out of outputs that send several races, never turning one into "all races"', () => {
    let { config, race: a } = withRace({ contests: ['A'] });
    const b = addRace(config, { name: 'B', contests: ['B'], inputPort: null });
    config = b.config;
    config = addOutput(config, { name: 'Two', races: [a.id, b.race.id], script: SCRIPT }).config;
    config = addOutput(config, { name: 'One', races: [a.id], script: SCRIPT }).config;
    const after = deleteRace(config, a.id);
    assert.deepEqual(after.races.map((r) => r.name), ['B']);
    assert.deepEqual(after.outputs.find((o) => o.name === 'Two').races, [b.race.id]);
    assert.deepEqual(after.outputs.find((o) => o.name === 'One').races, [a.id], 'kept: [] would mean every race');
    // ...and that output can still be switched off without fixing its race list first
    const one = after.outputs.find((o) => o.name === 'One');
    assert.equal(updateOutput(after, one.id, { enabled: false }).output.enabled, false);
    rejects(() => updateOutput(after, one.id, { races: [a.id] }), /race that no longer exists/);
  });

  test('outputs: defaults, validation and edits', () => {
    const { config, race } = withRace();
    const { config: c2, output } = addOutput(config, { name: 'TrackScore', script: SCRIPT, races: [race.id] });
    assert.deepEqual({ ...output, id: '' }, {
      id: '', name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: 5555, script: SCRIPT,
      stage: 'results', races: [race.id], eventNumber: 'race', precision: 3, mid: '',
    });
    assert.match(output.id, /^o_/);
    rejects(() => addOutput(c2, { name: 'trackscore', script: SCRIPT }), /already an output called "trackscore"/);
    rejects(() => addOutput(c2, { name: 'X', host: '', script: SCRIPT }), /Type the IP address/);
    rejects(() => addOutput(c2, { name: 'X', port: 70000 }), /port must be a whole number from 1 to 65535/);
    rejects(() => addOutput(c2, { name: 'X', script: 'XCScore.lss' }), /full path of the \.lss script/);
    rejects(() => addOutput(c2, { name: 'X', mid: '81a' }), /digits only/);
    rejects(() => addOutput(c2, { name: 'X', precision: 4 }), /Decimals must be 1, 2 or 3/);
    rejects(() => addOutput(c2, { name: 'X', mode: 'tcp-server', port: 5565 }), /Port 5565 is an RR12 input port/);
    assert.equal(addOutput(c2, { name: 'Board', mode: 'tcp-server', port: 6000 }).output.host, '0.0.0.0');
    const edited = updateOutput(c2, output.id, { mid: '8132', precision: '2' }).output;
    assert.equal(edited.mid, '8132');
    assert.equal(edited.precision, 2);
    assert.equal(edited.script, SCRIPT);
    rejects(() => updateOutput(c2, 'o_gone', {}), /no output with id "o_gone"/, 404);
    // 9.24: "Send a clearing line when a split is taken back" is off for every output and kept only when ticked
    assert.equal('clearLines' in output, false);
    const clr = updateOutput(c2, output.id, { clearLines: true });
    assert.equal(clr.output.clearLines, true);
    assert.equal('clearLines' in updateOutput(clr.config, output.id, { clearLines: false }).output, false);
    assert.deepEqual(deleteOutput(c2, output.id).outputs, []);
  });

  test('settings: partial sections, numbers from form fields, plain-English errors', () => {
    const base = defaultConfig();
    const next = updateSettings(base, { filter: { holdSec: '2,5' }, panel: { allowLan: true } });
    assert.deepEqual(next.filter, { tagWindowSec: 10, holdSec: 2.5, startIgnoreSec: 60 });
    assert.deepEqual(next.panel, { port: 5590, allowLan: true });
    assert.deepEqual(base.filter, { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 60 }, 'the old config is untouched');
    // the start area (s2 P1): 0 switches it off, up to 1800 s
    assert.equal(updateSettings(base, { filter: { startIgnoreSec: '0' } }).filter.startIgnoreSec, 0);
    assert.equal(updateSettings(base, { filter: { startIgnoreSec: 1800 } }).filter.startIgnoreSec, 1800);
    assert.equal(updateSettings(base, { filter: { startIgnoreSec: '45,5' } }).filter.startIgnoreSec, 45.5);
    rejects(() => updateSettings(base, { filter: { startIgnoreSec: 1801 } }), /Ignore reads in the first … s" must be a number of seconds from 0 to 1800 \(0 = off\)/);
    rejects(() => updateSettings(base, { filter: { startIgnoreSec: -1 } }), /from 0 to 1800/);
    rejects(() => updateSettings(base, { filter: { startIgnoreSec: 'soon' } }), /from 0 to 1800/);
    rejects(() => updateSettings(base, { input: { port: 0 } }), /"0" can't be an RR12 input port: use a whole number from 1024 to 65535/);
    rejects(() => updateSettings(base, { panel: { port: 5565 } }), /both 5565\. Use two different ports/);
    rejects(() => updateSettings(base, { input: { delimiter: '\t' } }), /separator can't be a line break, a tab/);
    rejects(() => updateSettings(base, { input: { columns: ['bib', 'time', 'bib'] } }), /"Timing point name" column[\s\S]*"Bib" is in the column order 2 times/);
    rejects(() => updateSettings(base, { filter: { tagWindowSec: 601 } }), /tag filter window/);
    rejects(() => updateSettings(base, { names: { pplPath: 'Lynx.ppl' } }), /full path of the names file/);
    rejects(() => updateSettings(base, { lif: { enabled: true } }), /Choose the FinishLynx folder[\s\S]*Choose a folder for the merged/);
    rejects(() => updateSettings(base, { lif: { inputDir: String.raw`C:\Lynx\Meet`, outputDir: String.raw`c:\lynx\meet\merged` } }),
      /can't be the FinishLynx folder or a folder inside it/);
    rejects(() => updateSettings(base, { colour: 'red' }), /no setting called "colour"/);
    const lif = updateSettings(base, { lif: { enabled: true, inputDir: String.raw`\\192.168.0.5\Lynx\Meet`, outputDir: `"${String.raw`C:\Lynx\Merged`}"` } }).lif;
    assert.deepEqual(lif, { enabled: true, inputDir: String.raw`\\192.168.0.5\Lynx\Meet`, outputDir: String.raw`C:\Lynx\Merged`, fillPlaces: false });
  });

  test("the engine's gun patch is stored as given", () => {
    const { config, race } = withRace();
    const next = patchRace(config, race.id, { gun: '10:00:00.000' });
    assert.equal(next.races[0].gun, '10:00:00.000');
    assert.equal(config.races[0].gun, '');
  });
});

describe('the settings file', () => {
  test('first run creates a default file; later runs read it back', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.json');
    const cf = new ConfigFile({ file });
    const r = cf.load();
    assert.equal(r.created, true);
    assert.deepEqual(r.config, defaultConfig());
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), defaultConfig());
    assert.ok(fs.existsSync(file + '.bak'));
    const again = new ConfigFile({ file }).load();
    assert.equal(again.created, false);
    assert.deepEqual(again.config, defaultConfig());
  });

  test('saves are atomic, coalesced and leave no temp files', async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.json');
    const cf = new ConfigFile({ file });
    cf.load();
    let config = cf.config;
    const saves = [];
    for (let i = 0; i < 20; i++) {
      config = updateSettings(config, { filter: { holdSec: i } });
      saves.push(cf.set(config));
    }
    assert.equal(cf.config.filter.holdSec, 19, 'live at once');
    await Promise.all(saves);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).filter.holdSec, 19);
    assert.match(fs.readFileSync(file, 'utf8'), /\r\n/, 'CRLF for Notepad');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak']);
  });

  test('a damaged file is moved aside and the copy from the last start is used', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.json');
    const cf = new ConfigFile({ file });
    cf.load();
    cf.set(addRace(cf.config, { name: 'Kept race' }).config);
    return cf.flush().then(() => {
      new ConfigFile({ file }).load(); // a clean start: the .bak now has the race
      fs.writeFileSync(file, '{ "races": [ oops');
      const lines = [];
      const r = new ConfigFile({ file, log: (l) => lines.push(l) }).load();
      assert.deepEqual(r.config.races.map((x) => x.name), ['Kept race']);
      assert.match(r.notes.join(' '), /could not be read: it is not valid JSON[\s\S]*renamed to config\.broken-[\d-]+\.json[\s\S]*config\.json\.bak/);
      assert.ok(fs.readdirSync(dir).some((n) => /^config\.broken-.*\.json$/.test(n)), 'the broken file is kept for a human');
      assert.ok(lines.length >= 1);
    });
  });

  test('V2: a start that fell back to config.json.bak never overwrites it; a lost config.json comes back from it', async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.json');
    const bak = `${file}.bak`;
    const cf = new ConfigFile({ file });
    assert.equal(cf.load().source, 'new');
    cf.set(addRace(cf.config, { name: 'Girls 5K', eventNumber: '1' }).config);
    await cf.flush();
    assert.equal(new ConfigFile({ file }).load().source, 'file'); // a clean start: the .bak has Girls 5K
    const good = fs.readFileSync(bak, 'utf8');
    // damaged: the backup is used, and kept exactly as it was (it may be the only copy of the races wanted back)
    fs.writeFileSync(file, '{ "races": [ broken by a bad edit');
    const r = new ConfigFile({ file }).load();
    assert.equal(r.source, 'backup');
    assert.match(r.brokenFile, /^config\.broken-[\d-]+\.json$/);
    assert.deepEqual(r.config.races.map((x) => x.name), ['Girls 5K']);
    assert.equal(fs.readFileSync(bak, 'utf8'), good, 'config.json.bak not rewritten by the start that fell back to it');
    // damaged again, with a backup that is damaged too: empty settings, and neither copy is touched
    fs.writeFileSync(file, 'oops');
    fs.writeFileSync(bak, 'also oops');
    const e = new ConfigFile({ file }).load();
    assert.equal(e.source, 'empty');
    assert.equal(fs.readFileSync(bak, 'utf8'), 'also oops');
    // config.json gone while its backup is there: it was lost, not never made
    fs.writeFileSync(bak, good);
    fs.rmSync(file);
    const lost = new ConfigFile({ file }).load();
    assert.deepEqual([lost.source, lost.created], ['backup', false]);
    assert.deepEqual(lost.config.races.map((x) => x.name), ['Girls 5K']);
    assert.match(lost.notes.join(' '), /is missing\. Using the copy saved when Split Relay last started/);
    assert.equal(fs.readFileSync(bak, 'utf8'), good);
    // the next clean start keeps a fresh copy as before
    assert.equal(new ConfigFile({ file }).load().source, 'file');
  });

  test('a save that cannot be written says so, and the change stays live', async (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'config.json');
    const cf = new ConfigFile({ file });
    cf.load();
    fs.rmSync(dir, { recursive: true, force: true }); // the folder vanished under us
    const next = updateSettings(cf.config, { filter: { holdSec: 3 } });
    await assert.rejects(cf.set(next), (err) => err.status === 500 && /could not save it[\s\S]*lost when Split Relay restarts/.test(err.message));
    assert.equal(cf.config.filter.holdSec, 3);
    assert.match(cf.lastError, /could not save/);
  });
});

describe('race store', () => {
  test('save, load, coalescing and remove (moved to races\\deleted)', async (t) => {
    const dir = path.join(tempDir(t), 'races');
    const store = new RaceStore({ dir });
    assert.equal(store.load('r_none'), null);
    const writes = [];
    for (let i = 0; i < 50; i++) writes.push(store.save('r_a', { version: 1, n: i }));
    await Promise.all(writes);
    assert.deepEqual(store.load('r_a'), { version: 1, n: 49 });
    assert.deepEqual(fs.readdirSync(dir), ['r_a.json'], 'no temp files left');
    await store.remove('r_a');
    assert.equal(store.load('r_a'), null);
    const deleted = fs.readdirSync(path.join(dir, 'deleted'));
    assert.equal(deleted.length, 1);
    assert.match(deleted[0], /^r_a-[\d-]+\.json$/);
    await store.remove('r_never_saved'); // nothing to move: fine
    await store.flush();
  });

  test('a save queued behind a remove is not written; flush waits for everything', async (t) => {
    const dir = path.join(tempDir(t), 'races');
    const store = new RaceStore({ dir });
    store.save('r_b', { n: 1 });
    store.remove('r_b');
    await store.flush();
    assert.equal(store.load('r_b'), null);
  });

  test('a damaged race file is moved aside, never overwritten', (t) => {
    const dir = path.join(tempDir(t), 'races');
    const lines = [];
    const store = new RaceStore({ dir, log: (l) => lines.push(l) });
    fs.writeFileSync(path.join(dir, 'r_c.json'), '{"crossings": [');
    assert.equal(store.load('r_c'), null);
    assert.ok(fs.readdirSync(dir).some((n) => /^r_c\.broken-.*\.json$/.test(n)));
    assert.match(lines.join(' '), /damaged/);
  });

  test('odd ids cannot escape the folder; leftover temp files are swept', (t) => {
    const dir = path.join(tempDir(t), 'races');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'r_x.json.~123-4.tmp'), 'half');
    new RaceStore({ dir });
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(raceFileName('r_ok-1'), 'r_ok-1.json');
    assert.match(raceFileName('..\\..\\evil'), /^x_[0-9a-f]{20}\.json$/);
    assert.match(raceFileName('CON'), /^x_/);
  });

  test('writeFileAtomic replaces the whole file', async (t) => {
    const file = path.join(tempDir(t), 'f.json');
    await writeFileAtomic(file, 'a'.repeat(10000));
    await writeFileAtomic(file, 'b');
    assert.equal(fs.readFileSync(file, 'utf8'), 'b');
  });
});

describe('the meet section (DESIGN 9.22)', () => {
  test('normalizeConfig repairs it: a name without control characters, at most 80 characters; a usable web port', () => {
    const { config } = normalizeConfig({ meet: { name: ' Fall\u0001 Classic ', trackScoreWebPort: 'x' } });
    assert.deepEqual(config.meet, { name: 'Fall Classic', trackScoreWebPort: 5000 });
    assert.equal(normalizeConfig({ meet: { name: 'x'.repeat(90), trackScoreWebPort: '5001' } }).config.meet.name.length, 80);
    assert.equal(normalizeConfig({ meet: { trackScoreWebPort: '5001' } }).config.meet.trackScoreWebPort, 5001);
    assert.deepEqual(normalizeConfig({}).config.meet, { name: '', trackScoreWebPort: 5000 }, 'an older config.json gets it');
  });

  test('updateSettings: the name and the web port, refused in words; never a port that takes timing data (R8)', () => {
    const c = updateSettings(defaultConfig(), { meet: { name: 'Fall Classic 2026', trackScoreWebPort: 5080 } });
    assert.deepEqual(c.meet, { name: 'Fall Classic 2026', trackScoreWebPort: 5080 });
    rejects(() => updateSettings(c, { meet: { name: 'x'.repeat(81) } }), /^Keep the meet name to 80 characters\.$/);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 0 } }), /^TrackScore's web port must be a whole number from 1 to 65535\.$/);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 5555 } }),
      /^Port 5555 is where TrackScore takes the splits, not its web page\. TrackScore's web page is usually on port 5000\.$/);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 5556 } }), /^Port 5556 is TrackScore's clock port, not its web page\./);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 4560 } }), /^Port 4560 is one of TrackScore's timing ports, not its web page\./);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 5565 } }), /^Port 5565 is an RR12 input port of this Split Relay, not TrackScore's web page\./);
    rejects(() => updateSettings(c, { meet: { trackScoreWebPort: 5590 } }), /^Port 5590 is this Split Relay's control panel, not TrackScore's web page\./);
    const withOut = addOutput(c, { name: 'Karmarush', port: 6400, enabled: false }).config;
    rejects(() => updateSettings(withOut, { meet: { trackScoreWebPort: 6400 } }), /^Port 6400 is where the output "Karmarush" sends its splits, not TrackScore's web page\./);
    rejects(() => updateSettings(c, { meet: { bogus: 1 }, foo: {} }), /Split Relay has no setting called "foo"\. The settings are: input, filter, names, lif, panel, meet, entries\./);
  });
});

describe("the start lists' setting (DESIGN 9.25)", () => {
  test('entries.otherRace: "keep" is the default and is not stored; "send" is; anything else is refused in words', () => {
    assert.equal(normalizeConfig({}).config.entries, undefined);
    assert.equal(normalizeConfig({ entries: { otherRace: 'keep' } }).config.entries, undefined);
    assert.equal(normalizeConfig({ entries: { otherRace: 'nonsense' } }).config.entries, undefined);
    assert.deepEqual(normalizeConfig({ entries: { otherRace: 'send' } }).config.entries, { otherRace: 'send' });
    const sent = updateSettings(defaultConfig(), { entries: { otherRace: 'send' } });
    assert.deepEqual(sent.entries, { otherRace: 'send' });
    assert.equal('entries' in updateSettings(sent, { entries: { otherRace: 'keep' } }), false);
    assert.deepEqual(updateSettings(sent, { filter: { holdSec: 3 } }).entries, { otherRace: 'send' }, 'another section leaves it');
    rejects(() => updateSettings(defaultConfig(), { entries: { otherRace: 'both' } }), /^Athletes entered in another race: choose "keep" \(keep them off the boards\) or "send" \(send and flag\)\.$/);
  });
});

describe('split points that are counted but not sent (DESIGN 9.26)', () => {
  const three = () => withRace({ splits: [{ name: '4K' }, { name: '4.2K', collectOnly: true }, { name: '5K' }] });

  test('collectOnly is kept only when it is set, it is never the Pause, and a file from before reads as before', () => {
    const { config, race } = three();
    assert.deepEqual(race.splits.map((s) => [s.name, s.collectOnly, s.sending, 'collectOnly' in s]),
      [['4K', undefined, true, false], ['4.2K', true, true, true], ['5K', undefined, true, false]]);
    // hand-edited: "true" as text is taken, anything unclear is a sent split; a not-sent split is never paused
    const n = normalizeConfig({ races: [{ name: 'R', splits: [{ name: 'a', collectOnly: 'true', sending: false }, { name: 'b', collectOnly: 'yes' }, { name: 'c', sending: false }] }] }).config;
    assert.deepEqual(n.races[0].splits.map((s) => [s.collectOnly ?? false, s.sending]), [[true, true], [false, true], [false, false]]);
    // through the settings file and back
    assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))).config.races[0].splits, race.splits);
  });

  test('a race needs at least one split that is sent, said in the operator\'s words', () => {
    rejects(() => withRace({ splits: [{ name: '4K', collectOnly: true }, { name: '4.2K', collectOnly: true }] }),
      /^Every split of Girls Varsity 5K is set to Not sent, so nothing would go to TrackScore or Karmarush\. Switch Send on for at least one split\.$/);
    const { config, race } = three();
    rejects(() => updateRace(config, race.id, { splits: race.splits.map((s) => ({ ...s, collectOnly: true })) }), /^Every split of Girls Varsity 5K is set to Not sent/);
    assert.equal(allNotSentText(''), 'Every split of this race is set to Not sent, so nothing would go to TrackScore or Karmarush. Switch Send on for at least one split.');
    assert.deepEqual(sentSplits(race).map((s) => s.name), ['4K', '5K']);
    assert.deepEqual(sentSplits(null), []);
  });

  test('a save that does not say collectOnly keeps it; false sends the split again; anything else is refused', () => {
    const { config, race } = three();
    // the race editor of a panel from before, or a script: names only
    const renamed = updateRace(config, race.id, { splits: race.splits.map((s) => ({ id: s.id, name: `${s.name}!`, sources: [], earliest: '' })) }).race;
    assert.deepEqual(renamed.splits.map((s) => [s.name, s.collectOnly ?? false]), [['4K!', false], ['4.2K!', true], ['5K!', false]]);
    const back = updateRace(config, race.id, { splits: race.splits.map((s) => ({ id: s.id, name: s.name, collectOnly: false })) }).race;
    assert.equal(back.splits.some((s) => 'collectOnly' in s), false);
    const on = updateRace(config, race.id, { splits: race.splits.map((s, i) => ({ id: s.id, name: s.name, collectOnly: i === 0 })) }).race;
    assert.deepEqual(on.splits.map((s) => s.collectOnly ?? false), [true, false, false]);
    rejects(() => updateRace(config, race.id, { splits: [{ id: race.splits[0].id, name: '4K', collectOnly: 'no' }] }), /^Say whether 4K is sent with "collectOnly": true \(counted, not sent\) or false \(sent\)\.$/);
    // a new split in the middle, not sent, keeps the others' ids
    const mid = updateRace(config, race.id, { splits: [race.splits[0], { name: '4.1K', collectOnly: true }, race.splits[1], race.splits[2]] }).race;
    assert.deepEqual(mid.splits.map((s) => [s.name, s.collectOnly ?? false, race.splits.find((o) => o.id === s.id)?.name ?? 'new']),
      [['4K', false, '4K'], ['4.1K', true, 'new'], ['4.2K', true, '4.2K'], ['5K', false, '5K']]);
  });

  test('a split that is not sent has nothing to pause or play', () => {
    const { config, race } = three();
    rejects(() => setSplitSending(config, race.id, race.splits[1].id, false),
      /^4\.2K is set to Not sent: it is counted, and nothing of it goes out, so there is nothing to pause or play\. To send it, switch Send on for 4\.2K on the race's page\.$/, 409);
    assert.equal(setSplitSending(config, race.id, race.splits[0].id, false).changed, true);
    // a paused split that is switched to Not sent is no longer paused: sent again later, it plays
    const paused = setSplitSending(config, race.id, race.splits[0].id, false).config;
    const quiet = updateRace(paused, race.id, { splits: paused.races[0].splits.map((s, i) => ({ ...s, collectOnly: i < 2 })) }).race;
    assert.deepEqual(quiet.splits.map((s) => [s.collectOnly ?? false, s.sending]), [[true, true], [true, true], [false, true]]);
  });
});
