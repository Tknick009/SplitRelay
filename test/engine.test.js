import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, normalizeGender, matchKey, parseGun, foldAscii, routeKeyInfo, portKey, eventRouteKey, asideText, LONE_TEXT } from '../src/engine.js';
import { parseTod, parseRaceTime, formatTod, formatRaceTime, TICKS_PER_SEC } from '../src/timefmt.js';
import { packetVariables, packetProblem } from '../src/outputs.js';
import { parseScript, renderUpdate } from '../src/lss.js';
import { normalizeConfig, addRace, updateRace, deleteRace, activateRace, restoreRace } from '../src/config.js';

const XCSCORE = parseScript(readFileSync(fileURLToPath(new URL('./fixtures/xcscore.lss', import.meta.url))));

const S = TICKS_PER_SEC;
// Local 10:00:00 on race day, so the race clock (elapsedTicks) can be checked against a 10:00 gun.
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();

/**
 * A clock whose timers only run when the test says so. Timers due at the same moment run in creation order.
 * jump(ms) moves the wall clock without moving the timers, as Windows time sync does to Date.now() while Node's
 * timers keep counting real time.
 */
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
    jump(ms) {
      now += ms;
      for (const t of timers.values()) t.at += ms;
    },
    timerCount: () => timers.size,
  };
}

/** Saves go through JSON like the real file store, so anything unserialisable shows up here. */
function memStore() {
  const data = new Map();
  const saves = [];
  const removed = [];
  const journal = [];
  return {
    data, saves, removed, journal,
    load: (id) => (data.has(id) ? JSON.parse(data.get(id)) : null),
    save: (id, d) => {
      saves.push(id);
      data.set(id, JSON.stringify(d));
    },
    remove: (id) => {
      removed.push(id);
      data.delete(id);
    },
    appendJournal: (rec) => journal.push(JSON.stringify(rec)),
    loadJournal: () => journal.map((l) => JSON.parse(l)),
  };
}

/**
 * Stands in for OutputManager.deliver. Each output takes packets and acknowledges at once, unless the test makes it
 * refuse (a broken script) or keep its acknowledgements back (a TrackScore that is down: packets queue).
 */
function fakeNet() {
  const got = new Map();
  const refuse = new Set();
  const hold = new Set();
  const queued = [];
  const of = (id) => {
    if (!got.has(id)) got.set(id, []);
    return got.get(id);
  };
  return {
    of, refuse, hold, queued,
    deliver(id, packet, ack) {
      if (refuse.has(id)) return false;
      if (hold.has(id)) queued.push({ id, packet, ack });
      else {
        of(id).push(packet);
        ack(true);
      }
      return true;
    },
    /** The output comes back: what is still current goes out, the rest is dropped (ack false). */
    flush(id) {
      for (const q of queued.splice(0).filter((x) => x.id === id)) {
        if (q.packet.isCurrent()) {
          of(id).push(q.packet);
          q.ack(true);
        } else q.ack(false);
      }
    },
    /** OutputManager.stop(): everything queued is dropped. */
    dropAll() {
      for (const q of queued.splice(0)) q.ack(false);
    },
  };
}

function race(over = {}) {
  return {
    id: 'r1', name: 'Girls Varsity 5K', eventNumber: '3', round: '1', heat: '1', distance: '',
    contests: [], gun: '10:00:00.000',
    splits: [
      { id: 's1', name: '1K', sources: ['1K-A', '1K-B'] },
      { id: 's2', name: '2K', sources: ['2K-A', '2K-B'] },
      { id: 's3', name: '3K', sources: ['3K-A'] },
    ],
    finishSources: ['Finish'], active: true, ...over,
  };
}

const output = (over = {}) => ({ id: 'o1', name: 'TrackScore', enabled: true, races: [], ...over });

function setup({ races = [race()], outputs = [output()], filter = {}, names, store = memStore(), clock = fakeClock(),
  net = fakeNet(), finishers, start = true, config: given } = {}) {
  const config = given ?? { version: 1, filter: { tagWindowSec: 10, holdSec: 2, ...filter }, races, outputs };
  const logs = [];
  const engine = new Engine({ getConfig: () => config, names, store, clock, log: (l) => logs.push(l), deliver: net.deliver, finishers });
  const feeds = [];
  const raceEvents = [];
  engine.on('feed', (e) => feeds.push({ ...e }));
  engine.on('race', (id) => raceEvents.push(id));
  // The config owner applies the patch synchronously, as main.js must.
  engine.on('config-patch', ({ raceId, patch }) => Object.assign(config.races.find((r) => r.id === raceId), patch));
  const read = (location, bib, tod, extra = {}) => engine.handleRead(
    { location, bib: String(bib), tod: parseTod(tod), contest: '', first: '', last: '', team: '', gender: '', ...extra },
    { receivedAt: clock.now(), raw: `SR|${location}|${bib}|${tod}`, connId: 1 },
  );
  if (start) clock.advance(0); // the engine starts delivering from a 0 ms timer
  return { engine, config, clock, store, net, sends: net.of('o1'), feeds, raceEvents, logs, read };
}

const sent = (sends) => sends.map((p) => [p.bib, p.place, p.reason]);
/** RaceView.stale.hint when a time, the gun or a place changed after the splits went out (DESIGN 9.16 F1). */
const CHANGED_HINT = "The gun time, the splits or the places changed after the splits went out. Resend this race's splits. " +
  'Resend corrects every split Split Relay has. A runner who has no split in a column under the new setting may still ' +
  'show an old time there in TrackScore and the live results until the race is cleared there.';
const rt = (s) => parseRaceTime(s);
const entryOf = (s, e) => s.engine.feed(1000).find((x) => x.id === e.id);
/**
 * DELETE /api/races/:id, as main.js does it: the races leave the settings and the engine is told they were deleted.
 * Only that takes reads out of use (DESIGN 9.2 R2); a race that just disappears from the settings is missing (R6).
 */
function deleteRaces(s, ...ids) {
  s.config.races = s.config.races.filter((r) => !ids.includes(r.id));
  s.engine.configChanged({ deleted: ids });
}

test('matchKey, normalizeGender and foldAscii', () => {
  assert.equal(matchKey('  1K -  A '), '1k - a');
  const cases = [['m', 'M'], ['Male', 'M'], ['BOYS', 'M'], ['boy', 'M'], ["Men's", 'M'], ['f', 'F'], ['female', 'F'],
    [' Girls ', 'F'], ["Women's", 'F'], ['W', 'F'], ['x', ''], ['', ''], [undefined, '']];
  for (const [v, want] of cases) assert.equal(normalizeGender(v), want, String(v));
  assert.equal(foldAscii('O’Neil “Jo” – Smith—Jr…'), 'O\'Neil "Jo" - Smith-Jr...');
  assert.equal(foldAscii('Ana María Šimić Ștefan Łukasz'), 'Ana María Simic Stefan Lukasz');
  assert.equal(foldAscii('Zoë Müller'), 'Zoë Müller', 'latin-1 letters are fine as they are');
});

test('contests pick the race; two overlapping races with different guns; catch-all takes the rest', () => {
  const s = setup({ races: [
    race({ id: 'g', name: 'Girls 5K', contests: ['Girls 5K'], gun: '10:00:00.000' }),
    race({ id: 'b', name: 'Boys 5K', contests: ['  boys   5k '], gun: '10:15:00.000' }),
    race({ id: 'any', name: 'Open', contests: [], gun: '10:30:00.000' }),
  ] });
  const g1 = s.read('1K-A', 101, '10:04:00.000', { contest: 'Girls 5K' });
  const b1 = s.read('1k-a', 201, '10:19:30.000', { contest: 'Boys  5K' });
  s.read('1K-A', 102, '10:04:01.000', { contest: 'GIRLS 5K' });
  s.read('1K-B', 202, '10:19:31.000', { contest: 'Boys 5K' });
  const o = s.read('1K-A', 301, '10:33:00.000', { contest: 'Novice' });
  assert.deepEqual([g1.raceId, g1.raceName, b1.raceId, o.raceId], ['g', 'Girls 5K', 'b', 'any']);
  assert.equal(g1.raceTicks, 240 * S);
  assert.equal(b1.raceTicks, 270 * S);
  s.clock.advance(2000);
  const by = Object.fromEntries(s.sends.map((p) => [p.bib, p]));
  assert.deepEqual(['101', '102', '201', '202', '301'].map((b) => [by[b].raceId, by[b].csTicks, by[b].place]), [
    ['g', 240 * S, 1], ['g', 241 * S, 2], ['b', 270 * S, 1], ['b', 271 * S, 2], ['any', 180 * S, 1],
  ]);
  assert.equal(by['201'].gunTicks, parseTod('10:15:00'));
  assert.equal(by['201'].race, s.config.races[1]);
  assert.equal(by['201'].runnerCount, 2);
});

test('no race, a paused race, and a paused race that claims the contest beats the catch-all', () => {
  const s = setup({ races: [race({ id: 'v', name: 'Varsity', contests: ['Varsity'], active: false }), race({ id: 'jv', name: 'JV', contests: ['JV'] })] });
  // Revision 6 (C1): a contest that only races that are not Active list waits for them in no race, never inside them
  const p = s.read('1K-A', 1, '10:01:00', { contest: 'Varsity' });
  assert.deepEqual([p.status, p.raceId, p.raceName], ['paused', null, 'Varsity']);
  assert.equal(p.detail, "Its race 'Varsity' is not Active. These reads are used when you tick Active.");
  const n = s.read('1K-A', 2, '10:01:00', { contest: 'Novice' });
  assert.equal(n.status, 'no-race');
  assert.match(n.detail, /Novice/);
  assert.equal(s.read('1K-A', 3, '10:01:00').status, 'no-race');

  // Revision 2 (9.2): reads that had no race are routed again on every config change, so a catch-all race added now
  // takes bibs 2 and 3 as well (it is "fixing a contest typo pulls the reads in").
  s.config.races.push(race({ id: 'all', name: 'Everything', contests: [] }));
  s.engine.configChanged();
  const p4 = s.read('1K-A', 4, '10:01:00', { contest: 'Varsity' });
  assert.deepEqual([p4.status, p4.raceId], ['paused', null], 'the race that lists the contest beats the one that takes every contest');
  assert.deepEqual([entryOf(s, p).status, entryOf(s, p).raceId], ['paused', null]);
  assert.equal(s.read('1K-A', 5, '10:01:00', { contest: 'Novice' }).raceId, 'all');
  assert.equal(s.read('1K-A', 6, '10:01:01').raceId, 'all');
  assert.equal(entryOf(s, n).raceId, 'all', 'the no-race row was updated in place');
  s.clock.advance(5000);
  assert.deepEqual(s.sends.map((x) => x.bib), ['2', '3', '5', '6']);
  // nothing is put into the race that is not Active; ticking Active takes every read of its contest
  assert.equal(s.engine.raceView('v').runners, 0);
  assert.deepEqual(s.engine.noRace().map((n) => [n.contest, n.status, n.count, n.raceId]), [['Varsity', 'paused', 2, 'v']]);
  s.config.races[0].active = true;
  s.engine.configChanged();
  s.clock.advance(3000);
  assert.equal(s.engine.raceView('v').runners, 2);
  assert.deepEqual(s.sends.slice(4).map((x) => [x.raceId, x.bib]), [['v', '1'], ['v', '4']]);
  assert.deepEqual([entryOf(s, p).status, entryOf(s, p).raceId], ['sent', 'v']);
  assert.deepEqual(s.engine.noRace(), []);

  // An inactive catch-all takes nothing (9.2): its reads have no race until it is made active.
  const only = setup({ races: [race({ active: false })] });
  const x = only.read('1K-A', 1, '10:01:00', { contest: 'X' });
  assert.equal(x.status, 'no-race');
  assert.match(x.detail, /Girls Varsity 5K takes every contest but is not active/);
  only.config.races[0].active = true;
  only.engine.configChanged();
  only.clock.advance(2000);
  assert.deepEqual(sent(only.sends), [['1', 1, 'new']]);
  const none = setup({ races: [] });
  assert.match(none.read('1K-A', 1, '10:01:00').detail, /No races/);
});

test('unmapped timing points are reported per race and counted in seen()', () => {
  const s = setup();
  const e = s.read('2K-C', 7, '10:06:00', { contest: 'Girls' });
  assert.deepEqual([e.status, e.raceId, e.splitName], ['unmapped', 'r1', '']);
  assert.match(e.detail, /2K-C/);
  s.clock.advance(1000);
  s.read(' 2k-c ', 8, '10:06:01', { contest: 'girls' });
  s.read('1K-A', 7, '10:03:00', { contest: 'Boys' });
  s.engine.handleRead(null, { raw: 'junk', error: 'Unparseable time' }); // bad lines are not "seen"
  const seen = s.engine.seen();
  assert.deepEqual(seen.locations, [{ name: '1K-A', count: 1, lastAt: T0 + 1000 }, { name: '2K-C', count: 2, lastAt: T0 + 1000 }]);
  assert.deepEqual(seen.contests.map((c) => [c.name, c.count]), [['Boys', 1], ['Girls', 2]]);
  assert.deepEqual(s.engine.raceView('r1').unmapped, [{ name: '2K-C', count: 2 }]);
  assert.deepEqual(s.engine.raceView('r1').contestsSeen, [
    { name: 'Boys', count: 1, blank: false }, { name: 'Girls', count: 2, blank: false },
  ]);

  // Revision 2 (review-core F1): mapping the name later turns the reads already received into crossings.
  s.config.races[0].splits[1].sources.push('2K-C');
  s.engine.configChanged();
  assert.deepEqual(s.engine.raceView('r1').unmapped, []);
  s.clock.advance(3000);
  // each goes out when its own hold is over: bib 7's 2K read came first. 9.23 F13: bib 7's 1K went out after its 2K, so
  // its 2K (its furthest split) goes again last: TrackScore takes the runner's place from the newest packet
  assert.deepEqual(s.sends.map((p) => `${p.splitName}:${p.bib}:${p.place}`), ['2K:7:1', '1K:7:1', '2K:8:2', '2K:7:1']);
  assert.equal(entryOf(s, e).status, 'sent', 'the unmapped row now says sent');
});

test('mapping a timing point late gives every runner behind the right place (review-core F1)', () => {
  const s = setup();
  for (let bib = 1; bib <= 5; bib++) s.read('2K', bib, `10:06:0${bib}`);
  s.clock.advance(3000);
  assert.equal(s.sends.length, 0);
  assert.deepEqual(s.engine.raceView('r1').unmapped, [{ name: '2K', count: 5 }]);
  s.config.races[0].splits[1].sources.push('2K');
  s.engine.configChanged();
  // the hold of these reads is long over: they go out at once, in time order
  assert.deepEqual(s.sends.map((p) => [p.bib, p.place]), [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]);
  s.read('2K', 6, '10:06:06');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends.slice(5)), [['6', 6, 'new']], 'the sixth runner is sixth, not first');
  assert.equal(s.engine.raceView('r1').splits[1].crossings, 6);
});

test('finish reads are recorded, never sent, and block corrections and place updates', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00.000');
  s.read('1K-A', 2, '10:03:01.000');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['1', 1, 'new'], ['2', 2, 'new']]);
  const f = s.read('finish', 1, '10:03:05.000');
  assert.deepEqual([f.status, f.splitName, f.place], ['finish', 'Finish', null]);
  assert.match(f.detail, /No more splits are sent for this runner/);
  assert.equal(s.engine.raceView('r1').finished, 1);
  s.sends.length = 0;

  const b = s.read('1K-B', 1, '10:02:59.500'); // earlier, within 60 s, but bib 1 has finished
  // revision 10: TrackScore has the old time (3:00.0); only "Send with finish place" (Review) may correct it
  assert.equal(b.status, 'finished-not-sent');
  assert.match(b.detail, /^Finished: Sent with an old time \(3:00\.0\): .* Send the corrected time \(2:59\.5\) with the finish place\. Review lists it/);
  assert.deepEqual(s.engine.review('r1').finishedNotSent.map((x) => [x.bib, x.timeText, x.sentOld?.timeText]), [['1', '2:59.5', '3:00.0']]);
  s.read('1K-B', 3, '10:02:58.000');
  s.clock.advance(2000);
  // Bib 1 moved from 1st to 2nd and bib 2 from 2nd to 3rd; only bib 2 may be told.
  assert.deepEqual(sent(s.sends), [['3', 1, 'new'], ['2', 3, 'place-update']]);
  assert.equal(s.engine.crossings('r1').find((c) => c.bib === '1').raceTicks, rt('2:59.500'));

  const warmup = s.read('Finish', 9, '09:55:00');
  assert.equal(warmup.status, 'before-gun');
  assert.equal(s.engine.raceView('r1').finished, 1);
});

test('finished runners never get a live split, by finish read or FinishLynx, but keep their splits for the .lif (trackscore-compat F1)', () => {
  const lynx = new Map([['r1', new Map()]]);
  const store = memStore();
  const clock = fakeClock();
  const net = fakeNet();
  const s = setup({ store, clock, net, finishers: (id) => lynx.get(id) });
  // An RR12 queue flush after an outage: 1K, 2K and the Finish of three runners in one burst.
  for (const bib of [1, 2, 3]) {
    s.read('1K-A', bib, `10:03:0${bib}`);
    s.read('2K-A', bib, `10:06:0${bib}`);
    s.read('Finish', bib, `10:10:0${bib}`);
  }
  clock.advance(5000);
  assert.deepEqual(s.sends, [], 'nothing for runners who finished');
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.finished, v.finishedNotSent, v.runners], [3, 6, 3]);
  assert.deepEqual(s.engine.raceData('r1').runners.get('2').splits, [rt('3:02'), rt('6:02'), null]);
  assert.equal(s.feeds.findLast((e) => e.bib === '1' && e.splitName === '1K').status, 'finished-not-sent');

  // FinishLynx has finished bib 5 (no finish timing point needed): no new split, no correction, no place update.
  s.read('1K-A', 5, '10:03:10');
  s.read('1K-A', 6, '10:03:11');
  clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['5', 4, 'new'], ['6', 5, 'new']]);
  lynx.get('r1').set('5', rt('9:59'));
  s.engine.converge();
  assert.equal(s.engine.raceView('r1').finished, 4);
  s.read('1K-B', 5, '10:03:09.900'); // earlier backup read: a correction for anyone else
  s.read('1K-A', 7, '10:03:09'); // a late runner ahead of 5 and 6: a place update for anyone else
  s.read('2K-A', 5, '10:06:20'); // a new split for a finisher
  clock.advance(2000);
  assert.deepEqual(sent(s.sends.slice(2)), [['7', 4, 'new'], ['6', 6, 'place-update']]);
  assert.equal(s.engine.raceData('r1').runners.get('5').splits[1], rt('6:20'), 'still in the merged .lif');

  // Restored after a restart: a crossing the output never took (it refused) is not sent once the runner finished.
  net.refuse.add('o1');
  s.read('1K-A', 8, '10:03:30');
  clock.advance(2000);
  s.engine.stop();
  s.engine.markCleanStop();
  lynx.get('r1').set('8', rt('10:30'));
  net.refuse.delete('o1');
  const before = s.sends.length;
  const s2 = setup({ store, clock, net, finishers: (id) => lynx.get(id) });
  clock.advance(5000);
  assert.equal(s2.sends.length, before, 'nothing after the restart either');
  assert.ok(s2.engine.raceData('r1').runners.has('8'));

  // A gun set late, after the finishes were in (the second repro): no packets for the finishers.
  const g = setup({ races: [race({ gun: '' })] });
  g.read('1K-A', 1, '10:03:00');
  g.read('Finish', 1, '10:10:00');
  g.read('1K-A', 2, '10:03:01');
  g.clock.advance(5000);
  g.engine.setGun('r1', '10:00:00');
  assert.deepEqual(sent(g.sends), [['2', 2, 'new']]);
});

test('a split read after the finish, or out of course order, is ignored (lif-ground-truth F1)', () => {
  const s = setup();
  // bib 1 missed the 2K mats, finished at 16:59, then walked over 2K-A 400 s later
  s.read('1K-A', 1, '10:05:00');
  s.read('Finish', 1, '10:16:59.297');
  const late = s.read('2K-A', 1, '10:23:39.297');
  // bib 2 has no finish read: missed 1K, crossed 2K at 6:00, then walked over the 1K mat after the 2K
  s.read('2K-A', 2, '10:06:00');
  const back = s.read('1K-B', 2, '10:20:44.429');
  s.clock.advance(5000);
  assert.deepEqual([late.status, back.status], ['after-finish', 'out-of-order']);
  assert.match(late.detail, /After this runner's finish \(16:59\.3\)/);
  assert.match(back.detail, /Not before this runner's 2K \(6:00\.0\), so it can't be a 1K crossing/);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.splitName]), [['2', '2K']]);
  assert.deepEqual(s.engine.raceData('r1').runners.get('1').splits, [rt('5:00'), null, null]);
  assert.deepEqual(s.engine.raceData('r1').runners.get('2').splits, [null, rt('6:00'), null]);
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.afterFinish, v.outOfOrder], [1, 1]);
  // a real 1K crossing of bib 2 that arrives late still counts: it is before the 2K
  s.read('1K-A', 2, '10:03:00');
  s.clock.advance(2000);
  assert.deepEqual(s.engine.raceData('r1').runners.get('2').splits, [rt('3:00'), rt('6:00'), null]);
});

test('reads wait for the gun, then go out in time-of-day order; their feed rows are updated in place', () => {
  const s = setup({ races: [race({ gun: '' })] });
  const first = s.read('1K-A', 3, '10:03:02.000');
  s.read('1K-A', 1, '10:03:00.000');
  s.read('1K-B', 2, '10:03:01.000');
  const again = s.read('1K-A', 1, '10:03:00.000'); // RR12 replay while waiting
  s.read('Finish', 8, '10:18:00.000');
  assert.deepEqual([first.status, first.raceTicks, again.status], ['waiting-gun', null, 'duplicate']);
  assert.match(first.detail, /gun time/);
  assert.deepEqual([s.engine.raceView('r1').pending, s.engine.raceView('r1').waitingGun], [4, 4]);
  assert.equal(s.engine.raceView('r1').finished, 0);
  s.clock.advance(10_000);
  assert.equal(s.sends.length, 0);

  assert.deepEqual(s.engine.setGun('r1', ' 10:00:00 '), { gun: '10:00:00.000', gunTicks: parseTod('10:00:00') });
  assert.equal(s.config.races[0].gun, '10:00:00.000');
  assert.deepEqual(s.sends.map((p) => [p.bib, p.place, p.csTicks]), [['1', 1, 180 * S], ['2', 2, 181 * S], ['3', 3, 182 * S]]);
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.pending, v.finished, v.runners, v.resendSuggested], [0, 1, 3, false]);
  // Revision 2 (race-day-sim F7): the rows that said 'Waiting for gun' now say what happened, with the race time.
  assert.deepEqual(s.engine.feed(5).map((e) => [e.bib, e.status]), [['8', 'finish'], ['1', 'duplicate'], ['2', 'sent'], ['1', 'sent'], ['3', 'sent']]);
  assert.deepEqual([first.status, first.raceTicks, first.place], ['sent', 182 * S, 3]);
  assert.deepEqual(s.feeds.filter((f) => f.id === first.id).map((f) => f.status), ['waiting-gun', 'sent']);
});

test('a gun later than the waiting reads counts them as before the gun, in the view and the feed (ux-walkthrough F2)', () => {
  const s = setup({ races: [race({ gun: '' })] });
  const rows = [1, 2, 3].map((b) => s.read('1K-A', b, `10:01:0${b}`));
  s.engine.setGun('r1', '10:01:30'); // 'Set to now' pressed late
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.pending, v.beforeGun, v.runners], [0, 3, 0]);
  assert.deepEqual(rows.map((e) => e.status), ['before-gun', 'before-gun', 'before-gun']);
  assert.match(rows[0].detail, /29 s before the gun \(10:01:30\.000\).*Is the gun time right\?/);
  s.clock.advance(2000);
  s.engine.setGun('r1', '10:00:00');
  assert.deepEqual(rows.map((e) => e.status), ['sent', 'sent', 'sent']);
});

test('setGun validates, normalises, clears, and refuses when nobody stores the patch', () => {
  const s = setup();
  assert.throws(() => s.engine.setGun('r1', '25:00:00'), /not a time of day/);
  assert.throws(() => s.engine.setGun('r1', '10'), /not a time of day/);
  assert.throws(() => s.engine.setGun('nope', '10:00:00'), /no race/);
  assert.equal(s.engine.setGun('r1', '12:58:49.2595').gun, '12:58:49.2595');
  assert.equal(s.engine.setGun('r1', '9:05:00,5').gun, '09:05:00.500');
  assert.deepEqual(s.engine.setGun('r1', ''), { gun: '', gunTicks: null });
  assert.equal(s.config.races[0].gun, '');
  assert.equal(s.engine.raceView('r1').gunTicks, null);
  assert.equal(s.read('1K-A', 1, '10:03:00').status, 'waiting-gun');

  const config = { filter: {}, races: [race()] };
  const lonely = new Engine({ getConfig: () => config, clock: fakeClock() });
  assert.throws(() => lonely.setGun('r1', '10:01:00'), /not saved/);
});

test('parseGun is the one validator for every way a gun is typed', () => {
  assert.deepEqual(parseGun('10:00:00'), { gun: '10:00:00.000', gunTicks: parseTod('10:00:00') });
  assert.deepEqual(parseGun('9:05:00.1'), { gun: '09:05:00.100', gunTicks: parseTod('9:05:00.1') });
  assert.equal(parseGun('12:58:49.2595').gun, '12:58:49.2595');
  assert.deepEqual(parseGun('  '), { gun: '', gunTicks: null });
  for (const bad of ['10', '36000', '24:00:00', '10:60:00', 'ten', '10:00']) assert.throws(() => parseGun(bad), /hh:mm:ss/, bad);
});

test('a gun cleared mid-race parks new reads, holds unsent crossings, and gives the .lif no data (review-core F9)', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.engine.setGun('r1', '');
  assert.equal(s.engine.raceData('r1'), null, 'LifSync leaves the merged file alone instead of writing it without splits');
  s.clock.advance(5000);
  assert.equal(s.sends.length, 0);
  assert.equal(s.read('1K-B', 1, '10:03:00.200').status, 'waiting-gun');
  s.engine.setGun('r1', '10:00:00');
  assert.deepEqual(s.sends.map((p) => [p.bib, p.csTicks]), [['1', 180 * S]]);
  assert.deepEqual(s.engine.crossings('r1').map((c) => c.reads), [2]);
});

test('a race over midnight keeps positive race times and the right order', () => {
  const s = setup({ races: [race({ gun: '23:58:00.000' })] });
  s.read('1K-A', 2, '00:01:05.000');
  s.read('1K-A', 1, '23:59:59.000');
  s.clock.advance(2000);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.place, p.csTicks]), [['1', 1, 119 * S], ['2', 2, 185 * S]]);
});

test('an async race-file load is merged in when it arrives', async () => {
  const store = memStore();
  const clock = fakeClock();
  const s1 = setup({ store, clock });
  s1.read('1K-A', 1, '10:03:00');
  clock.advance(2000);
  s1.engine.stop();
  const json = store.data.get('r1');
  const asyncStore = { ...store, load: async () => JSON.parse(json) };
  const net = fakeNet();
  net.hold.add('o1'); // the restored ledger must arrive before anything is acknowledged
  const s2 = setup({ store: asyncStore, clock, net, start: false });
  await new Promise((r) => setImmediate(r));
  clock.advance(0);
  assert.deepEqual(s2.engine.crossings('r1').map((c) => [c.bib, c.reason]), [['1', 'new']]);
  assert.equal(net.queued.length, 0, 'the output already had it: nothing is sent again');
  assert.equal(s2.read('1K-A', 1, '10:03:00').status, 'duplicate');
});

test('the default clock uses real timers', async () => {
  const config = { filter: { holdSec: 0.05, tagWindowSec: 10 }, races: [race()], outputs: [output()] };
  const saves = [];
  const engine = new Engine({ getConfig: () => config, store: { load: () => null, save: (id) => saves.push(id), remove() {} } });
  const sends = [];
  engine.on('send', (p, outputId) => sends.push([p.bib, outputId]));
  engine.handleRead({ location: '1K-A', bib: '1', tod: parseTod('10:03:00') });
  assert.equal(sends.length, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(sends, [['1', 'o1']]);
  engine.stop();
  assert.ok(saves.includes('r1'), 'what the output acknowledged is saved');
});

test('before-gun reads are ignored, but count again if the gun moves earlier', () => {
  const s = setup();
  const e = s.read('1K-A', 5, '09:59:50.000');
  assert.deepEqual([e.status, e.raceTicks], ['before-gun', -10 * S]);
  assert.equal(s.engine.raceView('r1').beforeGun, 1);
  s.clock.advance(5000);
  assert.equal(s.sends.length, 0);
  s.engine.setGun('r1', '09:58:00.000');
  assert.deepEqual(s.sends.map((p) => [p.bib, p.csTicks]), [['5', 110 * S]]);
  assert.equal(s.engine.raceView('r1').beforeGun, 0);
});

test('a gun moved later drops the crossings now before it, and the real crossing takes over (review-core F3)', () => {
  const s = setup();
  s.read('1K-A', 101, '10:10:00'); // a warm-up stride with the gun wrongly at 10:00
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['101', 1, 'new']]);
  s.engine.setGun('r1', '10:30:00');
  assert.deepEqual(s.engine.crossings('r1'), []);
  assert.equal(s.engine.raceView('r1').beforeGun, 1);
  const real = s.read('1K-A', 101, '10:33:20');
  s.read('1K-A', 102, '10:33:10');
  assert.equal(real.status, 'held', 'not a repeat of the warm-up stride');
  s.clock.advance(2000);
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.raceTicks, c.place]), [['102', 190 * S, 1], ['101', 200 * S, 2]]);
  assert.deepEqual(s.engine.raceData('r1').runners.get('101').splits, [200 * S, null, null], 'no negative split in the .lif');
  // bib 101's warm-up packet was sent less than 60 s ago: its real time goes out as a correction
  assert.deepEqual(sent(s.sends.slice(1)).sort(), [['101', 2, 'correction'], ['102', 1, 'new']]);
  s.engine.setGun('r1', '10:00:00'); // and back: the warm-up read counts again
  assert.equal(s.engine.crossings('r1').find((c) => c.bib === '101').raceTicks, 600 * S);
});

test('a new crossing is held for holdSec of wall clock, then sent', () => {
  const s = setup();
  const e = s.read('1K-A', 1, '10:03:00.000', { first: 'Ann', last: 'Lee', team: 'Central', gender: 'f' });
  assert.deepEqual([e.status, e.splitName, e.raceTicks, e.name, e.team], ['held', '1K', 180 * S, 'Ann Lee', 'Central']);
  s.clock.advance(1999);
  assert.equal(s.sends.length, 0);
  s.clock.advance(1);
  assert.equal(s.sends.length, 1);
  const { race: r, ...packet } = s.sends[0];
  assert.equal(r, s.config.races[0]);
  assert.deepEqual(packet, {
    raceId: 'r1', splitId: 's1', splitIndex: 0, splitCount: 3, splitName: '1K', bib: '1', first: 'Ann', last: 'Lee',
    team: 'Central', gender: 'F', csTicks: 180 * S, lsTicks: 180 * S, place: 1, lapsToGo: 3, gunTicks: parseTod('10:00:00'),
    tod: parseTod('10:03:00'), runnerCount: 1, reason: 'new',
  });
  assert.equal(s.sends[0].isCurrent(), true);
  assert.deepEqual([e.status, e.place], ['sent', 1]);
  assert.deepEqual(s.feeds.filter((f) => f.id === e.id).map((f) => f.status), ['held', 'sent']);
  assert.equal(s.engine.crossings('r1')[0].sentAt, T0 + 2000);

  const z = setup({ filter: { holdSec: 0 } });
  const now = z.read('1K-A', 1, '10:03:00.000');
  assert.deepEqual([now.status, now.place, z.sends.length], ['sent', 1, 1]);
  assert.deepEqual(z.feeds.map((f) => f.status), ['sent']);
});

test('a backwards wall-clock step does not stall a held crossing (review-core F8)', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.clock.jump(-301_000); // Windows time sync, or the timer setting the laptop clock mid-race
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['1', 1, 'new']]);
  s.read('1K-A', 2, '10:03:01');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['1', 1, 'new'], ['2', 2, 'new']]);
});

test('primary and backup inside the tag window are one crossing with the earliest time', () => {
  const s = setup();
  const a = s.read('1K-A', 1, '10:03:00.400');
  s.clock.advance(1000);
  // Revision 2: the earliest read is the crossing, so the B-mat read's row is the one that is held and sent (its race
  // time is what went out, ux-walkthrough F8), and the A-mat row becomes the backup.
  const b = s.read('1K-B', 1, '10:03:00.100');
  assert.equal(b.status, 'held');
  assert.equal(a.status, 'backup');
  assert.match(a.detail, /Same crossing as the read at 3:00\.1 \(0\.3 s later\)/);
  s.read('1K-A', 3, '10:03:05.000');
  const later = s.read('1K-B', 3, '10:03:05.200');
  assert.equal(later.status, 'backup');
  s.clock.advance(1000);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.csTicks]), [['1', rt('3:00.100')]]);
  assert.deepEqual([b.status, b.raceTicks, b.place], ['sent', rt('3:00.100'), 1]);
  s.clock.advance(1000);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.csTicks]), [['1', rt('3:00.100')], ['3', rt('3:05.000')]]);
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.reads, c.place]), [['1', 2, 1], ['3', 2, 2]]);
});

