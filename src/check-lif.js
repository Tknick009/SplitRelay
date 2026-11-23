// Measures the column check (DESIGN 9.17 P2) on FinishLynx .lif result files, without running Split Relay:
//
//   node src\check-lif.js <file.lif> [<file.lif> ...]
//
// A FinishLynx file lists, per finisher, only the split mats that read the runner, in order: exactly what counting
// gives (9.15 L4). So each file can be checked three ways: (1) the file as it is: how many runners with a split at
// every mat are flagged (never, by the rule) and which incomplete ones are; (2) every complete finisher with one split
// taken out in turn: is the right placing suggested (a missed last split needs none); (3) the race replayed every 30 s,
// each runner's passes and finish appearing when they happened: how many runners who had every split were flagged for
// a while on the course. It prints bibs and counts only, never names.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLif } from './lif.js';
import { decodeCp1252 } from './cp1252.js';
import { parseRaceTime, TICKS_PER_SEC } from './timefmt.js';
import { columnCheck } from './review.js';

/**
 * The finishers of a FinishLynx .lif file: bib, the race times of the mats that read them (field 10 without the
 * finish), and the finish (field 6). n = the most common number of split crossings among the finishers (the mats the
 * course had; XC-Analytics does the same).
 * @param {string} text
 * @returns {{ n: number, runners: { bib: string, times: number[], finish: number }[] }}
 */
export function lifFinishers(text) {
  const runners = [];
  for (const row of parseLif(text).rows) {
    const finish = parseRaceTime(row.time);
    if (!/^\d+$/.test(row.place) || finish === null) continue;
    const entries = String(row.fields[10] ?? '').split(',').map((e) => e.trim()).filter(Boolean)
      .map((e) => parseRaceTime(e.split(' (')[0]));
    if (entries.some((t) => t === null)) continue;
    // the last entry is the finish itself
    const times = entries.slice(0, -1).filter((t) => t > 0 && t < finish);
    runners.push({ bib: row.bib, times, finish });
  }
  const counts = new Map();
  for (const r of runners) counts.set(r.times.length, (counts.get(r.times.length) ?? 0) + 1);
  let n = 0;
  let most = 0;
  for (const [k, c] of counts) if (c > most || (c === most && k > n)) [n, most] = [k, c];
  return { n, runners };
}

/** A runner as columnCheck takes it: its passes counted in order, its finish once it is in (at time T). */
function asRunner(r, n, T = Infinity) {
  const ts = r.times.filter((t) => t <= T).slice(0, n);
  const passes = ts.map((t, col) => ({ t, col }));
  const real = new Array(n).fill(null);
  for (const p of passes) real[p.col] = p.t;
  return { bib: r.bib, passes, real, finish: r.finish <= T ? r.finish : null };
}

/**
 * The three measurements of one file (see the top of this file).
 * @param {string} text
 * @param {{ liveStepSec?: number }} [opts]
 */
export function measureLif(text, { liveStepSec = 30 } = {}) {
  const { n, runners } = lifFinishers(text);
  const out = { n, finishers: runners.length, complete: 0, flaggedComplete: 0, incomplete: 0, flagged: [],
    drop: { cases: 0, found: 0, right: 0, wrong: 0, lastCases: 0, lastFlagged: 0 }, live: { flaggedComplete: 0 } };
  if (n < 2 || runners.length < 2) return out;
  const field = runners.map((r) => asRunner(r, n));
  const { suspects } = columnCheck({ n, runners: field });
  for (const r of runners) {
    if (r.times.length >= n) {
      out.complete++;
      if (suspects.has(r.bib)) out.flaggedComplete++;
    } else {
      out.incomplete++;
      const s = suspects.get(r.bib);
      if (s) out.flagged.push({ bib: r.bib, splits: r.times.length, suggested: s.cols.map((c) => c + 1) });
    }
  }
  // (2) one split of a complete finisher taken out: the placing the check should find is every other split's own
  runners.forEach((r, i) => {
    if (r.times.length !== n) return;
    for (let k = 0; k < n; k++) {
      const times = r.times.filter((_, j) => j !== k);
      const truth = [...Array(n).keys()].filter((j) => j !== k);
      const list = field.slice();
      list[i] = asRunner({ ...r, times }, n);
      const s = columnCheck({ n, runners: list }).suspects.get(r.bib);
      if (k === n - 1) {
        out.drop.lastCases++;
        if (s) out.drop.lastFlagged++;
        continue;
      }
      out.drop.cases++;
      if (!s) continue;
      out.drop.found++;
      if (s.cols.every((c, j) => c === truth[j])) out.drop.right++;
      else out.drop.wrong++;
    }
  });
  // (3) live: the race as it was run
  const end = Math.max(...runners.map((r) => r.finish));
  const flagged = new Set();
  for (let T = liveStepSec * TICKS_PER_SEC; T <= end + liveStepSec * TICKS_PER_SEC; T += liveStepSec * TICKS_PER_SEC) {
    const { suspects: live } = columnCheck({ n, runners: runners.map((r) => asRunner(r, n, T)) });
    for (const r of runners) if (r.times.length >= n && live.has(r.bib)) flagged.add(r.bib);
  }
  out.live.flaggedComplete = flagged.size;
  return out;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const run = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === run.toLowerCase() : me === run;
}

if (isEntryPoint()) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Usage: node src\\check-lif.js <file.lif> [<file.lif> ...]');
    process.exitCode = 2;
  }
  const total = { complete: 0, flaggedComplete: 0, liveFlaggedComplete: 0, cases: 0, found: 0, right: 0, wrong: 0, lastCases: 0, lastFlagged: 0 };
  for (const f of files) {
    const m = measureLif(decodeCp1252(fs.readFileSync(f)));
    total.complete += m.complete;
    total.flaggedComplete += m.flaggedComplete;
    total.liveFlaggedComplete += m.live.flaggedComplete;
    for (const k of ['cases', 'found', 'right', 'wrong', 'lastCases', 'lastFlagged']) total[k] += m.drop[k];
    console.log(`${path.basename(f)}: ${m.finishers} finishers, ${m.n} splits; complete ${m.complete} (flagged ${m.flaggedComplete}, ` +
      `on the course ${m.live.flaggedComplete}); incomplete ${m.incomplete} (flagged ${m.flagged.length}` +
      `${m.flagged.length ? `: ${m.flagged.map((x) => `${x.bib} -> splits ${x.suggested.join('/')}`).join(', ')}` : ''}); ` +
      `one split taken out: ${m.drop.right} of ${m.drop.cases} placed right, ${m.drop.wrong} wrong; last split taken out: ` +
      `${m.drop.lastFlagged} of ${m.drop.lastCases} flagged`);
  }
  if (files.length > 1) console.log(`all: ${JSON.stringify(total)}`);
}
