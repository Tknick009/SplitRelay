// The whole relay in one process, as on race day: RR12 (a TCP client) sends primary and backup reads out of order, the
// operator sets the gun through the panel API, and a stand-in for TrackScore XC's port 5555 receives the packets. The
// merged .lif comes out of the output folder when FinishLynx's file lands in its folder, and a restart carries on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/main.js';
import { parseLif } from '../src/lif.js';
import { decodeCp1252 } from '../src/cp1252.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const XCSCORE = path.join(FIXTURES, 'xcscore.lss');
const RACE = 'Girls Varsity 5K';

async function api(app, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${app.panelPort}${p}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (res.status !== 200 && method !== 'GET') throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return { status: res.status, headers: res.headers, text, json };
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for TrackScore's port 5555: a TCP server that never writes back and frames JSON objects by brace depth
 * (outside strings), decoding latin1, the way server/lynx-listener.ts does. Keeps each packet's raw text too.
 */
function fakeTrackScore() {
  const packets = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = '';
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    sock.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      for (const ch of text) {
        buf += ch;
        const i = buf.length - 1;
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === '}' && depth > 0) {
          depth--;
          if (depth === 0) {
            packets.push({ raw: buf.slice(start, i + 1), after: '' });
            buf = '';
          }
        } else if (depth === 0 && packets.length) {
          packets[packets.length - 1].after += ch; // what follows the object: the script's CRLF
          buf = '';
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  return {
    packets,
    listen: async (port = 0) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
              server.off('error', reject);
              resolve(server.address().port);
            });
          });
        } catch (err) {
          if (attempt > 40 || err.code !== 'EADDRINUSE') throw err;
          await sleep(50); // Windows may hold a just-closed port for a moment
        }
      }
    },
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

/** The exact packet XCScore.lss produces for a split (DESIGN.md section 1). */
function expected({ bib, place, l2g, cs, ls, first, last, team, gender }) {
  return '{"T":"T","D":{"EN":3,"R":1,"H":1,"S":"UNOFFICIAL","DS":"","DN":"Girls Varsity 5K","W":"",' +
    `"P":"${place}","L":"","BIB":"${bib}","N":"${last}","AF":"${team}","T":"","RT":"","L2G":"${l2g}",` +
    `"CS":"${cs}","LS":"${ls}","FN":"${first}","LN":"${last}","LICENCE":"${gender}"}}`;
}

const ADA = { bib: '101', first: 'Ada', last: 'Quill', team: 'Lakeside', gender: 'F' };
const BEA = { bib: '202', first: 'Bea', last: 'Marsh', team: 'Hilltop', gender: 'F' };
const CY = { bib: '303', first: 'Cy', last: 'Wren', team: 'Riverside', gender: 'F' };
const DEE = { bib: '404', first: 'Dee', last: 'Okafor', team: 'Lakeside', gender: 'F' };
const EVE = { bib: '505', first: 'Eve', last: 'Lund', team: 'Hilltop', gender: 'F' };

/** One RR12 line in the default format: SR|location|bib|time|contest|first|last|team|gender */
const line = (who, location, time, contest = RACE) => `SR|${location}|${who.bib}|${time}|${contest}|${who.first}|${who.last}|${who.team}|${who.gender === 'F' ? 'Female' : 'Male'}`;

function rr12(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => resolve(sock));
    sock.on('error', reject);
  });
}

test('RR12 in, TrackScore packets and a merged .lif out, through the panel API', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  const mergedDir = path.join(root, 'Merged');
  fs.mkdirSync(lynxDir);
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  t.after(async () => {
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ---- the panel itself
  const page = await api(app, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.text, /<script type="module" src="app\.js"><\/script>/);
  assert.equal((await api(app, 'GET', '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');

  // ---- set up through the API, as the panel does
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.3, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: true, inputDir: lynxDir, outputDir: mergedDir, fillPlaces: false } });
  let st = (await api(app, 'POST', '/api/races', {
    name: RACE, eventNumber: '3', round: '1', heat: '1', distance: '', active: true, contests: [RACE],
    splits: [{ name: '1K', sources: ['1K-A', '1K-B'] }, { name: '2K', sources: ['2K-A', '2K-B'] }],
    finishSources: ['FINISH'],
  })).json;
  const race = st.config.races[0];
  const [k1, k2] = race.splits;
  st = (await api(app, 'POST', '/api/outputs', {
    name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort, script: XCSCORE,
    stage: 'results', races: [race.id], eventNumber: 'race', precision: 3, mid: '',
  })).json;
  const output = st.config.outputs[0];
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore to be connected');

  // ---- RR12 connects and sends the first reads before the gun, out of time order, primary and backup mats
  const sock = await rr12(app.inputPort);
  const batchA = [
    line(CY, '2K-B', '10:07:01.001'),
    line(ADA, '1K-B', '10:03:20.250'), // backup mat, 0.25 s after the primary
    line(DEE, '1K-A', '10:05:00.000'), // the same mat again 90 s later: a repeat, not a new crossing
    line(ADA, '2K-A', '10:06:50.500'),
    line(BEA, '1K-B', '10:03:18.700'), // only the backup mat saw her
    'garbage that is not a read',
    line(ADA, 'FINISH', '10:10:00.000'),
    line(ADA, '1K-A', '10:03:20.000'),
    line(ADA, '3K-A', '10:08:00.000'), // no such split
    line(DEE, '1K-A', '10:03:30.000'),
    line({ ...EVE, bib: '999' }, '1K-A', '10:03:40.000', 'Boys Varsity 5K'), // a race we do not run
    line(ADA, '2K-B', '10:06:50.400'), // backup mat 0.1 s EARLIER than the primary
    'SR|HELLO|RR12 test',
    line(CY, '1K-A', '10:03:25.123'),
  ];
  sock.write(batchA.slice(0, 7).join('\r\n') + '\r\n');
  await sleep(30);
  sock.write(batchA.slice(7).join('\r\n') + '\r\n');
  st = await waitFor(async () => {
    const s = (await api(app, 'GET', '/api/state')).json;
    return s.feed.length >= 13 ? s : null;
  }, 'the first reads in the feed');
  const statusesA = st.feed.map((e) => e.status).sort();
  assert.deepEqual(statusesA, ['bad-line', 'no-race', 'unmapped', ...Array(10).fill('waiting-gun')].sort());
  const view = st.races[0];
  assert.equal(view.pending, 10);
  assert.deepEqual(view.unmapped, [{ name: '3K-A', count: 1 }]);
  assert.equal(ts.packets.length, 0, 'nothing is sent before the gun');

  // ---- the gun: waiting reads are processed in time order and the batch goes out in course order. The hold runs
  // from each read's first arrival, so once it is over for all of them they leave as one batch. Revision 2: ADA has
  // a FINISH read, so none of her splits go out live (TrackScore would overwrite her finish place); they still count
  // for the places of the others and are in the merged .lif.
  await sleep(500);
  st = (await api(app, 'POST', `/api/races/${race.id}/gun`, { gun: '10:00:00.000' })).json;
  assert.equal(st.races[0].gunText, '10:00:00.000');
  await waitFor(() => ts.packets.length >= 4, 'the first four packets');

  // ---- after the gun: a held crossing whose backup read is earlier, and an RR12 replay of a line
  sock.write([line(BEA, '2K-A', '10:06:55.000'), line(BEA, '2K-B', '10:06:54.800'), line(CY, '1K-A', '10:03:25.123')].join('\r\n') + '\r\n');
  await waitFor(() => ts.packets.length >= 6, 'the 2K packet and its place update');
  // ---- a backup read earlier than a crossing already sent, inside the 60 s window: corrected and re-sent
  sock.write(line(DEE, '1K-B', '10:03:29.500') + '\r\n');
  await waitFor(() => ts.packets.length >= 7, 'the correction');
  await sleep(500);

  const want = [
    expected({ ...BEA, place: 1, l2g: 2, cs: '3:18.700', ls: '3:18.700' }),
    expected({ ...CY, place: 3, l2g: 2, cs: '3:25.123', ls: '3:25.123' }),
    expected({ ...DEE, place: 4, l2g: 2, cs: '3:30.000', ls: '3:30.000' }),
    expected({ ...CY, place: 2, l2g: 1, cs: '7:01.001', ls: '3:35.878' }),
    expected({ ...BEA, place: 2, l2g: 1, cs: '6:54.800', ls: '3:36.100' }),
    expected({ ...CY, place: 3, l2g: 1, cs: '7:01.001', ls: '3:35.878' }), // place update
    expected({ ...DEE, place: 4, l2g: 2, cs: '3:29.500', ls: '3:29.500' }), // correction
  ];
  assert.deepEqual(ts.packets.map((p) => p.raw), want);
  for (const p of ts.packets) {
    assert.equal(p.after, '\r\n', 'each packet ends with the script\'s CRLF');
    const obj = JSON.parse(p.raw);
    assert.ok(Number.isInteger(Number(obj.D.P)) && Number(obj.D.P) >= 1, 'P is a place');
    assert.equal(obj.D.T, '', 'a split never carries a finish time');
    assert.ok(['1', '2'].includes(obj.D.L2G), 'L2G = N - k + 1, never 0');
  }

  // ---- what the operator sees. Revision 2: each row is updated in place, so no row still says 'Waiting for gun'; the
  // row of the read whose time went out says Sent, and the other mat's read is the backup.
  st = (await api(app, 'GET', '/api/state')).json;
  const count = (status) => st.feed.filter((e) => e.status === status).length;
  assert.deepEqual(
    { waiting: count('waiting-gun'), sent: count('sent'), backup: count('backup'), repeat: count('repeat'), duplicate: count('duplicate'),
      corrected: count('corrected'), finish: count('finish'), unmapped: count('unmapped'), noRace: count('no-race'), bad: count('bad-line'),
      held: count('held'), finishedNotSent: count('finished-not-sent') },
    { waiting: 0, sent: 4, backup: 4, repeat: 1, duplicate: 1, corrected: 1, finish: 1, unmapped: 1, noRace: 1, bad: 1, held: 0, finishedNotSent: 2 },
  );
  // DESIGN 9.16 F6: the reads above have made-up times of day (hours from this PC's clock). Reads that come 2 s after
  // their passing, as RR12's live reads do, give the offset: a low percentile, which a few far-off reads don't move.
  await sleep(1100);
  const hhmmss = (d) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':') + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const liveLines = [];
  for (let i = 0; i < 12; i++) liveLines.push(line({ ...EVE, bib: String(980 + i) }, '1K-A', hhmmss(new Date(Date.now() - 2000 - i * 20)), 'Boys Varsity 5K'));
  sock.write(liveLines.join('\r\n') + '\r\n');
  const lag = await waitFor(async () => {
    const s = (await api(app, 'GET', '/api/state')).json;
    return s.feed.filter((e) => Number(e.bib) >= 980 && Number(e.bib) < 992).length === 12 ? s.input.clockLagSec : null;
  }, 'the clock offset of live reads');
  assert.ok(lag >= 1.5 && lag <= 3, `how far RR12 is behind this PC: ${lag} s`);
  const byStatus = (status, bib) => st.feed.find((e) => e.status === status && e.bib === bib);
  assert.match(byStatus('repeat', '404').detail, /already crossed/);
  assert.match(byStatus('bad-line', '').detail, /garbage that is not a read/);
  assert.equal(byStatus('corrected', '404').place, 4);
  const rv = st.races[0];
  assert.deepEqual(rv.splits.map((s) => [s.id, s.crossings]), [[k1.id, 4], [k2.id, 3]]);
  assert.equal(rv.runners, 4);
  assert.equal(rv.finished, 1);
  assert.equal(rv.pending, 0);
  const os1 = st.outputs.find((o) => o.id === output.id);
  assert.equal(os1.sent, 7);
  assert.deepEqual([os1.behind, os1.lagSec], [0, 0]);
  assert.equal(rv.finishedNotSent, 2);
  assert.deepEqual(rv.stale, { count: 0, byOutput: [], reason: null, splitCountFrom: null, hint: null });
  assert.equal(os1.lastError, null);
  assert.equal(st.input.connections.length, 1);
  const crossings = (await api(app, 'GET', `/api/races/${race.id}/crossings`)).json;
  assert.deepEqual(crossings.map((c) => [c.splitName, c.bib, c.place]),
    [['1K', '202', 1], ['1K', '101', 2], ['1K', '303', 3], ['1K', '404', 4], ['2K', '101', 1], ['2K', '202', 2], ['2K', '303', 3]]);

  // ---- merged .lif: FinishLynx writes its file (finish times only) and the merged one appears in the output folder
  const lynxText = [
    '3,1,1,Girls Varsity 5K,,,,,,,10:00:00.0000',
    '1,101,,Quill,Ada,Lakeside,10:00.000,F,10:00.00,,10:00.000 (10:00.000),10:00:00.000,,,,10:00.00,10:00.00,,10:00.00',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(lynxDir, '003-1-01.lif'), lynxText);
  fs.copyFileSync(path.join(FIXTURES, 'lif', '011-1-01.lif'), path.join(lynxDir, '011-1-01.lif'));
  const mergedFile = path.join(mergedDir, '003-1-01.lif');
  const merged = await waitFor(() => {
    try {
      const text = decodeCp1252(fs.readFileSync(mergedFile));
      return text.includes('10:00.000 (3:09.600)') ? text : null;
    } catch {
      return null;
    }
  }, 'the merged .lif');
  const lif = parseLif(merged);
  assert.equal(lif.header.line, '3,1,1,Girls Varsity 5K,,,,,,,10:00:00.0000', 'the FinishLynx header is kept verbatim');
  const ada = lif.rows.find((r) => r.bib === '101');
  assert.equal(ada.fields[10], '3:20.000 (3:20.000),6:50.400 (3:30.400),10:00.000 (3:09.600)');
  assert.equal(ada.fields[18], '3:20.00');
  const bea = lif.rows.find((r) => r.bib === '202');
  assert.ok(bea, 'a runner with splits but no FinishLynx row yet gets a row');
  assert.equal(bea.fields[10], '3:18.700 (3:18.700),6:54.800 (3:36.100)');
  assert.ok(merged.endsWith('\r\n'));
  await waitFor(() => fs.existsSync(path.join(mergedDir, '011-1-01.lif')), 'the copy of the other event');
  assert.deepEqual(fs.readFileSync(path.join(mergedDir, '011-1-01.lif')), fs.readFileSync(path.join(FIXTURES, 'lif', '011-1-01.lif')), 'copied byte for byte');
  st = (await api(app, 'GET', '/api/state')).json;
  assert.equal(st.races[0].lynxStart, 360_000_000, 'RaceView.lynxStart comes from the FinishLynx header');
  assert.equal(st.lif.state, 'ok');
  assert.deepEqual(fs.readdirSync(lynxDir).sort(), ['003-1-01.lif', '011-1-01.lif'], 'nothing is ever written into the FinishLynx folder');

  // ---- the daily log has every received line and every packet sent
  sock.destroy();
  await app.stop();
  const logs = fs.readdirSync(path.join(dataDir, 'logs'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\d{4}-\d{2}-\d{2}\.log$/);
  const log = fs.readFileSync(path.join(dataDir, 'logs', logs[0]), 'utf8');
  assert.match(log, /\d\d:\d\d:\d\d\.\d{3} \[in #\d+ 127\.0\.0\.1:\d+\] SR\|1K-B\|202\|10:03:18\.700/);
  assert.match(log, /\[in #\d+ [^\]]+\] garbage that is not a read/);
  assert.equal((log.match(/\[out TrackScore\] \{"T":"T"/g) ?? []).length, 7);
  assert.match(log, /\[read\] corrected bib 404 1K \(1K-B\)/);
  assert.ok(fs.existsSync(path.join(dataDir, 'races', `${race.id}.json`)), 'the race is saved');
  // A clean stop says so last in the journal, after the outputs were closed; without it the next start would send the
  // outputs' last minute again (as after a kill).
  const journal = fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(journal.at(-1)).t, 'stop');

  // ---- a restart carries on: nothing already sent goes out again, and places continue
  const before = ts.packets.length;
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore to be connected again');
  st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.races[0].splits.map((s) => s.crossings), [4, 3]);
  assert.equal(st.races[0].gunText, '10:00:00.000');
  await sleep(400);
  assert.equal(ts.packets.length, before, 'no re-sends after a restart');
  const sock2 = await rr12(app.inputPort);
  sock2.end(line(EVE, '1K-A', '10:03:45.000') + '\r\n');
  await waitFor(() => ts.packets.length > before, 'the first packet after the restart');
  assert.equal(ts.packets.at(-1).raw, expected({ ...EVE, place: 5, l2g: 2, cs: '3:45.000', ls: '3:45.000' }));
});

test('splits TrackScore missed while unreachable reach it after a restart; finishers and resend are safe', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  fs.mkdirSync(lynxDir);
  let ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let sock = null;
  t.after(async () => {
    sock?.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: false, inputDir: lynxDir, outputDir: '', fillPlaces: false } });
  let st = (await api(app, 'POST', '/api/races', {
    name: RACE, eventNumber: '3', round: '1', heat: '1', active: true, contests: [RACE], gun: '10:00:00.000',
    splits: [{ name: '1K', sources: ['1K-A', '1K-B'] }, { name: '2K', sources: ['2K-A', '2K-B'] }], finishSources: [],
  })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', {
    name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort, script: XCSCORE,
    stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '',
  });
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore to be connected');

  // FinishLynx has already finished CY: her split must never reach TrackScore, where it would overwrite her place
  fs.writeFileSync(path.join(lynxDir, '003-1-01.lif'), [
    '3,1,1,Girls Varsity 5K,,,,,,,10:00:00.0000',
    '1,303,,Wren,Cy,Riverside,8:00.000,F,,,"8:00.000 (8:00.000)",10:00:00.000,,,,,,,8:00.00',
    '',
  ].join('\r\n'));
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.races[0].finished === 1, 'the FinishLynx finisher');

  sock = await rr12(app.inputPort);
  const noGender = `SR|1K-A|${BEA.bib}|10:03:21.000|${RACE}|${BEA.first}|${BEA.last}|${BEA.team}|`;
  sock.write([line(ADA, '1K-A', '10:03:20.000'), noGender, line(CY, '1K-A', '10:03:19.000')].join('\r\n') + '\r\n');
  await waitFor(() => ts.packets.length >= 2, 'two packets');
  await sleep(300);
  assert.deepEqual(ts.packets.map((p) => JSON.parse(p.raw).D.BIB), ['101', '202'], 'none for the FinishLynx finisher');
  assert.deepEqual(ts.packets.map((p) => JSON.parse(p.raw).D.P), ['2', '3'], 'but she still counts for the places');
  // RR12 sent no gender for BEA: the packet leaves LICENCE out, so TrackScore keeps the gender FinishLynx gave her
  assert.equal('LICENCE' in JSON.parse(ts.packets[1].raw).D, false);

  // ---- TrackScore unreachable (it stays running elsewhere, the network dropped); two more runners pass
  await ts.close();
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0].state === 'connecting', 'the drop');
  sock.write([line(DEE, '1K-A', '10:03:30.000'), line(EVE, '1K-A', '10:03:31.000')].join('\r\n') + '\r\n');
  st = await waitFor(async () => {
    const s = (await api(app, 'GET', '/api/state')).json;
    return s.outputs[0].behind === 2 ? s : null;
  }, 'two packets behind');
  assert.ok(st.outputs[0].queued === 2);
  const lines = [];
  app.on('line', (l) => lines.push(l));
  sock.destroy();
  sock = null;
  await app.stop();
  assert.ok(lines.some((l) => /\[out TrackScore\] 2 splits were not delivered yet\. They are sent when Split Relay starts again/.test(l)), lines.join('\n'));

  // ---- TrackScore back, Split Relay started again: the two it missed arrive, nothing else is repeated
  ts = fakeTrackScore();
  await ts.listen(tsPort);
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await waitFor(() => ts.packets.length >= 2, 'the missed packets');
  await sleep(400);
  assert.deepEqual(ts.packets.map((p) => [JSON.parse(p.raw).D.BIB, JSON.parse(p.raw).D.P]), [['404', '4'], ['505', '5']]);

  // ---- Resend: finished runners are skipped; a race that is not active is refused (409) unless forced
  const r = app.resendRace(race.id, {});
  assert.deepEqual(r, { sent: 4, skippedFinished: 1, outputs: 1 });
  await api(app, 'PUT', `/api/races/${race.id}`, { active: false });
  assert.throws(() => app.resendRace(race.id, {}), (err) => err.status === 409 && /not active/.test(err.message));
  assert.deepEqual(app.resendRace(race.id, { force: true }), { sent: 4, skippedFinished: 1, outputs: 1 });
});