test('an earlier backup after sending is re-sent as a correction within 60 s, and after it; a place alone only within it', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00.500');
  s.read('1K-A', 2, '10:03:01.000');
  s.clock.advance(12_000);
  s.sends.length = 0;
  const c = s.read('1K-B', 1, '10:03:00.200');
  assert.deepEqual([c.status, c.place], ['corrected', 1]);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.reason, p.csTicks, p.place]), [['1', 'correction', rt('3:00.200'), 1]]);
  // A correction that changes the order also moves the other runner.
  const d = s.read('1K-B', 2, '10:02:59.900');
  assert.equal(d.status, 'corrected');
  assert.deepEqual(sent(s.sends.slice(1)), [['2', 1, 'correction'], ['1', 2, 'place-update']]);

  // 9.23 F13: a read that gives a cell another time goes out whatever the minute says (before, it waited for a
  // Resend): the boards get the runner's splits in their columns by themselves
  s.clock.advance(60_000);
  let n = s.sends.length;
  const late = s.read('1K-B', 2, '10:02:59.800');
  assert.equal(late.status, 'corrected');
  // (earlier than the time first sent, 3:01.000)
  assert.match(late.detail, /^Backup read 1\.2 s earlier: re-sent as place 1 with the corrected time\.$/);
  assert.deepEqual(s.sends.slice(n).map((p) => [p.bib, p.reason, p.csTicks, p.place]), [['2', 'correction', rt('2:59.800'), 1]]);
  assert.equal(s.engine.raceData('r1').runners.get('2').splits[0], rt('2:59.800'));
  assert.equal(s.engine.raceView('r1').stale.count, 0);
  // a place alone (another runner's read moved it) keeps the minute: an old split's place would become the runner's
  // place on TrackScore. It is stale: Resend.
  n = s.sends.length;
  s.read('1K-B', 1, '10:02:59.700');
  assert.deepEqual(s.sends.slice(n).map((p) => [p.bib, p.reason, p.place]), [['1', 'correction', 1]]);
  assert.deepEqual(s.engine.raceView('r1').stale, { count: 1, byOutput: [{ outputId: 'o1', name: 'TrackScore', count: 1 }],
    reason: 'changed', splitCountFrom: null, hint: CHANGED_HINT });
  assert.equal(s.engine.crossings('r1').find((x) => x.bib === '2').place, 2);
});

test('a replayed read is a duplicate; outside the tag window it is a repeat', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00.000');
  s.clock.advance(2000);
  assert.equal(s.read('1K-A', 1, '10:03:00.000').status, 'duplicate');
  const r = s.read('1K-A', 1, '10:03:10.001');
  assert.equal(r.status, 'repeat');
  assert.match(r.detail, /already crossed/);
  assert.equal(s.read('1K-B', 1, '10:03:10.000').status, 'backup'); // exactly tagWindowSec apart still counts
  assert.equal(s.read('1K-B', 1, '10:03:10.000').status, 'duplicate'); // and replaying the backup is a duplicate too
  s.clock.advance(5000);
  assert.equal(s.sends.length, 1);
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.tod, c.reads]), [['1', parseTod('10:03:00'), 2]]);
  assert.equal(s.engine.raceView('r1').repeats, 1);
  // Revision 2 (9.3 step 3): the earliest read always opens the crossing, whatever order the reads came in. A read
  // 11 s earlier is the crossing from now on; the old one becomes the repeat.
  s.read('1K-A', 1, '10:02:49.000');
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.tod, c.reads]), [['1', parseTod('10:02:49'), 1]]);
  assert.deepEqual(sent(s.sends.slice(1)), [['1', 1, 'correction']]);
});

test('places rank by time, not arrival; late arrivals re-send places only for fresh sends', () => {
  const s = setup();
  s.read('1K-A', 2, '10:03:01');
  s.read('1K-A', 3, '10:03:02');
  s.read('1K-A', 1, '10:03:00');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['1', 1, 'new'], ['2', 2, 'new'], ['3', 3, 'new']]);

  s.clock.advance(5000);
  s.read('1K-B', 4, '10:03:00.500'); // the mat reported this runner late
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends.slice(3)), [['4', 2, 'new'], ['2', 3, 'place-update'], ['3', 4, 'place-update']]);
  const row = s.engine.feed(10).find((e) => e.bib === '2' && e.status === 'sent');
  assert.deepEqual([row.place, row.detail], [3, 'Place updated to 3 (re-sent).']);

  s.clock.advance(60_000);
  s.read('1K-B', 5, '10:02:59');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends.slice(6)), [['5', 1, 'new']]);
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.place]), [['5', 1], ['1', 2], ['4', 3], ['2', 4], ['3', 5]]);
  // Revision 2 (race-day-sim F4): the four places that could not be re-sent are counted, and a resend is suggested.
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.stale.count, v.resendSuggested], [4, true]);
  assert.match(s.engine.feed(10).find((e) => e.bib === '3').detail, /Now place 5: not re-sent \(first sent \d+ s ago\)/);
});

test('lapsToGo = N - splitIndex; LS comes from the nearest earlier split the bib has', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.read('2K-A', 1, '10:06:10');
  s.read('3K-A', 1, '10:09:30');
  s.read('3K-A', 2, '10:09:40'); // missed 1K and 2K
  s.read('1K-A', 3, '10:03:05');
  s.read('3K-A', 3, '10:09:50'); // missed 2K
  s.clock.advance(2000);
  const pick = (bib, split) => s.sends.find((p) => p.bib === bib && p.splitName === split);
  assert.deepEqual(s.sends.map((p) => `${p.splitName}:${p.bib}`), ['1K:1', '1K:3', '2K:1', '3K:1', '3K:2', '3K:3']);
  assert.deepEqual(['1K', '2K', '3K'].map((n) => [pick('1', n).splitIndex, pick('1', n).lapsToGo, pick('1', n).splitCount]),
    [[0, 3, 3], [1, 2, 3], [2, 1, 3]]);
  assert.deepEqual(['1K', '2K', '3K'].map((n) => pick('1', n).lsTicks), [180 * S, 190 * S, 200 * S]);
  assert.deepEqual([pick('2', '3K').csTicks, pick('2', '3K').lsTicks], [580 * S, 580 * S]);
  assert.equal(pick('3', '3K').lsTicks, (590 - 185) * S);
  assert.equal(pick('3', '3K').runnerCount, 3);
});

test('names: people file first, then the first non-empty stream values (folded to ASCII); gender normalised', () => {
  const people = new Map([['1', { first: 'Ann', last: 'Lee', team: '', gender: 'F' }], ['4', { first: 'Zoë', last: 'D’Arcy', team: 'St. Mary’s' }]]);
  const s = setup({ names: { lookup: (bib) => people.get(bib) } });
  s.read('1K-A', 1, '10:03:00', { first: 'ANN', last: 'LEE', team: 'Central HS', gender: 'male' });
  s.read('1K-A', 2, '10:03:01', { last: 'Moss' });
  s.read('1K-B', 2, '10:03:01.200', { first: 'Bea', last: 'Mossy', team: 'East', gender: 'Girls' });
  s.read('1K-A', 3, '10:03:02', { first: 'Cy', gender: 'x' });
  s.read('1K-A', 4, '10:03:03', { first: 'Zoe', last: 'DArcy' });
  s.read('1K-A', 5, '10:03:04', { first: 'Seán', last: 'O’Neil–Ward', team: 'St. Mary’s “Blue”' });
  s.clock.advance(2000);
  const who = (bib) => {
    const p = s.sends.find((x) => x.bib === bib);
    return [p.first, p.last, p.team, p.gender];
  };
  assert.deepEqual(who('1'), ['Ann', 'Lee', 'Central HS', 'F']);
  assert.deepEqual(who('2'), ['Bea', 'Moss', 'East', 'F']);
  assert.deepEqual(who('3'), ['Cy', '', '', '']);
  // The people file is sent exactly as FinishLynx has it; stream names lose the C1-range punctuation (trackscore-compat F4).
  assert.deepEqual(who('4'), ['Zoë', 'D’Arcy', 'St. Mary’s', '']);
  assert.deepEqual(who('5'), ['Seán', "O'Neil-Ward", 'St. Mary\'s "Blue"', '']);
  assert.equal(s.engine.feed(10).find((e) => e.bib === '1').name, 'Ann Lee');
  assert.equal(s.engine.crossings('r1')[1].name, 'Bea Moss');
  // A people file that loads later wins from then on.
  people.set('3', { first: 'Cyrus', last: 'Diaz', team: 'North', gender: 'M' });
  assert.deepEqual(s.engine.raceData('r1').runners.get('3'), { first: 'Cyrus', last: 'Diaz', team: 'North', gender: 'M', splits: [rt('3:02'), null, null] });
});

test('persistence: the journal rebuilds everything; what the output had is not sent again; the rest goes out at once', () => {
  const store = memStore();
  const clock = fakeClock();
  const races = [race({ contests: ['Girls'] }), race({ id: 'r2', name: 'Boys', contests: ['Boys'], gun: '' })];
  const s1 = setup({ store, clock, races });
  s1.read('1K-A', 1, '10:03:00.000', { contest: 'Girls', first: 'Ann' });
  s1.read('1K-B', 1, '10:03:00.300', { contest: 'Girls' });
  s1.read('1K-A', 50, '10:03:00.000', { contest: 'Boys' });
  assert.equal(store.journal.length, 3, 'every read is journaled at once');
  assert.deepEqual(JSON.parse(store.journal[0]), { t: 'read', seq: 1, at: T0, conn: 1, location: '1K-A', bib: '1',
    tod: parseTod('10:03:00'), contest: 'Girls', first: 'Ann', last: '', team: '', gender: '', raceId: 'r1' });
  clock.advance(2000); // bib 1 sent at +2 s, its ledger saved at +2.5 s
  assert.equal(s1.sends.length, 1);
  clock.advance(500);
  // each race's settings go into its race file at +0.5 s (R6: a race missing from config.json can be found there), the
  // ledger of r1 at +2.5 s
  assert.deepEqual(store.saves, ['r1', 'r2', 'r1']);
  assert.deepEqual(JSON.parse(store.data.get('r1')).ledgers.o1.map((e) => e[0]), ['1|s1']);
  assert.deepEqual(JSON.parse(store.data.get('r2')).race, races[1]);
  s1.read('Finish', 7, '10:18:00', { contest: 'Girls' });
  s1.read('1K-A', 2, '10:03:30', { contest: 'Girls' }); // held until +4.5 s
  clock.advance(600);
  s1.engine.stop();
  s1.engine.markCleanStop();
  clock.advance(10_000);
  assert.equal(s1.sends.length, 1); // the old instance is gone before bib 2 went out

  const s2 = setup({ store, clock, races, start: false });
  assert.equal(s2.sends.length, 0); // never from inside the constructor: nobody was listening yet
  clock.advance(0);
  assert.deepEqual(s2.sends.map((p) => [p.bib, p.reason, p.place, p.first]), [['2', 'new', 2, '']]);
  const v = s2.engine.raceView('r1');
  assert.deepEqual([v.finished, v.runners, v.lastReadAt], [1, 2, T0 + 2500]);
  assert.deepEqual(s2.engine.crossings('r1').map((c) => [c.bib, c.reads, c.reason]), [['1', 2, 'new'], ['2', 1, 'new']]);
  assert.equal(s2.engine.raceView('r2').pending, 1);
  assert.equal(s2.read('1K-A', 1, '10:03:00.000', { contest: 'Girls' }).status, 'duplicate'); // replay after restart
  assert.equal(s2.engine.seen().locations.find((l) => l.name === '1K-A').count, 3, 'seen() comes back too');
  s2.engine.setGun('r2', '10:00:00');
  assert.deepEqual(s2.sends.slice(1).map((p) => [p.raceId, p.bib]), [['r2', '50']]);
  s2.engine.stop();
});

test('a hard kill loses no read: the journal is written before the read is used (race-day-sim F2)', () => {
  const store = memStore();
  const clock = fakeClock();
  const s1 = setup({ store, clock });
  s1.read('1K-A', 1100, '10:05:04.000');
  // the process dies here: no stop(), no save, no timers
  const s2 = setup({ store, clock });
  assert.deepEqual(s2.engine.crossings('r1').map((c) => [c.bib, c.tod]), [['1100', parseTod('10:05:04')]]);
  s2.read('1K-B', 1100, '10:05:04.300'); // the backup mat afterwards: a backup, not the split time
  clock.advance(2000);
  assert.deepEqual(s2.sends.map((p) => [p.bib, p.csTicks]), [['1100', rt('5:04.000')]]);

  // A torn last line from a power cut is skipped by the store; a garbage record in the journal is ignored here.
  store.journal.push('{"t":"read","seq":');
  const s3 = setup({ store: { ...store, loadJournal: () => [...store.journal.slice(0, -1).map((l) => JSON.parse(l)), { t: 'read', seq: 'x' }] }, clock });
  assert.equal(s3.engine.crossings('r1').length, 1);
});

test('packets an output had not taken when Split Relay stopped are delivered after the restart (race-day-sim F1)', () => {
  const store = memStore();
  const clock = fakeClock();
  const net = fakeNet();
  const s1 = setup({ store, clock, net });
  s1.read('1K-A', 101, '10:03:00');
  clock.advance(2000);
  net.hold.add('o1'); // TrackScore unreachable: packets queue in the output
  for (const bib of [201, 202, 203]) s1.read('1K-A', bib, `10:03:1${bib - 200}`);
  clock.advance(2000);
  assert.equal(net.queued.length, 3);
  s1.engine.stop();
  net.dropAll(); // OutputManager.stop(): the queue is gone
  s1.engine.markCleanStop();
  net.hold.delete('o1');
  const s2 = setup({ store, clock, net });
  // the same output before and after: bib 101 once, then what it never acknowledged
  assert.deepEqual(sent(s2.sends), [['101', 1, 'new'], ['201', 2, 'new'], ['202', 3, 'new'], ['203', 4, 'new']]);
});

test('after a kill, what the outputs took in their last minute goes out again once RR12 has caught up; after a clean stop nothing does (race-day-sim F3)', () => {
  // An acknowledgement means this PC's network stack took the bytes; a killed process loses what the stack still
  // held (measured: 228 of 600 splits never reached a slow target after a kill).
  const store = memStore();
  const clock = fakeClock();
  const net = fakeNet();
  const s1 = setup({ store, clock, net });
  s1.read('1K-A', 1, '10:03:00');
  clock.advance(2500); // bib 1 acknowledged at +2 s and saved
  clock.advance(120_000); // two quiet minutes
  s1.read('1K-A', 2, '10:05:00');
  s1.read('2K-A', 1, '10:06:00');
  s1.read('1K-A', 3, '10:05:10');
  s1.read('1K-A', 5, '10:05:15');
  clock.advance(2500); // all four acknowledged and saved
  s1.read('Finish', 3, '10:12:00'); // bib 3 finishes before the kill
  clock.advance(1000);
  assert.deepEqual(sent(s1.sends), [['1', 1, 'new'], ['2', 2, 'new'], ['3', 3, 'new'], ['5', 4, 'new'], ['1', 1, 'new']]);

  // killed: no stop(), no markCleanStop()
  const s2 = setup({ store, clock, net });
  assert.equal(s2.sends.length, 5, 'nothing at once: RR12 first sends what it queued while Split Relay was down');
  assert.match(s2.logs.join('\n'), /did not stop cleanly last time\. The 4 packets .* go out again in 15 s/);
  s2.read('Finish', 5, '10:12:30'); // bib 5 finished during the outage; RR12 sends it after the restart
  clock.advance(14_000);
  assert.equal(s2.sends.length, 5);
  clock.advance(1000);
  // bib 1's 1K went two minutes before the last acknowledgement: it left long ago. Of the last minute, bibs 3 and 5
  // have finished and get nothing (TrackScore keeps their finish places): bib 2's 1K and bib 1's 2K go again.
  assert.deepEqual(sent(s2.sends.slice(5)), [['2', 2, 'new'], ['1', 1, 'new']]);
  assert.equal(s2.engine.raceView('r1').resendSuggested, false, 'nothing is out of date afterwards');

  // A clean stop (outputs closed first, then the record): the next start sends nothing again.
  clock.advance(1000);
  s2.engine.stop();
  s2.engine.markCleanStop();
  assert.deepEqual(JSON.parse(store.journal.at(-1)), { t: 'stop', at: clock.now() });
  const n = s2.sends.length;
  const s3 = setup({ store, clock, net });
  clock.advance(20_000);
  assert.equal(s3.sends.length, n, 'a clean restart trusts the acknowledgements');
  assert.ok(!s3.logs.some((l) => /did not stop cleanly/.test(l)));

  // A read after the clean start, then a kill: unclean again. Everything acknowledged within a minute of the last
  // acknowledgement goes again (bib 2's 1K and bib 1's 2K were delivered again only seconds before), course order.
  s3.read('1K-A', 4, '10:05:20');
  clock.advance(2500);
  assert.deepEqual(sent(s3.sends.slice(n)), [['4', 5, 'new']]);
  const s4 = setup({ store, clock, net });
  clock.advance(15_000);
  assert.deepEqual(sent(s4.sends.slice(n + 1)), [['2', 2, 'new'], ['4', 5, 'new'], ['1', 1, 'new']]);

  // Killed again, then stopped cleanly before the 15 s were up: the saved ledger forgets them, so the next start sends them.
  const m = s4.sends.length;
  const s5 = setup({ store, clock, net });
  clock.advance(5000);
  s5.engine.stop();
  s5.engine.markCleanStop();
  assert.equal(s5.sends.length, m);
  const s6 = setup({ store, clock, net });
  assert.deepEqual(sent(s6.sends.slice(m)), [['2', 2, 'new'], ['4', 5, 'new'], ['1', 1, 'new']]);
});

test('a queued packet that is out of date by the time the output is back is not sent', () => {
  const lynx = new Map([['r1', new Map()]]);
  const net = fakeNet();
  const s = setup({ net, finishers: (id) => lynx.get(id) });
  net.hold.add('o1');
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:01');
  s.clock.advance(2000);
  s.read('1K-B', 3, '10:02:59'); // bib 2's queued place 2 becomes place 3
  s.clock.advance(2000);
  lynx.get('r1').set('1', rt('9:00')); // bib 1 finished while TrackScore was unreachable
  s.engine.converge();
  net.flush('o1');
  // bib 1's queued split would overwrite its finish place; bib 2's first packet carried a place that is now wrong
  assert.deepEqual(sent(s.sends), [['3', 1, 'new'], ['2', 3, 'new']]);
});

test('an output that could not take packets gets what it missed once it can (broken script, then fixed)', () => {
  const s = setup({ outputs: [output(), output({ id: 'o2', name: 'Live results' })] });
  const live = s.net.of('o2');
  s.net.refuse.add('o2');
  s.read('1K-A', 301, '10:03:00');
  s.clock.advance(2000);
  assert.deepEqual([s.sends.length, live.length], [1, 0]);
  const status = (scriptOk, at) => [{ id: 'o1', enabled: true, state: 'connected', scriptOk: true, clients: 1, scriptLoadedAt: 1 },
    { id: 'o2', enabled: true, state: scriptOk ? 'connected' : 'error', scriptOk, clients: 1, scriptLoadedAt: at }];
  s.engine.converge(status(false, null));
  assert.equal(live.length, 0);
  s.net.refuse.delete('o2'); // the operator fixed the script path
  s.engine.converge(status(true, 5));
  assert.deepEqual(live.map((p) => [p.bib, p.reason]), [['301', 'new']]);
  s.engine.converge(status(true, 5));
  assert.equal(live.length, 1, 'nothing twice');
  assert.equal(s.sends.length, 1);
});

test("changing an output's races sends it that race's splits; a new output catches up", () => {
  const s = setup({
    races: [race({ contests: ['Girls'] }), race({ id: 'r2', name: 'Boys', contests: ['Boys'] })],
    outputs: [output({ races: ['r1'] })],
  });
  s.read('1K-A', 1, '10:03:00', { contest: 'Girls' });
  s.read('1K-A', 2, '10:03:01', { contest: 'Boys' });
  s.clock.advance(2000);
  assert.deepEqual(s.sends.map((p) => p.raceId), ['r1']);
  s.config.outputs[0].races = ['r1', 'r2'];
  s.engine.configChanged();
  assert.deepEqual(s.sends.map((p) => [p.raceId, p.bib, p.reason]), [['r1', '1', 'new'], ['r2', '2', 'new']]);
  s.config.outputs.push(output({ id: 'o3', name: 'Board' }));
  s.engine.configChanged();
  assert.deepEqual(s.net.of('o3').map((p) => p.bib), ['1', '2']);
  // an output that is switched off misses nothing: it gets the rest when it is switched on again
  s.config.outputs[1].enabled = false;
  s.engine.configChanged();
  s.read('1K-A', 3, '10:03:02', { contest: 'Girls' });
  s.clock.advance(2000);
  s.config.outputs[1].enabled = true;
  s.engine.configChanged();
  assert.deepEqual(s.net.of('o3').map((p) => p.bib), ['1', '2', '3']);
});

test('the contest of a race narrowed: reads that belong elsewhere move out, waiting or not (ux-walkthrough F1)', () => {
  const s = setup({ races: [race({ name: 'Girls Varsity 5K', contests: [], gun: '' })] });
  const boy = s.read('1K-A', 888, '10:03:00', { contest: 'Boys Varsity 5K' });
  s.read('1K-A', 101, '10:03:05', { contest: 'Girls Varsity 5K' });
  assert.equal(boy.status, 'waiting-gun');
  s.config.races[0].contests = ['Girls Varsity 5K'];
  s.engine.configChanged();
  // Revision 4 (9.2): the race let go of the contest's reads, and they came to no other race first: set aside.
  assert.equal(boy.status, 'set-aside');
  assert.equal(boy.detail, "Reads of 'Boys Varsity 5K' are not used: 'Girls Varsity 5K' no longer lists it. List the contest on an Active race to use them.");
  assert.equal(s.engine.raceView('r1').pending, 1);
  s.clock.advance(2000);
  s.engine.setGun('r1', '10:00:00');
  assert.deepEqual(sent(s.sends), [['101', 1, 'new']], 'the boy is not sent in the girls race');
  // a Boys race added later takes the boy's read
  s.config.races.push(race({ id: 'r2', name: 'Boys Varsity 5K', contests: ['Boys Varsity 5K'] }));
  s.engine.configChanged();
  assert.equal(boy.raceId, 'r2');
  s.clock.advance(1);
  assert.deepEqual(sent(s.sends.slice(1)), [['888', 1, 'new']]);
  assert.ok(s.store.journal.some((l) => JSON.parse(l).t === 'route'), 'moves are journaled');

  // A catch-all race keeps a contest only until another race lists it.
  const c = setup({ races: [race({ contests: [] })] });
  c.read('1K-A', 5, '10:03:00', { contest: 'JV' });
  c.clock.advance(2000);
  assert.equal(c.engine.raceView('r1').runners, 1);
  c.config.races.push(race({ id: 'jv', name: 'JV', contests: ['JV'] }));
  c.engine.configChanged();
  assert.deepEqual([c.engine.raceView('r1').runners, c.engine.raceView('jv').runners], [0, 1]);
  assert.equal(c.engine.raceView('r1').stale.count, 1, 'TrackScore had it in the catch-all race: a resend is suggested');
});

test('store failures are logged, never thrown', async () => {
  const bad = {
    load: () => { throw new Error('disk on fire'); },
    save: () => Promise.reject(new Error('share went away')),
    remove: () => {},
    appendJournal: () => { throw new Error('disk full'); },
    loadJournal: () => { throw new Error('unreadable'); },
  };
  const s = setup({ store: bad });
  assert.match(s.logs.join('\n'), /disk on fire/);
  assert.match(s.logs.join('\n'), /unreadable/);
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:01');
  assert.equal(s.logs.filter((l) => /disk full/.test(l)).length, 1, 'once a minute, not once per read');
  s.clock.advance(2000);
  assert.equal(s.sends.length, 2, 'the reads are still used');
  s.clock.advance(1000);
  await new Promise((r) => setImmediate(r));
  assert.match(s.logs.join('\n'), /share went away/);
});

test('configChanged keeps crossings of surviving races and drops removed ones', () => {
  const s = setup({ races: [race({ id: 'a', name: 'A', contests: ['A'] }), race({ id: 'b', name: 'B', contests: ['B'] })] });
  s.read('1K-A', 1, '10:03:00', { contest: 'A' });
  s.read('1K-A', 2, '10:03:00', { contest: 'B' });
  s.clock.advance(2000);
  s.read('1K-A', 3, '10:03:01', { contest: 'B' }); // held when its race is deleted
  s.config.races = [{ ...s.config.races[0], name: 'A renamed' }, race({ id: 'c', name: 'C', contests: ['C'] })];
  s.raceEvents.length = 0;
  s.engine.configChanged({ deleted: ['b'] }); // DELETE /api/races/b
  s.clock.advance(5000);
  assert.deepEqual(s.sends.map((p) => p.bib), ['1', '2']);
  assert.deepEqual(s.store.removed, ['b']);
  assert.equal(s.engine.raceView('b'), null);
  assert.deepEqual(s.engine.crossings('b'), []);
  assert.equal(s.engine.raceView('a').name, 'A renamed');
  assert.deepEqual(s.engine.crossings('a').map((c) => c.bib), ['1']);
  assert.equal(s.engine.raceView('c').runners, 0);
  assert.ok(s.raceEvents.includes('b') && s.raceEvents.includes('c'));
  // B held reads of contest B when it was deleted: they are out of use for good, and the contest is set aside so new
  // reads of it are not used either (revision 5, R2)
  assert.deepEqual(s.feeds.filter((e) => e.bib === '3').at(-1).status, 'race-deleted');
  assert.equal(s.read('1K-A', 4, '10:03:00', { contest: 'B' }).status, 'set-aside');
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['B', "its race 'B' was deleted", 1]]);
});

test('editing a split mid-race: crossings follow the current mapping; a reorder or a lost crossing suggests a resend', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.clock.advance(2000);
  s.config.races[0].splits[0].name = 'Mile 1';
  s.engine.configChanged();
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.splitName]), [['1', 's1', 'Mile 1']]);
  assert.equal(s.engine.raceView('r1').resendSuggested, false);
  assert.equal(s.read('1K-B', 1, '10:03:00.200').status, 'backup');

  s.config.races[0].splits.reverse(); // lapsToGo changes for every split, so TrackScore needs the crossings again
  s.clock.advance(61_000);
  s.engine.configChanged();
  assert.equal(s.engine.raceView('r1').resendSuggested, true);
  assert.deepEqual(s.engine.resendRace('r1'), { sent: 1, skippedFinished: 0, outputs: 1 });
  assert.deepEqual([s.sends.at(-1).splitIndex, s.sends.at(-1).lapsToGo], [2, 1]);
  assert.equal(s.engine.raceView('r1').resendSuggested, false);

  // Revision 2 (9.3 step 1): a read counts for the split its timing point is mapped to NOW. Unmapping 1K-A/1K-B
  // takes bib 1's crossing away; it cannot be unsent, so it is stale.
  s.config.races[0].splits.find((sp) => sp.id === 's1').sources = ['1K-X', '1K-Y'];
  s.engine.configChanged();
  assert.deepEqual(s.engine.crossings('r1'), []);
  assert.equal(s.engine.raceView('r1').stale.count, 1);
  assert.equal(s.read('1K-A', 1, '10:03:00.300').status, 'unmapped');
  s.config.races[0].splits = s.config.races[0].splits.filter((sp) => sp.id !== 's1');
  s.engine.configChanged();
  assert.deepEqual(s.engine.crossings('r1'), []);
});

test('a gun change recomputes race times from the stored times of day: corrections while fresh, stale after 60 s', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:01');
  s.clock.advance(2000);
  s.raceEvents.length = 0;
  // Revision 2 (9.4): a different gun is a correction while the split is fresh on the scoreboard.
  s.engine.setGun('r1', '10:00:30.000');
  assert.deepEqual(s.raceEvents, ['r1']);
  assert.deepEqual(s.sends.slice(2).map((p) => [p.bib, p.reason, p.csTicks]), [['1', 'correction', 150 * S], ['2', 'correction', 151 * S]]);
  s.clock.advance(61_000);
  s.engine.setGun('r1', '10:01:00.000');
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.tod, c.raceTicks]), [[parseTod('10:03:00'), 120 * S], [parseTod('10:03:01'), 121 * S]]);
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.gunTicks, v.gunText, v.resendSuggested, v.stale.count], [parseTod('10:01:00'), '10:01:00.000', true, 2]);
  assert.equal(s.sends.length, 4); // nothing goes out until the operator resends
  assert.equal(s.engine.raceData('r1').runners.get('1').splits[0], 120 * S);
  // The gun can also change through a plain race edit.
  s.config.races[0].gun = '10:02:00.000';
  s.engine.configChanged();
  assert.equal(s.engine.crossings('r1')[0].raceTicks, 60 * S);
});

test('resendRace re-sends every sent crossing in split order, then time', () => {
  const s = setup();
  s.read('2K-A', 2, '10:06:00');
  s.read('1K-A', 2, '10:03:01');
  s.read('1K-A', 1, '10:03:00');
  s.read('2K-A', 1, '10:06:05');
  s.clock.advance(2000);
  s.read('1K-A', 3, '10:03:10'); // still held: goes out on its own
  s.sends.length = 0;
  assert.deepEqual(s.engine.resendRace('r1'), { sent: 4, skippedFinished: 0, outputs: 1 });
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.bib, p.place, p.reason]), [
    ['1K', '1', 1, 'resend'], ['1K', '2', 2, 'resend'], ['2K', '2', 1, 'resend'], ['2K', '1', 2, 'resend'],
  ]);
  assert.equal(s.engine.crossings('r1')[0].reason, 'resend');
  assert.deepEqual(s.engine.resendRace('nope'), { sent: 0, skippedFinished: 0, outputs: 0 });
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends.slice(4)), [['3', 3, 'new']]);
});

test('resend skips finished runners unless asked, and refuses a race that is not active unless forced (trackscore-compat F2, F3)', () => {
  const lynx = new Map([['r1', new Map([['2', rt('15:41.2')]])]]);
  const s = setup({ finishers: (id) => lynx.get(id) });
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 3, '10:03:02');
  s.clock.advance(2000);
  s.read('1K-A', 2, '10:03:01'); // FinishLynx has already finished bib 2: never sent live
  s.read('Finish', 3, '10:16:00');
  s.clock.advance(2000);
  s.sends.length = 0;
  assert.deepEqual(s.engine.resendRace('r1'), { sent: 1, skippedFinished: 2, outputs: 1 });
  assert.deepEqual(sent(s.sends), [['1', 1, 'resend']]);
  assert.deepEqual(s.engine.resendRace('r1', { includeFinished: true }), { sent: 3, skippedFinished: 0, outputs: 1 });
  assert.deepEqual(sent(s.sends.slice(1)), [['1', 1, 'resend'], ['2', 2, 'resend'], ['3', 3, 'resend']]);

  s.config.races[0].active = false;
  s.engine.configChanged();
  s.sends.length = 0;
  assert.throws(() => s.engine.resendRace('r1'), (err) => err.code === 'RACE_INACTIVE' &&
    /Girls Varsity 5K is not active\. Resending it would make TrackScore switch to its event and clear the race it is showing/.test(err.message));
  assert.equal(s.sends.length, 0);
  assert.deepEqual(s.engine.resendRace('r1', { force: true }), { sent: 1, skippedFinished: 2, outputs: 1 });
});

test('stale splits are counted once each (9.23 F14), per output too, and a resend clears them', () => {
  const s = setup({ outputs: [output(), output({ id: 'o2', name: 'Live results' })] });
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:01');
  s.read('Finish', 2, '10:15:00');
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['1', 1, 'new']]);
  s.clock.advance(61_000);
  s.engine.setGun('r1', '10:00:01');
  // (9.23 F14: bib 1's 1K out of date on both outputs is one split out of date, not two)
  assert.deepEqual(s.engine.raceView('r1').stale, { count: 1, byOutput: [
    { outputId: 'o1', name: 'TrackScore', count: 1 }, { outputId: 'o2', name: 'Live results', count: 1 }],
    reason: 'changed', splitCountFrom: null, hint: CHANGED_HINT });
  assert.equal(s.engine.raceView('r1').resendSuggested, true);
  // the Resend dialog's number is the toast's: bib 1's 1K goes, bib 2's (finished) only with the box
  assert.deepEqual(s.engine.raceView('r1').resend, { count: 1, finished: 1 });
  assert.deepEqual(s.engine.resendRace('r1'), { sent: 1, skippedFinished: 1, outputs: 2 });
  assert.deepEqual(s.engine.raceView('r1').stale, { count: 0, byOutput: [], reason: null, splitCountFrom: null, hint: null });
});

