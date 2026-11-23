// Review tools (DESIGN 9.17): the column check of counted passes, and made-up times for missed splits.
//
// A FinishLynx LapTime read says only "this bib crossed a mat at this time", so the engine counts a runner's passes
// into the splits in time order (DESIGN 9.15 L4). A runner who missed a mat therefore has every later pass one column
// too early. These pure functions look at the whole field to spot that, and to estimate a split a runner has no read
// for. They decide nothing on their own: the engine HOLDS a suspect pass (it is not sent) until the operator moves or
// keeps it, and a made-up time is only a suggestion until the operator sends it. Pure, so the same crossings always
// give the same answer: the engine's read-by-read derivation and a rebuild from scratch agree, and the check can be
// run on any set of runners (a FinishLynx .lif file, a test) without an engine.

import { formatRaceTime, TICKS_PER_SEC } from './timefmt.js';

/**
 * The numbers the check works with (DESIGN 9.17 P2). Frozen and exported so a test or a verifier can quote them.
 * - minComplete: field fractions need this many finishers with a pass at every split (a median of one or two runners
 *   is that runner's pacing, not the course's).
 * - leaders: the leader reference at a split is the median race time of the first this-many runners counted there.
 * - tailGap: a ratio above the field's highest plausible ratio at a split x this is implausible there.
 * - floor: a ratio below this (faster than the leaders' reference) is implausible.
 * - legMargin: a finisher is suspect only when counting costs more than the best placing by this share of the
 *   shortest leg (the field's), so pacing alone never moves a pass: a wrong column is off by a whole leg.
 * - spreadMargin: on course, counting is "clearly worse" when its spread of log ratios exceeds the best's by this.
 * - spreadSlack: an implausible counting gives way to a plausible placing that is at most this much less even.
 * - singleGap: a runner with only one pass so far has no evenness to compare: that pass is doubted only when it is
 *   beyond the field's highest plausible ratio x tailGap x singleGap, and fits the next split's field. Revision 10:
 *   1 (it was 1.5). A lone pass that fits the next split's leaders no longer counts as the back of the field (see
 *   loneAmbiguity), so "the field" is the runners that can only be at that split, and a pass beyond its plausible
 *   end that fits the next split is the next split's: measured on the 10 real FinishLynx races (DESIGN 9.18).
 * - nearest: made-up times are placed like the runners nearest in pace, this many at most.
 * - shapeMargin (9.23 F18): a runner whose legs from pass to pass fit the course as counted (legShape: every leg within
 *   FIT_RULES.shortBelow and longAbove of the runners of the same pace) is not held when they fit it this much better
 *   (the mean |log ratio| of a leg) than the better placing does: a late start, not a missed mat. Measured on the real
 *   race (every complete runner 1 to 15 minutes late, and every real missed first mat, two and three in a row from it
 *   and with a second mat apart) and on synthetic courses (DESIGN 9.23 F18).
 * - shapeLegs (9.23 F18): ... and with at least this many legs: a few legs compared as shares of their stretch are a
 *   number or two, which passes a column early can match by chance (synthetic 5K and 8K courses of three splits, the
 *   first two mats missed and a cool-down pass counted in a split; a synthetic 7-split course, 0.8K, 1.5K and 4.2K missed
 *   and no finish line: four passes counted in 0.8K to 3.1K, three legs, as close to the course as a late start's)
 * - shapeWithin (9.23 F18): ... and as closely as a late start does, a leg off by this much at most on average (the mean
 *   |log ratio|): every complete runner of the real race fits within 0.06 as counted but one walker, 0.17 (its last leg
 *   1.59 times the runners'); every runner who missed 800m there, 0.73 or more (its 200 m leg counted as 1100 m)
 * - shapeClose, shapeCloseLeg, shapePlacings (9.23 F19): with fewer than shapeLegs legs (on the course, before the last
 *   split), a late start only when the legs fit this closely on average and each within this factor, the check's placing
 *   moves the first pass, and no other placing of the same passes (when there are at most shapePlacings of them) fits
 *   within shapeMargin of it: every complete runner of the real race fits its first two, three and four legs within 0.04
 *   (each leg within 1.07), synthetic ones within 0.05 (1.10); the first two mats missed fit as counted within 0.05 on a
 *   synthetic 7-split course, but the right placing fits better
 * - shapeGap (9.23 F19): a split skipped between two passes (a mat missed) costs this much when placings of the same
 *   passes are compared by their legs (closeFit; the engine's one click that moves a runner's first pass): legShape
 *   compares a runner with the runners whose time over the same stretch is nearest, so a placing that skips every other
 *   split fits nearly as well as one that skips none (a 4-minute late starter's first three passes as 800m, 2400m and
 *   4200m, within 0.14 of the course as counted)
 * - lateMax (9.23 F19): a late start explains no first pass that would have needed a start this long after the gun even
 *   at the pace of the back of the field at its split (race ticks: 12 minutes; the synthetic late starters started 2 to 8
 *   minutes late, and a walker of the real race six minutes late who also missed 800m needed 8:56: with 8 minutes its
 *   sure one click on the course was "Missed 800m, 1500m and 2400m", wrong, for three minutes; a synthetic 8K's 5K pass
 *   counted in 1 mile would have needed 9 to 16, offered under 12 until the runner's third pass)
 * - legFloor (9.23 F19): on the course, a placing that moves the first pass on may not make the runner's first leg faster
 *   than this times the leaders' over the same splits (the median of the field's five fastest there): a late start makes
 *   nobody faster (a runner three minutes late, its 800m to 1500m in 2:20, counted as 1500m to 2400m where the leaders took
 *   2:47). Below the leaders' floor (0.97) for a leg: one read's jitter is a larger share of it
 * - strayLeg (9.23 F20): a leg between two passes counted in splits next to each other that is shorter than this times
 *   the leaders' over that stretch is no split: one of the two is a stray pass (a runner who stopped on a mat, a backup
 *   mat far from the primary), and a count of passes it fills is no proof that every mat read the runner. The real race's
 *   fastest legs are within 0.92 of the leaders' on every stretch; a stray read 30 to 90 s after a pass, beyond the tag
 *   window, is 0.24 to 0.72 of them on its stretch (0.71 at most: 90 s on the 700 m from 2400m to 3100m)
 * - strayOwn (9.23 F20): with a pass in every split, a leg between splits next to each other shorter than this times the
 *   runner's own pace (the median of its other legs over the leaders', a long one left out: ownShort) is a stray's too.
 *   A stray soon after the 4400m pass, 4200m missed, takes as long from that pass as a real 200 m leg, and leaves the 900 m
 *   on to 5300m short by what it came after: 60 s is 0.64 to 1.27 of the leaders' there, under the strayLeg for 52 of the
 *   real race's 167, under 0.8 of the runner's own pace for 163. The real race's legs are 0.86 of the runner's own pace at
 *   least; a late start changes no leg from pass to pass
 * - slowLeg (9.23 F20): what one slow leg costs (a stop, a fall, every mat read) when it is weighed against a placing of
 *   missed mats by the legs from pass to pass (legShape, the leg left out): with it the passes as read are the runner's
 *   when their other legs fit closely and no worse than the missed mats do (the column check does not hold them), and a
 *   one click is sure only when its placing fits better than the slow leg by shapeMargin. Measured on the real race: one
 *   slow leg of 1 to 4 minutes on any stretch, every mat read, fits 0.17 to 2.2 better than the best placing of missed
 *   mats; a real missed mat 0.11 worse to 3.5 better (4400m missed, its 5300m pass 4.8 times the runners' 200 m leg as a
 *   slow leg, is the closest)
 * - slowLost (9.23 F20): a slow leg loses at most this much (race ticks: 5 minutes; a stop or a fall costs a runner a
 *   minute or a few, the re-check's slow legs 1 to 4 minutes): a pass later than that after the runners of its pace is
 *   no slow leg's (586 after "Missed 3100m": its 5300m pass in 4400m, 5:18 after the runners' 4400m)
 * - farSpread (9.23 F22): on the course a pass may be placed two or more splits further than counting puts it (two mats
 *   missed in a row) only when nothing one split on is clearly better, the runner's first pass stays where it is,
 *   plausible there, and with the later passes moved on the log ratios of all of the runner's passes to the leaders
 *   spread no more than this: every pass at the first one's level. As spreadMargin, which is how much more even than
 *   counting a placing one split on must be; here it is a bound on the placing itself. On the IvyXC Women's 6K replay
 *   (a mid-pack runner's 2K and 2.6K reads dropped, and another's 2K, 2.6K and 3.4K) the right placings spread 0.05 and
 *   0.03; the three real meet days hold nobody new with it
 */
export const CHECK_RULES = Object.freeze({
  minComplete: 3,
  leaders: 5,
  tailGap: 1.15,
  floor: 0.97,
  legMargin: 0.25,
  spreadMargin: 0.1,
  spreadSlack: 0.02,
  singleGap: 1,
  nearest: 30,
  shapeMargin: 0.15,
  shapeLegs: 4,
  shapeWithin: 0.2,
  shapeClose: 0.06,
  shapeCloseLeg: 1.15,
  shapePlacings: 500,
  shapeGap: 0.05,
  lateMax: 12 * 60 * 10000,
  legFloor: 0.9,
  strayLeg: 0.75,
  strayOwn: 0.8,
  slowLeg: 0.15,
  slowLost: 5 * 60 * 10000,
  leaderFloor: 0.6,
  farSpread: 0.1,
});

/**
 * @typedef {object} CheckPass  one of a runner's kept crossings that counting placed (or the operator fixed)
 * @property {number} t race ticks
 * @property {number} col the column it is in now, 0-based split index
 * @property {boolean} [pinned] fixed: the operator moved or kept it, or it replaced a made-up time (never moved)
 * @property {boolean} [manual] a made-up time: fixed, and no evidence (neither its ratio nor its cost counts)
 *
 * @typedef {object} CheckRunner
 * @property {string} bib
 * @property {CheckPass[]} passes kept pass crossings and made-up times, in course order (columns going up)
 * @property {(number|null)[]} real race ticks of the runner's kept REAL crossing in each column (passes and timing
 *   points alike), null where there is none: what the field references are made of
 * @property {boolean} [located] the runner has a crossing from a named timing point: its columns are known, so it is
 *   evidence for the field but never checked itself
 * @property {number|null} finish the runner's finish race ticks, or null while on the course
 * @property {number|null} [afterLast] 9.23 F13: race ticks of the runner's first pass after its real last split (the
 *   stream's finish pass, when the RR12 exporter sends the finish line too), or null
 *
 * @typedef {{ i: number, t: number, from: number, to: number, missed: number[], withPrevious: boolean }} CheckMove
 *   pass i (index into passes) at race time t would move from column `from` to column `to` (n: the finish, 9.23 F13);
 *   `missed` = the columns the better placing leaves empty just before `to` (the mats the runner most likely missed);
 *   withPrevious: it only moves because the pass before it does (no mat missed in between)
 * @typedef {{ bib: string, method: 'finish'|'course', cols: number[], moves: CheckMove[], positional: number,
 *   best: number, lone?: boolean }} Suspect  cols: the better column of every pass; positional / best: the costs
 *   (finish method, ticks) or spreads (course method, log ratio) of counting and of the better placing; lone: the
 *   runner's only pass so far (revision 10), which the runner's next pass settles
 */

const sortNum = (a, b) => a - b;

/** Median of a sorted, non-empty list (the mean of the middle two for an even count). */
function median(sorted) {
  const n = sorted.length;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Where the field crosses each split as a share of its own finish time (XC-Analytics' matFractions): the median of
 * t_k / finish over the finishers with a real crossing at every split. Mats sit wherever the course allowed (1 mile,
 * 5K and 6.3K of an 8K are crossed at about 0.20, 0.63 and 0.79), so this, not an even spacing, says where a read
 * belongs. Null with fewer than CHECK_RULES.minComplete such finishers.
 * @param {CheckRunner[]} runners
 * @param {number} n split count
 * @returns {number[] | null}
 */
export function fieldFractions(runners, n) {
  if (!(n > 0)) return null;
  const cols = Array.from({ length: n }, () => []);
  let count = 0;
  for (const r of runners) {
    const f = r.finish;
    if (!isTime(f) || f <= 0) continue;
    let ok = true;
    let prev = 0;
    for (let k = 0; k < n && ok; k++) {
      const t = r.real?.[k];
      ok = isTime(t) && t > prev && t < f;
      prev = t;
    }
    if (!ok) continue;
    count++;
    for (let k = 0; k < n; k++) cols[k].push(r.real[k] / f);
  }
  if (count < CHECK_RULES.minComplete) return null;
  return cols.map((v) => median(v.sort(sortNum)));
}

/**
 * The leaders' reference at each split: the median race time of the first CHECK_RULES.leaders runners counted there
 * (null where nobody has been counted yet: a split nobody has reached can't be given a pass). The median of five, not
 * the first runner: a leader who broke away, or a stray early read, must not make everybody look slow.
 * @param {CheckRunner[]} runners
 * @param {number} n
 * @returns {(number|null)[]}
 */
export function leaderTimes(runners, n) {
  const best = Array.from({ length: n }, () => []);
  const keep = CHECK_RULES.leaders;
  for (const r of runners) {
    for (let k = 0; k < n; k++) {
      const t = r.real?.[k];
      if (!isTime(t) || t <= 0) continue;
      const b = best[k];
      if (b.length < keep) {
        b.push(t);
        b.sort(sortNum);
      } else if (t < b[keep - 1]) {
        b[keep - 1] = t;
        b.sort(sortNum);
      }
    }
  }
  return best.map((b) => (b.length ? median(b) : null));
}

/**
 * The columns a pass may take (DESIGN 9.15 L4 earliest times, which an alternative placing must respect as counting
 * does): at least the highest split whose earliest time it has reached ("a pass at or after that time is at least
 * that split"), and never a split whose earliest time is still ahead of it ("too early").
 * @param {number} t
 * @param {(number|null)[]} earliest
 * @param {number} n
 */
function columnRange(t, earliest, n) {
  let lo = 0;
  for (let c = n - 1; c > 0; c--) {
    const e = earliest?.[c];
    if (isTime(e) && e <= t) {
      lo = c;
      break;
    }
  }
  return { lo, ok: (c) => c >= lo && !(isTime(earliest?.[c]) && t < earliest[c]) };
}

/**
 * The placing of a finisher's passes, order kept, that minimises the total distance from where the field crosses the
 * splits (fractions x this runner's finish): XC-Analytics' alignCum. A dynamic programme over (pass, column), O(m*n).
 * Exact ties leave a gap as late as possible.
 * @returns {{ cols: number[], total: number } | null} null when no placing is allowed at all
 */
function bestByCost(m, n, allowed, cost) {
  const INF = Infinity;
  const dp = Array.from({ length: m }, () => new Array(n).fill(INF));
  const from = Array.from({ length: m }, () => new Array(n).fill(-1));
  for (let i = 0; i < m; i++) {
    let bestPrev = INF;
    let bestAt = -1;
    for (let c = 0; c < n; c++) {
      // the best placing of the earlier passes ending before column c (the smallest column on a tie)
      if (i > 0 && c > 0 && dp[i - 1][c - 1] < bestPrev) {
        bestPrev = dp[i - 1][c - 1];
        bestAt = c - 1;
      }
      if (!allowed(i, c)) continue;
      const base = i === 0 ? 0 : bestPrev;
      if (base === INF) continue;
      dp[i][c] = base + cost(i, c);
      from[i][c] = bestAt;
    }
  }
  let total = INF;
  let end = -1;
  for (let c = 0; c < n; c++) {
    if (dp[m - 1][c] < total) {
      total = dp[m - 1][c];
      end = c;
    }
  }
  if (end < 0) return null;
  const cols = new Array(m);
  for (let i = m - 1, c = end; i >= 0; i--) {
    cols[i] = c;
    c = from[i][c];
  }
  return { cols, total };
}

/**
 * The placing, order kept, whose log ratios to the leaders spread least (max - min), among the allowed cells. A runner
 * keeps roughly the same pace relative to the leaders split after split, so a missed mat shows as a jump of a whole
 * leg (2K / 1K = twice the time) that the right placing does not have. Min-max programmes over every possible lowest
 * value: O(m^2 n^2), run only for the few runners the quick tests leave.
 * @param {number} m
 * @param {number} n
 * @param {(i: number, c: number) => boolean} allowed
 * @param {(i: number, c: number) => number | null} value log ratio, or null for a made-up time (no evidence)
 * @returns {{ cols: number[], spread: number } | null}
 */
function bestBySpread(m, n, allowedFn, valueFn, slack = CHECK_RULES.spreadSlack) {
  // worked out once: the programmes below visit every cell once per candidate lowest value
  const A = Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, c) => allowedFn(i, c)));
  const V = Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, c) => (A[i][c] ? valueFn(i, c) : null)));
  const allowed = (i, c) => A[i][c];
  const value = (i, c) => V[i][c];
  const los = new Set();
  for (let i = 0; i < m; i++) for (let c = 0; c < n; c++) if (A[i][c] && V[i][c] !== null) los.add(V[i][c]);
  const tryLo = (lo, keep) => {
    const dp = Array.from({ length: m }, () => new Array(n).fill(Infinity));
    const from = keep ? Array.from({ length: m }, () => new Array(n).fill(-1)) : null;
    for (let i = 0; i < m; i++) {
      let bestPrev = Infinity;
      let bestAt = -1;
      for (let c = 0; c < n; c++) {
        if (i > 0 && c > 0 && dp[i - 1][c - 1] < bestPrev) {
          bestPrev = dp[i - 1][c - 1];
          bestAt = c - 1;
        }
        if (!allowed(i, c)) continue;
        const v = value(i, c);
        if (v !== null && v < lo) continue;
        const base = i === 0 ? -Infinity : bestPrev;
        if (base === Infinity) continue;
        dp[i][c] = Math.max(base, v === null ? -Infinity : v);
        if (from) from[i][c] = bestAt;
      }
    }
    let hi = Infinity;
    let end = -1;
    for (let c = 0; c < n; c++) {
      if (dp[m - 1][c] < hi) {
        hi = dp[m - 1][c];
        end = c;
      }
    }
    return { hi, end, from };
  };
  const lows = [...los].sort(sortNum);
  let least = Infinity;
  for (const lo of lows) {
    const r = tryLo(lo, false);
    if (r.end < 0) continue;
    least = Math.min(least, r.hi === -Infinity ? 0 : r.hi - lo);
  }
  if (least === Infinity) {
    if (los.size) return null;
    // only made-up times are free to choose (nothing to spread): the earliest allowed placing
    const r = tryLo(-Infinity, true);
    return r.end < 0 ? null : { cols: trace(r, m), spread: 0 };
  }
  // Of the placings about as even as the most even one (within `slack`), the one that moves the passes least: one
  // missed mat is likelier than two, and near the front of the race (a split only a few have reached) a runner who is
  // slowly fading looks a hair more even one column too far on.
  const window = least + slack;
  let best = null;
  for (const lo of lows) {
    const cols = earliestWithin(m, n, allowed, value, lo, lo + window);
    if (cols && (!best || lexLess(cols, best))) best = cols;
  }
  if (!best) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < m; i++) {
    const v = value(i, best[i]);
    if (v === null) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { cols: best, spread: hi === -Infinity ? 0 : hi - lo };
}