test('an RR12 Replay of a whole meet in one burst: the relay stays responsive and a live split is not held up', { timeout: 120_000 }, async (t) => {
  const { monitorEventLoopDelay } = await import('node:perf_hooks');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let sock = null;
  t.after(async () => {
    sock?.destroy();
    await app.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.5 } });
  await api(app, 'POST', '/api/races', { inputPort: null, name: 'Boys 5K', eventNumber: '1', contests: ['Boys'], gun: '10:00:00.000',
    splits: [{ name: '1 Mile', sources: ['S1-A', 'S1-B'] }, { name: '2 Mile', sources: ['S2-A'] }] });
  await api(app, 'POST', '/api/races', { inputPort: null, name: 'Old race', eventNumber: '9', contests: ['Old'], gun: '08:00:00.000',
    splits: [{ name: '1K', sources: ['X1'] }], active: false });
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', host: '127.0.0.1', port: tsPort, script: XCSCORE, races: [] });
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tod = (ms) => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
  const history = [];
  for (let i = 0; i < 1000; i++) history.push(`SR|S1-A|${1000 + i}|${tod(36300000 + i * 100)}|Boys|F|L|T|M`);
  for (let i = 0; history.length < 20_000; i++) history.push(`SR|X1|${5000 + (i % 2000)}|${tod(29000000 + i * 37)}|Old|F|L|T|F`);
  sock = await rr12(app.inputPort);
  sock.write(history.slice(0, 1000).join('\r\n') + '\r\n');
  await waitFor(() => ts.packets.length === 1000, 'the 1 Mile splits');

  // a control panel watching the live stream
  let feedEvents = 0;
  const http = await import('node:http');
  const sse = http.get({ host: '127.0.0.1', port: app.panelPort, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => { feedEvents += (c.match(/event: feed/g) ?? []).length; });
    res.on('error', () => {});
  });
  sse.on('error', () => {});
  t.after(() => sse.destroy());
  await sleep(300);
  feedEvents = 0;

  // RR12 Replay: the whole history again (1,000 duplicates, 19,000 reads of another race) and one live 2 Mile read
  // right behind it on the same connection.
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const sentAt = Date.now();
  sock.write(history.join('\r\n') + '\r\n' + `SR|S2-A|1000|${tod(36700000)}|Boys|F|L|T|M\r\n`);
  const pings = [];
  const live = waitFor(() => ts.packets.find((p) => JSON.parse(p.raw).D.L2G === '1'), 'the live 2 Mile split', 30_000);
  while (pings.length < 5) {
    const t0 = Date.now();
    await api(app, 'GET', '/api/state');
    pings.push(Date.now() - t0);
  }
  await live;
  const latency = Date.now() - sentAt;
  h.disable();
  const stallMs = h.max / 1e6;
  await sleep(500);
  t.diagnostic(`live split after ${latency} ms, longest stall ${Math.round(stallMs)} ms, panel ${pings.join('/')} ms, ${feedEvents} feed events`);
  assert.ok(latency < 500 + 1500, `the live split went out ${latency} ms after it was sent (hold 500 ms)`);
  // the panel keeps 600 rows: a flood is sent in batches of the newest ones, not as 20,000 events
  assert.ok(feedEvents > 0 && feedEvents < 6000, `${feedEvents} feed events for 20,001 reads`);
  assert.ok(stallMs < 500, `the event loop stalled ${Math.round(stallMs)} ms`);
  assert.ok(Math.max(...pings) < 1500, `the panel answered in ${pings.join(', ')} ms`);
  // every read is in the journal once; the duplicates are not
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.input.totalLines === 21_001, 'every line');
  const reads = fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"t":"read"'));
  assert.equal(reads.length, 1000 + 19_000 + 1);
  assert.equal(ts.packets.length, 1001, 'only the live split was sent');
  const st = (await api(app, 'GET', '/api/state')).json;
  // revision 6 (C1): the old race is not Active, so its contest's reads wait for it in no race, not inside it
  assert.equal(st.races.find((r) => r.name === 'Old race').runners, 0);
  assert.deepEqual(st.noRace.map((n) => [n.contest, n.status, n.count]), [['Old', 'paused', 19_000]]);
});