test('a finished runner whose split place moved is not stale (FinishLynx owns the place); a changed time is listed for Send with finish place', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:02');
  s.clock.advance(2000);
  s.read('Finish', 2, '10:15:00');
  s.clock.advance(61_000);
  s.read('1K-A', 3, '10:03:01'); // bib 2 (finished) drops from 2nd to 3rd at 1K
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends).slice(2), [['3', 2, 'new']]);
  assert.equal(s.engine.raceView('r1').stale.count, 0, 'nothing to nag about');
  assert.equal(s.engine.raceView('r1').finishedNotSent, 0);
  s.engine.setGun('r1', '10:00:01');
  // bibs 1 and 2 show old times; bib 3 was sent a moment ago, so it got the correction. Bib 1's is for a Resend; bib
  // 2 has finished, which a Resend leaves out (revision 10): Review lists it, sent with an old time, for Send with
  // finish place
  assert.equal(s.engine.raceView('r1').stale.count, 1);
  assert.equal(s.engine.raceView('r1').finishedNotSent, 1);
  assert.deepEqual(s.engine.review('r1').finishedNotSent.map((x) => [x.bib, x.timeText, x.sentOld?.timeText]), [['2', '3:01.0', '3:02.0']]);
  assert.deepEqual(sent(s.sends).slice(3), [['3', 2, 'correction']]);
});

test('a forced resend of a race that is not active sends its crossings, even ones still in their hold', () => {
  const s = setup({ races: [race({ contests: ['G'] })] });
  s.read('1K-A', 1, '10:03:00', { contest: 'G' });
  s.read('1K-A', 2, '10:03:01', { contest: 'G' });
  s.config.races[0].active = false; // switched off while both crossings are in their hold: it keeps them (R1)
  s.engine.configChanged();
  assert.equal(s.read('1K-A', 3, '10:03:02', { contest: 'G' }).status, 'paused');
  s.clock.advance(1000);
  assert.equal(s.sends.length, 0, 'nothing goes out live for a race that is not active');
  assert.equal(s.engine.raceView('r1').runners, 2, 'a new read waits for it in no race (C1)');
  assert.deepEqual(s.engine.resendRace('r1', { force: true }), { sent: 2, skippedFinished: 0, outputs: 1 });
  assert.deepEqual(sent(s.sends), [['1', 1, 'resend'], ['2', 2, 'resend']]);
});

test('clearRace forgets crossings, waiting reads, finishes and what was sent', () => {
  const s = setup({ races: [race(), race({ id: 'r2', name: 'Boys', contests: ['Boys'], gun: '' })] });
  s.read('1K-A', 1, '10:03:00');
  s.clock.advance(2000);
  s.read('Finish', 1, '10:18:00');
  s.read('1K-A', 2, '10:03:05'); // held
  s.read('1K-A', 9, '09:59:00'); // before the gun
  s.read('1K-A', 50, '10:03:00', { contest: 'Boys' });
  assert.equal(s.engine.clearRace('r1'), true);
  assert.equal(s.engine.clearRace('r2'), true);
  assert.equal(s.engine.clearRace('nope'), false);
  s.clock.advance(5000);
  assert.equal(s.sends.length, 1);
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.runners, v.finished, v.pending, v.beforeGun, v.splits[0].crossings, v.stale.count], [0, 0, 0, 0, 0, 0]);
  assert.equal(s.engine.raceView('r2').pending, 0);
  assert.deepEqual(JSON.parse(s.store.data.get('r1')), { version: 2, clearedSeq: 5, ledgers: {}, race: s.config.races[0] });
  assert.ok(s.store.journal.some((l) => JSON.parse(l).t === 'clear'));
  // Clear, then Replay in RR12, rebuilds the race (race day 2026-10-21): the cleared reads count again as new reads,
  // journaled again, and go out again. A replayed read from before the gun is still before the gun.
  const lines = s.store.journal.length;
  const again = s.read('1K-A', 1, '10:03:00');
  assert.equal(again.status, 'held');
  assert.equal(s.read('Finish', 1, '10:18:00').status, 'finish');
  assert.equal(s.read('1K-A', 9, '09:59:00').status, 'before-gun');
  assert.equal(s.store.journal.length, lines + 3);
  s.clock.advance(2000);
  assert.deepEqual([s.engine.raceView('r1').runners, s.engine.raceView('r1').finished], [1, 1]);
  // an exact repeat of a read that counts again is a plain duplicate, as always
  assert.equal(s.read('1K-A', 1, '10:03:00').status, 'duplicate');
});

test('feed is a ring buffer of 1000, newest first', () => {
  const s = setup({ races: [] });
  for (let i = 1; i <= 1100; i++) s.read('1K-A', i, '10:03:00');
  assert.equal(s.engine.feed().length, 200);
  const all = s.engine.feed(5000);
  assert.equal(all.length, 1000);
  assert.deepEqual([all[0].bib, all.at(-1).bib], ['1100', '101']);
  assert.ok(all.every((e, i) => i === 0 || e.id < all[i - 1].id));
  assert.deepEqual(s.engine.feed(0), []);
  // port: the RR12 input port the line came in on (9.15 L2); null for a read handed over without one
  assert.deepEqual(Object.keys(all[0]).sort(), ['at', 'bib', 'detail', 'id', 'location', 'name', 'place', 'port', 'raceId', 'raceName',
    'raceTicks', 'splitName', 'status', 'team', 'tod'].sort());
  assert.equal(all[0].port, null);
});

test('raceData() gives the .lif writer race times per split; raceView() paints a race card', () => {
  const s = setup();
  s.read('1K-A', 1, '10:03:00.123', { first: 'Ann', last: 'Lee', team: 'Central', gender: 'F', contest: 'Girls' });
  s.read('3K-A', 1, '10:09:30');
  s.read('2K-A', 2, '10:06:30', { first: 'Bo', last: 'Ng', team: 'West', gender: 'M' });
  s.read('Finish', 2, '10:18:00');
  s.read('Pre-start', 2, '09:58:00');
  const d = s.engine.raceData('r1'); // held crossings count too: the .lif should not lag 2 s behind
  assert.equal(d.splitCount, 3);
  assert.equal(d.gun, parseTod('10:00:00'));
  assert.ok(d.runners instanceof Map);
  assert.deepEqual(d.runners.get('1'), { first: 'Ann', last: 'Lee', team: 'Central', gender: 'F', splits: [rt('3:00.123'), null, rt('9:30')] });
  assert.deepEqual(d.runners.get('2'), { first: 'Bo', last: 'Ng', team: 'West', gender: 'M', splits: [null, rt('6:30'), null] });
  assert.equal(s.engine.raceData('nope'), null);

  s.clock.advance(5 * 60_000);
  assert.deepEqual(s.engine.raceView('r1'), {
    id: 'r1', name: 'Girls Varsity 5K', active: true, inputPort: null, gunTicks: parseTod('10:00:00'), gunText: '10:00:00.000',
    elapsedTicks: 300 * S, splitCount: 3,
    splits: [
      { id: 's1', name: '1K', sources: ['1K-A', '1K-B'], earliest: '', crossings: 1, lastAt: T0, sending: true, held: 0 },
      { id: 's2', name: '2K', sources: ['2K-A', '2K-B'], earliest: '', crossings: 1, lastAt: T0, sending: true, held: 0 },
      { id: 's3', name: '3K', sources: ['3K-A'], earliest: '', crossings: 1, lastAt: T0, sending: true, held: 0 },
    ],
    runners: 2, finished: 1, pending: 0, waitingGun: 0, beforeGun: 0, startArea: 0, afterFinish: 0, outOfOrder: 0, repeats: 0,
    tooEarly: 0, extra: 0, passes: 0, finishedNotSent: 1, unmapped: [{ name: 'Pre-start', count: 1 }],
    contestsSeen: [{ name: '(blank)', count: 4, blank: true }, { name: 'Girls', count: 1, blank: false }],
    stale: { count: 0, byOutput: [], reason: null, splitCountFrom: null, hint: null },
    leftover: { count: 0, runners: [], byOutput: [], text: null },
    // 9.17: bib 1 is missing 2K (it has 3K); bib 2, finished, 1K and 3K, but with no FinishLynx place they can't be sent
    // (9.23: the counts gained the look-wrong flags, the runners with the operator's decisions, and the made-up times)
    review: { missing: 3, estimable: 1, checks: 0, checkRunners: 0, manual: 0, flagged: 0, pinned: 0, madeUp: 0 },
    // (9.23 F14: what a Resend sends: bib 1's two splits; bib 2's (finished) with the box only)
    resendSuggested: false, resend: { count: 2, finished: 1 }, lastReadAt: T0, lynxStart: null, lynxName: null,
  });
  assert.equal(s.engine.raceView('nope'), null);
});

test('clockLagSec is the median of arrival time minus read time over recent reads (review-core F6)', () => {
  const s = setup();
  assert.equal(s.engine.clockLagSec(), null);
  // reads arrive about 2 s after the passing; one RR12 replay of an old read does not move the median
  for (let i = 0; i < 9; i++) {
    s.clock.advance(1000);
    const tod = new Date(s.clock.now() - 2000 - i * 10);
    s.read('1K-A', i + 1, `${tod.getHours()}:${String(tod.getMinutes()).padStart(2, '0')}:${String(tod.getSeconds()).padStart(2, '0')}.${String(tod.getMilliseconds()).padStart(3, '0')}`);
  }
  s.read('1K-A', 99, '09:00:00');
  assert.ok(Math.abs(s.engine.clockLagSec() - 2.0) <= 0.1, String(s.engine.clockLagSec()));
});

test('a v1 race file (crossings, not reads) is converted without sending anything twice', () => {
  const store = memStore();
  store.data.set('r1', JSON.stringify({
    version: 1, seq: 2, gunTicks: parseTod('10:00:00'), splitSig: 's1\ns2\ns3', resendSuggested: false, lastReadAt: T0,
    crossings: [
      { bib: '1', splitId: 's1', tod: parseTod('10:03:00'), seq: 1, arrivedAt: T0, readTods: [parseTod('10:03:00'), parseTod('10:03:00.300')],
        sentAt: T0 + 2000, firstSentAt: T0 + 2000, sentPlace: 1, reason: 'new' },
      { bib: '2', splitId: 's1', tod: parseTod('10:03:01'), seq: 2, arrivedAt: T0, readTods: [parseTod('10:03:01')],
        sentAt: null, firstSentAt: null, sentPlace: null, reason: null },
    ],
    pending: [], early: [], finished: [], names: [{ bib: '1', first: 'Ann', last: 'Lee', team: '', gender: 'F' }], locations: [],
  }));
  const s = setup({ store, races: [race({ contests: ['Girls'] })] });
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.reads]), [['1', 2], ['2', 1]]);
  s.clock.advance(2000);
  assert.deepEqual(sent(s.sends), [['2', 2, 'new']], 'bib 1 was sent before the upgrade');
  assert.equal(s.engine.raceData('r1').runners.get('1').first, 'Ann');
  assert.equal(store.journal.length, 3);
  s.clock.advance(1000);
  assert.equal(JSON.parse(store.data.get('r1')).version, 2);
});

test('derivation is the same live, after a restart, and whatever order the reads arrive in', () => {
  const reads = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  // Times in ms are bib * 700 + multiples of 41 (+ the bib mod 41), so two runners never share an exact time: a tie
  // is broken by arrival order, by design, and would make the comparison below depend on it.
  for (let bib = 1; bib <= 40; bib++) {
    for (const [i, loc] of [[0, '1K'], [1, '2K'], [2, '3K']]) {
      if (rand() < 0.1) continue; // a missed mat
      const t = 180_000 * (i + 1) + bib * 700 + 41 * Math.floor(rand() * 70) + (bib % 41);
      reads.push([`${loc}-A`, bib, t]);
      if (loc !== '3K' && rand() < 0.8) reads.push([`${loc}-B`, bib, t + 41 * Math.floor((rand() - 0.3) * 24)]);
    }
    if (rand() < 0.5) reads.push(['Finish', bib, 900_000 + bib * 1000]);
    if (rand() < 0.1) reads.push(['1K-A', bib, 1_000_000 + bib * 1000]); // walking back over a mat
  }
  const tod = (ms) => {
    const h = 10 + Math.floor(ms / 3_600_000);
    return `${h}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const run = (order) => {
    const store = memStore();
    const s = setup({ store, races: [race({ splits: [
      { id: 's1', name: '1K', sources: ['1K-A', '1K-B'] }, { id: 's2', name: '2K', sources: ['2K-A', '2K-B'] },
      { id: 's3', name: '3K', sources: ['3K-A'] }] })] });
    for (const [loc, bib, t] of order) s.read(loc, bib, tod(t));
    s.clock.advance(2000);
    return { s, store, view: JSON.stringify(s.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.tod, c.place, c.reads])) };
  };
  const live = run(reads);
  const shuffled = [...reads].sort(() => rand() - 0.5);
  assert.equal(run(shuffled).view, live.view, 'arrival order does not matter');
  const again = setup({ store: live.store });
  assert.equal(JSON.stringify(again.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.tod, c.place, c.reads])), live.view, 'a restart rebuilds the same');
  // what the scoreboard was told last equals the derivation
  const last = new Map();
  for (const p of live.s.sends) last.set(`${p.bib}|${p.splitId}`, p.place);
  for (const c of live.s.engine.crossings('r1')) if (last.has(`${c.bib}|${c.splitId}`)) assert.equal(last.get(`${c.bib}|${c.splitId}`), c.place);
});

test('performance: 600 runners x 3 splits x 2 mats with derivation in well under a second', (t) => {
  // The fake clock runs 11 minutes of race in well under a second, so the race file is "saved" about 1300 times; a
  // store that stringifies each save would measure JSON.stringify, not the engine (the real store writes in the
  // background and only the newest save of a burst). CPU time, not wall time.
  // The fastest of up to 5 runs counts, each run from scratch (a new engine, store and journal); a run under both
  // limits ends the test early. The first run pays for V8 compiling the engine, and it is the one the other test
  // files, all starting at once, slow down: it took 300-480 ms alone and 600-1015 ms in the full suite, where a
  // 1000 ms limit on it failed now and then. The later runs measure the engine itself: the fastest of 5 took 78-125 ms,
  // alone or in the suite, and 265-330 ms with three times the engine work in the measured span. So the limit is
  // 200 ms: 1.6 times the slowest normal best, while an engine 3 times slower fails. The restart limit stays about
  // as strict as the old 500 ms on one cold restart (63-125 ms then; the fastest restart now takes 0-16 ms).
  const LIMIT_MS = 200;
  const RESTART_LIMIT_MS = 100;
  const reads = [];
  for (let bib = 1; bib <= 600; bib++) {
    for (let k = 0; k < 3; k++) {
      const t = 180 * (k + 1) + bib * 0.25; // a runner every quarter second at each mat
      reads.push({ loc: `${k + 1}K-A`, bib, t, arrive: t + 1.4 + (bib % 7) * 0.2 });
      reads.push({ loc: `${k + 1}K-${k === 2 ? 'A' : 'B'}`, bib, t: t + 0.3, arrive: t + 1.9 + (bib % 5) * 0.25 });
    }
  }
  reads.sort((a, b) => a.arrive - b.arrive); // about 15 % of neighbours arrive out of time order
  const gun = parseTod('10:00:00');
  const cpuMs = (since) => {
    const used = process.cpuUsage(since);
    return (used.user + used.system) / 1000;
  };
  const once = () => {
    const journal = [];
    const store = { load: () => null, save: () => {}, remove: () => {}, appendJournal: (r) => journal.push(r), loadJournal: () => journal };
    const s = setup({ filter: { holdSec: 2 }, store });
    // the reads as parseLine gives them, made before the clock starts: only the engine is measured
    const lines = reads.map((r) => ({ at: Math.round(r.arrive * 1000), read: { location: r.loc, bib: String(r.bib),
      tod: gun + Math.round(r.t * 1000) * 10, contest: '', first: '', last: '', team: '', gender: '' } }));
    const started = process.cpuUsage();
    let clock = 0;
    for (const { at, read } of lines) {
      if (at > clock) {
        s.clock.advance(at - clock);
        clock = at;
      }
      s.engine.handleRead(read, { connId: 1 });
    }
    s.clock.advance(5000);
    const ms = cpuMs(started);
    assert.equal(s.engine.crossings('r1').length, 1800);
    assert.equal(s.sends.length, 1800, 'every crossing went out once, as new');
    const at3 = s.engine.crossings('r1').filter((c) => c.splitId === 's3');
    assert.deepEqual([at3[0].bib, at3[599].bib, at3[599].place], ['1', '600', 600]);
    // and a restart rebuilds all of it from the journal
    const restarted = process.cpuUsage();
    const again = setup({ store, filter: { holdSec: 2 } });
    const restartMs = cpuMs(restarted);
    assert.equal(again.engine.crossings('r1').length, 1800);
    return { ms, restartMs };
  };
  const runs = [];
  const best = (k) => Math.min(...runs.map((r) => r[k]));
  do runs.push(once());
  // (9.28: up to 12 runs, not 5: more test files start at once now, and the first runs here share the processors with
  // them. The limits are as they were: an engine that is slower fails all 12.)
  while (runs.length < 12 && (best('ms') >= LIMIT_MS || best('restartMs') >= RESTART_LIMIT_MS));
  t.diagnostic(`CPU time per run: ${runs.map((r) => `${Math.round(r.ms)} ms (restart ${Math.round(r.restartMs)} ms)`).join(', ')}`);
  assert.ok(best('ms') < LIMIT_MS, `the fastest of ${runs.length} runs took ${Math.round(best('ms'))} ms of CPU (limit ${LIMIT_MS} ms)`);
  assert.ok(best('restartMs') < RESTART_LIMIT_MS, `a restart is quick: the fastest took ${Math.round(best('restartMs'))} ms of CPU (limit ${RESTART_LIMIT_MS} ms)`);
});

test('bad lines and failing listeners never stop the engine; race events are coalesced', () => {
  const s = setup();
  const e = s.engine.handleRead(null, { raw: '\x01S,15:17:44.215,254', error: 'LapTime format has no timing point name' });
  assert.equal(e.status, 'bad-line');
  assert.equal(e.detail, 'LapTime format has no timing point name: \\01S,15:17:44.215,254');
  assert.equal(s.engine.handleRead({ location: '1K-A', bib: '', tod: 1 }).status, 'bad-line');
  assert.equal(s.engine.handleRead({ location: '1K-A', bib: '7', tod: 'soon' }).status, 'bad-line');
  assert.deepEqual(s.raceEvents, []);

  s.read('1K-A', 1, '10:03:00');
  assert.deepEqual(s.raceEvents, ['r1']);
  s.engine.on('send', () => { throw new Error('boom'); });
  s.clock.advance(2000);
  assert.equal(s.sends.length, 1);
  assert.match(s.logs.join('\n'), /'send' listener failed/);
  assert.equal(s.engine.feed(1)[0].status, 'sent');
  // a deliver() that throws costs that packet a retry, never the read
  const t = setup({ net: { deliver: () => { throw new Error('socket bug'); }, of: () => [] } });
  assert.equal(t.read('1K-A', 1, '10:03:00').status, 'held');
  t.clock.advance(2000);
  assert.match(t.logs.join('\n'), /handing bib 1 to TrackScore failed: Error: socket bug/);
});

/** A small seeded random generator, so a failing case can be run again exactly. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

test('the read-by-read derivation equals a rebuild from scratch, on random races (DESIGN 9.3)', () => {
  const sec = (t) => {
    const ticks = parseTod('10:00:00') + Math.round(t * S);
    const h = Math.floor(ticks / (3600 * S));
    const m = Math.floor(ticks / (60 * S)) % 60;
    const s2 = (ticks % (60 * S)) / S;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s2.toFixed(4).padStart(7, '0')}`;
  };
  for (const seed of [1, 7, 42, 99, 2026, 31337]) {
    const rand = rng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const lynx = new Map();
    const s = setup({ finishers: () => lynx });
    const reads = [];
    for (let bib = 1; bib <= 40; bib++) {
      const pace = 170 + rand() * 80;
      for (let k = 1; k <= 3; k++) {
        const t = pace * k + rand() * 4;
        if (rand() > 0.15) reads.push(['1K-A,2K-A,3K-A'.split(',')[k - 1], bib, t]);
        if (rand() > 0.3 && k < 3) reads.push([`${k}K-B`, bib, t + rand() * 0.8 - 0.3]);
        if (rand() < 0.1) reads.push([`${k}K-A`, bib, t + 30 + rand() * 300]); // a repeat, or out of order
      }
      if (rand() > 0.2) reads.push(['Finish', bib, pace * 3.2 + rand() * 5]);
      if (rand() < 0.15) reads.push(['Finish', bib, pace * 3.2 + 2 + rand() * 30]);
      if (rand() < 0.3) reads.push([pick(['Finish', '1K-A', '2K-B']), bib, rand() * 70]); // the start area
      if (rand() < 0.1) reads.push(['1K-A', bib, -rand() * 60]); // before the gun
      if (rand() < 0.1) reads.push(['Warm-up', bib, rand() * 900]); // not a split
      // FinishLynx LapTime passes (no timing point name, 9.15 L4): counted into the splits by time, with the mats
      if (rand() < 0.3) for (let k = 1; k <= 1 + Math.floor(rand() * 4); k++) reads.push(['', bib, pace * k + 1 + rand() * 2]);
    }
    // arrival order: roughly by time, many out of order, a few very late (an RR12 queue flush)
    const arrivals = reads.map((r) => ({ r, at: r[2] + 1.5 + rand() * 3 + (rand() < 0.1 ? rand() * 600 : 0) }))
      .sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < arrivals.length) {
      const n = rand() < 0.7 ? 1 : 1 + Math.floor(rand() * 40); // single live reads and chunks of a burst
      const batch = arrivals.slice(i, i + n).map(({ r: [loc, bib, t] }) => ({
        read: { location: loc, bib: String(bib), tod: parseTod(sec(t)), contest: '', first: '', last: '', team: '', gender: '' },
        meta: { connId: 1 },
      }));
      s.engine.handleReads(batch);
      i += n;
      s.clock.advance(Math.floor(rand() * 900));
      if (rand() < 0.02) {
        // FinishLynx finishes someone (or corrects a finish)
        lynx.set(String(1 + Math.floor(rand() * 40)), Math.round((500 + rand() * 400) * S));
        s.engine.converge();
      }
    }
    s.clock.advance(70_000);
    const snap = () => ({
      crossings: s.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.tod, c.raceTicks, c.place, c.reads, c.reason]),
      view: s.engine.raceView('r1'),
      data: [...s.engine.raceData('r1').runners].map(([bib, r]) => [bib, r.splits]),
      feed: s.engine.feed(1000).map((e) => [e.id, e.status, e.detail, e.raceTicks, e.splitName, e.place]),
    });
    const incremental = snap();
    const packets = s.sends.length;
    // a timing point nobody uses: the derivation is the same, but the race is worked out again from scratch
    s.config.races[0].splits[0].sources.push(`Never-${seed}`);
    s.engine.configChanged();
    s.config.races[0].splits[0].sources.pop();
    s.engine.configChanged();
    const rebuilt = snap();
    assert.deepEqual(rebuilt.crossings, incremental.crossings, `crossings, seed ${seed}`);
    assert.deepEqual(rebuilt.data, incremental.data, `raceData, seed ${seed}`);
    assert.deepEqual(rebuilt.view, incremental.view, `raceView, seed ${seed}`);
    assert.deepEqual(rebuilt.feed, incremental.feed, `feed rows, seed ${seed}`);
    assert.equal(s.sends.length, packets, `the rebuild found nothing to send, seed ${seed}`);
    // every kind of outcome turned up
    const kinds = new Set(incremental.feed.map((f) => f[1]));
    for (const k of ['sent', 'backup', 'finish', 'start-area', 'before-gun', 'unmapped']) assert.ok(kinds.has(k), `${k} in seed ${seed}`);
    assert.ok(incremental.view.passes > 0, `LapTime passes in seed ${seed}`);
  }
});

test('the start area: reads in the first startIgnoreSec after the gun are ignored, finish or split (s2 P1, P2)', () => {
  // P1: the start line runs over the finish mats; every runner is read there 4 s after the gun.
  const s = setup();
  const starts = [1, 2, 3, 4, 5].map((b) => s.read('Finish', b, `10:00:04.${b}00`));
  assert.ok(starts.every((e) => e.status === 'start-area'), starts.map((e) => e.status).join());
  assert.equal(starts[0].detail, "Too soon after the gun — ignored (start area). Change 'Ignore reads in the first 60 s' in Settings if this is a real split.");
  assert.equal(starts[0].raceTicks, rt('4.1'));
  s.clock.advance(3000);
  for (let b = 1; b <= 5; b++) s.read('1K-A', b, `10:03:2${b}`);
  s.clock.advance(3000);
  for (let b = 1; b <= 5; b++) s.read('2K-A', b, `10:06:4${b}`);
  s.clock.advance(3000);
  assert.equal(s.sends.length, 10, 'nobody "finished" at the start: their splits go out');
  let v = s.engine.raceView('r1');
  assert.deepEqual([v.startArea, v.finished, v.runners, v.afterFinish], [5, 0, 5, 0]);
  assert.deepEqual(s.engine.raceData('r1').runners.get('3').splits, [rt('3:23'), rt('6:43'), null], 'and in the merged .lif');

  // The setting is part of the derivation: 0 turns it off and the reads are worked out again (here: wrongly finished).
  s.config.filter.startIgnoreSec = 0;
  s.engine.configChanged();
  v = s.engine.raceView('r1');
  assert.deepEqual([v.startArea, v.finished, v.runners, v.afterFinish], [0, 5, 0, 10]);
  assert.equal(starts[0].status, 'finish', 'the feed row was updated in place');
  s.config.filter.startIgnoreSec = 60;
  s.engine.configChanged();
  v = s.engine.raceView('r1');
  assert.deepEqual([v.startArea, v.finished, v.runners, v.afterFinish], [5, 0, 5, 0]);
  assert.equal(starts[0].status, 'start-area');

  // P2: a stray read on the 2K mat right after the gun no longer drops the real 1K split as out of order.
  const p = setup();
  assert.equal(p.read('2K-A', 1, '10:00:05').status, 'start-area');
  p.clock.advance(3000);
  p.read('1K-A', 1, '10:03:20');
  p.clock.advance(3000);
  p.read('2K-A', 1, '10:06:40');
  p.clock.advance(3000);
  assert.deepEqual(p.sends.map((x) => [x.splitName, x.csTicks]), [['1K', rt('3:20')], ['2K', rt('6:40')]]);
  assert.deepEqual([p.engine.raceView('r1').outOfOrder, p.engine.raceView('r1').startArea], [0, 1]);

  // The edge: 59.999 s is the start area, 60 s counts; a negative race time is still "before the gun".
  const e = setup({ filter: { startIgnoreSec: 60 } });
  assert.equal(e.read('1K-A', 7, '10:00:59.999').status, 'start-area');
  assert.equal(e.read('1K-A', 8, '10:01:00.000').status, 'held');
  assert.equal(e.read('1K-A', 9, '09:59:59.000').status, 'before-gun');
  // Waiting reads are worked out when the gun is set, start area included.
  const w = setup({ races: [race({ gun: '' })] });
  const waiting = w.read('Finish', 4, '10:00:03');
  assert.equal(waiting.status, 'waiting-gun');
  w.engine.setGun('r1', '10:00:00');
  assert.equal(waiting.status, 'start-area');
  assert.equal(w.engine.raceView('r1').finished, 0);
});

test('reads let go by deleting a race or narrowing its contests never flood a catch-all race (s2 P3, revision 4)', () => {
  const girls = race({ id: 'rg', name: 'Girls', contests: ['Girls'], eventNumber: '3' });
  const boys = race({ id: 'rb', name: 'Boys', contests: [], eventNumber: '5' });
  const s = setup({ races: [girls, boys] });
  const girlRows = [1, 2, 3].map((b) => s.read('1K-A', 100 + b, `10:03:2${b}`, { contest: 'Girls' }));
  for (let b = 1; b <= 3; b++) s.read('1K-A', 500 + b, `10:03:2${5 + b}`, { contest: 'Boys' });
  s.clock.advance(3000);
  const before = s.sends.length;
  deleteRaces(s, 'rg'); // the Girls race is deleted while Boys (every other contest) runs
  s.clock.advance(3000);
  assert.equal(s.sends.length, before, 'no girl is sent as a Boys runner, no boy is moved down');
  assert.deepEqual(s.engine.crossings('rb').map((c) => `${c.bib}:${c.place}`), ['501:1', '502:2', '503:3']);
  // revision 5 (R2): the deleted race's reads are out of use for good, and say so
  assert.deepEqual([girlRows[0].status, girlRows[0].raceId], ['race-deleted', null]);
  assert.equal(girlRows[0].detail, "Its race 'Girls' was deleted, so this read is not used.");
  // a new read of that contest is set aside: it does not go into Boys either
  const late = s.read('1K-A', 777, '10:03:40', { contest: 'Girls' });
  assert.deepEqual([late.raceId, late.status], [null, 'set-aside']);
  assert.equal(late.detail, "Reads of 'Girls' are not used: its race 'Girls' was deleted. List the contest on an Active race to use them.");
  // adding a race that lists the contest takes the set-aside read; the deleted race's reads stay out of use
  s.config.races.unshift(race({ id: 'rg2', name: 'Girls', contests: ['Girls'], eventNumber: '3' }));
  s.engine.configChanged();
  assert.deepEqual([girlRows[0].raceId, girlRows[0].status], [null, 'race-deleted']);
  assert.deepEqual(s.engine.crossings('rg2').map((c) => c.bib), ['777']);

  // Narrowing a race's contests: the reads it lets go do not land in the catch-all either, also after a restart.
  const store = memStore();
  const n = setup({ store, races: [race({ id: 'v', name: 'Varsity', contests: ['Varsity', 'JV'] }), race({ id: 'open', name: 'Open', contests: [] })] });
  const jv = n.read('1K-A', 9, '10:03:00', { contest: 'JV' });
  n.config.races[0].contests = ['Varsity'];
  n.engine.configChanged();
  assert.equal(jv.status, 'set-aside');
  assert.equal(n.engine.raceView('open').runners, 0);
  assert.equal(n.read('1K-A', 10, '10:03:01', { contest: 'JV' }).status, 'set-aside');
  n.engine.stop();
  const again = setup({ store, config: n.config });
  assert.equal(again.engine.raceView('open').runners, 0, 'the journal remembers the contest is set aside');
  assert.equal(again.engine.raceView('v').runners, 0);
  assert.deepEqual(again.engine.setAside().map((a) => [a.contest, a.count]), [['JV', 2]]);
});

test('clear, restart, then Replay in RR12: the cleared reads count again and survive the next restart', () => {
  const store = memStore();
  const s = setup({ store });
  s.read('1K-A', 1, '10:03:00');
  s.read('1K-A', 2, '10:03:01');
  s.clock.advance(3000);
  s.engine.clearRace('r1');
  s.engine.stop();
  s.engine.markCleanStop();
  // after the restart the cleared reads are still out (nothing replayed yet)
  const t = setup({ store, config: s.config });
  t.clock.advance(1000);
  assert.equal(t.engine.crossings('r1').length, 0);
  // RR12 Replay: they count again and go out
  assert.deepEqual([t.read('1K-A', 1, '10:03:00').status, t.read('1K-A', 2, '10:03:01').status], ['held', 'held']);
  t.clock.advance(3000);
  assert.deepEqual([t.sends.length, t.engine.crossings('r1').length], [2, 2]);
  t.engine.stop();
  t.engine.markCleanStop();
  // a restart replays the journal to the same race: the clear, then the re-received reads
  const u = setup({ store, config: s.config });
  assert.deepEqual(u.engine.crossings('r1').map((c) => [c.bib, c.place]), [['1', 1], ['2', 2]]);
});

// ---- Revision 4 (DESIGN 9.2): set-aside contests. Old and new reads of one contest always go the same way. ----------

/** Girls lists its contest; Boys takes every other contest (the race-day setup behind both findings). */
function girlsAndBoys() {
  return [
    race({ id: 'rg', name: 'Girls 5K', contests: ['Girls Varsity'], eventNumber: '3' }),
    race({ id: 'rb', name: 'Boys 5K', contests: [], eventNumber: '5' }),
  ];
}
const places = (s, id) => s.engine.crossings(id).map((c) => `${c.bib}:${c.place}`);

test('(a) deleting an explicit race while a catch-all runs: its contest is set aside, old and new reads alike', () => {
  const s = setup({ races: girlsAndBoys() });
  const girls = [1, 2, 3].map((b) => s.read('1K-A', 100 + b, `10:03:2${b}`, { contest: 'Girls Varsity' }));
  for (let b = 1; b <= 3; b++) s.read('1K-A', 500 + b, `10:03:2${5 + b}`, { contest: 'Boys Varsity' });
  s.clock.advance(3000);
  const before = s.sends.length;
  deleteRaces(s, 'rg');
  // revision 5 (R2): the deleted race's own reads are out of use for good
  assert.ok(girls.every((e) => e.status === 'race-deleted' && e.raceId === null), girls.map((e) => e.status).join());
  assert.equal(girls[0].detail, "Its race 'Girls 5K' was deleted, so this read is not used.");
  // a girl arriving after the delete is not used either: not into Boys, where she would take a boy's place
  const late = s.read('1K-A', 104, '10:03:24.500', { contest: 'Girls Varsity' });
  assert.deepEqual([late.status, late.raceId], ['set-aside', null]);
  assert.equal(late.detail, "Reads of 'Girls Varsity' are not used: its race 'Girls 5K' was deleted. List the contest on an Active race to use them.");
  s.clock.advance(3000);
  assert.equal(s.sends.length, before, 'nothing sent: no girl as a Boys runner, no boy moved down');
  assert.deepEqual(places(s, 'rb'), ['501:1', '502:2', '503:3']);
  // the next boy is 4th, as he really is
  s.read('1K-A', 504, '10:03:30', { contest: 'Boys Varsity' });
  s.clock.advance(3000);
  assert.deepEqual(sent(s.sends.slice(before)), [['504', 4, 'new']]);
  assert.deepEqual(s.engine.setAside(), [{ contest: 'Girls Varsity', reason: "its race 'Girls 5K' was deleted", raceName: 'Girls 5K',
    raceId: null, since: T0 + 3000, count: 1,
    text: "Reads of 'Girls Varsity' are not used: its race 'Girls 5K' was deleted. List the contest on an Active race to use them." }]);
  const recs = s.store.journal.map((l) => JSON.parse(l));
  assert.ok(recs.some((r) => r.t === 'aside' && r.kind === 'deleted'), 'the set-aside is journaled');
  assert.deepEqual(recs.filter((r) => r.t === 'delete').map((r) => [r.raceId, r.raceName]), [['rg', 'Girls 5K']]);
  assert.match(s.logs.join('\n'), /race 'Girls 5K' deleted: its 3 reads are not used any more/);
  assert.match(s.logs.join('\n'), /reads of contest "Girls Varsity" are set aside \(not used\): its race 'Girls 5K' was deleted\. New reads/);
});

