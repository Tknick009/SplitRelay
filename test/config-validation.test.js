// Config validation added in revision 2 (DESIGN.md section 9.8): races that TrackScore and the .lif files could not
// tell apart, and paths that are not full paths.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, normalizeConfig, updateSettings, addRace, updateRace, addOutput, updateOutput, ConfigError } from '../src/config.js';

/** Throws a ConfigError whose message matches. */
function rejects(fn, re) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${err}`);
    assert.equal(err.status, 400);
    assert.match(err.message, re);
    return true;
  });
}

// Races that take their reads by contest (SR lines), not by an RR12 input port: several of them can be Active at once.
const girls = { name: 'Girls Varsity 5K', eventNumber: '3', round: '1', heat: '1', contests: ['Girls Varsity 5K'], inputPort: null };
const SAME_EVENT = /both use Event 3-1-1: TrackScore and the \.lif files can't tell them apart/;

describe('event, round and heat are unique (ux-walkthrough F4)', () => {
  test('a second race on the same event is refused, however the numbers are typed', () => {
    const { config } = addRace(defaultConfig(), girls);
    // What "Duplicate race" in the panel produces: the copy keeps 3-1-1.
    rejects(() => addRace(config, { ...girls, name: 'Boys Varsity 5K', contests: ['Boys Varsity 5K'] }), SAME_EVENT);
    rejects(() => addRace(config, { inputPort: null, name: 'Boys', eventNumber: '003', round: '01', heat: '01', contests: ['B'] }),
      /"Boys" and "Girls Varsity 5K" both use Event 3-1-1/);
    // Round and heat left blank mean 1, as FinishLynx numbers them.
    rejects(() => addRace(config, { inputPort: null, name: 'Boys', eventNumber: '3', round: '', heat: '', contests: ['B'] }), SAME_EVENT);
    // A paused race still has its .lif file matched and its event number sent.
    rejects(() => addRace(config, { inputPort: null, name: 'Boys', eventNumber: '3', contests: ['B'], active: false }), SAME_EVENT);
  });

  test('another heat, round or event is fine, and races without an event number are not compared', () => {
    let { config } = addRace(defaultConfig(), girls);
    config = addRace(config, { ...girls, name: 'Girls heat 2', heat: '2', contests: ['G2'] }).config;
    config = addRace(config, { ...girls, name: 'Girls round 2', round: '2', contests: ['G3'] }).config;
    config = addRace(config, { ...girls, name: 'Boys', eventNumber: '4', contests: ['B'] }).config;
    config = addRace(config, { inputPort: null, name: 'No number A', eventNumber: '', contests: ['X'] }).config;
    config = addRace(config, { inputPort: null, name: 'No number B', eventNumber: '', contests: ['Y'] }).config;
    assert.equal(config.races.length, 6);
    // Letters compare without case: "3A" and "3a" are the same event.
    config = addRace(config, { inputPort: null, name: 'Open A', eventNumber: '3A', contests: ['Z'] }).config;
    rejects(() => addRace(config, { inputPort: null, name: 'Open a', eventNumber: '3a', contests: ['W'] }), /both use Event 3a-1-1/);
  });

  test('an edit that moves a race onto another race\'s event is refused', () => {
    let { config } = addRace(defaultConfig(), girls);
    const boys = addRace(config, { ...girls, name: 'Boys', eventNumber: '4', contests: ['B'] });
    config = boys.config;
    rejects(() => updateRace(config, boys.race.id, { eventNumber: '3' }), /"Boys" and "Girls Varsity 5K" both use Event 3-1-1/);
    assert.equal(updateRace(config, boys.race.id, { eventNumber: '3', heat: '2' }).race.heat, '2');
  });

  test('a settings file that already has two races on one event can still pause or rename them', () => {
    const { config } = normalizeConfig({ races: [{ ...girls, id: 'r_a' }, { ...girls, id: 'r_b', name: 'Copy', contests: ['C'] }] });
    assert.equal(updateRace(config, 'r_b', { active: false }).race.active, false);
    assert.equal(updateRace(config, 'r_b', { name: 'Boys' }).race.name, 'Boys');
    // Saving the race form sends the event number: then the operator is told to fix it.
    rejects(() => updateRace(config, 'r_b', { eventNumber: '3', name: 'Boys' }), /"Boys" and "Girls Varsity 5K" both use Event 3-1-1/);
    // ...and the two can't both be Active: a LapTime line with FinishLynx's event picks the race by it (9.15 L3)
    const paused = updateRace(config, 'r_b', { active: false }).config;
    rejects(() => updateRace(paused, 'r_b', { active: true }), /"Copy" and "Girls Varsity 5K" both use Event 3-1-1: only one of them can be Active/);
  });
});

describe('paths are full paths: a drive letter or \\\\server\\share (review-edges F3)', () => {
  const ONE_BACKSLASH = /starts with a single (back)?slash\. A network path starts with two backslashes/;

  test('a network path that lost one backslash is refused for every folder and file setting', () => {
    const base = defaultConfig();
    rejects(() => updateSettings(base, { lif: { outputDir: String.raw`\192.168.0.5\Lynx\Merged` } }), ONE_BACKSLASH);
    rejects(() => updateSettings(base, { lif: { inputDir: String.raw`\192.168.0.5\Lynx\Meet` } }), ONE_BACKSLASH);
    rejects(() => updateSettings(base, { names: { pplPath: String.raw`\Lynx\Lynx.ppl` } }), ONE_BACKSLASH);
    rejects(() => addOutput(base, { name: 'TS', script: String.raw`\Lynx\XCScore.lss` }), ONE_BACKSLASH);
    const { config, output } = addOutput(base, { name: 'TS', script: String.raw`C:\Lynx\XCScore.lss` });
    // On Windows '/Lynx' is root-relative too; elsewhere it is that system's only kind of full path.
    if (process.platform === 'win32') rejects(() => updateOutput(config, output.id, { script: '/Lynx/XCScore.lss' }), ONE_BACKSLASH);
    else assert.equal(updateOutput(config, output.id, { script: '/Lynx/XCScore.lss' }).output.script, '/Lynx/XCScore.lss');
  });

  test('relative and drive-relative paths, and a share without its folder, are refused in plain words', () => {
    const base = defaultConfig();
    rejects(() => updateSettings(base, { lif: { outputDir: 'Merged' } }), /Type the full path of the merged \.lif folder, for example C:\\Lynx\\Merged/);
    rejects(() => updateSettings(base, { lif: { outputDir: 'C:Merged' } }), /Type the full path of the merged \.lif folder/);
    rejects(() => updateSettings(base, { lif: { inputDir: String.raw`\\192.168.0.5` } }), /missing the shared folder's name/);
  });

  test('drive and network paths are accepted as typed (quotes from "Copy as path" removed)', () => {
    const next = updateSettings(defaultConfig(), {
      lif: { enabled: true, inputDir: String.raw`\\192.168.0.5\Lynx\Meet`, outputDir: `"${String.raw`D:/Lynx/Merged`}"` },
      names: { pplPath: String.raw`\\timing-pc\Lynx\Lynx.ppl` },
    });
    assert.equal(next.lif.inputDir, String.raw`\\192.168.0.5\Lynx\Meet`);
    assert.equal(next.lif.outputDir, 'D:/Lynx/Merged');
    assert.equal(next.names.pplPath, String.raw`\\timing-pc\Lynx\Lynx.ppl`);
    // Clearing a path is always allowed.
    assert.equal(updateSettings(next, { names: { pplPath: '' } }).names.pplPath, '');
  });
});
