// Split Relay control panel (DESIGN.md §8). Plain browser JavaScript with no framework and no build step, so the page
// works offline on the timing laptop. It paints from GET /api/state and the /api/events stream (§6); every change goes
// through the mutation endpoints and the State the server answers with is painted at once.
//
// Rules this file keeps to, because the operator uses it under time pressure on race day:
// - Data never reaches innerHTML: every node is built with h() and text always goes in as text nodes.
// - A form the operator is editing is never rebuilt by incoming state; drafts live here until Save or Revert.
// - Nothing is rebuilt while a mouse button is down, so a click is never lost to a repaint.
// - A region that fails to draw says so in place; the rest of the panel keeps working.
//
// The pure helpers at the top are exported (and the page only boots when there is a document) so they can be tested
// in Node. The time helpers repeat the few lines of src/timefmt.js the panel needs: the server only serves public/.
// The rule for a running race is shared the other way: public/running.js, which src/meet.js imports.

import { runningNow, RUNNING_READ_MS } from './running.js';

export const TICKS_PER_SEC = 10000;
const TICKS_PER_DAY = 86400 * TICKS_PER_SEC;
const HALF_DAY = TICKS_PER_DAY / 2;

const pad = (v, n = 2) => String(v).padStart(n, '0');
const mod = (v, m) => ((v % m) + m) % m;
const str = (v) => (v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * The comparison the server uses for contests, timing point names and locations (DESIGN.md §3).
 * @param {unknown} s
 */
export const norm = (s) => str(s).trim().replace(/\s+/g, ' ').toLowerCase();

/** Decimal digits -> ticks (0.1 ms), rounding half up past the fourth digit, exactly as the server does. */
function fractionTicks(digits) {
  if (!digits) return 0;
  const four = Number((digits + '0000').slice(0, 4));
  return digits.length > 4 && digits[4] >= '5' ? four + 1 : four;
}

/**
 * A gun time as the operator types it ("10:00:00", "10:00:00.0", "10:00:00.000", "9:05:00", comma decimals) ->
 * ticks since midnight, or null. Stricter than the server's parseTod on purpose: at the start line a bare number or
 * an hour past 23 is a typo, not decimal seconds.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseGunText(text) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(str(text).trim());
  if (!m) return null;
  const [hh, mm, ss] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return mod((hh * 3600 + mm * 60 + ss) * TICKS_PER_SEC + fractionTicks(m[4]), TICKS_PER_DAY);
}

function splitTicks(t) {
  return { hh: Math.floor(t / 36e6), mm: Math.floor(t / 6e5) % 60, ss: Math.floor(t / 1e4) % 60, f: t % 1e4 };
}

/**
 * Time of day for display: "10:00:00.000" (two-digit hours). Truncates, never rounds.
 * @param {number} ticks
 * @param {number} [decimals=3] 0-4
 */
export function formatTod(ticks, decimals = 3) {
  if (!Number.isFinite(ticks)) return '';
  const { hh, mm, ss, f } = splitTicks(mod(Math.trunc(ticks), TICKS_PER_DAY));
  const frac = decimals > 0 ? '.' + pad(f, 4).slice(0, decimals) : '';
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${frac}`;
}

/**
 * A race time the way FinishLynx prints one ("45.1", "5:12.3", "1:02:03.4"); reducing precision rounds UP, so the
 * panel shows what TrackScore will show.
 * @param {number} ticks
 * @param {number} [decimals=3] 0-4
 */
export function formatRaceTime(ticks, decimals = 3) {
  if (!Number.isFinite(ticks)) return '';
  const d = Math.max(0, Math.min(4, Math.trunc(decimals)));
  const unit = 10 ** (4 - d);
  const t = Math.trunc(ticks);
  const abs = Math.ceil(Math.abs(t) / unit) * unit;
  const { hh, mm, ss, f } = splitTicks(abs);
  const frac = d > 0 ? '.' + pad(f, 4).slice(0, d) : '';
  const body = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}${frac}` : mm > 0 ? `${mm}:${pad(ss)}${frac}` : `${ss}${frac}`;
  return (t < 0 ? '-' : '') + body;
}

/**
 * The running race clock in tenths. Cut off rather than rounded up, so it never shows a tenth that has not happened.
 * @param {number} ticks
 */
export function formatClock(ticks) {
  return formatRaceTime(Math.trunc(ticks / 1000) * 1000, 1);
}

/**
 * tod - gun with the midnight wrap of DESIGN.md §2.
 * @param {number} tod
 * @param {number} gun
 */
export function raceTicks(tod, gun) {
  let d = tod - gun;
  if (d < -HALF_DAY) d += TICKS_PER_DAY;
  else if (d > HALF_DAY) d -= TICKS_PER_DAY;
  return d;
}

/**
 * Wall-clock milliseconds from the server (a number, or an ISO string if a module sends one), or null.
 * @param {unknown} v
 * @returns {number | null}
 */
export function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * "just now", "3 s ago", "4 min ago", "1 h 5 min ago".
 * @param {number} ms elapsed milliseconds
 */
export function formatAgo(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/** Local wall time "10:12:33" (the PC clock), for "last update" lines. */
export function formatWall(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "8,348" whatever the browser locale is, matching the wording in the design. */
export const fmtInt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '0');

/**
 * "1 read", "12 reads".
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
export const plural = (n, one, many = one + 's') => `${fmtInt(n)} ${Number(n) === 1 ? one : many}`;

/**
 * "A", "A and B", "A, B and C", "A, B, C and 2 more".
 * @param {string[]} names
 * @param {number} [max=4]
 */
export function listText(names, max = 4) {
  const list = arr(names).map(str).filter(Boolean);
  if (list.length <= 1) return list.join('');
  if (list.length > max) return `${list.slice(0, max - 1).join(', ')} and ${list.length - max + 1} more`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Status words. One table feeds the feed colours, the legend and the Help glossary so they can never disagree.  */

/**
 * The Races list's one line on where a read goes (DESIGN 9.2, 9.15 L3): the Active race on the RR12 port it came in on
 * (LapTime lines, the normal case); races that are not Active take nothing new; with SR lines, the Active race that
 * lists its contest, and the Active race with no contests and no port takes the rest, except contests set aside or
 * waiting.
 */
export const RACE_LIST_HELP = 'A read goes to the Active race that reads from the RR12 port it came in on (one Active race per port). A race that is not Active takes no new reads: they wait for it, not used, until you tick Active on it (or press “Switch to …”). With SR lines (Advanced), a read that names a contest goes to the Active race that lists that contest.';

/** DESIGN 9.24: the one sentence under "Send a clearing line when a split is taken back" (Outputs). */
export const CLEAR_LINE_HELP = "After Not a split, a Move, an Undo or Stop sending this runner, the runner's row for that split goes out once more with an empty time and place, for a receiver that can blank a cell. TrackScore ignores such a row today: leave it off unless yours blanks it.";

/** Order of the legend and the glossary: what the operator wants to see first. */
export const STATUS_ORDER = ['sent', 'held', 'ready', 'corrected', 'made-up', 'typed', 'finish', 'finished-not-sent', 'split-paused', 'check-column', 'not-sending', 'not-in-race', 'counted',
  'backup', 'duplicate', 'repeat', 'start-area', 'after-finish', 'out-of-order', 'extra', 'ignored', 'too-early', 'waiting-gun', 'before-gun', 'unmapped', 'no-race',
  'set-aside', 'paused', 'race-missing', 'race-deleted', 'cleared', 'bad-line'];

/** @type {Record<string, { label: string, tone: string, filtered?: boolean, meaning: string }>} */
export const STATUS = {
  sent: { label: 'Sent', tone: 'ok', meaning: 'Sent: an output (TrackScore, live results) took it.' },
  held: { label: 'Holding', tone: 'info', meaning: 'First read of this runner at this split. Held for a moment (the "hold" setting) in case the backup mat has an earlier time, then sent.' },
  // DESIGN 9.16 F3: "Sent" only once an output took it
  ready: { label: 'Ready: not sent', tone: 'warn', meaning: 'The split is ready to go out, but no output took it: no output sends this race, every output is switched off, or an output\'s script can\'t be loaded (the detail says which). It goes out by itself as soon as an output can take it, unless the runner has finished by then.' },
  corrected: { label: 'Corrected', tone: 'info', meaning: 'An earlier read for the same runner and split arrived after the split was sent. The earlier time won and the split was sent again.' },
  // DESIGN 9.17 P3: a time the operator approved in Review for a runner a mat missed
  'made-up': { label: 'Made-up time', tone: 'info', meaning: 'A split time Split Relay worked out for a runner who missed a mat (from the runner\'s splits before and after it, placed like the runners nearest in pace), sent because you approved it in Review. It goes to TrackScore, the live results and the merged .lif file like a real split, ranked with the real ones, and Review lists it as made-up. It is an estimate, not a timed split. A real read for that split later replaces it.' },
  typed: { label: 'Typed time', tone: 'info', meaning: 'A split time you typed in Review for a runner who missed a mat, instead of Split Relay\'s estimate. Sent and written to the merged .lif file like a real split, and listed in Review as typed. A real read for that split later replaces it.' },
  finish:{ label: 'Finish (not sent)', tone: 'finish', meaning: 'A read at a finish timing point. Recorded so Split Relay knows the runner finished; never sent, because FinishLynx sends finishes.' },
  'finished-not-sent': { label: 'Finished: not sent live', tone: 'finish', meaning: 'The runner had already finished when this split could go out, so it was not sent to TrackScore or live results: a split packet would overwrite their finish place. The split is in the merged .lif file. Review lists it with "Send with finish place", which sends it with the runner\'s finish place so TrackScore keeps that.' },
  // DESIGN 9.17 P1: the operator's pause button on a split
  'split-paused': { label: 'Split paused', tone: 'warn', meaning: 'This split is paused (the ⏸ button on its tile). The split is worked out and kept, but not sent to TrackScore or the live results and not written to the merged .lif file. Press ▶ Play on the split and what it held goes out (a runner who has finished by then is listed in Review instead).' },
  // DESIGN 9.17 P2: a pass that looks like it belongs in another split column
  'check-column': { label: 'Check column', tone: 'warn', meaning: 'This pass may be in the wrong split column: next to the rest of the field it looks like a later split, so the runner probably missed a mat. It is held (not sent, not in the merged .lif file) until you choose in Review: Move it to the split it looks like, or Keep it where it was counted.' },
  // DESIGN 9.24: the operator's "Stop sending this runner"
  'not-sending': { label: 'Not sending', tone: 'muted', meaning: 'You stopped sending this runner in Review. The pass is still read, counted and shown, but it is not sent to TrackScore or the live results, not written to the merged .lif file, and it does not count for the places of the others. Open the runner and choose "Send this runner again" to undo that.' },
  // DESIGN 9.25: an athlete of another race (a start list enters them there, or the operator said so)
  'not-in-race': { label: 'Not in this race', tone: 'muted', meaning: 'The runner is not in this race: a start list enters them in another race, or you said so in Review. The pass is still read, counted and shown, but it is not sent to TrackScore or the live results, not written to the merged .lif file, and it does not count for the places of the others. Review lists the runner under Not in this race: "Count them here" sends their splits like any runner\'s.' },
  // DESIGN 9.26: a pass in a split that is counted but not sent (the Send switch of the split, Races page)
  counted: { label: 'Counted, not sent', tone: 'muted', meaning: 'A pass in a split that is set to Not sent on the Races page (a mat a little after a K marker, say). It is read and counted like any split, so the runner\'s later passes land in their own splits, but nothing of it goes to TrackScore or the live results and it is not written to the merged .lif file. It never waits and can\'t be resent. To show the split after all, switch Send on for it on the race\'s page: the other splits\' laps to go change, so set the number of splits in TrackScore and Karmarush and resend.' },
  // DESIGN 9.23: the operator's "Not a split" in the runner editor
  ignored: { label: 'Not a split', tone: 'muted', meaning: 'You set this pass aside in Review: it is not a split (a finish, cool-down or stray pass). It is in no column, not sent and not in the merged .lif file. Open the runner and choose "Let Split Relay count it" to undo that.' },
  backup: { label: 'Backup read (filtered)', tone: 'muted', filtered: true, meaning: 'The same runner at the same split again within the tag filter window, usually from the backup mat. The earliest time is kept.' },
  duplicate: { label: 'Duplicate (ignored)', tone: 'muted', filtered: true, meaning: 'Exactly the same read again, for example after Replay in RR12. Nothing changes. (A read of a race you cleared counts again when RR12 sends it again; the reads of a deleted race stay out of use.)' },
  repeat: { label: 'Repeat (ignored)', tone: 'muted', filtered: true, meaning: 'The same runner at the same split again, later than the tag filter window. The first crossing stands.' },
  'start-area': { label: 'Start area (ignored)', tone: 'muted', filtered: true, meaning: 'Too soon after the gun: a runner crossing a mat at the start (often the finish mats), not a split or a finish. Ignored. If it is a real split, lower "Ignore reads in the first … s" in Settings, Tag filter.' },
  'after-finish': { label: 'After finish (ignored)', tone: 'muted', meaning: 'A split read later than the runner\'s finish, for example walking back over a mat after the race. Not counted and not sent.' },
  'out-of-order': { label: 'Out of order (ignored)', tone: 'muted', meaning: 'This split time is not earlier than the runner\'s time at a later split, so it can\'t be right (for example crossing the 1K mat again on the way back). Not counted and not sent.' },
  // L4: a split must never go out as laps to go 0, which TrackScore and Karmarush read as the finish
  extra: { label: 'Extra pass (ignored)', tone: 'warn', meaning: 'More passes than this race has splits — ignored. The runner already has every split, so this pass is not sent: a split after the last one would go out as laps to go 0, which TrackScore and Karmarush take as the finish. If the course really has more split passes, raise the race\'s number of splits on the Races page. If every runner gets one, check that the RR12 exporter sends the split mats only, not the finish.' },
  'too-early': { label: 'Too early for this split (ignored)', tone: 'muted', meaning: 'The pass came before the earliest race time set for the runner\'s next split (Races page, Advanced), so it can\'t be that split, for example a runner crossing the mat twice near the start. Not counted and not sent.' },
  'waiting-gun': { label: 'Waiting for gun', tone: 'warn', meaning: 'The race has no gun time yet. The read is kept, and sent when you set the gun time if it is after the gun.' },
  'before-gun': { label: 'Before gun', tone: 'warn', meaning: 'The read is earlier than the race\'s gun time, so it was not sent. Check the gun time: if you fix it, the read counts again.' },
  unmapped: { label: 'Unmapped', tone: 'warn', meaning: 'SR lines only: the timing point name is not one of this race\'s splits. Add it to a split on the Races page, and its reads count, the earlier ones too. Or ignore it.' },
  'no-race': { label: 'No race', tone: 'warn', meaning: 'No race takes the read. A LapTime read (bib and time): no Active race reads from the RR12 port it came in on, so choose that port on an Active race. An SR line with a contest: no race lists the contest, and no Active race takes every contest. List the contest on an Active race on the Races page. Either way its reads count there, the earlier ones too.' },
  'set-aside': { label: 'Set aside (not used)', tone: 'warn', meaning: 'The race this contest\'s reads were in was deleted, or no longer lists the contest, so the contest\'s reads are not used, and new reads of it are not used either. A race that takes every contest does not take them, or it would place these runners among its own. List the contest on an Active race, and they all count there (listed on a race that is not Active, they wait for it).' },
  paused: { label: 'Race paused', tone: 'muted', meaning: 'The read\'s race is not Active, so the read is not sent. It is kept: a race that is not Active keeps exactly the reads it had when you unticked Active, whatever you change in other races, and new reads of a contest that only races that are not Active list wait for them, in no race. Tick Active on the race, and they are used.' },
  'race-missing': { label: 'Race missing (not used)', tone: 'bad', meaning: 'The read\'s race is not in the settings any more, but it was not deleted: config.json was put back from its backup, or edited. The read waits for it, not used, and so do new reads of its contests that no other race takes. Put the race back (the Dashboard says how), and they all come back to it.' },
  'race-deleted': { label: 'Race deleted (not used)', tone: 'muted', meaning: 'The race this read was in was deleted, so the read is not used any more, even if you add the race again or RR12 sends it again. To stop a race without losing its reads, untick Active instead of deleting it.' },
  cleared: { label: 'Cleared (not used)', tone: 'muted', meaning: 'The read was in the race when you pressed "Clear race data". It is not used any more, wherever the race settings would move it. Press Replay in RR12 to send the race again: the reads then count again (reads from before the gun stay out).' },
  'bad-line': { label: 'Bad line', tone: 'bad', meaning: 'Split Relay could not understand this line from RR12 (the detail says why). Check that RR12\'s Export Data expression is exactly the one on the Inputs page.' },
};

/** Other names a server may use for a made-up crossing (DESIGN 9.17 P3), so the feed never shows a raw code. */
const STATUS_ALIASES = { manual: 'made-up', estimated: 'made-up', madeup: 'made-up' };

/**
 * @param {string} status
 * @returns {{ label: string, tone: string, filtered?: boolean, meaning: string }}
 */
export function statusInfo(status) {
  return STATUS[status] || STATUS[STATUS_ALIASES[status]] || { label: str(status) || 'Unknown', tone: 'muted', meaning: '' };
}

const isProblemTone = (tone) => tone === 'warn' || tone === 'bad';

/* ------------------------------------------------------------------------------------------------------------ */
/* Live feed. GET /api/state carries the newest 200 entries; after that only 'feed' events do (DESIGN.md §9.7), and */
/* the server re-emits an entry with the same id whenever its read's outcome changes (waiting for gun -> sent).    */

export class FeedStore {
  /** @param {number} [max] entries kept */
  constructor(max = 600) {
    this.max = max;
    /** @type {Map<string, { entry: any, seq: number, at0: number, stamp: number }>} */
    this.items = new Map();
    this.seq = 0;
    // bumped on every upsert, so a reset can tell what the live stream delivered after a given moment
    this.stamp = 0;
    this.cache = null;
  }

  clear() {
    this.items.clear();
    this.cache = null;
  }

  get size() {
    return this.items.size;
  }

  /**
   * A later entry with the same id (held, then sent; waiting for gun, then before gun) replaces the earlier one IN
   * PLACE: the row keeps the position of its first arrival, so the list doesn't jump while the operator reads it.
   */
  upsert(entry) {
    if (!entry || typeof entry !== 'object' || entry.id == null) return;
    const key = String(entry.id);
    const old = this.items.get(key);
    this.items.set(key, {
      entry,
      seq: old ? old.seq : ++this.seq,
      at0: old ? old.at0 : toMs(entry.at) ?? 0,
      stamp: ++this.stamp,
    });
    this.cache = null;
    if (this.items.size > this.max + 100) this.trim();
  }

  /** State.feed is newest first: walk it oldest first so arrival order survives equal timestamps. */
  merge(list) {
    const a = arr(list);
    for (let i = a.length - 1; i >= 0; i--) this.upsert(a[i]);
  }

  /**
   * Start over from a fresh GET /api/state feed (after a reconnect Split Relay may have restarted). Entries the live
   * stream delivered after `sinceStamp` are kept and win over the list: they are newer than the State, which only
   * fills in what the stream never carried.
   * @param {any[]} list newest first
   * @param {number} sinceStamp this.stamp when the stream (re)opened
   */
  resetTo(list, sinceStamp) {
    for (const [k, v] of [...this.items]) if (v.stamp <= sinceStamp) this.items.delete(k);
    const a = arr(list);
    for (let i = a.length - 1; i >= 0; i--) {
      const e = a[i];
      if (e && e.id != null && this.items.has(String(e.id))) continue;
      this.upsert(e);
    }
    this.cache = null;
  }

  /** @returns {any[]} newest first */
  list() {
    if (!this.cache) {
      this.cache = [...this.items.values()]
        .sort((a, b) => b.at0 - a.at0 || b.seq - a.seq)
        .map((x) => x.entry);
    }
    return this.cache;
  }

  trim() {
    const keep = new Set(this.list().slice(0, this.max).map((e) => String(e.id)));
    for (const k of [...this.items.keys()]) if (!keep.has(k)) this.items.delete(k);
    this.cache = null;
  }
}

/** Race filter value for reads that matched no race. */
export const NO_RACE = '__none';

/**
 * The feed rows to show for the operator's filters.
 * @param {any[]} list newest first
 * @param {{ raceId?: string, showFiltered?: boolean, problemsOnly?: boolean, search?: string }} f
 * @param {number} [limit=200]
 * @returns {{ rows: any[], hidden: number }} hidden = filtered reads (backup, duplicate, repeat, start area) left out
 */
export function filterFeed(list, f = {}, limit = 200) {
  const q = norm(f.search);
  const rows = [];
  let hidden = 0;
  for (const e of arr(list)) {
    if (f.raceId === NO_RACE ? e.raceId : f.raceId && e.raceId !== f.raceId) continue;
    const info = statusInfo(e.status);
    if (f.problemsOnly && !isProblemTone(info.tone)) continue;
    if (q && !(norm(e.bib).includes(q) || norm(e.name).includes(q) || norm(e.team).includes(q))) continue;
    if (info.filtered && !f.showFiltered) {
      hidden++;
      continue;
    }
    if (rows.length < limit) rows.push(e);
  }
  return { rows, hidden };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Reading State                                                                                                */

export const viewOf = (st, id) => arr(st?.races).find((r) => r.id === id) || null;
export const configRace = (st, id) => arr(st?.config?.races).find((r) => r.id === id) || null;
export const configOutput = (st, id) => arr(st?.config?.outputs).find((o) => o.id === id) || null;
export const outputStatus = (st, id) => arr(st?.outputs).find((o) => o.id === id) || null;

/** An output sends a race when its race list is empty (all races) or names the race. */
export const outputSendsRace = (o, raceId) => !arr(o?.races).length || arr(o.races).includes(raceId);

/** Crossings this race has made (held or sent): what a gun change or a Resend affects. */
export const crossingCount = (rv) => arr(rv?.splits).reduce((n, s) => n + (Number(s.crossings) || 0), 0);

/** Crossings at one split of a RaceView (0 for a split not saved yet). */
export function splitCrossings(rv, splitId) {
  if (!splitId) return 0;
  const s = arr(rv?.splits).find((x) => x && x.id === splitId);
  return Number(s?.crossings) || 0;
}

/**
 * For Element.replaceChildren, which turns a null into the text "null": keep only real children.
 * @param {unknown} n
 */
export const isNode = (n) => n != null && n !== false && n !== true;

/**
 * The race clock now. RaceView.elapsedTicks is the clock when the server built the State, so it is advanced by the
 * time since then; a server that leaves it out falls back to this browser's time of day.
 * @param {any} rv RaceView
 * @param {any} st State
 * @param {number} nowMs server wall clock estimate
 * @returns {number | null}
 */
export function elapsedNow(rv, st, nowMs) {
  if (!rv || !Number.isFinite(rv.gunTicks)) return null;
  if (Number.isFinite(rv.elapsedTicks)) return rv.elapsedTicks + Math.round((nowMs - (toMs(st?.now) ?? nowMs)) * 10);
  const d = new Date(nowMs);
  const tod = ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * TICKS_PER_SEC + d.getMilliseconds() * 10;
  return raceTicks(tod, rv.gunTicks);
}

/**
 * A race counts as running while it is Active with a gun, and its clock is under 30 minutes or reads keep arriving (one
 * in the last 20 minutes, whatever the clock says). A whole meet's guns set in the morning must not make every race
 * "running" all afternoon. The rule is public/running.js, Split Relay's own (src/meet.js raceRunning), so the Races
 * list never offers a load or Start a new meet that the server then treats as under a running race.
 */
export function isRunning(rv, cfgRace, st, nowMs) {
  // the race view's clock; with no view, the settings' gun (as the server works it out from the gun alone)
  const typed = Number.isFinite(rv?.gunTicks) ? null : parseGunText(cfgRace?.gun);
  const el = elapsedNow(typed != null ? { gunTicks: typed } : rv, st, nowMs);
  // a gun that can't be read counts, as it does there (src/meet.js raceClockMs: NaN)
  const gun = el != null || !!str(cfgRace?.gun).trim();
  return runningNow({ active: (cfgRace ?? rv)?.active, gun, clockMs: el != null ? el / (TICKS_PER_SEC / 1000) : gun ? NaN : null,
    lastReadAt: toMs(rv?.lastReadAt) }, nowMs);
}

/** Every runner the race has seen has finished (FinishLynx): nothing of it is live any more. */
export const allFinished = (rv) => Number(rv?.runners) > 0 && Number(rv?.finished) >= Number(rv?.runners);

/* ------------------------------------------------------------------------------------------------------------ */
/* RR12 inputs (DESIGN 9.15 L2): one listener per port, one RR12 exporter per port.                             */

/**
 * The Export Data expression of RR12's FinishLynx LapTime exporter, which the user's RR12 -> FinishLynx exporter
 * already uses: bib and time of day only. Kept here word for word because the operator pastes it into RR12.
 */
export const LAPTIME_EXPRESSION = 'chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]';

/** The LapTime expression as Split Relay gives it (State.expressions.laptime), else the panel's own copy. */
export const laptimeExpression = (st) => (typeof st?.expressions?.laptime === 'string' && st.expressions.laptime.trim() ? st.expressions.laptime : LAPTIME_EXPRESSION);

/** What each detected line format (State.inputs[].format) is called on the Inputs page. */
export const FORMAT_WORDS = {
  laptime: 'FinishLynx LapTime: bib + time',
  sr: 'SR lines: timing point names, bib, time, contest',
  json: 'RR12 record (JSON)',
};

/** @param {unknown} f State.inputs[].format @returns {string} */
export const formatWord = (f) => FORMAT_WORDS[str(f)] || (f ? str(f) : 'Nothing received yet');

const portNum = (v) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isInteger(n) ? n : null;
};

/**
 * The ports Split Relay listens on for RR12: config.input.ports, or the single port of a config (or server) from
 * before ports existed, so an older server still paints.
 * @param {any} st State
 * @returns {number[]}
 */
export function inputPorts(st) {
  const list = arr(st?.config?.input?.ports).map(portNum).filter((p) => p != null);
  if (list.length) return list;
  const one = portNum(st?.config?.input?.port) ?? portNum(st?.input?.port);
  return [one ?? 5565];
}

/** The first input port: what a new race reads from. */
export const firstPort = (st) => inputPorts(st)[0];

/**
 * One status per port (State.inputs). A server without it has only the aggregate State.input, which then stands for
 * its one port.
 * @param {any} st
 * @returns {any[]}
 */
export function inputsOf(st) {
  const list = arr(st?.inputs).filter((x) => x && portNum(x.port) != null);
  if (list.length) return list;
  return st?.input ? [{ ...st.input, port: portNum(st.input.port) ?? firstPort(st) }] : [];
}

/**
 * The address RR12 most likely reaches this PC on: the one in the same network as an RR12 connection, else the first
 * (Split Relay lists the private LAN addresses first). The Inputs page lists the others.
 * @param {any} st
 * @returns {string} '' when Split Relay reports none
 */
export function likelyAddress(st) {
  const addrs = arr(st?.addresses).filter(Boolean).map(str);
  if (addrs.length < 2) return addrs[0] || '';
  const net3 = (ip) => str(ip).replace(/^\[|\]$/g, '').split('.').slice(0, 3).join('.');
  const remotes = inputsOf(st).flatMap((i) => arr(i.connections)).map((c) => str(c?.remote).replace(/:\d+$/, ''));
  return addrs.find((a) => remotes.some((r) => net3(r) === net3(a))) || addrs[0];
}

/**
 * "192.168.0.21:5565" for "point RR12 at …": this PC's likely address (likelyAddress); the Inputs page has the rest.
 * @param {any} st
 * @param {number} [port] the port of one exporter; the first input port when left out
 */
export function rrTarget(st, port) {
  const p = port ?? portNum(st?.input?.port) ?? firstPort(st);
  const a = likelyAddress(st);
  return a ? `${a}:${p}` : `this PC's IP address, port ${p}`;
}

/** "45 s", "2 min", "1 h 5 min": how long something has been so. */
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The most RR12 input ports Split Relay listens on (src/config.js MAX_INPUT_PORTS): one per overlapping race. */
export const MAX_INPUT_PORTS = 10;

/** "port 5565" / "ports 5565 and 5566". */
export const portsText = (ports) => `${arr(ports).length === 1 ? 'port' : 'ports'} ${listText(arr(ports).map(String))}`;

/**
 * The ports the operator typed, checked the way the server checks them: distinct, 1024-65535, not the control
 * panel's port and not a port a TCP-server output listens on (one program per port).
 * @param {unknown[]} list port texts as typed
 * @param {{ panelPort?: number, outputs?: any[] }} [taken]
 * @returns {string[]} plain-English problems; empty when the ports work
 */
export function validateInputPorts(list, { panelPort, outputs = [], current = null, webPort = null } = {}) {
  const errs = [];
  const rows = arr(list).map((v) => str(v).trim());
  if (!rows.length) errs.push('Split Relay needs at least one port to receive RR12 reads on. Add one.');
  if (rows.length > MAX_INPUT_PORTS) errs.push(`Split Relay listens on at most ${MAX_INPUT_PORTS} RR12 input ports.`);
  const seen = new Set();
  rows.forEach((s, i) => {
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < 1024 || n > 65535) {
      errs.push(`${s ? `Port ${s}` : `Port ${i + 1}`} can't be used: type a whole number from 1024 to 65535 (for example 5565).`);
      return;
    }
    if (seen.has(n)) errs.push(`Port ${n} is in the list twice. Each RR12 exporter needs its own port.`);
    seen.add(n);
    if (n === Number(panelPort)) errs.push(`Port ${n} is the control panel's port. Choose another one for RR12.`);
    const o = arr(outputs).find((x) => x && x.enabled !== false && x.mode === 'tcp-server' && Number(x.port) === n);
    if (o) errs.push(`Port ${n} is used by the output “${str(o.name) || 'an output'}”, which listens there. Choose another one for RR12.`);
    // a port that is there already keeps working; only a new one is checked
    if (Array.isArray(current) && current.map(Number).includes(n)) return;
    if (n === 5555) errs.push("Port 5555 is where TrackScore takes the splits: Split Relay can't listen for RR12 there. Choose another one.");
    else if (n === 5556 || (n >= 4554 && n <= 4569)) errs.push(`Port ${n} is one of TrackScore's timing ports: Split Relay can't listen for RR12 there. Choose another one.`);
    else if (webPort != null && n === Number(webPort)) errs.push(`Port ${n} is TrackScore's web page (Settings → Meet setup): Split Relay can't listen for RR12 there. Choose another one.`);
    const to = arr(outputs).find((x) => x && x.mode !== 'tcp-server' && Number(x.port) === n && /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|\[::1\]|0\.0\.0\.0|)$/i.test(str(x.host).trim()));
    if (to) errs.push(`Port ${n} is where the output “${str(to.name) || 'an output'}” sends its splits on this PC. Choose another one for RR12.`);
  });
  return [...new Set(errs)];
}

/**
 * The port "+ Add a port" offers: one above the highest, skipping ports that are already taken.
 * @param {number[]} ports
 * @param {number[]} [taken] the control panel's port, TCP-server output ports
 */
export function nextFreePort(ports, taken = []) {
  const own = arr(ports).map(Number).filter(Number.isFinite);
  const used = new Set([...own, ...arr(taken).map(Number).filter(Number.isFinite)]);
  // next to the RR12 ports (5566 after 5565), not after the control panel's port
  let p = Math.max(5564, ...own) + 1;
  while (used.has(p) && p < 65535) p++;
  return p <= 65535 ? p : 5566;
}

/**
 * Saving the RR12 ports while RR12 is connected on a port that goes away cuts that exporter off: it keeps retrying the
 * old port. These are the ports to confirm, with their connection counts.
 * @param {any} st State
 * @param {unknown[]} ports the ports as they would be saved
 * @returns {{ port: number, connections: number }[]}
 */
export function inputPortsDropped(st, ports) {
  const keep = new Set(arr(ports).map(Number));
  return inputsOf(st).filter((i) => !keep.has(Number(i.port)) && arr(i.connections).length > 0)
    .map((i) => ({ port: Number(i.port), connections: arr(i.connections).length }));
}

/** The races that read from a port (race.inputPort). */
export const racesOnPort = (races, port) => arr(races).filter((r) => r && portNum(r.inputPort) != null && portNum(r.inputPort) === Number(port));

/**
 * The other ACTIVE race that already takes this draft's port (DESIGN 9.15 L3: one Active race per port, or a read
 * that carries only a bib could go to either), or null.
 * @param {any} d race draft or race
 * @param {any[]} races config races
 * @param {string} [id] the race being edited
 */
export function portConflict(d, races, id = '') {
  const port = portNum(d?.inputPort);
  if (!d || d.active === false || port == null) return null;
  return arr(races).find((r) => r && r.id !== id && r.active !== false && portNum(r.inputPort) === port) || null;
}

/** The words of a port clash, the same as the server's save error (DESIGN 9.15 L3). */
export const portConflictText = (port, other) =>
  `Port ${port} already feeds the active race '${str(other?.name) || '(no name)'}'. Untick Active on one of them, or give this race its own port.`;

/**
 * What "Switch to <race>" (POST /api/races/:id/activate) will do, for its dialog: the race becomes Active and the
 * other Active races that take the same reads (its port, or one of its contests) are unticked. The server decides; this
 * says it beforehand, and the toast afterwards says what really changed.
 * @param {any} st State
 * @param {string} id
 * @param {string[] | null} [offIds] the races the server says it unticks (POST /api/races/preview { activate }), when known
 * @returns {{ race: any, off: any[], port: number | null, outputs: { output: any, from: string[] }[] } | null}
 */
export function switchPlan(st, id, offIds = null) {
  const races = arr(st?.config?.races);
  const race = races.find((r) => r.id === id);
  if (!race) return null;
  const port = portNum(race.inputPort);
  const mine = new Set(arr(race.contests).map(norm).filter(Boolean));
  // the clashes the server checks: the same port, a contest both list, both taking every contest (no contest and no
  // port), the same event
  const every = (r) => !arr(r.contests).length && portNum(r.inputPort) == null;
  const ek = eventKey(race);
  const off = Array.isArray(offIds) ? races.filter((r) => offIds.includes(r.id)) : races.filter((r) => r.id !== id && r.active !== false && (
    (port != null && portNum(r.inputPort) === port) || arr(r.contests).some((c) => mine.has(norm(c)))
    || (every(race) && every(r)) || (ek != null && eventKey(r) === ek)));
  // TrackScore shows one race: an output given only the races that are switched off would get nothing from the new one
  const goingOff = new Set(off.map((r) => r.id));
  const outputs = arr(st?.config?.outputs)
    .filter((o) => o && o.enabled !== false && arr(o.races).length && !arr(o.races).includes(id) && arr(o.races).every((rid) => goingOff.has(rid)))
    .map((o) => ({ output: o, from: arr(o.races).map((rid) => races.find((r) => r.id === rid)?.name).filter(Boolean) }));
  return { race, off, port, outputs };
}

/**
 * The words of the Switch dialog.
 * @param {ReturnType<typeof switchPlan>} p
 * @param {any} [rv] the race's RaceView
 * @returns {string[]}
 */
export function switchDialogText(p, rv) {
  if (!p) return [];
  const name = str(p.race.name) || 'This race';
  const lines = [p.port != null
    ? `${name} becomes Active and takes the reads that arrive on port ${p.port}.`
    : `${name} becomes Active and takes the reads of its contests.`];
  if (p.off.length) {
    const one = p.off.length === 1;
    lines.push(`${listText(p.off.map((r) => str(r.name) || '(no name)'))} ${one ? 'is' : 'are'} unticked (not Active): ${one ? 'it keeps its' : 'they keep their'} reads, and ${one ? 'its' : 'their'} merged .lif ${one ? 'file keeps its' : 'files keep their'} splits, but nothing more is sent for ${one ? 'it' : 'them'}.`);
  }
  if (rv && !Number.isFinite(rv.gunTicks)) lines.push(`${name} has no gun time yet: set it when the race starts. Reads wait until then.`);
  return lines;
}

/** The most splits a race can have (the "Number of splits" control, DESIGN 9.15 L5). */
export const MAX_SPLITS = 20;

/** Laps to go of split i (0-based) of n: n for split 1 ... 1 for split n. Never 0: that is the finish. */
export const lapsToGo = (i, n) => n - i;

/** DESIGN 9.26: whether a split is counted but not sent (its Send switch is off): never the Pause, which is `sending`. */
export const notSent = (s) => !!s && s.collectOnly === true;

/** The splits of a race (config or draft) that are sent, in course order: what TrackScore and Karmarush are set up with. */
export const sentOnly = (splits) => arr(splits).filter((s) => s && !notSent(s));

/**
 * DESIGN 9.26: laps to go of split i of a list in which some splits are not sent: the number of SENT splits from it to
 * the end (the last sent split is 1, never 0). null for a split that is not sent: it has no column on a scoreboard.
 * With every split sent it is lapsToGo(i, n).
 * @param {any[]} splits config or draft splits
 * @param {number} i
 * @returns {number | null}
 */
export function sentLapsToGo(splits, i) {
  const list = arr(splits);
  if (!list[i] || notSent(list[i])) return null;
  let n = 0;
  for (let k = i; k < list.length; k++) if (list[k] && !notSent(list[k])) n++;
  return n;
}

/** The race editor's hint (DESIGN 9.15 L5). */
export const splitCountHint = (n) => `Set the number of splits to ${n} in TrackScore (Intermediate splits) and in Karmarush.`;

/**
 * The hint under "Number of splits" for a list of splits (DESIGN 9.26): the number TrackScore and Karmarush need is the
 * number of splits that are SENT, and it says how many more are counted only.
 * @param {any[]} splits config or draft splits
 */
export function splitsHint(splits) {
  const list = arr(splits);
  const quiet = list.filter(notSent).length;
  const n = list.length - quiet;
  if (!quiet) return splitCountHint(n);
  return `${splitCountHint(n)} ${quiet === 1 ? '1 more split is' : `${quiet} more splits are`} counted only: Split Relay reads ${quiet === 1 ? 'it' : 'them'} and sends nothing for ${quiet === 1 ? 'it' : 'them'}, so ${quiet === 1 ? 'it is' : 'they are'} not in that number.`;
}

/** "9 splits", or "9 splits + 2 not sent" (DESIGN 9.26): a race's splits on its tile and in the Races list. */
export function splitsWord(splits) {
  const list = arr(splits);
  const quiet = list.filter(notSent).length;
  return quiet ? `${plural(list.length - quiet, 'split')} + ${quiet} not sent` : plural(list.length, 'split');
}

/** DESIGN 9.26: every split of the race is set to Not sent: the server's words (src/config.js allNotSentText). */
export const allNotSentText = (name) => `Every split of ${str(name).trim() || 'this race'} is set to Not sent, so nothing would go to TrackScore or Karmarush. Switch Send on for at least one split.`;

/**
 * DESIGN 9.26, mats close together and the tag filter: whether the tag filter is long enough to merge a fast runner's
 * reads at two mats 200 m apart (about 35 s): 30 s or more. The line below is then amber, not quiet.
 * @param {unknown} tagWindowSec the tag filter now
 */
export const closeMatsRisk = (tagWindowSec) => Number(str(tagWindowSec).replace(',', '.')) >= 30;

/**
 * DESIGN 9.26: the line under the splits of a race that has a split that is not sent. Such a mat is often a little after
 * a K marker, and the tag filter merges the reads of one runner that come within its window: a fast runner's second
 * pass would be merged into the first, a slow runner's would count.
 * @param {unknown} tagWindowSec the tag filter now
 */
export const closeMatsText = (tagWindowSec) => `The tag filter is ${str(tagWindowSec ?? 10)} s: reads of one runner that close together count as one pass. If two mats are that close on the course, set the tag filter below the fastest runner's time between them (a fast runner covers 200 m in about 35 s).`;

/** "Split 3": the name a split row gets until the operator types one. */
export const defaultSplitName = (i) => `Split ${i + 1}`;
const isDefaultName = (name) => /^split\s*\d+$/i.test(str(name).trim());

/**
 * Splits that still have a default name ("Split 3") are named after their place again, so after a row is removed the
 * names still say which pass each split is.
 * @template {{ name: string }} T
 * @param {T[]} splits
 * @returns {T[]} the same array, renamed in place
 */
export function renumberDefaultNames(splits) {
  arr(splits).forEach((s, i) => {
    if (isDefaultName(s.name)) s.name = defaultSplitName(i);
  });
  return splits;
}

/**
 * The "Number of splits" control: rows are added at the end (named "Split N") or removed from the end.
 * @param {any[]} splits draft splits
 * @param {number} n 1-20
 * @param {() => string} [makeKey] a key for a new row (the editor's list key)
 * @returns {any[]} a new array
 */
export function setSplitCount(splits, n, makeKey = () => '') {
  const list = arr(splits).slice(0, Math.max(0, n));
  while (list.length < n) {
    const k = makeKey();
    list.push({ ...(k ? { _k: k } : {}), name: defaultSplitName(list.length), sources: [], earliest: '', collectOnly: false });
  }
  return renumberDefaultNames(list);
}

/**
 * DESIGN 9.26: a new split right after split i of the list ("Add a split after this one"): a mat between two splits is
 * put where it is on the course. It is sent like any new split; the row's Send switch makes it one that is only counted.
 * @param {any[]} splits draft splits
 * @param {number} i the row it comes after
 * @param {() => string} [makeKey] a key for the new row (the editor's list key)
 * @returns {any[]} a new array
 */
export function addSplitAfter(splits, i, makeKey = () => '') {
  const list = arr(splits).slice();
  const k = makeKey();
  const at = Math.max(0, Math.min(list.length, i + 1));
  // named after the split before it until the operator types its name: unique, and it says where it is
  const before = str(list[at - 1]?.name).trim();
  let name = before && !isDefaultName(before) ? `After ${before}` : defaultSplitName(at);
  for (let n = 2; list.some((x) => norm(x.name) === norm(name)); n++) name = before && !isDefaultName(before) ? `After ${before} (${n})` : `Split ${list.length + n}`;
  list.splice(at, 0, { ...(k ? { _k: k } : {}), name, sources: [], earliest: '', collectOnly: false });
  return renumberDefaultNames(list);
}

/**
 * A race time as typed for a split's earliest time ("8:00", "8:00.5", "1:02:03") -> ticks, or null. A bare number is
 * refused: "8" could be 8 seconds or 8 minutes.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseRaceText(text) {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,4}))?$/.exec(str(text).trim());
  if (!m) return null;
  const [hh, mm, ss] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (ss > 59 || (m[1] && mm > 59)) return null;
  return ((hh * 60 + mm) * 60 + ss) * TICKS_PER_SEC + fractionTicks(m[4]);
}

/**
 * What changing the number or the order of a race's splits does to the splits already sent (DESIGN 9.15 L6).
 * @param {number} was the saved number of splits
 * @param {number} now the new number
 * @param {boolean} [reordered]
 */
export function columnsChangeText(was, now, reordered = false, recount = false, swapped = false) {
  // (9.26: was and now count the splits that are SENT; reordered: the same number, but in another order; swapped: the
  // same number, but other splits are sent; recount: the sent splits are the same, but a split that is only counted was
  // added, taken out or moved between them)
  if (was === now && swapped) {
    return `TrackScore and Karmarush put splits in columns by laps to go. With other splits sent than before, the splits already sent are in the wrong columns: after saving, resend this race's splits. ${RESEND_LIMIT}`;
  }
  if (was === now && !reordered && recount) {
    return `With a split that is counted only added, taken out or moved, every runner's passes are counted again from the first. The splits already sent after it may then hold another split's time: after saving, resend this race's splits. ${RESEND_LIMIT}`;
  }
  const why = was !== now ? `With ${now} splits instead of ${was}` : reordered ? 'With the splits in a new order' : '';
  if (!why) return '';
  const set = was !== now ? ` set the number of splits to ${now} in TrackScore (Intermediate splits) and in Karmarush, and` : '';
  return `TrackScore and Karmarush put splits in columns by laps to go. ${why}, the splits already sent are in the wrong columns: after saving,${set} resend this race's splits. ${RESEND_LIMIT}`;
}

/**
 * DESIGN 9.26: what a draft's splits change for the scoreboards, against the race as it is saved. TrackScore and
 * Karmarush know only the splits that are sent: `was` and `now` count those; `reordered`: the same number of them, but
 * not the same ones in the same order; `swapped` (with it): other splits are sent than before, not only another order;
 * `recount`: the sent splits are as they were, but a split that is only counted was added, taken out or moved between
 * them, so the runners' passes are counted again.
 * @param {any[]} saved the race's splits as saved
 * @param {any[]} draft the draft's splits
 * @returns {{ was: number, now: number, reordered: boolean, recount: boolean, swapped: boolean }}
 */
export function splitsChange(saved, draft) {
  const ids = (list) => JSON.stringify(arr(list).map((x) => x.id || null));
  const was = sentOnly(saved).length;
  const now = sentOnly(draft).length;
  const reordered = was === now && ids(sentOnly(saved)) !== ids(sentOnly(draft));
  const set = (list) => JSON.stringify(sentOnly(list).map((x) => x.id || null).sort());
  const swapped = reordered && set(saved) !== set(draft);
  const recount = was === now && !reordered && ids(saved) !== ids(draft);
  return { was, now, reordered, recount, swapped };
}

/**
 * What a Resend corrects and what it can't (DESIGN 9.16 F1), word for word the server's (src/engine.js RESEND_LIMIT):
 * a packet can fill a TrackScore cell but never empty one.
 */
export const RESEND_LIMIT = 'Resend corrects every split Split Relay has. A runner who has no split in a column under ' +
  'the new setting may still show an old time there in TrackScore and the live results until the race is cleared there.';
/** The first sentence of RESEND_LIMIT: said before the count of cells a Resend can't correct, when there are any. */
export const RESEND_FIXES = 'Resend corrects every split Split Relay has.';
/**
 * A held pass that is the runner's only pass so far (revision 10): Split Relay waits for their next pass or finish.
 * The same words as src/engine.js LONE_TEXT (a test checks it).
 */
export const LONE_TEXT = "It is this runner's only pass so far: Split Relay holds it until their next pass or their finish shows which split it is. You can decide now, but you don't have to.";

/**
 * What a Resend corrects and what it can't, for this race: the count of cells and the runners when the server knows
 * of any (RaceView.leftover), else the general words.
 * @param {any} lo RaceView.leftover
 */
export function resendLimitText(lo) {
  const t = leftoverText(lo);
  return t ? `${RESEND_FIXES} ${t}` : RESEND_LIMIT;
}

/**
 * RaceView.leftover in words (DESIGN 9.16 F1): "2 cells sent earlier can't be removed from TrackScore by Split Relay
 * (runners: 507, 519). ...", or '' when there are none. The server's words when it gives them.
 * @param {any} lo RaceView.leftover
 */
export function leftoverText(lo) {
  const count = Number(lo?.count) || 0;
  if (!count) return '';
  if (typeof lo.text === 'string' && lo.text.trim()) return lo.text;
  const bibs = arr(lo.runners).map(str).filter(Boolean);
  const one = bibs.length === 1;
  const who = bibs.length ? ` (${one ? 'runner' : 'runners'}: ${bibs.length > 12 ? `${bibs.slice(0, 12).join(', ')} and ${bibs.length - 12} more` : bibs.join(', ')})` : '';
  return `${plural(count, 'cell')} sent earlier can't be removed from TrackScore by Split Relay${who}. ${one ? 'This runner has' : 'These runners have'} no split in ${count === 1 ? 'that column' : 'those columns'} under the current settings, so TrackScore and the live results may still show an old time there until the race is cleared there.`;
}

/**
 * Reads of one routing key in words, after a count: "of 'JV'", "without a contest", "from port 5566", "of Event 3-1-1".
 * A LapTime read carries no contest: it is routed by its port, or by the event it names (DESIGN 9.15 L3).
 * The server says what a key is with `via` ('contest'|'event'|'port'|'blank'); its `contest` is then a label such
 * as "Port 5565".
 * @param {{ contest?: string, blank?: boolean, via?: string, port?: number|null, event?: string|null }} k
 */
export function readsLabel(k) {
  if (k?.via === 'port' && k.port != null) return `from port ${k.port}`;
  if (k?.via === 'event' && k.event) return `of Event ${k.event}`;
  const c = str(k?.contest);
  if (k?.via === 'blank' || k?.blank || !c) return 'without a contest';
  return `of '${c}'`;
}

/**
 * How set-aside reads of a routing key are used again (DESIGN 9.2 R5, 9.15 L3): a contest is listed on an Active race,
 * a port's reads (LapTime lines) need an Active race on that port, an event's an Active race with that event.
 * @param {{ via?: string, port?: number|null, event?: string|null }} k
 */
export function useAgainText(k) {
  if (k?.via === 'port' && k.port != null) return `you choose port ${k.port} on an Active race`;
  if (k?.via === 'event' && k.event) return `an Active race has Event ${k.event}`;
  return 'you list the contest on an Active race';
}

/** "Event 3-1-1" the way FinishLynx names an event, round and heat. */
export function eventLabel(r) {
  if (!r || !str(r.eventNumber).trim()) return '';
  return `Event ${str(r.eventNumber).trim()}-${str(r.round).trim() || '1'}-${str(r.heat).trim() || '1'}`;
}

const normId = (v) => str(v).trim().replace(/^0+(?=.)/, '').toLowerCase();

/**
 * The event, round and heat as the server and the .lif matching compare them (leading zeros dropped, round and heat
 * default to 1), or null when the race has no event number. Two races with the same key can't be told apart by
 * TrackScore or by the merged .lif files.
 * @returns {string | null}
 */
export function eventKey(r) {
  const en = normId(r?.eventNumber);
  if (!en) return null;
  return `${en}-${normId(r.round) || '1'}-${normId(r.heat) || '1'}`;
}

/**
 * The other races (not `id`) whose event, round and heat equal this draft's.
 * @param {any} draft a race or race draft
 * @param {any[]} races config races
 * @param {string} [id] the race being edited (left out of the comparison)
 */
export function sameEventRaces(draft, races, id) {
  const key = eventKey(draft);
  if (!key) return [];
  return arr(races).filter((r) => r && r.id !== id && eventKey(r) === key);
}

/**
 * Whether an output behaves like TrackScore XC: one live race at a time, switched by the event number in each
 * packet. A script that sends a "MID" is the live-results family, which takes every race. Before the script is
 * loaded, only the live-results script name (or a MID override) says otherwise, so the TrackScore warnings err on
 * the side of showing.
 * @param {any} o Output config
 * @param {any} [s] OutputStatus
 */
export function isTrackScoreLike(o, s) {
  if (str(o?.mid).trim()) return false;
  const info = s?.scriptInfo;
  if (s?.scriptOk !== false && info && typeof info === 'object' && 'mid' in info) return !info.mid;
  return !/karmarush/i.test(str(o?.script));
}

/**
 * "RR12 times arrive 2.1 s after this PC's clock." from State.input.clockLagSec (arrival time minus read time).
 * @returns {string} '' when unknown
 */
export function clockLagText(lag) {
  if (!Number.isFinite(lag)) return '';
  const x = Math.abs(lag).toFixed(1);
  return lag >= 0 ? `RR12 times arrive ${x} s after this PC's clock.` : `RR12 times are ${x} s ahead of this PC's clock.`;
}

/**
 * Of the reads waiting for this race's gun that the panel has in its feed, how many a gun at `gunTicks` would put
 * before the gun (so they would not be sent), and the earliest of them. The feed keeps only the newest entries, so
 * `known` can be lower than the race's waitingGun count.
 * @param {any[]} feed
 * @param {string} raceId
 * @param {number} gunTicks
 * @returns {{ count: number, known: number, earliest: number | null }}
 */
export function waitingBeforeGun(feed, raceId, gunTicks) {
  let count = 0;
  let known = 0;
  let earliest = null;
  for (const e of arr(feed)) {
    if (!e || e.raceId !== raceId || e.status !== 'waiting-gun' || !Number.isFinite(e.tod)) continue;
    known++;
    const rt = raceTicks(e.tod, gunTicks);
    if (rt < 0) {
      count++;
      if (earliest == null || raceTicks(e.tod, earliest) < 0) earliest = e.tod;
    }
  }
  return { count, known, earliest };
}

/**
 * "12 reads are waiting for the gun. 3 of them are earlier than 10:05:00.000 (the first at 10:04:58.120), so they
 * would count as before the gun and not be sent."
 * @param {{ count: number, known: number, earliest: number | null }} w from waitingBeforeGun
 * @param {number} waiting the race's waitingGun count
 * @param {string} at the new gun as text
 */
export function waitingBeforeText(w, waiting, at) {
  const total = Math.max(Number(waiting) || 0, w.count);
  const head = `${plural(total, 'read')} ${total === 1 ? 'is' : 'are'} waiting for the gun.`;
  if (w.count === 1) {
    return `${head} ${total === 1 ? 'It is' : 'One of them is'} earlier than ${at} (at ${formatTod(w.earliest)}), so it would count as before the gun and not be sent.`;
  }
  const which = w.count >= total ? 'All of them are' : `${w.known < total ? 'At least ' : ''}${fmtInt(w.count)} of them are`;
  return `${head} ${which} earlier than ${at} (the first at ${formatTod(w.earliest)}), so they would count as before the gun and not be sent.`;
}

/** RaceView.waitingGun, or the older `pending` from a server that does not send it yet. */
export const waitingCount = (rv) => Number(rv?.waitingGun ?? rv?.pending) || 0;

/** The difference gun - FinishLynx start in ticks, or null when either is unknown. */
export function gunVsLynx(rv) {
  if (!rv || !Number.isFinite(rv.gunTicks) || !Number.isFinite(rv.lynxStart)) return null;
  return raceTicks(rv.gunTicks, rv.lynxStart);
}

/** More than 1 ms apart: FinishLynx prints 4 decimals, so anything more is a different start, not rounding. */
export const gunDiffers = (rv) => {
  const d = gunVsLynx(rv);
  return d != null && Math.abs(d) > 10;
};

/**
 * What the race tile's resend prompt says, driven by the server (RaceView.resendSuggested and .stale, DESIGN.md
 * §9.7) so every tab and a reload show it. A server without those fields falls back to the offer this tab made
 * itself after its own gun change.
 * @param {any} rv RaceView
 * @param {{ count: number } | undefined} [local]
 * @param {{ was: number, now: number, reordered?: boolean } | null} [columns] this tab saved a new number or order of
 *   splits after splits went out (used when the server does not say why its splits are stale)
 * @returns {{ server: boolean, count: number, byOutput: { outputId: string, name: string, count: number }[],
 *   columns: { was: number, now: number, reordered: boolean } | null, leftover?: string } | null}
 *   leftover: RaceView.leftover in words (DESIGN 9.16 F1), when there are cells a Resend can't correct
 */
export function resendPrompt(rv, local, columns = null) {
  const cols = staleColumns(rv, columns);
  if (rv && ('resendSuggested' in rv || (rv.stale && typeof rv.stale === 'object'))) {
    const count = Number(rv.stale?.count) || 0;
    if (!rv.resendSuggested && !count) return null;
    const byOutput = arr(rv.stale?.byOutput).filter((o) => o && Number(o.count) > 0)
      .map((o) => ({ outputId: str(o.outputId), name: str(o.name) || 'an output', count: Number(o.count) }));
    const leftover = leftoverText(rv.leftover);
    return { server: true, count, byOutput, columns: cols, ...(leftover ? { leftover } : {}) };
  }
  return local && Number(local.count) > 0 ? { server: false, count: Number(local.count), byOutput: [] } : null;
}

/**
 * Whether the splits already sent are stale because the number or the order of the race's splits changed (DESIGN
 * 9.15 L6: the ledger compares lapsToGo and splitCount). The server's RaceView.stale says so when it can; else what
 * this tab saved itself.
 * @returns {{ was: number, now: number, reordered: boolean } | null}
 */
function staleColumns(rv, local) {
  const s = rv?.stale && typeof rv.stale === 'object' ? rv.stale : {};
  // (9.26: the splits that are sent, when some are only counted: RaceView.sentCount)
  const now = Number(rv?.sentCount ?? rv?.splitCount ?? arr(rv?.splits).length);
  // stale.reason: 'split-count' (sent when the race had splitCountFrom splits), 'order', 'changed' (gun, places)
  const was = Number(s.splitCountFrom);
  if (s.reason === 'split-count' && Number.isFinite(was) && was > 0 && Number.isFinite(now) && now > 0 && was !== now) return { was, now, reordered: false, ...(rv?.sentCount != null ? { sends: true } : {}) };
  if (s.reason === 'order') return { was: now, now, reordered: true, ...(rv?.sentCount != null ? { sends: true } : {}) };
  // the server knows better than this tab what is stale and why
  if (s.reason === 'changed') return null;
  if (local && (local.was !== local.now || local.reordered)) return { was: Number(local.was), now: Number(local.now), reordered: !!local.reordered && local.was === local.now };
  return null;
}

/**
 * The words of the resend prompt. Honest about what a Resend can do (DESIGN 9.16 F1): it corrects every split Split
 * Relay has, but a TrackScore cell that no current split fills keeps its old time; the count when the server knows.
 */
export function resendPromptText(p) {
  return resendPromptParts(p).join(' ');
}

/**
 * The resend prompt in two parts: what is out of date and what to do, then what a Resend can and can't correct (with
 * the count of cells it can't, when the server knows them). The race tile shows the first, and the second behind its "?".
 * @returns {string[]} [] for no prompt
 */
/**
 * Where the splits sent are out of date (9.23 F14: a runner's split counts once, whatever the number of outputs): " on
 * TrackScore and Karmarush" when every output has all of them, else " (TrackScore: 58, Karmarush: 12)"; '' unknown.
 * @param {{ count: number, byOutput: { name: string, count: number }[] }} p resendPrompt
 */
export function staleWhere(p) {
  const by = arr(p?.byOutput);
  if (!by.length) return '';
  return by.every((o) => o.count === p.count) ? ` on ${listText(by.map((o) => o.name))}` : ` (${by.map((o) => `${o.name}: ${fmtInt(o.count)}`).join(', ')})`;
}

export function resendPromptParts(p) {
  if (!p) return [];
  let head;
  if (p.columns) {
    const c = p.columns;
    // (9.26: with splits that are only counted, the number is of the ones it sends: the engine's words too)
    const what = c.was !== c.now ? `this race now ${c.sends ? 'sends' : 'has'} ${c.now} splits instead of ${c.was}` : c.sends ? "this race's splits are in a new order, or other splits are sent now" : "this race's splits are in a new order";
    head = `TrackScore and Karmarush put splits in columns by laps to go; ${what}, so the splits already sent are in the wrong columns. Resend this race's splits.`;
  } else if (!p.server) {
    head = `The gun time changed after ${plural(p.count, 'split')} ${p.count === 1 ? 'was' : 'were'} sent, so TrackScore still shows the old race times. Resend this race's splits.`;
  } else {
    const where = staleWhere(p);
    const what = p.count ? `${plural(p.count, 'split')} already sent ${p.count === 1 ? 'is' : 'are'} out of date${where}.` : 'Splits already sent are out of date.';
    head = `${what} The gun time, the splits or the places changed after they went out. Resend this race's splits.`;
  }
  return [head, p.leftover ? `${RESEND_FIXES} ${p.leftover}` : RESEND_LIMIT];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Status pills                                                                                                 */

/**
 * The RR12 pill. With several ports (State.inputs, DESIGN 9.15 L2) it says how many receive: "Receiving on 2 ports".
 * @param {any} input State.input (the aggregate)
 * @param {number} nowMs
 * @param {any[]} [inputs] State.inputs, one per port
 * @returns {{ tone: string, text: string, title?: string }}
 */
export function inputPill(input, nowMs, inputs) {
  const list = arr(inputs).filter((x) => x && x.port != null);
  if (list.length > 1) return portsPill(list, input, nowMs);
  const port = input?.port ?? list[0]?.port ?? '?';
  if (!input) return { tone: 'muted', text: 'RR12 input' };
  if (input.error) return { tone: 'bad', text: `RR12 input problem (port ${port})`, title: str(input.error) };
  if (input.listening === false) return { tone: 'bad', text: `Not listening for RR12 (port ${port})` };
  const n = arr(input.connections).length;
  if (!n) return { tone: 'warn', text: `Waiting for RR12 on port ${port}` };
  const last = toMs(input.lastLineAt);
  const lag = clockLagText(input.clockLagSec);
  return {
    tone: 'ok',
    text: ['Receiving', plural(n, 'connection'), last ? 'last read ' + formatAgo(nowMs - last) : 'no reads yet'].join(' · '),
    title: lag || undefined,
  };
}

function portsPill(list, input, nowMs) {
  const bad = list.find((i) => i.error);
  if (bad) return { tone: 'bad', text: `RR12 input problem (port ${bad.port})`, title: str(bad.error) };
  const deaf = list.find((i) => i.listening === false);
  if (deaf) return { tone: 'bad', text: `Not listening for RR12 (port ${deaf.port})` };
  const on = list.filter((i) => arr(i.connections).length);
  const off = list.filter((i) => !arr(i.connections).length);
  if (!on.length) return { tone: 'warn', text: `Waiting for RR12 on ${portsText(list.map((i) => i.port))}` };
  const times = [input?.lastLineAt, ...list.map((i) => i.lastLineAt)].map(toMs).filter((t) => t != null);
  const last = times.length ? Math.max(...times) : null;
  const head = off.length ? `Receiving on ${portsText(on.map((i) => i.port))}` : `Receiving on ${list.length} ports`;
  // a second port waits until its exporter is started for an overlapping race: worth saying, not a fault
  const waiting = off.length ? `${listText(off.map((i) => String(i.port)))} waiting` : '';
  const lag = clockLagText(input?.clockLagSec);
  return {
    tone: 'ok',
    text: [head, waiting, last ? 'last read ' + formatAgo(nowMs - last) : 'no reads yet'].filter(Boolean).join(' · '),
    title: [list.map((i) => `Port ${i.port}: ${arr(i.connections).length ? plural(arr(i.connections).length, 'connection') : 'not connected'}`).join('. ') + '.', lag].filter(Boolean).join(' '),
  };
}

/**
 * "120 packets behind" / "8 s behind" when an output accepts packets faster than it delivers them (DESIGN.md §9.5:
 * behind = packets not yet written, lagSec = age of the oldest unacknowledged one), or '' while it keeps up.
 */
export function behindText(s) {
  const lag = Number(s?.lagSec);
  if (!Number.isFinite(lag) || lag <= 5) return '';
  const n = Number(s?.behind) || 0;
  return n > 0 ? `${plural(n, 'packet')} behind` : `${Math.round(lag)} s behind`;
}

/** What an output's state means, in words. */
export function outputStateWord(o, s) {
  if (o?.enabled === false || s?.state === 'disabled') return 'Off';
  if (s?.scriptOk === false) return 'Script problem';
  switch (s?.state) {
    case 'connected': return 'Connected';
    case 'connecting': return 'Connecting…';
    case 'disconnected': return 'Not connected';
    case 'listening': return s.clients ? `Listening · ${plural(s.clients, 'program')} connected` : 'Listening · nobody connected';
    case 'error': return 'Error';
    default: return 'Starting…';
  }
}

export function outputPill(o, s) {
  const name = str(o?.name || s?.name) || 'Output';
  const word = outputStateWord(o, s);
  if (o?.enabled === false || s?.state === 'disabled') return { tone: 'muted', text: `${name} · off` };
  if (s?.scriptOk === false) return { tone: 'bad', text: `${name} · script problem`, title: str(s.scriptError) };
  const queued = Number(s?.queued) || 0;
  const q = queued ? ` · ${fmtInt(queued)} waiting` : '';
  const behind = behindText(s);
  const lagTitle = behind ? `The oldest packet has waited ${Math.round(Number(s.lagSec))} s. The receiving program or the network is slow.` : '';
  switch (s?.state) {
    case 'connected':
      if (behind) return { tone: 'warn', text: `${name} · ${behind}`, title: [lagTitle, str(s.lastError)].filter(Boolean).join(' ') };
      return { tone: s.lastError ? 'warn' : 'ok', text: `${name} · connected${q}`, title: str(s.lastError) || undefined };
    case 'listening':
      if (s.clients && behind) return { tone: 'warn', text: `${name} · ${behind}`, title: lagTitle };
      return { tone: s.clients ? 'ok' : 'warn', text: `${name} · ${s.clients ? plural(s.clients, 'client') : 'no clients'}` };
    case 'connecting': return { tone: 'warn', text: `${name} · connecting${q}` };
    case 'disconnected': return { tone: 'bad', text: `${name} · not connected${q}` };
    case 'error': return { tone: 'bad', text: `${name} · error`, title: str(s.lastError) };
    default: return { tone: 'muted', text: `${name} · ${word.toLowerCase()}` };
  }
}

/**
 * The merged .lif status 'waiting' in words (DESIGN 9.16 F5): the FinishLynx folder is there but has no .lif file to
 * use yet. Not a wrong-path message: a folder that is not there is an error that says "not found: check the path".
 * @param {any} lif LifStatus
 */
export function lifWaitingText(lif) {
  if (str(lif?.message).trim()) return str(lif.message).trim();
  const dir = str(lif?.inputDir).trim();
  return `No FinishLynx .lif files${dir ? ` in ${dir}` : ''} yet.`;
}

export function lifPill(lif) {
  const files = arr(lif?.files).length;
  switch (lif?.state) {
    case 'ok': return { tone: 'ok', text: `.lif files · ${plural(files, 'file')}` };
    // the folder is there, with nothing in it to use yet (DESIGN 9.16 F5); a folder that isn't there is an 'error'
    case 'waiting': return { tone: 'warn', text: '.lif files · no FinishLynx files yet', title: str(lif.message) || undefined };
    case 'error': return { tone: 'bad', text: '.lif files · problem', title: str(lif.error) };
    case 'off': return { tone: 'muted', text: '.lif files · off' };
    default: return { tone: 'muted', text: '.lif files' };
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Plain-English warnings. Each says what is wrong and what to do, and links to the place to do it.             */

/**
 * A warning is plain data (tests check it, and its JSON is the repaint signature). `action` is a link (href) or a
 * one-click command (cmd, run by the page); `picker` is an inline race chooser for one output.
 * @typedef {{ label: string, href?: string, cmd?: 'lynx-gun'|'lynx-name'|'output-race'|'aside-race'|'missing-delete'|'missing-restore'|'switch'|'keep-race'|'delete-race',
 *   raceId?: string, outputId?: string, value?: string, raceName?: string, via?: string, port?: number|null,
 *   event?: string|null }} WarningAction  via/port/event: a set-aside port's or event's reads (LapTime lines)
 * @typedef {{ outputId: string, outputName: string, options: { id: string, name: string }[], selected: string }} RacePicker
 * @typedef {{ tone: 'info'|'warn'|'bad', text: string, hint?: string, action?: WarningAction, more?: WarningAction[], picker?: RacePicker }} Warning
 */

/**
 * The race an output that must take one race should most likely get: the active race whose gun went last (and has
 * gone), else the first active race.
 * @param {any} st
 * @param {any[]} active config races
 * @param {number} nowMs
 */
function likelyLiveRace(st, active, nowMs) {
  let best = null;
  let bestGun = -Infinity;
  for (const r of active) {
    const rv = viewOf(st, r.id);
    const el = elapsedNow(rv, st, nowMs);
    if (el == null || el < 0) continue;
    // a later gun = a smaller race clock
    if (-el > bestGun) {
      bestGun = -el;
      best = r;
    }
  }
  return (best || active[0])?.id || '';
}

/** DESIGN 9.15 L8 / 9.20 N1: the warning when RR12 sends LapTime lines (bibs only) and no people file is chosen. */
export const NAMES_WARNING = "RR12 sends only bibs, so the split packets carry no names, schools or gender. Choose the people file (.ppl) FinishLynx uses for this meet: Split Relay takes each runner's name from it.";

/**
 * The splits of a race that went out: its crossings, less the ones a paused split holds back (9.26: and less the ones of
 * a split that is counted but not sent).
 */
export const sentSplits = (rv) => arr(rv?.splits).reduce((n, s) => (notSent(s) ? n : n + Math.max(0, (Number(s?.crossings) || 0) - (Number(s?.held) || 0))), 0);

/**
 * The Active races whose splits went out to an output that is switched on (DESIGN 9.20): what TrackScore and the live
 * results already show, with the names the packets had.
 * @param {any} st State
 * @returns {{ id: string, name: string, sent: number, outputs: string[] }[]}
 */
export function racesSent(st) {
  const outs = arr(st?.config?.outputs).filter((o) => o && o.enabled !== false);
  const out = [];
  for (const r of arr(st?.config?.races)) {
    if (!r || r.active === false) continue;
    const to = outs.filter((o) => outputSendsRace(o, r.id));
    const n = sentSplits(viewOf(st, r.id));
    if (n > 0 && to.length) out.push({ id: r.id, name: str(r.name) || '(no name)', sent: n, outputs: to.map((o) => str(o.name).trim() || 'an output') });
  }
  return out;
}

/**
 * DESIGN 9.20 N1: whether the split packets go without names. 'none': RR12 sends only bibs (LapTime lines) and no names
 * file is chosen; 'unread': a names file is chosen but no names came from it. Red once an Active race has sent splits
 * (TrackScore shows those runners without names now), amber before.
 * @param {any} st State
 * @returns {{ missing: boolean, why: 'none'|'unread'|null, tone: 'bad'|'warn'|null, sent: ReturnType<typeof racesSent>, outputs: string[] }}
 */
export function namesGap(st) {
  const path = str(st?.config?.names?.pplPath).trim();
  // LapTime lines carry a bib and a time only (an older server says so only in the ports' formats)
  const lapTime = inputsOf(st).some((i) => i.format === 'laptime') || st?.input?.format === 'laptime' || arr(st?.races).some((v) => Number(v?.passes) > 0);
  let why = null;
  if (!path) {
    if (typeof st?.namesNeeded === 'boolean' ? st.namesNeeded : lapTime) why = 'none';
  } else if (st?.names && st.names.loaded === false && lapTime) why = 'unread';
  if (!why) return { missing: false, why: null, tone: null, sent: [], outputs: [] };
  const sent = racesSent(st);
  return { missing: true, why, tone: sent.length ? 'bad' : 'warn', sent, outputs: [...new Set(sent.flatMap((r) => r.outputs))] };
}

/** "Girls 5K (84 splits) already went out without names; once the file is in, “Send names now” fills them in." */
function sentWithoutNamesText(sent) {
  if (!sent.length) return '';
  const one = sent.length === 1 && sent[0].sent === 1;
  return ` ${listText(sent.map((r) => `${r.name} (${plural(r.sent, 'split')})`))} already went out without names; once the file is in, “Send names now” fills ${one ? 'it' : 'them'} in.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a file was last changed, on this PC's clock: "modified today 09:12", "modified yesterday 18:40",
 * "modified 12 Oct 18:40" (with the year when it is not this year's). An old date says it may be last meet's file.
 * @param {number} ms
 * @param {number} [now]
 */
export function modifiedText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const n = new Date(now);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86400000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 0) return `modified today ${hm}`;
  if (days === 1) return `modified yesterday ${hm}`;
  return `modified ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ` ${d.getFullYear()}` : ''} ${hm}`;
}

/**
 * DESIGN 9.20 N2: the folders to look in for the meet's .ppl: FinishLynx's results folder (Settings → Merged .lif
 * files) and the folder above it, where FinishLynx keeps its people file. Nothing when that folder is not set.
 * @param {any} st State
 * @returns {string[]}
 */
export function pplFolders(st) {
  let dir = str(st?.config?.lif?.inputDir).trim().replace(/[\\/]+$/, '');
  if (!dir) return [];
  if (/^[A-Za-z]:$/.test(dir)) dir += '\\';
  const up = dirName(dir);
  return up && normPath(up) !== normPath(dir) ? [dir, up] : [dir];
}

/**
 * The .ppl files to offer, newest first (at most 4), from the GET /api/files?ext=.ppl&times=1 listings of pplFolders.
 * Only offered: Split Relay never loads one by itself.
 * @param {any[]} listings
 * @param {string} [current] the names file in use: marked, so it is not offered as new
 * @returns {{ path: string, name: string, mtimeMs: number|null, current: boolean }[]}
 */
export function pplSuggestions(listings, current = '') {
  const seen = new Set();
  const out = [];
  for (const l of arr(listings)) {
    for (const e of arr(l?.entries)) {
      if (!e || e.type !== 'file' || !/\.ppl$/i.test(str(e.name))) continue;
      const key = normPath(e.path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ path: str(e.path), name: str(e.name), mtimeMs: Number.isFinite(e.mtimeMs) ? e.mtimeMs : null, current: !!str(current).trim() && key === normPath(current) });
    }
  }
  return out.sort((a, b) => (b.mtimeMs ?? -Infinity) - (a.mtimeMs ?? -Infinity) || a.path.localeCompare(b.path)).slice(0, 4);
}

/** "Use C:\Lynx\Lynx.ppl (modified today 09:12)". */
export function pplUseLabel(s, now = Date.now()) {
  const when = s?.mtimeMs != null ? modifiedText(s.mtimeMs, now) : '';
  return `Use ${str(s?.path)}${when ? ` (${when})` : ''}`;
}

/**
 * DESIGN 9.20 N3: whether the names just came in, between two States this page saw: a names file where there was none,
 * another file, or the same file that could not be read before. A re-read of the same file (FinishLynx saved it again)
 * is not: the names were in the splits already.
 * @param {any} prev State.names of the State seen before (null: this is the first one)
 * @param {any} next State.names now
 */
export function namesArrived(prev, next) {
  if (!prev || !next || !next.loaded || !(Number(next.count) > 0)) return false;
  const path = str(next.path).trim();
  if (!path) return false;
  return normPath(prev.path) !== normPath(path) || !prev.loaded;
}

/**
 * The offer once the names came in (namesArrived): the Active races that had sent splits without them. Kept by the
 * page (localStorage) as { key: path|loadedAt, path, count, races: { id: 'open'|'sent'|'dismissed' } }, so the same file
 * is offered once.
 * @param {any} st State with the names loaded
 * @param {{ switched?: boolean }} [o] switched: another names file was loaded before, so the splits went out with its names
 * @returns {{ key: string, path: string, count: number, races: Record<string, 'open'>, switched?: true } | null} null: nothing to fill in
 */
export function namesOfferFor(st, { switched = false } = {}) {
  const n = st?.names || {};
  const races = racesSent(st);
  if (!n.loaded || !races.length) return null;
  const offer = { key: `${normPath(n.path)}|${n.loadedAt ?? ''}`, path: str(n.path), count: Number(n.count) || 0, races: Object.fromEntries(races.map((r) => [r.id, 'open'])) };
  return switched ? { ...offer, switched: true } : offer;
}

/**
 * What "Send names now" could do besides filling in names: a TrackScore-like output (one race at a time) that takes this
 * race and another Active race that has sent splits may be showing the other one, and would switch to this race and
 * clear it. Then the panel asks first.
 * @param {any} st State
 * @param {string} id race id
 * @returns {{ output: string, others: string[] }[]}
 */
export function namesSendRisk(st, id) {
  const others = racesSent(st).filter((r) => r.id !== id);
  const out = [];
  for (const o of arr(st?.config?.outputs)) {
    if (!o || o.enabled === false || !outputSendsRace(o, id) || !isTrackScoreLike(o, outputStatus(st, o.id))) continue;
    const also = others.filter((r) => outputSendsRace(o, r.id)).map((r) => r.name);
    if (also.length) out.push({ output: str(o.name).trim() || 'TrackScore', others: also });
  }
  return out;
}

/**
 * Needs attention lines for an open names offer: one per race, "Send names now" (= Resend, the runners who have
 * finished left out: their names came with FinishLynx's own packets) and "Not now".
 * @param {any} st State
 * @param {any} offer the kept offer (namesOfferFor)
 * @returns {Warning[]}
 */
export function namesOfferItems(st, offer) {
  if (!offer || typeof offer !== 'object' || !st?.names?.loaded || normPath(st.names.path) !== normPath(offer.path)) return [];
  const out = [];
  for (const [id, state] of Object.entries(offer.races || {})) {
    if (state !== 'open') continue;
    const r = configRace(st, id);
    if (!r || r.active === false) continue;
    const outs = arr(st.config?.outputs).filter((o) => o && o.enabled !== false && outputSendsRace(o, id)).map((o) => str(o.name).trim() || 'an output');
    if (!outs.length) continue;
    const name = str(r.name) || '(no name)';
    const to = listText(outs);
    out.push({
      tone: 'warn',
      id: 'names-send:' + id,
      // a switch from one names file to another: the splits went out with the earlier file's names, not without names
      title: offer.switched ? `Update the names on ${to}` : `Fill in the names on ${to}`,
      text: offer.switched
        ? `${name}'s splits went out with the names from the earlier names file. “Send names now” sends the race's splits again with the names from ${baseName(offer.path)}; runners who have finished are left out (FinishLynx sent their names).`
        : `${name}'s splits went out before the names file was in, so ${to} ${outs.length === 1 ? 'shows' : 'show'} those runners without names. “Send names now” sends the race's splits again, now with names; runners who have finished are left out (FinishLynx sent their names).`,
      action: { label: 'Send names now', cmd: 'send-names', raceId: id },
      more: [{ label: 'Not now', cmd: 'names-not-now', raceId: id, ghost: true }],
    });
  }
  return out;
}

/** A State.noRace / plan entry routed by its RR12 port or its event, not by a contest (DESIGN 9.15 L3). */
export const keyedByPort = (n) => n?.via === 'port' || n?.via === 'event';

/**
 * DESIGN 9.15 L6: an output refused packets that would have put a split in the wrong column or made it a finish.
 * @param {string} name output name
 * @param {number} n OutputStatus.refused
 */
export function refusedText(name, n) {
  const one = n === 1;
  return `${name}: ${plural(n, 'split packet')} ${one ? 'was' : 'were'} not sent since Split Relay started, because ${one ? 'its' : 'their'} laps to go ` +
    `was 0 or more than the race's number of splits, or ${one ? 'it' : 'they'} carried a finish time: TrackScore and Karmarush would have shown a wrong ` +
    "column or a finish. Check the race's number of splits on the Races page; the log file lists each one.";
}

/**
 * Notices about the settings Split Relay started with (DESIGN 9.15 V1, V5): two Active races that would take the same
 * reads (it kept the first and unticked Active on the others, so no read is split between them silently), and a
 * deleted race that is back in the settings after config.json fell back to a copy. Red: a race may not be running as
 * the operator thinks.
 * @param {any} st State
 * @returns {Warning[]}
 */
export function settingsNotices(st) {
  const out = [];
  const races = arr(st?.config?.races);
  // V1: { raceId, raceName, keptId, keptName, why: "both take port 5565" }
  for (const u of arr(st?.startConflicts ?? st?.unticked)) {
    if (!u || typeof u !== 'object' || !str(u.raceName || u.raceId)) continue;
    const name = str(u.raceName) || races.find((r) => r.id === u.raceId)?.name || 'A race';
    const kept = str(u.keptName) || races.find((r) => r.id === u.keptId)?.name || 'another race';
    const why = str(u.why) || 'want the same reads';
    const here = races.some((r) => r.id === u.raceId && r.active === false);
    out.push({
      tone: 'bad',
      title: `${name} was switched off at start`,
      text: `When Split Relay started, ${name} and ${kept} were both Active, and they ${why}, so a read could go to only one of them. Split Relay kept ${kept} Active and unticked Active on ${name}. If ${name} is the race running now, switch to it.`,
      ...(here ? { action: { label: `Switch to ${name}…`, cmd: 'switch', raceId: u.raceId } } : {}),
    });
  }
  // V5: { raceId, raceName, deletedName, deletedAt, count }: deleted, and back in config.json from an older copy
  for (const b of arr(st?.deletedBack)) {
    if (!b || typeof b !== 'object' || !races.some((r) => r.id === b.raceId)) continue;
    const name = races.find((r) => r.id === b.raceId)?.name || str(b.raceName) || 'A race';
    const was = str(b.deletedName) && norm(b.deletedName) !== norm(name) ? ` (then called ${b.deletedName})` : '';
    const n = Number(b.count) || 0;
    const when = toMs(b.deletedAt) ? ` at ${formatWall(toMs(b.deletedAt))}` : '';
    out.push({
      tone: 'bad',
      title: `${name} is back in the settings after a delete`,
      text: `${name}${was} was deleted${when}, but it is back in the settings: config.json was put back from an older copy (config.json.bak) or edited. ${n ? `The ${plural(n, 'read')} it had when it was deleted stay${n === 1 ? 's' : ''} out of use; only` : 'Only'} its reads from now on count. Keep it if it should be there, or delete it again.`,
      action: { label: 'Keep it', cmd: 'keep-race', raceId: b.raceId, raceName: name },
      more: [{ label: 'Delete it again…', cmd: 'delete-race', raceId: b.raceId, raceName: name }],
    });
  }
  return out;
}

/**
 * "RR12 isn't connected" (DESIGN 9.16 F4), naming every RR12 input port that has no connection, with the Active races
 * it feeds. With one port: when it has none. With several: when none has one, or when a port with none feeds an
 * Active race (a second port that waits for the next overlapping race is not a problem, and the pill says it waits).
 * @param {any} st State
 * @param {any[]} [inputs] State.inputs (inputsOf)
 * @param {any[]} [races] config races
 * @returns {Warning | null}
 */
/**
 * RR12 can show its exporter as connected while Split Relay sees nothing: the exporter keeps the address it was started
 * with (a port typed later, say 5565 over 5556, is only used after Stop and Start; Pause and Resume keep the old
 * connection), or it is connected to another program. Said in the warning's details.
 */
export const RR_CONNECTED_HINT = "Does RR12 say the exporter is connected? Then it is connected somewhere else: a running exporter keeps the address it was started with. Check the destination in RR12, then Stop the exporter and start it again (Pause and Resume keep the old connection).";

export function rrNotConnected(st, inputs = inputsOf(st), races = arr(st?.config?.races), nowMs = Date.now()) {
  const off = arr(inputs).filter((i) => !arr(i.connections).length);
  if (!off.length) return null;
  const action = { label: 'Exporter settings', href: '#settings/exporter' };
  const one = inputs.length === 1;
  const activeOn = (port) => arr(races).filter((r) => r && r.active !== false && (one || portNum(r.inputPort) === Number(port)));
  const feeds = (port) => activeOn(port).map((r) => r.name || '(no name)');
  // red once a race that reads from the port has started: its splits are being missed now
  const started = off.some((i) => activeOn(i.port).some((r) => gunGone(viewOf(st, r.id), st, nowMs)));
  const ports = off.map((i) => Number(i.port));
  if (one) {
    const names = feeds(inputs[0].port);
    return { tone: started ? 'bad' : 'warn', id: 'rr-off', ports, title: `RR12 not connected${names.length ? ` · ${listText(names)}` : ''}`,
      text: `RR12 isn't connected. In RR12, press play on the Split Relay exporter (sending to ${rrTarget(st, inputs[0].port)}).`, hint: RR_CONNECTED_HINT, action };
  }
  if (off.length < inputs.length && !off.some((i) => feeds(i.port).length)) return null;
  const targets = off.map((i) => {
    const names = feeds(i.port);
    return `${rrTarget(st, i.port)}${names.length ? ` (${listText(names)})` : ''}`;
  });
  const names = off.flatMap((i) => feeds(i.port));
  const many = off.length > 1;
  return {
    tone: started ? 'bad' : 'warn', id: 'rr-off', ports,
    title: `RR12 not connected on ${portsText(ports)}${names.length ? ` · ${listText(names)}` : ''}`,
    text: `RR12 isn't connected on ${portsText(ports)}. In RR12, press play on the Split Relay ${many ? 'exporters that send' : 'exporter that sends'} to ${listText(targets, 10)}.`,
    hint: RR_CONNECTED_HINT,
    action,
  };
}

/** The race's gun is set and has gone: reads should be coming in. */
export function gunGone(rv, st, nowMs) {
  if (!rv || !Number.isFinite(rv.gunTicks)) return false;
  const el = elapsedNow(rv, st, nowMs);
  return el != null && el >= 0;
}

/** After this long down while a race runs, an output's problem turns red: the boards are falling behind. */
export const DOWN_RED_MS = 45000;

/**
 * An output's light: its tone and a short word, from its pill; a connection that has been down for DOWN_RED_MS while
 * a race is running turns red, with how long.
 * @param {any} o Output config
 * @param {any} s OutputStatus
 * @param {{ since?: number | null, running?: boolean, now?: number }} [x] since: when the panel first saw it down
 * @returns {{ tone: string, word: string, title: string, down: number }}
 */
export function outputLight(o, s, { since = null, running = false, now = Date.now() } = {}) {
  const p = outputPill(o, s);
  const down = since != null && (s?.state === 'disconnected' || s?.state === 'connecting') ? Math.max(0, now - since) : 0;
  let tone = p.tone;
  if (s?.state === 'disconnected' || s?.state === 'connecting') tone = running && down >= DOWN_RED_MS ? 'bad' : 'warn';
  const word = o?.enabled === false || s?.state === 'disabled' ? 'off'
    : tone === 'ok' ? '' : s?.scriptOk === false ? 'script problem'
      : s?.state === 'disconnected' || s?.state === 'connecting' ? 'not connected'
        : s?.state === 'error' ? 'error' : s?.state === 'listening' && !s?.clients ? 'no clients' : behindText(s) || 'check';
  const title = [p.text, down >= 5000 ? `down ${formatDuration(down)}` : '', p.title].filter(Boolean).join(' · ');
  return { tone, word, title, down };
}

/**
 * Problems that are not about one race.
 * @param {any} st State
 * @param {number} nowMs
 * @param {any[]} feed newest first
 * @param {{ downSince?: Map<string, number> }} [opts] downSince: when the panel first saw each output ('out:<id>') down
 * @returns {Warning[]}
 */
export function globalWarnings(st, nowMs, feed = [], opts = {}) {
  /** @type {Warning[]} */
  const out = [];
  if (!st) return out;
  const cfg = st.config || {};
  const races = arr(cfg.races);
  const outputs = arr(cfg.outputs);
  const input = st.input || {};
  const inputs = inputsOf(st);

  // V1 / V5 (DESIGN 9.15): what Split Relay had to change, or found odd, in the settings when it started
  out.push(...settingsNotices(st));

  const broken = inputs.filter((i) => i.error);
  const deaf = inputs.filter((i) => !i.error && i.listening === false);
  for (const i of broken) {
    out.push({ tone: 'bad', title: `RR12 port ${i.port} can't receive reads`, text: `Split Relay can't receive reads from RR12 on port ${i.port}: ${i.error}. If another program is using port ${i.port}, close it or choose another port on the Inputs page.`, action: { label: 'RR12 inputs', href: '#settings/input' } });
  }
  for (const i of deaf) {
    out.push({ tone: 'bad', title: `Not listening on RR12 port ${i.port}`, text: `Split Relay isn't listening for RR12 on port ${i.port}. Check the RR12 inputs.`, action: { label: 'RR12 inputs', href: '#settings/input' } });
  }
  const rrWarning = rrNotConnected(st, inputs, races, nowMs);
  if (!broken.length && !deaf.length && rrWarning) out.push(rrWarning);

  if (!races.length) out.push({ tone: 'warn', title: 'No races yet', text: 'No races yet. Add a race so Split Relay knows which reads are splits.', action: { label: 'Add a race', href: '#races/new' } });
  if (!outputs.length) out.push({ tone: 'warn', title: 'No outputs yet: nothing is sent', text: 'No outputs yet, so nothing is being sent. Add TrackScore on the Outputs page.', action: { label: 'Add an output', href: '#outputs/new' } });
  else if (!outputs.some((o) => o.enabled !== false)) out.push({ tone: 'warn', title: 'Every output is switched off', text: 'Every output is switched off, so nothing is being sent.', action: { label: 'Outputs', href: '#outputs' } });

  const active = races.filter((r) => r.active !== false);
  // an output that stays down while a race runs: the boards fall behind, so it turns red (DOWN_RED_MS)
  const running = active.some((r) => isRunning(viewOf(st, r.id), r, st, nowMs));
  for (const o of outputs) {
    // switched off while a race it would send is running: its board gets nothing (said once, not as a fault)
    if (o.enabled === false) {
      const misses = active.filter((r) => outputSendsRace(o, r.id) && isRunning(viewOf(st, r.id), r, st, nowMs));
      if (misses.length && outputs.some((x) => x.enabled !== false)) {
        out.push({ tone: 'warn', id: 'out-off:' + o.id, title: `${str(o.name) || 'An output'} is switched off`,
          text: `${str(o.name) || 'An output'} is switched off, so it gets nothing of ${listText(misses.map((r) => r.name || '(no name)'))}. Turn it on (Outputs page) when it should get splits again: it then gets what it missed, except for runners who have finished.`,
          action: { label: 'Outputs', href: '#outputs/' + encodeURIComponent(o.id) } });
      }
      continue;
    }
    const s = outputStatus(st, o.id) || {};
    const name = str(o.name) || 'An output';
    const href = '#outputs/' + encodeURIComponent(o.id);
    const target = s.target || `${o.host}:${o.port}`;
    if (s.scriptOk === false) {
      out.push({ tone: 'bad', id: 'out-script:' + o.id, title: `${name}: script can't be loaded`, text: `${name}: the script can't be loaded${s.scriptError ? ` (${s.scriptError})` : ''}. Nothing is sent to ${name} until the script path is fixed. The splits it misses are sent by themselves once the script works.`, action: { label: 'Fix script', href } });
      continue;
    }
    if (s.state === 'error') {
      out.push({ tone: 'bad', id: 'out-error:' + o.id, title: `${name} has a problem`, text: `${name} has a problem${s.lastError ? `: ${s.lastError}` : ''}. Check its IP address and port.`, action: { label: 'Check output', href } });
    } else if (s.state === 'disconnected' || s.state === 'connecting') {
      const q = Number(s.queued) || 0;
      const since = opts.downSince?.get('out:' + o.id) ?? null;
      const l = outputLight(o, s, { since, running, now: nowMs });
      out.push({ tone: l.tone, id: 'out-down:' + o.id, since,
        title: [`${name} not connected`, l.down >= 60000 ? `down ${formatDuration(l.down)}` : '', q ? `${fmtInt(q)} waiting` : ''].filter(Boolean).join(' · '),
        text: `${name} isn't connected (${target}). Is ${name} running on that computer? Split Relay keeps trying${q ? ` and sends the ${plural(q, 'waiting split')} when it connects` : ''}.`, action: { label: 'Check output', href } });
    } else if (s.state === 'listening' && !s.clients) {
      out.push({ tone: 'info', title: `${name} is waiting for a program to connect`, text: `${name} is waiting for a program to connect to port ${o.port}.`, action: { label: 'Output', href } });
    } else if (behindText(s)) {
      out.push({ tone: 'warn', title: `${name} is ${behindText(s)}`, text: `${name} is ${behindText(s)}: the oldest has waited ${Math.round(Number(s.lagSec))} s. ${name} or the network is slow. The splits still go out in order as it catches up.`, action: { label: 'Check output', href } });
    } else if (s.lastError) {
      out.push({ tone: 'warn', title: `${name} reported a problem`, text: `${name} reported a problem: ${s.lastError}`, action: { label: 'Check output', href } });
    }
    // DESIGN 9.15 L6: the last guard before the wire. Should never happen; if it does, splits are missing on a board.
    const refused = Number(s.refused) || 0;
    if (refused > 0) out.push({ tone: 'bad', title: `${name} refused ${plural(refused, 'split packet')}`, text: refusedText(name, refused) + (s.refusedReason ? ` The last one: ${s.refusedReason}` : ''), action: { label: 'Check output', href } });
    // TrackScore shows one live race: with two races taking reads, every packet of the other race switches it
    // (event number) or lands in the wrong race (blank event number). Live results take every race, so no warning.
    if (!arr(o.races).length && active.length > 1 && isTrackScoreLike(o, s)) {
      const names = listText(active.map((r) => r.name || '(no name)'));
      const why = o.eventNumber === 'blank'
        ? `TrackScore puts every split into the race it is showing, so runners of the other ${active.length === 2 ? 'race show' : 'races show'} up in it.`
        : `Each split carries its race's event number, so TrackScore switches to that race and clears the race it was showing.`;
      out.push({
        tone: 'bad',
        title: `${name} gets every race: choose one`,
        text: `${name} is set to send all races, and ${active.length} races are taking reads (${names}). ${why} Choose the one race ${name} gets:`,
        picker: { outputId: o.id, outputName: name, options: active.map((r) => ({ id: r.id, name: r.name || '(no name)' })), selected: likelyLiveRace(st, active, nowMs) },
      });
    }
  }

  const badLines = arr(feed).filter((e) => e.status === 'bad-line' && nowMs - (toMs(e.at) ?? 0) < 5 * 60e3).length;
  if (badLines) {
    out.push({ tone: 'bad', title: `${plural(badLines, 'unreadable line')} from RR12`, text: `RR12 sent ${plural(badLines, 'line')} in the last 5 minutes that Split Relay couldn't read. Check that RR12's Export Data expression is the one on the Inputs page.`, action: { label: 'Show expression', href: '#settings/input' } });
  }

  // DESIGN 9.2: a contest whose race was deleted or stopped listing it. Its reads, and its new ones, are not used.
  const aside = arr(st.setAside).filter((a) => a && str(a.contest));
  for (const a of aside) {
    const owner = a.raceId ? configRace(st, a.raceId) : null;
    out.push({
      tone: 'warn',
      title: a.via === 'port' ? `Reads from port ${a.port} are not used` : a.via === 'event' ? `Reads of Event ${a.event} are not used` : `Reads of '${a.contest}' are not used`,
      text: a.via === 'port' ? `Reads from port ${a.port} are not used: ${a.reason}. Choose port ${a.port} on an Active race to use them.`
        : a.via === 'event' ? `Reads of Event ${a.event} are not used: ${a.reason}. Give an Active race Event ${a.event} to use them.`
          : `Reads of '${a.contest}' are not used: ${a.reason}. List the contest on an Active race to use them.`,
      // the race that stopped listing it is the likely place to put it back; a deleted race can be added again
      action: owner ? { label: `Edit ${owner.name || 'the race'}`, href: '#races/' + encodeURIComponent(owner.id) }
        : { label: 'Add a race for it', cmd: 'aside-race', value: a.contest, raceName: str(a.raceName), ...(keyedByPort(a) ? { via: a.via, port: a.port ?? null, event: a.event ?? null } : {}) },
    });
  }

  // DESIGN 9.2 R6: a race with reads that is not in the settings, and was not deleted (config.json was put back from
  // its backup, or edited). Its reads wait for it; red, because a race may be running without its splits.
  for (const m of arr(st.missingRaces).filter((x) => x && str(x.raceId))) {
    // the reads in no race that wait for it (State.noRace counts its own reads among them)
    const waiting = arr(st.noRace).filter((n) => n?.status === 'race-missing' && n.raceId === m.raceId).reduce((t, n) => t + (Number(n.count) || 0), 0);
    const del = { label: 'Delete it…', cmd: 'missing-delete', raceId: m.raceId, raceName: str(m.raceName), value: String(Number(m.count) || 0) };
    // V2: the race file keeps its settings, so it can be put back with one click (a file without them can't)
    const canRestore = m.restorable !== false && m.hasSettings !== false;
    out.push({
      tone: 'bad', title: `${str(m.raceName) || 'A race'} isn't in the settings`, text: missingRaceText(m, Math.max(0, waiting - (Number(m.count) || 0)), st.configRecovery),
      action: canRestore ? { label: 'Put it back', cmd: 'missing-restore', raceId: m.raceId, raceName: str(m.raceName) } : del,
      ...(canRestore ? { more: [del] } : {}),
    });
  }

  // the reads in no race now (State.noRace), counted as they are now; the contests read in the last hour. Reads routed
  // by their RR12 port or their event (LapTime lines, DESIGN 9.15 L3) have no contest to look up: they always count.
  const recent = new Set(arr(st.seen?.contests).filter((c) => c?.name && (toMs(c.lastAt) == null || nowMs - toMs(c.lastAt) < 60 * 60e3)).map((c) => norm(c.name)));
  const waiting = arr(st.noRace).filter((n) => n && Number(n.count) > 0
    && (keyedByPort(n) || (!n.blank && str(n.contest) && recent.has(norm(n.contest)))));
  // C1: reads of a contest that only races that are not Active list wait for them; one warning per race they wait for
  const byRace = new Map();
  for (const n of waiting.filter((x) => x.status === 'paused' && x.raceId)) {
    if (!byRace.has(n.raceId)) byRace.set(n.raceId, []);
    byRace.get(n.raceId).push(n);
  }
  for (const [id, ns] of byRace) {
    const r = configRace(st, id);
    const name = r?.name || ns[0].raceName || 'its race';
    const one = ns.length === 1 && Number(ns[0].count) === 1;
    out.push({
      tone: 'warn',
      title: `Reads wait for ${name} (not Active)`,
      text: `${listText(ns.map((n) => `${plural(Number(n.count), 'read')} ${readsLabel(n)}`))} ${one ? 'waits' : 'wait'} for ${name}, which is not Active, so ${one ? 'it is' : 'they are'} not used. Tick Active on ${name} to use ${one ? 'it' : 'them'}.`,
      action: { label: `Edit ${name}`, href: '#races/' + encodeURIComponent(id) },
      ...(r ? { more: [{ label: `Switch to ${name}…`, cmd: 'switch', raceId: id }] } : {}),
    });
  }
  // reads that came in on a port (or name an event) that no race takes
  const strays = waiting.filter((n) => n.status === 'no-race' && keyedByPort(n));
  if (strays.length) {
    out.push({ tone: 'warn', title: 'Reads that belong to no race', text: `${listText(strays.map((n) => `${plural(Number(n.count), 'read')} ${readsLabel(n)}`))} belong to no race, so they are not sent. On the Races page, choose that RR12 port on the race they belong to (and tick Active).`, action: { label: 'Races', href: '#races' } });
  }
  if (active.length && !active.some((r) => !arr(r.contests).length)) {
    // only reads that are in no race because no race takes their contest: a set-aside contest, one that waits for a
    // race, and the reads a race that is not Active keeps have their own words
    const loose = waiting.filter((n) => n.status === 'no-race' && !keyedByPort(n));
    if (loose.length) {
      const one = loose.length === 1;
      out.push({ tone: 'warn', title: `${one ? 'A contest belongs' : 'Contests belong'} to no race`, text: `${one ? 'Contest' : 'Contests'} ${listText(loose.map((c) => `${c.contest} (${plural(Number(c.count) || 0, 'read')})`))} ${one ? "doesn't" : "don't"} belong to any race, so ${one ? 'its' : 'their'} reads are not sent. Add ${one ? 'it' : 'them'} to an Active race if ${one ? 'it' : 'they'} should be.`, action: { label: 'Races', href: '#races' } });
    }
  }

  // DESIGN 9.15 L8 / 9.20 N1: a LapTime line is a bib and a time, nothing else: the names come from the people file.
  // Red once a race's splits went out without them (the boards show those runners without names now). The button
  // opens the file picker at once, and the file is saved on the pick.
  const gap = namesGap(st);
  const choose = { label: 'Choose names file…', cmd: 'choose-ppl' };
  const getNone = (outs) => `${listText(outs)} ${outs.length === 1 ? 'gets' : 'get'} no names`;
  if (str(cfg.names?.pplPath).trim() && st.names && (st.names.error || st.names.loaded === false)) {
    const bad = gap.missing && gap.tone === 'bad';
    out.push({ tone: bad ? 'bad' : 'warn', id: 'names-file', title: bad ? `${getNone(gap.outputs)}: the names file can't be read` : "The names file can't be read",
      text: `The FinishLynx names file can't be read${st.names.error ? ` (${st.names.error})` : ''}. ${gap.missing ? 'The split packets go without names until it can.' : "Names come from RR12 instead and may not match FinishLynx's spelling."}${bad ? sentWithoutNamesText(gap.sent) : ''}`,
      action: choose, more: [{ label: 'Names file settings', href: '#settings/names' }], ...(bad ? {} : { step: 'names' }) });
  } else if (gap.missing && gap.why === 'none') {
    out.push({ tone: gap.tone, id: 'names-file',
      title: gap.tone === 'bad' ? `${getNone(gap.outputs)}: choose the meet's names file (.ppl)` : "No names file: choose the meet's names file (.ppl)",
      text: NAMES_WARNING + sentWithoutNamesText(gap.sent),
      action: choose,
      // while the setup checklist shows, its step says this (an amber line only: a red one always shows)
      ...(gap.tone === 'warn' ? { step: 'names' } : {}) });
  }
  if (cfg.lif?.enabled && st.lif?.state === 'error') {
    out.push({ tone: 'bad', title: "Merged .lif files aren't being written", text: `Merged .lif files aren't being written${st.lif.error ? `: ${st.lif.error}` : ''}.`, action: { label: '.lif settings', href: '#settings/lif' } });
  }
  return out;
}

/** The contests a catch-all race has received reads from: the server's count, else what no other race lists. */
function catchAllContests(rv, cfg, st, nowMs) {
  // only real contests: the reads of a port or an event (LapTime lines) are not a contest to choose
  if (Array.isArray(rv?.contestsSeen)) return rv.contestsSeen.filter((c) => c && c.name && !keyedByPort(c));
  const claimed = new Set(arr(st?.config?.races).filter((r) => r.id !== cfg.id).flatMap((r) => arr(r.contests).map(norm)));
  return arr(st?.seen?.contests).filter((c) => c && c.name && !claimed.has(norm(c.name))
    && (toMs(c.lastAt) == null || nowMs - toMs(c.lastAt) < 60 * 60e3));
}

/**
 * DESIGN 9.24, the Needs attention row of a race with a split too fast to be real: "Bib 142: a split too fast to be
 * real", with the way to Review, where the row has Not a split, Stop sending this runner and It's right. Null without one.
 * @param {any} rv RaceView (review: its counts, with fast and fastBibs)
 * @param {string} id the race's id
 * @returns {Warning | null}
 */
export function tooFastWarning(rv, id) {
  const c = reviewCounts(rv);
  if (!c.fast) return null;
  const bibs = arr(c.fastBibs);
  const one = c.fast === 1 && bibs.length === 1;
  const who = one ? `Bib ${bibs[0]}` : `${fmtInt(c.fast)} runners`;
  const names = !one && bibs.length ? ` (bib${bibs.length === 1 ? '' : 's'} ${listText(bibs)}${c.fast > bibs.length ? ' and more' : ''})` : '';
  return {
    tone: 'warn', id: 'too-fast',
    title: `${who}: a split too fast to be real`,
    text: `${who}${names} ${one ? 'has' : 'have'} a split that came sooner after the split before than the leaders ran that stretch, from a runner who was not with them. It went out as it is. In Review, Splits that look wrong: Not a split takes it back, Stop sending this runner keeps the runner off the boards, It's right leaves it.`,
    action: { label: 'Open Review', href: '#review/' + encodeURIComponent(id) },
  };
}

/**
 * DESIGN 9.25, the Needs attention row of a race whose boards have a runner of another race: "Bib 213 ran in Boys 2A
 * today: not in this race?", with the way to Review, where the row has Not in this race and It's right. Null without one.
 * @param {any} rv RaceView (review: its counts, with strange, strangeBibs and strangeText)
 * @param {string} id the race's id
 * @returns {Warning | null}
 */
export function strangerWarning(rv, id) {
  const c = reviewCounts(rv);
  if (!c.strange) return null;
  const bibs = arr(c.strangeBibs);
  const one = c.strange === 1;
  const who = bibs.length ? `Bib${bibs.length === 1 ? '' : 's'} ${listText(bibs)}${c.strange > bibs.length ? ' and more' : ''}` : `${fmtInt(c.strange)} runners`;
  return {
    tone: 'warn', id: 'not-in-race',
    title: one && c.strangeText ? c.strangeText : `${fmtInt(c.strange)} runners may not be in this race`,
    text: `${who} ${one ? 'is' : 'are'} entered in another race, or ran one today, and ${one ? 'was' : 'were'} read in this one. ${one ? 'Its' : 'Their'} splits went out like any runner's. In Review, Not in this race takes them back and puts the other runners' places right; It's right leaves them.`,
    action: { label: 'Open Review', href: '#review/' + encodeURIComponent(id) },
  };
}

/**
 * DESIGN 9.25, the Needs attention row of a race whose start list is not used: it does not fit the runners being read,
 * or it is from an earlier meet (Split Relay's own sentence). Nobody is kept off the boards by it. Null otherwise.
 * @param {any} rv RaceView (startList: its warn)
 * @returns {Warning | null}
 */
export function startListWarning(rv) {
  const w = str(rv?.startList?.warn).trim();
  if (!w) return null;
  return { tone: 'warn', id: 'start-list', title: 'The start list is not used', text: `${w} Every runner is sent as without a start list.`, action: { label: 'Races', href: '#races' } };
}

/**
 * DESIGN 9.26, mats close together and the tag filter: the Needs attention row of a race in which reads that came long
 * after the runner's last one were merged into it by the tag filter (RaceView.lateMerged, Split Relay's own sentence):
 * a second mat a little further on is being read inside the tag filter by the fast runners, whose later passes then
 * land a split early. With the way to the tag filter. Null without it.
 * @param {any} rv RaceView (lateMerged: reads, runners, fromSec, toSec, tagWindowSec, text)
 * @returns {Warning | null}
 */
export function lateMergedWarning(rv) {
  const m = rv?.lateMerged;
  if (!m || typeof m !== 'object' || !(Number(m.reads) > 0)) return null;
  const span = Number(m.fromSec) === Number(m.toSec) ? `${fmtInt(m.fromSec)} s` : `${fmtInt(m.fromSec)} to ${fmtInt(m.toSec)} s`;
  const text = str(m.text).trim() || `${plural(Number(m.reads), 'read')} came ${span} after the runner's last one and ${Number(m.reads) === 1 ? 'was' : 'were'} merged into it by the tag filter (${str(m.tagWindowSec)} s). If two mats are that close on the course, set the tag filter below the fastest runner's time between them.`;
  return {
    tone: 'warn', id: 'late-merged',
    // (short: on the race's page the title is one line beside its button)
    title: `Tag filter merged reads ${span} apart`,
    text: `Two mats close together? ${text} A pass that is merged away is not counted, so that runner's later passes land a split early. Split Relay works every race out again from its reads when the tag filter changes; splits already sent for longer than a minute then wait for Resend.`,
    action: { label: 'Tag filter settings', href: '#settings/filter' },
  };
}

/**
 * Problems with one race, for its Live card and its editor.
 * @param {any} rv RaceView
 * @param {any} cfg the race's config
 * @param {any} st State
 * @param {number} nowMs
 * @param {any[]} feed newest first
 * @returns {Warning[]}
 */
export function raceWarnings(rv, cfg, st, nowMs, feed = []) {
  /** @type {Warning[]} */
  const out = [];
  if (!rv && !cfg) return out;
  const id = rv?.id || cfg?.id;
  const href = '#races/' + encodeURIComponent(id);
  const pending = waitingCount(rv);
  const gunSet = !!rv && Number.isFinite(rv.gunTicks);
  const gunText = gunSet ? rv.gunText || formatTod(rv.gunTicks) : '';
  const races = arr(st?.config?.races);

  // DESIGN 9.24: a split too fast to be real went out (Split Relay marks it as the read comes in; it holds nothing).
  // The race's first line: it is about what the boards show now
  const fast = tooFastWarning(rv, id);
  if (fast) out.push(fast);
  // DESIGN 9.25: a runner of another race is on this race's boards; the race's start list is not used
  const strange = strangerWarning(rv, id);
  if (strange) out.push(strange);
  const noList = startListWarning(rv);
  if (noList) out.push(noList);
  // DESIGN 9.26: reads that came long after the runner's last one were merged by the tag filter (two mats close together)
  const merged = lateMergedWarning(rv);
  if (merged) out.push(merged);

  if (rv && !gunSet) {
    out.push(pending > 0
      ? { tone: 'warn', title: `${plural(pending, 'read')} ${pending === 1 ? 'waits' : 'wait'} for the gun time`, text: `${fmtInt(pending)} ${pending === 1 ? 'read is' : 'reads are'} waiting for the gun time — set it.`, action: { label: 'Set gun time', href: href + '/gun' } }
      : { tone: 'info', title: 'Gun time not set yet', text: 'Gun time not set yet. Set it when the race starts; reads wait until then.', action: { label: 'Set gun time', href: href + '/gun' } });
  }

  if (gunSet) {
    // The server counts reads before the gun (§9.7); an older server only shows them as feed rows.
    const early = Number.isFinite(rv.beforeGun) ? rv.beforeGun
      : arr(feed).filter((e) => e.raceId === id && e.status === 'before-gun' && nowMs - (toMs(e.at) ?? 0) < 10 * 60e3).length;
    if (early > 0) {
      out.push({ tone: 'warn', title: `${plural(early, 'read')} before the gun time`, text: `${plural(early, 'read')} ${early === 1 ? 'is' : 'are'} before the gun time ${gunText} and ${early === 1 ? 'was' : 'were'} not sent. Is the gun time right? If you fix it, they count.`, action: { label: 'Check gun time', href: href + '/gun' } });
    }
    // Normal on a course that starts over the finish mats; said once, quietly, in case a real split is that early.
    const startArea = Number(rv.startArea) || 0;
    if (startArea > 0) {
      const secs = str(st?.config?.filter?.startIgnoreSec ?? 60);
      out.push({ tone: 'info', title: `${plural(startArea, 'read')} ignored in the start area`, text: `${plural(startArea, 'read')} in the first ${secs} s after the gun ${startArea === 1 ? 'was' : 'were'} ignored (start area: runners crossing a mat at the start). If one is a real split, lower "Ignore reads in the first … s" in Settings.`, action: { label: 'Tag filter settings', href: '#settings/filter' } });
    }
    // DESIGN 9.15 L4: passes after the last split are never sent (laps to go 0 is the finish). RaceView.extra counts
    // reads: the A and B mats of one pass are two.
    const extra = Number(rv.extra ?? rv.extraPasses) || 0;
    if (extra > 0 && cfg) {
      const n = arr(cfg.splits).length;
      out.push({ tone: 'warn', title: `${plural(extra, 'extra pass read')} ignored`, text: `${plural(extra, 'read')} came after a runner's last split (this race has ${plural(n, 'split')}), so ${extra === 1 ? 'it was' : 'they were'} ignored ("Extra pass"). If every runner gets them, check that the RR12 exporter sends the split mats only, not the finish. If the course has more split passes, raise the number of splits.`, action: { label: 'Number of splits', href: href + '/splits' } });
    }
  }

  if (gunDiffers(rv)) {
    const d = gunVsLynx(rv);
    // exact to the 0.1 ms FinishLynx prints, without trailing zeros: "1.2405 s", "2 s"
    const secs = (Math.abs(d) / TICKS_PER_SEC).toFixed(4).replace(/\.?0+$/, '');
    out.push({
      tone: 'bad',
      title: `Gun differs from the FinishLynx start by ${secs} s`,
      text: `Gun ${gunText} differs from the FinishLynx start ${formatTod(rv.lynxStart, 4)} by ${secs} s, so every split is ${d > 0 ? 'short' : 'long'} by that much and won't match FinishLynx's times.`,
      action: { label: 'Check the gun time', cmd: 'lynx-gun', raceId: id },
    });
  }

  if (cfg) {
    const twins = sameEventRaces(cfg, races, id);
    if (twins.length) {
      out.push({ tone: 'bad', title: `Another race also uses ${eventLabel(cfg)}`, text: `${listText([cfg.name || 'This race', ...twins.map((r) => r.name || '(no name)')])} all use ${eventLabel(cfg)}: TrackScore and the .lif files can't tell them apart. Give each race the event, round and heat FinishLynx has for it.`, action: { label: 'Fix event number', href } });
    }
  }

  const lynxName = str(rv?.lynxName).trim();
  if (cfg && lynxName && lynxName !== str(cfg.name).trim()) {
    out.push({
      tone: 'warn',
      title: "Name differs from FinishLynx's event name",
      text: `FinishLynx calls this event “${lynxName}”, but the race here is “${str(cfg.name).trim()}”. Type the name exactly as FinishLynx's event name: TrackScore treats a merged file with a new name as a new race.`,
      action: { label: `Use “${lynxName}”`, cmd: 'lynx-name', raceId: id, value: lynxName },
    });
  }

  // (a race with an RR12 port takes that port's reads, not every contest: DESIGN 9.15 L3)
  if (cfg && cfg.active !== false && !arr(cfg.contests).length && portNum(cfg.inputPort) == null) {
    const got = catchAllContests(rv, cfg, st, nowMs);
    if (got.length > 1) {
      out.push({ tone: 'warn', title: 'Takes every contest: choose its contests', text: `This race takes every contest and has received reads from ${listText(got.map((c) => `${c.name} (${plural(c.count || 0, 'read')})`), 5)}. Choose its contests, so each contest's runners are placed in their own race.`, action: { label: 'Choose contests', href } });
    }
  }

  const unm = arr(rv?.unmapped).filter((u) => u && u.name);
  if (unm.length) {
    const one = unm.length === 1;
    out.push({ tone: 'warn', title: `${plural(unm.length, 'timing point')} not mapped to a split`, text: `${one ? "1 timing point name isn't" : `${unm.length} timing point names aren't`} mapped to a split: ${listText(unm.map((u) => `${u.name}${u.count ? ` (${plural(u.count, 'read')})` : ''}`), 6)}. Add ${one ? 'it' : 'them'} to a split if ${one ? 'it is a split' : 'they are splits'}; the earlier reads count too.`, action: { label: 'Map timing points', href: href + '/splits' } });
  }

  const splits = arr(cfg?.splits);
  // DESIGN 9.17 P1: a split paused and forgotten would leave its splits out of TrackScore and the .lif file for good
  const paused = splits.filter((s) => s && s.id && !splitSending(s));
  if (cfg && paused.length) {
    const held = (s) => splitHeld(arr(rv?.splits).find((x) => x && x.id === s.id));
    const total = paused.reduce((n, s) => n + held(s), 0);
    const names = listText(paused.map((s) => s.name || 'a split'));
    // revision 10: while Play reads FinishLynx's folder first, the button says so and can't be pressed twice
    const playing = (s) => arr(rv?.splits).some((x) => x && x.id === s.id && x.playing === true);
    const plays = paused.map((s) => (playing(s)
      ? { label: `Playing ${s.name || 'split'}…`, cmd: 'split-play', raceId: id, value: s.id, disabled: true }
      : { label: `▶ Play ${s.name || 'split'}`, cmd: 'split-play', raceId: id, value: s.id }));
    out.push({
      tone: total ? 'warn' : 'info',
      title: `${names} paused${total ? ` · ${fmtInt(total)} held` : ''}`,
      text: `${names} ${paused.length === 1 ? 'is' : 'are'} paused${total ? `: ${plural(total, 'split')} ${total === 1 ? 'is' : 'are'} held, not sent and not in the .lif file` : ''}. Press Play when ${paused.length === 1 ? 'it' : 'they'} can go out.`,
      action: plays[0],
      ...(plays.length > 1 ? { more: plays.slice(1) } : {}),
    });
  }
  if (cfg && !splits.length) {
    out.push({ tone: 'warn', title: 'No splits set', text: 'This race has no splits yet, so nothing can be sent. Set its number of splits.', action: { label: 'Set splits', href: href + '/splits' } });
  }
  // A race fed LapTime lines counts passes and has no timing points at all (DESIGN 9.15 L4); only a race that maps
  // timing point names to its splits has a split that is missing one.
  const mapsNames = splits.some((s) => arr(s.sources).length) || arr(cfg?.finishSources).length > 0;
  const empty = mapsNames ? splits.filter((s) => !arr(s.sources).length) : [];
  if (empty.length) {
    const one = empty.length === 1;
    out.push({ tone: 'warn', title: `${one ? 'A split has' : 'Splits have'} no timing point`, text: `${one ? 'Split' : 'Splits'} ${listText(empty.map((s) => s.name || '(no name)'))} ${one ? 'has' : 'have'} no timing point yet.`, action: { label: 'Add timing points', href: href + '/splits' } });
  }

  // DESIGN 9.15 L2/L3: the port this race reads from
  const port = portNum(cfg?.inputPort);
  if (cfg && port != null) {
    const ports = inputPorts(st);
    const ins = inputsOf(st);
    if (!ports.includes(port)) {
      out.push({ tone: cfg.active !== false ? 'bad' : 'warn', title: `Port ${port} isn't an RR12 input port`, text: `This race reads from RR12 port ${port}, but Split Relay doesn't listen on that port (it listens on ${portsText(ports)}). Choose ${ports.length === 1 ? `port ${ports[0]}` : 'one of those'} on the race, or add port ${port} on the Inputs page.`, action: { label: 'Choose the port', href } });
    } else if (cfg.active !== false && ins.length > 1) {
      const mine = ins.find((i) => Number(i.port) === port);
      if (mine && !arr(mine.connections).length && ins.some((i) => arr(i.connections).length)) {
        // `port`: the Dashboard says it once, on the port's own line (rrNotConnected), not again per race
        out.push({ tone: gunGone(rv, st, nowMs) ? 'bad' : isRunning(rv, cfg, st, nowMs) ? 'warn' : 'info', port, title: `RR12 not connected on port ${port}`, text: `Nothing is connected to port ${port}, which this race reads from. In RR12, press play on the exporter that sends to ${rrTarget(st, port)}.`, action: { label: 'Exporter settings', href: '#settings/exporter' } });
      }
    }
  }

  // a race fed by its own port gets reads whatever the other races' contests are
  if (cfg && cfg.active !== false && !arr(cfg.contests).length && port == null) {
    const earlier = races.slice(0, Math.max(0, races.findIndex((r) => r.id === id)))
      .find((r) => r.active !== false && !arr(r.contests).length && portNum(r.inputPort) == null);
    if (earlier) out.push({ tone: 'warn', title: 'Another race takes every contest', text: `“${earlier.name}” already takes reads from every contest, so this race gets none. Choose this race's contests.`, action: { label: 'Choose contests', href } });
  }

  const outs = arr(st?.config?.outputs).filter((o) => o.enabled !== false);
  if (cfg?.active !== false && outs.length && !outs.some((o) => outputSendsRace(o, id))) {
    out.push({ tone: 'warn', title: 'No output sends this race', text: "No output sends this race. Tick it in an output's races on the Outputs page.", action: { label: 'Outputs', href: '#outputs' } });
  } else if (cfg && isRunning(rv, cfg, st, nowMs) && !allFinished(rv)) {
    // TrackScore was given one race; when the next race starts, nothing else reminds the timer to move it over. (Not
    // for a race whose runners have all finished: there is nothing left to show live.) A decision, not a fault: the
    // Dashboard shows one line per output for all such races, with the race it shows and "Keep".
    const ts = outs.filter((o) => isTrackScoreLike(o, outputStatus(st, o.id)));
    if (ts.length && !ts.some((o) => outputSendsRace(o, id))) {
      const o = ts[0];
      const gets = arr(o.races).map((rid) => configRace(st, rid)?.name).filter(Boolean);
      out.push({
        tone: 'warn',
        outputId: o.id,
        title: `${o.name || 'TrackScore'} isn't getting this race`,
        text: `${o.name || 'TrackScore'} isn't getting this race${gets.length ? ` (it gets ${listText(gets)})` : ''}. It shows one race at a time: switching it clears the race it shows now.`,
        action: { label: `${o.name || 'TrackScore'} gets this race`, cmd: 'output-race', outputId: o.id, raceId: id },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Form drafts and validation                                                                                   */

/** RR12 column types (src/input.js COLUMN_TYPES) with the words and RR12 fields the operator recognises. */
export const COLUMN_INFO = {
  location: { label: 'Timing point name', rr: '[RD_TimingPoint]', sample: '1K-A' },
  bib: { label: 'Bib', rr: '[RD_IDBib]', sample: '254' },
  time: { label: 'Time of day', rr: 'format([RD_Time];"hh:mm:ss.kkk")', sample: '10:05:12.345' },
  contest: { label: 'Contest', rr: '[Contest.Name]', sample: 'Girls Varsity 5K' },
  first: { label: 'First name', rr: '[Firstname]', sample: 'Ann' },
  last: { label: 'Last name', rr: '[Lastname]', sample: 'Sample' },
  team: { label: 'Team / club', rr: '[Club]', sample: 'Hilltop' },
  gender: { label: 'Gender', rr: '[Gender]', sample: 'F' },
  ignore: { label: 'Ignore (always blank)', rr: '""', sample: '' },
};
export const COLUMN_TYPES = Object.keys(COLUMN_INFO);

/** One line as RR12 will send it with these settings, so the operator can compare with RR12's own preview. */
export function sampleLine(input) {
  const cols = arr(input?.columns).map((c) => COLUMN_INFO[c]?.sample ?? '');
  const tag = str(input?.tag);
  const delim = str(input?.delimiter) || '|';
  return (tag ? [tag, ...cols] : cols).join(delim);
}

/** @returns {string[]} plain-English problems; empty when the columns work */
export function validateColumns(cols) {
  const errs = [];
  const count = new Map();
  for (const c of arr(cols)) if (c !== 'ignore') count.set(c, (count.get(c) || 0) + 1);
  for (const need of ['location', 'bib', 'time']) {
    if (!count.has(need)) errs.push(`Add a “${COLUMN_INFO[need].label}” column. Split Relay can't work without it.`);
  }
  for (const [c, n] of count) if (n > 1) errs.push(`“${COLUMN_INFO[c]?.label || c}” is in the list ${n} times. Keep one.`);
  return errs;
}

/** @returns {string | null} */
export function validatePort(text, what) {
  const s = str(text).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || n < 1 || n > 65535) return `${what} must be a whole number from 1 to 65535.`;
  return null;
}

/** @returns {string | null} */
export function validateSeconds(text, what, max) {
  const s = str(text).trim().replace(',', '.');
  const n = Number(s);
  if (!s || !Number.isFinite(n) || n < 0) return `${what} must be a number of seconds, 0 or more.`;
  if (n > max) return `${what} can be at most ${max} seconds.`;
  return null;
}

/**
 * The race form's words on finish timing points (s2 P1): what a finish read does, and that the start area doesn't count.
 * @param {any} filter config.filter
 */
export function finishHelp(filter) {
  const sec = Number(filter?.startIgnoreSec ?? 60);
  return 'A read here marks the runner as finished: later reads of that runner are ignored, and no more splits are sent ' +
    'for them, so TrackScore keeps their finish place (their splits are still in the merged .lif files). Finish reads are ' +
    'never sent; FinishLynx sends finishes.' +
    (sec > 0 ? ` A read in the first ${sec} s after the gun (runners leaving the start over the finish mats) doesn't count.` : '');
}

/**
 * The contest picker's note on a contest (DESIGN 9.2): its reads, and how many are not used now and why, counted as
 * they are now (State.noRace), not as they ever were: "12 reads · in Open 5K", "3 set aside, not used",
 * "4 waiting for JV 4K (not Active)".
 * @param {{ name: string, count?: number }} c a contest seen on the stream (State.seen.contests)
 * @param {any} st State
 * @param {any} [owner] the other race that lists it, if any
 * @returns {string}
 */
export function contestNote(c, st, owner = null) {
  const k = norm(c?.name);
  const now = arr(st?.noRace).filter((n) => n && !n.blank && norm(n.contest) === k && Number(n.count) > 0);
  const why = now.map((n) => {
    const count = Number(n.count);
    if (n.status === 'set-aside') return `${count} set aside, not used`;
    if (n.status === 'paused') return `${count} waiting for ${configRace(st, n.raceId)?.name || str(n.raceName) || 'a race'} (not Active)`;
    if (n.status === 'race-missing') return `${count} waiting for ${str(n.raceName) || 'a race'} (not in the settings)`;
    return `${count} in no race`;
  });
  const parts = why.length ? why : [plural(Number(c?.count) || 0, 'read')];
  // the race that lists it, unless the reads already say they wait for it
  if (owner && !now.some((n) => n.status === 'paused' && n.raceId === owner.id)) parts.push(`in ${str(owner.name) || '(no name)'}`);
  return parts.join(' · ');
}

/**
 * A place in a RoutePlan (POST /api/races/preview) in words: "this race", "Open 5K", "set aside", "no race"; for reads
 * that wait in no race for a race (not Active, or missing from the settings), the race they wait for.
 * @param {any} p { raceId, raceName, active } | { raceId: null, status, raceName?, waitsFor? }
 * @param {string} raceId the race being saved or deleted
 */
function placeName(p, raceId) {
  if (!p) return 'no race';
  if (p.raceId != null) return p.raceId === raceId ? 'this race' : str(p.raceName) || '(no name)';
  if (p.status === 'set-aside') return 'set aside';
  if (p.status === 'paused' || p.status === 'race-missing') return p.waitsFor && p.waitsFor === raceId ? 'this race' : str(p.raceName) || 'their race';
  return 'no race';
}

/** Where reads in no race were, in words: "set aside", "waiting for JV 4K", "in no race". */
function noRaceFrom(p, raceId) {
  if (p?.status === 'set-aside') return 'set aside';
  if (p?.status === 'paused' || p?.status === 'race-missing') return `waiting for ${placeName(p, raceId)}`;
  return 'in no race';
}

/** Why reads wait in no race, in words, after "wait for <race>". @param {any} p @param {number} [n] how many */
function waitWhy(p, n = 2) {
  if (p?.status === 'race-missing') return ", which isn't in the settings";
  return `, which is not Active: ${n === 1 ? 'it is' : 'they are'} used when you tick Active`;
}

/**
 * What saving or deleting a race does to the reads received so far, in plain English, one line per change (DESIGN
 * 9.2). The server works the plan out with the same rules a saved change runs, so the lines say exactly what will
 * happen. Empty when no read is affected.
 * @param {any} plan RoutePlan from POST /api/races/preview
 * @param {string} raceId the race being saved or deleted: it is "this race"
 * @returns {string[]}
 */
export function planLines(plan, raceId) {
  const lines = [];
  // a key may be a contest, or (LapTime lines, DESIGN 9.15 L3) the RR12 port or the event the reads came with
  const reads = (n, k) => `${plural(n, 'read')} ${readsLabel(k)}`;
  const be = (n, one, many) => (n === 1 ? one : many);
  for (const d of arr(plan?.deleted)) {
    const whose = d.raceId === raceId ? 'Its' : `${str(d.raceName) || '(no name)'}'s`;
    lines.push(`${whose} ${plural(d.count, 'read')} ${be(d.count, 'is', 'are')} no longer used.`);
  }
  for (const a of arr(plan?.setAside)) {
    if (a.deleted) lines.push(`New reads ${readsLabel(a)} won't be used either until ${useAgainText(a)}.`);
  }
  const movedTo = new Set();
  for (const m of arr(plan?.moves)) {
    const n = Number(m.count) || 0;
    const what = reads(n, m);
    const from = m.from || {};
    const to = m.to || {};
    const leave = from.raceId != null ? ` ${be(n, 'leaves', 'leave')} ${placeName(from, raceId)} and` : '';
    if (to.raceId != null) {
      movedTo.add(`${m.blank ? '' : norm(m.contest)}|${to.raceId}`);
      const paused = to.active === false ? ` (not sent while ${placeName(to, raceId)} is not Active)` : '';
      if (from.raceId == null && (from.status === 'paused' || from.status === 'race-missing') && from.waitsFor && from.waitsFor === to.raceId && to.active !== false) {
        // the race they waited for is Active now ("Switch to", or Active ticked): they are used where they waited
        lines.push(`${what} that ${be(n, 'was', 'were')} waiting for ${placeName(to, raceId)} ${be(n, 'is', 'are')} now used in it.`);
      } else if (from.raceId == null) {
        lines.push(`${what} that ${be(n, 'was', 'were')} ${noRaceFrom(from, raceId)} ${be(n, 'goes', 'go')} to ${placeName(to, raceId)}${paused}.`);
      } else lines.push(`${what} ${be(n, 'moves', 'move')} from ${placeName(from, raceId)} to ${placeName(to, raceId)}${paused}.`);
    } else if (to.status === 'set-aside') {
      lines.push(`${what}${from.raceId != null ? ` in ${placeName(from, raceId)}` : ''} ${be(n, 'is', 'are')} set aside (not used).`);
    } else if (to.status === 'paused' || to.status === 'race-missing') {
      // C1 / R6: they wait in no race for the race that lists their contest (not Active) or is missing
      const was = from.raceId == null && from.status !== 'no-race' ? ` that ${be(n, 'was', 'were')} ${noRaceFrom(from, raceId)}` : '';
      lines.push(`${what}${was}${leave} ${be(n, 'waits', 'wait')} for ${placeName(to, raceId)}${waitWhy(to, n)}.`);
    } else {
      lines.push(`${what}${leave} ${be(n, 'has', 'have')} no race (not used).`);
    }
  }
  for (const a of arr(plan?.setAside)) {
    if (!a.deleted) lines.push(`New reads ${readsLabel(a)} are set aside too, until ${useAgainText(a)}. A race that takes every contest does not take them.`);
  }
  for (const k of arr(plan?.kept)) {
    lines.push(`${str(k.raceName) || '(no name)'} is not Active, so it keeps its ${reads(Number(k.count) || 0, k)}.`);
  }
  for (const r of arr(plan?.newReads)) {
    const to = r.to || {};
    // a contest nobody has read yet changes nothing that runs; a set-aside one is said above; moved reads say it too
    if (!r.reads || to.status === 'set-aside' || movedTo.has(`${r.blank ? '' : norm(r.contest)}|${to.raceId}`)) continue;
    const w = `New reads ${readsLabel(r)}`;
    if (to.status === 'paused' || to.status === 'race-missing') lines.push(`${w} wait for ${placeName(to, raceId)}${waitWhy(to)}.`);
    // (new reads never go into a race that is not Active: they wait for it, above)
    else if (to.raceId == null) lines.push(`${w} will have no race (not used).`);
    else lines.push(`${w} go to ${placeName(to, raceId)}.`);
  }
  return lines;
}

/**
 * The Dashboard's red warning for a missing race (DESIGN 9.2 R6): a race with reads that is not in the settings and was
 * not deleted, because config.json was put back from its backup or edited. Its reads wait for it; how to get it back.
 * @param {any} m State.missingRaces entry { raceId, raceName, count, contests, file }
 * @param {number} [others] reads of its contests that came since and wait for it too
 * @returns {string}
 */
export function missingRaceText(m, others = 0, recovery = null) {
  const name = str(m?.raceName) ? `Race '${m.raceName}'` : `A race (id ${str(m?.raceId)})`;
  const n = Number(m?.count) || 0;
  const file = str(m?.file) ? `data\\${m.file}` : `data\\races\\${str(m?.raceId) || '<its id>'}.json`;
  const more = others > 0 ? ` ${plural(others, 'other read')} of its contests ${others === 1 ? 'waits' : 'wait'} for it too.` : '';
  // V2: the race file keeps the race's settings, so "Put it back" restores it in place; config.json.bak is what a
  // start that fell back already uses, so it is no help here, but a damaged config.json is kept beside it
  // (State.configRecovery names the file when this start fell back)
  const brokenFile = str(recovery?.brokenFile).split(/[\\/]/).pop();
  const broken = recovery?.fellBack && brokenFile
    ? `config.json was damaged when Split Relay started: it is kept as data\\${brokenFile}, and may have other changes made since the last start.`
    : 'If config.json was damaged, Split Relay kept it as data\\config.broken-….json: it may have other changes made since the last start.';
  const how = m?.restorable === false || m?.hasSettings === false
    ? `To get it back, stop Split Relay and put the race back into data\\config.json (${file} has no settings to restore it from). ${broken}`
    : `Its settings are kept in ${file}: press “Put it back” to add it again. ${broken}`;
  return `${name} isn't in the settings (config.json was restored or edited), so its ${plural(n, 'read')} ${n === 1 ? 'is' : 'are'} not used.${more} ${how} Its reads come back with it.`;
}

/**
 * The dialog before "Put it back" (V2, POST /api/races/:id/restore): the race comes back with the settings in its race
 * file, and so do its reads.
 * @param {any} m State.missingRaces entry
 * @param {any} st State
 * @returns {string[]}
 */
export function restoreMissingText(m, st) {
  const name = str(m?.raceName) || 'The race';
  const n = Number(m?.count) || 0;
  const lines = [`${name} is added back to the settings as it was saved in data\\${str(m?.file) || `races\\${str(m?.raceId)}.json`}, and its ${plural(n, 'read')} ${n === 1 ? 'is' : 'are'} used again. Each output gets only the splits it is missing.`];
  // one Active race per port (V1): a race that would take the reads of a running one comes back not Active
  const port = portNum(m?.inputPort ?? m?.race?.inputPort);
  const other = port != null ? arr(st?.config?.races).find((r) => r.active !== false && portNum(r.inputPort) === port) : null;
  if (other) lines.push(`${other.name || 'Another race'} is Active on port ${port}, so ${name} comes back not Active. Switch to it when it runs.`);
  else lines.push('If it would take the reads of a race that is Active now (the same RR12 port or contest), it comes back not Active, so the running race keeps its reads.');
  return lines;
}

/**
 * The dialog before a missing race (R6) is deleted: its reads are then out of use for good, as with any delete.
 * @param {any} m State.missingRaces entry
 * @param {any} plan RoutePlan of the delete, or null
 * @returns {string[]}
 */
export function deleteMissingText(m, plan) {
  const lines = [`Only do this if you don't want ${str(m?.raceName) || 'the race'} back.`];
  const said = plan ? planLines(plan, str(m?.raceId)) : [];
  lines.push(...(said.length ? said : [`Its ${plural(Number(m?.count) || 0, 'read')} ${Number(m?.count) === 1 ? 'is' : 'are'} no longer used.`]));
  lines.push('This can\'t be undone: its reads stay unused even if the race comes back.');
  return lines;
}

/**
 * The delete dialog (DESIGN 9.2 R2): deleting takes the race's reads out of use for good, and what happens to new
 * reads of its contests.
 * @param {any} cfg the race's config
 * @param {any} rv its RaceView
 * @param {any} plan RoutePlan of the delete, or null when Split Relay could not work it out
 * @returns {string[]}
 */
export function deleteRaceText(cfg, rv, plan) {
  const lines = [`The race, its splits and its ${plural(crossingCount(rv), 'crossing')} are removed from Split Relay.`];
  if (!plan) {
    lines.push("Its reads are no longer used. New reads of its contests won't be used either until you list them on an Active race.");
  } else {
    const said = planLines(plan, cfg?.id);
    lines.push(...(said.length ? said : ['It has no reads, so nothing else changes.']));
  }
  lines.push('This can\'t be undone: its reads stay unused even if you add the race again. To stop a race but keep its reads, untick Active instead.');
  return lines;
}

/**
 * The Clear race data dialog (DESIGN 9.2 R3): the reads the race holds now go out of use for good.
 * @param {any} rv the race's RaceView
 * @returns {string[]}
 */
export function clearRaceText(rv) {
  const c = reviewCounts(rv);
  return [
    `Split Relay forgets this race's ${plural(crossingCount(rv), 'crossing')}, ${plural(waitingCount(rv), 'read')} waiting for the gun, and who has finished. Use this after a false start or a test.`,
    'The reads this race holds now are no longer used. To rebuild the race, press Replay on the exporter in RR12 afterwards: the reads count again (reads from before the gun stay out). Nothing already sent is taken back from TrackScore. The race settings, gun time and splits are kept.',
    // DESIGN 9.23 F10: the operator's Review changes to passes stay (they apply again to the same reads); made-up times go
    ...(c.pinned || c.madeUp ? [`${c.pinned ? `Your Review changes to ${plural(c.pinned, "runner's passes", "runners' passes")} (Move, Not a split, finish) stay: they apply again when RR12 replays the same reads.` : ''}${c.pinned && c.madeUp ? ' ' : ''}${c.madeUp ? `The ${plural(c.madeUp, 'made-up and typed time')} ${c.madeUp === 1 ? 'is' : 'are'} forgotten: fill ${c.madeUp === 1 ? 'it' : 'them'} in again in Review after the Replay.` : ''}`] : []),
  ];
}

/**
 * The dialog before a race is saved, new or changed, when reads would move, be set aside or be kept elsewhere, or new
 * reads of a contest that is coming in would go somewhere else (DESIGN 9.2). Null when nothing that runs changes.
 * @param {any} plan RoutePlan from POST /api/races/preview
 * @param {string} name the race's name as typed
 * @param {boolean} isNew
 * @returns {{ title: string, body: string[] } | null}
 */
export function raceSaveText(plan, name, isNew) {
  const lines = planLines(plan, plan?.raceId);
  if (!lines.length) return null;
  const moves = arr(plan?.moves).length > 0;
  return {
    title: isNew ? `Add ${str(name) || 'this race'}?` : `Save ${str(name) || 'this race'}?`,
    body: [...lines, ...(moves ? ['Places in the races involved are worked out again from these reads.'] : [])],
  };
}

/** A race form's draft as the editor holds it; gun is left out because it has its own endpoint. */
export function raceToDraft(r) {
  return {
    name: str(r?.name),
    eventNumber: str(r?.eventNumber),
    round: str(r?.round),
    heat: str(r?.heat),
    distance: str(r?.distance),
    active: r?.active !== false,
    // the RR12 port this race reads from (DESIGN 9.15 L3); '' = none: it takes only reads that name its contests
    inputPort: portNum(r?.inputPort) == null ? '' : String(portNum(r.inputPort)),
    contests: arr(r?.contests).map(str),
    // (9.26: collectOnly, the split is counted but not sent: part of the form, saved with it, unlike the Pause)
    splits: arr(r?.splits).map((s) => ({ id: s.id, name: str(s.name), sources: arr(s.sources).map(str), earliest: str(s.earliest), collectOnly: notSent(s) })),
    finishSources: arr(r?.finishSources).map(str),
  };
}

/**
 * The Partial<Race> body for POST/PUT: trimmed, and new splits without an id so the server makes one.
 * A split's pause (DESIGN 9.17 P1, `sending`) is not part of the form: it is switched at once by its own button. So the
 * draft never carries it (pausing a split while the form is open must not make the form "changed elsewhere"), and a
 * save sends the pause as the race has it NOW, so saving the form never plays a paused split by accident.
 * @param {any} d the draft
 * @param {any} [saved] the race as Split Relay has it now (config), for the splits' pause
 */
export function raceBody(d, saved = null) {
  const t = (v) => str(v).trim();
  const paused = new Set(arr(saved?.splits).filter((s) => s && s.id && !splitSending(s)).map((s) => s.id));
  const quiet = new Set(arr(saved?.splits).filter((s) => s && s.id && notSent(s)).map((s) => s.id));
  return {
    name: t(d.name),
    eventNumber: t(d.eventNumber),
    round: t(d.round),
    heat: t(d.heat),
    distance: t(d.distance),
    active: !!d.active,
    inputPort: portNum(t(d.inputPort)),
    contests: arr(d.contests).map(t).filter(Boolean),
    splits: arr(d.splits).map((s) => {
      const o = { name: t(s.name), sources: arr(s.sources).map(t).filter(Boolean), earliest: t(s.earliest) };
      if (s.id) o.id = s.id;
      if (s.id && paused.has(s.id) && !notSent(s)) o.sending = false;
      // 9.26: "Not sent" is part of the form. Said when it is on, and as false for a split that is saved as not sent and
      // is sent again (a split sent back without it keeps what it was: src/config.js raceFromBody)
      if (notSent(s)) o.collectOnly = true;
      else if (s.id && quiet.has(s.id)) o.collectOnly = false;
      return o;
    }),
    finishSources: arr(d.finishSources).map(t).filter(Boolean),
  };
}

/**
 * @param {any} d the draft
 * @param {any[]} [races] the config races, to refuse an event, round and heat another race already uses
 * @param {string} [id] the race being edited
 * @returns {string[]}
 */
export function validateRaceDraft(d, races = [], id = '') {
  const errs = [];
  if (!str(d.name).trim()) errs.push('Give the race a name.');
  const twins = sameEventRaces(d, races, id);
  if (twins.length) {
    errs.push(`${listText([str(d.name).trim() || 'This race', ...twins.map((r) => r.name || '(no name)')])} would all use ${eventLabel(d)}: TrackScore and the .lif files can't tell them apart. Type the event, round and heat FinishLynx has for this race.`);
  }
  // DESIGN 9.15 L3: a read with only a bib can't be shared between two Active races on one port
  const clash = portConflict(d, races, id);
  if (clash) errs.push(portConflictText(portNum(d.inputPort), clash));
  // TrackScore and Karmarush need the number of splits to put each one in its column (laps to go)
  if (!arr(d.splits).length) errs.push(`Set the number of splits (1 to ${MAX_SPLITS}): the split passes a runner makes before the finish.`);
  if (arr(d.splits).length > MAX_SPLITS) errs.push(`A race can have at most ${MAX_SPLITS} splits.`);
  // 9.26: a race needs at least one split that is sent
  if (arr(d.splits).length && !sentOnly(d.splits).length) errs.push(allNotSentText(d.name));
  const names = new Map();
  let prev = null;
  arr(d.splits).forEach((s, i) => {
    const n = norm(s.name);
    if (!n) errs.push(`Split ${i + 1} needs a name (for example 1K).`);
    else if (names.has(n)) errs.push(`Two splits are called “${str(s.name).trim()}”. Give each split its own name.`);
    else names.set(n, i);
    // the earliest race time a pass can be this split (L4): minutes:seconds, later than the split before
    const e = str(s.earliest).trim();
    if (!e) return;
    const t = parseRaceText(e);
    const what = str(s.name).trim() || `Split ${i + 1}`;
    // (the server's words, so the form and a refused save say the same)
    if (t == null) errs.push(`The earliest time of ${what}, "${e}", is not a race time. Type it like 8:00 (minutes:seconds), or leave it empty.`);
    else if (prev && t <= prev.t) errs.push(`The earliest time of ${what} (${e}) is ${t === prev.t ? 'the same as' : 'before'} the earliest time of ${prev.what} (${prev.e}). Earliest times must go up in course order.`);
    else prev = { t, e, what };
  });
  const used = new Map();
  const claim = (src, where) => {
    const n = norm(src);
    if (!n) return;
    if (used.has(n) && used.get(n) !== where) errs.push(`Timing point “${str(src).trim()}” is used by ${used.get(n)} and ${where}. A timing point can belong to one split only.`);
    else used.set(n, where);
  };
  arr(d.splits).forEach((s, i) => arr(s.sources).forEach((src) => claim(src, `split ${i + 1} (${str(s.name).trim() || 'no name'})`)));
  arr(d.finishSources).forEach((src) => claim(src, 'the finish'));
  return errs;
}

/**
 * The draft for "Duplicate race": same splits, timing points, round, heat and distance, but no contests and no
 * event number. FinishLynx gives every race its own event, so a copied number would make two races TrackScore and
 * the .lif files can't tell apart; an empty one makes the operator type the right one.
 */
export function duplicateDraft(cfg, races = []) {
  const draft = raceToDraft(cfg);
  draft.name = `${draft.name} (copy)`;
  draft.eventNumber = '';
  draft.contests = [];
  draft.splits = draft.splits.map((s) => ({ name: s.name, sources: s.sources.slice(), earliest: s.earliest }));
  // the copy is usually the next race on the same course and port: it can't be Active beside the original (one
  // Active race per port), so it starts switched off and is switched to when it runs
  if (draft.active && portConflict(draft, races)) draft.active = false;
  return draft;
}

/**
 * The toast after Duplicate race: what to type next, and why the copy is not Active when it isn't, said only when
 * true: the original is not Active itself (the copy is like it), or a race is Active on the copy's RR12 port.
 * @param {any} cfg the original race
 * @param {any} draft duplicateDraft(cfg, races)
 * @param {any[]} races config races
 */
export function duplicateToast(cfg, draft, races = []) {
  const head = 'Copied. Type the event number FinishLynx has for this race, then save it.';
  if (draft?.active !== false) return head;
  if (cfg?.active === false) return `${head} It starts not Active, like the original: switch to it when it runs.`;
  const other = portConflict({ ...draft, active: true }, races);
  const port = portNum(draft?.inputPort);
  if (!other) return `${head} It starts not Active: switch to it when it runs.`;
  const who = other.id === cfg?.id ? 'the original is' : `${str(other.name) || 'another race'} is`;
  return `${head} It starts not Active, because ${who} Active on the same RR12 port (${port}): switch to it when it runs.`;
}

/**
 * Saving the RR12 input with a new port while RR12 is connected cuts RR12 off: it keeps retrying the old port.
 * (One port; inputPortsDropped is the same check for the list of ports.)
 * @returns {{ from: number, to: number, connections: number } | null} what to confirm, or null
 */
export function inputPortChange(st, newPort) {
  const from = Number(st?.input?.port ?? st?.config?.input?.port);
  const to = Number(newPort);
  const connections = arr(st?.input?.connections).length;
  if (!connections || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return null;
  return { from, to, connections };
}

/**
 * Timing point names to offer for a split: the ones that start with the split's name first ("1K-A" for "1K"), then
 * the most recent.
 * @param {{ name: string, lastAt?: any }[]} locations seen.locations not used in this race yet
 * @param {string} splitName
 */
export function rankLocations(locations, splitName) {
  const key = norm(splitName);
  const rank = (l) => (key && norm(l.name).startsWith(key) ? 0 : 1);
  return arr(locations).slice().sort((a, b) => rank(a) - rank(b)
    || (toMs(b.lastAt) ?? 0) - (toMs(a.lastAt) ?? 0) || str(a.name).localeCompare(str(b.name)));
}

/**
 * Keeps the offered chips of an open adder where they were: names offered before stay in their place (the ones just
 * added stay too, shown as added), new names go at the end. Otherwise the next chip slides under the pointer after
 * each add, and a double click maps the wrong timing point.
 * @param {string[]} order names in the order shown so far
 * @param {{ name: string }[]} options what may be offered now
 * @param {Set<string>} added norm()ed names added while the adder was open
 * @returns {{ order: string[], items: { name: string, added: boolean, option: any }[] }}
 */
export function stableOptions(order, options, added) {
  const byName = new Map(arr(options).map((o) => [norm(o.name), o]));
  const items = [];
  const next = [];
  const seen = new Set();
  for (const name of arr(order)) {
    const k = norm(name);
    if (seen.has(k)) continue;
    if (byName.has(k)) items.push({ name: byName.get(k).name, added: false, option: byName.get(k) });
    else if (added.has(k)) items.push({ name, added: true, option: null });
    else continue;
    seen.add(k);
    next.push(name);
  }
  for (const o of arr(options)) {
    const k = norm(o.name);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ name: o.name, added: false, option: o });
    next.push(o.name);
  }
  return { order: next, items };
}

export function outputToDraft(o) {
  return {
    name: str(o?.name),
    enabled: o?.enabled !== false,
    mode: ['tcp-client', 'tcp-server', 'udp'].includes(o?.mode) ? o.mode : 'tcp-client',
    host: str(o?.host),
    port: o?.port == null ? '' : str(o.port),
    script: str(o?.script),
    stage: o?.stage === 'started' ? 'started' : 'results',
    allRaces: !arr(o?.races).length,
    races: arr(o?.races).map(str),
    eventNumber: o?.eventNumber === 'blank' ? 'blank' : 'race',
    precision: String([1, 2, 3].includes(Number(o?.precision)) ? Number(o.precision) : 3),
    mid: str(o?.mid),
    // DESIGN 9.24: a clearing line for a split that was taken back (off unless ticked)
    clearLines: o?.clearLines === true,
  };
}

/** The Partial<Output> body for POST/PUT. */
export function outputBody(d) {
  return {
    name: str(d.name).trim(),
    enabled: !!d.enabled,
    mode: d.mode,
    host: str(d.host).trim(),
    port: Number(str(d.port).trim()),
    script: str(d.script).trim(),
    stage: d.stage,
    races: d.allRaces ? [] : arr(d.races),
    eventNumber: d.eventNumber,
    precision: Number(d.precision),
    clearLines: d.clearLines === true,
    mid: str(d.mid).trim(),
  };
}

/** @returns {string[]} */
export function validateOutputDraft(d) {
  const errs = [];
  if (!str(d.name).trim()) errs.push('Give the output a name (for example TrackScore).');
  if (d.mode !== 'tcp-server' && !str(d.host).trim()) errs.push('Type the IP address of the computer to send to (127.0.0.1 is this PC).');
  const p = validatePort(d.port, 'The port');
  if (p) errs.push(p);
  if (!str(d.script).trim()) errs.push('Choose the .lss script for this output (Browse…).');
  if (!d.allRaces && !arr(d.races).length) errs.push('Tick at least one race, or choose “All races”.');
  if (str(d.mid).trim() && !/^\d+$/.test(str(d.mid).trim())) errs.push('The MID is the live-results meet number, digits only (for example 8132).');
  return errs;
}

/**
 * The MID the output really sends: the override replaces the script's (DESIGN.md §4.7).
 * @param {string | null | undefined} scriptMid from OutputStatus.scriptInfo.mid
 * @param {string} [override] Output.mid as saved
 */
export function midText(scriptMid, override) {
  const o = str(override).trim();
  if (o && scriptMid && o !== str(scriptMid)) return `It sends MID ${o} (your override; the script has ${scriptMid}).`;
  if (o) return `It sends MID ${o}.`;
  return scriptMid ? `It sends MID ${scriptMid}.` : '';
}

/**
 * Reads the answer of GET /api/files?dir=<script path>&ext=.lss (the server lists the folder of a file path) to
 * tell whether the script file is there, before a typo is saved and the output stops sending.
 * @param {string} p the typed path
 * @param {any} r the answer, or null when the request failed
 * @param {string} [error] the request's error message
 * @returns {{ ok: boolean, why: string }}
 */
export function scriptPathCheck(p, r, error = '') {
  const path = str(p).trim();
  if (!path) return { ok: false, why: 'No script chosen.' };
  if (!/\.lss$/i.test(path)) return { ok: false, why: `${baseName(path) || path} isn't a .lss file.` };
  if (!r) return { ok: false, why: `Split Relay can't open ${path}${error ? ` (${error})` : ''}.` };
  const want = normPath(path);
  if (arr(r.entries).some((e) => e && e.type === 'file' && normPath(e.path) === want)) return { ok: true, why: '' };
  if (r.truncated) return { ok: true, why: '' };
  return { ok: false, why: `There is no file called ${baseName(path)} in ${str(r.dir) || dirName(path)}.` };
}

/**
 * The words of the Resend dialog: what is sent where, and the risks an operator must know before pressing it.
 * @param {any} st State
 * @param {string} id race id
 * @param {{ includeFinished?: boolean }} [opts] the dialog's "Also re-send runners who have finished" box: the button
 *   says what goes with it ticked or not
 * @returns {{ title: string, body: string[], confirm: string, danger: boolean, inactive: boolean, n: number }}
 */
export function resendDialogText(st, id, { includeFinished = false } = {}) {
  const cfg = configRace(st, id);
  const rv = viewOf(st, id);
  const name = cfg?.name || rv?.name || 'this race';
  // 9.23 F14: what the Resend sends (RaceView.resend: held passes never, finishers' real splits only with the box), the
  // number its toast says afterwards; else every crossing (an older Split Relay)
  const rs = rv?.resend && typeof rv.resend === 'object' ? { count: Number(rv.resend.count) || 0, finished: Number(rv.resend.finished) || 0 } : null;
  const n = rs ? rs.count + (includeFinished ? rs.finished : 0) : crossingCount(rv);
  // the runners who have finished (FinishLynx): a Resend leaves their splits out unless the box is ticked
  const fin = Number(rv?.finished) || 0;
  const runners = Math.max(Number(rv?.runners) || 0, fin);
  const outs = arr(st?.config?.outputs).filter((o) => o.enabled !== false && outputSendsRace(o, id));
  const inactive = cfg?.active === false;
  const to = outs.length ? listText(outs.map((o) => o.name)) : 'no output (no output is switched on for this race)';
  const stale = resendPrompt(rv);
  const body = [n
    ? `Split Relay sends the ${plural(n, 'split')} it has for ${name} again, with the current settings, gun time and places, to ${to}${stale?.count ? `: ${fmtInt(stale.count)} of them ${stale.count === 1 ? 'is' : 'are'} out of date${staleWhere(stale)} now` : ''}.`
    : `Split Relay has no splits for ${name} under the current settings, so nothing is sent to ${to}; the splits sent earlier stop counting as out of date.`,
  ];
  if (inactive) {
    // only a TrackScore-like output shows one race at a time; live results take every race
    const one = outs.filter((o) => isTrackScoreLike(o, outputStatus(st, o.id)));
    body.push(one.length
      ? `${name} is switched off (not Active), so ${listText(one.map((o) => o.name))} ${one.length === 1 ? 'is' : 'are'} probably showing another race now.`
      : `${name} is switched off (not Active).`);
  }
  const en = eventLabel(cfg);
  // With nothing to send, nothing can make TrackScore switch races or touch a finished runner's place.
  if (n) {
    for (const o of outs) {
      if (!isTrackScoreLike(o, outputStatus(st, o.id))) continue;
      body.push(o.eventNumber === 'blank'
        ? `${o.name} gets a blank event number, so these splits go into whatever race it is showing now.`
        : `If ${o.name} is showing another race, it switches to ${en || "this race's event"} (${name}) and clears the race it was showing.`);
    }
    // name the outputs that take this race: a race sent only to the live results must not talk about TrackScore
    body.push(`Runners who have finished are left out unless you tick the box: a split packet replaces their finish place in ${outs.length ? listText(outs.map((o) => o.name)) : 'the outputs'}.`);
    // how many that is: a Resend of a race everybody has finished sends next to nothing unless the box is ticked
    if (fin > 0) {
      body.push(fin >= runners
        ? `All ${plural(runners, 'runner')} of ${name} have finished: without the box, only their made-up and typed times go.`
        : `${fmtInt(fin)} of ${plural(runners, 'runner')} have finished: their splits stay out unless you tick the box.`);
    }
    // revision 10: what TrackScore lacks (or has with an old time) for finishers is Review's, with the finish place
    const fns = Number(rv?.finishedNotSent) || 0;
    // (the outputs that take the race, by name: a race TrackScore doesn't get is not "in TrackScore")
    const dest = { outputs: outs.map((o) => str(o.name).trim() || 'an output') };
    const keeps = keepsText(dest);
    if (fns) body.push(`${fns === 1 ? '1 split' : `${fmtInt(fns)} splits`} of runners who have finished ${fns === 1 ? 'is' : 'are'} not in ${outsText(dest) || 'the outputs'} as ${fns === 1 ? 'it is' : 'they are'} now (not sent, or sent with an old time): send ${fns === 1 ? 'it' : 'them'} from Review (“Finished: not sent live”), with the finish place${keeps ? `, ${keeps}` : ''}.`);
    // DESIGN 9.17 P4: a finisher's made-up or typed split always carries the finish place, so the Resend sends it too
    if (reviewCounts(rv).manual) body.push(`Made-up and typed times of runners who have finished go too: they carry the finish place${keeps ? `, ${keeps}` : ''}.`);
  }
  // DESIGN 9.16 F1: a packet fills a cell, it can't empty one
  body.push(resendLimitText(rv?.leftover));
  const confirm = inactive ? 'Resend anyway'
    : !n || !fin ? `Resend ${plural(n, 'split')}`
      : includeFinished ? `Resend all ${plural(n, 'split')}` : rs ? `Resend ${plural(n, 'split')} (${fmtInt(fin)} finished left out)` : `Resend (${fmtInt(fin)} finished left out)`;
  return { title: `Resend ${name}'s splits?`, body, confirm, danger: inactive, inactive, n };
}

/**
 * The toast after a resend: { sent, skippedFinished, outputs } from POST /api/races/:id/resend (§9.8).
 * @param {string} name
 * @param {any} r
 * @param {number|null} [splits] the splits the race had when the dialog was confirmed: none means nothing to send
 */
export function resendToast(name, r, splits = null) {
  const sent = Number(r?.sent) || 0;
  const skipped = Number(r?.skippedFinished) || 0;
  if (splits === 0 && !sent && !skipped) return `Split Relay has no splits for ${name} under the current settings, so nothing was sent.`;
  // `outputs` is how many outputs took part (a number), or a list of them
  const outs = Array.isArray(r?.outputs) ? r.outputs : null;
  const outCount = outs ? outs.length : typeof r?.outputs === 'number' ? r.outputs : null;
  if (outCount === 0) return `Nothing was sent for ${name}: no output takes this race.`;
  const per = outs && outs.some((o) => o && typeof o === 'object' && o.name != null && Number.isFinite(Number(o.sent)))
    ? ` (${outs.map((o) => `${o.name}: ${fmtInt(o.sent)}`).join(', ')})` : '';
  return `Re-sent ${plural(sent, 'split')} for ${name}${per}.${skipped ? ` ${fmtInt(skipped)} skipped because the runner has finished.` : ''}`;
}

const normPath = (p) => str(p).trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/**
 * Whether folder `child` is `parent` or inside it (Windows rules: case-insensitive, / or \).
 * @param {string} child
 * @param {string} parent
 */
export function pathInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '\\');
}

/** "C:\Lynx\XCScore.lss" -> "C:\Lynx"; "" when there is no folder part. */
export function dirName(p) {
  const s = str(p).trim().replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return '';
  const d = s.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
}

/**
 * A folder path as its parts, each with the path that opens it (the file browser's trail): "C:\Lynx\Meet" -> C:,
 * Lynx, Meet; "\\server\share\x" -> \\server\share, x; "/home/me" -> /, home, me.
 * @param {string} dir
 * @returns {{ name: string, path: string }[]}
 */
export function pathCrumbs(dir) {
  const d = str(dir).trim();
  if (!d) return [];
  const sep = d.includes('\\') || /^[A-Za-z]:/.test(d) ? '\\' : '/';
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(d);
  const drive = /^[A-Za-z]:\\?/.exec(d);
  const root = unc ? unc[0] : drive ? drive[0] : d.startsWith('/') ? '/' : '';
  const out = [];
  let acc = '';
  if (root) {
    acc = drive && !root.endsWith('\\') ? root + '\\' : root;
    out.push({ name: unc || root === '/' ? root : root.replace(/\\$/, ''), path: acc });
  }
  for (const p of d.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    acc = !acc ? p : /[\\/]$/.test(acc) ? acc + p : acc + sep + p;
    out.push({ name: p, path: acc });
  }
  return out;
}

export function baseName(p) {
  const s = str(p).trim();
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * "#races/r_1/gun" -> { tab: 'races', id: 'r_1', focus: 'gun' }; anything unknown is the Dashboard ('live').
 * The RR12 inputs and the exporter moved from Settings to their own page: "#settings/input" and
 * "#settings/exporter" (and "#settings/sr") open the Inputs page there.
 * @param {string} hash
 */
export function parseRoute(hash) {
  const parts = str(hash).replace(/^#\/?/, '').split('/').map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  let tab = TABS.includes(parts[0]) ? parts[0] : 'live';
  if (tab === 'settings' && ['input', 'exporter', 'sr'].includes(parts[1])) tab = 'inputs';
  return { tab, id: parts[1] || '', focus: parts[2] || '' };
}

/** The pages, in the order of the navigation rail ('live' is the Dashboard). */
export const TABS = ['live', 'review', 'races', 'outputs', 'inputs', 'settings', 'help'];

/**
 * The Help tab's race-day checklist (DESIGN 9.15 L9, 9.20 N5): the meet's names file first (RR12 sends only bibs), the
 * RR12 exporter, then the races (port, number of splits), the programs that must agree on the number of splits, and the
 * change-over between races.
 * @param {any} st State
 * @returns {[string, string][]} [key, text]
 */
export function helpChecklist(st) {
  const races = arr(st?.config?.races);
  const ports = inputPorts(st);
  const splitList = races.length ? ` (${races.map((r) => `${r.name || '(no name)'}: ${arr(r.splits).length}`).join('; ')})` : '';
  const lifDir = str(st?.config?.lif?.outputDir).trim();
  return [
    ['newmeet', "New meet? Settings → Meet setup → Start a new meet… (last meet's reads are put away, a copy goes to data\\archive, nothing is deleted), then Load meet file… or Set up from TrackScore."],
    ['ppl', "First, load the meet's names file: Settings → Names file → Choose…, FinishLynx's .ppl for this meet. RR12 sends only bibs, so without it TrackScore and the live results show no names or schools. The Dashboard's “No names” chip and Needs attention say when it is missing."],
    ['start', 'Start Split Relay before pressing play on the RR12 exporter. RR12 won\'t start an exporter it can\'t connect to.'],
    ['exporter', `RR12 exporter for Split Relay: TCP/IP (not Pooled) to ${rrTarget(st, ports[0])}, Line end CRLF, Min. Seconds Between 0, Export Data ${laptimeExpression(st)} (copy it on the Inputs page). Timing points: the split mats only (A and B), not the finish.`],
    ['overlap', ports.length > 1
      ? `Races that overlap: a second exporter in RR12, filtered to that race, with the same settings but sending to ${listText(ports.slice(1).map((p) => rrTarget(st, p)))}; that port is chosen on the race.`
      : 'Races that overlap: a second port on the Inputs page, a second exporter in RR12 (filtered to that race) sending to it, and that port chosen on the race.'],
    ['lynx-exporter', 'RR12 exporter to FinishLynx: the Finish timing point only, so the photo shows finish lines only.'],
    ['lynx-laps', 'FinishLynx: every event has Total Laps = 1.'],
    ['names', 'Races: each race\'s name, event, round and heat exactly as FinishLynx has them, and the RR12 port it reads from.'],
    ['splits', `Races: each race's number of splits = the split passes a runner makes before the finish${splitList}.`],
    ['trackscore', "TrackScore (Intermediate splits) and Karmarush: the same number of splits for each race. Both put splits in columns by laps to go. Set up from TrackScore (Races page, or Settings → Meet setup while a race runs) makes Split Relay's splits match TrackScore's Race Setup."],
    ['outputs', 'Outputs: every output shows Connected. Press “Preview packet” once to check the script.'],
    ['lif', `Point XC-Analytics, the web results and TrackScore's file watch at the merged .lif folder${lifDir ? ` (${lifDir})` : ' (Settings → Merged .lif files)'}. During a race TrackScore gets its live splits over port 5555.`],
    ['gun', 'When the gun goes: type the race\'s gun time (from the start clock, or the FinishLynx start once FinishLynx has it) and press Set.'],
    ['watch', 'Dashboard: the first split reads show as Sent in the live feed, and the split counts go up.'],
    ['review', 'A split point in trouble (a mat down, a wrong mat): press ⏸ Pause on its tile; its splits are kept, not sent, until ▶ Play. Runners who missed a mat: press Review on the race tile, check the made-up times and send them, and decide the passes it asks you to check.'],
    ['after', 'After a race: press “Switch to …” for the next race on the same port (or turn off Active). Don\'t delete it: it keeps its reads, and its merged .lif file keeps its splits.'],
  ];
}

/** The race-day checklist's one-line items (Help); each item's full words are behind its "?". */
export const CHECKLIST_SHORT = {
  newmeet: 'New meet? Start a new meet, then load the meet setup.',
  ppl: "First: load the meet's names file (.ppl).",
  start: 'Start Split Relay before RR12\'s exporter.',
  exporter: 'RR12 exporter to Split Relay: the split mats only.',
  overlap: 'Races that overlap: a second exporter and port.',
  'lynx-exporter': 'RR12 exporter to FinishLynx: the Finish only.',
  'lynx-laps': 'FinishLynx: Total Laps = 1 for every event.',
  names: 'Race names, event, round and heat as FinishLynx has them.',
  splits: 'Each race has its number of splits.',
  trackscore: 'TrackScore and Karmarush: the same number of splits.',
  outputs: 'Every output Connected; Preview packet checked.',
  lif: 'TrackScore, XC-Analytics and the web results read the merged .lif folder.',
  gun: 'Set each gun time when the gun goes.',
  watch: 'Watch the first splits go out as Sent.',
  review: 'A mat in trouble: Pause. Runners who missed a mat: Review.',
  after: 'After a race: Switch to the next one on its port.',
};

/** The keys that work anywhere on the page (not while typing in a box). Help lists them. */
export const SHORTCUTS = [['B', 'Find a runner: bib or name'], ['/', 'Find: the feed search on the Dashboard, the runner box elsewhere'], ['R', 'Review'],
  ['In a runner: ← → Enter', 'Move between splits; send the suggested time, or open the choices'], ['Shift+← →', 'Move a time one split, with the later times'],
  ['Ctrl+Z', 'Undo the last change to the runner'], ['1 … 7', 'The pages, in the order of the bar on the left'], ['Esc', 'Close the output editor or a dialog']];

/* ------------------------------------------------------------------------------------------------------------ */
/* Review tools (DESIGN 9.17): pause and play a split, column checks, missing splits and made-up times.          */
/* Split Relay works everything out (estimates, checks, what is held); the panel shows it, says exactly where a     */
/* time goes before it goes, and sends only what the operator approved. Every reader below takes the server's      */
/* fields loosely (a field that is missing never breaks the page), because the panel may meet an older server.     */

/**
 * A split sends unless the operator paused it (config `split.sending`, default true). A paused split's crossings are
 * still worked out and shown, but nothing of it goes to an output or a merged .lif file until Play.
 * @param {any} s config split
 */
export const splitSending = (s) => s?.sending !== false;

/**
 * How many crossings a paused split is holding back (RaceView.splits[].held), 0 when the server does not say.
 * @param {any} s RaceView split
 */
export function splitHeld(s) {
  const n = Number(s?.held ?? s?.heldCount);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** A paused tile's line (DESIGN 9.17 P1): "Paused · 14 held". */
export const pausedText = (held) => `Paused · ${fmtInt(held)} held`;

/**
 * Where a split of this race goes: the outputs that are switched on and send the race, and the merged .lif file when
 * those are on. A dialog says it before anything goes, so the operator knows which scoreboards change.
 * @param {any} st State
 * @param {string} raceId
 * @returns {{ outputs: string[], lif: boolean }}
 */
export function destinations(st, raceId) {
  const outputs = arr(st?.config?.outputs).filter((o) => o && o.enabled !== false && outputSendsRace(o, raceId))
    .map((o) => str(o.name).trim() || 'an output');
  // a paused split keeps what it is given until Play (DESIGN 9.17 P1): said where a time would go into one
  const race = arr(st?.config?.races).find((r) => r && r.id === raceId);
  const paused = arr(race?.splits).filter((s) => s && s.id && !splitSending(s)).map((s) => ({ id: s.id, name: str(s.name) }));
  // a race that is not Active sends nothing live (a packet of it would make TrackScore switch races): its made-up
  // times go into the .lif file only, until the race is Active again
  const inactive = race && race.active === false ? str(race.name).trim() || 'This race' : '';
  return { outputs, lif: !!st?.config?.lif?.enabled, paused, inactive };
}

/** The outputs that take the race, as one list of names ("TrackScore and Karmarush"), or ''. */
const outsText = (dest) => listText(arr(dest?.outputs).filter(Boolean), 5);
const oneOut = (dest) => arr(dest?.outputs).filter(Boolean).length === 1;

/**
 * "so TrackScore keeps it", "so Karmarush and Live results keep it": a split packet's place becomes the runner's place
 * on the outputs that take the race, so a finisher's split carries the finish place. '' when no output takes it.
 * @param {{ outputs?: string[] }} dest
 * @param {string} [what] what they keep: 'it' (the finish place), 'the finish place'
 */
export function keepsText(dest, what = 'it') {
  const names = outsText(dest);
  return names ? `so ${names} ${oneOut(dest) ? 'keeps' : 'keep'} ${what}` : '';
}

/**
 * "3K is paused: it goes out when you press ▶ Play." for a time that goes into a paused split, else ''.
 * @param {{ paused?: { id: string, name: string }[] }} dest
 * @param {string|null|undefined} splitId
 */
export function pausedNote(dest, splitId) {
  const p = arr(dest?.paused).find((x) => x.id === splitId);
  return p ? ` ${p.name || 'That split'} is paused: it goes out when you press ▶ Play.` : '';
}

/**
 * "to TrackScore and Live results, and into the merged .lif file" (follows "goes" / "Sends 2K 6:41.3").
 * @param {{ outputs: string[], lif: boolean }} dest
 * @param {{ lif?: boolean }} [opts] lif: false for a split that is in the .lif file already
 */
export function sendsTo(dest, { lif = true } = {}) {
  const outs = listText(arr(dest?.outputs), 5);
  const toLif = lif && dest?.lif;
  if (dest?.inactive && outs) {
    const later = `${dest.inactive} is not Active, so nothing goes to ${outs} until it is`;
    return toLif ? `into the merged .lif file only (${later})` : `nowhere yet: ${later}`;
  }
  if (outs && toLif) return `to ${outs}, and into the merged .lif file`;
  if (outs) return `to ${outs}${lif ? ' (merged .lif files are off)' : ''}`;
  if (toLif) return 'into the merged .lif file only (no output sends this race)';
  return lif ? 'nowhere yet: no output sends this race and merged .lif files are off. It is kept, and goes out once an output sends the race'
    : 'nowhere yet: no output sends this race. It goes out once one does';
}

/**
 * The toast after a split's pause or play (DESIGN 9.17 P1).
 * @param {string} name the split's name
 * @param {boolean} on true = Play (sending again)
 * @param {number} held crossings it held
 * @param {{ outputs: string[], lif: boolean }} dest
 * @param {{ sent: number, toReview: number } | null} [after] what Play did, worked out from the race before and after
 *   (its held count, and its "Finished: not sent live" count): the held splits of runners who finished meanwhile wait
 *   in Review instead of going out
 */
export function sendingToast(name, on, held, dest, after = null) {
  if (!on) {
    const where = [arr(dest?.outputs).length ? listText(dest.outputs) : '', dest?.lif ? 'the merged .lif file' : ''].filter(Boolean);
    return `${name} is paused: its splits are kept but not sent${where.length ? ` to ${where.join(' or ')}` : ''}. Press ▶ Play to send them.`;
  }
  if (after) {
    const sent = Math.max(0, Number(after.sent) || 0);
    const review = Math.max(0, Number(after.toReview) || 0);
    const parts = [sent ? `${plural(sent, 'split')} sent now` : review ? 'nothing to send live' : '',
      review ? `${plural(review, 'split')} of runners who finished meanwhile wait in Review` : ''].filter(Boolean);
    return `${name} is sending again${parts.length ? `: ${parts.join(' · ')}` : ''}.`;
  }
  const n = Number(held) || 0;
  return `${name} is sending again${n ? `: ${plural(n, 'held split')} ${n === 1 ? 'goes' : 'go'} out now` : ''}. A runner who finished meanwhile is not sent live: Review lists them.`;
}

/**
 * The race's review counts (RaceView.review, DESIGN 9.17 P3) and its finished-not-sent count.
 * @param {any} rv RaceView
 * @returns {{ known: boolean, missing: number, estimable: number, checks: number, manual: number, finishedNotSent: number }}
 *   known: the server gives review counts at all (an older one does not: the panel then offers no Review button)
 */
export function reviewCounts(rv) {
  const r = rv?.review && typeof rv.review === 'object' ? rv.review : null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.trunc(Number(v)) : 0);
  // flagged (9.23): runners with a split that looks wrong; pinned / madeUp: the operator's changes (Clear race data says them)
  return { known: !!r, missing: n(r?.missing), estimable: n(r?.estimable), checks: n(r?.checks), manual: n(r?.manual), finishedNotSent: n(rv?.finishedNotSent),
    flagged: n(r?.flagged), pinned: n(r?.pinned), madeUp: n(r?.madeUp ?? r?.manual),
    // 9.24: of the flagged, the runners with a split too fast to be real, and the first few bibs (only when there are any)
    ...(n(r?.fast) ? { fast: n(r.fast), fastBibs: arr(r.fastBibs).map(str).filter(Boolean) } : {}),
    // 9.25, each only when there are any: strange, the runners who are probably not in this race and are sent all the
    // same (the first few bibs, the first one's words); away, the runners kept off the boards; unlisted, on no start list
    ...(n(r?.strange) ? { strange: n(r.strange), strangeBibs: arr(r.strangeBibs).map(str).filter(Boolean), strangeText: str(r.strangeText).trim() } : {}),
    ...(n(r?.away) ? { away: n(r.away) } : {}),
    ...(n(r?.unlisted) ? { unlisted: n(r.unlisted) } : {}) };
}

/**
 * The Review button's badge: "3 missing splits · 1 to check" (and "· 2 finished, not sent"), '' when nothing waits.
 * @param {ReturnType<typeof reviewCounts>} c
 */
export function reviewBadgeText(c) {
  return [
    c?.missing ? plural(c.missing, 'missing split') : '',
    c?.checks ? `${fmtInt(c.checks)} to check` : '',
    c?.flagged ? `${fmtInt(c.flagged)} look${c.flagged === 1 ? 's' : ''} wrong` : '',
    c?.strange ? `${fmtInt(c.strange)} not in this race?` : '',
    c?.finishedNotSent ? `${fmtInt(c.finishedNotSent)} finished, not sent` : '',
  ].filter(Boolean).join(' · ');
}

/** The badge's colour: a held pass (to check) or a time that can be sent now needs the operator; the rest can wait. */
export const reviewTone = (c) => (c?.checks || c?.estimable || c?.flagged || c?.strange ? 'warn' : c?.missing || c?.finishedNotSent ? 'info' : 'muted');

const numOrNull = (v) => (v == null || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));
const splitById = (cfg, id) => arr(cfg?.splits).find((s) => s && id != null && s.id === id) || null;
const splitByName = (cfg, name) => (norm(name) ? arr(cfg?.splits).find((s) => s && s.id && norm(s.name) === norm(name)) || null : null);

/**
 * The split (or the gun, or the finish) before or after a missing one as { id, name, ticks }, whatever shape the
 * server gives it in: { name, raceTicks }, { splitId }, { kind: 'gun'|'finish' }, a split id, 'gun', 'finish', ticks.
 * @param {any} v
 * @param {any} [cfg] config race, for split names
 * @returns {{ id: string|null, name: string, ticks: number|null } | null}
 */
export function refOf(v, cfg, { index = false } = {}) {
  if (v == null || v === false || v === '') return null;
  // a column check's from/to may be a split's place in the course (0 = the first split)
  if (typeof v === 'number' && index) {
    const s = Number.isInteger(v) ? arr(cfg?.splits)[v] : null;
    return s ? { id: str(s.id), name: str(s.name), ticks: null } : { id: null, name: Number.isInteger(v) && v >= 0 ? defaultSplitName(v) : '', ticks: null };
  }
  if (typeof v === 'number') return Number.isFinite(v) ? { id: null, name: '', ticks: v } : null;
  if (typeof v === 'string') {
    if (/^gun$/i.test(v)) return { id: null, name: 'the gun', ticks: 0 };
    if (/^finish$/i.test(v)) return { id: null, name: 'the finish', ticks: null };
    const s = splitById(cfg, v) || splitByName(cfg, v);
    return { id: s ? str(s.id) : null, name: s ? str(s.name) : v, ticks: null };
  }
  if (typeof v !== 'object') return null;
  const kind = str(v.kind ?? v.type).toLowerCase();
  const given = str(v.name ?? v.splitName ?? v.label).trim();
  // "Move to 2K" needs the split's id: from the server, else the split at that place in the course (col), else the
  // race's split of that name
  const byCol = kind !== 'gun' && kind !== 'finish' && Number.isInteger(v.col) ? arr(cfg?.splits)[v.col] : null;
  const id = v.splitId ?? v.id ?? byCol?.id ?? (given ? splitByName(cfg, given)?.id : null) ?? null;
  const name = given || (id != null ? str(splitById(cfg, id)?.name) : '')
    || (kind === 'gun' ? 'the gun' : kind === 'finish' ? 'the finish' : '');
  let ticks = numOrNull(v.raceTicks ?? v.ticks ?? v.t);
  if (ticks == null && typeof v.time === 'number') ticks = numOrNull(v.time);
  if (ticks == null && typeof v.time === 'string') ticks = parseRaceText(v.time);
  if (ticks == null && kind === 'gun') ticks = 0;
  return { id: id == null ? null : str(id), name, ticks };
}

/**
 * A runner's FinishLynx finish from a review or runner item: { finished, place, ticks } (place null while unknown).
 * @param {any} x
 */
export function finishOf(x) {
  const f = x?.finished;
  const obj = f && typeof f === 'object' ? f : null;
  const p = numOrNull(x?.finishPlace ?? obj?.place ?? x?.lynxPlace);
  const ticks = numOrNull(x?.finishTicks ?? obj?.raceTicks ?? obj?.ticks);
  return { finished: !!f || p != null || ticks != null, place: p != null && p >= 1 ? Math.trunc(p) : null, ticks };
}

/** The words for where a split time came from (runner view, Review). */
export const SOURCE_WORDS = { read: 'Read', 'made-up': 'Made-up time', typed: 'Typed time' };

/**
 * A crossing's source as 'read' | 'made-up' | 'typed' (DESIGN 9.17 P3), from `source`, or from `estimated` on a
 * manual crossing.
 * @param {any} x
 * @param {boolean} [manual] the item is a manual crossing (review.manual): no source means made-up or typed
 */
export function sourceOf(x, manual = false) {
  const s = str(x?.source).trim().toLowerCase();
  if (s === 'typed') return 'typed';
  if (['made-up', 'madeup', 'estimated', 'estimate'].includes(s)) return 'made-up';
  if (s === 'manual' || (manual && !s)) return x?.estimated === false ? 'typed' : 'made-up';
  return 'read';
}

/** How a pass was put in a column (runner view), in words; the server's own words pass through. */
const HOW_WORDS = {
  counted: 'counted in order', positional: 'counted in order', earliest: 'by the earliest time', assigned: 'you moved it here',
  assign: 'you moved it here', pinned: 'you moved it here', moved: 'you moved it here', shifted: 'moved here with the time before it', kept: 'you kept it here', keep: 'you kept it here',
  check: 'held: check it below', 'check-column': 'held: check it below', backup: 'backup mat (same pass)', repeat: 'repeat (ignored)',
  'too-early': 'too early (ignored)', extra: 'extra pass (ignored)', 'start-area': 'start area (ignored)', 'after-finish': 'after the finish (ignored)',
  'out-of-order': 'out of order (ignored)', 'before-gun': 'before the gun (ignored)',
};
export const howWord = (how) => HOW_WORDS[str(how).trim().toLowerCase()] || str(how).trim();

/** "Looks like 2K, not 1K (missed 1K?)": the server's words when it gives them. */
export const checkReason = (from, to) => `Looks like ${to?.name || 'a later split'}, not ${from?.name || 'this split'} (missed ${from?.name || 'a mat'}?)`;

/**
 * GET /api/races/:id/review (DESIGN 9.17 P3) as the panel uses it. Every list item gets a `key` that stays the same
 * while the item is there, for the operator's typed times and for keyboard focus across refreshes.
 * @param {any} raw
 * @param {any} [cfg] config race, for split names the server leaves out
 */
export function normReview(raw, cfg) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bibOf = (x) => str(x?.bib).trim();
  const who = (x) => ({ bib: bibOf(x), name: str(x.name).trim(), team: str(x.team).trim() });
  const nameOf = (id, given) => str(given).trim() || str(splitById(cfg, id)?.name) || 'a split';
  // the split's id, or the split at that place in the course when the server gives a column (0 = the first split)
  const sid = (x) => str(x.splitId ?? (Number.isInteger(x.col) ? arr(cfg?.splits)[x.col]?.id : ''));
  const ok = (x) => x && typeof x === 'object' && bibOf(x);
  const missing = arr(r.missing).filter(ok).map((x) => {
    const est = numOrNull(x.estimate);
    const f = finishOf(x);
    const splitId = sid(x);
    const basis = str(x.basis).trim();
    return {
      ...who(x), key: `${bibOf(x)}|${splitId}`, splitId, splitName: nameOf(splitId, x.splitName),
      estimate: est, estimateText: est == null ? '' : str(x.estimateText).trim() || formatRaceTime(est, 1),
      basis, prev: refOf(x.prev, cfg), next: refOf(x.next, cfg), finished: f.finished, finishPlace: f.place,
      // Split Relay says when a row can't go, and why (a finish place it doesn't know, ...); a row that only waits for
      // an estimate can still be typed
      blocked: x.sendable === false && str(x.why).trim() && str(x.why).trim() !== basis ? str(x.why).trim() : '',
    };
  });
  const checks = arr(r.checks).filter(ok).map((x) => {
    const from = refOf(x.from, cfg, { index: true }) || { id: null, name: '', ticks: null };
    const to = refOf(x.to, cfg, { index: true }) || { id: null, name: '', ticks: null };
    if (!from.name && str(x.fromName).trim()) from.name = str(x.fromName).trim();
    if (!to.name && str(x.toName).trim()) to.name = str(x.toName).trim();
    const passTod = numOrNull(x.passTod ?? x.tod);
    return { ...who(x), key: `${bibOf(x)}|${passTod ?? ''}`, passTod, raceTicks: numOrNull(x.raceTicks), from, to,
      reason: str(x.reason).trim() || checkReason(from, to), delivered: x.delivered === true, finished: x.finished === true,
      // (9.23 F20: the time the outputs have in that cell when this pass never went out there)
      sentOther: x.sentOther && typeof x.sentOther === 'object' && str(x.sentOther.timeText).trim() ? { timeText: str(x.sentOther.timeText).trim() } : null,
      // the runner's only pass so far (revision 10): their next pass or finish settles it
      lone: x.lone === true,
      // 9.23 F13: the row of the runner's first pass after a missed split: "Missed <split>: add it"
      missed: missedOf(x.missed), finishPlace: numOrNull(x.finishPlace),
      // 9.25: the runner ran (or is entered in) another race: that is the row's story, Not in this race its one click
      ...(x.stranger && typeof x.stranger === 'object' && str(x.stranger.text).trim() ? { stranger: { text: str(x.stranger.text).trim(), raceName: str(x.stranger.raceName) } } : {}) };
  });
  const finishedNotSent = arr(r.finishedNotSent).filter(ok).map((x) => ({
    ...who(x), key: `${bibOf(x)}|${sid(x)}`, splitId: sid(x), splitName: nameOf(sid(x), x.splitName),
    raceTicks: numOrNull(x.raceTicks), finishPlace: finishOf(x).place,
    // revision 10: it went out before it was corrected (a Move): TrackScore has this older time; or it went out after
    // the runner finished, with this split place (which TrackScore may show as the runner's place)
    sentOld: oldOf(x.sentOld), sentAfter: afterOf(x.sentAfter),
  }));
  const manual = arr(r.manual).filter(ok).map((x) => ({
    ...who(x), key: `${bibOf(x)}|${sid(x)}`, splitId: sid(x), splitName: nameOf(sid(x), x.splitName),
    raceTicks: numOrNull(x.raceTicks), source: sourceOf(x, true), basis: str(x.basis).trim(), at: toMs(x.at),
    // what became of it: 'active' is the runner's split now; the others are kept for the record (DESIGN 9.17 P3)
    state: str(x.state).trim() || 'active', sent: x.sent === true, place: numOrNull(x.place), withFinishPlace: x.withFinishPlace === true,
    // 9.23 F14: the place it went out with (the place there now may differ)
    sentPlace: numOrNull(x.sentPlace),
    // 9.26: a time in a split that is counted but not sent: it holds the runner's columns and goes nowhere
    ...(x.collectOnly === true ? { collectOnly: true } : {}),
  }));
  // DESIGN 9.23 F6: splits that look wrong (advice: nothing is held), with the split Split Relay suggests
  const flags = arr(r.flags).filter(ok).map((x) => ({
    ...who(x), key: `${bibOf(x)}|${numOrNull(x.passTod) ?? ''}`, splitId: sid(x), splitName: nameOf(sid(x), x.splitName),
    passTod: numOrNull(x.passTod), raceTicks: numOrNull(x.raceTicks), kind: str(x.kind) || 'long', text: str(x.text).trim(),
    // 9.23 F14: a made-up time that does not fit (kind 'made-up'): the split of the pass after it, which moves on
    passSplitId: str(x.passSplitId),
    suggest: suggestOf(x.suggest, cfg), kept: x.kept === true,
    // a finisher's fix goes with the finish place, asked first (as in the runner editor)
    finished: x.finished === true, finishPlace: numOrNull(x.finishPlace),
    // 9.23 F13: a later split (or the finish) suggested: the fix is "Missed <this split>: add it"
    missed: missedOf(x.missed),
    // 9.24: the row of a runner's splits that are too fast to be real: each split and its pass (the choices act on them all)
    ...(arr(x.passes).length ? { passes: arr(x.passes).filter((p) => p && typeof p === 'object' && numOrNull(p.passTod) != null).map((p) => ({ splitId: str(p.splitId), splitName: str(p.splitName), passTod: numOrNull(p.passTod), timeText: str(p.timeText).trim() })) } : {}),
    // 9.25: a runner of another race (kind 'stranger'): the race it ran or is entered in
    ...(x.stranger && typeof x.stranger === 'object' ? { stranger: { raceName: str(x.stranger.raceName) } } : {}),
  }));
  // DESIGN 9.25: the runners who are not in this race (kept off the boards), and the ones on no start list
  const passesOf = (x) => arr(x.passes).filter((p) => p && typeof p === 'object').map((p) => ({ splitName: str(p.splitName), timeText: str(p.timeText).trim(),
    ...(str(p.onBoards).trim() ? { onBoards: str(p.onBoards).trim() } : {}) }));
  const away = arr(r.away).filter(ok).map((x) => ({ ...who(x), key: bibOf(x), by: str(x.by) || 'list', why: str(x.why).trim(), passes: passesOf(x), finished: x.finished === true }));
  const unlisted = arr(r.unlisted).filter(ok).map((x) => ({ ...who(x), key: bibOf(x), passes: passesOf(x) }));
  // DESIGN 9.24: the runners the operator stopped sending
  const off = arr(r.off).filter(ok).map((x) => ({ ...who(x), key: bibOf(x), fromText: str(x.fromText).trim(), words: str(x.words).trim() || `from ${str(x.fromText).trim()} on`,
    held: arr(x.held).filter((y) => y && typeof y === 'object').map((y) => ({ splitName: str(y.splitName), timeText: str(y.timeText).trim() })) }));
  return { missing, checks, finishedNotSent, manual, flags, ...(off.length ? { off } : {}), ...(away.length ? { away } : {}), ...(unlisted.length ? { unlisted } : {}) };
}

/** A look-wrong flag's suggestion (9.23 F6): { to: split id | 'finish' | 'none', toName, missed }, or null. */
function suggestOf(v, cfg) {
  if (!v || typeof v !== 'object') return null;
  const to = str(v.to);
  if (!to) return null;
  const toName = str(v.toName).trim() || (to === 'finish' ? 'the finish' : to === 'none' ? 'Not a split' : str(splitById(cfg, to)?.name) || 'a split');
  return { to, toName, missed: arr(v.missed).map(str) };
}

/**
 * "Missed <split>: add it" (DESIGN 9.23 F13) as Split Relay gives it for a cell, a look-wrong flag or a check row: how
 * many splits in a row and their names; for a cell also whether it can be done (why not), whether a time can be typed
 * instead, the suggested time of each split, what it does to the runner's passes, the pass that moves on, and `here`
 * (the column check or a flag points at this split: "missed here?"). Null when it does not apply. 9.23 F16: a choice
 * of two mats missed apart has `runs` (each its split and count, in one change) and `read`, the splits read between
 * them ("Missed 4200m and 5300m: add them (4400m was read)"); every choice its own split and pass (`alt` can start at
 * another split than the hint's), which the menu acts on (missedKey).
 */
function missedOf(v) {
  if (!v || typeof v !== 'object') return null;
  const choice = (x, own = v) => {
    const names = arr(x.names).map(str).filter(Boolean);
    const count = Number.isInteger(x.count) && x.count > 0 ? x.count : Math.max(1, names.length);
    const runs = arr(x.runs).filter((y) => y && typeof y === 'object' && str(y.splitId)).map((y) => ({ splitId: str(y.splitId), splitName: str(y.splitName),
      count: Number.isInteger(y.count) && y.count > 0 ? y.count : 1 }));
    const splitId = str(x.splitId) || str(own.splitId);
    // (9.23 F20: the stray passes the set sets aside in the same change)
    const aside = arr(x.aside).filter((y) => y && typeof y === 'object' && numOrNull(y.passTod) != null).map((y) => ({ passTod: numOrNull(y.passTod), timeText: str(y.timeText).trim() }));
    return {
      count, names, ok: x.ok !== false, why: str(x.why).trim(),
      typed: x.typed === true, splits: arr(x.splits).filter((y) => y && typeof y === 'object').map((y) => ({ splitId: str(y.splitId), splitName: str(y.splitName),
        estimate: numOrNull(y.estimate), basis: str(y.basis).trim() })),
      effect: str(x.effect).trim(), splitId, passTod: numOrNull(x.passTod),
      ...(runs.length > 1 ? { runs, read: arr(x.read).map(str).filter(Boolean), readText: str(x.readText).trim() } : {}),
      ...(aside.length ? { aside } : {}),
    };
  };
  return {
    ...choice(v), here: v.here === true, by: str(v.by), reason: str(v.reason).trim(),
    // 9.23 F14: the one click only when one count of missed splits fits clearly best; else `alt`, the other count
    // Split Relay can't tell it from (both are offered), or none while it can't tell yet (9.23 F15: `unsure` 'where':
    // another split fits about as well; 9.23 F16: `alt` another set, perhaps from another split; 9.23 F19: 'late', the
    // runner may have started late (`alt`: then with this set missed), 'next', its next pass will tell, 'slow', its finish
    // will: the time fits neither split well)
    sure: v.sure !== false, alt: v.alt && typeof v.alt === 'object' ? choice(v.alt) : null, unsure: str(v.unsure),
    // (9.23 F20: the cell's own split alone, for a time typed there, when the choices are sets of several splits)
    one: v.one && typeof v.one === 'object' ? choice(v.one) : null,
    // (9.23 F20: 'leg', the slow leg Split Relay can't tell the missed mat from: { from, to, lostText }; 9.23 F21: 'stray',
    // a stray set whose times fit about as well as read, a fast leg)
    leg: v.leg && typeof v.leg === 'object' ? { from: str(v.leg.from), to: str(v.leg.to), lostText: str(v.leg.lostText) } : null,
  };
}

/**
 * The one-split choice of a cell's "Missed …" (9.23 F14: while Split Relay can't tell how many; 9.23 F20: `one`, the
 * cell's own split alone, when every choice is a set of several splits): what a time typed there adds. Null when none.
 * @param {ReturnType<typeof missedOf>} m
 */
export function missedOne(m) {
  if (!m) return null;
  return m.one ?? missedChoices(m).find((x) => x.count === 1 && !x.runs && !x.aside && (!x.splitId || !m.splitId || x.splitId === m.splitId)) ?? null;
}

/** A "Missed …" choice's key (9.23 F16): its runs ("s5:1,s7:1"), else its split and count; the column's split when it has none. */
export function missedKey(x, splitId = '') {
  if (x?.key) return x.key;
  // (9.23 F20: a set that sets a stray pass aside is a choice of its own)
  const aside = arr(x?.aside).length ? `/${x.aside.map((a) => a.passTod).join(',')}` : '';
  return (x?.runs?.length > 1 ? x.runs.map((y) => `${y.splitId}:${y.count}`).join(',') : `${x?.splitId || splitId}:${x?.count ?? 1}`) + aside;
}

/**
 * 9.23 F19: two choices that differ in which splits, not only in how many in a row from one split: "can't tell which mats
 * missed the runner", never "how many splits in a row" (568's two sets, "3100m, 4400m and 5300m" or "3100m, 4200m and
 * 5300m", were "can't tell how many splits in a row").
 */
const otherSet = (m) => !!m?.alt && (m.unsure === 'where' || !!m.runs || !!m.alt.runs || (!!m.alt.splitId && !!m.splitId && m.alt.splitId !== m.splitId));

/**
 * The choices of a "Missed <split>" hint (9.23 F14): the one click when Split Relay is sure, else the sets it can't
 * tell from, fewest splits first (then course order), each with what it does.
 * @param {ReturnType<typeof missedOf>} m
 */
export function missedChoices(m) {
  if (!m) return [];
  return m.alt ? [m, m.alt].sort((a, b) => a.names.length - b.names.length || a.count - b.count) : [m];
}

/**
 * What the panel says beside the choices when Split Relay can't tell how many splits in a row a mat missed (9.23 F14),
 * or '': "Split Relay can't tell which: Missed 2400m: add it (15:18.4 → 3100m, …) or Missed 2400m and 3100m: add them
 * (15:18.4 → 4200m, …)." (9.23 F16: or which mats, two apart or in a row: "… or Missed 4200m and 5300m: add them (4400m
 * was read) (16:41.3 → 4400m, …)", and while it may still tell where: "its next pass may tell")
 * @param {ReturnType<typeof missedOf>} m
 */
export function missedUnsureText(m) {
  if (!m || m.sure !== false) return '';
  const each = missedChoices(m).map((x) => `${missedLabel(x)}${x.effect ? ` (${x.effect})` : ''}`);
  // (9.23 F19: a runner who started late has every pass late by the same time, just as if the first mat missed it; one
  // leg that took minutes longer looks like a missed mat until the runner's next pass)
  const said = (x) => `${missedLabel(x)}${x.effect ? ` (${x.effect})` : ''}`;
  if (m.unsure === 'late') {
    return m.alt ? `Split Relay can't tell a missed mat from a late start: ${said(m)} if the runner started with the others, or ${said(m.alt)} if it started late.`
      : `Split Relay can't tell a missed mat from a late start (every pass late by the same time): choose ${said(m)} only if the runner started with the others.`;
  }
  if (m.unsure === 'next') return `Split Relay can't tell a missed mat from a slow leg until the runner's next pass: wait for it, or choose ${each[0]}.`;
  // (9.23 F20: the runner's passes fit as read with one slow leg about as well, its later passes in)
  if (m.unsure === 'leg') {
    const leg = m.leg?.from && m.leg?.to ? ` (${m.leg.from} to ${m.leg.to} took${m.leg.lostText ? ` ${m.leg.lostText}` : ''} longer than runners of the same pace, and its later times fit as read)` : '';
    return `Split Relay can't tell a missed mat from a slow leg${leg}: choose ${each[0]} only if a mat missed the runner.`;
  }
  if (m.unsure === 'slow') return `Split Relay can't tell a missed mat from a slow leg until the runner's finish (the time fits neither split well): wait for it, or choose ${each[0]}.`;
  // (9.23 F21: its times fit about as well as read, one leg fast: a stray pass or not, Split Relay can't tell)
  if (m.unsure === 'stray') return `Split Relay can't tell a stray pass from a fast leg (the runner's times fit about as well as they were read): choose ${each[0]} only if the runner was not that fast.`;
  if (m.alt) return `Split Relay can't tell which${otherSet(m) ? ' mats missed the runner' : ''}: ${each.join(' or ')}.`;
  // (9.23 F15: the runner's passes fit about as well with the mat missed at another split, or at none)
  return m.unsure === 'where' ? `Split Relay can't tell yet where the mat missed the runner: its next pass may tell, or choose ${each[0]} if its times say so.`
    : `Split Relay can't tell yet how many splits the mat missed: wait for the runner's next pass, or choose ${each[0]}.`;
}

/**
 * "Missed 2400m: add it", "Missed 1500m and 2400m: add them"; two mats missed apart (9.23 F16) say the splits read
 * between them: "Missed 4200m and 5300m: add them (4400m was read)" (9.23 F13; src/engine.js missedName says the same),
 * three or more in a row as a stretch (9.23 F17, Split Relay's readText): "Missed 800m and 5300m: add them (1500m to 4400m
 * were read)".
 */
export function missedLabel(m) {
  const names = arr(m?.names);
  const read = arr(m?.read);
  const said = str(m?.readText).trim() || `${listText(read)} ${read.length > 1 ? 'were' : 'was'} read`;
  // (9.23 F20: and the stray passes it sets aside: "Missed 2400m: add it (11:24.4 is a stray pass)")
  const aside = arr(m?.aside).map((a) => str(a.timeText)).filter(Boolean);
  const stray = aside.length ? `${listText(aside)} ${aside.length > 1 ? 'are stray passes' : 'is a stray pass'}` : '';
  const why = [read.length ? said : '', stray].filter(Boolean).join('; ');
  return `Missed ${listText(names) || 'this split'}: add ${names.length > 1 ? 'them' : 'it'}${why ? ` (${why})` : ''}`;
}

/**
 * The heading over a hint's choices in the menu when none is the one click (9.23 F17), as missedUnsureText says it: two
 * sets, "Split Relay can't tell which" (F16 headed 568's two sets "can't tell yet where" after its finish, while the row
 * said "can't tell which"); one, "Split Relay can't tell yet where" (or how many) while the runner's next pass may tell.
 * @param {ReturnType<typeof missedOf>} m
 */
export function missedGroup(m) {
  if (!m || m.sure !== false) return '';
  // (9.23 F19)
  if (m.unsure === 'late') return "Split Relay can't tell: a missed mat or a late start";
  if (m.unsure === 'next') return "Split Relay can't tell yet: its next pass will";
  // (9.23 F20)
  if (m.unsure === 'leg') return "Split Relay can't tell: a missed mat or a slow leg";
  if (m.unsure === 'slow') return "Split Relay can't tell yet: its finish will";
  // (9.23 F21)
  if (m.unsure === 'stray') return "Split Relay can't tell: a stray pass or a fast leg";
  if (m.alt) return "Split Relay can't tell which";
  return m.unsure === 'where' ? "Split Relay can't tell yet where" : "Split Relay can't tell yet how many";
}

/** What "Missed <split>: add it" does, under its button or menu item: "8:36.7 suggested · 11:05.9 → 3100m, …". */
export function missedSub(m) {
  if (!m) return '';
  if (!m.ok) return m.why;
  const times = arr(m.splits).filter((x) => x.estimate != null).map((x) => formatRaceTime(x.estimate, 1));
  return [times.length ? `${listText(times)} suggested` : '', m.effect].filter(Boolean).join(' · ');
}

/** A split's older time an output has (revision 10 `sentOld`): { raceTicks, timeText }, or null. */
function oldOf(v) {
  if (!v || typeof v !== 'object') return null;
  const t = numOrNull(v.raceTicks);
  const text = str(v.timeText).trim() || (t != null ? formatRaceTime(t, 1) : '');
  return text ? { raceTicks: t, timeText: text } : null;
}

/** A finished runner's split that went out after the finish (revision 10 `sentAfter`): { place }, or null. */
function afterOf(v) {
  return v && typeof v === 'object' ? { place: numOrNull(v.place) } : null;
}

/**
 * The line on a finished runner's split that went out after the runner finished, with the split place (revision 10,
 * the place rule). The same words as Split Relay's sentAfterText (src/engine.js), checked by a test.
 * @param {number|null} place
 * @param {number|null} finishPlace
 */
export function sentAfterText(place, finishPlace) {
  return `Sent after the runner finished, with place ${place ?? '?'}: TrackScore and the live results may show that as ` +
    `the runner's place. Send it with the finish place${finishPlace != null ? ` (${finishPlace})` : ''}.`;
}

/**
 * The line on a finished runner's split that went out before it was corrected (revision 10). The same words as
 * Split Relay's sentOldText (src/engine.js), checked by a test.
 * @param {string} split
 * @param {string} oldText
 * @param {string} nowText
 */
export function sentOldText(split, oldText, nowText) {
  return `Sent with an old time${oldText ? ` (${oldText})` : ''}: TrackScore and the live results show that as ${split}. ` +
    `Send the corrected time${nowText ? ` (${nowText})` : ''} with the finish place.`;
}

/** What became of a made-up or typed time that is not the runner's split any more, in words (Review's list). */
export const MANUAL_STATE_WORDS = {
  replaced: 'Replaced by a real read of the mat',
  'after-finish': 'Not used: it is not before the runner\'s finish',
  'out-of-order': 'Not used: it is out of course order with the runner\'s other splits',
  'before-gun': 'Not used: it is before the gun time',
  'waiting-gun': 'Not used until the race has a gun time',
  conflict: 'Not used: the split has another time',
};

/** DESIGN 9.26: the line under a made-up or typed time in a split that is counted but not sent. */
export const COUNTED_ONLY_TIME = "Counted, not sent: it keeps the runner's later passes in their own splits. It goes to no scoreboard and is not in the merged .lif file.";

/**
 * The line under a made-up or typed time in Review: sent where, with which place, or why it is not used.
 * @param {ReturnType<typeof normReview>['manual'][number]} m
 * @param {ReturnType<typeof destinations>} dest
 */
export function manualStateText(m, dest) {
  if (m.state !== 'active') return `${MANUAL_STATE_WORDS[m.state] || 'Not used any more'}.`;
  // 9.26: its split is counted, not sent: the time is there to keep the runner's later passes in their splits
  if (m.collectOnly) return COUNTED_ONLY_TIME;
  if (m.sent) {
    // 9.23 F14: the place it went out with (463: "as place 109" was the place there now, its line said P 106), and the
    // place there now when other runners' times moved it since
    const went = m.withFinishPlace ? m.place : m.sentPlace ?? m.place;
    const how = m.withFinishPlace && went != null ? ` with the finish place (${went})` : went != null ? ` as place ${went}` : '';
    const now = !m.withFinishPlace && m.sentPlace != null && m.place != null && m.place !== m.sentPlace ? ` (${ordinal(m.place)} there now)` : '';
    return `Sent${how}${now}.${dest?.lif ? ' In the merged .lif file.' : ''}`;
  }
  return `Not sent yet: it goes ${sendsTo(dest)}.${pausedNote(dest, m.splitId)}`;
}

/**
 * GET /api/races/:id/runners/:bib (DESIGN 9.17 P3): the runner's columns, and for each empty column an item that the
 * missing-split row logic takes (estimate, the splits around it), so any runner can be given a time by hand.
 * @param {any} raw
 * @param {any} [cfg] config race
 */
export function normRunner(raw, cfg) {
  const r = raw && typeof raw === 'object' ? (raw.runner && typeof raw.runner === 'object' ? raw.runner : raw) : {};
  const bib = str(r.bib).trim();
  const f = finishOf(r);
  // the server says why a column is held back as 'paused' / 'check' (CrossingView.held); the feed's words for them
  const HELD = { paused: 'split-paused', check: 'check-column', stopped: 'not-sending', away: 'not-in-race', collect: 'counted' };
  const cols = arr(r.columns ?? r.splits).filter((c) => c && typeof c === 'object').map((c, i) => {
    const id = str(c.splitId ?? c.id ?? arr(cfg?.splits)[Number.isInteger(c.col) ? c.col : i]?.id);
    // GET /runners/:bib gives a column's race time as `time` (ticks, null when empty)
    const ticks = numOrNull(c.raceTicks ?? (typeof c.time === 'number' ? c.time : null));
    const est = numOrNull(c.estimate);
    const held = str(c.status ?? c.held).trim();
    return {
      // DESIGN 9.23 F7: how it got there, what kind of cell it is, the pass in it (for a Move), whether it looks wrong,
      // and what a scoreboard shows instead (stale) or still shows in an empty cell (leftover)
      how: str(c.how).trim(), passTod: numOrNull(c.passTod), index: i,
      kind: str(c.kind).trim() || (ticks != null ? 'read' : c.missing ? (c.canAdd !== false && est != null ? 'missing' : 'blocked') : 'not-yet'),
      flag: c.flag && typeof c.flag === 'object' ? { kind: str(c.flag.kind), text: str(c.flag.text).trim(), suggest: suggestOf(c.flag.suggest, cfg), silenced: c.flag.silenced === true,
        // 9.24: a mark that covers several splits: the other passes its choices act on
        ...(arr(c.flag.also).length ? { also: arr(c.flag.also).map(numOrNull).filter((t) => t != null) } : {}) } : null,
      stale: c.stale && typeof c.stale === 'object' ? str(c.stale.text).trim() : str(c.stale).trim(),
      leftover: c.leftover && typeof c.leftover === 'object' ? { timeText: str(c.leftover.timeText).trim(), outputs: arr(c.leftover.outputs).map(str) } : null,
      why: str(c.why).trim(), check: c.check && typeof c.check === 'object' ? { to: str(c.check.to), toName: str(c.check.toName), reason: str(c.check.reason) } : null,
      // an output has it as it is now (revision 10)
      delivered: c.delivered === true,
      splitId: id, splitName: str(c.splitName ?? c.name).trim() || str(splitById(cfg, id)?.name) || defaultSplitName(i),
      raceTicks: ticks, place: numOrNull(c.place), source: ticks == null ? '' : sourceOf(c), basis: str(c.basis).trim(),
      estimate: est, estimateText: est == null ? '' : str(c.estimateText).trim() || formatRaceTime(est, 1),
      prev: refOf(c.prev, cfg), next: refOf(c.next, cfg), status: HELD[held] || held,
      // Split Relay's reason a time can't be sent for this column (a check to settle first, a finish place it doesn't
      // know): the row says it and its Send is off
      blocked: c.canAdd === false && ticks == null ? str(c.why).trim() : '',
      // revision 10: a finished runner's split no output has as it is now (Review: Finished: not sent live), and the
      // older time TrackScore has for it when it went out before it was corrected
      finishedNotSent: c.finishedNotSent === true && ticks != null, sentOld: oldOf(c.sentOld), sentAfter: afterOf(c.sentAfter),
      // 9.23 F13: "Missed <split>: add it" for this cell (here: the column check or a flag points at it)
      missed: missedOf(c.missed),
      // 9.26: the split is counted but not sent: marked and muted, nothing to send or resend
      collectOnly: c.collectOnly === true,
    };
  });
  // the splits around an empty column, from the runner's own columns when the server does not say
  cols.forEach((c, i) => {
    if (c.raceTicks != null) return;
    if (!c.prev) {
      const before = cols.slice(0, i).reverse().find((x) => x.raceTicks != null);
      c.prev = before ? { id: before.splitId, name: before.splitName, ticks: before.raceTicks } : { id: null, name: 'the gun', ticks: 0 };
    }
    if (!c.next) {
      const after = cols.slice(i + 1).find((x) => x.raceTicks != null);
      c.next = after ? { id: after.splitId, name: after.splitName, ticks: after.raceTicks } : f.ticks != null ? { id: null, name: 'the finish', ticks: f.ticks } : null;
    }
  });
  const target = (t) => ({ splitId: str(t?.splitId), splitName: str(t?.splitName) || str(splitById(cfg, t?.splitId)?.name), ok: t?.ok === true,
    why: str(t?.why).trim(), effect: str(t?.effect).trim(), fit: numOrNull(t?.fit), best: t?.best === true,
    // Split Relay's verdict on the runner's pace there (9.23 F2): 'early', 'late' or '' (it fits, or nothing to judge by)
    pace: t?.pace === 'early' || t?.pace === 'late' ? t.pace : '' });
  const passes = arr(r.passes).filter((p) => p && typeof p === 'object').map((p) => ({
    tod: numOrNull(p.tod), raceTicks: numOrNull(p.raceTicks),
    splitName: str(p.splitName).trim() || str(splitById(cfg, p.splitId)?.name),
    // the server's own sentence ("Counted: 2K.", "3K: moved there in Review.") when it gives one
    how: str(p.howText).trim() || howWord(p.how ?? p.assigned ?? p.status),
    suggestion: p.suggestion && typeof p.suggestion === 'object' ? str(p.suggestion.reason).trim() : '',
    // DESIGN 9.23 F7: where it is, the operator's decision on it, and what each change to it would do
    kind: str(p.how).trim(), splitId: p.splitId == null ? '' : str(p.splitId), where: str(p.where), inColumn: p.inColumn === true,
    pinned: p.pinned == null ? '' : str(p.pinned), timeText: str(p.timeText).trim() || (numOrNull(p.raceTicks) != null ? formatRaceTime(p.raceTicks, 1) : ''),
    targets: arr(p.targets).map(target), only: arr(p.only).map(target),
    finishOk: p.finishOk && typeof p.finishOk === 'object' ? { ok: p.finishOk.ok === true, why: str(p.finishOk.why).trim(), effect: str(p.finishOk.effect).trim(), best: p.finishOk.best === true,
      pace: p.finishOk.pace === 'early' || p.finishOk.pace === 'late' ? p.finishOk.pace : '' } : null,
  }));
  const changes = arr(r.changes).filter((c) => c && Number.isInteger(c.fix)).map((c) => ({ fix: c.fix, at: toMs(c.at), atText: str(c.atText),
    kind: str(c.kind), text: str(c.text).trim(), undone: c.undone === true, undoable: c.undoable === true, why: str(c.why).trim() }));
  return {
    bib, name: str(r.name).trim(), team: str(r.team).trim(), finished: f.finished, finishPlace: f.place, finishTicks: f.ticks,
    suspect: r.suspect === true,
    columns: cols, passes, found: r.found !== false && (cols.some((c) => c.raceTicks != null) || passes.length > 0 || f.finished),
    // DESIGN 9.23 F7
    finishBy: str(r.finishBy), finishMarkedTod: numOrNull(r.finishMarkedTod), fillable: Number(r.fillable) || 0,
    alsoIn: arr(r.alsoIn).filter((x) => x && x.raceId).map((x) => ({ raceId: str(x.raceId), raceName: str(x.raceName) })),
    changes, problems: arr(r.problems).filter((x) => x && typeof x === 'object').map((x) => ({ kind: str(x.kind), col: Number.isInteger(x.col) ? x.col : null, text: str(x.text).trim() })),
    missedHint: missedOf(r.missedHint),
    // 9.23 F18: Split Relay takes the runner for a late starter (a quiet note, nothing to do): "5:00", else ''
    lateStart: r.lateStart && typeof r.lateStart === 'object' ? str(r.lateStart.text).trim() : '',
    // 9.23 F20: Split Relay takes the runner for one with a slow leg, every mat read (a quiet note): { splitName, text }
    slowLeg: r.slowLeg && typeof r.slowLeg === 'object' && str(r.slowLeg.text).trim() ? { splitName: str(r.slowLeg.splitName), text: str(r.slowLeg.text).trim() } : null,
    manual: arr(r.manual).filter((x) => x && typeof x === 'object').map((x) => ({ splitId: str(x.splitId), state: str(x.state), source: sourceOf(x, true), basis: str(x.basis).trim() })),
    // 9.24: off, the runner is stopped (its words); stop, what Stop sending this runner would do now (its words)
    ...(r.sending && typeof r.sending === 'object' ? { sending: {
      off: r.sending.off && typeof r.sending.off === 'object' ? { fromText: str(r.sending.off.fromText), text: str(r.sending.off.text).trim() } : null,
      stop: r.sending.stop && typeof r.sending.stop === 'object' ? { fromText: str(r.sending.stop.fromText), text: str(r.sending.stop.text).trim() } : null } } : {}),
    // 9.25: where the runner stands: 'away' (not in this race), 'stranger' (probably not), 'unlisted' (on no start
    // list), 'here' (you said it counts here), with its words; only then
    ...(r.place && typeof r.place === 'object' && str(r.place.kind) ? { place: { kind: str(r.place.kind), text: str(r.place.text).trim() } } : {}),
    // 9.27: the bib is one of a swapped pair: the other bib, since when, and Split Relay's sentence; only then
    ...(r.swap && typeof r.swap === 'object' && str(r.swap.other).trim() ? { swap: { other: str(r.swap.other).trim(), atText: str(r.swap.atText).trim(),
      text: str(r.swap.text).trim() || `Swapped bibs: bib ${bib} ran with the chip of bib ${str(r.swap.other).trim()}.` } } : {}),
  };
}

/**
 * A runner-view column without a time, as a missing-split item (the same row logic and the same Send).
 * @param {ReturnType<typeof normRunner>} runner
 * @param {any} col one of runner.columns
 */
export function columnItem(runner, col) {
  return {
    key: `${runner.bib}|${col.splitId}`, bib: runner.bib, name: runner.name, team: runner.team, splitId: col.splitId, splitName: col.splitName,
    estimate: col.estimate, estimateText: col.estimateText, basis: col.basis, prev: col.prev, next: col.next,
    finished: runner.finished, finishPlace: runner.finishPlace, blocked: col.blocked || '',
  };
}

/**
 * Why a row's Send is off, or '' when it can go: Split Relay's reason, else a finisher whose place isn't known.
 * @param {any} item
 */
export const rowBlocked = (item) => str(item?.blocked).trim() || (item?.finished && item.finishPlace == null ? FINISHED_NO_PLACE : '');

/** Said on a row whose runner finished without a known place: the Send button is off (DESIGN 9.17 P4). */
// (9.23 F18: a finisher's splits go out with the finish place; TrackScore no longer takes a split packet's place as the
// finish place, since 2026-10-29, so the words don't say it would)
export const FINISHED_NO_PLACE = "Finished, but the finish place isn't known yet (it comes from FinishLynx's .lif file), and a finisher's splits go out with it. Turn on merged .lif files (Settings) or wait until FinishLynx has saved the race.";

/**
 * Whether a time is between the splits around it (DESIGN 9.17 P5): later than the split before (or the gun), earlier
 * than the split after (or the finish). The server checks it again; this says it before anything is sent.
 * @param {number} ticks
 * @param {{ splitName: string, prev?: any, next?: any }} item
 * @returns {string} '' when it fits
 */
export function manualBoundsProblem(ticks, item) {
  const prev = item?.prev && Number.isFinite(item.prev.ticks) ? item.prev : null;
  const next = item?.next && Number.isFinite(item.next.ticks) ? item.next : null;
  const what = item?.splitName || 'This split';
  if (ticks <= (prev ? prev.ticks : 0)) {
    const after = prev && prev.ticks > 0 ? `${prev.name || 'the split before'} (${formatRaceTime(prev.ticks, 3)})` : 'the gun';
    return `${what} must be later than ${after}.`;
  }
  if (next && ticks >= next.ticks) return `${what} must be earlier than ${next.name || 'the split after it'} (${formatRaceTime(next.ticks, 3)}).`;
  return '';
}

/**
 * The time a missing-split row would send: the estimate, unless the operator typed another (a "typed" time).
 * @param {any} item a normReview missing item (or a columnItem)
 * @param {string | undefined} typed what the operator typed in the row's box (undefined = untouched)
 * @returns {{ text: string, ticks: number|null, typed: boolean, problem: string, sendable: boolean }}
 */
export function rowTime(item, typed) {
  const text = typed == null ? str(item?.estimateText) : str(typed).trim();
  const isEstimate = item?.estimate != null && text === str(item.estimateText);
  const ticks = !text ? null : isEstimate ? item.estimate : parseRaceText(text);
  // a row Split Relay can't send whatever the time (a finish place it doesn't know, a check to settle) says that first
  const problem = rowBlocked(item)
    || (!text ? (item?.estimate == null ? 'No estimate yet: waiting for a later split or the finish. You can type a time.' : 'Type the race time, or put the estimate back.')
      : ticks == null ? `"${text}" is not a race time. Type it like 6:41.3 (minutes:seconds).`
        : manualBoundsProblem(ticks, item));
  return { text, ticks, typed: !!text && !isEstimate, problem, sendable: !problem };
}

/**
 * The body of POST /api/races/:id/manual (DESIGN 9.17 P3): no time when the estimate is sent as it is, so Split Relay
 * uses its own estimate to the millisecond (and marks it made-up); a typed time is sent as typed.
 * @param {any} item
 * @param {ReturnType<typeof rowTime>} row
 */
export function manualBody(item, row) {
  const body = { bib: item.bib, splitId: item.splitId };
  if (row.typed) {
    body.time = row.text;
    body.basis = `Typed in Review${item.estimateText ? ` (the estimate was ${item.estimateText})` : ''}.`;
  } else if (item.basis) body.basis = item.basis;
  return body;
}

/**
 * What one row's Send does, said on the row before it is pressed: "Sends 2K 6:41.3 (made-up time) to TrackScore and
 * Live results, and into the merged .lif file."
 * @param {any} item
 * @param {ReturnType<typeof rowTime>} row
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function manualSendLine(item, row, dest) {
  if (!row.text) return '';
  const kind = row.typed ? 'typed time' : 'made-up time';
  const keeps = keepsText(dest);
  const place = item.finished && item.finishPlace != null ? ` with place ${item.finishPlace} (the finish place${keeps ? `, ${keeps}` : ''})` : '';
  return `Sends ${item.splitName} ${row.text} (${kind})${place} ${sendsTo(dest)}.${pausedNote(dest, item.splitId)}`;
}

/**
 * "Send all estimable" (DESIGN 9.17 P6): the rows that can go now with the time in their box, and the ones left out.
 * @param {any[]} missing normReview().missing
 * @param {Map<string, string>} [typed] the operator's typed times by item key
 */
export function sendAllPlan(missing, typed = new Map()) {
  const plan = { send: [], noPlace: [], blocked: [], waiting: [], problems: [] };
  for (const item of arr(missing)) {
    const row = rowTime(item, typed.get(item.key));
    if (item.finished && item.finishPlace == null) plan.noPlace.push(item);
    else if (rowBlocked(item)) plan.blocked.push(item);
    else if (!row.text) plan.waiting.push(item);
    else if (row.problem) plan.problems.push({ item, problem: row.problem });
    else plan.send.push({ item, row });
  }
  return plan;
}

/**
 * The confirm dialog of "Send all": how many, where they go, what a made-up time is, and what is left out and why.
 * @param {ReturnType<typeof sendAllPlan>} plan
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function sendAllText(plan, dest) {
  const n = plan.send.length;
  const typed = plan.send.filter((x) => x.row.typed).length;
  // rows of runners who finished, and how many runners that is (a runner no mat read has a row per split)
  const finRows = plan.send.filter((x) => x.item.finished);
  const fin = new Set(finRows.map((x) => x.item.bib)).size;
  // rows on a paused split are kept until Play (DESIGN 9.17 P1): said apart, so "go out now" is true
  const pausedIds = new Set(arr(dest?.paused).map((p) => p.id));
  const held = plan.send.filter((x) => pausedIds.has(x.item.splitId));
  const heldNames = listText([...new Set(held.map((x) => x.item.splitName))]);
  const now = n - held.length;
  const first = !held.length
    ? `${plural(n, 'split time')} ${n === 1 ? 'goes' : 'go'} out now ${sendsTo(dest)}. Each is ranked with the real splits at its split.`
    : now
      ? `${plural(now, 'split time')} ${now === 1 ? 'goes' : 'go'} out now ${sendsTo(dest)}; ${fmtInt(held.length)} (${heldNames}, paused) ${held.length === 1 ? 'goes' : 'go'} out when you press ▶ Play. Each is ranked with the real splits at its split.`
      : `${plural(n, 'split time')} ${n === 1 ? 'is' : 'are'} kept until you press ▶ Play on ${heldNames} (paused); then ${n === 1 ? 'it goes' : 'they go'} ${sendsTo(dest)}.`;
  const body = [
    first,
    typed ? `${fmtInt(typed)} of them ${typed === 1 ? 'is a time' : 'are times'} you typed; the others are Split Relay's estimates.` : '',
    fin ? `${fin === 1 ? '1 runner has' : `${fmtInt(fin)} runners have`} finished: ${finRows.length === 1 ? 'that split goes' : `${finRows.length === n ? 'those' : `their ${fmtInt(finRows.length)}`} splits go`} with the finish place${keepsText(dest) ? `, ${keepsText(dest)}. ${outsText(dest)} also ${oneOut(dest) ? 'shows' : 'show'} it as their place at that split: a split packet carries only one place.` : '.'}` : '',
    plan.noPlace.length ? `Left out: ${plural(plan.noPlace.length, 'runner')} who finished without a known finish place (bib ${listText(plan.noPlace.map((m) => m.bib), 6)}).` : '',
    plan.blocked?.length ? `Left out: ${plural(plan.blocked.length, 'row')} Split Relay can't send yet (bib ${listText(plan.blocked.map((m) => m.bib), 6)}): each row says why.` : '',
    plan.waiting.length ? `Left out: ${plural(plan.waiting.length, 'missing split')} with no estimate yet (waiting for a later split or the finish).` : '',
    'Made-up times are estimates, not timed splits. Review lists them, and a real read for one of those splits later replaces it.',
  ].filter(Boolean);
  return { title: `Send ${plural(n, 'made-up split time')}?`, body, confirm: `Send ${fmtInt(n)}` };
}

/**
 * "Send with finish place" for real splits that were not sent live because the runner had finished (DESIGN 9.17 P4).
 * @param {any[]} items normReview().finishedNotSent
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function finishedSendText(items, dest) {
  const list = arr(items);
  const n = list.length;
  const one = list[0];
  const oldCount = list.filter((x) => x.sentOld).length;
  const afterCount = list.filter((x) => !x.sentOld && x.sentAfter).length;
  const title = n === 1 ? `Send bib ${one.bib}'s ${one.splitName} with the finish place?` : `Send ${plural(n, 'split')} with the finish place?`;
  // a race that is not Active is sent only when the operator says so here (force): the outputs do get it then
  const live = { ...dest, inactive: '' };
  return {
    title,
    body: [
      `${n === 1 ? `${one.splitName} ${formatRaceTime(one.raceTicks, 1)} goes` : 'They go'} ${sendsTo(live, { lif: false })}, with the runner's finish place${n === 1 && one.finishPlace ? ` (${one.finishPlace})` : ''} as the place${keepsText(live, 'the finish place') ? `, ${keepsText(live, 'the finish place')} and ${oneOut(live) ? 'shows' : 'show'} the split time` : ''}.`,
      `${n === 1 ? 'It is' : 'They are'} in the merged .lif file already.${[...new Set(list.map((x) => x.splitId))].map((id) => pausedNote(dest, id)).join('')}`,
      // revision 10: some were sent before they were corrected (a Move in Review): this replaces the old time; some
      // went out just after the runner finished, with the split place: this puts the finish place back
      oldCount ? `${oldCount === n ? (n === 1 ? 'It was' : 'They were') : `${fmtInt(oldCount)} of them ${oldCount === 1 ? 'was' : 'were'}`} sent earlier with an old time${n === 1 && one.sentOld?.timeText ? ` (${one.sentOld.timeText})` : ''}: the corrected time replaces ${oldCount === 1 ? 'it' : 'them'}.` : '',
      afterCount ? `${afterCount === n ? (n === 1 ? 'It was' : 'They were') : `${fmtInt(afterCount)} of them ${afterCount === 1 ? 'was' : 'were'}`} sent just after the runner finished, with the split place${n === 1 && one.sentAfter?.place != null ? ` (${one.sentAfter.place})` : ''}: this puts the finish place back${outsText(live) ? ` in ${outsText(live)}` : ''}.` : '',
      finishPlaceSplitNote(n === 1 ? one.splitName : '', n === 1 ? one.finishPlace : null, live),
      dest?.inactive ? `${dest.inactive} is not Active. If TrackScore is showing another race, a split of this race makes it switch to this one and clear the race it shows. Send only if TrackScore shows ${dest.inactive}.` : '',
    ].filter(Boolean),
    confirm: dest?.inactive ? 'Send anyway' : n === 1 ? 'Send it' : `Send ${fmtInt(n)}`,
    force: !!dest?.inactive,
  };
}

/**
 * The two buttons of a column check (DESIGN 9.17 P2): "Move to 2K" and "Keep in 1K".
 * @param {{ from: { name: string }, to: { name: string } }} c
 */
export function checkLabels(c) {
  return { move: `Move to ${c?.to?.name || 'the later split'}`, keep: `Keep in ${c?.from?.name || 'this split'}` };
}

/**
 * A held pass that went out as its counted split before the check held it: TrackScore and the live results show it in
 * that column, and a packet can't empty a cell; after a Move the column is a missing split, and its made-up time
 * fills the cell again.
 * @param {{ from: { name: string } }} c
 */
export function checkSentText(c) {
  const from = c?.from?.name || 'this split';
  // (9.23 F20: what the boards really show: this pass never went out when they have another time there, as after an
  // Undo, which keeps the change's times on the boards; 475's held 8:12.7 was said to have gone out as 1500m)
  const lead = !c?.delivered && c?.sentOther ? `It never went out: TrackScore and the live results show ${c.sentOther.timeText} at ${from}.`
    : `It went out as ${from} before it was held: TrackScore and the live results show it as ${from}.`;
  // 9.23 F14: as the row's own fix says ("Missed 3100m: add it" puts the made-up 3100m there in the same change; a pass
  // that moves with the one before it gets the right time there with that fix)
  if (c?.missed) {
    const choices = missedChoices(c.missed);
    const fix = choices.length > 1 ? 'Either "Missed …" choice' : missedLabel(c.missed);
    return `${lead} ${fix} puts the right time there, in the same change.`;
  }
  if (/moves with the pass before it/.test(str(c?.reason))) return `${lead} The fix of the pass before it puts the right time there.`;
  return `${lead} After a Move, send the made-up ${from} time that Review then lists: it replaces that cell.`;
}

/**
 * The toast after a column check is decided.
 * @param {any} c normReview check
 * @param {boolean} move
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function checkToast(c, move, dest) {
  const at = c.raceTicks != null ? ` at ${formatRaceTime(c.raceTicks, 1)}` : '';
  const split = move ? c.to : c.from;
  const goes = checkGoesText(c, dest, split);
  return move
    ? `Bib ${c.bib}: the pass${at} is ${c.to.name} now, and ${goes}.${pausedNote(dest, c.to.id)} ${c.from.name} is empty for them: Review lists it as a missing split.`
    : `Bib ${c.bib}: the pass${at} stays ${c.from.name}, and ${goes}.${pausedNote(dest, c.from.id)}`;
}

/**
 * Where a pass goes once its column check is decided: like any split, except for a runner who has finished, whose
 * split goes into the .lif file only (a live packet would replace the finish place in TrackScore) until "Send with
 * finish place".
 * @param {{ bib: string, finished?: boolean }} c
 * @param {ReturnType<typeof destinations>} dest
 * @param {{ name?: string }} [split]
 */
export function checkGoesText(c, dest, split) {
  if (!c?.finished) return `goes ${sendsTo(dest)}`;
  const lif = dest?.lif ? 'goes into the merged .lif file' : 'is kept';
  return `${lif}. Bib ${c.bib} has finished, so it is not sent live: Review then lists ${split?.name || 'it'} under "Finished: not sent live", with Send with finish place`;
}

/**
 * The confirm dialog for taking a made-up or typed time away again: Split Relay forgets it, but a packet can't empty a
 * TrackScore cell (DESIGN 9.16 F1), so the time stays there.
 * @param {any} m normReview manual item
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function removeManualText(m, dest) {
  const kind = m.source === 'typed' ? 'typed' : 'made-up';
  return {
    title: `Remove bib ${m.bib}'s ${kind} ${m.splitName} time?`,
    body: [
      `Split Relay forgets ${m.splitName} ${formatRaceTime(m.raceTicks, 1)} for bib ${m.bib}${dest.lif ? ', takes it out of the merged .lif file' : ''}, and Review lists the split as missing again.`,
      arr(dest.outputs).length
        ? `${listText(dest.outputs)} keep${dest.outputs.length === 1 ? 's' : ''} the time ${dest.outputs.length === 1 ? 'it was' : 'they were'} sent: a split packet can fill a cell but never empty one. Clear the race there if that cell matters.`
        : '',
    ].filter(Boolean),
    confirm: 'Remove time',
  };
}

/** 1st, 2nd, 3rd, 11th, 22nd. */
export function ordinal(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return '';
  const t = v % 100;
  const s = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${v}${s}`;
}

/** The review tools need a Split Relay that has them; an older one answers 404 to their requests. */
export const REVIEW_NOT_SUPPORTED = "This Split Relay doesn't have the review tools yet (pause a split, missing splits). Update Split Relay, then start it again (start.bat).";

/**
 * Whether a failed request means the server has no such endpoint (an older Split Relay), not a refusal with a reason.
 * @param {any} err ApiError
 */
export const notSupported = (err) => !!err && (err.status === 404 || err.status === 405)
  // a bare 404/405, or Split Relay's own "no such path" answer (src/server.js: "Split Relay has no /api/...")
  && /^(Split Relay answered "40[45]|Split Relay has no \/api\/)/.test(str(err.message));

/**
 * Whether this Split Relay has the review tools: its race views carry review counts, or its splits a pause setting.
 * An older one gets no pause buttons and no Review button, rather than buttons that fail.
 * @param {any} st State
 */
export function reviewSupported(st) {
  return arr(st?.races).some((rv) => rv && rv.review && typeof rv.review === 'object')
    || arr(st?.config?.races).some((r) => arr(r?.splits).some((s) => typeof s?.sending === 'boolean'));
}

/**
 * The confirm dialog before a time goes out for a runner who has finished (DESIGN 9.17 P4): a split packet's place
 * becomes the runner's place on the outputs that take the race (TrackScore, the live results), so it carries the
 * finish place.
 * @param {any} item
 * @param {ReturnType<typeof rowTime>} row
 * @param {{ outputs: string[], lif: boolean }} dest
 */
export function finishedManualText(item, row, dest) {
  const place = item.finishPlace ?? '?';
  const names = outsText(dest);
  return {
    title: `Send bib ${item.bib}'s ${item.splitName} with the finish place?`,
    body: [
      `Bib ${item.bib} has finished${item.finishPlace != null ? ` (place ${item.finishPlace})` : ''}. ${names
        ? `${names} ${oneOut(dest) ? 'takes' : 'take'} the place in a split packet as the runner's place, so this split goes with place ${place}, the finish place, and ${names} ${oneOut(dest) ? 'keeps' : 'keep'} it.`
        : `A split packet's place is taken as the runner's place, so this split goes with place ${place}, the finish place.`}`,
      `${item.splitName} ${row.text} (${row.typed ? 'a time you typed' : 'made-up'}) goes ${sendsTo(dest)}.${pausedNote(dest, item.splitId)}`,
      finishPlaceSplitNote(item.splitName, item.finishPlace, dest),
    ].filter(Boolean),
    confirm: 'Send it',
  };
}

/**
 * DESIGN 9.17 P4 (revision 10, R5): a packet carries one place, so a split sent with the finish place also gives the
 * outputs that take the race (TrackScore when not said) that place as the runner's place at that split; '' when no
 * output takes the race.
 * @param {string} split
 * @param {number|null} [place]
 * @param {{ outputs?: string[] }} [dest]
 */
export function finishPlaceSplitNote(split, place = null, dest = undefined) {
  const names = dest === undefined ? 'TrackScore' : outsText(dest);
  if (!names) return '';
  return `${names} also ${dest === undefined || oneOut(dest) ? 'shows' : 'show'} ${place != null ? `place ${place}` : 'the finish place'} as the runner's place at ${split || 'that split'}: a split packet carries only one place.`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The control room view: status lights, the Needs attention list, the setup checklist, the navigation badges. */

/** The short word a feed row shows beside its status dot. The full word and what it means are in its tooltip. */
export const SHORT_STATUS = {
  sent: 'Sent', held: 'Holding', ready: 'Not sent', corrected: 'Corrected', 'made-up': 'Made-up', typed: 'Typed',
  finish: 'Finish', 'finished-not-sent': 'Finished', 'split-paused': 'Paused', 'check-column': 'Check', 'not-sending': 'Not sending', 'not-in-race': 'Not in race', counted: 'Counted',
  backup: 'Backup', duplicate: 'Duplicate', repeat: 'Repeat', 'start-area': 'Start area', 'after-finish': 'After finish',
  'out-of-order': 'Out of order', extra: 'Extra pass', ignored: 'Not a split', 'too-early': 'Too early', 'waiting-gun': 'No gun yet',
  'before-gun': 'Before gun', unmapped: 'Unmapped', 'no-race': 'No race', 'set-aside': 'Set aside', paused: 'Race paused',
  'race-missing': 'Race missing', 'race-deleted': 'Race deleted', cleared: 'Cleared', 'bad-line': 'Bad line',
};

/** @param {string} status @returns {string} */
export const shortStatus = (status) => SHORT_STATUS[status] || SHORT_STATUS[STATUS_ALIASES[status]] || statusInfo(status).label;

/**
 * A warning's one-line headline for the Needs attention list: its title, else its first sentence. The whole text is
 * the row's detail.
 * @param {{ title?: string, text?: string }} w
 */
export function warningTitle(w) {
  const t = str(w?.title).trim();
  if (t) return t;
  const text = str(w?.text).trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] || text;
  const one = first.replace(/[.]$/, '');
  return one.length > 96 ? `${one.slice(0, 93).replace(/\s+\S*$/, '')}…` : one;
}

/** Red first, then amber, then the decisions (a choice, not a fault), then the notes. */
export const TONE_RANK = { bad: 0, warn: 1, decide: 2, info: 3, muted: 4 };
const rankOf = (w) => (w.decision ? TONE_RANK.decide : TONE_RANK[w.tone] ?? 4);

/**
 * TrackScore shows one race at a time: when other races run, which one it shows is the operator's choice. One line per
 * output for all of them ("TrackScore shows Girls 5K · Boys 5K also running"), with Switch (asks first) and Keep, in
 * place of a warning per race. `sig` changes when the races running change, so a Keep lasts until then.
 * @param {any} st State
 * @param {any} o Output config
 * @param {{ id: string, name: string }[]} others the running races it does not get
 */
export function outputDecision(st, o, others) {
  const name = str(o?.name) || 'TrackScore';
  const shows = arr(o?.races).map((rid) => configRace(st, rid)).filter(Boolean);
  const showsText = shows.length ? listText(shows.map((r) => str(r.name) || '(no name)')) : 'no race';
  const names = others.map((r) => r.name);
  const one = others.length === 1;
  return {
    tone: 'info', decision: true, id: 'decide:' + o.id, outputId: o.id,
    sig: JSON.stringify([others.map((r) => r.id).sort(), arr(o?.races).slice().sort()]),
    title: `${name} shows ${showsText} · ${listText(names)} also running`,
    text: `${name} shows one race at a time, and gets ${showsText}. ${listText(names)} ${one ? 'is' : 'are'} running too and ${one ? 'is' : 'are'} not on ${name}. Switch only if ${name} should show another race: it then clears ${shows.length === 1 ? showsText : 'the race it shows'}.`,
    keepLabel: shows.length ? `Keep ${shows.length === 1 ? showsText : 'as it is'}` : 'Keep as it is',
    picker: { outputId: o.id, outputName: name, options: others.map((r) => ({ id: r.id, name: r.name })), selected: others[0]?.id || '', decide: true },
  };
}

/**
 * Everything that needs the operator, in one list: the warnings that are not about a race, then each Active race's,
 * red first, then by how long they have lasted. One line per cause: a race's "RR12 not connected on port 5826" is said
 * by the port's own line, and every "TrackScore isn't getting this race" becomes one decision per output
 * (outputDecision). Each item keeps its warning (text, action, more, picker) and gets a key that stays the same while
 * the problem is there (its numbers may change), so an opened row stays open.
 * @param {any} st State
 * @param {number} nowMs
 * @param {any[]} [feed]
 * @param {{ downSince?: Map<string, number>, kept?: Map<string, string>, namesOffer?: any }} [opts] kept: the decisions the
 *   operator answered "Keep" to (output id -> its sig); namesOffer: the "Send names now" offer this page keeps
 *   (namesOfferFor, DESIGN 9.20 N3)
 * @returns {(Warning & { key: string, raceId: string|null, raceName: string })[]}
 */
export function attentionItems(st, nowMs, feed = [], opts = {}) {
  const keyOf = (scope, w) => {
    if (w.id) return `${scope}|${w.id}`;
    const a = w.action || {};
    const what = a.href || [a.cmd, a.raceId, a.outputId, a.value].filter(Boolean).join(':') || (w.picker ? `pick:${w.picker.outputId}` : '');
    return `${scope}|${what}|${warningTitle(w).replace(/[\d,.:]+/g, '#')}`;
  };
  const items = [];
  const global = globalWarnings(st, nowMs, feed, opts);
  global.forEach((w, i) => items.push({ ...w, key: keyOf('g', w), raceId: null, raceName: '', order: i }));
  const offPorts = new Set(global.flatMap((w) => arr(w.ports).map(Number)));
  /** @type {Map<string, { id: string, name: string }[]>} */
  const notOn = new Map();
  arr(st?.config?.races).filter((r) => r && r.active !== false).forEach((r, ri) => {
    raceWarnings(viewOf(st, r.id), r, st, nowMs, feed).forEach((w, i) => {
      if (w.port != null && offPorts.has(Number(w.port))) return;
      if (w.action?.cmd === 'output-race' && w.outputId) {
        if (!notOn.has(w.outputId)) notOn.set(w.outputId, []);
        notOn.get(w.outputId).push({ id: r.id, name: str(r.name) || '(no name)' });
        return;
      }
      items.push({ ...w, key: keyOf(`r:${r.id}`, w), raceId: r.id, raceName: str(r.name) || '(no name)', order: 1000 + ri * 100 + i });
    });
  });
  // DESIGN 9.20 N3: the names came in after a race's splits went out: "Send names now", once per file
  namesOfferItems(st, opts.namesOffer).forEach((w, i) => {
    const r = configRace(st, w.action.raceId);
    items.push({ ...w, key: keyOf(`r:${r.id}`, w), raceId: r.id, raceName: str(r.name) || '(no name)', order: 950 + i });
  });
  for (const [oid, others] of notOn) {
    const o = configOutput(st, oid);
    if (!o) continue;
    const d = outputDecision(st, o, others);
    if (opts.kept?.get(oid) === d.sig) continue;
    items.push({ ...d, key: 'g|' + d.id, raceId: null, raceName: '', order: 900 });
  }
  return items.sort((a, b) => rankOf(a) - rankOf(b) || (a.since ?? Infinity) - (b.since ?? Infinity) || a.order - b.order)
    .map(({ order, ...w }) => w);
}

/**
 * One status light per RR12 port (DESIGN 9.15 L2): green while RR12 is connected, amber while a port that feeds an
 * Active race waits for it, grey for a spare port, red for a port Split Relay can't listen on.
 * @param {any} i State.inputs entry
 * @param {any} st State
 * @param {number} nowMs
 * @returns {{ tone: string, label: string, word: string, title: string }}
 */
export function inputLight(i, st, nowMs) {
  const port = Number(i?.port);
  const races = racesOnPort(arr(st?.config?.races), port);
  const active = races.filter((r) => r.active !== false);
  const n = arr(i?.connections).length;
  const last = toMs(i?.lastLineAt);
  const feeds = races.length ? ` Races: ${listText(races.map((r) => `${r.name || '(no name)'}${r.active === false ? '' : ' (Active)'}`), 4)}.` : ' No race reads from it yet.';
  const label = `RR12 ${port}`;
  if (i?.error) return { tone: 'bad', label, word: 'Problem', title: `RR12 port ${port}: ${i.error}` };
  if (i?.listening === false) return { tone: 'bad', label, word: 'Not listening', title: `Split Relay isn't listening on RR12 port ${port}.` };
  if (n) {
    return { tone: 'ok', label, word: 'Receiving',
      title: `RR12 port ${port}: receiving, ${plural(n, 'connection')}, ${last ? `last read ${formatAgo(nowMs - last)}` : 'no reads yet'}.${feeds}` };
  }
  // the same colours as Needs attention: red once a race on it has started (rrNotConnected)
  const started = active.some((r) => gunGone(viewOf(st, r.id), st, nowMs));
  return { tone: !active.length ? 'muted' : started ? 'bad' : 'warn', label, word: active.length ? 'Not connected' : 'Waiting',
    title: `RR12 port ${port}: ${active.length ? 'not connected' : 'waiting for RR12 (no Active race reads from it)'}.${feeds}` };
}

/**
 * Lines said as one text, each ending in one full stop: what a screen reader says for a status light ("RR12 5842.
 * Receiving. Click to open its page."), never "..".
 * @param {string[]} parts
 */
export function sentences(parts) {
  return arr(parts).map((p) => str(p).trim()).filter(Boolean).map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`)).join(' ');
}

/** The kinds of lights in the status strip, in its order. Only RR12 ports and outputs are ever many. */
export const STRIP_KINDS = {
  in: { name: 'In', title: 'RR12 ports', noun: 'port', href: '#inputs', page: 'Inputs', group: true },
  out: { name: 'Out', title: 'Outputs', noun: 'output', href: '#outputs', page: 'Outputs', group: true },
  files: { name: 'Files', title: 'Files', noun: 'file', href: '#settings', page: 'Settings', group: false },
};

/**
 * How the status strip fits the bar, roomiest first: every light in full; short names (the port number, a long
 * output name cut short); then dot and short name only (the words go to the popover); then the kind with the most
 * lights becomes one light with a dot per light and a count ("IN ●●● 3 ports"), then the next kind; last, without
 * the IN / OUT / FILES labels (a phone). The page uses the first that fits; when none does, the strip wraps onto a
 * second line, so no light is ever cut off.
 * @param {{ kind: string, count: number }[]} groups
 * @returns {{ short: boolean, bare: boolean, grouped: string[], tight: boolean }[]}
 */
export function stripPlans(groups) {
  const plan = (short, bare, grouped = [], tight = false) => ({ short, bare, grouped, tight });
  const plans = [plan(false, false), plan(true, false), plan(true, true)];
  const order = arr(groups).filter((g) => STRIP_KINDS[g?.kind]?.group && g.count > 1).sort((a, b) => b.count - a.count);
  order.forEach((g, i) => plans.push(plan(true, true, order.slice(0, i + 1).map((x) => x.kind))));
  plans.push(plan(true, true, order.map((x) => x.kind), true));
  return plans;
}

const LIGHT_RANK = { muted: 0, ok: 1, info: 2, warn: 3, bad: 4 };

/** A group's colour is its worst light's: red, then amber, then green; grey only when every light is grey. */
export function groupTone(tones) {
  return arr(tones).reduce((w, t) => ((LIGHT_RANK[t] ?? 0) > LIGHT_RANK[w] ? t : w), 'muted');
}

/**
 * One light standing for every light of a kind when the strip is short of room: a dot per light in its colour, the
 * count, and in its popover each light with its word.
 * @param {'in'|'out'} kind
 * @param {{ label: string, tone: string, state: string }[]} items
 * @returns {{ tone: string, href: string, text: string, pop: string[] }}
 */
export function lightGroupSummary(kind, items) {
  const k = STRIP_KINDS[kind] || STRIP_KINDS.out;
  const list = arr(items);
  // the heading counts the lights by their word, the worst first: "RR12 ports · 1 not connected · 2 receiving"
  const byWord = new Map();
  for (const x of list) {
    const w = str(x.state) || 'OK';
    const e = byWord.get(w) || { n: 0, rank: LIGHT_RANK[x.tone] ?? 0 };
    e.n++;
    e.rank = Math.max(e.rank, LIGHT_RANK[x.tone] ?? 0);
    byWord.set(w, e);
  }
  const counts = [...byWord].sort((a, b) => b[1].rank - a[1].rank).map(([w, e]) => `${fmtInt(e.n)} ${w}`);
  return {
    tone: groupTone(list.map((x) => x.tone)),
    href: k.href,
    text: plural(list.length, k.noun),
    pop: [[k.title, ...counts].join(' · '), ...list.map((x) => `${x.label} · ${str(x.state) || 'OK'}`), `Click to open the ${k.page} page.`],
  };
}

/**
 * The first-run checklist: what a meet needs once, each step ticked from what Split Relay reports.
 * @param {any} st State
 * @returns {{ key: 'rr12'|'outputs'|'names'|'lif'|'race', title: string, done: boolean }[]}
 */
export function setupSteps(st) {
  const ins = inputsOf(st);
  const lif = st?.config?.lif || {};
  const ppl = str(st?.config?.names?.pplPath).trim();
  return [
    // first (DESIGN 9.22 M10): a meet file saved last time, or TrackScore's Race Setup, sets the races up in one go
    { key: 'race', title: 'Load the meet setup, or add the races', done: arr(st?.config?.races).length > 0 },
    { key: 'rr12', title: 'Connect the RR12 exporter', done: ins.some((i) => arr(i.connections).length > 0 || Number(i.totalLines) > 0) },
    { key: 'outputs', title: 'Add TrackScore and the live results', done: arr(st?.config?.outputs).length > 0 },
    { key: 'names', title: "Choose the meet's names file (.ppl)", done: !!ppl && st?.names?.loaded !== false && !st?.names?.error },
    { key: 'lif', title: 'Set the merged .lif folders', done: !!lif.enabled && !!str(lif.inputDir).trim() && !!str(lif.outputDir).trim() },
  ];
}

/* ---------- meet setup (DESIGN 9.22): save, load, set up from TrackScore, start a new meet ---------- */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-21" on this PC's clock: the name Save meet setup gives a meet with no name. */
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** "Tue 14 Oct 15:02" (with the year when it is another year's), on this PC's clock. */
export function dayTimeText(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const y = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${y} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The meet file a drop or the file chooser brought: the first .json, else the first file the browser calls JSON.
 * @param {ArrayLike<{ name?: string, type?: string }> | null | undefined} fileList
 */
export function pickMeetFile(fileList) {
  const files = Array.from(fileList ?? []);
  return files.find((f) => /\.json$/i.test(str(f?.name))) || files.find((f) => /^application\/json/i.test(str(f?.type))) || null;
}

/**
 * DESIGN 9.25: the entry files among the files chosen or dropped: text files (.txt, .csv, .tsv), one per event, named by
 * the event number. Never a meet file (.json).
 */
export function pickEntryFiles(fileList) {
  return Array.from(fileList ?? []).filter((f) => f && !/\.json$/i.test(str(f.name)) && (/\.(txt|csv|tsv)$/i.test(str(f.name)) || /^text\//i.test(str(f.type))));
}

/** An entry file's bytes as text: UTF-8 when they are valid UTF-8, else Windows-1252 (what most exports write); a BOM is dropped. */
export function decodeEntryBytes(bytes) {
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    s = new TextDecoder('windows-1252').decode(bytes);
  }
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Entry files in requests of at most `max` characters of text each (Split Relay takes 1 MB a request). */
export function entryBatches(files, max = 600000) {
  const out = [];
  let size = 0;
  for (const f of arr(files)) {
    const n = str(f.text).length;
    if (!out.length || size + n > max) {
      out.push([]);
      size = 0;
    }
    out[out.length - 1].push(f);
    size += n;
  }
  return out;
}

/**
 * DESIGN 9.25, the Races page's start lists as lines: each event that has one ("Men's 8K: 108 entered, from 1.txt"; one
 * that is not used for its race says so; one no race has: "Event 7: 2 entered, from 7.txt (no race here has event 7)"),
 * then, once any is loaded, each race without one ("JV Boys: no start list").
 * @param {any} st State (startLists: { events, without }; races: their startList.warn)
 */
export function startListLines(st) {
  const sl = st?.startLists;
  const today = localDay(toMs(st?.now) ?? Date.now());
  const out = [];
  for (const e of arr(sl?.events)) {
    const races = arr(e.races);
    const names = races.map((r) => str(r.name)).filter(Boolean);
    const unused = races.map((r) => viewOf(st, r.id)).find((v) => str(v?.startList?.warn).trim());
    const n = Number(e.entered) || 0;
    const loaded = toMs(e.loadedAt) != null && localDay(toMs(e.loadedAt)) !== today ? `, loaded ${localDay(toMs(e.loadedAt))}` : '';
    out.push({ key: `e-${e.event}`, event: str(e.event), name: names.length ? listText(names) : `Event ${e.event}`, entered: n, file: str(e.file),
      text: `${fmtInt(n)} entered, from ${str(e.file)}${loaded}${names.length ? '' : ` (no race here has event ${e.event})`}${unused ? ': not used' : ''}`,
      tone: unused ? 'warn' : names.length ? '' : 'muted', title: unused ? str(unused.startList.warn).trim() : '', removable: true });
  }
  if (out.length) for (const r of arr(sl?.without)) out.push({ key: `r-${r.id}`, event: '', name: str(r.name) || '(no name)', entered: 0, file: '', text: 'no start list', tone: 'muted', title: '', removable: false });
  return out;
}

/**
 * DESIGN 9.25: what a load of entry files did, for the toast: one sentence per file, then what it did to the boards.
 * @param {{ results?: { text: string }[], notes?: string[], resent?: number, held?: any[] }} load
 */
export function startListLoadText(load) {
  const parts = [...arr(load?.results).map((r) => str(r.text).trim()), ...arr(load?.notes).map((n) => str(n).trim())].filter(Boolean);
  const held = arr(load?.held);
  if (held.length) parts.push(`The boards still show ${plural(held.length, 'line')} of ${held.length === 1 ? 'an athlete who is' : 'athletes who are'} not in the race (sent before): Review, Not in this race.`);
  const n = Number(load?.resent) || 0;
  if (n > 0) parts.push(`${plural(n, 'line')} of other runners re-sent with ${n === 1 ? 'its' : 'their'} new place${n === 1 ? '' : 's'}.`);
  return parts.join(' ');
}

/** When a saved meet was saved: its own date (savedAt), else its file's. */
const savedAtOf = (f) => Date.parse(str(f?.savedAt)) || (Number.isFinite(f?.mtimeMs) ? f.mtimeMs : NaN);

/**
 * A saved meet's name in the lists: its meet name, or, for the copy kept before the last load (R14), "Before the load
 * at 15:02".
 * @param {any} f GET /api/meet/files entry
 */
export function savedMeetName(f, now = Date.now()) {
  if (f?.beforeLoad) {
    const at = savedAtOf(f);
    const when = modifiedText(at, now).replace(/^modified /, '');
    return `Before the load ${/^today /.test(when) ? `at ${when.slice(6)}` : /^yesterday /.test(when) ? `yesterday at ${when.slice(10)}` : `on ${when}`}`;
  }
  return str(f?.name) || str(f?.fileName).replace(/\.json$/i, '');
}

/** "2 races · saved today 15:02", or "can't be read as a meet file". @param {any} f GET /api/meet/files entry */
export function savedMeetText(f, now = Date.now()) {
  if (!f || f.error) return "can't be read as a meet file";
  const at = savedAtOf(f);
  return [plural(Number(f.races) || 0, 'race'), Number.isFinite(at) ? modifiedText(at, now).replace(/^modified/, 'saved') : ''].filter(Boolean).join(' · ');
}

/**
 * The meets saved here that the one-click offers show, newest first: not the copy kept before a load, not a file that
 * can't be read, not a meet with no races (O23: an empty setup saved by mistake must not become the gold button).
 */
export const savedMeets = (files) => arr(files).filter((f) => f && !f.error && !f.beforeLoad && Number(f.races) > 0);

/**
 * Where Set up from TrackScore reads TrackScore (the server does it the same way, src/meet.js trackScoreHost): the host
 * of the TrackScore output, else this PC; the web port of Settings → Meet setup.
 * @param {any} st State
 */
export function trackScoreAt(st) {
  const outs = arr(st?.config?.outputs).filter((o) => o && o.mode !== 'tcp-server' && !str(o.mid).trim() && !/karmarush/i.test(str(o.script)));
  const o = outs.find((x) => /trackscore|xcscore/i.test(`${str(x.name)} ${str(x.script)}`)) || outs.find((x) => Number(x.port) === 5555) || null;
  const host = !o || !str(o.host).trim() || /^localhost$/i.test(str(o.host).trim()) ? '127.0.0.1' : str(o.host).trim();
  return { host, port: Number(st?.config?.meet?.trackScoreWebPort) || 5000, outputName: o ? str(o.name) : null };
}

const TONE_WORD = { bad: 'Problem', warn: 'Check', info: 'Note' };

/**
 * The meet preview dialog (DESIGN 9.22 M3), in words: the server says what each line is; this puts the lines in their
 * sections and words the head and the buttons. openMeetPreview only draws it.
 * @param {any} p MeetPreview (POST /api/meet/preview)
 * @param {{ notes?: { text: string, tone?: string, raceId?: string }[], now?: number }} [opts] notes: this page's own
 *   (an unsaved form the load changes)
 * @returns {{ title: string, sourceLine: string, banner: string, sections: { key: string, title: string,
 *   lines: { text: string, tone: string, word: string, raceId: string, href: string }[] }[], removeLabel: string,
 *   applyLabel: string, applyPrimary: boolean, applyShown: boolean, applyDisabled: boolean, cancelLabel: string,
 *   nothingLine: string, nothingTone: 'info'|'warn', footer: string, trackscore: boolean }}
 */
export function meetPreviewView(p, { notes = [], now = Date.now() } = {}) {
  const ts = p?.mode === 'trackscore';
  const src = p?.source || {};
  let sourceLine;
  // O2: the copy kept before a load is named as the list names it, never by its file
  const undo = !ts && !!(p?.undo || src.beforeLoad);
  if (src.kind === 'trackscore') {
    const races = Number(src.races) || 0;
    // O36 (O14): boards that show a race not in the list TrackScore sent say so here too, as the Problem line below does
    const elsewhere = typeof src.shownElsewhere === 'string' ? src.shownElsewhere : null;
    const showing = src.liveRace ? `showing ${src.liveRace} now`
      : elsewhere !== null ? (elsewhere ? `showing "${elsewhere}", not in this list` : 'showing a race not in this list') : 'not showing a race now';
    sourceLine = [`TrackScore at ${str(src.host)}:${str(src.port)}`, str(src.meetName) ? `meet "${src.meetName}"` : str(src.meetId) ? `meet ${src.meetId}` : '',
      `${plural(races, 'race')} in Race Setup`, showing].filter(Boolean).join(' · ');
  } else {
    const saved = Date.parse(str(src.savedAt));
    const when = Number.isFinite(saved) ? ` · saved ${dayTimeText(saved, now)}${str(src.savedOn) ? ` on ${src.savedOn}` : ''}` : '';
    if (src.kind === 'config') sourceLine = `From ${str(src.fileName) || 'config.json'} (a Split Relay settings file)`;
    else if (src.kind === 'saved') sourceLine = `From data\\meets\\${str(src.fileName).replace(/\//g, '\\')}${when}`;
    else sourceLine = `From ${str(src.fileName) || 'the meet file'}${when}`;
  }
  const line = (i) => ({ text: str(i?.text), tone: str(i?.tone), word: TONE_WORD[i?.tone] || '', raceId: str(i?.raceId), href: str(i?.href) });
  const sections = [
    { key: 'attention', title: 'Needs your attention', lines: [...arr(notes), ...arr(p?.attention)].map(line) },
    { key: 'added', title: 'Added', lines: arr(p?.added).map(line) },
    { key: 'changed', title: 'Changed', lines: [...arr(p?.changed), ...arr(p?.removed)].map(line) },
    { key: 'reads', title: 'What happens to the reads so far', lines: planLines(p?.readsPlan, '').map((text) => ({ text, tone: '', word: '', raceId: '', href: '' })) },
    { key: 'kept', title: 'Left as they are', lines: arr(p?.kept).map(line) },
  ].filter((s) => s.lines.length);
  // R5: reads from an earlier day would become today's splits once the gun is typed: start a new meet first
  let banner = '';
  if (p?.newMeet) {
    const parts = arr(p.newMeet.races).map((r, i) => (i === 0
      ? `${str(r.name)} (${plural(Number(r.reads) || 0, 'read')}${toMs(r.lastReadAt) ? `, last read ${dayTimeText(toMs(r.lastReadAt), now).replace(/ \d\d:\d\d$/, '')}` : ''})`
      : `${str(r.name)} (${fmtInt(r.reads)})`));
    if (Number(p.newMeet.noRace) > 0) parts.push(`${plural(Number(p.newMeet.noRace), 'read')} in no race`);
    banner = `${arr(p.newMeet.races).length ? 'Races here have reads from an earlier day' : 'Split Relay has reads from an earlier day'}: ${listText(parts, 6)}. ` +
      "RR12's reads carry a time of day but no date: once today's gun is typed, they would count as today's splits. A new meet should start empty: start a new meet first, then this preview shows the whole meet.";
  }
  const n = arr(p?.removable).length;
  const when = Number.isFinite(Date.parse(str(src.savedAt))) ? savedMeetName({ beforeLoad: true, savedAt: src.savedAt }, now).replace(/^Before/, 'before') : 'before the last load';
  // O33 (O2): what the load after that copy added stays (R1): while it is here, the setup does not match the copy, and the
  // dialog says what differs and offers the box (Apply once it is ticked), never "Nothing to change" and Close alone
  const left = undo && p?.leftover ? p.leftover : null;
  const outs = arr(left?.outputs).map(str);
  const ports = arr(left?.ports).map(String);
  const leftWords = listText([...arr(left?.races).map(str), outs.length ? `the output${outs.length === 1 ? '' : 's'} ${listText(outs)}` : '',
    ports.length ? `RR12 ${ports.length === 1 ? 'port' : 'ports'} ${listText(ports)}` : ''], 8);
  let nothingLine = '';
  if (p?.nothing && leftWords) {
    nothingLine = `The setup is not as it was ${when}: what the load added is still here (${leftWords}). ` +
      (n ? `Tick the box above to remove ${n === 1 ? 'the race' : 'the races'} with no reads, then Apply.` : 'Putting that copy back does not remove it: see above.');
  } else if (p?.nothing) {
    nothingLine = undo ? `Nothing to change: the setup is already as it was ${when}.`
      : `Nothing to change: the setup already matches ${ts ? "TrackScore's Race Setup" : str(p.title) || 'the meet file'}.`;
  }
  // in the nothing state, Apply waits for the box (it is the one change left); with no box there is nothing to apply
  const applyShown = !p?.nothing || !!(leftWords && n);
  return {
    title: ts ? 'Set up from TrackScore' : undo ? `Back to the setup ${when}` : `Load meet: ${str(p?.title) || 'meet file'}`,
    sourceLine,
    banner,
    sections,
    removeLabel: n ? `Also remove ${plural(n, 'race')} that ${n === 1 ? 'is' : 'are'} not in ${ts ? "TrackScore's meet" : undo ? 'that copy' : 'the file'} and ${n === 1 ? 'has' : 'have'} no reads: ${listText(arr(p.removable).map((r) => str(r.name)), 6)}` : '',
    applyLabel: p?.newMeet ? 'Apply anyway (keep the old reads)' : 'Apply',
    // O14: TrackScore could not show it is this meet: Apply is not the gold button
    applyPrimary: !p?.newMeet && !(ts && src.confirmed === false),
    applyShown,
    applyDisabled: applyShown && !!p?.nothing,
    cancelLabel: applyShown ? 'Cancel' : 'Close',
    nothingLine,
    nothingTone: p?.nothing && leftWords ? 'warn' : 'info',
    footer: 'Nothing is sent to TrackScore or the live results by this. Gun times are never loaded: you type them on race day.',
    trackscore: ts,
  };
}

/**
 * The toast after a meet load (POST /api/meet/apply's `applied`).
 * @returns {{ text: string, tone: 'ok'|'info' }}
 */
export function meetAppliedText(a, now = Date.now()) {
  const ts = a?.mode === 'trackscore';
  // O33: the copy kept before a load puts the setup back; it is not a meet file "loaded"
  const undoAt = !ts && a?.undo ? toMs(a.undo.at) : null;
  const back = !ts && a?.undo ? (undoAt ? savedMeetName({ beforeLoad: true, mtimeMs: undoAt }, now).replace(/^Before/, 'before') : 'before the last load') : '';
  if (a?.nothing) {
    return { text: back ? `Nothing to put back: the setup is already as it was ${back}.`
      : `The setup already matches ${ts ? "TrackScore's Race Setup" : str(a.name) || 'the meet file'}.`, tone: 'info' };
  }
  const n = (k) => Number(a?.[k]) || 0;
  // O27: races, outputs and settings counted apart (an older server sends only "changed")
  const byKind = a?.racesChanged !== undefined;
  const settings = arr(a?.settings).map(str).filter(Boolean);
  const racesChanged = byKind ? n('racesChanged') : n('changed');
  const counts = ts
    ? [n('added') ? `${fmtInt(n('added'))} added` : '', racesChanged ? `${fmtInt(racesChanged)} changed` : '', n('removed') ? `${fmtInt(n('removed'))} removed` : '']
    : [n('added') ? `${plural(n('added'), 'race')} added` : '', racesChanged ? (byKind ? `${plural(racesChanged, 'race')} changed` : `${fmtInt(racesChanged)} changed`) : '',
      n('removed') ? `${plural(n('removed'), 'race')} removed` : '',
      n('outputsAdded') ? `${plural(n('outputsAdded'), 'output')} added` : '', byKind && n('outputsChanged') ? `${plural(n('outputsChanged'), 'output')} changed` : ''];
  const what = counts.filter(Boolean).join(', ');
  const head = ts ? `Races set up from TrackScore${what ? `: ${what}` : ''}.` : back ? `Setup put back to ${back}${what ? `: ${what}` : ''}.`
    : `${str(a?.name) || 'The meet file'} loaded${what ? `: ${what}` : ''}.`;
  const set = settings.length ? ` ${settings.length === 1 && settings[0] === 'Meet name' ? 'The meet name is set.' : `Settings changed: ${listText(settings)}.`}` : '';
  // O6: only outputs that came in off although the file had them on, or did not say
  const off = arr(a?.outputsOff);
  const offText = off.length ? ` ${listText(off)} came in switched off: switch ${off.length === 1 ? 'it' : 'them'} on in Outputs when you mean to.` : '';
  // O5: a file from the file chooser or a drop is one click next time
  const kept = str(a?.keptAs) ? ` It is kept in data\\meets as ${str(a.keptAs)}: next time it is one click.` : '';
  const before = a?.beforeLoad ? ` The setup before this load is saved (Settings → Meet setup → ${savedMeetName({ beforeLoad: true, mtimeMs: a.beforeLoad.at }, now)}).` : '';
  return { text: `${head}${set} Nothing was sent.${offText}${kept}${before}`, tone: 'ok' };
}

/**
 * The toast when Save meet setup could not first save what was typed in Settings → Meet setup (O22, O35): what was wrong
 * there, in the form's own words (the meet name, TrackScore's web port, or the server's answer), never "the meet name"
 * for a wrong web port.
 * @param {unknown} errors the form's errors
 */
export function meetSettingsNotSavedText(errors) {
  const errs = arr(errors).map((e) => str(e).trim()).filter(Boolean).map((e) => (/[.!?]$/.test(e) ? e : `${e}.`));
  return errs.length ? `The meet settings were not saved: ${errs.join(' ')} The meet file was not saved either. See Settings → Meet setup.`
    : 'The meet settings were not saved, so the meet file was not either. See Settings → Meet setup.';
}

/** The last read of any race, for the new-meet dialog: { at, name } or null. @param {any} st State */
function lastReadOf(st) {
  let last = null;
  for (const v of arr(st?.races)) {
    const at = toMs(v?.lastReadAt);
    if (at && (!last || at > last.at)) last = { at, name: str(v.name) };
  }
  return last;
}

/**
 * The words of "Start a new meet?" (DESIGN 9.22 M9): what is put away, what stays, and what still matters for the next
 * meet (FinishLynx's folder and Karmarush's meet number stay as they are).
 * @param {any} st State
 * @returns {string[]} paragraphs: the first ones show, the rest under Details (open: it is a risky action)
 */
export function newMeetText(st, now = Date.now()) {
  const views = arr(st?.races);
  const withReads = views.filter((v) => toMs(v?.lastReadAt));
  const reads = views.reduce((n, v) => n + arr(v?.contestsSeen).reduce((m, c) => m + (Number(c?.count) || 0), 0), 0) +
    arr(st?.noRace).reduce((n, e) => n + (Number(e?.count) || 0), 0);
  const last = lastReadOf(st);
  const lastWhen = last ? modifiedText(last.at, now).replace(/^modified /, '').replace(/^(today|yesterday) /, '$1 at ') : '';
  const out = [
    reads > 0
      ? `Split Relay puts away the reads of every race (${plural(withReads.length, 'race')}, ${plural(reads, 'read')}${lastWhen ? `, the last ${lastWhen}` : ''}) and clears every gun time and every Pause. The races, outputs and settings stay.`
      : 'No race has reads. Split Relay clears every gun time and every Pause. The races, outputs and settings stay.',
    'A copy of the data folder goes to data\\archive first. Nothing is deleted, and nothing is sent to TrackScore or the live results.',
  ];
  const lynx = str(st?.config?.lif?.inputDir).trim();
  if (lynx) out.push(`FinishLynx's folder ${lynx} stays. If it still has last meet's results, their finishers get no splits today: point it at this meet's folder (Settings → Merged .lif files).`);
  const kr = arr(st?.config?.outputs).filter((o) => str(o?.mid).trim() || /karmarush/i.test(str(o?.script)));
  if (kr.length) out.push(`Check ${listText(kr.map((o) => str(o.name)))}'s meet number (MID) for the new meet (Outputs).`);
  if (st?.config?.lif?.enabled) out.push("The merged .lif files already written stay as they are (copies go to the archive too). Once FinishLynx writes this meet's files, they are merged with this meet's splits only.");
  out.push('The reads stay in data\\reads.jsonl, out of use, as after Clear race data. An RR12 Replay of an old race would bring its reads back.');
  return out;
}

/**
 * Why Start a new meet can't be done now, or '' (DESIGN 9.22 M9, O28): a race is running. The words and the rule are
 * Split Relay's own (src/meet.js raceRunning, main.js #refuseWhileRunning): Active with a gun, and its clock under 30
 * minutes (a gun typed a moment ago, before the first read) or a read in the last 20 minutes.
 * @param {any} st State
 */
export function newMeetBlocker(st, now = Date.now()) {
  for (const r of arr(st?.config?.races)) {
    if (!r || !str(r.gun).trim()) continue;
    const rv = viewOf(st, r.id);
    if (!isRunning(rv, r, st, now)) continue;
    const last = toMs(rv?.lastReadAt);
    const recent = last != null && now - last < RUNNING_READ_MS;
    const d = new Date(last ?? 0);
    const when = recent ? `last read ${pad(d.getHours())}:${pad(d.getMinutes())}` : `gun ${str(r.gun).trim()}`;
    return `${str(r.name)} is running (${when}). Start a new meet once it is over, or turn off its Active (on its page) first.`;
  }
  return '';
}

/** The red line of "Start a new meet?" when a read came in the last 10 minutes, else ''. @param {any} st State */
export function newMeetRecent(st, now = Date.now()) {
  const last = lastReadOf(st);
  if (!last || now - last.at > 10 * 60_000) return '';
  const mins = Math.max(0, Math.round((now - last.at) / 60_000));
  return `A read came in ${mins < 1 ? 'less than a minute' : plural(mins, 'minute')} ago (${last.name}). If a race is running, don't start a new meet now.`;
}

/**
 * Where JSON.parse stopped in a hand-edited meet file (O10): "line 12, column 5", or ''.
 * @param {string} text
 * @param {unknown} err
 */
export function jsonErrorWhere(text, err) {
  const msg = str(err?.message ?? err);
  const src = str(text);
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  if (lc) return `line ${lc[1]}, column ${lc[2]}`;
  let pos = -1;
  const p = /position (\d+)/i.exec(msg);
  if (p) pos = Number(p[1]);
  else {
    // Chrome and Node: Unexpected token '}', ..."races": [}" is not valid JSON (10 characters before the token, when cut)
    const m = /^Unexpected token '([\s\S])', (\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/.exec(msg);
    const at = m ? src.indexOf(m[3]) : -1;
    if (at >= 0) {
      const k = m[3].indexOf(m[1], m[2] ? Math.min(10, m[3].length - 1) : 0);
      if (k >= 0) pos = at + k;
    }
  }
  if (pos < 0) return '';
  const lines = src.slice(0, pos).split('\n');
  return `line ${lines.length}, column ${lines.at(-1).length + 1}`;
}

/**
 * What waits in Review across all races (the navigation badge): checks, missing splits, finishers' splits not sent.
 * @param {any} st State
 */
export function reviewTotals(st) {
  const t = { missing: 0, estimable: 0, checks: 0, manual: 0, finishedNotSent: 0, known: false };
  for (const rv of arr(st?.races)) {
    const c = reviewCounts(rv);
    if (!c.known) continue;
    t.known = true;
    for (const k of ['missing', 'estimable', 'checks', 'manual', 'finishedNotSent', 'flagged']) t[k] = (t[k] ?? 0) + c[k];
  }
  return { ...t, total: t.missing + t.checks + t.finishedNotSent + (t.flagged ?? 0), tone: reviewTone(t) };
}

/** The race Review opens on: the first Active race with something to do, else the first Active race, else the first. */
export function defaultReviewRace(st) {
  const races = arr(st?.config?.races);
  const busy = (r) => {
    const c = reviewCounts(viewOf(st, r.id));
    return c.checks + c.missing + c.finishedNotSent > 0;
  };
  return (races.find((r) => r.active !== false && busy(r)) || races.find(busy) || races.find((r) => r.active !== false) || races[0])?.id || '';
}

/* ============================================================================================================ */
/* Browser side. Nothing below runs until boot().                                                               */

const NEW = '__new';
const enc = encodeURIComponent;
const LOOPBACK = (host) => /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host);


/** Everything the page knows. One object so the console can show it: `window.splitRelay`. */
const S = {
  state: null,
  skew: 0,
  conn: 'connecting',
  lostSince: 0,
  lastMsgAt: 0,
  es: null,
  retryTimer: 0,
  retryDelay: 1000,
  feed: new FeedStore(),
  // the feed starts over from the next GET /api/state started after the stream (re)opened (feedEpoch counts opens)
  feedNeedsReset: true,
  feedEpoch: 0,
  feedResetStamp: 0,
  route: { tab: 'live', id: '', focus: '' },
  // FinishLynx's start for the gun box the "differs from the FinishLynx start" warning opens: { id, text, at }
  gunPrefill: null,
  lastRoute: {},
  drafts: new Map(),
  // fallback for a server without RaceView.resendSuggested: the offer this tab makes after its own gun change
  resendOffers: new Map(),
  // "Not now" on a server-driven resend prompt: hidden until what is out of date changes
  offerDismissed: new Map(),
  // "Got it" on the cells a Resend can't correct (DESIGN 9.16 F1): hidden until the count or the runners change
  leftoverDismissed: new Map(),
  // a race whose number or order of splits this tab saved after splits went out: { was, now, reordered }, so the
  // resend prompt can say the splits sent are in the wrong columns (DESIGN 9.15 L6)
  columnChanges: new Map(),
  // "Advanced" sections: the SR line format on the Inputs page (null = open when RR12 sends SR lines), and the race
  // editor's advanced options, per race
  srOpen: null,
  raceAdvanced: new Map(),
  // the race chosen in a "TrackScore gets:" picker, per output, so a repaint keeps it
  pickerChoice: new Map(),
  // the open chip adder's offered names in display order, and what was added while it was open
  adderOrderKey: null,
  adderOrder: [],
  adderAdded: new Set(),
  crossings: new Map(),
  expr: { sig: '', text: '', error: '', loading: false },
  feedFilter: { raceId: '', showFiltered: false, problemsOnly: false, search: '' },
  feedPaused: null,
  // feed rows opened to show their detail (by feed id)
  feedOpen: new Set(),
  // Needs attention: rows opened to show their detail (by item key), and whether the notes (blue) are shown
  attOpen: new Set(),
  showNotes: false,
  // the "?" explanations opened, by key, so a repaint keeps them open
  more: new Set(),
  // the gun box on a Dashboard race tile: { text, error, editing } per race, so a repaint keeps what is typed
  tileGuns: new Map(),
  adder: null,
  focusAfter: null,
  // (9.26) the box named here has its text selected when it gets the focus that way: a stand-in name is typed over
  selectAfter: null,
  pendingFocus: null,
  pointerDown: false,
  pointerDownAt: 0,
  pointerTimer: 0,
  renderQueued: false,
  renderTimer: 0,
  renderAfterPointer: false,
  editorRace: null,
  // the name of the race the editor shows, for "… is no longer in the settings" when it is deleted elsewhere
  editorRaceName: '',
  editorOut: null,
  // the Review page (DESIGN 9.17 P6): its race, the list Split Relay gave, the operator's typed times by row, the rows
  // being sent, and the runner looked up; null until Review is first opened
  review: null,
  reviewFocus: null,
  reviewScroll: false,
  reviewBibRoute: '',
  // splits whose Play this panel pressed and Split Relay has not answered yet ("raceId|splitId"): "Playing…"
  playing: new Set(),
  gun: null,
  viewOnly: false,
  lastTopAt: 0,
  // when this page first saw each output ('out:<id>') or RR12 port ('in:<port>') down: how long, and red after a while
  downSince: new Map(),
  lastDownPaint: 0,
  // "Keep" on a decision (TrackScore shows one race): output id -> the races running when it was kept
  decisionKept: new Map(),
  // Needs attention: every row shown (else the first few), and held still while the pointer is on the race tiles
  attAll: false,
  tilesHover: false,
  attHeldSince: 0,
  // the live feed: how many rows show, and the row the arrow keys are on
  feedLimit: 60,
  feedActive: '',
  // the setup checklist step that opened an editor ('outputs', 'race'): it offers the way back
  fromSetup: '',
  // the status strip's lights by key, kept while a light is folded into its group (so its focus and popover survive)
  lightEls: new Map(),
  // destructive actions whose confirm is open or whose request runs ('race-del:<id>'): a second click does nothing
  confirming: new Set(),
  // the open confirm dialog's item check (confirmDialog's alive), so a State without the item closes it
  confirmOpen: null,
  // the names file (DESIGN 9.20): State.names as last seen (to see the names come in), the file a pick is waiting to
  // hear loaded, and the .ppl files offered from FinishLynx's folder
  namesPrev: null,
  namesToastFor: '',
  pplSug: { sig: '', at: 0, loading: null, list: [] },
  // DESIGN 9.22: the meet files saved in data\meets (GET /api/meet/files), asked again after 20 s while a page shows them
  meetFiles: { at: 0, list: [], dir: '', loading: null },
  // the meet preview open in #dlg-preview: the request it came from (a 409 or the remove tick box asks again)
  meetPreview: null,
};

const nowMs = () => Date.now() + S.skew;

/* ---------- small storage helpers: browser storage is a convenience only, it may be missing ---------- */

function loadPref(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem('splitRelay.' + key) || 'null');
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem('splitRelay.' + key, JSON.stringify(value));
  } catch {
    /* private window or blocked storage: the preference just isn't remembered */
  }
}

/* ---------- DOM ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const PROP_KEYS = new Set(['checked', 'disabled', 'selected', 'hidden', 'readOnly', 'indeterminate', 'open', 'multiple', 'required']);

/**
 * Build an element. Strings become text nodes; nothing is ever parsed as HTML.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} kids
 * @returns {HTMLElement}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'value') value = v;
      else if (PROP_KEYS.has(k)) el[k] = !!v;
      else if (v == null || v === false) continue;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendKids(el, kids);
  // a <select>'s value only sticks once its options exist
  if (value !== undefined) el.value = str(value);
  return el;
}

function appendKids(el, kids) {
  for (const k of kids) {
    if (k == null || k === false || k === true) continue;
    if (Array.isArray(k)) appendKids(el, k);
    else if (k instanceof Node) el.append(k);
    else el.append(document.createTextNode(String(k)));
  }
}

const flat = (nodes) => (Array.isArray(nodes) ? nodes.flat(Infinity) : [nodes]).filter((n) => n instanceof Node || typeof n === 'string');

function regionError(err) {
  console.error(err);
  return h('div', { class: 'region-error', role: 'alert' },
    `This part of the page couldn't be drawn (${err && err.message ? err.message : err}). The rest still works; reload the page (F5) if this stays.`);
}

/**
 * Replace a region's content, keeping keyboard focus and the text cursor on the element with the same data-fk.
 * @param {HTMLElement} container
 * @param {() => any} build
 */
function paint(container, build) {
  const a = document.activeElement;
  let fk = null;
  let sel = null;
  if (a && a !== document.body && container.contains(a)) {
    fk = a.getAttribute('data-fk');
    try {
      if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd];
    } catch { /* inputs like checkboxes have no selection */ }
  }
  let nodes;
  try {
    nodes = build();
  } catch (err) {
    nodes = regionError(err);
  }
  container.replaceChildren(...flat(nodes));
  const want = S.focusAfter || fk;
  if (!want) return;
  const el = container.querySelector(`[data-fk="${CSS.escape(want)}"]`);
  if (!el) return;
  const asked = S.focusAfter === want;
  if (asked) S.focusAfter = null;
  el.focus({ preventScroll: true });
  // 9.26: a split just added comes with a stand-in name ("After 4K"): selected, so typing the real name replaces it
  if (asked && S.selectAfter === want) {
    S.selectAfter = null;
    try { el.select(); } catch { /* not a text input */ }
  }
  if (sel && want === fk && typeof el.setSelectionRange === 'function') {
    try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ }
  }
}

/** paint() only when what the region shows has changed. */
function paintSig(container, sig, build) {
  if (!container || container._sig === sig) return;
  container._sig = sig;
  paint(container, build);
}

function guard(container, fn) {
  try {
    fn();
  } catch (err) {
    if (container) {
      container._sig = undefined;
      container.replaceChildren(regionError(err));
    } else console.error(err);
  }
}

const badge = (text, tone) => h('span', { class: `badge tone-${tone}` }, text);

/** A "3 s ago" that the ticker keeps current. */
function agoSpan(ms, { prefix = '', never = 'never' } = {}) {
  const t = toMs(ms);
  return h('span', { class: 'ago', 'data-ago': t || 0, 'data-prefix': prefix, 'data-never': never },
    t ? prefix + formatAgo(nowMs() - t) : never);
}

/**
 * A status as a coloured dot and its word; the tooltip says what it means.
 * @param {string} status
 * @param {string} [detail]
 * @param {{ short?: boolean, boxed?: boolean }} [opts] short: the feed's short word; boxed: a pill
 */
function statusWord(status, detail, { short = false, boxed = false } = {}) {
  const info = statusInfo(status);
  return h('span', { class: `st tone-${info.tone}${boxed ? ' boxed' : ''}`, title: [short ? info.label : '', info.meaning, detail].filter(Boolean).join(' — ') },
    short ? shortStatus(status) : info.label);
}

/** A small "?" that shows a longer explanation in place. Its open state survives a repaint. @returns {[Node|null, Node|null]} */
function moreParts(key, text, label = 'More about this') {
  if (!text) return [null, null];
  const id = 'more-' + String(key).replace(/[^\w-]/g, '_');
  const open = S.more.has(key);
  const body = h('div', { class: 'more-text', id, hidden: !open }, Array.isArray(text) ? text.map((t) => h('p', {}, t)) : h('p', {}, text));
  const btn = h('button', {
    type: 'button', class: 'more-btn local', 'aria-expanded': String(open), 'aria-controls': id, 'aria-label': label, title: label, 'data-fk': 'mb-' + key,
    onclick: () => {
      const on = !S.more.has(key);
      if (on) S.more.add(key);
      else S.more.delete(key);
      body.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
    },
  }, '?');
  return [btn, body];
}

/**
 * The Needs attention rows: a one-line headline, its one action, and the full words (and any other actions) when
 * opened. Used on the Dashboard (every warning) and on a race's page (that race's).
 * @param {(Warning & { key: string, raceName?: string })[]} items
 * @param {{ showRace?: boolean }} [opts]
 */
function attentionList(items, { showRace = true } = {}) {
  return h('ul', { class: 'att-list' }, items.map((w) => attentionRow(w, showRace)));
}

/** Whether a warning's full words add anything to its headline: if not, its row has nothing to open. */
const detailAdds = (w) => {
  if (w.picker || w.more?.length || w.hint) return true;
  const t = norm(warningTitle(w)).replace(/[.:…]+$/, '');
  const x = norm(w.text);
  return !(x.startsWith(t) && x.length - t.length < 40);
};

function attentionRow(w, showRace) {
  const open = S.attOpen.has(w.key);
  const adds = detailAdds(w);
  const detailId = 'att-d-' + w.key.replace(/[^\w-]/g, '_');
  const flip = () => {
    if (S.attOpen.has(w.key)) S.attOpen.delete(w.key);
    else S.attOpen.add(w.key);
    scheduleRender();
  };
  const toggle = adds ? h('button', { type: 'button', class: 'btn ghost icon-btn small att-toggle local', 'aria-expanded': String(open), 'aria-controls': detailId,
    'aria-label': open ? 'Hide the details' : 'Show the details', title: open ? 'Hide the details' : 'Details', 'data-fk': 'att-t-' + w.key, onclick: flip },
  h('span', { class: 'i i-chevron', 'aria-hidden': 'true' })) : null;
  let main;
  if (w.decision) {
    // TrackScore shows one race: a choice, with Switch (it asks first) and Keep, never a one-click flip
    const p = w.picker;
    main = [p.options.length === 1
      ? h('button', { type: 'button', class: 'btn small', 'data-fk': 'att-sw-' + w.outputId, onclick: (e) => confirmOutputRace(w.outputId, p.options[0].id, e.currentTarget) }, `Switch to ${p.options[0].name}…`)
      : h('button', { type: 'button', class: 'btn small', 'data-fk': 'att-pick-' + w.outputId, onclick: () => { S.attOpen.add(w.key); focusKey('pick-' + w.outputId); } }, 'Choose race…'),
    h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'att-keep-' + w.outputId, title: 'Hide this until the races that are running change', onclick: () => keepDecision(w) }, w.keepLabel)];
  } else if (w.picker) {
    // a race picker is opened in place: its select and button are the action
    main = h('button', { type: 'button', class: 'btn small primary', 'data-fk': 'att-pick-' + w.picker.outputId, onclick: () => {
      S.attOpen.add(w.key);
      focusKey('pick-' + w.picker.outputId);
    } }, 'Choose race…');
  } else main = warningAction(w, w.action);
  const tone = w.decision ? 'decide' : w.tone;
  return h('li', { class: `att tone-${tone}` },
    h('div', { class: 'att-row' },
      h('span', { class: `i i-${w.decision ? 'outputs' : w.tone === 'info' ? 'info' : 'alert'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'att-title', title: w.text },
        h('span', { class: 'sr-only' }, w.decision ? 'To decide: ' : w.tone === 'bad' ? 'Problem: ' : w.tone === 'warn' ? 'Check: ' : 'Note: '),
        warningTitle(w), showRace && w.raceName ? h('span', { class: 'att-race' }, `· ${w.raceName}`) : null),
      h('span', { class: 'att-acts' }, main, toggle)),
    adds ? h('div', { class: 'att-detail', id: detailId, hidden: !open },
      h('p', {}, w.text),
      w.hint ? h('p', { class: 'help' }, w.hint) : null,
      w.picker ? racePicker(w.picker) : null,
      w.more?.length ? h('div', { class: 'row' }, w.more.map((a) => warningAction(w, a))) : null) : null);
}

function warningAction(w, a) {
  if (!a) return null;
  // one key per button (two set-aside contests each have one), so focus comes back to the button that was pressed
  const fk = 'w-' + (a.href || `${a.cmd}-${a.raceId || ''}-${a.outputId || ''}-${a.cmd === 'aside-race' || a.cmd === 'split-play' ? a.value || '' : ''}`);
  if (a.href) {
    // "Set gun time" on the Dashboard opens the race tile's gun box in place, so the operator stays on the Dashboard
    const gun = /^#races\/([^/]+)\/gun$/.exec(a.href);
    const onclick = gun ? (e) => {
      const id = decodeURIComponent(gun[1]);
      if (S.route.tab !== 'live' || configRace(S.state, id)?.active === false) return;
      e.preventDefault();
      openTileGun(id);
    } : null;
    return h('a', { class: 'btn small', href: a.href, 'data-fk': fk + w.text.slice(0, 20), onclick }, a.label);
  }
  const play = a.cmd === 'split-play';
  const danger = a.cmd === 'missing-delete' || a.cmd === 'delete-race';
  // Gold is kept for a red line's fix. On an amber line a gold button would merge with the amber at a distance, so
  // Play and Switch there are outlined (Play with its gold icon). A missing race's Delete is the way out, not the fix.
  const primary = w.tone === 'bad' && !danger && !a.ghost;
  return h('button', { type: 'button', class: 'btn small' + (primary ? ' primary' : '') + (danger ? ' danger' : '') + (play ? ' play-btn' : '') + (a.ghost ? ' ghost' : ''),
    'data-fk': fk, disabled: a.disabled === true, 'aria-busy': a.disabled === true ? 'true' : null, 'aria-disabled': danger ? busyAttr('race-del:' + a.raceId) : null,
    onclick: (e) => runWarning(a, e.currentTarget) },
  play ? h('span', { class: 'i i-play', 'aria-hidden': 'true' }) : null, play ? str(a.label).replace(/^▶\s*/, '') : a.label);
}

/** "Keep Girls 5K" on TrackScore's line: it stays as it is, and the line comes back when the races running change. */
function keepDecision(w) {
  S.decisionKept.set(w.outputId, w.sig);
  savePref('decisionKept', Object.fromEntries(S.decisionKept));
  const o = configOutput(S.state, w.outputId);
  toast(`${o?.name || 'The output'} stays as it is. Needs attention asks again when the races that are running change.`, 'info');
  focusKey('att-h');
  scheduleRender();
}

/**
 * Give an output one race (TrackScore shows one at a time). Always asked first, naming the race it leaves: a click by
 * mistake would change the scoreboard in front of the crowd.
 */
async function confirmOutputRace(outputId, raceId, btn) {
  const o = configOutput(S.state, outputId);
  const r = configRace(S.state, raceId);
  if (!o || !r) return;
  const name = str(o.name) || 'The output';
  const race = str(r.name) || 'that race';
  const all = !arr(o.races).length;
  const leaves = arr(o.races).filter((id) => id !== raceId).map((id) => configRace(S.state, id)?.name).filter(Boolean);
  const ts = isTrackScoreLike(o, outputStatus(S.state, o.id));
  const ok = await confirmDialog({
    title: `Show ${race} on ${name}?`,
    body: [
      all ? `${name} gets every race now. From now on it gets only ${race}.` : `${name} stops getting ${listText(leaves) || 'the race it has'} and gets only ${race}.`,
      ts ? `${name} switches to ${race} with its next split and clears ${leaves.length === 1 ? leaves[0] : 'the race it shows'} from its screen.` : '',
    ],
    confirm: `Switch to ${race}`,
    focusCancel: true,
    back: btn instanceof Element ? btn : null,
  });
  if (ok) await setOutputRace(outputId, raceId, btn);
}

/** One-click fixes offered inside warnings. */
function runWarning(a, btn) {
  if (a.cmd === 'lynx-gun') {
    const rv = viewOf(S.state, a.raceId);
    if (rv && Number.isFinite(rv.lynxStart)) {
      // the gun is only what the operator sets: open the race's gun box with FinishLynx's start in it
      S.gunPrefill = { id: a.raceId, text: formatTod(rv.lynxStart, 4), at: Date.now() };
      location.hash = `#races/${a.raceId}/gun`;
      scheduleRender();
    }
  } else if (a.cmd === 'lynx-name') {
    renameRace(a.raceId, a.value, btn);
  } else if (a.cmd === 'output-race') {
    confirmOutputRace(a.outputId, a.raceId, btn);
  } else if (a.cmd === 'aside-race') {
    newRaceFor(a.value, a.raceName, a);
  } else if (a.cmd === 'missing-delete') {
    deleteMissingRace(a.raceId, btn);
  } else if (a.cmd === 'missing-restore') {
    restoreMissingRace(a.raceId, btn);
  } else if (a.cmd === 'switch') {
    switchToRace(a.raceId, btn);
  } else if (a.cmd === 'keep-race') {
    keepRace(a.raceId, a.raceName, btn);
  } else if (a.cmd === 'delete-race') {
    deleteRace(a.raceId, btn);
  } else if (a.cmd === 'split-play') {
    // the warning goes away once the split plays: focus moves on to the split's own button
    setSplitSending(a.raceId, a.value, true, btn, `${S.route.tab === 'races' ? 'ed' : 'tile'}-pause-${a.value}`);
  } else if (a.cmd === 'choose-ppl') {
    chooseNamesFile(btn);
  } else if (a.cmd === 'send-names') {
    sendNamesNow(a.raceId, btn);
  } else if (a.cmd === 'names-not-now') {
    setNamesOffer(a.raceId, 'dismissed');
    focusKey('att-h');
  }
}

/** "TrackScore gets: [race] [Send only this race]" inside the all-races warning. */
function racePicker(p) {
  const chosen = S.pickerChoice.get(p.outputId);
  const value = p.options.some((o) => o.id === chosen) ? chosen : p.selected;
  const selId = 'pick-' + p.outputId;
  const sel = h('select', { id: selId, 'data-fk': selId, value, onchange: (e) => S.pickerChoice.set(p.outputId, e.target.value) },
    p.options.map((o) => h('option', { value: o.id }, o.name)));
  // a decision (TrackScore shows one race) is an outline button; the red "gets every race" picker is the fix itself
  return h('div', { class: 'row warning-picker' },
    h('label', { for: selId }, p.decide ? `Show on ${p.outputName}:` : `${p.outputName} gets:`), sel,
    h('button', { type: 'button', class: 'btn small' + (p.decide ? '' : ' primary'), 'data-fk': 'pick-go-' + p.outputId, onclick: (e) => confirmOutputRace(p.outputId, sel.value, e.currentTarget) },
      p.decide ? 'Switch…' : 'Send only this race…'));
}

/**
 * Give an element focus back after a dialog: the same element, or, if a repaint replaced it meanwhile, the element
 * that now has its data-fk. A button that was disabled while its request ran must not leave focus on <body>.
 */
export function focusBack(el) {
  if (!el || el === document.body) return;
  let target = el.isConnected ? el : null;
  const fk = el.getAttribute?.('data-fk');
  if (!target && fk) target = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  if (target && typeof target.focus === 'function') target.focus();
}

/* ---------- toasts ---------- */

/**
 * A message at the bottom of the screen, clear of the row buttons on the right. It stays while the pointer or the
 * keyboard is on it, and longer messages stay longer, so it can be read to the end.
 * @param {string} text
 * @param {'ok'|'info'|'warn'|'bad'} [tone]
 * @param {number} [ms] how long it shows (default: by its length)
 * @param {{ action?: { label: string, run: () => void } }} [opts] one button, for the next step ("Review")
 */
function toast(text, tone = 'ok', ms, { action = null } = {}) {
  const box = $('#toasts');
  if (!box) return;
  const icon = tone === 'bad' || tone === 'warn' ? 'alert' : tone === 'info' ? 'info' : 'check';
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    t.remove();
  };
  const start = (d) => {
    clearTimeout(timer);
    timer = setTimeout(close, d);
  };
  const t = h('div', { class: `toast tone-${tone}`, role: tone === 'bad' ? 'alert' : 'status' },
    h('span', { class: `i i-${icon} toast-i`, 'aria-hidden': 'true' }),
    h('span', { class: 'toast-text' }, text),
    action ? h('button', { type: 'button', class: 'btn small toast-act local', onclick: () => { close(); action.run(); } }, action.label) : null,
    h('button', { type: 'button', class: 'toast-x local', 'aria-label': 'Dismiss message', title: 'Dismiss', onclick: close }, h('span', { class: 'i i-close', 'aria-hidden': 'true' })));
  t.addEventListener('pointerenter', () => clearTimeout(timer));
  t.addEventListener('pointerleave', () => start(3000));
  t.addEventListener('focusin', () => clearTimeout(timer));
  t.addEventListener('focusout', () => start(3000));
  box.append(t);
  start(ms ?? Math.max(tone === 'bad' ? 12000 : 6000, str(text).length * 65));
  while (box.children.length > 3) box.firstElementChild.remove();
}

/* ---------- HTTP ---------- */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * One request to the Split Relay API. Throws an ApiError whose message the operator can act on.
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError("Couldn't reach Split Relay. Is it still running? Its window must stay open.", 0);
  }
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    if (res.status === 403) {
      S.viewOnly = true;
      renderBanners();
      throw new ApiError(`This page can only watch from here. Make changes on the Split Relay PC itself (http://localhost:${location.port || 80}/).`, 403);
    }
    // (the whole answer too: a refusal may say more, as 9.23's Undo does with the cells the scoreboards keep)
    throw Object.assign(new ApiError((data && data.error) || `Split Relay answered "${res.status} ${res.statusText}".`, res.status), { data });
  }
  if (text && data === null) throw new ApiError('Split Relay sent an answer this page could not read. Reload the page (F5).', res.status);
  if (method !== 'GET' && S.viewOnly && LOOPBACK(location.hostname)) {
    S.viewOnly = false;
    renderBanners();
  }
  return data;
}

/**
 * Run a request for a button: the button is disabled while it runs and an error becomes a red message.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {EventTarget | null} [btn]
 * @returns {Promise<T | undefined>}
 */
async function act(fn, btn) {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err && err.message ? err.message : String(err), 'bad');
    return undefined;
  } finally {
    if (b) b.disabled = false;
  }
}

/**
 * One destructive action at a time per item: from the click until its request has answered, another click on the same
 * action (a double click, Enter held down, a click while the preview loads) does nothing, and the trigger shows it
 * (aria-disabled, so it keeps the focus the dialog gives back). The action itself checks that its item still exists
 * before it asks and again before it acts.
 * @template T
 * @param {string} key the action and its item: 'race-del:<id>'
 * @param {EventTarget | null} btn
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
async function once(key, btn, fn) {
  if (S.confirming.has(key)) return undefined;
  S.confirming.add(key);
  const b = btn instanceof HTMLElement ? btn : null;
  if (b) b.setAttribute('aria-disabled', 'true');
  try {
    return await fn();
  } finally {
    S.confirming.delete(key);
    if (b) b.removeAttribute('aria-disabled');
    scheduleRender();
  }
}

/** A trigger drawn while its action runs (once) is drawn as not available. */
const busyAttr = (key) => (S.confirming.has(key) ? 'true' : null);

/* ---------- live connection ---------- */

/**
 * Paint a new State. The feed is taken from it only when it is the fresh start the stream asked for, or when there
 * is no stream at all (polling): SSE 'state' events carry no feed (§9.7), and a mutation's State may be older than
 * the 'feed' events that arrived meanwhile.
 * @param {any} st
 * @param {{ feedEpoch?: number }} [opts] feedEpoch: the stream open this GET /api/state was started after
 */
function applyState(st, opts = {}) {
  if (!st || typeof st !== 'object' || !st.config) return;
  // 9.28: Split Relay answers as another version than this page was loaded from (an update was installed): the page
  // loads itself again, so the panel and Split Relay are the same version
  const appVersion = str(st.app?.version);
  if (appVersion) {
    if (S.appVersion && S.appVersion !== appVersion && typeof location !== 'undefined' && typeof location.reload === 'function') {
      location.reload();
      return;
    }
    if (!S.appVersion) {
      // the first answer after the page loaded: say once that an update came in, or that one was taken back
      const u0 = updateOf(st);
      const fresh = (x) => x && x.at && Math.abs((toMs(st.now) ?? Date.now()) - x.at) < 3 * 60 * 1000;
      if (fresh(u0.installed)) setTimeout(() => toast(`Split Relay was updated to version ${u0.installed.to}.`, 'ok', 10000), 0);
      else if (fresh(u0.rolledBack)) setTimeout(() => toast(rolledBackText(u0.rolledBack), 'warn', 20000), 0);
    }
    S.appVersion = appVersion;
  }
  S.state = st;
  const now = toMs(st.now);
  if (now) S.skew = now - Date.now();
  if (Array.isArray(st.feed)) {
    if (!S.es && typeof EventSource !== 'function') S.feed.merge(st.feed);
    else if (S.feedNeedsReset && opts.feedEpoch === S.feedEpoch) {
      S.feed.resetTo(st.feed, S.feedResetStamp);
      S.feedNeedsReset = false;
    }
  }
  // drafts of races and outputs deleted elsewhere would otherwise linger as "unsaved changes"
  const ids = new Set([...arr(st.config.races), ...arr(st.config.outputs)].map((x) => x.id));
  for (const key of [...S.drafts.keys()]) {
    const m = /^(race|out):(.+)$/.exec(key);
    if (m && m[2] !== NEW && !ids.has(m[2])) S.drafts.delete(key);
  }
  trackDown(st);
  noteNames(st);
  // a confirm open for an item that is now gone (deleted in another window) closes, as a Cancel
  if (S.confirmOpen && !S.confirmOpen.alive()) S.confirmOpen.lost();
  scheduleRender();
}

/**
 * Remember when each output and each RR12 port was first seen down (Split Relay doesn't say), so Needs attention and
 * the lights can say for how long, and turn red when it lasts while a race runs.
 */
function trackDown(st) {
  const now = nowMs();
  const seen = new Set();
  for (const o of arr(st?.config?.outputs)) {
    const s = outputStatus(st, o.id);
    const key = 'out:' + o.id;
    if (o.enabled !== false && (s?.state === 'disconnected' || s?.state === 'connecting')) {
      seen.add(key);
      if (!S.downSince.has(key)) S.downSince.set(key, now);
    }
  }
  for (const i of inputsOf(st)) {
    const key = 'in:' + i.port;
    if (!arr(i.connections).length) {
      seen.add(key);
      if (!S.downSince.has(key)) S.downSince.set(key, now);
    }
  }
  for (const k of [...S.downSince.keys()]) if (!seen.has(k)) S.downSince.delete(k);
}

/** An output's light as this page sees it: its pill, how long it has been down, and whether a race is running. */
function lightOf(st, o, now = nowMs()) {
  const running = arr(st?.config?.races).some((r) => r && r.active !== false && isRunning(viewOf(st, r.id), r, st, now));
  return outputLight(o, outputStatus(st, o.id) || {}, { since: S.downSince.get('out:' + o.id) ?? null, running, now });
}

/** What the attention list needs from this page besides the State. */
const attentionOpts = () => ({ downSince: S.downSince, kept: S.decisionKept, namesOffer: loadPref('namesOffer', null) });

function markAlive() {
  S.lastMsgAt = Date.now();
  if (S.conn !== 'open') {
    S.conn = 'open';
    S.retryDelay = 1000;
    renderBanners();
    scheduleRender();
  }
}

function markLost() {
  if (S.conn !== 'lost') {
    S.conn = 'lost';
    S.lostSince = Date.now();
    // Split Relay may have restarted with new feed ids: start the feed over once the stream is back
    S.feedNeedsReset = true;
    scheduleRender();
  }
}

async function refreshState() {
  const epoch = S.feedEpoch;
  const st = await api('GET', '/api/state');
  markAlive();
  applyState(st, { feedEpoch: epoch });
}

function connect() {
  clearTimeout(S.retryTimer);
  if (S.es) {
    try { S.es.close(); } catch { /* already closed */ }
    S.es = null;
  }
  if (typeof EventSource !== 'function') {
    // No SSE at all: poll instead, slower but still live
    refreshState().catch(markLost).finally(() => { S.retryTimer = setTimeout(connect, 2000); });
    return;
  }
  const es = new EventSource('/api/events');
  S.es = es;
  es.onopen = () => {
    if (S.es !== es) return;
    // 'feed' events from here on are newer than anything the panel has; the State fetched next fills in the rest
    S.feedEpoch++;
    S.feedNeedsReset = true;
    S.feedResetStamp = S.feed.stamp;
    markAlive();
    // the stream's own 'state' event paints meanwhile, but only this fetch brings the feed's older rows
    const fill = (tries) => refreshState().catch(() => {
      if (tries > 0 && S.es === es && S.feedNeedsReset) setTimeout(() => fill(tries - 1), 1500);
    });
    fill(3);
  };
  es.addEventListener('state', (ev) => {
    if (S.es !== es) return;
    markAlive();
    try { applyState(JSON.parse(ev.data)); } catch (err) { console.error('bad state event', err); }
  });
  es.addEventListener('feed', (ev) => {
    if (S.es !== es) return;
    markAlive();
    try {
      S.feed.upsert(JSON.parse(ev.data));
      scheduleRender();
    } catch (err) { console.error('bad feed event', err); }
  });
  es.onmessage = () => { if (S.es === es) markAlive(); };
  es.onerror = () => {
    if (S.es !== es) return;
    // The browser's own retry gives up on some errors; one reconnect loop with a known delay is easier to trust
    es.close();
    S.es = null;
    markLost();
    S.retryTimer = setTimeout(connect, S.retryDelay);
    S.retryDelay = Math.min(5000, S.retryDelay + 1000);
  };
}

/** An open stream that has gone quiet may be dead (sleep, network change): check with a plain request. */
function watchdog() {
  if (S.conn !== 'open' || Date.now() - S.lastMsgAt < 25000) return;
  refreshState().catch(() => {
    markLost();
    connect();
  });
}

/* ---------- rendering ---------- */

function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  const run = () => {
    if (!S.renderQueued) return;
    S.renderQueued = false;
    clearTimeout(S.renderTimer);
    // a press that never reports its release (a native popup, a drag out of the window) must not freeze the page
    if (S.pointerDown && Date.now() - S.pointerDownAt < 1500) {
      S.renderAfterPointer = true;
      clearTimeout(S.pointerTimer);
      S.pointerTimer = setTimeout(scheduleRender, 1600);
      return;
    }
    renderAll();
  };
  requestAnimationFrame(run);
  // animation frames stop while the window is hidden or covered; the page must still be current when it is shown
  S.renderTimer = setTimeout(run, 1000);
}

const PANELS = {};
const EL = {};

function renderAll() {
  guard(null, renderTop);
  renderBanners();
  // the lights and banners just painted set the bar's height (the ResizeObserver says so too, but only at the next frame)
  syncStickyHeight();
  const has = !!S.state;
  EL.boot.hidden = has;
  for (const t of TABS) PANELS[t].hidden = !has || S.route.tab !== t;
  // the output editor drawer belongs to the Outputs page
  if (EL.drawer && S.route.tab !== 'outputs' && !EL.drawer.hidden) EL.drawer.hidden = true;
  if (!has) return;
  const tab = S.route.tab;
  if (tab === 'live') renderLive();
  else if (tab === 'review') guard(PANELS.review, renderReview);
  else if (tab === 'races') renderRacesTab();
  else if (tab === 'outputs') renderOutputsTab();
  else if (tab === 'inputs') renderInputsTab();
  else if (tab === 'settings') renderSettingsTab();
  else if (tab === 'help') guard(PANELS.help, renderHelp);
  guard(null, renderNav);
  runPendingFocus();
}

/**
 * The status strip: one light per RR12 port, per output, and for the .lif files; each opens its page. It always fits
 * the bar (stripPlans): names get short, then the words go, then the ports or the outputs fold into one light each.
 */
function renderTop() {
  const box = EL.lights;
  const st = S.state;
  const now = nowMs();
  /** @type {{ kind: string, items: any[] }[]} */
  const groups = [];
  if (st) {
    const ins = inputsOf(st);
    const many = ins.length > 1;
    groups.push({ kind: 'in', items: ins.map((i) => {
      const l = inputLight(i, st, now);
      const since = S.downSince.get('in:' + i.port);
      return { key: 'in:' + i.port, href: '#inputs', tone: l.tone, label: many ? l.label : 'RR12', short: many ? String(i.port) : 'RR12',
        word: l.tone === 'ok' ? '' : l.word.toLowerCase(), state: l.word.toLowerCase(),
        title: [l.title, l.tone !== 'ok' && l.tone !== 'muted' && since ? `Not connected for ${formatDuration(now - since)}.` : ''].filter(Boolean).join(' ') };
    }) });
    groups.push({ kind: 'out', items: arr(st.config?.outputs).map((o) => {
      const l = lightOf(st, o, now);
      return { key: 'out:' + o.id, href: '#outputs/' + enc(o.id), tone: l.tone, label: str(o.name) || 'Output', short: str(o.name) || 'Output',
        word: l.word, state: l.word || outputStateWord(o, outputStatus(st, o.id)).toLowerCase(), title: l.title };
    }) });
    const files = [];
    if (st.config?.lif?.enabled) {
      const p = lifPill(st.lif);
      const what = p.text.replace(/^\.lif files( · )?/, '');
      files.push({ key: 'lif', href: '#settings/lif', tone: p.tone, label: '.lif', short: '.lif', word: p.tone === 'ok' ? '' : p.tone === 'bad' ? 'problem' : 'waiting',
        state: what || 'merged .lif files', title: `Merged .lif files${what ? `: ${what}` : ''}${p.title ? ` (${p.title})` : ''}` });
    }
    // the names file: a light while it did not load, or while the splits go without names (DESIGN 9.20 N1)
    const gap = namesGap(st);
    if (str(st.config?.names?.pplPath).trim() && (st.names?.error || st.names?.loaded === false)) {
      files.push({ key: 'names', href: '#settings/names', tone: gap.tone === 'bad' ? 'bad' : 'warn', label: 'Names', short: 'Names', word: 'not loaded', state: 'not loaded',
        title: `Names file not loaded${st.names?.error ? `: ${st.names.error}` : ''}` });
    } else if (gap.missing) {
      files.push({ key: 'names', href: '#settings/names', tone: gap.tone, label: 'Names', short: 'Names', word: 'none', state: 'no names file',
        title: gap.tone === 'bad' ? `No names file: ${listText(gap.outputs)} ${gap.outputs.length === 1 ? 'gets' : 'get'} bibs only` : 'No names file: the splits go out with bibs only' });
    }
    groups.push({ kind: 'files', items: files });
  }
  const shown = groups.filter((g) => g.items.length);
  // while the connection is lost every light is grey: what it shows is only the last known state
  const stale = S.conn === 'lost';
  const keep = new Set();
  const lightEl = (p) => {
    keep.add(p.key);
    let a = S.lightEls.get(p.key);
    if (!a) {
      a = h('a', { class: 'light', 'data-key': p.key, 'data-fk': 'light-' + p.key },
        h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'light-label' }), h('span', { class: 'light-short' }), h('span', { class: 'light-word' }));
      hookLightPop(a);
      S.lightEls.set(p.key, a);
    }
    const cls = `light tone-${stale ? 'muted' : p.tone}${stale ? ' stale' : ''}`;
    if (a.className !== cls) a.className = cls;
    if (a.getAttribute('href') !== p.href) a.setAttribute('href', p.href);
    const word = stale ? 'last known' : p.word;
    // (the details without the name the first line already says: "TrackScore · connected" -> "Connected")
    let detail = str(p.title).startsWith(`${p.label} · `) ? str(p.title).slice(p.label.length + 3) : str(p.title);
    // (and not the word again: "Stadium Display · off" needs no "Off" under it)
    if (detail.toLowerCase() === str(p.word).toLowerCase()) detail = '';
    detail = detail.charAt(0).toUpperCase() + detail.slice(1);
    setLightPop(a, [`${p.label}${word ? ` · ${word}` : ''}`, (stale ? 'Last known state: the connection to Split Relay is lost. ' : '') + detail, 'Click to open its page.']);
    const [t, s, w] = [a.querySelector('.light-label'), a.querySelector('.light-short'), a.querySelector('.light-word')];
    if (t.textContent !== p.label) t.textContent = p.label;
    if (s.textContent !== p.short) s.textContent = p.short;
    if (w.textContent !== word) w.textContent = word;
    w.hidden = !word;
    return a;
  };
  // one light for every light of a kind: "IN ●●● 3 ports"
  const sumEl = (g) => {
    const key = 'sum:' + g.kind;
    keep.add(key);
    let a = S.lightEls.get(key);
    if (!a) {
      a = h('a', { class: 'light light-sum', 'data-key': key, 'data-fk': 'light-' + key },
        h('span', { class: 'sum-dots', 'aria-hidden': 'true' }), h('span', { class: 'light-sum-text' }));
      hookLightPop(a);
      S.lightEls.set(key, a);
    }
    const sum = lightGroupSummary(g.kind, g.items);
    const cls = `light light-sum tone-${stale ? 'muted' : sum.tone}${stale ? ' stale' : ''}`;
    if (a.className !== cls) a.className = cls;
    if (a.getAttribute('href') !== sum.href) a.setAttribute('href', sum.href);
    const dots = a.querySelector('.sum-dots');
    const sig = g.items.map((x) => (stale ? 'muted' : x.tone)).join(' ');
    if (dots.dataset.sig !== sig) {
      dots.dataset.sig = sig;
      dots.replaceChildren(...sig.split(' ').map((t) => h('span', { class: `dot tone-${t}` })));
    }
    const text = a.querySelector('.light-sum-text');
    if (text.textContent !== sum.text) text.textContent = sum.text;
    setLightPop(a, stale ? [sum.pop[0], 'Last known state: the connection to Split Relay is lost.', ...sum.pop.slice(1)] : sum.pop);
    return a;
  };
  const labelEl = (kind) => {
    const key = 'grp:' + kind;
    keep.add(key);
    if (!S.lightEls.has(key)) S.lightEls.set(key, h('span', { class: 'light-group', 'data-key': key, 'aria-hidden': 'true' }, STRIP_KINDS[kind].name));
    return S.lightEls.get(key);
  };
  const nodesFor = (plan) => shown.flatMap((g) => [labelEl(g.kind), ...(plan.grouped.includes(g.kind) ? [sumEl(g)] : g.items.map(lightEl))]);
  // the first plan whose lights fit the room the bar has, measured on copies off screen (the lights on screen keep
  // their focus and popover while the strip is worked out again every second)
  const plans = stripPlans(shown.map((g) => ({ kind: g.kind, count: g.items.length })));
  const room = box.clientWidth;
  const m = lightsMeasurer();
  let plan = plans[plans.length - 1];
  let fits = false;
  for (const p of plans) {
    m.className = `lights lights-measure${p.short ? ' short' : ''}${p.bare ? ' bare' : ''}${p.tight ? ' tight' : ''}`;
    m.replaceChildren(...nodesFor(p).map((n) => n.cloneNode(true)));
    if (m.scrollWidth <= room + 0.5) {
      plan = p;
      fits = true;
      break;
    }
  }
  m.replaceChildren();
  box.classList.toggle('short', plan.short);
  box.classList.toggle('bare', plan.bare);
  box.classList.toggle('tight', plan.tight);
  box.classList.toggle('wrap', !fits && room > 0);
  const next = nodesFor(plan);
  if (next.length !== box.children.length || next.some((n, i) => box.children[i] !== n)) box.replaceChildren(...next);
  for (const k of [...S.lightEls.keys()]) if (!keep.has(k)) S.lightEls.delete(k);
  if (EL.lightPop && EL.lightPop._for && !EL.lightPop._for.isConnected) hideLightPop();
  // the connection to Split Relay itself
  const c = S.conn === 'open' ? { tone: 'ok', text: 'Live', title: 'Connected to Split Relay: this page updates by itself.' }
    : S.conn === 'lost' ? { tone: 'bad', text: 'Offline', title: 'Lost the connection to Split Relay. Retrying.' }
      : { tone: 'muted', text: 'Connecting…', title: 'Connecting to Split Relay.' };
  const cls = `conn tone-${c.tone}`;
  if (EL.conn.className !== cls) EL.conn.className = cls;
  if (EL.conn.title !== c.title) EL.conn.title = c.title;
  if (EL.connText.textContent !== c.text) EL.connText.textContent = c.text;
}

function hookLightPop(a) {
  a.addEventListener('pointerenter', () => showLightPop(a));
  a.addEventListener('pointerleave', hideLightPop);
  a.addEventListener('focus', () => showLightPop(a));
  a.addEventListener('blur', hideLightPop);
}

/** A light's popover lines (the first is its heading) and what a screen reader says for it, in sentences. */
function setLightPop(a, lines) {
  const pop = lines.filter(Boolean).join('\n');
  if (a.dataset.pop === pop) return;
  a.dataset.pop = pop;
  a.setAttribute('aria-label', sentences(lines));
  if (EL.lightPop && EL.lightPop._for === a && !EL.lightPop.hidden) showLightPop(a);
}

/** An off-screen copy of the strip that the lights are measured in (renderTop). */
function lightsMeasurer() {
  if (!EL.lightsMeasure || !EL.lightsMeasure.isConnected) {
    EL.lightsMeasure = h('div', { class: 'lights lights-measure', 'aria-hidden': 'true' });
    document.body.append(EL.lightsMeasure);
  }
  return EL.lightsMeasure;
}

/** A light's details in a styled popover under it, on hover and on keyboard focus (the browser's tooltip is slow). */
function showLightPop(a) {
  if (!EL.lightPop) {
    EL.lightPop = h('div', { class: 'light-pop', role: 'tooltip', id: 'light-pop', hidden: true });
    document.body.append(EL.lightPop);
  }
  const p = EL.lightPop;
  const [head, ...rest] = str(a.dataset.pop).split('\n');
  p.replaceChildren(h('strong', {}, head), ...rest.filter(Boolean).map((t) => h('span', {}, t)));
  p._for = a;
  p.hidden = false;
  const r = a.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 16);
  p.style.width = `${w}px`;
  p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  p.style.top = `${Math.round(r.bottom + 6)}px`;
}

function hideLightPop() {
  if (EL.lightPop) {
    EL.lightPop.hidden = true;
    EL.lightPop._for = null;
  }
}

/** The navigation rail: the current page, each page's last place, and what waits on each page. */
function renderNav() {
  const st = S.state;
  const items = st ? dashboardItems(st, nowMs(), S.feed.list()) : [];
  // (a decision, such as which race TrackScore shows, is not a problem: it is not counted)
  const problems = items.filter((w) => !w.decision && (w.tone === 'bad' || w.tone === 'warn'));
  const rt = reviewTotals(st);
  const outBad = arr(st?.config?.outputs).filter((o) => lightOf(st, o).tone === 'bad').length;
  const inBad = inputsOf(st).filter((i) => inputLight(i, st, nowMs()).tone === 'bad').length;
  const setBad = (st?.config?.lif?.enabled && st?.lif?.state === 'error') || (str(st?.config?.names?.pplPath).trim() && st?.names?.error) || (st && namesGap(st).tone === 'bad') ? 1 : 0;
  const badges = {
    live: problems.length ? { n: problems.length, tone: problems.some((w) => w.tone === 'bad') ? 'bad' : 'warn', title: `${plural(problems.length, 'thing')} to check` } : null,
    review: rt.total ? { n: rt.total, tone: rt.tone === 'muted' ? 'info' : rt.tone, title: reviewBadgeText(rt) } : null,
    outputs: outBad ? { n: outBad, tone: 'bad', title: `${plural(outBad, 'output')} with a problem` } : null,
    inputs: inBad ? { n: inBad, tone: 'bad', title: `${plural(inBad, 'RR12 port')} with a problem` } : null,
    settings: setBad ? { n: '!', tone: 'bad', title: 'A setting has a problem' } : null,
  };
  for (const a of EL.nav) {
    const tab = a.dataset.tab;
    const on = tab === S.route.tab;
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
    // a page opens where it was left (the race or output that was open)
    const href = on ? '#' + tab : S.lastRoute[tab] || '#' + tab;
    if (a.getAttribute('href') !== href) a.setAttribute('href', href);
    const b = a.querySelector('.nav-badge');
    const want = b ? badges[tab] : null;
    if (b) b.hidden = !want;
    if (want) {
      const t = String(typeof want.n === 'number' ? fmtInt(want.n) : want.n);
      if (b.textContent !== t) b.textContent = t;
      b.className = `nav-badge tone-${want.tone}`;
      a.title = `${a.querySelector('.nav-label').textContent}: ${want.title}`;
    } else a.title = a.querySelector('.nav-label').textContent;
  }
  // where this page is, and where another computer opens it (when that is allowed)
  const port = st?.config?.panel?.port ?? location.port;
  const lan = st?.config?.panel?.allowLan && likelyAddress(st) ? `${likelyAddress(st)}:${port}` : '';
  const foot = `${S.viewOnly ? location.host : `localhost:${port}`}${lan && !S.viewOnly ? ` · LAN ${lan}` : ''}`;
  if (EL.railFoot && EL.railFoot.textContent !== foot) {
    EL.railFoot.textContent = foot;
    EL.railFoot.title = lan ? `Other computers open http://${lan}/ to watch.` : 'This page. Settings, Control panel: let other computers watch it.';
  }
  // a background tab or a second screen still shows that something needs the operator
  const bad = problems.some((w) => w.tone === 'bad');
  const title = problems.length ? `(${fmtInt(problems.length)}) ${bad ? '⚠ ' : ''}Split Relay` : 'Split Relay';
  if (document.title !== title) document.title = title;
  const icon = bad ? 'icons/logo-alert.svg' : 'icons/logo.svg';
  const link = document.querySelector('link[rel="icon"]');
  if (link && link.getAttribute('href') !== icon) link.setAttribute('href', icon);
}

function renderBanners() {
  if (!EL.bannerConn) return;
  const lost = S.conn === 'lost' && Date.now() - S.lostSince > 1500;
  EL.bannerConn.hidden = !lost;
  if (lost) {
    const t = S.state && S.lastMsgAt ? `Showing what Split Relay last reported, at ${formatWall(S.lastMsgAt)}.` : '';
    if (EL.bannerConnWhen.textContent !== t) EL.bannerConnWhen.textContent = t;
  }
  document.body.classList.toggle('is-stale', lost);
  if (EL.viewChip) EL.viewChip.hidden = !S.viewOnly;
  // 9.28: a newer version is on GitHub: the chip (on every page) opens what is new and Install update
  if (EL.updateChip) {
    const u = updateOf(S.state);
    const show = u.available && !S.viewOnly;
    EL.updateChip.hidden = !show;
    const t = show ? `Update ${u.latest.version}` : '';
    if (show && EL.updateChipText && EL.updateChipText.textContent !== t) EL.updateChipText.textContent = t;
  }
}

/** Every second: the "ago" texts and the lights. Text only: nothing is rebuilt here. */
function tick() {
  if (!S.state) {
    renderBanners();
    guard(null, renderTop);
    return;
  }
  const now = nowMs();
  S.lastTopAt = Date.now();
  for (const el of document.querySelectorAll('[data-ago]')) {
    const ms = Number(el.getAttribute('data-ago'));
    const t = ms > 0 ? (el.getAttribute('data-prefix') || '') + formatAgo(now - ms) : el.getAttribute('data-never') || 'never';
    if (el.textContent !== t) el.textContent = t;
  }
  guard(null, renderTop);
  renderBanners();
  // something is down: its "down 2 min" and its colour (red after a while) follow the clock, not only new State
  if (S.downSince.size && Date.now() - S.lastDownPaint > 5000) {
    S.lastDownPaint = Date.now();
    scheduleRender();
  }
}

/* ---------- routing and focus ---------- */

function go(hash) {
  if (location.hash === hash) onRoute();
  else location.hash = hash;
}

function onRoute() {
  const r = parseRoute(location.hash);
  // each page starts at its top; the page scroll is shared by all of them
  if (r.tab !== S.route.tab) window.scrollTo(0, 0);
  // back on Review from another page: a runner looked up then is folded to one line, so the queue is on top
  if (r.tab === 'review' && S.route.tab !== 'review' && S.review?.runner && !r.focus) S.review.runnerFolded = true;
  hideLightPop();
  S.route = r;
  S.lastRoute[r.tab] = location.hash || '#' + r.tab;
  if (r.focus || ((r.tab === 'settings' || r.tab === 'inputs') && r.id)) S.pendingFocus = { ...r };
  if (r.tab === 'outputs' && r.id) S.pendingFocus = { ...r, focus: 'output' };
  if (r.tab === 'review') S.pendingFocus = null;
  scheduleRender();
}

/**
 * The sticky top bar's height as --sticky-h on <html> (DESIGN 9.16 F2). The style sheet turns it into
 * scroll-padding-top, which every scroll and focus target honours: a link to the gun box, Tab to a field below the
 * fold, a Help anchor. 0 when the bar is not sticky (a small window, where it scrolls away with the page).
 */
function syncStickyHeight() {
  const bar = $('.topbar');
  if (!bar || typeof getComputedStyle !== 'function') return;
  const h = getComputedStyle(bar).position === 'sticky' ? Math.ceil(bar.getBoundingClientRect().height) : 0;
  const root = document.documentElement;
  if (root.style.getPropertyValue('--sticky-h') !== `${h}px`) root.style.setProperty('--sticky-h', `${h}px`);
}

/**
 * Scroll the page so a focused field or button that sits under the sticky top bar shows just below it. Not for a
 * click (the operator sees what they clicked) or a container (main gets focus from a click on its background).
 */
function keepClearOfBar(el) {
  if (S.pointerDown || !el || typeof el.matches !== 'function') return;
  if (!el.matches('input, select, textarea, button, a[href], summary, [role="tab"]') || el.closest('.topbar, dialog, .toasts')) return;
  syncStickyHeight();
  const h = parseFloat(document.documentElement.style.getPropertyValue('--sticky-h')) || 0;
  if (!h) return;
  const r = el.getBoundingClientRect();
  if (r.bottom > 0 && r.top < h + 4) window.scrollBy(0, r.top - h - 12);
}

/**
 * Scroll `target` into view below the sticky top bar: its whole `box` (the gun card, say) when that fits on the
 * screen, so the label and the button beside the field show too; else the target itself at the top.
 */
function reveal(target, box = null) {
  syncStickyHeight();
  const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
  const room = window.innerHeight - pad - 8;
  const el = box && box.isConnected && box.getBoundingClientRect().height <= room ? box : target;
  el.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function runPendingFocus() {
  const f = S.pendingFocus;
  if (!f || f.tab !== S.route.tab) return;
  let target = null;
  let box = null;
  if (f.tab === 'races' && f.focus === 'gun') {
    target = $('#gun-input');
    box = target?.closest('.gun-card') ?? null;
  } else if (f.tab === 'races' && f.focus === 'splits') target = $('#race-splits-legend');
  else if (f.tab === 'settings' || f.tab === 'inputs') target = $('#set-' + f.id);
  else if (f.tab === 'outputs' && f.focus === 'output') target = $('#drawer-title');
  S.pendingFocus = null;
  if (!target) return;
  // the output editor is a drawer beside the page: nothing to scroll
  if (f.tab !== 'outputs') reveal(target, box);
  target.focus({ preventScroll: true });
  // drop the focus part so a reload or a later visit to the page doesn't jump again
  if (f.focus && f.tab === 'races') {
    history.replaceState(null, '', `#races/${enc(f.id)}`);
    S.lastRoute.races = `#races/${enc(f.id)}`;
  }
}

/* ---------- drafts ---------- */

const draftJson = (d) => JSON.stringify(d, (k, v) => (k === '_k' ? undefined : v));
const clone = (v) => JSON.parse(JSON.stringify(v));
let keySeq = 0;
const newKey = () => 'k' + ++keySeq;

/**
 * The draft of one form. `base` is the JSON of the server copy the draft started from: the draft is dirty when it
 * differs, and when the server copy changes under a clean draft the draft follows it (a dirty one is kept).
 */
function draftFor(key, toDraft, server, isNew = false) {
  let d = S.drafts.get(key);
  const serverJson = server ? draftJson(toDraft(server)) : null;
  if (!d) {
    d = { key, toDraft, draft: clone(toDraft(server || {})), base: serverJson, isNew, savedAt: 0, errors: [], remoteChanged: false, saving: false, version: 1, ui: {} };
    S.drafts.set(key, d);
    return d;
  }
  if (!d.isNew && serverJson !== null && serverJson !== d.base) {
    if (isDirty(d)) d.remoteChanged = true;
    else reloadDraft(d, server);
  }
  return d;
}

const isDirty = (d) => !!d && (d.isNew || draftJson(d.draft) !== d.base);

function reloadDraft(d, server) {
  d.draft = clone(d.toDraft(server || {}));
  d.base = draftJson(d.toDraft(server || {}));
  d.remoteChanged = false;
  d.errors = [];
  d.version++;
}

/** A text change: no rebuild, just the status line and the Unsaved badges. */
function changed(d) {
  if (d.errors.length) {
    d.errors = [];
    d.version++;
  }
  d.savedAt = 0;
  updateFormStatus(d);
  scheduleRender();
}

/** A structural change (add, remove, reorder): the form is rebuilt from the draft. */
function restructure(d) {
  d.version++;
  changed(d);
}

function syncForm(region, d, build) {
  if (region._key !== d.key || region._v !== d.version) {
    region._key = d.key;
    region._v = d.version;
    paint(region, () => build(d));
  }
  updateFormStatus(d);
}

function updateFormStatus(d) {
  const ui = d.ui || {};
  const dirty = isDirty(d);
  if (ui.status) {
    let text = '';
    let tone = 'muted';
    if (d.saving) text = 'Saving…';
    else if (d.savedAt && Date.now() - d.savedAt < 6000) { text = '✓ Saved'; tone = 'ok'; }
    // (a new one says "Not saved yet" once, in its title)
    else if (d.isNew) text = '';
    else if (dirty) { text = 'Unsaved changes'; tone = 'warn'; }
    // a form whose button does more than save it (Save meet setup) says only what is not saved
    else text = d.quietSaved ? '' : 'All changes saved';
    if (ui.status.textContent !== text) ui.status.textContent = text;
    ui.status.className = `form-status tone-${tone}`;
  }
  if (ui.save) ui.save.disabled = d.saving || !dirty;
  if (ui.revert) ui.revert.disabled = d.saving || (!dirty && !d.isNew);
  if (ui.notice) ui.notice.hidden = !d.remoteChanged;
}

/** Shared bits of every form footer. */
function formFooter(d, { saveLabel, onRevert, extra }) {
  d.ui = d.ui || {};
  d.ui.status = h('span', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  d.ui.save = h('button', { type: 'submit', class: 'btn primary', 'data-fk': d.key + '-save' }, saveLabel);
  d.ui.revert = h('button', { type: 'button', class: 'btn', 'data-fk': d.key + '-revert', onclick: onRevert }, d.isNew ? 'Discard' : 'Revert');
  d.ui.notice = h('p', { class: 'msg tone-warn', hidden: true },
    'This was changed somewhere else while you were editing. Save keeps your version; Revert loads the saved one.');
  return [
    d.errors.length ? h('div', { class: 'form-errors', role: 'alert', tabindex: '-1', 'data-fk': d.key + '-errors' },
      h('p', {}, d.errors.length === 1 ? 'Please fix this first:' : 'Please fix these first:'),
      h('ul', {}, d.errors.map((e) => h('li', {}, e)))) : null,
    d.ui.notice,
    h('div', { class: 'form-actions' }, d.ui.save, d.ui.revert, d.ui.status, extra || null),
  ];
}

/**
 * Validate, send, and on success start the draft over from the server's new copy with a "Saved" confirmation.
 * @returns {Promise<any>} the new State, or undefined
 */
async function saveDraft(d, { validate, send, server }) {
  const errs = validate ? validate(d.draft) : [];
  if (errs.length) {
    d.errors = errs;
    d.version++;
    S.focusAfter = d.key + '-errors';
    scheduleRender();
    return undefined;
  }
  d.saving = true;
  d.errors = [];
  updateFormStatus(d);
  try {
    const st = await send(d.draft);
    applyState(st);
    const fresh = server(st);
    if (fresh) reloadDraft(d, fresh);
    d.savedAt = Date.now();
    setTimeout(scheduleRender, 6100);
    return st;
  } catch (err) {
    d.errors = [err && err.message ? err.message : String(err)];
    d.version++;
    S.focusAfter = d.key + '-errors';
    return undefined;
  } finally {
    d.saving = false;
    scheduleRender();
  }
}

/* ---------- fields ---------- */
// At most one short line of help under a field; the longer explanation is behind its "?" (more).

function field({ id, label, help, more: long, control, cls = '' }) {
  const [btn, body] = moreParts(id, long, `About ${label}`);
  return h('div', { class: 'field ' + cls },
    h('div', { class: 'label-row' }, h('label', { for: id }, label), btn),
    control,
    help ? h('p', { class: 'help', id: id + '-help' }, help) : null,
    body);
}

function textInput(id, value, onInput, extra = {}) {
  const el = h('input', {
    id, 'data-fk': id, type: 'text', value, autocomplete: 'off', spellcheck: 'false',
    'aria-describedby': extra.help ? id + '-help' : null,
    oninput: (e) => onInput(e.target.value),
    ...extra.attrs,
  });
  if (/\bcode\b/.test(str(extra.attrs?.class))) showPathEnd(el);
  return el;
}

/**
 * A path box shows the end of the path (the file or folder name, the part that matters) when it is not being edited,
 * and the whole path in its tooltip.
 */
function showPathEnd(el) {
  const end = () => {
    el.title = el.value;
    if (document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  };
  el.addEventListener('blur', end);
  el.addEventListener('input', () => { el.title = el.value; });
  requestAnimationFrame(end);
}

/** A field read as a sentence, its box in the middle: "Ignore reads in the first [60] s after the gun". */
function sentenceField({ id, before, after, help, more: long, control }) {
  const [btn, body] = moreParts(id, long, `About ${before} … ${after}`);
  control.setAttribute('aria-label', `${before} … ${after}`);
  return h('div', { class: 'field sentence' },
    h('div', { class: 'sentence-row' }, h('label', { for: id }, before), control, h('span', { class: 'sentence-after' }, after), btn),
    help ? h('p', { class: 'help', id: id + '-help' }, help) : null,
    body);
}

/** A checkbox; `toggle` draws it as a switch (Active, On). */
function checkField({ id, label, checked, onChange, help, more: long, toggle = false }) {
  const [btn, body] = moreParts(id, long, `About ${label}`);
  return h('div', { class: 'field check' },
    h('div', { class: 'label-row' },
      h('label', { class: toggle ? 'switch-label' : 'check-label', for: id },
        h('input', { id, 'data-fk': id, type: 'checkbox', class: toggle ? 'switch' : null, checked, 'aria-describedby': help ? id + '-help' : null, onchange: (e) => onChange(e.target.checked) }),
        h('span', {}, label)),
      btn),
    help ? h('p', { class: 'help', id: id + '-help' }, help) : null,
    body);
}

function selectInput(id, value, options, onChange, help) {
  return h('select', { id, 'data-fk': id, value, 'aria-describedby': help ? id + '-help' : null, onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.value }, o.label)));
}

function radioGroup({ name, legend, value, options, onChange, help, more: long }) {
  const [btn, body] = moreParts('rg-' + name, long, `About ${legend}`);
  return h('fieldset', { class: 'field radios' },
    h('legend', {}, legend, btn),
    options.map((o) => h('label', { class: 'radio-label' },
      h('input', { type: 'radio', name, value: o.value, checked: value === o.value, 'data-fk': `${name}-${o.value}`, onchange: () => onChange(o.value) }),
      h('span', {}, o.label, o.help ? h('span', { class: 'help inline' }, ` ${o.help}`) : null))),
    help ? h('p', { class: 'help' }, help) : null,
    body);
}

/**
 * Chips with a remove button each, and a "+ add" that offers names seen on the stream plus a box to type one.
 * The open adder is remembered in S.adder so a rebuild keeps it open.
 */
export function chipEditor({ d, key, items, removeLabel, onRemove, onAdd, options, optionsTitle, emptyOptions, inputLabel, placeholder, seenMap }) {
  const open = S.adder === key;
  const chips = items.map((name, i) => {
    const seen = seenMap ? seenMap.get(norm(name)) : null;
    return h('span', { class: 'chip' + (seenMap && !seen ? ' unseen' : ''), title: seenMap ? (seen ? `${plural(seen.count || 0, 'read')} seen` : 'Not seen from RR12 yet') : null },
      h('span', { class: 'chip-text' }, name),
      seen ? h('span', { class: 'chip-count' }, fmtInt(seen.count || 0)) : null,
      h('button', { type: 'button', class: 'chip-x', 'aria-label': `${removeLabel} ${name}`, 'data-fk': `${key}-x-${i}`, onclick: () => {
        onRemove(i);
        S.focusAfter = items.length > 1 ? `${key}-x-${Math.max(0, i - 1)}` : `${key}-open`;
        restructure(d);
      } }, '×'));
  });
  // Each "+ add" says what it adds: a screen reader otherwise hears seven identical "+ add" buttons on one form.
  const toggle = h('button', {
    type: 'button', class: 'btn small add-btn', 'aria-expanded': String(open), 'data-fk': key + '-open',
    'aria-label': open ? `Close: ${inputLabel}` : inputLabel,
    onclick: () => {
      S.adder = open ? null : key;
      S.adderOrderKey = null;
      S.focusAfter = open ? key + '-open' : key + '-input';
      restructure(d);
    },
  }, open ? 'Close' : '+ add');
  const parts = [h('div', { class: 'chips' }, chips, toggle)];
  if (open) {
    const input = h('input', { type: 'text', class: 'adder-input', 'data-fk': key + '-input', placeholder, 'aria-label': inputLabel, autocomplete: 'off', spellcheck: 'false' });
    if (S.adderOrderKey !== key) {
      S.adderOrderKey = key;
      S.adderOrder = [];
      S.adderAdded = new Set();
    }
    const add = (name) => {
      const v = str(name).trim();
      if (!v) return;
      // a double click lands on the same chip again before the rebuild: it is already added, say nothing
      if (S.adderAdded.has(norm(v))) return;
      const problem = onAdd(v);
      if (problem) {
        toast(problem, 'warn');
        return;
      }
      S.adderAdded.add(norm(v));
      S.focusAfter = key + '-input';
      restructure(d);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); S.adder = null; S.focusAfter = key + '-open'; restructure(d); }
    });
    const shown = stableOptions(S.adderOrder, options, S.adderAdded);
    S.adderOrder = shown.order;
    parts.push(h('div', { class: 'adder', role: 'group', 'aria-label': inputLabel },
      shown.items.length
        ? h('div', { class: 'adder-options' }, h('p', { class: 'adder-title' }, optionsTitle),
          shown.items.map((it) => (it.added
            ? h('button', { type: 'button', class: 'opt added', disabled: true, 'aria-label': `${it.name}: added` },
              h('span', { class: 'opt-name' }, it.name), h('span', { class: 'opt-note' }, '✓ added'))
            : h('button', { type: 'button', class: 'opt', 'data-fk': `${key}-opt-${norm(it.name)}`, onclick: () => add(it.option.name) },
              h('span', { class: 'opt-name' }, it.name), it.option.note ? h('span', { class: 'opt-note' }, it.option.note) : null))))
        : h('p', { class: 'help' }, emptyOptions),
      h('div', { class: 'adder-type' }, input,
        h('button', { type: 'button', class: 'btn small', onclick: () => add(input.value) }, 'Add'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.adder = null; S.focusAfter = key + '-open'; restructure(d); } }, 'Done'))));
  }
  return parts;
}

/* ---------- dialogs ---------- */

/**
 * A confirm dialog that says what will happen: a clear title, the first lines, and the rest under "Details" (open at
 * once when the action is risky, so nothing that matters is hidden). The primary action is on the right; a
 * destructive one starts on Cancel. One confirm at a time: while one is open, another one answers "no" at once.
 * `alive` says whether the item it is about still exists: when it goes (deleted in another window, say) the dialog
 * closes as a Cancel with the `gone` message, and its button never confirms for an item that is gone.
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirm = 'OK', cancel = 'Cancel', danger = false, extra = null, back = null, lead = 2, focusCancel = false, openDetails = null, onReady = null, alive = null, gone = '' }) {
  const dlg = $('#dlg-confirm');
  const paras = (Array.isArray(body) ? body : [body]).filter(Boolean);
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm([title, ...paras].join('\n\n')));
  if (dlg.open) return Promise.resolve(false);
  const returnTo = back || document.activeElement;
  const shown = paras.slice(0, lead);
  const rest = paras.slice(lead);
  return new Promise((resolve) => {
    let ok = false;
    let settled = false;
    // answered once, at the click: the dialog's own close event (Esc) can come a frame later, or not at all while
    // the page isn't drawn, and a late one must not answer for the next dialog
    const settle = () => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      if (S.confirmOpen?.lost === lost) S.confirmOpen = null;
      resolve(ok);
      focusBack(returnTo);
    };
    const finish = () => {
      if (dlg.open) dlg.close();
      settle();
    };
    // Esc is the Cancel button, answered at once: the dialog's own close event came most of a second later (or never,
    // while the page isn't drawn), and until then the focus was on the page, not on what opened the dialog (9.23 F12)
    const onCancel = (e) => {
      e.preventDefault();
      finish();
    };
    dlg.addEventListener('cancel', onCancel);
    const lost = () => {
      if (gone) toast(gone, 'info');
      finish();
    };
    const yes = h('button', { type: 'button', class: 'btn big ' + (danger ? 'danger-solid' : 'primary'), onclick: () => {
      if (alive && !alive()) return lost();
      ok = true;
      finish();
    } }, confirm);
    const no = h('button', { type: 'button', class: 'btn big', onclick: finish }, cancel);
    dlg.replaceChildren(h('div', { class: 'dlg' },
      h('h2', { class: 'dlg-title', id: 'dlg-confirm-title' }, title),
      h('div', { class: 'dlg-body', id: 'dlg-confirm-body' },
        shown.map((p) => h('p', {}, p)),
        rest.length ? h('details', { class: 'fold dlg-more', open: openDetails ?? danger },
          h('summary', {}, 'Details', h('span', { class: 'summary-note' }, `${rest.length} more`)),
          h('div', { class: 'dlg-more-body' }, rest.map((p) => h('p', {}, p)))) : null),
      extra ? h('div', { class: 'dlg-extra' }, extra) : null,
      h('div', { class: 'dlg-actions' }, no, yes)));
    dlg.setAttribute('aria-labelledby', 'dlg-confirm-title');
    dlg.setAttribute('aria-describedby', 'dlg-confirm-body');
    S.confirmOpen = alive ? { alive, lost } : null;
    // Esc closes the dialog without a click: that is a Cancel (a late close event of an earlier dialog, arriving while
    // this one is open, is not)
    const onClose = () => {
      if (dlg.open) return;
      dlg.removeEventListener('close', onClose);
      settle();
    };
    dlg.addEventListener('close', onClose);
    if (onReady) onReady(yes);
    dlg.showModal();
    // a destructive or scoreboard-changing action starts on Cancel
    (danger || focusCancel ? no : yes).focus();
  });
}

/**
 * Pick a file or folder on the Split Relay PC through GET /api/files.
 * @param {{ title: string, pick: 'file'|'dir', ext?: string, start?: string, times?: boolean,
 *   suggest?: (() => Promise<{ path: string, mtimeMs: number|null, current?: boolean }[]>) | null, suggestTitle?: string }} opts
 *   times: each file with its modified time ("modified today 09:12"); suggest: files to offer above the folder, each a
 *   one-click "Use …" (DESIGN 9.20 N2)
 * @returns {Promise<string | null>}
 */
function browse({ title, pick, ext, start, times = false, suggest = null, suggestTitle = 'Suggested:' }) {
  const dlg = $('#dlg-browse');
  if (!dlg || typeof dlg.showModal !== 'function') {
    const v = window.prompt(`${title}\n\nType the full path:`, start || '');
    return Promise.resolve(v ? v.trim() : null);
  }
  const back = document.activeElement;
  return new Promise((resolve) => {
    let result = null;
    let cur = { dir: '', parent: null, entries: [] };
    let reqNo = 0;
    const pathInput = h('input', { type: 'text', class: 'code', id: 'browse-path', autocomplete: 'off', spellcheck: 'false', placeholder: 'C:\\Lynx  or  \\\\server\\share\\folder' });
    const goBtn = h('button', { type: 'button', class: 'btn', onclick: () => load(pathInput.value.trim()) }, 'Go');
    const upBtn = h('button', { type: 'button', class: 'btn', onclick: () => load(cur.parent || '') }, h('span', { class: 'i i-up', 'aria-hidden': 'true' }), 'Up');
    const rootsBtn = h('button', { type: 'button', class: 'btn', onclick: () => load('') }, 'Drives');
    // the folder as a trail of its parts: one click opens any folder above it
    const trail = h('nav', { class: 'browse-trail', 'aria-label': 'Folders above this one' });
    const msg = h('p', { class: 'browse-msg', role: 'status' });
    const list = h('ul', { class: 'browse-list', 'aria-label': 'Folder contents' });
    const useBtn = pick === 'dir' ? h('button', { type: 'button', class: 'btn primary', onclick: () => { if (cur.dir) { result = cur.dir; dlg.close(); } } }, 'Use this folder') : null;
    // files to offer before any browsing (the .ppl files in FinishLynx's folder): filled in when they are known
    const sugBox = h('div', { class: 'browse-suggest', hidden: true });
    if (typeof suggest === 'function') {
      Promise.resolve().then(suggest).then((found) => {
        const offer = arr(found).filter((x) => x && x.path);
        if (!offer.length || !dlg.open) return;
        sugBox.replaceChildren(h('p', { class: 'sub-label' }, suggestTitle),
          h('div', { class: 'browse-suggest-list' }, offer.map((x, i) => h('button', { type: 'button', class: 'btn small suggest-btn' + (i === 0 && !x.current ? ' primary' : ''), 'data-fk': 'browse-use-' + baseName(x.path),
            onclick: () => { result = x.path; dlg.close(); } }, pplUseLabel(x, nowMs()), x.current ? h('span', { class: 'help inline' }, ' · in use') : null))));
        sugBox.hidden = false;
      }).catch(() => { /* suggestions are a convenience */ });
    }
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); load(pathInput.value.trim()); } });
    dlg.replaceChildren(h('div', { class: 'dlg dlg-wide' },
      h('h2', { class: 'dlg-title', id: 'dlg-browse-title' }, title),
      h('p', { class: 'help' }, pick === 'dir'
        ? 'Open the folder you want, then press “Use this folder”. You can also type or paste a path, including network paths.'
        : `Open folders until you see the ${ext || ''} file, then click it. You can also type or paste a folder path.`),
      sugBox,
      h('div', { class: 'browse-bar' }, h('label', { for: 'browse-path', class: 'sr-only' }, 'Folder path'), pathInput, goBtn, upBtn, rootsBtn),
      trail, msg, list,
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), useBtn)));
    dlg.setAttribute('aria-labelledby', 'dlg-browse-title');
    dlg.addEventListener('close', () => {
      resolve(result);
      focusBack(back);
    }, { once: true });

    async function load(dir, fallbackToRoots = false) {
      const my = ++reqNo;
      msg.textContent = 'Opening…';
      const q = new URLSearchParams();
      if (dir) q.set('dir', dir);
      if (ext) q.set('ext', ext);
      if (times) q.set('times', '1');
      try {
        const r = await api('GET', '/api/files?' + q.toString());
        if (my !== reqNo) return;
        cur = { dir: str(r?.dir), parent: r?.parent ?? null, entries: arr(r?.entries) };
        pathInput.value = cur.dir;
        upBtn.disabled = !cur.dir;
        if (useBtn) useBtn.disabled = !cur.dir;
        draw();
      } catch (err) {
        if (my !== reqNo) return;
        if (fallbackToRoots) {
          await load('');
          msg.textContent = `Couldn't open ${dir} (${err.message}). Showing the drives instead.`;
        } else {
          msg.textContent = `Couldn't open ${dir || 'the list of drives'}: ${err.message}`;
        }
      }
    }

    function draw() {
      const dirs = cur.entries.filter((e) => e.type === 'dir');
      const want = str(ext).toLowerCase();
      const files = cur.entries.filter((e) => e.type === 'file' && (!want || str(e.name).toLowerCase().endsWith(want)));
      const byName = (a, b) => str(a.name).localeCompare(str(b.name), undefined, { numeric: true, sensitivity: 'base' });
      dirs.sort(byName);
      files.sort(byName);
      const items = [
        ...dirs.map((e) => h('li', {}, h('button', { type: 'button', class: 'entry dir', onclick: () => load(e.path) },
          h('span', { class: 'i i-folder', 'aria-hidden': 'true' }), h('span', {}, e.name), h('span', { class: 'sr-only' }, ' (folder)')))),
        ...files.map((e) => h('li', {}, pick === 'file'
          ? h('button', { type: 'button', class: 'entry file', onclick: () => { result = e.path; dlg.close(); } },
            h('span', { class: 'i i-file', 'aria-hidden': 'true' }), h('span', {}, e.name),
            Number.isFinite(e.mtimeMs) ? h('span', { class: 'entry-meta' }, modifiedText(e.mtimeMs, nowMs())) : null)
          : h('span', { class: 'entry file passive' }, h('span', { class: 'i i-file', 'aria-hidden': 'true' }), h('span', {}, e.name)))),
      ];
      list.replaceChildren(...items);
      const parts = pathCrumbs(cur.dir);
      trail.replaceChildren(...[h('button', { type: 'button', class: 'crumb', onclick: () => load('') }, 'Drives'),
        ...parts.flatMap((p, i) => [h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'),
          h('button', { type: 'button', class: 'crumb', 'aria-current': i === parts.length - 1 ? 'location' : null, onclick: () => load(p.path) }, p.name)])]);
      // (the path is in the box and the trail: the line says only what is in the folder)
      msg.textContent = items.length
        ? `${plural(dirs.length, cur.dir ? 'folder' : 'drive')}${want && cur.dir ? `, ${plural(files.length, want + ' file')}` : ''}.`
        : `No folders${want ? ` or ${want} files` : ''} here.`;
      const first = list.querySelector('button');
      if (first && dlg.contains(document.activeElement) && document.activeElement.classList.contains('entry')) first.focus();
    }

    dlg.showModal();
    pathInput.focus();
    load(start || '', !!start);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* not allowed (older browser or not a secure page): fall back below */ }
  const host = document.activeElement?.closest?.('dialog') || document.body;
  const ta = h('textarea', { class: 'offscreen', readOnly: true, 'aria-hidden': 'true' });
  ta.value = text;
  host.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function previewOutput(id, btn) {
  const o = configOutput(S.state, id);
  const r = await act(() => api('POST', `/api/outputs/${enc(id)}/preview`), btn);
  if (!r) return;
  const dlg = $('#dlg-preview');
  const errors = arr(r.jsonErrors);
  const warnings = arr(r.warnings);
  const verdict = errors.length
    ? badge('Not valid JSON — TrackScore would drop it', 'bad')
    : r.isJson ? badge('Valid JSON', 'ok') : badge('Plain text (not JSON)', 'muted');
  const display = str(r.display ?? r.text);
  const d = draftFor('out:' + id, outputToDraft, o);
  // what the operator came for is the packet: Copy is the main action, Close the other
  const copyBtn = h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const ok = await copyText(display);
    copyBtn.textContent = ok ? '✓ Copied' : 'Copy failed: select the text instead';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2500);
  } }, 'Copy');
  const content = h('div', { class: 'dlg dlg-wide' },
    h('h2', { class: 'dlg-title', id: 'dlg-preview-title' }, `Preview: ${o?.name || 'output'}`),
    h('p', { class: 'help' }, 'Exactly what Split Relay sends for one sample split, with control bytes shown as \\0d \\0a and so on.'),
    isDirty(d) ? h('p', { class: 'msg tone-warn' }, 'This uses the saved settings. Save the form first to preview your changes.') : null,
    h('div', { class: 'preview-verdict' }, verdict),
    h('pre', { class: 'code preview', tabindex: '0', 'aria-label': 'Packet text' }, display || '(empty: the script produced nothing)'),
    errors.length ? h('div', { class: 'msg tone-bad' }, h('p', {}, 'JSON problems:'), h('ul', {}, errors.map((e) => h('li', {}, str(e))))) : null,
    warnings.length ? h('div', { class: 'msg tone-warn' }, h('p', {}, 'Script warnings:'), h('ul', {}, warnings.map((e) => h('li', {}, str(e))))) : null,
    h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Close'), copyBtn));
  if (!dlg || typeof dlg.showModal !== 'function') {
    window.alert(display);
    return;
  }
  // The button, not document.activeElement: act() disabled it during the request, which moved focus to <body>.
  const back = btn instanceof Element ? btn : document.activeElement;
  dlg.replaceChildren(content);
  dlg.setAttribute('aria-labelledby', 'dlg-preview-title');
  dlg.addEventListener('close', () => focusBack(back), { once: true });
  dlg.showModal();
}

/* ============================================================================================================ */
/* Dashboard (race day): the setup checklist, Needs attention, one tile per Active race, the live feed.           */

function renderLive() {
  const st = S.state;
  const now = nowMs();
  const feedList = S.feed.list();
  guard(EL.dashSetup, () => {
    const steps = setupSteps(st);
    // the races step offers the newest meet file saved here (DESIGN 9.22 M10)
    if (!S.viewOnly && steps.some((s) => s.key === 'race' && !s.done) && !loadPref('setupHidden', false)) loadMeetFiles();
    const sig = JSON.stringify([steps, loadPref('setupHidden', false), laptimeExpression(st), inputPorts(st), st.addresses, arr(st.config.outputs).map((o) => o.name), S.viewOnly,
      newestMeet() && [newestMeet().fileName, newestMeet().name]]);
    paintSig(EL.dashSetup, sig, () => buildSetup(st, steps));
  });
  guard(EL.dashAttention, () => {
    const items = dashboardItems(st, now, feedList);
    // during setup an empty list says nothing the checklist doesn't
    const hide = !items.length && setupShown(st);
    const wide = dashWide();
    EL.dashTop.classList.toggle('no-att', hide);
    const sig = JSON.stringify([items, [...S.attOpen], S.showNotes, S.attAll, wide, hide, [...S.pickerChoice]]);
    // Above the race tiles (a narrow screen) a list that grows or shrinks moves the tiles: not while the pointer is on
    // them, for a few seconds, so a Pause or Review aimed at is not missed
    if (EL.dashAttention._sig !== undefined && EL.dashAttention._sig !== sig && !wide && S.tilesHover) {
      if (!S.attHeldSince) S.attHeldSince = Date.now();
      if (Date.now() - S.attHeldSince < 8000) {
        clearTimeout(S.attHoldTimer);
        S.attHoldTimer = setTimeout(scheduleRender, 1000);
        return;
      }
    }
    S.attHeldSince = 0;
    paintSig(EL.dashAttention, sig, () => (hide ? null : buildAttention(items, wide ? 7 : 3)));
  });
  guard(EL.dashRaces, () => renderRaceTiles(st));
  guard(EL.feedBody, renderFeed);
}

/** Wide enough for Needs attention beside the race tiles, where its changes never move them. */
const dashWide = () => typeof matchMedia === 'function' && matchMedia('(min-width: 1280px)').matches;

/* ---------- first-run checklist ---------- */

/** Whether the Dashboard shows the setup checklist in full (some step to do, and the operator has not hidden it). */
const setupShown = (st) => !loadPref('setupHidden', false) && setupSteps(st).some((s) => !s.done);

/** "Setup: 2 of 5 done." for the toast after a step's editor saved. */
function setupProgressText(st) {
  const steps = setupSteps(st);
  return `Setup: ${steps.filter((s) => s.done).length} of ${steps.length} done.`;
}

/** The Needs attention list as the Dashboard shows it: while the checklist shows, it stands for the warnings about its steps. */
function dashboardItems(st, now, feed) {
  const todo = setupShown(st) ? setupSteps(st).filter((s) => !s.done) : [];
  const covered = new Set(todo.map((s) => ({ rr12: '#settings/exporter', outputs: '#outputs/new', names: '#settings/names', race: '#races/new' })[s.key]));
  const steps = new Set(todo.map((s) => s.key));
  return attentionItems(st, now, feed, attentionOpts()).filter((w) => w.raceId || !(covered.has(w.action?.href) || (w.step && steps.has(w.step))));
}

function buildSetup(st, steps) {
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const bar = h('span', { class: 'setup-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round((done / steps.length) * 100)}%` }));
  const progress = h('span', { class: 'setup-progress' }, bar, `${done} of ${steps.length} done`);
  if (loadPref('setupHidden', false)) {
    return h('div', { class: 'card setup setup-collapsed' },
      h('strong', {}, 'Setup'), progress,
      h('button', { type: 'button', class: 'btn small push-right', 'data-fk': 'setup-show', onclick: () => { savePref('setupHidden', false); focusKey('setup-hide'); scheduleRender(); } }, 'Show the checklist'));
  }
  return h('section', { class: 'card setup', 'aria-labelledby': 'setup-h' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', { id: 'setup-h' }, 'Set up for race day'), h('p', { class: 'help' }, 'Once per meet. Each step ticks itself when Split Relay sees it done.')),
      h('div', { class: 'row' }, progress,
        h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'setup-hide', onclick: () => { savePref('setupHidden', true); focusKey('setup-show'); scheduleRender(); } }, 'Hide'))),
    h('ol', { class: 'steps' }, steps.map((s, i) => setupStep(st, s, i, steps.find((x) => !x.done)?.key))));
}

/** One setup step; only the next step to do has the gold button. */
function setupStep(st, s, i, next = '') {
  const port = firstPort(st);
  const main = (cls = 'btn small') => cls + (s.key === next ? ' primary' : '');
  let body = null;
  let acts = [];
  if (s.key === 'rr12') {
    const expr = laptimeExpression(st);
    const others = arr(st.addresses).length - 1;
    body = [
      h('p', {}, `In RR12, add a TCP/IP exporter to ${rrTarget(st, port)} (127.0.0.1:${port} on this PC${others > 0 ? `; ${plural(others, 'other address', 'other addresses')} on the Inputs page` : ''}). Line end CRLF, the split mats only, then press play.`),
      h('div', { class: 'expr-row' }, h('pre', { class: 'code expr', tabindex: '0', 'aria-label': 'RR12 Export Data expression' }, expr), copyButton(expr, 'Copy expression', main('btn'))),
    ];
    acts = [h('a', { class: 'btn small', href: '#inputs/exporter' }, 'All exporter settings')];
  } else if (s.key === 'outputs') {
    const names = arr(st.config.outputs).map((o) => o.name).filter(Boolean);
    body = h('p', {}, names.length ? `${listText(names)} added.` : 'TrackScore XC (port 5555) and the Karmarush live results each get the splits as scoreboard packets.');
    // the editor opens over the Outputs page; once it is saved, the toast offers the way back here
    const add = (preset) => () => { S.fromSetup = 'outputs'; startNewOutput(preset); };
    acts = s.done ? [h('button', { type: 'button', class: 'btn small ghost', onclick: add(null) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Add another')] : [
      h('button', { type: 'button', class: main(), onclick: add(TRACKSCORE_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'TrackScore'),
      h('button', { type: 'button', class: 'btn small', onclick: add(KARMARUSH_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Karmarush live results'),
    ];
  } else if (s.key === 'names') {
    body = h('p', {}, "FinishLynx's people file for this meet (often Lynx.ppl). RR12 sends only bibs: TrackScore and the live results get each runner's name, school and gender from this file.");
    acts = s.done ? [] : [h('button', { type: 'button', class: main(), 'data-fk': 'setup-ppl', onclick: (e) => chooseNamesFile(e.currentTarget) }, 'Choose names file…')];
  } else if (s.key === 'lif') {
    body = h('p', {}, "FinishLynx's results folder, and a separate folder for the merged files that TrackScore, XC-Analytics and the web results read.");
    acts = s.done ? [] : [h('a', { class: main(), href: '#settings/lif' }, 'Set the folders')];
  } else if (s.key === 'race') {
    // DESIGN 9.22 M10: the meet in one go first (a meet file saved last time, or TrackScore's Race Setup), by hand after
    body = h('p', {}, "A meet file saved last time, or TrackScore's Race Setup, sets up the races in one go. A meet file also brings the outputs, the names file and the folders.");
    const newest = S.viewOnly ? null : newestMeet();
    const newRace = h('a', { class: 'btn small ghost', href: '#races/new', onclick: () => { S.fromSetup = 'race'; } }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Add a race by hand');
    acts = s.done || S.viewOnly ? [] : [
      newest ? savedMeetButton(newest, { primary: s.key === next, fk: 'setup-meet-saved' }) : null,
      h('button', { type: 'button', class: newest ? 'btn small' : main(), 'data-fk': 'setup-meet-load', onclick: chooseMeetFile }, 'Load meet file…'),
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'setup-meet-ts', onclick: (e) => startMeetLoad({ trackscore: true }, e.currentTarget) }, 'Set up from TrackScore'),
      newRace,
    ];
  }
  return h('li', { class: 'step' + (s.done ? ' done' : '') },
    h('span', { class: 'step-mark', 'aria-hidden': 'true' }, s.done ? h('span', { class: 'i i-check' }) : String(i + 1)),
    h('div', {},
      h('div', { class: 'step-title' }, s.title, h('span', { class: 'sr-only' }, s.done ? ' (done)' : ' (to do)')),
      s.done ? null : h('div', { class: 'step-body' }, body)),
    h('div', { class: 'step-acts' }, s.done && s.key === 'rr12' ? null : acts));
}

/* ---------- the names file (DESIGN 9.20) ---------- */

/**
 * "Choose names file…" (Needs attention, a race tile's "No names", the setup checklist, Settings): the file picker at
 * once, the .ppl files of FinishLynx's folder offered on top, and the file saved on the pick.
 */
async function chooseNamesFile(btn) {
  const st = S.state;
  const cur = str(st?.config?.names?.pplPath).trim();
  const folders = pplFolders(st);
  const p = await browse({
    title: "Choose the meet's names file (.ppl)",
    pick: 'file', ext: '.ppl', times: true,
    start: dirName(cur) || folders[0] || '',
    suggest: folders.length ? () => loadPplSuggestions(true) : null,
    suggestTitle: "In FinishLynx's folder (newest first):",
  });
  if (!p) return;
  await useNamesFile(p, btn);
}

/** Save the names file; the toast says how many athletes came in ("✓ 412 athletes loaded"), now or once loaded. */
async function useNamesFile(p, btn) {
  const st = await act(() => api('PUT', '/api/settings', { names: { pplPath: p } }), btn);
  if (!st) return false;
  S.namesToastFor = p;
  applyState(st);
  if (S.namesToastFor) toast(`Names file saved: ${baseName(p)}. Loading the names…`, 'info');
  return true;
}

/** "Clear" on the Settings card: asked first, as the splits then go without names. */
async function clearNamesFile(btn) {
  const cur = str(S.state?.config?.names?.pplPath).trim();
  if (!cur) return;
  const ok = await confirmDialog({
    title: 'Clear the names file?',
    body: [`Split Relay stops reading ${cur}.`, 'New splits then go to TrackScore and the live results without names: RR12 sends only bibs. Names already on the boards stay.'],
    confirm: 'Clear names file',
    danger: true,
    focusCancel: true,
    back: btn instanceof Element ? btn : null,
  });
  if (!ok) return;
  const st = await act(() => api('PUT', '/api/settings', { names: { pplPath: '' } }), btn);
  if (!st) return;
  S.namesToastFor = '';
  applyState(st);
  toast('Names file cleared.', 'info');
}

/** The open "Send names now" offer, for the current file (DESIGN 9.20 N3): the races still to do, as config races. */
function openNamesOffer(st = S.state) {
  return namesOfferItems(st, loadPref('namesOffer', null)).map((w) => configRace(st, w.action.raceId)).filter(Boolean);
}

/**
 * Seen with every State: when the names came in (namesArrived) after Active races had sent splits, keep the offer to
 * send them (once per file: path + loadedAt), and say how many athletes a pick loaded.
 */
function noteNames(st) {
  const prev = S.namesPrev;
  const next = st?.names && typeof st.names === 'object' ? st.names : null;
  S.namesPrev = next ? { path: str(next.path), loaded: !!next.loaded } : null;
  if (namesArrived(prev, next)) {
    const offer = namesOfferFor(st, { switched: !!prev?.loaded && normPath(prev.path) !== normPath(next.path) });
    const seen = arr(loadPref('namesOfferSeen', []));
    if (offer && !seen.includes(offer.key) && loadPref('namesOffer', null)?.key !== offer.key) {
      savePref('namesOffer', offer);
      savePref('namesOfferSeen', [...seen, offer.key].slice(-20));
    }
  }
  if (S.namesToastFor && next && normPath(next.path) === normPath(S.namesToastFor) && (next.loaded || next.error)) namesLoadedToast(st);
}

/** "✓ 412 athletes loaded from Lynx.ppl." after a pick, with "Send names now" when one race went out without them. */
function namesLoadedToast(st) {
  S.namesToastFor = '';
  const n = st?.names || {};
  if (!n.loaded) {
    toast(`The names file is saved, but it can't be read: ${str(n.error) || 'unknown problem'}`, 'bad');
    return;
  }
  // (the toast has its own check mark: "✓ 412 athletes loaded from Lynx.ppl.")
  const head = `${plural(Number(n.count) || 0, 'athlete')} loaded from ${baseName(n.path)}.`;
  const open = openNamesOffer(st);
  const how = loadPref('namesOffer', null)?.switched ? "with the earlier file's names" : 'without them';
  if (!open.length) toast(`${head} New splits go out with names.`, 'ok');
  else if (open.length === 1) {
    const r = open[0];
    toast(`${head} ${r.name}'s splits went out ${how}.`, 'ok', 20000, { action: { label: 'Send names now', run: () => sendNamesNow(r.id, null) } });
  } else {
    toast(`${head} ${listText(open.map((r) => r.name))} went out ${how}: Needs attention has “Send names now” for each.`, 'ok', 20000);
  }
}

/** One race's answer to the offer: 'sent' or 'dismissed' (Not now). */
function setNamesOffer(id, state) {
  const o = loadPref('namesOffer', null);
  if (!o || typeof o !== 'object' || !o.races || !(id in o.races)) return;
  o.races[id] = state;
  savePref('namesOffer', o);
  scheduleRender();
}

/**
 * "Send names now": a Resend of the race's splits, runners who have finished left out (their names came with
 * FinishLynx's own packets), in one click: the race is Active and its outputs already show it.
 */
async function sendNamesNow(id, btn) {
  const name = configRace(S.state, id)?.name || viewOf(S.state, id)?.name || 'this race';
  await once('names-send:' + id, btn, async () => {
    const risk = namesSendRisk(S.state, id);
    if (risk.length) {
      const ok = await confirmDialog({
        title: `Send ${name}'s names now?`,
        body: risk.map((x) => `${x.output} also takes ${listText(x.others)}. If it is showing ${x.others.length === 1 ? x.others[0] : 'one of them'} now, it switches to ${name} and clears ${x.others.length === 1 ? 'it' : 'that race'}.`)
          .concat(`${name}'s splits go again, now with names; runners who have finished are left out.`),
        confirm: 'Send names now',
        focusCancel: true,
        back: btn instanceof Element ? btn : null,
      });
      if (!ok) return;
    }
    const r = await sendResend(id, { includeFinished: false }, btn);
    if (!r) return;
    if (r.refused) {
      toast(r.refused, 'warn');
      return;
    }
    setNamesOffer(id, 'sent');
    toast(`Names sent. ${resendToast(name, r)}`, Number(r.sent) ? 'ok' : 'warn');
  });
}

/** A GET for a convenience (suggestions): no error toast, and a refusal does not make the page view-only. */
async function getQuiet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/**
 * The .ppl files in FinishLynx's folder and the one above it (pplFolders), newest first: for the picker and the
 * Settings card. Asked again after 20 s, or at once with `force` (the picker opens).
 * @returns {Promise<ReturnType<typeof pplSuggestions>>}
 */
async function loadPplSuggestions(force = false) {
  const dirs = pplFolders(S.state);
  const sig = JSON.stringify(dirs);
  const c = S.pplSug;
  if (c.sig === sig && c.loading) return c.loading;
  if (!force && c.sig === sig && Date.now() - c.at < 20000) return c.list;
  const run = (async () => {
    if (!dirs.length) return [];
    const listings = await Promise.all(dirs.map((d) => getQuiet('/api/files?' + new URLSearchParams({ dir: d, ext: '.ppl', times: '1' })).catch(() => null)));
    return pplSuggestions(listings.filter(Boolean), str(S.state?.config?.names?.pplPath));
  })();
  S.pplSug = { ...c, sig, loading: run };
  let list = [];
  try { list = await run; } catch { list = []; }
  S.pplSug = { sig, at: Date.now(), loading: null, list };
  scheduleRender();
  return list;
}

/* ---------- meet setup (DESIGN 9.22) ---------- */

const viewOnlyText = () => `This page can only watch from here. Make changes on the Split Relay PC itself (http://localhost:${location.port || 80}/).`;

/**
 * The meet files saved in data\meets (GET /api/meet/files), for the empty Races page, the setup checklist and Settings →
 * Meet setup. Asked again after 20 s, or at once with `force` (after a Save or a load). Never from another computer:
 * the list is of files on the Split Relay PC.
 */
async function loadMeetFiles(force = false) {
  const c = S.meetFiles;
  if (S.viewOnly) return c.list;
  if (c.loading) return c.loading;
  if (!force && c.at && Date.now() - c.at < 20000) return c.list;
  const run = getQuiet('/api/meet/files').then((r) => ({ list: arr(r?.files), dir: str(r?.dir) }), () => ({ list: c.list, dir: c.dir }));
  S.meetFiles = { ...c, loading: run };
  const r = await run;
  S.meetFiles = { at: Date.now(), list: r.list, dir: r.dir, loading: null };
  scheduleRender();
  return r.list;
}

/** "Load meet file…": the browser's own file chooser (the input made once in boot). */
function chooseMeetFile() {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  if (!EL.meetInput) return;
  EL.meetInput.value = '';
  EL.meetInput.click();
}

/** DESIGN 9.25, "Load start lists…": the browser's file chooser, several files at once. */
function chooseEntryFiles() {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  if (!EL.entryInput) return;
  EL.entryInput.value = '';
  EL.entryInput.click();
}

/**
 * DESIGN 9.25: entry files from the file chooser or a drop: read here (UTF-8 or Windows-1252), their text sent to
 * Split Relay (POST /api/startlists), which keeps the bibs of each event. One sentence per file says what happened, in
 * a toast and under the Races page's start lists until the next load.
 */
async function onEntryFiles(fileList) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const files = pickEntryFiles(fileList);
  if (!files.length) return toast('Choose the entry files: one text file per event, named by its event number (1.txt, 2.txt).', 'warn');
  const load = { at: Date.now(), results: [], notes: [], resent: 0, held: [] };
  const texts = [];
  for (const f of files.slice(0, 100)) {
    if (Number(f.size) > 600 * 1024) load.results.push({ file: str(f.name), ok: false, text: `${str(f.name)}: too big to be an entry file (more than 600 KB). Nothing was loaded.` });
    else texts.push({ name: str(f.name), text: decodeEntryBytes(new Uint8Array(await f.arrayBuffer())) });
  }
  let st = null;
  try {
    for (const batch of entryBatches(texts)) {
      st = await api('POST', '/api/startlists', { files: batch });
      const r = st?.startListLoad ?? {};
      load.results.push(...arr(r.results));
      load.notes.push(...arr(r.notes));
      load.resent += Number(r.resent) || 0;
      load.held.push(...arr(r.held));
    }
  } catch (err) {
    toast(`The start lists could not be loaded: ${err.message}`, 'bad');
  }
  if (st) applyState(st);
  S.startListLoad = load.results.length ? load : null;
  if (load.results.length) toast(startListLoadText(load), load.results.every((r) => r.ok) && !load.held.length && !load.notes.length ? 'ok' : 'warn');
  scheduleRender();
  return undefined;
}

/** DESIGN 9.25, Remove on a start list's line (DELETE /api/startlists/:event), asked first: it changes what goes out. */
async function removeStartList(line, btn) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const ok = await confirmDialog({
    title: `Remove the start list of ${line.name}?`,
    body: [`${fmtInt(line.entered)} entered, from ${line.file}. Without it an athlete of another race who is read in ${line.name} is sent like any runner; what was kept off the boards there goes out now if the race is Active.`,
      'Loading the file again puts the list back.'],
    confirm: 'Remove',
  });
  if (!ok) return undefined;
  const st = await act(() => api('DELETE', `/api/startlists/${enc(line.event)}`), btn);
  if (!st) return undefined;
  applyState(st);
  S.startListLoad = null;
  toast(str(st.startListRemove?.text) || 'The start list was removed.', 'ok');
  return undefined;
}

/**
 * DESIGN 9.25, the Races page's start lists: Load start lists… (or a drop anywhere on the page), each race with how
 * many are entered and from which file, the races without one, Remove, and what the last load said.
 */
function startListsBlock(st) {
  const lines = startListLines(st);
  const keep = st.config?.entries?.otherRace !== 'send';
  const last = S.startListLoad;
  return h('div', { class: 'start-lists' },
    h('div', { class: 'list-head' }, h('h3', { class: 'subhead' }, 'Start lists'),
      S.viewOnly ? null : h('button', { type: 'button', class: 'btn small', 'data-fk': 'sl-load', onclick: chooseEntryFiles }, 'Load start lists…')),
    lines.length
      ? h('ul', { class: 'sl-items' }, lines.map((l) => h('li', { class: 'sl-item' + (l.tone ? ` tone-text-${l.tone}` : ''), title: l.title || null },
        h('span', { class: 'sl-text' }, h('b', {}, l.name), `: ${l.text}`),
        l.removable && !S.viewOnly ? h('button', { type: 'button', class: 'btn small ghost', 'data-fk': `sl-rm-${l.event}`, 'aria-label': `Remove the start list of ${l.name}`,
          onclick: (e) => removeStartList(l, e.currentTarget) }, 'Remove') : null)))
      : h('p', { class: 'help' }, "None loaded. Load the meet's entry files, one text file per event named by its event number (1.txt, 2.txt), or drop them on this page: an athlete of another race who crosses a mat is then kept off this race's boards."),
    lines.length ? h('p', { class: 'help' }, keep ? 'Athletes entered in another race are kept off the boards. ' : 'Athletes entered in another race are sent and flagged. ',
      h('a', { href: '#settings/entries' }, 'Change')) : null,
    last ? h('ul', { class: 'sl-load', 'aria-label': 'What the last load said' },
      arr(last.results).map((r) => h('li', { class: r.ok ? null : 'tone-text-warn' }, str(r.text))), arr(last.notes).map((n) => h('li', { class: 'tone-text-warn' }, str(n)))) : null);
}

/* ---------- updates from GitHub (DESIGN 9.28) ---------- */

/** The update check of a State (State.update), every field in a safe form. */
export function updateOf(st) {
  const u = st?.update && typeof st.update === 'object' ? st.update : {};
  const gh = (v) => (/^https:\/\/github\.com\//.test(str(v)) ? str(v) : '');
  const latest = u.latest && typeof u.latest === 'object' && str(u.latest.version).trim()
    ? { version: str(u.latest.version).trim(), notes: str(u.latest.notes).trim(), publishedAt: toMs(u.latest.publishedAt), pageUrl: gh(u.latest.pageUrl) } : null;
  const note = (x) => (x && typeof x === 'object' && str(x.to).trim() ? { from: str(x.from).trim(), to: str(x.to).trim(), at: toMs(x.at), why: str(x.why).trim() } : null);
  return { current: str(u.current || st?.app?.version).trim(), state: str(u.state) || 'idle', checkedAt: toMs(u.checkedAt), error: str(u.error).trim(),
    available: u.available === true && !!latest, latest, canInstall: u.canInstall === true, cannotWhy: str(u.cannotWhy).trim(), blocked: str(u.blocked).trim(),
    restartsItself: u.restartsItself === true, installed: note(u.installed), rolledBack: note(u.rolledBack), releasesUrl: gh(u.releasesUrl) };
}

/** The update check in one sentence (the Help page, and the answer to Check for updates). */
export function updateLine(u, when = formatWall) {
  if (u.state === 'checking') return 'Asking GitHub for the newest version…';
  if (u.state === 'installing') return `Installing Split Relay ${u.latest ? u.latest.version : ''}…`.replace(' …', '…');
  if (u.state === 'restarting') return 'The new version is in place. Split Relay is starting again…';
  if (u.state === 'restart-needed') return 'The new version is in place. Close the Split Relay window and start it again (start.bat) to use it.';
  if (u.available) return `Split Relay ${u.latest.version} is available. This PC has ${u.current || 'an older version'}.`;
  if (u.error) return u.error;
  if (u.checkedAt) return `This is the newest version (checked at ${when(u.checkedAt)}).`;
  return 'Not checked yet.';
}

/** "Version 9.29.0 was installed but did not start, so 9.28.0 was put back": the note of an update that was taken back. */
export function rolledBackText(r) {
  return `Split Relay ${r.to} was installed${r.at ? ` at ${formatWall(r.at)}` : ''} but did not start, so version ${r.from} was put back. Nothing was lost: the races, settings and reads are as they were.`;
}

/** "Check for updates": asks GitHub now and says the answer. */
async function checkUpdate(btn = null) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const st = await act(() => api('POST', '/api/update/check'), btn);
  if (!st) return undefined;
  applyState(st);
  const u = updateOf(st);
  toast(updateLine(u), u.error && !u.available ? 'warn' : 'ok');
  return undefined;
}

/**
 * DESIGN 9.28, "Install update…": says which version, what is new (the release's notes from GitHub) and what
 * installing does; nothing happens before Install update. While a race is running, or on a copy that can't be
 * updated from here, it says why and has no Install.
 */
async function updateDialog(btn = null) {
  const u = updateOf(S.state);
  if (!u.available) return undefined;
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const stop = u.cannotWhy || u.blocked;
  const ok = await confirmDialog({
    title: `Split Relay ${u.latest.version} is available`,
    body: [`This PC has ${u.current}. Install update downloads the new version from GitHub, keeps a copy of this one and starts Split Relay again: about ten seconds, and this page comes back by itself.`,
      'Your races, settings, reads and logs are not touched. RR12, TrackScore and the live results connect again by themselves. If the new version does not start, Split Relay puts this one back.'],
    confirm: 'Install update', cancel: stop ? 'Close' : 'Not now', back: btn,
    extra: h('div', { class: 'update-form' },
      stop ? h('p', { class: 'msg tone-warn' }, stop) : null,
      u.rolledBack && u.rolledBack.to === u.latest.version ? h('p', { class: 'msg tone-warn' }, rolledBackText(u.rolledBack)) : null,
      u.latest.notes ? h('h3', { class: 'subhead' }, 'What is new') : null,
      u.latest.notes ? h('div', { class: 'update-notes', tabindex: '0' }, u.latest.notes) : null,
      u.latest.pageUrl ? h('p', { class: 'help' }, h('a', { href: u.latest.pageUrl, target: '_blank', rel: 'noopener noreferrer' }, 'This version on GitHub')) : null),
    onReady: (y) => {
      if (stop) y.disabled = true;
    },
  });
  if (!ok || stop) return undefined;
  toast(`Downloading and checking Split Relay ${u.latest.version}…`, 'ok', 8000);
  const st = await act(() => api('POST', '/api/update/install'), btn);
  if (!st) return undefined;
  applyState(st);
  const d = st.updateDone ?? {};
  toast(d.restarts ? `Split Relay ${str(d.to)} is installed. It is starting again: this page comes back by itself.`
    : `Split Relay ${str(d.to)} is installed. Close the Split Relay window and start it again (start.bat) to use it.`, d.restarts ? 'ok' : 'warn', 20000);
  return undefined;
}

/** The Help page's "Version and updates" card. */
function updateCard(st) {
  const u = updateOf(st);
  const hide = async (e) => {
    const s2 = await act(() => api('POST', '/api/update/dismiss'), e.currentTarget);
    if (s2) applyState(s2);
  };
  return [
    h('p', {}, h('b', {}, `Split Relay ${u.current || '(version not known)'}`),
      u.installed ? ` · updated from ${u.installed.from}${u.installed.at ? ` at ${formatWall(u.installed.at)}` : ''}` : ''),
    h('p', { class: u.available ? 'msg tone-info' : u.error ? 'msg tone-warn' : 'help', role: 'status' }, updateLine(u)),
    u.rolledBack ? h('p', { class: 'msg tone-warn' }, rolledBackText(u.rolledBack), ' ',
      S.viewOnly ? null : h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'upd-hide', onclick: hide }, 'Hide')) : null,
    S.viewOnly ? null : h('div', { class: 'row' },
      u.available ? h('button', { type: 'button', class: 'btn small primary', 'data-fk': 'upd-install', disabled: u.state !== 'idle', onclick: (e) => updateDialog(e.currentTarget) }, 'Install update…') : null,
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'upd-check', disabled: u.state !== 'idle', onclick: (e) => checkUpdate(e.currentTarget) }, 'Check for updates')),
    h('p', { class: 'help' }, 'Split Relay asks GitHub for a newer version each time it starts, when this PC has internet. It never installs one by itself, and not while a race is running. Without internet it starts as usual. ',
      u.releasesUrl ? h('a', { href: u.releasesUrl, target: '_blank', rel: 'noopener noreferrer' }, 'All versions on GitHub') : null),
  ];
}

/* ---------- swapped bibs (DESIGN 9.27) ---------- */

/** The pairs of swapped bibs of a State: [{ a, b, at, atText, text, races: [{ raceId, raceName, text }] }], oldest first. */
export function swapsOf(st) {
  return arr(st?.swaps).filter((s) => s && typeof s === 'object' && str(s.a).trim() && str(s.b).trim()).map((s) => ({
    a: str(s.a).trim(), b: str(s.b).trim(), at: toMs(s.at), atText: str(s.atText).trim(),
    text: str(s.text).trim() || `Bib ${str(s.a).trim()} and bib ${str(s.b).trim()} are swapped`,
    races: arr(s.races).filter((r) => r && typeof r === 'object' && str(r.text).trim()).map((r) => ({ raceId: str(r.raceId), raceName: str(r.raceName), text: str(r.text).trim() })) }));
}

/**
 * What entering or removing a swap did (the answer's swapChange), as lines: its sentence, then one line per race, in
 * Split Relay's own words. `warn`: something stayed behind (a cell the boards still show, a split that was not sent).
 * @returns {{ head: string, lines: string[], warn: boolean }}
 */
export function swapChangeLines(c) {
  const races = arr(c?.races).filter((r) => r && arr(r.lines).length);
  return { head: str(c?.text).trim() || (c?.removed ? 'The swap was removed.' : 'The bibs are swapped.'),
    lines: races.map((r) => `${str(r.raceName) || 'A race'}: ${arr(r.lines).map((l) => str(l).trim()).filter(Boolean).join(' ')}`),
    warn: races.some((r) => arr(r.leftover).length > 0 || arr(r.notLive).length > 0) };
}

/**
 * The preview of a swap (POST /api/swaps/preview) as the dialog shows it: what happens in each race, then the notes.
 * (Not its `lead`: the dialog's own line says who ran with whose chip.)
 */
function swapPlanNodes(p) {
  const races = arr(p?.races).filter((r) => r && arr(r.lines).length);
  return [
    races.length ? h('ul', { class: 'swap-races' }, races.map((r) => h('li', {}, h('b', {}, str(r.raceName) || 'A race'),
      h('ul', {}, arr(r.lines).map((l) => h('li', { class: /still show|not sent|stays? off|waits?:/.test(str(l)) ? 'tone-text-warn' : null }, str(l))))))) : null,
    arr(p?.notes).map((n) => h('p', { class: 'swap-note tone-text-warn' }, str(n))),
  ];
}

/** After a swap was entered or removed: the new State, what it did (a toast, and under the list), the Review page as it is now. */
function afterSwap(st, bib = '') {
  applyState(st);
  const c = st.swapChange ?? {};
  const said = swapChangeLines(c);
  S.swapLast = { at: Date.now(), ...said };
  toast([said.head, ...said.lines].join(' '), said.warn ? 'warn' : 'ok', said.lines.length ? 12000 : undefined);
  const R = S.review;
  if (R) {
    // the runner the editor shows may have none of these reads any more: the bib that has them here now is shown
    const here = arr(c.races).find((r) => r && r.raceId === R.raceId);
    const now = here ? arr(here.owners).filter((x) => x && x.reads).map((x) => str(x.bib)) : [];
    const open = R.runner?.bib ? str(R.runner.bib) : '';
    const pair = arr(c.pair).map(str);
    if (open && now.length === 1 && now[0] !== open && (open === str(bib) || pair.includes(open))) findRunner(now[0]);
    loadReview();
    if (R.view === 'all') loadGrid(R);
  }
  scheduleRender();
}

/**
 * DESIGN 9.27, "Swapped bibs…": two athletes ran with each other's chips. The dialog asks for the two bibs ("Bib 11
 * ran with the chip of bib [ ]"), shows what Split Relay says the swap would do as the numbers are typed (POST
 * /api/swaps/preview: per race, which splits become which bib's, whether they go out, what the boards still show), and
 * enters it (POST /api/swaps) on Swap bibs. Nothing changes before that.
 * @param {string} [bib] the bib the dialog was opened on (the runner editor, a Review row)
 */
async function swapDialog(bib = '', btn = null) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const field = (id, label, value) => h('input', { type: 'text', class: 'swap-bib mono', id, inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: '20', size: '6', value, 'aria-label': label });
  const a = field('swap-a', 'Bib', str(bib).trim());
  const b = field('swap-b', 'ran with the chip of bib', '');
  const out = h('div', { class: 'swap-preview', role: 'status', 'aria-live': 'polite' });
  let yes = null;
  let plan = null;
  let asked = 0;
  let timer = null;
  const ask = async () => {
    clearTimeout(timer);
    const body = { bib: a.value.trim(), other: b.value.trim() };
    plan = null;
    if (yes) yes.disabled = true;
    const mine = ++asked;
    if (!body.bib || !body.other) {
      out.replaceChildren(h('p', { class: 'help' }, 'Type both bib numbers: what the swap does shows here before anything changes.'));
      return;
    }
    try {
      const p = await api('POST', '/api/swaps/preview', body);
      if (mine !== asked) return;
      plan = body;
      out.replaceChildren(...swapPlanNodes(p).flat().filter(Boolean));
      if (yes) yes.disabled = false;
    } catch (err) {
      if (mine !== asked) return;
      out.replaceChildren(h('p', { class: 'msg tone-warn' }, err && err.message ? err.message : String(err)));
    }
  };
  for (const el of [a, b]) {
    el.oninput = () => {
      plan = null;
      if (yes) yes.disabled = true;
      clearTimeout(timer);
      timer = setTimeout(ask, 250);
    };
    // Enter in a box: Swap bibs once the preview is there, else ask for it now
    el.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (yes && !yes.disabled) yes.click();
      else ask();
    };
  }
  const ok = await confirmDialog({
    title: 'Swapped bibs',
    body: ["Two athletes ran with each other's chips. Split Relay then counts every read of each chip for the other bib, in every race: the reads already in and the ones still to come. Remove swap puts everything back."],
    confirm: 'Swap bibs', back: btn,
    extra: h('div', { class: 'swap-form' },
      h('div', { class: 'swap-line' }, h('label', { for: 'swap-a' }, 'Bib'), a, h('label', { for: 'swap-b' }, 'ran with the chip of bib'), b),
      out),
    onReady: (y) => {
      yes = y;
      y.disabled = true;
      ask();
      setTimeout(() => (a.value.trim() ? b : a).focus(), 0);
    },
  });
  clearTimeout(timer);
  asked++;
  if (!ok || !plan) return undefined;
  const st = await act(() => api('POST', '/api/swaps', plan), btn);
  if (st) afterSwap(st, plan.bib);
  return undefined;
}

/** DESIGN 9.27, "Remove swap" (DELETE /api/swaps/:bib): asked once, with what changes back in Split Relay's words. */
async function removeSwap(bib, btn = null) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  let p;
  try {
    p = await api('POST', '/api/swaps/preview', { bib: str(bib), remove: true });
  } catch (err) {
    toast(err && err.message ? err.message : String(err), err?.status === 404 ? 'warn' : 'bad');
    if (err?.status === 404) refreshState();
    return undefined;
  }
  const plan = swapPlanNodes(p).flat().filter(Boolean);
  const ok = await confirmDialog({ title: str(p.title) || 'Remove the swap?', body: [str(p.lead) || 'Every read counts for the bib it came in as again.'],
    confirm: str(p.confirm) || 'Remove swap', back: btn, extra: plan.length ? h('div', { class: 'swap-form' }, h('div', { class: 'swap-preview' }, plan)) : null });
  if (!ok) return undefined;
  const st = await act(() => api('DELETE', `/api/swaps/${enc(str(bib))}`), btn);
  if (st) afterSwap(st, str(bib));
  return undefined;
}

/**
 * DESIGN 9.27, the "Swapped bibs" list (the Races page, and Review while there is one): each pair with since when and
 * who has whose reads in which race, Remove swap, Swapped bibs… to enter one, and what the last change said.
 * @param {{ raceId?: string }} [opts] raceId: the race Review shows (its line first)
 */
function swapsBlock(st, { raceId = '', always = true, key = 'sw' } = {}) {
  const swaps = swapsOf(st);
  const last = S.swapLast && Date.now() - S.swapLast.at < 10 * 60 * 1000 ? S.swapLast : null;
  if (!swaps.length && !always) return null;
  return h('div', { class: 'start-lists swaps' },
    h('div', { class: 'list-head' }, h('h3', { class: 'subhead' }, 'Swapped bibs'),
      S.viewOnly ? null : h('button', { type: 'button', class: 'btn small', 'data-fk': `${key}-add`, onclick: (e) => swapDialog('', e.currentTarget) }, 'Swapped bibs…')),
    swaps.length
      ? h('ul', { class: 'sl-items' }, swaps.map((s) => {
        const races = [...s.races].sort((x, y) => (y.raceId === raceId) - (x.raceId === raceId));
        return h('li', { class: 'sl-item swap-item' },
          h('span', { class: 'sl-text' }, h('b', {}, `Bib ${s.a} ⇄ bib ${s.b}`), s.atText ? ` · since ${s.atText}` : '',
            races.length ? h('span', { class: 'swap-where' }, races.map((r) => h('span', {}, r.text))) : h('span', { class: 'swap-where' }, h('span', {}, 'Neither chip has been read yet.'))),
          S.viewOnly ? null : h('button', { type: 'button', class: 'btn small ghost', 'data-fk': `${key}-rm-${s.a}`, 'aria-label': `Remove the swap of bibs ${s.a} and ${s.b}`,
            onclick: (e) => removeSwap(s.a, e.currentTarget) }, 'Remove swap'));
      }))
      : h('p', { class: 'help' }, "None. When two athletes ran with each other's chips, enter the two bibs here: every read of each chip then counts for the other bib, in every race."),
    last ? h('ul', { class: 'sl-load', 'aria-label': 'What the last change said' }, h('li', {}, last.head), last.lines.map((l) => h('li', { class: last.warn ? 'tone-text-warn' : null }, l))) : null);
}

/** A meet file from the file chooser or a drop: read here, sent to Split Relay for the preview. */
async function onMeetFile(file) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  if (!file) return toast('Drop a meet file (.json) here (save one with Save meet setup), or the entry files of the meet (1.txt, 2.txt) for the start lists.', 'warn');
  if (Number(file.size) > 1024 * 1024) return toast('That file is too big to be a meet file (more than 1 MB).', 'bad');
  let text = '';
  let raw;
  try {
    text = (await file.text()).replace(/^﻿/, '');
    raw = JSON.parse(text);
  } catch (err) {
    const where = jsonErrorWhere(text, err);
    return toast(`That file is not a meet file: it is not valid JSON${where ? ` (${where})` : ''}.`, 'bad');
  }
  return startMeetLoad({ meet: raw, fileName: str(file.name) });
}

/**
 * Ask Split Relay what a load would do, and show it. `replace`: the preview open now is asked again (the remove tick
 * box, a 409, a new meet started from its banner); nothing opens if it was closed meanwhile.
 */
async function startMeetLoad(req, btn = null, { replace = false, focus = '' } = {}) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const b = btn instanceof HTMLButtonElement ? btn : null;
  const kids = b ? [...b.childNodes] : [];
  if (b) {
    b.disabled = true;
    if (req.trackscore) b.textContent = 'Reading TrackScore…';
  }
  let p;
  try {
    p = await api('POST', '/api/meet/preview', req);
  } catch (err) {
    toast(err.message, 'bad', undefined, req.trackscore ? { action: { label: 'TrackScore settings', run: () => go('#settings/meet') } } : {});
    return undefined;
  } finally {
    if (b) {
      b.disabled = false;
      if (req.trackscore) b.replaceChildren(...kids);
    }
  }
  if (replace && !$('#dlg-preview')?.open) return undefined;
  openMeetPreview(p, req, b, focus);
  return p;
}

/** This page's own lines for the preview: a form with unsaved changes that the load changes. */
function meetDraftNotes(p) {
  const out = [];
  for (const i of [...arr(p?.changed), ...arr(p?.removed)]) {
    const d = i.raceId ? S.drafts.get('race:' + i.raceId) : i.outputId ? S.drafts.get('out:' + i.outputId) : null;
    if (d && !d.isNew && isDirty(d)) {
      out.push({ tone: 'info', raceId: i.raceId || '', text: `You have unsaved changes to ${i.name}. The load changes the saved ${i.raceId ? 'race' : 'output'}; your form will say it changed elsewhere.` });
    }
  }
  const fresh = S.drafts.get('race:' + NEW);
  const freshName = str(fresh?.draft.name).trim();
  if (freshName) out.push({ tone: 'info', text: `A new race you started ("${freshName}") is not saved yet.` });
  return out;
}

/** The preview dialog (#dlg-preview): what the load adds, changes and leaves, then Apply. Focus starts on Cancel. */
function openMeetPreview(p, req, back = null, focus = '') {
  const dlg = $('#dlg-preview');
  if (!dlg || typeof dlg.showModal !== 'function') return;
  const v = meetPreviewView(p, { notes: meetDraftNotes(p), now: nowMs() });
  const close = () => dlg.close();
  const lineEl = (l) => h('li', { class: l.tone ? `tone-${l.tone}` : null },
    l.word ? h('span', { class: 'mp-word' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), l.word) : null,
    h('span', { class: 'mp-text' }, l.text),
    l.raceId || l.href ? h('span', { class: 'mp-links' },
      l.raceId ? h('button', { type: 'button', class: 'btn small ghost local', onclick: () => { close(); go('#races/' + enc(l.raceId)); } }, 'Open race') : null,
      l.href ? h('a', { class: 'btn small ghost', href: l.href, onclick: close }, 'Open') : null) : null);
  const remove = v.removeLabel ? h('label', { class: 'check-label mp-remove' },
    h('input', { type: 'checkbox', 'data-fk': 'meet-remove', checked: !!p.removeOthers,
      onchange: (e) => startMeetLoad({ ...req, removeOthers: e.target.checked }, null, { replace: true, focus: 'meet-remove' }) }),
    h('span', {}, v.removeLabel)) : null;
  const cancel = h('button', { type: 'button', class: 'btn', 'data-fk': 'meet-cancel', onclick: close }, v.cancelLabel);
  // O33: the copy kept before a load with nothing else to change: Apply waits for the remove box, which the line says
  const apply = !v.applyShown ? null : h('button', { type: 'button', class: 'btn' + (v.applyPrimary && !v.applyDisabled ? ' primary' : ''), 'data-fk': 'meet-apply',
    disabled: v.applyDisabled, 'aria-disabled': busyAttr('meet-apply'), onclick: (e) => applyMeetPreview(p, req, e.currentTarget) }, v.applyLabel);
  const banner = v.banner ? h('div', { class: 'msg tone-warn mp-banner' }, h('p', {}, v.banner),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', 'data-fk': 'meet-new',
      onclick: (e) => newMeetFlow(e.currentTarget, () => startMeetLoad({ ...req, removeOthers: !!p.removeOthers }, null, { replace: true })) }, 'Start a new meet…'))) : null;
  const content = h('div', { class: 'dlg dlg-wide meet-preview' },
    h('h2', { class: 'dlg-title', id: 'dlg-preview-title' }, v.title),
    h('p', { class: 'help mp-source' }, v.sourceLine),
    banner,
    v.sections.map((s) => h('section', { class: 'mp-sec', 'aria-label': s.title },
      h('h3', {}, s.title, h('span', { class: 'mp-count' }, String(s.lines.length))),
      h('ul', { class: 'mp-list' + (s.key === 'attention' ? ' mp-att' : '') }, s.lines.map(lineEl)))),
    remove,
    v.nothingLine ? h('p', { class: `msg tone-${v.nothingTone}` }, v.nothingLine) : null,
    h('p', { class: 'help' }, v.footer),
    h('div', { class: 'dlg-actions' }, cancel, apply));
  const wasOpen = dlg.open;
  dlg.replaceChildren(content);
  dlg.setAttribute('aria-labelledby', 'dlg-preview-title');
  S.meetPreview = { req, p };
  if (!wasOpen) {
    const ret = back instanceof Element ? back : document.activeElement;
    dlg.addEventListener('close', () => {
      S.meetPreview = null;
      focusBack(ret);
    }, { once: true });
    dlg.showModal();
  }
  const target = focus ? dlg.querySelector(`[data-fk="${CSS.escape(focus)}"]`) : null;
  if (target) target.focus();
  else {
    // on Cancel, with the preview read from its top (Cancel is at the bottom of a long one)
    cancel.focus({ preventScroll: true });
    dlg.scrollTop = 0;
  }
}

/** Apply: the preview's meet, planned again by Split Relay from the setup as it is now (409: it changed meanwhile). */
function applyMeetPreview(p, req, btn) {
  return once('meet-apply', btn, async () => {
    const setupOpen = setupShown(S.state);
    let r;
    try {
      // keep: a file from the file chooser or a drop is kept in data\meets, so it is one click next time (O5)
      const src = p.source || {};
      r = await api('POST', '/api/meet/apply', { meet: p.meet, mode: p.mode, base: p.base, removeOthers: !!p.removeOthers, undo: !!p.undo,
        keep: src.kind === 'file' || src.kind === 'config', fileName: str(src.fileName) });
    } catch (err) {
      if (err.status === 409 && /changed while the preview/.test(err.message)) {
        toast('The setup changed while the preview was open. Here it is again.', 'info');
        await startMeetLoad({ ...req, removeOthers: !!p.removeOthers }, null, { replace: true });
        return;
      }
      toast(err.message, 'bad');
      return;
    }
    applyState(r);
    $('#dlg-preview')?.close();
    const t = meetAppliedText(r.applied, nowMs());
    toast(t.text + (setupOpen && !r.applied?.nothing && setupShown(r) ? ` ${setupProgressText(r)}` : ''), t.tone);
    loadMeetFiles(true);
    go('#races');
  });
}

/**
 * Save meet setup: data\meets\<meet name>.json, and a copy downloaded by the browser (it works offline). A meet name
 * typed in Settings → Meet setup and not saved yet is saved first, so the file has that name (O22); a setup with no
 * races is saved only when the operator says so (O23).
 */
async function saveMeetSetup(btn) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const d = S.drafts.get('set:meet');
  if (d && isDirty(d)) {
    await saveSettings('meet');
    if (isDirty(d) || d.errors.length) {
      toast(meetSettingsNotSavedText(d.errors), 'bad', undefined, { action: { label: 'Meet setup', run: () => go('#settings/meet') } });
      return;
    }
  }
  if (!arr(S.state?.config?.races).length) {
    const ok = await confirmDialog({
      title: 'Save a meet with no races?',
      body: ['This setup has no races yet: the meet file would hold only the outputs and the settings. Load or add the races first, then save.'],
      confirm: 'Save anyway', back: btn instanceof Element ? btn : null, focusCancel: true,
    });
    if (!ok) return;
  }
  const r = await act(() => api('POST', '/api/meet/save'), btn);
  if (!r) return;
  try {
    const url = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
    const a = h('a', { href: url, download: r.fileName, class: 'offscreen' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch { /* the copy in data\meets is the one that matters */ }
  toast(`Meet setup saved: data\\meets\\${r.fileName}, and downloaded.${r.replaced ? ' The copy saved before under that name is in data\\meets\\old.' : ''}`, 'ok');
  loadMeetFiles(true);
}

/** Start a new meet…: asks first (in red when a read came in the last 10 minutes), then puts the last meet away. */
function newMeetFlow(btn, after = null) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const blocked = newMeetBlocker(S.state, nowMs());
  if (blocked) return toast(blocked, 'warn');
  return once('new-meet', btn, async () => {
    const now = nowMs();
    const recent = newMeetRecent(S.state, now);
    const ok = await confirmDialog({
      title: 'Start a new meet?', danger: true, confirm: recent ? 'Start a new meet anyway' : 'Start a new meet',
      body: newMeetText(S.state, now), lead: 2, back: btn instanceof Element ? btn : null,
      extra: recent ? h('p', { class: 'msg tone-bad' }, recent) : null,
    });
    if (!ok) return;
    let r;
    try {
      r = await api('POST', '/api/meet/new', { confirm: true });
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
    applyState(r);
    const m = r.newMeet || {};
    S.startListLoad = null;
    toast(`New meet started. The old reads are put away; a copy is in ${str(m.archive)}.${m.mergedNote ? ` The merged .lif files could not be copied: ${m.mergedNote}.` : ''}${Number(m.startLists) > 0 ? ` The start lists went with them: load the new meet's entry files on the Races page.` : ''}`, 'ok');
    loadMeetFiles(true);
    if (after) await after();
  });
}

/** The newest meet saved here, offered as one click ("Load "Fall Classic 2026""). */
const newestMeet = () => savedMeets(S.meetFiles.list)[0] || null;

/** One click on a saved meet: its preview. */
function savedMeetButton(f, { primary = false, fk = '' } = {}) {
  return h('button', { type: 'button', class: 'btn small suggest-btn' + (primary ? ' primary' : ''), 'data-fk': fk || 'meet-saved-' + str(f.fileName),
    onclick: (e) => startMeetLoad({ saved: f.fileName }, e.currentTarget) }, `Load "${savedMeetName(f, nowMs())}"`);
}

/**
 * Whether a race is running (isRunning, the server's own rule: Active with its gun, its clock under 30 minutes or reads
 * still arriving): the Races list then offers only Save and the Settings card (O7). A gun left from an earlier day with
 * no reads since is not running (O8).
 */
const anyRunning = (st) => arr(st?.config?.races).some((r) => r && str(r.gun).trim() && isRunning(viewOf(st, r.id), r, st, nowMs()));

/* ---------- Needs attention ---------- */

/**
 * Needs attention: problems (red, then amber), then decisions, then, when asked for, the notes. The first `cap` rows
 * show; "N more" opens the rest.
 */
function buildAttention(items, cap = 3) {
  const main = items.filter((w) => w.tone !== 'info' || w.decision);
  const notes = items.filter((w) => w.tone === 'info' && !w.decision);
  const listed = S.showNotes ? [...main, ...notes] : main;
  const shown = S.attAll ? listed : listed.slice(0, cap);
  const hiddenN = listed.length - shown.length;
  const problems = main.filter((w) => !w.decision);
  const notesBtn = notes.length ? disclosureButton({ open: S.showNotes, fk: 'att-notes', label: S.showNotes ? 'Hide notes' : plural(notes.length, 'note'),
    onToggle: () => { S.showNotes = !S.showNotes; savePref('showNotes', S.showNotes); scheduleRender(); } }) : null;
  if (!listed.length) {
    return h('section', { class: 'card attention all-clear', 'aria-label': 'Needs attention' },
      h('div', { class: 'att-ok' }, h('span', { class: 'i i-check', 'aria-hidden': 'true' }), h('span', {}, 'Nothing needs attention.'), h('span', { class: 'push-right' }, notesBtn)));
  }
  const bad = problems.some((w) => w.tone === 'bad');
  return h('section', { class: 'card attention', 'aria-labelledby': 'att-h' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'att-h', class: 'title-row', tabindex: '-1', 'data-fk': 'att-h' }, 'Needs attention',
        problems.length ? h('span', { class: `nav-badge tone-${bad ? 'bad' : 'warn'}` }, fmtInt(problems.length)) : null),
      h('div', { class: 'row' }, notesBtn)),
    attentionList(shown),
    hiddenN > 0 || (S.attAll && listed.length > cap)
      ? h('div', { class: 'att-more' }, disclosureButton({ open: S.attAll, fk: 'att-all', label: S.attAll ? 'Show fewer' : `${fmtInt(hiddenN)} more`,
        onToggle: () => { S.attAll = !S.attAll; scheduleRender(); } }))
      : null);
}

/**
 * The one "show more" control of the page: a chevron and a label; the chevron turns when it is open.
 * @param {{ open: boolean, label: string, onToggle: () => void, fk?: string, controls?: string, cls?: string }} o
 */
function disclosureButton({ open, label, onToggle, fk = null, controls = null, cls = '' }) {
  return h('button', { type: 'button', class: `disclosure local${cls ? ' ' + cls : ''}`, 'aria-expanded': String(!!open), 'aria-controls': controls, 'data-fk': fk, onclick: onToggle },
    h('span', { class: 'i i-chevron', 'aria-hidden': 'true' }), label);
}

/* ---------- race tiles ---------- */

function renderRaceTiles(st) {
  const races = arr(st.config.races);
  const active = races.filter((r) => r.active !== false);
  const layout = JSON.stringify([active.map((r) => r.id), races.length > 0, !races.length && setupShown(st)]);
  if (EL.dashRaces._layout !== layout) {
    EL.dashRaces._layout = layout;
    EL.tiles = new Map();
    EL.nextRaces = h('div');
    if (!races.length && setupShown(st)) EL.dashRaces.replaceChildren();
    else if (!races.length) {
      EL.dashRaces.replaceChildren(h('div', { class: 'card empty-state' },
        h('h2', {}, 'No races yet'),
        h('p', {}, 'Add a race with its RR12 port and its number of splits. Its split counts and gun time show here.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#races/new' }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'New race'))));
    } else {
      const grid = h('div', { class: 'races-grid' });
      for (const r of active) {
        const slot = h('div', { class: 'race-slot' });
        EL.tiles.set(r.id, slot);
        grid.append(slot);
      }
      EL.dashRaces.replaceChildren(...(active.length ? [grid] : [h('div', { class: 'card empty-state' },
        h('h2', {}, 'No race is Active'),
        h('p', {}, 'Make the race that is running Active: it then takes the reads of its RR12 port.'))]), EL.nextRaces);
    }
  }
  const supported = reviewSupported(st);
  // what the tiles show besides their race: each output's light (their chips) and each port's connection
  const outs = JSON.stringify(arr(st.config.outputs).map((o) => {
    const l = lightOf(st, o);
    return [o.id, o.name, o.enabled, o.races, l.tone, l.word, isTrackScoreLike(o, outputStatus(st, o.id))];
  }));
  const ports = JSON.stringify(inputsOf(st).map((i) => [i.port, arr(i.connections).length > 0]));
  // "No names" on each tile while the split packets go without names (DESIGN 9.20 N1)
  const gap = namesGap(st);
  for (const r of active) {
    const slot = EL.tiles?.get(r.id);
    if (!slot) continue;
    const rv = viewOf(st, r.id);
    const sig = JSON.stringify([r, rv && { ...rv, elapsedTicks: 0 }, supported, inputPorts(st).length, outs, ports, gunGone(rv, st, nowMs()), S.tileGuns.get(r.id) || null,
      gap.missing && [gap.why, gap.sent.some((x) => x.id === r.id)],
      S.offerDismissed.get(r.id) || null, S.leftoverDismissed.get(r.id) || null, S.resendOffers.get(r.id) || null, S.columnChanges.get(r.id) || null,
      [...S.playing].filter((k) => k.startsWith(r.id + '|')), [...S.more].filter((k) => k.includes(r.id))]);
    guard(slot, () => paintSig(slot, sig, () => raceTile(st, r, supported, gap)));
  }
  const off = races.filter((r) => r.active === false);
  if (EL.nextRaces) paintSig(EL.nextRaces, JSON.stringify([off.map((r) => [r.id, r.name, r.inputPort, viewOf(st, r.id)?.runners]), races.map((r) => [r.id, r.active, r.inputPort, r.contests])]), () => nextRaces(st, off));
}

function raceTile(st, cfg, supported, gap = namesGap(st)) {
  const rv = viewOf(st, cfg.id) || { id: cfg.id, name: cfg.name, splits: [], gunTicks: null };
  const viewSplits = new Map(arr(rv.splits).map((s) => [s.id, s]));
  const splits = arr(cfg.splits).map((s) => ({ ...s, ...(viewSplits.get(s.id) || {}) }));
  const n = splits.length;
  const c = reviewCounts(rv);
  // (9.25: the athletes who are not in this race are not its runners: counted apart, quietly)
  const away = Math.min(c.away || 0, Number(rv.runners) || 0);
  const runners = (Number(rv.runners) || 0) - away;
  const titleId = 'rt-' + cfg.id;
  const href = '#races/' + enc(cfg.id);
  const offer = visiblePrompt(cfg.id, rv);
  const editing = !!S.tileGuns.get(cfg.id)?.editing || !Number.isFinite(rv.gunTicks);
  // the race's RR12 port: said on the tile when nothing is connected to it (red once the race has started)
  const port = portNum(cfg.inputPort);
  const portIn = port != null ? inputsOf(st).find((i) => Number(i.port) === port) : null;
  const portOff = !!portIn && !arr(portIn.connections).length;
  const portTone = portOff ? (gunGone(rv, st, nowMs()) ? 'bad' : 'warn') : '';
  // (9.26: "9 splits + 2 not sent": the number TrackScore and Karmarush are set up with, then the ones only counted)
  const meta = [eventLabel(cfg).replace(/^Event /, '') || 'No event', port != null ? `Port ${port}${portOff ? ' not connected' : ''}` : 'By contest', splitsWord(splits), plural(runners, 'runner')];
  return h('article', { class: 'card race-tile', 'aria-labelledby': titleId },
    h('div', { class: 'rt-head' },
      h('div', { class: 'rt-title' },
        h('h2', { id: titleId, title: cfg.name || '' }, cfg.name || '(no name)'),
        h('p', { class: 'rt-meta', title: [...meta, away ? `${fmtInt(away)} not in this race` : ''].filter(Boolean).join(' · ') },
          h('span', {}, meta[0]), ' · ',
          h('span', { class: portTone ? `tone-text-${portTone}` : null }, meta[1]), ' · ',
          h('span', {}, meta[2]), ' · ', h('span', { title: rv.startList?.entered ? rv.startList.text : null }, meta[3]),
          away ? [' · ', h('span', { title: 'Athletes read here who are entered in another race, or whom you set apart: counted and shown in Review, not sent.' }, `${fmtInt(away)} not in this race`)] : null)),
      h('div', { class: 'rt-acts' },
        c.known ? reviewChip(cfg, rv) : null,
        h('a', { class: 'btn small ghost icon-btn', href, 'data-fk': 'rt-edit-' + cfg.id, title: 'Race settings', 'aria-label': `Settings of ${cfg.name || 'this race'}` },
          h('span', { class: 'i i-gear', 'aria-hidden': 'true' })))),
    h('div', { class: 'rt-line' + (editing ? ' editing' : '') },
      gunLine(cfg, rv),
      editing ? null : outputChips(st, cfg),
      editing ? null : namesChip(cfg, gap),
      editing ? null : h('span', { class: 'rt-last' }, agoSpan(rv.lastReadAt, { prefix: 'Last read ', never: 'No reads yet' }))),
    h('div', { class: 'splits', role: 'list', 'aria-label': `${cfg.name || 'Race'}: splits` },
      n ? splits.map((s, i) => splitTile(cfg, s, i, n, runners, supported, splits))
        : h('p', { class: 'help' }, 'No splits set. ', h('a', { href: href + '/splits' }, 'Set the number of splits')),
      (arr(cfg.finishSources).length || rv.finished) ? finishTile(rv, runners) : null),
    offer ? offerBox(cfg.id, offer) : leftoverBox(cfg.id, rv));
}

/**
 * Where this race's splits go, on its tile: each output that sends it, with its light, and "Not on TrackScore" when a
 * TrackScore output shows another race.
 */
function outputChips(st, cfg) {
  const chips = [];
  for (const o of arr(st.config.outputs)) {
    if (o.enabled === false) continue;
    const name = str(o.name) || 'Output';
    if (outputSendsRace(o, cfg.id)) {
      const l = lightOf(st, o);
      chips.push(h('a', { class: `out-chip tone-${l.tone}`, href: '#outputs/' + enc(o.id), title: `${name}: ${l.title}` },
        h('span', { class: 'dot', 'aria-hidden': 'true' }), name, l.word ? h('span', { class: 'out-chip-word' }, l.word) : null));
    } else if (isTrackScoreLike(o, outputStatus(st, o.id))) {
      const gets = arr(o.races).map((rid) => configRace(st, rid)?.name).filter(Boolean);
      chips.push(h('span', { class: 'out-chip not-on', title: `${name} shows ${gets.length ? listText(gets) : 'another race'}, not this one.` }, `Not on ${name}`));
    }
  }
  return chips.length ? h('span', { class: 'out-chips' }, h('span', { class: 'sr-only' }, 'Sent to: '), chips) : null;
}

/**
 * "No names" on a race tile while the split packets go without names (DESIGN 9.20 N1): red once this race's splits went
 * out like that. One click opens the file picker.
 */
function namesChip(cfg, gap) {
  if (!gap?.missing) return null;
  const sent = gap.sent.find((x) => x.id === cfg.id);
  const tone = sent ? 'bad' : 'warn';
  const what = gap.why === 'unread' ? "The names file can't be read" : 'No names file';
  const title = `${what}: ${sent ? `new splits go out with bibs only (this race has sent ${plural(sent.sent, 'split')})` : 'the splits go out with bibs only'}. Click to choose the meet's names file (.ppl).`;
  return h('button', { type: 'button', class: `out-chip names-chip tone-${tone}`, 'data-fk': 'rt-names-' + cfg.id, title, 'aria-label': title,
    onclick: (e) => chooseNamesFile(e.currentTarget) },
  h('span', { class: 'i i-alert', 'aria-hidden': 'true' }), 'No names');
}

/** One split point: crossed (of the runners seen), a thin bar, and its Pause / Play (DESIGN 9.17 P1). */
function splitTile(cfg, s, i, n, runners, supported, splits = null) {
  const on = splitSending(s);
  const name = s.name || defaultSplitName(i);
  // (9.25: without the crossings of athletes who are not in this race)
  const count = Math.max(0, (Number(s.crossings) || 0) - (Number(s.away) || 0));
  const held = splitHeld(s);
  // the first split is a plain count: "runners seen" are counted from it, so a bar would always be full
  const first = i === 0;
  const pct = runners ? Math.min(100, Math.round((count / runners) * 100)) : 0;
  // DESIGN 9.26: a split point that is counted, not sent: the same tile, muted: its count, "Not sent", no Pause
  if (notSent(s)) {
    return h('div', { class: 'split-tile not-sent' + (count ? '' : ' zero'), role: 'listitem',
      title: `${name}: ${fmtInt(count)} counted. Not sent: nothing of this split goes to TrackScore, Karmarush or the merged .lif file. It is counted so the later splits stay right (Send is off for it on the race's page).` },
    h('div', { class: 'st-top' },
      h('span', { class: 'st-name' }, name),
      h('span', { class: 'st-sub' }, 'Not sent')),
    h('div', { class: 'st-mid' },
      h('span', { class: 'st-count' }, fmtInt(count)),
      h('span', { class: 'st-tag' }, 'counted')),
    h('div', { class: 'st-bar none', 'aria-hidden': 'true' }));
  }
  // (9.26: laps to go by the splits that are sent)
  const l2g = splits ? sentLapsToGo(splits, i) : lapsToGo(i, n);
  return h('div', { class: 'split-tile' + (count ? '' : ' zero') + (on ? '' : ' paused'), role: 'listitem',
    title: on ? `${name}: ${fmtInt(count)} crossed${first ? '' : ` of the ${fmtInt(runners)} runners seen`}. Sent with laps to go ${l2g}.` : `${name} is paused: its splits are kept, not sent and not in the .lif file, until you press Play.` },
  h('div', { class: 'st-top' },
    h('span', { class: 'st-name' }, name),
    h('span', { class: 'st-sub' }, on ? (toMs(s.lastAt) ? agoSpan(s.lastAt) : 'No reads yet') : pausedText(held))),
  h('div', { class: 'st-mid' },
    h('span', { class: 'st-count' }, fmtInt(count), !first && runners ? h('small', {}, `/${fmtInt(runners)}`) : null),
    s.id && supported ? pauseButton(cfg.id, s, held, 'tile') : null),
  h('div', { class: 'st-bar' + (first ? ' none' : ''), 'aria-hidden': 'true' }, first ? null : h('span', { style: `width:${pct}%` })));
}

function finishTile(rv, runners) {
  const n = Number(rv.finished) || 0;
  const pct = runners ? Math.min(100, Math.round((n / runners) * 100)) : 0;
  return h('div', { class: 'split-tile finish' + (n ? '' : ' zero'), role: 'listitem', title: 'Runners FinishLynx has finished. Finishes are never sent: FinishLynx sends them.' },
    h('div', { class: 'st-top' }, h('span', { class: 'st-name' }, 'Finished')),
    h('div', { class: 'st-mid' },
      h('span', { class: 'st-count' }, fmtInt(n), runners ? h('small', {}, `/${fmtInt(runners)}`) : null)),
    h('div', { class: 'st-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${pct}%` })));
}

/** The race's Review entry: the same button always, with what waits there ("Review 4"; a grey 0 when nothing). */
function reviewChip(cfg, rv) {
  const c = reviewCounts(rv);
  const total = c.missing + c.checks + c.finishedNotSent + c.flagged + (c.strange || 0);
  const text = reviewBadgeText(c);
  return h('a', { class: 'btn small review-chip', href: `#review/${enc(cfg.id)}`, 'data-fk': 'rc-review-' + cfg.id,
    title: text || 'Nothing to review', 'aria-label': `Review ${cfg.name || 'this race'}${text ? `: ${text}` : ': nothing waits'}` },
  h('span', { class: 'i i-review', 'aria-hidden': 'true' }), 'Review',
  h('span', { class: `nav-badge tone-${total ? reviewTone(c) : 'muted'}`, 'aria-hidden': 'true' }, fmtInt(total)));
}

/* ---------- the gun, in place on the tile ---------- */

const tileGunState = (id) => {
  if (!S.tileGuns.has(id)) S.tileGuns.set(id, { text: '', error: '', editing: false });
  return S.tileGuns.get(id);
};

function openTileGun(id) {
  const rv = viewOf(S.state, id);
  const g = tileGunState(id);
  g.editing = true;
  g.error = '';
  g.text = rv?.gunText || '';
  focusKey('tg-input-' + id);
}

function closeTileGun(id) {
  const was = S.tileGuns.get(id);
  S.tileGuns.delete(id);
  if (was?.editing) focusKey('tg-edit-' + id);
  scheduleRender();
}

/** The gun on a race tile: its time of day (no running clock), or a box to set it. */
function gunLine(cfg, rv) {
  const id = cfg.id;
  const gunSet = Number.isFinite(rv.gunTicks);
  const g = S.tileGuns.get(id);
  const editing = !!g?.editing;
  if (gunSet && !editing) {
    return h('div', { class: 'gunline' },
      h('span', { class: 'eyebrow' }, 'Gun'),
      h('span', { class: 'gun-value' }, rv.gunText || formatTod(rv.gunTicks)),
      gunDiffers(rv) ? h('span', { class: 'lynx-note', title: 'The gun differs from the FinishLynx start.' }, `FinishLynx ${formatTod(rv.lynxStart, 3)}`) : null,
      h('button', { type: 'button', class: 'btn small ghost icon-btn', 'data-fk': 'tg-edit-' + id, title: 'Change the gun time',
        'aria-label': `Change the gun time of ${cfg.name || 'this race'}`, onclick: () => openTileGun(id) }, h('span', { class: 'i i-edit', 'aria-hidden': 'true' })));
  }
  const waiting = waitingCount(rv);
  const inputId = 'tg-input-' + id;
  const input = h('input', { type: 'text', class: 'mono', id: inputId, 'data-fk': inputId, value: g?.text || '', placeholder: '10:00:00.000', inputmode: 'decimal',
    autocomplete: 'off', spellcheck: 'false', 'aria-invalid': g?.error ? 'true' : 'false', 'aria-describedby': g?.error ? inputId + '-err' : null });
  input.addEventListener('input', () => {
    const s = tileGunState(id);
    s.text = input.value;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitTileGun(id, input, input);
    } else if (e.key === 'Escape' && editing) {
      e.preventDefault();
      closeTileGun(id);
    }
  });
  return h('div', { class: 'gunline gun-edit' + (gunSet ? '' : ' unset') },
    // the label is short while a gun is changed (the box says it), so Set and FinishLynx stay on one line. The gun is only
    // ever what the operator types (race day 2026-10-21: "Set to now" put the PC's clock in by accident, so it is gone)
    h('label', { class: 'eyebrow' + (gunSet ? ' sr-only' : ''), for: inputId }, gunSet ? 'New gun time' : waiting ? `Gun not set · ${fmtInt(waiting)} waiting` : 'Gun not set'),
    input,
    h('span', { class: 'seg' },
      h('button', { type: 'button', class: 'btn small primary', 'data-fk': 'tg-set-' + id, onclick: (e) => submitTileGun(id, input, e.currentTarget) }, 'Set'),
      // FinishLynx's start only goes into the box: the gun is set when the operator presses Set
      Number.isFinite(rv.lynxStart) ? h('button', { type: 'button', class: 'btn small', 'data-fk': 'tg-lynx-' + id, title: `Put the FinishLynx start, ${formatTod(rv.lynxStart, 4)}, in the box`,
        onclick: () => {
          input.value = formatTod(rv.lynxStart, 4);
          tileGunState(id).text = input.value;
          input.focus();
        } }, 'FinishLynx') : null),
    editing ? h('button', { type: 'button', class: 'btn small ghost icon-btn', 'data-fk': 'tg-cancel-' + id, title: 'Cancel (Esc)', 'aria-label': 'Cancel: keep the gun time', onclick: () => closeTileGun(id) },
      h('span', { class: 'i i-close', 'aria-hidden': 'true' })) : null,
    g?.error ? h('p', { class: 'field-error', id: inputId + '-err', role: 'alert' }, g.error) : null);
}

async function submitTileGun(id, input, btn) {
  const g = tileGunState(id);
  g.text = input.value;
  const text = input.value.trim();
  const ticks = parseGunText(text);
  g.error = !text ? 'Type the gun time first.' : ticks == null ? "That isn't a time of day. Type it like 10:00:00 or 10:00:00.000." : '';
  if (g.error) {
    focusKey('tg-input-' + id);
    return;
  }
  const rv = viewOf(S.state, id);
  if (rv && rv.gunTicks === ticks) {
    toast(`The gun time is already ${rv.gunText || text}.`, 'info');
    closeTileGun(id);
    return;
  }
  if (await setGun(id, { gun: text }, text, btn, { newTicks: ticks })) closeTileGun(id);
}

/* ---------- pause and play ---------- */

/**
 * A split's Pause / Play button (DESIGN 9.17 P1). One click, no dialog: pausing loses nothing (the crossings are kept
 * and counted) and Play undoes it. Both states are the same size, an icon and a word, so the control never changes
 * shape under the pointer. `prefix` keeps the focus key apart on the tile, the race page and Review.
 * @param {string} raceId
 * @param {any} s config split
 * @param {number} held crossings the split holds back
 * @param {string} prefix
 */
function pauseButton(raceId, s, held, prefix) {
  const on = splitSending(s);
  const name = s.name || 'this split';
  const fk = `${prefix}-pause-${s.id}`;
  // Play first reads FinishLynx's folder (up to 3 s), so a runner who finished a moment ago keeps the finish place
  if (!on && splitPlaying(raceId, s.id)) {
    return h('button', { type: 'button', class: 'btn small pause-btn play', 'data-fk': fk, disabled: true, 'aria-busy': 'true',
      'aria-label': `Playing ${name}: reading FinishLynx's results first`, title: PLAYING_TITLE },
    h('span', { class: 'i i-play', 'aria-hidden': 'true' }), 'Playing…');
  }
  return h('button', {
    type: 'button', class: 'btn small pause-btn' + (on ? '' : ' play'), 'data-fk': fk,
    'aria-label': on ? `Pause ${name}: keep its splits, send nothing` : `Play ${name}: send the ${plural(held, 'split')} it holds`,
    title: on ? `Pause ${name}: its splits are kept, but not sent and not written to the .lif file, until you press Play.` : `Play ${name}: what it holds goes out now.`,
    onclick: (e) => setSplitSending(raceId, s.id, !on, e.currentTarget, fk),
  }, h('span', { class: `i i-${on ? 'pause' : 'play'}`, 'aria-hidden': 'true' }), on ? 'Pause' : 'Play');
}

/** The tooltip of a split's button while Play reads FinishLynx's folder first (revision 10). */
export const PLAYING_TITLE = "Playing: Split Relay first reads FinishLynx's results (a few seconds at most), so a runner who finished a moment ago keeps the finish place in TrackScore. Then what the split held goes out.";

/** Whether Play is under way for a split: this panel pressed it, or Split Relay says so (another panel did). */
function splitPlaying(raceId, splitId) {
  return S.playing.has(`${raceId}|${splitId}`)
    || arr(viewOf(S.state, raceId)?.splits).some((x) => x && x.id === splitId && x.playing === true);
}

/** POST .../splits/:splitId/sending: pause or play a split, and say what that does. */
async function setSplitSending(raceId, splitId, on, btn, fk) {
  const s = arr(configRace(S.state, raceId)?.splits).find((x) => x.id === splitId);
  const held = splitHeld(arr(viewOf(S.state, raceId)?.splits).find((x) => x.id === splitId));
  // what Play really did is worked out from the race before and after: held splits of runners who finished
  // meanwhile go to Review ("Finished: not sent live") instead of out
  const finBefore = Number(viewOf(S.state, raceId)?.finishedNotSent) || 0;
  const key = `${raceId}|${splitId}`;
  if (on && S.playing.has(key)) return;
  // "Playing…" while Split Relay reads FinishLynx's folder before it sends what the split held (revision 10)
  if (on) {
    S.playing.add(key);
    scheduleRender();
  }
  let r;
  try {
    r = await reviewAct(() => api('POST', REVIEW_API.sending(raceId, splitId), { on }), btn);
  } finally {
    if (on) {
      S.playing.delete(key);
      scheduleRender();
    }
  }
  if (r === undefined) return;
  const st = stateIn(r);
  if (st) applyState(st);
  else await refreshState().catch(() => {});
  // the button is drawn again with the other word; focus stays on it, so Play is one key away
  if (fk) focusKey(fk);
  let after = null;
  if (on && st) {
    const toReview = Math.max(0, (Number(viewOf(S.state, raceId)?.finishedNotSent) || 0) - finBefore);
    after = { toReview, sent: Math.max(0, held - toReview) };
  }
  toast(sendingToast(s?.name || 'The split', on, held, destinations(S.state, raceId), after), on ? (after?.toReview ? 'info' : 'ok') : 'warn', undefined,
    after?.toReview ? { action: { label: 'Review', run: () => go(`#review/${enc(raceId)}`) } } : {});
  reviewChanged(raceId);
}

/* ---------- resend offers ---------- */

const promptSig = (p) => JSON.stringify(p ? [p.count, p.byOutput, p.columns || null] : null);

/** The resend prompt for a race unless the operator said "Not now" to exactly this one. */
function visiblePrompt(id, rv) {
  const p = resendPrompt(rv, S.resendOffers.get(id), S.columnChanges.get(id) || null);
  if (!p) {
    S.offerDismissed.delete(id);
    // nothing is out of date any more (resent, or put back): a later prompt has its own reason. A State from just
    // after the save may not show the stale splits yet, so a fresh change is kept a moment.
    const c = S.columnChanges.get(id);
    if (c && Date.now() - c.at > 10000) S.columnChanges.delete(id);
    return null;
  }
  return S.offerDismissed.get(id) === promptSig(p) ? null : p;
}

/**
 * The cells a Resend can't correct (DESIGN 9.16 F1), on the race tile once nothing is left to resend: said once, with
 * "Got it", and again only when the count or the runners change. Nothing is done in TrackScore.
 */
function leftoverBox(id, rv) {
  const text = leftoverText(rv?.leftover);
  if (!text) {
    S.leftoverDismissed.delete(id);
    return null;
  }
  const sig = JSON.stringify([rv.leftover.count, arr(rv.leftover.runners)]);
  if (S.leftoverDismissed.get(id) === sig) return null;
  const n = Number(rv.leftover.count) || 0;
  const [btn, body] = moreParts('lo-' + id, text, 'Which cells, and why');
  return h('div', { class: 'offer leftover', role: 'status' },
    h('p', {}, `TrackScore may still show ${plural(n, 'old cell')} that Split Relay can't clear.`, btn),
    h('div', { class: 'offer-actions' },
      h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'leftover-ok-' + id, onclick: () => {
        S.leftoverDismissed.set(id, sig);
        scheduleRender();
      } }, 'Got it')),
    body);
}

function offerBox(id, prompt, where = 'tile') {
  const [head, limit] = resendPromptParts(prompt);
  const short = prompt.columns ? 'Splits sent are in the wrong columns.'
    : prompt.count ? `${plural(prompt.count, 'split')} sent ${prompt.count === 1 ? 'is' : 'are'} out of date${staleWhere(prompt)}.` : 'Splits sent are out of date.';
  const [btn, body] = moreParts(`offer-${where}-${id}`, [head, limit].filter(Boolean), 'Why, and what a resend can fix');
  return h('div', { class: 'offer', role: 'status' },
    h('p', {}, h('strong', {}, short), btn),
    h('div', { class: 'offer-actions' },
      h('button', { type: 'button', class: 'btn small primary', 'data-fk': 'offer-resend-' + id, onclick: (e) => resendRace(id, e.currentTarget) }, 'Resend splits…'),
      h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'offer-no-' + id, onclick: () => {
        S.resendOffers.delete(id);
        if (prompt.server) S.offerDismissed.set(id, promptSig(prompt));
        scheduleRender();
      } }, 'Not now')),
    body);
}

/**
 * The races that are not Active, and a one-click "Switch to" for the ones that have not run yet: between two races on
 * one RR12 port that is the race-day step (DESIGN 9.15 L3, POST /api/races/:id/activate).
 */
function nextRaces(st, off) {
  if (!off.length) return null;
  const next = off.filter((r) => !(Number(viewOf(st, r.id)?.runners) > 0)).slice(0, 4);
  return h('div', { class: 'card next-races' },
    h('span', { class: 'eyebrow' }, 'Not Active'),
    h('span', {}, listText(off.map((r) => r.name || '(no name)'), 6)),
    h('span', { class: 'help inline' }, 'Their reads are kept; nothing is sent.'),
    h('span', { class: 'row push-right' },
      next.map((r) => {
        const plan = switchPlan(st, r.id);
        const name = r.name || '(no name)';
        return h('button', { type: 'button', class: 'btn small', 'data-fk': 'sw-' + r.id, onclick: (e) => switchToRace(r.id, e.currentTarget) },
          plan?.off.length ? `Switch to ${name}…` : `Make ${name} Active…`);
      }),
      h('a', { class: 'btn small ghost', href: '#races/' + enc(off[0].id) }, 'Races')));
}

/* ---------- feed ---------- */

function buildFeedSection() {
  const f = S.feedFilter;
  EL.feedChips = h('div', { class: 'seg seg-filter', role: 'group', 'aria-label': 'Show the reads of' });
  EL.feedToggles = h('div', { class: 'chips-bar', role: 'group', 'aria-label': 'Which reads' });
  const search = h('input', { id: 'feed-search', 'data-fk': 'feed-search', type: 'search', placeholder: 'Bib, name or team', autocomplete: 'off', value: f.search, 'aria-label': 'Search the feed (/)',
    oninput: (e) => setFilter({ search: e.target.value }) });
  // "Freeze" holds the list still to read it; a split's Pause is something else (it stops sending)
  EL.feedPause = h('button', { type: 'button', class: 'btn small local', 'aria-pressed': 'false', 'data-fk': 'feed-pause', title: 'Hold the list still while you read it', onclick: () => {
    S.feedPaused = S.feedPaused ? null : S.feed.list().slice();
    scheduleRender();
  } }, h('span', { class: 'i i-freeze', 'aria-hidden': 'true' }), h('span', { class: 'feed-pause-label' }, 'Freeze list'));
  EL.feedInfo = h('p', { class: 'feed-info', role: 'status' });
  EL.feedBody = h('div', { class: 'feed-body' });
  EL.feedMore = h('div', { class: 'feed-more' });
  // one tab stop for the whole list: the arrow keys move between rows, Enter opens a row
  EL.feedBody.addEventListener('keydown', feedKeys);
  // the race choice (one control that never splits) beside the title; the on/off filters and the tools at the right,
  // on a line of their own when the card is narrow
  return h('section', { class: 'card feed-card', 'aria-labelledby': 'feed-title' },
    h('div', { class: 'card-head' },
      h('h2', { id: 'feed-title' }, 'Live feed'),
      EL.feedChips,
      h('div', { class: 'feed-tools' }, EL.feedToggles, search, EL.feedPause,
        h('a', { href: '#help/glossary', class: 'btn small ghost icon-btn', title: 'What the status words mean', 'aria-label': 'What the status words mean' }, h('span', { class: 'i i-help', 'aria-hidden': 'true' })))),
    EL.feedInfo, EL.feedBody, EL.feedMore);
}

/** Arrow keys, Home and End move between the feed's rows; Enter or Space opens a row's detail. */
function feedKeys(e) {
  const row = e.target.closest?.('tr.feed-row');
  if (!row || e.target !== row) return;
  const rows = [...EL.feedBody.querySelectorAll('tr.feed-row')];
  const i = rows.indexOf(row);
  let to = null;
  if (e.key === 'ArrowDown') to = rows[i + 1];
  else if (e.key === 'ArrowUp') to = rows[i - 1];
  else if (e.key === 'Home') to = rows[0];
  else if (e.key === 'End') to = rows[rows.length - 1];
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    row.click();
    return;
  } else return;
  e.preventDefault();
  if (!to) return;
  row.tabIndex = -1;
  to.tabIndex = 0;
  S.feedActive = to.dataset.id;
  to.focus();
}

function setFilter(patch) {
  Object.assign(S.feedFilter, patch);
  savePref('feedFilter', { ...S.feedFilter, search: '' });
  scheduleRender();
}

function renderFeed() {
  const st = S.state;
  const races = arr(st.config.races);
  const f = S.feedFilter;
  const opts = [['', 'All races'], ...races.filter((r) => r.active !== false).map((r) => [r.id, r.name || '(no name)']),
    ...races.filter((r) => r.active === false).map((r) => [r.id, r.name || '(no name)']), [NO_RACE, 'No race']];
  if (!opts.some(([v]) => v === f.raceId)) f.raceId = '';
  paintSig(EL.feedChips, JSON.stringify([opts, f.raceId]), () => opts.map(([v, l]) => h('button', {
    type: 'button', class: 'seg-btn local', 'aria-pressed': String(f.raceId === v), 'data-fk': 'fc-' + (v || 'all'), onclick: () => setFilter({ raceId: v }),
  }, l)));
  // on/off filters: a box that shows a tick when on, so they don't look like the race choice
  paintSig(EL.feedToggles, JSON.stringify([f.problemsOnly, f.showFiltered]), () => [
    h('button', { type: 'button', class: 'fchip toggle local', 'aria-pressed': String(!!f.problemsOnly), 'data-fk': 'ft-problems', title: 'Only reads that need a look (amber and red)',
      onclick: () => setFilter({ problemsOnly: !f.problemsOnly }) }, h('span', { class: 'tick', 'aria-hidden': 'true' }, h('span', { class: 'i i-check' })), 'Problems only'),
    h('button', { type: 'button', class: 'fchip toggle local', 'aria-pressed': String(!!f.showFiltered), 'data-fk': 'ft-filtered', title: 'Also show backup, duplicate, repeat and start-area reads',
      onclick: () => setFilter({ showFiltered: !f.showFiltered }) }, h('span', { class: 'tick', 'aria-hidden': 'true' }, h('span', { class: 'i i-check' })), 'Filtered reads'),
  ]);
  const paused = !!S.feedPaused;
  const source = paused ? S.feedPaused : S.feed.list();
  const { rows: all, hidden } = filterFeed(source, f, 200);
  const newer = paused ? Math.max(0, S.feed.size - S.feedPaused.length) : 0;
  const pl = paused ? `Unfreeze${newer ? ` (${fmtInt(newer)} new)` : ''}` : 'Freeze list';
  const plEl = EL.feedPause.querySelector('.feed-pause-label');
  if (plEl.textContent !== pl) plEl.textContent = pl;
  EL.feedPause.setAttribute('aria-pressed', String(paused));
  EL.feedPause.classList.toggle('on', paused);
  const rows = all.slice(0, S.feedLimit);
  const info = [
    paused ? `List frozen${newer ? `: ${plural(newer, 'newer read')} not shown` : ''}.` : '',
    hidden ? `${plural(hidden, 'filtered read')} hidden.` : '',
  ].filter(Boolean).join(' ');
  if (EL.feedInfo.textContent !== info) EL.feedInfo.textContent = info;
  // with two RR12 exporters, each read says which port it came in on
  const multi = inputPorts(st).length > 1;
  const open = rows.filter((e) => S.feedOpen.has(String(e.id))).map((e) => e.id);
  if (!rows.some((e) => String(e.id) === S.feedActive)) S.feedActive = rows.length ? String(rows[0].id) : '';
  const sig = JSON.stringify([rows, S.feed.size === 0, multi, open, S.feedActive]);
  paintSig(EL.feedBody, sig, () => {
    if (!rows.length) {
      return h('p', { class: 'empty-feed' }, S.feed.size
        ? 'No reads match these filters.'
        : `No reads yet. In RR12, press play on the Split Relay exporter (it sends to ${rrTarget(st, firstPort(st))}). Reads show here the moment they arrive.`);
    }
    return h('table', { class: 'feed feed-main', 'aria-label': 'Live feed of reads (arrow keys move between rows, Enter opens one)' },
      h('thead', {}, h('tr', {},
        [['Status', 'col-status'], ['Time', 'col-time'], ['Race', 'col-race'], ['Split', 'col-split'], ['Bib', 'num col-bib'], ['Name', 'col-name'], ['Race time', 'num col-rt'], ['Place', 'num col-place'], ['', 'col-x']]
          .map(([t, c]) => h('th', { scope: 'col', class: c || null }, t ? t : h('span', { class: 'sr-only' }, 'Details'))))),
      h('tbody', {}, rows.map((e) => feedRows(e, multi))));
  });
  // a long list grows the page on request, never inside a box of its own (one scroll for the whole page)
  const more = all.length - rows.length;
  paintSig(EL.feedMore, JSON.stringify([more, rows.length, S.feedLimit > 60, all.length >= 200]), () => (more > 0
    ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 'feed-more', onclick: () => { S.feedLimit = Math.min(200, S.feedLimit + 70); scheduleRender(); } },
      `Show ${fmtInt(Math.min(more, 70))} more`, h('span', { class: 'muted' }, ` (${fmtInt(rows.length)} of ${fmtInt(all.length)}${all.length >= 200 ? ', the newest 200' : ''})`))
    : S.feedLimit > 60 ? h('button', { type: 'button', class: 'btn small ghost local', 'data-fk': 'feed-fewer', onclick: () => { S.feedLimit = 60; scheduleRender(); } }, 'Show fewer') : null));
}

function feedRows(e, multi = false) {
  const info = statusInfo(e.status);
  const key = String(e.id);
  const open = S.feedOpen.has(key);
  const flip = () => {
    if (S.feedOpen.has(key)) S.feedOpen.delete(key);
    else S.feedOpen.add(key);
    S.feedActive = key;
    S.focusAfter = 'fr-' + key;
    scheduleRender();
  };
  const time = Number.isFinite(e.tod) ? formatTod(e.tod, 3) : formatWall(toMs(e.at));
  const loc = str(e.location);
  const split = str(e.splitName);
  const row = h('tr', { class: `feed-row tone-row-${info.tone}${open ? ' open' : ''}`, title: e.detail ? `${info.label}: ${e.detail}` : info.label,
    tabindex: key === S.feedActive ? '0' : '-1', 'data-fk': 'fr-' + key, 'data-id': key, 'aria-expanded': String(open),
    onclick: (ev) => { if (!ev.target.closest('button, a')) flip(); } },
  h('td', { class: 'col-status' }, statusWord(e.status, e.detail, { short: true })),
  h('td', { class: 'mono col-time' }, time),
  h('td', { class: 'col-race' }, e.raceName || (e.raceId ? '' : '—')),
  h('td', { class: 'col-split' }, split || loc || '—'),
  // 9.23 F1: the bib opens the runner (its own button: the row still opens its detail)
  // (9.27: a read that counts for the other bib of a swapped pair says what it came in as)
  h('td', { class: 'num col-bib' }, e.raceId && e.bib ? runnerBibButton(e.raceId, str(e.bib), { cls: 'bib-btn feed-bib' }) : str(e.bib),
    e.readAs ? h('span', { class: 'read-as', title: `This read came in as bib ${str(e.readAs)}: bibs ${str(e.bib)} and ${str(e.readAs)} are swapped` }, `read as ${str(e.readAs)}`) : null),
  h('td', { class: 'col-name' }, str(e.name)),
  h('td', { class: 'num col-rt' }, Number.isFinite(e.raceTicks) ? formatRaceTime(e.raceTicks, 1) : ''),
  h('td', { class: 'num col-place' }, e.place == null || e.place === '' ? '' : str(e.place)),
  h('td', { class: 'col-x' },
    // DESIGN 9.17 P2: a held pass is decided in Review; one click opens it on this runner
    e.status === 'check-column' && e.raceId ? h('button', { type: 'button', class: 'btn small', tabindex: '-1', 'data-fk': `feed-review-${e.id}`,
      'aria-label': `Check bib ${str(e.bib)} in Review`, onclick: (ev) => openReview(e.raceId, { bib: str(e.bib) }, ev.currentTarget) }, 'Check') : null,
    h('span', { class: 'i i-chevron row-chev', 'aria-hidden': 'true' })));
  if (!open) return row;
  return [row, h('tr', { class: 'feed-detail' }, h('td', { colspan: '9' }, h('div', { class: 'feed-detail-body' },
    statusWord(e.status, '', { boxed: true }),
    h('p', {}, str(e.detail) || info.meaning),
    e.team ? h('span', {}, e.team) : null,
    e.readAs ? h('span', {}, `Read as bib ${str(e.readAs)} (swapped bibs)`) : null,
    multi && e.port != null ? h('span', {}, `Port ${e.port}`) : null,
    split && loc && norm(split) !== norm(loc) ? h('span', {}, `Timing point ${loc}`) : null,
    e.status === 'check-column' && e.raceId ? h('button', { type: 'button', class: 'btn small', 'data-fk': `feed-review2-${e.id}`, onclick: (ev) => openReview(e.raceId, { bib: str(e.bib) }, ev.currentTarget) }, 'Check in Review') : null,
    e.raceId && e.bib && e.status !== 'check-column' ? h('button', { type: 'button', class: 'btn small local', 'data-fk': `feed-runner-${e.id}`, onclick: (ev) => openRunner(e.raceId, str(e.bib), ev.currentTarget) }, 'Open runner') : null)))];
}

/* ---------- Review page (DESIGN 9.17 P6) ---------- */
// The work queue of one race: passes to check, missing splits, finishers' splits not sent live, made-up times. Split
// Relay works out every estimate and check; the page fetches them (again whenever the race changes, at most every
// 2 s) and sends only what the operator approves.

const REVIEW_API = {
  review: (id) => `/api/races/${enc(id)}/review`,
  runner: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}`,
  sending: (id, splitId) => `/api/races/${enc(id)}/splits/${enc(splitId)}/sending`,
  manual: (id) => `/api/races/${enc(id)}/manual`,
  assign: (id) => `/api/races/${enc(id)}/assign`,
  finished: (id) => `/api/races/${enc(id)}/send-finished`,
  // DESIGN 9.23
  move: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/move`,
  missed: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/missed`,
  send: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/send`,
  undo: (id) => `/api/races/${enc(id)}/undo`,
  // DESIGN 9.24
  stop: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/stop`,
  resume: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/resume`,
  // DESIGN 9.25
  place: (id, bib) => `/api/races/${enc(id)}/runners/${enc(bib)}/place`,
  grid: (id) => `/api/races/${enc(id)}/grid`,
};

/**
 * Put focus on the element with this data-fk once the page is drawn: the next repaint does it (paint() looks for
 * S.focusAfter), and when nothing is repainted (the State came by the event stream first, so the answer changes
 * nothing) the element that is there already gets it. The key never lingers, so it can't pull focus away later while
 * the operator types somewhere else.
 * @param {string} fk
 */
function focusKey(fk) {
  if (!fk) return;
  S.focusAfter = fk;
  scheduleRender();
  requestAnimationFrame(() => setTimeout(() => {
    if (S.focusAfter !== fk) return;
    S.focusAfter = null;
    const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (el && !el.closest('[hidden]') && !el.disabled) el.focus();
  }, 0));
}

/** act() for the review tools: an older Split Relay without them says so in words, not as "404". */
async function reviewAct(fn, btn) {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : err && err.message ? err.message : String(err), 'bad');
    return undefined;
  } finally {
    if (b) b.disabled = false;
  }
}

/**
 * Open Review for a race (and, with a bib, that runner's columns): the Review page, #review/<race>[/<bib>].
 * @param {string} raceId
 * @param {{ bib?: string }} [opts]
 * @param {Element | null} [btn] (kept for the callers; the page has no Close to return focus from)
 */
function openReview(raceId, { bib = '' } = {}, btn = null) {
  if (!raceId) return;
  void btn;
  go(`#review/${enc(raceId)}${bib ? `/${enc(bib)}` : ''}`);
}

/**
 * Keep each Review list in the order its rows first came, so a row that comes in later goes at the end (with "New")
 * and never pushes down the row the operator is about to press.
 * @param {any} R S.review
 * @param {ReturnType<typeof normReview>} d
 */
function orderReview(R, d) {
  if (!R.seq) {
    R.seq = new Map();
    R.seqNext = 0;
    R.fresh = new Map();
  }
  const first = !R.seqInit;
  for (const k of ['checks', 'missing', 'finishedNotSent', 'manual']) {
    for (const x of d[k]) {
      const id = `${k}|${x.key}`;
      if (R.seq.has(id)) continue;
      R.seq.set(id, R.seqNext++);
      if (!first) R.fresh.set(id, Date.now());
    }
    d[k] = d[k].slice().sort((a, b) => R.seq.get(`${k}|${a.key}`) - R.seq.get(`${k}|${b.key}`));
  }
  R.seqInit = true;
  return d;
}

/** A fresh Review for a race: its list is fetched now. */
function startReview(raceId) {
  if (S.review) clearTimeout(S.review.timer);
  if (S.review) clearTimeout(S.review.gridTimer);
  // view: 'todo' (the queues) or 'all' (the race grid, 9.23 F8), remembered on this computer
  S.review = { raceId, data: null, loading: false, again: false, error: '', at: 0, srcSig: null, lastFetch: 0, timer: 0,
    edits: new Map(), busy: new Set(), bulk: '', find: '', runner: null, opener: null, sendAllBtn: null,
    view: loadPref('reviewView', 'todo') === 'all' ? 'all' : 'todo', grid: null, gridTimer: 0, menu: null, box: null, cellFocus: null,
    info: '', fixBusy: false, missSplit: '' };
  loadReview();
  if (S.review.view === 'all') loadGrid(S.review);
}

/**
 * The Review the page shows: the race in the route, else the one open before, else the race that most needs it. A
 * bib in the route (the feed's "Check") opens that runner once per link.
 * @param {any} st
 */
function ensureReview(st) {
  const routeId = S.route.id && configRace(st, S.route.id) ? S.route.id : '';
  const id = routeId || (S.review && configRace(st, S.review.raceId) ? S.review.raceId : defaultReviewRace(st));
  if (!id) return null;
  if (S.review?.raceId !== id) startReview(id);
  if (S.route.focus) {
    if (S.reviewBibRoute !== location.hash) {
      // 9.23 F1: a bib in the route opens that runner's editor, once per link
      S.reviewBibRoute = location.hash;
      findRunner(S.route.focus);
    }
  } else {
    // the route has no runner any more (Back, the race's own link): the editor closes as Close does
    if (S.reviewBibRoute && S.review.runner) {
      S.review.runner = null;
      S.review.menu = null;
      S.review.box = null;
      S.runnerOpener = null;
      S.runnerFrom = '';
    }
    S.reviewBibRoute = '';
  }
  return S.review;
}

/** Something this tab did changed the race (a pause, a send): the open Review fetches its list again soon. */
function reviewChanged(raceId) {
  if (S.review?.raceId === raceId) queueReviewLoad(300);
}

function queueReviewLoad(min = 0) {
  const R = S.review;
  if (!R) return;
  if (R.timer && !min) return;
  clearTimeout(R.timer);
  const wait = Math.max(min || 300, 2000 - (Date.now() - R.lastFetch));
  R.timer = setTimeout(() => {
    R.timer = 0;
    if (S.review === R) loadReview();
  }, min ? Math.min(wait, min) : wait);
}

async function loadReview() {
  const R = S.review;
  if (!R) return;
  if (R.loading) {
    R.again = true;
    return;
  }
  R.loading = true;
  R.lastFetch = Date.now();
  scheduleRender();
  try {
    const raw = await api('GET', REVIEW_API.review(R.raceId));
    if (S.review !== R) return;
    R.data = orderReview(R, normReview(raw, configRace(S.state, R.raceId)));
    // the list is drawn again only when it changed, not on every fetch (a refresh must not disturb the operator)
    R.dataSig = JSON.stringify(R.data);
    R.error = '';
  } catch (err) {
    if (S.review !== R) return;
    R.error = notSupported(err) ? REVIEW_NOT_SUPPORTED : err && err.message ? err.message : String(err);
  } finally {
    if (S.review === R) {
      R.at = Date.now();
      R.loading = false;
      if (R.again) {
        R.again = false;
        queueReviewLoad();
      }
      scheduleRender();
    }
  }
  if (S.review === R && R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
}

/** Open a runner in the editor (9.23 F1): the route's bib, the top bar's box, a bib anywhere. */
function findRunner(query) {
  const R = S.review;
  if (!R) return;
  const bib = str(query).trim();
  R.find = bib;
  R.menu = null;
  R.box = null;
  R.cellFocus = null;
  if (!bib) {
    R.runner = null;
    scheduleRender();
    return;
  }
  R.focusOnLoad = true;
  loadRunner(bib);
}

async function loadRunner(bib, { quiet = false } = {}) {
  const R = S.review;
  if (!R) return;
  const prev = R.runner?.bib === bib ? R.runner : null;
  const me = { bib, data: prev?.data || null, loading: true, error: '', at: prev?.at || 0, elsewhere: prev?.elsewhere || null };
  R.runner = me;
  if (!quiet) scheduleRender();
  try {
    const raw = await api('GET', REVIEW_API.runner(R.raceId, bib));
    if (S.review !== R || R.runner !== me) return;
    me.data = normRunner(raw, configRace(S.state, R.raceId));
    me.sig = JSON.stringify(me.data);
    if (!me.data.bib) me.data.bib = bib;
  } catch (err) {
    if (S.review !== R || R.runner !== me) return;
    me.data = null;
    me.error = notSupported(err) ? REVIEW_NOT_SUPPORTED : err && err.message ? err.message : String(err);
  }
  // not in this race: the coach asking "where is 233?" wants the race the runner is in, not three empty boxes
  if (S.review === R && R.runner === me && !quiet && (!me.data || !me.data.found) && me.error !== REVIEW_NOT_SUPPORTED) {
    me.elsewhere = await runnerElsewhere(R.raceId, bib);
  }
  if (R.runner === me) {
    me.loading = false;
    me.at = Date.now();
    // 9.23: opened just now: the cell to look at first (or the one the grid was clicked on, with its choices open)
    if (R.focusOnLoad && me.data?.found) {
      R.focusOnLoad = false;
      R.cellFocus = R.openMenuAt != null ? R.openMenuAt : editorFocus(me.data);
      S.reviewFocus = `rec-${R.cellFocus}`;
      S.reviewScroll = true;
      if (R.openMenuAt != null) {
        const k = R.openMenuAt;
        R.openMenuAt = null;
        const m = menuFor(me.data, { col: me.data.columns[k] });
        if (m.items.length && !S.viewOnly) {
          const first = m.items.find((x) => !x.disabled) || m.items[0];
          R.menu = { i: k, tod: null, focus: first.key };
          S.reviewFocus = `rem-${first.key}`;
        }
      }
    } else if (R.focusOnLoad) {
      R.focusOnLoad = false;
      S.reviewFocus = 're-title';
    }
    R.forceUntil = Date.now() + 1000;
    scheduleRender();
  }
}

/** The other races that have this bib: [{ raceId, raceName, name }]. */
async function runnerElsewhere(raceId, bib) {
  const races = arr(S.state?.config?.races).filter((r) => r.id !== raceId).slice(0, 12);
  const got = await Promise.all(races.map((r) => api('GET', REVIEW_API.runner(r.id, bib)).then((raw) => ({ r, v: normRunner(raw, r) }), () => null)));
  return got.filter((x) => x && x.v.found).map(({ r, v }) => ({ raceId: r.id, raceName: str(r.name) || '(no name)', name: v.name }));
}

/**
 * Paint the Review page (DESIGN 9.17 P6, 9.23 F8): the race chips, the runner editor when a runner is open, the view
 * switch, and To do (the queues) or All runners (the race grid). What the operator is working on holds still: a list,
 * the editor or the grid under the pointer or the keyboard is not redrawn by other runners' reads for a few seconds.
 */
function renderReview() {
  const st = S.state;
  const races = arr(st.config.races);
  if (!races.length) {
    for (const el of [EL.reviewRaces, EL.reviewEditor, EL.reviewSwitch, EL.reviewNotices]) if (el) paintSig(el, 'none', () => null);
    if (EL.reviewGrid) EL.reviewGrid.hidden = true;
    EL.reviewBody.hidden = false;
    paintSig(EL.reviewBody, 'none', () => h('div', { class: 'card empty-state' },
      h('h2', {}, 'Nothing to review yet'),
      h('p', {}, 'Missing splits, passes to check and finished runners\' splits show here once a race has reads.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#races/new' }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'New race'))));
    if (EL.reviewMeta.textContent) EL.reviewMeta.textContent = '';
    return;
  }
  const R = ensureReview(st);
  if (!R) return;
  const cfg = configRace(st, R.raceId);
  const rv = viewOf(st, R.raceId);
  // the race changed (a read, a send, a pause somewhere else): fetch the list (and the grid) again, at most every 2 s
  const src = JSON.stringify([rv && { ...rv, elapsedTicks: 0, lastReadAt: 0 }, cfg]);
  if (src !== R.srcSig) {
    const first = R.srcSig === null;
    R.srcSig = src;
    if (!first) {
      queueReviewLoad();
      queueGridLoad(R);
    }
  }
  if (R.view === 'all' && !R.grid) loadGrid(R);
  paintSig(EL.reviewRaces, JSON.stringify([R.raceId, races.map((r) => [r.id, r.name, r.active, reviewCounts(viewOf(st, r.id))])]), () => reviewRaceChips(st, races, R.raceId));
  const meta = R.loading && !R.at ? 'Loading…' : R.at ? `Updated ${formatWall(R.at)}${R.loading ? ' · updating…' : ''}` : '';
  if (EL.reviewMeta.textContent !== meta) EL.reviewMeta.textContent = meta;
  const dest = destinations(st, R.raceId);
  // a row that came in while the list was open says "New" for half a minute
  if (R.fresh) for (const [k, t] of R.fresh) if (Date.now() - t > 30000) R.fresh.delete(k);
  R.freshKeys = new Set(R.fresh ? R.fresh.keys() : []);
  const hadFocus = PANELS.review.contains(document.activeElement);
  const inEditor = EL.reviewEditor.contains(document.activeElement);
  // what the operator just did (a row being sent, a bulk send) always shows at once
  const busySig = JSON.stringify([[...R.busy], R.bulk, !!R.fixBusy]);
  if (busySig !== R.busySig) {
    R.busySig = busySig;
    R.forceUntil = Math.max(R.forceUntil || 0, Date.now() + 1000);
  }
  // R.force: this panel's own change (a menu opened, a box, a filter): drawn at the next render, whenever it comes
  const forced = R.force || Date.now() < (R.forceUntil || 0);
  R.force = false;
  /** paint, unless the region is in use (pointer or keyboard in it) and what changed is not the operator's own doing */
  const held = (el, sig, key, build, busy = false, mine = false) => {
    const working = busy || el.matches(':hover') || el.contains(document.activeElement);
    if (el._sig !== undefined && el._sig !== sig && !forced && !mine && working) {
      if (!R[key]) R[key] = Date.now();
      if (Date.now() - R[key] < 6000) {
        clearTimeout(R.holdTimer);
        R.holdTimer = setTimeout(scheduleRender, 1000);
        return;
      }
    }
    R[key] = 0;
    guard(el, () => paintSig(el, sig, build));
  };
  paintSig(EL.reviewNotices, JSON.stringify([cfg && [cfg.name, cfg.active, arr(cfg.splits).map((s) => [s.id, s.name, splitSending(s)])],
    rv && [Number.isFinite(rv.gunTicks), arr(rv.splits).map((s) => [s.id, splitHeld(s), s.playing])], [...S.playing],
    R.grid?.data ? [R.grid.data.finishSource, R.grid.data.finishPassStream] : null,
    // (9.27: the swapped bibs, what the last change said)
    st.swaps ?? null, S.swapLast?.at ?? 0, S.viewOnly]), () => reviewNotices(R, cfg, rv));
  // the runner editor (9.23 F1): full width above both views
  if (R.runner) {
    const esig = JSON.stringify([R.raceId, R.runner.bib, R.runner.sig, !R.runner.data && R.runner.loading, R.runner.error, R.runner.elsewhere,
      R.menu && [R.menu.i, R.menu.tod], R.box && [R.box.i], R.drag, !!R.fixBusy, S.viewOnly, dest, !!R.passesOpen, R.cellFocus, S.runnerFrom,
      cfg && arr(cfg.splits).map((s) => [s.id, s.name])]);
    // (another runner opened is the operator's own doing: drawn at once, never held for the one before)
    const other = EL.reviewEditor._bib !== R.runner.bib;
    held(EL.reviewEditor, esig, 'editorHold', () => runnerEditor(R, cfg, dest), !!R.box || !!R.drag, other);
    if (EL.reviewEditor._sig === esig) EL.reviewEditor._bib = R.runner.bib;
  } else {
    paintSig(EL.reviewEditor, 'none', () => null);
    EL.reviewEditor._bib = undefined;
  }
  // the switch between the two views
  const d = R.data;
  const todo = d ? d.checks.length + d.flags.length + d.missing.length + d.finishedNotSent.length : 0;
  const all = R.grid?.data?.counts?.runners ?? rv?.runners ?? 0;
  paintSig(EL.reviewSwitch, JSON.stringify([R.view, todo, all]), () => h('div', { class: 'seg review-views', role: 'group', 'aria-label': 'Review view' },
    [['todo', `To do (${fmtInt(todo)})`], ['all', `All runners (${fmtInt(all)})`]].map(([v, label]) => h('button', { type: 'button', class: 'seg-btn local', 'aria-pressed': String(R.view === v), 'data-fk': `rv-view-${v}`,
      onclick: () => {
        R.view = v;
        savePref('reviewView', v);
        if (v === 'all') loadGrid(R);
        scheduleRender();
      } }, label))));
  EL.reviewBody.hidden = R.view !== 'todo';
  EL.reviewGrid.hidden = R.view !== 'all';
  if (R.view === 'todo') {
    const sig = JSON.stringify([R.raceId, R.dataSig, R.error, !!R.data, R.bulk, [...R.busy], !!R.fixBusy, R.missSplit,
      cfg && [cfg.name, cfg.active, arr(cfg.splits).map((s) => [s.id, s.name, splitSending(s)])], rv && [Number.isFinite(rv.gunTicks)],
      dest, S.viewOnly, [...S.more].filter((k) => k.startsWith('rq-')), [...R.freshKeys], R.grid?.data?.counts?.stopped]);
    held(EL.reviewBody, sig, 'holdSince', () => buildReview(R, st, cfg, rv, dest));
  } else {
    const n = arr(cfg?.splits).length;
    const fits = gridFits(EL.reviewGrid.clientWidth || window.innerWidth, n);
    const gsig = JSON.stringify([R.raceId, R.grid?.rev, R.grid?.error, !!R.grid?.data, R.gridF, R.gridEdit && [R.gridEdit.bib, R.gridEdit.k],
      R.grid?.showAll, R.grid?.reorder, S.viewOnly, !!R.fixBusy, fits]);
    held(EL.reviewGrid, gsig, 'gridHold', () => gridSection(R, cfg, dest), !!R.gridEdit);
  }
  if (hadFocus && (!document.activeElement || document.activeElement === document.body)) {
    // the keyboard was in the runner editor (a menu or box went): back to its cell, so the arrows and Ctrl+Z still work
    const cell = inEditor && R.runner ? EL.reviewEditor.querySelector(`[data-fk="rec-${R.cellFocus}"]`) : null;
    (cell || EL.reviewTitle).focus({ preventScroll: true });
  }
  if (S.reviewFocus) {
    const want = S.reviewFocus;
    const el = want === 'title' ? EL.reviewTitle : PANELS.review.querySelector(`[data-fk="${CSS.escape(want)}"]`);
    if (el) {
      S.reviewFocus = null;
      // a menu's choice is scrolled into view (the menu opens under the cells, maybe below the window's edge)
      el.focus({ preventScroll: !want.startsWith('rem-') });
    }
  }
  // the editor was closed: back to where it was opened from (the bib button, the grid cell, the top bar's box)
  if (S.afterCloseFocus) {
    const el = S.afterCloseFocus;
    S.afterCloseFocus = null;
    if (el.isConnected) {
      el.scrollIntoView?.({ block: 'nearest' });
      el.focus();
    } else EL.reviewTitle.focus({ preventScroll: true });
  }
  // a runner opened from far down the page: the editor scrolls into view
  if (S.reviewScroll && R.runner && EL.reviewEditor.firstChild) {
    S.reviewScroll = false;
    EL.reviewEditor.scrollIntoView({ block: 'nearest' });
  }
}

/** One chip per race, with what waits in it. */
function reviewRaceChips(st, races, current) {
  const list = races.filter((r) => r.active !== false || r.id === current || reviewCounts(viewOf(st, r.id)).missing + reviewCounts(viewOf(st, r.id)).checks + reviewCounts(viewOf(st, r.id)).finishedNotSent > 0);
  return h('nav', { class: 'chips-bar', 'aria-label': 'Race to review' }, list.map((r) => {
    const c = reviewCounts(viewOf(st, r.id));
    const total = c.missing + c.checks + c.finishedNotSent;
    return h('a', { class: 'fchip', href: `#review/${enc(r.id)}`, 'aria-current': r.id === current ? 'page' : null, 'data-fk': 'rvr-chip-' + r.id },
      r.name || '(no name)', r.active === false ? h('span', { class: 'muted' }, ' (not Active)') : null,
      total ? h('span', { class: `nav-badge tone-${reviewTone(c)}` }, fmtInt(total)) : null);
  }));
}

function buildReview(R, st, cfg, rv, dest) {
  if (!cfg) return h('p', { class: 'msg tone-warn' }, 'This race is not in the settings any more.');
  const out = [];
  // (a paused split, a race not Active, no gun: said above both views, reviewNotices)
  void rv;
  if (R.error) out.push(h('p', { class: 'msg tone-bad', role: 'alert' }, R.error === REVIEW_NOT_SUPPORTED ? R.error : `Couldn't load the review list: ${R.error}`));
  if (!R.data) {
    if (!R.error) out.push(h('div', { class: 'card review-empty' }, 'Loading the review list…'));
    return out;
  }
  const d = R.data;
  const est = d.missing.filter((m) => m.estimate != null).length;
  const counter = (label, n, tone, fk, sub) => (n
    ? h('button', { type: 'button', class: `counter tone-${tone}`, onclick: () => focusKey(fk) }, h('b', {}, fmtInt(n)), h('span', {}, label), sub ? h('span', {}, sub) : null)
    : h('div', { class: 'counter zero' }, h('b', {}, '0'), h('span', {}, label)));
  out.push(h('div', { class: 'counters' },
    counter('To check', d.checks.length, 'warn', 'rv-checks-h'),
    counter('Look wrong', d.flags.length, 'warn', 'rv-flags-h'),
    counter('Missing splits', d.missing.length, est ? 'warn' : 'info', 'rv-missing-h', est && est < d.missing.length ? `${fmtInt(est)} with an estimate` : ''),
    counter('Finished, not sent live', d.finishedNotSent.length, 'info', 'rv-fin-h'),
    counter('Made-up and typed', d.manual.length, 'info', 'rv-man-h')));
  if (!d.checks.length && !d.flags.length && !d.missing.length && !d.finishedNotSent.length && !d.manual.length && !arr(d.off).length && !arr(d.away).length && !arr(d.unlisted).length) {
    out.push(h('div', { class: 'card review-empty' }, h('span', { class: 'i i-check', 'aria-hidden': 'true' }),
      h('span', {}, `Nothing to review in ${cfg.name || 'this race'}. Missing splits, passes to check and finished runners' splits show here as they come.`)));
    R.sendAllBtn = null;
    return out;
  }
  if (d.checks.length) out.push(checksSection(R, d, dest));
  if (d.flags.length) out.push(flagsSection(R, d, dest));
  if (d.missing.length) out.push(missingSection(R, d, dest));
  else R.sendAllBtn = null;
  if (d.finishedNotSent.length) out.push(finishedSection(R, d, dest));
  if (d.manual.length) out.push(manualSection(R, d, dest));
  if (arr(d.off).length) out.push(offSection(R, d));
  // 9.25: the athletes who are not in this race (kept off the boards), and the ones on no start list
  if (arr(d.away).length) out.push(awaySection(R, d));
  if (arr(d.unlisted).length) out.push(unlistedSection(R, d));
  out.push(h('p', { class: 'help' }, 'Made-up times are estimates, not timed splits. ', h('a', { href: '#help/review' }, 'How Review works')));
  return out;
}

/** A bib that opens the runner editor (9.23 F1): plain text that underlines, not a box that looks like a field. */
function bibButton(R, bib) {
  return runnerBibButton(R.raceId, bib);
}

const whoText = (x) => [x.name, x.team].filter(Boolean).join(' · ');
/**
 * The runner's name and team, with the chips that belong to the runner (finished, only pass, New) right after them.
 * The name always shows in full: in a narrow column the chips, then the team, go onto the next line (style.css
 * .ri-name-line); only a team longer than the whole column is cut short (it is in the tooltip).
 */
const whoNode = (x, chips = [], sub = '') => h('span', { class: 'ri-name', title: whoText(x) },
  h('span', { class: 'ri-name-line' }, x.name ? h('b', {}, x.name) : null,
    x.team ? h('span', { class: 'ri-team' }, x.name ? h('span', { class: 'sr-only' }, ', ') : null, x.team) : null, ...chips),
  sub ? h('span', { class: 'ri-sub' }, sub) : null);
const finishedChip = (x) => (x.finished ? h('span', { class: 'badge tone-finish' }, x.finishPlace != null ? `finished ${ordinal(x.finishPlace)}` : 'finished') : null);

/**
 * One time to approve: the estimate in an editable box, Send, and a line only when something about this row is not
 * as usual (a problem with the time, a finisher's place, a paused split). Used for the missing splits and for an
 * empty column of Find runner.
 * @param {any} R S.review
 * @param {any} item a normReview missing item or a columnItem
 * @param {{ outputs: string[], lif: boolean }} dest
 * @param {string} prefix focus key prefix ('rvm' list, 'rvr' runner view)
 * @param {{ who?: boolean, next?: string }} [opts] who: show the bib and name; next: the focus key after a send
 */
function timeRow(R, item, dest, prefix, { who = true, next = '' } = {}) {
  const fk = `${prefix}-${item.key}`;
  const busy = R.busy.has(item.key);
  const row = rowTime(item, R.edits.get(item.key));
  // a row Split Relay can't send (a finisher whose place it doesn't know, a check to settle first): said, Send off
  const blocked = rowBlocked(item);
  const line = h('p', { class: 'review-line', id: fk + '-line' });
  // how the estimate was made: a tooltip on the time in the list (the row stays one line), shown in Find runner
  const basisText = blocked ? '' : item.estimate == null ? 'No estimate yet: waiting for a later split or the finish. You can type a time.' : item.basis;
  const kind = h('span', { class: 'badge kind-badge', title: who && basisText ? basisText : null });
  const input = h('input', {
    id: fk + '-time', 'data-fk': fk + '-time', type: 'text', class: 'mono time-input', value: row.text, inputmode: 'decimal',
    placeholder: item.estimate == null ? 'm:ss.0' : '', autocomplete: 'off', spellcheck: 'false', disabled: !!blocked,
    title: who && basisText ? basisText : null,
    'aria-label': `${item.splitName} time for bib ${item.bib}`, 'aria-describedby': `${fk}-basis ${fk}-line`,
  });
  // outlined in the list: the queue's own action (Send all) is the gold one, and the row being worked on (focus)
  const send = h('button', { type: 'button', class: 'btn small row-primary', 'data-fk': fk + '-send', 'aria-describedby': fk + '-line',
    title: blocked || null, onclick: (e) => sendManual(item, e.currentTarget, next || fk + '-time') }, busy ? 'Sending…' : 'Send');
  const reset = item.estimate != null ? h('button', { type: 'button', class: 'btn small ghost', 'data-fk': fk + '-reset',
    onclick: () => { R.edits.delete(item.key); input.value = item.estimateText; update(); input.focus(); } }, 'Use estimate') : null;
  // where Send goes is said once for the list; a row says more only when it is not the usual
  const special = item.finished || !!pausedNote(dest, item.splitId) || !who;
  // typing changes only this row's words and buttons (no repaint while the operator types)
  const update = () => {
    const r = rowTime(item, R.edits.get(item.key));
    // (an empty box with no estimate is said once, by the line above it)
    // (in the list, the section says where Send goes: a row adds only what is different about it)
    // (the outputs that take this race keep the finish place: not "TrackScore" for a race TrackScore doesn't get)
    const keeps = keepsText(dest);
    const differs = [item.finished && item.finishPlace != null ? `Goes with place ${item.finishPlace}, the finish place${keeps ? `, ${keeps}` : ''}.` : '',
      pausedNote(dest, item.splitId).trim()].filter(Boolean).join(' ');
    line.textContent = r.sendable ? (!who ? manualSendLine(item, r, dest) : special ? differs : '') : !r.text && item.estimate == null && !blocked ? '' : r.problem;
    // a time that doesn't fit is an error, red like its box; a row Split Relay can't send yet is a warning
    line.classList.toggle('tone-text-bad', !r.sendable && !!r.text && !blocked);
    line.classList.toggle('tone-text-warn', !r.sendable && !!blocked);
    input.setAttribute('aria-invalid', String(!!r.text && !r.sendable && !blocked));
    send.disabled = !r.sendable || R.busy.has(item.key);
    kind.textContent = r.typed ? 'Typed' : r.text ? 'Made-up' : '';
    kind.className = `badge kind-badge tone-${r.typed ? 'warn' : 'info'}`;
    kind.hidden = !r.text || !!blocked;
    if (reset) reset.hidden = !r.typed;
    refreshSendAll(R);
  };
  input.addEventListener('input', () => {
    R.edits.set(item.key, input.value);
    update();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!send.disabled) sendManual(item, send, next || fk + '-time');
    } else if (e.key === 'Escape' && R.edits.has(item.key)) {
      // Esc puts the estimate back
      e.preventDefault();
      e.stopPropagation();
      R.edits.delete(item.key);
      input.value = item.estimateText;
      update();
    }
  });
  update();
  if (busy) send.disabled = true;
  return h('li', { class: 'review-item' + (blocked ? ' blocked' : '') + (who ? '' : ' in-runner') + (R.freshKeys?.has('missing|' + item.key) ? ' fresh' : '') },
    h('div', { class: 'ri-main' },
      who ? h('div', { class: 'ri-who' }, bibButton(R, item.bib), whoNode(item, [finishedChip(item), newChip(R, 'missing|' + item.key)])) : null,
      h('div', { class: 'ri-split' }, h('strong', {}, item.splitName), kind, who ? null : finishedChip(item)),
      h('div', { class: 'ri-act' }, input, send, reset)),
    basisText ? h('p', { class: who ? 'sr-only' : 'ri-basis', id: fk + '-basis' }, basisText) : null,
    line);
}

/** "New" on a row that came in while the list was open: it is added at the end, so nothing moves under the pointer. */
const newChip = (R, id) => (R.freshKeys?.has(id) ? h('span', { class: 'badge tone-info' }, 'New') : null);

/** The "Fill in N missing…" count follows the split chip (a row the operator typed into is sent with its own Send). */
function refreshSendAll(R) {
  const b = R.sendAllBtn;
  if (!b || !R.data) return;
  const items = missingShown(R).filter((m) => !R.edits.has(m.key) || R.edits.get(m.key) === m.estimateText);
  const n = fillAllPlan(items).send.length;
  const sp = R.missSplit ? R.data.missing.find((m) => m.splitId === R.missSplit)?.splitName : '';
  const t = R.bulk || (n ? `Fill in ${fmtInt(n)} missing${sp ? ` at ${sp}` : ''}…` : 'Fill in missing');
  if (b.textContent !== t) b.textContent = t;
  b.disabled = !!R.bulk || !!R.fixBusy || !n;
}

/** The missing splits the To do list shows: all, or one split's (its chip). */
function missingShown(R) {
  const list = arr(R.data?.missing);
  return R.missSplit ? list.filter((m) => m.splitId === R.missSplit) : list;
}

/** A queue section: a heading with its count and its bulk action, one note, the rows. */
function queueSection({ id, title, count, tone, action, note, more: long, moreKey, list }) {
  const [btn, body] = moreParts(moreKey || 'rq-' + id, long, `About ${title.toLowerCase()}`);
  return h('section', { class: 'card queue', 'aria-labelledby': id },
    h('div', { class: 'card-head' },
      h('h2', { id, 'data-fk': id, tabindex: '-1' }, title, h('span', { class: 'sr-only' }, ': '), h('span', { class: `nav-badge tone-${tone}` }, fmtInt(count))),
      action ? h('div', { class: 'row' }, action) : null),
    note || btn ? h('div', { class: 'queue-note' }, note || '', btn, body) : null,
    list);
}

function missingSection(R, d, dest) {
  const splits = [];
  for (const m of d.missing) if (!splits.some((x) => x.id === m.splitId)) splits.push({ id: m.splitId, name: m.splitName, n: 0 });
  for (const m of d.missing) splits.find((x) => x.id === m.splitId).n++;
  if (R.missSplit && !splits.some((x) => x.id === R.missSplit)) R.missSplit = '';
  const list = missingShown(R);
  const dropped = arr(R.grid?.data?.rows).filter((r) => r.stopped).map((r) => r.bib);
  R.sendAllBtn = S.viewOnly ? null : h('button', { type: 'button', class: 'btn primary', 'data-fk': 'rv-send-all', onclick: (e) => {
    const items = missingShown(R).filter((m) => !R.edits.has(m.key) || R.edits.get(m.key) === m.estimateText);
    const sp = R.missSplit ? splits.find((x) => x.id === R.missSplit)?.name : '';
    const n = fillAllPlan(items).send.length;
    fillAllDialog(R, items, { btn: e.currentTarget, dropped, title: sp ? `Fill in ${fmtInt(n)} missing at ${sp}?` : `Fill in ${plural(n, 'missing split')}?` });
  } }, 'Fill in missing');
  const keys = list.map((m) => `rvm-${m.key}-time`);
  const chips = splits.length > 1 ? h('div', { class: 'chips-bar miss-chips', role: 'group', 'aria-label': 'Show the missing splits of' },
    [['', 'All', d.missing.length], ...splits.map((x) => [x.id, x.name, x.n])].map(([id, name, n]) => h('button', { type: 'button', class: 'fchip local', 'aria-pressed': String(R.missSplit === id),
      onclick: () => { R.missSplit = id; R.force = true; scheduleRender(); } }, `${name} (${fmtInt(n)})`))) : null;
  const sec = queueSection({
    id: 'rv-missing-h', title: 'Missing splits', count: d.missing.length, tone: d.missing.some((m) => m.estimate != null) ? 'warn' : 'info', action: R.sendAllBtn,
    note: [`Send puts the time ${sendsTo(dest)}. Enter sends a row and moves to the next.`, chips],
    more: 'Runners with a later split or a FinishLynx finish, but no time at this split: a mat missed them. Split Relay made up a time from their splits around it, placed like the runners nearest in pace. Check it, type another time if you know better (a typed time), and send it. A real read for that split later replaces it. Runners with no read after their last split and no finish may have dropped out: nothing is made up for them.',
    list: h('ul', { class: 'review-list' }, list.map((m, i) => timeRow(R, m, dest, 'rvm', { next: keys[i + 1] || keys[i - 1] || 'rv-missing-h' }))),
  });
  refreshSendAll(R);
  return sec;
}

/**
 * 9.23 F19: the runners a Review row says a mat missed ("Missed …: add it" on one of their rows): their other rows keep
 * their Move, but not as the row's one click (as in the runner editor and the cells' menus, moveIsOneClick).
 */
export const hintedBibs = (d) => new Set([...arr(d?.checks), ...arr(d?.flags)].filter((x) => x?.missed).map((x) => x.bib));

function checksSection(R, d, dest) {
  const lone = d.checks.some((c) => c.lone && !c.finished);
  const hinted = hintedBibs(d);
  return queueSection({
    id: 'rv-checks-h', title: 'Passes to check', count: d.checks.length, tone: 'warn',
    note: `Held (not sent, not in the .lif file) until you choose. One Move usually settles all of a runner's passes.${lone ? ' "Only pass" can wait: the runner\'s next pass or finish settles it.' : ''}${d.checks.some((c) => c.finished) ? ' A finished runner\'s pass then goes into the .lif file only (Finished: not sent live).' : ''}`,
    more: [`Passes counted in one split column that, next to the rest of the field, look like they belong in another: a mat probably missed the runner. Move puts the pass in the split it looks like; Keep says counting was right. Your choice sticks, and the runner's other passes are counted around it.`, ...(lone ? [`Only pass: ${LONE_TEXT}`] : [])],
    list: h('ul', { class: 'review-list' }, d.checks.map((c, i) => {
      const L = checkLabels(c);
      const busy = R.busy.has(c.key);
      const fk = `rvc-${c.key}`;
      // focus goes on to the next runner's row: a Move usually settles this runner's later passes too (they count on
      // from it), so their rows go away with this one
      const after = d.checks.slice(i + 1);
      const nextRow = after.find((x) => x.bib !== c.bib) || after[0];
      const nextFk = nextRow ? `rvc-${nextRow.key}-move` : 'rv-checks-h';
      const chips = [c.finished ? h('span', { class: 'badge tone-finish' }, 'finished') : null,
        c.lone && !c.finished ? h('span', { class: 'badge tone-muted', title: LONE_TEXT }, 'Only pass · can wait') : null, newChip(R, 'checks|' + c.key)];
      return h('li', { class: 'review-item' + (R.freshKeys?.has('checks|' + c.key) ? ' fresh' : '') },
        h('div', { class: 'ri-main' },
          // (9.25: a runner of another race: that is the story, not a missed mat)
          h('div', { class: 'ri-who' }, bibButton(R, c.bib), whoNode(c, chips, c.stranger ? c.stranger.text : c.reason)),
          h('div', { class: 'ri-split' }, h('span', { class: 'muted' }, 'Pass at'),
            h('strong', { class: 'mono' }, c.raceTicks != null ? formatRaceTime(c.raceTicks, 1) : Number.isFinite(c.passTod) ? formatTod(c.passTod) : '?')),
          h('div', { class: 'ri-act' },
            // 9.23 F13: the runner's first pass after a missed split: "Missed <split>: add it" settles all of its passes
            // (F14: each count of missed splits a choice of its own while Split Relay can't tell which)
            // (9.27: or the chip of this bib was carried by an athlete of this race: Swapped bibs…)
            ...(c.stranger ? [h('button', { type: 'button', class: 'btn small row-primary', 'data-fk': fk + '-move', disabled: busy || !!R.fixBusy, onclick: () => placeRunner(R, c.bib, 'away') }, 'Not in this race'),
              h('button', { type: 'button', class: 'btn small', 'data-fk': fk + '-swap', disabled: busy || !!R.fixBusy, title: "An athlete of this race ran with this bib's chip", onclick: (e) => swapDialog(c.bib, e.currentTarget) }, 'Swapped bibs…')]
              : c.missed ? missedRowButtons(R, c, c.from.id, fk + '-move', busy)
              : [h('button', { type: 'button', class: `btn small${hinted.has(c.bib) ? '' : ' row-primary'}`, 'data-fk': fk + '-move', disabled: busy || !c.to.id, title: c.to.id ? '' : 'It moves on with the pass before it: the fix of that pass settles it', onclick: (e) => assignPass(c, true, e.currentTarget, nextFk) }, L.move)]),
            h('button', { type: 'button', class: 'btn small', 'data-fk': fk + '-keep', disabled: busy, onclick: (e) => assignPass(c, false, e.currentTarget, nextFk) }, L.keep))),
        c.missed && c.missed.sure === false ? h('p', { class: 'review-line' }, missedUnsureText(c.missed)) : null,
        // it went out as the earlier split before the check held it: a packet can't empty that TrackScore cell, but a
        // time for that split fills it again (the made-up time Review offers once the pass is moved)
        c.delivered || c.sentOther ? h('p', { class: 'review-line tone-text-warn' }, checkSentText(c)) : null);
    })),
  });
}

function finishedSection(R, d, dest) {
  const list = d.finishedNotSent;
  const ready = list.filter((x) => x.finishPlace != null);
  return queueSection({
    id: 'rv-fin-h', title: 'Finished: not sent live', count: list.length, tone: 'info',
    action: ready.length > 1 ? h('button', { type: 'button', class: 'btn primary', 'data-fk': 'rv-fin-all', disabled: !!R.bulk, onclick: (e) => sendFinished(ready, e.currentTarget) }, `Send all ${fmtInt(ready.length)} with finish place…`) : null,
    note: `Real splits of runners who finished that ${outsText(dest) || 'the outputs'} ${oneOut(dest) ? 'doesn\'t' : 'don\'t'} have as they are now. They are in the merged .lif file.`,
    more: `They came in after the finish, went out with an old time before they were corrected (a Move), or went out just after the runner finished, with the split place. They are not sent live: ${outsText(dest) || 'a scoreboard'} ${oneOut(dest) || !outsText(dest) ? 'takes' : 'take'} the place in a split packet as the runner's place. Send with finish place sends them with the runner's FinishLynx place${keepsText(dest) ? `, ${keepsText(dest)}` : ''}.`,
    list: h('ul', { class: 'review-list' }, list.map((x) => h('li', { class: 'review-item' + (x.finishPlace == null ? ' blocked' : '') + (R.freshKeys?.has('finishedNotSent|' + x.key) ? ' fresh' : '') },
      h('div', { class: 'ri-main' },
        h('div', { class: 'ri-who' }, bibButton(R, x.bib), whoNode(x, [h('span', { class: 'badge tone-finish' }, x.finishPlace != null ? `finished ${ordinal(x.finishPlace)}` : 'finished'), newChip(R, 'finishedNotSent|' + x.key)])),
        h('div', { class: 'ri-split' }, h('strong', {}, x.splitName), h('span', { class: 'mono' }, formatRaceTime(x.raceTicks, 1))),
        h('div', { class: 'ri-act' }, h('button', { type: 'button', class: 'btn small row-primary', 'data-fk': `rvf-${x.key}`, disabled: x.finishPlace == null || R.busy.has(x.key) || !!R.bulk,
          title: x.finishPlace == null ? FINISHED_NO_PLACE : null, onclick: (e) => sendFinished([x], e.currentTarget) }, 'Send with finish place…'))),
      x.sentOld ? h('p', { class: 'review-line tone-text-warn' }, sentOldText(x.splitName, x.sentOld.timeText, formatRaceTime(x.raceTicks, 1)))
        : x.sentAfter ? h('p', { class: 'review-line tone-text-warn' }, sentAfterText(x.sentAfter.place, x.finishPlace)) : null,
      x.finishPlace == null ? h('p', { class: 'review-line tone-text-warn' }, FINISHED_NO_PLACE) : null))),
  });
}

function manualSection(R, d, dest) {
  return queueSection({
    id: 'rv-man-h', title: 'Made-up and typed times', count: d.manual.length, tone: 'muted',
    note: 'Times you approved here. A real read for the split replaces one by itself.',
    list: h('ul', { class: 'review-list' }, d.manual.map((m) => h('li', { class: 'review-item' + (m.state === 'active' ? '' : ' done') },
      h('div', { class: 'ri-main' },
        h('div', { class: 'ri-who' }, bibButton(R, m.bib), whoNode(m, [newChip(R, 'manual|' + m.key)])),
        h('div', { class: 'ri-split' }, h('strong', {}, m.splitName), h('span', { class: 'mono' }, formatRaceTime(m.raceTicks, 1)),
          h('span', { class: `badge tone-${m.state !== 'active' ? 'muted' : m.source === 'typed' ? 'warn' : 'info'}`, title: m.basis || null }, SOURCE_WORDS[m.source] || 'Made-up time')),
        h('div', { class: 'ri-act' },
          m.at ? h('span', { class: 'help inline' }, `approved ${formatWall(m.at)}`) : null,
          h('button', { type: 'button', class: 'btn small danger', 'data-fk': `rvx-${m.key}`, disabled: R.busy.has(m.key), 'aria-disabled': busyAttr(`manual-del:${R.raceId}|${m.bib}|${m.splitId}`), onclick: (e) => removeManual(m, e.currentTarget) }, 'Remove…'))),
      h('p', { class: 'review-line' + (m.state === 'active' ? '' : ' tone-text-muted') }, manualStateText(m, dest)),
      m.basis ? h('p', { class: 'sr-only' }, m.basis) : null))),
  });
}

/**
 * Refresh the list (and the runner view) after something was sent. Split Relay answers a Review action with the list
 * as it is now (`review`): it is drawn at once, so the row just sent is gone before the next key press, and the
 * estimates that depend on it (the next split of the same runner) are the ones Send will use.
 */
function afterReviewChange(R, r) {
  const st = stateIn(r);
  if (st) applyState(st);
  if (S.review !== R) return;
  // the operator's own change: drawn at once (for a few seconds, until the list that follows it has come), even with
  // the pointer on the list
  R.forceUntil = Date.now() + 4000;
  if (r && typeof r === 'object' && r.review && typeof r.review === 'object' && r.review.raceId === R.raceId) {
    R.data = orderReview(R, normReview(r.review, configRace(S.state, R.raceId)));
    R.dataSig = JSON.stringify(R.data);
    R.error = '';
    R.at = Date.now();
    scheduleRender();
  } else queueReviewLoad(150);
  if (R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
}

/** "Not sent: bib 103 3K (6:00.0 is not after ...); ..." for the rows Split Relay turned away. */
function skippedText(skipped, items) {
  const name = (x) => arr(items).find((i) => i.bib === x.bib && i.splitId === x.splitId)?.splitName || 'a split';
  const list = arr(skipped);
  return list.slice(0, 3).map((x) => `bib ${x.bib} ${name(x)} (${str(x.why).replace(/\.$/, '')})`).join('; ')
    + (list.length > 3 ? ` and ${fmtInt(list.length - 3)} more` : '');
}

/** One row's Send (DESIGN 9.17 P3): one click; a runner who has finished gets a dialog about the place first. */
async function sendManual(item, btn, nextFk) {
  const R = S.review;
  if (!R || R.busy.has(item.key) || R.bulk) return;
  const row = rowTime(item, R.edits.get(item.key));
  if (!row.sendable) {
    toast(row.problem, 'warn');
    return;
  }
  const dest = destinations(S.state, R.raceId);
  if (item.finished) {
    const t = finishedManualText(item, row, dest);
    if (!(await confirmDialog({ title: t.title, body: t.body, confirm: t.confirm, back: btn })) || S.review !== R) return;
  }
  R.busy.add(item.key);
  // focus moves on to the next row's box, so a run of rows is Enter, Enter, Enter
  if (nextFk) focusKey(nextFk);
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.manual(R.raceId), manualBody(item, row));
    R.edits.delete(item.key);
    // what Split Relay did with it: sent as place N (or with the finish place), or why it waits
    const v = normReview({ manual: arr(r?.added) }, configRace(S.state, R.raceId)).manual[0];
    const what = `${item.splitName} ${v?.raceTicks != null ? formatRaceTime(v.raceTicks, 1) : row.text} (${row.typed ? 'typed time' : 'made-up time'})`;
    toast([`Bib ${item.bib}: ${what}.`, v ? manualStateText(v, dest) : `It goes ${sendsTo(dest)}.`, otherPlacesText(r?.change)].filter(Boolean).join(' '), v && !v.sent ? 'warn' : 'ok');
    afterReviewChange(R, r);
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${item.bib}, ${item.splitName}: ${err.message}`, 'bad');
    // back to the row that was not sent, so its time can be fixed
    const own = str(btn?.getAttribute?.('data-fk')).replace(/-send$/, '-time');
    if (own) focusKey(own);
  } finally {
    R.busy.delete(item.key);
    scheduleRender();
  }
}

/** "Move to 2K" / "Keep in 1K" (DESIGN 9.17 P2): the operator's choice pins the pass to that column. */
async function assignPass(c, move, btn, nextFk) {
  const R = S.review;
  if (!R || R.busy.has(c.key)) return;
  const dest = destinations(S.state, R.raceId);
  R.busy.add(c.key);
  focusKey(nextFk);
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.assign(R.raceId), { bib: c.bib, tod: c.passTod, splitId: move ? c.to.id : null });
    toast(checkToast(c, move, dest));
    afterReviewChange(R, r);
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${c.bib}: ${err.message}`, 'bad');
  } finally {
    R.busy.delete(c.key);
    scheduleRender();
  }
}

/** "Send with finish place" for real splits of finished runners, one or all (DESIGN 9.17 P4). */
async function sendFinished(items, btn) {
  const R = S.review;
  const list = arr(items).filter((x) => x && x.finishPlace != null);
  if (!R || !list.length || R.bulk) return;
  const dest = destinations(S.state, R.raceId);
  const t = finishedSendText(list, dest);
  if (!(await confirmDialog({ title: t.title, body: t.body, confirm: t.confirm, danger: t.force, back: btn })) || S.review !== R) return;
  let sent = 0;
  let last = null;
  const failed = [];
  for (const x of list) {
    if (S.review !== R) return;
    if (list.length > 1) R.bulk = `Sending ${fmtInt(sent + failed.length + 1)} of ${fmtInt(list.length)}…`;
    R.busy.add(x.key);
    scheduleRender();
    try {
      // force: the dialog said this race is not Active and the operator chose to send anyway
      const r = await api('POST', REVIEW_API.finished(R.raceId), { bib: x.bib, splitId: x.splitId, ...(t.force ? { force: true } : {}) });
      if (Number(r?.sent) > 0) sent++;
      else failed.push({ x, why: str(arr(r?.skipped)[0]?.why).replace(/\.$/, '') || 'no output took it' });
      last = r;
      const st = stateIn(r);
      if (st) applyState(st);
    } catch (err) {
      failed.push({ x, why: notSupported(err) ? REVIEW_NOT_SUPPORTED : err.message });
      if (notSupported(err)) break;
    } finally {
      R.busy.delete(x.key);
    }
  }
  R.bulk = '';
  focusKey('rv-fin-h');
  // the last answer carries the list as it is after all of them
  afterReviewChange(R, last);
  scheduleRender();
  if (!failed.length) toast(`${plural(sent, 'split')} ${sent === 1 ? 'goes' : 'go'} ${sendsTo({ ...dest, inactive: '' }, { lif: false })}, with the finish place.`);
  else toast(`Sent ${fmtInt(sent)} of ${fmtInt(list.length)}. Not sent: ${failed.slice(0, 3).map((f) => `bib ${f.x.bib} ${f.x.splitName} (${f.why})`).join('; ')}.`, 'bad');
}

/** Take a made-up or typed time away again. TrackScore keeps what it was sent (DESIGN 9.16 F1): said first. */
function removeManual(m, btn) {
  const R = S.review;
  if (!R) return undefined;
  const key = `${m.bib}|${m.splitId}`;
  return once(`manual-del:${R.raceId}|${key}`, btn, () => removeManualNow(R, m, key, btn));
}

async function removeManualNow(R, m, key, btn) {
  const dest = destinations(S.state, R.raceId);
  const t = removeManualText(m, dest);
  // still there: the same Review, the race, and the time in its list (it can go with a Clear or another window)
  const here = () => S.review === R && !!configRace(S.state, R.raceId) && !R.busy.has(key)
    && (!Array.isArray(R.data?.manual) || R.data.manual.some((x) => String(x.bib) === String(m.bib) && x.splitId === m.splitId));
  if (!here()) return;
  if (!(await confirmDialog({ title: t.title, body: t.body, confirm: t.confirm, danger: true, back: btn, alive: here,
    gone: `Bib ${m.bib}'s ${m.splitName || ''} time is no longer there to remove.`.replace('  ', ' ') })) || !here()) return;
  R.busy.add(key);
  scheduleRender();
  try {
    const r = await api('DELETE', REVIEW_API.manual(R.raceId), { bib: m.bib, splitId: m.splitId });
    // Split Relay says whether an output had it: only then can TrackScore still show it
    const sent = r && typeof r === 'object' && 'wasSent' in r ? r.wasSent === true : dest.outputs.length > 0;
    const where = listText(dest.outputs) || 'TrackScore and the live results';
    toast(`Bib ${m.bib}: the ${m.source === 'typed' ? 'typed' : 'made-up'} ${m.splitName} time is removed${dest.lif ? ' (and from the merged .lif file)' : ''}.${sent
      ? ` It had been sent: ${where} keep${dest.outputs.length === 1 ? 's' : ''} it until the race is cleared there (a packet can't empty a cell).`
      : ' It had not been sent, so nothing else shows it.'}`, sent ? 'warn' : 'info', 9000);
    afterReviewChange(R, r);
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : err.message, 'bad');
  } finally {
    R.busy.delete(key);
    scheduleRender();
  }
}

/* ============================================================================================================ */
/* Runner editor and race grid (DESIGN 9.23)                                                                     */
// One place to fix a runner: type a bib in the top bar (B), or click a bib anywhere. Each split is a cell: Enter sends
// a suggested time, or opens the choices for a time (Move, Not a split, This is the finish). Every change goes out at
// once, into the merged .lif file, and Undo (Ctrl+Z) puts it back. The whole race is a grid too (Review, All runners),
// the runners with something to fix first. Split Relay checks every change again and refuses in words; the panel only
// says what each choice would do before it is made.

/** DESIGN 9.23 F5: a race time of this much or more is a time of day typed in the race-time box (src/engine.js too). */
export const MAX_RACE_TICKS_TYPED = 3 * 3600 * TICKS_PER_SEC;

/** The feed's words for a pass set aside in Review and for a pass marked as the finish (src/engine.js has the same). */
export const IGNORED_TEXT = 'Not a split: you set this pass aside in Review. Not sent.';
export const MARKED_FINISH_TEXT = 'The finish: you marked this pass as the finish in Review. No more splits go live for this runner, so TrackScore keeps the finish place. Not sent.';

/**
 * How counting (or the operator) placed a pass, in words: the same as src/engine.js howText (a test checks it).
 * @param {string} how
 * @param {string} [split]
 */
export function howText(how, split = '') {
  return {
    counted: `Counted: ${split}.`,
    earliest: `Counted: ${split} (its earliest time).`,
    moved: `${split}: moved there in Review.`,
    shifted: `${split}: moved there in Review, with the time before it.`,
    kept: `${split}: kept there in Review.`,
    hold: `${split}: kept there in Review.`,
    replaces: `${split}: the real read that replaced the made-up time.`,
    extra: 'Extra pass: no split left for it (ignored).',
    'too-early': 'Too early for the next split (ignored).',
    'after-finish': 'After the finish (ignored).',
    'out-of-order': 'Out of course order (ignored).',
    ignored: 'Not a split: set aside in Review.',
    finish: 'The finish: marked in Review.',
  }[how] ?? '';
}

/** A bib as typed (digits, maybe a letter): anything else is looked up as a name or a team. */
export const looksLikeBib = (q) => /^[A-Za-z]?\d+[A-Za-z]?$/.test(str(q).trim());

/**
 * What the operator typed in a time box (DESIGN 9.23 F5), and how it is read: three parts with an hour of 3 or more is
 * a time of day ("16:36:43.6"), anything else a race time ("8:12.3", "1:02:03"); a bare number is refused (seconds or
 * minutes?). The line under the box says which: "Race time 8:12.3", "Time of day 16:36:43.6 = race time 8:43.1".
 * @param {string} text
 * @param {number|null} gunTicks the race's gun (a time of day needs it)
 * @returns {{ kind: 'race'|'tod'|'', ticks: number|null, tod: number|null, text: string, label: string, problem: string }}
 */
export function parseTimeEntry(text, gunTicks = null) {
  const t = str(text).trim();
  const out = { kind: '', ticks: null, tod: null, text: t, label: '', problem: '' };
  if (!t) return { ...out, problem: 'Type a time: a race time like 8:12.3, or a time of day like 16:36:43.6.' };
  if (/^\d+([.,]\d+)?$/.test(t)) return { ...out, problem: `"${t}" could be seconds or minutes. Type a race time like 8:12.3, or a time of day like 16:36:43.6.` };
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,4}))?$/.exec(t);
  if (m && Number(m[1]) >= 3) {
    const tod = parseGunText(t);
    if (tod == null) return { ...out, kind: 'tod', problem: `"${t}" is not a time of day. Type it like 16:36:43.6 (hours:minutes:seconds).` };
    if (!Number.isFinite(gunTicks)) return { ...out, kind: 'tod', tod, problem: 'This race has no gun time yet: a time of day needs it. Set the gun time first.' };
    let rt = tod - gunTicks;
    if (rt < -HALF_DAY) rt += TICKS_PER_DAY;
    else if (rt > HALF_DAY) rt -= TICKS_PER_DAY;
    const label = `Time of day ${formatTod(tod, 1)} = race time ${rt > 0 ? formatRaceTime(rt, 1) : '-'}`;
    if (rt <= 0) return { ...out, kind: 'tod', tod, ticks: rt, label, problem: `${formatTod(tod, 1)} is before the gun (${formatTod(gunTicks, 3)}).` };
    return { ...out, kind: 'tod', tod, ticks: rt, label };
  }
  const rt = parseRaceText(t);
  if (rt == null || rt <= 0) return { ...out, problem: `"${t}" is not a time. Type a race time like 8:12.3, or a time of day like 16:36:43.6.` };
  if (rt >= MAX_RACE_TICKS_TYPED) return { ...out, kind: 'race', ticks: rt, problem: `"${t}" is ${Math.floor(rt / 36e6)} h of race time. If it is a time of day, type it with its seconds (16:36:43.6).` };
  return { ...out, kind: 'race', ticks: rt, label: `Race time ${formatRaceTime(rt, 1)}` };
}

/** The body of POST /manual for a time the operator typed in a cell: a time of day goes as one (9.23 F5). */
export function typedBody(bib, splitId, entry) {
  const body = { bib, splitId, ifEmpty: true };
  if (entry.kind === 'tod') body.tod = entry.text;
  else body.time = entry.text;
  return body;
}

const BLOCK_WORD = (why) => (/^Check bib|columns first/.test(str(why)) ? 'Check first' : /finish place|has finished/.test(str(why)) ? 'Place unknown' : 'Not possible');

/** An empty cell that waits for a finisher's place (9.17 P4): nothing typed there can go live, so it has no time box. */
export const noPlaceBlock = (c) => c?.raceTicks == null && c?.kind === 'blocked' && BLOCK_WORD(c.why || c.blocked) === 'Place unknown';

/**
 * One cell of the runner editor or the race grid (DESIGN 9.23 F7), shared by both: the time and the line under it, the
 * one-word chip, its tone (every coloured state also has a word), what a screen reader says, and the info line.
 * @param {any} col a normRunner column
 * @param {any} runner normRunner
 * @param {any} [dest] destinations(): where a time goes
 * @param {{ editor?: boolean }} [opts] editor: the runner editor's info line, under which the problem lines say the
 *   whole of a question or a time that looks wrong (the grid's tooltip says it all)
 * @returns {{ kind: string, main: string, sub: string, chip: { text: string, tone: string }|null, tone: string,
 *   flag: ''|'flag'|'silenced', warn: string, aria: string, info: string }}
 */
export function cellModel(col, runner, dest = null, { editor = false } = {}) {
  const name = col?.splitName || 'This split';
  const filled = col?.raceTicks != null;
  const kind = col?.kind || (filled ? 'read' : 'not-yet');
  const m = { kind, main: '', sub: '', chip: null, tone: '', flag: '', warn: '', aria: '', info: '' };
  const bib = runner?.bib || '?';
  if (filled) {
    m.main = formatRaceTime(col.raceTicks, 1);
    m.sub = col.place != null ? ordinal(col.place) : '';
    const CHIP = { moved: ['Moved', 'info'], hold: ['Kept', 'muted'], keep: ['Kept', 'muted'], replaces: ['Read', 'ok'], 'made-up': ['Made-up', 'info'], typed: ['Typed', 'warn'] };
    if (col.status === 'check-column') {
      m.chip = { text: 'Held', tone: 'warn' };
      m.tone = 'held';
    } else if (col.status === 'split-paused') m.chip = { text: 'Paused', tone: 'warn' };
    // (9.24: the operator stopped sending this runner)
    else if (col.status === 'not-sending') m.chip = { text: 'Not sending', tone: 'muted' };
    // (9.25: the runner is not in this race)
    else if (col.status === 'not-in-race') m.chip = { text: 'Not in race', tone: 'muted' };
    // (9.26: its split is counted, not sent)
    else if (col.status === 'counted') {
      m.chip = { text: 'Not sent', tone: 'muted' };
      m.tone = 'counted';
    } else if (col.finishedNotSent) m.chip = { text: 'Not sent live', tone: 'finish' };
    else if (CHIP[kind]) m.chip = { text: CHIP[kind][0], tone: CHIP[kind][1] };
    if (col.flag) {
      m.flag = col.flag.silenced ? 'silenced' : 'flag';
      if (!col.flag.silenced && !m.tone) m.tone = 'flag';
    }
    // 9.23 F13: the column check or a flag says a mat missed the runner at this split: its pass is a later split's
    const here = !!col.missed?.here;
    if (here) m.chip = { text: 'Missed here?', tone: 'warn' };
    if (col.stale) m.warn = col.stale;
    // (a pass moved with the time before it says "Moved" too: its kind is 'moved', its how 'shifted')
    const how = { moved: col.how === 'shifted' ? 'moved here in Review, with the time before it' : 'moved here in Review', hold: 'kept here in Review', keep: 'kept here in Review', replaces: 'the real read that replaced a made-up time',
      'made-up': 'a made-up time', typed: 'a time you typed' }[kind] || (col.how === 'mat' ? 'from a timing point' : 'counted from the passes');
    m.aria = `${name}: ${m.main}${m.sub ? `, ${m.sub}` : ''}, ${how}${m.tone === 'held' ? ', held' : ''}${col.status === 'not-sending' ? ', not sending' : ''}${col.status === 'not-in-race' ? ', not in this race' : ''}${col.status === 'counted' ? ', counted, not sent' : ''}${m.flag === 'flag' ? ', looks wrong' : ''}${here ? ', missed here?' : ''}`;
    m.info = here && editor && col.missed.by === 'madeUp'
      // 9.23 F14: a made-up time the runner's later passes do not fit
      ? `${name} ${m.main}: this made-up time doesn't fit bib ${bib}'s later passes (below). ${missedLabel(col.missed)} makes it up again and moves the later times on. Enter opens the choices.`
      : here && editor ? (col.missed.sure !== false ? `${name} ${m.main} is probably a later split's: ${col.missed.runs ? 'mats' : 'the mat'} may have missed bib ${bib} at ${listText(col.missed.names)} (below). ${missedLabel(col.missed)} moves it and the later times on and fills ${col.missed.names.length > 1 ? 'them' : 'it'}. Enter opens the choices.`
      // 9.23 F14: how many splits in a row is not clear: each count is a choice (9.23 F15: nor where the run starts)
      : col.missed.unsure === 'late' ? `${name} ${m.main} may be a later split's, or bib ${bib} started late: Split Relay can't tell which (below). Enter opens the choices.`
      : col.missed.unsure === 'next' ? `${name} ${m.main} may be a later split's, or a slow leg: Split Relay can tell after bib ${bib}'s next pass (below). Enter opens the choices.`
      : col.missed.unsure === 'slow' ? `${name} ${m.main} may be a later split's, or a slow leg: Split Relay can tell once bib ${bib}'s finish is in (below). Enter opens the choices.`
      // (9.23 F20: its later times fit as read with one slow leg about as well)
      : col.missed.unsure === 'leg' ? `${name} ${m.main} may be a later split's, or bib ${bib} lost time on one leg: Split Relay can't tell which (below). Enter opens the choices.`
      // (9.23 F21: a stray pass, or one fast leg)
      : col.missed.unsure === 'stray' ? `${name} ${m.main} may be a later split's after a stray pass, or bib ${bib} ran one leg fast: Split Relay can't tell which (below). Enter opens the choices.`
      : col.missed.unsure === 'where' || otherSet(col.missed) ? `${name} ${m.main} may be a later split's, but Split Relay can't tell ${col.missed.alt ? 'which mats missed' : 'yet where the mat missed'} bib ${bib} (below). Enter opens the choices.`
        : `${name} ${m.main} is probably a later split's, but Split Relay can't tell${col.missed.alt ? '' : ' yet'} how many splits in a row the mat missed bib ${bib} (below). Enter opens the choices.`)
      : m.tone === 'held' && col.check ? (editor ? `${name} ${m.main} is held: Split Relay has a question about it (below). Enter opens the choices.`
        : `${name}: ${col.check.reason}. Held (not sent, not in the merged .lif file) until you choose: Enter opens the choices.`)
        : m.flag === 'flag' ? (editor ? `${name} ${m.main} looks wrong: why, and the fix, below. Enter opens the choices.` : `${col.flag.text} Enter opens the choices.`)
          : kind === 'made-up' || kind === 'typed' ? `${name} ${m.main}: ${how}.${col.basis ? ` ${col.basis}` : ''} Enter to change or remove it.`
            : col.how === 'mat' ? `${name} ${m.main}: from a timing point, its split is known.`
              : `${name} ${m.main}${m.sub ? `, ${m.sub}` : ''}: ${how}. Enter opens the choices (Move, Missed ${name}: add it, Not a split, This is the finish).`;
    if (col.status === 'not-sending') m.info = `${name} ${m.main}: read and counted, not sent: you stopped sending bib ${bib}. Send this runner again (above) puts it back.`;
    if (col.status === 'not-in-race') m.info = `${name} ${m.main}: read and counted, not sent: bib ${bib} is not in this race. Count them here (above) sends it.`;
    // (9.26: a pass in a split that is not sent: its choices are about which split it is, never about sending)
    if (col.status === 'counted' && !here) {
      m.info = kind === 'made-up' || kind === 'typed'
        ? `${name} ${m.main}: ${how}, counted, not sent. It keeps bib ${bib}'s later passes in their own splits and goes to no scoreboard. Enter to change or remove it.`
        : `${name} ${m.main}: counted, not sent. ${name} is set to Not sent on the race's page: the pass keeps bib ${bib}'s later passes in their own splits and goes to no scoreboard. Enter opens the choices (Move, Not a split).`;
    }
    if (col.stale) m.info += ` ${col.stale} there (an older time): Send bib ${bib} again puts this one there.`;
    if (col.finishedNotSent) m.info += ` Not sent live: bib ${bib} has finished (Send with finish place).`;
    return m;
  }
  if (kind === 'missing') {
    m.main = col.estimate != null ? formatRaceTime(col.estimate, 1) : '';
    m.sub = 'Suggested';
    m.tone = 'missing';
    m.aria = `${name}: missing, suggested ${m.main}`;
    const where = dest ? ` ${runner?.finished && runner.finishPlace != null ? `with the finish place (${runner.finishPlace}) ` : ''}${sendsTo(dest)}.${pausedNote(dest, col.splitId)}` : '.';
    m.info = `${name} is missing. Suggested ${m.main}${col.basis ? ` (${col.basis.replace(/\.$/, '').replace(/^From /, 'from ')})` : ''}. Enter sends it${where} Or type another time.`;
  } else if (kind === 'blocked') {
    m.main = col.estimate != null ? formatRaceTime(col.estimate, 1) : '—';
    m.sub = BLOCK_WORD(col.why || col.blocked);
    m.tone = 'blocked';
    m.aria = `${name}: missing, ${m.sub.toLowerCase()}`;
    m.info = `${name} is missing. ${col.why || col.blocked || 'Split Relay can\'t fill it yet.'}`;
    // 9.23 F13: a missed last split after a pass marked as the finish, with no finish place known: that pass can move
    // on (an extra pass), and the split goes with its own place
    if (col.missed?.ok) m.info += ` ${missedLabel(col.missed)} sends it with its own place instead (${col.missed.effect}): Enter opens the choices.`;
  } else if (col?.collectOnly) {
    // 9.26: an empty split that is not sent is missing nothing: no scoreboard has a column for it
    m.main = '—';
    m.sub = 'Not sent';
    m.tone = 'counted';
    m.aria = `${name}: counted only, no pass`;
    m.info = `${name} is counted, not sent: no scoreboard has a column for it, so it needs no time.${col.missed ? ' Enter opens the choices.' : ''}`;
  } else {
    m.main = '—';
    m.sub = 'Not yet';
    m.tone = 'not-yet';
    m.aria = `${name}: no time yet`;
    m.info = `${name}: no time yet. Bib ${bib} has no later split or finish: not there yet, or dropped out. Split Relay won't make one up; type a time only if you know it.`;
  }
  if (col?.leftover) {
    m.warn = `${col.leftover.outputs[0] || 'TrackScore'}: ${col.leftover.timeText || 'a time'}`;
    m.info += ` ${listText(col.leftover.outputs) || 'TrackScore'} still ${col.leftover.outputs.length > 1 ? 'show' : 'shows'} ${col.leftover.timeText || 'a time'} there: a time for ${name} replaces it.`;
  }
  return m;
}

/** The runner's finish cell: "26:22.1 · 164th · FinishLynx", "24:17.3 · marked", "— Not known". */
export function finishModel(runner) {
  // (9.23 F13: with merged .lif files off Split Relay may not know a finish: "Not finished" said it wrong)
  if (!runner?.finished) return { main: '—', sub: 'Not known', by: '', aria: 'Finish: not known to Split Relay' };
  const t = runner.finishTicks != null ? formatRaceTime(runner.finishTicks, 1) : '';
  const by = runner.finishBy === 'marked' ? 'marked' : runner.finishBy === 'mat' ? 'finish mat' : 'FinishLynx';
  const sub = [runner.finishPlace != null ? ordinal(runner.finishPlace) : '', by].filter(Boolean).join(' · ');
  return { main: t || 'Finished', sub, by, aria: `Finish: ${t}${runner.finishPlace != null ? `, ${ordinal(runner.finishPlace)}` : ''}, ${by}` };
}

/**
 * The choices for one time of a runner (DESIGN 9.23 F2, the menu): for a pass, the suggestion first (with what it does
 * to the later times), then Move to each split (the ones not allowed with why, the best fit "fits the pace"), Move only
 * this time, This is the finish, Not a split, Let Split Relay count it (when you set something), It's right; for a
 * made-up or typed time, Change time, Remove, Undo.
 * @param {any} runner normRunner
 * @param {{ col?: any, pass?: any }} at the cell (a column) or a pass in no column (Other passes)
 * @returns {{ title: string, items: { key: string, label: string, sub: string, disabled: boolean, primary: boolean,
 *   group: string, act: any }[] }}
 */
export function menuFor(runner, { col = null, pass = null } = {}) {
  const items = [];
  const add = (x) => items.push({ sub: '', disabled: false, primary: false, group: '', ...x });
  const p = pass || (col && col.passTod != null ? arr(runner?.passes).find((x) => x.tod === col.passTod) : null);
  // 9.23 F13: "Missed <split>: add it", the pass in the split and the later ones one column on and the split filled,
  // one change; first when the column check or a flag points at this split ("missed here?"), else after the Moves
  const ms = col?.missed ?? null;
  const missedItems = (primary) => {
    if (!ms) return;
    // 9.23 F14: while Split Relay can't tell how many splits in a row the mat missed, each count is a choice of its own,
    // neither the one click (9.23 F15: nor while it can't tell where)
    const group = primary ? missedGroup(ms) : 'A mat missed it';
    // (9.23 F16: a choice is its set, two mats missed apart too: the menu acts on its key)
    for (const x of missedChoices(ms)) {
      const key = missedKey(x, col?.splitId);
      add({ key: x === ms ? 'missed' : `missed-${key}`, label: missedLabel(x), sub: missedSub(x), primary: primary && ms.sure !== false && x.ok, disabled: !x.ok, group,
        act: { kind: 'missed', count: x.count, key } });
    }
    const one = missedOne(ms);
    if (one?.typed && (one.ok || /suggest|looks like|Check bib/.test(one.why))) add({ key: 'missed-time', label: `Missed ${one.names[0] || col.splitName}: type its time…`, sub: ms.one ? 'the later times move on one split' : 'the later times move on, as above', group, act: { kind: 'missed-time' } });
  };
  if (col && !p && (col.kind === 'made-up' || col.kind === 'typed')) {
    // (9.23 F14: a made-up time its later passes do not fit: the fix that makes it up again first)
    if (ms?.here) missedItems(true);
    add({ key: 'time', label: 'Change time…', act: { kind: 'time' } });
    add({ key: 'remove', label: 'Remove…', act: { kind: 'remove' } });
    const last = arr(runner?.changes)[0];
    if (last?.undoable) add({ key: 'undo', label: 'Undo', sub: last.text, act: { kind: 'undo', fix: last.fix } });
    return { title: `${col.splitName} ${formatRaceTime(col.raceTicks, 1)}`, items };
  }
  if (!p) {
    // (an empty last split after a pass marked as the finish: that pass is the one that moves on)
    missedItems(true);
    return { title: col ? col.splitName : '', items };
  }
  const here = p.inColumn ? p.where : '';
  const hereName = col?.splitName || p.splitName || '';
  const targets = arr(p.targets);
  const sug = col?.flag && !col.flag.silenced ? col.flag.suggest : col?.check ? { to: col.check.to, toName: col.check.toName } : null;
  // (9.23 F13: with no finish place known nothing of a finisher's goes live: the boards keep this time in its split, or,
  // when it never went out (held), the split stays empty there)
  const keeps = p.inColumn && runner?.finishPlace == null && p.finishOk?.ok
    ? (col?.delivered ? `no finish place known: the boards keep ${p.timeText} in ${hereName}` : `no finish place known: ${hereName} stays empty on the boards`) : '';
  // (9.23 F15: a pass held after the cell that says "Missed here?" moves on with that cell's pass: that cell's one click
  // first, acting there; 561's 22:29.3, held in 4400m after 19:41.6 in 4200m, whose own Move to 5300m would send the
  // finish pass as 5300m)
  const hk = col && !ms?.here && col.status === 'check-column' ? arr(runner?.columns).findIndex((c) => c?.missed?.here) : -1;
  const hm = hk >= 0 && hk < col.index ? runner.columns[hk].missed : null;
  if (hm) {
    const group = missedGroup(hm);
    for (const x of missedChoices(hm)) {
      const key = missedKey(x, runner.columns[hk].splitId);
      add({ key: x === hm ? 'missed-at' : `missed-at-${key}`, label: missedLabel(x), sub: missedSub(x), primary: hm.sure !== false && x.ok, disabled: !x.ok, group,
        act: { kind: 'missed', count: x.count, key, at: hk } });
    }
  }
  if (ms?.here) missedItems(true);
  if (sug && sug.to) {
    // (9.23 F19: nor when another cell of the runner says "Missed here?": its choices are the fix, and a held cell before
    // it no one click of its own; a late starter who missed 2400m had three, "Move to 1500m" and "Move to 2400m" wrong)
    const primary = !ms?.here && !hm && moveIsOneClick(runner);
    if (sug.to === 'finish') {
      add({ key: 'sug', label: 'This is the finish', sub: [p.finishOk?.effect, keeps].filter(Boolean).join(' · '), primary, disabled: !p.finishOk?.ok, why: p.finishOk?.why, act: { kind: 'move', to: 'finish' } });
    }
    else if (sug.to === 'none') add({ key: 'sug', label: 'Not a split', sub: fastAlso(col).length ? 'and the other time that is too fast' : '', primary, act: { kind: 'move', to: 'none', also: fastAlso(col) } });
    else {
      const t = targets.find((x) => x.splitId === sug.to);
      add({ key: 'sug', label: `Move to ${sug.toName}`, sub: t?.ok ? t.effect : t?.why || '', primary, disabled: !t?.ok, act: { kind: 'move', to: sug.to } });
    }
  }
  // the splits it can go to first (the one that fits the pace at the top), then the ones it can't, each with why
  const others = targets.filter((t) => t.splitId !== here && !(sug && t.splitId === sug.to));
  for (const t of [...others.filter((x) => x.ok && x.best), ...others.filter((x) => x.ok && !x.best), ...others.filter((x) => !x.ok)]) {
    add({ key: `to-${t.splitId}`, group: 'Move to', label: `Move to ${t.splitName}`, sub: t.ok ? [t.best ? 'fits the pace' : '', t.effect].filter(Boolean).join(' · ') : t.why,
      disabled: !t.ok, act: { kind: 'move', to: t.splitId } });
  }
  if (!ms?.here) missedItems(false);
  for (const t of arr(p.only)) {
    if (!t.ok || t.splitId === here) continue;
    add({ key: `only-${t.splitId}`, group: 'Move only this time', label: `Only this time to ${t.splitName}`, sub: 'the other times stay where they are', act: { kind: 'move', to: t.splitId, only: true } });
  }
  if (!sug || sug.to !== 'finish') {
    add({ key: 'finish', label: 'This is the finish', sub: p.finishOk?.ok ? [p.finishOk.best ? 'fits the pace' : '', p.finishOk.effect, keeps].filter(Boolean).join(' · ') : p.finishOk?.why || '',
      disabled: !!p.finishOk && !p.finishOk.ok, act: { kind: 'move', to: 'finish' } });
  }
  if (!sug || sug.to !== 'none') add({ key: 'none', label: 'Not a split', sub: 'a cool-down or stray pass: it takes no column', act: { kind: 'move', to: 'none' } });
  if (p.pinned) add({ key: 'count', label: 'Let Split Relay count it', sub: 'forget what you set for this pass', act: { kind: 'move', to: 'count' } });
  if (here && ((col?.flag && !col.flag.silenced) || col?.status === 'check-column')) add({ key: 'keep', label: `It's right: keep it in ${hereName}`, act: { kind: 'move', to: 'keep', also: fastAlso(col) } });
  // 9.24: a time too fast to be real: the runner may be off the course
  if (col?.flag?.kind === 'fast' && !col.flag.silenced && runner?.sending?.stop) add({ key: 'stop', label: 'Stop sending this runner', sub: 'nothing of this runner from this time on goes out', act: { kind: 'stop' } });
  return { title: `${p.timeText || formatRaceTime(p.raceTicks, 1)}${hereName && p.inColumn ? ` · ${hereName}` : ''}`, items };
}

/** 9.24: the other passes a too-fast mark's choices act on (the runner's other splits that are too fast to be real). */
const fastAlso = (col) => (col?.flag?.kind === 'fast' && !col.flag.silenced ? arr(col.flag.also) : []);

/**
 * The toast after a change of a runner (DESIGN 9.23 F2-F5): what it did, where it went, and what the scoreboards keep.
 * @param {any} change the server's change
 * @param {ReturnType<typeof destinations>} dest
 * @param {{ runner?: any }} [opts] runner: the runner after the change (what is missing now)
 */
export function fixToast(change, dest, { runner = null } = {}) {
  const c = change && typeof change === 'object' ? change : {};
  const bibs = arr(c.bibs);
  const who = bibs.length === 1 ? `Bib ${bibs[0]}: ` : '';
  let text = str(c.text).trim().replace(/\.$/, '');
  if (c.kind === 'only') text += '; the other times stay where they are';
  const parts = [`${who}${text}.`];
  const sent = arr(c.sentTo);
  const notLive = arr(c.notLive);
  const finished = notLive.find((x) => /finished/.test(str(x.why)));
  const held = notLive.find((x) => /question|held/.test(str(x.why)));
  // (9.24: Stop sending this runner sends nothing of the runner: what follows is about what it took back; 9.25: nor
  // does Not in this race)
  if (c.kind !== 'stop' && c.kind !== 'away' && (c.kind !== 'undo' || sent.length || arr(c.cells).length)) {
    if (dest?.inactive) parts.push(`Into the merged .lif file only: ${dest.inactive} is not Active.`);
    else if (sent.length) parts.push(`Sent to ${listText(sent)}${dest?.lif ? ', and into the merged .lif file' : ''}.`);
    else if (finished) {
      // without the finish place nothing of a finisher's can go live (it comes from FinishLynx's .lif file)
      parts.push(runner && runner.finished && runner.finishPlace == null
        ? `Into the merged .lif file only: bib ${finished.bib || bibs[0] || '?'} has finished, and Split Relay doesn't know the finish place yet.`
        : `Into the merged .lif file only: bib ${finished.bib || bibs[0] || '?'} has finished (Send with finish place in the runner).`);
    } else if (arr(c.cells).some((x) => x.after && !x.collectOnly) && dest?.lif) parts.push('Into the merged .lif file.');
    // 9.26: the change only put times in splits that are counted, not sent: nothing went out, and nothing should
    else if (arr(c.cells).some((x) => x.after) && arr(c.cells).every((x) => !x.after || x.collectOnly)) {
      const names = [...new Set(arr(c.cells).filter((x) => x.after && x.collectOnly).map((x) => x.splitName))];
      parts.push(`${listText(names)} ${names.length === 1 ? 'is' : 'are'} counted, not sent: nothing went out.`);
    }
  }
  for (const x of notLive) if (/paused/.test(str(x.why))) parts.push(pausedNote(dest, x.splitId).trim() || `${x.splitName} is paused: it goes out when you press ▶ Play.`);
  if (held) {
    // (9.23 F18: the question is the cell's that says "Missed here?" when the runner has one: after 489's Undo the toast
    // named 3100m, its first held split, while the question was on 2400m, where the run of missed mats starts)
    const q = arr(runner?.columns).find((x) => x?.missed?.here) ?? null;
    parts.push(q && q.splitName !== held.splitName
      ? `Split Relay now has a question about ${q.splitName}: ${held.splitName} and the times after it are held until you answer.`
      : `Split Relay now has a question about ${held.splitName}: it is held until you answer.`);
  }
  // the cells the change emptied that the boards still show, in one sentence (9.24: a stopped runner's are taken back,
  // not empty here, and a clearing line may have blanked them)
  const cleared = arr(c.cleared?.outputs);
  const lo = arr(c.leftover).filter((x) => !x.stopped);
  const many = arr(dest?.outputs).length > 1;
  if (lo.length) {
    parts.push(`${listText(lo.map((x) => x.splitName))} ${lo.length === 1 ? 'is' : 'are'} empty: ${listText(dest?.outputs) || 'TrackScore'} still ${many ? 'show' : 'shows'} `
      + `${listText(lo.map((x) => x.text))} there until you fill ${lo.length === 1 ? 'it' : 'them'}.`);
  }
  const st = arr(c.leftover).filter((x) => x.stopped);
  if (st.length) {
    parts.push(`${listText(dest?.outputs) || 'TrackScore'} still ${many ? 'show' : 'shows'} ${listText(st.map((x) => x.text))} there: a packet can't empty a cell.`);
  }
  if (cleared.length) parts.push(`A clearing line went to ${listText(cleared)}.`);
  // 9.24: the other runners' lines whose place the change moved went out again by themselves
  if (resentText(c)) parts.push(resentText(c));
  if (c.kind === 'finish' && runner) {
    const miss = arr(runner.columns).find((x) => x.raceTicks == null && (x.kind === 'missing' || x.kind === 'blocked'));
    if (miss?.kind === 'missing') parts.push(`${miss.splitName} is missing: Split Relay suggests ${formatRaceTime(miss.estimate, 1)}.`);
    else if (miss) {
      parts.push(`${miss.splitName} is missing, but it can't be sent until Split Relay knows the finish place (FinishLynx's .lif file: Settings, Merged .lif files).`
        // 9.23 F13: the way out with merged .lif files off
        + (miss.missed?.ok ? ` ${missedLabel(miss.missed)} (in its cell) sends it with its own place instead.` : ''));
    }
  }
  // (not after a change to a pass: Move, Not a split, the finish ..., nor after an Undo or Redo of one: the race tile
  // offers Resend when it matters)
  if (!PASS_CHANGES.has(c.kind) && otherPlacesText(c)) parts.push(otherPlacesText(c));
  for (const n of arr(c.notes)) parts.push(str(n));
  return parts.join(' ');
}

/**
 * DESIGN 9.24: "51 lines of other runners re-sent with their new places." after a change that moved their places (Split
 * Relay puts the boards right by itself), or ''.
 * @param {any} change the server's change (resent: { lines, outputs })
 */
export function resentText(change) {
  const n = Number(change?.resent?.lines) || 0;
  return n > 0 ? `${plural(n, 'line')} of other runners re-sent with ${n === 1 ? 'its' : 'their'} new place${n === 1 ? '' : 's'}.` : '';
}

/**
 * "12 other places on TrackScore are now out of date: Resend from the race tile." after a fill (9.23 F4; F13: the editor's
 * fill and Fill in N said nothing), or ''.
 * @param {any} change the server's change (staleOthers)
 */
export function otherPlacesText(change) {
  const n = Number(change?.staleOthers) || 0;
  // (9.23 F14: each runner's split once, whatever the number of outputs, on the outputs where it is out of date)
  const outs = arr(change?.staleOutputs).map(str).filter(Boolean);
  return n > 0 ? `${plural(n, 'other place')} on ${listText(outs) || 'TrackScore'} ${n === 1 ? 'is' : 'are'} now out of date: Resend from the race tile.` : '';
}

/** The changes made to a pass from the Move menu or the check queue (9.23 F2): their toast never counts other places. */
const PASS_CHANGES = new Set(['move', 'only', 'none', 'finish', 'count', 'keep', 'check', 'undo']);

/**
 * What the toast of a finisher's Undo adds (9.23 F3): only when a board keeps a time of one of the cells it changed
 * that went with the finish place (Send with finish place, or a change sent with it), and the toast did not say the
 * finisher's words already; else ''.
 * @param {any} change the server's change (finishKept: those cells)
 * @param {string} own the toast so far
 */
export function undoFinishNote(change, own) {
  return arr(change?.finishKept).length && !/has finished/.test(str(own))
    ? ' The boards keep what Send with finish place sent: send with the finish place again to put the old times back.' : '';
}

/**
 * "Fill in N missing" (DESIGN 9.23 F5): the missing splits that can go now, and the runners left out, in words: those
 * with no read after their last split and no finish (they may have dropped out: nothing is made up for them), finishers
 * whose place Split Relay doesn't know, and runners whose columns are to check first.
 * @param {any[]} items missing splits (normReview().missing, or a runner's columnItems)
 * @param {{ dropped?: string[] }} [opts] the bibs that may have dropped out (the race grid's "No read lately")
 * @returns {{ send: any[], left: { kind: string, bibs: string[], text: string }[] }}
 */
export function fillAllPlan(items, { dropped = [] } = {}) {
  const send = [];
  const groups = { noPlace: new Set(), flag: new Set(), check: new Set(), other: new Set() };
  for (const m of arr(items)) {
    if (m.finished && m.finishPlace == null) groups.noPlace.add(m.bib);
    // 9.23 F6: measured from a pass that looks wrong: that pass is decided first (Move, or It's right)
    else if (/^Check bib .* first: .*(looks like|looks wrong)/.test(str(m.blocked))) groups.flag.add(m.bib);
    else if (/^Check bib|columns first/.test(str(m.blocked))) groups.check.add(m.bib);
    else if (m.blocked || m.estimate == null) groups.other.add(m.bib);
    else send.push(m);
  }
  const list = (s) => listText([...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), 8);
  const left = [];
  const drop = [...new Set(arr(dropped))];
  if (drop.length) left.push({ kind: 'dropped', bibs: drop, text: `no read after their last split and no finish, so they may have dropped out: ${list(drop)}` });
  if (groups.noPlace.size) left.push({ kind: 'noPlace', bibs: [...groups.noPlace], text: `finished, but the finish place isn't known: ${list(groups.noPlace)}` });
  if (groups.flag.size) left.push({ kind: 'flag', bibs: [...groups.flag], text: `a split of theirs looks wrong: Move it or choose It's right first: ${list(groups.flag)}` });
  if (groups.check.size) left.push({ kind: 'check', bibs: [...groups.check], text: `check these runners' columns first: ${list(groups.check)}` });
  if (groups.other.size) left.push({ kind: 'other', bibs: [...groups.other], text: `Split Relay can't fill these yet: ${list(groups.other)}` });
  return { send, left };
}

/** One row of the Fill dialog: "586 · Runner O'Example · 3100m · 11:53.6 · 36.6% of 2400m–4200m". */
export function fillRowText(m) {
  const pct = /at ([\d.]+%) of that stretch/.exec(str(m.basis))?.[1];
  const span = m.prev?.name && m.next?.name ? `${pct ? `${pct} of ` : ''}${m.prev.name}–${m.next.name}` : '';
  return [m.bib, m.name, m.splitName, m.estimate != null ? formatRaceTime(m.estimate, 1) : '', span].filter(Boolean).join(' · ');
}

/**
 * Enter in the top bar's box (DESIGN 9.23 F1): go to the one runner found (or the exact bib in the Active race), keep the
 * list open when there are several, or say there is none.
 * @param {any[]} matches GET /api/find matches
 * @param {string} q
 * @returns {{ go?: any, open?: boolean, none?: string }}
 */
export function findPick(matches, q) {
  const list = arr(matches);
  const t = str(q).trim();
  if (!list.length) return { none: looksLikeBib(t) ? `No runner with bib ${t} has a read in any race.` : `No runner called "${t}" has a read yet.` };
  if (list.length === 1) return { go: list[0] };
  const active = list.filter((m) => m.by === 'bib' && m.active);
  if (active.length === 1) return { go: active[0] };
  return { open: true };
}

/**
 * "586 · A. Runner · State · Men's 8K · 3 of 7 splits": one row of the find list. 9.23 F13: a
 * runner a mat missed says where ("7 of 7 splits · missed 3100m?": the cells are full, one of them with a later split).
 */
export function findRowText(m) {
  const missed = arr(m.missed).map(str).filter(Boolean);
  // (9.23 F14: the other count Split Relay can't tell it from)
  const or = arr(m.missedOr).map(str).filter(Boolean);
  const others = Math.max(0, (Number(m.problems) || 0) - (missed.length ? 1 : 0));
  // (9.27: a runner whose reads came in as the other bib of a swapped pair says so)
  return [m.bib, m.name, m.team, m.raceName, `${fmtInt(m.filled)} of ${fmtInt(m.splits)} splits`, m.readAs ? `read as bib ${str(m.readAs)}` : '', missed.length ? `missed ${listText(missed)}${or.length ? ` (or ${listText(or)})` : ''}?` : '',
    // (9.23 F19: beside a missed split, the other things are more: "missed 2400m? · 2 more to look at" where the editor
    // says "3 look wrong")
    others ? `${fmtInt(others)}${missed.length ? ' more' : ''} to look at` : ''].filter(Boolean).join(' · ');
}

/** Whether the race grid fits as a table in this width (9.23 F9): else it is cards. */
export const gridFits = (width, n) => Number(width) >= 300 + Number(n) * 78;

/**
 * The race grid's rows as shown (9.23 F8): the chip's filter, the box's text (bib, name or team), "Only runners with
 * problems", and the order (problems first, bib, furthest along).
 * @param {any[]} rows Grid rows
 * @param {{ chip?: 'all'|'fix'|'changed'|'stopped', order?: 'problems'|'bib'|'far', q?: string, onlyProblems?: boolean }} f
 */
export function gridView(rows, { chip = 'all', order = 'problems', q = '', onlyProblems = false } = {}) {
  const k = norm(q);
  const fold = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  let list = arr(rows).filter((r) => {
    if (chip === 'fix' && !(r.tier <= 5)) return false;
    if (chip === 'changed' && !r.changed) return false;
    if (chip === 'stopped' && !r.stopped) return false;
    if (chip === 'all' && onlyProblems && !(r.tier <= 5)) return false;
    if (k && !(norm(r.bib) === k || norm(r.bib).startsWith(k) || fold(r.name).includes(fold(k)) || fold(r.team).includes(fold(k)))) return false;
    return true;
  });
  const byBib = (a, b) => str(a.bib).localeCompare(str(b.bib), undefined, { numeric: true });
  const filled = (r) => arr(r.cells).filter((c) => c && c.t != null).length;
  const lastT = (r) => {
    const t = arr(r.cells).filter((c) => c && c.t != null).map((c) => c.t);
    return t.length ? t[t.length - 1] : Infinity;
  };
  if (order === 'bib') list = list.sort(byBib);
  else if (order === 'far') list = list.sort((a, b) => (b.finished - a.finished) || filled(b) - filled(a) || lastT(a) - lastT(b) || byBib(a, b));
  else list = list.sort((a, b) => (a.tier ?? 8) - (b.tier ?? 8) || byBib(a, b));
  return list;
}

/**
 * The runner editor's keys on a cell (DESIGN 9.23 F7, 5.5): what a key does, and that the page must not act on it too.
 * A single unmodified key never changes the scoreboards: F and Delete only open the menu on that choice.
 * @param {{ key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} e
 * @param {{ i: number, n: number, kind: string, pass: boolean, editable: boolean, finishCell?: boolean }} ctx
 *   i: the cell (0-based), n: the cells (the finish cell included), pass: the cell holds a pass, editable: a made-up or
 *   typed time
 * @returns {{ act: string, to?: number, dir?: number, digit?: string, focus?: string } | null}
 */
export function editorKey(e, ctx) {
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (k === 'z' || k === 'Z')) return { act: e.shiftKey ? 'redo' : 'undo' };
  if (mod && !e.altKey && (k === 'y' || k === 'Y')) return { act: 'redo' };
  if (mod || e.altKey) return null;
  const filled = !['missing', 'blocked', 'not-yet'].includes(ctx.kind) && !ctx.finishCell;
  if (e.shiftKey && (k === 'ArrowRight' || k === 'ArrowLeft')) return ctx.pass ? { act: 'shift', dir: k === 'ArrowRight' ? 1 : -1 } : { act: 'none' };
  if (k === 'ArrowRight') return { act: 'focus', to: Math.min(ctx.n - 1, ctx.i + 1) };
  if (k === 'ArrowLeft') return { act: 'focus', to: Math.max(0, ctx.i - 1) };
  if (k === 'Home') return { act: 'focus', to: 0 };
  if (k === 'End') return { act: 'focus', to: ctx.n - 1 };
  if (k === 'ArrowDown') return { act: 'down' };
  if (k === 'ArrowUp') return { act: 'up' };
  if (k === 'Escape') return { act: 'close' };
  if (k === 'Enter' || k === ' ') {
    if (ctx.finishCell) return { act: 'info' };
    if (ctx.kind === 'missing') return { act: 'send' };
    return filled ? { act: 'menu' } : { act: 'box' };
  }
  if (/^[0-9]$/.test(k) && !ctx.finishCell && (!filled || ctx.editable)) return { act: 'box', digit: k };
  if ((k === 'f' || k === 'F') && ctx.pass) return { act: 'menu', focus: 'finish' };
  if ((k === 'Delete' || k === 'Backspace') && (ctx.pass || ctx.editable)) return { act: 'menu', focus: ctx.pass ? 'none' : 'remove' };
  return null;
}

/** Whether undoing this change is a Redo: it is an Undo ("Undone: …"), not a Redo ("Done again: …"). */
export const isRedo = (c) => c?.kind === 'undo' && /^Undone: /.test(str(c.text));

/** Where the editor puts focus (9.23 F7): the first held cell, else the first flagged, else the first missing, else the last filled. */
export function editorFocus(runner) {
  const cols = arr(runner?.columns);
  const at = (f) => cols.findIndex(f);
  // (9.23 F15: the cell that says "Missed here?" when it comes first: the run of missed mats can start before the pass
  // the column check holds, 561's 19:41.6 in 4200m before its held 22:29.3 in 4400m, and Enter there opens its one click)
  let i = at((c) => c.missed?.here || c.status === 'check-column');
  if (i < 0) i = at((c) => c.flag && !c.flag.silenced);
  if (i < 0) i = at((c) => c.kind === 'missing');
  if (i < 0) {
    for (let k = cols.length - 1; k >= 0; k--) {
      if (cols[k].raceTicks != null) {
        i = k;
        break;
      }
    }
  }
  return Math.max(0, i);
}

/**
 * The line under the runner's name: "Finish not known · 7 passes · 1 looks wrong", "Finished 164th in 26:22.1 (FinishLynx)";
 * 9.23 F18: "… · started about 5:00 after the gun?" for a runner Split Relay takes for a late starter.
 */
export function runnerStatusText(r) {
  const passes = arr(r?.passes).filter((p) => p.kind !== 'ignored').length;
  // (9.23 F15: a missed mat is one thing that looks wrong, whatever the number of held passes its one click settles)
  const at = arr(r?.columns).findIndex((c) => c?.missed?.here);
  const wrong = arr(r?.problems).filter((p) => ['flag', 'check', 'missed', 'made-up'].includes(p.kind) && !(at >= 0 && p.col > at)).length;
  const fin = r?.finished
    ? r.finishBy === 'marked'
      ? `Finish ${r.finishTicks != null ? formatRaceTime(r.finishTicks, 1) : ''} (you marked it) · ${r.finishPlace != null ? `${ordinal(r.finishPlace)}` : 'place not known yet'}`
      : `Finished${r.finishPlace != null ? ` ${ordinal(r.finishPlace)}` : ''}${r.finishTicks != null ? ` in ${formatRaceTime(r.finishTicks, 1)}` : ''} (${r.finishBy === 'mat' ? 'finish mat' : 'FinishLynx'})`
    : 'Finish not known';
  // (9.23 F18: a runner Split Relay takes for a late starter: its splits are sent as read, nothing to do; 9.23 F20: one
  // with a slow leg, every mat read)
  const late = r?.lateStart ? `started about ${r.lateStart} after the gun?` : '';
  const slow = r?.slowLeg ? `about ${r.slowLeg.text} lost before ${r.slowLeg.splitName}?` : '';
  return [fin, plural(passes, 'pass', 'passes'), wrong ? `${fmtInt(wrong)} look${wrong === 1 ? 's' : ''} wrong` : '', late, slow].filter(Boolean).join(' · ');
}

/* ---------- the top bar's "Bib or name" (9.23 F1) ---------- */

/**
 * The top bar's runner box and the Review page's frame (runner editor, To do / All runners). Called once from boot():
 * B focuses the box on every page; Enter opens the runner in Review (#review/<race>/<bib>).
 */
function bootRunnerFind() {
  buildReviewFrame();
  const form = $('#runner-find');
  const input = $('#rf-input');
  const list = $('#rf-list');
  if (!form || !input || !list) return;
  const F = (S.find = { q: '', matches: [], q0: null, at: -1, timer: 0, seq: 0, back: null, msg: '', loading: null });
  input.addEventListener('input', () => {
    F.q = input.value;
    F.msg = '';
    clearTimeout(F.timer);
    F.timer = setTimeout(() => findNow(), 150);
  });
  input.addEventListener('keydown', findKeys);
  input.addEventListener('focus', () => {
    if (F.matches.length && F.q0 === str(input.value).trim()) renderFindList(true);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    findGo();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!form.contains(e.target)) renderFindList(false);
  }, true);
}

/** Look the box's text up in every race (GET /api/find); the list follows. */
async function findNow() {
  const F = S.find;
  const q = str(F.q).trim();
  const seq = ++F.seq;
  if (!q) {
    F.matches = [];
    F.q0 = '';
    renderFindList(false);
    return [];
  }
  const p = api('GET', `/api/find?q=${enc(q)}`).then((r) => arr(r?.matches), (err) => {
    if (seq === F.seq) F.msg = notSupported(err) ? 'This Split Relay has no runner search yet. Restart it with this version (start.bat).' : err.message;
    return [];
  });
  F.loading = p;
  const matches = await p;
  if (seq !== F.seq) return matches;
  F.loading = null;
  F.matches = matches;
  F.q0 = q;
  F.at = matches.length ? 0 : -1;
  renderFindList(document.activeElement === $('#rf-input'));
  return matches;
}

function renderFindList(open) {
  const F = S.find;
  const list = $('#rf-list');
  const input = $('#rf-input');
  if (!list || !F) return;
  const show = open && (F.matches.length > 0 || !!F.msg);
  list.hidden = !show;
  input?.setAttribute('aria-expanded', String(show));
  if (!show) return;
  list.replaceChildren(...(F.msg ? [h('p', { class: 'rf-msg', role: 'status' }, F.msg)] : []),
    ...F.matches.slice(0, 8).map((m, i) => h('button', { type: 'button', class: 'rf-row local', role: 'option', id: `rf-opt-${i}`, 'aria-selected': String(i === F.at), tabindex: '-1',
      onclick: () => openRunner(m.raceId, m.bib, $('#rf-input')) },
    h('b', { class: 'mono' }, m.bib), h('span', {}, findRowText({ ...m, bib: '' }).replace(/^ · /, '')))));
  if (F.at >= 0) input?.setAttribute('aria-activedescendant', `rf-opt-${F.at}`);
  else input?.removeAttribute('aria-activedescendant');
}

/** Enter in the box: the one runner, or the list stays open on the first row, or "No runner …". */
async function findGo() {
  const F = S.find;
  const q = str($('#rf-input')?.value).trim();
  if (!q) return;
  F.q = q;
  let matches = F.matches;
  if (F.q0 !== q) matches = await (F.loading && F.q0 === q ? F.loading : findNow());
  if (F.at >= 0 && F.at < matches.length && F.matches === matches && F.at > 0) return openRunner(matches[F.at].raceId, matches[F.at].bib, $('#rf-input'));
  const pick = findPick(matches, q);
  if (pick.go) openRunner(pick.go.raceId, pick.go.bib, $('#rf-input'));
  else if (pick.none) {
    F.msg = pick.none;
    renderFindList(true);
  } else {
    F.at = 0;
    renderFindList(true);
  }
}

function findKeys(e) {
  const F = S.find;
  const n = Math.min(8, F.matches.length);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!n) return;
    e.preventDefault();
    F.at = (F.at + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderFindList(true);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const list = $('#rf-list');
    if (!list.hidden && F.at >= 0 && F.at < n && F.q0 === str(e.target.value).trim()) openRunner(F.matches[F.at].raceId, F.matches[F.at].bib, e.target);
    else findGo();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (!$('#rf-list').hidden) renderFindList(false);
    else {
      const back = F.back;
      F.back = null;
      if (back && back.isConnected && back !== e.target) back.focus();
      else e.target.blur();
    }
  }
}

/** B (or "/" off the Dashboard): the runner box, its text selected; Esc twice gives focus back. */
function focusRunnerFind() {
  const input = $('#rf-input');
  if (!input) return false;
  if (S.find && document.activeElement !== input) S.find.back = document.activeElement;
  input.focus();
  input.select?.();
  return true;
}

/** Open one runner in Review's editor: #review/<race>/<bib>; Esc in the editor gives focus back to `opener`. */
function openRunner(raceId, bib, opener = null) {
  if (!raceId || !bib) return;
  renderFindList(false);
  S.runnerOpener = opener || document.activeElement;
  S.runnerFrom = S.route.tab !== 'review' ? location.hash || '#live' : '';
  const hash = `#review/${enc(raceId)}/${enc(bib)}`;
  if (location.hash === hash && S.review?.runner?.bib === bib) {
    const d = editorRunner(S.review);
    S.reviewFocus = d ? `rec-${S.review.cellFocus ?? editorFocus(d)}` : 're-title';
    S.reviewScroll = true;
    S.review.force = true;
    scheduleRender();
  } else go(hash);
}

/** A bib anywhere (the feed, Review's lists, the grid): opens that runner's editor. */
function runnerBibButton(raceId, bib, { cls = 'bib-btn', label = null } = {}) {
  return h('button', { type: 'button', class: `${cls} local`, 'aria-label': label || `Bib ${bib}: open the runner`, title: 'Open this runner (every split, Move, fill)',
    onclick: (e) => {
      e.stopPropagation();
      openRunner(raceId, bib, e.currentTarget);
    } }, bib);
}

/* ---------- the Review page's frame ---------- */

function buildReviewFrame() {
  if (!PANELS.review || !EL.reviewTitle) return;
  EL.reviewEditor = h('div', { class: 'review-editor' });
  EL.reviewSwitch = h('div', { class: 'review-switch' });
  EL.reviewNotices = h('div', { class: 'review-notices' });
  EL.reviewGrid = h('div', { class: 'review-grid', hidden: true });
  EL.reviewSide = null;
  EL.reviewBody.classList.add('review-todo');
  PANELS.review.replaceChildren(
    h('div', { class: 'page-head' }, EL.reviewTitle, EL.reviewMeta),
    EL.reviewRaces, EL.reviewEditor, EL.reviewSwitch, EL.reviewNotices,
    h('div', { class: 'review-layout' }, EL.reviewBody, EL.reviewGrid));
  EL.reviewEditor.addEventListener('keydown', editorKeydown);
  EL.reviewEditor.addEventListener('pointerdown', editorPointerDown);
  EL.reviewGrid.addEventListener('keydown', gridKeydown);
}

/** The notices above both views: a paused split, a race not Active or without a gun, nobody known to have finished. */
function reviewNotices(R, cfg, rv) {
  if (!cfg) return null;
  const out = [];
  const vs = new Map(arr(rv?.splits).map((s) => [s.id, s]));
  const paused = arr(cfg.splits).filter((s) => s && s.id && !splitSending(s));
  if (paused.length) {
    out.push(h('div', { class: 'msg tone-warn review-paused' },
      h('strong', {}, `${listText(paused.map((s) => s.name || 'A split'))} ${paused.length === 1 ? 'is' : 'are'} paused: kept, not sent, not in the .lif file.`),
      h('span', { class: 'row push-right' }, paused.map((s) => h('span', { class: 'paused-one' },
        h('span', {}, `${s.name || 'Split'}: ${pausedText(splitHeld(vs.get(s.id)))}`), pauseButton(R.raceId, s, splitHeld(vs.get(s.id)), 'rv'))))));
  }
  if (rv && !Number.isFinite(rv.gunTicks)) out.push(h('p', { class: 'msg tone-info' }, 'This race has no gun time yet, so nothing has a race time to review. Set the gun time first.'));
  if (cfg.active === false) out.push(h('p', { class: 'msg tone-info' }, `${cfg.name || 'This race'} is not Active: what you send here goes into the .lif file only, until it is.`));
  const g = R.grid?.data;
  if (g && g.finishSource === 'none' && g.finishPassStream) {
    const lif = !!S.state?.config?.lif?.enabled;
    out.push(h('p', { class: 'msg tone-warn' }, `Split Relay doesn't know who has finished (${lif ? "FinishLynx's file for this race has no finishes yet" : 'merged .lif files are off'}). A split sent for a runner who has finished replaces their place in TrackScore. `,
      lif ? "Mark a runner's finish pass if FinishLynx has none." : [h('a', { href: '#settings/lif' }, 'Turn on merged .lif files (Settings)'), ", or mark a runner's finish pass."]));
  }
  // 9.27: the pairs of swapped bibs, while there is one (this race's line first), with Remove swap
  const swaps = swapsBlock(S.state, { raceId: R.raceId, always: false, key: 'rvsw' });
  if (swaps) out.push(h('div', { class: 'card review-swaps' }, swaps));
  return out;
}

/* ---------- the runner editor (9.23 F1-F5) ---------- */

const PASS_WORDS = { extra: 'After the last split', ignored: 'Not a split', finish: 'The finish', 'too-early': 'Too early', 'after-finish': 'After the finish', 'out-of-order': 'Out of order', repeat: 'Repeat' };

/**
 * What a pass that is in no split is, in the runner editor: PASS_WORDS, and (9.23 F19) one past the last split that came
 * after the runner's known finish is after the finish too (571's cool-down passes were "After the finish" and "After the
 * last split", both after FinishLynx's finish).
 */
export function passWords(p, r, none = 'No split') {
  if (p?.kind === 'extra' && r?.finishTicks != null && p.raceTicks != null && p.raceTicks > r.finishTicks) return PASS_WORDS['after-finish'];
  return PASS_WORDS[p?.kind] || none;
}

/** The runner the editor shows, as normRunner gives it, or null. */
const editorRunner = (R) => (R?.runner?.data?.found ? R.runner.data : null);

function runnerEditor(R, cfg, dest) {
  const r = R.runner;
  const close = h('button', { type: 'button', class: 'btn small ghost local', 'data-fk': 're-close', title: 'Close (Esc)', onclick: () => closeEditor(R) }, 'Close');
  const back = S.runnerFrom ? h('a', { class: 'btn small ghost local', href: S.runnerFrom, onclick: (e) => { e.preventDefault(); history.back(); } }, '← Back') : null;
  if (!r.data || (!r.data.found && !r.loading)) {
    const elsewhere = arr(r.elsewhere);
    return h('section', { class: 'card runner-editor', 'aria-labelledby': 're-title' },
      h('div', { class: 're-head' }, h('h2', { id: 're-title', tabindex: '-1', 'data-fk': 're-title' }, `Bib ${r.bib}`), h('span', { class: 'row push-right' }, back, close)),
      r.loading ? h('p', { class: 'help' }, 'Looking up…')
        : [h('p', { class: 'msg tone-warn', role: 'status' }, r.data ? `Bib ${r.bib} has no reads in ${cfg?.name || 'this race'}.` : r.error || 'Nothing found.'),
          // 9.27: a runner with no reads here may have run with another bib's chip; one of a swapped pair says so
          r.data?.swap ? h('p', { class: 're-off re-swap', role: 'status' }, r.data.swap.text, r.data.swap.atText ? ` Since ${r.data.swap.atText}.` : '',
            S.viewOnly ? null : h('button', { type: 'button', class: 'btn small ghost local', 'data-fk': 're-unswap', onclick: (e) => removeSwap(r.bib, e.currentTarget) }, 'Remove swap')) : null,
          r.data && !r.data.swap && !S.viewOnly ? h('div', { class: 'row' }, h('span', { class: 'help' }, 'Did this runner run with the chip of another bib?'),
            h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-swap', onclick: (e) => swapDialog(r.bib, e.currentTarget) }, 'Swapped bibs…')) : null,
          elsewhere.length ? h('div', { class: 'row' }, elsewhere.map((x) => h('button', { type: 'button', class: 'btn small local', onclick: (e) => openRunner(x.raceId, r.bib, e.currentTarget) }, `Open in ${x.raceName}`))) : null]);
  }
  const d = r.data;
  const view = S.viewOnly;
  const n = d.columns.length;
  if (R.cellFocus == null || R.cellFocus > n) R.cellFocus = editorFocus(d);
  const cells = d.columns.map((c, i) => editorCell(R, d, c, i, dest));
  const fm = finishModel(d);
  const finishCell = h('div', { class: `re-cell finish${R.drag ? ' drop-target' : ''}`, 'data-drop': 'finish' },
    h('button', { type: 'button', class: 'rc-main local', 'data-fk': `rec-${n}`, 'data-cell': String(n), tabindex: R.cellFocus === n ? '0' : '-1', 'aria-label': fm.aria,
      'aria-describedby': 're-info',
      onfocus: () => {
        R.cellFocus = n;
        setInfo(R, finishInfo(d));
      },
      onclick: () => setCell(R, n) },
    h('span', { class: 'rc-name' }, 'Finish'), h('span', { class: 'rc-time mono' }, fm.main), h('span', { class: 'rc-sub' }, fm.sub)));
  const other = d.passes.filter((p) => !p.inColumn);
  const last = d.changes[0];
  const fillN = d.columns.filter((c) => c.kind === 'missing').length;
  const head = h('div', { class: 're-head' },
    h('div', { class: 're-who' },
      h('h2', { id: 're-title', tabindex: '-1', 'data-fk': 're-title' }, `Bib ${d.bib}${d.name ? ` · ${d.name}` : ''}`, d.team ? h('span', { class: 're-team' }, ` ${d.team}`) : null),
      h('p', { class: 're-status' }, runnerStatusText(d)),
      // 9.24: the operator stopped sending this runner
      d.sending?.off ? h('p', { class: 're-off tone-text-warn', role: 'status' }, d.sending.off.text) : null,
      // 9.25: not in this race, probably not, on no start list, or here because the operator said so
      d.place ? h('p', { class: `re-off${d.place.kind === 'stranger' || d.place.kind === 'away' ? ' tone-text-warn' : ''}`, role: 'status' }, d.place.text) : null,
      // 9.27: the bib is one of a swapped pair: said in one line, with Remove swap
      d.swap ? h('p', { class: 're-off re-swap', role: 'status' }, d.swap.text, d.swap.atText ? ` Since ${d.swap.atText}.` : '',
        view ? null : h('button', { type: 'button', class: 'btn small ghost local', 'data-fk': 're-unswap', onclick: (e) => removeSwap(d.bib, e.currentTarget) }, 'Remove swap')) : null,
      d.alsoIn.length ? h('p', { class: 're-also' }, `Also in ${listText(d.alsoIn.map((x) => x.raceName))} `,
        d.alsoIn.map((x) => h('button', { type: 'button', class: 'btn small ghost local', onclick: (e) => openRunner(x.raceId, d.bib, e.currentTarget) }, 'Open there'))) : null),
    h('div', { class: 're-acts' },
      !view && fillN >= 2 ? h('button', { type: 'button', class: 'btn small primary', 'data-fk': 're-fill', disabled: !!R.fixBusy, onclick: (e) => fillRunner(R, d, e.currentTarget) }, `Fill in ${fmtInt(fillN)} missing`) : null,
      // 9.24: nothing more of this runner goes out (its reads are still counted and shown), or it is sent again
      !view && d.sending?.off ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-resume', disabled: !!R.fixBusy, onclick: () => resumeRunner(R, d.bib) }, 'Send this runner again') : null,
      !view && d.sending?.stop ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-stop', disabled: !!R.fixBusy, title: d.sending.stop.text, onclick: () => stopRunner(R, d.bib) }, 'Stop sending this runner') : null,
      // 9.25: Count them here for a runner kept off the boards; Not in this race (and It's right) for one who may not be
      !view && d.place?.kind === 'away' ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-here', disabled: !!R.fixBusy, onclick: () => placeRunner(R, d.bib, 'here') }, 'Count them here') : null,
      !view && d.place && d.place.kind !== 'away' ? h('button', { type: 'button', class: `btn small${d.place.kind === 'stranger' ? ' primary' : ''} local`, 'data-fk': 're-away', disabled: !!R.fixBusy, onclick: () => placeRunner(R, d.bib, 'away') }, 'Not in this race') : null,
      !view && (d.place?.kind === 'stranger' || d.place?.kind === 'unlisted') ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-right', disabled: !!R.fixBusy, onclick: () => placeRunner(R, d.bib, 'here') }, "It's right") : null,
      // 9.27: this runner ran with another bib's chip (and that runner with this one's)
      !view && !d.swap ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-swap', disabled: !!R.fixBusy, title: "This runner ran with another bib's chip", onclick: (e) => swapDialog(d.bib, e.currentTarget) }, 'Swapped bibs…') : null,
      back, close));
  const menu = R.menu ? editorMenu(R, d) : null;
  return h('section', { class: 'card runner-editor' + (R.fixBusy ? ' busy' : ''), 'aria-labelledby': 're-title', 'data-bib': d.bib },
    head,
    h('div', { class: 're-cells', role: 'group', 'aria-label': `Splits of bib ${d.bib}: arrow keys move, Enter sends a suggested time or opens the choices` }, cells, finishCell),
    h('p', { class: 're-info', id: 're-info', 'aria-live': 'polite' }, editorInfo(R, d, dest)),
    menu,
    view ? h('p', { class: 'help' }, 'View only: changes can be made on the Split Relay PC itself.') : editorProblems(R, d, dest),
    h('div', { class: 're-other', 'data-drop': 'none' },
      h('span', { class: 'sub-label' }, 'Other passes'),
      other.length ? other.map((p) => h('button', { type: 'button', class: `re-pass local${R.menu?.tod === p.tod ? ' open' : ''}`, 'data-fk': `rep-${p.tod}`, 'data-pass': String(p.tod), 'aria-haspopup': view ? null : 'menu',
        title: p.how, onclick: (e) => (view ? setInfo(R, p.how) : openMenu(R, { tod: p.tod }, e.currentTarget)) },
      h('span', { class: 'mono' }, p.timeText), ` · ${passWords(p, d)}`)) : h('span', { class: 'help inline' }, 'none')),
    last ? h('div', { class: 're-changes' },
      h('span', {}, `Last change: ${last.text}${last.undone ? ' (undone)' : ''} · ${last.atText}`),
      !view && last.undoable ? h('button', { type: 'button', class: 'btn small local', 'data-fk': 're-undo', onclick: (e) => undoFix(R, last.fix, { redo: isRedo(last), btn: e.currentTarget }) }, isRedo(last) ? 'Redo' : 'Undo') : null,
      d.changes.length > 1 ? h('details', { class: 'fold re-all-changes' }, h('summary', {}, 'All changes', h('span', { class: 'summary-note' }, fmtInt(d.changes.length))),
        h('ul', {}, d.changes.map((c) => h('li', { class: c.undone ? 'undone' : '' }, `${c.atText} · ${c.text}`)))) : null) : null,
    d.passes.length ? h('details', { class: 'fold passes', open: !!R.passesOpen, ontoggle: (e) => { R.passesOpen = e.currentTarget.open; } },
      h('summary', {}, 'How each pass was counted', h('span', { class: 'summary-note' }, fmtInt(d.passes.length))),
      h('ul', {}, d.passes.map((p) => h('li', {},
        h('span', { class: 'mono' }, Number.isFinite(p.tod) ? formatTod(p.tod) : ''), ' ',
        p.raceTicks != null ? h('span', { class: 'mono' }, `(${formatRaceTime(p.raceTicks, 1)})`) : null, ' → ',
        h('strong', {}, p.splitName || passWords(p, d, 'no split')), p.how ? ` · ${p.how}` : '',
        p.suggestion ? h('span', { class: 'tone-text-warn' }, ` · ${p.suggestion}`) : null)))) : null);
}

function editorCell(R, d, c, i, dest) {
  const m = cellModel(c, d, dest, { editor: true });
  const box = R.box && R.box.i === i;
  const pass = c.passTod != null;
  const cls = `re-cell tone-${m.tone || 'plain'} kind-${m.kind}${m.flag ? ` flag-${m.flag}` : ''}${R.menu?.i === i ? ' open' : ''}`;
  const drop = R.drag ? dropState(R, d, i) : null;
  const main = h('button', { type: 'button', class: 'rc-main local', 'data-fk': `rec-${i}`, 'data-cell': String(i), tabindex: R.cellFocus === i ? '0' : '-1',
    'aria-label': m.aria, 'aria-haspopup': !S.viewOnly && (pass || m.kind === 'made-up' || m.kind === 'typed') ? 'menu' : null, 'aria-describedby': 're-info',
    onfocus: () => {
      R.cellFocus = i;
      setInfo(R, m.info);
    },
    onpointerenter: () => setInfo(R, m.info),
    onclick: (e) => cellClick(R, d, i, e.currentTarget) },
  h('span', { class: 'rc-name' }, c.splitName),
  m.flag ? h('span', { class: `i i-alert rc-flag ${m.flag}`, 'aria-hidden': 'true' }) : null,
  h('span', { class: 'rc-time mono' }, m.main),
  h('span', { class: 'rc-sub' }, m.sub),
  m.chip ? h('span', { class: `badge tone-${m.chip.tone} rc-chip` }, m.chip.text) : null,
  m.warn ? h('span', { class: 'rc-warn' }, m.warn) : null);
  if (box) return h('div', { class: cls + ' boxed' }, cellBox(R, d, c, i, dest));
  // every split cell is a drop target, also one drawn before the drag began (a quick drag can end before a repaint)
  return h('div', { class: cls + (drop ? ` ${drop}` : ''), 'data-drop': String(i) },
    main,
    m.kind === 'missing' && !S.viewOnly ? h('button', { type: 'button', class: 'btn small rc-send local', tabindex: '-1', disabled: !!R.fixBusy, 'aria-label': `Send ${c.splitName} ${m.main}`,
      onclick: (e) => fillCell(R, d, c, null, e.currentTarget) }, 'Send') : null);
}

/** The time box in an empty (or made-up) cell: the suggestion in it, selected; the line says how the text is read. */
function cellBox(R, d, c, i, dest) {
  const gun = viewOf(S.state, R.raceId)?.gunTicks;
  const input = h('input', { type: 'text', class: 'mono rc-input', 'data-fk': `rec-box-${i}`, value: R.box.text, autocomplete: 'off', spellcheck: 'false', inputmode: 'decimal',
    'aria-label': `${c.splitName} time for bib ${d.bib}: a race time (8:12.3) or a time of day (16:36:43.6)`, 'aria-describedby': `rec-line-${i}` });
  const line = h('p', { class: 'rc-line', id: `rec-line-${i}` });
  const send = h('button', { type: 'button', class: 'btn small primary local', disabled: !!R.fixBusy }, 'Send');
  const cancel = h('button', { type: 'button', class: 'btn small ghost local' }, 'Cancel');
  // (9.23 F13: "Missed <split>: type its time": between the split before and the pass in this cell, which moves on)
  const missed = !!R.box.missed;
  const item = missed ? missedItem(d, c) : columnItem(d, c);
  const update = () => {
    const e = parseTimeEntry(input.value, gun);
    const bounds = e.ticks != null && !e.problem ? manualBoundsProblem(e.ticks, item) : '';
    line.textContent = e.problem || bounds || e.label;
    line.classList.toggle('tone-text-bad', !!(e.problem || bounds) && !!str(input.value).trim());
    send.disabled = !!R.fixBusy || !!e.problem || !!bounds;
    return { e, bounds };
  };
  input.addEventListener('input', () => {
    R.box.text = input.value;
    R.edits.set(`${d.bib}|${c.splitId}`, input.value);
    update();
  });
  const go = async () => {
    const { e, bounds } = update();
    if (e.problem || bounds) {
      toast(e.problem || bounds, 'warn');
      return;
    }
    // the suggestion as it was put in the box goes as Split Relay's estimate (made-up, with how it was made), not as a
    // typed time: only another time is the operator's own (9.23 F13: in a blocked cell too)
    // (a typed time is for one missed split: 9.23 F14, the one-split choice when Split Relay can't tell how many)
    const one = missed ? missedOne(c.missed) ?? c.missed : null;
    const est = missed ? one?.splits[0]?.estimate : c.raceTicks == null ? c.estimate : null;
    const sug = est != null ? formatRaceTime(est, 1) : '';
    const own = sug && e.kind === 'race' && str(input.value).trim() === sug ? null : e;
    if (missed) await addMissedFix(R, d, missedTarget(c, one), { entry: own, btn: send });
    else await fillCell(R, d, c, own, send);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const est = missed ? (missedOne(c.missed) ?? c.missed)?.splits[0]?.estimate : c.estimate;
      const sug = est != null ? formatRaceTime(est, 1) : c.raceTicks != null && !missed ? formatRaceTime(c.raceTicks, 1) : '';
      if (str(input.value).trim() !== sug && sug) {
        input.value = sug;
        R.box.text = sug;
        update();
        input.select();
      } else closeBox(R, i);
    }
    e.stopPropagation();
  });
  send.addEventListener('click', go);
  cancel.addEventListener('click', () => closeBox(R, i));
  queueMicrotask(update);
  if (R.box.select) {
    R.box.select = false;
    // (a microtask: the box is on the page by then; an animation frame never comes while the window is hidden)
    queueMicrotask(() => {
      input.focus();
      if (R.box.digit) {
        input.value = R.box.digit;
        R.box.text = R.box.digit;
        R.box.digit = '';
        update();
      } else input.select();
    });
  }
  return [h('span', { class: 'rc-name' }, missed ? `Missed ${c.splitName}` : c.splitName), input, line, h('span', { class: 'rc-box-acts' }, send, cancel)];
}

/** A missed split's time box as a row (9.23 F13): between the runner's split before it and the pass that moves on. */
function missedItem(d, c) {
  const before = d.columns.slice(0, c.index).reverse().find((x) => x.raceTicks != null);
  return { ...columnItem(d, c), splitName: c.splitName, prev: before ? { id: before.splitId, name: before.splitName, ticks: before.raceTicks } : { id: null, name: 'the gun', ticks: 0 },
    next: c.raceTicks != null ? { id: c.splitId, name: `${formatRaceTime(c.raceTicks, 1)}, which moves on`, ticks: c.raceTicks } : null };
}

function closeBox(R, i) {
  R.box = null;
  R.force = true;
  S.reviewFocus = `rec-${i}`;
  scheduleRender();
}

/** What the info line is for: this runner as the editor shows it now, and the cell that has focus. */
const infoKey = (R, d) => `${d?.bib ?? ''}|${R.runner?.sig ?? ''}|${R.cellFocus}`;

/** The finish cell's info line. */
function finishInfo(d) {
  const fm = finishModel(d);
  return d.finished ? `The finish: ${fm.main}${fm.sub ? ` (${fm.sub})` : ''}.${d.finishBy === 'marked' ? ' You marked this pass as the finish: "Let Split Relay count it" in its menu takes that back.' : ''}`
    : 'Finish not known: no finish from FinishLynx, a finish mat or a marked pass. Drop a pass here to mark it as the finish.';
}

/**
 * The editor's info line (9.23 F7): what the pointer, a drag or a disabled choice last said about this runner as it is
 * now and this focused cell; else what the focused cell is. Another runner, new data or another cell puts it back to
 * the focused cell's, so the line never speaks of another runner or of a time that has changed.
 */
function editorInfo(R, d, dest) {
  const key = infoKey(R, d);
  if (R.infoKey === key && R.info) return R.info;
  const i = R.cellFocus;
  const text = i === d.columns.length ? finishInfo(d) : d.columns[i] ? cellModel(d.columns[i], d, dest, { editor: true }).info : '';
  R.info = text;
  R.infoKey = key;
  return text;
}

function setInfo(R, text) {
  R.info = text;
  R.infoKey = infoKey(R, editorRunner(R));
  const el = $('#re-info');
  if (el && el.textContent !== text) el.textContent = text;
}

function setCell(R, i) {
  R.cellFocus = i;
  focusKey(`rec-${i}`);
}

function closeEditor(R) {
  const opener = S.runnerOpener;
  R.runner = null;
  R.menu = null;
  R.box = null;
  S.runnerOpener = null;
  S.runnerFrom = '';
  history.replaceState(null, '', `#review/${enc(R.raceId)}`);
  S.reviewBibRoute = '';
  S.route = parseRoute(location.hash);
  // focus goes back where the runner was opened from, once the page is drawn without the editor
  S.afterCloseFocus = opener || EL.reviewTitle;
  scheduleRender();
}

function cellClick(R, d, i, el) {
  const c = d.columns[i];
  R.cellFocus = i;
  if (S.viewOnly) return setInfo(R, cellModel(c, d, null, { editor: true }).info);
  if (c.raceTicks == null) {
    // 9.23 F13: a missed last split after a marked finish has its choices; one that waits for the finish place has
    // nothing to send (no time box with a Send that would be refused)
    if (c.missed) return openMenu(R, { i }, el);
    if (noPlaceBlock(c)) return setInfo(R, cellModel(c, d, null, { editor: true }).info);
    // (9.26: a split that is not sent needs no time: nothing to type, nothing to send)
    if (c.collectOnly) return setInfo(R, cellModel(c, d, null, { editor: true }).info);
    R.box = { i, text: R.edits.get(`${d.bib}|${c.splitId}`) ?? (c.estimate != null ? formatRaceTime(c.estimate, 1) : ''), select: true, digit: '' };
    R.force = true;
    scheduleRender();
    return;
  }
  openMenu(R, { i }, el);
}

/** Open the choices for a cell ({ i }) or a pass in no column ({ tod }); `focus` puts the keyboard on one choice. */
function openMenu(R, at, el, focus = '') {
  const d = editorRunner(R);
  if (!d) return;
  const col = at.i != null ? d.columns[at.i] : null;
  const pass = at.tod != null ? d.passes.find((p) => p.tod === at.tod) : null;
  const m = menuFor(d, { col, pass });
  if (!m.items.length) {
    if (col) setInfo(R, cellModel(col, d, null, { editor: true }).info);
    return;
  }
  const first = m.items.find((x) => x.key === focus && !x.disabled) || m.items.find((x) => !x.disabled) || m.items[0];
  R.menu = { i: at.i ?? null, tod: at.tod ?? null, focus: first.key, opener: el };
  R.force = true;
  S.reviewFocus = `rem-${first.key}`;
  scheduleRender();
}

function closeMenu(R, { refocus = true } = {}) {
  const m = R.menu;
  R.menu = null;
  R.force = true;
  if (refocus && m) S.reviewFocus = m.i != null ? `rec-${m.i}` : `rep-${m.tod}`;
  scheduleRender();
}

function editorMenu(R, d) {
  const col = R.menu.i != null ? d.columns[R.menu.i] : null;
  const pass = R.menu.tod != null ? d.passes.find((p) => p.tod === R.menu.tod) : null;
  const m = menuFor(d, { col, pass });
  let group = '';
  const rows = [];
  for (const x of m.items) {
    if (x.group && x.group !== group) rows.push(h('p', { class: 'rem-group', role: 'presentation' }, x.group));
    group = x.group;
    rows.push(h('button', { type: 'button', role: 'menuitem', class: `rem-item local${x.primary ? ' primary' : ''}`, 'data-fk': `rem-${x.key}`, 'data-key': x.key,
      tabindex: R.menu.focus === x.key ? '0' : '-1', 'aria-disabled': x.disabled ? 'true' : null,
      onclick: () => (x.disabled ? setInfo(R, x.sub || 'Not possible.') : menuAct(R, d, x.act, col, pass)) },
    h('span', { class: 'rem-label' }, x.label), x.sub ? h('span', { class: 'rem-sub' }, x.sub) : null));
  }
  return h('div', { class: 're-menu', role: 'menu', 'aria-label': `Choices for ${m.title}`, onkeydown: (e) => menuKeys(R, e) },
    h('p', { class: 'rem-title' }, m.title),
    rows,
    h('button', { type: 'button', class: 'btn small ghost rem-cancel local', onclick: () => closeMenu(R) }, 'Cancel'));
}

function menuKeys(R, e) {
  const items = [...e.currentTarget.querySelectorAll('.rem-item')];
  const i = items.indexOf(document.activeElement);
  let to = null;
  if (e.key === 'ArrowDown') to = items[(i + 1) % items.length];
  else if (e.key === 'ArrowUp') to = items[(i - 1 + items.length) % items.length];
  else if (e.key === 'Home') to = items[0];
  else if (e.key === 'End') to = items[items.length - 1];
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenu(R);
    return;
  } else if (e.key === 'Tab') {
    closeMenu(R, { refocus: false });
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  for (const x of items) x.tabIndex = -1;
  to.tabIndex = 0;
  R.menu.focus = to.dataset.key;
  to.focus();
}

async function menuAct(R, d, act, col, pass) {
  const p = pass || (col?.passTod != null ? d.passes.find((x) => x.tod === col.passTod) : null);
  // the keyboard stays on the cell (or the pass) while the change is sent: a redraw never drops it to the page
  closeMenu(R, { refocus: act.kind !== 'time' && act.kind !== 'missed-time' });
  if (act.kind === 'move') return movePass(R, d, p, act.to, { only: act.only === true, also: arr(act.also) });
  if (act.kind === 'stop') return stopRunner(R, d.bib, p?.tod ?? null);
  // (9.23 F15: `at`, the cell that says "Missed here?", from the menu of a pass held after it)
  const mc = act.at != null ? d.columns[act.at] : col;
  if (act.kind === 'missed' && mc) {
    const choices = missedChoices(mc.missed);
    return addMissedFix(R, d, missedTarget(mc, choices.find((x) => missedKey(x, mc.splitId) === act.key) ?? choices.find((x) => x.count === act.count) ?? mc.missed), {});
  }
  if (act.kind === 'missed-time' && col) {
    // the time box in this cell, with the suggestion in it: Send moves the pass on and sends the time typed (9.23 F13;
    // F14: the one-split choice's suggestion)
    const e = (missedOne(col.missed) ?? col.missed)?.splits[0]?.estimate;
    R.box = { i: col.index, text: e != null ? formatRaceTime(e, 1) : '', select: true, digit: '', missed: true };
    R.force = true;
    scheduleRender();
    return undefined;
  }
  if (act.kind === 'time' && col) {
    R.box = { i: col.index, text: formatRaceTime(col.raceTicks, 1), select: true, digit: '' };
    R.force = true;
    scheduleRender();
    return undefined;
  }
  if (act.kind === 'remove' && col) return removeManual({ bib: d.bib, splitId: col.splitId, splitName: col.splitName, raceTicks: col.raceTicks, source: col.kind === 'typed' ? 'typed' : 'made-up' }, null);
  if (act.kind === 'undo') return undoFix(R, act.fix);
  return undefined;
}

/**
 * 9.23 F19: whether a held or flagged pass's own Move is the one click (gold) in the runner editor, its cells' menus and
 * the Review rows: only when no cell of the runner says "Missed here?", whose choices are the fix. A late starter who
 * missed 2400m (539, six minutes late) had "Move to 1500m" and "Move to 2400m" gold on its real 800m and 1500m beside
 * "Missed 2400m: add it", whose one click alone sends every split right.
 */
export const moveIsOneClick = (runner) => !arr(runner?.columns).some((c) => c?.missed?.here);

/** The runner's problems in words, each with the one-click fix (9.23 F7). Gold never sits on an amber surface. */
export function editorProblems(R, d, dest) {
  const lines = [];
  // 9.23 F14: the cell where a mat missed the runner; the held passes after it move with it (their own choices are in
  // their cells' menus): one clear action per problem
  const hintAt = d.columns.findIndex((x) => x.missed?.here);
  // (9.23 F19: as in the cells' menus, a row's own Move is the one click only when no cell says "Missed here?")
  const movePrimary = moveIsOneClick(d) ? ' primary' : '';
  for (const p of d.problems) {
    const c = p.col != null ? d.columns[p.col] : null;
    const pass = c?.passTod != null ? d.passes.find((x) => x.tod === c.passTod) : null;
    const btns = [];
    let note = '';
    // 9.23 F13: where a mat missed the runner, the one fix is "Missed <split>: add it" (the later times move on, the
    // split is filled: one change); F14: while Split Relay can't tell how many splits in a row, each count is a choice,
    // neither the one click, and the line under it says what each does
    const missedBtns = () => {
      if (!c?.missed?.here) return [];
      if (c.missed.sure === false) note = missedUnsureText(c.missed);
      return missedChoices(c.missed).map((x) => h('button', { type: 'button', class: `btn small${c.missed.sure !== false ? ' primary' : ''} local`, disabled: !!R.fixBusy || !x.ok, title: x.ok ? missedSub(x) : x.why,
        onclick: (e) => addMissedFix(R, d, missedTarget(c, x), { btn: e.currentTarget }) }, missedLabel(x)));
    };
    if (p.kind === 'flag' && c?.flag && pass) {
      const s = c.flag.suggest;
      const mb = missedBtns();
      // (9.24: a too-fast mark's choices act on every split it covers; Stop sending this runner is one of them)
      const fast = c.flag.kind === 'fast';
      const also = fastAlso(c);
      if (mb.length) btns.push(...mb);
      else if (s) btns.push(h('button', { type: 'button', class: `btn small${movePrimary} local`, disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, s.to, { also }) },
        s.to === 'finish' ? 'This is the finish' : s.to === 'none' ? 'Not a split' : `Move to ${s.toName}`));
      else if (fast) btns.push(h('button', { type: 'button', class: 'btn small local', disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, 'none') }, 'Not a split'));
      if ((fast || (c.flag.kind === 'short' && !mb.length)) && d.sending?.stop) btns.push(h('button', { type: 'button', class: 'btn small local', disabled: !!R.fixBusy, onclick: () => stopRunner(R, d.bib, pass.tod) }, 'Stop sending this runner'));
      btns.push(h('button', { type: 'button', class: 'btn small local', disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, 'keep', { also }) }, "It's right"));
    } else if (p.kind === 'check' && c?.check && pass && !(hintAt >= 0 && p.col > hintAt)) {
      const mb = missedBtns();
      if (mb.length) btns.push(...mb);
      // (a pass that moves with the one before it to the finish has no split to go to: that one's fix settles it)
      else if (c.check.to) btns.push(h('button', { type: 'button', class: `btn small${movePrimary} local`, disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, c.check.to) }, `Move to ${c.check.toName}`));
      btns.push(h('button', { type: 'button', class: 'btn small local', disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, 'keep') }, `Keep in ${c.splitName}`));
    } else if ((p.kind === 'made-up' || p.kind === 'missed') && c?.missed?.here) {
      // 9.23 F14: a made-up time its later passes do not fit (the fix makes it up again and moves the pass after it on),
      // or a run of missed mats neither check pointed at
      btns.push(...missedBtns());
      if (p.kind === 'missed' && pass) btns.push(h('button', { type: 'button', class: 'btn small local', disabled: !!R.fixBusy, onclick: () => movePass(R, d, pass, 'keep') }, "It's right"));
    } else if (p.kind === 'not-live' && c) {
      btns.push(h('button', { type: 'button', class: 'btn small local', disabled: d.finishPlace == null || !!R.bulk,
        onclick: (e) => sendFinished([{ key: `${d.bib}|${c.splitId}`, bib: d.bib, name: d.name, team: d.team, splitId: c.splitId, splitName: c.splitName,
          raceTicks: c.raceTicks, finishPlace: d.finishPlace, sentOld: c.sentOld, sentAfter: c.sentAfter }], e.currentTarget) }, 'Send with finish place…'));
    } else if (p.kind === 'stale') {
      if (!lines.some((l) => l.stale)) btns.push(h('button', { type: 'button', class: 'btn small local', onclick: (e) => sendRunnerAgain(R, d, e.currentTarget) }, `Send bib ${d.bib} again`));
    } else if (p.kind === 'finish-differs') {
      const fin = d.passes.find((x) => x.kind === 'finish');
      if (fin) btns.push(h('button', { type: 'button', class: 'btn small local', onclick: () => movePass(R, d, fin, 'count') }, 'Let Split Relay count it'));
    } else if (p.kind === 'leftover' && c?.missed?.ok) {
      // (an empty last split after a pass marked as the finish, its finish place unknown: that pass moves on)
      btns.push(h('button', { type: 'button', class: 'btn small primary local', disabled: !!R.fixBusy, title: missedSub(c.missed),
        onclick: (e) => addMissedFix(R, d, missedTarget(c), { btn: e.currentTarget }) }, missedLabel(c.missed)));
    } else if (p.kind === 'missing') continue; // the empty cell itself is the fix
    const line = h('div', { class: `re-problem kind-${p.kind}` }, h('span', { class: 're-problem-text' }, p.text), btns.length ? h('span', { class: 're-problem-acts' }, btns) : null,
      note ? h('span', { class: 're-problem-note muted' }, note) : null);
    line.stale = p.kind === 'stale';
    lines.push(line);
  }
  return lines.length ? h('div', { class: 're-problems', 'aria-label': 'What to look at' }, lines) : null;
}

/* ---------- the editor's keys and drag ---------- */

function editorKeydown(e) {
  const R = S.review;
  const d = editorRunner(R);
  if (!R || !d || e.defaultPrevented) return;
  const cell = e.target.closest?.('.rc-main');
  if (!cell || !EL.reviewEditor.contains(cell)) {
    // Ctrl+Z anywhere in the editor that isn't a text box
    if (!typingIn(e.target) && (e.ctrlKey || e.metaKey) && /^[zZyY]$/.test(e.key)) {
      e.preventDefault();
      editorUndoKey(R, d, e.shiftKey || /^[yY]$/.test(e.key));
    } else if (e.key === 'Escape' && !typingIn(e.target) && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      closeEditor(R);
    }
    return;
  }
  const i = Number(cell.dataset.cell);
  const n = d.columns.length + 1;
  const c = d.columns[i];
  const ctx = { i, n, kind: c?.kind || '', pass: c?.passTod != null, editable: c?.kind === 'made-up' || c?.kind === 'typed', finishCell: i === d.columns.length };
  const k = editorKey(e, ctx);
  if (!k) return;
  e.preventDefault();
  e.stopPropagation();
  if (k.act === 'close' && (R.menu || R.box)) {
    // Esc closes the open choices or time box first, then the editor
    if (R.menu) closeMenu(R);
    else closeBox(R, R.box.i);
  } else if (k.act === 'focus') setCell(R, k.to);
  else if (k.act === 'down') EL.reviewEditor.querySelector('.re-problem button, .re-pass, .re-changes button')?.focus();
  else if (k.act === 'up') EL.reviewTitle?.focus();
  else if (k.act === 'close') closeEditor(R);
  else if (k.act === 'info') setInfo(R, $('#re-info')?.textContent || '');
  else if (S.viewOnly) setInfo(R, 'View only: changes can be made on the Split Relay PC itself.');
  else if (k.act === 'send') fillCell(R, d, c, null, null);
  else if (k.act === 'box' && c?.raceTicks == null && c.missed) openMenu(R, { i }, cell);
  else if (k.act === 'box' && noPlaceBlock(c)) setInfo(R, cellModel(c, d, null, { editor: true }).info);
  else if (k.act === 'box') {
    R.box = { i, text: k.digit ?? (c.raceTicks != null ? formatRaceTime(c.raceTicks, 1) : c.estimate != null ? formatRaceTime(c.estimate, 1) : ''), select: true, digit: k.digit || '' };
    R.force = true;
    scheduleRender();
  } else if (k.act === 'menu') openMenu(R, { i }, cell, k.focus || '');
  else if (k.act === 'shift') shiftPass(R, d, i, k.dir);
  else if (k.act === 'undo' || k.act === 'redo') editorUndoKey(R, d, k.act === 'redo');
}

function editorUndoKey(R, d, redo) {
  const last = d.changes[0];
  if (!last) return toast(`Nothing to ${redo ? 'redo' : 'undo'} for bib ${d.bib}.`, 'info');
  if (redo !== isRedo(last)) return toast(redo ? `Nothing to redo for bib ${d.bib}: the last change was not an Undo.` : `Bib ${d.bib}'s last change was an Undo: Ctrl+Y does it again.`, 'info');
  if (!last.undoable) return toast(`Bib ${d.bib}'s last change can't be ${redo ? 'redone' : 'undone'} here: ${last.why || 'it was changed since.'}`, 'warn');
  return undoFix(R, last.fix, { redo: true === isRedo(last) });
}

/** Shift+→ / Shift+←: this time one split later or earlier, with the later times, at once (9.23 5.5). */
function shiftPass(R, d, i, dir) {
  const c = d.columns[i];
  const pass = c?.passTod != null ? d.passes.find((x) => x.tod === c.passTod) : null;
  if (!pass) return toast(`${c?.splitName || 'This'} has no pass to move.`, 'info');
  const to = d.columns[i + dir];
  if (!to) {
    return toast(dir > 0 ? `No split after ${c.splitName}. If it is the finish, press F; if it is not a split, press Delete.` : `No split before ${c.splitName}.`, 'info');
  }
  const t = pass.targets.find((x) => x.splitId === to.splitId);
  if (t && !t.ok) return toast(t.why, 'warn');
  return movePass(R, d, pass, to.splitId);
}

/** Where a dragged pass may go: .drop-ok, .drop-no (why in the info line). */
function dropState(R, d, i) {
  const g = R.drag;
  const pass = d.passes.find((p) => p.tod === g.tod);
  if (!pass) return '';
  const list = g.only ? pass.only : pass.targets;
  const t = list.find((x) => x.splitId === d.columns[i]?.splitId);
  return t && t.ok ? 'drop-ok' : 'drop-no';
}

function editorPointerDown(e) {
  const R = S.review;
  const d = editorRunner(R);
  if (!R || !d || S.viewOnly || e.button !== 0 || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
  const el = e.target.closest?.('.rc-main, .re-pass');
  if (!el) return;
  let tod = null;
  if (el.classList.contains('re-pass')) tod = Number(el.dataset.pass);
  else {
    const c = d.columns[Number(el.dataset.cell)];
    if (c?.passTod != null && c.kind !== 'made-up' && c.kind !== 'typed' && c.how !== 'mat') tod = c.passTod;
  }
  if (tod == null) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let ghost = null;
  const pass = d.passes.find((p) => p.tod === tod);
  const move = (ev) => {
    if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
    if (!ghost) {
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      ghost = h('div', { class: 're-ghost mono', 'aria-hidden': 'true' }, pass?.timeText || '');
      document.body.append(ghost);
      R.drag = { tod, only: ev.altKey };
      R.force = true;
      scheduleRender();
    }
    if (R.drag && R.drag.only !== ev.altKey) {
      R.drag.only = ev.altKey;
      R.force = true;
      scheduleRender();
    }
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY + 12}px`;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-drop]');
    const drop = over?.dataset.drop;
    if (drop === 'finish') setInfo(R, `Drop on the finish: ${pass?.timeText} becomes the finish.${pass?.finishOk && !pass.finishOk.ok ? ` Not possible: ${pass.finishOk.why}` : ''}`);
    else if (drop === 'none') setInfo(R, `Drop here: ${pass?.timeText} is not a split.`);
    else if (drop != null && d.columns[Number(drop)]) {
      const c = d.columns[Number(drop)];
      const t = (R.drag.only ? pass.only : pass.targets).find((x) => x.splitId === c.splitId);
      setInfo(R, t?.ok ? `Drop on ${c.splitName}: ${pass.timeText} becomes ${c.splitName}${t.effect && !R.drag.only ? `; ${t.effect}` : ''}.${R.drag.only ? '' : ' Hold Alt to move only this time.'}` : `Not on ${c.splitName}: ${t?.why || 'not possible.'}`);
    }
  };
  const up = (ev) => {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('keydown', esc, true);
    if (!ghost) return;
    ghost.remove();
    const only = R.drag?.only;
    R.drag = null;
    R.force = true;
    scheduleRender();
    if (ev.type !== 'pointerup') return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-drop]');
    const drop = over?.dataset.drop;
    if (drop === 'finish') movePass(R, d, pass, 'finish');
    else if (drop === 'none') movePass(R, d, pass, 'none');
    else if (drop != null && d.columns[Number(drop)]) {
      const c = d.columns[Number(drop)];
      const t = (only ? pass.only : pass.targets).find((x) => x.splitId === c.splitId);
      if (t?.ok) movePass(R, d, pass, c.splitId, { only });
      else if (t) toast(t.why, 'warn');
    }
  };
  const esc = (ev) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    up({ type: 'cancel' });
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('keydown', esc, true);
}

/* ---------- the editor's actions: one request each, Undo in the toast ---------- */

/** Draw the answer of a change at once: the runner, the Review list, the grid; then the toast with Undo. */
function afterFix(R, r, { toastText = '', tone = 'ok', undo = true, focusVacated = true } = {}) {
  if (S.review !== R) return;
  const cfg = configRace(S.state, R.raceId);
  const before = editorRunner(R);
  if (r?.runner && R.runner && str(r.runner.bib) === R.runner.bib) {
    R.runner.data = normRunner(r.runner, cfg);
    R.runner.sig = JSON.stringify(R.runner.data);
    R.runner.at = Date.now();
  }
  afterReviewChange(R, r);
  queueGridLoad(R, 150);
  const d = editorRunner(R);
  const ch = r?.change;
  // focus: the cell a Move emptied when it is missing now, else where the editor starts
  if (d && R.runner) {
    let i = editorFocus(d);
    if (focusVacated && ch) {
      const vac = arr(ch.cells).find((x) => x.before && !x.after);
      const k = vac ? d.columns.findIndex((c) => c.splitId === vac.splitId) : -1;
      if (k >= 0 && d.columns[k].kind === 'missing') i = k;
    }
    R.cellFocus = i;
    const a = document.activeElement;
    if (EL.reviewEditor.contains(a) || !a || a === document.body || a === EL.reviewTitle) S.reviewFocus = `rec-${i}`;
  }
  void before;
  if (!ch) return;
  const dest = destinations(S.state, R.raceId);
  // (the runner of the change, which may not be the one in the editor: a To do row's one click)
  const own = r?.runner ? normRunner(r.runner, cfg) : null;
  const text = toastText || fixToast(ch, dest, { runner: own || d });
  // an Undo's toast offers Redo (undoing the Undo), a Redo's offers Undo again
  const label = isRedo(ch) ? 'Redo' : 'Undo';
  toast(text, tone, undefined, undo && ch.undoable && !S.viewOnly ? { action: { label, run: () => undoFix(R, ch.fix, { redo: isRedo(ch) }) } } : {});
}

/**
 * Move, Not a split, This is the finish, Let Split Relay count it, It's right (POST /runners/:bib/move). One click; asked
 * first only when it goes against the runner's pace (a time far from where runners of the same pace were) or, for a
 * runner who has finished, because the changed splits go with the finish place.
 */
async function movePass(R, d, pass, to, { only = false, also = [] } = {}) {
  if (!R || !pass || R.fixBusy || S.viewOnly) return;
  const body = { tod: pass.tod, to, from: pass.inColumn ? pass.where : '' };
  if (only) body.only = true;
  // (9.24: the runner's other passes that get the same answer in the same change: Not a split, It's right)
  if (also.length && (to === 'none' || to === 'keep')) body.also = also;
  const dest = destinations(S.state, R.raceId);
  const back = EL.reviewEditor?.querySelector(`[data-fk="rec-${R.cellFocus}"]`) || null;
  const t = to === 'finish' ? pass.finishOk : arr(pass.targets).find((x) => x.splitId === to);
  const where = to === 'finish' ? 'the finish' : t?.splitName || '';
  if (where && paceOff(t)) {
    const q = paceText(d, pass, where, paceOff(t), dest);
    if (!(await confirmDialog({ ...q, back })) || S.review !== R || R.fixBusy) return;
  }
  if (finishedMoveAsks(d, to, dest)) {
    const q = finishedMoveText(d, pass, to, where, dest);
    if (!(await confirmDialog({ ...q, back })) || S.review !== R || R.fixBusy) return;
    body.withFinishPlace = true;
  }
  R.fixBusy = true;
  R.forceUntil = Date.now() + 1000;
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.move(R.raceId, d.bib), body);
    afterFix(R, r);
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${d.bib}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
    if (R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
  } finally {
    R.fixBusy = false;
    R.forceUntil = Date.now() + 1000;
    scheduleRender();
  }
}

/**
 * A cell's "Missed <split>: add it" as the request needs it (9.23 F13): the split, the pass in it, how many, the basis;
 * `choice` one of its choices when Split Relay can't tell how many (9.23 F14: missedChoices), else the hint itself.
 * 9.23 F16: a choice's own split and pass (another set can start at another split), and its further runs (`also`).
 */
export const missedTarget = (col, choice = col.missed) => ({ splitId: choice?.splitId || col.splitId, passTod: choice?.passTod ?? col.missed?.passTod ?? null, count: choice?.count ?? 1,
  basis: choice?.splits?.[0]?.basis || '', ok: choice?.ok !== false, why: choice?.why || '', names: choice?.names ?? [col.splitName],
  ...missedAlso(choice) });

/**
 * 9.23 F16: a choice's runs after its first, as the request sends them ({ also: [{ splitId, count }] }), and the splits read
 * between them; 9.23 F20: and the stray passes it sets aside ({ aside: [<time of day>] }, with their times for the words).
 */
function missedAlso(choice) {
  const also = choice?.runs?.length > 1 ? { also: choice.runs.slice(1).map((r) => ({ splitId: r.splitId, count: r.count })), read: choice.read ?? [] } : {};
  return arr(choice?.aside).length ? { ...also, aside: choice.aside.map((a) => a.passTod), asideText: choice.aside.map((a) => a.timeText) } : also;
}

/**
 * "Missed <split>: add it" (DESIGN 9.23 F13, POST /runners/:bib/missed): the pass in that split and the later ones one
 * column on, and the split filled with the suggested time (or `entry`, a time typed in its box), as ONE change: one
 * click, one Undo, every changed cell sent at once with its laps to go. A finisher's moved splits go with the finish
 * place: asked first, as for a Move. From the editor (`who` the runner), a To do row or a check row (who: the row).
 * @param {any} who { bib, finished, finishPlace }
 * @param {{ splitId: string, passTod: number|null, count: number, basis?: string, ok?: boolean, why?: string, names?: string[],
 *   also?: { splitId: string, count: number }[], read?: string[], aside?: number[], asideText?: string[] }} t also: the other runs of
 *   two mats missed apart (9.23 F16); aside: the stray passes set aside with them (9.23 F20)
 */
async function addMissedFix(R, who, t, { entry = null, btn = null } = {}) {
  if (!R || !who || R.fixBusy || S.viewOnly) return;
  if (!entry && t.ok === false) {
    toast(`Bib ${who.bib}: ${t.why || 'not possible now.'}`, 'warn');
    return;
  }
  const dest = destinations(S.state, R.raceId);
  const body = { splitId: t.splitId, count: t.count || 1 };
  if (t.passTod != null) body.passTod = t.passTod;
  // (9.23 F16: two mats missed apart, all of them in one change; 9.23 F20: and the stray passes set aside with them)
  if (t.also?.length) body.also = t.also;
  if (t.aside?.length) body.aside = t.aside;
  if (entry) {
    if (entry.kind === 'tod') body.tod = entry.text;
    else body.time = entry.text;
  } else if (t.basis) body.basis = t.basis;
  const back = btn || EL.reviewEditor?.querySelector(`[data-fk="rec-${R.cellFocus}"]`) || null;
  if (finishedMoveAsks(who, 'missed', dest)) {
    const q = finishedMissedText(who, t, dest);
    if (!(await confirmDialog({ ...q, back })) || S.review !== R || R.fixBusy) return;
    body.withFinishPlace = true;
  }
  R.fixBusy = true;
  R.forceUntil = Date.now() + 1000;
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.missed(R.raceId, who.bib), body);
    R.box = null;
    afterFix(R, r, { focusVacated: false });
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${who.bib}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
    if (R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
  } finally {
    R.fixBusy = false;
    R.forceUntil = Date.now() + 1000;
    scheduleRender();
  }
}

/** The question before "Missed <split>: add it" for a finisher: what it changes goes with the finish place (9.17 P4). */
export function finishedMissedText(d, t, dest) {
  return {
    title: `Bib ${d.bib} has finished: send with the finish place?`,
    body: [`${missedLabel({ names: t.names, read: t.read, aside: arr(t.asideText).map((timeText) => ({ timeText })) })}: ${t.names?.length > 1 ? 'they go' : 'it goes'} ${sendsTo(dest)}, and the later times move on, all with place ${d.finishPlace}, the finish place${keepsText(dest) ? `, ${keepsText(dest)}` : ''}.`,
      finishPlaceSplitNote('those splits', d.finishPlace, dest)].filter(Boolean),
    confirm: 'Send with finish place',
  };
}

/**
 * Whether a Move goes against the runner's pace (9.23 F2): Split Relay's verdict on the target ('early' / 'late': far
 * from where runners of the same pace were, or for a first pass far outside the field's times there), '' when it fits.
 * @param {{ pace?: string }} t a pass's target (normRunner)
 * @returns {''|'early'|'late'}
 */
export const paceOff = (t) => (t?.pace === 'early' || t?.pace === 'late' ? t.pace : '');

/** The question before a Move that goes against the runner's pace: it goes live at once, so it is said first. */
export function paceText(d, pass, where, pace, dest) {
  const outs = outsText(dest);
  return {
    title: `Move ${pass.timeText} to ${where}?`,
    body: [`${pass.timeText} doesn't fit ${where} at bib ${d.bib}'s pace: runners of the same pace ${pace === 'early' ? 'take far longer to get there' : 'get there far sooner'}.`,
      outs && !dest?.inactive ? `It goes to ${outs} at once; Undo puts it back.` : 'Undo puts it back.'],
    confirm: 'Move anyway',
  };
}

/** Whether a change to a finisher's pass asks first: what it changes goes live with the finish place (9.17 P4). */
export function finishedMoveAsks(d, to, dest) {
  return !!d?.finished && d.finishPlace != null && to !== 'keep' && to !== 'finish' && !dest?.inactive && arr(dest?.outputs).length > 0;
}

/** The question before a change to a finisher's pass: the splits it changes go with the finish place (one dialog). */
export function finishedMoveText(d, pass, to, where, dest) {
  const what = to === 'none' ? `${pass.timeText} is not a split` : to === 'count' ? `Split Relay counts ${pass.timeText} again` : `${pass.timeText} goes to ${where}`;
  return {
    title: `Bib ${d.bib} has finished: send with the finish place?`,
    body: [`${what}. The splits this changes go ${sendsTo(dest)}, with place ${d.finishPlace}, the finish place${keepsText(dest) ? `, ${keepsText(dest)}` : ''}.`,
      finishPlaceSplitNote('those splits', d.finishPlace, dest)].filter(Boolean),
    confirm: 'Send with finish place',
  };
}

/**
 * Fill an empty cell (9.23 F5): the suggested time (entry null: Split Relay's own estimate, made-up), or a typed one.
 * A finisher's time goes with the finish place (said first); a time past the runner's last read asks first.
 */
async function fillCell(R, d, c, entry, btn) {
  if (!R || R.fixBusy || S.viewOnly) return;
  const dest = destinations(S.state, R.raceId);
  if (!entry && c.kind !== 'missing') return;
  const text = entry ? formatRaceTime(entry.ticks, 1) : formatRaceTime(c.estimate, 1);
  if (entry && c.kind === 'not-yet') {
    const before = [...d.columns.slice(0, c.index)].reverse().find((x) => x.raceTicks != null);
    const ok = await confirmDialog({ title: `Bib ${d.bib} may have dropped out`, back: btn,
      body: [`Split Relay has no read of bib ${d.bib} after ${before ? `${before.splitName} (${formatRaceTime(before.raceTicks, 1)})` : 'the gun'} and no finish. A typed ${c.splitName} time (${text}) goes ${sendsTo(dest)} as a split.`],
      confirm: `Send ${text}` });
    if (!ok || S.review !== R) return;
  }
  if (d.finished && d.finishPlace == null) {
    // (9.23 F13: no dialog that says "place ?" and a Send that Split Relay refuses)
    toast(`Bib ${d.bib}, ${c.splitName}: ${c.why || FINISHED_NO_PLACE}`, 'warn');
    return;
  }
  if (d.finished) {
    const item = { ...columnItem(d, c), finished: true, finishPlace: d.finishPlace };
    const t = finishedManualText(item, { text, typed: !!entry }, dest);
    if (!(await confirmDialog({ title: t.title, body: t.body, confirm: t.confirm, back: btn })) || S.review !== R) return;
  }
  R.fixBusy = true;
  R.forceUntil = Date.now() + 1000;
  scheduleRender();
  try {
    const body = entry ? typedBody(d.bib, c.splitId, entry) : { bib: d.bib, splitId: c.splitId, ifEmpty: true, ...(c.basis ? { basis: c.basis } : {}) };
    if (c.raceTicks != null) delete body.ifEmpty; // "Change time…" replaces the made-up time
    const r = await api('POST', REVIEW_API.manual(R.raceId), body);
    R.edits.delete(`${d.bib}|${c.splitId}`);
    R.box = null;
    const v = normReview({ manual: arr(r?.added) }, configRace(S.state, R.raceId)).manual[0];
    const what = `${c.splitName} ${v?.raceTicks != null ? formatRaceTime(v.raceTicks, 1) : text} (${entry ? 'typed time' : 'made-up time'})`;
    afterFix(R, r, { toastText: [`Bib ${d.bib}: ${what}.`, v ? manualStateText(v, dest) : `It goes ${sendsTo(dest)}.`, otherPlacesText(r?.change)].filter(Boolean).join(' '),
      tone: v && !v.sent ? 'warn' : 'ok', focusVacated: false });
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${d.bib}, ${c.splitName}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
    if (/another window/.test(str(err.message)) && R.box) {
      R.box = null;
      toast(`Filled in another window. Your ${text} was not sent.`, 'info');
    }
    if (R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
  } finally {
    R.fixBusy = false;
    R.forceUntil = Date.now() + 1000;
    scheduleRender();
  }
}

/** The runner's "Fill in N missing": one click (the suggestions are on screen); a finisher's are said first. */
async function fillRunner(R, d, btn) {
  const items = d.columns.filter((c) => c.kind === 'missing').map((c) => ({ ...columnItem(d, c), finished: d.finished, finishPlace: d.finishPlace }));
  if (!items.length) return;
  const dest = destinations(S.state, R.raceId);
  if (d.finished) {
    const plan = sendAllPlan(items);
    const t = sendAllText(plan, dest);
    if (!(await confirmDialog({ title: t.title, body: t.body, confirm: t.confirm, back: btn })) || S.review !== R) return;
  }
  await fillMany(R, items, { bib: d.bib });
}

/** One { items } request for many missing splits (one change: one Undo), every row only if its cell is still empty. */
async function fillMany(R, items, { bib = '' } = {}) {
  const dest = destinations(S.state, R.raceId);
  R.fixBusy = true;
  R.bulk = `Sending ${fmtInt(items.length)}…`;
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.manual(R.raceId), { items: items.map((m) => ({ bib: m.bib, splitId: m.splitId, ifEmpty: true })) });
    const added = normReview({ manual: arr(r?.added) }, configRace(S.state, R.raceId)).manual;
    const skipped = arr(r?.skipped);
    const one = new Set(added.map((a) => a.bib)).size === 1 ? added[0]?.bib : '';
    const head = one ? `Bib ${one}: ${listText(added.map((a) => `${a.splitName} ${formatRaceTime(a.raceTicks, 1)}`))} (made-up)` : `${plural(added.length, 'made-up split time')}`;
    const text = [`${head} ${added.length === 1 ? 'goes' : 'go'} ${sendsTo(dest)}.${skipped.length ? ` Not sent: ${skippedText(skipped, items)}.` : ''}`, otherPlacesText(r?.change)].filter(Boolean).join(' ');
    afterFix(R, r, { toastText: text, tone: skipped.length ? 'warn' : 'ok', focusVacated: false });
    void bib;
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Nothing was sent: ${err.message}`, 'bad');
  } finally {
    R.fixBusy = false;
    R.bulk = '';
    scheduleRender();
  }
}

/**
 * "Fill in N missing…" for many runners (9.23 F5): a list to check, a tick per row, the runners left out and why, then
 * one request with the ticked rows.
 */
async function fillAllDialog(R, items, { title = '', btn = null, dropped = [] } = {}) {
  if (!R || R.fixBusy) return;
  const plan = fillAllPlan(items, { dropped });
  if (!plan.send.length) {
    toast(plan.left.length ? `Nothing to fill now: ${plan.left.map((x) => x.text).join('; ')}.` : 'Nothing to fill now.', 'info', 9000);
    return;
  }
  const dest = destinations(S.state, R.raceId);
  const ticks = new Map(plan.send.map((m) => [m.key, true]));
  const count = () => [...ticks.values()].filter(Boolean).length;
  let yesBtn = null;
  const list = h('ul', { class: 'fill-list' }, plan.send.map((m) => h('li', {}, h('label', { class: 'check-label' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => {
      ticks.set(m.key, e.target.checked);
      if (yesBtn) {
        yesBtn.textContent = `Send ${fmtInt(count())}`;
        yesBtn.disabled = !count();
      }
    } }), h('span', {}, fillRowText(m))))));
  const n = plan.send.length;
  const fin = plan.send.filter((m) => m.finished).length;
  const ok = await confirmDialog({
    title: title || `Fill in ${plural(n, 'missing split')}?`, back: btn, confirm: `Send ${fmtInt(n)}`,
    body: [`${n === 1 ? 'It goes' : 'They go'} ${sendsTo(dest)}, each ranked with the real splits at its split. Untick a row to leave it out.`,
      fin ? `${fmtInt(fin)} of them ${fin === 1 ? 'is' : 'are'} of runners who have finished: they go with the finish place${keepsText(dest) ? `, ${keepsText(dest)}` : ''}.` : '',
      ...plan.left.map((x) => `Left out: ${x.text}.`),
      'Made-up times are estimates, not timed splits. Review lists them, and a real read for one of those splits later replaces it.'].filter(Boolean),
    extra: list, lead: 2 + plan.left.length, onReady: (b) => { yesBtn = b; },
  });
  if (!ok || S.review !== R) return;
  const pick = plan.send.filter((m) => ticks.get(m.key));
  if (pick.length) await fillMany(R, pick);
}

/**
 * The Undo dialog when a scoreboard keeps what the change sent (the 409 UNDO_LEAVES): a cell the undo empties (9.23 F3:
 * a packet can fill a cell, never empty one), or (9.23 F13) a pass the undo gives back to Passes to check, held: nothing
 * is sent for it until the operator chooses.
 * @param {{ bib: string, splitName: string, text: string, withFinishPlace?: boolean, held?: boolean }[]} leaves
 * @param {string[]} outputs
 * @param {{ bib: string, finished: boolean } | null} runner the editor's runner
 * @returns {{ title: string, body: string[] }}
 */
export function undoLeavesDialog(leaves, outputs, runner = null) {
  const outs = listText(outputs) || 'TrackScore and the live results';
  const keep = arr(outputs).length === 1 ? 'keeps' : 'keep';
  const gone = arr(leaves).filter((x) => !x.held);
  const held = arr(leaves).filter((x) => x.held);
  const body = [];
  if (gone.length) {
    // (9.23 F17: the splits it empties by name: after a fix of two splits "the split" read as one of them)
    const empties = [...new Set(gone.map((x) => x.splitName).filter(Boolean))];
    body.push(`Split Relay forgets ${gone.length > 1 ? 'them' : 'it'} and takes ${gone.length > 1 ? 'them' : 'it'} out of the merged .lif file; ${empties.length ? `${listText(empties)} ${empties.length > 1 ? 'are' : 'is'} empty again in Review` : 'Review lists the split as missing again'}. ${outs} ${keep} ${gone.length > 1 ? `the ${fmtInt(gone.length)} that were sent` : `${gone[0]?.text || 'the time'} at ${gone[0]?.splitName || 'that split'}`}: a split packet can fill a cell but never empty one.`);
  }
  if (held.length) {
    const bibs = [...new Set(held.map((x) => x.bib))];
    body.push(`${bibs.length === 1 ? `Bib ${bibs[0]}'s passes go` : `The passes of bibs ${listText(bibs)} go`} back to Passes to check, held: nothing is sent for them until you choose. Until then ${outs} ${keep} ${held.length > 1 ? `the ${fmtInt(held.length)} times this change sent` : `${held[0].text || 'the time'} at ${held[0].splitName || 'that split'}`}.`);
  }
  if (runner?.finished && arr(leaves).some((x) => x.withFinishPlace)) body.push(`Bib ${runner.bib} has finished: the boards keep what Send with finish place sent. Send with finish place again to put the old times back.`);
  return { title: gone.length > 1 ? `Take back ${plural(gone.length, 'time')}?` : 'Undo this change?', body };
}

/** Undo (or Redo) one change; when a scoreboard keeps a cell the undo empties, Split Relay says so and the panel asks. */
async function undoFix(R, fix, { redo = false, btn = null, confirm = false } = {}) {
  if (!R || !Number.isInteger(fix) || S.viewOnly) return;
  R.fixBusy = true;
  scheduleRender();
  try {
    const r = await api('POST', REVIEW_API.undo(R.raceId), confirm ? { fix, confirm: true } : { fix });
    const ch = r?.change;
    const d0 = editorRunner(R);
    const dest = destinations(S.state, R.raceId);
    // (9.23 F18: the runner as the Undo left it, when the answer has it: which cell asks the question now)
    const own = fixToast(ch, dest, { runner: r?.runner ? normRunner(r.runner, configRace(S.state, R.raceId)) : d0 });
    // (only when a board keeps a time that went with the finish place; said once: the toast may say it already)
    const text = `${own}${undoFinishNote(ch, own)}`;
    afterFix(R, r, { toastText: text, focusVacated: false });
  } catch (err) {
    if (err.status === 409 && err.data?.code === 'UNDO_LEAVES') {
      R.fixBusy = false;
      const dest = destinations(S.state, R.raceId);
      const ok = await confirmDialog({ ...undoLeavesDialog(arr(err.data.leaves), dest.outputs, editorRunner(R)), danger: true, back: btn, confirm: 'Undo anyway' });
      if (ok && S.review === R) return undoFix(R, fix, { redo, btn, confirm: true });
      return undefined;
    }
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : err.message, err.status === 409 || err.status === 404 ? 'warn' : 'bad', 9000);
    if (R.runner?.bib) loadRunner(R.runner.bib, { quiet: true });
  } finally {
    R.fixBusy = false;
    scheduleRender();
  }
  return undefined;
}

/**
 * DESIGN 9.24, "Stop sending this runner" (POST /runners/:bib/stop): one click, from the row of a split too fast to be
 * real, its cell's choices or the runner editor. Nothing of the runner from then on goes out or into the merged .lif
 * file; its reads are still counted and shown. `from`: the time of day of the pass it was pressed on (else Split Relay
 * takes the runner's first split in question, or everything after its last pass). Undo, or Send this runner again.
 */
async function stopRunner(R, bib, from = null) {
  if (!R || R.fixBusy || S.viewOnly) return;
  R.fixBusy = true;
  scheduleRender();
  try {
    afterFix(R, await api('POST', REVIEW_API.stop(R.raceId, bib), from != null ? { from } : {}), { focusVacated: false });
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${bib}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
  } finally {
    R.fixBusy = false;
    scheduleRender();
  }
}

/** DESIGN 9.24, "Send this runner again" (POST /runners/:bib/resume): what the stop held goes out if it still fits. */
async function resumeRunner(R, bib) {
  if (!R || R.fixBusy || S.viewOnly) return;
  R.fixBusy = true;
  scheduleRender();
  try {
    afterFix(R, await api('POST', REVIEW_API.resume(R.raceId, bib), {}), { focusVacated: false });
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${bib}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
  } finally {
    R.fixBusy = false;
    scheduleRender();
  }
}

/**
 * DESIGN 9.25 (POST /runners/:bib/place): "Not in this race" (say 'away': every pass of the runner here stays off the
 * boards and out of the merged .lif file; what went out is taken back, and the other runners' places go out again) and
 * "Count them here" / "It's right" (say 'here': the runner is this race's whatever a start list or the day's other races
 * say). One change: the toast has Undo.
 */
async function placeRunner(R, bib, say) {
  if (!R || R.fixBusy || S.viewOnly) return;
  R.fixBusy = true;
  scheduleRender();
  try {
    afterFix(R, await api('POST', REVIEW_API.place(R.raceId, bib), { say }), { focusVacated: false });
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : `Bib ${bib}: ${err.message}`, err.status === 409 ? 'warn' : 'bad');
  } finally {
    R.fixBusy = false;
    scheduleRender();
  }
}

/** "Send bib 586 again": what the scoreboards have otherwise goes out now (it changes nothing the operator didn't decide). */
async function sendRunnerAgain(R, d, btn) {
  if (!R || S.viewOnly) return;
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    const r = await api('POST', REVIEW_API.send(R.raceId, d.bib), {});
    const dest = destinations(S.state, R.raceId);
    const skipped = arr(r?.skipped);
    afterFix(R, r);
    toast(`Bib ${d.bib}: ${Number(r?.sent) ? `${plural(Number(r.sent), 'split')} sent again to ${listText(dest.outputs) || 'the outputs'}` : 'nothing to send: the scoreboards have every split as it is'}.${skipped.length ? ` Not sent: ${skipped.map((x) => `${x.splitName} (${x.why})`).join('; ')}.` : ''}`, skipped.length ? 'warn' : 'ok');
  } catch (err) {
    toast(notSupported(err) ? REVIEW_NOT_SUPPORTED : err.message, 'bad');
  } finally {
    if (b) b.disabled = false;
  }
}

/* ---------- To do: splits that look wrong (9.23 F6) ---------- */

/**
 * The buttons of a Splits that look wrong row besides It's right: its one click (the flag's suggestion; gold unless the
 * runner's missed-mat row has the one click), or (9.23 F21) for a leg far shorter than the runners' that Split Relay
 * can't call a stray for sure, "Not a split" for the pass as a plain choice: the re-check's 549, every mat read and a
 * stray read 1:00 after its 1500m pass ("5:54.7 comes soon after 1500m for 2400m"), offered only "It's right" there,
 * and Not a split was in the runner's own menu.
 * @param {{ suggest?: { to: string, toName: string } | null, kind?: string }} f
 * @param {boolean} [hinted] the runner's row elsewhere has the one click
 * @returns {{ label: string, to: string, primary: boolean }[]}
 */
export function flagChoices(f, hinted = false) {
  const s = f?.suggest;
  if (s) return [{ label: s.to === 'finish' ? 'This is the finish' : s.to === 'none' ? 'Not a split' : `Move to ${s.toName}`, to: s.to, primary: !hinted }];
  // (9.24: nor for a time marked because it follows one that was not a split: a plain choice)
  if (f?.kind === 'short' || f?.kind === 'fast') return [{ label: 'Not a split', to: 'none', primary: false }];
  return [];
}

function flagsSection(R, d, dest) {
  const hinted = hintedBibs(d);
  return queueSection({
    id: 'rv-flags-h', title: 'Splits that look wrong', count: d.flags.length, tone: 'warn',
    note: 'Not held: these went out as they are. Split Relay compares each runner\'s legs with runners of the same pace, and with the leaders. A fix goes out at once; Undo puts it back.',
    more: 'A leg much longer than the legs of the runners nearest in time at the split before it usually means a missed mat (the time is a later split, or the finish); a very short one a stray pass. A leg faster than the leaders ran that stretch, from a runner who was not with them, is too fast to be real: a runner who dropped out and crossed a mat, a chip carried over it. Not a split takes the time back and the other runners\' places go out again by themselves; Stop sending this runner keeps everything of the runner from that time on off the boards. It is advice only: nothing is held or changed until you choose.',
    list: h('ul', { class: 'review-list' }, d.flags.map((f) => {
      const s = f.suggest;
      const busy = !!R.fixBusy;
      return h('li', { class: 'review-item' },
        h('div', { class: 'ri-main' },
          h('div', { class: 'ri-who' }, runnerBibButton(R.raceId, f.bib), whoNode(f, [], f.text)),
          // (9.24: a row that covers two splits too fast to be real says both times)
          h('div', { class: 'ri-split' }, h('strong', {}, f.splitName), h('span', { class: 'mono' }, arr(f.passes).length > 1 ? f.passes.map((p) => p.timeText).join(', ') : f.raceTicks != null ? formatRaceTime(f.raceTicks, 1) : '')),
          // 9.25: a runner of another race: Not in this race takes its splits back, It's right keeps them
          S.viewOnly || f.kind !== 'stranger' ? null : h('div', { class: 'ri-act' },
            h('button', { type: 'button', class: 'btn small row-primary', disabled: busy, 'data-fk': `rvw-${f.key}-go`, onclick: () => placeRunner(R, f.bib, 'away') }, 'Not in this race'),
            h('button', { type: 'button', class: 'btn small', disabled: busy, 'data-fk': `rvw-${f.key}-keep`, onclick: () => placeRunner(R, f.bib, 'here') }, "It's right"),
            // 9.27: or the chip of this bib was carried by an athlete of this race
            h('button', { type: 'button', class: 'btn small', disabled: busy, 'data-fk': `rvw-${f.key}-swap`, title: "An athlete of this race ran with this bib's chip", onclick: (e) => swapDialog(f.bib, e.currentTarget) }, 'Swapped bibs…')),
          S.viewOnly || f.kind === 'stranger' ? null : h('div', { class: 'ri-act' },
            // 9.23 F13: a later split (or the finish) suggested: "Missed <this split>: add it" is the one fix (F14: each
            // count a choice of its own while Split Relay can't tell which)
            ...(f.missed ? missedRowButtons(R, f, f.splitId, `rvw-${f.key}-go`, busy)
              : flagChoices(f, hinted.has(f.bib)).map((x) => h('button', { type: 'button', class: `btn small${x.primary ? ' row-primary' : ''}`, disabled: busy,
                'data-fk': `rvw-${f.key}-${x.to === 'none' && !s ? 'none' : 'go'}`, onclick: () => flagAct(R, f, x.to) }, x.label))),
            // 9.24: a split too fast to be real, a stray pass: the runner may be off the course, or of another race
            f.kind === 'fast' || (f.kind === 'short' && !f.missed) ? h('button', { type: 'button', class: 'btn small', disabled: busy, 'data-fk': `rvw-${f.key}-stop`, onclick: () => stopRunner(R, f.bib, f.passTod) }, 'Stop sending this runner') : null,
            // (a made-up time has no "It's right": Change time or Remove in its cell)
            f.kind === 'made-up' ? null : h('button', { type: 'button', class: 'btn small', disabled: busy, 'data-fk': `rvw-${f.key}-keep`, onclick: () => flagAct(R, f, 'keep') }, "It's right"))),
        f.missed && f.missed.sure === false ? h('p', { class: 'review-line' }, missedUnsureText(f.missed)) : null);
    })),
  });
}

/**
 * What a Review row's "Missed <split>" choice sends (POST /runners/:bib/missed): the split and the pass that moves on.
 * 9.23 F15: the hint's own, not the row's: the row of a runner's first held pass can carry a run that starts at an
 * earlier pass (561's 19:41.6, counted in 4200m and sent as 4200m, while 22:29.3 in 4400m is held).
 * @param {any} row a check row or a look-wrong row (passTod, missed)
 * @param {string} splitId the row's split
 * @param {any} [x] one of the row's choices (missedChoices), else the hint itself
 */
export function missedRowTarget(row, splitId, x = row?.missed) {
  const m = row?.missed ?? {};
  // (9.23 F16: a choice of another set has its own split and pass, and two mats missed apart their runs)
  return { splitId: x?.splitId || m.splitId || splitId, passTod: x?.passTod ?? m.passTod ?? row?.passTod ?? null, count: x?.count ?? 1, names: x?.names ?? [], ok: x?.ok !== false,
    why: x?.why ?? '', ...missedAlso(x) };
}

/**
 * The "Missed <split>" buttons of a Review row (9.23 F13): the one click, or (F14) each count of missed splits as a
 * choice of its own, neither the one click, while Split Relay can't tell which. The first keeps the row's focus key.
 * @param {any} row a check row or a look-wrong row (bib, passTod, finished, finishPlace, missed)
 */
function missedRowButtons(R, row, splitId, fk, busy) {
  const m = row.missed;
  return missedChoices(m).map((x, i) => h('button', { type: 'button', class: `btn small${m.sure !== false ? ' row-primary' : ''}`, 'data-fk': i ? `${fk}-${missedKey(x, splitId)}` : fk,
    disabled: busy || !!R.fixBusy, title: x.ok ? missedSub(x) : x.why,
    onclick: (e) => addMissedFix(R, row, missedRowTarget(row, splitId, x), { btn: e.currentTarget }) }, missedLabel(x)));
}

/**
 * The pass a look-wrong row's choice changes, as the editor's own: with its time and the suggested split, which the
 * question a finisher's change asks first names (9.23 F21: the re-check's 577, a finisher, asked "undefined is not a
 * split." after its row's Not a split).
 * @param {{ passTod: number|null, passSplitId?: string, splitId: string, raceTicks: number|null, suggest?: { to: string, toName: string } | null }} f
 */
export function flagPass(f) {
  const s = f.suggest;
  return { tod: f.passTod, inColumn: true, where: f.passSplitId || f.splitId, timeText: f.raceTicks != null ? formatRaceTime(f.raceTicks, 1) : '',
    targets: s && s.to !== 'none' && s.to !== 'finish' ? [{ splitId: s.to, splitName: s.toName }] : [] };
}

/** A look-wrong row's one click: the same POST /move as the editor's, the pass as the list showed it. */
async function flagAct(R, f, to) {
  const d = { bib: f.bib, finished: f.finished, finishPlace: f.finishPlace };
  // (9.24: a row that covers several splits too fast to be real: Not a split and It's right are for all of them)
  await movePass(R, d, flagPass(f), to, { also: f.kind === 'fast' ? arr(f.passes).map((p) => p.passTod).filter((t) => t !== f.passTod) : [] });
}

/**
 * DESIGN 9.24, Review's "Not sending": the runners the operator stopped sending, from when, and their splits that wait;
 * Send this runner again puts each back.
 */
function offSection(R, d) {
  return queueSection({
    id: 'rv-off-h', title: 'Not sending', count: d.off.length, tone: 'muted',
    note: 'Runners you stopped sending. Their reads are still counted and shown; from the time shown nothing of them goes out or into the .lif file.',
    list: h('ul', { class: 'review-list' }, d.off.map((x) => h('li', { class: 'review-item' },
      h('div', { class: 'ri-main' },
        h('div', { class: 'ri-who' }, runnerBibButton(R.raceId, x.bib), whoNode(x, [], `Not sent ${x.words}${x.held.length ? `: ${listText(x.held.map((y) => `${y.splitName} ${y.timeText}`))} ${x.held.length === 1 ? 'waits' : 'wait'}` : ''}.`)),
        S.viewOnly ? null : h('div', { class: 'ri-act' },
          h('button', { type: 'button', class: 'btn small', disabled: !!R.fixBusy, 'data-fk': `rvo-${x.key}`, onclick: () => resumeRunner(R, x.bib) }, 'Send this runner again')))))),
  });
}

/** A runner's passes in words: "1 Mile 3:34.1 and 2 Mile 4:43.1". */
const passesText = (passes) => listText(arr(passes).map((p) => `${p.splitName} ${p.timeText}`));

/**
 * DESIGN 9.25, Review's "Not in this race": the athletes read here whom a start list enters in another race, or whom
 * the operator set apart, one row each: why, their passes here (counted and shown, not sent, not in the .lif file, no
 * part of the others' places), and what the boards still show of them. Count them here sends them like any runner's.
 */
function awaySection(R, d) {
  return queueSection({
    id: 'rv-away-h', title: 'Not in this race', count: d.away.length, tone: 'muted',
    note: 'Athletes read here who are entered in another race (the start list), or whom you set apart. Their passes are counted and shown; nothing of them goes out or into the .lif file, and they take nobody\'s place.',
    list: h('ul', { class: 'review-list' }, d.away.map((x) => {
      const on = x.passes.filter((p) => p.onBoards);
      const why = x.why ? x.why.charAt(0).toUpperCase() + x.why.slice(1) : 'Not in this race';
      return h('li', { class: 'review-item' },
        h('div', { class: 'ri-main' },
          h('div', { class: 'ri-who' }, runnerBibButton(R.raceId, x.bib), whoNode(x, [], `${why}${x.passes.length ? `. Here: ${passesText(x.passes)}` : ''}.`)),
          S.viewOnly ? null : h('div', { class: 'ri-act' },
            h('button', { type: 'button', class: 'btn small', disabled: !!R.fixBusy, 'data-fk': `rva-${x.key}`, onclick: () => placeRunner(R, x.bib, 'here') }, 'Count them here'),
            // 9.27: or the chip of this bib was carried by an athlete of this race
            S.viewOnly ? null : h('button', { type: 'button', class: 'btn small', disabled: !!R.fixBusy, 'data-fk': `rva-${x.key}-swap`, title: "An athlete of this race ran with this bib's chip", onclick: (e) => swapDialog(x.bib, e.currentTarget) }, 'Swapped bibs…'))),
        on.length ? h('p', { class: 'review-line tone-text-warn' }, `The boards still show ${listText(on.map((p) => `${p.splitName} ${p.onBoards}`))} (sent before): a packet can't empty a cell.`) : null);
    })),
  });
}

/**
 * DESIGN 9.25, Review's "Not on the start list": runners with a pass here who are on no start list (a late entry, a
 * spare chip). They are sent like any runner: a note, nothing to do. It's right takes the note away, Not in this race
 * takes the runner off the boards.
 */
function unlistedSection(R, d) {
  return queueSection({
    id: 'rv-unl-h', title: 'Not on the start list', count: d.unlisted.length, tone: 'muted',
    note: 'On no start list: a late entry, a spare chip. Sent like any runner.',
    list: h('ul', { class: 'review-list' }, d.unlisted.map((x) => h('li', { class: 'review-item' },
      h('div', { class: 'ri-main' },
        h('div', { class: 'ri-who' }, runnerBibButton(R.raceId, x.bib), whoNode(x, [], `${passesText(x.passes)}.`)),
        S.viewOnly ? null : h('div', { class: 'ri-act' },
          h('button', { type: 'button', class: 'btn small', disabled: !!R.fixBusy, 'data-fk': `rvu-${x.key}-away`, onclick: () => placeRunner(R, x.bib, 'away') }, 'Not in this race'),
          h('button', { type: 'button', class: 'btn small', disabled: !!R.fixBusy, 'data-fk': `rvu-${x.key}-keep`, onclick: () => placeRunner(R, x.bib, 'here') }, "It's right")))))),
  });
}

/* ---------- All runners: the race grid (9.23 F8) ---------- */

function queueGridLoad(R, min = 0) {
  if (!R || R.view !== 'all') return;
  if (R.gridTimer && !min) return;
  clearTimeout(R.gridTimer);
  const wait = Math.max(min || 300, 2000 - (Date.now() - (R.grid?.lastFetch || 0)));
  R.gridTimer = setTimeout(() => {
    R.gridTimer = 0;
    if (S.review === R) loadGrid(R);
  }, min ? Math.min(wait, min) : wait);
}

async function loadGrid(R) {
  const G = (R.grid ??= { data: null, rev: '', loading: false, again: false, error: '', at: 0, lastFetch: 0, order: null, showAll: false });
  if (G.loading) {
    G.again = true;
    return;
  }
  G.loading = true;
  G.lastFetch = Date.now();
  try {
    const raw = await api('GET', `${REVIEW_API.grid(R.raceId)}${G.rev ? `?since=${enc(G.rev)}` : ''}`);
    if (S.review !== R) return;
    if (!raw?.unchanged) {
      G.data = raw;
      G.rev = str(raw?.rev);
    }
    G.error = '';
    G.unsupported = false;
  } catch (err) {
    if (S.review !== R) return;
    G.unsupported = notSupported(err);
    G.error = err.message;
  } finally {
    G.loading = false;
    G.at = Date.now();
    if (G.again) {
      G.again = false;
      queueGridLoad(R);
    }
    scheduleRender();
  }
}

/** The grid's filters, remembered on this computer (a convenience: the page works without). */
function gridPrefs(R) {
  if (!R.gridF) R.gridF = { chip: 'all', order: 'problems', q: '', onlyProblems: null, ...loadPref('gridFilter', {}), q: '' };
  return R.gridF;
}

function setGridF(R, patch) {
  Object.assign(gridPrefs(R), patch);
  savePref('gridFilter', { ...R.gridF, q: '' });
  if (R.grid) R.grid.order = null;
  R.force = true;
  scheduleRender();
}

function gridSection(R, cfg, dest) {
  const G = R.grid;
  if (!G || (!G.data && !G.error)) return h('div', { class: 'card review-empty' }, 'Loading the race grid…');
  if (G.error && !G.data) {
    if (G.unsupported) return h('p', { class: 'msg tone-info' }, 'This Split Relay has no race grid yet. Restart it with this version (start.bat). To do still works.');
    return h('p', { class: 'msg tone-bad', role: 'alert' }, `Couldn't load the race grid: ${G.error}. `, h('button', { type: 'button', class: 'btn small local', onclick: () => loadGrid(R) }, 'Try again'));
  }
  const g = G.data;
  if (!g.gunSet) return h('p', { class: 'msg tone-info' }, `Set the gun time of ${g.raceName} first: every split is a time from the gun.`);
  if (!arr(g.rows).length) return h('p', { class: 'msg tone-info' }, `No runner of ${g.raceName} has a read yet.`);
  const f = gridPrefs(R);
  const only = f.onlyProblems ?? arr(g.rows).length > 100;
  let rows = gridView(g.rows, { ...f, onlyProblems: only });
  // hold still: while the pointer or the keyboard is in the grid, rows update in place but keep their order
  const working = EL.reviewGrid.matches(':hover') || EL.reviewGrid.contains(document.activeElement);
  const sig = rows.map((r) => r.bib).join(',');
  if (working && G.order && G.order.sig !== sig) {
    const pos = new Map(G.order.bibs.map((b, i) => [b, i]));
    rows = rows.slice().sort((a, b) => (pos.get(a.bib) ?? 1e9) - (pos.get(b.bib) ?? 1e9));
    G.reorder = true;
    clearTimeout(G.reorderTimer);
    G.reorderTimer = setTimeout(() => {
      if (!(EL.reviewGrid.matches(':hover') || EL.reviewGrid.contains(document.activeElement))) {
        G.order = null;
        G.reorder = false;
        scheduleRender();
      }
    }, 5000);
  } else {
    G.order = { sig, bibs: rows.map((r) => r.bib) };
    G.reorder = false;
  }
  const c = g.counts || {};
  const toFix = arr(g.rows).filter((r) => r.tier <= 5).map((r) => r.bib);
  const summary = toFix.length
    ? `${plural(toFix.length, 'runner')} to fix: ${listText(toFix, 8)}.${c.stopped ? ` ${fmtInt(c.stopped)} ${c.stopped === 1 ? 'has' : 'have'} no read lately.` : ''}`
    : `Nothing to fix in ${g.raceName}.${c.stopped ? ` ${fmtInt(c.stopped)} ${c.stopped === 1 ? 'has' : 'have'} no read lately.` : ''}`;
  // (the blocked ones too: the Fill dialog says why each is left out)
  const fillable = arr(g.rows).flatMap((r) => arr(r.cells).map((cell, k) => (cell.kind === 'missing' || cell.kind === 'blocked' ? gridItem(g, r, k) : null)).filter(Boolean));
  const fillN = fillable.filter((x) => !x.blocked && !(x.finished && x.finishPlace == null)).length;
  const dropped = arr(g.rows).filter((r) => r.stopped).map((r) => r.bib);
  const chip = (id, label, n) => h('button', { type: 'button', class: 'fchip local', 'aria-pressed': String(f.chip === id), onclick: () => setGridF(R, { chip: id }) }, label, h('span', { class: 'chip-count' }, ` ${fmtInt(n)}`));
  const box = h('input', { type: 'search', class: 'grid-find', placeholder: 'Bib or name', value: f.q, 'aria-label': 'Show the runners with this bib or name', 'data-fk': 'grid-q',
    oninput: (e) => { f.q = e.target.value; R.force = true; scheduleRender(); } });
  const n = arr(g.splits).length;
  const width = EL.reviewGrid.clientWidth || (typeof window !== 'undefined' ? window.innerWidth - 32 : 1280);
  const table = gridFits(width, n);
  const limit = G.showAll ? rows.length : Math.min(rows.length, 100);
  const shown = rows.slice(0, limit);
  return [
    h('p', { class: 'grid-summary', role: 'status' }, summary),
    h('div', { class: 'grid-tools' },
      h('div', { class: 'chips-bar', role: 'group', 'aria-label': 'Show' },
        chip('all', 'All', c.runners || 0), chip('fix', 'To fix', c.toFix || 0), chip('changed', 'Changed by you', c.pinned || 0), chip('stopped', 'No read lately', c.stopped || 0)),
      h('label', { class: 'grid-order' }, 'Order ', selectInput('grid-order', f.order, [{ value: 'problems', label: 'Problems first' }, { value: 'bib', label: 'Bib' }, { value: 'far', label: 'Furthest along' }], (v) => setGridF(R, { order: v }))),
      box,
      f.chip === 'all' ? h('label', { class: 'check-label' }, h('input', { type: 'checkbox', checked: only, onchange: (e) => setGridF(R, { onlyProblems: e.target.checked }) }), 'Only runners with problems') : null,
      G.reorder ? h('button', { type: 'button', class: 'btn small local', onclick: () => { G.order = null; G.reorder = false; scheduleRender(); } }, 'Order changed: re-sort') : null,
      !S.viewOnly && fillN ? h('button', { type: 'button', class: 'btn small primary', disabled: !!R.fixBusy, onclick: (e) => fillAllDialog(R, fillable, { btn: e.currentTarget, dropped }) }, `Fill in ${fmtInt(fillN)} missing…`) : null),
    !shown.length ? h('p', { class: 'msg tone-info' }, f.q ? `No runner matches "${f.q}".` : 'No runner to show with these filters.')
      : table ? gridTable(R, g, shown) : gridCards(R, g, shown),
    rows.length > limit ? h('button', { type: 'button', class: 'btn small local', onclick: () => { G.showAll = true; scheduleRender(); } }, `Show all ${fmtInt(rows.length)}`) : null,
  ];
}

/** A missing cell of the grid as a missing-split item (fillAllPlan, the inline box). */
function gridItem(g, r, k) {
  const sp = arr(g.splits)[k];
  const cell = r.cells[k];
  const prev = [...r.cells.slice(0, k)].map((c, i) => [c, i]).reverse().find(([c]) => c.t != null);
  const next = r.cells.slice(k + 1).map((c, i) => [c, k + 1 + i]).find(([c]) => c.t != null);
  return { key: `${r.bib}|${sp.id}`, bib: r.bib, name: r.name, team: r.team, splitId: sp.id, splitName: sp.name, estimate: cell.est ?? null,
    estimateText: cell.estText || '', basis: '', finished: !!r.finished, finishPlace: r.finishPlace ?? null, blocked: cell.kind === 'blocked' ? str(cell.why) : '',
    prev: prev ? { name: g.splits[prev[1]].name, ticks: prev[0].t } : { name: 'the gun', ticks: 0 },
    next: next ? { name: g.splits[next[1]].name, ticks: next[0].t } : r.finished ? { name: 'the finish', ticks: null } : null };
}

/** A grid cell as cellModel takes it (a normRunner column). */
function gridCol(g, r, k) {
  const sp = arr(g.splits)[k];
  const x = r.cells[k] || {};
  return { splitId: sp.id, splitName: sp.name, index: k, raceTicks: x.t ?? null, place: x.place ?? null, kind: x.kind, how: x.how || '',
    status: x.held === 'check' ? 'check-column' : x.held === 'paused' ? 'split-paused' : x.held === 'stopped' ? 'not-sending' : x.held === 'away' ? 'not-in-race' : x.held === 'collect' ? 'counted' : '', flag: x.flag ? { ...x.flag } : null, stale: x.stale || '',
    // (9.26: a column that is counted but not sent)
    collectOnly: sp.collectOnly === true,
    leftover: x.leftover ? { timeText: str(x.leftover).replace(/^[^:]*: /, ''), outputs: [str(x.leftover).split(':')[0]] } : null,
    estimate: x.est ?? null, why: x.why || '', finishedNotSent: !!x.notLive, basis: '' };
}

function gridTable(R, g, rows) {
  const n = arr(g.splits).length;
  const head = h('tr', {}, h('th', { scope: 'col', class: 'num' }, 'Bib'), h('th', { scope: 'col' }, 'Runner'),
    // (9.26: a column that is counted, not sent, says so under its name)
    arr(g.splits).map((sp) => h('th', { scope: 'col', class: 'g-split' + (sp.collectOnly ? ' not-sent' : ''), title: sp.collectOnly ? `${sp.name} is counted, not sent: nothing of it goes to a scoreboard or the merged .lif file.` : null }, sp.name,
      sp.collectOnly ? h('span', { class: 'g-quiet' }, 'not sent') : null, sp.missing ? h('span', { class: 'g-miss' },
      !S.viewOnly && sp.fillable ? h('button', { type: 'button', class: 'linklike local', onclick: (e) => fillAllDialog(R, arr(g.rows).map((r) => (['missing', 'blocked'].includes(r.cells[sp.index]?.kind) ? gridItem(g, r, sp.index) : null)).filter(Boolean),
        { btn: e.currentTarget, title: `Fill in ${fmtInt(sp.fillable)} missing at ${sp.name}?`,
          // runners with no read after an earlier split may have dropped out: nothing is made up for them
          dropped: arr(g.rows).filter((r) => r.stopped && r.stopped.col < sp.index).map((r) => r.bib) }) }, `${fmtInt(sp.missing)} missing · Fill…`) : `${fmtInt(sp.missing)} missing`) : null)),
    h('th', { scope: 'col' }, 'Finish'), h('th', { scope: 'col' }, 'Problems'));
  return h('div', { class: 'grid-wrap' }, h('table', { class: 'race-grid', role: 'grid', 'aria-label': `${g.raceName}: runners by splits (arrow keys move, Enter acts, N: next problem)`, 'aria-rowcount': String(rows.length + 1) },
    h('thead', {}, head),
    h('tbody', {}, rows.map((r, ri) => gridRow(R, g, r, ri, n)))));
}

function gridRow(R, g, r, ri, n) {
  const d = { bib: r.bib, finished: r.finished, finishPlace: r.finishPlace, passes: [], changes: [], columns: [] };
  const cur = R.gridCur || { r: 0, c: 0 };
  const cells = arr(g.splits).map((sp, k) => {
    const col = gridCol(g, r, k);
    const m = cellModel(col, d);
    const fk = `gc-${r.bib}-${k}`;
    const edit = R.gridEdit && R.gridEdit.bib === r.bib && R.gridEdit.k === k;
    if (edit) return h('td', { class: 'g-cell boxed' }, gridBox(R, g, r, k));
    return h('td', { class: `g-cell tone-${m.tone || 'plain'} kind-${m.kind}${m.flag ? ` flag-${m.flag}` : ''}`, role: 'gridcell' },
      h('button', { type: 'button', class: 'g-btn local', 'data-fk': fk, 'data-r': String(ri), 'data-c': String(k + 2), tabindex: cur.r === ri && cur.c === k + 2 ? '0' : '-1',
        title: [m.info, m.sub && col.raceTicks != null ? `place ${m.sub}` : ''].filter(Boolean).join(' '), 'aria-label': m.aria,
        onclick: () => gridCellAct(R, g, r, k) },
      h('span', { class: 'mono g-time' }, m.main), h('span', { class: 'g-sub' }, col.raceTicks != null ? (m.chip?.text || '') : m.sub),
      m.flag === 'flag' ? h('span', { class: 'i i-alert g-flag', 'aria-hidden': 'true' }) : null,
      m.warn ? h('span', { class: 'g-warn' }, m.warn) : null));
  });
  const tone = r.tier <= 1 ? 'warn' : r.tier <= 5 ? 'info' : '';
  return h('tr', { class: `g-row tier-${r.tier}${tone ? ` tone-row-${tone}` : ''}`, 'aria-rowindex': String(ri + 2) },
    h('td', { class: 'num', role: 'rowheader' }, h('button', { type: 'button', class: 'bib-btn g-btn local', 'data-fk': `gb-${r.bib}`, 'data-r': String(ri), 'data-c': '0', tabindex: cur.r === ri && cur.c === 0 ? '0' : '-1',
      onclick: (e) => openRunner(R.raceId, r.bib, e.currentTarget) }, r.bib)),
    h('td', { class: 'g-name' }, h('button', { type: 'button', class: 'linklike g-btn local', 'data-fk': `gn-${r.bib}`, 'data-r': String(ri), 'data-c': '1', tabindex: cur.r === ri && cur.c === 1 ? '0' : '-1',
      onclick: (e) => openRunner(R.raceId, r.bib, e.currentTarget) }, r.name || '—'), r.team ? h('span', { class: 'g-team' }, r.team) : null),
    cells,
    h('td', { class: 'g-fin' }, r.finished ? `${r.finishText}${r.finishPlace != null ? ` · ${ordinal(r.finishPlace)}` : ''}` : r.stopped ? h('span', { class: 'muted' }, 'No read lately') : '—'),
    // (9.24: the operator stopped sending this runner: said on its row)
    h('td', { class: 'g-probs' }, r.off ? h('span', { class: 'badge tone-muted', title: 'You stopped sending this runner: open it to send it again' }, str(r.off)) : null,
      // (9.25: not in this race; on no start list)
      r.away ? h('span', { class: 'badge tone-muted', title: 'Read and counted here, not sent: open the runner to count them here' }, str(r.away))
        : r.unlisted ? h('span', { class: 'badge tone-muted', title: 'On no start list: a late entry, a spare chip. Sent like any runner.' }, 'Not on the start list') : null, arr(r.problems).slice(0, 2).map((p) => h('span', { class: `g-prob kind-${p.kind}` }, p.text)), r.problems?.length > 2 ? h('span', { class: 'muted' }, ` +${r.problems.length - 2}`) : null));
}

/** The narrow grid (9.23 F9): a card per runner: bib, name and problem chips; a square per split; the problems in words. */
function gridCards(R, g, rows) {
  return h('ul', { class: 'grid-cards' }, rows.map((r) => {
    const d = { bib: r.bib, finished: r.finished, finishPlace: r.finishPlace, passes: [], changes: [], columns: [] };
    const squares = arr(g.splits).map((sp, k) => {
      const col = gridCol(g, r, k);
      const m = cellModel(col, d);
      const state = m.tone === 'held' || m.flag === 'flag' ? 'warn' : col.collectOnly ? 'quiet' : m.kind === 'missing' ? 'miss' : m.kind === 'made-up' || m.kind === 'typed' ? 'info' : col.raceTicks != null ? 'ok' : 'idle';
      return h('span', { class: `sq sq-${state}`, role: 'img', 'aria-label': m.aria, title: m.aria });
    });
    squares.push(h('span', { class: `sq sq-${r.finished ? 'fin' : 'idle'}`, role: 'img', 'aria-label': r.finished ? `Finish ${r.finishText}` : 'Finish not known', title: r.finished ? `Finish ${r.finishText}` : 'Finish not known' }));
    return h('li', { class: `grid-card tier-${r.tier}` },
      h('button', { type: 'button', class: 'gc-open local', 'aria-label': `Bib ${r.bib}${r.name ? `, ${r.name}` : ''}: open the runner`, onclick: (e) => openRunner(R.raceId, r.bib, e.currentTarget) },
        h('span', { class: 'gc-line' }, h('b', { class: 'mono' }, r.bib), h('span', { class: 'gc-name' }, r.name || '—'),
          arr(r.problems).length ? h('span', { class: `badge tone-${r.tier <= 1 ? 'warn' : 'info'}` }, `${fmtInt(r.problems.length)} to look at`) : null,
          r.off ? h('span', { class: 'badge tone-muted' }, 'Not sending') : null,
          r.away ? h('span', { class: 'badge tone-muted' }, 'Not in this race') : null),
        h('span', { class: 'gc-squares' }, squares),
        arr(r.problems).length ? h('span', { class: 'gc-probs' }, r.problems.slice(0, 3).map((p) => p.text).join(' · ')) : null));
  }));
}

/** A click (or Enter) on a grid cell: a missing one fills in place; any other opens the editor on that cell, choices open. */
function gridCellAct(R, g, r, k) {
  const cell = r.cells[k];
  if (cell?.kind === 'missing' && !S.viewOnly) {
    R.gridEdit = { bib: r.bib, k, text: cell.estText || '', select: true };
    R.force = true;
    scheduleRender();
    return;
  }
  R.openMenuAt = cell?.t != null ? k : null;
  openRunner(R.raceId, r.bib, document.activeElement);
}

function gridBox(R, g, r, k) {
  const sp = arr(g.splits)[k];
  const item = gridItem(g, r, k);
  const gun = viewOf(S.state, R.raceId)?.gunTicks;
  const input = h('input', { type: 'text', class: 'mono rc-input', value: R.gridEdit.text, 'data-fk': `gbox-${r.bib}-${k}`, 'aria-label': `${sp.name} time for bib ${r.bib}`, autocomplete: 'off', spellcheck: 'false' });
  const line = h('span', { class: 'rc-line' });
  const update = () => {
    const e = parseTimeEntry(input.value, gun);
    line.textContent = e.problem || e.label;
    return e;
  };
  const done = () => {
    R.gridEdit = null;
    R.force = true;
    focusKey(`gc-${r.bib}-${k}`);
  };
  const send = async () => {
    const e = update();
    if (e.problem) return toast(e.problem, 'warn');
    const same = item.estimate != null && str(input.value).trim() === item.estimateText;
    R.gridEdit = null;
    const d = { bib: r.bib, name: r.name, team: r.team, finished: r.finished, finishPlace: r.finishPlace, columns: [], passes: [], changes: [] };
    const col = { ...gridCol(g, r, k), basis: '', kind: 'missing', index: k, prev: item.prev, next: item.next };
    await fillCell(R, d, col, same ? null : e, null);
    focusKey(`gc-${r.bib}-${k}`);
    return undefined;
  };
  input.addEventListener('input', () => {
    R.gridEdit.text = input.value;
    update();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done();
    }
  });
  queueMicrotask(update);
  if (R.gridEdit.select) {
    R.gridEdit.select = false;
    const end = R.gridEdit.caretEnd;
    queueMicrotask(() => {
      input.focus();
      if (end) input.setSelectionRange?.(input.value.length, input.value.length);
      else input.select();
    });
  }
  return [input, line, h('button', { type: 'button', class: 'btn small primary local', onclick: send }, 'Send')];
}

/** The grid's keys (role grid): arrows, Home/End, PgUp/PgDn, N / Shift+N to the next problem, digits type a time. */
function gridKeydown(e) {
  const R = S.review;
  const btn = e.target.closest?.('.g-btn');
  if (!R || !btn || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const r = Number(btn.dataset.r);
  const c = Number(btn.dataset.c);
  const all = [...EL.reviewGrid.querySelectorAll('.g-btn[data-r]')];
  const rows = Math.max(...all.map((x) => Number(x.dataset.r))) + 1;
  const cols = Math.max(...all.map((x) => Number(x.dataset.c))) + 1;
  const at = (rr, cc) => all.find((x) => Number(x.dataset.r) === rr && Number(x.dataset.c) === cc);
  let to = null;
  const k = e.key;
  if (k === 'ArrowRight') to = [r, Math.min(cols - 1, c + 1)];
  else if (k === 'ArrowLeft') to = [r, Math.max(0, c - 1)];
  else if (k === 'ArrowDown') to = [Math.min(rows - 1, r + 1), c];
  else if (k === 'ArrowUp') to = [Math.max(0, r - 1), c];
  else if (k === 'Home') to = [r, 0];
  else if (k === 'End') to = [r, cols - 1];
  else if (k === 'PageDown') to = [Math.min(rows - 1, r + 10), c];
  else if (k === 'PageUp') to = [Math.max(0, r - 10), c];
  else if (k === 'n' || k === 'N') {
    const probs = all.filter((x) => x.closest('td')?.matches('.tone-held, .tone-missing, .tone-flag, .tone-blocked'));
    const idx = probs.indexOf(btn);
    const next = e.shiftKey ? probs[(idx - 1 + probs.length) % probs.length] : probs[(idx + 1) % probs.length];
    if (next) to = [Number(next.dataset.r), Number(next.dataset.c)];
  } else if (/^[0-9]$/.test(k) && btn.closest('td')?.classList.contains('kind-missing') && !S.viewOnly) {
    e.preventDefault();
    const bib = btn.dataset.fk?.replace(/^gc-/, '').replace(/-\d+$/, '');
    R.gridEdit = { bib, k: c - 2, text: k, select: true, caretEnd: true };
    R.force = true;
    scheduleRender();
    return;
  } else return;
  e.preventDefault();
  const el = to && at(to[0], to[1]);
  if (!el) return;
  R.gridCur = { r: to[0], c: to[1] };
  for (const x of all) x.tabIndex = -1;
  el.tabIndex = 0;
  el.focus();
}

/* ============================================================================================================ */
/* Races tab                                                                                                    */

const NEW_RACE_DEFAULTS = { round: '1', heat: '1', active: true };

/** The gun card of a race not saved yet: the form's own Gun time box is optional, this card takes over once saved. */
export const NEW_RACE_GUN_HELP = "Type it in the form's Gun time box (optional), or leave that empty: once the race is saved, type it here and press Set.";

/**
 * A new race reads from the first RR12 port (DESIGN 9.15 L3). One port feeds one Active race, so a new race on a port
 * that already feeds one starts not Active: "Switch to" changes over when it runs.
 * @param {any} st
 * @param {any} [extra] fields to set
 */
function newRaceDefaults(st, extra = {}) {
  // the first RR12 port no Active race reads from (a second exporter's, for a race that overlaps), else the first
  const races = arr(st?.config?.races);
  const free = inputPorts(st).find((p) => !races.some((r) => r && r.active !== false && portNum(r.inputPort) === p));
  const base = { ...NEW_RACE_DEFAULTS, inputPort: free ?? firstPort(st), ...extra };
  if (portConflict(base, races)) base.active = false;
  return base;
}

function raceDraft(id, st = S.state) {
  if (id === NEW) {
    let d = S.drafts.get('race:' + NEW);
    if (!d) {
      d = draftFor('race:' + NEW, raceToDraft, newRaceDefaults(st), true);
      // Active is Split Relay's guess until the operator ticks or unticks it: see the port field
      d.autoActive = true;
    }
    return d;
  }
  return draftFor('race:' + id, raceToDraft, configRace(st, id));
}

function renderRacesTab() {
  const st = S.state;
  const races = arr(st.config.races);
  let sel = S.route.id;
  if (sel === 'new') {
    sel = NEW;
    raceDraft(NEW, st);
  } else if (!races.some((r) => r.id === sel)) {
    // the race on screen is gone (deleted in another window): said once, and the page moves to the list's first race
    // under that race's own address, so a click meant for the gone race (Delete…) never lands on another one unseen
    if (sel && S.editorRace === sel) {
      toast(`${S.editorRaceName || 'The race you were looking at'} is no longer in the settings: it was deleted.`, 'info');
      S.editorRace = null;
      go('#races');
      return;
    }
    sel = races[0]?.id || (S.drafts.has('race:' + NEW) ? NEW : '');
  }
  // O24: no race and none being added: the empty page alone (its actions once, the gold one first at 390 px)
  const listHidden = !races.length && !S.drafts.has('race:' + NEW);
  if (EL.raceList.hidden !== listHidden) {
    EL.raceList.hidden = listHidden;
    EL.raceList.parentElement?.classList.toggle('no-list', listHidden);
  }
  guard(EL.raceList, () => {
    const sig = JSON.stringify([sel, inputPorts(st).length, races.map((r) => [r.id, r.name, r.eventNumber, r.round, r.heat, r.active, r.inputPort, splitsWord(r.splits), isDirty(S.drafts.get('race:' + r.id))]),
      arr(st.races).map((v) => [v.id, v.gunText, v.gunTicks, v.startList?.entered, v.startList?.warn]), S.drafts.get('race:' + NEW)?.draft.name ?? null, str(st.config.meet?.name), S.viewOnly, anyRunning(st),
      // (9.25: the start lists, the setting, what the last load said)
      st.startLists ?? null, st.config.entries?.otherRace ?? '', S.startListLoad?.at ?? 0, localDay(nowMs()),
      // (9.27: the swapped bibs, what the last change said)
      st.swaps ?? null, S.swapLast?.at ?? 0]);
    paintSig(EL.raceList, sig, () => buildRaceList(st, races, sel));
  });
  guard(EL.raceEditor, () => {
    if (!sel) {
      // the empty page offers the meet in one go first (DESIGN 9.22 M10), and says which data folder this copy uses
      if (!S.viewOnly) loadMeetFiles();
      const sig = JSON.stringify([S.meetFiles.at, S.meetFiles.list.map((f) => [f.fileName, f.name, f.savedAt, f.races, f.beforeLoad]), st.dataDir,
        st.configRecovery?.source, S.viewOnly, trackScoreAt(st)]);
      if (S.editorRace !== '' || EL.raceEditor._emptySig !== sig) {
        S.editorRace = '';
        EL.raceEditor._emptySig = sig;
        paint(EL.raceEditor, () => racesEmptyCard(st));
      }
      return;
    }
    EL.raceEditor._emptySig = undefined;
    if (S.editorRace !== sel) {
      // a clean draft of the race we leave is dropped, so coming back starts from the server copy
      const prev = S.drafts.get('race:' + S.editorRace);
      if (prev && !prev.isNew && !isDirty(prev)) S.drafts.delete(prev.key);
      S.adder = null;
      buildRaceEditor(sel);
      S.editorRace = sel;
    }
    updateRaceEditor(sel);
    S.editorRaceName = configRace(st, sel)?.name || '';
  });
}

function buildRaceList(st, races, sel) {
  const multi = inputPorts(st).length > 1;
  const items = races.map((r) => {
    const rv = viewOf(st, r.id);
    const d = S.drafts.get('race:' + r.id);
    const meta = [eventLabel(r).replace(/^Event /, 'Ev ') || 'No event', splitsWord(r.splits), multi && portNum(r.inputPort) != null ? `port ${r.inputPort}` : '',
      rv && Number.isFinite(rv.gunTicks) ? `gun ${rv.gunText || formatTod(rv.gunTicks)}` : 'no gun',
      // (9.25: how many are entered, when the race has a start list)
      Number(rv?.startList?.entered) > 0 ? `${fmtInt(rv.startList.entered)} entered` : ''].filter(Boolean).join(' · ');
    return h('li', {}, h('a', { href: '#races/' + enc(r.id), class: 'race-item' + (r.id === sel ? ' current' : ''), 'aria-current': r.id === sel ? 'page' : null, 'data-fk': 'ri-' + r.id },
      h('span', { class: `dot tone-${r.active === false ? 'muted' : 'ok'}`, title: r.active === false ? 'Not Active' : 'Active', 'aria-hidden': 'true' }),
      h('span', { class: 'race-item-name' }, r.name || '(no name)', h('span', { class: 'sr-only' }, r.active === false ? ' (not Active)' : ' (Active)')),
      h('span', { class: 'race-item-meta' }, meta),
      isDirty(d) ? h('span', { class: 'badges' }, badge('Unsaved', 'warn')) : null));
  });
  if (S.drafts.has('race:' + NEW)) {
    const d = S.drafts.get('race:' + NEW);
    // (its editor's title says "Not saved yet"; the list only says it is new)
    items.push(h('li', {}, h('a', { href: '#races/new', class: 'race-item' + (sel === NEW ? ' current' : ''), 'aria-current': sel === NEW ? 'page' : null },
      h('span', { class: 'dot tone-muted', 'aria-hidden': 'true' }),
      h('span', { class: 'race-item-name' }, str(d.draft.name).trim() || 'New race'),
      h('span', { class: 'race-item-meta' }, 'new, not saved'))));
  }
  const [btn, body] = moreParts('race-list', RACE_LIST_HELP, 'Where a read goes');
  const meetName = str(st.config.meet?.name).trim();
  // O7: while a race runs, loading a meet is on Settings → Meet setup only; Save is always one click
  const running = anyRunning(st);
  const ghost = (fk, label, onclick) => h('button', { type: 'button', class: 'btn small ghost', 'data-fk': fk, onclick }, label);
  return [
    h('div', { class: 'list-head' }, h('h2', {}, 'Races'),
      h('a', { href: '#races/new', class: 'btn small', 'data-fk': 'race-new' }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'New race')),
    meetName || (!S.viewOnly && races.length) ? h('div', { class: 'meet-bar' },
      meetName ? h('p', { class: 'help meet-name' }, `Meet: ${meetName}`) : null,
      S.viewOnly || !races.length ? null : h('div', { class: 'meet-acts' },
        running ? null : ghost('list-meet-load', 'Load meet file…', chooseMeetFile),
        running ? null : ghost('list-meet-ts', 'Set up from TrackScore', (e) => startMeetLoad({ trackscore: true }, e.currentTarget)),
        ghost('list-meet-save', 'Save meet setup', (e) => saveMeetSetup(e.currentTarget)),
        running ? h('a', { class: 'btn small ghost', href: '#settings/meet', 'data-fk': 'list-meet-more' }, 'Meet setup…') : null)) : null,
    items.length ? h('ul', { class: 'race-items' }, items) : h('p', { class: 'help' }, 'No races yet.'),
    races.length > 1 ? h('div', { class: 'help' }, 'One Active race per RR12 port.', btn, body) : null,
    // 9.25: who is entered in which race (the meet's entry files)
    races.length ? startListsBlock(st) : null,
    // 9.27: the pairs of swapped bibs (two athletes with each other's chips)
    races.length ? swapsBlock(st) : null,
  ];
}

/** "This copy of Split Relay keeps its data in C:\…\data." and, on the empty page, why it may be empty (DESIGN 9.22 M10). */
function dataDirText(st, empty = false) {
  const dir = str(st?.dataDir);
  if (!dir) return '';
  const head = `This copy of Split Relay keeps its data in ${dir}.`;
  if (!empty) return head;
  return st?.configRecovery?.source === 'new'
    ? `${head} It started with a new, empty data folder: if your races were set up before, you may have started another copy of Split Relay. Close this one and start the one you used, or load that copy's data\\config.json here.`
    : `${head} Expected races here? You may have started another copy of Split Relay.`;
}

/** The empty Races page: the meet in one go (a meet file, a saved meet, TrackScore), then a race by hand. */
function racesEmptyCard(st) {
  const ts = trackScoreAt(st);
  const saved = S.viewOnly ? [] : savedMeets(S.meetFiles.list).slice(0, 4);
  const now = nowMs();
  return h('div', { class: 'card empty-state meet-empty' },
    h('h2', {}, 'No races yet'),
    h('p', {}, 'Load the meet\'s setup in one go, or add the races one by one.'),
    S.viewOnly ? null : [
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', 'data-fk': 'empty-meet-load', onclick: chooseMeetFile }, 'Load meet file…'),
        h('button', { type: 'button', class: 'btn', 'data-fk': 'empty-meet-ts', onclick: (e) => startMeetLoad({ trackscore: true }, e.currentTarget) }, 'Set up from TrackScore')),
      h('p', { class: 'help' }, `From TrackScore at ${ts.host}:${ts.port} (Settings → Meet setup to change).`),
      saved.length ? h('div', { class: 'names-suggest meet-saved' },
        h('p', { class: 'sub-label' }, 'Saved meets'),
        saved.map((f, i) => h('div', { class: 'row meet-saved-row' }, savedMeetButton(f, { fk: 'empty-saved-' + i }), h('span', { class: 'help inline' }, savedMeetText(f, now))))) : null,
    ],
    h('div', { class: 'row' }, h('a', { class: 'btn ghost', href: '#races/new', 'data-fk': 'empty-race-new' }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Add a race by hand')),
    S.viewOnly ? null : h('p', { class: 'help' }, 'Once the races are set up, Save meet setup (Races page or Settings → Meet setup) keeps them for next time.'),
    S.viewOnly ? null : h('p', { class: 'help' }, 'Tip: drop a meet file (.json) anywhere on this page.'),
    h('p', { class: 'help data-dir' }, dataDirText(st, true)));
}

function buildRaceEditor(id) {
  const isNew = id === NEW;
  const R = {
    id,
    head: h('div', { class: 'editor-head' }),
    warn: h('div', { class: 'editor-warn' }),
    form: h('div', { class: 'card race-form-card' }),
    gun: isNew ? null : buildGunCard(id),
    offer: h('div'),
    data: isNew ? null : h('section', { class: 'card', 'aria-labelledby': 'race-data-h' }),
    cross: isNew ? null : h('section', { class: 'card crossings-card', 'aria-label': 'Crossings' }),
  };
  S.re = R;
  // replaceChildren turns a null into the text "null": a new race has no crossings card
  EL.raceEditor.replaceChildren(...[
    R.head,
    h('div', { class: 'editor-grid' },
      h('div', { class: 'editor-main' }, R.warn, R.form),
      h('div', { class: 'editor-side' }, R.gun ? R.gun.card : h('div', { class: 'card' },
        h('h2', {}, 'Gun time'), h('p', { class: 'help' }, NEW_RACE_GUN_HELP)), R.offer, R.data)),
    R.cross,
  ].filter(isNode));
}

/** Crossings at one split as the server has them right now (a form built earlier may show an older count). */
function liveSplitCrossings(raceId, splitId) {
  return splitCrossings(viewOf(S.state, raceId), splitId);
}

function updateRaceEditor(id) {
  const st = S.state;
  const R = S.re;
  const isNew = id === NEW;
  const cfg = isNew ? null : configRace(st, id);
  const rv = isNew ? null : viewOf(st, id);
  const d = raceDraft(id, st);
  const sw = !isNew && cfg?.active === false ? switchPlan(st, id) : null;
  const rc = reviewCounts(rv);
  paintSig(R.head, JSON.stringify([id, cfg?.name, cfg?.active, isNew && d.draft.name, sw && sw.off.map((r) => r.name), rc]), () => [
    h('h1', { class: 'editor-title' }, isNew ? (str(d.draft.name).trim() || 'New race') : cfg?.name || '(no name)'),
    isNew ? badge('Not saved yet', 'warn') : cfg?.active === false ? badge('Not Active', 'muted') : badge('Active', 'ok'),
    h('div', { class: 'row' },
      // V4: a race that is not Active keeps its reads (DESIGN 9.2 R1); nothing is thrown away
      sw ? h('button', { type: 'button', class: 'btn primary', 'data-fk': 'race-switch', title: 'Its reads are kept, and used once it is Active', onclick: (e) => switchToRace(id, e.currentTarget) },
        sw.off.length ? 'Switch to this race…' : 'Make it Active…') : null,
      !isNew && cfg && rc.known ? reviewChip(cfg, rv) : null),
  ]);
  if (!isNew) {
    const ws = raceWarnings(rv, cfg, st, nowMs(), S.feed.list()).map((w) => ({ ...w, key: `ed|${id}|${warningTitle(w).replace(/[\d,.:]+/g, '#')}` }));
    paintSig(R.warn, JSON.stringify([ws, [...S.attOpen]]), () => (ws.length ? h('section', { class: 'card attention', 'aria-label': 'This race needs attention' }, attentionList(ws, { showRace: false })) : null));
    updateGunCard(rv, cfg);
    const offer = visiblePrompt(id, rv);
    paintSig(R.offer, JSON.stringify([offer || null, [...S.more].filter((k) => k.includes(id))]), () => (offer ? offerBox(id, offer, 'ed') : null));
    paintSig(R.data, JSON.stringify([rv && { ...rv, elapsedTicks: 0 }, cfg?.active, cfg?.inputPort, arr(st.config.outputs).map((o) => [o.name, o.enabled, o.races]), [...S.more].filter((k) => k.startsWith('rd'))]), () => buildRaceData(id, rv, cfg));
    const c = S.crossings.get(id);
    paintSig(R.cross, JSON.stringify(c ? [c.loading, c.error, c.at, c.filter] : null), () => buildCrossings(id));
  }
  // The form also shows what depends on the State: whether RR12 sends timing point names or contests at all (LapTime
  // lines send neither), the ports, which other race is Active on them. A change there rebuilds it, as an edit does.
  const ctx = JSON.stringify([
    arr(st.seen?.locations).some((l) => l && str(l.name).trim()), arr(st.seen?.contests).some((c) => c && str(c.name).trim()),
    inputPorts(st), arr(st.config.races).map((r) => [r.id, r.name, r.active, r.inputPort]), crossingCount(rv) > 0,
  ]);
  if (d.ctx !== ctx) {
    if (d.ctx !== undefined) d.version++;
    d.ctx = ctx;
  }
  syncForm(R.form, d, () => buildRaceForm(id, d));
  // The form is only rebuilt when the draft changes; the per-split counts follow every State (text only).
  if (!isNew) {
    for (const el of R.form.querySelectorAll('[data-split-count]')) {
      const n = liveSplitCrossings(id, el.getAttribute('data-split-count'));
      const t = n ? plural(n, 'crossing') : '';
      if (el.textContent !== t) el.textContent = t;
    }
    // each saved split's pause, as Split Relay has it now
    const supported = reviewSupported(st);
    for (const el of R.form.querySelectorAll('[data-split-pause]')) {
      const sid = el.getAttribute('data-split-pause');
      const cs = arr(cfg?.splits).find((x) => x && x.id === sid);
      const held = splitHeld(arr(rv?.splits).find((x) => x && x.id === sid));
      const on = cs ? splitSending(cs) : true;
      paintSig(el, JSON.stringify([supported, !!cs, on, held, cs?.name, cs ? splitPlaying(id, cs.id) : false]), () => (supported && cs ? [
        on ? null : h('span', { class: 'badge tone-warn' }, pausedText(held)),
        pauseButton(id, cs, held, 'ed'),
      ] : null));
    }
  }
}

/* ---------- gun ---------- */

function buildGunCard(id) {
  const input = h('input', {
    id: 'gun-input', 'data-fk': 'gun-input', class: 'mono gun-input', type: 'text', inputmode: 'decimal',
    autocomplete: 'off', spellcheck: 'false', placeholder: '10:00:00.000', 'aria-describedby': 'gun-help gun-error',
  });
  const err = h('p', { id: 'gun-error', class: 'field-error', role: 'alert', hidden: true });
  const g = {
    id, input, err, dirty: false,
    lynxSlot: h('div', { class: 'gun-lynx' }), live: h('div', { class: 'gun-live' }),
  };
  input.addEventListener('input', () => {
    g.dirty = true;
    if (!err.hidden) checkGunInput(g, false);
  });
  input.addEventListener('blur', () => checkGunInput(g, false));
  const form = h('form', { class: 'gun-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submitGun(g, e.submitter); } },
    h('label', { for: 'gun-input', class: 'gun-label' }, 'Gun time (time of day)'),
    h('div', { class: 'gun-row' }, input, h('button', { type: 'submit', class: 'btn primary', 'data-fk': 'gun-submit' }, 'Set')),
    h('p', { id: 'gun-help', class: 'help' }, '24-hour clock, like 10:00:00.000. Enter sets it.'),
    err,
    // no "Set to now": the gun is only ever what the operator types (race day 2026-10-21, it put the PC's clock in)
    h('div', { class: 'gun-buttons' }, g.lynxSlot));
  g.card = h('section', { class: 'card gun-card', 'aria-labelledby': 'gun-h' },
    h('div', { class: 'card-head' }, h('h2', { id: 'gun-h' }, 'Gun')), g.live, form);
  S.gun = g;
  return g;
}

/** @returns {number | null} */
function checkGunInput(g, required) {
  const text = g.input.value.trim();
  let msg = '';
  let ticks = null;
  if (!text) msg = required ? 'Type the gun time first.' : '';
  else {
    ticks = parseGunText(text);
    if (ticks == null) msg = "That isn't a time of day. Type it like 10:00:00 or 10:00:00.000.";
  }
  showGunError(g, msg);
  return msg ? null : ticks;
}

/** One place sets the message and the red border together, so a value that was fixed never keeps a red field. */
export function showGunError(g, msg) {
  g.err.textContent = msg;
  g.err.hidden = !msg;
  g.input.setAttribute('aria-invalid', String(!!msg));
}

function updateGunCard(rv, cfg) {
  const g = S.gun;
  if (!g || !rv) return;
  void cfg;
  const gunSet = Number.isFinite(rv.gunTicks);
  paintSig(g.live, JSON.stringify([rv.gunText, rv.gunTicks]), () => (gunSet
    ? h('div', { class: 'gun-now' },
      h('span', { class: 'gun-big' }, rv.gunText || formatTod(rv.gunTicks, 4)),
      h('button', { type: 'button', class: 'btn small ghost push-right', 'data-fk': 'gun-clear', onclick: (e) => clearGun(rv.id, e.currentTarget) }, 'Clear'))
    : h('div', { class: 'gun-now' }, h('span', { class: 'gun-big unset' }, 'Not set yet'), h('span', { class: 'help inline' }, 'Reads wait until it is set.'))));
  const lifOn = !!S.state.config.lif?.enabled;
  const differs = gunDiffers(rv);
  paintSig(g.lynxSlot, JSON.stringify([rv.lynxStart, lifOn, differs]), () => {
    if (Number.isFinite(rv.lynxStart)) {
      return [
        h('button', { type: 'button', class: 'btn two-line' + (differs ? ' primary' : ''), 'data-fk': 'gun-lynx', 'aria-label': `Put the FinishLynx start, ${formatTod(rv.lynxStart, 4)}, in the box`, onclick: () => fillGunBox(g, formatTod(rv.lynxStart, 4)) },
          h('span', {}, 'FinishLynx start into the box'), h('span', { class: 'btn-sub' }, formatTod(rv.lynxStart, 4))),
        differs ? h('p', { class: 'msg tone-bad' }, 'The gun differs from the FinishLynx start, so the splits won\'t match FinishLynx\'s times.') : null,
      ];
    }
    return h('p', { class: 'help' }, lifOn
      ? 'FinishLynx start: once FinishLynx has saved this race.'
      : 'Turn on merged .lif files (Settings) to use the FinishLynx start.');
  });
  if (S.gunPrefill && S.gunPrefill.id === rv.id) {
    const { text, at } = S.gunPrefill;
    S.gunPrefill = null;
    if (Date.now() - at < 10_000) fillGunBox(g, text);
    else if (!g.dirty && document.activeElement !== g.input) g.input.value = rv.gunText || '';
  } else if (!g.dirty && document.activeElement !== g.input) g.input.value = rv.gunText || '';
}

/** Put a time in the gun box for the operator to check and Set: nothing is set until they press Set (or Enter). */
function fillGunBox(g, text) {
  g.input.value = text;
  g.dirty = true;
  showGunError(g, '');
  g.input.focus();
  g.input.select();
}

/**
 * What a new gun would do to the reads and crossings the race already has, in words for the confirm dialog.
 * @param {string} id
 * @param {number | null} newTicks
 * @returns {Promise<{ lines: string[], risky: boolean }>}
 */
async function gunEffects(id, newTicks) {
  const lines = [];
  if (!Number.isFinite(newTicks)) return { lines, risky: false };
  const rv = viewOf(S.state, id);
  const prev = Number.isFinite(rv?.gunTicks) ? rv.gunTicks : null;
  const at = formatTod(newTicks);
  let dropped = 0;
  // A later gun takes away the crossings that are now before it (DESIGN.md §9.3): count them in the server's list.
  if (prev != null && raceTicks(newTicks, prev) > 0 && crossingCount(rv) > 0) {
    try {
      const rows = await api('GET', `/api/races/${enc(id)}/crossings`);
      dropped = arr(rows).filter((x) => Number.isFinite(x?.tod) && raceTicks(x.tod, newTicks) < 0).length;
    } catch { /* the dialog still works without the count */ }
  }
  if (dropped) lines.push(`${plural(dropped, 'split')} already counted ${dropped === 1 ? 'is' : 'are'} earlier than ${at} and would no longer count.`);
  const waiting = waitingCount(rv);
  const w = waitingBeforeGun(S.feed.list(), id, newTicks);
  if (w.count) lines.push(waitingBeforeText(w, waiting, at));
  if (dropped || w.count) lines.push('If the race started earlier, type the real start time instead: from the start clock, or the FinishLynx start.');
  return { lines, risky: !!(dropped || w.count) };
}

/**
 * Set or change a gun time. Before a gun that would put reads before it, the operator sees how many and can type
 * the real start instead.
 * @param {string} id
 * @param {any} body POST /api/races/:id/gun body
 * @param {string} describe the new gun in words
 * @param {EventTarget | null} btn
 * @param {{ skipConfirm?: boolean, newTicks?: number | null }} [opts] newTicks: the gun the server will set
 * @returns {Promise<boolean>}
 */
async function setGun(id, body, describe, btn, { skipConfirm = false, newTicks = null } = {}) {
  const rv = viewOf(S.state, id);
  const name = rv?.name || configRace(S.state, id)?.name || 'this race';
  const sentBefore = crossingCount(rv);
  const prev = Number.isFinite(rv?.gunTicks) ? rv.gunTicks : null;
  const back = btn instanceof Element ? btn : null;
  const fx = skipConfirm ? { lines: [], risky: false } : await gunEffects(id, newTicks);
  let ok = true;
  if (prev != null && !skipConfirm) {
    ok = await confirmDialog({
      title: 'Change the gun time?',
      body: [
        `${name} has gun time ${rv.gunText || formatTod(prev)}. Change it to ${describe}?`,
        'Every race time is worked out again from the new gun time.',
        ...fx.lines,
        sentBefore ? 'Splits sent in the last minute are corrected by themselves. If older ones need sending again, the race tile offers a resend.' : '',
      ],
      confirm: 'Change gun time',
      danger: fx.risky,
      back,
    });
  } else if (fx.risky) {
    ok = await confirmDialog({
      title: 'Reads would be before this gun time',
      body: [`Set ${name}'s gun time to ${describe}?`, ...fx.lines],
      confirm: 'Set gun anyway',
      cancel: 'Type the start time',
      danger: true,
      back,
    });
    if (!ok && S.gun && S.gun.id === id && S.gun.input.isConnected) {
      S.gun.input.focus();
      S.gun.input.select();
    }
  }
  if (!ok) return false;
  const st = await act(() => api('POST', `/api/races/${enc(id)}/gun`, body), btn);
  if (!st) return false;
  applyState(st);
  const after = viewOf(st, id);
  const now = Number.isFinite(after?.gunTicks) ? after.gunTicks : null;
  if (sentBefore > 0 && now !== prev && now != null) S.resendOffers.set(id, { count: sentBefore, gun: after.gunText });
  if (now == null) S.resendOffers.delete(id);
  if (S.gun && S.gun.id === id) {
    S.gun.dirty = false;
    S.gun.input.value = after?.gunText || '';
    showGunError(S.gun, '');
  }
  const early = Number(after?.beforeGun) || 0;
  if (now == null) toast(`Gun time for ${name} cleared.`);
  else if (early) toast(`Gun time for ${name} set to ${after.gunText || formatTod(now)}. ${plural(early, 'read')} ${early === 1 ? 'is' : 'are'} before it and not sent.`, 'warn');
  else toast(`Gun time for ${name} set to ${after.gunText || formatTod(now)}.`);
  scheduleRender();
  return true;
}

function submitGun(g, btn) {
  const ticks = checkGunInput(g, true);
  if (ticks == null) {
    g.input.focus();
    return;
  }
  const text = g.input.value.trim();
  const rv = viewOf(S.state, g.id);
  if (rv && rv.gunTicks === ticks) {
    toast(`The gun time is already ${rv.gunText || text}.`, 'info');
    return;
  }
  setGun(g.id, { gun: text }, text, btn, { newTicks: ticks });
}

async function clearGun(id, btn) {
  const rv = viewOf(S.state, id);
  const ok = await confirmDialog({
    title: 'Clear the gun time?',
    body: [`${rv?.name || 'This race'} will have no gun time. New reads wait, and nothing more is sent for this race until you set a gun time again.`],
    confirm: 'Clear gun time',
    danger: true,
  });
  if (ok) setGun(id, { gun: '' }, '', btn, { skipConfirm: true });
}

/* ---------- race actions ---------- */

function outputsForRace(id) {
  return arr(S.state?.config?.outputs).filter((o) => o.enabled !== false && outputSendsRace(o, id));
}

async function resendRace(id, btn) {
  const name = configRace(S.state, id)?.name || viewOf(S.state, id)?.name || 'this race';
  const t = resendDialogText(S.state, id);
  const fin = h('input', { type: 'checkbox', id: 'resend-finished' });
  const ok = await confirmDialog({
    title: t.title,
    body: t.body,
    extra: h('label', { class: 'check-label resend-finished', for: 'resend-finished' }, fin,
      h('span', {}, `Also re-send runners who have finished (${outputsForRace(id).length ? listText(outputsForRace(id).map((o) => o.name)) : 'the outputs'} will show their split place until FinishLynx re-sends their finish)`)),
    confirm: t.confirm,
    danger: t.danger,
    back: btn instanceof Element ? btn : null,
    // the button says what goes, with the box ticked or not
    onReady: (yes) => fin.addEventListener('change', () => { yes.textContent = resendDialogText(S.state, id, { includeFinished: fin.checked }).confirm; }),
  });
  if (!ok) return;
  const includeFinished = fin.checked;
  // A race the operator already knows is switched off was just confirmed with the risk spelled out.
  let r = await sendResend(id, { includeFinished, force: t.inactive }, btn);
  if (r && r.refused) {
    const again = await confirmDialog({
      title: `${name} is switched off`,
      body: [r.refused, 'Resending it makes TrackScore switch to this race and clear the race it is showing now.'],
      confirm: 'Resend anyway',
      danger: true,
      back: btn instanceof Element ? btn : null,
    });
    if (!again) return;
    r = await sendResend(id, { includeFinished, force: true }, btn);
  }
  if (!r || r.refused) return;
  S.resendOffers.delete(id);
  S.offerDismissed.delete(id);
  toast(resendToast(name, r, t.n), Number(r.sent) ? 'ok' : 'warn');
  scheduleRender();
}

/**
 * POST /api/races/:id/resend. A 409 (an inactive race without force, DESIGN.md §9.8) comes back as { refused } with
 * the server's words instead of an error toast, so the caller can ask.
 */
async function sendResend(id, body, btn) {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    return await api('POST', `/api/races/${enc(id)}/resend`, body);
  } catch (err) {
    if (err && err.status === 409) return { refused: err.message };
    toast(err && err.message ? err.message : String(err), 'bad');
    return undefined;
  } finally {
    if (b) b.disabled = false;
  }
}

/** One click from the "FinishLynx calls this event …" warning: the race takes FinishLynx's event name. */
async function renameRace(id, name, btn) {
  const st = await act(() => api('PUT', `/api/races/${enc(id)}`, { name }), btn);
  if (!st) return;
  applyState(st);
  toast(`Race renamed to ${name}, as FinishLynx has it.`);
}

/** "TrackScore gets: [race]": the output sends that one race from now on. */
async function setOutputRace(outputId, raceId, btn) {
  const o = configOutput(S.state, outputId);
  const r = configRace(S.state, raceId);
  if (!o || !r) return;
  const st = await act(() => api('PUT', `/api/outputs/${enc(outputId)}`, { races: [raceId] }), btn);
  if (!st) return;
  applyState(st);
  S.pickerChoice.delete(outputId);
  toast(`${o.name || 'The output'} now gets only ${r.name || 'that race'}.`);
}

function clearRace(id, btn) {
  return once('race-clear:' + id, btn, async () => {
    const rv = viewOf(S.state, id);
    const name = rv?.name || configRace(S.state, id)?.name || 'this race';
    const here = () => !!configRace(S.state, id);
    if (!here()) return toast(`${name} is not in the settings any more: there is nothing to clear.`, 'info');
    // one line up front; the whole story under Details, open from the start as in every risky dialog
    const ok = await confirmDialog({
      title: `Clear ${name}'s race data?`,
      body: [`Forgets ${plural(crossingCount(rv), 'crossing')} and who finished. The settings, gun time and splits stay.`, ...clearRaceText(rv)],
      lead: 1,
      confirm: 'Clear race data',
      danger: true,
      alive: here,
      gone: `${name} was deleted meanwhile: there is nothing to clear.`,
    });
    if (!ok) return;
    const st = await act(() => api('POST', `/api/races/${enc(id)}/clear`), btn);
    if (!st) return;
    applyState(st);
    S.resendOffers.delete(id);
    S.offerDismissed.delete(id);
    S.crossings.delete(id);
    toast(`${name}: race data cleared.`);
  });
}

/** The words when a race to delete is already gone (a second click, another window): said, never asked again. */
const raceGoneText = (name) => `${name} is already deleted.`;

function deleteRace(id, btn) {
  return once('race-del:' + id, btn, async () => {
    const cfg = configRace(S.state, id);
    const name = cfg?.name || 'this race';
    const here = () => !!configRace(S.state, id);
    if (!cfg) return toast(raceGoneText('The race'), 'info');
    // what the delete does to the reads, worked out by Split Relay with the rules it will apply (DESIGN 9.2)
    let plan = null;
    try {
      plan = await api('POST', '/api/races/preview', { id, delete: true });
    } catch (err) {
      if (err?.status === 404) return here() ? toast(err.message, 'bad') : toast(raceGoneText(name), 'info');
    }
    // the preview took a moment: the race may have gone meanwhile
    if (!here()) return toast(raceGoneText(name), 'info');
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      body: deleteRaceText(configRace(S.state, id), viewOf(S.state, id), plan),
      confirm: 'Delete race',
      danger: true,
      alive: here,
      gone: `${name} was deleted meanwhile (another window?).`,
    });
    if (!ok || !here()) return;
    const st = await act(() => api('DELETE', `/api/races/${enc(id)}`), btn);
    if (!st) return;
    S.drafts.delete('race:' + id);
    S.resendOffers.delete(id);
    S.offerDismissed.delete(id);
    S.crossings.delete(id);
    // (deleted here: the Races page needs no "it was deleted" of its own)
    if (S.editorRace === id) S.editorRace = null;
    applyState(st);
    toast(`${name} deleted.`);
    go('#races');
  });
}

/**
 * "Delete it…" on a missing race's warning (DESIGN 9.2 R6): the way to let its reads go when the race is not coming
 * back. Like any delete it takes them out of use for good, so the dialog says what happens first.
 * @param {string} id
 * @param {HTMLElement} btn
 */
function deleteMissingRace(id, btn) {
  return once('race-del:' + id, btn, async () => {
    const missing = () => arr(S.state?.missingRaces).find((x) => x.raceId === id);
    const m = missing();
    if (!m) return;
    const name = str(m.raceName) || id;
    let plan = null;
    try {
      plan = await api('POST', '/api/races/preview', { id, delete: true });
    } catch (err) {
      if (err?.status === 404) return missing() ? toast(err.message, 'bad') : toast(raceGoneText(name), 'info');
    }
    if (!missing()) return toast(`${name} is no longer missing: it was deleted or put back meanwhile.`, 'info');
    const ok = await confirmDialog({
      title: `Delete the missing race ${name}?`,
      body: deleteMissingText(m, plan),
      confirm: 'Delete race',
      danger: true,
      alive: () => !!missing(),
      gone: `${name} is no longer missing: it was deleted or put back meanwhile.`,
    });
    if (!ok || !missing()) return;
    const st = await act(() => api('DELETE', `/api/races/${enc(id)}`), btn);
    if (!st) return;
    applyState(st);
    toast(`${str(m.raceName) || 'The missing race'} deleted: its reads are no longer used.`);
  });
}

/**
 * "Keep it" on the warning about a deleted race that is back in the settings (DESIGN 9.15 V5): the operator wants it,
 * so it is no longer treated as deleted. Its reads from before the delete stay out of use.
 */
async function keepRace(id, name, btn) {
  const ok = await confirmDialog({
    title: `Keep ${name || 'this race'}?`,
    body: [`${name || 'The race'} stays in the settings and works like any other race from now on. The reads it had when it was deleted stay out of use.`],
    confirm: 'Keep it',
    back: btn instanceof Element ? btn : null,
  });
  if (!ok) return;
  // saving the race is keeping it: Split Relay then no longer counts it as deleted
  const cfg = configRace(S.state, id);
  if (!cfg) return;
  const st = await act(() => api('PUT', `/api/races/${enc(id)}`, { name: cfg.name }), btn);
  if (!st) return;
  applyState(st);
  toast(`${name || 'The race'} is kept.`);
}

/** The State in an answer that may be a State, or { state, ... } with more (activate, restore). */
const stateIn = (r) => (r?.config ? r : r?.state?.config ? r.state : null);

/**
 * A race draft after its race changed on the server for a reason the operator asked for elsewhere (a switch): a
 * clean draft follows the server, a dirty one keeps its own edits on top of the new server copy instead of saying
 * "changed somewhere else".
 */
function rebaseRaceDraft(id) {
  const d = S.drafts.get('race:' + id);
  const server = configRace(S.state, id);
  if (!d || d.isNew || !server) return;
  const fresh = raceToDraft(server);
  if (!isDirty(d) || draftJson(d.draft) === draftJson(fresh)) {
    reloadDraft(d, server);
    return;
  }
  d.draft.active = fresh.active;
  d.base = draftJson(fresh);
  d.remoteChanged = false;
  d.version++;
}

/**
 * "Switch to <race>" (DESIGN 9.15 L3): POST /api/races/:id/activate ticks Active on the race and unticks the other
 * Active races that take the same reads (its RR12 port, its contests) in one step, the change-over between two races
 * on one port. The dialog says what changes; an output that was given only the race going off can follow.
 * @param {string} id
 * @param {EventTarget | null} btn
 */
async function switchToRace(id, btn) {
  const st0 = S.state;
  if (!configRace(st0, id)) return;
  // what Split Relay will do, worked out by it: the races it unticks, and the reads that wait for this race. A switch
  // it would refuse (the race's port is gone) says why here, before anything changes.
  let preview = null;
  try {
    preview = await api('POST', '/api/races/preview', { id, activate: true });
  } catch (err) {
    if (err?.status >= 400 && err.status < 500) return toast(err.message, 'bad');
  }
  const plan = switchPlan(st0, id, Array.isArray(preview?.unticked) ? preview.unticked.map((u) => u.raceId) : null);
  if (!plan) return;
  const name = plan.race.name || 'this race';
  const outChecks = plan.outputs.map(({ output, from }) => {
    const box = h('input', { type: 'checkbox', id: 'sw-out-' + output.id, checked: true });
    return { output, box, label: h('label', { class: 'check-label', for: 'sw-out-' + output.id }, box,
      h('span', {}, `Also send ${output.name || 'that output'} ${name} instead of ${listText(from)}`)) };
  });
  const ok = await confirmDialog({
    title: plan.off.length ? `Switch to ${name}?` : `Make ${name} Active?`,
    // (the races switched off keep their reads: said once, above, not again per contest)
    body: [...switchDialogText(plan, viewOf(st0, id)), ...(Array.isArray(preview?.unticked) ? planLines({ ...preview, kept: [] }, id) : [])],
    extra: outChecks.length ? h('div', { class: 'stack' }, outChecks.map((c) => c.label)) : null,
    confirm: plan.off.length ? `Switch to ${name}` : 'Make it Active',
    back: btn instanceof Element ? btn : null,
  });
  if (!ok) return;
  const r = await act(() => api('POST', `/api/races/${enc(id)}/activate`), btn);
  if (!r) return;
  const st = stateIn(r);
  if (st) applyState(st);
  else await refreshState().catch(() => {});
  // what really changed: the server's list when it gives one, else the races that were Active and are not any more
  const named = arr(r.unticked).map((x) => (typeof x === 'string' ? configRace(S.state, x)?.name || x : str(x?.raceName) || configRace(S.state, x?.raceId)?.name)).filter(Boolean);
  const offIds = arr(st0.config.races).filter((x) => x.active !== false && configRace(S.state, x.id)?.active === false).map((x) => x.id);
  const off = named.length ? named : offIds.map((x) => configRace(S.state, x)?.name || '(no name)');
  for (const rid of [id, ...offIds]) rebaseRaceDraft(rid);
  const moved = [];
  for (const c of outChecks) {
    if (!c.box.checked) continue;
    const st2 = await act(() => api('PUT', `/api/outputs/${enc(c.output.id)}`, { races: [id] }), null);
    if (st2) {
      applyState(st2);
      moved.push(c.output.name || 'the output');
    }
  }
  const now = configRace(S.state, id);
  if (now && now.active === false) {
    toast(`${name} is still not Active. Split Relay did not switch it on.`, 'bad');
    return;
  }
  toast(`${name} is Active${off.length ? `; ${listText(off)} ${off.length === 1 ? 'is' : 'are'} not Active any more (reads kept)` : ''}.${moved.length ? ` ${listText(moved)} now ${moved.length === 1 ? 'gets' : 'get'} only ${name}.` : ''}`, 'ok', 8000);
  scheduleRender();
}

/**
 * "Put it back" on a missing race's warning (DESIGN 9.15 V2): POST /api/races/:id/restore adds the race to the settings
 * again from the settings kept in its race file (checked like any change: it may come back not Active), and its reads
 * come back with it.
 * @param {string} id
 * @param {EventTarget | null} btn
 */
async function restoreMissingRace(id, btn) {
  const m = arr(S.state?.missingRaces).find((x) => x.raceId === id);
  if (!m) return;
  const ok = await confirmDialog({
    title: `Put ${str(m.raceName) || 'the race'} back?`,
    body: restoreMissingText(m, S.state),
    confirm: 'Put it back',
    back: btn instanceof Element ? btn : null,
  });
  if (!ok) return;
  const r = await act(() => api('POST', `/api/races/${enc(id)}/restore`), btn);
  if (!r) return;
  const st = stateIn(r);
  if (st) applyState(st);
  else await refreshState().catch(() => {});
  const back = configRace(S.state, id);
  const name = back?.name || str(m.raceName) || 'The race';
  if (!back) {
    toast(`${name} could not be put back. Reload the page (F5) and look at the Dashboard.`, 'bad');
    return;
  }
  // the answer says why it came back not Active (V1: it wants the reads of an Active race) and whether it was renamed
  const why = str(r.restored?.why ?? r.why);
  const renamed = str(r.restored?.renamedFrom ?? r.renamedFrom);
  toast(`${name} is back with its settings, and its reads are used again.${renamed ? ` It is called “${name}” because another race is called “${renamed}”.` : ''}${back.active === false ? ` It is not Active${why ? `: ${why}` : ''}. Switch to it when it runs.` : ''}`, back.active === false || renamed ? 'warn' : 'ok', 12000);
}

function duplicateRace(id) {
  const cfg = configRace(S.state, id);
  if (!cfg) return;
  const existing = S.drafts.get('race:' + NEW);
  if (existing && isDirty(existing) && str(existing.draft.name).trim()) {
    toast('Finish or discard the new race you started first.', 'warn');
    go('#races/new');
    return;
  }
  const draft = duplicateDraft(cfg, S.state.config.races);
  draft.splits = draft.splits.map((s) => ({ _k: newKey(), ...s }));
  S.drafts.set('race:' + NEW, { key: 'race:' + NEW, toDraft: raceToDraft, draft, base: null, isNew: true, savedAt: 0, errors: [], remoteChanged: false, saving: false, version: 1, ui: {}, autoActive: true });
  // the event number is the one thing a copy must not keep: put the cursor in it
  S.focusAfter = 'race-en';
  toast(duplicateToast(cfg, draft, S.state.config.races), 'info', 9000);
  go('#races/new');
}

/**
 * "Add a race for it" on a set-aside warning: the new-race editor ready to take those reads, with the deleted race's
 * name filled in. The set-aside reads (the ones that came after the delete) and the new ones then count there; the
 * deleted race's own reads stay out of use (DESIGN 9.2 R2). A contest is listed on the race; a port's reads (LapTime
 * lines) need a race on that port, an event's a race with that event (DESIGN 9.15 L3).
 * @param {string} contest the set-aside entry's contest (for a port or an event, its label: "Port 5565")
 * @param {string} name the deleted race's name, or ''
 * @param {{ via?: string, port?: number|null, event?: string|null }} [key] how the reads are routed
 */
function newRaceFor(contest, name, key = {}) {
  const port = key.via === 'port' ? portNum(key.port) : null;
  const event = key.via === 'event' ? str(key.event) : '';
  const what = readsLabel({ contest, via: key.via, port, event });
  const existing = S.drafts.get('race:' + NEW);
  if (existing && isDirty(existing) && str(existing.draft.name).trim()) {
    toast(`Finish or discard the new race you started first, or ${port != null ? `choose port ${port} on it` : event ? `give it Event ${event}` : `add '${contest}' to its contests`}.`, 'warn');
    go('#races/new');
    return;
  }
  const [en = '', round = '1', heat = '1'] = event ? event.split('-') : [];
  // a race for a contest or an event takes those reads: no port of its own (a port could clash with the running race)
  const fields = port != null ? { name, inputPort: port }
    : event ? { name, eventNumber: en, round, heat, inputPort: null }
      : { name, contests: [contest], inputPort: null };
  const draft = raceToDraft(newRaceDefaults(S.state, fields));
  S.drafts.set('race:' + NEW, { key: 'race:' + NEW, toDraft: raceToDraft, draft, base: null, isNew: true, savedAt: 0, errors: [], remoteChanged: false, saving: false, version: 1, ui: {}, autoActive: true });
  S.focusAfter = name ? (event ? 'race-nsplits' : 'race-en') : 'race-name';
  const head = port != null ? `The new race reads from port ${port}.` : event ? `The new race has Event ${event}.` : `'${contest}' is listed on the new race.`;
  toast(`${head} ${event ? 'Set' : 'Type its event number, set'} its number of splits, then save it: the reads ${what} count there.`, 'info', 9000);
  go('#races/new');
}

function buildRaceData(id, rv, cfg) {
  const n = crossingCount(rv);
  const outs = outputsForRace(id);
  const stat = (label, v, tone) => h('div', {}, h('dt', {}, label), h('dd', { class: tone || null }, fmtInt(v || 0)));
  const ignored = [
    ['in the start area', rv?.startArea],
    ['after the finish', rv?.afterFinish],
    ['out of order', rv?.outOfOrder],
    ['repeats', rv?.repeats],
    // passes counted past the last split, or before a split's earliest time (DESIGN 9.15 L4)
    ['after the last split (extra passes)', rv?.extra ?? rv?.extraPasses],
    ['too early for their split', rv?.tooEarly],
  ].filter(([, v]) => Number(v) > 0);
  const lo = leftoverText(rv?.leftover);
  const [loBtn, loBody] = moreParts('rd-lo-' + id, lo, 'Which cells, and why');
  const resendHelp = n ? (cfg?.active === false
    ? 'Not Active: TrackScore probably shows another race, and a resend makes it switch.'
    : 'Sends every split again with the current settings, for example after a gun fix.')
    // splits went out earlier but none count under the current settings (the gun moved past them, say)
    : Number(rv?.stale?.count) > 0 || Number(rv?.leftover?.count) > 0
      ? 'No splits under the current settings, so nothing to resend.'
      : 'Nothing has been sent for this race yet.';
  const [rsBtn, rsBody] = moreParts('rd-rs-' + id, n && cfg?.active !== false ? RESEND_LIMIT : '', 'What a resend can and can\'t fix');
  return [
    h('div', { class: 'card-head' }, h('h2', { id: 'race-data-h' }, 'Race data')),
    h('dl', { class: 'stats' },
      stat('Runners', rv?.runners),
      stat('Finished', rv?.finished),
      stat('Waiting for gun', waitingCount(rv), waitingCount(rv) ? 'tone-text-warn' : ''),
      Number.isFinite(rv?.beforeGun) ? stat('Before gun', rv.beforeGun, rv.beforeGun ? 'tone-text-warn' : '') : null,
      Number(rv?.finishedNotSent) > 0 ? stat('Finished, not sent', rv.finishedNotSent) : null,
      h('div', {}, h('dt', {}, 'Last read'), h('dd', {}, agoSpan(rv?.lastReadAt, { never: 'none yet' })))),
    h('p', { class: 'help' }, [
      portNum(cfg?.inputPort) != null ? `Reads from RR12 port ${cfg.inputPort}.` : 'Reads only the RR12 reads that name its contests.',
      outs.length ? `Sent to ${listText(outs.map((o) => o.name))}.` : 'No output sends this race.',
    ].join(' ')),
    ignored.length ? h('p', { class: 'help' }, `Ignored: ${ignored.map(([w, v]) => `${fmtInt(v)} ${w}`).join(', ')}.`) : null,
    // DESIGN 9.16 F1: what a Resend can't correct, said where the button is
    lo ? h('div', { class: 'msg tone-info', 'data-fk': 'race-leftover' }, `TrackScore may still show ${plural(Number(rv.leftover.count) || 0, 'old cell')} that Split Relay can't clear.`, loBtn, loBody) : null,
    h('div', { class: 'tool-list', style: 'margin-top:12px' },
      h('div', { class: 'tool' },
        h('strong', {}, 'Resend splits', rsBtn),
        h('p', { class: 'help' }, resendHelp),
        h('button', { type: 'button', class: 'btn small', 'data-fk': 'race-resend', disabled: !n, onclick: (e) => resendRace(id, e.currentTarget) }, 'Resend…'),
        rsBody),
      h('div', { class: 'tool' },
        h('strong', {}, 'Clear race data'),
        h('p', { class: 'help' }, 'Forgets its crossings, after a false start or a test. Settings stay.'),
        h('button', { type: 'button', class: 'btn small danger', 'data-fk': 'race-clear', 'aria-disabled': busyAttr('race-clear:' + id), onclick: (e) => clearRace(id, e.currentTarget) }, 'Clear…')),
      h('div', { class: 'tool' },
        h('strong', {}, 'Duplicate'),
        h('p', { class: 'help' }, 'A new race with the same splits and port.'),
        h('button', { type: 'button', class: 'btn small', 'data-fk': 'race-dup', onclick: () => duplicateRace(id) }, 'Duplicate')),
      h('div', { class: 'tool' },
        h('strong', {}, 'Delete race'),
        h('p', { class: 'help' }, 'Its reads are no longer used. To stop a race, turn off Active.'),
        h('button', { type: 'button', class: 'btn small danger', 'data-fk': 'race-del', 'aria-disabled': busyAttr('race-del:' + id), onclick: (e) => deleteRace(id, e.currentTarget) }, 'Delete…'))),
  ];
}

/* ---------- crossings ---------- */

async function loadCrossings(id, btn) {
  const prev = S.crossings.get(id);
  S.crossings.set(id, { ...(prev || {}), loading: true, error: '' });
  scheduleRender();
  try {
    const rows = await api('GET', `/api/races/${enc(id)}/crossings`);
    S.crossings.set(id, { rows: arr(rows), loading: false, error: '', at: Date.now(), filter: prev?.filter || '' });
  } catch (err) {
    S.crossings.set(id, { ...(prev || {}), loading: false, error: err.message, at: Date.now() });
  }
  if (btn && btn.isConnected) btn.disabled = false;
  scheduleRender();
}

function buildCrossings(id) {
  const c = S.crossings.get(id);
  const head = h('div', { class: 'row-between' },
    h('h3', {}, 'Crossings'),
    h('div', { class: 'row' },
      c ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { S.crossings.delete(id); scheduleRender(); } }, 'Hide') : null,
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'cross-load', disabled: !!c?.loading, onclick: (e) => loadCrossings(id, e.currentTarget) },
        c?.loading ? 'Loading…' : c ? 'Refresh' : 'Show crossings')));
  if (!c) return [head, h('p', { class: 'help' }, 'Every runner\'s splits as Split Relay has them: time, place, and how many reads made each crossing.')];
  if (c.error) return [head, h('p', { class: 'msg tone-bad' }, `Couldn't load the crossings: ${c.error}`)];
  if (!c.rows) return [head, h('p', { class: 'help' }, 'Loading…')];
  const q = norm(c.filter);
  const rows = c.rows.filter((x) => !q || norm(x.bib).includes(q) || norm(x.name).includes(q) || norm(x.team).includes(q));
  const filter = h('input', { type: 'search', 'data-fk': 'cross-filter', placeholder: 'Bib, name or team', value: c.filter || '', 'aria-label': 'Filter crossings',
    oninput: (e) => { c.filter = e.target.value; scheduleRender(); } });
  return [head,
    h('p', { class: 'help' }, `${plural(c.rows.length, 'crossing')} as of ${formatWall(c.at)}. `, filter),
    rows.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'feed' },
      h('thead', {}, h('tr', {}, ['Split', 'Bib', 'Name', 'Team', 'Time of day', 'Race time', 'Place', 'Reads', 'Sent', 'Why sent'].map((t, i) => h('th', { scope: 'col', class: [1, 5, 6, 7].includes(i) ? 'num' : null }, t)))),
      h('tbody', {}, rows.map((x) => h('tr', {},
        h('td', {}, str(x.splitName)), h('td', { class: 'num' }, str(x.bib)), h('td', {}, str(x.name)), h('td', {}, str(x.team)),
        h('td', { class: 'mono' }, Number.isFinite(x.tod) ? formatTod(x.tod) : ''),
        h('td', { class: 'num' }, Number.isFinite(x.raceTicks) ? formatRaceTime(x.raceTicks, 3) : ''),
        h('td', { class: 'num' }, x.place == null ? '' : str(x.place)),
        h('td', { class: 'num' }, str(x.reads ?? '')),
        // (9.26: a crossing of a split that is counted, not sent, never goes out)
        h('td', {}, toMs(x.sentAt) ? formatWall(toMs(x.sentAt)) : x.held === 'collect' ? 'not sent (counted)' : 'not yet'),
        h('td', {}, reasonWord(x.reason))))))) : h('p', { class: 'help' }, c.rows.length ? 'No crossing matches.' : 'No crossings yet.'),
  ];
}

const reasonWord = (r) => ({ new: 'first read', correction: 'earlier read won', 'place-update': 'place changed', resend: 'resend' }[r] || str(r));

/* ---------- race form ---------- */

function buildRaceForm(id, d) {
  const st = S.state;
  const dr = d.draft;
  const rv = id === NEW ? null : viewOf(st, id);
  const saved = id === NEW ? null : configRace(st, id);
  const crossingsBySplit = new Map(arr(rv?.splits).map((s) => [s.id, Number(s.crossings) || 0]));
  const seenLoc = new Map(arr(st.seen?.locations).map((l) => [norm(l.name), l]));
  const seenContest = new Map(arr(st.seen?.contests).map((c) => [norm(c.name), c]));
  // RR12's LapTime lines (bib + time, DESIGN 9.15) carry no timing point names and no contests: the race then counts
  // each runner's passes, and the editor leaves out what only named reads need. Anything the race already has stays.
  const namesSeen = arr(st.seen?.locations).some((l) => l && str(l.name).trim());
  const showSources = namesSeen || dr.splits.some((s) => s.sources.length) || dr.finishSources.length > 0;
  const showContests = arr(st.seen?.contests).some((c) => c && str(c.name).trim()) || dr.contests.length > 0;
  const hasEarliest = dr.splits.some((s) => str(s.earliest).trim());
  const earliestError = d.errors.some((e) => /earliest/i.test(e));
  // (open when an earliest time is refused: the field the message is about must be in view)
  const advanced = earliestError || (S.raceAdvanced.get(d.key) ?? hasEarliest);
  const tagWindow = str(st.config?.filter?.tagWindowSec ?? 10);
  const mappedHere = () => new Set([...dr.splits.flatMap((s) => s.sources), ...dr.finishSources].map(norm));
  const byRecent = (a, b) => (toMs(b.lastAt) ?? 0) - (toMs(a.lastAt) ?? 0) || str(a.name).localeCompare(str(b.name));
  // names that start with the split's name come first: "1K-A" and "1K-B" lead the list for split "1K"
  const locationOptions = (forName) => {
    const used = mappedHere();
    return rankLocations(arr(st.seen?.locations).filter((l) => l.name && !used.has(norm(l.name))), forName)
      .map((l) => ({ name: l.name, note: plural(l.count || 0, 'read') }));
  };
  const addSource = (list) => (name) => {
    const n = norm(name);
    const inSplit = dr.splits.find((s) => s.sources.some((x) => norm(x) === n));
    if (inSplit) return `“${name}” is already used by split ${inSplit.name || '(no name)'}.`;
    if (dr.finishSources.some((x) => norm(x) === n)) return `“${name}” is already a finish timing point.`;
    list.push(name);
    return null;
  };
  const other = arr(st.config.races).filter((r) => r.id !== id);
  const contestOwner = (name) => other.find((r) => arr(r.contests).some((c) => norm(c) === norm(name)));
  const contestOptions = arr(st.seen?.contests)
    .filter((c) => c.name && !dr.contests.some((x) => norm(x) === norm(c.name))).sort(byRecent)
    .map((c) => ({ name: c.name, note: contestNote(c, st, contestOwner(c.name)) }));
  const n = dr.splits.length;
  // 9.26: the scoreboards go by the splits that are sent: a change of their number or order, or a split that is only
  // counted put between them, changes what the splits already sent mean
  const chg = splitsChange(saved?.splits, dr.splits);
  const anyCrossings = crossingCount(rv) > 0;
  const columnsNote = !d.isNew && anyCrossings ? columnsChangeText(chg.was, chg.now, chg.reordered, chg.recount, chg.swapped) : '';
  const quietCount = dr.splits.filter(notSent).length;
  const keyOf = (s) => {
    if (!s.id && !s._k) s._k = newKey();
    return s.id || s._k;
  };

  const splitRow = (s, i) => {
    const key = keyOf(s);
    const crossings = crossingsBySplit.get(s.id) || 0;
    const nameId = `race-split-${key}`;
    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= dr.splits.length) return;
      [dr.splits[i], dr.splits[j]] = [dr.splits[j], dr.splits[i]];
      renumberDefaultNames(dr.splits);
      const dir = delta < 0 ? 'up' : 'down';
      const edge = delta < 0 ? j === 0 : j === dr.splits.length - 1;
      S.focusAfter = `split-${edge ? (dir === 'up' ? 'down' : 'up') : dir}-${key}`;
      restructure(d);
    };
    const remove = async () => {
      // counted now, not when the form was built: the race may have had its data cleared or new reads since
      const now = liveSplitCrossings(id, s.id);
      const at = dr.splits.indexOf(s);
      if (now) {
        const rest = dr.splits.filter((x) => x !== s);
        const ok = await confirmDialog({
          title: `Remove split ${s.name || at + 1}?`,
          // (9.26: a split that is only counted has no column on a scoreboard: taking it out moves the runners' later
          // passes a split earlier, which the boards then show)
          body: [notSent(s)
            ? `It has ${plural(now, 'crossing')}. When you save, those passes are no longer counted as ${s.name || 'this split'}, so every runner's later passes move one split earlier and the splits already sent hold another split's time. Remove it only if its mat is gone; then resend this race's splits.`
            : `It has ${plural(now, 'crossing')}. When you save, its reads no longer count as a split, and the splits after it move one column in TrackScore and Karmarush (they go by laps to go). ${splitsHint(rest)}`],
          confirm: 'Remove split',
          danger: true,
        });
        if (!ok) return;
      }
      const j = dr.splits.indexOf(s);
      if (j < 0) return;
      dr.splits.splice(j, 1);
      renumberDefaultNames(dr.splits);
      S.focusAfter = 'race-nsplits';
      restructure(d);
    };
    // 9.26: "Add a split after this one": a mat between two splits goes where it is on the course
    const addAfter = () => {
      const at = dr.splits.indexOf(s);
      if (at < 0 || dr.splits.length >= MAX_SPLITS) return;
      const k = newKey();
      dr.splits = addSplitAfter(dr.splits, at, () => k);
      S.focusAfter = `race-split-${k}`;
      S.selectAfter = `race-split-${k}`;
      restructure(d);
    };
    // 9.26: laps to go by the splits that are sent; a split that is not sent has none
    const quiet = notSent(s);
    const l2g = sentLapsToGo(dr.splits, i);
    const what = s.name || `split ${i + 1}`;
    const sendId = `race-send-${key}`;
    const isSaved = !!s.id && arr(saved?.splits).some((x) => x && x.id === s.id);
    return h('li', { class: 'split-row' + (quiet ? ' not-sent' : '') },
      h('span', { class: 'split-num', 'aria-hidden': 'true' }, String(i + 1)),
      h('label', { for: nameId, class: 'sr-only' }, `Split ${i + 1} name`),
      h('input', { id: nameId, 'data-fk': nameId, type: 'text', value: s.name, placeholder: defaultSplitName(i), autocomplete: 'off', oninput: (e) => { s.name = e.target.value; changed(d); } }),
      // DESIGN 9.26: Send, on for every split unless the operator switches it off: then the split is counted (so the later
      // passes land in their own splits) and nothing of it goes out. Part of the form: it is saved with Save.
      h('label', { class: 'switch-label split-send', for: sendId,
        title: quiet ? `${what} is counted, not sent: nothing of it goes to TrackScore, Karmarush or the merged .lif file. Switch on to send it.`
          : `${what} is sent. Switch off for a mat whose time is not worth showing (one a little after a K marker): it is still counted, so the later splits stay right.` },
        h('input', { id: sendId, 'data-fk': sendId, type: 'checkbox', class: 'switch', checked: !quiet, 'aria-label': `Send ${what}`,
          onchange: (e) => { s.collectOnly = !e.target.checked; S.focusAfter = sendId; restructure(d); } }),
        h('span', {}, quiet ? 'Not sent' : 'Send')),
      // L5/L6: the number TrackScore and Karmarush file this split under; never 0, which is the finish
      h('span', { class: 'split-meta' },
        quiet
          ? h('span', { class: 'badge tone-muted l2g', title: 'Counted, not sent: it has no column in TrackScore or Karmarush, so no laps to go.' }, 'Counted only')
          : h('span', { class: 'badge tone-muted l2g', title: 'TrackScore and Karmarush put this split in the column for this number of laps to go.' }, `Laps to go ${l2g}`),
        h('span', { class: 'split-count', 'data-split-count': s.id || '' }, crossings ? plural(crossings, 'crossing') : '')),
      // DESIGN 9.17 P1: pause/play acts at once (not on Save), so it is drawn from the State, beside the form's fields
      // (9.26: a split that is not sent has nothing to pause)
      isSaved && !quiet ? h('span', { class: 'split-pause', 'data-split-pause': s.id }) : h('span'),
      // with passes counted, a split is its place in the order: there is nothing to move (9.26: but a split can be added
      // after any row, and any row removed, so a mat between two splits is put where it is on the course)
      h('div', { class: 'split-tools' },
        showSources ? h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `split-up-${key}`, disabled: i === 0, 'aria-label': `Move split ${s.name || i + 1} up`, title: 'Move up', onclick: () => move(-1) }, h('span', { class: 'i i-up', 'aria-hidden': 'true' })) : null,
        showSources ? h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `split-down-${key}`, disabled: i === n - 1, 'aria-label': `Move split ${s.name || i + 1} down`, title: 'Move down', onclick: () => move(1) }, h('span', { class: 'i i-down', 'aria-hidden': 'true' })) : null,
        h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `split-add-${key}`, disabled: n >= MAX_SPLITS, 'aria-label': `Add a split after ${what}`, title: `Add a split after ${what}`, onclick: addAfter }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' })),
        showSources
          ? h('button', { type: 'button', class: 'btn small danger', 'data-fk': `split-del-${key}`, 'aria-label': `Delete split ${s.name || i + 1}`, onclick: remove }, 'Delete')
          : h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `split-del-${key}`, disabled: n <= 1, 'aria-label': `Remove split ${what}`, title: `Remove ${what}`, onclick: remove }, h('span', { class: 'i i-close', 'aria-hidden': 'true' }))),
      showSources ? h('div', { class: 'split-extra' },
        h('span', { class: 'sub-label' }, 'Timing points'),
        chipEditor({
          d, key: `src-${key}`, items: s.sources, removeLabel: `Remove from split ${s.name || i + 1}:`, seenMap: seenLoc,
          onRemove: (k) => s.sources.splice(k, 1), onAdd: addSource(s.sources), options: locationOptions(s.name),
          optionsTitle: 'Timing point names seen from RR12, not used in this race yet:',
          emptyOptions: 'No unused timing point names seen yet. Type the name exactly as RR12 has it (for example 1K-A).',
          inputLabel: `Add a timing point to split ${s.name || i + 1}`, placeholder: 'Timing point name',
        })) : null);
  };

  // "Number of splits": the operator's main control (DESIGN 9.15 L5). Rows are added or removed at the end.
  const countInput = h('input', {
    id: 'race-nsplits', 'data-fk': 'race-nsplits', type: 'number', min: '1', max: String(MAX_SPLITS), step: '1', inputmode: 'numeric',
    class: 'mono count-input', value: n ? String(n) : '', placeholder: '0', 'aria-describedby': 'race-nsplits-help',
  });
  // focus stays on the control that was used, so "+" can be pressed again from the keyboard
  const applyCount = async (v, focusKey = 'race-nsplits') => {
    const k = Number(str(v).trim());
    if (!Number.isInteger(k) || k < 1 || k > MAX_SPLITS) {
      if (str(v).trim()) toast(`Type a number of splits from 1 to ${MAX_SPLITS}.`, 'warn');
      countInput.value = n ? String(n) : '';
      return;
    }
    if (k === dr.splits.length) return;
    const going = dr.splits.slice(k);
    const lost = going.reduce((t, s) => t + liveSplitCrossings(id, s.id), 0);
    if (lost) {
      const ok = await confirmDialog({
        title: `Remove ${listText(going.map((s, j) => s.name || `split ${k + j + 1}`))}?`,
        body: [`${going.length === 1 ? 'It has' : 'They have'} ${plural(lost, 'crossing')}. When you save, those passes no longer count as splits ("Extra pass").`,
          `TrackScore and Karmarush put splits in columns by laps to go, so the splits already sent are then in the wrong columns. ${splitsHint(dr.splits.slice(0, k))} Then resend this race's splits.`],
        confirm: `Use ${plural(k, 'split')}`,
        danger: true,
      });
      if (!ok) {
        countInput.value = n ? String(n) : '';
        return;
      }
    }
    dr.splits = setSplitCount(dr.splits, k, newKey);
    // at the edge of the range the button is disabled: focus goes to the number instead
    S.focusAfter = (focusKey === 'race-nsplits-less' && k <= 1) || (focusKey === 'race-nsplits-more' && k >= MAX_SPLITS) ? 'race-nsplits' : focusKey;
    restructure(d);
  };
  countInput.addEventListener('change', () => applyCount(countInput.value));
  // Enter applies the number instead of saving the whole form
  countInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyCount(countInput.value);
    }
  });

  // the RR12 port this race reads from (DESIGN 9.15 L3)
  const ports = inputPorts(st);
  const activeOn = (p) => other.find((r) => r.active !== false && portNum(r.inputPort) === p);
  const portOptions = ports.map((p) => {
    const o = activeOn(p);
    return { value: String(p), label: `Port ${p}${o ? ` (${o.name || 'another race'} is Active on it)` : ''}` };
  });
  if (dr.inputPort !== '' && !ports.includes(Number(dr.inputPort))) {
    portOptions.push({ value: dr.inputPort, label: `Port ${dr.inputPort} (Split Relay doesn't listen on it)` });
  }
  // "none" is for a race fed by contests only (SR lines); LapTime lines always need a port
  if (showContests || dr.inputPort === '') portOptions.push({ value: '', label: 'None: only reads that name its contests' });
  const clash = portConflict(dr, st.config.races, id);
  const canSwitch = !!clash && !d.isNew && saved?.active === false && portNum(saved.inputPort) === portNum(dr.inputPort);

  const set = (k) => (v) => { dr[k] = v; changed(d); };
  // event, round and heat rebuild once typing pauses, so the "another race uses this event" note stays current
  const setEvent = (k) => (v) => { dr[k] = v; restructureSoon(d); };
  const twins = sameEventRaces(dr, st.config.races, id);
  const lynxName = str(rv?.lynxName).trim();
  const firstName = dr.splits[0]?.name || defaultSplitName(0);
  const secondName = dr.splits[1]?.name || defaultSplitName(1);
  const [cntBtn, cntBody] = moreParts('race-nsplits', showSources
    ? 'One split per split point on the course, before the finish. Each split gets its timing points (the A and B mats).'
    : [`How many times a runner passes the split mats before the finish. The A and B mats together count once (reads within ${tagWindow} s).`,
      n ? `RR12 sends only the bib and the time, so Split Relay counts each runner's passes: the first pass is ${firstName}${n > 1 ? `, the next ${secondName}, and so on` : ''}. A pass after the last split is ignored (“Extra pass”): a split is never sent with laps to go 0, which means the finish.` : ''].filter(Boolean),
  'How splits are counted');

  return h('form', { class: 'form', novalidate: true, 'aria-label': 'Race settings', onsubmit: (e) => { e.preventDefault(); saveRace(id); } },
    h('div', { class: 'card-head' }, h('h2', {}, 'Race settings')),
    h('div', { class: 'field-row' },
      field({ id: 'race-name', label: 'Name', cls: 'grow',
        help: lynxName ? `FinishLynx calls it “${lynxName}”.` : "Exactly as FinishLynx's event name.",
        control: textInput('race-name', dr.name, set('name'), { help: true, attrs: { placeholder: 'e.g. Girls Varsity 5K' } }) }),
      // "Active" is the word every warning, dialog and the Help page use (DESIGN 9.2 R1); its change rebuilds the form
      // so a port clash is said at once
      checkField({ id: 'race-active', label: 'Active', toggle: true, checked: dr.active, onChange: (v) => { dr.active = v; d.autoActive = false; restructure(d); },
        more: 'Turn it off when the race is over: it then sends nothing and keeps exactly the reads it has, whatever you change in other races, so its merged .lif keeps its splits. Reads that would go to it wait, not used, and turning Active on uses them all. One RR12 port feeds one Active race at a time.' })),
    h('div', { class: 'field-row' },
      field({ id: 'race-en', label: 'Event', cls: 'narrow', control: textInput('race-en', dr.eventNumber, setEvent('eventNumber'), { attrs: { inputmode: 'numeric', 'aria-invalid': twins.length ? 'true' : null } }),
        more: 'Event, round and heat exactly as FinishLynx has them. They go in every packet and match this race to its FinishLynx .lif file.' }),
      field({ id: 'race-round', label: 'Round', cls: 'narrow', control: textInput('race-round', dr.round, setEvent('round'), { attrs: { inputmode: 'numeric' } }) }),
      field({ id: 'race-heat', label: 'Heat', cls: 'narrow', control: textInput('race-heat', dr.heat, setEvent('heat'), { attrs: { inputmode: 'numeric' } }) }),
      field({ id: 'race-distance', label: 'Distance', cls: 'narrow', control: textInput('race-distance', dr.distance, set('distance'), { attrs: { placeholder: 'optional' } }) })),
    twins.length ? h('p', { class: 'field-error', role: 'alert' },
      `${listText(twins.map((r) => r.name || '(no name)'))} already ${twins.length === 1 ? 'uses' : 'use'} ${eventLabel(dr)}. Each race needs its own event, round and heat, as FinishLynx has them.`)
      : d.isNew && !str(dr.eventNumber).trim() ? h('p', { class: 'help' }, 'Type the event number FinishLynx has for this race.') : null,

    h('div', { class: 'field-row' },
      field({
        id: 'race-port', label: 'RR12 port', cls: 'port-field',
        help: 'The port of the RR12 exporter that sends this race.',
        more: ports.length > 1
          ? 'Its destination in RR12. Races that run at the same time each need their own port and exporter.'
          : 'For two races at the same time, add a second port on the Inputs page (a second exporter in RR12, filtered to that race).',
        control: selectInput('race-port', dr.inputPort, portOptions, (v) => {
          dr.inputPort = v;
          // a new race starts not Active only because its port already feeds an Active race: on a free port (the second
          // exporter's, for an overlapping race) it can be Active. A tick or untick by the operator is never changed.
          if (d.isNew && d.autoActive) dr.active = !portConflict(dr, st.config.races, id);
          restructure(d);
        }, true),
      }),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', { for: 'race-nsplits', id: 'race-splits-legend', tabindex: '-1' }, 'Number of splits'), cntBtn),
        h('div', { class: 'stepper' },
          // Count from the draft, not from n: a second quick click can land on this button before the form is redrawn,
          // and n would still be the count from the last drawing (three fast clicks made 1 split, not 3).
          h('button', { type: 'button', class: 'btn icon-btn', 'data-fk': 'race-nsplits-less', disabled: n <= 1, 'aria-label': 'One split fewer', onclick: () => applyCount(Math.max(1, dr.splits.length - 1), 'race-nsplits-less') }, '−'),
          countInput,
          h('button', { type: 'button', class: 'btn icon-btn', 'data-fk': 'race-nsplits-more', disabled: n >= MAX_SPLITS, 'aria-label': 'One split more', onclick: () => applyCount(Math.min(MAX_SPLITS, dr.splits.length + 1), 'race-nsplits-more') }, '+')),
        h('p', { class: 'help', id: 'race-nsplits-help' }, n ? splitsHint(dr.splits) : 'Split passes before the finish. TrackScore and Karmarush need it.'),
        cntBody),
      // a race that is created as the gun goes can get its gun time in the same step
      d.isNew ? field({ id: 'race-newgun', label: 'Gun time', cls: 'mid', help: 'Optional: type it now, or set it once the race is saved.',
        control: h('input', { id: 'race-newgun', 'data-fk': 'race-newgun', type: 'text', class: 'mono', value: d.newGun || '', placeholder: '10:00:00.000', inputmode: 'decimal',
          autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'race-newgun-help', oninput: (e) => { d.newGun = e.target.value; } }) }) : null),
    clash ? h('div', { class: 'msg tone-warn', role: 'alert' },
      h('p', {}, portConflictText(portNum(dr.inputPort), clash)),
      canSwitch
        ? h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small primary', 'data-fk': 'race-port-switch', onclick: (e) => switchToRace(id, e.currentTarget) }, `Switch to ${saved.name || 'this race'}…`),
          h('span', { class: 'help inline' }, `Unticks ${clash.name || 'the other race'} (it keeps its reads) and makes this race Active.`))
        : h('p', { class: 'help' }, d.isNew
          ? 'Turn off Active to add it now, and press “Switch to …” on the Dashboard when it runs.'
          : 'Turn off Active here, or choose another port.')) : null,

    columnsNote ? h('p', { class: 'msg tone-warn' }, columnsNote) : null,
    n ? h('ol', { class: 'split-list', 'aria-label': 'Splits, in course order' }, dr.splits.map(splitRow)) : null,
    // 9.26: a split that is only counted is often a mat a little after another one: the tag filter must be shorter than
    // the fastest runner's time between them, or it merges that runner's two passes into one
    // (a quiet line; amber once the tag filter is longer than a fast runner needs for 200 m: at 45 s every runner of the
    // 2026-11-13 men's race would have had the second mat's read merged away)
    quietCount ? h('p', { class: closeMatsRisk(tagWindow) ? 'msg tone-warn close-mats' : 'help close-mats', id: 'race-close-mats' }, closeMatsText(tagWindow), ' ',
      h('a', { href: '#settings/filter', 'data-fk': 'race-tagfilter' }, 'Tag filter settings')) : null,

    h('details', { class: 'fold', open: advanced, 'data-fk': 'race-adv', ontoggle: (e) => { S.raceAdvanced.set(d.key, e.currentTarget.open); } },
      h('summary', {}, 'Advanced',
        h('span', { class: 'summary-note' }, [
          hasEarliest ? `earliest times set: ${listText(dr.splits.filter((s) => str(s.earliest).trim()).map((s) => `${s.name || 'a split'} from ${str(s.earliest).trim()}`))}` : 'earliest time per split',
          showContests ? 'contests' : '', showSources ? 'finish timing points' : '',
        ].filter(Boolean).join(' · '))),
      h('div', { class: 'stack', style: 'padding-top:8px' },
        n ? h('fieldset', { class: 'group' },
          h('legend', {}, 'Earliest race time per split'),
          h('p', { class: 'help', id: 'race-early-help' }, 'Optional, like 8:00. A pass at or after it counts as that split even if the runner missed an earlier mat.'),
          h('div', { class: 'field-row' }, dr.splits.map((s, i) => {
            const earlyId = `race-early-${keyOf(s)}`;
            return field({ id: earlyId, label: s.name || defaultSplitName(i), cls: 'narrow',
              control: h('input', { id: earlyId, 'data-fk': earlyId, type: 'text', class: 'mono', value: s.earliest, placeholder: 'm:ss', autocomplete: 'off', spellcheck: 'false', inputmode: 'decimal',
                'aria-describedby': 'race-early-help', oninput: (e) => { s.earliest = e.target.value; changed(d); } }) });
          })),
          h('p', { class: 'help' }, 'A pass before the next split\'s earliest time is ignored (“Too early for this split”). Leave it empty where runners can\'t miss a mat.')) : null,

        showContests ? h('fieldset', { class: 'group' },
          h('legend', {}, 'Contests (SR lines)'),
          h('p', { class: 'help' }, dr.contests.length
            ? 'Reads from these RR12 contests belong to this race.'
            : 'None: while Active, it takes the reads of every contest no other race lists.'),
          chipEditor({
            d, key: 'contests', items: dr.contests, removeLabel: 'Remove contest', seenMap: seenContest,
            onRemove: (k) => dr.contests.splice(k, 1),
            onAdd: (name) => {
              if (dr.contests.some((x) => norm(x) === norm(name))) return `“${name}” is already in this race.`;
              dr.contests.push(name);
              return null;
            },
            options: contestOptions, optionsTitle: 'Contests seen from RR12:',
            emptyOptions: 'No other contests seen from RR12 yet. Type the contest name exactly as RR12 has it.',
            inputLabel: 'Add a contest', placeholder: 'Contest name',
          })) : null,

        showSources ? h('fieldset', { class: 'group' },
          h('legend', {}, 'Finish timing points (optional)'),
          h('p', { class: 'help' }, finishHelp(S.state?.config?.filter)),
          chipEditor({
            d, key: 'finish', items: dr.finishSources, removeLabel: 'Remove finish timing point', seenMap: seenLoc,
            onRemove: (k) => dr.finishSources.splice(k, 1), onAdd: addSource(dr.finishSources), options: locationOptions('fin'),
            optionsTitle: 'Timing point names seen from RR12, not used in this race yet:',
            emptyOptions: 'No unused timing point names seen yet. Type the finish timing point name as RR12 has it.',
            inputLabel: 'Add a finish timing point', placeholder: 'Timing point name',
          })) : null)),

    formFooter(d, {
      saveLabel: d.isNew ? 'Create race' : 'Save race',
      onRevert: () => {
        if (d.isNew) {
          S.drafts.delete(d.key);
          S.adder = null;
          go('#races');
          return;
        }
        reloadDraft(d, configRace(S.state, id));
        S.adder = null;
        scheduleRender();
      },
    }));
}

/**
 * Ask Split Relay what saving this race would do to the reads so far, and let the operator confirm it when anything
 * that runs changes. A change Split Relay refuses shows its message in the form, as the save would.
 * @returns {Promise<boolean>} whether to go on with the save
 */
async function confirmRacePlan(d, body, isNew) {
  let plan;
  try {
    plan = await api('POST', '/api/races/preview', body);
  } catch (err) {
    if (err?.status >= 400 && err.status < 500) {
      d.errors = [err.message];
      d.version++;
      S.focusAfter = d.key + '-errors';
      scheduleRender();
      return false;
    }
    // Split Relay could not work it out (not reachable): the save itself will say so
    return true;
  }
  const text = raceSaveText(plan, d.draft.name, isNew);
  return !text || confirmDialog({ title: text.title, body: text.body, confirm: isNew ? 'Add race' : 'Save race' });
}

async function saveRace(id) {
  const d = raceDraft(id);
  S.adder = null;
  if (d.isNew) {
    const before = new Set(arr(S.state.config.races).map((r) => r.id));
    const gunText = str(d.newGun).trim();
    const errs = validateRaceDraft(d.draft, S.state.config.races);
    if (gunText && parseGunText(gunText) == null) errs.push("The gun time isn't a time of day. Type it like 10:00:00 or 10:00:00.000, or leave it empty.");
    if (errs.length) {
      d.errors = errs;
      d.version++;
      S.focusAfter = d.key + '-errors';
      scheduleRender();
      return;
    }
    // A new race can take reads that are in another race or waiting (DESIGN 9.2): said before, not found out on the
    // scoreboard.
    if (!(await confirmRacePlan(d, { race: raceBody(d.draft) }, true))) return;
    d.saving = true;
    updateFormStatus(d);
    try {
      const st = await api('POST', '/api/races', raceBody(d.draft));
      applyState(st);
      const created = arr(st.config?.races).find((r) => !before.has(r.id));
      S.drafts.delete(d.key);
      if (created) {
        const nd = raceDraft(created.id, st);
        nd.savedAt = Date.now();
        setTimeout(scheduleRender, 6100);
        // the gun typed in the form, through the gun's own endpoint (a new race has nothing a gun could move)
        let gunSet = false;
        if (gunText) {
          const g = await act(() => api('POST', `/api/races/${enc(created.id)}/gun`, { gun: gunText }), null);
          if (g) {
            applyState(g);
            gunSet = true;
          }
        }
        const fromSetup = S.fromSetup === 'race';
        S.fromSetup = '';
        toast(`${created.name} created${gunSet ? `, gun ${viewOf(S.state, created.id)?.gunText || gunText}` : '. Set its gun time when the race starts'}.${fromSetup ? ` ${setupProgressText(S.state)}` : ''}`, 'ok', undefined,
          fromSetup && setupShown(S.state) ? { action: { label: 'Back to setup', run: () => go('#live') } } : {});
        go('#races/' + enc(created.id));
      } else go('#races');
    } catch (err) {
      d.errors = [err.message];
      d.version++;
      S.focusAfter = d.key + '-errors';
    } finally {
      d.saving = false;
      scheduleRender();
    }
    return;
  }
  const valid = !validateRaceDraft(d.draft, S.state.config.races, id).length;
  // DESIGN 9.15 L6: TrackScore and Karmarush file a split by laps to go, so a new number or order of splits puts the
  // splits already sent in the wrong columns. Said before the save, and the resend prompt says it again after.
  const saved = configRace(S.state, id);
  // (9.26: by the splits that are sent: switching a split's Send off or on is a new number of splits for the boards)
  const { was, now, reordered, recount, swapped } = splitsChange(saved?.splits, d.draft.splits);
  let columns = null;
  if (valid && crossingCount(viewOf(S.state, id)) > 0 && (was !== now || reordered || recount)) {
    const name = str(d.draft.name).trim() || 'this race';
    const someQuiet = arr(saved?.splits).some(notSent) || d.draft.splits.some(notSent);
    const ok = await confirmDialog({
      title: was !== now ? (someQuiet ? `Send ${plural(now, 'split')} of ${name}?` : `Give ${name} ${plural(now, 'split')}?`)
        : swapped ? `Send other splits of ${name}?` : reordered ? `Change the order of ${name}'s splits?` : `Count ${name}'s passes again?`,
      body: [columnsChangeText(was, now, reordered, recount, swapped)],
      confirm: 'Save race',
    });
    if (!ok) return;
    if (was !== now || reordered) columns = { was, now, reordered, at: Date.now() };
  }
  // Reads that would move because the contests or Active changed: said before, not found out on the scoreboard
  // (DESIGN 9.2). A draft the form refuses gets its errors from saveDraft, as before.
  if (valid && !(await confirmRacePlan(d, { id, race: raceBody(d.draft, configRace(S.state, id)) }, false))) return;
  const st = await saveDraft(d, {
    validate: (draft) => validateRaceDraft(draft, S.state.config.races, id),
    // the splits' pause as Split Relay has it at this moment (it may have changed while the dialog was open)
    send: (draft) => api('PUT', `/api/races/${enc(id)}`, raceBody(draft, configRace(S.state, id))),
    server: (s) => configRace(s, id),
  });
  if (st && columns) {
    S.columnChanges.set(id, columns);
    scheduleRender();
  }
}

/* ============================================================================================================ */
/* Outputs tab                                                                                                  */

const OUTPUT_DEFAULTS = { name: '', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: 5555, script: '', stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' };
const TRACKSCORE_PRESET = { ...OUTPUT_DEFAULTS, name: 'TrackScore', script: 'C:\\Lynx\\XCScore.lss' };

const MODE_INFO = {
  'tcp-client': { label: 'Connect to a program (TCP), for TrackScore and live results', short: 'Sends to' },
  'tcp-server': { label: 'Let programs connect to Split Relay (TCP server)', short: 'Listens on' },
  udp: { label: 'Send UDP packets', short: 'UDP to' },
};

function outputDraft(id, st = S.state) {
  if (id === NEW) return S.drafts.get('out:' + NEW) || draftFor('out:' + NEW, outputToDraft, OUTPUT_DEFAULTS, true);
  return draftFor('out:' + id, outputToDraft, configOutput(st, id));
}

function startNewOutput(preset) {
  const existing = S.drafts.get('out:' + NEW);
  if (existing && preset) S.drafts.delete('out:' + NEW);
  if (!existing || preset) draftFor('out:' + NEW, outputToDraft, preset || OUTPUT_DEFAULTS, true);
  go('#outputs/new');
}

/** The Karmarush live results: a TCP client to the live-results computer, with this meet's MID typed in. */
const KARMARUSH_PRESET = { ...OUTPUT_DEFAULTS, name: 'Karmarush live results', host: '', port: '', script: 'C:\\Lynx\\Karmarush-Track.lss' };

function renderOutputsTab() {
  const st = S.state;
  const outs = arr(st.config.outputs);
  let sel = S.route.id;
  if (sel === 'new') {
    sel = NEW;
    outputDraft(NEW);
  } else if (!outs.some((o) => o.id === sel)) sel = '';
  guard(EL.outCards, () => {
    const sig = JSON.stringify([sel, outs, [...S.downSince].map(([k, t]) => [k, Math.floor((nowMs() - t) / 15000)]), arr(st.outputs).map((s) => ({ ...s, lastSentAt: !!s.lastSentAt })), arr(st.config.races).map((r) => [r.id, r.name]),
      [...S.drafts.keys()].filter((k) => k.startsWith('out:')).map((k) => [k, isDirty(S.drafts.get(k))]), [...S.more].filter((k) => k.startsWith('oc'))]);
    paintSig(EL.outCards, sig, () => buildOutputCards(st, outs, sel));
  });
  guard(EL.drawerBody, () => {
    if (!sel) {
      if (S.editorOut !== '') {
        S.editorOut = '';
        EL.drawerBody.replaceChildren();
      }
      EL.drawer.hidden = true;
      return;
    }
    if (S.editorOut !== sel) {
      const prev = S.drafts.get('out:' + S.editorOut);
      if (prev && !prev.isNew && !isDirty(prev)) S.drafts.delete(prev.key);
      EL.drawerBody.replaceChildren((S.oe = h('div')));
      EL.drawerBody.scrollTop = 0;
      S.editorOut = sel;
    }
    EL.drawer.hidden = false;
    EL.drawerBack.hidden = !(S.fromSetup === 'outputs' && setupShown(st));
    const d = outputDraft(sel, st);
    const title = d.isNew ? (str(d.draft.name).trim() ? `New output: ${str(d.draft.name).trim()}` : 'New output') : `Edit ${configOutput(st, sel)?.name || 'output'}`;
    if (EL.drawerTitle.textContent !== title) EL.drawerTitle.textContent = title;
    const s = sel === NEW ? null : outputStatus(st, sel);
    // The MID field belongs to live-results scripts. Before a new output is saved the script isn't loaded yet, so
    // any picked script that isn't TrackScore's shows it (blank keeps the script's own MID).
    const picked = str(d.draft.script).trim();
    const showMid = !!(s?.scriptInfo?.mid || str(d.draft.mid).trim()
      || ((d.isNew || !s?.scriptInfo) && picked && !/xcscore/i.test(picked)));
    // TrackScore wording follows the script: the form rebuilds when the kind of output changes
    const tsLike = isTrackScoreLike({ script: picked, mid: d.draft.mid }, d.isNew ? null : s);
    if (d.midShown !== showMid || d.tsLike !== tsLike) {
      d.midShown = showMid;
      d.tsLike = tsLike;
      d.version++;
    }
    syncForm(S.oe, d, () => buildOutputForm(sel, d));
    const slot = S.oe.querySelector('[data-slot="script"]');
    if (slot) paintSig(slot, JSON.stringify([s?.scriptOk, s?.scriptError, s?.scriptInfo, d.draft.script, d.base, d.scriptCheck, configOutput(st, sel)?.mid]), () => scriptStatus(sel, s, d));
  });
}

/** Close the output editor (the draft stays: the card says "Unsaved" until it is saved or reverted). */
function closeDrawer() {
  const was = S.editorOut;
  go('#outputs');
  if (was && was !== NEW) focusKey('oc-edit-' + was);
}

function buildOutputCards(st, outs, sel) {
  if (!outs.length) {
    return h('div', { class: 'card empty-state' },
      h('h2', {}, 'No outputs yet'),
      h('p', {}, 'Nothing is being sent. An output is one program that gets the splits as FinishLynx scoreboard packets: TrackScore, the live results, a scoreboard.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => startNewOutput(TRACKSCORE_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'TrackScore'),
        h('button', { type: 'button', class: 'btn', onclick: () => startNewOutput(KARMARUSH_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Karmarush live results'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => startNewOutput(null) }, 'Other output')));
  }
  return h('div', { class: 'out-cards' }, outs.map((o) => outputCard(st, o, outputStatus(st, o.id) || {}, sel)));
}

function racesLabel(st, o) {
  if (!arr(o.races).length) return 'All races';
  const names = arr(o.races).map((id) => configRace(st, id)?.name).filter(Boolean);
  return names.length ? listText(names) : 'No race (the chosen races were deleted)';
}

function outputCard(st, o, s, sel) {
  const pill = outputPill(o, s);
  const titleId = 'oc-' + o.id;
  const href = '#outputs/' + enc(o.id);
  const d = S.drafts.get('out:' + o.id);
  const refused = Number(s.refused) || 0;
  const [rfBtn, rfBody] = moreParts('oc-rf-' + o.id, refused ? refusedText(o.name || 'This output', refused) + (s.refusedReason ? ` The last one: ${s.refusedReason}` : '') : '', 'Why');
  const stat = (label, value, cls = '') => h('div', {}, h('dt', {}, label), h('dd', { class: cls || null }, value));
  const light = lightOf(st, o);
  return h('article', { class: 'card out-card' + (o.id === sel ? ' current' : ''), 'aria-labelledby': titleId },
    h('div', { class: 'card-head' },
      h('h2', { id: titleId }, o.name || '(no name)'),
      h('span', { class: `state-chip tone-${light.tone}`, title: light.title || pill.text }, h('span', { class: 'dot', 'aria-hidden': 'true' }), outputStateWord(o, s),
        light.down >= 5000 ? h('span', { class: 'state-age' }, ` · ${formatDuration(light.down)}`) : null)),
    h('div', {},
      h('div', { class: 'out-target' }, `${MODE_INFO[o.mode]?.short || 'Sends to'} ${s.target || `${o.host || '0.0.0.0'}:${o.port}`}`),
      h('dl', { class: 'kv', style: 'margin-top:8px' },
        h('dt', {}, 'Script'), h('dd', {}, `${baseName(o.script) || 'none'} · ${o.stage === 'started' ? 'Started' : 'Results'} sections`),
        h('dt', {}, 'Races'), h('dd', {}, racesLabel(st, o)),
        h('dt', {}, 'Packets'), h('dd', {}, `Event number: ${o.eventNumber === 'blank' ? 'blank' : "the race's"} · ${o.precision ?? 3} decimals${str(o.mid) ? ` · MID ${o.mid}` : ''}`))),
    h('dl', { class: 'out-stats' },
      stat('Sent', fmtInt(s.sent || 0)),
      stat('Waiting', fmtInt(s.queued || 0), (s.queued || 0) ? 'tone-text-warn' : ''),
      o.mode === 'tcp-server' ? stat('Programs', fmtInt(s.clients || 0))
        : stat('Refused', fmtInt(refused), refused ? 'tone-text-bad' : ''),
      stat('Last sent', agoSpan(s.lastSentAt))),
    refused ? h('div', { class: 'msg tone-bad' }, `${plural(refused, 'split packet')} refused (laps to go or a finish time).`, rfBtn, rfBody) : null,
    s.scriptOk === false ? h('p', { class: 'msg tone-bad' }, `Script problem: ${s.scriptError || 'it could not be loaded'}. Nothing is sent until it is fixed.`) : null,
    s.lastError ? h('p', { class: 'msg tone-warn' }, `Last problem: ${s.lastError}`) : null,
    behindText(s) ? h('p', { class: 'msg tone-warn' }, `${behindText(s)}: the oldest has waited ${Math.round(Number(s.lagSec))} s. The receiving program or the network is slow.`) : null,
    isDirty(d) ? h('p', { class: 'msg tone-warn' }, 'Unsaved changes in the editor.') : null,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'oc-prev-' + o.id, onclick: (e) => previewOutput(o.id, e.currentTarget) }, 'Preview packet'),
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'oc-rec-' + o.id, disabled: o.enabled === false, onclick: (e) => reconnectOutput(o.id, e.currentTarget) },
        h('span', { class: 'i i-refresh', 'aria-hidden': 'true' }), 'Reconnect'),
      h('button', { type: 'button', class: 'btn small', 'data-fk': 'oc-tog-' + o.id, onclick: (e) => toggleOutput(o, e.currentTarget) }, o.enabled === false ? 'Turn on' : 'Turn off'),
      h('a', { class: 'btn small push-right' + (o.id === sel ? ' current' : ''), href, 'data-fk': 'oc-edit-' + o.id, 'aria-current': o.id === sel ? 'true' : null }, h('span', { class: 'i i-edit', 'aria-hidden': 'true' }), o.id === sel ? 'Editing' : 'Edit')));
}

/**
 * Look the draft's script up on the Split Relay PC (GET /api/files) and remember the answer on the draft, so the
 * form can say "not found" before the operator saves a typo.
 * @returns {Promise<{ ok: boolean, why: string } | null>} null when it can't be checked from here
 */
async function checkDraftScript(d) {
  const path = str(d.draft.script).trim();
  if (!path) {
    d.scriptCheck = null;
    return null;
  }
  if (d.scriptCheck && d.scriptCheck.path === path && !d.scriptCheck.checking) return d.scriptCheck;
  d.scriptCheck = { path, checking: true, ok: false, why: '' };
  scheduleRender();
  let result;
  try {
    const r = await api('GET', '/api/files?' + new URLSearchParams({ dir: path, ext: '.lss' }).toString());
    result = scriptPathCheck(path, r);
  } catch (err) {
    // view-only (403) or Split Relay gone (0): it can't be checked, the server checks it on save anyway
    result = err && (err.status === 403 || err.status === 0) ? null : scriptPathCheck(path, null, err && err.message);
  }
  if (str(d.draft.script).trim() !== path) return null;
  d.scriptCheck = result ? { path, checking: false, ...result } : null;
  scheduleRender();
  return result;
}

async function reconnectOutput(id, btn) {
  const st = await act(() => api('POST', `/api/outputs/${enc(id)}/reconnect`), btn);
  if (!st) return;
  applyState(st);
  toast(`Reconnecting ${configOutput(st, id)?.name || 'output'}…`, 'info');
}

async function toggleOutput(o, btn) {
  if (o.enabled !== false) {
    const ok = await confirmDialog({
      title: `Turn off ${o.name}?`,
      body: [`Split Relay stops sending splits to ${o.name} until you turn it on again. When you turn it back on, it gets the splits it missed in the races that are taking reads, except for runners who have finished.`],
      confirm: 'Turn off',
    });
    if (!ok) return;
  }
  const st = await act(() => api('PUT', `/api/outputs/${enc(o.id)}`, { enabled: o.enabled === false }), btn);
  if (!st) return;
  applyState(st);
  toast(`${o.name} turned ${o.enabled === false ? 'on' : 'off'}.`);
}

function deleteOutput(id, btn) {
  return once('out-del:' + id, btn, async () => {
    const o = configOutput(S.state, id);
    const here = () => !!configOutput(S.state, id);
    const gone = `${o?.name || 'The output'} is already deleted.`;
    if (!o) return toast(gone, 'info');
    const ok = await confirmDialog({
      title: `Delete ${o.name || 'this output'}?`,
      body: [`Split Relay stops sending to ${o.host || '0.0.0.0'}:${o.port} and forgets its settings. This can't be undone.`],
      confirm: 'Delete output',
      danger: true,
      alive: here,
      gone: `${o.name || 'The output'} was deleted meanwhile (another window?).`,
    });
    if (!ok || !here()) return;
    const st = await act(() => api('DELETE', `/api/outputs/${enc(id)}`), btn);
    if (!st) return;
    S.drafts.delete('out:' + id);
    applyState(st);
    toast(`${o.name || 'Output'} deleted.`);
    go('#outputs');
  });
}

function scriptStatus(id, s, d) {
  const changedPath = !d.isNew && str(d.draft.script).trim() !== str(JSON.parse(d.base || '{}').script).trim();
  if (d.isNew || changedPath) {
    const c = d.scriptCheck;
    if (c && c.path === str(d.draft.script).trim()) {
      if (c.checking) return h('p', { class: 'help' }, 'Looking for the script…');
      if (c.ok) return h('p', { class: 'msg tone-ok' }, '✓ Script file found. It is loaded when you save.');
      return h('p', { class: 'msg tone-bad' }, `${c.why} Fix the path or press Browse…`);
    }
    return h('p', { class: 'help' }, 'The script is checked when you save.');
  }
  if (!s) return h('p', { class: 'help' }, 'Checking the script…');
  if (s.scriptOk === false) {
    return h('p', { class: 'msg tone-bad' }, `This script can't be used: ${s.scriptError || 'it could not be loaded'}. Nothing is sent to this output until it is fixed; the splits it misses are sent by themselves once the script works.`);
  }
  const info = s.scriptInfo || {};
  const sections = arr(info.sections).map((x) => (typeof x === 'string' ? x : `${x.name}${x.lines != null ? ` (${x.lines})` : ''}`));
  const mid = midText(info.mid, configOutput(S.state, id)?.mid);
  return h('p', { class: 'msg tone-ok' }, '✓ Script loaded',
    sections.length ? `. Sections: ${sections.join(', ')}` : '',
    mid ? `. ${mid}` : '.');
}

function buildOutputForm(id, d) {
  const st = S.state;
  const dr = d.draft;
  const s = id === NEW ? null : outputStatus(st, id);
  const set = (k) => (v) => { dr[k] = v; changed(d); };
  const races = arr(st.config.races);
  const isServer = dr.mode === 'tcp-server';
  const scriptMid = s?.scriptInfo?.mid;
  const tsLike = d.tsLike ?? isTrackScoreLike({ script: dr.script, mid: dr.mid }, d.isNew ? null : s);
  const isXc = /xcscore/i.test(str(dr.script));
  const browseScript = async () => {
    const p = await browse({ title: 'Choose the .lss script', pick: 'file', ext: '.lss', start: dirName(dr.script) });
    if (p) {
      dr.script = p;
      S.focusAfter = 'out-script';
      restructure(d);
      checkDraftScript(d);
    }
  };
  const scriptInput = textInput('out-script', dr.script, set('script'), { attrs: { class: 'code', placeholder: 'C:\\Lynx\\XCScore.lss' } });
  scriptInput.addEventListener('change', () => checkDraftScript(d));
  return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveOutput(id); } },
    h('div', { class: 'field-row' },
      field({ id: 'out-name', label: 'Name', cls: 'grow', control: textInput('out-name', dr.name, set('name'), { attrs: { placeholder: 'e.g. TrackScore' } }) }),
      checkField({ id: 'out-enabled', label: 'On', toggle: true, checked: dr.enabled, onChange: (v) => { dr.enabled = v; changed(d); } })),
    field({ id: 'out-mode', label: 'How to send', control: selectInput('out-mode', dr.mode, Object.entries(MODE_INFO).map(([value, m]) => ({ value, label: m.label })), (v) => { dr.mode = v; restructure(d); }) }),
    h('div', { class: 'field-row' },
      field({
        id: 'out-host', label: isServer ? 'Listen on address' : 'IP address', cls: 'grow',
        help: isServer ? '0.0.0.0 (or blank): every network card.' : '127.0.0.1 is this PC.',
        control: textInput('out-host', dr.host, set('host'), { help: true, attrs: { class: 'mono', placeholder: isServer ? '0.0.0.0' : '127.0.0.1' } }),
      }),
      field({ id: 'out-port', label: 'Port', cls: 'narrow', help: tsLike ? 'TrackScore: 5555' : 'Its listening port.', control: textInput('out-port', dr.port, set('port'), { help: true, attrs: { class: 'mono', inputmode: 'numeric' } }) })),
    h('div', { class: 'field' },
      h('div', { class: 'label-row' }, h('label', { for: 'out-script' }, 'Scoreboard script (.lss)')),
      h('div', { class: 'input-with-button' },
        scriptInput,
        h('button', { type: 'button', class: 'btn', onclick: browseScript }, 'Browse…')),
      h('div', { 'data-slot': 'script' })),
    h('div', { class: 'field-row' },
      field({
        id: 'out-stage', label: 'Script sections', cls: 'mid',
        help: isXc ? 'Results: its Started sections are broken.' : 'Results suits most scripts.',
        more: isXc ? "XCScore.lss's Started sections produce broken JSON, so use Results unless you know the script needs Started. Press Preview packet after saving to check what is sent." : 'Press Preview packet after saving to check what is sent.',
        control: selectInput('out-stage', dr.stage, [{ value: 'results', label: 'Results (recommended)' }, { value: 'started', label: 'Started' }], set('stage'), true),
      }),
      field({
        id: 'out-precision', label: 'Decimals', cls: 'mid', help: 'Rounded up, like FinishLynx.',
        control: selectInput('out-precision', dr.precision, [{ value: '1', label: '1  (5:12.4)' }, { value: '2', label: '2  (5:12.35)' }, { value: '3', label: '3  (5:12.345)' }], set('precision'), true),
      })),
    h('fieldset', { class: 'field radios' },
      h('legend', {}, 'Races to send'),
      h('label', { class: 'radio-label' },
        h('input', { type: 'radio', name: 'out-races', 'data-fk': 'out-races-all', checked: dr.allRaces, onchange: () => { dr.allRaces = true; restructure(d); } }),
        h('span', {}, 'All races')),
      h('label', { class: 'radio-label' },
        h('input', { type: 'radio', name: 'out-races', 'data-fk': 'out-races-some', checked: !dr.allRaces, onchange: () => { dr.allRaces = false; restructure(d); } }),
        h('span', {}, 'Only these races:')),
      !dr.allRaces ? h('div', { class: 'race-checks' }, races.length ? races.map((r) => h('label', { class: 'check-label' },
        h('input', { type: 'checkbox', 'data-fk': 'out-race-' + r.id, checked: dr.races.includes(r.id), onchange: (e) => {
          dr.races = e.target.checked ? [...dr.races.filter((x) => x !== r.id), r.id] : dr.races.filter((x) => x !== r.id);
          changed(d);
        } }), h('span', {}, r.name || '(no name)'))) : h('p', { class: 'help' }, 'No races yet.')) : null,
      h('p', { class: 'help' }, tsLike
        ? 'TrackScore shows one live race: while races overlap, give it only the race it shows.'
        : 'Live results can take every race.')),
    radioGroup({
      name: 'out-en', legend: 'Event number in the packets', value: dr.eventNumber, onChange: (v) => { dr.eventNumber = v; changed(d); },
      more: tsLike ? 'With the race\'s event number, TrackScore switches its live race to that event if it is in the meet program, and clears the race it was showing. Blank: TrackScore never switches race; splits go to whichever race is live there.' : '',
      options: tsLike ? [
        { value: 'race', label: "The race's event number", help: '(TrackScore switches to that race)' },
        { value: 'blank', label: 'Blank', help: '(TrackScore never switches race)' },
      ] : [
        { value: 'race', label: "The race's event number", help: '(recommended)' },
        { value: 'blank', label: 'Blank' },
      ],
    }),
    // DESIGN 9.24: for a receiver that can blank a cell; TrackScore can't today, so it is off unless ticked
    checkField({ id: 'out-clear', label: 'Send a clearing line when a split is taken back', checked: dr.clearLines === true, onChange: (v) => { dr.clearLines = v; changed(d); },
      help: CLEAR_LINE_HELP }),
    d.midShown ? field({
      id: 'out-mid', label: 'Live results meet ID (MID)', cls: 'mid',
      help: scriptMid ? `The script sends ${scriptMid}. Blank keeps it.` : "Replaces the script's MID. Blank keeps it.",
      control: textInput('out-mid', dr.mid, set('mid'), { help: true, attrs: { class: 'mono', inputmode: 'numeric', placeholder: scriptMid || '' } }),
    }) : null,
    formFooter(d, {
      saveLabel: d.isNew ? 'Create output' : 'Save output',
      onRevert: () => {
        if (d.isNew) {
          S.drafts.delete(d.key);
          go('#outputs');
          return;
        }
        reloadDraft(d, configOutput(S.state, id));
        scheduleRender();
      },
      extra: d.isNew ? null : h('span', { class: 'row push-right' },
        h('button', { type: 'button', class: 'btn', 'data-fk': 'oe-preview', onclick: (e) => previewOutput(id, e.currentTarget) }, 'Preview packet'),
        h('button', { type: 'button', class: 'btn danger', 'data-fk': 'out-del-' + id, 'aria-disabled': busyAttr('out-del:' + id), onclick: (e) => deleteOutput(id, e.currentTarget) }, 'Delete…')),
    }));
}

/**
 * Before a new or changed script path is saved, make sure the file is there. A typo saved straight away stops the
 * output sending, so the operator decides with the facts in front of them.
 * @returns {Promise<boolean>} true to go on saving
 */
async function confirmScriptPath(d, id) {
  const path = str(d.draft.script).trim();
  const savedPath = d.isNew ? null : str(configOutput(S.state, id)?.script).trim();
  if (!path || path === savedPath) return true;
  const c = await checkDraftScript(d);
  if (!c || c.ok) return true;
  const name = str(d.draft.name).trim() || 'This output';
  const ok = await confirmDialog({
    title: 'Script file not found',
    body: [
      c.why,
      `If you save it like this, ${name} sends nothing until the script path is fixed. The splits it misses are sent by themselves once the script works.`,
    ],
    confirm: 'Save anyway',
    cancel: 'Fix the path',
    danger: true,
  });
  if (!ok) S.focusAfter = 'out-script';
  scheduleRender();
  return ok;
}

async function saveOutput(id) {
  const d = outputDraft(id);
  if (!validateOutputDraft(d.draft).length && !(await confirmScriptPath(d, id))) {
    $('#out-script')?.focus();
    return;
  }
  if (d.isNew) {
    const before = new Set(arr(S.state.config.outputs).map((o) => o.id));
    const errs = validateOutputDraft(d.draft);
    if (errs.length) {
      d.errors = errs;
      d.version++;
      S.focusAfter = d.key + '-errors';
      scheduleRender();
      return;
    }
    d.saving = true;
    updateFormStatus(d);
    try {
      const st = await api('POST', '/api/outputs', outputBody(d.draft));
      applyState(st);
      const created = arr(st.config?.outputs).find((o) => !before.has(o.id));
      S.drafts.delete(d.key);
      if (created) {
        const nd = outputDraft(created.id, st);
        nd.savedAt = Date.now();
        setTimeout(scheduleRender, 6100);
        // opened from the setup checklist: the way back to it, with how far setup is
        const fromSetup = S.fromSetup === 'outputs';
        toast(`${created.name} added.${fromSetup ? ` ${setupProgressText(S.state)}` : ''}`, 'ok', undefined,
          fromSetup && setupShown(S.state) ? { action: { label: 'Back to setup', run: () => { S.fromSetup = ''; go('#live'); } } } : {});
        go('#outputs/' + enc(created.id));
      } else go('#outputs');
    } catch (err) {
      d.errors = [err.message];
      d.version++;
      S.focusAfter = d.key + '-errors';
    } finally {
      d.saving = false;
      scheduleRender();
    }
    return;
  }
  const saved = await saveDraft(d, {
    validate: validateOutputDraft,
    send: (draft) => api('PUT', `/api/outputs/${enc(id)}`, outputBody(draft)),
    server: (st) => configOutput(st, id),
  });
  // Save is disabled once saved: focus goes to the panel's heading (Esc still closes it), not to the page
  if (saved && !EL.drawer.hidden) requestAnimationFrame(() => EL.drawerTitle.focus({ preventScroll: true }));
}

/* ============================================================================================================ */
/* Settings page                                                                                                */

const SETTINGS = {
  // the ports RR12's exporters send to (DESIGN 9.15 L2/L7); an older config has one port
  input: {
    toDraft: (c) => ({ ports: (arr(c?.ports).length ? arr(c.ports) : [c?.port ?? 5565]).map((p) => str(p)) }),
    body: (d) => ({ ports: d.ports.map((p) => Number(str(p).trim())) }),
    validate: (d) => validateInputPorts(d.ports, { panelPort: S.state?.config?.panel?.port, outputs: S.state?.config?.outputs, current: inputPorts(S.state),
      webPort: Number(S.state?.config?.meet?.trackScoreWebPort) || 5000 }),
  },
  // Advanced: the SR line format, for an exporter that sends timing point names (same config section as the ports)
  sr: {
    section: 'input',
    toDraft: (c) => ({ delimiter: str(c?.delimiter ?? '|'), tag: str(c?.tag), columns: arr(c?.columns).map(str) }),
    body: (d) => ({ delimiter: d.delimiter, tag: d.tag.trim(), columns: d.columns }),
    validate: (d) => [d.delimiter ? null : 'Type the separator RR12 puts between fields (usually |).', ...validateColumns(d.columns)].filter(Boolean),
  },
  filter: {
    toDraft: (c) => ({ tagWindowSec: str(c?.tagWindowSec ?? 10), holdSec: str(c?.holdSec ?? 2), startIgnoreSec: str(c?.startIgnoreSec ?? 60) }),
    body: (d) => ({ tagWindowSec: Number(d.tagWindowSec.replace(',', '.')), holdSec: Number(d.holdSec.replace(',', '.')),
      startIgnoreSec: Number(d.startIgnoreSec.replace(',', '.')) }),
    validate: (d) => [validateSeconds(d.tagWindowSec, 'The tag filter window', 600), validateSeconds(d.holdSec, 'The hold', 60),
      validateSeconds(d.startIgnoreSec, '"Ignore reads in the first … s"', 1800)].filter(Boolean),
  },
  lif: {
    toDraft: (c) => ({ enabled: !!c?.enabled, inputDir: str(c?.inputDir), outputDir: str(c?.outputDir), fillPlaces: !!c?.fillPlaces }),
    body: (d) => ({ enabled: d.enabled, inputDir: d.inputDir.trim(), outputDir: d.outputDir.trim(), fillPlaces: d.fillPlaces }),
    validate: (d) => {
      const e = [];
      if (d.enabled && !d.inputDir.trim()) e.push('Choose the FinishLynx results folder (where FinishLynx writes its .lif files).');
      if (d.enabled && !d.outputDir.trim()) e.push('Choose the output folder for the merged .lif files.');
      if (d.inputDir.trim() && d.outputDir.trim() && pathInside(d.outputDir, d.inputDir)) {
        e.push("The output folder can't be the FinishLynx folder or inside it. Split Relay never writes where FinishLynx writes.");
      }
      return e;
    },
  },
  panel: {
    toDraft: (c) => ({ port: str(c?.port ?? 5590), allowLan: !!c?.allowLan }),
    body: (d) => ({ port: Number(d.port), allowLan: d.allowLan }),
    validate: (d) => [validatePort(d.port, 'The control panel port')].filter(Boolean),
  },
  // DESIGN 9.22: the meet's name (its meet file's name) and TrackScore's web page for Set up from TrackScore
  meet: {
    toDraft: (c) => ({ name: str(c?.name), trackScoreWebPort: str(c?.trackScoreWebPort ?? 5000) }),
    body: (d) => ({ name: d.name.trim(), trackScoreWebPort: Number(str(d.trackScoreWebPort).trim()) }),
    validate: (d) => [
      d.name.trim().length > 80 ? 'Keep the meet name to 80 characters.' : null,
      validatePort(d.trackScoreWebPort, "TrackScore's web port"),
      Number(str(d.trackScoreWebPort).trim()) === 5555 ? "Port 5555 is where TrackScore takes the splits, not its web page. TrackScore's web page is usually on port 5000." : null,
    ].filter(Boolean),
  },
};

const sectionOf = (sec) => SETTINGS[sec].section || sec;

function settingsDraft(sec, st = S.state) {
  return draftFor('set:' + sec, SETTINGS[sec].toDraft, st.config[sectionOf(sec)] || {});
}

async function saveSettings(sec) {
  const d = settingsDraft(sec);
  const oldPanelPort = S.state.config.panel?.port;
  if (sec === 'input' && !SETTINGS.input.validate(d.draft).length) {
    // Enter in a Port field saves at once; an exporter connected on a port that goes away would just keep retrying it
    // (a port removed with its Remove button was confirmed there already)
    const dropped = inputPortsDropped(S.state, d.draft.ports).filter((x) => !arr(d.confirmedDrops).includes(x.port));
    if (dropped.length) {
      const where = arr(S.state.addresses).filter(Boolean)[0] || "this PC's address";
      const before = new Set(inputPorts(S.state));
      const added = d.draft.ports.map((p) => Number(str(p).trim())).filter((p) => !before.has(p));
      const one = dropped.length === 1;
      const ok = await confirmDialog({
        title: one ? `Stop listening on port ${dropped[0].port}?` : 'Stop listening on these ports?',
        body: [
          `RR12 is connected on ${portsText(dropped.map((x) => x.port))} now. Saving stops Split Relay listening there and disconnects ${one ? 'that exporter' : 'those exporters'}: ${one ? 'its' : 'their'} reads stop arriving.`,
          one && added.length === 1
            ? `Then change that RR12 exporter's destination to ${where}:${added[0]} as well (127.0.0.1:${added[0]} if RR12 runs on this PC).`
            : 'Then point those RR12 exporters at a port Split Relay listens on.',
        ],
        confirm: one && added.length === 1 ? `Move to port ${added[0]}` : 'Save ports',
        danger: true,
      });
      if (!ok) return;
    }
  }
  const section = sectionOf(sec);
  const st = await saveDraft(d, {
    validate: SETTINGS[sec].validate,
    send: (draft) => api('PUT', '/api/settings', { [section]: SETTINGS[sec].body(draft) }),
    server: (s) => s.config[section] || {},
  });
  if (!st) return;
  if (sec === 'input') d.confirmedDrops = [];
  if (section === 'input') S.expr.sig = '';
  if (sec === 'panel' && Number(st.config.panel?.port) !== Number(oldPanelPort)) {
    toast(`The control panel moves to port ${st.config.panel.port}. If this page stops updating, open http://localhost:${st.config.panel.port}/`, 'info', 20000);
  }
}

/** Whether the Advanced SR section is open: as the operator left it, else open while RR12 sends SR or JSON lines. */
function srIsOpen(st) {
  if (S.srOpen != null) return S.srOpen;
  return inputsOf(st).some((i) => i.format === 'sr' || i.format === 'json') || isDirty(S.drafts.get('set:sr'));
}

/* ============================================================================================================ */
/* Inputs page: the RR12 ports, the exporter to set up in RR12, and the SR line format (advanced)                 */

function renderInputsTab() {
  const st = S.state;
  if (!EL.inputsBuilt) {
    EL.inputsBuilt = true;
    EL.setForms.input = h('div');
    EL.setForms.sr = h('div');
    EL.setLive.input = h('div', { class: 'set-live' });
    EL.exprBox = h('div', { class: 'expr-box' });
    // DESIGN 9.15 L7: the SR line format (timing point names, contests, names) is the advanced way, under a toggle
    EL.srToggle = h('button', { type: 'button', class: 'disclosure local', 'data-fk': 'sr-toggle', 'aria-controls': 'sr-advanced', 'aria-expanded': 'false',
      onclick: () => { S.srOpen = !srIsOpen(S.state); scheduleRender(); } }, h('span', { class: 'i i-chevron', 'aria-hidden': 'true' }), h('span', { class: 'disc-label' }, 'Advanced'));
    EL.srExpr = h('div', { class: 'expr-box' });
    EL.srWrap = h('div', { id: 'sr-advanced', class: 'advanced', hidden: true },
      h('h3', { class: 'subhead' }, 'SR lines: timing point names, contests and names'),
      h('p', { class: 'help' }, 'Only for an exporter that sends timing point names instead of the LapTime line. Split Relay reads either kind on any port, by itself.'),
      EL.setForms.sr, EL.srExpr);
    PANELS.inputs.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', {}, 'Inputs'), h('p', { class: 'meta' }, 'Race Result 12 sends the split reads here: one exporter per port.')),
      h('div', { class: 'stack' },
        h('section', { class: 'card settings-card', id: 'set-input', tabindex: '-1', 'aria-labelledby': 'set-input-h' },
          h('div', { class: 'card-head' }, h('h2', { id: 'set-input-h' }, 'RR12 ports')),
          EL.setForms.input, EL.setLive.input),
        h('section', { class: 'card settings-card', id: 'set-exporter', tabindex: '-1', 'aria-labelledby': 'set-exporter-h' },
          h('div', { class: 'card-head' }, h('h2', { id: 'set-exporter-h' }, 'RR12 exporter setup')),
          EL.exprBox,
          h('div', { class: 'sr-toggle-row' }, EL.srToggle), EL.srWrap)));
  }
  for (const sec of ['input', 'sr']) {
    guard(EL.setForms[sec], () => syncForm(EL.setForms[sec], settingsDraft(sec, st), SETTINGS_FORMS[sec]));
  }
  const portMap = arr(st.config.races).map((r) => [r.id, r.name, r.active, r.inputPort]);
  // the ports table is the form (a draft); its status columns follow every State
  guard(EL.setForms.input, () => paintPortCells(st));
  guard(EL.setLive.input, () => paintSig(EL.setLive.input, JSON.stringify([st.input?.clockLagSec, st.inputs, st.input?.connections, !!S.connsOpen]), () => inputLive(st)));
  guard(EL.exprBox, () => paintSig(EL.exprBox, JSON.stringify([st.addresses, likelyAddress(st), inputPorts(st), portMap, laptimeExpression(st), S.more.has('exp-how'), !!S.addrsOpen]), () => exporterBox(st)));
  const open = srIsOpen(st);
  EL.srWrap.hidden = !open;
  EL.srToggle.setAttribute('aria-expanded', String(open));
  const label = 'Advanced: send timing point names instead (SR lines)';
  const lab = EL.srToggle.querySelector('.disc-label');
  if (lab && lab.textContent !== label) lab.textContent = label;
  guard(EL.srExpr, () => {
    const sig = JSON.stringify(st.config.input || {});
    // State carries the SR expression (State.expressions.sr); an older server is asked for it
    if (typeof st.expressions?.sr === 'string') {
      if (S.expr.text !== st.expressions.sr || S.expr.error) S.expr = { sig, loading: false, text: st.expressions.sr, error: '' };
    } else if (open && S.expr.sig !== sig && !S.expr.loading) loadExpression(sig);
    const dirty = isDirty(S.drafts.get('set:sr'));
    paintSig(EL.srExpr, JSON.stringify([S.expr, dirty]), () => srExpressionBox(dirty));
  });
}

/* ============================================================================================================ */
/* Settings page: tag filter, names file, merged .lif files, control panel                                      */

function renderSettingsTab() {
  const st = S.state;
  if (!EL.settingsBuilt) {
    EL.settingsBuilt = true;
    const card = (sec, title, intro) => {
      EL.setForms[sec] = h('div');
      EL.setLive[sec] = h('div', { class: 'set-live' });
      return h('section', { class: 'card settings-card', id: 'set-' + sec, tabindex: '-1', 'aria-labelledby': `set-${sec}-h` },
        h('div', { class: 'card-head' }, h('h2', { id: `set-${sec}-h` }, title), intro ? h('p', { class: 'help' }, intro) : null),
        sec === 'filter' ? EL.setForms[sec] : [EL.setLive[sec], EL.setForms[sec]]);
    };
    // DESIGN 9.22: Meet setup, first and wide: what it can do, the meets saved here, its two settings, a new meet
    EL.setForms.meet = h('div');
    EL.setLive.meet = h('div', { class: 'set-live' });
    EL.meetNew = h('div', { class: 'meet-new' });
    const meetCard = h('section', { class: 'card settings-card', id: 'set-meet', tabindex: '-1', 'aria-labelledby': 'set-meet-h' },
      h('div', { class: 'card-head' }, h('h2', { id: 'set-meet-h' }, 'Meet setup'),
        h('p', { class: 'help' }, "Save this meet's races, outputs and settings to a file, load them again, or read the races from TrackScore.")),
      EL.setForms.meet, EL.setLive.meet, EL.meetNew);
    // the cards in the order of the shortcuts above them: two in a row, the wide .lif table on its own row
    PANELS.settings.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', {}, 'Settings'),
        h('nav', { class: 'chips-bar', 'aria-label': 'Settings sections' },
          [['meet', 'Meet setup'], ['filter', 'Tag filter'], ['names', 'Names file'], ['entries', 'Start lists'], ['lif', 'Merged .lif files'], ['panel', 'Control panel']].map(([k, l]) => h('a', { class: 'fchip', href: '#settings/' + k }, l)),
          h('a', { class: 'fchip', href: '#inputs' }, 'RR12 inputs →'))),
      h('div', { class: 'settings-grid' },
        h('div', { class: 'span-2' }, meetCard),
        card('filter', 'Tag filter', 'How reads of one runner become one pass, and which reads at the start are ignored.'),
        card('names', 'Names file', "RR12 sends only bibs: names, schools and gender come from FinishLynx's .ppl for this meet. It reloads by itself when FinishLynx changes it."),
        h('div', { class: 'span-2' }, card('lif', 'Merged .lif files', 'FinishLynx\'s files get the splits added, in a folder of their own.')),
        card('panel', 'Control panel'),
        card('entries', 'Start lists', "Who is entered in which race, from the meet's entry files. Split Relay keeps an athlete of another race off a race's boards.")));
  }
  // 9.25: the one setting of the start lists, saved at once
  guard(EL.setLive.entries, () => paintSig(EL.setLive.entries, JSON.stringify([st.config.entries ?? null, arr(st.startLists?.events).length, S.viewOnly]), () => entriesCard(st)));
  for (const sec of ['meet', 'filter', 'lif', 'panel']) {
    guard(EL.setForms[sec], () => syncForm(EL.setForms[sec], settingsDraft(sec, st), SETTINGS_FORMS[sec]));
  }
  if (!S.viewOnly) loadMeetFiles();
  guard(EL.setLive.meet, () => paintSig(EL.setLive.meet, JSON.stringify([st.config.meet, S.meetFiles.at, S.meetFiles.list, S.meetFiles.dir, S.viewOnly,
    Math.floor(nowMs() / 60000)]), () => meetCardLive(st)));
  const blocked = S.viewOnly ? '' : newMeetBlocker(st, nowMs());
  guard(EL.meetNew, () => paintSig(EL.meetNew, JSON.stringify([st.dataDir, S.viewOnly, S.confirming.has('new-meet'), blocked]), () => [
    h('h3', { class: 'subhead' }, 'New meet'),
    h('p', { class: 'help' }, 'Puts the reads of the last meet away (a copy goes to data\\archive) and clears every gun time and Pause, so the next meet\'s races start empty. Races, outputs and settings stay.'),
    S.viewOnly ? null : h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn ghost danger', 'data-fk': 'meet-new-start', 'aria-disabled': busyAttr('new-meet'),
      'aria-describedby': blocked ? 'meet-new-why' : null, onclick: (e) => newMeetFlow(e.currentTarget) }, 'Start a new meet…')),
    // O28: while a race runs it is said here, and the button says it again instead of asking
    blocked ? h('p', { class: 'msg tone-warn', id: 'meet-new-why' }, blocked) : null,
    h('p', { class: 'help data-dir' }, dataDirText(st)),
  ]));
  // the names file is chosen with the picker and saved at once (DESIGN 9.20): a card, no form; the .ppl files of
  // FinishLynx's folder are looked up again every 20 s while the page shows
  if (pplFolders(st).length) loadPplSuggestions();
  const gap = namesGap(st);
  guard(EL.setLive.names, () => paintSig(EL.setLive.names, JSON.stringify([st.names, st.config.names, st.namesNeeded, gap, S.pplSug.list, pplFolders(st),
    openNamesOffer(st).map((r) => [r.id, r.name]), S.confirming.size]), () => namesCard(st, gap)));
  guard(EL.setLive.lif, () => paintSig(EL.setLive.lif, JSON.stringify([st.lif, st.config.lif, arr(st.config.races).map((r) => [r.id, r.name]), arr(st.races).map((v) => [v.id, gunDiffers(v)])]), () => lifLive(st)));
  guard(EL.setLive.panel, () => paintSig(EL.setLive.panel, JSON.stringify([st.config.panel]), () => panelLive(st)));
}

/** DESIGN 9.25, Settings, Start lists: what happens to an athlete a start list enters in another race. Saved at once. */
function entriesCard(st) {
  const n = arr(st.startLists?.events).length;
  return [
    radioGroup({ name: 'entries-other', legend: 'Athletes entered in another race', value: st.config?.entries?.otherRace === 'send' ? 'send' : 'keep',
      options: [{ value: 'keep', label: 'Keep them off the boards', help: 'Read and counted, listed in Review under Not in this race; not sent, not in the .lif file.' },
        { value: 'send', label: 'Send and flag', help: 'Sent like any runner, with a row in Review: Not in this race takes them back.' }],
      onChange: (v) => setOtherRace(v),
      help: 'For a race whose start list fits its runners. A race without one sends everybody, and flags a runner who ran another race today.' }),
    h('p', { class: 'help' }, n ? `${plural(n, 'start list')} loaded. ` : 'No start list loaded. ', h('a', { href: '#races' }, 'Load them on the Races page')),
  ];
}

async function setOtherRace(v) {
  if (S.viewOnly) return toast(viewOnlyText(), 'bad');
  const st = await act(() => api('PUT', '/api/settings', { entries: { otherRace: v } }));
  if (st) {
    applyState(st);
    toast(v === 'send' ? 'Athletes entered in another race are sent and flagged from now on.' : 'Athletes entered in another race are kept off the boards from now on.', 'ok');
  }
  scheduleRender();
  return undefined;
}

async function loadExpression(sig) {
  S.expr = { ...S.expr, sig, loading: true, error: '' };
  try {
    const r = await api('GET', '/api/expression');
    S.expr = { sig, loading: false, text: str(r?.expression), error: '' };
  } catch (err) {
    S.expr = { sig, loading: false, text: '', error: err.message };
  }
  scheduleRender();
}

/** An address or value as a chip: one click copies it ("192.168.0.21:5565"). */
function copyChip(text) {
  const label = h('span', { class: 'mono' }, text);
  const b = h('button', { type: 'button', class: 'copy-chip local', title: `Copy ${text}`, 'aria-label': `Copy ${text}`, onclick: async () => {
    const ok = await copyText(text);
    label.textContent = ok ? 'Copied' : text;
    b.classList.toggle('done', ok);
    setTimeout(() => { if (b.isConnected) { label.textContent = text; b.classList.remove('done'); } }, 1500);
  } }, label, h('span', { class: 'i i-copy', 'aria-hidden': 'true' }));
  return b;
}

/** A "Copy" button for text the operator pastes into RR12. */
function copyButton(text, label, cls = 'btn primary') {
  const b = h('button', { type: 'button', class: cls, disabled: !text, onclick: async () => {
    const ok = await copyText(text);
    b.textContent = ok ? '✓ Copied' : 'Copy failed: select the text and press Ctrl+C';
    setTimeout(() => { if (b.isConnected) b.textContent = label; }, 2500);
  } }, label);
  return b;
}

/**
 * The RR12 exporter to set up first (DESIGN 9.15 L7): the FinishLynx LapTime line, the same one RR12's FinishLynx
 * exporter sends, to each port; the split mats only. One exporter per port; overlapping races get a second one.
 */
function exporterBox(st) {
  const ports = inputPorts(st);
  const races = arr(st.config.races);
  const who = (p) => {
    const rs = racesOnPort(races, p);
    return rs.length ? ` · ${listText(rs.map((r) => `${r.name || '(no name)'}${r.active === false ? '' : ' (Active)'}`), 4)}` : ' · no race reads from it yet';
  };
  const expr = laptimeExpression(st);
  const [btn, body] = moreParts('exp-how', 'RR12 sends each runner\'s bib and time at the split mats. Split Relay counts each runner\'s passes: reads within the tag filter window (the A and B mats) are one pass, the first pass is split 1, the next split 2, and so on, up to the race\'s number of splits (Races page). Passes after the last split are ignored; a split is never sent as laps to go 0, which is the finish.', 'How the reads become splits');
  const item = (dt, ...dd) => h('div', {}, h('dt', {}, dt), h('dd', {}, ...dd));
  // the address RR12 most likely reaches this PC on, as a chip to copy; the others behind "More addresses"
  const likely = likelyAddress(st);
  const others = arr(st.addresses).filter((a) => a && a !== likely);
  return [
    h('p', { class: 'help' }, 'Add one exporter in RR12 with these settings, then press play. Start Split Relay first: RR12 won\'t start an exporter it can\'t connect to.'),
    h('dl', { class: 'settings-list' },
      item('Type', h('strong', {}, 'TCP/IP'), ' (not "TCP/IP (Pooled)")'),
      item('Destination', ports.map((p, i) => h('div', { class: 'dest' },
        ports.length > 1 ? h('span', { class: 'dest-label' }, `Exporter ${i + 1}`) : null,
        likely ? copyChip(`${likely}:${p}`) : h('strong', {}, rrTarget(st, p)),
        h('span', { class: 'help inline' }, `127.0.0.1:${p} on this PC${ports.length > 1 ? who(p) : ''}`))),
      others.length ? h('div', { class: 'dest-more' },
        disclosureButton({ open: !!S.addrsOpen, fk: 'addrs-more', label: `More addresses (${others.length})`, onToggle: () => { S.addrsOpen = !S.addrsOpen; scheduleRender(); } }),
        S.addrsOpen ? h('div', { class: 'chips' }, h('span', { class: 'help inline' }, 'If RR12 is on another network of this PC:'), others.flatMap((a) => ports.map((p) => copyChip(`${a}:${p}`)))) : null) : null),
      item('Timing points', h('strong', {}, 'The split mats only (A and B), not the finish.')),
      item('Line end', h('strong', {}, 'CRLF')),
      item('Min. Seconds Between', h('strong', {}, '0')),
      item('Export Data', 'This expression (bib and time only, the same line RR12 sends FinishLynx):')),
    h('div', { class: 'expr-row' }, h('pre', { class: 'code expr', tabindex: '0', 'aria-label': 'RR12 Export Data expression' }, expr), copyButton(expr, 'Copy expression')),
    h('p', { class: 'msg tone-info overlap' }, h('strong', {}, 'Races that overlap: '),
      'a second exporter in RR12, filtered to that race, sending to a second port. ',
      ports.length > 1 ? `Split Relay listens on ${portsText(ports)}; choose each race's port on the Races page.` : h('a', { href: '#inputs/input' }, 'Add a second port')),
    h('div', { class: 'help' }, 'How the reads become splits', btn, body),
  ];
}

/** The SR line format's expression, built by Split Relay from the columns (GET /api/expression). */
function srExpressionBox(dirty) {
  return [
    dirty ? h('p', { class: 'msg tone-warn' }, 'You have unsaved changes to the SR line format above. Save them first; the expression changes with the fields.') : null,
    h('p', { class: 'help' }, 'Export Data for an SR exporter (same Type, Destination, Line end and Min. Seconds Between as above, but all split timing points):'),
    S.expr.error
      ? h('p', { class: 'msg tone-bad' }, `Couldn't get the expression: ${S.expr.error} `, h('button', { type: 'button', class: 'btn small', onclick: () => { S.expr.sig = ''; scheduleRender(); } }, 'Try again'))
      : h('pre', { class: 'code expr', tabindex: '0', 'aria-label': 'RR12 Export Data expression for SR lines' }, S.expr.text || (S.expr.loading ? 'Loading…' : '')),
    h('div', { class: 'row' }, copyButton(S.expr.text, 'Copy SR expression'),
      h('span', { class: 'help inline' }, 'After changing the fields, paste it again.')),
  ];
}

/** Under the ports table: the RR12 clock offset, and the connections, folded. */
function inputLive(st) {
  const ins = inputsOf(st);
  const lag = st.input?.clockLagSec;
  const conns = ins.flatMap((i) => arr(i.connections).map((c) => ({ ...c, port: i.port })));
  return [
    Number.isFinite(lag) ? h('p', { class: 'help' }, clockLagText(lag)) : null,
    // a port nobody is connected to: the usual reason when RR12 nevertheless shows "connected"
    ins.some((i) => !arr(i.connections).length) ? h('p', { class: 'help', 'data-fk': 'rr-connected-hint' }, RR_CONNECTED_HINT) : null,
    // (a button, not <details>: this part repaints with every read and would fold up again)
    conns.length ? h('div', { class: 'conns' },
      disclosureButton({ open: !!S.connsOpen, fk: 'conns-toggle', label: `Connections (${fmtInt(conns.length)})`, onToggle: () => { S.connsOpen = !S.connsOpen; scheduleRender(); } }),
      S.connsOpen ? h('div', { class: 'table-scroll' }, h('table', { class: 'feed compact' },
        h('thead', {}, h('tr', {}, [['From'], ['Port', 'num'], ['Connected'], ['Lines', 'num'], ['Last line']].map(([t, c]) => h('th', { scope: 'col', class: c || null }, t)))),
        h('tbody', {}, conns.map((c) => h('tr', {},
          h('td', { class: 'mono' }, str(c.remote)),
          h('td', { class: 'num' }, str(c.port)),
          h('td', { class: 'mono' }, toMs(c.connectedAt) ? formatWall(toMs(c.connectedAt)) : ''),
          h('td', { class: 'num' }, fmtInt(c.lines || 0)),
          h('td', {}, agoSpan(c.lastLineAt))))))) : null) : null,
  ];
}

/** The ports table's live columns: what each port is doing, what RR12 sends on it, and which races read from it. */
function paintPortCells(st) {
  const live = new Map(inputsOf(st).map((i) => [Number(i.port), i]));
  const races = arr(st.config.races);
  const now = nowMs();
  for (const td of EL.setForms.input.querySelectorAll('[data-port-cell]')) {
    const port = Number(td.getAttribute('data-port'));
    const i = live.get(port);
    const kind = td.getAttribute('data-port-cell');
    const rs = racesOnPort(races, port);
    let sig;
    let build;
    if (!i) {
      sig = JSON.stringify([kind, port, 'new', kind === 'races' ? rs.map((r) => [r.name, r.active]) : null]);
      build = () => (kind === 'status' ? h('span', { class: 'muted' }, Number.isFinite(port) && port > 0 ? 'Not saved yet' : '') : kind === 'races' && rs.length ? listText(rs.map((r) => r.name || '(no name)'), 4) : '');
    } else if (kind === 'status') {
      const l = inputLight(i, st, now);
      const n = arr(i.connections).length;
      sig = JSON.stringify([kind, l.tone, l.word, n, i.error]);
      build = () => h('span', { class: `st tone-${l.tone}`, title: l.title }, i.error ? `Problem: ${i.error}` : n ? `${l.word} · ${plural(n, 'connection')}` : l.word);
    } else if (kind === 'format') {
      sig = JSON.stringify([kind, i.format]);
      build = () => formatWord(i.format);
    } else if (kind === 'lines') {
      sig = JSON.stringify([kind, i.totalLines]);
      build = () => fmtInt(i.totalLines || 0);
    } else if (kind === 'last') {
      sig = JSON.stringify([kind, toMs(i.lastLineAt)]);
      build = () => agoSpan(i.lastLineAt);
    } else {
      sig = JSON.stringify([kind, rs.map((r) => [r.name, r.active])]);
      build = () => (rs.length ? listText(rs.map((r) => `${r.name || '(no name)'}${r.active === false ? '' : ' (Active)'}`), 4) : h('span', { class: 'muted' }, 'none yet'));
    }
    paintSig(td, sig, build);
  }
}

/**
 * Settings → Names file (DESIGN 9.20): the file in use, how many athletes and when they loaded, Choose… (the picker,
 * saved on the pick) and Clear; the .ppl files of FinishLynx's folder to use in one click; and "Send names now" for the
 * races that went out without names.
 */
function namesCard(st, gap = namesGap(st)) {
  const n = st.names || {};
  const path = str(st.config.names?.pplPath).trim();
  const now = nowMs();
  const outs = (o) => `${listText(o)} ${o.length === 1 ? 'gets' : 'get'}`;
  let status;
  if (!path) {
    // RR12's LapTime lines carry bibs only (DESIGN 9.15 L8): without the file the boards get no names at all
    status = !gap.missing ? h('p', { class: 'help' }, 'No names file chosen.')
      : gap.tone === 'bad' ? h('p', { class: 'msg tone-bad' }, `No names file: ${outs(gap.outputs)} bibs only.${sentWithoutNamesText(gap.sent)}`)
        : h('p', { class: 'msg tone-warn' }, "No names file yet: the splits go out with bibs only. Choose the meet's .ppl before the first split.");
  } else if (!n.loaded) {
    status = n.error ? h('p', { class: `msg tone-${gap.tone === 'bad' ? 'bad' : 'warn'}` }, `Can't read it: ${n.error}`) : h('p', { class: 'msg tone-warn' }, 'Loading the names…');
  } else {
    status = h('p', { class: `msg tone-${n.error ? 'warn' : 'ok'}` }, `✓ ${plural(n.count || 0, 'athlete')} loaded`, n.error ? `. Now: ${n.error}` : '.');
  }
  const item = (dt, ...dd) => h('div', {}, h('dt', {}, dt), h('dd', {}, ...dd));
  const busy = S.confirming.has('names-clear');
  const chooseBtn = h('button', { type: 'button', class: 'btn' + (!path || gap.missing ? ' primary' : ''), 'data-fk': 'names-choose', onclick: (e) => chooseNamesFile(e.currentTarget) }, 'Choose…');
  const clearBtn = path ? h('button', { type: 'button', class: 'btn ghost', 'data-fk': 'names-clear', 'aria-disabled': busy ? 'true' : null,
    onclick: (e) => once('names-clear', e.currentTarget, () => clearNamesFile(e.currentTarget)) }, 'Clear') : null;
  const sug = arr(S.pplSug.list).filter((x) => normPath(x.path) !== normPath(path));
  const offer = openNamesOffer(st);
  return [
    status,
    h('dl', { class: 'settings-list names-list' },
      item('File', path ? h('span', { class: 'mono path' }, path) : h('span', { class: 'muted' }, 'None chosen')),
      path && n.loaded ? item('Athletes', fmtInt(n.count || 0)) : null,
      path && n.loaded && toMs(n.loadedAt) ? item('Loaded at', formatWall(toMs(n.loadedAt))) : null),
    h('div', { class: 'row' }, chooseBtn, clearBtn),
    sug.length ? h('div', { class: 'names-suggest' },
      h('p', { class: 'sub-label' }, path ? "Other .ppl files in FinishLynx's folder:" : "In FinishLynx's folder (newest first):"),
      sug.map((x, i) => h('button', { type: 'button', class: 'btn small suggest-btn' + (!path && i === 0 ? ' primary' : ''), 'data-fk': 'names-use-' + i,
        onclick: (e) => useNamesFile(x.path, e.currentTarget) }, pplUseLabel(x, now)))) : null,
    !path && !pplFolders(st).length ? h('p', { class: 'help' }, "Tip: once FinishLynx's folder is set (Merged .lif files), the .ppl files in it are offered here.") : null,
    offer.length ? h('div', { class: 'msg tone-warn names-offer' },
      h('p', {}, `${listText(offer.map((r) => r.name))} went out ${loadPref('namesOffer', null)?.switched ? "with the earlier names file's names" : 'before the names were in'}. “Send names now” sends ${offer.length === 1 ? "the race's" : "each race's"} splits again, now with ${loadPref('namesOffer', null)?.switched ? "this file's names" : 'names'} (runners who have finished are left out: FinishLynx sent their names).`),
      offer.map((r) => h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', 'data-fk': 'names-send-' + r.id, onclick: (e) => sendNamesNow(r.id, e.currentTarget) }, offer.length === 1 ? 'Send names now' : `Send names now: ${r.name}`),
        h('button', { type: 'button', class: 'btn small ghost', 'data-fk': 'names-notnow-' + r.id, onclick: () => setNamesOffer(r.id, 'dismissed') }, 'Not now')))) : null,
  ];
}

/**
 * Settings → Meet setup (DESIGN 9.22): the meet's name, Save, Load and Set up from TrackScore, and the meets saved here
 * (the copy kept before the last load first), each loaded with one click.
 */
function meetCardLive(st) {
  const now = nowMs();
  const files = arr(S.meetFiles.list).slice(0, 8);
  const dir = str(S.meetFiles.dir) || (st.dataDir ? `${st.dataDir}\\meets` : '');
  return [
    S.viewOnly ? null : h('div', { class: 'row meet-load-row' },
      h('button', { type: 'button', class: 'btn', 'data-fk': 'set-meet-load', onclick: chooseMeetFile }, 'Load meet file…'),
      h('button', { type: 'button', class: 'btn', 'data-fk': 'set-meet-ts', onclick: (e) => startMeetLoad({ trackscore: true }, e.currentTarget) }, 'Set up from TrackScore')),
    S.viewOnly ? null : h('div', { class: 'meet-files' },
      h('p', { class: 'sub-label' }, 'Saved meets'),
      files.length ? h('ul', { class: 'meet-file-list' }, files.map((f, i) => h('li', {},
        h('span', { class: 'mf-text' }, h('span', { class: 'mf-name' }, savedMeetName(f, now)),
          h('span', { class: 'help mf-meta' }, f.beforeLoad && !f.error ? 'The setup as it was before the last load. Load… shows what it can put back.' : savedMeetText(f, now))),
        f.error ? null : h('button', { type: 'button', class: 'btn small', 'data-fk': 'set-meet-file-' + i, onclick: (e) => startMeetLoad({ saved: f.fileName }, e.currentTarget) }, 'Load…'))))
        : h('p', { class: 'help' }, S.meetFiles.at ? 'No meet saved yet.' : 'Looking for the meets saved here…'),
      dir ? h('p', { class: 'help' }, 'Saved in ', h('span', { class: 'mono path' }, dir)) : null),
  ];
}

function lifLive(st) {
  const l = st.lif || {};
  const races = arr(st.config.races);
  if (!st.config.lif?.enabled) return h('p', { class: 'help' }, 'Off. Tick “Write merged .lif files” and save to start.');
  const pill = lifPill(l);
  const files = arr(l.files);
  return [
    h('p', { class: `msg tone-${pill.tone}` },
      l.state === 'error' ? `Problem: ${l.error || 'unknown'}`
        : l.state === 'waiting' ? lifWaitingText(l)
          : `Working. ${plural(files.length, 'file')}`,
      toMs(l.lastScanAt) ? h('span', {}, ' · last checked ', agoSpan(l.lastScanAt)) : null),
    files.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'feed compact' },
      h('thead', {}, h('tr', {}, [['File'], ['Event'], ['Race'], ['Rows', 'num'], ['Splits added', 'num'], ['Written']].map(([t, c]) => h('th', { scope: 'col', class: c || null }, t)))),
      h('tbody', {}, files.map((f) => h('tr', {},
        h('td', { class: 'mono' }, str(f.name)),
        h('td', { class: 'mono' }, [f.eventNumber, f.round, f.heat].filter((x) => x != null && x !== '').join('-')),
        h('td', {}, f.copiedOnly ? h('span', { class: 'help inline' }, 'no matching race: copied as is') : str(f.raceName || races.find((r) => r.id === f.raceId)?.name),
          !f.copiedOnly && gunDiffers(viewOf(st, f.raceId)) ? h('span', { class: 'sub tone-text-bad' }, 'Gun differs from the FinishLynx start') : null),
        h('td', { class: 'num' }, fmtInt(f.rows || 0)),
        h('td', { class: 'num' }, fmtInt(f.splitsAdded || 0)),
        h('td', { class: 'mono' }, toMs(f.writtenAt) ? formatWall(toMs(f.writtenAt)) : 'not yet')))))) : null,
  ];
}

function panelLive(st) {
  return h('p', { class: 'help' }, `This page on this PC: http://localhost:${st.config.panel?.port ?? location.port}/`);
}

/** The panel has one look (dark, for the timing tent); a theme left by an older panel is dropped. */
function applyTheme() {
  document.documentElement.removeAttribute('data-theme');
}

const SETTINGS_FORMS = {
  // DESIGN 9.15 L2/L7: the ports Split Relay listens on, one per RR12 exporter
  input(d) {
    const dr = d.draft;
    const st = S.state;
    const races = arr(st.config.races);
    const live = new Map(inputsOf(st).map((i) => [Number(i.port), i]));
    const taken = [st.config.panel?.port, ...arr(st.config.outputs).filter((o) => o.mode === 'tcp-server' && o.enabled !== false).map((o) => o.port)];
    const row = (p, i) => {
      const id = `in-port-${i}`;
      const port = Number(str(p).trim());
      const users = racesOnPort(races, port);
      const conns = arr(live.get(port)?.connections).length;
      const remove = async () => {
        if (conns || users.length) {
          const ok = await confirmDialog({
            title: `Remove port ${port}?`,
            body: [
              conns ? `RR12 is connected on port ${port} now (${plural(conns, 'connection')}). Once you save, Split Relay stops listening there and that exporter's reads stop arriving.` : '',
              users.length ? `${listText(users.map((r) => r.name || '(no name)'))} ${users.length === 1 ? 'reads' : 'read'} from port ${port}: choose another port on ${users.length === 1 ? 'that race' : 'those races'} (Races page).` : '',
            ],
            confirm: 'Remove port',
            danger: conns > 0,
          });
          if (!ok) return;
          // said here, so the save does not ask again
          if (conns) d.confirmedDrops = [...arr(d.confirmedDrops), port];
        }
        dr.ports.splice(i, 1);
        S.focusAfter = 'in-port-add';
        restructure(d);
      };
      // the port is edited in place; the columns after it are what Split Relay reports for it now (paintPortCells)
      const cell = (kind, cls = '') => h('td', { class: cls || null, 'data-port-cell': kind, 'data-port': String(port) });
      return h('tr', {},
        h('td', { class: 'col-port' }, h('label', { for: id, class: 'sr-only' }, `Port ${i + 1}`),
          h('input', { id, 'data-fk': id, type: 'text', class: 'mono port-input', inputmode: 'numeric', autocomplete: 'off', value: p,
            oninput: (e) => { dr.ports[i] = e.target.value; changed(d); } })),
        cell('status'), cell('format'), cell('lines', 'num'), cell('last'), cell('races', 'wrap'),
        h('td', { class: 'col-x' }, h('button', { type: 'button', class: 'btn small danger', 'data-fk': `in-port-del-${i}`, disabled: dr.ports.length <= 1, 'aria-label': `Remove port ${str(p) || i + 1}`, onclick: remove }, 'Remove')));
    };
    const [btn, body] = moreParts('in-ports', 'One port per RR12 exporter, 1024 to 65535 (the first is usually 5565). For races that overlap, add a second port: a second exporter in RR12, filtered to that race, sends to it, and that race reads from it (Races page).', 'About the ports');
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSettings('input'); } },
      h('div', { class: 'table-scroll' }, h('table', { class: 'feed compact ports-table' },
        h('thead', {}, h('tr', {}, [['Port'], ['Status'], ['RR12 sends'], ['Lines', 'num'], ['Last line'], ['Races'], ['', 'col-x']]
          .map(([t, c]) => h('th', { scope: 'col', class: c || null }, t || h('span', { class: 'sr-only' }, 'Remove'))))),
        h('tbody', {}, dr.ports.map(row)))),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn small', 'data-fk': 'in-port-add', disabled: dr.ports.length >= MAX_INPUT_PORTS, onclick: () => {
          dr.ports.push(String(nextFreePort(dr.ports.map((x) => Number(str(x).trim())), taken)));
          S.focusAfter = `in-port-${dr.ports.length - 1}`;
          restructure(d);
        } }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Add a port'),
        h('span', { class: 'help inline' }, 'A second port is for a race that overlaps.', btn), body),
      formFooter(d, { saveLabel: 'Save ports', onRevert: () => { d.confirmedDrops = []; reloadDraft(d, S.state.config.input); scheduleRender(); } }));
  },

  // Advanced (DESIGN 9.15 L7): the SR line format, for an exporter that sends timing point names instead
  sr(d) {
    const dr = d.draft;
    const set = (k) => (v) => { dr[k] = v; changed(d); };
    const n = dr.columns.length;
    const colRow = (c, i) => {
      const move = (delta) => {
        const j = i + delta;
        if (j < 0 || j >= n) return;
        [dr.columns[i], dr.columns[j]] = [dr.columns[j], dr.columns[i]];
        const dir = delta < 0 ? 'up' : 'down';
        const edge = delta < 0 ? j === 0 : j === n - 1;
        S.focusAfter = `col-${edge ? (dir === 'up' ? 'down' : 'up') : dir}-${j}`;
        restructure(d);
      };
      return h('li', { class: 'col-row' },
        h('span', { class: 'split-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('label', { for: `col-type-${i}`, class: 'sr-only' }, `Field ${i + 1}`),
        h('select', { id: `col-type-${i}`, 'data-fk': `col-type-${i}`, value: c, onchange: (e) => { dr.columns[i] = e.target.value; restructure(d); } },
          COLUMN_TYPES.map((t) => h('option', { value: t }, COLUMN_INFO[t].label))),
        h('code', { class: 'col-rr' }, COLUMN_INFO[c]?.rr || ''),
        h('span', { class: 'split-tools' },
          h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `col-up-${i}`, disabled: i === 0, 'aria-label': `Move field ${i + 1} up`, title: 'Move up', onclick: () => move(-1) }, h('span', { class: 'i i-up', 'aria-hidden': 'true' })),
          h('button', { type: 'button', class: 'btn icon-btn small', 'data-fk': `col-down-${i}`, disabled: i === n - 1, 'aria-label': `Move field ${i + 1} down`, title: 'Move down', onclick: () => move(1) }, h('span', { class: 'i i-down', 'aria-hidden': 'true' })),
          h('button', { type: 'button', class: 'btn small danger', 'data-fk': `col-del-${i}`, 'aria-label': `Remove field ${i + 1}`, onclick: () => { dr.columns.splice(i, 1); S.focusAfter = 'col-add'; restructure(d); } }, 'Remove')));
    };
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSettings('sr'); } },
      h('div', { class: 'field-row' },
        field({ id: 'in-delim', label: 'Separator', cls: 'narrow', help: 'Usually |', control: textInput('in-delim', dr.delimiter, set('delimiter'), { help: true, attrs: { class: 'code' } }) }),
        field({ id: 'in-tag', label: 'Line tag', cls: 'narrow', help: 'First field (SR)', control: textInput('in-tag', dr.tag, set('tag'), { help: true, attrs: { class: 'code' } }) })),
      h('fieldset', { class: 'group' },
        h('legend', {}, 'Fields in each line, in order'),
        h('ol', { class: 'col-list' }, dr.columns.map(colRow)),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { type: 'button', class: 'btn small', 'data-fk': 'col-add', onclick: () => { dr.columns.push('ignore'); S.focusAfter = `col-type-${dr.columns.length - 1}`; restructure(d); } }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Add field'),
          h('span', { class: 'help inline' }, 'A line will look like: ', h('code', { class: 'sample' }, sampleLine(dr))))),
      formFooter(d, { saveLabel: 'Save SR line format', onRevert: () => { reloadDraft(d, S.state.config.input); scheduleRender(); } }));
  },

  filter(d) {
    const dr = d.draft;
    const set = (k) => (v) => { dr[k] = v; changed(d); };
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSettings('filter'); } },
      h('div', { class: 'field-row' },
        field({ id: 'f-window', label: 'Tag filter window (s)', cls: 'mid', help: 'One pass: the A and B mats.',
          more: 'Reads of the same bib at the same split this close together (chip time) count as one crossing, and the earliest time wins. Keep it below the fastest runner\'s time between the two closest mats on the course (about 35 s for 200 m): a second mat read inside the window would be merged into the first. A change counts for the reads already received too.',
          control: textInput('f-window', dr.tagWindowSec, set('tagWindowSec'), { help: true, attrs: { class: 'mono', inputmode: 'decimal' } }) }),
        // a sentence with the box where its "…" is: "Ignore reads in the first [60] s after the gun"
        sentenceField({ id: 'f-start', before: 'Ignore reads in the first', after: 's after the gun', help: 'The start area. 0 = off.',
          more: 'Runners cross mats at the start, often the finish mats: a read this soon after the gun is not a split or a finish. A change counts for the reads already received too.',
          control: textInput('f-start', dr.startIgnoreSec, set('startIgnoreSec'), { help: true, attrs: { class: 'mono short', inputmode: 'decimal' } }) }),
        field({ id: 'f-hold', label: 'Hold before sending (s)', cls: 'mid', help: 'For an earlier backup read.',
          more: "After a runner's first read at a split, Split Relay waits this long before sending, so an earlier read from the other mat can still win.",
          control: textInput('f-hold', dr.holdSec, set('holdSec'), { help: true, attrs: { class: 'mono', inputmode: 'decimal' } }) })),
      formFooter(d, { saveLabel: 'Save tag filter', onRevert: () => { reloadDraft(d, S.state.config.filter); scheduleRender(); } }));
  },

  lif(d) {
    const dr = d.draft;
    const pickDir = (k, title) => async () => {
      const p = await browse({ title, pick: 'dir', ext: '.lif', start: dr[k] });
      if (p) {
        dr[k] = p;
        S.focusAfter = 'lif-' + k;
        restructure(d);
      }
    };
    const clash = dr.inputDir.trim() && dr.outputDir.trim() && pathInside(dr.outputDir, dr.inputDir);
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSettings('lif'); } },
      checkField({ id: 'lif-enabled', label: 'Write merged .lif files', toggle: true, checked: dr.enabled, onChange: (v) => { dr.enabled = v; changed(d); } }),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', { for: 'lif-inputDir' }, 'FinishLynx results folder (only read)')),
        h('div', { class: 'input-with-button' },
          textInput('lif-inputDir', dr.inputDir, (v) => { dr.inputDir = v; restructureSoon(d); }, { attrs: { class: 'code', placeholder: 'e.g. \\\\192.168.0.5\\Lynx\\Meet' } }),
          h('button', { type: 'button', class: 'btn', onclick: pickDir('inputDir', 'Choose the FinishLynx results folder') }, 'Browse…'))),
      h('div', { class: 'field' },
        h('div', { class: 'label-row' }, h('label', { for: 'lif-outputDir' }, 'Output folder for the merged files')),
        h('div', { class: 'input-with-button' },
          textInput('lif-outputDir', dr.outputDir, (v) => { dr.outputDir = v; restructureSoon(d); }, { attrs: { class: 'code', placeholder: 'e.g. C:\\SplitRelay\\lif' } }),
          h('button', { type: 'button', class: 'btn', onclick: pickDir('outputDir', 'Choose the output folder for merged .lif files') }, 'Browse…')),
        h('p', { class: 'help' }, 'Point TrackScore, XC-Analytics and the web results here. Not the FinishLynx folder.'),
        clash ? h('p', { class: 'field-error' }, 'This is the FinishLynx folder or inside it. Choose a different folder.') : null),
      checkField({ id: 'lif-fill', label: 'Fill in places for runners FinishLynx has no row for', checked: dr.fillPlaces, onChange: (v) => { dr.fillPlaces = v; changed(d); },
        more: 'Like FinishLynx "Fill in place": until the first finisher, runners get places by how far they have got. Off by default.' }),
      formFooter(d, { saveLabel: 'Save .lif settings', onRevert: () => { reloadDraft(d, S.state.config.lif); scheduleRender(); } }));
  },

  // DESIGN 9.22 (O22): the meet's name and the ONE save, "Save meet setup": it saves the name (and the web port) when
  // they changed, then writes the meet file under that name. TrackScore's web page is the second field.
  meet(d) {
    const dr = d.draft;
    const ts = trackScoreAt(S.state);
    const footer = formFooter(d, { saveLabel: 'Save meet setup', onRevert: () => { reloadDraft(d, S.state.config.meet); scheduleRender(); } });
    // always there: it saves the meet file even when nothing in the form changed
    const save = d.ui.save;
    d.ui.save = null;
    d.quietSaved = true;
    if (S.viewOnly) save.hidden = true;
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveMeetSetup(save); } },
      h('div', { class: 'field-row' },
        field({ id: 'm-name', label: 'Meet name', cls: 'grow', help: `The meet file's name${str(S.state.config.meet?.name).trim() ? '' : " (none yet: Save meet setup uses today's date)"}. Shown on the Races page.`,
          control: textInput('m-name', dr.name, (v) => { dr.name = v; changed(d); }, { help: true, attrs: { maxlength: '80', placeholder: `Meet ${localDay(nowMs())}` } }) }),
        field({ id: 'm-webport', label: 'TrackScore web port', cls: 'narrow', help: 'Usually 5000.',
          control: textInput('m-webport', dr.trackScoreWebPort, (v) => { dr.trackScoreWebPort = v; changed(d); }, { help: true, attrs: { class: 'mono', inputmode: 'numeric' } }) })),
      h('p', { class: 'help' }, `Set up from TrackScore reads TrackScore's web page at ${ts.host} (${ts.outputName ? `from the ${ts.outputName} output` : 'this PC'}). Never 5555: that is where TrackScore takes the splits.`),
      footer);
  },

  panel(d) {
    const dr = d.draft;
    return h('form', { class: 'form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveSettings('panel'); } },
      field({ id: 'p-port', label: 'Port', cls: 'narrow', help: 'Default 5590.',
        control: textInput('p-port', dr.port, (v) => { dr.port = v; changed(d); }, { help: true, attrs: { class: 'mono', inputmode: 'numeric' } }) }),
      checkField({ id: 'p-lan', label: 'Let other computers on the network open this page', checked: dr.allowLan, onChange: (v) => { dr.allowLan = v; changed(d); },
        help: 'They can watch, not change anything.' }),
      formFooter(d, { saveLabel: 'Save panel settings', onRevert: () => { reloadDraft(d, S.state.config.panel); scheduleRender(); } }));
  },
};

/** Folder fields show a clash warning, which needs a rebuild; wait until typing pauses so the cursor isn't disturbed. */
function restructureSoon(d) {
  changed(d);
  clearTimeout(d.soon);
  d.soon = setTimeout(() => restructure(d), 700);
}

/* ============================================================================================================ */
/* Help page: the checklists, how it works, the status words, and what to do when something goes wrong          */

const HELP_SECTIONS = [
  ['update', 'Version and updates'], ['setup', 'Setup checklist'], ['checklist', 'Race-day checklist'], ['splits', 'How reads become splits'], ['review', 'Pause and Review'],
  ['glossary', 'Status words'], ['lights', 'Status lights'], ['notes', 'Good to know'], ['trouble', 'If something goes wrong'],
];

function renderHelp() {
  const st = S.state;
  const races = arr(st.config.races);
  const ticks = loadPref('checklist', {});
  const steps = setupSteps(st);
  const sig = JSON.stringify([rrTarget(st), inputPorts(st), races.map((r) => [r.name, arr(r.splits).length, r.inputPort]), st.config.lif, st.config.names, ticks, st.version, steps,
    S.meetFiles.at, S.viewOnly, st.dataDir, st.app ?? null, st.update ?? null]);
  paintSig(PANELS.help, sig, () => {
    const items = helpChecklist(st);
    const done = items.filter(([k]) => ticks[k]).length;
    const tagWindow = str(st.config?.filter?.tagWindowSec ?? 10);
    const card = (id, title, ...kids) => h('section', { class: 'card help-card', id: 'help-' + id, 'aria-labelledby': `help-${id}-h` }, h('h2', { id: `help-${id}-h` }, title), ...kids);
    const dl = (pairs) => h('dl', { class: 'trouble' }, pairs.flatMap(([t, d]) => [h('dt', {}, t), h('dd', {}, d)]));
    return [
      h('div', { class: 'page-head' }, h('h1', {}, 'Help'), h('p', { class: 'meta' }, 'The README next to start.bat has all of this too.')),
      h('div', { class: 'help-layout' },
        h('nav', { class: 'help-toc', 'aria-label': 'Help sections' }, HELP_SECTIONS.map(([k, l]) => h('a', { href: '#help/' + k }, l))),
        h('div', { class: 'help-main' },
          card('update', 'Version and updates', updateCard(st)),
          card('setup', 'Setup checklist',
            h('p', { class: 'help' }, 'Once per meet. Each step ticks itself when Split Relay sees it done; the Dashboard shows this list until then.'),
            h('ol', { class: 'steps' }, steps.map((s, i) => setupStep(st, { ...s, done: s.done }, i)))),
          card('checklist', 'Race-day checklist',
            h('div', { class: 'row-between' },
              h('p', { class: 'help' }, `${done} of ${items.length} done. Ticks are remembered on this computer only.`),
              h('button', { type: 'button', class: 'btn small', onclick: () => { savePref('checklist', {}); scheduleRender(); } }, 'Untick all')),
            h('ol', { class: 'checklist', style: 'margin-top:8px' }, items.map(([k, text]) => {
              // one line each; the whole item (addresses, the expression, the numbers) behind its "?"
              const [btn, body] = moreParts('chk-' + k, CHECKLIST_SHORT[k] ? text : '', `More about: ${CHECKLIST_SHORT[k] || text}`);
              return h('li', {},
                h('div', { class: 'check-row' },
                  h('label', { class: 'check-label' },
                    h('input', { type: 'checkbox', 'data-fk': 'chk-' + k, checked: !!ticks[k], onchange: (e) => { const t = loadPref('checklist', {}); t[k] = e.target.checked; savePref('checklist', t); scheduleRender(); } }),
                    h('span', {}, CHECKLIST_SHORT[k] || text)),
                  btn),
                body);
            })),
            h('p', { class: 'help' }, 'The exporter settings and the expression to copy are on the ', h('a', { href: '#inputs/exporter' }, 'Inputs page'), '.')),
          card('splits', 'How reads become splits', dl([
            ['RR12 sends the bib and the time', `The RR12 exporter sends the FinishLynx LapTime line: a bib and a time of day, nothing else. Split Relay counts each runner's passes over the split mats. Reads of one runner within the tag filter window (${tagWindow} s: the A and B mats) are one pass, timed by the earliest read. The first pass is split 1, the next split 2, and so on.`],
            ['Set the number of splits', 'On the Races page, set each race\'s number of splits: how many times a runner passes the split mats before the finish. A pass after the last split is ignored (“Extra pass”). Set the same number in TrackScore (Intermediate splits) and in Karmarush.'],
            ['Laps to go: never 0', 'TrackScore and Karmarush put each split in a column by laps to go: with 3 splits, split 1 goes out as 3, split 2 as 2, split 3 as 1. Laps to go 0 means the finish, so Split Relay never sends a split with it, and never one with a finish time. Changing the number of splits after splits went out puts those in the wrong columns: the race tile then offers a resend. ' + RESEND_LIMIT],
            ['Splits you collect but don\'t send', 'A mat whose time is not worth showing (one about 200 m after a K marker, say) still has to be counted: without it every later pass of a runner would land a split early. Give it its own split on the Races page, where it is on the course (the + on a row adds a split after it), and switch its Send off. It then says Not sent: its passes are counted and shown here, and nothing of it goes to TrackScore, Karmarush or the merged .lif file. The other splits\' laps to go count only the splits that are sent, and so does the number of splits to set in TrackScore and Karmarush. The lap time of a split is the time since the runner\'s last split that was sent. Switching Send on or off after splits went out changes the laps to go of the others: the race tile then offers a resend, as after a change of the number of splits.'],
            ['Two mats close together', 'The tag filter makes one pass of the reads of one runner that come within its window (Settings → Tag filter). When two mats are close on the course, a fast runner gets from one to the other inside that window: the second pass is merged into the first, the runner\'s later passes land a split early, and a slower runner\'s do not. Set the tag filter below the fastest runner\'s time between the two mats (a fast runner covers 200 m in about 35 s; the A and B mats of one split read a runner a second or two apart). The Dashboard says so under Needs attention when reads that came 15 s or more after the runner\'s last one were merged.'],
            ['A missed mat', 'If a runner can miss a mat, give the splits an earliest race time (Races page, Advanced, for example 8:00 for split 2). A pass after that time is at least that split, so one missed mat does not shift the later splits. A pass before the next split\'s earliest time is ignored (“Too early for this split”).'],
            ['Two races at the same time', 'Add a second exporter in RR12, filtered to that race, sending to a second port (Inputs page: Add a port), and choose that port on the race. One port feeds one Active race at a time.'],
            ['The next race on the same port', 'When a race is over and the next one starts on the same port, press “Switch to …” on the Dashboard (or on the race): the next race becomes Active and the finished one is unticked. It keeps its reads, and its merged .lif file keeps its splits.'],
            ['Names on the split boards', "The LapTime line has no names. Load the meet's names file first (Settings → Names file → Choose…: FinishLynx's .ppl for this meet): TrackScore and the live results then show each runner's name, school and gender, spelled exactly as FinishLynx has them. Once FinishLynx's folder is set (Merged .lif files), the .ppl files in it are offered with their date."],
          ])),
          card('review', 'Pause a split, and runners who missed a mat', dl([
            ['Pause a split point', 'Each split tile on the Dashboard (and each split on the race page) has a ⏸ Pause button. Use it when a split point is in trouble: a mat down, a mat reading the wrong runners, a split you want to check first. A paused split is still worked out and counted (the tile says "Paused · 14 held"), but nothing of it goes to TrackScore or the live results, and it is left out of the merged .lif file (feed: “Split paused”). Press ▶ Play and everything it held goes out at once. Play first reads FinishLynx\'s results (a few seconds at most; the button says “Playing…”), so a runner who finished meanwhile, even a moment ago, is not sent live (that would replace their finish place); Review lists them. A finish FinishLynx has not saved yet shows up there a moment later (“Sent after the runner finished”).'],
            ['Review: missing splits', 'A runner is missing a split when they have a later split, or a FinishLynx finish, but no time at that split: a mat missed them. The race tile\'s Review button says how many wait. Review shows each one with a made-up time: Split Relay takes the runner\'s split before and after it (or the gun and the finish) and places the missing one like the 30 runners nearest in pace; the line under it says how. Check it, type another time if you know better (a “Typed time”), and press Send (Enter sends too). “Send all” sends every row that has a time, after one dialog that says how many and where they go. A row with no estimate yet is waiting for the runner\'s next split or the finish.'],
            ['What a made-up time means for the results', 'A made-up time is an estimate, not a timed split. Once sent, TrackScore, the live results and the merged .lif file (so XC-Analytics and the web results) show it like any other split, and it is ranked with the real ones. Only Review (and the log) say which times were made up. The finish time and place come from FinishLynx and are never changed. If a real read for that split comes in later, it replaces the made-up time by itself. Remove takes one back out of Split Relay and the .lif file, but TrackScore and the live results keep a time they were sent until the race is cleared there.'],
            ['Runners who have finished', 'A split packet carries a place, and TrackScore takes it as the runner\'s place. So a made-up time for a runner who has finished goes with their FinishLynx finish place (the dialog says so), and TrackScore keeps it. It also becomes the runner\'s place at that split in TrackScore: a packet carries only one place. Without a known finish place (no merged .lif file yet) it can\'t be sent: the row says why. Real splits that came after the runner finished are listed under “Finished: not sent live”, with “Send with finish place”, and so are splits that went out with an old time before a Move corrected them (“Sent with an old time”) or just after the runner finished, with the split place (“Sent after the runner finished”).'],
            ['Passes to check', 'Split Relay counts passes in order, so a runner who missed the first mat would get their second pass in the first column. It compares each runner with the field, and when a pass clearly belongs in another column it holds that pass (not sent, not in the .lif file; feed: “Check column”) and asks in Review: “Move to 2K” or “Keep in 1K”. Your choice sticks, and later passes are counted around it. A runner\'s first pass that is well behind everybody at the first split but fits the runners at the second is held before it goes out; their next pass (or finish) settles it, so you don\'t have to decide at once. When RR12 sends the finish line too, a held runner stays held when the finish pass comes (it would sit in the last split; from the fourth finisher on, once three have shown the finish line is in the stream), and “Missed 2400m: add it” on the first row settles all of their passes at once (“Missed 1500m and 2400m: add them” for two in a row: Split Relay counts how many from all of the runner\'s later times). Two or three mats missed in a row are held too, before anything goes out: the time is far behind everybody in the split it is counted in and in the next one, and right where the runner\'s first time puts her two or three splits on (“Looks like 3.4K, not 2K (missed 2K and 2.6K?)”).'],
            ['A missed first mat Split Relay can\'t tell', 'One pass says only "this bib crossed a mat now". A leader who missed the first mat crosses the second one while the slowest runners are still reaching the first: that pass fits both splits, so it goes out as split 1 (most common in races with 2 splits). After the finish, Review knows better: “Missed 800m: add it” on that cell moves the passes on and sends the made-up 800m time, which replaces the wrong cell in TrackScore and the live results.'],
            ['Fix a runner', 'Type the bib in the box at the top (B). Each split is a cell: Enter sends a suggested time, or opens the choices for a time. Move puts a time in another split, and the times after it move with it. Not a split and This is the finish take a pass out of the columns. Every change goes out at once, into the merged .lif file, and Undo (Ctrl+Z) puts it back. A cell TrackScore was sent stays filled there: a packet can fill a cell but never empty one. Undo the fix of a runner from Passes to check and their passes are held there again: TrackScore keeps what the fix sent until you choose (Undo asks first); a held pass that never went out there says what the boards show instead (“It never went out: TrackScore and the live results show 4:50.8 at 1500m.”). A split that can\'t be filled yet says which time to check first and how (“Check bib 488\'s 4200m first: 16:33.7 is held (it looks like 4400m). Choose “It\'s right: keep it in 4200m” or Move it in its menu; then 4400m can be filled.”).'],
            ['A runner who missed a mat: “Missed 2400m: add it”', 'When a mat missed a runner, the time in that split is really the next split\'s, and every later time sits one column early. The cell where Split Relay thinks it happened says “Missed here?” (Passes to check and Splits that look wrong say it too), and its first choice is “Missed 2400m: add it”: in one change the time in 2400m and the later ones move on one split, and 2400m gets the suggested time (made up from the split before it and the time that moved on, placed like the runners nearest in pace), or the time you type (“type its time…”). A time moved past the last split is an extra pass, never a split with laps to go 0 (when RR12 sends the finish line, the first one is the runner\'s finish: “→ extra pass (the finish)”). TrackScore and Karmarush get every changed split at once, each in its own column, and the runner\'s furthest split last, so they show the runner\'s place there. One Undo puts it all back. Every split of every runner has it in its choices, also where Split Relay saw nothing. A runner who has finished: with the finish place known it goes with the finish place (asked first); without one it can\'t go live. For the last split this works with merged .lif files off too: the finish pass that sat in 5300m becomes an extra pass, so the runner is not finished for Split Relay, and 5300m goes with its own place. If you marked that pass as the finish already, the empty 5300m cell offers the same (“→ extra pass (the finish pass, no longer the finish you marked)”), and another split that waited for a finish place (800m, say) can be filled after it: its cell says so. A finisher\'s fix goes out with the finish place, each split once, in course order, the furthest last. A choice that leaves a time where Split Relay would hold it says so first (“21:46.1 → 5300m (held: it looks like the finish)”): that time is not sent, and its own one click follows.'],
            ['How many mats in a row', 'Split Relay works out how many splits a mat missed from all of the runner\'s later times: for each count it moves every later time on that many splits (past the last split, the first is the finish when RR12 sends the finish line, the rest extra passes) and measures each leg against the runners of the same pace. When one count fits clearly best it is the one click (“Missed 2400m and 3100m: add them”). When two fit about as well, the row says “Split Relay can\'t tell which” and offers both, each with what it does, neither as the one click: the runner\'s next time usually settles it, or you choose. A time you type for a split moves a made-up time that is out of order with it out of the way (made up again in its new stretch, or taken out), and the toast says so.'],
            ['Where the run of missed mats starts', 'Passes to check and Splits that look wrong point at the time they doubt, which is not always the first time that moved on: a runner who missed 4200m and 4400m can have its 5300m time in 4200m among the slowest runners\' times there (it went out as 4200m) and only its finish held in 4400m. Split Relay places all of the runner\'s times from every split where the run could start, and the one click is where they fit clearly best: that cell says “Missed here?”, and the row of the runner\'s first held time carries it (“19:41.6 looks like 5300m, not 4200m (missed 4200m and 4400m?) …; 22:29.3 moves on with it (the finish)”). Its one click sends 4200m and 4400m made up and 19:41.6 as 5300m. Two mats missed apart are one change too: “Missed 4200m and 5300m: add them (4400m was read)” makes up 4200m and 5300m and sends 4200m, 4400m and 5300m once each, with their laps to go, the furthest last; the row says which times move (“15:08.2 looks like 4400m, not 4200m, and 20:43.5 like the finish, not 4400m (missed 4200m and 5300m?)”). On the course the one click is the first mat alone until the runner\'s times after the second are in, and once the runner\'s finish would be in by now, a set that leaves the runner on the course counts the finish mat as missed too. A finisher\'s finish read held in a split (within 10 s of the FinishLynx finish) is that finish: every split from there on was missed (“21:44.4 looks like the finish, not 4200m (missed 4200m, 4400m and 5300m?)”), also with another mat missed before it: one change (“Missed 3100m and 5300m: add them (4200m and 4400m were read)”). The first split has no time before it: a time there far behind every other runner (491\'s 1500m time, 6:03.9, in 800m where everyone else was by 3:08) is no fit for a set that leaves it there; a late starter or a walker whose mats all read is never moved for being slow. When another start, or the times as they are, fit about as well, nothing is the one click (“can\'t tell yet where”): the runner\'s next time usually tells, or you choose; the set that fits best with all of the runner\'s times is offered beside the cell\'s own when it is another one. When two sets of missed mats fit about as well (a walker: 4200m and 5300m apart, or 4400m and 5300m in a row; 4400m alone, or 4200m and 5300m), both are offered, each with what it does, and neither is the one click (“can\'t tell which mats missed the runner”; the menu heads them “Split Relay can\'t tell which”): choose the one its times say. Many splits read between two mats are said as a stretch (“1500m to 4400m were read”). The editor opens on the cell that says “Missed here?”, a time held after it offers that cell\'s one click first, and the editor counts a missed mat as one thing that looks wrong, whatever the held times after it. A time held before it keeps its own Move, but not as the one click, in its menu, the editor and its Review row: the missed mat\'s fix usually settles it (539, a late starter who missed 2400m: once 2400m was added, its 800m and 1500m went out as read).'],
            ['A runner who started late', 'A runner who started minutes after the gun, every mat read, has every time late by the same minutes, so its first times are far behind everyone (and, once FinishLynx has its finish, behind where the field\'s finish says they belong). Split Relay measures its times from split to split: when every leg fits the course as read, like the runners of the same pace on that stretch, and clearly better than with a mat missed, it started late. Nothing is held, nothing is offered, every split goes out as read, and the line under its name says it quietly (“started about 5:00 after the gun?”): nothing to do. On the course its first time waits for its second (a missed first mat looks just the same until then); it goes out with the second when that leg was run faster than the leaders could have run it a split on, else with the third once its legs fit the course as read closely. Until Split Relay can tell, “Missed 800m: add it” is offered but never the one click (“Split Relay can\'t tell a missed mat from a late start”): choose it only if the runner started with the others. So too after the race on a course of even splits, where the legs can\'t tell, and for a late starter who missed a mat later: both are offered (“Missed 800m: add it if the runner started with the others, or Missed 2400m: add it if it started late”). A late starter whose first mat missed it has that split made up from its start, not the gun. Its later splits are measured from its start too: a late starter who missed 4400m (or 4200m and 5300m) has a good 4200m time that looks late from the gun; the set its legs fit is the one click only when it fits clearly better than the others, else both are offered (“Split Relay can\'t tell which mats missed the runner”), never “Missed 4200m” as the one click. A wrong fix taken back (a Move back, or Undo) sends every split it changed again, as read.'],
            ['A slow leg', 'A runner who lost minutes on one leg (a fall, a stop), every mat read, has a time that looks like a later split\'s, as if a mat missed it. Split Relay weighs that leg like a late start: the runner\'s times as read with that one leg left out (up to 5 minutes lost) against every set of missed mats; a missed mat is the one click only when it fits clearly better. On the course the time waits for the runner\'s next one (“Split Relay can\'t tell a missed mat from a slow leg until the runner\'s next pass”), and that one must fit where the missed mat would put it (three minutes lost from 800m to 1500m put the 1500m time where 2400m\'s belong; only the next time tells); once two later times fit the course as read, the held times go out as read during the race, and “Missed 2400m: add it” stays offered, never the one click (“Split Relay can\'t tell a missed mat from a slow leg (1500m to 2400m took 2:30 longer than runners of the same pace, and its later times fit as read): choose … only if a mat missed the runner”; the menu heads it “Split Relay can\'t tell: a missed mat or a slow leg”). The line under the name may say it quietly (“about 2:30 lost before 2400m?”). A slow last leg whose pass looks like the finish waits for the stream\'s finish pass after it; when that pass comes about when the runner\'s finish would after its 5300m time, Split Relay can\'t tell a slow leg from a missed 5300m and a cool-down pass: no sure “Missed 5300m”. Once FinishLynx\'s finish shows the time was 5300m\'s, it goes to TrackScore and Karmarush by itself, with the finish place (no Send with finish place needed; for a runner with every split read and no time that looks like a stray pass). A time that fits neither split well stays offered until the runner\'s finish (“… until the runner\'s finish”): a real missed mat\'s time nearly always fits the next split like the runners of its pace. Once the runner\'s finish is known (FinishLynx\'s, with its finish read) and every split has its time before it, no mat can have missed it: nothing is held and nothing is offered, every split stays as read.'],
            ['A stray pass', 'A second read of a runner 30 s to a minute and a half after a mat (later than the tag window) is counted as the next split, and every later time sits a split early. With a mat missed as well, the stray makes up for it in the count: every column filled. Split Relay checks the legs, not only the count: a leg far shorter than the leaders\' on that stretch (under three quarters of it), or, with every column filled, far shorter than the runner\'s own pace on its other legs (under 0.8 of it), is a stray pass, and the one click sets it aside in the same change: “Missed 2400m: add it (11:24.4 is a stray pass)”, the row saying “11:24.4 is a stray pass, 0:40 after 10:44.4.” and the choice what it does (“10:44.4 → 3100m, 11:24.4 → not a split”): 2400m made up, every later split right, the stray in no column. On the course the one click waits for the runner\'s next time after a stray: only that time shows it. A runner with every mat read and a stray pass is listed under Splits that look wrong (“3:24.8 comes soon after 800m for 1500m”), nothing held: Not a split for the stray is its one click when the leg is under a quarter of the runners\' of its pace, else a plain choice beside It\'s right in that row (and in the cell\'s choices). Around the 200 m from 4200m to 4400m a stray takes no longer than a real leg: with 4200m missed, a stray a minute after the 4400m pass shows only in the 900 m on to 5300m, a minute short of the runner\'s own pace; one under a minute after it can still look complete, and its cells\' own choices fix it by hand. A stray before the missed mat (a read 30 s after the 4200m pass with 4400m missed: the read counted in 4400m) is one change too once the runner\'s finish is known: “Missed 4400m: add it (18:36.8 is a stray pass)”, the row saying the stray first (“18:36.8 is a stray pass, 0:30 after 18:06.8. 23:02.0 looks like 5300m, not 4400m (missed 4400m?)”). A set that sets a stray aside is the one click only when the runner\'s times fit it clearly better than as they were read: a runner who ran one leg very fast, every mat read, has a time that looks like a stray, so the set is offered, never the one click (the row says “15:41.6 may be a stray pass, 0:38 after 15:04.1.”, then “Split Relay can\'t tell a stray pass from a fast leg”; the menu heads it “Split Relay can\'t tell: a stray pass or a fast leg”): choose it only if the runner was not that fast. A Move that a stray pass is in the way of names it: “If 9:53.7 is a stray pass (it came soon after the pass before it), choose Not a split for it first.”'],
            ['Typing one missed split', 'One missed split can always be typed by hand from the cell that holds the later time, also where Split Relay offers only sets of several splits: “Missed 800m: type its time…” fills that split alone and moves the later times on one split (“the later times move on one split”), every split it changes sent again. Three mats missed apart, one read between each, are one change (“Missed 800m, 2400m and 4200m: add them (1500m and 3100m were read)”); when that is offered and not the one click, type the first one and the runner\'s choices then offer the rest.'],
            ['A made-up time that doesn\'t fit', 'When a runner\'s later times don\'t fit a made-up time (a fix with too few splits, say), Splits that look wrong lists it with its fix, never Not a split for the real time after it: “2400m\'s made-up 11:00.0 doesn\'t fit: 15:18.4 looks like 4200m, not 3100m (missed 2400m and 3100m?)”. Its one click makes 2400m up again, adds 3100m and moves the later times on, every changed split sent again. A real time set aside as Not a split by mistake comes back with Undo, or in Other passes with “Let Split Relay count it”. A time you moved yourself is looked at once a time you type before it makes its leg look wrong (“You moved 18:07.1 to 4400m, but it looks like 5300m”): its one click moves it on, “It\'s right” keeps your Move.'],
            ['A missed split that comes later', 'When RR12 sends the missing read later (it was queued, or a Replay), Split Relay counts the runner\'s passes again and sends every split that changed by itself, whenever that is, each with its laps to go, and the runner\'s furthest split last. A real read of a split you filled replaces the made-up time on the boards the same way. Only the places of other runners at an old split wait for Resend (the race tile says how many).'],
            ['Splits that look wrong', 'Review compares each runner\'s legs with the runners of the same pace and lists a split whose leg is far too long (a missed mat: the time is a later split, or the finish) or far too short (a stray pass), with the runners\' time to the split it looks like. It is advice: nothing is held. One click does what it suggests (for a missed mat: “Missed 2400m: add it”, as many splits as the runner\'s later times fit); "It\'s right" says it is not wrong. When a leg looks wrong because of something before it, it lists that instead, with its fix: a made-up time that doesn\'t fit, or the first two mats missed (every time two splits early). A runner whose first time is far behind every other runner at the first split is listed too, also when no leg looks wrong (“8:49.0 looks like 2400m, not 800m, and 16:42.2 like 4400m, not 2400m (missed 800m, 1500m and 4200m?)”).'],
            ['A split too fast to be real', 'Split Relay checks every split as its read comes in: the time since the runner\'s split before against the leaders\' on that stretch, and against the runner\'s own pace so far. A leg faster than the leaders ran it (under 0.95 of theirs), from a runner who was not running with them (under 0.88 of the runner\'s own pace), is too fast to be real: a runner who dropped out and walked over a mat, a chip carried across. Nothing is held: the split goes out like any other. From that moment Needs attention says “Bib 142: a split too fast to be real”, the race tile\'s Review count goes up, the cell in the grid is marked, and Splits that look wrong has one row for the runner: “Bib 142, 4.4K 15:36.4: 3:01.7 after 3.4K, where the leaders took 3:21; 5K 17:06.3: 1:29.9 after 4.4K, where the leaders took 2:09. Too fast for a runner who was 74th: not splits?” Not a split takes every time of the row back in one change (they leave the merged .lif file, and the other runners\' places go out again by themselves); Stop sending this runner takes them back and keeps the runner off the boards; It\'s right leaves them. Pressed when only the first time is in, Not a split lets the runner\'s next read take that split: it goes out, and is marked too when it comes slow for the runner (“it follows 15:36.4, which was not a split: is it 4.4K?”). A runner far ahead of the field, a strong last leg from far back, a runner who slows down and a runner a mat missed are not marked.'],
            ['Stop sending this runner', 'For a runner who is off the course (dropped out, or an athlete of another race walking over the mats): the button at the top of the runner, on the row of a split too fast to be real or a stray pass, and in that split\'s choices. From that time on nothing of the runner goes to TrackScore or the live results or into the merged .lif file. The reads are still read, counted and shown: the cells say “Not sending”, the grid says “Not sending from 15:36.4 on”, Review lists the runner under Not sending, and the feed says “Not sending”. They no longer count for the places of the others. Pressed on a marked split it starts there: that split and the later ones are taken back (“Not sent from 15:36.4 on (4.4K and 5K taken back)”). Pressed on a runner with nothing marked, it is for what comes after the runner\'s last time (“Not sent after 12:34.7”): what went out stays. Send this runner again puts it back, and what was held goes out if it still fits. Undo works, and it holds across a restart.'],
            ['The boards after a fix', 'After Not a split, a Move, “Missed …: add it”, a fill, an Undo or Stop sending this runner, Split Relay puts the boards right by itself: the runner\'s own changed splits go out, and every line of the other runners whose place the change moved goes out again with its new place, each of those runners\' furthest split last (TrackScore shows a runner\'s place from its newest line). The toast says how many: “51 lines of other runners re-sent with their new places.” A finished runner\'s real splits are left alone, as with Resend, and a split that was taken back stays on TrackScore: a packet can fill a cell but never empty one. Outputs has “Send a clearing line when a split is taken back” (off) for a receiver that can blank a cell: the runner\'s row for that split goes out once more with an empty time and place. TrackScore ignores such a row today.'],
            ['Start lists', 'RR12 sends a bib and a time, nothing about the race: a read belongs to the race that is Active on its port, so an athlete of another race who jogs over a mat becomes a split of the race that is running. Load the meet\'s entry files on the Races page (Load start lists…, or drop them on the page): one text file per event, named by its event number (1.txt, 2.txt), with a header line and one line per athlete, the bib first (NO.;FIRST NAME;LAST NAME;…;EVENT;…). Split Relay keeps only the bibs of each event, in its data folder, and a race gets the list of its event number. The page says what each file held (“1.txt: 108 athletes entered in event 1 (Men\'s 8K).”) and lists each race with its count. Loading a file again replaces that event\'s list, Remove takes it away, and Start a new meet puts the lists away with the old meet. A list that does not fit a race does nothing there: once five runners are through and fewer than half of them are on it (or three and none), it is not used, everybody is sent as without a list, and Needs attention says “The start list does not match Girls 2A (12 of 40 runners are on it): not used.” A list loaded more than 6 days ago is not used either.'],
            ['Not in this race', 'With a start list in use, an athlete entered in another race who is read in this one is kept off the boards: the reads are counted and shown, nothing of them goes to TrackScore, the live results or the merged .lif file, and they take nobody\'s place. The race tile counts them quietly (“22 not in this race”), the feed says “Not in this race”, and Review lists them under Not in this race with the race they are entered in. Count them here sends their splits like any runner\'s; Undo puts it back. Settings, Start lists has “Send and flag” instead: they go out, each with a row in Review whose one click is Not in this race. A runner on no start list (a late entry, a spare chip) is sent as always, with a quiet row under Not on the start list. Without a start list Split Relay remembers the day: a bib that ran another race today (most of its splits) is flagged when it is read in this one (“Bib 213 ran in Boys 2A today: not in this race?”). Nothing is held. Not in this race takes its lines back, sends the other runners\' places again and keeps its later reads here off the boards; It\'s right leaves it.'],
            ['All runners', 'Review\'s second view: every runner by split, those with something to fix first. A missing cell fills in place (Enter sends the suggested time); any other cell opens the runner with its choices.'],
          ])),
          card('glossary', 'What the status words mean',
            h('table', { class: 'glossary' },
              h('tbody', {}, STATUS_ORDER.map((k) => h('tr', {}, h('th', { scope: 'row' }, statusWord(k)), h('td', {}, STATUS[k].meaning))))),
            h('p', { class: 'help' }, 'Filtered reads (backup, duplicate, repeat, start area) are hidden in the live feed unless “Filtered reads” is on. The feed shows a short word; point at it, or open the row, for the whole story.')),
          card('lights', 'The status lights at the top',
            h('ul', { class: 'legend-list' },
              h('li', {}, h('span', { class: 'dot tone-ok' }), h('strong', {}, 'Green'), ' working: receiving reads, connected.'),
              h('li', {}, h('span', { class: 'dot tone-warn' }), h('strong', {}, 'Amber'), ' waiting: RR12 not connected yet, an output still connecting.'),
              h('li', {}, h('span', { class: 'dot tone-bad' }), h('strong', {}, 'Red'), ' a problem to fix. Click the light to go to it.'),
              h('li', {}, h('span', { class: 'dot tone-muted' }), h('strong', {}, 'Grey'), ' switched off, or a spare RR12 port no Active race reads from.')),
            h('p', { class: 'help' }, 'Point at a light for the details. “Live” at the far right means this page is connected to Split Relay. In a narrow window, or with many ports or outputs, the lights get shorter names, then only a dot and the name, then one light for all the ports or outputs with a dot each (“IN ●●● 3 ports”): point at it for the list.')),
          card('notes', 'Good to know', dl([
            ['Meet setup: save, load, start a new meet', "Save meet setup (Races page or Settings → Meet setup) writes the races, outputs, RR12 ports, names file and folders to data\\meets\\<meet name>.json, and your browser downloads a copy: never gun times, reads or Pause. Load meet file… (or a .json dropped on the page), a saved meet in one click, or Set up from TrackScore (its Race Setup: names, events, distances and split points) always shows what changes first, and changes nothing until Apply. A load never deletes a race that has reads, and sends nothing. Start a new meet… (Settings → Meet setup) puts the last meet's reads away (a copy goes to data\\archive) and clears every gun time: do it before loading the next meet."],
            ['Keyboard', h('span', { class: 'keys' }, SHORTCUTS.map(([k, what]) => h('span', { class: 'key-row' }, h('kbd', {}, k), ` ${what}`)))],
            ['Gun times', 'The gun time is exactly what you type: Split Relay never fills it in from a clock. Type it from the start clock, or press “FinishLynx start into the box” once FinishLynx has the start, check it, and press Set. A wrong gun time puts every split off by the difference.'],
            ['Race names', 'Type each race\'s name exactly as FinishLynx\'s event name. Once FinishLynx writes its file, the merged .lif file carries FinishLynx\'s name, and TrackScore treats a new name as a new race.'],
            ['TrackScore\'s file watch', 'While TrackScore watches a results file for a race, it ignores port 5555 and shows only runners with a place, as with FinishLynx\'s own files. Runners still on the course appear when they finish. Live splits during the race come over port 5555.'],
            ['Runners who have finished', 'Split Relay doesn\'t send a split live for a runner who has finished: TrackScore would replace their finish place with the split place. Those splits are still in the merged .lif files. A resend leaves them out too, unless you tick its box. Review lists them under “Finished: not sent live” (also a split TrackScore has with an old time), with “Send with finish place”.'],
            ['Advanced: timing point names (SR lines)', 'An RR12 exporter can send timing point names, contests and names instead (Inputs page, Advanced). Each race then maps timing points to its splits (A and B mats per split), contests choose the race, and a loop course gives each pass its own timing point name (for example Loop-1 and Loop-2).'],
          ])),
          card('trouble', 'If something goes wrong', dl([
            ['The races are gone after a restart', `${dataDirText(st) || 'This copy of Split Relay keeps its data in the folder the Races page names.'} If that isn't the folder you used before, you started another copy of Split Relay: close it and start the one you used (its start.bat), or load your meet file, or that copy's data\\config.json, with Load meet file….`],
            ['“Lost connection to Split Relay”', 'The Split Relay window was closed or the PC is busy. Start it again (start.bat). RR12 keeps its reads and sends them when Split Relay is back, and repeats are ignored.'],
            ['TrackScore shows splits with no names or schools', "No names file was loaded (the race tiles say “No names”). Press “Choose names file…” in Needs attention and pick the meet's .ppl. Then press “Send names now” on the race: its splits go again, now with names. Runners who have finished already have theirs from FinishLynx."],
            ['Splits in the wrong TrackScore or Karmarush column', 'The number of splits in TrackScore (Intermediate splits) and Karmarush must be the race\'s number of splits here. After changing it, resend the race\'s splits (the race tile offers it). ' + RESEND_LIMIT + ' The race tile says how many such cells there are, and for which runners.'],
            ['Every runner gets an “Extra pass”', 'The RR12 exporter probably sends the finish too: it must send the split mats only (A and B). Or the course has more split passes than the race\'s number of splits: raise it on the Races page.'],
            ['The gun time was wrong', 'Fix it on the race tile or the race page. If splits already sent are out of date, the race tile offers “Resend splits” (it counts each runner\'s split once, whatever the outputs, and names them; the Resend dialog and its toast say how many it sends). Runners who have finished are left out unless you tick the box, so their finish place in TrackScore stays: Review lists their splits under “Finished: not sent live”, to send with the finish place. ' + RESEND_LIMIT],
            ['Reads show “No race”', 'No Active race reads from the port they came in on (or, for SR lines, takes their contest). Choose that port on the race and tick Active (or press Switch to); the earlier reads count there too.'],
            ['Reads show “Race paused”', 'Their race is not Active. Either it had them when you turned off Active (it keeps them), or only races that are not Active take them: they wait, not used. Turn on Active on the race (or press “Switch to …”) to use them all.'],
            ['Reads show “Unmapped”', 'SR lines only: that timing point name is not in any of the race\'s splits. Add it with “+ add” on the split; its earlier reads count too.'],
            ['A red warning: a race “isn\'t in the settings”', 'config.json was damaged and Split Relay started with its backup (config.json.bak), or the file was edited. The race was not deleted: its reads wait for it. Press “Put it back” on the warning: the race comes back with the settings kept in its file in data\\races, and its reads with it. A damaged config.json is kept as data\\config.broken-….json. Delete the race there only if you don\'t want it back.'],
            ['Reads show “Set aside (not used)”', 'Their race was deleted, or no longer lists their contest. None of that contest\'s reads is used, the new ones too, until you list the contest on an Active race: then they all count there (listed on a race that is not Active, they wait for it). The Dashboard has a button for it.'],
            ['Reads show “Race deleted (not used)”', 'Their race was deleted. Those reads are not used again, even if you add the race again. Next time, turn off Active to stop a race: a race that is not Active keeps its reads, and its merged .lif file keeps its splits.'],
            ['Reads show “Bad line”', 'RR12\'s Export Data expression is not the one on the Inputs page. Copy it again and paste it into the exporter.'],
            ['Pressing Replay in RR12', 'Safe: reads Split Relay already has show as Duplicate and change nothing. After “Clear race data”, a Replay sends the race again: its reads count again.'],
            ['TrackScore hung or was restarted', 'Nothing to do: when its connection comes back, Split Relay sends the splits of the minute before the drop again, in case TrackScore never read them. A repeated split changes nothing in TrackScore.'],
          ])),
          h('p', { class: 'help center' }, `Split Relay${st.version != null ? ` · config version ${st.version}` : ''}`))),
    ];
  });
  const anchor = HELP_SECTIONS.some(([k]) => k === S.route.id) ? '#help-' + S.route.id : '';
  if (anchor && S.helpScrolled !== S.route.id) {
    S.helpScrolled = S.route.id;
    const el = $(anchor);
    if (el) reveal(el);
  } else if (!anchor) S.helpScrolled = false;
  helpSpy();
}

/** The Help contents column marks the section on screen, as the page scrolls. */
function helpSpy() {
  if (S.route.tab !== 'help') return;
  const top = (parseFloat(document.documentElement.style.getPropertyValue('--sticky-h')) || 0) + 96;
  let current = HELP_SECTIONS[0][0];
  for (const [k] of HELP_SECTIONS) {
    const el = document.getElementById('help-' + k);
    if (el && el.getBoundingClientRect().top <= top) current = k;
  }
  // at the bottom of the page the last section is the one being read, however short it is
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = HELP_SECTIONS[HELP_SECTIONS.length - 1][0];
  for (const a of PANELS.help.querySelectorAll('.help-toc a')) {
    const on = a.getAttribute('href') === '#help/' + current;
    if (on) a.setAttribute('aria-current', 'location');
    else a.removeAttribute('aria-current');
  }
}

/* ============================================================================================================ */
/* Boot                                                                                                         */

/** Whether a key press belongs to a box being typed in (or a control that uses keys itself). */
const typingIn = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * The page's keys: B finds a runner (9.23), "/" finds (the feed search on the Dashboard, the runner box elsewhere), R
 * opens Review, 1 to 7 open the pages, Esc closes the output editor. Never while typing in a box, with a modifier held,
 * or with a dialog open; never a key a part of the page used itself (the runner editor's digits, say).
 */
function pageKeys(e) {
  if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (EL.drawer && !EL.drawer.hidden) {
      e.preventDefault();
      closeDrawer();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || typingIn(document.activeElement)) return;
  if (e.key === 'b' || e.key === 'B') {
    // 9.23 F1: find a runner, on every page
    if (focusRunnerFind()) e.preventDefault();
  } else if (e.key === '/') {
    // the feed's search on the Dashboard, the runner box everywhere else
    if (S.route.tab === 'live' && $('#feed-search')) {
      e.preventDefault();
      $('#feed-search').focus();
      $('#feed-search').select?.();
    } else if (focusRunnerFind()) e.preventDefault();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    go('#review');
  } else if (/^[1-7]$/.test(e.key)) {
    const a = EL.nav[Number(e.key) - 1];
    if (a) {
      e.preventDefault();
      go(a.getAttribute('href') || '#' + TABS[Number(e.key) - 1]);
    }
  }
}

function boot() {
  applyTheme();
  for (const t of TABS) PANELS[t] = $('#panel-' + t);
  EL.lights = $('#lights');
  EL.conn = $('#conn');
  EL.connText = $('#conn-text');
  EL.viewChip = $('#viewonly-chip');
  EL.updateChip = $('#update-chip');
  EL.updateChipText = $('#update-chip-text');
  if (EL.updateChip) EL.updateChip.addEventListener('click', (e) => updateDialog(e.currentTarget));
  EL.nav = [...document.querySelectorAll('#rail .nav-item')];
  EL.railFoot = $('#rail-foot');
  EL.boot = $('#boot');
  EL.bannerConn = $('#banner-conn');
  EL.bannerConnWhen = $('#banner-conn-when');
  EL.setForms = {};
  EL.setLive = {};
  Object.assign(S.feedFilter, loadPref('feedFilter', {}), { search: '' });
  S.showNotes = loadPref('showNotes', false) === true;
  const kept = loadPref('decisionKept', {});
  if (kept && typeof kept === 'object') for (const [k, v] of Object.entries(kept)) if (typeof v === 'string') S.decisionKept.set(k, v);

  // Dashboard: the setup checklist; Needs attention beside the race tiles on a wide screen (above them on a narrow
  // one, first for a screen reader either way); the live feed
  EL.dashSetup = h('div', { class: 'dash-slot' });
  EL.dashAttention = h('div', { class: 'dash-att' });
  EL.dashRaces = h('div', { class: 'dash-board' });
  EL.dashTop = h('div', { class: 'dash-top' }, EL.dashAttention, EL.dashRaces);
  PANELS.live.replaceChildren(h('div', { class: 'dash' }, h('h1', { class: 'sr-only' }, 'Dashboard'), EL.dashSetup, EL.dashTop, buildFeedSection()));
  EL.dashRaces.addEventListener('pointerenter', () => { S.tilesHover = true; });
  EL.dashRaces.addEventListener('pointerleave', () => { S.tilesHover = false; scheduleRender(); });

  // Review (DESIGN 9.17 P6): the page frame is built once; the queue and Find runner are painted from the review list
  EL.reviewTitle = h('h1', { id: 'review-title', tabindex: '-1' }, 'Review');
  EL.reviewMeta = h('p', { class: 'meta', role: 'status' });
  EL.reviewRaces = h('div', { class: 'review-races' });
  EL.reviewBody = h('div', { class: 'review-main' });
  EL.reviewSide = h('aside', { class: 'review-side', 'aria-label': 'Find runner' });
  PANELS.review.replaceChildren(
    h('div', { class: 'page-head' }, EL.reviewTitle, EL.reviewMeta),
    EL.reviewRaces,
    h('div', { class: 'review-layout' }, EL.reviewBody, EL.reviewSide));
  bootRunnerFind();

  // Races
  EL.raceList = h('aside', { class: 'race-list card', 'aria-label': 'Race list' });
  EL.raceEditor = h('div', { class: 'race-editor' });
  PANELS.races.replaceChildren(h('div', { class: 'split-pane' }, EL.raceList, EL.raceEditor));

  // Outputs: cards on the page, the editor in a drawer beside it
  EL.outCards = h('div', { class: 'out-list' });
  const add = (preset) => () => { S.fromSetup = ''; startNewOutput(preset); };
  PANELS.outputs.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Outputs'),
      h('div', { class: 'add-presets' },
        h('button', { type: 'button', class: 'btn', 'data-fk': 'add-ts', onclick: add(TRACKSCORE_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'TrackScore'),
        h('button', { type: 'button', class: 'btn', 'data-fk': 'add-kr', onclick: add(KARMARUSH_PRESET) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Karmarush live results'),
        h('button', { type: 'button', class: 'btn ghost', 'data-fk': 'add-out', onclick: add(null) }, h('span', { class: 'i i-plus', 'aria-hidden': 'true' }), 'Other output'))),
    EL.outCards);
  EL.drawer = $('#drawer');
  EL.drawerTitle = h('h2', { id: 'drawer-title', class: 'drawer-title', tabindex: '-1' }, 'Output');
  EL.drawerBody = h('div', { class: 'drawer-body' });
  // opened from the setup checklist: the way back to it
  EL.drawerBack = h('a', { class: 'btn small ghost', href: '#live', hidden: true, onclick: () => { S.fromSetup = ''; } }, '← Back to setup');
  EL.drawer.replaceChildren(
    h('div', { class: 'drawer-head' }, EL.drawerTitle,
      h('span', { class: 'row' }, EL.drawerBack,
        h('button', { type: 'button', class: 'btn ghost icon-btn local', 'data-fk': 'drawer-close', 'aria-label': 'Close the editor (Esc)', title: 'Close (Esc)', onclick: closeDrawer },
          h('span', { class: 'i i-close', 'aria-hidden': 'true' })))),
    EL.drawerBody);

  // the keys that work anywhere (Help lists them); Esc closes the output editor wherever focus is
  document.addEventListener('keydown', pageKeys);
  // While the connection is lost, a button that would ask Split Relay to do something can't work: it says so at
  // once instead of failing after it was sent. Buttons that only change this page (marked "local") still work.
  document.addEventListener('click', (e) => {
    if (S.conn !== 'lost') return;
    const b = e.target.closest?.('button');
    if (!b || b.classList.contains('local') || b.closest('.topbar, .toasts, .rail, dialog') || b.disabled) return;
    if (!b.closest('main, .drawer')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast('Offline: Split Relay can\'t be reached, so nothing can be changed now. Is its window still open? This page reconnects by itself.', 'bad', 6000);
  }, true);
  window.addEventListener('scroll', () => {
    hideLightPop();
    if (S.route.tab === 'help') requestAnimationFrame(helpSpy);
  }, { passive: true });
  // Needs attention moves beside the race tiles on a wide window, above them on a narrow one
  if (typeof matchMedia === 'function') matchMedia('(min-width: 1280px)').addEventListener?.('change', () => scheduleRender());

  S.viewOnly = !LOOPBACK(location.hostname);

  // DESIGN 9.22: "Load meet file…" opens the browser's file chooser; a meet file dropped anywhere on the page is loaded
  // the same way (a preview first). The browser never opens a dropped file itself, whatever is dropped where.
  EL.meetInput = h('input', { type: 'file', accept: '.json,application/json', class: 'offscreen', tabindex: '-1', 'aria-hidden': 'true',
    onchange: (e) => { const f = e.target.files?.[0]; if (f) onMeetFile(f); } });
  EL.dropOverlay = h('div', { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'drop-box' }, h('p', { class: 'drop-title' }, 'Drop the meet file to see what it changes'),
      h('p', { class: 'drop-sub' }, 'Nothing changes until you press Apply. Entry files (1.txt, 2.txt) are loaded as the start lists.')));
  // DESIGN 9.25: "Load start lists…" opens the file chooser for the meet's entry files (several at once); entry files
  // dropped anywhere on the page are loaded the same way
  EL.entryInput = h('input', { type: 'file', multiple: true, accept: '.txt,.csv,.tsv,text/plain,text/csv', class: 'offscreen', tabindex: '-1', 'aria-hidden': 'true',
    onchange: (e) => { if (e.target.files?.length) onEntryFiles(e.target.files); } });
  document.body.append(EL.meetInput, EL.entryInput, EL.dropOverlay);
  const dragsFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const noDrop = () => S.viewOnly || !!document.querySelector('dialog[open]');
  const overDrop = (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = noDrop() ? 'none' : 'copy';
    EL.dropOverlay.hidden = noDrop();
  };
  document.addEventListener('dragenter', overDrop);
  document.addEventListener('dragover', overDrop);
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) EL.dropOverlay.hidden = true; });
  document.addEventListener('drop', (e) => {
    EL.dropOverlay.hidden = true;
    if (!dragsFiles(e)) return;
    e.preventDefault();
    if (S.viewOnly) return toast(viewOnlyText(), 'bad');
    if (document.querySelector('dialog[open]')) return;
    // (9.25: text files are the meet's entry files: the start lists; a .json is a meet file)
    const meet = pickMeetFile(e.dataTransfer.files);
    if (!meet && pickEntryFiles(e.dataTransfer.files).length) return onEntryFiles(e.dataTransfer.files);
    onMeetFile(meet);
  });
  window.addEventListener('blur', () => { EL.dropOverlay.hidden = true; });

  $('#banner-retry')?.addEventListener('click', () => {
    S.retryDelay = 1000;
    connect();
  });
  window.addEventListener('hashchange', onRoute);
  // "Send names now" answered in another tab of this PC: the offer goes here too (DESIGN 9.20 N3)
  window.addEventListener('storage', (e) => { if (!e.key || e.key.startsWith('splitRelay.namesOffer')) scheduleRender(); });
  document.addEventListener('pointerdown', () => {
    S.pointerDown = true;
    S.pointerDownAt = Date.now();
  }, true);
  const up = () => setTimeout(() => {
    S.pointerDown = false;
    if (S.renderAfterPointer) {
      S.renderAfterPointer = false;
      scheduleRender();
    }
  }, 0);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  // a pointer released outside the window never sends pointerup
  window.addEventListener('blur', up);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshState().catch(() => { markLost(); connect(); });
  });
  window.addEventListener('beforeunload', (e) => {
    if ([...S.drafts.values()].some((d) => isDirty(d) && !(d.isNew && !str(d.draft.name).trim()))) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.splitRelay = S;
  // DESIGN 9.16 F2: the sticky top bar's live height, so nothing is scrolled or focused under it
  syncStickyHeight();
  const bar = $('.topbar');
  if (bar && typeof ResizeObserver === 'function') new ResizeObserver(() => syncStickyHeight()).observe(bar);
  window.addEventListener('resize', syncStickyHeight);
  // the status strip is fitted to the bar's width again as soon as the window changes size, not at the next tick
  let fitQueued = false;
  window.addEventListener('resize', () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      guard(null, renderTop);
      syncStickyHeight();
    });
  });
  // A field that gets focus while under the bar (Tab, or a focus() after a repaint or an error): a browser counts it as
  // on screen and does not scroll, so it is moved down below the bar
  document.addEventListener('focusin', (e) => keepClearOfBar(e.target));

  onRoute();
  // Reaching nothing at all for a few seconds shows the same "lost" banner as losing the connection later
  S.lostSince = Date.now();
  setTimeout(() => { if (S.conn === 'connecting') { S.conn = 'lost'; renderBanners(); } }, 2500);
  connect();
  setInterval(tick, 1000);
  setInterval(watchdog, 5000);
  renderAll();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