test('revision 5 through the app: a deleted race\'s reads are out of use, its contest\'s new reads set aside, also after a restart', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let sock = null;
  t.after(async () => {
    sock?.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2 } });
  const splits = [{ name: '1K', sources: ['Q1'] }, { name: '2K', sources: ['Q2'] }];
  let st = (await api(app, 'POST', '/api/races', { inputPort: null, name: 'Open', eventNumber: '31', contests: [], splits, gun: '11:00:00.000' })).json;
  const open = st.config.races.at(-1).id;
  st = (await api(app, 'POST', '/api/races', { inputPort: null, name: 'Girls JV', eventNumber: '32', contests: ['Girls JV'], splits, gun: '11:00:00.000' })).json;
  const girls = st.config.races.at(-1).id;
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', host: '127.0.0.1', port: tsPort, script: XCSCORE, races: [open] });
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore');
  const L = (bib, s, contest) => `SR|Q1|${bib}|11:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.000|${contest}|F${bib}|L${bib}|Team|${contest === 'Boys JV' ? 'M' : 'F'}`;
  sock = await rr12(app.inputPort);
  sock.write([L(601, 300, 'Girls JV'), L(602, 301, 'Girls JV'), L(701, 305, 'Boys JV'), L(702, 306, 'Boys JV')].join('\r\n') + '\r\n');
  await waitFor(() => ts.packets.length === 2, 'the two boys');
  await api(app, 'DELETE', `/api/races/${girls}`);
  sock.write(L(603, 302, 'Girls JV') + '\r\n'); // a straggler of the deleted race
  sock.write(L(703, 307, 'Boys JV') + '\r\n');
  await waitFor(() => ts.packets.length === 3, 'the third boy');
  const place = (p) => JSON.parse(p.raw).D.P;
  assert.deepEqual(ts.packets.map((p) => [JSON.parse(p.raw).D.BIB, place(p)]), [['701', '1'], ['702', '2'], ['703', '3']], 'no girl in the Open race');
  st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.setAside.map((a) => [a.contest, a.reason, a.raceName, a.count]), [['Girls JV', "its race 'Girls JV' was deleted", 'Girls JV', 1]]);
  const gone = st.feed.find((e) => e.bib === '601');
  assert.deepEqual([gone.status, gone.raceId, gone.detail], ['race-deleted', null, "Its race 'Girls JV' was deleted, so this read is not used."]);
  const row = st.feed.find((e) => e.bib === '603');
  assert.deepEqual([row.status, row.raceId, row.detail], ['set-aside', null,
    "Reads of 'Girls JV' are not used: its race 'Girls JV' was deleted. List the contest on an Active race to use them."]);
  sock.destroy();
  sock = null;
  await app.stop();
  const log = fs.readFileSync(path.join(dataDir, 'logs', fs.readdirSync(path.join(dataDir, 'logs'))[0]), 'utf8');
  assert.match(log, /reads of contest "Girls JV" are set aside \(not used\): its race 'Girls JV' was deleted/);

  // a restart remembers it; listing the contest on a race again uses the set-aside read, not the deleted race's own
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.setAside.map((a) => [a.contest, a.count]), [['Girls JV', 1]]);
  st = (await api(app, 'POST', '/api/races', { inputPort: null, name: 'Girls JV', eventNumber: '32', contests: ['Girls JV'], splits, gun: '11:00:00.000' })).json;
  const again = st.config.races.at(-1).id;
  assert.deepEqual(st.setAside, []);
  const cr = (await api(app, 'GET', `/api/races/${again}/crossings`)).json;
  assert.deepEqual(cr.map((c) => `${c.bib}:${c.place}`), ['603:1']);
});

test('revision 6 through the app: config.json damaged, the copy from the last start used: a race added since is missing, not deleted, and comes back', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let sock = null;
  t.after(async () => {
    sock?.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const splits = [{ name: '1K', sources: ['Q1'] }];
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2 } });
  await api(app, 'POST', '/api/races', { inputPort: null, name: 'Girls JV', eventNumber: '41', contests: ['Girls JV'], splits, gun: '11:00:00.000' });
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', host: '127.0.0.1', port: tsPort, script: XCSCORE, races: [] });
  await app.stop();
  // the next start keeps that config as config.json.bak; Boys JV is added after it
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let st = (await api(app, 'POST', '/api/races', { inputPort: null, name: 'Boys JV', eventNumber: '42', contests: ['Boys JV'], splits, gun: '11:00:00.000' })).json;
  const boys = st.config.races.find((r) => r.name === 'Boys JV').id;
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.outputs[0]?.state === 'connected', 'TrackScore');
  const L = (bib, s, contest) => `SR|Q1|${bib}|11:05:${String(s).padStart(2, '0')}.000|${contest}|F${bib}|L${bib}|Team|`;
  sock = await rr12(app.inputPort);
  sock.write([L(601, 1, 'Girls JV'), L(701, 2, 'Boys JV'), L(702, 3, 'Boys JV')].join('\r\n') + '\r\n');
  await waitFor(() => ts.packets.length === 3, 'three splits');
  sock.destroy();
  sock = null;
  await app.stop();
  const journal = () => fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lines = journal().length;

  // config.json is damaged: Split Relay starts with config.json.bak, which does not have Boys JV
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{ "races": [ {');
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.config.races.map((r) => r.name), ['Girls JV']);
  assert.deepEqual(st.missingRaces.map((m) => [m.raceId, m.raceName, m.count, m.file]), [[boys, 'Boys JV', 2, `races\\${boys}.json`]]);
  assert.deepEqual(st.setAside, []);
  assert.ok(fs.existsSync(path.join(dataDir, 'races', `${boys}.json`)), 'its race file is kept, with its settings');
  sock = await rr12(app.inputPort);
  sock.write(L(703, 4, 'Boys JV') + '\r\n'); // a straggler: it waits for Boys JV too
  await waitFor(async () => (await api(app, 'GET', '/api/state')).json.feed.some((e) => e.bib === '703'), 'the straggler');
  st = (await api(app, 'GET', '/api/state')).json;
  const row = st.feed.find((e) => e.bib === '703');
  assert.deepEqual([row.status, row.raceId, row.raceName, row.detail], ['race-missing', null, 'Boys JV',
    "Its race 'Boys JV' isn't in the settings (config.json was restored or edited). They come back if the race does."]);
  assert.deepEqual(st.noRace.map((n) => [n.contest, n.status, n.count]), [['Boys JV', 'race-missing', 3]]);
  assert.equal(ts.packets.length, 3, 'nothing sent for it');
  sock.destroy();
  sock = null;
  await app.stop();
  assert.ok(!journal().slice(lines).some((r) => ['delete', 'aside', 'unaside'].includes(r.t)), 'the start journaled no delete and no set-aside');

  // the operator puts the race back into config.json from its race file, as the warning says, and starts again
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'races', `${boys}.json`), 'utf8')).race;
  assert.equal(saved.name, 'Boys JV');
  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  cfg.races.push(saved);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.missingRaces, []);
  const cr = (await api(app, 'GET', `/api/races/${boys}/crossings`)).json;
  assert.deepEqual(cr.map((c) => `${c.bib}:${c.place}`), ['701:1', '702:2', '703:3']);
  await waitFor(() => ts.packets.length === 4, 'the straggler sent');
  await sleep(500);
  assert.deepEqual(ts.packets.slice(3).map((p) => [JSON.parse(p.raw).D.BIB, JSON.parse(p.raw).D.P]), [['703', '3']], 'only what TrackScore did not have');
});