test('(b) a contest added to a race by mistake and taken out again: its reads go back to the catch-all race', () => {
  const s = setup({ races: girlsAndBoys() });
  for (let b = 1; b <= 3; b++) s.read('1K-A', 500 + b, `10:03:2${5 + b}`, { contest: 'Boys Varsity' });
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'rb'), ['501:1', '502:2', '503:3']);
  assert.deepEqual(s.engine.raceView('rb').contestsSeen, [{ name: 'Boys Varsity', count: 3, blank: false }]);
  s.config.races[0].contests = ['Girls Varsity', 'Boys Varsity']; // the misclick
  s.engine.configChanged();
  assert.deepEqual([places(s, 'rb'), places(s, 'rg')], [[], ['501:1', '502:2', '503:3']]);
  // what the undo would do comes back to Boys: the panel's contest dialog says so (planChange)
  const undoPlan = s.engine.planChange({ ...s.config, races: [{ ...s.config.races[0], contests: ['Girls Varsity'] }, s.config.races[1]] });
  assert.deepEqual(undoPlan.moves, [{ contest: 'Boys Varsity', blank: false, count: 3,
    from: { raceId: 'rg', raceName: 'Girls 5K', active: true }, to: { raceId: 'rb', raceName: 'Boys 5K', active: true } }]);
  assert.deepEqual([undoPlan.setAside, undoPlan.deleted], [[], []]);
  s.config.races[0].contests = ['Girls Varsity']; // the undo
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside(), [], 'nothing set aside: every read came from Boys, which takes every contest');
  assert.deepEqual([places(s, 'rb'), places(s, 'rg')], [['501:1', '502:2', '503:3'], []]);
  const n = s.sends.filter((p) => p.raceId === 'rb').length;
  const next = s.read('1K-A', 504, '10:03:29', { contest: 'Boys Varsity' });
  assert.equal(next.raceId, 'rb', 'a new boy goes where the old ones are');
  s.clock.advance(3000);
  assert.deepEqual(sent(s.sends.filter((p) => p.raceId === 'rb').slice(n)), [['504', 4, 'new']]);
  assert.equal(s.engine.feed(1000).find((e) => e.bib === '501').status, 'sent');
  // a boy who arrived WHILE the Girls race listed the contest came from no catch-all race: then the contest is set aside
  s.config.races[0].contests = ['Girls Varsity', 'Boys Varsity'];
  s.engine.configChanged();
  s.read('1K-A', 505, '10:03:31', { contest: 'Boys Varsity' });
  s.config.races[0].contests = ['Girls Varsity'];
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['Boys Varsity', "'Girls 5K' no longer lists it", 5]]);
  assert.equal(s.read('1K-A', 506, '10:03:32', { contest: 'Boys Varsity' }).status, 'set-aside', 'and new boys with them');
});

test("(c) narrowing a catch-all race after another contest's read arrived sets that contest aside, old and new", () => {
  const s = setup({ races: [race({ id: 'rg', name: 'Girls 5K', contests: [] })] });
  const boy = s.read('1K-A', 888, '10:03:00', { contest: 'Boys Varsity' });
  s.read('1K-A', 101, '10:03:05', { contest: 'Girls Varsity' });
  s.clock.advance(3000);
  s.config.races[0].contests = ['Girls Varsity'];
  s.engine.configChanged();
  assert.deepEqual([boy.status, boy.raceId], ['set-aside', null]);
  assert.equal(s.read('1K-A', 889, '10:03:06', { contest: 'Boys Varsity' }).status, 'set-aside');
  assert.deepEqual(places(s, 'rg'), ['101:1']);
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason, a.raceId, a.count]), [['Boys Varsity', "'Girls 5K' no longer lists it", 'rg', 2]]);
  // a new race that takes every contest takes nothing set aside (only a race that lists the contest does)
  s.config.races.push(race({ id: 'any', name: 'Open', contests: [], eventNumber: '9' }));
  s.engine.configChanged();
  assert.equal(boy.status, 'set-aside');
  assert.equal(s.read('1K-A', 1, '10:03:07', { contest: 'Novice' }).raceId, 'any', 'a contest nobody set aside still goes there');
});

test('(d) listing a set-aside contest on a race takes all its reads there, old and new', () => {
  const s = setup({ races: girlsAndBoys() });
  for (let b = 1; b <= 2; b++) s.read('1K-A', 100 + b, `10:03:2${b}`, { contest: 'Girls Varsity' });
  deleteRaces(s, 'rg');
  s.read('1K-A', 103, '10:03:23', { contest: 'Girls Varsity' });
  assert.equal(s.engine.setAside()[0].count, 1, 'the straggler; the deleted race\'s two reads are out of use (R2)');
  s.config.races.unshift(race({ id: 'rg2', name: 'Girls 5K', contests: ['girls  varsity'], eventNumber: '3' }));
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside(), []);
  assert.deepEqual(places(s, 'rg2'), ['103:1']);
  assert.equal(s.read('1K-A', 104, '10:03:24', { contest: 'Girls Varsity' }).raceId, 'rg2');
  assert.ok(s.store.journal.some((l) => JSON.parse(l).t === 'unaside'));
  assert.match(s.logs.join('\n'), /contest "Girls Varsity" is listed by Girls 5K: its reads are used again/);
});

test('(e) deleting a catch-all race with reads sets its contests aside; a new catch-all race does not take them', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open', contests: [] })] });
  s.read('1K-A', 1, '10:03:00', { contest: 'JV' });
  s.read('1K-A', 2, '10:03:01', { contest: 'Novice' });
  const blank = s.read('1K-A', 3, '10:03:02');
  s.config.races = [race({ id: 'open2', name: 'Open again', contests: [], eventNumber: '7' })];
  s.engine.configChanged({ deleted: ['open'] });
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason]), [['JV', "its race 'Open' was deleted"], ['Novice', "its race 'Open' was deleted"]]);
  assert.equal(s.engine.raceView('open2').runners, 0);
  assert.equal(s.read('1K-A', 4, '10:03:03', { contest: 'JV' }).status, 'set-aside');
  assert.equal(s.read('1K-A', 5, '10:03:04', { contest: 'Varsity' }).raceId, 'open2', 'a contest the old race never had');
  // A read without a contest is never set aside (no race could list it, so it would be unused for good): the deleted
  // race's one is out of use like its others (R2), a new one goes to the race that takes every contest.
  assert.deepEqual([blank.status, blank.raceId], ['race-deleted', null]);
  assert.equal(blank.detail, "Its race 'Open' was deleted, so this read is not used.");
  const blank2 = s.read('1K-A', 6, '10:03:05');
  assert.equal(blank2.raceId, 'open2');
  s.config.races[0].contests = ['JV', 'Varsity'];
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside().map((a) => a.contest), ['Novice']);
  assert.deepEqual(places(s, 'open2'), ['4:1', '5:2']);
  // the blank read went with the race that took every contest; none does now
  assert.deepEqual([blank2.raceId, blank2.status], [null, 'no-race']);
});

test('(f) a contest listed by mistake and taken out before any of its reads came: nothing is set aside', () => {
  const s = setup({ races: girlsAndBoys() });
  s.config.races[0].contests = ['Girls Varsity', 'Boys Varsity'];
  s.engine.configChanged();
  s.config.races[0].contests = ['Girls Varsity'];
  s.engine.configChanged();
  s.config.races.push(race({ id: 'x', name: 'Spare', contests: ['Masters'], eventNumber: '8' }));
  s.engine.configChanged();
  deleteRaces(s, 'x'); // deleted with no reads
  assert.deepEqual(s.engine.setAside(), []);
  assert.equal(s.read('1K-A', 501, '10:03:00', { contest: 'Boys Varsity' }).raceId, 'rb');
  assert.equal(s.read('1K-A', 601, '10:03:00', { contest: 'Masters' }).raceId, 'rb');
  assert.ok(!s.store.journal.some((l) => JSON.parse(l).t === 'aside'));
});

test('(g) a restart replays set-asides and routes to the same result; an older journal is brought in line', () => {
  const store = memStore();
  const s = setup({ store, races: girlsAndBoys() });
  for (let b = 1; b <= 3; b++) s.read('1K-A', 100 + b, `10:03:2${b}`, { contest: 'Girls Varsity' });
  for (let b = 1; b <= 3; b++) s.read('1K-A', 500 + b, `10:03:2${5 + b}`, { contest: 'Boys Varsity' });
  s.config.races[0].contests = ['Girls Varsity', 'Boys Varsity'];
  s.engine.configChanged();
  s.config.races[0].contests = ['Girls Varsity'];
  s.engine.configChanged();
  deleteRaces(s, 'rg');
  s.read('1K-A', 104, '10:03:24', { contest: 'Girls Varsity' });
  s.clock.advance(3000);
  const snap = (e) => ({ aside: e.setAside(), boys: e.crossings('rb').map((c) => [c.bib, c.tod, c.place]), view: e.raceView('rb').contestsSeen });
  const live = snap(s.engine);
  assert.equal(live.aside.length, 1);
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  const t = setup({ store, config: s.config });
  assert.deepEqual(snap(t.engine), live);
  assert.equal(store.journal.length, lines, 'nothing to journal again: the replay gives the same');
  assert.equal(t.read('1K-A', 105, '10:03:25', { contest: 'Girls Varsity' }).status, 'set-aside');
  assert.equal(t.read('1K-A', 504, '10:03:30', { contest: 'Boys Varsity' }).raceId, 'rb');

  // A revision 3 journal: the deleted race's reads were routed to no race, and a girl who came after the delete went
  // into the Boys race. On start the contest is set aside and she comes out of the Boys race, but only in memory
  // (revision 6: at start nothing but the moves is journaled; the next start works it out again).
  const old = memStore();
  const rec = (seq, bib, tod, contest, raceId) => old.appendJournal({ t: 'read', seq, at: T0, conn: 1, location: '1K-A',
    bib: String(bib), tod: parseTod(tod), contest, first: '', last: '', team: '', gender: '', raceId });
  rec(1, 101, '10:03:21', 'Girls Varsity', 'rg');
  rec(2, 501, '10:03:26', 'Boys Varsity', 'rb');
  old.appendJournal({ t: 'route', seq: 1, raceId: null });
  rec(3, 104, '10:03:20', 'Girls Varsity', 'rb');
  const u = setup({ store: old, races: [girlsAndBoys()[1]] });
  assert.deepEqual(u.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['Girls Varsity', 'no race lists it any more', 2]]);
  assert.deepEqual(places(u, 'rb'), ['501:1']);
  assert.deepEqual(old.journal.slice(4).map((l) => JSON.parse(l)), [{ t: 'route', seq: 3, raceId: null }]);
  assert.deepEqual(u.engine.missingRaces(), [], 'rg holds no read: nothing waits for it');
  u.engine.stop();
  const again = setup({ store: old, races: [girlsAndBoys()[1]] });
  assert.deepEqual(again.engine.setAside().map((a) => [a.contest, a.count]), [['Girls Varsity', 2]]);
  assert.equal(old.journal.length, 5, 'the next start works it out again and journals nothing');
});

test('(h) random reads and race edits follow the routing rules R1-R6, the plan says exactly what happens, and a rebuild or a restart gives the same', () => {
  const CONTESTS = ['A', 'B', 'C', 'D', ''];
  const seen = { deleted: 0, cleared: 0, asideDeleted: 0, asideUnlisted: 0, unaside: 0, back: 0, waiting: 0, pulledOut: 0,
    frozenKept: 0, plans: 0, lost: 0, lostDeleted: 0, held: 0, straggler: 0, returned: 0, startLost: 0, startHeld: 0, startEdited: 0 };
  const cloneStore = (st) => {
    const c = memStore();
    c.journal.push(...st.journal);
    for (const [k, v] of st.data) c.data.set(k, v);
    return c;
  };
  for (const seed of [3, 11, 64, 777, 4096, 90210, 5, 19, 2024, 31337, 8, 13, 21, 34, 55, 89]) {
    const rand = rng(seed);
    const pick = (l) => l[Math.floor(rand() * l.length)];
    const store = memStore();
    let nextId = 1;
    /** race id -> its last name, also after it is deleted or lost */
    const names = new Map();
    /** races deleted by the operator (only these take reads out of use, R2) */
    const everDeleted = new Set();
    /** race id -> its settings, for a race that left the settings without being deleted (R6), to put it back */
    const lostRaces = new Map();
    const newRace = () => {
      const id = `q${nextId++}`;
      const catchAll = rand() < 0.4;
      const contests = catchAll ? [] : CONTESTS.slice(0, 4).filter(() => rand() < 0.3);
      if (!catchAll && !contests.length) contests.push(pick(CONTESTS.slice(0, 4)));
      names.set(id, `Race ${id}`);
      return race({ id, name: `Race ${id}`, eventNumber: id.slice(1), contests, active: rand() < 0.65,
        splits: [{ id: 's1', name: '1K', sources: ['1K-A'] }], finishSources: [] });
    };
    // what the config allows (config.js validateRace): one active race that takes every contest, and a contest listed
    // by one active race at most; a race that would break that is switched off
    const legal = (races) => {
      let all = false;
      const listed = new Set();
      for (const r of races) {
        if (!r.active) continue;
        const keys = r.contests.map(matchKey);
        if (!keys.length ? all : keys.some((k) => listed.has(k))) r.active = false;
        else if (!keys.length) all = true;
        else keys.forEach((k) => listed.add(k));
      }
      return races;
    };
    let s = setup({ store, races: legal([newRace(), newRace(), newRace()]) });

    // ---- The routing rules of DESIGN 9.2 (revision 6), written out plainly from the text, one read at a time. ----
    /** { bib, c: contest key, seq, raceId, home: race id | 'ASIDE' | null, gone: null | 'cleared' | 'deleted', entry } */
    const reads = [];
    /** contest key -> { byId, byName, deleted } */
    let aside = new Map();
    /** contest key -> the missing race its reads wait for (R6) */
    let held = new Map();
    const view = (races) => races.map((r) => ({ id: r.id, name: r.name, active: r.active !== false, contests: new Set(r.contests.map(matchKey)) }));
    const takesAll = (rs) => rs.find((x) => x.active && !x.contests.size) ?? null;
    const lists = (rs, c) => (c ? rs.filter((x) => x.contests.has(c)) : []);
    const live = (r) => r.gone === null;
    // New reads: the active race that lists the contest; nowhere when only races that are not Active list it (C1: it
    // waits for them), when it is set aside or waits for a missing race; else the active race taking every contest.
    const newTarget = (rs, set, hd, c) => {
      if (!c) return hd.has('') ? null : takesAll(rs)?.id ?? null;
      const l = lists(rs, c);
      if (l.length) return l.find((x) => x.active)?.id ?? null;
      if (set.has(c) || hd.has(c)) return null;
      return takesAll(rs)?.id ?? null;
    };
    // R4 for a read in an active race or in no race: a race id, null, or 'f'
    const reRoute = (rs, set, hd, r) => {
      const cur = rs.find((x) => x.id === r.raceId);
      const curAll = cur && cur.active && !cur.contests.size;
      if (!r.c) return hd.has('') ? null : curAll ? cur.id : takesAll(rs)?.id ?? null; // a blank contest goes with the race taking every contest
      const l = lists(rs, r.c);
      if (l.length) {
        const act = l.filter((x) => x.active);
        return act.length ? (act.find((x) => x.id === r.raceId) ?? act[0]).id : null; // a; C1: it waits in no race
      }
      if (set.has(r.c) || hd.has(r.c)) return null; // b; R6
      if (curAll) return cur.id; // c
      const home = rs.find((x) => x.id === r.home);
      if (home && home.active && !home.contests.size) return home.id; // d
      if (r.home === null) return takesAll(rs)?.id ?? null; // e
      return 'f'; // f
    };
    /** a live read in no race: why (the feed status, State.noRace) */
    const whyNoRace = (rs, set, hd, c) => (c && lists(rs, c).length ? 'paused' : c && set.has(c) ? 'set-aside' : hd.has(c) ? 'race-missing' : 'no-race');
    const reasonOf = (a, rs) => {
      const r = rs.find((x) => x.id === a.byId);
      if (a.deleted) return a.byName ? `its race '${a.byName}' was deleted` : 'its race was deleted';
      if (r) return `'${r.name}' no longer lists it`;
      if (!a.byId) return 'no race lists it any more';
      // called by the last name it had; a race that is gone without being deleted is missing (R6)
      const n = names.get(a.byId) || a.byName;
      if (!everDeleted.has(a.byId)) return n ? `'${n}' isn't in the settings any more` : 'no race lists it any more';
      return n ? `'${n}' was deleted` : 'its race was deleted';
    };
    /** where a read is (or new reads go, with whether that race is active), as the plan describes it */
    const placeOf = (rs, set, hd, raceId, c, withActive = false) => {
      const x = rs.find((q) => q.id === raceId);
      if (x) return withActive ? `${x.id}/${x.active}` : x.id;
      return raceId !== null ? 'race-missing' : whyNoRace(rs, set, hd, c);
    };
    /**
     * What a change does (DESIGN 9.2), worked out without changing anything: `before` null at start (deletedIds then
     * empty). Returns the set-asides and holds after it, where each routable read goes, and the deleted reads.
     */
    const planModel = (before, after, deletedIds) => {
      const ids = new Set(after.map((x) => x.id));
      const routable = (r) => live(r) && (r.raceId === null || after.some((x) => x.id === r.raceId && x.active));
      const missingIds = new Set(reads.filter((r) => live(r) && r.raceId !== null && !ids.has(r.raceId) && !deletedIds.includes(r.raceId)).map((r) => r.raceId));
      const deletedNow = reads.filter((r) => live(r) && r.raceId !== null && !ids.has(r.raceId) && deletedIds.includes(r.raceId));
      // R5: listed again -> used again
      const set = new Map([...aside].filter(([c]) => !lists(after, c).length));
      // R6: the contests of a missing race's reads, and of reads whose home it is, wait for it
      const waitFor = new Map();
      for (const r of reads) if (live(r) && missingIds.has(r.raceId) && !waitFor.has(r.c)) waitFor.set(r.c, r.raceId);
      for (const r of reads) if (routable(r) && missingIds.has(r.home) && !waitFor.has(r.c)) waitFor.set(r.c, r.home);
      // R2: a deleted race's reads are out of use; their contest is set aside when new reads of it went to the race (or
      // waited for it), no race lists it and no race that counts holds reads of it
      const heldLive = new Set(reads.filter((r) => routable(r) && r.raceId !== null && r.c).map((r) => r.c));
      const added = new Set();
      if (before) {
        for (const r of deletedNow) {
          const c = r.c;
          if (!c || set.has(c) || lists(after, c).length || heldLive.has(c) || waitFor.has(c)) continue;
          const to = newTarget(before, aside, held, c);
          if (to !== null ? to !== r.raceId : !(lists(before, c).some((x) => x.id === r.raceId) || held.get(c) === r.raceId)) continue;
          set.set(c, { byId: r.raceId, byName: names.get(r.raceId) ?? '', deleted: true });
          added.add(c);
        }
      }
      // R6: held, unless the race taking every contest has reads of it already and none would be let go
      const hd = new Map();
      const T = takesAll(after);
      for (const [c, id] of waitFor) {
        if (c && (lists(after, c).length || set.has(c))) continue;
        const mine = reads.filter((r) => routable(r) && r.c === c);
        if (T && mine.some((r) => r.raceId === T.id) && !mine.some((r) => reRoute(after, set, new Map(), r) === 'f')) continue;
        hd.set(c, id);
      }
      // R4f: every contest rule f lets go of is set aside before anything moves
      for (const r of reads) {
        if (!routable(r) || !r.c || set.has(r.c) || reRoute(after, set, hd, r) !== 'f') continue;
        const byId = r.raceId ?? (before ? lists(before, r.c)[0]?.id : undefined) ?? (r.home !== 'ASIDE' ? r.home : null);
        set.set(r.c, { byId, byName: byId ? names.get(byId) ?? '' : '', deleted: false });
        added.add(r.c);
      }
      const to = new Map();
      for (const r of reads) if (routable(r)) to.set(r, reRoute(after, set, hd, r));
      return { set, hd, added, to, deletedNow, missingIds };
    };
    const change = (before, after, deletedIds) => {
      const asideBefore = new Map(aside);
      const heldBefore = new Map(held);
      const p = planModel(before, after, deletedIds);
      for (const r of p.deletedNow) r.gone = 'deleted';
      for (const id of deletedIds) everDeleted.add(id);
      for (const r of reads) if (live(r) && r.raceId === null && r.home === null && r.c && p.added.has(r.c)) r.home = 'ASIDE';
      const from = new Map(reads.map((r) => [r, r.raceId]));
      for (const [r, to] of p.to) {
        assert.notEqual(to, 'f', `seed ${seed}: rule f after the contests were set aside`);
        if (to === null && r.raceId !== null && r.c && lists(after, r.c).length) seen.pulledOut++;
        r.raceId = to;
        if (to !== null && r.home === null) r.home = to;
      }
      aside = p.set;
      held = p.hd;
      return { deletedNow: p.deletedNow, from, asideBefore, heldBefore };
    };

    /** the feed rows, the set-aside list, the waiting reads and the races agree with the model; and the consequences hold */
    const check = (what) => {
      const rs = view(s.config.races);
      const where = `seed ${seed}, ${what}`;
      const noRace = new Map();
      const missing = new Map();
      for (const r of reads) {
        const e = r.entry;
        if (r.gone === 'deleted') {
          assert.deepEqual([e.status, e.raceId], ['race-deleted', null], `${where}: bib ${r.bib} race deleted`);
          continue;
        }
        if (r.gone === 'cleared') {
          assert.deepEqual([e.status, e.raceId], ['cleared', rs.some((x) => x.id === r.raceId) ? r.raceId : null], `${where}: bib ${r.bib} cleared`);
          continue;
        }
        const x = rs.find((q) => q.id === r.raceId);
        if (r.raceId !== null && !x) {
          // R6: its race is missing from the settings: it waits for it
          assert.deepEqual([e.raceId, e.status], [null, 'race-missing'], `${where}: bib ${r.bib} waits for its missing race`);
          missing.set(r.raceId, (missing.get(r.raceId) ?? 0) + 1);
          noRace.set(`${r.c}|race-missing`, (noRace.get(`${r.c}|race-missing`) ?? 0) + 1);
        } else {
          assert.equal(e.raceId, r.raceId, `${where}: bib ${r.bib} (contest ${r.c || 'blank'})`);
          if (!x) {
            const why = whyNoRace(rs, aside, held, r.c);
            assert.equal(e.status, why, `${where}: bib ${r.bib} status`);
            noRace.set(`${r.c}|${why}`, (noRace.get(`${r.c}|${why}`) ?? 0) + 1);
          } else if (!x.active) assert.ok(['paused', 'sent'].includes(e.status), `${where}: bib ${r.bib} status ${e.status}`);
          // a race switched off sends nothing: its reads are paused (or say they were sent before it was switched off)
          else assert.ok(['held', 'sent'].includes(e.status), `${where}: bib ${r.bib} status ${e.status}`);
        }
        // nothing is lost without a word
        assert.ok(e.detail, `${where}: bib ${r.bib} has a reason`);
      }
      const got = s.engine.setAside();
      assert.deepEqual(got.map((a) => matchKey(a.contest)).sort(), [...aside.keys()].sort(), `${where}: set aside`);
      for (const a of got) {
        const m = aside.get(matchKey(a.contest));
        const n = reads.filter((r) => live(r) && r.raceId === null && r.c === matchKey(a.contest)).length;
        assert.deepEqual([a.count, a.reason, a.raceId], [n, reasonOf(m, rs), !m.deleted && rs.some((x) => x.id === m.byId) ? m.byId : null],
          `${where}: set-aside ${a.contest}`);
      }
      // State.noRace: what waits now, per contest and why; State.missingRaces: the missing races and their reads
      assert.deepEqual(s.engine.noRace().map((n) => [`${n.blank ? '' : matchKey(n.contest)}|${n.status}`, n.count]).sort(), [...noRace].sort(), `${where}: noRace`);
      assert.deepEqual(s.engine.missingRaces().map((m) => [m.raceId, m.count]).sort(), [...missing].sort(), `${where}: missing races`);
      for (const x of rs) {
        const n = reads.filter((r) => live(r) && r.raceId === x.id).length;
        assert.equal(s.engine.raceView(x.id).runners, n, `${where}: runners of ${x.id}`);
      }
      // The consequence, checked always (revision 6): every read of a contest that is in use and not kept by a race
      // that is not Active (or by a missing race) is where new reads of the contest go: one active race, or no race
      // with one status. A race that is not Active never gets a new read.
      for (const c of CONTESTS.map(matchKey)) {
        const t = newTarget(rs, aside, held, c);
        assert.ok(t === null || rs.find((x) => x.id === t).active, `${where}: new reads of ${c || 'blank'} never go into a race that is not Active`);
        const status = t === null ? whyNoRace(rs, aside, held, c) : null;
        for (const r of reads) {
          if (!live(r) || r.c !== c) continue;
          if (r.raceId !== null && !rs.find((x) => x.id === r.raceId)?.active) continue; // kept by its inactive or missing race
          assert.equal(r.entry.raceId, t, `${where}: bib ${r.bib} of contest ${c || 'blank'} is where new reads go`);
          if (t === null) assert.equal(r.entry.status, status, `${where}: bib ${r.bib} of contest ${c || 'blank'} waits as new reads do`);
        }
      }
    };

    /** One settings change, as the panel makes it: the plan first, then the change; both checked against the rules. */
    const edit = (races, what, deletedIds = []) => {
      const before = view(s.config.races);
      const next = { ...s.config, races: legal(races) };
      const pre = new Map(reads.map((r) => [r, r.entry.raceId]));
      // what the panel would show before saving (planChange), checked against what then happens
      const plan = s.engine.planChange(next, { deleted: deletedIds });
      for (const r of next.races) names.set(r.id, r.name);
      s.config.races = next.races;
      s.engine.configChanged({ deleted: deletedIds });
      const after = view(s.config.races);
      const { deletedNow, from, asideBefore, heldBefore } = change(before, after, deletedIds);
      seen.plans++;
      // R1, checked on the engine's own rows: a race that is not Active keeps exactly the reads it has (a missing race
      // that is back in the settings gets its own reads back)
      for (const q of after.filter((r) => !r.active && before.some((b) => b.id === r.id))) {
        const had = reads.filter((r) => pre.get(r) === q.id).map((r) => r.bib);
        const has = reads.filter((r) => r.entry.raceId === q.id).map((r) => r.bib);
        assert.deepEqual(has, had, `seed ${seed}, ${what}: ${q.id} is not active and keeps its reads`);
        if (had.length) seen.frozenKept++;
      }
      // the plan said exactly this
      const moved = new Map();
      for (const r of reads) {
        if (r.gone !== null) continue;
        const a = placeOf(before, asideBefore, heldBefore, from.get(r), r.c);
        const b = placeOf(after, aside, held, r.raceId, r.c);
        if (a === b) continue;
        if (r.raceId !== null && r.raceId === r.home && from.get(r) !== null && after.some((x) => x.id === r.raceId)) seen.back++; // rule d
        const k = `${r.c}|${a}|${b}`;
        moved.set(k, (moved.get(k) ?? 0) + 1);
      }
      const planned = plan.moves.map((m) => `${matchKey(m.contest)}|${m.from.raceId ?? m.from.status}|${m.to.raceId ?? m.to.status}|${m.count}`).sort();
      assert.deepEqual(planned, [...moved].map(([k, n]) => `${k}|${n}`).sort(), `seed ${seed}, ${what}: the plan's moves`);
      const del = new Map();
      for (const r of deletedNow) del.set(r.raceId, (del.get(r.raceId) ?? 0) + 1);
      assert.deepEqual(plan.deleted.map((d) => [d.raceId, d.count]).sort(), [...del].sort(), `seed ${seed}, ${what}: the plan's deleted reads`);
      const newly = [...aside].filter(([c]) => !asideBefore.has(c));
      assert.deepEqual(plan.setAside.map((a) => [matchKey(a.contest), a.deleted, a.reason]).sort(),
        newly.map(([c, a]) => [c, a.deleted, reasonOf(a, after)]).sort(), `seed ${seed}, ${what}: the plan's set-asides`);
      assert.deepEqual(plan.usedAgain.map(matchKey).sort(), [...asideBefore.keys()].filter((c) => !aside.has(c)).sort(), `seed ${seed}, ${what}: used again`);
      // where new reads of each contest go, before and after: every change is in the plan, and nothing else
      const nr = new Map(plan.newReads.map((n) => [n.blank ? '' : matchKey(n.contest), n]));
      for (const c of CONTESTS.map(matchKey)) {
        const a = newTarget(before, asideBefore, heldBefore, c);
        const b = newTarget(after, aside, held, c);
        const pa = placeOf(before, asideBefore, heldBefore, a, c, true);
        const pb = placeOf(after, aside, held, b, c, true);
        if (pa === pb) assert.ok(!nr.has(c), `seed ${seed}, ${what}: new reads of ${c || 'blank'} go where they went`);
        else if (nr.has(c) || reads.some((r) => r.c === c)) {
          const n = nr.get(c);
          assert.deepEqual([n?.from.raceId ?? n?.from.status, n?.to.raceId ?? n?.to.status], [a ?? pa, b ?? pb], `seed ${seed}, ${what}: new reads of ${c || 'blank'}`);
        }
      }
      for (const k of plan.kept) {
        const n = reads.filter((r) => live(r) && r.raceId === k.raceId && r.c === matchKey(k.contest)).length;
        assert.ok(n === k.count && !after.find((q) => q.id === k.raceId).active, `seed ${seed}, ${what}: kept ${k.contest} in ${k.raceId}`);
      }
      seen.deleted += deletedNow.length;
      for (const [, a] of newly) seen[a.deleted ? 'asideDeleted' : 'asideUnlisted']++;
      seen.unaside += plan.usedAgain.length;
      if (held.size) seen.held++;
      s.clock.advance(Math.floor(rand() * 3000));
      check(what);
    };
    const copyRaces = () => s.config.races.map((r) => ({ ...r, contests: [...r.contests] }));
    const todOf = (b, ms = Math.floor(rand() * 1000)) => `10:${String(4 + Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    const snapOf = (e, races = s.config.races) => ({ aside: e.setAside(), noRace: e.noRace(), missing: e.missingRaces(),
      races: races.map((q) => [q.id, e.crossings(q.id).map((c) => [c.bib, c.tod, c.place]), e.raceView(q.id)?.runners]) });

    let bib = 0;
    for (let step = 0; step < 170; step++) {
      const x = rand();
      if (x < 0.53) {
        const c = pick(CONTESTS);
        const rs = view(s.config.races);
        const r = { bib: String(++bib), c: matchKey(c), seq: 0, raceId: null, home: null, gone: null };
        r.entry = s.read('1K-A', r.bib, todOf(bib), { contest: c });
        r.raceId = newTarget(rs, aside, held, r.c);
        r.home = r.raceId ?? (r.c && aside.has(r.c) ? 'ASIDE' : null);
        if (r.raceId === null && r.c && lists(rs, r.c).length) seen.waiting++;
        if (r.raceId === null && held.has(r.c)) seen.straggler++;
        reads.push(r);
        s.clock.advance(Math.floor(rand() * 3000));
        check(`read ${r.bib}`);
        continue;
      }
      if (x < 0.58) {
        // Clear race data (R3): the reads the race holds now are out of use for good, wherever they would move
        const r = pick(s.config.races);
        if (!r) continue;
        s.engine.clearRace(r.id);
        for (const q of reads) if (live(q) && q.raceId === r.id) {
          q.gone = 'cleared';
          seen.cleared++;
        }
        check(`clear ${r.id}`);
        continue;
      }
      if (x < 0.62) {
        // a restart from the journal so far gives the same and journals nothing (a copy, so this run goes on)
        s.engine.flush();
        const copy = cloneStore(store);
        const n = copy.journal.length;
        const t = setup({ store: copy, config: structuredClone(s.config) });
        assert.deepEqual(snapOf(t.engine), snapOf(s.engine), `seed ${seed}, restart at step ${step}`);
        assert.equal(copy.journal.length, n, `seed ${seed}, restart at step ${step}: nothing journaled`);
        t.engine.stop();
        if (!s.config.races.length) continue;
        // R6: the same journal started with a race gone from the settings (config.json put back from an older copy):
        // the race is missing, not deleted. Nothing but moves is journaled; its reads wait for it, and so do new reads
        // of its contests that would otherwise go to the race that takes every contest.
        const lost = pick(s.config.races);
        const copy2 = cloneStore(store);
        const cfg2 = structuredClone(s.config);
        cfg2.races = cfg2.races.filter((q) => q.id !== lost.id);
        // an older config.json differs in other ways too: a race switched on or off, or listing other contests (a
        // set-aside one among them)
        if (cfg2.races.length && rand() < 0.6) {
          const q = pick(cfg2.races);
          if (rand() < 0.5) q.active = !q.active;
          else q.contests = rand() < 0.3 ? [] : [...new Set([...(aside.size && rand() < 0.6 ? [pick([...aside.keys()]).toUpperCase()] : []), ...CONTESTS.slice(0, 4).filter(() => rand() < 0.3)])];
          legal(cfg2.races);
          seen.startEdited++;
        }
        const m = setup({ store: copy2, config: cfg2 });
        const recs = copy2.journal.slice(n).map((l) => JSON.parse(l));
        assert.ok(recs.every((q) => q.t === 'route'), `seed ${seed}, start without ${lost.id}: only moves are journaled (${recs.map((q) => q.t)})`);
        const mine = reads.filter((r) => live(r) && r.raceId === lost.id);
        const gone2 = new Map();
        for (const r of reads) if (live(r) && r.raceId !== null && !cfg2.races.some((q) => q.id === r.raceId)) gone2.set(r.raceId, (gone2.get(r.raceId) ?? 0) + 1);
        assert.deepEqual(m.engine.missingRaces().map((q) => [q.raceId, q.raceName, q.count]).sort(), [...gone2].map(([id, k]) => [id, names.get(id), k]).sort(),
          `seed ${seed}, start without ${lost.id}: it is missing, named as its race file has it`);
        if (mine.length) seen.startLost++;
        // where new reads go now, by the rules worked out at start (before = null)
        const after2 = view(cfg2.races);
        const p = planModel(null, after2, []);
        if (p.hd.size) seen.startHeld++;
        for (const c of CONTESTS) {
          const e = m.read('1K-A', `8${bib}${c}`, '10:30:00', { contest: c });
          assert.deepEqual([e.raceId, e.raceId === null ? e.status : 'in a race'], [newTarget(after2, p.set, p.hd, matchKey(c)),
            newTarget(after2, p.set, p.hd, matchKey(c)) === null ? whyNoRace(after2, p.set, p.hd, matchKey(c)) : 'in a race'],
          `seed ${seed}, start without ${lost.id}: a new read of ${c || 'blank'}`);
        }
        m.engine.stop();
        // with the right settings back, its reads come back to it; when that start moved nothing, everything is as it was
        const copy3 = cloneStore(store);
        const cfg3 = structuredClone(s.config);
        cfg3.races = cfg3.races.filter((q) => q.id !== lost.id);
        const m3 = setup({ store: copy3, config: cfg3 });
        const moved3 = copy3.journal.length > n;
        m3.engine.stop();
        const back = setup({ store: copy3, config: structuredClone(s.config) });
        const crossed = (e) => e.crossings(lost.id).map((c) => [c.bib, c.tod, c.place]);
        assert.deepEqual(crossed(back.engine), crossed(s.engine), `seed ${seed}: ${lost.id} back in the settings has its crossings back`);
        if (!moved3) assert.deepEqual(snapOf(back.engine), snapOf(s.engine), `seed ${seed}: everything is back as it was with ${lost.id}`);
        back.engine.stop();
        continue;
      }
      const races = copyRaces();
      if (x < 0.69 && races.length < 6) {
        races.splice(Math.floor(rand() * (races.length + 1)), 0, newRace());
        edit(races, `step ${step}: add`);
      } else if (x < 0.76 && races.length) {
        const gone = races.splice(Math.floor(rand() * races.length), 1)[0];
        edit(races, `step ${step}: delete ${gone.id}`, [gone.id]);
      } else if (x < 0.78 && races.length) {
        // R6 while running: a race leaves the settings without being deleted (only a restart with an older
        // config.json does that on race day): it is missing, its reads wait for it
        const i = Math.floor(rand() * races.length);
        const gone = races.splice(i, 1)[0];
        lostRaces.set(gone.id, { ...gone, contests: [...gone.contests] });
        seen.lost++;
        edit(races, `step ${step}: lose ${gone.id}`);
      } else if (x < 0.8 && lostRaces.size) {
        const id = pick([...lostRaces.keys()]);
        const back = lostRaces.get(id);
        lostRaces.delete(id);
        if (rand() < 0.35) {
          // ...and is deleted by the operator (the Delete button on its warning): its reads go out of use (R2)
          seen.lostDeleted++;
          edit(races, `step ${step}: delete the missing ${id}`, [id]);
          continue;
        }
        // ...or comes back: everything returns to it
        races.splice(Math.floor(rand() * (races.length + 1)), 0, back);
        const had = reads.filter((r) => live(r) && r.raceId === id).map((r) => r.bib);
        edit(races, `step ${step}: ${id} is back`);
        if (had.length) seen.returned++;
        // back but not Active (legal() may switch it off): it has exactly its own reads back (R1)
        if (!s.config.races.find((q) => q.id === id).active) {
          assert.deepEqual(reads.filter((r) => live(r) && r.entry.raceId === id).map((r) => r.bib), had, `seed ${seed}: ${id}'s reads are back`);
        }
      } else if (x < 0.85 && races.length) {
        const r = pick(races);
        if (rand() < 0.5) {
          // one contest added or taken off
          const c = pick(CONTESTS.slice(0, 4));
          r.contests = r.contests.includes(c) ? r.contests.filter((k) => k !== c) : [...r.contests, c];
        } else r.contests = rand() < 0.3 ? [] : CONTESTS.slice(0, 4).filter(() => rand() < 0.45);
        edit(races, `step ${step}: contests of ${r.id}`);
      } else if (x < 0.89) {
        // a misclick: a contest the race taking every contest has reads of, added to another active race; often
        // undone at once, sometimes after more reads came
        const all = races.find((q) => q.active && !q.contests.length);
        const inAll = all ? reads.filter((q) => live(q) && q.raceId === all.id && q.c).map((q) => q.c) : [];
        const to = races.filter((q) => q.active && q.contests.length);
        if (!inAll.length || !to.length) continue;
        const c = pick(inAll);
        const r = pick(to);
        if (r.contests.map(matchKey).includes(c)) continue;
        r.contests = [...r.contests, c.toUpperCase()];
        edit(races, `step ${step}: misclick ${c} on ${r.id}`);
        if (rand() < 0.3) continue;
        const undo = copyRaces();
        const u = undo.find((q) => q.id === r.id);
        u.contests = u.contests.filter((k) => matchKey(k) !== c);
        edit(undo, `step ${step}: undo ${c} on ${r.id}`);
      } else if (x < 0.92) {
        // a spare race, switched off, that lists a contest whose reads are set aside or in the race taking every
        // contest (yesterday's race, a copy made in advance): its reads wait for it (C1); often deleted again, or the
        // contest taken off it
        const all = races.find((q) => q.active && !q.contests.length);
        const cs = [...aside.keys(), ...reads.filter((q) => live(q) && all && q.raceId === all.id && q.c).map((q) => q.c)];
        if (!cs.length || races.length >= 6) continue;
        const spare = newRace();
        spare.active = false;
        spare.contests = [pick(cs).toUpperCase()];
        races.push(spare);
        edit(races, `step ${step}: spare ${spare.id} for ${spare.contests[0]}`);
        const y = rand();
        if (y < 0.3) continue;
        if (y < 0.65) {
          // a read of the contest arrives first: it waits for the spare race, in no race
          const c = matchKey(spare.contests[0]);
          const r = { bib: String(++bib), c, seq: 0, raceId: newTarget(view(s.config.races), aside, held, c), home: null, gone: null };
          r.home = r.raceId;
          r.entry = s.read('1K-A', r.bib, todOf(bib, 500), { contest: spare.contests[0] });
          reads.push(r);
          if (r.raceId === null) seen.waiting++;
          check(`read ${r.bib} waiting for the spare race`);
        }
        const later = copyRaces();
        const del = rand() < 0.5;
        if (del) later.splice(later.findIndex((q) => q.id === spare.id), 1);
        else later.find((q) => q.id === spare.id).contests = [];
        edit(later, `step ${step}: spare ${spare.id} ${del ? 'deleted' : 'takes every contest'}`, del ? [spare.id] : []);
      } else if (x < 0.97 && races.length) {
        const r = pick(races);
        r.active = !r.active;
        edit(races, `step ${step}: ${r.active ? 'activate' : 'deactivate'} ${r.id}`);
      } else if (races.length) {
        const r = pick(races);
        r.name = `${r.name}*`;
        edit(races, `step ${step}: rename ${r.id}`);
      }
    }
    s.clock.advance(70_000);
    const snap = (e) => ({
      aside: e.setAside(), noRace: e.noRace(), missing: e.missingRaces(),
      races: s.config.races.map((r) => {
        const v = e.raceView(r.id);
        return {
          id: r.id,
          crossings: e.crossings(r.id).map((c) => [c.bib, c.splitId, c.tod, c.raceTicks, c.place, c.reads]),
          view: [v.runners, v.waitingGun, v.beforeGun, v.startArea, v.contestsSeen, v.unmapped],
          data: [...(e.raceData(r.id)?.runners ?? [])].map(([b, d]) => [b, d.splits]),
        };
      }),
    });
    const incremental = snap(s.engine);
    // The same reads and settings worked out from scratch: every race rebuilt, then a restart from the journal.
    for (const r of s.config.races) r.splits[0].sources.push(`Never-${seed}`);
    s.engine.configChanged();
    for (const r of s.config.races) r.splits[0].sources.pop();
    s.engine.configChanged();
    assert.deepEqual(snap(s.engine), incremental, `rebuild, seed ${seed}`);
    s.engine.stop();
    s.engine.markCleanStop();
    const lines = store.journal.length;
    s = setup({ store, config: s.config });
    assert.deepEqual(snap(s.engine), incremental, `restart, seed ${seed}`);
    assert.equal(store.journal.length, lines, `restart, seed ${seed}: the start's settle changes nothing`);
    // and new reads after the restart go where the rules put them; replays of every old read are duplicates, except a
    // cleared one: clear, then Replay in RR12, rebuilds a race, so RR12 sending it again counts as a new read
    const rs = view(s.config.races);
    for (const c of CONTESTS) {
      const e = s.read('1K-A', `9${bib++}`, '10:20:00', { contest: c });
      assert.equal(e.raceId, newTarget(rs, aside, held, matchKey(c)), `after restart, seed ${seed}, contest ${c || 'blank'}`);
    }
    for (const r of reads.slice(0, 20)) {
      const status = s.engine.handleRead({ location: '1K-A', bib: r.bib, tod: JSON.parse(store.journal.find((l) => JSON.parse(l).bib === r.bib)).tod, contest: '' }).status;
      if (r.gone === 'cleared') assert.notEqual(status, 'duplicate', `seed ${seed}: a replayed cleared read counts again`);
      else assert.equal(status, 'duplicate');
    }
  }
  // every rule was exercised
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `the random edits never hit: ${k}`);
});

