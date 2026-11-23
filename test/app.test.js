// Control panel logic (public/app.js). The panel only boots in a browser; its pure helpers are exported so the
// decisions behind every warning, prompt and dialog can be checked here. A few DOM helpers run against the small
// fake document below, which is just enough of the DOM for h() and focus handling.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, RESEND_LIMIT as SERVER_RESEND_LIMIT, LONE_TEXT as SERVER_LONE_TEXT, sentOldText as serverSentOldText,
  sentAfterText as serverSentAfterText, howText as serverHowText, IGNORED_TEXT as SERVER_IGNORED_TEXT, MARKED_FINISH_TEXT as SERVER_MARKED_FINISH_TEXT, STOPPED_TEXT as SERVER_STOPPED_TEXT,
  MAX_RACE_TICKS_TYPED as SERVER_MAX_RACE_TICKS_TYPED, COUNTED_TEXT as SERVER_COUNTED_TEXT, lateMergedText as serverLateMergedText } from '../src/engine.js';
import { LAPTIME_EXPRESSION as SERVER_LAPTIME_EXPRESSION } from '../src/input.js';
import { MAX_INPUT_PORTS as SERVER_MAX_INPUT_PORTS, MAX_SPLITS_SET as SERVER_MAX_SPLITS, allNotSentText as serverAllNotSentText } from '../src/config.js';
import { raceRunning as serverRaceRunning, trackScoreToMeet } from '../src/meet.js';

class Node {}
class FakeText extends Node {
  constructor(t) {
    super();
    this.data = String(t);
    this.parentNode = null;
  }
  get textContent() { return this.data; }
}
class FakeEl extends Node {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.listeners = {};
    this.className = '';
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); }
  // like the real DOM: anything that isn't a node becomes a text node, so null turns into the text "null"
  append(...ns) {
    for (const n of ns) {
      const node = n instanceof Node ? n : new FakeText(String(n));
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...ns) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...ns);
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(t) { this.replaceChildren(...(t ? [String(t)] : [])); }
  focus() { doc.activeElement = this; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === doc.body;
  }
  *walk() {
    for (const c of this.childNodes) {
      if (c instanceof FakeEl) {
        yield c;
        yield* c.walk();
      }
    }
  }
  querySelector(sel) {
    const id = /^#([\w-]+)$/.exec(sel);
    if (id) {
      for (const e of this.walk()) if (e.getAttribute('id') === id[1]) return e;
      return null;
    }
    const m = /^\[([\w-]+)="(.*)"\]$/.exec(sel);
    if (!m) throw new Error('fake DOM: unsupported selector ' + sel);
    for (const e of this.walk()) if (e.getAttribute(m[1]) === m[2]) return e;
    return null;
  }
}
const doc = {
  body: new FakeEl('body'),
  activeElement: null,
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => new FakeText(t),
  querySelector: (sel) => doc.body.querySelector(sel),
};
doc.activeElement = doc.body;

let A;
before(async () => {
  // no `window`: the panel must not boot
  globalThis.Node = Node;
  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s) };
  A = await import('../public/app.js');
});

const T = 10000; // ticks per second
const tod = (h, m, s, ms = 0) => ((h * 60 + m) * 60 + s) * T + ms * 10;
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0);

function race(id, extra = {}) {
  return { id, name: id.toUpperCase(), eventNumber: '', round: '1', heat: '1', distance: '', contests: [], gun: '',
    splits: [{ id: id + 's1', name: '1K', sources: ['1K-A'] }], finishSources: [], active: true, ...extra };
}
function view(id, extra = {}) {
  return { id, name: id.toUpperCase(), gunTicks: null, gunText: '', elapsedTicks: null, splits: [], runners: 0, finished: 0,
    pending: 0, unmapped: [], lastReadAt: null, lynxStart: null, ...extra };
}
const TRACKSCORE = { id: 'o_ts', name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: 5555,
  script: 'C:\\Lynx\\XCScore.lss', stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' };
const LIVE = { id: 'o_live', name: 'Live results', enabled: true, mode: 'tcp-client', host: '10.0.0.9', port: 7000,
  script: 'C:\\Lynx\\Karmarush-Track.lss', stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' };
function state({ races = [], views = [], outputs = [], statuses = [], input = {}, seen } = {}) {
  return {
    version: 1, now: NOW, addresses: ['192.168.0.21'],
    config: { input: { port: 5565 }, races, outputs, lif: { enabled: true }, names: { pplPath: '' }, panel: { port: 5590 } },
    input: { listening: true, port: 5565, connections: [{ id: 1 }], lastLineAt: NOW - 1000, ...input },
    outputs: statuses, races: views, seen: seen || { locations: [], contests: [] },
  };
}

describe('status words (new outcomes of DESIGN.md §9.3/9.4)', () => {
  test('after-finish, out-of-order and finished-not-sent have words, a colour and a glossary line', () => {
    for (const k of ['after-finish', 'out-of-order', 'finished-not-sent']) {
      const info = A.statusInfo(k);
      assert.ok(info.label && info.label !== k, `${k} has a word`);
      assert.ok(['ok', 'info', 'warn', 'bad', 'muted', 'finish'].includes(info.tone), `${k} has a tone`);
      assert.ok(info.meaning.length > 40, `${k} has a glossary line`);
      assert.ok(A.STATUS_ORDER.includes(k), `${k} is in the legend and the glossary`);
    }
    assert.match(A.statusInfo('finished-not-sent').meaning, /merged \.lif/);
  });

  test('"Race paused" says the read is kept and sent once the race is Active (§9.2: reads are never thrown away)', () => {
    const m = A.statusInfo('paused').meaning;
    assert.match(m, /kept/);
    assert.match(m, /Active/);
    assert.doesNotMatch(m, /not taking reads/);
    const t = A.resendDialogText(state({ races: [race('a', { active: false })], views: [view('a')] }), 'a');
    assert.ok(t.body.every((line) => !/not taking reads/.test(line)), 'the resend dialog does not claim the race ignores reads');
  });
});

describe('FeedStore: entries updated in place (§9.7)', () => {
  test('a re-emitted entry replaces its row and keeps its position, even when its time changes', () => {
    const f = new A.FeedStore();
    f.upsert({ id: 1, at: 1000, status: 'waiting-gun' });
    f.upsert({ id: 2, at: 2000, status: 'sent' });
    f.upsert({ id: 1, at: 5000, status: 'sent', raceTicks: 3000000, place: 1 });
    assert.deepEqual(f.list().map((e) => [e.id, e.status]), [[2, 'sent'], [1, 'sent']]);
    assert.equal(f.size, 2);
  });

  test('a reset keeps what the live stream delivered after the stream opened and drops the rest', () => {
    const f = new A.FeedStore();
    f.upsert({ id: 'old', at: 1000, status: 'sent' }); // from before the reconnect: Split Relay may have restarted
    const mark = f.stamp;
    f.upsert({ id: 7, at: 3000, status: 'sent' }); // a 'feed' event after the stream opened: the newest copy
    f.resetTo([{ id: 7, at: 3000, status: 'waiting-gun' }, { id: 6, at: 2000, status: 'held' }], mark);
    assert.deepEqual(f.list().map((e) => [e.id, e.status]), [[7, 'sent'], [6, 'held']]);
  });
});

describe('race warnings', () => {
  test('ux-walkthrough/F2: reads before the gun are shown from RaceView.beforeGun', () => {
    const st = state({ races: [race('r1')], views: [view('r1', { gunTicks: tod(10, 5, 0), gunText: '10:05:00.000', beforeGun: 3, waitingGun: 0 })] });
    const ws = A.raceWarnings(st.races[0], st.config.races[0], st, NOW, []);
    const w = ws.find((x) => /before the gun time/.test(x.text));
    assert.ok(w, 'a before-gun warning without any feed rows');
    assert.match(w.text, /3 reads are before the gun time 10:05:00\.000/);
    assert.equal(w.action.href, '#races/r1/gun');
  });

  test('ux-walkthrough/F2: waiting reads are counted from waitingGun', () => {
    const rv = view('r1', { waitingGun: 4, pending: 0 });
    assert.equal(A.waitingCount(rv), 4);
    const st = state({ races: [race('r1')], views: [rv] });
    assert.match(A.raceWarnings(rv, st.config.races[0], st, NOW)[0].text, /^4 reads are waiting for the gun/);
  });

  test('ux-walkthrough/F3: a catch-all race receiving several contests says which, with counts', () => {
    const rv = view('r1', { contestsSeen: [{ name: 'Girls Varsity 5K', count: 7 }, { name: 'Boys Varsity 5K', count: 1 }] });
    const st = state({ races: [race('r1')], views: [rv] });
    const w = A.raceWarnings(rv, st.config.races[0], st, NOW).find((x) => /takes every contest/.test(x.text));
    assert.ok(w);
    assert.match(w.text, /Girls Varsity 5K \(7 reads\) and Boys Varsity 5K \(1 read\)/);
    const one = view('r1', { contestsSeen: [{ name: 'Girls Varsity 5K', count: 7 }] });
    assert.equal(A.raceWarnings(one, st.config.races[0], st, NOW).some((x) => /takes every contest/.test(x.text)), false);
  });

  test('ux-walkthrough/F3: without contestsSeen, the unclaimed seen contests stand in', () => {
    const races = [race('r1'), race('r2', { contests: ['JV 4K'] })];
    const seen = { locations: [], contests: [{ name: 'Girls 5K', count: 3, lastAt: NOW }, { name: 'Boys 5K', count: 2, lastAt: NOW }, { name: 'JV 4K', count: 9, lastAt: NOW }] };
    const st = state({ races, views: [view('r1'), view('r2')], seen });
    const w = A.raceWarnings(st.races[0], races[0], st, NOW).find((x) => /takes every contest/.test(x.text));
    assert.ok(w);
    assert.doesNotMatch(w.text, /JV 4K/);
  });

  test('ux-walkthrough/F4: two races with the same event, round and heat are flagged on both', () => {
    const races = [race('girls', { name: 'Girls Varsity 5K', eventNumber: '3' }), race('boys', { name: 'Boys Varsity 5K', eventNumber: '003', round: '' })];
    const st = state({ races, views: [view('girls'), view('boys')] });
    for (const r of races) {
      const w = A.raceWarnings(viewOf(st, r.id), r, st, NOW).find((x) => /can't tell them apart/.test(x.text));
      assert.ok(w, `flagged on ${r.name}`);
      assert.equal(w.tone, 'bad');
      assert.match(w.text, /Girls Varsity 5K/);
      assert.match(w.text, /Boys Varsity 5K/);
      assert.match(w.text, /all use Event 0*3-1-1/);
    }
  });

  test('lif-ground-truth/F2: a gun more than 1 ms from the FinishLynx start is red, with a one-click fix', () => {
    const races = [race('r1', { eventNumber: '1' })];
    const off = view('r1', { gunTicks: tod(12, 58, 50, 500), gunText: '12:58:50.500', lynxStart: tod(12, 58, 49) + 2595 });
    const st = state({ races, views: [off] });
    const w = A.raceWarnings(off, races[0], st, NOW).find((x) => /FinishLynx start/.test(x.text));
    assert.ok(w);
    assert.equal(w.tone, 'bad');
    assert.match(w.text, /by 1\.2405 s/);
    assert.match(w.text, /short/);
    assert.deepEqual(w.action, { label: 'Check the gun time', cmd: 'lynx-gun', raceId: 'r1' });
    const close = view('r1', { gunTicks: tod(12, 58, 49) + 2600, gunText: '12:58:49.260', lynxStart: tod(12, 58, 49) + 2595 });
    assert.equal(A.gunDiffers(close), false, '0.5 ms is rounding, not a different start');
    assert.equal(A.raceWarnings(close, races[0], st, NOW).some((x) => /FinishLynx start/.test(x.text)), false);
  });

  test("lif-ground-truth/F5: a race name that isn't FinishLynx's event name is flagged with a one-click rename", () => {
    const races = [race('r1', { name: 'Race 1', eventNumber: '1' })];
    const rv = view('r1', { lynxName: 'Boys Gold' });
    const st = state({ races, views: [rv] });
    const w = A.raceWarnings(rv, races[0], st, NOW).find((x) => /exactly as FinishLynx/.test(x.text));
    assert.ok(w);
    assert.deepEqual(w.action, { label: 'Use “Boys Gold”', cmd: 'lynx-name', raceId: 'r1', value: 'Boys Gold' });
    const same = view('r1', { lynxName: 'Race 1' });
    assert.equal(A.raceWarnings(same, races[0], st, NOW).some((x) => /exactly as FinishLynx/.test(x.text)), false);
  });

  test("race-day-sim/F6: a running race TrackScore isn't getting offers to move TrackScore over", () => {
    const races = [race('a'), race('b', { contests: ['B'] })];
    const ts = { ...TRACKSCORE, races: ['a'] };
    const vb = view('b', { gunTicks: tod(10, 0, 0), gunText: '10:00:00.000', elapsedTicks: 60 * T });
    const st = state({ races, views: [view('a'), vb], outputs: [ts, LIVE], statuses: [{ id: 'o_ts', state: 'connected', scriptOk: true, scriptInfo: { mid: null } }] });
    const w = A.raceWarnings(vb, races[1], st, NOW).find((x) => x.action?.cmd === 'output-race');
    assert.ok(w, 'warned');
    assert.deepEqual(w.action, { label: 'TrackScore gets this race', cmd: 'output-race', outputId: 'o_ts', raceId: 'b' });
  });
});

const viewOf = (st, id) => st.races.find((r) => r.id === id);

describe('global warnings', () => {
  test('race-day-sim/F6: TrackScore on all races with two active races is red and carries a race picker', () => {
    const races = [race('a', { name: 'Girls 5K' }), race('b', { name: 'Boys 5K', contests: ['B'] })];
    const views = [view('a', { gunTicks: tod(9, 0, 0), elapsedTicks: 3600 * T }), view('b', { gunTicks: tod(9, 30, 0), elapsedTicks: 1800 * T })];
    const st = state({ races, views, outputs: [TRACKSCORE, LIVE], statuses: [
      { id: 'o_ts', state: 'connected', scriptOk: true, scriptInfo: { mid: null } },
      { id: 'o_live', state: 'connected', scriptOk: true, scriptInfo: { mid: '8132' } }] });
    const ws = A.globalWarnings(st, NOW);
    const picks = ws.filter((w) => w.picker);
    assert.equal(picks.length, 1, 'live results takes every race: no warning for it (ux-walkthrough/F14)');
    const w = picks[0];
    assert.equal(w.tone, 'bad');
    assert.match(w.text, /switches to that race and clears the race it was showing/);
    assert.equal(w.picker.outputId, 'o_ts');
    assert.deepEqual(w.picker.options.map((o) => o.id), ['a', 'b']);
    assert.equal(w.picker.selected, 'b', 'the race whose gun went last');
  });

  test('race-day-sim/F6: with a blank event number the warning says splits land in the wrong race', () => {
    const races = [race('a'), race('b', { contests: ['B'] })];
    const st = state({ races, views: [view('a'), view('b')], outputs: [{ ...TRACKSCORE, eventNumber: 'blank' }] });
    const w = A.globalWarnings(st, NOW).find((x) => x.picker);
    assert.match(w.text, /puts every split into the race it is showing/);
  });

  test('race-day-sim/F6: one active race, or TrackScore given one race: no picker', () => {
    const races = [race('a'), race('b', { contests: ['B'], active: false })];
    assert.equal(A.globalWarnings(state({ races, views: [view('a'), view('b')], outputs: [TRACKSCORE] }), NOW).some((w) => w.picker), false);
    const both = [race('a'), race('b', { contests: ['B'] })];
    assert.equal(A.globalWarnings(state({ races: both, views: [view('a'), view('b')], outputs: [{ ...TRACKSCORE, races: ['a'] }] }), NOW).some((w) => w.picker), false);
  });

  test('no "Set to now": a far-off RR12 clock is not a warning, since the gun is only what the operator types', () => {
    for (const lag of [12.4, -1.5, 2.1, null]) {
      const ws = A.globalWarnings(state({ races: [race('a')], views: [view('a')], outputs: [TRACKSCORE], input: { clockLagSec: lag } }), NOW);
      assert.equal(ws.some((x) => /Set to now|clock/i.test(x.title + ' ' + x.text)), false, `lag ${lag}`);
    }
    assert.equal(A.clockLagText(-1.5), "RR12 times are 1.5 s ahead of this PC's clock.");
    assert.equal(A.clockLagBad, undefined);
    assert.equal(A.localTod, undefined);
  });

  test('ux-walkthrough/F5: a broken script says the missed splits go out once it works', () => {
    const st = state({ races: [race('a')], views: [view('a')], outputs: [LIVE], statuses: [{ id: 'o_live', state: 'disabled', scriptOk: false, scriptError: 'Script file not found' }] });
    const w = A.globalWarnings(st, NOW).find((x) => /script/.test(x.text));
    assert.match(w.text, /sent by themselves once the script works/);
  });

  test('an output that lags gets a warning', () => {
    const st = state({ races: [race('a')], views: [view('a')], outputs: [LIVE], statuses: [{ id: 'o_live', state: 'connected', scriptOk: true, scriptInfo: { mid: '1' }, behind: 120, lagSec: 12 }] });
    assert.ok(A.globalWarnings(st, NOW).some((x) => /120 packets behind/.test(x.text)));
  });
});

describe('pills', () => {
  test('an output pill turns amber with "N packets behind" when lagSec > 5', () => {
    const o = { name: 'TrackScore', enabled: true };
    const p = A.outputPill(o, { state: 'connected', scriptOk: true, behind: 120, lagSec: 8 });
    assert.equal(p.tone, 'warn');
    assert.equal(p.text, 'TrackScore · 120 packets behind');
    assert.equal(A.outputPill(o, { state: 'connected', scriptOk: true, behind: 3, lagSec: 2 }).tone, 'ok');
    assert.equal(A.outputPill(o, { state: 'connected', scriptOk: true }).tone, 'ok', 'a server without lagSec');
    assert.equal(A.behindText({ lagSec: 9, behind: 0 }), '9 s behind');
  });

  test('the RR12 pill tooltip carries the clock offset', () => {
    const p = A.inputPill({ listening: true, port: 5565, connections: [{}], lastLineAt: NOW, clockLagSec: 2.04 }, NOW);
    assert.equal(p.title, "RR12 times arrive 2.0 s after this PC's clock.");
  });
});

describe('TrackScore-like outputs (ux-walkthrough/F14)', () => {
  test('a script without a MID is TrackScore-like; a MID script or a MID override is not', () => {
    assert.equal(A.isTrackScoreLike(TRACKSCORE, { scriptOk: true, scriptInfo: { mid: null } }), true);
    assert.equal(A.isTrackScoreLike(LIVE, { scriptOk: true, scriptInfo: { mid: '8132' } }), false);
    assert.equal(A.isTrackScoreLike({ ...TRACKSCORE, mid: '9001' }, null), false);
    assert.equal(A.isTrackScoreLike(LIVE, null), false, 'not loaded yet: the live-results script name');
    assert.equal(A.isTrackScoreLike(TRACKSCORE, null), true);
  });

  test("the MID line shows the override and the script's own MID", () => {
    assert.equal(A.midText('8132', '9001'), 'It sends MID 9001 (your override; the script has 8132).');
    assert.equal(A.midText('8132', ''), 'It sends MID 8132.');
    assert.equal(A.midText('8132', '8132'), 'It sends MID 8132.');
    assert.equal(A.midText(null, ''), '');
  });
});

describe('gun (ux-walkthrough/F2, review-core/F6)', () => {
  const feed = [
    { id: 1, raceId: 'r1', status: 'waiting-gun', tod: tod(10, 0, 3) },
    { id: 2, raceId: 'r1', status: 'waiting-gun', tod: tod(10, 0, 1, 234) },
    { id: 3, raceId: 'r1', status: 'waiting-gun', tod: tod(10, 6, 0) },
    { id: 4, raceId: 'r2', status: 'waiting-gun', tod: tod(9, 0, 0) },
    { id: 5, raceId: 'r1', status: 'sent', tod: tod(9, 0, 0) },
  ];

  test('counts the waiting reads a new gun would put before it, and the earliest', () => {
    assert.deepEqual(A.waitingBeforeGun(feed, 'r1', tod(10, 5, 0)), { count: 2, known: 3, earliest: tod(10, 0, 1, 234) });
    assert.equal(A.waitingBeforeGun(feed, 'r1', tod(9, 59, 0)).count, 0);
    // midnight: reads just after midnight are after a gun just before it
    assert.equal(A.waitingBeforeGun([{ raceId: 'x', status: 'waiting-gun', tod: tod(0, 0, 5) }], 'x', tod(23, 59, 50)).count, 0);
  });

  test('says how many and when, and admits when the feed knows only some', () => {
    const w = A.waitingBeforeGun(feed, 'r1', tod(10, 5, 0));
    assert.equal(A.waitingBeforeText(w, 3, '10:05:00.000'),
      '3 reads are waiting for the gun. 2 of them are earlier than 10:05:00.000 (the first at 10:00:01.234), so they would count as before the gun and not be sent.');
    assert.match(A.waitingBeforeText(w, 12, '10:05:00.000'), /^12 reads .* At least 2 of them/);
    const all = A.waitingBeforeGun(feed, 'r1', tod(10, 7, 0));
    assert.match(A.waitingBeforeText(all, 3, '10:07:00.000'), /All of them are earlier/);
  });

});

describe('resend (race-day-sim/F5, trackscore-compat/F2+F3)', () => {
  test('the prompt follows the server: resendSuggested and stale with per-output counts', () => {
    const rv = view('r1', { resendSuggested: true, stale: { count: 15, byOutput: [{ outputId: 'o_ts', name: 'TrackScore', count: 12 }, { outputId: 'o_live', name: 'Live results', count: 3 }, { outputId: 'x', name: 'Off', count: 0 }] } });
    const p = A.resendPrompt(rv, undefined);
    assert.equal(p.server, true);
    assert.equal(p.count, 15);
    assert.deepEqual(p.byOutput.map((o) => o.name), ['TrackScore', 'Live results']);
    assert.match(A.resendPromptText(p), /^15 splits already sent are out of date \(TrackScore: 12, Live results: 3\)\./);
  });

  test("the server's 'nothing stale' wins over this tab's own offer; an old server falls back to it", () => {
    assert.equal(A.resendPrompt(view('r1', { resendSuggested: false, stale: { count: 0, byOutput: [] } }), { count: 5 }), null);
    assert.deepEqual(A.resendPrompt(view('r1'), { count: 5 }), { server: false, count: 5, byOutput: [] });
    assert.equal(A.resendPrompt(view('r1'), undefined), null);
  });

  test('the dialog spells out the switch and clear risk, and that finished runners are left out', () => {
    const races = [race('girls', { name: 'Girls 5K', eventNumber: '3' })];
    const rv = view('girls', { splits: [{ id: 'girlss1', crossings: 40 }] });
    const st = state({ races, views: [rv], outputs: [TRACKSCORE, LIVE], statuses: [
      { id: 'o_ts', scriptOk: true, scriptInfo: { mid: null } }, { id: 'o_live', scriptOk: true, scriptInfo: { mid: '8132' } }] });
    const t = A.resendDialogText(st, 'girls');
    assert.equal(t.inactive, false);
    assert.equal(t.confirm, 'Resend 40 splits');
    const text = t.body.join('\n');
    assert.match(text, /to TrackScore and Live results/);
    assert.match(text, /If TrackScore is showing another race, it switches to Event 3-1-1 \(Girls 5K\) and clears the race it was showing\./);
    assert.doesNotMatch(text, /If Live results is showing/);
    assert.match(text, /Runners who have finished are left out unless you tick the box/);
    assert.doesNotMatch(text, /Made-up and typed times/, 'said only when the race has some');
    rv.review = { missing: 0, estimable: 0, checks: 0, manual: 2 };
    assert.match(A.resendDialogText(st, 'girls').body.join('\n'), /Made-up and typed times of runners who have finished go too: they carry the finish place/);
  });

  test('a race sent only to the live results: the Resend dialog names them, never TrackScore', () => {
    const races = [race('boys', { name: 'Boys 5K', eventNumber: '4', active: false })];
    const live = { ...LIVE, races: ['boys'] };
    const st = state({ races, views: [view('boys', { splits: [{ id: 'boyss1', crossings: 3 }] })], outputs: [{ ...TRACKSCORE, races: ['girls'] }, live] });
    const text = A.resendDialogText(st, 'boys').body.join('\n');
    // the general line on what a resend can't remove is the same for every race
    assert.doesNotMatch(text.replace(A.RESEND_LIMIT, ''), /TrackScore/);
    assert.match(text, /replaces their finish place in Live results\./);
    assert.match(text, /Boys 5K is switched off \(not Active\)\./);
  });

  test('an inactive race is a dangerous resend that needs "Resend anyway"', () => {
    const races = [race('girls', { name: 'Girls 5K', eventNumber: '3', active: false })];
    const st = state({ races, views: [view('girls', { splits: [{ id: 'girlss1', crossings: 2 }] })], outputs: [TRACKSCORE] });
    const t = A.resendDialogText(st, 'girls');
    assert.equal(t.inactive, true);
    assert.equal(t.danger, true);
    assert.equal(t.confirm, 'Resend anyway');
    assert.match(t.body.join(' '), /switched off/);
  });

  test('the toast gives the sent and skipped counts', () => {
    assert.equal(A.resendToast('Girls 5K', { sent: 120, skippedFinished: 14 }), 'Re-sent 120 splits for Girls 5K. 14 skipped because the runner has finished.');
    assert.equal(A.resendToast('Girls 5K', { sent: 2, skippedFinished: 0, outputs: [{ name: 'TrackScore', sent: 1 }, { name: 'Live', sent: 1 }] }), 'Re-sent 2 splits for Girls 5K (TrackScore: 1, Live: 1).');
    assert.match(A.resendToast('Girls 5K', { sent: 0, outputs: [] }), /no output takes this race/);
    assert.match(A.resendToast('Girls 5K', { sent: 0, skippedFinished: 0, outputs: 0 }), /no output takes this race/);
    assert.equal(A.resendToast('Girls 5K', { sent: 5, skippedFinished: 1, outputs: 2 }), 'Re-sent 5 splits for Girls 5K. 1 skipped because the runner has finished.');
  });
});

describe('race form', () => {
  test('ux-walkthrough/F4: a draft that reuses another race\'s event, round and heat is refused', () => {
    const races = [race('girls', { name: 'Girls Varsity 5K', eventNumber: '3' })];
    const one = [{ name: 'Split 1', sources: [] }];
    const errs = A.validateRaceDraft({ name: 'Boys Varsity 5K', eventNumber: '3', round: '1', heat: '1', splits: one, finishSources: [] }, races);
    assert.ok(errs.some((e) => /Girls Varsity 5K would all use Event 3-1-1/.test(e)));
    assert.deepEqual(A.validateRaceDraft({ name: 'Girls Varsity 5K', eventNumber: '3', splits: one, finishSources: [] }, races, 'girls'), [], 'the race itself is no clash');
    assert.deepEqual(A.validateRaceDraft({ name: 'Boys', eventNumber: '3', heat: '2', splits: one, finishSources: [] }, races), []);
    assert.equal(A.eventKey({ eventNumber: '003', round: '', heat: '01' }), '3-1-1');
    assert.equal(A.eventKey({ eventNumber: ' ' }), null);
  });

  test('ux-walkthrough/F4: Duplicate race clears the event number and contests and copies the splits', () => {
    const cfg = race('girls', { name: 'Girls Varsity 5K', eventNumber: '3', contests: ['Girls'], heat: '2' });
    const d = A.duplicateDraft(cfg);
    assert.equal(d.name, 'Girls Varsity 5K (copy)');
    assert.equal(d.eventNumber, '');
    assert.deepEqual(d.contests, []);
    assert.equal(d.heat, '2');
    assert.deepEqual(d.splits, [{ name: '1K', sources: ['1K-A'], earliest: '' }]);
    d.splits[0].sources.push('1K-B');
    assert.deepEqual(cfg.splits[0].sources, ['1K-A'], 'the copy does not share arrays with the original');
  });

  test('ux-walkthrough/F10: the split count comes from the live RaceView', () => {
    const rv = view('r1', { splits: [{ id: 's1', crossings: 5 }, { id: 's2', crossings: 0 }] });
    assert.equal(A.splitCrossings(rv, 's1'), 5);
    assert.equal(A.splitCrossings(view('r1', { splits: [{ id: 's1', crossings: 0 }] }), 's1'), 0, 'after Clear race data');
    assert.equal(A.splitCrossings(rv, undefined), 0, 'a split not saved yet');
  });

  test('ux-walkthrough/F13: offered timing points stay in place after an add; matching names come first', () => {
    const locs = [{ name: '3K-A', lastAt: 5 }, { name: '2K-B', lastAt: 9 }, { name: '2K-A', lastAt: 1 }, { name: 'Finish', lastAt: 8 }];
    assert.deepEqual(A.rankLocations(locs, '2K').map((l) => l.name), ['2K-B', '2K-A', 'Finish', '3K-A']);
    const first = A.stableOptions([], A.rankLocations(locs, '2K'), new Set());
    assert.deepEqual(first.order, ['2K-B', '2K-A', 'Finish', '3K-A']);
    // 2K-B was added: it is no longer offered, but keeps its place as "added"; nothing slides under the pointer
    const after = A.stableOptions(first.order, A.rankLocations(locs.filter((l) => l.name !== '2K-B'), '2K'), new Set(['2k-b']));
    assert.deepEqual(after.items.map((i) => [i.name, i.added]), [['2K-B', true], ['2K-A', false], ['Finish', false], ['3K-A', false]]);
    // a new name seen meanwhile goes at the end
    const more = A.stableOptions(after.order, [...A.rankLocations(locs.filter((l) => l.name !== '2K-B'), '2K'), { name: '1K-A' }], new Set(['2k-b']));
    assert.equal(more.items.at(-1).name, '1K-A');
  });

  test('ux-walkthrough/F12: no stray "null" text in a new race editor', () => {
    const box = doc.createElement('div');
    box.replaceChildren(...[doc.createElement('div'), null, false, doc.createElement('section'), undefined].filter(A.isNode));
    assert.equal(box.childNodes.length, 2);
    assert.doesNotMatch(box.textContent, /null|false|undefined/);
  });
});

describe('settings and outputs', () => {
  test('ux-walkthrough/F6: changing the RR12 port while RR12 is connected needs a confirm', () => {
    const st = state();
    assert.deepEqual(A.inputPortChange(st, '5625'), { from: 5565, to: 5625, connections: 1 });
    assert.equal(A.inputPortChange(st, '5565'), null);
    assert.equal(A.inputPortChange(state({ input: { connections: [] } }), '5625'), null);
  });

  test('ux-walkthrough/F5: a script path is checked against the folder listing before saving', () => {
    const listing = { dir: 'C:\\Lynx', entries: [{ name: 'Karmarush-Track.lss', path: 'C:\\Lynx\\Karmarush-Track.lss', type: 'file' }] };
    assert.deepEqual(A.scriptPathCheck('c:\\lynx\\karmarush-track.lss', listing), { ok: true, why: '' });
    assert.match(A.scriptPathCheck('C:\\Lynx\\Karmarush-Trak.lss', listing).why, /no file called Karmarush-Trak\.lss in C:\\Lynx/);
    assert.match(A.scriptPathCheck('C:\\Lynx\\Missing\\X.lss', null, 'Folder not found').why, /can't open .*Folder not found/);
    assert.match(A.scriptPathCheck('C:\\Lynx\\XCScore.txt', listing).why, /isn't a \.lss file/);
  });
});

describe('DOM helpers', () => {
  test('ux-walkthrough/F11: clearing the gun error also clears the red border', () => {
    const g = { err: doc.createElement('p'), input: doc.createElement('input') };
    A.showGunError(g, "That isn't a time of day.");
    assert.equal(g.input.getAttribute('aria-invalid'), 'true');
    A.showGunError(g, '');
    assert.equal(g.input.getAttribute('aria-invalid'), 'false');
    assert.equal(g.err.hidden, true);
  });

  test('ux-walkthrough/F15: focus returns to the button, or to its replacement after a repaint', () => {
    const card = doc.createElement('div');
    doc.body.replaceChildren(card);
    const old = A.h('button', { 'data-fk': 'oc-prev-o1' }, 'Preview packet');
    card.replaceChildren(old);
    doc.activeElement = doc.body;
    A.focusBack(old);
    assert.equal(doc.activeElement, old);
    const fresh = A.h('button', { 'data-fk': 'oc-prev-o1' }, 'Preview packet');
    card.replaceChildren(fresh); // a State arrived while the dialog was open
    doc.activeElement = doc.body;
    A.focusBack(old);
    assert.equal(doc.activeElement, fresh);
  });

  test('ux-walkthrough/F15: each "+ add" button says what it adds', () => {
    const parts = A.chipEditor({ d: {}, key: 'src-s1', items: ['1K-A'], removeLabel: 'Remove from split 1K:', onRemove() {}, onAdd() {},
      options: [], optionsTitle: '', emptyOptions: '', inputLabel: 'Add a timing point to split 1K', placeholder: '' });
    const box = doc.createElement('div');
    box.replaceChildren(...parts);
    const add = box.querySelector('[data-fk="src-s1-open"]');
    assert.equal(add.getAttribute('aria-label'), 'Add a timing point to split 1K');
  });
});

describe('revision 3: the start area, freed reads, finish reads', () => {
  test('s2 P1: "Start area (ignored)" has a word, a colour, a glossary line, and is a filtered read', () => {
    const info = A.statusInfo('start-area');
    assert.equal(info.label, 'Start area (ignored)');
    assert.equal(info.tone, 'muted');
    assert.equal(info.filtered, true, 'hundreds of runners cross the finish mats at the start: hidden unless asked');
    assert.match(info.meaning, /Too soon after the gun/);
    assert.match(info.meaning, /Ignore reads in the first … s/);
    assert.ok(A.STATUS_ORDER.includes('start-area'));
    const feed = [{ id: 2, status: 'start-area', raceId: 'r1' }, { id: 1, status: 'sent', raceId: 'r1' }];
    assert.deepEqual(A.filterFeed(feed, {}).rows.map((e) => e.id), [1]);
    assert.equal(A.filterFeed(feed, {}).hidden, 1);
    assert.deepEqual(A.filterFeed(feed, { showFiltered: true }).rows.map((e) => e.id), [2, 1]);
  });

  test('s2 P1: the race card says how many reads the start area ignored, and where to change it', () => {
    const races = [race('r1')];
    const st = state({ races, views: [view('r1', { gunTicks: tod(10, 0, 0), gunText: '10:00:00.000', startArea: 120 })] });
    st.config.filter = { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 45 };
    const w = A.raceWarnings(st.races[0], races[0], st, NOW).find((x) => /start area/.test(x.text));
    assert.ok(w);
    assert.equal(w.tone, 'info', 'normal on a course that starts over the finish mats: not a warning');
    assert.match(w.text, /^120 reads in the first 45 s after the gun were ignored/);
    assert.equal(w.action.href, '#settings/filter');
    const none = state({ races, views: [view('r1', { gunTicks: tod(10, 0, 0), startArea: 0 })] });
    assert.equal(A.raceWarnings(none.races[0], races[0], none, NOW).some((x) => /start area/.test(x.text)), false);
  });

  test('the race form says a finish read marks the runner finished and later reads are ignored', () => {
    const t = A.finishHelp({ startIgnoreSec: 60 });
    assert.match(t, /marks the runner as finished: later reads of that runner are ignored/);
    assert.match(t, /never sent/);
    assert.match(t, /first 60 s after the gun/);
    assert.doesNotMatch(t, /only mark a runner as finished/);
    assert.doesNotMatch(A.finishHelp({ startIgnoreSec: 0 }), /after the gun/, 'nothing about the start area when it is off');
  });

  test('s2 P3: the delete dialog says the race\'s reads are no longer used and new reads of its contest are not used either', () => {
    const races = [race('g', { name: 'Girls 5K', contests: ['Girls Varsity'] }), race('b', { name: 'Boys 5K' })];
    const plan = enginePlan(races, [[101, 'Girls Varsity'], [102, 'Girls Varsity'], [501, 'Boys Varsity']], [races[1]]);
    const t = A.deleteRaceText(races[0], view('g', { splits: [{ id: 'gs1', crossings: 12 }] }), plan);
    assert.match(t[0], /12 crossings are removed/);
    assert.deepEqual(t.slice(1, 3), ['Its 2 reads are no longer used.',
      "New reads of 'Girls Varsity' won't be used either until you list the contest on an Active race."]);
    assert.doesNotMatch(t.join(' '), /Boys 5K/, 'nothing goes into the race that takes every contest');
    assert.match(t.at(-1), /can't be undone: its reads stay unused even if you add the race again\. To stop a race but keep its reads, untick Active instead\./);
  });
});

/**
 * A RoutePlan as Split Relay works it out (Engine.planChange), for the panel's dialog texts: the races, reads of the
 * given contests (bib, contest), and the races as they would be after the change. `edit` changes the settings first
 * (saved) and may return reads that come after that change. A race left out is deleted, as the panel's Delete does
 * (only a Delete takes reads out of use: DESIGN 9.2 R2).
 */
function enginePlan(races, reads, next, edit = null) {
  const cfg = { version: 1, filter: { tagWindowSec: 10, holdSec: 2 }, races: structuredClone(races), outputs: [] };
  const e = new Engine({ getConfig: () => cfg, autoStart: false });
  const add = ([bib, contest]) => e.handleRead({ location: '1K-A', bib: String(bib), tod: tod(10, 5, 0) + bib * T, contest });
  const gone = (from, to) => from.filter((r) => !to.some((x) => x.id === r.id)).map((r) => r.id);
  reads.forEach(add);
  if (edit) {
    const before = [...cfg.races];
    const later = edit(cfg) ?? [];
    e.configChanged({ deleted: gone(before, cfg.races) });
    later.forEach(add);
  }
  return e.planChange({ ...cfg, races: next }, { deleted: gone(cfg.races, next) });
}

describe('revision 5: what saving or deleting a race does to the reads (DESIGN 9.2)', () => {
  const open = (extra) => race('open', { name: 'Open 5K', ...extra });

  test('"Race deleted (not used)" and "Cleared (not used)" have words, a colour and a glossary line', () => {
    assert.deepEqual([A.statusInfo('race-deleted').label, A.statusInfo('cleared').label], ['Race deleted (not used)', 'Cleared (not used)']);
    for (const k of ['race-deleted', 'cleared']) {
      const info = A.statusInfo(k);
      assert.equal(info.tone, 'muted');
      assert.ok(!info.filtered, `${k} rows are shown: nothing is lost without a word`);
      assert.ok(A.STATUS_ORDER.includes(k));
      assert.match(info.meaning, /not used any more/);
    }
    assert.match(A.statusInfo('race-deleted').meaning, /untick Active instead of deleting it/);
    assert.match(A.statusInfo('paused').meaning, /keeps exactly the reads it had when you unticked Active/);
  });

  test('a new race that lists a contest: "N reads of \'JV\' move from Open 5K to this race"', () => {
    const races = [open()];
    const plan = enginePlan(races, [[1, 'JV'], [2, 'JV'], [3, 'JV'], [4, 'Novice']], [...races, race('jv', { name: 'JV 4K', contests: ['JV'] })]);
    plan.raceId = 'jv'; // the server says which race is "this race"
    assert.deepEqual(A.raceSaveText(plan, 'JV 4K', true), { title: 'Add JV 4K?', body: [
      "3 reads of 'JV' move from Open 5K to this race.",
      'Places in the races involved are worked out again from these reads.',
    ] });
  });

  test('a race that is not Active keeps its reads: "Open 5K is not Active, so it keeps its reads"', () => {
    // Open 5K took the JV reads, then finished and was switched off
    const races = [open()];
    const plan = enginePlan(races, [[1, 'JV'], [2, 'JV']], [open({ active: false }), race('jv', { name: 'JV 4K', contests: ['JV'] })],
      (cfg) => { cfg.races[0].active = false; });
    plan.raceId = 'jv';
    assert.deepEqual(A.raceSaveText(plan, 'JV 4K', true).body, [
      "Open 5K is not Active, so it keeps its 2 reads of 'JV'.",
      "New reads of 'JV' go to this race.",
    ]);
  });

  test('a new race that is not Active takes no read; its contest\'s reads, old and new, wait for it (revision 6, C1)', () => {
    const races = [open()];
    const plan = enginePlan(races, [[1, 'JV']], [...races, race('jv', { name: 'JV 4K', contests: ['JV'], active: false })]);
    plan.raceId = 'jv';
    assert.deepEqual(A.raceSaveText(plan, 'JV 4K', true).body, [
      "1 read of 'JV' leaves Open 5K and waits for this race, which is not Active: it is used when you tick Active.",
      "New reads of 'JV' wait for this race, which is not Active: they are used when you tick Active.",
      'Places in the races involved are worked out again from these reads.',
    ]);
  });

  test('a list changed to empty: the race takes the reads that had no race', () => {
    const races = [race('jv', { name: 'JV 4K', contests: ['JV'] })];
    const plan = enginePlan(races, [[1, 'JV'], [2, 'Novice'], [3, 'Novice']], [{ ...races[0], contests: [] }]);
    plan.raceId = 'jv';
    assert.deepEqual(A.raceSaveText(plan, 'JV 4K', false), { title: 'Save JV 4K?', body: [
      "2 reads of 'Novice' that were in no race go to this race.",
      'Places in the races involved are worked out again from these reads.',
    ] });
  });

  test('a contest taken off a race: set aside, old and new reads; or back to the race that takes every contest', () => {
    const solo = race('g', { name: 'Girls 5K' });
    const plan = enginePlan([solo], [[888, 'Boys Varsity'], [101, 'Girls Varsity']], [{ ...solo, contests: ['Girls Varsity'] }]);
    plan.raceId = 'g';
    assert.deepEqual(A.raceSaveText(plan, 'Girls 5K', false).body.slice(0, 2), [
      "1 read of 'Boys Varsity' in this race is set aside (not used).",
      "New reads of 'Boys Varsity' are set aside too, until you list the contest on an Active race. A race that takes every contest does not take them.",
    ]);
    // the misclick and its undo
    const rs = [race('g', { name: 'Girls 5K', contests: ['Girls Varsity'] }), race('b', { name: 'Boys 5K' })];
    const undo = enginePlan(rs, [[501, 'Boys Varsity'], [502, 'Boys Varsity']], rs, (cfg) => { cfg.races[0].contests = ['Girls Varsity', 'Boys Varsity']; });
    undo.raceId = 'g';
    assert.deepEqual(A.raceSaveText(undo, 'Girls 5K', false).body[0], "2 reads of 'Boys Varsity' move from this race to Boys 5K.");
    // nothing that runs changes: no dialog
    const quiet = enginePlan(rs, [[501, 'Boys Varsity']], [{ ...rs[0], name: 'Girls Varsity 5K' }, rs[1]]);
    quiet.raceId = 'g';
    assert.equal(A.raceSaveText(quiet, 'Girls Varsity 5K', false), null);
    const fresh = enginePlan(rs, [[501, 'Boys Varsity']], [...rs, race('m', { name: 'Masters', contests: ['Masters'] })]);
    fresh.raceId = 'm';
    assert.equal(A.raceSaveText(fresh, 'Masters', true), null, 'a contest nobody has read yet');
  });

  test('listing a set-aside contest uses its reads; deleting a race that holds none says so', () => {
    const rs = [race('g', { name: 'Girls 5K', contests: ['Girls Varsity'] }), race('b', { name: 'Boys 5K' })];
    // Girls 5K deleted with its reads, then a straggler came: set aside. A race that lists the contest uses the
    // straggler; the deleted race's own read stays out of use.
    const plan = enginePlan(rs, [[101, 'Girls Varsity']], [rs[1], race('g2', { name: 'Girls again', contests: ['Girls Varsity'] })], (cfg) => {
      cfg.races.shift();
      return [[102, 'Girls Varsity']];
    });
    assert.deepEqual(A.planLines(plan, 'g2'), ["1 read of 'Girls Varsity' that was set aside goes to this race."]);
    const none = enginePlan(rs, [[501, 'Boys Varsity']], [rs[1]]);
    assert.deepEqual(A.deleteRaceText(rs[0], view('g'), none).slice(1, 2), ['It has no reads, so nothing else changes.']);
    assert.match(A.deleteRaceText(rs[0], view('g'), null)[1], /^Its reads are no longer used\. New reads of its contests won't be used either/);
    const t = A.clearRaceText(view('g'));
    // clear, then Replay in RR12, rebuilds a race (race day 2026-10-21): the dialog says how
    assert.match(t[1], /The reads this race holds now are no longer used\. To rebuild the race, press Replay on the exporter in RR12 afterwards: the reads count again/);
  });

  test('planLines covers every kind of change in words', () => {
    const lines = A.planLines({
      raceId: 'x',
      deleted: [{ raceId: 'x', raceName: 'X', count: 1, contests: [] }],
      setAside: [{ contest: 'A', deleted: true }, { contest: 'B', deleted: false }],
      moves: [
        { contest: 'C', count: 1, from: { raceId: null, status: 'set-aside' }, to: { raceId: 'x', raceName: 'X', active: true } },
        { contest: '', blank: true, count: 2, from: { raceId: 'y', raceName: 'Y', active: true }, to: { raceId: null, status: 'no-race' } },
        { contest: 'D', count: 3, from: { raceId: null, status: 'race-missing', raceName: 'Z', waitsFor: 'z' }, to: { raceId: 'z', raceName: 'Z', active: false } },
        // revision 6: reads that wait in no race for a race that is not Active (C1), or for a missing race (R6)
        { contest: 'H', count: 5, from: { raceId: 'y', raceName: 'Y', active: true }, to: { raceId: null, status: 'paused', raceName: 'X', waitsFor: 'x' } },
        { contest: 'I', count: 1, from: { raceId: null, status: 'set-aside' }, to: { raceId: null, status: 'paused', raceName: 'W', waitsFor: 'w' } },
        { contest: 'J', count: 2, from: { raceId: null, status: 'paused', raceName: 'W', waitsFor: 'w' }, to: { raceId: 'y', raceName: 'Y', active: true } },
        { contest: 'K', count: 6, from: { raceId: 'y', raceName: 'Y', active: true }, to: { raceId: null, status: 'race-missing', raceName: 'Boys 5K', waitsFor: 'm' } },
      ],
      kept: [{ contest: 'E', count: 4, raceId: 'y', raceName: 'Y' }],
      newReads: [{ contest: 'F', reads: 2, to: { raceId: null, status: 'no-race' } }, { contest: 'G', reads: 0, to: { raceId: 'x' } },
        { contest: 'H', reads: 5, to: { raceId: null, status: 'paused', raceName: 'X', waitsFor: 'x' } },
        { contest: 'K', reads: 6, to: { raceId: null, status: 'race-missing', raceName: '', waitsFor: 'm' } }],
    }, 'x');
    assert.deepEqual(lines, [
      'Its 1 read is no longer used.',
      "New reads of 'A' won't be used either until you list the contest on an Active race.",
      "1 read of 'C' that was set aside goes to this race.",
      '2 reads without a contest leave Y and have no race (not used).',
      "3 reads of 'D' that were waiting for Z go to Z (not sent while Z is not Active).",
      "5 reads of 'H' leave Y and wait for this race, which is not Active: they are used when you tick Active.",
      "1 read of 'I' that was set aside waits for W, which is not Active: it is used when you tick Active.",
      "2 reads of 'J' that were waiting for W go to Y.",
      "6 reads of 'K' leave Y and wait for Boys 5K, which isn't in the settings.",
      "New reads of 'B' are set aside too, until you list the contest on an Active race. A race that takes every contest does not take them.",
      "Y is not Active, so it keeps its 4 reads of 'E'.",
      "New reads of 'F' will have no race (not used).",
      "New reads of 'H' wait for this race, which is not Active: they are used when you tick Active.",
      "New reads of 'K' wait for their race, which isn't in the settings.",
    ]);
  });
});

describe('revision 4: set-aside contests (DESIGN 9.2)', () => {
  const races = () => [race('g', { name: 'Girls 5K', contests: ['Girls Varsity'] }), race('b', { name: 'Boys 5K' })];

  test('"Set aside (not used)" has a word, a warning colour and a glossary line, and is a problem, not a filtered read', () => {
    const info = A.statusInfo('set-aside');
    assert.equal(info.label, 'Set aside (not used)');
    assert.equal(info.tone, 'warn');
    assert.ok(!info.filtered);
    assert.match(info.meaning, /List the contest on an Active race/);
    assert.ok(A.STATUS_ORDER.includes('set-aside'));
    const feed = [{ id: 1, status: 'set-aside', raceId: null }, { id: 2, status: 'sent', raceId: 'b' }];
    assert.deepEqual(A.filterFeed(feed, { problemsOnly: true }).rows.map((e) => e.id), [1]);
    assert.deepEqual(A.filterFeed(feed, { raceId: A.NO_RACE }).rows.map((e) => e.id), [1]);
  });

  test('the Live tab warns once per set-aside contest, with a button to the race editor', () => {
    const st = state({ races: races(), views: [view('g'), view('b')] });
    st.setAside = [
      { contest: 'Girls JV', reason: "its race 'Girls JV 4K' was deleted", raceName: 'Girls JV 4K', raceId: null, count: 7 },
      { contest: 'Boys JV', reason: "'Girls 5K' no longer lists it", raceName: 'Girls 5K', raceId: 'g', count: 2 },
    ];
    const ws = A.globalWarnings(st, NOW).filter((w) => /are not used/.test(w.text));
    assert.deepEqual(ws.map((w) => w.text), [
      "Reads of 'Girls JV' are not used: its race 'Girls JV 4K' was deleted. List the contest on an Active race to use them.",
      "Reads of 'Boys JV' are not used: 'Girls 5K' no longer lists it. List the contest on an Active race to use them.",
    ]);
    assert.deepEqual(ws[0].action, { label: 'Add a race for it', cmd: 'aside-race', value: 'Girls JV', raceName: 'Girls JV 4K' });
    assert.deepEqual(ws[1].action, { label: 'Edit Girls 5K', href: '#races/g' });
    assert.ok(ws.every((w) => w.tone === 'warn'));
  });

  test("a port's or an event's set-aside reads (LapTime lines): the words and 'Add a race for it' name the port or the event, never a contest", () => {
    const st = state({ races: races(), views: [view('g'), view('b')] });
    // State.setAside as the server sends it for a routing key that is not a contest (DESIGN 9.15 L3)
    st.setAside = [
      { contest: 'Port 5566', via: 'port', port: 5566, event: null, reason: "its race 'Boys 5K' was deleted", raceName: 'Boys 5K', raceId: null, count: 4 },
      { contest: 'Event 3-1-1', via: 'event', port: null, event: '3-1-1', reason: "its race 'JV' was deleted", raceName: 'JV', raceId: null, count: 2 },
    ];
    const ws = A.globalWarnings(st, NOW).filter((w) => /are not used/.test(w.text));
    assert.deepEqual(ws.map((w) => w.text), [
      "Reads from port 5566 are not used: its race 'Boys 5K' was deleted. Choose port 5566 on an Active race to use them.",
      "Reads of Event 3-1-1 are not used: its race 'JV' was deleted. Give an Active race Event 3-1-1 to use them.",
    ]);
    // the button makes a race that takes them: on that port, or with that event (not a contest called "Port 5566")
    assert.deepEqual(ws[0].action, { label: 'Add a race for it', cmd: 'aside-race', value: 'Port 5566', raceName: 'Boys 5K', via: 'port', port: 5566, event: null });
    assert.deepEqual(ws[1].action, { label: 'Add a race for it', cmd: 'aside-race', value: 'Event 3-1-1', raceName: 'JV', via: 'event', port: null, event: '3-1-1' });
    // the save and delete dialogs say how those reads are used again
    const lines = A.planLines({ setAside: [{ contest: 'Port 5566', via: 'port', port: 5566, deleted: true }, { contest: 'Event 3-1-1', via: 'event', event: '3-1-1', deleted: false }] }, 'x');
    assert.deepEqual(lines, [
      "New reads from port 5566 won't be used either until you choose port 5566 on an Active race.",
      'New reads of Event 3-1-1 are set aside too, until an Active race has Event 3-1-1. A race that takes every contest does not take them.',
    ]);
  });

  test('a set-aside contest is not also reported as a contest that belongs to no race', () => {
    const st = state({ races: [race('g', { name: 'Girls 5K', contests: ['Girls Varsity'] })], views: [view('g')],
      seen: { locations: [], contests: [{ name: 'Girls JV', count: 7, lastAt: NOW }, { name: 'Masters', count: 1, lastAt: NOW }] } });
    st.setAside = [{ contest: 'Girls JV', reason: "its race 'Girls JV 4K' was deleted", raceName: 'Girls JV 4K', raceId: null, count: 7 }];
    st.noRace = [{ contest: 'Girls JV', blank: false, status: 'set-aside', count: 7, raceId: null, raceName: '' },
      { contest: 'Masters', blank: false, status: 'no-race', count: 1, raceId: null, raceName: '' }];
    const loose = A.globalWarnings(st, NOW).find((w) => /belong to any race/.test(w.text));
    assert.ok(loose);
    assert.doesNotMatch(loose.text, /Girls JV/);
    assert.match(loose.text, /Masters/);
  });
});

describe('revision 6: waiting for a race that is not Active, and missing races (DESIGN 9.2 C1, R6)', () => {
  /** An engine with these races and reads (bib, contest), for State.noRace and State.missingRaces as the server gives them. */
  function engineOf(races, reads) {
    const cfg = { version: 1, filter: { tagWindowSec: 10, holdSec: 2 }, races: structuredClone(races), outputs: [] };
    const e = new Engine({ getConfig: () => cfg, autoStart: false });
    for (const [bib, contest] of reads) e.handleRead({ location: '1K-A', bib: String(bib), tod: tod(10, 5, 0) + bib * T, contest });
    return { e, cfg };
  }

  test('"Race missing (not used)" has a word, a red colour and a glossary line; "Race paused" says what ticking Active does', () => {
    const info = A.statusInfo('race-missing');
    assert.equal(info.label, 'Race missing (not used)');
    assert.equal(info.tone, 'bad');
    assert.ok(!info.filtered, 'shown: nothing is lost without a word');
    assert.ok(A.STATUS_ORDER.includes('race-missing'));
    assert.match(info.meaning, /was not deleted: config\.json was put back from its backup, or edited/);
    assert.match(A.statusInfo('paused').meaning, /wait for them, in no race\. Tick Active on the race, and they are used/);
    // C3: the words say that it takes an ACTIVE race to use the reads
    assert.match(A.statusInfo('no-race').meaning, /List the contest on an Active race/);
    assert.match(A.statusInfo('set-aside').meaning, /on an Active race, and they all count there \(listed on a race that is not Active, they wait for it\)/);
  });

  test('the Races list says the Active race on the port (or that lists a contest) takes its reads, not the first race in the list', () => {
    // LapTime lines first (DESIGN 9.15 L3): the reads of a port go to the Active race that reads from it
    assert.match(A.RACE_LIST_HELP, /^A read goes to the Active race that reads from the RR12 port it came in on \(one Active race per port\)\./);
    assert.match(A.RACE_LIST_HELP, /A race that is not Active takes no new reads: they wait for it, not used, until you tick Active on it/);
    assert.match(A.RACE_LIST_HELP, /a read that names a contest goes to the Active race that lists that contest/);
    assert.doesNotMatch(A.RACE_LIST_HELP, /first race in this list/);
  });

  test('a missing race gets a red Live warning with its reads and how to get it back, and a way to let them go', () => {
    const st = state({ races: [race('g', { name: 'Girls 5K', contests: ['Girls'] })], views: [view('g')] });
    st.missingRaces = [{ raceId: 'r_b0y5', raceName: 'Boys 5K', count: 3, contests: [{ contest: 'Boys', blank: false, count: 3 }], file: 'races\\r_b0y5.json' },
      { raceId: 'r_x', raceName: '', count: 1, contests: [], file: 'races\\r_x.json' }];
    // a read of Boys that came since waits for it too (State.noRace counts the race's own 3 with it)
    st.noRace = [{ contest: 'Boys', blank: false, status: 'race-missing', count: 4, raceId: 'r_b0y5', raceName: 'Boys 5K' }];
    const ws = A.globalWarnings(st, NOW).filter((w) => /isn't in the settings/.test(w.text));
    // V2 (DESIGN 9.15): the race file keeps the settings, so the way back is one button; config.json.bak is what a
    // start that fell back already uses, so the words point at the race file and at the damaged config.json instead
    const broken = 'If config.json was damaged, Split Relay kept it as data\\config.broken-….json: it may have other changes made since the last start.';
    assert.deepEqual(ws.map((w) => w.text), [
      `Race 'Boys 5K' isn't in the settings (config.json was restored or edited), so its 3 reads are not used. 1 other read of its contests waits for it too. Its settings are kept in data\\races\\r_b0y5.json: press “Put it back” to add it again. ${broken} Its reads come back with it.`,
      `A race (id r_x) isn't in the settings (config.json was restored or edited), so its 1 read is not used. Its settings are kept in data\\races\\r_x.json: press “Put it back” to add it again. ${broken} Its reads come back with it.`,
    ]);
    assert.ok(ws.every((w) => w.tone === 'bad'));
    assert.doesNotMatch(ws[0].text, /config\.json\.bak/);
    assert.deepEqual(ws[0].action, { label: 'Put it back', cmd: 'missing-restore', raceId: 'r_b0y5', raceName: 'Boys 5K' });
    assert.deepEqual(ws[0].more, [{ label: 'Delete it…', cmd: 'missing-delete', raceId: 'r_b0y5', raceName: 'Boys 5K', value: '3' }]);
    // a race file without settings can't be put back: the words say how, and Delete is the only button
    const bare = A.globalWarnings({ ...st, missingRaces: [{ ...st.missingRaces[0], hasSettings: false }] }, NOW).find((w) => /isn't in the settings/.test(w.text));
    assert.match(bare.text, /stop Split Relay and put the race back into data\\config\.json \(data\\races\\r_b0y5\.json has no settings to restore it from\)/);
    assert.equal(bare.action.cmd, 'missing-delete');
    assert.equal(bare.more, undefined);
    const t = A.deleteMissingText(st.missingRaces[0], null);
    assert.deepEqual(t, ["Only do this if you don't want Boys 5K back.", 'Its 3 reads are no longer used.',
      "This can't be undone: its reads stay unused even if the race comes back."]);
    assert.deepEqual(A.globalWarnings(state({ races: [race('g')], views: [view('g')] }), NOW).filter((w) => /isn't in the settings/.test(w.text)), []);
  });

  test('reads waiting for a race that is not Active: one warning per race, counted as they are now', () => {
    const races = [race('open', { name: 'Open 5K' }), race('jv', { name: 'JV 4K', contests: ['JV'], active: false })];
    const { e } = engineOf(races, [[1, 'JV'], [2, 'JV'], [3, 'Novice']]);
    const st = state({ races, views: [view('open'), view('jv')], seen: e.seen() });
    st.noRace = e.noRace();
    assert.deepEqual(st.noRace.map((n) => [n.contest, n.status, n.count, n.raceId]), [['JV', 'paused', 2, 'jv']]);
    const ws = A.globalWarnings(st, NOW).filter((w) => /not Active/.test(w.text));
    assert.deepEqual(ws.map((w) => [w.text, w.action.href]), [["2 reads of 'JV' wait for JV 4K, which is not Active, so they are not used. Tick Active on JV 4K to use them.", '#races/jv']]);
  });

  test('"doesn\'t belong to any race" counts the reads in no race now, not the ones a race that is not Active keeps (C3)', () => {
    // Open (every contest) took 4 Novice reads and finished: switched off, it keeps them. JV has an Active race.
    const races = [race('open', { name: 'Open 5K' }), race('jv', { name: 'JV 4K', contests: ['JV'] })];
    const { e, cfg } = engineOf(races, [[1, 'Novice'], [2, 'Novice'], [3, 'Novice'], [4, 'Novice']]);
    cfg.races[0].active = false;
    e.configChanged();
    e.handleRead({ location: '1K-A', bib: '9', tod: tod(10, 9, 0), contest: 'Novice' }); // a new one: no race takes it
    const st = state({ races: cfg.races, views: [view('open'), view('jv')], seen: e.seen() });
    st.noRace = e.noRace();
    assert.equal(e.seen().contests.find((c) => c.name === 'Novice').count, 5);
    const loose = A.globalWarnings(st, NOW).find((w) => /belong to any race/.test(w.text));
    assert.equal(loose.text, "Contest Novice (1 read) doesn't belong to any race, so its reads are not sent. Add it to an Active race if it should be.");
  });

  test('the contest picker shows how many reads wait now and why, not how many were ever read (C3)', () => {
    const races = [race('open', { name: 'Open 5K' }), race('jv', { name: 'JV 4K', contests: ['JV'], active: false })];
    const { e, cfg } = engineOf(races, [[1, 'Frosh'], [2, 'Frosh'], [3, 'JV'], [4, 'Masters']]);
    // Open stops taking every contest: Frosh is let go (set aside), Masters stays
    cfg.races[0].contests = ['Masters'];
    e.configChanged();
    e.handleRead({ location: '1K-A', bib: '5', tod: tod(10, 9, 0), contest: 'Frosh' });
    const st = state({ races: cfg.races, views: [view('open'), view('jv')], seen: e.seen() });
    st.noRace = e.noRace();
    st.setAside = e.setAside();
    const note = (name, owner = null) => A.contestNote(e.seen().contests.find((c) => c.name === name), st, owner);
    assert.equal(note('Frosh'), '3 set aside, not used');
    assert.equal(note('JV', cfg.races[1]), '1 waiting for JV 4K (not Active)', 'the race it waits for is named once');
    assert.equal(note('Masters', cfg.races[0]), '1 read · in Open 5K');
  });

  test('the save dialog of a race that is not Active listing a contest of the running catch-all says its reads wait for it', () => {
    const races = [race('open', { name: 'Open 5K' })];
    const plan = enginePlan(races, [[1, 'JV'], [2, 'JV']], [...races, race('jv', { name: 'JV 4K', contests: ['JV'], active: false })]);
    plan.raceId = 'jv';
    assert.deepEqual(A.planLines(plan, 'jv'), [
      "2 reads of 'JV' leave Open 5K and wait for this race, which is not Active: they are used when you tick Active.",
      "New reads of 'JV' wait for this race, which is not Active: they are used when you tick Active.",
    ]);
  });
});

describe('revision 7: LapTime mode (DESIGN 9.15)', () => {
  // LapTime races: no contests, a port, splits without timing points (passes are counted)
  const lap = (id, extra = {}) => race(id, { contests: [], inputPort: 5565,
    splits: [{ id: id + 's1', name: 'Split 1', sources: [], earliest: '' }, { id: id + 's2', name: 'Split 2', sources: [], earliest: '' }], ...extra });
  const two = (extra = {}) => {
    const st = state({ races: [lap('g', { name: 'Girls 5K' }), lap('b', { name: 'Boys 5K', active: false })], views: [view('g'), view('b')], outputs: [TRACKSCORE] });
    st.config.input = { ports: [5565, 5566] };
    st.inputs = [
      { port: 5565, listening: true, connections: [{ id: 1 }], totalLines: 40, lastLineAt: NOW - 3000, format: 'laptime' },
      { port: 5566, listening: true, connections: [], totalLines: 0, lastLineAt: null, format: null },
    ];
    return Object.assign(st, extra);
  };

  test('L7: the exporter expression is the LapTime line, word for word', () => {
    assert.equal(A.LAPTIME_EXPRESSION, 'chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]');
    // Split Relay's own copy (State.expressions.laptime) is shown; the panel's only for a server without it
    assert.equal(A.laptimeExpression({ expressions: { laptime: 'chr(2) & "S," & x' } }), 'chr(2) & "S," & x');
    assert.equal(A.laptimeExpression({}), A.LAPTIME_EXPRESSION);
    assert.equal(A.LAPTIME_EXPRESSION, SERVER_LAPTIME_EXPRESSION, "the panel's copy is word for word the server's");
    assert.equal(A.formatWord('laptime'), 'FinishLynx LapTime: bib + time');
    assert.equal(A.formatWord(null), 'Nothing received yet');
  });

  test('L2: the ports come from config.input.ports, or the one port of an older config or server', () => {
    assert.deepEqual(A.inputPorts(two()), [5565, 5566]);
    assert.deepEqual(A.inputPorts(state()), [5565], 'config.input.port');
    assert.deepEqual(A.inputsOf(state()).map((i) => i.port), [5565], 'State.input stands for its one port');
    assert.equal(A.rrTarget(two(), 5566), '192.168.0.21:5566');
    assert.equal(A.rrTarget(two()), '192.168.0.21:5565');
  });

  test('L2: the pill says how many ports receive, and which one waits', () => {
    const st = two();
    assert.equal(A.inputPill(st.input, NOW, st.inputs).text, 'Receiving on port 5565 · 5566 waiting · last read 1 s ago');
    st.inputs[1].connections = [{ id: 2 }];
    const p = A.inputPill(st.input, NOW, st.inputs);
    assert.equal(p.tone, 'ok');
    assert.match(p.text, /^Receiving on 2 ports · last read/);
    st.inputs.forEach((i) => { i.connections = []; });
    assert.deepEqual(A.inputPill(st.input, NOW, st.inputs), { tone: 'warn', text: 'Waiting for RR12 on ports 5565 and 5566' });
    st.inputs[1].error = 'Port 5566 is already in use';
    assert.equal(A.inputPill(st.input, NOW, st.inputs).text, 'RR12 input problem (port 5566)');
    assert.match(A.inputPill(st.input, NOW, [st.inputs[0]]).text, /^Receiving · 1 connection/, 'one port: the words as before');
  });

  test('L2: ports are checked like the server checks them, in words', () => {
    const outputs = [{ name: 'Scoreboard', mode: 'tcp-server', port: 6000, enabled: true }];
    assert.deepEqual(A.validateInputPorts(['5565', '5566'], { panelPort: 5590, outputs }), []);
    assert.deepEqual(A.validateInputPorts(['5565', '5565', '80', '5590', '6000', 'x'], { panelPort: 5590, outputs }), [
      'Port 5565 is in the list twice. Each RR12 exporter needs its own port.',
      "Port 80 can't be used: type a whole number from 1024 to 65535 (for example 5565).",
      "Port 5590 is the control panel's port. Choose another one for RR12.",
      'Port 6000 is used by the output “Scoreboard”, which listens there. Choose another one for RR12.',
      "Port x can't be used: type a whole number from 1024 to 65535 (for example 5565).",
    ]);
    assert.match(A.validateInputPorts([])[0], /at least one port/);
    // the server's limit (src/config.js MAX_INPUT_PORTS)
    assert.equal(A.MAX_INPUT_PORTS, SERVER_MAX_INPUT_PORTS);
    assert.deepEqual(A.validateInputPorts(Array.from({ length: 11 }, (_, i) => String(5565 + i))), ['Split Relay listens on at most 10 RR12 input ports.']);
    assert.equal(A.nextFreePort([5565], [5590]), 5566);
    assert.equal(A.nextFreePort([5565, 5566], [5567, 5590]), 5568, 'next to the RR12 ports, skipping a taken one');
    assert.deepEqual(A.inputPortsDropped(two(), ['5566']), [{ port: 5565, connections: 1 }], 'a connected port that goes away');
    assert.deepEqual(A.inputPortsDropped(two(), ['5565']), [], 'nobody is connected to 5566');
  });

  test('L3: one Active race per port, with the server\'s words; a race with no port never clashes', () => {
    const races = [lap('g', { name: 'Girls 5K' }), lap('b', { name: 'Boys 5K', active: false })];
    const draft = { ...A.raceToDraft(races[1]), active: true };
    assert.equal(draft.inputPort, '5565');
    assert.equal(A.portConflict(draft, races, 'b').id, 'g');
    assert.ok(A.validateRaceDraft(draft, races, 'b').includes("Port 5565 already feeds the active race 'Girls 5K'. Untick Active on one of them, or give this race its own port."));
    assert.equal(A.portConflict({ ...draft, inputPort: '5566' }, races, 'b'), null);
    assert.equal(A.portConflict({ ...draft, inputPort: '' }, races, 'b'), null);
    assert.equal(A.portConflict({ ...draft, active: false }, races, 'b'), null);
    assert.equal(A.raceBody({ ...draft, inputPort: '' }).inputPort, null, 'none: only reads that name its contests');
    assert.equal(A.raceBody(draft).inputPort, 5565);
    // a copy of a running race is the next race on the same port: not Active until it is switched to
    assert.equal(A.duplicateDraft(races[0], races).active, false);
    assert.equal(A.duplicateDraft({ ...races[0], inputPort: null, contests: ['G'] }, races).active, true);
  });

  test('L3: "Switch to" says what it unticks, and offers to move an output that had only that race', () => {
    const st = two();
    st.config.outputs = [{ ...TRACKSCORE, races: ['g'] }, LIVE];
    const p = A.switchPlan(st, 'b');
    assert.deepEqual(p.off.map((r) => r.id), ['g']);
    assert.equal(p.port, 5565);
    assert.deepEqual(p.outputs.map((o) => [o.output.id, o.from]), [['o_ts', ['Girls 5K']]]);
    assert.deepEqual(A.switchDialogText(p, view('b')), [
      'Boys 5K becomes Active and takes the reads that arrive on port 5565.',
      'Girls 5K is unticked (not Active): it keeps its reads, and its merged .lif file keeps its splits, but nothing more is sent for it.',
      'Boys 5K has no gun time yet: set it when the race starts. Reads wait until then.',
    ]);
    st.config.races[1].inputPort = 5566;
    assert.deepEqual(A.switchPlan(st, 'b').off, [], 'its own port: nothing to untick');
  });

  test('L5: the number of splits adds and removes rows at the end, named Split N; laps to go is N for split 1', () => {
    let keys = 0;
    const key = () => 'k' + ++keys;
    const grown = A.setSplitCount([{ id: 's1', name: '1K', sources: ['1K-A'], earliest: '' }], 3, key);
    assert.deepEqual(grown.map((s) => [s.name, s._k ?? s.id]), [['1K', 's1'], ['Split 2', 'k1'], ['Split 3', 'k2']]);
    assert.deepEqual(A.setSplitCount(grown, 1).map((s) => s.name), ['1K']);
    // a default name follows its place when a row before it goes; a typed name stays
    assert.deepEqual(A.renumberDefaultNames([{ name: 'Split 2' }, { name: 'Loop' }, { name: 'split 4' }]).map((s) => s.name), ['Split 1', 'Loop', 'Split 3']);
    assert.deepEqual([0, 1, 2].map((i) => A.lapsToGo(i, 3)), [3, 2, 1], 'never 0: that is the finish');
    assert.equal(A.splitCountHint(3), 'Set the number of splits to 3 in TrackScore (Intermediate splits) and in Karmarush.');
    assert.equal(A.MAX_SPLITS, 20);
    assert.equal(A.MAX_SPLITS, SERVER_MAX_SPLITS, 'the panel and the server allow the same number of splits');
    assert.match(A.validateRaceDraft({ name: 'X', splits: [], finishSources: [] })[0], /^Set the number of splits \(1 to 20\)/);
  });

  test('L4/L5: an earliest time is minutes:seconds, and goes up in course order', () => {
    assert.equal(A.parseRaceText('8:00'), 480 * T);
    assert.equal(A.parseRaceText('8:00.5'), 480.5 * T);
    assert.equal(A.parseRaceText('1:02:03'), 3723 * T);
    assert.equal(A.parseRaceText('8'), null, 'a bare number could be seconds or minutes');
    assert.equal(A.parseRaceText('8:75'), null);
    const d = (e2, e3) => ({ name: 'R', splits: [{ name: 'Split 1', sources: [], earliest: '' }, { name: 'Split 2', sources: [], earliest: e2 }, { name: 'Split 3', sources: [], earliest: e3 }], finishSources: [] });
    assert.deepEqual(A.validateRaceDraft(d('8:00', '16:00')), []);
    // the server's words (src/config.js validateRace), so the form and a refused save say the same
    assert.deepEqual(A.validateRaceDraft(d('8:00', '7:30')), ['The earliest time of Split 3 (7:30) is before the earliest time of Split 2 (8:00). Earliest times must go up in course order.']);
    assert.deepEqual(A.validateRaceDraft(d('8:00', '8:00')), ['The earliest time of Split 3 (8:00) is the same as the earliest time of Split 2 (8:00). Earliest times must go up in course order.']);
    assert.deepEqual(A.validateRaceDraft(d('8', '')), ['The earliest time of Split 2, "8", is not a race time. Type it like 8:00 (minutes:seconds), or leave it empty.']);
    const back = A.raceBody(A.raceToDraft(race('r', { splits: [{ id: 's1', name: 'Split 1', sources: [], earliest: ' 8:00 ' }] })));
    assert.deepEqual(back.splits, [{ id: 's1', name: 'Split 1', sources: [], earliest: '8:00' }]);
  });

  test('L6: splits sent before the number of splits changed are in the wrong columns: the resend prompt says so', () => {
    const stale = (s) => view('g', { splitCount: 3, splits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], resendSuggested: true, stale: { count: 40, byOutput: [], ...s } });
    const p = A.resendPrompt(stale({ reason: 'split-count', splitCountFrom: 2 }));
    assert.deepEqual(p.columns, { was: 2, now: 3, reordered: false });
    assert.equal(A.resendPromptText(p), "TrackScore and Karmarush put splits in columns by laps to go; this race now has 3 splits instead of 2, so the splits already sent are in the wrong columns. Resend this race's splits. " + A.RESEND_LIMIT);
    assert.match(A.resendPromptText(A.resendPrompt(stale({ reason: 'order' }))), /this race's splits are in a new order, so the splits already sent are in the wrong columns/);
    assert.match(A.resendPromptText(A.resendPrompt(stale({ reason: 'changed' }), undefined, { was: 2, now: 3 })), /^40 splits already sent are out of date/, 'the server says the gun or places changed');
    // a server that does not say why: what this tab saved itself
    assert.match(A.resendPromptText(A.resendPrompt(stale({}), undefined, { was: 2, now: 3 })), /now has 3 splits instead of 2/);
    assert.equal(A.columnsChangeText(2, 3), "TrackScore and Karmarush put splits in columns by laps to go. With 3 splits instead of 2, the splits already sent are in the wrong columns: after saving, set the number of splits to 3 in TrackScore (Intermediate splits) and in Karmarush, and resend this race's splits. " + A.RESEND_LIMIT);
    assert.equal(A.columnsChangeText(3, 3), '');
  });

  test('L6: refused packets are counted on the output and said in red', () => {
    const st = two({ outputs: [{ id: 'o_ts', state: 'connected', scriptOk: true, scriptInfo: { mid: null }, refused: 2 }] });
    const w = A.globalWarnings(st, NOW).find((x) => /not sent since Split Relay started/.test(x.text));
    assert.equal(w.tone, 'bad');
    assert.match(w.text, /^TrackScore: 2 split packets were not sent since Split Relay started, because their laps to go was 0 or more than the race's number of splits, or they carried a finish time/);
  });

  test('L8: RR12 sends only bibs: a Live warning until the people file is chosen', () => {
    const w = A.globalWarnings(two(), NOW).find((x) => x.text === A.NAMES_WARNING);
    assert.equal(A.NAMES_WARNING, "RR12 sends only bibs, so the split packets carry no names, schools or gender. Choose the people file (.ppl) FinishLynx uses for this meet: Split Relay takes each runner's name from it.");
    // DESIGN 9.20 N1: its button opens the file picker at once (no detour through Settings)
    assert.deepEqual(w.action, { label: 'Choose names file…', cmd: 'choose-ppl' });
    assert.equal(w.tone, 'warn', 'amber while no split has gone out');
    assert.equal(w.title, "No names file: choose the meet's names file (.ppl)");
    const withPpl = two();
    withPpl.config.names = { pplPath: 'C:\\Lynx\\Lynx.ppl' };
    assert.equal(A.globalWarnings(withPpl, NOW).some((x) => x.text === A.NAMES_WARNING), false);
    const sr = two();
    sr.inputs.forEach((i) => { i.format = 'sr'; });
    assert.equal(A.globalWarnings(sr, NOW).some((x) => x.text === A.NAMES_WARNING), false, 'SR lines carry names');
  });

  test('L4/L5: a race that counts passes has no "no timing point" warning; extra passes and its port are said', () => {
    const st = two();
    const g = st.config.races[0];
    const rv = view('g', { gunTicks: tod(10, 0, 0), gunText: '10:00:00.000', extra: 12 });
    const ws = A.raceWarnings(rv, g, st, NOW);
    assert.equal(ws.some((w) => /no timing point/.test(w.text)), false);
    assert.match(ws.find((w) => /after a runner's last split/.test(w.text)).text, /^12 reads came after a runner's last split \(this race has 2 splits\), so they were ignored \("Extra pass"\)\. If every runner gets them, check that the RR12 exporter sends the split mats only, not the finish\./);
    const jv = lap('j', { name: 'JV 4K', inputPort: 5566 });
    assert.match(A.raceWarnings(view('j'), jv, st, NOW).find((w) => /Nothing is connected/.test(w.text)).text,
      /^Nothing is connected to port 5566, which this race reads from\. In RR12, press play on the exporter that sends to 192\.168\.0\.21:5566\.$/);
    const gone = lap('x', { inputPort: 5570 });
    assert.match(A.raceWarnings(view('x'), gone, st, NOW).find((w) => /doesn't listen/.test(w.text)).text, /port 5570, but Split Relay doesn't listen on that port \(it listens on ports 5565 and 5566\)/);
    // two LapTime races on two ports are not two races that take every contest
    assert.equal(A.raceWarnings(view('j'), jv, { ...st, config: { ...st.config, races: [g, jv] } }, NOW).some((w) => /already takes reads from every contest/.test(w.text)), false);
  });

  test('L3: reads routed by their port say "from port 5566", in warnings and in the save dialogs', () => {
    const portKey = { contest: 'Port 5566', blank: false, via: 'port', port: 5566, event: null };
    assert.equal(A.readsLabel(portKey), 'from port 5566');
    assert.equal(A.readsLabel({ contest: 'Event 3-1-1', via: 'event', event: '3-1-1' }), 'of Event 3-1-1');
    assert.equal(A.readsLabel({ contest: 'JV', via: 'contest' }), "of 'JV'");
    assert.equal(A.readsLabel({ contest: '', blank: true, via: 'blank' }), 'without a contest');
    const st = two();
    st.noRace = [{ ...portKey, status: 'paused', count: 4, raceId: 'b', raceName: 'Boys 5K' }, { ...portKey, port: 5567, contest: 'Port 5567', status: 'no-race', count: 2, raceId: null, raceName: '' }];
    const ws = A.globalWarnings(st, NOW);
    const wait = ws.find((w) => /wait for Boys 5K/.test(w.text));
    assert.equal(wait.text, '4 reads from port 5566 wait for Boys 5K, which is not Active, so they are not used. Tick Active on Boys 5K to use them.');
    assert.deepEqual(wait.more, [{ label: 'Switch to Boys 5K…', cmd: 'switch', raceId: 'b' }]);
    assert.match(ws.find((w) => /belong to no race/.test(w.text)).text, /^2 reads from port 5567 belong to no race/);
    assert.deepEqual(A.planLines({ moves: [{ ...portKey, count: 3, from: { raceId: 'g', raceName: 'Girls 5K', active: true }, to: { raceId: 'b', raceName: 'Boys 5K', active: true } }] }, 'b'),
      ['3 reads from port 5566 move from Girls 5K to this race.']);
  });

  test('V1, V5: a race unticked at start, and a deleted race back in the settings, are red Live warnings', () => {
    const st = two();
    st.unticked = [{ raceId: 'b', raceName: 'Boys 5K', keptId: 'g', keptName: 'Girls 5K', why: 'both take port 5565' }];
    st.deletedBack = [{ raceId: 'g', raceName: 'Girls 5K', deletedName: 'Girls 5K', deletedAt: null, count: 3 }];
    const ws = A.settingsNotices(st);
    assert.deepEqual(ws.map((w) => w.tone), ['bad', 'bad']);
    assert.equal(ws[0].text, 'When Split Relay started, Boys 5K and Girls 5K were both Active, and they both take port 5565, so a read could go to only one of them. Split Relay kept Girls 5K Active and unticked Active on Boys 5K. If Boys 5K is the race running now, switch to it.');
    assert.deepEqual(ws[0].action, { label: 'Switch to Boys 5K…', cmd: 'switch', raceId: 'b' });
    assert.match(ws[1].text, /^Girls 5K was deleted, but it is back in the settings: config\.json was put back from an older copy \(config\.json\.bak\) or edited\. The 3 reads it had when it was deleted stay out of use; only its reads from now on count\./);
    assert.deepEqual([ws[1].action.cmd, ws[1].more[0].cmd], ['keep-race', 'delete-race']);
    assert.ok(A.globalWarnings(st, NOW).slice(0, 2).every((w) => w.tone === 'bad'), 'first on the Live tab');
  });

  test('V2, V4: "Put it back" is explained; stale texts are accurate', () => {
    const st = two();
    const m = { raceId: 'r_f', raceName: 'Frosh 3K', count: 7, file: 'races\\r_f.json', hasSettings: true };
    assert.deepEqual(A.restoreMissingText(m, st), [
      'Frosh 3K is added back to the settings as it was saved in data\\races\\r_f.json, and its 7 reads are used again. Each output gets only the splits it is missing.',
      'If it would take the reads of a race that is Active now (the same RR12 port or contest), it comes back not Active, so the running race keeps its reads.',
    ]);
    // State.missingRaces[].inputPort (the port its race file keeps): the dialog says beforehand that it comes back not Active
    const g = A.configRace(st, 'g');
    assert.equal(A.restoreMissingText({ ...m, inputPort: g.inputPort }, st)[1],
      `Girls 5K is Active on port ${g.inputPort}, so Frosh 3K comes back not Active. Switch to it when it runs.`);
    assert.match(A.deleteRaceText(race('g'), view('g'), null)[1], /until you list them on an Active race\.$/);
  });

  test('new status words: "Extra pass (ignored)" and "Too early for this split (ignored)", with glossary lines', () => {
    assert.equal(A.statusInfo('extra').label, 'Extra pass (ignored)');
    assert.equal(A.statusInfo('too-early').label, 'Too early for this split (ignored)');
    assert.match(A.statusInfo('extra').meaning, /^More passes than this race has splits — ignored\./);
    assert.match(A.statusInfo('extra').meaning, /laps to go 0/);
    assert.match(A.statusInfo('too-early').meaning, /earliest race time/);
    for (const k of ['extra', 'too-early']) {
      assert.ok(A.STATUS_ORDER.includes(k));
      assert.ok(!A.statusInfo(k).filtered, `${k} rows are shown`);
    }
  });

  test('L9: the Help checklist starts with the names file, then the RR12 exporter, and names the number of splits and the second port', () => {
    const items = A.helpChecklist(two());
    const keys = items.map(([k]) => k);
    // DESIGN 9.20 N5: the meet's .ppl first (RR12 sends only bibs), after "New meet?" as in the README (9.22 O32)
    assert.deepEqual(keys.slice(0, 5), ['newmeet', 'ppl', 'start', 'exporter', 'overlap']);
    assert.match(Object.fromEntries(items).newmeet, /^New meet\? Settings → Meet setup → Start a new meet…/);
    assert.equal(A.CHECKLIST_SHORT.newmeet, 'New meet? Start a new meet, then load the meet setup.');
    assert.match(Object.fromEntries(items).ppl, /^First, load the meet's names file/);
    assert.equal(A.CHECKLIST_SHORT.ppl, "First: load the meet's names file (.ppl).");
    const text = Object.fromEntries(items);
    assert.ok(text.exporter.includes(A.LAPTIME_EXPRESSION));
    assert.match(text.exporter, /the split mats only \(A and B\), not the finish/);
    assert.match(text.overlap, /sending to 192\.168\.0\.21:5566/);
    assert.match(text.splits, /Girls 5K: 2; Boys 5K: 2/);
    assert.match(text.trackscore, /Karmarush/);
    assert.ok(keys.indexOf('exporter') < keys.indexOf('names'));
  });
});

describe('revision 8 (DESIGN 9.16)', () => {
  const lap = (id, extra = {}) => race(id, { contests: [], inputPort: 5565,
    splits: [{ id: id + 's1', name: 'Split 1', sources: [], earliest: '' }, { id: id + 's2', name: 'Split 2', sources: [], earliest: '' }], ...extra });

  /**
   * A real engine: a 3-split race whose passes went out, then fixed to 2 splits a minute later (bib 507 missed the
   * first mat), for RaceView.stale and .leftover as the server gives them.
   */
  function fixedSplitCount() {
    let now = Date.UTC(2026, 9, 18, 14, 0, 0);
    const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
    const splits = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: `Split ${i + 1}`, sources: [], earliest: i === 1 ? '12:00' : '' }));
    const cfg = { version: 1, filter: { tagWindowSec: 10, holdSec: 0 },
      races: [{ id: 'b', name: 'Boys 5K', eventNumber: '5', round: '1', heat: '1', contests: [], inputPort: 5565, gun: '10:00:00.000', splits: splits(3), finishSources: [], active: true }],
      outputs: [{ id: 'o_ts', name: 'TrackScore B', enabled: true, races: [] }] };
    const e = new Engine({ getConfig: () => cfg, clock, autoStart: false });
    e.start();
    const pass = (bib, min) => e.handleRead({ location: '', bib: String(bib), tod: tod(10, min, 0), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
    pass(501, 7);
    pass(501, 16);
    pass(507, 17);
    now += 61_000;
    cfg.races[0].splits = splits(2);
    e.configChanged();
    return { e, cfg };
  }

  test('F1: what a Resend corrects and what it cannot, in the server\'s words, in the prompt, the dialog and the split-count dialog', () => {
    assert.equal(A.RESEND_LIMIT, SERVER_RESEND_LIMIT, "the panel's words are the server's");
    const { e, cfg } = fixedSplitCount();
    const rv = e.raceView('b');
    assert.deepEqual([rv.leftover.count, rv.leftover.runners], [1, ['507']]);
    const p = A.resendPrompt(rv);
    // what is out of date, then what a Resend corrects and, counted, what it can't
    const limit = "Resend corrects every split Split Relay has. 1 cell sent earlier can't be removed from TrackScore by Split Relay (runner: 507). This runner has no split in that column under the current settings, so TrackScore and the live results may still show an old time there until the race is cleared there.";
    assert.deepEqual(A.resendPromptParts(p), ["TrackScore and Karmarush put splits in columns by laps to go; this race now has 2 splits instead of 3, so the splits already sent are in the wrong columns. Resend this race's splits.", limit]);
    assert.equal(A.resendPromptText(p), A.resendPromptParts(p).join(' '));
    assert.equal(A.resendLimitText(rv.leftover), limit);
    assert.equal(A.resendLimitText(null), A.RESEND_LIMIT);
    // the Resend dialog says the same
    const st = state({ races: cfg.races, views: [rv], outputs: [{ ...TRACKSCORE, id: 'o_ts', name: 'TrackScore B' }] });
    const body = A.resendDialogText(st, 'b').body;
    // (9.23 F14: the number it sends is the one its toast says; how many of them are out of date, and where)
    assert.match(body[0], /^Split Relay sends the 3 splits it has for Boys 5K again, with the current settings, gun time and places, to TrackScore B: 3 of them are out of date on TrackScore B now\.$/);
    assert.equal(body.at(-1), limit);
    // a gun moved past every split: nothing to send, and the dialog and the toast say so (not "no output takes it")
    const none = state({ races: cfg.races, views: [{ ...rv, splits: rv.splits.map((x) => ({ ...x, crossings: 0 })), resend: { count: 0, finished: 0 } }], outputs: [{ ...TRACKSCORE, id: 'o_ts', name: 'TrackScore B' }] });
    assert.equal(A.resendDialogText(none, 'b').body[0], 'Split Relay has no splits for Boys 5K under the current settings, so nothing is sent to TrackScore B; the splits sent earlier stop counting as out of date.');
    // with nothing to send, nothing can switch TrackScore's race or touch a finished runner's place
    const noneText = A.resendDialogText(none, 'b').body.join('\n');
    assert.doesNotMatch(noneText, /switches to/);
    assert.doesNotMatch(noneText, /Runners who have finished are left out/);
    assert.equal(A.resendToast('Boys 5K', { sent: 0, skippedFinished: 0, outputs: 0 }, 0), 'Split Relay has no splits for Boys 5K under the current settings, so nothing was sent.');
    assert.match(A.resendToast('Boys 5K', { sent: 0, skippedFinished: 0, outputs: 0 }, 3), /no output takes this race/);
    // the "Give Boys 5K 2 splits?" dialog, before the save, says it too
    assert.ok(A.columnsChangeText(3, 2).endsWith(A.RESEND_LIMIT));
    // a stale prompt for a gun change ends with the same words; no count when the server knows of no such cell
    const gun = A.resendPromptText(A.resendPrompt(view('g', { resendSuggested: true, stale: { count: 4, byOutput: [], reason: 'changed' } })));
    assert.equal(gun, `4 splits already sent are out of date. The gun time, the splits or the places changed after they went out. Resend this race's splits. ${A.RESEND_LIMIT}`);
    assert.equal(A.resendPromptText(A.resendPrompt(view('g'), { count: 2 })), `The gun time changed after 2 splits were sent, so TrackScore still shows the old race times. Resend this race's splits. ${A.RESEND_LIMIT}`);
  });

  test('F1: leftoverText counts cells and names the runners, the first 12 and how many more', () => {
    assert.equal(A.leftoverText(null), '');
    assert.equal(A.leftoverText({ count: 0, runners: [] }), '');
    assert.equal(A.leftoverText({ count: 2, runners: ['507', '519'] }), "2 cells sent earlier can't be removed from TrackScore by Split Relay (runners: 507, 519). These runners have no split in those columns under the current settings, so TrackScore and the live results may still show an old time there until the race is cleared there.");
    assert.match(A.leftoverText({ count: 14, runners: Array.from({ length: 14 }, (_, i) => String(i + 1)) }), /\(runners: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 and 2 more\)/);
    assert.equal(A.leftoverText({ count: 3, runners: ['9'], text: 'The server says so.' }), 'The server says so.');
  });

  test('F3: "Ready: not sent" is a warning word with a glossary line; "Sent" means an output took it', () => {
    const info = A.statusInfo('ready');
    assert.equal(info.label, 'Ready: not sent');
    assert.equal(info.tone, 'warn');
    assert.ok(!info.filtered);
    assert.ok(A.STATUS_ORDER.includes('ready'));
    assert.match(info.meaning, /no output took it/);
    assert.match(A.statusInfo('sent').meaning, /an output .* took it/);
    const rows = A.filterFeed([{ id: 1, status: 'ready', bib: '1' }, { id: 2, status: 'sent', bib: '2' }], { problemsOnly: true }).rows;
    assert.deepEqual(rows.map((r) => r.bib), ['1'], '"Problems only" shows it');
  });

  test('F4: with two RR12 ports, "RR12 isn\'t connected" names every port that has no connection, with its race', () => {
    const st = state({ races: [lap('g', { name: 'Girls 5K' }), lap('b', { name: 'Boys 5K', inputPort: 5566 })], views: [view('g'), view('b')], outputs: [TRACKSCORE] });
    st.config.input = { ports: [5565, 5566] };
    st.inputs = [
      { port: 5565, listening: true, connections: [], totalLines: 0, lastLineAt: null, format: null },
      { port: 5566, listening: true, connections: [], totalLines: 0, lastLineAt: null, format: null },
    ];
    const rr = (s) => A.globalWarnings(s, NOW).filter((w) => /^RR12 isn't connected/.test(w.text));
    // RR12 showing "connected" while nothing reaches Split Relay: the details say a running exporter keeps the address
    // it was started with (Stop and start it after changing the port; Pause and Resume keep the old connection)
    assert.match(A.RR_CONNECTED_HINT, /Stop the exporter and start it again \(Pause and Resume keep the old connection\)/);
    assert.deepEqual(rr(st).map((w) => [w.tone, w.text]), [['warn',
      "RR12 isn't connected on ports 5565 and 5566. In RR12, press play on the Split Relay exporters that send to 192.168.0.21:5565 (Girls 5K) and 192.168.0.21:5566 (Boys 5K)."]]);
    // one of them connected: the other, which feeds an Active race, is still named
    st.inputs[0].connections = [{ id: 1 }];
    assert.deepEqual(rr(st).map((w) => w.text), [
      "RR12 isn't connected on port 5566. In RR12, press play on the Split Relay exporter that sends to 192.168.0.21:5566 (Boys 5K)."]);
    // a second port no Active race reads from yet (the next overlapping race) is not a problem
    st.config.races[1].active = false;
    assert.deepEqual(rr(st), []);
    // none connected: every port, the ones no Active race reads from too
    st.inputs[0].connections = [];
    assert.match(rr(st)[0].text, /^RR12 isn't connected on ports 5565 and 5566\. .* to 192\.168\.0\.21:5565 \(Girls 5K\) and 192\.168\.0\.21:5566\.$/);
    // one port: the words as before
    const one = state({ races: [race('a')], views: [view('a')], outputs: [TRACKSCORE], input: { connections: [] } });
    assert.deepEqual(rr(one).map((w) => w.text), ["RR12 isn't connected. In RR12, press play on the Split Relay exporter (sending to 192.168.0.21:5565)."]);
    assert.equal(rr(one)[0].hint, A.RR_CONNECTED_HINT);
    assert.equal(A.rrNotConnected(one, [{ port: 5565, connections: [{ id: 1 }] }]), null);
  });

  test('F5: a FinishLynx folder with no .lif files yet says so, not "check the path"', () => {
    const lif = { enabled: true, inputDir: 'C:\\Lynx\\Meet', state: 'waiting', error: null, files: [],
      message: 'No FinishLynx .lif files in C:\\Lynx\\Meet yet. They appear when FinishLynx saves a race; a race with splits and a gun time gets a merged file of its own before that.' };
    assert.deepEqual(A.lifPill(lif), { tone: 'warn', text: '.lif files · no FinishLynx files yet', title: lif.message });
    assert.equal(A.lifWaitingText(lif), lif.message);
    assert.equal(A.lifWaitingText({ state: 'waiting', inputDir: 'C:\\Lynx\\Meet' }), 'No FinishLynx .lif files in C:\\Lynx\\Meet yet.', 'an older server');
    assert.doesNotMatch(A.lifPill(lif).text, /folder/);
  });

  test('F2: every scroll and focus target stops below the sticky top bar, at its live height', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
    const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(css, /html \{[^}]*scroll-padding-top: calc\(var\(--sticky-h, 0px\) \+ 12px\)/);
    assert.doesNotMatch(css, /scroll-margin-top: [1-9]/, 'no fixed guess of the bar height');
    assert.doesNotMatch(css, /top: 112px/);
    assert.match(js, /setProperty\('--sticky-h'/);
    assert.match(js, /new ResizeObserver\(\(\) => syncStickyHeight\(\)\)\.observe\(bar\)/);
    assert.match(js, /box = target\?\.closest\('\.gun-card'\)/, 'the gun box is revealed with its card: its label and button show too');
  });
});

describe('review tools (DESIGN 9.17)', () => {
  const R3 = () => race('g', { inputPort: 5565, gun: '10:00:00.000',
    splits: [{ id: 's1', name: '1K', sources: [], earliest: '' }, { id: 's2', name: '2K', sources: [], earliest: '' }, { id: 's3', name: '3K', sources: [], earliest: '' }] });
  const min = (m, s = 0, tenths = 0) => (m * 60 + s) * T + tenths * 1000;

  test('P6: "Split paused", "Check column", "Made-up time" and "Typed time" are status words with a glossary line', () => {
    const want = { 'split-paused': 'Split paused', 'check-column': 'Check column', 'made-up': 'Made-up time', typed: 'Typed time' };
    for (const [k, label] of Object.entries(want)) {
      const info = A.statusInfo(k);
      assert.equal(info.label, label);
      assert.ok(['ok', 'info', 'warn', 'bad', 'muted', 'finish'].includes(info.tone), `${k} has a tone`);
      assert.ok(info.meaning.length > 80, `${k} has a glossary line`);
      assert.ok(A.STATUS_ORDER.includes(k), `${k} is in the legend and the glossary`);
      assert.ok(!info.filtered, `${k} is never hidden as a filtered read`);
    }
    assert.match(A.statusInfo('split-paused').meaning, /not sent/);
    assert.match(A.statusInfo('split-paused').meaning, /\.lif/);
    assert.match(A.statusInfo('check-column').meaning, /Review/);
    assert.match(A.statusInfo('made-up').meaning, /estimate/);
    assert.match(A.statusInfo('made-up').meaning, /real read .* replaces it/);
    // a server that calls a made-up crossing 'manual' still gets the word
    assert.equal(A.statusInfo('manual').label, 'Made-up time');
    assert.match(A.statusInfo('finished-not-sent').meaning, /Send with finish place/);
  });

  test('P1: a split sends unless it is paused; a paused tile says how many it holds', () => {
    assert.equal(A.splitSending({ id: 's1' }), true, 'default: sending');
    assert.equal(A.splitSending({ id: 's1', sending: true }), true);
    assert.equal(A.splitSending({ id: 's1', sending: false }), false);
    assert.equal(A.splitHeld({ held: 14 }), 14);
    assert.equal(A.splitHeld({ heldCount: 3 }), 3);
    assert.equal(A.splitHeld({}), 0);
    assert.equal(A.splitHeld({ held: -2 }), 0);
    assert.equal(A.pausedText(14), 'Paused · 14 held');
    assert.equal(A.pausedText(1200), 'Paused · 1,200 held');
  });

  test('P1: saving the race form never plays a paused split, and the form draft never carries the pause', () => {
    const saved = R3();
    saved.splits[1].sending = false;
    const draft = A.raceToDraft(saved);
    assert.ok(draft.splits.every((s) => !('sending' in s)), 'pausing while the form is open does not make it "changed elsewhere"');
    const body = A.raceBody(draft, saved);
    assert.deepEqual(body.splits.map((s) => s.sending), [undefined, false, undefined]);
    // the pause as it is NOW: played meanwhile, the save does not pause it again
    const now = R3();
    assert.ok(A.raceBody(draft, now).splits.every((s) => !('sending' in s)));
    // a new split has no id and sends
    draft.splits.push({ name: 'Split 4', sources: [], earliest: '' });
    assert.equal(A.raceBody(draft, saved).splits[3].sending, undefined);
  });

  test('P1: the pause and play toasts say what is kept, what is sent and where', () => {
    const dest = { outputs: ['TrackScore', 'Live results'], lif: true };
    assert.equal(A.sendingToast('1K', false, 0, dest), '1K is paused: its splits are kept but not sent to TrackScore and Live results or the merged .lif file. Press ▶ Play to send them.');
    assert.match(A.sendingToast('1K', true, 14, dest), /^1K is sending again: 14 held splits go out now\. .*Review lists them\.$/);
    assert.match(A.sendingToast('1K', true, 1, dest), /1 held split goes out now/);
    assert.match(A.sendingToast('1K', true, 0, dest), /^1K is sending again\. /);
  });

  test('P6: the Review button says what waits: "3 missing splits · 1 to check"', () => {
    const c = A.reviewCounts(view('g', { review: { missing: 3, estimable: 2, checks: 1, manual: 4 }, finishedNotSent: 0 }));
    // (9.23: the counts gained flagged, pinned and madeUp; an older server's made-up count is its manual count)
    assert.deepEqual(c, { known: true, missing: 3, estimable: 2, checks: 1, manual: 4, finishedNotSent: 0, flagged: 0, pinned: 0, madeUp: 4 });
    assert.equal(A.reviewBadgeText(c), '3 missing splits · 1 to check');
    assert.equal(A.reviewTone(c), 'warn', 'a held pass needs the operator');
    const one = A.reviewCounts(view('g', { review: { missing: 1, estimable: 0, checks: 0, manual: 0 }, finishedNotSent: 2 }));
    assert.equal(A.reviewBadgeText(one), '1 missing split · 2 finished, not sent');
    assert.equal(A.reviewTone(one), 'info', 'nothing to send yet');
    assert.equal(A.reviewBadgeText(A.reviewCounts(view('g', { review: { missing: 0, checks: 0 } }))), '');
    // an older server: no review counts, no Review button
    assert.equal(A.reviewCounts(view('g')).known, false);
    assert.equal(A.reviewCounts(view('g', { review: { missing: 'x', checks: null } })).missing, 0, 'loose fields never break the page');
  });

  test('P6: the review tools show only for a Split Relay that has them', () => {
    assert.equal(A.reviewSupported(state({ races: [race('a')], views: [view('a')] })), false);
    assert.equal(A.reviewSupported(state({ races: [race('a')], views: [view('a', { review: { missing: 0 } })] })), true);
    const r = race('a');
    r.splits[0].sending = true;
    assert.equal(A.reviewSupported(state({ races: [r], views: [view('a')] })), true);
    assert.equal(A.notSupported({ status: 404, message: 'Split Relay answered "404 Not Found".' }), true);
    assert.equal(A.notSupported({ status: 404, message: 'Bib 999 has no reads in Girls 5K.' }), false, 'a refusal with a reason is said as it is');
    assert.equal(A.notSupported({ status: 400, message: 'Split Relay answered "400 Bad Request".' }), false);
  });

  test('P6: every dialog says where a time goes: the outputs that send the race, and the merged .lif file', () => {
    const st = state({ races: [R3(), race('b')], outputs: [{ ...TRACKSCORE, races: ['g'] }, LIVE, { ...LIVE, id: 'o_off', name: 'Old board', enabled: false }] });
    assert.deepEqual(A.destinations(st, 'g'), { outputs: ['TrackScore', 'Live results'], lif: true, paused: [], inactive: '' });
    assert.deepEqual(A.destinations(st, 'b'), { outputs: ['Live results'], lif: true, paused: [], inactive: '' });
    // a time that goes into a paused split waits there for Play, and the row says so
    st.config.races[0].splits[1].sending = false;
    const dest = A.destinations(st, 'g');
    assert.deepEqual(dest.paused, [{ id: 's2', name: '2K' }]);
    assert.equal(A.pausedNote(dest, 's2'), ' 2K is paused: it goes out when you press ▶ Play.');
    assert.equal(A.pausedNote(dest, 's1'), '');
    const item = { bib: '1', splitId: 's2', splitName: '2K', estimate: min(6), estimateText: '6:00.0', prev: null, next: null, finished: false };
    assert.match(A.manualSendLine(item, A.rowTime(item), dest), /\(made-up time\) to TrackScore and Live results, and into the merged \.lif file\. 2K is paused: it goes out when you press ▶ Play\.$/);
    assert.match(A.checkToast({ bib: '1', raceTicks: null, from: { id: 's1', name: '1K' }, to: { id: 's2', name: '2K' } }, true, dest), /2K is paused/);
    assert.equal(A.sendsTo({ outputs: ['TrackScore', 'Live results'], lif: true }), 'to TrackScore and Live results, and into the merged .lif file');
    assert.equal(A.sendsTo({ outputs: ['TrackScore'], lif: false }), 'to TrackScore (merged .lif files are off)');
    assert.equal(A.sendsTo({ outputs: [], lif: true }), 'into the merged .lif file only (no output sends this race)');
    assert.match(A.sendsTo({ outputs: [], lif: false }), /^nowhere yet: no output sends this race/);
    assert.equal(A.sendsTo({ outputs: ['TrackScore'], lif: true }, { lif: false }), 'to TrackScore', 'a split already in the .lif file');
  });

  test('P3: the review list is read loosely, with split names from the race and a key per row', () => {
    const cfg = R3();
    const d = A.normReview({
      missing: [
        { bib: 254, name: 'Runner A', team: 'Team A', splitId: 's2', estimate: min(6, 41, 3), estimateText: '6:41.3',
          basis: 'From 1K 3:20.4 and 3K 10:45.1, placed like the 30 runners nearest in pace (2K at 48.5% of that stretch)',
          prev: { splitId: 's1', raceTicks: min(3, 20, 4) }, next: { splitId: 's3', name: '3K', raceTicks: min(10, 45, 1) }, finished: false },
        { bib: '310', splitId: 's1', estimate: null, prev: 'gun', next: null },
        { bib: '412', splitId: 's3', estimate: min(11, 2), prev: { name: '2K', raceTicks: min(7) }, next: { kind: 'finish', raceTicks: min(15) }, finished: { place: 12 } },
        { splitId: 's1' }, null, 'junk',
      ],
      checks: [{ bib: '501', passTod: tod(10, 6, 52, 100), raceTicks: min(6, 52, 1), from: 's1', to: { splitId: 's2' } }],
      finishedNotSent: [{ bib: '118', splitId: 's3', raceTicks: min(10, 1), finishPlace: 4 }],
      manual: [{ bib: '254', splitId: 's1', raceTicks: min(3, 22), estimated: true, basis: 'b', at: NOW }, { bib: '77', splitId: 's2', raceTicks: min(7), estimated: false }],
    }, cfg);
    assert.equal(d.missing.length, 3, 'rows without a bib are left out');
    const [a, b, c] = d.missing;
    assert.equal(a.key, '254|s2');
    assert.equal(a.bib, '254');
    assert.equal(a.splitName, '2K', 'the split name from the race');
    assert.deepEqual(a.prev, { id: 's1', name: '1K', ticks: min(3, 20, 4) });
    assert.equal(a.next.name, '3K');
    assert.equal(a.finished, false);
    assert.equal(b.estimate, null);
    assert.equal(b.estimateText, '');
    assert.deepEqual(b.prev, { id: null, name: 'the gun', ticks: 0 });
    assert.equal(c.estimateText, '11:02.0', 'formatted when the server gives only ticks');
    assert.deepEqual([c.finished, c.finishPlace], [true, 12]);
    assert.deepEqual(c.next, { id: null, name: 'the finish', ticks: min(15) });
    const k = d.checks[0];
    assert.deepEqual([k.from.id, k.from.name, k.to.id, k.to.name], ['s1', '1K', 's2', '2K']);
    assert.equal(k.reason, 'Looks like 2K, not 1K (missed 1K?)', 'the words when the server gives none');
    assert.deepEqual(A.checkLabels(k), { move: 'Move to 2K', keep: 'Keep in 1K' });
    assert.equal(d.finishedNotSent[0].finishPlace, 4);
    assert.deepEqual(d.manual.map((m) => m.source), ['made-up', 'typed']);
    // (9.23: and the splits that look wrong)
    assert.deepEqual(A.normReview(null, cfg), { missing: [], checks: [], finishedNotSent: [], manual: [], flags: [] });
    // a check that names its split only by name still gets the id "Move" needs
    assert.equal(A.normReview({ checks: [{ bib: '9', passTod: 1, from: { name: '1K' }, to: { name: '2k' } }] }, cfg).checks[0].to.id, 's2');
  });

  test('P3/P5: a row sends the estimate as it is, or a typed time that fits between the splits around it', () => {
    const item = { key: '254|s2', bib: '254', splitId: 's2', splitName: '2K', estimate: min(6, 41, 3) + 120, estimateText: '6:41.3', basis: 'From 1K and 3K',
      prev: { id: 's1', name: '1K', ticks: min(3, 20, 4) }, next: { id: 's3', name: '3K', ticks: min(10, 45, 1) }, finished: false, finishPlace: null };
    const est = A.rowTime(item, undefined);
    assert.deepEqual(est, { text: '6:41.3', ticks: min(6, 41, 3) + 120, typed: false, problem: '', sendable: true }, 'the exact estimate, not the rounded text');
    assert.deepEqual(A.manualBody(item, est), { bib: '254', splitId: 's2', basis: 'From 1K and 3K' }, 'no time: Split Relay sends its own estimate, marked made-up');
    assert.equal(A.rowTime(item, ' 6:41.3 ').typed, false, 'the estimate typed again is still the estimate');
    const typed = A.rowTime(item, '6:39.9');
    assert.deepEqual([typed.typed, typed.ticks, typed.sendable], [true, min(6, 39, 9), true]);
    assert.deepEqual(A.manualBody(item, typed), { bib: '254', splitId: 's2', time: '6:39.9', basis: 'Typed in Review (the estimate was 6:41.3).' });
    assert.equal(A.rowTime(item, '639').problem, '"639" is not a race time. Type it like 6:41.3 (minutes:seconds).');
    assert.equal(A.rowTime(item, '3:20.0').problem, '2K must be later than 1K (3:20.400).');
    assert.equal(A.rowTime(item, '10:45.1').problem, '2K must be earlier than 3K (10:45.100).');
    assert.equal(A.rowTime(item, '').sendable, false);
    // no later split or finish yet: no estimate, but a time can be typed
    const waiting = { ...item, estimate: null, estimateText: '', next: null };
    assert.match(A.rowTime(waiting, undefined).problem, /waiting for a later split or the finish/);
    assert.equal(A.rowTime(waiting, '40:00').sendable, true);
    assert.equal(A.manualBoundsProblem(min(0, 0), { splitName: '1K', prev: { name: 'the gun', ticks: 0 } }), '1K must be later than the gun.');
  });

  test('P4: a runner who finished: sent with the finish place, said before; without a known place it cannot be sent', () => {
    const dest = { outputs: ['TrackScore'], lif: true };
    const item = { key: '412|s3', bib: '412', splitId: 's3', splitName: '3K', estimate: min(11, 2), estimateText: '11:02.0',
      prev: { name: '2K', ticks: min(7) }, next: { name: 'the finish', ticks: min(15) }, finished: true, finishPlace: 12 };
    const row = A.rowTime(item, undefined);
    assert.equal(A.manualSendLine(item, row, dest), 'Sends 3K 11:02.0 (made-up time) with place 12 (the finish place, so TrackScore keeps it) to TrackScore, and into the merged .lif file.');
    const t = A.finishedManualText(item, row, dest);
    assert.match(t.body[0], /place 12, the finish place, and TrackScore keeps it/);
    assert.match(t.body[1], /goes to TrackScore, and into the merged \.lif file/);
    const noPlace = A.rowTime({ ...item, finishPlace: null }, undefined);
    assert.equal(noPlace.sendable, false);
    assert.equal(noPlace.problem, A.FINISHED_NO_PLACE);
    assert.match(A.FINISHED_NO_PLACE, /a finisher's splits go out with it/);
    const f = A.finishedSendText([{ bib: '118', splitName: '3K', raceTicks: min(10, 1), finishPlace: 4 }], dest);
    assert.equal(f.title, "Send bib 118's 3K with the finish place?");
    assert.match(f.body[0], /^3K 10:01\.0 goes to TrackScore, with the runner's finish place \(4\) as the place, so TrackScore keeps the finish place/);
    assert.match(f.body[1], /in the merged \.lif file already/);
    assert.equal(A.finishedSendText([{ bib: '1' }, { bib: '2' }], dest).confirm, 'Send 2');
  });

  test('revision 10: the panel\'s words are the server\'s; a split sent with an old time; a lone pass; the split place a finish place sets', () => {
    assert.equal(A.LONE_TEXT, SERVER_LONE_TEXT);
    assert.equal(A.sentOldText('2 Mile', '29:12.1', '18:47.3'), serverSentOldText('2 Mile', '29:12.1', '18:47.3'));
    assert.equal(A.sentOldText('2 Mile', '29:12.1', '18:47.3'),
      'Sent with an old time (29:12.1): TrackScore and the live results show that as 2 Mile. Send the corrected time (18:47.3) with the finish place.');
    assert.equal(A.sentAfterText(58, 50), serverSentAfterText(58, 50));
    assert.equal(A.sentAfterText(58, 50), "Sent after the runner finished, with place 58: TrackScore and the live results may show that as the runner's place. Send it with the finish place (50).");
    const after = A.normReview({ raceId: 'r', finishedNotSent: [{ bib: '2313', splitId: 's2', splitName: '2 Mile', raceTicks: min(10, 5), finishPlace: 50, sentAfter: { place: 58 } }] }, null).finishedNotSent;
    assert.deepEqual(after.map((x) => [x.bib, x.sentAfter?.place]), [['2313', 58]]);
    assert.ok(A.finishedSendText(after, { outputs: ['TrackScore'], lif: true }).body.includes('It was sent just after the runner finished, with the split place (58): this puts the finish place back in TrackScore.'));
    const dest = { outputs: ['TrackScore'], lif: true };
    // R5: a finisher's made-up split carries the finish place, which TrackScore also takes as the split place there
    const item = { key: '412|s3', bib: '412', splitId: 's3', splitName: '3K', estimate: min(11, 2), estimateText: '11:02.0',
      prev: { name: '2K', ticks: min(7) }, next: { name: 'the finish', ticks: min(15) }, finished: true, finishPlace: 12 };
    const t = A.finishedManualText(item, A.rowTime(item, undefined), dest);
    assert.equal(t.body[2], "TrackScore also shows place 12 as the runner's place at 3K: a split packet carries only one place.");
    const plan = A.sendAllPlan([{ ...item, key: 'a' }]);
    assert.match(A.sendAllText(plan, dest).body.join(' '), /TrackScore also shows it as their place at that split: a split packet carries only one place\./);
    // R3: Review's "Finished: not sent live" with a split that went out with an old time
    const r = A.normReview({ raceId: 'r', finishedNotSent: [
      { bib: '3403', splitId: 's2', splitName: '2 Mile', raceTicks: min(18, 47.3), finishPlace: 315, sentOld: { raceTicks: min(29, 12.1), timeText: '29:12.1' } },
      { bib: '3404', splitId: 's3', splitName: '3 Mile', raceTicks: min(29), finishPlace: 316 },
    ], checks: [{ bib: '7', from: 's1', to: 's2', fromName: '1K', toName: '2K', passTod: 1, raceTicks: min(6), lone: true }] }, null);
    assert.deepEqual(r.finishedNotSent.map((x) => [x.bib, x.sentOld?.timeText ?? null]), [['3403', '29:12.1'], ['3404', null]]);
    assert.equal(r.checks[0].lone, true);
    const f = A.finishedSendText([r.finishedNotSent[0]], dest);
    assert.deepEqual(f.body.slice(1), ['It is in the merged .lif file already.', 'It was sent earlier with an old time (29:12.1): the corrected time replaces it.',
      "TrackScore also shows place 315 as the runner's place at 2 Mile: a split packet carries only one place."]);
    assert.match(A.finishedSendText(r.finishedNotSent, dest).body.join(' '), /1 of them was sent earlier with an old time: the corrected time replaces it\./);
    // the runner view: a finished runner's split not sent live (and the old time TrackScore has)
    const runner = A.normRunner({ bib: '3403', finishPlace: 315, finished: true, finishTicks: min(35, 48), columns: [
      { splitId: 's1', splitName: '1 Mile', time: min(8, 50.6), source: 'made-up', delivered: true, finishedNotSent: false },
      { splitId: 's2', splitName: '2 Mile', time: min(18, 47.3), source: 'read', delivered: false, finishedNotSent: true, sentOld: { raceTicks: min(29, 12.1), timeText: '29:12.1' } },
    ] }, null);
    assert.deepEqual(runner.columns.map((c) => [c.finishedNotSent, c.sentOld?.timeText ?? null]), [[false, null], [true, '29:12.1']]);
    assert.match(A.PLAYING_TITLE, /first reads FinishLynx's results/);
  });

  test('P6: "Send all" says how many, where they go, and what is left out and why', () => {
    const base = { prev: { name: '1K', ticks: min(3) }, next: { name: '3K', ticks: min(10) }, splitName: '2K', splitId: 's2', finished: false, finishPlace: null };
    const rows = [
      { ...base, key: 'a', bib: '1', estimate: min(6), estimateText: '6:00.0' },
      { ...base, key: 'b', bib: '2', estimate: min(6, 30), estimateText: '6:30.0' },
      { ...base, key: 'c', bib: '3', estimate: min(7), estimateText: '7:00.0', finished: true, finishPlace: 9 },
      { ...base, key: 'd', bib: '4', estimate: min(7), estimateText: '7:00.0', finished: true },
      { ...base, key: 'e', bib: '5', estimate: null, estimateText: '', next: null },
    ];
    const plan = A.sendAllPlan(rows, new Map([['b', '6:20.0']]));
    assert.deepEqual(plan.send.map((x) => x.item.bib), ['1', '2', '3']);
    assert.deepEqual([plan.noPlace.map((m) => m.bib), plan.waiting.map((m) => m.bib), plan.problems.length], [['4'], ['5'], 0]);
    const t = A.sendAllText(plan, { outputs: ['TrackScore', 'Live results'], lif: true });
    assert.equal(t.title, 'Send 3 made-up split times?');
    assert.equal(t.confirm, 'Send 3');
    assert.equal(t.body[0], '3 split times go out now to TrackScore and Live results, and into the merged .lif file. Each is ranked with the real splits at its split.');
    assert.match(t.body.join(' '), /1 of them is a time you typed/);
    assert.match(t.body.join(' '), /1 runner has finished: that split goes with the finish place/);
    assert.match(t.body.join(' '), /Left out: 1 runner who finished without a known finish place \(bib 4\)/);
    assert.match(t.body.join(' '), /Left out: 1 missing split with no estimate yet/);
    assert.match(t.body.at(-1), /estimates, not timed splits/);
    // a typed time that does not fit stops Send all and is pointed at
    assert.equal(A.sendAllPlan(rows, new Map([['a', '2:00.0']])).problems[0].item.bib, '1');
    // runners are counted once: a finisher no mat read has a row for every split
    const runs = [{ ...base, key: 'x1', bib: '30', splitId: 's1', splitName: '1K', estimate: min(3), estimateText: '3:00.0', prev: null, finished: true, finishPlace: 28 },
      { ...base, key: 'x2', bib: '30', estimate: min(6), estimateText: '6:00.0', finished: true, finishPlace: 28 },
      { ...base, key: 'x3', bib: '15', estimate: min(6, 30), estimateText: '6:30.0', finished: true, finishPlace: 15 },
      { ...base, key: 'x4', bib: '29', estimate: min(6, 40), estimateText: '6:40.0' }];
    const words = A.sendAllText(A.sendAllPlan(runs), { outputs: ['TrackScore'], lif: true }).body.join(' ');
    assert.match(words, /2 runners have finished: their 3 splits go with the finish place/);
    assert.match(A.sendAllText(A.sendAllPlan(runs.slice(0, 3)), { outputs: ['TrackScore'], lif: true }).body.join(' '), /2 runners have finished: those splits go with the finish place/);
  });

  test('P2: a column check says what Move and Keep do; Remove says TrackScore keeps a time it was sent', () => {
    const c = { bib: '501', raceTicks: min(6, 52, 1), from: { id: 's1', name: '1K' }, to: { id: 's2', name: '2K' } };
    const dest = { outputs: ['TrackScore'], lif: true };
    assert.equal(A.checkToast(c, true, dest), 'Bib 501: the pass at 6:52.1 is 2K now, and goes to TrackScore, and into the merged .lif file. 1K is empty for them: Review lists it as a missing split.');
    assert.equal(A.checkToast(c, false, dest), 'Bib 501: the pass at 6:52.1 stays 1K, and goes to TrackScore, and into the merged .lif file.');
    const r = A.removeManualText({ bib: '254', splitName: '2K', raceTicks: min(6, 41, 3), source: 'made-up' }, dest);
    assert.equal(r.title, "Remove bib 254's made-up 2K time?");
    assert.match(r.body[0], /takes it out of the merged \.lif file, and Review lists the split as missing again/);
    assert.match(r.body[1], /TrackScore keeps the time it was sent: a split packet can fill a cell but never empty one/);
    assert.equal(A.removeManualText({ bib: '1', splitName: '1K', raceTicks: 0, source: 'typed' }, { outputs: [], lif: false }).body.length, 1);
  });

  test('P3: the runner view: each column with its source, an empty one with its estimate and the splits around it', () => {
    const cfg = R3();
    const r = A.normRunner({
      bib: '254', name: 'Runner A', team: 'Team A', finished: { place: 14, raceTicks: min(15, 2, 3) },
      columns: [
        { splitId: 's1', raceTicks: min(3, 20, 4), place: 12, source: 'read' },
        { splitId: 's2', raceTicks: null, estimate: min(6, 41, 3), basis: 'From 1K and 3K' },
        { splitId: 's3', raceTicks: min(10, 45, 1), place: 15, source: 'typed' },
      ],
      passes: [{ tod: tod(10, 3, 20, 400), raceTicks: min(3, 20, 4), splitId: 's1', how: 'counted' }, { tod: tod(10, 10, 45, 100), splitId: 's3', how: 'assigned' }],
    }, cfg);
    assert.deepEqual([r.bib, r.finished, r.finishPlace, r.finishTicks, r.found], ['254', true, 14, min(15, 2, 3), true]);
    assert.deepEqual(r.columns.map((c) => [c.splitName, c.source]), [['1K', 'read'], ['2K', ''], ['3K', 'typed']]);
    assert.deepEqual(r.columns[1].prev, { id: 's1', name: '1K', ticks: min(3, 20, 4) }, 'the split before, from the runner\'s own columns');
    assert.deepEqual(r.columns[1].next, { id: 's3', name: '3K', ticks: min(10, 45, 1) });
    assert.deepEqual(r.passes.map((p) => [p.splitName, p.how]), [['1K', 'counted in order'], ['3K', 'you moved it here']]);
    const item = A.columnItem(r, r.columns[1]);
    assert.deepEqual([item.key, item.estimateText, item.finished, item.finishPlace], ['254|s2', '6:41.3', true, 14]);
    assert.equal(A.rowTime(item, undefined).sendable, true);
    assert.equal(A.SOURCE_WORDS.typed, 'Typed time');
    // a runner with no split after the empty one: the finish is the next reference
    const tail = A.normRunner({ bib: '9', finishTicks: min(15), columns: [{ splitId: 's1', raceTicks: min(3) }, { splitId: 's2' }] }, cfg);
    assert.deepEqual(tail.columns[1].next, { id: null, name: 'the finish', ticks: min(15) });
    assert.equal(A.normRunner({ runner: { bib: '5', columns: [] } }, cfg).found, false, 'a runner Split Relay has nothing for');
    assert.equal(A.sourceOf({ source: 'manual', estimated: false }), 'typed');
    assert.equal(A.sourceOf({ estimated: true }, true), 'made-up');
  });

  test('P6: ordinals for the finish place, and the Help checklist and README say how to pause and review', async () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 112].map(A.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '112th']);
    const items = Object.fromEntries(A.helpChecklist(state({ races: [R3()] })));
    assert.match(items.review, /⏸ Pause/);
    assert.match(items.review, /Review/);
    const { readFile } = await import('node:fs/promises');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    for (const k of ['split-paused', 'check-column', 'made-up', 'typed']) {
      assert.ok(readme.includes(`| ${A.statusInfo(k).label} |`), `README explains "${A.statusInfo(k).label}"`);
    }
    assert.match(readme, /## Pausing a split/);
    assert.match(readme, /What "made-up" means for the results/);
  });

  test('P3: the server may name splits by their place in the course (col) and give references as { kind, col, t }', () => {
    const cfg = R3();
    const d = A.normReview({
      missing: [{ bib: '7', col: 1, estimate: min(6), prev: { kind: 'split', col: 0, t: min(3) }, next: { kind: 'finish', col: 3, t: min(15) } },
        { bib: '8', col: 0, estimate: min(3), prev: { kind: 'gun', col: -1, t: 0 }, next: { kind: 'split', col: 1, t: min(7) } }],
      checks: [{ bib: '9', passTod: 5, raceTicks: min(6), from: 0, to: 1 }],
      manual: [{ bib: '10', col: 2, raceTicks: min(11), estimated: true }],
    }, cfg);
    assert.deepEqual([d.missing[0].splitId, d.missing[0].splitName], ['s2', '2K']);
    assert.deepEqual(d.missing[0].prev, { id: 's1', name: '1K', ticks: min(3) });
    assert.deepEqual(d.missing[0].next, { id: null, name: 'the finish', ticks: min(15) });
    assert.deepEqual(d.missing[1].prev, { id: null, name: 'the gun', ticks: 0 });
    assert.deepEqual([d.checks[0].from.id, d.checks[0].to.id, d.checks[0].reason], ['s1', 's2', 'Looks like 2K, not 1K (missed 1K?)']);
    assert.equal(d.manual[0].splitName, '3K');
    assert.equal(A.rowTime(d.missing[0], '2:59.0').problem, '2K must be later than 1K (3:00.000).');
  });

  /**
   * A real engine with a 3-split LapTime race (DESIGN 9.17): 12 runners at every mat, bib 105 missed 2K (its 3K pass
   * is held for a column check), bib 103 missed 3K and FinishLynx has no place for it yet, and bib 120 finished in
   * FinishLynx with no mat read (every split missing).
   */
  function reviewEngine() {
    let now = Date.UTC(2026, 9, 18, 14, 0, 0);
    const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
    const cfg = { version: 1, filter: { tagWindowSec: 10, holdSec: 0, startIgnoreSec: 60 }, races: [{ ...R3(), name: 'Girls 5K' }],
      outputs: [{ id: 'o_ts', name: 'TrackScore', enabled: true, races: [] }] };
    const lynx = new Map();
    const places = new Map();
    const e = new Engine({ getConfig: () => cfg, clock, autoStart: false, deliver: (id, p, ack) => { ack(true); return true; },
      finishers: () => lynx, finishPlaces: () => places });
    e.start();
    const pass = (bib, sec) => e.handleRead({ location: '', bib: String(bib), tod: tod(10, 0, 0) + Math.round(sec * T), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
    for (let k = 1; k <= 3; k++) {
      for (let i = 0; i < 12; i++) if (!(i === 5 && k === 2) && !(i === 3 && k === 3)) pass(100 + i, 180 * k * (1 + 0.02 * i));
    }
    for (let i = 0; i < 12; i++) {
      lynx.set(String(100 + i), Math.round(720 * (1 + 0.02 * i) * T));
      if (i !== 3) places.set(String(100 + i), i + 1);
    }
    lynx.set('120', min(14));
    places.set('120', 13);
    now += 5000;
    e.converge();
    return { e, cfg, lynx, places };
  }

  test('P3/P6: the review list and the runner view as a real Split Relay gives them', () => {
    const { e, cfg } = reviewEngine();
    const d = A.normReview(e.review('g'), cfg.races[0]);
    // bib 105's later passes wait for Move or Keep; its 2K is not listed as missing until then
    assert.deepEqual(d.checks.map((c) => [c.bib, c.from.name, c.to.name, c.from.id, c.to.id, c.delivered]), [['105', '2K', '3K', 's2', 's3', false]]);
    assert.ok(Number.isFinite(d.checks[0].passTod));
    assert.deepEqual(A.checkLabels(d.checks[0]), { move: 'Move to 3K', keep: 'Keep in 2K' });
    // bib 105 has finished: the pass goes into the .lif file only, and the toast says so (not "goes to TrackScore")
    assert.equal(d.checks[0].finished, true);
    assert.equal(A.checkToast(d.checks[0], true, { outputs: ['TrackScore'], lif: true }),
      'Bib 105: the pass at 9:54.0 is 3K now, and goes into the merged .lif file. Bib 105 has finished, so it is not sent live: Review then lists 3K under "Finished: not sent live", with Send with finish place. 2K is empty for them: Review lists it as a missing split.');
    assert.match(A.checkToast({ ...d.checks[0], finished: false }, true, { outputs: ['TrackScore'], lif: true }), /is 3K now, and goes to TrackScore, and into the merged \.lif file\./);
    const rows = new Map(d.missing.map((m) => [m.key, m]));
    assert.deepEqual([...rows.keys()].sort(), ['103|s3', '120|s1', '120|s2', '120|s3'].sort());
    // a row whose place FinishLynx hasn't given: Split Relay's own words, and Send is off
    const r103 = rows.get('103|s3');
    assert.match(r103.blocked, /^Bib 103 has finished, but Split Relay doesn't know the finish place/);
    assert.equal(A.rowTime(r103).sendable, false);
    assert.equal(A.rowTime(r103).problem, r103.blocked);
    // the finisher no mat read: the gun and the finish around a run of three, each sendable with its estimate
    const r = rows.get('120|s2');
    assert.deepEqual([r.prev.name, r.prev.ticks, r.next.name, r.next.ticks, r.finished, r.finishPlace, r.blocked], ['Gun', 0, 'Finish', min(14), true, 13, '']);
    assert.equal(A.rowTime(r).ticks, r.estimate, 'Send uses the exact estimate');
    assert.deepEqual(A.manualBody(r, A.rowTime(r)), { bib: '120', splitId: 's2', basis: r.basis });
    const plan = A.sendAllPlan(d.missing);
    assert.deepEqual([plan.send.length, plan.noPlace.map((m) => m.bib)], [3, ['103']]);
    // the runner view: the server gives a column's time as `time`
    const v = A.normRunner(e.runner('g', '105'), cfg.races[0]);
    assert.deepEqual(v.columns.map((c) => [c.splitName, c.raceTicks, c.status]), [['1K', min(3, 18), ''], ['2K', min(9, 54), 'check-column'], ['3K', null, '']]);
    assert.equal(v.suspect, true);
    // (9.23 F20: which pass, and the way on)
    assert.equal(v.columns[2].blocked, `Check bib 105's 2K first: 9:54.0 is held (it looks like 3K). Choose "It's right: keep it in 2K" or Move it in its menu; then 3K can be filled.`);
    assert.equal(A.rowTime(A.columnItem(v, v.columns[2]), '15:00.0').sendable, false, 'no time goes in before the check is settled');
    assert.deepEqual(v.passes.map((p) => p.how), ['Counted: 1K.', 'Counted: 2K.']);
    assert.equal(v.passes[1].suggestion, 'Looks like 3K, not 2K (missed 2K?)');
    const v120 = A.normRunner(e.runner('g', '120'), cfg.races[0]);
    assert.deepEqual([v120.found, v120.finished, v120.finishPlace, v120.finishTicks], [true, true, 13, min(14)]);
    assert.ok(v120.columns.every((c) => c.raceTicks == null && c.estimate != null && !c.blocked));
    assert.equal(v120.columns[1].estimate, r.estimate, 'the runner view shows the estimate the list shows');
    // sent: the made-up time is a column with its source, place and state
    const added = e.addManual('g', { bib: '120', splitId: 's1' }).added;
    const after = A.normRunner(e.runner('g', '120'), cfg.races[0]);
    // (the column's place is its rank at 1K; the packet carried the finish place, as the list says below)
    assert.deepEqual([after.columns[0].source, after.columns[0].raceTicks, Number.isInteger(after.columns[0].place)], ['made-up', added[0].raceTicks, true]);
    const m = A.normReview(e.review('g'), cfg.races[0]).manual[0];
    assert.deepEqual([m.bib, m.state, m.sent, m.place, m.withFinishPlace], ['120', 'active', true, 13, true]);
    assert.equal(A.manualStateText(m, { outputs: ['TrackScore'], lif: true }), 'Sent with the finish place (13). In the merged .lif file.');
  });

  test('P1/P4: a paused split and a race that is not Active are said where a time goes; "Send with finish place" then asks to force', () => {
    const { e, cfg } = reviewEngine();
    cfg.races[0].splits[0].sending = false;
    e.configChanged();
    const st = state({ races: cfg.races, views: [e.raceView('g')], outputs: [TRACKSCORE] });
    let dest = A.destinations(st, 'g');
    const d = A.normReview(e.review('g'), cfg.races[0]);
    const r = d.missing.find((x) => x.key === '120|s1');
    assert.match(A.manualSendLine(r, A.rowTime(r), dest), /1K is paused: it goes out when you press ▶ Play\.$/);
    // sent while paused: kept, not sent; the list says so
    e.addManual('g', { bib: '120', splitId: 's1' });
    const m = A.normReview(e.review('g'), cfg.races[0]).manual[0];
    assert.equal(m.sent, false);
    assert.equal(A.manualStateText(m, dest), 'Not sent yet: it goes to TrackScore, and into the merged .lif file. 1K is paused: it goes out when you press ▶ Play.');
    // a race that is not Active: nothing live, the .lif file only
    st.config.races[0].active = false;
    dest = A.destinations(st, 'g');
    assert.equal(dest.inactive, 'Girls 5K');
    assert.equal(A.sendsTo(dest), 'into the merged .lif file only (Girls 5K is not Active, so nothing goes to TrackScore until it is)');
    assert.equal(A.sendsTo({ ...dest, lif: false }), 'nowhere yet: Girls 5K is not Active, so nothing goes to TrackScore until it is');
    const f = A.finishedSendText([{ bib: '118', splitName: '3K', raceTicks: min(10, 1), finishPlace: 4 }], dest);
    assert.equal(f.force, true);
    assert.equal(f.confirm, 'Send anyway');
    assert.match(f.body[0], /^3K 10:01\.0 goes to TrackScore, with the runner's finish place/);
    assert.match(f.body.at(-1), /^Girls 5K is not Active\. If TrackScore is showing another race, a split of this race makes it switch/);
    assert.equal(A.finishedSendText([{ bib: '118', splitName: '3K', raceTicks: min(10, 1), finishPlace: 4 }], { ...dest, inactive: '' }).force, false);
    // what became of a made-up time that is not the runner's split any more
    assert.equal(A.manualStateText({ state: 'replaced' }, dest), 'Replaced by a real read of the mat.');
    assert.equal(A.manualStateText({ state: 'something-new' }, dest), 'Not used any more.');
  });

  test('P6: Split Relay\'s own "no such path" answer counts as an older Split Relay; its refusals are said as they are', () => {
    assert.equal(A.notSupported({ status: 404, message: 'Split Relay has no /api/races/r_1/review.' }), true);
    assert.equal(A.notSupported({ status: 404, message: 'Nothing to send: these splits went out already, or the runner is not finished. Reload the Review list.' }), false);
    // the rows Split Relay can't send (other than a finisher without a place) are left out of "Send all" with a word
    const base = { prev: { name: '1K', ticks: min(3) }, next: { name: '3K', ticks: min(10) }, splitName: '2K', splitId: 's2', finished: false, finishPlace: null };
    const plan = A.sendAllPlan([{ ...base, key: 'a', bib: '1', estimate: min(6), estimateText: '6:00.0' },
      { ...base, key: 'b', bib: '2', estimate: min(6), estimateText: '6:00.0', blocked: "Check bib 2's columns first (Review: Move or Keep)." }]);
    assert.deepEqual([plan.send.length, plan.blocked.map((m) => m.bib)], [1, ['2']]);
    assert.match(A.sendAllText(plan, { outputs: ['TrackScore'], lif: true }).body.join(' '), /Left out: 1 row Split Relay can't send yet \(bib 2\): each row says why\./);
  });

  test('P1: a paused split is a race warning with a one-click Play, so it is never forgotten', () => {
    const cfg = R3();
    cfg.splits[1].sending = false;
    const rv = view('g', { gunTicks: tod(10, 0, 0), splits: [{ id: 's1', crossings: 4 }, { id: 's2', crossings: 4, held: 3 }, { id: 's3', crossings: 0 }] });
    const ws = A.raceWarnings(rv, cfg, state({ races: [cfg], views: [rv] }), NOW);
    const w = ws.find((x) => x.action?.cmd === 'split-play');
    assert.equal(w.text, '2K is paused: 3 splits are held, not sent and not in the .lif file. Press Play when it can go out.');
    assert.equal(w.tone, 'warn');
    assert.deepEqual(w.action, { label: '▶ Play 2K', cmd: 'split-play', raceId: 'g', value: 's2' });
    cfg.splits[2].sending = false;
    const two = A.raceWarnings(rv, cfg, state({ races: [cfg], views: [rv] }), NOW).find((x) => x.action?.cmd === 'split-play');
    assert.match(two.text, /^2K and 3K are paused: 3 splits are held/);
    assert.equal(two.more[0].value, 's3');
    assert.equal(A.raceWarnings(rv, R3(), state({ races: [R3()], views: [rv] }), NOW).some((x) => x.action?.cmd === 'split-play'), false);
  });
});

describe('control room panel (the redesign\'s own helpers)', () => {
  const lap = (id, extra = {}) => race(id, { contests: [], inputPort: 5565,
    splits: [{ id: id + 's1', name: '1K', sources: [], earliest: '' }, { id: id + 's2', name: '2K', sources: [], earliest: '' }], ...extra });

  test('the address RR12 most likely reaches: the one in the network of an RR12 connection, else the first', () => {
    const st = state({ races: [lap('g')], views: [view('g')] });
    st.addresses = ['192.168.44.48', '192.168.8.70', '25.10.20.30'];
    assert.equal(A.likelyAddress(st), '192.168.44.48');
    st.input.connections = [{ id: 1, remote: '192.168.8.55:51234' }];
    assert.equal(A.likelyAddress(st), '192.168.8.70');
    assert.equal(A.rrTarget(st, 5566), '192.168.8.70:5566', 'one address in the words, not three');
    assert.equal(A.likelyAddress({ addresses: [] }), '');
    assert.equal(A.rrTarget({ addresses: [], config: { input: { ports: [5565] } } }), "this PC's IP address, port 5565");
  });

  test('how long something is down, and an output that stays down while a race runs turns red', () => {
    assert.deepEqual([0, 45000, 125000, 3725000].map(A.formatDuration), ['0 s', '45 s', '2 min', '1 h 2 min']);
    const o = { name: 'Scoreboard', enabled: true };
    const s = { state: 'disconnected', scriptOk: true, queued: 14 };
    assert.equal(A.outputLight(o, s, { since: NOW - 10000, running: true, now: NOW }).tone, 'warn');
    assert.equal(A.outputLight(o, s, { since: NOW - A.DOWN_RED_MS, running: true, now: NOW }).tone, 'bad');
    assert.equal(A.outputLight(o, s, { since: NOW - 600000, running: false, now: NOW }).tone, 'warn', 'no race running: amber');
    assert.equal(A.outputLight(o, s, { since: NOW - 10000, running: true, now: NOW }).word, 'not connected');
    assert.equal(A.outputLight({ ...o, enabled: false }, { state: 'disabled' }).word, 'off');
    assert.equal(A.outputLight(o, { state: 'connected', scriptOk: true }).word, '', 'a green light needs no word');
    const st = state({ races: [lap('g', { name: 'Girls 5K' })], views: [view('g', { gunTicks: tod(14, 50, 0), elapsedTicks: 600 * T })],
      outputs: [{ ...LIVE, id: 'o_sb', name: 'Scoreboard' }], statuses: [{ id: 'o_sb', state: 'disconnected', scriptOk: true, queued: 14 }] });
    const w = A.globalWarnings(st, NOW, [], { downSince: new Map([['out:o_sb', NOW - 120000]]) }).find((x) => x.id === 'out-down:o_sb');
    assert.equal(w.tone, 'bad');
    assert.equal(w.title, 'Scoreboard not connected · down 2 min · 14 waiting');
    assert.match(w.text, /^Scoreboard isn't connected \(/, 'the words as before');
  });

  test("RR12 not connected is red once its race has started; the race's own line is said once, by the port's", () => {
    const st = state({ races: [lap('g', { name: 'Girls 5K' }), lap('o', { name: 'Open 3K', inputPort: 5566 })],
      views: [view('g'), view('o', { gunTicks: tod(14, 59, 0), elapsedTicks: 60 * T })], outputs: [LIVE] });
    st.config.input = { ports: [5565, 5566] };
    st.inputs = [{ port: 5565, listening: true, connections: [{ id: 1 }] }, { port: 5566, listening: true, connections: [] }];
    const rr = A.rrNotConnected(st, A.inputsOf(st), st.config.races, NOW);
    assert.deepEqual([rr.tone, rr.title, rr.ports], ['bad', 'RR12 not connected on port 5566 · Open 3K', [5566]]);
    assert.equal(A.inputLight(st.inputs[1], st, NOW).tone, 'bad', 'the light says the same');
    const items = A.attentionItems(st, NOW);
    assert.equal(items.filter((w) => /not connected on port 5566/.test(w.title)).length, 1, 'one line, not two');
    assert.equal(items[0].tone, 'bad', 'red first');
  });

  test('which race TrackScore shows is one decision per output, asked again when the races running change', () => {
    const races = [lap('g', { name: 'Girls 5K' }), lap('b', { name: 'Boys 5K', inputPort: 5566 }), lap('x', { name: 'Open 3K', inputPort: 5567 })];
    const views = races.map((r) => view(r.id, { gunTicks: tod(14, 50, 0), elapsedTicks: 600 * T, runners: 10, finished: 0 }));
    const st = state({ races, views, outputs: [{ ...TRACKSCORE, races: ['g'] }, LIVE], statuses: [{ id: 'o_ts', state: 'connected', scriptOk: true, scriptInfo: { mid: null } },
      { id: 'o_live', state: 'connected', scriptOk: true, scriptInfo: { mid: '8132' } }] });
    const items = A.attentionItems(st, NOW);
    assert.equal(items.filter((w) => w.action?.cmd === 'output-race').length, 0, 'no line per race on the Dashboard');
    const d = items.find((w) => w.decision);
    assert.equal(d.title, 'TrackScore shows Girls 5K · Boys 5K and Open 3K also running');
    assert.equal(d.keepLabel, 'Keep Girls 5K');
    assert.deepEqual(d.picker.options.map((o) => o.id), ['b', 'x']);
    assert.equal(d.tone, 'info', 'a choice, not an alarm');
    assert.equal(A.attentionItems(st, NOW, [], { kept: new Map([['o_ts', d.sig]]) }).some((w) => w.decision), false, 'Keep hides it');
    // a race whose runners have all finished is not one TrackScore should switch to
    views[2].finished = 10;
    const after = A.attentionItems(st, NOW, [], { kept: new Map([['o_ts', d.sig]]) }).find((w) => w.decision);
    assert.equal(after.title, 'TrackScore shows Girls 5K · Boys 5K also running', 'the races running changed: asked again');
    // the race page still has its own line, with the one-click label the tests above pin
    assert.ok(A.raceWarnings(views[1], races[1], st, NOW).some((w) => w.action?.cmd === 'output-race'));
  });

  test('Send all, Play and Resend say what really happens', () => {
    const base = { prev: { name: '2K', ticks: (7 * 60) * T }, next: { name: 'the finish', ticks: (15 * 60) * T }, splitName: '4K', splitId: 's3', finished: false, finishPlace: null };
    const plan = A.sendAllPlan([{ ...base, key: 'a', bib: '1', estimate: 600 * T, estimateText: '10:00.0' },
      { ...base, key: 'b', bib: '2', splitId: 's2', splitName: '2K', estimate: 300 * T, estimateText: '5:00.0', prev: null, next: { name: '4K', ticks: 600 * T } }]);
    const dest = { outputs: ['TrackScore'], lif: true, paused: [{ id: 's3', name: '4K' }] };
    assert.equal(A.sendAllText(plan, dest).body[0], '1 split time goes out now to TrackScore, and into the merged .lif file; 1 (4K, paused) goes out when you press ▶ Play. Each is ranked with the real splits at its split.');
    assert.match(A.sendAllText({ ...plan, send: plan.send.slice(0, 1) }, dest).body[0], /^1 split time is kept until you press ▶ Play on 4K \(paused\); then it goes to TrackScore/);
    assert.equal(A.sendingToast('4K', true, 69, dest, { sent: 4, toReview: 65 }), '4K is sending again: 4 splits sent now · 65 splits of runners who finished meanwhile wait in Review.');
    const item = { key: '163|s3', bib: '163', ...base, estimate: 600 * T, estimateText: '10:00.0', finished: true, finishPlace: 26 };
    assert.match(A.finishedManualText(item, A.rowTime(item), dest).body[1], /4K is paused: it goes out when you press ▶ Play\.$/);
    const races = [race('girls', { name: 'Girls 5K', eventNumber: '3' })];
    const rv = view('girls', { splits: [{ id: 'girlss1', crossings: 209 }], runners: 70, finished: 70 });
    const st = state({ races, views: [rv], outputs: [TRACKSCORE] });
    assert.equal(A.resendDialogText(st, 'girls').confirm, 'Resend (70 finished left out)');
    assert.equal(A.resendDialogText(st, 'girls', { includeFinished: true }).confirm, 'Resend all 209 splits');
    assert.ok(A.resendDialogText(st, 'girls').body.includes('All 70 runners of Girls 5K have finished: without the box, only their made-up and typed times go.'));
  });

  test('a folder path as a trail of folders to click', () => {
    assert.deepEqual(A.pathCrumbs('C:\\Lynx\\Meet'), [{ name: 'C:', path: 'C:\\' }, { name: 'Lynx', path: 'C:\\Lynx' }, { name: 'Meet', path: 'C:\\Lynx\\Meet' }]);
    assert.deepEqual(A.pathCrumbs('\\\\server\\share\\x').map((c) => c.path), ['\\\\server\\share', '\\\\server\\share\\x']);
    assert.deepEqual(A.pathCrumbs('/home/me').map((c) => c.name), ['/', 'home', 'me']);
    assert.deepEqual(A.pathCrumbs(''), []);
  });

  test('the Help checklist has a one-line item for every step', () => {
    for (const [k] of A.helpChecklist(state({ races: [lap('g')] }))) assert.ok(A.CHECKLIST_SHORT[k], `a short line for ${k}`);
  });
});
describe('control room fixes (status strip, review rows, honest words, one confirm at a time)', () => {
  test('the status strip always fits: full, short names, dot and name, one light per kind, then without its labels', () => {
    const plans = A.stripPlans([{ kind: 'in', count: 3 }, { kind: 'out', count: 4 }, { kind: 'files', count: 1 }]);
    assert.deepEqual(plans.map((p) => [p.short, p.bare, p.grouped.join('+'), p.tight]), [
      [false, false, '', false], [true, false, '', false], [true, true, '', false],
      // the kind with the most lights folds first
      [true, true, 'out', false], [true, true, 'out+in', false], [true, true, 'out+in', true]]);
    // one port and one output: nothing to fold; the .lif and names lights never fold
    assert.ok(A.stripPlans([{ kind: 'in', count: 1 }, { kind: 'out', count: 1 }]).every((p) => !p.grouped.length));
    assert.ok(A.stripPlans([{ kind: 'files', count: 2 }]).every((p) => !p.grouped.includes('files')));
    // a folded light is as red as its worst light, and grey only when all of them are
    assert.equal(A.groupTone(['ok', 'muted', 'ok']), 'ok');
    assert.equal(A.groupTone(['muted', 'muted']), 'muted');
    assert.equal(A.groupTone(['ok', 'warn', 'muted']), 'warn');
    assert.equal(A.groupTone(['warn', 'bad', 'ok']), 'bad');
    assert.deepEqual(A.lightGroupSummary('in', [{ label: 'RR12 5842', tone: 'ok', state: 'receiving' },
      { label: 'RR12 5843', tone: 'bad', state: 'not connected' }, { label: 'RR12 5846', tone: 'muted', state: 'waiting' }]), {
      tone: 'bad', href: '#inputs', text: '3 ports',
      pop: ['RR12 ports · 1 not connected · 1 receiving · 1 waiting', 'RR12 5842 · receiving', 'RR12 5843 · not connected', 'RR12 5846 · waiting', 'Click to open the Inputs page.'],
    });
    assert.equal(A.lightGroupSummary('out', [{ label: 'TrackScore', tone: 'ok', state: 'connected' }, { label: 'Karmarush', tone: 'ok', state: 'connected' }]).pop[0],
      'Outputs · 2 connected');
  });

  test('a status light says its details in sentences, never ".."', () => {
    assert.equal(A.sentences(['RR12 5842', 'RR12 port 5842: receiving. Races: Girls 5K (Active).', 'Click to open its page.']),
      'RR12 5842. RR12 port 5842: receiving. Races: Girls 5K (Active). Click to open its page.');
    assert.equal(A.sentences(['TrackScore · off', '', 'Click to open its page.']), 'TrackScore · off. Click to open its page.');
    const st = state({ races: [race('g', { name: 'Girls 5K', inputPort: 5565 }), race('jv', { name: 'JV Girls 4K', inputPort: 5565, active: false })] });
    st.config.input = { ports: [5565, 5566] };
    st.inputs = [{ port: 5565, listening: true, connections: [{ id: 1 }], lastLineAt: NOW - 3000 }, { port: 5566, listening: true, connections: [] }];
    for (const i of st.inputs) {
      const l = A.inputLight(i, st, NOW);
      const said = A.sentences([l.label, l.title, 'Click to open its page.']);
      assert.doesNotMatch(said, /\.\./, said);
    }
  });

  test('Duplicate race says the copy starts not Active only for the reason that is true', () => {
    const races = [race('g', { name: 'Girls 5K', inputPort: 5565 }), race('jv', { name: 'JV Girls 4K', inputPort: 5565, active: false }),
      race('o', { name: 'Open 3K', inputPort: null, contests: ['OPEN'] })];
    const head = 'Copied. Type the event number FinishLynx has for this race, then save it.';
    // the original is not Active: the copy is like it, and no other race is blamed
    const jv = A.duplicateDraft(races[1], races);
    assert.equal(jv.active, false);
    assert.equal(A.duplicateToast(races[1], jv, races), `${head} It starts not Active, like the original: switch to it when it runs.`);
    // the original is Active on the copy's port: that is the reason
    const g = A.duplicateDraft(races[0], races);
    assert.equal(A.duplicateToast(races[0], g, races), `${head} It starts not Active, because the original is Active on the same RR12 port (5565): switch to it when it runs.`);
    // nothing clashes (no port): the copy is Active and nothing more is said
    const o = A.duplicateDraft(races[2], races);
    assert.equal(o.active, true);
    assert.equal(A.duplicateToast(races[2], o, races), head);
  });

  test("a finisher's split names the outputs that take the race, not TrackScore when it doesn't", () => {
    const item = { key: '233|s2', bib: '233', splitId: 's2', splitName: '2 Mile', estimate: 600 * T, estimateText: '10:00.0',
      prev: { name: '1 Mile', ticks: 300 * T }, next: { name: 'the finish', ticks: 900 * T }, finished: true, finishPlace: 40 };
    const row = A.rowTime(item);
    const karma = { outputs: ['Karmarush'], lif: true };
    assert.equal(A.keepsText(karma), 'so Karmarush keeps it');
    assert.equal(A.keepsText({ outputs: ['TrackScore', 'Karmarush'] }), 'so TrackScore and Karmarush keep it');
    assert.equal(A.keepsText({ outputs: [] }), '');
    assert.equal(A.manualSendLine(item, row, karma), 'Sends 2 Mile 10:00.0 (made-up time) with place 40 (the finish place, so Karmarush keeps it) to Karmarush, and into the merged .lif file.');
    const t = A.finishedManualText(item, row, karma);
    assert.match(t.body[0], /Karmarush takes the place in a split packet as the runner's place, so this split goes with place 40, the finish place, and Karmarush keeps it\./);
    assert.equal(t.body[2], "Karmarush also shows place 40 as the runner's place at 2 Mile: a split packet carries only one place.");
    const sent = A.finishedSendText([{ ...item, raceTicks: 600 * T }], karma);
    const all = [...t.body, ...A.sendAllText(A.sendAllPlan([item]), karma).body, ...sent.body].join(' ');
    assert.doesNotMatch(all, /TrackScore/, 'a race TrackScore does not get never says TrackScore');
    assert.match(sent.body[0], /, so Karmarush keeps the finish place and shows the split time\.$/);
    // no output takes the race: no one "keeps it"
    const none = { outputs: [], lif: true };
    assert.equal(A.manualSendLine(item, row, none).includes('keeps'), false);
    assert.equal(A.finishPlaceSplitNote('2 Mile', 40, none), '');
    assert.doesNotMatch(A.finishedManualText(item, row, none).body.join(' '), /TrackScore|keeps it/);
    // the Resend dialog of a race only the live results get
    const races = [race('b', { name: 'Boys 5K', eventNumber: '4' })];
    const rv = view('b', { splits: [{ id: 'bs1', crossings: 40 }], runners: 40, finished: 30, finishedNotSent: 2, review: { manual: 1 } });
    const st = state({ races, views: [rv], outputs: [{ ...TRACKSCORE, races: ['other'] }, LIVE] });
    const body = A.resendDialogText(st, 'b').body.join('\n');
    assert.match(body, /not in Live results as they are now .*with the finish place, so Live results keeps it\./);
    assert.match(body, /they carry the finish place, so Live results keeps it\./);
  });

  test('the new race form and its gun card agree: the Gun time box is optional, the card takes over once saved', () => {
    assert.match(A.NEW_RACE_GUN_HELP, /Gun time box \(optional\)/);
    assert.match(A.NEW_RACE_GUN_HELP, /once the race is saved/);
    assert.doesNotMatch(A.NEW_RACE_GUN_HELP, /Save the race first/);
  });
});

describe("the meet's names file (DESIGN 9.20)", () => {
  const lap = (id, extra = {}) => race(id, { contests: [], inputPort: 5565,
    splits: [{ id: id + 's1', name: '1K', sources: [], earliest: '' }, { id: id + 's2', name: '2K', sources: [], earliest: '' }], ...extra });
  /** Girls 5K Active on a LapTime port, Boys 5K not Active; TrackScore and Karmarush take every race. */
  const meet = ({ girls = [], boys = [], ppl = '', names = null, outputs = null, namesNeeded } = {}) => {
    const st = state({
      races: [lap('g', { name: 'Girls 5K' }), lap('b', { name: 'Boys 5K', active: false })],
      views: [view('g', { gunTicks: tod(10, 0, 0), gunText: '10:00:00.000', splits: girls }), view('b', { splits: boys })],
      outputs: outputs || [TRACKSCORE, { ...LIVE, id: 'o_kr', name: 'Karmarush' }],
    });
    st.inputs = [{ port: 5565, listening: true, connections: [{ id: 1 }], totalLines: 40, lastLineAt: NOW - 3000, format: 'laptime' }];
    st.config.names = { pplPath: ppl };
    if (names) st.names = names;
    if (namesNeeded !== undefined) st.namesNeeded = namesNeeded;
    return st;
  };
  const sent = [{ id: 'gs1', name: '1K', crossings: 30, held: 0 }, { id: 'gs2', name: '2K', crossings: 12, held: 0 }];
  const namesLine = (st) => A.globalWarnings(st, NOW).find((w) => w.id === 'names-file');

  test('N1: "No names file" is amber before any split went out, red (naming the outputs) once one did', () => {
    let w = namesLine(meet());
    assert.equal(w.tone, 'warn');
    assert.equal(w.step, 'names', 'the setup checklist stands for the amber line');
    w = namesLine(meet({ girls: sent }));
    assert.equal(w.tone, 'bad');
    assert.equal(w.title, "TrackScore and Karmarush get no names: choose the meet's names file (.ppl)");
    assert.equal(w.step, undefined, 'a red line always shows, checklist or not');
    assert.deepEqual(w.action, { label: 'Choose names file…', cmd: 'choose-ppl' });
    assert.match(w.text, /Girls 5K \(42 splits\) already went out without names; once the file is in, “Send names now” fills them in\.$/);
    // one output: "gets"
    w = namesLine(meet({ girls: sent, outputs: [{ ...TRACKSCORE, races: ['g'] }] }));
    assert.equal(w.title, "TrackScore gets no names: choose the meet's names file (.ppl)");
    // the line keeps its key from amber to red, so an opened row stays open
    const keys = [meet(), meet({ girls: sent })].map((st) => A.attentionItems(st, NOW).find((x) => x.id === 'names-file').key);
    assert.equal(keys[0], keys[1]);
  });

  test('N1: only splits that went out count: held by a pause, a race not Active, or every output off is still amber', () => {
    assert.equal(namesLine(meet({ girls: [{ id: 'gs1', crossings: 8, held: 8 }] })).tone, 'warn', 'a paused split held them all');
    assert.equal(namesLine(meet({ boys: sent })).tone, 'warn', 'Boys 5K is not Active');
    assert.equal(namesLine(meet({ girls: sent, outputs: [{ ...TRACKSCORE, enabled: false }] })).tone, 'warn', 'nothing was switched on to send them to');
    assert.equal(namesLine(meet({ girls: sent, outputs: [{ ...TRACKSCORE, races: ['b'] }] })).tone, 'warn', "TrackScore doesn't take Girls 5K");
    assert.equal(A.sentSplits(view('x', { splits: [{ crossings: 5, held: 2 }, { crossings: 3 }] })), 6);
    assert.deepEqual(A.racesSent(meet({ girls: sent })).map((r) => [r.id, r.sent, r.outputs]), [['g', 42, ['TrackScore', 'Karmarush']]]);
  });

  test('N1: no line once the file is in, or when RR12 sends names itself (SR lines)', () => {
    assert.equal(namesLine(meet({ girls: sent, ppl: 'C:\\Lynx\\Lynx.ppl', names: { path: 'C:\\Lynx\\Lynx.ppl', loaded: true, count: 412, error: null, loadedAt: NOW } })), undefined);
    assert.equal(namesLine(meet({ girls: sent, namesNeeded: false })), undefined, "the server's namesNeeded is the say");
    const sr = meet({ girls: sent });
    sr.inputs[0].format = 'sr';
    assert.equal(namesLine(sr), undefined);
    assert.equal(A.namesGap(sr).missing, false);
  });

  test("N1: a names file that can't be read: red once splits went out without names, amber while old names are still in use", () => {
    const path = '\\\\lynx-pc\\Lynx\\Lynx.ppl';
    let w = namesLine(meet({ girls: sent, ppl: path, names: { path, loaded: false, count: 0, error: `Names file not found: ${path}`, loadedAt: null } }));
    assert.equal(w.tone, 'bad');
    assert.equal(w.title, "TrackScore and Karmarush get no names: the names file can't be read");
    assert.deepEqual(w.action, { label: 'Choose names file…', cmd: 'choose-ppl' });
    assert.deepEqual(w.more, [{ label: 'Names file settings', href: '#settings/names' }]);
    assert.match(w.text, /The split packets go without names until it can\./);
    w = namesLine(meet({ girls: sent, ppl: path, names: { path, loaded: true, count: 412, error: 'Names file not found (still using the 412 names loaded earlier)', loadedAt: NOW } }));
    assert.equal(w.tone, 'warn');
    assert.equal(w.title, "The names file can't be read");
    assert.equal(w.step, 'names', 'amber: the setup checklist says it while it shows');
    assert.equal(A.namesGap(meet({ girls: sent, ppl: path, names: { path, loaded: true, count: 412, error: 'x', loadedAt: NOW } })).missing, false);
  });

  test('N2: "modified today 09:12": the date says whether a .ppl is this meet\'s', () => {
    const now = new Date(2026, 9, 21, 10, 30).getTime();
    assert.equal(A.modifiedText(new Date(2026, 9, 21, 9, 12).getTime(), now), 'modified today 09:12');
    assert.equal(A.modifiedText(new Date(2026, 9, 20, 18, 40).getTime(), now), 'modified yesterday 18:40');
    assert.equal(A.modifiedText(new Date(2026, 9, 12, 7, 5).getTime(), now), 'modified 12 Oct 07:05');
    assert.equal(A.modifiedText(new Date(2025, 4, 3, 16, 0).getTime(), now), 'modified 3 May 2025 16:00');
    assert.equal(A.modifiedText(NaN, now), '');
  });

  test("N2: the .ppl files offered: FinishLynx's folder and the one above it, newest first, never loaded by themselves", () => {
    const withDir = (d) => { const st = meet(); st.config.lif = { enabled: true, inputDir: d, outputDir: 'D:\\Merged' }; return st; };
    assert.deepEqual(A.pplFolders(withDir('C:\\Lynx\\Results\\')), ['C:\\Lynx\\Results', 'C:\\Lynx']);
    assert.deepEqual(A.pplFolders(withDir('C:\\Lynx')), ['C:\\Lynx', 'C:\\']);
    assert.deepEqual(A.pplFolders(withDir('C:\\')), ['C:\\']);
    assert.deepEqual(A.pplFolders(withDir('\\\\lynx-pc\\Lynx\\Meet')), ['\\\\lynx-pc\\Lynx\\Meet', '\\\\lynx-pc\\Lynx']);
    assert.deepEqual(A.pplFolders(withDir('')), []);
    const t = (h, m) => new Date(2026, 9, 21, h, m).getTime();
    const listings = [
      { dir: 'C:\\Lynx\\Results', entries: [{ name: 'Meet', path: 'C:\\Lynx\\Results\\Meet', type: 'dir' }, { name: 'old.PPL', path: 'C:\\Lynx\\Results\\old.PPL', type: 'file', mtimeMs: t(7, 0) }] },
      { dir: 'C:\\Lynx', entries: [
        { name: 'Lynx.ppl', path: 'C:\\Lynx\\Lynx.ppl', type: 'file', mtimeMs: t(9, 12) },
        { name: 'notes.txt', path: 'C:\\Lynx\\notes.txt', type: 'file', mtimeMs: t(9, 30) },
        { name: 'nodate.ppl', path: 'C:\\Lynx\\nodate.ppl', type: 'file' },
      ] },
      { dir: 'C:\\Lynx', entries: [{ name: 'Lynx.ppl', path: 'c:\\lynx\\LYNX.PPL', type: 'file', mtimeMs: t(9, 12) }] },
    ];
    const list = A.pplSuggestions(listings, 'C:\\Lynx\\Results\\old.ppl');
    assert.deepEqual(list.map((x) => [x.path, x.current]), [['C:\\Lynx\\Lynx.ppl', false], ['C:\\Lynx\\Results\\old.PPL', true], ['C:\\Lynx\\nodate.ppl', false]]);
    assert.equal(A.pplUseLabel(list[0], t(10, 0)), 'Use C:\\Lynx\\Lynx.ppl (modified today 09:12)');
    assert.equal(A.pplUseLabel(list[2], t(10, 0)), 'Use C:\\Lynx\\nodate.ppl');
    const many = [{ entries: Array.from({ length: 7 }, (_, i) => ({ name: `m${i}.ppl`, path: `C:\\L\\m${i}.ppl`, type: 'file', mtimeMs: i })) }];
    assert.deepEqual(A.pplSuggestions(many).map((x) => x.name), ['m6.ppl', 'm5.ppl', 'm4.ppl', 'm3.ppl'], 'the newest four');
  });

  test('N3: the names "come in" when a file is chosen, changed, or first read; not when FinishLynx saves it again', () => {
    const P = 'C:\\Lynx\\Lynx.ppl';
    const loaded = (path, extra = {}) => ({ path, loaded: true, count: 412, error: null, loadedAt: NOW, ...extra });
    assert.equal(A.namesArrived({ path: '', loaded: false }, loaded(P)), true, 'chosen');
    assert.equal(A.namesArrived({ path: 'C:\\Lynx\\Yesterday.ppl', loaded: true }, loaded(P)), true, 'another file');
    assert.equal(A.namesArrived({ path: P, loaded: false }, loaded(P)), true, 'could not be read before');
    assert.equal(A.namesArrived({ path: P, loaded: true }, loaded(P, { loadedAt: NOW + 60000 })), false, 'a re-read of the same file');
    assert.equal(A.namesArrived({ path: 'c:\\lynx\\LYNX.PPL', loaded: true }, loaded(P)), false, 'the same file, written differently');
    assert.equal(A.namesArrived(null, loaded(P)), false, 'the first State this page sees says nothing about when');
    assert.equal(A.namesArrived({ path: '', loaded: false }, loaded(P, { count: 0 })), false, 'an empty file brings no names');
    assert.equal(A.namesArrived({ path: '', loaded: false }, { path: P, loaded: false, count: 0, error: 'not found' }), false);
  });

  test('N3: "Send names now" per race that went out without names, once per file, gone once sent or "Not now"', () => {
    const P = 'C:\\Lynx\\Lynx.ppl';
    const names = { path: P, loaded: true, count: 412, error: null, loadedAt: 1761037920000 };
    const st = meet({ girls: sent, ppl: P, names });
    const offer = A.namesOfferFor(st);
    assert.deepEqual(offer, { key: 'c:\\lynx\\lynx.ppl|1761037920000', path: P, count: 412, races: { g: 'open' } });
    assert.equal(A.namesOfferFor(meet({ ppl: P, names })), null, 'nothing went out yet: nothing to fill in');
    // one names file after another: the splits went out with the earlier file's names, not without names
    const switched = A.namesOfferFor(st, { switched: true });
    assert.equal(switched.switched, true);
    const sw = A.namesOfferItems(st, switched)[0];
    assert.equal(sw.title, 'Update the names on TrackScore and Karmarush');
    assert.match(sw.text, /^Girls 5K's splits went out with the names from the earlier names file. “Send names now” sends the race's splits again with the names from Lynx.ppl;/);
    assert.doesNotMatch(sw.text, /without names|before the names/);
    const items = A.namesOfferItems(st, offer);
    assert.equal(items.length, 1);
    const w = items[0];
    assert.equal(w.tone, 'warn');
    assert.equal(w.title, 'Fill in the names on TrackScore and Karmarush');
    assert.deepEqual(w.action, { label: 'Send names now', cmd: 'send-names', raceId: 'g' });
    assert.deepEqual(w.more, [{ label: 'Not now', cmd: 'names-not-now', raceId: 'g', ghost: true }]);
    assert.match(w.text, /^Girls 5K's splits went out before the names file was in, so TrackScore and Karmarush show those runners without names\. “Send names now” sends the race's splits again, now with names; runners who have finished are left out \(FinishLynx sent their names\)\.$/);
    // in Needs attention, as Girls 5K's line
    const att = A.attentionItems(st, NOW, [], { namesOffer: offer }).find((x) => x.id === 'names-send:g');
    assert.equal(att.raceId, 'g');
    assert.equal(att.raceName, 'Girls 5K');
    assert.equal(A.attentionItems(st, NOW, []).some((x) => x.id === 'names-send:g'), false, 'no offer kept: no line');
    // answered: gone
    assert.deepEqual(A.namesOfferItems(st, { ...offer, races: { g: 'sent' } }), []);
    assert.deepEqual(A.namesOfferItems(st, { ...offer, races: { g: 'dismissed' } }), []);
    // the offer is for that file: another file, or none loaded, ends it
    assert.deepEqual(A.namesOfferItems(meet({ girls: sent, ppl: 'C:\\Lynx\\Other.ppl', names: { ...names, path: 'C:\\Lynx\\Other.ppl' } }), offer), []);
    assert.deepEqual(A.namesOfferItems(meet({ girls: sent, ppl: P, names: { ...names, loaded: false } }), offer), []);
    // a race no longer Active, or no output that takes it: nothing to send
    const off = meet({ girls: sent, ppl: P, names });
    off.config.races[0].active = false;
    assert.deepEqual(A.namesOfferItems(off, offer), []);
    assert.deepEqual(A.namesOfferItems(meet({ girls: sent, ppl: P, names, outputs: [{ ...TRACKSCORE, enabled: false }] }), offer), []);
    assert.deepEqual(A.namesOfferItems(st, null), []);
  });

  test('N3: "Send names now" asks first only when a TrackScore that takes another running race could switch to this one', () => {
    const P = 'C:\\Lynx\\Lynx.ppl';
    const names = { path: P, loaded: true, count: 412, error: null, loadedAt: NOW };
    // TrackScore takes every race, and Boys 5K (Active too) has sent splits: it may be showing Boys 5K
    const both = meet({ girls: sent, boys: sent, ppl: P, names });
    both.config.races[1].active = true;
    assert.deepEqual(A.namesSendRisk(both, 'g'), [{ output: 'TrackScore', others: ['Boys 5K'] }], 'Karmarush (MID script) takes every race: no switch');
    // TrackScore given Girls 5K only, or Boys 5K not Active: one click
    const one = meet({ girls: sent, boys: sent, ppl: P, names, outputs: [{ ...TRACKSCORE, races: ['g'] }, { ...LIVE, id: 'o_kr', name: 'Karmarush' }] });
    one.config.races[1].active = true;
    assert.deepEqual(A.namesSendRisk(one, 'g'), []);
    assert.deepEqual(A.namesSendRisk(meet({ girls: sent, boys: sent, ppl: P, names }), 'g'), []);
  });

  test('N4: the first-run checklist step names the .ppl', () => {
    const steps = A.setupSteps(meet());
    assert.equal(steps.find((x) => x.key === 'names').title, "Choose the meet's names file (.ppl)");
    assert.equal(steps.find((x) => x.key === 'names').done, false);
    const P = 'C:\\Lynx\\Lynx.ppl';
    assert.equal(A.setupSteps(meet({ ppl: P, names: { path: P, loaded: true, count: 3, error: null, loadedAt: NOW } })).find((x) => x.key === 'names').done, true);
  });
});

describe('fix a runner (DESIGN 9.23)', () => {
  const R3 = () => race('g', { inputPort: 5565, gun: '10:00:00.000',
    splits: [{ id: 's1', name: '1K', sources: [], earliest: '' }, { id: 's2', name: '2K', sources: [], earliest: '' }, { id: 's3', name: '3K', sources: [], earliest: '' }] });
  const T9 = 10000;
  const m = (mm, ss = 0, ms = 0) => (mm * 60 + ss) * T9 + ms * 10;

  test('the panel\'s words are the server\'s: how a pass was placed, Not a split, a marked finish, the 3 h cap', () => {
    for (const how of ['counted', 'earliest', 'moved', 'kept', 'hold', 'replaces', 'extra', 'too-early', 'after-finish', 'out-of-order', 'ignored', 'finish']) {
      assert.equal(A.howText(how, '3K'), serverHowText(how, '3K'), how);
    }
    assert.equal(A.IGNORED_TEXT, SERVER_IGNORED_TEXT);
    assert.equal(A.MARKED_FINISH_TEXT, SERVER_MARKED_FINISH_TEXT);
    assert.equal(A.MAX_RACE_TICKS_TYPED, SERVER_MAX_RACE_TICKS_TYPED);
    // "Not a split" is a status word with a glossary line, after "Extra pass"
    const info = A.statusInfo('ignored');
    assert.deepEqual([info.label, info.tone, A.shortStatus('ignored')], ['Not a split', 'muted', 'Not a split']);
    assert.match(info.meaning, /Let Split Relay count it/);
    assert.equal(A.STATUS_ORDER.indexOf('ignored'), A.STATUS_ORDER.indexOf('extra') + 1);
    // the keys
    assert.deepEqual(A.SHORTCUTS[0], ['B', 'Find a runner: bib or name']);
    assert.ok(A.SHORTCUTS.some(([k, w]) => k === '/' && w === 'Find: the feed search on the Dashboard, the runner box elsewhere'));
    assert.ok(A.SHORTCUTS.some(([k]) => k === 'Ctrl+Z'));
  });

  test('a time typed in a cell: a time of day or a race time, said which; a bare number refused', () => {
    const gun = tod(16, 28, 0, 455);
    let e = A.parseTimeEntry('8:12.3', gun);
    assert.deepEqual([e.kind, e.ticks, e.label, e.problem], ['race', m(8, 12, 300), 'Race time 8:12.3', '']);
    e = A.parseTimeEntry('16:36:43.6', gun);
    assert.deepEqual([e.kind, e.ticks, e.label, e.problem], ['tod', tod(16, 36, 43, 600) - gun, 'Time of day 16:36:43.6 = race time 8:43.2', '']);
    assert.deepEqual(A.typedBody('586', 's3', e), { bib: '586', splitId: 's3', ifEmpty: true, tod: '16:36:43.6' });
    assert.deepEqual(A.typedBody('586', 's3', A.parseTimeEntry('8:12.3', gun)), { bib: '586', splitId: 's3', ifEmpty: true, time: '8:12.3' });
    // an hour below 3 is a race time
    assert.deepEqual([A.parseTimeEntry('2:05:01', gun).kind, A.parseTimeEntry('2:05:01', gun).ticks], ['race', (2 * 3600 + 5 * 60 + 1) * T9]);
    assert.equal(A.parseTimeEntry('16:20:00.0', gun).problem, '16:20:00.0 is before the gun (16:28:00.455).');
    assert.match(A.parseTimeEntry('1636', gun).problem, /^"1636" could be seconds or minutes/);
    assert.match(A.parseTimeEntry('', gun).problem, /^Type a time/);
    assert.match(A.parseTimeEntry('16:36:43.6', null).problem, /no gun time yet/);
  });

  test('a cell says what it is in words, for the editor and the grid alike', () => {
    const runner = { bib: '586', finished: false, finishPlace: null };
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true, paused: [], inactive: '' };
    const col = (x) => ({ splitId: 's3', splitName: '3100m', raceTicks: m(16, 10, 800), place: 135, kind: 'read', how: 'counted', ...x });
    let c = A.cellModel(col({}), runner, dest);
    assert.deepEqual([c.main, c.sub, c.chip, c.tone], ['16:10.8', '135th', null, '']);
    assert.equal(c.aria, '3100m: 16:10.8, 135th, counted from the passes');
    const chip = (x) => A.cellModel(col(x), runner).chip?.text;
    assert.deepEqual([chip({ kind: 'moved' }), chip({ kind: 'hold' }), chip({ kind: 'keep' }), chip({ kind: 'replaces' }), chip({ kind: 'made-up' }), chip({ kind: 'typed' })],
      ['Moved', 'Kept', 'Kept', 'Read', 'Made-up', 'Typed']);
    c = A.cellModel(col({ status: 'check-column', check: { to: 's4', toName: '4200m', reason: 'Looks like 4200m, not 3100m (missed 3100m?)' } }), runner);
    assert.deepEqual([c.chip.text, c.tone], ['Held', 'held']);
    assert.match(c.info, /^3100m: Looks like 4200m, not 3100m \(missed 3100m\?\)\. Held \(not sent, not in the merged \.lif file\) until you choose/);
    assert.equal(A.cellModel(col({ status: 'split-paused' }), runner).chip.text, 'Paused');
    assert.equal(A.cellModel(col({ finishedNotSent: true }), runner).chip.text, 'Not sent live');
    c = A.cellModel(col({ flag: { kind: 'long', text: '16:10.8 looks like 4200m.', silenced: false } }), runner);
    assert.deepEqual([c.flag, c.tone, /looks wrong$/.test(c.aria)], ['flag', 'flag', true]);
    assert.equal(A.cellModel(col({ flag: { kind: 'long', text: '', silenced: true } }), runner).flag, 'silenced');
    assert.equal(A.cellModel(col({ stale: 'TrackScore: 16:10.8' }), runner).warn, 'TrackScore: 16:10.8');
    c = A.cellModel({ splitId: 's3', splitName: '3100m', raceTicks: null, kind: 'missing', estimate: m(11, 53, 557),
      basis: 'From 2400m 9:25.4 and 4200m 16:10.8, placed like the 30 runners nearest in pace (3100m at 36.6% of that stretch).', leftover: { timeText: '16:10.8', outputs: ['TrackScore'] } }, runner, dest);
    assert.deepEqual([c.main, c.sub, c.tone, c.aria, c.warn], ['11:53.6', 'Suggested', 'missing', '3100m: missing, suggested 11:53.6', 'TrackScore: 16:10.8']);
    assert.equal(c.info, '3100m is missing. Suggested 11:53.6 (from 2400m 9:25.4 and 4200m 16:10.8, placed like the 30 runners nearest in pace (3100m at 36.6% of that stretch)). Enter sends it to TrackScore and Karmarush, and into the merged .lif file. Or type another time. TrackScore still shows 16:10.8 there: a time for 3100m replaces it.');
    const blocked = (why) => A.cellModel({ splitName: '5300m', raceTicks: null, kind: 'blocked', why }, runner).sub;
    assert.deepEqual([blocked("Check bib 586's columns first (Review: Move or Keep)."), blocked("Bib 403 has finished, but Split Relay doesn't know the finish place"), blocked('x')],
      ['Check first', 'Place unknown', 'Not possible']);
    c = A.cellModel({ splitName: '3100m', raceTicks: null, kind: 'not-yet' }, { bib: '452' });
    assert.deepEqual([c.main, c.sub], ['—', 'Not yet']);
    assert.equal(c.info, "3100m: no time yet. Bib 452 has no later split or finish: not there yet, or dropped out. Split Relay won't make one up; type a time only if you know it.");
    assert.deepEqual(A.finishModel({ finished: true, finishTicks: m(26, 22, 100), finishPlace: 164, finishBy: 'lynx' }), { main: '26:22.1', sub: '164th · FinishLynx', by: 'FinishLynx', aria: 'Finish: 26:22.1, 164th, FinishLynx' });
    assert.equal(A.finishModel({ finished: true, finishTicks: m(24, 17, 300), finishBy: 'marked' }).sub, 'marked');
    // (9.23 F13: with merged .lif files off Split Relay may not know a finish)
    assert.equal(A.finishModel({ finished: false }).sub, 'Not known');
  });

  /** A runner editor's pass as the server gives it (RunnerView passes, 9.23 F7), normalized. */
  function pass586() {
    const t = (id, name, ok, why, effect = '', best = false) => ({ splitId: id, splitName: name, ok, why, effect, fit: null, best });
    return A.normRunner({
      bib: '586', found: true,
      columns: [{ splitId: 's3', splitName: '3100m', time: m(16, 10, 800), kind: 'read', how: 'counted', passTod: 99,
        flag: { kind: 'long', text: '16:10.8 looks like 4200m, not 3100m (missed 3100m?).', suggest: { to: 's4', toName: '4200m', missed: ['3100m'] }, silenced: false } }],
      passes: [{ tod: 99, raceTicks: m(16, 10, 800), timeText: '16:10.8', how: 'counted', splitId: 's3', where: 's3', inColumn: true, pinned: null,
        targets: [t('s1', '800m', false, "The pass at 16:10.8 can't be 800m: 3 earlier passes need the splits before it."), t('s3', '3100m', false, '16:10.8 is 3100m already.'),
          t('s4', '4200m', true, null, '22:28.8 → 4400m', true), t('s5', '4400m', true, null, '22:28.8 → 5300m')],
        only: [t('s4', '4200m', false, 'Only this time can\'t go to 4200m: 22:28.8 is there.'), t('s6', '5300m', true, null)],
        finishOk: { ok: false, why: 'FinishLynx has bib 586\'s finish at 26:22.1, so 16:10.8 can\'t be the finish. Choose Not a split instead.', effect: '' } }],
      changes: [{ fix: 4, at: 1, atText: '12:03:14', kind: 'fill', text: '3100m 11:53.6 made up', undone: false, undoable: true }],
    }, null);
  }

  test('the choices for a time: the suggestion first with what it does, every split (why not, "fits the pace"), only this time, the finish, Not a split, It\'s right', () => {
    const r = pass586();
    const menu = A.menuFor(r, { col: r.columns[0] });
    assert.equal(menu.title, '16:10.8 · 3100m');
    assert.deepEqual(menu.items.map((x) => [x.key, x.label, x.sub, x.disabled, x.primary]), [
      ['sug', 'Move to 4200m', '22:28.8 → 4400m', false, true],
      // the splits it can go to first, the ones it can't after them (with why)
      ['to-s5', 'Move to 4400m', '22:28.8 → 5300m', false, false],
      ['to-s1', 'Move to 800m', "The pass at 16:10.8 can't be 800m: 3 earlier passes need the splits before it.", true, false],
      ['only-s6', 'Only this time to 5300m', 'the other times stay where they are', false, false],
      ['finish', 'This is the finish', "FinishLynx has bib 586's finish at 26:22.1, so 16:10.8 can't be the finish. Choose Not a split instead.", true, false],
      ['none', 'Not a split', 'a cool-down or stray pass: it takes no column', false, false],
      ['keep', "It's right: keep it in 3100m", '', false, false]]);
    assert.deepEqual(menu.items[0].act, { kind: 'move', to: 's4' });
    assert.deepEqual(menu.items[3].act, { kind: 'move', to: 's6', only: true });
    // with no suggestion, the best fit says so
    const plain = A.menuFor({ ...r, columns: [{ ...r.columns[0], flag: null }] }, { col: { ...r.columns[0], flag: null } });
    assert.equal(plain.items.find((x) => x.key === 'to-s4').sub, 'fits the pace · 22:28.8 → 4400m');
    assert.deepEqual(plain.items.filter((x) => x.group === 'Move to').map((x) => x.key), ['to-s4', 'to-s5', 'to-s1'], 'the one that fits the pace first');
    assert.ok(!plain.items.some((x) => x.key === 'keep'), "It's right only for a held or flagged time");
    // a pinned pass can be counted again
    r.passes[0].pinned = 'move';
    assert.ok(A.menuFor(r, { col: r.columns[0] }).items.some((x) => x.key === 'count'));
    // a made-up time: change, remove, undo when it is the latest change
    const made = { splitId: 's3', splitName: '3100m', raceTicks: m(11, 53, 600), kind: 'made-up', passTod: null };
    assert.deepEqual(A.menuFor({ ...r, changes: r.changes }, { col: made }).items.map((x) => x.label), ['Change time…', 'Remove…', 'Undo']);
  });

  test('9.23 F13 "Missed <split>: add it": first in the menu where a mat missed the runner ("Missed here?"), in every pass cell\'s menu, the toasts and the words', () => {
    const r = pass586();
    const miss = (over = {}) => ({ count: 1, names: ['3100m'], here: true, by: 'flag', reason: '', ok: true, why: '', typed: true,
      splits: [{ splitId: 's3', splitName: '3100m', estimate: m(11, 53, 557), basis: 'From 2400m 9:25.4 and 4200m 16:10.8, placed like the 30 runners nearest in pace (3100m at 36.6% of that stretch).' }],
      effect: '16:10.8 → 4200m, 22:28.8 → 4400m', passTod: 99, ...over });
    const raw = { ...r, columns: [{ ...r.columns[0], missed: miss() }] };
    // the server's words, through normRunner
    const n = A.normRunner({ bib: '586', columns: [{ splitId: 's3', splitName: '3100m', time: m(16, 10, 800), kind: 'read', missed: miss() }], missedHint: { splitId: 's3', splitName: '3100m', count: 1, names: ['3100m'] } }, null);
    assert.deepEqual([n.columns[0].missed.here, n.columns[0].missed.names, n.missedHint.names], [true, ['3100m'], ['3100m']]);
    // where the check or a flag points: first, the primary, with the suggested time and what it does to the later times;
    // then "type its time…"; the flag's own Move after them
    let menu = A.menuFor(raw, { col: raw.columns[0] });
    assert.deepEqual(menu.items.slice(0, 3).map((x) => [x.key, x.label, x.sub, x.primary]), [
      ['missed', 'Missed 3100m: add it', '11:53.6 suggested · 16:10.8 → 4200m, 22:28.8 → 4400m', true],
      ['missed-time', 'Missed 3100m: type its time…', 'the later times move on, as above', false],
      ['sug', 'Move to 4200m', '22:28.8 → 4400m', false]]);
    assert.deepEqual(menu.items[0].act, { kind: 'missed', count: 1, key: 's3:1' });
    // anywhere else: after the Moves, under "A mat missed it"
    menu = A.menuFor({ ...raw, columns: [{ ...raw.columns[0], flag: null, missed: miss({ here: false }) }] }, { col: { ...raw.columns[0], flag: null, missed: miss({ here: false }) } });
    assert.deepEqual(menu.items.filter((x) => x.group === 'A mat missed it').map((x) => x.key), ['missed', 'missed-time']);
    assert.ok(menu.items.findIndex((x) => x.key === 'missed') > menu.items.findIndex((x) => x.key === 'to-s5'));
    // a run of missed splits: one choice, no typed time; one that can't be done says why
    menu = A.menuFor(raw, { col: { ...raw.columns[0], missed: miss({ count: 3, names: ['3100m', '4200m', '4400m'], typed: false }) } });
    assert.deepEqual([menu.items[0].label, menu.items.some((x) => x.key === 'missed-time')], ['Missed 3100m, 4200m and 4400m: add them', false]);
    menu = A.menuFor(raw, { col: { ...raw.columns[0], missed: miss({ ok: false, why: 'Bib 586 has finished, but Split Relay doesn\'t know the finish place.' }) } });
    assert.deepEqual([menu.items[0].disabled, menu.items[0].sub], [true, 'Bib 586 has finished, but Split Relay doesn\'t know the finish place.']);
    // an empty last split after a marked finish (no pass in it): its menu is the fix itself
    menu = A.menuFor(raw, { col: { splitId: 's7', splitName: '5300m', raceTicks: null, kind: 'blocked', passTod: null, missed: miss({ names: ['5300m'], effect: '22:19.4 → extra pass' }) } });
    assert.deepEqual(menu.items.map((x) => x.key), ['missed', 'missed-time']);
    // the cell says it: "Missed here?", and the editor's info line what the fix does
    const c = A.cellModel(raw.columns[0], { bib: '586' }, null, { editor: true });
    assert.deepEqual(c.chip, { text: 'Missed here?', tone: 'warn' });
    assert.match(c.aria, /, missed here\?$/);
    assert.equal(c.info, '3100m 16:10.8 is probably a later split\'s: the mat may have missed bib 586 at 3100m (below). Missed 3100m: add it moves it and the later times on and fills it. Enter opens the choices.');
    // a blocked cell waiting for a finish place has no time box (nothing typed there could go live)
    assert.equal(A.noPlaceBlock({ raceTicks: null, kind: 'blocked', why: "Bib 463 has finished, but Split Relay doesn't know the finish place (it comes from FinishLynx's .lif file)." }), true);
    assert.equal(A.noPlaceBlock({ raceTicks: null, kind: 'blocked', why: "Check bib 521's 3100m first: 19:39.5 looks like 5300m." }), false);
    // the find list says where a mat missed the runner, not just "7 of 7 splits"
    assert.equal(A.findRowText({ bib: '586', name: "Runner O'Example", team: 'State', raceName: 'Womens Race', filled: 7, splits: 7, problems: 1, missed: ['3100m'] }),
      "586 · Runner O'Example · State · Womens Race · 7 of 7 splits · missed 3100m?");
    // a finisher: asked first, with the finish place
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: false, inactive: '' };
    const q = A.finishedMissedText({ bib: '428', finished: true, finishPlace: 35 }, { names: ['4200m'] }, dest);
    assert.equal(q.title, 'Bib 428 has finished: send with the finish place?');
    assert.match(q.body[0], /^Missed 4200m: add it: it goes to TrackScore and Karmarush \(merged \.lif files are off\), and the later times move on, all with place 35, the finish place/);
    // its toast says what it did, where it went, and the other places now out of date (a fill: Resend)
    const change = { kind: 'missed', bibs: ['586'], text: 'Missed 3100m added (11:53.6, made up); 16:10.8 → 4200m', sentTo: ['TrackScore', 'Karmarush'], cells: [{ after: '11:53.6' }], leftover: [], notLive: [], staleOthers: 12 };
    assert.equal(A.fixToast(change, dest), 'Bib 586: Missed 3100m added (11:53.6, made up); 16:10.8 → 4200m. Sent to TrackScore and Karmarush. 12 other places on TrackScore are now out of date: Resend from the race tile.');
    assert.equal(A.otherPlacesText({ staleOthers: 1 }), '1 other place on TrackScore is now out of date: Resend from the race tile.');
    assert.equal(A.otherPlacesText({ staleOthers: 0 }), '');
    // after "This is the finish" with no finish place known, the toast points at the way out
    const fin = { kind: 'finish', bibs: ['463'], text: '23:18.0 is the finish now', sentTo: [], cells: [{ before: '23:18.0', after: '' }], leftover: [], notLive: [], staleOthers: 0 };
    assert.match(A.fixToast(fin, dest, { runner: { columns: [{ splitName: '5300m', raceTicks: null, kind: 'blocked', missed: { ok: true, names: ['5300m'] } }] } }),
      / 5300m is missing, but it can't be sent until Split Relay knows the finish place \(FinishLynx's \.lif file: Settings, Merged \.lif files\)\. Missed 5300m: add it \(in its cell\) sends it with its own place instead\.$/);
    // This is the finish with no finish place known: the boards keep the time in its split when it went out, and the
    // split stays empty there when it was held (463's 23:18.0 in 5300m)
    const fin463 = (delivered) => {
      const x = A.normRunner({ bib: '463', found: true, finishPlace: null,
        columns: [{ splitId: 's7', splitName: '5300m', time: m(23, 18, 0), kind: 'read', how: 'counted', passTod: 7, delivered, held: delivered ? null : 'check' }],
        passes: [{ tod: 7, raceTicks: m(23, 18, 0), timeText: '23:18.0', how: 'counted', splitId: 's7', where: 's7', inColumn: true, pinned: null, targets: [], only: [],
          finishOk: { ok: true, best: true, why: null, effect: '' } }] }, null);
      return A.menuFor(x, { col: x.columns[0] }).items.find((i) => i.key === 'finish').sub;
    };
    assert.equal(fin463(true), 'fits the pace · no finish place known: the boards keep 23:18.0 in 5300m');
    assert.equal(fin463(false), 'fits the pace · no finish place known: 5300m stays empty on the boards');
    // the words for passes in no column and the runner's finish
    assert.equal(A.finishModel({ finished: false }).aria, 'Finish: not known to Split Relay');
    // the Undo of the fix of a held runner: its passes go back to Passes to check, held, and the boards keep what the
    // change sent until the operator chooses: the dialog says that, not "takes them out of the merged .lif file"
    const held = ['1500m', '2400m', '3100m'].map((x, i) => ({ bib: '451', splitName: x, text: ['5:54.4', '10:58.9', '15:28.7'][i], held: true }));
    let dlg = A.undoLeavesDialog(held, ['TrackScore', 'Karmarush'], { bib: '451', finished: false });
    assert.deepEqual(dlg, { title: 'Undo this change?', body: ["Bib 451's passes go back to Passes to check, held: nothing is sent for them until you choose. Until then TrackScore and Karmarush keep the 3 times this change sent."] });
    // a cell the undo empties, as before (9.23 F3; 9.23 F17: by its split's name)
    dlg = A.undoLeavesDialog([{ bib: '451', splitName: '2400m', text: '8:25.8' }], ['TrackScore'], { bib: '451', finished: false });
    assert.deepEqual(dlg, { title: 'Undo this change?', body: ['Split Relay forgets it and takes it out of the merged .lif file; 2400m is empty again in Review. TrackScore keeps 8:25.8 at 2400m: a split packet can fill a cell but never empty one.'] });
  });

  test('9.23 F14 how many in a row: the one click only when Split Relay is sure, else each count a choice with what it does; a made-up time that does not fit; the counts and words of what is out of date; the place a made-up time went out with', () => {
    const r = pass586();
    const choice = (count, names, effect) => ({ count, names, ok: true, why: '', typed: count === 1, effect,
      splits: names.map((x, i) => ({ splitId: `s${3 + i}`, splitName: x, estimate: m(8 + 2 * i, 30, 0), basis: 'From 1500m 4:57.2 and 15:18.4.' })) });
    // two counts that fit about as well (459 on the course, after its 4200m pass alone): both offered, neither primary
    const unsure = { ...choice(2, ['2400m', '3100m'], '15:18.4 → 4200m'), here: true, by: 'check', passTod: 99, sure: false,
      reason: "15:18.4 looks like 4200m or 4400m, not 2400m: Split Relay can't tell which (missed 2400m and 3100m, or 2400m, 3100m and 4200m?).",
      alt: choice(3, ['2400m', '3100m', '4200m'], '15:18.4 → 4400m') };
    const n = A.normRunner({ bib: '459', columns: [{ splitId: 's3', splitName: '2400m', time: m(15, 18, 377), kind: 'read', missed: unsure }] }, null);
    const ms = n.columns[0].missed;
    assert.deepEqual([ms.sure, ms.count, ms.alt.count, ms.alt.names, ms.alt.effect], [false, 2, 3, ['2400m', '3100m', '4200m'], '15:18.4 → 4400m']);
    assert.deepEqual(A.missedChoices(ms).map((x) => A.missedLabel(x)), ['Missed 2400m and 3100m: add them', 'Missed 2400m, 3100m and 4200m: add them']);
    assert.equal(A.missedUnsureText(ms), "Split Relay can't tell which: Missed 2400m and 3100m: add them (15:18.4 → 4200m) or Missed 2400m, 3100m and 4200m: add them (15:18.4 → 4400m).");
    const raw = { ...r, columns: [{ ...r.columns[0], missed: unsure, flag: null }] };
    let menu = A.menuFor(raw, { col: raw.columns[0] });
    assert.deepEqual(menu.items.slice(0, 2).map((x) => [x.label, x.primary, x.group, x.act]), [
      ['Missed 2400m and 3100m: add them', false, "Split Relay can't tell which", { kind: 'missed', count: 2, key: 's3:2' }],
      ['Missed 2400m, 3100m and 4200m: add them', false, "Split Relay can't tell which", { kind: 'missed', count: 3, key: 's3:3' }]]);
    assert.ok(menu.items.every((x) => !x.primary), 'no one click while Split Relay cannot tell');
    // sure: the one click, as before
    assert.deepEqual(A.menuFor({ ...raw, columns: [{ ...raw.columns[0], missed: { ...unsure, sure: true, alt: null } }] }, { col: { ...raw.columns[0], missed: { ...unsure, sure: true, alt: null } } }).items[0].primary, true);
    // can't tell yet (a count that can't be measured yet): one choice, not the one click, and the words say so
    const open = { ...unsure, alt: null };
    assert.equal(A.missedUnsureText(A.normRunner({ bib: '459', columns: [{ splitId: 's3', splitName: '2400m', time: 1, kind: 'read', missed: open }] }, null).columns[0].missed),
      "Split Relay can't tell yet how many splits the mat missed: wait for the runner's next pass, or choose Missed 2400m and 3100m: add them (15:18.4 → 4200m).");
    // the cell's info line says Split Relay can't tell
    assert.match(A.cellModel(n.columns[0], { bib: '459' }, null, { editor: true }).info, /^2400m 15:18\.4 is probably a later split's, but Split Relay can't tell how many splits in a row the mat missed bib 459 \(below\)\. Enter opens the choices\.$/);
    // a made-up time its later passes do not fit: its cell's menu has the fix first, then Change time and Remove
    const made = { splitId: 's3', splitName: '2400m', raceTicks: m(11, 0, 0), kind: 'made-up', passTod: null,
      missed: { ...choice(2, ['2400m', '3100m'], '15:18.4 → 4200m, 16:12.8 → 4400m'), here: true, by: 'madeUp', passTod: 98, sure: true, alt: null,
        reason: "2400m's made-up 11:00.0 doesn't fit: 15:18.4 looks like 4200m, not 3100m (missed 2400m and 3100m?)." } };
    menu = A.menuFor({ ...r, changes: [] }, { col: made });
    assert.deepEqual(menu.items.map((x) => [x.label, x.primary]), [['Missed 2400m and 3100m: add them', true], ['Change time…', false], ['Remove…', false]]);
    assert.match(A.cellModel(A.normRunner({ bib: '459', columns: [{ splitId: 's3', splitName: '2400m', time: m(11, 0, 0), kind: 'made-up', source: 'made-up', missed: made.missed }] }, null).columns[0], { bib: '459' }, null, { editor: true }).info,
      /^2400m 11:00\.0: this made-up time doesn't fit bib 459's later passes \(below\)\. Missed 2400m and 3100m: add them makes it up again and moves the later times on\./);
    // the Review list's look-wrong row of a made-up time: the pass after it is where It's right would go (none offered)
    const rv = A.normReview({ flags: [{ bib: '459', splitId: 's3', splitName: '2400m', passTod: 98, passSplitId: 's4', raceTicks: m(11, 0, 0), kind: 'made-up', text: made.missed.reason, missed: made.missed }] });
    assert.deepEqual([rv.flags[0].kind, rv.flags[0].passSplitId, rv.flags[0].missed.by], ['made-up', 's4', 'madeUp']);
    // the find list: the other count it can't tell from
    assert.equal(A.findRowText({ bib: '459', name: 'A B', team: 'T', raceName: 'Womens Race', filled: 3, splits: 7, problems: 1, missed: ['2400m', '3100m'], missedOr: ['2400m', '3100m', '4200m'] }),
      '459 · A B · T · Womens Race · 3 of 7 splits · missed 2400m and 3100m (or 2400m, 3100m and 4200m)?');
    // what is out of date: each runner's split once, on the outputs where it is (463's toast said "116 on TrackScore" for
    // 58 out of date on each of two outputs)
    assert.equal(A.otherPlacesText({ staleOthers: 58, staleOutputs: ['TrackScore', 'Karmarush'] }), '58 other places on TrackScore and Karmarush are now out of date: Resend from the race tile.');
    assert.equal(A.staleWhere({ count: 58, byOutput: [{ name: 'TrackScore', count: 58 }, { name: 'Karmarush', count: 58 }] }), ' on TrackScore and Karmarush');
    assert.equal(A.staleWhere({ count: 58, byOutput: [{ name: 'TrackScore', count: 58 }, { name: 'Karmarush', count: 12 }] }), ' (TrackScore: 58, Karmarush: 12)');
    assert.equal(A.resendPromptParts({ server: true, count: 58, byOutput: [{ name: 'TrackScore', count: 58 }, { name: 'Karmarush', count: 58 }] })[0],
      "58 splits already sent are out of date on TrackScore and Karmarush. The gun time, the splits or the places changed after they went out. Resend this race's splits.");
    // the Resend dialog's number is what it sends (its toast's), and how many of them are out of date where
    const cfgRace = { id: 'w', name: 'Womens Race', active: true, splits: [{ id: 's1', name: '800m' }] };
    const view = { id: 'w', name: 'Womens Race', splits: [{ id: 's1', crossings: 1240 }], runners: 179, finished: 0, resendSuggested: true,
      stale: { count: 58, byOutput: [{ outputId: 'o1', name: 'TrackScore', count: 58 }, { outputId: 'o2', name: 'Karmarush', count: 58 }] }, resend: { count: 1223, finished: 0 } };
    const st = state({ races: [cfgRace], views: [view], outputs: [{ ...TRACKSCORE, id: 'o1', name: 'TrackScore' }, { ...TRACKSCORE, id: 'o2', name: 'Karmarush', eventNumber: 'blank' }] });
    const t = A.resendDialogText(st, 'w');
    assert.equal(t.body[0], 'Split Relay sends the 1,223 splits it has for Womens Race again, with the current settings, gun time and places, to TrackScore and Karmarush: 58 of them are out of date on TrackScore and Karmarush now.');
    assert.equal(t.confirm, 'Resend 1,223 splits');
    assert.equal(A.resendToast('Womens Race', { sent: 1223, skippedFinished: 0, outputs: 2 }), 'Re-sent 1,223 splits for Womens Race.');
    // finishers left out unless the box is ticked: the button's number is what goes either way
    const fin = state({ races: [cfgRace], views: [{ ...view, finished: 150, resend: { count: 40, finished: 1183 } }], outputs: [{ ...TRACKSCORE, id: 'o1', name: 'TrackScore' }] });
    assert.deepEqual([A.resendDialogText(fin, 'w').confirm, A.resendDialogText(fin, 'w', { includeFinished: true }).confirm], ['Resend 40 splits (150 finished left out)', 'Resend all 1,223 splits']);
    // the place a made-up time went out with, and the place there now when other runners moved it since (463: "Sent as
    // place 109" for a line that said P 106)
    assert.equal(A.manualStateText({ state: 'active', sent: true, place: 109, sentPlace: 106 }, { outputs: ['TrackScore'], lif: false }), 'Sent as place 106 (109th there now).');
    assert.equal(A.manualStateText({ state: 'active', sent: true, place: 106, sentPlace: 106 }, { outputs: ['TrackScore'], lif: false }), 'Sent as place 106.');
    // a held pass that went out before: the note says what the row's one click does, not "After a Move, send …"
    assert.equal(A.checkSentText({ from: { name: '3100m' }, missed: { names: ['3100m'], sure: true } }),
      'It went out as 3100m before it was held: TrackScore and the live results show it as 3100m. Missed 3100m: add it puts the right time there, in the same change.');
    assert.equal(A.checkSentText({ from: { name: '4200m' }, reason: 'Looks like 4400m, not 4200m (it moves with the pass before it)' }),
      'It went out as 4200m before it was held: TrackScore and the live results show it as 4200m. The fix of the pass before it puts the right time there.');
  });

  test('9.23 F15 where the run starts: a Review row sends the hint\'s own split and pass; "can\'t tell yet where" in the row, the menu and the cell; one thing that looks wrong, whatever the held passes its one click settles; the editor starts on the cell that says Missed here?, and a pass held after it offers that cell\'s one click first', () => {
    // 561 (4200m and 4400m missed, a cool-down pass): its first held row (22:29.3 in 4400m) carries the run that starts at
    // 19:41.6 in 4200m, which went out as counted; the one click sends 4200m and that pass, not the row's
    const choice = { count: 2, names: ['4200m', '4400m'], ok: true, why: '', typed: false, effect: '19:41.6 → 5300m, 22:29.3 → extra pass, 29:13.6 → extra pass',
      splits: [{ splitId: 's5', splitName: '4200m', estimate: m(15, 29, 141), basis: 'From 3100m 11:13.2 and 5300m 19:41.6.' }] };
    const rv = A.normReview({ checks: [{ bib: '561', passTod: 200, raceTicks: m(22, 29, 300), from: 's6', fromName: '4400m', to: null, toName: 'the finish',
      reason: '19:41.6 looks like 5300m, not 4200m (missed 4200m and 4400m?): 8:28 after 3100m, where runners of the same pace took 8:44; 22:29.3 moves on with it (the finish)',
      missed: { ...choice, splitId: 's5', splitName: '4200m', by: 'check', sure: true, alt: null, passTod: 150 } }] });
    const c = rv.checks[0];
    assert.deepEqual(A.missedRowTarget(c, c.from.id), { splitId: 's5', passTod: 150, count: 2, names: ['4200m', '4400m'], ok: true, why: '' });
    // a row whose hint is its own pass, as before (an older Split Relay sends no passTod with the hint: the row's)
    const old = A.normReview({ checks: [{ bib: '459', passTod: 300, raceTicks: m(15, 18, 377), from: 's3', to: 's5', reason: 'r', missed: { ...choice, splitId: 's3', sure: true } }] }).checks[0];
    assert.deepEqual([A.missedRowTarget(old, old.from.id).splitId, A.missedRowTarget(old, old.from.id).passTod], ['s3', 300]);
    // can't tell yet where (418 on the course, its first three missed, after its 4200m pass): one choice, not the one click
    const where = A.normRunner({ bib: '418', columns: [{ splitId: 's2', splitName: '1500m', time: m(17, 42, 700), kind: 'read', passTod: 7,
      missed: { count: 1, names: ['1500m'], ok: true, effect: '17:42.7 → 2400m, …', here: true, by: 'flag', passTod: 7, sure: false, unsure: 'where', alt: null,
        reason: '17:42.7 looks like 2400m, not 1500m (missed 1500m?): 4:53 after 800m, where runners of the same pace took 5:57.' } }],
    passes: [{ tod: 7, raceTicks: m(17, 42, 700), timeText: '17:42.7', how: 'counted', splitId: 's2', where: 's2', inColumn: true, targets: [] }] }, null);
    const ms = where.columns[0].missed;
    assert.deepEqual([ms.sure, ms.unsure], [false, 'where']);
    assert.equal(A.missedUnsureText(ms), "Split Relay can't tell yet where the mat missed the runner: its next pass may tell, or choose Missed 1500m: add it (17:42.7 → 2400m, …) if its times say so.");
    const menu = A.menuFor(where, { col: where.columns[0] });
    assert.deepEqual([menu.items[0].label, menu.items[0].primary, menu.items[0].group], ['Missed 1500m: add it', false, "Split Relay can't tell yet where"]);
    assert.match(A.cellModel(where.columns[0], { bib: '418' }, null, { editor: true }).info, /^1500m 17:42\.7 may be a later split's, but Split Relay can't tell yet where the mat missed bib 418 \(below\)\. Enter opens the choices\.$/);
    // the editor's line under the name: the run is one thing that looks wrong, not one per held pass after it (554: "4
    // look wrong" for one click)
    const cols = [{ missed: null }, { missed: { here: true } }, { missed: null }, { missed: null }];
    assert.equal(A.runnerStatusText({ finished: false, passes: [{ kind: 'counted' }], columns: cols,
      problems: [{ kind: 'check', col: 1 }, { kind: 'check', col: 2 }, { kind: 'check', col: 3 }] }), 'Finish not known · 1 pass · 1 looks wrong');
    assert.equal(A.runnerStatusText({ finished: false, passes: [{ kind: 'counted' }], columns: [{ missed: null }, { missed: null }, { missed: { here: true } }],
      problems: [{ kind: 'missed', col: 2 }, { kind: 'check', col: 3 }, { kind: 'flag', col: 0 }] }), 'Finish not known · 1 pass · 2 look wrong');
    // the find row: one thing to look at for the run (the server counts the held passes it settles as one)
    assert.equal(A.findRowText({ bib: '554', name: 'A B', team: 'T', raceName: 'Womens Race', filled: 6, splits: 7, problems: 1, missed: ['2400m', '3100m'] }),
      '554 · A B · T · Womens Race · 6 of 7 splits · missed 2400m and 3100m?');
    // 561 in the editor: it starts on 4200m (Missed here?), not on the held 4400m after it; the held pass's own choices
    // start with that cell's one click (its own Move to 5300m would send the finish pass as 5300m), acting on 4200m
    const pass = (tod, t, text, where) => ({ tod, raceTicks: t, timeText: text, how: 'counted', splitId: where, where, inColumn: true,
      targets: ['s5', 's6', 's7'].map((s) => ({ splitId: s, splitName: { s5: '4200m', s6: '4400m', s7: '5300m' }[s], ok: s === 's7', why: s === 's7' ? '' : "can't", effect: s === 's7' ? '29:13.6 → extra pass' : '' })),
      only: [], finishOk: { ok: true, effect: '29:13.6 becomes after the finish' } });
    const raw561 = { bib: '561', missedHint: { splitId: 's5', splitName: '4200m', count: 2, names: ['4200m', '4400m'], sure: true }, columns: [
      { splitId: 's4', splitName: '3100m', time: m(11, 13, 154), kind: 'read', passTod: 100 },
      { splitId: 's5', splitName: '4200m', time: m(19, 41, 554), kind: 'read', passTod: 150, missed: { ...choice, here: true, by: 'check', sure: true, alt: null, passTod: 150,
        reason: '19:41.6 looks like 5300m, not 4200m (missed 4200m and 4400m?): 8:28 after 3100m, where runners of the same pace took 8:44.' } },
      { splitId: 's6', splitName: '4400m', time: m(22, 29, 300), kind: 'read', passTod: 200, status: 'check', check: { to: null, toName: 'the finish', reason: 'Looks like the finish, not 4400m (it moves with the pass before it)' },
        missed: { ...choice, count: 1, names: ['4400m'], here: false, passTod: 200 } },
      { splitId: 's7', splitName: '5300m', time: m(29, 13, 600), kind: 'read', passTod: 250, status: 'check', check: { to: null, toName: 'an extra pass', reason: 'An extra pass, not 5300m (it moves with the pass before it)' } }],
    passes: [pass(150, m(19, 41, 554), '19:41.6', 's5'), pass(200, m(22, 29, 300), '22:29.3', 's6'), pass(250, m(29, 13, 600), '29:13.6', 's7')] };
    const r561 = A.normRunner(raw561, null);
    assert.equal(A.editorFocus(r561), 1);
    const held = A.menuFor(r561, { col: r561.columns[2] });
    assert.deepEqual([held.items[0].label, held.items[0].primary, held.items[0].act], ['Missed 4200m and 4400m: add them', true, { kind: 'missed', count: 2, key: 's5:2', at: 1 }]);
    assert.deepEqual(held.items.filter((x) => x.primary).map((x) => x.key), ['missed-at'], 'one primary: the one click of the cell that says Missed here?');
    assert.ok(held.items.findIndex((x) => x.label === 'Move to 5300m') > 0);
    // (its own cell's menu as before: the one click first; a held cell with no Missed here? before it as before)
    assert.deepEqual(A.menuFor(r561, { col: r561.columns[1] }).items[0].label, 'Missed 4200m and 4400m: add them');
    const alone = A.normRunner({ ...raw561, missedHint: null, columns: raw561.columns.map((c) => ({ ...c, missed: null })) }, null);
    assert.deepEqual([A.editorFocus(alone), A.menuFor(alone, { col: alone.columns[2] }).items.some((x) => x.key === 'missed-at')], [2, false]);
  });

  test('9.23 F16 two mats missed apart: one choice adds both, its words say the splits read between them, the menu acts on it and the request sends the further run; a choice of another split sends its own split and pass; Split Relay can\'t tell which: both, neither primary', () => {
    // 544 (4200m and 5300m missed, 4400m read): its cell's hint, as the server sends it
    const pass = (tod, t, text, where) => ({ tod, raceTicks: t, timeText: text, how: 'counted', splitId: where, where, inColumn: true, targets: [], only: [], finishOk: { ok: true, effect: '' } });
    const both = { count: 1, names: ['4200m', '5300m'], read: ['4400m'], runs: [{ splitId: 's5', splitName: '4200m', count: 1 }, { splitId: 's7', splitName: '5300m', count: 1 }],
      ok: true, why: '', typed: false, effect: '15:08.2 → 4400m, 20:43.5 → extra pass', splitId: 's5', passTod: 150,
      splits: [{ splitId: 's5', splitName: '4200m', estimate: m(14, 18, 104), basis: 'From 3100m 10:24.1 and 4400m 15:08.2.' }, { splitId: 's7', splitName: '5300m', estimate: m(18, 9, 823), basis: 'From 4400m 15:08.2 and the finish 20:43.5.' }] };
    const raw = { bib: '544', missedHint: { ...both, sure: true }, columns: [
      { splitId: 's4', splitName: '3100m', time: m(10, 24, 100), kind: 'read', passTod: 100 },
      { splitId: 's5', splitName: '4200m', time: m(15, 8, 200), kind: 'read', passTod: 150, missed: { ...both, here: true, by: 'check', sure: true, alt: null,
        reason: '15:08.2 looks like 4400m, not 4200m, and 20:43.5 like the finish, not 4400m (missed 4200m and 5300m?): 4:44 after 3100m, where runners of the same pace took 4:58.' } },
      { splitId: 's6', splitName: '4400m', time: m(20, 43, 500), kind: 'read', passTod: 200, status: 'check', check: { to: null, toName: 'the finish', reason: 'Looks like the finish, not 4400m (it moves with the pass before it, and 5300m was missed too)' } }],
    passes: [pass(150, m(15, 8, 200), '15:08.2', 's5'), pass(200, m(20, 43, 500), '20:43.5', 's6')] };
    const r = A.normRunner(raw, null);
    const ms = r.columns[1].missed;
    assert.deepEqual([ms.names, ms.read, ms.runs.map((x) => [x.splitId, x.count]), A.missedKey(ms)], [['4200m', '5300m'], ['4400m'], [['s5', 1], ['s7', 1]], 's5:1,s7:1']);
    assert.equal(A.missedLabel(ms), 'Missed 4200m and 5300m: add them (4400m was read)');
    assert.equal(A.missedLabel({ names: ['2400m', '4400m'], read: ['3100m', '4200m'] }), 'Missed 2400m and 4400m: add them (3100m and 4200m were read)');
    // the menu: the one click first, primary, with what it does; no "type its time…" (two splits)
    const menu = A.menuFor(r, { col: r.columns[1] });
    assert.deepEqual([menu.items[0].label, menu.items[0].sub, menu.items[0].primary, menu.items[0].act], ['Missed 4200m and 5300m: add them (4400m was read)',
      '14:18.2 and 18:09.9 suggested · 15:08.2 → 4400m, 20:43.5 → extra pass', true, { kind: 'missed', count: 1, key: 's5:1,s7:1' }]);
    assert.ok(!menu.items.some((x) => x.key === 'missed-time'));
    // the held 4400m pass offers that cell's one click first, acting there
    const held = A.menuFor(r, { col: r.columns[2] });
    assert.deepEqual([held.items[0].label, held.items[0].primary, held.items[0].act], ['Missed 4200m and 5300m: add them (4400m was read)', true, { kind: 'missed', count: 1, key: 's5:1,s7:1', at: 1 }]);
    // the request: the first run's split and pass, its count, and the further run
    assert.deepEqual(A.missedTarget(r.columns[1]), { splitId: 's5', passTod: 150, count: 1, basis: 'From 3100m 10:24.1 and 4400m 15:08.2.', ok: true, why: '',
      names: ['4200m', '5300m'], also: [{ splitId: 's7', count: 1 }], read: ['4400m'] });
    // the cell's info line and a finisher's question say both, and the split read between them
    assert.equal(A.cellModel(r.columns[1], { bib: '544' }, null, { editor: true }).info,
      '4200m 15:08.2 is probably a later split\'s: mats may have missed bib 544 at 4200m and 5300m (below). Missed 4200m and 5300m: add them (4400m was read) moves it and the later times on and fills them. Enter opens the choices.');
    const q = A.finishedMissedText({ bib: '544', finished: true, finishPlace: 2 }, A.missedTarget(r.columns[1]), { outputs: ['TrackScore', 'Karmarush'], lif: false, inactive: '' });
    assert.match(q.body[0], /^Missed 4200m and 5300m: add them \(4400m was read\): they go to TrackScore and Karmarush/);
    // a Review row: the same set, the further run sent with it (missedRowTarget)
    const rv = A.normReview({ checks: [{ bib: '544', passTod: 200, raceTicks: m(20, 43, 500), from: 's6', fromName: '4400m', to: null, toName: 'the finish', reason: 'r',
      missed: { ...both, by: 'check', sure: true, alt: null } }] });
    assert.deepEqual(A.missedRowTarget(rv.checks[0], 's6'), { splitId: 's5', passTod: 150, count: 1, names: ['4200m', '5300m'], ok: true, why: '', also: [{ splitId: 's7', count: 1 }], read: ['4400m'] });
    // 568, a walker: Split Relay can't tell 4200m and 5300m apart from 4400m and 5300m in a row: both offered, neither
    // primary, each with what it does; the other one starts at another split and is sent with its own split and pass
    const inRow = { count: 2, names: ['4400m', '5300m'], ok: true, why: '', typed: false, effect: '28:22.6 → extra pass, 29:10.4 → extra pass', splitId: 's6', passTod: 300, splits: [] };
    const unsure = A.normRunner({ bib: '568', columns: [
      { splitId: 's5', splitName: '4200m', time: m(17, 56, 200), kind: 'read', passTod: 250 },
      { splitId: 's6', splitName: '4400m', time: m(28, 22, 600), kind: 'read', passTod: 300, status: 'check', check: { to: null, toName: 'the finish', reason: 'x' },
        missed: { ...inRow, here: true, by: 'check', sure: false, unsure: 'where', reason: "Looks like the finish, not 4400m: Split Relay can't tell which (missed 4200m and 5300m, or 4400m and 5300m?)",
          alt: { ...both, splitId: 's5', passTod: 250, effect: '17:56.2 → 4400m, 28:22.6 → extra pass, 29:10.4 → extra pass' } } }],
    passes: [pass(250, m(17, 56, 200), '17:56.2', 's5'), pass(300, m(28, 22, 600), '28:22.6', 's6')] }, null);
    const um = unsure.columns[1].missed;
    assert.deepEqual(A.missedChoices(um).map((x) => A.missedLabel(x)), ['Missed 4200m and 5300m: add them (4400m was read)', 'Missed 4400m and 5300m: add them']);
    assert.equal(A.missedUnsureText(um), "Split Relay can't tell which mats missed the runner: Missed 4200m and 5300m: add them (4400m was read) (17:56.2 → 4400m, 28:22.6 → extra pass, 29:10.4 → extra pass) or Missed 4400m and 5300m: add them (28:22.6 → extra pass, 29:10.4 → extra pass).");
    const um2 = A.menuFor(unsure, { col: unsure.columns[1] });
    // (9.23 F17: two sets under the heading the row and the cell's line say, "can't tell which", not "can't tell yet where")
    assert.deepEqual(um2.items.slice(0, 2).map((x) => [x.label, x.primary, x.group, x.act.key]), [
      ['Missed 4200m and 5300m: add them (4400m was read)', false, "Split Relay can't tell which", 's5:1,s7:1'],
      ['Missed 4400m and 5300m: add them', false, "Split Relay can't tell which", 's6:2']]);
    assert.ok(um2.items.every((x) => !x.primary), 'no one click while Split Relay cannot tell');
    assert.deepEqual([A.missedTarget(unsure.columns[1], um.alt).splitId, A.missedTarget(unsure.columns[1], um.alt).passTod, A.missedTarget(unsure.columns[1], um.alt).also],
      ['s5', 250, [{ splitId: 's7', count: 1 }]]);
    assert.match(A.cellModel(unsure.columns[1], { bib: '568' }, null, { editor: true }).info, /^4400m 28:22\.6 may be a later split's, but Split Relay can't tell which mats missed bib 568 \(below\)\./);
    // the find row names every split of the set
    assert.equal(A.findRowText({ bib: '544', name: 'A B', team: 'T', raceName: 'Womens Race', filled: 6, splits: 7, problems: 1, missed: ['4200m', '5300m'] }),
      '544 · A B · T · Womens Race · 6 of 7 splits · missed 4200m and 5300m?');
  });

  test('9.23 F17 the words: the menu\'s heading says what the row says (two sets: "can\'t tell which", never "yet" for them); a long stretch read between two mats as "1500m to 4400m were read"; the Undo dialog names the splits it empties', () => {
    // the heading over the choices that are not the one click, as missedUnsureText says it
    const two = { sure: false, unsure: 'where', alt: { names: ['4400m'] } };
    assert.deepEqual([A.missedGroup(two), A.missedGroup({ sure: false, unsure: 'where', alt: null }), A.missedGroup({ sure: false, unsure: null, alt: null }), A.missedGroup({ sure: true })],
      ["Split Relay can't tell which", "Split Relay can't tell yet where", "Split Relay can't tell yet how many", '']);
    // 568 with 4400m missed: its two sets in the menu under the row's words, neither primary, the right one among them
    const one = { count: 1, names: ['4400m'], ok: true, why: '', typed: true, effect: '22:31.3 → 5300m, 28:22.6 → extra pass (the finish)', splitId: 's6', passTod: 300, splits: [] };
    const apart = { count: 1, names: ['4200m', '5300m'], read: ['4400m'], readText: '4400m was read', runs: [{ splitId: 's5', splitName: '4200m', count: 1 }, { splitId: 's7', splitName: '5300m', count: 1 }],
      ok: true, why: '', typed: false, effect: '16:51.6 → 4400m, 22:31.3 → extra pass (the finish), 28:22.6 → extra pass', splitId: 's5', passTod: 250, splits: [] };
    const r = A.normRunner({ bib: '568', columns: [
      { splitId: 's5', splitName: '4200m', time: m(16, 51, 600), kind: 'read', passTod: 250, missed: { ...apart, here: true, by: 'check', sure: false, unsure: 'where',
        reason: "22:31.3 looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or 4200m and 5300m?).", alt: one } },
      { splitId: 's6', splitName: '4400m', time: m(22, 31, 300), kind: 'read', passTod: 300 }],
    passes: [{ tod: 250, raceTicks: m(16, 51, 600), timeText: '16:51.6', how: 'counted', splitId: 's5', where: 's5', inColumn: true, targets: [], only: [], finishOk: { ok: true, effect: '' } }] }, null);
    const menu = A.menuFor(r, { col: r.columns[0] });
    assert.deepEqual(menu.items.slice(0, 2).map((x) => [x.label, x.primary, x.group]), [
      ['Missed 4400m: add it', false, "Split Relay can't tell which"], ['Missed 4200m and 5300m: add them (4400m was read)', false, "Split Relay can't tell which"]]);
    assert.equal(A.missedUnsureText(r.columns[0].missed), "Split Relay can't tell which mats missed the runner: Missed 4400m: add it (22:31.3 → 5300m, 28:22.6 → extra pass (the finish)) or "
      + 'Missed 4200m and 5300m: add them (4400m was read) (16:51.6 → 4400m, 22:31.3 → extra pass (the finish), 28:22.6 → extra pass).');
    // 543 (800m and 5300m): the five splits read between them as one stretch, as Split Relay words it
    const far = A.normRunner({ bib: '543', columns: [{ splitId: 's1', splitName: '800m', time: m(5, 8, 200), kind: 'read', passTod: 50,
      missed: { count: 1, names: ['800m', '5300m'], read: ['1500m', '2400m', '3100m', '4200m', '4400m'], readText: '1500m to 4400m were read', ok: true, typed: false,
        runs: [{ splitId: 's1', splitName: '800m', count: 1 }, { splitId: 's7', splitName: '5300m', count: 1 }], splitId: 's1', passTod: 50, here: true, sure: true, splits: [] } }] }, null);
    assert.equal(A.missedLabel(far.columns[0].missed), 'Missed 800m and 5300m: add them (1500m to 4400m were read)');
    // (without Split Relay's words, every split read, as before)
    assert.equal(A.missedLabel({ names: ['800m', '5300m'], read: ['1500m', '2400m'] }), 'Missed 800m and 5300m: add them (1500m and 2400m were read)');
    // the Undo of a fix of two splits: the splits it empties by name
    const dlg = A.undoLeavesDialog([{ bib: '544', splitName: '4200m', text: '14:18.1' }, { bib: '544', splitName: '5300m', text: '18:09.9' }], ['TrackScore', 'Karmarush'], { bib: '544', finished: false });
    assert.deepEqual(dlg, { title: 'Take back 2 times?', body: ['Split Relay forgets them and takes them out of the merged .lif file; 4200m and 5300m are empty again in Review. TrackScore and Karmarush keep the 2 that were sent: a split packet can fill a cell but never empty one.'] });
  });

  test('9.23 F19 the words: Split Relay can\'t tell a missed first mat from a late start, nor a missed mat from a slow leg until the runner\'s next pass (or, a time that fits neither split well, its finish); the editor says so; a held cell before the one that asks "Missed here?" has no one click of its own (a late starter who missed 2400m had three: "Move to 1500m" and "Move to 2400m" wrong)', () => {
    const one = { count: 1, names: ['800m'], ok: true, why: '', typed: true, effect: '8:47.0 → 1500m, 11:16.2 → 2400m, …', splitId: 's1', passTod: 100, splits: [] };
    const later = { count: 1, names: ['2400m'], ok: true, why: '', typed: true, effect: '17:55.1 → 3100m, …', splitId: 's3', passTod: 300, splits: [] };
    const r = A.normRunner({ bib: '539', columns: [
      { splitId: 's1', splitName: '800m', time: m(8, 47), kind: 'read', passTod: 100, status: 'check', check: { to: 's2', toName: '1500m', reason: 'Looks like 1500m, not 800m (missed 800m?)' },
        missed: { ...one, here: true, by: 'check', sure: false, unsure: 'late', reason: 'Looks like 1500m, not 800m (missed 800m?)', alt: later } },
      { splitId: 's2', splitName: '1500m', time: m(11, 16, 200), kind: 'read', passTod: 200, status: 'check', check: { to: 's3', toName: '2400m', reason: 'Looks like 2400m, not 1500m (it moves with the pass before it)' } }],
    passes: [{ tod: 100, raceTicks: m(8, 47), timeText: '8:47.0', how: 'counted', splitId: 's1', where: 's1', inColumn: true, targets: [{ splitId: 's2', splitName: '1500m', ok: true, effect: '' }], only: [], finishOk: { ok: true, effect: '' } },
      { tod: 200, raceTicks: m(11, 16, 200), timeText: '11:16.2', how: 'counted', splitId: 's2', where: 's2', inColumn: true, targets: [{ splitId: 's3', splitName: '2400m', ok: true, effect: '' }], only: [], finishOk: { ok: true, effect: '' } }] }, null);
    const ms = r.columns[0].missed;
    assert.equal(A.missedUnsureText(ms), "Split Relay can't tell a missed mat from a late start: Missed 800m: add it (8:47.0 → 1500m, 11:16.2 → 2400m, …) if the runner started with the others, or Missed 2400m: add it (17:55.1 → 3100m, …) if it started late.");
    assert.equal(A.missedUnsureText({ ...ms, alt: null }), "Split Relay can't tell a missed mat from a late start (every pass late by the same time): choose Missed 800m: add it (8:47.0 → 1500m, 11:16.2 → 2400m, …) only if the runner started with the others.");
    assert.equal(A.missedUnsureText({ ...ms, alt: null, unsure: 'next' }), "Split Relay can't tell a missed mat from a slow leg until the runner's next pass: wait for it, or choose Missed 800m: add it (8:47.0 → 1500m, 11:16.2 → 2400m, …).");
    // (a time that fits neither split well: its next pass does not tell, its finish does)
    assert.equal(A.missedUnsureText({ ...ms, alt: null, unsure: 'slow' }), "Split Relay can't tell a missed mat from a slow leg until the runner's finish (the time fits neither split well): wait for it, or choose Missed 800m: add it (8:47.0 → 1500m, 11:16.2 → 2400m, …).");
    assert.deepEqual([A.missedGroup(ms), A.missedGroup({ sure: false, unsure: 'next', alt: null }), A.missedGroup({ sure: false, unsure: 'slow', alt: null })],
      ["Split Relay can't tell: a missed mat or a late start", "Split Relay can't tell yet: its next pass will", "Split Relay can't tell yet: its finish will"]);
    assert.match(A.cellModel(r.columns[0], { bib: '539' }, null, { editor: true }).info, /^800m 8:47\.0 may be a later split's, or bib 539 started late: Split Relay can't tell which \(below\)\./);
    assert.match(A.cellModel({ ...r.columns[0], missed: { ...ms, unsure: 'next', alt: null } }, { bib: '539' }, null, { editor: true }).info, /or a slow leg: Split Relay can tell after bib 539's next pass/);
    assert.match(A.cellModel({ ...r.columns[0], missed: { ...ms, unsure: 'slow', alt: null } }, { bib: '539' }, null, { editor: true }).info, /or a slow leg: Split Relay can tell once bib 539's finish is in/);
    // both choices in the menu under those words, neither the one click; the held 1500m's own Move is no one click either
    const menu = A.menuFor(r, { col: r.columns[0] });
    assert.deepEqual(menu.items.slice(0, 2).map((x) => [x.label, x.primary, x.group]), [['Missed 800m: add it', false, "Split Relay can't tell: a missed mat or a late start"],
      ['Missed 2400m: add it', false, "Split Relay can't tell: a missed mat or a late start"]]);
    const second = A.menuFor(r, { col: r.columns[1] });
    assert.ok(second.items.every((x) => !x.primary), JSON.stringify(second.items.map((x) => [x.label, x.primary])));
    // the runner editor's rows the same (the browser check's 539, six minutes late and 2400m missed: "Missed 2400m: add it"
    // the one click on its 2400m row, and "Move to 1500m" and "Move to 2400m" gold on its real 800m and 1500m), and the
    // Review rows of a runner a row says a mat missed
    const pass = (t, s, to) => ({ tod: t, raceTicks: t, timeText: A.formatRaceTime(t, 1), how: 'counted', splitId: s, where: s, inColumn: true,
      targets: [{ splitId: to, splitName: to, ok: true, effect: '' }], only: [], finishOk: { ok: true, effect: '' } });
    const held = (s, name, t, to, toName, extra = {}) => ({ splitId: s, splitName: name, time: t, kind: 'read', passTod: t, status: 'check', held: 'check',
      check: { to, toName, reason: `Looks like ${toName}, not ${name}` }, ...extra });
    const late = A.normRunner({ bib: '539', finishPlace: 167,
      columns: [held('s1', '800m', m(8, 47, 100), 's2', '1500m'), held('s2', '1500m', m(11, 16, 200), 's3', '2400m'),
        held('s3', '2400m', m(17, 55, 100), 's4', '3100m', { missed: { ...later, here: true, by: 'check', sure: true, reason: 'Looks like 3100m, not 2400m (missed 2400m?)', alt: null } })],
      passes: [pass(m(8, 47, 100), 's1', 's2'), pass(m(11, 16, 200), 's2', 's3'), pass(m(17, 55, 100), 's3', 's4')],
      problems: [0, 1, 2].map((col) => ({ kind: 'check', col, text: `${['800m', '1500m', '2400m'][col]}: looks like a later split's. Held until you choose.` })) }, null);
    const buttons = [...A.editorProblems({ fixBusy: false, busy: new Set() }, late, null).walk()].filter((e) => e.tagName === 'BUTTON')
      .map((e) => `${e.textContent}${/\bprimary\b/.test(e.className) ? ' (gold)' : ''}`);
    assert.deepEqual(buttons, ['Move to 1500m', 'Keep in 800m', 'Move to 2400m', 'Keep in 1500m', 'Missed 2400m: add it (gold)', 'Keep in 2400m']);
    assert.deepEqual([A.moveIsOneClick(late), A.moveIsOneClick({ columns: [late.columns[0]] })], [false, true]);
    assert.deepEqual([...A.hintedBibs({ checks: [{ bib: '539' }, { bib: '539', missed: later }, { bib: '7' }], flags: [{ bib: '8', missed: one }, { bib: '9' }] })], ['539', '8']);
    // the find row beside a missed split: the other things are more (the editor counts all three as "3 look wrong")
    assert.equal(A.findRowText({ bib: '539', name: 'A B', team: 'T', raceName: 'Womens Race', filled: 7, splits: 7, problems: 3, missed: ['2400m'] }),
      '539 · A B · T · Womens Race · 7 of 7 splits · missed 2400m? · 2 more to look at');
    // a pass past the last split after the runner's known finish is after the finish (571: "After the last split")
    assert.deepEqual([A.passWords({ kind: 'extra', raceTicks: m(28, 33, 600) }, { finishTicks: m(28, 23) }), A.passWords({ kind: 'extra', raceTicks: m(20, 0) }, { finishTicks: null }),
      A.passWords({ kind: 'after-finish' }, {}), A.passWords({ kind: 'what' }, {}, 'no split')], ['After the finish', 'After the last split', 'After the finish', 'no split']);
    // two sets that differ in which splits, not how many in a row (568: 3100m, 4400m and 5300m, or 3100m, 4200m and 5300m)
    const which = A.normRunner({ bib: '568', columns: [{ splitId: 's4', splitName: '3100m', time: m(17, 56, 200), kind: 'read', passTod: 50, missed: { count: 1, names: ['3100m', '4400m', '5300m'],
      runs: [{ splitId: 's4', splitName: '3100m', count: 1 }, { splitId: 's6', splitName: '4400m', count: 2 }], ok: true, typed: false, splitId: 's4', passTod: 50, here: true, by: 'check', sure: false,
      reason: 'x', splits: [], alt: { count: 2, names: ['3100m', '4200m', '5300m'], runs: [{ splitId: 's4', splitName: '3100m', count: 2 }, { splitId: 's7', splitName: '5300m', count: 1 }], ok: true, splitId: 's4', passTod: 50, splits: [] } } }] }, null);
    assert.match(A.missedUnsureText(which.columns[0].missed), /^Split Relay can't tell which mats missed the runner: /);
    assert.match(A.cellModel(which.columns[0], { bib: '568' }, null, { editor: true }).info, /Split Relay can't tell which mats missed bib 568/);
  });

  test('9.23 F20 the words and the request: a set that sets a stray pass aside says so and sends it; Split Relay can\'t tell a missed mat from one slow leg; a cell offers its own split alone to type when the choices are sets of several splits; a held pass\'s row says what the boards show after an Undo; the quiet note of a slow leg', () => {
    const pass = (tod, t, text, where) => ({ tod, raceTicks: t, timeText: text, how: 'counted', splitId: where, where, inColumn: true, targets: [], only: [], finishOk: { ok: true, effect: '' } });
    // 2400m missed, a stray read 40 s after the 3100m pass made up for it in the count (the re-check's probe8dup)
    const stray = { count: 1, names: ['2400m'], aside: [{ passTod: 120, timeText: '11:24.4' }], ok: true, why: '', typed: true, effect: '10:44.4 → 3100m, 11:24.4 → not a split', splitId: 's3', passTod: 110,
      splits: [{ splitId: 's3', splitName: '2400m', estimate: m(8, 21, 900), basis: 'From 1500m 4:56.8 and 3100m 10:44.4.' }] };
    const r = A.normRunner({ bib: '1', missedHint: { ...stray, sure: true }, columns: [
      { splitId: 's3', splitName: '2400m', time: m(10, 44, 400), kind: 'read', passTod: 110, missed: { ...stray, here: true, by: 'flag', sure: true, alt: null, reason: '10:44.4 looks like 3100m, not 2400m (missed 2400m?): 5:48 after 1500m, where runners of the same pace took 5:57. 11:24.4 is a stray pass, 0:40 after 10:44.4.' } },
      { splitId: 's4', splitName: '3100m', time: m(11, 24, 400), kind: 'read', passTod: 120 }],
    passes: [pass(110, m(10, 44, 400), '10:44.4', 's3'), pass(120, m(11, 24, 400), '11:24.4', 's4')] }, null);
    const ms = r.columns[0].missed;
    assert.deepEqual([A.missedLabel(ms), A.missedKey(ms), A.missedKey({ ...ms, aside: [] })], ['Missed 2400m: add it (11:24.4 is a stray pass)', 's3:1/120', 's3:1']);
    assert.deepEqual(A.missedTarget(r.columns[0]), { splitId: 's3', passTod: 110, count: 1, basis: 'From 1500m 4:56.8 and 3100m 10:44.4.', ok: true, why: '', names: ['2400m'], aside: [120], asideText: ['11:24.4'] });
    const menu = A.menuFor(r, { col: r.columns[0] });
    assert.deepEqual([menu.items[0].label, menu.items[0].primary, menu.items[0].sub], ['Missed 2400m: add it (11:24.4 is a stray pass)', true, '8:21.9 suggested · 10:44.4 → 3100m, 11:24.4 → not a split']);
    const q = A.finishedMissedText({ bib: '1', finished: true, finishPlace: 23 }, A.missedTarget(r.columns[0]), { outputs: ['TrackScore', 'Karmarush'], lif: false, inactive: '' });
    assert.match(q.body[0], /^Missed 2400m: add it \(11:24\.4 is a stray pass\): it goes to TrackScore and Karmarush/);
    // one slow leg: offered, never the one click, in the words, the menu's heading and the cell's line
    const leg = A.normRunner({ bib: '1', columns: [{ splitId: 's3', splitName: '2400m', time: m(10, 51, 500), kind: 'read', passTod: 110,
      missed: { count: 1, names: ['2400m'], ok: true, typed: true, effect: '10:51.5 → 3100m, 13:14.4 → 4200m', splitId: 's3', passTod: 110, splits: [], here: true, by: 'flag', sure: false, unsure: 'leg',
        leg: { from: '1500m', to: '2400m', lostText: '2:30' }, reason: '10:51.5 looks like 3100m, not 2400m (missed 2400m?)', alt: null } }],
    passes: [pass(110, m(10, 51, 500), '10:51.5', 's3')] }, null);
    const lm = leg.columns[0].missed;
    assert.equal(A.missedUnsureText(lm), "Split Relay can't tell a missed mat from a slow leg (1500m to 2400m took 2:30 longer than runners of the same pace, and its later times fit as read): choose Missed 2400m: add it (10:51.5 → 3100m, 13:14.4 → 4200m) only if a mat missed the runner.");
    assert.equal(A.missedGroup(lm), "Split Relay can't tell: a missed mat or a slow leg");
    assert.match(A.cellModel(leg.columns[0], { bib: '1' }, null, { editor: true }).info, /^2400m 10:51\.5 may be a later split's, or bib 1 lost time on one leg: Split Relay can't tell which \(below\)\./);
    assert.ok(A.menuFor(leg, { col: leg.columns[0] }).items.every((x) => !x.primary));
    // three mats missed apart: the cell offers its own split alone to type (the server's `one`), with its suggestion
    const three = { count: 1, names: ['800m', '2400m', '4200m'], runs: [{ splitId: 's1', splitName: '800m', count: 1 }, { splitId: 's3', splitName: '2400m', count: 1 }, { splitId: 's5', splitName: '4200m', count: 1 }],
      read: ['1500m', '3100m', '4400m'], ok: true, typed: false, effect: '…', splitId: 's1', passTod: 100, splits: [] };
    const one = { count: 1, names: ['800m'], ok: false, why: '4:53.8 looks like 1500m: bib 410 missed 800m, 2400m and 4200m? Add them together, or type the time.', typed: true, effect: '4:53.8 → 1500m', splitId: 's1', passTod: 100,
      splits: [{ splitId: 's1', splitName: '800m', estimate: m(2, 39, 200), basis: 'From the gun and 1500m 4:53.8.' }] };
    const t = A.normRunner({ bib: '410', columns: [{ splitId: 's1', splitName: '800m', time: m(4, 53, 800), kind: 'read', passTod: 100,
      missed: { ...three, here: true, by: 'check', sure: false, unsure: 'where', reason: 'x', alt: null, one } }], passes: [pass(100, m(4, 53, 800), '4:53.8', 's1')] }, null);
    const tm = A.menuFor(t, { col: t.columns[0] });
    assert.deepEqual(tm.items.filter((x) => x.key === 'missed-time').map((x) => [x.label, x.sub]), [['Missed 800m: type its time…', 'the later times move on one split']]);
    assert.deepEqual([A.missedOne(t.columns[0].missed)?.names, A.missedOne(t.columns[0].missed)?.splits[0].estimate], [['800m'], m(2, 39, 200)]);
    // a held pass that never went out (after an Undo): what the boards show there
    assert.equal(A.checkSentText({ from: { name: '1500m' }, delivered: false, sentOther: { timeText: '4:50.8' }, missed: { names: ['1500m', '3100m'], read: ['2400m'], runs: [{}, {}], sure: true } }),
      'It never went out: TrackScore and the live results show 4:50.8 at 1500m. Missed 1500m and 3100m: add them (2400m was read) puts the right time there, in the same change.');
    const rv = A.normReview({ checks: [{ bib: '475', passTod: 200, raceTicks: m(8, 12, 700), from: 's2', fromName: '1500m', to: 's3', toName: '2400m', reason: 'r', delivered: false, sentOther: { timeText: '4:50.8' } }] });
    assert.deepEqual([rv.checks[0].delivered, rv.checks[0].sentOther], [false, { timeText: '4:50.8' }]);
    // the quiet note of a runner Split Relay takes for one slow leg, every mat read
    const slow = A.normRunner({ bib: '1', columns: [], passes: [], slowLeg: { splitName: '2400m', raceTicks: 1500000, text: '2:30' } }, null);
    assert.equal(A.runnerStatusText({ ...slow, finished: false, passes: [{ kind: 'counted' }] }), 'Finish not known · 1 pass · about 2:30 lost before 2400m?');
  });

  test('9.23 F21 the words: a stray set whose times fit about as well as read (a fast leg) is offered, never the one click, in the words, the menu\'s heading and the cell\'s line', () => {
    const pass = (tod, t, text, where) => ({ tod, raceTicks: t, timeText: text, how: 'counted', splitId: where, where, inColumn: true, targets: [], only: [], finishOk: { ok: true, effect: '' } });
    // the re-check's fastx 76: its last 900 m in 0.7 of its own time, "Missed 5300m: add it (17:40.3 is a stray pass)" sure
    const fast = { count: 1, names: ['5300m'], aside: [{ passTod: 130, timeText: '17:40.3' }], ok: true, why: '', typed: true, effect: '17:40.3 → not a split', splitId: 's7', passTod: 140, splits: [] };
    const r = A.normRunner({ bib: '76', columns: [{ splitId: 's7', splitName: '5300m', time: m(17, 40, 300), kind: 'read', passTod: 130,
      missed: { ...fast, here: true, by: 'count', sure: false, unsure: 'stray', alt: null, reason: '17:40.3 is a stray pass, 2:16 after 15:24.4. 20:31.5 looks like the finish, not 5300m (missed 5300m?).' } }],
    passes: [pass(130, m(17, 40, 300), '17:40.3', 's7')] }, null);
    const ms = r.columns[0].missed;
    assert.equal(A.missedUnsureText(ms), "Split Relay can't tell a stray pass from a fast leg (the runner's times fit about as well as they were read): choose Missed 5300m: add it (17:40.3 is a stray pass) (17:40.3 → not a split) only if the runner was not that fast.");
    assert.equal(A.missedGroup(ms), "Split Relay can't tell: a stray pass or a fast leg");
    assert.match(A.cellModel(r.columns[0], { bib: '76' }, null, { editor: true }).info, /^5300m 17:40\.3 may be a later split's after a stray pass, or bib 76 ran one leg fast: Split Relay can't tell which \(below\)\./);
    assert.ok(A.menuFor(r, { col: r.columns[0] }).items.every((x) => !x.primary), 'no gold one click');
    // a Splits that look wrong row: its one click, or for a short leg Split Relay can't call a stray for sure, a plain
    // "Not a split" beside It's right (the re-check's 549: only It's right)
    assert.deepEqual(A.flagChoices({ kind: 'short', suggest: null }), [{ label: 'Not a split', to: 'none', primary: false }]);
    assert.deepEqual(A.flagChoices({ kind: 'short', suggest: { to: 'none', toName: 'not a split' } }), [{ label: 'Not a split', to: 'none', primary: true }]);
    assert.deepEqual(A.flagChoices({ kind: 'long', suggest: { to: 's4', toName: '3100m' } }, true), [{ label: 'Move to 3100m', to: 's4', primary: false }]);
    assert.deepEqual(A.flagChoices({ kind: 'long', suggest: null }), []);
    // a finisher's row choice asks first with the pass's own time and the split it goes to (577 was asked "undefined is
    // not a split.")
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true, paused: [], inactive: '' };
    const fin = { bib: '577', finished: true, finishPlace: 67 };
    const row = { passTod: 123, splitId: 's4', passSplitId: '', raceTicks: m(9, 53, 700), suggest: null };
    assert.deepEqual(A.flagPass(row), { tod: 123, inColumn: true, where: 's4', timeText: '9:53.7', targets: [] });
    assert.match(A.finishedMoveText(fin, A.flagPass(row), 'none', '', dest).body[0], /^9:53\.7 is not a split\. The splits this changes go to TrackScore and Karmarush/);
    const moved = A.flagPass({ ...row, suggest: { to: 's5', toName: '4200m' } });
    assert.deepEqual(moved.targets, [{ splitId: 's5', splitName: '4200m' }]);
    assert.match(A.finishedMoveText(fin, moved, 's5', moved.targets[0].splitName, dest).body[0], /^9:53\.7 goes to 4200m\. /);
  });

  test('Esc on a confirm dialog (Move 2:47.1 to 1500m?) is its Cancel at once: the focus goes back to the cell that opened it', async () => {
    // a <dialog> whose close event comes late, or never (a page not drawn): only its cancel event fires at the Esc
    const dlg = doc.createElement('dialog');
    dlg.setAttribute('id', 'dlg-confirm');
    dlg.open = false;
    dlg.showModal = () => { dlg.open = true; };
    dlg.close = () => { dlg.open = false; };
    const fire = (type) => {
      const ev = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const f of [...(dlg.listeners[type] ?? [])]) f(ev);
      return ev;
    };
    const editor = doc.createElement('div');
    const cell = A.h('button', { 'data-fk': 'rec-0' }, '800m 2:47.1');
    editor.append(cell);
    doc.body.replaceChildren(editor, dlg);
    cell.focus();
    const asked = A.confirmDialog({ title: 'Move 2:47.1 to 1500m?', body: ["2:47.1 doesn't fit 1500m at bib 586's pace."], confirm: 'Move anyway', back: cell });
    assert.equal(dlg.open, true);
    assert.notEqual(doc.activeElement, cell, 'the dialog has the focus');
    // the editor is drawn again while the dialog is open (the focus is not in it)
    const fresh = A.h('button', { 'data-fk': 'rec-0' }, '800m 2:47.1');
    editor.replaceChildren(fresh);
    const ev = fire('cancel');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(dlg.open, false);
    assert.equal(doc.activeElement, fresh, 'on the cell at once, not on the page');
    assert.equal(await asked, false, 'a Cancel');
    // the next dialog's Esc is its own (the first one's listener is gone)
    const next = A.confirmDialog({ title: 'Undo this change?', body: ['x'], confirm: 'Undo anyway', back: fresh });
    assert.equal((dlg.listeners.cancel ?? []).length, 1);
    fire('cancel');
    assert.equal(await next, false);
    assert.equal(doc.activeElement, fresh);
    doc.body.replaceChildren();
  });

  test('the toast of a change: what it did, where it went, what the boards keep', () => {
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true, paused: [], inactive: '' };
    const move = { fix: 7, kind: 'move', text: '16:10.8 moved to 4200m; 22:28.8 → 4400m, 26:22.1 → 5300m; 29:45.0 is an extra pass now', bibs: ['586'],
      cells: [{ bib: '586', splitId: 's3', splitName: '3100m', before: '16:10.8', after: '' }], leftover: [{ bib: '586', splitName: '3100m', text: '16:10.8' }],
      sentTo: ['TrackScore', 'Karmarush'], lifOnly: false, notLive: [], staleOthers: 12, undoable: true, leaves: [], notes: [] };
    // (a Move's toast never counts the other places it put out of date: the race tile offers Resend when it matters)
    assert.equal(A.fixToast(move, dest), 'Bib 586: 16:10.8 moved to 4200m; 22:28.8 → 4400m, 26:22.1 → 5300m; 29:45.0 is an extra pass now. Sent to TrackScore and Karmarush, and into the merged .lif file. 3100m is empty: TrackScore and Karmarush still show 16:10.8 there until you fill it.');
    for (const kind of ['move', 'only', 'none', 'finish', 'count', 'keep', 'check', 'undo']) assert.doesNotMatch(A.fixToast({ ...move, kind }, dest), /other place/, kind);
    // a fill still says it
    assert.match(A.fixToast({ ...move, kind: 'fill', text: '3100m 11:53.6 made up', leftover: [], cells: [] }, dest), / 12 other places on TrackScore are now out of date: Resend from the race tile\.$/);
    assert.equal(A.fixToast({ ...move, kind: 'only', text: 'Only 16:10.8 moved (to 4400m)', leftover: [], staleOthers: 0 }, dest),
      'Bib 586: Only 16:10.8 moved (to 4400m); the other times stay where they are. Sent to TrackScore and Karmarush, and into the merged .lif file.');
    // a finisher: the .lif only
    assert.equal(A.fixToast({ ...move, sentTo: [], leftover: [], staleOthers: 0, notLive: [{ bib: '586', splitId: 's4', splitName: '4200m', why: 'has finished: use Send with finish place' }] }, dest),
      'Bib 586: 16:10.8 moved to 4200m; 22:28.8 → 4400m, 26:22.1 → 5300m; 29:45.0 is an extra pass now. Into the merged .lif file only: bib 586 has finished (Send with finish place in the runner).');
    // a race that is not Active
    assert.match(A.fixToast({ ...move, sentTo: [], leftover: [], staleOthers: 0 }, { ...dest, inactive: 'Womens Race' }), / Into the merged \.lif file only: Womens Race is not Active\.$/);
    // a new question
    assert.match(A.fixToast({ ...move, leftover: [], staleOthers: 0, notLive: [{ bib: '586', splitName: '4400m', why: 'held: Split Relay has a question about it' }] }, dest),
      / Split Relay now has a question about 4400m: it is held until you answer\.$/);
    // (9.23 F18: the question is the cell's that says "Missed here?": after 489's Undo, 2400m, its passes from 3100m on held)
    assert.match(A.fixToast({ ...move, kind: 'undo', leftover: [], staleOthers: 0, notLive: [{ bib: '489', splitName: '3100m', why: 'held: Split Relay has a question about it' },
      { bib: '489', splitName: '4200m', why: 'held: Split Relay has a question about it' }] }, dest, { runner: { columns: [{ splitName: '2400m', missed: { here: true } }, { splitName: '3100m', missed: null }] } }),
    / Split Relay now has a question about 2400m: 3100m and the times after it are held until you answer\.$/);
    // This is the finish: the split before it is missing
    const fin = { ...move, kind: 'finish', text: '24:17.3 is the finish now', bibs: ['403'], leftover: [], staleOthers: 0, sentTo: [], cells: [] };
    assert.equal(A.fixToast(fin, dest, { runner: { columns: [{ splitName: '5300m', raceTicks: null, kind: 'missing', estimate: m(20, 57, 500) }] } }),
      'Bib 403: 24:17.3 is the finish now. 5300m is missing: Split Relay suggests 20:57.5.');
    assert.equal(A.fixToast(fin, dest, { runner: { columns: [{ splitName: '5300m', raceTicks: null, kind: 'blocked' }] } }),
      "Bib 403: 24:17.3 is the finish now. 5300m is missing, but it can't be sent until Split Relay knows the finish place (FinishLynx's .lif file: Settings, Merged .lif files).");
    // an Undo and its Redo
    assert.equal(A.isRedo({ kind: 'undo', text: 'Undone: the made-up 3100m time (11:53.6) taken back' }), true);
    assert.equal(A.isRedo({ kind: 'undo', text: 'Done again: 3100m 11:53.6 made up' }), false);
    assert.equal(A.fixToast({ ...move, kind: 'undo', text: 'Undone: the made-up 3100m time (11:53.6) taken back', leftover: [], staleOthers: 0, sentTo: [], cells: [], notes: ['Bib 512 was changed since: not undone.'] }, dest),
      'Bib 586: Undone: the made-up 3100m time (11:53.6) taken back. Bib 512 was changed since: not undone.');
    // a finisher's Undo: "the boards keep what Send with finish place sent" only when a board has a time of a cell it
    // changed that went with the finish place (403: This is the finish, then Ctrl+Z with the .lif off: nothing went so)
    const undo = { ...move, kind: 'undo', bibs: ['403'], text: 'Undone: 24:17.3 is the 5300m split again', leftover: [], staleOthers: 0, sentTo: [],
      cells: [{ bib: '403', splitId: 's7', splitName: '5300m', before: '', after: '24:17.3' }], finishKept: [] };
    const own = A.fixToast(undo, { ...dest, lif: false });
    assert.equal(own, 'Bib 403: Undone: 24:17.3 is the 5300m split again.');
    assert.equal(A.undoFinishNote(undo, own), '');
    assert.equal(A.undoFinishNote({ ...undo, finishKept: undefined }, own), '', 'an older Split Relay says nothing of it');
    const kept = { ...undo, bibs: ['507'], finishKept: [{ bib: '507', splitName: '4400m', text: '14:37.1' }] };
    assert.equal(A.undoFinishNote(kept, A.fixToast(kept, dest)), ' The boards keep what Send with finish place sent: send with the finish place again to put the old times back.');
    // (said once: the toast says the finisher's words already when the restored times went to the .lif only)
    const lifOnly = { ...kept, notLive: [{ bib: '507', splitId: 's6', splitName: '4400m', why: 'has finished: use Send with finish place' }] };
    assert.equal(A.undoFinishNote(lifOnly, A.fixToast(lifOnly, dest)), '');
  });

  test('a change asked first only when it goes against the pace, or for a finisher (with the finish place); toasts say each thing once', () => {
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true, paused: [], inactive: '' };
    // a Move far from the runner's pace (586's 2:47.1 to 5300m: a leg a tenth of theirs) is asked first; one that fits is not
    assert.deepEqual([A.paceOff({ pace: 'early' }), A.paceOff({ pace: 'late' }), A.paceOff({ pace: '' }), A.paceOff(null)], ['early', 'late', '', '']);
    assert.equal(A.normRunner({ bib: '586', passes: [{ tod: 1, targets: [{ splitId: 's7', splitName: '5300m', ok: true, pace: 'early' }] }] }, null).passes[0].targets[0].pace, 'early');
    const q = A.paceText({ bib: '586' }, { timeText: '2:47.1' }, '5300m', 'early', dest);
    assert.deepEqual([q.title, q.body, q.confirm], ['Move 2:47.1 to 5300m?', ["2:47.1 doesn't fit 5300m at bib 586's pace: runners of the same pace take far longer to get there.",
      'It goes to TrackScore and Karmarush at once; Undo puts it back.'], 'Move anyway']);
    // a finisher: one question, then the changed splits go with the finish place
    const fin = { bib: '507', finished: true, finishPlace: 23 };
    assert.deepEqual([A.finishedMoveAsks(fin, 's5', dest), A.finishedMoveAsks(fin, 'keep', dest), A.finishedMoveAsks(fin, 'finish', dest),
      A.finishedMoveAsks({ ...fin, finishPlace: null }, 's5', dest), A.finishedMoveAsks(fin, 's5', { ...dest, inactive: 'Womens Race' }), A.finishedMoveAsks({ bib: '1' }, 's5', dest)],
    [true, false, false, false, false, false]);
    const t = A.finishedMoveText(fin, { timeText: '15:32.0' }, 's5', '4400m', dest);
    assert.equal(t.title, 'Bib 507 has finished: send with the finish place?');
    assert.equal(t.body[0], '15:32.0 goes to 4400m. The splits this changes go to TrackScore and Karmarush, and into the merged .lif file, with place 23, the finish place, so TrackScore and Karmarush keep it.');
    assert.equal(t.confirm, 'Send with finish place');
    // the editor's info line under the cells does not repeat the problem line below it
    const col = { splitId: 's3', splitName: '3100m', raceTicks: m(16, 10, 800), place: 135, kind: 'read', how: 'counted',
      flag: { kind: 'long', text: '16:10.8 looks like 4200m, not 3100m (missed 3100m?): 6:45 after 2400m.', silenced: false } };
    assert.equal(A.cellModel(col, { bib: '586' }, dest, { editor: true }).info, '3100m 16:10.8 looks wrong: why, and the fix, below. Enter opens the choices.');
    assert.equal(A.cellModel(col, { bib: '586' }, dest).info, '16:10.8 looks like 4200m, not 3100m (missed 3100m?): 6:45 after 2400m. Enter opens the choices.', 'the grid\'s tooltip says it all');
    assert.equal(A.cellModel({ ...col, kind: 'moved', how: 'shifted', flag: null }, { bib: '586' }).aria, '3100m: 16:10.8, 135th, moved here in Review, with the time before it');
    // two emptied cells in one sentence; a finisher whose place is not known
    const move = { fix: 7, kind: 'move', text: '19:39.5 moved to 5300m; the made-up 4200m and 4400m times are taken out', bibs: ['521'], cells: [],
      leftover: [{ bib: '521', splitName: '4200m', text: '22:15.7' }, { bib: '521', splitName: '4400m', text: '22:49.0' }], sentTo: ['TrackScore', 'Karmarush'], notLive: [], staleOthers: 0, notes: [] };
    assert.equal(A.fixToast(move, dest), 'Bib 521: 19:39.5 moved to 5300m; the made-up 4200m and 4400m times are taken out. Sent to TrackScore and Karmarush, and into the merged .lif file. '
      + '4200m and 4400m are empty: TrackScore and Karmarush still show 22:15.7 and 22:49.0 there until you fill them.');
    const lifOnly = { ...move, sentTo: [], leftover: [], notLive: [{ bib: '512', splitId: 's7', splitName: '5300m', why: 'has finished: use Send with finish place' }], bibs: ['512'], text: '24:15.4 moved to 5300m' };
    assert.equal(A.fixToast(lifOnly, dest, { runner: { finished: true, finishPlace: null, columns: [] } }),
      "Bib 512: 24:15.4 moved to 5300m. Into the merged .lif file only: bib 512 has finished, and Split Relay doesn't know the finish place yet.");
  });

  test('Fill in N: the rows that can go, and the runners left out in words', () => {
    const row = (bib, x = {}) => ({ key: `${bib}|s3`, bib, name: `Runner ${bib}`, splitId: 's3', splitName: '3100m', estimate: m(11, 53, 600), estimateText: '11:53.600',
      basis: 'From 2400m 9:25.4 and 4200m 16:10.8, placed like the 30 runners nearest in pace (3100m at 36.6% of that stretch).',
      prev: { name: '2400m', ticks: m(9, 25, 400) }, next: { name: '4200m', ticks: m(16, 10, 800) }, finished: false, finishPlace: null, blocked: '', ...x });
    const plan = A.fillAllPlan([row('586'), row('403', { finished: true }), row('521', { blocked: "Check bib 521's columns first (Review: Move or Keep): a pass of this runner looks like another split's." }),
      row('600', { estimate: null }), row('115', { blocked: "Check bib 115's 3100m first: 19:39.5 looks like 5300m. Move it, or choose It's right; then this split can be filled." })], { dropped: ['452', '432'] });
    assert.deepEqual(plan.send.map((x) => x.bib), ['586']);
    assert.deepEqual(plan.left.map((x) => x.text), ['no read after their last split and no finish, so they may have dropped out: 432 and 452',
      "finished, but the finish place isn't known: 403", "a split of theirs looks wrong: Move it or choose It's right first: 115", "check these runners' columns first: 521", "Split Relay can't fill these yet: 600"]);
    assert.equal(A.fillRowText(row('586', { name: "Runner O'Example" })), "586 · Runner O'Example · 3100m · 11:53.6 · 36.6% of 2400m–4200m");
  });

  test('the top bar\'s box: one runner opens, an exact bib in the Active race opens, several stay listed, none is said', () => {
    const a = { raceId: 'w', raceName: 'Womens Race', active: true, bib: '586', name: "Runner O'Example", team: 'State', filled: 7, splits: 7, finished: false, problems: 1, by: 'bib' };
    const b = { ...a, raceId: 'm', raceName: 'Mens Race', active: false };
    assert.deepEqual(A.findPick([a], '586'), { go: a });
    assert.deepEqual(A.findPick([a, b], '586'), { go: a });
    assert.deepEqual(A.findPick([{ ...a, active: false }, b], '586'), { open: true });
    assert.deepEqual(A.findPick([], '999'), { none: 'No runner with bib 999 has a read in any race.' });
    assert.deepEqual(A.findPick([], 'kratz'), { none: 'No runner called "kratz" has a read yet.' });
    assert.equal(A.findRowText(a), "586 · Runner O'Example · State · Womens Race · 7 of 7 splits · 1 to look at");
  });

  test('the race grid: a table when it fits, cards when not; problems first; the filters', () => {
    assert.deepEqual([A.gridFits(390, 7), A.gridFits(846, 7), A.gridFits(1280, 7)], [false, true, true]);
    const rows = [{ bib: '20', name: 'Ann Lee', team: 'Central', tier: 8, cells: [{ t: 1 }, { t: 2 }], finished: true },
      { bib: '3', name: 'Bo Ng', team: 'West', tier: 1, cells: [{ t: 1 }], changed: true },
      { bib: '100', name: 'Ció Sá', team: 'East', tier: 7, cells: [{ t: 3 }], stopped: { col: 0, text: 'No read after 1K (3:00.0)' } }];
    assert.deepEqual(A.gridView(rows).map((r) => r.bib), ['3', '100', '20']);
    assert.deepEqual(A.gridView(rows, { order: 'bib' }).map((r) => r.bib), ['3', '20', '100']);
    assert.deepEqual(A.gridView(rows, { order: 'far' }).map((r) => r.bib), ['20', '3', '100']);
    assert.deepEqual(A.gridView(rows, { chip: 'fix' }).map((r) => r.bib), ['3']);
    assert.deepEqual(A.gridView(rows, { chip: 'changed' }).map((r) => r.bib), ['3']);
    assert.deepEqual(A.gridView(rows, { chip: 'stopped' }).map((r) => r.bib), ['100']);
    assert.deepEqual(A.gridView(rows, { onlyProblems: true }).map((r) => r.bib), ['3']);
    assert.deepEqual(A.gridView(rows, { q: 'cio' }).map((r) => r.bib), ['100'], 'accents and case do not matter');
    assert.deepEqual(A.gridView(rows, { q: '2' }).map((r) => r.bib), ['20']);
  });

  test('the editor\'s keys: arrows, Enter, digits, Shift+arrows, F and Delete open the menu (never act alone), Ctrl+Z', () => {
    const ctx = (x) => ({ i: 2, n: 8, kind: 'read', pass: true, editable: false, ...x });
    const k = (key, x = {}, mod = {}) => A.editorKey({ key, ...mod }, ctx(x));
    assert.deepEqual([k('ArrowRight'), k('ArrowLeft'), k('Home'), k('End')], [{ act: 'focus', to: 3 }, { act: 'focus', to: 1 }, { act: 'focus', to: 0 }, { act: 'focus', to: 7 }]);
    assert.deepEqual(k('Enter'), { act: 'menu' });
    assert.deepEqual(k('Enter', { kind: 'missing', pass: false }), { act: 'send' });
    assert.deepEqual(k('Enter', { kind: 'not-yet', pass: false }), { act: 'box' });
    assert.deepEqual(k('7', { kind: 'missing', pass: false }), { act: 'box', digit: '7' });
    assert.equal(k('7'), null, 'a digit on a read time does nothing');
    assert.deepEqual(k('7', { kind: 'made-up', pass: false, editable: true }), { act: 'box', digit: '7' });
    assert.deepEqual(k('ArrowRight', {}, { shiftKey: true }), { act: 'shift', dir: 1 });
    assert.deepEqual(k('f'), { act: 'menu', focus: 'finish' });
    assert.deepEqual(k('Delete'), { act: 'menu', focus: 'none' });
    assert.deepEqual(k('Backspace', { kind: 'typed', pass: false, editable: true }), { act: 'menu', focus: 'remove' });
    assert.deepEqual([k('z', {}, { ctrlKey: true }), k('z', {}, { ctrlKey: true, shiftKey: true }), k('y', {}, { ctrlKey: true })], [{ act: 'undo' }, { act: 'redo' }, { act: 'redo' }]);
    assert.deepEqual(k('Escape'), { act: 'close' });
    assert.deepEqual(k('Enter', { i: 7, finishCell: true, pass: false }), { act: 'info' });
    // where the editor puts focus: held, else flagged, else missing, else the last filled
    const cols = (...kinds) => ({ columns: kinds.map((x) => ({ raceTicks: x === 'missing' ? null : 1, kind: x === 'held' || x === 'flag' ? 'read' : x,
      status: x === 'held' ? 'check-column' : '', flag: x === 'flag' ? { silenced: false } : null })) });
    assert.deepEqual([A.editorFocus(cols('read', 'flag', 'held')), A.editorFocus(cols('read', 'missing', 'flag')), A.editorFocus(cols('read', 'missing')), A.editorFocus(cols('read', 'read'))], [2, 2, 1, 1]);
    assert.equal(A.runnerStatusText({ finished: false, passes: [{ kind: 'counted' }, { kind: 'ignored' }], problems: [{ kind: 'flag' }] }), 'Finish not known · 1 pass · 1 looks wrong');
    assert.equal(A.runnerStatusText({ finished: true, finishBy: 'lynx', finishPlace: 164, finishTicks: m(26, 22, 100), passes: [], problems: [] }), 'Finished 164th in 26:22.1 (FinishLynx) · 0 passes');
    assert.equal(A.runnerStatusText({ finished: true, finishBy: 'marked', finishPlace: null, finishTicks: m(24, 17, 300), passes: [], problems: [] }), 'Finish 24:17.3 (you marked it) · place not known yet · 0 passes');
    // 9.23 F18: a runner Split Relay takes for a late starter: a quiet note, nothing to do
    assert.equal(A.runnerStatusText({ finished: true, finishBy: 'lynx', finishPlace: 165, finishTicks: m(29, 4, 700), passes: [{ kind: 'counted' }], problems: [], lateStart: '5:00' }),
      'Finished 165th in 29:04.7 (FinishLynx) · 1 pass · started about 5:00 after the gun?');
    assert.deepEqual([A.normRunner({ bib: '423', lateStart: { raceTicks: m(5, 0, 0), text: '5:00' } }, null).lateStart, A.normRunner({ bib: '423' }, null).lateStart], ['5:00', '']);
  });

  test('the race tile says how many look wrong; Clear race data says the Moves stay and the made-up times go', () => {
    const c = A.reviewCounts(view('g', { review: { missing: 0, estimable: 0, checks: 0, manual: 0, flagged: 4, pinned: 2, madeUp: 3 } }));
    assert.equal(A.reviewBadgeText(c), '4 look wrong');
    assert.equal(A.reviewTone(c), 'warn');
    assert.equal(A.reviewBadgeText({ ...c, flagged: 1 }), '1 looks wrong');
    const lines = A.clearRaceText(view('g', { review: { pinned: 2, madeUp: 3 }, splits: [] }));
    assert.equal(lines.at(-1), "Your Review changes to 2 runners' passes (Move, Not a split, finish) stay: they apply again when RR12 replays the same reads. The 3 made-up and typed times are forgotten: fill them in again in Review after the Replay.");
    assert.equal(A.clearRaceText(view('g', { review: {}, splits: [] })).length, 2);
  });

  test('a real Split Relay\'s runner view: the cells, the passes with what each change would do, the changes', () => {
    let now = Date.UTC(2026, 9, 18, 14, 0, 0);
    const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
    const cfg = { version: 1, filter: { tagWindowSec: 10, holdSec: 0, startIgnoreSec: 60 }, races: [{ ...R3(), name: 'Girls 5K' }],
      outputs: [{ id: 'o_ts', name: 'TrackScore', enabled: true, races: [] }] };
    const e = new Engine({ getConfig: () => cfg, clock, autoStart: false, deliver: (id, p, ack) => { ack(true); return true; } });
    e.start();
    const pass = (bib, sec) => e.handleRead({ location: '', bib: String(bib), tod: tod(10, 0, 0) + Math.round(sec * T9), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
    for (let k = 1; k <= 3; k++) for (let i = 0; i < 12; i++) if (!(i === 5 && k === 2)) pass(100 + i, 180 * k * (1 + 0.02 * i));
    now += 5000;
    e.assign('g', { bib: '105', all: 'move' });
    const r = A.normRunner(e.runner('g', '105'), cfg.races[0]);
    assert.deepEqual(r.columns.map((c) => [c.kind, c.how, A.cellModel(c, r).sub]), [['read', 'counted', '6th'], ['missing', '', 'Suggested'], ['moved', 'moved', '6th']]);
    assert.deepEqual(r.changes.map((c) => [c.kind, c.undoable]), [['check', true]]);
    const p = r.passes.find((x) => x.timeText === '9:54.0');
    assert.deepEqual([p.inColumn, p.where, p.pinned], [true, 's3', 'move']);
    const menu = A.menuFor(r, { col: r.columns[2] });
    assert.ok(menu.items.some((x) => x.key === 'count'));
    assert.deepEqual(r.problems.map((x) => x.kind), ['missing']);
    void m;
  });
});

describe('meet setup (DESIGN 9.22)', () => {
  // local times, as the panel shows them: today is Wed 21 Oct 2026, 15:00
  const now = new Date(2026, 9, 21, 15, 0, 0).getTime();
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0).getTime();

  test('the setup checklist starts with the meet: load it, or add the races', () => {
    const steps = A.setupSteps(state());
    assert.deepEqual(steps.map((s) => s.key), ['race', 'rr12', 'outputs', 'names', 'lif']);
    assert.deepEqual([steps[0].title, steps[0].done], ['Load the meet setup, or add the races', false]);
    assert.equal(A.setupSteps(state({ races: [race('a')] }))[0].done, true);
  });

  test('parseRoute: #settings/meet', () => {
    assert.deepEqual(A.parseRoute('#settings/meet'), { tab: 'settings', id: 'meet', focus: '' });
  });

  test('pickMeetFile: the first .json, else a file the browser calls JSON', () => {
    const f = (name, type = '') => ({ name, type });
    assert.equal(A.pickMeetFile([f('a.txt'), f('Meet.JSON'), f('b.json')]).name, 'Meet.JSON');
    assert.equal(A.pickMeetFile([f('a.txt'), f('meet', 'application/json')]).name, 'meet');
    assert.equal(A.pickMeetFile([f('a.txt')]), null);
    assert.equal(A.pickMeetFile(null), null);
  });

  test('saved meets: their names and lines; the copy kept before a load', () => {
    const f = { fileName: 'Fall Classic 2026.json', name: 'Fall Classic 2026', races: 2, savedAt: new Date(at(21, 15, 2)).toISOString(), mtimeMs: at(1, 1, 1) };
    assert.equal(A.savedMeetText(f, now), '2 races · saved today 15:02');
    assert.equal(A.savedMeetText({ ...f, savedAt: null, mtimeMs: at(14, 9, 5), races: 1 }, now), '1 race · saved 14 Oct 09:05');
    assert.equal(A.savedMeetText({ fileName: 'Odd.json', error: 'not a meet file' }, now), "can't be read as a meet file");
    assert.equal(A.savedMeetName(f, now), 'Fall Classic 2026');
    assert.equal(A.savedMeetName({ fileName: 'x.json', name: '' }, now), 'x');
    assert.equal(A.savedMeetName({ beforeLoad: true, mtimeMs: at(21, 15, 2) }, now), 'Before the load at 15:02');
    assert.equal(A.savedMeetName({ beforeLoad: true, mtimeMs: at(20, 9, 1) }, now), 'Before the load yesterday at 09:01');
    assert.equal(A.savedMeetName({ beforeLoad: true, mtimeMs: at(14, 9, 1) }, now), 'Before the load on 14 Oct 09:01');
    // O23: a meet with no races is never the one-click offer
    assert.deepEqual(A.savedMeets([{ ...f, beforeLoad: true }, { fileName: 'x', error: 'x' }, { ...f, fileName: 'Empty.json', races: 0 }, f]), [f]);
  });

  test('trackScoreAt: the TrackScore output\'s host, else this PC; the web port of Settings', () => {
    assert.deepEqual(A.trackScoreAt(state()), { host: '127.0.0.1', port: 5000, outputName: null });
    const st = state({ outputs: [{ ...LIVE, script: 'C:\\Lynx\\Karmarush-Track.lss' }, { ...TRACKSCORE, host: '192.168.0.9' }] });
    st.config.meet = { trackScoreWebPort: 5080 };
    assert.deepEqual(A.trackScoreAt(st), { host: '192.168.0.9', port: 5080, outputName: 'TrackScore' });
  });

  const preview = (extra = {}) => ({
    mode: 'file', title: 'Fall Classic 2026', base: 'b', removeOthers: false, nothing: false, newMeet: null,
    source: { kind: 'file', fileName: 'Fall Classic 2026.json', savedAt: new Date(at(14, 15, 2)).toISOString(), savedOn: 'TIMING-1' },
    added: [{ kind: 'race', name: 'Boys 5K', raceId: 'r_b', text: 'Boys 5K · Event 4-1-1 · 2 splits: 1K, 2K · port 5566 · Active' }],
    changed: [{ kind: 'race', name: 'Girls 5K', raceId: 'r_g', text: 'Girls 5K: split 2 2K → 2.5K' }],
    removed: [],
    kept: [{ kind: 'race', name: 'Girls 5K', raceId: 'r_g', text: 'Girls 5K keeps its 40 reads.' }],
    attention: [
      { kind: 'race', name: 'X', tone: 'bad', text: 'A conflict.', raceId: 'r_x' },
      { kind: 'note', name: '', tone: 'warn', text: 'The tag filter stays.', href: '#settings/filter' },
      { kind: 'note', name: '', tone: 'info', text: 'A note.' },
    ],
    removable: [{ id: 'r_jv', name: 'JV Race' }, { id: 'r_o', name: 'Open Race' }],
    readsPlan: { moves: [], deleted: [], setAside: [], usedAgain: [], kept: [], newReads: [] },
    ...extra,
  });

  test('meetPreviewView: the head, the sections in order with their words and links, the remove box, the buttons', () => {
    const v = A.meetPreviewView(preview(), { now });
    assert.equal(v.title, 'Load meet: Fall Classic 2026');
    assert.equal(v.sourceLine, 'From Fall Classic 2026.json · saved Wed 14 Oct 15:02 on TIMING-1');
    assert.equal(v.banner, '');
    assert.deepEqual(v.sections.map((s) => [s.key, s.title, s.lines.length]), [['attention', 'Needs your attention', 3], ['added', 'Added', 1], ['changed', 'Changed', 1], ['kept', 'Left as they are', 1]]);
    assert.deepEqual(v.sections[0].lines.map((l) => [l.word, l.tone, l.raceId, l.href]), [['Problem', 'bad', 'r_x', ''], ['Check', 'warn', '', '#settings/filter'], ['Note', 'info', '', '']]);
    assert.equal(v.removeLabel, 'Also remove 2 races that are not in the file and have no reads: JV Race and Open Race');
    assert.deepEqual([v.applyLabel, v.nothingLine], ['Apply', '']);
    assert.equal(v.footer, 'Nothing is sent to TrackScore or the live results by this. Gun times are never loaded: you type them on race day.');
    // this page's own notes come first; removed races show under Changed
    const w = A.meetPreviewView(preview({ removed: [{ kind: 'race', name: 'JV Race', raceId: 'r_jv', text: 'JV Race is removed (it has no reads).' }], removeOthers: true }),
      { now, notes: [{ tone: 'info', text: 'You have unsaved changes to Girls 5K.' }] });
    assert.equal(w.sections[0].lines[0].text, 'You have unsaved changes to Girls 5K.');
    assert.deepEqual(w.sections.find((s) => s.key === 'changed').lines.map((l) => l.text), ['Girls 5K: split 2 2K → 2.5K', 'JV Race is removed (it has no reads).']);
    // the reads so far, when they move
    const r = A.meetPreviewView(preview({ readsPlan: { moves: [{ contest: 'Port 5566', count: 3, from: { raceId: null, status: 'no-race' }, to: { raceId: 'r_b', raceName: 'Boys 5K', active: true } }] } }), { now });
    assert.deepEqual(r.sections.find((s) => s.key === 'reads').lines.map((l) => l.text), A.planLines(r.sections && preview({ readsPlan: { moves: [{ contest: 'Port 5566', count: 3,
      from: { raceId: null, status: 'no-race' }, to: { raceId: 'r_b', raceName: 'Boys 5K', active: true } }] } }).readsPlan, ''));
    assert.match(r.sections.find((s) => s.key === 'reads').lines[0].text, /^3 reads .* go to Boys 5K\.$/);
    assert.equal(r.sections.map((s) => s.key).join(','), 'attention,added,changed,reads,kept');
  });

  test('meetPreviewView: TrackScore, a saved file, config.json, nothing to change, reads from an earlier day', () => {
    const ts = A.meetPreviewView(preview({ mode: 'trackscore', source: { kind: 'trackscore', host: '127.0.0.1', port: 5000, meetName: 'Fall Classic', races: 2, liveRace: "Women's Race" } }), { now });
    assert.equal(ts.title, 'Set up from TrackScore');
    assert.equal(ts.sourceLine, 'TrackScore at 127.0.0.1:5000 · meet "Fall Classic" · 2 races in Race Setup · showing Women\'s Race now');
    assert.equal(ts.removeLabel, "Also remove 2 races that are not in TrackScore's meet and have no reads: JV Race and Open Race");
    assert.equal(A.meetPreviewView(preview({ mode: 'trackscore', source: { kind: 'trackscore', host: 'h', port: 1, meetId: 'm-1', races: 1, liveRace: null } }), { now }).sourceLine,
      'TrackScore at h:1 · meet m-1 · 1 race in Race Setup · not showing a race now');
    assert.equal(A.meetPreviewView(preview({ source: { kind: 'saved', fileName: 'before-load/2026-10-21-150200.json' } }), { now }).sourceLine, 'From data\\meets\\before-load\\2026-10-21-150200.json');
    assert.equal(A.meetPreviewView(preview({ source: { kind: 'config', fileName: 'config.json' } }), { now }).sourceLine, 'From config.json (a Split Relay settings file)');
    // O2: the copy kept before a load is named as the list names it, and Apply says what it is
    const undo = A.meetPreviewView(preview({ undo: true, source: { kind: 'saved', fileName: 'before-load/2026-10-21-125217.json', beforeLoad: true,
      savedAt: new Date(at(21, 12, 52)).toISOString() } }), { now });
    assert.deepEqual([undo.title, undo.removeLabel], ['Back to the setup before the load at 12:52',
      'Also remove 2 races that are not in that copy and have no reads: JV Race and Open Race']);
    // O14: TrackScore could not show it is this meet: Apply is not the gold button
    assert.equal(ts.applyPrimary, true);
    assert.equal(A.meetPreviewView(preview({ mode: 'trackscore', source: { kind: 'trackscore', host: 'h', port: 1, races: 1, confirmed: false } }), { now }).applyPrimary, false);
    const none = A.meetPreviewView(preview({ nothing: true, added: [], changed: [], removable: [] }), { now });
    assert.deepEqual([none.nothingLine, none.removeLabel], ['Nothing to change: the setup already matches Fall Classic 2026.', '']);
    const old = A.meetPreviewView(preview({ newMeet: { races: [{ id: 'r_w', name: 'Womens Race', reads: 412, lastReadAt: at(14, 16, 41) }, { id: 'r_m', name: 'Mens Race', reads: 380 }], noRace: 37 } }), { now });
    assert.equal(old.banner, 'Races here have reads from an earlier day: Womens Race (412 reads, last read Wed 14 Oct), Mens Race (380) and 37 reads in no race. ' +
      "RR12's reads carry a time of day but no date: once today's gun is typed, they would count as today's splits. A new meet should start empty: start a new meet first, then this preview shows the whole meet.");
    assert.deepEqual([old.applyLabel, old.applyPrimary], ['Apply anyway (keep the old reads)', false]);
  });

  test('meetAppliedText', () => {
    assert.deepEqual(A.meetAppliedText({ name: 'Fall Classic 2026', mode: 'file', added: 2, changed: 1, removed: 0, outputsAdded: 0, outputsOff: [] }, now),
      { text: 'Fall Classic 2026 loaded: 2 races added, 1 changed. Nothing was sent.', tone: 'ok' });
    assert.equal(A.meetAppliedText({ mode: 'trackscore', added: 2, changed: 1, removed: 2 }, now).text, 'Races set up from TrackScore: 2 added, 1 changed, 2 removed. Nothing was sent.');
    assert.equal(A.meetAppliedText({ name: 'F', mode: 'file', added: 1, outputsAdded: 1, changed: 0, outputsOff: ['Karmarush'], beforeLoad: { at: at(21, 15, 2) } }, now).text,
      'F loaded: 1 race added, 1 output added. Nothing was sent. Karmarush came in switched off: switch it on in Outputs when you mean to. ' +
      'The setup before this load is saved (Settings → Meet setup → Before the load at 15:02).');
    // O27: races, outputs and settings apart; the meet name is not a race. O5: the file kept for next time
    assert.equal(A.meetAppliedText({ mode: 'trackscore', added: 0, changed: 3, racesChanged: 2, outputsChanged: 0, settings: ['Meet name'], removed: 0 }, now).text,
      'Races set up from TrackScore: 2 changed. The meet name is set. Nothing was sent.');
    assert.equal(A.meetAppliedText({ name: 'Fall', mode: 'file', added: 2, changed: 3, racesChanged: 1, outputsAdded: 1, outputsChanged: 1, settings: ['Tag filter'],
      removed: 0, outputsOff: [], keptAs: 'Fall.json' }, now).text,
    'Fall loaded: 2 races added, 1 race changed, 1 output added, 1 output changed. Settings changed: Tag filter. Nothing was sent. ' +
      'It is kept in data\\meets as Fall.json: next time it is one click.');
    assert.deepEqual(A.meetAppliedText({ nothing: true, name: 'Fall Classic 2026', mode: 'file' }, now), { text: 'The setup already matches Fall Classic 2026.', tone: 'info' });
  });

  test('newMeetText: what is put away, what stays, what still matters; red when a read came in the last 10 minutes', () => {
    const st = state({ races: [race('w', { name: 'Womens Race' }), race('m', { name: 'Mens Race' })], views: [
      view('w', { name: 'Womens Race', lastReadAt: at(21, 14, 41), contestsSeen: [{ name: 'Port 5565', count: 1000 }] }),
      view('m', { name: 'Mens Race', lastReadAt: at(21, 11, 2), contestsSeen: [{ name: 'Port 5565', count: 200 }] }),
    ], outputs: [{ ...LIVE, name: 'Karmarush', mid: '8132' }] });
    st.noRace = [{ count: 4 }];
    st.config.lif = { enabled: true, inputDir: 'C:\\Lynx\\Meet', outputDir: 'C:\\Merged' };
    assert.deepEqual(A.newMeetText(st, now), [
      'Split Relay puts away the reads of every race (2 races, 1,204 reads, the last today at 14:41) and clears every gun time and every Pause. The races, outputs and settings stay.',
      'A copy of the data folder goes to data\\archive first. Nothing is deleted, and nothing is sent to TrackScore or the live results.',
      "FinishLynx's folder C:\\Lynx\\Meet stays. If it still has last meet's results, their finishers get no splits today: point it at this meet's folder (Settings → Merged .lif files).",
      "Check Karmarush's meet number (MID) for the new meet (Outputs).",
      "The merged .lif files already written stay as they are (copies go to the archive too). Once FinishLynx writes this meet's files, they are merged with this meet's splits only.",
      'The reads stay in data\\reads.jsonl, out of use, as after Clear race data. An RR12 Replay of an old race would bring its reads back.',
    ]);
    assert.equal(A.newMeetRecent(st, now), '');
    assert.equal(A.newMeetRecent(st, at(21, 14, 43)), "A read came in 2 minutes ago (Womens Race). If a race is running, don't start a new meet now.");
    const empty = state({ races: [race('w')], views: [view('w')] });
    assert.equal(A.newMeetText(empty, now)[0], 'No race has reads. Split Relay clears every gun time and every Pause. The races, outputs and settings stay.');
  });

  test('newMeetBlocker: a running race is said at once, in Split Relay\'s words, never asked first and refused after (O7, O19, O28)', () => {
    const tod = (h, m) => ((h * 60 + m) * 60) * 10000;
    const st = (gun, lastReadAt, active = true) => {
      const x = state({ races: [race('w', { name: 'Womens Race', gun, active })], views: [view('w', { name: 'Womens Race', gunTicks: gun ? tod(14, 30) : null, lastReadAt })] });
      x.now = now;
      return x;
    };
    // 15:00: a gun at 14:30 with no read is exactly 30 minutes old: over
    assert.equal(A.newMeetBlocker(st('14:30:00.000', null), now), '');
    assert.equal(A.newMeetBlocker(st('14:30:00.000', null), at(21, 14, 30) + 30_000),
      'Womens Race is running (gun 14:30:00.000). Start a new meet once it is over, or turn off its Active (on its page) first.');
    assert.equal(A.newMeetBlocker(st('14:30:00.000', at(21, 14, 52)), now),
      'Womens Race is running (last read 14:52). Start a new meet once it is over, or turn off its Active (on its page) first.');
    assert.equal(A.newMeetBlocker(st('14:30:00.000', at(21, 14, 52), false), now), '', 'not Active');
    assert.equal(A.newMeetBlocker(st('', at(21, 14, 52)), now), '', 'no gun');
  });

  test('validateInputPorts: a new port that TrackScore or an output on this PC uses is refused; one there already stays (O18)', () => {
    const outputs = [{ name: 'TrackScore', mode: 'tcp-client', host: '127.0.0.1', port: 5903 }, { name: 'Live', mode: 'tcp-client', host: '10.0.0.9', port: 5904 }];
    assert.deepEqual(A.validateInputPorts(['5565', '5555', '4560', '5903', '5904'], { outputs, current: [5565] }), [
      "Port 5555 is where TrackScore takes the splits: Split Relay can't listen for RR12 there. Choose another one.",
      "Port 4560 is one of TrackScore's timing ports: Split Relay can't listen for RR12 there. Choose another one.",
      'Port 5903 is where the output “TrackScore” sends its splits on this PC. Choose another one for RR12.',
    ]);
    assert.deepEqual(A.validateInputPorts(['5555'], { outputs, current: [5555] }), [], 'a setup that has it keeps it');
    assert.deepEqual(A.validateInputPorts(['5000'], { current: [], webPort: 5000 }),
      ["Port 5000 is TrackScore's web page (Settings → Meet setup): Split Relay can't listen for RR12 there. Choose another one."]);
  });

  test('jsonErrorWhere: the line and column of a hand-edit that broke the JSON', () => {
    const text = '{\n  "splitRelayMeet": 1,\n  "races": [}\n';
    let err;
    try { JSON.parse(text); } catch (e) { err = e; }
    assert.equal(A.jsonErrorWhere(text, err), 'line 3, column 13');
    assert.equal(A.jsonErrorWhere('x', { message: 'Unexpected token' }), '');
    assert.equal(A.jsonErrorWhere('ab\ncd', { message: 'at position 4' }), 'line 2, column 2');
  });
});

describe('meet setup: what the re-check found (DESIGN 9.22, O33-O37)', () => {
  // local times, as the panel shows them: today is Wed 21 Oct 2026, 15:00
  const now = new Date(2026, 9, 21, 15, 0, 0).getTime();
  const at = (d, h, m) => new Date(2026, 9, d, h, m, 0).getTime();
  const undoPreview = (extra = {}) => ({
    mode: 'file', title: 'Fall XC Invitational', base: 'b', removeOthers: false, nothing: true, newMeet: null, undo: true,
    source: { kind: 'saved', fileName: 'before-load/2026-10-21-140200.json', beforeLoad: true, savedAt: new Date(at(21, 14, 2)).toISOString() },
    added: [], changed: [], removed: [], kept: [], attention: [], readsPlan: null,
    removable: [{ id: 'r_jv', name: 'JV Race' }, { id: 'r_o', name: 'Open Race' }],
    leftover: { races: ['JV Race', 'Open Race'], outputs: ['Loop'], ports: [5925] },
    ...extra,
  });

  test('O33: the copy kept before a load never says "Nothing to change" while what the load added is there; it offers the box, then Apply', () => {
    const v = A.meetPreviewView(undoPreview(), { now });
    assert.equal(v.title, 'Back to the setup before the load at 14:02');
    assert.equal(v.nothingLine, 'The setup is not as it was before the load at 14:02: what the load added is still here ' +
      '(JV Race, Open Race, the output Loop and RR12 port 5925). Tick the box above to remove the races with no reads, then Apply.');
    assert.equal(v.removeLabel, 'Also remove 2 races that are not in that copy and have no reads: JV Race and Open Race');
    // Apply is there, waiting for the box; Cancel, not Close
    assert.deepEqual([v.applyShown, v.applyDisabled, v.cancelLabel, v.nothingTone], [true, true, 'Cancel', 'warn']);
    // the box ticked: the races go, Apply is live
    const ticked = A.meetPreviewView(undoPreview({ nothing: false, removeOthers: true, removed: [{ kind: 'race', name: 'JV Race', text: 'JV Race is removed (it has no reads).' }],
      leftover: { races: [], outputs: ['Loop'], ports: [5925] } }), { now });
    assert.deepEqual([ticked.nothingLine, ticked.applyShown, ticked.applyDisabled, ticked.cancelLabel], ['', true, false, 'Cancel']);
    // what is left can't be removed here (a race with reads, an output, a port): said, and nothing to apply
    const kept = A.meetPreviewView(undoPreview({ removable: [], leftover: { races: ['Boys 5K'], outputs: ['Loop', 'Board'], ports: [] } }), { now });
    assert.equal(kept.nothingLine, 'The setup is not as it was before the load at 14:02: what the load added is still here ' +
      '(Boys 5K and the outputs Loop and Board). Putting that copy back does not remove it: see above.');
    assert.deepEqual([kept.applyShown, kept.cancelLabel, kept.removeLabel], [false, 'Close', '']);
    // nothing left over: it is as it was
    const same = A.meetPreviewView(undoPreview({ removable: [], leftover: null }), { now });
    assert.deepEqual([same.nothingLine, same.nothingTone, same.applyShown, same.cancelLabel],
      ['Nothing to change: the setup is already as it was before the load at 14:02.', 'info', false, 'Close']);
    // a meet file with nothing to change is as before
    const file = A.meetPreviewView(undoPreview({ undo: false, source: { kind: 'file', fileName: 'Fall XC Invitational.json' }, leftover: undefined, removable: [] }), { now });
    assert.deepEqual([file.nothingLine, file.applyShown, file.cancelLabel], ['Nothing to change: the setup already matches Fall XC Invitational.', false, 'Close']);
  });

  test('O33: the toast after the copy kept before a load says the setup was put back, not that the meet was loaded', () => {
    const a = { name: 'Fall XC Invitational', mode: 'file', undo: { at: at(21, 14, 2) }, added: 0, changed: 0, racesChanged: 0, outputsAdded: 0, outputsChanged: 0,
      settings: [], removed: 2, outputsOff: [], keptAs: null, beforeLoad: { fileName: 'before-load/2026-10-21-150000.json', at: at(21, 15, 0) } };
    assert.deepEqual(A.meetAppliedText(a, now), { tone: 'ok', text: 'Setup put back to before the load at 14:02: 2 races removed. Nothing was sent. ' +
      'The setup before this load is saved (Settings → Meet setup → Before the load at 15:00).' });
    assert.equal(A.meetAppliedText({ ...a, undo: { at: at(20, 9, 1) } }, now).text.split('.')[0], 'Setup put back to before the load yesterday at 09:01: 2 races removed');
    assert.deepEqual(A.meetAppliedText({ nothing: true, name: 'Fall XC Invitational', mode: 'file', undo: { at: at(21, 14, 2) } }, now),
      { tone: 'info', text: 'Nothing to put back: the setup is already as it was before the load at 14:02.' });
    assert.equal(A.meetAppliedText({ ...a, undo: undefined }, now).text.split('.')[0], 'Fall XC Invitational loaded: 2 races removed');
  });

  test('O35: Save meet setup names what was wrong in Settings → Meet setup, never "the meet name" for a wrong web port', () => {
    const port = "Port 5555 is where TrackScore takes the splits, not its web page. TrackScore's web page is usually on port 5000.";
    assert.equal(A.meetSettingsNotSavedText([port]),
      `The meet settings were not saved: ${port} The meet file was not saved either. See Settings → Meet setup.`);
    assert.doesNotMatch(A.meetSettingsNotSavedText([port]), /meet name/);
    assert.equal(A.meetSettingsNotSavedText(['Keep the meet name to 80 characters.', "TrackScore's web port must be a number"]),
      "The meet settings were not saved: Keep the meet name to 80 characters. TrackScore's web port must be a number. The meet file was not saved either. " +
      'See Settings → Meet setup.');
    assert.equal(A.meetSettingsNotSavedText([]), 'The meet settings were not saved, so the meet file was not either. See Settings → Meet setup.');
  });

  test('O36: TrackScore\'s boards on a race not in the list it sent: the source line says so, as the Problem line below does', () => {
    const point = (label) => ({ label, distance: label });
    const ts = trackScoreToMeet({ raceSnap: { meetId: 'm', config: { scheduledRaceId: 'xcr-old', raceName: "Women's Race" } },
      schedule: { races: [{ id: 'a', name: "Men's Race", filterEventNumber: '1', splitPoints: [point('1K')] },
        { id: 'b', name: "Women's Race", filterEventNumber: '2', splitPoints: [point('1K')] }], activeRaceId: 'xcr-old' },
      meetName: 'Fall XC Invitational', meetId: 'm', host: '127.0.0.1', port: 5000 });
    const v = A.meetPreviewView({ mode: 'trackscore', source: ts.source, attention: ts.notes, added: [], changed: [], kept: [], removable: [], nothing: false }, { now });
    assert.equal(v.sourceLine, 'TrackScore at 127.0.0.1:5000 · meet "Fall XC Invitational" · 2 races in Race Setup · showing "Women\'s Race", not in this list');
    assert.match(v.sections[0].lines[0].text, /^TrackScore's boards show "Women's Race", which is not in the races TrackScore sent/);
    assert.equal(v.applyPrimary, false);
    const unnamed = A.meetPreviewView({ mode: 'trackscore', source: { kind: 'trackscore', host: 'h', port: 1, races: 2, confirmed: false, shownElsewhere: '' } }, { now });
    assert.match(unnamed.sourceLine, / · showing a race not in this list$/);
    // not showing any race: as before
    const none = A.meetPreviewView({ mode: 'trackscore', source: { kind: 'trackscore', host: 'h', port: 1, races: 2, confirmed: false, liveRace: null } }, { now });
    assert.match(none.sourceLine, / · not showing a race now$/);
  });

  test('O37: the panel calls a race running exactly when Split Relay does (public/running.js), so the Races list never offers a load under one', () => {
    const cases = [];
    for (const gun of ['', '14:58:00.000', '14:20:00.000', '16:28:00.455', '23:59:00.000']) {
      for (const last of [null, at(21, 14, 59), at(21, 14, 30), at(21, 15, 1), at(20, 14, 59)]) {
        for (const active of [true, false]) for (const withView of [true, false]) cases.push({ gun, last, active, withView });
      }
    }
    for (const c of cases) {
      const r = race('w', { name: 'Womens Race', gun: c.gun, active: c.active });
      const v = c.withView ? view('w', { gunTicks: A.parseGunText(c.gun), gunText: c.gun, lastReadAt: c.last }) : null;
      const st = state({ races: [r], views: v ? [v] : [] });
      st.now = now;
      assert.equal(A.isRunning(v, r, st, now), serverRaceRunning(r, v ? c.last : null, now), JSON.stringify(c));
    }
    // with the clock the server sends (elapsedTicks), the same
    const r = race('w', { name: 'Womens Race', gun: '16:28:00.455' });
    const v = view('w', { gunTicks: A.parseGunText('16:28:00.455'), gunText: '16:28:00.455', lastReadAt: at(21, 14, 55),
      elapsedTicks: A.raceTicks(A.parseGunText('15:00:00.000'), A.parseGunText('16:28:00.455')) });
    const st = state({ races: [r], views: [v] });
    st.now = now;
    assert.ok(v.elapsedTicks < 0, 'a gun later in the day than now: an earlier day\'s');
    // reads still arriving under it: running, here as there (the Races list offered Load meet file before)
    assert.equal(A.isRunning(v, r, st, now), true);
    assert.equal(serverRaceRunning(r, v.lastReadAt, now), true);
    assert.equal(A.newMeetBlocker(st, now), 'Womens Race is running (last read 14:55). Start a new meet once it is over, or turn off its Active (on its page) first.');
    // 25 minutes after its last read: not running, here as there
    assert.equal(A.isRunning(v, r, st, at(21, 15, 20)), false);
    assert.equal(A.newMeetBlocker(st, at(21, 15, 20)), '');
  });
});

describe('too fast to be real, Stop sending this runner, the boards put right (DESIGN 9.24)', () => {
  test('Needs attention names a race\'s runner with a split too fast to be real, and leads to Review', () => {
    assert.equal(A.tooFastWarning({ review: { flagged: 2, fast: 0 } }, 'r1'), null);
    assert.equal(A.tooFastWarning({ review: { flagged: 2 } }, 'r1'), null);
    const one = A.tooFastWarning({ review: { flagged: 1, fast: 1, fastBibs: ['142'] } }, 'r 1');
    assert.deepEqual([one.tone, one.title, one.action], ['warn', 'Bib 142: a split too fast to be real', { label: 'Open Review', href: '#review/r%201' }]);
    assert.match(one.text, /^Bib 142 has a split that came sooner after the split before than the leaders ran that stretch.* It went out as it is\. In Review, Splits that look wrong: Not a split takes it back, Stop sending this runner keeps the runner off the boards, It's right leaves it\.$/);
    const many = A.tooFastWarning({ review: { flagged: 6, fast: 6, fastBibs: ['142', '161', '178', '213'] } }, 'r1');
    assert.equal(many.title, '6 runners: a split too fast to be real');
    assert.match(many.text, /^6 runners \(bibs 142, 161, 178 and 213 and more\) have a split/);
    // it is one of the race's rows on the Dashboard, and the counts carry it only when there is one
    assert.deepEqual(A.reviewCounts({ review: { flagged: 1, fast: 1, fastBibs: ['142'] } }).fastBibs, ['142']);
    assert.equal('fast' in A.reviewCounts({ review: { flagged: 1 } }), false);
    const st = { config: { races: [{ id: 'r1', name: 'Women 6K', active: true, splits: [{ id: 's1', name: '1K', sources: [] }], inputPort: 5565 }], outputs: [], inputs: { ports: [5565] }, filter: {} },
      races: [{ id: 'r1', gunTicks: 1, review: { flagged: 1, fast: 1, fastBibs: ['142'] } }], inputs: [{ port: 5565, listening: true, connections: [{}] }], outputs: [] };
    const row = A.raceWarnings(st.races[0], st.config.races[0], st, Date.now()).find((w) => w.id === 'too-fast');
    assert.equal(row.title, 'Bib 142: a split too fast to be real');
    assert.equal(A.reviewBadgeText(A.reviewCounts(st.races[0])), '1 looks wrong');
    assert.equal(A.reviewTone(A.reviewCounts(st.races[0])), 'warn');
  });

  test('the Review row of a runner with two splits too fast to be real: its passes, and the choices', () => {
    const cfg = { splits: [{ id: 's5', name: '4.4K' }, { id: 's6', name: '5K' }] };
    const text = 'Bib 142, 4.4K 15:36.4: 3:01.7 after 3.4K, where the leaders took 3:21; 5K 17:06.3: 1:29.9 after 4.4K, where the leaders took 2:09. Too fast for a runner who was 74th: not splits?';
    const d = A.normReview({ flags: [{ bib: '142', splitId: 's5', splitName: '4.4K and 5K', passTod: 405340080, raceTicks: 9363833, kind: 'fast', suggest: { to: 'none', toName: 'Not a split', missed: [] }, text,
      passes: [{ splitId: 's5', splitName: '4.4K', passTod: 405340080, timeText: '15:36.4' }, { splitId: 's6', splitName: '5K', passTod: 406239080, timeText: '17:06.3' }] }],
    off: [{ bib: '150', name: '', team: '', fromText: '12:00.0', held: [{ splitName: '4.4K', timeText: '16:01.0' }] }] }, cfg);
    const f = d.flags[0];
    assert.deepEqual([f.kind, f.text, f.suggest.to, f.passes.map((p) => [p.splitName, p.passTod])], ['fast', text, 'none', [['4.4K', 405340080], ['5K', 406239080]]]);
    assert.deepEqual(A.flagChoices(f), [{ label: 'Not a split', to: 'none', primary: true }]);
    // (the mark of a time that follows one set aside has no one click: Not a split is a plain choice)
    assert.deepEqual(A.flagChoices({ kind: 'fast', suggest: null }), [{ label: 'Not a split', to: 'none', primary: false }]);
    assert.deepEqual(d.off, [{ bib: '150', name: '', team: '', key: '150', fromText: '12:00.0', words: 'from 12:00.0 on', held: [{ splitName: '4.4K', timeText: '16:01.0' }] }]);
    assert.equal('off' in A.normReview({ flags: [] }, cfg), false);
    assert.equal('passes' in A.normReview({ flags: [{ bib: '1', splitId: 's5', kind: 'long', text: 'x' }] }, cfg).flags[0], false);
  });

  test('the runner editor: a stopped runner\'s cells say Not sending; a too-fast mark\'s choices act on both times; Stop sending this runner is in the menu', () => {
    const cfg = { splits: [{ id: 's1', name: '3.4K' }, { id: 's2', name: '4.4K' }, { id: 's3', name: '5K' }] };
    const flag = (also, first) => ({ kind: 'fast', text: 'Bib 142, 4.4K 15:36.4: …', suggest: { to: 'none', toName: 'Not a split', missed: [] }, silenced: false, also, first });
    const raw = { bib: '142', found: true, columns: [
      { splitId: 's1', splitName: '3.4K', time: 7546840, place: 74, kind: 'read', how: 'counted', passTod: 1, held: null },
      { splitId: 's2', splitName: '4.4K', time: 9363833, place: 33, kind: 'read', how: 'counted', passTod: 2, held: null, flag: flag([3], true) },
      { splitId: 's3', splitName: '5K', time: 10262833, place: 6, kind: 'read', how: 'counted', passTod: 3, held: null, flag: flag([2], false) }],
    passes: [1, 2, 3].map((tod, i) => ({ tod, raceTicks: [7546840, 9363833, 10262833][i], how: 'counted', inColumn: true, where: `s${i + 1}`, splitId: `s${i + 1}`, targets: [], only: [], finishOk: { ok: true } })),
    sending: { off: null, stop: { fromText: '15:36.4', text: 'Nothing of bib 142 from 15:36.4 on goes out: 4.4K and 5K are taken back.' } }, problems: [{ kind: 'flag', col: 1, text: 'Bib 142, 4.4K 15:36.4: …' }] };
    const v = A.normRunner(raw, cfg);
    assert.deepEqual([v.columns[1].flag.kind, v.columns[1].flag.also, v.columns[2].flag.also, v.sending.stop.fromText, v.sending.off], ['fast', [3], [2], '15:36.4', null]);
    assert.equal(A.cellModel(v.columns[1], v).flag, 'flag');
    assert.equal(A.cellModel(v.columns[2], v).flag, 'flag');
    const menu = A.menuFor(v, { col: v.columns[1] });
    const item = (key) => menu.items.find((x) => x.key === key);
    assert.deepEqual([item('sug').label, item('sug').primary, item('sug').act, item('keep').act, item('stop').label, item('stop').act],
      ['Not a split', true, { kind: 'move', to: 'none', also: [3] }, { kind: 'move', to: 'keep', also: [3] }, 'Stop sending this runner', { kind: 'stop' }]);
    // stopped: the cells from then on, the words, no Stop in the menu
    const off = A.normRunner({ ...raw, columns: raw.columns.map((c, i) => (i ? { ...c, held: 'stopped', flag: null } : c)), problems: [],
      sending: { off: { fromText: '15:36.4', text: 'Not sending bib 142: nothing from 15:36.4 on goes out (4.4K and 5K wait).' }, stop: null } }, cfg);
    assert.deepEqual(off.columns.map((c) => c.status), ['', 'not-sending', 'not-sending']);
    const m = A.cellModel(off.columns[1], off);
    assert.deepEqual([m.chip, m.tone], [{ text: 'Not sending', tone: 'muted' }, '']);
    assert.match(m.aria, /, not sending$/);
    assert.match(A.cellModel(off.columns[1], off, null, { editor: true }).info, /^4\.4K 15:36\.4: read and counted, not sent: you stopped sending bib 142\. Send this runner again \(above\) puts it back\.$/);
    assert.equal(A.menuFor(off, { col: off.columns[1] }).items.some((x) => x.key === 'stop'), false);
    // the feed's word for such a pass, and the server's sentence
    assert.ok(A.STATUS_ORDER.includes('not-sending'));
    assert.deepEqual([A.statusInfo('not-sending').label, A.SHORT_STATUS['not-sending']], ['Not sending', 'Not sending']);
    assert.match(SERVER_STOPPED_TEXT, /^Not sending this runner: you stopped it in Review\./);
  });

  test('the toast after a change: what was taken back, the other runners\' lines that went out again by themselves, a clearing line', () => {
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true };
    const none = { fix: 7, kind: 'none', text: '15:36.4 and 17:06.3 are not splits now', bibs: ['142'], cells: [{ splitName: '4.4K', before: '15:36.4', after: '' }, { splitName: '5K', before: '17:06.3', after: '' }],
      leftover: [{ bib: '142', splitName: '4.4K', text: '15:36.4' }, { bib: '142', splitName: '5K', text: '17:06.3' }], sentTo: ['TrackScore', 'Karmarush'], notLive: [], staleOthers: 0, staleOutputs: [],
      resent: { lines: 127, outputs: ['TrackScore', 'Karmarush'] }, cleared: { lines: 0, outputs: [] }, undoable: true, notes: [] };
    assert.equal(A.fixToast(none, dest), 'Bib 142: 15:36.4 and 17:06.3 are not splits now. Sent to TrackScore and Karmarush, and into the merged .lif file. '
      + '4.4K and 5K are empty: TrackScore and Karmarush still show 15:36.4 and 17:06.3 there until you fill them. 127 lines of other runners re-sent with their new places.');
    assert.equal(A.resentText({ resent: { lines: 1 } }), '1 line of other runners re-sent with its new place.');
    assert.equal(A.resentText({ resent: { lines: 0 } }), '');
    assert.equal(A.resentText({}), '');
    const stop = { fix: 8, kind: 'stop', text: 'Not sent from 15:36.4 on (4.4K and 5K taken back)', bibs: ['142'], cells: [], leftover: [{ bib: '142', splitName: '4.4K', text: '15:36.4', stopped: true }, { bib: '142', splitName: '5K', text: '17:06.3', stopped: true }],
      sentTo: ['TrackScore', 'Karmarush'], notLive: [], staleOthers: 0, staleOutputs: [], resent: { lines: 51, outputs: ['TrackScore', 'Karmarush'] }, cleared: { lines: 2, outputs: ['Board'] }, undoable: true, notes: [] };
    assert.equal(A.fixToast(stop, dest), 'Bib 142: Not sent from 15:36.4 on (4.4K and 5K taken back). '
      + "TrackScore and Karmarush still show 15:36.4 and 17:06.3 there: a packet can't empty a cell. A clearing line went to Board. 51 lines of other runners re-sent with their new places.");
    // a change that moved nobody else's place says nothing more than before
    assert.equal(A.fixToast({ ...none, leftover: [], resent: { lines: 0, outputs: [] } }, dest), 'Bib 142: 15:36.4 and 17:06.3 are not splits now. Sent to TrackScore and Karmarush, and into the merged .lif file.');
    // the Outputs form's setting: off unless ticked, sent as it is
    assert.equal(A.outputToDraft({ name: 'TrackScore' }).clearLines, false);
    assert.equal(A.outputToDraft({ name: 'Board', clearLines: true }).clearLines, true);
    assert.equal(A.outputBody(A.outputToDraft({ name: 'Board', port: 6000, clearLines: true })).clearLines, true);
    assert.match(A.CLEAR_LINE_HELP, /empty time and place.*TrackScore ignores such a row today/);
  });
});

describe('start lists and the athletes of other races (DESIGN 9.25)', () => {
  test('the counts carry who is not in the race only when there is somebody; the badge, Needs attention, the start list that is not used', () => {
    const plain = A.reviewCounts({ review: { flagged: 1 } });
    for (const k of ['strange', 'strangeBibs', 'strangeText', 'away', 'unlisted']) assert.equal(k in plain, false, k);
    const rv = { id: 'r1', gunTicks: 1, review: { flagged: 0, checks: 1, strange: 2, strangeBibs: ['33', '213'], strangeText: 'Bib 33 ran in Boys 2A today: not in this race?', away: 3, unlisted: 1 } };
    const c = A.reviewCounts(rv);
    assert.deepEqual([c.strange, c.strangeBibs, c.strangeText, c.away, c.unlisted], [2, ['33', '213'], 'Bib 33 ran in Boys 2A today: not in this race?', 3, 1]);
    assert.equal(A.reviewBadgeText(c), '1 to check · 2 not in this race?');
    assert.equal(A.reviewTone(A.reviewCounts({ review: { strange: 1 } })), 'warn');
    assert.equal(A.reviewTone(A.reviewCounts({ review: { away: 22, unlisted: 1 } })), 'muted', 'kept off the boards, on no list: nothing to alarm');
    // one runner: its own sentence is the title
    assert.equal(A.strangerWarning({ review: { flagged: 2 } }, 'r1'), null);
    const one = A.strangerWarning({ review: { strange: 1, strangeBibs: ['213'], strangeText: 'Bib 213 ran in Boys 2A today: not in this race?' } }, 'r 1');
    assert.deepEqual([one.tone, one.title, one.action], ['warn', 'Bib 213 ran in Boys 2A today: not in this race?', { label: 'Open Review', href: '#review/r%201' }]);
    assert.equal(one.text, "Bib 213 is entered in another race, or ran one today, and was read in this one. Its splits went out like any runner's. In Review, Not in this race takes them back and puts the other runners' places right; It's right leaves them.");
    const many = A.strangerWarning({ review: { strange: 6, strangeBibs: ['44', '48', '189', '191'] } }, 'r1');
    assert.equal(many.title, '6 runners may not be in this race');
    assert.match(many.text, /^Bibs 44, 48, 189 and 191 and more are entered in another race, or ran one today, and were read in this one\. Their splits/);
    // the start list that does not fit: Split Relay's own sentence, and what follows from it
    assert.equal(A.startListWarning({ startList: { used: true, warn: null } }), null);
    assert.equal(A.startListWarning({}), null);
    const w = "The start list does not match Girls 2A (12 of 40 runners are on it): not used. Check the race's event number, or load the right file (Races tab).";
    assert.deepEqual(A.startListWarning({ startList: { used: false, warn: w } }), { tone: 'warn', id: 'start-list', title: 'The start list is not used', text: `${w} Every runner is sent as without a start list.`,
      action: { label: 'Races', href: '#races' } });
    // both are rows of the race on the Dashboard
    const st = { config: { races: [{ id: 'r1', name: 'Girls 2A', active: true, splits: [{ id: 's1', name: '1 Mile', sources: [] }], inputPort: 5565 }], outputs: [], inputs: { ports: [5565] }, filter: {} },
      races: [{ ...rv, startList: { used: false, warn: w } }], inputs: [{ port: 5565, listening: true, connections: [{}] }], outputs: [] };
    assert.deepEqual(A.raceWarnings(st.races[0], st.config.races[0], st, Date.now()).map((x) => x.id).filter(Boolean), ['not-in-race', 'start-list']);
  });

  test('Review: Not in this race, Not on the start list, the row of a runner of another race, a held pass of one', () => {
    const cfg = { splits: [{ id: 's1', name: '1 Mile' }, { id: 's2', name: '2 Mile' }] };
    const d = A.normReview({
      away: [{ bib: '213', name: '', team: '', by: 'list', why: 'entered in Boys 2A', raceName: 'Boys 2A', finished: false,
        passes: [{ splitId: 's1', splitName: '1 Mile', timeText: '3:34.1', onBoards: '3:34.1' }, { splitId: 's2', splitName: '2 Mile', timeText: '4:43.1' }] }],
      unlisted: [{ bib: '3464', name: '', team: '', passes: [{ splitId: 's1', splitName: '1 Mile', timeText: '4:18.2' }] }],
      flags: [{ bib: '243', splitId: 's1', splitName: '1 Mile', passTod: 5, raceTicks: 6280000, kind: 'stranger', suggest: null, text: 'Bib 243 ran in Boys 2A today: not in this race?',
        passes: [{ splitId: 's1', splitName: '1 Mile', passTod: 5, timeText: '10:28.0' }], stranger: { by: 'day', raceId: 'r5', raceName: 'Boys 2A' } }],
      checks: [{ bib: '33', passTod: 7, raceTicks: 8381000, from: 's1', to: 's2', reason: 'Looks like 2 Mile, not 1 Mile (missed 1 Mile?)', stranger: { raceName: 'Boys 2A', text: 'Bib 33 ran in Boys 2A today: not in this race?' } },
        { bib: '500', passTod: 8, raceTicks: 8381000, from: 's1', to: 's2', reason: 'Looks like 2 Mile, not 1 Mile (missed 1 Mile?)' }],
    }, cfg);
    assert.deepEqual(d.away, [{ bib: '213', name: '', team: '', key: '213', by: 'list', why: 'entered in Boys 2A', finished: false,
      passes: [{ splitName: '1 Mile', timeText: '3:34.1', onBoards: '3:34.1' }, { splitName: '2 Mile', timeText: '4:43.1' }] }]);
    assert.deepEqual(d.unlisted, [{ bib: '3464', name: '', team: '', key: '3464', passes: [{ splitName: '1 Mile', timeText: '4:18.2' }] }]);
    assert.deepEqual([d.flags[0].kind, d.flags[0].text, d.flags[0].stranger, d.flags[0].passes.map((p) => p.timeText)], ['stranger', 'Bib 243 ran in Boys 2A today: not in this race?', { raceName: 'Boys 2A' }, ['10:28.0']]);
    assert.deepEqual(A.flagChoices(d.flags[0]), [], 'its buttons are Not in this race and It\'s right, not a Move');
    assert.deepEqual([d.checks[0].stranger, 'stranger' in d.checks[1]], [{ text: 'Bib 33 ran in Boys 2A today: not in this race?', raceName: 'Boys 2A' }, false]);
    const none = A.normReview({ flags: [{ bib: '1', splitId: 's1', kind: 'long', text: 'x' }] }, cfg);
    assert.deepEqual(['away' in none, 'unlisted' in none, 'stranger' in none.flags[0]], [false, false, false]);
  });

  test('the runner: its cells say Not in race, the note, the toast of Not in this race', () => {
    const cfg = { splits: [{ id: 's1', name: '1 Mile' }, { id: 's2', name: '2 Mile' }] };
    const raw = { bib: '213', found: true, columns: [
      { splitId: 's1', splitName: '1 Mile', time: 2141000, place: 1, kind: 'read', how: 'counted', passTod: 1, held: 'away' },
      { splitId: 's2', splitName: '2 Mile', time: 2831000, place: 1, kind: 'read', how: 'counted', passTod: 2, held: 'away' }], passes: [],
    place: { kind: 'away', why: 'entered in Boys 2A', text: 'Not in this race (entered in Boys 2A): read and counted here, not sent, not in the merged .lif file.' } };
    const v = A.normRunner(raw, cfg);
    assert.deepEqual([v.columns.map((x) => x.status), v.place], [['not-in-race', 'not-in-race'],
      { kind: 'away', text: 'Not in this race (entered in Boys 2A): read and counted here, not sent, not in the merged .lif file.' }]);
    const m = A.cellModel(v.columns[0], v);
    assert.deepEqual([m.chip, m.info], [{ text: 'Not in race', tone: 'muted' }, '1 Mile 3:34.1: read and counted, not sent: bib 213 is not in this race. Count them here (above) sends it.']);
    assert.match(m.aria, /, not in this race/);
    assert.equal('place' in A.normRunner({ bib: '1', columns: [], passes: [] }, cfg), false);
    assert.deepEqual([A.STATUS['not-in-race'].label, A.shortStatus('not-in-race'), A.STATUS_ORDER.includes('not-in-race')], ['Not in this race', 'Not in race', true]);
    // the toast: nothing of the runner is sent; what the boards keep, and the others' places
    const dest = { outputs: ['TrackScore', 'Karmarush'], lif: true };
    const away = { fix: 4, kind: 'away', text: 'Not in this race (1 Mile and 2 Mile taken back)', bibs: ['213'], cells: [], leftover: [{ bib: '213', splitName: '1 Mile', text: '3:34.1', stopped: true, away: true },
      { bib: '213', splitName: '2 Mile', text: '4:43.1', stopped: true, away: true }], sentTo: [], notLive: [], staleOthers: 0, staleOutputs: [], resent: { lines: 83, outputs: ['TrackScore', 'Karmarush'] }, cleared: { lines: 0, outputs: [] } };
    assert.equal(A.fixToast(away, dest), "Bib 213: Not in this race (1 Mile and 2 Mile taken back). TrackScore and Karmarush still show 3:34.1 and 4:43.1 there: a packet can't empty a cell. 83 lines of other runners re-sent with their new places.");
    const here = { fix: 5, kind: 'here', text: 'Counted in this race', bibs: ['177'], cells: [], leftover: [], sentTo: ['TrackScore', 'Karmarush'], notLive: [], staleOthers: 0, staleOutputs: [], resent: { lines: 0, outputs: [] } };
    assert.equal(A.fixToast(here, dest), 'Bib 177: Counted in this race. Sent to TrackScore and Karmarush, and into the merged .lif file.');
  });

  test('the Races page: the entry files among dropped files, their text, the requests, each race\'s line, what a load said', () => {
    const files = [{ name: '1.txt', type: 'text/plain' }, { name: 'meet.json', type: 'application/json' }, { name: 'entries 2.CSV', type: '' }, { name: 'photo.png', type: 'image/png' }, { name: '3', type: 'text/plain' }, null];
    assert.deepEqual(A.pickEntryFiles(files).map((x) => x.name), ['1.txt', 'entries 2.CSV', '3']);
    assert.deepEqual(A.pickEntryFiles(null), []);
    assert.equal(A.pickMeetFile(files).name, 'meet.json', 'a meet file is still a meet file');
    // UTF-8 (with or without a BOM) and Windows-1252 both read
    assert.equal(A.decodeEntryBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x4e, 0x4f, 0x2e, 0x3b, 0x58, 0xc3, 0xa9])), 'NO.;Xé');
    assert.equal(A.decodeEntryBytes(new Uint8Array([0x4e, 0x4f, 0x2e, 0x3b, 0x58, 0xe9])), 'NO.;Xé');
    // requests of at most 600 KB of text
    const big = (name, n) => ({ name, text: 'x'.repeat(n) });
    assert.deepEqual(A.entryBatches([big('1.txt', 400000), big('2.txt', 300000), big('3.txt', 100000), big('4.txt', 700000), big('5.txt', 10)]).map((b) => b.map((x) => x.name)),
      [['1.txt'], ['2.txt', '3.txt'], ['4.txt'], ['5.txt']]);
    assert.deepEqual(A.entryBatches([]), []);
    // each event with a list, one not used, one with no race; then the races without one
    const now = new Date(2026, 9, 31, 9, 0, 0).getTime();
    const w = "The start list does not match Men's 8K (0 of 47 runners are on it): not used. Check the race's event number, or load the right file (Races tab).";
    const st = { now, startLists: { events: [
      { event: '1', file: '1.txt', loadedAt: now - 1000, entered: 104, races: [{ id: 'm', name: "Men's 8K" }] },
      { event: '2', file: '2.txt', loadedAt: new Date(2026, 9, 30, 20, 0, 0).getTime(), entered: 104, races: [{ id: 'w', name: "Women's 6K" }] },
      { event: '7', file: '7.txt', loadedAt: now - 1000, entered: 2, races: [] }], without: [{ id: 'j', name: 'JV' }] },
    races: [{ id: 'm', startList: { used: false, warn: w } }, { id: 'w', startList: { used: true, warn: null } }] };
    assert.deepEqual(A.startListLines(st).map((l) => [l.name, l.text, l.tone, l.title, l.removable, l.event]), [
      ["Men's 8K", '104 entered, from 1.txt: not used', 'warn', w, true, '1'],
      ["Women's 6K", '104 entered, from 2.txt, loaded 2026-10-30', '', '', true, '2'],
      ['Event 7', '2 entered, from 7.txt (no race here has event 7)', 'muted', '', true, '7'],
      ['JV', 'no start list', 'muted', '', false, '']]);
    assert.deepEqual(A.startListLines({ now }), []);
    assert.deepEqual(A.startListLines({ now, startLists: { events: [], without: [{ id: 'j', name: 'JV' }] } }), [], 'no list at all: no line per race');
    // the toast of a load: a sentence per file, then what it did to the boards
    assert.equal(A.startListLoadText({ results: [{ ok: true, text: "1.txt: 108 athletes entered in event 1 (Men's 8K)." }, { ok: false, text: '3.txt: no athletes in it (the file is empty). Nothing was loaded.' }],
      notes: ['Bib 150 (events 1 and 2) is entered in two events: counted in both.'], resent: 20, held: [{ bib: '105' }] }),
    "1.txt: 108 athletes entered in event 1 (Men's 8K). 3.txt: no athletes in it (the file is empty). Nothing was loaded. Bib 150 (events 1 and 2) is entered in two events: counted in both. "
      + 'The boards still show 1 line of an athlete who is not in the race (sent before): Review, Not in this race. 20 lines of other runners re-sent with their new places.');
    assert.equal(A.startListLoadText({ results: [{ ok: true, text: 'x.' }] }), 'x.');
  });
});

describe('split points that are counted but not sent (DESIGN 9.26)', () => {
  const sp = (name, quiet = false, id = `s-${name}`) => ({ id, name, sources: [], earliest: '', ...(quiet ? { collectOnly: true } : {}) });
  const men = () => [sp('3K'), sp('4K'), sp('4.2K', true), sp('5K'), sp('8K'), sp('8.2K', true), sp('9K')];

  test('laps to go count the splits that are sent; the hint says the number for TrackScore and Karmarush and how many are counted only', () => {
    const list = men();
    assert.deepEqual(list.map((_, i) => A.sentLapsToGo(list, i)), [5, 4, null, 3, 2, null, 1], 'the last sent split is 1, never 0; a split that is not sent has none');
    const all = [sp('1K'), sp('2K'), sp('3K')];
    assert.deepEqual(all.map((_, i) => A.sentLapsToGo(all, i)), all.map((_, i) => A.lapsToGo(i, 3)), 'with every split sent: as before');
    assert.equal(A.sentLapsToGo(list, 9), null);
    assert.deepEqual([A.notSent(list[2]), A.notSent(list[0]), A.notSent(null), A.notSent({ sending: false })], [true, false, false, false], 'not the Pause');
    assert.deepEqual(A.sentOnly(list).map((s) => s.name), ['3K', '4K', '5K', '8K', '9K']);
    assert.equal(A.splitsHint(all), A.splitCountHint(3));
    assert.equal(A.splitsHint(list), 'Set the number of splits to 5 in TrackScore (Intermediate splits) and in Karmarush. 2 more splits are counted only: Split Relay reads them and sends nothing for them, so they are not in that number.');
    assert.equal(A.splitsHint([sp('4K'), sp('4.2K', true)]), 'Set the number of splits to 1 in TrackScore (Intermediate splits) and in Karmarush. 1 more split is counted only: Split Relay reads it and sends nothing for it, so it is not in that number.');
    assert.deepEqual([A.splitsWord(all), A.splitsWord(list), A.splitsWord([sp('1K')])], ['3 splits', '5 splits + 2 not sent', '1 split']);
  });

  test('the draft and the save: Not sent is part of the form; said when on, and as false only for a split saved as not sent', () => {
    const saved = race('r', { splits: men() });
    const d = A.raceToDraft(saved);
    assert.deepEqual(d.splits.map((s) => s.collectOnly), [false, false, true, false, false, true, false]);
    // unchanged: the body says it for the two that are not sent, and nothing for the others (a server from before ignores it)
    assert.deepEqual(A.raceBody(d, saved).splits.map((s) => s.collectOnly), [undefined, undefined, true, undefined, undefined, true, undefined]);
    // 4.2K is sent again, 8K is not sent any more
    d.splits[2].collectOnly = false;
    d.splits[4].collectOnly = true;
    assert.deepEqual(A.raceBody(d, saved).splits.map((s) => s.collectOnly), [undefined, undefined, false, undefined, true, true, undefined]);
    // a paused split that is switched to Not sent is not sent as paused
    const paused = race('r', { splits: [{ ...sp('1K'), sending: false }, sp('2K')] });
    const pd = A.raceToDraft(paused);
    assert.equal(A.raceBody(pd, paused).splits[0].sending, false);
    pd.splits[0].collectOnly = true;
    assert.deepEqual([A.raceBody(pd, paused).splits[0].sending, A.raceBody(pd, paused).splits[0].collectOnly], [undefined, true]);
    // every split not sent: refused in the form, in the server's words
    const none = { ...A.raceToDraft(race('r', { name: 'Mens Race', splits: [sp('4K', true), sp('4.2K', true)] })) };
    assert.deepEqual(A.validateRaceDraft(none, [], 'r'), [serverAllNotSentText('Mens Race')]);
    assert.equal(A.allNotSentText(''), serverAllNotSentText(''));
    assert.deepEqual(A.validateRaceDraft(A.raceToDraft(saved), [], 'r'), []);
  });

  test('"Add a split after this one": the new row goes where the mat is, is sent until its switch says otherwise, and has a name of its own', () => {
    let n = 0;
    const key = () => `k${++n}`;
    const list = [sp('3K'), sp('4K'), sp('5K')];
    const added = A.addSplitAfter(list, 1, key);
    assert.deepEqual(added.map((s) => [s.name, s._k ?? s.id, s.collectOnly ?? false]), [['3K', 's-3K', false], ['4K', 's-4K', false], ['After 4K', 'k1', false], ['5K', 's-5K', false]]);
    assert.equal(list.length, 3, 'a new list');
    assert.deepEqual(A.addSplitAfter(added, 1, key).map((s) => s.name), ['3K', '4K', 'After 4K (2)', 'After 4K', '5K']);
    // default names follow their place
    assert.deepEqual(A.addSplitAfter([{ name: 'Split 1' }, { name: 'Split 2' }], 0).map((s) => s.name), ['Split 1', 'Split 2', 'Split 3']);
    assert.deepEqual(A.addSplitAfter(list, 2).map((s) => s.name), ['3K', '4K', '5K', 'After 5K']);
  });

  test('a change of which splits are sent is a new number of splits for the boards; a counted-only split between them counts the passes again', () => {
    const saved = [sp('4K'), sp('4.2K'), sp('5K')];
    const draft = (f) => { const d = saved.map((s) => ({ ...s })); f(d); return d; };
    assert.deepEqual(A.splitsChange(saved, saved), { was: 3, now: 3, reordered: false, recount: false, swapped: false });
    // Send switched off for 4.2K: 2 splits instead of 3
    const off = A.splitsChange(saved, draft((d) => { d[1].collectOnly = true; }));
    assert.deepEqual(off, { was: 3, now: 2, reordered: false, recount: false, swapped: false });
    assert.equal(A.columnsChangeText(off.was, off.now, off.reordered, off.recount), A.columnsChangeText(3, 2), 'the words of a change of the number of splits');
    assert.match(A.columnsChangeText(3, 2), /^TrackScore and Karmarush put splits in columns by laps to go\. With 2 splits instead of 3, the splits already sent are in the wrong columns: after saving, set the number of splits to 2 in TrackScore \(Intermediate splits\) and in Karmarush, and resend this race's splits\./);
    // another split sent instead: the same number, other columns
    const quiet = [sp('4K'), sp('4.2K', true), sp('5K')];
    const swap = A.splitsChange(quiet, [sp('4K', true), sp('4.2K'), sp('5K')]);
    assert.deepEqual(swap, { was: 2, now: 2, reordered: true, recount: false, swapped: true });
    assert.match(A.columnsChangeText(2, 2, true, false, true), /^TrackScore and Karmarush put splits in columns by laps to go. With other splits sent than before, the splits already sent are in the wrong columns: after saving, resend this race's splits./);
    // the same splits in another order (SR lines): the words of before
    assert.deepEqual(A.splitsChange(saved, [saved[1], saved[0], saved[2]]), { was: 3, now: 3, reordered: true, recount: false, swapped: false });
    assert.match(A.columnsChangeText(3, 3, true), /^TrackScore and Karmarush put splits in columns by laps to go. With the splits in a new order, /);
    // a split that is only counted put between two sent ones: the boards' columns stay, the passes are counted again
    const added = A.splitsChange(quiet, [quiet[0], quiet[1], { name: 'After 4.2K', collectOnly: true }, quiet[2]]);
    assert.deepEqual(added, { was: 2, now: 2, reordered: false, recount: true, swapped: false });
    assert.equal(A.columnsChangeText(2, 2, false, true), "With a split that is counted only added, taken out or moved, every runner's passes are counted again from the first. " +
      `The splits already sent after it may then hold another split's time: after saving, resend this race's splits. ${A.RESEND_LIMIT}`);
    assert.deepEqual(A.splitsChange(quiet, [quiet[0], quiet[2]]), { was: 2, now: 2, reordered: false, recount: true, swapped: false }, 'taken out');
    assert.equal(A.columnsChangeText(2, 2, false, false), '');
    // the resend prompt: the race's number of splits is the number it sends
    const stale = view('g', { splitCount: 3, sentCount: 2, splits: quiet, resendSuggested: true, stale: { count: 40, byOutput: [], reason: 'split-count', splitCountFrom: 3 } });
    const p = A.resendPrompt(stale);
    assert.deepEqual(p.columns, { was: 3, now: 2, reordered: false, sends: true });
    assert.match(A.resendPromptText(p), /^TrackScore and Karmarush put splits in columns by laps to go; this race now sends 2 splits instead of 3, so the splits already sent are in the wrong columns\. Resend this race's splits\./);
    const plain = A.resendPrompt(view('g', { splitCount: 3, splits: saved, resendSuggested: true, stale: { count: 40, byOutput: [], reason: 'split-count', splitCountFrom: 2 } }));
    assert.match(A.resendPromptText(plain), /this race now has 3 splits instead of 2/);
    const order = A.resendPrompt(view('g', { splitCount: 3, sentCount: 2, splits: quiet, resendSuggested: true, stale: { count: 4, byOutput: [], reason: 'order', splitCountFrom: null } }));
    assert.match(A.resendPromptText(order), /this race's splits are in a new order, or other splits are sent now, so the splits already sent are in the wrong columns/);
  });

  test('the status word, its meaning, the cells and a made-up time in a split that is not sent', async () => {
    assert.deepEqual([A.STATUS.counted.label, A.STATUS.counted.tone, A.STATUS.counted.filtered, A.shortStatus('counted'), A.STATUS_ORDER.includes('counted')],
      ['Counted, not sent', 'muted', undefined, 'Counted', true]);
    assert.match(A.STATUS.counted.meaning, /set to Not sent on the Races page/);
    const { readFile } = await import('node:fs/promises');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(readme.includes(`| ${A.STATUS.counted.label} |`), 'README explains "Counted, not sent"');
    assert.match(readme, /## Splits you collect but don't send/);
    // the feed's own sentence starts with the split's name
    assert.match(SERVER_COUNTED_TEXT.replace('This split', '4.2K'), /^4\.2K is counted, not sent: /);
    const cfg = race('r', { splits: [sp('4K'), sp('4.2K', true), sp('5K')] });
    const raw = { bib: '143', found: true, passes: [], columns: [
      { splitId: 's-4K', splitName: '4K', time: 7443000, place: 79, kind: 'read', how: 'counted', lapsToGo: 2 },
      { splitId: 's-4.2K', splitName: '4.2K', time: 7789000, place: 80, kind: 'read', how: 'counted', held: 'collect', collectOnly: true, lapsToGo: null },
      { splitId: 's-5K', splitName: '5K', time: null, kind: 'not-yet', lapsToGo: 1 }] };
    const v = A.normRunner(raw, cfg);
    assert.deepEqual(v.columns.map((c) => [c.status, c.collectOnly]), [['', false], ['counted', true], ['', false]]);
    const m = A.cellModel(v.columns[1], v);
    assert.deepEqual([m.chip, m.tone, m.main], [{ text: 'Not sent', tone: 'muted' }, 'counted', '12:58.9']);
    assert.match(m.aria, /, counted, not sent$/);
    assert.equal(m.info, "4.2K 12:58.9: counted, not sent. 4.2K is set to Not sent on the race's page: the pass keeps bib 143's later passes in their own splits and goes to no scoreboard. Enter opens the choices (Move, Not a split).");
    // an empty one is missing nothing
    const empty = A.cellModel({ splitId: 's-4.2K', splitName: '4.2K', raceTicks: null, kind: 'not-yet', collectOnly: true }, v);
    assert.deepEqual([empty.main, empty.sub, empty.tone, empty.aria], ['—', 'Not sent', 'counted', '4.2K: counted only, no pass']);
    assert.equal(empty.info, '4.2K is counted, not sent: no scoreboard has a column for it, so it needs no time.');
    assert.equal(A.cellModel({ splitId: 's-5K', splitName: '5K', raceTicks: null, kind: 'not-yet' }, v).sub, 'Not yet');
    // a made-up time there
    const rv = A.normReview({ manual: [{ bib: '143', splitId: 's-4.2K', splitName: '4.2K', raceTicks: 7789000, estimated: true, state: 'active', sent: false, collectOnly: true }] }, cfg);
    assert.equal(A.manualStateText(rv.manual[0], { outputs: ['TrackScore'], lif: true }), A.COUNTED_ONLY_TIME);
    assert.match(A.COUNTED_ONLY_TIME, /^Counted, not sent: it keeps the runner's later passes in their own splits\./);
  });

  test('the Dashboard: the splits that went out leave the counted ones out; reads merged long after the runner\'s last one are a Needs attention row', () => {
    const rv = view('g', { splits: [{ id: 'a', name: '4K', crossings: 30, held: 0 }, { id: 'b', name: '4.2K', crossings: 28, held: 0, collectOnly: true }, { id: 'c', name: '5K', crossings: 12, held: 2 }] });
    assert.equal(A.sentSplits(rv), 40);
    assert.equal(A.lateMergedWarning(rv), null);
    const m = { reads: 24, runners: 12, fromSec: 20, toSec: 45, tagWindowSec: 45 };
    const text = serverLateMergedText(m);
    assert.equal(text, "24 reads of 12 runners came 20 to 45 s after the runner's last one and were merged into it by the tag filter (45 s). " +
      "If two mats are that close on the course, set the tag filter below the fastest runner's time between them.");
    const w = A.lateMergedWarning({ ...rv, lateMerged: { ...m, text } });
    assert.deepEqual([w.tone, w.id, w.title, w.action], ['warn', 'late-merged', 'Tag filter merged reads 20 to 45 s apart', { label: 'Tag filter settings', href: '#settings/filter' }]);
    assert.ok(w.text.startsWith(`Two mats close together? ${text}`));
    assert.match(w.text, /A pass that is merged away is not counted, so that runner's later passes land a split early\./);
    assert.equal(A.lateMergedWarning({ lateMerged: { ...m, fromSec: 36, toSec: 36, text: '' } }).title, 'Tag filter merged reads 36 s apart');
    const cfg = race('g', { splits: [{ id: 'a', name: '4K' }, { id: 'b', name: '4.2K', collectOnly: true }, { id: 'c', name: '5K' }] });
    const ws = A.raceWarnings({ ...rv, id: 'g', gunTicks: 1, gunText: '10:00:00.000', lateMerged: { ...m, text } }, cfg, state({ races: [cfg] }), 0);
    assert.ok(ws.some((x) => x.id === 'late-merged'));
    // the setup line: quiet below 30 s, amber from there
    assert.equal(A.closeMatsText(45), "The tag filter is 45 s: reads of one runner that close together count as one pass. If two mats are that close on the course, set the tag filter below the fastest runner's time between them (a fast runner covers 200 m in about 35 s).");
    assert.deepEqual([A.closeMatsRisk(45), A.closeMatsRisk('30'), A.closeMatsRisk(20), A.closeMatsRisk('10'), A.closeMatsRisk('')], [true, true, false, false, false]);
  });
});

describe('swapped bibs (DESIGN 9.27)', () => {
  test('the list of a State, what a change said, the runner and the find row', () => {
    assert.deepEqual(A.swapsOf({}), []);
    assert.deepEqual(A.swapsOf({ swaps: [{ a: '11', b: '510', at: 1000, atText: '14:02:11', text: 'Bib 11 and bib 510 are swapped',
      races: [{ raceId: 'w', raceName: "Women's Race", text: "Women's Race: bib 510 has 5 splits (3:17.4 to 17:57.9) read as bib 11" }, { raceId: 'x' }] }, { a: '', b: '9' }, null] }),
    [{ a: '11', b: '510', at: 1000, atText: '14:02:11', text: 'Bib 11 and bib 510 are swapped',
      races: [{ raceId: 'w', raceName: "Women's Race", text: "Women's Race: bib 510 has 5 splits (3:17.4 to 17:57.9) read as bib 11" }] }]);
    assert.equal(A.swapsOf({ swaps: [{ a: '7', b: '8' }] })[0].text, 'Bib 7 and bib 8 are swapped');
    // what a change said: Split Relay's own sentences, one line per race; amber when something stayed behind
    const change = { text: 'Bibs 11 and 510 are swapped.', removed: false, races: [
      { raceName: "Women's Race", lines: ["5 splits are bib 510's now; bib 11 has none here.", 'Sent to TrackScore.'], leftover: [], notLive: [] },
      { raceName: "Men's Race", lines: [], leftover: [], notLive: [] }] };
    assert.deepEqual(A.swapChangeLines(change), { head: 'Bibs 11 and 510 are swapped.', lines: ["Women's Race: 5 splits are bib 510's now; bib 11 has none here. Sent to TrackScore."], warn: false });
    assert.equal(A.swapChangeLines({ ...change, races: [{ ...change.races[0], leftover: [{ bib: '11' }] }] }).warn, true);
    assert.deepEqual(A.swapChangeLines({ removed: true }), { head: 'The swap was removed.', lines: [], warn: false });
    // the runner editor's line, and a runner the race has no read of that is one of a pair
    const cfg = race('g', { splits: [{ id: 'a', name: '1K' }] });
    const v = A.normRunner({ bib: '510', columns: [{ splitId: 'a', raceTicks: 1973220 }], swap: { other: '11', atText: '14:02:11', text: 'Swapped bibs: bib 510 ran with the chip of bib 11. Its reads here came in as bib 11.' } }, cfg);
    assert.deepEqual(v.swap, { other: '11', atText: '14:02:11', text: 'Swapped bibs: bib 510 ran with the chip of bib 11. Its reads here came in as bib 11.' });
    assert.equal(A.normRunner({ bib: '11', found: false, columns: [], swap: { other: '510' } }, cfg).swap.text, 'Swapped bibs: bib 11 ran with the chip of bib 510.');
    assert.equal(A.normRunner({ bib: '12', columns: [] }, cfg).swap, undefined);
    assert.equal(A.findRowText({ bib: '11', name: '', team: '', raceName: "Men's Race", filled: 12, splits: 12, readAs: '510' }), "11 · Men's Race · 12 of 12 splits · read as bib 510");
  });
});
