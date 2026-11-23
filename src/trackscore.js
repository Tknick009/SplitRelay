// "Set up from TrackScore" (DESIGN 9.22 M8): read the live meet's Race Setup from TrackScore's web page, so Split
// Relay's races have TrackScore's event numbers and exactly its split points. GET requests only, read by the Split
// Relay server (a page can't: CORS), with a deadline and a size cap, and never into a port that takes timing data.
//
//   1. GET /api/xc/race                     -> the meet TrackScore's live race belongs to (meetId), and what its boards
//                                              run now; the rest (every runner) is dropped at once
//   2. GET /api/xc/schedule                 -> only when 1 has no meetId: lynxEvent.lastScopeMeetId. Never its races:
//                                              without a meetId TrackScore answers with an old, meet-less list
//   3. GET /api/xc/schedule?meetId=<id>     -> the meet's races, in program order
//   4. GET /api/meets/<id>                  -> the meet's name, if TrackScore has it (any failure is ignored)

import http from 'node:http';

/** Why TrackScore could not be read, in words for the operator; `status` is the HTTP status the panel gets. */
export class TrackScoreError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'TrackScoreError';
    this.status = status;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** The longest a whole read may take (O13): four GETs, but one wait for the operator. */
const OVERALL_MS = 8000;

/**
 * Read TrackScore's live meet.
 * @param {{ host: string, port: number, refuse?: (port: number) => string|null, timeoutMs?: number,
 *   overallMs?: number, maxBytes?: number, get?: typeof http.get }} opts refuse: why a port can't be TrackScore's web
 *   page (config.js webPortProblem), checked before any socket is opened; get: http.get (tests pass a stub)
 * @returns {Promise<{ meetId: string, meetName: string, raceSnap: { meetId: string|null, config: any },
 *   schedule: { races: any[], activeRaceId: string|null, lynxDir: string, autoSwitch: boolean|undefined } }>}
 */
export async function readTrackScore({ host, port, refuse = () => null, timeoutMs = 5000, overallMs = OVERALL_MS,
  maxBytes = 4 * 1024 * 1024, get = http.get }) {
  // An HTTP GET into TrackScore's port 5555 (or a live-results port) would feed the request lines into its live
  // ingestion: refused before anything is opened.
  const why = port === 5555 ? 'Port 5555 is where TrackScore takes the splits, not its web page.' : refuse(port);
  if (why) throw new TrackScoreError(400, `${why} Set "TrackScore web port" in Settings → Meet setup (usually 5000).`);
  const at = `${host}:${port}`;
  const end = Date.now() + overallMs;
  const fetchJson = (path) => getJson({ host, port, path, timeoutMs: Math.max(1, Math.min(timeoutMs, end - Date.now())), maxBytes, get, at });

  const race = await fetchJson('/api/xc/race');
  if (!isObj(race)) throw notTrackScore(at);
  // only the meet and what the boards run now: the snapshot also has every runner of the race
  const raceSnap = { meetId: text(race.meetId) || null, config: isObj(race.config) ? race.config : {} };
  let meetId = raceSnap.meetId ?? '';
  if (!meetId) {
    const any = await fetchJson('/api/xc/schedule');
    meetId = text(any?.lynxEvent?.lastScopeMeetId);
  }
  if (!meetId) throw new TrackScoreError(502, 'TrackScore has no meet open. Open the meet in TrackScore (its XC page), then try again.');
  const sched = await fetchJson(`/api/xc/schedule?meetId=${encodeURIComponent(meetId)}`);
  if (!isObj(sched)) throw notTrackScore(at);
  if (!Array.isArray(sched.races) || !sched.races.length) {
    throw new TrackScoreError(502, "TrackScore's meet has no races in Race Setup yet. Add them there, then try again.");
  }
  let meetName = '';
  try {
    const m = await fetchJson(`/api/meets/${encodeURIComponent(meetId)}`);
    meetName = text(m?.name);
  } catch {
    // an older TrackScore, or the meet was deleted: the heading shows its id instead
  }
  return {
    meetId, meetName, raceSnap,
    schedule: { races: sched.races, activeRaceId: text(sched.activeRaceId) || null, lynxDir: text(sched.lynxDir), autoSwitch: sched.autoSwitch },
  };
}

const notTrackScore = (at) => new TrackScoreError(502, `${at} answered, but not as TrackScore's XC Race Setup. Check "TrackScore web ` +
  'port" in Settings → Meet setup (usually 5000).');

/** One GET: 200 and JSON, at most maxBytes, within timeoutMs; anything else is a TrackScoreError in words. */
function getJson({ host, port, path, timeoutMs, maxBytes, get, at }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    };
    let req;
    const timer = setTimeout(() => {
      fail(new TrackScoreError(502, `TrackScore at ${at} did not answer within ${Math.round(timeoutMs / 1000) || 1} seconds.`));
      req?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = get({ host, port, path, agent: false, headers: { Accept: 'application/json' } }, (res) => {
        const type = String(res.headers['content-type'] ?? '');
        if (res.statusCode !== 200 || !/json/i.test(type)) {
          res.resume();
          fail(notTrackScore(at));
          req.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            const cap = maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${Math.round(maxBytes / 1024)} KB`;
            fail(new TrackScoreError(502, `TrackScore's answer was too big (more than ${cap}).`));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (done) return;
          try {
            const v = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^﻿/, ''));
            done = true;
            clearTimeout(timer);
            resolve(v);
          } catch {
            fail(notTrackScore(at));
          }
        });
        res.on('error', (err) => fail(socketError(err, at)));
      });
      req.on('error', (err) => fail(socketError(err, at)));
    } catch (err) {
      fail(socketError(err, at));
    }
  });
}

function socketError(err, at) {
  if (err instanceof TrackScoreError) return err;
  if (err?.code === 'ECONNREFUSED') {
    return new TrackScoreError(502, `TrackScore is not answering at ${at}. Is TrackScore running? If its web page is on another port, ` +
      'change "TrackScore web port" in Settings → Meet setup.');
  }
  return new TrackScoreError(502, `Split Relay couldn't reach TrackScore at ${at} (${err?.code ?? err?.message ?? err}).`);
}