test('revision 6 through the app: a race taken out of config.json by hand is missing; deleting it in the panel lets its reads go', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let sock = null;
  t.after(async () => {
    sock?.destroy();
    await app?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const splits = [{ name: '1K', sources: ['Q1'] }];
  const st0 = (await api(app, 'POST', '/api/races', { inputPort: null, name: 'Masters', eventNumber: '51', contests: ['Masters'], splits, gun: '11:00:00.000' })).json;
  const id = st0.config.races[0].id;
  sock = await rr12(app.inputPort);
  sock.write('SR|Q1|901|11:05:01.000|Masters|F|L|T|\r\nSR|Q1|902|11:05:02.000|Masters|F|L|T|\r\n');
  await waitFor(async () => (await api(app, 'GET', `/api/races/${id}/crossings`)).json.length === 2, 'two crossings');
  sock.destroy();
  sock = null;
  await app.stop();
  const file = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.races = [];
  fs.writeFileSync(file, JSON.stringify(cfg)); // edited by hand while Split Relay was stopped
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let st = (await api(app, 'GET', '/api/state')).json;
  assert.deepEqual(st.missingRaces.map((m) => [m.raceId, m.raceName, m.count]), [[id, 'Masters', 2]]);
  // what the delete would do, and the delete itself, for a race that is not in the settings
  const plan = (await api(app, 'POST', '/api/races/preview', { id, delete: true })).json;
  assert.deepEqual(plan.deleted.map((d) => [d.raceId, d.raceName, d.count]), [[id, 'Masters', 2]]);
  assert.deepEqual(plan.setAside.map((a) => [a.contest, a.reason]), [['Masters', "its race 'Masters' was deleted"]]);
  await assert.rejects(() => api(app, 'POST', '/api/races/preview', { id: 'r_nope', delete: true }), /-> 404/);
  await assert.rejects(() => api(app, 'DELETE', '/api/races/r_nope'), /-> 404/);
  assert.equal((await api(app, 'GET', '/api/state')).json.missingRaces.length, 1, 'a preview changes nothing');
  st = (await api(app, 'DELETE', `/api/races/${id}`)).json;
  assert.deepEqual(st.missingRaces, []);
  assert.deepEqual(st.setAside.map((a) => [a.contest, a.count]), [['Masters', 0]]);
  assert.ok(st.feed.length === 0 || st.feed.every((e) => e.status !== 'race-missing'));
  await app.stop();
  app = null;
  const recs = fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(recs.filter((r) => r.t === 'delete').map((r) => [r.raceId, r.raceName]), [[id, 'Masters']]);
  assert.ok(!fs.existsSync(path.join(dataDir, 'races', `${id}.json`)), 'its race file went to races\deleted');
  assert.ok(fs.readdirSync(path.join(dataDir, 'races', 'deleted')).some((n) => n.startsWith(id)));
});

test('revision 7 through the app: FinishLynx LapTime lines on two ports, laps to go by split count; V1, V2 "Put it back" and V5 across restarts', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  /** RR12's FinishLynx exporter: "<SOH>S,<time>,<bib>" + CRLF, to the listener of a configured input port. */
  const send = async (port, lines) => {
    const sock = await rr12(app.inputPortOf(port));
    socks.push(sock);
    sock.write(lines.map(([tod, bib]) => `\x01S,${tod},${bib}\r\n`).join(''));
  };
  const D = (p) => JSON.parse(p.raw).D;
  const lapSplits = (n) => Array.from({ length: n }, (_, i) => ({ name: `Split ${i + 1}`, sources: [] }));

  // ---- start 1: two overlapping races, each with its own RR12 exporter and port
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 }, input: { ports: [5565, 5566] } });
  let st = (await api(app, 'POST', '/api/races', { name: 'Girls 5K', eventNumber: '3', gun: '10:00:00.000', splits: lapSplits(2) })).json;
  const girls = st.config.races.find((r) => r.name === 'Girls 5K').id;
  st = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '4', gun: '10:00:00.000', splits: lapSplits(3), inputPort: 5566 })).json;
  const boys = st.config.races.find((r) => r.name === 'Boys 5K').id;
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', host: '127.0.0.1', port: tsPort, script: XCSCORE, races: [] });
  await waitFor(async () => (await state()).outputs[0]?.state === 'connected', 'TrackScore');
  await send(5565, [['10:03:00.400', 101], ['10:03:00.100', 101]]); // the B mat's read first, the A mat's after it
  await send(5566, [['10:04:00.000', 201]]);
  await waitFor(() => ts.packets.length === 2, 'two splits');
  await sleep(400);
  const first = ts.packets.map(D).sort((a, b) => a.BIB.localeCompare(b.BIB));
  assert.deepEqual(first.map((d) => [d.BIB, d.DN, d.L2G, d.CS, d.T]), [['101', 'Girls 5K', '2', '3:00.100', ''], ['201', 'Boys 5K', '3', '4:00.000', '']],
    'laps to go = number of splits - split index; never 0; no finish time');
  st = await state();
  assert.deepEqual(st.inputs.map((i) => [i.port, i.format]), [[5565, 'laptime'], [5566, 'laptime']]);
  assert.equal(st.namesNeeded, true);
  await app.stop();

  // ---- start 2: config.json.bak now has both races. A third race on a third port comes, and Boys 5K is deleted.
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await api(app, 'PUT', '/api/settings', { input: { ports: [5565, 5566, 5567] } });
  st = (await api(app, 'POST', '/api/races', { name: 'Late 3K', eventNumber: '5', gun: '10:00:00.000', splits: lapSplits(1), inputPort: 5567 })).json;
  const late = st.config.races.find((r) => r.name === 'Late 3K').id;
  await send(5567, [['10:05:00.000', 301]]);
  await waitFor(() => ts.packets.length === 3, 'the Late 3K split');
  assert.equal(D(ts.packets[2]).L2G, '1', 'a race of one split: laps to go 1');
  await api(app, 'DELETE', `/api/races/${boys}`);
  await app.stop();
  const bak = fs.readFileSync(path.join(dataDir, 'config.json.bak'), 'utf8');

  // ---- start 3: config.json is damaged; the copy from start 2 is used. Late 3K is missing, Boys 5K deleted but back.
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{ "races": [ broken by a bad edit');
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  st = await state();
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json.bak'), 'utf8'), bak, 'V2: the start that fell back to config.json.bak left it alone');
  assert.equal(st.configRecovery.fellBack, true);
  assert.match(st.configRecovery.brokenFile, /^config\.broken-[\d-]+\.json$/);
  assert.deepEqual(st.configRecovery.brokenFiles, [st.configRecovery.brokenFile]);
  assert.deepEqual(st.config.races.map((r) => r.name), ['Girls 5K', 'Boys 5K']);
  // inputPort: the port its race file keeps, so "Put it back" can say beforehand whether it comes back Active
  assert.deepEqual(st.missingRaces.map((m) => [m.raceId, m.raceName, m.count, m.hasSettings, m.file, m.inputPort]), [[late, 'Late 3K', 1, true, `races\\${late}.json`, 5567]]);
  assert.deepEqual(st.missingRaces[0].contests.map((c) => [c.contest, c.via, c.port]), [['Port 5567', 'port', 5567]]);
  // V5: Boys 5K was deleted; its old read stays out of use, the panel warns in red
  assert.deepEqual(st.deletedBack.map((d) => [d.raceId, d.raceName, d.count]), [[boys, 'Boys 5K', 1]]);
  assert.match(st.deletedBack[0].text, /^'Boys 5K' was deleted at \d\d:\d\d:\d\d, but it is back in the settings \(config\.json was put back from its backup, or edited\)\. The reads it had when it was deleted stay out of use; new reads count in it\./);
  assert.deepEqual((await api(app, 'GET', `/api/races/${boys}/crossings`)).json, []);
  // V2 "Put it back": from its race file; its port is not an RR12 input port in these settings, so not Active yet
  let r = await api(app, 'POST', `/api/races/${late}/restore`);
  assert.deepEqual(r.json.restored, { raceId: late, raceName: 'Late 3K', active: false, renamedFrom: null, why: 'its port 5567 is not an RR12 input port any more' });
  assert.deepEqual(r.json.missingRaces, []);
  await api(app, 'PUT', '/api/settings', { input: { ports: [5565, 5566, 5567] } });
  r = await api(app, 'POST', `/api/races/${late}/activate`);
  assert.deepEqual(r.json.unticked, []);
  assert.deepEqual((await api(app, 'GET', `/api/races/${late}/crossings`)).json.map((c) => [c.bib, c.splitName]), [['301', 'Split 1']],
    'its read is in it again');
  await sleep(500);
  assert.equal(ts.packets.length, 3, 'TrackScore had it already: nothing is sent twice');
  // V5: saving the race keeps it, and the warning goes
  st = (await api(app, 'PUT', `/api/races/${boys}`, { name: 'Boys 5K' })).json;
  assert.deepEqual(st.deletedBack, []);
  await app.stop();

  // ---- start 4: config.json edited by hand: Boys 5K on Girls 5K's port, both Active (V1)
  const cfgFile = path.join(dataDir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  Object.assign(cfg.races.find((x) => x.id === boys), { inputPort: 5565, active: true });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  st = await state();
  assert.deepEqual(st.config.races.map((x) => [x.name, x.active]), [['Girls 5K', true], ['Boys 5K', false], ['Late 3K', true]]);
  assert.deepEqual(st.startConflicts.map((c) => [c.raceName, c.keptName, c.why]), [['Boys 5K', 'Girls 5K', 'both take port 5565']]);
  assert.match(st.startConflicts[0].text, /^'Boys 5K' was switched off when Split Relay started: it and 'Girls 5K' both take port 5565, and only one Active race can take those reads\./);
  await waitFor(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')).races.find((x) => x.id === boys).active === false, 'the unticked race saved');
  // a LapTime read on 5565 goes to Girls 5K only: the reads are never split between the two
  await send(5565, [['10:06:00.000', 102]]);
  await waitFor(async () => (await state()).feed.some((e) => e.bib === '102'), 'the read');
  assert.equal((await state()).feed.find((e) => e.bib === '102').raceName, 'Girls 5K');
  // "Switch to Boys 5K": the warning goes, Girls 5K is switched off and keeps its reads
  r = await api(app, 'POST', `/api/races/${boys}/activate`);
  assert.deepEqual(r.json.unticked.map((u) => [u.raceName, u.why]), [['Girls 5K', 'both take port 5565']]);
  assert.deepEqual(r.json.startConflicts, []);
  assert.deepEqual((await api(app, 'GET', `/api/races/${girls}/crossings`)).json.map((c) => c.bib), ['101', '102']);
});

test('review tools through the app (9.17): a paused split goes out when played; a finisher\'s made-up split carries the finish place to TrackScore and is in the merged .lif', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  const mergedDir = path.join(root, 'Merged');
  fs.mkdirSync(lynxDir);
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: true, inputDir: lynxDir, outputDir: mergedDir, fillPlaces: false } });
  let st = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '5', gun: '10:00:00.000', inputPort: 5565,
    splits: [{ name: '1K', sources: [] }, { name: '2K', sources: [] }] })).json;
  const race = st.config.races[0];
  const [k1, k2] = race.splits.map((s) => s.id);
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await waitFor(async () => (await state()).outputs[0]?.state === 'connected', 'TrackScore to be connected');

  // ---- 1K paused: the passes are kept and shown, nothing goes out; played: all of them do
  st = (await api(app, 'POST', `/api/races/${race.id}/splits/${k1}/sending`, { on: false })).json;
  assert.equal(st.races[0].splits[0].sending, false);
  await send(Array.from({ length: 8 }, (_, i) => [180 + 5 * i, 901 + i]));
  st = await waitFor(async () => {
    const s = await state();
    return s.races[0].splits[0].held === 8 ? s : null;
  }, 'eight held 1K splits');
  await sleep(500);
  assert.equal(ts.packets.length, 0, 'a paused split sends nothing');
  assert.equal(st.feed.find((e) => e.bib === '901').status, 'split-paused');
  await api(app, 'POST', `/api/races/${race.id}/splits/${k1}/sending`, { on: true });
  await waitFor(() => ts.packets.length === 8, 'the eight 1K splits, once played');
  assert.deepEqual(ts.packets.map((p) => JSON.parse(p.raw).D.L2G), Array(8).fill('2'));

  // ---- 2K: bib 905 is missed by the mats; then FinishLynx finishes everybody (905 in 5th)
  await send(Array.from({ length: 8 }, (_, i) => [360 + 10 * i, 901 + i]).filter(([, bib]) => bib !== 905));
  await waitFor(() => ts.packets.length === 15, 'seven 2K splits');
  const rows = Array.from({ length: 8 }, (_, i) => `${i + 1},${901 + i},,Runner,R${i + 1},Team,${9 + i}:00.000,M,,,"${9 + i}:00.000 (${9 + i}:00.000)",10:00:00.000,,,,,,,${9 + i}:00.00`);
  fs.writeFileSync(path.join(lynxDir, '005-1-01.lif'), ['5,1,1,Boys 5K,,,,,,,10:00:00.0000', ...rows, ''].join('\r\n'));
  const miss = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return r.missing.find((m) => m.bib === '905' && m.finishPlace === 5) ?? null;
  }, "905's missing 2K, with its finish place");
  assert.deepEqual([miss.splitId, miss.finished, miss.sendable, miss.next.kind], [k2, true, true, 'finish']);

  // ---- the operator sends the estimate: TrackScore gets it with P = 5, the finish place, so it keeps it
  const r = (await api(app, 'POST', `/api/races/${race.id}/manual`, { bib: '905', splitId: k2 })).json;
  assert.deepEqual([r.added[0].source, r.added[0].withFinishPlace, r.added[0].place], ['made-up', true, 5]);
  await waitFor(() => ts.packets.length === 16, 'the made-up split');
  const d = JSON.parse(ts.packets[15].raw).D;
  assert.deepEqual([d.BIB, d.P, d.L2G, d.T], ['905', '5', '1', '']);
  assert.equal(d.CS, miss.estimateText);
  // ...and it is in the merged .lif, between its 1K and its finish
  const merged = await waitFor(() => {
    const f = path.join(mergedDir, '005-1-01.lif');
    if (!fs.existsSync(f)) return null;
    const row = parseLif(decodeCp1252(fs.readFileSync(f))).rows.find((x) => x.bib === '905');
    return row && row.fields[10].includes(miss.estimateText) ? row : null;
  }, 'the merged row of 905 with its made-up 2K');
  assert.ok(merged.fields[10].startsWith(`3:20.000 (3:20.000),${miss.estimateText} (`), merged.fields[10]);
  // a restart: nothing sent again, the made-up time still there
  await app.stop();
  const before = ts.packets.length;
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await sleep(1000);
  assert.equal(ts.packets.length, before);
  assert.deepEqual((await api(app, 'GET', `/api/races/${race.id}/runners/905`)).json.columns.map((c) => c.source), ['read', 'made-up']);
});

