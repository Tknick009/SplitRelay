// Set up from TrackScore's reader (src/trackscore.js, DESIGN 9.22 M8) against a stand-in for TrackScore's web page on
// a free port: the live meet first, never the meet-less list's races, GETs only, and every failure in words. Never port
// 5000 or 5555: the real TrackScore may be running on this PC.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readTrackScore, TrackScoreError } from '../src/trackscore.js';

const fixture = (f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url)), 'utf8'));
const RACE = fixture('trackscore-race.json');
const SCHEDULE = fixture('trackscore-schedule.json');
const OLD = fixture('trackscore-schedule-nomeetid.json');

/** A guard every test read goes through: the live TrackScore's ports are never asked. */
function safeGet(opts, cb) {
  if (opts.port === 5000 || opts.port === 5555) throw new Error(`a test tried TrackScore's live port ${opts.port}`);
  return http.get(opts, cb);
}

/** TrackScore's web page, as far as Set up from TrackScore asks it: routes path -> [status, type, body] or a handler. */
async function fakeTrackScore(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const r = routes[req.url];
    if (typeof r === 'function') return r(req, res);
    const [status, type, body] = r ?? [404, 'application/json', { error: 'API route not found' }];
    res.writeHead(status, { 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const json = (body) => [200, 'application/json; charset=utf-8', body];
const read = (port, extra = {}) => readTrackScore({ host: '127.0.0.1', port, get: safeGet, ...extra });
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof TrackScoreError && e.status === status && re.test(e.message));

describe('readTrackScore', () => {
  const servers = [];
  after(() => Promise.all(servers.map((s) => s.close())));
  const serve = async (routes) => {
    const s = await fakeTrackScore(routes);
    servers.push(s);
    return s;
  };

  test('the live meet: /api/xc/race for the meet, then that meet\'s schedule; GETs only; the runners are dropped', async () => {
    const s = await serve({
      '/api/xc/race': json({ ...RACE, results: [{ bib: '1', name: 'A Runner' }], feed: [1], teamScores: [] }),
      '/api/xc/schedule?meetId=meet-fixture-1': json(SCHEDULE),
      '/api/xc/schedule': json(OLD),
      '/api/meets/meet-fixture-1': json({ id: 'meet-fixture-1', name: 'Fall Classic' }),
    });
    const r = await read(s.port);
    assert.deepEqual(s.seen, ['GET /api/xc/race', 'GET /api/xc/schedule?meetId=meet-fixture-1', 'GET /api/meets/meet-fixture-1']);
    assert.deepEqual([r.meetId, r.meetName], ['meet-fixture-1', 'Fall Classic']);
    assert.deepEqual(Object.keys(r.raceSnap), ['meetId', 'config']);
    assert.deepEqual(r.schedule.races.map((x) => x.name), ["Men's Race", "Women's Race"]);
    assert.equal(r.schedule.activeRaceId, 'xcr-1790270149269-55gs2l');
    assert.ok(!JSON.stringify(r).includes('A Runner'));
  });

  test('no meet on the live race: lynxEvent.lastScopeMeetId, never the meet-less list\'s races; no meet at all is said', async () => {
    const s = await serve({
      '/api/xc/race': json({ ...RACE, meetId: null }),
      '/api/xc/schedule': json(OLD),
      '/api/xc/schedule?meetId=meet-fixture-1': json(SCHEDULE),
    });
    const r = await read(s.port);
    assert.deepEqual(s.seen.slice(0, 3), ['GET /api/xc/race', 'GET /api/xc/schedule', 'GET /api/xc/schedule?meetId=meet-fixture-1']);
    assert.deepEqual(r.schedule.races.map((x) => x.splitPoints.length), [8, 7], 'the live meet, not the old one (3, 2, 0)');
    assert.equal(r.meetName, '', 'a TrackScore without /api/meets/<id>: no name');
    const t = await serve({ '/api/xc/race': json({ meetId: '' }), '/api/xc/schedule': json({ races: OLD.races, lynxEvent: { lastScopeMeetId: null } }) });
    await rejects(read(t.port), 502, /^TrackScore has no meet open\. Open the meet in TrackScore \(its XC page\), then try again\.$/);
  });

  test('a meet with no races in Race Setup', async () => {
    const s = await serve({ '/api/xc/race': json(RACE), '/api/xc/schedule?meetId=meet-fixture-1': json({ races: [], activeRaceId: null }) });
    await rejects(read(s.port), 502, /^TrackScore's meet has no races in Race Setup yet\. Add them there, then try again\.$/);
  });

  test('nothing listening, no answer, not TrackScore, too big', async () => {
    const gone = await fakeTrackScore({});
    await gone.close();
    await rejects(read(gone.port), 502, new RegExp(`^TrackScore is not answering at 127\\.0\\.0\\.1:${gone.port}\\. Is TrackScore running\\?`));
    const slow = await serve({ '/api/xc/race': () => {} });
    await rejects(read(slow.port, { timeoutMs: 200 }), 502, new RegExp(`^TrackScore at 127\\.0\\.0\\.1:${slow.port} did not answer within 1 seconds\\.$`));
    const NOT = /answered, but not as TrackScore's XC Race Setup\. Check "TrackScore web port" in Settings → Meet setup \(usually 5000\)\.$/;
    for (const r of [[200, 'text/html', '<html>Hello</html>'], [404, 'application/json', { error: 'API route not found' }], [200, 'application/json', '{"meetId": ']]) {
      const s = await serve({ '/api/xc/race': r });
      await rejects(read(s.port), 502, NOT);
    }
    const big = await serve({ '/api/xc/race': json({ ...RACE, pad: 'x'.repeat(5000) }) });
    await rejects(read(big.port, { maxBytes: 1024 }), 502, /^TrackScore's answer was too big \(more than 1 KB\)\.$/);
  });

  test('port 5555 and any port the guard names are refused before a socket is opened', async () => {
    const never = () => {
      throw new Error('a socket was opened');
    };
    await rejects(readTrackScore({ host: '127.0.0.1', port: 5555, get: never }), 400,
      /^Port 5555 is where TrackScore takes the splits, not its web page\. Set "TrackScore web port" in Settings → Meet setup \(usually 5000\)\.$/);
    await rejects(readTrackScore({ host: '127.0.0.1', port: 6400, get: never, refuse: (p) => (p === 6400 ? 'Port 6400 is where the output "Karmarush" sends its splits, not TrackScore\'s web page.' : null) }),
      400, /^Port 6400 is where the output "Karmarush" sends its splits/);
  });
});