test('routing stays sticky for a finished race that is switched off: it keeps its reads, so its .lif keeps its splits', () => {
  const s = setup({ races: [race({ id: 'r1', name: 'Race 1', contests: [] }), race({ id: 'v', name: 'Varsity', contests: ['Varsity'], eventNumber: '4' })] });
  s.read('1K-A', 1, '10:03:00', { contest: 'Open' });
  s.read('1K-A', 2, '10:03:01', { contest: 'Varsity' });
  // Race 1 (every contest) and Varsity are over: switched off; Race 2 now takes every contest, JV lists Varsity too
  s.config.races[0].active = false;
  s.config.races[1].active = false;
  s.config.races.push(race({ id: 'r2', name: 'Race 2', contests: [], eventNumber: '5', gun: '11:00:00.000' }));
  s.config.races.push(race({ id: 'jv', name: 'JV', contests: ['Varsity'], eventNumber: '6', gun: '11:00:00.000' }));
  s.engine.configChanged();
  assert.deepEqual([...s.engine.raceData('r1').runners.keys()], ['1']);
  assert.deepEqual([...s.engine.raceData('v').runners.keys()], ['2']);
  assert.deepEqual(s.engine.setAside(), []);
  // new reads go to the races that are running now
  assert.equal(s.read('1K-A', 3, '11:03:00', { contest: 'Open' }).raceId, 'r2');
  assert.equal(s.read('1K-A', 4, '11:03:00', { contest: 'Varsity' }).raceId, 'jv');
});

// ---- Revision 5 (DESIGN 9.2): regression tests for the problems found by the re-check of revision 4 (P1-P6). ----------

/** A clean stop and a start from the same journal and settings. */
function restartOf(s) {
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = s.store.journal.length;
  const t = setup({ store: s.store, config: s.config });
  assert.equal(s.store.journal.length, lines, 'the start replays to the same result: nothing to journal');
  return t;
}
const rowOf = (s, bib) => s.engine.feed(1000).find((e) => e.bib === String(bib));

test('P1: an active race changed to take every contest keeps its reads, even when their home race is switched off', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open', contests: [] })] });
  for (const b of [1, 2, 3]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' });
  s.config.races.push(race({ id: 'jv', name: 'JV 5K', contests: ['JV'], eventNumber: '4' }));
  s.engine.configChanged();
  s.read('1K-A', 4, '10:03:04', { contest: 'JV' }); // arrived while JV 5K listed JV
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'jv'), ['1:1', '2:2', '3:3', '4:4']);
  s.config.races[0].active = false; // Open has finished
  s.engine.configChanged();
  const before = s.sends.length;
  s.config.races[1].contests = []; // JV 5K now takes every contest (valid: the only active one that does)
  s.engine.configChanged();
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'jv'), ['1:1', '2:2', '3:3', '4:4'], 'R4c: the reads stay in the active race that takes every contest');
  assert.deepEqual(places(s, 'open'), [], 'R1: nothing moves into a race that is not active');
  s.read('1K-A', 5, '10:03:05', { contest: 'JV' });
  s.clock.advance(3000);
  assert.deepEqual(sent(s.sends.slice(before)), [['5', 5, 'new']], 'the 5th JV runner is sent as place 5');
  const t = restartOf(s);
  assert.deepEqual(places(t, 'jv'), ['1:1', '2:2', '3:3', '4:4', '5:5']);
});

test('P2: deleting a race whose reads came from a race now switched off: stragglers are set aside, not put in another catch-all', () => {
  const s = setup({ races: [race({ id: 'am', name: 'Open AM', contests: [] })] });
  for (const b of [1, 2]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' });
  s.config.races.push(race({ id: 'jv', name: 'JV 5K', contests: ['JV'], eventNumber: '4' }));
  s.engine.configChanged();
  s.config.races[0].active = false;
  s.config.races.push(race({ id: 'pm', name: 'Open PM', contests: [], eventNumber: '9' }));
  s.engine.configChanged();
  s.read('1K-A', 201, '10:03:00', { contest: 'Masters' });
  s.clock.advance(3000);
  const before = s.sends.length;
  const plan = s.engine.planChange({ ...s.config, races: s.config.races.filter((r) => r.id !== 'jv') }, { deleted: ['jv'] });
  assert.deepEqual(plan.deleted, [{ raceId: 'jv', raceName: 'JV 5K', count: 2, contests: [{ contest: 'JV', blank: false, count: 2 }] }]);
  assert.deepEqual(plan.setAside, [{ contest: 'JV', reason: "its race 'JV 5K' was deleted", deleted: true, count: 0 }]);
  deleteRaces(s, 'jv');
  assert.deepEqual([rowOf(s, 1).status, rowOf(s, 1).detail], ['race-deleted', "Its race 'JV 5K' was deleted, so this read is not used."]);
  const late = s.read('1K-A', 3, '10:03:03', { contest: 'JV' });
  s.clock.advance(3000);
  assert.deepEqual([late.status, late.raceId], ['set-aside', null]);
  assert.deepEqual(places(s, 'pm'), ['201:1'], 'no JV runner in Open PM');
  assert.equal(s.sends.length, before);
  assert.deepEqual(places(s, 'am'), [], 'Open AM is not active: it took nothing back');
  const t = restartOf(s);
  assert.deepEqual(t.engine.setAside().map((a) => [a.contest, a.count]), [['JV', 1]]);
});

test('P3: a finished race that is switched off keeps its reads and .lif splits when a new race lists one of its contests', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open', contests: [] })] });
  for (const b of [1, 2, 3]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' });
  s.read('1K-A', 9, '10:03:10', { contest: 'Frosh' });
  s.clock.advance(3000);
  s.config.races[0].active = false;
  s.engine.configChanged();
  const lif = [...s.engine.raceData('open').runners.keys()];
  const next = { ...s.config, races: [...s.config.races, race({ id: 'jv2', name: 'JV (afternoon)', contests: ['JV'], eventNumber: '5', gun: '13:00:00.000' })] };
  const plan = s.engine.planChange(next);
  assert.deepEqual(plan.moves, [], 'nothing moves');
  assert.deepEqual(plan.kept, [{ contest: 'JV', blank: false, count: 3, raceId: 'open', raceName: 'Open' }], 'the dialog: "Open is not Active, so it keeps its reads"');
  assert.deepEqual(plan.newReads.map((n) => [n.contest, n.from.raceId, n.to.raceId]), [['JV', null, 'jv2']]);
  s.config.races = next.races;
  s.engine.configChanged();
  assert.deepEqual([...s.engine.raceData('open').runners.keys()], lif);
  assert.deepEqual(lif, ['1', '2', '3', '9']);
  assert.equal(s.read('1K-A', 4, '13:03:04', { contest: 'JV' }).raceId, 'jv2');
  assert.deepEqual([...restartOf(s).engine.raceData('open').runners.keys()], lif);
});

test('P4: reads that move into a race cleared before they came count there; a cleared read stays out of use wherever it would go', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open', contests: [] }), race({ id: 'jv', name: 'JV 5K', contests: ['Frosh'], eventNumber: '4' })] });
  const old = [1, 2, 3].map((b) => s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' }));
  s.clock.advance(3000);
  s.engine.clearRace('jv'); // after a test start: JV 5K held none of these
  s.config.races[1].contests = ['Frosh', 'JV'];
  s.engine.configChanged();
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'jv'), ['1:1', '2:2', '3:3']);
  assert.ok(old.every((e) => e.raceId === 'jv' && e.status === 'sent'), old.map((e) => `${e.raceId}:${e.status}`).join());
  s.config.races[1].contests = ['Frosh']; // and taken out again: back to Open
  s.engine.configChanged();
  assert.deepEqual(places(s, 'open'), ['1:1', '2:2', '3:3']);
  // R3: Open is cleared now; its reads do not come back in another race
  s.engine.clearRace('open');
  assert.ok(old.every((e) => e.status === 'cleared' && e.raceId === 'open'), old.map((e) => e.status).join());
  assert.match(old[0].detail, /^Cleared with "Clear race data" in Open, so it is not used/);
  s.config.races[1].contests = ['Frosh', 'JV'];
  s.engine.configChanged();
  assert.deepEqual([places(s, 'jv'), places(s, 'open')], [[], []]);
  assert.ok(old.every((e) => e.status === 'cleared'));
  // RR12 sending a cleared read again (clear, then Replay, rebuilds a race) counts as a new read, routed as one
  const replay = s.read('1K-A', 1, '10:03:01', { contest: 'JV' });
  assert.deepEqual([replay.raceId, replay.status === 'duplicate'], ['jv', false]);
  const late = s.read('1K-A', 4, '10:03:04', { contest: 'JV' });
  assert.equal(late.raceId, 'jv', 'a new read counts as usual');
  const t = restartOf(s);
  assert.deepEqual([places(t, 'jv'), places(t, 'open')], [['1:1', '4:2'], []]);
  // the journal has the clears as they were made: the reads each race held then
  assert.deepEqual(s.store.journal.map((l) => JSON.parse(l)).filter((r) => r.t === 'clear').map((r) => [r.raceId, r.seq]), [['jv', 3], ['open', 3]]);
});

test('P5: deleting a paused copy takes its reads out of use; none go live into the active race that lists the same contest', () => {
  const s = setup({ races: [race({ id: 'y', name: 'Boys (yesterday)', contests: ['Boys Varsity'] })] });
  for (const b of [1, 2, 3]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'Boys Varsity' });
  s.clock.advance(3000);
  s.config.races[0].active = false;
  s.config.races.push(race({ id: 'today', name: 'Boys (today)', contests: ['Boys Varsity'], eventNumber: '4' }));
  s.engine.configChanged();
  assert.deepEqual(places(s, 'today'), [], "R1: yesterday's race keeps its reads");
  s.read('1K-A', 7, '10:03:05', { contest: 'Boys Varsity' });
  s.clock.advance(3000);
  const before = s.sends.length;
  const plan = s.engine.planChange({ ...s.config, races: [s.config.races[1]] }, { deleted: ['y'] });
  assert.deepEqual([plan.moves, plan.setAside, plan.deleted.map((d) => d.count)], [[], [], [3]]);
  deleteRaces(s, 'y');
  s.clock.advance(3000);
  assert.equal(s.sends.length, before, 'nothing sent on the delete');
  assert.deepEqual(places(s, 'today'), ['7:1']);
  assert.equal(rowOf(s, 1).status, 'race-deleted');
  assert.deepEqual(s.engine.setAside(), [], 'Boys (today) lists the contest: nothing is set aside');
});

test('P6: the set-aside reason and button are worked out when shown: a rename or a later delete of the race is reflected', () => {
  const s = setup({ races: [race({ id: 'rg', name: 'Girls 5K', contests: [] }), race({ id: 'o', name: 'Other', contests: ['X'], eventNumber: '4' })] });
  const boy = s.read('1K-A', 888, '10:03:00', { contest: 'Boys Varsity' });
  s.config.races[0].contests = ['Girls Varsity'];
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside().map((a) => [a.reason, a.raceId, a.raceName]), [["'Girls 5K' no longer lists it", 'rg', 'Girls 5K']]);
  s.config.races[0].name = 'Girls Varsity 5K';
  s.engine.configChanged();
  assert.deepEqual(s.engine.setAside().map((a) => [a.reason, a.raceId]), [["'Girls Varsity 5K' no longer lists it", 'rg']]);
  assert.equal(boy.detail, "Reads of 'Boys Varsity' are not used: 'Girls Varsity 5K' no longer lists it. List the contest on an Active race to use them.");
  deleteRaces(s, 'rg');
  assert.deepEqual(s.engine.setAside().map((a) => [a.reason, a.raceId, a.raceName, a.count]), [["'Girls Varsity 5K' was deleted", null, 'Girls Varsity 5K', 1]]);
  assert.equal(boy.detail, "Reads of 'Boys Varsity' are not used: 'Girls Varsity 5K' was deleted. List the contest on an Active race to use them.");
  const t = restartOf(s);
  assert.deepEqual(t.engine.setAside().map((a) => [a.reason, a.raceId]), [["'Girls Varsity 5K' was deleted", null]]);
});

test('R2: deleting a paused race never takes reads away from the race that takes every contest', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open', contests: [] })] });
  for (const b of [1, 2]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' });
  s.clock.advance(3000);
  // a copy made in advance, switched off, that lists JV: an explicit listing beats "every contest", so JV's reads wait
  // for it in no race, the new ones too (revision 6, C1). The plan says so before it is saved.
  const spare = race({ id: 'x', name: 'JV spare', contests: ['JV'], eventNumber: '4', active: false });
  const plan = s.engine.planChange({ ...s.config, races: [...s.config.races, spare] });
  assert.deepEqual(plan.moves, [{ contest: 'JV', blank: false, count: 2, from: { raceId: 'open', raceName: 'Open', active: true },
    to: { raceId: null, status: 'paused', raceName: 'JV spare', waitsFor: 'x' } }]);
  s.config.races.push(spare);
  s.engine.configChanged();
  assert.deepEqual([s.read('1K-A', 3, '10:03:03', { contest: 'JV' }).status, rowOf(s, 3).raceId], ['paused', null]);
  assert.deepEqual([rowOf(s, 1).status, rowOf(s, 1).raceId], ['paused', null]);
  assert.deepEqual([places(s, 'open'), places(s, 'x')], [[], []]);
  // deleted again: it held none of them, so none is out of use; they go back to Open, the new one with them
  deleteRaces(s, 'x');
  s.clock.advance(3000);
  assert.deepEqual(s.engine.setAside(), [], 'Open has reads of JV: new ones go there with them');
  assert.deepEqual(places(s, 'open'), ['1:1', '2:2', '3:3']);
  assert.equal(s.read('1K-A', 4, '10:03:04', { contest: 'JV' }).raceId, 'open');
  // a finished catch-all deleted while another runs: its contests' new reads keep going to the running one
  const d = setup({ races: [race({ id: 'am', name: 'Open AM', contests: [], active: false }), race({ id: 'pm', name: 'Open PM', contests: [], eventNumber: '9', active: false })] });
  d.read('1K-A', 1, '10:03:01', { contest: 'JV' }); // no race takes it: no race
  d.config.races[0].active = true;
  d.engine.configChanged();
  d.config.races[0].active = false;
  d.config.races[1].active = true;
  d.engine.configChanged();
  d.read('1K-A', 2, '10:03:02', { contest: 'JV' });
  assert.deepEqual([places(d, 'am'), places(d, 'pm')], [['1:1'], ['2:1']]);
  deleteRaces(d, 'am');
  assert.deepEqual([d.engine.setAside(), places(d, 'pm')], [[], ['2:1']]);
});

test('R4e and ASIDE: reads that waited with no race go with their contest when it is set aside, used again and let go again', () => {
  const s = setup({ races: [race({ id: 'b', name: 'Boys', contests: ['Boys'] }), race({ id: 'x', name: 'JV', contests: ['JV'], eventNumber: '4' })] });
  s.read('1K-A', 2, '10:03:02', { contest: 'JV' }); // in JV
  s.config.races[1].active = false; // JV is over: it keeps its read (R1)
  s.engine.configChanged();
  const early = s.read('1K-A', 1, '10:03:01', { contest: 'JV' });
  assert.deepEqual([early.status, early.raceId], ['paused', null], 'it waits for JV in no race (C1)');
  assert.match(early.detail, /^Its race 'JV' is not Active. These reads are used when you tick Active./);
  assert.equal(s.engine.raceView('x').runners, 1);
  deleteRaces(s, 'x'); // JV deleted with its read: the contest it was waiting for is set aside, the early read with it
  assert.deepEqual([early.status, s.engine.setAside().map((a) => [a.contest, a.count])], ['set-aside', [['JV', 1]]]);
  s.config.races.push(race({ id: 'all', name: 'Open', contests: [], eventNumber: '9' })); // a catch-all does not take it
  s.engine.configChanged();
  assert.equal(early.status, 'set-aside');
  s.config.races.push(race({ id: 'y', name: 'JV again', contests: ['JV'], eventNumber: '5', active: false }));
  s.engine.configChanged();
  assert.deepEqual([early.status, early.raceId, s.engine.setAside()], ['paused', null, []], 'listed again, by a race that is not active: it waits');
  deleteRaces(s, 'y'); // and deleted again before it held a read: the contest is set aside again, not given to Open
  assert.deepEqual([early.status, early.raceId], ['set-aside', null]);
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['JV', "'JV again' was deleted", 1]]);
  assert.deepEqual(places(s, 'all'), []);
  const t = restartOf(s);
  assert.deepEqual([places(t, 'all'), t.engine.setAside().map((a) => a.count)], [[], [1]]);
});

test('planChange says what saving or deleting a race would do, and changes nothing', () => {
  const s = setup({ races: [race({ id: 'open', name: 'Open 5K', contests: [] }), race({ id: 'b', name: 'Boys', contests: ['Boys'], eventNumber: '4' })] });
  for (const b of [1, 2, 3]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'JV' });
  s.read('1K-A', 4, '10:03:04', { contest: 'Novice' });
  s.read('1K-A', 5, '10:03:05', { contest: 'Boys' });
  const lines = s.store.journal.length;
  // a new race listing JV
  const add = s.engine.planChange({ ...s.config, races: [...s.config.races, race({ id: 'new', name: 'JV 4K', contests: ['JV'], eventNumber: '5' })] });
  assert.deepEqual(add.moves, [{ contest: 'JV', blank: false, count: 3, from: { raceId: 'open', raceName: 'Open 5K', active: true }, to: { raceId: 'new', raceName: 'JV 4K', active: true } }]);
  assert.deepEqual(add.newReads.map((n) => [n.contest, n.reads, n.from.raceId, n.to.raceId]), [['JV', 3, 'open', 'new']]);
  // the same race, not active: its listing beats the race that takes every contest, so the JV reads leave Open and
  // wait for it in no race, the new ones too (revision 6, C1)
  const paused = s.engine.planChange({ ...s.config, races: [...s.config.races, race({ id: 'new', name: 'JV 4K', contests: ['JV'], eventNumber: '5', active: false })] });
  assert.deepEqual(paused.moves, [{ contest: 'JV', blank: false, count: 3, from: { raceId: 'open', raceName: 'Open 5K', active: true }, to: { raceId: null, status: 'paused', raceName: 'JV 4K', waitsFor: 'new' } }]);
  assert.deepEqual(paused.newReads.map((n) => [n.contest, n.to.raceId, n.to.status, n.to.raceName]), [['JV', null, 'paused', 'JV 4K']]);
  // Open narrowed to JV sets Novice aside
  const narrow = s.engine.planChange({ ...s.config, races: [{ ...s.config.races[0], contests: ['JV'] }, s.config.races[1]] });
  assert.deepEqual(narrow.moves.map((m) => [m.contest, m.count, m.from.raceId, m.to.status]), [['Novice', 1, 'open', 'set-aside']]);
  assert.deepEqual(narrow.setAside, [{ contest: 'Novice', reason: "'Open 5K' no longer lists it", deleted: false, count: 1 }]);
  // deleting Open
  const del = s.engine.planChange({ ...s.config, races: [s.config.races[1]] }, { deleted: ['open'] });
  assert.deepEqual(del.deleted, [{ raceId: 'open', raceName: 'Open 5K', count: 4, contests: [{ contest: 'JV', blank: false, count: 3 }, { contest: 'Novice', blank: false, count: 1 }] }]);
  assert.deepEqual(del.setAside.map((a) => [a.contest, a.reason, a.count]), [['JV', "its race 'Open 5K' was deleted", 0], ['Novice', "its race 'Open 5K' was deleted", 0]]);
  assert.deepEqual(del.moves, []);
  // nothing changed
  assert.equal(s.store.journal.length, lines);
  assert.deepEqual([places(s, 'open').length, s.engine.setAside()], [4, []]);
});

// ---- Revision 6 (DESIGN 9.2 C1, R6): regression tests for the re-check of revision 5 (rc8 Q1-Q3), and missing races. --

test('Q1 (rc8): a contest that only a race that is not Active lists waits in no race, old and new reads together, until it is ticked Active', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const s = setup({ races: [race({ id: 'A', name: 'Open', contests: [], splits: sp })] });
  const r2 = s.read('1K-A', 2, '10:05:02', { contest: 'X' });
  s.clock.advance(3000);
  assert.deepEqual([r2.raceId, r2.status], ['A', 'sent']);
  s.config.races[0].active = false;
  s.engine.configChanged();
  const r1 = s.read('1K-A', 1, '10:05:01', { contest: 'X' });
  assert.deepEqual([r1.raceId, r1.status], [null, 'no-race']);
  s.config.races.push(race({ id: 'B', name: 'X race', contests: ['X'], eventNumber: '31', splits: sp, active: false }));
  s.engine.configChanged();
  assert.deepEqual([r1.raceId, r1.status, r1.detail], [null, 'paused', "Its race 'X race' is not Active. These reads are used when you tick Active."]);
  assert.deepEqual([r2.raceId, r2.status], ['A', 'sent'], 'Open is not Active: it keeps its read (R1)');
  // Open switched on again: X is listed (by a race that is not Active), so Open's X read comes out to wait with the
  // others. Before revision 6 it stayed in Open while the other two waited elsewhere: three places for one contest.
  const plan = s.engine.planChange({ ...s.config, races: s.config.races.map((r) => (r.id === 'A' ? { ...r, active: true } : r)) });
  assert.deepEqual(plan.moves, [{ contest: 'X', blank: false, count: 1, from: { raceId: 'A', raceName: 'Open', active: false },
    to: { raceId: null, status: 'paused', raceName: 'X race', waitsFor: 'B' } }]);
  s.config.races[0].active = true;
  s.engine.configChanged();
  const r3 = s.read('1K-A', 3, '10:05:03', { contest: 'X' });
  assert.deepEqual([r1, r2, r3].map((e) => [e.raceId, e.status]), [[null, 'paused'], [null, 'paused'], [null, 'paused']]);
  assert.deepEqual([places(s, 'A'), places(s, 'B')], [[], []]);
  assert.deepEqual(s.engine.noRace().map((n) => [n.contest, n.status, n.count, n.raceId]), [['X', 'paused', 3, 'B']]);
  // ticked Active: X race takes all three, in time order
  const before = s.sends.length;
  s.config.races[1].active = true;
  s.engine.configChanged();
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'B'), ['1:1', '2:2', '3:3']);
  // bib 2 first (its hold was long over), then 1 and 3 once theirs are: each once, with its place
  assert.deepEqual(s.sends.slice(before).map((p) => [p.raceId, p.bib, p.place]), [['B', '2', 2], ['B', '1', 1], ['B', '3', 3]]);
  assert.deepEqual(places(restartOf(s), 'B'), ['1:1', '2:2', '3:3']);
});