test('revision 10 through the app (R4): Play reads FinishLynx\'s folder first ("Playing…"); runners who just finished keep their finish place', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  const mergedDir = path.join(root, 'Merged');
  fs.mkdirSync(lynxDir);
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: true, inputDir: lynxDir, outputDir: mergedDir, fillPlaces: false } });
  const st0 = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '5', gun: '10:00:00.000', inputPort: 5565,
    splits: [{ name: '1K', sources: [] }, { name: '2K', sources: [] }] })).json;
  const race = st0.config.races[0];
  const k2 = race.splits[1].id;
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await waitFor(async () => (await state()).outputs[0]?.state === 'connected', 'TrackScore to be connected');

  // 2K is paused (a mat in trouble); four runners pass both mats
  await api(app, 'POST', `/api/races/${race.id}/splits/${k2}/sending`, { on: false });
  await send([...[901, 902, 903, 904].map((bib, i) => [180 + 5 * i, bib]), ...[901, 902, 903, 904].map((bib, i) => [360 + 10 * i, bib])]);
  await waitFor(async () => (await state()).races[0].splits[1].held === 4, 'four held 2K splits');
  await waitFor(() => ts.packets.length === 4, 'the four 1K splits');
  // FinishLynx finishes 901 and 902 and is still writing its file (no final line break yet) when the operator presses
  // Play: the relay reads the folder first, and waits for the file
  const rows = [1, 2].map((p) => `${p},${900 + p},,Runner,R${p},Team,${9 + p}:00.000,M,,,"${9 + p}:00.000 (${9 + p}:00.000)",10:00:00.000,,,,,,,${9 + p}:00.00`);
  const full = ['5,1,1,Boys 5K,,,,,,,10:00:00.0000', ...rows, ''].join('\r\n');
  const file = path.join(lynxDir, '005-1-01.lif');
  fs.writeFileSync(file, full.slice(0, -2));
  const play = api(app, 'POST', `/api/races/${race.id}/splits/${k2}/sending`, { on: true });
  const playing = await waitFor(async () => (await state()).races[0].splits[1].playing === true, 'the split to say "Playing…"', 2500);
  assert.ok(playing);
  assert.equal(ts.packets.length, 4, 'nothing of 2K goes out while the folder is read');
  await sleep(300);
  fs.writeFileSync(file, full); // FinishLynx is done writing
  await play;
  const st = await state();
  assert.deepEqual([st.races[0].splits[1].sending, st.races[0].splits[1].playing], [true, false]);
  await waitFor(() => ts.packets.length === 6, "the two 2K splits of the runners still on the course");
  await sleep(500);
  const twoK = ts.packets.slice(4).map((p) => JSON.parse(p.raw).D).map((d) => [d.BIB, d.L2G]);
  assert.deepEqual(twoK.sort(), [['903', '1'], ['904', '1']], "901 and 902 had finished: no 2K packet replaces their finish place");
  // their 2K splits wait in Review, to go with the finish place
  const fin = (await api(app, 'GET', `/api/races/${race.id}/review`)).json.finishedNotSent;
  assert.deepEqual(fin.map((x) => [x.bib, x.finishPlace]).sort(), [['901', 1], ['902', 2]]);
});

test('revision 11 through the app: a Pause pressed while Play is still reading FinishLynx\'s folder cancels the Play', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  const mergedDir = path.join(root, 'Merged');
  fs.mkdirSync(lynxDir);
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: true, inputDir: lynxDir, outputDir: mergedDir, fillPlaces: false } });
  const st0 = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '5', gun: '10:00:00.000', inputPort: 5565,
    splits: [{ name: '1K', sources: [] }, { name: '2K', sources: [] }] })).json;
  const race = st0.config.races[0];
  const k2 = race.splits[1].id;
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await waitFor(async () => (await state()).outputs[0]?.state === 'connected', 'TrackScore to be connected');
  await api(app, 'POST', `/api/races/${race.id}/splits/${k2}/sending`, { on: false });
  await send([...[901, 902].map((bib, i) => [180 + 5 * i, bib]), ...[901, 902].map((bib, i) => [360 + 10 * i, bib])]);
  await waitFor(async () => (await state()).races[0].splits[1].held === 2, 'two held 2K splits');
  await waitFor(() => ts.packets.length === 2, 'the two 1K splits');
  // FinishLynx is still writing its file: Play waits for it...
  const file = path.join(lynxDir, '005-1-01.lif');
  const full = ['5,1,1,Boys 5K,,,,,,,10:00:00.0000', ''].join('\r\n');
  fs.writeFileSync(file, full.slice(0, -2));
  const play = api(app, 'POST', `/api/races/${race.id}/splits/${k2}/sending`, { on: true });
  await waitFor(async () => (await state()).races[0].splits[1].playing === true, 'the split to say "Playing…"', 2500);
  // ...and the operator changes their mind and pauses it again
  await api(app, 'POST', `/api/races/${race.id}/splits/${k2}/sending`, { on: false });
  fs.writeFileSync(file, full);
  await play;
  await sleep(800);
  const st = await state();
  assert.deepEqual([st.races[0].splits[1].sending, st.races[0].splits[1].playing], [false, false], 'still paused');
  assert.equal(ts.packets.length, 2, 'no 2K split went out');
});

