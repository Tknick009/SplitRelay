// DESIGN 9.17, the review tools: pause and play a split, the column check of counted passes, missing splits and the
// made-up times the operator sends for them, splits of finished runners sent with the finish place, and the safety
// rules over all of it. The column check is measured on synthetic races built from real-looking distributions (see
// makeRace): bibs only, no names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, IGNORED_TEXT, MARKED_FINISH_TEXT, TOO_FAST_TEXT } from '../src/engine.js';
import { columnCheck, estimateGaps, moveText, fieldFractions, leaderTimes, CHECK_RULES, legFlags, FIT_RULES, finishColumn, finishPassesIn, legField,
  missedCounts, missedCountText, COUNT_RULES, pastField, legShape, closeFit, checkField, strayLegs, strayIn, strayLegAt,
  fastField, fastLegsOf, fastText, paceAt, FAST_RULES } from '../src/review.js';
import { parseTod, parseRaceTime, formatRaceTime, TICKS_PER_SEC } from '../src/timefmt.js';
import { measureLif, lifFinishers } from '../src/check-lif.js';
import { packetVariables, packetProblem } from '../src/outputs.js';
import { parseScript, renderUpdate } from '../src/lss.js';

const XCSCORE = parseScript(readFileSync(fileURLToPath(new URL('./fixtures/xcscore.lss', import.meta.url))));
const S = TICKS_PER_SEC;
const T0 = new Date(2026, 9, 17, 10, 0, 0).getTime();
const rt = (s) => parseRaceTime(s);

// ---- harness (as in engine.test.js) ----------------------------------------------------------------------------------

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

/** OutputManager.deliver stand-in: takes and acknowledges at once, or holds packets back (an output that is down). */
function fakeNet() {
  const got = [];
  /** the output each packet of `got` went to */
  const via = [];
  const hold = new Set();
  const queued = [];
  return {
    got, via, hold, queued,
    deliver(id, packet, ack) {
      if (hold.has(id)) queued.push({ id, packet, ack });
      else {
        got.push(packet);
        via.push(id);
        ack(true);
      }
      return true;
    },
    flush(id) {
      for (const q of queued.splice(0).filter((x) => x.id === id)) {
        if (q.packet.isCurrent()) {
          got.push(q.packet);
          via.push(q.id);
          q.ack(true);
        } else q.ack(false);
      }
    },
  };
}

const lapSplits = (n, names = []) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, name: names[i] ?? `${i + 1}K`, sources: [], earliest: '' }));
const lapRace = (over = {}) => ({
  id: 'r', name: 'Boys 5K', eventNumber: '1', round: '1', heat: '1', distance: '', contests: [], inputPort: 5565,
  gun: '10:00:00.000', splits: lapSplits(4), finishSources: [], active: true, ...over,
});

function setup({ races = [lapRace()], filter = {}, store = memStore(), clock = fakeClock(), net = fakeNet(), lynx = new Map(),
  places = new Map(), config: given, lif = true, outputs = [{ id: 'o1', name: 'TrackScore', enabled: true, races: [] }] } = {}) {
  // lif: merged .lif files on (Settings): the feed says a made-up time is in one (9.23 F13)
  const config = given ?? { version: 1, filter: { tagWindowSec: 10, holdSec: 2, startIgnoreSec: 60, ...filter }, races,
    outputs, lif: { enabled: lif } };
  const logs = [];
  const engine = new Engine({ getConfig: () => config, store, clock, log: (l) => logs.push(l), deliver: net.deliver,
    finishers: () => lynx, finishPlaces: () => places });
  engine.on('config-patch', ({ raceId, patch }) => Object.assign(config.races.find((r) => r.id === raceId), patch));
  clock.advance(0);
  const s = { engine, config, clock, store, net, sends: net.got, lynx, places, logs };
  /** a FinishLynx LapTime read: bib, race time after a 10:00:00 gun */
  s.lap = (bib, raceTime, port = 5565) => engine.handleRead(
    { location: '', bib: String(bib), tod: parseTod('10:00:00') + parseRaceTime(raceTime), contest: '', first: '', last: '', team: '', gender: '' },
    { receivedAt: clock.now(), raw: `\\x01S,${raceTime},${bib}`, connId: 1, port });
  s.row = (e) => engine.feed(1000).find((x) => x.id === e.id);
  s.restart = () => {
    engine.stop();
    engine.markCleanStop();
    return setup({ store, clock, net, lynx, places, config });
  };
  return s;
}

const sentOf = (s, bib) => s.sends.filter((p) => p.bib === String(bib)).map((p) => [p.splitName, p.csTicks, p.place, p.reason]);

/** Every packet must be one TrackScore can file: 1 <= laps to go <= N, no finish time (9.15 L6). */
function assertSendable(p, config) {
  const n = config.races.find((r) => r.id === p.raceId).splits.length;
  assert.ok(Number.isInteger(p.lapsToGo) && p.lapsToGo >= 1 && p.lapsToGo <= n, `L2G ${p.lapsToGo} of ${n} (bib ${p.bib})`);
  assert.equal(p.lapsToGo, n - p.splitIndex);
  const vars = packetVariables(p, {});
  assert.equal(packetProblem(p, vars), null);
  const d = JSON.parse(renderUpdate(XCSCORE, { stage: 'results', header: vars.header, rows: vars.rows }).text).D;
  assert.equal(d.T, '');
  assert.ok(Number.isInteger(Number(d.P)) && Number(d.P) >= 1, `P ${d.P}`);
}

/**
 * A field of runners that pass the four 1K mats of a 5K: bib b crosses split k at 3:00 x k x pace, pace 1.00 for the
 * first runner, then 2 % slower each. `skip`: bib -> the splits its chip was not read at.
 */
function field(s, { count = 12, splits = 4, skip = {}, upTo = Infinity } = {}) {
  for (let k = 1; k <= splits; k++) {
    for (let i = 0; i < count; i++) {
      const bib = 100 + i;
      if (skip[bib]?.includes(k)) continue;
      const t = 180 * k * (1 + 0.02 * i);
      if (t > upTo) continue;
      s.lap(bib, raceTimeText(t));
    }
  }
}
const raceTimeText = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(3).padStart(6, '0')}`;
const timeOf = (bib, k) => Math.round(180 * k * (1 + 0.02 * (bib - 100)) * S);

// ---- synthetic races from real-looking distributions --------------------------------------------------------------

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
function gauss(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Mats where cross-country courses put them (km); the last number is the finish. */
const COURSES = [
  { name: '5K, 1K splits', d: [1, 2, 3, 4], D: 5 },
  { name: '5K, mile splits', d: [1.609, 3.219], D: 5 },
  { name: '8K, 1 mile / 5K / 6.3K', d: [1.609, 5, 6.3], D: 8 },
  { name: '6K, 2K / 4K', d: [2, 4], D: 6 },
  { name: '5K, 1.5K / 2.5K / 4K', d: [1.5, 2.5, 4], D: 5 },
];
/**
 * A race: finish times log-normal around 17-23 min per 5K with a slower, wider back of the field and a few walkers;
 * pacing styles from a fast start that fades to an even or negative split, slower runners going out relatively faster;
 * legs slowed or sped up for everybody by the terrain. Seconds; mats in course order.
 */
function makeRace(seed, course, size, walkers = 0.04) {
  const rand = rng(seed);
  const legs = [];
  let prev = 0;
  for (const d of [...course.d, course.D]) {
    legs.push(d - prev);
    prev = d;
  }
  const terrain = legs.map(() => 1 + (rand() - 0.5) * 0.12);
  const mean = (course.D / 5) * (17 + rand() * 6) * 60;
  const runners = [];
  for (let i = 0; i < size; i++) {
    const z = gauss(rand);
    const F = mean * Math.exp(0.09 * z + (z > 0 ? 0.03 * z * z : 0) + (rand() < walkers ? 0.25 + rand() * 0.4 : 0));
    const style = gauss(rand);
    const slow = Math.max(-1.5, Math.min(2.5, z));
    const mult = legs.map((_, k) => {
      const pos = legs.length === 1 ? 0 : k / (legs.length - 1);
      return 1 + (-0.04 - 0.015 * slow - 0.02 * style) * (1 - pos) + (0.02 * style + 0.01 * slow) * pos + gauss(rand) * 0.02;
    });
    const raw = legs.map((l, k) => l * terrain[k] * mult[k]);
    const tot = raw.reduce((a, b) => a + b, 0);
    const mats = [];
    let acc = 0;
    for (let k = 0; k < raw.length - 1; k++) {
      acc += (raw[k] / tot) * F;
      mats.push(acc);
    }
    runners.push({ bib: String(100 + i), mats, finish: F, dnf: rand() < 0.03, seen: course.d.map(() => rand() > 0.02) });
  }
  return runners;
}
/** A runner as the check sees it at time T: the passes the mats read, counted in order, and the finish once it is in. */
function checkRunner(r, T, n) {
  const ts = r.mats.filter((t, k) => r.seen[k] && t <= T);
  const passes = ts.slice(0, n).map((t, col) => ({ t: Math.round(t * S), col }));
  const real = new Array(n).fill(null);
  for (const p of passes) real[p.col] = p.t;
  return { bib: r.bib, passes, real, finish: !r.dnf && r.finish <= T ? Math.round(r.finish * S) : null };
}
const truthOf = (r) => r.seen.flatMap((x, k) => (x ? [k] : []));

// ---- the column check, pure (src/review.js) --------------------------------------------------------------------------

test('column check on synthetic races: complete runners never flagged; dropped splits found and placed right; live flags rare', () => {
  const st = { complete: 0, completeFlagged: 0, legit: 0, legitFinal: 0, legitLive: 0, legitLiveLone: 0, dropped: 0, lastDrops: 0, lastFlagged: 0,
    found: 0, right: 0, wrong: 0, liveRight: 0, liveWrong: 0, onCourseCases: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed * 7919);
    const course = COURSES[seed % COURSES.length];
    const n = course.d.length;
    const race = makeRace(seed, course, 30 + Math.floor(rand() * 200));
    const end = Math.max(...race.map((r) => r.finish)) + 60;
    const liveFlag = new Set();
    const loneFlag = new Set();
    for (let T = 60; T <= end; T += 30) {
      const runners = race.map((r) => checkRunner(r, T, n));
      const { suspects } = columnCheck({ n, runners });
      runners.forEach((cr, i) => {
        const r = race[i];
        const sus = suspects.get(r.bib);
        if (cr.passes.length === n) {
          st.complete++;
          if (sus) st.completeFlagged++;
        }
        if (!sus) return;
        const truth = truthOf(r);
        if (r.seen.every(Boolean)) {
          liveFlag.add(r.bib);
          if (cr.passes.length === 1) loneFlag.add(r.bib);
        } else if (cr.finish === null && r.seen.filter((x) => !x).length === 1) {
          if (sus.cols.every((c, j) => c === truth[j])) st.liveRight++;
          else st.liveWrong++;
        }
      });
    }
    const runners = race.map((r) => checkRunner(r, Infinity, n));
    const { suspects } = columnCheck({ n, runners });
    race.forEach((r, i) => {
      const misses = r.seen.filter((x) => !x).length;
      if (misses === 0) {
        st.legit++;
        if (suspects.has(r.bib)) st.legitFinal++;
        if (liveFlag.has(r.bib)) st.legitLive++;
        if (loneFlag.has(r.bib)) st.legitLiveLone++;
        return;
      }
      if (misses !== 1 || runners[i].finish === null) return;
      const truth = truthOf(r);
      if (!r.seen[n - 1]) {
        // missed the last mat: counting is right as it is
        st.lastDrops++;
        if (suspects.has(r.bib)) st.lastFlagged++;
        return;
      }
      st.dropped++;
      const sus = suspects.get(r.bib);
      if (!sus) return;
      st.found++;
      if (sus.cols.every((c, j) => c === truth[j])) st.right++;
      else st.wrong++;
    });
  }
  assert.equal(st.completeFlagged, 0, 'a runner with a pass at every split is never suspect');
  assert.equal(st.legitFinal, 0, 'no runner whose every mat read is flagged once the race is over');
  // Revision 10: a lone first pass beyond the field that fits the next split's leaders is held (the next split's pass
  // of a runner who missed the first mat, most likely). In these synthetic fields 4 % are walkers, some of them slower
  // at the first mat than the leaders at the second: those are held for a while, until their next pass lets them go
  // (DESIGN 9.18; on the 10 real FinishLynx races none is). Never a runner with two passes or more.
  assert.ok(st.legitLive / st.legit < 0.015, `live: ${st.legitLive} of ${st.legit} runners with every mat read were flagged for a while`);
  assert.equal(st.legitLive, st.legitLiveLone, 'only a lone first pass of a runner with every mat read is ever held');
  assert.equal(st.lastFlagged, 0, 'a missed last split needs no move');
  assert.equal(st.wrong, 0, 'finishers: every suggestion is the true placing');
  assert.ok(st.found / st.dropped >= 0.98, `finishers: ${st.found} of ${st.dropped} dropped 1K / middle splits found`);
  assert.equal(st.liveWrong, 0, 'on the course: no wrong suggestion');
  assert.ok(st.liveRight > 0.5 * st.dropped, `on the course: ${st.liveRight} snapshots with the right suggestion`);
  assert.ok(st.lastDrops > 5 && st.dropped > 50, JSON.stringify(st));
});

test('revision 10: a runner who missed the first mat is held at their first pass, before it goes out as split 1', () => {
  // Every 4th runner with every mat read, made to miss the first mat, one at a time: the check as it is two seconds
  // after their first pass (the second mat), the field as it is then. Most are held at once with the right column;
  // the few that are not are near the front, where the first split's slow runners are still coming (undecidable).
  let cases = 0;
  let held = 0;
  let wrong = 0;
  const byCourse = new Map();
  for (let seed = 1; seed <= 10; seed++) {
    const rand = rng(seed * 7919);
    const course = COURSES[seed % COURSES.length];
    const n = course.d.length;
    const race = makeRace(seed, course, 30 + Math.floor(rand() * 200));
    race.forEach((r, i) => {
      if (i % 4 || !r.seen.every(Boolean)) return;
      const T = r.mats[1] + 2;
      const runners = race.map((o, j) => (j === i ? checkRunner({ ...o, seen: o.seen.map((_, k) => k !== 0) }, T, n) : checkRunner(o, T, n)));
      const sus = columnCheck({ n, runners }).suspects.get(r.bib);
      cases++;
      const c = byCourse.get(course.name) ?? { cases: 0, held: 0 };
      c.cases++;
      if (sus) {
        if (sus.cols[0] === 1 && sus.lone) {
          held++;
          c.held++;
        } else wrong++;
      }
      byCourse.set(course.name, c);
    });
  }
  assert.equal(wrong, 0, 'never a wrong suggestion');
  assert.ok(held / cases >= 0.85, `${held} of ${cases} held at once (${JSON.stringify([...byCourse])})`);
});

test('9.23 F13 finishPassesIn: the first finishers count before the rest of the field gets there; stray passes after the last split do not', () => {
  const T = (m) => m * 60 * S;
  // 40 runners at the last split, the first 3 of them finished 2:30 later; the race's latest pass is 1:00 after that:
  // the others have not had the time to finish yet
  const lasts = Array.from({ length: 40 }, (_, i) => ({ t: T(18) + i * 10 * S, next: i < 3 ? T(20.5) + i * 10 * S : null }));
  assert.equal(finishPassesIn(lasts, T(21.5)), true);
  // (counting every runner at the last split against it, as before, said no until half of them had finished)
  assert.ok(3 * 2 < lasts.length);
  // a splits-only stream: 3 runners passed a mat again soon after it (a cool-down), the 30 who got there more than
  // twice that long ago did not
  const stray = Array.from({ length: 33 }, (_, i) => ({ t: T(18) + i * 10 * S, next: i < 3 ? T(19) + i * 10 * S : null }));
  assert.equal(finishPassesIn(stray, T(30)), false);
  // fewer than 3: no
  assert.equal(finishPassesIn(lasts.slice(0, 2), T(30)), false);
});

test('9.23 F13 the column check with the finish as a column, the stream carrying the finish pass: a missed mat stays held when the finish pass fills the last split; complete runners never', () => {
  // The RR12 stream of 2026-10-21 carried the finish line (and a cool-down pass for some): a runner who missed a mat
  // had the finish pass counted in the last split, every column full, and the check let them go. With the finish as
  // column n (its leaders and tail from the field's finish passes), the last pass of such a runner may be placed there.
  const st = { complete: 0, completeHeld: 0, liveHeld: 0, liveLone: 0, missed: 0, held: 0, right: 0, last: 0, lastHeld: 0, lastRight: 0, full: 0, fullOut: 0, outBefore: 0, fullLast: 0, fullLastOut: 0 };
  const COURSE7 = { name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 };
  for (let seed = 1; seed <= 30; seed++) {
    const rand = rng(seed * 7919);
    const course = seed % 6 === 5 ? COURSE7 : COURSES[seed % COURSES.length];
    const n = course.d.length;
    const race = makeRace(seed, course, 30 + Math.floor(rand() * 200));
    // one in ten runners misses one mat, one in four passes the finish line again (a cool-down)
    for (const r of race) {
      r.seen = course.d.map(() => true);
      if (rand() < 0.1) r.seen[Math.floor(rand() * n)] = false;
      r.cool = rand() < 0.25;
    }
    const stream = (r, T) => {
      const ts = r.mats.filter((t, k) => r.seen[k]);
      if (!r.dnf) ts.push(r.finish, ...(r.cool ? [r.finish + 90] : []));
      const now = ts.filter((t) => t <= T);
      const passes = now.slice(0, n).map((t, col) => ({ t: Math.round(t * S), col }));
      const real = new Array(n).fill(null);
      for (const p of passes) real[p.col] = p.t;
      return { bib: r.bib, passes, real, finish: null, afterLast: now.length > n ? Math.round(now[n] * S) : null };
    };
    const end = Math.max(...race.map((r) => r.finish)) + 200;
    const live = new Set();
    // a runner who missed a mat and is held when the finish pass fills its last column (a missed last mat: the finish
    // pass is its first pass in a wrong column): let go then or at any time after it, its passes go out a column early
    // (what the 2026-10-27 replay showed for the first finishers)
    const full = new Map();
    const heldBefore = new Map();
    for (let T = 60; T <= end; T += 30) {
      const runners = race.map((r) => stream(r, T));
      const { suspects } = columnCheck({ n, runners });
      race.forEach((r, i) => {
        const sus = suspects.get(r.bib);
        if (!r.dnf && r.seen.every(Boolean) && sus && !live.has(r.bib)) {
          live.add(r.bib);
          if (runners[i].passes.length === 1) st.liveLone++;
          assert.ok(sus.moves.every((m) => m.to < n), 'a complete runner is never placed at the finish');
        }
        if (!r.dnf && !r.seen.every(Boolean)) {
          const was = !r.seen[n - 1] || (heldBefore.get(r.bib) ?? false);
          if (runners[i].passes.length >= n) {
            const f = full.get(r.bib);
            if (f === undefined) full.set(r.bib, was ? (sus ? 'held' : 'out') : 'before');
            else if (f === 'held' && !sus) full.set(r.bib, 'out');
          }
          heldBefore.set(r.bib, !!sus);
        }
      });
    }
    st.liveHeld += live.size;
    for (const [bib, f] of full) {
      const lastMat = !race.find((x) => x.bib === bib).seen[n - 1];
      if (f === 'before') st.outBefore++;
      else if (lastMat) st.fullLast++;
      else st.full++;
      if (f === 'out' && lastMat) st.fullLastOut++;
      else if (f === 'out') st.fullOut++;
    }
    const runners = race.map((r) => stream(r, Infinity));
    const { suspects } = columnCheck({ n, runners });
    race.forEach((r) => {
      if (r.dnf) return;
      const sus = suspects.get(r.bib);
      const truth = [...r.seen.flatMap((x, k) => (x ? [k] : [])), n];
      if (r.seen.every(Boolean)) {
        st.complete++;
        if (sus) st.completeHeld++;
      } else if (!r.seen[n - 1]) {
        st.last++;
        if (sus) st.lastHeld++;
        if (sus && sus.cols.every((c, j) => c === truth[j])) st.lastRight++;
      } else {
        st.missed++;
        if (sus) st.held++;
        if (sus && sus.cols.every((c, j) => c === truth[j])) st.right++;
      }
    });
  }
  assert.equal(st.completeHeld, 0, 'a runner whose every mat read is never held once the race is over');
  assert.equal(st.liveHeld, st.liveLone, 'on the course only a lone first pass (revision 10), never the finish column');
  assert.ok(st.held / st.missed > 0.9, `a missed first or middle mat held with the finish pass in the last split: ${st.held} of ${st.missed}`);
  assert.ok(st.right / st.held > 0.98, `with the right placing: ${st.right} of ${st.held}`);
  assert.ok(st.lastHeld / st.last > 0.85 && st.lastRight === st.lastHeld, `a missed last split: the finish pass held there, to the finish: ${st.lastHeld} (${st.lastRight} right) of ${st.last}`);
  assert.ok(st.missed > 100 && st.last > 20 && st.complete > 2000, JSON.stringify(st));
  // held when the finish pass came (whatever the place: the first finishers too, once 3 runners have finished) and kept
  // held from then on; before the time-aware test of finishPassesIn 113 of 239 and 90 of 164 went out
  assert.ok(st.full > 100 && st.fullOut <= st.full * 0.03, `a missed first or middle mat held when the finish pass filled the last split, let go after it: ${st.fullOut} of ${st.full}`);
  assert.ok(st.fullLast > 100 && st.fullLastOut <= st.fullLast * 0.1, `a missed last mat: the finish pass let out: ${st.fullLastOut} of ${st.fullLast}`);
  console.log(`finish column synthetic: ${JSON.stringify(st)}`);
  // a stream of splits only (no finish passes) changes nothing: the finish pass is not there to place
  const race = makeRace(3, COURSE7, 120);
  const plain = race.map((r) => checkRunner({ ...r, seen: r.seen.map(() => true) }, Infinity, 7));
  assert.equal(finishColumn(plain, 7), null);
});

test('column check by hand: a dropped 1K, a middle split and the last split, for finishers and on the course', () => {
  const n = 4;
  // 20 runners, 1K splits of a 5K, 3:00/km for the first, 2 % slower each; finish = 5 legs
  const base = Array.from({ length: 20 }, (_, i) => {
    const p = 180 * (1 + 0.02 * i);
    return { bib: String(i + 1), times: [1, 2, 3, 4].map((k) => Math.round(p * k * S)), finish: Math.round(p * 5 * S) };
  });
  const asRunner = (b, cols, { finish = true, upTo = Infinity } = {}) => {
    const ts = cols.map((k) => b.times[k]).filter((t) => t <= upTo);
    const passes = ts.map((t, col) => ({ t, col }));
    const real = new Array(n).fill(null);
    for (const p of passes) real[p.col] = p.t;
    return { bib: b.bib, passes, real, finish: finish ? b.finish : null };
  };
  const all = [0, 1, 2, 3];
  const run = (special, opts) => columnCheck({ n, runners: base.map((b) => (special[b.bib] ? asRunner(b, special[b.bib], opts) : asRunner(b, all, opts))) });
  // finishers
  let { suspects, fractions } = run({ 5: [1, 2, 3], 8: [0, 1, 3], 11: [0, 1, 2] });
  assert.deepEqual(fractions.map((f) => Math.round(f * 100)), [20, 40, 60, 80]);
  assert.deepEqual(suspects.get('5').cols, [1, 2, 3], 'missed 1K: every pass one column on');
  assert.deepEqual(suspects.get('5').moves.map((m) => moveText(m, ['1K', '2K', '3K', '4K'])),
    ['Looks like 2K, not 1K (missed 1K?)', 'Looks like 3K, not 2K (it moves with the pass before it)', 'Looks like 4K, not 3K (it moves with the pass before it)']);
  assert.deepEqual(suspects.get('8').cols, [0, 1, 3], 'missed 3K: the 4K pass is 4K');
  assert.deepEqual(suspects.get('8').moves.map((m) => [m.from, m.to, m.missed]), [[2, 3, [2]]]);
  assert.equal(suspects.has('11'), false, 'missed 4K: counting is right');
  assert.equal(suspects.size, 2);
  // on the course, the leaders past 3K: bib 5 missed 1K and has passed 2K and 3K
  ({ suspects } = run({ 5: [1, 2] }, { finish: false, upTo: Math.round(600 * S) }));
  assert.deepEqual(suspects.get('5')?.cols, [1, 2], 'on the course: two passes of the same pace say it');
  assert.equal(suspects.get('5').method, 'course');
  for (const [bib] of suspects) assert.equal(bib, '5', `only the runner who missed a mat (${bib})`);
});

test('column check by hand: walkers, a lone first pass, pinned and made-up passes, timing points, earliest times', () => {
  const n = 4;
  const L = [180, 360, 540, 720].map((t) => t * S);
  // a dense field at the leaders' pace .. 1.2 x, every split
  const fieldRunners = Array.from({ length: 21 }, (_, i) => {
    const r = 1 + 0.01 * i;
    const real = L.map((t) => Math.round(t * r));
    return { bib: String(i + 1), passes: real.map((t, col) => ({ t, col })), real, finish: null };
  });
  const one = (bib, ts, extra = {}) => {
    const passes = ts.map((t, col) => ({ t: Math.round(t * S), col, ...(extra.pass?.(col) ?? {}) }));
    const real = new Array(n).fill(null);
    for (const p of passes) if (!p.manual) real[p.col] = p.t;
    return { bib, passes, real, finish: null, ...extra.runner };
  };
  const check = (...extra) => columnCheck({ n, runners: [...fieldRunners, ...extra] }).suspects;
  // a walker at twice the leaders' time, every pass consistent: never moved (two missed mats would be needed)
  assert.equal(check(one('w', [360, 720])).has('w'), false);
  // one pass so far, behind the field at 1K but not far: could well be a slow 1K pass (one pass has no evenness to
  // compare, so only a pass well beyond the field is doubted: singleGap)
  assert.equal(check(one('a', [180 * 1.6])).has('a'), false);
  // revision 10: right with the 2K leaders and beyond the end of the 1K field (1.2 x 1.15): the 2K pass of a leader
  // who missed 1K, held before it goes out as 1K; the runner's next pass (or finish) settles it
  const a2 = check(one('a2', [360 * 1.02])).get('a2');
  assert.deepEqual([a2?.cols, a2?.lone], [[1], true]);
  // ...but a 1K field that reaches (nearly) the 2K leaders' time leaves it undecidable: plausible as either split
  const slowTail = Array.from({ length: 12 }, (_, i) => one(`t${i}`, [180 * (1.25 + 0.06 * i)]));
  assert.equal(check(...slowTail.slice(0, 11), one('a3', [360 * 1.02])).has('a3'), false, 'a 1K field to 1.85 x: a pass at 2.0 x may be a slow 1K');
  for (const t of slowTail) assert.equal(check(...slowTail).has(t.bib), false, `the slow 1K runners themselves (${t.bib})`);
  // several runners who missed 1K don't make each other "the back of the 1K field": lone passes that fit the 2K leaders
  // are no evidence of where the 1K field ends. With the slow 1K tail (to 1.81 x), the first (2.0 x) is undecidable;
  // the others, each within 15 % of the one before, would have stretched "the 1K field" on and on
  const missed = [2.0, 2.2, 2.35, 2.5].map((x, i) => one(`m${i}`, [Math.round(183.6 * x * 10) / 10]));
  const sm = check(...slowTail.slice(0, 11), ...missed);
  assert.equal(sm.has('m0'), false, 'plausible as a slow 1K pass');
  for (const m of missed.slice(1)) assert.deepEqual([sm.get(m.bib)?.cols, sm.get(m.bib)?.lone], [[1], true], `missed 1K, ${m.bib}`);
  for (const t of slowTail.slice(0, 11)) assert.equal(sm.has(t.bib), false, `a slow 1K runner (${t.bib}) is not moved`);
  // one pass far beyond everybody at 1K, with the 2K field: the 2K pass of a runner who missed 1K
  assert.deepEqual(check(one('b', [400])).get('b')?.cols, [1]);
  // ...unless the operator kept it (pinned), or the runner has a timing-point crossing
  assert.equal(check(one('c', [400], { pass: () => ({ pinned: true }) })).has('c'), false);
  assert.equal(check(one('d', [400], { runner: { located: true } })).has('d'), false);
  // an earliest time for 2K of 7:00 rules 2K out for a pass at 6:40 (and 3K, nobody's there yet)
  assert.equal(columnCheck({ n, runners: [...fieldRunners, one('e', [400])], earliest: [null, 420 * S, null, null] }).suspects.has('e'), false);
  // a made-up time is a fixed point: a runner with a made-up 1K and a 2K pass is not moved past it
  const m = one('f', [181, 400], { pass: (col) => (col === 0 ? { manual: true, pinned: true } : {}) });
  assert.equal(check(m).has('f'), false);
  // a split nobody has reached can't be given a pass
  const early = fieldRunners.map((r) => ({ ...r, passes: r.passes.slice(0, 1), real: [r.real[0], null, null, null] }));
  assert.equal(columnCheck({ n, runners: [...early, one('g', [400])] }).suspects.has('g'), false);
  // the field references
  assert.deepEqual(leaderTimes(fieldRunners, n), [Math.round(180 * 1.02 * S), Math.round(360 * 1.02 * S), Math.round(540 * 1.02 * S), Math.round(720 * 1.02 * S)]);
  assert.equal(fieldFractions(fieldRunners, n), null, 'nobody has finished: no field fractions');
  assert.deepEqual(Object.keys(CHECK_RULES), ['minComplete', 'leaders', 'tailGap', 'floor', 'legMargin', 'spreadMargin', 'spreadSlack', 'singleGap', 'nearest', 'shapeMargin', 'shapeLegs', 'shapeWithin',
    'shapeClose', 'shapeCloseLeg', 'shapePlacings', 'shapeGap', 'lateMax', 'legFloor', 'strayLeg', 'strayOwn', 'slowLeg', 'slowLost', 'leaderFloor', 'farSpread']);
});

test('src/check-lif.js measures the check on a FinishLynx .lif file: every split taken out in turn is placed right', () => {
  for (const [i, course] of COURSES.entries()) {
    const race = makeRace(500 + i, course, 120).filter((r) => !r.dnf).sort((a, b) => a.finish - b.finish);
    const rows = race.map((r, p) => {
      const ts = r.mats.filter((_, k) => r.seen[k]).map((t) => Math.round(t * S));
      const fin = Math.round(r.finish * S);
      let prev = 0;
      const entries = [...ts, fin].map((t) => {
        const e = `${formatRaceTime(t, 3)} (${formatRaceTime(t - prev, 3)})`;
        prev = t;
        return e;
      });
      // FinishLynx lists only the mats that read the runner; names are placeholders
      return `${p + 1},${r.bib},,Runner,Test,Team,${formatRaceTime(fin, 3)},M,,,"${entries.join(',')}",10:00:00.000,,,,,,,`;
    });
    const text = [`${i + 1},1,1,Test ${i + 1},,,,,,,10:00:00.0000`, ...rows, ''].join('\r\n');
    const m = measureLif(text, { liveStepSec: 60 });
    assert.equal(m.n, course.d.length);
    assert.equal(m.flaggedComplete, 0, course.name);
    assert.equal(m.drop.wrong, 0, `${course.name}: no wrong placing`);
    assert.ok(m.drop.right / m.drop.cases >= 0.98, `${course.name}: ${m.drop.right} of ${m.drop.cases}`);
    assert.equal(m.drop.lastFlagged, 0, `${course.name}: a missed last split needs no move`);
    assert.ok(m.live.flaggedComplete <= 2, `${course.name}: ${m.live.flaggedComplete} flagged for a while`);
    // the incomplete runners it flags: missed a mat that is not the last
    for (const f of m.flagged) {
      const r = race.find((x) => x.bib === f.bib);
      assert.deepEqual(f.suggested, truthOf(r).map((c) => c + 1), `${course.name} bib ${f.bib}`);
    }
  }
  const { n, runners } = lifFinishers('1,1,1,X,,,,,,,10:00:00.0000\r\n1,7,,A,B,C,9:00.000,M,,,"3:00.000 (3:00.000),6:00.000 (3:00.000),9:00.000 (3:00.000)",,,,,,,,\r\nDNF,8,,A,B,C,,M,,,,,,,,,,,\r\n');
  assert.deepEqual([n, runners], [2, [{ bib: '7', times: [rt('3:00'), rt('6:00')], finish: rt('9:00') }]]);
});

// ---- made-up times, pure (src/review.js estimateGaps) ----------------------------------------------------------------

test('estimates: the stretch between two references, placed like the runners nearest in pace; gun, finish, runs, fallbacks', () => {
  const n = 4;
  const names = ['1K', '2K', '3K', '4K'];
  // 40 runners; runner i: splits at fractions 0.2/0.41/0.6/0.8 of its finish, the slow ones a bit later at 2K
  const others = Array.from({ length: 40 }, (_, i) => {
    const F = (900 + 10 * i) * S;
    const f2 = i < 20 ? 0.40 : 0.42;
    return { bib: String(i + 1), real: [0.2, f2, 0.6, 0.8].map((f) => Math.round(f * F)), finish: F };
  });
  const me = (kept, finish = null) => ({ n, names, kept, finish, others });
  // a fast runner (F 900 s) missing 2K: the 30 nearest in pace are the faster half and ten of the others
  let [e] = estimateGaps(me([180 * S, null, 540 * S, 720 * S], 900 * S));
  assert.equal(e.col, 1);
  assert.equal(e.method, 'nearest');
  assert.equal(e.count, 30);
  assert.equal(e.frac, 0.5, 'the median of 20 runners at 0.5 and 10 at 0.55');
  assert.equal(e.estimate, 360 * S);
  assert.equal(e.basis, 'From 1K 3:00.0 and 3K 9:00.0, placed like the 30 runners nearest in pace (2K at 50.0% of that stretch).');
  assert.deepEqual([e.prev, e.next], [{ kind: 'split', col: 0, t: 180 * S }, { kind: 'split', col: 2, t: 540 * S }]);
  // a slow runner (F 1290 s): its 30 nearest are the slower ones
  [e] = estimateGaps(me([258 * S, null, 774 * S, 1032 * S], 1290 * S));
  assert.equal(Math.round(e.frac * 1000), 550);
  // missing 1K: the gun is the earlier reference
  [e] = estimateGaps(me([null, 369 * S, 540 * S, 720 * S], 900 * S));
  assert.equal(e.basis.slice(0, 33), 'From the gun and 2K 6:09.0, place');
  assert.equal(e.prev.kind, 'gun');
  // missing 4K: the finish is the later reference
  [e] = estimateGaps(me([180 * S, 369 * S, 540 * S, null], 900 * S));
  assert.equal(e.next.kind, 'finish');
  assert.match(e.basis, /^From 3K 9:00\.0 and the finish 15:00\.0, placed like the 30 runners nearest in pace \(4K at 50\.0% of that stretch\)\.$/);
  // two in a row: estimated together, in order, from the same references
  const two = estimateGaps(me([180 * S, null, null, 720 * S], 900 * S));
  assert.deepEqual(two.map((x) => x.col), [1, 2]);
  assert.ok(two[0].estimate > 180 * S && two[0].estimate < two[1].estimate && two[1].estimate < 720 * S);
  assert.deepEqual(two.map((x) => x.prev.col), [0, 0]);
  // still on the course after 2K: 3K and 4K are not missing yet
  const waiting = estimateGaps(me([180 * S, 369 * S, null, null]));
  assert.deepEqual(waiting.map((x) => [x.col, x.estimate, x.basis]), [[2, null, 'Waiting for a later split or the finish.'], [3, null, 'Waiting for a later split or the finish.']]);
  // nobody has 1K, 2K and 3K together, but some have 1K, 2K and 4K... fall back to the runners with that split
  const partial = others.map((o, i) => ({ ...o, real: i % 2 ? [o.real[0], o.real[1], null, o.real[3]] : [o.real[0], null, o.real[2], o.real[3]] }));
  const pair = estimateGaps({ n, names, kept: [180 * S, null, null, 720 * S], finish: 900 * S, others: partial });
  assert.deepEqual(pair.map((x) => x.method), ['column', 'column']);
  // nobody at all: evenly spaced
  [e] = estimateGaps({ n, names, kept: [180 * S, null, 540 * S, 720 * S], finish: 900 * S, others: [] });
  assert.deepEqual([e.method, e.estimate], ['even', 360 * S]);
  // (9.23 F13: what is missing is a runner with times at both ends and in it, not "a time there")
  assert.equal(e.basis, 'From 1K 3:00.0 and 3K 9:00.0, evenly spaced: no other runner has times at both of them and at 2K yet (2K at 50.0% of that stretch).');
  // to the millisecond, strictly inside the stretch
  [e] = estimateGaps({ n, names, kept: [1800001, null, 1800051, null], finish: null, others: [] });
  assert.equal(e.estimate % 10, 0);
  assert.ok(e.estimate > 1800001 && e.estimate < 1800051);
});

// ---- P1: pause and play a split --------------------------------------------------------------------------------------

test('P1 pause and play: a paused split is kept and shown, not sent and not in the .lif; play sends what it held', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(2) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const sp = s.config.races[0].splits;
  sp[0].sending = false;
  s.engine.configChanged();
  const a = s.lap(1, '3:00');
  s.lap(2, '3:05');
  s.lap(3, '3:10');
  s.clock.advance(5000);
  assert.deepEqual(s.sends, [], 'nothing goes out from a paused split');
  assert.deepEqual([s.row(a).status, s.row(a).detail, s.row(a).place], ['split-paused', '1K is paused: kept, not sent. Press play on 1K to send it.', 1]);
  let v = s.engine.raceView('r');
  assert.deepEqual(v.splits.map((x) => [x.name, x.sending, x.crossings, x.held]), [['1K', false, 3, 3], ['2K', true, 0, 0]]);
  assert.deepEqual(s.engine.raceData('r').runners.size, 0, 'and not in the merged .lif');
  assert.deepEqual(s.engine.crossings('r').map((c) => [c.bib, c.place, c.held, c.sentAt]), [['1', 1, 'paused', null], ['2', 2, 'paused', null], ['3', 3, 'paused', null]]);
  assert.equal(s.engine.resendRace('r').sent, 0, 'a Resend does not send a paused split either');
  // the other split is not affected; its leg is from the gun (the 1K it follows is not out)
  s.lap(1, '6:10');
  s.clock.advance(3000);
  assert.deepEqual(s.sends.map((p) => [p.bib, p.splitName, p.lsTicks]), [['1', '2K', rt('6:10')]]);
  // bib 3 finishes while 1K is paused
  s.lynx.set('3', rt('15:00'));
  s.places.set('3', 1);
  s.engine.converge();
  // play: what it held goes out (the finisher's not: TrackScore keeps the finish place) and the .lif gets it
  sp[0].sending = true;
  s.engine.configChanged();
  s.clock.advance(100);
  // (9.23 F13: bib 1's 2K went out before its 1K, so its 2K goes again last: TrackScore shows the 2K place)
  assert.deepEqual(s.sends.slice(1).map((p) => [p.bib, p.splitName, p.place, p.reason]), [['1', '1K', 1, 'new'], ['2', '1K', 2, 'new'], ['1', '2K', 1, 'place-update']]);
  assert.equal(s.row(a).status, 'sent');
  v = s.engine.raceView('r');
  assert.deepEqual([v.splits[0].sending, v.splits[0].held, v.finishedNotSent], [true, 0, 1]);
  assert.deepEqual([...s.engine.raceData('r').runners.keys()].sort(), ['1', '2', '3']);
  const fin = s.engine.review('r').finishedNotSent;
  assert.deepEqual(fin.map((x) => [x.bib, x.splitName, x.finishPlace, x.sendable]), [['3', '1K', 1, true]]);
  // a queued packet whose split is paused before the output takes it is not written
  s.net.hold.add('o1');
  s.lap(4, '3:20');
  s.clock.advance(3000);
  assert.equal(s.net.queued.length, 1);
  sp[0].sending = false;
  s.engine.configChanged();
  const before = s.sends.length;
  s.net.flush('o1');
  assert.equal(s.sends.length, before, 'paused while it waited in the queue: not written');
  s.net.hold.delete('o1');
  sp[0].sending = true;
  s.engine.configChanged();
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(before).map((p) => [p.bib, p.splitName]), [['4', '1K']]);
  // a restart keeps all of it
  const t = s.restart();
  t.clock.advance(70_000);
  assert.equal(t.sends.length, s.sends.length, 'nothing again after a clean restart');
});

// ---- P2: the column check in the engine ------------------------------------------------------------------------------

test('P2 the column check holds a pass that looks like another split, keeps it out of the places, and Move or Keep decides', () => {
  const s = setup();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // 12 runners, all four splits; bib 105 missed 2K
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  const v = s.engine.raceView('r');
  // (9.23: the counts gained flagged, pinned and madeUp; a suspect is the column check's, never flagged)
  assert.deepEqual(v.review, { missing: 0, estimable: 0, checks: 2, checkRunners: 1, manual: 0, flagged: 0, pinned: 0, madeUp: 0 });
  const r = s.engine.review('r');
  assert.deepEqual(r.checks.map((c) => [c.bib, c.fromName, c.toName, c.reason, c.raceTicks, c.delivered]), [
    ['105', '2K', '3K', 'Looks like 3K, not 2K (missed 2K?)', timeOf(105, 3), false],
    ['105', '3K', '4K', 'Looks like 4K, not 3K (it moves with the pass before it)', timeOf(105, 4), false],
  ]);
  assert.deepEqual(sentOf(s, 105), [['1K', timeOf(105, 1), 6, 'new']], 'only the pass that stays is sent');
  // the held pass is not counted for the places of the others at 2K
  const at2 = s.engine.crossings('r').filter((c) => c.splitId === 's2');
  assert.deepEqual(at2.map((c) => [c.bib, c.place, c.held]).slice(-2), [['111', 11, null], ['105', 12, 'check']]);
  assert.equal(s.sends.find((p) => p.bib === '111' && p.splitName === '2K').place, 11);
  assert.equal(s.engine.raceData('r').runners.get('105').splits.filter((x) => x !== null).length, 1, 'held passes are not in the .lif');
  const feedRow = s.engine.feed(1000).find((e) => e.bib === '105' && e.raceTicks === timeOf(105, 3));
  assert.deepEqual([feedRow.status, feedRow.detail], ['check-column', 'Looks like 3K, not 2K (missed 2K?) — check it in Review.']);
  // the runner view says the same
  const rv = s.engine.runner('r', '105');
  assert.deepEqual(rv.passes.map((p) => [p.timeText, p.splitName, p.how, p.suggestion?.splitName ?? null]),
    [['3:18.0', '1K', 'counted', null], ['9:54.0', '2K', 'counted', '3K'], ['13:12.0', '3K', 'counted', '4K']]);
  assert.equal(rv.suspect, true);
  assert.deepEqual(rv.columns.map((c) => [c.splitName, c.held, c.canAdd]), [['1K', null, false], ['2K', 'check', false], ['3K', 'check', false], ['4K', null, false]]);
  // (9.23 F20: which pass, and the way on: the re-check of 2026-10-30 found "a pass of this runner looks like another
  // split's" with nothing to go on)
  assert.equal(rv.columns[3].why, `Check bib 105's 3K first: 13:12.0 is held (it looks like 4K). Choose "It's right: keep it in 3K" or Move it in its menu; then 4K can be filled.`);
  // a Move that breaks course order is refused in words
  assert.throws(() => s.engine.assign('r', { bib: '105', tod: rv.passes[2].tod, splitId: 's1' }), (err) => err.status === 409 &&
    /^The pass at 13:12\.0 can't be 1K: 2 earlier passes need the splits before it\.$/.test(err.message));
  // Move all: both passes go where the check said, are sent, and are pinned there
  // (9.23: the answer also has the change, for the panel's Undo)
  const moved = s.engine.assign('r', { bib: '105', all: 'move' });
  assert.equal(moved.assigned, 2);
  assert.deepEqual([moved.change.kind, moved.change.text, moved.change.undoable], ['check', '9:54.0 moved to 3K, 13:12.0 moved to 4K', true]);
  s.clock.advance(3000);
  assert.deepEqual(sentOf(s, 105).slice(1).map((x) => x.slice(0, 2)), [['3K', timeOf(105, 3)], ['4K', timeOf(105, 4)]]);
  assert.deepEqual(s.engine.review('r').checks, []);
  assert.deepEqual(s.engine.runner('r', '105').passes.map((p) => [p.splitName, p.how, p.pinned]), [['1K', 'counted', null], ['3K', 'moved', 'move'], ['4K', 'moved', 'move']]);
  assert.deepEqual(s.store.journal.map((l) => JSON.parse(l)).filter((x) => x.t === 'assign').map((x) => [x.bib, x.tod, x.splitId]),
    [['105', parseTod('10:00:00') + timeOf(105, 3), 's3'], ['105', parseTod('10:00:00') + timeOf(105, 4), 's4']]);
  // now the 2K is missing, with an estimate
  const miss = s.engine.review('r').missing;
  assert.deepEqual(miss.map((m) => [m.bib, m.splitName, m.prev.splitName, m.next.splitName, m.sendable]), [['105', '2K', '1K', '3K', true]]);
  // a restart replays the Moves
  const t = s.restart();
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => c.time), [timeOf(105, 1), null, timeOf(105, 3), timeOf(105, 4)]);
  assert.deepEqual(t.engine.review('r').checks, []);
});

test('P2 Keep: the operator says counting is right; the pass is sent where it was counted and never asked about again', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  const tods = s.engine.review('r').checks.map((c) => c.passTod);
  assert.equal(s.engine.assign('r', { bib: '105', tod: tods[0], splitId: null }).assigned, 1);
  s.clock.advance(3000);
  // keeping the first lets the second be judged with it fixed: it is consistent again
  assert.deepEqual(s.engine.review('r').checks, []);
  assert.deepEqual(sentOf(s, 105).map((x) => x[0]), ['1K', '2K', '3K']);
  assert.equal(s.engine.runner('r', '105').passes[1].how, 'kept');
  const t = s.restart();
  assert.deepEqual(t.engine.review('r').checks, []);
  assert.throws(() => s.engine.assign('r', { bib: '105', all: 'move' }), (err) => err.status === 409 && /Nothing to check for bib 105 any more/.test(err.message));
  assert.throws(() => s.engine.assign('r', { bib: '999', tod: 1, splitId: null }), (err) => err.status === 404 && /^Bib 999 has no passes in Boys 5K\.$/.test(err.message));
  assert.throws(() => s.engine.assign('r', { bib: '105', tod: 1, splitId: null }), (err) => err.status === 404 && /no pass at that time/.test(err.message));
});

test('P2 finishers: once FinishLynx has the finish, the field fractions place a runner who missed 1K', () => {
  const s = setup();
  // the field is done; bib 105 missed 1K. FinishLynx finished them all.
  field(s, { skip: { 105: [1] } });
  for (let i = 0; i < 12; i++) {
    s.lynx.set(String(100 + i), Math.round(900 * (1 + 0.02 * i) * S));
    s.places.set(String(100 + i), i + 1);
  }
  s.engine.converge();
  s.clock.advance(3000);
  const c = s.engine.review('r').checks;
  assert.deepEqual(c.map((x) => [x.fromName, x.toName, x.method]), [['1K', '2K', 'finish'], ['2K', '3K', 'finish'], ['3K', '4K', 'finish']]);
  assert.equal(c[0].reason, 'Looks like 2K, not 1K (missed 1K?)');
  assert.deepEqual(sentOf(s, 105), [], 'a finisher gets nothing live anyway');
});

// ---- P3: missing splits and made-up times ----------------------------------------------------------------------------

test('P3 a made-up time: estimate, approve, sent and in the .lif, ranked with the real ones; typed; removed; replaced by a real read', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // bib 105 missed 2K; its 3K pass came, so counting put it in 2K: Move it first (the check holds it)
  field(s, { splits: 3, skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.clock.advance(3000);
  let miss = s.engine.review('r').missing;
  assert.equal(miss.length, 1);
  const m = miss[0];
  assert.deepEqual([m.bib, m.splitId, m.prev.raceTicks, m.next.raceTicks, m.finished, m.sendable, m.why],
    ['105', 's2', timeOf(105, 1), timeOf(105, 3), false, true, null]);
  assert.equal(m.estimate, Math.round((timeOf(105, 1) + timeOf(105, 3)) / 20) * 10);
  assert.equal(m.estimateText, '6:36.000');
  assert.equal(m.basis, 'From 1K 3:18.0 and 3K 9:54.0, placed like the 11 runners nearest in pace (2K at 50.0% of that stretch).');
  assert.deepEqual(s.engine.raceView('r').review, { missing: 1, estimable: 1, checks: 0, checkRunners: 0, manual: 0, flagged: 0, pinned: 1, madeUp: 0 });
  // approve the estimate
  const before = s.sends.length;
  const res = s.engine.addManual('r', { bib: '105', splitId: 's2' });
  assert.deepEqual(res.skipped, []);
  assert.deepEqual([res.added[0].source, res.added[0].estimated, res.added[0].timeText, res.added[0].sent, res.added[0].place],
    ['made-up', true, '6:36.0', true, 6]);
  // 9.23 F4: then the runner's furthest split again, as a place update: TrackScore takes the runner's place from every
  // packet, so the boards show bib 105 at its 3K place, not its 2K place
  assert.deepEqual(s.sends.slice(before).filter((p) => p.bib === '105').map((p) => [p.splitName, p.csTicks, p.place, p.reason]),
    [['2K', m.estimate, 6, 'new'], ['3K', timeOf(105, 3), 6, 'place-update']], 'sent at once (the operator approved it), placed among the real 2K times: no hold for a backup read');
  // the runners behind it move down a place, as for a real read; 9.23 F13: each then gets its furthest split (3K) again
  // last, so TrackScore keeps showing its 3K place, not its 2K one
  const behind = ['106', '107', '108', '109', '110', '111'];
  assert.deepEqual(s.sends.slice(before).filter((p) => p.bib !== '105').map((p) => [p.bib, p.splitName, p.place, p.reason]),
    [...behind.map((b, i) => [b, '2K', 7 + i, 'place-update']), ...behind.map((b, i) => [b, '3K', 7 + i, 'place-update'])]);
  assert.equal(s.engine.raceData('r').runners.get('105').splits[1], m.estimate, 'in the merged .lif');
  assert.deepEqual(s.engine.crossings('r').find((c) => c.bib === '105' && c.splitId === 's2').source, 'made-up');
  const feedRow = s.engine.feed(5)[0];
  assert.deepEqual([feedRow.status, feedRow.bib, feedRow.splitName, feedRow.raceTicks], ['made-up', '105', '2K', m.estimate]);
  assert.match(feedRow.detail, /^Made-up time, approved in Review: Sent as place 6\. It is in the merged \.lif\. From 1K/);
  assert.deepEqual(s.engine.raceView('r').review, { missing: 0, estimable: 0, checks: 0, checkRunners: 0, manual: 1, flagged: 0, pinned: 1, madeUp: 1 });
  const rec = s.store.journal.map((l) => JSON.parse(l)).find((x) => x.t === 'manual');
  assert.deepEqual([rec.raceId, rec.bib, rec.splitId, rec.raceTicks, rec.estimated, rec.basis], ['r', '105', 's2', m.estimate, true, m.basis]);
  // a restart has it, and does not send it again
  let t = s.restart();
  t.clock.advance(70_000);
  assert.equal(t.sends.length, s.sends.length);
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => c.source), ['read', 'made-up', 'read']);
  // typed: another time replaces the made-up one
  t.engine.addManual('r', { bib: '105', splitId: 's2', time: '6:50' });
  assert.deepEqual(t.engine.runner('r', '105').columns[1].source, 'typed');
  // the operator approved it now: it goes out, though the first copy went out more than a minute ago
  // (9.23 F4: then the runner's furthest split as a place update)
  assert.deepEqual(sentOf(t, 105).slice(-2), [['2K', rt('6:50'), 7, 'correction'], ['3K', timeOf(105, 3), 6, 'place-update']]);
  // take it back: what was sent stays in TrackScore, and the answer says so
  const gone = t.engine.removeManual('r', { bib: '105', splitId: 's2' });
  assert.equal(gone.wasSent, true);
  assert.match(gone.note, /^The typed 2K time \(6:50\.0\) was already sent\. Split Relay can't remove it from TrackScore/);
  assert.equal(t.engine.raceData('r').runners.get('105').splits[1], null);
  assert.equal(t.engine.review('r').missing.length, 1, 'missing again');
  // made up again, then the real read of the mat comes late: it takes the made-up time's place. TrackScore got its
  // first 2K time for bib 105 more than a minute ago, but the operator put the made-up time in that cell just now: the
  // cell's minute starts again then (9.23 F4), so the real time goes out as a correction by itself, and the runner's
  // furthest split after it (TrackScore takes the runner's place from the newest packet)
  t.engine.addManual('r', { bib: '105', splitId: 's2' });
  t.clock.advance(1000);
  let at = t.sends.length;
  const late = t.lap(105, raceTimeText(timeOf(105, 2) / S + 3)); // 3 s after the estimate
  t.clock.advance(3000);
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => [c.source, c.time]),
    [['read', timeOf(105, 1)], ['read', timeOf(105, 2) + 3 * S], ['read', timeOf(105, 3)]]);
  assert.deepEqual(t.sends.slice(at).filter((p) => p.bib === '105').map((p) => [p.splitName, p.csTicks, p.reason]),
    [['2K', timeOf(105, 2) + 3 * S, 'correction'], ['3K', timeOf(105, 3), 'place-update']]);
  assert.match(t.row(late).detail, /^Real read replaced the made-up time \(3 s later\): re-sent as place \d+ with the real time\.$/);
  assert.equal(t.row(late).status, 'corrected');
  assert.equal(t.engine.review('r').manual[0].state, 'replaced');
  assert.equal(t.engine.raceView('r').stale.count, 0);
  // 9.23 F13: a real read that comes more than a minute after the made-up time went out goes out by itself too (before,
  // it waited for a Resend): the 2K with the real time, then 3K (its leg, and the runner's furthest split) last. The
  // two runners it is behind now at 2K only changed place, after their minute: they wait for Resend
  t.engine.removeManual('r', { bib: '105', splitId: 's2' });
  t.engine.movePass('r', '105', { tod: t.engine.runner('r', '105').passes[1].tod, to: 'none' });
  t.engine.addManual('r', { bib: '105', splitId: 's2' });
  t.clock.advance(70_000);
  at = t.sends.length;
  // (beyond the tag window of the pass set aside)
  const later = t.lap(105, raceTimeText(timeOf(105, 2) / S + 20));
  t.clock.advance(3000);
  assert.deepEqual(t.sends.slice(at).filter((p) => p.bib === '105').map((p) => [p.splitName, p.csTicks, p.reason]),
    [['2K', timeOf(105, 2) + 20 * S, 'correction'], ['3K', timeOf(105, 3), 'place-update']]);
  assert.match(t.row(later).detail, /^Real read replaced the made-up time \(20 s later\): re-sent as place \d+ with the real time\.$/);
  assert.equal(t.row(later).status, 'corrected');
  assert.equal(t.engine.raceView('r').stale.count, 2);
  assert.equal(t.engine.runner('r', '105').columns[1].stale, null);
  t.engine.resendRace('r');
  assert.equal(t.engine.raceView('r').stale.count, 0);
  assert.deepEqual(sentOf(t, 105).filter((x) => x[0] === '2K').at(-1).slice(0, 2), ['2K', timeOf(105, 2) + 20 * S]);
  // a restart agrees
  t = t.restart();
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => c.source), ['read', 'read', 'read']);
});

test('P3 a real read that lands on a made-up split within the minute replaces it and is sent as a correction', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  field(s, { splits: 3, skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.engine.addManual('r', { bib: '105', splitId: 's2' });
  // (9.23 F4: the made-up 2K, then the runner's furthest split as a place update)
  assert.deepEqual(sentOf(s, 105).slice(-2).map((x) => [x[0], x[3]]), [['2K', 'new'], ['3K', 'place-update']]);
  s.clock.advance(10_000);
  const late = s.lap(105, raceTimeText(timeOf(105, 2) / S - 4)); // 4 s before the estimate
  s.clock.advance(3000);
  // (9.23 F11: the real time inside the made-up time's minute, then 3K again: its leg (LS) is from the real 2K now, and
  // it is the runner's furthest split, whose place TrackScore shows)
  assert.deepEqual(sentOf(s, 105).slice(-2), [['2K', timeOf(105, 2) - 4 * S, 6, 'correction'], ['3K', timeOf(105, 3), 6, 'place-update']]);
  assert.equal(s.sends.at(-1).lsTicks, timeOf(105, 3) - timeOf(105, 2) + 4 * S);
  assert.deepEqual([s.row(late).status, s.row(late).detail], ['corrected', 'Real read replaced the made-up time (4 s earlier): re-sent as place 6 with the real time.']);
  assert.equal(s.engine.crossings('r').find((c) => c.bib === '105' && c.splitId === 's2').source, 'read');
  // a read that was already there when the time was made up never takes its place (it was looked at then)
  const pins = s.store.journal.filter((l) => l.includes('"t":"manual"')).length;
  assert.equal(pins, 1);
});

test('P3 a made-up time holds its split: the passes after it count on from the split after it', () => {
  const s = setup();
  // on the course: bib 105 missed 2K and has passed 3K; the leaders are past 4K
  field(s, { skip: { 105: [2] }, upTo: 700 });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.engine.addManual('r', { bib: '105', splitId: 's2' });
  // the 4K pass comes: it is 4K (after the made-up 2K and the real 3K), not 3K
  s.lap(105, raceTimeText(timeOf(105, 4) / S));
  s.clock.advance(3000);
  assert.deepEqual(s.engine.runner('r', '105').columns.map((c) => [c.splitName, c.source]),
    [['1K', 'read'], ['2K', 'made-up'], ['3K', 'read'], ['4K', 'read']]);
  assert.deepEqual(s.engine.review('r').checks, []);
});

test('P3 "Send all estimable", a finisher no mat read, and the validation words (P5)', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  field(s, { splits: 3, skip: { 103: [3], 104: [3] } });
  // FinishLynx: everybody finished, bib 120 too, though no mat read it
  for (let i = 0; i < 12; i++) {
    s.lynx.set(String(100 + i), Math.round(720 * (1 + 0.02 * i) * S));
    s.places.set(String(100 + i), i + 1);
  }
  s.lynx.set('120', rt('14:00'));
  s.places.set('120', 13);
  s.engine.converge();
  s.clock.advance(3000);
  let r = s.engine.review('r');
  assert.deepEqual(r.missing.map((m) => [m.bib, m.splitName, m.prev.splitName, m.next.splitName, m.finishPlace, m.sendable]), [
    ['103', '3K', '2K', 'Finish', 4, true], ['104', '3K', '2K', 'Finish', 5, true],
    ['120', '1K', 'Gun', 'Finish', 13, true], ['120', '2K', 'Gun', 'Finish', 13, true], ['120', '3K', 'Gun', 'Finish', 13, true],
  ]);
  const at = r.missing.filter((m) => m.bib === '120').map((m) => m.estimate);
  assert.ok(at[0] < at[1] && at[1] < at[2] && at[2] < rt('14:00'), 'a run of three, in order inside the stretch');
  // validation (P5), in words
  const no = (body, re) => assert.throws(() => s.engine.addManual('r', body), (err) => {
    assert.equal(err.status, 409, err.message);
    assert.match(err.message, re);
    return true;
  });
  no({ bib: '103', splitId: 's3', time: '6:00' }, /^6:00\.0 is not after bib 103's 2K \(6:21\.6\)\. A 3K time must come after it\.$/);
  no({ bib: '103', splitId: 's3', time: '20:00' }, /^20:00\.0 is not before bib 103's finish \(12:43\.2\)\. A 3K time must come before it\.$/);
  no({ bib: '103', splitId: 's1', time: '3:00' }, /^Bib 103 has a real 1K time \(3:10\.8\) from the mats\.$/);
  no({ bib: '120', splitId: 's1', time: '0:30' }, /^30\.0 is in the start area \(the first 60 s after the gun\)\. A 1K time must come after it\.$/);
  assert.throws(() => s.engine.addManual('r', { bib: '103', splitId: 's3', time: 'soon' }), (err) => err.status === 400 &&
    /^"soon" is not a race time\. Type it like 6:12\.3 \(minutes:seconds\)\.$/.test(err.message));
  // send all: every estimable one, finishers with their finish place (P4)
  const before = s.sends.length;
  const all = s.engine.addManual('r', { all: true });
  assert.equal(all.added.length, 5);
  assert.deepEqual(all.skipped, []);
  assert.deepEqual(s.sends.slice(before).map((p) => [p.bib, p.splitName, p.place]).sort(),
    [['103', '3K', 4], ['104', '3K', 5], ['120', '1K', 13], ['120', '2K', 13], ['120', '3K', 13]]);
  assert.ok(all.added.every((a) => a.withFinishPlace));
  r = s.engine.review('r');
  assert.deepEqual([r.missing.length, r.counts.manual], [0, 5]);
  assert.match(s.engine.feed(1)[0].detail, /^Made-up time, approved in Review: Sent with the finish place \(13\), so TrackScore keeps it\./);
});

test('P3 Send sends the estimate the list shows, inside a run of missing splits too; a batch of approved rows is checked row by row', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // 12 complete runners whose 1K share of the race varies (a fast or a steady start), and 6 who were read at 1K only
  // (fast starters): estimating the 1K of a runner no mat read from the 1K alone would learn from all 18 of them,
  // estimating the whole run 1K-2K-3K from the 12 that have every split
  for (let i = 0; i < 12; i++) {
    const p = 1 + 0.02 * i;
    const f = [0.9, 1, 1.1][i % 3];
    for (const t of [180 * p * f, 360 * p, 540 * p]) s.lap(100 + i, raceTimeText(t));
    s.lynx.set(String(100 + i), Math.round(720 * p * S));
    s.places.set(String(100 + i), i + 1);
  }
  for (let i = 0; i < 6; i++) {
    const p = 1 + 0.02 * i;
    s.lap(140 + i, raceTimeText(150 * p));
    s.lynx.set(String(140 + i), Math.round(720 * p * S) + 1000);
    s.places.set(String(140 + i), 13 + i);
  }
  s.lynx.set('120', rt('14:00'));
  s.places.set('120', 19);
  s.engine.converge();
  s.clock.advance(3000);
  const listed = () => new Map(s.engine.review('r').missing.map((m) => [`${m.bib}|${m.splitId}`, m]));
  let list = listed();
  assert.deepEqual(s.engine.review('r').checks, [], 'nobody is in doubt');
  assert.deepEqual(['120|s1', '120|s2', '120|s3', '140|s2', '140|s3'].map((k) => list.get(k)?.sendable), [true, true, true, true, true]);
  // one row: exactly the time the list showed, not a 1K worked out on its own
  const e1 = list.get('120|s1').estimate;
  const one = s.engine.addManual('r', { bib: '120', splitId: 's1' });
  assert.deepEqual([one.added[0].raceTicks, one.added[0].source, one.added[0].basis], [e1, 'made-up', list.get('120|s1').basis]);
  // the rest of the run now sits between the made-up 1K and the finish
  list = listed();
  assert.deepEqual([list.get('120|s2').prev.splitName, list.get('120|s2').prev.raceTicks], ['1K', e1]);
  // a batch: the times the list shows now, each row checked after the rows before it went in
  const e2 = list.get('120|s2').estimate;
  const e140 = list.get('140|s2').estimate;
  const before = s.sends.length;
  const res = s.engine.addManual('r', { items: [
    { bib: '120', splitId: 's2' },
    { bib: '120', splitId: 's3', time: formatRaceTime(e2 - 10 * S, 1) },
    { bib: '140', splitId: 's2' },
    { bib: '140', splitId: 's3', time: 'later' },
    { bib: '100', splitId: 's1' },
  ] });
  assert.deepEqual(res.added.map((a) => [a.bib, a.splitName, a.raceTicks, a.source]), [['120', '2K', e2, 'made-up'], ['140', '2K', e140, 'made-up']]);
  assert.deepEqual(res.skipped.map((x) => [x.bib, x.splitId]), [['120', 's3'], ['140', 's3'], ['100', 's1']]);
  assert.match(res.skipped[0].why, /^\d+:\d\d\.\d is not after bib 120's 2K \(\d+:\d\d\.\d\)\. A 3K time must come after it\.$/);
  assert.equal(res.skipped[1].why, '"later" is not a race time. Type it like 6:12.3 (minutes:seconds).');
  assert.match(res.skipped[2].why, /^Bib 100 has a real 1K time/);
  // finishers: sent with their finish places (P4)
  assert.deepEqual(s.sends.slice(before).filter((p) => ['120', '140'].includes(p.bib)).map((p) => [p.bib, p.splitName, p.place]).sort(),
    [['120', '2K', 19], ['140', '2K', 13]]);
  // a restart replays them exactly
  const t = s.restart();
  assert.deepEqual(t.engine.runner('r', '120').columns.map((c) => [c.source, c.time]), [['made-up', e1], ['made-up', e2], [null, null]]);
  assert.equal(t.engine.runner('r', '140').columns[1].time, e140);
});

// ---- P4: finished runners --------------------------------------------------------------------------------------------

test('P4 a finisher: a made-up split goes with the finish place; without a known place it is refused; finished-not-sent goes on request', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(2) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  field(s, { splits: 2, skip: { 103: [2], 111: [2] } });
  s.clock.advance(3000);
  // bib 103 finished; FinishLynx's file has no place for it yet
  s.lynx.set('103', rt('10:00'));
  s.engine.converge();
  const m = s.engine.review('r').missing.find((x) => x.bib === '103');
  assert.equal(m.sendable, false);
  assert.match(m.why, /^Bib 103 has finished, but Split Relay doesn't know the finish place/);
  assert.throws(() => s.engine.addManual('r', { bib: '103', splitId: 's2' }), (err) => err.status === 409 && /doesn't know the finish place/.test(err.message));
  // the place comes in: sent with P = 7, so TrackScore keeps it
  s.places.set('103', 7);
  s.engine.converge();
  const before = s.sends.length;
  const res = s.engine.addManual('r', { bib: '103', splitId: 's2' });
  assert.deepEqual(s.sends.slice(before).filter((p) => p.bib === '103').map((p) => [p.bib, p.splitName, p.place]), [['103', '2K', 7]],
    'its own packet carries the finish place; the runners behind it at 2K move down a place as usual');
  assert.deepEqual([res.added[0].withFinishPlace, res.added[0].place], [true, 7]);
  // FinishLynx moves the runner to 6th: the made-up split follows (within the minute)
  s.places.set('103', 6);
  s.engine.converge();
  s.clock.advance(100);
  assert.deepEqual(s.sends.at(-1).place, 6);
  // real splits of a runner who finished before they were sent: listed, sent only on request, with the finish place
  s.lynx.set('111', rt('11:00'));
  s.places.set('111', 12);
  s.engine.converge();
  s.lap(111, raceTimeText(timeOf(111, 2) / S)); // its 2K read comes in late (RR12 had it queued)
  s.clock.advance(3000);
  let fin = s.engine.review('r').finishedNotSent;
  assert.deepEqual(fin.map((x) => [x.bib, x.splitName, x.finishPlace, x.sendable]), [['111', '2K', 12, true]]);
  assert.equal(s.engine.raceView('r').finishedNotSent, 1);
  const out = s.engine.sendFinished('r', { bib: '111', splitId: 's2' });
  assert.deepEqual(out, { sent: 1, skipped: [], outputs: 1 });
  assert.deepEqual([s.sends.at(-1).bib, s.sends.at(-1).place], ['111', 12]);
  fin = s.engine.review('r').finishedNotSent;
  assert.deepEqual(fin, []);
  assert.throws(() => s.engine.sendFinished('r', { all: true }), (err) => err.status === 404 && /^Nothing to send/.test(err.message));
  s.config.races[0].active = false;
  s.engine.configChanged();
  assert.throws(() => s.engine.sendFinished('r', { all: true }), (err) => err.code === 'RACE_INACTIVE' && err.status === 409);
});

// ---- revision 10 (DESIGN 9.18) -----------------------------------------------------------------------------------------

test('R1: two made-up times in a row: a late real read replaces the one of its own split, never the other', () => {
  for (const [lateAt, want] of [['10:50', '2K'], ['5:30', '1K'], ['5:50', '1K'], ['10:55', '2K']]) {
    const s = setup({ races: [lapRace({ splits: lapSplits(2) })] });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    for (let i = 0; i < 10; i++) s.lap(100 + i, raceTimeText(300 + 6 * i));
    for (let i = 0; i < 10; i++) s.lap(100 + i, raceTimeText(600 + 6 * i));
    s.clock.advance(3000);
    // all of them finished, and bib 120 that no mat read
    for (let i = 0; i < 10; i++) {
      s.lynx.set(String(100 + i), Math.round((900 + 5 * i) * S));
      s.places.set(String(100 + i), i + 1);
    }
    s.lynx.set('120', rt('16:00'));
    s.places.set('120', 11);
    s.engine.converge();
    s.clock.advance(3000);
    const added = s.engine.addManual('r', { all: true }).added;
    assert.deepEqual(added.map((m) => [m.bib, m.splitName]), [['120', '1K'], ['120', '2K']]);
    const madeUp = new Map(added.map((m) => [m.splitName, m.raceTicks]));
    s.clock.advance(3000);
    s.lap(120, lateAt); // RR12 sends a read of one of the mats late (a queued read, a Replay)
    s.clock.advance(5000);
    const view = s.engine.runner('r', '120');
    const other = want === '1K' ? '2K' : '1K';
    const col = (name) => view.columns.find((c) => c.splitName === name);
    assert.deepEqual([col(want).source, col(want).time], ['read', rt(lateAt)], `${lateAt}: the real ${want}`);
    assert.deepEqual([col(other).source, col(other).time], ['made-up', madeUp.get(other)], `${lateAt}: the made-up ${other} stays`);
    assert.deepEqual(view.manual.map((m) => [m.splitName, m.state]).sort(), [[want, 'replaced'], [other, 'active']].sort());
    assert.deepEqual(view.passes.map((p) => [p.splitName, p.how]), [[want, 'replaces']]);
    assert.deepEqual(s.engine.raceData('r').runners.get('120').splits, want === '1K' ? [rt(lateAt), madeUp.get('2K')] : [madeUp.get('1K'), rt(lateAt)]);
    // a finisher: TrackScore has the made-up time; the real one goes with the finish place on request (R3)
    assert.deepEqual(s.engine.review('r').finishedNotSent.map((x) => [x.bib, x.splitName, x.sentOld?.timeText]),
      [['120', want, formatRaceTime(madeUp.get(want), 1)]]);
    // read by read = a restart
    const t = s.restart();
    assert.deepEqual(t.engine.runner('r', '120').columns.map((c) => [c.source, c.time]), view.columns.map((c) => [c.source, c.time]));
  }
});

test('R1: a late real read nearer an empty column is an ordinary pass; one after its own made-up time replaces it', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // bib 105 missed 1K and 2K: its one pass is the 3K. Everybody finishes; the field fractions place the pass.
  field(s, { splits: 3, skip: { 105: [1, 2] } });
  for (let i = 0; i < 12; i++) {
    s.lynx.set(String(100 + i), Math.round(720 * (1 + 0.02 * i) * S));
    s.places.set(String(100 + i), i + 1);
  }
  s.engine.converge();
  s.clock.advance(3000);
  assert.deepEqual(s.engine.review('r').checks.map((c) => [c.bib, c.fromName, c.toName]), [['105', '1K', '3K']]);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.clock.advance(3000);
  // the operator sends the 2K estimate only; 1K stays empty
  const m2 = s.engine.addManual('r', { bib: '105', splitId: 's2' }).added[0];
  assert.equal(m2.withFinishPlace, true);
  s.clock.advance(3000);
  // a late real 1K read: nearer the empty 1K than the made-up 2K: an ordinary pass, counted there
  s.lap(105, raceTimeText(timeOf(105, 1) / S));
  s.clock.advance(3000);
  let view = s.engine.runner('r', '105');
  assert.deepEqual(view.columns.map((c) => [c.source, c.time]),
    [['read', timeOf(105, 1)], ['made-up', m2.raceTicks], ['read', timeOf(105, 3)]]);
  assert.deepEqual(view.manual.map((m) => m.state), ['active']);
  // then the 2K mat's own read, 3 s after the made-up time (an estimate is never exact): it replaces it
  s.lap(105, raceTimeText(m2.raceTicks / S + 3));
  s.clock.advance(3000);
  view = s.engine.runner('r', '105');
  assert.deepEqual(view.columns.map((c) => [c.source, c.time]),
    [['read', timeOf(105, 1)], ['read', m2.raceTicks + 3 * S], ['read', timeOf(105, 3)]]);
  assert.deepEqual(view.manual.map((m) => m.state), ['replaced']);
  assert.deepEqual(view.passes.map((p) => [p.splitName, p.how]), [['1K', 'counted'], ['2K', 'replaces'], ['3K', 'moved']]);
  // a pass that fits no made-up time and no column (a stray read after everything): ordinary, here extra
  s.lap(105, raceTimeText(timeOf(105, 3) / S + 60));
  s.clock.advance(3000);
  assert.deepEqual(s.engine.runner('r', '105').columns.map((c) => c.time), [timeOf(105, 1), m2.raceTicks + 3 * S, timeOf(105, 3)]);
  const t = s.restart();
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => [c.source, c.time]),
    [['read', timeOf(105, 1)], ['read', m2.raceTicks + 3 * S], ['read', timeOf(105, 3)]]);
});

test('R1 randomized: a late real read of a made-up split replaces that made-up time, whatever the other made-up times', () => {
  let checked = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed * 104729);
    const n = 2 + Math.floor(rand() * 3);
    const s = setup({ races: [lapRace({ splits: lapSplits(n) })] });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    const count = 14;
    const pace = (i) => 1 + 0.02 * i;
    // bib 100 + count is the runner under test: its mats missed at random (at least one), never all of them
    const miss = new Set();
    for (let k = 1; k <= n; k++) if (rand() < 0.5) miss.add(k);
    if (!miss.size) miss.add(1 + Math.floor(rand() * n));
    const who = 100 + count;
    for (let k = 1; k <= n; k++) {
      for (let i = 0; i <= count; i++) {
        if (i === count && miss.has(k)) continue;
        s.lap(100 + i, raceTimeText(180 * k * (i === count ? 1.1 : pace(i))));
      }
    }
    for (let i = 0; i <= count; i++) {
      const p = i === count ? 1.1 : pace(i);
      s.lynx.set(String(100 + i), Math.round(180 * (n + 1) * p * S));
      s.places.set(String(100 + i), i + 1);
    }
    s.engine.converge();
    s.clock.advance(3000);
    if (s.engine.review('r').checks.some((c) => c.bib === String(who))) s.engine.assign('r', { bib: String(who), all: 'move' });
    s.clock.advance(3000);
    s.engine.addManual('r', { all: true });
    s.clock.advance(3000);
    // the real reads of its missed mats come late, in random order, each a few seconds off the made-up time
    const late = [...miss].sort(() => rand() - 0.5);
    for (const k of late) {
      const real = 180 * k * 1.1;
      s.lap(who, raceTimeText(real));
      s.clock.advance(3000);
      const v = s.engine.runner('r', String(who));
      const col = v.columns[k - 1];
      // its neighbours: real reads, or made-up times still waiting for their own late read
      assert.deepEqual([col.source, col.time], ['read', Math.round(real * S)], `seed ${seed} n ${n} missed ${[...miss]} late ${k}: ${JSON.stringify(v.columns.map((c) => [c.source, c.time]))}`);
      assert.equal(v.manual.find((m) => m.index === k - 1)?.state ?? 'replaced', 'replaced');
      for (const j of miss) {
        if (late.indexOf(j) <= late.indexOf(k)) continue;
        assert.equal(v.columns[j - 1].source, 'made-up', `seed ${seed}: the made-up ${j}K is still there`);
      }
      checked++;
    }
    const t = s.restart();
    assert.deepEqual(t.engine.runner('r', String(who)).columns.map((c) => [c.source, c.time]),
      Array.from({ length: n }, (_, k) => ['read', Math.round(180 * (k + 1) * 1.1 * S)]), `seed ${seed}: every column real after a restart`);
  }
  assert.ok(checked > 60, `${checked} late reads checked`);
});

test('R3: a finisher\'s split sent before a Move is not "sent": Review offers the corrected time with the finish place', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const lap = (bib, sec) => s.lap(bib, raceTimeText(sec));
  // bib 100, the leader, missed 1K. Its 2K pass comes before anybody else reaches 2K, so nothing can say it is not
  // a (slow) 1K: it goes out as 1K. Its 3K pass likewise goes out as 2K.
  for (let i = 1; i < 12; i++) lap(100 + i, 180 * (1 + 0.02 * i));
  s.clock.advance(3000);
  lap(100, 360);
  s.clock.advance(3000);
  for (let i = 1; i < 12; i++) lap(100 + i, 360 * (1 + 0.02 * i));
  s.clock.advance(3000);
  lap(100, 540);
  s.clock.advance(3000);
  for (let i = 1; i < 12; i++) lap(100 + i, 540 * (1 + 0.02 * i));
  s.clock.advance(3000);
  assert.deepEqual(sentOf(s, 100).map((x) => [x[0], x[1]]), [['1K', rt('6:00')], ['2K', rt('9:00')]]);
  // FinishLynx finishes everybody; the field fractions now say where bib 100's passes belong
  for (let i = 0; i < 12; i++) {
    s.lynx.set(String(100 + i), Math.round(720 * (1 + 0.02 * i) * S));
    s.places.set(String(100 + i), i + 1);
  }
  s.engine.converge();
  s.clock.advance(3000);
  assert.deepEqual(s.engine.review('r').checks.map((c) => [c.fromName, c.toName, c.delivered, c.finished]), [['1K', '2K', true, true], ['2K', '3K', true, true]]);
  s.engine.assign('r', { bib: '100', all: 'move' });
  s.clock.advance(3000);
  // the made-up 1K goes with the finish place, into the cell that has the 6:00.0
  const m1 = s.engine.addManual('r', { bib: '100', splitId: 's1' }).added[0];
  assert.deepEqual(sentOf(s, 100).at(-1), ['1K', m1.raceTicks, 1, 'correction']);
  assert.deepEqual([m1.sent, m1.withFinishPlace], [true, true]);
  // TrackScore has 9:00.0 as bib 100's 2K: the 6:00.0 pass is 2K now. Not "sent": it is in Review with the old time
  const r = s.engine.review('r');
  assert.deepEqual(r.finishedNotSent.map((x) => [x.splitName, x.timeText, x.sentOld?.timeText ?? null, x.finishPlace]),
    [['2K', '6:00.0', '9:00.0', 1], ['3K', '9:00.0', null, 1]]);
  assert.equal(r.finishedNotSent[0].note, 'Sent with an old time (9:00.0): TrackScore and the live results show that as 2K. Send the corrected time (6:00.0) with the finish place.');
  const rv = s.engine.raceView('r');
  assert.deepEqual([rv.finishedNotSent, rv.stale.count], [2, 0], 'counted under Finished: not sent live, not as a Resend (a Resend leaves finishers out)');
  const cols = s.engine.runner('r', '100').columns;
  assert.deepEqual(cols.map((c) => [c.splitName, c.delivered, c.finishedNotSent, c.sentOld?.timeText ?? null]),
    [['1K', true, false, null], ['2K', false, true, '9:00.0'], ['3K', false, true, null]]);
  assert.equal(cols[1].note, r.finishedNotSent[0].note);
  const row = s.engine.feed(1000).find((e) => e.bib === '100' && e.raceTicks === rt('6:00'));
  assert.equal(row.status, 'finished-not-sent');
  assert.match(row.detail, /^Finished: Sent with an old time \(9:00\.0\): .* Review lists it under Finished: not sent live\./);
  // the same after a restart (what was sent is in the race file)
  let t = s.restart();
  assert.deepEqual(t.engine.review('r').finishedNotSent.map((x) => [x.splitName, x.sentOld?.timeText ?? null]), [['2K', '9:00.0'], ['3K', null]]);
  // Send with finish place: the corrected 2K replaces the old one, the 3K goes for the first time; both with P = 1
  const before = t.sends.length;
  assert.deepEqual(t.engine.sendFinished('r', { all: true }), { sent: 2, skipped: [], outputs: 1 });
  assert.deepEqual(t.sends.slice(before).map((p) => [p.splitName, p.csTicks, p.place, p.lapsToGo, p.reason]),
    [['2K', rt('6:00'), 1, 2, 'correction'], ['3K', rt('9:00'), 1, 1, 'new']]);
  assert.deepEqual(t.engine.review('r').finishedNotSent, []);
  assert.deepEqual(t.engine.runner('r', '100').columns.map((c) => c.delivered), [true, true, true]);
  assert.equal(t.engine.raceView('r').finishedNotSent, 0);
  t = t.restart();
  assert.deepEqual(t.engine.review('r').finishedNotSent, []);
});

test('R3/R4 + revision 11: a split that went out just after the runner finished, with the split place, goes out again with the finish place on its own', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(2) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // the clock is the race clock here (T0 = the gun, 10:00:00): 2K paused, the field passes both mats
  s.config.races[0].splits[1].sending = false;
  s.engine.configChanged();
  field(s, { splits: 2 });
  s.clock.advance(3000);
  assert.equal(s.sends.filter((p) => p.splitName === '2K').length, 0);
  // bib 100 finishes at 9:00; FinishLynx has told TrackScore, but its file does not have it yet. Play at 9:20. (The
  // race's own reads tell how far on the race is: a straggler's read timed 9:15 has come in by then.)
  s.clock.advance(Math.max(0, Math.round(rt('9:16') / 10) - (s.clock.now() - T0)));
  s.lap(150, '9:15');
  s.clock.advance(Math.max(0, Math.round(rt('9:20') / 10) - (s.clock.now() - T0)));
  s.config.races[0].splits[1].sending = true;
  s.engine.configChanged();
  s.clock.advance(100);
  const twoK = s.sends.find((p) => p.bib === '100' && p.splitName === '2K');
  assert.deepEqual([twoK.place, twoK.reason], [1, 'new'], 'sent with its split place: the relay did not know the finish yet');
  assert.deepEqual(s.engine.review('r').finishedNotSent, []);
  // FinishLynx's file catches up at 9:22 with bib 102, who finished at 9:18 in 5th: no read was timed after 9:18 yet,
  // but its split went out late (held by the pause) in the moments before the relay found the finish in the file
  s.clock.advance(Math.round(rt('0:02') / 10));
  s.lynx.set('102', rt('9:18'));
  s.places.set('102', 5);
  let mark = s.sends.length;
  s.engine.converge();
  // Revision 11: the relay puts the finish place back on its own as soon as FinishLynx's file has it — the same time,
  // the finish place (no operator needed: it only restores what FinishLynx said)
  assert.deepEqual(s.sends.slice(mark).map((p) => [p.bib, p.splitName, p.place, p.reason, p.csTicks]),
    [['102', '2K', 5, 'place-update', timeOf(102, 2)]]);
  // ...and at 9:45 with bib 100, who finished at 9:00 in 3rd (its split went out at 9:20: the race's reads were past
  // 9:00 by then), and bib 101 at 9:30 (its 2K went out at 9:20, before that, so TrackScore's place for it is
  // FinishLynx's packet's: nothing to put back)
  s.clock.advance(Math.round(rt('0:23') / 10));
  s.lynx.set('100', rt('9:00'));
  s.places.set('100', 3);
  s.lynx.set('101', rt('9:30'));
  s.places.set('101', 4);
  mark = s.sends.length;
  s.engine.converge();
  assert.deepEqual(s.sends.slice(mark).map((p) => [p.bib, p.splitName, p.place, p.reason, p.csTicks]),
    [['100', '2K', 3, 'place-update', timeOf(100, 2)]]);
  // nothing is left for the operator, and a second look sends nothing again
  assert.deepEqual(s.engine.review('r').finishedNotSent, []);
  assert.equal(s.engine.raceView('r').finishedNotSent, 0);
  const col = s.engine.runner('r', '100').columns[1];
  assert.deepEqual([col.delivered, col.finishedNotSent, col.sentAfter], [true, false, null]);
  mark = s.sends.length;
  s.clock.advance(5000);
  s.engine.converge();
  assert.equal(s.sends.length, mark);
  // a restart agrees (what was sent, and when, is in the race file)
  assert.deepEqual(s.restart().engine.review('r').finishedNotSent, []);
});

test('R3/R4 the place rule across a restart: a split that went out late just before Split Relay restarted', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(2) })] });
  s.config.races[0].splits[1].sending = false;
  s.engine.configChanged();
  field(s, { splits: 2 });
  s.clock.advance(Math.max(0, Math.round(rt('9:20') / 10) - (s.clock.now() - T0)));
  s.config.races[0].splits[1].sending = true;
  s.engine.configChanged();
  s.clock.advance(1000);
  // the relay restarts at 9:21; by then FinishLynx's file has bib 104, who finished at 9:19 in 6th
  s.lynx.set('104', rt('9:19'));
  s.places.set('104', 6);
  const before = s.sends.length;
  const t = s.restart();
  // the restarted relay still knows its 2K went out after that finish, and puts the finish place back on its own
  t.engine.converge();
  t.clock.advance(100);
  const back = t.sends.slice(t.sends === s.sends ? before : 0).filter((p) => p.bib === '104' && p.splitName === '2K').map((p) => [p.place, p.reason]);
  assert.deepEqual(back, [[6, 'place-update']]);
  assert.deepEqual(t.engine.review('r').finishedNotSent, []);
});

test('R3: a made-up time counts as sent only when an output has it, not an older real time of that split', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  // as above: bib 100 missed 1K; its 2K pass went out as 1K; Moved
  const lap = (bib, sec) => s.lap(bib, raceTimeText(sec));
  for (let i = 1; i < 12; i++) lap(100 + i, 180 * (1 + 0.02 * i));
  s.clock.advance(3000);
  lap(100, 360);
  s.clock.advance(3000);
  for (let i = 1; i < 12; i++) lap(100 + i, 360 * (1 + 0.02 * i));
  for (let i = 1; i < 12; i++) lap(100 + i, 540 * (1 + 0.02 * i));
  s.clock.advance(3000);
  lap(100, 540);
  s.clock.advance(3000);
  for (let i = 0; i < 12; i++) {
    s.lynx.set(String(100 + i), Math.round(720 * (1 + 0.02 * i) * S));
    s.places.set(String(100 + i), i + 1);
  }
  s.engine.converge();
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '100', all: 'move' });
  s.clock.advance(3000);
  // 1K paused: the made-up 1K waits; TrackScore still has 6:00.0 in that cell from the pass that went out as 1K
  s.config.races[0].splits[0].sending = false;
  s.engine.configChanged();
  const m1 = s.engine.addManual('r', { bib: '100', splitId: 's1' }).added[0];
  assert.equal(m1.sent, false, 'not sent: the 1K cell has the old 6:00.0, not the made-up time');
  const gone = s.engine.removeManual('r', { bib: '100', splitId: 's1' });
  assert.deepEqual([gone.wasSent, gone.note], [false, null]);
});

// ---- P5: everything replayed, incremental = rebuild, never an unsafe packet ----------------------------------------

test('P5 randomized: pauses, Moves, Keeps and made-up times: read by read equals a rebuild and a restart; every packet is safe', () => {
  for (const seed of [7, 31, 404, 2718]) {
    const rand = rng(seed);
    const s = setup({ races: [lapRace({ splits: lapSplits(4) })], filter: { holdSec: rand() < 0.5 ? 0 : 2 } });
    let packets = 0;
    s.engine.on('send', (p) => {
      packets++;
      assertSendable(p, s.config);
    });
    const reads = [];
    for (let i = 0; i < 40; i++) {
      const pace = 1 + rand() * 0.5;
      for (let k = 1; k <= 4; k++) {
        if (rand() < 0.08) continue; // a missed mat
        const t = 180 * k * pace + rand() * 3;
        reads.push([100 + i, t]);
        if (rand() < 0.5) reads.push([100 + i, t + rand() * 1.5]);
      }
    }
    const arrivals = reads.map((r) => ({ r, at: r[1] + 1.5 + rand() * 3 + (rand() < 0.05 ? rand() * 300 : 0) })).sort((a, b) => a.at - b.at);
    for (const [i, { r: [bib, t] }] of arrivals.entries()) {
      s.lap(bib, raceTimeText(t));
      s.clock.advance(Math.floor(rand() * 900));
      if (i % 37 === 20) {
        const sp = s.config.races[0].splits[Math.floor(rand() * 4)];
        sp.sending = !sp.sending;
        s.engine.configChanged();
      }
      if (i % 23 === 11) {
        const rv = s.engine.review('r');
        const c = rv.checks[Math.floor(rand() * rv.checks.length)];
        if (c) s.engine.assign('r', rand() < 0.6 ? { bib: c.bib, all: 'move' } : { bib: c.bib, tod: c.passTod, splitId: null });
        const m = rv.missing.find((x) => x.sendable);
        if (m) {
          try {
            s.engine.addManual('r', rand() < 0.7 ? { bib: m.bib, splitId: m.splitId } : { bib: m.bib, splitId: m.splitId, time: raceTimeText((m.estimate + 10 * S) / S) });
          } catch (err) {
            assert.equal(err.status, 409, err.message); // a typed time past the next split: refused in words
          }
        }
        const made = rv.manual.find((x) => x.state === 'active');
        if (made && rand() < 0.2) s.engine.removeManual('r', { bib: made.bib, splitId: made.splitId });
      }
      if (rand() < 0.02) {
        s.lynx.set(String(100 + Math.floor(rand() * 40)), Math.round((700 + rand() * 400) * S));
        s.engine.converge();
      }
    }
    s.clock.advance(70_000);
    const snap = (e) => ({
      crossings: e.crossings('r').map((c) => [c.bib, c.splitId, c.tod, c.raceTicks, c.place, c.reads, c.source, c.held]),
      view: e.raceView('r'),
      data: [...e.raceData('r').runners].map(([bib, r]) => [bib, r.splits]),
      review: e.review('r'),
    });
    const incremental = snap(s.engine);
    const n = packets;
    // a rebuild from scratch (a setting the derivation depends on, changed and changed back)
    s.config.races[0].splits[0].sources.push('Never');
    s.engine.configChanged();
    s.config.races[0].splits[0].sources.pop();
    s.engine.configChanged();
    const rebuilt = snap(s.engine);
    assert.deepEqual(rebuilt.crossings, incremental.crossings, `crossings, seed ${seed}`);
    assert.deepEqual(rebuilt.data, incremental.data, `raceData, seed ${seed}`);
    assert.deepEqual(rebuilt.view, incremental.view, `raceView, seed ${seed}`);
    assert.deepEqual(rebuilt.review, incremental.review, `review, seed ${seed}`);
    assert.equal(packets, n, `the rebuild found nothing to send, seed ${seed}`);
    const t = s.restart();
    const after = snap(t.engine);
    assert.deepEqual(after.crossings, incremental.crossings, `restart, seed ${seed}`);
    assert.deepEqual(after.review.missing, incremental.review.missing, `restart review, seed ${seed}`);
    assert.ok(packets > 40, `seed ${seed}: ${packets} packets`);
    assert.ok(s.store.journal.some((l) => l.includes('"t":"manual"')), `seed ${seed} made up a time`);
  }
});

// ---- DESIGN 9.23: fix a runner (move times between splits, fill in missing splits) ----------------------------------

const WOMENS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/womens-passes.json', import.meta.url)), 'utf8'));
const GUN = parseTod('10:00:00');

/**
 * The Womens Race of race day 2026-10-21 from its times (bibs renumbered, no names): 7 splits, the stream carried the
 * finish line and cool-down passes, and the operator kept one lone pass in 3100m from the check queue. Its first
 * packets went out 70 s ago, so a correction now needs the operator (the minute is over).
 */
function womens({ drop = {}, keep = [], kept3100 = true, ...opts } = {}) {
  const races = [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })];
  const s = setup({ races, filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, ...opts });
  // drop: bib -> the passes (race ticks) its chip was not read at, for a what-if on the real race
  const reads = WOMENS.runners.flatMap((r) => r.passes.filter((t) => !drop[r.bib]?.includes(t)).map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
  // (521's lone pass kept in 3100m from the check queue, as on race day; kept3100 false: held by the column check)
  if (kept3100) s.engine.assign('w', { bib: WOMENS.keptAt3100.bib, tod: GUN + WOMENS.keptAt3100.raceTicks, splitId: null });
  // keep: runners (by their race-day bib, WOMENS.shapes) whose passes the column check holds, kept as counted from the
  // check queue: they go out a column early, as they did on race day before 9.23 F13 held them past the finish pass
  for (const b of keep) s.engine.assign('w', { bib: WOMENS.shapes[b] ?? String(b), all: 'keep' });
  s.clock.advance(70_000);
  s.sh = WOMENS.shapes;
  return s;
}
/**
 * 9.23 F13: the race-day runners the column check now holds (403 and 512, the finish pass in 5300m; 586, two mats missed)
 * kept from the check queue as counted: their passes go out a column early, as they did on race day.
 */
const RACE_DAY = [403, 512, 586];
const passAt = (v, time) => v.passes.find((p) => p.timeText === time);
const sentFrom = (s, at, bib) => s.sends.slice(at).filter((p) => p.bib === String(bib)).map((p) => [p.splitName, p.lapsToGo, p.reason]);
const journalOf = (s) => s.store.journal.map((l) => JSON.parse(l));

test('9.23 F6/F13 the real race: the four runners that went out wrong are found, each with "Missed <split>: add it"; 8 have no read lately', () => {
  const s = womens();
  const { 403: a, 512: b, 521: c, 586: d } = s.sh;
  const r = s.engine.review('w');
  // 9.23 F13: the column check, with the finish as a column (the stream carries finish passes), holds three of them
  // before anything goes out a column early: 403's and 512's finish passes in 5300m, and 586's passes (its cool-down
  // pass in 5300m no longer lets them go). Each runner's first row has the one fix. Nothing is missing.
  assert.deepEqual(r.missing, []);
  // (9.23 F16: 586 missed 3100m and 4400m, two mats apart: its passes fit 22:28.8 as 5300m about as well as the finish,
  // so both sets, each one change, are offered, neither the one click; F15 sent "Missed 3100m" first, then asked)
  assert.deepEqual(r.checks.map((x) => [x.bib, x.fromName, x.toName, x.timeText, x.missed?.names ?? null]), [
    [a, '5300m', 'the finish', '24:17.3', ['5300m']], [b, '5300m', 'the finish', '24:15.4', ['5300m']],
    [d, '3100m', '4200m', '16:10.8', ['3100m', '4400m', '5300m']], [d, '4200m', 'the finish', '22:28.8', null], [d, '4400m', 'an extra pass', '26:22.1', null],
    [d, '5300m', 'an extra pass', '29:45.0', null]]);
  assert.deepEqual([r.checks[0].reason, r.checks[2].reason, r.checks[5].reason, r.checks[5].to],
    ['Looks like the finish, not 5300m (missed 5300m?)', "Looks like 4200m, not 3100m: Split Relay can't tell which (missed 3100m and 4400m, or 3100m, 4400m and 5300m?)",
      'An extra pass, not 5300m (it moves with the pass before it)', null]);
  assert.deepEqual([r.checks[2].missed.alt.names, r.checks[2].missed.alt.read, r.checks[2].missed.alt.effect],
    [['3100m', '4400m'], ['4200m'], '16:10.8 → 4200m, 22:28.8 → 5300m, 26:22.1 → extra pass (the finish), 29:45.0 → extra pass']);
  assert.deepEqual(s.sends.filter((p) => p.bib === d).map((p) => p.splitName), ['800m', '1500m', '2400m'], 'nothing of 586 went out a column early');
  assert.deepEqual(s.sends.filter((p) => p.bib === a).map((p) => p.splitName), ['800m', '1500m', '2400m', '3100m', '4200m', '4400m'], "nor 403's finish as 5300m");
  // 521 went out as counted (the operator kept its lone pass from the check queue on race day): it looks wrong, with
  // the same one fix
  assert.deepEqual(r.flags.map((f) => [f.bib, f.splitName, f.timeText, f.suggest?.toName ?? null, f.kind, f.missed?.names ?? null]), [
    [c, '3100m', '19:39.5', '5300m', 'long', ['3100m', '4200m', '4400m']]]);
  // (9.23 F15: the runners' leg to the split it looks like, 5300m, as Passes to check says it; not 2400m to 3100m)
  assert.equal(r.flags[0].text, 'You kept 19:39.5 in 3100m, but it looks like 5300m (missed 3100m, 4200m and 4400m?): 11:16 after 2400m, where runners of the same pace took 10:56.');
  assert.deepEqual([r.counts.flagged, r.counts.pinned, r.counts.madeUp, r.counts.checkRunners], [1, 1, 0, 3]);
  assert.equal(s.engine.raceView('w').review.flagged, 1);
  // kept from the check queue as counted (they went out so on race day), they look wrong as before
  const k = womens({ keep: RACE_DAY }).engine.review('w').flags;
  assert.deepEqual(k.map((f) => [f.bib, f.splitName, f.timeText, f.suggest?.toName ?? null, f.missed?.names ?? null]), [
    [a, '5300m', '24:17.3', 'the finish', ['5300m']], [b, '5300m', '24:15.4', 'the finish', ['5300m']],
    [c, '3100m', '19:39.5', '5300m', ['3100m', '4200m', '4400m']], [d, '3100m', '16:10.8', '4200m', ['3100m']]]);
  // (9.23 F15: their leg to 4200m, the split it looks like: F6 said 2:44, their leg to 3100m, as if it were to 4200m)
  assert.equal(k[3].text, 'You kept 16:10.8 in 3100m, but it looks like 4200m (missed 3100m?): 6:45 after 2400m, where runners of the same pace took 7:32.');
  // (9.23 F16: the finish form says the splits missed and the runners' leg to the finish, as Passes to check says it)
  assert.match(k[0].text, /^You kept 24:17\.3 in 5300m, but it looks like the finish \(missed 5300m\?\): 7:16 after 4400m, where runners of the same pace took 6:\d\d\.$/);
  // (9.23 F15: each is the one click, held or kept, as in F14: with a pass the column check holds, a placing with a leg
  // the look-wrong check would flag is no reason to doubt one whose every leg fits: 512's finish read as 5300m, a leg
  // 2.56 times the runners', 586's 16:10.8 left in 3100m, 2.47 times)
  assert.deepEqual([...r.checks.filter((x) => x.missed), ...r.flags].map((x) => [x.bib, x.missed.sure, x.missed.unsure]), [[a, true, null], [b, true, null], [d, false, null], [c, true, null]]);
  assert.deepEqual(k.map((f) => [f.bib, f.missed.sure, f.missed.unsure]), [[a, true, null], [b, true, null], [c, true, null], [d, true, null]]);
  const held = womens({ kept3100: false }).engine.review('w');
  assert.deepEqual(held.checks.filter((x) => x.missed).map((x) => [x.bib, x.missed.names.length, x.missed.sure]), [[a, 1, true], [b, 1, true], [c, 3, true], [d, 3, false]]);
  // the grid: the three held first (tier 0), 521 (tier 1, a flag), then the 8 runners with no read after their last
  // split (stopped)
  const g = s.engine.grid('w');
  assert.deepEqual(g.rows.slice(0, 4).map((x) => [x.bib, x.tier]), [[a, 0], [b, 0], [d, 0], [c, 1]]);
  assert.equal(g.counts.stopped, 8);
  assert.ok(g.rows.filter((x) => x.stopped).every((x) => x.tier === 7 && /^No read after \S+ \(\d+:\d\d\.\d\)$/.test(x.stopped.text)));
  assert.equal(g.finishPassStream, true, 'the stream carried the finish passes');
  assert.equal(g.finishSource, 'none');
  // nothing is made up for a runner who may have dropped out: Fill all has nothing
  assert.deepEqual(s.engine.addManual('w', { all: true }).added, []);
  // a grid the panel has is answered "unchanged"
  assert.deepEqual(s.engine.grid('w', { since: g.rev }), { rev: g.rev, unchanged: true });
});

test('9.23 F6/F13 two splits close together: a runner who missed 4200m is held at the pass counted there, not at the leg after it; kept, it is flagged there', () => {
  // bib 106 of the real race (its 4200m pass taken out): 15:32.0 (really 4400m, 200 m on) is counted as 4200m, 18:41.2
  // (5300m) as 4400m and the finish pass 21:38.2 as 5300m. Only the 4200m-4400m leg looks long, but the fix is to move
  // 15:32.0 to 4400m with the later times, not 18:41.2 to 5300m.
  const s = womens({ drop: { 106: [8770530] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // 9.23 F13: the column check (without the finish pass in 5300m) holds 15:32.0 and the later passes, rightly
  const r = s.engine.review('w');
  assert.deepEqual(r.checks.filter((x) => x.bib === '106').map((x) => [x.timeText, x.fromName, x.toName, x.reason]), [
    ['15:32.0', '4200m', '4400m', 'Looks like 4400m, not 4200m (missed 4200m?)'], ['18:41.2', '4400m', '5300m', 'Looks like 5300m, not 4400m (it moves with the pass before it)'],
    ['21:38.3', '5300m', 'the finish', 'Looks like the finish, not 5300m (it moves with the pass before it)']]);
  assert.deepEqual(s.sends.filter((p) => p.bib === '106').map((p) => p.splitName), ['800m', '1500m', '2400m', '3100m']);
  let v = s.engine.runner('w', '106');
  assert.deepEqual([v.missedHint.splitId, v.missedHint.count, v.missedHint.names, v.missedHint.sure, v.missedHint.alt, v.columns[4].missed.here, v.columns[4].missed.ok],
    ['s5', 1, ['4200m'], true, null, true, true]);
  assert.ok(Math.abs(v.columns[4].missed.splits[0].estimate - 8770530) < 30_000, formatRaceTime(v.columns[4].missed.splits[0].estimate, 1));
  // one change: 15:32.0 -> 4400m with the later times, 4200m filled; never sent before, every cell goes as new, the
  // furthest last, each with its laps to go
  const at = s.sends.length;
  const m = s.engine.addMissed('w', '106', { splitId: 's5', passTod: v.columns[4].passTod });
  assert.match(m.change.text, /^Missed 4200m added \(14:3\d\.\d, made up\); 15:32\.0 → 4400m, 18:41\.2 → 5300m; 21:38\.3 is an extra pass now \(the finish\)$/);
  assert.deepEqual(sentFrom(s, at, '106'), [['4200m', 3, 'new'], ['4400m', 2, 'new'], ['5300m', 1, 'new']]);
  v = s.engine.runner('w', '106');
  assert.deepEqual(v.columns.map((c) => c.kind), ['read', 'read', 'read', 'read', 'made-up', 'moved', 'moved']);
  assert.deepEqual(s.engine.review('w').checks.filter((x) => x.bib === '106'), []);
  // kept from the check queue as counted (as on race day): the look-wrong check flags the pass counted in 4200m, not
  // the leg after it, with the same one fix
  const k = womens({ drop: { 106: [8770530] }, keep: [106] });
  const f = k.engine.review('w').flags.find((x) => x.bib === '106');
  assert.deepEqual([f.splitName, f.timeText, f.suggest.toName, f.missed.names], ['4200m', '15:32.0', '4400m', ['4200m']]);
  assert.match(f.text, /^You kept 15:32\.0 in 4200m, but it looks like 4400m \(missed 4200m\?\): then 18:41\.2 fits 5300m\. As counted, 18:41\.2 comes 3:09 after 4200m, where runners of the same pace took 0:\d\d to 4400m\.$/);
  v = k.engine.runner('w', '106');
  assert.deepEqual([v.columns[4].flag.suggest.toName, v.problems.filter((x) => x.kind === 'flag').map((x) => x.col)], ['4400m', [4]]);
  // (15:32.0 alone fits 4200m about as well, as for any runner a little ahead of the runners nearest in time: the menu
  // marks no split "fits the pace" for a time that fits where it is)
  assert.deepEqual(passAt(v, '15:32.0').targets.filter((t) => t.best), []);
  assert.deepEqual(passAt(k.engine.runner('w', '117'), '14:11.9').targets.filter((t) => t.best), [], "the leader's right 4200m time");
  // the Move of 9.23 F2 still does the first half: 15:32.0 -> 4400m with the later times, 4200m missing
  const at2 = k.sends.length;
  const mv = k.engine.movePass('w', '106', { tod: f.passTod, to: f.suggest.to, from: f.splitId });
  assert.equal(mv.change.text, '15:32.0 moved to 4400m; 18:41.2 → 5300m; 21:38.3 is an extra pass now');
  assert.deepEqual(sentFrom(k, at2, '106'), [['4400m', 2, 'correction'], ['5300m', 1, 'correction']]);
  v = k.engine.runner('w', '106');
  assert.equal(v.columns[4].kind, 'missing');
  assert.deepEqual(v.columns.map((c) => c.how), ['counted', 'counted', 'counted', 'counted', null, 'moved', 'keep']);
});

test('9.23 F2/F4 the real race fixed: Move with the later times, fill, Move, fill; This is the finish; every packet in its column, the furthest last', () => {
  // (as on race day: the runners 9.23 F13 now holds went out a column early)
  const s = womens({ keep: RACE_DAY });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const { 403: a, 521: c, 586: d } = s.sh;
  const run = (bib) => s.engine.runner('w', bib);
  let v = run(d);
  const p1 = passAt(v, '16:10.8');
  // the menu says what each Move does before it is made, and which split fits the pace
  const to4200 = p1.targets.find((t) => t.splitName === '4200m');
  assert.deepEqual([to4200.ok, to4200.effect, to4200.best], [true, '22:28.8 → 4400m, 26:22.1 → 5300m, 29:45.0 → extra pass (the finish)', true]);
  assert.equal(p1.targets[0].why, "The pass at 16:10.8 can't be 800m: 3 earlier passes need the splits before it.");
  assert.equal(p1.targets[3].why, '16:10.8 is 3100m already.');
  assert.equal(p1.finishOk.effect, '22:28.8, 26:22.1 and 29:45.0 become after the finish');
  // the pace there: 16:10.8 fits 4200m; the first pass (2:47.1) as 5300m is far earlier than anybody's 5300m (the panel
  // asks first); as 800m it is where it is
  assert.deepEqual([p1.targets[4].pace, passAt(v, '2:47.1').targets[6].pace, passAt(v, '2:47.1').targets[1].pace], [null, 'early', 'early']);
  // Move: 16:10.8 is 4200m, and the later times move with it
  let at = s.sends.length;
  let r = s.engine.movePass('w', d, { tod: p1.tod, to: to4200.splitId, from: p1.splitId });
  assert.equal(r.change.text, '16:10.8 moved to 4200m; 22:28.8 → 4400m, 26:22.1 → 5300m; 29:45.0 is an extra pass now');
  assert.deepEqual(sentFrom(s, at, d), [['4200m', 3, 'correction'], ['4400m', 2, 'correction'], ['5300m', 1, 'correction']],
    'past the minute, in course order, each with its laps to go: the furthest (5300m) last');
  assert.deepEqual(r.change.leftover, [{ bib: d, splitName: '3100m', text: '16:10.8' }]);
  assert.deepEqual(r.change.sentTo, ['TrackScore']);
  // (9.24: the other runners' places at 4200m-5300m changed after their minute: they went out again by themselves)
  assert.deepEqual([r.change.staleOthers, r.change.resent.lines > 0, r.change.resent.outputs], [0, true, ['TrackScore']]);
  v = run(d);
  assert.deepEqual([v.columns[3].kind, formatRaceTime(v.columns[3].estimate, 1), v.columns[3].leftover.timeText], ['missing', '11:53.6', '16:10.8']);
  assert.deepEqual(v.passes.filter((p) => !p.inColumn).map((p) => [p.timeText, p.how]), [['29:45.0', 'extra']]);
  // fill 3100m (the suggestion): L2G 4; 4200m again with its new leg (LS from 3100m now, not 2400m); then the furthest
  // split again as a place update; the board's old cell is replaced
  at = s.sends.length;
  r = s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, ifEmpty: true });
  assert.deepEqual(sentFrom(s, at, d), [['3100m', 4, 'correction'], ['4200m', 3, 'place-update'], ['5300m', 1, 'place-update']]);
  const ls4200 = s.sends.slice(at).find((p) => p.bib === d && p.splitName === '4200m');
  assert.equal(formatRaceTime(ls4200.lsTicks, 1), formatRaceTime(ls4200.csTicks - r.added[0].raceTicks, 1));
  assert.equal(run(d).columns[3].leftover, null);
  // the next leg looks wrong now: 22:28.8 is 5300m (the finish is not a candidate: later passes exist)
  const f = s.engine.review('w').flags.find((x) => x.bib === d);
  assert.deepEqual([f.timeText, f.splitName, f.suggest.toName], ['22:28.8', '4400m', '5300m']);
  at = s.sends.length;
  r = s.engine.movePass('w', d, { tod: f.passTod, to: f.suggest.to, from: f.splitId });
  assert.equal(r.change.text, '22:28.8 moved to 5300m; 26:22.1 is an extra pass now');
  assert.deepEqual(sentFrom(s, at, d), [['5300m', 1, 'correction']]);
  v = run(d);
  at = s.sends.length;
  s.engine.addManual('w', { bib: d, splitId: v.columns[5].splitId, ifEmpty: true });
  assert.deepEqual(sentFrom(s, at, d), [['4400m', 2, 'correction'], ['5300m', 1, 'place-update']]);
  assert.deepEqual(run(d).columns.map((x) => [x.timeText, x.kind]), [['2:47.1', 'read'], ['5:20.6', 'read'], ['9:25.4', 'read'], ['11:53.6', 'made-up'],
    ['16:10.8', 'moved'], ['17:30.5', 'made-up'], ['22:28.8', 'moved']]);
  assert.deepEqual(s.engine.raceData('w').runners.get(d).splits.map((t) => formatRaceTime(t, 1)), ['2:47.1', '5:20.6', '9:25.4', '11:53.6', '16:10.8', '17:30.5', '22:28.8']);
  // 403: the finish went out as 5300m. This is the finish: nothing goes live (the finish is FinishLynx's), 5300m is
  // missing, but with no finish place known it can't be sent
  v = run(a);
  at = s.sends.length;
  r = s.engine.movePass('w', a, { tod: passAt(v, '24:17.3').tod, to: 'finish' });
  assert.equal(r.change.text, '24:17.3 is the finish now');
  assert.deepEqual(sentFrom(s, at, a), []);
  v = run(a);
  assert.deepEqual([v.finished, v.finishBy, v.finishText, v.columns[6].kind, v.columns[6].leftover.timeText], [true, 'marked', '24:17.3', 'blocked', '24:17.3']);
  // (9.23 F18: the finish the operator marked, no place known: the words say the way out, the last split's one click)
  assert.equal(v.columns[6].why, `Bib ${a} has finished: you marked 24:17.3 as its finish, and Split Relay doesn't know a finish place for it. `
    + `A finisher's splits go out with the finish place, so nothing of bib ${a}'s can go live. To send it: choose "Missed 5300m: add it" (24:17.3 is the finish pass again, not the finish).`);
  const fin = s.engine.feed(1000).find((e) => e.bib === a && e.raceTicks === passAt(v, '24:17.3').raceTicks);
  assert.deepEqual([fin.status, fin.detail], ['finish', MARKED_FINISH_TEXT]);
  // 521: the kept lone pass is 5300m
  v = run(c);
  at = s.sends.length;
  s.engine.movePass('w', c, { tod: passAt(v, '19:39.5').tod, to: v.columns[6].splitId });
  assert.deepEqual(sentFrom(s, at, c), [['5300m', 1, 'new']]);
  assert.deepEqual(s.engine.review('w').flags.map((x) => x.bib), [s.sh[512]]);
  // after a stop and a start, everything is as it was, and the newest change can be undone
  s.clock.advance(1000);
  const cross = (e) => e.crossings('w').map((x) => [x.bib, x.splitId, x.tod, x.raceTicks, x.place, x.reads, x.source, x.held]);
  const before = cross(s.engine);
  const t = s.restart();
  assert.deepEqual(cross(t.engine), before);
  assert.deepEqual(t.engine.runner('w', d).changes.map((x) => [x.kind, x.undoable]), [['fill', true], ['move', false], ['fill', false], ['move', false], ['check', false]]);
  // Undo the 4400m fill: TrackScore keeps 17:30.5 there (a packet can't empty a cell): asked first
  const last = t.engine.runner('w', d).changes[0].fix;
  assert.throws(() => t.engine.undo('w', { fix: last }), (err) => err.status === 409 && err.code === 'UNDO_LEAVES'
    && err.message === 'TrackScore keeps 17:30.5 at 4400m (bib 169): a packet can fill a cell but never empty one. Undo anyway?'
    && JSON.stringify(err.leaves) === JSON.stringify([{ bib: d, splitName: '4400m', text: '17:30.5' }]));
  const u = t.engine.undo('w', { fix: last, confirm: true });
  assert.deepEqual([u.undone, u.change.kind, u.change.text, u.change.leaves], [last, 'undo', 'Undone: the made-up 4400m time (17:30.5) taken back', [{ bib: d, splitName: '4400m', text: '17:30.5' }]]);
  assert.equal(t.engine.runner('w', d).columns[5].kind, 'missing');
  // Redo: the undo of the Undo puts it back exactly. The board has the 4400m cell already; 5300m goes again, with its
  // leg from 4400m again (LS: the Undo sent it with its leg from 4200m)
  at = t.sends.length;
  const redo = t.engine.undo('w', { fix: u.change.fix });
  assert.equal(redo.change.text, 'Done again: 4400m 17:30.5 made up');
  assert.equal(t.engine.runner('w', d).columns[5].timeText, '17:30.5');
  assert.deepEqual(sentFrom(t, at, d), [['5300m', 1, 'place-update']]);
  const p5300 = t.sends.slice(at).find((p) => p.bib === d);
  assert.equal(p5300.lsTicks, p5300.csTicks - t.engine.runner('w', d).columns[5].time);
});

test('9.23 F2 Not a split: a stray pass takes no column, the later passes move back and go out as corrections; read by read = rebuild = restart', () => {
  const s = setup();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  field(s);
  // bib 105: a stray pass 30 s after its 2K (a runner crossing back over the mat): counted as 3K, its 3K as 4K
  s.lap(105, raceTimeText(timeOf(105, 2) / S + 30));
  s.clock.advance(70_000);
  const stray = timeOf(105, 2) + 30 * S;
  let v = s.engine.runner('r', '105');
  assert.deepEqual(v.columns.map((c) => c.time), [timeOf(105, 1), timeOf(105, 2), stray, timeOf(105, 3)]);
  // its leg is far too short: a stray pass (advice; nothing is held)
  const f = s.engine.review('r').flags[0];
  assert.deepEqual([f.bib, f.splitName, f.kind, f.suggest.to], ['105', '3K', 'short', 'none']);
  assert.ok(f.text.startsWith(`${formatRaceTime(stray, 1)} comes soon after 2K (0:30; runners of the same pace took 3:`) && f.text.endsWith('). A stray pass?'), f.text);
  const at = s.sends.length;
  const r = s.engine.movePass('r', '105', { tod: passAt(v, formatRaceTime(stray, 1)).tod, to: 'none', from: 's3' });
  assert.equal(r.change.text, `${formatRaceTime(stray, 1)} is not a split now; ${formatRaceTime(timeOf(105, 3), 1)} → 3K, ${formatRaceTime(timeOf(105, 4), 1)} → 4K`);
  assert.deepEqual(sentFrom(s, at, 105), [['3K', 2, 'correction'], ['4K', 1, 'correction']], 'corrections though first sent more than a minute ago');
  v = s.engine.runner('r', '105');
  assert.deepEqual(v.columns.map((c) => c.time), [timeOf(105, 1), timeOf(105, 2), timeOf(105, 3), timeOf(105, 4)]);
  const p = passAt(v, formatRaceTime(stray, 1));
  assert.deepEqual([p.how, p.howText, p.pinned, p.inColumn], ['ignored', 'Not a split: set aside in Review.', 'none', false]);
  const row = s.engine.feed(1000).find((e) => e.bib === '105' && e.raceTicks === stray);
  assert.deepEqual([row.status, row.detail], ['ignored', IGNORED_TEXT]);
  assert.equal(s.engine.raceView('r').extra, 0, "'ignored' is not one of the counted outcomes");
  // the journal: one record of the 9.23 kind, which an older Split Relay reads as a Keep
  const recs = journalOf(s).filter((x) => x.fix === r.change.fix);
  assert.deepEqual(recs.map((x) => [x.t, x.as, x.splitId, x.fixKind, x.fixText]), [['assign', 'none', null, 'none', r.change.text]]);
  const snap = (e) => [e.crossings('r').map((x) => [x.bib, x.splitId, x.tod, x.place, x.source, x.held]), e.raceData('r'), e.review('r'), e.runner('r', '105').passes];
  const now = snap(s.engine);
  s.config.races[0].splits[0].sources.push('Never');
  s.engine.configChanged();
  s.config.races[0].splits[0].sources.pop();
  s.engine.configChanged();
  assert.deepEqual(snap(s.engine), now, 'a rebuild agrees');
  const t = s.restart();
  assert.deepEqual(snap(t.engine), now, 'a restart agrees');
  // "Let Split Relay count it": counted again where counting puts it
  const back = t.engine.movePass('r', '105', { tod: p.tod, to: 'count' });
  assert.equal(back.change.text, `${formatRaceTime(stray, 1)} is counted again (3K); ${formatRaceTime(timeOf(105, 3), 1)} → 4K; ${formatRaceTime(timeOf(105, 4), 1)} is an extra pass now`);
  assert.throws(() => t.engine.movePass('r', '105', { tod: p.tod, to: 'count' }), (err) => err.status === 404
    && err.message === `Nothing is set in Review for the pass at ${formatRaceTime(stray, 1)}. Reload the runner.`);
});

test('9.23 F2 This is the finish: the runner has finished, the split before is missing; one marked finish; the refusals', () => {
  // the stream carries the finish: every runner passes 1K-4K and the finish (5K); bib 103 missed 4K
  const s = setup();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  field(s, { skip: { 103: [4] } });
  for (let i = 0; i < 12; i++) s.lap(100 + i, raceTimeText(900 * (1 + 0.02 * i)));
  s.clock.advance(70_000);
  let v = s.engine.runner('r', '103');
  const finT = Math.round(900 * 1.06 * S);
  assert.equal(v.columns[3].time, finT, 'its finish is counted as 4K');
  // 9.23 F13: the column check holds it (the finish as a column: the stream carries finish passes), so it never goes
  // out as 4K; its one fix is "Missed 4K: add it"
  assert.deepEqual([v.columns[3].held, sentOf(s, 103).map((x) => x[0])], ['check', ['1K', '2K', '3K']]);
  assert.deepEqual(s.engine.review('r').checks.map((c) => [c.bib, c.fromName, c.toName, c.reason, c.missed?.names]),
    [['103', '4K', 'the finish', 'Looks like the finish, not 4K (missed 4K?)', ['4K']]]);
  assert.deepEqual(s.engine.review('r').flags, []);
  // a FinishLynx finish far from it: refused
  s.lynx.set('103', finT + 60 * S);
  s.engine.converge();
  const p = passAt(v, formatRaceTime(finT, 1));
  assert.throws(() => s.engine.movePass('r', '103', { tod: p.tod, to: 'finish' }), (err) => err.status === 409
    && err.message === `FinishLynx has bib 103's finish at ${formatRaceTime(finT + 60 * S, 1)}, so ${formatRaceTime(finT, 1)} can't be the finish. Choose Not a split instead.`);
  // FinishLynx's within 10 s: allowed (a pass a hair before FinishLynx's finish)
  s.lynx.set('103', finT + 3 * S);
  s.engine.converge();
  const at = s.sends.length;
  let r = s.engine.movePass('r', '103', { tod: p.tod, to: 'finish', from: 's4' });
  assert.equal(r.change.text, `${formatRaceTime(finT, 1)} is the finish now`);
  assert.deepEqual(sentFrom(s, at, 103), [], 'a finish never makes a packet');
  v = s.engine.runner('r', '103');
  assert.deepEqual([v.finished, v.finishBy, v.columns[3].kind], [true, 'marked', 'blocked']);
  assert.match(v.columns[3].why, /^Bib 103 has finished, but Split Relay doesn't know the finish place/);
  assert.throws(() => s.engine.addManual('r', { bib: '103', splitId: 's4' }), (err) => err.status === 409 && /doesn't know the finish place/.test(err.message));
  // with FinishLynx's place: sent with P = the finish place, and in the .lif
  s.places.set('103', 4);
  s.engine.converge();
  const at2 = s.sends.length;
  const added = s.engine.addManual('r', { bib: '103', splitId: 's4', ifEmpty: true }).added[0];
  assert.deepEqual(s.sends.slice(at2).filter((x) => x.bib === '103').map((x) => [x.splitName, x.place, x.lapsToGo]), [['4K', 4, 1]]);
  assert.equal(s.engine.raceData('r').runners.get('103').splits[3], added.raceTicks);
  // the made-up 4K comes after the 3K pass: that pass can't be the finish now
  const p3 = passAt(v, formatRaceTime(timeOf(103, 3), 1));
  assert.throws(() => s.engine.movePass('r', '103', { tod: p3.tod, to: 'finish' }), (err) => err.status === 409
    && err.message === `${formatRaceTime(timeOf(103, 3), 1)} can't be the finish: the made-up 4K time (${added.timeText}) comes after it. Remove that first.`);
  // a finish read from the mat
  const s2 = setup({ races: [lapRace({ finishSources: ['Finish'] })] });
  field(s2, { skip: { 103: [4] } });
  s2.engine.handleRead({ location: 'Finish', bib: '103', tod: GUN + finT + 5 * S, contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
  const v2 = s2.engine.runner('r', '103');
  assert.throws(() => s2.engine.movePass('r', '103', { tod: v2.passes[2].tod, to: 'finish' }), (err) => err.status === 409
    && err.message === `Bib 103 has a finish read from the finish mat (${formatRaceTime(finT + 5 * S, 1)}).`);
  void r;
});

test('9.23 F2 Move only this time: the other passes are held where they are; its refusals', () => {
  const s = setup();
  // bib 105 on the course: passes at 1K and 2K only
  field(s, { upTo: 400 });
  s.clock.advance(70_000);
  const v = s.engine.runner('r', '105');
  const p1 = v.passes[0];
  assert.throws(() => s.engine.movePass('r', '105', { tod: p1.tod, to: 's2', only: true }), (err) => err.status === 409 && err.message
    === `Only this time can't go to 2K: ${formatRaceTime(timeOf(105, 2), 1)} is there. Move it with the later times instead, or choose Not a split for ${formatRaceTime(timeOf(105, 2), 1)} first.`);
  assert.throws(() => s.engine.movePass('r', '105', { tod: p1.tod, to: 's3', only: true }), (err) => err.status === 409 && err.message
    === `Only this time can't go to 3K: ${formatRaceTime(timeOf(105, 2), 1)} (2K) is later, so it would have to come after it.`);
  // only the 2K pass to 3K: the 1K pass is held in 1K
  const r = s.engine.movePass('r', '105', { tod: v.passes[1].tod, to: 's3', only: true });
  assert.equal(r.change.text, `Only ${formatRaceTime(timeOf(105, 2), 1)} moved (to 3K)`);
  const w = s.engine.runner('r', '105');
  assert.deepEqual(w.passes.map((p) => [p.splitName, p.how, p.pinned]), [['1K', 'hold', 'hold'], ['3K', 'moved', 'move']]);
  assert.equal(w.passes[0].howText, '1K: kept there in Review.');
  assert.deepEqual(journalOf(s).filter((x) => x.fix === r.change.fix).map((x) => [x.t, x.splitId, x.as ?? null]), [['assign', 's3', null], ['assign', 's1', 'hold']]);
  // the column check takes held passes as the operator's
  assert.deepEqual(s.engine.review('r').checks, []);
});

test('9.23 F2 a Move onto a made-up time replaces it in the same change; Undo puts it back with its own journal position', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  const made = s.engine.addManual('r', { bib: '105', splitId: 's2' });
  const rec0 = journalOf(s).find((x) => x.t === 'manual');
  s.clock.advance(70_000);
  // the 1K pass to 2K: the made-up 2K gives way (else counting would put the pass after it, in no column)
  const v = s.engine.runner('r', '105');
  const r = s.engine.movePass('r', '105', { tod: v.passes[0].tod, to: 's2' });
  assert.deepEqual(journalOf(s).filter((x) => x.fix === r.change.fix).map((x) => [x.t, x.splitId]), [['unmanual', 's2'], ['assign', 's2']]);
  assert.deepEqual(s.engine.runner('r', '105').columns.map((c) => [c.time, c.kind]), [[null, 'missing'], [timeOf(105, 1), 'moved'], [timeOf(105, 3), 'moved'], [timeOf(105, 4), 'moved']]);
  // a real 2K read comes in late (after the made-up time was made)
  s.lap(105, raceTimeText(timeOf(105, 2) / S));
  const u = s.engine.undo('r', { fix: r.change.fix, confirm: true });
  // (what the Undo did: the pass back in 1K, the late real read in 2K; the made-up 2K time it put back is replaced by it)
  assert.equal(u.change.text, `Undone: ${formatRaceTime(timeOf(105, 1), 1)} is the 1K split again; ${formatRaceTime(timeOf(105, 2), 1)} → 2K`);
  const back = journalOf(s).filter((x) => x.fix === u.change.fix && x.t === 'manual');
  assert.deepEqual(back.map((x) => [x.seq, x.at, x.raceTicks, x.estimated, x.basis, x.restored]), [[rec0.seq, rec0.at, rec0.raceTicks, rec0.estimated, rec0.basis, true]]);
  // the made-up time is back as it was; the read that came after it was made takes its place, as it would have
  const w = s.engine.runner('r', '105');
  assert.deepEqual(w.columns.map((c) => [c.time, c.source]), [[timeOf(105, 1), 'read'], [timeOf(105, 2), 'read'], [timeOf(105, 3), 'read'], [timeOf(105, 4), 'read']]);
  assert.equal(s.engine.review('r').manual[0].state, 'replaced');
  void made;
});

test('9.23 F2 "Let Split Relay count it" after a Move: the decision is forgotten, and the column check can ask again', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  const checks = s.engine.review('r').checks;
  assert.equal(checks.length, 2);
  s.engine.assign('r', { bib: '105', all: 'move' });
  assert.deepEqual(s.engine.review('r').checks, []);
  for (const c of checks) s.engine.movePass('r', '105', { tod: c.passTod, to: 'count' });
  assert.deepEqual(s.engine.runner('r', '105').passes.map((p) => p.pinned), [null, null, null]);
  assert.equal(s.engine.review('r').checks.length, 2, 'held again');
  assert.deepEqual(journalOf(s).filter((x) => x.t === 'unassign').map((x) => x.bib), ['105', '105']);
});

test('9.23 F2 a change that would not hold is put back and refused in words: nothing journaled or sent', () => {
  // 3K is a timing point; the others are passes. Bib 105's pass after the 3K mat read is out of course order at 2K.
  const races = [lapRace({ splits: [{ id: 's1', name: '1K', sources: [], earliest: '' }, { id: 's2', name: '2K', sources: [], earliest: '' },
    { id: 's3', name: '3K', sources: ['3K-A'], earliest: '' }, { id: 's4', name: '4K', sources: [], earliest: '' }] })];
  const s = setup({ races });
  // bib 105 missed 2K; its pass a minute after its 3K mat read is counted as 2K: out of course order
  field(s, { splits: 2, skip: { 105: [2] } });
  for (let i = 0; i < 12; i++) s.engine.handleRead({ location: '3K-A', bib: String(100 + i), tod: GUN + timeOf(100 + i, 3), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
  const lateT = timeOf(105, 3) + 60 * S;
  s.lap(105, raceTimeText(lateT / S));
  s.clock.advance(70_000);
  const v = s.engine.runner('r', '105');
  const late = v.passes[1];
  assert.equal(late.how, 'out-of-order');
  const before = { journal: s.store.journal.length, sends: s.sends.length, crossings: s.engine.crossings('r'), runner: s.engine.runner('r', '105') };
  // to 3K: a mat read says which split it is
  assert.throws(() => s.engine.movePass('r', '105', { tod: late.tod, to: 's3' }), (err) => err.status === 409
    && err.message === '3K has a read from the 3K-A mat for bib 105: its time is known.');
  // to 2K: the rules allow it, but 2K after the 3K mat read is out of course order: the post-condition puts it all back
  assert.throws(() => s.engine.movePass('r', '105', { tod: late.tod, to: 's2', from: '' }), (err) => err.status === 409
    && err.message === `Split Relay couldn't put ${formatRaceTime(lateT, 1)} in 2K (out of course order). Nothing was changed.`);
  assert.deepEqual({ journal: s.store.journal.length, sends: s.sends.length, crossings: s.engine.crossings('r'), runner: s.engine.runner('r', '105') }, before);
  assert.deepEqual(s.engine.runner('r', '105').changes, []);
});

test('9.23 F3 Undo: only the newest change of a runner, once; after a Clear in words; a Fill in N undoes the runners that still match', () => {
  const s = setup();
  field(s, { skip: { 104: [2], 106: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '104', all: 'move' });
  s.engine.assign('r', { bib: '106', all: 'move' });
  const many = s.engine.addManual('r', { items: [{ bib: '104', splitId: 's2', ifEmpty: true }, { bib: '106', splitId: 's2', ifEmpty: true }] });
  assert.deepEqual([many.change.kind, many.change.bibs], ['fill-many', ['104', '106']]);
  // bib 106 changed since: its made-up time typed again
  const typed = s.engine.addManual('r', { bib: '106', splitId: 's2', time: raceTimeText(timeOf(106, 2) / S) });
  assert.equal(typed.change.kind, 'change-time');
  assert.throws(() => s.engine.undo('r', { fix: many.change.fix - 1 }), (err) => err.status === 409 && /^Bib 106 was changed after this \(/.test(err.message));
  const u = s.engine.undo('r', { fix: many.change.fix, confirm: true });
  assert.deepEqual([u.change.bibs, u.change.notes], [['104'], ['Bib 106 was changed since: not undone.']]);
  assert.equal(s.engine.runner('r', '104').columns[1].kind, 'missing');
  assert.equal(s.engine.runner('r', '106').columns[1].kind, 'typed');
  assert.throws(() => s.engine.undo('r', { fix: many.change.fix }), (err) => err.status === 409 && err.message === 'That change was undone already.');
  assert.throws(() => s.engine.undo('r', {}), (err) => err.status === 400 && err.message === 'Send { "fix": 17 }: the change to undo.');
  // a Clear forgets the changes: an Undo then says so
  s.engine.clearRace('r');
  assert.throws(() => s.engine.undo('r', { fix: typed.change.fix }), (err) => err.status === 404
    && err.message === `There is no change ${typed.change.fix} in Boys 5K (the race was cleared since). Change it by hand.`);
  assert.throws(() => s.engine.undo('r', { fix: 999 }), (err) => err.status === 404 && err.message === 'There is no change 999 in Boys 5K. Change it by hand.');
});

test('9.23 F4 what the operator approved goes out after the minute, also to an output that was down; never a finisher\'s split; not for a race that is not Active', () => {
  let down = false;
  const got = [];
  const net = { got, hold: new Set(), deliver(id, p, ack) {
    if (down) return false;
    got.push(p);
    ack(true);
    return true;
  } };
  const s = setup({ net });
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.clock.advance(70_000);
  // the output is down when the fill is approved
  down = true;
  s.engine.addManual('r', { bib: '105', splitId: 's2', time: raceTimeText(timeOf(105, 2) / S) });
  const at = got.length;
  down = false;
  s.clock.advance(70_000);
  // back up (its status changes): the approved time goes out though its cell's first copy is minutes old, then the
  // runner's furthest split (TrackScore takes the runner's place from the newest packet)
  s.engine.converge([{ id: 'o1', enabled: true, state: 'connected', scriptOk: true, clients: 1 }]);
  // (9.23 F13: 3K again too, its leg (LS) from the 2K it never had before)
  assert.deepEqual(got.slice(at).filter((p) => p.bib === '105').map((p) => [p.splitName, p.reason]), [['2K', 'new'], ['3K', 'place-update'], ['4K', 'place-update']]);
  // a finisher: a Move of a real pass goes to the .lif only, then waits for Send with finish place
  s.lynx.set('104', Math.round(900 * 1.08 * S));
  s.places.set('104', 5);
  s.engine.converge();
  const v = s.engine.runner('r', '104');
  const at2 = got.length;
  const r = s.engine.movePass('r', '104', { tod: v.passes.find((p) => p.splitName === '3K').tod, to: 's4' });
  assert.deepEqual(got.slice(at2).filter((p) => p.bib === '104'), []);
  assert.deepEqual(r.change.notLive.map((x) => [x.splitName, x.why]), [['4K', 'has finished: use Send with finish place']]);
  assert.deepEqual(s.engine.review('r').finishedNotSent.map((x) => [x.bib, x.splitName]), [['104', '4K']]);
  // ... or, when the operator said so first (the panel asks), at once with the finish place, as Send with finish place
  s.engine.undo('r', { fix: r.change.fix, confirm: true });
  const at4 = got.length;
  const r2 = s.engine.movePass('r', '104', { tod: v.passes.find((p) => p.splitName === '3K').tod, to: 's4', withFinishPlace: true });
  assert.deepEqual(got.slice(at4).filter((p) => p.bib === '104').map((p) => [p.splitName, p.place, p.reason]), [['4K', 5, 'correction']]);
  assert.deepEqual([r2.change.notLive, r2.change.sentTo], [[], ['TrackScore']]);
  assert.deepEqual(s.engine.review('r').finishedNotSent, []);
  // a race that is not Active: the .lif only
  s.config.races[0].active = false;
  s.engine.configChanged();
  const at3 = got.length;
  const w = s.engine.runner('r', '103');
  const m = s.engine.movePass('r', '103', { tod: w.passes[3].tod, to: 'none' });
  assert.deepEqual(got.slice(at3), []);
  assert.equal(m.change.lifOnly, true);
  assert.equal(s.engine.raceData('r').runners.get('103').splits[3], null);
  assert.throws(() => s.engine.sendRunner('r', '103'), (err) => err.status === 409 && err.message === 'Boys 5K is not Active: nothing goes live. Tick Active first.');
});

test('9.23 F4 the runner\'s place on the boards: an Undo or a Redo that sends no split still ends with the runner\'s furthest split', () => {
  // TrackScore takes a runner's place from the newest packet. Bib 61 stopped after 4200m (17:08.3).
  const s = womens();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const bib = '61';
  const v = s.engine.runner('w', bib);
  const p = passAt(v, '17:08.3');
  let at = s.sends.length;
  const mv = s.engine.movePass('w', bib, { tod: p.tod, to: v.columns[5].splitId, from: v.columns[4].splitId });
  assert.deepEqual(sentFrom(s, at, bib), [['4400m', 2, 'new']]);
  // Undo: 4200m is back, and the board has it as it is (nothing to send for it); but the board's newest packet of bib 61
  // is the 4400m one, whose place TrackScore shows: 4200m goes again, as a place update
  at = s.sends.length;
  const u = s.engine.undo('w', { fix: mv.change.fix, confirm: true });
  assert.deepEqual(sentFrom(s, at, bib), [['4200m', 3, 'place-update']]);
  // (9.24: the other runners' lines whose place the Undo moved follow it by themselves: the runner's own newest line)
  assert.equal(s.sends.filter((x) => x.bib === bib).at(-1).place, s.engine.runner('w', bib).columns[4].place);
  assert.deepEqual(u.change.sentTo, ['TrackScore']);
  // Redo (it empties 4200m again: asked first): the 4400m cell is the board's already; its place goes again, so
  // TrackScore shows the runner's 4400m place
  at = s.sends.length;
  s.engine.undo('w', { fix: u.change.fix, confirm: true });
  assert.deepEqual(sentFrom(s, at, bib), [['4400m', 2, 'place-update']]);
  // "Send again" when the boards have every split as it is, and the runner's place: nothing
  at = s.sends.length;
  assert.equal(s.engine.sendRunner('w', bib).sent, 0);
  assert.deepEqual(sentFrom(s, at, bib), []);
});

test('9.23 F4 a fill on a paused split goes out on Play, whatever the minute says, and the runner\'s furthest split after it', () => {
  // (as on race day: the runners 9.23 F13 now holds went out a column early)
  const s = womens({ keep: RACE_DAY });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const d = s.sh[586];
  let v = s.engine.runner('w', d);
  s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId });
  const sp = s.config.races[0].splits;
  sp[3].sending = false;
  s.engine.configChanged();
  v = s.engine.runner('w', d);
  let at = s.sends.length;
  const r = s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, time: '11:50.0', ifEmpty: true });
  assert.deepEqual(r.change.notLive.map((x) => [x.splitName, x.why]), [['3100m', '3100m is paused']]);
  assert.deepEqual(sentFrom(s, at, d), []);
  // Play, minutes later: the 3100m cell was first sent long ago, but the operator approved this time for it
  s.clock.advance(180_000);
  at = s.sends.length;
  sp[3].sending = true;
  s.engine.configChanged();
  s.clock.advance(100);
  // (4200m again too: its leg (LS) is from 3100m now, not from 2400m)
  assert.deepEqual(sentFrom(s, at, d), [['3100m', 4, 'correction'], ['4200m', 3, 'place-update'], ['5300m', 1, 'place-update']]);
  assert.equal(formatRaceTime(s.sends.slice(at).find((p) => p.bib === d).csTicks, 1), '11:50.0');
  assert.equal(formatRaceTime(s.sends.slice(at).find((p) => p.bib === d && p.splitName === '4200m').lsTicks, 1), '4:20.8');
  assert.equal(s.engine.runner('w', d).columns[3].stale, null);
});

test('9.23 F4 the real 3100m read that comes in seconds after the fill replaces it on the boards too (586: Move, fill, the late read)', () => {
  // (as on race day: the runners 9.23 F13 now holds went out a column early)
  const s = womens({ keep: RACE_DAY });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const d = s.sh[586];
  let v = s.engine.runner('w', d);
  s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId });
  v = s.engine.runner('w', d);
  s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, ifEmpty: true });
  assert.equal(s.engine.runner('w', d).columns[3].timeText, '11:53.6');
  // the 3100m cell was first sent minutes ago (16:10.8, before the Move); the made-up time went in just now
  s.clock.advance(15_000);
  const at = s.sends.length;
  const real = parseRaceTime('11:49.6');
  s.engine.handleRead({ location: '', bib: d, tod: GUN + real, contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
  s.clock.advance(100);
  assert.deepEqual(s.engine.runner('w', d).columns[3].kind, 'replaces');
  // 3100m with the real time; 4200m again, its leg (LS) now from the real time (TrackScore does not read it, Karmarush
  // shows it); then the runner's furthest split last
  assert.deepEqual(sentFrom(s, at, d), [['3100m', 4, 'correction'], ['4200m', 3, 'place-update'], ['5300m', 1, 'place-update']]);
  assert.equal(s.sends.slice(at).find((p) => p.bib === d).csTicks, real);
  const p4200 = s.sends.slice(at).find((p) => p.bib === d && p.splitName === '4200m');
  assert.deepEqual([p4200.lsTicks, formatRaceTime(p4200.lsTicks, 3)], [p4200.csTicks - real, '4:21.193']);
  assert.equal(s.engine.runner('w', d).columns[3].stale, null);
  const row = s.engine.feed(50).find((e) => e.bib === d && e.raceTicks === real);
  assert.equal(row.status, 'corrected');
  assert.match(row.detail, /^Real read replaced the made-up time \(3\.957 s earlier\): re-sent as place \d+ with the real time\.$/);
  // and after a restart within the minute, the same
  const t = s.restart();
  assert.equal(t.engine.runner('w', d).columns[3].stale, null);
});

test('9.23 F11 a real read that replaces a made-up time inside the cell\'s first minute: the next split\'s leg and the runner\'s furthest split go again', () => {
  // bib 224 of the race-day check (no reads in the copy): four passes, 16:04.0 moved to 4200m, 3100m filled; seconds
  // later the real 3100m read, all inside the minute of the cell's first packet (16:04.0 as 3100m)
  const s = womens();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const bib = '224';
  const read = (t) => s.engine.handleRead({ location: '', bib, tod: GUN + parseRaceTime(t), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
  for (const t of ['2:52.0', '5:31.0', '9:24.0', '16:04.0']) read(t);
  s.clock.advance(100);
  let v = s.engine.runner('w', bib);
  assert.deepEqual(v.columns.map((c) => c.timeText), ['2:52.0', '5:31.0', '9:24.0', '16:04.0', '', '', '']);
  s.engine.movePass('w', bib, { tod: passAt(v, '16:04.0').tod, to: v.columns[4].splitId, from: v.columns[3].splitId });
  s.clock.advance(5000);
  v = s.engine.runner('w', bib);
  s.engine.addManual('w', { bib, splitId: v.columns[3].splitId, time: '11:50.0', ifEmpty: true });
  s.clock.advance(6000);
  const at = s.sends.length;
  read('11:58.0');
  s.clock.advance(100);
  // 3100m with the real time; then 4200m, its leg (LS) from the real 3100m and the runner's furthest split, whose place
  // TrackScore shows (before: only 3100m went, and TrackScore showed the runner's 3100m place)
  assert.deepEqual(sentFrom(s, at, bib), [['3100m', 4, 'correction'], ['4200m', 3, 'place-update']]);
  const [p3100, p4200] = s.sends.slice(at).filter((p) => p.bib === bib);
  assert.deepEqual([formatRaceTime(p3100.csTicks, 1), formatRaceTime(p4200.lsTicks, 3)], ['11:58.0', '4:06.000']);
  assert.equal(s.sends.filter((p) => p.bib === bib).at(-1).splitName, '4200m');
  assert.equal(s.engine.runner('w', bib).columns[4].stale, null);
  // a correction the relay makes by itself is as before: the minute of the 3100m cell over, a backup read changes nothing
  s.clock.advance(120_000);
  const at2 = s.sends.length;
  read('11:58.3');
  s.clock.advance(100);
  assert.deepEqual(sentFrom(s, at2, bib), []);
});

test('9.23 F4 a finisher\'s change sent with the finish place: every cell it changes goes live with that place, one never sent before too; its Undo and Redo the same way', () => {
  // (as on race day: the runners 9.23 F13 now holds went out a column early)
  const s = womens({ keep: RACE_DAY });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const { 521: c, 586: d } = s.sh;
  // FinishLynx has finished them (test places, after the race's last read: their splits went out before the finish):
  // 521 76th, 586 140th
  s.lynx.set(c, parseRaceTime('31:00.0'));
  s.places.set(c, 76);
  s.lynx.set(d, parseRaceTime('31:30.0'));
  s.places.set(d, 140);
  s.engine.converge();
  const sentP = (eng, sends, at, bib) => sends.slice(at).filter((p) => p.bib === bib).map((p) => [p.splitName, p.lapsToGo, p.place, p.reason]);
  // 521: its lone pass to 5300m, a cell no output ever had: it goes with the finish place (before: nothing went, and
  // the cell waited in "Finished: not sent live")
  let v = s.engine.runner('w', c);
  let at = s.sends.length;
  const r = s.engine.movePass('w', c, { tod: passAt(v, '19:39.5').tod, to: v.columns[6].splitId, only: true, withFinishPlace: true });
  assert.deepEqual(sentP(s.engine, s.sends, at, c), [['5300m', 1, 76, 'new']]);
  assert.deepEqual([r.change.sentTo, r.change.notLive, r.change.lifOnly], [['TrackScore'], [], false]);
  v = s.engine.runner('w', c);
  assert.deepEqual([v.columns[6].finishedNotSent, v.columns[6].delivered], [false, true]);
  assert.deepEqual(s.engine.review('w').finishedNotSent.filter((x) => x.bib === c), []);
  // its Undo goes the same way: 19:39.5 is 3100m again, with the finish place (the board had it with its 3100m place)
  at = s.sends.length;
  const u = s.engine.undo('w', { fix: r.change.fix, confirm: true });
  assert.equal(u.change.text, 'Undone: 19:39.5 is the 3100m split again');
  assert.deepEqual(sentP(s.engine, s.sends, at, c), [['3100m', 4, 76, 'place-update']]);
  assert.deepEqual([u.change.sentTo, u.change.lifOnly, u.change.finishKept], [['TrackScore'], false, []]);
  // ... and its Redo: the board has 5300m as it is already; nothing to send, nothing waits
  at = s.sends.length;
  const rd = s.engine.undo('w', { fix: u.change.fix, confirm: true });
  assert.deepEqual([sentP(s.engine, s.sends, at, c), rd.change.notLive, rd.change.lifOnly], [[], [], false]);
  // 586, cells the boards had: Move 16:10.8 to 4200m with the later times, every changed cell with P 140 and no split
  // place after them
  v = s.engine.runner('w', d);
  at = s.sends.length;
  const m = s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId, withFinishPlace: true });
  assert.deepEqual(sentP(s.engine, s.sends, at, d), [['4200m', 3, 140, 'correction'], ['4400m', 2, 140, 'correction'], ['5300m', 1, 140, 'correction']]);
  assert.equal(journalOf(s).find((x) => x.fix === m.change.fix && x.fixKind).byFinish, true);
  // after a stop and a start (the change says it went with the finish place: the journal has it), its Undo too
  s.clock.advance(1000);
  const t = s.restart();
  at = t.sends.length;
  const u2 = t.engine.undo('w', { fix: m.change.fix });
  assert.equal(u2.change.text, 'Undone: 16:10.8 is the 3100m split again; 22:28.8 → 4200m, 26:22.1 → 4400m, 29:45.0 → 5300m');
  assert.deepEqual(sentP(t.engine, t.sends, at, d), [['3100m', 4, 140, 'place-update'], ['4200m', 3, 140, 'correction'], ['4400m', 2, 140, 'correction'], ['5300m', 1, 140, 'correction']]);
  assert.equal(journalOf(t).find((x) => x.t === 'undo' && x.by === u2.change.fix).byFinish, true);
  // and its Redo
  at = t.sends.length;
  t.engine.undo('w', { fix: u2.change.fix, confirm: true });
  assert.deepEqual(sentP(t.engine, t.sends, at, d), [['4200m', 3, 140, 'correction'], ['4400m', 2, 140, 'correction'], ['5300m', 1, 140, 'correction']]);
  // without the operator's word nothing of a finisher's goes live: the Move, then its Undo, the .lif only
  v = t.engine.runner('w', d);
  at = t.sends.length;
  const plain = t.engine.movePass('w', d, { tod: passAt(v, '22:28.8').tod, to: v.columns[6].splitId });
  const pu = t.engine.undo('w', { fix: plain.change.fix, confirm: true });
  assert.deepEqual(sentP(t.engine, t.sends, at, d), []);
  assert.deepEqual([plain.change.lifOnly, pu.change.lifOnly], [true, true]);
  // the boards keep 22:28.8 at 4400m from the change sent with the finish place, but this Undo put that time back: no
  // "the boards keep what Send with finish place sent"
  assert.deepEqual(pu.change.finishKept, []);
});

test('9.23 F4 "the boards keep what Send with finish place sent" only when they do: a finisher\'s .lif-only change sent with Send with finish place, then undone', () => {
  // (as on race day: the runners 9.23 F13 now holds went out a column early)
  const s = womens({ keep: RACE_DAY });
  const { 403: a, 586: d } = s.sh;
  // 403 This is the finish, then Undo, with no finish place known (merged .lif files off): nothing went with a finish place
  let v = s.engine.runner('w', a);
  const f = s.engine.movePass('w', a, { tod: passAt(v, '24:17.3').tod, to: 'finish' });
  const u = s.engine.undo('w', { fix: f.change.fix, confirm: true });
  assert.deepEqual([u.change.text, u.change.finishKept, u.change.sentTo], ['Undone: 24:17.3 is the 5300m split again', [], []]);
  // 586 finished: a Move to the .lif only, then Send with finish place, then Undo (the .lif only): the boards keep the
  // moved times with the finish place
  s.lynx.set(d, parseRaceTime('31:30.0'));
  s.places.set(d, 140);
  s.engine.converge();
  v = s.engine.runner('w', d);
  const m = s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId });
  assert.equal(m.change.lifOnly, true);
  assert.equal(s.engine.sendFinished('w', { bib: d }).sent, 3);
  const u2 = s.engine.undo('w', { fix: m.change.fix, confirm: true });
  assert.deepEqual(u2.change.finishKept.map((x) => [x.splitName, x.text]), [['4200m', '16:10.8'], ['4400m', '22:28.8'], ['5300m', '26:22.1']]);
  assert.equal(u2.change.lifOnly, true);
  // Redo: the moved times are back, as the boards have them
  const r2 = s.engine.undo('w', { fix: u2.change.fix, confirm: true });
  assert.deepEqual(r2.change.finishKept, []);
  // an Undo that would empty a cell a board has with the finish place says so (the panel's dialog says it then): the
  // made-up 3100m time of a finisher goes with the finish place
  v = s.engine.runner('w', d);
  const fill = s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, ifEmpty: true });
  assert.equal(s.sends.filter((x) => x.bib === d).at(-1).place, 140);
  assert.throws(() => s.engine.undo('w', { fix: fill.change.fix }), (err) => err.code === 'UNDO_LEAVES'
    && JSON.stringify(err.leaves) === JSON.stringify([{ bib: d, splitName: '3100m', text: '11:53.6', withFinishPlace: true }]));
});

test('9.23 F7 passes a Move shifted keep their "Moved" while their column is not where the passes alone put them, also after a fill', () => {
  // (403 and 512 as on race day; 586 held by the column check, its passes counted)
  const s = womens({ keep: [403, 512] });
  const d = s.sh[586];
  const kinds = () => s.engine.runner('w', d).columns.map((c) => [c.timeText, c.kind, c.how]);
  let v = s.engine.runner('w', d);
  s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId });
  assert.deepEqual(kinds().slice(3), [['', 'missing', null], ['16:10.8', 'moved', 'moved'], ['22:28.8', 'moved', 'shifted'], ['26:22.1', 'moved', 'shifted']]);
  // the fill holds 3100m: the later passes are where the Move put them, and they were moved there (before: a plain read)
  v = s.engine.runner('w', d);
  s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, ifEmpty: true });
  assert.deepEqual(kinds().slice(3), [['11:53.6', 'made-up', 'made-up'], ['16:10.8', 'moved', 'moved'], ['22:28.8', 'moved', 'shifted'], ['26:22.1', 'moved', 'shifted']]);
  assert.equal(s.engine.runner('w', d).columns[5].howText ?? s.engine.runner('w', d).passes.find((p) => p.timeText === '22:28.8').howText, '4400m: moved there in Review, with the time before it.');
  // the real 3100m read: the passes alone now put them where they are (read, not moved)
  s.clock.advance(15_000);
  s.engine.handleRead({ location: '', bib: d, tod: GUN + parseRaceTime('11:49.6'), contest: '', first: '', last: '', team: '', gender: '' }, { port: 5565 });
  s.clock.advance(100);
  assert.deepEqual(kinds().slice(3), [['11:49.6', 'replaces', 'replaces'], ['16:10.8', 'moved', 'moved'], ['22:28.8', 'read', 'counted'], ['26:22.1', 'read', 'counted']]);
});

test('9.23 F6 a split measured from a pass that looks wrong is not filled until that pass is decided; a Move takes out the times made up from it', () => {
  // 521: the lone pass 19:39.5 kept in 3100m looks like 5300m. With FinishLynx's finish, 4200m-5300m are missing.
  const s = womens();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const c = s.sh[521];
  s.lynx.set(c, parseRaceTime('20:40.0'));
  s.places.set(c, 140);
  s.engine.converge();
  const why = `Check bib ${c}'s 3100m first: 19:39.5 looks like 5300m. Move it, or choose It's right; then this split can be filled.`;
  const mine = () => s.engine.review('w').missing.filter((m) => m.bib === c);
  assert.deepEqual(mine().map((m) => [m.splitName, m.sendable, m.why]), [['4200m', false, why], ['4400m', false, why], ['5300m', false, why]]);
  let v = s.engine.runner('w', c);
  assert.deepEqual(v.columns.slice(4).map((x) => [x.kind, x.why]), [['blocked', why], ['blocked', why], ['blocked', why]]);
  assert.equal(s.engine.grid('w').rows.find((r) => r.bib === c).cells[4].kind, 'blocked');
  // Fill in N leaves them out, with the reason
  const all = s.engine.addManual('w', { all: true });
  assert.deepEqual(all.added.filter((m) => m.bib === c), []);
  assert.deepEqual(all.skipped.filter((x) => x.bib === c).map((x) => x.why), [why, why, why]);
  assert.throws(() => s.engine.addManual('w', { bib: c, splitId: v.columns[4].splitId }), (err) => err.status === 409 && err.message === why);
  // a typed time is the operator's own
  s.engine.addManual('w', { bib: c, splitId: v.columns[4].splitId, time: '19:50.0' });
  // the Move the flag suggests takes the typed 4200m time out (it comes after 19:39.5, which becomes 5300m)
  v = s.engine.runner('w', c);
  const p = passAt(v, '19:39.5');
  const to = p.targets.find((t) => t.splitName === '5300m');
  assert.deepEqual([to.ok, to.effect], [true, 'takes out the typed 4200m time']);
  const r = s.engine.movePass('w', c, { tod: p.tod, to: to.splitId, from: v.columns[3].splitId });
  assert.equal(r.change.text, '19:39.5 moved to 5300m; the typed 4200m time is taken out');
  assert.deepEqual(journalOf(s).filter((x) => x.fix === r.change.fix).map((x) => [x.t, x.splitId]), [['unmanual', v.columns[4].splitId], ['assign', to.splitId]]);
  v = s.engine.runner('w', c);
  assert.deepEqual(v.columns.map((x) => x.kind), ['read', 'read', 'read', 'missing', 'missing', 'missing', 'moved']);
  assert.equal(s.engine.review('w').flags.find((f) => f.bib === c), undefined);
  // Undo puts the typed time back
  s.engine.undo('w', { fix: r.change.fix, confirm: true });
  assert.equal(s.engine.runner('w', c).columns[4].timeText, '19:50.0');
});

test('9.23 F5 fill: a time of day, a race time of 3 h refused, the race clock from the race\'s own reads (whatever this PC\'s clock says), ifEmpty', () => {
  for (const shift of [-6, 0, 6]) {
    const s = setup({ clock: fakeClock(T0 + shift * 3600_000) });
    field(s, { upTo: 400 });
    s.clock.advance(3000);
    // bib 105 has 1K and 2K; 3K is not reached yet: no estimate
    let r = s.engine.addManual('r', { bib: '105', splitId: 's3', tod: '10:10:00.0' });
    assert.deepEqual([r.added[0].timeText, r.added[0].source, r.added[0].basis], ['10:00.0', 'typed', 'Typed in Review as the time of day 10:10:00.0.']);
    s.engine.removeManual('r', { bib: '105', splitId: 's3' });
    assert.throws(() => s.engine.addManual('r', { bib: '105', splitId: 's3', time: '16:36:43.6' }), (err) => err.status === 400
      && err.message === '"16:36:43.6" is 16 h 36 min of race time. If it is a time of day, send it as one. Race times look like 8:12.3.');
    assert.throws(() => s.engine.addManual('r', { bib: '105', splitId: 's3', tod: '1636' }), (err) => err.status === 400
      && err.message === '"1636" is not a time of day. Type it like 16:36:43.6 (hours:minutes:seconds).');
    assert.throws(() => s.engine.addManual('r', { bib: '105', splitId: 's3', tod: '09:59:00.0' }), (err) => err.status === 409
      && err.message === '09:59:00.0 is before the gun (10:00:00.000).');
    // the newest read of the race (the slowest runner with a 2K): a 3K time may be at most 10 min after it
    const latest = formatRaceTime(timeOf(105, 2), 1);
    assert.throws(() => s.engine.addManual('r', { bib: '105', splitId: 's3', time: '25:00' }), (err) => err.status === 409
      && err.message === `25:00.0 is later than anything Split Relay has seen in Boys 5K (latest read ${latest}). Type a time that has happened.`, `shift ${shift}`);
    // sent from an empty cell that another window filled meanwhile
    s.engine.addManual('r', { bib: '105', splitId: 's3', time: '10:00' });
    assert.throws(() => s.engine.addManual('r', { bib: '105', splitId: 's3', time: '10:01', ifEmpty: true }), (err) => err.status === 409
      && err.message === 'Bib 105 has a typed 3K time already (10:00.0): another window sent it. It shows now.');
    r = s.engine.addManual('r', { items: [{ bib: '105', splitId: 's3', time: '10:02', ifEmpty: true }] });
    assert.deepEqual(r.skipped.map((x) => x.why), ['Bib 105 has a typed 3K time already (10:00.0): another window sent it. It shows now.']);
    assert.equal(r.change, null, 'nothing changed: no change to undo');
  }
});

test('9.23 F5 the feed says ".lif" only for a made-up time that is used', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  // FinishLynx's finish before the 2K estimate would make it not used
  s.lynx.set('105', timeOf(105, 1) + 10 * S);
  s.places.set('105', 9);
  s.engine.converge();
  const r = s.engine.addManual('r', { bib: '105', splitId: 's2', time: raceTimeText(timeOf(105, 1) / S + 5) });
  assert.equal(r.added[0].state, 'active');
  const row = s.engine.feed(5)[0];
  assert.match(row.detail, /It is in the merged \.lif\./);
  // 9.23 F13: merged .lif files off (as on race day): the feed does not say so
  const t = setup({ lif: false });
  field(t, { skip: { 105: [2] } });
  t.clock.advance(3000);
  t.engine.assign('r', { bib: '105', all: 'move' });
  t.engine.addManual('r', { bib: '105', splitId: 's2' });
  assert.doesNotMatch(t.engine.feed(5)[0].detail, /\.lif/);
});

// ---- 9.23 F13: a missed split, added in one change; what reads change later ------------------------------------------

const TWO_OUTPUTS = [{ id: 'o1', name: 'TrackScore', enabled: true, races: [] }, { id: 'o2', name: 'Karmarush', enabled: true, races: [] }];
/** The lines one output got since `at` for a bib: [split, laps to go, CS, LS, P, reason]. */
const linesOf = (s, at, bib, out = 'o1') => s.sends.map((p, i) => [p, s.net.via[i]]).slice(at).filter(([p, o]) => o === out && p.bib === String(bib))
  .map(([p]) => [p.splitName, p.lapsToGo, formatRaceTime(p.csTicks, 3), formatRaceTime(p.lsTicks, 3), p.place, p.reason]);
/** TrackScore and Karmarush got the same lines since `at`, in the same order (the user: "exactly like the TrackScore"). */
function sameOnBoth(s, at) {
  const of = (out) => s.sends.map((p, i) => [p, s.net.via[i]]).slice(at).filter(([, o]) => o === out).map(([p]) => [p.bib, p.lapsToGo, p.csTicks, p.lsTicks, p.place, p.reason].join('|'));
  assert.deepEqual(of('o2'), of('o1'));
}
/** A runner's newest line per laps to go, and its newest line of all, on one output: what the board shows. */
function board(s, bib, out = 'o1') {
  const mine = s.sends.map((p, i) => [p, s.net.via[i]]).filter(([p, o]) => o === out && p.bib === String(bib)).map(([p]) => p);
  const cols = new Map();
  for (const p of mine) cols.set(p.lapsToGo, formatRaceTime(p.csTicks, 1));
  const last = mine.at(-1);
  return { cols: [...cols].sort((a, b) => b[0] - a[0]).map(([l2g, t]) => `${l2g}:${t}`), last: last && [last.lapsToGo, last.place] };
}

test('9.23 F13 "Missed <split>: add it": one change, every changed line out at once in its column with its leg, the furthest last, the same to both outputs; Undo, Redo, a restart', () => {
  const s = womens({ outputs: TWO_OUTPUTS });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const { 403: a, 512: b, 521: c, 586: d } = s.sh;
  // 586 (3100m and 4400m missed): held by the column check; the cell the mat missed says so, with what the fix does
  // (9.23 F16: two mats apart; its passes fit 22:28.8 as 5300m about as well as the finish: both sets offered, each one
  // change that adds both runs, neither the one click)
  let v = s.engine.runner('w', d);
  const cell = v.columns[3];
  assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.missedHint.alt.names, v.missedHint.alt.read, cell.missed.here, cell.missed.by, cell.missed.ok, cell.missed.count, cell.missed.typed],
    [['3100m', '4400m', '5300m'], false, ['3100m', '4400m'], ['4200m'], true, 'check', true, 1, false]);
  assert.deepEqual([cell.missed.effect, cell.missed.alt.effect], ['16:10.8 → 4200m, 22:28.8 → extra pass (the finish), 26:22.1 → extra pass, 29:45.0 → extra pass',
    '16:10.8 → 4200m, 22:28.8 → 5300m, 26:22.1 → extra pass (the finish), 29:45.0 → extra pass']);
  assert.match(cell.missed.alt.splits[0].basis, /^From 2400m 9:25\.4 and 4200m 16:10\.8, placed like the 30 runners nearest in pace/);
  assert.match(cell.missed.alt.splits[1].basis, /^From 4200m 16:10\.8 and 5300m 22:28\.8, placed like the 30 runners nearest in pace/);
  // every other cell with a pass has it too (count 1), where nothing pointed at it
  assert.deepEqual(v.columns.map((x) => [x.missed?.here ?? null, x.missed?.count ?? null]), [[false, 1], [false, 1], [false, 1], [true, 1], [false, 1], [false, 1], [false, 1]]);
  {
    // the operator's choice, the one that fits what happened (22:28.8 is 5300m): ONE change adds 3100m and 4400m, every
    // held split goes out at once in course order with its laps to go and its leg, the furthest last, on both outputs
    const s0 = womens({ outputs: TWO_OUTPUTS });
    s0.engine.on('send', (p) => assertSendable(p, s0.config));
    const alt = cell.missed.alt;
    const at0 = s0.sends.length;
    const r0 = s0.engine.addMissed('w', d, { splitId: alt.splitId, passTod: alt.passTod, count: 1, also: [{ splitId: alt.runs[1].splitId, count: 1 }] });
    const [m3100, m4400] = r0.added.map((x) => x.raceTicks);
    assert.equal(r0.change.text, `Missed 3100m and 4400m added (${formatRaceTime(m3100, 1)} and ${formatRaceTime(m4400, 1)}, made up); 16:10.8 → 4200m, 22:28.8 → 5300m; 26:22.1 and 29:45.0 are extra passes now (26:22.1 the finish)`);
    const both = linesOf(s0, at0, d);
    assert.deepEqual(both.map((x) => [x[0], x[1], x[5]]), [['3100m', 4, 'new'], ['4200m', 3, 'new'], ['4400m', 2, 'new'], ['5300m', 1, 'new']]);
    for (let i = 1; i < both.length; i++) assert.equal(rt(both[i][3]), rt(both[i][2]) - rt(both[i - 1][2]), `586 ${both[i][0]}'s leg is from ${both[i - 1][0]}`);
    sameOnBoth(s0, at0);
    assert.deepEqual([r0.change.notLive, s0.engine.runner('w', d).missedHint], [[], null]);
    // one Undo puts it all back, held again (asked first: the boards keep what it sent)
    assert.throws(() => s0.engine.undo('w', { fix: r0.change.fix }), (err) => err.code === 'UNDO_LEAVES');
    s0.engine.undo('w', { fix: r0.change.fix, confirm: true });
    const v0 = s0.engine.runner('w', d);
    assert.deepEqual([v0.columns.slice(3).map((x) => x.held), v0.missedHint.alt.names], [['check', 'check', 'check', 'check'], ['3100m', '4400m']]);
  }
  // F13's one run at a time, as an operator can still send it while Split Relay can't tell which (the panel offers the sets)
  let at = s.sends.length;
  let r = s.engine.addMissed('w', d, { splitId: cell.splitId, passTod: cell.passTod });
  const t3100 = r.added[0].raceTicks;
  assert.equal(r.change.text, `Missed 3100m added (${formatRaceTime(t3100, 1)}, made up); 16:10.8 → 4200m, 22:28.8 → 4400m, 26:22.1 → 5300m; 29:45.0 is an extra pass now (the finish)`);
  assert.deepEqual([r.change.kind, r.added[0].source, r.added[0].basis], ['missed', 'made-up', cell.missed.splits[0].basis]);
  // 3100m and 4200m go out (they were held, never sent), in course order, each with its laps to go and its leg; 4400m
  // and 5300m stay held: the column check sees the second missed mat now, so nothing goes out a column early
  assert.deepEqual(linesOf(s, at, d).map((x) => [x[0], x[1], x[5]]), [['3100m', 4, 'new'], ['4200m', 3, 'new']]);
  assert.equal(linesOf(s, at, d)[1][3], formatRaceTime(rt('16:10.793') - t3100, 3), 'the 4200m leg is from the made-up 3100m');
  sameOnBoth(s, at);
  assert.deepEqual(r.change.notLive.map((x) => x.splitName), ['4400m', '5300m']);
  v = s.engine.runner('w', d);
  // 9.23 F14: its later passes fit 4400m missed (22:28.8 is 5300m, slow) about as well as 4400m and 5300m (22:28.8 is the
  // finish, 26:22.1 and 29:45.0 cool-down passes): Split Relay can't tell which, and offers both, neither as the one click
  assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.missedHint.alt.names, v.columns[5].missed.here, v.columns[5].missed.sure, v.columns[5].missed.alt.count],
    [['4400m'], false, ['4400m', '5300m'], true, false, 2]);
  assert.equal(v.columns[5].check.reason, "Looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or 4400m and 5300m?)");
  assert.deepEqual([v.columns[5].missed.effect, v.columns[5].missed.alt.effect], ['22:28.8 → 5300m, 26:22.1 → extra pass (the finish)', '22:28.8 → extra pass (the finish), 26:22.1 → extra pass']);
  // the operator's choice, the second: 22:28.8 to 5300m, 4400m made up; 26:22.1 an extra pass. The furthest split is the last line
  at = s.sends.length;
  r = s.engine.addMissed('w', d, { splitId: v.columns[5].splitId, passTod: v.columns[5].passTod });
  assert.match(r.change.text, /^Missed 4400m added \(17:3\d\.\d, made up\); 22:28\.8 → 5300m; 26:22\.1 is an extra pass now \(the finish\)$/);
  assert.deepEqual(linesOf(s, at, d).map((x) => [x[0], x[1], x[5]]), [['4400m', 2, 'new'], ['5300m', 1, 'new']]);
  sameOnBoth(s, at);
  v = s.engine.runner('w', d);
  assert.deepEqual(v.columns.map((x) => x.kind), ['read', 'read', 'read', 'made-up', 'moved', 'made-up', 'moved']);
  assert.deepEqual(v.passes.filter((p) => !p.inColumn).map((p) => [p.timeText, p.how]), [['26:22.1', 'extra'], ['29:45.0', 'extra']]);
  assert.deepEqual(board(s, d), { cols: ['7:2:47.1', '6:5:20.6', '5:9:25.4', `4:${formatRaceTime(t3100, 1)}`, '3:16:10.8', `2:${v.columns[5].timeText}`, '1:22:28.8'], last: [1, v.columns[6].place] });
  // 403: its finish pass held in 5300m (merged .lif files off: no finish is known). The fix: that pass is an extra pass,
  // 5300m made up from 4400m and it, placed like the runners nearest in pace (their finish passes): one line, L2G 1
  v = s.engine.runner('w', a);
  assert.deepEqual([v.finished, v.columns[6].missed.here, v.columns[6].missed.effect], [false, true, '24:17.3 → extra pass (the finish)']);
  assert.match(v.columns[6].missed.splits[0].basis, /^From 4400m 17:01\.2 and 24:17\.3, the pass after it, placed like the 30 runners nearest in pace|^From 4400m 17:01\.2 and the finish 24:17\.3, placed like the 30 runners nearest in pace/);
  at = s.sends.length;
  r = s.engine.addMissed('w', a, { splitId: v.columns[6].splitId, passTod: v.columns[6].passTod });
  assert.match(r.change.text, /^Missed 5300m added \(20:5\d\.\d, made up\); 24:17\.3 is an extra pass now \(the finish\)$/);
  assert.deepEqual(linesOf(s, at, a).map((x) => [x[0], x[1], x[5]]), [['5300m', 1, 'new']]);
  sameOnBoth(s, at);
  assert.equal(s.engine.runner('w', a).finished, false);
  // 512: "This is the finish" first, with no finish place known: nothing can go live for a finisher, and the empty
  // 5300m cell offers the same fix: the marked pass moves on (an extra pass), 5300m goes with its own place
  v = s.engine.runner('w', b);
  s.engine.movePass('w', b, { tod: passAt(v, '24:15.4').tod, to: 'finish' });
  v = s.engine.runner('w', b);
  assert.deepEqual([v.finished, v.finishBy, v.columns[6].kind, v.columns[6].missed.ok, v.columns[6].missed.effect], [true, 'marked', 'blocked', true, '24:15.4 → extra pass (the finish pass, no longer the finish you marked)']);
  // (9.23 F18: and the refusal of a fill there says that way out)
  assert.throws(() => s.engine.addManual('w', { bib: b, splitId: v.columns[6].splitId, ifEmpty: true }),
    (err) => err.status === 409 && /you marked 24:15\.4 as its finish, and Split Relay doesn't know a finish place for it\..* To send it: choose "Missed 5300m: add it"/.test(err.message));
  at = s.sends.length;
  r = s.engine.addMissed('w', b, { splitId: v.columns[6].splitId, passTod: v.columns[6].missed.passTod });
  assert.match(r.change.text, /^Missed 5300m added \(20:\d\d\.\d, made up\); 24:15\.4 is an extra pass now \(the finish\)$/);
  assert.deepEqual(linesOf(s, at, b).map((x) => [x[0], x[1], x[5]]), [['5300m', 1, 'new']]);
  assert.equal(s.engine.runner('w', b).finished, false);
  // 521: three missed in a row (its lone pass kept in 3100m is 5300m): one change, four lines, L2G 4 to 1
  v = s.engine.runner('w', c);
  assert.deepEqual([v.missedHint.names, v.columns[3].missed.count, v.columns[3].missed.by], [['3100m', '4200m', '4400m'], 3, 'flag']);
  assert.throws(() => s.engine.addMissed('w', c, { splitId: v.columns[3].splitId, passTod: v.columns[3].passTod, count: 1 }), (err) => err.status === 409
    && /^19:39\.5 looks like 5300m: bib \d+ missed 3100m, 4200m and 4400m\? Add them together, or type the time\.$/.test(err.message));
  at = s.sends.length;
  r = s.engine.addMissed('w', c, { splitId: v.columns[3].splitId, passTod: v.columns[3].passTod, count: 3 });
  assert.match(r.change.text, /^Missed 3100m, 4200m and 4400m added \(1\d:\d\d\.\d, 1\d:\d\d\.\d and 1\d:\d\d\.\d, made up\); 19:39\.5 → 5300m$/);
  assert.deepEqual(linesOf(s, at, c).map((x) => [x[0], x[1], x[5]]), [['3100m', 4, 'correction'], ['4200m', 3, 'new'], ['4400m', 2, 'new'], ['5300m', 1, 'new']]);
  sameOnBoth(s, at);
  const legs = linesOf(s, at, c);
  for (let i = 1; i < legs.length; i++) assert.equal(rt(legs[i][3]), rt(legs[i][2]) - rt(legs[i - 1][2]), `${legs[i][0]}'s leg is from ${legs[i - 1][0]}`);
  // the journal: one write of the change, its first record says what it was
  const recs = journalOf(s).filter((x) => x.fix === r.change.fix);
  assert.deepEqual(recs.map((x) => x.t), ['assign', 'manual', 'manual', 'manual']);
  assert.deepEqual([recs[0].fixKind, recs[0].as, recs[0].splitId], ['missed', undefined, v.columns[6].splitId]);
  // a stop and a start: the same crossings, the change still undoable
  s.clock.advance(1000);
  const cross = (e) => e.crossings('w').map((x) => [x.bib, x.splitId, x.tod, x.raceTicks, x.place, x.reads, x.source, x.held]);
  const before = cross(s.engine);
  const t = s.restart();
  assert.deepEqual(cross(t.engine), before);
  const last = t.engine.runner('w', c).changes[0];
  assert.deepEqual([last.kind, last.undoable], ['missed', true]);
  // Undo: the boards keep 4200m-5300m (a packet can't empty a cell): asked first; then 19:39.5 is 3100m again
  assert.throws(() => t.engine.undo('w', { fix: last.fix }), (err) => err.code === 'UNDO_LEAVES' && err.leaves.length === 3);
  at = t.sends.length;
  const u = t.engine.undo('w', { fix: last.fix, confirm: true });
  assert.equal(u.change.text, 'Undone: 19:39.5 is the 3100m split again; 3 made-up times taken back');
  assert.deepEqual(linesOf(t, at, c).map((x) => [x[0], x[1], x[2]]), [['3100m', 4, '19:39.433']]);
  // Redo: the same change again, the furthest split last
  at = t.sends.length;
  const rd = t.engine.undo('w', { fix: u.change.fix });
  assert.match(rd.change.text, /^Done again: Missed 3100m, 4200m and 4400m added/);
  assert.deepEqual(linesOf(t, at, c).map((x) => [x[0], x[1]]).at(-1), ['5300m', 1]);
  assert.deepEqual(linesOf(t, at, c)[0].slice(0, 2), ['3100m', 4]);
  sameOnBoth(t, at);
});

test('9.23 F13 two mats missed in a row and a cool-down pass (451 on the replay): held, the one click adds both; its Undo says the passes are held again and asks first', () => {
  // race day's 451 (bib 54 here) with its 1500m and 2400m reads taken out: 800m, then 3100m to 5300m, the finish pass
  // and a cool-down pass, 7 passes in 7 columns. The column check has one more column (the finish) and placed every
  // pass one split on; the look-wrong check measures the leg (8:21 after 800m) and says 3100m: the one click is theirs
  const D = '54';
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [D]: [2945790, 5057190] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  assert.deepEqual(linesOf(s, 0, D).map((x) => x[0]), ['800m'], 'held: nothing goes out a column early');
  const rows = s.engine.review('w').checks.filter((c) => c.bib === D);
  assert.deepEqual(rows.map((c) => [c.timeText, c.toName, c.reason]), [
    ['10:58.9', '3100m', 'Looks like 3100m, not 1500m (missed 1500m and 2400m?): 8:21 after 800m, where runners of the same pace took 8:10'],
    ['15:28.7', '4200m', 'Looks like 4200m, not 2400m (it moves with the pass before it)'],
    ['16:26.6', '4400m', 'Looks like 4400m, not 3100m (it moves with the pass before it)'],
    ['19:43.7', '5300m', 'Looks like 5300m, not 4200m (it moves with the pass before it)'],
    ['22:28.7', 'the finish', 'Looks like the finish, not 4400m (it moves with the pass before it)'],
    ['28:02.4', 'an extra pass', 'An extra pass, not 5300m (it moves with the pass before it)'],
  ]);
  assert.deepEqual(rows.map((c) => c.missed?.names ?? null), [['1500m', '2400m'], null, null, null, null, null]);
  let v = s.engine.runner('w', D);
  assert.deepEqual([v.missedHint.names, v.columns[1].missed.here, v.columns[1].missed.count, v.columns[1].missed.ok, v.columns[1].check.toName],
    [['1500m', '2400m'], true, 2, true, '3100m']);
  assert.equal(v.columns[1].missed.effect, '10:58.9 → 3100m, 15:28.7 → 4200m, 16:26.6 → 4400m, 19:43.7 → 5300m, 22:28.7 → extra pass (the finish), 28:02.4 → extra pass');
  // one change: both made up, every pass in its split, each line with its laps to go and its leg, 5300m last
  let at = s.sends.length;
  const r = s.engine.addMissed('w', D, { splitId: v.columns[1].splitId, passTod: v.columns[1].passTod, count: 2 });
  assert.match(r.change.text, /^Missed 1500m and 2400m added \(\d:\d\d\.\d and \d:\d\d\.\d, made up\); 10:58\.9 → 3100m, 15:28\.7 → 4200m, 16:26\.6 → 4400m, 19:43\.7 → 5300m; 22:28\.7 and 28:02\.4 are extra passes now \(22:28\.7 the finish\)$/);
  const lines = linesOf(s, at, D);
  assert.deepEqual(lines.map((x) => [x[0], x[1]]), [['1500m', 6], ['2400m', 5], ['3100m', 4], ['4200m', 3], ['4400m', 2], ['5300m', 1]]);
  assert.deepEqual(lines.slice(2).map((x) => x[2]), ['10:58.854', '15:28.653', '16:26.554', '19:43.695']);
  for (let i = 1; i < lines.length; i++) assert.equal(rt(lines[i][3]), rt(lines[i][2]) - rt(lines[i - 1][2]), `${lines[i][0]}'s leg is from ${lines[i - 1][0]}`);
  // (the made-up times sit between 800m and 10:58.9 like the runners nearest in pace: 4:54.6 and 8:25.7 on race day)
  assert.ok(rt(lines[0][2]) > rt('4:30') && rt(lines[0][2]) < rt('5:20') && rt(lines[1][2]) > rt('8:00') && rt(lines[1][2]) < rt('8:50'), JSON.stringify(lines));
  sameOnBoth(s, at);
  const rv = s.engine.review('w');
  assert.deepEqual([rv.checks.filter((c) => c.bib === D).length, rv.flags.filter((f) => f.bib === D).length], [0, 0]);
  // Undo: the passes go back to the column check, held; the boards keep what the change sent until the operator
  // chooses, so the panel asks first
  s.clock.advance(1000);
  assert.throws(() => s.engine.undo('w', { fix: r.change.fix }), (err) => err.code === 'UNDO_LEAVES' && err.leaves.length === 6 && err.leaves.every((x) => x.held)
    && /^TrackScore and Karmarush keep .* \(bib 54\): Split Relay holds bib 54's passes again \(Passes to check\) and sends nothing for them until you choose\. Undo anyway\?$/.test(err.message));
  // (asked, nothing changed)
  assert.deepEqual(s.engine.runner('w', D).columns.map((x) => x.kind), ['read', 'made-up', 'made-up', 'moved', 'moved', 'moved', 'moved']);
  at = s.sends.length;
  const u = s.engine.undo('w', { fix: r.change.fix, confirm: true });
  assert.deepEqual(u.change.leaves.map((x) => [x.splitName, x.held]), [['1500m', true], ['2400m', true], ['3100m', true], ['4200m', true], ['4400m', true], ['5300m', true]]);
  assert.deepEqual(linesOf(s, at, D).map((x) => x[0]), ['800m'], 'its furthest split out of doubt goes last again: 800m, the place before the change');
  v = s.engine.runner('w', D);
  assert.deepEqual(v.columns.map((x) => x.held), [null, 'check', 'check', 'check', 'check', 'check', 'check']);
  assert.deepEqual(v.missedHint.names, ['1500m', '2400m']);
});

test('9.23 F13 "Missed <split>: add it": its refusals, a typed time, a finisher (the finish place), a paused split, a race not Active', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(4) })] });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // 105, 106, 107 and 108 missed 2K: their 3K pass is counted in 2K (the column check holds it)
  field(s, { splits: 4, skip: { 105: [2], 106: [2], 107: [2], 108: [2] } });
  s.clock.advance(70_000);
  const cellOf = (bib, k) => s.engine.runner('r', bib).columns[k];
  let c = cellOf('105', 1);
  assert.deepEqual([c.missed.here, c.missed.by, c.missed.count], [true, 'check', 1]);
  // refusals, in words, before anything changes
  const no = (bib, body, status, re) => assert.throws(() => s.engine.addMissed('r', bib, body), (err) => err.status === status && re.test(err.message), JSON.stringify(body));
  no('105', { splitId: 's2', passTod: cellOf('105', 0).passTod }, 409, /^2K has \d+:\d\d\.\d now, not the pass you saw: it was changed in another window\. Look again\.$/);
  no('105', { splitId: 's2', count: 2, time: '6:40' }, 400, /^A typed time is for one missed split/);
  no('105', { splitId: 's2', count: 4 }, 400, /^"count" is how many splits in a row the mats missed from 2K on: 1 to 3\.$/);
  no('105', { splitId: 's2', time: '2:00' }, 409, /^2:00\.0 is not after bib 105's 1K \(3:\d\d\.\d\)\. A 2K time must come after it\.$/);
  no('105', { splitId: 's2', time: '9:59' }, 409, /^9:59\.0 is not before .*, which moves on to 3K \(\d+:\d\d\.\d\)\. A 2K time must come before it\.$/);
  no('105', { splitId: 'nope' }, 400, /^Send \{ "splitId"/);
  // a typed time: the pass moves on, 2K is the time typed (a typed time), one change
  let at = s.sends.length;
  let r = s.engine.addMissed('r', '105', { splitId: 's2', passTod: c.passTod, time: '6:40' });
  assert.match(r.change.text, /^Missed 2K added \(6:40\.0, typed\); \d+:\d\d\.\d → 3K, \d+:\d\d\.\d → 4K$/);
  assert.deepEqual([r.added[0].source, r.added[0].basis], ['typed', 'Typed in Review.']);
  assert.deepEqual(sentOf(s, 105).slice(-3).map((x) => [x[0], x[3]]), [['2K', 'new'], ['3K', 'new'], ['4K', 'new']]);
  void at;
  // a made-up cell: change that time instead; an empty cell: send its time instead
  no('105', { splitId: 's2' }, 409, /^Bib 105 has a typed 2K time \(6:40\.0\): change that time instead\.$/);
  // a finisher with no finish place known: refused (a split packet would replace it)
  s.lynx.set('106', timeOf(106, 4) + 100 * S);
  s.engine.converge();
  no('106', { splitId: 's2' }, 409, /^Bib 106 has finished, but Split Relay doesn't know the finish place/);
  // ... with it: everything it changes goes with the finish place when the operator says so (the panel asks first)
  s.places.set('106', 3);
  s.engine.converge();
  c = cellOf('106', 1);
  at = s.sends.length;
  r = s.engine.addMissed('r', '106', { splitId: 's2', passTod: c.passTod, withFinishPlace: true });
  assert.deepEqual(s.sends.slice(at).filter((p) => p.bib === '106').map((p) => [p.splitName, p.place]), [['2K', 3], ['3K', 3], ['4K', 3]]);
  // a paused split: its made-up time waits for Play (approved: it goes out then, whatever the minute says)
  s.config.races[0].splits[1].sending = false;
  s.engine.configChanged();
  c = cellOf('107', 1);
  at = s.sends.length;
  r = s.engine.addMissed('r', '107', { splitId: 's2', passTod: c.passTod });
  assert.deepEqual(r.change.notLive.map((x) => [x.splitName, x.why]), [['2K', '2K is paused']]);
  assert.deepEqual(s.sends.slice(at).filter((p) => p.bib === '107').map((p) => p.splitName), ['3K', '4K']);
  s.clock.advance(120_000);
  at = s.sends.length;
  s.config.races[0].splits[1].sending = true;
  s.engine.configChanged();
  s.clock.advance(100);
  assert.deepEqual(s.sends.slice(at).filter((p) => p.bib === '107').map((p) => [p.splitName, p.reason]), [['2K', 'new'], ['3K', 'place-update'], ['4K', 'place-update']]);
  // a race that is not Active: into the merged .lif only
  s.config.races[0].active = false;
  s.engine.configChanged();
  c = cellOf('108', 1);
  at = s.sends.length;
  r = s.engine.addMissed('r', '108', { splitId: 's2', passTod: c.passTod });
  assert.deepEqual([r.change.lifOnly, s.sends.length - at], [true, 0]);
  assert.equal(s.engine.raceData('r').runners.get('108').splits[1], r.added[0].raceTicks);
});

test('9.23 F13 what a read changes after the minute goes out by itself: a late read of the missed split moves the later passes back, each line in its column, the furthest last; a place alone waits', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(4) })], outputs: TWO_OUTPUTS });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  // bib 105 missed 2K; kept from the check queue as counted, its 3K pass went out as 2K, its 4K pass as 3K
  field(s, { splits: 4, skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'keep' });
  s.clock.advance(70_000);
  assert.deepEqual(board(s, 105).cols, ['4:3:18.0', `3:${formatRaceTime(timeOf(105, 3), 1)}`, `2:${formatRaceTime(timeOf(105, 4), 1)}`]);
  // its 2K read comes now, long after those cells went out (RR12 had it queued): every changed cell goes out by itself,
  // as a correction, in course order, each with its laps to go and its leg; 4K for the first time
  const at = s.sends.length;
  const late = s.lap(105, raceTimeText(timeOf(105, 2) / S));
  s.clock.advance(3000);
  assert.deepEqual(linesOf(s, at, 105).map((x) => [x[0], x[1], x[2], x[3], x[5]]), [
    ['2K', 3, formatRaceTime(timeOf(105, 2), 3), formatRaceTime(timeOf(105, 2) - timeOf(105, 1), 3), 'correction'],
    ['3K', 2, formatRaceTime(timeOf(105, 3), 3), formatRaceTime(timeOf(105, 3) - timeOf(105, 2), 3), 'correction'],
    ['4K', 1, formatRaceTime(timeOf(105, 4), 3), formatRaceTime(timeOf(105, 4) - timeOf(105, 3), 3), 'new']]);
  sameOnBoth(s, at);
  assert.deepEqual(board(s, 105), { cols: ['4:3:18.0', `3:${formatRaceTime(timeOf(105, 2), 1)}`, `2:${formatRaceTime(timeOf(105, 3), 1)}`, `1:${formatRaceTime(timeOf(105, 4), 1)}`], last: [1, 6] });
  // (the feed: the late read's row says the passes were counted again)
  assert.equal(s.row(late).status, 'corrected');
  assert.match(s.row(late).detail, /^Counted again after a late read: re-sent as place \d+ with this time \(\d+:\d\d\.\d was there before\)\.$/);
  // the places of the other runners at 2K-4K only moved: after their minute they wait for Resend
  assert.ok(s.engine.raceView('r').stale.count > 0);
  assert.ok(linesOf(s, at, 106).length === 0, 'no other runner\'s old split went out');
});

test('9.23 F13 after the relay sends an earlier split of a runner by itself, the runner\'s furthest split goes again, last', () => {
  const s = setup({ races: [lapRace({ splits: lapSplits(3) })] });
  // two runners at 1K and 2K; inside their 1K's minute, a third runner's 1K read lands before them: their 1K places go
  // up by one (a place update), and each then gets its 2K again, so TrackScore keeps showing its 2K place
  s.lap(101, '3:00');
  s.lap(102, '3:02');
  s.clock.advance(3000);
  s.lap(101, '3:30');
  s.lap(102, '3:32');
  s.clock.advance(3000);
  const at = s.sends.length;
  s.lap(100, '2:59');
  s.clock.advance(3000);
  assert.deepEqual(s.sends.slice(at).map((p) => [p.bib, p.splitName, p.place, p.reason]), [
    ['100', '1K', 1, 'new'], ['101', '1K', 2, 'place-update'], ['102', '1K', 3, 'place-update'], ['101', '2K', 1, 'place-update'], ['102', '2K', 2, 'place-update']]);
});

test('9.23 F13 a finisher\'s next split after a fill gets its new leg with the finish place; and after its Undo (F14: its furthest split last)', () => {
  const s = womens({ keep: RACE_DAY });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const d = s.sh[586];
  s.lynx.set(d, parseRaceTime('31:30.0'));
  s.places.set(d, 140);
  s.engine.converge();
  let v = s.engine.runner('w', d);
  s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId, withFinishPlace: true });
  v = s.engine.runner('w', d);
  // the fill is not "with the finish place" (a made-up time always is): 4200m's leg is from it now, and goes again
  let at = s.sends.length;
  const f = s.engine.addManual('w', { bib: d, splitId: v.columns[3].splitId, ifEmpty: true });
  const sent = s.sends.slice(at).filter((p) => p.bib === d);
  // (9.23 F14: and its furthest split last, with the finish place, as for a runner on the course)
  assert.deepEqual(sent.map((p) => [p.splitName, p.place, p.reason]), [['3100m', 140, 'correction'], ['4200m', 140, 'place-update'], ['5300m', 140, 'place-update']]);
  assert.equal(sent[1].lsTicks, sent[1].csTicks - f.added[0].raceTicks);
  // its Undo: the boards keep the made-up 3100m (asked first); 4200m's leg is from 2400m again
  at = s.sends.length;
  s.engine.undo('w', { fix: f.change.fix, confirm: true });
  const back = s.sends.slice(at).filter((p) => p.bib === d);
  assert.deepEqual(back.map((p) => [p.splitName, p.place]), [['4200m', 140], ['5300m', 140]]);
  assert.equal(back[0].lsTicks, back[0].csTicks - s.engine.runner('w', d).columns[2].time);
});

// ---- DESIGN 9.23 F14: how many mats in a row; the real cause; recovery ----------------------------------------------

/** The real race as the look-wrong check takes it (src/review.js), with one runner's passes taken out (by index). */
function womensLegs(bib, drop = [], cut = Infinity) {
  const n = 7;
  const runners = WOMENS.runners.map((r) => {
    const all = r.passes.slice().sort((x, y) => x - y);
    const ps = (r.bib === bib ? all.filter((_, i) => !drop.includes(i)) : all).filter((t) => t <= cut);
    const kept = new Array(n).fill(null);
    ps.slice(0, n).forEach((t, c) => { kept[c] = t; });
    // (the runner a mat missed is held: no reference for the others, as in the engine)
    return { bib: r.bib, kept, real: r.bib === bib ? new Array(n).fill(null) : kept.slice(), look: new Array(n).fill(null), passes: ps, finish: null };
  });
  return { field: legField({ n, runners }), me: runners.find((r) => r.bib === bib) };
}

const passesOf = (bib) => WOMENS.runners.find((r) => r.bib === bib).passes.slice().sort((x, y) => x - y);

test('9.23 F14 missedCounts on the real race: every complete runner with one, two or three mats in a row taken out at every split: at the end the right count, sure, nearly always, never a wrong one; on the course a wrong one sure only for the race leader', () => {
  const st = { end: { sure: 0, two: 0, wrong: 0, all: 0 }, live: { sure: 0, two: 0, wrong: 0, all: 0 } };
  const wrong = [];
  for (const r of WOMENS.runners) {
    const all = passesOf(r.bib);
    if (all.length < 8) continue;
    for (const len of [1, 2, 3]) {
      for (let j = 0; j + len <= 7; j++) {
        const drop = Array.from({ length: len }, (_, i) => j + i);
        const mine = all.filter((_, i) => !drop.includes(i));
        // at the end, and right after the first and the second pass that moved on (3 s later)
        for (const [stage, cut] of [['end', Infinity], ['live', mine[j] + 30000], ['live', (mine[j + 1] ?? Infinity) + 30000]]) {
          if (stage === 'live' && cut === Infinity) continue;
          const { field, me } = womensLegs(r.bib, drop, cut);
          const res = missedCounts(field, me, j, me.passes.filter((t) => t >= mine[j]));
          const x = st[stage];
          x.all++;
          if (res.sure && res.count === len) x.sure++;
          else if (res.alt !== null && [res.count, res.alt].includes(len)) x.two++;
          // a count sure but wrong, or two offered and neither right
          else if (res.sure || res.alt !== null) {
            x.wrong++;
            wrong.push(`${r.bib} ${len}@${j} ${stage}: ${res.count}${res.alt ? ` or ${res.alt}` : ''}`);
          }
        }
      }
    }
  }
  console.log(`missedCounts on the real race: ${JSON.stringify(st)}; wrong: ${wrong.join(', ')}`);
  assert.equal(st.end.wrong, 0, 'never a wrong count once the race is over');
  assert.ok(st.end.sure / st.end.all > 0.97, `the right count, sure, at the end: ${st.end.sure} of ${st.end.all}`);
  // (117 leads the race: when its first pass after its first three missed mats comes, nobody has been at 3100m yet, so
  // that count can't be there yet, as for the column check: DESIGN 9.23 F14, not done)
  assert.ok(wrong.every((w) => /^117 3@0 live/.test(w)), wrong.join(', '));
});

test('9.23 F14 missedCounts on synthetic races: one, two and three mats in a row at the first, middle and last splits, the finish pass in the stream or not, one runner in four with a cool-down pass: at the end a wrong count for at most 1.5 %, one missed mat sure and right for 90 %; the cause of a leg that looks wrong never moves a runner whose mats all read', () => {
  const courses = [...COURSES, { name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 }];
  for (const fin of [true, false]) {
    const st = { all: 0, wrong: 0, one: 0, oneSure: 0, complete: 0, completeCause: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      for (const course of courses) {
        const n = course.d.length;
        const race = makeRace(seed * 7919 + n, course, 120 + (seed % 5) * 40);
        const rand = rng(seed * 31 + n);
        for (const r of race) {
          r.cool = rand() < 0.25;
          r.miss = null;
          if (rand() < 0.15) {
            const len = 1 + Math.floor(rand() * Math.min(3, n - 1));
            r.miss = { j: Math.floor(rand() * (n - len + 1)), len };
          }
          const ts = r.mats.filter((_, k) => !r.miss || k < r.miss.j || k >= r.miss.j + r.miss.len);
          if (fin && !r.dnf) ts.push(r.finish, ...(r.cool ? [r.finish + 90 + rand() * 400] : []));
          r.passes = ts.map((t) => Math.round(t * S));
        }
        const runners = race.map((o) => {
          const kept = new Array(n).fill(null);
          o.passes.slice(0, n).forEach((t, c) => { kept[c] = t; });
          return { bib: o.bib, kept, real: o.miss ? new Array(n).fill(null) : kept.slice(), look: kept.map((t) => (t === null ? null : 'counted')), passes: o.passes, finish: null, src: o };
        });
        const field = legField({ n, runners });
        for (const me of runners) {
          const r = me.src;
          if (r.dnf) continue;
          if (!r.miss) {
            st.complete++;
            continue;
          }
          if (r.passes[r.miss.j] === undefined) continue;
          const res = missedCounts(field, me, r.miss.j, me.passes.filter((t) => t >= r.passes[r.miss.j]));
          st.all++;
          if (r.miss.len === 1) st.one++;
          if (res.sure && res.count === r.miss.len && r.miss.len === 1) st.oneSure++;
          if ((res.sure && res.count !== r.miss.len) || (!res.sure && res.alt !== null && ![res.count, res.alt].includes(r.miss.len))) st.wrong++;
        }
        // the cause of a leg that looks wrong (#countHint): runners whose mats all read, whose legs look wrong anyway, are
        // never given one
        const flags = legFlags({ n, names: course.d.map((x) => `${x}K`), runners: runners.map((x) => ({ ...x, real: x.src.miss ? x.real : x.kept.slice() })) });
        for (const me of runners) {
          const f = flags.get(me.bib);
          if (me.src.miss || me.src.dnf || !f || (f.suggest && f.suggest.to !== 'none' && (f.suggest.to === 'finish' || f.suggest.to > f.col))) continue;
          for (let k = 0; k <= f.col && k < n; k++) {
            if (me.kept[k] === null) continue;
            const res = missedCounts(field, me, k, me.passes.filter((t) => t >= me.kept[k]), { none: true });
            const best = res.fits.find((x) => x.count === res.count);
            if (res.sure && res.none && (res.none.out || best.cost + COUNT_RULES.misfit < res.none.cost)) {
              st.completeCause++;
              break;
            }
          }
        }
      }
    }
    console.log(`missedCounts on synthetic races (${fin ? 'finish passes in the stream' : 'splits only'}): ${JSON.stringify(st)}`);
    assert.ok(st.all > 1000 && st.wrong / st.all <= 0.015, `a wrong count at the end: ${st.wrong} of ${st.all}`);
    assert.ok(st.oneSure / st.one >= 0.9, `one missed mat, sure and right: ${st.oneSure} of ${st.one}`);
    assert.equal(st.completeCause, 0, 'a runner whose mats all read is never given a cause');
  }
});

test('9.23 F14 two mats missed in a row (the re-check\'s 459, 507, 472 with a cool-down pass, 524, and 438\'s last two): held, sure, both added in one click; every split from the first missed one on both outputs with its own time, laps to go and leg, the furthest last', () => {
  for (const [bib, drop, names] of [['62', [2, 3], ['2400m', '3100m']], ['106', [1, 2], ['1500m', '2400m']], ['73', [2, 3], ['2400m', '3100m']],
    ['117', [4, 5], ['4200m', '4400m']], ['42', [5, 6], ['4400m', '5300m']]]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    // held: nothing of it went out a column early, before the operator chose
    assert.ok(linesOf(s, 0, bib).every((x) => x[1] > 7 - drop[0]), `bib ${bib}: ${JSON.stringify(linesOf(s, 0, bib))}`);
    let v = s.engine.runner('w', bib);
    assert.deepEqual([v.missedHint.names, v.missedHint.count, v.missedHint.sure, v.missedHint.alt], [names, 2, true, null], `bib ${bib}`);
    const cell = v.columns[drop[0]];
    assert.deepEqual([cell.missed.here, cell.missed.count, cell.missed.sure, cell.missed.ok], [true, 2, true, true], `bib ${bib}`);
    assert.match(cell.missed.reason, new RegExp(`^\\d+:\\d\\d\\.\\d looks like (\\d+m|the finish), not ${names[0]} \\(missed ${names[0]} and ${names[1]}\\?\\): \\d+:\\d\\d after \\d+m, where runners of the same pace took \\d+:\\d\\d\\.$`));
    // the same count on Passes to check's first row (its one click) and in the editor's problem line
    const row = s.engine.review('w').checks.find((c) => c.bib === bib && c.missed);
    assert.deepEqual([row.missed.names, row.missed.sure, row.missed.effect, row.reason], [names, true, cell.missed.effect, cell.missed.reason.replace(/^[\d:.]+ looks like /, 'Looks like ').replace(/\.$/, '')]);
    assert.ok(v.problems[0].text.includes(row.reason), v.problems[0].text);
    const at = s.sends.length;
    const r = s.engine.addMissed('w', bib, { splitId: cell.splitId, passTod: cell.missed.passTod, count: row.missed.count });
    assert.match(r.change.text, new RegExp(`^Missed ${names[0]} and ${names[1]} added`));
    const lines = linesOf(s, at, bib);
    // every split from the first missed one, once, in course order: the furthest (5300m) last
    assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1].slice(drop[0]), `bib ${bib}: ${JSON.stringify(lines)}`);
    lines.forEach(([split, l2g, cs, ls], i) => {
      const k = 7 - l2g;
      // its own time: the real one, or the made-up one within 20 s of what the mat would have read
      if (drop.includes(k)) assert.ok(Math.abs(rt(cs) - real[k]) < 20 * S, `${bib} ${split} made up ${cs}, the mat ${formatRaceTime(real[k], 3)}`);
      else assert.equal(cs, formatRaceTime(real[k], 3), `${bib} ${split}`);
      assert.equal(rt(ls), rt(cs) - (i ? rt(lines[i - 1][2]) : real[k - 1]), `${bib} ${split}'s leg is from the split before it`);
    });
    sameOnBoth(s, at);
    v = s.engine.runner('w', bib);
    assert.deepEqual([v.missedHint, v.problems], [null, []], `bib ${bib}: nothing left to do`);
  }
});

test('9.23 F14 no finish read, three in a row, the last three and the first two (which neither check points at): the right count, one click, every line right', () => {
  for (const [bib, drop, names, by] of [['62', [2, 3, 7], ['2400m', '3100m'], 'check'], ['62', [2, 3, 4], ['2400m', '3100m', '4200m'], 'check'],
    ['42', [3, 4, 5], ['3100m', '4200m', '4400m'], 'check'], ['117', [4, 5, 6], ['4200m', '4400m', '5300m'], 'flag'], ['54', [5, 6], ['4400m', '5300m'], 'check'],
    ['73', [0, 1], ['800m', '1500m'], 'count']]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    let v = s.engine.runner('w', bib);
    const k = drop[0];
    assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.missedHint.alt, v.columns[k].missed.by], [names, true, null, by], `bib ${bib} ${drop}`);
    if (by === 'count') {
      // 472 with its first two mats missed: every pass went out two columns early, nothing held, and the look-wrong
      // check saw a short leg only; the cause is listed with the splits that look wrong, with the one click
      const f = s.engine.review('w').flags.find((x) => x.bib === bib);
      assert.deepEqual([f.kind, f.splitName, f.missed.names, f.missed.sure], ['missed', '800m', names, true]);
      assert.equal(f.text, '8:13.9 looks like 2400m, not 800m (missed 800m and 1500m?).');
      assert.deepEqual(v.problems.map((p) => [p.kind, p.col]), [['missed', 0]]);
    }
    const at = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: v.columns[k].splitId, passTod: v.columns[k].missed.passTod, count: v.missedHint.count });
    const lines = linesOf(s, at, bib);
    assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1].slice(k), `bib ${bib} ${drop}: ${JSON.stringify(lines)}`);
    for (const [split, l2g, cs] of lines) {
      const c = 7 - l2g;
      if (drop.includes(c)) assert.ok(Math.abs(rt(cs) - real[c]) < 25 * S, `${bib} ${split} made up ${cs}, the mat ${formatRaceTime(real[c], 3)}`);
      else assert.equal(cs, formatRaceTime(real[c], 3), `${bib} ${split}`);
    }
    sameOnBoth(s, at);
    v = s.engine.runner('w', bib);
    assert.equal(v.missedHint, null, `bib ${bib} ${drop}: done`);
  }
});

test('9.23 F14 the last three missed (the browser check\'s 410): the Review row and the runner editor say the same; 9.23 F16: the finish read is the finish (two would leave no pass at the finish, the finish mat missed too), the one click, in the finish form of the words', () => {
  const bib = '20';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [4, 5, 6].map((i) => real[i]) } });
  const f = s.engine.review('w').flags.find((x) => x.bib === bib);
  // (F14 and F15 could not tell two from three: "21:11.7 looks like 5300m or the finish, not 4200m: Split Relay can't
  // tell which"; two put its finish read in 5300m and left nothing at the finish, while every runner who finished has
  // a finish pass in the stream)
  assert.deepEqual([f.missed.sure, f.missed.names, f.missed.alt], [true, ['4200m', '4400m', '5300m'], null], JSON.stringify(f.missed));
  // 9.23 F16: the finish form as the others and as Passes to check says it: the splits missed, the runners' leg to the finish
  assert.match(f.text, /^21:11\.7 looks like the finish, not 4200m \(missed 4200m, 4400m and 5300m\?\): 10:39 after 3100m, where runners of the same pace took 10:\d\d\.$/);
  // the runner editor's line is the row's
  const v = s.engine.runner('w', bib);
  assert.deepEqual(v.problems.filter((p) => p.kind === 'flag').map((p) => p.text), [f.text]);
  assert.deepEqual([v.columns[4].missed.sure, v.columns[4].missed.count, v.columns[4].missed.alt], [true, 3, null]);
  missedOneClick(s, bib, f, [4, 5, 6], real);
});

/** The real race streamed up to race time `cut`; `s.more(to)` streams on (the runner's next passes). */
function womensLive({ drop = {}, cut, outputs = TWO_OUTPUTS } = {}) {
  const races = [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })];
  const s = setup({ races, filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs });
  const reads = WOMENS.runners.flatMap((r) => r.passes.filter((t) => !drop[r.bib]?.includes(t)).map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  let upTo = -Infinity;
  s.more = (to) => {
    s.engine.handleReads(reads.filter(([, t]) => t > upTo && t <= to).map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
    upTo = to;
    s.clock.advance(3000);
  };
  s.more(cut);
  return s;
}

test('9.23 F14 on the course (the re-check\'s M4: 459, 2400m and 3100m missed): after its 4200m pass alone Split Relay can\'t tell 4200m from 4400m and offers both, neither the one click; its next pass settles it; one click; the later passes go to their own columns by themselves', () => {
  const bib = '62';
  const real = passesOf(bib);
  const s = womensLive({ drop: { [bib]: [real[2], real[3]] }, cut: real[4] + 30000 });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  const cell = v.columns[2];
  assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.missedHint.alt.names], [['2400m', '3100m'], false, ['2400m', '3100m', '4200m']]);
  assert.equal(cell.missed.reason, "15:18.4 looks like 4200m or 4400m, not 2400m: Split Relay can't tell which (missed 2400m and 3100m, or 2400m, 3100m and 4200m?).");
  assert.deepEqual([cell.missed.effect, cell.missed.alt.effect, cell.missed.sure], ['15:18.4 → 4200m', '15:18.4 → 4400m', false]);
  // the check queue's row offers both, neither as the one click; nothing of it went out a column early
  const row = s.engine.review('w').checks.find((c) => c.bib === bib && c.missed);
  assert.deepEqual([row.missed.sure, row.missed.count, row.missed.alt.count], [false, 2, 3]);
  assert.ok(linesOf(s, 0, bib).every((x) => x[1] > 5));
  // either count goes (the operator's choice), none is refused for not being Split Relay's
  assert.equal(s.engine.runner('w', bib).columns[2].missed.alt.ok, true);
  // its 4400m pass: 0:54 after 15:18.4 is 4200m to 4400m, not 4400m to 5300m: sure
  s.more(real[5] + 30000);
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.missedHint.alt], [['2400m', '3100m'], true, null]);
  let at = s.sends.length;
  s.engine.addMissed('w', bib, { splitId: v.columns[2].splitId, passTod: v.columns[2].missed.passTod, count: v.missedHint.count });
  assert.deepEqual(linesOf(s, at, bib).map((x) => [x[0], x[1], x[2]]), [['2400m', 5, linesOf(s, at, bib)[0][2]], ['3100m', 4, linesOf(s, at, bib)[1][2]],
    ['4200m', 3, '15:18.377'], ['4400m', 2, '16:12.759']]);
  sameOnBoth(s, at);
  // the rest of its race: 19:39.2 is 5300m, with its leg from 4400m; the finish pass an extra pass
  at = s.sends.length;
  s.more(Infinity);
  s.clock.advance(70_000);
  assert.deepEqual(linesOf(s, at, bib).map((x) => [x[0], x[1], x[2], x[3]]), [['5300m', 1, '19:39.154', '3:26.395']]);
  sameOnBoth(s, at);
});

test('9.23 F14 after a wrong count (a typed time, an older Split Relay): the made-up time that does not fit is pointed at with its fix, never Not a split for the real pass after it; one click makes it up again and moves the passes on, every line again; Undo', () => {
  for (const [bib, drop, wrong, names, cause] of [
    ['62', [2, 3], '10:59.954', ['2400m', '3100m'], /^2400m's made-up 11:00\.0 doesn't fit: 15:18\.4 looks like 4200m, not 3100m \(missed 2400m and 3100m\?\): 10:21 after 1500m, where runners of the same pace took 10:\d\d\.$/],
    ['106', [1, 2], '5:36.306', ['1500m', '2400m'], /^1500m's made-up 5:36\.4 doesn't fit: 10:25\.4 looks like 3100m, not 2400m \(missed 1500m and 2400m\?\)/],
    ['117', [4, 5], '16:47.687', ['4200m', '4400m'], /^4200m's made-up 16:47\.7 doesn't fit: 18:09\.9 looks like 5300m, not 4400m \(missed 4200m and 4400m\?\)/],
    ['42', [5, 6], '15:47.950', ['4400m', '5300m'], /^4400m's made-up 15:48\.0 doesn't fit: 21:02\.4 looks like the finish, not 5300m \(missed 4400m and 5300m\?\)/]]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    let v = s.engine.runner('w', bib);
    const k = drop[0];
    // the wrong count: one split, the time the old one click sent (a typed time is the operator's own: it goes)
    s.engine.addMissed('w', bib, { splitId: v.columns[k].splitId, passTod: v.columns[k].missed.passTod, count: 1, time: wrong });
    s.clock.advance(70_000);
    const rv = s.engine.review('w');
    const rows = rv.flags.filter((f) => f.bib === bib);
    assert.deepEqual(rows.map((f) => [f.kind, f.splitName, f.missed.names, f.missed.sure, f.suggest]), [['made-up', names[0], names, true, null]], `bib ${bib}`);
    assert.match(rows[0].text, cause);
    v = s.engine.runner('w', bib);
    // no "A stray pass?" with Not a split as its fix: the short leg after the made-up time is not a flag of its own
    assert.ok(v.columns.every((c) => !c.flag), JSON.stringify(v.columns.map((c) => c.flag)));
    assert.deepEqual(v.problems.map((p) => [p.kind, p.col]), [['made-up', k]]);
    const at = s.sends.length;
    const r = s.engine.addMissed('w', bib, { splitId: v.columns[k].splitId, passTod: v.columns[k].missed.passTod, count: rows[0].missed.count });
    assert.match(r.change.text, new RegExp(`^Missed ${names[0]} and ${names[1]} added \\(.*\\); ${names[0]} made up again \\(.* before\\)`));
    const lines = linesOf(s, at, bib);
    assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1].slice(k), `bib ${bib}: ${JSON.stringify(lines)}`);
    for (const [split, l2g, cs] of lines) {
      const c = 7 - l2g;
      if (drop.includes(c)) assert.ok(Math.abs(rt(cs) - real[c]) < 20 * S, `${bib} ${split} made up ${cs}, the mat ${formatRaceTime(real[c], 3)}`);
      else assert.equal(cs, formatRaceTime(real[c], 3), `${bib} ${split}`);
    }
    sameOnBoth(s, at);
    assert.deepEqual([s.engine.runner('w', bib).missedHint, s.engine.review('w').flags.filter((f) => f.bib === bib)], [null, []]);
    // Undo: the wrong count again, said in words, its lines again (the furthest last)
    const u = s.engine.undo('w', { fix: r.change.fix, confirm: true });
    assert.match(u.change.text, new RegExp(`${names[0]} is [\\d:.]+ again`));
    assert.equal(s.engine.review('w').flags.filter((f) => f.bib === bib).length, 1);
  }
});

test('9.23 F14 a time typed for a split pushes a made-up time out of course order with it out of the way, made up again, in words, every changed cell re-sent; a real pass set aside by mistake comes back with its own menu or Undo, its column re-sent', () => {
  // 524 on the re-check (runD): the wrong count (4200m made up 16:47.7 from 18:09.9 in 4400m), 18:09.9 moved to 5300m
  // by hand, then the real 4400m typed: "not after 4200m (16:47.7)" before
  const bib = '117';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4], real[5]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  s.engine.addMissed('w', bib, { splitId: v.columns[4].splitId, passTod: v.columns[4].missed.passTod, count: 1, time: '16:47.687' });
  s.clock.advance(70_000);
  v = s.engine.runner('w', bib);
  s.engine.movePass('w', bib, { tod: passAt(v, '18:09.9').tod, to: v.columns[6].splitId, from: v.columns[5].splitId });
  s.clock.advance(70_000);
  v = s.engine.runner('w', bib);
  let at = s.sends.length;
  const r = s.engine.addManual('w', { bib, splitId: v.columns[5].splitId, ifEmpty: true, time: '15:02.894' });
  assert.match(r.change.text, /^4400m 15:02\.9 typed; the made-up 4200m time \(16:47\.7\) made up again \(14:1\d\.\d\)$/);
  const lines = linesOf(s, at, bib);
  assert.deepEqual(lines.map((x) => [x[0], x[1]]), [['4200m', 3], ['4400m', 2], ['5300m', 1]]);
  assert.ok(Math.abs(rt(lines[0][2]) - real[4]) < 10 * S, `4200m made up again ${lines[0][2]}, the mat ${formatRaceTime(real[4], 3)}`);
  assert.deepEqual([lines[1][2], lines[1][3], lines[2][2], lines[2][3]], ['15:02.894', formatRaceTime(rt('15:02.894') - rt(lines[0][2]), 3), '18:09.814', '3:06.920']);
  sameOnBoth(s, at);
  // Undo: the made-up 4200m as it was, the typed 4400m taken back
  const u = s.engine.undo('w', { fix: r.change.fix, confirm: true });
  assert.equal(u.change.text, 'Undone: 4200m is 16:47.7 again; the typed 4400m time (15:02.9) taken back');
  // 459 on the re-check (runD): the wrong count's short leg was answered with Not a split on its real 4400m
  const b2 = '62';
  const r2 = passesOf(b2);
  const t = womens({ outputs: TWO_OUTPUTS, drop: { [b2]: [r2[2], r2[3]] } });
  t.engine.on('send', (p) => assertSendable(p, t.config));
  v = t.engine.runner('w', b2);
  t.engine.addMissed('w', b2, { splitId: v.columns[2].splitId, passTod: v.columns[2].missed.passTod, count: 1, time: '10:59.954' });
  t.clock.advance(70_000);
  v = t.engine.runner('w', b2);
  t.engine.movePass('w', b2, { tod: passAt(v, '16:12.8').tod, to: 'none', from: v.columns[4].splitId });
  t.clock.advance(70_000);
  // its own menu in Other passes: Let Split Relay count it, the column and the later ones re-sent, the furthest last
  v = t.engine.runner('w', b2);
  const p = passAt(v, '16:12.8');
  assert.deepEqual([p.inColumn, p.pinned], [false, 'none']);
  at = t.sends.length;
  const back = t.engine.movePass('w', b2, { tod: p.tod, to: 'count' });
  assert.equal(back.change.text, '16:12.8 is counted again (4200m); 19:39.2 → 4400m, 22:41.8 → 5300m');
  assert.deepEqual(linesOf(t, at, b2).map((x) => [x[0], x[2]]), [['4200m', '16:12.759'], ['4400m', '19:39.154'], ['5300m', '22:41.721']]);
  sameOnBoth(t, at);
  // and the real cause is pointed at again, with its fix
  assert.equal(t.engine.runner('w', b2).missedHint.by, 'madeUp');
  // or Undo of the Not a split: the same
  const t2 = womens({ outputs: TWO_OUTPUTS, drop: { [b2]: [r2[2], r2[3]] } });
  v = t2.engine.runner('w', b2);
  t2.engine.addMissed('w', b2, { splitId: v.columns[2].splitId, passTod: v.columns[2].missed.passTod, count: 1, time: '10:59.954' });
  t2.clock.advance(70_000);
  v = t2.engine.runner('w', b2);
  const n2 = t2.engine.movePass('w', b2, { tod: passAt(v, '16:12.8').tod, to: 'none', from: v.columns[4].splitId });
  t2.clock.advance(70_000);
  at = t2.sends.length;
  t2.engine.undo('w', { fix: n2.change.fix, confirm: true });
  assert.deepEqual(linesOf(t2, at, b2).map((x) => [x[0], x[2]]), [['4200m', '16:12.759'], ['4400m', '19:39.154'], ['5300m', '22:41.721']]);
});

test('9.23 F14 the other places a change makes out of date count each runner\'s split once, whatever the number of outputs, and say where (9.24: and go out again by themselves)', () => {
  const s = womens({ outputs: TWO_OUTPUTS, keep: RACE_DAY });
  const { 586: d } = s.sh;
  const before = s.engine.raceView('w').stale.count;
  const v = s.engine.runner('w', d);
  const at = s.sends.length;
  const r = s.engine.movePass('w', d, { tod: passAt(v, '16:10.8').tod, to: v.columns[4].splitId });
  // 9.24: the change puts the boards right itself: each of those lines once per output, none left out of date by it
  assert.ok(r.change.resent.lines > 0);
  assert.deepEqual([r.change.staleOthers, r.change.staleOutputs, r.change.resent.outputs], [0, [], ['TrackScore', 'Karmarush']]);
  const others = s.sends.map((p, i) => [p, s.net.via[i]]).slice(at).filter(([p]) => p.bib !== d);
  const linesOn = (o) => new Set(others.filter(([p, out]) => out === o && p.reason === 'place-update' && p.splitName !== '5300m').map(([p]) => `${p.bib}|${p.splitName}`));
  assert.deepEqual([...linesOn('o2')].sort(), [...linesOn('o1')].sort());
  sameOnBoth(s, at);
  const rv = s.engine.raceView('w');
  // the race tile counts what is left: what was out of date before, and the runner's own cells (the change reports
  // those itself): once each, each output having all of them
  assert.ok(rv.stale.count >= before && rv.stale.count <= before + 7, `${rv.stale.count} ${before}`);
  assert.deepEqual(rv.stale.byOutput.map((o) => [o.name, o.count]), [['TrackScore', rv.stale.count], ['Karmarush', rv.stale.count]]);
  // and what a Resend sends is what its toast says it sent
  const want = rv.resend.count;
  assert.equal(s.engine.resendRace('w').sent, want);
  assert.equal(s.engine.raceView('w').stale.count, 0);
});

test('9.23 F14 a finisher\'s furthest split goes last too, with the finish place: after a made-up split that waited for an output that was down (as after a restart)', () => {
  let down = false;
  const got = [];
  const net = { got, hold: new Set(), deliver(id, p, ack) {
    if (down) return false;
    got.push(p);
    ack(true);
    return true;
  } };
  const s = setup({ net });
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.lynx.set('105', Math.round(900 * 1.1 * S));
  s.places.set('105', 6);
  s.engine.converge();
  s.clock.advance(70_000);
  // the output is down when the made-up 2K is approved (it goes with the finish place)
  down = true;
  s.engine.addManual('r', { bib: '105', splitId: 's2' });
  const at = got.length;
  down = false;
  s.clock.advance(70_000);
  s.engine.converge([{ id: 'o1', enabled: true, state: 'connected', scriptOk: true, clients: 1 }]);
  // back up: the made-up 2K, then the runner's furthest split again, both with the finish place (before 9.23 F14 the
  // board's newest line of the runner was its 2K)
  assert.deepEqual(got.slice(at).filter((p) => p.bib === '105').map((p) => [p.splitName, p.place]), [['2K', 6], ['4K', 6]]);
});

test('9.23 F14 a finisher\'s furthest split goes last too after a kill: the made-up split of the last minute goes again, then the furthest one the boards took before the kill (runF\'s 428 and 593)', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.lynx.set('105', Math.round(900 * 1.1 * S));
  s.places.set('105', 6);
  s.engine.converge();
  s.clock.advance(70_000);
  // the made-up 2K with the finish place, then the runner's furthest split (#sendFixed), both acknowledged
  s.engine.addManual('r', { bib: '105', splitId: 's2' });
  s.clock.advance(3000);
  const at = s.sends.length;
  // killed: no stop(), no markCleanStop(); the packets of the last minute go again once RR12 has caught up
  const t = setup({ store: s.store, clock: s.clock, net: s.net, lynx: s.lynx, places: s.places, config: s.config });
  assert.match(t.logs.join('\n'), /did not stop cleanly last time/);
  t.clock.advance(16_000);
  const again = t.sends.slice(at).filter((p) => p.bib === '105');
  // (before: the made-up 2K alone, so the board's newest line of the runner was its 2K)
  assert.deepEqual(again.map((p) => [p.splitName, p.place]), [['2K', 6], ['4K', 6]]);
  assert.equal(again[1].lapsToGo, 1);
  // nothing else of it is out of date, and nothing more goes
  t.clock.advance(70_000);
  assert.equal(t.sends.slice(at).filter((p) => p.bib === '105').length, 2);
});

// ---- 9.23 F15: where the run of missed mats starts ----------------------------------------------------------------------

const W_NAMES = [...WOMENS.splits, 'the finish'];
/**
 * One sure "Missed …: add it" as the panel sends it from a Review row (the hint's own split and pass), and what went
 * out: from the first missed split on, every line once, in its column with its leg, the furthest last; the made-up
 * times within 25 s of what the mats would have read, the real ones exact; both outputs alike; and then on the boards
 * each column the runner's own time (no column keeps a time of another split or of the finish).
 */
function missedOneClick(s, bib, row, drop, real, { near = 25 * S } = {}) {
  const k = WOMENS.splits.findIndex((x, i) => s.config.races[0].splits[i].id === row.missed.splitId);
  const at = s.sends.length;
  // (9.23 F16: two mats missed apart: the further runs too, as the panel sends them)
  const also = row.missed.runs?.length > 1 ? row.missed.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) : undefined;
  const r = s.engine.addMissed('w', bib, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count, also });
  const lines = linesOf(s, at, bib);
  assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1].slice(k), `bib ${bib}: ${JSON.stringify(lines)}`);
  // (near null: a made-up time only between the real ones around it, as for the whole field)
  const made = (c, t) => (near === null ? t > (drop[0] ? real[drop[0] - 1] : 0) && t < real[drop.at(-1) + 1] : Math.abs(t - real[c]) < near);
  const right = (c, cs) => (drop.includes(c) ? made(c, rt(cs)) : cs === formatRaceTime(real[c], 3));
  const before = k ? s.engine.runner('w', bib).columns[k - 1].time : 0;
  lines.forEach(([split, l2g, cs, ls], i) => {
    const c = 7 - l2g;
    assert.ok(right(c, cs), `${bib} ${split} ${cs}, the mat ${formatRaceTime(real[c], 3)}`);
    assert.equal(rt(ls), rt(cs) - (i ? rt(lines[i - 1][2]) : before), `${bib} ${split}'s leg is from the split before it`);
  });
  sameOnBoth(s, at);
  for (const out of ['o1', 'o2']) {
    const b = board(s, bib, out);
    assert.equal(b.cols.length, 7, `${bib} ${out}: ${b.cols}`);
    for (const x of b.cols) {
      const c = 7 - Number(x.slice(0, x.indexOf(':')));
      const t = x.slice(x.indexOf(':') + 1);
      assert.ok(drop.includes(c) ? made(c, rt(t)) : t === formatRaceTime(real[c], 1), `${bib} ${out} ${x}: the mat ${formatRaceTime(real[c], 1)}`);
    }
    assert.equal(b.last[0], 1, `${bib} ${out}: the furthest split last`);
  }
  return r;
}

test('9.23 F15 where the run starts: the column check and the flag point at the pass they doubt, the run starts at another (561 and 565, 4200m and 4400m with a cool-down pass; 547 and 568, 4200m with the 4400m pass counted there; 412 and 418, the first three; 451, the last three; 491, a walker, 4400m and 5300m): the one click there, the Review row and the runner editor say the same, every line right on both outputs', () => {
  // (568, fixture 154, with 4200m missed: below, 9.23 F16)
  for (const [bib, drop, by, pointed] of [['147', [4, 5], 'check', 5], ['151', [4, 5], 'check', 5], ['137', [4], 'check', 5],
    ['22', [0, 1, 2], 'flag', 1], ['26', [0, 1, 2], 'flag', 1], ['54', [4, 5, 6], 'check', 5], ['91', [5, 6], 'flag', 4]]) {
    const real = passesOf(bib);
    const names = drop.map((i) => WOMENS.splits[i]);
    const k = drop[0];
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    let v = s.engine.runner('w', bib);
    // the hint: the split the run starts at, how many, sure; the cell says "Missed here?" with the pass in it
    assert.deepEqual([v.missedHint.splitName, v.missedHint.names, v.missedHint.sure, v.missedHint.alt, v.missedHint.by], [WOMENS.splits[k], names, true, null, by], `bib ${bib}`);
    const cell = v.columns[k];
    const t = real[k + drop.length];
    assert.deepEqual([cell.missed.here, cell.missed.ok, cell.time], [true, true, t], `bib ${bib}`);
    assert.ok(cell.missed.reason.startsWith(`${formatRaceTime(t, 1)} looks like ${W_NAMES[k + drop.length]}, not ${WOMENS.splits[k]} (missed ${names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(' and ')}?)`), `bib ${bib}: ${cell.missed.reason}`);
    // the editor: the one line with the fix is that pass's; the flag of the pass the check or the flag pointed at is not
    // a line of its own, the held passes after it have no buttons (they move with it)
    assert.deepEqual(v.problems.filter((p) => p.col <= k || p.kind !== 'check').map((p) => [p.kind, p.col, p.text]), [['missed', k, cell.missed.reason]], `bib ${bib}`);
    assert.ok(v.columns.every((c) => !c.flag), `bib ${bib}: no flag of its own at ${pointed}`);
    const rv = s.engine.review('w');
    let row;
    if (by === 'check') {
      // Passes to check: the runner's first held row carries it, with the hint's own split and pass, in its words
      const rows = rv.checks.filter((c) => c.bib === bib);
      row = rows[0];
      assert.deepEqual([row.missed.splitId, row.missed.passTod, row.missed.names, row.missed.sure, rows.slice(1).every((c) => !c.missed)],
        [cell.splitId, cell.missed.passTod, names, true, true], `bib ${bib}`);
      assert.ok(row.reason.startsWith(cell.missed.reason.replace(/\.$/, '')), `bib ${bib}: ${row.reason}`);
      if (row.from !== cell.splitId) assert.match(row.reason, new RegExp(`; ${row.timeText.replace('.', '\\.')} moves on with it \\((the finish|\\d+m|an extra pass)\\)$`), `bib ${bib}`);
    } else {
      // Splits that look wrong: the row is the pass where the run starts, in the hint's words (not the flagged leg's)
      const rows = rv.flags.filter((f) => f.bib === bib);
      assert.deepEqual(rows.map((f) => [f.kind, f.splitId, f.passTod, f.text, f.missed.names, f.missed.sure]), [['missed', cell.splitId, cell.missed.passTod, cell.missed.reason, names, true]], `bib ${bib}`);
      row = rows[0];
    }
    // the find list: one thing to look at, said as the missed splits
    const m = s.engine.find(bib).matches.find((x) => x.bib === bib);
    assert.deepEqual([m.missed, m.problems], [names, 1], `bib ${bib}`);
    missedOneClick(s, bib, row, drop, real);
    v = s.engine.runner('w', bib);
    assert.deepEqual([v.missedHint, v.problems.filter((p) => p.kind !== 'stale')], [null, []], `bib ${bib}: nothing left to do`);
  }
  // 9.23 F16: 568, a walker (its last 700 m took 5:51), with 4200m missed: its 4400m pass counted in 4200m fits 4400m, and
  // its finish read fits 5300m slowly, or the finish with 5300m missed too (4400m read): Split Relay can't tell which and
  // offers both, each with what it does, neither the one click (F15 sent "Missed 4200m: add it", here right by luck)
  const bib = '154';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4]] } });
  const h = s.engine.runner('w', bib).missedHint;
  const choices = [h, h.alt].map((x) => [x.names, x.read ?? null, x.effect]).sort((p, q) => p[0].length - q[0].length);
  assert.deepEqual([h.sure, choices], [false, [[['4200m'], null, '17:56.2 → 4400m, 22:31.3 → 5300m, 28:22.6 → extra pass (the finish)'],
    [['4200m', '5300m'], ['4400m'], '17:56.2 → 4400m, 22:31.3 → extra pass (the finish), 28:22.6 → extra pass']]]);
  const right = h.names.length === 1 ? h : h.alt;
  missedOneClick(s, bib, { missed: { splitId: right.splitId, passTod: right.passTod, count: 1 } }, [4], real);
});

test('9.23 F15 the last three missed with a cool-down pass (567): Split Relay can\'t tell two from three at the pass where the run starts, before the first held one; both offered, neither the one click; the right one sends every line', () => {
  const bib = '153';
  const real = passesOf(bib);
  const drop = [4, 5, 6];
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
  const v = s.engine.runner('w', bib);
  assert.deepEqual([v.missedHint.splitName, v.missedHint.count, v.missedHint.sure, v.missedHint.alt.count], ['4200m', 3, false, 2]);
  const row = s.engine.review('w').checks.find((c) => c.bib === bib && c.missed);
  assert.deepEqual([row.timeText, row.missed.splitId, row.missed.sure, row.missed.alt.count], ['28:42.6', v.columns[4].splitId, false, 2]);
  // before: "Missed 4400m: add it" was the one click, and sent the cool-down pass as 5300m
  assert.ok(row.reason.startsWith("24:55.0 looks like 5300m or the finish, not 4200m: Split Relay can't tell which (missed 4200m and 4400m, or 4200m, 4400m and 5300m?)"), row.reason);
  missedOneClick(s, bib, { missed: { ...row.missed, count: 3 } }, drop, real);
});

test('9.23 F15 on the course: when the run fits about as well from another pass, nothing is the one click ("can\'t tell yet where"); the runner\'s next pass settles it (418\'s first three missed)', () => {
  const bib = '93';
  const real = passesOf(bib);
  const drop = [0, 1, 2];
  const s = womensLive({ drop: { [bib]: drop.map((i) => real[i]) }, cut: real[4] + 30000 });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  // its 3100m pass counted in 800m and its 4200m pass in 1500m: the leg between them fits 2400m from 800m about as well
  // as 4200m from 3100m (9.23 F16: the first three missed fit it, or the first three and 4200m too, 3100m read: both
  // offered, neither the one click; F15 offered "Missed 1500m" alone, "can't tell yet where")
  assert.deepEqual([v.missedHint.splitName, v.missedHint.names, v.missedHint.sure, v.missedHint.unsure, v.missedHint.alt.names, v.missedHint.alt.read],
    ['800m', ['800m', '1500m', '2400m'], false, null, ['800m', '1500m', '2400m', '4200m'], ['3100m']]);
  const row = s.engine.review('w').flags.find((f) => f.bib === bib);
  assert.deepEqual([row.missed.sure, row.missed.unsure], [false, null]);
  assert.equal(row.text, "18:26.8 looks like 4200m or 4400m, not 1500m: Split Relay can't tell which (missed 800m, 1500m and 2400m, or 800m, 1500m, 2400m and 4200m?).");
  // its 4400m pass: from 3100m the run fits clearly
  s.more(real[5] + 30000);
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.missedHint.splitName, v.missedHint.names, v.missedHint.sure], ['800m', ['800m', '1500m', '2400m'], true]);
  const at = s.sends.length;
  s.engine.addMissed('w', bib, { splitId: v.columns[0].splitId, passTod: v.columns[0].missed.passTod, count: 3 });
  assert.deepEqual(linesOf(s, at, bib).map((x) => [x[0], x[1]]), [['800m', 7], ['1500m', 6], ['2400m', 5], ['3100m', 4], ['4200m', 3], ['4400m', 2]]);
  assert.deepEqual(linesOf(s, at, bib).slice(3).map((x) => x[2]), [3, 4, 5].map((i) => formatRaceTime(real[i], 3)));
  sameOnBoth(s, at);
});

test('9.23 F15 the real race: every 12th complete runner with two and three mats in a row taken out at every split, with the finish and cool-down passes in the stream and without: a sure one click is always right (the run\'s start and its count), and sends every line right', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const complete = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  const st = { all: 0, sure: 0, two: 0, wrong: [] };
  // (a dozen runners at a time, spread over the field, each with the same mats missed: as many as the field can take
  // without its own times there going wrong)
  for (const [len, fin, group] of [[2, true, 0], [3, true, 1], [2, false, 2], [3, false, 3], [2, true, 4], [3, true, 5]]) {
    const mine = complete.filter((_, i) => i % 12 === group);
    for (let j = 0; j + len <= 7; j++) {
      // (the last splits with no pass after them, the finish passes out of the stream: nothing moves on; typed instead)
      if (!fin && j + len === 7) continue;
      const drop = {};
      for (const bib of mine) {
        const real = passesOf(bib);
        drop[bib] = [...Array.from({ length: len }, (_, i) => real[j + i]), ...(fin ? [] : real.slice(7))];
      }
      const s = womens({ outputs: TWO_OUTPUTS, drop });
      for (const bib of mine) {
        const real = passesOf(bib);
        const h = s.engine.runner('w', bib).missedHint;
        st.all++;
        const at = WOMENS.splits.indexOf(h?.splitName);
        if (h?.sure) {
          if (at !== j || h.count !== len) st.wrong.push(`${bib} ${len}@${j} fin ${fin}: sure ${h.names.join('+')}`);
          else {
            st.sure++;
            const row = { missed: { splitId: h.splitId, passTod: h.passTod, count: h.count } };
            missedOneClick(s, bib, row, Array.from({ length: len }, (_, i) => j + i), real, { near: null });
          }
        } else if (h?.alt && at === j && [h.count, h.alt.count].includes(len)) st.two++;
        else if (h?.alt) st.wrong.push(`${bib} ${len}@${j} fin ${fin}: ${h.names.join('+')} or ${h.alt.names.join('+')}`);
      }
    }
  }
  console.log(`9.23 F15 the real race, through the engine: ${JSON.stringify({ ...st, wrong: st.wrong.length })}`);
  assert.deepEqual(st.wrong, [], 'never a wrong one click, nor two offered without the right one');
  assert.ok(st.sure / st.all > 0.93, `sure and right: ${st.sure} of ${st.all}`);
});

test('9.23 F15 finishers, FinishLynx has every finish: a finish read in the split the check holds is that finish (the last three missed: all three, not "4200m, or 4200m and 4400m?"); 568 with 1500m missed, its finish read in 5300m: 1500m; every line with the finish place', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const lynx = new Map();
  const places = new Map();
  WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => [r.bib, passesOf(r.bib)[7] + 4000]).sort((a, b) => a[1] - b[1])
    .forEach(([bib, t], i) => { lynx.set(bib, t); places.set(bib, i + 1); });
  for (const [bib, drop, text] of [['1', [4, 5, 6], /^21:44\.4 looks like the finish, not 4200m \(missed 4200m, 4400m and 5300m\?\)$/], ['154', [1], /^\d+:\d\d\.\d looks like 2400m, not 1500m \(missed 1500m\?\)/], ['9', [6], /missed 5300m\?/]]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) }, lynx, places });
    s.engine.converge();
    s.clock.advance(3000);
    const v = s.engine.runner('w', bib);
    const h = v.missedHint;
    assert.deepEqual([h.splitName, h.count, h.sure, h.alt], [WOMENS.splits[drop[0]], drop.length, true, null], `bib ${bib}: ${JSON.stringify(h)}`);
    assert.match(v.columns[drop[0]].missed.reason, text, `bib ${bib}`);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, withFinishPlace: true });
    const lines = linesOf(s, at, bib);
    assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1].slice(drop[0]), `bib ${bib}: ${JSON.stringify(lines)}`);
    for (const [split, l2g, cs, , p] of lines) {
      const c = 7 - l2g;
      assert.ok(drop.includes(c) ? Math.abs(rt(cs) - real[c]) < 30 * S : cs === formatRaceTime(real[c], 3), `bib ${bib} ${split} ${cs}`);
      assert.equal(p, places.get(bib), `bib ${bib} ${split}: the finish place`);
    }
    sameOnBoth(s, at);
  }
});

// ---- 9.23 F16: two mats missed apart, in one change ----------------------------------------------------------------------

test('9.23 F16 two mats missed apart in one change (447: 2400m and 4400m; 1500m and 3100m; the first and 2400m; the re-check\'s 408 and 544, 4200m and 5300m, and 547, 2400m and 4200m): sure, the words say both and the splits read between them; one click adds both: every affected split once in its column with its leg, the furthest last, on both outputs alike, no column with another split\'s time; one change in the journal, one Undo; nothing more after', () => {
  for (const [bib, drop, read] of [['50', [2, 5], ['3100m', '4200m']], ['26', [1, 3], ['2400m']], ['54', [1, 3], ['2400m']], ['117', [0, 2], ['1500m']],
    ['18', [4, 6], ['4400m']], ['134', [4, 6], ['4400m']], ['137', [2, 4], ['3100m']]]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    const ids = drop.map((i) => s.config.races[0].splits[i].id);
    const names = drop.map((i) => WOMENS.splits[i]);
    const v = s.engine.runner('w', bib);
    const h = v.missedHint;
    assert.deepEqual([h?.sure, h?.alt, h?.names, h?.runs?.map((x) => [x.splitId, x.count]), h?.read], [true, null, names, ids.map((x) => [x, 1]), read], `bib ${bib}: ${JSON.stringify(h)}`);
    // the cell where the first run starts says "Missed here?"; the set is no time to type (two splits)
    const cell = v.columns[drop[0]];
    assert.deepEqual([cell.missed.here, cell.missed.ok, cell.missed.typed, cell.missed.runs.length], [true, true, false, 2], `bib ${bib}`);
    // the Review row (the first held pass, or the look-wrong row) carries the same set
    const rv = s.engine.review('w');
    const row = rv.checks.find((c) => c.bib === bib && c.missed) ?? rv.flags.find((f) => f.bib === bib);
    assert.deepEqual([row.missed.names, row.missed.runs.map((x) => x.splitId), row.missed.read, row.missed.sure, row.missed.effect], [names, ids, read, true, cell.missed.effect], `bib ${bib}`);
    // one click: what went out is right (missedOneClick: every split from the first missed one on, once, in its column
    // with its leg, the made-up ones near what the mats would have read, the furthest last, both outputs alike, the boards)
    const r = missedOneClick(s, bib, row, drop, real);
    assert.match(r.change.text, new RegExp(`^Missed ${names[0]} and ${names[1]} added \\(\\d+:\\d\\d\\.\\d and \\d+:\\d\\d\\.\\d, made up\\); `), `bib ${bib}: ${r.change.text}`);
    const recs = journalOf(s).filter((x) => x.fix === r.change.fix);
    assert.deepEqual([recs[0].fixKind, recs.filter((x) => x.t === 'manual').map((x) => x.splitId)], ['missed', ids], `bib ${bib}: one change`);
    const after = s.engine.runner('w', bib);
    assert.deepEqual([after.missedHint, after.problems.filter((p) => p.kind !== 'stale'), s.engine.review('w').flags.filter((f) => f.bib === bib)], [null, [], []], `bib ${bib}: done`);
    // one Undo puts it all back (asked first: the boards keep the cells it filled), and the hint is there again
    assert.throws(() => s.engine.undo('w', { fix: r.change.fix }), (err) => err.code === 'UNDO_LEAVES', `bib ${bib}`);
    s.engine.undo('w', { fix: r.change.fix, confirm: true });
    const back = s.engine.runner('w', bib);
    assert.deepEqual([back.missedHint?.names, back.columns.filter((c) => c.kind === 'made-up').length], [names, 0], `bib ${bib}: undone`);
  }
  // the re-check's shapes, in words: the pass where the first run starts, and the second run's pass
  const words = (bib, drop) => {
    const real = passesOf(bib);
    const s = womens({ drop: { [bib]: drop.map((i) => real[i]) } });
    const v = s.engine.runner('w', bib);
    return [v.missedHint.effect, v.problems.map((p) => [p.kind, p.text])];
  };
  assert.deepEqual(words('134', [4, 6]), ['15:08.2 → 4400m, 20:43.5 → extra pass (the finish)', [
    ['missed', '15:08.2 looks like 4400m, not 4200m, and 20:43.5 like the finish, not 4400m (missed 4200m and 5300m?): 4:44 after 3100m, where runners of the same pace took 4:58.'],
    ['check', '4400m: Looks like the finish, not 4400m (it moves with the pass before it, and 5300m was missed too). Held until you choose.']]]);
  assert.deepEqual(words('18', [4, 6])[0], '16:41.3 → 4400m, 22:51.9 → extra pass (the finish)');
  assert.deepEqual(words('137', [2, 4]), ['10:24.1 → 3100m, 15:07.3 → 4400m, 18:13.1 → 5300m, 21:02.4 → extra pass (the finish)', [
    ['check', '2400m: Looks like 3100m, not 2400m, and 15:07.3 like 4400m, not 3100m (missed 2400m and 4200m?): 5:30 after 1500m, where runners of the same pace took 5:51. Held until you choose.'],
    ['check', '3100m: Looks like 4400m, not 3100m (it moves with the pass before it, and 4200m was missed too). Held until you choose.'],
    ['check', '4200m: Looks like 5300m, not 4200m (it moves with the pass before it). Held until you choose.'],
    ['check', '4400m: Looks like the finish, not 4400m (it moves with the pass before it). Held until you choose.']]]);
});

test('9.23 F16 a walker who missed 4200m and 5300m apart (the re-check\'s 568): Split Relay can\'t tell it from 4400m and 5300m in a row: both offered with what each does, neither the one click; the right one in one change, every line right on both outputs', () => {
  const bib = '154';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4], real[6]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const v = s.engine.runner('w', bib);
  const h = v.missedHint;
  // (F15: "Missed 4400m and 5300m: add them" was the one click, and sent its finish read's stretch as 4400m and 5300m)
  const choices = [h, h.alt].map((x) => [x.splitName, x.names, x.read ?? null, x.effect]).sort((p, q) => p[0].localeCompare(q[0]));
  assert.deepEqual([h.sure, h.unsure, choices], [false, 'where', [
    ['4200m', ['4200m', '5300m'], ['4400m'], '17:56.2 → 4400m, 28:22.6 → extra pass (the finish), 29:10.4 → extra pass'],
    ['4400m', ['4400m', '5300m'], null, '28:22.6 → extra pass (the finish), 29:10.4 → extra pass']]]);
  const row = s.engine.review('w').checks.find((c) => c.bib === bib && c.missed);
  assert.equal(row.reason, "Looks like the finish, not 4400m: Split Relay can't tell which (missed 4200m and 5300m, or 4400m and 5300m?)");
  assert.deepEqual(v.problems.filter((p) => p.kind === 'missed' || p.kind === 'check').map((p) => p.text)[0], `4400m: ${row.reason}. Held until you choose.`);
  // the operator who knows takes the two apart: one change, 4200m to 5300m right on both outputs
  const right = h.runs ? h : h.alt;
  // (a walker: its made-up 5300m is placed like the runners of its pace, a minute after its own; between its real neighbours)
  missedOneClick(s, bib, { missed: right }, [4, 6], real, { near: null });
  assert.equal(s.engine.runner('w', bib).missedHint, null);
});

test('9.23 F16 800m and 3100m missed by the slowest runners (only "9:57.6 comes late for 1500m … A missed mat?" before): the fit of all their passes points at both, the one click in Splits that look wrong; one change, every line right', () => {
  for (const bib of ['22', '26', '57', '92', '93']) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[0], real[3]] } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    const rows = s.engine.review('w').flags.filter((f) => f.bib === bib);
    assert.deepEqual(rows.map((f) => [f.kind, f.splitName, f.missed.names, f.missed.read, f.missed.sure]), [['missed', '800m', ['800m', '3100m'], ['1500m', '2400m'], true]], `bib ${bib}`);
    assert.match(rows[0].text, /^\d+:\d\d\.\d looks like 1500m, not 800m, and \d+:\d\d\.\d like 4200m, not 2400m \(missed 800m and 3100m\?\)\.$/, `bib ${bib}`);
    // the editor: the cell says "Missed here?", the one line with the fix; the leg the flag found is not a line of its own
    const v = s.engine.runner('w', bib);
    assert.deepEqual(v.problems.map((p) => [p.kind, p.col]), [['missed', 0]], `bib ${bib}`);
    missedOneClick(s, bib, rows[0], [0, 3], real);
    assert.deepEqual(s.engine.runner('w', bib).problems.filter((p) => p.kind !== 'stale'), [], `bib ${bib}`);
  }
});

test('9.23 F16 "also" in "Missed …: add it": its refusals in words; a set other than the sure one is refused (one at a time sent the finish read as 5300m); the API answers with the runner and the change', () => {
  const bib = '134';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4], real[6]] } });
  const v = s.engine.runner('w', bib);
  const [s4, s5, s6, s7] = [3, 4, 5, 6].map((i) => s.config.races[0].splits[i].id);
  const body = { splitId: s5, passTod: v.columns[4].missed.passTod, count: 1 };
  const no = (b, re) => assert.throws(() => s.engine.addMissed('w', bib, b), (err) => re.test(err.message), JSON.stringify(b));
  no({ ...body, also: 'x' }, /^"also" is the other runs of missed splits further on/);
  no({ ...body, also: [{ splitId: 'nope' }] }, /no such split in "also"/);
  no({ ...body, also: [{ splitId: s6, count: 1 }] }, /^4400m is not after 4400m, which was read: a run in a row is one "count"\.$/);
  no({ ...body, also: [{ splitId: s4, count: 1 }] }, /^3100m is not after 4400m, which was read/);
  no({ ...body, also: [{ splitId: s7, count: 2 }] }, /^"count" in "also" is how many splits in a row the mats missed from 5300m on: 1 to 1\.$/);
  no({ ...body, also: [{ splitId: s7 }], time: '14:20.0' }, /^A typed time is for one missed split/);
  // the sure set is both: "Missed 4200m: add it" alone is refused for suggested times, in words (a typed time goes)
  no(body, /^15:08\.2 looks like 4400m: bib 134 missed 4200m and 5300m \(4400m was read\)\? Add them together, or type the time\.$/);
  const typed = s.engine.addMissed('w', bib, { ...body, time: formatRaceTime(real[4], 3) });
  assert.match(typed.change.text, /^Missed 4200m added \(14:18\.4, typed\); 15:08\.2 → 4400m, 20:43\.5 → 5300m$/);
  s.engine.undo('w', { fix: typed.change.fix, confirm: true });
  // nothing changed by a refusal: the journal has the typed change and its Undo only
  assert.deepEqual(journalOf(s).filter((x) => x.fixKind && x.bib === bib).map((x) => x.fixKind), ['missed', 'undo']);
  // both together: one change
  const r = s.engine.addMissed('w', bib, { ...body, also: [{ splitId: s7, count: 1 }] });
  assert.deepEqual([r.change.kind, r.added.map((x) => x.splitName)], ['missed', ['4200m', '5300m']]);
});

test('9.23 F16 a made-up last split on the course, then the runner\'s cool-down pass: it replaces nothing (it replaced the made-up 5300m, and went out as 5300m)', () => {
  const bib = '159';
  const real = passesOf(bib);
  // 573 with 5300m missed, three cool-down passes after its finish read; on the course, 30 s after its finish read
  const s = womensLive({ drop: { [bib]: [real[6]] }, cut: real[7] + 300000 });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const h = s.engine.runner('w', bib).missedHint;
  // (9.23 F20: 30 s after it, its finish read in 5300m may still be a slow 5300m pass, the finish pass to come: Split
  // Relay waits for it before the one click; the operator who knows chooses it now)
  assert.deepEqual([h.names, h.sure, h.unsure], [['5300m'], false, 'next']);
  const r = s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: 1 });
  const made = r.added[0].raceTicks;
  // the cool-down passes come in
  const at = s.sends.length;
  s.more(Infinity);
  s.clock.advance(70_000);
  const v = s.engine.runner('w', bib);
  assert.deepEqual([v.columns[6].kind, v.columns[6].time, linesOf(s, at, bib).filter((x) => x[1] === 1)], ['made-up', made, []]);
  assert.deepEqual(v.passes.filter((p) => !p.inColumn).map((p) => p.how), ['extra', 'extra', 'extra', 'extra']);
});

/** A Missed hint or choice as its set of splits, "4200m | 5300m" (two runs apart), "2400m+3100m" (in a row). */
const setText = (h, names = WOMENS.splits) => (h.runs ?? [{ splitName: h.splitName, count: h.count }])
  .map((r) => names.slice(names.indexOf(r.splitName), names.indexOf(r.splitName) + r.count).join('+')).join(' | ');

test('9.23 F16 the real race, two mats missed apart: every 12th complete runner, one and two splits read between them, the first at 800m to the last at 5300m, with the finish and cool-down passes in the stream and without, after the race: a sure one click is always both runs, right, and sends every line right; when Split Relay can\'t tell, the right set is offered', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const complete = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  const st = { all: 0, sure: 0, offered: 0, wrong: [] };
  let group = 0;
  for (const fin of [true, false]) {
    for (const gap of [1, 2]) {
      for (let a = 0; a + gap + 1 < 7; a++) {
        const b = a + gap + 1;
        // (the last split missed with the finish passes out of the stream: nothing after it to move on; typed instead)
        if (!fin && b === 6) continue;
        const mine = complete.filter((_, i) => i % 12 === group % 12);
        group++;
        const drop = {};
        for (const bib of mine) {
          const real = passesOf(bib);
          drop[bib] = [real[a], real[b], ...(fin ? [] : real.slice(7))];
        }
        const s = womens({ outputs: TWO_OUTPUTS, drop });
        const right = `${WOMENS.splits[a]} | ${WOMENS.splits[b]}`;
        for (const bib of mine) {
          const real = passesOf(bib);
          const h = s.engine.runner('w', bib).missedHint;
          st.all++;
          if (h?.sure) {
            if (setText(h) !== right) st.wrong.push(`${bib} ${right} fin ${fin}: sure ${setText(h)}`);
            else {
              st.sure++;
              missedOneClick(s, bib, { missed: h }, [a, b], real, { near: 60 * S });
            }
          } else if (h?.alt && [h, h.alt].some((x) => setText(x) === right)) st.offered++;
          else if (h?.alt) st.wrong.push(`${bib} ${right} fin ${fin}: ${setText(h)} or ${setText(h.alt)}`);
        }
      }
    }
  }
  console.log(`9.23 F16 the real race, two apart, through the engine: ${JSON.stringify({ ...st, wrong: st.wrong.length })}`);
  assert.deepEqual(st.wrong, [], 'never a wrong one click, nor two offered without the right one');
  assert.ok(st.sure / st.all > 0.9, `sure and right: ${st.sure} of ${st.all}`);
});

test('9.23 F16 on the course: the real race streamed with two mats missed apart (2400m and 4200m; 4200m and 5300m) and an operator who clicks every sure one click at once: never a wrong one; a one click never sends a line a split early; every runner right at the end', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const complete = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  const st = { clicks: 0, wrong: [], early: [], end: [] };
  for (const [a, b, g] of [[2, 4, 3], [4, 6, 7]]) {
    const mine = complete.filter((_, i) => i % 12 === g);
    const drop = {};
    for (const bib of mine) drop[bib] = [passesOf(bib)[a], passesOf(bib)[b]];
    const s = womensLive({ drop, cut: 0 });
    const looks = mine.flatMap((bib) => passesOf(bib).filter((t, i) => i !== a && i !== b && t > passesOf(bib)[a]).map((t) => [t + 300000, bib])).sort((p, q) => p[0] - q[0]);
    const done = new Map(mine.map((bib) => [bib, new Set()]));
    const click = (bib, h) => {
      const at = s.sends.length;
      s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, also: h.runs?.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) });
      s.clock.advance(3000);
      // what the one click sent: each line its own split's time (a made-up one only at a or b, between the real ones)
      const real = passesOf(bib);
      for (const [split, l2g, cs] of linesOf(s, at, bib)) {
        const c = 7 - l2g;
        const ok = c === a || c === b ? rt(cs) > real[c - 1] && rt(cs) < real[c + 1] : cs === formatRaceTime(real[c], 3);
        if (!ok) st.early.push(`${bib}: ${split} ${cs}`);
      }
      for (const r of h.runs ?? [{ splitName: h.splitName }]) done.get(bib).add(WOMENS.splits.indexOf(r.splitName));
      st.clicks++;
    };
    for (const [t, bib] of looks) {
      s.more(t);
      const h = s.engine.runner('w', bib).missedHint;
      if (!h?.sure) continue;
      // right for what the runner has passed: a alone until a pass after b is in, then both (less what was added)
      const real = passesOf(bib);
      const want = [a, ...(t > real[b + 1] ? [b] : [])].filter((k) => !done.get(bib).has(k)).map((k) => WOMENS.splits[k]).join(' | ');
      if (setText(h) !== want) {
        st.wrong.push(`${bib} at ${formatRaceTime(t, 1)}: sure ${setText(h)}, right ${want}`);
        continue;
      }
      click(bib, h);
    }
    s.more(Infinity);
    s.clock.advance(70_000);
    for (const bib of mine) {
      const h = s.engine.runner('w', bib).missedHint;
      if (h) {
        const want = [a, b].filter((k) => !done.get(bib).has(k)).map((k) => WOMENS.splits[k]).join(' | ');
        const pick = [h, h.alt].filter(Boolean).find((x) => setText(x) === want);
        if (h.sure && !pick) st.wrong.push(`${bib} after the race: sure ${setText(h)}, right ${want}`);
        if (pick) click(bib, pick);
      }
      const real = passesOf(bib);
      const v = s.engine.runner('w', bib);
      if (!v.columns.every((c, k) => (k === a || k === b ? c.kind === 'made-up' : c.time === real[k]))) st.end.push(`${bib}: ${v.columns.map((c) => c.timeText).join(' ')}`);
    }
  }
  console.log(`9.23 F16 on the course, two apart: ${JSON.stringify({ clicks: st.clicks, wrong: st.wrong.length, early: st.early.length, end: st.end.length })}`);
  assert.deepEqual([st.wrong, st.early, st.end], [[], [], []]);
  // (9.23 F19: a one click on the course once the runner's next pass is in: by then often both runs, one click for both)
  assert.ok(st.clicks >= 28, `${st.clicks} one clicks`);
});

test('9.23 F16 synthetic races through the engine: two mats missed apart (and two in a row then one) at the first, middle and last splits, the finish pass in the stream or not, one runner in four with a cool-down pass: a sure one click is the right set nearly always and sends every line right; a runner whose mats all read is never given one', () => {
  const courses = [{ name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 }, { name: '5K, 1K splits', d: [1, 2, 3, 4], D: 5 }];
  const st = { all: 0, sure: 0, offered: 0, wrong: [], complete: 0, completeSure: 0 };
  for (const fin of [true, false]) {
    for (let seed = 1; seed <= 3; seed++) {
      for (const course of courses) {
        const n = course.d.length;
        const names = course.d.map((x) => `${x}K`);
        const race = makeRace(seed * 7919 + n, course, 140);
        const rand = rng(seed * 31 + n);
        for (const r of race) {
          r.miss = null;
          if (rand() < 0.15) {
            const len = rand() < 0.75 || n < 5 ? 1 : 2;
            const a = Math.floor(rand() * (n - len - 1));
            r.miss = [{ j: a, len }, { j: a + len + 1 + Math.floor(rand() * (n - a - len - 1)), len: 1 }];
          }
          const cool = rand() < 0.25;
          const out = new Set((r.miss ?? []).flatMap((m) => Array.from({ length: m.len }, (_, i) => m.j + i)));
          const ts = r.mats.filter((_, k) => !out.has(k));
          if (fin && !r.dnf) ts.push(r.finish, ...(cool ? [r.finish + 90 + rand() * 400] : []));
          r.passes = ts.map((t) => Math.round(t * S));
          r.out = out;
        }
        const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, names) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs: TWO_OUTPUTS });
        const reads = race.flatMap((r) => r.passes.map((t) => [r.bib, t])).sort((p, q) => p[1] - q[1]);
        s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
        s.clock.advance(70_000);
        for (const r of race) {
          if (r.dnf) continue;
          const h = s.engine.runner('w', r.bib).missedHint;
          if (!r.miss) {
            st.complete++;
            if (h?.sure) st.completeSure++;
            continue;
          }
          // (the last split missed with no pass after it: nothing moves on)
          const shift = r.miss[0].len;
          if (r.passes.length <= r.miss[1].j - shift) continue;
          st.all++;
          const right = r.miss.map((m) => names.slice(m.j, m.j + m.len).join('+')).join(' | ');
          if (!h) continue;
          if (!h.sure) {
            if (h.alt && [h, h.alt].some((x) => setText(x, names) === right)) st.offered++;
            continue;
          }
          if (setText(h, names) !== right) {
            st.wrong.push(`${course.name} s${seed} fin ${fin} ${r.bib} ${right}: sure ${setText(h, names)}`);
            continue;
          }
          st.sure++;
          const at = s.sends.length;
          s.engine.addMissed('w', r.bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, also: h.runs?.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) });
          const lines = linesOf(s, at, r.bib);
          assert.deepEqual(lines.map((x) => x[1]), Array.from({ length: n - r.miss[0].j }, (_, i) => n - r.miss[0].j - i), `${course.name} ${r.bib}`);
          for (const [split, l2g, cs] of lines) {
            const c = n - l2g;
            if (!r.out.has(c)) assert.equal(cs, formatRaceTime(Math.round(r.mats[c] * S), 3), `${course.name} ${r.bib} ${split}`);
          }
          sameOnBoth(s, at);
        }
      }
    }
  }
  console.log(`9.23 F16 synthetic races, two apart, through the engine: ${JSON.stringify({ ...st, wrong: st.wrong })}`);
  // (the first split missed on a course of even splits: a slower runner who missed the second fits about as well; walkers)
  assert.ok(st.all > 60 && st.sure / st.all > 0.6, `sure and right: ${st.sure} of ${st.all}`);
  assert.ok(st.wrong.length <= Math.ceil(st.all * 0.04), st.wrong.join('; '));
  assert.equal(st.completeSure, 0, `runners whose mats all read, given a one click: ${st.completeSure} of ${st.complete}`);
});

// ---- 9.23 F17: the back of the field without the runner itself; no flag at all; a finisher's trail; walkers ----------

/** The real neighbours of a made-up split c of a runner: the last real time before it and the next after it (or its finish). */
const realAround = (real, drop, c) => {
  let lo = 0;
  for (let y = c - 1; y >= 0; y--) {
    if (!drop.includes(y)) {
      lo = real[y];
      break;
    }
  }
  let hi = real[7] ?? Infinity;
  for (let y = c + 1; y < 7; y++) {
    if (!drop.includes(y)) {
      hi = real[y];
      break;
    }
  }
  return [lo, hi];
};

/** FinishLynx's finishes for every complete runner of the real race (its finish read + 0.4 s), and their places. */
function womensLynx() {
  const lynx = new Map();
  const places = new Map();
  WOMENS.runners.filter((r) => r.passes.length >= 8).map((r) => [r.bib, passesOf(r.bib)[7] + 4000]).sort((a, b) => a[1] - b[1])
    .forEach(([b, t], i) => {
      lynx.set(b, t);
      places.set(b, i + 1);
    });
  return { lynx, places };
}

test('9.23 F17 the re-check\'s 491, a walker who missed 800m, 2400m and 3100m: its 1500m pass, counted in 800m three minutes behind every other runner, is no fit for "Missed 1500m, 2400m and 3100m" (F16\'s sure and wrong one click); the one click is 800m and 2400m+3100m (1500m read), every line right on both outputs; so too with 221\'s 800m and 1500m missed in the same race', () => {
  const bib = '91';
  const real = passesOf(bib);
  for (const also of [{}, { 2: [passesOf('2')[0], passesOf('2')[1]] }]) {
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[0], real[2], real[3]], ...also } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    const h = s.engine.runner('w', bib).missedHint;
    assert.deepEqual([h.sure, h.alt, h.names, h.runs.map((x) => [x.splitName, x.count]), h.read, h.readText],
      [true, null, ['800m', '2400m', '3100m'], [['800m', 1], ['2400m', 2]], ['1500m'], '1500m was read'], JSON.stringify(h));
    assert.equal(h.effect, '6:03.9 → 1500m, 20:20.5 → 4200m, 21:30.3 → 4400m, 26:25.3 → 5300m, 30:13.0 → extra pass (the finish)');
    // Splits that look wrong: the row is its 800m pass, in the words of the set
    const row = s.engine.review('w').flags.find((f) => f.bib === bib);
    assert.deepEqual([row.kind, row.splitName, row.missed.names, row.missed.sure, row.text],
      ['missed', '800m', ['800m', '2400m', '3100m'], true, '6:03.9 looks like 1500m, not 800m, and 20:20.5 like 4200m, not 1500m (missed 800m, 2400m and 3100m?).']);
    if (also[2]) assert.deepEqual(s.engine.runner('w', '2').missedHint.names, ['800m', '1500m'], "221's own");
    // (a walker: its made-up 800m is placed like the runners of its pace; between its real neighbours)
    missedOneClick(s, bib, row, [0, 2, 3], real, { near: null });
    assert.equal(s.engine.runner('w', bib).missedHint, null);
  }
  // without the finish line in the stream, 800m, 1500m and 4200m missed: its passes where they are fit about as well
  // (Split Relay can't tell yet where); the set that fits best is offered beside the cell's own (F16: "Missed 2400m" alone),
  // and sends every line right
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[0], real[1], real[4], ...real.slice(7)] } });
  const h = s.engine.runner('w', bib).missedHint;
  assert.deepEqual([h.sure, h.unsure, [h, h.alt].map((x) => x.names.join('+'))], [false, 'where', ['2400m', '800m+1500m+4200m']]);
  assert.equal(h.alt.readText, '2400m and 3100m were read');
  missedOneClick(s, bib, { missed: h.alt }, [0, 1, 4], real, { near: null });
  // the pure rule: 6:03.9 is far past the back of the field in 800m (the others', the runner itself no part of it), not
  // in 1500m; its real 800m, 3:04.2, is not
  const n = 7;
  const runners = WOMENS.runners.map((r) => {
    const all = r.passes.slice().sort((x, y) => x - y);
    const ps = r.bib === bib ? all.filter((_, i) => ![0, 2, 3].includes(i)) : all;
    const kept = new Array(n).fill(null);
    ps.slice(0, n).forEach((t, c) => {
      kept[c] = t;
    });
    return { bib: r.bib, kept, real: kept.slice(), look: new Array(n).fill(null), passes: ps, finish: null };
  });
  const field = legField({ n, runners });
  const me = runners.find((r) => r.bib === bib);
  assert.deepEqual([pastField(field, me, 0, real[1]), pastField(field, me, 1, real[1]), pastField(field, me, 0, real[0])], [true, false, false]);
});

test('9.23 F17 no flag and no held pass (the re-check\'s 221: 800m, 1500m and 4200m missed, or 4400m): its 2400m pass, counted in 800m far behind every other runner there, is the cause; the one click in Splits that look wrong and the runner editor; every line right on both outputs', () => {
  const bib = '2';
  const real = passesOf(bib);
  for (const [drop, text] of [[[0, 1, 4], '8:49.0 looks like 2400m, not 800m, and 16:42.2 like 4400m, not 2400m (missed 800m, 1500m and 4200m?).'],
    [[0, 1, 5], '8:49.0 looks like 2400m, not 800m, and 20:08.0 like 5300m, not 3100m (missed 800m, 1500m and 4400m?).']]) {
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    const v = s.engine.runner('w', bib);
    // (F16: nothing at all; its lines went out two and three splits early)
    assert.deepEqual([v.missedHint.sure, v.missedHint.names, v.columns[0].missed.here, v.problems.map((p) => [p.kind, p.col, p.text])],
      [true, drop.map((i) => WOMENS.splits[i]), true, [['missed', 0, text]]]);
    const row = s.engine.review('w').flags.find((f) => f.bib === bib);
    assert.deepEqual([row.kind, row.text, row.missed.sure], ['missed', text, true]);
    missedOneClick(s, bib, row, drop, real, { near: 30 * S });
    assert.deepEqual(s.engine.runner('w', bib).problems.filter((p) => p.kind !== 'stale'), []);
  }
});

test('9.23 F17 568, a walker, with only 4400m missed (1.84 times the runners of its pace from 5300m to the finish): Split Relay can\'t tell it from 4200m and 5300m; both offered with what each does, the right one among them, neither the one click; the right one sends every line right. With FinishLynx\'s finishes, 568 with 4200m and 5300m missed: both offered, not "4400m and 5300m" sure', () => {
  const bib = '154';
  const real = passesOf(bib);
  let s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[5]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const h = s.engine.runner('w', bib).missedHint;
  const choices = [h, h.alt].map((x) => [x.names, x.effect]).sort((p, q) => p[0].length - q[0].length);
  // (F16: "Missed 4200m and 5300m" or "Missed 4400m and 5300m", neither right)
  assert.deepEqual([h.sure, choices], [false, [[['4400m'], '22:31.3 → 5300m, 28:22.6 → extra pass (the finish)'],
    [['4200m', '5300m'], '16:51.6 → 4400m, 22:31.3 → extra pass (the finish), 28:22.6 → extra pass']]]);
  const row = s.engine.review('w').checks.find((c) => c.bib === bib && c.missed);
  assert.equal(row.reason, "22:31.3 looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or 4200m and 5300m?)");
  // (the runner editor's held passes say where each set puts them; the pass one set moves first asks the row's question)
  const held = s.engine.runner('w', bib).columns.slice(5).map((c) => c.check?.reason ?? null);
  assert.deepEqual(held, ["Looks like 5300m or the finish, not 4400m: Split Relay can't tell which (missed 4400m, or 4200m and 5300m?)",
    "Looks like the finish or an extra pass, not 5300m (it moves with the pass before it): Split Relay can't tell which"]);
  const right = h.names.length === 1 ? h : h.alt;
  missedOneClick(s, bib, { missed: right }, [5], real, { near: null });
  assert.equal(s.engine.runner('w', bib).missedHint, null);
  // with FinishLynx's finishes: its finish read in 4400m made "Missed 4400m and 5300m" (every split from there on) sure
  const { lynx, places } = womensLynx();
  s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4], real[6]] }, lynx, places });
  s.engine.converge();
  s.clock.advance(3000);
  const f = s.engine.runner('w', bib).missedHint;
  assert.deepEqual([f.sure, [f, f.alt].map((x) => x.names.join('+')).sort()], [false, ['4200m+5300m', '4400m+5300m']]);
  const two = f.runs ? f : f.alt;
  const at = s.sends.length;
  s.engine.addMissed('w', bib, { splitId: two.splitId, passTod: two.passTod, count: two.count, also: two.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })), withFinishPlace: true });
  // (a finisher's made-up splits go with the finish place as they are made, then the rest, the furthest last)
  const lines = linesOf(s, at, bib);
  const newest = new Map(lines.map((x) => [x[1], x]));
  assert.deepEqual([[...newest.keys()].sort(), lines.every((x) => x[4] === places.get(bib)), lines.at(-1)[1]], [[1, 2, 3], true, 1]);
  assert.equal(newest.get(2)[2], formatRaceTime(real[5], 3), 'its 4400m pass in 4400m');
  for (const c of [4, 6]) {
    const [lo, hi] = realAround(real, [4, 6], c);
    assert.ok(rt(newest.get(7 - c)[2]) > lo && rt(newest.get(7 - c)[2]) < hi, `${WOMENS.splits[c]} made up between the real times around it`);
  }
  sameOnBoth(s, at);
});

test('9.23 F17 finishers (FinishLynx has every finish), the second mat missed at 5300m (the re-check\'s 441: 3100m and 5300m; 543: 800m and 5300m; 401: 4200m and 5300m; 451: 800m, 4400m and 5300m): one change, the finish read moved on past the last split, every line with the finish place on both outputs alike; nothing left to add', () => {
  const { lynx, places } = womensLynx();
  for (const [bib, drop, read] of [['45', [3, 6], '4200m and 4400m were read'], ['133', [0, 6], '1500m to 4400m were read'], ['11', [4, 6], '4400m was read'],
    ['54', [0, 5, 6], '1500m to 4200m were read']]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((i) => real[i]) }, lynx, places });
    s.engine.converge();
    s.clock.advance(3000);
    const h = s.engine.runner('w', bib).missedHint;
    // (F16: "Missed 3100m: add it" first; its finish read then in 5300m, a second one click)
    assert.deepEqual([h.sure, h.alt, h.names, h.readText], [true, null, drop.map((i) => WOMENS.splits[i]), read], `bib ${bib}: ${JSON.stringify(h)}`);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, also: h.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })), withFinishPlace: true });
    // (a finisher's made-up splits go with the finish place as they are made, then the rest: every split from the first
    // missed one on, the furthest last)
    const lines = linesOf(s, at, bib);
    assert.deepEqual([[...new Set(lines.map((x) => x[1]))].sort((p, q) => q - p), lines.at(-1)[1]], [[7, 6, 5, 4, 3, 2, 1].slice(drop[0]), 1], `bib ${bib}: ${JSON.stringify(lines)}`);
    for (const [split, l2g, cs, , p] of lines) {
      const c = 7 - l2g;
      const [lo, hi] = realAround(real, drop, c);
      assert.ok(drop.includes(c) ? rt(cs) > lo && rt(cs) < hi : cs === formatRaceTime(real[c], 3), `bib ${bib} ${split} ${cs}`);
      assert.equal(p, places.get(bib), `bib ${bib} ${split}: the finish place`);
    }
    sameOnBoth(s, at);
    const v = s.engine.runner('w', bib);
    assert.deepEqual([v.missedHint, v.columns.every((c, k) => (drop.includes(k) ? c.kind === 'made-up' : c.time === real[k]))], [null, true], `bib ${bib}: nothing more`);
  }
});

test('9.23 F17 a runner whose mats all read is never given a one click for being far behind: walkers at the back of synthetic races with two splits (the slowest by a gap: 2K at 15:43.8 where the others were by 14:44.6), and late starters in the real race (every 6th runner two or three minutes late)', () => {
  const courses = [{ name: '6K, 2K / 4K', d: [2, 4], D: 6 }, { name: '5K, mile splits', d: [1.609, 3.219], D: 5 }];
  let complete = 0;
  const sure = [];
  for (const seed of [4, 5, 7]) {
    for (const course of courses) {
      const n = course.d.length;
      const race = makeRace(seed * 7919 + n, course, 120 + (seed % 5) * 40);
      const rand = rng(seed * 31 + n);
      for (const r of race) {
        // (the draws of the synthetic eval, so that its walkers are these ones; every mat read here)
        const cool = rand() < 0.25;
        if (rand() < 0.15) {
          const len = 1 + Math.floor(rand() * Math.min(3, n - 1));
          rand();
          void len;
        }
        const ts = r.mats.slice();
        if (!r.dnf) ts.push(r.finish, ...(cool ? [r.finish + 90 + rand() * 400] : []));
        r.passes = ts.map((t) => Math.round(t * S));
      }
      const names = course.d.map((x) => `${x}K`);
      const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, names) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 } });
      const reads = race.flatMap((r) => r.passes.map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
      s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
      s.clock.advance(70_000);
      for (const r of race) {
        if (r.dnf) continue;
        complete++;
        const h = s.engine.runner('w', r.bib).missedHint;
        if (h?.sure) sure.push(`${course.name} s${seed} ${r.bib}: ${h.names.join('+')}`);
      }
    }
  }
  // the real race, late starters: all of a runner's passes 2 or 3 minutes later
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const all = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  for (const late of [120, 180]) {
    for (let g = 0; g < 6; g++) {
      const mine = new Set(all.filter((_, i) => i % 6 === g));
      const s = setup({ races: [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 } });
      const reads = WOMENS.runners.flatMap((r) => r.passes.map((t) => [r.bib, mine.has(r.bib) ? t + late * S : t])).sort((a, b) => a[1] - b[1]);
      s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
      s.engine.assign('w', { bib: WOMENS.keptAt3100.bib, tod: GUN + WOMENS.keptAt3100.raceTicks, splitId: null });
      s.clock.advance(70_000);
      for (const bib of mine) {
        complete++;
        const h = s.engine.runner('w', bib).missedHint;
        if (h?.sure) sure.push(`late ${late} s ${bib}: ${h.names.join('+')}`);
      }
    }
  }
  assert.ok(complete > 1500, `${complete} runners`);
  assert.deepEqual(sure, [], 'never a one click');
});

/**
 * 9.23 F18: the real race streamed a minute of race time at a time, each line out as it comes, with one runner's every
 * pass `late` later (it started late, its mats all read); fin false: the RR12 stream carries split points only; lynx:
 * FinishLynx's finishes and places (each complete runner's finish read + 0.4 s, the late starter's late too) read once
 * the race is in, as when FinishLynx's results file comes after the race.
 */
/**
 * The real race streamed a minute at a time with one runner (`bib`) every pass `late` ticks after the race's, read on
 * every mat. 9.23 F19: `drop`, that runner's passes (indexes) a mat missed; `slow`, [j, ticks]: it lost that much on the
 * leg to its pass j (every pass from j on later); `look(s, end)` after every minute.
 */
function womensLate(bib, late, { fin = true, lynx = false, outputs = TWO_OUTPUTS, drop = [], slow = null, look = null, extra = [], step = 60 * S } = {}) {
  const finishers = new Map();
  const places = new Map();
  const s = setup({ races: [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 },
    outputs, lynx: finishers, places });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const mine = lateTimes(bib, late, slow);
  // (9.23 F20: `extra`, the runner's stray reads, race ticks)
  const reads = WOMENS.runners.flatMap((r) => (r.bib === bib ? [...mine.slice(0, fin ? undefined : 7).filter((_, j) => !drop.includes(j)), ...extra] : passesOf(r.bib).slice(0, fin ? undefined : 7))
    .map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  let kept = false;
  // (9.23 F21: `step`, the race time between looks)
  for (let at = 0, end = step; at < reads.length; end += step) {
    const chunk = [];
    while (at < reads.length && reads[at][1] < end) chunk.push(reads[at++]);
    s.engine.handleReads(chunk.map(([b, t]) => ({ read: { location: '', bib: b, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
    // (521's lone pass kept in 3100m from the check queue, as on race day)
    if (!kept && end > WOMENS.keptAt3100.raceTicks) {
      s.engine.assign('w', { bib: WOMENS.keptAt3100.bib, tod: GUN + WOMENS.keptAt3100.raceTicks, splitId: null });
      kept = true;
    }
    s.clock.advance(3000);
    look?.(s, end);
  }
  s.clock.advance(70_000);
  if (lynx) {
    WOMENS.runners.filter((r) => r.passes.length >= 8).map((r) => [r.bib, (r.bib === bib ? mine : passesOf(r.bib))[7] + 4000]).sort((a, b) => a[1] - b[1])
      .forEach(([b, t], i) => {
        finishers.set(b, t);
        places.set(b, i + 1);
      });
    s.engine.converge();
    s.clock.advance(70_000);
  }
  return s;
}

/** 9.23 F19: a runner's passes started `late` ticks after the gun, `slow` ([j, ticks]) lost on the leg to its pass j. */
function lateTimes(bib, late, slow = null) {
  return passesOf(bib).map((t, j) => t + late + (slow && j >= slow[0] ? slow[1] : 0));
}

test('9.23 F18 a late starter is no missed first mat (the re-check\'s 423 and 530, every mat read, five minutes after the gun: once FinishLynx\'s finish was known every pass was held, and the sure one click "Missed 800m" sent each split a column late): 1, 2, 3, 5, 10 and 15 minutes late, with the stream\'s finish passes and FinishLynx\'s finishes, the finish passes only, and split points only, never held, never a one click or a row, every split\'s newest line its own time on both outputs alike; a quiet note says it', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const complete = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  // (front to back, and 154, 568 on race day: the walker who faded to 1.59 times the runners of its pace on its last leg)
  const some = [...complete.filter((_, i) => i % 50 === 7), '154'];
  const problems = [];
  const notes = [];
  for (const late of [60, 120, 180, 300, 600, 900]) {
    for (const mode of [{ lynx: true }, {}, { fin: false }]) {
      for (const bib of some) {
        const s = womensLate(bib, late * S, mode);
        const v = s.engine.runner('w', bib);
        const rv = s.engine.review('w');
        const what = `${bib} ${late} s late ${mode.lynx ? 'FinishLynx' : mode.fin === false ? 'split points' : 'finish passes'}`;
        const held = v.columns.filter((c) => c.held).map((c) => c.splitName);
        if (held.length) problems.push(`${what}: held ${held}`);
        if (v.missedHint) problems.push(`${what}: ${v.missedHint.sure ? 'SURE' : 'offered'} ${v.missedHint.names}`);
        if ([...rv.checks, ...rv.flags].some((x) => x.bib === bib)) problems.push(`${what}: a Review row`);
        const want = passesOf(bib).slice(0, 7).map((t, j) => `${7 - j}:${formatRaceTime(t + late * S, 1)}`);
        for (const out of ['o1', 'o2']) {
          const b = board(s, bib, out);
          if (JSON.stringify(b.cols) !== JSON.stringify(want) || b.last?.[0] !== 1) problems.push(`${what} ${out}: ${b.cols} (${want})`);
        }
        sameOnBoth(s, 0);
        if (v.lateStart) notes.push(`${what}: ${v.lateStart.text}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  // the note: only where the column check would have held the runner, its late start to the second
  assert.ok(notes.length >= 15 && notes.every((x) => /: \d+:\d\d$/.test(x)), notes.join('; '));
  for (const x of notes.filter((y) => / 300 s late/.test(y))) assert.match(x, /: (4:5\d|5:0\d)$/);
  // real missed first mats are still found, sure, with the right set: 800m, two and three in a row from it, and 800m and
  // 3100m apart, with the finish passes and with FinishLynx's finishes
  const { lynx, places } = womensLynx();
  for (const drop of [[0], [0, 1], [0, 1, 2], [0, 3]]) {
    for (const opts of [{}, { lynx, places }]) {
      for (const bib of some.slice(0, 4)) {
        const s = womens({ drop: { [bib]: drop.map((j) => passesOf(bib)[j]) }, ...opts });
        if (opts.lynx) {
          s.engine.converge();
          s.clock.advance(3000);
        }
        const h = s.engine.runner('w', bib).missedHint;
        const right = drop.length === 2 && drop[1] === 3 ? '800m+3100m' : WOMENS.splits.slice(0, drop.length).join('+');
        assert.deepEqual([h?.sure, h?.names.join('+')], [true, right], `${bib} missed ${right}${opts.lynx ? ' (FinishLynx)' : ''}`);
      }
    }
  }
});

test('9.23 F18 a wrong "Missed 800m" for a late starter taken back (a Move back, or Undo): every split it changed goes out again with its own time, laps to go and leg, the furthest last, on both outputs alike; nothing is held again', () => {
  const bib = '31';
  const late = 300 * S;
  const real = passesOf(bib).map((t) => t + late);
  for (const back of ['move', 'undo']) {
    const s = womensLate(bib, late, { lynx: true });
    assert.equal(s.engine.runner('w', bib).missedHint, null);
    // (a wrong fix as an older Split Relay offered it: the first pass moved on, 800m made up, with the finish place)
    let v = s.engine.runner('w', bib);
    const r = s.engine.addMissed('w', bib, { splitId: v.columns[0].splitId, passTod: v.columns[0].passTod, withFinishPlace: true });
    v = s.engine.runner('w', bib);
    assert.equal(v.columns[1].timeText, formatRaceTime(real[0], 1), 'the 800m pass moved on to 1500m');
    const at = s.sends.length;
    if (back === 'move') s.engine.movePass('w', bib, { tod: v.columns[1].passTod, to: v.columns[0].splitId, withFinishPlace: true });
    else s.engine.undo('w', { fix: r.change.fix, confirm: true });
    s.clock.advance(3000);
    v = s.engine.runner('w', bib);
    assert.deepEqual(v.columns.map((c) => [c.timeText, c.held]), real.slice(0, 7).map((t) => [formatRaceTime(t, 1), null]), back);
    assert.equal(v.missedHint, null, back);
    const lines = linesOf(s, at, bib);
    assert.deepEqual(lines.map((x) => x[1]), [7, 6, 5, 4, 3, 2, 1], `${back}: ${JSON.stringify(lines)}`);
    lines.forEach(([, l2g, cs, ls, p], i) => {
      assert.equal(cs, formatRaceTime(real[7 - l2g], 3), `${back} L2G ${l2g}`);
      assert.equal(rt(ls), rt(cs) - (i ? rt(lines[i - 1][2]) : 0), `${back} L2G ${l2g}'s leg`);
      assert.equal(p, s.places.get(bib), `${back}: with the finish place`);
    });
    sameOnBoth(s, at);
  }
});

test('9.23 F18 568, a walker, a finisher (FinishLynx has every finish), 3100m, 4200m and 5300m missed: not "3100m, 4400m and 5300m" sure (its trail of two mats, the splits its finish read would be left in, paid for none); both offered, the right one among them; the held pass says the row\'s question; the right one sends each split once, course order, every line right with the finish place', () => {
  const bib = '154';
  const real = passesOf(bib);
  const { lynx, places } = womensLynx();
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[3], real[4], real[6]] }, lynx, places });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  s.engine.converge();
  s.clock.advance(3000);
  const v = s.engine.runner('w', bib);
  const h = v.missedHint;
  assert.deepEqual([h.sure, [h, h.alt].map((x) => x.names.join('+')).sort()], [false, ['3100m+4200m+5300m', '3100m+4400m+5300m']]);
  assert.deepEqual(v.columns.slice(3, 5).map((c) => c.check?.reason), ["Looks like 4200m or 4400m, not 3100m: Split Relay can't tell which (missed 3100m, 4400m and 5300m, or 3100m, 4200m and 5300m?)",
    "Looks like the finish, not 4200m (it moves with the pass before it): Split Relay can't tell which (missed 3100m, 4400m and 5300m, or 3100m, 4200m and 5300m?)"]);
  // a Move's preview that holds a pass as the finish calls no other pass "(the finish)" (the panel said both, for two passes)
  const to4400 = passAt(v, formatRaceTime(real[5], 1)).targets.find((t) => t.splitName === '4400m');
  assert.equal(to4400.effect, [`${formatRaceTime(real[7], 1)} → 5300m (held: it looks like the finish)`, ...real.slice(8).map((t) => `${formatRaceTime(t, 1)} → extra pass`)].join(', '));
  const right = h.names.includes('4200m') ? h : h.alt;
  const at = s.sends.length;
  s.engine.addMissed('w', bib, { splitId: right.splitId, passTod: right.passTod, count: right.count, also: right.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })), withFinishPlace: true });
  const lines = linesOf(s, at, bib);
  assert.deepEqual(lines.map((x) => x[1]), [4, 3, 2, 1], JSON.stringify(lines));
  assert.equal(lines[2][2], formatRaceTime(real[5], 3), 'its 4400m pass in 4400m');
  for (const [, l2g, cs] of lines.filter((x) => x[1] !== 2)) {
    const c = 7 - l2g;
    const [lo, hi] = realAround(real, [3, 4, 6], c);
    assert.ok(rt(cs) > lo && rt(cs) < hi, `${WOMENS.splits[c]} made up between the real times around it`);
  }
  assert.ok(lines.every((x) => x[4] === places.get(bib)), 'with the finish place');
  sameOnBoth(s, at);
  assert.equal(s.engine.runner('w', bib).missedHint, null);
});

test('9.23 F18 a finisher\'s one click sends each split once, in course order, the furthest last (F17 sent the made-up ones first and 5300m twice: "3100m | 5300m | 4200m | 4400m | 5300m")', () => {
  const { lynx, places } = womensLynx();
  for (const [bib, drop] of [['45', [3, 6]], ['134', [4, 6]], ['54', [0, 5, 6]]]) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: drop.map((j) => real[j]) }, lynx, places });
    s.engine.converge();
    s.clock.advance(3000);
    const h = s.engine.runner('w', bib).missedHint;
    assert.equal(h.sure, true, bib);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, also: h.runs?.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })), withFinishPlace: true });
    const l2g = linesOf(s, at, bib).map((x) => x[1]);
    assert.deepEqual(l2g, [...new Set(l2g)].sort((a, b) => b - a), `${bib}: ${l2g}`);
    assert.equal(l2g.at(-1), 1, bib);
    sameOnBoth(s, at);
  }
});

test('9.23 F18 a Move by hand that leaves a finish read in the last split (the re-check\'s 227, 3100m and 5300m missed, "Move 15:04.1 to 4200m"): the finish read is held as the finish, never sent as 5300m; the Move\'s preview says so; then the last split\'s one click', () => {
  for (const bib of ['4', '45']) {
    const real = passesOf(bib);
    const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[3], real[6]] } });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    let v = s.engine.runner('w', bib);
    const p = passAt(v, formatRaceTime(real[4], 1));
    const target = p.targets.find((t) => t.splitName === '4200m');
    assert.equal(target.effect, `${formatRaceTime(real[5], 1)} → 4400m, ${formatRaceTime(real[7], 1)} → 5300m (held: it looks like the finish)`, bib);
    const at = s.sends.length;
    s.engine.movePass('w', bib, { tod: p.tod, to: target.splitId });
    s.clock.advance(3000);
    v = s.engine.runner('w', bib);
    assert.deepEqual([v.columns[6].timeText, v.columns[6].held], [formatRaceTime(real[7], 1), 'check'], bib);
    assert.deepEqual(linesOf(s, at, bib).map((x) => [x[1], x[2]]), [[3, formatRaceTime(real[4], 3)], [2, formatRaceTime(real[5], 3)]], bib);
    // the last split's one click: 5300m made up, the finish read an extra pass (the finish)
    const h = v.missedHint;
    assert.deepEqual([h.sure, h.names], [true, ['5300m']], bib);
    const at2 = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count });
    const l = linesOf(s, at2, bib);
    assert.deepEqual(l.map((x) => x[1]), [1], bib);
    assert.ok(rt(l[0][2]) > real[5] && rt(l[0][2]) < real[7], `${bib}: 5300m made up before its finish read`);
    sameOnBoth(s, at);
  }
});

test('9.23 F18 by hand with "This is the finish" and no finish place known (the re-check\'s 419, 800m and 5300m missed): the typed 800m is refused with the way out in words; the last split\'s "Missed 5300m" says the marked pass is the finish pass again and 800m can be filled then; after it, the typed 800m goes out with its own place, its next split with the new leg, the furthest last', () => {
  const bib = '27';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[0], real[6]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  s.engine.movePass('w', bib, { tod: passAt(v, formatRaceTime(real[1], 1)).tod, to: v.columns[1].splitId });
  v = s.engine.runner('w', bib);
  const fin = formatRaceTime(real[7], 1);
  s.engine.movePass('w', bib, { tod: passAt(v, fin).tod, to: 'finish' });
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.finished, v.finishBy, v.columns[0].kind], [true, 'marked', 'blocked']);
  const way = `Bib ${bib} has finished: you marked ${fin} as its finish, and Split Relay doesn't know a finish place for it. A finisher's splits go out with the finish place, so nothing of bib ${bib}'s can go live. `;
  assert.equal(v.columns[0].why, `${way}To send it: in 5300m choose "Missed 5300m: add it" (${fin} is the finish pass again, not the finish), then this split.`);
  assert.throws(() => s.engine.addManual('w', { bib, splitId: v.columns[0].splitId, time: '2:49.793', ifEmpty: true }), (err) => err.status === 409 && err.message.startsWith(way));
  assert.equal(v.columns[6].missed.effect, `${fin} → extra pass (the finish pass, no longer the finish you marked), ${formatRaceTime(real[8], 1)} → extra pass, 800m can be filled then`);
  s.engine.addMissed('w', bib, { splitId: v.columns[6].splitId, passTod: v.columns[6].missed.passTod });
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.finished, v.columns[0].kind], [false, 'missing']);
  const at = s.sends.length;
  s.engine.addManual('w', { bib, splitId: v.columns[0].splitId, time: '2:49.793', ifEmpty: true });
  const lines = linesOf(s, at, bib);
  assert.deepEqual(lines.map((x) => [x[1], x[2], x[3]]).slice(0, 2), [[7, '2:49.793', '2:49.793'], [6, formatRaceTime(real[1], 3), formatRaceTime(real[1] - rt('2:49.793'), 3)]]);
  assert.equal(lines.at(-1)[1], 1, 'the furthest last');
  sameOnBoth(s, at);
});

test('9.23 F18 walkers whose mats all read on synthetic courses of even splits (seeds the synthetic evals never tuned on: 9, 25, 26, 30, 35 and 38) are never given a one click: a flag the column check did not hold them for lets the passes where they are count against "Missed 1K" (every leg 1.8 times the runners nearest in time, "15:15.1 looks like 2K, not 1K (missed 1K?)" was sure)', () => {
  const courses = [{ name: '5K, 1K splits', d: [1, 2, 3, 4], D: 5 }, { name: '5K, 1.5K / 2.5K / 4K', d: [1.5, 2.5, 4], D: 5 }];
  let complete = 0;
  const sure = [];
  for (const seed of [9, 25, 26, 30, 35, 38]) {
    for (const course of courses) {
      const n = course.d.length;
      const race = makeRace(seed * 7919 + n, course, 120 + (seed % 5) * 40);
      const rand = rng(seed * 31 + n);
      for (const r of race) {
        // (the draws of the synthetic eval, runs of missed mats in a row: the same runners miss the same mats)
        r.cool = rand() < 0.25;
        r.out = new Set();
        if (rand() < 0.15) {
          const len = 1 + Math.floor(rand() * Math.min(3, n - 1));
          const j = Math.floor(rand() * (n - len + 1));
          for (let x = 0; x < len; x++) r.out.add(j + x);
        }
        const ts = r.mats.filter((_, k) => !r.out.has(k));
        if (!r.dnf) ts.push(r.finish, ...(r.cool ? [r.finish + 90 + rand() * 400] : []));
        r.passes = ts.map((t) => Math.round(t * S));
      }
      const names = course.d.map((x) => `${x}K`);
      const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, names) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 } });
      const reads = race.flatMap((r) => r.passes.map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
      s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
      s.clock.advance(70_000);
      for (const r of race) {
        if (r.dnf || r.out.size) continue;
        complete++;
        const h = s.engine.runner('w', r.bib).missedHint;
        if (h?.sure) sure.push(`${course.name} s${seed} ${r.bib}: ${h.names.join('+')}`);
      }
    }
  }
  assert.ok(complete > 1500, `${complete} runners`);
  assert.deepEqual(sure, [], 'never a one click');
});

test('9.23 F18 the words: "1 earlier pass needs a split before it"; a one click\'s preview says which passes the column check would hold (NB5\'s 451: "22:28.7 → 4400m (held: …)"); two sets offered: "Missed here?" on the pass the row asks about (568 with only 4400m missed: 4400m, not 4200m)', () => {
  let s = womens({ drop: { 1: [passesOf('1')[0], passesOf('1')[2]] } });
  let v = s.engine.runner('w', '1');
  // (800m and 2400m missed: its 3100m pass counted in 1500m has one pass before it, its 4200m pass in 2400m two)
  const p1 = v.passes.find((x) => x.timeText === formatRaceTime(passesOf('1')[3], 1));
  assert.equal(p1.targets[0].why, `The pass at ${formatRaceTime(passesOf('1')[3], 1)} can't be 800m: 1 earlier pass needs a split before it.`);
  const p3 = v.passes.find((x) => x.timeText === formatRaceTime(passesOf('1')[4], 1));
  assert.equal(p3.targets[0].why, `The pass at ${formatRaceTime(passesOf('1')[4], 1)} can't be 800m: 2 earlier passes need the splits before it.`);
  // 451 (fixture 54): 800m, 4400m and 5300m missed, no FinishLynx: its first one click, and what it holds then
  const real = passesOf('54');
  s = womens({ drop: { 54: [real[0], real[5], real[6]] } });
  v = s.engine.runner('w', '54');
  assert.deepEqual([v.missedHint.sure, v.missedHint.names], [true, ['800m']]);
  assert.ok(v.missedHint.effect.endsWith(`${formatRaceTime(real[7], 1)} → 4400m (held: it looks like 5300m), ${formatRaceTime(real[8], 1)} → 5300m (held: it looks like the finish)`), v.missedHint.effect);
  s.engine.addMissed('w', '54', { splitId: v.missedHint.splitId, passTod: v.missedHint.passTod, count: 1 });
  v = s.engine.runner('w', '54');
  assert.deepEqual(v.columns.slice(5).map((c) => c.held), ['check', 'check'], 'as the preview said');
  // 568 with only 4400m missed: two sets offered; the cell that says "Missed here?" is its 4400m, the held pass the row asks about
  s = womens({ drop: { 154: [passesOf('154')[5]] } });
  v = s.engine.runner('w', '154');
  assert.deepEqual([v.missedHint.sure, v.columns.map((c) => !!c.missed?.here)], [false, [false, false, false, false, false, true, false]]);
  assert.deepEqual([v.columns[5].missed.names, v.columns[5].missed.alt.names].sort(), [['4200m', '5300m'], ['4400m']]);
});

test('9.23 F19 late starters on the course (the re-check\'s LM2 and LM4, two and four minutes late, every mat read: the sure one click "Missed 800m: add it" from their first pass on, which sent every split a column late for the rest of the race, and their good passes held until their fifth): 1, 2, 3, 5, 10 and 15 minutes late, with the stream\'s finish passes and FinishLynx\'s finishes, the finish passes only, and split points only: never the one click; the first two passes out once the third is in; every split\'s newest line its own time on both outputs alike. Real first mats missed on the course are still found', () => {
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const complete = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).map((r) => r.bib);
  // (front to back, and 154, 568 on race day: the walker)
  const some = [...complete.filter((_, i) => i % 50 === 7), '154'];
  const problems = [];
  for (const late of [60, 120, 180, 300, 600, 900]) {
    for (const mode of [{ lynx: true }, {}, { fin: false }]) {
      for (const bib of some) {
        const mine = lateTimes(bib, late * S);
        const what = `${bib} ${late} s late ${mode.lynx ? 'FinishLynx' : mode.fin === false ? 'split points' : 'finish passes'}`;
        const s = womensLate(bib, late * S, {
          ...mode,
          look: (x, end) => {
            if (end < mine[0]) return;
            const v = x.engine.runner('w', bib);
            if (v.missedHint?.sure) problems.push(`${what} at ${formatRaceTime(end, 0)}: the one click ${v.missedHint.names}`);
            // (one pass can't tell a late start from a missed 800m; the second or third does)
            if (mine.filter((t) => t < end).length >= 3 && v.columns.slice(0, 2).some((c) => c.held)) problems.push(`${what} at ${formatRaceTime(end, 0)}: its first passes held after its third`);
          },
        });
        const v = s.engine.runner('w', bib);
        if (v.columns.some((c) => c.held) || v.missedHint) problems.push(`${what} after the race: held ${v.columns.filter((c) => c.held).map((c) => c.splitName)}, ${v.missedHint?.names ?? 'no hint'}`);
        const want = mine.slice(0, 7).map((t, j) => `${7 - j}:${formatRaceTime(t, 1)}`);
        for (const out of ['o1', 'o2']) {
          const b = board(s, bib, out);
          if (JSON.stringify(b.cols) !== JSON.stringify(want) || b.last?.[0] !== 1) problems.push(`${what} ${out}: ${b.cols} (${want})`);
        }
        sameOnBoth(s, 0);
      }
    }
  }
  assert.deepEqual(problems, []);
  // real first mats missed on the course: never a wrong one click, and the one click by the runner's third pass after it
  for (const bib of some.slice(0, 4)) {
    const real = passesOf(bib);
    const seen = [];
    womensLate(bib, 0, {
      drop: [0],
      look: (x, end) => {
        const h = x.engine.runner('w', bib).missedHint;
        if (h?.sure) seen.push([real.slice(1).filter((t) => t < end).length, h.names.join('+')]);
      },
    });
    assert.ok(seen.length && seen.every(([, names]) => names === '800m') && seen[0][0] <= 3, `${bib}: ${JSON.stringify(seen.slice(0, 3))}`);
  }
});

test('9.23 F19 a late starter who also missed a mat, FinishLynx\'s finishes known (the re-check\'s LS1, six minutes late, 2400m missed: three sure and wrong one clicks in a row, every split sent a column late; LS1b, four minutes, 4200m): "Missed 800m" is never the one click; the right set is offered with it, and taken it sends every split right on both outputs with the finish place, nothing held after it; a late starter who missed 800m itself, or 5300m, is still offered it (without FinishLynx too: the gun counted six minutes late and 800m missed as three splits on)', () => {
  for (const [bib, late, drop, lynx = true] of [['31', 360, [2]], ['60', 240, [4]], ['118', 360, [3, 4]], ['8', 120, [2]], ['1', 300, [0]], ['118', 360, [6]], ['60', 360, [0], false]]) {
    const s = womensLate(bib, late * S, { lynx, drop });
    const real = lateTimes(bib, late * S);
    const right = drop.map((j) => WOMENS.splits[j]).join('+');
    let v = s.engine.runner('w', bib);
    const h = v.missedHint;
    const what = `${bib} ${late} s late, ${right} missed${lynx ? '' : ', no FinishLynx'}`;
    assert.ok(h, `${what}: a hint`);
    const pick = [h, h.alt].filter(Boolean).find((x) => setText(x) === right);
    assert.ok(pick, `${what}: offered ${[h, h.alt].filter(Boolean).map((x) => setText(x)).join(' / ')}`);
    // (9.23 F20: or the right set the one click: with the runner itself at the back of the field where its passes are,
    // the count fit places a late starter's passes after its first; never a wrong one)
    if (drop[0] !== 0) assert.ok(h.sure ? setText(h) === right : h.unsure === 'late' || h.unsure === 'where', `${what}: ${h.sure} ${h.unsure} ${setText(h)}`);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, { splitId: pick.splitId, passTod: pick.passTod, count: pick.count, withFinishPlace: lynx,
      also: pick.runs?.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) });
    s.clock.advance(3000);
    v = s.engine.runner('w', bib);
    assert.deepEqual(v.columns.map((c, k) => (drop.includes(k) ? c.kind : c.timeText)), real.slice(0, 7).map((t, k) => (drop.includes(k) ? 'made-up' : formatRaceTime(t, 1))), what);
    assert.equal(v.columns.filter((c) => c.held).length, 0, `${what}: nothing held`);
    // every line it sent: a read split its own time, a missed one between the times around it, with the finish place
    for (const [, l2g, cs, , p] of linesOf(s, at, bib)) {
      const k = 7 - l2g;
      // (a missed first split made up from the runner's own start, a minute and more after it: not from the gun)
      if (drop.includes(k)) assert.ok(rt(cs) > (k ? real[k - 1] : late * S + 60 * S) && rt(cs) < real[k + 1], `${what}: ${WOMENS.splits[k]} ${cs}`);
      else assert.equal(cs, formatRaceTime(real[k], 3), `${what}: ${WOMENS.splits[k]}`);
      if (lynx) assert.equal(p, s.places.get(bib), `${what}: the finish place`);
    }
    const want = real.slice(0, 7).map((t, j) => `${7 - j}:${drop.includes(j) ? '' : formatRaceTime(t, 1)}`);
    for (const out of ['o1', 'o2']) {
      const b = board(s, bib, out);
      assert.deepEqual(b.cols.map((x, j) => (drop.includes(j) ? x.replace(/:[\d:.]+$/, ':') : x)), want, `${what} ${out}`);
    }
    sameOnBoth(s, at);
  }
});

test('9.23 F19 a walker six minutes late who also missed 800m (91, the re-check\'s 491: its 1500m pass at 12:03.9, counted in 800m, would need a start 8:56 after the gun at the back of the field\'s pace): on the course its one click is never "Missed 800m, 1500m and 2400m" (with CHECK_RULES.lateMax 8 minutes it was, for three minutes); after the race, with FinishLynx, "Missed 800m" the one click and right', () => {
  const bib = '91';
  const sure = [];
  const s = womensLate(bib, 360 * S, {
    lynx: true,
    drop: [0],
    look: (x, end) => {
      const h = x.engine.runner('w', bib).missedHint;
      if (h?.sure) sure.push(`${formatRaceTime(end, 0)}: ${h.names.join('+')}`);
    },
  });
  assert.deepEqual(sure.filter((x) => !x.endsWith(': 800m')), [], 'on the course');
  // (9.23 F20: "Missed 800m" the one click, or offered with the set that leaves its 800m pass where it is: with the
  // walker itself at the back of the field at 800m, that placing is no longer out, and its legs and the gun disagree)
  const h = s.engine.runner('w', bib).missedHint;
  assert.ok(h?.sure ? h.names.join() === '800m' : [h, h?.alt].some((x) => x?.names.join() === '800m'), JSON.stringify([h?.sure, h?.names, h?.alt?.names]));
});

test('9.23 F19 one slow leg, every mat read (the re-check\'s late8s: 2:30 lost on the 700 m from 2400m to 3100m, "13:14.4 looks like 4200m, not 3100m (missed 3100m?)" the sure one click once FinishLynx\'s finish was known, for 130 of 167, and right after the 3100m pass on the course): no one click, no Review row and nothing held after the race with FinishLynx\'s finishes, every split as read; on the course never the one click, also when the slow leg fits the split after it loosely and later passes do not undo it (2:00 lost from 800m to 1500m: the one click two passes on, before MOVED_FIT_WITHIN); the same five minutes late', () => {
  for (const [bib, late, leg, lost] of [['1', 0, 3, 150], ['31', 0, 3, 150], ['60', 300, 3, 150], ['118', 300, 3, 150], ['1', 0, 1, 120], ['20', 0, 3, 150]]) {
    const slow = [leg, lost * S];
    const real = lateTimes(bib, late * S, slow);
    const sure = [];
    const kinds = new Set();
    const s = womensLate(bib, late * S, {
      lynx: true,
      slow,
      look: (x, end) => {
        const h = x.engine.runner('w', bib).missedHint;
        if (h?.sure) sure.push(`${formatRaceTime(end, 0)}: ${h.names}`);
        else if (h) kinds.add(h.unsure);
      },
    });
    const what = `${bib} ${late} s late, ${lost} s lost on the leg to pass ${leg + 1}`;
    assert.deepEqual(sure, [], `${what}: on the course`);
    // (the 1500m time, 0.74 of the runners' leg to 2400m, fits neither split well: offered until its finish; 9.23 F20: or
    // its later passes fit as read with the slow leg left out, about as well: "a missed mat or a slow leg")
    if (leg === 1) assert.ok(kinds.has('slow') || kinds.has('leg'), `${what}: ${[...kinds]}`);
    const v = s.engine.runner('w', bib);
    const rv = s.engine.review('w');
    assert.deepEqual([v.missedHint, v.columns.filter((c) => c.held).length, [...rv.checks, ...rv.flags].filter((x) => x.bib === bib).length], [null, 0, 0], what);
    const want = real.slice(0, 7).map((t, j) => `${7 - j}:${formatRaceTime(t, 1)}`);
    for (const out of ['o1', 'o2']) assert.deepEqual(board(s, bib, out).cols, want, `${what} ${out}`);
    sameOnBoth(s, 0);
  }
});

test('9.23 F19 a Move by hand that leaves a finish read in the last split, a cool-down pass soon after it (the re-check\'s 230: 3100m and 5300m missed, its cool-down 1:21 after its finish read; "Move 15:12.7 to 4200m" sent the finish read as 5300m): the finish read is held as the finish, the preview says so; then the last split\'s one click', () => {
  const bib = '7';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[3], real[6]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  const p = passAt(v, formatRaceTime(real[4], 1));
  const target = p.targets.find((t) => t.splitName === '4200m');
  assert.ok(target.effect.startsWith(`${formatRaceTime(real[5], 1)} → 4400m, ${formatRaceTime(real[7], 1)} → 5300m (held: it looks like the finish)`), target.effect);
  const at = s.sends.length;
  s.engine.movePass('w', bib, { tod: p.tod, to: target.splitId });
  s.clock.advance(3000);
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.columns[6].timeText, v.columns[6].held], [formatRaceTime(real[7], 1), 'check']);
  assert.deepEqual(linesOf(s, at, bib).map((x) => [x[1], x[2]]), [[3, formatRaceTime(real[4], 3)], [2, formatRaceTime(real[5], 3)]]);
  const h = v.missedHint;
  assert.deepEqual([h.sure, h.names], [true, ['5300m']]);
  const at2 = s.sends.length;
  s.engine.addMissed('w', bib, { splitId: h.splitId, passTod: h.passTod, count: h.count });
  const l = linesOf(s, at2, bib);
  assert.deepEqual(l.map((x) => x[1]), [1]);
  assert.ok(rt(l[0][2]) > real[5] && rt(l[0][2]) < real[7], '5300m made up before its finish read');
  sameOnBoth(s, at);
});

test('9.23 F19 no made-up time after a finish read: 568 (3100m, 4200m and 5300m missed, FinishLynx\'s finish 0.4 s after its finish read, counted in 4200m) had 4400m and 5300m "made up" 28:22.7 and 28:22.8 between them; the cells say why there is none', () => {
  const real = passesOf('154');
  const { lynx, places } = womensLynx();
  const s = womens({ drop: { 154: [real[3], real[4], real[6]] }, lynx, places });
  s.engine.converge();
  s.clock.advance(3000);
  const v = s.engine.runner('w', '154');
  assert.equal(v.columns[4].timeText, formatRaceTime(real[7], 1), 'its finish read counted in 4200m');
  for (const k of [5, 6]) {
    assert.equal(v.columns[k].estimate, null, WOMENS.splits[k]);
    assert.equal(v.columns[k].basis, `4200m 28:22.6 is the finish read (the finish 28:23.0): there is no time for ${WOMENS.splits[k]} after it.`);
  }
});

test('9.23 F19 the column check by hand: a runner with every split read and its finish read at its known finish is never held (a late start on even splits, where the legs can\'t tell); closeFit: on even splits a placing a split on fits as well, so few legs say no late start; a placing where a pass can\'t be is no rival', () => {
  const T = (m) => Math.round(m * 60 * S);
  // twelve runners over 5 even splits, a minute a split at 1.0 to 1.55 times the pace, the finish a split after the last
  const runner = (bib, pace, late = 0) => {
    const real = Array.from({ length: 5 }, (_, k) => T((k + 1) * pace) + late);
    return { bib, passes: real.map((t, c) => ({ t, col: c })), real, finish: T(6 * pace) + late, afterLast: T(6 * pace) + late - 4000 };
  };
  const field = Array.from({ length: 12 }, (_, i) => runner(`f${i}`, 1 + i * 0.05));
  const res = columnCheck({ n: 5, runners: [...field, runner('L', 1.2, T(3))], near: 10 * S });
  assert.equal(res.suspects.has('L'), false, 'every split read before its known finish');
  const others = field.map((r) => ({ bib: r.bib, real: r.real, finish: r.finish }));
  const timeOf = (o, c) => (c < 5 ? o.real[c] : o.finish);
  const ev = [0, 1, 2].map((c) => ({ t: T((c + 1) * 1.2) + T(3), c }));
  const own = legShape(ev, others, timeOf);
  assert.ok(own && own.cost < 0.01, JSON.stringify(own));
  assert.equal(closeFit(own, ev, 5, others, timeOf), false, 'a split on fits as well');
  assert.equal(closeFit(own, ev, 5, others, timeOf, (t, c) => c < 3), true, 'no placing where its passes can be fits as well');
  assert.equal(closeFit({ ...own, cost: CHECK_RULES.shapeClose + 0.01 }, ev, 5, others, timeOf, (t, c) => c < 3), false, 'not closely enough');
});

/** 9.23 F20: the set of a hint or a choice as split names in course order, "2400m" or "800m+2400m", with what it sets aside. */
const setOfHint = (h) => (h ? `${h.names.join('+')}${h.aside?.length ? ` aside ${h.aside.map((a) => a.timeText).join(',')}` : ''}` : '-');
/** 9.23 F20: the request the runner editor sends for a hint or a choice (its runs, the passes it sets aside). */
const bodyOf = (h, extra = {}) => ({ splitId: h.splitId, passTod: h.passTod, count: h.count, ...(h.runs?.length > 1 ? { also: h.runs.slice(1).map((r) => ({ splitId: r.splitId, count: r.count })) } : {}),
  ...(h.aside?.length ? { aside: h.aside.map((a) => a.passTod) } : {}), ...extra });
/** 9.23 F20: every split's newest line on both outputs is its real time, a missed one a made-up time between its neighbours. */
function rightBoards(s, bib, real, missed, what) {
  for (const out of ['o1', 'o2']) {
    const cols = new Map(board(s, bib, out).cols.map((x) => [Number(x.split(':')[0]), x.slice(x.indexOf(':') + 1)]));
    for (let j = 0; j < 7; j++) {
      const got = cols.get(7 - j);
      if (!missed.includes(j)) {
        assert.equal(got, formatRaceTime(real[j], 1), `${what} ${out}: ${WOMENS.splits[j]}`);
        continue;
      }
      let lo = 0;
      for (let y = j - 1; y >= 0; y--) if (!missed.includes(y)) { lo = real[y]; break; }
      let hi = real[7];
      for (let y = j + 1; y < 7; y++) if (!missed.includes(y)) { hi = real[y]; break; }
      const t = got ? parseRaceTime(got) : null;
      assert.ok(t !== null && t > lo && t < hi, `${what} ${out}: ${WOMENS.splits[j]} made up ${got} between ${formatRaceTime(lo, 1)} and ${formatRaceTime(hi, 1)}`);
    }
  }
}

test('9.23 F20 a missed mat and a stray pass that makes up for it in the count (the re-check\'s probe8dup: 2400m missed and a second read 40 s after the 3100m pass, beyond the tag window; FinishLynx\'s finish known: no hint and no Review row, 2400m holding its 3100m time on both boards; c53dc9a\'s sure "Missed 2400m" sent the stray as 4200m): never silent; the one click sets the stray aside and sends every split right on both outputs alike, the stray in no column; a complete runner with a stray pass: its Not a split is the one click, nothing held', () => {
  for (const bib of ['1', '31', '60', '118']) {
    const real = passesOf(bib);
    for (const [k, after] of [[2, 40], [1, 60], [0, 45]]) {
      const stray = real[k + 1] + after * S;
      for (const mode of [{ lynx: true }, {}]) {
        const s = womensLate(bib, 0, { ...mode, drop: [k], extra: [stray] });
        const what = `${bib} ${WOMENS.splits[k]} missed, a stray ${after} s after ${WOMENS.splits[k + 1]}, ${mode.lynx ? 'FinishLynx' : 'finish passes'}`;
        const v = s.engine.runner('w', bib);
        const h = v.missedHint;
        assert.equal(setOfHint(h), `${WOMENS.splits[k]} aside ${formatRaceTime(stray, 1)}`, what);
        assert.equal(h.sure, true, what);
        // never silent: the runner's row carries it, its words name the stray
        const rv = s.engine.review('w');
        const row = [...rv.flags, ...rv.checks].find((x) => x.bib === bib && x.missed);
        assert.ok(row && row.missed.aside?.length === 1, `${what}: ${JSON.stringify(row?.missed)}`);
        assert.match(h.effect, new RegExp(`${formatRaceTime(stray, 1).replace('.', '\\.')} → not a split`), what);
        const at = s.sends.length;
        s.engine.addMissed('w', bib, bodyOf(h, mode.lynx ? { withFinishPlace: true } : {}));
        s.clock.advance(3000);
        rightBoards(s, bib, real, [k], what);
        sameOnBoth(s, at);
        const after2 = s.engine.runner('w', bib);
        assert.deepEqual([after2.missedHint, after2.columns.filter((c) => c.held).length, after2.passes.find((p) => p.raceTicks === stray)?.how], [null, 0, 'ignored'], what);
      }
    }
  }
  // a complete runner with a stray pass: the stray takes a split, every later pass a split early, until its Not a split
  for (const bib of ['1', '118']) {
    const real = passesOf(bib);
    const stray = real[3] + 45 * S;
    const s = womensLate(bib, 0, { lynx: true, extra: [stray] });
    const v = s.engine.runner('w', bib);
    assert.deepEqual([v.missedHint, v.columns.filter((c) => c.held).length], [null, 0], `${bib}: nothing held`);
    const c = v.columns.find((x) => x.flag && x.flag.suggest?.to === 'none');
    assert.ok(c && c.time === stray, `${bib}: the stray's flag says Not a split`);
    s.engine.movePass('w', bib, { tod: c.passTod, to: 'none', withFinishPlace: true });
    s.clock.advance(3000);
    rightBoards(s, bib, real, [], `${bib} a stray after 3100m, set aside`);
  }
});

test('9.23 F20 a stray soon after the 4400m pass, 4200m missed (mine, stray8: a read 60 s after it, counted in 4400m, takes as long from that pass as a real 200 m leg, and leaves the 900 m on to 5300m 1:00 short but as long as the leaders\' there or longer: no hint and no row for 119 of 167 with the leaders\' rule alone): a leg far shorter than the runner\'s own pace is a stray\'s too (CHECK_RULES.strayOwn); the one click sets it aside, every split right on both outputs; by hand, a late start and a fast last leg are no stray', () => {
  for (const bib of ['2', '3', '5']) {
    const real = passesOf(bib);
    const stray = real[5] + 60 * S;
    for (const mode of [{ lynx: true }, {}]) {
      const s = womensLate(bib, 0, { ...mode, drop: [4], extra: [stray] });
      const what = `${bib} 4200m missed, a stray 60 s after 4400m, ${mode.lynx ? 'FinishLynx' : 'finish passes'}`;
      const h = s.engine.runner('w', bib).missedHint;
      assert.equal(setOfHint(h), `4200m aside ${formatRaceTime(stray, 1)}`, what);
      // (9.23 F21: the one click when its legs fit clearly better than the passes as read; 2 with the stream's finish
      // passes fits it 0.14 better, within CHECK_RULES.shapeMargin: offered, "a stray pass or a fast leg")
      if (mode.lynx || bib !== '2') assert.equal(h.sure, true, what);
      else assert.deepEqual([h.sure, h.unsure], [false, 'stray'], what);
      const rv = s.engine.review('w');
      const row = [...rv.flags, ...rv.checks].find((x) => x.bib === bib && x.missed);
      assert.ok(row && row.missed.aside?.length === 1, `${what}: ${JSON.stringify(row?.missed)}`);
      const at = s.sends.length;
      s.engine.addMissed('w', bib, bodyOf(h, mode.lynx ? { withFinishPlace: true } : {}));
      s.clock.advance(3000);
      rightBoards(s, bib, real, [4], what);
      sameOnBoth(s, at);
    }
  }
  // by hand: six splits as the real race's 2400m to 5300m, a short leg then a long one (seconds at the leaders' pace),
  // twelve runners at 1.0 to 1.55 times it
  const cum = [150, 300, 450, 600, 650, 850];
  const at = (pace, k, late = 0) => Math.round((cum[k] * pace + late) * S);
  const runnerOf = (bib, real, finish) => ({ bib, passes: real.map((t, c) => ({ t, col: c })), real: real.slice(), finish, afterLast: finish - 4000 });
  const field = Array.from({ length: 12 }, (_, i) => runnerOf(`f${i}`, cum.map((_, k) => at(1 + i * 0.05, k)), Math.round(1000 * (1 + i * 0.05) * S)));
  // at 1.3 times it, the 4th split missed and a stray 70 s after the 5th: the leg into the stray 1.27 of the leaders' there,
  // the leg on from it 0.9 of theirs (no strayLeg) and 0.74 of its own pace
  const x = [at(1.3, 0), at(1.3, 1), at(1.3, 2), at(1.3, 4), at(1.3, 4) + 70 * S, at(1.3, 5)];
  const X = runnerOf('X', x, Math.round(1300 * S));
  const cf = checkField({ n: 6, runners: [...field, X], near: 10 * S });
  assert.deepEqual([strayLegs(cf, X), strayIn(cf, X), field.some((r) => strayIn(cf, r))], [[[4, 5]], true, false], 'a leg far shorter than its own pace');
  // two minutes late at the leaders' pace: every leg its own, no stray
  const L = runnerOf('L', cum.map((_, k) => at(1, k, 120)), Math.round(1120 * S));
  assert.deepEqual(strayLegs(checkField({ n: 6, runners: [...field, L], near: 10 * S }), L), [], 'a late start');
  // a fast last leg, 0.85 of its own pace
  const k = cum.map((_, j) => at(1.3, j));
  k[5] = k[4] + Math.round(0.85 * 200 * 1.3 * S);
  const K = runnerOf('K', k, k[5] + Math.round(150 * 1.3 * S));
  assert.deepEqual(strayLegs(checkField({ n: 6, runners: [...field, K], near: 10 * S }), K), [], 'a fast last leg');
});

test('9.23 F20 a late starter who missed a later mat, FinishLynx\'s finishes known (the re-check\'s late8: one to two minutes late with 4400m missed, the sure and wrong "Missed 4200m", its one click sending the good 4200m pass as 4400m; 4200m and 5300m missed, the same): never a sure wrong one click; the right set sure or offered, and taken, every split right on both outputs with the finish place', () => {
  const problems = [];
  for (const [bib, late, drop] of [['10', 120, [5]], ['1', 90, [5]], ['60', 60, [5]], ['1', 60, [4, 6]], ['31', 90, [4, 6]], ['118', 120, [4, 6]]]) {
    const s = womensLate(bib, late * S, { lynx: true, drop });
    const real = lateTimes(bib, late * S);
    const what = `${bib} ${late} s late, ${drop.map((j) => WOMENS.splits[j]).join(' and ')} missed`;
    const right = drop.map((j) => WOMENS.splits[j]).join('+');
    const h = s.engine.runner('w', bib).missedHint;
    const pick = [h, h?.alt].filter(Boolean).find((x) => x.names.join('+') === right);
    if (h?.sure && h.names.join('+') !== right) problems.push(`${what}: SURE ${setOfHint(h)}`);
    if (!pick) {
      problems.push(`${what}: the right set not offered (${setOfHint(h)} / ${setOfHint(h?.alt)})`);
      continue;
    }
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(pick, { withFinishPlace: true }));
    s.clock.advance(3000);
    rightBoards(s, bib, real, drop, what);
    sameOnBoth(s, at);
    const fp = s.engine.runner('w', bib).finishPlace;
    assert.ok(linesOf(s, at, bib).every((x) => x[4] === fp), `${what}: with the finish place`);
  }
  // as 051d375: a late starter who missed its first mat, FinishLynx's finish known, has "Missed 800m" as its sure and right
  // one click (the gun's placings of its late passes had a good pass taken for a stray, "800m and 1500m (… is a stray
  // pass)", and a set that leaves its first pass where it is as good as the right one: its legs settle both)
  for (const [bib, late] of [['1', 300], ['60', 360], ['60', 720], ['20', 120], ['118', 60]]) {
    const s = womensLate(bib, late * S, { lynx: true, drop: [0] });
    const h = s.engine.runner('w', bib).missedHint;
    if (!(h?.sure && setOfHint(h) === '800m')) problems.push(`${bib} ${late} s late, 800m missed: ${h?.sure ? 'SURE' : 'offered'} ${setOfHint(h)} / ${setOfHint(h?.alt)}`);
  }
  // and on the course, two minutes late with 4200m missed (051d375's 570): "Missed 4200m" sure and right by its finish
  // read, never another set sure (its real 4400m pass counted in 4200m fits 4200m about as well, measured against the
  // slower runners nearest it in time: a late start, not one slow leg)
  for (const bib of ['1', '60', '118']) {
    const sure = new Set();
    const s = womensLate(bib, 120 * S, { drop: [4], look: (x) => {
      const h = x.engine.runner('w', bib).missedHint;
      if (h?.sure) sure.add(setOfHint(h));
    } });
    const h = s.engine.runner('w', bib).missedHint;
    if ([...sure].some((x) => x !== '4200m') || !(h?.sure && setOfHint(h) === '4200m')) problems.push(`${bib} two minutes late, 4200m missed, on the course: sure ${[...sure]}, at the end ${setOfHint(h)} ${h?.sure}`);
  }
  assert.deepEqual(problems, []);
});

test('9.23 F20 one slow leg, every mat read, on every stretch (the re-check\'s late8s: 2:30 lost from 1500m to 2400m, the sure "Missed 2400m" once its 3100m pass was in; 4:00 from 2400m to 3100m, "3100m and 4400m" sure and its later splits held until its finish, then never sent live; 2:00 from 4400m to 5300m, "Missed 5300m" sure with the stream\'s finish pass): never the one click on the course; once a pass after it shows the leg its passes go out as read during the race; after the race nothing held, with FinishLynx nothing offered, without it no sure "Missed 5300m"', () => {
  const problems = [];
  // (and three to four minutes on the 700 m from 800m to 1500m: the 1500m pass where the runners of its pace pass 2400m,
  // the next leg alone tells it from a missed 1500m, the sure "Missed 1500m" for 162 of 167 on the course once it was in)
  for (const [leg, lost] of [[2, 150], [2, 180], [3, 240], [6, 120], [1, 90], [1, 180], [1, 240], [5, 240], [5, 120], [5, 180], [4, 60]]) {
    for (const bib of ['1', '60', '118']) {
      for (const mode of [{ lynx: true }, {}]) {
        const slow = [leg, lost * S];
        const real = lateTimes(bib, 0, slow);
        const what = `${bib} ${lost} s lost on the leg to ${WOMENS.splits[leg] ?? 'the finish'} ${mode.lynx ? 'FinishLynx' : 'finish passes'}`;
        let sure = null;
        const s = womensLate(bib, 0, {
          ...mode,
          slow,
          look: (x, end) => {
            const h = x.engine.runner('w', bib).missedHint;
            if (h?.sure && !sure) sure = `${formatRaceTime(end, 0)} ${setOfHint(h)}`;
          },
        });
        if (sure) problems.push(`${what}: SURE on the course at ${sure}`);
        const v = s.engine.runner('w', bib);
        // (without FinishLynx's finish, three minutes lost on the 200 m from 4200m to 4400m fit "Missed 4400m" about as
        // well, the 4400m pass where 5300m's belong, the 5300m pass at the finish's time: held, and offered as "a missed
        // mat or a slow leg", never the one click)
        const ambiguous = !mode.lynx && leg === 5 && lost >= 180 && v.missedHint?.unsure === 'leg';
        if (v.columns.some((c) => c.held) && !ambiguous) problems.push(`${what}: held after the race`);
        if (mode.lynx && v.missedHint) problems.push(`${what}: offered ${setOfHint(v.missedHint)} with FinishLynx`);
        if (v.missedHint?.sure) problems.push(`${what}: SURE after the race ${setOfHint(v.missedHint)}`);
        // every split's newest line its own time, sent during the race (as read: no split held to the finish)
        for (const out of ambiguous ? [] : ['o1', 'o2']) {
          const got = board(s, bib, out).cols;
          const want = real.slice(0, 7).map((t, j) => `${7 - j}:${formatRaceTime(t, 1)}`);
          if (got.join() !== want.join()) problems.push(`${what} ${out}: ${got.join(' ')}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('9.23 F20 on the course, 800m and 2400m missed (the re-check\'s live4 and MQ1 421: its 1500m and 3100m passes went out as 800m and 1500m at its second pass, and its 4200m pass as 2400m, until the one click a pass later): while Split Relay can\'t tell a late start from a missed 800m, the passes are held, nothing goes out a split early; the one click by the third pass sends every split right on both outputs', () => {
  for (const bib of ['20', '1', '60', '118']) {
    const real = passesOf(bib);
    const s = womensLive({ drop: { [bib]: [real[0], real[2]] }, cut: real[1] + 30 * S });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    // a look every 15 s from its first pass to its fourth: the one click once sure (by its third pass), nothing a split
    // early before it
    let h = null;
    for (let t = real[1] + 45 * S; t < real[5] && !h?.sure; t += 15 * S) {
      s.more(t);
      h = s.engine.runner('w', bib).missedHint;
    }
    const early = linesOf(s, 0, bib).filter((x) => x[2] !== formatRaceTime(real[7 - x[1]], 3));
    assert.deepEqual(early, [], `${bib}: nothing a split early before the one click`);
    assert.deepEqual([setOfHint(h), h.sure], ['800m+2400m', true], bib);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(h));
    s.more(Infinity);
    s.clock.advance(70_000);
    rightBoards(s, bib, real, [0, 2], `${bib} after the click`);
    sameOnBoth(s, at);
  }
});

test('9.23 F20 on the course, 3100m and 4400m missed, no finish line in the stream: its 4200m pass in 3100m and its 5300m pass in 4200m fit one slow leg from 2400m to 3100m as well (the 1100 m to 4200m like the runners\' 1100 m to 5300m), until the 4400m pass that slow leg predicts is overdue: held meanwhile, nothing out a split early (one pass after the slow leg let them go, the lines a split early until the race was over, 156 of 167), then the one click sends every split right on both outputs', () => {
  for (const bib of ['1', '60', '118']) {
    const real = passesOf(bib);
    const drop = {};
    for (const r of WOMENS.runners) drop[r.bib] = r.passes.slice(7);
    drop[bib] = [...drop[bib], real[3], real[5]];
    const s = womensLive({ drop, cut: real[4] - 1 });
    s.engine.on('send', (p) => assertSendable(p, s.config));
    let h = null;
    for (let t = real[4] + 15 * S; t < real[6] + 600 * S && !h?.sure; t += 15 * S) {
      s.more(t);
      h = s.engine.runner('w', bib).missedHint;
    }
    const early = linesOf(s, 0, bib).filter((x) => x[2] !== formatRaceTime(real[7 - x[1]], 3));
    assert.deepEqual(early, [], `${bib}: nothing a split early before the one click`);
    assert.deepEqual([setOfHint(h), h?.sure], ['3100m+4400m', true], bib);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(h));
    s.more(Infinity);
    s.clock.advance(70_000);
    sameOnBoth(s, at);
    const b = board(s, bib).cols;
    assert.deepEqual(b.filter((x, j) => j !== 3 && j !== 5), real.slice(0, 7).map((t, j) => `${7 - j}:${formatRaceTime(t, 1)}`).filter((x, j) => j !== 3 && j !== 5), `${bib} after the click`);
  }
});

test('9.23 F20 three mats missed apart (the re-check\'s ZT1 410: 800m, 2400m and 4200m, FinishLynx; offered "800m & 2400m & 5300m" or "800m & 4200m & 5300m", the right set nowhere, and no one-split "type its time…" to start by hand): the right set of three is placed; the runner editor\'s cell offers its own split alone to type, and a typed 800m moves the later passes on, every affected split sent', () => {
  const problems = [];
  for (const bib of ['1', '20', '60', '118']) {
    const real = passesOf(bib);
    const drop = [0, 2, 4];
    const s = womensLate(bib, 0, { lynx: true, drop });
    const v = s.engine.runner('w', bib);
    const h = v.missedHint;
    const pick = [h, h?.alt].filter(Boolean).find((x) => x.names.join('+') === '800m+2400m+4200m');
    if (!pick) problems.push(`${bib}: ${setOfHint(h)} / ${setOfHint(h?.alt)}`);
    // the typed route: the cell that says "Missed here?" has its own split alone (count 1) to type
    const cell = v.columns.find((c) => c.missed?.here);
    const one = cell.missed.one ?? (cell.missed.count === 1 && !cell.missed.runs ? cell.missed : null);
    assert.ok(one && one.count === 1 && one.typed, `${bib}: ${JSON.stringify(cell.missed)}`);
    if (pick) {
      const at = s.sends.length;
      s.engine.addMissed('w', bib, bodyOf(pick, { withFinishPlace: true }));
      s.clock.advance(3000);
      rightBoards(s, bib, real, drop, `${bib} the three apart`);
      sameOnBoth(s, at);
    }
    // by hand: 800m typed, then the next one click
    const t = womensLate(bib, 0, { lynx: true, drop });
    const tv = t.engine.runner('w', bib);
    const at = t.sends.length;
    t.engine.addMissed('w', bib, { splitId: tv.columns[0].splitId, passTod: tv.columns[0].passTod, count: 1, time: formatRaceTime(real[0], 3), withFinishPlace: true });
    t.clock.advance(3000);
    const sent = linesOf(t, at, bib);
    // (the typed 800m and its next split go out; the later passes stay held while 2400m and 4200m are missed)
    assert.deepEqual(sent.map((x) => x.slice(0, 3)), [['800m', 7, formatRaceTime(real[0], 3)], ['1500m', 6, formatRaceTime(real[1], 3)]], `${bib}: the typed 800m`);
    const next = t.engine.runner('w', bib).missedHint;
    const take = [next, next?.alt].filter(Boolean).find((x) => x.names.join('+') === '2400m+4200m');
    assert.ok(take, `${bib}: then 2400m and 4200m: ${setOfHint(next)} / ${setOfHint(next?.alt)}`);
    t.engine.addMissed('w', bib, bodyOf(take, { withFinishPlace: true }));
    t.clock.advance(3000);
    rightBoards(t, bib, real, drop, `${bib} by hand`);
  }
  assert.deepEqual(problems, []);
});

test('9.23 F20 by hand, a late starter who missed 4400m (the re-check\'s ZLT3 488, two minutes late, FinishLynx: after "Move 20:30.9 to 5300m" its typed 4400m was refused twice, its good 4200m pass held); after an Undo a held pass\'s row says what the boards show (475: "It went out as 1500m before it was held" where it never went out)', () => {
  // the Move, then the typed 4400m: its good 4200m pass is no longer in doubt, the splits right with the finish place
  const bib = '10';
  const late = 120 * S;
  const s = womensLate(bib, late, { lynx: true, drop: [5] });
  const real = lateTimes(bib, late);
  const v = s.engine.runner('w', bib);
  s.engine.movePass('w', bib, { tod: v.columns[5].passTod, to: v.columns[6].splitId, withFinishPlace: true });
  s.clock.advance(3000);
  assert.equal(s.engine.runner('w', bib).columns[4].held, null, 'its 4200m pass is not held');
  const at0 = s.sends.length;
  s.engine.addManual('w', { bib, splitId: v.columns[5].splitId, time: formatRaceTime(real[5], 3) });
  s.clock.advance(3000);
  assert.deepEqual(linesOf(s, at0, bib).map((x) => [x[0], x[2]]), [['4400m', formatRaceTime(real[5], 3)], ['5300m', formatRaceTime(real[6], 3)]]);
  sameOnBoth(s, at0);
  // 475's Undo: the held passes never went out, the boards keep the change's times
  const b2 = '17';
  const u = womensLate(b2, 0, { lynx: true, drop: [1, 3] });
  const h = u.engine.runner('w', b2).missedHint;
  const r = u.engine.addMissed('w', b2, bodyOf(h, { withFinishPlace: true }));
  u.clock.advance(3000);
  u.engine.undo('w', { fix: r.change.fix, confirm: true });
  u.clock.advance(3000);
  const rows = u.engine.review('w').checks.filter((c) => c.bib === b2);
  assert.ok(rows.length > 0, 'held again after the Undo');
  for (const c of rows) {
    const out = board(u, b2).cols.find((x) => x.startsWith(`${7 - WOMENS.splits.indexOf(c.fromName)}:`));
    if (c.delivered) assert.equal(out, `${7 - WOMENS.splits.indexOf(c.fromName)}:${c.timeText}`, `${c.timeText} went out as ${c.fromName}`);
    else if (out) assert.equal(c.sentOther?.timeText, out.slice(out.indexOf(':') + 1), `${c.timeText}: the boards show ${out}`);
  }
  assert.ok(rows.some((c) => !c.delivered && c.sentOther), JSON.stringify(rows.map((c) => [c.timeText, c.delivered, c.sentOther])));
});

test('9.23 F20 the column check by hand: a stray pass is no complete count (strayLegs); one slow leg with every mat read is let go once a pass after it shows it, clearly better than the missed mat (slow); a leg longer than any runner\'s with the first pass in doubt lets the check say two more mats', () => {
  const T = (m) => Math.round(m * 60 * S);
  // twelve runners over 6 splits a minute apart at 1.0 to 1.55 times the pace, the finish a minute after the last
  const runner = (bib, pace) => {
    const real = Array.from({ length: 6 }, (_, k) => T((k + 1) * pace));
    return { bib, passes: real.map((t, c) => ({ t, col: c })), real, finish: T(7 * pace), afterLast: T(7 * pace) - 4000 };
  };
  const field = Array.from({ length: 12 }, (_, i) => runner(`f${i}`, 1 + i * 0.05));
  const at = (pace, k) => T((k + 1) * pace);
  // 3 missed, a stray 20 s after its 4: six passes, the count complete with its finish
  const passes = [0, 1, 3].map((k) => at(1.2, k));
  passes.push(at(1.2, 3) + 20 * S, at(1.2, 4), at(1.2, 5));
  const strayRunner = { bib: 'X', passes: passes.map((t, c) => ({ t, col: c })), real: passes.slice(), finish: T(8.4), afterLast: T(8.4) - 4000 };
  const cf = checkField({ n: 6, runners: [...field, strayRunner], near: 10 * S });
  assert.deepEqual([strayLegs(cf, strayRunner), strayIn(cf, strayRunner), strayIn(cf, field[3])], [[[2, 3]], true, false], 'a leg of 20 s where the leaders took a minute');
  // a slow leg: 3 minutes lost before its 3, every mat read, on the course after its 5
  const slow = [0, 1, 2, 3, 4].map((k) => at(1.1, k) + (k >= 2 ? T(3) : 0));
  const slowRunner = { bib: 'Y', passes: slow.map((t, c) => ({ t, col: c })), real: slow.slice(), finish: null, afterLast: null };
  const onCourse = field.map((r) => ({ ...r, finish: null, afterLast: null }));
  const r2 = columnCheck({ n: 6, runners: [...onCourse, slowRunner] });
  assert.deepEqual([r2.suspects.has('Y'), r2.slow.get('Y')?.col], [false, 2], 'one slow leg, let go');
  // a leg longer than anybody's and slower than the runner's own first pass, the first pass beyond the field: two more mats
  // (splits 1, 2, 4, 5, 7 and 8 minutes in at the fastest pace: a runner at 1.2 times it, the first and the third missed,
  // its second pass 3:36 after its first where the slowest runner took 1:33 from the first split to the second)
  const uneven = [1, 2, 4, 5, 7, 8];
  const field2 = Array.from({ length: 12 }, (_, i) => {
    const real = uneven.map((m) => T(m * (1 + i * 0.05)));
    return { bib: `g${i}`, passes: real.map((t, c) => ({ t, col: c })), real, finish: null, afterLast: null };
  });
  const two = [T(2.4), T(6)];
  const twoRunner = { bib: 'Z', passes: two.map((t, c) => ({ t, col: c })), real: two.slice(), finish: null, afterLast: null };
  const r3 = columnCheck({ n: 6, runners: [...field2, twoRunner] });
  assert.deepEqual(r3.suspects.get('Z')?.cols, [1, 3], 'the first and the third missed: both passes held');
});

/**
 * 9.23 F21: on both outputs, every split's newest line carries the leg (LS) its cell has now, and the runner's newest line
 * of all is its furthest split (with the finish place when FinishLynx has it).
 */
function rightLegs(s, bib, what, place = null) {
  const v = s.engine.runner('w', bib);
  for (const out of ['o1', 'o2']) {
    const mine = s.sends.map((p, i) => [p, s.net.via[i]]).filter(([p, o]) => o === out && p.bib === String(bib)).map(([p]) => p);
    const newest = new Map();
    for (const p of mine) newest.set(p.lapsToGo, p);
    let prev = 0;
    for (const [k, c] of v.columns.entries()) {
      if (c.time == null) continue;
      const p = newest.get(7 - k);
      assert.ok(p, `${what} ${out}: ${c.splitName} never sent`);
      assert.deepEqual([formatRaceTime(p.csTicks, 3), formatRaceTime(p.lsTicks, 3)], [formatRaceTime(c.time, 3), formatRaceTime(c.time - prev, 3)], `${what} ${out}: ${c.splitName}`);
      prev = c.time;
    }
    const last = mine.at(-1);
    const far = 7 - v.columns.findLastIndex((c) => c.time != null);
    assert.deepEqual([last.lapsToGo, place ?? last.place], [far, last.place], `${what} ${out}: the newest line is the furthest split`);
  }
}

test('9.23 F21 a leg the boards got from a stray pass goes again when a later change gives its split the same time back (the re-check\'s ls1, bib 1: 1500m missed and a stray read 30 s after its 800m pass, counted in 1500m; Not a split for the stray, then "Missed 1500m": 2400m kept its leg of 5:11.6 from the stray on both boards, where its cell said 3:25.0); every split\'s newest line with its cell\'s leg, the furthest last, on both outputs alike', () => {
  const bib = '1';
  const real = passesOf(bib);
  const stray = real[0] + 30 * S;
  // the race's reads all at once (a relay started after the race, or reads replayed), then FinishLynx's finishes: every
  // line went out after the finishes, so each went again with the finish place (#repairFinishPlaces)
  const finishers = new Map();
  const places = new Map();
  const s = setup({ races: [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 },
    outputs: TWO_OUTPUTS, lynx: finishers, places });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const reads = WOMENS.runners.flatMap((r) => (r.bib === bib ? [...real.filter((_, j) => j !== 1), stray] : passesOf(r.bib)).map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  s.engine.handleReads(reads.map(([b, t]) => ({ read: { location: '', bib: b, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
  s.clock.advance(70_000);
  WOMENS.runners.filter((r) => r.passes.length >= 8).map((r) => [r.bib, passesOf(r.bib)[7] + 4000]).sort((a, b) => a[1] - b[1]).forEach(([b, t], i) => {
    finishers.set(b, t);
    places.set(b, i + 1);
  });
  s.engine.converge();
  s.clock.advance(70_000);
  // the stray went out as 1500m and 2400m with the leg from it, with the finish place
  const was = linesOf(s, 0, bib).filter((x) => x[1] === 5).at(-1);
  assert.deepEqual([was[3], was[4]], [formatRaceTime(real[2] - stray, 3), places.get(bib)], 'the leg from the stray on the boards');
  const at = s.sends.length;
  // by hand, two changes: the stray Not a split (the later passes held while 1500m is empty), then the missed split
  s.engine.movePass('w', bib, { tod: GUN + stray, to: 'none', withFinishPlace: true });
  s.clock.advance(3000);
  s.engine.addMissed('w', bib, { splitId: 's2', count: 1, withFinishPlace: true });
  s.clock.advance(3000);
  rightBoards(s, bib, real, [1], 'Not a split, then Missed 1500m');
  rightLegs(s, bib, 'Not a split, then Missed 1500m', s.places.get(bib));
  sameOnBoth(s, at);
  assert.ok(linesOf(s, at, bib).some((x) => x[1] === 5), '2400m went again, its time the same, its leg new');
  // what each output got is kept with the leg it carried (a restart has it from the race file)
  const s2 = s.restart();
  s2.clock.advance(3000);
  assert.equal(s2.sends.length, s.sends.length, 'nothing again after a restart');
});

test('9.23 F21 a finisher\'s split repaired with the finish place is followed by its furthest split (the re-check\'s strayL, bib 3: 4200m missed, a stray 1:15 after its 4400m pass, "Missed 4200m (17:45.9 is a stray pass)" taken on the course after its finish read, before FinishLynx\'s file; then FinishLynx\'s finish: 4400m went again with the finish place after the 5300m line, the runner\'s newest line L2G 2 on both boards)', () => {
  const bib = '3';
  const real = passesOf(bib);
  const stray = real[5] + 75 * S;
  let clicked = false;
  const look = (s, end) => {
    if (clicked || end < real[7]) return;
    const h = s.engine.runner('w', bib).missedHint;
    if (!h || h.sure === false) return;
    s.engine.addMissed('w', bib, bodyOf(h));
    s.clock.advance(3000);
    clicked = true;
  };
  const s = womensLate(bib, 0, { lynx: true, drop: [4], extra: [stray], look });
  assert.ok(clicked, 'the one click on the course');
  rightBoards(s, bib, real, [4], 'after FinishLynx');
  rightLegs(s, bib, 'after FinishLynx', s.places.get(bib));
  for (const out of ['o1', 'o2']) assert.deepEqual(board(s, bib, out).last, [1, s.places.get(bib)], `${out}: 5300m last, with the finish place`);
});

test('9.23 F21 a pass the column check held and let go once FinishLynx\'s finish was known goes out with the finish place by itself (the re-check\'s V9 L3 542 and late8s: one slow leg to the last split, every mat read, its 5300m pass held as "it looks like the finish" until the finish, then never sent: "not sent live (bib 542 has finished)"); the furthest last, on both outputs alike', () => {
  for (const [bib, lost] of [['1', 150], ['57', 180], ['118', 240]]) {
    const real = lateTimes(bib, 0, [6, lost * S]);
    const s = womensLate(bib, 0, { lynx: true, slow: [6, lost * S] });
    const what = `${bib}, ${lost} s lost from 4400m to 5300m`;
    rightBoards(s, bib, real, [], what);
    rightLegs(s, bib, what, s.places.get(bib));
    const rv = s.engine.review('w');
    assert.deepEqual([rv.finishedNotSent.filter((x) => x.bib === bib).length, s.engine.runner('w', bib).missedHint], [0, null], `${what}: nothing left to send, nothing asked`);
    for (const out of ['o1', 'o2']) assert.deepEqual(board(s, bib, out).last, [1, s.places.get(bib)], `${what} ${out}`);
  }
  // not what it let go of a runner whose count a stray pass made complete (3100m missed and a read 30 s after the 4200m
  // pass, the real 4200m pass in 3100m and the stray in 4200m): they wait for the one click, which sends them right
  for (const bib of ['22', '57']) {
    const real = passesOf(bib);
    const stray = real[4] + 30 * S;
    const s = womensLate(bib, 0, { lynx: true, drop: [3], extra: [stray] });
    const what = `${bib}, 3100m missed and a stray 30 s after 4200m`;
    assert.deepEqual(linesOf(s, 0, bib).filter((x) => x[2] === formatRaceTime(stray, 3) || x[1] === 4), [], `${what}: before the one click`);
    const h = s.engine.runner('w', bib).missedHint;
    assert.deepEqual([setOfHint(h), h.sure], [`3100m aside ${formatRaceTime(stray, 1)}`, true], what);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(h, { withFinishPlace: true }));
    s.clock.advance(3000);
    rightBoards(s, bib, real, [3], what);
    sameOnBoth(s, at);
  }
});

test('9.23 F21 a stray before a missed mat on the course (my stray grid streamed, the operator taking each sure one click: 4400m missed and a read 30 s after the 4200m pass, counted in 4400m; "Missed 4200m and 5300m (17:22.9 is a stray pass)" was the sure one click once the 5300m pass was in, its real 4200m pass sent as 4400m and its 5300m pass taken for the finish, then no hint and no row, 5 of 167): a set that leaves a split between the stray\'s neighbours stands only with the runner\'s finish known; after FinishLynx\'s finish "Missed 4400m (… is a stray pass)" is the one click, every split right', () => {
  for (const bib of ['75', '104']) {
    const real = passesOf(bib);
    const stray = real[4] + 30 * S;
    const what = `${bib}, 4400m missed and a stray 30 s after 4200m`;
    const seen = [];
    const look = (s) => {
      const h = s.engine.runner('w', bib).missedHint;
      if (h?.sure !== false && h) seen.push(setOfHint(h));
    };
    const s = womensLate(bib, 0, { lynx: true, drop: [5], extra: [stray], look, step: 15 * S });
    assert.deepEqual(seen, [], `${what}: no sure one click on the course`);
    const h = s.engine.runner('w', bib).missedHint;
    assert.deepEqual([setOfHint(h), h.sure], [`4400m aside ${formatRaceTime(stray, 1)}`, true], what);
    s.engine.addMissed('w', bib, bodyOf(h, { withFinishPlace: true }));
    s.clock.advance(3000);
    rightBoards(s, bib, real, [5], what);
  }
});

test('9.23 F21 a stray pass before the missed mat, the runner\'s finish known (the re-check\'s stray grid with FinishLynx: 5300m missed and a read 1:30 after the 4400m pass, "Missed 4200m (15:56.6 is a stray pass)" sure for 14 of 167, the real 4400m pass set aside; 4400m missed and a read 30 s after the 4200m pass, the same for 4; 1500m missed and a read 30 s after the 800m pass, two clicks): the one click sets the stray aside and adds the split after it, every split right on both outputs alike, the stray in no column; its words say the stray first', () => {
  for (const [bib, miss, after, sec] of [['4', 6, 5, 90], ['57', 5, 4, 30], ['1', 1, 0, 30], ['100', 2, 1, 60]]) {
    const real = passesOf(bib);
    const stray = real[after] + sec * S;
    const s = womensLate(bib, 0, { lynx: true, drop: [miss], extra: [stray] });
    const what = `${bib} ${WOMENS.splits[miss]} missed, a stray ${sec} s after ${WOMENS.splits[after]}`;
    const v = s.engine.runner('w', bib);
    const h = v.missedHint;
    assert.equal(setOfHint(h), `${WOMENS.splits[miss]} aside ${formatRaceTime(stray, 1)}`, what);
    assert.equal(h.sure, true, what);
    const c = v.columns.find((x) => x.missed?.here);
    assert.match(c.missed.reason, new RegExp(`^${formatRaceTime(stray, 1).replace('.', '\\.')} is a stray pass, `), `${what}: the stray first`);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(h, { withFinishPlace: true }));
    s.clock.advance(3000);
    rightBoards(s, bib, real, [miss], what);
    rightLegs(s, bib, what, s.places.get(bib));
    sameOnBoth(s, at);
    const after2 = s.engine.runner('w', bib);
    assert.deepEqual([after2.missedHint, after2.columns.filter((x) => x.held).length, after2.passes.find((p) => p.raceTicks === stray)?.how], [null, 0, 'ignored'], what);
  }
});

test('9.23 F21 a stray the one click would put in a split (the re-check\'s item 14: 3100m missed and a read 37 s after the 4400m pass, no finish line and no FinishLynx; as counted the read is a 4400m pass a split late, "Missed 3100m" puts it in 5300m 0:37 after 4400m, and was the sure one click for 14 of 161, the read sent as 5300m until its own Not a split): the one click sets it aside in the same change, every split right', () => {
  for (const bib of ['10', '20', '41']) {
    const real = passesOf(bib);
    const stray = real[4] + 90 * S;
    const s = womensLate(bib, 0, { fin: false, drop: [3], extra: [stray] });
    const what = `${bib} 3100m missed, a stray 90 s after 4200m`;
    const h = s.engine.runner('w', bib).missedHint;
    assert.deepEqual([setOfHint(h), h.sure], [`3100m aside ${formatRaceTime(stray, 1)}`, true], what);
    const at = s.sends.length;
    s.engine.addMissed('w', bib, bodyOf(h));
    s.clock.advance(3000);
    const lines = linesOf(s, at, bib);
    assert.ok(!lines.some((x) => x[2] === formatRaceTime(stray, 3)), `${what}: the stray in no line`);
    rightBoards(s, bib, real.slice(0, 7).concat([real[6] + 3 * 60 * S]), [3], what);
    sameOnBoth(s, at);
  }
});

test('9.23 F21 V9\'s 577 (the re-check\'s item 29, the fixture\'s 162: 4400m missed and a stray read 1:30 after its 2400m pass, counted in 3100m, FinishLynx\'s finishes; its by-hand Move of its real 3100m pass was refused eight times, "4 earlier passes need the splits before it", the stray unnamed): the row\'s Not a split is on the stray and the refusal names it; Not a split, then the one click, every split right on both outputs', () => {
  const bib = '162';
  const real = passesOf(bib);
  const stray = real[2] + 90 * S;
  const s = womensLate(bib, 0, { lynx: true, drop: [5], extra: [stray] });
  const row = s.engine.review('w').flags.find((f) => f.bib === bib);
  assert.deepEqual([row?.passTod, row?.kind, row?.suggest], [GUN + stray, 'short', null]);
  const p3100 = s.engine.runner('w', bib).passes.find((p) => p.raceTicks === real[3]);
  const to3100 = p3100.targets.find((t) => t.splitName === '3100m');
  const way = `If ${formatRaceTime(stray, 1)} is a stray pass (it came soon after the pass before it), choose Not a split for it first.`;
  assert.equal(to3100.why, `The pass at ${formatRaceTime(real[3], 1)} can't be 3100m: 4 earlier passes need the splits before it. ${way}`);
  assert.throws(() => s.engine.movePass('w', bib, { tod: p3100.tod, to: to3100.splitId }), (e) => e.status === 409 && e.message.endsWith(way));
  // the row's Not a split (a finisher's: with the finish place), then the one click
  const at = s.sends.length;
  s.engine.movePass('w', bib, { tod: row.passTod, to: 'none', withFinishPlace: true });
  s.clock.advance(3000);
  const h = s.engine.runner('w', bib).missedHint;
  assert.deepEqual([h?.splitName, h?.count, h?.sure], ['4400m', 1, true]);
  s.engine.addMissed('w', bib, bodyOf(h, { withFinishPlace: true }));
  s.clock.advance(3000);
  rightBoards(s, bib, real, [5], `${bib} after Not a split and Missed 4400m`);
  rightLegs(s, bib, bib, s.places.get(bib));
  sameOnBoth(s, at);
});

test('9.23 F21 a fast last leg, every mat read (the re-check\'s fastx: the 900 m to 5300m in 0.7 of the runner\'s own time, FinishLynx\'s finishes; "Missed 4200m (16:05.0 is a stray pass)" sure for 22 of 167, the real 4400m pass set aside): a set that sets a stray aside is the one click only when the legs fit it clearly better than the passes as read; else offered, "Split Relay can\'t tell a stray pass from a fast leg"', () => {
  for (const bib of ['7', '71', '76', '58']) {
    const base = passesOf(bib);
    const cut = Math.round(0.3 * (base[6] - base[5]));
    const s = womensLate(bib, 0, { lynx: true, slow: [6, -cut] });
    const h = s.engine.runner('w', bib).missedHint;
    assert.ok(!h || h.sure === false, `${bib}: ${JSON.stringify(h && { names: h.names, aside: h.aside, sure: h.sure })}`);
    if (h?.aside?.length && !h.alt) {
      assert.equal(h.unsure, 'stray', bib);
      // (its words say it may be one: Split Relay can't tell)
      const row = s.engine.review('w').flags.find((f) => f.bib === bib);
      assert.match(row?.text ?? '', /\d may be a stray pass, /, bib);
      assert.doesNotMatch(row.text, / is a stray pass/, bib);
    }
    const real = lateTimes(bib, 0, [6, -cut]);
    rightBoards(s, bib, real, [], `${bib} as read`);
  }
  // a real 4400m pass 15 s fast (0:38 where runners of the same pace took 0:53), every mat read, FinishLynx's finishes:
  // a stray before a 4400m missed as well is offered, in the same words
  const s = womensLate('4', 0, { lynx: true, slow: [5, -15 * S] });
  const h = s.engine.runner('w', '4').missedHint;
  assert.deepEqual([h?.sure, h?.unsure], [false, 'stray']);
  assert.match(s.engine.review('w').flags.find((f) => f.bib === '4')?.text ?? '', /^15:41\.6 may be a stray pass, 0:38 after 15:04\.1\. /);
  rightBoards(s, '4', lateTimes('4', 0, [5, -15 * S]), [], '4 as read');
});

test('9.23 F21 three mats missed apart by a walker who faded (the re-check\'s wf4 tri, 154: 800m, 4200m and 5300m missed, the stream\'s finish passes, no FinishLynx; "Missed 800m, 4400m and 5300m" sure, its real 4400m pass sent as 4200m): a third run whose pass fits loosely is a set that fits about as well, as a second run\'s is; both offered, the right one among them', () => {
  const bib = '154';
  const s = womensLate(bib, 0, { drop: [0, 4, 6] });
  const h = s.engine.runner('w', bib).missedHint;
  const sets = [h, h?.alt].filter(Boolean).map((x) => setText(x));
  assert.equal(h.sure, false, JSON.stringify(sets));
  assert.ok(sets.includes('800m | 4200m | 5300m'), JSON.stringify(sets));
});

test('9.23 F21 a slow last leg on the course, the stream\'s finish pass after it (the re-check\'s late8s: 3:00 lost from 4400m to 5300m by a runner of the back of the field, its finish pass 4:04 after its 5300m pass as always: "Missed 5300m" the sure one click once that pass was in): never the one click; offered as "a missed mat or a slow leg"; with FinishLynx\'s finish after the race, 5300m out with the finish place', () => {
  for (const [bib, lost] of [['57', 180], ['3', 150], ['118', 150]]) {
    const seen = [];
    const look = (s) => {
      const h = s.engine.runner('w', bib).missedHint;
      if (h) seen.push([h.sure, h.unsure]);
    };
    const s = womensLate(bib, 0, { lynx: true, slow: [6, lost * S], look });
    assert.ok(seen.every(([sure]) => sure === false), `${bib}: ${JSON.stringify(seen)}`);
    rightBoards(s, bib, lateTimes(bib, 0, [6, lost * S]), [], `${bib} after the race`);
  }
});

test('9.23 F21 one slow leg on the course: a hint offered while Split Relay can\'t tell yet how many says the slow leg (the re-check\'s 220, 2:30 lost from 1500m to 2400m: "…, but Split Relay can\'t tell yet how many", a missed mat for all the words said)', () => {
  for (const bib of ['1', '60', '100']) {
    const said = [];
    // (the race streamed in looks of 15 s from the first read, the clock a tenth of it, the runner editor looked at each
    // time: as the re-check's panel saw 220)
    const s = setup({ races: [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs: TWO_OUTPUTS });
    const mine = lateTimes(bib, 0, [2, 150 * S]);
    const reads = WOMENS.runners.flatMap((r) => (r.bib === bib ? mine : passesOf(r.bib)).map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
    let kept = false;
    for (let at = 0, now = reads[0][1]; at < reads.length; now += 15 * S) {
      const chunk = [];
      while (at < reads.length && reads[at][1] <= now) chunk.push(reads[at++]);
      if (chunk.length) s.engine.handleReads(chunk.map(([b, t]) => ({ read: { location: '', bib: b, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
      if (!kept && now >= WOMENS.keptAt3100.raceTicks) {
        s.engine.assign('w', { bib: WOMENS.keptAt3100.bib, tod: GUN + WOMENS.keptAt3100.raceTicks, splitId: null });
        kept = true;
      }
      s.clock.advance(1500);
      if (now < mine[2] || now > mine[7]) continue;
      const v = s.engine.runner('w', bib);
      const h = v.missedHint;
      const c = v.columns.find((x) => x.missed?.here);
      if (h && !h.alt && h.splitName === '2400m') said.push([h.sure, h.unsure, c?.missed?.reason ?? '', c?.missed?.leg ?? null]);
      s.engine.review('w');
    }
    const bad = said.filter(([sure, unsure, reason]) => sure !== false || (unsure !== 'leg' && unsure !== 'next' && unsure !== 'where') || /can't tell yet how many/.test(reason));
    assert.deepEqual(bad, [], `${bib}: ${JSON.stringify(said)}`);
    // the editor's line names the leg, as the Review row does ("1500m to 2400m took 2:30 longer than runners of the same pace")
    const legs = said.filter(([, unsure]) => unsure === 'leg').map(([, , , leg]) => leg);
    assert.ok(legs.length > 0 && legs.every((l) => l?.from === '1500m' && l?.to === '2400m' && /^2:[23]\d$/.test(l.lostText)), `${bib}: ${JSON.stringify(legs)}`);
  }
});

test('9.23 F21 the leaders\' leg by hand: a stray\'s leg is no leader\'s, alone at the front (V9\'s field: four strays on the 700 m to 3100m, 453\'s own among them) or four close together far ahead of the field (multistray: 53 to 57 s after the 4400m pass on the 900 m to 5300m); five or more that far ahead are a group that ran it so (runners the same mats missed, another stretch\'s legs counted there: twenty without 800m and 1500m were each "a stray pass"); real leaders far ahead of each other still are', () => {
  const T = (m) => Math.round(m * 60 * S);
  // twenty runners over 6 splits a minute apart at 1.0 to 1.95 times the pace
  const runner = (bib, real) => ({ bib, passes: real.map((t, c) => ({ t, col: c })), real: real.slice(), finish: real[5] + T(1), afterLast: real[5] + T(1) - 4000 });
  const field = Array.from({ length: 20 }, (_, i) => runner(`f${i}`, Array.from({ length: 6 }, (_, k) => T((k + 1) * (1 + i * 0.05)))));
  // runners with a stray read 16 to 19 s after their 4th pass, counted in the 5th split (every later pass a split on)
  const strayed = [16, 16.5, 17, 18, 19].map((sec, i) => {
    const pace = 1.2 + i * 0.1;
    const real = [0, 1, 2, 3].map((k) => T((k + 1) * pace));
    real.push(real[3] + Math.round(sec * S), T(5 * pace));
    return runner(`s${i}`, real);
  });
  // the runner checked: its stray 25 s after its 4th pass, where the real leaders take a minute (three others: four strays)
  const x = [0, 1, 2, 3].map((k) => T((k + 1) * 1.3));
  x.push(x[3] + 25 * S, T(5 * 1.3));
  const X = runner('X', x);
  const cf = checkField({ n: 6, runners: [...field, ...strayed.slice(0, 3), X], near: 10 * S });
  assert.deepEqual(strayLegs(cf, X), [[3, 4]], 'four strays close together are no leaders: 0:25 where the leaders take 1:00 is a stray');
  assert.ok(field.every((r) => !strayIn(cf, r)), 'no real runner a stray');
  // five that far ahead and the runner checked: a group, the leaders' leg (16 to 19 s) as before F21
  const cg = checkField({ n: 6, runners: [...field, ...strayed, X], near: 10 * S });
  assert.deepEqual([strayLegAt(cf, 3, 4, 25 * S), strayLegAt(cg, 3, 4, 25 * S), strayLegs(cg, X).some(([i]) => i === 3)], [true, false, false], 'a group far ahead is the leaders: 0:25 is no stray then');
  assert.ok(field.every((r) => !strayIn(cg, r)), 'no real runner a stray');
  // through the engine, the real race: twenty runners in a row at 800m all missed 800m and 1500m (a mat outage), FinishLynx
  const special = new Set([...Object.values(WOMENS.shapes), WOMENS.keptAt3100.bib]);
  const byFirst = WOMENS.runners.filter((r) => r.passes.length >= 8 && !special.has(r.bib)).sort((a, b) => passesOf(a.bib)[0] - passesOf(b.bib)[0]);
  const hit = new Set(byFirst.slice(60, 80).map((r) => r.bib));
  const finishers = new Map();
  const places = new Map();
  const s = setup({ races: [lapRace({ id: 'w', name: 'Womens Race', splits: lapSplits(7, WOMENS.splits) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs: TWO_OUTPUTS, lynx: finishers, places });
  const reads = WOMENS.runners.flatMap((r) => passesOf(r.bib).filter((_, j) => !(hit.has(r.bib) && j < 2)).map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  s.engine.handleReads(reads.map(([b, t]) => ({ read: { location: '', bib: b, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
  s.engine.assign('w', { bib: WOMENS.keptAt3100.bib, tod: GUN + WOMENS.keptAt3100.raceTicks, splitId: null });
  s.clock.advance(70_000);
  WOMENS.runners.filter((r) => r.passes.length >= 8).map((r) => [r.bib, passesOf(r.bib)[7] + 4000]).sort((a, b) => a[1] - b[1]).forEach(([b, t], i) => {
    finishers.set(b, t);
    places.set(b, i + 1);
  });
  s.engine.converge();
  s.clock.advance(70_000);
  const rv = s.engine.review('w');
  assert.deepEqual(rv.flags.filter((f) => hit.has(f.bib) && f.kind === 'short').map((f) => `${f.bib}: ${f.text}`), [], 'no "comes soon after" row for a real pass');
  const sure = [...hit].map((b) => s.engine.runner('w', b).missedHint).filter((h) => h && h.sure !== false);
  assert.ok(sure.every((h) => setOfHint(h) === '800m+1500m'), JSON.stringify(sure.map(setOfHint)));
  // real leaders far ahead of each other (1.0, 1.1, 1.2 times the pace, then the field from 1.4): their legs are the leaders'
  const spread = [1, 1.1, 1.2, ...Array.from({ length: 12 }, (_, i) => 1.4 + i * 0.05)].map((p, i) => runner(`g${i}`, Array.from({ length: 6 }, (_, k) => T((k + 1) * p))));
  const cs = checkField({ n: 6, runners: spread, near: 10 * S });
  assert.ok(spread.every((r) => !strayIn(cs, r)), 'the winner\'s legs are no stray\'s');
});

test('9.23 F21 a late starter\'s one click is not made sure over another set its legs can\'t weigh (the re-check\'s syn6, seed 109, the 8K of 1 mile, 5K and 6.3K, bib 128: 1 mile and 5K missed and a cool-down pass; "Missed 1 mile" was made the sure one click, its other set one leg too few to weigh, where its row said "Split Relay can\'t tell which"): both offered, as on 051d375', () => {
  const course = { name: '8K, 1 mile / 5K / 6.3K', d: [1.609, 5, 6.3], D: 8 };
  const seed = 109;
  const n = course.d.length;
  const race = makeRace(seed * 7919 + n, course, 120 + (seed % 5) * 40);
  const rand = rng(seed * 31 + n);
  for (const r of race) {
    r.cool = rand() < 0.25;
    r.miss = null;
    if (rand() < 0.15) {
      const len = 1 + Math.floor(rand() * Math.min(3, n - 1));
      r.miss = { j: Math.floor(rand() * (n - len + 1)), len };
    }
    const out = new Set(r.miss ? Array.from({ length: r.miss.len }, (_, i) => r.miss.j + i) : []);
    const ts = r.mats.filter((_, k) => !out.has(k));
    if (!r.dnf) ts.push(r.finish, ...(r.cool ? [r.finish + 90 + rand() * 400] : []));
    r.passes = ts.map((t) => Math.round(t * S));
  }
  const me = race.find((r) => r.bib === '128');
  assert.deepEqual([me.miss, me.cool], [{ j: 0, len: 2 }, true], 'the re-check\'s runner');
  const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, course.d.map((x) => `${x}K`)) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 } });
  const reads = race.flatMap((r) => r.passes.map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
  s.engine.handleReads(reads.map(([b, t]) => ({ read: { location: '', bib: b, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
  s.clock.advance(70_000);
  const h = s.engine.runner('w', '128').missedHint;
  assert.deepEqual([h.names, h.sure, h.alt?.names], [['1.609K'], false, ['1.609K', '5K']], JSON.stringify(h));
});

test('9.23 F17 synthetic races on the course: two mats missed apart (one or two splits read between them, the first split and the last among them), the finish pass in the stream or not, one runner in four with a cool-down pass, the stream cut when half the field has finished: a sure one click is right for what the runner has passed (a run once a pass after it is in), and sends every line in its column; a runner whose mats all read is never given one', () => {
  const courses = [{ name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 }, { name: '5K, 1K splits', d: [1, 2, 3, 4], D: 5 },
    { name: '8K, 1 mile / 5K / 6.3K', d: [1.609, 5, 6.3], D: 8 }];
  const st = { all: 0, sure: 0, offered: 0, wrong: [], early: [], complete: 0, completeSure: 0 };
  for (const fin of [true, false]) {
    for (let seed = 1; seed <= 3; seed++) {
      for (const course of courses) {
        const n = course.d.length;
        const names = course.d.map((x) => `${x}K`);
        const race = makeRace(seed * 7717 + n, course, 160);
        const rand = rng(seed * 37 + n);
        for (const r of race) {
          r.miss = null;
          if (rand() < 0.2) {
            const gap = 1 + Math.floor(rand() * Math.min(2, n - 2));
            const a = Math.floor(rand() * (n - gap - 1));
            r.miss = [{ j: a, len: 1 }, { j: a + gap + 1, len: 1 }];
          }
          const cool = rand() < 0.25;
          const out = new Set((r.miss ?? []).map((x) => x.j));
          const ts = r.mats.filter((_, k) => !out.has(k));
          if (fin && !r.dnf) ts.push(r.finish, ...(cool ? [r.finish + 90 + rand() * 400] : []));
          r.passes = ts.map((t) => Math.round(t * S));
          r.out = out;
        }
        const cut = Math.round(race.map((r) => r.finish).sort((p, q) => p - q)[race.length >> 1] * S);
        const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, names) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs: TWO_OUTPUTS });
        const reads = race.flatMap((r) => r.passes.filter((t) => t <= cut).map((t) => [r.bib, t])).sort((p, q) => p[1] - q[1]);
        s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
        s.clock.advance(70_000);
        for (const r of race) {
          if (r.dnf) continue;
          const h = s.engine.runner('w', r.bib).missedHint;
          if (!r.miss) {
            st.complete++;
            if (h?.sure) st.completeSure++;
            continue;
          }
          // what it has passed: a run is known once a pass after it is in (the next mat read, or the finish pass)
          const passed = r.passes.filter((t) => t <= cut);
          const known = r.miss.filter((x) => passed.some((t) => t > Math.round(r.mats[x.j] * S)));
          if (!known.length) continue;
          st.all++;
          const right = known.map((x) => names[x.j]).join(' | ');
          // (9.23 F19: not the one click while a late start (the first mat, on few or even legs) or a slow leg (the moved pass
          // the runner's latest) can't be told from it: the right set offered)
          if (!h?.sure) {
            if (h && [h, h.alt].filter(Boolean).some((x) => setText(x, names) === right)) st.offered++;
            continue;
          }
          if (setText(h, names) !== right) {
            st.wrong.push(`${course.name} s${seed} fin ${fin} ${r.bib} ${right}: sure ${setText(h, names)}`);
            continue;
          }
          st.sure++;
          const at = s.sends.length;
          s.engine.addMissed('w', r.bib, { splitId: h.splitId, passTod: h.passTod, count: h.count, also: h.runs?.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) });
          // every line it sent in its own column: a real split its real time, a missed one between the real ones around it
          for (const [split, l2g, cs] of linesOf(s, at, r.bib)) {
            const c = n - l2g;
            const lo = c ? Math.round(r.mats[c - 1] * S) : 0;
            const hi = c + 1 < n ? Math.round(r.mats[c + 1] * S) : Math.round(r.finish * S);
            if (r.out.has(c) ? !(rt(cs) > lo && rt(cs) < hi) : cs !== formatRaceTime(Math.round(r.mats[c] * S), 3)) st.early.push(`${course.name} ${r.bib} ${split} ${cs}`);
          }
          sameOnBoth(s, at);
        }
      }
    }
  }
  console.log(`9.23 F17 synthetic races on the course, two apart: ${JSON.stringify({ ...st, wrong: st.wrong })}`);
  // (9.23 F20: a few fewer sure on the course, the right set offered instead: a one click weighed against one slow leg
  // too, and a pass that looks like the finish waits for the runner's finish pass; F19 182 sure and 332 offered of 581,
  // here 175 and 338, none wrong)
  assert.ok(st.all > 80 && st.sure / st.all > 0.28 && (st.sure + st.offered) / st.all > 0.6, `sure and right: ${st.sure}, the right one offered: ${st.offered} of ${st.all}`);
  assert.ok(st.wrong.length <= Math.ceil(st.all * 0.03), st.wrong.join('; '));
  assert.deepEqual(st.early, [], 'a one click sends no line in another split\'s column');
  assert.equal(st.completeSure, 0, `runners whose mats all read, given a one click: ${st.completeSure} of ${st.complete}`);
});

test('9.23 F15 synthetic races through the engine: two and three mats in a row at the first, middle and last splits, the finish pass in the stream or not, one runner in four with a cool-down pass: a sure one click is right (and sends every line right) for all but a walker or two; a runner whose mats all read is almost never given one', () => {
  const courses = [{ name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 }, { name: '5K, 1K splits', d: [1, 2, 3, 4], D: 5 }];
  const st = { all: 0, sure: 0, wrong: [], complete: 0, completeSure: 0, clicks: 0 };
  for (const fin of [true, false]) {
    for (let seed = 1; seed <= 2; seed++) {
      for (const course of courses) {
        const n = course.d.length;
        const race = makeRace(seed * 7919 + n, course, 140);
        const rand = rng(seed * 31 + n);
        for (const r of race) {
          r.miss = null;
          if (rand() < 0.15) {
            const len = 2 + Math.floor(rand() * Math.min(2, n - 2));
            r.miss = { j: Math.floor(rand() * (n - len + 1)), len };
          }
          const cool = rand() < 0.25;
          const ts = r.mats.filter((_, k) => !r.miss || k < r.miss.j || k >= r.miss.j + r.miss.len);
          if (fin && !r.dnf) ts.push(r.finish, ...(cool ? [r.finish + 90 + rand() * 400] : []));
          r.passes = ts.map((t) => Math.round(t * S));
        }
        const names = course.d.map((x) => `${x}K`);
        const s = setup({ races: [lapRace({ id: 'w', name: 'Synthetic', splits: lapSplits(n, names) })], filter: { tagWindowSec: 25, holdSec: 0, startIgnoreSec: 60 }, outputs: TWO_OUTPUTS });
        const reads = race.flatMap((r) => r.passes.map((t) => [r.bib, t])).sort((a, b) => a[1] - b[1]);
        s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
        s.clock.advance(70_000);
        for (const r of race) {
          if (r.dnf) continue;
          const h = s.engine.runner('w', r.bib).missedHint;
          if (!r.miss) {
            st.complete++;
            if (h?.sure) st.completeSure++;
            continue;
          }
          if (r.passes.length <= r.miss.j) continue;
          st.all++;
          if (!h?.sure) continue;
          if (names.indexOf(h.splitName) !== r.miss.j || h.count !== r.miss.len) {
            st.wrong.push(`${course.name} s${seed} fin ${fin} ${r.bib} ${r.miss.len}@${r.miss.j}: sure ${h.names.join('+')}`);
            continue;
          }
          st.sure++;
          // the one click: the made-up ones between their neighbours, the real ones as read, each line once, the furthest last
          const at = s.sends.length;
          s.engine.addMissed('w', r.bib, { splitId: h.splitId, passTod: h.passTod, count: h.count });
          const lines = linesOf(s, at, r.bib);
          assert.deepEqual(lines.map((x) => x[1]), Array.from({ length: n - r.miss.j }, (_, i) => n - r.miss.j - i), `${course.name} ${r.bib}`);
          for (const [split, l2g, cs] of lines) {
            const c = n - l2g;
            if (c < r.miss.j || c >= r.miss.j + r.miss.len) assert.equal(cs, formatRaceTime(Math.round(r.mats[c] * S), 3), `${course.name} ${r.bib} ${split}`);
          }
          sameOnBoth(s, at);
          st.clicks++;
        }
      }
    }
  }
  console.log(`9.23 F15 synthetic races, through the engine: ${JSON.stringify({ ...st, wrong: st.wrong })}`);
  // (the first two missed on a course with even splits, and walkers: legs alone can't tell; DESIGN 9.23 F15, not done)
  assert.ok(st.all > 100 && st.sure / st.all > 0.65, `sure and right: ${st.sure} of ${st.all}`);
  assert.ok(st.wrong.length <= Math.ceil(st.all * 0.015), st.wrong.join('; '));
  assert.ok(st.completeSure <= st.complete * 0.005, `runners whose mats all read, given a one click: ${st.completeSure} of ${st.complete}`);
});

test('9.23 F15 a Move the operator made, then a time typed before it (the re-check\'s R2b: 544, its real 5300m moved to 4400m, its real 4200m typed over the made-up one): the moved pass looks wrong, with its fix; one click, every line right; It\'s right keeps the Move', () => {
  const bib = '134';
  const real = passesOf(bib);
  const s = womens({ outputs: TWO_OUTPUTS, drop: { [bib]: [real[4], real[5]] } });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  let v = s.engine.runner('w', bib);
  const pass = v.passes.find((p) => p.raceTicks === real[6]);
  // the wrong fix by hand: 18:07.1 (its 5300m, counted in 4200m) moved to 4400m, 4200m filled with the suggestion
  s.engine.movePass('w', bib, { tod: pass.tod, to: v.columns[5].splitId, from: pass.where });
  s.engine.addManual('w', { bib, splitId: v.columns[4].splitId, ifEmpty: true });
  // ... then its real 4200m typed over the made-up one: the leg to the moved pass is 3:49 for 200 m
  s.engine.addManual('w', { bib, splitId: v.columns[4].splitId, time: formatRaceTime(real[4], 3) });
  s.clock.advance(3000);
  v = s.engine.runner('w', bib);
  assert.deepEqual(v.problems.map((p) => [p.kind, p.col, p.text]), [['flag', 5, 'You moved 18:07.1 to 4400m, but it looks like 5300m (missed 4400m?): 3:49 after 4200m, where runners of the same pace took 4:02.']]);
  assert.deepEqual([v.missedHint.names, v.missedHint.sure, v.columns[5].missed.ok], [['4400m'], true, true]);
  const row = s.engine.review('w').flags.find((f) => f.bib === bib);
  assert.deepEqual([row.splitName, row.kind, row.missed.names], ['4400m', 'long', ['4400m']]);
  // It's right: the Move stays (it is said to be right), the flag is silenced, also after a restart (the journal's
  // record: a Move with seen, which an older Split Relay reads as the Move it is); Undo puts the question back
  const keep = s.engine.movePass('w', bib, { tod: pass.tod, to: 'keep', from: v.columns[5].splitId });
  assert.match(keep.change.text, /^18:07\.1 stays in 4400m/);
  v = s.engine.runner('w', bib);
  assert.deepEqual([v.columns[5].time, v.columns[5].how, v.problems, v.missedHint], [real[6], 'moved', [], null]);
  const back = s.restart();
  v = back.engine.runner('w', bib);
  assert.deepEqual([v.columns[5].time, v.columns[5].how, v.problems, v.missedHint], [real[6], 'moved', [], null]);
  assert.deepEqual(journalOf(s).filter((x) => x.t === 'assign' && x.tod === pass.tod).at(-1), { ...journalOf(s).filter((x) => x.t === 'assign' && x.tod === pass.tod).at(-1), splitId: v.columns[5].splitId, seen: true });
  back.engine.undo('w', { fix: keep.change.fix, confirm: true });
  assert.equal(back.engine.runner('w', bib).problems[0].kind, 'flag');
  Object.assign(s, { engine: back.engine, sends: back.sends });
  // the one click: 18:07.1 to 5300m, 4400m made up between the typed 4200m and it, the finish pass an extra pass
  const r = missedOneClick(s, bib, row, [5], real);
  assert.equal(r.change.text, `Missed 4400m added (${formatRaceTime(s.engine.runner('w', bib).columns[5].time, 1)}, made up); 18:07.1 → 5300m; 20:43.5 is an extra pass now (the finish)`);
  assert.deepEqual(s.engine.runner('w', bib).problems, []);
});

test('9.23 F10 Clear race data keeps the pins: Replay rebuilds the race fixed; an old journal\'s clear forgets them; made-up times always go', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  s.engine.addManual('r', { bib: '105', splitId: 's2' });
  s.engine.clearRace('r');
  assert.equal(journalOf(s).filter((x) => x.t === 'clear').at(-1).keepPins, true);
  assert.deepEqual(s.engine.review('r').manual, [], 'the made-up time is forgotten');
  // RR12's Replay: the same reads again
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  const cols = s.engine.runner('r', '105').columns.map((c) => [c.time, c.kind]);
  assert.deepEqual(cols, [[timeOf(105, 1), 'read'], [null, 'missing'], [timeOf(105, 3), 'moved'], [timeOf(105, 4), 'moved']]);
  assert.deepEqual(s.engine.review('r').checks, [], 'not asked again');
  const t = s.restart();
  assert.deepEqual(t.engine.runner('r', '105').columns.map((c) => [c.time, c.kind]), cols);
  // an older Split Relay's clear (no keepPins) forgets the pins too, as it always did
  const old = memStore();
  for (const l of s.store.journal) old.journal.push(l.includes('"t":"clear"') ? l.replace(',"keepPins":true', '') : l);
  const o = setup({ store: old });
  assert.deepEqual(o.engine.runner('r', '105').columns.map((c) => c.kind), ['read', 'read', 'read', 'blocked'], 'counted, and held for the check again');
  assert.equal(o.engine.review('r').checks.length, 2);
});

test('9.23 F6 legFlags by hand: long and short legs, the nearest runners, the finish only for the last split or pass, silenced keeps, too few to judge', () => {
  const n = 3;
  const names = ['1K', '2K', '3K'];
  const mk = (bib, ts, { look = 'counted', finish = null, passes = null } = {}) => ({ bib, kept: ts.slice(), real: ts.slice(), look: ts.map((t) => (t === null ? null : look)),
    passes: passes ?? ts.filter((t) => t !== null), finish });
  const field3 = [];
  for (let i = 0; i < 20; i++) field3.push(mk(String(100 + i), [180 + i, 360 + 2 * i, 540 + 3 * i].map((x) => x * S), { finish: (900 + 5 * i) * S }));
  // a runner whose 2K pass is really 3K (missed 2K), and its finish counted as 3K
  const miss = mk('9', [185 * S, 545 * S, 905 * S]);
  // a stray pass 20 s after 1K
  const stray = mk('8', [185 * S, 205 * S, 365 * S]);
  let f = legFlags({ n, names, runners: [...field3, miss, stray] });
  assert.deepEqual([f.get('9').col, f.get('9').kind, f.get('9').suggest.to], [1, 'long', 2]);
  assert.deepEqual([f.get('8').col, f.get('8').kind, f.get('8').suggest.to], [1, 'short', 'none']);
  assert.equal(f.size, 2, 'nobody else');
  // only 4 others nearest: too few to judge
  f = legFlags({ n, names, runners: [...field3.slice(0, 4), miss] });
  assert.equal(f.size, 0);
  // the finish is a candidate for the last split: a finish counted as 3K
  const fin = mk('7', [185 * S, 365 * S, 905 * S]);
  f = legFlags({ n, names, runners: [...field3, fin] });
  assert.deepEqual([f.get('7').col, f.get('7').suggest.to], [2, 'finish']);
  // (9.23 F16: in the form of the others and of Passes to check: the splits missed, the runners' leg to the finish)
  assert.deepEqual([f.get('7').suggest.missed, f.get('7').text], [['3K'], '15:05.0 looks like the finish, not 3K (missed 3K?): 9:00 after 2K, where runners of the same pace took 9:29.']);
  // ... but not for a middle pass with later passes
  const mid = mk('6', [185 * S, 905 * S, null], { passes: [185 * S, 905 * S, 1000 * S] });
  f = legFlags({ n, names, runners: [...field3, mid] });
  assert.ok(f.get('6').fits.every((x) => x.to !== 'finish'));
  // a leg 0.25-0.6 of theirs: flagged, no suggestion
  const short = mk('5', [185 * S, 250 * S, 545 * S]);
  f = legFlags({ n, names, runners: [...field3, short] });
  assert.deepEqual([f.get('5').kind, f.get('5').suggest], ['short', null]);
  // the operator said it is right (seen): a silenced flag; kept from the check queue (not seen): it asks once
  f = legFlags({ n, names, runners: [...field3, mk('9', [185 * S, 545 * S, 905 * S], { look: 'seen' })] });
  assert.equal(f.get('9').silenced, true);
  f = legFlags({ n, names, runners: [...field3, mk('9', [185 * S, 545 * S, 905 * S], { look: 'kept' })] });
  assert.deepEqual([f.get('9').silenced, f.get('9').kept, /^You kept /.test(f.get('9').text)], [false, true, true]);
  // a crossing not looked at (a Move, a made-up time, a timing point, a suspect): no flag
  f = legFlags({ n, names, runners: [...field3, { ...miss, look: [null, null, null] }] });
  assert.equal(f.size, 0);
  assert.deepEqual(Object.keys(FIT_RULES), ['nearest', 'minRefs', 'longAbove', 'shortBelow', 'strayBelow', 'fitWithin', 'betterBy']);
});

test('9.23 F6 legFlags on synthetic races where the stream carries the finish pass: complete runners rarely flagged, missed mats found and placed', () => {
  const courses = [...COURSES, { name: '6K, 7 splits', d: [0.8, 1.5, 2.4, 3.1, 4.2, 4.4, 5.3], D: 6 }];
  const st = { complete: 0, completeFlagged: 0, missed: 0, flagged: 0, right: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    for (const course of courses) {
      const n = course.d.length;
      const fieldRunners = makeRace(seed * 7919 + n, course, 120 + (seed % 5) * 40);
      const rand = rng(seed * 31 + n);
      const runners = fieldRunners.map((r) => {
        const miss = rand() < 0.1 ? 1 + Math.floor(rand() * (n - 1)) : -1;
        const passes = [...r.mats.filter((_, k) => k !== miss), r.finish, r.finish + 120 + rand() * 600].map((t) => Math.round(t * S));
        const real = new Array(n).fill(null);
        const look = new Array(n).fill(null);
        passes.slice(0, n).forEach((t, k) => {
          real[k] = t;
          look[k] = 'counted';
        });
        return { bib: r.bib, kept: real.slice(), real, look, passes, finish: null, miss };
      });
      const flags = legFlags({ n, names: course.d.map((x) => `${x}K`), runners });
      for (const r of runners) {
        const f = flags.get(r.bib);
        if (r.miss < 0) {
          st.complete++;
          if (f) st.completeFlagged++;
          continue;
        }
        st.missed++;
        if (!f) continue;
        st.flagged++;
        if (f.col === r.miss && f.suggest?.to === (r.miss === n - 1 ? 'finish' : r.miss + 1)) st.right++;
      }
    }
  }
  const pct = (a, b) => Math.round((1000 * a) / b) / 10;
  console.log(`legFlags synthetic: complete runners flagged ${pct(st.completeFlagged, st.complete)}% of ${st.complete}; missed mats flagged ${pct(st.flagged, st.missed)}% of ${st.missed}, right suggestion ${pct(st.right, st.flagged)}%`);
  assert.ok(st.completeFlagged / st.complete <= 0.01, 'complete runners flagged <= 1%');
  assert.ok(st.flagged / st.missed >= 0.88, 'missed mats with every column full flagged (DESIGN 9.23: 90.4% on 60 seeds)');
  assert.ok(st.right / st.flagged >= 0.95, 'the right suggestion');
});

test('9.23 F7 views: the runner editor\'s targets, only, finishOk, problems and changes; find by bib and name', () => {
  const s = setup();
  field(s, { skip: { 105: [2] } });
  s.clock.advance(3000);
  s.engine.assign('r', { bib: '105', all: 'move' });
  const v = s.engine.runner('r', '105');
  assert.deepEqual(v.columns.map((c) => [c.kind, c.how]), [['read', 'counted'], ['missing', null], ['moved', 'moved'], ['moved', 'moved']]);
  assert.deepEqual([v.fillable, v.finishBy, v.alsoIn], [1, null, []]);
  assert.deepEqual(v.problems.map((p) => [p.kind, p.col]), [['missing', 1]]);
  assert.deepEqual(v.changes.map((c) => [c.kind, c.undoable, c.text]), [['check', true, '9:54.0 moved to 3K, 13:12.0 moved to 4K']]);
  assert.match(v.changes[0].atText, /^\d\d:\d\d:\d\d$/);
  const p = v.passes[1];
  assert.deepEqual(p.only.map((t) => [t.splitName, t.ok]), [['1K', false], ['2K', true], ['3K', false], ['4K', false]]);
  assert.equal(p.finishOk.ok, false);
  assert.deepEqual(s.engine.find('105').matches.map((m) => [m.raceId, m.bib, m.by, m.filled, m.problems]), [['r', '105', 'bib', 3, 1]]);
  assert.deepEqual(s.engine.find('0105').matches.length, 1, 'leading zeros');
  assert.deepEqual(s.engine.find('').matches, []);
  // the grid's estimates are the Review list's
  const g = s.engine.grid('r');
  const row = g.rows.find((x) => x.bib === '105');
  assert.equal(row.cells[1].est, s.engine.review('r').missing[0].estimate);
  assert.deepEqual([row.tier, g.counts.fillable, g.splits[1].fillable], [2, 1, 1]);
});

test('9.23 performance: grid() and the look-wrong check for 600 runners by 8 splits', () => {
  const races = [lapRace({ splits: lapSplits(8) })];
  const s = setup({ races, filter: { holdSec: 0 } });
  const rand = rng(23);
  const reads = [];
  for (let i = 0; i < 600; i++) {
    const pace = 1 + rand() * 0.6;
    for (let k = 1; k <= 8; k++) if (rand() > 0.03) reads.push([String(1000 + i), Math.round(160 * k * pace * S)]);
  }
  reads.sort((a, b) => a[1] - b[1]);
  s.engine.handleReads(reads.map(([bib, t]) => ({ read: { location: '', bib, tod: GUN + t, contest: '', first: '', last: '', team: '', gender: '' }, meta: { port: 5565 } })));
  let t0 = performance.now();
  s.engine.review('r');
  const review = performance.now() - t0;
  t0 = performance.now();
  const g = s.engine.grid('r');
  const grid = performance.now() - t0;
  t0 = performance.now();
  s.engine.grid('r');
  const again = performance.now() - t0;
  console.log(`600 x 8: review (check, estimates, legFlags) ${review.toFixed(1)} ms; grid() ${grid.toFixed(1)} ms, cached ${again.toFixed(1)} ms; ${g.rows.length} rows`);
  assert.equal(g.rows.length, 600);
  assert.ok(review < 1000 && grid < 1000 && again < 1000);
});

test('9.23 randomized: Moves (with the later times, only), Not a split, the finish, count, keep, fills, removes, Undo, Redo, Clear + Replay: read by read = rebuild = restart; every packet safe', () => {
  for (const seed of [11, 57, 812]) {
    const rand = rng(seed);
    const s = setup({ races: [lapRace({ splits: lapSplits(4) })], filter: { holdSec: rand() < 0.5 ? 0 : 2 } });
    let packets = 0;
    s.engine.on('send', (p) => {
      packets++;
      assertSendable(p, s.config);
    });
    const reads = [];
    for (let i = 0; i < 30; i++) {
      const pace = 1 + rand() * 0.5;
      for (let k = 1; k <= 5; k++) { // the fifth pass is the finish line, carried by the stream
        if (rand() < 0.08) continue;
        const t = 180 * k * pace + rand() * 3;
        reads.push([100 + i, t]);
        if (rand() < 0.3) reads.push([100 + i, t + rand() * 1.5]);
        if (rand() < 0.04) reads.push([100 + i, t + 30 + rand() * 20]); // a stray pass
      }
    }
    const arrivals = reads.map((r) => ({ r, at: r[1] + 1.5 + rand() * 3 })).sort((a, b) => a.at - b.at);
    const tried = { ok: 0, refused: 0 };
    const attempt = (fn) => {
      try {
        fn();
        tried.ok++;
      } catch (err) {
        assert.ok([400, 404, 409].includes(err.status), err.stack);
        tried.refused++;
      }
    };
    const pick = (list) => list[Math.floor(rand() * list.length)];
    let cleared = false;
    for (const [i, { r: [bib, t] }] of arrivals.entries()) {
      s.lap(bib, raceTimeText(t));
      s.clock.advance(Math.floor(rand() * 1500));
      if (i % 4 !== 1) continue;
      const b = String(100 + Math.floor(rand() * 30));
      const v = s.engine.runner('r', b);
      if (!v.found) continue;
      const roll = rand();
      if (roll < 0.35 && v.passes.length) {
        const p = pick(v.passes);
        const to = rand() < 0.6 ? pick(['s1', 's2', 's3', 's4']) : pick(['none', 'finish', 'count', 'keep']);
        attempt(() => s.engine.movePass('r', b, { tod: p.tod, to, only: rand() < 0.25, from: p.inColumn ? p.where : '' }));
      } else if (roll < 0.55) {
        const c = v.columns.find((x) => x.kind === 'missing') || v.columns.find((x) => x.kind === 'not-yet');
        if (c) attempt(() => s.engine.addManual('r', c.kind === 'missing' ? { bib: b, splitId: c.splitId, ifEmpty: true } : { bib: b, splitId: c.splitId, time: raceTimeText(180 * (c.index + 1) * 1.3) }));
      } else if (roll < 0.62) {
        const m = s.engine.review('r').manual.find((x) => x.state === 'active');
        if (m) attempt(() => s.engine.removeManual('r', { bib: m.bib, splitId: m.splitId }));
      } else if (roll < 0.85) {
        const ch = v.changes.find((x) => x.undoable);
        if (ch) attempt(() => s.engine.undo('r', { fix: ch.fix, confirm: true }));
      } else if (roll < 0.9 && !cleared && i > arrivals.length / 2) {
        // Clear race data, then RR12's Replay: the same reads again; the pins apply to them again
        cleared = true;
        s.engine.clearRace('r');
        for (const { r: [bb, tt] } of arrivals.slice(0, i + 1)) s.lap(bb, raceTimeText(tt));
      } else if (rand() < 0.3) {
        s.lynx.set(b, Math.round((900 + rand() * 200) * S));
        s.places.set(b, 1 + Math.floor(rand() * 30));
        s.engine.converge();
      }
    }
    s.clock.advance(70_000);
    const bibs = Array.from({ length: 30 }, (_, i) => String(100 + i));
    const snap = (e) => {
      const g = e.grid('r');
      return {
        crossings: e.crossings('r').map((c) => [c.bib, c.splitId, c.tod, c.raceTicks, c.place, c.reads, c.source, c.held]),
        view: e.raceView('r'),
        data: [...e.raceData('r').runners].map(([bib, r]) => [bib, r.splits]),
        review: e.review('r'),
        grid: g.rows.map((r) => [r.bib, r.tier, r.cells, r.problems.map((p) => p.kind)]),
        changes: bibs.map((bib) => e.runner('r', bib).changes.map((c) => [c.fix, c.kind, c.text, c.undone, c.undoable, c.at])),
        passes: bibs.map((bib) => e.runner('r', bib).passes.map((p) => [p.tod, p.how, p.pinned, p.splitName])),
      };
    };
    const incremental = snap(s.engine);
    const n = packets;
    s.config.races[0].splits[0].sources.push('Never');
    s.engine.configChanged();
    s.config.races[0].splits[0].sources.pop();
    s.engine.configChanged();
    const rebuilt = snap(s.engine);
    for (const k of Object.keys(incremental)) assert.deepEqual(rebuilt[k], incremental[k], `${k}, rebuild, seed ${seed}`);
    assert.equal(packets, n, `the rebuild found nothing to send, seed ${seed}`);
    s.clock.advance(1000);
    const t = s.restart();
    const after = snap(t.engine);
    for (const k of ['crossings', 'data', 'grid', 'changes', 'passes']) assert.deepEqual(after[k], incremental[k], `${k}, restart, seed ${seed}`);
    assert.deepEqual(after.review.missing, incremental.review.missing, `review, restart, seed ${seed}`);
    console.log(`9.23 randomized, seed ${seed}: ${tried.ok} changes made, ${tried.refused} refused in words, ${n} packets${cleared ? ', a Clear and a Replay' : ''}`);
    assert.ok(tried.ok > 5, `seed ${seed}: ${tried.ok} changes made, ${tried.refused} refused`);
  }
});

// ---- DESIGN 9.24: a split too fast to be real is marked as its read comes in (never held), Stop sending this runner,
// ---- the boards put right by themselves after a change, the clearing line ------------------------------------------------

/**
 * A race fed in time order, the clock at each read (as a meet's reads arrive): bib 100 + i passes split k at 3:00 x k x
 * (1 + 0.02 i); `own`: bib -> its own race times in seconds instead. Only the reads later than `after` and up to `upTo`.
 */
function liveField(s, { count = 20, splits = 6, own = {}, after = -Infinity, upTo = Infinity } = {}) {
  const reads = [];
  for (let i = 0; i < count; i++) {
    const bib = 100 + i;
    const mine = own[bib] ?? Array.from({ length: splits }, (_, k) => 180 * (k + 1) * (1 + 0.02 * i));
    for (const t of mine) if (t > after && t <= upTo) reads.push([bib, t]);
  }
  reads.sort((a, b) => a[1] - b[1]);
  for (const [bib, t] of reads) {
    const at = T0 + Math.round(t * 1000);
    if (at > s.clock.now()) s.clock.advance(at - s.clock.now());
    s.lap(bib, raceTimeText(t));
  }
}
/**
 * The 2026-10-31 shape on a synthetic race of six 1K mats: bib 118 (19th of 20, every leg 1.36 of the leader's) drops
 * out after 3K, and its chip is read twice more: 2:48.5 after its 3K (0.90 of the leaders' leg, 3:07.2) and 2:11.0
 * after that (0.70). Bib 109 (10th) runs the last leg in 2:59.7, the fastest of the race (0.96 of the leaders');
 * bib 110 collapses on the leg to 4K (5:24 where its pace gives 3:36, from 11th to 18th) and goes on.
 */
const FAST_OWN = {
  118: [244.8, 489.6, 734.4, 902.9, 1033.9],
  109: [212.4, 424.8, 637.2, 849.6, 1062.0, 1241.7],
  110: [216, 432, 648, 972, 1188, 1404],
};
const fastRace = (over = {}) => setup({ races: [lapRace({ splits: lapSplits(6) })], filter: { holdSec: 0 }, ...over });

test('9.24 the pace check (pure): too fast is under 0.95 of the leaders\' leg AND under 0.88 of the runner\'s own pace, for a runner whose legs agree; the words', () => {
  const n = 6;
  const times = (pace) => Array.from({ length: n }, (_, k) => Math.round(180 * (k + 1) * pace * S));
  const fieldOf = (extra = []) => fastField({ n, runners: [...Array.from({ length: 20 }, (_, i) => ({ bib: String(100 + i), real: times(1 + 0.02 * i) })), ...extra] });
  const judge = (real, rules) => fastLegsOf(fieldOf([{ bib: 'x', real }]), { bib: 'x', real }, rules);
  // the leaders' leg of a stretch: the median of the five fastest legs of the OTHERS (187.2 s here)
  const lead = Math.round(187.2 * S);
  // (1) the dropped-out runner: two reads, each too fast after the one before
  const out = times(1.36).slice(0, 3);
  out.push(out[2] + 1685000, out[2] + 1685000 + 1310000, null);
  const legs = judge(out);
  assert.deepEqual(legs.map((x) => [x.col, x.from, Math.round(x.ratio * 100) / 100, Math.round(x.own * 100) / 100, x.refs]), [[3, 2, 0.9, 1.31, 20], [4, 3, 0.7, 1.31, 20]]);
  assert.equal(fastText(legs.slice(0, 1), { bib: '118', place: 19, names: ['1K', '2K', '3K', '4K', '5K', '6K'] }),
    'Bib 118, 4K 15:02.9: 2:48.5 after 3K, where the leaders took 3:07. Too fast for a runner who was 19th: not a split?');
  assert.match(fastText(legs, { bib: '118', place: 19, names: ['1K', '2K', '3K', '4K', '5K', '6K'] }), /^Bib 118, 4K 15:02\.9: 2:48\.5 after 3K, where the leaders took 3:07; 5K 17:13\.9: 2:11\.0 after 4K, where the leaders took 3:07\. Too fast for a runner who was 19th: not splits\?$/);
  // with the rule switched off nothing is marked: the numbers are the rule
  assert.deepEqual(judge(out, { ...FAST_RULES, below: 0 }), []);
  assert.deepEqual(judge(out, { ...FAST_RULES, ownBelow: 0 }), []);
  // (2) a strong finisher from far back: one of the fastest legs of the race, 0.98 of the leaders': a real split
  const strong = times(1.32);
  strong[5] = strong[4] + Math.round(0.98 * lead);
  assert.deepEqual(judge(strong), []);
  // (3) a runner far ahead of the field runs every leg under the leaders' (0.90 of it): her own pace, a real split
  assert.deepEqual(judge(times(0.9)), []);
  // ... and a leg that is under both bounds but only just above one of them is no mark either
  const edge = times(1.1);
  edge[3] = edge[2] + Math.round(0.96 * lead);
  assert.deepEqual(judge(edge), [], '0.96 of the leaders\' leg, 0.87 of its own pace');
  // (4) a collapse: a leg twice as long, then the old pace again: nothing is too fast
  const slow = times(1.2);
  for (let k = 3; k < n; k++) slow[k] += 216 * S;
  assert.deepEqual(judge(slow), []);
  // (5) a mat that missed the runner (2K): its legs are other stretches' (one twice as long, the passes after it a
  // column early): the runner's legs do not agree, and that is the missed-mat fixes', never "too fast"
  const course = [180, 360, 760, 1000, 1180, 1500].map((t) => t * S);
  const courseField = fastField({ n, runners: Array.from({ length: 20 }, (_, i) => ({ bib: String(100 + i), real: course.map((t) => Math.round(t * (1 + 0.02 * i))) })) });
  const missed = course.map((t) => Math.round(t * 1.2));
  missed.splice(1, 1);
  missed.push(null);
  assert.deepEqual(fastLegsOf(courseField, { bib: 'x', real: missed }), [], 'its 240 s leg counted on the 400 s stretch is 0.6 of the leaders\'');
  assert.equal(fastLegsOf(courseField, { bib: 'x', real: missed }, { ...FAST_RULES, steady: Infinity }).length > 0, true, 'only the steady rule keeps it out');
  // (6) a stray read 0:40 after a real pass, and the runner's real next pass a column late because of it: the stray is
  // the mark; the real pass is no part of it (with the stray set aside it fits the runner's own pace)
  const stray = times(1.2);
  stray.splice(3, 0, stray[2] + 40 * S);
  stray.length = n;
  assert.deepEqual(fastLegsOf(fieldOf(), { bib: 'x', real: stray }).map((x) => x.col), [3]);
  // (7) a pass the operator placed or said is right is not judged; nor a leg to or from a made-up time (no real time there)
  assert.deepEqual(fastLegsOf(fieldOf(), { bib: 'x', real: out, fixed: [false, false, false, true, true, false] }), []);
  const gap = out.slice();
  gap[2] = null;
  assert.deepEqual(fastLegsOf(fieldOf(), { bib: 'x', real: gap }).map((x) => x.col), [4], 'no leg into 4K: only the next one, measured from it');
  // fewer than five others through both splits: no judgement yet
  const few = fastField({ n, runners: Array.from({ length: 5 }, (_, i) => ({ bib: String(100 + i), real: times(1 + 0.02 * i) })) });
  assert.deepEqual(fastLegsOf(few, { bib: '104', real: out }), []);
  assert.deepEqual([FAST_RULES.minRefs, FAST_RULES.below, FAST_RULES.ownBelow, FAST_RULES.steady, FAST_RULES.afterAbove], [5, 0.95, 0.88, 1.5, 1.15]);
  assert.deepEqual(paceAt(fieldOf(), { bib: 'x', real: out }, 3), { lead, own: legs[0].own, steady: true });
});

test('9.24 a split too fast to be real goes out as any split and is marked from the moment its read arrives: one row for both, Needs attention, the grid, the feed; Not a split takes both back and the others\' places go out by themselves; a strong finisher and a collapse are not marked', () => {
  const s = fastRace();
  s.engine.on('send', (p) => assertSendable(p, s.config));
  liveField(s, { own: FAST_OWN, upTo: 902.8 });
  assert.deepEqual([s.engine.review('r').flags, s.engine.review('r').checks, s.engine.review('r').counts.fast], [[], [], undefined]);
  // her chip is read 2:48.5 after her 3K: it goes out as her 4K, place 13 ...
  const e4 = s.lap(118, '15:02.900');
  assert.deepEqual(sentOf(s, 118).at(-1), ['4K', rt('15:02.9'), 13, 'new']);
  // ... and it is marked at once: the row, the counts the Dashboard and the race tile show, the grid, the feed, the log
  let rv = s.engine.review('r');
  assert.deepEqual(rv.flags.map((f) => [f.bib, f.splitName, f.kind, f.suggest.to, f.passes.map((p) => `${p.splitName} ${p.timeText}`), f.text]),
    [['118', '4K', 'fast', 'none', ['4K 15:02.9'], 'Bib 118, 4K 15:02.9: 2:48.5 after 3K, where the leaders took 3:07. Too fast for a runner who was 19th: not a split?']]);
  assert.deepEqual([rv.checks, rv.counts.flagged, rv.counts.fast, rv.counts.fastBibs, s.engine.raceView('r').review.fast], [[], 1, 1, ['118'], 1]);
  assert.equal(s.logs.filter((l) => l.includes('Bib 118, 4K 15:02.9') && l.includes('Marked (Splits that look wrong); it went out as any split.')).length, 1);
  assert.equal(s.row(e4).detail, `Sent as place 13. ${TOO_FAST_TEXT}`);
  let g = s.engine.grid('r').rows.find((r) => r.bib === '118');
  assert.deepEqual([g.tier, g.cells.map((c) => (c.flag ? 1 : 0)), g.problems.map((p) => p.kind)], [1, [0, 0, 0, 1, 0, 0], ['flag']]);
  // the second read, 2:11 later, goes out as her 5K, PLACE 9: one row for both splits
  liveField(s, { own: { ...FAST_OWN, 118: [] }, after: 902.8, upTo: 1033.8 });
  s.lap(118, '17:13.900');
  assert.deepEqual(sentOf(s, 118).at(-1), ['5K', rt('17:13.9'), 9, 'new']);
  rv = s.engine.review('r');
  assert.deepEqual(rv.flags.map((f) => [f.bib, f.splitName, f.kind, f.suggest.to, f.passes.map((p) => `${p.splitName} ${p.timeText}`)]), [['118', '4K and 5K', 'fast', 'none', ['4K 15:02.9', '5K 17:13.9']]]);
  assert.equal(rv.flags[0].text, 'Bib 118, 4K 15:02.9: 2:48.5 after 3K, where the leaders took 3:07; 5K 17:13.9: 2:11.0 after 4K, where the leaders took 3:07. Too fast for a runner who was 19th: not splits?');
  g = s.engine.grid('r').rows.find((r) => r.bib === '118');
  assert.deepEqual(g.cells.map((c) => (c.flag ? 1 : 0)), [0, 0, 0, 1, 1, 0], 'both cells are marked');
  const v0 = s.engine.runner('r', '118');
  assert.deepEqual(v0.columns.map((c) => [c.held, c.flag?.kind ?? null, c.flag?.also?.length ?? 0]), [[null, null, 0], [null, null, 0], [null, null, 0], [null, 'fast', 1], [null, 'fast', 1], [null, null, 0]]);
  assert.deepEqual(v0.problems.map((p) => [p.kind, p.col]), [['flag', 3]]);
  // the rest of the race: the strong last leg (bib 109) and the collapse (bib 110) go out and are not marked
  liveField(s, { own: { ...FAST_OWN, 118: [] }, after: 1033.8 });
  s.clock.advance(70_000);
  assert.deepEqual([...new Set(sentOf(s, 109).map((x) => x[0]))], ['1K', '2K', '3K', '4K', '5K', '6K']);
  assert.deepEqual(sentOf(s, 109).at(-1).slice(0, 3), ['6K', Math.round(1241.7 * S), 9]);
  assert.deepEqual([...new Set(sentOf(s, 110).map((x) => x[0]))], ['1K', '2K', '3K', '4K', '5K', '6K']);
  rv = s.engine.review('r');
  assert.deepEqual([rv.flags.map((f) => f.bib), rv.checks, rv.counts.fast], [['118'], [], 1]);
  assert.deepEqual(s.engine.crossings('r').filter((c) => c.held).length, 0, 'nothing is held');
  // Not a split on the row: both are taken back in ONE change; the 18 lines of the runners behind her at 4K and 5K go
  // out again by themselves with their new places (long after their minute), each runner's furthest split last
  const f = rv.flags[0];
  const at = s.sends.length;
  const r = s.engine.movePass('r', '118', { tod: f.passTod, to: 'none', from: f.splitId, also: f.passes.slice(1).map((p) => p.passTod) });
  assert.equal(r.change.text, '15:02.9 and 17:13.9 are not splits now');
  assert.deepEqual(r.change.cells.map((c) => [c.splitName, c.before, c.after]), [['4K', '15:02.9', ''], ['5K', '17:13.9', '']]);
  assert.deepEqual([r.change.resent, r.change.staleOthers, r.change.leftover.map((x) => x.splitName), r.change.cleared], [{ lines: 18, outputs: ['TrackScore'] }, 0, ['4K', '5K'], { lines: 0, outputs: [] }]);
  const since = s.sends.slice(at);
  assert.deepEqual(since.filter((p) => p.bib === '118').map((p) => [p.splitName, p.reason]), [['3K', 'place-update']], 'her furthest split that is left, last');
  const others = since.filter((p) => p.bib !== '118');
  assert.deepEqual(others.filter((p) => p.splitName === '4K').map((p) => [p.bib, p.place, p.reason]), [113, 114, 115, 116, 117, 110, 119].map((b, i) => [String(b), 13 + i, 'place-update']));
  assert.deepEqual(others.filter((p) => p.splitName === '5K').map((p) => [p.bib, p.place]), [108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 119].map((b) => [String(b), s.engine.crossings('r').find((c) => c.bib === String(b) && c.splitName === '5K').place]).sort((x, y) => x[1] - y[1]));
  assert.equal(new Set(others.filter((p) => p.splitName !== '6K').map((p) => `${p.bib}|${p.splitName}`)).size, 18);
  for (const b of new Set(others.map((p) => p.bib))) assert.equal(others.filter((p) => p.bib === b).at(-1).splitName, '6K', `bib ${b}: its furthest split last`);
  assert.deepEqual(s.engine.raceData('r').runners.get('118').splits.map((t) => t !== null), [true, true, true, false, false, false], 'gone from the merged .lif');
  // (what the race tile still counts as out of date: her own two cells, which no packet can empty; the change said so)
  assert.deepEqual([s.engine.review('r').flags, s.engine.raceView('r').stale?.count ?? 0], [[], 2]);
  // one Undo puts both back (and the places); It's right silences the mark
  const u = s.engine.undo('r', { fix: r.change.fix, confirm: true });
  assert.equal(u.change.resent.lines, 18);
  assert.deepEqual(s.engine.review('r').flags.map((x) => [x.bib, x.kind, x.passes.length]), [['118', 'fast', 2]]);
  const k = s.engine.movePass('r', '118', { tod: f.passTod, to: 'keep', from: f.splitId, also: f.passes.slice(1).map((p) => p.passTod) });
  assert.equal(k.change.text, '15:02.9 and 17:13.9 stay where they are');
  assert.deepEqual([s.engine.review('r').flags.length, s.engine.review('r').counts.fast], [0, undefined]);
  // a rebuild and a restart agree
  const snap = (e) => [e.crossings('r').map((x) => [x.bib, x.splitId, x.tod, x.place, x.held]), e.review('r').flags, e.review('r').counts];
  const now = snap(s.engine);
  assert.deepEqual(snap(s.restart().engine), now);
});

test('9.24 Stop sending this runner: from the marked split on nothing of the runner goes out or into the .lif, its reads are still counted and shown; a restart keeps it; Send this runner again and Undo', () => {
  const s = fastRace();
  liveField(s, { own: FAST_OWN, upTo: 1000 });
  const f = s.engine.review('r').flags[0];
  assert.deepEqual([f.bib, f.kind], ['118', 'fast']);
  let v = s.engine.runner('r', '118');
  assert.deepEqual(v.sending, { off: null, stop: { from: f.passTod, fromText: '15:02.9', after: false, takesBack: ['4K'],
    text: 'Nothing of bib 118 from 15:02.9 on goes out: 4K is taken back.' } });
  const at = s.sends.length;
  const r = s.engine.stopRunner('r', '118', { from: f.passTod });
  assert.deepEqual([r.change.kind, r.change.text, r.change.leftover], ['stop', 'Not sent from 15:02.9 on (4K taken back)', [{ bib: '118', splitName: '4K', text: '15:02.9', stopped: true }]]);
  // the seven runners behind her at 4K move up a place: on the boards by themselves (some inside their minute, some after it)
  const upd = s.sends.slice(at).filter((p) => p.splitName === '4K');
  assert.deepEqual(upd.map((p) => [p.bib, p.place, p.reason]).sort((x, y) => x[1] - y[1]), [113, 114, 115, 116, 117, 110, 119].map((b, i) => [String(b), 13 + i, 'place-update']));
  assert.equal(r.change.resent.lines > 0 && r.change.staleOthers === 0, true);
  // her next read is counted and shown, not sent
  const n = s.sends.length;
  liveField(s, { own: FAST_OWN, after: 1000 });
  s.clock.advance(70_000);
  assert.equal(s.sends.slice(n).filter((p) => p.bib === '118').length, 0, 'nothing of bib 118 after the stop');
  v = s.engine.runner('r', '118');
  assert.deepEqual(v.columns.map((c) => [c.timeText, c.held]), [['4:04.8', null], ['8:09.6', null], ['12:14.4', null], ['15:02.9', 'stopped'], ['17:13.9', 'stopped'], ['', null]]);
  assert.equal(v.sending.off.text, 'Not sending bib 118: nothing from 15:02.9 on goes out (4K and 5K wait).');
  assert.deepEqual(s.engine.raceData('r').runners.get('118').splits.map((t) => t !== null), [true, true, true, false, false, false]);
  const rv = s.engine.review('r');
  assert.deepEqual([rv.flags, rv.checks, rv.off.map((o) => [o.bib, o.fromText, o.held.map((h) => h.splitName)])], [[], [], [['118', '15:02.9', ['4K', '5K']]]]);
  const g = s.engine.grid('r');
  assert.deepEqual([g.counts.off, g.rows.find((x) => x.bib === '118').off, g.rows.find((x) => x.bib === '118').cells.map((c) => c.held ?? '')], [1, 'Not sending from 15:02.9 on', ['', '', '', 'stopped', 'stopped', '']]);
  assert.equal(s.engine.feed(1000).find((e) => e.bib === '118' && e.raceTicks === rt('17:13.9')).status, 'not-sending');
  // the others' places do not count her: bib 108 is 9th at 5K
  assert.equal(s.engine.crossings('r').find((c) => c.bib === '108' && c.splitName === '5K').place, 9);
  assert.throws(() => s.engine.stopRunner('r', '118'), (err) => err.status === 409 && err.message === 'Bib 118 is not sent already.');
  // journaled with the change, kept across a restart
  assert.deepEqual(journalOf(s).filter((x) => x.fix === r.change.fix).map((x) => [x.t, x.bib, x.from, x.fixKind]), [['runner-off', '118', f.passTod, 'stop']]);
  const t = s.restart();
  assert.deepEqual(t.engine.runner('r', '118').columns.map((c) => c.held), [null, null, null, 'stopped', 'stopped', null]);
  assert.equal(t.engine.review('r').off.length, 1);
  // Send this runner again: what was held goes out, and it is marked again (both too fast)
  const m = t.sends.length;
  const back = t.engine.resumeRunner('r', '118');
  assert.deepEqual([back.change.kind, back.change.text], ['resume', 'Sent again']);
  assert.deepEqual(t.sends.slice(m).filter((p) => p.bib === '118').map((p) => [p.splitName, p.reason]), [['5K', 'new']], 'the boards have her 4K as it is again; the 5K never went out');
  assert.deepEqual(t.engine.review('r').flags.map((x) => [x.bib, x.kind, x.passes.length]), [['118', 'fast', 2]]);
  assert.equal(t.engine.review('r').off, undefined);
  // Undo takes "Send this runner again" back; Undo of that sends again (a Redo)
  const u = t.engine.undo('r', { fix: back.change.fix, confirm: true });
  assert.equal(u.change.text, 'Undone: bib 118 is not sent again');
  assert.deepEqual(t.engine.runner('r', '118').columns.map((c) => c.held), [null, null, null, 'stopped', 'stopped', null]);
  const u2 = t.engine.undo('r', { fix: u.change.fix, confirm: true });
  assert.equal(u2.change.text, 'Done again: Sent again');
  assert.equal(t.engine.runner('r', '118').sending.off, null);
  // with nothing in question, Stop is for what comes after the runner's last pass: what went out stays
  const plain = t.engine.stopRunner('r', '105');
  assert.equal(plain.change.text, 'Not sent after 19:48.0');
  assert.deepEqual([plain.change.leftover, t.engine.runner('r', '105').columns.map((c) => c.held)], [[], [null, null, null, null, null, null]]);
});

test('9.24 Not a split for the first too-fast read only: the runner\'s next read takes its split, goes out, and is marked when it comes slow for the runner', () => {
  const s = fastRace();
  liveField(s, { own: FAST_OWN, upTo: 902.9 });
  const f = s.engine.review('r').flags[0];
  s.engine.movePass('r', '118', { tod: f.passTod, to: 'none', from: f.splitId });
  assert.deepEqual(s.engine.review('r').flags, []);
  // 5:20 after her 3K where her pace gives 4:15 (1.26 of it): it is "4K" now
  liveField(s, { own: { ...FAST_OWN, 118: [1054.4] }, after: 902.9, upTo: 1054.4 });
  assert.deepEqual(sentOf(s, 118).at(-1).slice(0, 2), ['4K', rt('17:34.4')]);
  const g = s.engine.review('r').flags[0];
  assert.deepEqual([g.bib, g.kind, g.suggest, g.splitName], ['118', 'fast', null, '4K']);
  assert.equal(g.text, 'Bib 118, 4K 17:34.4: 5:20.0 after 3K, where the leaders took 3:07. Slow for this runner, and it follows 15:02.9, which was not a split: is it 4K?');
  // a next read that fits her own pace is her split: no mark
  const t = fastRace();
  liveField(t, { own: FAST_OWN, upTo: 902.9 });
  const f2 = t.engine.review('r').flags[0];
  t.engine.movePass('r', '118', { tod: f2.passTod, to: 'none', from: f2.splitId });
  liveField(t, { own: { ...FAST_OWN, 118: [979.2] }, after: 902.9, upTo: 979.2 });
  assert.deepEqual([sentOf(t, 118).at(-1).slice(0, 2), t.engine.review('r').flags], [['4K', rt('16:19.2')], []]);
});

test('9.24 the clearing line: off unless the output has it on; then a split that was taken back goes out once more with an empty time and place, and the output\'s copy is forgotten', () => {
  const run = (outputs) => {
    const s = fastRace({ outputs });
    liveField(s, { own: FAST_OWN });
    s.clock.advance(70_000);
    const f = s.engine.review('r').flags.find((x) => x.bib === '118');
    const at = s.sends.length;
    const r = s.engine.movePass('r', '118', { tod: f.passTod, to: 'none', from: f.splitId, also: f.passes.slice(1).map((p) => p.passTod) });
    return { s, r, since: s.sends.slice(at).map((p, i) => [p, s.net.via[at + i]]) };
  };
  // off (the default): nothing new on the wire, and the boards still show the two times
  const off = run([{ id: 'o1', name: 'TrackScore', enabled: true, races: [] }, { id: 'o2', name: 'Karmarush', enabled: true, races: [] }]);
  assert.equal(off.since.filter(([p]) => p.reason === 'clear').length, 0);
  assert.deepEqual(off.r.change.cleared, { lines: 0, outputs: [] });
  assert.deepEqual(off.s.engine.runner('r', '118').columns[3].leftover.outputs, ['TrackScore', 'Karmarush']);
  // on for one output: it alone gets the two rows, empty, each in its column
  const on = run([{ id: 'o1', name: 'TrackScore', enabled: true, races: [] }, { id: 'o2', name: 'Board', enabled: true, races: [], clearLines: true }]);
  const clears = on.since.filter(([p]) => p.reason === 'clear');
  assert.deepEqual(clears.map(([p, o]) => [o, p.bib, p.splitName, p.lapsToGo, p.csTicks, p.lsTicks, p.place, p.clear]), [['o2', '118', '4K', 3, null, null, null, true], ['o2', '118', '5K', 2, null, null, null, true]]);
  const vars = packetVariables(clears[0][0], {});
  assert.deepEqual([vars.rows[0][0x01], vars.rows[0][0x03], vars.rows[0][0x08], vars.rows[0][0x09], vars.rows[0][0x0a]], ['', '118', '', '', '3']);
  assert.equal(packetProblem(clears[0][0], vars), null);
  assert.deepEqual(on.r.change.cleared, { lines: 2, outputs: ['Board'] });
  assert.deepEqual(on.s.engine.runner('r', '118').columns[3].leftover.outputs, ['TrackScore'], 'the board that took the line has the cell empty');
  // every other packet of the change is the same with it on or off
  const plain = (x) => x.since.filter(([p]) => p.reason !== 'clear').map(([p, o]) => [o, p.bib, p.splitName, p.place, p.reason].join('|'));
  assert.deepEqual(plain(on), plain(off));
  // Stop sending this runner clears what it takes back too
  const t = fastRace({ outputs: [{ id: 'o2', name: 'Board', enabled: true, races: [], clearLines: true }] });
  liveField(t, { own: FAST_OWN });
  t.clock.advance(70_000);
  const at = t.sends.length;
  const st = t.engine.stopRunner('r', '118');
  assert.deepEqual([st.change.cleared, t.sends.slice(at).filter((p) => p.reason === 'clear').map((p) => p.splitName)], [{ lines: 2, outputs: ['Board'] }, ['4K', '5K']]);
});

// ---- DESIGN 9.23 F22: two (or more) mats missed in a row are held before they go out -------------------------------------

test('9.23 F22 the column check by hand: a pass two or three splits on is held when the runner\'s first pass stays, plausible, and every pass is then at its level; never a walker, a pass that fits loosely, or a runner with nothing to stand on', () => {
  const n = 6;
  const L = [180, 360, 540, 720, 900, 1080].map((t) => t * S);
  // a field at the leaders' pace .. 1.2 x, every split read
  const fieldRunners = Array.from({ length: 21 }, (_, i) => {
    const real = L.map((t) => Math.round(t * (1 + 0.01 * i)));
    return { bib: String(i + 1), passes: real.map((t, col) => ({ t, col })), real, finish: null };
  });
  const one = (bib, ts, pin = () => ({})) => {
    const passes = ts.map((t, col) => ({ t: Math.round(t * S), col, ...pin(col) }));
    const real = new Array(n).fill(null);
    for (const p of passes) if (!p.manual) real[p.col] = p.t;
    return { bib, passes, real, finish: null };
  };
  const check = (r) => columnCheck({ n, runners: [...fieldRunners, r] }).suspects.get(r.bib) ?? null;
  const names = ['1K', '2K', '3K', '4K', '5K', '6K'];
  // a runner at 1.10 x whose 2K and 3K mats missed it: its 4K pass, 13:12.0, is counted in 2K. At 2K it is far beyond
  // the field (2.16 x the leaders'), at 3K too (1.44 x; the field ends at 1.2 x 1.15), at 4K it is where its 1K was
  const two = check(one('x', [198, 792]));
  assert.deepEqual([two.cols, two.method, two.moves.map((mv) => [mv.from, mv.to, mv.missed]), moveText(two.moves[0], names)],
    [[0, 3], 'course', [[1, 3, [1, 2]]], 'Looks like 4K, not 2K (missed 2K and 3K?)']);
  // three in a row: its 5K pass in 2K
  const three = check(one('x', [198, 990]));
  assert.deepEqual([three.cols, moveText(three.moves[0], names)], [[0, 4], 'Looks like 5K, not 2K (missed 2K, 3K and 4K?)']);
  // its next pass moves on with it
  const next = check(one('x', [198, 792, 990]));
  assert.deepEqual([next.cols, next.moves.map((mv) => moveText(mv, names))], [[0, 3, 4], ['Looks like 4K, not 2K (missed 2K and 3K?)', 'Looks like 5K, not 3K (it moves with the pass before it)']]);
  // one mat missed is what it was: one split on, clearly better than counting
  assert.deepEqual(check(one('x', [198, 594])).cols, [0, 2]);
  // the evidence. (1) every pass at the first one's level, within CHECK_RULES.farSpread (0.1): 14:20 would be 1.17 x at 4K
  // (0.08 from 1.08 x), 14:40 1.20 x (0.105): the first is held, the second is not (it fits nothing one split on either)
  assert.deepEqual(check(one('y', [198, 860])).cols, [0, 3]);
  assert.equal(check(one('y', [198, 880])), null);
  assert.equal(CHECK_RULES.farSpread, 0.1);
  // (2) the runner's first pass stays where it is: a walker at twice the leaders' time is not "missed 1K and 3K", and a
  // runner whose first pass is itself beyond the field has no level to compare with
  assert.equal(check(one('w', [360, 720])), null);
  assert.equal(check(one('w', [300, 1200])), null);
  // (3) a pass the operator kept where it is is not moved, and a split nobody has reached can't be given a pass
  assert.equal(check(one('k', [198, 792], (col) => (col === 1 ? { pinned: true } : {}))), null);
  const early = fieldRunners.map((r) => ({ ...r, passes: r.passes.slice(0, 3), real: [...r.real.slice(0, 3), null, null, null] }));
  assert.equal(columnCheck({ n, runners: [...early, one('g', [198, 792])] }).suspects.has('g'), false);
});

test('9.26 two mats close together, both missed: the placing further on wins over a poor one a split on, so the first held pass is not let go when the next one comes; a runner who slowed with every mat read is left alone', () => {
  // 1K, 2K, 3K, 4K, a mat 200 m after 4K, 5K, 6K: the leaders at 3:00 a kilometre
  const n = 7;
  const L = [180, 360, 540, 720, 756, 900, 1080].map((t) => t * S);
  const fieldRunners = Array.from({ length: 21 }, (_, i) => {
    const real = L.map((t) => Math.round(t * (1 + 0.01 * i)));
    return { bib: String(i + 1), passes: real.map((t, col) => ({ t, col })), real, finish: null };
  });
  const one = (bib, ts) => {
    const passes = ts.map((t, col) => ({ t: Math.round(t * S), col }));
    const real = new Array(n).fill(null);
    for (const p of passes) real[p.col] = p.t;
    return { bib, passes, real, finish: null };
  };
  const check = (r) => columnCheck({ n, runners: [...fieldRunners, r] }).suspects.get(r.bib) ?? null;
  // a runner at 1.03 x whose 4K and 4.2K mats both missed it. Its 5K pass, 15:27.0, is counted in 4K: held as 5K's
  const first = check(one('x', [185.4, 370.8, 556.2, 927]));
  assert.deepEqual([first.cols, first.moves.map((mv) => [mv.from, mv.to])], [[0, 1, 2, 5], [[3, 5]]]);
  // its 6K pass, 18:32.4, is counted in 4.2K. One split on (4.2K and 5K: 1.23 x and 1.24 x, both merely slow there) is
  // clearly better than counting and fits badly (spread 0.18); further on (5K and 6K) every pass is at 1.03 x. The
  // further placing is the one: both passes stay held, each for its own split. (Before 9.26: [0, 1, 2, 4, 5]; with a
  // real field the 5K pass stayed in 4K and went out there.)
  const both = check(one('x', [185.4, 370.8, 556.2, 927, 1112.4]));
  assert.deepEqual([both.cols, both.moves.map((mv) => [mv.from, mv.to])], [[0, 1, 2, 5, 6], [[3, 5], [4, 6]]]);
  assert.ok(both.best < 0.02);
  // one of the two missed is one split on, as before: 4.2K missed (the 5K pass in 4.2K), 4K missed (the 4.2K pass in 4K
  // fits 4K too, 4 % slow: nothing to say until the 5K pass comes, then both move on)
  assert.deepEqual(check(one('x', [185.4, 370.8, 556.2, 741.6, 927])).cols, [0, 1, 2, 3, 5]);
  assert.equal(check(one('x', [185.4, 370.8, 556.2, 778.7])), null);
  assert.deepEqual(check(one('x', [185.4, 370.8, 556.2, 778.7, 927])).cols, [0, 1, 2, 4, 5]);
  // a runner who slowed to 1.25 x after 3K, every mat read, is nobody's missed mats: nothing further on fits its level
  assert.equal(check(one('s', [185.4, 370.8, 556.2, 900, 945, 1125, 1350])), null);
  assert.equal(check(one('s', [185.4, 370.8, 556.2, 900, 945])), null);
});

test('9.23 F22 two mats missed in a row, live, both outputs: the pass is held when it arrives (nothing goes out a column early), the one click adds both, every line right; three in a row the same', () => {
  // bib 105 (1.10 x) misses 2K and 3K; bib 107 (1.14 x) misses 2K, 3K and 4K
  const own = { 105: [198, 792, 990, 1188], 107: [205.2, 1026, 1231.2] };
  const s = setup({ races: [lapRace({ splits: lapSplits(6) })], filter: { holdSec: 0 }, outputs: TWO_OUTPUTS });
  s.engine.on('send', (p) => assertSendable(p, s.config));
  const real = (bib, k) => Math.round(180 * k * (1 + 0.02 * (bib - 100)) * S);
  /** the splits TrackScore was sent for a bib, in order */
  const out1 = (bib) => s.sends.filter((p, i) => p.bib === String(bib) && s.net.via[i] === 'o1').map((p) => p.splitName);
  liveField(s, { own, upTo: 792 });
  // its 4K read arrives: held, not sent
  let rows = s.engine.review('r').checks.filter((c) => c.bib === '105');
  assert.deepEqual(rows.map((c) => [c.timeText, c.fromName, c.toName, c.reason.split(':')[0], c.missed?.names, c.missed?.sure !== false]),
    [['13:12.0', '2K', '4K', 'Looks like 4K, not 2K (missed 2K and 3K?)', ['2K', '3K'], false]]);
  assert.deepEqual(out1(105), ['1K']);
  assert.deepEqual(s.engine.runner('r', '105').columns.map((c) => [c.timeText, c.held]).slice(0, 3), [['3:18.0', null], ['13:12.0', 'check'], ['', null]]);
  // its 5K read: held with it, and the one click is sure: "Missed 2K and 3K: add them"
  liveField(s, { own, after: 792, upTo: 990 });
  rows = s.engine.review('r').checks.filter((c) => c.bib === '105');
  assert.deepEqual(rows.map((c) => [c.timeText, c.fromName, c.toName]), [['13:12.0', '2K', '4K'], ['16:30.0', '3K', '5K']]);
  assert.deepEqual([rows[0].missed.names, rows[0].missed.sure, rows[0].missed.ok, rows[0].missed.count], [['2K', '3K'], true, true, 2]);
  assert.deepEqual(out1(105), ['1K'], 'still nothing a column early');
  const at = s.sends.length;
  const r = s.engine.addMissed('r', '105', bodyOf(rows[0].missed));
  assert.match(r.change.text, /^Missed 2K and 3K added \(\d+:\d\d\.\d and \d+:\d\d\.\d, made up\); 13:12\.0 → 4K, 16:30\.0 → 5K$/);
  // both outputs: 2K and 3K made up between its 1K and its 4K, then 4K and 5K, each with its laps to go, the furthest last
  const lines = linesOf(s, at, 105);
  assert.deepEqual(lines.map((l) => [l[0], l[1], l[5]]), [['2K', 5, 'new'], ['3K', 4, 'new'], ['4K', 3, 'new'], ['5K', 2, 'new']]);
  assert.deepEqual([lines[2][2], lines[3][2]], [formatRaceTime(real(105, 4), 3), formatRaceTime(real(105, 5), 3)]);
  for (const [i, k] of [[0, 2], [1, 3]]) assert.ok(Math.abs(parseRaceTime(lines[i][2]) - real(105, k)) < 2 * S, `the made-up ${k}K is within 2 s of the real one (${lines[i][2]})`);
  assert.deepEqual(linesOf(s, at, 105, 'o2'), lines);
  sameOnBoth(s, at);
  // the rest of the race: its 6K goes out by itself; no line of the runner ever carried a time that is not that split's
  liveField(s, { own, after: 990 });
  s.clock.advance(70_000);
  const mine = s.sends.filter((p, i) => p.bib === '105' && s.net.via[i] === 'o1');
  assert.deepEqual([...new Set(mine.map((p) => p.splitName))], ['1K', '2K', '3K', '4K', '5K', '6K']);
  for (const p of mine) if (!['2K', '3K'].includes(p.splitName)) assert.equal(p.csTicks, real(105, p.splitIndex + 1), `${p.splitName} is its own time`);
  assert.deepEqual(s.engine.review('r').checks.filter((c) => c.bib === '105'), []);
  // three in a row (bib 107): held as its 5K read arrives, and after its 6K read the one click adds all three
  rows = s.engine.review('r').checks.filter((c) => c.bib === '107');
  assert.deepEqual(rows.map((c) => [c.fromName, c.toName]), [['2K', '5K'], ['3K', '6K']]);
  assert.equal(rows[0].reason.split(':')[0], 'Looks like 5K, not 2K (missed 2K, 3K and 4K?)');
  assert.deepEqual([rows[0].missed.names, rows[0].missed.sure], [['2K', '3K', '4K'], true]);
  assert.deepEqual(out1(107), ['1K']);
  const at2 = s.sends.length;
  s.engine.addMissed('r', '107', bodyOf(rows[0].missed));
  assert.deepEqual(linesOf(s, at2, 107).map((l) => [l[0], l[1]]), [['2K', 5], ['3K', 4], ['4K', 3], ['5K', 2], ['6K', 1]]);
  sameOnBoth(s, at2);
  assert.deepEqual(s.engine.runner('r', '107').columns.map((c) => c.kind), ['read', 'made-up', 'made-up', 'made-up', 'moved', 'moved']);
  // nobody else was ever held, and a rebuild and a restart agree
  assert.deepEqual(s.engine.review('r').checks, []);
  const snap = (e) => [e.crossings('r').map((x) => [x.bib, x.splitId, x.tod, x.place, x.held, x.source]), e.review('r').checks, e.review('r').flags];
  const now = snap(s.engine);
  assert.deepEqual(snap(s.restart().engine), now);
});