test('Q2 (rc8): a race that is not Active listing a set-aside contest makes all its reads wait for it; none goes to the race that takes every contest', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const s = setup({ races: [race({ id: 'A', name: 'Open', contests: [], splits: sp })] });
  const r1 = s.read('1K-A', 1, '10:05:01', { contest: 'Frosh' });
  s.clock.advance(3000);
  s.config.races.push(race({ id: 'B', name: 'Frosh 5K', contests: ['Frosh'], eventNumber: '41', splits: sp }));
  s.engine.configChanged();
  const r2 = s.read('1K-A', 2, '10:05:02', { contest: 'Frosh' });
  s.clock.advance(3000);
  s.config.races[1].contests = ['JV']; // Frosh 5K lets go of Frosh: r2 came to it first, so the contest is set aside
  s.engine.configChanged();
  assert.deepEqual([r1.status, r2.status, s.engine.setAside().map((a) => [a.contest, a.count])], ['set-aside', 'set-aside', [['Frosh', 2]]]);
  const spare = race({ id: 'C', name: 'Frosh (tomorrow)', contests: ['Frosh'], eventNumber: '42', splits: sp, active: false });
  const next = { ...s.config, races: [...s.config.races, spare] };
  const plan = s.engine.planChange(next);
  assert.deepEqual([plan.moves, plan.usedAgain], [[{ contest: 'Frosh', blank: false, count: 2, from: { raceId: null, status: 'set-aside' },
    to: { raceId: null, status: 'paused', raceName: 'Frosh (tomorrow)', waitsFor: 'C' } }], ['Frosh']]);
  assert.deepEqual(plan.newReads.map((n) => [n.contest, n.from.status, n.to.status, n.to.waitsFor]), [['Frosh', 'set-aside', 'paused', 'C']]);
  const n0 = s.sends.length;
  s.config.races = next.races;
  s.engine.configChanged();
  s.clock.advance(3000);
  // before revision 6, r1 went back to Open (its home) and was sent there, while r2 waited: one contest in two places
  assert.deepEqual([r1, r2].map((e) => [e.raceId, e.status]), [[null, 'paused'], [null, 'paused']]);
  assert.equal(s.sends.length, n0, 'nothing is sent on that change');
  const r3 = s.read('1K-A', 3, '10:05:03', { contest: 'Frosh' });
  assert.deepEqual([r3.raceId, r3.status], [null, 'paused']);
  assert.deepEqual(places(s, 'A'), []);
  s.config.races[2].active = true; // tomorrow is today
  s.engine.configChanged();
  s.clock.advance(3000);
  assert.deepEqual(places(s, 'C'), ['1:1', '2:2', '3:3']);
});

test('Q3 (rc8): config.json put back from an older copy at a restart: a race added since is missing, not deleted, and comes back with its reads', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const girls = race({ id: 'A', name: 'Girls 5K', contests: ['Girls'], eventNumber: '1', splits: sp });
  const boys = race({ id: 'B', name: 'Boys 5K', contests: ['Boys'], eventNumber: '2', splits: sp });
  const open = race({ id: 'O', name: 'Open', contests: [], eventNumber: '3', splits: sp });
  const store = memStore();
  const clock = fakeClock();
  const s = setup({ store, clock, races: [structuredClone(girls), structuredClone(open)] });
  s.config.races.push(structuredClone(boys)); // added after the last start: config.json.bak does not have it
  s.engine.configChanged();
  s.read('1K-A', 1, '10:05:01', { contest: 'Girls' });
  s.read('1K-A', 2, '10:05:02', { contest: 'Boys' });
  s.read('1K-A', 3, '10:05:03', { contest: 'Boys' });
  clock.advance(3000);
  assert.equal(s.sends.length, 3);
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  // config.json was damaged: Split Relay starts with config.json.bak, which has Girls 5K and Open only
  const t = setup({ store, clock, config: { ...s.config, races: [structuredClone(girls), structuredClone(open)] } });
  assert.equal(store.journal.length, lines, 'nothing is journaled at start: no delete, no set-aside');
  assert.deepEqual(t.engine.missingRaces(), [{ raceId: 'B', raceName: 'Boys 5K', count: 2, hasSettings: true, inputPort: null, contests: [{ contest: 'Boys', blank: false, count: 2 }] }],
    'named as its race file has it');
  assert.deepEqual(t.engine.setAside(), []);
  assert.ok(!store.removed.includes('B'), 'its race file stays where it is: nothing it had is sent twice when it comes back');
  assert.equal(t.engine.handleRead({ location: '1K-A', bib: '2', tod: parseTod('10:05:02'), contest: 'Boys' }).detail,
    'Already received (RR12 replay or a repeated line). Ignored.', 'a replay of its read is a duplicate, not "deleted"');
  // a straggler of its contest waits for it too: not in Open, where it would be placed among Open's runners
  const late = t.read('1K-A', 4, '10:05:04', { contest: 'Boys' });
  assert.deepEqual([late.raceId, late.raceName, late.status, late.detail], [null, 'Boys 5K', 'race-missing',
    "Its race 'Boys 5K' isn't in the settings (config.json was restored or edited). They come back if the race does."]);
  assert.deepEqual(t.engine.noRace().map((n) => [n.contest, n.status, n.count]), [['Boys', 'race-missing', 3]]);
  assert.deepEqual(places(t, 'O'), []);
  clock.advance(3000);
  assert.equal(t.sends.length, 0);
  t.engine.stop();
  t.engine.markCleanStop();
  // the right config.json put back: Boys 5K has every read back, the straggler too; it gets only what it is missing
  const u = setup({ store, clock, config: { ...s.config, races: [structuredClone(girls), structuredClone(open), structuredClone(boys)] } });
  assert.deepEqual(u.engine.missingRaces(), []);
  assert.deepEqual(places(u, 'B'), ['2:1', '3:2', '4:3']);
  clock.advance(3000);
  assert.deepEqual(u.sends.map((p) => [p.raceId, p.bib, p.place]), [['B', '4', 3]]);
  assert.ok(!store.journal.slice(lines).some((l) => ['delete', 'aside', 'unaside'].includes(JSON.parse(l).t)), 'no start journaled a delete or a set-aside');
});

test('R6: a race gone from the settings without a Delete is missing: its reads wait, its contests\' too; a Delete is what lets them go', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const s = setup({ races: [race({ id: 'b', name: 'Boys 5K', contests: ['Boys'], splits: sp }), race({ id: 'o', name: 'Open', contests: [], eventNumber: '9', splits: sp })] });
  const own = [1, 2].map((b) => s.read('1K-A', b, `10:05:0${b}`, { contest: 'Boys' }));
  s.read('1K-A', 7, '10:05:07', { contest: 'Masters' }); // Open's
  s.clock.advance(3000);
  // the race leaves the settings some other way than the Delete button (this is what a restart with an older
  // config.json does; configChanged without `deleted` behaves the same)
  const plan = s.engine.planChange({ ...s.config, races: [s.config.races[1]] });
  assert.deepEqual([plan.deleted, plan.setAside], [[], []]);
  assert.deepEqual(plan.moves, [{ contest: 'Boys', blank: false, count: 2, from: { raceId: 'b', raceName: 'Boys 5K', active: true },
    to: { raceId: null, status: 'race-missing', raceName: 'Boys 5K', waitsFor: 'b' } }]);
  assert.deepEqual(plan.newReads.map((n) => [n.contest, n.from.raceId, n.to.status]), [['Boys', 'b', 'race-missing']]);
  s.config.races = [s.config.races[1]];
  s.engine.configChanged();
  assert.ok(own.every((e) => e.status === 'race-missing' && e.raceId === null), own.map((e) => e.status).join());
  assert.equal(s.store.removed.length, 0, 'its race file is kept');
  assert.ok(!s.store.journal.some((l) => ['delete', 'aside'].includes(JSON.parse(l).t)));
  const late = s.read('1K-A', 3, '10:05:03', { contest: 'Boys' });
  assert.deepEqual([late.raceId, late.status], [null, 'race-missing'], 'not into Open');
  assert.deepEqual(s.engine.missingRaces().map((m) => [m.raceId, m.raceName, m.count]), [['b', 'Boys 5K', 2]]);
  // a race that lists the contest takes the stragglers; the missing race keeps its own reads (they wait for it)
  s.config.races.push(race({ id: 'b2', name: 'Boys again', contests: ['Boys'], eventNumber: '4', splits: sp }));
  s.engine.configChanged();
  assert.deepEqual([places(s, 'b2'), own.map((e) => e.status)], [['3:1'], ['race-missing', 'race-missing']]);
  s.config.races.pop();
  s.engine.configChanged({ deleted: ['b2'] });
  // the operator lets the missing race go: a Delete, like any other; its reads are out of use for good, and the
  // contest its stragglers waited for is set aside (they would otherwise flood Open)
  const del = s.engine.planChange(s.config, { deleted: ['b'] });
  assert.deepEqual(del.deleted.map((d) => [d.raceId, d.raceName, d.count]), [['b', 'Boys 5K', 2]]);
  s.engine.configChanged({ deleted: ['b'] });
  assert.ok(own.every((e) => e.status === 'race-deleted'));
  assert.equal(own[0].detail, "Its race 'Boys 5K' was deleted, so this read is not used.");
  assert.deepEqual(s.store.removed, ['b2', 'b'], 'its race file goes to races\\deleted like any deleted race');
  assert.deepEqual(s.engine.missingRaces(), []);
  assert.deepEqual(places(s, 'o'), ['7:1'], 'Open takes no Boys runner');
  assert.equal(s.read('1K-A', 5, '10:05:05', { contest: 'Boys' }).status, 'set-aside');
  assert.ok(s.store.journal.some((l) => JSON.parse(l).t === 'delete' && JSON.parse(l).raceId === 'b'));
});

test('R6: started without a race that is not Active: its own reads wait for it; reads that only waited for its listing go on', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  // JV went to Open (every contest) first; then JV 4K was made and switched off again (it keeps the two it got)
  const s = setup({ store, races: [race({ id: 'o', name: 'Open', contests: [], splits: sp })] });
  s.read('1K-A', 1, '10:05:01', { contest: 'JV' });
  s.config.races.push(race({ id: 'jv', name: 'JV 4K', contests: ['JV'], eventNumber: '4', splits: sp }));
  s.engine.configChanged();
  s.read('1K-A', 2, '10:05:02', { contest: 'JV' });
  s.config.races[1].contests = [];
  s.config.races[0].contests = ['Varsity'];
  s.config.races[1].contests = ['JV', 'Frosh'];
  s.engine.configChanged();
  s.config.races[1].active = false;
  s.config.races[0].contests = [];
  s.engine.configChanged();
  assert.deepEqual([places(s, 'jv').length, s.engine.setAside()], [2, []]);
  // JV waits for JV 4K (C1); a Frosh read comes to Open
  s.read('1K-A', 3, '10:05:03', { contest: 'Frosh' });
  assert.deepEqual(s.engine.noRace().map((n) => [n.contest, n.status]), [['Frosh', 'paused']]);
  s.engine.stop();
  s.engine.markCleanStop();
  // started without JV 4K: its two reads wait for it. JV has no other race: new JV reads wait too. Frosh had waited for
  // it as well: now Open takes it (it never had a race, and Open takes every contest), as a new Frosh read would.
  const t = setup({ store, config: { ...s.config, races: [s.config.races[0]] } });
  assert.deepEqual(t.engine.missingRaces().map((m) => [m.raceId, m.count]), [['jv', 2]]);
  assert.deepEqual(places(t, 'o'), ['3:1']);
  assert.deepEqual(t.read('1K-A', 4, '10:05:04', { contest: 'JV' }).status, 'race-missing');
  assert.equal(t.read('1K-A', 5, '10:05:05', { contest: 'Frosh' }).raceId, 'o');
});

test('R6: a missing race\'s contest goes with the race that takes every contest when that race has reads of it already', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  // the morning's Open took JV read 1 and Frosh read 3 and was switched off; the afternoon's Open took JV read 2
  const s = setup({ store, races: [race({ id: 'am', name: 'Open AM', contests: [], splits: sp })] });
  s.read('1K-A', 1, '10:05:01', { contest: 'JV' });
  s.read('1K-A', 3, '10:05:03', { contest: 'Frosh' });
  s.config.races[0].active = false;
  s.config.races.push(race({ id: 'pm', name: 'Open PM', contests: [], eventNumber: '9', splits: sp }));
  s.engine.configChanged();
  s.read('1K-A', 2, '10:05:02', { contest: 'JV' });
  s.engine.stop();
  s.engine.markCleanStop();
  // started without Open AM: its reads wait for it. JV's new reads go to Open PM, which has JV's other read: together.
  // Frosh has no read anywhere that counts: its new reads wait for Open AM instead of going into Open PM.
  const t = setup({ store, config: { ...s.config, races: [s.config.races[1]] } });
  assert.deepEqual(t.engine.missingRaces().map((m) => [m.raceId, m.count, m.contests.map((c) => c.contest)]), [['am', 2, ['Frosh', 'JV']]]);
  assert.equal(t.read('1K-A', 4, '10:05:04', { contest: 'JV' }).raceId, 'pm');
  assert.deepEqual(places(t, 'pm'), ['2:1', '4:2']);
  const f = t.read('1K-A', 5, '10:05:05', { contest: 'Frosh' });
  assert.deepEqual([f.raceId, f.status], [null, 'race-missing']);
  assert.deepEqual(t.engine.noRace().map((n) => [n.contest, n.status, n.count]), [['Frosh', 'race-missing', 2], ['JV', 'race-missing', 1]]);
});

test('R6: a held contest is never set aside: when the race taking every contest has reads of it but others would be let go, they all wait', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  // M (every contest) took JV read 1 and was switched off; T (every contest, not Active) has JV read 2 from earlier;
  // R lists JV and took read 3
  const s = setup({ store, races: [race({ id: 'M', name: 'Morning', contests: [], splits: sp })] });
  s.read('1K-A', 1, '10:05:01', { contest: 'JV' });
  s.config.races[0].active = false;
  s.config.races.push(race({ id: 'T', name: 'Afternoon', contests: [], eventNumber: '8', splits: sp }));
  s.engine.configChanged();
  s.read('1K-A', 2, '10:05:02', { contest: 'JV' });
  s.config.races[1].active = false;
  s.config.races.push(race({ id: 'R', name: 'JV 4K', contests: ['JV'], eventNumber: '9', splits: sp }));
  s.engine.configChanged();
  s.read('1K-A', 3, '10:05:03', { contest: 'JV' });
  assert.deepEqual([places(s, 'M'), places(s, 'T'), places(s, 'R')], [['1:1'], ['2:1'], ['3:1']]);
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  // started without M, with T switched on and R no longer listing JV (an older config.json): JV is held by M. T has a
  // JV read, but R's would be let go (R4f): instead of setting JV aside for good, they all wait for M
  const cfg = structuredClone(s.config);
  cfg.races = cfg.races.filter((r) => r.id !== 'M');
  cfg.races.find((r) => r.id === 'T').active = true;
  cfg.races.find((r) => r.id === 'R').contests = ['Varsity'];
  const t = setup({ store, config: cfg });
  assert.deepEqual(t.engine.setAside(), []);
  assert.deepEqual(t.engine.noRace().map((n) => [n.contest, n.status, n.count]), [['JV', 'race-missing', 3]]);
  assert.deepEqual([places(t, 'T'), places(t, 'R')], [[], []]);
  assert.ok(store.journal.slice(lines).every((l) => JSON.parse(l).t === 'route'), 'only moves journaled');
  assert.equal(t.read('1K-A', 4, '10:05:04', { contest: 'JV' }).status, 'race-missing');
  // M back in the settings: it has its read again, and the others are worked out again by R4: R no longer lists JV and
  // lets its read go (R4f), so JV is set aside now, with every read that waited (in memory: this is a start)
  t.engine.stop();
  t.engine.markCleanStop();
  const back = structuredClone(cfg);
  back.races.unshift(structuredClone(s.config.races[0]));
  const u = setup({ store, config: back });
  assert.deepEqual(places(u, 'M'), ['1:1']);
  assert.deepEqual(u.engine.setAside().map((a) => [a.contest, a.count]), [['JV', 3]]);
});

test('C2: a start that finds a set-aside contest listed uses it again in memory only; with the old settings back it is set aside as before', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  const s = setup({ store, races: [race({ id: 'g', name: 'Girls 5K', contests: ['Girls'], splits: sp }), race({ id: 'o', name: 'Open', contests: [], eventNumber: '7', splits: sp })] });
  s.read('1K-A', 1, '10:05:01', { contest: 'Girls' });
  deleteRaces(s, 'g');
  s.read('1K-A', 2, '10:05:02', { contest: 'Girls' });
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['Girls', "its race 'Girls 5K' was deleted", 1]]);
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  // an edited config.json lists Girls on a new race: the read is used there, but nothing about it is journaled
  const edited = { ...structuredClone(s.config), races: [...structuredClone(s.config.races), race({ id: 'g2', name: 'Girls again', contests: ['Girls'], eventNumber: '8', splits: sp })] };
  const t = setup({ store, config: edited });
  assert.deepEqual([t.engine.setAside(), places(t, 'g2')], [[], ['2:1']]);
  assert.deepEqual(store.journal.slice(lines).map((l) => JSON.parse(l).t), ['route'], 'a move, but no "unaside"');
  t.engine.setGun('o', '10:00:01.000'); // a change while running that has nothing to do with it
  assert.ok(!store.journal.slice(lines).some((l) => JSON.parse(l).t === 'unaside'), "still no unaside: the listing is the start's");
  t.engine.stop();
  t.engine.markCleanStop();
  // the settings as they were: the contest is set aside again, for the reason it had (an "unaside" journaled at that
  // start would have ended that); the read that went to the new race waits for it, as a missing race (R6)
  const u = setup({ store, config: structuredClone(s.config) });
  assert.deepEqual(u.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['Girls', "its race 'Girls 5K' was deleted", 0]]);
  assert.deepEqual(u.engine.missingRaces().map((m) => [m.raceId, m.raceName, m.count]), [['g2', 'Girls again', 1]]);
  assert.equal(u.read('1K-A', 3, '10:05:03', { contest: 'Girls' }).status, 'set-aside');
  assert.deepEqual(places(u, 'o'), []);
});

test('R6: reads that came from a missing race wait for it too, instead of being set aside, and go back to it when it is back', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  // Open (every contest) took X read 1 and Y read 2; then the X race listed X and took read 1 from it
  const s = setup({ store, races: [race({ id: 'open', name: 'Open', contests: [], splits: sp })] });
  const r1 = s.read('1K-A', 1, '10:05:01', { contest: 'X' });
  s.read('1K-A', 2, '10:05:02', { contest: 'Y' });
  s.config.races.push(race({ id: 'x', name: 'X race', contests: ['X'], eventNumber: '5', splits: sp }));
  s.engine.configChanged();
  assert.equal(r1.raceId, 'x');
  s.engine.stop();
  s.engine.markCleanStop();
  // an older config.json: no Open, and the X race does not list X. Read 1 would be let go (its home, Open, is gone),
  // which would set X aside; it waits for Open instead, because it came from it
  const older = structuredClone(s.config);
  older.races = [{ ...older.races[1], contests: ['Z'] }];
  const t = setup({ store, config: older });
  assert.deepEqual(t.engine.setAside(), []);
  assert.deepEqual(t.engine.noRace().map((n) => [n.contest, n.status, n.count, n.raceId]), [['X', 'race-missing', 1, 'open'], ['Y', 'race-missing', 1, 'open']]);
  assert.equal(t.read('1K-A', 3, '10:05:03', { contest: 'X' }).status, 'race-missing');
  t.engine.stop();
  t.engine.markCleanStop();
  // Open back (and the X race as it is now): read 1 goes back to Open, where it came from (R4d), the new one with it
  const u = setup({ store, config: { ...older, races: [structuredClone(s.config.races[0]), older.races[0]] } });
  assert.deepEqual(places(u, 'open'), ['1:1', '2:2', '3:3']);
  assert.deepEqual([u.engine.setAside(), u.engine.missingRaces()], [[], []]);
});

test('C2: a set-aside a start works out is never journaled; a later change that ends its cause ends it, and a restart agrees', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const store = memStore();
  const s = setup({ store, races: [race({ id: 'r', name: 'Relay', contests: ['X'], splits: sp }), race({ id: 'o', name: 'Other', contests: ['Y'], eventNumber: '6', splits: sp })] });
  s.read('1K-A', 1, '10:05:01', { contest: 'X' });
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  // an older config.json: Relay listed Z, not X. Its X read is let go (R4f): set aside, in memory only
  const older = structuredClone(s.config);
  older.races[0].contests = ['Z'];
  const t = setup({ store, config: older });
  assert.deepEqual(t.engine.setAside().map((a) => [a.contest, a.reason, a.count]), [['X', "'Relay' no longer lists it", 1]]);
  const late = t.read('1K-A', 2, '10:05:02', { contest: 'X' });
  assert.equal(late.status, 'set-aside');
  const recs = store.journal.slice(lines).map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((r) => r.t), ['route', 'read']);
  assert.equal(recs[1].aside, 0, 'the read is journaled as not having come while its contest was set aside for good');
  t.engine.setGun('o', '10:00:01.000'); // a change while running that has nothing to do with it
  assert.deepEqual(t.engine.setAside().map((a) => a.contest), ['X']);
  assert.ok(!store.journal.some((l) => JSON.parse(l).t === 'aside'), "still not journaled: it is the start's, worked out again");
  // a change while running that ends its cause: Relay now takes every contest, so its read comes back (R4d), and
  // the new one goes there too (R4e); nothing about the set-aside was ever journaled
  t.config.races[0].contests = [];
  t.engine.configChanged();
  assert.deepEqual([t.engine.setAside(), places(t, 'r')], [[], ['1:1', '2:2']]);
  assert.ok(!store.journal.some((l) => ['aside', 'unaside'].includes(JSON.parse(l).t)));
  const live = [places(t, 'r'), t.engine.setAside(), t.engine.noRace()];
  t.engine.stop();
  t.engine.markCleanStop();
  const n = store.journal.length;
  const u = setup({ store, config: t.config });
  assert.deepEqual([places(u, 'r'), u.engine.setAside(), u.engine.noRace()], live, 'a restart with the same settings gives the same');
  assert.equal(store.journal.length, n);
});

test('C2: a read journals whether it came while its contest was set aside, so the replay gives it the same home', () => {
  // a journal as revision 6 writes it: JV set aside, then a read of JV that waited for a race that is not Active while a
  // start had found JV listed (so it was not set aside for it: aside 0), then JV used again
  const store = memStore();
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const rec = (seq, bib, raceId, aside) => store.appendJournal({ t: 'read', seq, at: T0, conn: 1, location: '1K-A', bib: String(bib),
    tod: parseTod('10:05:00') + bib * S, contest: 'JV', first: '', last: '', team: '', gender: '', raceId, ...(aside === undefined ? {} : { aside }) });
  rec(1, 1, 'g', undefined);
  store.appendJournal({ t: 'delete', raceId: 'g', raceName: 'Girls', seq: 1, at: T0 });
  store.appendJournal({ t: 'aside', contest: 'JV', kind: 'deleted', raceId: 'g', raceName: 'Girls', reason: "its race 'Girls' was deleted", at: T0 });
  rec(2, 2, null, 0);
  rec(3, 3, null, 1);
  store.appendJournal({ t: 'unaside', contest: 'JV', at: T0 });
  // now Open takes every contest: read 2 never had a race and goes there (R4e); read 3 came while JV was set aside
  // ("aside" home), so it is let go: JV is set aside again (in memory: this is a start), read 2 with it
  const s = setup({ store, races: [race({ id: 'o', name: 'Open', contests: [], splits: sp })] });
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.count]), [['JV', 2]]);
  // without read 3, read 2 goes to Open
  const store2 = memStore();
  for (const l of store.journal) if (JSON.parse(l).seq !== 3 || JSON.parse(l).t !== 'read') store2.journal.push(l);
  const t = setup({ store: store2, races: [race({ id: 'o', name: 'Open', contests: [], splits: sp })] });
  assert.deepEqual([t.engine.setAside(), places(t, 'o')], [[], ['2:1']]);
});

// ---- Revision 7 (DESIGN 9.15): FinishLynx LapTime lines, input ports, pass counting, laps-to-go safety ------------------

/** N splits with no timing points: the race counts passes (9.15 L4). `earliest`: one text per split ('' = none). */
const lapSplits = (n, earliest = []) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: `Split ${i + 1}`, sources: [], earliest: earliest[i] ?? '' }));
/** A race that takes the LapTime reads of an RR12 input port. */
const lapRace = (over = {}) => race({ contests: [], inputPort: 5565, splits: lapSplits(3), finishSources: [], ...over });

/** A FinishLynx LapTime read as main.js hands it over: a bib and a time of day, from a port (event: '3-1-1' or ''). */
function lap(s, bib, tod, { port = 5565, event = '' } = {}) {
  return s.engine.handleRead({ location: '', bib: String(bib), tod: parseTod(tod), contest: '', first: '', last: '', team: '', gender: '', event },
    { receivedAt: s.clock.now(), raw: `\\x01S,${tod},${bib}`, connId: 1, port });
}

/** Race time "m:ss.s" after a 10:00:00 gun -> time of day text. */
const after = (raceTime) => formatTod(parseTod('10:00:00') + parseRaceTime(raceTime), 4);

/**
 * Every packet must be one TrackScore and Karmarush can file: 1 <= laps to go <= the race's splits (as the settings
 * have them when it goes out), laps to go = N - split index, no finish time, and XCScore.lss renders "T":"" (9.15 L6).
 */
function assertSendable(p, config) {
  const n = config.races.find((r) => r.id === p.raceId).splits.length;
  assert.ok(Number.isInteger(p.lapsToGo) && p.lapsToGo >= 1 && p.lapsToGo <= n, `L2G ${p.lapsToGo} of ${n} (bib ${p.bib})`);
  assert.equal(p.splitCount, n);
  assert.equal(p.lapsToGo, n - p.splitIndex);
  const vars = packetVariables(p, {});
  assert.equal(packetProblem(p, vars), null);
  const out = renderUpdate(XCSCORE, { stage: 'results', header: vars.header, rows: vars.rows });
  const d = JSON.parse(out.text).D;
  assert.equal(d.T, '', 'no finish time: a split must never make a runner a finisher');
  assert.ok(Number(d.L2G) >= 1 && Number(d.L2G) <= n && String(Number(d.L2G)) === d.L2G, `rendered L2G ${d.L2G}`);
}

test('routing keys (9.15 L3): a LapTime read goes by its contest, else its event, else its port; a race lists its port and event', () => {
  assert.deepEqual(routeKeyInfo(portKey(5565)), { via: 'port', port: 5565, event: null, label: 'Port 5565' });
  assert.deepEqual(routeKeyInfo(eventRouteKey('3-1-1')), { via: 'event', port: null, event: '3-1-1', label: 'Event 3-1-1' });
  assert.deepEqual(routeKeyInfo('girls'), { via: 'contest', port: null, event: null, label: '' });
  const s = setup({ races: [
    lapRace({ id: 'g', name: 'Girls 5K', eventNumber: '1', inputPort: 5565 }),
    lapRace({ id: 'b', name: 'Boys 5K', eventNumber: '2', inputPort: 5566 }),
    lapRace({ id: 'o', name: 'Open', eventNumber: '9', inputPort: null }), // no contest, no port: takes every contest
  ] });
  assert.equal(lap(s, 1, '10:03:00', { port: 5565 }).raceId, 'g');
  assert.equal(lap(s, 2, '10:03:00', { port: 5566 }).raceId, 'b');
  assert.equal(lap(s, 3, '10:03:00', { port: 5566, event: '1-1-1' }).raceId, 'g', "FinishLynx's event beats the port");
  assert.equal(lap(s, 4, '10:03:00', { port: 5567 }).raceId, 'o', 'a port no race takes: the race that takes every contest');
  const sr = s.engine.handleRead({ location: '', bib: '5', tod: parseTod('10:03:00'), contest: 'Masters' }, { port: 5565 });
  assert.equal(sr.raceId, 'o', 'a line with a contest goes by its contest, whatever port it came on');
  // without a race that takes every contest, a port no race takes is in no race, and says what to do
  const lone = setup({ races: [lapRace({ id: 'g', name: 'Girls 5K', eventNumber: '1' })] });
  const none = lap(lone, 6, '10:03:00', { port: 5567 });
  assert.deepEqual([none.raceId, none.status], [null, 'no-race']);
  assert.equal(none.detail, 'No active race takes the reads from port 5567. Choose port 5567 on the race (Races tab), and tick Active.');
  assert.deepEqual(lone.engine.noRace().map((n) => [n.contest, n.via, n.port, n.status, n.count]), [['Port 5567', 'port', 5567, 'no-race', 1]],
    'the panel names it "Port 5567"');
  // a race that is not Active and takes the port: its reads wait for it (R1), as for a contest
  s.config.races[1].active = false;
  s.engine.configChanged();
  const waits = lap(s, 7, '10:04:00', { port: 5566 });
  assert.equal(lap(s, 8, '10:04:00', { port: 5566 }).raceName, 'Boys 5K');
  assert.deepEqual([waits.raceId, waits.status, waits.raceName], [null, 'paused', 'Boys 5K']);
  assert.equal(waits.detail, "Its race 'Boys 5K' is not Active. These reads are used when you tick Active.");
  // the port and event are journaled with the read, so a restart routes exactly the same
  const recs = s.store.journal.map((l) => JSON.parse(l)).filter((r) => r.t === 'read');
  assert.deepEqual(recs.slice(0, 3).map((r) => [r.port, r.event]), [[5565, undefined], [5566, undefined], [5566, '1-1-1']]);
  const t = restartOf(s);
  assert.deepEqual([places(t, 'g'), places(t, 'b'), t.engine.noRace().map((n) => [n.contest, n.status, n.count])],
    [places(s, 'g'), places(s, 'b'), s.engine.noRace().map((n) => [n.contest, n.status, n.count])]);
  assert.deepEqual(t.engine.seen().contests.map((c) => c.name), ['Masters'], 'ports and events are not offered as contests');
});

test('pass counting (9.15 L4): the A and B mats are one pass, passes fill the splits in time order, never laps to go 0', () => {
  const s = setup({ races: [lapRace({ id: 'r', name: 'Girls 5K' })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // bib 1: A and B mat of each split, B first sometimes (reads arrive out of order)
  const a1 = lap(s, 1, after('3:00.400'));
  const b1 = lap(s, 1, after('3:00.100'));
  lap(s, 1, after('6:10.000'));
  lap(s, 1, after('6:10.300'));
  lap(s, 1, after('9:20.000'));
  const extra = lap(s, 1, after('12:00.000'));
  s.clock.advance(3000);
  assert.deepEqual(s.engine.crossings('r').map((c) => [c.bib, c.splitName, c.raceTicks, c.reads]),
    [['1', 'Split 1', rt('3:00.1'), 2], ['1', 'Split 2', rt('6:10'), 2], ['1', 'Split 3', rt('9:20'), 1]]);
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.lapsToGo, p.csTicks]),
    [['Split 1', 3, rt('3:00.1')], ['Split 2', 2, rt('6:10')], ['Split 3', 1, rt('9:20')]]);
  const row = (e) => entryOf(s, e);
  assert.deepEqual([row(b1).status, row(b1).splitName, row(a1).status], ['sent', 'Split 1', 'backup']);
  assert.deepEqual([row(extra).status, row(extra).splitName], ['extra', '']);
  assert.match(row(extra).detail, /^More passes than this race has splits — ignored \(Girls 5K has 3 splits/);
  const v = s.engine.raceView('r');
  assert.deepEqual([v.extra, v.tooEarly, v.passes, v.unmapped], [1, 0, 6, []], 'passes are not "unmapped"');
  // the start area and the time before the gun count no pass, so they shift nothing
  lap(s, 2, after('0:20'));
  lap(s, 2, '09:59:50');
  lap(s, 2, after('3:05'));
  s.clock.advance(3000);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '2').map((c) => c.splitName), ['Split 1']);
  // a pass that arrives late, after the runner's next one: the splits are counted again and corrected. A 6:30 first
  // pass looks like Split 2 next to the field's (9.17 P2), so it is held, not sent as Split 1, until the 3:10 comes.
  const late = lap(s, 3, after('6:30'));
  s.clock.advance(3000);
  assert.deepEqual(s.sends.filter((p) => p.bib === '3'), []);
  assert.deepEqual([entryOf(s, late).status, entryOf(s, late).detail], ['check-column', `Looks like Split 2, not Split 1 (missed Split 1?) — check it in Review. ${LONE_TEXT}`]);
  lap(s, 3, after('3:10'));
  s.clock.advance(3000);
  // (the 6:30 waited long enough already; the 3:10 waits out its own hold for a backup read. 9.23 F13: then Split 2,
  // the runner's furthest split, goes again last, so TrackScore shows the runner's Split 2 place)
  assert.deepEqual(s.sends.filter((p) => p.bib === '3').map((p) => [p.splitName, p.lapsToGo, p.csTicks, p.reason]),
    [['Split 2', 2, rt('6:30'), 'new'], ['Split 1', 3, rt('3:10'), 'new'], ['Split 2', 2, rt('6:30'), 'place-update']]);
  assert.equal(entryOf(s, late).status, 'sent');
});