test('fix a runner through the app (9.23): a Move after the minute reaches TrackScore in its new column, the furthest split last; a fill replaces the emptied cell; Undo after a kill; a finisher\'s Move waits for the finish place', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-'));
  const dataDir = path.join(root, 'data');
  const lynxDir = path.join(root, 'Lynx');
  const mergedDir = path.join(root, 'Merged');
  fs.mkdirSync(lynxDir);
  const ts = fakeTrackScore();
  const tsPort = await ts.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  const packets = (from, bib) => ts.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.P]);
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  await api(app, 'PUT', '/api/settings', { lif: { enabled: true, inputDir: lynxDir, outputDir: mergedDir, fillPlaces: false } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '5', gun: '10:00:00.000', inputPort: 5565,
    splits: [{ name: '1K', sources: [] }, { name: '2K', sources: [] }, { name: '3K', sources: [] }] })).json;
  const race = st.config.races[0];
  const [k1, k2, k3] = race.splits.map((s) => s.id);
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await waitFor(async () => (await state()).outputs[0]?.state === 'connected', 'TrackScore to be connected');
  // eight runners pass the three mats, and the stream carries the finish line too; bib 905 missed 2K, so every one of
  // its columns is full (its 3K pass is counted as 2K, its finish as 3K). 9.23 F13: the column check holds them all the
  // same (the finish pass no longer lets them go); kept from the check queue as counted, they go out a column early, as
  // they did on race day
  const lines = [];
  for (let i = 0; i < 8; i++) {
    for (const [k, sec] of [[1, 180 + 5 * i], [2, 360 + 10 * i], [3, 540 + 15 * i], [4, 720 + 20 * i]]) if (!(i === 4 && k === 2)) lines.push([sec, String(901 + i)]);
  }
  await send(lines.sort((a, b) => a[0] - b[0]));
  await waitFor(() => ts.packets.length === 22, "every split of the seven, and 905's 1K");
  const held = (await api(app, 'GET', `/api/races/${race.id}/review`)).json.checks.filter((c) => c.bib === '905');
  assert.deepEqual(held.map((c) => [c.fromName, c.toName, c.missed?.names ?? null]), [['2K', '3K', ['2K']], ['3K', 'the finish', null]]);
  await api(app, 'POST', `/api/races/${race.id}/assign`, { bib: '905', all: 'keep' });
  await waitFor(() => ts.packets.length === 24, 'every split of the eight');
  assert.deepEqual(packets(0, '905'), [['3', '3:20.000', '5'], ['2', '10:00.000', '8'], ['1', '13:20.000', '8']]);
  // the scoreboard got them more than a minute ago: a correction now needs the operator
  await app.stop();
  const file = path.join(dataDir, 'races', `${race.id}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const rows of Object.values(saved.ledgers)) for (const row of rows) row[5] = row[6] = Date.now() - 120_000;
  fs.writeFileSync(file, JSON.stringify(saved));
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await sleep(500);
  assert.equal(ts.packets.length, 24, 'a clean restart sends nothing');
  // the look-wrong check: 905's 3K pass is in 2K
  const flag = (await api(app, 'GET', `/api/races/${race.id}/review`)).json.flags.find((f) => f.bib === '905');
  assert.deepEqual([flag.splitName, flag.timeText, flag.suggest.toName], ['2K', '10:00.0', '3K']);
  // Move it, with the later times: 3K is 10:00.0 now, its finish an extra pass; TrackScore gets it in the 3K column
  let at = ts.packets.length;
  let r = (await api(app, 'POST', `/api/races/${race.id}/runners/905/move`, { tod: flag.passTod, to: k3, from: k2 })).json;
  assert.equal(r.change.text, '10:00.0 moved to 3K; 13:20.0 is an extra pass now');
  await waitFor(() => packets(at, '905').length === 1, 'the corrected 3K');
  assert.deepEqual(packets(at, '905'), [['1', '10:00.000', '5']]);
  assert.deepEqual(r.change.leftover, [{ bib: '905', splitName: '2K', text: '10:00.0' }]);
  // a kill (the journal has no clean stop) and a start: the change is still there, and Undo works and sends
  await app.stop();
  const journal = path.join(dataDir, 'reads.jsonl');
  const jl = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean);
  while (JSON.parse(jl.at(-1)).t === 'stop') jl.pop();
  fs.writeFileSync(journal, jl.join('\n') + '\n');
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  let v = (await api(app, 'GET', `/api/races/${race.id}/runners/905`)).json;
  assert.deepEqual(v.columns.map((c) => [c.timeText, c.kind]), [['3:20.0', 'read'], ['', 'missing'], ['10:00.0', 'moved']]);
  assert.deepEqual(v.changes.map((c) => [c.kind, c.undoable]), [['move', true], ['check', false]]);
  at = ts.packets.length;
  r = (await api(app, 'POST', `/api/races/${race.id}/undo`, { fix: v.changes[0].fix })).json;
  // (what the Undo did, not the words of the Move it took back)
  assert.equal(r.change.text, 'Undone: 10:00.0 is the 2K split again; 13:20.0 → 3K');
  await waitFor(() => packets(at, '905').length === 1, 'the 3K put back');
  assert.deepEqual(packets(at, '905'), [['1', '13:20.000', '8']]);
  // Redo (it empties 2K again, which TrackScore keeps: the panel has asked), then fill 2K: TrackScore's old 2K cell
  // gets the made-up time, then the furthest split again (its place)
  r = (await api(app, 'POST', `/api/races/${race.id}/undo`, { fix: r.change.fix, confirm: true })).json;
  assert.match(r.change.text, /^Done again: 10:00\.0 moved to 3K/);
  at = ts.packets.length;
  r = (await api(app, 'POST', `/api/races/${race.id}/manual`, { bib: '905', splitId: k2, ifEmpty: true })).json;
  const est = r.added[0].timeText;
  await waitFor(() => packets(at, '905').length === 2, 'the made-up 2K, then 3K');
  const two = packets(at, '905');
  assert.deepEqual([two[0][0], two[1]], ['2', ['1', '10:00.000', '5']]);
  assert.ok(two[0][1].startsWith(est), `${two[0][1]} ~ ${est}`);
  // the merged .lif has the moved and the made-up times
  const merged = await waitFor(() => {
    const f = path.join(mergedDir, '005-1-01.lif');
    if (!fs.existsSync(f)) return null;
    const row = parseLif(decodeCp1252(fs.readFileSync(f))).rows.find((x) => x.bib === '905');
    return row && row.fields[10].includes('10:00.000') && row.fields[10].includes(est) ? row : null;
  }, 'the merged row of 905');
  assert.ok(merged.fields[10].startsWith('3:20.000 (3:20.000),'), merged.fields[10]);
  // FinishLynx finishes everybody: bib 902's 2K pass set aside (Not a split) goes into the .lif only, and waits in
  // "Finished: not sent live" until Send with finish place. 9.23 F13: its 3K pass is then in 2K and its finish pass in
  // 3K, which the column check holds (the finish is a column): the operator keeps them there first
  const rows = Array.from({ length: 8 }, (_, i) => `${i + 1},${901 + i},,Runner,R${i + 1},Team,${12 + i}:00.000,M,,,"",10:00:00.000,,,,,,,${12 + i}:00.00`);
  fs.writeFileSync(path.join(lynxDir, '005-1-01.lif'), ['5,1,1,Boys 5K,,,,,,,10:00:00.0000', ...rows, ''].join('\r\n'));
  await waitFor(async () => (await api(app, 'GET', `/api/races/${race.id}/runners/902`)).json.finishPlace === 2, "902's finish place");
  v = (await api(app, 'GET', `/api/races/${race.id}/runners/902`)).json;
  at = ts.packets.length;
  r = (await api(app, 'POST', `/api/races/${race.id}/runners/902/move`, { tod: v.passes[1].tod, to: 'none', from: k2 })).json;
  const held902 = (await api(app, 'GET', `/api/races/${race.id}/review`)).json.checks.filter((c) => c.bib === '902');
  assert.deepEqual(held902.map((c) => [c.fromName, c.toName]), [['2K', '3K'], ['3K', 'the finish']]);
  await api(app, 'POST', `/api/races/${race.id}/assign`, { bib: '902', all: 'keep' });
  await sleep(500);
  assert.deepEqual(packets(at, '902'), [], 'a finisher is not sent a split place');
  assert.ok(r.change.notLive.length > 0);
  const fns = (await api(app, 'GET', `/api/races/${race.id}/review`)).json.finishedNotSent.filter((x) => x.bib === '902');
  // (its 3K pass is 2K now, and its finish line pass, before FinishLynx's finish, is 3K)
  assert.deepEqual(fns.map((x) => [x.splitName, x.timeText]), [['2K', '9:15.0'], ['3K', '12:20.0']]);
  await api(app, 'POST', `/api/races/${race.id}/send-finished`, { bib: '902' });
  await waitFor(() => packets(at, '902').length === 2, "902's splits with the finish place");
  assert.deepEqual(packets(at, '902'), [['2', '9:15.000', '2'], ['1', '12:20.000', '2']]);
  void k1;
});

test('a missed split through the app (9.23 F13): held past the finish pass, "Missed 2K: add it" sends every line to TrackScore and Karmarush alike; a late read after the minute goes out by itself', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-missed-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  let app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  // a split line as both scoreboards read it: bib, laps to go, CS, LS, P
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Boys 5K', eventNumber: '5', gun: '10:00:00.000', inputPort: 5565,
    splits: [{ name: '1K', sources: [] }, { name: '2K', sources: [] }, { name: '3K', sources: [] }] })).json;
  const race = st.config.races[0];
  const [, k2] = race.splits.map((s) => s.id);
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // eight runners pass the three mats and the finish line; 905 and 906 missed 2K: their 3K pass is counted in 2K and
  // their finish pass in 3K. The column check (the finish as a column) holds both: nothing goes out a column early
  const all = [];
  for (let i = 0; i < 8; i++) {
    for (const [k, sec] of [[1, 180 + 5 * i], [2, 360 + 10 * i], [3, 540 + 15 * i], [4, 720 + 20 * i]]) if (!((i === 4 || i === 5) && k === 2)) all.push([sec, String(901 + i)]);
  }
  await send(all.sort((a, b) => a[0] - b[0]));
  await waitFor(() => ts.packets.length === 20 && kr.packets.length === 20, "every split of the six, and 905's and 906's 1K");
  assert.deepEqual(lines(ts, 0, '905'), [['3', '3:20.000', '3:20.000', '5']]);
  // "Missed 2K: add it" (the check row's one click): 2K made up, 10:00 in 3K, 13:20 an extra pass; both outputs get the
  // same lines, each in its column with its leg, the furthest (3K) last
  const v = (await api(app, 'GET', `/api/races/${race.id}/runners/905`)).json;
  assert.deepEqual([v.columns[1].missed.here, v.columns[1].missed.effect], [true, '10:00.0 → 3K, 13:20.0 → extra pass (the finish)']);
  let tsAt = ts.packets.length;
  let krAt = kr.packets.length;
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/905/missed`, { splitId: k2, passTod: v.columns[1].passTod })).json;
  assert.match(r.change.text, /^Missed 2K added \(\d:\d\d\.\d, made up\); 10:00\.0 → 3K; 13:20\.0 is an extra pass now \(the finish\)$/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, '905').length === 2 && lines(kr, krAt, '905').length === 2, "905's 2K and 3K on both");
  const est = r.added[0].raceTicks / 10000;
  const two = lines(ts, tsAt, '905');
  assert.deepEqual(two.map((x) => x[0]), ['2', '1']);
  assert.equal(Number(two[0][1].split(':')[1]) + 60 * Number(two[0][1].split(':')[0]), est);
  assert.equal(two[1][1], '10:00.000');
  assert.deepEqual(lines(kr, krAt, '905'), two, 'Karmarush gets exactly what TrackScore gets');
  assert.equal(JSON.parse(kr.packets.at(-1).raw).D.MID, 9999);
  // 906: kept from the check queue as counted (its 3K pass goes out as 2K, its finish as 3K, as on race day); a minute
  // later its 2K read comes (RR12 had it queued): the passes are counted again and every changed line goes out by
  // itself, to both, with its laps to go, the furthest last
  await api(app, 'POST', `/api/races/${race.id}/assign`, { bib: '906', all: 'keep' });
  await waitFor(() => lines(ts, 0, '906').length === 3 && lines(kr, 0, '906').length === 3, "906's splits as counted");
  await app.stop();
  const file = path.join(dataDir, 'races', `${race.id}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const rows of Object.values(saved.ledgers)) for (const row of rows) row[5] = row[6] = Date.now() - 120_000;
  fs.writeFileSync(file, JSON.stringify(saved));
  app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  await sleep(500);
  tsAt = ts.packets.length;
  krAt = kr.packets.length;
  await send([[360 + 10 * 5, '906']]);
  await waitFor(() => lines(ts, tsAt, '906').length === 2 && lines(kr, krAt, '906').length === 2, "906's corrected 2K and 3K on both");
  assert.deepEqual(lines(ts, tsAt, '906'), [['2', '6:50.000', '3:25.000', '6'], ['1', '10:15.000', '3:25.000', '6']]);
  assert.deepEqual(lines(kr, krAt, '906'), lines(ts, tsAt, '906'));
});

test('two mats missed in a row through the app (9.23 F14): Split Relay is sure how many; "Missed 2K and 3K: add them" (Splits that look wrong) sends every line to TrackScore and Karmarush alike, each in its column with its leg, the furthest last', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-two-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const send = async (lines) => {
    const sock = await rr12(app.inputPortOf(5565));
    socks.push(sock);
    sock.write(lines.map(([sec, bib]) => `\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${bib}\r\n`).join(''));
  };
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 10 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Girls 5K', eventNumber: '6', gun: '10:00:00.000', inputPort: 5565,
    splits: ['1K', '2K', '3K', '4K'].map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  const k2 = race.splits[1].id;
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // twelve runners pass the four mats and the finish line, 3:00 a kilometre for the first, 2 % slower each; 907 missed
  // 2K and 3K: its 4K pass is counted in 2K and its finish pass in 3K. Too far from the field there for the column check
  // (it places a pass one split on at most), they go out as counted; the look-wrong check sees the long leg
  const all = [];
  for (let i = 0; i < 12; i++) {
    for (let k = 1; k <= 5; k++) if (!(i === 6 && (k === 2 || k === 3))) all.push([Math.round(180 * k * (1 + 0.02 * i) * 1000) / 1000, String(901 + i)]);
  }
  await send(all.sort((a, b) => a[0] - b[0]));
  await waitFor(() => lines(ts, 0, '907').length === 3 && lines(kr, 0, '907').length === 3 && lines(ts, 0, '912').length === 4, "907's splits as counted, and the last runner's");
  assert.deepEqual(lines(ts, 0, '907').map((x) => [x[0], x[1]]), [['4', '3:21.600'], ['3', '13:26.400'], ['2', '16:48.000']]);
  // Splits that look wrong: sure how many (from 1K the leg fits 4K, not 3K), both missed splits, what it does
  const rv = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
  const row = rv.flags.find((f) => f.bib === '907');
  assert.deepEqual([row.splitId, row.missed.names, row.missed.count, row.missed.sure, row.missed.alt, row.missed.effect], [k2, ['2K', '3K'], 2, true, null, '13:26.4 → 4K, 16:48.0 → extra pass (the finish)']);
  assert.match(row.text, /^13:26\.4 looks like 4K, not 2K \(missed 2K and 3K\?\)/);
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/907/missed`, { splitId: row.splitId, passTod: row.passTod, count: row.missed.count })).json;
  assert.match(r.change.text, /^Missed 2K and 3K added \(\d:\d\d\.\d and \d+:\d\d\.\d, made up\); 13:26\.4 → 4K; 16:48\.0 is an extra pass now \(the finish\)$/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, '907').length === 3 && lines(kr, krAt, '907').length === 3, "907's 2K, 3K and 4K on both");
  const three = lines(ts, tsAt, '907');
  // each in its column (laps to go 3, 2, 1: the furthest last), the made-up ones where the mats would have read, each
  // leg from the split before it
  assert.deepEqual(three.map((x) => x[0]), ['3', '2', '1']);
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  assert.ok(Math.abs(sec(three[0][1]) - 403.2) < 3 && Math.abs(sec(three[1][1]) - 604.8) < 3, JSON.stringify(three));
  assert.equal(three[2][1], '13:26.400');
  assert.equal(Math.round((sec(three[0][1]) - 201.6) * 1000), Math.round(sec(three[0][2]) * 1000));
  for (let i = 1; i < 3; i++) assert.equal(Math.round((sec(three[i][1]) - sec(three[i - 1][1])) * 1000), Math.round(sec(three[i][2]) * 1000));
  assert.deepEqual(lines(kr, krAt, '907'), three, 'Karmarush gets exactly what TrackScore gets');
});