/**
 * The placing with the smallest columns (pass by pass) whose values all lie in [lo, hi], or null: a backward pass
 * finds which cells can still be completed, a forward pass takes the first such cell for each pass.
 */
function earliestWithin(m, n, allowed, value, lo, hi) {
  const ok = (i, c) => {
    if (!allowed(i, c)) return false;
    const v = value(i, c);
    return v === null || (v >= lo - 1e-12 && v <= hi + 1e-12);
  };
  const can = Array.from({ length: m }, () => new Array(n).fill(false));
  for (let c = 0; c < n; c++) can[m - 1][c] = ok(m - 1, c);
  for (let i = m - 2; i >= 0; i--) {
    // later: the next pass can still be placed in a column after c
    let later = false;
    for (let c = n - 1; c >= 0; c--) {
      can[i][c] = later && ok(i, c);
      if (can[i + 1][c]) later = true;
    }
  }
  const cols = new Array(m);
  let prev = -1;
  for (let i = 0; i < m; i++) {
    let c = prev + 1;
    while (c < n && !can[i][c]) c++;
    if (c >= n) return null;
    cols[i] = c;
    prev = c;
  }
  return cols;
}

/** Whether column list a comes before b: the first column that differs is smaller. */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function trace({ end, from }, m) {
  const cols = new Array(m);
  for (let i = m - 1, c = end; i >= 0; i--) {
    cols[i] = c;
    c = from[i][c];
  }
  return cols;
}

/**
 * Revision 10: the column of a runner's lone pass when it fits the next column's leaders too (it is at least floor x
 * their reference time), else -1. A lone pass is a runner's only pass so far, counted, not fixed by the operator or a
 * made-up time. Such a pass is either a slow runner at column c or a runner at column c + 1 whose mat at c missed
 * them: one pass can't tell, so it is no evidence for where column c's field ends.
 * @param {CheckPass[]} passes
 * @param {(number|null)[]} leaders
 * @param {number} n
 */
function loneAmbiguity(passes, leaders, n) {
  if (!Array.isArray(passes) || passes.length !== 1) return -1;
  const p = passes[0];
  if (p.manual || p.pinned) return -1;
  const next = leaders[p.col + 1];
  if (p.col + 1 >= n || !isTime(next) || !(next > 0)) return -1;
  return p.t >= CHECK_RULES.floor * next ? p.col : -1;
}

/** The columns a better placing leaves empty just before each moved pass: "missed 1K?". */
function movesOf(passes, cols) {
  const moves = [];
  for (let i = 0; i < passes.length; i++) {
    if (passes[i].manual || cols[i] === passes[i].col) continue;
    const missed = [];
    const prev = i > 0 ? cols[i - 1] : -1;
    for (let c = prev + 1; c < cols[i]; c++) missed.push(c);
    const withPrevious = !missed.length && i > 0 && cols[i - 1] !== passes[i - 1].col;
    moves.push({ i, t: passes[i].t, from: passes[i].col, to: cols[i], missed, withPrevious });
  }
  return moves;
}

/**
 * DESIGN 9.17 P2, the column check: which runners' counted passes clearly belong to other columns because a mat
 * missed them. Counting stays the default; a runner is SUSPECT only when counting is implausible, or clearly worse
 * than the best other placing, and never with a crossing in every column, unless (9.23 F13) the RR12 stream carries
 * finish passes and the last column holds a counted pass: the finish is then column n (finishColumn), for that pass
 * only, so a finish pass counted as the last split is placed at the finish and the runner's passes before it where
 * they belong (a move to n: "Looks like the finish, not 5300m").
 *
 * - Finishers (finish known, field fractions known): XC-Analytics' method. The passes (order kept) go on the columns
 *   that minimise the sum of |t - fraction x finish|; suspect when counting costs more than legMargin x the shortest
 *   leg more than that (ties keep counting).
 * - Runners on the course (or no field fractions yet): each pass is compared with the leaders' reference at its
 *   column (ratio = t / leaders' median). A placing is implausible when a ratio is below `floor` or above the field's
 *   highest ratio at that column x `tailGap`, where the field's highest ratio is the end of the unbroken run of ratios
 *   from the leaders back (each within tailGap of the one before), over the runners whose counted passes are all
 *   plausible (worked out until nothing changes: removing a runner can only shorten a run). Of the plausible placings
 *   the one with the smallest spread of log ratios is the best (of those about as even, the one that moves the passes
 *   least), saying at most one more missed mat than counting does (9.23 F22: more, when nothing one split on is clearly
 *   better, the runner's first pass stays where it is, plausible, and every pass is then at that pass's level, within
 *   spreadMargin: two mats missed in a row). Suspect when counting is implausible and the best
 *   is at least as even (within spreadSlack), or when counting's spread exceeds the best's by spreadMargin. A single
 *   pass is doubted only beyond the field x tailGap x singleGap, and a lone pass that fits the next split's leaders is
 *   not part of "the field" (revision 10: it may be that split's pass). A split that nobody has reached yet can't be
 *   given a pass, and a runner the operator placed a pass of is judged on evenness only.
 * - Both: earliest times are respected as counting respects them, and pinned passes and made-up times stay put.
 * - Both (9.23 F18): a runner whose legs from pass to pass fit the course as counted, clearly better than as the better
 *   placing puts them (legShape, CHECK_RULES.shapeMargin), started late: it is not suspect (`late`). The leaders'
 *   references and the field fractions measure every pass from the gun, so a runner who started minutes after it has
 *   every pass late by those minutes and looked like a runner a mat missed at the first split, every pass a split on.
 *
 * - Both (9.23 F19): a runner with a pass in every column, whose finish is known and whose first pass after its last
 *   split is that finish (its finish read, within `near` of it), is complete: its last pass is no finish pass, and it is
 *   never suspect (completeAt; still noted as a late starter). A late starter who also lost minutes on one leg, every mat
 *   read, had every pass held once FinishLynx's finish was known, and the sure one click "Missed 800m" (that leg fitted the
 *   course as counted nowhere near a late start's). 9.23 F20: not with two passes closer than anybody covers their stretch
 *   (strayIn): a stray pass made up for a missed mat in the count.
 * - Both (9.23 F20): a runner whose legs as counted fit closely with one slow leg left out, a pass after it in, and no
 *   worse than the better placing does (a slow leg costing CHECK_RULES.slowLeg), lost time on that leg: it is not suspect
 *   (`slow`, the split it came late to and how much it lost).
 *
 * @param {{ n: number, runners: CheckRunner[], earliest?: (number|null)[], near?: number }} args earliest: race ticks per
 *   split (the race's earliest times, null for none); a CheckRunner's `afterLast` (9.23 F13): its first pass after its
 *   real last split, for the finish column; near (9.23 F19): a pass this close to the runner's known finish is its finish
 *   read
 * @returns {{ suspects: Map<string, Suspect>, fractions: number[]|null, leaders: (number|null)[],
 *   tails: (number|null)[], late: Map<string, { late: number }>, slow: Map<string, { col: number, lost: number }> }}
 *   leaders and tails have the finish at n when it is a column; late (9.23 F18): the runners the check would have held but
 *   whose legs fit the course as counted, with how long after the gun they started by the runners of the same pace; slow
 *   (9.23 F20): the runners it would have held but whose legs fit as counted with one slow leg left out
 */
export function columnCheck({ n, runners, earliest = [], near = 0 }) {
  const suspects = new Map();
  const late = new Map();
  const slow = new Map();
  const field = checkField({ n, runners, earliest, near });
  if (!field) return { suspects, fractions: null, leaders: [], tails: [], late, slow, field: null };
  field.list.forEach((r, idx) => {
    if (!field.candidate[idx]) return;
    const got = checkOne(field, r);
    if (got?.suspect) suspects.set(r.bib, got.suspect);
    else if (got?.late) late.set(r.bib, got.late);
    else if (got?.slow) slow.set(r.bib, got.slow);
  });
  return { suspects, fractions: field.fractions, leaders: field.leaders, tails: field.tails, late, slow, field };
}

/**
 * The field the column check judges a runner against (columnCheck): the field fractions, the leaders' references, the
 * finish column, who can be suspect at all, and the field's tails. 9.23 F18: made once per race state, so that a
 * runner as a change would leave it (a Move, "Missed …: add it") can be judged by the same rules (checkOne) for the
 * change's preview, without the whole check again for every choice.
 * @param {{ n: number, runners: CheckRunner[], earliest?: (number|null)[], near?: number }} args
 * @returns {object|null} null with fewer than two splits or no runners
 */
export function checkField({ n, runners, earliest = [], near = 0 }) {
  const list = Array.isArray(runners) ? runners : [];
  if (!(n > 1) || !list.length) return null;
  const R = CHECK_RULES;
  const fractions = fieldFractions(list, n);
  const leaders = leaderTimes(list, n);
  // 9.23 F13: the finish as a column (n). When the RR12 stream carries finish passes, a runner's last column may hold
  // the finish pass, counted as the last split because a mat missed them earlier: every column full, the runner was
  // never looked at again (on 2026-10-27's replay the finish pass let seven held runners go out a column early; a
  // cool-down pass after it changes nothing). The last pass of such a runner (counted in the last column) may be
  // placed at the finish: column n, with the field's finish passes (or FinishLynx's finishes) as its leaders' reference
  // and its tail, and 1 as its field fraction. A runner whose splits are right is placed as counted, as before; a
  // stream of splits only changes nothing.
  const fin = finishColumn(list, n);
  if (fin) leaders[n] = fin.leader;
  // Who can be suspect at all: a runner made of counted passes, with a column still empty (or a finish pass in the last).
  const candidate = list.map((r) => candidateOf(r, n, fin));
  const ratio = (t, c) => (isTime(leaders[c]) && leaders[c] > 0 ? t / leaders[c] : null);
  // Revision 10: a LONE pass (a runner with one pass so far, nothing fixed) at column c that also fits the next
  // column's leaders (not faster than floor x their reference) may be the next split's pass of a runner a mat missed.
  // It is no evidence of where column c's field ends: otherwise the runners who missed the first mat, whose passes are
  // all counted there, chain each other into "the back of the field" and none of them is ever doubted.
  const ambiguousAt = list.map((r, idx) => (candidate[idx] ? loneAmbiguity(r.passes, leaders, n) : -1));

  // The field's highest plausible ratio per column (see above): ratios per column, slowest last (and the finish's).
  const entries = Array.from({ length: fin ? n + 1 : n }, () => []);
  list.forEach((r, idx) => {
    for (let c = 0; c < n; c++) {
      if (ambiguousAt[idx] === c) continue;
      const t = r.real?.[c];
      const x = isTime(t) ? ratio(t, c) : null;
      if (x !== null) entries[c].push({ x, idx });
    }
    const f = fin?.refs[idx];
    if (isTime(f)) entries[n].push({ x: ratio(f, n), idx });
  });
  for (const e of entries) e.sort((a, b) => a.x - b.x || a.idx - b.idx);
  // The run starts at the leaders' reference itself (ratio 1): a lone runner far ahead of the leaders' median (a
  // breakaway, a stray read) must not end the run before the field even starts.
  const tailsOf = (untrusted) => entries.map((e) => {
    let u = null;
    for (const { x, idx } of e) {
      if (untrusted.has(idx)) continue;
      if (x <= Math.max(u ?? 1, 1) * R.tailGap) u = Math.max(u ?? x, x);
      else break;
    }
    return u;
  });
  const plausibleAt = (tails, t, c) => {
    const x = ratio(t, c);
    return x !== null && tails[c] !== null && x >= R.floor && x <= tails[c] * R.tailGap;
  };
  const positionalPlausible = (tails, r) => r.passes.every((p) => p.manual || p.pinned || plausibleAt(tails, p.t, p.col));
  let untrusted = new Set();
  let tails = tailsOf(untrusted);
  for (let round = 0; round < 12; round++) {
    const next = new Set();
    list.forEach((r, idx) => {
      if (candidate[idx] && !positionalPlausible(tails, r)) next.add(idx);
    });
    if (next.size === untrusted.size && [...next].every((i) => untrusted.has(i))) break;
    untrusted = next;
    tails = tailsOf(untrusted);
  }

  // the shortest leg of the field, as a share of the finish: gun to the first split, between splits, last to finish
  let minLeg = Infinity;
  if (fractions) {
    let prev = 0;
    for (const f of [...fractions, 1]) {
      minLeg = Math.min(minLeg, f - prev);
      prev = f;
    }
  }

  // 9.23 F18: the other runners as legShape compares a runner's legs with theirs: their real crossings, and at the finish
  // (n) theirs as the finish column takes it (FinishLynx's, a finish read, else the stream's finish pass)
  const refAt = (x, c) => (c < n ? x.r.real?.[c] ?? null : isTime(x.r.finish) && x.r.finish > 0 ? x.r.finish : fin?.refs[x.idx] ?? null);
  const shapeRefs = list.map((r, idx) => ({ r, idx, bib: r.bib }));
  // (9.23 F18: the race's latest pass, and for each split twice the field's median leg to the next one: a runner whose
  // passes stop before the last split for longer than that has dropped out or had mats miss it, no late start)
  let now = -Infinity;
  for (const r of list) {
    for (const p of r.passes ?? []) if (isTime(p.t) && p.t > now) now = p.t;
    if (isTime(r.afterLast) && r.afterLast > now) now = r.afterLast;
  }
  const legWait = Array.from({ length: n - 1 }, (_, c) => {
    const l = list.map((r) => (isTime(r.real?.[c]) && isTime(r.real?.[c + 1]) ? r.real[c + 1] - r.real[c] : null)).filter(isTime).sort(sortNum);
    return l.length ? 2 * median(l) : null;
  });
  return { n, list, earliest, near, fractions, leaders, fin, candidate, tails, ratio, plausibleAt, positionalPlausible, minLeg, refAt, shapeRefs, now, legWait };
}

/**
 * 9.23 F21: the leaders' leg of a stretch from its legs (sorted, fastest first): the median of the CHECK_RULES.leaders
 * fastest of those no shorter than CHECK_RULES.leaderFloor times the stretch's median leg (five left at least). A leg far
 * ahead of the whole field is a stray pass's, not a leader's: a read 30 s after a runner's 2400m pass, counted in 3100m,
 * is a 0:30 "leg" on the 700 m to 3100m. On the re-check of 2026-10-31, a field with four of those (the runner's own among
 * them) had 1:15 as the leaders' leg there, where the real leaders took 2:15: a stray 1:15 after a 3100m pass looked a
 * real leg, and the runner's real 3100m pass was set aside as the stray; and four strays 53 to 57 s after the 4400m pass
 * in one race (mine, multistray) were the "leaders" on the 900 m to 5300m. The real race's fastest leg on every stretch
 * is 0.88 of its median or more, the synthetic courses' 0.65 (2,100 stretches): nothing changes for them; a winner far
 * ahead of the second is a leader still. Strays are a runner's at a time: CHECK_RULES.leaders legs or more that far ahead
 * are a group that ran it so, the leaders' leg as before: runners a mat (or the same mats) missed, whose counted legs
 * are another stretch's (twenty runners without 800m and 1500m: their real 200 m from 4200m to 4400m counted on the 900 m
 * from 1500m to 2400m). Left out, each of them was "a stray pass", its row "16:33.2 comes soon after 1500m for 2400m (0:55;
 * runners of the same pace took 0:57)" with Not a split for a real pass; three of a field where twenty-one missed
 * 800m, 1500m and 2400m lost their one click.
 * @param {number[]} legs
 * @returns {number|null}
 */
function leadersLeg(legs) {
  if (legs.length < CHECK_RULES.leaders) return null;
  const floor = CHECK_RULES.leaderFloor * median(legs);
  let i = 0;
  while (i + CHECK_RULES.leaders < legs.length && legs[i] < floor) i++;
  if (i >= CHECK_RULES.leaders) i = 0;
  return median(legs.slice(i, i + CHECK_RULES.leaders));
}

/**
 * 9.23 F19: the leaders' leg from column a to column b (b < n): the median of the CHECK_RULES.leaders fastest times from a
 * to b among the field's runners with a crossing at both; null with fewer, or b the finish. Worked out once per field.
 * 9.23 F21: `stray`, for what is shorter than anybody covers (strayLegs, strayLegAt): leadersLeg, a stray's leg left out.
 * Not for the column check's own measures (its first leg against the leaders', legFloor; the wide rule): a field's counted
 * legs there include missed mats' (a 1 km leg counted on 1.5 km), which F19 and F20 weighed as they are; with the floor a
 * synthetic runner who missed 1.5K and 2.5K was no longer held, its 4K pass and finish read out as 1.5K and 2.5K.
 */
function leaderLeg(field, a, b, { stray = false } = {}) {
  if (!(a >= 0 && a < b && b < field.n)) return null;
  const memo = (field.legMemo ??= new Map());
  const key = (a * field.n + b) * 2 + (stray ? 1 : 0);
  if (memo.has(key)) return memo.get(key);
  const legs = [];
  for (const r of field.list) {
    const x = r.real?.[a];
    const y = r.real?.[b];
    if (isTime(x) && isTime(y) && y > x) legs.push(y - x);
  }
  legs.sort(sortNum);
  const v = stray ? leadersLeg(legs) : legs.length >= CHECK_RULES.leaders ? median(legs.slice(0, CHECK_RULES.leaders)) : null;
  memo.set(key, v);
  return v;
}

/**
 * 9.23 F20: the field's slowest plausible leg from column c to c + 1 (as the tails of the field: from the leaders' leg, the
 * legs in order each within CHECK_RULES.tailGap of the one before; a runner a mat missed, its counted leg a whole split
 * longer, does not stretch it), null with fewer than CHECK_RULES.leaders legs. Worked out once per field.
 */
function legTail(field, c) {
  const memo = (field.tailMemo ??= new Map());
  if (memo.has(c)) return memo.get(c);
  const legs = [];
  for (const r of field.list) {
    const x = r.real?.[c];
    const y = r.real?.[c + 1];
    if (isTime(x) && isTime(y) && y > x) legs.push(y - x);
  }
  legs.sort(sortNum);
  let u = null;
  if (legs.length >= CHECK_RULES.leaders) {
    u = median(legs.slice(0, CHECK_RULES.leaders));
    for (const x of legs) {
      if (x > u * CHECK_RULES.tailGap) break;
      u = Math.max(u, x);
    }
  }
  memo.set(c, u);
  return u;
}

/** Whether a runner can be suspect at all (columnCheck): counted passes, a column still empty, or a finish pass in the last. */
function candidateOf(r, n, fin) {
  const passes = Array.isArray(r.passes) ? r.passes : [];
  if (r.located || (passes.length >= n && !(!!fin && lastIsCounted(r, n)))) return false;
  return passes.some((p) => !p.manual && !p.pinned);
}

/**
 * 9.23 F19: a runner with a pass in every column whose finish is known and whose first pass after its last split is that
 * finish (its finish read, within `near` of it): its last pass is no finish pass, every split has its own pass. 9.23 F20:
 * and no leg between two of them is a stray's (strayIn): a stray pass makes up for a missed mat in the count. The
 * re-check of 2026-10-30 found every complete runner with 2400m missed and a second read 40 s after its 3100m pass taken
 * as complete once FinishLynx's finish was known: no hint, no row, 2400m holding its 3100m time on both boards.
 */
