import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/main.js';
import { PanelServer, isLoopback, hostAllowed, listFolder } from '../src/server.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const XCSCORE = path.join(FIXTURES, 'xcscore.lss');

/** One HTTP request with full control over the headers (fetch will not let us set Host). */
function request(port, method, urlPath, { body, headers = {}, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (data && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = data.length;
    const req = http.request({ host, port, method, path: urlPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Read server-sent events until `until(events)` is true. */
function sse(port, until, { timeoutMs = 5000, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buf = '';
    const req = http.get({ host, port, path: '/api/events', agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = { event: 'message', data: '' };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data += line.slice(6);
            else if (line.startsWith('retry: ')) ev.event = 'retry';
          }
          events.push(ev);
          if (until(events, res)) {
            clearTimeout(timer);
            req.destroy();
            resolve({ events, headers: res.headers });
            return;
          }
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out waiting for events; got ${events.map((e) => e.event).join(',')}`));
    }, timeoutMs);
    req.on('error', (err) => {
      if (!req.destroyed) reject(err);
    });
  });
}

async function waitFor(fn, { timeoutMs = 8000, everyMs = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) return a.address;
  }
  return null;
}

describe('control panel API on a running app', () => {
  let app;
  let port;
  let root;
  const call = (method, p, opts) => request(port, method, p, opts);

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-server-'));
    app = await startApp({ dataDir: path.join(root, 'data'), panelPort: 0, inputPort: 0, quiet: true });
    port = app.panelPort;
  });

  after(async () => {
    await app?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('GET /api/state has every part of State', async () => {
    const r = await call('GET', '/api/state');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(r.json).sort(), ['addresses', 'app', 'update', 'config', 'configRecovery', 'dataDir', 'deletedBack', 'expressions', 'feed', 'input',
      'inputs', 'lif', 'missingRaces', 'names', 'namesNeeded', 'noRace', 'now', 'outputs', 'races', 'seen', 'setAside',
      'startConflicts', 'version'].sort());
    assert.equal(r.json.version, 1);
    assert.ok(Math.abs(r.json.now - Date.now()) < 5000);
    assert.equal(r.json.input.listening, true);
    assert.equal(r.json.input.port, app.inputPort);
    assert.equal(r.json.config.panel.port, port, 'the panel shows the port it is really on');
    assert.deepEqual(r.json.config.races, []);
    assert.deepEqual(r.json.outputs, []);
    assert.equal(r.json.lif.state, 'off');
    assert.ok(Array.isArray(r.json.addresses));
    assert.deepEqual(r.json.seen, { locations: [], contests: [] });
    assert.deepEqual(r.json.setAside, [], 'no contest is set aside (DESIGN 9.2)');
    assert.deepEqual([r.json.missingRaces, r.json.noRace], [[], []], 'no race is missing, no read waits (DESIGN 9.2 R6)');
    // DESIGN 9.15: one input per RR12 port, with what it receives; the expressions to type into RR12
    assert.deepEqual(r.json.inputs.map((i) => [i.port, i.boundPort, i.listening, i.format]), [[5565, app.inputPort, true, null]]);
    assert.deepEqual([r.json.input.ports, r.json.input.listeningCount], [[5565], 1]);
    assert.equal(r.json.expressions.laptime, 'chr(1) & "S," & format([RD_Time];"hh:mm:ss.kkk") & "," & [RD_IDBib]');
    assert.match(r.json.expressions.sr, /^"SR\|" & \[RD_TimingPoint\]/);
    assert.deepEqual([r.json.startConflicts, r.json.deletedBack, r.json.namesNeeded], [[], [], false]);
    assert.deepEqual(r.json.configRecovery, { source: 'new', fellBack: false, brokenFile: null, brokenFiles: [] });
  });

  test('static files: types, no caching of index.html, revalidation, nothing outside public', async () => {
    const index = await call('GET', '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['cache-control'], 'no-store');
    assert.match(index.text, /<title>Split Relay<\/title>/);
    const js = await call('GET', '/app.js');
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(js.headers['cache-control'], 'no-cache');
    const again = await call('GET', '/app.js', { headers: { 'If-None-Match': js.headers.etag } });
    assert.equal(again.status, 304);
    assert.equal((await call('GET', '/style.css')).headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await call('GET', '/icons/logo.svg')).headers['content-type'], 'image/svg+xml');
    // every module the panel imports is served as one (public/running.js: the running rule Split Relay shares)
    const imports = [...js.text.matchAll(/^import [^;]*? from '\.\/([^']+)';$/gm)].map((m) => m[1]);
    assert.ok(imports.includes('running.js'), imports.join(', '));
    for (const f of imports) {
      const r = await call('GET', `/${f}`);
      assert.deepEqual([r.status, r.headers['content-type']], [200, 'text/javascript; charset=utf-8'], f);
    }
    for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/icons/../../DESIGN.md', '/C:%5cWindows%5cwin.ini', '/nope.html']) {
      assert.equal((await call('GET', p)).status, 404, p);
    }
    assert.equal((await call('POST', '/index.html', { body: {} })).status, 405);
  });

  test('errors are JSON with a plain-English message', async () => {
    let r = await call('GET', '/api/nothing');
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no \/api\/nothing/);
    r = await call('DELETE', '/api/state');
    assert.equal(r.status, 405);
    assert.match(r.json.error, /DELETE is not allowed/);
    r = await call('POST', '/api/races', { body: '{"name": ' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'The request body is not valid JSON.');
    r = await call('POST', '/api/races', { body: 'name=x', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
    r = await call('POST', '/api/races', { body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Give the race a name.');
    r = await call('PUT', '/api/settings', { body: { input: { port: 70000 } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /"70000" can't be an RR12 input port: use a whole number from 1024 to 65535/);
    r = await call('PUT', '/api/races/r_gone', { body: { name: 'x' } });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /no race with id "r_gone"/);
    for (const p of ['/api/races/r_gone/crossings']) assert.equal((await call('GET', p)).status, 404);
    for (const p of ['/api/races/r_gone/resend', '/api/races/r_gone/clear', '/api/races/r_gone/gun', '/api/outputs/o_gone/preview', '/api/outputs/o_gone/reconnect']) {
      assert.equal((await call('POST', p, { body: { gun: '10:00:00' } })).status, 404, p);
    }
  });

  test('changes requested by another web page or through a borrowed host name are refused', async () => {
    let r = await call('POST', '/api/races', { body: { name: 'Evil' }, headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /another web page/);
    r = await call('GET', '/api/state', { headers: { Host: `evil.example:${port}` } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Open the control panel at http:\/\/localhost/);
    r = await call('POST', '/api/races', { body: { name: 'Fine', active: false }, headers: { Origin: `http://127.0.0.1:${port}` } });
    assert.equal(r.status, 200, 'the panel\'s own origin is fine');
    r = await call('GET', '/api/state', { headers: { Host: `localhost:${port}` } });
    assert.equal(r.status, 200);
    const id = r.json.config.races.find((x) => x.name === 'Fine').id;
    assert.equal((await call('DELETE', `/api/races/${id}`)).status, 200);
    // review-edges F8: a rebinding domain that starts with this PC's name, with a matching Origin.
    const evil = `${os.hostname().toLowerCase()}.evil.example:${port}`;
    r = await call('PUT', '/api/settings', { body: { filter: { holdSec: 3 } }, headers: { Host: evil, Origin: `http://${evil}` } });
    assert.equal(r.status, 403);
    assert.equal((await call('GET', '/api/state')).json.config.filter.holdSec, 2, 'nothing changed');
    assert.equal((await call('GET', `/api/files?dir=${encodeURIComponent(os.tmpdir())}`, { headers: { Host: evil } })).status, 403);
  });

  test('saving the Control panel card keeps a --port override for this run only (review-edges F9)', async () => {
    // This app runs on a port given at start (as --port does); the saved one is the default.
    const saved = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8')).panel;
    assert.equal(saved().port, 5590);
    const r = await call('PUT', '/api/settings', { body: { panel: { port, allowLan: false } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.config.panel.port, port, 'the panel still shows the port it is on');
    await waitFor(() => saved().allowLan === false, { what: 'the settings file' });
    assert.equal(saved().port, 5590, 'the saved port is not replaced by the one-run port');
    assert.equal(app.config.panel.port, 5590);
  });

  test('from another computer: view only when allowed, nothing at all otherwise', async (t) => {
    const lan = lanAddress();
    if (!lan) return t.skip('this PC has no LAN address');
    let r = await request(port, 'GET', '/api/state', { host: lan });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Watching Split Relay from other computers is switched off/);
    r = await request(port, 'GET', '/', { host: lan });
    assert.equal(r.status, 403);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.equal((await call('PUT', '/api/settings', { body: { panel: { allowLan: true } } })).status, 200);
    try {
      r = await request(port, 'GET', '/api/state', { host: lan });
      assert.equal(r.status, 200);
      assert.equal((await request(port, 'GET', '/', { host: lan })).status, 200);
      r = await request(port, 'POST', '/api/races', { host: lan, body: { name: 'From the tent' } });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /Changes can only be made on the Split Relay PC itself/);
      r = await request(port, 'GET', '/api/files', { host: lan });
      assert.equal(r.status, 403);
      assert.match(r.json.error, /Folders can only be browsed/);
    } finally {
      await call('PUT', '/api/settings', { body: { panel: { allowLan: false } } });
    }
  });

  test('races: create, edit, gun (typed, now, FinishLynx), crossings, resend, clear, delete', async () => {
    const lynxDir = path.join(root, 'lynx');
    fs.mkdirSync(lynxDir, { recursive: true });
    let r = await call('POST', '/api/races', {
      // no contest list and no port: it takes every contest of the SR lines below (DESIGN 9.15 L3)
      body: { name: 'Girls Varsity 5K', eventNumber: '3', round: '1', heat: '1', contests: [], inputPort: null, splits: [{ name: '1K', sources: ['1K-A'] }, { name: '2K', sources: ['2K-A'] }] },
    });
    assert.equal(r.status, 200);
    const race = r.json.config.races.find((x) => x.name === 'Girls Varsity 5K');
    assert.match(race.id, /^r_/);
    const view = r.json.races.find((x) => x.id === race.id);
    assert.deepEqual(view.splits.map((s) => [s.name, s.crossings]), [['1K', 0], ['2K', 0]]);
    assert.equal(view.gunTicks, null);
    assert.equal(view.lynxStart, null);

    r = await call('PUT', `/api/races/${race.id}`, { body: { distance: '5000m' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.config.races.find((x) => x.id === race.id).distance, '5000m');

    r = await call('POST', `/api/races/${race.id}/gun`, { body: { gun: '9:05:00' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.races.find((x) => x.id === race.id).gunText, '09:05:00.000');
    assert.equal(r.json.config.races.find((x) => x.id === race.id).gun, '09:05:00.000', 'stored in the config');

    r = await call('POST', `/api/races/${race.id}/gun`, { body: { gun: '25:00:00' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not a time of day/);
    r = await call('POST', `/api/races/${race.id}/gun`, { body: { colour: 'red' } });
    assert.equal(r.status, 400);

    // the gun is only ever a typed time: "now" (this PC's clock) and "fromLynx" are refused and change nothing
    for (const body of [{ now: true }, { fromLynx: true }, {}]) {
      r = await call('POST', `/api/races/${race.id}/gun`, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error, 'Type the gun time: send { "gun": "10:00:00.000" }.');
    }
    assert.equal((await call('GET', '/api/state')).json.races.find((x) => x.id === race.id).gunText, '09:05:00.000', 'refused bodies leave the typed gun');

    // the FinishLynx start is shown (the panel puts it in the gun box); it is set only when the operator sets it
    assert.equal((await call('PUT', '/api/settings', { body: { lif: { inputDir: lynxDir } } })).status, 200);
    fs.writeFileSync(path.join(lynxDir, '003-1-01.lif'), '3,1,1,Girls Varsity 5K,,,,,,,12:58:49.2595\r\n');
    await waitFor(async () => (await call('GET', '/api/state')).json.races.find((x) => x.id === race.id).lynxStart === 467292595,
      { what: 'RaceView.lynxStart from the FinishLynx header' });
    assert.equal((await call('GET', '/api/state')).json.races.find((x) => x.id === race.id).gunText, '09:05:00.000', 'a FinishLynx start never sets the gun by itself');
    r = await call('POST', `/api/races/${race.id}/gun`, { body: { gun: '12:58:49.2595' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.races.find((x) => x.id === race.id).gunText, '12:58:49.2595');

    // one read so crossings/resend/clear have something to work on
    const sock = net.connect(app.inputPort, '127.0.0.1');
    await new Promise((res) => sock.once('connect', res));
    sock.end('SR|1K-A|254|13:02:00.000|Girls Varsity 5K|Ann|Sample|Hilltop|F\r\n');
    // there is no output yet: once its hold is over the crossing is ready, and the feed says no output took it (9.16 F3)
    const ready = await waitFor(async () => {
      const e = (await call('GET', '/api/state')).json.feed.find((x) => x.bib === '254');
      return e?.status === 'ready' ? e : null;
    }, { what: 'the crossing to be ready' });
    assert.equal(ready.detail, 'Ready — no output took it: there are no outputs yet (add TrackScore on the Outputs tab). It goes out by itself as soon as an output can take it.');
    assert.equal(ready.place, 1);
    const crossings = (await call('GET', `/api/races/${race.id}/crossings`)).json;
    assert.deepEqual(Object.keys(crossings[0]).sort(), ['bib', 'held', 'name', 'place', 'raceTicks', 'reads', 'reason', 'sentAt', 'source', 'splitId', 'splitName', 'team', 'tod'].sort());
    assert.equal(crossings[0].bib, '254');
    assert.equal(crossings[0].place, 1);
    assert.equal(crossings[0].sentAt, null, 'not sent: no output took it');
    assert.equal(crossings[0].raceTicks, 13 * 36e6 + 2 * 6e5 - 467292595);

    // what saving or deleting a race would do to the reads, before it is done (DESIGN 9.2); nothing changes
    const races = (await call('GET', '/api/state')).json.config.races.length;
    r = await call('POST', '/api/races/preview', { body: { race: { name: 'Girls only', eventNumber: '4', contests: ['girls varsity 5k'] } } });
    assert.equal(r.status, 200);
    assert.match(r.json.raceId, /^r_/);
    assert.deepEqual(r.json.moves.map((m) => [m.contest, m.count, m.from.raceId, m.to.raceId]), [['Girls Varsity 5K', 1, race.id, r.json.raceId]]);
    r = await call('POST', '/api/races/preview', { body: { id: race.id, delete: true } });
    assert.deepEqual(r.json.deleted.map((d) => [d.raceId, d.count]), [[race.id, 1]]);
    assert.deepEqual(r.json.setAside.map((a) => [a.contest, a.reason]), [['Girls Varsity 5K', "its race 'Girls Varsity 5K' was deleted"]]);
    // switched off, the race keeps its read; it takes every contest, so new reads would have no race
    r = await call('POST', '/api/races/preview', { body: { id: race.id, race: { active: false } } });
    assert.deepEqual([r.json.moves, r.json.newReads.map((n) => [n.contest, n.from.raceId, n.to.raceId])],
      [[], [['', race.id, null], ['Girls Varsity 5K', race.id, null]]]);
    assert.equal((await call('POST', '/api/races/preview', { body: { id: 'r_nope', delete: true } })).status, 404);
    assert.equal((await call('POST', '/api/races/preview', { body: { race: { name: '' } } })).status, 400);
    assert.equal((await call('POST', '/api/races/preview', { body: [] })).status, 400);
    assert.equal((await call('GET', '/api/state')).json.config.races.length, races, 'a preview changes nothing');

    r = await call('POST', `/api/races/${race.id}/resend`);
    assert.equal(r.status, 200);
    // How many go out depends on the outputs (none here); what the options do is tested on PanelServer below.
    assert.ok(Number.isInteger(r.json.sent) && r.json.sent >= 0, JSON.stringify(r.json));
    r = await call('POST', `/api/races/${race.id}/clear`);
    assert.equal(r.status, 200);
    assert.equal(r.json.races.find((x) => x.id === race.id).runners, 0);
    assert.deepEqual((await call('GET', `/api/races/${race.id}/crossings`)).json, []);
    assert.equal(r.json.feed.find((e) => e.bib === '254').status, 'cleared', 'a cleared read says so');
    // a cleared read is out of use already: deleting the race takes nothing more out of use
    assert.deepEqual((await call('POST', '/api/races/preview', { body: { id: race.id, delete: true } })).json.deleted, []);

    r = await call('DELETE', `/api/races/${race.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.config.races.some((x) => x.id === race.id), false);
    assert.equal(r.json.races.some((x) => x.id === race.id), false);
    await call('PUT', '/api/settings', { body: { lif: { inputDir: '' } } });
  });

  test('outputs: create, preview, reconnect, edit, delete', async () => {
    let r = await call('POST', '/api/outputs', { body: { name: 'TrackScore', host: '127.0.0.1', port: await freePort(), script: XCSCORE } });
    assert.equal(r.status, 200);
    const out = r.json.config.outputs.find((o) => o.name === 'TrackScore');
    assert.match(out.id, /^o_/);
    assert.equal(r.json.outputs.find((o) => o.id === out.id).target, `127.0.0.1:${out.port}`);
    r = await call('POST', `/api/outputs/${out.id}/preview`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['display', 'isJson', 'jsonErrors', 'text', 'warnings']);
    assert.equal(r.json.isJson, true);
    assert.deepEqual(r.json.jsonErrors, []);
    assert.match(r.json.display, /"L2G":"2".*\\0d\\0a$/);
    assert.equal(JSON.parse(r.json.text).D.BIB, '1234');
    r = await call('POST', `/api/outputs/${out.id}/reconnect`);
    assert.equal(r.status, 200);
    assert.ok(r.json.outputs.some((o) => o.id === out.id));
    r = await call('PUT', `/api/outputs/${out.id}`, { body: { enabled: false } });
    assert.equal(r.json.outputs.find((o) => o.id === out.id).state, 'disabled');
    r = await call('POST', '/api/outputs', { body: { name: 'trackscore' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /already an output called/);
    r = await call('DELETE', `/api/outputs/${out.id}`);
    assert.deepEqual(r.json.config.outputs, []);
    assert.deepEqual(r.json.outputs, []);
  });

  test('GET /api/expression follows the input format', async () => {
    let r = await call('GET', '/api/expression');
    assert.equal(r.json.expression, '"SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk") & "|" & [Contest.Name] & "|" & [Firstname] & "|" & [Lastname] & "|" & [Club] & "|" & [Gender]');
    await call('PUT', '/api/settings', { body: { input: { columns: ['location', 'bib', 'time'] } } });
    r = await call('GET', '/api/expression');
    assert.equal(r.json.expression, '"SR|" & [RD_TimingPoint] & "|" & [RD_IDBib] & "|" & format([RD_Time];"hh:mm:ss.kkk")');
    await call('PUT', '/api/settings', { body: { input: { columns: ['location', 'bib', 'time', 'contest', 'first', 'last', 'team', 'gender'] } } });
  });

  test('GET /api/files lists drives, folders and files of the wanted type', async () => {
    const dir = path.join(root, 'browse');
    fs.mkdirSync(path.join(dir, 'Sub folder'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'XCScore.lss'), '');
    fs.writeFileSync(path.join(dir, 'b.LSS'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    let r = await call('GET', `/api/files?dir=${encodeURIComponent(dir)}&ext=.lss`);
    assert.equal(r.status, 200);
    assert.equal(r.json.dir, dir);
    assert.equal(r.json.parent, path.dirname(dir));
    assert.deepEqual(r.json.entries, [
      { name: 'Sub folder', path: path.join(dir, 'Sub folder'), type: 'dir' },
      { name: 'b.LSS', path: path.join(dir, 'b.LSS'), type: 'file' },
      { name: 'XCScore.lss', path: path.join(dir, 'XCScore.lss'), type: 'file' },
    ]);
    r = await call('GET', `/api/files?dir=${encodeURIComponent(path.join(dir, 'XCScore.lss'))}&ext=lss`);
    assert.equal(r.json.dir, dir, 'a file path opens its folder');
    r = await call('GET', `/api/files?dir=${encodeURIComponent(`"${dir}"`)}`);
    assert.equal(r.json.entries.length, 4, 'quotes from "Copy as path" are removed; no ext = every file');
    r = await call('GET', `/api/files?dir=${encodeURIComponent(path.join(dir, 'missing'))}&ext=.lss`);
    assert.equal(r.status, 404);
    assert.match(r.json.error, /doesn't exist/);
    r = await call('GET', '/api/files?ext=.lss');
    assert.equal(r.status, 200);
    if (process.platform === 'win32') {
      assert.equal(r.json.dir, '');
      assert.equal(r.json.parent, null);
      assert.ok(r.json.entries.some((e) => e.path === 'C:\\' && e.type === 'dir'), 'drive C is listed');
    } else {
      assert.equal(r.json.dir, os.homedir());
    }
  });

  test('GET /api/files?times=1 gives each listed file its modified time, for "Use Lynx.ppl (modified today 09:12)"', async () => {
    const dir = path.join(root, 'ppl-times');
    fs.mkdirSync(path.join(dir, 'Meet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Lynx.ppl'), '101,Ashford,Ava,Hilltop,F\r\n');
    fs.writeFileSync(path.join(dir, 'old.PPL'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    const when = new Date(2026, 9, 21, 9, 12, 0);
    fs.utimesSync(path.join(dir, 'Lynx.ppl'), when, when);
    let r = await call('GET', `/api/files?dir=${encodeURIComponent(dir)}&ext=.ppl&times=1`);
    assert.equal(r.status, 200);
    const byName = Object.fromEntries(r.json.entries.map((e) => [e.name, e]));
    assert.deepEqual(Object.keys(byName), ['Meet', 'Lynx.ppl', 'old.PPL']);
    assert.equal(Math.abs(byName['Lynx.ppl'].mtimeMs - when.getTime()) < 2000, true, 'the modified time of the file');
    assert.equal(typeof byName['old.PPL'].mtimeMs, 'number');
    assert.equal('mtimeMs' in byName.Meet, false, 'folders get no time');
    // without times=1 (the Browse dialog for scripts and folders) no file is looked at one by one
    r = await call('GET', `/api/files?dir=${encodeURIComponent(dir)}&ext=.ppl`);
    assert.equal(r.json.entries.some((e) => 'mtimeMs' in e), false);
    const direct = await listFolder(dir, 'ppl', { times: true });
    assert.equal(direct.entries.filter((e) => typeof e.mtimeMs === 'number').length, 2);
  });

  test("the live stream: a full State on connect, then 'feed' at once and 'state' when something changed", async () => {
    const got = sse(port, (evs) => evs.some((e) => e.event === 'feed') && evs.filter((e) => e.event === 'state').length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    const sock = net.connect(app.inputPort, '127.0.0.1');
    await new Promise((res) => sock.once('connect', res));
    sock.end('SR|9K|77|10:00:00.000|Nobody|A|B|C|M\r\n');
    const { events, headers } = await got;
    assert.match(headers['content-type'], /^text\/event-stream/);
    assert.equal(events[0].event, 'retry');
    const first = events.find((e) => e.event === 'state');
    assert.ok(JSON.parse(first.data).config, 'the first state is a full State');
    // race-day-sim F8: the feed goes out as 'feed' events only; GET /api/state still carries it.
    for (const e of events.filter((x) => x.event === 'state')) assert.equal('feed' in JSON.parse(e.data), false);
    assert.ok(Array.isArray((await call('GET', '/api/state')).json.feed));
    const feed = JSON.parse(events.find((e) => e.event === 'feed').data);
    assert.equal(feed.bib, '77');
    assert.equal(feed.status, 'no-race');
    assert.match(feed.detail, /No races are set up yet|No active race/);
  });

  test('LapTime (DESIGN 9.15): one listener per RR12 port, reads routed by port, the detected format, "Switch to" and its preview', async () => {
    let r = await call('PUT', '/api/settings', { body: { input: { ports: [5565, 5566] } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.inputs.map((i) => i.port), [5565, 5566]);
    const second = await waitFor(() => app.inputPortOf(5566), { what: 'the second listener' });
    assert.notEqual(second, app.inputPort);
    const sp = [{ name: 'Split 1', sources: [] }, { name: 'Split 2', sources: [] }];
    r = await call('POST', '/api/races', { body: { name: 'LT Girls', eventNumber: '61', gun: '10:00:00.000', splits: sp } });
    assert.equal(r.status, 200);
    const girls = r.json.config.races.find((x) => x.name === 'LT Girls');
    assert.equal(girls.inputPort, 5565, 'a new race takes the first RR12 input port');
    r = await call('POST', '/api/races', { body: { name: 'LT Boys', eventNumber: '62', gun: '10:00:00.000', splits: sp } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "Port 5565 already feeds the active race 'LT Girls'. Untick Active on one of them, or give this race its own port.");
    r = await call('POST', '/api/races', { body: { name: 'LT Boys', eventNumber: '62', gun: '10:00:00.000', splits: sp, inputPort: 5566 } });
    const boys = r.json.config.races.find((x) => x.name === 'LT Boys');
    r = await call('POST', '/api/races', { body: { name: 'LT Boys JV', eventNumber: '63', gun: '10:00:00.000', splits: sp, inputPort: 5566, active: false } });
    const jv = r.json.config.races.find((x) => x.name === 'LT Boys JV');
    // RR12's FinishLynx exporters: one per race, each to its own port
    for (const [port, bib] of [[app.inputPort, '611'], [second, '622']]) {
      const sock = net.connect(port, '127.0.0.1');
      await new Promise((res) => sock.once('connect', res));
      sock.end(`\x01S,10:03:00.000,${bib}\r\n\x01Z\r\n`);
    }
    const st = await waitFor(async () => {
      const s = (await call('GET', '/api/state')).json;
      return s.feed.some((e) => e.bib === '611') && s.feed.some((e) => e.bib === '622') && s.inputs.every((i) => i.format === 'laptime') ? s : null;
    }, { what: 'both reads and the detected formats' });
    assert.equal(st.feed.find((e) => e.bib === '611').raceName, 'LT Girls');
    assert.equal(st.feed.find((e) => e.bib === '622').raceName, 'LT Boys');
    // each feed row says which RR12 port (which exporter) it came in on: the panel shows it with two ports
    assert.deepEqual([st.feed.find((e) => e.bib === '611').port, st.feed.find((e) => e.bib === '622').port], [5565, 5566]);
    assert.deepEqual(st.inputs.map((i) => [i.port, i.listening, i.format]), [[5565, true, 'laptime'], [5566, true, 'laptime']]);
    assert.equal(st.input.listeningCount, 2);
    assert.equal(st.namesNeeded, true, 'LapTime lines carry bibs only and no people file is chosen');
    assert.ok(st.input.connections.every((c) => [5565, 5566].includes(c.port)) || st.input.connections.length === 0);
    // "Switch to LT Boys JV": what it would do, then do it
    r = await call('POST', '/api/races/preview', { body: { id: jv.id, activate: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.unticked, [{ raceId: boys.id, raceName: 'LT Boys', why: 'both take port 5566' }]);
    assert.deepEqual(r.json.kept.map((k) => [k.contest, k.raceName, k.count]), [['Port 5566', 'LT Boys', 1]], 'LT Boys keeps its read');
    assert.equal((await call('GET', '/api/state')).json.config.races.find((x) => x.id === boys.id).active, true, 'a preview changes nothing');
    r = await call('POST', `/api/races/${jv.id}/activate`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.unticked, [{ raceId: boys.id, raceName: 'LT Boys', why: 'both take port 5566' }]);
    assert.deepEqual(r.json.config.races.filter((x) => x.name.startsWith('LT')).map((x) => [x.name, x.active]),
      [['LT Girls', true], ['LT Boys', false], ['LT Boys JV', true]]);
    assert.ok(r.json.races && r.json.feed, 'the answer is State, to repaint from');
    assert.equal((await call('POST', '/api/races/r_gone/activate')).status, 404);
    assert.equal((await call('POST', '/api/races/r_gone/restore')).status, 404);
    // the second port goes again; a port that feeds an Active race can't
    r = await call('PUT', '/api/settings', { body: { input: { ports: [5565] } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Port 5566 feeds the active race 'LT Boys JV'/);
    for (const x of [girls, boys, jv]) assert.equal((await call('DELETE', `/api/races/${x.id}`)).status, 200);
    r = await call('PUT', '/api/settings', { body: { input: { ports: [5565] } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.inputs.map((i) => i.port), [5565]);
    assert.equal(app.inputPortOf(5566), null);
  });

  test('Review (DESIGN 9.17): pause and play a split, the Review list, the runner view, Move, made-up times, their errors', async () => {
    const sp = [{ name: '1K', sources: [] }, { name: '2K', sources: [] }, { name: '3K', sources: [] }];
    let r = await call('POST', '/api/races', { body: { name: 'Review Boys', eventNumber: '71', gun: '10:00:00.000', splits: sp, inputPort: 5565 } });
    assert.equal(r.status, 200, r.text);
    const race = r.json.config.races.find((x) => x.name === 'Review Boys');
    const [s1, s2] = race.splits.map((x) => x.id);
    // (9.23: the counts gained flagged, pinned and madeUp)
    assert.deepEqual(r.json.races.find((x) => x.id === race.id).review, { missing: 0, estimable: 0, checks: 0, checkRunners: 0, manual: 0, flagged: 0, pinned: 0, madeUp: 0 });
    // twelve runners pass the three mats; bib 705 missed 2K
    const lines = [];
    for (let k = 1; k <= 3; k++) {
      for (let i = 0; i < 12; i++) {
        if (i === 5 && k === 2) continue;
        const sec = 180 * k * (1 + 0.02 * i);
        lines.push(`\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${700 + i}\r\n`);
      }
    }
    const sock = net.connect(app.inputPort, '127.0.0.1');
    await new Promise((res) => sock.once('connect', res));
    sock.end(lines.join(''));
    const review = await waitFor(async () => {
      const x = (await call('GET', `/api/races/${race.id}/review`)).json;
      return x?.checks?.length === 1 ? x : null;
    }, { what: 'the column check of bib 705' });
    assert.deepEqual(review.checks.map((c) => [c.bib, c.fromName, c.toName, c.reason]), [['705', '2K', '3K', 'Looks like 3K, not 2K (missed 2K?)']]);
    // (9.23: Review gained 'flags', the splits that look wrong)
    assert.deepEqual(Object.keys(review).sort(), ['active', 'checks', 'counts', 'finishedNotSent', 'flags', 'gunSet', 'manual', 'missing', 'raceId', 'raceName']);
    // the runner view
    r = await call('GET', `/api/races/${race.id}/runners/705`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.columns.map((c) => [c.splitName, c.held]), [['1K', null], ['2K', 'check'], ['3K', null]]);
    assert.equal(r.json.suspect, true);
    assert.equal((await call('GET', `/api/races/${race.id}/runners/999`)).json.found, false);
    // Move it: the answer has the Review list as it is now; then 2K is missing, with an estimate
    r = await call('POST', `/api/races/${race.id}/assign`, { body: { bib: '705', all: 'move' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.assigned, 1);
    assert.deepEqual(r.json.review.checks, []);
    const miss = r.json.review.missing;
    assert.deepEqual(miss.map((m) => [m.bib, m.splitId, m.sendable]), [['705', s2, true]]);
    assert.match(miss[0].basis, /^From 1K 3:18\.0 and 3K 9:54\.0, placed like the 11 runners nearest in pace \(2K at 50\.0% of that stretch\)\.$/);
    // errors, in words
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2, time: '12:00' } });
    assert.deepEqual([r.status, r.json.error], [409, "12:00.0 is not before bib 705's 3K (9:54.0). A 2K time must come before it."]);
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2, time: 'x' } });
    assert.equal(r.status, 400);
    assert.equal((await call('POST', `/api/races/${race.id}/manual`, { body: [] })).status, 400);
    assert.equal((await call('POST', '/api/races/r_nope/manual', { body: { bib: '705', splitId: s2 } })).status, 404);
    assert.equal((await call('POST', `/api/races/${race.id}/assign`, { body: { bib: '705', all: 'move' } })).status, 409);
    // send the estimate: a made-up time, in the race's crossings and the runner view
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.added.map((a) => [a.bib, a.splitName, a.source, a.timeText]), [['705', '2K', 'made-up', '6:36.0']]);
    assert.deepEqual(r.json.review.manual.map((m) => [m.bib, m.state]), [['705', 'active']]);
    assert.equal((await call('GET', `/api/races/${race.id}/crossings`)).json.find((c) => c.bib === '705' && c.splitId === s2).source, 'made-up');
    assert.deepEqual((await call('GET', `/api/races/${race.id}/runners/705`)).json.columns.map((c) => c.source), ['read', 'made-up', 'read']);
    // take it back
    r = await call('DELETE', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.removed, true);
    assert.equal(r.json.review.missing.length, 1);
    assert.equal((await call('DELETE', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2 } })).status, 404);
    // "Send all": the rows the operator approved, in one request; a row that can't go is skipped with the reason
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { items: [{ bib: '705', splitId: s2 }, { bib: '700', splitId: s1 }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.added.map((a) => [a.bib, a.splitName, a.source, a.timeText]), [['705', '2K', 'made-up', '6:36.0']]);
    assert.deepEqual(r.json.skipped, [{ bib: '700', splitId: s1, why: 'Bib 700 has a real 1K time (3:00.0) from the mats.' }]);
    assert.deepEqual(r.json.review.missing, []);
    r = await call('DELETE', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2 } });
    assert.equal(r.json.wasSent, false, 'no output sends this race in this test');
    // DESIGN 9.23, fix a runner: find, the race grid, Move, Undo, Send again, a time of day, and the words of each refusal
    const [, , s3] = race.splits.map((x) => x.id);
    r = await call('GET', '/api/find?q=0705');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.matches.map((m) => [m.raceId, m.bib, m.by, m.filled]), [[race.id, '705', 'bib', 2]]);
    assert.deepEqual((await call('GET', '/api/find')).json, { q: '', matches: [] });
    r = await call('GET', `/api/races/${race.id}/grid`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.rows.find((x) => x.bib === '705').cells.map((c) => c.kind), ['read', 'missing', 'moved']);
    assert.deepEqual((await call('GET', `/api/races/${race.id}/grid?since=${r.json.rev}`)).json, { rev: r.json.rev, unchanged: true });
    assert.equal((await call('GET', '/api/races/r_nope/grid')).status, 404);
    const pass3 = (await call('GET', `/api/races/${race.id}/runners/705`)).json.passes.find((x) => x.splitId === s3);
    const move = (body, headers) => call('POST', `/api/races/${race.id}/runners/705/move`, { body, headers });
    r = await move([]);
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "tod": <time of day of the pass>, "to": "<split id>" | "none" | "finish" | "count" | "keep" }.']);
    r = await move({ tod: pass3.tod, to: 's_nope' });
    assert.deepEqual([r.status, r.json.error], [400, 'Review Boys has no such split. Reload: the race may have changed.']);
    r = await move({ tod: 1, to: s2 });
    assert.deepEqual([r.status, r.json.error], [404, 'Bib 705 has no pass at that time any more. It shows again now.']);
    r = await move({ tod: pass3.tod, to: s3 });
    assert.deepEqual([r.status, r.json.error], [409, '9:54.0 is 3K already.']);
    r = await move({ tod: pass3.tod, to: s2, from: s2 });
    assert.deepEqual([r.status, r.json.error], [409, '9:54.0 is 3K now, not 2K: it was changed in another window. Look again.']);
    r = await move({ tod: pass3.tod, to: s2 }, { Origin: 'http://evil.example' });
    assert.deepEqual([r.status, r.json.error], [403, 'Split Relay refused a change requested by another web page.']);
    r = await move({ tod: pass3.tod, to: s2, from: s3 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['change', 'review', 'runner']);
    assert.deepEqual([r.json.change.kind, r.json.change.text, r.json.change.undoable], ['move', '9:54.0 moved to 2K', true]);
    assert.deepEqual(r.json.runner.columns.map((c) => c.kind), ['read', 'moved', 'not-yet']);
    const fix = r.json.change.fix;
    const undo = (body) => call('POST', `/api/races/${race.id}/undo`, { body });
    r = await undo([]);
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "fix": 17 }: the change to undo.']);
    r = await undo({ fix: 9999 });
    assert.deepEqual([r.status, r.json.error], [404, 'There is no change 9999 in Review Boys. Change it by hand.']);
    r = await undo({ fix });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.undone, r.json.change.text, r.json.runner.columns.map((c) => c.kind)], [fix, 'Undone: 9:54.0 is the 3K split again', ['read', 'missing', 'moved']]);
    r = await undo({ fix });
    assert.deepEqual([r.status, r.json.error], [409, 'That change was undone already.']);
    // "Send bib 705 again": nothing differs (no output sends this race)
    r = await call('POST', `/api/races/${race.id}/runners/705/send`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.sent, r.json.outputs, r.json.skipped, r.json.runner.bib, !!r.json.review], [0, 0, [], '705', true]);
    // 9.24 "Stop sending this runner" and "Send this runner again": a change like any other, the runner and the list back
    r = await call('POST', `/api/races/${race.id}/runners/705/stop`, { body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.change.kind, r.json.change.text, r.json.runner.sending.off.fromText, r.json.review.off.map((x) => x.bib)], ['stop', 'Not sent after 9:54.0', '9:54.0', ['705']]);
    r = await call('POST', `/api/races/${race.id}/runners/705/stop`, { body: {} });
    assert.deepEqual([r.status, r.json.error], [409, 'Bib 705 is not sent already.']);
    r = await call('POST', `/api/races/${race.id}/runners/705/resume`);
    assert.deepEqual([r.status, r.json.change.kind, r.json.change.text, r.json.runner.sending.off, r.json.review.off], [200, 'resume', 'Sent again', null, undefined]);
    r = await call('POST', `/api/races/${race.id}/runners/705/resume`);
    assert.deepEqual([r.status, r.json.error], [409, 'Bib 705 is sent as usual already.']);
    // a time of day, said as one; an empty cell another window filled; a time of day typed as a race time
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2, tod: '10:06:40.0', ifEmpty: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.added[0].timeText, r.json.added[0].basis, r.json.change.kind, r.json.runner.columns[1].kind],
      ['6:40.0', 'Typed in Review as the time of day 10:06:40.0.', 'fill', 'typed']);
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2, tod: '10:06:37.0', ifEmpty: true } });
    assert.deepEqual([r.status, r.json.error], [409, 'Bib 705 has a typed 2K time already (6:40.0): another window sent it. It shows now.']);
    r = await call('POST', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2, time: '10:06:37.0' } });
    assert.deepEqual([r.status, r.json.error], [400, '"10:06:37.0" is 10 h 6 min of race time. If it is a time of day, send it as one. Race times look like 8:12.3.']);
    r = await call('DELETE', `/api/races/${race.id}/manual`, { body: { bib: '705', splitId: s2 } });
    assert.deepEqual([r.status, r.json.change.kind, r.json.runner.columns[1].kind], [200, 'remove', 'missing']);
    // 9.23 F13, "Missed 3K: add it": the pass in 3K moves on (past the last split: an extra pass) and 3K is filled, one
    // change; its words; an empty cell is filled with its own Send instead
    const missed = (body) => call('POST', `/api/races/${race.id}/runners/705/missed`, { body });
    r = await missed([]);
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "splitId": "<the split the mat missed>", "passTod": <time of day of the pass in it> }.']);
    r = await missed({ splitId: s2 });
    assert.deepEqual([r.status, r.json.error], [409, 'Bib 705 has no time in 2K: it is missing, with no later time in it to move on. Send its time instead.']);
    r = await missed({ splitId: s3, passTod: 1 });
    assert.deepEqual([r.status, r.json.error], [409, '3K has 9:54.0 now, not the pass you saw: it was changed in another window. Look again.']);
    r = await missed({ splitId: s3, passTod: pass3.tod, time: '9:00' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['added', 'change', 'review', 'runner']);
    assert.deepEqual([r.json.change.kind, r.json.change.text, r.json.added[0].source, r.json.runner.columns.map((c) => c.kind)],
      ['missed', 'Missed 3K added (9:00.0, typed); 9:54.0 is an extra pass now', 'typed', ['read', 'missing', 'typed']]);
    r = await undo({ fix: r.json.change.fix });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.runner.columns.map((c) => c.kind), ['read', 'missing', 'moved']);
    // from another computer: find and the grid can be watched, nothing can be changed
    const lan = lanAddress();
    if (lan) {
      assert.equal((await call('PUT', '/api/settings', { body: { panel: { allowLan: true } } })).status, 200);
      try {
        assert.equal((await request(port, 'GET', '/api/find?q=705', { host: lan })).status, 200);
        assert.equal((await request(port, 'GET', `/api/races/${race.id}/grid`, { host: lan })).status, 200);
        for (const [path2, body] of [[`/api/races/${race.id}/runners/705/move`, { tod: pass3.tod, to: s2 }], [`/api/races/${race.id}/runners/705/send`, {}], [`/api/races/${race.id}/undo`, { fix }],
          [`/api/races/${race.id}/runners/705/missed`, { splitId: s3 }]]) {
          r = await request(port, 'POST', path2, { host: lan, body });
          assert.equal(r.status, 403, path2);
          assert.match(r.json.error, /^Changes can only be made on the Split Relay PC itself/);
        }
      } finally {
        await call('PUT', '/api/settings', { body: { panel: { allowLan: false } } });
      }
    }
    // pause 1K, then play it
    r = await call('POST', `/api/races/${race.id}/splits/${s1}/sending`, { body: { on: false } });
    assert.equal(r.status, 200, r.text);
    let view = r.json.races.find((x) => x.id === race.id);
    assert.deepEqual(view.splits.map((x) => x.sending), [false, true, true]);
    assert.equal(r.json.config.races.find((x) => x.id === race.id).splits[0].sending, false, 'saved in the settings');
    assert.equal((await call('POST', `/api/races/${race.id}/splits/${s1}/sending`, { body: { on: 'no' } })).status, 400);
    assert.equal((await call('POST', `/api/races/${race.id}/splits/s_nope/sending`, { body: { on: true } })).status, 404);
    r = await call('POST', `/api/races/${race.id}/splits/${s1}/sending`, { body: { on: true } });
    view = r.json.races.find((x) => x.id === race.id);
    assert.deepEqual([view.splits[0].sending, view.splits[0].held], [true, 0]);
    // nothing finished: nothing to send with a finish place
    r = await call('POST', `/api/races/${race.id}/send-finished`, { body: { all: true } });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /^Nothing to send/);
    assert.equal((await call('DELETE', `/api/races/${race.id}`)).status, 200);
  });

  test('the panel moves to another port live, without restarting', async () => {
    const next = await freePort();
    let r = await call('PUT', '/api/settings', { body: { panel: { port: app.inputPort } } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /both \d+\. Use two different ports/, 'validated before any port is opened');
    r = await call('PUT', '/api/settings', { body: { panel: { port: next, allowLan: false } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.config.panel.port, next);
    const moved = await request(next, 'GET', '/api/state');
    assert.equal(moved.status, 200);
    await waitFor(() => request(port, 'GET', '/api/state').then(() => false, () => true), { what: 'the old port to close' });
    port = next;
    assert.equal(app.panelPort, next);
  });
});

describe('PanelServer on its own', () => {
  function fakeApp() {
    const st = { version: 1, now: 0, n: 0 };
    return {
      st,
      state: () => ({ ...st, now: Date.now() }),
      allowLan: () => false,
      expression: () => 'x',
    };
  }

  /** Every event of the stream during `ms` milliseconds, while `during()` runs. */
  function collect(port, ms, during = () => {}) {
    return new Promise((resolve, reject) => {
      let all = '';
      const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => { all += c; });
        during();
      });
      req.on('error', (err) => { if (!req.destroyed) reject(err); });
      setTimeout(() => {
        req.destroy();
        resolve(all.split('\n\n').filter(Boolean).map((b) => (/^event: (\w+)/m.exec(b)?.[1] ?? (b.startsWith('retry') ? 'retry' : 'message'))));
      }, ms);
    });
  }

  test("'state' events: at most two a second, and only when State changed", async (t) => {
    const app = fakeApp();
    const panel = new PanelServer({ app, stateIntervalMs: 500, pollMs: 60_000, heartbeatMs: 60_000 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    let spam;
    const busy = await collect(port, 1300, () => {
      spam = setInterval(() => {
        app.st.n++;
        panel.notify();
      }, 10);
    });
    clearInterval(spam);
    const states = busy.filter((e) => e === 'state').length;
    assert.ok(states >= 3 && states <= 5, `1 on connect + at most 2 a second while State changes: got ${states}`);
    await new Promise((r) => setTimeout(r, 600)); // the last change goes out
    const quiet = await collect(port, 800, () => {
      for (let i = 0; i < 20; i++) panel.notify();
    });
    assert.equal(quiet.filter((e) => e === 'state').length, 1, 'only the one sent on connect: nothing changed');
  });

  test('a heartbeat keeps the page from thinking the connection is lost', async (t) => {
    const panel = new PanelServer({ app: fakeApp(), heartbeatMs: 100 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    const { events } = await sse(port, (evs) => evs.some((e) => e.event === 'message' && e.data === 'ping'), { timeoutMs: 3000 });
    assert.ok(events.length >= 3);
  });

  test('a port already in use is reported in plain words', async (t) => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
    t.after(() => blocker.close());
    const panel = new PanelServer({ app: fakeApp() });
    t.after(() => panel.close());
    await assert.rejects(panel.listen(blocker.address().port), /already in use by another program/);
  });

  test('address checks', async () => {
    assert.equal(isLoopback('127.0.0.1'), true);
    assert.equal(isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(isLoopback('::1'), true);
    assert.equal(isLoopback('192.168.0.21'), false);
    assert.equal(isLoopback('::ffff:192.168.0.21'), false);
    assert.equal(isLoopback(undefined), false);
    const pc = { hostname: 'Timing-Laptop', suffixes: ['lan', 'meet.example.org'] };
    for (const h of ['localhost:5590', '127.0.0.1:5590', '[::1]:5590', '192.168.0.21:5590', 'timing-laptop:5590',
      'TIMING-LAPTOP', 'app.localhost', 'timing-laptop.lan:5590', 'timing-laptop.meet.example.org', 'timing-laptop.lan.',
      'timing-laptop.local:5590']) {
      assert.equal(hostAllowed(h, pc), true, h);
    }
    // review-edges F8: this PC's name followed by somebody else's domain is a rebinding attempt, and so is any
    // other single-word name.
    for (const h of ['evil.example:5590', 'localhost.evil.example', '[zz]:1', 'timing-laptop.evil.example:5590',
      'timing-laptop.lan.evil.example', 'other-pc:5590', 'evil', 'lan']) {
      assert.equal(hostAllowed(h, pc), false, h);
    }
    // This PC by default.
    assert.equal(hostAllowed(os.hostname()), true);
    assert.equal(hostAllowed(`${os.hostname()}:5590`), true);
    assert.equal(hostAllowed(`${os.hostname()}.evil.example`), false);
    await assert.rejects(listFolder(path.join(os.tmpdir(), 'surely-not-here-' + Date.now())), (err) => err.status === 404);
  });

  test("the stream's 'state' events leave out the feed, and a new feed entry alone sends no 'state' (race-day-sim F8)", async (t) => {
    const app = fakeApp();
    app.st.feed = [{ id: 1, bib: '1' }];
    const panel = new PanelServer({ app, stateIntervalMs: 50, pollMs: 60_000, heartbeatMs: 60_000 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    const datas = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: state')) datas.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      });
    });
    t.after(() => req.destroy());
    await waitFor(() => datas.length === 1, { what: 'the state on connect' });
    assert.equal('feed' in datas[0], false);
    assert.equal(datas[0].n, 0);
    // Only the feed changes: nothing to send (its rows went out as 'feed' events).
    for (let i = 2; i < 20; i++) {
      app.st.feed = [{ id: i, bib: String(i) }, ...app.st.feed];
      panel.notify();
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(datas.length, 1);
    app.st.n = 1;
    panel.notify();
    await waitFor(() => datas.length === 2, { what: 'a state after a real change' });
    assert.equal(datas[1].n, 1);
    assert.equal('feed' in datas[1], false);
  });

  test("'feed' events are batched: an entry updated twice goes once, a flood only its newest 600 (revision 3)", async (t) => {
    const app = fakeApp();
    const panel = new PanelServer({ app, stateIntervalMs: 50, pollMs: 60_000, heartbeatMs: 60_000, feedGapMs: 100 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    const feeds = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('event: feed')) feeds.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      });
    });
    t.after(() => req.destroy());
    await waitFor(() => panel.clientCount === 1, { what: 'the stream' });
    // a single read shows at once
    const one = { id: 1, bib: '1', status: 'held' };
    panel.feed(one);
    await waitFor(() => feeds.length === 1, { what: 'the first entry' });
    // updated in place twice before the next batch: one event, with the newest content
    one.status = 'sent';
    panel.feed(one);
    one.place = 3;
    panel.feed(one);
    await waitFor(() => feeds.length === 2, { what: 'the update' });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(feeds.slice(1).map((e) => [e.id, e.status, e.place]), [[1, 'sent', 3]]);
    // an RR12 Replay: 5,000 entries in one go; the panel keeps 600, so only the newest 600 are sent, in order
    feeds.length = 0;
    for (let i = 2; i <= 5001; i++) panel.feed({ id: i, bib: String(i), status: 'duplicate' });
    await waitFor(() => feeds.length === 600, { what: 'the newest 600' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(feeds.length, 600);
    assert.deepEqual([feeds[0].id, feeds.at(-1).id], [4402, 5001]);
    assert.ok(feeds.every((e, i) => i === 0 || e.id > feeds[i - 1].id));
  });

  test('POST /api/races/:id/resend passes its options on and returns what the app says', async (t) => {
    const calls = [];
    const app = {
      ...fakeApp(),
      resendRace: (id, opts) => {
        calls.push([id, opts]);
        if (id === 'r_paused' && !opts.force) {
          throw Object.assign(new Error('Girls 5K is not active. Resending it would make TrackScore switch to its event.'), { status: 409 });
        }
        if (id === 'r_old') return 4; // an app that still answers with a count
        if (id === 'r_engine' && !opts.force) {
          // the engine's own refusal, passed on by an app that does not turn it into an HTTP status
          throw Object.assign(new Error('Boys 5K is not active.'), { code: 'RACE_INACTIVE' });
        }
        return { sent: 12, skippedFinished: 3, outputs: [{ outputId: 'o_1', name: 'TrackScore', sent: 12 }] };
      },
    };
    const panel = new PanelServer({ app, pollMs: 60_000, heartbeatMs: 60_000 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    let r = await request(port, 'POST', '/api/races/r_live/resend', { body: { includeFinished: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { sent: 12, skippedFinished: 3, outputs: [{ outputId: 'o_1', name: 'TrackScore', sent: 12 }] });
    assert.deepEqual(calls.at(-1), ['r_live', { includeFinished: true, force: false }]);
    r = await request(port, 'POST', '/api/races/r_live/resend');
    assert.deepEqual(calls.at(-1), ['r_live', { includeFinished: false, force: false }], 'no body: the safe defaults');
    // trackscore-compat F2: an inactive race is refused with the app's own words, unless forced.
    r = await request(port, 'POST', '/api/races/r_paused/resend', { body: {} });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not active/);
    r = await request(port, 'POST', '/api/races/r_paused/resend', { body: { force: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.at(-1), ['r_paused', { includeFinished: false, force: true }]);
    // Only a real true counts: "true" typed into a tool is not a decision to wipe TrackScore's live race.
    r = await request(port, 'POST', '/api/races/r_paused/resend', { body: { force: 'true' } });
    assert.equal(r.status, 409);
    r = await request(port, 'POST', '/api/races/r_engine/resend');
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'Boys 5K is not active.');
    assert.deepEqual((await request(port, 'POST', '/api/races/r_old/resend')).json, { sent: 4 });
    r = await request(port, 'POST', '/api/races/r_live/resend', { body: [true] });
    assert.equal(r.status, 400);
  });

  test("saving the panel port it already runs on leaves the saved port alone (review-edges F9)", async (t) => {
    const patches = [];
    const app = { ...fakeApp(), checkSettings: () => {}, updateSettings: async (p) => { patches.push(p); } };
    const panel = new PanelServer({ app, pollMs: 60_000, heartbeatMs: 60_000 });
    const port = await panel.listen(0);
    t.after(() => panel.close());
    assert.equal((await request(port, 'PUT', '/api/settings', { body: { panel: { port, allowLan: true } } })).status, 200);
    assert.deepEqual(patches.at(-1), { panel: { allowLan: true } });
    assert.equal((await request(port, 'PUT', '/api/settings', { body: { panel: { port: String(port) }, filter: { holdSec: 1 } } })).status, 200);
    assert.deepEqual(patches.at(-1), { panel: {}, filter: { holdSec: 1 } });
    assert.equal(panel.port, port, 'no move');
  });
});

// ---- DESIGN 9.22: meet setup on a running app ---------------------------------------------------------------------
// Its own data folder, with config.json written first: RR12 and panel ports 17xxx, outputs on capture listeners this
// test opened. Nothing here may name 5565, 5590, 5555 or 5000 (the user's live relay and TrackScore may be running).

/** A stand-in for TrackScore's port: the scoreboard packets it is sent. */
async function captureListener() {
  const chunks = [];
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('data', (c) => chunks.push(c.toString('latin1')));
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    packets: () => chunks.join('').split('{"T":').slice(1).map((p) => `{"T":${p}`.trim()),
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

/** TrackScore's web page for Set up from TrackScore: the fixtures (no athletes), the requests kept. */
async function fakeTrackScoreWeb() {
  const fx = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const body = { '/api/xc/race': fx('trackscore-race.json'), '/api/xc/schedule?meetId=meet-fixture-1': fx('trackscore-schedule.json'),
      '/api/xc/schedule': fx('trackscore-schedule-nomeetid.json') }[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(body ?? '{"error":"API route not found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(() => r())) };
}

/** Every TrackScore read of these tests goes through this: never the live TrackScore's ports. */
function guardedGet(opts, cb) {
  if (opts.port === 5000 || opts.port === 5555) throw new Error(`a test asked TrackScore's live port ${opts.port}`);
  return http.get(opts, cb);
}

/** A data folder whose config.json is written before the start, so no start can take the live relay's ports. */
function meetDataDir(root, name, extra = {}) {
  const dataDir = path.join(root, name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ input: { ports: [17565, 17566] }, panel: { port: 17590 }, ...extra }));
  return dataDir;
}

const WOMEN_SPLITS = ['800m', '1500m', '2400m', '3100m', '4200m', '4400m', '5300m'].map((name) => ({ name }));
const MEN_SPLITS = ['800m', '1500m', '2500m', '3500m', '4500m', '5500m', '6400m', '7100m'].map((name) => ({ name }));

describe('meet setup on a running app (DESIGN 9.22)', () => {
  let app;
  let port;
  let root;
  let dataDir;
  let cap;
  let tsWeb;
  /** what the path check was asked, and a gate it waits at */
  const paths = { gate: null, asked: [] };
  const call = (method, p, opts) => request(port, method, p, opts);
  const state = async () => (await call('GET', '/api/state')).json;
  const configBytes = () => fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8');
  const lapTimes = async (rrPort, lines) => {
    const sock = net.connect(app.inputPortOf(rrPort), '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.end(lines.map(([tod, bib]) => `\x01S,${tod},${bib}\r\n`).join(''));
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-meet-'));
    cap = await captureListener();
    tsWeb = await fakeTrackScoreWeb();
    dataDir = meetDataDir(root, 'data', { meet: { trackScoreWebPort: tsWeb.port } });
    app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true, trackScoreGet: guardedGet,
      // R17: port 17599 stands for a port another copy of Split Relay listens on (no real port is tried)
      portTaken: async (p) => p === 17599,
      checkPath: async (p) => {
        paths.asked.push(p);
        if (paths.gate) await paths.gate;
        return 'yes';
      } });
    port = app.panelPort;
    // the race-day setup of 2026-10-21, on test ports
    for (const body of [
      { name: 'Womens Race', eventNumber: '2', distance: '6K', inputPort: 17565, splits: WOMEN_SPLITS },
      { name: 'Mens Race', eventNumber: '1', inputPort: 17565, active: false, splits: MEN_SPLITS },
    ]) assert.equal((await call('POST', '/api/races', { body })).status, 200);
    const r = await call('POST', '/api/outputs', { body: { name: 'TrackScore', host: '127.0.0.1', port: cap.port, script: XCSCORE } });
    assert.equal(r.status, 200);
  });

  after(async () => {
    await app?.stop();
    await cap?.close();
    await tsWeb?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('State says which data folder this copy uses', async () => {
    assert.equal((await state()).dataDir, path.resolve(dataDir));
  });

  test('Save meet setup: data\\meets\\<name>.json with the text returned, listed; saved again it replaces it', async () => {
    let r = await call('POST', '/api/meet/save');
    assert.equal(r.status, 200);
    const today = new Date();
    const name = `Meet ${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.deepEqual([r.json.name, r.json.fileName, r.json.replaced], [name, `${name}.json`, false]);
    assert.equal(r.json.path, path.join(path.resolve(dataDir), 'meets', `${name}.json`));
    assert.equal(fs.readFileSync(r.json.path, 'utf8'), r.json.text);
    const meet = JSON.parse(r.json.text);
    assert.deepEqual(meet.races.map((x) => [x.name, x.splits.length]), [['Womens Race', 7], ['Mens Race', 8]]);
    assert.equal(meet.outputs[0].port, cap.port);
    assert.equal((await state()).config.meet.name, '', 'Save does not name the meet');
    r = await call('POST', '/api/meet/save');
    assert.equal(r.json.replaced, true);
    assert.equal(fs.readdirSync(path.join(dataDir, 'meets', 'old')).length, 1, 'the copy it replaced is kept');
    r = await call('GET', '/api/meet/files');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.files.map((f) => [f.fileName, f.name, f.races, f.outputs]), [[`${name}.json`, name, 2, 1]]);
    assert.equal(r.json.dir, path.join(path.resolve(dataDir), 'meets'));
  });

  test('a preview changes nothing; a saved meet is looked up only in data\\meets', async () => {
    const before = configBytes();
    const mtime = fs.statSync(path.join(dataDir, 'config.json')).mtimeMs;
    const st = await state();
    const file = { splitRelayMeet: 1, name: 'Fall Classic', races: [{ name: 'Girls 5K', eventNumber: '3', inputPort: 17566, splits: ['1K', '2K'] }],
      names: { pplPath: 'C:\\Lynx\\Meet.ppl' } };
    const r = await call('POST', '/api/meet/preview', { body: { meet: file, fileName: 'Fall Classic.json' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.added.map((i) => i.text), ['Girls 5K · Event 3-1-1 · 2 splits: 1K, 2K · port 17566 · Active']);
    assert.deepEqual(r.json.source, { kind: 'file', fileName: 'Fall Classic.json', savedAt: null, savedOn: null, otherPc: false });
    assert.deepEqual(r.json.removable.map((x) => x.name), ['Womens Race', 'Mens Race']);
    assert.ok(typeof r.json.base === 'string' && r.json.readsPlan && 'moves' in r.json.readsPlan);
    assert.deepEqual(paths.asked, ['C:\\Lynx\\Meet.ppl']);
    assert.equal(configBytes(), before);
    assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mtimeMs, mtime);
    assert.deepEqual((await state()).config, st.config);
    for (const saved of ['..\\config.json', '../config.json', 'nope.json', 'CON', 'before-load/../x.json']) {
      const x = await call('POST', '/api/meet/preview', { body: { saved } });
      assert.ok([400, 404].includes(x.status), saved);
    }
    assert.equal((await call('POST', '/api/meet/preview', { body: {} })).json.error,
      'Send { "meet": … } (a meet file), { "saved": "<file name>" } or { "trackscore": true }.');
    assert.equal((await call('POST', '/api/meet/preview', { body: { meet: { races: [] } } })).json.error,
      'This is not a Split Relay meet file: it has no "splitRelayMeet" line. Save one with Save meet setup.');
    assert.equal((await call('POST', '/api/meet/apply', { body: { meet: file } })).json.error, 'Send the meet and base from a preview.');
    assert.equal((await call('POST', '/api/meet/apply', { body: { meet: file, base: r.json.base }, headers: { Origin: 'http://evil.example' } })).status, 403);
    const stale = await call('POST', '/api/meet/apply', { body: { meet: file, base: 'x', mode: 'file' } });
    assert.deepEqual([stale.status, stale.json.error], [409, 'The setup changed while the preview was open (a race was saved or a read came in). Look at the preview again.']);
    assert.equal(configBytes(), before);
  });

  test('a race with its gun and reads keeps its id, gun and reads; Set up from TrackScore renames its splits and sends nothing', async () => {
    let st = await state();
    const women = st.config.races.find((x) => x.name === 'Womens Race');
    assert.equal((await call('POST', `/api/races/${women.id}/gun`, { body: { gun: '10:00:00.000' } })).status, 200);
    await lapTimes(17565, [['10:03:00.000', '101'], ['10:03:01.000', '102'], ['10:03:02.000', '103']]);
    await waitFor(() => cap.packets().length >= 3, { what: 'the first three splits at the capture listener' });
    await new Promise((r) => setTimeout(r, 300));
    const sentBefore = cap.packets();
    st = await state();
    assert.equal(st.races.find((v) => v.id === women.id).splits[0].crossings, 3);
    const r = await call('POST', '/api/meet/preview', { body: { trackscore: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(tsWeb.seen.slice(0, 2), ['GET /api/xc/race', 'GET /api/xc/schedule?meetId=meet-fixture-1']);
    assert.ok(tsWeb.seen.every((x) => x.startsWith('GET ')));
    assert.equal(r.json.title, 'TrackScore: meet');
    assert.deepEqual([r.json.source.host, r.json.source.port, r.json.source.liveRace, r.json.source.outputName], ['127.0.0.1', tsWeb.port, "Women's Race", 'TrackScore']);
    assert.deepEqual(r.json.changed.map((i) => i.text), ['Mens Race: distance 8K (was none); split names written as in TrackScore: 800M, 1500M, 2500M, 3500M, 4500M, 5500M, 6400M, 7100M',
      'Womens Race: split 6 4400m → 4500M, split 7 5300m → 5400M; split names written as in TrackScore: 800M, 1500M, 2400M, 3100M, 4200M']);
    assert.deepEqual(r.json.kept.map((i) => i.text), ['Womens Race keeps its 3 reads and its gun 10:00:00.000.']);
    assert.deepEqual([r.json.added, r.json.attention], [[], []]);
    const a = await call('POST', '/api/meet/apply', { body: { meet: r.json.meet, mode: 'trackscore', base: r.json.base } });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual([a.json.applied.changed, a.json.applied.racesChanged, a.json.applied.added, a.json.applied.mode], [2, 2, 0, 'trackscore']);
    assert.match(a.json.applied.beforeLoad.fileName, /^before-load\/\d{4}-\d{2}-\d{2}-\d{6}\.json$/);
    const w = a.json.config.races.find((x) => x.id === women.id);
    assert.deepEqual([w.gun, w.active, w.splits.map((s) => s.name)], ['10:00:00.000', true, ['800M', '1500M', '2400M', '3100M', '4200M', '4500M', '5400M']]);
    assert.deepEqual(w.splits.map((s) => s.id), women.splits.map((s) => s.id));
    assert.equal(a.json.races.find((v) => v.id === women.id).splits[0].crossings, 3, 'its reads are kept');
    await new Promise((res) => setTimeout(res, 500));
    assert.deepEqual(cap.packets(), sentBefore, 'nothing was sent by the load');
    // the next packet has the same header as before: the event, the distance, the race name
    await lapTimes(17565, [['10:03:03.000', '104']]);
    await waitFor(() => cap.packets().length > sentBefore.length, { what: 'the next split' });
    const head = (p) => /"EN":\d+,\s*"R":\d+,\s*"H":\d+,\s*"S":"[^"]*",\s*"DS":"[^"]*",\s*"DN":"[^"]*"/.exec(p)?.[0];
    assert.ok(head(sentBefore[0]), sentBefore[0]);
    assert.equal(head(cap.packets().at(-1)), head(sentBefore[0]));
    const files = (await call('GET', '/api/meet/files')).json.files;
    assert.equal(files[0].beforeLoad, true, 'the setup before the load is offered first');
    assert.ok(fs.existsSync(path.join(dataDir, 'meets', a.json.applied.beforeLoad.fileName.replace('.json', '.config.json'))));
  });

  test('R1: a gun typed while an apply waits for its path checks makes it a 409, and nothing changes', async () => {
    const file = { splitRelayMeet: 1, name: 'Fall Classic', races: [{ name: 'Girls 5K', eventNumber: '3', inputPort: 17566, splits: ['1K'] }] };
    const p = await call('POST', '/api/meet/preview', { body: { meet: file } });
    assert.equal(p.status, 200);
    let open;
    paths.gate = new Promise((r) => { open = r; });
    // the apply's meet has a path the preview did not check: the apply waits at its check
    const applying = call('POST', '/api/meet/apply', { body: { meet: { ...file, names: { pplPath: 'C:\\Lynx\\Other.ppl' } }, mode: 'file', base: p.json.base } });
    await waitFor(() => paths.asked.includes('C:\\Lynx\\Other.ppl'), { what: 'the apply to check its path' });
    const men = (await state()).config.races.find((x) => x.name === 'Mens Race');
    assert.equal((await call('POST', `/api/races/${men.id}/gun`, { body: { gun: '11:00:00.000' } })).status, 200);
    const before = configBytes();
    open();
    paths.gate = null;
    const r = await applying;
    assert.equal(r.status, 409);
    assert.equal(configBytes(), before);
    assert.ok(!(await state()).config.races.some((x) => x.name === 'Girls 5K'));
    assert.equal((await call('POST', `/api/races/${men.id}/gun`, { body: { gun: null } })).status, 200);
  });

  test('O5/O6/O17: a file from the file chooser is kept in data\\meets after the load; a port another program has is said first', async () => {
    const file = { splitRelayMeet: 1, name: 'Chooser Meet', input: { ports: [17599] },
      races: [{ name: 'Open 3K', eventNumber: '21', inputPort: 17599, active: false, splits: ['1K', '2K'] }],
      outputs: [{ name: 'Board On', port: 6911, enabled: true }, { name: 'Board Off', port: 6912, enabled: false }] };
    const p = await call('POST', '/api/meet/preview', { body: { meet: file, fileName: 'C:\\USB\\Chooser Meet.json' } });
    assert.equal(p.status, 200, p.text);
    assert.ok(p.json.attention.some((i) => i.tone === 'bad' && i.text.startsWith('Port 17599 is already in use by another program on this PC')), JSON.stringify(p.json.attention));
    const a = await call('POST', '/api/meet/apply', { body: { meet: p.json.meet, mode: 'file', base: p.json.base, keep: true, fileName: 'Chooser Meet.json' } });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.applied.keptAs, 'Chooser Meet.json');
    // O6: Board On came in off (Womens Race runs) and is said; Board Off was off on purpose and is not
    assert.deepEqual(a.json.applied.outputsOff, ['Board On']);
    const kept = JSON.parse(fs.readFileSync(path.join(dataDir, 'meets', 'Chooser Meet.json'), 'utf8'));
    assert.deepEqual([kept.splitRelayMeet, kept.name, kept.races[0].splits], [1, 'Chooser Meet', ['1K', '2K']]);
    const files = (await call('GET', '/api/meet/files')).json.files;
    assert.ok(files.some((x) => x.fileName === 'Chooser Meet.json' && x.races === 1), JSON.stringify(files));
    // O2: the copy kept before that load offers to remove what it added, and says what it can't take back
    const before = files.find((x) => x.beforeLoad);
    const u = await call('POST', '/api/meet/preview', { body: { saved: before.fileName } });
    assert.equal(u.status, 200, u.text);
    assert.deepEqual([u.json.undo, u.json.source.beforeLoad, u.json.removable.map((x) => x.name)], [true, true, ['Open 3K']]);
    assert.ok(u.json.attention.some((i) => /^This puts back what that copy has, as it was before the load at \d\d:\d\d\. What the load added stays: Open 3K .*the outputs Board On and Board Off/.test(i.text)),
      JSON.stringify(u.json.attention));
    // O33: nothing that copy has changes; what the load added is what differs, for the panel to say (never "Nothing to
    // change"), and its outputs are "not in that copy" as its races are
    assert.deepEqual([u.json.nothing, u.json.leftover], [true, { races: ['Open 3K'], outputs: ['Board On', 'Board Off'], ports: [17599] }]);
    assert.deepEqual(u.json.kept.map((i) => i.text).filter((t) => / not in /.test(t)),
      ['Open 3K is not in that copy: it stays.', 'Board On is not in that copy: it stays.', 'Board Off is not in that copy: it stays.']);
    const back = await call('POST', '/api/meet/apply', { body: { meet: u.json.meet, mode: 'file', base: u.json.base, undo: true, removeOthers: true } });
    assert.equal(back.status, 200, back.text);
    assert.ok(!back.json.config.races.some((x) => x.name === 'Open 3K'), 'the race the load added is removed');
    assert.equal(back.json.applied.keptAs, null);
    // O33: the toast says the setup was put back (to the time that copy was kept), not "<meet name> loaded"
    assert.deepEqual([back.json.applied.undo, back.json.applied.removed], [{ at: Date.parse(u.json.meet.savedAt) }, 1]);
    // the outputs that load added stay (R1): taken out here so the next tests see the setup as it was
    for (const o of back.json.config.outputs.filter((x) => x.name.startsWith('Board'))) assert.equal((await call('DELETE', `/api/outputs/${o.id}`)).status, 200);
    assert.equal((await call('PUT', '/api/settings', { body: { input: { ports: [17565, 17566] }, meet: { name: '' } } })).status, 200);
  });

  test('O34: an output to this PC on an RR12 port, one the same file adds or one here, by any of its names, is never added', async () => {
    const before = configBytes();
    const file = { splitRelayMeet: 1, name: 'Loop Meet', input: { ports: [17571] },
      races: [{ name: 'Open 5K', eventNumber: '22', inputPort: 17571, active: false, splits: ['1K'] }],
      outputs: [{ name: 'Loop', mode: 'tcp-client', host: '127.0.0.1', port: 17571, enabled: true }, { name: 'By Name', host: os.hostname(), port: 17565 },
        { name: 'Remote', host: '10.0.0.9', port: 17565 }] };
    const p = await call('POST', '/api/meet/preview', { body: { meet: file } });
    assert.equal(p.status, 200, p.text);
    const bad = p.json.attention.filter((i) => i.tone === 'bad').map((i) => i.text);
    assert.deepEqual(bad, [
      'Port 17571 is an RR12 input port of this Split Relay (the file adds it): the output "Loop" would send Split Relay\'s own splits to it on this PC, ' +
        'and they would come back in as RR12 reads. It is not added. Choose another port in the file.',
      'Port 17565 is an RR12 input port of this Split Relay: the output "By Name" would send Split Relay\'s own splits to it on this PC, ' +
        'and they would come back in as RR12 reads. It is not added. Choose another port in the file.',
    ]);
    assert.deepEqual(p.json.added.filter((i) => i.kind === 'output').map((i) => i.name), ['Remote']);
    assert.ok(p.json.added.some((i) => i.kind === 'port' && i.name === '17571'), 'the port is added: its race reads from it');
    assert.equal(configBytes(), before, 'a preview changes nothing');
  });

  test('Start a new meet: refused while a race runs; then the reads are put away, guns and Pause cleared, a copy kept', async () => {
    assert.equal((await call('POST', '/api/meet/new', { body: {} })).json.error, 'Send { "confirm": true } to start a new meet.');
    let r = await call('POST', '/api/meet/new', { body: { confirm: true } });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /^Womens Race is running \(last read \d\d:\d\d\)\. Start a new meet once it is over, or turn off its Active \(on its page\) first\.$/);
    let st = await state();
    const women = st.config.races.find((x) => x.name === 'Womens Race');
    assert.equal((await call('PUT', `/api/races/${women.id}`, { body: { active: false } })).status, 200);
    // O19: a gun typed half a minute ago, before the first read, is a running race too
    const men = st.config.races.find((x) => x.name === 'Mens Race');
    const g = new Date(Date.now() - 30_000);
    const gun = `${String(g.getHours()).padStart(2, '0')}:${String(g.getMinutes()).padStart(2, '0')}:${String(g.getSeconds()).padStart(2, '0')}.000`;
    assert.equal((await call('PUT', `/api/races/${men.id}`, { body: { active: true } })).status, 200);
    assert.equal((await call('POST', `/api/races/${men.id}/gun`, { body: { gun } })).status, 200);
    r = await call('POST', '/api/meet/new', { body: { confirm: true } });
    assert.deepEqual([r.status, r.json.error], [409, `Mens Race is running (gun ${gun}). Start a new meet once it is over, or turn off its Active (on its page) first.`]);
    assert.equal((await call('POST', `/api/races/${men.id}/gun`, { body: { gun: null } })).status, 200);
    assert.equal((await call('PUT', `/api/races/${men.id}`, { body: { active: false } })).status, 200);
    await call('POST', `/api/races/${women.id}/splits/${women.splits[2].id}/sending`, { body: { on: false } });
    await call('PUT', '/api/settings', { body: { meet: { name: 'Last Meet' } } });
    const sent = cap.packets().length;
    r = await call('POST', '/api/meet/new', { body: { confirm: true } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.newMeet.archive, /^data\\archive\\\d{4}-\d{2}-\d{2}-\d{6}$/);
    assert.deepEqual([r.json.newMeet.reads, r.json.newMeet.races, r.json.newMeet.guns], [4, ['Womens Race'], 1]);
    const dir = path.join(dataDir, 'archive', r.json.newMeet.archive.split('\\').at(-1));
    for (const f of ['config.json', 'reads.jsonl', 'races', 'about.txt']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    st = r.json;
    assert.ok(st.config.races.every((x) => x.gun === '' && x.splits.every((s) => s.sending)));
    assert.equal(st.config.meet.name, '', "the next Save does not replace the last meet's file");
    assert.ok(st.races.every((v) => v.lastReadAt === null && v.splits.every((s) => s.crossings === 0)));
    assert.deepEqual([st.noRace, st.setAside, st.missingRaces], [[], [], []]);
    assert.deepEqual(st.config.races.map((x) => x.name), ['Womens Race', 'Mens Race'], 'the races stay');
    assert.equal(st.config.outputs.length, 1, 'the outputs stay');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(cap.packets().length, sent, 'nothing is sent');
    assert.ok(fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').includes('"t":"new-meet"'), 'the reads stay, out of use');
  });
});

test('R5: reads that came before today are said in the preview, per race and in no race, with Start a new meet first', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-meet-old-'));
  const dataDir = meetDataDir(root, 'data', { races: [{ id: 'r_old', name: 'Old Race', eventNumber: '7', inputPort: 17565, splits: [{ name: '1K' }] }] });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const tod = (10 * 3600 + 3 * 60) * 10000;
  const read = (seq, bib, raceId, port) => JSON.stringify({ t: 'read', seq, at: yesterday.getTime() + seq, conn: 1, location: '', bib, tod: tod + seq,
    contest: '', first: '', last: '', team: '', gender: '', raceId, port, ...(raceId ? {} : { aside: 0 }) });
  fs.writeFileSync(path.join(dataDir, 'reads.jsonl'), `${read(1, '101', 'r_old', 17565)}\n${read(2, '102', null, 17566)}\n`);
  const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true, trackScoreGet: guardedGet });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const r = await request(app.panelPort, 'POST', '/api/meet/preview', { body: { meet: { splitRelayMeet: 1, races: [{ name: 'Old Race', eventNumber: '7', splits: ['1K'] }] } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.newMeet, { races: [{ id: 'r_old', name: 'Old Race', reads: 1, lastReadAt: yesterday.getTime() + 1 }], noRace: 1 });
  assert.deepEqual(r.json.kept.map((i) => i.text), ['Old Race: no change, and it keeps its 1 read.']);
});

// ---- DESIGN 9.25: start lists on a running app ---------------------------------------------------------------------
// Its own data folder (ports 17xxx), an output on a capture listener of the test. Entry files as the timer has them,
// with made-up names.

describe('start lists on a running app (DESIGN 9.25)', () => {
  let app;
  let port;
  let root;
  let dataDir;
  let cap;
  const call = (method, p, opts) => request(port, method, p, opts);
  const HEAD = 'NO.;FIRST NAME;LAST NAME;SEX;YEAR;CODE;SCHOOL;DIV;DIVPTS;EVENT;WAVE';
  const entryFile = (first, n, event) => [HEAD, ...Array.from({ length: n }, (_, i) => `${first + i};Runner;N${first + i};F;SO;T${event};Team ${event};;;${event};`), ''].join('\r\n');
  const start = async () => {
    app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true, trackScoreGet: guardedGet });
    port = app.panelPort;
  };
  /** the split lines the output got: [bib, laps to go] */
  const sent = () => cap.packets().map((p) => JSON.parse(p).D).filter((d) => d && d.BIB).map((d) => String(d.BIB));

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-lists-'));
    cap = await captureListener();
    dataDir = meetDataDir(root, 'data');
    await start();
    for (const body of [
      { name: 'List Girls', eventNumber: '31', inputPort: 17565, gun: '10:00:00.000', splits: [{ name: '1K' }, { name: '2K' }, { name: '3K' }] },
      { name: 'List Boys', eventNumber: '32', inputPort: 17566, splits: [{ name: '1K' }, { name: '2K' }, { name: '3K' }] },
    ]) assert.equal((await call('POST', '/api/races', { body })).status, 200);
    assert.equal((await call('POST', '/api/outputs', { body: { name: 'TrackScore', host: '127.0.0.1', port: cap.port, script: XCSCORE } })).status, 200);
  });

  after(async () => {
    await app?.stop();
    await cap?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loading entry files: one sentence per file, the lists in the state and (bibs only) in the data folder; the athlete of the other race stays off the output; Count them here; the setting; a restart; Remove; a new meet', async () => {
    let r = await call('POST', '/api/startlists', { body: {} });
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "files": [{ "name": "1.txt", "text": "<the text of the file>" }] }: the entry files to load.']);
    r = await call('POST', '/api/startlists', { body: { files: [{ name: '31.txt', text: entryFile(800, 12, 31) }] }, headers: { Origin: 'http://evil.example' } });
    assert.deepEqual([r.status, r.json.error], [403, 'Split Relay refused a change requested by another web page.']);
    let st = (await call('GET', '/api/state')).json;
    assert.equal(st.startLists, undefined, 'none loaded: nothing about them');
    const girls = st.config.races.find((x) => x.name === 'List Girls');
    assert.equal(st.races.find((v) => v.id === girls.id).startList, undefined);
    r = await call('POST', '/api/startlists', { body: { files: [
      { name: '31.txt', text: entryFile(800, 12, 31) }, { name: 'C:\\meet\\32.txt', text: entryFile(900, 6, 32) }, { name: '40.txt', text: entryFile(1, 2, 40) }, { name: '41.txt', text: `${HEAD}\r\n` }] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.startListLoad, { results: [
      { file: '31.txt', ok: true, events: ['31'], entered: 12, text: '31.txt: 12 athletes entered in event 31 (List Girls).' },
      { file: '32.txt', ok: true, events: ['32'], entered: 6, text: '32.txt: 6 athletes entered in event 32 (List Boys).' },
      { file: '40.txt', ok: true, events: ['40'], entered: 2, text: '40.txt: 2 athletes entered in event 40, which has no race here.' },
      { file: '41.txt', ok: false, events: [], entered: 0, text: '41.txt: no athletes in it (only a header line). Nothing was loaded.' }], notes: [], resent: 0, held: [] });
    assert.deepEqual(r.json.startLists.events.map((e) => [e.event, e.file, e.entered, e.races.map((x) => x.name)]),
      [['31', '31.txt', 12, ['List Girls']], ['32', '32.txt', 6, ['List Boys']], ['40', '40.txt', 2, []]]);
    assert.deepEqual(r.json.startLists.without, []);
    const view = r.json.races.find((v) => v.id === girls.id).startList;
    assert.deepEqual([view.entered, view.file, view.used, view.text, view.warn], [12, '31.txt', true, '12 entered, from 31.txt', null]);
    // kept in the data folder: the bibs of each event, never a name
    const kept = fs.readFileSync(path.join(dataDir, 'startlists.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(kept).events), ['31', '32', '40']);
    assert.equal(/Runner|Team/.test(kept), false);
    // the girls' race: its twelve runners over the first two mats, and boy 903 over the first one at 3:30
    const lines = [];
    for (let k = 1; k <= 2; k++) for (let i = 0; i < 12; i++) {
      const sec = 180 * k * (1 + 0.02 * i);
      lines.push(`\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${800 + i}\r\n`);
    }
    lines.push('\x01S,10:03:30.000,903\r\n');
    const sock = net.connect(app.inputPortOf(17565), '127.0.0.1');
    await new Promise((res) => sock.once('connect', res));
    sock.end(lines.join(''));
    const review = await waitFor(async () => {
      const x = (await call('GET', `/api/races/${girls.id}/review`)).json;
      return x?.away?.length === 1 ? x : null;
    }, { what: 'bib 903 in Not in this race' });
    assert.deepEqual(review.away.map((a) => [a.bib, a.by, a.why, a.passes.map((p) => `${p.splitName} ${p.timeText}`)]), [['903', 'list', 'entered in List Boys', ['1K 3:30.0']]]);
    assert.deepEqual([review.counts.away, review.flags, review.checks], [1, [], []]);
    await waitFor(() => sent().length >= 24, { what: 'the 24 split lines' });
    await new Promise((res) => setTimeout(res, 300));
    assert.deepEqual([sent().length, sent().includes('903')], [24, false]);
    st = (await call('GET', '/api/state')).json;
    const tile = st.races.find((v) => v.id === girls.id);
    assert.deepEqual([tile.runners, tile.review.away, tile.splits[0].crossings, tile.splits[0].away, tile.startList.on, tile.startList.through], [13, 1, 13, 1, 12, 13]);
    assert.equal(st.feed.find((e) => e.bib === '903').status, 'not-in-race');
    // Count them here: one change; its line goes out
    const place = (bib, body) => call('POST', `/api/races/${girls.id}/runners/${bib}/place`, { body });
    r = await place('903', {});
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "say": "away" } (not in this race) or { "say": "here" } (count them here).']);
    r = await place('903', { say: 'away' });
    assert.deepEqual([r.status, r.json.error], [409, 'Bib 903 is not in List Girls already.']);
    r = await place('903', { say: 'here' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['change', 'review', 'runner']);
    assert.deepEqual([r.json.change.kind, r.json.change.text, r.json.change.sentTo, r.json.runner.place.kind, r.json.review.away], ['here', 'Counted in this race', ['TrackScore'], 'here', undefined]);
    await waitFor(() => sent().includes('903'), { what: "bib 903's line" });
    r = await call('POST', `/api/races/${girls.id}/undo`, { body: { fix: r.json.change.fix } });
    assert.deepEqual([r.status, r.json.change.text, r.json.review.away.map((a) => [a.bib, a.passes[0].onBoards])], [200, 'Undone: bib 903 is not in this race again', [['903', '3:30.0']]]);
    // the setting: send and flag, and back; nothing else is a choice
    r = await call('PUT', '/api/settings', { body: { entries: { otherRace: 'both' } } });
    assert.deepEqual([r.status, r.json.error], [400, 'Athletes entered in another race: choose "keep" (keep them off the boards) or "send" (send and flag).']);
    r = await call('PUT', '/api/settings', { body: { entries: { otherRace: 'send' } } });
    assert.deepEqual([r.status, r.json.config.entries], [200, { otherRace: 'send' }]);
    let rv = (await call('GET', `/api/races/${girls.id}/review`)).json;
    assert.deepEqual([rv.away, rv.flags.map((x) => [x.bib, x.kind, x.text]), rv.counts.strange], [undefined, [['903', 'stranger', 'Bib 903 is entered in List Boys: not in this race?']], 1]);
    r = await call('PUT', '/api/settings', { body: { entries: { otherRace: 'keep' } } });
    assert.deepEqual([r.status, r.json.config.entries], [200, undefined]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).entries, undefined, 'the default is not written');
    // a restart has the lists, and the athlete is still off the boards
    await app.stop();
    await start();
    st = (await call('GET', '/api/state')).json;
    assert.deepEqual(st.startLists.events.map((e) => [e.event, e.entered]), [['31', 12], ['32', 6], ['40', 2]]);
    rv = (await call('GET', `/api/races/${girls.id}/review`)).json;
    assert.deepEqual(rv.away.map((a) => a.bib), ['903']);
    // Remove: the boys' list goes; 903 is on no list now: sent as always, a quiet row
    r = await call('DELETE', '/api/startlists/32');
    assert.deepEqual([r.status, r.json.startListRemove.text, r.json.startLists.events.map((e) => e.event), r.json.startLists.without.map((x) => x.name)],
      [200, 'The start list of event 32 (6 athletes, from 32.txt) was removed.', ['31', '40'], ['List Boys']]);
    r = await call('DELETE', '/api/startlists/32');
    assert.deepEqual([r.status, r.json.error], [404, 'There is no start list for event 32. It may have been removed already: reload the page.']);
    rv = (await call('GET', `/api/races/${girls.id}/review`)).json;
    assert.deepEqual([rv.away, rv.unlisted.map((u) => u.bib), rv.counts.unlisted], [undefined, ['903'], 1]);
    // "Start a new meet" puts the lists away with the old meet
    assert.equal((await call('PUT', `/api/races/${girls.id}`, { body: { active: false } })).status, 200);
    r = await call('POST', '/api/meet/new', { body: { confirm: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.newMeet.startLists, r.json.startLists, fs.existsSync(path.join(dataDir, 'startlists.json'))], [2, undefined, false]);
    const dir = path.join(dataDir, 'archive', r.json.newMeet.archive.split('\\').at(-1));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'startlists.json'), 'utf8')).events), ['31', '40']);
    r = await call('DELETE', '/api/startlists/all');
    assert.deepEqual([r.status, r.json.error], [404, 'There is no start list to remove.']);
  });
});

// ---- DESIGN 9.27: swapped bibs on a running app --------------------------------------------------------------------
// Its own data folder (input ports 6490 and 6491 in the settings; the app listens on free ports), an output on a
// capture listener of the test. Bibs only.

describe('swapped bibs on a running app (DESIGN 9.27)', () => {
  let app;
  let port;
  let root;
  let dataDir;
  let cap;
  const call = (method, p, opts) => request(port, method, p, opts);
  const start = async () => {
    app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true, trackScoreGet: guardedGet });
    port = app.panelPort;
  };
  /** the split lines the output got: the bib of each */
  const sent = () => cap.packets().map((p) => JSON.parse(p).D).filter((d) => d && d.BIB).map((d) => String(d.BIB));

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-swap-'));
    cap = await captureListener();
    dataDir = meetDataDir(root, 'data', { input: { ports: [6490, 6491] }, panel: { port: 6492 } });
    await start();
    for (const body of [
      { name: 'Swap Women', eventNumber: '41', inputPort: 6490, gun: '10:00:00.000', splits: [{ name: '1K' }, { name: '2K' }] },
      { name: 'Swap Men', eventNumber: '42', inputPort: 6491, gun: '11:00:00.000', splits: [{ name: '1K' }, { name: '2K' }] },
    ]) assert.equal((await call('POST', '/api/races', { body })).status, 200);
    assert.equal((await call('POST', '/api/outputs', { body: { name: 'TrackScore', host: '127.0.0.1', port: cap.port, script: XCSCORE } })).status, 200);
  });

  after(async () => {
    await app?.stop();
    await cap?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('preview, swap, the list in the state, the runner and the feed, a restart, remove, a new meet; refusals in words', async () => {
    const state0 = (await call('GET', '/api/state')).json;
    const women = state0.config.races.find((x) => x.name === 'Swap Women');
    assert.equal(state0.swaps, undefined);
    // the women's race: bibs 800 to 805, and the athlete of bib 803 with the chip of bib 903
    const lines = [];
    for (let k = 1; k <= 2; k++) for (let i = 0; i < 6; i++) {
      const sec = 180 * k * (1 + 0.02 * i);
      lines.push(`\x01S,10:${String(Math.floor(sec / 60)).padStart(2, '0')}:${(sec % 60).toFixed(3).padStart(6, '0')},${i === 3 ? 903 : 800 + i}\r\n`);
    }
    const sock = net.connect(app.inputPortOf(6490), '127.0.0.1');
    await new Promise((res) => sock.once('connect', res));
    sock.end(lines.join(''));
    await waitFor(() => sent().length >= 12, { what: 'the 12 split lines' });
    assert.equal(sent().filter((b) => b === '903').length, 2);

    // refusals, in words; a page of another site may not change anything
    let r = await call('POST', '/api/swaps/preview', { body: [] });
    assert.deepEqual([r.status, r.json.error], [400, 'Send { "bib": "11", "other": "510" }: the two bibs whose chips were swapped.']);
    r = await call('POST', '/api/swaps', { body: { bib: '803' } });
    assert.deepEqual([r.status, r.json.error], [400, 'Type both bib numbers.']);
    r = await call('POST', '/api/swaps', { body: { bib: '803', other: '0803' } });
    assert.deepEqual([r.status, r.json.error], [400, "Bib 803 can't be swapped with itself. Type the bib whose chip it ran with."]);
    r = await call('POST', '/api/swaps', { body: { bib: '803', other: '903' }, headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await call('DELETE', '/api/swaps/803');
    assert.deepEqual([r.status, r.json.error], [404, 'Bib 803 is not swapped with another bib. The swap may have been removed already: reload the page.']);

    // the preview says what it would do, and changes nothing
    r = await call('POST', '/api/swaps/preview', { body: { bib: '803', other: '903' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.title, r.json.confirm, r.json.races.map((x) => [x.raceName, x.lines])], ['Swap bibs 803 and 903?', 'Swap bibs',
      [['Swap Women', ["Bib 903's 2 splits (3:10.8 to 6:21.6) become bib 803's.", 'They go out again under bib 803.',
        "The boards still show 2 splits under bib 903 (sent before): a packet can't empty a cell."]]]]);
    assert.deepEqual((await call('GET', '/api/swaps')).json, { swaps: [] });

    // the swap: the state has it, the splits go out under bib 803
    r = await call('POST', '/api/swaps', { body: { bib: '803', other: '903' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.swapChange.text, r.json.swapChange.removed, r.json.swapChange.races.map((x) => x.lines)], ['Bibs 803 and 903 are swapped.', false,
      [["2 splits are bib 803's now; bib 903 has none here.", 'Sent to TrackScore.', "The boards still show 2 splits under bib 903 (sent before): a packet can't empty a cell."]]]);
    assert.deepEqual(r.json.swaps.map((x) => [x.a, x.b, x.text, x.races.map((y) => y.text)]),
      [['803', '903', 'Bib 803 and bib 903 are swapped', ['Swap Women: bib 803 has 2 splits (3:10.8 to 6:21.6) read as bib 903']]]);
    await waitFor(() => sent().filter((b) => b === '803').length >= 2, { what: "bib 803's two lines" });
    assert.deepEqual((await call('GET', '/api/swaps')).json.swaps.map((x) => [x.a, x.b]), [['803', '903']]);
    const runner = (await call('GET', `/api/races/${women.id}/runners/803`)).json;
    assert.deepEqual([runner.found, runner.swap.other, runner.columns.map((c) => c.timeText), runner.passes.map((p) => p.readAs)], [true, '903', ['3:10.8', '6:21.6'], ['903', '903']]);
    assert.equal((await call('GET', `/api/races/${women.id}/runners/903`)).json.found, false);
    const feed = (await call('GET', '/api/state')).json.feed.filter((e) => e.readAs);
    assert.deepEqual([...new Set(feed.map((e) => `${e.bib} read as ${e.readAs}`))], ['803 read as 903']);
    // the journal keeps the reads as they came in, and the swap as one record
    const journal = fs.readFileSync(path.join(dataDir, 'reads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([journal.filter((x) => x.t === 'read' && x.bib === '903').length, journal.filter((x) => x.t === 'read' && x.bib === '803').length,
      journal.filter((x) => x.t === 'swap').map((x) => [x.a, x.b])], [2, 0, [['803', '903']]]);
    // not in the settings, not in a saved meet setup
    assert.equal(/swapped|803|903/i.test(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')), false);
    r = await call('POST', '/api/meet/save', { body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(/swapped|803|903/i.test(r.json.text), false);

    // a restart keeps it
    await app.stop();
    await start();
    r = await call('GET', '/api/state');
    assert.deepEqual(r.json.swaps.map((x) => [x.a, x.b]), [['803', '903']]);
    assert.deepEqual((await call('GET', `/api/races/${women.id}/runners/803`)).json.columns.map((c) => c.timeText), ['3:10.8', '6:21.6']);

    // remove: what it would do, then done; again: not there
    r = await call('POST', '/api/swaps/preview', { body: { bib: '903', remove: true } });
    assert.deepEqual([r.status, r.json.title, r.json.races[0].lines[0]], [200, 'Remove the swap of bibs 803 and 903?', "Bib 803's 2 splits (3:10.8 to 6:21.6), read as bib 903, go back to bib 903."]);
    r = await call('DELETE', '/api/swaps/0903');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.swapChange.text, r.json.swapChange.removed, r.json.swaps], ['The swap of bibs 803 and 903 was removed.', true, undefined]);
    assert.equal((await call('GET', `/api/races/${women.id}/runners/903`)).json.found, true);
    r = await call('DELETE', '/api/swaps/903');
    assert.equal(r.status, 404);

    // "Start a new meet" forgets a swap with the old meet's reads
    assert.equal((await call('POST', '/api/swaps', { body: { bib: '803', other: '903' } })).status, 200);
    assert.equal((await call('PUT', `/api/races/${women.id}`, { body: { active: false } })).status, 200);
    r = await call('POST', '/api/meet/new', { body: { confirm: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.swaps, undefined);
    assert.deepEqual((await call('GET', '/api/swaps')).json, { swaps: [] });
  });
});