test('where the run starts through the app (9.23 F15): the real race, 561 missed 4200m and 4400m, its 5300m pass sent as 4200m and its finish pass held in 4400m; the first held row\'s one click adds both at 4200m and sends every line to TrackScore and Karmarush alike', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-start-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too), 561 (fixture bib 147) without its 4200m and 4400m
  const bib = '147';
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b);
  const reads = W.runners.flatMap((r) => r.passes.filter((x) => !(r.bib === bib && (x === real[4] || x === real[5]))).map((x) => [x, r.bib])).sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  await waitFor(() => lines(ts, 0, bib).length >= 5 && lines(kr, 0, bib).length >= 5, "561's splits as counted");
  // its 5300m pass went out as 4200m (the back of the field's times there); its finish pass is held in 4400m
  assert.deepEqual(lines(ts, 0, bib).map((x) => [x[0], x[1]]).at(-1), ['3', fmt(real[6])]);
  const rv = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return r.checks.some((c) => c.bib === bib && c.missed) ? r : null;
  }, "561's row in Passes to check");
  const row = rv.checks.find((c) => c.bib === bib && c.missed);
  assert.deepEqual([row.timeText, row.from, row.missed.splitId, row.missed.names, row.missed.sure, row.missed.effect],
    ['22:29.3', race.splits[5].id, race.splits[4].id, ['4200m', '4400m'], true, '19:41.6 → 5300m, 22:29.3 → extra pass (the finish), 29:13.6 → extra pass']);
  assert.match(row.reason, /^19:41\.6 looks like 5300m, not 4200m \(missed 4200m and 4400m\?\)/);
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  // as the panel sends it (missedRowTarget): the hint's split and pass, not the row's
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/${bib}/missed`, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count })).json;
  assert.match(r.change.text, /^Missed 4200m and 4400m added \(\d+:\d\d\.\d and \d+:\d\d\.\d, made up\); 19:41\.6 → 5300m; 22:29\.3 and 29:13\.6 are extra passes now \(22:29\.3 the finish\)$/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, bib).length >= 3 && lines(kr, krAt, bib).length >= 3, "561's 4200m, 4400m and 5300m on both");
  const three = lines(ts, tsAt, bib);
  // each in its column, the furthest last: 4200m and 4400m made up where the mats would have read, 5300m its own pass
  assert.deepEqual(three.map((x) => x[0]), ['3', '2', '1']);
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  assert.ok(Math.abs(sec(three[0][1]) - real[4] / 10000) < 25 && Math.abs(sec(three[1][1]) - real[5] / 10000) < 25, JSON.stringify(three));
  assert.equal(three[2][1], fmt(real[6]));
  assert.equal(Math.round((sec(three[0][1]) - real[3] / 10000) * 1000), Math.round(sec(three[0][2]) * 1000));
  for (let i = 1; i < 3; i++) assert.equal(Math.round((sec(three[i][1]) - sec(three[i - 1][1])) * 1000), Math.round(sec(three[i][2]) * 1000));
  assert.deepEqual(lines(kr, krAt, bib), three, 'Karmarush gets exactly what TrackScore gets');
});

test('two mats missed apart through the app (9.23 F16): the real race, 544 missed 4200m and 5300m (4400m read); the first held row\'s one click adds both in ONE change and sends 4200m, 4400m and 5300m to TrackScore and Karmarush alike, each in its column with its leg, the furthest last; one Undo', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-apart-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too), 544 (fixture bib 134) without its 4200m and 5300m
  const bib = '134';
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b);
  const reads = W.runners.flatMap((r) => r.passes.filter((x) => !(r.bib === bib && (x === real[4] || x === real[6]))).map((x) => [x, r.bib])).sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  await waitFor(() => lines(ts, 0, bib).length >= 5 && lines(kr, 0, bib).length >= 5, "544's splits as counted");
  // its 4400m pass went out as 4200m (200 m before); its finish read is held in 4400m
  assert.deepEqual(lines(ts, 0, bib).map((x) => [x[0], x[1]]).at(-1), ['3', fmt(real[5])]);
  const rv = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return r.checks.some((c) => c.bib === bib && c.missed) ? r : null;
  }, "544's row in Passes to check");
  const row = rv.checks.find((c) => c.bib === bib && c.missed);
  assert.deepEqual([row.timeText, row.from, row.missed.splitId, row.missed.names, row.missed.read, row.missed.runs.map((x) => [x.splitId, x.count]), row.missed.sure, row.missed.effect],
    ['20:43.5', race.splits[5].id, race.splits[4].id, ['4200m', '5300m'], ['4400m'], [[race.splits[4].id, 1], [race.splits[6].id, 1]], true, '15:08.2 → 4400m, 20:43.5 → extra pass (the finish)']);
  assert.match(row.reason, /^15:08\.2 looks like 4400m, not 4200m, and 20:43\.5 like the finish, not 4400m \(missed 4200m and 5300m\?\)/);
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  // as the panel sends it (missedRowTarget): the hint's split and pass, and the further run
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/${bib}/missed`, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count,
    also: row.missed.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) })).json;
  assert.match(r.change.text, /^Missed 4200m and 5300m added \(\d+:\d\d\.\d and \d+:\d\d\.\d, made up\); 15:08\.2 → 4400m; 20:43\.5 is an extra pass now \(the finish\)$/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, bib).length >= 3 && lines(kr, krAt, bib).length >= 3, "544's 4200m, 4400m and 5300m on both");
  const three = lines(ts, tsAt, bib);
  // each in its column, the furthest last: 4200m and 5300m made up where the mats would have read, 4400m its own pass
  assert.deepEqual(three.map((x) => x[0]), ['3', '2', '1']);
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  assert.ok(Math.abs(sec(three[0][1]) - real[4] / 10000) < 25 && Math.abs(sec(three[2][1]) - real[6] / 10000) < 25, JSON.stringify(three));
  assert.equal(three[1][1], fmt(real[5]));
  assert.equal(Math.round((sec(three[0][1]) - real[3] / 10000) * 1000), Math.round(sec(three[0][2]) * 1000));
  for (let i = 1; i < 3; i++) assert.equal(Math.round((sec(three[i][1]) - sec(three[i - 1][1])) * 1000), Math.round(sec(three[i][2]) * 1000));
  assert.deepEqual(lines(kr, krAt, bib), three, 'Karmarush gets exactly what TrackScore gets');
  // one Undo puts it all back (asked first: the boards keep the cells it filled)
  await assert.rejects(api(app, 'POST', `/api/races/${race.id}/undo`, { fix: r.change.fix }), /-> 409 .*"code":"UNDO_LEAVES"/);
  const u = (await api(app, 'POST', `/api/races/${race.id}/undo`, { fix: r.change.fix, confirm: true })).json;
  assert.equal(u.change.kind, 'undo');
  const runner = (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  assert.deepEqual([runner.missedHint.names, runner.columns.filter((c) => c.kind === 'made-up').length], [['4200m', '5300m'], 0]);
});

test('the first mat and two more missed apart through the app (9.23 F17): the real race, 491 (a walker) missed 800m, 2400m and 3100m, its 1500m pass counted in 800m three minutes behind every other runner; Splits that look wrong\'s one click adds all three in ONE change and sends every split from 800m to 5300m to TrackScore and Karmarush alike, each in its column with its leg, the furthest last', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-first-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too), 491 (fixture bib 91) without its 800m, 2400m and 3100m
  const bib = '91';
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b);
  const gone = new Set([real[0], real[2], real[3]]);
  const reads = W.runners.flatMap((r) => r.passes.filter((x) => !(r.bib === bib && gone.has(x))).map((x) => [x, r.bib])).sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  // its passes went out as counted: its 1500m pass as 800m, its 4200m pass as 1500m, and so on
  await waitFor(() => lines(ts, 0, bib).length >= 5 && lines(kr, 0, bib).length >= 5, "491's splits as counted");
  assert.deepEqual(lines(ts, 0, bib).slice(0, 2).map((x) => [x[0], x[1]]), [['7', fmt(real[1])], ['6', fmt(real[4])]]);
  const rv = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return r.flags.some((f) => f.bib === bib && f.missed) ? r : null;
  }, "491's row in Splits that look wrong");
  const row = rv.flags.find((f) => f.bib === bib && f.missed);
  assert.deepEqual([row.kind, row.splitId, row.missed.names, row.missed.read, row.missed.runs.map((x) => [x.splitId, x.count]), row.missed.sure],
    ['missed', race.splits[0].id, ['800m', '2400m', '3100m'], ['1500m'], [[race.splits[0].id, 1], [race.splits[2].id, 2]], true]);
  assert.equal(row.text, '6:03.9 looks like 1500m, not 800m, and 20:20.5 like 4200m, not 1500m (missed 800m, 2400m and 3100m?).');
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  // as the panel sends it (missedRowTarget): the hint's split and pass, and the further run
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/${bib}/missed`, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count,
    also: row.missed.runs.slice(1).map((x) => ({ splitId: x.splitId, count: x.count })) })).json;
  assert.match(r.change.text, /^Missed 800m, 2400m and 3100m added \(\d+:\d\d\.\d, \d+:\d\d\.\d and \d+:\d\d\.\d, made up\); /);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, bib).length >= 7 && lines(kr, krAt, bib).length >= 7, "491's seven splits on both");
  const seven = lines(ts, tsAt, bib);
  // each in its column, the furthest last: 800m, 2400m and 3100m made up between the real times around them, the others its own
  assert.deepEqual(seven.map((x) => x[0]), ['7', '6', '5', '4', '3', '2', '1']);
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  assert.ok(sec(seven[0][1]) < real[1] / 10000 && sec(seven[2][1]) > real[1] / 10000 && sec(seven[3][1]) < real[4] / 10000 && sec(seven[2][1]) < sec(seven[3][1]), JSON.stringify(seven));
  for (const [i, k] of [[1, 1], [4, 4], [5, 5], [6, 6]]) assert.equal(seven[i][1], fmt(real[k]), `L2G ${7 - k}`);
  assert.equal(Math.round(sec(seven[0][1]) * 1000), Math.round(sec(seven[0][2]) * 1000));
  for (let i = 1; i < 7; i++) assert.equal(Math.round((sec(seven[i][1]) - sec(seven[i - 1][1])) * 1000), Math.round(sec(seven[i][2]) * 1000));
  assert.deepEqual(lines(kr, krAt, bib), seven, 'Karmarush gets exactly what TrackScore gets');
  const runner = (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  assert.deepEqual([runner.missedHint, runner.columns.filter((c) => c.kind === 'made-up').map((c) => c.splitName)], [null, ['800m', '2400m', '3100m']]);
});

test('a late starter through the app (9.23 F18): the real race, 423 every mat read three minutes after the gun, the finish line and cool-down passes in the stream: nothing held, no Review row, every split to TrackScore and Karmarush alike as read, the furthest last; the runner says "started about 3:00 after the gun?" (to a few seconds)', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-late-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too), 423 (fixture bib 31) every pass three minutes later
  const bib = '31';
  const late = 180 * 10000;
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b).map((x) => x + late);
  const reads = W.runners.flatMap((r) => r.passes.map((x) => [r.bib === bib ? x + late : x, r.bib])).sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  // (F17 held every pass of such a runner once the stream's finish passes were in, and offered two wrong sets)
  await waitFor(() => lines(ts, 0, bib).length >= 7 && lines(kr, 0, bib).length >= 7, "423's seven splits on both", 20_000);
  const seven = lines(ts, 0, bib);
  assert.deepEqual(seven.map((x) => [x[0], x[1]]), real.slice(0, 7).map((x, k) => [String(7 - k), fmt(x)]));
  assert.deepEqual(lines(kr, 0, bib), seven, 'Karmarush gets exactly what TrackScore gets');
  const runner = (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  assert.deepEqual([runner.columns.filter((c) => c.held).length, runner.missedHint], [0, null]);
  // (the runners of its pace's time to 800m, at its pace, against its own: about the three minutes)
  assert.match(runner.lateStart?.text ?? '', /^(2:5\d|3:0\d)$/);
  const rv = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
  assert.equal([...rv.checks, ...rv.flags].filter((x) => x.bib === bib).length, 0);
});

test('a late starter on the course through the app (9.23 F19): the real race streamed in three parts, 423 every mat read four minutes after the gun: after its first pass its 800m waits, "Missed 800m: add it" is offered but never the one click (Split Relay can\'t tell it from a late start); once its second pass is in, its 800m and 1500m reach TrackScore and Karmarush alike as read; at the end every split as read, nothing held, nothing offered', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-late-on-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too), 423 (fixture bib 31) every pass four minutes later
  const bib = '31';
  const late = 240 * 10000;
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b).map((x) => x + late);
  const reads = W.runners.flatMap((r) => r.passes.map((x) => [r.bib === bib ? x + late : x, r.bib])).sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  const send = (from, to) => sock.write(reads.filter(([x]) => x >= from && x < to).map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  const runner = async () => (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  // up to half a minute after its first pass: its 800m waits; the fix is offered, not the one click (F18 had it sure,
  // and taken it sent every split a column late for the rest of the race)
  send(0, real[0] + 30 * 10000);
  await waitFor(async () => (await runner()).columns[0].time === real[0], "423's first pass");
  let v = await runner();
  assert.deepEqual([v.columns[0].held, v.missedHint?.sure, v.missedHint?.unsure], ['check', false, 'late']);
  const rv = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
  const row = rv.checks.find((x) => x.bib === bib);
  assert.deepEqual([row?.missed?.sure, row?.missed?.unsure], [false, 'late']);
  assert.equal(lines(ts, 0, bib).length, 0, 'nothing of it on the boards yet');
  // up to half a minute after its second pass: 800m and 1500m out as read, on both
  send(real[0] + 30 * 10000, real[1] + 30 * 10000);
  await waitFor(() => lines(ts, 0, bib).length >= 2 && lines(kr, 0, bib).length >= 2, "423's 800m and 1500m on both");
  v = await runner();
  assert.deepEqual([v.columns.filter((c) => c.held).length, v.missedHint], [0, null]);
  assert.deepEqual(lines(ts, 0, bib).slice(0, 2).map((x) => [x[0], x[1]]), [['7', fmt(real[0])], ['6', fmt(real[1])]]);
  // the rest of the race: every split as read, the furthest last, Karmarush as TrackScore
  send(real[1] + 30 * 10000, Infinity);
  await waitFor(() => lines(ts, 0, bib).length >= 7 && lines(kr, 0, bib).length >= 7, "423's seven splits on both", 20_000);
  const seven = lines(ts, 0, bib);
  assert.deepEqual(seven.map((x) => [x[0], x[1]]), real.slice(0, 7).map((x, k) => [String(7 - k), fmt(x)]));
  assert.deepEqual(lines(kr, 0, bib), seven, 'Karmarush gets exactly what TrackScore gets');
  v = await runner();
  assert.deepEqual([v.columns.filter((c) => c.held).length, v.missedHint], [0, null]);
});

test('a missed mat and a stray pass through the app (9.23 F20): the real race, bib 1 missed 2400m and a second read came 40 s after its 3100m pass (it filled every column: no row on c53dc9a and 051d375); the Review row says it and its one click sets the stray aside in the same change: 2400m made up and 3100m its own time on TrackScore and Karmarush alike, each with its laps to go and leg, the stray in no column', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-stray-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's every pass (the finish line and cool-down passes too); bib 1 without its 2400m, and a stray read 40 s
  // after its 3100m pass (beyond the tag window)
  const bib = '1';
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b);
  const stray = real[3] + 40 * 10000;
  const reads = [...W.runners.flatMap((r) => r.passes.filter((x) => !(r.bib === bib && x === real[2])).map((x) => [x, r.bib])), [stray, bib]].sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  // the Review row: never silent, its one click names the stray
  const rv = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return [...r.checks, ...r.flags].some((c) => c.bib === bib && c.missed?.aside?.length) ? r : null;
  }, "bib 1's row in Review");
  const row = [...rv.checks, ...rv.flags].find((c) => c.bib === bib && c.missed?.aside?.length);
  assert.deepEqual([row.missed.names, row.missed.sure, row.missed.aside.map((a) => a.timeText), row.missed.effect],
    [['2400m'], true, ['11:24.4'], '10:44.4 → 3100m, 11:24.4 → not a split']);
  await waitFor(() => lines(ts, 0, bib).length >= 7 && lines(kr, 0, bib).length >= 7, "bib 1's splits as counted");
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  // as the panel sends it (missedTarget, addMissedFix): the hint's split and pass, and the stray it sets aside
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/${bib}/missed`, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count,
    aside: row.missed.aside.map((a) => a.passTod) })).json;
  assert.match(r.change.text, /^Missed 2400m added \(\d+:\d\d\.\d, made up\); 10:44\.4 → 3100m, 11:24\.4 → not a split$/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, bib).length >= 3 && lines(kr, krAt, bib).length >= 3, "bib 1's 2400m, 3100m and 4200m on both");
  const sent = lines(ts, tsAt, bib);
  // 2400m made up between 1500m and 3100m, 3100m its own time with its leg from the made-up 2400m, 4200m its own time
  // with its leg from 3100m (no longer from the stray); the stray in no line
  const at = (l2g) => sent.filter((x) => x[0] === l2g).at(-1);
  assert.ok(sec(at('5')[1]) > real[1] / 10000 && sec(at('5')[1]) < real[3] / 10000, JSON.stringify(sent));
  assert.equal(at('4')[1], fmt(real[3]));
  assert.equal(Math.round((sec(at('4')[1]) - sec(at('5')[1])) * 1000), Math.round(sec(at('4')[2]) * 1000));
  assert.deepEqual([at('3')[1], at('3')[2]], [fmt(real[4]), fmt(real[4] - real[3])]);
  assert.ok(sent.every((x) => x[1] !== fmt(stray)), 'the stray is in no line');
  assert.deepEqual(lines(kr, krAt, bib), sent, 'Karmarush gets exactly what TrackScore gets');
  const v = (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  assert.deepEqual([v.missedHint, v.columns.filter((c) => c.held).length, v.passes.find((p) => p.timeText === '11:24.4')?.how], [null, 0, 'ignored']);
});