test("a split's earliest time (9.15 L4): a missed mat does not shift the later splits; a pass before split j's earliest is too early", () => {
  const s = setup({ races: [lapRace({ id: 'r', name: 'Boys 5K', splits: lapSplits(3, ['', '5:00', '9:00']) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // bib 1 missed split 1: its first pass at 6:20 is past split 2's earliest, so it is split 2, not split 1
  lap(s, 1, after('6:20'));
  lap(s, 1, after('9:40'));
  // bib 2 missed split 2: 3:00 is split 1, 9:30 is past split 3's earliest
  lap(s, 2, after('3:00'));
  lap(s, 2, after('9:30'));
  s.clock.advance(3000);
  const at = (bib) => s.engine.crossings('r').filter((c) => c.bib === String(bib)).map((c) => c.splitName);
  assert.deepEqual([at(1), at(2)], [['Split 2', 'Split 3'], ['Split 1', 'Split 3']]);
  assert.deepEqual(s.sends.filter((p) => p.bib === '1').map((p) => p.lapsToGo), [2, 1]);
  // split 1 with an earliest of 2:00: a pass at 1:30 (after the start area) is too early, the next one is split 1
  s.config.races[0].splits[0].earliest = '2:00';
  s.engine.configChanged();
  const early = lap(s, 3, after('1:30'));
  lap(s, 3, after('3:20'));
  s.clock.advance(3000);
  assert.deepEqual(at(3), ['Split 1']);
  const e = entryOf(s, early);
  assert.deepEqual([e.status, e.splitName], ['too-early', 'Split 1']);
  assert.match(e.detail, /^Earlier than the earliest time of Split 1 \(2:00\), so it can't be the Split 1 pass — ignored\./);
  assert.equal(s.engine.raceView('r').tooEarly, 1);
  // without earliest times the same passes fill the splits in order (the missed mat shifts them): a setting counts for
  // the reads already received too
  for (const sp of s.config.races[0].splits) sp.earliest = '';
  s.engine.configChanged();
  assert.deepEqual([at(1), at(2), at(3)], [['Split 1', 'Split 2'], ['Split 1', 'Split 2'], ['Split 1', 'Split 2']]);
});

test('passes after the finish (FinishLynx finishers) are dropped and never sent; a finished runner gets no live split', () => {
  const lynx = new Map();
  const s = setup({ races: [lapRace({ id: 'r', splits: lapSplits(2) })], finishers: () => lynx });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  lap(s, 1, after('3:00'));
  s.clock.advance(3000);
  lynx.set('1', rt('8:00'));
  s.engine.converge();
  const late = lap(s, 1, after('8:30')); // walking back over a mat
  s.clock.advance(3000);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.splitName]), [['1', 'Split 1']]);
  assert.equal(entryOf(s, late).status, 'after-finish');
  assert.deepEqual(s.engine.raceData('r').runners.get('1').splits, [rt('3:00'), null]);
});

test('changing the number of splits (9.15 L5, L6): fresh splits are re-sent with the new laps to go; older ones are stale, with the reason', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: lapSplits(2) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  lap(s, 1, after('3:00'));
  lap(s, 1, after('6:00'));
  s.clock.advance(3000);
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.lapsToGo, p.splitCount]), [['Split 1', 2, 2], ['Split 2', 1, 2]]);
  // within the minute: corrected by themselves, in the columns of 3 splits
  s.config.races[0].splits = lapSplits(3);
  s.engine.configChanged();
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(2).map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.reason]),
    [['Split 1', 3, 3, 'correction'], ['Split 2', 2, 3, 'correction']]);
  assert.equal(s.engine.raceView('r').stale.count, 0);
  // later: what went out is in the wrong columns and only a resend fixes it; the prompt says why
  s.clock.advance(61_000);
  s.config.races[0].splits = lapSplits(4);
  s.engine.configChanged();
  const v = s.engine.raceView('r');
  assert.deepEqual([v.stale.count, v.stale.reason, v.stale.splitCountFrom, v.resendSuggested], [2, 'split-count', 3, true]);
  assert.equal(v.stale.hint, 'TrackScore and Karmarush put splits in columns by laps to go; this race now has 4 splits instead of 3, ' +
    "so the splits already sent are in the wrong columns. Resend this race's splits. Resend corrects every split Split Relay has. " +
    'A runner who has no split in a column under the new setting may still show an old time there in TrackScore and the live ' +
    'results until the race is cleared there.');
  assert.equal(s.engine.resendRace('r').sent, 2);
  assert.deepEqual(s.sends.slice(-2).map((p) => [p.lapsToGo, p.splitCount]), [[4, 4], [3, 4]]);
  assert.deepEqual(s.engine.raceView('r').stale, { count: 0, byOutput: [], reason: null, splitCountFrom: null, hint: null });
  // the same number of splits in another order: also the wrong columns
  s.clock.advance(61_000);
  const sp = s.config.races[0].splits;
  s.config.races[0].splits = [sp[1], sp[0], sp[2], sp[3]];
  s.engine.configChanged();
  assert.equal(s.engine.raceView('r').stale.reason, 'order');
  assert.match(s.engine.raceView('r').stale.hint, /put in another order after they were sent/);
});

test('a split added before the others (9.15 L6): the laps to go of a sent split stay the same, but its column moved; the split count says so', () => {
  // timing points: the 1K crossing keeps its split id when "500m" is put before it. Its laps to go stay 2 (2 - 0, then
  // 3 - 1), but TrackScore's column is "split count - laps to go": 0 before, 1 now.
  const s = setup({ races: [race({ splits: [{ id: 's1', name: '1K', sources: ['1K-A'] }, { id: 's2', name: '2K', sources: ['2K-A'] }] })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  s.read('1K-A', 1, '10:03:00');
  s.clock.advance(3000);
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.lapsToGo, p.splitCount]), [['1K', 2, 2]]);
  s.config.races[0].splits.unshift({ id: 's0', name: '500m', sources: ['500-A'] });
  s.engine.configChanged();
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(1).map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.reason]), [['1K', 2, 3, 'correction']],
    'within the minute it goes again, for the column of 3 splits');
  s.clock.advance(61_000);
  s.config.races[0].splits.unshift({ id: 's00', name: '200m', sources: ['200-A'] });
  s.engine.configChanged();
  const v = s.engine.raceView('r1');
  assert.deepEqual([v.stale.count, v.stale.reason, v.stale.splitCountFrom], [1, 'split-count', 3]);
});

test('the ledger of a race file from before revision 7 (no split count) counts as sent with the splits the race has', () => {
  const store = memStore();
  store.data.set('r', JSON.stringify({ version: 2, clearedSeq: 0, ledgers: { o1: [['1|s1', parseTod('10:03:00'), 1, parseTod('10:00:00'), 2, T0, T0, null]] } }));
  store.appendJournal({ t: 'read', seq: 1, at: T0, conn: 1, location: '', bib: '1', tod: parseTod('10:03:00'), contest: '', first: '', last: '',
    team: '', gender: '', raceId: 'r', port: 5565 });
  store.appendJournal({ t: 'stop', at: T0 }); // a clean stop: nothing is sent again for safety
  const s = setup({ store, races: [lapRace({ id: 'r', splits: lapSplits(2) })] });
  s.clock.advance(70_000);
  assert.deepEqual([s.sends.length, s.engine.raceView('r').stale.count], [0, 0], 'nothing re-sent, nothing stale after the upgrade');
});

test('randomized (9.15 L6): over random passes, earliest times and split counts, every packet has 1 <= laps to go <= N and no finish time', () => {
  for (const seed of [3, 11, 58, 404, 2027, 8080]) {
    const rand = rng(seed);
    const lynx = new Map();
    const n0 = 1 + Math.floor(rand() * 5);
    const earliest = (n) => Array.from({ length: n }, (_, i) => (rand() < 0.4 ? `${Math.floor(((i + 1) * 180 + rand() * 60 - 90) / 60)}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` : ''));
    const sortedEarliest = (n) => {
      // earliest times go up in course order (config validation refuses anything else)
      const e = earliest(n);
      let prev = -1;
      return e.map((t) => {
        if (!t) return '';
        const v = parseRaceTime(t);
        if (v < prev) return '';
        prev = v;
        return t;
      });
    };
    const s = setup({ races: [lapRace({ id: 'r', splits: lapSplits(n0, sortedEarliest(n0)) }), lapRace({ id: 'q', name: 'Boys', eventNumber: '7', inputPort: 5566, splits: lapSplits(2) })],
      finishers: () => lynx, filter: { tagWindowSec: [5, 10, 20][Math.floor(rand() * 3)], holdSec: rand() < 0.5 ? 0 : 2 } });
    let packets = 0;
    s.engine.on('send', (p) => {
      packets++;
      assertSendable(p, s.config);
    });
    const reads = [];
    for (let bib = 1; bib <= 50; bib++) {
      const pace = 150 + rand() * 120;
      const passes = 1 + Math.floor(rand() * 7); // fewer than the splits, or more (extra passes)
      for (let k = 1; k <= passes; k++) {
        const t = pace * k + rand() * 3;
        if (rand() > 0.15) reads.push([bib, t, 5565]); // A mat (or missed)
        if (rand() > 0.3) reads.push([bib, t + rand() * 1.5, 5565]); // B mat
      }
      if (rand() < 0.3) reads.push([bib, rand() * 70, 5565]); // the start area
      if (rand() < 0.2) reads.push([bib, 100 + rand() * 800, 5566]); // the other race's port
    }
    const arrivals = reads.map((r) => ({ r, at: r[1] + 1.5 + rand() * 3 + (rand() < 0.1 ? rand() * 400 : 0) })).sort((a, b) => a.at - b.at);
    for (const [i, { r: [bib, t, port] }] of arrivals.entries()) {
      lap(s, bib, formatTod(parseTod('10:00:00') + Math.round(t * S), 4), { port });
      s.clock.advance(Math.floor(rand() * 700));
      if (rand() < 0.01) {
        lynx.set(String(1 + Math.floor(rand() * 50)), Math.round((400 + rand() * 900) * S));
        s.engine.converge();
      }
      if (i % 97 === 50) {
        // the operator changes the number of splits mid-race (and their earliest times)
        const n = 1 + Math.floor(rand() * 5);
        s.config.races[0].splits = lapSplits(n, sortedEarliest(n));
        s.engine.configChanged();
      }
      if (i % 151 === 100) s.engine.resendRace('r', { includeFinished: rand() < 0.5 });
    }
    s.clock.advance(70_000);
    assert.ok(packets > 50, `seed ${seed}: ${packets} packets`);
    for (const c of s.engine.crossings('r')) assert.ok(c.place >= 1);
  }
});

test('the read-by-read derivation equals a rebuild from scratch with LapTime passes, earliest times and timing points mixed (DESIGN 9.3, 9.15)', () => {
  for (const seed of [5, 17, 123, 777, 4242, 90210]) {
    const rand = rng(seed);
    const lynx = new Map();
    const splits = [
      { id: 's1', name: '1K', sources: ['1K-A'], earliest: '' },
      { id: 's2', name: '2K', sources: [], earliest: rand() < 0.5 ? '5:00' : '' },
      { id: 's3', name: '3K', sources: [], earliest: rand() < 0.5 ? '8:30' : '' },
      { id: 's4', name: '4K', sources: ['4K-A'], earliest: '' },
    ];
    const s = setup({ races: [lapRace({ id: 'r1', splits, finishSources: ['Finish'] })], finishers: () => lynx });
    const reads = [];
    for (let bib = 1; bib <= 40; bib++) {
      const pace = 160 + rand() * 90;
      for (let k = 1; k <= 5; k++) {
        const t = pace * k + rand() * 4;
        if (rand() > 0.2) reads.push(['', bib, t]); // a pass
        if (rand() > 0.4) reads.push(['', bib, t + rand() * 1.2]); // the other mat
        if (k === 1 && rand() < 0.5) reads.push(['1K-A', bib, t + rand()]); // a named timing point too
        if (k === 4 && rand() < 0.5) reads.push(['4K-A', bib, t + rand()]);
      }
      if (rand() > 0.3) reads.push(['Finish', bib, pace * 4.6 + rand() * 5]);
      if (rand() < 0.3) reads.push(['', bib, rand() * 70]); // the start area
      if (rand() < 0.1) reads.push(['', bib, -rand() * 60]); // before the gun
      if (rand() < 0.15) reads.push(['', bib, 30 + rand() * 120]); // too early, or a first pass
    }
    const arrivals = reads.map((r) => ({ r, at: r[2] + 1.5 + rand() * 3 + (rand() < 0.1 ? rand() * 600 : 0) })).sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < arrivals.length) {
      const n = rand() < 0.7 ? 1 : 1 + Math.floor(rand() * 30);
      s.engine.handleReads(arrivals.slice(i, i + n).map(({ r: [loc, bib, t] }) => ({
        read: { location: loc, bib: String(bib), tod: parseTod('10:00:00') + Math.round(t * S), contest: '', first: '', last: '', team: '', gender: '' },
        meta: { connId: 1, port: 5565 },
      })));
      i += n;
      s.clock.advance(Math.floor(rand() * 900));
      if (rand() < 0.02) {
        lynx.set(String(1 + Math.floor(rand() * 40)), Math.round((700 + rand() * 500) * S));
        s.engine.converge();
      }
    }
    s.clock.advance(70_000);
    const snap = () => ({
      crossings: s.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.tod, c.raceTicks, c.place, c.reads, c.reason]),
      view: s.engine.raceView('r1'),
      data: [...s.engine.raceData('r1').runners].map(([bib, r]) => [bib, r.splits]),
      feed: s.engine.feed(1000).map((e) => [e.id, e.status, e.detail, e.raceTicks, e.splitName, e.place]),
    });
    const incremental = snap();
    const packets = s.sends.length;
    s.config.races[0].splits[0].sources.push(`Never-${seed}`);
    s.engine.configChanged();
    s.config.races[0].splits[0].sources.pop();
    s.engine.configChanged();
    const rebuilt = snap();
    assert.deepEqual(rebuilt.crossings, incremental.crossings, `crossings, seed ${seed}`);
    assert.deepEqual(rebuilt.data, incremental.data, `raceData, seed ${seed}`);
    assert.deepEqual(rebuilt.view, incremental.view, `raceView, seed ${seed}`);
    assert.deepEqual(rebuilt.feed, incremental.feed, `feed rows, seed ${seed}`);
    assert.equal(s.sends.length, packets, `the rebuild found nothing to send, seed ${seed}`);
    const kinds = new Set(incremental.feed.map((f) => f[1]));
    for (const k of ['sent', 'backup', 'start-area', 'extra']) assert.ok(kinds.has(k), `${k} in seed ${seed}`);
    // ...and a restart from the journal (with the same FinishLynx finishers) gives the same again
    s.engine.stop();
    s.engine.markCleanStop();
    const t = setup({ store: s.store, config: s.config, clock: s.clock, finishers: () => lynx });
    assert.deepEqual(t.engine.crossings('r1').map((c) => [c.bib, c.splitId, c.tod, c.place]), incremental.crossings.map((c) => [c[0], c[1], c[2], c[4]]), `restart, seed ${seed}`);
  }
});

test('V3: State.noRace counts per missing race, so two missing races with reads of one contest each have their own count', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const A = race({ id: 'A', name: 'Girls 5K', contests: ['Girls'], eventNumber: '1', splits: sp });
  const C = race({ id: 'C', name: 'Open', contests: [], eventNumber: '3', splits: sp });
  const s = setup({ races: [C, A] });
  for (const b of [1, 2, 3]) s.read('1K-A', b, `10:03:0${b}`, { contest: 'Girls' });
  s.config.races[1].active = false;
  s.engine.configChanged();
  s.config.races.push(race({ id: 'B', name: 'Girls 5K (copy)', contests: ['Girls'], eventNumber: '2', splits: sp }));
  s.engine.configChanged();
  s.read('1K-A', 4, '10:03:04', { contest: 'Girls' });
  s.engine.stop();
  s.engine.markCleanStop();
  // config.json put back from a copy that has only Open: both Girls races are missing
  const t = setup({ store: s.store, config: { ...s.config, races: [C] }, clock: s.clock });
  t.read('1K-A', 5, '10:03:05', { contest: 'Girls' });
  assert.deepEqual(t.engine.missingRaces().map((m) => [m.raceId, m.count]), [['A', 3], ['B', 1]]);
  assert.deepEqual(t.engine.noRace().map((n) => [n.contest, n.status, n.raceId, n.count]),
    [['Girls', 'race-missing', 'A', 4], ['Girls', 'race-missing', 'B', 1]], "the new read waits for the first race that holds Girls");
});

test('V5: a race deleted earlier and back in the settings is reported; its old reads stay out of use; saving it keeps it', () => {
  const sp = [{ id: 's1', name: '1K', sources: ['1K-A'] }];
  const G = race({ id: 'g', name: 'Girls 5K', contests: ['Girls'], splits: sp });
  const s = setup({ races: [G] });
  s.read('1K-A', 1, '10:03:01', { contest: 'Girls' });
  s.clock.advance(3000);
  deleteRaces(s, 'g');
  assert.deepEqual(s.engine.deletedBack(), [], 'a deleted race that is gone is nothing to warn about');
  s.engine.stop();
  s.engine.markCleanStop();
  // the old config.json comes back from its backup with Girls 5K in it
  const t = setup({ store: s.store, config: { ...s.config, races: [G] }, clock: s.clock });
  const back = t.engine.deletedBack();
  assert.deepEqual(back.map((d) => [d.raceId, d.raceName, d.deletedName, d.count]), [['g', 'Girls 5K', 'Girls 5K', 1]]);
  assert.equal(back[0].deletedAt, T0 + 3000);
  assert.deepEqual(places(t, 'g'), [], 'its reads from before the delete stay out of use');
  t.read('1K-A', 2, '10:03:02', { contest: 'Girls' });
  assert.deepEqual(places(t, 'g'), ['2:1'], 'new reads count in it');
  assert.equal(t.engine.keepRace('g'), true);
  assert.equal(t.engine.keepRace('g'), false, 'once');
  assert.deepEqual(t.engine.deletedBack(), []);
  const u = restartOf(t);
  assert.deepEqual([u.engine.deletedBack(), places(u, 'g')], [[], ['2:1']], 'kept for good: the journal says so');
});

test('set-aside reads of a port say what to choose, and the set-aside replays by its key', () => {
  const s = setup({ races: [lapRace({ id: 'g', name: 'Girls 5K', splits: lapSplits(2) })] });
  lap(s, 1, after('3:00'));
  deleteRaces(s, 'g');
  const late = lap(s, 2, after('3:10'));
  assert.equal(late.status, 'set-aside');
  assert.equal(late.detail, "Reads from port 5565 are not used: its race 'Girls 5K' was deleted. Choose port 5565 on an Active race to use them.");
  assert.deepEqual(s.engine.setAside().map((a) => [a.contest, a.via, a.port, a.count]), [['Port 5565', 'port', 5565, 1]]);
  assert.equal(asideText({ contest: 'Event 3-1-1', reason: 'x', key: eventRouteKey('3-1-1') }),
    'Reads for event 3-1-1 are not used: x. Give an Active race event 3-1-1 to use them.');
  const t = restartOf(s);
  assert.deepEqual(t.engine.setAside().map((a) => [a.contest, a.count]), [['Port 5565', 1]]);
  // a race that takes the port uses them again
  t.config.races.push(lapRace({ id: 'g2', name: 'Girls again', eventNumber: '8', splits: lapSplits(2) }));
  t.engine.configChanged();
  assert.deepEqual([t.engine.setAside(), places(t, 'g2')], [[], ['2:1']]);
});