function completeAt(field, r) {
  const n = field.n;
  const passes = Array.isArray(r.passes) ? r.passes : [];
  return passes.length >= n && isTime(r.finish) && r.finish > 0 && isTime(r.afterLast) && Math.abs(r.afterLast - r.finish) <= field.near
    && !strayIn(field, r);
}

/**
 * 9.23 F20: the runner's legs, between two of its passes in splits next to each other, shorter than anybody covers that
 * stretch (CHECK_RULES.strayLeg x the leaders' leg there, leaderLeg): one of the two passes is no split, a stray pass (a
 * runner who stopped on a mat, a backup mat far from the primary); a stray soon after a real pass is the later of the two,
 * one soon before the runner's next real pass the earlier. Each as the indexes into r.passes of its two ends.
 * @param {ReturnType<typeof checkField>} field
 * @param {CheckRunner} r
 * @returns {[number, number][]}
 */
export function strayLegs(field, r) {
  const ps = Array.isArray(r?.passes) ? r.passes : [];
  const out = [];
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    if (a.manual || b.manual || b.col !== a.col + 1) continue;
    const lead = leaderLeg(field, a.col, b.col, { stray: true });
    if (lead !== null && b.t - a.t < CHECK_RULES.strayLeg * lead) out.push([i - 1, i]);
  }
  // (and, with a pass in every split, a leg far shorter than the runner's own pace: ownShort. 4200m missed and a read 60 s
  // after the runner's 4400m pass, counted in 4400m: its leg on to 5300m 1:00 short, as long as the leaders' or longer for a
  // runner of the back of the field, and nothing said so)
  const cols = new Set(ps.map((p) => p.col));
  let every = true;
  for (let c = 0; c < field.n && every; c++) every = cols.has(c);
  if (every) {
    const legs = [];
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1];
      const b = ps[i];
      if (a.manual || b.manual || b.col !== a.col + 1 || b.col >= field.n) continue;
      const lead = leaderLeg(field, a.col, b.col, { stray: true });
      if (lead !== null && lead > 0) legs.push({ i, x: (b.t - a.t) / lead });
    }
    for (const i of ownShort(legs)) if (!out.some(([, j]) => j === i)) out.push([i - 1, i]);
    out.sort((x, y) => x[1] - y[1]);
  }
  return out;
}

/** 9.23 F20: whether the runner has a stray pass in its splits (strayLegs). */
export const strayIn = (field, r) => strayLegs(field, r).length > 0;

/**
 * 9.23 F20: whether a leg from column a to the next, b, is shorter than anybody covers that stretch (as strayLegs measures
 * it); null when nobody has covered it yet (the runner at the front), or b is not the next column.
 */
export function strayLegAt(field, a, b, leg) {
  const lead = b === a + 1 ? leaderLeg(field, a, b, { stray: true }) : null;
  return lead === null ? null : leg < CHECK_RULES.strayLeg * lead;
}

/**
 * 9.23 F20: the legs of a runner with a pass in every split (`legs`, between splits next to each other: { i, x }, x the
 * leg over the leaders' there) shorter than CHECK_RULES.strayOwn x the runner's own pace: the median x of its other legs,
 * a long one left out (FIT_RULES.longAbove x the shortest: a missed mat's or a slow leg's), with three other legs at least.
 * One of the two passes of such a leg is a stray. Each as its i.
 * @param {{ i: number, x: number }[]} legs
 * @returns {number[]}
 */
function ownShort(legs) {
  const out = [];
  if (legs.length < 4) return out;
  for (const l of legs) {
    const others = legs.filter((o) => o !== l).map((o) => o.x).sort(sortNum);
    const keep = others.filter((x) => x <= FIT_RULES.longAbove * others[0]);
    if (keep.length >= 3 && l.x < CHECK_RULES.strayOwn * median(keep)) out.push(l.i);
  }
  return out;
}

// ---- too fast to be real (DESIGN 9.24) ---------------------------------------------------------------------------------
//
// The column check asks which split a pass belongs to, and the look-wrong check compares a leg with the runners of the
// same pace (marked under 0.6 of theirs, or under 0.75 of the leaders': a stray). Neither says anything about a read that
// is no split at all and comes plausibly soon: at the IvyXC meet of 2026-10-31 a runner who had dropped out (55th, 59th,
// 67th, 69th and 74th at the first five splits) had her chip read twice more, and both reads went to the boards as her
// next two splits, the second as PLACE 6. Her leg to the first was 0.90 of the leaders' on that stretch: unmarked. This
// check judges each leg against the leaders' and against the runner's own legs so far. It MARKS, it never holds: the
// engine works it out as each read comes in, so the split is listed with the splits that look wrong, counted on the
// Dashboard and marked in the grid from that moment ("Too fast for a runner who was 74th: not a split?"), and the
// operator takes it back (Not a split) or stops sending the runner.

/**
 * The numbers of the pace check (fastLegsOf), chosen from every pass of the nine real races on disk (2,764 real ones:
 * six two-split races of 2026-10-28, the 7-split race of 2026-10-21, the IvyXC Women's 6K and Men's 8K), each judged at
 * the moment it arrived and again after its race (DESIGN 9.24). x = a leg over the leaders' leg on its stretch.
 * - minRefs: the leaders' leg is the median of the CHECK_RULES.leaders fastest legs of the OTHER runners with a real
 *   crossing at both splits; with fewer than this many of them through, no judgement yet (the split is marked once
 *   they are)
 * - below: too fast only when x is under this. The fastest real leg was 0.973 at its arrival (a runner who went from
 *   32nd to 8th) and 0.913 after its race (a winner far ahead of a field of 51); the dropped-out runner's two reads
 *   0.902 and 0.686
 * - ownBelow: ... and under this times the runner's own pace: the median x of its earlier legs (its first split's time
 *   over the leaders' time there is one). A winner runs every leg ahead of the leaders (0.957 of her own pace); a runner
 *   far back who runs one of the fastest legs stays above `below`. The lowest real leg was 0.920 of the runner's own
 *   pace (0.942 among the legs faster than the leaders'); the dropped-out runner's 0.827 and 0.634
 * - steady: ... and only a runner whose earlier legs agree, the slowest within this factor of the fastest: a mat that
 *   missed the runner makes one counted leg two stretches long (1.6 times or more on the real courses) and the next ones
 *   another stretch's, which can be shorter. Those are the column check's and the missed-mat fixes', never "not a
 *   split?" (every complete runner of the three long races with one mat taken out: all but the first mat left alone)
 * - afterAbove: once the operator has set such a pass aside (Not a split), the runner's next pass takes its split. One
 *   that fits the runner's own pace is its split; one slower than this times that pace (and no slower than `steady`
 *   times: a missed mat's) is marked too: a chip read where it should not be is often off the course. The dropped-out
 *   runner's second read came 4:31.6 after her last real split where her pace gives 3:39 (1.24); 99 of 100 real legs are
 *   within 1.17 of the runner's own pace, 95 within 1.10
 */
export const FAST_RULES = Object.freeze({ minRefs: 5, below: 0.95, ownBelow: 0.88, steady: 1.5, afterAbove: 1.15 });

/**
 * @typedef {{ col: number, from: number, t: number, leg: number, lead: number, ratio: number, own: number, refs: number }} FastLeg
 *   the pass at column `col` (race ticks t) came `leg` after the runner's pass at `from` (the column before), where the
 *   leaders took `lead`; ratio = leg / lead; own: the runner's own pace (the median ratio of its earlier legs); refs: the
 *   other runners through both splits
 */

/** The x smallest values seen, each with its bib (insert one). */
function keepLowest(top, x, bib, keep) {
  if (top.length === keep && x >= top[keep - 1].x) return;
  let i = top.length;
  while (i > 0 && top[i - 1].x > x) i--;
  top.splice(i, 0, { x, bib });
  if (top.length > keep) top.pop();
}

/**
 * What the pace check measures against (fastLegsOf), made once per race state in one pass over the runners: for every
 * stretch between two splits next to each other its fastest legs and how many runners covered it, and the first times at
 * the first split. One more than the leaders are kept, so a runner is never its own reference.
 * @param {{ n: number, runners: { bib: string, real: (number|null)[] }[] }} args real: the kept REAL crossing per column
 * @returns {{ n: number, legs: { top: { x: number, bib: string }[], count: number }[], first: { top: { x: number, bib: string }[], count: number } } | null}
 */
export function fastField({ n, runners }) {
  const list = Array.isArray(runners) ? runners : [];
  if (!(n > 1) || !list.length) return null;
  const keep = CHECK_RULES.leaders + 1;
  const legs = Array.from({ length: n - 1 }, () => ({ top: [], count: 0 }));
  const first = { top: [], count: 0 };
  for (const r of list) {
    const real = r.real;
    if (!Array.isArray(real)) continue;
    if (isTime(real[0]) && real[0] > 0) {
      first.count++;
      keepLowest(first.top, real[0], r.bib, keep);
    }
    for (let c = 0; c + 1 < n; c++) {
      const a = real[c];
      const b = real[c + 1];
      if (!isTime(a) || !isTime(b) || b <= a) continue;
      legs[c].count++;
      keepLowest(legs[c].top, b - a, r.bib, keep);
    }
  }
  return { n, legs, first };
}

/** The leaders' value of a stretch (or of the first split) without this runner, who has one there: null with too few. */
function leadWithout(entry, bib, rules) {
  if (!entry || entry.count - 1 < rules.minRefs) return null;
  const v = [];
  for (const e of entry.top) if (e.bib !== bib && v.length < CHECK_RULES.leaders) v.push(e.x);
  return v.length ? median(v) : null;
}

/**
 * DESIGN 9.24, the pace check: a runner's legs between its real crossings in splits next to each other that are too
 * fast to be real (FAST_RULES): clearly faster than the leaders' leg on that stretch AND clearly faster than the runner's
 * own legs so far, for a runner whose earlier legs agree with each other. The first such pass, and the passes right
 * after it that are too fast as well (each measured from the one before; not one that would be the runner's own split
 * with those set aside): one mark for the runner. Not judged: the first split (no leg), a leg to or from a made-up time
 * or a pass the operator placed or said is right (`fixed`), anything after the mark.
 * @param {ReturnType<typeof fastField>} field
 * @param {{ bib: string, real: (number|null)[], fixed?: boolean[], passes?: CheckPass[] }} me fixed: per column, the
 *   operator placed or kept the pass there (a CheckRunner's pinned passes say so too)
 * @param {typeof FAST_RULES} [rules]
 * @returns {FastLeg[]} in course order
 */
export function fastLegsOf(field, me, rules = FAST_RULES) {
  return paceWalk(field, me, rules).fast;
}

/**
 * 9.24: what the pace check measures a runner's pass at column b against: the leaders' leg from the split before
 * (`lead`), the runner's own pace up to there (`own`: the median of its earlier legs over the leaders', a too-fast one
 * left out; null without one) and whether those legs agree (`steady`). Null when the runner has no real crossing at
 * both splits or too few others are through.
 * @returns {{ lead: number, own: number|null, steady: boolean } | null}
 */
export function paceAt(field, me, b, rules = FAST_RULES) {
  return paceWalk(field, me, rules).at[b] ?? null;
}

/** The pace check's walk over one runner's legs (fastLegsOf, paceAt). */
function paceWalk(field, me, rules) {
  const out = [];
  const at = [];
  const real = me?.real;
  if (!field || !Array.isArray(real)) return { fast: out, at };
  const fixed = (b) => (me.fixed ? me.fixed[b] === true : (me.passes ?? []).some((p) => p.col === b && p.pinned));
  const own = [];
  if (isTime(real[0]) && real[0] > 0) {
    const lead0 = leadWithout(field.first, me.bib, rules);
    if (lead0 !== null && lead0 > 0) own.push(real[0] / lead0);
  }
  /** the runner's last pass before the first one that is too fast: what the passes after it are measured from as well */
  let anchor = null;
  for (let b = 1; b < field.n; b++) {
    const ta = real[b - 1];
    const tb = real[b];
    const lead = isTime(ta) && isTime(tb) && tb > ta ? leadWithout(field.legs[b - 1], me.bib, rules) : null;
    if (lead === null || !(lead > 0)) {
      if (anchor) break;
      continue;
    }
    const ratio = (tb - ta) / lead;
    const s = own.slice().sort(sortNum);
    const level = s.length ? median(s) : null;
    const steady = s.length > 0 && s[s.length - 1] <= rules.steady * s[0];
    at[b] = { lead, own: level, steady };
    // (a leg to or from a pass the operator placed or said is right is the operator's: not judged, no measure of pace)
    if (fixed(b) || fixed(b - 1)) {
      if (anchor) break;
      continue;
    }
    const fast = ratio < rules.below && steady && ratio < rules.ownBelow * level;
    // A mark is a run of passes in a row that are each too fast after the one before: what follows a pass that is no
    // split is measured from it, so it says nothing more. And a pass that is too fast only because a stray took its
    // split is the runner's own: with the passes before it set aside it would be the split after the anchor, and when
    // its leg from there fits the runner's own pace (rules.ownBelow to rules.afterAbove times it) it is that split, a
    // column late: the stray's fix moves it back (the dropped-out runner's second read would be 1.24 times her pace there).
    if (anchor) {
      const lead2 = fast ? leadWithout(field.legs[anchor.col], me.bib, rules) : null;
      const r2 = lead2 !== null && lead2 > 0 ? (tb - anchor.t) / lead2 : null;
      if (!fast || (r2 !== null && r2 >= rules.ownBelow * level && r2 <= rules.afterAbove * level)) break;
    }
    if (fast) {
      out.push({ col: b, from: b - 1, t: tb, leg: tb - ta, lead, ratio, own: level, refs: field.legs[b - 1].count - 1 });
      anchor ??= { col: b - 1, t: ta };
      continue;
    }
    own.push(ratio);
  }
  return { fast: out, at };
}