test('a stray the one click would put in a split, through the app (9.23 F21): the real race, split points only (no finish line, no FinishLynx), bib 10 missed 3100m and a second read came 37 s after its 4400m pass (counted in 4400m, a split late, it looks like a real pass there); "Missed 3100m" alone would put it in 5300m (sure on 23590ad); the Review row\'s one click sets it aside in the same change: 3100m made up, 4200m to 5300m their own times with their legs on TrackScore and Karmarush alike, the stray in no line', { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-stray2-'));
  const dataDir = path.join(root, 'data');
  const ts = fakeTrackScore();
  const kr = fakeTrackScore();
  const tsPort = await ts.listen();
  const krPort = await kr.listen();
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true });
  const socks = [];
  t.after(async () => {
    for (const s of socks) s.destroy();
    await app?.stop();
    await ts.close();
    await kr.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const state = async () => (await api(app, 'GET', '/api/state')).json;
  const W = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'womens-passes.json'), 'utf8'));
  const lines = (sink, from, bib) => sink.packets.slice(from).map((p) => JSON.parse(p.raw).D).filter((d) => d.BIB === bib).map((d) => [d.L2G, d.CS, d.LS, d.P]);
  const fmt = (ticks) => {
    const ms = Math.round(ticks / 10);
    return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const sec = (x) => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);
  await api(app, 'PUT', '/api/settings', { filter: { holdSec: 0.2, tagWindowSec: 25 } });
  const st = (await api(app, 'POST', '/api/races', { name: 'Womens Race', eventNumber: '2', gun: '10:00:00.000', inputPort: 5565,
    splits: W.splits.map((name) => ({ name, sources: [] })) })).json;
  const race = st.config.races[0];
  await api(app, 'POST', '/api/outputs', { name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: tsPort,
    script: XCSCORE, stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '' });
  await api(app, 'POST', '/api/outputs', { name: 'Karmarush', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: krPort,
    script: path.join(FIXTURES, 'karmarush-track.lss'), stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '9999' });
  await waitFor(async () => (await state()).outputs.every((o) => o.state === 'connected'), 'both outputs to be connected');
  // the race's split passes only (the RR12 exporter set to split points); bib 10 without its 3100m, and a stray read
  // 1:30 after its 4200m pass, 37 s after its 4400m pass
  const bib = '10';
  const real = W.runners.find((r) => r.bib === bib).passes.slice().sort((a, b) => a - b);
  const stray = real[4] + 90 * 10000;
  const reads = [...W.runners.flatMap((r) => r.passes.slice().sort((a, b) => a - b).slice(0, 7).filter((x) => !(r.bib === bib && x === real[3])).map((x) => [x, r.bib])), [stray, bib]]
    .sort((a, b) => a[0] - b[0]);
  const sock = await rr12(app.inputPortOf(5565));
  socks.push(sock);
  sock.write(reads.map(([x, b]) => `\x01S,10:${fmt(x).padStart(9, '0')},${b}\r\n`).join(''));
  const rv = await waitFor(async () => {
    const r = (await api(app, 'GET', `/api/races/${race.id}/review`)).json;
    return [...r.checks, ...r.flags].some((c) => c.bib === bib && c.missed?.aside?.length) ? r : null;
  }, "bib 10's row in Review");
  const row = [...rv.checks, ...rv.flags].find((c) => c.bib === bib && c.missed?.aside?.length);
  assert.deepEqual([row.missed.names, row.missed.sure, row.missed.aside.map((a) => a.timeText)], [['3100m'], true, ['16:10.6']]);
  await waitFor(() => lines(ts, 0, bib).length >= 7 && lines(kr, 0, bib).length >= 7, "bib 10's splits as counted");
  const tsAt = ts.packets.length;
  const krAt = kr.packets.length;
  const r = (await api(app, 'POST', `/api/races/${race.id}/runners/${bib}/missed`, { splitId: row.missed.splitId, passTod: row.missed.passTod, count: row.missed.count,
    aside: row.missed.aside.map((a) => a.passTod) })).json;
  assert.match(r.change.text, /^Missed 3100m added \(\d+:\d\d\.\d, made up\); .*16:10\.6 → not a split/);
  assert.deepEqual(r.change.sentTo, ['TrackScore', 'Karmarush']);
  await waitFor(() => lines(ts, tsAt, bib).some((x) => x[0] === '1') && lines(kr, krAt, bib).some((x) => x[0] === '1'), "bib 10's 5300m on both");
  const sent = lines(ts, tsAt, bib);
  const at = (l2g) => sent.filter((x) => x[0] === l2g).at(-1);
  // 3100m made up between 2400m and 4200m; 4200m, 4400m and 5300m their own times, each with its leg; the stray in no line
  assert.ok(sec(at('4')[1]) > real[2] / 10000 && sec(at('4')[1]) < real[4] / 10000, JSON.stringify(sent));
  const ms = (x) => Math.round(sec(x) * 1000);
  assert.deepEqual([at('3')[1], at('2')[1], ms(at('2')[2]), at('1')[1], ms(at('1')[2])], [fmt(real[4]), fmt(real[5]), Math.round((real[5] - real[4]) / 10), fmt(real[6]), Math.round((real[6] - real[5]) / 10)]);
  assert.ok(sent.every((x) => x[1] !== fmt(stray)), 'the stray is in no line');
  assert.equal(sent.at(-1)[0], '1', 'the furthest split last');
  assert.deepEqual(lines(kr, krAt, bib), sent, 'Karmarush gets exactly what TrackScore gets');
  const v = (await api(app, 'GET', `/api/races/${race.id}/runners/${bib}`)).json;
  assert.deepEqual([v.missedHint, v.columns.filter((c) => c.held).length, v.passes.find((p) => p.timeText === '16:10.6')?.how], [null, 0, 'ignored']);
});

test('9.22: the meet saved on one copy is loaded on another, and is still there after a restart; no gun comes along', { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-e2e-meet-'));
  // config.json first, on test ports: no start here can take the live relay's ports (5565, 5590)
  const dataDir = (name, ports) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ input: { ports }, panel: { port: 17591 } }));
    return dir;
  };
  const dirA = dataDir('a', [17571, 17572]);
  const dirB = dataDir('b', [17573]);
  let a = await startApp({ dataDir: dirA, panelPort: 0, inputPort: 0, quiet: true });
  let b = null;
  t.after(async () => {
    await a?.stop();
    await b?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await api(a, 'POST', '/api/races', { name: RACE, eventNumber: '3', inputPort: 17571, gun: '10:00:00.000', splits: [{ name: '1K' }, { name: '2K', earliest: '5:00' }] });
  await api(a, 'POST', '/api/races', { name: 'Boys Varsity 5K', eventNumber: '5', inputPort: 17572, splits: [{ name: '1K' }, { name: '2K' }, { name: '3K' }] });
  await api(a, 'POST', '/api/outputs', { name: 'TrackScore', enabled: false, host: '127.0.0.1', port: 6555, script: XCSCORE });
  await api(a, 'PUT', '/api/settings', { meet: { name: 'Fall Classic 2026' }, filter: { tagWindowSec: 25, holdSec: 0 } });
  const saved = (await api(a, 'POST', '/api/meet/save')).json;
  assert.equal(saved.fileName, 'Fall Classic 2026.json');
  await a.stop();
  a = null;

  // the other copy: its own data folder, no races
  b = await startApp({ dataDir: dirB, panelPort: 0, inputPort: 0, quiet: true });
  let st = (await api(b, 'GET', '/api/state')).json;
  assert.deepEqual([st.config.races, st.config.outputs], [[], []]);
  const p = (await api(b, 'POST', '/api/meet/preview', { meet: JSON.parse(saved.text), fileName: saved.fileName })).json;
  assert.equal(p.title, 'Fall Classic 2026');
  assert.deepEqual(p.added.map((i) => i.text), [
    'RR12 input port 17571 (Girls Varsity 5K reads from it)', 'RR12 input port 17572 (Boys Varsity 5K reads from it)',
    'Girls Varsity 5K · Event 3-1-1 · 2 splits: 1K, 2K · port 17571 · Active',
    'Boys Varsity 5K · Event 5-1-1 · 3 splits: 1K, 2K, 3K · port 17572 · Active',
    'TrackScore · 127.0.0.1:6555 · switched off',
  ]);
  const applied = (await api(b, 'POST', '/api/meet/apply', { meet: p.meet, mode: p.mode, base: p.base })).json;
  assert.equal(applied.applied.added, 2);
  await b.stop();
  b = await startApp({ dataDir: dirB, panelPort: 0, inputPort: 0, quiet: true });
  st = (await api(b, 'GET', '/api/state')).json;
  assert.deepEqual(st.config.races.map((r) => [r.name, r.gun, r.splits.map((s) => [s.name, s.earliest])]), [
    [RACE, '', [['1K', ''], ['2K', '5:00']]], ['Boys Varsity 5K', '', [['1K', ''], ['2K', ''], ['3K', '']]],
  ]);
  assert.deepEqual(st.config.outputs.map((o) => [o.name, o.enabled, o.port]), [['TrackScore', false, 6555]]);
  assert.deepEqual([st.config.meet.name, st.config.filter.tagWindowSec, st.config.input.ports], ['Fall Classic 2026', 25, [17573, 17571, 17572]]);
  // and the same file again changes nothing
  const again = (await api(b, 'POST', '/api/meet/preview', { meet: JSON.parse(saved.text) })).json;
  assert.equal(again.nothing, true);
});