test('randomized (9.15 L3): LapTime reads by port, event and contest under random race edits keep one place per key, and a restart agrees', () => {
  const PORTS = [5565, 5566, 5567];
  for (let seed = 1; seed <= 100; seed++) {
    const rand = rng(seed * 7919);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    let config = normalizeConfig({ input: { ports: PORTS }, filter: { tagWindowSec: 10, holdSec: 0 }, races: [], outputs: [] }).config;
    const holder = { cfg: config };
    const store = memStore();
    const clock = fakeClock();
    const engine = new Engine({ getConfig: () => holder.cfg, store, clock, autoStart: false });
    /** bib -> the read's routing key, as the rules see it */
    const keyOf = new Map();
    const lost = [];
    let n = 0;
    let bib = 0;
    const snapshot = (e) => JSON.stringify({
      races: holder.cfg.races.map((r) => [r.id, e.crossings(r.id).map((c) => c.bib).sort().join(','), JSON.stringify(e.raceView(r.id).contestsSeen)]),
      aside: e.setAside().map((a) => [a.contest, a.count, a.reason]),
      noRace: e.noRace().map((x) => [x.contest, x.status, x.count, x.raceId]),
      missing: e.missingRaces().map((m) => [m.raceId, m.count]),
    });
    for (let step = 0; step < 80; step++) {
      const op = rand();
      try {
        if (!config.races.length && op >= 0.6 && op < 0.93) continue;
        if (op < 0.45) {
          for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
            const kind = rand();
            const port = pick(PORTS);
            const read = { location: '', bib: String(++bib), tod: parseTod('10:05:00') + bib * 1000, contest: '', event: '' };
            if (kind < 0.6) keyOf.set(read.bib, `port ${port}`);
            else if (kind < 0.8) keyOf.set(read.bib, `event ${(read.event = pick(['1-1-1', '2-1-1', '9-1-1']))}`);
            else keyOf.set(read.bib, `contest ${(read.contest = pick(['A', 'B']))}`);
            engine.handleRead(read, { port });
          }
          continue;
        } else if (op < 0.6) {
          config = addRace(config, { name: `R${++n}`, eventNumber: String(1 + Math.floor(rand() * 4)), gun: '10:00:00.000',
            splits: [{ name: 'S1', sources: [] }], inputPort: rand() < 0.2 ? null : pick(PORTS), contests: rand() < 0.3 ? [pick(['A', 'B'])] : [],
            active: rand() < 0.6 }).config;
        } else if (op < 0.7) {
          const r = pick(config.races);
          config = updateRace(config, r.id, rand() < 0.5 ? { inputPort: rand() < 0.2 ? null : pick(PORTS) } : { active: !r.active }).config;
        } else if (op < 0.78) {
          config = activateRace(config, pick(config.races).id).config;
        } else if (op < 0.86) {
          const r = pick(config.races);
          config = deleteRace(config, r.id);
          holder.cfg = config;
          engine.configChanged({ deleted: [r.id] });
          continue;
        } else if (op < 0.93) {
          // gone from the settings without a Delete (config.json put back from its backup): missing (R6)
          const r = pick(config.races);
          lost.push(r);
          config = { ...config, races: config.races.filter((x) => x.id !== r.id) };
        } else if (lost.length) {
          const r = lost.shift();
          config = restoreRace(config, r, r.id).config; // "Put it back" (V2)
        }
      } catch (err) {
        if (err?.name !== 'ConfigError') throw err;
        continue; // a change the panel refuses
      }
      holder.cfg = config;
      engine.configChanged();
      // a restart from the journal (and the race files) works out the same
      engine.flush();
      const copy = memStore();
      for (const [k, v] of store.data) copy.data.set(k, v);
      copy.journal.push(...store.journal, JSON.stringify({ t: 'stop', at: clock.now() }));
      assert.equal(snapshot(new Engine({ getConfig: () => holder.cfg, store: copy, clock, autoStart: false })), snapshot(engine), `seed ${seed} step ${step}: restart`);
      // one place per key for the reads in an Active race or in no race (9.2 invariant)
      const active = new Set(config.races.filter((r) => r.active).map((r) => r.id));
      const places = new Map();
      for (const e of engine.feed(1000)) {
        if (['race-deleted', 'cleared', 'duplicate', 'bad-line', 'race-missing'].includes(e.status)) continue;
        if (e.raceId && !active.has(e.raceId)) continue; // frozen in a race that is not Active (R1)
        const key = keyOf.get(e.bib);
        const place = e.raceId ? `race ${e.raceId}` : `${e.status} ${e.raceName}`;
        if (!places.has(key)) places.set(key, new Set());
        places.get(key).add(place);
      }
      for (const [key, set] of places) assert.equal(set.size, 1, `seed ${seed} step ${step}: ${key} is in ${[...set].join(' and ')}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Revision 8 (DESIGN 9.16): what a Resend can't correct, a feed that follows delivery, the clock offset

/**
 * TrackScore XC's split cells (server/xc/xc-ingestion.ts in TrackScore): a split goes to cell "totalSplits - L2G" of the
 * runner, with the totalSplits TrackScore has when the packet comes; a packet fills a cell, nothing on the wire empties
 * one.
 * @param {any[]} packets in the order they went out
 * @param {number | ((p: any) => number)} total TrackScore's number of splits (when each packet came)
 * @returns {Map<string, Map<number, number>>} bib -> cell -> race ticks
 */
function trackScoreCells(packets, total) {
  const cells = new Map();
  for (const p of packets) {
    const n = typeof total === 'function' ? total(p) : total;
    const idx = n - p.lapsToGo;
    if (!cells.has(p.bib)) cells.set(p.bib, new Map());
    const m = cells.get(p.bib);
    // a new number of splits resizes the runner's cells to n + 2, keeping what fits
    for (const k of [...m.keys()]) if (k >= n + 2) m.delete(k);
    if (idx >= 0 && idx < n + 2) m.set(idx, p.csTicks);
  }
  return cells;
}

/** The cells TrackScore shows (columns of the race's splits) that hold a time Split Relay has no split for now: "bib col". */
function wrongCells(s, raceId, cells) {
  const race = s.config.races.find((r) => r.id === raceId);
  const want = new Map();
  for (const c of s.engine.crossings(raceId)) {
    if (!want.has(c.bib)) want.set(c.bib, new Map());
    want.get(c.bib).set(race.splits.findIndex((x) => x.id === c.splitId), c.raceTicks);
  }
  const out = [];
  for (const [bib, m] of cells) {
    for (const [col, t] of m) if (col < race.splits.length && want.get(bib)?.get(col) !== t) out.push(`${bib} ${col}`);
  }
  return out.sort();
}

test('9.16 F1: the number of splits fixed after splits went out: Resend corrects every split, and the cells it cannot are counted by runner', () => {
  const store = memStore();
  const clock = fakeClock();
  // TrackScore has 2 splits; the race was given 3 by mistake (split 2 earliest 12:00, for a missed first mat)
  const s = setup({ store, clock, races: [lapRace({ id: 'r', splits: lapSplits(3, ['', '12:00', '']) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  lap(s, 501, after('7:00'));
  lap(s, 512, after('7:10'));
  s.clock.advance(3000);
  lap(s, 501, after('16:00'));
  lap(s, 507, after('16:01.7')); // missed the first split mat: split 2 by its earliest time
  lap(s, 512, after('16:10'));
  lap(s, 519, after('18:06.4')); // missed it too
  s.clock.advance(3000);
  lap(s, 512, after('16:50')); // a third pass: split 3 of 3
  s.clock.advance(3000);
  assert.equal(s.engine.raceView('r').leftover.count, 0, 'nothing to say while the settings are unchanged');

  // a minute later the number of splits is fixed: 2
  s.clock.advance(61_000);
  s.config.races[0].splits = lapSplits(2, ['', '12:00']);
  s.engine.configChanged();
  let v = s.engine.raceView('r');
  assert.deepEqual([v.stale.reason, v.stale.splitCountFrom], ['split-count', 3]);
  assert.match(v.stale.hint, /Resend this race's splits\. Resend corrects every split Split Relay has\. A runner who has no split in a column under the new setting may still show an old time there in TrackScore and the live results until the race is cleared there\.$/);
  const expectLeftover = {
    count: 2, runners: ['507', '519'], byOutput: [{ outputId: 'o1', name: 'TrackScore', count: 2 }],
    text: "2 cells sent earlier can't be removed from TrackScore by Split Relay (runners: 507, 519). These runners have no " +
      'split in those columns under the current settings, so TrackScore and the live results may still show an old time ' +
      'there until the race is cleared there.',
  };
  assert.deepEqual(v.leftover, expectLeftover, 'known before the resend');

  assert.ok(s.engine.resendRace('r').sent > 0);
  // what TrackScore (2 splits all along) shows now: every split Split Relay has is right; the wrong cells are the ones counted
  assert.deepEqual(wrongCells(s, 'r', trackScoreCells(s.sends, 2)), ['507 0', '519 0']);
  // had TrackScore had 3 splits when the first packets came (and 2 since), it would show no wrong cell: the count says
  // "may", it never misses one
  assert.deepEqual(wrongCells(s, 'r', trackScoreCells(s.sends, (p) => p.splitCount)), []);
  v = s.engine.raceView('r');
  assert.equal(v.stale.count, 0);
  assert.deepEqual(v.leftover, expectLeftover, 'and still after it: a packet cannot empty a cell');

  // a restart remembers them (the race file keeps the cells no ledger entry stands for)
  s.engine.flush();
  assert.ok(JSON.parse(store.data.get('r')).orphans.o1.length > 0);
  store.journal.push(JSON.stringify({ t: 'stop', at: clock.now() }));
  const s2 = setup({ store, clock, config: s.config });
  assert.deepEqual(s2.engine.raceView('r').leftover, expectLeftover, 'the same after a restart');
  // Clear race data forgets them with the race
  s2.engine.clearRace('r');
  assert.deepEqual(s2.engine.raceView('r').leftover, { count: 0, runners: [], byOutput: [], text: null });
});

test('9.16 F1: a crossing that went out and no longer counts (the start area raised): its cell is counted, the others are corrected', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: lapSplits(3) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  lap(s, 601, after('1:30')); // over a split mat near the start
  lap(s, 602, after('2:40'));
  s.clock.advance(3000);
  lap(s, 601, after('5:00'));
  lap(s, 602, after('5:05'));
  s.clock.advance(3000);
  lap(s, 601, after('10:00'));
  lap(s, 602, after('10:05'));
  s.clock.advance(3000);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '601').map((c) => c.splitName), ['Split 1', 'Split 2', 'Split 3']);
  s.clock.advance(61_000);
  // the operator raises the start area to 2 minutes: 601's 1:30 pass no longer counts, its passes move down a split
  s.config.filter.startIgnoreSec = 120;
  s.engine.configChanged();
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '601').map((c) => c.splitName), ['Split 1', 'Split 2']);
  const v = s.engine.raceView('r');
  assert.equal(v.stale.reason, 'changed');
  assert.deepEqual([v.leftover.count, v.leftover.runners], [1, ['601']]);
  assert.match(v.leftover.text, /^1 cell sent earlier can't be removed from TrackScore by Split Relay \(runner: 601\)\. This runner has no split in that column under the current settings/);
  s.engine.resendRace('r');
  assert.deepEqual(wrongCells(s, 'r', trackScoreCells(s.sends, 3)), ['601 2'], "TrackScore keeps 601's old split 3");
  assert.deepEqual(s.engine.raceView('r').leftover.runners, ['601']);
  // the start area back as it was: 601 has a split 3 again, and nothing is left over
  s.config.filter.startIgnoreSec = 60;
  s.engine.configChanged();
  assert.equal(s.engine.raceView('r').leftover.count, 0);
  // no gun time (being fixed): nothing counts until it is set again, so nothing is said
  s.engine.setGun('r', '');
  assert.equal(s.engine.raceView('r').leftover.count, 0);
});

test('9.16 F3: "Sent" only once an output took it; otherwise "Ready", and the finished count follows, before and after a restart', async () => {
  const store = memStore();
  const clock = fakeClock();
  const lynx = new Map();
  // the only output sends another race
  const s = setup({ store, clock, outputs: [output({ races: ['other'] })], finishers: () => lynx });
  const r1 = s.read('1K-A', 1, '10:03:00');
  const r2 = s.read('1K-A', 2, '10:03:01');
  s.clock.advance(3000);
  assert.equal(s.sends.length, 0);
  let e = entryOf(s, r1);
  assert.deepEqual([e.status, e.place], ['ready', 1]);
  assert.equal(e.detail, 'Ready — no output took it: no output that is switched on sends Girls Varsity 5K (Outputs tab). It goes out by itself as soon as an output can take it.');
  assert.deepEqual(s.engine.crossings('r1').map((c) => [c.bib, c.sentAt, c.reason]), [['1', null, null], ['2', null, null]]);
  // bib 2 finishes (FinishLynx): its split was never sent, and the count says so
  lynx.set('2', rt('9:00'));
  s.engine.converge();
  assert.equal(entryOf(s, r2).status, 'finished-not-sent');
  assert.equal(s.engine.raceView('r1').finishedNotSent, 1);

  // a restart says the same
  s.engine.stop();
  s.engine.markCleanStop();
  const s2 = setup({ store, clock, config: s.config, finishers: () => lynx });
  s2.clock.advance(3000);
  assert.equal(s2.engine.raceView('r1').finishedNotSent, 1);
  const a = s2.read('1K-B', 1, '10:03:00.300'); // a backup read: its row says what the crossing is now
  s2.clock.advance(3000);
  assert.equal(a.status, 'backup');
  assert.deepEqual(s2.engine.crossings('r1').map((c) => [c.bib, c.sentAt]), [['1', null], ['2', null]]);

  // the output is given this race: bib 1 goes out and is Sent; bib 2 has finished and stays out
  s2.config.outputs[0].races = [];
  s2.engine.configChanged();
  assert.deepEqual(s2.sends.map((p) => p.bib), ['1']);
  assert.equal(s2.engine.raceView('r1').finishedNotSent, 1);
  assert.equal(s2.engine.crossings('r1')[0].reason, 'new');

  // no outputs at all, every output switched off
  const none = setup({ outputs: [] });
  const n1 = none.read('1K-A', 3, '10:03:00');
  none.clock.advance(3000);
  assert.match(entryOf(none, n1).detail, /^Ready — no output took it: there are no outputs yet \(add TrackScore on the Outputs tab\)\./);
  const off = setup({ outputs: [output({ enabled: false })] });
  const o1 = off.read('1K-A', 4, '10:03:00');
  off.clock.advance(3000);
  assert.match(entryOf(off, o1).detail, /^Ready — no output took it: every output is switched off \(Outputs tab\)\./);

  // a broken script: the row says why
  const s3 = setup();
  s3.net.refuse.add('o1');
  s3.engine.converge([{ id: 'o1', enabled: true, state: 'error', scriptOk: false, scriptError: 'C:\\Lynx\\XCScore.lss not found', clients: 0 }]);
  const b = s3.read('1K-A', 5, '10:03:00');
  s3.clock.advance(3000);
  e = entryOf(s3, b);
  assert.equal(e.status, 'ready');
  assert.match(e.detail, /^Ready — no output took it: TrackScore's script can't be loaded \(C:\\Lynx\\XCScore\.lss not found\)\./);
  s3.net.refuse.delete('o1');
  s3.engine.converge([{ id: 'o1', enabled: true, state: 'connected', scriptOk: true, scriptLoadedAt: 7, clients: 1 }]);
  assert.deepEqual([entryOf(s3, b).status, s3.sends.length], ['sent', 1]);

  // taken, then dropped before it went out (TrackScore's queue was thrown away): Ready again, once the drop is known
  const s4 = setup();
  s4.net.hold.add('o1');
  const q = s4.read('1K-A', 7, '10:03:00');
  s4.clock.advance(3000);
  assert.equal(entryOf(s4, q).status, 'sent', 'handed to the output, which sends it when it can');
  s4.net.dropAll();
  await Promise.resolve();
  assert.equal(entryOf(s4, q).status, 'ready');
});

test("9.16 F6: the clock offset is a low percentile of recent reads; a flush of RR12's queue does not move it, a wrong PC clock does", () => {
  const todOf = (ms) => {
    const d = new Date(ms);
    return formatTod(((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * S + d.getMilliseconds() * 10);
  };
  // a cold start straight into a flush: RR12 had 344 reads queued, the newest 40 s old, the oldest 6 minutes old
  const s = setup({ races: [] });
  for (let i = 0; i < 344; i++) s.read('1K-A', 1000 + i, todOf(s.clock.now() - 360_000 + i * 930));
  assert.equal(s.engine.clockLagSec(), null, 'a flush says nothing about the clocks');
  s.clock.advance(2000);
  assert.equal(s.engine.clockLagSec(), null);
  // live reads, 1.5 to 3 s after the passing
  for (let i = 0; i < 30; i++) {
    s.clock.advance(700);
    s.read('1K-A', 2000 + i, todOf(s.clock.now() - 1500 - ((i * 53) % 1500)));
  }
  const live = s.engine.clockLagSec();
  assert.ok(live >= 1.5 && live <= 2, String(live));
  // another flush mid-race, spread over 3.4 s (Split Relay takes a big one in slices): no change
  for (let i = 0; i < 344; i++) {
    if (i % 10 === 0) s.clock.advance(100);
    s.read('1K-A', 3000 + i, todOf(s.clock.now() - 300_000 + i * 800));
  }
  s.clock.advance(2000);
  assert.equal(s.engine.clockLagSec(), live);
  // one read with a wrong time does not move it either
  s.read('1K-A', 4000, todOf(s.clock.now() + 60_000));
  s.clock.advance(1500);
  assert.equal(s.engine.clockLagSec(), live);

  // this PC's clock 30 s ahead of RR12's: every read arrives 31.5-33 s "late"
  const w = setup({ races: [] });
  for (let i = 0; i < 40; i++) {
    w.clock.advance(1000);
    w.read('1K-A', 100 + i, todOf(w.clock.now() - 30_000 - 1500 - ((i * 53) % 1500)));
  }
  const ahead = w.engine.clockLagSec();
  assert.ok(ahead >= 31.4 && ahead <= 32, String(ahead));
  // and 30 s behind it: the reads seem to come from the future
  const b = setup({ races: [] });
  for (let i = 0; i < 40; i++) {
    b.clock.advance(1000);
    b.read('1K-A', 100 + i, todOf(b.clock.now() + 30_000 - 1500 - ((i * 53) % 1500)));
  }
  assert.ok(b.engine.clockLagSec() <= -27, String(b.engine.clockLagSec()));
});

// ---- DESIGN 9.22 M9: Start a new meet ------------------------------------------------------------------------------

/** A meet with reads everywhere: a race that sent splits, reads waiting for a race, set aside, of a missing race, in none. */
function lastMeet(store = memStore()) {
  const s = setup({ store, races: [
    race({ id: 'g', name: 'Girls 5K', contests: ['Girls'] }),
    race({ id: 'b', name: 'Boys 5K', contests: ['Boys'], active: false, gun: '' }),
    race({ id: 'v', name: 'Varsity', contests: ['Varsity', 'JV'], eventNumber: '7', gun: '' }),
    race({ id: 'm', name: 'Open', contests: ['Open'], eventNumber: '9', gun: '' }),
  ] });
  s.read('1K-A', 1, '10:03:00', { contest: 'Girls' });
  s.read('1K-A', 2, '10:03:01', { contest: 'Girls' });
  s.read('1K-A', 50, '10:03:00', { contest: 'Boys' }); // waits for Boys 5K (not Active)
  s.read('1K-A', 60, '10:03:00', { contest: 'JV' });
  s.read('1K-A', 70, '10:03:00', { contest: 'Open' });
  s.read('1K-A', 80, '10:03:00', { contest: 'Novice' }); // no race takes it
  s.clock.advance(3000);
  // JV is set aside (Varsity stops listing it), Open goes missing (config.json edited: not deleted)
  s.config.races[2].contests = ['Varsity'];
  s.config.races = s.config.races.filter((r) => r.id !== 'm');
  s.engine.configChanged();
  return s;
}

test('9.22 M9 newMeet: every read goes out of use, in races and in none; nothing is sent; deliveries are forgotten', () => {
  const s = lastMeet();
  assert.equal(s.sends.length, 2, 'Girls 5K sent its two splits');
  assert.ok(s.engine.noRace().length > 0 && s.engine.setAside().length > 0 && s.engine.missingRaces().length > 0);
  assert.deepEqual([...s.engine.sentCounts()], [['o1', 2]]);
  const { byRace, noRace } = s.engine.readsBefore(s.clock.now() + 1);
  assert.deepEqual([[...byRace].sort(), noRace], [[['g', 2], ['m', 1]], 3]);
  assert.deepEqual(s.engine.readsBefore(T0 - 1), { byRace: new Map(), noRace: 0 });
  const r = s.engine.newMeet();
  assert.deepEqual(r, { reads: 6 });
  s.clock.advance(5000);
  assert.equal(s.sends.length, 2, 'nothing is sent');
  for (const id of ['g', 'b', 'v']) {
    const v = s.engine.raceView(id);
    assert.deepEqual([v.runners, v.lastReadAt, v.splits[0].crossings, v.stale.count], [0, null, 0, 0], id);
  }
  assert.deepEqual([s.engine.noRace(), s.engine.setAside(), s.engine.missingRaces(), s.engine.deletedBack()], [[], [], [], []]);
  assert.deepEqual([...s.engine.sentCounts()], []);
  assert.deepEqual(s.engine.readsBefore(s.clock.now() + 1), { byRace: new Map(), noRace: 0 });
  const recs = s.store.journal.map((l) => JSON.parse(l));
  const nm = recs.find((x) => x.t === 'new-meet');
  assert.deepEqual([nm.seq, Number.isFinite(nm.at)], [6, true]);
  assert.deepEqual(recs.filter((x) => x.t === 'clear').map((x) => [x.raceId, x.seq]), [['g', 6], ['b', 6], ['v', 6]], 'O12: a clear per race for an older Split Relay');
  assert.deepEqual(JSON.parse(s.store.data.get('g')), { version: 2, clearedSeq: 6, ledgers: {}, race: s.config.races[0] });
  // a read after it counts, and an RR12 Replay of the last meet's read counts as new (as after Clear race data)
  assert.equal(s.read('1K-A', 1, '10:03:00', { contest: 'Girls' }).status, 'held');
  assert.equal(s.read('1K-A', 3, '10:03:05', { contest: 'Girls' }).status, 'held');
  s.clock.advance(3000);
  assert.deepEqual(s.sends.slice(2).map((p) => [p.bib, p.place]), [['1', 1], ['3', 2]]);
});

test('9.22 M9 newMeet survives a restart: the same state, and no clear journaled again at the next start', () => {
  const store = memStore();
  const s = lastMeet(store);
  s.engine.newMeet();
  s.read('1K-A', 5, '10:04:00', { contest: 'Girls' });
  s.clock.advance(3000);
  s.engine.stop();
  s.engine.markCleanStop();
  const lines = store.journal.length;
  const t = setup({ store, config: s.config });
  assert.equal(store.journal.length, lines, 'a race file saved after the new meet is no reason to journal a clear');
  assert.deepEqual(t.engine.crossings('g').map((c) => c.bib), ['5']);
  assert.deepEqual([t.engine.noRace(), t.engine.setAside(), t.engine.missingRaces()], [[], [], []]);
  t.clock.advance(3000);
  assert.equal(t.sends.length, 0, 'what was sent after the new meet is not sent again');
  assert.deepEqual([...t.engine.sentCounts()], [['o1', 1]]);
});

test('9.22 M9 + 9.23 newMeet forgets every race\'s fixes: no pin, made-up time, change or Undo is left; a Replay of the old reads counts them as read; a restart is the same', () => {
  const store = memStore();
  const lap = (over = {}) => race({ splits: ['1K', '2K', '3K', '4K'].map((name, i) => ({ id: `s${i + 1}`, name, sources: [] })), finishSources: [], ...over });
  const s = setup({ store, races: [lap({ id: 'g', name: 'Girls 5K', contests: ['Girls'] }), lap({ id: 'b', name: 'Boys 5K', contests: ['Boys'], eventNumber: '4' })] });
  // ten runners in each race pass four mats; bib 105 missed 2K (its 3K pass counted as 2K, 4K as 3K), and bib 207's
  // stream has a stray pass 20 s after its 1K
  const reads = [];
  for (const [contest, base] of [['Girls', 100], ['Boys', 200]]) {
    for (let k = 1; k <= 4; k++) {
      for (let i = 0; i < 10; i++) {
        const bib = base + i;
        if (bib === 105 && k === 2) continue;
        reads.push([Math.round(180 * k * (1 + 0.02 * i)), bib, contest]);
      }
    }
  }
  reads.push([Math.round(180 * 1.14) + 20, 207, 'Boys']);
  reads.sort((a, b) => a[0] - b[0]);
  const tod = (sec) => formatTod(parseTod('10:00:00') + sec * S);
  const replay = () => {
    for (const [sec, bib, contest] of reads) s.read('', bib, tod(sec), { contest });
    s.clock.advance(3000);
  };
  replay();
  const pass = (eng, raceId, bib, t) => eng.runner(raceId, String(bib)).passes.find((p) => p.raceTicks === t * S);
  // the fixes: 105's 3K pass to 3K with the later times, its 2K filled with a made-up time; 207's stray pass Not a split;
  // bib 103's 4K pass kept ("It's right")
  const t3 = Math.round(180 * 3 * 1.1);
  const fixes = [];
  fixes.push(s.engine.movePass('g', '105', { tod: pass(s.engine, 'g', 105, t3).tod, to: 's3' }).change.fix);
  fixes.push(s.engine.addManual('g', { bib: '105', splitId: 's2', ifEmpty: true }).change.fix);
  fixes.push(s.engine.movePass('b', '207', { tod: pass(s.engine, 'b', 207, Math.round(180 * 1.14) + 20).tod, to: 'none' }).change.fix);
  fixes.push(s.engine.movePass('g', '103', { tod: pass(s.engine, 'g', 103, Math.round(720 * 1.06)).tod, to: 'keep' }).change.fix);
  const shown = (eng) => ['g', 'b'].map((id) => {
    const r = eng.review(id);
    return [id, r.counts.pinned, r.counts.madeUp, r.manual.length];
  });
  assert.deepEqual(shown(s.engine), [['g', 2, 1, 1], ['b', 1, 0, 0]]);
  assert.deepEqual(s.engine.runner('g', '105').columns.map((c) => c.kind), ['read', 'made-up', 'moved', 'moved']);
  assert.deepEqual(s.engine.runner('b', '207').passes.map((p) => p.pinned ?? null), [null, 'none', null, null, null]);
  s.engine.newMeet();
  // nothing of the old meet's fixes is left, and Undo of any of them says the race was cleared since
  const forgotten = (eng) => {
    assert.deepEqual(shown(eng), [['g', 0, 0, 0], ['b', 0, 0, 0]]);
    for (const [id, bib] of [['g', '105'], ['g', '103'], ['b', '207']]) assert.deepEqual(eng.runner(id, bib).changes, [], `${id} ${bib}`);
    for (const fix of fixes) {
      const id = fix === fixes[2] ? 'b' : 'g';
      const name = id === 'b' ? 'Boys 5K' : 'Girls 5K';
      assert.throws(() => eng.undo(id, { fix, confirm: true }), (err) => err.status === 404
        && err.message === `There is no change ${fix} in ${name} (the race was cleared since). Change it by hand.`, `undo ${fix}`);
    }
  };
  forgotten(s.engine);
  // an RR12 Replay of the old reads: counted as the mats read them, no Move, Not a split, Keep or made-up time
  replay();
  const counted = (eng) => [eng.runner('g', '105').columns.map((c) => [c.timeText, c.kind]), eng.runner('b', '207').passes.map((p) => [p.timeText, p.pinned ?? null]),
    eng.runner('g', '103').passes.map((p) => p.pinned ?? null)];
  const fresh = counted(s.engine);
  // (its 4K empty again, and the column check may ask about it, as on the day it was read)
  assert.deepEqual(fresh[0].map((c) => c[1]).slice(0, 3), ['read', 'read', 'read']);
  assert.equal(fresh[0][3][0], '');
  assert.equal(fresh[0][1][0], formatRaceTime(t3 * S, 1), "105's 3K pass is 2K again: nobody moved it in this meet");
  assert.ok(fresh[1].every((p) => p[1] === null) && fresh[2].every((p) => p === null));
  forgotten(s.engine);
  const crossings = (eng) => ['g', 'b'].flatMap((id) => eng.crossings(id).map((c) => [id, c.bib, c.splitId, c.tod, c.place, c.source]));
  const before = crossings(s.engine);
  // after a stop and a start, the same: the journal's old fixes come before the new meet and stay forgotten
  s.engine.stop();
  s.engine.markCleanStop();
  const t = setup({ store, config: s.config });
  assert.deepEqual(crossings(t.engine), before);
  assert.deepEqual(counted(t.engine), fresh);
  forgotten(t.engine);
  // and a kill (no clean stop) gives the same
  t.engine.stop();
  const u = setup({ store, config: s.config });
  assert.deepEqual(crossings(u.engine), before);
  forgotten(u.engine);
});

test('9.22 M9 a race file not saved again after the new meet does not bring the last meet\'s deliveries back', () => {
  const store = memStore();
  const s = lastMeet(store);
  const old = store.data.get('g');
  assert.equal(JSON.parse(old).ledgers.o1.length, 2, "the race file has the last meet's deliveries");
  s.engine.newMeet();
  s.engine.stop();
  // a kill within the save delay: the race file still has the last meet's ledgers
  store.data.set('g', old);
  const t = setup({ store, config: s.config });
  assert.deepEqual([...t.engine.sentCounts()], []);
  assert.equal(t.engine.raceView('g').stale.count, 0);
  t.read('1K-A', 1, '10:03:00', { contest: 'Girls' });
  t.clock.advance(3000);
  assert.deepEqual(t.sends.map((p) => [p.bib, p.reason]), [['1', 'new']], 'bib 1 is new to TrackScore in this meet');
});

// ---- DESIGN 9.26: split points that are counted but not sent ---------------------------------------------------------

/** LapTime splits by name; the ones in `quiet` are counted, not sent (collectOnly). */
const quietSplits = (names, quiet = []) => names.map((name, i) => ({ id: `s${i + 1}`, name, sources: [], earliest: '',
  ...(quiet.includes(name) ? { collectOnly: true } : {}) }));
const line = (p) => [p.bib, p.splitName, p.lapsToGo, p.splitCount, p.splitIndex, p.csTicks, p.lsTicks, p.place, p.reason];

test('9.26: a split that is counted but not sent takes its pass and sends nothing; laps to go, the split count and the leg follow the sent splits', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: quietSplits(['1K', '1.2K', '2K', '3K'], ['1.2K']) })], filter: { tagWindowSec: 20, holdSec: 0 } });
  lap(s, 1, after('3:00'));
  const mid = lap(s, 1, after('3:36'));
  lap(s, 1, after('6:00'));
  lap(s, 1, after('9:00'));
  lap(s, 2, after('3:10'));
  lap(s, 2, after('3:50'));
  lap(s, 2, after('6:20'));
  s.clock.advance(3000);
  // nothing of 1.2K on the wire: laps to go 3, 2, 1 of 3 sent splits, the split index among them, and 2K's leg since 1K
  assert.deepEqual(s.sends.map(line), [
    ['1', '1K', 3, 3, 0, rt('3:00'), rt('3:00'), 1, 'new'],
    ['1', '2K', 2, 3, 1, rt('6:00'), rt('3:00'), 1, 'new'],
    ['1', '3K', 1, 3, 2, rt('9:00'), rt('3:00'), 1, 'new'],
    ['2', '1K', 3, 3, 0, rt('3:10'), rt('3:10'), 2, 'new'],
    ['2', '2K', 2, 3, 1, rt('6:20'), rt('3:10'), 2, 'new'],
  ]);
  for (const p of s.sends) {
    const vars = packetVariables(p, {});
    assert.equal(packetProblem(p, vars), null);
    assert.equal(JSON.parse(renderUpdate(XCSCORE, { stage: 'results', header: vars.header, rows: vars.rows }).text).D.L2G, String(p.lapsToGo));
  }
  // counted like any split: the pass is its crossing, with its place there; held for good, never waiting
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.splitName === '1.2K').map((c) => [c.bib, c.raceTicks, c.place, c.held, c.sentAt]),
    [['1', rt('3:36'), 1, 'collect', null], ['2', rt('3:50'), 2, 'collect', null]]);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.splitName !== '1.2K').map((c) => c.held), [null, null, null, null, null]);
  const row = entryOf(s, mid);
  assert.deepEqual([row.status, row.splitName], ['counted', '1.2K']);
  assert.match(row.detail, /^1\.2K is counted, not sent: /);
  const v = s.engine.raceView('r');
  assert.deepEqual([v.splitCount, v.sentCount, v.stale.count, v.finishedNotSent, v.resend], [4, 3, 0, 0, { count: 5, finished: 0 }]);
  assert.deepEqual(v.splits.map((x) => [x.name, x.crossings, x.held, x.collectOnly ?? false]), [['1K', 2, 0, false], ['1.2K', 2, 0, true], ['2K', 2, 0, false], ['3K', 1, 0, false]]);
  // the merged .lif: only the sent splits, in course order
  const d = s.engine.raceData('r');
  assert.equal(d.splitCount, 3);
  assert.deepEqual([d.runners.get('1').splits, d.runners.get('2').splits], [[rt('3:00'), rt('6:00'), rt('9:00')], [rt('3:10'), rt('6:20'), null]]);
  // the runner editor and the grid: the column is marked, with no laps to go
  const cols = s.engine.runner('r', '2').columns;
  assert.deepEqual(cols.map((c) => [c.splitName, c.lapsToGo, c.collectOnly ?? false, c.held, c.kind, c.missing]),
    [['1K', 3, false, null, 'read', false], ['1.2K', null, true, 'collect', 'read', false], ['2K', 2, false, null, 'read', false], ['3K', 1, false, null, 'not-yet', false]]);
  const g = s.engine.grid('r');
  assert.deepEqual(g.splits.map((x) => x.collectOnly ?? false), [false, true, false, false]);
  assert.deepEqual(g.rows.find((x) => x.bib === '1').cells.map((c) => c.held ?? null), [null, 'collect', null, null]);
  // a Resend sends what the boards can show, and nothing else
  assert.deepEqual(s.engine.resendRace('r'), { sent: 5, skippedFinished: 0, outputs: 1 });
  assert.deepEqual(s.sends.slice(5).map((p) => [p.splitName, p.lapsToGo, p.reason]), [['1K', 3, 'resend'], ['1K', 3, 'resend'], ['2K', 2, 'resend'], ['2K', 2, 'resend'], ['3K', 1, 'resend']]);
  // and a restart keeps it so: nothing goes out for the split that is not sent
  s.engine.stop();
  s.engine.markCleanStop();
  const t = setup({ store: s.store, config: s.config });
  t.clock.advance(3000);
  assert.deepEqual(t.sends, []);
  assert.deepEqual(t.engine.crossings('r').filter((c) => c.held).map((c) => [c.bib, c.splitName, c.held]), [['1', '1.2K', 'collect'], ['2', '1.2K', 'collect']]);
});

test('9.26: switching a split to Not sent, or back, is a new number of splits for the boards: older lines are stale until Resend, with the reason', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: quietSplits(['1K', '1.2K', '2K']) })], filter: { tagWindowSec: 20, holdSec: 0 } });
  lap(s, 1, after('3:00'));
  lap(s, 1, after('3:36'));
  lap(s, 1, after('6:00'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.lsTicks]), [['1K', 3, 3, rt('3:00')], ['1.2K', 2, 3, rt('0:36')], ['2K', 1, 3, rt('2:24')]]);
  // after their minute: nothing goes by itself; the tile says why, in the words of a change of the number of splits
  s.clock.advance(61_000);
  s.config.races[0].splits[1].collectOnly = true;
  s.engine.configChanged();
  s.clock.advance(100);
  assert.equal(s.sends.length, 3);
  let v = s.engine.raceView('r');
  assert.deepEqual([v.sentCount, v.stale.count, v.stale.reason, v.stale.splitCountFrom, v.resendSuggested, v.resend.count], [2, 2, 'split-count', 3, true, 2]);
  assert.equal(v.stale.hint, 'TrackScore and Karmarush put splits in columns by laps to go; this race now sends 2 splits instead of 3, ' +
    "so the splits already sent are in the wrong columns. Resend this race's splits. Resend corrects every split Split Relay has. " +
    'A runner who has no split in a column under the new setting may still show an old time there in TrackScore and the live ' +
    'results until the race is cleared there.');
  assert.equal(s.engine.resendRace('r').sent, 2);
  // 2K's leg is now since 1K: 1.2K is not on the boards
  assert.deepEqual(s.sends.slice(3).map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.lsTicks, p.reason]), [['1K', 2, 2, rt('3:00'), 'resend'], ['2K', 1, 2, rt('3:00'), 'resend']]);
  v = s.engine.raceView('r');
  assert.deepEqual([v.stale.count, v.leftover.count], [0, 0]);
  // a new runner: two packets, never three
  lap(s, 2, after('3:10'));
  lap(s, 2, after('3:50'));
  lap(s, 2, after('6:20'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(5).map((p) => [p.bib, p.splitName, p.lapsToGo, p.splitCount]), [['2', '1K', 2, 2], ['2', '2K', 1, 2]]);
  // Send switched on again within the runner's minute: what was only counted goes out, and its fresh lines are corrected
  s.config.races[0].splits[1].collectOnly = false;
  s.engine.configChanged();
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(7).filter((p) => p.bib === '2').map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.reason]).sort(),
    [['1.2K', 2, 3, 'new'], ['1K', 3, 3, 'correction'], ['2K', 1, 3, 'correction']]);
  v = s.engine.raceView('r');
  assert.deepEqual([v.sentCount, v.stale.reason, v.stale.splitCountFrom], [undefined, 'split-count', 2], "bib 1's older lines wait for Resend");
});

test('9.26: a change inside a split that is not sent sends nothing; a typed time there holds the later passes in their splits and never goes out', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: quietSplits(['1K', '1.2K', '2K', '3K'], ['1.2K']) })], filter: { tagWindowSec: 20, holdSec: 0 } });
  lap(s, 1, after('3:00'));
  lap(s, 1, after('3:36'));
  lap(s, 1, after('6:00'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.map((p) => p.splitName), ['1K', '2K']);
  // the other mat's read of the 1.2K pass, 2 s earlier: the crossing has a new time, the boards get nothing
  lap(s, 1, after('3:34'));
  s.clock.advance(100);
  assert.equal(s.sends.length, 2);
  assert.deepEqual(s.engine.crossings('r').map((c) => [c.splitName, c.raceTicks, c.held]), [['1K', rt('3:00'), null], ['1.2K', rt('3:34'), 'collect'], ['2K', rt('6:00'), null]]);
  // bib 2 is missed by the 1.2K mat: the 2K read is counted into 1.2K, where it is not sent
  lap(s, 2, after('3:10'));
  const two = lap(s, 2, after('6:20'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(2).map((p) => [p.bib, p.splitName]), [['2', '1K']]);
  assert.equal(entryOf(s, two).status, 'counted');
  // "Missed 1.2K: add it" with a typed time: the pass moves on to 2K and goes out; the typed time is counted only
  const before = s.sends.length;
  const r = s.engine.addMissed('r', '2', { splitId: 's2', passTod: parseTod(after('6:20')), time: '3:48.0' });
  s.clock.advance(100);
  assert.match(r.change.text, /^Missed 1\.2K added \(3:48\.0, typed\); 6:20\.0 → 2K/);
  assert.deepEqual(s.sends.slice(before).map((p) => [p.bib, p.splitName, p.csTicks, p.lapsToGo, p.lsTicks, p.reason]), [['2', '2K', rt('6:20'), 2, rt('3:10'), 'new']]);
  assert.deepEqual(r.change.notLive, []);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '2').map((c) => [c.splitName, c.raceTicks, c.source, c.held]),
    [['1K', rt('3:10'), 'read', null], ['1.2K', rt('3:48'), 'typed', 'collect'], ['2K', rt('6:20'), 'read', null]]);
  const m = s.engine.review('r').manual;
  assert.deepEqual(m.map((x) => [x.bib, x.splitName, x.state, x.sent, x.collectOnly]), [['2', '1.2K', 'active', false, true]]);
  const made = s.engine.feed(50).find((f) => f.status === 'typed');
  assert.match(made.detail, /1\.2K is counted, not sent: the time keeps the runner's later passes in their splits and goes to no scoreboard\./);
  assert.doesNotMatch(made.detail, /merged \.lif/);
  // the next pass is 3K, as it should be
  lap(s, 2, after('9:30'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(-1).map((p) => [p.bib, p.splitName, p.lapsToGo]), [['2', '3K', 1]]);
  assert.equal(s.engine.raceData('r').runners.get('2').splits.length, 3);
  assert.equal(s.sends.some((p) => p.splitName === '1.2K'), false);
});

test('9.26: an empty split that is not sent is not a missing split; an empty sent one still is', () => {
  const s = setup({ races: [race({ id: 'r', splits: [{ id: 's1', name: '1K', sources: ['1K-A'] }, { id: 's2', name: '1.2K', sources: ['X-A'], collectOnly: true },
    { id: 's3', name: '2K', sources: ['2K-A'] }], finishSources: [] })], filter: { tagWindowSec: 20, holdSec: 0 } });
  // bib 1: the 1.2K mat missed it; bib 2: the 1K mat missed it
  s.read('1K-A', 1, '10:03:00');
  s.read('2K-A', 1, '10:06:00');
  s.read('X-A', 2, '10:03:50');
  s.read('2K-A', 2, '10:06:20');
  s.clock.advance(100);
  const rv = s.engine.review('r');
  assert.deepEqual(rv.missing.map((x) => [x.bib, x.splitName]), [['2', '1K']]);
  assert.equal(rv.counts.missing, 1);
  const col = s.engine.runner('r', '1').columns[1];
  assert.deepEqual([col.splitName, col.collectOnly, col.missing, col.kind, col.lapsToGo], ['1.2K', true, false, 'not-yet', null]);
  assert.equal(s.engine.runner('r', '1').fillable, 0);
  const g = s.engine.grid('r');
  assert.deepEqual(g.rows.find((x) => x.bib === '1').cells.map((c) => c.kind), ['read', 'not-yet', 'read']);
  assert.deepEqual([g.counts.missing, g.splits.map((x) => x.missing)], [1, [1, 0, 0]]);
  // and nothing of the mat went out
  assert.deepEqual(s.sends.map((p) => [p.bib, p.splitName, p.lapsToGo, p.splitCount]), [['1', '1K', 2, 2], ['1', '2K', 1, 2], ['2', '2K', 1, 2]]);
});

test('9.26: reads merged by the tag filter long after the runner\'s last one are said once three runners have one; a lower tag filter counts them again', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: quietSplits(['1K', '1.2K', '2K'], ['1.2K']) })], filter: { tagWindowSec: 45, holdSec: 0 } });
  // the A and B mats of 1K, 1.5 s apart, then the 1.2K mat 36 s on: inside the 45 s tag filter
  const pass = (bib, t) => {
    lap(s, bib, after(t));
    lap(s, bib, formatTod(parseTod(after(t)) + 1.5 * S, 4));
    lap(s, bib, formatTod(parseTod(after(t)) + 36 * S, 4));
  };
  pass(1, '3:00');
  pass(2, '3:02');
  s.clock.advance(100);
  assert.equal(s.engine.raceView('r').lateMerged, undefined, 'two runners are not it yet');
  pass(3, '3:04');
  s.clock.advance(100);
  const m = s.engine.raceView('r').lateMerged;
  assert.deepEqual([m.reads, m.runners, m.fromSec, m.toSec, m.tagWindowSec], [3, 3, 34, 35, 45]);
  assert.equal(m.text, "3 reads of 3 runners came 34 to 35 s after the runner's last one and were merged into it by the tag filter (45 s). " +
    "If two mats are that close on the course, set the tag filter below the fastest runner's time between them.");
  // what it costs: the 2K read lands in 1.2K, which is not sent
  lap(s, 1, after('6:00'));
  s.clock.advance(100);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.splitName]), [['1', '1K'], ['2', '1K'], ['3', '1K']]);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '1').map((c) => [c.splitName, c.raceTicks, c.reads]), [['1K', rt('3:00'), 3], ['1.2K', rt('6:00'), 1]]);
  // the tag filter below the fastest runner's time between the mats: every race is worked out again from its reads
  s.config.filter.tagWindowSec = 20;
  s.engine.configChanged();
  s.clock.advance(100);
  assert.equal(s.engine.raceView('r').lateMerged, undefined);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.bib === '1').map((c) => [c.splitName, c.raceTicks, c.reads, c.held]),
    [['1K', rt('3:00'), 2, null], ['1.2K', rt('3:36'), 1, 'collect'], ['2K', rt('6:00'), 1, null]]);
  assert.deepEqual(s.sends.slice(3).map((p) => [p.bib, p.splitName, p.lapsToGo, p.lsTicks, p.reason]), [['1', '2K', 1, rt('3:00'), 'new']]);
  assert.equal(s.engine.raceView('r').stale.count, 0);
});

test('9.26: another split sent instead, the same number: the split between them has other laps to go, and the tile says so', () => {
  const s = setup({ races: [lapRace({ id: 'r', splits: quietSplits(['1K', '2K', '3K', '4K'], ['1K']) })], filter: { tagWindowSec: 20, holdSec: 0 } });
  for (const t of ['3:00', '6:00', '9:00', '12:00']) lap(s, 1, after(t));
  s.clock.advance(100);
  assert.deepEqual(s.sends.map((p) => [p.splitName, p.lapsToGo, p.splitCount]), [['2K', 3, 3], ['3K', 2, 3], ['4K', 1, 3]]);
  s.clock.advance(61_000);
  // now 1K is sent and 3K is only counted: 2K goes from laps to go 3 to 2
  s.config.races[0].splits[0].collectOnly = false;
  s.config.races[0].splits[2].collectOnly = true;
  s.engine.configChanged();
  s.clock.advance(100);
  // what was only counted goes out, and the runner's furthest split after it, as after any line of an earlier split
  // (9.23 F4); the line of 2K is older than its minute and waits for Resend
  assert.deepEqual(s.sends.slice(3).map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.reason]), [['1K', 3, 3, 'new'], ['4K', 1, 3, 'place-update']]);
  assert.equal(s.sends.at(-1).lsTicks, rt('6:00'), "4K's leg is since 2K now: 3K is not on the boards");
  const v = s.engine.raceView('r');
  assert.deepEqual([v.stale.count, v.stale.reason, v.stale.splitCountFrom], [1, 'order', null]);
  assert.equal(v.stale.hint, "TrackScore and Karmarush put splits in columns by laps to go; this race's splits were put in another order, or other splits are sent now, " +
    "after they were sent, so they are in the wrong columns. Resend this race's splits. Resend corrects every split Split Relay has. " +
    'A runner who has no split in a column under the new setting may still show an old time there in TrackScore and the live ' +
    'results until the race is cleared there.');
  assert.equal(s.engine.resendRace('r').sent, 3);
  assert.deepEqual(s.sends.slice(-3).map((p) => [p.splitName, p.lapsToGo, p.splitCount, p.lsTicks]), [['1K', 3, 3, rt('3:00')], ['2K', 2, 3, rt('3:00')], ['4K', 1, 3, rt('6:00')]]);
  assert.equal(s.engine.raceView('r').stale.count, 0);
});
