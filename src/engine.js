// The engine decides what each RR12 read means: which race it belongs to, which split, whether it is a new passing or
// the other mat seeing the same runner, and which place to send. It owns no sockets, files or real timers: packets
// leave through the injected deliver(), files through the injected store and time comes from the injected clock, so a
// test can replay a race exactly and main.js decides where everything goes.
//
// Revision 2 (DESIGN.md section 9): every read is journaled before anything is done with it, and everything else is
// DERIVED from the journal and the settings as they are now. Mapping a timing point late, correcting a gun or narrowing
// a race's contests therefore applies to the reads already received, exactly as if the setting had been right all
// along. What each output was given is a separate ledger per output; convergence compares the two and sends only the
// difference, so nothing an output could not take is lost and nothing is sent twice.
//
// Revision 5 (DESIGN 9.2): which race a read is in follows five plain rules, so the operator can predict it. A race
// that is not Active keeps exactly the reads it has; deleting a race or clearing its data takes its reads out of use
// for good; only the reads in active races or in no race are routed again, among the active races. One pure planner
// (planRoutes) decides it, for the live change and for the panel's "what will happen" dialogs alike.
//
// Revision 6 (DESIGN 9.2): a race that is not Active takes no read at all, so a contest only such races list waits for
// them in no race; and only the operator's Delete takes reads out of use. A race that is gone from the settings any
// other way (config.json put back from its backup, or edited) is missing: its reads wait for it, and come back with it.

import { EventEmitter } from 'node:events';
import { parseTod, parseRaceTime, formatTod, formatRaceTime, raceTicks, TICKS_PER_SEC, TICKS_PER_DAY } from './timefmt.js';
import { eventKeyOf, entryBib } from './entries.js';
import { columnCheck, checkField, checkOne, estimateGaps, moveText, legField, legFlagOf, legFits, missedCounts, missedStarts, missedCountText, missedRunsText, missedSetsText,
  startMargin, pastField, startRuns, legShape, strayLegs, strayLegAt, fastField, fastLegsOf, paceAt, fastText, FIT_RULES, COUNT_RULES, CHECK_RULES, FAST_RULES } from './review.js';

const FEED_SIZE = 1000;
// TrackScore sets runner.place from every packet, so any re-send can overwrite a place. Corrections and place updates
// are only worth that while the split is still fresh on the scoreboard.
const RESEND_WINDOW_MS = 60_000;
// The place rule (revision 10): a finished runner's split that went out this long before the relay found the finish
// in FinishLynx's file may have reached TrackScore after FinishLynx's own finish packet (FinishLynx saves its file a
// little after it tells TrackScore, and the relay reads the folder once a second). Longer would list splits that went
// out just before a finish; shorter would miss a FinishLynx that is slow to save.
const FINISH_SEEN_WINDOW_MS = 5_000;
// ...and only a split that went out late: this long after its read came in, beyond the hold (a pause, an output that
// caught up). A split sent as the runner crossed the mat was sent before the runner finished.
const LATE_SEND_MS = 5_000;
// How often a race is checked for splits that went out with the split place after the runner finished (#repairFinishPlaces).
const REPAIR_EVERY_MS = 1_000;
const SAVE_DELAY_MS = 500;
const STORE_VERSION = 2;
// clockLagSec (DESIGN 9.16 F6) is a low percentile of (arrival - read time) over this many recent reads. A read can
// arrive late (a queue, a busy network) but never early, so the low end is the PC clock's offset plus the normal
// 1.5 s of RR12's own delay; the 10th percentile rather than the minimum, so one read with a wrong time can't move it.
const LAG_SAMPLES = 200;
const LAG_PERCENTILE = 0.1;
// Reads that arrive in a burst are RR12's queue being flushed (it was cut off, or Split Relay was down): their lags are
// how long they waited in the queue, not the clock. Within any LAG_BURST_MS of arrivals, live reads' lags differ by
// a second or two (RR12 sends each read 1.4-3 s after the passing); a spread of more than LAG_BURST_SPREAD_SEC means a
// flush, and every read of it is left out.
const LAG_BURST_MS = 1000;
const LAG_BURST_SPREAD_SEC = 5;
const JOURNAL_WARN_MS = 60_000;
// An output's acknowledgement means this PC's network stack took the bytes, not that the scoreboard read them. A
// process that is killed (Task Manager, a crash, a power cut) loses what the stack still held: on a slow link that is
// several seconds of packets, on this PC's own loopback far more. After such a stop, what the outputs took in their
// last minute is delivered again; a repeated split changes nothing in TrackScore.
const UNCLEAN_REDELIVER_MS = 60_000;
// ...but not at once. A runner who finished while Split Relay was down must be known as finished before his last split
// goes out again, or TrackScore would replace his finish place: RR12 sends the reads it queued (finish reads among
// them) within a few seconds of the restart, and FinishLynx's finishers are read every second.
const REDELIVER_SETTLE_MS = 15_000;
// The start line of many cross-country courses runs over the finish mats (and sometimes a split mat): every runner is
// read there in the first seconds of the race. Such a read must not count, or it would "finish" the runner and wipe
// their real splits, or open a split crossing that drops their real earlier splits as out of order.
const START_IGNORE_SEC = 60;
const START_IGNORE_MAX_SEC = 1800;
// A made-up time (9.17 P3) has no read whose arrival breaks a tie: it ranks after every real crossing with the same
// time, in the order the operator made them (the journal's), so a rebuild ranks them exactly as before.
const MANUAL_SEQ_BASE = 2 ** 50;
/** The outcomes the race view counts (DESIGN 9.7, 9.15); kept per runner and per race as reads come in. */
const COUNTED = ['waiting-gun', 'before-gun', 'start-area', 'after-finish', 'out-of-order', 'repeat', 'too-early', 'extra'];
const COUNTED_SET = new Set(COUNTED);
// Strings cached by the interning tables: plenty for every timing point, contest, team and name of a meet. A table
// that grows past it is simply started again, so a stream of junk can never hold memory.
const INTERN_MAX = 100_000;
// A read's `gone`: whether it is still in use (DESIGN 9.2 R2, R3). Numbers, because a meet has tens of thousands of
// read records in memory and a small integer costs nothing.
const LIVE = 0;
const CLEARED = 1;
const DELETED = 2;
/**
 * The `home` of a read that came, or was waiting in no race, while its contest was set aside. It counts as having had a
 * race: if the contest is used again and then let go once more, the read is set aside again with the others, instead
 * of being taken by the race that takes every contest as a read that never had a race would be (rule R4e).
 */
const ASIDE = Symbol('set aside');
/** planRoutes: a read that a race took out of its contest list and that has nowhere to go (rule R4f). */
const LET_GO = Symbol('let go');

/**
 * @typedef {object} Clock
 * @property {() => number} now wall-clock milliseconds
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(handle: any) => void} clearTimeout
 *
 * @typedef {{ location: string, bib: string, tod: number, contest?: string, first?: string, last?: string,
 *   team?: string, gender?: string }} Read  tod in ticks since midnight (input.js parseLine)
 * @typedef {{ receivedAt?: number, raw?: string, connId?: unknown, error?: string }} ReadMeta
 *   `error` (with `raw`) turns the call into a 'bad-line' feed entry for a line parseLine rejected.
 *
 * @typedef {object} SplitPacket
 * @property {string} raceId
 * @property {object} race the Race from the config
 * @property {string} splitId
 * @property {number} splitIndex 0-based, course order, among the splits that are sent (9.26)
 * @property {number} splitCount N: the race's splits that are sent (9.26: not the ones that are counted only)
 * @property {string} splitName
 * @property {string} bib
 * @property {string} first
 * @property {string} last
 * @property {string} team
 * @property {'M'|'F'|''} gender
 * @property {number} csTicks race time at this split
 * @property {number} lsTicks time since the nearest earlier SENT split this bib has (CS when there is none)
 * @property {number} place 1-based place at this split
 * @property {number} lapsToGo N - splitIndex: the sent splits from this one to the end (TrackScore L2G; never 0, which
 *   would mean "finished")
 * @property {number} gunTicks
 * @property {number} tod time of day of the crossing
 * @property {number} runnerCount bibs in the race with at least one crossing (LSS header \13\08)
 * @property {'new'|'correction'|'place-update'|'resend'|'clear'} reason  'clear' (9.24): a clearing line, csTicks, lsTicks
 *   and place null: the row of a split that was taken back, for a receiver that can blank a cell
 *   Every packet also has a non-enumerable `isCurrent()`: false once the packet is out of date (a newer one replaced
 *   it, the runner finished, the race was paused). An output that queued it checks before writing it.
 *
 * @typedef {'held'|'sent'|'backup'|'duplicate'|'repeat'|'corrected'|'before-gun'|'waiting-gun'|'unmapped'|'no-race'|
 *   'paused'|'finish'|'bad-line'|'after-finish'|'out-of-order'|'finished-not-sent'|'start-area'|'set-aside'|
 *   'race-deleted'|'cleared'|'race-missing'|'too-early'|'extra'|'ready'|'split-paused'|'check-column'|'made-up'|
 *   'typed'|'ignored'|'not-sending'|'not-in-race'|'counted'} FeedStatus
 *   'too-early': a pass (a read with no timing point name, 9.15 L4) earlier than the earliest time of the split it
 *   would be; 'extra': a pass after the race's last split; 'ready' (9.16 F3): its hold is over but no output took it
 *   (none sends the race, or each one turned it away); 'sent' only once an output took it. DESIGN 9.17:
 *   'split-paused': its split is paused ("1K is paused: kept, not sent"); 'check-column': the column check holds it
 *   ("Looks like 2K, not 1K (missed 1K?) — check it in Review"); 'made-up' / 'typed': a row for a time the operator
 *   sent from Review (the relay's estimate, or a time typed), not for a read; 'ignored' (9.23): a pass the operator
 *   set aside in Review ("Not a split"); 'counted' (9.26): a pass in a split that is counted but not sent
 * @typedef {{ id: number, at: number, raceId: string|null, raceName: string, splitName: string, location: string,
 *   bib: string, name: string, team: string, tod: number|null, raceTicks: number|null, place: number|null,
 *   status: FeedStatus, detail: string, port: number|null }} FeedEntry  port: the RR12 input port the line came in on
 *   Updated IN PLACE (same id, re-emitted on 'feed') whenever its read's outcome changes.
 *
 * @typedef {{ id: string, name: string, active: boolean, inputPort: number|null, gunTicks: number|null, gunText: string,
 *   elapsedTicks: number|null, splitCount: number, splits: { id: string, name: string, sources: string[],
 *   earliest: string, crossings: number, lastAt: number|null, sending: boolean, held: number }[], runners: number,
 *   finished: number, pending: number,
 *   waitingGun: number, beforeGun: number, startArea: number, afterFinish: number, outOfOrder: number, repeats: number,
 *   tooEarly: number, extra: number, passes: number, finishedNotSent: number,
 *   unmapped: { name: string, count: number }[],
 *   contestsSeen: { name: string, count: number, blank: boolean, via?: 'port'|'event', port?: number, event?: string }[],
 *   stale: { count: number, byOutput: { outputId: string, name: string, count: number }[],
 *     reason: 'split-count'|'order'|'changed'|null, splitCountFrom: number|null, hint: string|null },
 *   leftover: { count: number, runners: string[], byOutput: { outputId: string, name: string, count: number }[],
 *     text: string|null },
 *   review: { missing: number, estimable: number, checks: number, checkRunners: number, manual: number, flagged: number,
 *     pinned: number, madeUp: number },
 *   resendSuggested: boolean, resend: { count: number, finished: number }, lastReadAt: number|null,
 *   lynxStart: number|null, lynxName: string|null }} RaceView
 *   stale.count: the crossings out of date on any output, each once (9.23 F14; byOutput: per output). resend: what a
 *   Resend sends: count without, finished with "Also re-send runners who have finished" (9.23 F14).
 *   splits[].sending: false = paused by the operator (9.17 P1); held = its crossings no output has, kept back by the
 *   pause ("Paused · 14 held"). review (9.17): missing splits, how many of them have an estimate that can be sent,
 *   passes held for a column check (and how many runners), made-up times in use.
 *   passes: reads of the race with no timing point name (FinishLynx LapTime), counted into splits by time (9.15 L4).
 *   finishedNotSent: crossings of finished runners that no output took (DESIGN 9.16 F3).
 *   stale.reason 'split-count': what the outputs have was sent when the race had splitCountFrom splits; 'order': the
 *   splits were reordered since; 'changed': a time, the gun or a place; hint: the words for the resend prompt.
 *   leftover (9.16 F1): cells of TrackScore / Karmarush that got a time earlier and that no current split of the runner
 *   fills, so a Resend can't correct them: count = distinct (runner, column) cells over the outputs that take the race.
 *   9.26: splits[].collectOnly, true on a split that is counted but not sent (only then); sentCount, the splits that are
 *   sent (only when some are counted only): the number TrackScore and Karmarush are set up with; lateMerged (only then):
 *   { reads, runners, fromSec, toSec, tagWindowSec, text }, reads the tag filter merged that came long after the
 *   runner's last one (#lateMerged).
 * @typedef {{ bib: string, name: string, team: string, splitId: string, splitName: string, tod: number,
 *   raceTicks: number|null, place: number, sentAt: number|null, reads: number,
 *   reason: SplitPacket['reason']|null, source: 'read'|'made-up'|'typed', held: 'paused'|'check'|'stopped'|'away'|'collect'|null }} CrossingView
 *   place: not counting crossings held for a column check before it (9.17); source and held: 9.17 ('collect', 9.26:
 *   its split is counted but not sent)
 * @typedef {{ kind: 'gun'|'split'|'finish', splitId: string|null, splitName: string, raceTicks: number }} ReviewRef
 * @typedef {{ bib: string, name: string, team: string, splitId: string, splitName: string, index: number,
 *   estimate: number|null, estimateText: string, basis: string, prev: ReviewRef, next: ReviewRef, finished: boolean,
 *   finishPlace: number|null, sendable: boolean, why: string|null }} MissingSplit  why: why it can't be sent (no
 *   estimate, a finisher whose place is unknown, ...), null when it can
 * @typedef {{ bib: string, name: string, team: string, passTod: number, passTodText: string, raceTicks: number,
 *   timeText: string, from: string, fromName: string, to: string, toName: string, reason: string,
 *   method: 'finish'|'course', delivered: boolean, finished: boolean }} ColumnCheck  a pass held because it looks like
 *   another split's; delivered: it went out as `from` before it was held; finished: the runner has finished
 * @typedef {{ bib: string, name: string, team: string, splitId: string, splitName: string, raceTicks: number,
 *   timeText: string, finishPlace: number|null, sendable: boolean, why: string|null }} FinishedNotSent
 * @typedef {{ bib: string, name: string, team: string, splitId: string, splitName: string, index: number,
 *   raceTicks: number, timeText: string, estimated: boolean, source: 'made-up'|'typed', basis: string, at: number,
 *   state: 'active'|'replaced'|'after-finish'|'out-of-order'|'before-gun'|'waiting-gun'|'conflict', sent: boolean,
 *   place: number|null, withFinishPlace: boolean }} ManualView
 * @typedef {{ raceId: string, raceName: string, active: boolean, gunSet: boolean, missing: MissingSplit[],
 *   checks: ColumnCheck[], finishedNotSent: FinishedNotSent[], manual: ManualView[], flags: any[], counts: { missing: number,
 *   estimable: number, checks: number, checkRunners: number, manual: number, finishedNotSent: number, flagged: number,
 *   pinned: number, madeUp: number } }} Review  flags (9.23 F6): the splits that look wrong (advice), one per runner
 * @typedef {{ raceId: string, raceName: string, bib: string, name: string, team: string, found: boolean,
 *   finished: boolean, finishTicks: number|null, finishText: string, finishPlace: number|null, suspect: boolean,
 *   columns: { splitId: string, splitName: string, index: number, lapsToGo: number, sending: boolean,
 *     time: number|null, timeText: string, place: number|null, source: 'read'|'made-up'|'typed'|null,
 *     held: 'paused'|'check'|null, delivered: boolean, check: { to: string, toName: string, reason: string }|null,
 *     estimate: number|null, estimateText: string, basis: string, missing: boolean, canAdd: boolean,
 *     why: string|null }[],
 *   passes: { tod: number, todText: string, raceTicks: number, timeText: string, reads: number, splitId: string|null,
 *     splitName: string, how: string, howText: string, pinned: 'move'|'keep'|'hold'|'none'|'finish'|null,
 *     suggestion: { splitId: string, splitName: string, reason: string }|null }[],
 *   manual: ManualView[] }} RunnerView  9.23 F7 adds, per column: how, kind, passTod, flag, stale, leftover; per pass: col,
 *   inColumn, where, targets, only, finishOk; and finishBy, finishMarkedTod, fillable, alsoIn, changes, problems
 * @typedef {{ splitCount: number, gun: number|null, runners: Map<string, { first: string, last: string, team: string,
 *   gender: string, splits: (number|null)[] }> }} RaceData  splits hold race ticks per split, course order
 *
 * @typedef {(outputId: string, packet: SplitPacket, ack: (ok: boolean) => void) => boolean} Deliver
 *   OutputManager.deliver: false = the output cannot take it now; otherwise ack(true) once the bytes were accepted,
 *   ack(false) when they were dropped.
 *
 * @typedef {{ raceId: string, raceName: string, active: boolean } | { raceId: null, status: 'set-aside'|'no-race' } |
 *   { raceId: null, status: 'paused'|'race-missing', raceName: string, waitsFor: string }} Place
 *   where reads of a contest are (or new reads of it go): a race, or no race: set aside, simply no race, or waiting for
 *   a race (`waitsFor`) that is not Active ('paused') or not in the settings ('race-missing')
 * @typedef {object} RoutePlan  what a settings change would do to the reads received so far (Engine.planChange)
 * @property {{ contest: string, blank: boolean, count: number, from: Place, to: Place }[]} moves
 *   live reads whose race, or whose reason for having none, changes. An entry of a plan whose reads came by an RR12
 *   input port or by FinishLynx's event (a LapTime line with no contest, 9.15 L3) also has `via: 'port', port` or
 *   `via: 'event', event`, and its `contest` is "Port 5565" / "Event 3-1-1"; no `via` = a contest (or blank).
 * @property {{ raceId: string, raceName: string, count: number, contests: { contest: string, blank: boolean,
 *   count: number }[] }[]} deleted  races deleted with reads: those reads are no longer used (R2)
 * @property {{ contest: string, reason: string, deleted: boolean, count: number }[]} setAside  contests set aside by
 *   the change (R5); count = their reads not used afterwards
 * @property {string[]} usedAgain  contests that stop being set aside (a race lists them now)
 * @property {{ contest: string, blank: boolean, count: number, raceId: string, raceName: string }[]} kept  reads that
 *   stay in a race that is not Active while new reads of their contest go elsewhere after the change (R1)
 * @property {{ contest: string, blank: boolean, reads: number, from: Place, to: Place }[]} newReads  contests whose new
 *   reads go somewhere else after the change; reads = how many reads of it are in use or waiting now
 */

const DEFAULT_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const nonNegative = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const byContestName = (a, b) => a.contest.localeCompare(b.contest, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Contest, timing point and source names match case-insensitively, trimmed, with whitespace runs collapsed: RR12
 * exports whatever was typed into its setup, and "1K - A" vs "1k -  a" must not cost a split on race day.
 * @param {unknown} v
 */
export function matchKey(v) {
  return text(v).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * FinishLynx's event, round and heat as one key, '3-1-1': "003" and "3" are the same event to FinishLynx and to the .lif
 * file names, round and heat default to 1. '' when there is no event number.
 * @param {unknown} eventNumber
 * @param {unknown} [round]
 * @param {unknown} [heat]
 */
export function eventKey(eventNumber, round, heat) {
  const id = (v) => text(v).replace(/^\uFEFF/, '').replace(/^0+(?=.)/, '').toLowerCase();
  const en = id(eventNumber);
  return en ? `${en}-${id(round) || '1'}-${id(heat) || '1'}` : '';
}

// ---- routing keys (DESIGN 9.15 L3) ------------------------------------------------------------------------------
//
// The routing rules (9.2) work on one key per read. It is the contest when the line carried one, else FinishLynx's
// event when the LapTime line carried event fields, else the port the line came in on: a LapTime line from RR12 has
// nothing else. A race lists its contests, its port and its event, so the rules apply to all three unchanged. Port and
// event keys start with a control character, which no contest can (cleanRead strips them), so they never collide.
const PORT_KEY = '\u0001port ';
const EVENT_KEY = '\u0001event ';

/** @param {number} port */
export const portKey = (port) => PORT_KEY + port;
/** @param {string} key an eventKey() */
export const eventRouteKey = (key) => EVENT_KEY + key;

/**
 * What a routing key stands for, for the panel: a contest, an event, a port, or nothing ('blank': a read with no
 * contest that came in with no port, e.g. from an older journal). `label` is what the panel shows where it shows a
 * contest name ("Port 5565", "Event 3-1-1"; '' for a blank one; for a contest the caller has the name).
 * @param {string} key
 * @returns {{ via: 'contest'|'event'|'port'|'blank', port: number|null, event: string|null, label: string }}
 */
export function routeKeyInfo(key) {
  const k = String(key ?? '');
  if (k.startsWith(PORT_KEY)) {
    const port = Number(k.slice(PORT_KEY.length));
    return { via: 'port', port, event: null, label: `Port ${port}` };
  }
  if (k.startsWith(EVENT_KEY)) {
    const event = k.slice(EVENT_KEY.length);
    return { via: 'event', port: null, event, label: `Event ${event}` };
  }
  return { via: k ? 'contest' : 'blank', port: null, event: null, label: '' };
}

/** The name the panel shows for the reads of a key: the contest as RR12 wrote it, "Port 5565", "Event 3-1-1" or ''. */
function keyLabel(key, contest = '') {
  return contest || routeKeyInfo(key).label;
}

/**
 * The fields a panel list entry with a contest in it gets when its reads came by port or by event (DESIGN 9.15):
 * `{ via: 'port', port }` or `{ via: 'event', event }`; nothing for a contest or a blank one (no `via` = a contest).
 */
function keyFields(key) {
  const { via, port, event } = routeKeyInfo(key);
  return via === 'port' ? { via, port } : via === 'event' ? { via, event } : {};
}

const MALE = new Set(['m', 'male', 'man', 'men', 'mens', "men's", 'boy', 'boys', 'b']);
const FEMALE = new Set(['f', 'female', 'woman', 'women', 'womens', "women's", 'girl', 'girls', 'g', 'w', 'lady', 'ladies']);

/**
 * Whatever RR12 or a people file calls a gender -> 'M' | 'F' | '' (TrackScore reads gender from LICENCE as M/F).
 * @param {unknown} v
 * @returns {'M'|'F'|''}
 */
export function normalizeGender(v) {
  const k = matchKey(v);
  return MALE.has(k) ? 'M' : FEMALE.has(k) ? 'F' : '';
}

// TrackScore decodes the packets as latin1, so the windows-1252 bytes 0x80-0x9F (curly quotes, dashes, Š, Œ ...)
// arrive as invisible control characters. Registration exports are full of them; FinishLynx's own people file is not.
const FOLD = new Map(Object.entries({
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '´': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‹': '<', '›': '>',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-', '•': '-',
  '…': '...',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z', 'Œ': 'OE', 'œ': 'oe', 'Ÿ': 'Y',
  'ƒ': 'f', 'ˆ': '^', '˜': '~', '™': 'TM', '€': 'EUR', '‰': '%', '†': '+',
  '‡': '+', 'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'ı': 'i',
}));

/**
 * A name from the RR12 stream with typographic punctuation folded to ASCII (’ to ', “ to ", – to -, … to ..., NBSP to
 * a space) and letters windows-1252 cannot hold reduced to their base letter ("Ștefan" -> "Stefan", not "?tefan").
 * Names from the people file are never folded: they must match FinishLynx's own strings exactly.
 * @param {unknown} v
 * @returns {string}
 */
export function foldAscii(v) {
  const s = String(v ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const f = FOLD.get(ch);
    if (f !== undefined) {
      out += f;
      continue;
    }
    if (ch.codePointAt(0) <= 0xff) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base && [...base].every((c) => c.codePointAt(0) <= 0xff) ? base : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** FinishLynx writes numeric bibs without leading zeros; RR12 may not. Finishers are matched on this. */
function bibKey(bib) {
  const b = text(bib);
  return /^\d+$/.test(b) ? b.replace(/^0+(?=\d)/, '') : b;
}

/**
 * A gun time as the operator typed it -> the text to store ('10:00:00.000', four decimals only when FinishLynx gave
 * them) and its ticks; '' clears. Throws a plain-English Error on anything else. Use it for every way a gun can be
 * entered, so a race edit cannot store what setGun would refuse.
 * @param {unknown} gunText
 * @returns {{ gun: string, gunTicks: number | null }}
 */
export function parseGun(gunText) {
  const typed = text(gunText);
  if (!typed) return { gun: '', gunTicks: null };
  // parseTod also takes bare seconds (RR12's raw [RD_Time]) and wraps hours past 23; in a gun box "10" or "25:00:00"
  // is a typo, not 00:00:10 or 01:00:00.
  const hour = /^(\d{1,2}):/.exec(typed);
  const ticks = hour && Number(hour[1]) <= 23 ? parseTod(typed) : null;
  if (ticks === null) throw new Error(`"${typed}" is not a time of day. Type the gun time as hh:mm:ss.sss, for example 10:00:00.000.`);
  return { gun: formatTod(ticks, ticks % 10 ? 4 : 3), gunTicks: ticks };
}

/** Seconds for the plain-English feed details: "0.3 s", "45.2 s" (thousandths below 10 s, tenths above). */
function secs(ticks) {
  const t = Math.abs(ticks);
  return t < 10 * TICKS_PER_SEC ? `${Math.round(t / 10) / 1000} s` : `${Math.round(t / 1000) / 10} s`;
}

const at1 = (ticks) => formatRaceTime(ticks, 1);
/** A setting in seconds as the Settings tab shows it: "60", "2.5". */
const fmtSec = (s) => String(Math.round(s * 1000) / 1000);

/** Local time of day in ticks: RR12 times and gun times are local wall-clock times. */
function localTod(ms) {
  const d = new Date(ms);
  return ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * TICKS_PER_SEC + d.getMilliseconds() * 10;
}

const joinName = (who) => `${who.first} ${who.last}`.trim();
const crossingKey = (bib, splitId) => `${bib}|${splitId}`;
/** Place order at a split: race time, then the arrival order of the read that opened the crossing. */
const cmpCrossing = (a, b) => a.rt - b.rt || a.seq - b.seq;
const byRtSeq = (a, b) => a.rt - b.rt || a.r.seq - b.r.seq;
const takes = (o, raceId) => o.enabled && (o.races.length === 0 || o.races.includes(raceId));

/** Where `x` goes in a list sorted by (rt, read seq): after every equal one, as a full sort would put a newer read. */
function insertAt(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (byRtSeq(list[mid], x) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A table that hands back one shared copy of each string. RR12 sends the same timing point, contest, team and names
 * in thousands of reads; one copy each keeps a whole meet's journal in memory cheaply.
 */
function internTable() {
  const map = new Map();
  return (s) => {
    const hit = map.get(s);
    if (hit !== undefined) return hit;
    if (map.size >= INTERN_MAX) map.clear();
    // A longer string cut from a line may be a view into the whole 64 KB chunk the line came in; the copy kept here
    // must not hold on to that chunk for the rest of the meet.
    const own = s.length >= 13 ? (' ' + s).slice(1) : s;
    map.set(own, own);
    return own;
  };
}

/** One runner's derivation in one race (DESIGN 9.3), kept up to date read by read. Indexed by split (course order). */
function newBibState() {
  return {
    /** split index -> the reads that count at that split (after the gun and the start area), sorted by (rt, seq) */
    groups: [],
    /** finish reads that count, sorted by (rt, seq) */
    finishes: [],
    /** split index -> the crossing its reads open, before the finish and course-order checks */
    open: [],
    /** split index -> why that split's crossing does not count (after the finish, out of course order) */
    drop: [],
    /** split index -> the crossing that counts */
    kept: [],
    keptCount: 0,
    /** race ticks of the earliest finish read, or null */
    finishRt: null,
    /** the runner's passes as counting placed them, and how (9.17: the column check and the runner view), or null */
    passInfo: null,
    /** split index -> how its pass got there: 'counted', 'earliest', 'moved', 'kept' or 'replaces' (9.17) */
    colHow: null,
    /** the runner's made-up times and what became of each (active, replaced, ...), or null (9.17 P3) */
    manualInfo: null,
    /** the runner as the column check takes it (9.17 P2), made once per derivation: a read re-checks the whole field */
    checkRunner: null,
  };
}

/** 'read', 'made-up' (the relay's estimate, sent by the operator) or 'typed' (a time the operator typed) (9.17). */
function sourceOf(c) {
  return !c.manual ? 'read' : c.manual.estimated ? 'made-up' : 'typed';
}

/**
 * The crossing a made-up time stands for (DESIGN 9.17 P3): kept and ranked like a real one, but with no read behind
 * it. Its `manual` is the ManualRec; a real crossing has `manual: null`.
 */
function manualCrossing(bib, split, m, gun) {
  const tod = m.rec.tod ?? ((((gun + m.rt) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY);
  return { key: crossingKey(bib, split.id), bib, splitId: split.id, index: split.index, tod, rt: m.rt,
    seq: MANUAL_SEQ_BASE + m.rec.mseq, opener: null, reads: [], firstAt: m.rec.at, manual: m.rec };
}

/** A runner's passes and made-up times in time order; a pass before a made-up time of the same moment. */
const byEventTime = (a, b) => a.t - b.t || (a.c ? 0 : 1) - (b.c ? 0 : 1);

/**
 * Pass counting with fixed points (DESIGN 9.15 L4, 9.17 P2/P3), as decisions in time order, without changing anything.
 * events: the runner's pass clusters ({ c }) and active made-up times ({ m }), sorted by byEventTime. A cluster the
 * operator moved (pinCol), or that replaces a made-up time, is that split; a made-up time holds its split; counting
 * fills the columns between the fixed points, an earliest time skips ahead, and a pass with no column left before the
 * next fixed one is 'extra'.
 * @returns {({ kind: 'place', c: any, col: number, how: string } | { kind: 'extra', c: any, before: string }
 *   | { kind: 'too-early', c: any, split: any } | { kind: 'conflict', m: any })[]}
 */
function countClusters(events, splits) {
  const n = splits.length;
  const out = [];
  let j = 0; // the next split a cluster can be, 0-based
  /** the next fixed column after event e: a pass the operator moved, or a made-up time */
  const fixedAfter = (e) => {
    for (let f = e + 1; f < events.length; f++) {
      const x = events[f];
      const col = x.m ? (x.m.state === 'active' ? x.m.k : undefined) : x.c.pinCol;
      if (col !== undefined && col >= j) return col;
    }
    return null;
  };
  for (let e = 0; e < events.length; e++) {
    const { c, m } = events[e];
    if (m) {
      if (m.state !== 'active') continue;
      if (m.k < j) out.push({ kind: 'conflict', m }); // a real pass already took its split or a later one
      else j = m.k + 1;
      continue;
    }
    if (c.pinCol !== undefined && c.pinCol >= j) {
      // 9.23: a pass "Move only this time" kept in its split is a fixed point like a Move, and says so
      out.push({ kind: 'place', c, col: c.pinCol, how: c.replaces ? 'replaces' : c.hold ? 'hold' : 'moved' });
      j = c.pinCol + 1;
      continue;
    }
    const next = fixedAfter(e);
    const limit = next ?? n;
    if (j >= limit) {
      out.push({ kind: 'extra', c, before: limit < n ? splits[limit].name : '' });
      continue;
    }
    let k = j;
    for (let m2 = limit - 1; m2 > j; m2--) {
      const ea = splits[m2].earliest;
      if (ea !== null && ea <= c.t) {
        k = m2;
        break;
      }
    }
    if (k === j && splits[j].earliest !== null && c.t < splits[j].earliest) {
      out.push({ kind: 'too-early', c, split: splits[j] });
      continue;
    }
    out.push({ kind: 'place', c, col: k, how: c.keep ? 'kept' : k > j ? 'earliest' : 'counted' });
    j = k + 1;
  }
  return out;
}

/**
 * DESIGN 9.17 P3 (revision 10): a pass that came in after a made-up time was approved (an RR12 read that came late, a
 * Replay) may be the real read of that split. Which made-up time it replaces, if any, is decided by where it lies
 * among everything else the runner has, with all the made-up times as fixed points:
 * - its neighbours in time are the nearest crossing before it and the nearest after it (the gun, the passes counted
 *   with the made-up times fixed, the operator's Moves, timing-point reads, the made-up times, the finish);
 * - the columns it can be are the made-up time just before it or just after it (when the pass came in after that time
 *   was approved), or an empty column between the two neighbours;
 * - it is the one whose time it is nearest: the made-up time itself, or for an empty column the even spacing between
 *   the neighbours (with no later neighbour, the runner's average leg so far).
 * So a late read replaces at most the made-up time next to it, never one across another made-up time or real pass;
 * a pass that is nearer an empty column is an ordinary pass, counted (and checked) as any other. Passes are taken in
 * time order, each decided one a neighbour of the next. Marks the cluster (pinCol, replaces) and the made-up time
 * (state 'replaced'); passes at or after the finish replace nothing, nor (9.23 F16) passes after a pass the count puts
 * past the last split (the stream's finish pass: a cool-down pass after it).
 */
function lateReplacements(clusters, mans, groups, splits, finish) {
  const active = mans.filter((m) => m.state === 'active');
  if (!active.length || !clusters.length) return;
  const n = splits.length;
  // (9.27: a read of another chip than the one the time was typed or made up with is new to it, whenever it came in: a
  // swap of bibs brought it to this runner, and nobody had looked at it for this runner when the time was made)
  const newer = (c, m) => c.items.every((x) => x.r.seq > m.rec.seq || (x.r.chip !== m.rec.chip && bibKey(x.r.chip) !== bibKey(m.rec.chip)));
  const late = clusters.filter((c) => c.pinCol === undefined && !c.keep && (finish === null || c.t < finish) && active.some((m) => newer(c, m)));
  if (!late.length) return;
  const lateSet = new Set(late);
  // where everything else is: counted with the made-up times (and the operator's Moves) as fixed points
  const events = clusters.filter((c) => !lateSet.has(c)).map((c) => ({ t: c.t, c, m: null }));
  for (const m of active) events.push({ t: m.rt, c: null, m });
  events.sort(byEventTime);
  /** @type {{ t: number, col: number, m: any }[]} */
  const anchors = [{ t: 0, col: -1, m: null }];
  for (const x of countClusters(events, splits)) {
    if (x.kind === 'place') anchors.push({ t: x.c.t, col: x.col, m: null });
    // (9.23 F16: a pass past the last split, the stream's finish pass, is where the finish is: a cool-down pass after it
    // replaces nothing. "Missed 5300m: add it" on the course, then a cool-down pass: it replaced the made-up 5300m)
    else if (x.kind === 'extra' && !x.before) anchors.push({ t: x.c.t, col: n, m: null });
  }
  for (const m of active) anchors.push({ t: m.rt, col: m.k, m });
  for (let k = 0; k < n; k++) {
    let t = Infinity;
    for (const x of groups[k] ?? []) if (x.rt < t) t = x.rt;
    if (t !== Infinity) anchors.push({ t, col: k, m: null });
  }
  if (finish !== null) anchors.push({ t: finish, col: n, m: null });
  for (const c of late) {
    let P = null;
    let N = null;
    for (const a of anchors) {
      if (a.t <= c.t) {
        if (!P || a.t > P.t || (a.t === P.t && a.col > P.col)) P = a;
      } else if (!N || a.t < N.t || (a.t === N.t && a.col < N.col)) N = a;
    }
    const options = [];
    const mine = (a) => !!a?.m && a.m.state === 'active' && newer(c, a.m);
    if (mine(P)) options.push({ col: P.col, m: P.m, d: Math.abs(c.t - P.t) });
    if (mine(N)) options.push({ col: N.col, m: N.m, d: Math.abs(c.t - N.t) });
    const top = N ? Math.min(N.col, n) : n;
    const leg = P.col >= 0 && P.t > 0 ? P.t / (P.col + 1) : null;
    for (let x = P.col + 1; x < top; x++) {
      const exp = N ? P.t + ((x - P.col) / (N.col - P.col)) * (N.t - P.t) : leg !== null ? P.t + (x - P.col) * leg : null;
      if (exp !== null) options.push({ col: x, m: null, d: Math.abs(c.t - exp) });
    }
    let best = null;
    for (const o of options) if (!best || o.d < best.d || (o.d === best.d && o.col < best.col)) best = o;
    if (best?.m) {
      c.pinCol = best.m.k;
      c.replaces = best.m;
      best.m.state = 'replaced';
      anchors.splice(anchors.findIndex((a) => a.m === best.m), 1, { t: c.t, col: best.m.k, m: null });
    } else if (P.col + 1 < top) {
      // an ordinary pass: counting puts it in the column after its neighbour before
      anchors.push({ t: c.t, col: P.col + 1, m: null });
    } else if (P.col + 1 >= n) {
      // (9.23 F16: past the last split, the stream's finish pass: the passes after it replace nothing)
      anchors.push({ t: c.t, col: n, m: null });
    }
  }
}

// ---- the operator's fixes (DESIGN 9.23) -------------------------------------------------------------------------
//
// A Pin is the operator's decision on one pass: { split, as, seen }. 'move': the pass IS that split; 'keep': counted
// where counting puts it, never asked about again (seen: said from the runner editor, so the look-wrong check is quiet
// too); 'hold': stays in exactly this split (written for the other passes by "Move only this time"); 'none': not a
// split (a cool-down or stray pass: no column); 'finish': the runner's finish (FinishLynx had none to send).

/** DESIGN 9.23 F5: a typed race time of this much or more is a time of day typed in the race-time box. */
export const MAX_RACE_TICKS_TYPED = 3 * 3600 * TICKS_PER_SEC;
/** DESIGN 9.23 F5: a typed time with no later reference may be at most this far after the race's newest read. */
const TYPED_AHEAD_TICKS = 10 * 60 * TICKS_PER_SEC;
/** DESIGN 9.23 F2: "This is the finish" for a pass this close to FinishLynx's finish (a pass a hair before it). */
const FINISH_NEAR_TICKS = 10 * TICKS_PER_SEC;
/**
 * 9.23 F19: a runner whose legs put its start at least this long after the gun has a missed first split made up from that
 * start (#lateStartFor): every complete runner of the real race, on time, comes out at most 23 s after the gun, also with
 * its 800m missed and its passes moved on (half of them within a second of it).
 */
const LATE_START_TICKS = 60 * TICKS_PER_SEC;
/**
 * 9.23 F20: a runner whose legs put its start at least this long after the gun has a one click at a later split weighed
 * against a late start with another set (#lateLater): every on-time complete runner of the real race comes out within 23 s
 * (the quiet note's half minute, #lateStartOf).
 */
const LATE_SEEN_TICKS = 30 * TICKS_PER_SEC;
/**
 * 9.23 F19: a one click, while the runner's finish is unknown, only when the pass that moves on fits the split it would go
 * to within this factor of the runners of its pace (#nextOr): the moved pass of every single mat missed from 1500m to
 * 4400m by the real race's complete runners fits within it but 2 of 835 (the median 1.02).
 */
const MOVED_FIT_WITHIN = 1.25;
/** The journal records an operator's fix is made of (DESIGN 9.23 F3); each carries the fix (group) id. */
const FIX_RECORDS = new Set(['assign', 'unassign', 'manual', 'unmanual', 'runner-off', 'runner-on', 'runner-say']);
/**
 * DESIGN 9.25, when a race's start list is used (listFits). A list that does not fit the runners actually being read
 * must do nothing: a wrong file, a file of another meet, an event number that is off. Measured on the two real meets
 * (eight races, each bib counted when its first pass arrived): with the right list the share of the runners through
 * that are on it is 0.80 at its lowest once five are through (four of the first five in one race, where an athlete of
 * another race crossed first; 88 of 110 at the end of a race in which 22 athletes of the earlier race cooled down over
 * the mats), with another race's list of the same meet 0.20 at most, with the other meet's files 0.16.
 * - runners, share: with this many runners through, fewer than this share of them on the list: not used
 * - none: with this many runners through and none of them on the list: not used (a race too small to reach `runners`;
 *   two athletes of another race jogging over a mat before the field are still kept off the boards)
 * - days: a list loaded longer ago than this is not used: last week's entries, left in the data folder, fit this week's
 *   bibs by their numbers alone ("Start a new meet" puts the lists away; this is for when it was not pressed)
 */
export const LIST_RULES = Object.freeze({ runners: 5, share: 0.5, none: 3, days: 6 });

/**
 * 9.25: whether a race's start list fits the runners being read: `on` of the `through` runners with a counted pass are
 * on it (LIST_RULES). Before enough are through it is trusted: an athlete of another race who crosses a mat before the
 * field does (bib 213 on 2026-10-28, "1 Mile place 1" at 3:34) is exactly who it is for.
 */
export function listFits(on, through, rules = LIST_RULES) {
  if (through >= rules.runners && on < rules.share * through) return false;
  return !(through >= rules.none && on === 0);
}
const PIN_KINDS = new Set(['move', 'keep', 'hold', 'none', 'finish']);
/** A filled cell of the runner editor by how it got there (9.23 F7). */
const KIND_OF_HOW = { counted: 'read', earliest: 'read', mat: 'read', moved: 'moved', shifted: 'moved', hold: 'hold', keep: 'keep', replaces: 'replaces', 'made-up': 'made-up', typed: 'typed' };
/** Why a made-up time is not used, in words (ManualView.state). */
const MANUAL_NOT_USED = { replaced: 'a real read replaced it', 'after-finish': 'it is not before the finish', 'out-of-order': 'it is out of course order',
  'before-gun': 'it is before the gun', 'waiting-gun': 'the race has no gun time', conflict: 'the split has another time',
  // 9.27
  swapped: 'it was made from reads that count for another bib now: swapped bibs' };
/** What a pass can be changed to besides a split (Engine.movePass). */
const MOVE_TO = new Set(['none', 'finish', 'count', 'keep']);

/** A race grid cell without its null and false fields (9.23 F7): a 600-runner grid stays small. */
function compact(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== null && o[k] !== false && o[k] !== undefined) out[k] = o[k];
  return out;
}

/** "a, b and c". */
function listWords(items) {
  const l = items.filter(Boolean);
  return l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
}

/**
 * An 'assign' journal record -> Pin. A record with no `as` is 9.17's: a split id is a Move, null a Keep. An older
 * Split Relay reads a 'hold' as a Move to the same split and 'none' / 'finish' as a Keep, which changes nothing.
 * @returns {{ split: string|null, as: 'move'|'keep'|'hold'|'none'|'finish', seen: boolean }}
 */
function pinOf(rec) {
  const split = typeof rec?.splitId === 'string' && rec.splitId ? rec.splitId : null;
  const as = PIN_KINDS.has(rec?.as) ? rec.as : null;
  if (as === 'hold' && split) return { split, as, seen: false };
  if (as === 'none' || as === 'finish') return { split: null, as, seen: false };
  if (as === 'keep' || !split) return { split: null, as: 'keep', seen: rec?.seen === true };
  // (9.23 F15: a Move the operator said is right, from its look-wrong flag: `seen`)
  return { split, as: 'move', seen: rec?.seen === true };
}

/**
 * The fields of an 'assign' record for a Pin (pinOf's inverse); a plain Move or Keep is written as 9.17 wrote it. An
 * older Split Relay reads a Move with `seen` as the Move it is.
 */
function pinFields(pin) {
  if (pin.as === 'move') return pin.seen ? { splitId: pin.split, seen: true } : { splitId: pin.split };
  if (pin.as === 'hold') return { splitId: pin.split, as: 'hold' };
  if (pin.as === 'keep') return pin.seen ? { splitId: null, as: 'keep', seen: true } : { splitId: null };
  return { splitId: null, as: pin.as };
}

const samePin = (a, b) => (!a && !b) || (!!a && !!b && a.as === b.as && a.split === b.split && a.seen === b.seen);

/**
 * A runner's decisions as one string (DESIGN 9.23 F3): its pins by time of day and its made-up times, everything a
 * rebuild from the journal gives back (not the made-up times' order numbers, which a rebuild numbers again). Reads do
 * not change it, so an Undo is allowed while this is what the change left.
 */
function fixSig(pins, manuals, off = null, say = null) {
  const p = [...(pins ?? [])].sort((a, b) => a[0] - b[0]).map(([tod, x]) => [tod, x.split, x.as, x.seen]);
  const m = [...(manuals?.values() ?? [])].sort((a, b) => (a.splitId < b.splitId ? -1 : a.splitId > b.splitId ? 1 : 0))
    .map((x) => [x.splitId, x.raceTicks, x.tod, x.estimated, x.basis, x.at, x.seq]);
  // (9.24: and whether the runner is stopped, from when; 9.25: and what the operator said of where it runs; a runner
  // with neither has the string it always had)
  return JSON.stringify(say ? [p, m, off ? off.from : null, say] : off ? [p, m, off.from] : [p, m]);
}

/**
 * DESIGN 9.23 F7, the preview of a Move: where each of a runner's passes would go with cluster `cl` pinned to `pin`
 * (null: nothing set; 9.23 F16: or `cl` a Map of several passes to their pins), the other passes keeping their own pins. The count of #assignPasses on the clusters as they are
 * (the finish first, then Not a split, then counting with the moved passes and the made-up times as fixed points), so
 * the menu says what a Move would do without doing it. Pure.
 * @param {any[]} clusters the runner's passes (d.passInfo)
 * @param {any[]} mans the runner's made-up times as the count took them (d.manualInfo)
 * @param {Set<number>|number} dropAt the made-up times in these columns give way (a Move onto one replaces it, one out of
 *   order with the Move is taken out), -1 or an empty set for none
 * @param {(marked: number|null) => number|null} finishOf the runner's finish given a marked finish at that time
 * @returns {Map<any, number|'extra'|'too-early'|'ignored'|'finish'|'after-finish'>}
 */
function previewPlaces(clusters, mans, splits, cl, pin, dropAt, finishOf) {
  const where = new Map();
  // (9.23 F16: `cl` a Map of several passes to their pins, `pin` unused: two runs of missed mats apart, each run's pass)
  const set = cl instanceof Map ? cl : new Map(cl ? [[cl, pin]] : []);
  const asOf = (c) => (set.has(c) ? set.get(c) : c.pin);
  const fin = clusters.find((c) => asOf(c)?.as === 'finish') ?? null;
  const events = [];
  for (const c of clusters) {
    const p = asOf(c);
    if (c === fin) where.set(c, 'finish');
    else if (p?.as === 'none' || p?.as === 'finish') where.set(c, 'ignored');
    else {
      let pinCol;
      if (!set.has(c) && c.replaces) pinCol = c.pinCol;
      else if (p && (p.as === 'move' || p.as === 'hold')) {
        const sp = splits.find((s) => s.id === p.split);
        if (sp) pinCol = sp.index;
      }
      events.push({ t: c.t, c: { t: c.t, pinCol, keep: p?.as === 'keep', hold: p?.as === 'hold', replaces: !set.has(c) ? c.replaces : null, src: c }, m: null });
    }
  }
  const drop = dropAt instanceof Set ? dropAt : new Set([dropAt]);
  for (const m of mans ?? []) if (m.state === 'active' && !drop.has(m.k)) events.push({ t: m.rt, c: null, m });
  events.sort(byEventTime);
  for (const x of countClusters(events, splits)) {
    if (x.kind === 'place') where.set(x.c.src, x.col);
    else if (x.kind === 'extra' || x.kind === 'too-early') where.set(x.c.src, x.kind);
  }
  const finish = finishOf(fin ? fin.t : null);
  if (finish !== null) for (const [c, w] of where) if (typeof w === 'number' && c.t >= finish) where.set(c, 'after-finish');
  return where;
}

/** "4400m", "an extra pass", "after the finish": where a previewed pass goes, in words. */
function whereWord(w, splits) {
  if (typeof w === 'number') return splits[w]?.name ?? `split ${w + 1}`;
  return { extra: 'extra pass', 'too-early': 'too early', ignored: 'not a split', finish: 'the finish', 'after-finish': 'after the finish' }[w] ?? 'no split';
}

/**
 * How counting (or the operator) placed a pass, in words, for the runner view. The same words in public/app.js (a test
 * checks it).
 * @param {string} how counted|earliest|moved|shifted|kept|hold|replaces|extra|too-early|after-finish|out-of-order|ignored|finish
 * @param {string} [split] the split's name
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

/** The feed's words for a pass set aside in Review, and for a pass marked as the finish (9.23; app.js has them too). */
export const IGNORED_TEXT = 'Not a split: you set this pass aside in Review. Not sent.';
export const MARKED_FINISH_TEXT = 'The finish: you marked this pass as the finish in Review. No more splits go live for this runner, so TrackScore keeps the finish place. Not sent.';

/**
 * 9.25: the warning of a start list that is not used for its race, in words: "The start list does not match Girls 2A
 * (12 of 40 runners are on it): not used. Check the race's event number, or load the right file."; one from an earlier
 * meet: "The start list of Girls 2A was loaded 8 days ago: not used. Load this meet's entry files."
 */
export function listMisfitText(raceName, list, now = Date.now()) {
  if (list.old) {
    const days = Math.max(1, Math.floor((now - list.loadedAt) / 86400000));
    return `The start list of ${raceName} was loaded ${days} days ago: not used. Load this meet's entry files (Races tab).`;
  }
  return `The start list does not match ${raceName} (${list.on} of ${list.through} runners are on it): not used. Check the race's event number, or load the right file (Races tab).`;
}
/** 9.25: the feed's words for a pass of a runner who is not in this race. */
export const AWAY_TEXT = 'Not in this race: read and counted here, not sent, not in the merged .lif file. Review lists the runner under Not in this race, with "Count them here".';
/** 9.24: what the feed adds to the row of a split the pace check marks. */
export const TOO_FAST_TEXT = 'Too fast to be real? Review lists it under Splits that look wrong.';
/**
 * 9.26: the feed's words for a pass in a split that is counted but not sent ("This split" becomes the split's name;
 * app.js has the meaning of the status word).
 */
export const COUNTED_TEXT = 'This split is counted, not sent: the pass keeps this runner\'s later passes in the right splits. It goes to no scoreboard and is not in the merged .lif file.';
/**
 * 9.26, the tag filter and mats close together: a read that comes this long after the runner's last read and is still
 * inside the tag filter was merged into that pass. The A and B mats of one split read a runner a second or two apart
 * (median 1.3 to 1.8 s at the four real meets), so a read this late is another pass: a second mat a little further on.
 */
export const LATE_MERGE_SEC = 15;
/** ...said (Needs attention) once this many runners of a race have such a read: one runner standing by a mat is not it. */
export const LATE_MERGE_RUNNERS = 3;
/**
 * 9.26: that warning in words (RaceView.lateMerged.text): "24 reads of 12 runners came 20 to 45 s after the runner's last
 * one and were merged into it by the tag filter (45 s). If two mats are that close on the course, set the tag filter
 * below the fastest runner's time between them."
 * @param {{ reads: number, runners: number, fromSec: number, toSec: number, tagWindowSec: number }} m
 */
export function lateMergedText({ reads, runners, fromSec, toSec, tagWindowSec }) {
  const span = fromSec === toSec ? `${fromSec} s` : `${fromSec} to ${toSec} s`;
  return `${reads} read${reads === 1 ? '' : 's'} of ${runners} runners came ${span} after the runner's last one and ` +
    `${reads === 1 ? 'was' : 'were'} merged into it by the tag filter (${fmtSec(tagWindowSec)} s). ` +
    "If two mats are that close on the course, set the tag filter below the fastest runner's time between them.";
}
/** 9.24: the feed's words for a pass of a runner the operator stopped sending (app.js has them too). */
export const STOPPED_TEXT = 'Not sending this runner: you stopped it in Review. Read and counted, not sent, not in the merged .lif file. Open the runner and choose "Send this runner again" to undo that.';

/** A wall-clock moment as this PC's local time of day: "12:03:14". */
const wallText = (ms) => formatTod(localTod(ms), 0);

/** FNV-1a of a string: the race grid's revision, so a panel that has it gets "unchanged". */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Lower case without accents, for finding a runner by a part of the name ("Lieberman", "o'donnell", "Muller"). */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The outcome of every read whose timing point is no split or finish of its race (they are many: one object). */
const UNMAPPED = Object.freeze({ kind: 'unmapped' });

const sameDrop = (a, b) => (a === undefined ? b === undefined
  : b !== undefined && a.kind === b.kind && a.finish === b.finish && a.byIndex === b.byIndex && a.byRt === b.byRt);

/**
 * What one output acknowledged for one crossing. `row` is the form saved in the race file, kept ready: the file is
 * saved every half second while packets flow, and building thousands of rows for each save would cost more than the
 * race itself.
 */
function ledgerEntry(key, tod, place, gun, l2g, count, n, firstAt, at, waived = null, fixedAt = null, ls = null) {
  // count: the race's number of splits when it was sent. TrackScore and Karmarush file a split in the column
  // "count - laps to go", so a split count changed since puts it in the wrong column (9.15 L6): it is compared too.
  // fixedAt (9.23 F4): when the operator last put a time in this cell (a fill, a Move, an Undo): the minute in which
  // the relay may still correct the cell by itself starts again then. ls (9.23 F21): the leg (LS) the output got with
  // it, so a change that gives the cell its old time back with another leg sends it again (null: not known, a race file
  // from before). Each saved only when there is one (fixedAt as null before an ls), so a race file without them is as
  // before (an older Split Relay ignores the extra fields).
  const row = [key, tod, place, gun, l2g, firstAt, at, waived, count];
  if (fixedAt !== null || ls !== null) row.push(fixedAt);
  if (ls !== null) row.push(ls);
  return { sig: `${tod}|${place}|${gun}|${l2g}|${count}`, bib: bibOfKey(key), tod, place, gun, l2g, count, n, firstAt, at, waived, fixedAt, ls, row };
}

/** A crossing's content without its place: its time and column (9.23 F4: what an approval made while it was held is for). */
const cellOf = (content) => `${content.tod}|${content.gun}|${content.l2g}|${content.count}`;

/**
 * 9.23 F13: the output's copy of a cell has another time of day, with the same gun and column: what a read changes
 * (a late read, a real read that replaces a made-up time), never a setting (a gun or a split count changes the rest).
 */
const retimedByRead = (led, content) => led.tod !== content.tod && led.gun === content.gun && led.l2g === content.l2g && led.count === content.count;

/** Why a packet goes to an output whose copy of the crossing is `led` (9.4): new, a corrected time or column, a new place. */
const reasonOf = (led, content) => (!led ? 'new'
  : led.tod !== content.tod || led.gun !== content.gun || led.l2g !== content.l2g || led.count !== content.count ? 'correction' : 'place-update');

/** A cell an Undo empties that a board keeps, as the answer says it (withFinishPlace: it went with the finish place). */
const leaveOut = ({ bib, splitName, text: t, withFinishPlace, held }) => ({ bib, splitName, text: t, ...(withFinishPlace ? { withFinishPlace: true } : {}),
  ...(held ? { held: true } : {}) });

/** Where a pass is, as "24:17.3 is … again" says it (9.23 F3: what an Undo did). */
function wherePhrase(w, splits) {
  if (typeof w === 'number') return `the ${splits[w]?.name ?? `split ${w + 1}`} split`;
  return { extra: 'an extra pass', 'too-early': 'too early', ignored: 'not a split', finish: 'the finish', 'after-finish': 'after the finish' }[w] ?? 'in no split';
}

/** The bib of a crossing key "bib|splitId" (split ids never hold a "|"; a bib might). */
function bibOfKey(key) {
  const i = key.lastIndexOf('|');
  return i < 0 ? key : key.slice(0, i);
}

// ---- what Resend cannot fix (DESIGN 9.16 F1) -------------------------------------------------------------------------
//
// TrackScore and Karmarush keep a runner's split times in cells, one per column ("split count - laps to go"), and a
// packet can only fill a cell: nothing on the wire empties one. After a setting change (the number of splits, an
// earliest time, the start area, the gun) a Resend corrects every split Split Relay has, but a cell that no current
// split of the runner fills keeps the time it was given.

/** The words every resend prompt ends with: what a Resend corrects, and what it can't. */
export const RESEND_LIMIT = 'Resend corrects every split Split Relay has. A runner who has no split in a column under ' +
  'the new setting may still show an old time there in TrackScore and the live results until the race is cleared there.';

/**
 * Revision 10: a held pass that is the runner's only pass so far. One pass can't show evenness, so the relay waits
 * for the runner's next pass or finish, which settles it (a slow runner's next pass lets it go by itself). The same
 * words in public/app.js (a test checks it).
 */
export const LONE_TEXT = "It is this runner's only pass so far: Split Relay holds it until their next pass or their finish shows which split it is. You can decide now, but you don't have to.";

/** "507, 519", the first 12 of a sorted list and how many more. */
function runnerList(bibs) {
  const shown = bibs.slice(0, 12).join(', ');
  return bibs.length > 12 ? `${shown} and ${bibs.length - 12} more` : shown;
}

/**
 * "2 cells sent earlier can't be removed from TrackScore by Split Relay (runners: 507, 519). ..." for RaceView.leftover.
 * @param {number} count
 * @param {string[]} bibs sorted
 * @returns {string|null}
 */
export function leftoverText(count, bibs) {
  if (!count) return null;
  const one = bibs.length === 1;
  return `${count} ${count === 1 ? 'cell' : 'cells'} sent earlier can't be removed from TrackScore by Split Relay ` +
    `(${one ? 'runner' : 'runners'}: ${runnerList(bibs)}). ${one ? 'This runner has' : 'These runners have'} no split in ` +
    `${count === 1 ? 'that column' : 'those columns'} under the current settings, so TrackScore and the live results may ` +
    'still show an old time there until the race is cleared there.';
}

/**
 * Revision 10: a finished runner's split that went out before it was corrected (a Move in Review, an earlier backup
 * read, a gun change). TrackScore shows the old time; only a packet with the finish place may correct it, since a
 * split packet's place replaces the runner's place. The same words in public/app.js (a test checks it).
 * @param {string} split the split's name
 * @param {string} oldText the time the outputs have ("29:12.1")
 * @param {string} nowText the corrected time ("18:47.3")
 */
export function sentOldText(split, oldText, nowText) {
  return `Sent with an old time${oldText ? ` (${oldText})` : ''}: TrackScore and the live results show that as ${split}. ` +
    `Send the corrected time${nowText ? ` (${nowText})` : ''} with the finish place.`;
}

/**
 * "Missed 2400m: add it", "Missed 1500m and 2400m: add them"; two mats missed apart (9.23 F16) say the splits between
 * them were read: "Missed 4200m and 5300m: add them (4400m was read)" (9.23 F13; public/app.js missedLabel says the same).
 */
function missedName(m) {
  const read = m.read ?? [];
  // (9.23 F20: and the stray passes it sets aside: "Missed 2400m: add it (11:24.4 is a stray pass)")
  const aside = (m.aside ?? []).map((a) => a.timeText);
  const stray = aside.length ? `${listWords(aside)} ${aside.length > 1 ? 'are stray passes' : 'is a stray pass'}` : '';
  const why = [read.length ? m.readText || readWords([read]) : '', stray].filter(Boolean).join('; ');
  return `Missed ${listWords(m.names)}: add ${m.names.length > 1 ? 'them' : 'it'}${why ? ` (${why})` : ''}`;
}

/**
 * 9.23 F17: the splits read between runs of missed splits (each gap's names, course order), in words: "4400m was read",
 * "1500m and 2400m were read", three or more in a row as a stretch: "1500m to 4400m were read" (800m and 5300m missed:
 * F16 named all five).
 * @param {string[][]} gaps
 */
function readWords(gaps) {
  const parts = gaps.filter((g) => g.length).map((g) => (g.length > 2 ? `${g[0]} to ${g[g.length - 1]}` : listWords(g)));
  const count = gaps.reduce((a, g) => a + g.length, 0);
  return parts.length ? `${listWords(parts)} ${count > 1 ? 'were' : 'was'} read` : '';
}

/** The splits read between the runs, one list per gap (9.23 F17: readWords). */
function readGaps(runs, splits) {
  const gaps = [];
  for (let i = 1; i < runs.length; i++) {
    const g = [];
    for (let x = runs[i - 1].k + runs[i - 1].count; x < runs[i].k; x++) g.push(splits[x].name);
    gaps.push(g);
  }
  return gaps;
}

/**
 * The runs of missed splits of a "Missed …" hint or choice, course order, each { k, count } (k its first missed split):
 * one run of `count` from k, or (9.23 F16: two mats missed apart, 4200m and 5300m with 4400m read) `runs`.
 */
const runsOf = (h) => (h?.runs?.length ? h.runs : h ? [{ k: h.k, count: h.count }] : []);

/** The column each run's pass that moves on is counted in now (the runs before it moved the later passes on). */
function runCols(runs) {
  let shift = 0;
  return runs.map((r) => {
    const c = r.k - shift;
    shift += r.count;
    return c;
  });
}

/** Where the pass counted in column c goes with these runs added (9.23 F16): every run whose pass is at or before it moves it on. */
function runShift(runs, c) {
  const cols = runCols(runs);
  let to = c;
  runs.forEach((r, i) => {
    if (cols[i] <= c) to += r.count;
  });
  return to;
}

/**
 * 9.23 F20: the words of a stray pass a set of missed splits sets aside: "11:24.4 is a stray pass, 0:40 after 10:44.4."
 * 9.23 F21: `may`, for a set offered because the runner's times fit it only about as well as they were read (a fast leg):
 * "15:41.6 may be a stray pass, 0:38 after 15:04.1." (a real 4400m pass 15 s fast was "a stray pass" in its row's words)
 * @param {{ t: number } | null} prev the runner's pass before it
 * @param {{ t: number }} s
 * @param {boolean} [may]
 */
function strayWords(prev, s, may = false) {
  const at = `${formatRaceTime(s.t, 1)} ${may ? 'may be' : 'is'} a stray pass`;
  if (!prev) return `${at}.`;
  const sec = Math.max(0, Math.round((s.t - prev.t) / TICKS_PER_SEC));
  return `${at}, ${sec < 60 ? `0:${String(sec).padStart(2, '0')}` : formatRaceTime(sec * TICKS_PER_SEC, 0)} after ${formatRaceTime(prev.t, 1)}.`;
}

/** 9.23 F18: a change's preview holds a pass as the finish (#previewHeld's words): no other pass is "(the finish)" then. */
const heldAsFinish = (held) => [...held.values()].some((w) => w.endsWith('the finish'));

/** The cell of a hint that says "Missed here?": its split, or (9.23 F18) `at`, the pass in doubt when two sets are offered. */
const hereOf = (h) => (h ? h.at ?? h.k : -1);

/** 9.23 F20: the slow leg Split Relay can't tell the missed mat from, in words: "1500m to 2400m", how much longer it took. */
const legOut = (h) => (h?.leg ? { leg: { from: h.leg.from, to: h.leg.to,
  lostText: Number.isFinite(h.leg.lost) && h.leg.lost > 0 ? formatRaceTime(Math.round(h.leg.lost / TICKS_PER_SEC) * TICKS_PER_SEC, 0) : '' } } : {});

/** Two choices are the same splits (9.23 F16: a hint's runs, the operator's request). */
const sameRuns = (a, b) => a.length === b.length && a.every((r, i) => r.k === b[i].k && r.count === b[i].count);

/**
 * Why a finisher's split can't go live while the finish place is unknown (9.17 P4), and what to do. 9.23 F18: a finish
 * the operator marked ("This is the finish") with no place known: the way out is the last split's "Missed …: add it",
 * which makes the marked pass the finish pass again (the runner's other splits can go then, each with its own place):
 * on the re-check of 2026-10-30, 419's typed 800m was refused with no way out, and the words said TrackScore would take
 * the split's place as the finish place, which it no longer does (TrackScore-Master, 2026-10-29: from finish rows only).
 * @param {string} bib
 * @param {{ timeText: string, last: string, here?: boolean } | null} [marked] the pass the operator marked as the finish, and
 *   the last split (here: the split asked about is that last split)
 */
function noPlaceText(bib, marked = null) {
  if (marked) {
    return `Bib ${bib} has finished: you marked ${marked.timeText} as its finish, and Split Relay doesn't know a finish place for it. `
      + `A finisher's splits go out with the finish place, so nothing of bib ${bib}'s can go live. To send it: ${marked.here ? 'choose' : `in ${marked.last} choose`} `
      + `"Missed ${marked.last}: add it" (${marked.timeText} is the finish pass again, not the finish)${marked.here ? '' : ', then this split'}.`;
  }
  return `Bib ${bib} has finished, but Split Relay doesn't know the finish place (it comes from FinishLynx's .lif file: ` +
    'Settings, Merged .lif files). A finisher\'s splits go out with the finish place, so this one waits for it.';
}

/**
 * Revision 10, the place rule: a finished runner's split that went out after the runner finished, with the split
 * place (a split held by a pause, played a moment after FinishLynx's finish reached TrackScore but before it reached
 * FinishLynx's file). The same words in public/app.js (a test checks it).
 * @param {number|null} place the place it went out with
 * @param {number|null} finishPlace
 */
export function sentAfterText(place, finishPlace) {
  return `Sent after the runner finished, with place ${place ?? '?'}: TrackScore and the live results may show that as ` +
    `the runner's place. Send it with the finish place${finishPlace != null ? ` (${finishPlace})` : ''}.`;
}

/**
 * The words for a set-aside contest (DESIGN 9.2), on its feed rows and in the panel's warning:
 * "Reads of 'Girls Varsity' are not used: its race 'Girls 5K' was deleted. List the contest on an Active race to use them."
 * For the reads of a port or an event (LapTime lines, 9.15 L3) it says what to choose on a race instead.
 * @param {{ contest: string, reason: string, key?: string, via?: string, port?: number|null, event?: string|null }} a
 */
export function asideText(a) {
  const info = typeof a.key === 'string' ? routeKeyInfo(a.key) : { via: a.via, port: a.port, event: a.event };
  if (info.via === 'port') return `Reads from port ${info.port} are not used: ${a.reason}. Choose port ${info.port} on an Active race to use them.`;
  if (info.via === 'event') return `Reads for event ${info.event} are not used: ${a.reason}. Give an Active race event ${info.event} to use them.`;
  return `Reads of '${a.contest}' are not used: ${a.reason}. List the contest on an Active race to use them.`;
}

// ---- routing (DESIGN 9.2) -------------------------------------------------------------------------------------------
//
// The rules, written once and used three ways: for a read arriving now (routeNew), for the reads already received
// when the settings change (planRoutes, applied by Engine.#settle), and for the panel's dialogs before a change is
// saved (Engine.planChange runs planRoutes on the settings as they would be). The three can therefore never disagree.
//
// Revision 6: a contest that only races that are not Active list waits in no race for them (an inactive race takes no
// read, old or new), and a race that is gone from the settings without being deleted is missing, not deleted: its
// reads wait for it, and so do the reads of its contests that would otherwise go to the race taking every contest.

/**
 * @typedef {{ races: any[], byId: Map<string, any>, listing: Map<string, any[]>, catchAll: any }} Routes
 *   compiled races: `listing` maps a routing key (a contest, a race's port or event: 9.15 L3) to the races that list
 *   it (config order); `catchAll` is the first active race that takes every contest (no contest list and no port)
 * @typedef {{ contest: string, key: string, byId: string|null, byName: string, deleted: boolean, since?: number,
 *   transient?: boolean, suppressed?: boolean }} AsideEntry  contest: what the panel calls it ("Port 5565" for a key)
 *   why a contest is set aside: its race `byId` was deleted (R2), or stopped listing it (R4f). `transient`: worked out
 *   at a start from the settings found then (R4f), in memory only, never journaled, and worked out again at every
 *   change. `suppressed`: journaled, but a race has listed the contest since a start: not in effect (no 'unaside' is
 *   journaled for it), and in effect again if the listing goes.
 * @typedef {{ raceId: string|null, home: string|symbol|null, key: string, contest: string, reads: any[] }} Bucket
 *   the live reads with the same race, home and contest: the rules give them all the same answer
 * @typedef {Map<string, string>} Held  contest key ('' = no contest) -> the missing race its reads wait for (R6)
 */

/** No contest is held: what routeKept is asked with to find out whether a contest would be let go at all. */
const NONE_HELD = new Map();

/**
 * Where a new read of this contest goes (R4, new reads): the active race that lists it; else nowhere when races that
 * are not Active list it (it waits for them, 'paused': R1), when it is set aside (R5) or when it waits for a missing
 * race (R6); else the active race that takes every contest.
 * @param {Routes} cfg
 * @param {Map<string, AsideEntry>} aside
 * @param {Held} held
 * @param {string} key matchKey of the contest ('' = none)
 * @returns {any} compiled race or null
 */
function routeNew(cfg, aside, held, key) {
  if (!key) return held.has('') ? null : cfg.catchAll;
  const listing = cfg.listing.get(key);
  // An explicit listing always beats "every contest", also when the race that lists it is not Active: the read waits
  // for that race in no race, never inside it (R1) and never in the race that takes every contest.
  if (listing) return listing.find((r) => r.active) ?? null;
  if (aside.has(key) || held.has(key)) return null;
  return cfg.catchAll;
}

/**
 * Where reads already received go when the settings change (R4). Only reads in an active race or in no race are asked:
 * a race that is not Active keeps exactly the reads it has (R1), and so does a missing race (R6).
 *   a. an active race lists the contest: there (the one they are in, if several do);
 *      (races that are not Active list it, and no active race does: no race; they wait for one of them to be switched
 *      on. They come out of a race that takes every contest too: an explicit listing beats "every contest".)
 *   b. the contest is set aside: no race;
 *      (the contest waits for a missing race: no race)
 *   c. they are in an active race that takes every contest: they stay;
 *   d. their home (the first race they were in) is an active race that takes every contest: back there;
 *   e. they never had a race: the active race that takes every contest, if any;
 *   f. LET_GO: a race took them out of its list and they have nowhere to go: the contest is set aside.
 * A read without a contest can't be listed or set aside: it goes with the race that takes every contest.
 * @param {Routes} cfg
 * @param {Map<string, AsideEntry>} aside
 * @param {Held} held
 * @param {Bucket} b
 * @returns {any} compiled race, null, or LET_GO
 */
function routeKept(cfg, aside, held, b) {
  const cur = b.raceId === null ? null : cfg.byId.get(b.raceId) ?? null;
  const curTakesAll = cur !== null && cur.active && cur.takesAll;
  if (!b.key) return held.has('') ? null : curTakesAll ? cur : cfg.catchAll;
  const listing = cfg.listing.get(b.key);
  if (listing) {
    let first = null;
    for (const r of listing) {
      if (!r.active) continue;
      if (r === cur) return r;
      first ??= r;
    }
    return first;
  }
  if (aside.has(b.key) || held.has(b.key)) return null;
  if (curTakesAll) return cur;
  const home = typeof b.home === 'string' ? cfg.byId.get(b.home) : undefined;
  if (home && home.active && home.takesAll) return home;
  if (b.home === null) return cfg.catchAll;
  return LET_GO;
}

/**
 * What a settings change does to every live read (DESIGN 9.2). Pure: Engine.#settle applies the result and journals
 * it; Engine.planChange shows it to the operator before the change is saved.
 *   R2: a race deleted by the operator (`deletedIds`) takes its reads out of use. A contest of those reads is set aside,
 *       so that the reads of it still to come are not used either, when new reads of it went to the deleted race (or
 *       waited for it), no race lists it now and no race holds reads of it that count (an active race: then new reads go
 *       there, with them; a missing race: then they wait for it).
 *   R6: a race that is gone from the settings but was not deleted (config.json restored or edited) is missing: its
 *       reads stay with it, not used, and come back with it. The contests of its reads (and of reads whose home it is)
 *       are held while no race lists them and they are not set aside: their reads wait for it in no race, the new ones
 *       too, instead of going to the race that takes every contest. Only when that race already has reads of the
 *       contest, and none would be let go, do they go there with them.
 *   R5: a contest that a race lists is no longer set aside.
 *   R4: the reads in active races and in no race are routed again (routeKept). Every contest that rule f lets go of is
 *       set aside first, so that all its reads, wherever they were, end up together in no race.
 * @param {Routes} cfg the races after the change
 * @param {Routes|null} prev before it (null at start, when it is not known)
 * @param {Map<string, AsideEntry>} aside the journaled set-asides before the change (a suppressed one too; see opts)
 * @param {Held} prevHeld held before the change
 * @param {Bucket[]} buckets every live read, grouped
 * @param {(id: string) => string} nameOf a race's name, also once it is deleted or missing
 * @param {Set<string>} [deletedIds] the races the operator deleted in this change (DELETE /api/races/:id)
 * @param {{ transient?: Set<string>, atStart?: boolean, prevAside?: Map<string, AsideEntry> }} [opts] `aside` holds the
 *   journaled set-asides; `transient` the contests a start set aside (in memory), worked out again here: one that is
 *   let go again stays transient (never journaled), as does every set-aside at start; `prevAside` = what was in
 *   effect before the change (where new reads went)
 */
function planRoutes(cfg, prev, aside, prevHeld, buckets, nameOf, deletedIds = new Set(), { transient = new Set(), atStart = false, prevAside = aside } = {}) {
  /** @type {Map<string, { id: string, name: string, buckets: Bucket[] }>} */
  const deleted = new Map();
  /** @type {Map<string, { id: string, name: string, buckets: Bucket[] }>} */
  const missing = new Map();
  /** @type {Bucket[]} in an active race or in no race */
  const routable = [];
  for (const b of buckets) {
    if (b.raceId === null) {
      routable.push(b);
      continue;
    }
    const race = cfg.byId.get(b.raceId);
    if (race) {
      if (race.active) routable.push(b);
      continue;
    }
    const into = deletedIds.has(b.raceId) ? deleted : missing;
    let d = into.get(b.raceId);
    if (!d) into.set(b.raceId, (d = { id: b.raceId, name: nameOf(b.raceId), buckets: [] }));
    d.buckets.push(b);
  }
  const unaside = [...aside.keys()].filter((k) => cfg.listing.has(k));
  const after = new Map([...aside].filter(([k]) => !cfg.listing.has(k)));
  /** contest key -> the missing race its reads wait for (R6): the contests of its reads, then of reads whose home it is */
  const waitFor = new Map();
  for (const m of missing.values()) for (const b of m.buckets) if (!waitFor.has(b.key)) waitFor.set(b.key, m.id);
  for (const b of routable) {
    if (typeof b.home === 'string' && missing.has(b.home) && !waitFor.has(b.key)) waitFor.set(b.key, b.home);
  }
  /** @type {Map<string, AsideEntry>} */
  const added = new Map();
  const heldLive = new Set();
  for (const b of routable) if (b.raceId !== null && b.key) heldLive.add(b.key);
  for (const d of deleted.values()) {
    for (const b of d.buckets) {
      const k = b.key;
      if (!k || after.has(k) || cfg.listing.has(k) || heldLive.has(k) || waitFor.has(k) || !prev) continue;
      // only the race new reads of the contest went to, or waited for (it listed the contest and was not Active, or it
      // was missing and they waited for it)
      const to = routeNew(prev, prevAside, prevHeld, k);
      if (to ? to.id !== d.id : !(prev.listing.get(k)?.some((r) => r.id === d.id) || prevHeld.get(k) === d.id)) continue;
      const a = { contest: b.contest, key: k, byId: d.id, byName: d.name, deleted: true };
      added.set(k, a);
      after.set(k, a);
    }
  }
  /** @type {Held} */
  const held = new Map();
  const all = cfg.catchAll;
  for (const [k, id] of waitFor) {
    if (k && (cfg.listing.has(k) || after.has(k))) continue;
    // With the race that takes every contest when it has reads of the contest already and none of them would be let
    // go: then they all stay together there. Otherwise the reads wait for the missing race, all of them.
    const mine = (b) => b.key === k;
    if (all && routable.some((b) => mine(b) && b.raceId === all.id)
      && !routable.some((b) => mine(b) && routeKept(cfg, after, NONE_HELD, b) === LET_GO)) continue;
    held.set(k, id);
  }
  for (const b of routable) {
    if (!b.key || after.has(b.key) || routeKept(cfg, after, held, b) !== LET_GO) continue;
    // who let go of it: the race it is in; for a read already in no race, the race that listed the contest before
    // (it stopped listing it, or was deleted), else its home
    let byId = b.raceId;
    if (byId === null) byId = prev?.listing.get(b.key)?.[0]?.id ?? (typeof b.home === 'string' ? b.home : null);
    // worked out from the settings a start found: kept in memory only (DESIGN 9.2), and worked out again at every change
    const a = { contest: b.contest, key: b.key, byId, byName: byId ? nameOf(byId) : '', deleted: false, transient: atStart || transient.has(b.key) };
    added.set(b.key, a);
    after.set(b.key, a);
  }
  /** @type {Map<Bucket, any>} */
  const target = new Map();
  for (const b of routable) target.set(b, routeKept(cfg, after, held, b));
  return { deleted: [...deleted.values()], missing: [...missing.values()], unaside, added, after, held, target };
}

/**
 * The races and outputs of a config, ready for routing and derivation. Pure, so planChange() can look at settings that
 * are not saved yet.
 * @param {any} cfg
 * @returns {Routes & { outputs: any[] }}
 */
function compileConfig(cfg) {
  const races = [];
  const byId = new Map();
  const listing = new Map();
  for (const r of arr(cfg?.races)) {
    const id = text(r?.id);
    if (!id || byId.has(id)) continue;
    const splits = [];
    const splitById = new Map();
    const sourceToSplit = new Map();
    for (const s of arr(r.splits)) {
      const sid = text(s?.id);
      if (!sid || splitById.has(sid)) continue;
      // earliest: before this race time a pass can't be this split (9.15 L4); null = no limit
      const e = text(s.earliest) ? parseRaceTime(s.earliest) : null;
      // 9.26: a split point that is counted but not sent (a mat a little after a K marker): it takes passes like any
      // split, and nothing of it ever goes to an output or into the merged .lif. It can't be paused: there is nothing to hold
      const collectOnly = s.collectOnly === true;
      const split = { id: sid, name: text(s.name) || `Split ${splits.length + 1}`, index: splits.length, sources: list(s.sources),
        earliest: e !== null && e >= 0 ? e : null, earliestText: e !== null && e >= 0 ? text(s.earliest) : '',
        // paused by the operator (9.17 P1): its crossings are worked out and shown, but held back from every output
        sending: collectOnly || s.sending !== false, collectOnly,
        // 9.26: its place among the splits that are sent (-1: not sent) and its laps to go (null: not sent), set below
        sentIndex: -1, l2g: null };
      splits.push(split);
      splitById.set(sid, split);
      // A location listed under two splits belongs to the first one in course order.
      for (const src of split.sources) if (!sourceToSplit.has(matchKey(src))) sourceToSplit.set(matchKey(src), split);
    }
    // 9.26: the splits that are sent, in course order. TrackScore and Karmarush are set up with these only, so a split's
    // laps to go is the number of SENT splits from it to the end (the last sent split is 1, never 0) and the split
    // count every packet and ledger entry carries is the number of sent splits. With every split sent: as before.
    const sent = splits.filter((s) => !s.collectOnly);
    sent.forEach((s, i) => {
      s.sentIndex = i;
      s.l2g = sent.length - i;
    });
    const explicit = new Set(list(r.contests).map(matchKey));
    const inputPort = Number.isInteger(r.inputPort) && r.inputPort > 0 ? r.inputPort : null;
    const ev = eventKey(r.eventNumber, r.round, r.heat);
    // A race lists its contests, and with them its port and its event (9.15 L3): a LapTime read that carries neither
    // a contest nor an event goes by the port it came in on, one with FinishLynx's event fields by its event.
    const contestKeys = new Set(explicit);
    if (inputPort !== null) contestKeys.add(portKey(inputPort));
    if (ev) contestKeys.add(eventRouteKey(ev));
    const race = {
      id, race: r, order: races.length, name: text(r.name) || 'Race', active: r.active !== false,
      // (9.25: the event its start list is matched on: round and heat do not matter)
      event: eventKeyOf(r.eventNumber),
      contestKeys, splits, splitById, sourceToSplit, inputPort,
      // 9.26: the splits that are sent (not "counted only"), and how many: the split count the outputs go by
      sent, sentCount: sent.length,
      // "takes every contest" (9.2): no contest list and no port; a race with a port takes that port's reads
      takesAll: explicit.size === 0 && inputPort === null,
      finishKeys: new Set(list(r.finishSources).map(matchKey)),
      gunTicks: parseTod(r.gun), gunText: text(r.gun),
      // which splits are paused (9.17 P1): a change sends what was held, or holds what is not sent yet. 9.26: and which
      // are not sent at all (2): a change gives the other splits other laps to go, so everything is looked at again
      sendSig: splits.map((s) => (s.collectOnly ? 2 : s.sending ? 1 : 0)).join(''),
    };
    races.push(race);
    byId.set(id, race);
    for (const k of contestKeys) {
      const l = listing.get(k);
      if (l) l.push(race);
      else listing.set(k, [race]);
    }
  }
  const outputs = [];
  const outIds = new Set();
  for (const o of arr(cfg?.outputs)) {
    const id = text(o?.id);
    if (!id || outIds.has(id)) continue;
    outIds.add(id);
    // (9.24: clearLines, the output takes a clearing line for a split that was taken back; off unless set)
    outputs.push({ id, name: text(o.name) || id, enabled: o.enabled !== false, races: list(o.races), ...(o.clearLines === true ? { clearLines: true } : {}) });
  }
  const catchAll = races.find((r) => r.active && r.takesAll) ?? null;
  // (9.25: athletes entered in another race are kept off the boards unless the setting says "send and flag")
  return { races, byId, listing, catchAll, outputs, keepOff: cfg?.entries?.otherRace !== 'send' };
}

function printable(raw) {
  const s = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/**
 * A read from parseLine (or the journal) -> the engine's record of it, or a plain-English reason it is unusable. The
 * record has every field from the start, in one literal, so each is one compact object: a meet's journal is tens of
 * thousands of them, all in memory. Its journal position and race are filled in by placeRec once it is accepted.
 * @param {any} read
 * @param {(s: string) => string} [intern] shares equal strings between reads
 * @param {(s: string) => string} [keyOf] matchKey, possibly cached
 * @param {unknown} [port] the RR12 input port the line came in on (9.15 L2), or nothing
 */
function cleanRead(read, intern = (s) => s, keyOf = matchKey, port = read?.port) {
  if (!read || typeof read !== 'object') return 'This line is not a read';
  const bib = text(read.bib);
  if (!bib || /^0+$/.test(bib)) return 'The read has no bib number';
  const tod = typeof read.tod === 'number' ? read.tod : parseTod(read.tod);
  if (tod === null || !Number.isFinite(tod)) return 'The read has no valid time of day';
  const location = intern(text(read.location));
  // control characters never belong in a contest name, and the port and event keys start with one
  const contest = intern(text(read.contest).replace(/[\x00-\x1f\x7f]/g, ''));
  const event = text(read.event) ? intern(text(read.event).toLowerCase()) : '';
  const p = Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  // (9.27: one shared string for the bib as received and, until a swap says otherwise, the runner it counts for)
  const chip = intern(bib);
  // the routing key (9.15 L3): the contest, else FinishLynx's event, else the port; '' for none of them
  const key = contest ? keyOf(contest) : event ? intern(eventRouteKey(event)) : p !== null ? intern(portKey(p)) : '';
  return {
    location, locKey: keyOf(location), bib: chip,
    tod: ((Math.round(tod) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY,
    // contestKey is the routing key: the contest's matchKey, or the event's or port's key (routeKeyInfo)
    contest, contestKey: key, event, port: p, first: intern(text(read.first)), last: intern(text(read.last)),
    team: intern(text(read.team)), gender: intern(text(read.gender)),
    seq: 0, at: 0, conn: null, raceId: null,
    // 9.27 (swapped bibs): `chip` is the bib as RR12 sent it, for good (the journal, a repeated line); `bib` is the
    // runner the read counts for: the same, or the other bib of the pair while a swap is in force (Engine #label)
    chip,
    // the race the read was first given (DESIGN 9.2), or ASIDE: a read whose home takes every contest goes back there
    // when the race that took it from there lets it go; a read that never had a race is routed like a new one
    home: null,
    // LIVE, or out of use for good: CLEARED (Clear race data) or DELETED (its race was deleted)
    gone: LIVE,
    // what the read means in its race now, and the runner derivation that worked it out (see #outcome)
    o: null, od: null,
  };
}

/** A read accepted at journal position `seq`. */
function placeRec(rec, seq, at, conn, raceId, home = raceId) {
  rec.seq = seq;
  rec.at = at;
  rec.conn = conn;
  rec.raceId = raceId;
  rec.home = home;
  return rec;
}

/** A read's journal record (DESIGN 9.1). */
function journalRead(rec) {
  const j = {
    t: 'read', seq: rec.seq, at: rec.at, conn: rec.conn, location: rec.location, bib: rec.chip, tod: rec.tod,
    contest: rec.contest, first: rec.first, last: rec.last, team: rec.team, gender: rec.gender, raceId: rec.raceId,
  };
  // Revision 7 (9.15): the port the line came in on, and FinishLynx's event of a LapTime line: they decide its race.
  if (rec.port !== null) j.port = rec.port;
  if (rec.event) j.event = rec.event;
  // Revision 6: whether a read with no race came while its contest was set aside (its home, see ASIDE). Written down,
  // because a set-aside that a start worked out is not journaled: the replay could not tell otherwise.
  if (rec.raceId === null) j.aside = rec.home === ASIDE ? 1 : 0;
  return j;
}

/**
 * @typedef {{ raceId: string, bib: string, splitId: string, tod: number|null, raceTicks: number, estimated: boolean,
 *   basis: string, at: number, mseq: number, seq: number }} ManualRec  a made-up time (9.17 P3): tod is the time of
 *   day it stands for (so a gun corrected later moves it with the real reads around it); estimated: the relay's
 *   estimate as it was, false = the operator typed another time; mseq: its order among made-up times; seq: the
 *   journal position when it was made
 */

/** An error of a Review action, with the HTTP status the panel gets (the message is shown as it is). */
function reviewError(status, message) {
  return Object.assign(new Error(message), { status, code: 'REVIEW' });
}

/**
 * DESIGN 9.27: why a text can't be one of a pair of swapped bibs, in words, or null. (A bib is whatever RR12 sends; a
 * crossing's key is "bib|split id", so a bar can't be in one.)
 */
function swapBibProblem(b) {
  if (!b) return 'Type both bib numbers.';
  if (/^0+$/.test(b) || b.length > 20 || /[\x00-\x1f\x7f|]/.test(b)) return `"${printable(b)}" is not a bib number.`;
  return null;
}

/** 9.27: the most swapped pairs at a time (a meet has one or two; a list this long is a mistake). */
const MAX_SWAPS = 50;

/** 9.27: "5 splits (3:17.3 to 17:57.9)", "1 split (3:17.3)": a runner's crossings that count, in course order. */
function splitsText(kept) {
  const t = (c) => formatRaceTime(c.rt, 1);
  return kept.length === 1 ? `1 split (${t(kept[0])})` : `${kept.length} splits (${t(kept[0])} to ${t(kept[kept.length - 1])})`;
}

/**
 * 9.27: what entering or removing a swap of bibs did in one race, in sentences (Engine #changeSwap; the panel shows
 * them as they are): whose the splits are now, whether they went out, what the boards still show.
 */
function swapLines(race, r, lif) {
  const lines = [];
  const n = (k, one = 'split') => (k === 1 ? `1 ${one}` : `${k} ${one}s`);
  // whose the reads are now (owners: each bib of the pair here: its splits now, the splits it had, whether it has reads)
  const parts = [];
  for (const o of r.owners) if (o.reads) parts.push(o.splits ? `${n(o.splits)} ${o.splits === 1 ? 'is' : 'are'} bib ${o.bib}'s now` : `bib ${o.bib} has the reads now (no split is counted from them)`);
  for (const o of r.owners) if (!o.reads && o.had && !o.splits) parts.push(`bib ${o.bib} has none here`);
  if (!parts.length) return lines;
  lines.push(`${parts.join('; ').replace(/^./, (ch) => ch.toUpperCase())}.`);
  if (race.gunTicks === null) return lines;
  // a runner who is kept off the boards here stays off them, whatever bib its reads came in as
  for (const o of r.owners) {
    if (o.reads && o.away) lines.push(`Bib ${o.bib} is not in this race (${o.away}): nothing of it goes out. Review, Not in this race.`);
    else if (o.reads && o.off) lines.push(`Bib ${o.bib} is not sent here (Stop sending this runner).`);
  }
  if (!race.active) lines.push(`Not sent: ${race.name} is not Active.${lif ? ' Its merged .lif file follows by itself.' : ''}`);
  else {
    if (r.sentTo.length) lines.push(`Sent to ${listWords(r.sentTo)}.`);
    const why = new Map();
    for (const x of r.notLive) {
      const k = `${x.bib}\u0000${x.why}`;
      why.set(k, (why.get(k) ?? 0) + 1);
    }
    for (const [k, count] of why) {
      const [bib, w] = k.split('\u0000');
      lines.push(w.startsWith('has finished') ? `${n(count)} of bib ${bib} ${count === 1 ? 'was' : 'were'} not sent: bib ${bib} has finished. Review lists ${count === 1 ? 'it' : 'them'} under Finished: not sent live (Send with finish place).`
        : `${n(count)} of bib ${bib} ${count === 1 ? 'was' : 'were'} not sent: ${w}.`);
    }
    if (r.resent.lines) lines.push(`${n(r.resent.lines, 'line')} of other runners went out again with ${r.resent.lines === 1 ? 'its' : 'their'} new place${r.resent.lines === 1 ? '' : 's'}.`);
  }
  const left = new Map();
  for (const x of r.leftover) left.set(x.bib, (left.get(x.bib) ?? 0) + 1);
  for (const [bib, count] of left) lines.push(`The boards still show ${n(count)} under bib ${bib} (sent before): a packet can't empty a cell.`);
  if (r.cleared.lines) lines.push(`A clearing line went to ${listWords(r.cleared.outputs)} for ${r.cleared.lines === 1 ? 'it' : `${r.cleared.lines} of them`}.`);
  return lines;
}

/** A 'manual' journal record -> ManualRec, or null when it is unusable. */
function manualRec(rec, mseq) {
  const raceId = text(rec?.raceId);
  const bib = text(rec?.bib);
  const splitId = text(rec?.splitId);
  const rt = finite(rec?.raceTicks);
  if (!raceId || !bib || !splitId || rt === null) return null;
  return { raceId, bib, splitId, tod: Number.isInteger(rec.tod) ? rec.tod : null, raceTicks: rt, estimated: rec.estimated !== false,
    basis: text(rec.basis), at: finite(rec.at) ?? 0, mseq,
    // 9.27: the chip whose reads counted for the bib when the time was made: the bib's own, or the other bib of a swapped
    // pair (journaled only then)
    chip: text(rec.chip) || bib,
    // the journal position when it was made: only reads that came after it can be the real crossing it stood for
    seq: Number.isInteger(rec.seq) ? rec.seq : 0 };
}

/**
 * Why a race's splits on the outputs are out of date (RaceView.stale, 9.15 L6), for the resend prompt: TrackScore and
 * Karmarush file a split in the column "split count - laps to go", so a split count changed (or splits reordered) after
 * packets went out puts what they show in the wrong columns.
 * @param {any} race compiled race
 * @param {number} count stale crossings
 * @param {{ counts: Map<number, number>, order: number }} why per stale entry: the split count it was sent with
 *   (when different), or a different laps to go with the same count (a reorder)
 */
function staleWhy(race, count, why) {
  if (!count) return { reason: null, splitCountFrom: null, hint: null };
  // 9.26: the splits that are sent: the count TrackScore and Karmarush are set up with
  const n = race.sentCount;
  let from = null;
  let most = 0;
  for (const [k, c] of why.counts) if (c > most) [from, most] = [k, c];
  if (from !== null) {
    const has = n === race.splits.length ? `has ${n} split${n === 1 ? '' : 's'}` : `sends ${n} split${n === 1 ? '' : 's'}`;
    return { reason: 'split-count', splitCountFrom: from,
      hint: `TrackScore and Karmarush put splits in columns by laps to go; this race now ${has} ` +
        `instead of ${from}, so the splits already sent are in the wrong columns. Resend this race's splits. ${RESEND_LIMIT}` };
  }
  if (why.order) {
    // (9.26: the same number of splits is sent, with other laps to go: another order, or other splits are sent now)
    const how = n === race.splits.length ? "this race's splits were put in another order " : "this race's splits were put in another order, or other splits are sent now, ";
    return { reason: 'order', splitCountFrom: null,
      hint: `TrackScore and Karmarush put splits in columns by laps to go; ${how}` +
        `after they were sent, so they are in the wrong columns. Resend this race's splits. ${RESEND_LIMIT}` };
  }
  return { reason: 'changed', splitCountFrom: null,
    hint: `The gun time, the splits or the places changed after the splits went out. Resend this race's splits. ${RESEND_LIMIT}` };
}

/** First index in a sorted crossing list whose place order is not before c. */
function lowerBound(list, c) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmpCrossing(list[mid], c) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Races, tag filter, places and delivery. See DESIGN.md sections 4.5 and 9.
 *
 * Events: 'feed' (FeedEntry; again with the same id whenever its outcome changes), 'race' (raceId; that race's
 * crossings, reads or gun changed, coalesced per call), 'config-patch' ({ raceId, patch }; the config owner must apply
 * it synchronously), 'send' (packet, outputId; a packet an output accepted, for logs and tests).
 */
export class Engine extends EventEmitter {
  #getConfig;
  #names;
  #store;
  #clock;
  #log;
  /** @type {Deliver} */
  #deliverFn;
  #finishersFn;
  #races = [];
  #raceById = new Map();
  /** contest key -> the races that list it, in config order (DESIGN 9.2) */
  #listing = new Map();
  /** The first active race with no contest list: where a new read of a contest nobody lists goes. */
  #catchAll = null;
  /** The same races, as the routing rules take them (planRoutes, routeNew). @type {Routes} */
  #routing = { races: [], byId: new Map(), listing: new Map(), catchAll: null };
  /** race id -> its name, kept after the race is deleted: "its race 'Girls 5K' was deleted" */
  #raceNames = new Map();
  /**
   * contest key -> why its reads are not used (DESIGN 9.2 R5): its race was deleted, or stopped listing the contest
   * and its reads had nowhere to go back to. Until a race lists the contest, its reads, the new ones too, have no race:
   * a race that takes "every contest" must not rank them among its own runners. The reason is worked out when it is
   * shown, so it never names a race by an old name, or as still there once it is deleted.
   * @type {Map<string, AsideEntry>}
   */
  #setAside = new Map();
  /** contest key -> live reads of a set-aside contest (they have no race), for the panel's warning */
  #asideCount = new Map();
  /**
   * DESIGN 9.2 R6: contest key ('' = no contest) -> the missing race its reads wait for. Worked out at every settings
   * change and at start, never journaled: it lasts while that race is missing, and a start works it out again.
   * @type {Held}
   */
  #held = new Map();
  /**
   * Races that have reads but are not in the settings and were not deleted (config.json was restored from its backup,
   * reset or edited): race id -> { raceId, raceName, count, contests }. Their reads wait for them (R6).
   */
  #missing = new Map();
  /** Races the operator deleted (DELETE /api/races/:id, or a 'delete' record in the journal): only these retire reads. */
  #deletedIds = new Set();
  /** race id -> when it was deleted and under which name (9.15 V5: a deleted race back in the settings is warned about) */
  #deletedAt = new Map();
  /**
   * Live reads that are in no race, and why: `${status}\u0000${contest key}` -> { contest, blank, status, count,
   * raceId, raceName }. Kept up to date at every settings change and new read, so the panel never walks the reads.
   */
  #noRace = new Map();
  /** race id -> its name as its race file has it (a missing race is not in the settings), '' when unknown */
  #fileNames = new Map();
  #outputs = [];
  #outputsSig = '';
  /** The read journal in memory, in journal order (a list: a table keyed by seq would cost more than the reads). */
  #readList = [];
  /**
   * bib -> every read of that bib, for spotting an exact repeat (same timing point and time): a 'duplicate', never
   * journaled again. A list per bib holds a handful of reads; a key string per read would cost more memory than the read.
   */
  #byBib = new Map();
  #intern = internTable();
  /** matchKey per distinct name: the regex runs once per timing point or contest, not once per read. */
  #keys = new Map();
  #seq = 0;
  /**
   * raceId -> the journal position of its last Clear race data. The reads it held then are marked CLEARED one by one
   * (DESIGN 9.2 R3); this is kept for the race file, which also records it.
   */
  #clearSeq = new Map();
  /**
   * The journal position of the last "Start a new meet" (DESIGN 9.22 M9), 0 for none: every read up to it is out of
   * use, and a race file saved before it holds the last meet's deliveries.
   */
  #meetSeq = 0;
  #states = new Map();
  /** The newest FEED_SIZE entries, a ring: #feedStart is the oldest. */
  #feed = [];
  #feedStart = 0;
  #feedBySeq = new Map();
  /**
   * feed entry -> the read it shows. Kept beside the entry, not on it: FeedEntry's shape is the panel's, and an extra
   * (hidden) property would make each of the tens of thousands of entries of a Replay a bigger, slower object.
   */
  #recOf = new WeakMap();
  /** compiled race -> its feed texts (#textsOf) */
  #texts = new WeakMap();
  #feedSeq;
  #feedAll = false;
  #seenLocations = new Map();
  #seenContests = new Map();
  /** every routing key a read has had (contests, events, ports), for the plan's "new reads go elsewhere" (9.2) */
  #seenKeys = new Set();
  /** reads with no timing point name (FinishLynx LapTime lines): they carry no names (9.15 L8) */
  #passesSeen = 0;
  /** clock lag samples (seconds) of reads that did not come in a burst, a ring of LAG_SAMPLES */
  #lag = [];
  #lagPos = 0;
  /**
   * The reads of the last LAG_BURST_MS, oldest first, each { at, lag }: a sample joins #lag once it is older than that
   * and no flush was seen around it (#lagFlagged). #lagHead is the first one still waiting; #lagMin / #lagMax are
   * monotonic queues (indices) for the smallest and largest lag among them.
   */
  #lagWin = [];
  #lagHead = 0;
  #lagMin = { q: [], h: 0 };
  #lagMax = { q: [], h: 0 };
  /** index into #lagWin up to which every waiting read is marked as part of a flush */
  #lagFlagged = 0;
  #holdTimer = null;
  #holdTimerAt = Infinity;
  #saveTimers = new Map();
  #unsaved = new Set();
  #touched = new Set();
  #delivering = false;
  #halted = false;
  #readiness = new Map();
  /** output id -> its last OutputStatus (converge(statuses)): why it turned a packet away, for the feed (9.16 F3) */
  #outStatus = new Map();
  /** a feed refresh is due in a microtask (an output acknowledged or dropped a packet outside a batch) */
  #feedSoon = false;
  #flightSeq = 0;
  #journalWarnedAt = -Infinity;
  /** Whether the journal ends with a clean stop (markCleanStop). A journal without one means a kill or a crash. */
  #cleanStop = true;
  /** After a kill: ledger entries that may never have left this PC, sent again REDELIVER_SETTLE_MS after start(). */
  #suspects = null;
  #suspectTimer = null;
  /**
   * 9.23 F14: while #releaseSuspects sends them again: the entries it forgot, state -> "outputId|key" -> entry (what
   * the output acknowledged before the kill), so a finisher's furthest split can follow a made-up split that went again
   * (#sendFurthestFinished).
   */
  #redelivered = null;
  /**
   * DESIGN 9.17 P2, 9.23 F2: the operator's decisions on passes. race id -> bib -> the time of day of one read of the
   * pass -> Pin { split, as: 'move'|'keep'|'hold'|'none'|'finish', seen } (see pinOf).
   */
  #pins = new Map();
  /**
   * DESIGN 9.24: the runners the operator stopped sending ("Stop sending this runner"). race id -> bib -> { from, at }:
   * `from`, a time of day: the runner's crossings from then on stay off every output and out of the merged .lif (still
   * read, counted and shown), until "Send this runner again"; `at`, when the operator said so. Journaled as
   * { t: 'runner-off', raceId, bib, from } and { t: 'runner-on', raceId, bib }, parts of a change like a pin (Undo).
   */
  #offs = new Map();
  /**
   * DESIGN 9.25: what the operator said of where a runner runs. race id -> bib -> 'here' ("Count them here": a runner the
   * start list or the day's other races put elsewhere is this race's all the same) or 'away' ("Not in this race": its
   * reads here are counted and shown, never sent, never in the merged .lif, no part of the others' places). Journaled as
   * { t: 'runner-say', raceId, bib, say: 'here'|'away'|null }, part of a change like a pin (Undo).
   */
  #says = new Map();
  /**
   * DESIGN 9.27, swapped bibs: the pairs of bibs whose chips were swapped, for the whole meet, in the order they were
   * entered: [{ a, b, at }] (`at`: when, wall ms). While a pair is in force every read of chip a counts for runner b and
   * every read of chip b for runner a, in every race, the reads already in and the ones to come (#label). The journal
   * keeps each read as it was received; the pair is journaled as { t: 'swap', a, b, at } and taken out again by
   * { t: 'unswap', a, b, at }. "Start a new meet" forgets the pairs with the reads.
   */
  #swapList = [];
  /** 9.27: bibKey of a swapped bib -> { other: the bib its chip's reads count for, swap: the pair } */
  #swapBy = new Map();
  /** 9.25: the start lists as main.js hands them (opts.startLists), compiled: by event, and the events of each bib */
  #startListsFn = null;
  #lists = { byEvent: new Map(), eventsOf: new Map() };
  /** 9.25: athletes entered in another race are kept off the boards (the default), not sent and flagged */
  #keepOff = true;
  /** 9.25: the races' events and that setting, as the checks were made with them */
  #listSig = '';
  /** 9.25: #listsSnapshot() taken when they changed (#compile), until configChanged has put the boards right */
  #listsBefore = null;
  /**
   * DESIGN 9.23 F3: the operator's changes, each one action (a Move, a fill, an Undo ...) and the journal records it
   * was made of: race id -> fix id -> FixGroup { id, raceId, kind, text, at, bibs: Map<bib, { inverse, sigAfter }>,
   * undoneBy, undoes, byFinish }. Rebuilt from the journal at a start, so Undo works after a restart. byFinish: a
   * finisher's change the operator sent with the finish place; its Undo and Redo go the same way (journaled `byFinish`).
   */
  #fixGroups = new Map();
  /** race id -> fix ids a Clear race data or a Delete forgot, for the words of an Undo that comes too late */
  #fixDropped = new Map();
  /** the newest fix id (live and in the journal) */
  #fixSeq = 0;
  /** the change being made (live) or read back (replay): { group, before: Map<bib, { pins, manuals }> } */
  #fixOpen = null;
  /** the packets handed over during one Review action, [{ outputId, key }], or null outside one (9.23 F4) */
  #capture = null;
  /**
   * While a change goes out (#runFix): its runners and the crossings it gave a new time or column. What convergence
   * hands over of those is the operator's time too (its minute starts again: #windowFrom), and the change sends their
   * furthest split itself (#sendFixed). Null otherwise.
   * @type {{ bibs: Set<string>, keys: Set<string> } | null}
   */
  #fixing = null;
  /** DESIGN 9.17 P3: made-up times. race id -> bib -> split id -> ManualRec */
  #manuals = new Map();
  /** made-up times in journal order (MANUAL_SEQ_BASE) */
  #mseq = 0;
  /** (raceId) -> bib -> FinishLynx finish place, for packets of runners who finished (9.17 P4) */
  #placesFn = null;

  /**
   * @param {object} opts
   * @param {() => any} opts.getConfig returns the current Config (DESIGN.md section 3)
   * @param {{ lookup(bib: string): { first?: string, last?: string, team?: string, gender?: string } | undefined }}
   *   [opts.names] the FinishLynx people file
   * @param {{ load(raceId: string): any, save(raceId: string, data: any): any, remove(raceId: string): any,
   *   appendJournal?(rec: object): void, loadJournal?(): object[] }} [opts.store]
   *   load and appendJournal must be synchronous: a read is on disk before anything is done with it
   * @param {Partial<Clock>} [opts.clock]
   * @param {(line: string) => void} [opts.log] store failures and listener exceptions
   * @param {Deliver} [opts.deliver] hands a packet to one output (OutputManager.deliver). Without one every packet
   *   counts as delivered at once (tests that only listen to 'send').
   * @param {(raceId: string) => Map<string, number> | null} [opts.finishers] who FinishLynx has finished
   *   (LifSync.lynxFinishers): bib -> finish race ticks
   * @param {(raceId: string) => Map<string, number> | null} [opts.finishPlaces] their FinishLynx places
   *   (LifSync.lynxPlaces): bib -> place. A made-up split of a finisher goes out with that place (9.17 P4).
   * @param {boolean} [opts.autoStart=true] start delivering from a 0 ms timer. main.js passes false and calls start()
   *   once FinishLynx's files have been read, so a restart never sends a split to a runner who has finished.
   */
  constructor({ getConfig, names = null, store = null, clock = DEFAULT_CLOCK, log = () => {}, deliver = null,
    finishers = null, finishPlaces = null, startLists = null, autoStart = true } = {}) {
    super();
    if (typeof getConfig !== 'function') throw new TypeError('Engine needs getConfig()');
    this.#getConfig = getConfig;
    this.#names = names;
    this.#store = store;
    // Called as methods, not spread: a clock that is a class instance (shared with LifSync, say) keeps its prototype.
    const c = clock ?? DEFAULT_CLOCK;
    this.#clock = {
      now: typeof c.now === 'function' ? () => c.now() : DEFAULT_CLOCK.now,
      setTimeout: typeof c.setTimeout === 'function' ? (fn, ms) => c.setTimeout(fn, ms) : DEFAULT_CLOCK.setTimeout,
      clearTimeout: typeof c.clearTimeout === 'function' ? (h) => c.clearTimeout(h) : DEFAULT_CLOCK.clearTimeout,
    };
    this.#log = typeof log === 'function' ? log : () => {};
    this.#deliverFn = typeof deliver === 'function' ? deliver : (_id, _p, ack) => {
      ack(true);
      return true;
    };
    this.#finishersFn = typeof finishers === 'function' ? finishers : null;
    this.#placesFn = typeof finishPlaces === 'function' ? finishPlaces : null;
    // 9.25: () -> { events: { [event]: { file, loadedAt, bibs } } }, the start lists the operator loaded (src/entries.js)
    this.#startListsFn = typeof startLists === 'function' ? startLists : null;
    this.#readLists();
    // Feed ids keep rising across restarts, so a panel left open never mistakes a new row for an old one.
    this.#feedSeq = Math.max(0, Math.floor(this.#clock.now())) * 1000;
    this.#compile();
    const now = this.#clock.now();
    this.#replay(now);
    for (const race of this.#races) this.#stateFor(race, now);
    if (!this.#cleanStop) this.#collectSuspects();
    this.#settle(null);
    this.#collectAll();
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      state.active = race.active;
      state.sendSig = race.sendSig;
      // its settings go into its race file too: a race that goes missing can be put back from there (R6)
      state.lastRace = race.race ?? null;
      if (state.savedRace !== JSON.stringify(race.race ?? null)) this.#saveSoon(state);
      this.#refreshFinishers(race, state, false);
      this.#rebuildRace(race, state);
      this.#restoreReleases(state);
    }
    this.#touched.clear();
    // Nobody can be listening yet: what is due goes out from a timer, after main.js has wired everything.
    if (autoStart) this.#clock.setTimeout(() => this.start(), 0);
  }

  /** Begin (or resume) delivering: everything an output has not been given yet goes out now. */
  start() {
    this.#halted = false;
    this.#delivering = true;
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      this.#refreshFinishers(race, state, true);
      state.dirtyAll = true;
    }
    this.#converge(this.#clock.now());
    if (this.#suspects && this.#suspectTimer === null) {
      this.#suspectTimer = this.#clock.setTimeout(() => {
        this.#suspectTimer = null;
        try {
          this.#releaseSuspects(true);
        } catch (err) {
          this.#log(`[engine] sending the packets of before the crash again failed: ${err?.stack ?? err}`);
        }
      }, REDELIVER_SETTLE_MS);
    }
    this.#after();
  }

  /**
   * Process one read from RR12. Never throws: a read that cannot be used becomes a 'bad-line' entry.
   * @param {Read | null} read
   * @param {ReadMeta} [meta]
   * @returns {FeedEntry}
   */
  handleRead(read, meta = {}) {
    return this.handleReads([{ read, meta }])[0];
  }

  /**
   * Process the reads that arrived together (main.js passes every line of one TCP chunk). The new reads are journaled
   * with ONE write before any of them is used; what does not depend on a single read (delivery, the feed rows of other
   * reads, the panel's events) is done once for the lot. An RR12 Replay of a whole meet therefore costs a moment, not
   * seconds of live splits waiting behind it. Never throws: a read that cannot be used becomes a 'bad-line' entry.
   * @param {Array<{ read: Read | null, meta?: ReadMeta }>} items in arrival order
   * @returns {FeedEntry[]} one per item, in the same order
   */
  handleReads(items) {
    const list = Array.isArray(items) ? items : [];
    const now = this.#clock.now();
    const entries = new Array(list.length);
    /** the reads not seen before, and where each is in `list` */
    const fresh = [];
    const at = [];
    const records = [];
    for (let i = 0; i < list.length; i++) {
      const read = list[i]?.read ?? null;
      const meta = list[i]?.meta ?? {};
      try {
        const r = meta.error ? text(meta.error?.message ?? meta.error) || 'Unreadable line' : cleanRead(read, this.#intern, this.#keyOf, meta.port ?? read?.port);
        if (typeof r === 'string') {
          entries[i] = this.#badLine(read, meta.raw ? `${r}: ${printable(meta.raw)}` : r, now, meta.port ?? read?.port);
          continue;
        }
        // An exact repeat (RR12 Replay, a reconnect that sends the last lines again) changes nothing: no journal, no
        // derivation, no delivery. Not so for a read that was cleared with "Clear race data": clear, then Replay in RR12
        // is how an operator rebuilds a race (seen on race day 2026-10-21), so it counts again as a new read. A false
        // start's or a test's reads still don't come back as splits: they are before the race's gun. A deleted race's
        // reads stay out of use.
        // (9.27: the runner it counts for, while its bib is one of a swapped pair)
        this.#label(r);
        const prev = this.#findExact(r);
        if (prev && prev.gone !== CLEARED) {
          entries[i] = this.#duplicate(r, prev, now);
          continue;
        }
        const race = routeNew(this.#routing, this.#setAside, this.#held, r.contestKey);
        // a read of a set-aside contest belongs with the others of it (see ASIDE)
        // (not for a set-aside a start worked out, which is never journaled: see AsideEntry)
        const a = race || !r.contestKey ? undefined : this.#setAside.get(r.contestKey);
        const home = race ? race.id : a && !a.transient && !a.suppressed ? ASIDE : null;
        const rec = placeRec(r, this.#seq + 1, now, meta.connId ?? null, race?.id ?? null, home);
        this.#seq = rec.seq;
        this.#addRead(rec); // a repeat of it later in the same chunk is a duplicate
        records.push(journalRead(rec));
        fresh.push(rec);
        at.push(i);
      } catch (err) {
        entries[i] = this.#failed(read, err, now);
      }
    }
    // On disk before anything is done with them: a relay killed a moment later still has these reads when it starts.
    if (records.length) this.#journalMany(records);
    let deliver = false;
    const lagTod = fresh.length ? localTod(now) : 0;
    for (let n = 0; n < fresh.length; n++) {
      const rec = fresh[n];
      const i = at[n];
      try {
        this.#see(rec, now);
        this.#sampleLag(rec, lagTod, now);
        const entry = this.#entryFor(rec, now);
        this.#recOf.set(entry, rec);
        entries[i] = entry;
        const race = rec.raceId ? this.#raceById.get(rec.raceId) : null;
        const state = race ? this.#states.get(race.id) : null;
        if (state) {
          this.#addToState(state, rec);
          this.#deriveRead(race, state, rec);
          this.#touched.add(race.id);
          if (race.active && race.gunTicks !== null) deliver = true;
        } else this.#countNoRace(rec, 1);
      } catch (err) {
        entries[i] = this.#failed(rec, err, now);
      }
    }
    // Only a read in a race that is sending can change what an output should have.
    if (deliver) {
      try {
        this.#converge(now);
      } catch (err) {
        this.#log(`[engine] delivering after new reads failed: ${err?.stack ?? err}`);
      }
    }
    // Described after delivery, so a read that went out at once says "Sent".
    for (let n = 0; n < fresh.length; n++) {
      const rec = fresh[n];
      const entry = entries[at[n]];
      if (!entry || this.#recOf.get(entry) !== rec) continue;
      try {
        Object.assign(entry, this.#describe(rec));
      } catch (err) {
        this.#log(`[engine] could not describe a read: ${err?.stack ?? err}`);
      }
    }
    for (const entry of entries) if (entry) this.#publish(entry);
    this.#after();
    return entries;
  }

  /**
   * Re-read the config after races or outputs were added, removed or edited, and apply it to every read so far.
   * DESIGN 9.2 R2/R6: only the races named in `deleted` (DELETE /api/races/:id) take their reads out of use. A race that
   * is gone from the settings without being named there is missing: its reads wait for it, and its race file is kept.
   * @param {{ deleted?: Iterable<string> }} [opts] the races the operator deleted
   */
  configChanged({ deleted = [] } = {}) {
    const deletedIds = new Set([...(deleted ?? [])].map(text).filter(Boolean));
    const prevOutputs = this.#outputsSig;
    // the races before the change: whether a deleted race was taking a contest, and who stopped listing one (9.2)
    const prev = this.#routing;
    this.#compile();
    const now = this.#clock.now();
    for (const id of [...this.#states.keys()]) if (!this.#raceById.has(id)) this.#dropRace(id, deletedIds.has(id));
    // a missing race the operator deletes has no state: its race file goes to races\deleted all the same
    for (const id of deletedIds) if (!this.#raceById.has(id) && !this.#states.has(id) && this.#missing.has(id)) this.#dropRace(id, true);
    const fresh = new Set();
    for (const race of this.#races) {
      if (this.#states.has(race.id)) continue;
      this.#stateFor(race, now);
      fresh.add(race.id);
    }
    const outputsChanged = this.#outputsSig !== prevOutputs;
    if (outputsChanged) this.#pruneLedgers();
    const moved = this.#settle(prev, deletedIds);
    // a race that is new to the engine (added, or a missing race back in the settings) collects the reads it holds
    if (moved.size || fresh.size) this.#collectAll();
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      // its settings go into its race file too: a race that goes missing can be put back from there (R6)
      state.lastRace = race.race ?? null;
      if (state.savedRace !== JSON.stringify(race.race ?? null)) this.#saveSoon(state);
      if (moved.has(race.id) || fresh.has(race.id) || state.derivedSig !== this.#derivSig(race)) {
        this.#refreshFinishers(race, state, false);
        this.#rebuildRace(race, state);
      }
      // A race made active sends what it has; a changed output (enabled, its races) gets what it is missing. A split
      // paused or played (9.17 P1): what it held goes out, or what is not sent yet waits; its feed rows say which.
      if (outputsChanged || state.active !== race.active) state.dirtyAll = true;
      if (state.sendSig !== null && state.sendSig !== race.sendSig) {
        state.dirtyAll = true;
        state.feedAllBibs = true;
      }
      state.sendSig = race.sendSig;
      state.active = race.active;
      this.#touched.add(race.id);
    }
    // Race names, statuses and routes may all have changed.
    this.#feedAll = true;
    this.#converge(now);
    // 9.25: the setting "Athletes entered in another race" or a race's event number changed: the boards as after a
    // start list is loaded (the other runners' places, a clearing line)
    if (this.#listsBefore) {
      const before = this.#listsBefore;
      this.#listsBefore = null;
      this.#listsSettle(before);
    }
    this.#after();
  }

  /**
   * Set (or clear with '') a race's gun time. The config owner stores it from the 'config-patch' event; every read of
   * the race is then worked out again from the new gun.
   * @param {string} raceId
   * @param {string} gunText "10:00:00.000", "9:05:00", "12:58:49.2595" or ''
   * @returns {{ gun: string, gunTicks: number | null }} the gun as stored
   */
  setGun(raceId, gunText) {
    const id = text(raceId);
    const cfgRace = arr(this.#getConfig()?.races).find((r) => text(r?.id) === id);
    if (!cfgRace) throw new Error(`There is no race with id "${id}".`);
    const { gun, gunTicks: ticks } = parseGun(gunText);
    this.emit('config-patch', { raceId: id, patch: { gun } });
    this.configChanged();
    const race = this.#raceById.get(id);
    if ((race?.gunTicks ?? null) !== ticks) {
      throw new Error(`The gun time for ${text(cfgRace.name) || 'this race'} was not saved.`);
    }
    return { gun, gunTicks: ticks };
  }

  /**
   * Send every crossing of the race again to every output that takes it (after a gun change, or when a scoreboard
   * restarted). Finished runners are skipped unless includeFinished: their place in TrackScore is FinishLynx's.
   * Throws (code 'RACE_INACTIVE') for a race that is not active unless force: TrackScore would switch to that event
   * and clear the race it is showing.
   * @param {string} raceId
   * @param {{ includeFinished?: boolean, force?: boolean }} [opts]
   * @returns {{ sent: number, skippedFinished: number, outputs: number }} crossings sent (to at least one output),
   *   crossings of finished runners skipped, outputs that took them
   */
  resendRace(raceId, { includeFinished = false, force = false } = {}) {
    const none = { sent: 0, skippedFinished: 0, outputs: 0 };
    const race = this.#raceById.get(text(raceId));
    const state = race && this.#states.get(race.id);
    if (!race || !state) return none;
    if (!race.active && !force) {
      throw Object.assign(new Error(`${race.name} is not active. Resending it would make TrackScore switch to its ` +
        'event and clear the race it is showing. Tick Active first, or choose to resend anyway.'), { code: 'RACE_INACTIVE' });
    }
    if (race.gunTicks === null) return none;
    const now = this.#clock.now();
    const { holdMs } = this.#filter();
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    let sent = 0;
    let skipped = 0;
    const used = new Set();
    this.#ensureCheck(race, state);
    for (const split of race.splits) {
      (state.ranks.get(split.id) ?? []).forEach((c) => {
        // paused splits and columns in doubt never leave (9.17 P5), a Resend included
        if (this.#holdOf(race, state, c)) return;
        // a finisher's made-up split goes with the finish place, as convergence sends it (9.17 P4)
        const fp = c.manual && this.#finished(state, c.bib) ? this.#finishPlace(state, c.bib) : null;
        const place = fp ?? this.#place(state, c);
        const content = this.#content(race, c, place);
        if (fp !== null) {
          let any = false;
          if (!state.rel.has(c.key)) state.rel.set(c.key, { at: now, tod: c.tod, reason: 'resend', live: { reason: 'new', tod: c.tod, place } });
          for (const o of outs) {
            if (this.#send(race, state, o, c, place, 'resend', content, { allowInactive: force, byFinish: true })) {
              any = true;
              used.add(o.id);
            }
          }
          if (any) sent++;
          return;
        }
        if (this.#finished(state, c.bib) && !includeFinished) {
          skipped++;
          // The operator chose not to send these: they are no longer counted as out of date.
          for (const o of outs) {
            const led = state.ledgers.get(o.id)?.get(c.key);
            if (led && led.sig !== content.sig) led.waived = led.row[7] = content.sig;
          }
          return;
        }
        // Still in its hold: it goes out by itself in a moment, with the backup read's time if that is earlier. (In a
        // race that is not active nothing goes out by itself, so a forced resend takes it now.)
        if (race.active && !state.rel.has(c.key) && !this.#finished(state, c.bib) && now >= c.firstAt && now - c.firstAt < holdMs) return;
        if (!state.rel.has(c.key)) state.rel.set(c.key, { at: now, tod: c.tod, reason: 'resend', live: { reason: 'new', tod: c.tod, place } });
        let any = false;
        for (const o of outs) {
          if (this.#send(race, state, o, c, place, 'resend', content, { allowFinished: includeFinished, allowInactive: force })) {
            any = true;
            used.add(o.id);
          }
        }
        if (any) sent++;
      });
    }
    // A crossing that no longer counts cannot be unsent; the operator has seen it, so it stops being "out of date". The
    // TrackScore cell it filled keeps its time all the same: remembered, so the race view can say so (9.16 F1).
    for (const o of outs) {
      const ledger = state.ledgers.get(o.id);
      if (!ledger) continue;
      for (const [k, led] of [...ledger]) {
        if (state.kept.has(k)) continue;
        this.#orphan(state, o.id, led);
        ledger.delete(k);
      }
    }
    this.#saveSoon(state);
    this.#touched.add(race.id);
    state.feedAllBibs = true;
    this.#after();
    return { sent, skippedFinished: skipped, outputs: used.size };
  }

  /**
   * Forget a race's reads, crossings and what was sent (to re-run it, or after a test start). DESIGN 9.2 R3: the reads
   * the race holds now are marked cleared, one by one. They stay in the journal but are not used again, wherever the
   * settings would move them. RR12 sending them again (Replay) brings them back as new reads: clear, then Replay, is
   * how an operator rebuilds a race. Reads that come to the race later count as usual, new ones and ones that move in.
   * @param {string} raceId
   * @returns {boolean} false for an unknown race
   */
  clearRace(raceId) {
    const race = this.#raceById.get(text(raceId));
    if (!race) return false;
    const state = this.#states.get(race.id);
    // 9.23 F10: keepPins: the operator's decisions on passes stay, so a Replay in RR12 rebuilds the race already fixed
    this.#journal({ t: 'clear', raceId: race.id, seq: this.#seq, keepPins: true });
    this.#clearReads(race.id, this.#seq);
    // the made-up times were about the reads that are gone now (9.17), and so were the changes; the pins are keyed by
    // the reads' times of day, so they apply again only to the same reads (the replay of the clear does the same)
    this.#forgetFixes(race.id, { keepPins: true });
    state.approved.clear();
    state.epoch++;
    state.ledgers.clear();
    state.orphans.clear();
    state.flights.clear();
    state.failed.clear();
    state.rel.clear();
    state.unreleased.clear();
    this.#collectReads(state);
    this.#rebuildRace(race, state);
    this.#saveSoon(state);
    this.#touched.add(race.id);
    this.#after();
    return true;
  }

  /**
   * "Start a new meet" (DESIGN 9.22 M9): every read so far goes out of use, as Clear race data does for one race, in
   * every race and in none (waiting for a race, set aside, a missing race's). Nothing is deleted: the reads stay in the
   * journal, and a 'new-meet' record makes the next start do the same. Each race's deliveries are forgotten (the next
   * meet's splits are all new to the outputs), and so are the Moves, Keeps and made-up times, the set-aside contests and
   * the deleted races' ids. Nothing is sent: no crossing is left. An RR12 Replay of an old race brings its reads back,
   * as after Clear race data.
   * @returns {{ reads: number }} the reads put out of use
   */
  newMeet() {
    let reads = 0;
    for (const r of this.#readList) if (r.gone === LIVE) reads++;
    const seq = this.#seq;
    // O12: a 'clear' per race too, so an older Split Relay started on this data folder still clears the races' reads
    this.#journalMany([{ t: 'new-meet', seq, at: this.#clock.now() }, ...this.#races.map((r) => ({ t: 'clear', raceId: r.id, seq }))]);
    this.#startMeet(seq);
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      // what clearRace does for one race
      state.approved.clear();
      state.epoch++;
      state.ledgers.clear();
      state.orphans.clear();
      state.flights.clear();
      state.failed.clear();
      state.rel.clear();
      state.unreleased.clear();
      this.#clearSeq.set(race.id, seq);
      this.#collectReads(state);
      this.#rebuildRace(race, state);
      this.#saveSoon(state);
      this.#touched.add(race.id);
    }
    // no read waits for a race, and none is set aside or a missing race's: none is in use
    this.#held = new Map();
    this.#missing = new Map();
    this.#countAllNoRace(this.#buckets());
    this.#feedAll = true;
    this.#converge(this.#clock.now());
    this.#after();
    this.#log(`[engine] new meet: ${reads === 1 ? '1 read is' : `${reads} reads are`} out of use (kept in the journal)`);
    return { reads };
  }

  /** The part of newMeet that the replay of its 'new-meet' record does too. */
  #startMeet(seq) {
    for (const r of this.#readList) if (r.gone === LIVE && r.seq <= seq) r.gone = CLEARED;
    this.#setAside.clear();
    // every race's fixes go with its reads (9.23), pins too: a new meet's Replay is not a rebuild of these races
    for (const id of new Set([...this.#pins.keys(), ...this.#manuals.keys(), ...this.#fixGroups.keys()])) this.#forgetFixes(id);
    this.#pins.clear();
    this.#offs.clear();
    this.#says.clear();
    this.#manuals.clear();
    // 9.27: the swapped bibs were about the old meet's chips; its reads (out of use now) are their own bibs' again
    if (this.#swapList.length) {
      this.#swapList = [];
      this.#swapBy.clear();
      for (const r of this.#readList) this.#label(r);
    }
    this.#deletedIds.clear();
    this.#deletedAt.clear();
    if (seq > this.#meetSeq) this.#meetSeq = seq;
  }

  /**
   * The live reads that arrived before `ms` (wall clock), per race and in no race (DESIGN 9.22 M9): reads carry a time
   * of day but no date, so last meet's reads would become splits of today's race once its gun is typed.
   * @param {number} ms
   * @returns {{ byRace: Map<string, number>, noRace: number }}
   */
  readsBefore(ms) {
    const byRace = new Map();
    let noRace = 0;
    for (const r of this.#readList) {
      if (r.gone !== LIVE || !(r.at < ms)) continue;
      if (r.raceId) byRace.set(r.raceId, (byRace.get(r.raceId) ?? 0) + 1);
      else noRace++;
    }
    return { byRace, noRace };
  }

  /**
   * How many splits each output has been given, over every race (its ledgers): a meet load keeps the address of an
   * output that has some, since its deliveries are kept by output id (DESIGN 9.22 M5).
   * @returns {Map<string, number>}
   */
  sentCounts() {
    const out = new Map();
    for (const state of this.#states.values()) {
      for (const [id, ledger] of state.ledgers) if (ledger.size) out.set(id, (out.get(id) ?? 0) + ledger.size);
    }
    return out;
  }

  /**
   * Run delivery now. With the OutputManager's status list (main.js passes it on every 'status' event), an output
   * whose readiness changed (connected, a client came, its script was loaded or fixed, its error cleared) is given
   * again what it could not take before. Without arguments (LifSync reported new finishers) who FinishLynx has
   * finished is read again.
   * @param {Array<{ id: string, enabled?: boolean, state?: string, scriptOk?: boolean, clients?: number,
   *   scriptLoadedAt?: number|null, lastError?: string|null }>} [statuses]
   */
  converge(statuses) {
    if (this.#halted) return;
    if (Array.isArray(statuses)) {
      for (const s of statuses) {
        const id = text(s?.id);
        if (!id) continue;
        this.#outStatus.set(id, s);
        const sig = [s.enabled, s.state, s.scriptOk, s.clients, s.scriptLoadedAt ?? '', s.lastError ?? ''].join('|');
        if (this.#readiness.get(id) === sig) continue;
        this.#readiness.set(id, sig);
        this.#retry(id);
      }
    } else {
      for (const race of this.#races) {
        const state = this.#states.get(race.id);
        if (state) this.#refreshFinishers(race, state, true);
      }
    }
    this.#converge(this.#clock.now());
    this.#after();
  }

  /**
   * @param {string} raceId
   * @returns {RaceView | null}
   */
  raceView(raceId) {
    const race = this.#raceById.get(raceId);
    if (!race) return null;
    const state = this.#states.get(raceId) ?? this.#newState(raceId);
    this.#ensureCheck(race, state);
    const gun = race.gunTicks;
    const splits = race.splits.map((s) => {
      const ranked = state.ranks.get(s.id) ?? [];
      let lastAt = null;
      let held = 0;
      // (9.25: the crossings of runners who are not in this race: the tile counts the race's own; only when there are any)
      let away = 0;
      for (const c of ranked) {
        if (lastAt === null || c.firstAt > lastAt) lastAt = c.firstAt;
        if (state.check.away.has(c.key)) away++;
        // "Paused · 14 held" (9.17 P1): what the pause keeps back from the outputs
        else if (!s.sending && !this.#delivered(state, c.key)) held++;
      }
      return { id: s.id, name: s.name, sources: [...s.sources], earliest: s.earliestText, crossings: ranked.length, lastAt,
        sending: s.sending, held, ...(away ? { away } : {}),
        // 9.26: counted, not sent (said only then; the panel works out the others' laps to go from which ones are sent)
        ...(s.collectOnly ? { collectOnly: true } : {}) };
    });
    // Kept up to date read by read: building the view (twice a second while the panel is open) never walks the reads.
    const counts = state.counts;
    const finished = new Set(state.lynx.keys());
    state.bibs.forEach((d, bib) => {
      if (d.finishRt !== null) finished.add(bibKey(bib));
    });
    // follows delivery (9.16 F3): a crossing no output has as it is now is not sent, whether or not its hold was over
    // (revision 10: one sent with an old time, before a Move or a correction, is not sent either)
    let finishedNotSent = 0;
    state.kept.forEach((c) => {
      // a paused or held one waits for the operator first (9.17); a made-up time is the operator's own
      if (this.#finishedUnsent(race, state, c)) finishedNotSent++;
    });
    const unmapped = [...state.locations.entries()]
      // reads with no timing point name are passes, counted into splits by time (9.15 L4), not unmapped
      .filter(([key]) => key !== '' && !race.sourceToSplit.has(key) && !race.finishKeys.has(key))
      .map(([, l]) => ({ name: l.name || '(blank)', count: l.count }))
      .sort(byName);
    const contestsSeen = [...state.contests.entries()]
      .map(([key, c]) => ({ name: c.name || '(blank)', count: c.count, blank: !key, ...keyFields(key) }))
      .sort(byName);
    const byOutput = [];
    /** why what the outputs have is out of date: the split count it was sent with, or the order of the splits */
    const why = { counts: new Map(), order: 0 };
    // 9.23 F14: a runner's split out of date counts once, whatever the number of outputs (byOutput says where)
    const staleKeys = new Set();
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      const n = this.#staleCount(race, state, o, why, null, staleKeys);
      if (n) byOutput.push({ outputId: o.id, name: o.name, count: n });
    }
    const staleCount = staleKeys.size;
    // 9.23 F14: what a Resend sends (resendRace): every crossing not held; a finished runner's real split only with
    // "Also re-send runners who have finished" (`finished`), its made-up or typed time with the finish place always.
    // The Resend dialog says these numbers, the toast what went: the same count
    let resendCount = 0;
    let resendFinished = 0;
    for (const sp of race.splits) {
      for (const c of state.ranks.get(sp.id) ?? []) {
        if (this.#holdOf(race, state, c)) continue;
        if (this.#finished(state, c.bib) && !(c.manual && this.#finishPlace(state, c.bib) !== null)) resendFinished++;
        else resendCount++;
      }
    }
    // 9.25: the runners who are probably not in this race (worked out once for the counts and the warning below)
    const strangers = this.#strangersOf(race, state);
    // 9.26: reads that came long after the runner's last one and were merged into it by the tag filter (only then)
    const lateMerged = this.#lateMerged(race, state, strangers);
    return {
      id: race.id, name: race.name, active: race.active, inputPort: race.inputPort,
      gunTicks: gun, gunText: race.gunText,
      elapsedTicks: gun === null ? null : raceTicks(localTod(this.#clock.now()), gun),
      splitCount: race.splits.length,
      // 9.26: how many of them are sent: the number of splits TrackScore and Karmarush are set up with (only when some
      // are counted only; else every split is sent)
      ...(race.sentCount !== race.splits.length ? { sentCount: race.sentCount } : {}),
      splits,
      runners: state.runnerCount,
      finished: finished.size,
      pending: counts['waiting-gun'],
      waitingGun: counts['waiting-gun'],
      beforeGun: counts['before-gun'],
      startArea: counts['start-area'],
      afterFinish: counts['after-finish'],
      outOfOrder: counts['out-of-order'],
      repeats: counts.repeat,
      tooEarly: counts['too-early'],
      extra: counts.extra,
      passes: state.locations.get('')?.count ?? 0,
      finishedNotSent,
      unmapped,
      contestsSeen,
      stale: { count: staleCount, byOutput, ...staleWhy(race, staleCount, why) },
      leftover: this.#leftover(race, state),
      // 9.17: what the Review panel has ("3 missing splits · 1 to check")
      review: this.#reviewCounts(race, state, strangers),
      ...(lateMerged ? { lateMerged } : {}),
      // 9.25: the race's start list, when any is loaded: how many entered and from which file, whether it is used, and
      // the warning when it is not (it does not fit the runners being read, or it is from an earlier meet)
      ...(state.check.list ? { startList: this.#startListOut(race, state) } : {}),
      resendSuggested: staleCount > 0,
      resend: { count: resendCount, finished: resendFinished },
      lastReadAt: state.lastReadAt,
      lynxStart: null, // known to LifSync, not here: main.js fills these two in
      lynxName: null,
    };
  }

  /**
   * DESIGN 9.26, mats close together and the tag filter. The tag filter merges the reads of one bib that come within its
   * window into one pass (the A and B mats of a split). A mat a little further on the course (a split point 200 m after
   * a K marker) is read inside that window by the fast runners and outside it by the slow ones: the fast ones' second
   * pass is merged away, and every later pass of theirs lands a split early. What shows it: reads of counted crossings
   * that came LATE_MERGE_SEC or more after the runner's last read and were merged all the same. Said (RaceView.lateMerged,
   * the Dashboard's Needs attention) once LATE_MERGE_RUNNERS runners of the race have one; not counted: the runners who
   * are not in this race or probably not (9.25: an athlete of another race standing by a mat is read again and again).
   * Worked out again only when the race's crossings or the tag filter changed.
   * @param {Map<string, any>} strangers #strangersOf
   * @returns {{ reads: number, runners: number, fromSec: number, toSec: number, tagWindowSec: number, text: string } | null}
   */
  #lateMerged(race, state, strangers) {
    const { windowTicks } = this.#filter();
    const least = LATE_MERGE_SEC * TICKS_PER_SEC;
    if (race.gunTicks === null || windowTicks < least) return null;
    let found = state.lateCache;
    if (!found || found.version !== state.version || found.window !== windowTicks) {
      /** bib -> { reads, lo, hi }: its merged reads that came late, the shortest and the longest wait (ticks) */
      const byBib = new Map();
      for (const c of state.kept.values()) {
        if (c.manual || c.reads.length < 2) continue;
        for (let i = 1; i < c.reads.length; i++) {
          const gap = raceTicks(c.reads[i].tod, c.reads[i - 1].tod);
          if (gap < least) continue;
          const b = byBib.get(c.bib);
          if (!b) byBib.set(c.bib, { reads: 1, lo: gap, hi: gap });
          else {
            b.reads++;
            if (gap < b.lo) b.lo = gap;
            if (gap > b.hi) b.hi = gap;
          }
        }
      }
      state.lateCache = found = { version: state.version, window: windowTicks, byBib };
    }
    if (found.byBib.size < LATE_MERGE_RUNNERS) return null;
    let reads = 0;
    let runners = 0;
    let lo = Infinity;
    let hi = 0;
    for (const [bib, b] of found.byBib) {
      if (state.check?.apart?.has(bib) || strangers.has(bib)) continue;
      runners++;
      reads += b.reads;
      if (b.lo < lo) lo = b.lo;
      if (b.hi > hi) hi = b.hi;
    }
    if (runners < LATE_MERGE_RUNNERS) return null;
    const fromSec = Math.floor(lo / TICKS_PER_SEC);
    const toSec = Math.ceil(hi / TICKS_PER_SEC);
    const tagWindowSec = Math.round(windowTicks / TICKS_PER_SEC * 1000) / 1000;
    return { reads, runners, fromSec, toSec, tagWindowSec, text: lateMergedText({ reads, runners, fromSec, toSec, tagWindowSec }) };
  }

  /**
   * @param {string} raceId
   * @returns {CrossingView[]} course order, then race time
   */
  crossings(raceId) {
    const race = this.#raceById.get(raceId);
    const state = this.#states.get(raceId);
    if (!race || !state) return [];
    this.#ensureCheck(race, state);
    const out = [];
    for (const split of race.splits) {
      (state.ranks.get(split.id) ?? []).forEach((c) => {
        const who = this.#who(state, c.bib);
        // sent = an output took it (9.16 F3); a crossing released from its hold that none took is not
        const rel = this.#delivered(state, c.key) ? state.rel.get(c.key) : undefined;
        out.push({
          bib: c.bib, name: joinName(who), team: who.team, splitId: split.id, splitName: split.name, tod: c.tod,
          raceTicks: c.rt, place: this.#place(state, c), sentAt: rel?.at ?? null, reads: c.reads.length, reason: rel?.reason ?? null,
          // 9.17: a made-up or typed time, and whether it is held back (paused split, column in doubt)
          source: sourceOf(c), held: this.#holdOf(race, state, c),
        });
      });
    }
    return out;
  }

  // ---- Review (DESIGN 9.17) -----------------------------------------------------------------------------------------

  /**
   * What the Review panel lists for a race (DESIGN 9.17): the splits runners are missing, with the relay's estimate
   * and how it was made; the passes whose column is in doubt (held until the operator moves or keeps them); the
   * splits of finished runners that were not sent live; and the made-up times sent so far.
   * @param {string} raceId
   * @returns {Review | null}
   */
  review(raceId) {
    const race = this.#raceById.get(text(raceId));
    if (!race) return null;
    const state = this.#states.get(race.id) ?? this.#newState(race.id);
    const r = this.#reviewOf(race, state);
    // 9.25: the runners who are probably not in this race (the day's other races, the start lists): worked out now
    const strangers = this.#strangersOf(race, state);
    const away = this.#awayList(race, state);
    const unlisted = this.#unlistedList(race, state, strangers);
    // what follows delivery is worked out now, not cached: an output can take (or drop) a packet at any moment
    const finishedNotSent = this.#finishedNotSentList(race, state);
    const manual = this.#manualList(race, state);
    // names too: the people file can be loaded or changed at any time
    const named = (x) => {
      const who = this.#who(state, x.bib);
      return { name: joinName(who), team: who.team };
    };
    // 9.23 F13: the row of a runner's first pass that moves past a missed split carries "Missed <split>: add it"; where
    // the runner's later passes put that pass elsewhere than the column check did (9.23 F14), the runner's rows say so
    const hints = new Map();
    const hintOf = (bib) => {
      if (!hints.has(bib)) hints.set(bib, this.#missedHint(race, state, bib, r));
      return hints.get(bib);
    };
    // (9.23 F15: a run that starts before the runner's first held pass, at a pass that went out as counted, is that
    // first row's one click, in the hint's words)
    const firstRow = new Map();
    for (const c of r.checks) if (!firstRow.has(c.bib)) firstRow.set(c.bib, c);
    const checkRow = (c) => {
      const hint = hintOf(c.bib);
      const k = race.splitById.get(c.from)?.index ?? -1;
      const carries = !!hint && hint.by === 'check' && (hint.k === k || (hint.k < k && firstRow.get(c.bib) === c));
      const w = hint && k >= hint.k ? this.#heldWords(race, hint, k, { to: c.to, text: c.reason }) : null;
      // (9.23 F16: for a sure one: while Split Relay can't tell which, the hint's words say where each puts it)
      if (w && carries && hint.k < k) w.reason = hint.sure !== false ? `${hint.text.replace(/\.$/, '')}; ${c.timeText} moves on with it (${w.toName})` : hint.text.replace(/\.$/, '');
      return { ...(w ? { to: w.to, toName: w.toName, reason: w.reason } : {}),
        missed: carries ? this.#missedOut(race, hint, this.#hintView(race, state, c.bib, hint, r)) : null };
    };
    return {
      raceId: race.id, raceName: race.name, active: race.active, gunSet: race.gunTicks !== null,
      missing: r.missing.map((m) => ({ ...m, ...named(m), prev: { ...m.prev }, next: m.next && { ...m.next } })),
      // finished: a Move or Keep of a finisher's pass puts it in the .lif only (a live packet would replace the finish
      // place), so the panel says so instead of "goes to TrackScore"
      // (9.25: a held pass of a runner of another of the day's races: that is its story, "Not in this race" its one click)
      checks: r.checks.map((c) => ({ ...c, ...named(c), ...this.#checkSent(race, state, c), finished: this.#finished(state, c.bib),
        finishPlace: this.#finishPlace(state, c.bib), ...checkRow(c),
        ...(strangers.has(c.bib) ? { stranger: { raceName: strangers.get(c.bib).raceName, text: strangers.get(c.bib).text } } : {}) })),
      finishedNotSent,
      manual,
      // 9.23 F6: splits that look wrong (advice: nothing is held), one per runner, not the ones the operator said are right
      // (9.25: a runner of another race has that row instead of a leg that looks wrong or too fast: one story)
      flags: this.#strangerFlags(race, state, r, strangers).concat(this.#flagList(race, state, r).filter((f) => !strangers.has(f.bib)))
        .sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true })),
      // 9.24: the runners the operator stopped sending, with the splits that wait ("Send this runner again"); only then
      ...(this.#offs.get(race.id)?.size ? { off: this.#offList(race, state) } : {}),
      // 9.25: the runners who are not in this race (kept off the boards), and the ones on no start list; only then
      ...(away.length ? { away } : {}),
      ...(unlisted.length ? { unlisted } : {}),
      counts: { ...this.#reviewCounts(race, state, strangers), manual: manual.filter((m) => m.state === 'active').length, finishedNotSent: finishedNotSent.length },
    };
  }

  /**
   * What the outputs show for a held pass's cell (9.17 P2): `delivered`, this pass went out as that split before it was
   * held; else `sentOther`, the time they have there instead ({ timeText }), or null for an empty cell. 9.23 F20: not
   * whether the cell has anything at all: after an Undo of "Missed 1500m and 3100m: add them", 475's held 8:12.7 in 1500m
   * was said to have gone out as 1500m, where the boards kept the change's 4:50.8 and 8:12.7 had never gone out.
   */
  #checkSent(race, state, row) {
    const c = state.kept.get(crossingKey(row.bib, row.from));
    if (!c) return { delivered: this.#delivered(state, crossingKey(row.bib, row.from)), sentOther: null };
    const sent = this.#sentAs(race, state, c);
    if (sent.now) return { delivered: true, sentOther: null };
    return { delivered: false, sentOther: sent.old ? { timeText: this.#oldText(sent.old) } : null };
  }

  /**
   * 9.25: where else a runner belongs, as far as Split Relay knows: the race the start list enters it in (the race's
   * list is used and the runner is on another event's), else another of the day's races it ran (#ranElsewhere).
   * { by: 'list'|'day', raceId, raceName, words: "entered in Boys 2A" | "ran in Boys 2A today" } or null.
   */
  #whereElse(race, state, bib) {
    const l = state.check?.list;
    if (l?.used && l.elsewhere.has(bib)) {
      const ev = l.elsewhere.get(bib);
      const rs = this.#races.filter((r) => r.event === ev);
      const raceName = rs.length ? listWords(rs.map((r) => r.name)) : `event ${ev}`;
      return { by: 'list', raceId: rs[0]?.id ?? null, raceName, words: `entered in ${raceName}` };
    }
    const day = this.#ranElsewhere(race, state, bib);
    return day ? { by: 'day', raceId: day.id, raceName: day.name, words: `ran in ${day.name} today` } : null;
  }

  /**
   * 9.25: who ran this race, for the day's other races (a runner of this one read in another is "not in this race?"
   * there): a real crossing in more than half of its splits, not counting the ones in doubt (held for the column check,
   * marked too fast, stopped), and not a runner set apart. Not for a race of one split: one pass says nothing.
   * bibKey -> when the runner's first split here arrived (wall ms). Worked out when asked, once per change of the race.
   */
  #ranOf(race, state) {
    const chk = this.#ensureCheck(race, state);
    if (state.ranCache?.version === state.version) return state.ranCache.map;
    const map = new Map();
    const n = race.splits.length;
    const need = Math.floor(n / 2) + 1;
    for (const [bib, d] of n > 1 && race.gunTicks !== null ? state.bibs : []) {
      if (d.keptCount < need || chk.apart.has(bib)) continue;
      const fast = chk.fastOf.get(bib)?.legs ?? [];
      let k = 0;
      let first = Infinity;
      for (const c of d.kept) {
        if (!c || c.manual || chk.off.has(c.key) || chk.held.has(c.key) || fast.some((x) => x.col === c.index)) continue;
        k++;
        if (c.firstAt < first) first = c.firstAt;
      }
      if (k >= need) map.set(bibKey(bib), first);
    }
    state.ranCache = { version: state.version, map };
    return map;
  }

  /**
   * 9.25, the day's memory: another race this runner ran today (#ranOf: most of that race's splits, none of them in
   * doubt), within 18 hours of its first split here; when it ran this race too, only a race it ran before this one (a
   * runner runs one race: the first is its own). The earliest such race, or null.
   */
  #ranElsewhere(race, state, bib) {
    let first = Infinity;
    for (const c of state.bibs.get(bib)?.kept ?? []) if (c && !c.manual && c.firstAt < first) first = c.firstAt;
    if (first === Infinity) return null;
    const key = bibKey(bib);
    const mine = this.#ranOf(race, state).get(key);
    let best = null;
    let at = Infinity;
    for (const r of this.#races) {
      if (r.id === race.id) continue;
      const st = this.#states.get(r.id);
      const t = st ? this.#ranOf(r, st).get(key) : undefined;
      if (t === undefined || Math.abs(t - first) > 18 * 3600000 || (mine !== undefined && !(t < mine)) || !(t < at)) continue;
      best = r;
      at = t;
    }
    return best;
  }

  /**
   * DESIGN 9.25: the runners of this race who are probably not in it and are sent all the same (a flag, nothing held):
   * bib -> { by, raceId, raceName, words, text }. With the race's start list in use: the runners it enters in another
   * race when the setting says "send and flag" ('list'), and of the ones on no list those who ran another of the day's
   * races ('day'); without one, every runner who ran another of the day's races. Never a runner the operator said
   * something about (here, or not in this race), and nobody by the day's memory when more than half of the race's
   * runners ran another race today (the same bib numbers in two races). Worked out on each call (a few lookups per
   * runner): it depends on the other races.
   */
  #strangersOf(race, state) {
    const out = new Map();
    if (race.gunTicks === null) return out;
    this.#ensureChecks();
    const l = state.check.list;
    const says = this.#says.get(race.id);
    let through = 0;
    let day = 0;
    for (const [bib, d] of state.bibs) {
      if (!d.keptCount) continue;
      through++;
      if (says?.has(bib)) continue;
      const listed = l?.used === true && l.elsewhere.has(bib);
      // (kept off the boards: Review's Not in this race; on this race's own list: nothing to say)
      if ((listed && this.#keepOff) || (l?.used && !listed && !l.unlisted.has(bib))) continue;
      const w = listed ? this.#whereElse(race, state, bib) : this.#ranElsewhere(race, state, bib);
      if (!w) continue;
      const x = listed ? w : { by: 'day', raceId: w.id, raceName: w.name, words: `ran in ${w.name} today` };
      if (!listed) day++;
      out.set(bib, { ...x, text: `Bib ${bib} ${x.by === 'list' ? 'is entered' : 'ran'} in ${x.raceName}${x.by === 'day' ? ' today' : ''}: not in this race?` });
    }
    // A meet that numbers each race's bibs from 1: more than half of this race's runners "ran another race today" (on
    // the two real meets 22 of 110 at most). The day's memory can tell nobody apart then, and says nothing.
    if (through >= LIST_RULES.runners && day > LIST_RULES.share * through) for (const [bib, x] of [...out]) if (x.by === 'day') out.delete(bib);
    return out;
  }

  /**
   * Review.flags (9.25): one row per runner of another race that is sent here all the same and has no held pass (that
   * row says it): its passes here, "Not in this race" as the one click (it takes them back), "It's right" to keep them.
   */
  #strangerFlags(race, state, r, strangers) {
    const out = [];
    for (const [bib, s] of strangers) {
      const d = state.bibs.get(bib);
      const kept = d?.kept.filter(Boolean) ?? [];
      if (!kept.length || state.check.suspects.has(bib)) continue;
      const who = this.#who(state, bib);
      const c = kept[0];
      const tod = (k) => d.passInfo?.find((x) => this.#whereOf(state, d, x) === k)?.tod ?? null;
      out.push({ bib, name: joinName(who), team: who.team, splitId: c.splitId, splitName: kept.map((x) => race.splits[x.index].name).join(' and '), index: c.index,
        passTod: tod(c.index), raceTicks: c.rt, timeText: formatRaceTime(c.rt, 1), kind: 'stranger', suggest: null,
        passes: kept.map((x) => ({ splitId: x.splitId, splitName: race.splits[x.index].name, passTod: tod(x.index), timeText: formatRaceTime(x.rt, 1) })),
        stranger: { by: s.by, raceId: s.raceId, raceName: s.raceName },
        text: s.text, kept: false, finished: this.#finished(state, bib), finishPlace: this.#finishPlace(state, bib), missed: null });
    }
    return out;
  }

  /**
   * Review.away (9.25), "Not in this race": the runners kept off the boards (a start list enters them in another race,
   * or the operator said so), one row each: why, their passes here (`onBoards`: a line a scoreboard still shows, sent
   * before), "Count them here" as the one click.
   */
  #awayList(race, state) {
    const out = [];
    const says = this.#says.get(race.id);
    for (const bib of new Set(state.check?.away?.values() ?? [])) {
      const d = state.bibs.get(bib);
      if (!d) continue;
      const who = this.#who(state, bib);
      const w = this.#whereElse(race, state, bib);
      const passes = d.kept.filter(Boolean).map((c) => {
        const copy = this.#boardCopy(state, c.key);
        return { splitId: c.splitId, splitName: race.splits[c.index].name, timeText: formatRaceTime(c.rt, 1), ...(copy ? { onBoards: copy.text } : {}) };
      });
      out.push({ bib, name: joinName(who), team: who.team, by: says?.get(bib) === 'away' ? 'you' : 'list',
        why: w ? w.words : 'you said so', raceName: w ? w.raceName : null, passes, finished: this.#finished(state, bib) });
    }
    return out.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }));
  }

  /** The runners with a pass here who are on no start list, while this race's list is in use, and nothing else is said of them. */
  #unlistedBibs(race, state, strangers) {
    const l = state.check?.list;
    if (!l?.used) return [];
    const says = this.#says.get(race.id);
    return [...l.unlisted].filter((bib) => state.bibs.get(bib)?.keptCount > 0 && !says?.has(bib) && !strangers.has(bib));
  }

  /** Review.unlisted (9.25), "Not on the start list": a late entry, a spare chip. Sent as any runner: a note, no alarm. */
  #unlistedList(race, state, strangers) {
    const out = [];
    for (const bib of this.#unlistedBibs(race, state, strangers)) {
      const d = state.bibs.get(bib);
      if (!d) continue;
      const who = this.#who(state, bib);
      out.push({ bib, name: joinName(who), team: who.team,
        passes: d.kept.filter(Boolean).map((c) => ({ splitId: c.splitId, splitName: race.splits[c.index].name, timeText: formatRaceTime(c.rt, 1) })) });
    }
    return out.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }));
  }

  /** RaceView.startList (9.25): see raceView(). */
  #startListOut(race, state) {
    const l = state.check.list;
    const has = l.entered > 0;
    return { event: l.event, file: l.file, loadedAt: l.loadedAt, entered: l.entered, used: l.used, on: l.on, through: l.through,
      text: has ? `${l.entered.toLocaleString('en-US')} entered, from ${l.file}` : l.event ? `no start list for event ${l.event}` : 'no start list (the race has no event number)',
      warn: has && !l.used ? listMisfitText(race.name, l, this.#clock.now()) : null };
  }

  /**
   * 9.25: where a runner stands, for the runner editor: 'away' (not in this race: kept off the boards), 'stranger'
   * (probably not in this race, sent all the same), 'unlisted' (on no start list: a note), 'here' (the operator said it
   * counts here); null: nothing to say. `why`: "entered in Boys 2A", "ran in Boys 2A today", "you said so".
   */
  #placeOf(race, state, bib, d) {
    if (!d || race.gunTicks === null) return null;
    const say = this.#says.get(race.id)?.get(bib) ?? null;
    const w = this.#whereElse(race, state, bib);
    if (this.#isAway(race, state, bib, d)) {
      const why = w ? w.words : 'you said so';
      return { kind: 'away', why, text: `Not in this race (${why}): read and counted here, not sent, not in the merged .lif file.` };
    }
    if (say === 'here') return { kind: 'here', why: w ? w.words : null, text: `Counted in this race${w ? ` (${w.words})` : ''}: you said so.` };
    const s = d.keptCount ? this.#strangersOf(race, state).get(bib) : null;
    if (s) return { kind: 'stranger', why: s.words, text: s.text };
    if (state.check.list?.used && state.check.list.unlisted.has(bib)) return { kind: 'unlisted', why: null, text: `Not on the start list of ${race.name}.` };
    return null;
  }

  /**
   * 9.25: whether a runner is kept off the boards here: its crossings are (#recheck's `away`), or, with no pass yet (a
   * read in the start area), the operator said so or the start list in use enters it in another race.
   */
  #isAway(race, state, bib, d) {
    if (d?.keptCount) return d.kept.some((c) => c && state.check.away.has(c.key));
    const say = this.#says.get(race.id)?.get(bib) ?? null;
    const l = state.check?.list;
    return say === 'away' || (say === null && this.#keepOff && l?.used === true && l.elsewhere.has(bib));
  }

  /** Review.off (9.24): the runners the operator stopped sending: from when, and their splits that wait. */
  #offList(race, state) {
    const out = [];
    if (race.gunTicks === null) return out;
    for (const [bib, o] of this.#offs.get(race.id) ?? []) {
      const d = state.bibs.get(bib);
      if (!d) continue;
      const who = this.#who(state, bib);
      // (9.26: a split that is counted but not sent does not wait: it never goes out)
      const held = d.kept.filter((c) => c && state.check?.off?.has(c.key) && !this.#notSent(race, c)).map((c) => ({ splitId: c.splitId, splitName: race.splits[c.index].name, timeText: formatRaceTime(c.rt, 1) }));
      const w = this.#offWhen(race, d, o);
      out.push({ bib, name: joinName(who), team: who.team, from: o.from, fromText: w.text, words: w.words, at: o.at, held });
    }
    return out.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }));
  }

  /** Review.flags (9.23 F6): the look-wrong flags the operator has not silenced, by bib. */
  #flagList(race, state, r) {
    const out = [];
    // 9.23 F14: a made-up time the runner's later passes do not fit, or a run of missed mats that neither check pointed
    // at, is listed (on its split) instead of the leg it makes look wrong ("A stray pass?"): its fix is the one click,
    // never Not a split for a real pass
    for (const [bib, h] of r.causes ?? []) {
      const d = state.bibs.get(bib);
      const c = d?.kept[h.k];
      if (!c) continue;
      const who = this.#who(state, bib);
      const sp = race.splits[h.k];
      out.push({ bib, name: joinName(who), team: who.team, splitId: sp.id, splitName: sp.name, index: h.k, passTod: h.tod, passSplitId: race.splits[h.j]?.id ?? null,
        raceTicks: c.rt, timeText: formatRaceTime(c.rt, 1), kind: h.by === 'madeUp' ? 'made-up' : 'missed', suggest: null, text: h.text, kept: false,
        finished: this.#finished(state, bib), finishPlace: this.#finishPlace(state, bib), missed: this.#missedOut(race, h, this.#hintView(race, state, bib, h, r)) });
    }
    // 9.24: a runner's splits that are too fast to be real: one row for all of them (`passes`: each split and its pass, so
    // Not a split and It's right act on them all; Stop sending this runner is a choice of the row too)
    for (const [bib, f] of r.fastFlags ?? []) {
      const who = this.#who(state, bib);
      const d = state.bibs.get(bib);
      const sp = race.splits[f.col];
      const t = d?.kept[f.col]?.rt ?? null;
      out.push({ bib, name: joinName(who), team: who.team, splitId: sp.id, splitName: f.cols.map((k) => race.splits[k].name).join(' and '), index: f.col, passTod: f.passTod,
        raceTicks: t, timeText: t === null ? '' : formatRaceTime(t, 1), kind: f.kind, suggest: this.#suggestOut(race, f.suggest),
        passes: f.cols.map((k, i) => ({ splitId: race.splits[k].id, splitName: race.splits[k].name, passTod: f.passTods[i], timeText: formatRaceTime(d.kept[k].rt, 1) })),
        text: f.text, kept: false, finished: this.#finished(state, bib), finishPlace: this.#finishPlace(state, bib), missed: null });
    }
    for (const [bib, f] of r.legs?.flags ?? []) {
      if (f.silenced || r.causes?.has(bib) || r.fastFlags?.has(bib)) continue;
      const who = this.#who(state, bib);
      // 9.23 F13: a later split (or the finish) suggested: the fix is "Missed <this split>: add it" (9.23 F14: as many
      // splits as the runner's later passes fit, in their words)
      const hint = this.#missedHint(race, state, bib, r);
      const mine = hint?.by === 'flag' ? hint : null;
      const view = mine ? this.#hintView(race, state, bib, mine, r) : null;
      // (9.23 F15: the run starts at another pass than the flagged one: the row is that split's, in the hint's words)
      if (mine && mine.k !== f.col) {
        const c = state.bibs.get(bib)?.kept[mine.k];
        const sp = race.splits[mine.k];
        out.push({ bib, name: joinName(who), team: who.team, splitId: sp.id, splitName: sp.name, index: mine.k, passTod: view?.passTod ?? null,
          raceTicks: c?.rt ?? null, timeText: c ? formatRaceTime(c.rt, 1) : '', kind: 'missed', suggest: null, text: mine.text, kept: false,
          finished: this.#finished(state, bib), finishPlace: this.#finishPlace(state, bib), missed: this.#missedOut(race, mine, view) });
        continue;
      }
      const sp = race.splits[f.col];
      const t = r.legs.runners.get(bib)?.real[f.col] ?? null;
      out.push({ bib, name: joinName(who), team: who.team, splitId: sp.id, splitName: sp.name, index: f.col, passTod: f.passTod,
        raceTicks: t, timeText: t === null ? '' : formatRaceTime(t, 1), kind: f.kind, suggest: this.#suggestOut(race, f.suggest),
        text: mine ? mine.text : f.text, kept: f.kept, finished: this.#finished(state, bib), finishPlace: this.#finishPlace(state, bib),
        missed: mine ? this.#missedOut(race, mine, view) : null });
    }
    return out.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }));
  }

  /**
   * The runner editor's view of a hint's cell (#missedView), for the Review list's rows: what each choice does. 9.23 F21:
   * once per hint of the Review list (made again when the race's crossings change, as the hint itself): a Review with
   * nothing changed made every row's choices again, 23-31 ms for 84 runners a mat missed (051d375 14-16 ms).
   */
  #hintView(race, state, bib, hint, r) {
    const d = state.bibs.get(bib);
    if (!d || !hint) return null;
    const memo = r?.legs ? (r.legs.viewMemo ??= new WeakMap()) : null;
    if (memo?.has(hint)) return memo.get(hint);
    let refs = null;
    const view = this.#missedView(race, state, bib, d, hereOf(hint), hint, r, () => (refs ??= this.#refRunners(state, race.splits.length, bib, r.legs)));
    memo?.set(hint, view);
    return view;
  }

  /** A flag's suggestion with a split id instead of a column: { to: splitId | 'finish' | 'none', toName, missed }. */
  #suggestOut(race, s) {
    if (!s) return null;
    return { to: typeof s.to === 'number' ? race.splits[s.to]?.id ?? null : s.to, toName: s.toName, missed: [...s.missed] };
  }

  /**
   * One runner as the runner editor shows them (DESIGN 9.17 P3, 9.23 F7): every column with its time, place and where
   * it came from (a read, a Move, a made-up or typed time ...), whether it is held back, whether a scoreboard shows it
   * otherwise (stale) or still shows an emptied cell (leftover), whether it looks wrong (flag), and for an empty column
   * the relay's estimate and what kind of empty it is; every pass with where it is and what each change to it would do
   * (targets, with the effect on the runner's other passes); the runner's last changes (Undo); and its problems in
   * words. Null for an unknown race. A bib the race has never seen is `found: false`.
   * @param {string} raceId
   * @param {string} bibText
   * @returns {RunnerView | null}
   */
  runner(raceId, bibText) {
    const race = this.#raceById.get(text(raceId));
    if (!race) return null;
    const state = this.#states.get(race.id) ?? this.#newState(race.id);
    this.#ensureCheck(race, state);
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    const n = race.splits.length;
    const who = this.#who(state, bib);
    const finish = d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null;
    const finishPlace = this.#finishPlace(state, bib);
    const suspect = state.check?.suspects.get(bib) ?? null;
    const found = !!d || state.lynx.has(bibKey(bib));
    const rv = race.gunTicks !== null ? this.#reviewOf(race, state) : null;
    // the estimates the Review list shows (cached with it); a runner the list leaves out has none (still on the course)
    // (a runner the column check holds a pass of has the estimates of its splits that are not measured from one)
    const estimates = found ? rv?.gapsOf.get(bib) ?? new Map() : new Map();
    const finished = finish !== null;
    // 9.23 F13: where the column check or the look-wrong check says a mat missed the runner, and the other runners as
    // the references of "Missed <split>: add it" (worked out once, for the cells that have a pass)
    const hint = found && rv ? this.#missedHint(race, state, bib, rv) : null;
    // (9.23 F14: a leg that looks wrong because of a cause before it is not a flag of its own: the cause has the fix;
    // 9.23 F15: nor one the run of missed mats explains from another pass)
    // (9.24: or the runner's splits that are too fast to be real: the pace check's mark stands for its flag)
    const flag0 = rv?.fastFlags?.get(bib) ?? rv?.legs?.flags.get(bib) ?? null;
    const flag = flag0 && !rv?.causes?.has(bib) && hint?.pointed !== flag0.col ? flag0 : null;
    let refs = null;
    const refsOf = () => (refs ??= this.#refRunners(state, n, bib, rv?.legs ?? null));
    const columns = race.splits.map((sp, k) => {
      const c = d?.kept[k] ?? null;
      const e = estimates.get(k);
      const h = c ? this.#holdOf(race, state, c) : null;
      const chk = c && h === 'check' ? state.check.held.get(c.key) : null;
      const can = this.#canAdd(race, state, bib, k, { suspect, finish, finishPlace, found });
      // revision 10: an output has it as it is now; or only an older time of it (sent before a Move or a correction)
      const sent = c ? this.#sentAs(race, state, c) : { now: false, old: null };
      const fns = !!c && this.#finishedUnsent(race, state, c);
      const after = fns && sent.now ? this.#sentAfterFinish(race, state, c) : null;
      const how = this.#colHowOf(d, k);
      const cl = c && !c.manual ? d.passInfo?.find((x) => this.#whereOf(state, d, x) === k) ?? null : null;
      // (9.26: an empty split that is not sent is missing nothing: no scoreboard has a column for it)
      const missing = !c && !!e?.next && !sp.collectOnly;
      // 9.23 F6: an estimate measured from a pass that looks wrong waits until the operator decides about that pass
      const fb = missing && can.ok ? this.#flagBlock(race, rv, bib, k, d) : null;
      return {
        // (9.26: laps to go by the splits that are sent; a split that is counted only has none, and says so)
        splitId: sp.id, splitName: sp.name, index: k, lapsToGo: sp.l2g, sending: sp.sending, ...(sp.collectOnly ? { collectOnly: true } : {}),
        time: c ? c.rt : null, timeText: c ? formatRaceTime(c.rt, 1) : '',
        place: c ? this.#place(state, c) : null, source: c ? sourceOf(c) : null, held: h,
        delivered: sent.now,
        sentOld: sent.old ? { raceTicks: raceTicks(sent.old.tod, sent.old.gun), timeText: this.#oldText(sent.old) } : null,
        // in Review's "Finished: not sent live": the runner view offers Send with finish place for it
        finishedNotSent: fns, sentAfter: after !== null ? { place: after } : null,
        note: fns && sent.old ? sentOldText(sp.name, this.#oldText(sent.old), formatRaceTime(c.rt, 1))
          : after !== null ? sentAfterText(after, finishPlace) : null,
        check: chk ? this.#heldWords(race, hint, k, chk) : null,
        estimate: e?.estimate ?? null, estimateText: e?.estimate != null ? formatRaceTime(e.estimate, 3) : '',
        basis: e?.basis ?? '', missing, canAdd: can.ok && !fb, why: can.why ?? fb,
        // 9.23 F7
        how, passTod: cl ? cl.tod : null,
        kind: c ? KIND_OF_HOW[how] ?? 'read' : missing ? (can.ok && !fb && e.estimate !== null ? 'missing' : 'blocked') : suspect && !sp.collectOnly ? 'blocked' : 'not-yet',
        // (9.24: a mark that covers several splits is on each of them; `also`: the other passes its choices act on)
        flag: flag && (flag.col === k || flag.cols?.includes(k)) ? { kind: flag.kind, text: flag.text, suggest: this.#suggestOut(race, flag.suggest), ratio: flag.ratio, silenced: flag.silenced, kept: flag.kept,
          ...(flag.cols ? { also: flag.passTods.filter((_, i) => flag.cols[i] !== k), first: flag.col === k } : {}) } : null,
        stale: c && !finished && !h ? this.#staleAt(race, state, c) : null,
        leftover: c ? null : this.#leftoverAt(race, state, bib, k),
        // 9.23 F13: "Missed <split>: add it" for this cell (here: the check or a flag points at it)
        missed: d && rv ? this.#missedView(race, state, bib, d, k, hint, rv, refsOf) : null,
      };
    });
    const passes = (d?.passInfo ?? []).map((cl) => ({ ...this.#passView(race, state, bib, cl), ...this.#passChoices(race, state, bib, d, cl, rv) }));
    // the finish and who says so
    let own = null;
    let marked = null;
    for (const f of d?.finishes ?? []) {
      if (own === null || f.rt < own) own = f.rt;
      if (f.marked) marked ??= f;
    }
    const lynx = state.lynx.get(bibKey(bib));
    const finishBy = finish === null ? null : lynx !== undefined && (own === null || lynx <= own) ? 'lynx' : marked && own === marked.rt ? 'marked' : 'mat';
    const markedCl = d?.passInfo?.find((x) => x.how === 'finish') ?? null;
    const view = {
      raceId: race.id, raceName: race.name, bib, name: joinName(who), team: who.team, found,
      finished, finishTicks: finish, finishText: finish !== null ? formatRaceTime(finish, 1) : '',
      finishPlace, suspect: !!suspect, columns, passes,
      manual: this.#manualList(race, state).filter((m) => m.bib === bib),
      finishBy, finishMarkedTod: markedCl ? markedCl.tod : null,
      fillable: columns.filter((c) => c.kind === 'missing').length,
      alsoIn: this.#alsoIn(race, bib),
      changes: this.#changesOf(race, bib),
      // 9.23 F13: the split a mat missed, as the column check or the look-wrong check says ({ splitId, count, names })
      missedHint: this.#missedOut(race, hint, hint ? columns[hereOf(hint)]?.missed : null),
      // 9.23 F18: a quiet note, nothing to do: the column check would have held the runner's passes, but its legs fit the
      // course as counted, every pass late by the same time: a late start ({ raceTicks, text: "5:00" }), else null
      lateStart: this.#lateStartOf(state, bib),
      // 9.23 F20: a quiet note, nothing to do: the column check would have held the runner's passes, but its legs fit as
      // read with one slow leg, every mat read ({ splitName, raceTicks, text: "2:30" }: how much it lost on the way there)
      slowLeg: this.#slowLegOf(race, state, bib),
      // 9.24: Stop sending this runner / Send this runner again: how it stands and what the button would do
      sending: this.#sendingOf(race, state, bib, d),
      // 9.25: not in this race, probably not, on no start list, or here because the operator said so; null otherwise
      place: this.#placeOf(race, state, bib, d),
      // 9.27: the bib is one of a swapped pair ({ other, at, atText, text }); only then
      ...(this.#swapBy.size && this.#swapBy.has(bibKey(bib)) ? { swap: this.#swapOf(state, bib) } : {}),
    };
    view.problems = this.#problemsOf(view, { marked: markedCl, lynx });
    return view;
  }

  /**
   * 9.23 F18: how late a runner the column check spared as a late starter (src/review.js columnCheck `late`) started,
   * by the runners of its pace, to the second: { raceTicks, text }; null for a start within half a minute of the gun.
   */
  #lateStartOf(state, bib) {
    const late = state.check?.late?.get(bib)?.late;
    if (!Number.isFinite(late) || late < 30 * TICKS_PER_SEC) return null;
    const t = Math.round(late / TICKS_PER_SEC) * TICKS_PER_SEC;
    return { raceTicks: t, text: formatRaceTime(t, 0) };
  }

  /**
   * 9.23 F20: the slow leg of a runner the column check spared for it (src/review.js columnCheck `slow`): the split it came
   * late to and how much it lost on the way there, to the second; null for less than half a minute.
   */
  #slowLegOf(race, state, bib) {
    const s = state.check?.slow?.get(bib);
    if (!s || !Number.isFinite(s.lost) || s.lost < 30 * TICKS_PER_SEC || !race.splits[s.col]) return null;
    const t = Math.round(s.lost / TICKS_PER_SEC) * TICKS_PER_SEC;
    return { splitName: race.splits[s.col].name, raceTicks: t, text: formatRaceTime(t, 0) };
  }

  /** How a runner's crossing at column k got there (9.23 F7): counted, earliest, moved, hold, keep, replaces, made-up, typed, mat; null when empty. */
  #colHowOf(d, k) {
    const c = d?.kept[k];
    if (!c) return null;
    if (c.manual) return c.manual.estimated ? 'made-up' : 'typed';
    if (c.reads.some((r) => r.locKey !== '')) return 'mat';
    const h = d.colHow?.[k];
    return h === 'kept' ? 'keep' : h || 'counted';
  }

  /** An output shows this crossing with another time or column (9.23 F7: "TrackScore: 16:10.8"), or null. */
  #staleAt(race, state, c) {
    const n = race.sentCount;
    const l2g = this.#l2gOf(race, c);
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      const e = this.#latestFlight(state, o.id, c.key) ?? state.ledgers.get(o.id)?.get(c.key);
      if (!e || (e.tod === c.tod && e.gun === race.gunTicks && e.l2g === l2g && e.count === n)) continue;
      const t = Number.isFinite(e.gun) ? formatRaceTime(raceTicks(e.tod, e.gun), 1) : '';
      return { text: `${o.name}: ${t}`, output: o.name, timeText: t };
    }
    return null;
  }

  /**
   * An empty column whose cell an output still has (9.16 F1, per runner): it got a time for that split that no
   * crossing fills now (a Move, a removed time). { raceTicks, timeText, outputs } or null.
   */
  #leftoverAt(race, state, bib, k) {
    // (9.26: a split that is not sent has no cell on the boards; the others by their place among the sent ones)
    if (race.gunTicks === null || race.splits[k].collectOnly) return null;
    const n = race.sentCount;
    const j = race.splits[k].sentIndex;
    const key = crossingKey(bib, race.splits[k].id);
    const outputs = [];
    let copy = null;
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      const e = this.#latestFlight(state, o.id, key) ?? state.ledgers.get(o.id)?.get(key);
      let has = !!e;
      if (e) copy ??= e;
      if (!has) {
        for (const cell of state.orphans.get(o.id)?.get(bib) ?? []) {
          const [l2g, count] = cell.split('|').map(Number);
          if (n - l2g === j || (count !== n && count - l2g === j)) has = true;
        }
      }
      if (has) outputs.push(o.name);
    }
    if (!outputs.length) return null;
    const t = copy && Number.isFinite(copy.gun) ? raceTicks(copy.tod, copy.gun) : null;
    return { raceTicks: t, timeText: t === null ? '' : formatRaceTime(t, 1), outputs };
  }

  /** The other races this bib has reads or a FinishLynx finish in (9.23: "Also in Mens Race"). */
  #alsoIn(race, bib) {
    const k = bibKey(bib);
    const out = [];
    for (const r of this.#races) {
      if (r.id === race.id) continue;
      const st = this.#states.get(r.id);
      if (st && (st.bibKeys.has(k) || st.lynx.has(k))) out.push({ raceId: r.id, raceName: r.name });
    }
    return out;
  }

  /** The runner's last 5 changes, newest first: only the newest can be undone, and only while it is what it left. */
  #changesOf(race, bib) {
    const list = this.#fixesOf(race.id, bib);
    const sig = list.length ? this.#fixSigOf(race.id, bib) : '';
    return list.slice(0, 5).map((g, i) => {
      const undone = !!g.undoneBy;
      const matches = g.bibs.get(bib)?.sigAfter === sig;
      const undoable = i === 0 && !undone && matches;
      return { fix: g.id, at: g.at, atText: wallText(g.at), kind: g.kind, text: g.text, undone, undoable,
        why: undoable ? null : undone ? 'Undone already.' : i > 0 ? 'A later change of this runner comes first.' : 'This runner was changed since.' };
    });
  }

  /**
   * What each change to one pass would do (9.23 F7), for the runner editor's menu: Move to each split (allowed or why
   * not, and its effect on the runner's other passes), Move only this time, This is the finish; and how well the pass
   * fits each split at the runner's pace (fit; best: "fits the pace").
   */
  #passChoices(race, state, bib, d, cl, rv) {
    const n = race.splits.length;
    const where = this.#whereOf(state, d, cl);
    const col = cl.col;
    const inColumn = typeof where === 'number';
    const lynx = state.lynx.get(bibKey(bib));
    let mat = null;
    for (const f of d.finishes) if (!f.marked && (mat === null || f.rt < mat)) mat = f.rt;
    const finishOf = (marked) => {
      let f = mat;
      if (marked !== null && (f === null || marked < f)) f = marked;
      if (lynx !== undefined && (f === null || lynx < f)) f = lynx;
      return f;
    };
    const mans = d.manualInfo ?? [];
    const base = previewPlaces(d.passInfo, mans, race.splits, null, null, -1, finishOf);
    const effect = (pin, dropAt) => {
      const next = previewPlaces(d.passInfo, mans, race.splits, cl, pin, dropAt, finishOf);
      const parts = [];
      const late = [];
      // (9.23 F17: the runner's first pass past the last split is its finish pass when the stream carries them, as
      // "Missed …: add it" says it: "28:22.6 → extra pass (the finish)")
      // (9.23 F18: and what the column check would hold then: "21:46.1 → 5300m (held: it looks like the finish)"; a pass
      // held as the finish is the finish pass, not the first one past the last split)
      const held = pin?.as === 'move' ? this.#previewHeld(race, state, bib, d, next, new Set([cl]), mans.filter((m) => m.state === 'active' && !(dropAt instanceof Set ? dropAt : new Set([dropAt])).has(m.k))) : new Map();
      const finPass = rv?.legs?.field?.stream === true && !heldAsFinish(held) ? d.passInfo.find((x) => next.get(x) === 'extra') ?? null : null;
      for (const x of d.passInfo) {
        if (x === cl || base.get(x) === next.get(x)) continue;
        if (next.get(x) === 'after-finish') late.push(formatRaceTime(x.t, 1));
        else parts.push(`${formatRaceTime(x.t, 1)} → ${whereWord(next.get(x), race.splits)}${x === finPass ? ' (the finish)' : held.has(x) ? ` (held: ${held.get(x)})` : ''}`);
      }
      if (late.length) parts.push(`${listWords(late)} ${late.length === 1 ? 'becomes' : 'become'} after the finish`);
      return parts;
    };
    const legRunner = rv?.legs?.runners.get(bib) ?? null;
    const fits = new Map();
    if (legRunner && rv.legs.field) {
      const cols = [];
      for (let c = 0; c <= n; c++) cols.push(c);
      for (const f of legFits(rv.legs.field, legRunner, cl.t, cols)) fits.set(f.col, f.fit);
    }
    // 9.23 F2: a Move far from the runner's pace is asked first (the panel): 'early' / 'late' when the leg is far
    // shorter or longer than the runners' of the same pace; for the runner's first pass (no leg to measure) when it is
    // far outside the field's own times at that split. Null: it fits, or there is nothing to judge by.
    const paceOf = (k) => {
      const fit = fits.get(k);
      if (fit !== undefined) return fit < FIT_RULES.shortBelow ? 'early' : fit > FIT_RULES.longAbove ? 'late' : null;
      const col = rv?.legs?.field?.byCol[k] ?? [];
      if (col.length < FIT_RULES.minRefs || legRunner?.kept.some((t) => t !== null && t < cl.t)) return null;
      return cl.t < col[0].real[k] * 0.8 ? 'early' : cl.t > col[col.length - 1].real[k] * 1.25 ? 'late' : null;
    };
    // (9.23 F21: a refusal names the runner's flagged stray pass as the way on)
    const stray = this.#strayFlagged(race, state, bib, d, rv);
    const targets = race.splits.map((sp, k) => {
      const r = this.#moveRules(race, state, bib, d, cl, sp.id, false, { stray });
      const drops = r.why ? [] : this.#giveWay(d, cl, k);
      const fx = r.why ? [] : effect({ split: sp.id, as: 'move', seen: false }, new Set(drops.map((m) => m.k)));
      const made = drops.find((m) => m.k === k);
      if (made) fx.unshift(`replaces the ${made.rec.estimated ? 'made-up' : 'typed'} ${sp.name} time`);
      const out = drops.filter((m) => m.k !== k);
      if (out.length) fx.push(`takes out ${listWords(out.map((m) => `the ${m.rec.estimated ? 'made-up' : 'typed'} ${race.splits[m.k].name} time`))}`);
      return { splitId: sp.id, splitName: sp.name, ok: !r.why, why: r.why, effect: fx.join(', '), fit: fits.get(k) ?? null, best: false, pace: paceOf(k) };
    });
    // the best fit at the runner's pace among the splits it can go to (and the finish): "fits the pace"
    let best = null;
    for (const t of targets) if (t.ok && t.fit !== null && (!best || Math.abs(Math.log(t.fit)) < Math.abs(Math.log(best.fit)))) best = t;
    const fin = this.#moveRules(race, state, bib, d, cl, 'finish', false);
    const finFit = fits.get(n) ?? null;
    // ... and only for a pass that does not fit where it is: a runner well ahead of (or behind) the runners nearest in
    // time fits every split a little off, and a time that is right is not to be marked as one to move
    const here = inColumn ? fits.get(where) ?? null : null;
    const fitsHere = here !== null && Math.abs(Math.log(here)) <= Math.log(FIT_RULES.fitWithin);
    const finBest = !fitsHere && !fin.why && finFit !== null && (!best || Math.abs(Math.log(finFit)) < Math.abs(Math.log(best.fit)));
    if (fitsHere || (finBest && Math.abs(Math.log(finFit)) <= Math.log(FIT_RULES.fitWithin))) best = null;
    else if (best && Math.abs(Math.log(best.fit)) > Math.log(FIT_RULES.fitWithin)) best = null;
    if (best) best.best = true;
    const only = race.splits.map((sp) => {
      const r = this.#moveRules(race, state, bib, d, cl, sp.id, true, { stray });
      return { splitId: sp.id, splitName: sp.name, ok: !r.why, why: r.why };
    });
    return {
      col, inColumn, where: typeof where === 'number' ? race.splits[where].id : where,
      targets, only,
      finishOk: { ok: !fin.why, why: fin.why, effect: fin.why ? '' : effect({ split: null, as: 'finish', seen: false }, -1).join(', '), fit: finFit, pace: paceOf(n),
        best: finBest && Math.abs(Math.log(finFit)) <= Math.log(FIT_RULES.fitWithin) },
    };
  }

  /** The runner's problems in words, course order (9.23 F7): what the editor's problem lines and the grid say. */
  #problemsOf(v, { marked, lynx }) {
    const out = [];
    for (const c of v.columns) {
      const k = c.index;
      if (c.held === 'check' && c.check) out.push({ kind: 'check', col: k, text: `${c.splitName}: ${c.check.reason}. Held until you choose.` });
      // 9.23 F14: a made-up time the runner's later passes do not fit, a run of missed mats neither check pointed at;
      // 9.23 F15: the pass where the run starts when the check or the flag doubts a later (or an earlier) one
      const own = (c.held === 'check' && c.check) || (c.flag && !c.flag.silenced);
      if (c.missed?.here && !own) out.push({ kind: c.missed.by === 'madeUp' ? 'made-up' : 'missed', col: k, text: c.missed.reason });
      // (9.23 F14: with the count of missed splits on it, the hint's words, as the Review row says them: "… looks like
      // 5300m or the finish, not 4200m: Split Relay can't tell which (…)")
      // (9.24: a mark that covers several splits is said once, at its first)
      if (c.flag && !c.flag.silenced && c.flag.first !== false) out.push({ kind: 'flag', col: k, text: c.missed?.here && c.missed.by === 'flag' && c.missed.reason ? c.missed.reason : c.flag.text });
      if (c.kind === 'missing') out.push({ kind: 'missing', col: k, text: `${c.splitName} is missing: suggested ${formatRaceTime(c.estimate, 1)}.` });
      if (c.finishedNotSent) out.push({ kind: 'not-live', col: k, text: `${c.splitName}: not sent live (bib ${v.bib} has finished).${c.note ? ` ${c.note}` : ''}` });
      if (c.stale) out.push({ kind: 'stale', col: k, text: `${c.splitName}: ${c.stale.output} shows ${c.stale.timeText || 'another time'}, not ${c.timeText}.` });
      if (c.leftover) {
        // (9.23 F13: a cell that waits for the finish place can't take a time; "Missed <split>: add it" can, when the
        // pass marked as the finish moves on)
        const fix = c.missed?.ok ? `${missedName(c.missed)} puts the right time there.` : c.kind === 'blocked' && c.why && /finish place/.test(c.why)
          ? 'It can\'t be replaced while Split Relay doesn\'t know the finish place.' : `A time for ${c.splitName} replaces it.`;
        out.push({ kind: 'leftover', col: k, text: `${c.splitName}: ${listWords(c.leftover.outputs)} still ${c.leftover.outputs.length === 1 ? 'shows' : 'show'} ${c.leftover.timeText || 'a time'} there (a packet can't empty a cell). ${fix}` });
      }
    }
    if (marked && lynx !== undefined && Math.abs(lynx - marked.t) > FINISH_NEAR_TICKS) {
      out.push({ kind: 'finish-differs', col: null, text: `You marked ${formatRaceTime(marked.t, 1)} as the finish; FinishLynx has ${formatRaceTime(lynx, 1)}.` });
    }
    for (const m of v.manual) {
      if (m.state === 'active') continue;
      out.push({ kind: 'unused-manual', col: m.index, text: `${m.splitName}: the ${m.source} time ${m.timeText} is not used (${MANUAL_NOT_USED[m.state] ?? 'it no longer fits'}).` });
    }
    return out;
  }

  /**
   * The operator's decision on a pass whose column is in doubt (DESIGN 9.17 P2): Move it to a split, or Keep it where
   * counting put it. Journaled as { t: 'assign', raceId, bib, tod, splitId|null } (one per pass) and replayed at
   * every start; a Move overrides counting and the earliest times. `{ bib, all: 'move' }` moves every pass the check
   * would move to the split it suggests, `{ bib, all: 'keep' }` keeps them all.
   * @param {string} raceId
   * @param {{ bib: string, tod?: number, splitId?: string|null, all?: 'move'|'keep' }} body
   * @returns {{ assigned: number }}
   */
  assign(raceId, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const bib = this.#bibIn(state, b.bib);
    const d = state.bibs.get(bib);
    if (!d?.passInfo?.length) throw reviewError(404, `Bib ${text(b.bib) || '?'} has no passes in ${race.name}.`);
    this.#ensureCheck(race, state);
    /** [{ tod, splitId }] */
    let todo = [];
    if (b.all === 'move' || b.all === 'keep') {
      const sus = state.check?.suspects.get(bib);
      if (!sus) throw reviewError(409, `Nothing to check for bib ${bib} any more: its splits look right. Reload the Review list.`);
      for (const mv of sus.moves) {
        const c = d.kept[mv.from];
        // (9.23 F13: a finish pass in the last column moves on by itself when the passes before it move: an extra pass)
        if (!c || (b.all === 'move' && mv.to >= race.splits.length)) continue;
        todo.push({ tod: c.tod, splitId: b.all === 'move' ? race.splits[mv.to].id : null });
      }
    } else {
      const tod = typeof b.tod === 'number' ? b.tod : parseTod(b.tod);
      const cl = tod === null ? null : d.passInfo.find((x) => x.tod === tod || x.items.some((i) => i.r.tod === tod));
      if (!cl) throw reviewError(404, `Bib ${bib} has no pass at that time. Reload the Review list.`);
      const splitId = b.splitId === null || b.splitId === undefined || b.splitId === '' ? null : text(b.splitId);
      if (splitId !== null) {
        const sp = race.splitById.get(splitId);
        if (!sp) throw reviewError(400, `${race.name} has no such split. Reload the Review list.`);
        const why = this.#moveProblem(race, d, cl, sp.index, { stray: race.gunTicks !== null ? this.#strayFlagged(race, state, bib, d, this.#reviewOf(race, state)) : null });
        if (why) throw reviewError(409, why);
      }
      todo = [{ tod: cl.tod, splitId }];
    }
    const now = this.#clock.now();
    const recs = [];
    // 9.23: a Move onto a made-up time replaces it, in the same change (else counting would put the pass after it)
    for (const x of todo) {
      const k = x.splitId === null ? -1 : race.splitById.get(x.splitId).index;
      if (k >= 0 && (d.manualInfo ?? []).some((m) => m.state === 'active' && m.k === k)) recs.push({ t: 'unmanual', raceId: race.id, bib, splitId: x.splitId, at: now });
    }
    for (const x of todo) recs.push({ t: 'assign', raceId: race.id, bib, tod: x.tod, splitId: x.splitId, at: now });
    const before = this.#wheres(state, d);
    const change = this.#runFix(race, state, {
      kind: 'check', bibs: [bib],
      apply: () => {
        for (const r of recs) this.#applyFixRecord(r);
        this.#rederiveBib(race, state, bib);
        return recs;
      },
      text: () => todo.map((x) => {
        const at = formatRaceTime(d.passInfo.find((c) => c.tod === x.tod)?.t ?? 0, 1);
        return x.splitId ? `${at} moved to ${race.splitById.get(x.splitId).name}` : `${at} kept in ${whereWord(before.get(x.tod), race.splits)}`;
      }).join(', '),
    });
    this.#after();
    return { assigned: todo.length, change };
  }

  /**
   * Send a made-up time (DESIGN 9.17 P3). `time` is a race time ("6:12.3"); without it the relay's estimate is used.
   * It becomes a kept crossing of that split, ranked with the real ones, sent to the live outputs and in the merged
   * .lif: 'made-up' when it is the estimate, 'typed' when the operator typed another time. Journaled as
   * { t: 'manual', raceId, bib, splitId, raceTicks, tod, estimated, basis, at, seq }. For a runner who has finished it
   * goes out with the FinishLynx finish place (9.17 P4), and is refused while that place is unknown.
   * Several at once: `{ items: [{ bib, splitId, time?, basis? }] }` (the rows the operator approved with "Send all") or
   * `{ all: true }` (every missing split the Review list has). A batch never throws for one row: a row that can't go
   * is in `skipped` with the reason in words, and each row is checked after the rows before it went in (a typed 1K
   * after the 2K estimate of the same runner is refused, not sent out of order).
   * @param {string} raceId
   * @param {{ bib?: string, splitId?: string, time?: string, basis?: string, all?: boolean,
   *   items?: { bib: string, splitId: string, time?: string, basis?: string }[] }} body
   * @returns {{ added: ManualView[], skipped: { bib: string, splitId: string, why: string }[] }}
   */
  addManual(raceId, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const now = this.#clock.now();
    const skipped = [];
    const added = [];
    const batch = b.all === true || Array.isArray(b.items);
    let shown = null;
    let rows = [b];
    // (the look-wrong check as the operator saw it: an estimate measured from a pass that looks wrong is not sent)
    const seen = this.#reviewOf(race, state);
    if (batch) {
      // One look at the Review list for the whole batch: a row without a time is sent with the estimate the operator
      // saw there. A run of missing splits of one runner is estimated together; working each out again after the one
      // before it went in would send times a little different from the ones the list showed.
      shown = new Map(seen.missing.map((m) => [`${m.bib}|${m.splitId}`, m]));
      rows = b.all === true ? [...shown.values()].map((m) => ({ bib: m.bib, splitId: m.splitId })) : b.items;
    }
    const rowOf = (row) => (row && typeof row === 'object' ? row : {});
    const bibs = rows.map((r) => this.#bibIn(state, rowOf(r).bib)).filter(Boolean);
    // 9.23 F3: one change (one Undo): a time for an empty split, another time for a made-up one, or a batch
    const sp0 = race.splitById.get(text(b.splitId));
    const kind = batch ? 'fill-many' : sp0 && this.#manuals.get(race.id)?.get(this.#bibIn(state, b.bib))?.has(sp0.id) ? 'change-time' : 'fill';
    /** 9.23 F14: made-up times that gave way to the time typed: { name, was, now (null: taken out) } */
    const gaveWay = [];
    const change = this.#runFix(race, state, {
      kind, bibs,
      apply: () => {
        const journal = [];
        for (const row of rows) {
          const r = rowOf(row);
          try {
            // Each approved time goes in at once, so the next row of a batch is checked against it.
            const way = batch ? null : [];
            const x = this.#manualItem(race, state, r, shown, now, seen, way);
            for (const g of way ?? []) journal.push(g.rec);
            const sp = race.splits[x.k];
            const tod = (((race.gunTicks + x.rt) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
            const rec = { t: 'manual', raceId: race.id, bib: x.bib, splitId: sp.id, raceTicks: x.rt, tod, estimated: x.estimated,
              basis: x.basis, at: now, seq: this.#seq };
            journal.push(rec);
            const m = this.#applyFixRecord(rec);
            if (!state.bibKeys.has(bibKey(x.bib))) state.bibKeys.set(bibKey(x.bib), x.bib);
            this.#rederiveBib(race, state, x.bib);
            added.push(m);
            // 9.23 F14: the made-up times that gave way, made up again in their new stretch (else they stay out)
            for (const g of way ?? []) {
              const e = this.#estimateFor(race, state, x.bib, g.k);
              const name = race.splits[g.k].name;
              if (e?.estimate == null) {
                gaveWay.push({ name, was: g.rt, now: null });
                continue;
              }
              const t2 = (((race.gunTicks + e.estimate) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
              const again = { t: 'manual', raceId: race.id, bib: x.bib, splitId: race.splits[g.k].id, raceTicks: e.estimate, tod: t2, estimated: true,
                basis: e.basis, at: now, seq: this.#seq };
              journal.push(again);
              this.#applyFixRecord(again);
              this.#rederiveBib(race, state, x.bib);
              gaveWay.push({ name, was: g.rt, now: e.estimate });
            }
          } catch (err) {
            if (!batch || !Number.isInteger(err?.status)) throw err;
            skipped.push({ bib: text(r.bib), splitId: text(r.splitId), why: String(err.message) });
          }
        }
        return journal;
      },
      text: () => {
        const one = (m) => `${race.splitById.get(m.splitId)?.name ?? '?'} ${formatRaceTime(m.raceTicks, 1)}`;
        if (kind === 'fill-many') {
          const list = added.slice(0, 4).map((m) => `${m.bib} ${one(m)}`).join(', ');
          return `${added.length} made-up time${added.length === 1 ? '' : 's'} sent (${list}${added.length > 4 ? ', …' : ''})`;
        }
        const m = added[0];
        // (9.23 F14: "…; the made-up 4200m time (16:47.7) made up again (14:12.3)", "… taken out")
        const way = gaveWay.map((g) => `the made-up ${g.name} time (${formatRaceTime(g.was, 1)}) ${g.now === null ? 'taken out' : `made up again (${formatRaceTime(g.now, 1)})`}`);
        return [kind === 'change-time' ? `${race.splitById.get(m.splitId)?.name} changed to ${formatRaceTime(m.raceTicks, 1)} (${m.estimated ? 'made-up' : 'typed'})`
          : `${one(m)} ${m.estimated ? 'made up' : 'typed'}`, ...way].join('; ');
      },
    });
    const views = added.map((m) => this.#manualView(race, state, m));
    for (const v of views) this.#manualFeed(race, state, v, now);
    this.#after();
    return { added: views, skipped, change };
  }

  /**
   * Take a made-up time back (DESIGN 9.17 P3): journaled { t: 'unmanual', raceId, bib, splitId, at }. What an output
   * was already given can't be taken back (a packet can only fill a cell), so the answer says so. One change (9.23 F3):
   * Undo puts it back.
   * @param {string} raceId
   * @param {{ bib: string, splitId: string }} body
   * @returns {{ removed: boolean, wasSent: boolean, note: string|null, change: any }}
   */
  removeManual(raceId, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const bib = this.#bibIn(state, b.bib);
    const sp = race.splitById.get(text(b.splitId));
    const m = sp ? this.#manuals.get(race.id)?.get(bib)?.get(sp.id) : undefined;
    if (!sp || !m) throw reviewError(404, `Bib ${text(b.bib) || '?'} has no made-up time${sp ? ` at ${sp.name}` : ''}. Reload the Review list.`);
    const key = crossingKey(bib, sp.id);
    const c = state.kept.get(key);
    // the made-up time itself went out (an older real time of the split in that cell is the leftover note's)
    const wasSent = !!c?.manual && this.#madeUpSent(race, state, c);
    const now = this.#clock.now();
    const timeText = formatRaceTime(c?.manual ? c.rt : m.raceTicks, 1);
    const rec = { t: 'unmanual', raceId: race.id, bib, splitId: sp.id, at: now };
    const change = this.#runFix(race, state, {
      kind: 'remove', bibs: [bib],
      apply: () => {
        this.#applyFixRecord(rec);
        this.#rederiveBib(race, state, bib);
        return [rec];
      },
      text: () => `${sp.name} ${timeText} (${m.estimated ? 'made-up' : 'typed'}) removed`,
    });
    const note = wasSent
      ? `The ${m.estimated ? 'made-up' : 'typed'} ${sp.name} time (${timeText}) was already sent. Split Relay can't remove it from TrackScore and the live ` +
        'results (a packet can only fill a cell, never empty one), so it stays there until the race is cleared there. ' +
        'It is gone from the merged .lif.'
      : null;
    const entry = this.#entryFor({ location: '', bib, tod: c?.manual ? c.tod : m.tod, port: null }, now);
    const who = this.#who(state, bib);
    Object.assign(entry, { raceId: race.id, raceName: race.name, splitName: sp.name, name: joinName(who), team: who.team,
      raceTicks: c?.manual ? c.rt : m.raceTicks, status: m.estimated ? 'made-up' : 'typed',
      detail: `Removed in Review.${note ? ` ${note}` : ''}` });
    this.#publish(entry);
    this.#after();
    return { removed: true, wasSent, note, change };
  }

  /**
   * DESIGN 9.23 F2, the one way to change a pass from the runner editor: Move it to a split (with the passes after it,
   * or `only` this one: the others are then held where they are), "Not a split" ('none'), "This is the finish"
   * ('finish'), "Let Split Relay count it" ('count': every decision on the pass forgotten) or "It's right" ('keep').
   * Checked first, with words (`from`: the split the operator saw it in, so a change made in another window is
   * refused, not undone by accident); then applied, and the runner worked out again; then the result checked (the pass
   * really is where it was put), and on failure everything is put back and refused in words. Only then is the change
   * journaled (one write) and sent (#sendFixed).
   * @param {string} raceId
   * @param {string} bibText
   * `withFinishPlace`: for a runner who has finished, the splits the change gives a new time or column go live with
   * the finish place (as Send with finish place would send them), when it is known; without it they go into the
   * merged .lif only and wait in "Finished: not sent live" (9.17 P4).
   * 9.24: `also`, for Not a split ('none') and It's right ('keep'): the runner's other passes that get the same answer in
   * the same change (the times of day of one read of each), so the row of a runner with two splits too fast to be real
   * takes both back at once (one Undo), and neither is counted into the other's split in between.
   * @param {{ tod: number|string, to: string, only?: boolean, from?: string, withFinishPlace?: boolean, also?: (number|string)[] }} body
   * @returns {{ change: any }}
   */
  movePass(raceId, bibText, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const to = text(b.to);
    const tod = typeof b.tod === 'number' ? b.tod : parseTod(b.tod);
    if (tod === null || !to) throw reviewError(400, 'Send { "tod": <time of day of the pass>, "to": "<split id>" | "none" | "finish" | "count" | "keep" }.');
    if (!MOVE_TO.has(to) && !race.splitById.has(to)) throw reviewError(400, `${race.name} has no such split. Reload: the race may have changed.`);
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    const cl = d?.passInfo?.find((x) => x.tod === tod || x.items.some((i) => i.r.tod === tod)) ?? null;
    if (!cl) throw reviewError(404, `Bib ${bib || text(bibText) || '?'} has no pass at that time any more. It shows again now.`);
    const at = formatRaceTime(cl.t, 1);
    if (b.from !== undefined && b.from !== null) {
      const where = this.#whereOf(state, d, cl);
      const now = typeof where === 'number' ? race.splits[where].id : '';
      const from = text(b.from);
      if (from !== now) {
        const word = (id, w) => (id ? race.splitById.get(id)?.name ?? 'another split' : w === 'finish' ? 'the finish' : 'outside the splits');
        throw reviewError(409, `${at} is ${word(now, where)} now, not ${word(from, null)}: it was changed in another window. Look again.`);
      }
    }
    const rule = this.#moveRules(race, state, bib, d, cl, to, b.only === true,
      { stray: race.gunTicks !== null ? this.#strayFlagged(race, state, bib, d, this.#reviewOf(race, state)) : null });
    if (rule.why) throw reviewError(rule.status, rule.why);
    // 9.24: the other passes that get the same answer (Not a split, It's right), each by its own rules
    const more = [];
    for (const v of to === 'none' || to === 'keep' ? arr(b.also) : []) {
      const t2 = typeof v === 'number' ? v : parseTod(v);
      const x = t2 === null ? null : d.passInfo.find((y) => y.tod === t2 || y.items.some((i) => i.r.tod === t2)) ?? null;
      if (!x) throw reviewError(404, `Bib ${bib} has no pass at that time any more. It shows again now.`);
      if (x === cl || more.some((m) => m.cl === x)) continue;
      const r2 = this.#moveRules(race, state, bib, d, x, to);
      // (one that has that answer already stays as it is)
      if (r2.why && r2.status === 409) continue;
      if (r2.why) throw reviewError(r2.status, r2.why);
      more.push({ cl: x, rule: r2 });
    }
    const recs = [...rule.recs, ...more.flatMap((m) => m.rule.recs)];
    const before = this.#wheres(state, d);
    const change = this.#runFix(race, state, {
      kind: rule.kind, bibs: [bib],
      // 9.23 F2: a finisher's changed splits go with the finish place when the operator said so (the panel asks first)
      byFinish: b.withFinishPlace === true,
      apply: () => {
        for (const r of recs) this.#applyFixRecord(r);
        this.#rederiveBib(race, state, bib);
        return recs;
      },
      check: () => this.#fixCheck(race, state, bib, cl.tod, rule.expect, at, to)
        ?? more.map((m) => this.#fixCheck(race, state, bib, m.cl.tod, m.rule.expect, formatRaceTime(m.cl.t, 1), to)).find(Boolean) ?? null,
      text: () => {
        if (!more.length) return this.#moveWords(race, state, bib, cl, rule.kind, before, rule.drops);
        const times = listWords([cl, ...more.map((m) => m.cl)].sort((x, y) => x.t - y.t).map((x) => formatRaceTime(x.t, 1)));
        return to === 'none' ? `${times} are not splits now` : `${times} stay where they are`;
      },
    });
    this.#after();
    return { change };
  }

  /**
   * DESIGN 9.23 F13, "Missed 2400m: add it": a mat missed the runner at a split, so counting put the next split's pass
   * (and every later one) a column early. In ONE change (one Undo): the pass in that split and the later ones move on
   * one column (`count` columns for a run of missed splits in a row), and the missed split gets the suggested time (made
   * up from the split before and the pass that moved on, placed like the runners nearest in pace) or the time typed
   * (`time`, a race time, or `tod`, a time of day; one split only). A pass moved past the last split is an extra pass,
   * never laps to go 0. For a missed last split whose pass was marked as the finish (This is the finish, the cell
   * empty), that pass is the one that moves on: it is an extra pass again, so the runner is not finished for Split Relay
   * and the made-up split goes with its own place (with merged .lif files off nobody's finish place is known). Then every
   * cell it changes goes out (#runFix, #sendFixed), each with its laps to go, the runner's furthest split last. The rules
   * of a Move apply to the pass (#moveRules) and those of a fill to the time: a finisher's goes with the finish place
   * (the moved real splits too with `withFinishPlace`: the panel asks first) and is refused while that place is unknown;
   * a paused split's waits for Play; a race that is not Active gets the merged .lif only. 9.23 F16: `also`, the other runs
   * of missed splits further on (two mats missed apart: 4200m and 5300m, 4400m read), each { splitId: its first split as
   * the course has it, count }: all of them in the same change, every run's pass moved on and its splits made up (no
   * typed time), every affected split sent once with its laps to go and leg, the furthest last; one Undo.
   * @param {string} raceId
   * @param {string} bibText
   * @param {{ splitId: string, passTod?: number|string, count?: number, also?: { splitId: string, count?: number }[],
   *   time?: string, tod?: string, basis?: string, withFinishPlace?: boolean }} body passTod: the pass the panel showed in
   *   that split (a change made in another window since is refused, not undone by accident)
   * @returns {{ change: any, added: ManualView[] }}
   */
  addMissed(raceId, bibText, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const n = race.splits.length;
    const sp = race.splitById.get(text(b.splitId));
    if (!sp) throw reviewError(400, 'Send { "splitId": "<the split the mat missed>", "passTod": <time of day of the pass in it> }.');
    const count = b.count === undefined || b.count === null || b.count === '' ? 1 : Number(b.count);
    if (!Number.isInteger(count) || count < 1 || sp.index + count > n) {
      throw reviewError(400, `"count" is how many splits in a row the mats missed from ${sp.name} on: 1 to ${n - sp.index}.`);
    }
    // 9.23 F16: the other runs further on, course order, each after a split that was read
    const also = [];
    if (b.also !== undefined && b.also !== null) {
      if (!Array.isArray(b.also)) throw reviewError(400, '"also" is the other runs of missed splits further on: [{ "splitId": "<its first split>", "count": 1 }].');
      let end = sp.index + count;
      for (const r of b.also) {
        const rsp = race.splitById.get(text(r?.splitId));
        if (!rsp) throw reviewError(400, `${race.name} has no such split in "also". Reload the runner.`);
        const rc = r.count === undefined || r.count === null || r.count === '' ? 1 : Number(r.count);
        if (!Number.isInteger(rc) || rc < 1 || rsp.index + rc > n) throw reviewError(400, `"count" in "also" is how many splits in a row the mats missed from ${rsp.name} on: 1 to ${n - rsp.index}.`);
        if (rsp.index <= end) {
          throw reviewError(400, end < n ? `${rsp.name} is not after ${race.splits[end].name}, which was read: a run in a row is one "count".` : `${rsp.name} is not after the splits before it.`);
        }
        also.push({ k: rsp.index, count: rc });
        end = rsp.index + rc;
      }
    }
    const typedTime = text(b.time);
    const typedTod = text(b.tod);
    if ((typedTime || typedTod) && (count > 1 || also.length)) throw reviewError(400, 'A typed time is for one missed split: send "count": 1 with it, or no time for the suggested ones.');
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    if (!d?.passInfo?.length) throw reviewError(404, `Bib ${bib || text(bibText) || '?'} has no passes in ${race.name}.`);
    const rv = this.#reviewOf(race, state);
    // 9.23 F20: stray passes set aside in the same change (Not a split): a stray that made up for the missed mat in the count
    let aside = [];
    if (b.aside !== undefined && b.aside !== null) {
      if (!Array.isArray(b.aside)) throw reviewError(400, '"aside" is the stray passes to set aside in the same change: [<time of day of each>].');
      aside = this.#asideOf(d, { aside: b.aside.map((x) => (typeof x === 'number' ? x : parseTod(text(x)))) });
      if (!aside) throw reviewError(409, `Bib ${bib} has no such stray pass any more. Reload the runner.`);
    }
    const plan = this.#missedPlan(race, state, bib, d, sp.index, count, this.#refRunners(state, n, bib, rv.legs), also, aside);
    if (plan.why) throw reviewError(plan.status, plan.why);
    const passTod = typeof b.passTod === 'number' ? b.passTod : text(b.passTod) ? parseTod(text(b.passTod)) : null;
    if (passTod !== null && plan.cl.tod !== passTod && !plan.cl.items.some((i) => i.r.tod === passTod)) {
      throw reviewError(409, `${sp.name} has ${formatRaceTime(plan.cl.t, 1)} now, not the pass you saw: it was changed in another window. Look again.`);
    }
    // the time of each missed split: typed (one split), or the suggestion, which is not measured from a pass that
    // looks wrong (9.23 F6: a typed time is the operator's own)
    const times = [];
    /** 9.23 F14: made-up times that give way to the time typed */
    let way = [];
    if (typedTime || typedTod) {
      let rt;
      let basis = text(b.basis) || 'Typed in Review.';
      if (typedTod) {
        const tod = /^\d{1,2}:\d{2}:\d{2}([.,]\d{1,4})?$/.test(typedTod) ? parseTod(typedTod) : null;
        if (tod === null) throw reviewError(400, `"${typedTod}" is not a time of day. Type it like 16:36:43.6 (hours:minutes:seconds).`);
        rt = raceTicks(tod, race.gunTicks);
        if (rt <= 0) throw reviewError(409, `${formatTod(tod, 1)} is before the gun (${race.gunText}).`);
        basis = `Typed in Review as the time of day ${formatTod(tod, 1)}.`;
      } else {
        rt = parseRaceTime(typedTime);
        if (rt === null || rt <= 0) throw reviewError(400, `"${typedTime}" is not a race time. Type it like 6:12.3 (minutes:seconds).`);
        if (rt >= MAX_RACE_TICKS_TYPED) {
          const mins = Math.floor(rt / (60 * TICKS_PER_SEC));
          throw reviewError(400, `"${typedTime}" is ${Math.floor(mins / 60)} h ${mins % 60} min of race time. If it is a time of day, send it as one. Race times look like 8:12.3.`);
        }
      }
      rt = Math.round(rt / 10) * 10;
      const t = formatRaceTime(rt, 1);
      const { startTicks, startSec } = this.#filter();
      // 9.23 F14: made-up times before it that are not before the time typed give way (made up again after it), as
      // they do for a Move and a fill
      way = (d.manualInfo ?? []).filter((m) => m.state === 'active' && m.rec?.estimated && m.k < sp.index && m.rt >= rt);
      let prev = plan.prev;
      if (way.length) {
        prev = null;
        for (let x = 0; x < sp.index; x++) if (d.kept[x] && !way.some((m) => m.k === x)) prev = { name: race.splits[x].name, t: d.kept[x].rt };
      }
      if (prev && rt <= prev.t) throw reviewError(409, `${t} is not after bib ${bib}'s ${prev.name} (${formatRaceTime(prev.t, 1)}). A ${sp.name} time must come after it.`);
      if (!prev && rt < startTicks) throw reviewError(409, `${t} is in the start area (the first ${fmtSec(startSec)} s after the gun). A ${sp.name} time must come after it.`);
      if (rt >= plan.next.t) throw reviewError(409, `${t} is not before ${plan.next.text} (${formatRaceTime(plan.next.t, 1)}). A ${sp.name} time must come before it.`);
      // the suggestion as the panel showed it goes as Split Relay's estimate, with how it was made
      const e = plan.est[0];
      const estimated = e?.estimate != null && rt === e.estimate;
      times.push({ k: sp.index, rt, estimated, basis: estimated ? e.basis : basis });
    } else {
      const block = this.#missedFlagBlock(race, state, rv, bib, { k: sp.index, count, runs: [{ k: sp.index, count }, ...also], aside: aside.map((x) => ({ tod: x.tod, t: x.t })) },
        this.#missedHint(race, state, bib, rv));
      if (block) throw reviewError(409, block);
      for (const e of plan.est) {
        if (e.estimate == null) throw reviewError(409, `There is no suggestion for bib ${bib} at ${race.splits[e.col].name} (${e.basis}). Type the time instead.`);
        times.push({ k: e.col, rt: e.estimate, estimated: true, basis: e.basis });
      }
    }
    const now = this.#clock.now();
    const before = this.#wheres(state, d);
    const added = [];
    const gave = [];
    const change = this.#runFix(race, state, {
      kind: 'missed', bibs: [bib],
      // a finisher's moved real splits go with the finish place when the operator said so (the panel asks first)
      byFinish: b.withFinishPlace === true,
      apply: () => {
        const recs = [...way.map((m) => ({ t: 'unmanual', raceId: race.id, bib, splitId: race.splits[m.k].id, at: now })), ...plan.recs];
        for (const x of times) {
          const tod = (((race.gunTicks + x.rt) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
          recs.push({ t: 'manual', raceId: race.id, bib, splitId: race.splits[x.k].id, raceTicks: x.rt, tod, estimated: x.estimated, basis: x.basis, at: now, seq: this.#seq });
        }
        for (const r of recs) {
          const m = this.#applyFixRecord(r);
          if (m) added.push(m);
        }
        this.#rederiveBib(race, state, bib);
        // 9.23 F14: the made-up times that gave way, made up again in their new stretch (else they stay out)
        for (const m of way) {
          const e = this.#estimateFor(race, state, bib, m.k);
          if (e?.estimate == null) {
            gave.push({ name: race.splits[m.k].name, was: m.rt, now: null });
            continue;
          }
          const tod = (((race.gunTicks + e.estimate) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
          const r = { t: 'manual', raceId: race.id, bib, splitId: race.splits[m.k].id, raceTicks: e.estimate, tod, estimated: true, basis: e.basis, at: now, seq: this.#seq };
          this.#applyFixRecord(r);
          recs.push(r);
          this.#rederiveBib(race, state, bib);
          gave.push({ name: race.splits[m.k].name, was: m.rt, now: e.estimate });
        }
        return recs;
      },
      check: () => this.#missedCheck(race, state, bib, plan),
      text: () => [this.#missedWords(race, state, bib, plan, before, added, rv.legs?.field?.stream === true),
        ...gave.map((g) => `the made-up ${g.name} time (${formatRaceTime(g.was, 1)}) ${g.now === null ? 'taken out' : `made up again (${formatRaceTime(g.now, 1)})`}`)].join('; '),
    });
    const views = added.map((m) => this.#manualView(race, state, m));
    for (const v of views) this.#manualFeed(race, state, v, now);
    this.#after();
    return { change, added: views };
  }

  /**
   * DESIGN 9.23 F3: undo one change (its id, `fix`), or redo one (undo the Undo). Allowed for a runner while what the
   * change left is still that runner's newest decision (fixSig); a change of several runners (Fill in N) undoes the
   * runners that still match and says which it left. A cell the undo empties stays filled on TrackScore and Karmarush
   * (a packet can fill a cell, never empty one): without `confirm` the answer is a 409 { code: 'UNDO_LEAVES', leaves }
   * that says so, and the panel asks first. The restored times go out like any approved change (#sendFixed).
   * @param {string} raceId
   * @param {{ fix: number, confirm?: boolean }} body
   * @returns {{ change: any, undone: number }}
   */
  undo(raceId, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const id = typeof b.fix === 'number' ? b.fix : /^\d+$/.test(text(b.fix)) ? Number(text(b.fix)) : NaN;
    if (!Number.isInteger(id) || id < 1) throw reviewError(400, 'Send { "fix": 17 }: the change to undo.');
    const g = this.#fixGroups.get(race.id)?.get(id);
    if (!g) {
      throw reviewError(404, this.#fixDropped.get(race.id)?.has(id)
        ? `There is no change ${id} in ${race.name} (the race was cleared since). Change it by hand.`
        : `There is no change ${id} in ${race.name}. Change it by hand.`);
    }
    if (g.undoneBy) throw reviewError(409, 'That change was undone already.');
    const ok = [];
    const notes = [];
    let late = null;
    for (const [bib, x] of g.bibs) {
      if (this.#fixSigOf(race.id, bib) === x.sigAfter) ok.push(bib);
      else {
        late ??= bib;
        notes.push(`Bib ${bib} was changed since: not undone.`);
      }
    }
    if (!ok.length) {
      const newer = late === null ? null : this.#fixesOf(race.id, late).find((x) => x.id > g.id) ?? null;
      throw reviewError(409, `Bib ${late ?? '?'} was changed after this (${newer ? `${newer.text}, at ${wallText(newer.at)}` : 'another change'}). Undo that first, or change it by hand.`);
    }
    const now = this.#clock.now();
    const keptBefore = new Map(ok.map((bib) => [bib, state.bibs.get(bib)?.kept.filter(Boolean).map((c) => c) ?? []]));
    // A Redo (the Undo of an Undo) does the change again and says it so; an Undo says what it did, not the change it
    // took back ("Undone: 24:17.3 is the 5300m split again", not "Undone: 24:17.3 is the finish now")
    let root = g;
    let redo = false;
    for (let up = g; up.kind === 'undo' && up.undoes !== null;) {
      up = this.#fixGroups.get(race.id)?.get(up.undoes);
      if (!up) break;
      root = up;
      redo = !redo;
    }
    const was = new Map(ok.map((bib) => [bib, { wheres: this.#wheres(state, state.bibs.get(bib)), manuals: this.#fixState(race.id, bib).manuals }]));
    let recs = [];
    let leaves = [];
    const change = this.#runFix(race, state, {
      kind: 'undo', bibs: ok,
      // a finisher's change sent with the finish place: what the Undo puts back goes the same way
      byFinish: g.byFinish === true,
      apply: () => {
        recs = [];
        // (a made-up time comes back with its own time of approval, journal position and all)
        for (const bib of ok) for (const inv of g.bibs.get(bib).inverse) recs.push({ at: now, ...inv, raceId: race.id, bib });
        for (const r of recs) this.#applyFixRecord(r);
        for (const bib of ok) this.#rederiveBib(race, state, bib);
        return recs;
      },
      check: () => {
        // what the undo empties that an output has now: TrackScore and Karmarush keep it
        leaves = [];
        for (const [bib, cs] of keptBefore) {
          const fp = this.#finished(state, bib) ? this.#finishPlace(state, bib) : null;
          for (const c of cs) {
            if (state.kept.has(c.key)) continue;
            const copy = this.#boardCopy(state, c.key);
            // (sent with the finish place: Send with finish place, or a change sent with it)
            if (copy) leaves.push({ bib, splitId: c.splitId, splitName: race.splits[c.index]?.name ?? '', text: copy.text, outputs: copy.outputs, withFinishPlace: fp !== null && copy.places.includes(fp) });
          }
        }
        // 9.23 F13: a pass the undo gives back to the column check is held again (Passes to check): nothing goes out for
        // it until the operator chooses, so an output keeps what the change sent there (the fix of a held runner, as
        // "Missed 2400m: add it", undone)
        this.#ensureCheck(race, state);
        for (const bib of ok) {
          for (const c of state.bibs.get(bib)?.kept ?? []) {
            if (!c || this.#holdOf(race, state, c) !== 'check') continue;
            const copy = this.#boardCopy(state, c.key);
            if (!copy || copy.tods.every((t) => t === c.tod)) continue;
            leaves.push({ bib, splitId: c.splitId, splitName: race.splits[c.index]?.name ?? '', text: copy.text, outputs: copy.outputs, withFinishPlace: false, held: true });
          }
        }
        if (leaves.length && b.confirm !== true) {
          const outs = [...new Set(leaves.flatMap((x) => x.outputs))];
          const names = outs.length ? listWords(outs) : 'TrackScore';
          const what = listWords(leaves.map((x) => `${x.text} at ${x.splitName} (bib ${x.bib})`));
          const held = [...new Set(leaves.filter((x) => x.held).map((x) => x.bib))];
          const why = [leaves.some((x) => !x.held) ? 'a packet can fill a cell but never empty one' : null,
            held.length ? `Split Relay holds ${listWords(held.map((x) => `bib ${x}'s passes`))} again (Passes to check) and sends nothing for them until you choose` : null];
          throw Object.assign(reviewError(409, `${names} ${outs.length === 1 ? 'keeps' : 'keep'} ${what}: ${why.filter(Boolean).join(', and ')}. Undo anyway?`),
            { code: 'UNDO_LEAVES', leaves: leaves.map(leaveOut) });
        }
        return null;
      },
      text: () => (redo ? `Done again: ${root.text}` : this.#undoWords(race, state, recs, was, root)),
      head: (ng) => ({ t: 'undo', raceId: race.id, fix: id, by: ng.id, bibs: ok, text: ng.text, at: now }),
      commit: (ng) => {
        ng.undoes = id;
        g.undoneBy = ng.id;
      },
    });
    change.leaves = leaves.map(leaveOut);
    change.notes = notes;
    this.#after();
    return { change, undone: id };
  }

  /**
   * DESIGN 9.23 F4, "Send bib 586 again" in the runner editor: every split of the runner that an output has otherwise
   * (an older time, another place) goes out now, as the operator approved it, whatever the minute says; the furthest
   * last. A runner who has finished gets nothing (Send with finish place does that). Refused for a race that is not
   * Active.
   * @returns {{ sent: number, outputs: number, skipped: { splitName: string, why: string }[] }}
   */
  sendRunner(raceId, bibText) {
    const { race, state } = this.#reviewRace(raceId);
    if (!race.active) throw reviewError(409, `${race.name} is not Active: nothing goes live. Tick Active first.`);
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    if (!d?.keptCount) throw reviewError(404, `Bib ${bib || text(bibText) || '?'} has no splits in ${race.name}.`);
    const now = this.#clock.now();
    const finished = this.#finished(state, bib);
    const fp = finished ? this.#finishPlace(state, bib) : null;
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    const keys = new Set();
    for (const c of d.kept) {
      if (!c) continue;
      const place = finished && c.manual && fp !== null ? fp : this.#place(state, c);
      const content = this.#content(race, c, place);
      if (outs.some((o) => (this.#latestFlight(state, o.id, c.key) ?? state.ledgers.get(o.id)?.get(c.key))?.sig !== content.sig)) keys.add(c.key);
    }
    this.#capture = [];
    let res;
    try {
      // (and the runner's furthest split last, also when only the place TrackScore shows for them was wrong)
      res = this.#sendFixed(race, state, bib, now, keys, [], { placeCheck: true });
    } finally {
      this.#capture = null;
    }
    this.#log(`[engine] ${race.name} bib ${bib}: sent again (Review): ${res.keys.size} split${res.keys.size === 1 ? '' : 's'}`);
    this.#touched.add(race.id);
    this.#after();
    return { sent: res.keys.size, outputs: res.outputs.size, skipped: res.notLive.map((x) => ({ splitName: x.splitName, why: x.why })) };
  }

  /**
   * DESIGN 9.24, "Stop sending this runner": from a moment of the race on, nothing of the runner goes to any output or
   * into the merged .lif. Its reads are still read, counted into the splits and shown (the grid, the editor, Review),
   * and they no longer count for the places of the others. From when (#stopPlan): `from`, the pass the operator pressed
   * it on (the time of day of one of its reads), else the runner's first split in question (the pace check's mark): that
   * split and the later ones are taken back; else after its last pass so far (what went out stays, nothing more goes). One change: journaled { t: 'runner-off', raceId, bib, from }, kept across a restart,
   * undone by Undo or by "Send this runner again". The other runners' lines whose place it changes go out again by
   * themselves (#runFix).
   * @param {string} raceId
   * @param {string} bibText
   * @param {{ from?: number|string }} [body]
   * @returns {{ change: any }}
   */
  stopRunner(raceId, bibText, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    if (!d?.passInfo?.length) throw reviewError(404, `Bib ${bib || text(bibText) || '?'} has no passes in ${race.name}.`);
    if (race.gunTicks === null) throw reviewError(409, `${race.name} has no gun time yet.`);
    if (this.#offs.get(race.id)?.has(bib)) throw reviewError(409, `Bib ${bib} is not sent already.`);
    this.#ensureCheck(race, state);
    const tod = b.from === undefined || b.from === null ? null : typeof b.from === 'number' ? b.from : parseTod(b.from);
    const cl = tod === null ? null : d.passInfo.find((x) => x.tod === tod || x.items.some((i) => i.r.tod === tod)) ?? null;
    if (b.from !== undefined && b.from !== null && !cl) throw reviewError(404, `Bib ${bib} has no pass at that time any more. It shows again now.`);
    const plan = this.#stopPlan(race, state, bib, d, cl ? cl.t : null);
    const rec = { t: 'runner-off', raceId: race.id, bib, from: plan.from, at: this.#clock.now() };
    const change = this.#runFix(race, state, {
      kind: 'stop', bibs: [bib],
      apply: () => {
        this.#applyFixRecord(rec);
        this.#rederiveBib(race, state, bib);
        return [rec];
      },
      text: () => plan.text,
    });
    this.#after();
    return { change };
  }

  /**
   * DESIGN 9.24, "Send this runner again": the stop is taken back (journaled { t: 'runner-on', raceId, bib }). What it
   * held is judged again as any pass and goes out if it still fits (a split that is too fast to be real is marked
   * again); a finisher's real split waits for Send with finish place.
   * @returns {{ change: any }}
   */
  resumeRunner(raceId, bibText) {
    const { race, state } = this.#reviewRace(raceId);
    const bib = this.#bibIn(state, bibText);
    if (!this.#offs.get(race.id)?.has(bib)) throw reviewError(409, `Bib ${bib || text(bibText) || '?'} is sent as usual already.`);
    const rec = { t: 'runner-on', raceId: race.id, bib, at: this.#clock.now() };
    const change = this.#runFix(race, state, {
      kind: 'resume', bibs: [bib],
      apply: () => {
        this.#applyFixRecord(rec);
        this.#rederiveBib(race, state, bib);
        return [rec];
      },
      text: () => 'Sent again',
    });
    this.#after();
    return { change };
  }

  /**
   * DESIGN 9.25, what the operator says of where a runner runs. { say: 'away' }, "Not in this race": every pass of the
   * runner here, now and later, stays off every output and out of the merged .lif, and counts for nobody's place; what a
   * scoreboard has of it is taken back (a clearing line where an output takes one), and the other runners' lines whose
   * place moved go out again by themselves (#runFix). { say: 'here' }, "Count them here" / "It's right": the runner is
   * this race's whatever a start list or the day's other races say: what was kept off the boards goes out like any
   * runner's splits. One change: journaled { t: 'runner-say', raceId, bib, say }, kept across a restart, undone by Undo.
   * @param {string} raceId
   * @param {string} bibText
   * @param {{ say?: 'here'|'away' }} [body]
   * @returns {{ change: any }}
   */
  placeRunner(raceId, bibText, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    const say = b.say === 'here' || b.say === 'away' ? b.say : null;
    if (!say) throw reviewError(400, 'Send { "say": "away" } (not in this race) or { "say": "here" } (count them here).');
    const bib = this.#bibIn(state, bibText);
    const d = state.bibs.get(bib);
    // (a runner with a read and no pass yet, a read in the start area, can be said of too: it is for its passes to come)
    if (!d) throw reviewError(404, `Bib ${bib || text(bibText) || '?'} has no reads in ${race.name}.`);
    const was = this.#says.get(race.id)?.get(bib) ?? null;
    const isAway = this.#isAway(race, state, bib, d);
    if (say === 'away' && (was === 'away' || isAway)) throw reviewError(409, `Bib ${bib} is not in ${race.name} already.`);
    if (say === 'here' && was === 'here') throw reviewError(409, `Bib ${bib} counts in ${race.name} already.`);
    const takesBack = say === 'away' ? d.kept.filter((c) => c && !this.#holdOf(race, state, c) && this.#boardCopy(state, c.key)).map((c) => race.splits[c.index].name) : [];
    const rec = { t: 'runner-say', raceId: race.id, bib, say, at: this.#clock.now() };
    const change = this.#runFix(race, state, {
      kind: say, bibs: [bib],
      apply: () => {
        this.#applyFixRecord(rec);
        this.#rederiveBib(race, state, bib);
        return [rec];
      },
      text: () => (say === 'away' ? `Not in this race${takesBack.length ? ` (${listWords(takesBack)} taken back)` : ''}` : isAway ? 'Counted in this race' : 'Stays in this race'),
    });
    this.#after();
    return { change };
  }

  // ---- swapped bibs (DESIGN 9.27) ---------------------------------------------------------------------------------

  /**
   * DESIGN 9.27: the pairs of swapped bibs, oldest first, as the panel lists them: { a, b, at, atText, text, races }.
   * races: where each bib has reads of the other one's chip now, in words ("Women's Race: bib 510 has 5 splits read as
   * bib 11 (3:17.3 to 17:57.9)").
   */
  swaps() {
    return this.#swapList.map((s) => this.#swapOut(s));
  }

  #swapOut(s) {
    const races = [];
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      const parts = [];
      for (const [bib, chip] of [[s.b, s.a], [s.a, s.b]]) {
        const reads = state.reads.get(bib);
        if (!reads?.length) continue;
        const kept = state.bibs.get(bib)?.kept.filter(Boolean) ?? [];
        parts.push(kept.length ? `bib ${bib} has ${splitsText(kept)} read as bib ${chip}`
          : `bib ${bib} has ${reads.length === 1 ? '1 read' : `${reads.length} reads`} of bib ${chip}'s chip`);
      }
      if (parts.length) races.push({ raceId: race.id, raceName: race.name, text: `${race.name}: ${parts.join('; ')}` });
    }
    return { a: s.a, b: s.b, at: s.at, atText: wallText(s.at), text: `Bib ${s.a} and bib ${s.b} are swapped`, races };
  }

  /** 9.27: the swap a bib is in, for the runner editor: { other, at, atText, text }, or null. */
  #swapOf(state, bib) {
    const s = this.#swapBy.size ? this.#swapBy.get(bibKey(bib)) : undefined;
    if (!s) return null;
    const mine = state.reads.get(bib)?.length ?? 0;
    return { other: s.other, at: s.swap.at, atText: wallText(s.swap.at),
      text: mine ? `Swapped bibs: bib ${bib} ran with the chip of bib ${s.other}. Its reads here came in as bib ${s.other}.`
        : `Swapped bibs: bib ${bib} ran with the chip of bib ${s.other}. That chip has not been read in this race.` };
  }

  /** 9.27: the two bibs of a request ({ bib, other }), each as the reads so far spell it. Throws in words. */
  #swapArgs(body) {
    const b = body && typeof body === 'object' ? body : {};
    const x = text(b.bib);
    const y = text(b.other);
    const why = swapBibProblem(x) ?? swapBibProblem(y);
    if (why) throw reviewError(400, why);
    if (bibKey(x) === bibKey(y)) throw reviewError(400, `Bib ${x} can't be swapped with itself. Type the bib whose chip it ran with.`);
    return { a: this.#bibForm(x), b: this.#bibForm(y) };
  }

  /** A bib as the reads so far spell it ("0458" when RR12 sends it so), else as FinishLynx writes it (no leading zeros). */
  #bibForm(b) {
    if (this.#byBib.has(b)) return b;
    const k = bibKey(b);
    for (const chip of this.#byBib.keys()) if (bibKey(chip) === k) return chip;
    return k;
  }

  /** 9.27: whether a chip (a bib as received) has a read that counts in this race. */
  #chipRead(raceId, chip) {
    const k = bibKey(chip);
    for (const [c, list] of this.#byBib) {
      if (bibKey(c) !== k) continue;
      for (const r of list) if (r.gone === LIVE && r.raceId === raceId) return true;
    }
    return false;
  }

  /**
   * 9.27, for the preview of a swap: why a bib would be kept off this race's boards once it has passes here (9.25), in
   * words ("you said so", "entered in Men's Race"), or null: the operator said Not in this race, or the race's start
   * list is in use and enters the bib in another race only (and the setting keeps those off the boards).
   */
  #awayWhy(race, state, bib) {
    const say = this.#says.get(race.id)?.get(bib) ?? null;
    if (say) return say === 'away' ? 'you said so' : null;
    if (!this.#keepOff || state.check?.list?.used !== true) return null;
    const key = bibKey(bib);
    if (this.#lists.byEvent.get(race.event)?.bibs.has(key)) return null;
    const ev = this.#lists.eventsOf.get(key)?.[0];
    if (!ev) return null;
    const rs = this.#races.filter((r) => r.event === ev);
    return `entered in ${rs.length ? listWords(rs.map((r) => r.name)) : `event ${ev}`}`;
  }

  /** 9.27: the runner a read counts for: its own bib, or the other bib of its pair while their swap is in force. */
  #label(r) {
    const s = this.#swapBy.size ? this.#swapBy.get(bibKey(r.chip)) : undefined;
    const bib = s ? s.other : r.chip;
    if (r.bib !== bib) r.bib = bib;
  }

  #putSwap(a, b, at) {
    const swap = { a, b, at };
    this.#swapList.push(swap);
    this.#swapBy.set(bibKey(a), { other: b, swap });
    this.#swapBy.set(bibKey(b), { other: a, swap });
    return swap;
  }

  #dropSwap(swap) {
    const i = this.#swapList.indexOf(swap);
    if (i >= 0) this.#swapList.splice(i, 1);
    this.#swapBy.delete(bibKey(swap.a));
    this.#swapBy.delete(bibKey(swap.b));
  }

  /**
   * DESIGN 9.27: what entering the swap of two bibs ({ bib, other }), or removing the one a bib is in ({ bib, remove:
   * true }), would do, in words, changing nothing: per race, which splits become which bib's, whether they go out, and
   * what the boards still show; and what stays behind (the changes made to either bib before).
   * @param {{ bib?: string, other?: string, remove?: boolean }} body
   * @returns {{ a: string, b: string, remove: boolean, title: string, lead: string, confirm: string,
   *   races: { raceId: string, raceName: string, active: boolean, lines: string[] }[], notes: string[] }}
   */
  swapPreview(body) {
    const { a, b, remove } = this.#swapAsked(body);
    return this.#swapPlan(a, b, remove);
  }

  /** The pair a request is about, checked: to enter ({ bib, other }) or to remove ({ bib, remove: true }). Throws in words. */
  #swapAsked(body) {
    const q = body && typeof body === 'object' ? body : {};
    if (q.remove === true) {
      const x = text(q.bib);
      const s = x ? this.#swapBy.get(bibKey(x))?.swap : null;
      if (!s) throw reviewError(404, `Bib ${x || '?'} is not swapped with another bib. The swap may have been removed already: reload the page.`);
      return { a: s.a, b: s.b, remove: true, swap: s };
    }
    const { a, b } = this.#swapArgs(q);
    for (const [x, y] of [[a, b], [b, a]]) {
      const s = this.#swapBy.get(bibKey(x));
      if (!s) continue;
      throw reviewError(409, bibKey(s.other) === bibKey(y) ? `Bibs ${a} and ${b} are swapped already.`
        : `Bib ${x} is swapped with bib ${s.other} already, and a bib can be in one swap only. Remove that swap first.`);
    }
    if (this.#swapList.length >= MAX_SWAPS) throw reviewError(409, `There are ${MAX_SWAPS} swapped pairs already. Remove one you no longer need first.`);
    return { a, b, remove: false, swap: null };
  }

  #swapPlan(a, b, remove) {
    const races = [];
    const notes = [];
    let reads = 0;
    this.#ensureChecks();
    const lif = this.#lifOn();
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      const lines = [];
      let moved = 0;
      for (const [chip, other] of [[a, b], [b, a]]) {
        // who has this chip's reads now, and who gets them
        const from = this.#bibIn(state, remove ? other : chip);
        const to = remove ? chip : other;
        const list = state.reads.get(from);
        if (!list?.length) continue;
        reads += list.length;
        const d = state.bibs.get(from);
        const kept = d?.kept.filter(Boolean) ?? [];
        if (!kept.length) {
          const n = list.length === 1 ? '1 read' : `${list.length} reads`;
          lines.push(remove ? `The ${n} of bib ${chip}'s chip ${list.length === 1 ? 'goes' : 'go'} back to bib ${chip} (no split is counted from ${list.length === 1 ? 'it' : 'them'}).`
            : `The ${n} of bib ${chip} ${list.length === 1 ? 'becomes' : 'become'} bib ${to}'s (no split is counted from ${list.length === 1 ? 'it' : 'them'}).`);
          continue;
        }
        moved += kept.length;
        const one = kept.length === 1;
        lines.push(remove ? `Bib ${from}'s ${splitsText(kept)}, read as bib ${chip}, ${one ? 'goes' : 'go'} back to bib ${chip}.`
          : `Bib ${chip}'s ${splitsText(kept)} ${one ? 'becomes' : 'become'} bib ${to}'s.`);
        // whether they go out under the bib they become
        if (race.gunTicks !== null && race.active) {
          const toBib = this.#bibIn(state, to);
          const they = one ? 'It' : 'They';
          const away = this.#awayWhy(race, state, toBib);
          if (away) {
            lines.push(`${they} ${one ? 'stays' : 'stay'} off the boards: bib ${to} is not in this race (${away}).`);
          } else if (this.#offs.get(race.id)?.has(toBib)) {
            lines.push(`${they} ${one ? 'waits' : 'wait'}: bib ${to} is not sent in this race (Stop sending this runner).`);
          } else if (state.lynx.has(bibKey(to)) || d.finishRt !== null) {
            lines.push(`Bib ${to} has finished, so ${one ? 'it is' : 'they are'} not sent by ${one ? 'itself' : 'themselves'}: TrackScore keeps FinishLynx's place. ` +
              `Review lists ${one ? 'it' : 'them'} under Finished: not sent live, with Send with finish place.`);
          } else lines.push(`${they} ${one ? 'goes' : 'go'} out again under bib ${to}.`);
        }
        // what the boards have under the bib they leave, unless the other chip's reads fill those cells here
        const refill = state.reads.get(this.#bibIn(state, remove ? chip : other))?.length;
        const shown = refill ? [] : kept.filter((c) => this.#boardCopy(state, c.key));
        if (shown.length) {
          const clear = this.#outputs.filter((o) => o.clearLines === true && takes(o, race.id) && shown.some((c) => state.ledgers.get(o.id)?.has(c.key))).map((o) => o.name);
          lines.push(`The boards still show ${shown.length === 1 ? '1 split' : `${shown.length} splits`} under bib ${from} (sent before): a packet can't empty a cell.` +
            (clear.length && race.active ? ` ${listWords(clear)} ${clear.length === 1 ? 'gets' : 'get'} a clearing line.` : ''));
        }
      }
      if (moved && race.gunTicks !== null && !race.active) lines.push(`${race.name} is not Active: nothing is sent.${lif ? ' Its merged .lif file follows by itself.' : ''}`);
      else if (moved && race.gunTicks === null) lines.push(`${race.name} has no gun time yet: nothing is sent.`);
      // what was decided about either bib here stays with that bib (9.27: nothing is carried over with the reads)
      for (const [bib, other] of [[a, b], [b, a]]) {
        const x = this.#bibIn(state, bib);
        const f = this.#fixState(race.id, x);
        const count = f.pins.size + f.manuals.size + (f.off ? 1 : 0) + (f.say ? 1 : 0);
        if (!count) continue;
        const has = [f.pins.size ? (f.pins.size === 1 ? '1 changed pass' : `${f.pins.size} changed passes`) : '',
          f.manuals.size ? (f.manuals.size === 1 ? '1 typed or made-up time' : `${f.manuals.size} typed or made-up times`) : '',
          f.off ? 'Stop sending this runner' : '', f.say === 'away' ? 'Not in this race' : f.say === 'here' ? 'Count them here' : ''].filter(Boolean);
        // (the reads this bib gets: the other chip's when the swap is entered, its own when it is removed)
        const gets = state.reads.get(this.#bibIn(state, other))?.length > 0;
        lines.push(`What you changed for bib ${bib} here (${listWords(has)}) stays with bib ${bib}: ${count === 1 ? 'it is' : 'they are'} not carried over to bib ${other}.` +
          (f.manuals.size && gets ? ' A real read takes the place of a typed or made-up time of its split.' : ''));
      }
      if (lines.length) races.push({ raceId: race.id, raceName: race.name, active: race.active, lines });
    }
    if (!reads) {
      notes.push(remove ? 'Neither chip has been read: nothing changes on the boards.'
        : 'Neither bib has been read yet. The swap is ready for the reads to come: check the two numbers.');
    }
    const lead = remove ? `Every read counts for the bib it came in as again: chip ${a} for bib ${a}, chip ${b} for bib ${b}, in every race.`
      : `Bib ${a} ran with the chip of bib ${b}, and bib ${b} with the chip of bib ${a}. From now on every read of chip ${b} counts for bib ${a} ` +
        `and every read of chip ${a} for bib ${b}, in every race: the reads already in and the ones to come.`;
    return { a, b, remove, title: remove ? `Remove the swap of bibs ${a} and ${b}?` : `Swap bibs ${a} and ${b}?`, lead,
      confirm: remove ? 'Remove swap' : 'Swap bibs', races, notes };
  }

  /**
   * DESIGN 9.27, "Swapped bibs": bib `bib` ran with the chip of bib `other` (and the other way round), for the whole
   * meet. Every read of either chip, in every race, already in or still to come, counts for the other bib from now on:
   * counting, the tag filter, names, start lists, FinishLynx's finishes, the merged .lif, the packets. The journal keeps
   * each read as it came in ({ t: 'swap', a, b, at } is one record of its own), so removing the swap puts everything
   * back. What follows goes out as after any change of the operator's (#sendChange): in an Active race the splits go
   * out under the bib they are now (a finisher's wait for Send with finish place), the other runners' lines whose place
   * moved go out again, and a cell the boards have under the bib that lost it gets a clearing line where an output
   * takes one (else it still shows there: `leftover`). A race that is not Active gets its merged .lif only.
   * @param {{ bib: string, other: string }} body
   * @returns {{ swap: any, pair: string[], removed: boolean, text: string, races: any[], swaps: any[] }} pair: the two bibs
   */
  addSwap(body) {
    const { a, b } = this.#swapAsked({ ...(body && typeof body === 'object' ? body : {}), remove: false });
    const at = this.#clock.now();
    let swap = null;
    const races = this.#changeSwap(a, b, () => {
      this.#journal({ t: 'swap', a, b, at });
      swap = this.#putSwap(a, b, at);
    });
    this.#log(`[engine] bibs ${a} and ${b} are swapped: every read of chip ${a} counts for bib ${b}, every read of chip ${b} for bib ${a}`);
    this.#after();
    return { swap: this.#swapOut(swap), pair: [a, b], removed: false, text: `Bibs ${a} and ${b} are swapped.`, races, swaps: this.swaps() };
  }

  /**
   * DESIGN 9.27, "Remove swap": the swap a bib is in is taken out ({ t: 'unswap', a, b, at }): every read counts for the
   * bib it came in as again, and what follows goes out as when it was entered (addSwap).
   * @param {{ bib: string }} body either bib of the pair
   */
  removeSwap(body) {
    const { a, b, swap } = this.#swapAsked({ bib: body && typeof body === 'object' ? body.bib : body, remove: true });
    const races = this.#changeSwap(a, b, () => {
      this.#journal({ t: 'unswap', a, b, at: this.#clock.now() });
      this.#dropSwap(swap);
    });
    this.#log(`[engine] the swap of bibs ${a} and ${b} was removed: every read counts for the bib it came in as`);
    this.#after();
    return { swap: null, pair: [a, b], removed: true, text: `The swap of bibs ${a} and ${b} was removed.`, races, swaps: this.swaps() };
  }

  /**
   * 9.27: one change of the swapped pairs (`change` journals it and puts it in or takes it out), applied to the reads
   * and sent. Every read of the two chips gets the bib it counts for now; each race that holds one is worked out again
   * from its reads (as after a change of its settings: the same as a restart gives), and what the change did to the
   * two runners there goes out (#sendChange). One race at a time, so each race's lines go out as one change.
   * @returns {{ raceId: string, raceName: string, active: boolean, owners: any[], cells: any[], leftover: any[], sentTo: string[],
   *   notLive: any[], resent: any, cleared: any, lines: string[] }[]} what it did in each race, and in words
   */
  #changeSwap(a, b, change) {
    const now = this.#clock.now();
    const keys = new Set([bibKey(a), bibKey(b)]);
    /** every read of the two chips, and the spellings of the two bibs (as reads have them, and as the pair has them) */
    const recs = [];
    const forms = new Set([a, b]);
    for (const [chip, list] of this.#byBib) {
      if (!keys.has(bibKey(chip))) continue;
      forms.add(chip);
      for (const r of list) recs.push(r);
    }
    const holds = new Set();
    for (const r of recs) if (r.gone === LIVE && r.raceId && this.#states.has(r.raceId)) holds.add(r.raceId);
    // (in the order of the settings, as the panel lists the races)
    const ids = this.#races.filter((r) => holds.has(r.id)).map((r) => r.id);
    const bibs = [...forms];
    const except = new Set(bibs);
    // before: the two runners in each of those races, and what was out of date there already
    this.#ensureChecks();
    const before = new Map();
    for (const id of ids) {
      const race = this.#raceById.get(id);
      const state = this.#states.get(id);
      before.set(id, { stale: this.#staleExcept(race, state, except),
        runners: new Map(bibs.map((bib) => [bib, { kept: this.#keptSig(race, state, bib), laps: this.#lapSig(race, state, bib), cells: this.#cellTexts(race, state, bib) }])) });
    }
    change();
    for (const r of recs) this.#label(r);
    const out = [];
    for (const id of ids) {
      const race = this.#raceById.get(id);
      const state = this.#states.get(id);
      this.#collectReads(state);
      this.#rebuildRace(race, state);
      this.#restoreReleases(state);
      const was = before.get(id);
      const res = this.#sendChange(race, state, bibs, was.runners, was.stale, now);
      this.#saveSoon(state);
      const names = (set) => this.#outputs.filter((o) => set.has(o.id)).map((o) => o.name);
      // each bib of the pair here: its splits now, the splits it had, whether it has reads now (the other chip's, or its own again)
      // (and whether it is kept off the boards here: not in this race, or stopped by the operator)
      const owners = bibs.map((bib) => {
        const d = state.bibs.get(bib);
        const kept = d?.kept.filter(Boolean) ?? [];
        return { bib, splits: kept.length, had: was.runners.get(bib).cells.size, reads: (state.reads.get(bib)?.length ?? 0) > 0,
          ...(kept.some((c) => state.check?.away?.has(c.key)) ? { away: this.#whereElse(race, state, bib)?.words ?? 'you said so' } : {}),
          ...(kept.some((c) => state.check?.off?.has(c.key)) ? { off: true } : {}) };
      });
      const r = { raceId: race.id, raceName: race.name, active: race.active, owners, cells: res.cells, leftover: res.leftover, sentTo: names(res.sentTo), notLive: res.notLive,
        resent: { lines: res.resent.lines, outputs: names(res.resent.outputs) }, cleared: { lines: res.cleared.lines, outputs: names(res.cleared.outputs) } };
      out.push({ ...r, lines: swapLines(race, r, this.#lifOn()) });
    }
    // every row of the feed says which runner its read counts for now
    this.#feedAll = true;
    return out;
  }

  /**
   * 9.24: what "Stop sending this runner" would do now: from when (a time of day), in words, and the splits an output
   * has that it takes back. `at`: the race time of the pass the operator pressed it on; else the runner's first split
   * in question (the pace check's mark), else just after the runner's last pass so far.
   * @returns {{ from: number, fromText: string, after: boolean, takesBack: string[], text: string }}
   */
  #stopPlan(race, state, bib, d, at = null) {
    const gun = race.gunTicks;
    let t = at ?? state.check?.fastOf?.get(bib)?.legs[0].t ?? null;
    const first = t !== null;
    if (t === null) t = Math.max(0, ...d.passInfo.map((x) => x.t)) + 1;
    const takesBack = [];
    for (const c of d.kept) if (c && c.rt >= t && !this.#holdOf(race, state, c) && this.#boardCopy(state, c.key)) takesBack.push(race.splits[c.index].name);
    const fromText = formatRaceTime(first ? t : t - 1, 1);
    const text = first ? `Not sent from ${fromText} on${takesBack.length ? ` (${listWords(takesBack)} taken back)` : ''}` : `Not sent after ${fromText}`;
    return { from: (((gun + t) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY, fromText, after: !first, takesBack, text };
  }

  /**
   * 9.24: from when a stopped runner is not sent, in words: "from 15:36.4 on" (one of its passes: that one and what comes
   * after it), or "after 9:54.0" (a stop for what comes after its last pass then: the time of that pass).
   * @returns {{ text: string, words: string }}
   */
  #offWhen(race, d, o) {
    const t = raceTicks(o.from, race.gunTicks);
    const from = { text: formatRaceTime(t, 1), words: `from ${formatRaceTime(t, 1)} on` };
    let last = null;
    for (const x of d?.passInfo ?? []) {
      if (x.t === t) return from;
      if (x.t < t && (last === null || x.t > last)) last = x.t;
    }
    return last === null ? from : { text: formatRaceTime(last, 1), words: `after ${formatRaceTime(last, 1)}` };
  }

  /**
   * 9.24: how a runner's sending stands, for the runner editor: `off`, stopped ({ from, fromText, held: the splits that
   * wait }), else null; `stop`, what Stop sending this runner would do now (#stopPlan's words), null when it can't.
   */
  #sendingOf(race, state, bib, d) {
    const o = this.#offs.get(race.id)?.get(bib) ?? null;
    if (race.gunTicks === null || !d?.passInfo?.length) return { off: null, stop: null };
    if (o) {
      const w = this.#offWhen(race, d, o);
      const held = d.kept.filter((c) => c && state.check?.off?.has(c.key) && !this.#notSent(race, c)).map((c) => race.splits[c.index].name);
      return { off: { from: o.from, fromText: w.text, held, text: `Not sending bib ${bib}: nothing ${w.words} goes out${held.length ? ` (${listWords(held)} ${held.length === 1 ? 'waits' : 'wait'})` : ''}.` }, stop: null };
    }
    const p = this.#stopPlan(race, state, bib, d);
    return { off: null, stop: { from: p.from, fromText: p.fromText, after: p.after, takesBack: p.takesBack,
      text: p.after ? `Nothing of bib ${bib} after ${p.fromText} goes out any more. What went out stays.`
        : `Nothing of bib ${bib} from ${p.fromText} on goes out${p.takesBack.length ? `: ${listWords(p.takesBack)} ${p.takesBack.length === 1 ? 'is' : 'are'} taken back` : ''}.` } };
  }

  /**
   * DESIGN 9.23 F7, F8: the whole race as a grid, runners by splits, the runners with something to fix first. What the
   * crossings say is cached with the Review list (worked out again only when the race changed); what the scoreboards
   * have (stale, leftover, not sent live) is looked up on each call. `since`: the revision the panel has, answered with
   * { rev, unchanged: true } when nothing changed.
   * @param {string} raceId
   * @param {{ since?: string|null }} [opts]
   */
  grid(raceId, { since = null } = {}) {
    const race = this.#raceById.get(text(raceId));
    if (!race) return null;
    const state = this.#states.get(race.id) ?? this.#newState(race.id);
    this.#ensureCheck(race, state);
    const rv = race.gunTicks !== null ? this.#reviewOf(race, state) : null;
    const rev = fnv(`${state.reviewCache?.key ?? ''}|${state.version}|${state.deliveryRev}|${race.active}|${this.#outputsSig}|${state.lynxSig}`);
    if (since !== null && since !== undefined && String(since) === rev) return { rev, unchanged: true };
    const n = race.splits.length;
    // (9.26: a column that is counted, not sent, says so: the grid marks and mutes it)
    const splitsOut = race.splits.map((sp, k) => ({ id: sp.id, name: sp.name, index: k, sending: sp.sending, ...(sp.collectOnly ? { collectOnly: true } : {}), missing: 0, fillable: 0 }));
    const counts = { runners: 0, toFix: 0, check: 0, flagged: 0, missing: 0, fillable: 0, notLive: 0, old: 0, stopped: 0, pinned: 0, off: 0 };
    const base = { raceId: race.id, raceName: race.name, active: race.active, gunSet: race.gunTicks !== null, rev };
    if (race.gunTicks === null || !rv) {
      return { ...base, finishSource: 'none', finishPassStream: false, why: `${race.name} has no gun time yet.`, splits: splitsOut, counts,
        resend: { suggested: false, count: 0 }, rows: [] };
    }
    const cache = state.reviewCache;
    if (!cache.grid) cache.grid = this.#gridBase(race, state, rv);
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    // (9.23 F14: once per crossing, whatever the outputs, as the race tile counts it)
    const staleKeys = new Set();
    for (const o of outs) this.#staleCount(race, state, o, null, null, staleKeys);
    const stale = staleKeys.size;
    const rows = [];
    for (const b of cache.grid.rows) {
      const d = state.bibs.get(b.bib);
      const cells = b.cells.map((x, k) => {
        const cell = { ...x };
        const c = d?.kept[k];
        if (c) {
          if (!b.finished && !x.held) {
            const s = this.#staleAt(race, state, c);
            if (s) cell.stale = s.text;
          }
          if (b.finished && !c.manual && this.#finishedUnsent(race, state, c)) cell.notLive = true;
        } else {
          const lo = this.#leftoverAt(race, state, b.bib, k);
          if (lo) cell.leftover = `${lo.outputs[0]}: ${lo.timeText || 'a time'}`;
        }
        return cell;
      });
      const problems = [...b.problems];
      let old = false;
      let notLive = false;
      cells.forEach((cell, k) => {
        const name = race.splits[k].name;
        if (cell.stale) problems.push({ kind: 'stale', col: k, text: `${name}: ${cell.stale}` });
        if (cell.leftover) problems.push({ kind: 'leftover', col: k, text: `${name}: ${cell.leftover} still there` });
        if (cell.notLive) problems.push({ kind: 'not-live', col: k, text: `${name}: not sent live` });
        if (cell.stale || cell.leftover) old = true;
        if (cell.notLive && b.finishPlace !== null) notLive = true;
      });
      problems.sort((a, z) => (a.col ?? n) - (z.col ?? n));
      const tier = b.held ? 0 : b.flag && !b.flag.silenced ? 1 : b.fillable ? 2 : old || notLive ? 3 : b.blocked ? 4 : b.unused ? 5
        : (b.flag?.silenced || b.changed) ? 6 : b.stopped ? 7 : 8;
      for (const cell of cells) {
        if (cell.notLive) counts.notLive++;
        if (cell.stale || cell.leftover) counts.old++;
      }
      rows.push({ bib: b.bib, name: b.name, team: b.team, finished: b.finished, finishText: b.finishText, finishPlace: b.finishPlace,
        finishBy: b.finishBy, tier, stopped: b.stopped, passes: b.passes, extra: b.extra, ignored: b.ignored, changed: b.changed,
        ...(b.off ? { off: b.off } : {}), ...(b.away ? { away: b.away } : {}), ...(b.unlisted ? { unlisted: true } : {}), problems, cells: cells.map(compact) });
    }
    rows.sort((a, z) => a.tier - z.tier || a.bib.localeCompare(z.bib, undefined, { numeric: true }));
    for (const r of rows) {
      counts.runners++;
      if (r.tier <= 5) counts.toFix++;
      if (r.cells.some((c) => c.held === 'check')) counts.check++;
      if (r.problems.some((p) => p.kind === 'flag')) counts.flagged++;
      if (r.stopped) counts.stopped++;
      if (r.changed) counts.pinned++;
      if (r.off) counts.off++;
      r.cells.forEach((c, k) => {
        if (c.kind === 'missing' || c.kind === 'blocked') {
          counts.missing++;
          splitsOut[k].missing++;
        }
        if (c.kind === 'missing') {
          counts.fillable++;
          splitsOut[k].fillable++;
        }
      });
    }
    return { ...base, finishSource: cache.grid.finishSource, finishPassStream: cache.grid.stream, splits: splitsOut, counts,
      resend: { suggested: stale > 0, count: stale }, rows };
  }

  /** The race grid's rows as the crossings make them (cached with the Review list): see grid(). */
  #gridBase(race, state, rv) {
    const n = race.splits.length;
    const legs = rv.legs;
    const tods = state.clock.tods;
    const newest = tods.length ? raceTicks(tods[tods.length - 1], race.gunTicks) : null;
    // the field's median leg from each split to the next: how long is too long to have no read ("No read after 2400m")
    const medLeg = [];
    for (let k = 0; k + 1 < n; k++) {
      const legsK = [];
      for (const r of legs?.field.byCol[k] ?? []) if (Number.isFinite(r.real[k + 1]) && r.real[k + 1] > r.real[k]) legsK.push(r.real[k + 1] - r.real[k]);
      legsK.sort((a, b) => a - b);
      medLeg.push(legsK.length ? legsK[legsK.length >> 1] : null);
    }
    const bibs = new Set();
    for (const [bib, d] of state.bibs) if (d.keptCount || d.passInfo?.length) bibs.add(bib);
    for (const k of state.lynx.keys()) if (!state.bibKeys.has(k)) bibs.add(k);
    let finishReads = false;
    const rows = [];
    for (const bib of bibs) {
      const d = state.bibs.get(bib);
      if (d?.finishes.some((f) => !f.marked)) finishReads = true;
      const who = this.#who(state, bib);
      const finish = d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null;
      const finishPlace = this.#finishPlace(state, bib);
      const suspect = state.check?.suspects.get(bib) ?? null;
      const gaps = rv.gapsOf.get(bib) ?? new Map();
      // (9.23 F14: the cause of a leg that looks wrong, with its fix, instead of that leg: a made-up time that does not
      // fit, a run of missed mats neither check pointed at; 9.23 F15: the pass where the run starts, when the check or
      // the flag doubts another one, and the held passes in the words of that run, as the runner editor says them)
      const cause = rv.causes?.get(bib) ?? null;
      const fast = rv.fastFlags?.get(bib) ?? null;
      const f0 = fast ?? legs?.flags.get(bib) ?? null;
      const hint = !cause && !fast && (suspect || (f0 && !f0.silenced)) ? this.#missedHint(race, state, bib, rv) : null;
      const moved = hint?.pointed !== undefined ? hint : null;
      const flag = cause ? { col: cause.k, text: cause.text, suggest: null, silenced: false }
        : moved && !(moved.by === 'check' && this.#holdOf(race, state, d.kept[hereOf(moved)]) === 'check') ? { col: hereOf(moved), text: moved.text, suggest: null, silenced: false } : f0;
      let held = false;
      let fillable = 0;
      let blocked = 0;
      let last = -1;
      const problems = [];
      const cells = race.splits.map((sp, k) => {
        const c = d?.kept[k] ?? null;
        if (c) {
          last = k;
          const how = this.#colHowOf(d, k);
          const h = this.#holdOf(race, state, c);
          if (h === 'check') {
            held = true;
            const chk = state.check.held.get(c.key);
            problems.push({ kind: 'check', col: k, text: `${sp.name}: ${chk ? this.#heldWords(race, hint, k, chk).reason : 'check it'}` });
          }
          const cell = { t: c.rt, text: formatRaceTime(c.rt, 1), place: this.#place(state, c), kind: KIND_OF_HOW[how] ?? 'read', how, held: h };
          if (flag && (flag.col === k || flag.cols?.includes(k))) {
            cell.flag = { text: flag.text, suggest: this.#suggestOut(race, flag.suggest), silenced: flag.silenced, ...(flag.cols ? { kind: flag.kind, also: flag.passTods.filter((_, i) => flag.cols[i] !== k) } : {}) };
            if (!flag.silenced && flag.col === k) problems.push({ kind: 'flag', col: k, text: flag.text });
          }
          return cell;
        }
        // 9.26: an empty split that is not sent is missing nothing, and nothing is asked for it
        if (sp.collectOnly) return { kind: 'not-yet' };
        const e = gaps.get(k);
        const can = this.#canAdd(race, state, bib, k, { suspect, finish, finishPlace, found: true });
        if (suspect || e?.next) {
          const fb = can.ok ? this.#flagBlock(race, rv, bib, k, d) : null;
          const ok = !!e?.next && can.ok && e.estimate !== null && !fb;
          if (ok) fillable++;
          else blocked++;
          problems.push({ kind: 'missing', col: k, text: `${sp.name} missing${ok ? '' : ': it can\'t be filled yet'}` });
          return { kind: ok ? 'missing' : 'blocked', est: e?.estimate ?? null, estText: e?.estimate != null ? formatRaceTime(e.estimate, 1) : '',
            why: ok ? null : can.why ?? fb ?? e?.basis ?? null };
        }
        return { kind: 'not-yet' };
      });
      // stopped: no finish, no read at a later split for much longer than runners of the field took for that leg
      let stopped = null;
      if (finish === null && last >= 0 && last < n - 1 && newest !== null && medLeg[last] != null) {
        const t = d.kept[last].rt;
        if (newest > t + Math.max(3 * medLeg[last], 120 * TICKS_PER_SEC)) stopped = { col: last, text: `No read after ${race.splits[last].name} (${formatRaceTime(t, 1)})` };
      }
      let own = null;
      let markedRt = null;
      for (const f of d?.finishes ?? []) {
        if (own === null || f.rt < own) own = f.rt;
        if (f.marked && markedRt === null) markedRt = f.rt;
      }
      const lynx = state.lynx.get(bibKey(bib));
      const finishBy = finish === null ? null : lynx !== undefined && (own === null || lynx <= own) ? 'lynx' : markedRt !== null && own === markedRt ? 'marked' : 'mat';
      let extra = 0;
      let ignored = 0;
      let passes = 0;
      for (const cl of d?.passInfo ?? []) {
        if (cl.how === 'ignored') ignored++;
        else {
          passes++;
          if (cl.how === 'extra') extra++;
        }
      }
      const unused = (d?.manualInfo ?? []).filter((m) => m.state !== 'active').length;
      if (unused) problems.push({ kind: 'unused-manual', col: null, text: `${unused === 1 ? 'A made-up time is' : `${unused} made-up times are`} not used` });
      // 9.24: the operator stopped sending this runner: said on its row, nothing to fix
      const offRec = this.#offs.get(race.id)?.get(bib) ?? null;
      const off = offRec ? `Not sending ${this.#offWhen(race, d, offRec).words}` : null;
      // 9.25: a runner who is not in this race: said on its row, nothing to fix
      const away = d && this.#isAway(race, state, bib, d) ? `Not in this race (${this.#whereElse(race, state, bib)?.words ?? 'you said so'})` : null;
      // (on no start list while the race's is in use: a quiet note)
      const unlisted = !away && state.check?.list?.used === true && state.check.list.unlisted.has(bib) && !this.#says.get(race.id)?.has(bib);
      rows.push({ bib, name: joinName(who), team: who.team, finished: finish !== null, finishText: finish !== null ? formatRaceTime(finish, 1) : '',
        finishPlace, finishBy, stopped, passes, extra, ignored, held, flag, fillable, blocked, unused,
        changed: !!(this.#pins.get(race.id)?.has(bib) || this.#manuals.get(race.id)?.has(bib) || off || this.#says.get(race.id)?.has(bib)), off, away, unlisted, problems, cells });
    }
    return { rows, stream: legs?.field.stream ?? false, finishSource: state.lynx.size ? 'lynx' : finishReads ? 'reads' : 'none' };
  }

  /**
   * DESIGN 9.23 F1: find a runner in every race by bib ("0458" is 458) or by a part of the name or team (2 characters
   * or more, any case, accents or not), for the top bar's box. Bib matches first (the Active race first, then the race
   * with the newest read), then names A-Z; at most 20.
   * @param {string} q
   * @returns {{ q: string, matches: { raceId: string, raceName: string, active: boolean, bib: string, name: string,
   *   team: string, filled: number, splits: number, finished: boolean, problems: number, by: 'bib'|'name' }[] }}
   */
  find(q) {
    const query = text(q);
    if (!query) return { q: '', matches: [] };
    const key = bibKey(query);
    const words = fold(query);
    const byName = words.length >= 2;
    const out = [];
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      const bibs = new Set(state.reads.keys());
      for (const k of state.lynx.keys()) if (!state.bibKeys.has(k)) bibs.add(k);
      let problems = null;
      let rv = null;
      for (const bib of bibs) {
        const isBib = bibKey(bib) === key;
        const who = isBib || byName ? this.#who(state, bib) : null;
        if (!isBib && !(byName && (fold(joinName(who)).includes(words) || fold(who.team).includes(words)))) continue;
        if (!problems) {
          problems = new Map();
          if (race.gunTicks !== null) {
            rv = this.#reviewOf(race, state);
            const of = (b) => problems.get(b) ?? problems.set(b, { missing: 0, checks: [], flag: false }).get(b);
            for (const m of rv.missing) of(m.bib).missing++;
            for (const c of rv.checks) of(c.bib).checks.push(race.splitById.get(c.from)?.index ?? -1);
            for (const [b, f] of rv.legs?.flags ?? []) if (!f.silenced) of(b).flag = true;
          }
        }
        const d = state.bibs.get(bib);
        // 9.23 F13: "7 of 7 splits" of a runner a mat missed says which split it missed ("missed 800m?")
        const h = rv ? this.#missedHint(race, state, bib, rv) : null;
        const hint = this.#missedOut(race, h);
        // (9.23 F15: what the one click settles is one thing to look at: the held passes from its split on, the flag it
        // explains; the find row says "missed 2400m?" for it, and how many other things there are)
        const p = problems.get(bib);
        const count = !p ? (h ? 1 : 0) : h ? 1 + p.missing + p.checks.filter((k) => k < h.k).length : p.missing + p.checks.length + (p.flag ? 1 : 0);
        out.push({ raceId: race.id, raceName: race.name, active: race.active, bib, name: joinName(who), team: who.team,
          filled: d?.keptCount ?? 0, splits: race.splits.length, finished: this.#finished(state, bib), problems: count,
          missed: hint?.names ?? [], missedOr: hint?.alt?.names ?? [], by: isBib ? 'bib' : 'name', lastAt: state.lastReadAt ?? 0,
          // 9.27: the runner's reads came in as the other bib of a swapped pair (only then)
          ...(this.#swapBy.size && this.#swapBy.has(bibKey(bib)) && state.reads.has(bib) ? { readAs: this.#swapBy.get(bibKey(bib)).other } : {}) });
      }
    }
    out.sort((a, b) => (a.by === b.by ? 0 : a.by === 'bib' ? -1 : 1)
      || (a.by === 'bib' ? (b.active - a.active) || (b.lastAt - a.lastAt) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      || a.bib.localeCompare(b.bib, undefined, { numeric: true }) || a.raceName.localeCompare(b.raceName));
    return { q: query, matches: out.slice(0, 20).map(({ lastAt, ...m }) => m) };
  }

  /**
   * "Send with finish place" (DESIGN 9.17 P4): real splits of runners who had finished, that were not sent live
   * because a split packet would replace the finish place in TrackScore. They go out with P = the FinishLynx finish
   * place, so TrackScore keeps it. One ({ bib, splitId }), a runner's ({ bib }) or all ({ all: true }). Refused for a
   * race that is not Active unless force (TrackScore would switch to it and wipe the race it shows).
   * @param {string} raceId
   * @param {{ bib?: string, splitId?: string, all?: boolean, force?: boolean }} body
   * @returns {{ sent: number, skipped: { bib: string, splitId: string, why: string }[], outputs: number }}
   */
  sendFinished(raceId, body) {
    const { race, state } = this.#reviewRace(raceId);
    const b = body && typeof body === 'object' ? body : {};
    if (!race.active && b.force !== true) {
      throw Object.assign(new Error(`${race.name} is not active. Sending its splits would make TrackScore switch to its ` +
        'event and clear the race it is showing. Tick Active first, or choose to send anyway.'), { code: 'RACE_INACTIVE', status: 409 });
    }
    if (b.all !== true && !text(b.bib)) {
      throw reviewError(400, `Send { "bib": "254", "splitId": "..." } (one split), { "bib": "254" } (a runner's) or { "all": true }.`);
    }
    const bib = b.all === true ? null : this.#bibIn(state, b.bib);
    const splitId = b.all === true || !text(b.splitId) ? null : text(b.splitId);
    const items = this.#finishedNotSentList(race, state).filter((x) => bib === null || (x.bib === bib && (splitId === null || x.splitId === splitId)));
    if (!items.length) throw reviewError(404, 'Nothing to send: these splits went out already, or the runner is not finished. Reload the Review list.');
    const now = this.#clock.now();
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    const used = new Set();
    let sent = 0;
    const skipped = [];
    for (const x of items) {
      const c = state.kept.get(crossingKey(x.bib, x.splitId));
      if (!c || x.finishPlace === null) {
        skipped.push({ bib: x.bib, splitId: x.splitId, why: x.why || 'It is not a split any more.' });
        continue;
      }
      const place = x.finishPlace;
      const content = this.#content(race, c, place);
      if (!state.rel.has(c.key)) state.rel.set(c.key, { at: now, tod: c.tod, reason: 'new', live: { reason: 'new', tod: c.tod, place } });
      let any = false;
      for (const o of outs) {
        // revision 10: an output that has an older time of it gets the corrected one; one that has it with the split
        // place (sent after the runner finished) gets the finish place
        const led = state.ledgers.get(o.id)?.get(c.key);
        const reason = !led ? 'new' : led.tod !== content.tod || led.gun !== content.gun || led.l2g !== content.l2g || led.count !== content.count
          ? 'correction' : 'place-update';
        if (this.#send(race, state, o, c, place, reason, content, { allowFinished: true, allowInactive: b.force === true, byFinish: true })) {
          any = true;
          used.add(o.id);
        }
      }
      if (any) sent++;
      else skipped.push({ bib: x.bib, splitId: x.splitId, why: `No output took it: ${this.#noTakerWhy(race)}.` });
    }
    this.#log(`[engine] ${race.name}: ${sent} split${sent === 1 ? '' : 's'} of finished runners sent with the finish place (Review)`);
    this.#saveSoon(state);
    this.#touched.add(race.id);
    this.#after();
    return { sent, skipped, outputs: used.size };
  }

  /** The race a Review action is about, with a gun time (a made-up time is a race time). Throws in words. */
  #reviewRace(raceId) {
    const race = this.#raceById.get(text(raceId));
    if (!race) throw reviewError(404, `There is no race with id "${text(raceId)}". It may have been deleted: reload the page.`);
    const state = this.#states.get(race.id);
    if (!state) throw reviewError(404, `There is no race with id "${text(raceId)}". Reload the page.`);
    if (race.gunTicks === null) throw reviewError(409, `${race.name} has no gun time yet. Set it first: every split is a time from the gun.`);
    this.#ensureCheck(race, state);
    return { race, state };
  }

  /** A bib as the race knows it: "0458" and "458" are one runner (FinishLynx drops leading zeros). */
  #bibIn(state, v) {
    const b = text(v);
    const k = bibKey(b);
    // a runner only FinishLynx knows (no mat read it) goes by FinishLynx's spelling of the bib
    return state.bibKeys.get(k) ?? (state.lynx.has(k) ? k : b);
  }

  /**
   * The other runners' real crossings, for estimates: no made-up times (an estimate is made from what the mats saw)
   * and nothing held for a column check. Their finish: FinishLynx's, a finish read or a marked one; else, when the RR12
   * stream carries finish passes (`legs`, the look-wrong check's field: 9.23 F6), their first pass after their last
   * split. So a missed last split is placed like the runners nearest in pace with merged .lif files off too, not
   * "evenly spaced" (9.23 F13: 463's 5300m was 18 s early that way).
   * @param {{ field: any, runners: Map<string, any> } | null} [legs]
   */
  #refRunners(state, n, except = null, legs = null) {
    const out = [];
    const stream = legs?.field?.stream === true;
    for (const [bib, d] of state.bibs) {
      if (bib === except || !d.keptCount) continue;
      // (9.25: nor a runner who is not in this race: bib 221's "2 Mile" in another race's field was nobody's pace there)
      if (state.check?.suspects.has(bib) || state.check?.apart?.has(bib)) continue;
      const real = new Array(n).fill(null);
      let any = false;
      for (let k = 0; k < n; k++) {
        const c = d.kept[k];
        // (9.24: not a stopped runner's crossing: it may be no split at all)
        if (c && !c.manual && !state.check?.off?.has(c.key)) {
          real[k] = c.rt;
          any = true;
        }
      }
      if (!any) continue;
      let finish = this.#finishOf(state, bib, d);
      if (finish === null && stream) {
        const lr = legs.runners.get(bib);
        finish = lr ? legs.field.finOf(lr) : null;
      }
      out.push({ bib, real, finish });
    }
    return out;
  }

  /**
   * The relay's estimate for one empty column of one runner, or null. The runner's whole stretch is estimated, as the
   * Review list and the runner view do it (a run of missing splits together), so Send sends the time the operator saw:
   * estimating one column of a run alone uses other reference runners and gives a slightly different time.
   */
  #estimateFor(race, state, bib, k) {
    const n = race.splits.length;
    const d = state.bibs.get(bib);
    const kept = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (d?.kept[i]) kept[i] = d.kept[i].rt;
    if (kept[k] !== null) return null;
    const finish = d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null;
    // (the references as the Review list takes them, the stream's finish passes too: the time the operator saw)
    const legs = this.#reviewOf(race, state).legs;
    return estimateGaps({ n, names: race.splits.map((s) => s.name), kept, finish, others: this.#refRunners(state, n, bib, legs) })
      .find((e) => e.col === k) ?? null;
  }

  /**
   * One made-up time to add, checked (DESIGN 9.17 P5), or a reviewError in words. `shown`: the Review list's missing
   * splits by "bib|splitId" when a batch is sent, so a row without a time gets the estimate the list showed.
   * @returns {{ bib: string, k: number, rt: number, estimated: boolean, basis: string }}
   */
  #manualItem(race, state, b, shown, now, flags = null, giveWay = null) {
    // the check may have changed with the row before (a made-up time is a fixed point of the count)
    this.#ensureCheck(race, state);
    const bib = this.#bibIn(state, b.bib);
    if (!bib) throw reviewError(400, 'Say which runner: { "bib": "254", "splitId": "..." }.');
    const sp = race.splitById.get(text(b.splitId));
    if (!sp) throw reviewError(400, `${race.name} has no such split. Reload the Review list.`);
    // the column itself first (a real read there, a check to settle, a finish place to wait for): that is the reason
    // the operator needs, not "no estimate"
    const d = state.bibs.get(bib);
    const can = this.#canAdd(race, state, bib, sp.index, { suspect: state.check?.suspects.get(bib) ?? null,
      finish: d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null, finishPlace: this.#finishPlace(state, bib),
      found: !!d || state.lynx.has(bibKey(bib)) });
    if (!can.ok) throw reviewError(409, can.why);
    // 9.23: sent from an empty cell; another window may have filled it meanwhile
    const there = d?.kept[sp.index];
    if (b.ifEmpty === true && there?.manual) {
      throw reviewError(409, `Bib ${bib} has a ${there.manual.estimated ? 'made-up' : 'typed'} ${sp.name} time already (${formatRaceTime(there.rt, 1)}): another window sent it. It shows now.`);
    }
    const listed = shown?.get(`${bib}|${sp.id}`);
    const ctxEst = listed && listed.estimate !== null ? { estimate: listed.estimate, basis: listed.basis } : this.#estimateFor(race, state, bib, sp.index);
    let rt;
    const typed = text(b.time);
    const typedTod = text(b.tod);
    let todBasis = '';
    if (typedTod) {
      // 9.23 F5: a time of day ("16:36:43.6"), said as one: its race time is from the gun
      const tod = /^\d{1,2}:\d{2}:\d{2}([.,]\d{1,4})?$/.test(typedTod) ? parseTod(typedTod) : null;
      if (tod === null) throw reviewError(400, `"${typedTod}" is not a time of day. Type it like 16:36:43.6 (hours:minutes:seconds).`);
      rt = raceTicks(tod, race.gunTicks);
      if (rt <= 0) throw reviewError(409, `${formatTod(tod, 1)} is before the gun (${race.gunText}).`);
      todBasis = `Typed in Review as the time of day ${formatTod(tod, 1)}.`;
    } else if (typed) {
      rt = parseRaceTime(typed);
      if (rt === null || rt <= 0) throw reviewError(400, `"${typed}" is not a race time. Type it like 6:12.3 (minutes:seconds).`);
      if (rt >= MAX_RACE_TICKS_TYPED) {
        const mins = Math.floor(rt / (60 * TICKS_PER_SEC));
        throw reviewError(400, `"${typed}" is ${Math.floor(mins / 60)} h ${mins % 60} min of race time. If it is a time of day, send it as one. Race times look like 8:12.3.`);
      }
    } else {
      // 9.23 F6: not an estimate measured from a pass that looks wrong (a typed time is the operator's own)
      const fb = this.#flagBlock(race, flags ?? this.#reviewOf(race, state), bib, sp.index, d);
      if (fb) throw reviewError(409, fb);
      if (ctxEst?.estimate == null) throw reviewError(409, `There is no estimate for bib ${bib} at ${sp.name} yet (${ctxEst?.basis || 'it needs a later split or the finish'}). Type the time instead.`);
      rt = ctxEst.estimate;
    }
    rt = Math.round(rt / 10) * 10;
    // 9.23 F14: a time typed for a split is the operator's own: made-up times out of course order with it give way (a
    // made-up 4200m after the real 4400m typed, made up from a pass that was in the wrong split: 524 on the re-check),
    // as they do for a Move; addManual makes them up again in their new stretch when it can
    if ((typed || typedTod) && giveWay && d) {
      for (const m of d.manualInfo ?? []) {
        if (m.state !== 'active' || !m.rec?.estimated || m.k === sp.index || !((m.k < sp.index && m.rt >= rt) || (m.k > sp.index && m.rt <= rt))) continue;
        const rec = { t: 'unmanual', raceId: race.id, bib, splitId: race.splits[m.k].id, at: now };
        this.#applyFixRecord(rec);
        giveWay.push({ k: m.k, rt: m.rt, rec });
      }
      if (giveWay.length) this.#rederiveBib(race, state, bib);
    }
    const problem = this.#manualProblem(race, state, bib, sp.index, rt, now);
    if (problem) throw reviewError(409, problem);
    const estimated = ctxEst?.estimate != null && rt === ctxEst.estimate;
    const basis = estimated ? ctxEst.basis : todBasis || text(b.basis) || 'Typed in Review.';
    return { bib, k: sp.index, rt, estimated, basis };
  }

  /**
   * Why a made-up time can't go in this column, in words, or null (DESIGN 9.17 P5): the split must be empty (a real
   * read wins), the runner's column check settled, a finisher's finish place known; and the time after the runner's
   * previous split (or the start area) and before the next split or the finish (or the race clock, when there is
   * neither).
   */
  #manualProblem(race, state, bib, k, rt, now) {
    const sp = race.splits[k];
    const d = state.bibs.get(bib);
    const finish = d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null;
    const found = !!d || state.lynx.has(bibKey(bib));
    const can = this.#canAdd(race, state, bib, k, { suspect: state.check?.suspects.get(bib) ?? null, finish, finishPlace: this.#finishPlace(state, bib), found, replace: true });
    if (!can.ok) return can.why;
    let prev = null;
    let next = null;
    for (let i = k - 1; i >= 0 && !prev; i--) if (d?.kept[i]) prev = { name: race.splits[i].name, t: d.kept[i].rt };
    for (let i = k + 1; i < race.splits.length && !next; i++) if (d?.kept[i]) next = { name: race.splits[i].name, t: d.kept[i].rt };
    if (!next && finish !== null) next = { name: 'finish', t: finish };
    const t = formatRaceTime(rt, 1);
    if (prev && rt <= prev.t) return `${t} is not after bib ${bib}'s ${prev.name} (${formatRaceTime(prev.t, 1)}). A ${sp.name} time must come after it.`;
    const { startTicks, startSec } = this.#filter();
    if (!prev && rt < startTicks) return `${t} is in the start area (the first ${fmtSec(startSec)} s after the gun). A ${sp.name} time must come after it.`;
    if (next && rt >= next.t) return `${t} is not before bib ${bib}'s ${next.name} (${formatRaceTime(next.t, 1)}). A ${sp.name} time must come before it.`;
    if (!next) {
      // 9.23 F5: no later split and no finish: at most a little after the newest read of the race. The race's own reads,
      // not this PC's clock, which can be hours apart from RR12's (it was on race day, 9.21).
      void now;
      const tods = state.clock.tods;
      const latest = tods.length ? raceTicks(tods[tods.length - 1], race.gunTicks) : null;
      if (latest !== null && rt > latest + TYPED_AHEAD_TICKS) {
        return `${t} is later than anything Split Relay has seen in ${race.name} (latest read ${formatRaceTime(latest, 1)}). Type a time that has happened.`;
      }
    }
    return null;
  }

  /**
   * DESIGN 9.23 F6: why the estimate of a runner's missing split can't be sent yet, or null: it is measured from a pass
   * that looks wrong (the runner's look-wrong flag, not silenced, is at a split before it, or is the next split after
   * it). Made up from a pass that is probably another split's, it would be wrong, and it would stand in the way of the
   * Move that fixes that pass (Fill in N left 521 that way on race day). A typed time is the operator's own: allowed.
   * @param {{ legs: any }} rv the Review list's look-wrong check (#reviewOf)
   */
  #flagBlock(race, rv, bib, k, d) {
    const f = rv?.legs?.flags.get(bib);
    if (!f || f.silenced) return null;
    let next = -1;
    for (let i = k + 1; i < race.splits.length && next < 0; i++) if (d?.kept[i]) next = i;
    if (f.col > k && next !== f.col) return null;
    const t = rv.legs.runners.get(bib)?.real[f.col];
    const at = Number.isFinite(t) ? `${formatRaceTime(t, 1)} ` : '';
    const like = f.suggest ? `looks like ${f.suggest.toName}` : 'looks wrong';
    return `Check bib ${bib}'s ${race.splits[f.col].name} first: ${at}${like}. Move it, or choose It's right; then this split can be filled.`;
  }

  /**
   * 9.23 F13: whether a made-up time for column k would be measured from a pass the column check holds (the runner's
   * nearest kept crossing before k, or after it). A runner the check holds a pass of keeps its other splits fillable:
   * after a Move that settled one missed mat, with a second one still in doubt, the first need not wait for it. 9.23 F20:
   * that held crossing (truthy), for the words of the refusal; null when there is none.
   */
  #stretchHeld(state, d, k) {
    const held = state.check?.held;
    if (!held?.size || !d) return null;
    for (let i = k - 1; i >= 0; i--) {
      if (d.kept[i]) {
        if (held.has(d.kept[i].key)) return d.kept[i];
        break;
      }
    }
    for (let i = k + 1; i < d.kept.length; i++) if (d.kept[i]) return held.has(d.kept[i].key) ? d.kept[i] : null;
    return null;
  }

  /**
   * Whether the operator can send a made-up time for this column, and if not why (for the runner view's buttons).
   * `replace`: a made-up time already there may be replaced by a new one.
   */
  #canAdd(race, state, bib, k, { suspect, finish, finishPlace, found, replace = true }) {
    const sp = race.splits[k];
    const c = state.bibs.get(bib)?.kept[k];
    if (!found) return { ok: false, why: `Bib ${bib} has no reads in ${race.name} and no FinishLynx finish.` };
    if (race.gunTicks === null) return { ok: false, why: `${race.name} has no gun time yet.` };
    if (c && !c.manual) return { ok: false, why: `Bib ${bib} has a real ${sp.name} time (${formatRaceTime(c.rt, 1)}) from the mats.` };
    if (c?.manual && !replace) return { ok: false, why: `Bib ${bib} has a made-up ${sp.name} time already.` };
    // (9.23 F13: only a split measured from a pass in doubt; another split of the runner can be filled)
    // (9.23 F20: the held pass by its time and split, and the two ways on: the re-check of 2026-10-30 found a late starter's
    // typed 4400m refused twice with "a pass of this runner looks like another split's", its good 4200m pass held)
    const at = suspect ? this.#stretchHeld(state, state.bibs.get(bib), k) : null;
    if (at) {
      const h = state.check.held.get(at.key);
      const t = formatRaceTime(at.rt, 1);
      const where = race.splits[at.index].name;
      const to = h?.move ? (h.move.to < race.splits.length ? race.splits[h.move.to].name : 'the finish') : '';
      return { ok: false, why: `Check bib ${bib}'s ${where} first: ${t} is held${to ? ` (it looks like ${to})` : ''}. Choose "It's right: keep it in ${where}" or Move it in its menu; then ${sp.name} can be filled.` };
    }
    if (finish !== null && finishPlace === null) return { ok: false, why: noPlaceText(bib, this.#markedFinish(race, state, bib, k)) };
    return { ok: true, why: null };
  }

  /**
   * 9.23 F18: the runner's finish when it is a pass the operator marked ("This is the finish") and no other finish is
   * known (FinishLynx's, a finish mat's): its time and the race's last split, for noPlaceText's way out. Null otherwise.
   */
  #markedFinish(race, state, bib, k = -1) {
    const d = state.bibs.get(bib);
    const cl = d?.passInfo?.find((x) => x.how === 'finish') ?? null;
    if (!cl || this.#finishWithout(state, bib, d, cl) !== null) return null;
    return { timeText: formatRaceTime(cl.t, 1), last: race.splits[race.splits.length - 1].name, here: k === race.splits.length - 1 };
  }

  /**
   * One pass of a runner for the runner view: when it was, which split it is, and how it got there (counting, an
   * earliest time, the operator), or why it does not count.
   */
  #passView(race, state, bib, cl) {
    const first = cl.items[0];
    const o = this.#outcome(state, first.r);
    const sp = cl.col !== null ? race.splits[cl.col] : null;
    const c = sp ? state.kept.get(crossingKey(bib, sp.id)) : null;
    const counts = !!c && c.reads.includes(first.r);
    const h = counts ? state.check?.held.get(c.key) : null;
    // 9.23: the operator's decision on it, whatever it is (a pin whose split is gone is none)
    const pinned = cl.pin ? cl.pin.as : null;
    let how = cl.how || o?.kind || '';
    if (sp && !counts && o?.kind) how = o.kind; // after the finish, out of course order
    return {
      tod: cl.tod, todText: formatTod(cl.tod, 3), raceTicks: cl.t, timeText: formatRaceTime(cl.t, 1), reads: cl.items.length,
      splitId: counts ? sp.id : null, splitName: counts ? sp.name : '', how, howText: howText(how, sp?.name), pinned,
      suggestion: h ? { splitId: h.to, splitName: h.to === null ? 'the finish' : race.splits.find((x) => x.id === h.to)?.name ?? '', reason: h.text } : null,
      // 9.27: the bib the pass came in as, while it counts for the other bib of a swapped pair (only then)
      ...(first.r.chip !== first.r.bib ? { readAs: first.r.chip } : {}),
    };
  }

  /** The Review list of a race, worked out again only when its crossings (or pauses) changed. */
  #reviewOf(race, state) {
    this.#ensureCheck(race, state);
    const key = `${state.version}|${race.sendSig}|${race.splits.map((s) => s.id).join(',')}|${race.gunTicks}`;
    if (state.reviewCache?.key === key) return state.reviewCache.value;
    const n = race.splits.length;
    const names = race.splits.map((s) => s.name);
    const missing = [];
    const checks = [];
    /** 9.23: bib -> column -> its estimate (GapEstimate), for the runner editor and the race grid */
    const gapsOf = new Map();
    // 9.23 F6: the look-wrong check first: a missing split measured from a pass that looks wrong waits for it
    const legs = race.gunTicks !== null && n > 1 ? this.#legsOf(race, state) : null;
    if (race.gunTicks !== null && n > 0) {
      const others = this.#refRunners(state, n, null, legs);
      const bibs = new Set(state.bibs.keys());
      // FinishLynx finishers that no mat read at all: every split is missing
      for (const k of state.lynx.keys()) if (!state.bibKeys.has(k)) bibs.add(k);
      for (const bib of bibs) {
        // (9.25: a runner who is not in this race is missing no split of it)
        if (state.check?.apart?.has(bib)) continue;
        const d = state.bibs.get(bib);
        const suspect = state.check?.suspects.has(bib) ?? false;
        const finish = d ? this.#finishOf(state, bib, d) : state.lynx.get(bibKey(bib)) ?? null;
        const kept = new Array(n).fill(null);
        let last = -1;
        for (let k = 0; k < n; k++) {
          if (!d?.kept[k]) continue;
          kept[k] = d.kept[k].rt;
          last = k;
        }
        if (finish === null && last < 1) continue; // nothing later than an empty column
        // (a runner is never its own reference: it has no real crossing in a column it is missing)
        const gaps = estimateGaps({ n, names, kept, finish, others });
        gapsOf.set(bib, new Map(gaps.map((e) => [e.col, e])));
        const who = this.#who(state, bib);
        const finishPlace = this.#finishPlace(state, bib);
        for (const e of gaps) {
          if (!e.next) continue; // still on the course: not missing yet
          // 9.26: a split that is counted but not sent is in no scoreboard's column: an empty one is not asked for
          // (the missed-mat one click still fills it when the runner's later passes must move on: #missedHint)
          if (race.splits[e.col].collectOnly) continue;
          // 9.23 F13: a runner the column check holds a pass of: only the splits not measured from a pass in doubt
          if (suspect && this.#stretchHeld(state, d, e.col)) continue;
          const can = this.#canAdd(race, state, bib, e.col, { suspect: null, finish, finishPlace, found: true });
          const fb = can.ok ? this.#flagBlock(race, { legs }, bib, e.col, d) : null;
          const ref = (r) => (r.kind === 'split' ? { kind: r.kind, splitId: race.splits[r.col].id, splitName: names[r.col], raceTicks: r.t }
            : { kind: r.kind, splitId: null, splitName: r.kind === 'gun' ? 'Gun' : 'Finish', raceTicks: r.t });
          missing.push({
            bib, name: joinName(who), team: who.team, splitId: race.splits[e.col].id, splitName: names[e.col], index: e.col,
            estimate: e.estimate, estimateText: e.estimate !== null ? formatRaceTime(e.estimate, 3) : '', basis: e.basis,
            prev: ref(e.prev), next: ref(e.next), finished: finish !== null, finishPlace,
            sendable: can.ok && !fb && e.estimate !== null, why: !can.ok ? can.why : fb ?? (e.estimate === null ? e.basis : null),
          });
        }
      }
      for (const [key, h] of state.check?.held ?? []) {
        const c = state.kept.get(key);
        // (9.24: a stopped runner's pass has no question open: nothing of it goes out either way)
        if (!c || state.check.off.has(key)) continue;
        const who = this.#who(state, h.bib);
        checks.push({
          bib: h.bib, name: joinName(who), team: who.team, passTod: c.tod, passTodText: formatTod(c.tod, 3), raceTicks: c.rt,
          timeText: formatRaceTime(c.rt, 1), from: h.from, fromName: names[h.move.from], to: h.to, toName: names[h.move.to] ?? 'the finish',
          // lone: the runner's only pass so far (revision 10): their next pass settles it by itself
          reason: h.text, method: h.method, lone: h.lone === true, delivered: false,
        });
      }
    }
    const byBib = (a, b) => a.localeCompare(b, undefined, { numeric: true });
    const byBibSplit = (a, b) => byBib(a.bib, b.bib) || (a.index ?? 0) - (b.index ?? 0);
    missing.sort(byBibSplit);
    checks.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }) || a.raceTicks - b.raceTicks);
    let manual = 0;
    for (const bySplit of this.#manuals.get(race.id)?.values() ?? []) {
      for (const m of bySplit.values()) {
        const sp = race.splitById.get(m.splitId);
        if (sp && state.bibs.get(m.bib)?.kept[sp.index]?.manual === m) manual++;
      }
    }
    // 9.23 F14: the real cause of what looks wrong where neither check points at a missed split, with its fix: a made-up
    // time the runner's later passes do not fit (an earlier fix with too few splits), or passes a run of missed mats put
    // columns early (the first two missed: the column check places a pass one column on at most, and the look-wrong
    // check sees a short leg only). Listed with the splits that look wrong, instead of the leg they make look wrong
    const causes = new Map();
    if (legs) {
      for (const [bib, d] of state.bibs) {
        if (!d.keptCount || state.check?.suspects.has(bib) || state.check?.apart?.has(bib)) continue;
        const f = legs.flags.get(bib);
        // (a flag that points at a later split or the finish has its own fix: #missedHint)
        if (f && !f.silenced && f.suggest && f.suggest.to !== 'none' && (f.suggest.to === 'finish' || f.suggest.to > f.col)) continue;
        let h = d.manualInfo?.some((m) => m.state === 'active' && m.rec?.estimated) ? this.#madeUpHint(race, state, bib, legs) : null;
        if (!h && f && !f.silenced) h = this.#countHint(race, state, bib, legs, f);
        // 9.23 F17: no leg looks wrong, but the runner's first pass is far past the back of the field at its split (221,
        // 800m, 1500m and 4200m missed: its 2400m pass, 8:49.0, in 800m, where every other runner was by 3:08; the column
        // check places a pass one split further at most, and with 4200m missed no leg is short: the 200 m to 4400m was
        // what showed 800m and 1500m missed alone). Its fix as for a flag, from the fit of all of its passes
        if (!h && !f) {
          const c0 = this.#farBehind(race, state, bib, legs);
          if (c0 !== null) h = this.#countHint(race, state, bib, legs, { col: c0 });
        }
        // (9.23 F19: the one click only on evidence a late start or a slow leg can't give, as every hint)
        if (h) causes.set(bib, this.#settled(race, state, bib, { legs }, h));
      }
    }
    // 9.24: the runners with a split too fast to be real (the pace check, worked out as the read came in: #recheck). One row
    // per runner that covers all of them (`cols`), so one Not a split takes them all back. A missed-mat cause listed for
    // the runner, or its look-wrong flag at that split or an earlier one, comes first, in its own words and with its own
    // fixes (a stray pass, a missed mat): the mark is for what those rules say nothing about, and it then stands for a
    // flag at a later split (measured from a pass that is no split).
    const fastFlags = new Map();
    for (const [bib, f] of state.check?.fastOf ?? []) {
      const d = state.bibs.get(bib);
      const f0 = legs?.flags.get(bib) ?? null;
      if (!d || causes.has(bib) || (f0 && !f0.silenced && f0.col <= f.legs[0].col)) continue;
      const first = f.legs[0];
      fastFlags.set(bib, { col: first.col, cols: f.legs.map((x) => x.col), from: first.from, kind: 'fast', ratio: first.ratio, leg: first.leg, silenced: false, kept: false,
        suggest: first.after === null ? { to: 'none', toName: 'Not a split', missed: [] } : null,
        passTod: d.kept[first.col].tod, passTods: f.legs.map((x) => d.kept[x.col].tod), text: f.text });
    }
    // (the runners the Dashboard's Needs attention names: those rows, and a stray's row about the very split the pace check
    // marks: "8:10.4 comes soon after 1 Mile … A stray pass?" is too fast to be real as well)
    const fastBibs = new Set(fastFlags.keys());
    for (const [bib, f] of state.check?.fastOf ?? []) {
      const f0 = legs?.flags.get(bib) ?? null;
      if (!causes.has(bib) && f0 && !f0.silenced && f0.kind === 'short' && f0.col === f.legs[0].col) fastBibs.add(bib);
    }
    const listed = new Set([...causes.keys(), ...fastFlags.keys()]);
    for (const [bib, f] of legs?.flags ?? []) if (!f.silenced) listed.add(bib);
    const flagged = listed.size;
    let pinned = 0;
    for (const bib of this.#pins.get(race.id)?.keys() ?? []) if (state.bibs.has(bib)) pinned++;
    const value = {
      missing, checks, gapsOf, legs, causes, fastFlags,
      // (9.25: for the counts that leave the runners of another race out: #reviewCounts)
      listed, fastAll: [...fastBibs].sort(byBib),
      counts: {
        missing: missing.length, estimable: missing.filter((m) => m.sendable).length, checks: checks.length,
        checkRunners: state.check?.suspects.size ?? 0, manual,
        // 9.23: runners with a split that looks wrong (advice), runners with the operator's decisions, made-up times
        flagged, pinned, madeUp: manual,
        // 9.24: of those, the runners with a split too fast to be real (Needs attention names the first few); only then
        ...(fastBibs.size ? { fast: fastBibs.size, fastBibs: [...fastBibs].sort(byBib).slice(0, 4) } : {}),
      },
    };
    state.reviewCache = { key, value };
    return value;
  }

  /**
   * RaceView.review: the Review panel's counts, for the race card's badge ("3 missing splits · 1 to check"). 9.25: with
   * what the start lists and the day's other races say, worked out now, each only when there is any: `strange`, the
   * runners who are probably not in this race and are sent all the same (with the first few bibs and the first one's
   * words; they are not counted as a split that looks wrong or too fast as well); `away`, the runners kept off the
   * boards; `unlisted`, the ones on no start list.
   */
  #reviewCounts(race, state, strangers = this.#strangersOf(race, state)) {
    const r = this.#reviewOf(race, state);
    const counts = { ...r.counts };
    if (strangers.size) {
      for (const bib of strangers.keys()) if (r.listed.has(bib)) counts.flagged--;
      const fast = r.fastAll.filter((b) => !strangers.has(b));
      delete counts.fast;
      delete counts.fastBibs;
      if (fast.length) Object.assign(counts, { fast: fast.length, fastBibs: fast.slice(0, 4) });
      const bibs = [...strangers.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      Object.assign(counts, { strange: bibs.length, strangeBibs: bibs.slice(0, 4), strangeText: strangers.get(bibs[0]).text });
    }
    const away = new Set(state.check?.away?.values() ?? []).size;
    if (away) counts.away = away;
    const unlisted = this.#unlistedBibs(race, state, strangers).length;
    if (unlisted) counts.unlisted = unlisted;
    return counts;
  }

  /**
   * DESIGN 9.23 F6: the race's runners as the look-wrong check takes them (src/review.js legFlags), its field, and the
   * flags (bib -> LegFlag, with the time of day of the flagged pass). Part of the Review list's cache: never worked out
   * while a read comes in.
   */
  #legsOf(race, state) {
    const n = race.splits.length;
    const names = race.splits.map((s) => s.name);
    const runners = new Map();
    for (const [bib, d] of state.bibs) {
      if (!d.keptCount) continue;
      // (9.25: a runner who is not in this race is looked at no more than a suspect: no reference, no flag)
      const suspect = (state.check?.suspects.has(bib) ?? false) || (state.check?.apart?.has(bib) ?? false);
      const kept = new Array(n).fill(null);
      const real = new Array(n).fill(null);
      const look = new Array(n).fill(null);
      let located = false;
      for (let k = 0; k < n; k++) {
        const c = d.kept[k];
        if (!c) continue;
        kept[k] = c.rt;
        if (c.manual) continue;
        // (a suspect's passes may be in the wrong columns: no reference for others, as for estimates; 9.24: nor a
        // stopped runner's crossing, which is looked at no more)
        if (!suspect && !state.check?.off?.has(c.key)) real[k] = c.rt;
        if (c.reads.some((r) => r.locKey !== '')) located = true;
      }
      const passes = [];
      const tods = new Array(n).fill(null);
      for (const cl of d.passInfo ?? []) {
        if (cl.how === 'ignored') continue;
        passes.push(cl.t);
        const w = this.#whereOf(state, d, cl);
        if (typeof w !== 'number') continue;
        tods[w] = cl.tod;
        const counted = cl.how === 'counted' || cl.how === 'earliest' || cl.how === 'shifted';
        // looked at: counted by Split Relay, or kept from the check queue (not yet said to be right in the editor);
        // 9.23 F15: or moved by the operator: a time typed before it later can make its leg look wrong (the re-check's
        // R2b: 544's real 5300m moved to 4400m, then its real 4200m typed, a 3:49 leg for 200 m). Not measured from a
        // made-up time: that one is made up from the stretch to it (a made-up time that does not fit is the cause, 9.23 F14)
        if (suspect || located || !real[w]) continue;
        if (counted) look[w] = 'counted';
        else if (cl.how === 'kept') look[w] = cl.pin?.seen ? 'seen' : 'kept';
        else if (cl.how === 'moved') {
          let p = w - 1;
          while (p >= 0 && !d.kept[p]) p--;
          if (!d.kept[p]?.manual?.estimated) look[w] = cl.pin?.seen ? 'seen' : 'moved';
        }
      }
      const finish = this.#finishOf(state, bib, d);
      runners.set(bib, { bib, kept, real, look, passes, tods, finish });
    }
    const field = legField({ n, runners: [...runners.values()], near: FINISH_NEAR_TICKS });
    const flags = new Map();
    for (const r of runners.values()) {
      const f = legFlagOf(field, r, names);
      if (f) flags.set(r.bib, { ...f, passTod: r.tods[f.col] });
    }
    return { runners, field, flags, names };
  }

  /**
   * Real splits of finished runners that no output has as they are now, and whether "Send with finish place" can send
   * them. Revision 10: a split sent before it was corrected (a Move in Review, a backup read, a gun change) counts as
   * not sent: TrackScore shows the old time (`sentOld`), and only a packet with the finish place can correct it.
   */
  #finishedNotSentList(race, state) {
    const out = [];
    for (const split of race.splits) {
      for (const c of state.ranks.get(split.id) ?? []) {
        if (c.manual || !this.#finished(state, c.bib) || this.#holdOf(race, state, c)) continue;
        const sent = this.#sentAs(race, state, c);
        // the place rule: sent as it is now, but after the runner finished, with the split place
        const after = sent.now ? this.#sentAfterFinish(race, state, c) : null;
        if (sent.now && after === null) continue;
        const who = this.#who(state, c.bib);
        const fp = this.#finishPlace(state, c.bib);
        const oldText = this.#oldText(sent.old);
        out.push({
          bib: c.bib, name: joinName(who), team: who.team, splitId: split.id, splitName: split.name, raceTicks: c.rt,
          timeText: formatRaceTime(c.rt, 1), finishPlace: fp, sendable: fp !== null,
          sentOld: sent.old ? { raceTicks: raceTicks(sent.old.tod, sent.old.gun), timeText: oldText } : null,
          sentAfter: after !== null ? { place: after } : null,
          note: sent.old ? sentOldText(split.name, oldText, formatRaceTime(c.rt, 1)) : after !== null ? sentAfterText(after, fp) : null,
          // (9.23 F18: a finisher's splits go out with the finish place; TrackScore no longer takes a split's as its own)
          why: fp !== null ? null : "Split Relay doesn't know this runner's finish place (it comes from FinishLynx's .lif file), " +
            "and a finisher's splits go out with it.",
        });
      }
    }
    return out;
  }

  /** Every made-up time of a race and what became of it. */
  #manualList(race, state) {
    const out = [];
    for (const [bib, bySplit] of this.#manuals.get(race.id) ?? []) {
      for (const m of bySplit.values()) {
        if (!race.splitById.has(m.splitId)) continue;
        out.push(this.#manualView(race, state, m, bib));
      }
    }
    return out.sort((a, b) => a.bib.localeCompare(b.bib, undefined, { numeric: true }) || a.index - b.index);
  }

  /**
   * A made-up time as the panel shows it: state 'active' (it is the runner's split), 'replaced' (a real read of the
   * split took its place), 'after-finish' / 'out-of-order' / 'before-gun' / 'conflict' (it no longer fits), and
   * whether an output took it.
   * @returns {ManualView}
   */
  #manualView(race, state, m, bib = m.bib) {
    const sp = race.splitById.get(m.splitId);
    const d = state.bibs.get(bib);
    const info = d?.manualInfo?.find((x) => x.rec === m);
    const c = d?.kept[sp.index];
    const active = !!c && c.manual === m;
    const who = this.#who(state, bib);
    const rt = info?.rt ?? m.raceTicks;
    const fp = this.#finishPlace(state, bib);
    const sent = active && this.#madeUpSent(race, state, c);
    // 9.23 F14: the place it went out with (an output's copy of this time): other runners' times may have moved it since
    const copy = sent ? this.#boardCopy(state, c.key) : null;
    const at = copy ? copy.tods.indexOf(c.tod) : -1;
    return {
      bib, name: joinName(who), team: who.team, splitId: sp.id, splitName: sp.name, index: sp.index, raceTicks: rt,
      timeText: formatRaceTime(rt, 1), estimated: m.estimated, source: m.estimated ? 'made-up' : 'typed', basis: m.basis,
      // sent: an output has this made-up time (not just an older real time of the split in that cell)
      at: m.at, state: active ? 'active' : info?.state ?? 'replaced', sent,
      place: active ? (this.#finished(state, bib) && fp !== null ? fp : this.#place(state, c)) : null,
      sentPlace: at >= 0 ? copy.places[at] ?? null : null,
      withFinishPlace: active && this.#finished(state, bib) && fp !== null,
      // 9.26: a time in a split that is counted but not sent: it holds the runner's columns, and never goes out
      ...(sp.collectOnly ? { collectOnly: true } : {}),
    };
  }

  /** A feed row for a made-up time the operator sent (not a read: it is never updated). */
  #manualFeed(race, state, v, now) {
    const c = state.kept.get(crossingKey(v.bib, v.splitId));
    const entry = this.#entryFor({ location: '', bib: v.bib, tod: c?.tod ?? null, port: null }, now);
    const what = v.source === 'made-up' ? 'Made-up time' : 'Typed time';
    const where = v.withFinishPlace ? ` with the finish place (${v.place}), so TrackScore keeps it` : v.place ? ` as place ${v.place}` : '';
    const paused = !!c && this.#holdOf(race, state, c) === 'paused';
    // 9.26: a time in a split that is counted but not sent holds the runner's columns: it goes nowhere
    const quiet = v.collectOnly === true && v.state === 'active';
    const sent = v.sent ? `Sent${where}` : v.state !== 'active' ? 'Not used'
      : quiet ? `${v.splitName} is counted, not sent: the time keeps the runner's later passes in their splits and goes to no scoreboard`
        : paused ? `${v.splitName} is paused: it goes out when you press play on ${v.splitName}`
          : !race.active ? `${race.name} is not Active: it goes out when it is` : 'Goes out as soon as an output can take it';
    Object.assign(entry, { raceId: race.id, raceName: race.name, splitName: v.splitName, name: v.name, team: v.team,
      raceTicks: v.raceTicks, place: v.place, status: v.source,
      // (9.23: a time that is not used is not in the .lif either; 9.23 F13: nor while merged .lif files are off)
      detail: `${what}, approved in Review: ${sent}.${paused || quiet || v.state !== 'active' || !this.#lifOn() ? '' : ' It is in the merged .lif.'} ${v.basis}`.trim() });
    this.#publish(entry);
  }

  /** Whether merged .lif files are written (Settings): only then does a feed row say a time is in one (9.23 F13). */
  #lifOn() {
    try {
      return this.#getConfig()?.lif?.enabled === true;
    } catch {
      return false;
    }
  }

  /**
   * Why a pass can't be moved to column k, or null: the runner's other fixed points (passes moved, made-up times)
   * keep their course order, and the passes counted before it need splits before k. `giveWay` (the runner editor's
   * Move, 9.23): made-up and typed times out of order with it are not a reason: the Move takes them out (#giveWay).
   * `stray` (9.23 F21, #strayFlagged): the earlier pass the look-wrong check takes for a stray, named as the way on (the
   * re-check's 577, its real 3100m pass refused eight times: "4 earlier passes need the splits before it", its stray
   * 9:53.7 among them, unnamed).
   */
  #moveProblem(race, d, cl, k, { giveWay = false, stray = null } = {}) {
    const sp = race.splits[k];
    const at = formatRaceTime(cl.t, 1);
    for (const x of d.passInfo) {
      // 9.23: a pass kept in its split by "Move only this time" is as fixed as a moved one
      if (x === cl || (x.how !== 'moved' && x.how !== 'replaces' && x.how !== 'hold')) continue;
      if (x.t < cl.t && x.col >= k) return `The pass at ${at} can't be ${sp.name}: an earlier pass (${formatRaceTime(x.t, 1)}) is ${race.splits[x.col].name}, set in Review.`;
      if (x.t > cl.t && x.col <= k) return `The pass at ${at} can't be ${sp.name}: a later pass (${formatRaceTime(x.t, 1)}) is ${race.splits[x.col].name}, set in Review.`;
    }
    for (const m of giveWay ? [] : d.manualInfo ?? []) {
      // a made-up time in the split itself gives way: the Move replaces it (9.23, in the same change)
      if (m.state !== 'active' || m.k === k) continue;
      const name = race.splits[m.k].name;
      if (m.rt < cl.t && m.k >= k) return `The pass at ${at} can't be ${sp.name}: the made-up ${name} time (${formatRaceTime(m.rt, 1)}) comes before it.`;
      if (m.rt > cl.t && m.k <= k) return `The pass at ${at} can't be ${sp.name}: the made-up ${name} time (${formatRaceTime(m.rt, 1)}) comes after it.`;
    }
    const before = d.passInfo.filter((x) => x !== cl && x.t < cl.t && x.col !== null).length;
    // (9.23 F18: one pass, one split: "1 earlier pass needs a split before it", not "1 earlier passes need the splits")
    if (before > k) {
      const way = stray && stray !== cl && stray.t < cl.t && stray.col !== null
        ? ` If ${formatRaceTime(stray.t, 1)} is a stray pass (it came soon after the pass before it), choose Not a split for it first.` : '';
      return `The pass at ${at} can't be ${sp.name}: ${before === 1 ? '1 earlier pass needs a split' : `${before} earlier passes need the splits`} before it.${way}`;
    }
    return null;
  }

  /**
   * 9.23 F21: the runner's pass the look-wrong check takes for a stray pass (its "comes soon after" flag, not silenced),
   * for the words of a Move it is in the way of (#moveProblem `stray`), or null.
   */
  #strayFlagged(race, state, bib, d, rv) {
    const f = rv?.legs?.flags.get(bib);
    return f?.kind === 'short' && !f.silenced ? d?.passInfo?.find((x) => x.tod === f.passTod || x.items.some((i) => i.r.tod === f.passTod)) ?? null : null;
  }

  /**
   * The runner's made-up and typed times that give way to a Move of `cl` to column k (9.23 F2): the one in k itself, and
   * those out of course order with it (earlier in time but in k or a later split, later in time but in k or an earlier
   * split).
   */
  #giveWay(d, cl, k) {
    return (d.manualInfo ?? []).filter((m) => m.state === 'active' && (m.k === k || (m.rt < cl.t && m.k >= k) || (m.rt > cl.t && m.k <= k)));
  }

  // ---- Fix a runner (DESIGN 9.23) ----------------------------------------------------------------------------------

  /**
   * Where a pass is now: its column (a number) when it counts there, else 'finish' (marked), 'ignored' (Not a split),
   * 'extra', 'too-early', 'after-finish', 'out-of-order' or 'repeat'.
   */
  #whereOf(state, d, cl) {
    if (cl.how === 'finish' || cl.how === 'ignored') return cl.how;
    if (cl.col !== null) {
      const c = d.kept[cl.col];
      if (c && c.reads.includes(cl.items[0].r)) return cl.col;
      const o = this.#outcome(state, cl.items[0].r);
      return o?.kind === 'out-of-order' || o?.kind === 'after-finish' ? o.kind : 'repeat';
    }
    return cl.how === 'too-early' ? 'too-early' : 'extra';
  }

  /** Where each of a runner's passes is now, by the time of day of its first read. */
  #wheres(state, d) {
    const m = new Map();
    for (const cl of d?.passInfo ?? []) m.set(cl.tod, this.#whereOf(state, d, cl));
    return m;
  }

  /** The runner's finish without the pass `cl` (when it is the one marked as the finish): what a Move of it is judged by. */
  #finishWithout(state, bib, d, cl) {
    let own = null;
    for (const f of d.finishes) if (!(f.marked && cl.items.some((x) => x.r === f.r)) && (own === null || f.rt < own)) own = f.rt;
    const lynx = state.lynx.get(bibKey(bib));
    return own === null ? lynx ?? null : lynx === undefined ? own : Math.min(own, lynx);
  }

  /**
   * DESIGN 9.23 F2, the rules of a change to one pass, checked before anything changes: why it can't be done (in
   * words, with the HTTP status), or the journal records that do it and what must hold once it is done. Every read of
   * the pass with a decision on it is forgotten first, so no older decision on another of its reads can win later; the
   * new one goes on its first read. The runner editor asks the same rules for every split (RunnerView targets).
   * @param {string} to a split id, 'none', 'finish', 'count' or 'keep'
   * @param {boolean} only a Move of this pass alone: the runner's other placed passes are held where they are
   * @param {{ stray?: any }} [opts] stray: the pass a refusal names as the way on (#moveProblem)
   * @returns {{ status: number, why: string } | { why: null, recs: any[], kind: string, expect: any }}
   */
  #moveRules(race, state, bib, d, cl, to, only = false, { stray = null } = {}) {
    const at = formatRaceTime(cl.t, 1);
    const no = (why, status = 409) => ({ status, why });
    const pins = this.#pins.get(race.id)?.get(bib);
    const todsOf = (x) => [...new Set(x.items.map((i) => i.r.tod))].filter((t) => pins?.has(t));
    const base = { raceId: race.id, bib };
    const recs = [];
    const unpin = (x, except) => {
      for (const t of todsOf(x)) if (t !== except) recs.push({ t: 'unassign', ...base, tod: t });
    };
    const pinAt = (tod, pin) => recs.push({ t: 'assign', ...base, tod, ...pinFields(pin) });
    const where = this.#whereOf(state, d, cl);
    /** the made-up and typed times the change takes out (a Move onto one, or out of order with it) */
    let drops = [];
    const done = (kind, expect) => ({ why: null, recs, kind, expect, drops });
    if (to === 'count') {
      if (!todsOf(cl).length) return no(`Nothing is set in Review for the pass at ${at}. Reload the runner.`, 404);
      unpin(cl, null);
      return done('count', { pin: null });
    }
    if (to === 'keep' || to === 'none') {
      // (9.23 F15: It's right on a pass the operator moved keeps the Move, said to be right: its flag is silenced)
      const moved = to === 'keep' && cl.pin?.as === 'move' && typeof where === 'number' && race.splits[where]?.id === cl.pin.split;
      const pin = moved ? { split: cl.pin.split, as: 'move', seen: true } : to === 'keep' ? { split: null, as: 'keep', seen: true } : { split: null, as: 'none', seen: false };
      if (samePin(cl.pin, pin)) return no(to === 'keep' ? `${at} stays in ${whereWord(where, race.splits)} already.` : `${at} is not a split already.`);
      unpin(cl, cl.tod);
      pinAt(cl.tod, pin);
      return done(to, to === 'keep' ? { pin: pin.as } : { how: 'ignored' });
    }
    if (to === 'finish') {
      if (cl.how === 'finish') return no(`${at} is the finish already.`);
      const m = (d.manualInfo ?? []).find((x) => x.state === 'active' && x.rt > cl.t);
      if (m) return no(`${at} can't be the finish: the ${m.rec.estimated ? 'made-up' : 'typed'} ${race.splits[m.k].name} time (${formatRaceTime(m.rt, 1)}) comes after it. Remove that first.`);
      const later = d.passInfo.find((x) => x !== cl && x.t > cl.t && (x.how === 'moved' || x.how === 'hold') && x.col !== null);
      if (later) return no(`${at} can't be the finish: ${formatRaceTime(later.t, 1)} comes after it and you set it to ${race.splits[later.col].name} in Review.`);
      const mat = d.finishes.filter((f) => !f.marked);
      if (mat.length) return no(`Bib ${bib} has a finish read from the finish mat (${formatRaceTime(Math.min(...mat.map((f) => f.rt)), 1)}).`);
      const lynx = state.lynx.get(bibKey(bib));
      if (lynx !== undefined && Math.abs(lynx - cl.t) > FINISH_NEAR_TICKS) {
        return no(`FinishLynx has bib ${bib}'s finish at ${formatRaceTime(lynx, 1)}, so ${at} can't be the finish. Choose Not a split instead.`);
      }
      // a runner has one marked finish: the pass marked before is a pass again
      for (const x of d.passInfo) if (x !== cl && x.pin?.as === 'finish') unpin(x, null);
      unpin(cl, cl.tod);
      pinAt(cl.tod, { split: null, as: 'finish', seen: false });
      return done('finish', { finish: cl.t });
    }
    const sp = race.splitById.get(to);
    if (!sp) return no(`${race.name} has no such split. Reload: the race may have changed.`, 400);
    const k = sp.index;
    if (where === k) return no(`${at} is ${sp.name} already.`);
    const mat = d.groups[k]?.find((x) => x.r.locKey !== '');
    if (mat) return no(`${sp.name} has a read from the ${mat.r.location} mat for bib ${bib}: its time is known.`);
    const finish = this.#finishWithout(state, bib, d, cl);
    if (finish !== null && cl.t >= finish) return no(`${at} is after bib ${bib}'s finish (${formatRaceTime(finish, 1)}): a split can't come after the finish.`);
    const problem = this.#moveProblem(race, d, cl, k, { giveWay: true, stray });
    if (problem) return no(problem);
    // a made-up time in that split gives way: the Move replaces it, in the same change; and so do made-up or typed
    // times the pass would come out of order with (made up from it while it was in the wrong split: 521 on race day)
    drops = this.#giveWay(d, cl, k);
    for (const m of drops) recs.push({ t: 'unmanual', ...base, splitId: race.splits[m.k].id });
    if (!only) {
      unpin(cl, cl.tod);
      pinAt(cl.tod, { split: sp.id, as: 'move', seen: false });
      return done('move', { col: k });
    }
    const real = d.kept[k];
    if (real && !real.manual) {
      const t = formatRaceTime(real.rt, 1);
      return no(`Only this time can't go to ${sp.name}: ${t} is there. Move it with the later times instead, or choose Not a split for ${t} first.`);
    }
    const placed = d.passInfo.filter((x) => x !== cl && typeof this.#whereOf(state, d, x) === 'number');
    for (const x of placed) {
      if (x.t < cl.t && x.col >= k) return no(`Only this time can't go to ${sp.name}: ${formatRaceTime(x.t, 1)} (${race.splits[x.col].name}) is earlier, so it would have to come before it.`);
      if (x.t > cl.t && x.col <= k) return no(`Only this time can't go to ${sp.name}: ${formatRaceTime(x.t, 1)} (${race.splits[x.col].name}) is later, so it would have to come after it.`);
    }
    unpin(cl, cl.tod);
    pinAt(cl.tod, { split: sp.id, as: 'move', seen: false });
    for (const x of placed) {
      const hold = { split: race.splits[x.col].id, as: 'hold', seen: false };
      if ((x.pin?.as === 'move' || x.pin?.as === 'hold') && x.pin.split === hold.split) continue;
      unpin(x, x.tod);
      pinAt(x.tod, hold);
    }
    return done('only', { col: k, keep: placed.map((x) => [x.tod, x.col]) });
  }

  /** The post-condition of a change to one pass (9.23 F2): null when the pass is where it was put, else why not. */
  #fixCheck(race, state, bib, tod, expect, at) {
    const d = state.bibs.get(bib);
    const cl = d?.passInfo?.find((x) => x.tod === tod);
    if (!cl) return `Split Relay couldn't change ${at}: the pass is gone. Nothing was changed.`;
    if (expect.col !== undefined) {
      const w = this.#whereOf(state, d, cl);
      const name = race.splits[expect.col].name;
      if (w !== expect.col) {
        const why = w === 'after-finish' ? 'after the finish' : w === 'out-of-order' ? 'out of course order' : w === 'extra' ? 'no split left' : 'it would not stay there';
        return `Split Relay couldn't put ${at} in ${name} (${why}). Nothing was changed.`;
      }
      for (const [t, col] of expect.keep ?? []) {
        const x = d.passInfo.find((y) => y.tod === t);
        if (!x || this.#whereOf(state, d, x) !== col) return `Split Relay couldn't put only ${at} in ${name}: ${formatRaceTime(x?.t ?? 0, 1)} would not stay in ${race.splits[col].name}. Nothing was changed.`;
      }
    }
    if (expect.finish !== undefined && d.finishRt !== expect.finish) return `Split Relay couldn't make ${at} the finish. Nothing was changed.`;
    if (expect.how !== undefined && cl.how !== expect.how) return `Split Relay couldn't set ${at} aside. Nothing was changed.`;
    if (expect.pin !== undefined && (cl.pin?.as ?? null) !== expect.pin) return `Split Relay couldn't change ${at}. Nothing was changed.`;
    return null;
  }

  /** What a change to one pass did, in words: "16:10.8 moved to 4200m; 22:28.8 → 4400m, 26:22.1 → 5300m; ...". */
  #moveWords(race, state, bib, cl, kind, before, drops = []) {
    const d = state.bibs.get(bib);
    const after = this.#wheres(state, d);
    const at = formatRaceTime(cl.t, 1);
    const w = whereWord(after.get(cl.tod), race.splits);
    const moved = [];
    const extras = [];
    const late = [];
    for (const x of d?.passInfo ?? []) {
      if (x.tod === cl.tod) continue;
      const a = before.get(x.tod);
      const z = after.get(x.tod);
      if (a === z) continue;
      const t = formatRaceTime(x.t, 1);
      if (z === 'extra') extras.push(t);
      else if (z === 'after-finish') late.push(t);
      else moved.push(`${t} → ${whereWord(z, race.splits)}`);
    }
    // the made-up and typed times out of order with it, taken out (the one in its own split it replaces: said by the cell)
    const k = typeof after.get(cl.tod) === 'number' ? after.get(cl.tod) : -1;
    const gone = (est) => drops.filter((m) => m.k !== k && m.rec.estimated === est).map((m) => race.splits[m.k].name);
    const out = [gone(true), gone(false)].map((l, i) => (l.length ? `the ${i ? 'typed' : 'made-up'} ${listWords(l)} time${l.length === 1 ? '' : 's'}` : '')).filter(Boolean);
    const n = drops.filter((m) => m.k !== k).length;
    const tail = [moved.join(', '),
      extras.length ? `${listWords(extras)} ${extras.length === 1 ? 'is an extra pass' : 'are extra passes'} now` : '',
      late.length ? `${listWords(late)} ${late.length === 1 ? 'is' : 'are'} after the finish now` : '',
      out.length ? `${listWords(out)} ${n === 1 ? 'is' : 'are'} taken out` : ''].filter(Boolean);
    const head = { only: `Only ${at} moved (to ${w})`, move: `${at} moved to ${w}`, none: `${at} is not a split now`, finish: `${at} is the finish now`,
      count: `${at} is counted again (${w})`, keep: `${at} stays in ${w}` }[kind] ?? `${at} changed`;
    return [head, ...tail].join('; ');
  }

  // ---- "Missed <split>: add it" (DESIGN 9.23 F13) ---------------------------------------------------------------------

  /**
   * The rules of "Missed <split>: add it", checked before anything changes, for the action and the runner editor's menu
   * alike: the pass that moves on (the one counted in split k; for a missed last split, a pass marked as the finish),
   * the records that move it `count` columns on (a Move, by the rules of a Move; past the last split it is an extra
   * pass, and a decision on it is forgotten), and the suggested times of the emptied splits: the stretch from the split
   * before (or the gun) to the pass that moved on, or, past the last split, to the runner's finish (else that pass: the
   * stream's finish pass), placed like the runners nearest in pace (estimateGaps). Or why it can't be done, in words.
   * 9.23 F16: `also`, the other runs of missed splits further on (two mats missed apart: 4200m and 5300m with 4400m
   * read), each { k: its first split as the course has it, count }: each run's pass (counted now in its first split less
   * the splits added before it) moves on by the rules of a Move to the run's end (past the last split: an extra pass),
   * and every run's splits get their suggested times, each between the crossings around it once all have moved, in the
   * same change. Only counted passes move so (not a made-up or typed time, a timing point or a marked finish).
   * @param {any[]} refs the other runners as references (#refRunners)
   * @param {{ k: number, count: number }[]} [also]
   * @returns {{ status: number, why: string, cl?: undefined } | { why: null, cl: any, marked: boolean, cols: number[],
   *   to: number, recs: any[], drops: any[], est: any[], prev: { name: string, t: number }|null,
   *   next: { text: string, t: number }, runs: { k: number, count: number, cl: any, to: number, cols: number[], at: number }[] }}
   *   runs[].at: the column its pass is counted in now
   */
  #missedPlan(race, state, bib, d, k, count, refs, also = [], aside = []) {
    if (aside.length) return this.#missedAsidePlan(race, state, bib, d, k, count, refs, also, aside);
    const n = race.splits.length;
    const sp = race.splits[k];
    const no = (why, status = 409) => ({ status, why });
    const c = d?.kept[k] ?? null;
    let cl = null;
    let marked = false;
    /** 9.23 F14: made-up times from k on, before the pass that moves on: made up again with the splits it adds */
    let again = [];
    if (c?.manual?.estimated) {
      // a made-up time that its later passes do not fit (an earlier fix with too few splits, #madeUpHint): the runner's
      // next real pass after it moves on, and the made-up times on the way are made up again
      let j = k;
      while (j < n && (!d.kept[j] || d.kept[j].manual?.estimated)) j++;
      const nx = j < n ? d.kept[j] : null;
      if (nx && !nx.manual && !nx.reads.some((r) => r.locKey !== '') && j <= k + count) {
        cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === j) ?? null;
        again = (d.manualInfo ?? []).filter((m) => m.state === 'active' && m.k >= k && m.k < j);
      }
      if (!cl) return no(`Bib ${bib} has a made-up ${sp.name} time (${formatRaceTime(c.rt, 1)}): change that time instead.`);
    } else if (c) {
      if (c.manual) return no(`Bib ${bib} has a ${c.manual.estimated ? 'made-up' : 'typed'} ${sp.name} time (${formatRaceTime(c.rt, 1)}): change that time instead.`);
      const mat = c.reads.find((r) => r.locKey !== '');
      if (mat) return no(`${sp.name} has a read from the ${mat.location} mat for bib ${bib}: its time is known.`);
      cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === k) ?? null;
    } else if (k + count === n) {
      // the runner's pass marked as the finish comes after the missed last split(s): it is the pass that moves on
      cl = d?.passInfo?.find((x) => x.how === 'finish') ?? null;
      marked = !!cl;
    }
    if (!cl) {
      return no(c ? `Split Relay can't find the pass in bib ${bib}'s ${sp.name}. Reload the runner.`
        : `Bib ${bib} has no time in ${sp.name}: it is missing, with no later time in it to move on. Send its time instead.`);
    }
    const to = k + count;
    const cols = [];
    for (let x = k; x < to; x++) cols.push(x);
    if (also.length && (marked || again.length || to >= n)) {
      return no(`Bib ${bib}'s ${listWords(cols.map((x) => race.splits[x].name))} can't be added with ${listWords(also.map((r) => race.splits[r.k]?.name ?? '?'))} in one change: add ${cols.length > 1 ? 'them' : 'it'} on ${cols.length > 1 ? 'their' : 'its'} own first.`);
    }
    const recs = [];
    let drops = [];
    if (to < n && this.#whereOf(state, d, cl) === to) {
      // (made up again only: the pass is in that split already)
    } else if (to < n) {
      const rule = this.#moveRules(race, state, bib, d, cl, race.splits[to].id, false);
      if (rule.why) return no(rule.why, rule.status);
      recs.push(...rule.recs);
      drops = rule.drops;
    } else {
      // past the last split: the pass, and the passes after it, are extra passes (never laps to go 0)
      for (const x of d.passInfo) {
        if (x === cl || x.t < cl.t || !(x.pin?.as === 'move' || x.pin?.as === 'hold')) continue;
        const w = this.#whereOf(state, d, x);
        if (typeof w === 'number') return no(`${formatRaceTime(x.t, 1)} is ${race.splits[w].name}, set in Review: it can't go past the last split. Change it first.`);
      }
      const pins = this.#pins.get(race.id)?.get(bib);
      for (const t of new Set(cl.items.map((i) => i.r.tod))) if (pins?.has(t)) recs.push({ t: 'unassign', raceId: race.id, bib, tod: t });
    }
    // 9.23 F16: the further runs, each with its own pass, moved on past the splits added before it and its own
    const runs = [{ k, count, cl, to, cols: [...cols], at: k }];
    let shift = count;
    for (const r of also) {
      const name = race.splits[r.k].name;
      const at = r.k - shift;
      // (only counted passes from the run before it on: they move on with it)
      for (let y = runs.at(-1).at + 1; y < at; y++) {
        const z = d.kept[y];
        if (z && (z.manual || z.reads.some((q) => q.locKey !== ''))) {
          return no(`Bib ${bib} has a ${z.manual ? `${z.manual.estimated ? 'made-up' : 'typed'} ${race.splits[y].name} time` : `${race.splits[y].name} read from a timing point`} between the missed splits: add them one at a time.`);
        }
      }
      const x = d.kept[at] ?? null;
      if (!x || x.manual || x.reads.some((q) => q.locKey !== '')) {
        return no(`Bib ${bib} has no counted time in ${race.splits[at]?.name ?? 'the split before it'} to move on past ${name}: add ${name} on its own.`);
      }
      const rcl = d.passInfo?.find((y) => this.#whereOf(state, d, y) === at) ?? null;
      if (!rcl) return no(`Split Relay can't find the pass in bib ${bib}'s ${race.splits[at].name}. Reload the runner.`);
      const rto = r.k + r.count;
      const rcols = [];
      for (let y = r.k; y < rto; y++) rcols.push(y);
      if (rto < n) {
        const rule = this.#moveRules(race, state, bib, d, rcl, race.splits[rto].id, false);
        if (rule.why) return no(rule.why, rule.status);
        recs.push(...rule.recs);
        for (const m of rule.drops) {
          if (drops.includes(m)) continue;
          drops = [...drops, m];
        }
      } else {
        for (const y of d.passInfo) {
          if (y === rcl || y.t < rcl.t || !(y.pin?.as === 'move' || y.pin?.as === 'hold')) continue;
          const w = this.#whereOf(state, d, y);
          if (typeof w === 'number') return no(`${formatRaceTime(y.t, 1)} is ${race.splits[w].name}, set in Review: it can't go past the last split. Change it first.`);
        }
        const pins = this.#pins.get(race.id)?.get(bib);
        for (const t of new Set(rcl.items.map((i) => i.r.tod))) if (pins?.has(t)) recs.push({ t: 'unassign', raceId: race.id, bib, tod: t });
      }
      runs.push({ k: r.k, count: r.count, cl: rcl, to: rto, cols: rcols, at });
      cols.push(...rcols);
      shift += r.count;
    }
    // a finisher's split goes with the finish place, so it waits for it (9.17 P4); a pass marked as the finish that
    // moves on is the finish no more
    const finishAfter = marked ? this.#finishWithout(state, bib, d, cl) : this.#finishOf(state, bib, d);
    if (finishAfter !== null && this.#finishPlace(state, bib) === null) return no(noPlaceText(bib, this.#markedFinish(race, state, bib)));
    const kept = new Array(n).fill(null);
    let prev = null;
    for (let x = 0; x < k; x++) {
      if (!d.kept[x]) continue;
      kept[x] = d.kept[x].rt;
      prev = { name: race.splits[x].name, t: d.kept[x].rt };
    }
    let finish = finishAfter;
    let next;
    if (to < n) {
      kept[to] = cl.t;
      next = { text: `${formatRaceTime(cl.t, 1)}, which moves on to ${race.splits[to].name}`, t: cl.t };
    } else {
      if (finish === null || finish < cl.t) finish = cl.t;
      next = finish === cl.t ? { text: `${formatRaceTime(cl.t, 1)}, the pass after it`, t: cl.t } : { text: 'the finish', t: finish };
    }
    if (runs.length > 1) {
      // (9.23 F16: every crossing from the first run's pass on where the change puts it, so each run is made up between
      // the crossings around it: 568's 5300m between 17:56.2, its 4400m then, and 28:22.6, the stream's finish pass)
      const plan = runs.map((r) => ({ k: r.k, count: r.count }));
      for (let x = k + 1; x < n; x++) {
        if (!d.kept[x]) continue;
        const y = runShift(plan, x);
        if (y < n) kept[y] = d.kept[x].rt;
        else if (y === n && finishAfter === null && (finish === null || d.kept[x].rt < finish)) finish = d.kept[x].rt;
      }
    }
    const est = estimateGaps({ n, names: race.splits.map((s) => s.name), kept, finish, others: refs, columns: cols, start: this.#lateStartFor(race, state, bib, d, runs, cols, finishAfter) });
    return { why: null, cl, marked, cols, to, recs, drops, est, prev, next, again, runs };
  }

  /**
   * 9.23 F20: "Missed …: add it" that also sets stray passes aside (`aside`, the runner's passes: Not a split), as one change:
   * the runner as counted with the strays left out (previewPlaces), each run's pass there moved on as a Move, the strays
   * set aside, the made-up times between the crossings around them once all have moved. Only for a runner as counted (no
   * pass placed or set aside, no made-up or typed time, no timing point): else the stray is set aside first, on its own.
   * The same shape as #missedPlan's.
   */
  #missedAsidePlan(race, state, bib, d, k, count, refs, also, aside) {
    const n = race.splits.length;
    const names = race.splits.map((sp) => sp.name);
    const no = (why, status = 409) => ({ status, why });
    const strays = listWords(aside.map((x) => formatRaceTime(x.t, 1)));
    if (d.passInfo.some((x) => x.pin) || (d.manualInfo ?? []).some((m) => m.state === 'active') || d.kept.some((c) => c && c.reads.some((r) => r.locKey !== ''))) {
      return no(`Set ${strays} aside first (Not a split, in its menu), then add ${names[k]}.`);
    }
    const finishAfter = this.#finishOf(state, bib, d);
    if (finishAfter !== null && this.#finishPlace(state, bib) === null) return no(noPlaceText(bib, this.#markedFinish(race, state, bib)));
    // the runner as counted with the strays set aside
    const none = new Map(aside.map((x) => [x, { split: null, as: 'none', seen: false }]));
    const adj = previewPlaces(d.passInfo, d.manualInfo ?? [], race.splits, none, null, -1, () => finishAfter);
    const passAt = (c) => d.passInfo.find((x) => adj.get(x) === c) ?? null;
    const runs = [];
    let shift = 0;
    for (const r of [{ k, count }, ...also]) {
      const at = r.k - shift;
      const rcl = passAt(at);
      if (!rcl || aside.includes(rcl)) return no(`Split Relay can't find the pass that moves on to ${names[Math.min(r.k + r.count, n - 1)]} for bib ${bib}. Reload the runner.`);
      const cols = [];
      for (let y = r.k; y < r.k + r.count; y++) cols.push(y);
      runs.push({ k: r.k, count: r.count, cl: rcl, to: r.k + r.count, cols, at });
      shift += r.count;
    }
    const recs = [];
    for (const x of aside) recs.push({ t: 'assign', raceId: race.id, bib, tod: x.tod, ...pinFields({ split: null, as: 'none', seen: false }) });
    for (const r of runs) if (r.to < n) recs.push({ t: 'assign', raceId: race.id, bib, tod: r.cl.tod, ...pinFields({ split: race.splits[r.to].id, as: 'move', seen: false }) });
    // every crossing where the change puts it, so each run is made up between the crossings around it
    const plan = runs.map((r) => ({ k: r.k, count: r.count }));
    const kept = new Array(n).fill(null);
    let finish = finishAfter;
    for (const x of d.passInfo) {
      const c = adj.get(x);
      if (typeof c !== 'number') continue;
      const y = runShift(plan, c);
      if (y < n) kept[y] = x.t;
      else if (y === n && finishAfter === null && (finish === null || x.t < finish)) finish = x.t;
    }
    let prev = null;
    for (let x = 0; x < k; x++) if (kept[x] !== null) prev = { name: names[x], t: kept[x] };
    const cl = runs[0].cl;
    const to = runs[0].to;
    const next = to < n ? { text: `${formatRaceTime(cl.t, 1)}, which moves on to ${names[to]}`, t: cl.t }
      : { text: finish !== null && finish > cl.t ? 'the finish' : `${formatRaceTime(cl.t, 1)}, the pass after it`, t: finish !== null && finish > cl.t ? finish : cl.t };
    const cols = runs.flatMap((r) => r.cols);
    const est = estimateGaps({ n, names, kept, finish, others: refs, columns: cols, start: this.#lateStartFor(race, state, bib, d, runs, cols, finishAfter, aside) });
    return { why: null, cl, marked: false, cols, to, recs, drops: [], est, prev, next, again: [], runs, aside };
  }

  /**
   * 9.23 F19: when a change makes up a runner's first split, the start it is made up from: the gun (0), or the runner's own
   * start when its legs from pass to pass as the change leaves them (src/review.js legShape, against the column check's
   * field) fit the course and put it LATE_START_TICKS or more after the gun. A late starter who missed 800m had its 800m
   * made up from the gun: 56 s after its start (476, four minutes late).
   */
  #lateStartFor(race, state, bib, d, runs, cols, finish, aside = []) {
    if (!cols.includes(0)) return 0;
    const field = this.#checkFieldOf(race, state);
    if (!field) return 0;
    const n = race.splits.length;
    const plan = runs.map((r) => ({ k: r.k, count: r.count }));
    const ev = [];
    // (9.23 F20: a stray pass set aside takes no split: the crossings after it count one back)
    let back = 0;
    for (let x = 0; x < n; x++) {
      const c = d.kept[x];
      if (!c || c.manual) continue;
      if (aside.some((s) => s.t === c.rt)) {
        back++;
        continue;
      }
      const y = runShift(plan, x - back);
      if (y < n && (finish === null || c.rt < finish - FINISH_NEAR_TICKS)) ev.push({ t: c.rt, c: y });
    }
    if (finish !== null) ev.push({ t: finish, c: n });
    const s = ev.length ? legShape(ev, field.shapeRefs.filter((x) => x.bib !== bib), field.refAt) : null;
    return s && s.cost <= CHECK_RULES.shapeWithin && s.late >= LATE_START_TICKS && s.late < ev[0].t ? Math.round(s.late) : 0;
  }

  /**
   * Why the suggested times of "Missed <split>: add it" are not sent (a typed time is the operator's own), or null
   * (9.23 F6): an earlier pass of the runner looks wrong (the stretch is measured from it), or (9.23 F14) the runner's
   * later passes fit another count clearly better (the runner missed more mats in a row, or fewer: add as many as
   * that). While Split Relay can't tell which, either count goes. (9.23 F15: a flag the hint was moved on from is no
   * reason: the fit of all of the runner's passes has measured that pass too, and placed the run after it. 9.23 F16:
   * when the hint's set is two runs apart, another set from its split is refused as another count is: 544's "Missed
   * 4200m: add it" alone sent its finish read as 5300m.)
   * @param {{ k: number, count: number, runs?: { k: number, count: number }[] }} set the split, how many, the runs
   * @param {ReturnType<Engine['#missedHint']>} hint
   */
  #missedFlagBlock(race, state, rv, bib, set, hint) {
    const n = race.splits.length;
    const k = set.k;
    const f = rv?.legs?.flags.get(bib);
    if (f && !f.silenced && f.col < k && !(hint?.pointed === f.col && hint.k === k)) {
      const t = rv.legs.runners.get(bib)?.real[f.col];
      const at = Number.isFinite(t) ? `${formatRaceTime(t, 1)} ` : '';
      return `Check bib ${bib}'s ${race.splits[f.col].name} first: ${at}${f.suggest ? `looks like ${f.suggest.toName}` : 'looks wrong'}. Move it, or choose It's right; then this split can be filled.`;
    }
    if (!hint || hint.k !== k || !hint.sure) return null;
    if (sameRuns(runsOf(set), runsOf(hint))) {
      // (9.23 F20: the same splits, but a stray pass the one click sets aside left in a split: every later split a column on)
      const key = (x) => (x?.aside ?? []).map((a) => a.tod).join(',');
      if (!hint.aside?.length || key(set) === key(hint)) return null;
      const strays = listWords(hint.aside.map((a) => formatRaceTime(a.t, 1)));
      return `${strays} looks like a stray pass, no split: add ${race.splits[k].name} with it set aside (${missedName({ names: runsOf(hint).flatMap((r) => race.splits.slice(r.k, r.k + r.count).map((sp) => sp.name)), aside: hint.aside.map((a) => ({ timeText: formatRaceTime(a.t, 1) })) })}), or choose Not a split for it first.`;
    }
    const d = state.bibs.get(bib);
    const cl = d?.passInfo?.find((x) => this.#whereOf(state, d, x) === k) ?? null;
    const at = cl ? `${formatRaceTime(cl.t, 1)} ` : '';
    const runs = runsOf(hint);
    const to = k + hint.count;
    const names = runs.flatMap((r) => race.splits.slice(r.k, r.k + r.count).map((sp) => sp.name));
    const read = readWords(readGaps(runs, race.splits));
    return `${at}looks like ${to < n ? race.splits[to].name : 'the finish'}: bib ${bib} missed ${listWords(names)}${read ? ` (${read})` : ''}? `
      + `Add ${names.length === 1 ? 'it' : 'them together'}, or type the time.`;
  }

  /**
   * DESIGN 9.23 F14: how many splits in a row from column k a mat missed the runner (src/review.js missedCounts): the
   * pass in k and every later pass of the runner in a split or past the last one, moved on count columns for each
   * count, measured against the look-wrong check's field (the runners of the same pace). Null with no field or no pass
   * in k.
   */
  #missedCountOf(race, state, bib, rv, k, none = false) {
    const legs = rv?.legs;
    const me = legs?.runners.get(bib);
    const d = state.bibs.get(bib);
    if (!legs?.field || !me || !d) return null;
    const cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === k) ?? null;
    if (!cl) return null;
    const { passes, upTo } = this.#countPasses(race, state, d, cl, k);
    return { cl, fit: missedCounts(legs.field, me, k, passes, { finish: upTo === race.splits.length ? this.#finishOf(state, bib, d) : null, near: FINISH_NEAR_TICKS, none, upTo }) };
  }

  /**
   * The runner's passes from `cl` on as the count fit takes them (missedCounts), up to the next time the operator set
   * after column k (9.23 F15: a made-up or typed time, a timing point's read: the passes before it can't go past it, two
   * mats missed apart and each added, 1500m and 3100m), and that column (`upTo`, n when there is none; the runner's
   * finish counts only then).
   */
  #countPasses(race, state, d, cl, k) {
    const n = race.splits.length;
    let upTo = n;
    for (let x = k + 1; x < n && upTo === n; x++) {
      const c = d.kept[x];
      if (c && (c.manual || c.reads.some((r) => r.locKey !== ''))) upTo = x;
    }
    const passes = [];
    for (const x of d.passInfo) {
      if (x.t < cl.t) continue;
      const w = this.#whereOf(state, d, x);
      if ((typeof w === 'number' && w < upTo) || (w === 'extra' && upTo === n)) passes.push(x.t);
    }
    return { passes, upTo };
  }

  /**
   * DESIGN 9.23 F15: every placing of the runner's passes Split Relay counted (src/review.js missedStarts): the passes
   * after the last cell the operator set (a Move or Keep, a made-up or typed time; a timing point) or left empty, each
   * of them as the first that moved on, every count. Null with no field or no such pass.
   * @returns {{ w: number, cls: any[], fit: ReturnType<typeof missedStarts> } | null} w: the first column of those
   *   passes; cls: the pass in each column
   */
  #missedStartsOf(race, state, bib, rv) {
    // (9.23 F16: worked out once per Review list, which is made again when the race's crossings change: a runner's rows,
    // its cells and the cause of its leg all ask)
    const memo = rv?.legs ? (rv.legs.startsMemo ??= new Map()) : null;
    if (memo?.has(bib)) return memo.get(bib);
    const got = this.#missedStartsOfNow(race, state, bib, rv);
    memo?.set(bib, got);
    return got;
  }

  /** #missedStartsOf, worked out. */
  #missedStartsOfNow(race, state, bib, rv) {
    const n = race.splits.length;
    const legs = rv?.legs;
    const me = legs?.runners.get(bib);
    const d = state.bibs.get(bib);
    if (!legs?.field || !me || !d?.passInfo) return null;
    let last = -1;
    for (let x = 0; x < n; x++) if (d.kept[x]) last = x;
    let w = 0;
    const cls = [];
    for (let x = 0; x <= last; x++) {
      const c = d.kept[x];
      const cl = c && !c.manual ? d.passInfo.find((y) => this.#whereOf(state, d, y) === x) ?? null : null;
      cls.push(cl);
      if (!cl || !(cl.how === 'counted' || cl.how === 'earliest' || cl.how === 'shifted') || cl.pin || c.reads.some((r) => r.locKey !== '')) w = x + 1;
    }
    if (w > last) return null;
    const from = cls[w];
    const passes = [];
    let past = n;
    for (const x of d.passInfo) {
      if (x.t < from.t) continue;
      const where = this.#whereOf(state, d, x);
      if (typeof where === 'number') passes.push({ t: x.t, col: where });
      else if (where === 'extra') passes.push({ t: x.t, col: past++ });
    }
    const starts = [];
    for (let x = w; x <= last; x++) starts.push(x);
    const finish = this.#finishOf(state, bib, d);
    const fit = missedStarts(legs.field, me, w, passes, starts, { finish, near: FINISH_NEAR_TICKS });
    // 9.23 F20: a stray pass after the pass that moves on (#straysOf) set aside: the runner's passes from it on count one
    // split back, and every placing of them is measured again, each with the stray left out (it costs as an extra pass,
    // COUNT_RULES.extra); one that starts before the stray carries it (`aside`), its one click sets it aside too. The
    // re-check of 2026-10-30 found every complete runner with 2400m missed and a second read 40 s after its 3100m pass
    // given "Missed 2400m: add it" as its one click (c53dc9a), which sent the stray as 4200m and every later split a column
    // late; or, once a full count was taken for every mat read, nothing at all
    // (each pass that may be the stray set aside in turn, at most four)
    const strays = this.#straysOf(race, state, bib, d).filter((x) => x.t > from.t);
    // 9.23 F21: and either pass of a leg that the cheapest placings would make shorter than anybody covers that stretch
    // (the runner as counted, as #straysOf takes it): 3100m missed and a read 37 s after the 4400m pass, counted in 4400m,
    // a leg like a real one there, so no stray as counted; "Missed 3100m" puts it in 5300m, 0:37 after 4400m where the
    // leaders took 3:05, and was the sure one click (14 of 161 without the finish line or FinishLynx), the read sent as
    // 5300m until its own Not a split
    const cf = this.#checkFieldOf(race, state);
    // (only the placing that would be the one click, clearly the cheapest: a slow leg on the course, its placings close,
    // would have its real passes "set aside")
    const top = fit.ok[0];
    const next = [fit.ok[1], fit.loose[0], fit.none].filter((y) => y && !y.out).reduce((a, y) => Math.min(a, y.cost), Infinity);
    if (cf && top && next - top.cost >= startMargin(top) && strays.length < 4 && this.#asCounted(race, state, bib, d)) {
      const lastT = d.passInfo.filter((x) => x.how !== 'ignored').at(-1)?.t;
      // (where the top placing puts the pass at index i: moved on by every run that starts at or before it)
      const colOf = (i) => passes[i].col + (i < top.first ? 0 : top.second === null || i < top.second ? top.count
        : top.third === null || top.third === undefined || i < top.third ? top.count + top.count2 : top.count + top.count2 + top.count3);
      for (let i = 1; i < passes.length; i++) {
        const a = colOf(i - 1);
        if (colOf(i) !== a + 1 || a + 1 >= n || strayLegAt(cf, a, a + 1, passes[i].t - passes[i - 1].t) !== true) continue;
        if (passes[i].t === lastT || (finish !== null && passes[i].t >= finish - FINISH_NEAR_TICKS)) continue;
        for (const p of [passes[i - 1], passes[i]]) {
          const y = p.t > from.t ? d.passInfo.find((z) => z.t === p.t) ?? null : null;
          if (y && !strays.includes(y)) strays.push(y);
        }
      }
    }
    if (strays.length && strays.length <= 4) {
      const ok = [...fit.ok];
      const loose = [...fit.loose];
      let open = fit.open;
      for (const s of strays) {
        const list = [];
        for (const p of passes) if (p.t !== s.t) list.push(p.t > s.t ? { t: p.t, col: p.col - 1 } : p);
        let lastA = -1;
        for (const p of list) if (p.col < n) lastA = Math.max(lastA, p.col);
        const startsA = [];
        for (let x = w; x <= lastA; x++) startsA.push(x);
        const fa = missedStarts(legs.field, me, w, list, startsA, { finish, near: FINISH_NEAR_TICKS });
        // (9.23 F21: `moved`, the pass that moves on first, for the words: after the stray it is not the one counted in k now)
        const mark = (x) => ({ ...x, cost: x.cost + COUNT_RULES.extra, aside: [s], moved: list[x.first]?.t ?? null });
        // (where a placing puts the pass at index i of the list: moved on by every run that starts at or before it)
        const placed = (x, i) => list[i].col + (i < x.first ? 0 : x.second === null || i < x.second ? x.count
          : x.third === null || x.third === undefined || i < x.third ? x.count + x.count2 : x.count + x.count2 + x.count3);
        // (not a placing that leaves a split missed between the stray's neighbours: the stray would be that split's pass,
        // as a walker's real 4400m pass 70 s after its 4200m, counted in 4200m after 800m missed, looked a stray on the
        // stretch from 3100m to 4200m. 9.23 F21: unless it came sooner after the pass before it than anybody covers the
        // stretch to that split: a read 30 s after a 4200m pass is no 4400m pass, one 1:30 after a 4400m pass no 5300m pass.
        // Only with the runner's finish known, as a run that starts after the stray (`can`): on the course the runner's
        // latest pass may be its last split's, and 4400m missed with a read 30 s after the 4200m pass had "Missed 4200m and
        // 5300m (17:22.9 is a stray pass)" as the sure one click there, its real 5300m pass taken for the finish, 5 of 167)
        const after = list.findIndex((p) => p.t > s.t);
        const soon = (x) => finish !== null && !!cf && strayLegAt(cf, placed(x, after - 1), placed(x, after - 1) + 1, s.t - list[after - 1].t) === true;
        const fills = (x) => after > 0 && placed(x, after) - placed(x, after - 1) >= 2 && !soon(x);
        // (nor, while the runner's finish is unknown, one that would leave it past the last split anyway: an extra pass is
        // no split already, the same placing without it; a cool-down pass soon after a finish read counted in a split,
        // 573's, was "set aside" so. With its finish known no pass can be between the last split and it)
        const prev = after < 0 ? list.length - 1 : after - 1;
        const past = (x) => finish === null && prev >= 0 && placed(x, prev) + 1 >= n;
        // (9.23 F21: with the runner's finish known, a run that starts after the stray too: the stray made up in the count
        // for a mat missed after it, the passes between them a split late. 4400m missed and a read 30 s after the 4200m
        // pass, counted in 4400m: the only stray set was "Missed 4200m" with the real 4400m pass set aside, the sure one
        // click for 4 of 167, which sent the real 4200m as 4400m. While the finish is unknown, the stream's finish pass may
        // be the last split's, and the stray's own flag says Not a split)
        const can = (x) => (list[x.first]?.t < s.t || finish !== null) && !fills(x) && !past(x);
        ok.push(...fa.ok.filter(can).map(mark));
        loose.push(...fa.loose.filter(can).map(mark));
        // (9.23 F21: and, with the finish known, the stray set aside with no run before the finish read: it is in a split
        // then, and every split from there on was missed, a finisher's trail. 5300m missed and a read 1:30 after the 4400m
        // pass, counted in 5300m: "Missed 4200m" setting the real 4400m pass aside was the sure one click for 14 of 167)
        const fr = finish === null ? -1 : list.findIndex((p) => p.t >= finish - FINISH_NEAR_TICKS);
        if (fr >= 0 && list[fr].col < n && !fa.none.out && !fa.none.unknown) {
          const x = { ...fa.none, k: list[fr].col, count: n - list[fr].col, k2: null, count2: 0, k3: null, count3: 0, first: fr, second: null, third: null, trail: null };
          x.cost += COUNT_RULES.perMat * Math.max(0, x.count - 1);
          if (can(x)) ok.push(mark(x));
        }
        open ||= fa.open;
      }
      const byCost = (x, y) => x.cost - y.cost || x.k - y.k || x.count - y.count || (x.k2 ?? -1) - (y.k2 ?? -1) || (x.aside?.[0]?.t ?? 0) - (y.aside?.[0]?.t ?? 0);
      return { w, cls, fit: this.#strayLegsFit(race, state, bib, rv, d, w, { ok: ok.sort(byCost), loose: loose.sort(byCost), none: fit.none, open }) };
    }
    return { w, cls, fit };
  }

  /**
   * 9.23 F20: the sets that set a stray pass aside (#missedStartsOfNow) stand only where the runner's legs from pass to pass
   * (src/review.js legShape, whenever it started, as #lateOr weighs placings) fit them better than they fit the best of the
   * cheapest sets that set nothing aside, or than one run of one to three splits from each of the first three splits whose
   * pass can move (the count fit's; a late starter's gun placings that set nothing aside are all out), or no missed split
   * at all: the gun's placings of a late starter's passes, all late, can fit a set that sets a good pass aside and moves
   * the rest further on, where nothing else fits the gun. Bib 1 five minutes late with 800m missed: its real 3100m pass,
   * 2:23 after its 2400m pass, counted on the 900 m from 1500m (0.73 of the leaders' leg there), made "800m and 1500m
   * (15:44.4 is a stray pass)" its hint, where 051d375 had "Missed 800m" sure and right (167 late starters six minutes late
   * with 800m missed, FinishLynx's finishes known, all of them offered instead). Only a stray set that can be the one click
   * or one about as good is weighed: cheapest first, until twice COUNT_RULES.margin past the cheapest set that stands.
   */
  #strayLegsFit(race, state, bib, rv, d, w, fit) {
    const all = [...fit.ok, ...fit.loose].sort((x, y) => x.cost - y.cost);
    const top = all[0]?.cost;
    if (!all.some((f) => f.aside && f.cost < top + 2 * COUNT_RULES.margin)) return fit;
    const field = this.#checkFieldOf(race, state);
    if (!field) return fit;
    const ctx = this.#legCtx(race, state, bib, d, rv, field);
    const mats = (runs) => runs.reduce((a, y) => a + y.count, 0);
    const n = race.splits.length;
    const legsOf = (runs, aside) => {
      const got = this.#placingOf(race, state, d, runs, ctx.finish, ctx.stream, aside);
      const s = got ? legShape(got.ev, ctx.others, field.refAt) : null;
      const r = got?.trail ? [...runs, got.trail] : runs;
      return s ? s.cost * s.legs + COUNT_RULES.extra * (got.dropped + aside.length) + CHECK_RULES.shapeGap * mats(r) : null;
    };
    let plain = null;
    const better = (v) => {
      if (v !== null && (plain === null || v < plain)) plain = v;
    };
    for (const f of all.filter((x) => !x.aside).slice(0, 6)) better(legsOf(startRuns({ ...f, trail: null }), []));
    for (let k = w; k < Math.min(n, w + 3); k++) for (let c = 1; c <= 3 && k + c <= n; c++) better(legsOf([{ k, count: c }], []));
    better(legsOf([], []));
    if (plain === null) return fit;
    const gone = new Set();
    const near = new Set();
    let floor = null;
    for (const f of all) {
      if (floor !== null && f.cost >= floor + 2 * COUNT_RULES.margin) break;
      if (f.aside) {
        const v = legsOf(startRuns({ ...f, trail: null }), f.aside.map((a) => a.tod));
        if (v === null || v >= plain) {
          gone.add(f);
          continue;
        }
        // 9.23 F21: and it is the one click only when they fit it clearly better (CHECK_RULES.shapeMargin), as every
        // other explanation is weighed: a runner whose mats all read and who ran its last 900 m in 0.7 of its own time
        // fitted "Missed 5300m: add it (17:40.3 is a stray pass)" (its real 5300m pass set aside) within 0.06 of its passes
        // as read, and "Missed 4200m" setting its real 4400m pass aside within 0.1: the sure one click for 22 of 167
        if (plain - v < CHECK_RULES.shapeMargin) near.add(f);
      }
      floor ??= f.cost;
    }
    if (!gone.size && !near.size) return fit;
    // (`near`: offered, not the one click, `unsure: 'stray'`)
    const keep = (l) => l.filter((f) => !gone.has(f)).map((f) => (near.has(f) ? { ...f, near: true } : f));
    return { ...fit, ok: keep(fit.ok), loose: keep(fit.loose) };
  }

  /** 9.23 F20: the runner's pass before a stray pass (its words: "0:40 after 10:44.4"), or null. */
  #strayPrev(state, d, s) {
    let prev = null;
    for (const x of d?.passInfo ?? []) if (x.t < s.t && x.how !== 'ignored' && (!prev || x.t > prev.t)) prev = x;
    return prev;
  }

  /** 9.23 F20: a runner as counted: no pass placed or set aside by the operator, no made-up or typed time, no timing point. */
  #asCounted(race, state, bib, d) {
    if (!d?.passInfo?.length || d.passInfo.some((x) => x.pin) || (d.manualInfo ?? []).some((m) => m.state === 'active')) return false;
    return !(d.checkRunner ??= this.#checkRunnerOf(state, bib, d, race.splits.length)).located;
  }

  /**
   * 9.23 F20: the passes that may be a runner's stray pass in its splits, either pass of a leg shorter than anybody covers
   * that stretch (src/review.js strayLegs; a stray soon after a real pass is the later, one soon before the runner's next
   * real pass the earlier: 4200m missed and a read 60 s after the 4400m pass, counted in 4400m, leaves the leg after it short
   * on the 900 m to 5300m), when the runner is as counted (no pass placed or set aside by the operator, no made-up or typed
   * time, no timing point): a set of missed splits may set one aside, and the placings of all of them say which. Not a leg
   * that ends at the runner's last pass (a finish pass and a cool-down pass soon after it: nothing after them tells), nor
   * at its finish read at its known finish. [] otherwise.
   */
  #straysOf(race, state, bib, d) {
    if (!this.#asCounted(race, state, bib, d)) return [];
    const field = this.#checkFieldOf(race, state);
    const n = race.splits.length;
    const r = (d.checkRunner ??= this.#checkRunnerOf(state, bib, d, n));
    if (!field) return [];
    const finish = this.#finishOf(state, bib, d);
    const lastT = d.passInfo.filter((x) => x.how !== 'ignored').at(-1)?.t;
    const at = (i) => d.passInfo.find((x) => x.t === r.passes[i].t && this.#whereOf(state, d, x) === r.passes[i].col) ?? null;
    const out = [];
    for (const [i, j] of strayLegs(field, r)) {
      const b = r.passes[j];
      if (b.t === lastT || (finish !== null && b.t >= finish - FINISH_NEAR_TICKS)) continue;
      for (const x of [at(i), at(j)]) if (x && !out.includes(x)) out.push(x);
    }
    return out;
  }

  /**
   * DESIGN 9.23 F15: where the run of missed mats starts, when the column check or a look-wrong flag points at a split
   * (`base`): they point at the pass they doubt, which is not always the first that moved on. The placing of all of the
   * runner's counted passes that fits clearly best (#missedStartsOf) gives the splits to add: `hint`, the one click
   * (`pointed`: base's split, when the first run starts at another). 9.23 F16: every placing is a set of missed splits
   * (one run from a split, two or three in a row, or two runs apart: 4200m and 5300m with 4400m read), and the one click
   * is the set that is cheaper than every other set (another start, another count, one run or two, and a second run whose
   * first pass fits loosely) by the margin (startMargin: more for a runner whose legs fit loosely however they are
   * placed), and than the passes where they are; two runs apart are one click (`runs`), not one at a time (in between,
   * a pass the column check did not hold went out a split early: 544's finish read as 5300m, 547's 4400m pass as 4200m).
   * Another set that fits about as well is `alt`: both are offered, neither the one click (`unsure: 'where'` when it starts
   * at another split). When the passes as they are fit about as well, Split Relay can't tell yet where (`unsure`):
   * nothing is the one click; for a pass the check holds, not a placing with a leg the look-wrong check would flag
   * against one whose every leg fits. Null when the best placing is one run from base's split, and no other set but
   * another count there fits about as well (missedCounts says how many from there).
   * @returns {{ hint: ReturnType<Engine['#missedHint']> } | { unsure: true } | null}
   */
  #missedStartOf(race, state, bib, rv, base) {
    const n = race.splits.length;
    const got = this.#missedStartsOf(race, state, bib, rv);
    if (!got || base.k < got.w) return null;
    const { ok, loose, none } = got.fit;
    const [x] = ok;
    if (!x) return null;
    // (base's pass is the runner's known finish, a finish read in the last split: the fit takes it as that finish, so
    // the passes where they are are base's own placing, the split before it missed; another start only when it fits
    // clearly better: 568 with 1500m missed, its finish read in 5300m)
    const fin = this.#finishOf(state, bib, state.bibs.get(bib));
    let own = null;
    // (9.23 F18: base's own placing pays for its missed mats as every other set does, each after the first perMat: its
    // splits from base's on are missed, a run in a row; a finisher's trail is paid for too, src/review.js missedStarts)
    const ownCost = none.cost + COUNT_RULES.perMat * Math.max(0, n - base.k - 1);
    if (fin !== null && got.cls[base.k] && got.cls[base.k].t >= fin - FINISH_NEAR_TICKS && !none.out && ownCost - x.cost < COUNT_RULES.margin) {
      // (9.23 F17: the one click only when it fits clearly best; another set about as good is offered with it. 568, a
      // walker who missed 4200m and 5300m, a finisher: its finish read in 4400m made "Missed 4400m and 5300m" the one
      // click, its 4400m pass left in 4200m, where "4200m and 5300m" (4400m read) fitted about as well)
      own = { k: base.k, count: n - base.k, k2: null, count2: 0, trail: null, cost: ownCost, legs: none.legs, path: none.path, first: 0 };
      if ((sameRuns(startRuns(x), startRuns(own)) && !x.aside) || x.cost - ownCost >= startMargin(none)) return null;
    }
    // (with a pass the column check holds, a placing with a leg the look-wrong check would flag, far longer or shorter than
    // the runners' of the same pace, is no reason to doubt one whose every leg fits: one leg's cost stops at
    // COUNT_RULES.misfit, so the real race's 512, its finish read held in 5300m, had that read as 5300m, a leg 2.56 times
    // theirs, about as cheap as the finish, and 586 its held 16:10.8 left in 3100m, 2.47 times, about as cheap as Missed
    // 3100m. Not for a flag, which is advice only: a runner whose mats all read but who walked has such a leg where it is.
    // 9.23 F17: a leg to a split, as the look-wrong check measures them, not the last one to the finish: 568, a walker who
    // missed 4400m, took 1.84 times the runners of its pace from 5300m to the finish, so "Missed 4400m" was set aside and
    // the two sets offered were both wrong)
    const wild = (f) => f.path.some((q) => q.fit !== null && q.col < n && (q.fit > FIT_RULES.longAbove || q.fit < FIT_RULES.shortBelow));
    const clean = base.by === 'check' && !wild(x);
    const margin = startMargin(x);
    // 9.23 F16: the next cheapest set, whatever it is (568, a walker who missed 4200m and 5300m: its finish read 1.52
    // times the runners' leg from 4400m, a set that fits about as well as "4400m and 5300m", which F15 sent sure); both
    // are offered when it fits about as well
    let rival = own;
    for (const f of own ? [] : [...ok.slice(1), ...loose]) {
      // (as F15: another count of the same split always; a set that starts elsewhere not with such a leg)
      if ((f.k === x.k || !(clean && wild(f))) && (!rival || f.cost < rival.cost)) rival = f;
    }
    const close = !!own || (!!rival && rival.cost - x.cost < margin);
    // (9.23 F16: a placing that can't be measured yet, the runner at the front: nothing is sure)
    const open = got.fit.open === true;
    // (the passes where they are fit about as well: no mat missed at all, a runner who walked; not said by a placing
    // whose first moved pass has nothing to be measured from, the first split missed, while the column check holds the
    // runner: its field fractions decide that. 9.23 F16: two runs apart always beat them clearly: a walker whose every leg
    // took 1.7 times the field's, its mats all read, fits "missed 1K and 3K, the last two passes extra" a little worse,
    // and that was the one click. 9.23 F18: for a flag the check held nothing, so they are said: walkers of 8:30 to 15:15
    // a km on synthetic 5Ks of 1K splits, their mats all read, had every leg 1.8 times the runners nearest in time at the
    // split before it, a flag, and "Missed 1K: add it" sure, the passes where they are as cheap as that)
    const stay = !own && !none.out && none.cost - x.cost < margin
      && (x.k2 !== null || (!(clean && wild(none)) && (x.path[x.first].from !== -1 || base.by !== 'check')));
    if (stay) return { unsure: true, best: x };
    // one run from base's split, and nothing but another count there about as good: F14's count fit says how many (9.23
    // F17: not with a finisher's trail, the splits its finish read would be left in: the count fit has no such run)
    const runs = startRuns(x);
    // (9.23 F20: a set that sets a stray pass aside is a set of its own: the count fit has no such placing)
    const asideKey = (f) => (f?.aside ?? []).map((a) => a.tod).join(',');
    const one = (f) => startRuns(f).length === 1 && asideKey(f) === asideKey(x);
    if (x.k === base.k && runs.length === 1 && !x.aside && (!close || (rival.k === x.k && one(rival)))) return null;
    const names = race.splits.map((sp) => sp.name);
    const asideOf = (f) => (f.aside ? { aside: f.aside.map((a) => ({ tod: a.tod, t: a.t })) } : {});
    const setOf = (f) => {
      const r = startRuns(f);
      return { ...(r.length > 1 ? { k: f.k, count: f.count, runs: r } : { k: f.k, count: f.count }), ...asideOf(f) };
    };
    const alt = close ? setOf(rival) : null;
    let text;
    // (9.23 F21: the pass that moves on, for a set whose run starts after the stray it sets aside: the one after it)
    const movedT = (f) => (f.aside && Number.isFinite(f.moved) ? f.moved : got.cls[f.k].t);
    if (!close) {
      text = runs.length > 1 ? missedRunsText(x, names, { sure: !open })
        : missedCountText({ count: x.count, alt: null, sure: !open, fits: [{ count: x.count, path: x.path.slice(x.first) }] }, movedT(x), x.k, names);
      // (9.23 F20: and the stray pass it sets aside: "11:24.4 is a stray pass, 0:40 after 10:44.4."; 9.23 F21: first when it
      // came first, "17:26.6 is a stray pass, 1:30 after 15:56.6. 21:46.1 looks like the finish, not 5300m (missed 5300m?)")
      if (x.aside) {
        const sw = strayWords(this.#strayPrev(state, state.bibs.get(bib), x.aside[0]), x.aside[0], !!x.near);
        text = movedT(x) > x.aside[0].t ? `${sw} ${text}` : `${text} ${sw}`;
      }
    }
    else if (runs.length === 1 && rival.k === x.k && one(rival)) {
      text = missedCountText({ count: x.count, alt: rival.count, sure: false, fits: [] }, movedT(x), x.k, names);
    } else {
      // (two sets that differ: where each puts the pass the check or the flag doubts, fewest splits first)
      const sets = [x, rival].map((f) => {
        const r = startRuns(f);
        const to = runShift(r, base.k);
        return { to: to === base.k ? null : Math.min(to, n + 1), missed: r.flatMap((y) => Array.from({ length: y.count }, (_, i) => y.k + i)) };
      }).sort((a, b) => a.missed.length - b.missed.length || a.missed[0] - b.missed[0]);
      text = missedSetsText(got.cls[base.k].t, base.k, sets, names);
    }
    // (9.23 F21: a stray set its legs fit only about as well as the passes as read, `near`: offered, Split Relay can't tell a
    // stray pass from a fast leg)
    return { hint: { k: x.k, count: x.count, ...(runs.length > 1 ? { runs } : {}), ...asideOf(x), by: base.by, sure: !close && !open && !x.near, alt,
      recount: x.k !== base.k || runs.length > 1 || (base.by === 'check' && x.count !== base.count), ...(x.k !== base.k ? { pointed: base.k } : {}),
      // (9.23 F18: two sets offered, neither the one click: the cell that says "Missed here?" is the pass the check or the
      // flag asks about, with both sets in its menu; 568 with 4400m missed had it on 4200m, the first set's split, where
      // the right one was 4400m's)
      ...(close && x.k !== base.k ? { at: base.k } : {}),
      unsure: (close && rival.k !== x.k) || (open && !close) ? 'where' : x.near && !close ? 'stray' : null, text } };
  }

  /**
   * DESIGN 9.23 F13: where a runner's mat was missed, when the column check (its first pass that moves past an empty
   * split) or the look-wrong check (a later split or the finish) says so: the split k whose pass moves on, how many
   * splits in a row, and the words. Null when neither points at one. 9.23 F14: how many comes from all of the runner's
   * later passes (#missedCountOf), for a held runner and a counted one alike: the column check places a pass at most
   * one split further than counting, and a flag measures one leg, so two missed mats in a row looked like one (459 and
   * 507 on the re-check of 2026-10-27, whose one click sent their later splits a column early and the finish pass as
   * 5300m). `sure`: one count fits clearly best, the one click; else `alt`, another count that fits about as well (both
   * are offered, neither as the one click), or none when a count can't be measured yet. `recount`: the count is not the
   * column check's (Passes to check says where the runner's later held passes go with it). 9.23 F15: where the run
   * starts comes from all of the runner's passes too (#missedStartOf): the check and the flag point at the pass they
   * doubt, an earlier one can be the first that moved on (561's 5300m pass counted in 4200m, 547's 4400m pass in 4200m,
   * 412's 3100m pass in 800m) or a later one (491, a walker: its real 4200m pass). `pointed`: the split they pointed at,
   * when the hint is elsewhere; `unsure: 'where'`: another split fits about as well, nothing is the one click. 9.23 F16:
   * `runs`, two runs of missed splits apart, added in one click (4200m and 5300m, 4400m read); `alt` the other set that
   * fits about as well (its own split, count and runs).
   * @returns {{ k: number, count: number, runs?: { k: number, count: number }[], by: 'check'|'flag'|'count'|'madeUp',
   *   text: string, sure: boolean, alt: { k: number, count: number, runs?: { k: number, count: number }[] } | null,
   *   recount: boolean, pointed?: number, unsure?: 'where'|'late'|'next'|'slow'|null } | null}
   */
  #missedHint(race, state, bib, rv) {
    // (9.23 F16: once per Review list, as #missedStartsOf)
    const memo = rv?.legs ? (rv.legs.hintMemo ??= new Map()) : null;
    if (memo?.has(bib)) return memo.get(bib);
    const hint = this.#settled(race, state, bib, rv, this.#missedHintNow(race, state, bib, rv));
    memo?.set(bib, hint);
    return hint;
  }

  /**
   * 9.23 F19: a hint is the one click only on evidence a late start or a slow leg can't give (#lateOr, #nextOr); else it
   * is offered, Split Relay saying what it can't tell yet. 9.23 F20: the same rule for every hint, weighed by the legs
   * from pass to pass: its placing must fit clearly better than a late start with another set (#lateOr, also when the
   * hint is at a later split) and than one slow leg with every mat read (#slowOr).
   */
  #settled(race, state, bib, rv, hint) {
    return this.#nextOr(race, state, bib, rv, this.#slowOr(race, state, bib, rv, this.#lateOr(race, state, bib, rv, hint)));
  }

  /**
   * 9.23 F20: how a set of missed splits fits the runner's passes by their legs (src/review.js legShape, whenever it
   * started), as #lateOr and #slowOr weigh it: what its legs are off by together, a pass it leaves past the finish as an
   * extra pass (COUNT_RULES.extra), each missed mat CHECK_RULES.shapeGap (a finisher's trail too); `skip`, a slow leg left
   * out, costing CHECK_RULES.slowLeg (the best leg to leave out: one whose leg is slow, with a leg after it). Null when it
   * can't be measured.
   * @param {{ k: number, count: number }[]} runs
   * @returns {{ all: { k: number, count: number }[], score: number, late: number, s: any } | null}
   */
  #legScore(race, state, d, runs, { field, finish, stream, due = false, others, skip = false }) {
    const got = this.#placingOf(race, state, d, runs, finish, stream);
    if (!got) return null;
    const all = got.trail ? [...runs, got.trail] : runs;
    // (the finish mat missed too: no pass at the finish while the runner's would be in by now)
    const gone = due && !got.ev.some((e) => e.c === race.splits.length) ? 1 : 0;
    const base = COUNT_RULES.extra * got.dropped + CHECK_RULES.shapeGap * (all.reduce((a, y) => a + y.count, 0) + gone);
    if (!skip) {
      const s = legShape(got.ev, others, field.refAt);
      return s ? { all, score: s.cost * s.legs + base, late: s.late, s, gone } : null;
    }
    let out = null;
    for (let i = 1; i < got.ev.length - 1; i++) {
      const s = legShape(got.ev, others, field.refAt, i);
      // (a slow leg explains the passes only when every other leg fits closely, as the column check takes it: 586, two mats
      // missed apart, its passes kept as counted, fitted no worse with a leg left out than with one mat added; and when it
      // lost no more than CHECK_RULES.slowLost)
      if (!s || !(s.slow > 1) || s.lost > CHECK_RULES.slowLost || s.cost > CHECK_RULES.shapeClose || s.lo < 1 / CHECK_RULES.shapeCloseLeg || s.hi > CHECK_RULES.shapeCloseLeg) continue;
      const score = s.cost * s.legs + base + CHECK_RULES.slowLeg;
      if (!out || score < out.score) out = { all, score, late: s.late, s, at: got.ev[i].c, from: got.ev[i - 1].c, gone, last: got.ev.at(-1), after: got.ev.length - 1 - i };
    }
    return out;
  }

  /**
   * 9.23 F20: a one click weighed against one slow leg, every mat read (a stop, a fall): the runner's passes as counted with
   * that leg left out (#legScore `skip`, CHECK_RULES.slowLeg) fit about as well as its placing (within shapeMargin), or
   * better: Split Relay can't tell a missed mat from a slow leg (`unsure: 'leg'`, with the leg: `leg`). A slow leg is no
   * explanation for a finisher whose finish read is counted in a split (a mat missed it), and it needs a pass after it.
   * The re-check of 2026-10-30 found runners who lost 2:30 on the 900 m from 1500m to 2400m given "Missed 2400m" as the one
   * click once their 3100m pass was in (156 of 167), 4:00 lost from 2400m to 3100m "Missed 3100m and 4400m" (122), and 2:00
   * lost from 4400m to 5300m, the stream's finish pass after it, "Missed 5300m" after the race without FinishLynx (89): the
   * count fit charges a slow leg twice (the leg, and the next one against it).
   */
  #slowOr(race, state, bib, rv, hint) {
    // (9.23 F21: also a hint offered while Split Relay can't tell yet how many, its words then say the slow leg: the
    // re-check's 220, 2:30 lost from 1500m to 2400m, was "10:51.5 looks like 3100m, not 2400m (missed 2400m?) …, but Split
    // Relay can't tell yet how many" on the course, a mat missed it for all the words said)
    if (!hint || (hint.sure === false && (hint.unsure || hint.alt)) || hint.by === 'madeUp' || hint.aside?.length) return hint;
    const d = state.bibs.get(bib);
    const field = this.#checkFieldOf(race, state);
    if (!d || !field) return hint;
    const ctx = this.#legCtx(race, state, bib, d, rv, field);
    const slow = this.#legScore(race, state, d, [], { ...ctx, skip: true });
    // (every mat read: not with the finish mat missed too, no finish pass while the runner's would be in by now)
    if (!slow || slow.all.length || slow.gone) return hint;
    const own = this.#legScore(race, state, d, runsOf(hint), ctx);
    if (own && slow.score - own.score >= CHECK_RULES.shapeMargin) return hint;
    // (a slow leg with one pass after it that the runner's next pass would show, overdue: twice the field's median leg on
    // from that pass's split, as #nextOr waits. A runner who missed 3100m and 4400m has its 5300m pass in 4200m, one slow
    // leg from 2400m to 3100m about as good, the 4400m pass that leg predicts never coming: without the finish line in the
    // stream nothing else would tell)
    const legs = rv?.legs?.field;
    if (slow.after === 1 && slow.last && slow.last.c < race.splits.length - 1 && Number.isFinite(legs?.now)) {
      const ls = [];
      for (const o of legs.byCol[slow.last.c] ?? []) if (Number.isFinite(o.real?.[slow.last.c + 1])) ls.push(o.real[slow.last.c + 1] - o.real[slow.last.c]);
      ls.sort((a, b) => a - b);
      if (ls.length && slow.last.t + 2 * ls[ls.length >> 1] <= legs.now) return hint;
    }
    const names = race.splits.map((sp) => sp.name);
    // (9.23 F21: what Split Relay can't tell is said by the slow leg's words, not "how many")
    const text = typeof hint.text === 'string' ? hint.text.replace(/, but Split Relay can't tell yet how many\.$/, '.') : hint.text;
    return { ...hint, text, sure: false, unsure: 'leg', leg: { from: slow.from < 0 ? 'the gun' : names[slow.from], to: names[slow.at] ?? 'the finish', lost: slow.s.lost } };
  }

  /**
   * 9.23 F19: a one click that moves the runner's first pass (the first split missed: nothing before it to measure it
   * from) rests on where that pass is from the gun, and a runner who started late has every pass late by the same time:
   * just like a runner a mat missed at the first split, every pass a split on. On the re-check of 2026-10-30, runners two
   * to four minutes late, every mat read, had "Missed 800m: add it" as their one click from their first pass on, and a late
   * starter who also missed 2400m had it once FinishLynx's finish was known: each sent every split a column late. It stays
   * the one click only when the runner's legs from pass to pass (src/review.js legShape, whenever it started) fit it
   * clearly better (CHECK_RULES.shapeMargin) than they fit any placing that leaves the first pass where it is: as counted
   * (a late start), or with one run of missed splits after it or two apart (a late start and a mat missed later; not the
   * count fit's placings, which measure the first pass from the gun: a late starter's were all out). The one click's own
   * side may miss one more run later too (451's first one click, 800m, before 4400m and 5300m). Each placing is scored by
   * what its legs are off by together (two placings that differ in one leg differ that much: 4, who missed 800m, fitted "a
   * late start and 1500m missed" within 0.15 on average over six legs), a pass it leaves past the finish as an extra pass
   * (COUNT_RULES.extra), and each mat it misses as CHECK_RULES.shapeGap; a placing that leaves the first pass misses no more
   * mats than the one click's side (a late start and more mats missed are two rare things: 154, a walker, had "1500m, 2400m,
   * 3100m, 4400m and 5300m" offered beside "800m"). Else Split Relay can't tell (`unsure: 'late'`), and the best placing
   * that leaves the first pass is offered beside it (`alt`) when it is a set; or, when the legs fit another count from the
   * first pass clearly better than the one click's (a late start throws the count the gun gives: six minutes late, 800m
   * missed, "Missed 800m, 1500m and 2400m"), that count, with the late start the legs say. 9.23 F20: also a hint offered
   * already (not the one click), whose other set is then the one the legs fit when they fit it clearly better than the
   * hint's own other set: a late starter's passes all look late from the gun, and the gun's placings of them that fit about
   * as well can all be wrong (bib 1 five minutes late, 800m missed: "800m and 1500m (15:44.4 is a stray pass)" or "800m and
   * 1500m"; 118 six minutes late, 5300m missed: "800m" or "4200m"; the set its legs fit offered nowhere). Every placing is
   * measured with each set of passes the hint or its other set sets aside as stray passes (each one costs as an extra
   * pass) and without, the best of them counting.
   */
  #lateOr(race, state, bib, rv, hint) {
    if (!hint || hint.by === 'madeUp') return hint;
    const strays = [hint.aside, hint.alt?.aside].filter((a) => a?.length);
    const offered = hint.sure === false;
    const d = state.bibs.get(bib);
    const k0 = d ? d.kept.findIndex((c) => !!c) : -1;
    const c0 = k0 >= 0 ? d.kept[k0] : null;
    if (!c0 || c0.manual || c0.reads.some((r) => r.locKey !== '')) return hint;
    if (hint.k !== k0) return offered ? hint : this.#lateLater(race, state, bib, rv, hint);
    const cl0 = d.passInfo?.find((x) => this.#whereOf(state, d, x) === k0) ?? null;
    if (!cl0 || cl0.pin) return hint;
    const field = this.#checkFieldOf(race, state);
    if (!field) return hint;
    const n = race.splits.length;
    const finish = this.#finishOf(state, bib, d);
    const stream = rv?.legs?.field?.stream === true;
    const others = field.shapeRefs.filter((x) => x.bib !== bib);
    const hintRuns = runsOf(hint);
    const mats = (runs) => runs.reduce((a, y) => a + y.count, 0);
    // (9.23 F20: each placing with the stray passes the hint or its other set sets aside, and without them)
    const asides = [[], ...strays];
    // (a placing's runs, with the trail its finish read leaves: 5300m missed, the finish read counted in 5300m is the finish)
    const score = (runs) => {
      let out = null;
      for (const aside of asides) {
        const got = this.#placingOf(race, state, d, runs, finish, stream, aside.map((a) => a.tod));
        const s = got ? legShape(got.ev, others, field.refAt) : null;
        if (!s) continue;
        const all = got.trail ? [...runs, got.trail] : runs;
        const x = { all, aside, late: s.late, score: s.cost * s.legs + COUNT_RULES.extra * (got.dropped + aside.length) + CHECK_RULES.shapeGap * mats(all) };
        if (!out || x.score < out.score) out = x;
      }
      return out;
    };
    const best = (sets) => {
      let b = null;
      for (const runs of sets) {
        const x = score(runs);
        if (x !== null && (!b || x.score < b.score)) b = { runs: x.all, score: x.score, aside: x.aside, late: x.late };
      }
      return b;
    };
    // (the runs that can follow: from a counted pass after the first one's, moved on by the run before it)
    const after = [];
    for (let x = k0 + 1; x < n; x++) if (d.kept[x] && !d.kept[x].manual && !d.kept[x].reads.some((r) => r.locKey !== '')) after.push(x);
    const later = (first) => {
      const out = [];
      const shift = first ? first.count : 0;
      for (const b of after) if (!first || b > first.k) for (let cb = 1; b + shift + cb <= n; cb++) out.push({ k: b + shift, count: cb });
      return out;
    };
    const head = hintRuns[0];
    const own = best([hintRuns, [head], ...later(head).map((y) => [head, y])]);
    // (too few legs to tell from pass to pass: a late start explains no first pass that would have needed one longer than
    // CHECK_RULES.lateMax even at the pace of the back of the field there: a synthetic 8K's 5K pass counted in 1 mile)
    const back = Number.isFinite(field.tails?.[k0]) && Number.isFinite(field.leaders?.[k0]) ? field.tails[k0] * field.leaders[k0] : null;
    if (!own && back !== null && cl0.t - back > CHECK_RULES.lateMax) return hint;
    const keepSets = [[]];
    for (const a of later(null)) {
      keepSets.push([a]);
      for (const y of later(a)) keepSets.push([a, y]);
    }
    // (a late start and more mats missed than the one click's side needs: two rare things, not offered)
    const keep = own ? best(keepSets.filter((runs) => mats(runs) <= mats(own.runs))) : best(keepSets);
    // (another count from the first pass that the legs fit clearly better: the gun counted a late starter's first pass,
    // its 800m missed, as three splits on, and its legs say one: offered beside it, a late start's reading of it)
    let moved = null;
    for (let c = 1; k0 + c <= n; c++) {
      if (c === head.count) continue;
      const x = best([[{ k: k0, count: c }], ...later({ k: k0, count: c }).map((y) => [{ k: k0, count: c }, y])]);
      if (x && (!moved || x.score < moved.score)) moved = x;
    }
    if (moved && own && moved.score > own.score - CHECK_RULES.shapeMargin) moved = null;
    if (own && !moved && (!keep || keep.score - own.score >= CHECK_RULES.shapeMargin)) {
      // (9.23 F20: a late starter's hint the gun can't settle, its legs clearly can: the one click. With the runner itself at
      // the back of the field (src/review.js countFrame), a set that leaves a late starter's first pass where it is fits the
      // gun about as well as the one that moves it: 60, six minutes late with 800m missed, was offered "800m" or "4400m",
      // where 051d375 had "Missed 800m" sure and right. Only the gun's doubt (`unsure` 'where' or none), only when the
      // hint's own set is the one its legs fit best, starting late, and clearly better than its other set too. 9.23 F21: an
      // other set the legs can't measure is not beaten: a synthetic 8K's runner, 1 mile and 5K missed and a cool-down pass,
      // its other set's one leg too few to weigh, had "Missed 1 mile" made sure, where its row said "can't tell which")
      if (offered && !hint.aside?.length && (hint.unsure === 'where' || !hint.unsure) && own.late >= LATE_SEEN_TICKS) {
        const mine = score(hintRuns);
        const other = hint.alt ? score(runsOf(hint.alt)) : null;
        if (mine && mine.score <= own.score + 1e-9 && (!hint.alt || (other && other.score - own.score >= CHECK_RULES.shapeMargin))) return { ...hint, sure: true, alt: null, unsure: null };
      }
      return hint;
    }
    const pick = moved && (!keep || moved.score <= keep.score) ? moved : keep;
    // (a hint offered already keeps its other set unless the legs fit this one clearly better)
    if (offered) {
      const other = hint.alt ? score(runsOf(hint.alt)) : null;
      if (!pick || (other && (sameRuns(other.all, pick.runs) || pick.score > other.score - CHECK_RULES.shapeMargin))) return hint;
    }
    const r = pick?.runs ?? [];
    const alt = !r.length ? null : { ...(r.length > 1 ? { k: r[0].k, count: r[0].count, runs: r } : { k: r[0].k, count: r[0].count }),
      ...(pick.aside.length ? { aside: pick.aside.map((a) => ({ tod: a.tod, t: a.t })) } : {}) };
    // (the words stay the check's or the flag's: the panel says what Split Relay can't tell, public/app.js missedUnsureText)
    return { ...hint, sure: false, alt, unsure: 'late' };
  }

  /**
   * 9.23 F20: a one click at a later split than the runner's first pass, for a runner whose legs show a late start (its
   * placing's legShape puts its start LATE_SEEN_TICKS or more after the gun): the column check's field fractions and the
   * count fit's runners nearest in time measure every pass from the gun, so a late starter's passes all look late, the later
   * ones less, and a good pass can look like the next split's. Weighed as #lateOr weighs a first pass: the hint's set
   * against every other set of no more missed mats (one run from a counted pass, or two apart, or none) by their legs
   * (#legScore, whenever the runner started); one that fits about as well or better (within CHECK_RULES.shapeMargin) is
   * offered beside it (`unsure: 'late'`, `alt`). The re-check of 2026-10-30 found late starters one to two minutes late
   * who missed 4400m (or 4200m and 5300m), FinishLynx's finish known, given the sure and wrong "Missed 4200m" (21 to 74 of
   * 167; 4200m and 5300m: 153 to 166): its one click sent the good 4200m pass as 4400m.
   */
  #lateLater(race, state, bib, rv, hint) {
    const d = state.bibs.get(bib);
    const field = this.#checkFieldOf(race, state);
    if (!d || !field || hint.aside?.length) return hint;
    const n = race.splits.length;
    const ctx = this.#legCtx(race, state, bib, d, rv, field);
    const hintRuns = runsOf(hint);
    const own = this.#legScore(race, state, d, hintRuns, ctx);
    if (!own || !(own.late >= LATE_SEEN_TICKS)) return hint;
    const mats = (runs) => runs.reduce((a, y) => a + y.count, 0);
    const most = mats(own.all);
    // (the runs that can be: from a counted pass, moved on by the run before it; no more missed mats than the hint's)
    const ks = [];
    for (let x = 0; x < n; x++) if (d.kept[x] && !d.kept[x].manual && !d.kept[x].reads.some((r) => r.locKey !== '')) ks.push(x);
    const from = (first, left) => {
      const out = [];
      const shift = first ? first.count : 0;
      for (const b of ks) if (!first || b > first.k) for (let cb = 1; cb <= left && b + shift + cb <= n; cb++) out.push({ k: b + shift, count: cb });
      return out;
    };
    const sets = [[]];
    for (const a of from(null, most)) {
      sets.push([a]);
      for (const y of from(a, most - a.count)) sets.push([a, y]);
    }
    let best = null;
    for (const runs of sets) {
      if (sameRuns(runs, hintRuns)) continue;
      const x = this.#legScore(race, state, d, runs, ctx);
      if (!x || mats(x.all) > mats(own.all) || sameRuns(x.all, own.all)) continue;
      if (!best || x.score < best.score) best = x;
    }
    if (!best || best.score - own.score >= CHECK_RULES.shapeMargin) return hint;
    const r = best.all;
    const alt = !r.length ? null : r.length > 1 ? { k: r[0].k, count: r[0].count, runs: r } : { k: r[0].k, count: r[0].count };
    // (both sets keep the runner's first pass where it is: what tells them apart is which mats missed it, not when it
    // started, as the words say it: "Split Relay can't tell which mats missed the runner")
    return { ...hint, sure: false, alt, unsure: alt ? 'where' : 'late' };
  }

  /** 9.23 F20: what #legScore weighs a runner's sets against: the check's field, the runner's finish, the stream's finish passes. */
  #legCtx(race, state, bib, d, rv, field) {
    const legs = rv?.legs?.field;
    const finish = this.#finishOf(state, bib, d);
    // (the runner's finish pass would be in by now: a placing with none at the finish missed the finish mat too, as the
    // count fit takes it, COUNT_RULES.finishAfter)
    const last = d.passInfo?.at(-1)?.t;
    const due = finish === null && legs?.stream === true && Number.isFinite(legs.finishWait) && Number.isFinite(legs.now) && Number.isFinite(last) && last + legs.finishWait <= legs.now;
    return { field, finish, stream: legs?.stream === true, due, others: field.shapeRefs.filter((x) => x.bib !== bib) };
  }

  /**
   * 9.23 F19: a one click whose pass that moves on is the runner's latest, on the course, rests on one leg: a runner who
   * lost minutes on it (a stop, a fall) looks just like one a mat missed, until its next pass. On the re-check of
   * 2026-10-30, runners who lost 2:30 on the 700 m from 2400m to 3100m, every mat read, had "Missed 3100m: add it" as their
   * one click right after their 3100m pass. It is the one click once a later pass of the runner is in, or its finish is
   * known, or its next pass is overdue (twice the field's median leg to the split after the one the pass would go to, or
   * to the finish pass when the stream carries them); until then it is offered (`unsure: 'next'`). While its finish is
   * unknown, a pass that fits the split it would go to loosely (MOVED_FIT_WITHIN) is offered whatever came after it
   * (`unsure: 'slow'`): its finish tells.
   */
  #nextOr(race, state, bib, rv, hint) {
    if (!hint || hint.sure === false || hint.by === 'madeUp') return hint;
    const d = state.bibs.get(bib);
    const field = rv?.legs?.field;
    if (!d || !field || this.#finishOf(state, bib, d) !== null) return hint;
    const n = race.splits.length;
    const cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === hint.k) ?? null;
    if (!cl) return hint;
    // (9.23 F20: the runner's latest pass soon after the one before it where the one click puts them, a leg shorter than
    // anybody covers there, may be a stray pass, and only its next pass can tell (#straysOf weighs no stray at the runner's
    // last pass): the one click waits for that pass. On the course, 2400m missed and a read 40 s after its 3100m pass,
    // "Missed 2400m: add it" was the sure one click until its 4200m pass, the stray going out as 4200m: 158 of 167 on
    // 051d375)
    const cr = (d.checkRunner ??= this.#checkRunnerOf(state, bib, d, n));
    const lastI = cr && !cr.located ? cr.passes.length - 1 : -1;
    if (lastI > 0 && cr.passes[lastI].t >= cl.t) {
      const cf = this.#checkFieldOf(race, state);
      const pa = cr.passes[lastI - 1].col;
      const pb = cr.passes[lastI].col;
      const a = runShift(runsOf(hint), pa);
      const b = runShift(runsOf(hint), pb);
      const leg = cr.passes[lastI].t - cr.passes[lastI - 1].t;
      // (where nobody has covered the stretch it would go to yet, the runner at the front, the stretch it is counted on)
      const at = cf && b < n ? strayLegAt(cf, a, b, leg) : false;
      if (at === true || (at === null && strayLegAt(cf, pa, pb, leg) === true)) return { ...hint, sure: false, unsure: 'next' };
    }
    const to = runShift(runsOf(hint), hint.k);
    // (9.23 F20: a pass that would be the finish pass too, when the stream carries finish passes: a slow leg to the last
    // split puts its pass at the finish's time, and the runner's finish pass comes after it. The re-check of 2026-10-30
    // found runners who lost 2:00 on the 900 m from 4400m to 5300m given "Missed 5300m: add it" at once, 89 of 167)
    // (only the last split's pass: one counted before it that looks like the finish would need minutes more than any slow
    // leg loses, CHECK_RULES.slowLost, two splits and the finish still to come)
    if (to >= n && (!field.stream || hint.k < n - 1)) return hint;
    const me = rv.legs.runners?.get(bib);
    // (9.23 F21: the last split's pass that the one click makes the finish, and the stream's next pass after it: as one slow
    // leg reads them, that pass is the runner's finish pass. When it came about when the runners nearest in time there
    // reach their finish pass (within FIT_RULES.fitWithin, as the count fit takes a pass that moves on), the slow leg fits
    // as well, and a cool-down pass could have come then or any time: Split Relay can't tell. Three minutes lost from 4400m
    // to 5300m by a runner of the back of the field, its finish pass 4:04 after its 5300m pass as always, made "Missed
    // 5300m" the sure one click on the course, its real 5300m pass taken for the finish)
    const asideT = new Set((hint.aside ?? []).map((a) => a.tod));
    const nxF = to >= n ? d.passInfo.find((x) => x.t > cl.t && x.how !== 'ignored' && !asideT.has(x.tod)) ?? null : null;
    if (me && nxF && this.#whereOf(state, d, nxF) === 'extra' && field.stream && Number.isFinite(me.kept?.[n - 1]) && me.kept[n - 1] === cl.t) {
      // (what that slow leg lost, the leg as legFits measures it: no more than any slow leg loses, CHECK_RULES.slowLost; a
      // synthetic 5K of mile splits, its last split missed, would have lost the 1.8 km to the finish, 6 to 7 minutes)
      const ta = me.kept.filter((t, c) => Number.isFinite(t) && c < hint.k && t < cl.t).at(-1);
      const here = Number.isFinite(ta) ? legFits(field, me, cl.t, [hint.k])[0] : null;
      const lost = here && here.fit > 1 ? (cl.t - ta) * (1 - 1 / here.fit) : null;
      const f = lost !== null && lost <= CHECK_RULES.slowLost ? legFits(field, me, nxF.t, [n])[0] : null;
      // (at the runner's own pace: the median of its legs before, each over the runners' nearest in time there; a walker's
      // are 1.8 times theirs, its finish pass too)
      const paces = [];
      for (let c = 1; c < n - 1; c++) {
        const g = Number.isFinite(me.kept?.[c]) && Number.isFinite(me.kept?.[c - 1]) ? legFits(field, me, me.kept[c], [c])[0] : null;
        if (g) paces.push(g.fit);
      }
      paces.sort((a, b) => a - b);
      const pace = paces.length >= 3 ? paces[paces.length >> 1] : 1;
      if (f && Math.abs(Math.log(f.fit / pace)) <= Math.log(FIT_RULES.fitWithin)) {
        const names = race.splits.map((sp) => sp.name);
        return { ...hint, sure: false, unsure: 'leg', leg: { from: names[n - 2] ?? 'the gun', to: names[n - 1], lost } };
      }
    }
    // (not a pass later than any slow leg makes one, CHECK_RULES.slowLost after the runners of its pace at the split it is in: the
    // walker 91, 4400m and 5300m missed, its finish read 8:43 after them at 4400m, the race's last runner, had no next pass
    // to wait for)
    if (to >= n && me) {
      // (the leg as legFits measures it: from the runner's latest crossing before the pass)
      const ta = me.kept.filter((t, c) => Number.isFinite(t) && c < hint.k && t < cl.t).at(-1);
      const here = Number.isFinite(ta) ? legFits(field, me, cl.t, [hint.k])[0] : null;
      if (here && here.fit > 1 && (cl.t - ta) * (1 - 1 / here.fit) > CHECK_RULES.slowLost) return hint;
    }
    // (and, while the runner's finish is unknown, only when that pass fits the split it would go to closely: a real missed
    // mat's moved pass fits within MOVED_FIT_WITHIN of the runners of its pace nearly always, a leg a minute or two slower
    // than theirs fits the split after it loosely, and later passes do not always undo it: 2:00 lost on the 700 m from
    // 800m to 1500m, 0.74 of the runners' leg to 2400m, was the one click two passes on)
    const fit = me && to < n ? legFits(field, me, cl.t, [to])[0]?.fit : undefined;
    if (Number.isFinite(fit) && Math.abs(Math.log(fit)) > Math.log(MOVED_FIT_WITHIN)) return { ...hint, sure: false, unsure: 'slow' };
    // (9.23 F20: nor when that pass fits the split it is counted in better than the one it would go to: the one click rests
    // on a later pass then, which one slow leg explains as well. Two minutes lost on the 200 m from 4200m to 4400m put the
    // 4400m pass where the runners of its pace pass 5300m, and "Missed 4200m" moved the good 4200m pass to 4400m, 0.89 of
    // their leg there where it fitted 4200m within 1.08: the sure one click on the course for 30 of 167. Not for a runner
    // whose legs show a late start: the runners nearest it in time are slower, and a late starter's real 4400m pass counted
    // in 4200m fitted 4200m as well, 570 two minutes late, sure and right at its finish read on 051d375)
    const own = me && to < n ? legFits(field, me, cl.t, [hint.k])[0]?.fit : undefined;
    if (Number.isFinite(fit) && Number.isFinite(own) && Math.abs(Math.log(own)) < Math.abs(Math.log(fit))) {
      const cf = this.#checkFieldOf(race, state);
      const sc = cf ? this.#legScore(race, state, d, runsOf(hint), this.#legCtx(race, state, bib, d, rv, cf)) : null;
      if (!(sc && sc.late >= LATE_SEEN_TICKS)) return { ...hint, sure: false, unsure: 'leg' };
    }
    // (9.23 F20: a stray pass the hint sets aside is no later pass)
    const aside = new Set((hint.aside ?? []).map((a) => a.tod));
    // (9.23 F20: and the runner's next pass fits where the one click puts it or a split after it (another mat missed there,
    // F16's second run, which its own one click follows), measured from that pass where it puts it: three or four minutes
    // lost on the 700 m from 800m to 1500m put the runner's 1500m pass where the runners of its pace pass 2400m, and only
    // the leg after it, its 2400m pass as 3100m, 1.4 times theirs and half of theirs to 4200m, tells it from a missed 1500m,
    // too few legs yet to weigh one slow leg (#slowOr): "Missed 1500m" was the sure one click for 162 of 167 once that pass
    // was in)
    const nx = d.passInfo.find((x) => x.t > cl.t && x.how !== 'ignored' && !aside.has(x.tod)) ?? null;
    const kx = nx ? this.#whereOf(state, d, nx) : null;
    // (a stray pass the hint sets aside before it takes no split: it counts one back, as #placingOf places it)
    const back = nx ? d.passInfo.filter((x) => aside.has(x.tod) && x.t < nx.t && typeof this.#whereOf(state, d, x) === 'number').length : 0;
    const to2 = typeof kx === 'number' ? runShift(runsOf(hint), kx - back) : null;
    if (me && to < n && to2 !== null && to2 > to && to2 <= n) {
      const kept = new Array(n).fill(null);
      for (let c = 0; c < hint.k; c++) kept[c] = me.kept?.[c] ?? null;
      kept[to] = cl.t;
      const cols = [];
      for (let c = to2; c <= n; c++) cols.push(c);
      const fits = legFits(field, { ...me, kept }, nx.t, cols);
      if (fits.length && fits[0].col === to2 && fits.every((f) => Math.abs(Math.log(f.fit)) > Math.log(MOVED_FIT_WITHIN))) return { ...hint, sure: false, unsure: 'leg' };
    }
    if (nx) return hint;
    // the field's median leg from column c to the next split (from the last split: to the finish pass, when the stream
    // carries them; else no pass follows it)
    const legOf = (c) => {
      if (c >= n - 1) return field.stream && Number.isFinite(field.finishWait) ? field.finishWait / COUNT_RULES.finishAfter : null;
      const legs = [];
      for (const o of field.byCol[c] ?? []) if (Number.isFinite(o.real?.[c + 1])) legs.push(o.real[c + 1] - o.real[c]);
      legs.sort((a, b) => a - b);
      return legs.length ? legs[legs.length >> 1] : null;
    };
    // its next pass: the split after `to` when the hint is right, the split after hint.k when it is not (a slow leg); a
    // leg nobody has run yet (a runner at the front) can't be waited for
    const right = legOf(to);
    const wrong = legOf(hint.k);
    if (to === n - 1 && !field.stream && wrong === null) return hint;
    const wait = wrong === null ? null : 2 * Math.max(wrong, right ?? 0);
    if (wait !== null && Number.isFinite(field.now) && cl.t + wait <= field.now) return hint;
    return { ...hint, sure: false, unsure: 'next' };
  }

  /**
   * 9.23 F19: the runner's passes as a set of missed splits would place them (`runs`, none: as counted), in time order,
   * for src/review.js legShape: each counted pass moved on by the runs (runShift), past the last split the first the
   * finish pass when the stream carries them (the rest cool-down passes, left out: `dropped`); with the runner's finish
   * known, a pass within FINISH_NEAR_TICKS of it is that finish, it comes last, and a placing that leaves a pass between
   * the last split and it is none (null); one that leaves the finish read in a split misses every split from there on
   * (`trail`, as src/review.js missedStarts' finisher's trail).
   * @returns {{ ev: { t: number, c: number }[], dropped: number, trail: { k: number, count: number } | null } | null}
   */
  #placingOf(race, state, d, runs, finish, stream, aside = []) {
    const n = race.splits.length;
    const shift = runs.reduce((a, r) => a + r.count, 0);
    const ev = [];
    let past = 0;
    let dropped = 0;
    let trail = null;
    // (9.23 F20: a stray pass set aside takes no split: the passes after it count one back)
    let back = 0;
    for (const x of d.passInfo ?? []) {
      const w = this.#whereOf(state, d, x);
      if (aside.includes(x.tod)) {
        if (typeof w === 'number') back++;
        continue;
      }
      let c;
      if (typeof w === 'number') c = runShift(runs, w - back);
      else if (w === 'extra') c = n + shift + past++;
      else continue;
      if (finish !== null) {
        // (the finish read left in a split: every split from there on is missed too, the finisher's trail)
        if (x.t >= finish - FINISH_NEAR_TICKS) {
          if (c < n && !trail) trail = { k: c, count: n - c };
          continue;
        }
        if (c >= n) return null;
      } else if (c > n || (c === n && (!stream || ev.some((e) => e.c === n)))) {
        dropped++;
        continue;
      }
      ev.push({ t: x.t, c });
    }
    if (finish !== null) ev.push({ t: finish, c: n });
    return { ev, dropped, trail };
  }

  /** #missedHint, worked out. */
  #missedHintNow(race, state, bib, rv) {
    const n = race.splits.length;
    const names = race.splits.map((sp) => sp.name);
    const sus = state.check?.suspects.get(bib);
    let base;
    if (sus) {
      const mv = sus.moves.find((x) => x.missed.length > 0 && x.to > x.from && x.from < n);
      if (!mv) return null;
      const c = state.bibs.get(bib)?.kept[mv.from];
      base = { k: mv.from, count: Math.min(mv.to, n) - mv.from, by: 'check', text: c ? state.check.held.get(c.key)?.text ?? '' : '' };
    } else {
      const f = rv?.legs?.flags.get(bib);
      // (9.23 F14: a made-up time that does not fit is the real cause of a short leg after it, "A stray pass?")
      if (!f || f.silenced || !f.suggest || f.suggest.to === 'none') return rv?.causes?.get(bib) ?? null;
      const to = f.suggest.to === 'finish' ? n : f.suggest.to;
      if (!(to > f.col)) return rv?.causes?.get(bib) ?? null;
      base = { k: f.col, count: to - f.col, by: 'flag', text: f.text };
    }
    // 9.23 F15: where the run starts, from all of the runner's passes: at another split than base's (its own hint), or
    // Split Relay can't tell yet where (nothing is the one click)
    const start = this.#missedStartOf(race, state, bib, rv, base);
    if (start?.hint) return start.hint;
    const where = start?.unsure === true;
    const one = { ...base, sure: !where, alt: null, recount: false, unsure: where ? 'where' : null };
    // (9.23 F17: while Split Relay can't tell yet where, the set of all of the runner's passes that fits best is offered
    // beside the cell's own when it is another one: 491 without the finish passes, 800m, 1500m and 4200m missed, was
    // offered "Missed 2400m" alone, its passes where they are fitting about as well as the right set)
    const best = (h) => {
      if (!where || !start?.best || h.alt) return h;
      const r = startRuns(start.best);
      if (sameRuns(r, runsOf(h))) return h;
      return { ...h, alt: r.length > 1 ? { k: start.best.k, count: start.best.count, runs: r } : { k: start.best.k, count: start.best.count } };
    };
    // (a missed last split has one count only; 9.23 F15: so has a pass that is the runner's known finish, a finish read
    // in the split the check or the flag points at: every split from there on was missed. The count fit has no pass to
    // place there, and took the fewest: "missed 4200m, or 4200m and 4400m?" for a finisher who missed the last three)
    if (base.k + 1 >= n) return best(one);
    const d = state.bibs.get(bib);
    const fin = d ? this.#finishOf(state, bib, d) : null;
    const at = d?.passInfo?.find((x) => this.#whereOf(state, d, x) === base.k);
    if (fin !== null && at && at.t >= fin - FINISH_NEAR_TICKS) {
      if (base.k + base.count === n) return best(one);
      return best({ ...one, count: n - base.k, recount: base.by === 'check',
        text: `${formatRaceTime(at.t, 1)} looks like the finish, not ${names[base.k]} (missed ${listWords(names.slice(base.k))}?)` });
    }
    const got = this.#missedCountOf(race, state, bib, rv, base.k);
    const fit = got?.fit;
    // no count fits (a runner who walked): as the check or the flag says; one that can't be measured yet: not sure
    if (!fit || fit.count === null) return best(fit?.open ? { ...one, sure: false } : one);
    const recount = base.by === 'check' && fit.count !== base.count;
    if (fit.sure && fit.count === base.count) return best(one);
    if (where) return best({ ...one, count: fit.count, recount, text: missedCountText({ ...fit, alt: null, sure: true }, got.cl.t, base.k, names) });
    return { ...base, count: fit.count, sure: fit.sure, alt: fit.alt !== null ? { k: base.k, count: fit.alt } : null, recount, unsure: null,
      text: missedCountText(fit, got.cl.t, base.k, names) };
  }

  /**
   * 9.23 F14: a run of made-up times from column k that the runner's later passes do not fit: an earlier "Missed …: add
   * it" with too few splits (459 on the re-check of 2026-10-27: its 2400m made up from 15:18.4, which is its 4200m), or a
   * fill measured from a pass in the wrong split. With them left out and the next real pass counted at k, the runner's
   * passes fit another count clearly (missedCounts): that is the fix, "Missed <split>: add it" on the made-up cell, which
   * makes them up again (#missedPlan). Null when they fit, when Split Relay can't tell, or when the operator said the
   * pass after them is right (It's right).
   * @param {{ field: any, runners: Map<string, any> }} legs the look-wrong check's field and runners
   * @returns {ReturnType<Engine['#missedHint']>}
   */
  #madeUpHint(race, state, bib, legs) {
    const n = race.splits.length;
    const d = state.bibs.get(bib);
    const me = legs?.runners.get(bib);
    if (!d || !me || !legs.field) return null;
    const names = race.splits.map((sp) => sp.name);
    for (let k = 0; k < n; k++) {
      if (!d.kept[k]?.manual?.estimated || d.kept[k - 1]?.manual?.estimated) continue;
      // the run from k: made-up times (and empty splits) up to the runner's next real pass
      let j = k;
      while (j < n && (!d.kept[j] || d.kept[j].manual?.estimated)) j++;
      const nx = j < n ? d.kept[j] : null;
      if (!nx || nx.manual || nx.reads.some((r) => r.locKey !== '')) continue;
      const cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === j) ?? null;
      if (!cl || cl.pin?.seen) continue;
      const kept = me.kept.slice();
      for (let x = k; x < j; x++) kept[x] = null;
      const { passes, upTo } = this.#countPasses(race, state, d, cl, j);
      const fit = missedCounts(legs.field, { ...me, kept }, k, passes, { finish: upTo === n ? this.#finishOf(state, bib, d) : null, near: FINISH_NEAR_TICKS, upTo });
      if (!fit.sure || fit.count === null || fit.count === j - k) continue;
      const run = [];
      for (let x = k; x < j; x++) if (d.kept[x]) run.push(x);
      const what = `${listWords(run.map((x) => names[x]))}'s made-up ${listWords(run.map((x) => formatRaceTime(d.kept[x].rt, 1)))} ${run.length === 1 ? "doesn't" : "don't"} fit`;
      return { k, count: fit.count, by: 'madeUp', sure: true, alt: null, recount: false, j, tod: cl.tod, text: `${what}: ${missedCountText(fit, cl.t, k, names, { now: j })}` };
    }
    return null;
  }

  /**
   * 9.23 F17: the column of a runner's first crossing when it is a pass Split Relay counted there that is far past the back
   * of the field (src/review.js pastField: the others', beyond CHECK_RULES.tailGap), else null: a pass of a later split
   * that nothing else points at (221's 2400m pass, 8:49.0, in 800m). A late start or a walker is not moved by it: the
   * fix is one only when the fit of all of the runner's passes says so (#countHint).
   */
  #farBehind(race, state, bib, legs) {
    const d = state.bibs.get(bib);
    const me = legs?.runners.get(bib);
    if (!d || !me || !legs.field) return null;
    const c0 = d.kept.findIndex((c) => !!c);
    const c = c0 >= 0 ? d.kept[c0] : null;
    if (!c || c.manual || c.reads.some((r) => r.locKey !== '')) return null;
    const cl = d.passInfo?.find((x) => this.#whereOf(state, d, x) === c0) ?? null;
    if (!cl || !(cl.how === 'counted' || cl.how === 'earliest' || cl.how === 'shifted') || cl.pin) return null;
    return pastField(legs.field, me, c0, c.rt) ? c0 : null;
  }

  /**
   * 9.23 F14: the run of missed mats that explains a leg that looks wrong when neither check points at one (the first two
   * missed: every pass two columns early, the column check places none of them, and the look-wrong check sees a short
   * leg only). From the first split to the flagged one, the first column where the runner's passes moved on fit a count
   * clearly (missedCounts) and clearly better than where they are (by a misfit's worth, so a runner whose splits are
   * right is not moved by it). Null when none does, or when the operator said the pass there is right (It's right).
   * 9.23 F16: or the placing of all of the runner's passes that fits clearly best (#missedStartsOf, as for the column
   * check and a flag that points at a split) starts there, and is better than where they are by a misfit's worth: two
   * mats missed apart, the first at the first split, by the slowest runners (800m and 3100m: their 1500m pass in 800m is
   * beyond the back of the field there, so the flag only says "9:57.6 comes late for 1500m … A missed mat?"). 9.23 F17:
   * or no flag at all, the runner's first pass far past the back of the field (#farBehind): `f` is then its column only.
   * @param {{ field: any, runners: Map<string, any> }} legs
   * @param {{ col: number }} f the runner's look-wrong flag
   * @returns {ReturnType<Engine['#missedHint']>}
   */
  #countHint(race, state, bib, legs, f) {
    const d = state.bibs.get(bib);
    const me = legs.runners.get(bib);
    if (!d || !me || !legs.field) return null;
    const names = race.splits.map((sp) => sp.name);
    // 9.23 F16: the placing of all of the runner's passes (#missedStartsOf) that fits clearly best and better than where
    // they are by a misfit's worth; when it is two runs apart it is the cause, before a run in a row the loop below
    // finds (1K and 3K missed on a course of even splits: "Missed 2K: add it" left the 2K pass in 1K)
    const got = this.#missedStartsOf(race, state, bib, { legs });
    let x = got?.fit.ok[0] ?? null;
    if (x) {
      let rival = null;
      for (const y of [...got.fit.ok.slice(1), ...got.fit.loose]) if (!rival || y.cost < rival.cost) rival = y;
      // (9.23 F20: for a leg shorter than anybody covers, the passes as counted are no reading at all: a set that sets the
      // stray aside need only fit better; for one shorter than the runner's own pace only, ownStray, by a misfit's worth)
      const worse = f.stray && !f.ownStray && x.aside ? x.cost < got.fit.none.cost : x.cost + COUNT_RULES.misfit < got.fit.none.cost;
      if (x.k > f.col || got.cls[x.k]?.pin?.seen || got.fit.open || (rival && rival.cost - x.cost < startMargin(x)) || !(got.fit.none.out || worse)) x = null;
    }
    const fromStart = () => {
      const runs = startRuns(x);
      // (9.23 F21: a set whose run starts after the stray it sets aside moves the pass after the stray on, not the one
      // counted in its split now: the stray is)
      const after = !!x.aside && Number.isFinite(x.moved) && x.moved > x.aside[0].t;
      const cl = (after ? d.passInfo.find((y) => y.t === x.moved) : null) ?? got.cls[x.k];
      const text = runs.length > 1 ? missedRunsText(x, names) : missedCountText({ count: x.count, alt: null, sure: true, fits: [{ count: x.count, path: x.path.slice(x.first) }] }, cl.t, x.k, names);
      // (9.23 F20: and the stray pass it sets aside; 9.23 F21: first when it came first)
      const sw = x.aside ? strayWords(this.#strayPrev(state, d, x.aside[0]), x.aside[0], !!x.near) : '';
      // (9.23 F21: a stray set its legs fit only about as well as the passes as read, #strayLegsFit `near`: offered, Split
      // Relay can't tell a stray pass from a fast leg)
      return { k: x.k, count: x.count, ...(runs.length > 1 ? { runs } : {}), ...(x.aside ? { aside: x.aside.map((a) => ({ tod: a.tod, t: a.t })) } : {}), by: 'count',
        sure: !x.near, alt: null, recount: false, j: x.k, tod: cl.tod, ...(x.near ? { unsure: 'stray' } : {}), text: !x.aside ? text : after ? `${sw} ${text}` : `${text} ${sw}` };
    };
    // (9.23 F20: a set that sets a stray pass aside is the cause too: the count fit below has no such placing)
    if (x && (startRuns(x).length > 1 || x.aside)) return fromStart();
    for (let k = 0; k <= f.col && k < race.splits.length; k++) {
      const c = d.kept[k];
      if (!c || c.manual || c.reads.some((r) => r.locKey !== '')) continue;
      const got = this.#missedCountOf(race, state, bib, { legs }, k, true);
      // (the operator said that pass is right: It's right)
      if (got?.cl.pin?.seen) return null;
      const fit = got?.fit;
      if (!fit?.sure || fit.count === null || !fit.none) continue;
      const best = fit.fits.find((y) => y.count === fit.count);
      if (!(fit.none.out || best.cost + COUNT_RULES.misfit < fit.none.cost)) continue;
      return { k, count: fit.count, by: 'count', sure: true, alt: null, recount: false, j: k, tod: got.cl.tod, text: missedCountText(fit, got.cl.t, k, names) };
    }
    return x ? fromStart() : null;
  }

  /**
   * What Passes to check and the runner editor say about a held pass at column k: the column check's words, or, when
   * the runner's later passes put its first moved pass elsewhere (9.23 F14, #missedHint's `recount`), or Split Relay
   * can't tell how far, the hint's words for that pass and for the later ones the place they go to with it ("an extra
   * pass" past the finish).
   * @returns {{ to: string|null, toName: string, reason: string }}
   */
  #heldWords(race, hint, k, chk) {
    const n = race.splits.length;
    const own = { to: chk.to, toName: chk.to === null ? 'the finish' : race.splits.find((x) => x.id === chk.to)?.name ?? '', reason: chk.text };
    if (!hint || k < hint.k || (k > hint.k && !hint.recount) || (k === hint.k && !hint.recount && hint.text === chk.text)) return own;
    // (9.23 F16: with two runs apart, a pass after the second run's moves on by both)
    const runs = runsOf(hint);
    const to = runShift(runs, k);
    const toName = to < n ? race.splits[to].name : to === n ? 'the finish' : 'an extra pass';
    const at = runCols(runs).indexOf(k);
    const run = at > 0 ? runs[at] : null;
    // (in the check's own form: "Looks like 3100m, not 1500m (…)", the time beside it already, and no full stop: "…
    // Held until you choose." follows them; the second run's own pass says which split it missed too)
    let reason = k === hint.k ? hint.text.replace(/^[\d:.]+ looks like /, 'Looks like ').replace(/\.$/, '')
      : run ? `Looks like ${toName}, not ${race.splits[k].name} (it moves with the pass before it, and ${listWords(race.splits.slice(run.k, run.k + run.count).map((sp) => sp.name))} ${run.count > 1 ? 'were' : 'was'} missed too)`
        : to > n ? `An extra pass, not ${race.splits[k].name} (it moves with the pass before it)`
          : `Looks like ${toName}, not ${race.splits[k].name} (it moves with the pass before it)`;
    // (9.23 F17: while Split Relay can't tell which of two sets, a later held pass says where each puts it, as the row of
    // the hint does: 568's 22:31.3, "Looks like 5300m or the finish, not 4400m", not "the finish" alone)
    if (k > hint.k && hint.sure === false && hint.alt) {
      const to2 = runShift(runsOf(hint.alt), k);
      const nameOf = (c) => (c < n ? race.splits[c].name : c === n ? 'the finish' : 'an extra pass');
      const tos = [...new Set([to, to2].filter((c) => c !== k).map((c) => (c > n ? n + 1 : c)))].sort((a, b) => a - b).map(nameOf);
      if (to2 !== to && !(to > n && to2 > n)) {
        // (the other set's run starts at this pass: it moves with the pass before it in one set only, so the hint's
        // question, as the row says it: 568's 22:31.3, "(missed 4400m, or 4200m and 5300m?)")
        const q = runCols(runsOf(hint.alt)).includes(k) ? hint.text.match(/\(missed [^()]*\?\)/)?.[0] ?? null : null;
        reason = `Looks like ${tos.join(' or ')}, not ${race.splits[k].name}${to2 === k || to === k ? `, or it is ${race.splits[k].name}` : ''}`
          + (q ? `: Split Relay can't tell which ${q}` : " (it moves with the pass before it): Split Relay can't tell which");
      } else {
        // (9.23 F18: both sets put it in the same place but miss other splits on the way to it: the row's question, not
        // one set's splits as a fact; 568, 3100m, 4200m and 5300m missed, a finisher: its 28:22.6 said "… and 4400m and
        // 5300m were missed too", the first set's)
        const at2 = runCols(runsOf(hint.alt)).indexOf(k);
        const run2 = at2 > 0 ? runsOf(hint.alt)[at2] : null;
        if ((run?.k ?? null) !== (run2?.k ?? null) || (run?.count ?? 0) !== (run2?.count ?? 0)) {
          const q = hint.text.match(/\(missed [^()]*\?\)/)?.[0] ?? null;
          reason = `${to > n ? 'An extra pass' : `Looks like ${toName}`}, not ${race.splits[k].name} (it moves with the pass before it): Split Relay can't tell which${q ? ` ${q}` : ''}`;
        }
      }
    }
    return { to: to < n ? race.splits[to].id : null, toName, reason };
  }

  /**
   * A missed-split hint as the Review list's items carry it: the split, how many, their names, whether it is the one
   * click (`sure`), and the other count Split Relay can't tell from (`alt`); with the hint's cell (#missedView), what
   * each does ("15:18.4 → 4200m, …") and whether it can be done. 9.23 F16: a set of two runs apart has `runs` (each
   * its split and count) and `read`, the splits read between them; `names` are all of its splits ("Missed 4200m and
   * 5300m: add them (4400m was read)"); `alt` is another set, with its own split and pass.
   */
  #missedOut(race, hint, view = null) {
    if (!hint) return null;
    // (9.23 F15: the pass that moves on, for a row of another pass: the hint's split is not always the row's)
    const what = (v) => (v ? { ok: v.ok, why: v.why, effect: v.effect, splits: v.splits, passTod: v.passTod } : {});
    return { ...this.#missedSet(race, hint), by: hint.by, sure: hint.sure !== false, unsure: hint.unsure ?? null, ...legOut(hint),
      alt: hint.alt ? { ...this.#missedSet(race, hint.alt), ...what(view?.alt) } : null, ...what(view) };
  }

  /**
   * A set of missed splits in words for the panel (9.23 F16): its first split, how many in a row from it, every split's
   * name, and with two runs apart each run and the splits read between them.
   * @param {{ k: number, count: number, runs?: { k: number, count: number }[] }} h
   */
  #missedSet(race, h) {
    const n = race.splits.length;
    const runs = runsOf(h);
    const names = runs.flatMap((r) => race.splits.slice(r.k, Math.min(n, r.k + r.count)).map((sp) => sp.name));
    const out = { splitId: race.splits[h.k].id, splitName: race.splits[h.k].name, count: h.count, names,
      // (9.23 F20: the stray passes it sets aside: "Missed 2400m: add it (11:24.4 is a stray pass)")
      ...(h.aside?.length ? { aside: h.aside.map((a) => ({ passTod: a.tod, timeText: formatRaceTime(a.t, 1) })) } : {}) };
    if (runs.length < 2) return out;
    const gaps = readGaps(runs, race.splits);
    // (9.23 F17: readText, the words of the splits read, a long stretch as "1500m to 4400m")
    return { ...out, runs: runs.map((r) => ({ splitId: race.splits[r.k].id, splitName: race.splits[r.k].name, count: r.count })), read: gaps.flat(), readText: readWords(gaps) };
  }

  /**
   * The runner editor's "Missed <split>: add it" for one cell (9.23 F13), or null where it does not apply (no pass in the
   * cell, a made-up time, a timing point): whether it can be done (and why not), the suggested time of each missed
   * split, and what it does to the runner's passes ("11:05.9 → 3100m, … 22:41.8 → extra pass"). `here`: the column
   * check or the look-wrong check points at this split (the editor says "missed here?"); count is then the hint's, with
   * `sure` (the one click) and, when Split Relay can't tell which, `alt`: the other count, as a choice of its own.
   * 9.23 F16: the hint's set, two runs apart too (`runs`); its `alt` may start at another split, with its own pass.
   */
  #missedView(race, state, bib, d, k, hint, rv, refs) {
    const n = race.splits.length;
    const c = d?.kept[k] ?? null;
    const markedLast = !c && k === n - 1 && d?.passInfo?.some((x) => x.how === 'finish');
    // (9.23 F14: a made-up time its later passes do not fit: the fix is on it)
    const madeUp = !!c?.manual?.estimated && hint?.by === 'madeUp' && hint.k === k;
    if (!markedLast && !madeUp && (!c || c.manual || c.reads.some((r) => r.locKey !== ''))) return null;
    const here = !!hint && hereOf(hint) === k;
    // (9.23 F21: with the slow leg, as the Review row has it: the editor's line said "can't tell a missed mat from a slow
    // leg" without which leg)
    const view = { ...this.#missedChoice(race, state, bib, d, here ? hint : { k, count: 1 }, rv, refs, here ? hint : null), here, by: here ? hint.by : null,
      reason: here ? hint.text : '', sure: here ? hint.sure !== false : true, unsure: here ? hint.unsure ?? null : null, ...(here ? legOut(hint) : {}), alt: null };
    if (here && hint.alt) view.alt = this.#missedChoice(race, state, bib, d, hint.alt, rv, refs, hint);
    // (9.23 F20: the cell's own split alone, for a time typed there, "Missed 800m: type its time…", also when the hint and
    // its other set are sets of several splits: the re-check found three mats missed apart that could not be typed at all)
    const single = (h) => !!h && h.k === k && h.count === 1 && runsOf(h).length === 1 && !h.aside?.length;
    if (here && c && !c.manual && !single(hint) && !single(hint.alt)) view.one = this.#missedChoice(race, state, bib, d, { k, count: 1 }, rv, refs, hint);
    return view;
  }

  /**
   * One set of "Missed <split>: add it" (#missedView): its splits, effect, and whether it can be done. The set: from
   * column k, count in a row (9.23 F16: and its further runs, two mats missed apart).
   * @param {{ k: number, count: number, runs?: { k: number, count: number }[] }} set
   */
  #missedChoice(race, state, bib, d, set, rv, refs, hint) {
    const n = race.splits.length;
    const { k, count } = set;
    const runs = runsOf(set);
    // (9.23 F20: the stray passes the set sets aside, as the runner's passes)
    const aside = this.#asideOf(d, set);
    if (!aside) return { ...this.#missedSet(race, set), ok: false, why: `Split Relay can't find bib ${bib}'s stray pass any more. Reload the runner.`, typed: false, splits: [], effect: '', passTod: null };
    const plan = this.#missedPlan(race, state, bib, d, k, count, refs(), runs.slice(1), aside);
    const base = this.#missedSet(race, set);
    if (plan.why) return { ...base, ok: false, why: plan.why, typed: false, splits: [], effect: '', passTod: null };
    const block = this.#missedFlagBlock(race, state, rv, bib, set, hint);
    const splits = plan.est.map((e) => ({ splitId: race.splits[e.col].id, splitName: race.splits[e.col].name, estimate: e.estimate,
      estimateText: e.estimate != null ? formatRaceTime(e.estimate, 3) : '', basis: e.basis }));
    const noEstimate = splits.find((x) => x.estimate === null);
    // what it does to the passes: counted as #assignPasses will, with the made-up times in their splits (each run's
    // between the crossings around it: 9.23 F16) and each run's pass moved on
    const mans = (d.manualInfo ?? []).filter((m) => m.state === 'active' && !plan.cols.includes(m.k));
    const estOf = new Map(plan.est.map((e) => [e.col, e.estimate]));
    for (const r of plan.runs) {
      // (from the crossing before the run: the split before it, or for a later run the pass before its own)
      let lo = plan.prev ? plan.prev.t : 0;
      if (r !== plan.runs[0]) for (const x of d.passInfo) if (x.t < r.cl.t && x.t > lo) lo = x.t;
      for (const [i, x] of r.cols.entries()) mans.push({ state: 'active', k: x, rt: estOf.get(x) ?? lo + ((i + 1) * (r.cl.t - lo)) / (r.cols.length + 1), rec: { estimated: true } });
    }
    let mat = null;
    for (const f of d.finishes) if (!f.marked && (mat === null || f.rt < mat)) mat = f.rt;
    const lynx = state.lynx.get(bibKey(bib));
    const finishOf = (m) => [mat, m, lynx ?? null].filter((x) => x !== null).reduce((a, x) => (a === null || x < a ? x : a), null);
    const pins = new Map(plan.runs.map((r) => [r.cl, r.to < n ? { split: race.splits[r.to].id, as: 'move', seen: false } : null]));
    for (const x of aside) pins.set(x, { split: null, as: 'none', seen: false });
    const was = previewPlaces(d.passInfo, d.manualInfo ?? [], race.splits, null, null, -1, finishOf);
    const will = previewPlaces(d.passInfo, mans, race.splits, pins, null, new Set(plan.drops.map((m) => m.k)), finishOf);
    const parts = [];
    // (9.23 F17: with the stream's finish passes, the runner's first pass past the last split is its finish pass, as the
    // row says it: "22:31.3 looks like the finish, not 4400m" and "22:31.3 → extra pass (the finish)")
    // (9.23 F18: and what the column check would hold then, not sent: NB5's 451 on the re-check of 2026-10-30, 800m, 4400m
    // and 5300m missed, "Missed 800m" said "22:28.7 → 4400m, 28:02.4 → 5300m", and both were held)
    const dropped = new Set(plan.drops.map((m) => m.k));
    const held = this.#previewHeld(race, state, bib, d, will, new Set(plan.runs.filter((r) => r.to < n).map((r) => r.cl)), mans.filter((m) => !dropped.has(m.k)),
      plan.marked ? this.#finishWithout(state, bib, d, plan.cl) : this.#finishOf(state, bib, d));
    // (9.23 F20: with the runner's finish known, its finish read: a stray pass after the last split before it is no finish)
    const known = this.#finishOf(state, bib, d);
    const finPass = rv?.legs?.field?.stream === true && !heldAsFinish(held)
      ? d.passInfo.find((x) => will.get(x) === 'extra' && (known === null || x.t >= known - FINISH_NEAR_TICKS)) ?? null : null;
    for (const x of d.passInfo) {
      // (9.23 F18: the pass the operator marked as the finish is the finish pass again: the runner is on the course for
      // Split Relay, and its splits that waited for a finish place can be filled then)
      const how = x === plan.cl && plan.marked ? ' (the finish pass, no longer the finish you marked)' : x === finPass ? ' (the finish)' : held.has(x) ? ` (held: ${held.get(x)})` : '';
      if (was.get(x) !== will.get(x)) parts.push(`${formatRaceTime(x.t, 1)} → ${whereWord(will.get(x), race.splits)}${how}`);
    }
    if (plan.marked && this.#finishPlace(state, bib) === null) {
      const wait = [];
      for (let x = 0; x < n; x++) if (!d.kept[x] && !plan.cols.includes(x)) wait.push(race.splits[x].name);
      if (wait.length) parts.push(`${listWords(wait)} can be filled then`);
    }
    return { ...base, ok: !block && !noEstimate, why: block ?? (noEstimate ? `No suggestion for ${noEstimate.splitName} (${noEstimate.basis}).` : null),
      typed: count === 1 && runs.length === 1, splits, effect: parts.join(', '), passTod: plan.cl.tod };
  }

  /**
   * 9.23 F20: the stray passes a set sets aside (its `aside`, by time of day), as the runner's passes: [] for a set with
   * none, null when one is gone.
   */
  #asideOf(d, set) {
    const out = [];
    for (const a of set?.aside ?? []) {
      const tod = typeof a === 'number' ? a : a?.tod;
      const x = d?.passInfo?.find((y) => y.tod === tod || y.items.some((i) => i.r.tod === tod)) ?? null;
      if (!x) return null;
      out.push(x);
    }
    return out;
  }

  /** The post-condition of "Missed <split>: add it": the made-up times hold their splits and each run's pass moved on (9.23 F16). */
  #missedCheck(race, state, bib, plan) {
    const n = race.splits.length;
    const d = state.bibs.get(bib);
    const names = listWords(plan.cols.map((k) => race.splits[k].name));
    // (9.23 F20: and the stray passes it sets aside are no split)
    for (const x of plan.aside ?? []) {
      const cl = d?.passInfo?.find((y) => y.tod === x.tod);
      if (!cl || cl.how !== 'ignored') return `Split Relay couldn't add ${names} for bib ${bib}: ${formatRaceTime(x.t, 1)} would not be set aside. Nothing was changed.`;
    }
    for (const k of plan.cols) {
      if (!d?.kept[k]?.manual) return `Split Relay couldn't add ${names} for bib ${bib}: ${race.splits[k].name} would not hold the time. Nothing was changed.`;
    }
    for (const r of plan.runs ?? [{ cl: plan.cl, to: plan.to }]) {
      const cl = d.passInfo?.find((x) => x.tod === r.cl.tod);
      const w = cl ? this.#whereOf(state, d, cl) : null;
      if (r.to < n ? w !== r.to : w !== 'extra' && w !== 'after-finish') {
        return `Split Relay couldn't add ${names} for bib ${bib}: ${formatRaceTime(r.cl.t, 1)} would not move on to ${r.to < n ? race.splits[r.to].name : 'after the last split'}. Nothing was changed.`;
      }
    }
    return null;
  }

  /**
   * "Missed 2400m added (8:36.7, made up); 11:05.9 → 3100m, …; 22:41.8 is an extra pass now" (9.23 F17: "… now (the
   * finish)" for the runner's first pass past the last split when the stream carries the finish passes, `stream`)
   */
  #missedWords(race, state, bib, plan, before, added, stream = false) {
    const d = state.bibs.get(bib);
    const after = this.#wheres(state, d);
    const names = listWords(plan.cols.map((k) => race.splits[k].name));
    const times = listWords(plan.cols.map((k) => formatRaceTime(d?.kept[k]?.rt ?? 0, 1)));
    const how = added.every((m) => m.estimated) ? 'made up' : 'typed';
    const moved = [];
    const extras = [];
    const late = [];
    const known = d ? this.#finishOf(state, bib, d) : null;
    const finPass = stream ? (d?.passInfo ?? []).find((x) => after.get(x.tod) === 'extra' && (known === null || x.t >= known - FINISH_NEAR_TICKS)) ?? null : null;
    // (the finish pass only when this change made it an extra pass)
    const finT = finPass && before.get(finPass.tod) !== 'extra' ? formatRaceTime(finPass.t, 1) : null;
    for (const x of d?.passInfo ?? []) {
      const a = before.get(x.tod);
      const z = after.get(x.tod);
      if (a === z) continue;
      const t = formatRaceTime(x.t, 1);
      if (z === 'extra') extras.push(t);
      else if (z === 'after-finish') late.push(t);
      else moved.push(`${t} → ${whereWord(z, race.splits)}`);
    }
    // (9.23 F14: made-up times on the way, made up again: "2400m made up again (11:00.0 before)")
    const again = (plan.again ?? []).map((m) => ({ name: race.splits[m.k].name, was: formatRaceTime(m.rt, 1) }));
    return [`Missed ${names} added (${times}, ${how})`,
      again.length ? `${listWords(again.map((x) => x.name))} made up again (${listWords(again.map((x) => x.was))} before)` : '', moved.join(', '),
      extras.length ? `${listWords(extras)} ${extras.length === 1 ? 'is an extra pass' : 'are extra passes'} now${finT ? ` (${extras.length > 1 ? `${finT} ` : ''}the finish)` : ''}` : '',
      late.length ? `${listWords(late)} ${late.length === 1 ? 'is' : 'are'} after the finish now` : ''].filter(Boolean).join('; ');
  }

  /**
   * What an Undo did, in words (9.23 F3), for its toast and the runner's changes: where the passes whose decision it
   * changed are now, the other passes it moved, and the made-up and typed times it took back or put back ("24:17.3 is
   * the 5300m split again", "3 made-up times taken back", "4400m is 17:30.5 again"). Not the words of the change it
   * took back: "Undone: 24:17.3 is the finish now" read as the opposite of what happened.
   * @param {any[]} recs the Undo's records
   * @param {Map<string, { wheres: Map<number, any>, manuals: Map<string, any> }>} was each runner's before the Undo
   * @param {any} root the change it took back (its words, when nothing shows)
   */
  #undoWords(race, state, recs, was, root) {
    const parts = [];
    const taken = [];
    const time = (m) => formatRaceTime(m.tod !== null && race.gunTicks !== null ? raceTicks(m.tod, race.gunTicks) : m.raceTicks, 1);
    for (const [bib, before] of was) {
      const d = state.bibs.get(bib);
      const after = this.#wheres(state, d);
      const mine = recs.filter((r) => r.bib === bib);
      const decided = new Set();
      for (const r of mine) {
        if (r.t !== 'assign' && r.t !== 'unassign') continue;
        const cl = d?.passInfo?.find((x) => x.tod === r.tod || x.items.some((i) => i.r.tod === r.tod));
        if (cl) decided.add(cl);
      }
      const back = [];
      const same = [];
      const moved = [];
      for (const cl of d?.passInfo ?? []) {
        const at = formatRaceTime(cl.t, 1);
        const a = before.wheres.get(cl.tod);
        const z = after.get(cl.tod);
        if (decided.has(cl)) {
          if (a !== z) back.push(`${at} is ${wherePhrase(z, race.splits)} again`);
          else same.push(cl.pin ? `${at} is kept in ${whereWord(z, race.splits)} again` : `Split Relay counts ${at} again (${whereWord(z, race.splits)})`);
        } else if (a !== z) moved.push(`${at} → ${whereWord(z, race.splits)}`);
      }
      // (the passes "Move only this time" held where they were say nothing: they stay)
      parts.push(...(back.length ? back : same));
      if (moved.length) parts.push(moved.join(', '));
      for (const r of mine) {
        const name = race.splitById.get(text(r.splitId))?.name ?? '?';
        if (r.t === 'unmanual') {
          const m = before.manuals.get(r.splitId);
          if (m) taken.push({ m, name });
        } else if (r.t === 'manual') {
          // (one a real read replaces at once is not said: the read's own line says where it is)
          const m = this.#manuals.get(race.id)?.get(bib)?.get(r.splitId);
          if (m && d?.kept[race.splitById.get(r.splitId)?.index ?? -1]?.manual) {
            parts.push(before.manuals.has(r.splitId) ? `${name} is ${time(m)} again` : `the ${m.estimated ? 'made-up' : 'typed'} ${name} time (${time(m)}) is back`);
          }
        }
      }
    }
    if (taken.length === 1) parts.push(`the ${taken[0].m.estimated ? 'made-up' : 'typed'} ${taken[0].name} time (${time(taken[0].m)}) taken back`);
    else if (taken.length) {
      const est = taken.filter((x) => x.m.estimated).length;
      parts.push(`${taken.length} ${est === taken.length ? 'made-up' : est === 0 ? 'typed' : 'made-up and typed'} times taken back`);
    }
    // (9.24: a runner stopped, or sent again)
    for (const r of recs) {
      if (r.t === 'runner-on') parts.push(`bib ${r.bib} is sent again`);
      else if (r.t === 'runner-off') parts.push(`bib ${r.bib} is not sent again`);
      // (9.25: what the operator said of where the runner runs)
      // (nothing said any more: the runner is where the start list or nothing puts it)
      else if (r.t === 'runner-say') {
        this.#ensureCheck(race, state);
        const out = r.say === 'away' || (r.say !== 'here' && this.#isAway(race, state, r.bib, state.bibs.get(r.bib)));
        parts.push(out ? `bib ${r.bib} is not in this race again` : r.say === 'here' ? `bib ${r.bib} counts here again` : `bib ${r.bib} is sent again`);
      }
    }
    if (!parts.length) return `Undone: ${root.text ? `"${root.text}"` : `change ${root.id}`} taken back`;
    return `Undone: ${parts.join('; ')}`;
  }

  /**
   * The runner's kept crossings as "time of day|column|held" by key: what a change sends is what differs (a crossing
   * the change let go of, the column check answered, too).
   */
  #keptSig(race, state, bib) {
    const m = new Map();
    // (9.26: not the crossings of a split that is counted but not sent: a change there alone sends nothing, and is no
    // reason to send the runner's furthest split again)
    for (const c of state.bibs.get(bib)?.kept ?? []) if (c && !this.#notSent(race, c)) m.set(c.key, `${c.tod}|${c.index}|${this.#holdOf(race, state, c) ? 1 : 0}`);
    return m;
  }

  /** The runner's kept crossings' legs (LS) by key: a crossing whose split before changed gets its new leg sent. */
  #lapSig(race, state, bib) {
    const m = new Map();
    for (const c of state.bibs.get(bib)?.kept ?? []) if (c && !this.#notSent(race, c)) m.set(c.key, this.#lapOf(race, state, c));
    return m;
  }

  /** The runner's split times in words, by split id: what a change did to each cell. */
  #cellTexts(race, state, bib) {
    const m = new Map();
    for (const c of state.bibs.get(bib)?.kept ?? []) if (c) m.set(c.splitId, formatRaceTime(c.rt, 1));
    return m;
  }

  /**
   * What an output has (or has on its way) for a crossing key, and which outputs: null when none has it. `tods` and
   * `places`: every output's copy's time of day and place.
   */
  #boardCopy(state, key) {
    const outputs = [];
    const tods = [];
    const places = [];
    let copy = null;
    for (const o of this.#outputs) {
      const e = this.#latestFlight(state, o.id, key) ?? state.ledgers.get(o.id)?.get(key);
      if (!e) continue;
      outputs.push(o.name);
      tods.push(e.tod);
      places.push(e.place);
      copy ??= e;
    }
    if (!copy) return null;
    return { text: Number.isFinite(copy.gun) ? formatRaceTime(raceTicks(copy.tod, copy.gun), 1) : '', outputs, tod: copy.tod, gun: copy.gun, tods, places };
  }

  /**
   * The race's stale count (what a Resend would correct), not counting these runners' own cells: each crossing once,
   * whatever the number of outputs (9.23 F14: the toast's "other places" counted each output's copy, 116 for 58), and
   * per output.
   * @returns {{ count: number, byOutput: Map<string, number> }}
   */
  #staleExcept(race, state, bibs) {
    const keys = new Set();
    const byOutput = new Map();
    for (const o of this.#outputs) if (takes(o, race.id)) byOutput.set(o.name, this.#staleCount(race, state, o, null, bibs, keys));
    return { count: keys.size, byOutput, keys };
  }

  /**
   * DESIGN 9.24, the clearing line: for a split that went out and was taken back (its cell is empty now, or its runner
   * was stopped), the runner's row for that split with an EMPTY time, lap time and place, to every output that has a
   * copy of it and has "Send a clearing line" on (off by default): a receiver that can blank a cell does. TrackScore
   * ignores a row with an empty time today, so this is for a receiver that learns to; with the setting off nothing of
   * it is ever on the wire. Once the output took the line its copy is forgotten: the cell counts as empty there (no
   * "still shows" note), and a time that comes back goes out as new. Not for a race that is not Active.
   * @param {{ bib: string, key: string }[]} cells the cells the change took back
   * @returns {{ lines: number, outputs: Set<string> }} lines: cells cleared (each once, whatever the outputs)
   */
  #sendClears(race, state, cells) {
    const res = { lines: 0, outputs: new Set() };
    if (!race.active || race.gunTicks === null) return res;
    const outs = this.#outputs.filter((o) => o.clearLines === true && takes(o, race.id));
    // (9.26: by the splits that are sent, as every packet; a split that is not sent has no cell to clear)
    const n = race.sentCount;
    for (const { bib, key } of outs.length ? cells : []) {
      const split = race.splitById.get(key.slice(key.lastIndexOf('|') + 1));
      if (!split || split.collectOnly) continue;
      const who = this.#who(state, bib);
      // (the cell is taken back for as long as nothing fills it and the runner stays stopped)
      const gone = (st) => { const c = st.kept.get(key); return !c || st.check?.off?.has(key) === true || st.check?.away?.has(key) === true; };
      let any = false;
      for (const o of outs) {
        const ledger = state.ledgers.get(o.id);
        const copy = ledger?.get(key);
        if (!copy || this.#latestFlight(state, o.id, key)) continue;
        const packet = {
          raceId: race.id, race: race.race, splitId: split.id, splitIndex: split.sentIndex, splitCount: n, splitName: split.name,
          bib, first: who.first, last: who.last, team: who.team, gender: who.gender, csTicks: null, lsTicks: null, place: null,
          lapsToGo: split.l2g, gunTicks: race.gunTicks, tod: null, runnerCount: state.runnerCount, reason: 'clear', clear: true,
        };
        const epoch = state.epoch;
        Object.defineProperty(packet, 'isCurrent', { enumerable: false,
          value: () => this.#states.get(race.id) === state && state.epoch === epoch && this.#raceById.get(race.id)?.active === true && gone(state) });
        let accepted = false;
        try {
          accepted = this.#deliverFn(o.id, packet, (ok) => {
            if (ok !== true || this.#states.get(race.id) !== state || state.epoch !== epoch || ledger.get(key) !== copy) return;
            ledger.delete(key);
            state.deliveryRev++;
            this.#saveSoon(state);
            this.#touched.add(race.id);
          }) !== false;
        } catch (err) {
          this.#log(`[engine] handing a clearing line for bib ${bib} to ${o.name} failed: ${err?.stack ?? err}`);
        }
        if (!accepted) continue;
        any = true;
        res.outputs.add(o.id);
        this.#emitSafe('send', packet, o.id);
      }
      if (any) res.lines++;
    }
    return res;
  }

  /**
   * DESIGN 9.24: after a change, the boards are put right by themselves: every line of the OTHER runners that the change
   * made out of date on an output (a split place that moved because a split was taken back, put in or stopped: what the
   * race tile's Resend would correct; `before`: what was out of date already stays for Resend) goes out again there, in
   * course order, whatever the minute says, and each of those runners' furthest split last, so TrackScore keeps the
   * runner's place of its furthest split (9.23 F4). By Resend's rules: nothing for a race that is not Active, a paused
   * split or a held pass; a finisher's real split is left alone (its place on TrackScore is FinishLynx's), a finisher's
   * made-up split goes with the finish place.
   * @param {Set<string>} except the change's own runners (#sendFixed sent theirs)
   * @param {Set<string>} before the crossings that were out of date before the change
   * @returns {{ lines: number, outputs: Set<string> }} lines: crossings re-sent (each once, whatever the outputs)
   */
  #resendOthers(race, state, except, before) {
    const res = { lines: 0, outputs: new Set() };
    if (!race.active || race.gunTicks === null) return res;
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    const now = new Set();
    for (const o of outs) this.#staleCount(race, state, o, null, except, now);
    const list = [];
    for (const k of now) {
      const c = before.has(k) ? null : state.kept.get(k);
      if (c && state.rel.has(k) && !this.#holdOf(race, state, c)) list.push(c);
    }
    list.sort((a, b) => a.index - b.index || cmpCrossing(a, b));
    /** bib -> output id -> the key of the last packet of the runner it got here */
    const lastOf = new Map();
    for (const c of list) {
      const finished = this.#finished(state, c.bib);
      const fp = finished && c.manual ? this.#finishPlace(state, c.bib) : null;
      if (finished && fp === null) continue;
      const place = fp ?? this.#place(state, c);
      const content = this.#content(race, c, place);
      let any = false;
      for (const o of outs) {
        const led = state.ledgers.get(o.id)?.get(c.key);
        const base = this.#latestFlight(state, o.id, c.key) ?? led;
        if (!led || base.sig === content.sig) continue;
        if (!this.#send(race, state, o, c, place, reasonOf(led, content), content, { byFinish: fp !== null })) continue;
        any = true;
        res.outputs.add(o.id);
        let last = lastOf.get(c.bib);
        if (!last) lastOf.set(c.bib, (last = new Map()));
        last.set(o.id, c.key);
      }
      if (any) res.lines++;
    }
    for (const [bib, last] of lastOf) {
      if (this.#finished(state, bib)) this.#sendFurthestFinished(race, state, bib, last);
      else this.#sendFurthest(race, state, bib, last, false);
    }
    return res;
  }

  /**
   * What a change made out of date of the other runners (9.23 F4, F14): `staleOthers`, each crossing once, and
   * `staleOutputs`, the outputs where it grew ("on TrackScore and Karmarush").
   */
  #staleOthers(before, after) {
    const outputs = [];
    for (const [name, n] of after.byOutput) if (n > (before.byOutput.get(name) ?? 0)) outputs.push(name);
    return { staleOthers: Math.max(0, after.count - before.count), staleOutputs: outputs };
  }

  /** A runner's decisions and what was released of it, to put back if a change does not hold (9.23 F2). */
  #snapRunner(race, state, bib) {
    const rel = new Map();
    const approved = new Map();
    for (const sp of race.splits) {
      const k = crossingKey(bib, sp.id);
      if (state.rel.has(k)) rel.set(k, state.rel.get(k));
      if (state.approved.has(k)) approved.set(k, state.approved.get(k));
    }
    return { fix: this.#fixState(race.id, bib), rel, approved };
  }

  #restoreRunner(race, state, bib, snap) {
    const put = (all, map) => {
      let byBib = all.get(race.id);
      if (!map.size) {
        byBib?.delete(bib);
        if (byBib && !byBib.size) all.delete(race.id);
        return;
      }
      if (!byBib) all.set(race.id, (byBib = new Map()));
      byBib.set(bib, new Map(map));
    };
    put(this.#pins, snap.fix.pins);
    put(this.#manuals, snap.fix.manuals);
    let offs = this.#offs.get(race.id);
    if (snap.fix.off) {
      if (!offs) this.#offs.set(race.id, (offs = new Map()));
      offs.set(bib, snap.fix.off);
    } else if (offs?.delete(bib) && !offs.size) this.#offs.delete(race.id);
    let says = this.#says.get(race.id);
    if (snap.fix.say) {
      if (!says) this.#says.set(race.id, (says = new Map()));
      says.set(bib, snap.fix.say);
    } else if (says?.delete(bib) && !says.size) this.#says.delete(race.id);
    this.#rederiveBib(race, state, bib);
    for (const sp of race.splits) {
      const k = crossingKey(bib, sp.id);
      if (snap.rel.has(k)) state.rel.set(k, snap.rel.get(k));
      else state.rel.delete(k);
      if (snap.approved.has(k)) state.approved.set(k, snap.approved.get(k));
      else state.approved.delete(k);
    }
  }

  /** The changes that touched a runner, newest first. */
  #fixesOf(raceId, bib) {
    const out = [];
    for (const g of this.#fixGroups.get(raceId)?.values() ?? []) if (g.bibs.has(bib)) out.push(g);
    return out.sort((a, b) => b.id - a.id);
  }

  /**
   * DESIGN 9.23 F3, F4: one change of the operator's, from the click to the scoreboards. `apply` puts its records into
   * the decisions and works the runners out again (it returns the records); `check`, the post-condition, says why it
   * did not come out as it should (or throws a refusal of its own): then everything is put back and nothing is
   * journaled or sent. Else the records go into the journal in ONE write (each with the change's id, the first with
   * what it was; `head` first, for an Undo), the change is kept for Undo, and what changed goes out (#sendFixed).
   * @returns {any} the change as the panel shows it, or null when `apply` changed nothing (every row refused)
   */
  #runFix(race, state, { kind, bibs, apply, check = null, text: words, head = null, commit = null, byFinish = false }) {
    const now = this.#clock.now();
    const list = [...new Set(bibs)];
    const before = new Map(list.map((bib) => [bib, { kept: this.#keptSig(race, state, bib), laps: this.#lapSig(race, state, bib), cells: this.#cellTexts(race, state, bib),
      snap: this.#snapRunner(race, state, bib) }]));
    const except = new Set(list);
    const staleBefore = this.#staleExcept(race, state, except);
    const g = this.#beginFix(race.id, kind);
    let recs;
    try {
      recs = apply(g) ?? [];
      const why = recs.length && check ? check() : null;
      if (why) throw reviewError(409, why);
    } catch (err) {
      const hit = [...(this.#fixOpen?.before.keys() ?? [])];
      this.#fixOpen = null;
      for (const bib of hit) if (before.has(bib)) this.#restoreRunner(race, state, bib, before.get(bib).snap);
      throw err;
    }
    if (!recs.length) {
      this.#fixOpen = null;
      return null;
    }
    g.text = words();
    // a finisher's change sent with the finish place (the operator said so): its Undo and Redo go the same way
    if (byFinish) g.byFinish = true;
    const first = head ? head(g) : null;
    recs.forEach((r, i) => {
      // when it was done (a start rebuilds the change's time from it)
      r.at ??= now;
      r.fix = g.id;
      if (i === 0) {
        r.fixKind = kind;
        r.fixText = g.text;
      }
    });
    if (byFinish) (first ?? recs[0]).byFinish = true;
    this.#journalMany(first ? [first, ...recs] : recs);
    this.#endFix();
    commit?.(g);
    this.#touched.add(race.id);
    const { sentTo, notLive, resent, cells, leftover, finishKept, cleared } = this.#sendChange(race, state, list, before, staleBefore, now, byFinish);
    const names = this.#outputs.filter((o) => sentTo.has(o.id)).map((o) => o.name);
    this.#log(`[engine] ${race.name} ${list.length === 1 ? `bib ${list[0]}` : `${list.length} runners`}: ${g.text} (Review)`);
    return {
      fix: g.id, kind, text: g.text, bibs: list, cells, leftover, finishKept, sentTo: names,
      lifOnly: !race.active || (cells.length > 0 && !names.length && notLive.length > 0),
      notLive, ...this.#staleOthers(staleBefore, this.#staleExcept(race, state, except)),
      // 9.24: the other runners' lines that went out again with their new places, and where
      resent: { lines: resent.lines, outputs: this.#outputs.filter((o) => resent.outputs.has(o.id)).map((o) => o.name) },
      cleared: { lines: cleared.lines, outputs: this.#outputs.filter((o) => cleared.outputs.has(o.id)).map((o) => o.name) },
      undoable: true, leaves: [], notes: [],
    };
  }

  /**
   * The part of a change that goes to the scoreboards (#runFix, and 9.27: a swap of bibs): what the change gave a new
   * time or column goes out for each of its runners (#sendFixed), the other runners' lines it made out of date go out
   * again (#resendOthers), and a cell it emptied that a scoreboard has gets a clearing line where an output takes one.
   * @param {string[]} list the change's runners
   * @param {Map<string, { kept: Map<string, string>, laps: Map<string, any>, cells: Map<string, string> }>} before
   *   each runner's #keptSig, #lapSig and #cellTexts before the change
   * @param {{ keys: Set<string> }} staleBefore #staleExcept before the change, without its runners
   */
  #sendChange(race, state, list, before, staleBefore, now, byFinish = false) {
    const except = new Set(list);
    const sentTo = new Set();
    const notLive = [];
    let resent = { lines: 0, outputs: new Set() };
    // what the change gave a new time or column, per runner (the column check first: it decides what is held)
    this.#ensureCheck(race, state);
    // (9.23 F21: what the check let go of these runners goes as the change sends it, not by itself: #letGoOf)
    for (const bib of list) for (const sp of race.splits) state.letGo.delete(crossingKey(bib, sp.id));
    const fresh = new Map(list.map((bib) => {
      const was = before.get(bib).kept;
      const keys = new Set();
      for (const [key, sig] of this.#keptSig(race, state, bib)) if (was.get(key) !== sig) keys.add(key);
      // 9.23 F20: a finisher's change sent with the finish place (the operator said so) sends the runner's later splits
      // that no output has as they are now too, from the first split it gave a new time or column on: a walker's 4200m to
      // 5300m, held on the course while 2400m was in doubt and let go only after its finish (a finisher's splits go with the
      // finish place), stayed off the boards after "Missed 2400m: add it (15:01.8 is a stray pass)", which moved none of them
      if (byFinish && keys.size && this.#finished(state, bib)) {
        const kept = state.bibs.get(bib)?.kept ?? [];
        const from = kept.findIndex((c) => c && keys.has(c.key));
        for (const c of from < 0 ? [] : kept.slice(from)) if (c && !this.#holdOf(race, state, c) && !this.#sentAs(race, state, c).now) keys.add(c.key);
      }
      return [bib, keys];
    }));
    this.#capture = [];
    this.#fixing = { bibs: new Set(list), keys: new Set([...fresh.values()].flatMap((keys) => [...keys])) };
    try {
      this.#converge(now);
      this.#fixing = null;
      const handed = this.#capture.slice();
      for (const bib of list) {
        const was = before.get(bib).kept;
        const is = this.#keptSig(race, state, bib);
        const keys = fresh.get(bib);
        // the runner's cells changed (one filled, moved or emptied): the boards must end with their furthest split
        const placeCheck = keys.size > 0 || [...was.keys()].some((key) => !is.has(key));
        // a split filled or emptied before a crossing gives it another leg (LS): the outputs that have it get it again
        const refresh = new Set();
        const laps = before.get(bib).laps;
        for (const [key, ls] of this.#lapSig(race, state, bib)) if (!keys.has(key) && laps.has(key) && laps.get(key) !== ls) refresh.add(key);
        // 9.23 F21: and every split an output has with its time and column as they are now but another leg, whatever
        // changed it (Not a split for a stray in 1500m held the later passes; "Missed 1500m" then gave 2400m its own
        // time back, the same cell as on the boards, so its leg of 5:11.6 from the stray stayed there instead of 3:25.0)
        for (const c of state.bibs.get(bib)?.kept ?? []) if (c && !keys.has(c.key) && !refresh.has(c.key) && this.#legOff(race, state, c)) refresh.add(c.key);
        const res = this.#sendFixed(race, state, bib, now, keys, handed, { refresh, placeCheck, byFinish });
        for (const o of res.outputs) sentTo.add(o);
        notLive.push(...res.notLive);
      }
      // 9.24: and the other runners' lines the change made out of date (their places at the splits it changed)
      resent = this.#resendOthers(race, state, except, staleBefore.keys);
      // (9.25: counted with the ones convergence sent inside their minute: on the course, with bib 213 taken out of a
      // race 7 minutes old, 35 of the 83 lines that went out again were counted)
      const again = new Set();
      for (const x of this.#capture) {
        if (except.has(x.bib) || !x.moved) continue;
        again.add(x.key);
        resent.outputs.add(x.outputId);
      }
      resent.lines = again.size;
    } finally {
      this.#capture = null;
      this.#fixing = null;
    }
    const cells = [];
    const leftover = [];
    const finishKept = [];
    /** 9.24: the cells the change took back that a scoreboard has (emptied, or stopped), for a clearing line */
    const tookBack = [];
    for (const bib of list) {
      const was = before.get(bib).cells;
      const is = this.#cellTexts(race, state, bib);
      const fp = this.#finished(state, bib) ? this.#finishPlace(state, bib) : null;
      for (const sp of race.splits) {
        const a = was.get(sp.id) ?? '';
        const z = is.get(sp.id) ?? '';
        if (a === z) continue;
        // (9.26: a cell of a split that is counted but not sent says so: its time goes nowhere, not into the .lif either)
        cells.push({ bib, splitId: sp.id, splitName: sp.name, before: a, after: z, ...(sp.collectOnly ? { collectOnly: true } : {}) });
        // emptied, but a scoreboard has it: a packet can't empty a cell
        const key = crossingKey(bib, sp.id);
        const copy = this.#boardCopy(state, key);
        if (copy && !z) {
          leftover.push({ bib, splitName: sp.name, text: copy.text });
          tookBack.push({ bib, key });
        }
        // a finisher's cell the boards have from Send with finish place (or a change sent with it), with another time
        // than it has now: the panel says how to put the boards right (only then; an emptied one is a leftover)
        const tod = state.kept.get(key)?.tod ?? null;
        if (copy && z && fp !== null && copy.places.some((p, i) => p === fp && copy.tods[i] !== tod)) finishKept.push({ bib, splitName: sp.name, text: copy.text });
      }
      // 9.24: a split the change stopped (Stop sending this runner) that a scoreboard has: taken back here, still there
      const sigs = before.get(bib).kept;
      for (const c of state.bibs.get(bib)?.kept ?? []) {
        const hold = c ? this.#holdOf(race, state, c) : null;
        if ((hold !== 'stopped' && hold !== 'away') || !sigs.get(c.key)?.endsWith('|0')) continue;
        const copy = this.#boardCopy(state, c.key);
        if (copy) {
          leftover.push({ bib, splitName: race.splits[c.index].name, text: copy.text, stopped: true, ...(hold === 'away' ? { away: true } : {}) });
          tookBack.push({ bib, key: c.key });
        }
      }
    }
    // 9.24: a clearing line for each, to the outputs that take one (off by default: then nothing goes)
    const cleared = this.#sendClears(race, state, tookBack);
    return { sentTo, notLive, resent, cells, leftover, finishKept, cleared };
  }

  /**
   * DESIGN 9.23 F4, what the operator just approved for one runner goes out now, to every output whose copy differs:
   * the crossings in `keys` (those the change gave a new time or column, or let go of; an emptied one has nothing to
   * send), in course order, whatever the minute (RESEND_WINDOW_MS) says, and kept as approved (state.approved) so an
   * output that is down gets them when it is back. Not for a race that is not Active (the .lif follows by itself), a
   * paused split or a column in doubt (they wait, approved for their time and column: they go out when let go,
   * whatever the minute says), a crossing still in its hold (convergence sends it), or a runner who has finished: a
   * split packet's place would replace the finish place in TrackScore (a made-up time goes with the finish place;
   * a real one waits for Send with finish place, or goes with it when the operator said so first: `byFinish`, every
   * cell the change gave a new time or column, one that never went out before too, as Send with finish place does).
   * TrackScore sets the runner's place from every packet, so an output that got a packet now gets the runner's
   * furthest split last, as a place update (not for a finisher); and with `placeCheck` (the change moved or emptied a
   * cell of the runner, or "Send again") an output whose newest packet of the runner is not their furthest split as it
   * is now gets it even when nothing else went (an Undo that puts back a cell the board still has: the board kept the
   * place of the split the Undo emptied). `refresh`: crossings whose time and column are the same but whose leg
   * changed (the split before them was filled or emptied): an output that has them gets them again, with the new leg.
   * @param {Set<string>} keys
   * @param {{ outputId: string, key: string, bib: string }[]} [handed] what convergence handed over in this action
   * @param {{ refresh?: Set<string>, placeCheck?: boolean, byFinish?: boolean }} [opts]
   * @returns {{ keys: Set<string>, outputs: Set<string>, notLive: { bib: string, splitId: string, splitName: string, why: string }[] }}
   */
  #sendFixed(race, state, bib, now, keys, handed = [], { refresh = new Set(), placeCheck = false, byFinish = false } = {}) {
    const res = { keys: new Set(), outputs: new Set(), notLive: [] };
    const d = state.bibs.get(bib);
    const list = (d?.kept ?? []).filter((c) => c && (keys.has(c.key) || refresh.has(c.key)));
    const not = (c, why) => {
      if (keys.has(c.key)) res.notLive.push({ bib, splitId: c.splitId, splitName: race.splits[c.index].name, why });
    };
    if (!race.active || race.gunTicks === null) {
      for (const c of list) not(c, `${race.name} is not Active`);
      return res;
    }
    const finished = this.#finished(state, bib);
    const fp = finished ? this.#finishPlace(state, bib) : null;
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    /** output id -> the key of the last packet of this runner it got in this action */
    const last = new Map();
    /** "output|key" of the packets convergence handed over in this action: they went with the new leg already */
    const got = new Set();
    for (const x of handed) {
      if (x.bib !== bib) continue;
      last.set(x.outputId, x.key);
      got.add(`${x.outputId}|${x.key}`);
      res.outputs.add(x.outputId);
      res.keys.add(x.key);
    }
    for (const c of list) {
      const fresh = keys.has(c.key);
      // approved for its time and column, while it waits: it goes out when it is let go, whatever the minute says
      const pending = () => {
        if (fresh) state.approved.set(c.key, { sig: null, cell: cellOf(this.#content(race, c, 0)) });
      };
      const hold = this.#holdOf(race, state, c);
      // (9.24: a stopped runner's crossing waits for "Send this runner again": nothing to approve, nothing to say; 9.25:
      // nor one of a runner who is not in this race; 9.26: nor one in a split that is counted but not sent, whatever
      // else holds it)
      if (hold === 'stopped' || hold === 'away' || this.#notSent(race, c)) continue;
      if (hold) {
        pending();
        not(c, hold === 'paused' ? `${race.splits[c.index].name} is paused` : 'held: Split Relay has a question about it');
        continue;
      }
      // a finisher's split goes with the finish place: a made-up one always, a real one the change moved when the
      // operator said so (byFinish), and the next split's new leg (refresh) to an output that has it: 9.23 F13, its LS
      // after a fill or an Undo, as for a runner on the course (P = the finish place, so TrackScore keeps it)
      if (finished && !(fp !== null && (c.manual || byFinish || !fresh))) {
        not(c, 'has finished: use Send with finish place');
        continue;
      }
      if (!state.rel.has(c.key)) {
        if (!(finished && fresh)) {
          pending(); // still in its hold: convergence sends it
          continue;
        }
        // a finisher's split the operator sends with the finish place: convergence never lets a finisher's real
        // crossing go, so it goes from here, as Send with finish place sends it (a cell never sent before too)
        state.rel.set(c.key, { at: now, tod: c.tod, reason: 'new', live: { reason: 'new', tod: c.tod, place: fp } });
        state.feedBibs.add(bib);
      }
      const place = finished ? fp : this.#place(state, c);
      const content = this.#content(race, c, place);
      const ls = this.#lapOf(race, state, c);
      if (fresh) state.approved.set(c.key, { sig: content.sig, cell: cellOf(content) });
      for (const o of outs) {
        const led = state.ledgers.get(o.id)?.get(c.key);
        const base = this.#latestFlight(state, o.id, c.key) ?? led;
        // a changed crossing goes where the output's copy differs (9.23 F21: its leg too, when the copy says which it
        // got); a new leg only where the output has the crossing (a finisher's: only where it has it with this time and
        // column; an older one waits for Send with finish place)
        if (fresh ? base && base.sig === content.sig && !(base.ls != null && base.ls !== ls) : !base || got.has(`${o.id}|${c.key}`)
          || (finished && !c.manual && !byFinish && cellOf(base) !== cellOf(content))) continue;
        if (this.#send(race, state, o, c, place, reasonOf(led, content), content, { byFinish: finished, fixed: fresh })) {
          res.keys.add(c.key);
          res.outputs.add(o.id);
          last.set(o.id, c.key);
        }
      }
    }
    if (finished) {
      // 9.23 F14: a finisher's furthest split last too, with the finish place (#sendFurthestFinished)
      const far = this.#sendFurthestFinished(race, state, bib, last);
      for (const o of far.outputs) res.outputs.add(o);
      if (far.key) res.keys.add(far.key);
      return res;
    }
    const far = this.#sendFurthest(race, state, bib, last, placeCheck);
    for (const o of far.outputs) res.outputs.add(o);
    if (far.key) res.keys.add(far.key);
    return res;
  }

  /**
   * DESIGN 9.23 F4, the runner's place on the boards: TrackScore takes it from the newest packet of the runner, so an
   * output that got a packet in this action (`last`: output id -> its key) gets the runner's furthest kept split that
   * is out (not held, released) last, as a place update. With `placeCheck`, an output that got nothing now gets it too
   * when its newest packet of the runner is not that split as it is now. Not for a finisher (the callers check).
   * @param {Map<string, string>} last
   * @param {boolean} placeCheck
   * @returns {{ key: string|null, outputs: Set<string> }}
   */
  #sendFurthest(race, state, bib, last, placeCheck) {
    const out = { key: null, outputs: new Set() };
    const d = state.bibs.get(bib);
    let far = null;
    for (let k = (d?.kept.length ?? 0) - 1; k >= 0 && !far; k--) {
      const c = d.kept[k];
      if (c && !this.#holdOf(race, state, c) && state.rel.has(c.key)) far = c;
    }
    if (!far || (!last.size && !placeCheck)) return out;
    const place = this.#place(state, far);
    const content = this.#content(race, far, place);
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      if (last.has(o.id)) {
        if (last.get(o.id) === far.key) continue;
      } else {
        if (!placeCheck) continue;
        const top = this.#newestCopy(race, state, o.id, bib);
        if (!top || (top.key === far.key && top.e.sig === content.sig)) continue;
      }
      if (this.#send(race, state, o, far, place, reasonOf(state.ledgers.get(o.id)?.get(far.key), content), content, {})) {
        out.key = far.key;
        out.outputs.add(o.id);
      }
    }
    return out;
  }

  /**
   * 9.23 F14: the runner's furthest split last for a finisher too (F4 and F13 left finishers out): every packet of a
   * finisher carries the finish place, so TrackScore's place was right either way, but its newest split of the runner
   * was an earlier one after a fill (2400m on the re-check of 2026-10-27, after a typed 1500m and its next split's new
   * leg) or after a restart (a made-up 4200m that went again). Only with the finish place known, and only to an output
   * that got an earlier split of the runner in this action and has the furthest one with this time and column already
   * (one with another time waits for Send with finish place, as before): it goes again with the finish place. After a
   * kill, the packets of the last minute go again (#releaseSuspects) and the runner's real splits among them do not
   * (a finisher): the furthest one the output acknowledged before the kill, with this time and column, follows a made-up
   * split that went again (#redelivered; runF's 428 and 593 on the re-check of 2026-10-28).
   * @param {Map<string, string>} last output id -> the key of the last packet of the runner it got in this action
   * @returns {{ key: string|null, outputs: Set<string> }}
   */
  #sendFurthestFinished(race, state, bib, last) {
    const out = { key: null, outputs: new Set() };
    const fp = this.#finishPlace(state, bib);
    if (fp === null || !last.size) return out;
    const d = state.bibs.get(bib);
    let far = null;
    for (let k = (d?.kept.length ?? 0) - 1; k >= 0 && !far; k--) {
      const c = d.kept[k];
      if (c && !this.#holdOf(race, state, c) && state.rel.has(c.key)) far = c;
    }
    if (!far) return out;
    const content = this.#content(race, far, fp);
    for (const o of this.#outputs) {
      if (!takes(o, race.id) || !last.has(o.id) || last.get(o.id) === far.key) continue;
      const led = state.ledgers.get(o.id)?.get(far.key);
      const base = this.#latestFlight(state, o.id, far.key) ?? led ?? this.#redelivered?.get(state)?.get(`${o.id}|${far.key}`);
      if (!base || cellOf(base) !== cellOf(content)) continue;
      if (this.#send(race, state, o, far, fp, reasonOf(led, content), content, { byFinish: true })) {
        out.key = far.key;
        out.outputs.add(o.id);
      }
    }
    return out;
  }

  /**
   * Everything the .lif writer needs for one race: the crossings that count. Null while the gun is not set, so the
   * merged file is left alone instead of being rewritten without its splits.
   * @param {string} raceId
   * @returns {RaceData | null}
   */
  raceData(raceId) {
    const race = this.#raceById.get(raceId);
    if (!race || race.gunTicks === null) return null;
    const state = this.#states.get(raceId) ?? this.#newState(raceId);
    this.#ensureCheck(race, state);
    const runners = new Map();
    // 9.26: only the splits that are sent, in course order: the file has what the scoreboards have, and its split count
    // is the number of sent splits (a split that is counted only is in no column of it)
    for (const split of race.sent) {
      for (const c of state.ranks.get(split.id) ?? []) {
        // a paused split, or a column in doubt, is not in the merged .lif either (9.17 P1, P2); made-up times are
        if (this.#holdOf(race, state, c)) continue;
        let r = runners.get(c.bib);
        if (!r) runners.set(c.bib, (r = { ...this.#who(state, c.bib), splits: new Array(race.sentCount).fill(null) }));
        r.splits[split.sentIndex] = c.rt;
      }
    }
    return { splitCount: race.sentCount, gun: race.gunTicks, runners };
  }

  /**
   * Contests whose reads are not used (DESIGN 9.2 R5): their race was deleted, or stopped listing the contest. Until a
   * race lists it, its reads, the new ones too, have no race.
   * @returns {{ contest: string, reason: string, raceName: string, raceId: string|null, since: number,
   *   count: number, text: string, via?: 'port'|'event', port?: number, event?: string }[]} count = its reads that are
   *   set aside (the deleted race's own reads are not among them: they are out of use for good); raceId = the race the
   *   panel offers to edit (the one that stopped listing it, while it exists), null when a new race is the way to use
   *   the contest again; text = the warning in words (asideText); via/port/event: what the key is (9.15 L3)
   */
  setAside() {
    return [...this.#effectiveAside()].map(([key, a]) => {
      const race = a.byId ? this.#raceById.get(a.byId) : undefined;
      const reason = this.#reason(a);
      return {
        // named as the reason names it: a race gone from the settings by the name it had last (this run, or its race file)
        contest: a.contest, reason, raceName: race?.name || (a.byId && (this.#raceNames.get(a.byId) || this.#fileName(a.byId))) || a.byName,
        raceId: !a.deleted && race ? race.id : null, since: a.since ?? 0, count: this.#asideCount.get(key) ?? 0,
        text: asideText({ contest: a.contest, reason, key }), ...keyFields(key),
      };
    }).sort(byContestName);
  }

  /**
   * DESIGN 9.2 R6: races that have reads but are not in the settings, and were not deleted (config.json was restored
   * from its backup, reset or edited by hand). Their reads wait for them, not used; they come back when a race with
   * that id is in the settings again. The panel shows them in red.
   * @returns {{ raceId: string, raceName: string, count: number, hasSettings: boolean, inputPort: number|null,
   *   contests: { contest: string, blank: boolean, count: number, via?: 'port'|'event', port?: number, event?: string }[]
   *   }[]} raceName '' when not even its race file knows it; hasSettings: its race file keeps its settings, so "Put it
   *   back" can restore it (V2); inputPort: the port in those settings (null: none, or no settings)
   */
  missingRaces() {
    return [...this.#missing.values()].map((m) => {
      const saved = this.#fileSettings(m.raceId);
      return {
        raceId: m.raceId, raceName: m.raceName, count: m.count, hasSettings: saved !== null,
        // the port its race file says it reads from, so "Put it back" can say beforehand that it comes back not Active
        inputPort: Number.isInteger(saved?.inputPort) ? saved.inputPort : null,
        contests: [...m.contests.values()].map((c) => ({ ...c })).sort(byContestName),
      };
    }).sort((a, b) => a.raceName.localeCompare(b.raceName, undefined, { numeric: true, sensitivity: 'base' }) || a.raceId.localeCompare(b.raceId));
  }

  /**
   * DESIGN 9.15 V5: races in the settings that the operator deleted earlier (config.json was put back from its backup,
   * or edited, and still had them). Their reads from before the delete stay out of use (R2); new reads count in them.
   * The panel warns in red until the race is deleted again or saved (which keeps it: keepRace).
   * @returns {{ raceId: string, raceName: string, deletedName: string, deletedAt: number|null, count: number }[]}
   *   count = its reads that the delete took out of use
   */
  deletedBack() {
    const out = [];
    for (const race of this.#races) {
      if (!this.#deletedIds.has(race.id)) continue;
      const d = this.#deletedAt.get(race.id);
      let count = 0;
      for (const r of this.#readList) if (r.gone === DELETED && r.raceId === race.id) count++;
      out.push({ raceId: race.id, raceName: race.name, deletedName: d?.name || race.name, deletedAt: d?.at ?? null, count });
    }
    return out;
  }

  /**
   * The operator keeps a race that was deleted earlier and is back in the settings (9.15 V5): it is no longer called
   * deleted (journaled 'undelete'). Its reads from before the delete stay out of use. No-op for any other race.
   * @param {string} raceId
   * @returns {boolean} whether it was one
   */
  keepRace(raceId) {
    const id = text(raceId);
    if (!this.#deletedIds.has(id) || !this.#raceById.has(id)) return false;
    this.#deletedIds.delete(id);
    this.#deletedAt.delete(id);
    this.#journal({ t: 'undelete', raceId: id, at: this.#clock.now() });
    this.#log(`[engine] race '${this.#raceById.get(id).name}' (${id}) was deleted earlier and is back in the settings: kept`);
    return true;
  }

  /**
   * The live reads that are in no race now, per contest and why (DESIGN 9.2): 'paused' (races that are not Active list
   * the contest; raceId/raceName = the first of them), 'set-aside', 'race-missing' (they wait for a missing race, or are
   * its own reads; raceId/raceName = that race) or 'no-race' (no race takes them). For the panel's counts: what is
   * waiting now, not what was ever read.
   * @returns {{ contest: string, blank: boolean, status: 'paused'|'set-aside'|'race-missing'|'no-race', count: number,
   *   raceId: string|null, raceName: string, via?: 'port'|'event', port?: number, event?: string }[]} one entry per
   *   contest, status and race (9.15 V3)
   */
  noRace() {
    return [...this.#noRace.values()].filter((e) => e.count > 0).map((e) => ({ ...e }))
      .sort((a, b) => byContestName(a, b) || a.status.localeCompare(b.status) || String(a.raceId ?? '').localeCompare(String(b.raceId ?? '')));
  }

  /**
   * DESIGN 9.2: what saving these settings would do to the reads received so far, without changing anything. The
   * control panel says it in its dialogs before a race is saved or deleted ("3 reads of 'JV' move from Open 5K to this
   * race"). It runs the very rules a saved change runs (planRoutes), so it says exactly what will happen.
   * @param {any} next the whole config as it would be
   * @param {{ deleted?: Iterable<string> }} [opts] the races the change deletes (a race left out of `next` without
   *   being named here would be missing, R6, not deleted)
   * @returns {RoutePlan}
   */
  planChange(next, { deleted = [] } = {}) {
    const deletedIds = new Set([...(deleted ?? [])].map(text).filter(Boolean));
    const cfg = compileConfig(next);
    const prev = this.#routing;
    const buckets = this.#buckets();
    const nameOf = (id) => cfg.byId.get(id)?.name ?? this.#raceNames.get(id) ?? this.#fileName(id);
    const { base, transient } = this.#asideBase();
    const before = this.#effectiveAside();
    const plan = planRoutes(cfg, prev, base, this.#held, buckets, nameOf, deletedIds, { transient, prevAside: before });
    const missingAfter = new Map(plan.missing.map((m) => [m.id, m]));
    const racePlace = (race) => ({ raceId: race.id, raceName: race.name, active: race.active });
    // in no race, and why: waiting for a race that is not Active (C1), set aside, waiting for a missing race, or none
    const noRace = (routes, aside, held, key) => {
      const listing = key ? routes.listing.get(key) : undefined;
      if (listing) return { raceId: null, status: 'paused', raceName: listing[0].name, waitsFor: listing[0].id };
      if (key && aside.has(key)) return { raceId: null, status: 'set-aside' };
      if (held.has(key)) return { raceId: null, status: 'race-missing', raceName: nameOf(held.get(key)), waitsFor: held.get(key) };
      return { raceId: null, status: 'no-race' };
    };
    const missingPlace = (id) => ({ raceId: null, status: 'race-missing', raceName: nameOf(id), waitsFor: id });
    // a read stays where it is when its race is only switched on or off: not a move
    const same = (a, b) => a.raceId === b.raceId && a.status === b.status;
    // ...but new reads that go to a race that is now switched off are not sent: that is worth saying
    const sameNew = (a, b) => same(a, b) && a.active === b.active;
    const contestOf = new Map();
    for (const b of buckets) if (!contestOf.has(b.key)) contestOf.set(b.key, b.contest);
    const gone = new Set(plan.deleted.flatMap((d) => d.buckets));
    /** contest key -> live reads of it after the change that are in no race */
    const unused = new Map();
    const moves = new Map();
    for (const b of buckets) {
      if (gone.has(b)) continue;
      let from;
      if (b.raceId === null) from = noRace(prev, before, this.#held, b.key);
      else {
        const r = prev.byId.get(b.raceId);
        from = r ? racePlace(r) : missingPlace(b.raceId);
      }
      let to;
      if (plan.target.has(b)) {
        const t = plan.target.get(b);
        to = t ? racePlace(t) : noRace(cfg, plan.after, plan.held, b.key);
        if (!t) unused.set(b.key, (unused.get(b.key) ?? 0) + b.reads.length);
      } else {
        // kept where it is: in a race that is not Active, or with a missing race (back in the settings, or not)
        const r = cfg.byId.get(b.raceId);
        to = r ? racePlace(r) : missingAfter.has(b.raceId) ? missingPlace(b.raceId) : { raceId: null, status: 'no-race' };
      }
      if (same(from, to)) continue;
      const k = `${b.key}\u0000${from.raceId}\u0000${from.status}\u0000${to.raceId}\u0000${to.status}`;
      const m = moves.get(k);
      if (m) m.count += b.reads.length;
      else moves.set(k, { contest: b.contest, blank: !b.key, ...keyFields(b.key), count: b.reads.length, from, to });
    }
    // where a new read of each contest goes, before and after: every contest seen or listed
    // A race's own port and event are listed implicitly (9.15 L3): they are worth a word only once reads came by them.
    const listed = (k) => !routeKeyInfo(k).port && !routeKeyInfo(k).event;
    const keys = new Set(['', ...this.#seenKeys, ...[...prev.listing.keys(), ...cfg.listing.keys()].filter(listed), ...before.keys()]);
    const liveReads = new Map();
    for (const b of buckets) if (!gone.has(b)) liveReads.set(b.key, (liveReads.get(b.key) ?? 0) + b.reads.length);
    const newReads = [];
    const changed = new Set();
    for (const k of keys) {
      const was = routeNew(prev, before, this.#held, k);
      const will = routeNew(cfg, plan.after, plan.held, k);
      const from = was ? racePlace(was) : noRace(prev, before, this.#held, k);
      const to = will ? racePlace(will) : noRace(cfg, plan.after, plan.held, k);
      if (sameNew(from, to)) continue;
      changed.add(k);
      const contest = contestOf.get(k) ?? this.#seenContests.get(k)?.name ?? before.get(k)?.contest
        ?? [...cfg.races, ...prev.races].flatMap((r) => list(r.race?.contests)).find((c) => matchKey(c) === k) ?? (keyLabel(k) || k);
      newReads.push({ contest, blank: !k, ...keyFields(k), reads: liveReads.get(k) ?? 0, from, to });
    }
    const kept = new Map();
    for (const b of buckets) {
      if (gone.has(b) || plan.target.has(b) || b.raceId === null || !changed.has(b.key)) continue;
      const race = cfg.byId.get(b.raceId);
      if (!race || routeNew(cfg, plan.after, plan.held, b.key) === race) continue;
      const k = `${b.key}\u0000${race.id}`;
      const e = kept.get(k);
      if (e) e.count += b.reads.length;
      else kept.set(k, { contest: b.contest, blank: !b.key, ...keyFields(b.key), count: b.reads.length, raceId: race.id, raceName: race.name });
    }
    const deletedAfter = new Set([...this.#deletedIds, ...deletedIds]);
    const reasonIn = (a) => {
      const race = a.byId ? cfg.byId.get(a.byId) : undefined;
      return this.#reason(a, race ?? null, deletedAfter);
    };
    return {
      moves: [...moves.values()].sort(byContestName),
      deleted: plan.deleted.map((d) => {
        const per = new Map();
        for (const b of d.buckets) per.set(b.key, { contest: b.contest, blank: !b.key, ...keyFields(b.key), count: (per.get(b.key)?.count ?? 0) + b.reads.length });
        return { raceId: d.id, raceName: d.name, count: d.buckets.reduce((n, b) => n + b.reads.length, 0), contests: [...per.values()].sort(byContestName) };
      }),
      // in effect after the change and not before (a journaled set-aside whose listing goes is in effect again), and
      // the other way round
      setAside: [...plan.after].filter(([k]) => !before.has(k)).map(([k, a]) => ({ contest: a.contest, reason: reasonIn(a), deleted: a.deleted, count: unused.get(k) ?? 0, ...keyFields(k) })).sort(byContestName),
      usedAgain: [...before].filter(([k]) => !plan.after.has(k)).map(([, a]) => a.contest).sort((a, b) => a.localeCompare(b)),
      kept: [...kept.values()].sort(byContestName),
      newReads: newReads.sort(byContestName),
    };
  }

  /** Whether any read without a timing point name (a FinishLynx LapTime line: a bib and a time) came in (9.15 L8). */
  passesSeen() {
    return this.#passesSeen > 0;
  }

  /** Every timing point and contest name seen on the stream, for the pickers in the race editor. */
  seen() {
    const rows = (m) => [...m.values()].map(({ name, count, lastAt }) => ({ name, count, lastAt })).sort(byName);
    return { locations: rows(this.#seenLocations), contests: rows(this.#seenContests) };
  }

  /**
   * @param {number} [limit=200]
   * @returns {FeedEntry[]} newest first
   */
  feed(limit = 200) {
    const len = this.#feed.length;
    const n = Math.max(0, Math.min(len, Math.floor(Number.isFinite(limit) ? limit : 200)));
    const out = new Array(n);
    // newest first: the newest entry sits just before #feedStart in the ring
    for (let i = 0; i < n; i++) out[i] = this.#feed[(this.#feedStart + len - 1 - i) % len];
    return out;
  }

  /**
   * How far the reads' times of day are behind this PC's clock (DESIGN 9.16 F6): the 10th percentile of (arrival time
   * of day - read time of day) over the last 200 reads that did not arrive in a burst, in seconds. A read can come
   * late but never early, so the low end is the clock's offset plus RR12's normal delay: about 1.5 s when the clocks
   * agree. Reads RR12 had queued (it was cut off, or Split Relay was down) arrive all at once with long lags; they are
   * left out, so a flush can't make the clocks look wrong. Null before the first read that counts.
   * @returns {number | null}
   */
  clockLagSec() {
    this.#settleLag(this.#clock.now());
    const s = [...this.#lag];
    // the reads of the last moment count too, unless they are part of a flush
    for (let i = Math.max(this.#lagHead, this.#lagFlagged); i < this.#lagWin.length; i++) s.push(this.#lagWin[i].lag);
    if (!s.length) return null;
    s.sort((a, b) => a - b);
    const x = LAG_PERCENTILE * (s.length - 1);
    const lo = Math.floor(x);
    const v = lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (x - lo) : s[lo];
    return Math.round(v * 10) / 10;
  }

  /** Save every race with unsaved changes now (before shutdown). */
  flush() {
    for (const t of this.#saveTimers.values()) this.#clock.clearTimeout(t);
    this.#saveTimers.clear();
    for (const id of [...this.#unsaved]) this.#save(id);
  }

  /**
   * Save and stop all timers and deliveries. What an output had not acknowledged is not in its ledger, so it goes out
   * at the next start. Acknowledgements that still arrive are recorded; call flush() again to save them.
   */
  stop() {
    this.#halted = true;
    this.#delivering = false;
    this.#clearHoldTimer();
    // Packets of before a crash that were not sent again yet: forgotten in the saved ledger, so the next start sends them.
    if (this.#suspects) this.#releaseSuspects(false);
    this.flush();
  }

  /**
   * Record in the journal that Split Relay stopped cleanly. Call it last, once every output is closed: a closed
   * connection still delivers what this PC's network stack held, so nothing an output took needs sending again. A
   * start without this record behind it (a kill, a crash, a power cut) sends the last minute of packets again.
   */
  markCleanStop() {
    this.#journal({ t: 'stop', at: this.#clock.now() });
  }

  // ---- config ---------------------------------------------------------------------------------------------------

  #compile() {
    let cfg;
    try {
      cfg = this.#getConfig() ?? {};
    } catch (err) {
      this.#log(`[engine] could not read the config: ${err?.stack ?? err}`);
      return; // keep racing on the last good config
    }
    const c = compileConfig(cfg);
    const sig0 = (x) => `${x.keepOff}|${x.races.map((r) => `${r.id}:${r.event}`).join(',')}`;
    // 9.25: a race's event number or the setting changed: who is kept off the boards as it was, for configChanged
    if (this.#lists.byEvent.size && this.#states.size && this.#listSig && sig0(c) !== this.#listSig) this.#listsBefore = this.#listsSnapshot();
    this.#races = c.races;
    this.#raceById = c.byId;
    this.#listing = c.listing;
    this.#catchAll = c.catchAll;
    this.#routing = { races: c.races, byId: c.byId, listing: c.listing, catchAll: c.catchAll };
    for (const r of c.races) this.#raceNames.set(r.id, r.name);
    this.#outputs = c.outputs;
    this.#outputsSig = JSON.stringify(c.outputs);
    // 9.25: a race's event number or the setting changed: who is not in which race is worked out again
    this.#keepOff = c.keepOff;
    const sig = sig0(c);
    if (sig !== this.#listSig) {
      this.#listSig = sig;
      for (const state of this.#states.values()) this.#changed(state);
    }
  }

  /** 9.25: the start lists as they are now (opts.startLists), by event and by bib. */
  #readLists() {
    const byEvent = new Map();
    const eventsOf = new Map();
    let raw = null;
    try {
      raw = this.#startListsFn?.() ?? null;
    } catch (err) {
      this.#log(`[engine] could not read the start lists: ${err?.message ?? err}`);
    }
    const events = raw && typeof raw === 'object' && raw.events && typeof raw.events === 'object' ? raw.events : {};
    for (const [k, l] of Object.entries(events)) {
      const event = eventKeyOf(k);
      if (!event || !Array.isArray(l?.bibs)) continue;
      const bibs = new Set(l.bibs.map(entryBib).filter(Boolean));
      byEvent.set(event, { event, file: text(l.file) || 'entries', loadedAt: finite(l.loadedAt) ?? 0, bibs });
      for (const b of bibs) {
        const e = eventsOf.get(b);
        if (e) e.push(event);
        else eventsOf.set(b, [event]);
      }
    }
    this.#lists = { byEvent, eventsOf };
  }

  /**
   * DESIGN 9.25: the operator loaded or removed a start list (main.js keeps them): who is not in which race is worked
   * out again, and what follows goes out as after any change of the operator's: a runner who is in the race after all
   * is sent, the other runners' lines whose place moved go out again by themselves (9.24), a line the boards have of a
   * runner who is not in the race gets a clearing line where an output takes one.
   * @returns {{ resent: number, held: { raceId: string, raceName: string, bib: string, splitName: string, text: string }[] }}
   *   resent: lines of other runners that went out again; held: the lines the boards still show of runners who are not
   *   in the race (sent before the list was loaded)
   */
  startListsChanged() {
    const now = this.#clock.now();
    const before = this.#listsSnapshot();
    this.#readLists();
    for (const state of this.#states.values()) this.#changed(state);
    for (const race of this.#races) this.#touched.add(race.id);
    this.#converge(now);
    const res = this.#listsSettle(before);
    this.#after();
    return res;
  }

  /** 9.25: who is kept off the boards in each race, and which lines are out of date, before the lists or the setting change. */
  #listsSnapshot() {
    const before = new Map();
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      this.#ensureCheck(race, state);
      before.set(race.id, { away: new Set(state.check.away.keys()), stale: this.#staleExcept(race, state, new Set()).keys });
    }
    return before;
  }

  /**
   * 9.25: after the lists or the setting changed who is kept off the boards (and convergence sent what is new): the
   * other runners' lines whose place moved go out again, a line the boards have of a runner who is no longer sent gets
   * a clearing line where an output takes one. @returns {{ resent: number, held: any[] }} see startListsChanged
   */
  #listsSettle(before) {
    let resent = 0;
    const held = [];
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      const was = before.get(race.id);
      if (!state || !was) continue;
      const chk = this.#ensureCheck(race, state);
      const same = chk.away.size === was.away.size && [...chk.away.keys()].every((k) => was.away.has(k));
      if (same) continue;
      state.feedAllBibs = true;
      resent += this.#resendOthers(race, state, new Set(), was.stale).lines;
      const cells = [];
      for (const [key, bib] of chk.away) {
        const copy = was.away.has(key) ? null : this.#boardCopy(state, key);
        const c = state.kept.get(key);
        if (!copy || !c) continue;
        cells.push({ bib, key });
        held.push({ raceId: race.id, raceName: race.name, bib, splitName: race.splits[c.index].name, text: copy.text });
      }
      this.#sendClears(race, state, cells);
    }
    return { resent, held };
  }

  #filter() {
    let f = {};
    try {
      f = this.#getConfig()?.filter ?? {};
    } catch {}
    const holdSec = nonNegative(f.holdSec, 2);
    const startSec = Math.min(START_IGNORE_MAX_SEC, nonNegative(f.startIgnoreSec, START_IGNORE_SEC));
    return {
      holdSec, holdMs: Math.round(holdSec * 1000), windowTicks: Math.round(nonNegative(f.tagWindowSec, 10) * TICKS_PER_SEC),
      startSec, startTicks: Math.round(startSec * TICKS_PER_SEC),
    };
  }

  /** What the derivation of a race depends on in its settings: when it changes, the race is worked out again. */
  #derivSig(race) {
    const splits = race.splits.map((s) => `${s.id}:${s.sources.map(matchKey).join(',')}:${s.earliest}`).join(';');
    const { windowTicks, startTicks } = this.#filter();
    return `${race.gunTicks}|${windowTicks}|${startTicks}|${splits}|${[...race.finishKeys].join(',')}`;
  }

  /**
   * Why a contest is set aside, in words, worked out now (DESIGN 9.2 R5): a race renamed since is called by its new
   * name, and a race that stopped listing the contest and was deleted afterwards is called deleted.
   * @param {AsideEntry} a
   * @param {any} [race] the race `a.byId` as it is now (default: in the current settings), null when it is gone
   * @param {Set<string>} [deletedIds] the races deleted by then (a race that is gone without that is missing, R6)
   */
  #reason(a, race = a.byId ? this.#raceById.get(a.byId) ?? null : null, deletedIds = this.#deletedIds) {
    if (a.deleted) {
      const name = a.byName || race?.name || '';
      return name ? `its race '${name}' was deleted` : 'its race was deleted';
    }
    if (race) return `'${race.name}' no longer lists it`;
    if (!a.byId) return 'no race lists it any more';
    // a race gone from the settings: the name it had this run, else its race file's (its last settings), else the
    // name it had when the contest was set aside
    const name = this.#raceNames.get(a.byId) || this.#fileName(a.byId) || a.byName || '';
    if (!deletedIds.has(a.byId)) return name ? `'${name}' isn't in the settings any more` : 'no race lists it any more';
    return name ? `'${name}' was deleted` : 'its race was deleted';
  }

  /**
   * A race's name from its race file (the settings are saved there too), for a race that is not in the settings: a
   * missing race (R6) is named in the panel's warning by the name it had. '' when the file does not know it.
   * @param {string} id
   */
  #fileName(id) {
    return this.#fileInfo(id).name;
  }

  /** The settings a race file keeps for a race that is not in the settings (V2 "Put it back"), or null. */
  #fileSettings(id) {
    return this.#fileInfo(id).race;
  }

  /** What a race file says about a race: its name and settings. Read once per race (the panel asks twice a second). */
  #fileInfo(id) {
    if (!id) return { name: '', race: null };
    let info = this.#fileNames.get(id);
    if (info !== undefined) return info;
    info = { name: '', race: null };
    try {
      const data = this.#store?.load?.(id);
      if (data && typeof data.then === 'function') data.then(null, () => {}); // an async store: no name, and no noise
      else if (data && typeof data === 'object' && data.race && typeof data.race === 'object' && !Array.isArray(data.race)) {
        info = { name: text(data.race.name), race: data.race };
      }
    } catch {
      // only a name: the warning says "a race" instead
    }
    this.#fileNames.set(id, info);
    return info;
  }

  /** Every live read, grouped by race, home and contest: the routing rules give a group one answer (planRoutes). */
  #buckets() {
    /** @type {Map<string|null, Map<any, Map<string, Bucket>>>} */
    const byRace = new Map();
    /** @type {Bucket[]} in order of their first read, so a plan is the same every time */
    const out = [];
    for (const r of this.#readList) {
      if (r.gone !== LIVE) continue;
      let byHome = byRace.get(r.raceId);
      if (!byHome) byRace.set(r.raceId, (byHome = new Map()));
      let byKey = byHome.get(r.home);
      if (!byKey) byHome.set(r.home, (byKey = new Map()));
      let b = byKey.get(r.contestKey);
      if (!b) {
        // contest: what the panel calls it ("Port 5565" for the reads of a port, 9.15 L3)
        byKey.set(r.contestKey, (b = { raceId: r.raceId, home: r.home, key: r.contestKey, contest: keyLabel(r.contestKey, r.contest), reads: [] }));
        out.push(b);
      }
      b.reads.push(r);
    }
    return out;
  }

  /**
   * DESIGN 9.2, after the races changed, and at start (the config may have been edited while Split Relay was stopped):
   * planRoutes decides, this applies it. Deleted races' reads go out of use, contests are set aside or used again,
   * reads move. Everything is journaled in one write, in the order a replay needs it ('delete', 'unaside', 'aside',
   * then 'route'), so a restart replays to the same result and its own settle then changes nothing.
   *
   * At start only the moves are journaled. Nothing is deleted then (only the operator deletes a race: a race gone from
   * the settings is missing, R6), and a contest set aside or used again because of the settings found at start is so in
   * memory only, worked out again at the next start: a config.json put back from its backup must not change anything
   * for good, and the right one, put back later, then gives everything back.
   * @param {Routes|null} prev the races before the change (null at start)
   * @param {Set<string>} [deletedIds] the races the operator deleted in this change
   * @returns {Set<string|null>} race ids that lost or gained reads
   */
  #settle(prev, deletedIds = new Set()) {
    const now = this.#clock.now();
    const atStart = prev === null;
    const buckets = this.#buckets();
    const nameOf = (id) => this.#raceNames.get(id) ?? this.#fileName(id);
    // Set-asides a start worked out are worked out again now, from these settings; the journaled ones are the base.
    const { base, transient } = this.#asideBase();
    const plan = planRoutes(this.#routing, prev, base, this.#held, buckets, nameOf, atStart ? new Set() : deletedIds,
      { transient, atStart, prevAside: this.#effectiveAside() });
    const recs = [];
    const logs = [];
    for (const d of plan.deleted) {
      let n = 0;
      for (const b of d.buckets) {
        for (const r of b.reads) r.gone = DELETED;
        n += b.reads.length;
      }
      if (d.name) this.#raceNames.set(d.id, d.name);
      recs.push({ t: 'delete', raceId: d.id, raceName: d.name, seq: this.#seq, at: now });
      logs.push(`[engine] race ${d.name ? `'${d.name}'` : d.id} deleted: its ${n === 1 ? 'read is' : `${n} reads are`} not used any more`);
    }
    // A race deleted with no reads is journaled too: a set-aside reason may name it ("'Girls 5K' was deleted"), by the
    // last name it had, also after a restart.
    if (!atStart) {
      for (const id of deletedIds) {
        if (this.#raceById.has(id) || plan.deleted.some((d) => d.id === id)) continue;
        recs.push({ t: 'delete', raceId: id, raceName: nameOf(id), seq: this.#seq, at: now });
      }
      for (const id of deletedIds) {
        if (this.#raceById.has(id)) continue;
        this.#deletedIds.add(id);
        this.#deletedAt.set(id, { name: nameOf(id), at: now });
        // its reads are out of use for good, and so are the Moves, Keeps and made-up times about them (9.17)
        this.#forgetFixes(id);
      }
    }
    for (const key of plan.unaside) {
      const a = this.#setAside.get(key);
      const listedBy = this.#listing.get(key)[0].name;
      // A start that finds the contest listed (config.json put back, or edited) uses it again in memory only: the journal
      // keeps the set-aside, which is in effect again if the listing goes. A change made while running is journaled.
      if (atStart || a.suppressed) {
        if (!a.suppressed) logs.push(`[engine] contest "${a.contest}" is listed by ${listedBy}: its reads are used again (not saved: these are the settings found at start)`);
        a.suppressed = true;
        continue;
      }
      this.#setAside.delete(key);
      recs.push({ t: 'unaside', contest: a.contest, key, at: now });
      logs.push(`[engine] contest "${a.contest}" is listed by ${listedBy}: its reads are used again`);
    }
    for (const [key, a] of this.#setAside) if (a.suppressed && !this.#listing.has(key)) a.suppressed = false;
    // a set-aside a start worked out that no longer holds: gone, as if it had never been (nothing was journaled)
    for (const key of transient) if (!plan.added.has(key)) this.#setAside.delete(key);
    for (const [key, a] of plan.added) {
      const old = this.#setAside.get(key);
      const e = { ...a, since: old?.transient ? old.since : now };
      this.#setAside.set(key, e);
      const reason = this.#reason(e);
      if (!a.transient) recs.push({ t: 'aside', contest: a.contest, key, kind: a.deleted ? 'deleted' : 'unlisted', raceId: a.byId, raceName: a.byName, reason, at: now });
      if (!old?.transient || !a.transient) {
        logs.push(`[engine] reads of contest "${a.contest}" are set aside (not used): ${reason}. ` +
          `New reads of it are set aside too, until a race lists the contest${a.transient ? ' (not saved: these are the settings found at start)' : ''}`);
      }
    }
    // A read that had no race now belongs with the set-aside contest's reads (ASIDE). The replay of the 'aside' record
    // does the same, so it needs no record of its own. (Not for a set-aside a start worked out: no record replays it.)
    for (const b of buckets) {
      if (b.raceId !== null || b.home !== null || !plan.added.has(b.key) || plan.added.get(b.key).transient) continue;
      for (const r of b.reads) r.home = ASIDE;
    }
    const moved = new Set();
    for (const [b, t] of plan.target) {
      const to = t?.id ?? null;
      if (to === b.raceId) continue;
      moved.add(b.raceId);
      moved.add(to);
      for (const r of b.reads) {
        r.raceId = to;
        if (to !== null && r.home === null) r.home = to;
        recs.push({ t: 'route', seq: r.seq, raceId: to });
      }
    }
    this.#held = plan.held;
    const missing = new Map();
    for (const m of plan.missing) {
      const contests = new Map();
      let count = 0;
      for (const b of m.buckets) {
        const c = contests.get(b.key) ?? { contest: b.contest, blank: !b.key, ...keyFields(b.key), count: 0 };
        c.count += b.reads.length;
        contests.set(b.key, c);
        count += b.reads.length;
      }
      missing.set(m.id, { raceId: m.id, raceName: m.name, count, contests });
    }
    const wasMissing = new Set(this.#missing.keys());
    this.#missing = missing;
    for (const m of missing.values()) {
      if (wasMissing.has(m.raceId)) continue;
      logs.push(`[engine] race ${m.raceName ? `'${m.raceName}'` : m.raceId} (${m.raceId}) has ${m.count === 1 ? '1 read' : `${m.count} reads`} ` +
        'but is not in the settings: they are not used, and come back if the race does (config.json was restored or edited)');
    }
    this.#countAllNoRace(buckets);
    if (recs.length) this.#journalMany(recs);
    for (const line of logs) this.#log(line);
    return moved;
  }

  /**
   * The set-asides to plan a change from (planRoutes): the journaled ones (also those suppressed by a listing), and,
   * apart, the contests a start set aside in memory, which every change works out again.
   * @returns {{ base: Map<string, AsideEntry>, transient: Set<string> }}
   */
  #asideBase() {
    const base = new Map();
    const transient = new Set();
    for (const [k, a] of this.#setAside) {
      if (a.transient) transient.add(k);
      else base.set(k, a);
    }
    return { base, transient };
  }

  /** The set-asides in effect now: a journaled one that a race lists since a start (suppressed) is not. */
  #effectiveAside() {
    const m = new Map();
    for (const [k, a] of this.#setAside) if (!a.suppressed) m.set(k, a);
    return m;
  }

  /**
   * Why a live read that is in no race is there (DESIGN 9.2): races that are not Active list its contest ('paused': it
   * waits for them), the contest is set aside, it waits for a missing race ('race-missing'), or no race takes it.
   * @param {string} key the read's contest key
   * @returns {{ status: 'paused'|'set-aside'|'race-missing'|'no-race', raceId: string|null, raceName: string }}
   */
  #noRaceWhy(key) {
    const listing = key ? this.#listing.get(key) : undefined;
    if (listing) return { status: 'paused', raceId: listing[0].id, raceName: listing[0].name };
    if (key && this.#setAside.has(key)) return { status: 'set-aside', raceId: null, raceName: '' };
    const id = this.#held.get(key);
    if (id !== undefined) return { status: 'race-missing', raceId: id, raceName: this.#missingName(id) };
    return { status: 'no-race', raceId: null, raceName: '' };
  }

  /** The name of a missing race (R6): the one it had in the settings this run, else its race file's; '' when unknown. */
  #missingName(id) {
    return this.#missing.get(id)?.raceName || this.#raceNames.get(id) || this.#fileName(id);
  }

  /** One more (or one fewer) live read in no race: the panel's counts follow (State.noRace, State.setAside). */
  #countNoRace(rec, delta, why = this.#noRaceWhy(rec.contestKey)) {
    // per race too (9.15 V3): two missing races with reads of one contest are two warnings with their own counts
    const k = `${why.status}\u0000${rec.contestKey}\u0000${why.raceId ?? ''}`;
    let e = this.#noRace.get(k);
    if (!e) {
      this.#noRace.set(k, (e = { contest: keyLabel(rec.contestKey, rec.contest), blank: !rec.contestKey, ...keyFields(rec.contestKey),
        status: why.status, count: 0, raceId: why.raceId, raceName: why.raceName }));
    }
    e.count += delta;
    if (why.status === 'set-aside') this.#asideCount.set(rec.contestKey, (this.#asideCount.get(rec.contestKey) ?? 0) + delta);
  }

  /** The counts of the reads in no race, from scratch (after a settings change): a missing race's own reads among them. */
  #countAllNoRace(buckets) {
    this.#noRace = new Map();
    this.#asideCount = new Map();
    for (const b of buckets) {
      const r = b.reads[0];
      if (r.gone !== LIVE) continue;
      if (r.raceId === null) this.#countNoRace(r, b.reads.length);
      else if (this.#missing.has(r.raceId)) {
        this.#countNoRace(r, b.reads.length, { status: 'race-missing', raceId: r.raceId, raceName: this.#missingName(r.raceId) });
      }
    }
  }

  /** DESIGN 9.2 R3: the reads race `raceId` holds, up to journal position `seq`, are out of use for good. */
  #clearReads(raceId, seq) {
    for (const r of this.#readList) if (r.gone === LIVE && r.raceId === raceId && r.seq <= seq) r.gone = CLEARED;
    if (seq > (this.#clearSeq.get(raceId) ?? 0)) this.#clearSeq.set(raceId, seq);
  }

  // ---- the operator's decisions (DESIGN 9.17) ----------------------------------------------------------------------

  /** The operator's decision on one pass (a Pin), found again by the time of day of one of its reads. */
  #setPin(raceId, bib, tod, pin) {
    this.#touchFix(raceId, bib);
    let byBib = this.#pins.get(raceId);
    if (!byBib) this.#pins.set(raceId, (byBib = new Map()));
    let byTod = byBib.get(bib);
    if (!byTod) byBib.set(bib, (byTod = new Map()));
    byTod.set(tod, pin);
  }

  /** 9.23: the decision on that pass is forgotten (Undo, "Let Split Relay count it"); counting decides again. */
  #unsetPin(raceId, bib, tod) {
    const byBib = this.#pins.get(raceId);
    const byTod = byBib?.get(bib);
    if (!byTod?.has(tod)) return;
    this.#touchFix(raceId, bib);
    byTod.delete(tod);
    if (!byTod.size) byBib.delete(bib);
    if (!byBib.size) this.#pins.delete(raceId);
  }

  /** @param {ManualRec} m */
  #putManual(m) {
    this.#touchFix(m.raceId, m.bib);
    let byBib = this.#manuals.get(m.raceId);
    if (!byBib) this.#manuals.set(m.raceId, (byBib = new Map()));
    let bySplit = byBib.get(m.bib);
    if (!bySplit) byBib.set(m.bib, (bySplit = new Map()));
    bySplit.set(m.splitId, m);
  }

  /** @returns {ManualRec | null} the made-up time taken away */
  #takeManual(raceId, bib, splitId) {
    const bySplit = this.#manuals.get(raceId)?.get(bib);
    const m = bySplit?.get(splitId) ?? null;
    if (!m) return null;
    this.#touchFix(raceId, bib);
    bySplit.delete(splitId);
    if (!bySplit.size) this.#manuals.get(raceId).delete(bib);
    return m;
  }

  /**
   * A cleared or deleted race: the decisions about its reads are gone with them. DESIGN 9.23 F10: a Clear race data
   * from this version on keeps the pins (keepPins): they are keyed by the reads' times of day, so they apply again to
   * the very reads a Replay in RR12 brings back, and to nothing else. Made-up times and the changes' history go.
   */
  #forgetFixes(raceId, { keepPins = false } = {}) {
    if (!keepPins) this.#pins.delete(raceId);
    // (9.24: a stopped runner stays stopped with the pins: from a time of day, as they are; 9.25: and what the operator
    // said of a runner, here or not in this race: the same bib comes back with a Replay)
    if (!keepPins) this.#offs.delete(raceId);
    if (!keepPins) this.#says.delete(raceId);
    this.#manuals.delete(raceId);
    const groups = this.#fixGroups.get(raceId);
    if (groups?.size) {
      let dropped = this.#fixDropped.get(raceId);
      if (!dropped) this.#fixDropped.set(raceId, (dropped = new Set()));
      for (const id of groups.keys()) dropped.add(id);
    }
    this.#fixGroups.delete(raceId);
  }

  /**
   * One record of an operator's fix, applied to the decisions (live and at replay alike, so the two always agree).
   * @returns {ManualRec | null} the made-up time a 'manual' record put in
   */
  #applyFixRecord(rec) {
    const raceId = text(rec.raceId);
    const bib = text(rec.bib);
    if (!raceId || !bib) return null;
    if (rec.t === 'assign') {
      if (Number.isInteger(rec.tod)) this.#setPin(raceId, bib, rec.tod, pinOf(rec));
    } else if (rec.t === 'unassign') {
      if (Number.isInteger(rec.tod)) this.#unsetPin(raceId, bib, rec.tod);
    } else if (rec.t === 'manual') {
      // 9.27: a time made while the bib is one of a swapped pair was made from the other chip's reads, and says so (a
      // time an Undo puts back says what it was made with itself)
      const other = rec.chip === undefined && rec.restored !== true ? this.#swapBy.get(bibKey(bib))?.other : undefined;
      if (other !== undefined) rec.chip = other;
      const m = manualRec(rec, ++this.#mseq);
      if (m) this.#putManual(m);
      return m;
    } else if (rec.t === 'unmanual') this.#takeManual(raceId, bib, text(rec.splitId));
    else if (rec.t === 'runner-off') {
      if (Number.isInteger(rec.from)) this.#setOff(raceId, bib, { from: rec.from, at: finite(rec.at) ?? 0 });
    } else if (rec.t === 'runner-on') this.#setOff(raceId, bib, null);
    else if (rec.t === 'runner-say') this.#setSay(raceId, bib, rec.say === 'here' || rec.say === 'away' ? rec.say : null);
    return null;
  }

  /** 9.25: what the operator says of where a runner runs: 'here', 'away' (not in this race), or null (nothing said). */
  #setSay(raceId, bib, say) {
    let byBib = this.#says.get(raceId);
    if ((byBib?.get(bib) ?? null) === say) return;
    this.#touchFix(raceId, bib);
    if (say) {
      if (!byBib) this.#says.set(raceId, (byBib = new Map()));
      byBib.set(bib, say);
    } else {
      byBib.delete(bib);
      if (!byBib.size) this.#says.delete(raceId);
    }
  }

  /** 9.24: stop sending a runner from a time of day on ({ from, at }), or send it again (null). */
  #setOff(raceId, bib, off) {
    let byBib = this.#offs.get(raceId);
    if (!off && !byBib?.has(bib)) return;
    this.#touchFix(raceId, bib);
    if (off) {
      if (!byBib) this.#offs.set(raceId, (byBib = new Map()));
      byBib.set(bib, off);
    } else {
      byBib.delete(bib);
      if (!byBib.size) this.#offs.delete(raceId);
    }
  }

  /** A runner's decisions right now: pins by time of day, made-up times by split (copies), and whether it is stopped. */
  #fixState(raceId, bib) {
    return { pins: new Map(this.#pins.get(raceId)?.get(bib) ?? []), manuals: new Map(this.#manuals.get(raceId)?.get(bib) ?? []),
      off: this.#offs.get(raceId)?.get(bib) ?? null, say: this.#says.get(raceId)?.get(bib) ?? null };
  }

  #fixSigOf(raceId, bib) {
    const s = this.#fixState(raceId, bib);
    return fixSig(s.pins, s.manuals, s.off, s.say);
  }

  /** Start one change (9.23 F3): what each runner it touches had is noted before its first decision changes. */
  #beginFix(raceId, kind, id = this.#fixSeq + 1, at = this.#clock.now()) {
    this.#fixOpen = { group: { id, raceId, kind, text: '', at, bibs: new Map(), undoneBy: null, undoes: null, byFinish: false }, before: new Map() };
    return this.#fixOpen.group;
  }

  #touchFix(raceId, bib) {
    const f = this.#fixOpen;
    if (!f || f.group.raceId !== raceId || f.before.has(bib)) return;
    f.before.set(bib, this.#fixState(raceId, bib));
  }

  /**
   * End the change: its inverse per runner, worked out by comparing what the runner had before with what it has now
   * (a pin added is forgotten, a pin changed or removed is set back, a made-up time added is taken out, one changed or
   * removed comes back exactly as it was, its journal position included, so a late read is judged as before), and
   * what the runner has after it (Undo is allowed while that is still so). Kept for Undo.
   */
  #endFix() {
    const f = this.#fixOpen;
    this.#fixOpen = null;
    if (!f) return null;
    const g = f.group;
    for (const [bib, before] of f.before) {
      const now = this.#fixState(g.raceId, bib);
      const inverse = [];
      for (const [tod] of now.pins) if (!before.pins.has(tod)) inverse.push({ t: 'unassign', tod });
      for (const [tod, pin] of before.pins) if (!samePin(now.pins.get(tod), pin)) inverse.push({ t: 'assign', tod, ...pinFields(pin) });
      for (const [splitId, m] of now.manuals) if (!before.manuals.has(splitId)) inverse.push({ t: 'unmanual', splitId });
      for (const [splitId, m] of before.manuals) {
        if (now.manuals.get(splitId) === m) continue;
        inverse.push({ t: 'manual', splitId, raceTicks: m.raceTicks, tod: m.tod, estimated: m.estimated, basis: m.basis, at: m.at, seq: m.seq, restored: true,
          // (9.27: and the chip it was made with, when that was not the bib's own)
          ...(m.chip !== bib ? { chip: m.chip } : {}) });
      }
      // (9.24: a runner stopped is sent again, one sent again is stopped from where it was)
      if (now.off && !before.off) inverse.push({ t: 'runner-on' });
      else if (before.off && now.off?.from !== before.off.from) inverse.push({ t: 'runner-off', from: before.off.from });
      // (9.25: what the operator said of where the runner runs goes back to what it was)
      if (now.say !== before.say) inverse.push({ t: 'runner-say', say: before.say });
      g.bibs.set(bib, { inverse, sigAfter: fixSig(now.pins, now.manuals, now.off, now.say) });
    }
    if (g.id > this.#fixSeq) this.#fixSeq = g.id;
    let groups = this.#fixGroups.get(g.raceId);
    if (!groups) this.#fixGroups.set(g.raceId, (groups = new Map()));
    groups.set(g.id, g);
    return g;
  }

  /**
   * At replay: the records of one change come together (one write), each with its fix id; the first says what it was.
   * An 'undo' record starts the change that undoes another.
   */
  #replayFixGroup(rec) {
    const isUndo = rec.t === 'undo';
    const fid = isUndo ? rec.by : FIX_RECORDS.has(rec.t) ? rec.fix : undefined;
    const id = Number.isInteger(fid) && fid > 0 ? fid : null;
    const raceId = text(rec.raceId);
    const open = this.#fixOpen?.group;
    if (open && (isUndo || id === null || id !== open.id || raceId !== open.raceId)) this.#endFix();
    if (id === null || !raceId) return;
    if (id > this.#fixSeq) this.#fixSeq = id;
    if (this.#fixOpen) return;
    const g = this.#beginFix(raceId, isUndo ? 'undo' : text(rec.fixKind) || 'fix', id, finite(rec.at) ?? 0);
    g.text = text(isUndo ? rec.text : rec.fixText);
    g.byFinish = rec.byFinish === true;
    if (isUndo && Number.isInteger(rec.fix)) {
      g.undoes = rec.fix;
      const undone = this.#fixGroups.get(raceId)?.get(rec.fix);
      if (undone) undone.undoneBy = id;
    }
  }

  /** Whether a runner has Moves, Keeps or made-up times: then a new read works the runner out again from scratch. */
  #hasFixes(raceId, bib) {
    return !!(this.#pins.get(raceId)?.has(bib) || this.#manuals.get(raceId)?.has(bib));
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  /** Out of use for good: cleared, or its race was deleted (DESIGN 9.2 R2, R3). */
  #dead(r) {
    return r.gone !== LIVE;
  }

  /** matchKey of a timing point or contest name, worked out once per distinct name. */
  #keyOf = (s) => {
    let k = this.#keys.get(s);
    if (k === undefined) {
      if (this.#keys.size >= INTERN_MAX) this.#keys.clear();
      k = this.#intern(matchKey(s));
      this.#keys.set(s, k);
    }
    return k;
  };

  /**
   * The read already received with this bib, timing point and time of day, or null. One that still counts is
   * preferred; one out of use (cleared, or its race deleted) is returned when there is no other, so it stays out of use.
   */
  #findExact(r) {
    const list = this.#byBib.get(r.chip);
    if (!list) return null;
    let cleared = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i];
      if (x.tod !== r.tod || x.locKey !== r.locKey) continue;
      if (!this.#dead(x)) return x;
      cleared ??= x;
    }
    return cleared;
  }

  #duplicate(r, prev, now) {
    const entry = this.#entryFor(r, now);
    Object.assign(entry, this.#describe(prev), {
      place: null, status: 'duplicate',
      detail: prev.gone === CLEARED
        ? 'Already received, and cleared with "Clear race data" (RR12 replay or a repeated line). Ignored.'
        : prev.gone === DELETED
          ? `Already received, and not used: ${this.#deletedText(prev)} (RR12 replay or a repeated line). Ignored.`
          : 'Already received (RR12 replay or a repeated line). Ignored.',
    });
    return entry;
  }

  #badLine(read, detail, now, port = read?.port) {
    const entry = this.#entryFor({ location: text(read?.location), bib: text(read?.bib), tod: null, port }, now);
    entry.status = 'bad-line';
    entry.detail = detail;
    return entry;
  }

  #failed(read, err, now) {
    this.#log(`[engine] could not process a read: ${err?.stack ?? err}`);
    return this.#badLine(read, `Split Relay could not process this read (${err?.message ?? err})`, now);
  }

  #addRead(rec) {
    this.#readList.push(rec);
    // (9.27: by the bib as received: a repeated line is the same line whatever runner it counts for)
    let list = this.#byBib.get(rec.chip);
    if (!list) this.#byBib.set(rec.chip, (list = []));
    list.push(rec);
  }

  #see(read, at) {
    const bump = (map, key, name) => {
      if (!key) return;
      const row = map.get(key) ?? { name, count: 0, lastAt: null };
      row.count++;
      row.lastAt = at;
      map.set(key, row);
    };
    bump(this.#seenLocations, read.locKey, read.location);
    // the contest picker offers contests only; the port and event keys of LapTime reads are not contests
    if (read.contest) bump(this.#seenContests, read.contestKey, read.contest);
    this.#seenKeys.add(read.contestKey);
    if (!read.locKey) this.#passesSeen++;
  }

  /**
   * One read's clock lag (DESIGN 9.16 F6). It waits LAG_BURST_MS before it counts: if reads arrive meanwhile whose lags
   * are far apart, they came in a burst (RR12 flushing its queue) and none of them counts.
   * @param {number} arrivalTod this PC's local time of day when the read arrived, in ticks
   * @param {number} now wall ms of the arrival
   */
  #sampleLag(rec, arrivalTod, now) {
    let d = arrivalTod - rec.tod;
    if (d > TICKS_PER_DAY / 2) d -= TICKS_PER_DAY;
    else if (d < -TICKS_PER_DAY / 2) d += TICKS_PER_DAY;
    this.#settleLag(now);
    const win = this.#lagWin;
    const i = win.length;
    const lag = d / TICKS_PER_SEC;
    win.push({ at: now, lag });
    // monotonic queues: the front of #lagMin.q is the smallest lag still waiting, of #lagMax.q the largest
    const mins = this.#lagMin;
    const maxs = this.#lagMax;
    while (mins.q.length > mins.h && win[mins.q[mins.q.length - 1]].lag >= lag) mins.q.pop();
    mins.q.push(i);
    while (maxs.q.length > maxs.h && win[maxs.q[maxs.q.length - 1]].lag <= lag) maxs.q.pop();
    maxs.q.push(i);
    // a flush: every read still waiting is part of it (each is marked once, so a long flush costs nothing extra)
    if (win[maxs.q[maxs.h]].lag - win[mins.q[mins.h]].lag > LAG_BURST_SPREAD_SEC) this.#lagFlagged = win.length;
  }

  /** Reads that waited LAG_BURST_MS without a flush around them become clock lag samples. */
  #settleLag(now) {
    const win = this.#lagWin;
    const mins = this.#lagMin;
    const maxs = this.#lagMax;
    while (this.#lagHead < win.length && now - win[this.#lagHead].at > LAG_BURST_MS) {
      const i = this.#lagHead++;
      if (mins.q[mins.h] === i) mins.h++;
      if (maxs.q[maxs.h] === i) maxs.h++;
      if (i < this.#lagFlagged) continue; // came in a flush
      const lag = win[i].lag;
      if (this.#lag.length < LAG_SAMPLES) this.#lag.push(lag);
      else this.#lag[this.#lagPos++ % LAG_SAMPLES] = lag;
    }
    // drop what has been used, now and then, so the window never holds more than a moment of reads
    if (this.#lagHead > 1024 && this.#lagHead * 2 > win.length) {
      const cut = this.#lagHead;
      this.#lagWin = win.slice(cut);
      this.#lagHead = 0;
      this.#lagFlagged = Math.max(0, this.#lagFlagged - cut);
      for (const m of [mins, maxs]) {
        m.q = m.q.slice(m.h).map((j) => j - cut);
        m.h = 0;
      }
    }
  }

  #journal(rec) {
    this.#journalMany([rec]);
  }

  /**
   * Append records to the journal. The store writes them with one write when it can (appendJournalMany): a chunk of
   * 1,300 reads from an RR12 Replay is one disk write, not 1,300.
   */
  #journalMany(recs) {
    const store = this.#store;
    if (typeof store?.appendJournalMany !== 'function' && typeof store?.appendJournal !== 'function') return;
    try {
      if (typeof store.appendJournalMany === 'function') store.appendJournalMany(recs);
      else for (const rec of recs) store.appendJournal(rec);
    } catch (err) {
      const now = this.#clock.now();
      if (now - this.#journalWarnedAt < JOURNAL_WARN_MS) return;
      this.#journalWarnedAt = now;
      this.#log(`[engine] could not write the read journal, so new reads are not saved until it works again: ${err?.message ?? err}`);
    }
  }

  /**
   * On start: the journal rebuilds every read, its race and home, every clear, delete and set-aside, record by record
   * in the order they happened, which is what makes the result the same as before the stop. Nothing per crossing is
   * trusted from disk.
   */
  #replay(now) {
    let recs = [];
    try {
      const j = this.#store?.loadJournal?.();
      recs = Array.isArray(j) ? j : arr(j?.records);
    } catch (err) {
      this.#log(`[engine] could not read the read journal: ${err?.message ?? err}`);
    }
    /** seq -> read, while the journal is read (route records name their read by seq) */
    const bySeq = new Map();
    for (const rec of recs) {
      if (!rec || typeof rec !== 'object') continue;
      // 9.23 F3: the operator's changes, as groups of records (an Undo works after a restart)
      this.#replayFixGroup(rec);
      if (rec.t === 'read') {
        const r = cleanRead(rec, this.#intern, this.#keyOf, rec.port);
        if (typeof r === 'string' || !Number.isInteger(rec.seq) || bySeq.has(rec.seq)) continue;
        const raceId = text(rec.raceId) || null;
        // a read that came while its contest was set aside belongs with the contest's other reads (ASIDE)
        // revision 6 journals it; an older journal: whether the contest was set aside at that point of the journal
        const home = raceId ?? (rec.aside === 1 ? ASIDE : rec.aside === 0 ? null : r.contestKey && this.#setAside.has(r.contestKey) ? ASIDE : null);
        const read = placeRec(r, rec.seq, finite(rec.at) ?? now, rec.conn ?? null, raceId, home);
        if (read.seq > this.#seq) this.#seq = read.seq;
        // An older Split Relay journaled a read again after its race was cleared; it counted then, so it counts now.
        const prev = this.#findExact(read);
        if (prev && !this.#dead(prev)) continue;
        this.#addRead(read);
        bySeq.set(read.seq, read);
        this.#see(read, read.at);
      } else if (rec.t === 'route') {
        const read = bySeq.get(rec.seq);
        if (read && read.gone === LIVE) {
          read.raceId = text(rec.raceId) || null;
          // The first race a read is given is its home (a journal from before revision 4 has no other record of it).
          read.home ??= read.raceId;
        }
      } else if (rec.t === 'aside') {
        const contest = text(rec.contest);
        // revision 7 writes the routing key (a port's or an event's is not the contest's matchKey); before, the contest
        const key = typeof rec.key === 'string' && rec.key ? rec.key : matchKey(contest);
        if (!key) continue;
        const byId = text(rec.raceId) || null;
        // revision 4 wrote no kind: it named the race only when the race still existed (it stopped listing it)
        const deleted = rec.kind === 'deleted' || (rec.kind !== 'unlisted' && !byId);
        this.#setAside.set(key, { contest: contest || keyLabel(key), key, byId, byName: text(rec.raceName), deleted, since: finite(rec.at) ?? now });
        // as #settle does: the reads of it that never had a race now belong with the set-aside ones
        for (const r of this.#readList) if (r.home === null && r.gone === LIVE && r.contestKey === key) r.home = ASIDE;
      } else if (rec.t === 'unaside') {
        this.#setAside.delete(typeof rec.key === 'string' && rec.key ? rec.key : matchKey(rec.contest));
      } else if (rec.t === 'clear') {
        const id = text(rec.raceId);
        if (id && Number.isInteger(rec.seq)) this.#clearReads(id, rec.seq);
        // the operator's decisions about those reads go with them (9.17); a clear of 9.23 on keeps the pins (keepPins)
        if (id) this.#forgetFixes(id, { keepPins: rec.keepPins === true });
      } else if (rec.t === 'new-meet') {
        // 9.22 M9: every read up to it out of use, wherever it was
        if (Number.isInteger(rec.seq)) this.#startMeet(rec.seq);
      } else if (FIX_RECORDS.has(rec.t)) {
        // 9.17 P2/P3, 9.23 F2: a pin set or forgotten (Move, Keep, hold, Not a split, the finish), a made-up (or typed)
        // time sent or taken back
        this.#applyFixRecord(rec);
      } else if (rec.t === 'swap') {
        // 9.27: a pair of swapped bibs (one that breaks the rules, a journal edited by hand, is left out)
        const a = text(rec.a);
        const b = text(rec.b);
        if (!swapBibProblem(a) && !swapBibProblem(b) && bibKey(a) !== bibKey(b) && !this.#swapBy.has(bibKey(a)) && !this.#swapBy.has(bibKey(b))) {
          this.#putSwap(a, b, finite(rec.at) ?? now);
        }
      } else if (rec.t === 'unswap') {
        const s = this.#swapBy.get(bibKey(text(rec.a)))?.swap;
        if (s && this.#swapBy.get(bibKey(text(rec.b)))?.swap === s) this.#dropSwap(s);
      } else if (rec.t === 'delete') {
        const id = text(rec.raceId);
        if (!id) continue;
        this.#forgetFixes(id);
        if (text(rec.raceName) && !this.#raceById.has(id)) this.#raceNames.set(id, text(rec.raceName));
        this.#deletedIds.add(id);
        this.#deletedAt.set(id, { name: text(rec.raceName), at: finite(rec.at) });
        const upTo = Number.isInteger(rec.seq) ? rec.seq : Infinity;
        for (const r of this.#readList) if (r.gone === LIVE && r.raceId === id && r.seq <= upTo) r.gone = DELETED;
      } else if (rec.t === 'undelete') {
        // 9.15 V5: the operator kept a deleted race that came back in the settings; its old reads stay out of use
        const id = text(rec.raceId);
        this.#deletedIds.delete(id);
        this.#deletedAt.delete(id);
      }
    }
    // a change at the very end of the journal (a stop cut off after it is whole as far as it was written)
    if (this.#fixOpen) this.#endFix();
    // 9.27: every read counts for the runner the swaps in force at the end give it
    if (this.#swapList.length) for (const r of this.#readList) this.#label(r);
    // Anything after the last clean stop (a read, a route) means the process ended some other way.
    const last = recs.findLast((rec) => rec && typeof rec === 'object');
    this.#cleanStop = !last || last.t === 'stop';
  }

  /**
   * After a kill or a crash: what the outputs acknowledged in the minute before their last acknowledgement may never
   * have left this PC (see UNCLEAN_REDELIVER_MS). Those ledger entries are noted now and forgotten REDELIVER_SETTLE_MS
   * after start(), so convergence then delivers them again.
   */
  #collectSuspects() {
    let latest = -Infinity;
    for (const state of this.#states.values()) {
      for (const ledger of state.ledgers.values()) for (const e of ledger.values()) if (e.at > latest) latest = e.at;
    }
    if (latest === -Infinity) return;
    const cutoff = latest - UNCLEAN_REDELIVER_MS;
    const suspects = [];
    for (const state of this.#states.values()) {
      for (const [outputId, ledger] of state.ledgers) {
        for (const [key, entry] of ledger) if (entry.at >= cutoff) suspects.push({ state, outputId, key, entry });
      }
    }
    if (!suspects.length) return;
    this.#suspects = suspects;
    const n = suspects.length;
    this.#log(`[engine] Split Relay did not stop cleanly last time. The ${n === 1 ? 'packet' : `${n} packets`} the outputs ` +
      `took in its last minute go out again in ${REDELIVER_SETTLE_MS / 1000} s, in case they never left this PC.`);
  }

  /**
   * Forget the suspect ledger entries that are still what the output had before the crash (a newer packet that was
   * acknowledged since, or a cleared race, replaces them), so convergence sends them again. Convergence never sends to
   * a runner who has finished, and by now RR12's queued finish reads and FinishLynx's finishers are in.
   * @param {boolean} send false at stop(): only forgotten (and saved), so the next start sends them
   */
  #releaseSuspects(send) {
    this.#clearSuspectTimer();
    const suspects = this.#suspects ?? [];
    this.#suspects = null;
    const touched = new Set();
    /** (9.23 F14: what was forgotten, for a finisher's furthest split: #redelivered) */
    const forgot = new Map();
    for (const { state, outputId, key, entry } of suspects) {
      const ledger = state.ledgers.get(outputId);
      if (this.#states.get(state.id) !== state || ledger?.get(key) !== entry) continue;
      // the cell it filled is still there if it did reach the scoreboard (9.16 F1)
      this.#orphan(state, outputId, entry);
      ledger.delete(key);
      state.dirty.add(key);
      touched.add(state);
      if (!forgot.has(state)) forgot.set(state, new Map());
      forgot.get(state).set(`${outputId}|${key}`, entry);
    }
    // Saved, so a clean stop before they could go out (the output still down) does not forget them.
    for (const state of touched) this.#saveSoon(state);
    if (!send || !touched.size) return;
    this.#redelivered = forgot;
    try {
      this.#converge(this.#clock.now());
    } finally {
      this.#redelivered = null;
    }
    this.#after();
  }

  #clearSuspectTimer() {
    if (this.#suspectTimer !== null) this.#clock.clearTimeout(this.#suspectTimer);
    this.#suspectTimer = null;
  }

  // ---- race state -----------------------------------------------------------------------------------------------

  #newState(id) {
    return {
      id,
      epoch: 0,
      /** bib -> live reads of this race (seq > clearedSeq), journal order */
      reads: new Map(),
      bibKeys: new Map(),
      /** bib -> derivation (newBibState: crossings kept, finish, outcome per read) */
      bibs: new Map(),
      /** outcome kind -> reads of this race with it (the sum of every runner's counts), for the race view */
      counts: Object.fromEntries(COUNTED.map((k) => [k, 0])),
      /** crossing key -> kept crossing */
      kept: new Map(),
      /** split id -> kept crossings in place order */
      ranks: new Map(),
      names: new Map(),
      locations: new Map(),
      contests: new Map(),
      lastReadAt: null,
      /** the race's clock by arrival (the place rule, revision 10): arrival times, and the latest time of day so far */
      clock: { ats: [], tods: [] },
      runnerCount: 0,
      derivedSig: null,
      active: null,
      lynx: new Map(),
      lynxSig: '',
      /** bibKey -> when the relay first saw that finisher in FinishLynx's file (wall ms; the place rule, revision 10) */
      lynxSeenAt: new Map(),
      /** output id -> crossing key -> what that output acknowledged */
      ledgers: new Map(),
      /**
       * output id -> bib -> 'l2g|count' of the packets it took that no ledger entry stands for any more (replaced by a
       * packet for another column, or for a crossing that no longer counts): TrackScore's cell still has that time
       * (9.16 F1). Cleared with the race.
       */
      orphans: new Map(),
      /** output id -> crossing key -> packets handed over, not yet acknowledged */
      flights: new Map(),
      /** output id -> crossing keys it could not take (retried when its status changes) */
      failed: new Map(),
      /** crossing key -> when it was released (its hold over) and what went out live */
      rel: new Map(),
      /** crossing keys in their hold */
      unreleased: new Set(),
      dirty: new Set(),
      dirtyAll: true,
      feedBibs: new Set(),
      feedAllBibs: false,
      /** the race's settings as its race file has them (JSON), to save them there when they change (R6) */
      savedRace: null,
      /** the race's settings when it was last in the settings: what its file keeps once it is missing (R6, V2) */
      lastRace: null,
      /** bibKey -> FinishLynx finish place (9.17 P4) */
      lynxPlace: new Map(),
      /** which splits were paused when the race was last looked at (9.17 P1): a change re-delivers the race */
      sendSig: null,
      /**
       * The column check (9.17 P2), worked out again whenever the crossings changed (checkDirty): suspects (bib ->
       * Suspect), held (crossing key -> why it is held), heldBySplit (split id -> held crossing keys).
       */
      check: null,
      checkDirty: true,
      /** goes up whenever the crossings change: the Review list is cached by it */
      version: 0,
      reviewCache: null,
      /** 9.26: the reads the tag filter merged that came late (#lateMerged), by the race's version and the tag filter */
      lateCache: null,
      /**
       * 9.23 F4: crossing key -> the content the operator approved for it (a Move, a fill, an Undo): convergence sends
       * it whatever the minute (RESEND_WINDOW_MS) says, also on a retry after an output was down. { sig, cell }: sig is
       * null while it waits (a paused split, a column in doubt): its time and column (cell) are approved, and it takes
       * the place it has when it is let go (#approvalOf). Not saved.
       */
      approved: new Map(),
      /**
       * 9.23 F21: crossing key -> the time of day of the crossing the column check held and then let go (Split Relay's
       * own question, answered): a finisher's goes out with the finish place by itself once no output has it. Not saved.
       */
      letGo: new Map(),
      /** goes up whenever an output is handed a packet or answers for one: the race grid's revision follows it */
      deliveryRev: 0,
    };
  }

  #stateFor(race, now) {
    const state = this.#newState(race.id);
    this.#states.set(race.id, state);
    this.#touched.add(race.id);
    if (!this.#store?.load) return state;
    let data = null;
    try {
      data = this.#store.load(race.id);
    } catch (err) {
      this.#log(`[engine] could not load the saved deliveries of ${race.name}: ${err?.message ?? err}`);
    }
    if (data && typeof data.then === 'function') {
      // The contract asks for a synchronous load; an async store still works, merged in when it arrives.
      data.then((d) => this.#lateLoad(race.id, state, d), (err) => this.#log(`[engine] could not load ${race.name}: ${err?.message ?? err}`));
    } else if (data && typeof data === 'object') {
      this.#applyRaceFile(race, state, data, now, false);
      if (data.race !== undefined) state.savedRace = JSON.stringify(data.race);
    }
    return state;
  }

  #lateLoad(raceId, state, data) {
    const race = this.#raceById.get(raceId);
    if (!race || this.#states.get(raceId) !== state || !data || typeof data !== 'object') return;
    if (this.#applyRaceFile(race, state, data, this.#clock.now(), true)) this.#collectReads(state);
    this.#rebuildRace(race, state);
    this.#restoreReleases(state);
    this.#converge(this.#clock.now());
    this.#after();
  }

  /** @returns {boolean} whether reads of the race were cleared by it (a clear the journal had missed) */
  #applyRaceFile(race, state, data, now, merge) {
    if (Array.isArray(data.crossings)) {
      this.#migrateV1(race, state, data, now);
      return false;
    }
    let cleared = false;
    // The journal records every clear; a race file that knows a later one means that journal write failed. The clear
    // is journaled now, so the next start replays it in this same place. A new meet counts as a clear of every race
    // (a race file saved since says so: #serialize), so such a file is no reason to journal one again.
    if (Number.isInteger(data.clearedSeq) && data.clearedSeq > Math.max(this.#clearSeq.get(race.id) ?? 0, this.#meetSeq)) {
      this.#journal({ t: 'clear', raceId: race.id, seq: data.clearedSeq });
      this.#clearReads(race.id, data.clearedSeq);
      cleared = true;
    }
    // A race file not saved again since "Start a new meet" (a kill within the save delay, a disk error) holds the last
    // meet's deliveries: brought back, they would show as leftover or stale cells of this meet (9.22 M9).
    if (this.#meetSeq > 0 && !(Number.isInteger(data.clearedSeq) && data.clearedSeq >= this.#meetSeq)) return cleared;
    const ledgers = data.ledgers && typeof data.ledgers === 'object' ? data.ledgers : {};
    for (const [outputId, entries] of Object.entries(ledgers)) {
      let ledger = state.ledgers.get(outputId);
      if (!ledger) state.ledgers.set(outputId, (ledger = new Map()));
      for (const e of arr(entries)) {
        const [key, tod, place, gun, l2g, firstAt, at, waived, count, fixedAt, ls] = arr(e);
        if (typeof key !== 'string' || !Number.isInteger(tod) || !Number.isInteger(place)) continue;
        if (merge && ledger.has(key)) continue;
        const g = Number.isInteger(gun) ? gun : null;
        const l = Number.isInteger(l2g) ? l2g : null;
        // a race file from before revision 7 has no split count: it was sent with the splits the race has now
        const k = Number.isInteger(count) ? count : race.sentCount;
        ledger.set(key, ledgerEntry(key, tod, place, g, l, k, 0, finite(firstAt) ?? now, finite(at) ?? now,
          // a waived content of before revision 7 has no split count in it
          typeof waived === 'string' ? (waived.split('|').length === 4 ? `${waived}|${k}` : waived) : null, finite(fixedAt), Number.isInteger(ls) ? ls : null));
      }
    }
    // the cells an output was given that no ledger entry stands for (9.16 F1); a file from before has none
    const orphans = data.orphans && typeof data.orphans === 'object' ? data.orphans : {};
    for (const [outputId, rows] of Object.entries(orphans)) {
      for (const r of arr(rows)) {
        const [bib, l2g, count] = arr(r);
        if (typeof bib === 'string' && bib) this.#orphan(state, outputId, { bib, l2g, count });
      }
    }
    return cleared;
  }

  /**
   * A race file from before revision 2 holds crossings, not reads. Its reads go into the journal (a crossing's mat is
   * taken to be the split's first timing point) and what it had sent becomes the ledger of every output, so the
   * upgrade sends nothing twice.
   */
  #migrateV1(race, state, data, now) {
    const names = new Map(arr(data.names).map((n) => [text(n?.bib), n]));
    // The old file kept no contest per crossing; one the race lists keeps the read in this race when contests move.
    const contest = list(race.race?.contests)[0] ?? '';
    let n = 0;
    const add = (r) => {
      const c = cleanRead(r, this.#intern, this.#keyOf);
      if (typeof c === 'string') return;
      const prev = this.#findExact(c);
      if (prev && !this.#dead(prev)) return;
      this.#label(c);
      const rec = placeRec(c, this.#seq + 1, finite(r.arrivedAt) ?? now, null, race.id);
      this.#journal(journalRead(rec));
      this.#seq = rec.seq;
      this.#addRead(rec);
      n++;
    };
    const gun = Number.isInteger(data.gunTicks) ? data.gunTicks : race.gunTicks;
    for (const c of arr(data.crossings)) {
      const split = race.splitById.get(text(c?.splitId));
      if (!split || !split.sources.length || !Number.isInteger(c.tod)) continue;
      const nm = names.get(text(c.bib)) ?? {};
      for (const tod of new Set([c.tod, ...arr(c.readTods).filter(Number.isInteger)])) {
        add({ location: split.sources[0], bib: c.bib, tod, contest, first: nm.first, last: nm.last, team: nm.team, gender: nm.gender, arrivedAt: c.arrivedAt });
      }
      if (finite(c.sentAt) === null || !Number.isInteger(c.sentPlace)) continue;
      // (9.26: a split that is not sent has no cell on the boards)
      const l2g = split.l2g;
      if (l2g === null) continue;
      for (const o of this.#outputs) {
        if (!takes(o, race.id)) continue;
        let ledger = state.ledgers.get(o.id);
        if (!ledger) state.ledgers.set(o.id, (ledger = new Map()));
        const key = crossingKey(text(c.bib), split.id);
        ledger.set(key, ledgerEntry(key, c.tod, c.sentPlace, gun, l2g, race.sentCount, 0, finite(c.firstSentAt) ?? c.sentAt, c.sentAt));
      }
    }
    for (const r of [...arr(data.pending), ...arr(data.early)]) add(r);
    this.#log(`[engine] ${race.name}: converted the saved race file to the new format (${n} reads)`);
    this.#saveSoon(state);
  }

  /** Every live read into its race. */
  #collectAll() {
    for (const state of this.#states.values()) this.#resetReads(state);
    for (const r of this.#readList) {
      if (this.#dead(r)) continue;
      const state = r.raceId ? this.#states.get(r.raceId) : null;
      if (state) this.#addToState(state, r);
    }
  }

  #collectReads(state) {
    this.#resetReads(state);
    for (const r of this.#readList) if (r.raceId === state.id && !this.#dead(r)) this.#addToState(state, r);
  }

  #resetReads(state) {
    state.reads = new Map();
    state.bibKeys = new Map();
    state.names = new Map();
    state.locations = new Map();
    state.contests = new Map();
    state.lastReadAt = null;
    // the race's clock by arrival (the place rule, revision 10): arrival times, and the latest time of day so far
    state.clock = { ats: [], tods: [] };
  }

  #addToState(state, rec) {
    let reads = state.reads.get(rec.bib);
    if (!reads) {
      state.reads.set(rec.bib, (reads = []));
      state.bibKeys.set(bibKey(rec.bib), rec.bib);
    }
    reads.push(rec);
    if (state.lastReadAt === null || rec.at > state.lastReadAt) state.lastReadAt = rec.at;
    if (Number.isFinite(rec.at) && Number.isFinite(rec.tod)) {
      const { ats, tods } = state.clock;
      const k = ats.length;
      // reads come in arrival order; a PC clock set back keeps the list in order (the read counts as just in)
      ats.push(k && rec.at < ats[k - 1] ? ats[k - 1] : rec.at);
      tods.push(k && tods[k - 1] > rec.tod ? tods[k - 1] : rec.tod);
    }
    const loc = state.locations.get(rec.locKey) ?? { name: rec.location, count: 0 };
    loc.count++;
    state.locations.set(rec.locKey, loc);
    let con = state.contests.get(rec.contestKey);
    if (!con) state.contests.set(rec.contestKey, (con = { name: keyLabel(rec.contestKey, rec.contest), count: 0 }));
    con.count++;
    this.#learnNames(state, rec);
  }

  #learnNames(state, read) {
    const gender = normalizeGender(read.gender);
    if (!read.first && !read.last && !read.team && !gender) return;
    // (9.27: a name RR12 sends with a read is the name of the bib it was read as, not of the runner who carried the chip)
    let n = state.names.get(read.chip);
    if (!n) state.names.set(read.chip, (n = { first: '', last: '', team: '', gender: '' }));
    n.first ||= foldAscii(read.first);
    n.last ||= foldAscii(read.last);
    n.team ||= foldAscii(read.team);
    n.gender ||= gender;
  }

  /**
   * Names exactly as FinishLynx has them (people file) win field by field, because TrackScore keeps the latest
   * non-empty value and two spellings would flip-flop on the boards; the stream fills what the file leaves blank.
   */
  #who(state, bib, read = null) {
    let n;
    try {
      n = this.#names?.lookup?.(bib);
    } catch (err) {
      this.#log(`[engine] names lookup failed for bib ${bib}: ${err?.message ?? err}`);
    }
    const s = state?.names.get(bib);
    return {
      first: text(n?.first) || s?.first || foldAscii(read?.first) || '',
      last: text(n?.last) || s?.last || foldAscii(read?.last) || '',
      team: text(n?.team) || s?.team || foldAscii(read?.team) || '',
      gender: normalizeGender(n?.gender) || s?.gender || normalizeGender(read?.gender),
    };
  }

  /**
   * The runner's finish race time: the earliest finish read, or FinishLynx's finish, whichever is earlier; null while
   * on the course. (The finish reads are taken as they are: their order does not matter for the earliest.)
   */
  #finishOf(state, bib, d = state.bibs.get(bib)) {
    let own = null;
    for (const f of d?.finishes ?? []) if (own === null || f.rt < own) own = f.rt;
    const lynx = state.lynx.get(bibKey(bib));
    if (own === null) return lynx ?? null;
    return lynx === undefined ? own : Math.min(own, lynx);
  }

  /** The runner's FinishLynx finish place (9.17 P4), or null when FinishLynx has not placed them (or no .lif). */
  #finishPlace(state, bib) {
    return state.lynxPlace.get(bibKey(bib)) ?? null;
  }

  /** Every race's column check, up to date (cheap when nothing changed). */
  #ensureChecks() {
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (state) this.#ensureCheck(race, state);
    }
  }

  #finished(state, bib) {
    const d = state.bibs.get(bib);
    return (d !== undefined && d.finishRt !== null) || (state.lynx.size > 0 && state.lynx.has(bibKey(bib)));
  }

  /**
   * Who FinishLynx has finished in this race. With `incremental` only the bibs that changed are worked out again.
   * @returns {boolean} whether anything changed
   */
  #refreshFinishers(race, state, incremental) {
    if (!this.#finishersFn) return false;
    let raw;
    try {
      raw = this.#finishersFn(race.id);
    } catch (err) {
      this.#log(`[engine] could not read the FinishLynx finishers of ${race.name}: ${err?.message ?? err}`);
      return false;
    }
    const map = new Map();
    const entries = raw instanceof Map ? raw.entries() : raw && typeof raw === 'object' ? Object.entries(raw) : [];
    for (const [b, t] of entries) {
      const k = bibKey(b);
      const v = finite(t);
      if (k && v !== null) map.set(k, v);
    }
    // the places too (9.17 P4): a made-up split of a finisher goes out with the finish place
    const places = new Map();
    if (this.#placesFn) {
      let rawPlaces = null;
      try {
        rawPlaces = this.#placesFn(race.id);
      } catch (err) {
        this.#log(`[engine] could not read the FinishLynx places of ${race.name}: ${err?.message ?? err}`);
      }
      const pe = rawPlaces instanceof Map ? rawPlaces.entries() : rawPlaces && typeof rawPlaces === 'object' ? Object.entries(rawPlaces) : [];
      for (const [b, p] of pe) {
        const k = bibKey(b);
        if (k && Number.isInteger(p) && p >= 1 && map.has(k)) places.set(k, p);
      }
    }
    const sig = [...map].map(([k, v]) => `${k}:${v}:${places.get(k) ?? ''}`).sort().join(',');
    if (sig === state.lynxSig) return false;
    const old = state.lynx;
    const oldPlaces = state.lynxPlace;
    state.lynx = map;
    state.lynxPlace = places;
    state.lynxSig = sig;
    // when the relay first saw each finisher in FinishLynx's file (the place rule, revision 10; after a restart: when
    // it read the file then, so a split that went out late just before the restart still counts)
    const seenAt = this.#clock.now();
    for (const k of map.keys()) if (!state.lynxSeenAt.has(k)) state.lynxSeenAt.set(k, seenAt);
    for (const k of [...state.lynxSeenAt.keys()]) if (!map.has(k)) state.lynxSeenAt.delete(k);
    for (const [k, p] of places) {
      if (oldPlaces.get(k) === p) continue;
      // what a finisher's made-up split goes out with
      const bib = state.bibKeys.get(k);
      const d = bib === undefined ? undefined : state.bibs.get(bib);
      for (const c of d?.kept ?? []) if (c?.manual) state.dirty.add(c.key);
    }
    this.#changed(state);
    this.#touched.add(race.id);
    if (incremental) {
      const changed = new Set();
      for (const [k, v] of map) if (old.get(k) !== v) changed.add(k);
      for (const k of old.keys()) if (!map.has(k)) changed.add(k);
      for (const k of changed) {
        const bib = state.bibKeys.get(k);
        if (bib !== undefined) this.#rederiveBib(race, state, bib);
      }
    }
    return true;
  }

  // ---- derivation (DESIGN 9.3) ------------------------------------------------------------------------------------
  //
  // Every runner of a race has a small state (newBibState) that is kept up to date read by read; a read's outcome is
  // kept on the read itself (rec.o, written by rec.od, the runner state that worked it out), so a meet's worth of
  // reads costs no table per runner. Changing a setting the derivation depends on rebuilds the race from scratch.

  /** What a race's derivation takes from the settings, read once per pass rather than once per read. */
  #ctx(race) {
    const { windowTicks, startTicks } = this.#filter();
    return { race, gun: race.gunTicks, windowTicks, startTicks };
  }

  /**
   * Steps 1-2 for one read: its outcome when it cannot count (an object with a `kind`), or `{ r, rt, split }` (split
   * null for a finish read) when it counts at a split or at the finish, or `{ r, rt, split: null, pass: true }` for a
   * read with no timing point name (a FinishLynx LapTime line): a pass, given its split by counting (9.15 L4).
   */
  #classify(ctx, r) {
    const { race, gun } = ctx;
    const pass = r.locKey === '';
    const split = pass ? undefined : race.sourceToSplit.get(r.locKey);
    const isFinish = !split && !pass && race.finishKeys.has(r.locKey);
    if (!split && !isFinish && !pass) return UNMAPPED;
    const splitId = split ? split.id : null;
    if (gun === null) return { kind: 'waiting-gun', splitId, finish: isFinish };
    const rt = raceTicks(r.tod, gun);
    // A finish read before the gun is a warm-up stride over the mat, not a finish.
    if (rt < 0) return { kind: 'before-gun', splitId, finish: isFinish, rt };
    // The start line runs over the finish mats (or a split mat) on many courses: a read seconds after the gun is a
    // runner leaving the start, not a split or a finish.
    if (rt < ctx.startTicks) return { kind: 'start-area', splitId, finish: isFinish, rt };
    if (pass) return { r, rt, split: null, pass: true };
    return { r, rt, split: split ?? null };
  }

  /**
   * DESIGN 9.15 L4, pass counting. A LapTime read says only "this bib crossed a mat at this time": which split it was
   * is counted. The runner's passes (sorted by time) are clustered with the tag window (the A and B mats of one split:
   * a read within the window of the cluster's first read joins it; the cluster's time is its earliest read), and the
   * clusters fill splits 1..N in time order. A split's `earliest` (a race time) keeps a missed mat from shifting every
   * later split: before a cluster takes the next split j, it skips ahead to the highest split k >= j whose earliest it
   * has reached; a cluster before split j's own earliest is 'too-early' (ignored, j stays). Clusters after split N are
   * 'extra' (never sent: laps to go would be 0, which means finished). The assigned reads join the split's group like
   * reads mapped by timing point, so the tag window, the finish and course order apply to them unchanged.
   *
   * DESIGN 9.17: the operator's decisions are fixed points of the count. A pass the operator moved is that split
   * (whatever counting or the earliest times say); a made-up time holds its split, so the passes after it count on
   * from the split after it, as they would have had the mat read the runner. Counting fills the columns between the
   * fixed points; a pass that finds no column left before the next fixed one is 'extra'. A made-up time gives way to a
   * real crossing of its split: a timing-point read of that split, or a pass that came in after the time was made up
   * (an RR12 read that came late) and belongs to that split's column (lateReplacements: it replaces at most the made-up
   * time next to it, never one across another made-up time or real pass). Passes that were there when the operator
   * made the time up were looked at then, so they never replace it.
   * @param {ReturnType<Engine['#ctx']>} ctx
   * @param {any} state
   * @param {ReturnType<typeof newBibState>} d
   * @param {string} bib
   * @param {{ r: any, rt: number }[]} passes the runner's counted passes
   */
  #assignPasses(ctx, state, d, bib, passes) {
    const race = ctx.race;
    const splits = race.splits;
    const n = splits.length;
    passes.sort(byRtSeq);
    const pins = this.#pins.get(race.id)?.get(bib);
    /** @type {any[]} the runner's passes, for the column check and the runner view */
    const clusters = [];
    for (let i = 0; i < passes.length;) {
      const t = passes[i].rt;
      let end = i + 1;
      while (end < passes.length && passes[end].rt - t <= ctx.windowTicks) end++;
      const c = { items: passes.slice(i, end), t, tod: passes[i].r.tod, col: null, how: '', pinCol: undefined, keep: false, hold: false,
        replaces: null, pin: null };
      if (pins) {
        for (const x of c.items) {
          const pin = pins.get(x.r.tod);
          if (!pin) continue;
          c.pin = pin;
          if (pin.as === 'keep') c.keep = true;
          else if (pin.as === 'move' || pin.as === 'hold') {
            const sp = race.splitById.get(pin.split);
            if (sp) {
              c.pinCol = sp.index;
              c.hold = pin.as === 'hold';
            } else c.pin = null; // its split was taken out of the race
          }
          break;
        }
      }
      clusters.push(c);
      i = end;
    }
    d.passInfo = clusters;
    // 9.23 F2: the operator's "This is the finish" and "Not a split" come first. The finish-marked pass is the runner's
    // finish, like a finish mat's read; a pass set aside takes no column, so the passes after it count on without it.
    let counted = clusters;
    if (pins) {
      const fin = clusters.find((c) => c.pin?.as === 'finish') ?? null;
      if (fin) {
        fin.how = 'finish';
        for (const x of fin.items) d.finishes.push({ r: x.r, rt: x.rt, split: null, marked: true });
      }
      counted = [];
      for (const c of clusters) {
        if (c === fin) continue;
        if (c.pin?.as === 'none' || c.pin?.as === 'finish') {
          c.how = 'ignored';
          for (const it of c.items) this.#setOut(state, d, it.r, { kind: 'ignored', splitId: null, rt: it.rt });
        } else counted.push(c);
      }
    }
    const mans = d.manualInfo ?? [];
    // a timing point that names the split: the real crossing
    for (const m of mans) if (m.state === 'active' && d.groups[m.k]?.length) m.state = 'replaced';
    // a pass that came in after a made-up time: the real read of that split, of another one, or neither (revision 10)
    lateReplacements(counted, mans, d.groups, splits, this.#finishOf(state, bib, d));
    const events = counted.map((c) => ({ t: c.t, c, m: null }));
    for (const m of mans) if (m.state === 'active') events.push({ t: m.rt, c: null, m });
    events.sort(byEventTime);
    for (const x of countClusters(events, splits)) {
      if (x.kind === 'conflict') x.m.state = 'conflict'; // a real pass already took its split or a later one
      else if (x.kind === 'place') this.#placeCluster(d, x.c, splits[x.col], x.how);
      else if (x.kind === 'extra') {
        for (const it of x.c.items) this.#setOut(state, d, it.r, { kind: 'extra', splitId: null, rt: it.rt, count: n, before: x.before });
        x.c.how = 'extra';
      } else {
        const sp = x.split;
        for (const it of x.c.items) this.#setOut(state, d, it.r, { kind: 'too-early', splitId: sp.id, rt: it.rt, earliest: sp.earliest });
        x.c.how = 'too-early';
      }
    }
    // 9.23 F7: a pass that counting put in another split because of the operator's decisions on the runner's other
    // passes (a Move of an earlier time with the later ones, Not a split, a marked finish) is 'shifted': the runner
    // editor says "Moved" for it too, not a plain read. Counted as before (the column check and the look-wrong check
    // take it as counted): only the words change. Where it would be is where the runner's passes alone put it, without
    // the operator's pins and made-up times: a time filled in after a Move (586's 3100m) holds the split the Move
    // emptied, so with it the later passes are where the Move put them, and they were still moved there.
    if (pins) {
      const placed = counted.filter((c) => (c.how === 'counted' || c.how === 'earliest') && !c.pin);
      if (placed.length) {
        const base = new Map();
        const ev = clusters.map((c) => ({ t: c.t, c: { t: c.t, pinCol: undefined, keep: false, hold: false, replaces: null, src: c }, m: null }));
        ev.sort(byEventTime);
        for (const x of countClusters(ev, splits)) if (x.kind === 'place') base.set(x.c.src, x.col);
        for (const c of placed) {
          if (base.get(c) === c.col) continue;
          c.how = 'shifted';
          d.colHow[c.col] = 'shifted';
        }
      }
    }
  }

  /** A pass given its split: its reads join the split's group, as reads of a timing point do. */
  #placeCluster(d, c, split, how) {
    const g = (d.groups[split.index] ??= []);
    for (const x of c.items) g.push({ r: x.r, rt: x.rt, split });
    c.col = split.index;
    c.how = how;
    (d.colHow ??= [])[split.index] = how;
  }

  /**
   * The runner's made-up times in this race (DESIGN 9.17 P3), as the count takes them: active, or not (no gun yet,
   * before the gun). A made-up time stands for a time of day, so a gun corrected later moves it with the real reads.
   * @returns {any[] | null}
   */
  #manualInfo(ctx, bib) {
    const bySplit = this.#manuals.get(ctx.race.id)?.get(bib);
    if (!bySplit) return null;
    const out = [];
    // 9.27: the chip whose reads count for this bib now (its own, or the other bib of its swapped pair)
    const chip = this.#swapBy.size ? this.#swapBy.get(bibKey(bib))?.other ?? bib : bib;
    for (const rec of bySplit.values()) {
      const sp = ctx.race.splitById.get(rec.splitId);
      if (!sp) continue; // its split was taken out of the race
      if (ctx.gun === null) {
        out.push({ rec, k: sp.index, rt: null, state: 'waiting-gun' });
        continue;
      }
      const rt = rec.tod !== null ? raceTicks(rec.tod, ctx.gun) : rec.raceTicks;
      // 9.27: a time made from the reads of another chip than the one that counts for the runner now is set aside while
      // those reads are another runner's (a swap entered or removed since); not one made for a runner that chip never
      // read in this race (a time typed for a runner no mat read stays the runner's)
      if (rec.chip !== chip && bibKey(rec.chip) !== bibKey(chip) && this.#chipRead(ctx.race.id, rec.chip)) {
        out.push({ rec, k: sp.index, rt, state: 'swapped' });
        continue;
      }
      out.push({ rec, k: sp.index, rt, state: rt > 0 ? 'active' : 'before-gun' });
    }
    return out.length ? out : null;
  }

  /** What a read of this race means now (null when the race has not worked it out: cleared, moved, no race). */
  #outcome(state, rec) {
    const d = state.bibs.get(rec.bib);
    return d !== undefined && rec.od === d ? rec.o : null;
  }

  /** A read's outcome, with the race's counts kept in step. */
  #setOut(state, d, r, o) {
    const old = r.od === d ? r.o : null;
    if (old !== null && COUNTED_SET.has(old.kind)) state.counts[old.kind]--;
    if (COUNTED_SET.has(o.kind)) state.counts[o.kind]++;
    r.o = o;
    r.od = d;
  }

  /** Step 4's input: the finish reads' outcomes (the earliest one is "the" finish) and the runner's finish time. */
  #finishOuts(state, d) {
    const f = d.finishes;
    // marked: a pass the operator marked as the finish in Review (9.23 F2)
    for (let i = 0; i < f.length; i++) this.#setOut(state, d, f[i].r, f[i].marked ? { kind: 'finish', rt: f[i].rt, first: i === 0, marked: true } : { kind: 'finish', rt: f[i].rt, first: i === 0 });
    d.finishRt = f.length ? f[0].rt : null;
  }

  /** Step 3: the crossing a split's sorted reads open; the reads within the tag window of the first one join it. */
  #openCrossing(ctx, bib, split, g) {
    const open = g[0];
    const c = { key: crossingKey(bib, split.id), bib, splitId: split.id, index: split.index, tod: open.r.tod, rt: open.rt,
      seq: open.r.seq, opener: open.r, reads: [], firstAt: Infinity, manual: null };
    for (const x of g) {
      // g is sorted by time, so the reads within the window are the first ones
      if (x !== open && x.rt - open.rt > ctx.windowTicks) break;
      c.reads.push(x.r);
      if (x.r.at < c.firstAt) c.firstAt = x.r.at;
    }
    return c;
  }

  /** What each read at one split means: the crossing's opener, a backup, a repeat, or why the split does not count. */
  #memberOuts(ctx, state, d, i) {
    const g = d.groups[i];
    const c = d.open[i];
    const drop = d.drop[i];
    const splitId = c.splitId;
    for (const x of g) {
      let o;
      if (drop) o = { ...drop, splitId, rt: x.rt };
      else if (x === g[0]) o = { kind: 'opener', splitId, rt: x.rt, key: c.key, openRt: c.rt };
      else o = { kind: x.rt - c.rt <= ctx.windowTicks ? 'backup' : 'repeat', splitId, rt: x.rt, key: c.key, openRt: c.rt };
      this.#setOut(state, d, x.r, o);
    }
  }

  /**
   * Step 4 for one runner: nothing counts at or after the finish; then splits must come in course order (walking over
   * the 1K mat after the 3K is not a 1K crossing). Sets d.drop, d.kept and d.keptCount.
   * @returns {number[]} the split indexes whose crossing started or stopped counting, or whose reason changed
   */
  #applyFilter(race, state, bib, d) {
    const lynx = state.lynx.get(bibKey(bib));
    const finish = d.finishRt === null ? lynx ?? null : lynx === undefined ? d.finishRt : Math.min(d.finishRt, lynx);
    const n = race.splits.length;
    const drop = new Array(n).fill(undefined);
    if (finish !== null) {
      for (let i = 0; i < n; i++) if (d.open[i] && d.open[i].rt >= finish) drop[i] = { kind: 'after-finish', finish };
    }
    let runMin = Infinity;
    let runIndex = -1;
    for (let i = n - 1; i >= 0; i--) {
      const c = d.open[i];
      if (!c || drop[i]) continue;
      if (c.rt >= runMin) drop[i] = { kind: 'out-of-order', byIndex: runIndex, byRt: runMin };
      else {
        runMin = c.rt;
        runIndex = i;
      }
    }
    const changed = [];
    const kept = new Array(n).fill(undefined);
    let keptCount = 0;
    for (let i = 0; i < n; i++) {
      if (!d.open[i]) continue;
      if (sameDrop(d.drop[i], drop[i])) drop[i] = d.drop[i];
      else changed.push(i);
      if (!drop[i]) {
        kept[i] = d.open[i];
        keptCount++;
      }
    }
    d.drop = drop;
    d.kept = kept;
    d.keptCount = keptCount;
    return changed;
  }

  /**
   * One runner's reads in one race -> the crossings that count and what each read means, from scratch. Pure apart
   * from writing each read's outcome: the same reads and settings always give the same answer, whatever order the
   * reads arrived in.
   */
  #deriveBib(race, state, bib, reads, ctx = this.#ctx(race)) {
    const d = newBibState(race.splits.length);
    let passes = null;
    for (const r of reads) {
      const o = this.#classify(ctx, r);
      if (o.kind !== undefined) this.#setOut(state, d, r, o);
      else if (o.pass) (passes ??= []).push(o);
      else if (o.split === null) d.finishes.push(o);
      else (d.groups[o.split.index] ??= []).push(o);
    }
    // the operator's made-up times (9.17 P3), fixed points of the count like the passes the operator moved
    d.manualInfo = this.#manualInfo(ctx, bib);
    // passes are given their splits first: they then count like reads mapped by timing point
    if (passes || d.manualInfo) this.#assignPasses(ctx, state, d, bib, passes ?? []);
    d.finishes.sort(byRtSeq);
    this.#finishOuts(state, d);
    for (let i = 0; i < d.groups.length; i++) {
      const g = d.groups[i];
      if (!g) continue;
      g.sort(byRtSeq);
      d.open[i] = this.#openCrossing(ctx, bib, race.splits[i], g);
    }
    if (d.manualInfo) {
      for (const m of d.manualInfo) {
        if (m.state !== 'active') continue;
        if (d.open[m.k]) m.state = 'replaced';
        else d.open[m.k] = manualCrossing(bib, race.splits[m.k], m, ctx.gun);
      }
    }
    this.#applyFilter(race, state, bib, d);
    if (d.manualInfo) {
      // a made-up time that the finish or course order rules out (a FinishLynx finish earlier than it, say)
      for (const m of d.manualInfo) if (m.state === 'active' && d.drop[m.k]) m.state = d.drop[m.k].kind;
    }
    for (let i = 0; i < d.groups.length; i++) if (d.groups[i]) this.#memberOuts(ctx, state, d, i);
    return d;
  }

  /**
   * A new read worked into its runner's derivation. Only what the read can change is worked out again: its split (or
   * the finish), then which of the runner's crossings count; places move only at the splits whose crossing changed.
   * The result is the same as #deriveBib on all the runner's reads (a test checks that on thousands of random reads).
   */
  #deriveRead(race, state, rec) {
    const bib = rec.bib;
    let d = state.bibs.get(bib);
    if (!d) state.bibs.set(bib, (d = newBibState(race.splits.length)));
    const ctx = this.#ctx(race);
    const o = this.#classify(ctx, rec);
    if (o.kind !== undefined) {
      // unmapped, waiting for the gun, before the gun, start area: it changes nothing else
      this.#setOut(state, d, rec, o);
      return;
    }
    if (o.pass || this.#hasFixes(race.id, bib)) {
      // A pass can move every later pass of the runner to another split (one that arrives late, after the runner's
      // next split): the runner is worked out again, which costs a handful of reads (9.15 L4). So is a runner with
      // the operator's Moves or made-up times (9.17): a real read can take a made-up time's place.
      this.#rederiveBib(race, state, bib);
      return;
    }
    this.#changed(state);
    d.checkRunner = null;
    const before = d.kept;
    const hadAny = d.keptCount > 0;
    let sync = [];
    let others = false;
    if (o.split === null) {
      const i = insertAt(d.finishes, o);
      d.finishes.splice(i, 0, o);
      const was = d.finishRt;
      this.#finishOuts(state, d);
      // An earlier finish read: the one that was first is now "already recorded"; and a runner who has just finished
      // gets nothing more live, which every row of theirs says.
      others = i === 0;
      if (d.finishRt !== was) {
        sync = this.#applyFilter(race, state, bib, d);
        for (const k of sync) this.#memberOuts(ctx, state, d, k);
      }
    } else {
      const { split } = o;
      const s = split.index;
      const g = (d.groups[s] ??= []);
      const i = insertAt(g, o);
      g.splice(i, 0, o);
      if (i === 0) {
        // the earliest read at this split: the crossing starts again from it
        d.open[s] = this.#openCrossing(ctx, bib, split, g);
        sync = this.#applyFilter(race, state, bib, d);
        if (!sync.includes(s)) sync.push(s);
        for (const k of sync) this.#memberOuts(ctx, state, d, k);
        others = g.length > 1 || sync.length > 1;
      } else {
        const c = d.open[s];
        const within = o.rt - c.rt <= ctx.windowTicks;
        if (within) {
          // the reads within the window are the first ones of g, so this read takes the same position among them
          c.reads.splice(i, 0, rec);
          if (rec.at < c.firstAt) c.firstAt = rec.at;
          if (d.kept[s] === c) state.dirty.add(c.key);
        }
        const drop = d.drop[s];
        this.#setOut(state, d, rec, drop ? { ...drop, splitId: split.id, rt: o.rt }
          : { kind: within ? 'backup' : 'repeat', splitId: split.id, rt: o.rt, key: c.key, openRt: c.rt });
      }
    }
    if (!sync.length) {
      if (others) state.feedBibs.add(bib);
      return;
    }
    for (const k of sync) {
      const was = before[k];
      const now = d.kept[k];
      if (was === now) continue;
      if (was) this.#unrank(state, was);
      if (now) this.#rank(state, now);
      // A crossing that no longer counts loses its release: if it comes back (the real crossing after a gun fix), it
      // waits out its own hold. What the outputs were given stays in their ledgers.
      if (was && !now) {
        state.rel.delete(was.key);
        state.approved.delete(was.key);
      }
    }
    state.runnerCount += (d.keptCount > 0 ? 1 : 0) - (hadAny ? 1 : 0);
    state.feedBibs.add(bib);
  }

  /** The race worked out again from all its reads (settings changed). */
  #rebuildRace(race, state) {
    state.bibs = new Map();
    state.kept = new Map();
    state.ranks = new Map(race.splits.map((s) => [s.id, []]));
    state.runnerCount = 0;
    state.counts = Object.fromEntries(COUNTED.map((k) => [k, 0]));
    const ctx = this.#ctx(race);
    const add = (bib, reads) => {
      const d = this.#deriveBib(race, state, bib, reads, ctx);
      state.bibs.set(bib, d);
      if (d.keptCount) state.runnerCount++;
      for (const c of d.kept) {
        if (!c) continue;
        state.kept.set(c.key, c);
        state.ranks.get(c.splitId).push(c);
      }
    };
    for (const [bib, reads] of state.reads) add(bib, reads);
    // a runner with made-up times only (a FinishLynx finisher no mat read, 9.17 P3)
    for (const bib of this.#manuals.get(race.id)?.keys() ?? []) {
      if (state.reads.has(bib)) continue;
      if (!state.bibKeys.has(bibKey(bib))) state.bibKeys.set(bibKey(bib), bib);
      add(bib, []);
    }
    for (const ranked of state.ranks.values()) ranked.sort(cmpCrossing);
    this.#changed(state);
    for (const key of [...state.rel.keys()]) if (!state.kept.has(key)) state.rel.delete(key);
    for (const key of [...state.approved.keys()]) if (!state.kept.has(key)) state.approved.delete(key);
    state.derivedSig = this.#derivSig(race);
    state.dirtyAll = true;
    state.dirty.clear();
    state.feedAllBibs = true;
    this.#touched.add(race.id);
  }

  /** One runner worked out again from scratch (FinishLynx finished them); only the crossings that moved change places. */
  #rederiveBib(race, state, bib) {
    const old = state.bibs.get(bib);
    const reads = state.reads.get(bib) ?? [];
    // what the old derivation counted goes, what the new one counts comes
    if (old) {
      for (const r of reads) if (r.od === old && r.o !== null && COUNTED_SET.has(r.o.kind)) state.counts[r.o.kind]--;
    }
    const d = this.#deriveBib(race, state, bib, reads);
    for (let i = 0; i < race.splits.length; i++) {
      const o = old?.kept[i];
      const n = d.kept[i];
      if (o && n && o.rt === n.rt && o.seq === n.seq) {
        // the same crossing: keep the object the places are ranked by
        o.reads = n.reads;
        o.firstAt = n.firstAt;
        o.tod = n.tod;
        o.opener = n.opener;
        o.manual = n.manual;
        d.kept[i] = o;
        d.open[i] = o;
        state.dirty.add(o.key);
        continue;
      }
      if (o) this.#unrank(state, o);
      if (n) this.#rank(state, n);
      if (o && !n) {
        state.rel.delete(o.key);
        state.approved.delete(o.key);
      }
    }
    state.runnerCount += (d.keptCount > 0 ? 1 : 0) - (old && old.keptCount > 0 ? 1 : 0);
    state.bibs.set(bib, d);
    state.feedBibs.add(bib);
    this.#changed(state);
  }

  /**
   * Something the race's crossings depend on changed: the column check (which looks at the whole field) is worked out
   * again before anything is sent or shown, and the Review list with it (9.17).
   */
  #changed(state) {
    state.checkDirty = true;
    state.version++;
  }

  // ---- the column check (DESIGN 9.17 P2) ---------------------------------------------------------------------------

  /** The race's column check, worked out again first if its crossings changed since. */
  #ensureCheck(race, state) {
    if (state.checkDirty || !state.check) {
      state.checkDirty = false;
      this.#recheck(race, state);
    }
    return state.check;
  }

  /**
   * The column check over the race's crossings (src/review.js columnCheck): which runners' counted passes clearly
   * belong to other columns. Their passes that would move are HELD: not sent, not in the merged .lif, and not counted
   * for the places of the others at that split, until the operator moves or keeps them. Whatever starts or stops being
   * held is delivered again (its own crossing, and the places behind it).
   */
  #recheck(race, state) {
    const n = race.splits.length;
    const old = state.check;
    // 9.25: the race's start list and who it puts elsewhere. `list`: null with no start list loaded at all; else what
    // this race has of them: its own list (entered, file), of the runners through (with a counted pass) how many are on
    // it, the bibs read here that are on another event's only (`elsewhere`: bib -> that event) and on none
    // (`unlisted`), and whether it is used: it has athletes, it is not from an earlier meet (`old`) and it fits the
    // runners being read (listFits: only runners with a pass count, a read in the start area says nothing). `away`: the
    // crossings of the runners who are not in this race: the operator said so, or a used list says they are entered in
    // another race and the setting keeps those off the boards. Kept like any crossing (read, counted, shown), held from
    // every output and the merged .lif, no part of the others' places. `apart`: the bibs that are no part of this
    // race's field: those, and with "send and flag" the ones the list puts elsewhere: no reference for anybody, and
    // neither the column check nor the pace check tells a story about them.
    const own = this.#lists.byEvent.get(race.event) ?? null;
    const says = this.#says.get(race.id);
    let list = null;
    if (this.#lists.byEvent.size) {
      const elsewhere = new Map();
      const unlisted = new Set();
      let on = 0;
      let through = 0;
      for (const [bib, d] of state.bibs) {
        const key = bibKey(bib);
        const mine = own?.bibs.has(key) === true;
        if (!mine && this.#lists.eventsOf.has(key)) elsewhere.set(bib, this.#lists.eventsOf.get(key)[0]);
        else if (!mine) unlisted.add(bib);
        if (!d.keptCount) continue;
        through++;
        if (mine) on++;
      }
      const stale = !!own && this.#clock.now() - own.loadedAt > LIST_RULES.days * 86400000;
      list = { event: race.event, file: own?.file ?? null, loadedAt: own?.loadedAt ?? null, entered: own?.bibs.size ?? 0, on, through, elsewhere, unlisted,
        old: stale, used: !!own && own.bibs.size > 0 && !stale && listFits(on, through) };
    }
    /** crossing key -> bib */
    const away = new Map();
    const apart = new Set();
    const setApart = (bib, keepOff) => {
      const d = state.bibs.get(bib);
      if (!d?.keptCount) return;
      apart.add(bib);
      if (keepOff) for (const c of d.kept) if (c) away.set(c.key, bib);
    };
    for (const [bib, say] of says ?? []) if (say === 'away') setApart(bib, true);
    if (list?.used) for (const bib of list.elsewhere.keys()) if (!says?.has(bib)) setApart(bib, this.#keepOff);
    const runners = [];
    // only counted passes (reads with no timing point name) can be in the wrong column
    if (race.gunTicks !== null && n > 1 && (state.locations.get('')?.count ?? 0) > 0) {
      for (const [bib, d] of state.bibs) if (d.keptCount && !apart.has(bib)) runners.push((d.checkRunner ??= this.#checkRunnerOf(state, bib, d, n)));
    }
    // Only a runner of counted passes with a split still empty can be suspect: a race of timing points (or one where
    // everybody has every split) needs no field references at all, which keeps a read cheap in a big race. 9.23 F13: or
    // one whose last column's pass counting put there, which may be its finish pass (columnCheck, when the stream
    // carries finish passes: a runner it held stays held when the finish pass fills the last column)
    const any = runners.some((r) => {
      const last = r.passes[r.passes.length - 1];
      return !r.located && r.passes.some((p) => !p.pinned) && (r.passes.length < n || (!last.pinned && last.col === n - 1));
    });
    const res = any ? columnCheck({ n, runners, earliest: race.splits.map((sp) => sp.earliest), near: FINISH_NEAR_TICKS }) : null;
    // (a move to column n: the finish pass, that moves on with the pass before it)
    const names = [...race.splits.map((sp) => sp.name), 'the finish'];
    /** crossing key -> { bib, move, text, from, to } (to: null for the finish) */
    const held = new Map();
    const heldBySplit = new Map();
    for (const sus of res?.suspects.values() ?? []) {
      const d = state.bibs.get(sus.bib);
      for (const mv of sus.moves) {
        const c = d?.kept[mv.from];
        if (!c) continue;
        held.set(c.key, { bib: sus.bib, move: mv, text: moveText(mv, names), from: race.splits[mv.from].id, to: mv.to < n ? race.splits[mv.to].id : null,
          method: sus.method, lone: sus.lone === true });
        let keys = heldBySplit.get(c.splitId);
        if (!keys) heldBySplit.set(c.splitId, (keys = []));
        keys.push(c.key);
      }
    }
    // 9.24: a runner the operator stopped sending: its crossings from then on stay off the outputs and out of the .lif
    /** crossing key -> bib */
    const off = new Map();
    const offs = race.gunTicks !== null ? this.#offs.get(race.id) : null;
    for (const [bib, o] of offs ?? []) {
      const from = raceTicks(o.from, race.gunTicks);
      for (const c of state.bibs.get(bib)?.kept ?? []) if (c && c.rt >= from) off.set(c.key, bib);
    }
    // 9.24: the pace check (src/review.js fastLegsOf), worked out here, as each read comes in: a runner's splits that
    // are too fast to be real are MARKED from that moment (Review's Splits that look wrong, the Dashboard, the grid),
    // never held: their lines go out as any other, and the operator takes them back or stops sending the runner. Not for a
    // runner the column check holds a pass of (its question comes first: a missed mat makes legs of other stretches) or
    // one with a timing point's read (its splits are known); not a stopped runner's split, nor a made-up time.
    /** bib -> { legs: (FastLeg & { after: number|null })[], text }: the runner's splits in question, in course order */
    const fastOf = new Map();
    const pace = runners.length > FAST_RULES.minRefs ? fastField({ n, runners }) : null;
    const marked = (c) => !!c && !c.manual && !off.has(c.key);
    for (const r of pace ? runners : []) {
      if (r.located || res?.suspects.has(r.bib)) continue;
      const d = state.bibs.get(r.bib);
      const legs = fastLegsOf(pace, r).filter((x) => marked(d?.kept[x.col]));
      if (legs.length) fastOf.set(r.bib, { legs: legs.map((x) => ({ ...x, after: null })), text: '' });
    }
    // ... and, once the operator has set a too-fast pass aside (Not a split), the runner's next pass, which takes its
    // split: one that fits the runner's own pace is its split; one that comes slow for the runner (FAST_RULES.afterAbove;
    // not as slow as a missed mat makes a leg: that is the missed-mat fixes') is marked too. The dropped-out runner's
    // second read, 4:31.6 after her last real split, is her "4.4K" the moment the first is set aside.
    for (const [bib, pins] of pace ? this.#pins.get(race.id) ?? [] : []) {
      let none = false;
      for (const p of pins.values()) if (p.as === 'none') none = true;
      const d = none ? state.bibs.get(bib) : null;
      const r = d?.checkRunner;
      if (!r || r.located || res?.suspects.has(bib) || fastOf.has(bib)) continue;
      for (const x of d.passInfo ?? []) {
        if (x.how !== 'ignored') continue;
        let a = -1;
        for (let k = 0; k < n; k++) if (r.real[k] !== null && r.real[k] < x.t) a = k;
        const b = a + 1;
        const c = a >= 0 && b < n ? d.kept[b] : null;
        if (!marked(c) || !(c.rt > x.t) || r.passes.some((p) => p.col === b && p.pinned)) continue;
        const p = paceAt(pace, r, b);
        if (!p || p.own === null || !p.steady) continue;
        const was = (x.t - r.real[a]) / p.lead;
        const ratio = (c.rt - r.real[a]) / p.lead;
        if (!(was < FAST_RULES.below && was < FAST_RULES.ownBelow * p.own) || !(ratio > FAST_RULES.afterAbove * p.own && ratio <= FAST_RULES.steady * p.own)) continue;
        fastOf.set(bib, { legs: [{ col: b, from: a, t: c.rt, leg: c.rt - r.real[a], lead: p.lead, ratio, own: p.own, refs: 0, after: x.t }], text: '' });
        break;
      }
    }
    for (const k of new Set([...off.keys(), ...away.keys()])) {
      if (held.has(k)) continue;
      const splitId = state.kept.get(k)?.splitId;
      let keys = heldBySplit.get(splitId);
      if (!keys) heldBySplit.set(splitId, (keys = []));
      keys.push(k);
    }
    // (9.23 F18: `late`, the runners the check spared as late starters: their legs fit the course as counted; `field`,
    // what it judged them against, for a change's preview: #previewHeld. 9.23 F20: `slow`, the runners it spared for one
    // slow leg, every mat read)
    state.check = { suspects: res?.suspects ?? new Map(), held, heldBySplit, late: res?.late ?? new Map(), slow: res?.slow ?? new Map(), field: res?.field ?? undefined,
      fastOf, off, away, apart, list };
    // (9.25: said once in the log when a start list stops fitting its race, and when it fits again)
    if (old?.list && list && list.entered > 0 && !list.old && old.list.used !== list.used && old.list.file === list.file) {
      this.#log(`[engine] ${race.name}: ${list.used ? `the start list fits again (${list.on} of ${list.through} runners are on it): used` : listMisfitText(race.name, list)}`);
      this.#touched.add(race.id);
    }
    // (the mark's words, with the runner's place at the split before as the boards have it; said once in the log, when
    // the read that made it comes in; the runner's feed rows say it too)
    for (const [bib, f] of fastOf) {
      const prev = state.bibs.get(bib)?.kept[f.legs[0].from];
      f.text = fastText(f.legs, { bib, place: prev ? this.#place(state, prev) : null, names });
      const was = old?.fastOf?.get(bib);
      if (was && was.legs.length === f.legs.length && was.legs.every((x, i) => x.col === f.legs[i].col && x.t === f.legs[i].t)) continue;
      state.feedBibs.add(bib);
      this.#touched.add(race.id);
      if (old) this.#log(`[engine] ${race.name}: ${f.text} Marked (Splits that look wrong); it went out as any split.`);
    }
    for (const bib of old?.fastOf?.keys() ?? []) {
      if (fastOf.has(bib)) continue;
      state.feedBibs.add(bib);
      this.#touched.add(race.id);
    }
    const changed = [];
    for (const [k, h] of held) {
      if (old?.held.get(k)?.text !== h.text) changed.push(k);
      state.letGo.delete(k);
    }
    for (const k of old?.held.keys() ?? []) {
      if (held.has(k)) continue;
      changed.push(k);
      // 9.23 F21: what the check let go (its tod: the crossing it held, not one that took the cell since)
      const c = state.kept.get(k);
      if (c && !c.manual) state.letGo.set(k, c.tod);
    }
    // (9.24: a runner stopped or sent again)
    for (const k of off.keys()) {
      if (!old?.off?.has(k)) changed.push(k);
      state.letGo.delete(k);
    }
    for (const k of old?.off?.keys() ?? []) if (!off.has(k)) changed.push(k);
    // (9.25: a runner who is not in this race, or is after all)
    for (const k of away.keys()) {
      if (!old?.away?.has(k)) changed.push(k);
      state.letGo.delete(k);
    }
    for (const k of old?.away?.keys() ?? []) if (!away.has(k)) changed.push(k);
    for (const k of changed) {
      state.dirty.add(k);
      state.feedBibs.add(bibOfKey(k));
      const c = state.kept.get(k);
      if (!c) continue;
      // the places behind it at that split move by one
      const ranked = state.ranks.get(c.splitId) ?? [];
      for (let x = Math.max(0, this.#index(state, c)); x < ranked.length; x++) {
        state.dirty.add(ranked[x].key);
        state.feedBibs.add(ranked[x].bib);
      }
    }
    if (changed.length) this.#touched.add(race.id);
  }

  /**
   * 9.23 F18: what the column check judges runners against (src/review.js checkField), as it was made for the race's
   * crossings now: #recheck's, or made here when nobody was a candidate then (a change can make one). Null for a race the
   * check does not look at (no gun, one split, no counted passes).
   */
  #checkFieldOf(race, state) {
    const chk = this.#ensureCheck(race, state);
    if (chk.field !== undefined) return chk.field;
    const n = race.splits.length;
    const runners = [];
    if (race.gunTicks !== null && n > 1 && (state.locations.get('')?.count ?? 0) > 0) {
      for (const [bib, d] of state.bibs) if (d.keptCount && !chk.apart.has(bib)) runners.push((d.checkRunner ??= this.#checkRunnerOf(state, bib, d, n)));
    }
    chk.field = runners.length ? checkField({ n, runners, earliest: race.splits.map((sp) => sp.earliest), near: FINISH_NEAR_TICKS }) : null;
    return chk.field;
  }

  /**
   * 9.23 F18: which of a runner's passes the column check would hold after a change, for the change's preview ("21:46.1 →
   * 5300m (held: it looks like the finish)"): the runner as the change would leave it (`where`: each pass's place as
   * previewPlaces gives it; `pins`: the passes the change pins; `mans`: the made-up and typed times it keeps or makes)
   * judged by the check's own rules (src/review.js checkOne) against the field as it is. The re-check of 2026-10-30
   * found a Move's preview, "15:56.6 → 4400m, 21:46.1 → 5300m", and a one click's, "22:28.7 → 4400m, 28:02.4 → 5300m",
   * that said nothing of the passes the check then held (the first sent the finish read as 5300m: no longer).
   * @param {Map<any, any>} where cluster -> column (or 'extra', 'after-finish', …)
   * @param {Set<any>} pins clusters the change pins (a Move, each run's pass of "Missed …: add it")
   * @param {{ k: number, rt: number }[]} mans the made-up and typed times the runner has after the change
   * @param {number|null} [finish] the runner's finish after the change (a marked finish that moves on is none)
   * @returns {Map<any, string>} cluster -> the words of where the check would put it ("it looks like the finish")
   */
  #previewHeld(race, state, bib, d, where, pins, mans, finish = this.#finishOf(state, bib, d)) {
    const out = new Map();
    const field = this.#checkFieldOf(race, state);
    // (9.25: nor a story about a runner who is not in this race)
    if (!field || d.checkRunner?.located || state.check?.apart?.has(bib)) return out;
    const n = race.splits.length;
    const passes = [];
    const real = new Array(n).fill(null);
    const at = new Map();
    for (const x of d.passInfo ?? []) {
      const c = where.get(x);
      if (typeof c !== 'number') continue;
      const pinned = pins.has(x) || !!x.replaces || ['move', 'hold', 'keep'].includes(x.pin?.as);
      passes.push({ t: x.t, col: c, pinned });
      real[c] = x.t;
      at.set(c, x);
    }
    for (const m of mans) passes.push({ t: m.rt, col: m.k, manual: true, pinned: true });
    passes.sort((a, b) => a.col - b.col);
    const lastReal = real[n - 1];
    const after = lastReal === null ? null : (d.passInfo ?? []).find((x) => x.t > lastReal && where.get(x) !== 'ignored' && x.how !== 'ignored') ?? null;
    const got = checkOne(field, { bib, passes, real, located: false, finish, afterLast: after ? after.t : null });
    for (const mv of got?.suspect?.moves ?? []) {
      const x = at.get(mv.from);
      if (x) out.set(x, `it looks like ${mv.to < n ? race.splits[mv.to].name : 'the finish'}`);
    }
    return out;
  }

  /** One runner as src/review.js columnCheck takes it: its kept crossings, which of them are fixed, its finish. */
  #checkRunnerOf(state, bib, d, n) {
    const real = new Array(n).fill(null);
    const passes = [];
    let located = false;
    for (let k = 0; k < n; k++) {
      const c = d.kept[k];
      if (!c) continue;
      if (c.manual) {
        passes.push({ t: c.rt, col: k, manual: true, pinned: true });
        continue;
      }
      real[k] = c.rt;
      // a read of a named timing point says which split it is: the runner's columns are known
      if (c.reads.some((r) => r.locKey !== '')) {
        located = true;
        continue;
      }
      const how = d.colHow?.[k];
      passes.push({ t: c.rt, col: k, pinned: how === 'moved' || how === 'kept' || how === 'replaces' || how === 'hold' });
    }
    // 9.23 F13: the runner's first pass after its last split (columnCheck's test of finish passes in the stream)
    const afterLast = real[n - 1] === null ? null : (d.passInfo ?? []).find((cl) => cl.t > real[n - 1] && cl.how !== 'ignored')?.t ?? null;
    return { bib, passes, real, located, finish: this.#finishOf(state, bib, d), afterLast };
  }

  /**
   * 9.23 F21: whether a finisher's real crossing goes out by itself with the finish place: the column check held it (its
   * own question, so it never went out live), let it go once the runner's finish was known (a slow last leg's 5300m
   * pass, held as "it looks like the finish" until FinishLynx's finish showed the finish later), the finish place is
   * known and no output has another time or column of it (a copy sent before it was held waits for Send with finish
   * place, as before). Not for a runner whose change is being sent: the operator said how it goes (#sendFixed). Only a
   * runner with every split read and no pass that may be a stray (#straysOf): a count made complete by a stray pass is
   * let go as well once the finish is known (3100m missed and a read 30 s after the 4200m pass: the real 4200m pass in
   * 3100m and the stray in 4200m went out by themselves before the one click, 23 of 80 on my stray grid).
   */
  #letGoOf(race, state, c) {
    const fp = this.#finishPlace(state, c.bib);
    if (c.manual || state.letGo.get(c.key) !== c.tod || fp === null || this.#fixing?.bibs.has(c.bib)) return false;
    const d = state.bibs.get(c.bib);
    if (!d || race.splits.some((_, k) => !d.kept[k]) || this.#straysOf(race, state, c.bib, d).length) return false;
    const cell = cellOf(this.#content(race, c, 0));
    for (const o of this.#outputs) {
      // (an output that has it with the finish place already took it so: one that was down gets it when it is back;
      // one let go on the course went out live with its split place, before the finish)
      const e = this.#latestFlight(state, o.id, c.key) ?? state.ledgers.get(o.id)?.get(c.key);
      if (e && (cellOf(e) !== cell || e.place !== fp)) return false;
    }
    return true;
  }

  /**
   * Why a kept crossing is not sent (DESIGN 9.17): 'paused' (its split is paused), 'check' (its column is in doubt),
   * 'stopped' (9.24: the operator stopped sending this runner), 'away' (9.25: the runner is not in this race),
   * 'collect' (9.26: its split is counted but not sent, for good: it never waits, and no decision lets it go). Said
   * last: a pass in a split that is not sent whose column is in doubt still has that question open (the one click that
   * moves the runner's later passes on); once it is answered the pass is simply not sent.
   */
  #holdOf(race, state, c) {
    if (state.check?.away?.has(c.key)) return 'away';
    if (state.check?.off?.has(c.key)) return 'stopped';
    if (race.splits[c.index]?.sending === false) return 'paused';
    if (state.check?.held.has(c.key)) return 'check';
    if (race.splits[c.index]?.collectOnly === true) return 'collect';
    return null;
  }

  /**
   * 9.26: the laps to go a crossing is sent with: the sent splits from its split to the end (compileConfig). Null for a
   * split that is counted but not sent, or for a crossing whose split is not in the race as it is now.
   */
  #l2gOf(race, c) {
    return race.splits[c.index]?.l2g ?? null;
  }

  /** 9.26: whether a crossing is of a split that is counted but not sent (whatever else holds it). */
  #notSent(race, c) {
    return race.splits[c.index]?.collectOnly === true;
  }

  /**
   * A crossing's place at its split: its rank among the kept crossings there, not counting the ones held for a column
   * check before it (a pass that is probably another split's must not push the runners behind it down a place).
   */
  #place(state, c) {
    const i = this.#index(state, c);
    const keys = state.check?.heldBySplit.get(c.splitId);
    if (!keys?.length) return i + 1;
    let before = 0;
    for (const k of keys) {
      const h = state.kept.get(k);
      if (h && h !== c && cmpCrossing(h, c) < 0) before++;
    }
    return i + 1 - before;
  }

  #rank(state, c) {
    let ranked = state.ranks.get(c.splitId);
    if (!ranked) state.ranks.set(c.splitId, (ranked = []));
    const i = lowerBound(ranked, c);
    ranked.splice(i, 0, c);
    state.kept.set(c.key, c);
    // Everyone behind moved down a place.
    for (let j = i; j < ranked.length; j++) {
      state.dirty.add(ranked[j].key);
      state.feedBibs.add(ranked[j].bib);
    }
  }

  #unrank(state, c) {
    const ranked = state.ranks.get(c.splitId) ?? [];
    const i = this.#index(state, c);
    if (i >= 0) ranked.splice(i, 1);
    if (state.kept.get(c.key) === c) state.kept.delete(c.key);
    state.dirty.add(c.key);
    for (let j = Math.max(0, i); j < ranked.length; j++) {
      state.dirty.add(ranked[j].key);
      state.feedBibs.add(ranked[j].bib);
    }
  }

  #index(state, c) {
    const ranked = state.ranks.get(c.splitId);
    if (!ranked) return -1;
    const i = lowerBound(ranked, c);
    return ranked[i] === c ? i : -1;
  }

  /** After a restart (or a rebuild), a crossing an output already has counts as released. */
  #restoreReleases(state) {
    for (const c of state.kept.values()) {
      if (state.rel.has(c.key)) continue;
      let best = null;
      for (const ledger of state.ledgers.values()) {
        const e = ledger.get(c.key);
        if (e && (!best || e.firstAt < best.firstAt)) best = e;
      }
      if (best) state.rel.set(c.key, { at: best.firstAt, tod: best.tod, reason: 'new', live: { reason: 'new', tod: best.tod, place: best.place } });
    }
  }

  // ---- delivery (DESIGN 9.4) --------------------------------------------------------------------------------------

  #content(race, c, place) {
    const gun = race.gunTicks;
    // 9.26: the split count and laps to go the outputs go by are those of the splits that are sent
    const count = race.sentCount;
    const l2g = this.#l2gOf(race, c);
    return { sig: `${c.tod}|${place}|${gun}|${l2g}|${count}`, tod: c.tod, place, gun, l2g, count };
  }

  #converge(now) {
    // the column check first, for every race: what is held decides what goes out, and the places of the others
    this.#ensureChecks();
    if (!this.#delivering) return;
    const { holdMs } = this.#filter();
    for (const race of this.#races) {
      const state = this.#states.get(race.id);
      if (!state) continue;
      if (!race.active || race.gunTicks === null) {
        // Nothing is sent live for it; it is looked at again in full when it becomes active or gets a gun.
        state.unreleased.clear();
        state.dirty.clear();
        state.dirtyAll = false;
        continue;
      }
      this.#convergeRace(race, state, now, holdMs);
    }
  }

  #convergeRace(race, state, now, holdMs) {
    this.#repairFinishPlaces(race, state, now);
    let cands;
    // a rebuild (a setting changed: the gun, an earliest time, the splits; a start) looks at everything again; what it
    // changes after the cells' minute waits for Resend, as before (9.23 F13 below is for what reads change)
    const rebuilt = state.dirtyAll;
    if (state.dirtyAll) {
      cands = [];
      for (const split of race.splits) for (const c of state.ranks.get(split.id) ?? []) cands.push(c);
      state.unreleased.clear();
    } else {
      if (!state.dirty.size && !state.unreleased.size) return;
      cands = [];
      for (const k of state.dirty) {
        const c = state.kept.get(k);
        if (c) cands.push(c);
      }
      for (const k of state.unreleased) {
        const c = state.kept.get(k);
        if (!c) state.unreleased.delete(k);
        else if (!state.dirty.has(k)) cands.push(c);
      }
      cands.sort((a, b) => a.index - b.index || a.rt - b.rt || a.seq - b.seq);
    }
    state.dirtyAll = false;
    state.dirty = new Set();
    const ready = [];
    /** 9.23 F21: a finisher's crossings the column check let go, that go with the finish place */
    const letGo = new Set();
    for (const c of cands) {
      // Paused split, or a column in doubt (9.17 P1, P2): kept and shown, never sent until it is let go.
      if (this.#holdOf(race, state, c)) {
        state.unreleased.delete(c.key);
        continue;
      }
      // A finished runner's place in TrackScore is FinishLynx's: no split packet may overwrite it. A made-up split the
      // operator sent for a finisher goes out with the finish place itself, so TrackScore keeps it (9.17 P4). 9.23 F18:
      // one that a change being sent made goes from #sendFixed, in course order with the real splits the change moved
      // (convergence sent the made-up ones first and the furthest split twice: "3100m | 5300m | 4200m | 4400m | 5300m").
      // 9.23 F21: so does a real one the column check held and let go once the runner had finished (#letGoOf)
      if (this.#finished(state, c.bib)) {
        if (this.#letGoOf(race, state, c)) letGo.add(c.key);
        else if (!(c.manual && this.#finishPlace(state, c.bib) !== null) || this.#fixing?.keys.has(c.key)) {
          state.unreleased.delete(c.key);
          continue;
        }
      }
      // The hold runs on the wall clock from the first arrival; a clock that went backwards releases it at once. A
      // made-up time has no backup read to wait for: the operator sent it.
      if (!c.manual && !state.rel.has(c.key) && now >= c.firstAt && now - c.firstAt < holdMs) {
        state.unreleased.add(c.key);
        continue;
      }
      state.unreleased.delete(c.key);
      ready.push(c);
    }
    if (!ready.length) return;
    // An update behind a crossing still in its hold waits for it, so the new crossing goes out first and the places
    // behind it are sent once, final.
    const heldMin = new Map();
    for (const k of state.unreleased) {
      const c = state.kept.get(k);
      if (!c) continue;
      const i = this.#index(state, c);
      const m = heldMin.get(c.splitId);
      if (m === undefined || i < m) heldMin.set(c.splitId, i);
    }
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    /** 9.23 F4: what went out in this pass */
    const sent = [];
    for (const c of ready) {
      const idx = this.#index(state, c);
      const byFinish = (c.manual !== null || letGo.has(c.key)) && this.#finished(state, c.bib);
      const place = byFinish ? this.#finishPlace(state, c.bib) : this.#place(state, c);
      if (!state.rel.has(c.key)) {
        state.rel.set(c.key, { at: now, tod: c.tod, reason: 'new', live: { reason: 'new', tod: c.tod, place } });
        this.#touched.add(race.id);
        state.feedBibs.add(c.bib); // its row goes from Holding to Sent
      }
      const held = heldMin.get(c.splitId);
      const defer = held !== undefined && held < idx;
      const content = this.#content(race, c, place);
      const approved = this.#approvalOf(state, c.key, content);
      for (const o of outs) {
        const led = state.ledgers.get(o.id)?.get(c.key);
        const base = this.#latestFlight(state, o.id, c.key) ?? led;
        if (base && base.sig === content.sig) continue;
        // Too late to change what the scoreboard shows: it is out of date (stale) until the operator resends. Not what
        // the operator approved in Review (9.23 F4): that goes out whenever an output can take it; and a cell the
        // operator put a time in has its minute from then (a real read replacing a made-up time just sent). 9.23 F13:
        // nor a cell that a READ gave another time (a late read of a split the mats missed moves the runner's later
        // passes on a column; a real read replaces a made-up time a minute after the fill): the boards get the
        // runner's splits in their right columns, with their laps to go, by themselves, and the runner's furthest
        // split goes last (below). A place alone (another runner's read moved it) keeps the minute: an old split's
        // place would become the runner's place on TrackScore. So does what a setting changed (a rebuild: Resend).
        if (led && now - this.#windowFrom(state, o.id, c.key, led) >= RESEND_WINDOW_MS && !approved && (rebuilt || !retimedByRead(led, content))) continue;
        if (base && defer) {
          state.dirty.add(c.key);
          continue;
        }
        const reason = !led ? 'new'
          : led.tod !== content.tod || led.gun !== content.gun || led.l2g !== content.l2g || led.count !== content.count ? 'correction' : 'place-update';
        // a time the operator's change being sent put in the cell, handed over here inside the cell's minute: the
        // operator's too (its minute starts again now, as for one #sendFixed sends)
        const mine = !!this.#fixing?.keys.has(c.key);
        if (!this.#send(race, state, o, c, place, reason, content, { byFinish, fixed: approved || mine })) continue;
        // (a new time for the cell on this output, or its first one, so the runner's next split there, when it went
        // out already, has another leg: 9.23 F13, a split played after a pause or a read that came late)
        sent.push({ outputId: o.id, key: c.key, bib: c.bib, retimed: !base || base.tod !== content.tod });
      }
    }
    // 9.23 F12: the lap split (LS) of the runner's next split is measured from this one: an output given a new time
    // for a split gets the next split again where it has it as it is now (only the leg differs; TrackScore does not
    // read it, Karmarush shows it), unless it went in this pass. A real read that replaces a made-up time, say.
    for (const x of sent.slice()) {
      if (!x.retimed || this.#finished(state, x.bib)) continue;
      const c = state.kept.get(x.key);
      const mine = state.bibs.get(x.bib)?.kept ?? [];
      let next = null;
      for (let i = (c?.index ?? Infinity) + 1; i < mine.length && !next; i++) if (mine[i] && !this.#holdOf(race, state, mine[i])) next = mine[i];
      if (!next || !state.rel.has(next.key) || sent.some((y) => y.outputId === x.outputId && y.key === next.key)) continue;
      const o = outs.find((y) => y.id === x.outputId);
      const place = this.#place(state, next);
      const content = this.#content(race, next, place);
      const base = this.#latestFlight(state, o.id, next.key) ?? state.ledgers.get(o.id)?.get(next.key);
      if (!base || base.sig !== content.sig) continue;
      if (this.#send(race, state, o, next, place, 'place-update', content, {})) sent.push({ outputId: o.id, key: next.key, bib: next.bib, retimed: false });
    }
    // 9.23 F4: TrackScore takes the runner's place from the newest packet, so after a packet for an earlier split the
    // runner's furthest split goes again, last. 9.23 F13: for what the relay sends by itself too (a place update of an
    // earlier split within its minute, reads that came out of order, a late read that moved the runner's passes on):
    // before, a runner could end with an earlier split's place on TrackScore (81 of 177 in the 20x replay). A runner
    // whose newest packet is its furthest split already gets nothing more. A change being sent does that itself, after
    // what it sends (#sendFixed).
    const lastOf = new Map();
    for (const x of sent) {
      let last = lastOf.get(x.bib);
      if (!last) lastOf.set(x.bib, (last = new Map()));
      last.set(x.outputId, x.key);
    }
    for (const [bib, last] of lastOf) {
      if (this.#fixing?.bibs.has(bib)) continue;
      // (9.23 F14: a finisher's made-up split, sent with the finish place, is followed by its furthest split the same way)
      if (this.#finished(state, bib)) this.#sendFurthestFinished(race, state, bib, last);
      else this.#sendFurthest(race, state, bib, last, false);
    }
  }

  /**
   * 9.23 F4: whether the operator approved this content of a crossing (state.approved), so it goes out whatever the
   * minute says. An approval made while the crossing was held (a paused split, a column in doubt, its own hold) is for
   * its time and column: it takes the place the crossing has once it is let go. Any other change ends an approval:
   * it is for what the operator saw.
   */
  #approvalOf(state, key, content) {
    const ap = state.approved.get(key);
    if (!ap) return false;
    if (ap.sig === content.sig) return true;
    if (ap.sig === null && ap.cell === cellOf(content)) {
      state.approved.set(key, { sig: content.sig, cell: ap.cell });
      return true;
    }
    state.approved.delete(key);
    return false;
  }

  /**
   * Hand one packet to one output. `fixed`: it carries a time the operator put in this cell (9.23 F4), so the cell's
   * minute starts again when it lands (#windowFrom).
   * @returns {boolean} whether the output took it
   */
  #send(race, state, o, c, place, reason, content, { allowFinished = false, allowInactive = false, byFinish = false, fixed = false } = {}) {
    const packet = this.#packet(race, state, c, place, reason, content.sig, allowFinished, allowInactive, byFinish);
    // (what this output has of the crossing now: a line that goes out again with another time or place has `moved`)
    const prior = this.#capture ? this.#latestFlight(state, o.id, c.key) ?? state.ledgers.get(o.id)?.get(c.key) : null;
    const flight = { n: ++this.#flightSeq, ...content, reason, ls: packet.lsTicks };
    if (fixed) flight.fixedAt = this.#clock.now();
    let byKey = state.flights.get(o.id);
    if (!byKey) state.flights.set(o.id, (byKey = new Map()));
    let flights = byKey.get(c.key);
    if (!flights) byKey.set(c.key, (flights = []));
    flights.push(flight);
    const epoch = state.epoch;
    let accepted = false;
    try {
      accepted = this.#deliverFn(o.id, packet, (ok) => this.#ack(race.id, state, epoch, o.id, c.key, flight, ok === true)) !== false;
    } catch (err) {
      this.#log(`[engine] handing bib ${c.bib} to ${o.name} failed: ${err?.stack ?? err}`);
    }
    // the feed row says "Sent" only once an output took it, "Ready — no output took it" until then (9.16 F3)
    state.feedBibs.add(c.bib);
    state.deliveryRev++;
    if (!accepted) {
      this.#dropFlight(state, o.id, c.key, flight);
      this.#failedSet(state, o.id).add(c.key);
      return false;
    }
    const rel = state.rel.get(c.key);
    if (rel) {
      rel.reason = reason;
      if (reason === 'correction' || reason === 'place-update') {
        rel.live = { reason, tod: c.tod, place };
        state.feedBibs.add(c.bib);
      }
    }
    // a Review action notes what it handed over (9.23 F4: the runner's furthest split goes last)
    this.#capture?.push({ outputId: o.id, key: c.key, bib: c.bib, moved: !!prior && prior.sig !== content.sig });
    this.#emitSafe('send', packet, o.id);
    return true;
  }

  /**
   * @param {boolean} byFinish the packet carries the runner's FinishLynx finish place (9.17 P4: a finisher's made-up
   *   split, or the operator's "Send with finish place"), not the place at the split
   */
  /** A crossing's leg (LS): from the nearest earlier split the outputs get (not one that is paused or held), else CS. */
  #lapOf(race, state, c) {
    const mine = state.bibs.get(c.bib)?.kept;
    for (let i = c.index - 1; i >= 0; i--) {
      const prev = mine?.[i];
      if (prev && !this.#holdOf(race, state, prev)) return c.rt - prev.rt;
    }
    return c.rt;
  }

  /**
   * 9.23 F21: whether an output has this crossing with its time and column as they are now (any place) but with another
   * leg (LS) than it has now, by what the output's copy says it got (a copy from a race file of before says nothing).
   */
  #legOff(race, state, c) {
    if (this.#holdOf(race, state, c) || !state.rel.has(c.key)) return false;
    const ls = this.#lapOf(race, state, c);
    const cell = cellOf(this.#content(race, c, 0));
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      const e = this.#latestFlight(state, o.id, c.key) ?? state.ledgers.get(o.id)?.get(c.key);
      if (e && e.ls != null && e.ls !== ls && cellOf(e) === cell) return true;
    }
    return false;
  }

  #packet(race, state, c, place, reason, sig, allowFinished, allowInactive, byFinish = false) {
    const split = race.splits[c.index];
    const ls = this.#lapOf(race, state, c);
    const who = this.#who(state, c.bib);
    /** @type {SplitPacket} */
    const packet = {
      // (9.26: its place among the splits that are sent, and how many there are: what the scoreboards count by)
      raceId: race.id, race: race.race, splitId: split.id, splitIndex: split.sentIndex, splitCount: race.sentCount,
      splitName: split.name, bib: c.bib, first: who.first, last: who.last, team: who.team, gender: who.gender,
      csTicks: c.rt, lsTicks: ls, place, lapsToGo: split.l2g, gunTicks: race.gunTicks, tod: c.tod,
      runnerCount: state.runnerCount, reason,
    };
    const { id: raceId } = race;
    const epoch = state.epoch;
    const key = c.key;
    // A packet that waited in a queue (TrackScore was down) must not go out once it is wrong: the runner finished
    // meanwhile (it would overwrite the finish place), a newer packet replaced it, or the race was paused.
    Object.defineProperty(packet, 'isCurrent', {
      enumerable: false,
      value: () => {
        const r = this.#raceById.get(raceId);
        const st = this.#states.get(raceId);
        if (!r || st !== state || st.epoch !== epoch || r.gunTicks === null) return false;
        if (!r.active && !allowInactive) return false;
        const now = st.kept.get(key);
        // paused, or its column in doubt since (9.17): it waits
        if (!now || this.#holdOf(r, st, now)) return false;
        if (byFinish) {
          const fp = this.#finishPlace(st, now.bib);
          return fp !== null && this.#content(r, now, fp).sig === sig;
        }
        if (!allowFinished && this.#finished(st, now.bib)) return false;
        return this.#content(r, now, this.#place(st, now)).sig === sig;
      },
    });
    return packet;
  }

  #latestFlight(state, outputId, key) {
    const flights = state.flights.get(outputId)?.get(key);
    return flights?.length ? flights[flights.length - 1] : null;
  }

  /**
   * When the minute in which the relay corrects an output's cell by itself (RESEND_WINDOW_MS) starts: the output's
   * first copy of the cell, or later, when the operator last put a time there (9.23 F4: a fill, a Move, an Undo; on
   * its way or landed). A real read that replaces a made-up time the operator just sent is then sent as a correction,
   * though an earlier time of that cell went out minutes before (a Move emptied it, the fill went in).
   */
  #windowFrom(state, outputId, key, led) {
    let t = led ? Math.max(led.firstAt, led.fixedAt ?? -Infinity) : -Infinity;
    for (const f of state.flights.get(outputId)?.get(key) ?? []) if (f.fixedAt !== undefined && f.fixedAt > t) t = f.fixedAt;
    return t;
  }

  /** The start of a crossing's minute as the feed says it ("first sent 75 s ago"): the oldest among the outputs. */
  #sentSince(state, key) {
    let t = null;
    for (const [oid, ledger] of state.ledgers) {
      const e = ledger.get(key);
      if (!e) continue;
      const w = this.#windowFrom(state, oid, key, e);
      if (t === null || w < t) t = w;
    }
    return t;
  }

  /**
   * The newest packet an output has (or has on its way) for a runner, of any split: TrackScore takes the runner's place
   * from the newest packet (9.23 F4). { key, e } or null. Packets of this run are ordered by their number; entries
   * from before a restart (number 0) by when they landed.
   */
  #newestCopy(race, state, outputId, bib) {
    let top = null;
    const newer = (a, b) => (a.n !== b.n ? a.n > b.n : (a.at ?? 0) > (b.at ?? 0));
    for (const sp of race.splits) {
      const key = crossingKey(bib, sp.id);
      const e = this.#latestFlight(state, outputId, key) ?? state.ledgers.get(outputId)?.get(key);
      if (e && (!top || newer(e, top.e))) top = { key, e };
    }
    return top;
  }

  #dropFlight(state, outputId, key, flight) {
    const byKey = state.flights.get(outputId);
    const flights = byKey?.get(key);
    const i = flights ? flights.indexOf(flight) : -1;
    if (i < 0) return false;
    state.deliveryRev++;
    flights.splice(i, 1);
    if (!flights.length) byKey.delete(key);
    return true;
  }

  #failedSet(state, outputId) {
    let s = state.failed.get(outputId);
    if (!s) state.failed.set(outputId, (s = new Set()));
    return s;
  }

  #ack(raceId, state, epoch, outputId, key, flight, ok) {
    if (this.#states.get(raceId) !== state || state.epoch !== epoch) return;
    if (!this.#dropFlight(state, outputId, key, flight)) return;
    if (!ok) {
      this.#failedSet(state, outputId).add(key);
      // dropped (the queue overflowed, the output was switched off): its feed row and the counts say so (9.16 F3; a
      // correction that never arrived leaves an old copy, which counts as not sent for a finisher: revision 10)
      this.#deliveryChanged(state, key);
      return;
    }
    let ledger = state.ledgers.get(outputId);
    if (!ledger) state.ledgers.set(outputId, (ledger = new Map()));
    const led = ledger.get(key);
    if (led && led.n > flight.n) {
      // a newer packet was acknowledged first; this older one still filled its own cell (9.16 F1)
      if (led.l2g !== flight.l2g || led.count !== flight.count) this.#orphan(state, outputId, { bib: led.bib, l2g: flight.l2g, count: flight.count });
      return;
    }
    // the cell the older packet filled stays filled in TrackScore when this one goes to another column (9.16 F1)
    if (led && (led.l2g !== flight.l2g || led.count !== flight.count)) this.#orphan(state, outputId, led);
    const now = this.#clock.now();
    // 9.23 F4: a time the operator put in this cell starts its minute again (a later read may still correct it)
    const fixedAt = flight.fixedAt !== undefined ? flight.fixedAt : led?.fixedAt ?? null;
    ledger.set(key, ledgerEntry(key, flight.tod, flight.place, flight.gun, flight.l2g, flight.count, flight.n, led?.firstAt ?? now, now, null, fixedAt, flight.ls ?? null));
    state.failed.get(outputId)?.delete(key);
    this.#saveSoon(state);
  }

  /**
   * Whether an output took this crossing (DESIGN 9.16 F3): it acknowledged it (its ledger) or holds it to send (in
   * flight). The feed says "Sent", and the finished-not-sent count leaves it out, only then.
   */
  #delivered(state, key) {
    for (const ledger of state.ledgers.values()) if (ledger.has(key)) return true;
    for (const byKey of state.flights.values()) if (byKey.has(key)) return true;
    return false;
  }

  /**
   * Whether an output has this crossing AS IT IS NOW (revision 10): the same time of day, gun and column (laps to go
   * and split count), acknowledged or on its way. The place is not compared: a finisher's place in TrackScore is
   * FinishLynx's, and a runner on the course gets place updates by the usual rules. `old` is what an output has for
   * the crossing when none has it as it is now (it was sent before a Move, a gun change or a backup read corrected
   * it): its time of day and gun, so the panel can say "Sent with an old time (29:12.1)". Used where an old copy must
   * not count as sent: a finisher's split (Finished: not sent live), a made-up time (sent or not).
   * @returns {{ now: boolean, old: { tod: number, gun: number, l2g: number, count: number } | null }}
   */
  #sentAs(race, state, c) {
    const n = race.sentCount;
    const l2g = this.#l2gOf(race, c);
    const same = (e) => e.tod === c.tod && e.gun === race.gunTicks && e.l2g === l2g && e.count === n;
    let old = null;
    for (const [oid, ledger] of state.ledgers) {
      const e = ledger.get(c.key);
      const f = this.#latestFlight(state, oid, c.key);
      if ((e && same(e)) || (f && same(f))) return { now: true, old: null };
      old ??= f ?? e ?? null;
    }
    for (const [oid, byKey] of state.flights) {
      if (state.ledgers.has(oid) || !byKey.has(c.key)) continue;
      const f = this.#latestFlight(state, oid, c.key);
      if (f && same(f)) return { now: true, old: null };
      old ??= f ?? null;
    }
    return { now: false, old };
  }

  /**
   * Whether a made-up crossing went out: an output has it as it is now, or with the same time of day (the gun was
   * corrected since). An older real time of that split in the same cell does not count: that is not the made-up time.
   */
  #madeUpSent(race, state, c) {
    const s = this.#sentAs(race, state, c);
    return s.now || (s.old !== null && s.old.tod === c.tod);
  }

  /**
   * The place rule for a finished runner's split (revision 10): an output that was given it AFTER the runner finished
   * with a place other than the finish place (a split held by a pause, released a moment after FinishLynx's finish
   * reached TrackScore but before its file did; a Resend that included finishers; an output that caught up late) has
   * the split place as the runner's place. Returns that copy's place, or null when every output's current copy is
   * fine (sent before the finish, or with the finish place), or the finish place is not known.
   * @returns {number | null}
   */
  #sentAfterFinish(race, state, c, only = undefined) {
    if (c.manual || race.gunTicks === null) return null;
    const fp = this.#finishPlace(state, c.bib);
    const finish = this.#finishOf(state, c.bib);
    if (fp === null || finish === null) return null;
    const n = race.sentCount;
    const l2g = this.#l2gOf(race, c);
    const now = this.#clock.now();
    const finishTod = race.gunTicks + finish;
    const seen = state.lynxSeenAt.get(bibKey(c.bib));
    const late = this.#filter().holdMs + LATE_SEND_MS;
    // after the finish: by then reads timed at or after the finish had come in (the race's own clock, so a PC clock
    // set apart from RR12's, or a race replayed later, changes nothing); or it went out late (held by a pause, an
    // output that caught up) in the moments before the relay found the finish in FinishLynx's file, which FinishLynx
    // writes a little after it tells TrackScore. A split sent as the runner crossed the mat went out before the finish.
    const after = (copy) => {
      if (copy.tod !== c.tod || copy.gun !== race.gunTicks || copy.l2g !== l2g || copy.count !== n || copy.place === fp) return false;
      const at = copy.at ?? now;
      if ((this.#raceClockAt(state, at) ?? -Infinity) >= finishTod) return true;
      return seen !== undefined && at >= seen - FINISH_SEEN_WINDOW_MS && at - c.firstAt >= late;
    };
    for (const oid of this.#copyOutputs(state, c.key)) {
      // what this output has, or will have once the packet on its way lands
      const copy = this.#latestFlight(state, oid, c.key) ?? state.ledgers.get(oid)?.get(c.key);
      if (copy && after(copy) && (only === undefined || only === oid)) return copy.place;
    }
    return null;
  }

  /** Every output that has, or has on its way, a copy of this crossing. */
  #copyOutputs(state, key) {
    const out = [];
    for (const [oid, ledger] of state.ledgers) if (ledger.has(key) || state.flights.get(oid)?.has(key)) out.push(oid);
    for (const [oid, byKey] of state.flights) if (!state.ledgers.has(oid) && byKey.has(key)) out.push(oid);
    return out;
  }

  /**
   * Revision 11: a split that went out with the split place after the runner had finished (held by a pause and played
   * a moment before FinishLynx saved the finish; an output that caught up late) replaced the finish place in
   * TrackScore. Once the finish place is known, that copy is sent again with it, on its own: it only puts back what
   * FinishLynx said, so it needs no operator (made-up and corrected times still do). Checked at most once a second.
   */
  #repairFinishPlaces(race, state, now) {
    if (now >= (state.repairAt ?? 0) && now - (state.repairAt ?? 0) < REPAIR_EVERY_MS) return;
    state.repairAt = now;
    let repaired = 0;
    /** bib -> output id -> the key of the runner's last packet sent here (9.23 F21) */
    const lastOf = new Map();
    for (const c of state.kept.values()) {
      if (c.manual || !this.#finished(state, c.bib) || this.#holdOf(race, state, c)) continue;
      const fp = this.#finishPlace(state, c.bib);
      if (fp === null) continue;
      let content = null;
      for (const o of this.#outputs) {
        if (!takes(o, race.id) || this.#sentAfterFinish(race, state, c, o.id) === null) continue;
        content ??= this.#content(race, c, fp);
        if (!this.#send(race, state, o, c, fp, 'place-update', content, { allowFinished: true, byFinish: true })) continue;
        repaired++;
        let last = lastOf.get(c.bib);
        if (!last) lastOf.set(c.bib, (last = new Map()));
        last.set(o.id, c.key);
      }
    }
    // 9.23 F21: the runner's furthest split last, with the finish place, as after any packet of an earlier split: a
    // 4400m that a one click on the course sent after the runner's finish, with its split place, went again with the
    // finish place once FinishLynx's file had it, after the 5300m line, and stayed the runner's newest line
    for (const [bib, last] of lastOf) this.#sendFurthestFinished(race, state, bib, last);
    if (repaired) {
      this.#log(`[engine] ${race.name}: ${repaired} split${repaired === 1 ? '' : 's'} sent after the runner finished went out again with the finish place`);
      this.#saveSoon(state);
      this.#touched.add(race.id);
    }
  }

  /**
   * The race's clock as its reads showed it at a wall-clock moment (revision 10, the place rule): the latest time of
   * day among the race's reads that had come in by then, or null before the first. Reads come in after they happen,
   * so the race was at least this far on.
   * @param {number} wall ms
   */
  #raceClockAt(state, wall) {
    const { ats, tods } = state.clock;
    let lo = 0;
    let hi = ats.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ats[mid] <= wall) lo = mid + 1;
      else hi = mid;
    }
    return lo ? tods[lo - 1] : null;
  }

  /**
   * A finished runner's real crossing that no output has as it is now, or that went out after the runner finished
   * with the split place (the place rule): Review's "Finished: not sent live" (P4, revision 10).
   */
  #finishedUnsent(race, state, c) {
    if (c.manual || !this.#finished(state, c.bib) || this.#holdOf(race, state, c)) return false;
    return !this.#sentAs(race, state, c).now || this.#sentAfterFinish(race, state, c) !== null;
  }

  /** "29:12.1": the race time an output has for a crossing that was sent before it was corrected. */
  #oldText(old) {
    return old && Number.isFinite(old.tod) && Number.isFinite(old.gun) ? formatRaceTime(raceTicks(old.tod, old.gun), 1) : '';
  }

  /** A crossing's delivery changed outside a batch of reads: its feed row and the race view follow at once. */
  #deliveryChanged(state, key) {
    const bib = state.kept.get(key)?.bib ?? bibOfKey(key);
    state.feedBibs.add(bib);
    this.#touched.add(state.id);
    if (this.#feedSoon) return;
    this.#feedSoon = true;
    queueMicrotask(() => {
      this.#feedSoon = false;
      try {
        this.#emitTouched();
        this.#refreshFeed();
      } catch (err) {
        this.#log(`[engine] refreshing the feed failed: ${err?.stack ?? err}`);
      }
    });
  }

  /**
   * Remember a cell an output was given that no ledger entry will stand for (DESIGN 9.16 F1).
   * @param {{ bib: string, l2g: unknown, count: unknown }} led
   */
  #orphan(state, outputId, led) {
    if (!led || !led.bib || !Number.isInteger(led.l2g) || !Number.isInteger(led.count)) return;
    let byBib = state.orphans.get(outputId);
    if (!byBib) state.orphans.set(outputId, (byBib = new Map()));
    let cells = byBib.get(led.bib);
    if (!cells) byBib.set(led.bib, (cells = new Set()));
    const cell = `${led.l2g}|${led.count}`;
    if (cells.has(cell)) return;
    cells.add(cell);
    this.#saveSoon(state);
  }

  /**
   * The TrackScore / Karmarush cells a Resend can't correct (DESIGN 9.16 F1): cells an output that takes the race was
   * given a time for, in which the runner has no split under the current settings. A cell is the column a packet went
   * to: "split count - laps to go", with the split count TrackScore has now (it is told to match the race's) or, if
   * it matched the race when the packet went out, the one it had then. Columns that no longer exist don't count. None
   * while the race has no gun time (nothing counts then, until it is set).
   * @returns {RaceView['leftover']}
   */
  #leftover(race, state) {
    // 9.26: the boards' columns are the splits that are sent: column j of them is the race's split race.sent[j]
    const n = race.sentCount;
    const none = { count: 0, runners: [], byOutput: [], text: null };
    if (race.gunTicks === null || !n) return none;
    const all = new Set();
    const bibs = new Set();
    const byOutput = [];
    for (const o of this.#outputs) {
      if (!takes(o, race.id)) continue;
      const mine = new Set();
      const check = (bib, l2g, count) => {
        if (!Number.isInteger(l2g) || !Number.isInteger(count)) return;
        const kept = state.bibs.get(bib)?.kept;
        for (const j of count === n ? [n - l2g] : [n - l2g, count - l2g]) {
          if (j < 0 || j >= n) continue;
          const col = race.sent[j].index;
          if (kept?.[col]) continue;
          const cell = `${bib}\u0000${col}`;
          mine.add(cell);
          all.add(cell);
          bibs.add(bib);
        }
      };
      state.ledgers.get(o.id)?.forEach((led, key) => {
        // nearly every entry: the crossing it was sent for still counts, in the same column
        if (led.count === n) {
          const c = state.kept.get(key);
          if (c && led.l2g === this.#l2gOf(race, c)) return;
        }
        check(led.bib, led.l2g, led.count);
      });
      state.orphans.get(o.id)?.forEach((cells, bib) => {
        for (const cell of cells) {
          const [l2g, count] = cell.split('|').map(Number);
          check(bib, l2g, count);
        }
      });
      if (mine.size) byOutput.push({ outputId: o.id, name: o.name, count: mine.size });
    }
    if (!all.size) return none;
    const runners = [...bibs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { count: all.size, runners, byOutput, text: leftoverText(all.size, runners) };
  }

  /**
   * Why no output took a crossing whose hold is over (DESIGN 9.16 F3), for its feed row: "no output that is switched on
   * sends Girls 5K (Outputs tab)", "TrackScore's script can't be loaded (...)".
   */
  #noTakerWhy(race) {
    if (!this.#outputs.length) return 'there are no outputs yet (add TrackScore on the Outputs tab)';
    if (!this.#outputs.some((o) => o.enabled)) return 'every output is switched off (Outputs tab)';
    const outs = this.#outputs.filter((o) => takes(o, race.id));
    if (!outs.length) return `no output that is switched on sends ${race.name} (Outputs tab)`;
    const why = outs.map((o) => {
      const s = this.#outStatus.get(o.id);
      if (s?.enabled === false) return `${o.name} is switched off`;
      if (s?.scriptOk === false) return `${o.name}'s script can't be loaded${s.scriptError ? ` (${text(s.scriptError)})` : ''}`;
      if (s?.state === 'listening' && !s.clients) return `no program is connected to ${o.name}`;
      if (s?.refusal) return `${o.name}: ${text(s.refusal)}`;
      if (s?.state === 'error' && s.lastError) return `${o.name}: ${text(s.lastError)}`;
      return `${o.name} couldn't take it`;
    });
    return why.join('; ');
  }

  #retry(outputId) {
    for (const state of this.#states.values()) {
      for (const [oid, keys] of state.failed) {
        if (outputId !== null && oid !== outputId) continue;
        for (const k of keys) state.dirty.add(k);
        keys.clear();
      }
    }
  }

  /**
   * Crossings this output shows differently from now, that convergence will not fix (only a resend can).
   * @param {{ counts: Map<number, number>, order: number }} [why] filled with the reasons (staleWhy)
   * @param {Set<string>|null} [keys] 9.23 F14: the crossings out of date on any output so far: this output's are added,
   *   and the reasons are counted once per crossing (a runner's split out of date counts once, whatever the outputs)
   */
  #staleCount(race, state, o, why = null, except = null, keys = null) {
    const ledger = state.ledgers.get(o.id);
    if (!ledger) return 0;
    let n = 0;
    const gun = race.gunTicks;
    const count = race.sentCount;
    // Worked out for every race view (twice a second while the panel is open): compared field by field, the content
    // signature is only built for the few entries that differ.
    ledger.forEach((led, key) => {
      // (9.23: a change's own runners, whose emptied cells the change itself reports)
      if (except?.has(led.bib)) return;
      const c = state.kept.get(key);
      if (!c) {
        n++;
        keys?.add(key);
        return;
      }
      // paused, or its column in doubt (9.17): held on purpose, and what it gets is worked out when it is let go
      if (this.#holdOf(race, state, c)) return;
      const fp = c.manual && this.#finished(state, c.bib) ? this.#finishPlace(state, c.bib) : null;
      const place = fp ?? this.#place(state, c);
      const l2g = this.#l2gOf(race, c);
      if (led.tod === c.tod && led.place === place && led.gun === gun && led.l2g === l2g && led.count === count) return;
      const now = this.#content(race, c, place);
      if (led.waived === now.sig || this.#latestFlight(state, o.id, key)?.sig === now.sig) return;
      // A finished runner's place in TrackScore is FinishLynx's: only a different time (or column) is worth a resend.
      if (this.#finished(state, c.bib) && led.tod === now.tod && led.gun === now.gun && led.l2g === now.l2g && led.count === now.count) return;
      // A finished runner's real split with another time: a Resend leaves finishers out, so it can't fix it. Review
      // lists it under "Finished: not sent live" (sent with an old time), where Send with finish place corrects it.
      if (!c.manual && this.#finishedUnsent(race, state, c)) return;
      n++;
      if (keys) {
        if (keys.has(key)) return;
        keys.add(key);
      }
      if (why && led.count !== count) why.counts.set(led.count, (why.counts.get(led.count) ?? 0) + 1);
      else if (why && led.l2g !== l2g) why.order++;
    });
    return n;
  }

  #pruneLedgers() {
    const ids = new Set(this.#outputs.map((o) => o.id));
    for (const state of this.#states.values()) {
      let changed = false;
      for (const map of [state.ledgers, state.flights, state.failed, state.orphans]) {
        for (const id of [...map.keys()]) {
          if (ids.has(id)) continue;
          map.delete(id);
          changed = true;
        }
      }
      if (changed) this.#saveSoon(state);
    }
  }

  #schedule() {
    if (!this.#delivering) return this.#clearHoldTimer();
    const { holdMs } = this.#filter();
    const now = this.#clock.now();
    let next = Infinity;
    for (const race of this.#races) {
      if (!race.active || race.gunTicks === null) continue;
      const state = this.#states.get(race.id);
      if (!state) continue;
      for (const k of state.unreleased) {
        const c = state.kept.get(k);
        if (!c) continue;
        const due = now < c.firstAt ? now : c.firstAt + holdMs;
        if (due < next) next = due;
      }
    }
    if (next === Infinity) return this.#clearHoldTimer();
    if (this.#holdTimer !== null && this.#holdTimerAt <= next) return;
    this.#clearHoldTimer();
    this.#holdTimerAt = next;
    // Never longer than one hold: whatever the wall clock does, a held crossing waits at most about holdSec.
    this.#holdTimer = this.#clock.setTimeout(() => this.#onHoldTimer(), Math.min(holdMs, Math.max(0, next - now)));
  }

  #clearHoldTimer() {
    if (this.#holdTimer !== null) this.#clock.clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    this.#holdTimerAt = Infinity;
  }

  #onHoldTimer() {
    this.#holdTimer = null;
    this.#holdTimerAt = Infinity;
    try {
      this.#converge(this.#clock.now());
    } catch (err) {
      this.#log(`[engine] sending held crossings failed: ${err?.stack ?? err}`);
    }
    this.#after();
  }

  // ---- persistence ----------------------------------------------------------------------------------------------

  /**
   * Forget a race that is no longer in the settings. Its race file (what each output was given, and its settings) is
   * moved to racesdeleted only when the operator deleted the race: a missing race (R6) keeps it, so nothing is sent
   * twice and it can be put back when the race comes back.
   * @param {string} id
   * @param {boolean} remove the operator deleted it
   */
  #dropRace(id, remove) {
    // A race that goes missing keeps its file, with its last settings and deliveries in it: "Put it back" restores the
    // race from there (9.15 V2), so a save that was still due is written now.
    if (!remove && this.#unsaved.has(id)) this.#save(id);
    this.#fileNames.delete(id);
    this.#states.delete(id);
    if (this.#saveTimers.has(id)) this.#clock.clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);
    this.#unsaved.delete(id);
    this.#touched.add(id);
    if (!remove || !this.#store?.remove) return;
    try {
      const r = this.#store.remove(id);
      if (r && typeof r.then === 'function') r.then(null, (err) => this.#log(`[engine] could not remove saved race ${id}: ${err?.message ?? err}`));
    } catch (err) {
      this.#log(`[engine] could not remove saved race ${id}: ${err?.message ?? err}`);
    }
  }

  /**
   * The race file (what each output was given) is saved at most SAVE_DELAY_MS later. Not a trailing debounce: a steady
   * stream of packets must not keep postponing the save forever. Losing the last moment of it only means a packet an
   * output already had is sent again, which changes nothing.
   */
  #saveSoon(state) {
    this.#unsaved.add(state.id);
    if (this.#halted || !this.#store?.save || this.#saveTimers.has(state.id)) return;
    this.#saveTimers.set(state.id, this.#clock.setTimeout(() => {
      this.#saveTimers.delete(state.id);
      this.#save(state.id);
    }, SAVE_DELAY_MS));
  }

  #save(id) {
    this.#unsaved.delete(id);
    const state = this.#states.get(id);
    if (!state || !this.#store?.save) return;
    const fail = (err) => this.#log(`[engine] could not save the race file of ${this.#raceById.get(id)?.name ?? id}: ${err?.message ?? err}`);
    try {
      const r = this.#store.save(id, this.#serialize(state));
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (err) {
      fail(err);
    }
  }

  #serialize(state) {
    const ledgers = {};
    for (const [outputId, ledger] of state.ledgers) {
      ledgers[outputId] = Array.from(ledger.values(), (e) => e.row);
    }
    // The race's settings too: if config.json is ever put back from an older copy, a race added since is missing (R6),
    // and this is where its settings can be found again.
    const race = this.#raceById.get(state.id)?.race ?? state.lastRace ?? null;
    state.savedRace = JSON.stringify(race);
    // a new meet is a clear of every race, also of one added since (its file then says its deliveries are this meet's)
    const out = { version: STORE_VERSION, clearedSeq: Math.max(this.#clearSeq.get(state.id) ?? 0, this.#meetSeq), ledgers, race };
    // only after a setting change, and few: [bib, laps to go, split count] per cell (9.16 F1)
    let orphans = null;
    for (const [outputId, byBib] of state.orphans) {
      const rows = [];
      for (const [bib, cells] of byBib) {
        for (const cell of cells) {
          const [l2g, count] = cell.split('|').map(Number);
          rows.push([bib, l2g, count]);
        }
      }
      if (rows.length) (orphans ??= {})[outputId] = rows;
    }
    if (orphans) out.orphans = orphans;
    return out;
  }

  // ---- feed -----------------------------------------------------------------------------------------------------

  #entryFor(read, now) {
    const entry = {
      id: ++this.#feedSeq, at: now, raceId: null, raceName: '', splitName: '', location: read.location ?? '',
      bib: read.bib ?? '', name: '', team: '', tod: read.tod ?? null, raceTicks: null, place: null, status: 'bad-line',
      detail: '',
      // the RR12 input port the line came in on (9.15 L2): with two exporters, the panel's feed says which one sent it
      port: Number.isInteger(read.port) ? read.port : null,
    };
    // 9.27: the bib the read came in as, while it counts for the other bib of a swapped pair (only then)
    if (read.chip !== undefined && read.chip !== read.bib) entry.readAs = read.chip;
    return entry;
  }

  /** The feed texts of one race (see #describe); a race edited in the settings is a new object, with new texts. */
  #textsOf(race) {
    let t = this.#texts.get(race);
    if (!t) this.#texts.set(race, (t = { paused: undefined, waiting: undefined, waitFor: undefined, unmapped: new Map() }));
    return t;
  }

  /** The feed detail of a read that waits for a missing race (DESIGN 9.2 R6). */
  #missingText(raceId) {
    const name = this.#missingName(raceId);
    return `Its race${name ? ` '${name}'` : ''} isn't in the settings (config.json was restored or edited). They come back if the race does.`;
  }

  /** "its race 'Girls 5K' was deleted", for a read whose race was deleted (DESIGN 9.2 R2). */
  #deletedText(rec) {
    const name = rec.raceId ? this.#raceNames.get(rec.raceId) ?? '' : '';
    return name ? `its race '${name}' was deleted` : 'its race was deleted';
  }

  /**
   * A read out of use for good (DESIGN 9.2 R2, R3): its row says why, so nothing goes missing without a word. A cleared
   * read stays in its race's rows; a read whose race was deleted has no race.
   */
  #describeGone(rec) {
    const who = this.#who(null, rec.bib, rec.chip === rec.bib ? rec : null);
    const f = { raceId: null, raceName: '', splitName: '', name: joinName(who), team: who.team, raceTicks: null, place: null };
    if (rec.gone === CLEARED) {
      const race = rec.raceId ? this.#raceById.get(rec.raceId) : undefined;
      const name = race?.name ?? (rec.raceId ? this.#raceNames.get(rec.raceId) ?? '' : '');
      return { ...f, raceId: race ? race.id : null, raceName: name, status: 'cleared',
        detail: `Cleared with "Clear race data"${name ? ` in ${name}` : ''}, so it is not used. New reads count as usual.` };
    }
    const t = this.#deletedText(rec);
    return { ...f, raceName: rec.raceId ? this.#raceNames.get(rec.raceId) ?? '' : '', status: 'race-deleted',
      detail: `${t[0].toUpperCase()}${t.slice(1)}, so this read is not used.` };
  }

  /** What a read means now, as the feed shows it. */
  #describe(rec) {
    if (rec.gone !== LIVE) return this.#describeGone(rec);
    const race = rec.raceId ? this.#raceById.get(rec.raceId) : null;
    const state = race ? this.#states.get(race.id) : null;
    if (!race || !state) {
      const who = this.#who(null, rec.bib, rec.chip === rec.bib ? rec : null);
      const f = { raceId: null, raceName: '', splitName: '', name: joinName(who), team: who.team, raceTicks: null, place: null };
      // R6: the read's own race is missing from the settings (not deleted): it waits for it
      if (rec.raceId) return { ...f, raceName: this.#missingName(rec.raceId), status: 'race-missing', detail: this.#missingText(rec.raceId) };
      const why = this.#noRaceWhy(rec.contestKey);
      if (why.status === 'paused') {
        // C1: it waits for the race that lists its contest, in no race; it is not moved into a race that is not Active.
        // (The text is made once per race: an RR12 Replay of an old race's reads describes thousands of them.)
        const texts = this.#textsOf(this.#listing.get(rec.contestKey)[0]);
        texts.waitFor ??= `Its race '${why.raceName}' is not Active. These reads are used when you tick Active.`;
        return { ...f, raceName: why.raceName, status: 'paused', detail: texts.waitFor };
      }
      if (why.status === 'set-aside') {
        const aside = this.#setAside.get(rec.contestKey);
        return { ...f, status: 'set-aside', detail: asideText({ contest: aside.contest, reason: this.#reason(aside), key: rec.contestKey }) };
      }
      if (why.status === 'race-missing') return { ...f, raceName: why.raceName, status: 'race-missing', detail: this.#missingText(why.raceId) };
      let detail;
      const idle = this.#races.find((r) => r.takesAll && !r.active);
      const also = idle ? ` ${idle.name} takes every contest but is not active.` : '';
      const info = routeKeyInfo(rec.contestKey);
      if (!this.#races.length) detail = 'No races are set up yet. Add one on the Races tab.';
      else if (rec.contest) detail = `No active race takes contest "${rec.contest}".${also}`;
      else if (info.via === 'port') detail = `No active race takes the reads from port ${info.port}. Choose port ${info.port} on the race (Races tab), and tick Active.${also}`;
      else if (info.via === 'event') detail = `No active race is event ${info.event}. Give the race event ${info.event} (Races tab), and tick Active.${also}`;
      else detail = 'This read has no contest, and no active race takes every contest.';
      return { ...f, status: 'no-race', detail };
    }
    const who = this.#who(state, rec.bib);
    const f = { raceId: race.id, raceName: race.name, splitName: '', name: joinName(who), team: who.team, raceTicks: null,
      place: null, status: 'unmapped', detail: '' };
    const o = this.#outcome(state, rec) ?? UNMAPPED;
    const split = o.splitId ? race.splitById.get(o.splitId) : null;
    f.splitName = split ? split.name : o.finish || o.kind === 'finish' ? 'Finish' : '';
    if (typeof o.rt === 'number') f.raceTicks = o.rt;
    // The texts that only depend on the race are made once per race: an RR12 Replay describes tens of thousands of reads.
    const texts = this.#textsOf(race);
    const paused = () => {
      f.status = 'paused';
      f.detail = texts.paused ??= `${race.name} is not active, so its reads are not sent. Tick Active to send them.`;
    };
    switch (o.kind) {
      case 'unmapped': {
        let t = texts.unmapped.get(rec.location);
        if (t === undefined) {
          t = rec.location ? `"${rec.location}" is not a split or finish of ${race.name}.` : 'This read has no timing point name.';
          if (texts.unmapped.size < 1000) texts.unmapped.set(rec.location, t);
        }
        f.detail = t;
        break;
      }
      case 'waiting-gun':
        if (!race.active) paused();
        else {
          f.status = 'waiting-gun';
          f.detail = texts.waiting ??= `Waiting for the gun time of ${race.name}. Set it on the Races tab.`;
        }
        break;
      case 'before-gun':
        f.status = 'before-gun';
        f.detail = `${secs(o.rt)} before the gun (${formatTod(race.gunTicks)}), so it is not counted. Is the gun time right?`;
        break;
      case 'start-area':
        f.status = 'start-area';
        f.detail = `Too soon after the gun — ignored (start area). Change 'Ignore reads in the first ${fmtSec(this.#filter().startSec)} s' in Settings if this is a real split.`;
        break;
      case 'too-early': {
        const at = split?.earliestText || formatRaceTime(o.earliest, 0);
        f.status = 'too-early';
        f.detail = `Earlier than the earliest time of ${f.splitName} (${at}), so it can't be the ${f.splitName} pass — ignored. ` +
          'Change the earliest time on the race (Advanced) if it is wrong.';
        break;
      }
      case 'extra':
        f.status = 'extra';
        // 9.17: a pass with no split left before a split the operator fixed (a Move, or a made-up time)
        if (o.before) f.detail = `No split is left for this pass before ${o.before}, which was set in Review — ignored.`;
        else {
          f.detail = `More passes than this race has splits — ignored (${race.name} has ${o.count} split${o.count === 1 ? '' : 's'}; ` +
            'a split after the last one would mean "finished" to TrackScore).';
        }
        break;
      case 'finish':
        f.status = 'finish';
        // 9.23: a pass the operator marked as the finish in Review
        f.detail = o.marked && o.first ? MARKED_FINISH_TEXT
          : o.first ? 'Finish read: recorded. No more splits are sent for this runner, so TrackScore keeps the finish place. Not sent.'
            : 'Finish read (already recorded). Not sent.';
        break;
      case 'ignored':
        // 9.23: "Not a split": the operator set this pass aside in Review
        f.status = 'ignored';
        f.detail = IGNORED_TEXT;
        break;
      case 'backup':
        f.status = 'backup';
        f.detail = `Same crossing as the read at ${at1(o.openRt)} (${o.rt === o.openRt ? 'same time' : `${secs(o.rt - o.openRt)} later`}). Filtered.`;
        break;
      case 'repeat':
        f.status = 'repeat';
        f.detail = `${f.splitName} was already crossed at ${at1(o.openRt)}; this read is ${secs(o.rt - o.openRt)} later. Ignored.`;
        break;
      case 'after-finish':
        f.status = 'after-finish';
        f.detail = `After this runner's finish (${at1(o.finish)}). A split can't come after the finish, so it is ignored.`;
        break;
      case 'out-of-order': {
        const later = race.splits[o.byIndex]?.name ?? 'a later split';
        f.status = 'out-of-order';
        f.detail = `Not before this runner's ${later} (${at1(o.byRt)}), so it can't be a ${f.splitName} crossing. Ignored.`;
        break;
      }
      case 'opener':
        this.#describeOpener(race, state, rec, o, f, paused);
        break;
      default:
        break;
    }
    return f;
  }

  #describeOpener(race, state, rec, o, f, paused) {
    const c = state.kept.get(o.key);
    const rel = state.rel.get(o.key);
    const fin = this.#finished(state, rec.bib);
    if (!c) return;
    const delivered = !!rel && this.#delivered(state, o.key);
    const hold = this.#holdOf(race, state, c);
    // a late real read that took the place of a made-up time (9.17 P3) says so
    const tail = state.bibs.get(rec.bib)?.manualInfo?.some((m) => m.state === 'replaced' && m.k === c.index)
      ? ' Real read replaced the made-up time.' : '';
    if (hold === 'check') {
      // 9.17 P2: its column is in doubt; held from every output and the .lif until the operator decides
      const h = state.check.held.get(c.key);
      f.status = 'check-column';
      f.detail = `${h.text} — check it in Review.${h.lone ? ` ${LONE_TEXT}` : ''}${delivered ? ` (${race.splits[c.index].name} was sent before the doubt came up.)` : ''}`;
      return;
    }
    if (hold === 'stopped') {
      // 9.24: the operator stopped sending this runner
      f.status = 'not-sending';
      f.detail = STOPPED_TEXT;
      return;
    }
    if (hold === 'away') {
      // 9.25: the runner is not in this race (a start list enters it in another one, or the operator said so)
      const w = this.#whereElse(race, state, rec.bib);
      f.status = 'not-in-race';
      f.detail = AWAY_TEXT.replace('Not in this race:', `Not in this race (${w ? w.words : 'you said so'}):`);
      return;
    }
    if (hold === 'collect') {
      // 9.26: its split is counted but not sent: the pass keeps the runner's later passes in their splits
      const name = race.splits[c.index].name;
      f.status = 'counted';
      f.detail = COUNTED_TEXT.replace('This split', name) + (delivered ? ` (${name} went out before it was set to Not sent.)` : '') + tail;
      return;
    }
    if (hold === 'paused' && !delivered) {
      // 9.17 P1: the operator paused the split
      const name = race.splits[c.index].name;
      f.status = 'split-paused';
      f.place = this.#place(state, c);
      f.detail = `${name} is paused: kept, not sent. Press play on ${name} to send it.${tail}`;
      return;
    }
    if (delivered && fin && !hold && !c.manual) {
      // revision 10: it went out before it was corrected (a Move, an earlier backup read): TrackScore has the old time,
      // and only "Send with finish place" (Review) may correct it
      const s = this.#sentAs(race, state, c);
      if (!s.now) {
        f.status = 'finished-not-sent';
        f.place = this.#place(state, c);
        f.detail = `Finished: ${sentOldText(race.splits[c.index].name, this.#oldText(s.old), formatRaceTime(c.rt, 1))} ` +
          `Review lists it under Finished: not sent live. It is in the merged .lif.${tail}`;
        return;
      }
    }
    // what the row says follows delivery (9.16 F3): "Sent" once an output took it, the same before and after a restart
    if (!delivered) {
      if (fin) {
        f.status = 'finished-not-sent';
        f.detail = 'Finished: this split is not sent live, so TrackScore keeps the finish place. It is in the merged .lif.';
      } else if (!race.active) paused();
      else if (!rel) {
        const { holdSec, holdMs } = this.#filter();
        f.status = 'held';
        f.detail = holdMs > 0 ? `Holding ${holdSec} s for the backup read.` : 'Sending.';
      } else {
        f.status = 'ready';
        f.place = this.#place(state, c);
        f.detail = `Ready — no output took it: ${this.#noTakerWhy(race)}. It goes out by itself as soon as an output can take it.`;
      }
      f.detail += tail;
      return;
    }
    const live = rel.live;
    const place = this.#place(state, c);
    // the minute the correction rules count from (the cell's first copy, or the operator's last time in it: 9.23 F4)
    const ago = Math.max(0, Math.round((this.#clock.now() - (this.#sentSince(state, c.key) ?? rel.at)) / 1000));
    const why = fin ? 'this runner has finished' : !race.active ? `${race.name} is not active`
      : hold === 'paused' ? `${race.splits[c.index].name} is paused` : `first sent ${ago} s ago`;
    f.place = live.place;
    if (tail && c.tod !== rel.tod) {
      // the made-up time went out first; the real read is the crossing now (correction rules, 9.17 P3)
      const d = raceTicks(c.tod, rel.tod);
      if (live.tod === c.tod) {
        f.status = 'corrected';
        f.detail = `Real read replaced the made-up time (${secs(d)} ${d < 0 ? 'earlier' : 'later'}): re-sent as place ${live.place} with the real time.`;
      } else {
        f.status = 'backup';
        f.detail = `Real read replaced the made-up time (${secs(d)} ${d < 0 ? 'earlier' : 'later'}). Not re-sent: ${why}. ` +
          "Resend the race's splits to send the real time.";
      }
      return;
    }
    if (c.tod === rel.tod) {
      f.status = 'sent';
      if (live.reason === 'place-update') f.detail = `Place updated to ${live.place} (re-sent).`;
      else if (live.reason === 'correction') f.detail = `Re-sent as place ${live.place} with the corrected time ${formatRaceTime(c.rt)}.`;
      else f.detail = `Sent as place ${live.place}.`;
      if (place !== live.place) f.detail += ` Now place ${place}: not re-sent (${why}).`;
    } else if (live.tod === c.tod) {
      f.status = 'corrected';
      // a pass the operator moved in Review is this split's now; else an earlier (backup) read came in
      const how = state.bibs.get(rec.bib)?.colHow?.[c.index];
      f.detail = how === 'moved' || how === 'shifted' || how === 'kept' || how === 'hold'
        ? `${how === 'moved' || how === 'shifted' ? 'Moved' : 'Kept'} in Review: re-sent as place ${live.place} with the corrected time.`
        // 9.23 F13: another pass of the runner is this split now (a late read of a split the mats missed came in)
        : Math.abs(raceTicks(rel.tod, c.tod)) > this.#filter().windowTicks
          ? `Counted again after a late read: re-sent as place ${live.place} with this time (${formatRaceTime(raceTicks(rel.tod, race.gunTicks), 1)} was there before).`
          : `Backup read ${secs(raceTicks(rel.tod, c.tod))} earlier: re-sent as place ${live.place} with the corrected time.`;
    } else {
      f.status = 'backup';
      f.detail = `${secs(raceTicks(rel.tod, c.tod))} earlier than the time sent. Not re-sent: ${why}.`;
    }
    // revision 10, the place rule: it went out after the runner finished, with the split place
    const after = fin && !hold ? this.#sentAfterFinish(race, state, c) : null;
    if (after !== null) f.detail += ` ${sentAfterText(after, this.#finishPlace(state, c.bib))} Review lists it under Finished: not sent live.`;
    // 9.24: the pace check marks it
    if (state.check?.fastOf?.get(rec.bib)?.legs.some((x) => x.col === c.index)) f.detail += ` ${TOO_FAST_TEXT}`;
    f.detail += tail;
  }

  /** Bring the feed rows of every read whose outcome may have changed up to date, in place. */
  #refreshFeed() {
    let all = this.#feedAll;
    this.#feedAll = false;
    const bibs = new Map();
    for (const state of this.#states.values()) {
      if (state.feedAllBibs) all = true;
      else if (state.feedBibs.size) bibs.set(state.id, state.feedBibs);
      state.feedAllBibs = false;
      state.feedBibs = new Set();
    }
    if (all) {
      for (const entry of this.#feedBySeq.values()) this.#update(entry);
      return;
    }
    for (const [raceId, set] of bibs) {
      const state = this.#states.get(raceId);
      for (const bib of set) {
        for (const r of state.reads.get(bib) ?? []) {
          const entry = this.#feedBySeq.get(r.seq);
          if (entry) this.#update(entry);
        }
      }
    }
  }

  #update(entry) {
    const rec = this.#recOf.get(entry);
    if (!rec) return;
    // a read taken out of use (cleared, its race deleted) says so: nothing disappears without a word (DESIGN 9.2)
    const f = this.#describe(rec);
    let changed = false;
    for (const k of Object.keys(f)) {
      if (entry[k] !== f[k]) {
        entry[k] = f[k];
        changed = true;
      }
    }
    // 9.27: a swap of bibs entered or removed since: the row is the runner's it counts for now, and says what it was read as
    if (entry.bib !== rec.bib) {
      entry.bib = rec.bib;
      changed = true;
    }
    const readAs = rec.chip !== rec.bib ? rec.chip : undefined;
    if (entry.readAs !== readAs) {
      if (readAs === undefined) delete entry.readAs;
      else entry.readAs = readAs;
      changed = true;
    }
    if (changed) this.#emitSafe('feed', entry);
  }

  #publish(entry) {
    if (this.#feed.length < FEED_SIZE) {
      this.#feed.push(entry);
    } else {
      // a ring: the oldest entry makes room without moving the other 999 (a Replay publishes tens of thousands)
      const old = this.#feed[this.#feedStart];
      const gone = this.#recOf.get(old);
      if (gone && this.#feedBySeq.get(gone.seq) === old) this.#feedBySeq.delete(gone.seq);
      this.#feed[this.#feedStart] = entry;
      this.#feedStart = (this.#feedStart + 1) % FEED_SIZE;
    }
    const rec = this.#recOf.get(entry);
    if (rec) this.#feedBySeq.set(rec.seq, entry);
    this.#emitSafe('feed', entry);
  }

  #after() {
    this.#ensureChecks();
    this.#schedule();
    this.#emitTouched();
    this.#refreshFeed();
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  #emitTouched() {
    const ids = [...this.#touched];
    this.#touched.clear();
    for (const id of ids) this.#emitSafe('race', id);
  }

  /** A failing listener (an output, the panel) must not leave a crossing half-sent or stop the reads behind it. */
  #emitSafe(name, ...payload) {
    try {
      this.emit(name, ...payload);
    } catch (err) {
      this.#log(`[engine] a '${name}' listener failed: ${err?.stack ?? err}`);
    }
  }
}