/** "1st", "2nd", "74th". */
function ordinalOf(n) {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The words of a runner's splits that are too fast to be real, in the timer's terms, one sentence for all of them:
 * "Bib 142, 4.4K 15:36.4: 3:01.7 after 3.4K, where the leaders took 3:21. Too fast for a runner who was 74th: not a
 * split?", and with the next one too, "Bib 142, 4.4K 15:36.4: 3:01.7 after 3.4K, where the leaders took 3:21; 5K 17:06.3:
 * 1:29.9 after 4.4K, where the leaders took 2:09. Too fast for a runner who was 74th: not splits?". `after`: the runner's
 * next pass once such a pass was set aside, when it comes slow for the runner: "Bib 142, 4.4K 17:06.3: 4:31.6 after 3.4K,
 * where the leaders took 3:21. Slow for this runner, and it follows 15:36.4, which was not a split: is it 4.4K?"
 * @param {(FastLeg & { after?: number|null })[]} legs the runner's legs in question, in course order
 * @param {{ bib: string, place?: number|null, names: string[] }} who place: the runner's place at the split before the first
 */
export function fastText(legs, { bib, place = null, names }) {
  const name = (c) => names?.[c] ?? `Split ${c + 1}`;
  const one = (f) => {
    const tenths = formatRaceTime(f.leg, 1);
    return `${name(f.col)} ${formatRaceTime(f.t, 1)}: ${f.leg < 60 * TICKS_PER_SEC ? `0:${tenths.padStart(4, '0')}` : tenths} after ${name(f.from)}, where the leaders took ${legWords(f.lead)}`;
  };
  const list = Array.isArray(legs) ? legs : [];
  if (!list.length) return '';
  const head = `Bib ${bib}, ${list.map(one).join('; ')}. `;
  const f = list[0];
  if (isTime(f.after)) return `${head}Slow for this runner, and it follows ${formatRaceTime(f.after, 1)}, which was not a split: is it ${name(f.col)}?`;
  const who = Number.isInteger(place) && place > 0 ? ` for a runner who was ${ordinalOf(place)}` : ' to be real';
  return `${head}Too fast${who}: not ${list.length > 1 ? 'splits' : 'a split'}?`;
}

/**
 * One runner judged by the column check (columnCheck), on a field made by checkField: the runner of the field, or (9.23
 * F18) one as a change would leave it, for the change's preview ("21:46.1 → 5300m, held: it looks like the finish").
 * @param {ReturnType<typeof checkField>} field
 * @param {CheckRunner} r
 * @returns {{ suspect: Suspect } | { late: { late: number } } | { slow: { col: number, lost: number } } | null}
 */
export function checkOne(field, r) {
  if (!field || !r || !candidateOf(r, field.n, field.fin)) return null;
  const { n, earliest, fractions, fin, tails, ratio, plausibleAt, positionalPlausible, minLeg, refAt, shapeRefs, now, legWait } = field;
  const R = CHECK_RULES;
  let out = null;
  const passes = r.passes;
  const m = passes.length;
  const fixed = (i) => passes[i].manual || passes[i].pinned;
  let ranges = null;
  const rangeOf = (i) => (ranges ??= passes.map((p) => columnRange(p.t, earliest, n)))[i];
  // the columns its passes may take: the finish (n) only for its last pass, and only for a finish pass in the last
  const toFinish = !!fin && lastIsCounted(r, n);
  const N = toFinish ? n + 1 : n;
  const room = (i, c) => c < n || i === m - 1;
  // 9.23 F18: a late start, not a missed mat. The runner's legs from pass to pass (and on to its finish, when it is
  // known) fit the course as counted, every one of them like the runners' of the same pace, and clearly better than as
  // the better placing puts them: then nothing is held. The late starters of the re-check of 2026-10-30 (every mat
  // read, 3 to 15 minutes after the gun) had every pass held once FinishLynx's finish was known, and the one click
  // "Missed 800m: add it" sent each split a column late; 2 to 4 minutes late, with the stream's finish passes, every
  // pass held after the race and two wrong sets offered.
  const fRef = finishRefOf(r, n, fin);
  const fT = isTime(r.finish) && r.finish > 0 ? r.finish : fRef;
  const eventsOf = (cols) => {
    const ev = [];
    for (let i = 0; i < m; i++) if (!passes[i].manual) ev.push({ t: passes[i].t, c: cols[i] });
    const z = ev[ev.length - 1];
    if (isTime(fT) && z && z.c < n && fT > z.t) ev.push({ t: fT, c: n });
    return ev;
  };
  const others = shapeRefs.filter((x) => x.bib !== r.bib);
  const lateStart = (cols) => {
    // (on the course, or every split read: a late starter whose passes stop before the last split long enough ago is
    // none; a synthetic runner who missed 0.8K and 4.4K, nothing read after its 5.3K pass, fitted the course as counted)
    const z = passes[m - 1];
    if (z.col < n - 1 && isTime(legWait[z.col]) && z.t + legWait[z.col] < now) return null;
    const ev = eventsOf(passes.map((p) => p.col));
    const own = legShape(ev, others, refAt);
    if (!own || own.cost > R.shapeWithin || own.lo < FIT_RULES.shortBelow || own.hi > FIT_RULES.longAbove) return null;
    // 9.23 F19: with fewer legs, on the course before the last split, a late start only when the check's placing moves
    // the first pass (a late start makes every pass late by the same time: the first, measured from the gun, looks the
    // latest), and every leg fits as closely as the runners of the same pace (shapeClose, shapeCloseLeg) and clearly
    // better than any other placing of the same passes (closeStart). The re-check of 2026-10-30 found late starters two
    // to four minutes late held on the course until their fifth pass, a sure "Missed 800m: add it" on offer meanwhile
    if (own.legs < R.shapeLegs && !closeStart(own, ev, cols)) return null;
    const other = legShape(eventsOf(cols), others, refAt);
    return other && other.cost - own.cost >= R.shapeMargin ? own : null;
  };
  // (the other placings only where a pass can be: not before the leaders there, nor before the split's earliest time; a
  // late start makes nobody faster)
  const can = (t, c) => {
    const x = ratio(t, c);
    return x !== null && x >= R.floor && columnRange(t, earliest, n).ok(c);
  };
  const closeStart = (own, ev, cols) => !fixed(0) && cols[0] !== passes[0].col && ev[ev.length - 1].c < n - 1 && closeFit(own, ev, n, others, refAt, can);
  // 9.23 F20: one slow leg, every mat read (a stop, a fall): the runner's legs as counted fit closely with that one leg
  // left out (legShape `skip`: every other leg within shapeCloseLeg of the runners of the same pace, all within shapeClose
  // on average), two passes after it show it (one can't: a runner who missed 3100m and 4400m has its 4200m pass in 3100m
  // and its 5300m pass in 4200m, as one slow leg from 2400m to 3100m and the 1100 m from 3100m to 4200m like the runners'
  // 1100 m from 4200m to 5300m; its lines went out a split early on the course for 156 of 167 until the race was over),
  // or the last split's pass alone when the slow leg ends just before it (nothing else comes before the runner's finish,
  // and a finisher's splits go out only with its finish place: three minutes lost on the 200 m from 4200m to 4400m kept
  // the 4400m and 5300m lines off the boards for good), and the placing the check found fits no better, a slow leg
  // costing CHECK_RULES.slowLeg: then nothing is held. The re-check of 2026-10-30 found runners who
  // lost 2:30 on the 900 m from 1500m to 2400m held on the course and given "Missed 2400m" as the one click once their
  // 3100m pass was in, and runners who lost 4:00 from 2400m to 3100m with their 3100m to 5300m held until their finish
  // (then never sent live: a finisher's splits go with the finish place)
  const slowLeg = (cols) => {
    // (every mat read: not when the stream carries finish passes and the runner's would be in by now, none in)
    const z = passes[m - 1];
    if (fin && !isTime(fT) && isTime(fin.gap) && z.t + fin.gap < now) return null;
    const ev = eventsOf(passes.map((p) => p.col));
    let own = null;
    for (let i = 1; i < ev.length - 1; i++) {
      if (i >= ev.length - 2 && ev[i + 1].c !== n - 1) continue;
      const s = legShape(ev, others, refAt, i);
      // (a leg that lost more than CHECK_RULES.slowLost is no slow leg: 586, 3100m and 4400m missed, its 5300m pass in 4400m
      // after "Missed 3100m", fitted as 5:18 lost on the 200 m to 4400m, a cool-down pass its finish pass)
      if (!s || !(s.slow > 1) || s.lost > R.slowLost || s.cost > R.shapeClose || s.lo < 1 / R.shapeCloseLeg || s.hi > R.shapeCloseLeg) continue;
      if (!own || s.cost * s.legs < own.cost * own.legs) own = { ...s, at: ev[i].c };
    }
    if (!own) return null;
    const other = legShape(eventsOf(cols), others, refAt);
    return other && other.cost * other.legs >= own.cost * own.legs + R.slowLeg ? own : null;
  };
  // (9.23 F19: a runner with every split read before its known finish is never held: completeAt)
  const complete = completeAt(field, r);
  const hold = (sus) => {
    const own = lateStart(sus.cols);
    const slow = own || complete ? null : slowLeg(sus.cols);
    out = own ? { late: { late: own.late } } : complete ? null : slow ? { slow: { col: slow.at, lost: slow.lost } } : { suspect: sus };
  };
  if (isTime(r.finish) && r.finish > 0 && fractions && minLeg > 0) {
    const F = r.finish;
    const cost = (i, c) => (passes[i].manual ? 0 : Math.abs(passes[i].t - (c < n ? fractions[c] : 1) * F));
    let positional = 0;
    for (let i = 0; i < m; i++) positional += cost(i, passes[i].col);
    // ties (and anything within the margin) keep counting: only a whole leg's worth of difference moves a pass. Most
    // finishers are that close to the field already, and need no programme at all.
    const margin = R.legMargin * minLeg * F;
    if (positional <= margin) return;
    const allowed = (i, c) => (fixed(i) ? c === passes[i].col : rangeOf(i).ok(c) && room(i, c));
    const best = bestByCost(m, N, allowed, cost);
    if (!best) return;
    if (positional - best.total <= margin) return;
    const moves = movesOf(passes, best.cols);
    if (moves.length) hold({ bib: r.bib, method: 'finish', cols: best.cols, moves, positional, best: best.total });
    return out;
  }
  // on the course: leaders' references and the field's tails
  const value = (i, c) => {
    if (passes[i].manual) return null;
    const x = ratio(passes[i].t, c);
    return x === null ? null : Math.log(x);
  };
  const spreadOf = (cols) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < m; i++) {
      const v = value(i, cols[i]);
      if (v === null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return hi === -Infinity ? 0 : hi - lo;
  };
  const posCols = passes.map((p) => p.col);
  // A runner the operator has placed a pass of (Move, Keep) is no longer compared with the field: the operator said
  // where this runner is, however slow that is. Only evenness with that pass can still say a later one is off.
  const placed = passes.some((p) => p.pinned && !p.manual);
  const posPlausible = placed || positionalPlausible(tails, r);
  // 9.23 F18: ... and its last pass, counted in the last split with no pass soon after it while the stream carries the
  // finish passes, by its leg (lastLegFinish): evenness hardly sees the finish, a short way after the last split in the
  // leaders' times. The re-check's 227 (3100m and 5300m missed): "Move 15:04.1 to 4200m" put its finish read, 21:46.1,
  // in 5300m, 5:49 after its 4400m where the runners of its pace took 3:10 to 5300m, and it went out as 5300m (441, the
  // same Move, had it held); every time the check lets such a runner go, its last pass is still looked at that way. 9.23
  // F19: and with a pass soon after it that is no finish pass from it (afterFitsFinish): 230 (3100m and 5300m missed), its
  // finish read moved into 5300m by "Move 15:12.7 to 4200m", had a cool-down pass 1:21 after it, and went out as 5300m
  const asFinish = () => {
    if (!placed || !toFinish || fixed(m - 1) || (isTime(r.finish) && r.finish > 0) || !lastLegFinish(field, r)) return null;
    if (isTime(fRef) && afterFitsFinish(field, r, passes[m - 1])) return null;
    const cols = posCols.slice();
    cols[m - 1] = n;
    hold({ bib: r.bib, method: 'course', cols, moves: movesOf(passes, cols), positional: 0, best: 0, lone: false });
    return out;
  };
  const evidence = passes.filter((p) => !p.manual).length;
  const posSpread = posPlausible || evidence > 1 ? spreadOf(posCols) : 0;
  // quick exits, which most runners take: a plausible single pass, or a plausible placing that is even already
  if (posPlausible && (evidence <= 1 || posSpread <= R.spreadMargin)) return asFinish();
  if (posPlausible) {
    // A missed mat is one jump between two passes; a runner who fades over many splits spreads out without one, and
    // moving passes to later columns can only take out about one jump, so such a runner can't be clearly better
    // placed (and is spared the programme below, which a 9-split race would otherwise run for half its field).
    let jump = 0;
    let prev = null;
    for (let i = 0; i < m; i++) {
      const v = value(i, posCols[i]);
      if (v === null) continue;
      if (prev !== null) jump = Math.max(jump, Math.abs(v - prev));
      prev = v;
    }
    if (jump <= R.spreadMargin) return asFinish();
  }
  if (evidence <= 1) {
    // one pass: no evenness to compare, so only a pass beyond the field there (see singleGap) is doubted, and only
    // when another column fits it (below: plausible there)
    const p = passes.find((x) => !x.manual);
    const x = ratio(p.t, p.col);
    if (x !== null && tails[p.col] !== null && x >= R.floor && x <= tails[p.col] * R.tailGap * R.singleGap) return asFinish();
  }
  // On the course the evidence is the leaders' times only, so a placing may say the runner missed one more mat than
  // counting does, not two: a runner twice the leaders' time at 1K and 2K looks just like one at the leaders' pace
  // who missed 1K and 3K, and a slow runner is far likelier than two missed mats. 9.23 F20: unless a leg as counted, from
  // one pass to the next in the split after, is longer than any runner's there (the field's slowest plausible leg,
  // legTail, x tailGap): no slow runner explains that leg, a late start makes nobody slower, and with the first pass in
  // doubt (a late start or a missed first mat) the runner's later passes went out a split early. The re-check of
  // 2026-10-30 found every runner with 800m and 2400m missed on the boards a split or two early from its second pass (its
  // 3100m pass, 5:39 after its 1500m pass, counted in 1500m where the slowest runner took 3:00 from 800m) until the one
  // click, which waits for a late start to be ruled out
  // (only with the first pass in doubt, beyond the field there, and a leg slower than the runner's own pace to it too:
  // a walker's legs are as slow as its first pass, a late starter's faster)
  let wide = false;
  const p0 = passes[0];
  const r0 = !fixed(0) && !p0.manual ? ratio(p0.t, p0.col) : null;
  if (r0 !== null && tails[p0.col] !== null && r0 > tails[p0.col] * R.tailGap) {
    for (let i = 1; i < m && !wide; i++) {
      const a = passes[i - 1];
      const b = passes[i];
      const tail = !a.manual && !b.manual && b.col === a.col + 1 ? legTail(field, a.col) : null;
      const lead = tail !== null ? leaderLeg(field, a.col, b.col) : null;
      if (tail !== null && lead !== null && b.t - a.t > tail * R.tailGap && (b.t - a.t) / lead > r0 * R.tailGap) wide = true;
    }
  }
  const last = posCols[m - 1] + (wide ? 2 : 1);
  /** The clearly better placing with no pass past column `limit` (`anchor`: the pass that stays where it is), or null. */
  const betterWithin = (limit, anchor = -1) => {
    const allowed = (i, c) => {
      if (fixed(i) || i === anchor) return c === passes[i].col;
      return c <= limit && room(i, c) && rangeOf(i).ok(c) && plausibleAt(tails, passes[i].t, c);
    };
    // a quick exit: a pass that fits no column plausibly (a leader ahead of the leaders' median), or no pass with a
    // plausible column other than its own, leaves nothing to suggest
    let other = false;
    for (let i = 0; i < m; i++) {
      if (fixed(i) || i === anchor) continue;
      let any = false;
      for (let c = 0; c <= Math.min(limit, N - 1); c++) {
        if (!allowed(i, c)) continue;
        any = true;
        if (c !== posCols[i]) other = true;
      }
      if (!any) return null;
    }
    if (!other) return null;
    const found = bestBySpread(m, N, allowed, value);
    if (!found || found.cols.every((c, i) => c === posCols[i])) return null;
    const clear = posPlausible
      ? posSpread - found.spread > R.spreadMargin
      : found.spread <= posSpread + R.spreadSlack;
    return clear ? found : null;
  };
  let best = betterWithin(last);
  // 9.23 F22: two or more mats missed in a row. With nothing clearly better one split further, a pass may be placed
  // as far on as it fits, on evidence at least as strong: the runner's first pass stays where counting put it and is
  // plausible there (it says how far behind the leaders this runner runs: the slow runner who "looks like one who
  // missed 1K and 3K" has no such pass), and with the later passes moved on every pass is at that same level
  // (CHECK_RULES.farSpread: for one split a placing only has to be clearly better than counting). On the IvyXC Women's
  // 6K replay, a mid-pack runner with 2K and 2.6K missed had her 3.4K read on both boards as "2K 12:22.4 place 85" and
  // her 4.4K read as "2.6K 16:11.8 place 84" for four minutes: at 2.6K the first was beyond the field too, so nothing
  // one split on was plausible, the check had nothing to suggest, and the line went out.
  if (!best) {
    const a = passes.findIndex((p) => !p.manual);
    if (a >= 0 && evidence > 1 && (fixed(a) || plausibleAt(tails, passes[a].t, posCols[a]))) {
      const far = betterWithin(N - 1, a);
      if (far && far.spread <= R.farSpread) best = far;
    }
  } else if (best.spread > R.farSpread) {
    // 9.26: two mats close together, both missed (a mat 200 m after a K marker: one stretch of course, one bad patch
    // for a chip). The runner's next two passes are counted in those two columns; one split on is "clearly better than
    // counting" and still fits badly (the 5K time left in 4K at 1.28 x and the 6K time in 5K, for a runner at 1.03 x:
    // spread 0.22), while further on every pass is at the runner's own level (0.03). With mats a kilometre apart such
    // a pass is implausible one split on, so the far placing above was reached; with a close mat it is merely slow
    // there. So a placing one split on that itself fits badly gives way to one further on that passes the same test
    // as above and is clearly better still. On the 2026-11-13 Men's Race with a mat 200 m after 4K, a runner with
    // both missed had his 5K time sent as "4K 15:27.0 place 186" the moment his 6K read came, which is also the
    // moment the one click became sure: the hold on it was let go for the worse placing.
    const a = passes.findIndex((p) => !p.manual);
    if (a >= 0 && evidence > 1 && (fixed(a) || plausibleAt(tails, passes[a].t, posCols[a]))) {
      const far = betterWithin(N - 1, a);
      if (far && far.spread <= R.farSpread && best.spread - far.spread > R.spreadMargin) best = far;
    }
  }
  if (!best) return asFinish();
  // 9.23 F19: a placing that moves the runner's first pass on (the first split missed) must not make its first leg faster
  // than the leaders' over the same splits (legFloor x the median of the field's five fastest): a runner who started late
  // runs its legs at its own pace, so its 800m to 1500m counted as 1500m to 2400m is far faster than anybody's. Late
  // starters two to four minutes late, every mat read, were held until their third to fifth pass (the check measures
  // every pass from the gun)
  if (best.cols[0] !== posCols[0] && m > 1 && !fixed(0) && !fixed(1)) {
    const lead = leaderLeg(field, best.cols[0], best.cols[1]);
    if (lead !== null && passes[1].t - passes[0].t < R.legFloor * lead) {
      // (the quiet note when its legs fit the course as counted, as for a late starter the check spares)
      const own = legShape(eventsOf(posCols), others, refAt);
      if (own && own.cost <= R.shapeWithin && own.lo >= FIT_RULES.shortBelow && own.hi <= FIT_RULES.longAbove) return { late: { late: own.late } };
      return asFinish();
    }
  }
  const moves = movesOf(passes, best.cols);
  // lone: the runner's only pass so far (revision 10): its next pass tells which split it is, so it is held until
  // then (or until the operator decides)
  if (moves.length) hold({ bib: r.bib, method: 'course', cols: best.cols, moves, positional: posSpread, best: best.spread, lone: evidence <= 1 });
  return out;
}

/**
 * 9.23 F18: how a placing of a runner's passes fits the course from pass to pass, whenever the runner started: each leg
 * (one event to the next, in the placing's columns; n the finish) as a share of the runner's whole stretch (its first
 * event to its last), over the median share of the same leg among the CHECK_RULES.nearest other runners whose time over
 * that stretch is nearest the runner's (the runners of the same pace, as estimateGaps takes them). Measured from the
 * runner's own first pass, so a late start changes nothing (the leaders' references and the field fractions measure
 * every pass from the gun). A missed mat shows as legs of another length than the course's: on 2026-10-21's course a
 * runner who missed 800m has its 1100 m leg counted as 3100m's 700 m and its 200 m one as 4200m's 1100 m; a runner who
 * started late has every leg as counted.
 * 9.23 F20: `skip`, one leg left out (a slow leg: a stop, a fall, every mat read): the leg from event skip - 1 to event
 * skip is no part of the runner's stretch nor of the other runners' durations, it costs nothing, and how slow it was is
 * said (`slow`: its time over the runners' on that leg at the pace of the rest). Without it a leg minutes slower than
 * the runners' makes every other leg look short as a share of the stretch.
 * @param {{ t: number, c: number }[]} events the placing in time order: race ticks, column (n: the finish)
 * @param {{ bib: string }[]} others the other runners, as `timeOf` takes them
 * @param {(o: any, c: number) => number|null} timeOf another runner's race ticks at a column (n: its finish)
 * @param {number} [skip] 9.23 F20: the leg left out (1 .. events.length - 1), 0 for none
 * @returns {{ cost: number, lo: number, hi: number, late: number, legs: number, slow: number|null, lost: number|null } | null}
 *   cost: the mean |log ratio| of the legs; lo, hi: the smallest and largest ratio (1: as the runners of the same pace);
 *   late: how long after the gun the runner started, by those runners' time to its first column at its pace; slow, lost
 *   (with `skip`): the left-out leg's ratio and the race ticks it took longer than theirs; null with fewer than two legs
 *   (two besides the one left out), or fewer than CHECK_RULES.minComplete runners with a time at every column of the
 *   placing
 */
export function legShape(events, others, timeOf, skip = 0) {
  const ev = Array.isArray(events) ? events : [];
  const cut = Number.isInteger(skip) && skip > 0 && skip < ev.length ? skip : 0;
  if (ev.length < (cut ? 4 : 3)) return null;
  const gone = (ts) => (cut ? ts[cut] - ts[cut - 1] : 0);
  const S = ev[ev.length - 1].t - ev[0].t - (cut ? ev[cut].t - ev[cut - 1].t : 0);
  if (!(S > 0)) return null;
  const refs = [];
  for (const o of others ?? []) {
    const ts = [];
    for (const e of ev) {
      const t = timeOf(o, e.c);
      if (!isTime(t) || (ts.length && !(t > ts[ts.length - 1]))) break;
      ts.push(t);
    }
    if (ts.length === ev.length) refs.push({ bib: o.bib, ts, dur: ts[ts.length - 1] - ts[0] - gone(ts) });
  }
  if (refs.length < CHECK_RULES.minComplete) return null;
  const near = refs.map((x) => ({ x, d: Math.abs(x.dur - S) })).sort((a, b) => a.d - b.d || byBib(a.x.bib, b.x.bib))
    .slice(0, CHECK_RULES.nearest).map((y) => y.x);
  let cost = 0;
  let lo = Infinity;
  let hi = 0;
  for (let i = 1; i < ev.length; i++) {
    if (i === cut) continue;
    const ratio = ((ev[i].t - ev[i - 1].t) / S) / median(near.map((x) => (x.ts[i] - x.ts[i - 1]) / x.dur).sort(sortNum));
    cost += Math.abs(Math.log(ratio));
    lo = Math.min(lo, ratio);
    hi = Math.max(hi, ratio);
  }
  const legs = ev.length - 1 - (cut ? 1 : 0);
  // (the start: the runner's first event against theirs at its pace; with a leg left out before it, none is)
  const late = ev[0].t - median(near.map((x) => (x.ts[0] * S) / x.dur).sort(sortNum));
  let slow = null;
  let lost = null;
  if (cut) {
    const theirs = median(near.map((x) => (x.ts[cut] - x.ts[cut - 1]) / x.dur).sort(sortNum)) * S;
    slow = (ev[cut].t - ev[cut - 1].t) / theirs;
    lost = ev[cut].t - ev[cut - 1].t - theirs;
  }
  return { cost: cost / legs, lo, hi, late, legs, slow, lost };
}

/**
 * 9.23 F19: whether a placing of a runner's passes (`events`, its legShape `own`) fits the course so closely, and so much
 * better than any other placing of the same passes, that nothing else explains them: every leg within
 * CHECK_RULES.shapeCloseLeg of the runners of the same pace and all of them within shapeClose on average, and every other
 * placing (course order kept; a split skipped between two passes costs shapeGap, a missed mat) at least shapeMargin
 * worse. Measured from pass to pass, it says nothing of when the runner started: a late start with few legs. Placings in
 * which a pass would be skipped columns from the one before it fit a little better than they should: legShape compares
 * the runner with the runners whose time over the same stretch is nearest, slower ones for a longer stretch (a 4-minute
 * late starter's first three passes as 800m, 2400m and 4200m fitted within 0.14 of the course as counted). False with
 * more than CHECK_RULES.shapePlacings placings to try (a long course).
 * @param {{ cost: number, lo: number, hi: number }} own
 * @param {{ t: number, c: number }[]} events
 * @param {number} n split count (the placings use columns 0 .. n - 1)
 * @param {{ bib: string }[]} others
 * @param {(o: any, c: number) => number|null} timeOf
 * @param {(t: number, c: number) => boolean} [can] whether a pass at race time t can be in column c (the column check: not
 *   before the leaders there): a placing with a pass where it can't be is no other placing (the late starter's first
 *   three passes as 2400m, 3100m and 4200m, its 800m faster than the leaders at 2400m, fitted within 0.07 of as counted)
 */
export function closeFit(own, events, n, others, timeOf, can = () => true) {
  const R = CHECK_RULES;
  if (!own || own.cost > R.shapeClose || own.lo < 1 / R.shapeCloseLeg || own.hi > R.shapeCloseLeg) return false;
  const k = events.length;
  let count = 1;
  for (let i = 0; i < k; i++) count = (count * (n - i)) / (i + 1);
  if (count > R.shapePlacings) return false;
  const at = new Array(k);
  const beats = (i, from) => {
    if (i === k) {
      if (at.every((c, j) => c === events[j].c)) return true;
      const s = legShape(events.map((e, j) => ({ t: e.t, c: at[j] })), others, timeOf);
      let gaps = 0;
      for (let j = 1; j < k; j++) gaps += at[j] - at[j - 1] - 1;
      return !s || s.cost + R.shapeGap * gaps - own.cost >= R.shapeMargin;
    }
    for (let c = from; c <= n - (k - i); c++) {
      if (c !== events[i].c && !can(events[i].t, c)) continue;
      at[i] = c;
      if (!beats(i + 1, c + 1)) return false;
    }
    return true;
  };
  return beats(0, 0);
}

/**
 * 9.23 F18: whether a runner's last pass, counted in the last split, is the finish by its leg: the leg from the runner's
 * crossing before it against the same stretch of the FIT_RULES.nearest other runners nearest in time at that crossing
 * (as the look-wrong check measures a leg, legFits): far longer than theirs to the last split (FIT_RULES.longAbove), and
 * fitting theirs to the finish (the finish column's references) within FIT_RULES.fitWithin and betterBy times better
 * in log terms.
 * @param {ReturnType<typeof checkField>} field
 * @param {CheckRunner} r
 */
export function lastLegFinish(field, r) {
  const { n, fin } = field ?? {};
  const ps = r?.passes ?? [];
  const p = ps[ps.length - 1];
  const q = ps[ps.length - 2];
  if (!p || !q || p.col !== n - 1 || !fin) return false;
  const near = [];
  for (const x of field.shapeRefs) {
    const t = x.r.real?.[q.col];
    if (x.bib !== r.bib && isTime(t)) near.push({ x, t, d: Math.abs(t - q.t) });
  }
  near.sort((a, b) => a.d - b.d || byBib(a.x.bib, b.x.bib));
  const toSplit = [];
  const toFin = [];
  for (const { x, t } of near) {
    const s = x.r.real?.[n - 1];
    const f = field.refAt(x, n);
    if (toSplit.length < FIT_RULES.nearest && isTime(s) && s > t) toSplit.push(s - t);
    if (toFin.length < FIT_RULES.nearest && isTime(f) && f > t) toFin.push(f - t);
    if (toSplit.length >= FIT_RULES.nearest && toFin.length >= FIT_RULES.nearest) break;
  }
  if (toSplit.length < FIT_RULES.minRefs || toFin.length < FIT_RULES.minRefs) return false;
  const split = (p.t - q.t) / median(toSplit.sort(sortNum));
  const finish = Math.abs(Math.log((p.t - q.t) / median(toFin.sort(sortNum))));
  return split > FIT_RULES.longAbove && finish <= Math.log(FIT_RULES.fitWithin) && finish <= Math.log(split) / FIT_RULES.betterBy;
}

/**
 * 9.23 F19: whether the runner's pass after its last split (the stream's, `afterLast`) fits as the finish pass after its
 * last pass `p` (in the last split): its leg is not far shorter (FIT_RULES.shortBelow) than the leg from the last split to
 * the finish (the finish column's references) of the FIT_RULES.nearest other runners nearest in time there. True when it
 * can't be measured. 230's cool-down pass 1:21 after its finish read, where the runners of its pace took 2:41 from 5300m to
 * the finish, is none.
 * @param {ReturnType<typeof checkField>} field
 * @param {CheckRunner} r
 * @param {{ t: number }} p
 */
export function afterFitsFinish(field, r, p) {
  const n = field.n;
  if (!isTime(r.afterLast) || !p || !(r.afterLast > p.t)) return true;
  const near = [];
  for (const x of field.shapeRefs) {
    const t = x.r.real?.[n - 1];
    if (x.bib !== r.bib && isTime(t)) near.push({ x, t, d: Math.abs(t - p.t) });
  }
  near.sort((a, b) => a.d - b.d || byBib(a.x.bib, b.x.bib));
  const legs = [];
  for (const { x, t } of near) {
    const f = field.refAt(x, n);
    if (isTime(f) && f > t) legs.push(f - t);
    if (legs.length >= FIT_RULES.nearest) break;
  }
  if (legs.length < FIT_RULES.minRefs) return true;
  return (r.afterLast - p.t) / median(legs.sort(sortNum)) >= FIT_RULES.shortBelow;
}

/**
 * 9.23 F13: whether the RR12 stream carries finish passes: at least 3 runners passed again soon after their real last
 * split, and no fewer than the runners who did not although they got there long enough ago to have done it by now
 * (twice the median of those last legs before the race's latest pass). While the field comes in most runners at the
 * last split have not reached the finish yet: counting them against it (half of all those with a real last split, as
 * before) kept the finish out of the column check until half the field had finished, and on the 2026-10-27 replay let
 * the first finishers who had missed a mat go out a column early.
 * @param {{ t: number, next: number|null }[]} lasts each runner with a real last split: its time there, and its next
 *   pass when that came soon after it (else null)
 * @param {number} now the race's latest pass (race ticks)
 */
export function finishPassesIn(lasts, now) {
  const legs = lasts.filter((x) => isTime(x.next)).map((x) => x.next - x.t).sort(sortNum);
  if (legs.length < 3) return false;
  const wait = 2 * median(legs);
  let none = 0;
  for (const x of lasts) if (!isTime(x.next) && x.t + wait <= now) none++;
  return legs.length >= none;
}

/**
 * 9.23 F13: the finish as the column check's column n, when the RR12 stream carries finish passes (finishPassesIn, the
 * look-wrong check's test too: a pass within twice the field's median last leg after the real last split), else null.
 * refs: per runner, the finish the field references take: FinishLynx's (or a finish read), else its first pass after
 * its real last split when that came within the same bound (`afterLast`); leader: the median of the first
 * CHECK_RULES.leaders of them.
 * @param {CheckRunner[]} runners
 * @param {number} n
 * @returns {{ refs: (number|null)[], leader: number, gap: number } | null} gap (9.23 F18): the bound of "soon after the
 *   last split" (finishRefOf)
 */
export function finishColumn(runners, n) {
  const med = (k) => {
    const l = runners.map((r) => r.real?.[k]).filter(isTime).sort(sortNum);
    return l.length ? median(l) : null;
  };
  const last = med(n - 1);
  const prev = n > 1 ? med(n - 2) : 0;
  if (last === null || prev === null || !(last > prev)) return null;
  const gap = 2 * (last - prev);
  let now = -Infinity;
  const lasts = [];
  const refs = runners.map((r) => {
    for (const p of Array.isArray(r.passes) ? r.passes : []) if (isTime(p.t) && p.t > now) now = p.t;
    if (isTime(r.afterLast) && r.afterLast > now) now = r.afterLast;
    const t = r.real?.[n - 1];
    const soon = isTime(t) && isTime(r.afterLast) && r.afterLast > t && r.afterLast - t < gap;
    if (isTime(t)) lasts.push({ t, next: soon ? r.afterLast : null });
    return isTime(r.finish) && r.finish > 0 ? r.finish : soon ? r.afterLast : null;
  });
  if (!finishPassesIn(lasts, now)) return null;
  const first = refs.filter(isTime).sort(sortNum).slice(0, CHECK_RULES.leaders);
  return first.length ? { refs, leader: median(first), gap } : null;
}

/**
 * 9.23 F18: a runner's finish as the finish column takes it (finishColumn's refs): FinishLynx's (or a finish read), else
 * its first pass after its real last split when that came soon after it; null without the finish column. For a runner
 * of the field it is its entry in fin.refs; checkOne works it out for a runner as a change would leave it too.
 */
function finishRefOf(r, n, fin) {
  if (!fin) return null;
  if (isTime(r.finish) && r.finish > 0) return r.finish;
  const t = r.real?.[n - 1];
  return isTime(t) && isTime(r.afterLast) && r.afterLast > t && r.afterLast - t < fin.gap ? r.afterLast : null;
}

/** The runner's last column holds a pass counting put there (not fixed, not a made-up time, not a timing point). */
function lastIsCounted(r, n) {
  const passes = Array.isArray(r.passes) ? r.passes : [];
  const p = passes[passes.length - 1];
  return !r.located && !!p && !p.manual && !p.pinned && p.col === n - 1;
}

/**
 * "Looks like 2K, not 1K (missed 1K?)": what the Review list and the feed say about a pass the check would move.
 * @param {CheckMove} move
 * @param {string[]} names split names, course order
 */
export function moveText(move, names) {
  const name = (c) => names[c] ?? `Split ${c + 1}`;
  const missed = move.missed.map(name);
  const tail = missed.length ? ` (missed ${missed.length > 1 ? `${missed.slice(0, -1).join(', ')} and ${missed[missed.length - 1]}` : missed[0]}?)`
    : move.withPrevious ? ' (it moves with the pass before it)' : '';
  return `Looks like ${name(move.to)}, not ${name(move.from)}${tail}`;
}

// ---- made-up times (DESIGN 9.17 P3) ---------------------------------------------------------------------------------

/**
 * @typedef {{ bib: string, real: (number|null)[], finish: number|null }} RefRunner  another runner's REAL kept
 *   crossings by column (no made-up times, nothing held), and finish
 * @typedef {{ kind: 'gun'|'start'|'split'|'finish', col: number, t: number }} GapRef  col -1 = the gun (9.23 F19: or the
 *   runner's late start), n = the finish
 * @typedef {{ col: number, estimate: number|null, basis: string, prev: GapRef, next: GapRef|null, frac: number|null,
 *   method: 'nearest'|'column'|'even'|null, count: number }} GapEstimate
 */

const at1 = (t) => formatRaceTime(t, 1);
/** 9.23 F19: a pass this close before a runner's finish is its finish read (the engine's FINISH_NEAR_TICKS). */
const FINISH_READ_TICKS = 10 * TICKS_PER_SEC;
const round10 = (t) => Math.round(t / 10) * 10;
const byBib = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/** The 30 runners whose prev-to-next stretch took nearest to this runner's: they ran it at the same pace. */
function nearestIn(refs, dur, take) {
  return refs.map((r) => ({ r, d: Math.abs(r.dur - dur) }))
    .sort((a, b) => a.d - b.d || byBib(a.r.bib, b.r.bib))
    .slice(0, take)
    .map((x) => x.r);
}

/**
 * Estimates for the splits a runner is missing (DESIGN 9.17 P3). A split is missing when the runner has a kept
 * crossing in a later column, or a finish, but none in it. Each run of missing splits sits between two references:
 * the nearest earlier kept crossing (or the gun, 0) and the nearest later one (or the finish). They are placed in that
 * stretch where runners of the same pace crossed them: estimate = prev + frac x (next - prev), frac = the median of
 * (t_k - t_prev) / (t_next - t_prev) over the (up to) 30 runners nearest in (next - prev) duration that have real
 * crossings at both references and at every split of the run; failing that, per split, over the runners that have
 * prev, that split and next; failing that, evenly spaced. Rounded to the millisecond, and always strictly between the
 * references and in course order. A run with no later reference (the runner is still out there) gets no estimate.
 * 9.23 F19: a runner who started late (`start`, race ticks) has its first splits placed from that start, not the gun.
 * @param {{ n: number, names: string[], kept: (number|null)[], finish: number|null, others: RefRunner[],
 *   columns?: number[] | null, start?: number }} args kept: this runner's kept crossings by column (real or made-up);
 *   others: the other runners of the race; columns: only these empty columns (default: every empty column)
 * @returns {GapEstimate[]} one per empty column, course order: with an estimate when there is a reference on both
 *   sides, else estimate null ("Waiting for a later split or the finish.")
 */
export function estimateGaps({ n, names, kept, finish, others, columns = null, start = 0 }) {
  const out = [];
  const has = (k) => isTime(kept?.[k]);
  const fin = isTime(finish) ? finish : null;
  const name = (c) => names?.[c] ?? `Split ${c + 1}`;
  const want = columns ? new Set(columns) : null;
  for (let k = 0; k < n;) {
    if (has(k)) {
      k++;
      continue;
    }
    let end = k;
    while (end + 1 < n && !has(end + 1)) end++;
    // the run k..end: references on both sides
    let p = -1;
    for (let j = k - 1; j >= 0; j--) if (has(j)) {
      p = j;
      break;
    }
    const prev = p >= 0 ? { kind: 'split', col: p, t: kept[p] } : start > 0 ? { kind: 'start', col: -1, t: start } : { kind: 'gun', col: -1, t: 0 };
    let next = null;
    if (end + 1 < n) next = { kind: 'split', col: end + 1, t: kept[end + 1] };
    else if (fin !== null) next = { kind: 'finish', col: n, t: fin };
    const run = [];
    for (let c = k; c <= end; c++) if (!want || want.has(c)) run.push(c);
    if (run.length) out.push(...estimateRun({ n, name, run, prev, next, others }));
    k = end + 1;
  }
  return out;
}

function estimateRun({ n, name, run, prev, next, others }) {
  if (!next) {
    return run.map((col) => ({ col, estimate: null, basis: 'Waiting for a later split or the finish.', prev, next: null,
      frac: null, method: null, count: 0 }));
  }
  const tp = prev.t;
  const tq = next.t;
  const dur = tq - tp;
  const prevText = prev.kind === 'gun' ? 'the gun' : prev.kind === 'start' ? `its start (about ${formatRaceTime(tp, 0)} after the gun)` : `${name(prev.col)} ${at1(tp)}`;
  const nextText = next.kind === 'finish' ? `the finish ${at1(tq)}` : `${name(next.col)} ${at1(tq)}`;
  if (!(dur > 0)) {
    return run.map((col) => ({ col, estimate: null, basis: `${prevText} is not before ${nextText}.`, prev, next, frac: null, method: null, count: 0 }));
  }
  // 9.23 F19: a pass seconds before the finish is the finish read, counted in a split: nothing is placed after it (568,
  // 3100m, 4200m and 5300m missed, had 4400m and 5300m "made up" 28:22.7 and 28:22.8, between its finish read 28:22.6 in
  // 4200m and FinishLynx's 28:23.0)
  if (next.kind === 'finish' && prev.kind === 'split' && dur < FINISH_READ_TICKS) {
    return run.map((col) => ({ col, estimate: null, basis: `${prevText} is the finish read (${nextText}): there is no time for ${name(col)} after it.`, prev, next,
      frac: null, method: null, count: 0 }));
  }
  /** a reference runner's time at a column: the gun is 0, the finish is their finish */
  const timeOf = (r, c) => (c === -1 ? 0 : c === n ? (isTime(r.finish) ? r.finish : null) : (isTime(r.real?.[c]) ? r.real[c] : null));
  const refsFor = (cols) => {
    const refs = [];
    for (const r of others ?? []) {
      const a = timeOf(r, prev.col);
      const b = timeOf(r, next.col);
      if (a === null || b === null || !(b > a)) continue;
      let ok = true;
      for (const c of cols) {
        const t = timeOf(r, c);
        if (t === null || !(t > a && t < b)) {
          ok = false;
          break;
        }
      }
      if (ok) refs.push({ bib: r.bib, r, a, b, dur: b - a });
    }
    return refs;
  };
  const fracOf = (refs, c) => median(refs.map((x) => (timeOf(x.r, c) - x.a) / x.dur).sort(sortNum));
  const take = CHECK_RULES.nearest;
  const all = refsFor(run);
  const result = [];
  if (all.length) {
    const near = nearestIn(all, dur, take);
    for (const col of run) result.push({ col, frac: fracOf(near, col), method: 'nearest', count: near.length });
  } else {
    for (const col of run) {
      const refs = refsFor([col]);
      if (refs.length) {
        const near = nearestIn(refs, dur, take);
        result.push({ col, frac: fracOf(near, col), method: 'column', count: near.length });
      } else {
        // nobody to learn from yet: the run's splits evenly between the two references
        result.push({ col, frac: (col - prev.col) / (next.col - prev.col), method: 'even', count: 0 });
      }
    }
  }
  // strictly between the references, in course order, to the millisecond (a per-split median can cross over)
  let last = tp;
  const fracs = result.map((x) => x.frac).sort(sortNum);
  return result.map((x, i) => {
    let est = round10(tp + fracs[i] * dur);
    if (est <= last) est = last + 10;
    const room = run.length - i;
    if (est > tq - 10 * room) est = tq - 10 * room;
    last = est;
    const pct = `${(Math.round(((est - tp) / dur) * 1000) / 10).toFixed(1)}%`;
    const who = x.count === 1 ? 'the runner nearest in pace' : `the ${x.count} runners nearest in pace`;
    // (9.23 F13: "no other runner has a time there yet" was said with 169 runners' 5300m times there: what is missing is
    // a runner with times at both ends of the stretch and in it)
    const basis = x.method === 'even'
      ? `From ${prevText} and ${nextText}, evenly spaced: no other runner has times at both of them and at ${name(x.col)} yet (${name(x.col)} at ${pct} of that stretch).`
      : `From ${prevText} and ${nextText}, placed like ${who} (${name(x.col)} at ${pct} of that stretch).`;
    return { col: x.col, estimate: est > tp && est < tq ? est : null, basis, prev, next, frac: (est - tp) / dur, method: x.method, count: x.count };
  });
}

// ---- splits that look wrong (DESIGN 9.23 F6) --------------------------------------------------------------------------
//
// The column check above never looked at a runner whose every column is full (9.23 F13: now it does when the last one
// holds a counted pass, which may be the finish pass), and it never asks again about a pass the operator placed. On
// race day 2026-10-21 RR12's stream carried the finish line and cool-down passes too, so a runner who missed a mat had
// every column full (the finish counted as the last split) and nothing was flagged. This check is advice only: it
// compares each leg with the legs of the runners nearest in time at the split before it, and says which split (or the
// finish) the pass fits. It never holds or sends anything.

/**
 * The numbers of the look-wrong check, apart from CHECK_RULES (which holds passes). Measured on the real race and on
 * synthetic ones (DESIGN 9.23 F6).
 * - nearest: a leg is compared with those of this many other runners nearest in time at the split before it
 * - minRefs: with fewer such runners, no judgement
 * - longAbove / shortBelow: a leg longer (shorter) than this times theirs looks wrong
 * - strayBelow: a leg this short is a stray pass: "Not a split" is suggested
 * - fitWithin: a later split (or the finish) is suggested when the leg fits it within this factor ...
 * - betterBy: ... and fits it this many times better (in log terms) than the split it is in
 */
export const FIT_RULES = Object.freeze({ nearest: 30, minRefs: 5, longAbove: 1.6, shortBelow: 0.6, strayBelow: 0.25, fitWithin: 1.5, betterBy: 2 });

/**
 * @typedef {object} LegRunner  one runner as the look-wrong check takes it
 * @property {string} bib
 * @property {(number|null)[]} kept race ticks of the runner's kept crossing per column (real or made-up): the anchors
 * @property {(number|null)[]} real race ticks of the kept REAL crossings: what other runners are compared with
 * @property {number|null} finish the finish (FinishLynx, a finish read, a marked finish)
 * @property {number[]} passes race ticks of the runner's passes that are not set aside, sorted
 * @property {(null|'counted'|'kept'|'moved'|'seen')[]} look per column: whether its crossing is looked at: counted by
 *   Split Relay, kept by the operator from the check queue (a strong flag may still ask once), moved there by the
 *   operator (9.23 F15: "You moved 18:07.1 to 4400m, but it looks like 5300m"), 'seen' (the operator said it is right:
 *   a flag is only noted, silenced); null: not looked at (Move only this time, a made-up time, a timing point)
 * @typedef {{ col: number, from: number, kind: 'long'|'short', ratio: number, leg: number, fieldLeg: number,
 *   suggest: { to: number|'finish'|'none', toName: string, missed: string[], leg?: number } | null, fits: { to: number|'finish',
 *   toName: string, fit: number }[], text: string, silenced: boolean, kept: boolean }} LegFlag
 *   to: a column (0-based), 'finish' or 'none' (Not a split); leg: the runners' leg of the same pace to there
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** A leg to the second, always with its minutes: "6:45", "0:58". */
const legWords = (t) => {
  const sec = Math.max(0, Math.round(t / 10000));
  return sec < 60 ? `0:${String(sec).padStart(2, '0')}` : formatRaceTime(sec * 10000, 0);
};

/**
 * The field the check measures against, made once per race state: each column's real times in order, whether the
 * stream carries finish passes (the RR12 exporter sent the finish mat too, as on 2026-10-21), and each runner's finish
 * for the references: their finish, else (stream) their first pass after their real last split.
 * @param {{ n: number, runners: LegRunner[], finishPassStream?: boolean|null, near?: number }} args near (9.23 F19): a pass this
 *   close to a runner's known finish is its finish read (everySplitRead)
 */
export function legField({ n, runners, finishPassStream = null, near = 0 }) {
  const list = Array.isArray(runners) ? runners : [];
  const byCol = Array.from({ length: n }, () => []);
  for (const r of list) for (let c = 0; c < n; c++) if (isNum(r.real?.[c])) byCol[c].push(r);
  for (let c = 0; c < n; c++) byCol[c].sort((a, b) => a.real[c] - b.real[c] || (a.bib < b.bib ? -1 : a.bib > b.bib ? 1 : 0));
  // finish passes in the stream: at least 3 runners pass again soon after their real last split, and half of those
  // who got there long enough ago (finishPassesIn, as the column check takes it)
  const med = (c) => (byCol[c]?.length ? median(byCol[c].map((r) => r.real[c])) : null);
  const lastMed = n > 0 ? med(n - 1) : null;
  const prevMed = n > 1 ? med(n - 2) : 0;
  const gap = isNum(lastMed) && isNum(prevMed) && lastMed > prevMed ? lastMed - prevMed : null;
  const tail = new Map();
  const lasts = [];
  let now = -Infinity;
  for (const r of list) for (const p of r.passes ?? []) if (isNum(p) && p > now) now = p;
  for (const r of n > 0 ? byCol[n - 1] : []) {
    const t = r.real[n - 1];
    const next = (r.passes ?? []).find((p) => p > t);
    const soon = gap !== null && isNum(next) && next - t < 2 * gap;
    if (soon) tail.set(r, next);
    lasts.push({ t, next: soon ? next : null });
  }
  const stream = typeof finishPassStream === 'boolean' ? finishPassStream : finishPassesIn(lasts, now);
  const finOf = (r) => (isNum(r.finish) ? r.finish : stream ? tail.get(r) ?? null : null);
  // 9.23 F14: the field's finishes in order (the count fit's leaders and back of the field at the finish)
  const fins = list.map(finOf).filter(isNum).sort(sortNum);
  // (9.23 F17: whose finish is whose, for the back of the field without the runner itself: fieldBack)
  const finByBib = new Map(list.map((r) => [r.bib, finOf(r)]));
  // 9.23 F16: when a runner's finish pass would be in by now (its last pass this long before the race's latest one: the
  // bound finishPassesIn takes, twice the field's median leg from the last split to its finish pass), null without one
  const tailLegs = lasts.filter((x) => isNum(x.next)).map((x) => x.next - x.t).sort(sortNum);
  const finishWait = stream && tailLegs.length ? COUNT_RULES.finishAfter * median(tailLegs) : null;
  return { n, byCol, stream, finOf, fins, finByBib, now: isNum(now) ? now : null, finishWait, near };
}

/**
 * 9.23 F19: whether a runner has exactly one pass for every split before its known finish (FinishLynx's, a finish read,
 * a marked finish; a pass within `near` of it is its finish read): then no mat missed it, and no stray pass took a
 * split's place. A long leg is a slow one (a stop, a fall): the re-check of 2026-10-30 found runners who lost two to two
 * and a half minutes on one leg, every mat read, given the sure one click "Missed 3100m: add it" once FinishLynx's finish
 * was known ("13:14.4 looks like 4200m, not 3100m (missed 3100m?)"), which would have sent each later split a column late.
 * 9.23 F20: a short one is a stray pass's, which can make up for a missed mat in the count: no runner is complete with it.
 * @param {ReturnType<typeof legField>} field
 * @param {LegRunner} me
 */
export function everySplitRead(field, me) {
  if (!isNum(me?.finish)) return false;
  let count = 0;
  for (const p of me.passes ?? []) if (isNum(p) && p < me.finish - (field?.near ?? 0)) count++;
  if (count !== field.n) return false;
  // 9.23 F20: ... and no two of its crossings in splits next to each other closer in time than anybody covers that stretch
  // (CHECK_RULES.strayLeg x the leaders' leg, as the column check's strayIn): a stray pass made up for a missed mat
  for (let c = 0; c + 1 < field.n; c++) {
    const a = me.real?.[c];
    const b = me.real?.[c + 1];
    const lead = isNum(a) && isNum(b) ? fieldLeaderLeg(field, c) : null;
    if (lead !== null && b - a < CHECK_RULES.strayLeg * lead) return false;
  }
  // (or than the runner's own pace: ownShortAt)
  return ownShortAt(field, me).length === 0;
}

/**
 * 9.23 F20: on a field made by legField, the splits c of a runner with every split read whose leg on to c + 1 is far
 * shorter than the runner's own pace (ownShort, as the column check's strayLegs).
 */
function ownShortAt(field, me) {
  for (let c = 0; c < field.n; c++) if (!isNum(me.real?.[c])) return [];
  const legs = [];
  for (let c = 0; c + 1 < field.n; c++) {
    const lead = fieldLeaderLeg(field, c);
    if (lead !== null && lead > 0) legs.push({ i: c, x: (me.real[c + 1] - me.real[c]) / lead });
  }
  return ownShort(legs);
}

/**
 * 9.23 F20: the leaders' leg from split c to split c + 1 on a field made by legField (the median of the CHECK_RULES.leaders
 * fastest of the runners with a real crossing at both, as the column check's leaderLeg; 9.23 F21: leadersLeg, a stray's
 * leg left out), null with fewer. Worked out once per field.
 */
function fieldLeaderLeg(field, c) {
  const memo = (field.leadMemo ??= new Map());
  if (memo.has(c)) return memo.get(c);
  const legs = [];
  for (const r of field.byCol?.[c] ?? []) {
    const b = r.real?.[c + 1];
    if (isNum(b) && b > r.real[c]) legs.push(b - r.real[c]);
  }
  legs.sort(sortNum);
  const v = leadersLeg(legs);
  memo.set(c, v);
  return v;
}

/**
 * The up-to-`take` other runners nearest in time to `ta` at column a (two pointers over the column's sorted times) for
 * whom `at(o)` is later than their time at a, each with that stretch's duration.
 */
function nearestAt(field, me, a, ta, at, take) {
  const col = field.byCol[a] ?? [];
  let lo = 0;
  let hi = col.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (col[mid].real[a] < ta) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  let i = lo - 1;
  let j = lo;
  while (out.length < take && (i >= 0 || j < col.length)) {
    const left = i >= 0 ? ta - col[i].real[a] : Infinity;
    const right = j < col.length ? col[j].real[a] - ta : Infinity;
    const o = left <= right ? col[i--] : col[j++];
    if (o === me || o.bib === me.bib) continue;
    const t = at(o);
    if (isNum(t) && t > o.real[a]) out.push({ o, d: t - o.real[a] });
  }
  return out;
}

/**
 * How well a pass at race time t fits each column in `cols` (a split index, or n for the finish) at this runner's
 * pace: the leg from the runner's latest kept crossing before t, over the median of the same stretch of the runners
 * nearest in time there. 1 fits; 2 took twice as long. [] when there is no earlier crossing to measure from.
 * @returns {{ col: number, fit: number }[]}
 */
export function legFits(field, me, t, cols, rules = FIT_RULES) {
  let a = -1;
  for (let c = field.n - 1; c >= 0; c--) {
    if (isNum(me.kept?.[c]) && me.kept[c] < t) {
      a = c;
      break;
    }
  }
  if (a < 0) return [];
  const ta = me.kept[a];
  const out = [];
  for (const c of cols) {
    if (c <= a) continue;
    const refs = nearestAt(field, me, a, ta, (o) => (c === field.n ? field.finOf(o) : o.real?.[c]), rules.nearest);
    if (refs.length < rules.minRefs) continue;
    out.push({ col: c, fit: (t - ta) / median(refs.map((x) => x.d).sort(sortNum)) });
  }
  return out;
}

/**
 * DESIGN 9.23 F6, the look-wrong check: for each runner, the first crossing whose leg (from the nearest earlier kept
 * crossing) is far longer or shorter than the legs of the runners nearest in time at that earlier split. Later legs are
 * measured from an anchor that is wrong, so a runner has one flag at most. A long leg suggests the later split (or the
 * finish, for the last split or the runner's last pass) it fits best, when it fits that well; a very short one is a
 * stray pass. A crossing the operator said is right gives a silenced flag only.
 * @param {{ n: number, names: string[], runners: LegRunner[], finishPassStream?: boolean|null }} args
 * @param {typeof FIT_RULES} [rules]
 * @returns {Map<string, LegFlag>}
 */
export function legFlags({ n, names, runners, finishPassStream = null }, rules = FIT_RULES) {
  const field = legField({ n, runners, finishPassStream });
  const out = new Map();
  for (const me of runners ?? []) {
    const f = legFlagOf(field, me, names, rules);
    if (f) out.set(me.bib, f);
  }
  return out;
}

/** One runner's look-wrong flag (see legFlags), on a field made by legField; null when nothing looks wrong. */
export function legFlagOf(field, me, names, rules = FIT_RULES) {
  const n = field.n;
  // 9.23 F19: a pass for every split before the runner's known finish: no leg Split Relay counted is doubted (a long one
  // is a slow leg); a pass the operator placed still is
  const full = everySplitRead(field, me);
  let own = null;
  const name = (c) => (c === n ? 'the finish' : names?.[c] ?? `Split ${c + 1}`);
  let silenced = null;
  for (let b = 0; b < n; b++) {
    const look = me.look?.[b];
    const tb = me.real?.[b];
    if (!look || !isNum(tb) || (full && look === 'counted')) continue;
    let a = -1;
    for (let i = b - 1; i >= 0; i--) {
      if (isNum(me.kept?.[i])) {
        a = i;
        break;
      }
    }
    // the first split has no earlier one: the column check judges it (9.18 R2)
    if (a < 0) continue;
    const ta = me.kept[a];
    const leg = tb - ta;
    const refs = nearestAt(field, me, a, ta, (o) => o.real?.[b], rules.nearest);
    if (refs.length < rules.minRefs) continue;
    const fieldLeg = median(refs.map((x) => x.d).sort(sortNum));
    const ratio = leg / fieldLeg;
    // (9.23 F20: or shorter than anybody covers that stretch, CHECK_RULES.strayLeg x the leaders' leg, a pass counted in
    // the split after: one of the two passes is a stray, however near the runners of its pace come: 4200m missed and a read
    // 60 s after the runner's 4400m pass made its count complete, its leg on to 5300m 2:12 where the leaders took 3:05,
    // 0.68 of the runners of its pace, and nothing said so)
    const lead = b === a + 1 ? fieldLeaderLeg(field, a) : null;
    const leadShort = lead !== null && leg < CHECK_RULES.strayLeg * lead;
    // (or, every split read, shorter than the runner's own pace, CHECK_RULES.strayOwn: `ownStray`, the one click by a
    // misfit's worth only, as any other set)
    const ownStray = !leadShort && b === a + 1 && (own ??= ownShortAt(field, me)).includes(a);
    const stray = leadShort || ownStray;
    const kind = ratio > rules.longAbove ? 'long' : ratio < rules.shortBelow || stray ? 'short' : null;
    if (!kind) continue;
    let suggest = null;
    let fits = [];
    if (kind === 'long') {
      const last = !(me.passes ?? []).some((p) => p > tb);
      const cols = [];
      for (let c = b + 1; c < n; c++) cols.push(c);
      if (b === n - 1 || last) cols.push(n);
      const all = legFits(field, me, tb, cols, rules);
      let best = null;
      for (const f of all) if (!best || Math.abs(Math.log(f.fit)) < Math.abs(Math.log(best.fit))) best = f;
      if (best && Math.abs(Math.log(best.fit)) <= Math.log(rules.fitWithin) && Math.abs(Math.log(best.fit)) <= Math.abs(Math.log(ratio)) / rules.betterBy) {
        const missed = [];
        // (9.23 F16: to the finish, every split from this one on)
        for (let c = b; c < Math.min(best.col, n); c++) missed.push(name(c));
        // (9.23 F15: the words give the runners' leg to the split it looks like, as Passes to check does)
        suggest = { to: best.col === n ? 'finish' : best.col, toName: name(best.col), missed, leg: leg / best.fit };
      }
      fits = all.map((x) => ({ to: x.col === n ? 'finish' : x.col, toName: name(x.col), fit: x.fit }));
      // ... unless the pass before it is the one in the wrong split: two splits close together (4200m and 4400m on
      // 2026-10-21), the runner missed the first, and the pass counted there fits the second about as well, so only the
      // leg after it looks wrong. Then the fix is to move THAT pass (with the later ones).
      const earlier = shiftedBefore(field, me, { a, b, tb, last, cost: suggest ? Math.abs(Math.log(best.fit)) : Math.abs(Math.log(ratio)) }, name, rules);
      if (earlier) {
        if (earlier.look !== 'seen') return earlier.flag;
        silenced ??= earlier.flag;
        continue;
      }
    } else if (ratio < rules.strayBelow) suggest = { to: 'none', toName: 'Not a split', missed: [] };
    const kept = look === 'kept' || look === 'seen';
    const flag = { col: b, from: a, kind, ratio, leg, fieldLeg, suggest, fits, silenced: look === 'seen', kept, stray,
      ...(ownStray ? { ownStray } : {}),
      text: legFlagText({ t: tb, b, a, kind, leg, fieldLeg, suggest, kept, moved: look === 'moved' }, name) };
    if (look !== 'seen') return flag;
    silenced ??= flag;
  }
  return silenced;
}

/**
 * The earlier pass of a long leg as the one in the wrong split (see legFlagOf): the pass at a (counted, or kept from the
 * check queue) fits a later split up to b at the runner's pace better than a, and with it there the pass at b fits a
 * split after it; and both together fit better than the pass at b alone in a later split (`cost`, in log terms, with
 * the pass at a's own leg). Its flag is at a, suggesting that split; null when it does not explain the leg better.
 */
function shiftedBefore(field, me, { a, b, tb, last, cost }, name, rules) {
  const n = field.n;
  const look = me.look?.[a];
  const ta = me.real?.[a];
  if ((look !== 'counted' && look !== 'kept' && look !== 'seen') || !isNum(ta) || ta !== me.kept?.[a]) return null;
  let a2 = -1;
  for (let i = a - 1; i >= 0; i--) {
    if (isNum(me.kept?.[i])) {
      a2 = i;
      break;
    }
  }
  if (a2 < 0) return null;
  const t2 = me.kept[a2];
  const refs = nearestAt(field, me, a2, t2, (o) => o.real?.[a], rules.nearest);
  if (refs.length < rules.minRefs) return null;
  const fieldLeg = median(refs.map((x) => x.d).sort(sortNum));
  const ratio = (ta - t2) / fieldLeg;
  const colsA = [];
  for (let c = a + 1; c <= b && c < n; c++) colsA.push(c);
  const fitsA = legFits(field, me, ta, colsA, rules);
  let bestA = null;
  for (const f of fitsA) if (!bestA || Math.abs(Math.log(f.fit)) < Math.abs(Math.log(bestA.fit))) bestA = f;
  const costA = bestA ? Math.abs(Math.log(bestA.fit)) : Infinity;
  if (!bestA || costA > Math.log(rules.fitWithin) || costA >= Math.abs(Math.log(ratio))) return null;
  // the pass at b, measured from the pass at a in that split
  const kept = me.kept.slice();
  kept[a] = null;
  kept[bestA.col] = ta;
  const colsB = [];
  for (let c = bestA.col + 1; c < n; c++) colsB.push(c);
  if (last || b === n - 1 || !colsB.length) colsB.push(n);
  let bestB = null;
  for (const f of legFits(field, { ...me, kept }, tb, colsB, rules)) if (!bestB || Math.abs(Math.log(f.fit)) < Math.abs(Math.log(bestB.fit))) bestB = f;
  if (!bestB || Math.abs(Math.log(bestB.fit)) > Math.log(rules.fitWithin)) return null;
  if (costA + Math.abs(Math.log(bestB.fit)) >= cost + Math.abs(Math.log(ratio))) return null;
  const missed = [];
  for (let c = a; c < bestA.col; c++) missed.push(name(c));
  const suggest = { to: bestA.col, toName: name(bestA.col), missed };
  const kept2 = look === 'kept' || look === 'seen';
  const lead = kept2 ? `You kept ${at1(ta)} in ${name(a)}, but it looks like ${suggest.toName}` : `${at1(ta)} looks like ${suggest.toName}, not ${name(a)}`;
  const legB = tb - me.kept[a];
  const refsB = nearestAt(field, me, a, me.kept[a], (o) => o.real?.[b], rules.nearest);
  const theirs = refsB.length ? `, where runners of the same pace took ${legWords(median(refsB.map((x) => x.d).sort(sortNum)))}` : '';
  const text = `${lead} (missed ${missed.length > 1 ? `${missed.slice(0, -1).join(', ')} and ${missed[missed.length - 1]}` : missed[0]}?): `
    + `then ${at1(tb)} fits ${name(bestB.col)}. As counted, ${at1(tb)} comes ${legWords(legB)} after ${name(a)}${theirs} to ${name(b)}.`;
  return {
    look,
    flag: { col: a, from: a2, kind: 'long', ratio, leg: ta - t2, fieldLeg, suggest, silenced: look === 'seen', kept: kept2,
      fits: fitsA.map((x) => ({ to: x.col, toName: name(x.col), fit: x.fit })), text },
  };
}

/**
 * The words of a look-wrong flag: "16:10.8 looks like 4200m, not 3100m (missed 3100m?): 6:45 after 2400m, where
 * runners of the same pace took 6:52." (9.23 F15: their leg to the split it looks like, as Passes to check says it;
 * F6 gave their leg to the split it is in, 2:44, which read as the leg to 4200m. 9.23 F16: the finish form too: "22:27.4
 * looks like the finish, not 4200m (missed 4200m, 4400m and 5300m?): 11:27 after 3100m, where runners of the same pace
 * took 11:35.", not "… took 4:17 to 4200m")
 */
function legFlagText({ t, b, a, kind, leg, fieldLeg, suggest, kept, moved = false }, name) {
  const at = at1(t);
  const legs = `${legWords(leg)} after ${name(a)}`;
  const theirs = legWords(fieldLeg);
  const list = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
  const lead = (what) => (kept ? `You kept ${at} in ${name(b)}, but it looks like ${what}` : moved ? `You moved ${at} to ${name(b)}, but it looks like ${what}`
    : `${at} looks like ${what}, not ${name(b)}`);
  if (kind === 'long') {
    // (9.23 F16: the finish form as the others and as Passes to check says it: the splits missed, their leg to the finish)
    if (suggest?.to === 'finish') return `${lead('the finish')} (missed ${list(suggest.missed)}?): ${legs}, where runners of the same pace took ${legWords(suggest.leg ?? fieldLeg)}.`;
    if (suggest) return `${lead(suggest.toName)}${suggest.missed.length ? ` (missed ${list(suggest.missed)}?)` : ''}: ${legs}, where runners of the same pace took ${legWords(suggest.leg ?? fieldLeg)}.`;
    return `${at} comes late for ${name(b)}: ${legs}, where runners of the same pace took ${theirs}. A missed mat?`;
  }
  if (suggest?.to === 'none') return `${at} comes soon after ${name(a)} (${legWords(leg)}; runners of the same pace took ${theirs}). A stray pass?`;
  return `${at} comes soon after ${name(a)} for ${name(b)} (${legWords(leg)}; runners of the same pace took ${theirs}).`;
}

// ---- how many mats in a row (DESIGN 9.23 F14) --------------------------------------------------------------------------
//
// The column check places a pass at most one split further than counting does, and a look-wrong flag measures one leg,
// so two missed mats in a row looked like one: on the re-check of 2026-10-27, 459 (2400m and 3100m missed) was offered
// "Missed 2400m: add it", and its one click sent its 4200m time as 3100m, its 4400m as 4200m and its finish pass as
// 5300m. How many splits a mat missed is settled by all of the runner's later passes together.

/**
 * The numbers of the count fit (missedCounts), measured on the real race of 2026-10-21 (every complete runner with one,
 * two and three mats in a row taken out, at the end and right after the passes that moved on) and on synthetic races
 * (DESIGN 9.23 F14). Costs are in log terms, as the look-wrong check's fits (0: fits; 0.69: twice or half as long).
 * - misfit: a pass that fits worse than FIT_RULES.fitWithin costs this much, however far off: a second missed mat
 *   further on makes every count misfit there alike, and must not decide the first
 * - extra: a pass past the finish (a cool-down pass, or a pass a larger count leaves no split) costs this much
 * - perMat: each mat missed after the first costs this much (one missed mat is likelier than two), when the runner
 *   has a crossing before them to measure from
 * - margin: a count fits clearly best when every other count costs at least this much more
 * - doubt (9.23 F16): where the runner's passes are measured (missedStarts), the margin grows by this share of what
 *   the best placing's own legs cost: a runner whose legs fit loosely however they are placed (568, a walker who
 *   faded to 1.5 times the runners of the same pace on the last leg) is not judged as closely as one whose legs fit
 * - finishAfter (9.23 F16): when the stream carries finish passes, a placing that puts none of the runner's passes at
 *   the finish costs one more missed mat (the finish mat) once the runner's finish pass would be in: its last pass this
 *   many times the field's median leg from the last split to the finish before the race's latest pass, the bound of
 *   finishPassesIn (408, 4200m and 5300m missed: its finish read as 5300m left no pass at the finish)
 * - winner (9.23 F16): a first pass with nothing before it, placed before the leaders at a split by no more than this
 *   share of their time there, may be the race winner's when that placing finishes it among the leaders: not measured,
 *   not out (the winner who missed the first two mats of an 8K was given the one click of one)
 */
export const COUNT_RULES = Object.freeze({ misfit: Math.log(FIT_RULES.fitWithin), extra: 0.2, perMat: 0.1, margin: 0.15, doubt: 0.1, finishAfter: 2, winner: 0.9 });

/**
 * @typedef {{ t: number, col: number, from: number|null, fit: number|null, leg: number|null, theirs: number|null }} CountPass
 *   one of the runner's later passes as a count places it: col a split (0-based), n the finish, -1 an extra pass; from:
 *   the column it is measured from (-1 the gun); fit (leg over theirs, the median leg of the runners nearest in time)
 *   when it is measured
 * @typedef {{ count: number, cost: number, out: boolean, unknown: boolean, path: CountPass[] }} CountFit  out: the count
 *   puts a pass where it can't be (before the leaders, well after the back of the field at the first split, where
 *   nobody has been yet, between the last split and the runner's finish); unknown: the pass that moved on can't be
 *   measured there yet (a runner at the front, or too few runners near in time there); a later one that can't be ends
 *   the measuring
 */

/**
 * What every placing of the count fit is measured from (missedCounts, missedStarts): the runner's latest kept crossing
 * before column k (a = -1: none, the gun), its finish when known, the leaders' reference and the back of the field at a
 * column, and whether the runner is among the first at that crossing.
 */
function countFrame(field, me, k, finish) {
  const n = field.n;
  let a = -1;
  for (let c = Math.min(k, n) - 1; c >= 0; c--) {
    if (isNum(me.kept?.[c])) {
      a = c;
      break;
    }
  }
  const ta = a >= 0 ? me.kept[a] : 0;
  // the leaders' reference at a column (the median of the first CHECK_RULES.leaders there), and the back of the field
  const firsts = (c) => (c < n ? (field.byCol[c] ?? []).slice(0, CHECK_RULES.leaders).map((o) => o.real[c]) : (field.fins ?? []).slice(0, CHECK_RULES.leaders));
  const lead = (c) => {
    const l = firsts(c);
    return l.length ? median(l) : null;
  };
  // (9.23 F17: `last`, the field's last crossing there, and `run`, the end of its unbroken run from the leaders; for a
  // set of missed splits the others', fieldBack; for the passes where they are, `own`, the field's last with the runner
  // itself, as F16 took it for every placing: a late start or a walker is never moved for being slow)
  const backs = [];
  const back = (c, own = false) => {
    if (own) {
      // (9.23 F20: with the runner itself also when the column check holds it, and its crossings are no reference for the
      // others: a late starter a minute behind the field's last at 800m, its 4400m missed (4200m and 5300m too), had every
      // placing out once FinishLynx's finish was known, and the column check's "Missed 4200m" was the sure one click)
      let B = c < n ? field.byCol[c]?.at(-1)?.real[c] ?? null : field.fins?.at(-1) ?? null;
      const mine = c < n ? me.kept?.[c] : null;
      if (isNum(mine) && (!isNum(B) || mine > B)) B = mine;
      return { last: B, run: B };
    }
    if (backs[c] === undefined) backs[c] = fieldBack(field, me, c, lead(c));
    return backs[c];
  };
  // a runner among the first at its crossing before k may be where nobody has been yet: not measured yet, not out
  const at = field.byCol[a] ?? [];
  const front = a >= 0 && at.length > 0 && (at.length < CHECK_RULES.leaders || ta <= at[CHECK_RULES.leaders - 1].real[a]);
  return { a, ta, fin: isNum(finish) ? finish : null, lead, back, front };
}

/**
 * 9.23 F17: the back of the field at column c (n: the finish) for a set of missed splits, from the OTHER runners'
 * crossings there: `last`, the last of them, and `run`, the end of their unbroken run from the leaders' reference L,
 * each within CHECK_RULES.tailGap of the one before (the column check's tail of the field), which a pass of another
 * runner a mat missed (counted a split or more early, far behind everyone) does not stretch. The runner's own crossing
 * there is no part of either: 491, a walker who missed 800m, 2400m and 3100m, had its 1500m pass, 6:03.9, counted in
 * 800m, the last there, so "Missed 1500m, 2400m and 3100m", which left it in 800m three minutes behind every other runner
 * (by 3:08), was measured as fitting and was the one click. Nulls with nobody there.
 * @returns {{ last: number|null, run: number|null }}
 */
function fieldBack(field, me, c, L) {
  let times;
  if (c < field.n) times = (field.byCol[c] ?? []).filter((o) => o !== me && o.bib !== me.bib).map((o) => o.real[c]);
  else {
    times = (field.fins ?? []).slice();
    const mine = field.finByBib?.get(me.bib);
    const i = isNum(mine) ? times.indexOf(mine) : -1;
    if (i >= 0) times.splice(i, 1);
  }
  let u = null;
  for (const t of times) {
    if (isNum(L) && t > Math.max(u ?? L, L) * CHECK_RULES.tailGap) break;
    u = Math.max(u ?? t, t);
  }
  return { last: times.length ? times[times.length - 1] : null, run: u };
}

/**
 * 9.23 F17: whether a pass at race time t is far past the back of the field at column c, the others' (fieldBack), by
 * more than CHECK_RULES.tailGap: where the column check finds a pass implausible. For a runner's first pass, with no
 * crossing before it to measure a leg from, it is what says a mat missed it when nothing else does (221).
 * @param {ReturnType<typeof legField>} field
 * @param {LegRunner} me
 * @param {number} c
 * @param {number} t
 */
export function pastField(field, me, c, t) {
  const B = fieldBack(field, me, c, countFrame(field, me, 0, null).lead(c)).run;
  return isNum(B) && isNum(t) && t > B * CHECK_RULES.tailGap;
}

/**
 * The runners' median leg from column a, nearest in time to ta there, to column c (n: the finish), as countPath measures
 * a leg; null with fewer than FIT_RULES.minRefs of them. 9.23 F20: worked out once per field and runner (the placings of
 * one runner share their legs, and F20 weighs more of them: three runs apart, the stray passes set aside).
 */
function theirsAt(field, me, a, ta, c) {
  const memo = (field.theirsMemo ??= new Map());
  const key = `${me.bib}|${a}|${ta}|${c}`;
  if (memo.has(key)) return memo.get(key);
  const refs = nearestAt(field, me, a, ta, (o) => (c === field.n ? field.finOf(o) : o.real?.[c]), FIT_RULES.nearest);
  const v = refs.length < FIT_RULES.minRefs ? null : median(refs.map((x) => x.d).sort(sortNum));
  memo.set(key, v);
  return v;
}

/**
 * One placing of a runner's passes, measured as the count fit measures it (missedCounts, missedStarts): event i (the
 * passes in time order, then the runner's known finish) in column colAt(i), n and more past the last split. Each pass
 * is measured as the look-wrong check measures a leg (legFits): from the crossing before it in this placing, against
 * the runners nearest in time there; after the first, as a change from the runner's own pace on the leg before it.
 * Events before `m` are where they are: whether the placing can be measured yet is said by the pass that moved on.
 * 9.23 F16: a placing that puts no pass at the finish, when the stream carries finish passes and the runner's finish
 * pass would be in by now (COUNT_RULES.finishAfter), has the finish mat missed too: one more missed mat.
 * @returns {{ cost: number, legs: number, raw: number, out: boolean, unknown: boolean, path: CountPass[] }} legs: what
 *   the measured legs cost of it (not the extra passes and the missed mats); raw (9.23 F17): what they are off by in
 *   full, no leg capped at COUNT_RULES.misfit (startMargin)
 */
function countPath(field, me, ctx, events, colAt, m, rules) {
  const n = field.n;
  const { fin, lead, back, front, own = false } = ctx;
  const path = [];
  let cost = 0;
  let legs = 0;
  // (9.23 F17: what the measured legs are off by in full, a misfit's leg not capped: startMargin)
  let raw = 0;
  let out = false;
  let unknown = false;
  let pc = ctx.a;
  let pt = ctx.ta;
  let done = false;
  let lf0 = null;
  for (let i = 0; i < events.length; i++) {
    const t = events[i];
    const isFin = fin !== null && i === events.length - 1;
    let c = isFin ? n : colAt(i);
    if (!isFin && (c >= n || done)) {
      // past the last split: between it and the runner's known finish no pass can be; else the stream's finish pass,
      // then extra passes (not before the leaders at the last split)
      if (fin !== null) {
        out = true;
        break;
      }
      if (!done && field.stream) c = n;
      else {
        const L = lead(n - 1);
        if (L === null || t < CHECK_RULES.floor * L) {
          out = true;
          break;
        }
        path.push({ t, col: -1, from: null, fit: null, leg: null, theirs: null });
        cost += rules.extra;
        done = true;
        continue;
      }
    }
    // where nobody has been yet a pass can't be (the column check's rule), unless the runner is at the front: then it
    // can't be measured yet (a count is measured up to there once the pass that moved on is)
    const measured = path.slice(m).some((p) => p.fit !== null);
    const L = lead(c);
    if (L === null) {
      if (!front) out = true;
      else if (!measured) unknown = true;
      break;
    }
    if (pc < 0) {
      // the first split missed: nothing to measure the pass from; it is only not before the leaders there, and not
      // well after the back of the field (9.23 F16: a leader can be before them: it can't be measured, not out. 9.23
      // F17: a pass a set of missed splits puts there, after the others' last, fieldBack; a pass where it was counted,
      // after the field's last with the runner itself, as F16 took it: a walker is there, however far behind)
      const B = back(c, own || i < m);
      if (t < CHECK_RULES.floor * L || (isNum(B.last) && t > B.last * CHECK_RULES.tailGap)) {
        // (9.23 F16: a little before the leaders, by a winner's lead (COUNT_RULES.winner), is no bound for a runner this
        // placing finishes among the leaders: the race winner who missed the first two mats was given the one click of
        // one, the truth "before the leaders"; it can't be measured, not out)
        const li = events.length - 1;
        const finT = fin !== null ? fin : field.stream && li > i && colAt(li) >= n ? events[li] : null;
        const fins = field.fins ?? [];
        if (t < CHECK_RULES.floor * L && t >= rules.winner * L && finT !== null && fins.length >= CHECK_RULES.leaders && finT <= fins[CHECK_RULES.leaders - 1]) unknown = true;
        else out = true;
        break;
      }
      // (9.23 F16: past the slowest runner there it costs what it is past, in log terms, at most a misfit: the field's
      // slowest are no reference for its pace. 1K and 3K missed on a course of even splits: "2K" left its 2K pass, 8:55.6,
      // in 1K, past everyone there, and fitted a little better than the two mats apart with nothing against it. 9.23 F17:
      // for a set of missed splits, past the end of the others' unbroken run (fieldBack), all of it: a pass far behind
      // everyone at the first split is no one leg that fits badly, and a set that leaves it there explains nothing of it.
      // 491's 6:03.9 in 800m, 1.9 times the slowest runner's 3:08, cost as much as 1.5 times, and "Missed 1500m, 2400m and
      // 3100m", which left it there, was the one click)
      const O = own ? B : back(c);
      if (isNum(O.run) && t > O.run) {
        const past = own ? Math.min(rules.misfit, Math.log(t / O.run)) : Math.log(t / O.run);
        cost += past;
        legs += past;
        raw += Math.log(t / O.run);
      }
      path.push({ t, col: c, from: -1, fit: null, leg: null, theirs: null });
    } else {
      const theirs = theirsAt(field, me, pc, pt, c);
      if (theirs === null) {
        if (!measured) unknown = true;
        break;
      }
      const fit = (t - pt) / theirs;
      path.push({ t, col: c, from: pc, fit, leg: t - pt, theirs });
      // the first leg against the runners of the same pace; each later one against the runner's own pace on the leg
      // before it (a runner who slows down on the last legs is as slow there whatever the count)
      const lf = Math.log(fit);
      const leg = Math.min(rules.misfit, Math.abs(lf0 !== null ? lf - lf0 : lf));
      cost += leg;
      legs += leg;
      raw += Math.abs(lf0 !== null ? lf - lf0 : lf);
      lf0 = lf;
    }
    pc = c;
    pt = t;
    if (c === n) done = true;
  }
  // (9.23 F16: no pass at the finish although the stream carries the finish passes and the runner's would be in by now
  // (legField's finishWait after its last pass): the finish mat missed it too, one more missed mat. 408, 4200m and 5300m
  // missed: "Missed 4400m: add it" left its finish read in 5300m and nothing at the finish, and fitted about as well as
  // the two mats apart, a set with its finish read at the finish)
  const last = (me.passes ?? []).at(-1);
  if (!out && !unknown && !done && fin === null && field.stream && path.length && isNum(field.finishWait) && isNum(field.now) && isNum(last)
    && last + field.finishWait <= field.now) cost += rules.perMat;
  return { cost, legs, raw, out, unknown, path };
}

/**
 * DESIGN 9.23 F14: how many splits in a row a mat missed a runner, from the fit of all of its later passes. For each
 * count from 1 to n - k, the pass counted in column k and every pass after it (`passes`, in time order) move on that
 * many columns; past the last split the first of them is the finish (when the stream carries finish passes), the rest
 * extra passes; with the runner's finish known (FinishLynx, a finish read, a marked finish) a pass within `near` of it
 * is that finish, and the finish is measured last. Each pass is measured as the look-wrong check measures a leg
 * (legFits): from the runner's crossing before it in that placing (before k: its latest kept crossing), against the
 * runners nearest in time there; after the first, as a change from the runner's own pace on the leg before it (a
 * runner who fades over the last legs fades whatever the count). A count counts only where the pass that moved on first
 * fits (within FIT_RULES.fitWithin): the count is about that pass. One count is sure when it costs clearly least
 * (COUNT_RULES.margin) and no count is left that can't be measured yet; two that fit about as well are both offered
 * (`alt`), and Split Relay says it can't tell which.
 * @param {ReturnType<typeof legField>} field
 * @param {LegRunner} me
 * @param {number} k the column whose pass moves on
 * @param {number[]} passes race ticks of the pass in column k and of every later pass of the runner, in time order
 * @param {{ finish?: number|null, near?: number, none?: boolean, upTo?: number }} [opts] none: also the passes where
 *   they are (count 0: no mat missed), as `none`, to tell whether a mat was missed at all; upTo (9.23 F15): the column
 *   of a time the operator set further on (a made-up or typed time): `passes` are the ones before it, and a count that
 *   puts one of them there or past it is out (two mats missed apart, each added: 1500m and 3100m)
 * @param {typeof COUNT_RULES} [rules]
 * @returns {{ count: number|null, alt: number|null, sure: boolean, open: boolean, fits: CountFit[], none?: CountFit }}
 *   count: the count that fits best (null: none fits); alt: another one that fits about as well; open: a count can't be
 *   measured yet
 */
export function missedCounts(field, me, k, passes, { finish = null, near = 0, none = false, upTo = field.n } = {}, rules = COUNT_RULES) {
  const n = field.n;
  const ctx = countFrame(field, me, k, finish);
  const list = (passes ?? []).filter((t) => isNum(t) && (ctx.fin === null || t < ctx.fin - near));
  const events = ctx.fin !== null ? [...list, ctx.fin] : list;
  const fits = [];
  for (let count = none ? 0 : 1; k + count <= n; count++) {
    const p = countPath(field, me, count ? ctx : { ...ctx, own: true }, events, (i) => k + count + i, 0, rules);
    if (ctx.a >= 0) p.cost += rules.perMat * Math.max(0, count - 1);
    if (upTo < n && k + count + list.length > upTo) p.out = true;
    fits.push({ count, ...p });
  }
  const zero = none ? fits.shift() : undefined;
  // (the pass that moved on first; with the first split missed it has nothing to be measured from: no count is out by it)
  const firstFit = (f) => f.path[0]?.fit ?? null;
  const ok = fits.filter((f) => !f.out && !f.unknown && (firstFit(f) === null || Math.abs(Math.log(firstFit(f))) <= Math.log(FIT_RULES.fitWithin)))
    .sort((x, y) => x.cost - y.cost || x.count - y.count);
  // open: a count is left that can't be measured yet, or three fit about as well (a first split missed and one pass
  // so far): no count is sure, and none is offered beside the best
  const [best, second, third] = ok;
  const open = fits.some((f) => f.unknown) || (!!third && third.cost - best.cost < rules.margin);
  if (!ok.length) return { count: null, alt: null, sure: false, open, fits, none: zero };
  const close = !!second && second.cost - best.cost < rules.margin;
  return { count: best.count, alt: close && !open ? second.count : null, sure: !close && !open, open, fits, none: zero };
}

/**
 * DESIGN 9.23 F15: where a run of missed mats starts, from the fit of all of the runner's passes from column w on.
 * missedCounts takes the start it is given; the column check and a look-wrong flag point at the pass they doubt, which
 * is not always the first that moved on: 561 (4200m and 4400m missed) had its 5300m pass in 4200m at the back of the
 * field's times there, so the check held its finish pass in 4400m, and "Missed 4400m: add it" sent the finish pass as
 * 5300m; 547's 4400m pass counted in 4200m (200 m before) fits both. Each start k in `starts` and each count is one
 * placing: the passes before column k where they are, the one in k and every later one `count` columns on; with a
 * second run from a later start k2 (two mats missed apart: from the pass in k2 on, count + count2 columns on); the
 * passes where they are (count 0) too. All of them are measured over the same passes, from the runner's crossing
 * before w, with missedCounts' rules (countPath, COUNT_RULES), so their costs compare.
 * @param {ReturnType<typeof legField>} field
 * @param {LegRunner} me
 * @param {number} w the first column of the window: the runner's crossings before it are where they are
 * @param {{ t: number, col: number }[]} passes the runner's passes from the one in column w on, in time order: col the
 *   column it is counted in (n and more: past the last split)
 * @param {number[]} starts the columns whose pass may be the first that moved on
 * @param {{ finish?: number|null, near?: number }} [opts]
 * @param {typeof COUNT_RULES} [rules]
 * @returns {{ ok: StartFit[], loose: StartFit[], none: CountFit, open: boolean }} ok: the placings that can be (none out,
 *   none that can't be measured yet, the first pass of each run fits), cheapest first; open (9.23 F16): a placing can't
 *   be measured yet (the runner at the front), so none is sure; loose (9.23 F16): the placings of two runs
 *   whose second run's first pass fits loosely (worse than FIT_RULES.fitWithin, a runner who faded on the last leg: 568's
 *   finish read, 1.52 times the runners' leg from 4400m), never the one click but a set that fits about as well; none:
 *   the passes where they are
 * @typedef {CountFit & { k: number, k2: number|null, count2: number, k3: number|null, count3: number, first: number,
 *   second: number|null, third: number|null, trail: { k: number, count: number, t: number, col: number } | null }} StartFit
 *   first: the index of the pass that moved on first; second: of the second run's (k2's pass), null with one run; third
 *   (9.23 F20): of a third run's (k3's pass, one mat), null without; trail
 *   (9.23 F17): the splits the runner's finish read would be left in, with the runner's finish known: missed too (k the
 *   first of them, t and col the finish read's time and the column it is counted in now)
 */
export function missedStarts(field, me, w, passes, starts, { finish = null, near = 0 } = {}, rules = COUNT_RULES) {
  const n = field.n;
  const ctx = countFrame(field, me, w, finish);
  const list = (passes ?? []).filter((p) => isNum(p?.t) && (ctx.fin === null || p.t < ctx.fin - near));
  const events = list.map((p) => p.t);
  if (ctx.fin !== null) events.push(ctx.fin);
  const none = { k: null, count: 0, ...countPath(field, me, { ...ctx, own: true }, events, (i) => list[i].col, 0, rules) };
  // 9.23 F17: the runner's finish read counted in a split now, with its finish known (the passes from near it on are that
  // finish, measured last): a placing that leaves it in a split misses every split from there to the finish too. 441
  // (3100m and 5300m missed, a finisher): "Missed 3100m" put its finish read in 5300m, and 5300m took a second one click
  const finRead = ctx.fin === null ? null : (passes ?? []).find((p) => isNum(p?.t) && p.t >= ctx.fin - near) ?? null;
  const trailOf = (shift) => {
    if (!finRead || !(finRead.col < n) || finRead.col + shift >= n) return null;
    return { k: finRead.col + shift, count: n - finRead.col - shift, t: finRead.t, col: finRead.col };
  };
  const ok = [];
  const loose = [];
  let open = false;
  // (the pass that moved on first must fit there; an extra pass is not measured, so it says nothing for its count)
  const fits = (x) => !!x && x.col !== -1 && (x.fit === null || Math.abs(Math.log(x.fit)) <= Math.log(FIT_RULES.fitWithin));
  const at = (k) => list.findIndex((p) => p.col === k);
  for (const k of starts) {
    const m = at(k);
    if (m < 0) continue;
    for (let count = 1; k + count <= n; count++) {
      // one run of `count` missed mats from k; or two (9.23 F15: two mats missed apart, 447's 2400m and 4400m): a second
      // run of count2 from the pass in k2, every pass from it on count + count2 columns on. Each run's first pass must fit
      const runs = [[null, 0, null, 0]];
      for (const k2 of starts) {
        if (k2 <= k) continue;
        for (let count2 = 1; k2 + count + count2 <= n; count2++) {
          runs.push([k2, count2, null, 0]);
          // (9.23 F20: and a third, three single mats missed apart: the re-check's 410, 800m, 2400m and 4200m missed with
          // FinishLynx's finish known, was offered two sets of three, neither right: a third run was no placing at all)
          if (count === 1 && count2 === 1) for (const k3 of starts) if (k3 > k2 && k3 + count + count2 + 1 <= n) runs.push([k2, count2, k3, 1]);
        }
      }
      for (const [k2, count2, k3, count3] of runs) {
        const m2 = k2 === null ? list.length + 1 : at(k2);
        const m3 = k3 === null ? list.length + 1 : at(k3);
        if (m2 < 0 || m3 < 0) continue;
        const p = countPath(field, me, ctx, events, (i) => list[i].col + (i < m ? 0 : i < m2 ? count : i < m3 ? count + count2 : count + count2 + count3), m, rules);
        const trail = trailOf(count + count2 + count3);
        // (each mat after the first costs perMat; the first run's only when its first pass has a crossing before it to be
        // measured from, a second run's always: 9.23 F16, a second run is no free guess after the first split missed.
        // 9.23 F18: a finisher's trail too, the splits its finish read would be left in: they are missed mats as much as a
        // second run's. 568, a walker who missed 3100m, 4200m and 5300m, a finisher: "3100m, 4400m and 5300m" (one mat in
        // its run, two in its trail) paid for none of the three, the right set (two in its run, one in its trail) for one,
        // and was the sure one click, its real 4400m sent as 4200m)
        p.cost += rules.perMat * ((ctx.a >= 0 || m > 0 ? Math.max(0, count - 1) : 0) + count2 + count3 + (trail ? trail.count : 0));
        if (p.unknown && !p.out) open = true;
        if (p.out || p.unknown || !fits(p.path[m])) continue;
        // (9.23 F17: a placing that measures none of the runner's passes from the one that moved on is no fit at all: 202,
        // a walker on a synthetic 5K who missed 1.5K, had "Missed 1.5K, 2.5K and 4K" as its one click, its 2.5K pass the
        // finish and the rest cool-down passes, nothing measured)
        if (!p.path.slice(m).some((q) => q.fit !== null)) continue;
        const x = { k, count, k2, count2, k3, count3, ...p, first: m, second: k2 === null ? null : m2, third: k3 === null ? null : m3, trail };
        // (an extra pass that starts the second run says nothing for it: out, as for the first; 9.23 F20: so the third's.
        // 9.23 F21: a third run whose pass fits loosely is a set that fits about as well too, as a second run's is: 154, a
        // walker who faded, 800m, 4200m and 5300m missed, its finish read 1.6 times the runners' leg from its 4400m pass,
        // had "Missed 800m, 4400m and 5300m" as the sure one click with nothing beside it, its real 4400m pass sent as 4200m)
        if ((k2 === null || fits(p.path[m2])) && (k3 === null || fits(p.path[m3]))) ok.push(x);
        else if (p.path[m2] && p.path[m2].col !== -1 && (k3 === null || (fits(p.path[m2]) && p.path[m3] && p.path[m3].col !== -1))) loose.push(x);
      }
    }
  }
  const byCost = (x, y) => x.cost - y.cost || x.k - y.k || x.count - y.count || (x.k2 ?? -1) - (y.k2 ?? -1) || (x.k3 ?? -1) - (y.k3 ?? -1);
  ok.sort(byCost);
  loose.sort(byCost);
  return { ok, loose, none, open };
}

/**
 * 9.23 F16: how much cheaper the best placing of missedStarts must be than any other to be the one click:
 * COUNT_RULES.margin, and more by COUNT_RULES.doubt of what the best placing's own legs cost (a runner whose legs fit
 * loosely however they are placed is not judged as closely). 9.23 F17: what they are off by in full (`raw`), a leg that
 * misfits not capped at COUNT_RULES.misfit: a walker 40 % slower than the slowest runner at every split (a synthetic 5K)
 * had its last leg 6.5 times the runners', and "missed 1K and 3K" was the one click by the margin of a runner who fits.
 * @param {{ legs?: number, raw?: number }} best
 * @param {typeof COUNT_RULES} [rules]
 */
export function startMargin(best, rules = COUNT_RULES) {
  return rules.margin + rules.doubt * (isNum(best?.raw) ? best.raw : isNum(best?.legs) ? best.legs : 0);
}

/**
 * The words of a count fit for the pass that moves on (at race time t, counted in column k): "15:18.4 looks like 4200m,
 * not 2400m (missed 2400m and 3100m?): 10:21 after 1500m, where runners of the same pace took 10:16."; two that fit
 * about as well: "15:18.4 looks like 4200m or 4400m, not 2400m: Split Relay can't tell which (missed 2400m and 3100m,
 * or 2400m, 3100m and 4200m?)."; one that can't be measured yet: "…, but Split Relay can't tell yet how many."
 * @param {ReturnType<typeof missedCounts>} res
 * @param {number} t
 * @param {number} k
 * @param {string[]} names split names, course order
 * @param {{ now?: number }} [opts] the column the pass is in now when it is not k (after made-up times: "…, not 3100m")
 */
export function missedCountText(res, t, k, names, { now = k } = {}) {
  const n = names.length;
  const name = (c) => (c >= n ? 'the finish' : names[c] ?? `Split ${c + 1}`);
  const list = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
  const missed = (count) => list(Array.from({ length: count }, (_, i) => name(k + i)));
  const at = at1(t);
  if (res.alt !== null && res.alt !== undefined) {
    const [x, y] = [res.count, res.alt].sort((p, q) => p - q);
    return `${at} looks like ${name(k + x)} or ${name(k + y)}, not ${name(now)}: Split Relay can't tell which (missed ${missed(x)}, or ${missed(y)}?).`;
  }
  const fit = res.fits.find((f) => f.count === res.count);
  const p = fit?.path.find((x) => x.fit !== null && x.from !== null && x.from >= 0) ?? null;
  const why = p && p.t === t ? `: ${legWords(p.leg)} after ${name(p.from)}, where runners of the same pace took ${legWords(p.theirs)}` : '';
  return `${at} looks like ${name(k + res.count)}, not ${name(now)} (missed ${missed(res.count)}?)${why}${res.sure ? '' : ', but Split Relay can\'t tell yet how many'}.`;
}

/**
 * The splits a placing of missedStarts leaves to be added, course order: its first run from k, and its second run's
 * (9.23 F16: two mats missed apart) from where the pass of k2 lands less count2. Each run as { k, count }. 9.23 F17:
 * and a finisher's trail, the splits from where its finish read would land to the finish (441's 5300m).
 * @param {{ k: number, count: number, k2: number|null, count2: number, trail?: { k: number, count: number } | null }} x
 * @returns {{ k: number, count: number }[]}
 */
export function startRuns(x) {
  const runs = x.k2 === null || !x.count2 ? [{ k: x.k, count: x.count }] : [{ k: x.k, count: x.count }, { k: x.k2 + x.count, count: x.count2 }];
  // (9.23 F20: a third run, three mats missed apart)
  if (x.k2 !== null && x.count2 && x.k3 !== null && x.k3 !== undefined && x.count3) runs.push({ k: x.k3 + x.count + x.count2, count: x.count3 });
  return x.trail ? [...runs, { k: x.trail.k, count: x.trail.count }] : runs;
}

/**
 * 9.23 F16: the words of two runs of missed mats apart (a placing of missedStarts, sure): where the pass that moved on
 * first goes and where the second run's pass goes, the splits to add, and the leg of the first as missedCountText says
 * it: "17:56.2 looks like 4400m, not 4200m, and 28:22.6 like the finish, not 4400m (missed 4200m and 5300m?): 5:53 after
 * 3100m, where runners of the same pace took 5:44."
 * @param {StartFit} x
 * @param {string[]} names split names, course order
 * @param {{ sure?: boolean }} [opts] sure false: a placing could not be measured yet ("…, but Split Relay can't tell yet.")
 */
export function missedRunsText(x, names, { sure = true } = {}) {
  const n = names.length;
  const name = (c) => (c >= n ? 'the finish' : names[c] ?? `Split ${c + 1}`);
  const list = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
  const runs = startRuns(x);
  const missed = runs.flatMap((r) => Array.from({ length: r.count }, (_, i) => name(r.k + i)));
  const a = x.path[x.first];
  const b = x.second !== null ? x.path[x.second] : null;
  // (9.23 F20: a third run's pass)
  const c = x.third !== null && x.third !== undefined ? x.path[x.third] : null;
  const p = x.path.slice(x.first).find((q) => q.fit !== null && q.from !== null && q.from >= 0) ?? null;
  const why = p && p.t === a.t ? `: ${legWords(p.leg)} after ${name(p.from)}, where runners of the same pace took ${legWords(p.theirs)}` : '';
  const second = (b ? `, and ${at1(b.t)} like ${b.col === -1 ? 'an extra pass' : name(b.col)}, not ${name(x.k2)}` : '')
    + (c ? `, and ${at1(c.t)} like ${c.col === -1 ? 'an extra pass' : name(c.col)}, not ${name(x.k3)}` : '')
    // (9.23 F17: a finisher's finish read, left in a split, is its finish)
    + (x.trail ? `, and ${at1(x.trail.t)} like the finish, not ${name(x.trail.col)}` : '');
  return `${at1(a.t)} looks like ${name(a.col)}, not ${name(x.k)}${second} (missed ${list(missed)}?)${why}${sure ? '' : ', but Split Relay can\'t tell yet'}.`;
}

/**
 * 9.23 F16: the words of two sets of missed splits that fit about as well (two placings of missedStarts, neither the
 * one click), for the pass at race time t counted in column `now`: where each set puts it, and what each adds: "22:51.9
 * looks like the finish or 5300m, not 4400m: Split Relay can't tell which (missed 4200m and 5300m, or 4400m?)."
 * @param {number} t
 * @param {number} now
 * @param {{ to: number|null, missed: number[] }[]} sets where each puts the pass (a column, n the finish, more an extra
 *   pass, null where it is: a run after it), and its missed splits, in the order they are said
 * @param {string[]} names
 */
export function missedSetsText(t, now, sets, names) {
  const n = names.length;
  const name = (c) => (c === n ? 'the finish' : c > n ? 'an extra pass' : names[c] ?? `Split ${c + 1}`);
  const list = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
  const tos = [...new Set(sets.filter((s) => s.to !== null && s.to !== now).map((s) => name(s.to)))];
  const what = sets.map((s) => list(s.missed.map(name))).join(', or ');
  const lead = tos.length ? `${at1(t)} looks like ${tos.join(' or ')}, not ${name(now)}${sets.some((s) => s.to === null || s.to === now) ? `, or it is ${name(now)}` : ''}` : `${at1(t)} in ${name(now)}`;
  return `${lead}: Split Relay can't tell which (missed ${what}?).`;
}
