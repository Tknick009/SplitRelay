import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OutputManager, packetVariables, samplePacket, packetProblem } from '../src/outputs.js';
import { encodeCp1252 } from '../src/cp1252.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const XC = join(FIXTURES, 'xcscore.lss');
const KARMARUSH = join(FIXTURES, 'karmarush-track.lss');
const TRACK = join(FIXTURES, 'trackscore-track.lss');

// Tests run in milliseconds: fast retries, and scripts re-read only when a test asks (or sets a short poll).
const FAST = { retryMs: [20, 40, 60], scriptPollMs: 60_000, connectTimeoutMs: 2000 };

const RACE = {
  id: 'r1', name: 'Girls Varsity 5K', eventNumber: '3', round: '1', heat: '1', distance: '', contests: [],
  gun: '10:00:00.000', splits: [{ id: 's1', name: '1K' }, { id: 's2', name: '2K' }, { id: 's3', name: '4K' }],
  finishSources: [], active: true,
};
const RACE2 = { ...RACE, id: 'r2', name: 'Boys Varsity 5K', eventNumber: '4' };

/** Split 2 of 3 for an invented runner whose names need windows-1252 (ë 0xeb, ’ 0x92, – 0x96). */
function packet(over = {}) {
  return {
    raceId: 'r1', race: RACE, splitId: 's2', splitIndex: 1, splitCount: 3, splitName: '2K', bib: '1234', first: 'Zoë',
    last: 'D’Arcy', team: 'Lakeside – Blue', gender: 'F', csTicks: 3_123_450, lsTicks: 1_511_230, place: 7, lapsToGo: 2,
    gunTicks: 360_000_000, tod: 363_123_450, runnerCount: 25, reason: 'new', ...over,
  };
}

const XC_PACKET = '{"T":"T","D":{"EN":3,"R":1,"H":1,"S":"UNOFFICIAL","DS":"","DN":"Girls Varsity 5K","W":"","P":"7","L":"",' +
  '"BIB":"1234","N":"D’Arcy","AF":"Lakeside – Blue","T":"","RT":"","L2G":"2","CS":"5:12.345","LS":"2:31.123",' +
  '"FN":"Zoë","LN":"D’Arcy","LICENCE":"F"}}\r\n';

function output(over = {}) {
  return {
    id: 'o1', name: 'TrackScore', enabled: true, mode: 'tcp-client', host: '127.0.0.1', port: 0, script: XC,
    stage: 'results', races: [], eventNumber: 'race', precision: 3, mid: '', ...over,
  };
}

/** A manager on a config the test can edit; everything it logs is kept. Stopped when the test ends. */
function manager(t, outputs, more = {}) {
  const config = { races: [RACE, RACE2], outputs };
  const logs = [];
  const m = new OutputManager({ getConfig: () => config, log: (line) => logs.push(line), ...FAST, ...more });
  t.after(() => m.stop());
  return { m, config, logs };
}

const statusOf = (m, id = 'o1') => m.status().find((s) => s.id === id);

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Packets as byte-preserving strings (latin1), one per CRLF. */
const split = (buf) => buf.toString('latin1').split(/(?<=\r\n)/).filter(Boolean);
const bibs = (packets) => packets.map((p) => /"BIB":"([^"]*)"/.exec(p)?.[1]);

/** A TCP server like TrackScore's port 5555: accepts many clients, never writes back. */
async function tcpSink(t, port = 0) {
  const conns = [];
  const server = net.createServer((sock) => {
    const c = { sock, chunks: [], closed: false };
    conns.push(c);
    sock.on('data', (d) => c.chunks.push(d));
    sock.on('error', () => {});
    sock.on('close', () => {
      c.closed = true;
    });
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if (attempt > 20 || err.code !== 'EADDRINUSE') throw err;
      await pause(50); // Windows may hold a just-closed port for a moment
    }
  }
  const sink = {
    port: server.address().port,
    conns,
    bytes: () => Buffer.concat(conns.flatMap((c) => c.chunks)),
    packets: () => split(sink.bytes()),
    async close() {
      for (const c of conns) c.sock.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  t.after(() => sink.close());
  return sink;
}

async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'split-relay-outputs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('packetVariables maps a split crossing onto the FinishLynx variables', () => {
  const { header, rows } = packetVariables(packet(), output());
  assert.deepEqual(header, {
    1: 'UNOFFICIAL', 2: 'Girls Varsity 5K', 3: '', 4: '3', 5: '1', 6: '1', 7: 'AUTO', 8: '25', 9: 'RUNNING', 10: '',
    11: '', 12: '', 13: '10:00:00.0000', 14: '10:00:00.000', 15: '10:00:00.00',
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  const expected = {};
  for (let code = 1; code <= 0x18; code++) expected[code] = '';
  Object.assign(expected, {
    1: '7', 3: '1234', 4: 'D’Arcy', 5: 'Lakeside – Blue', 8: '5:12.345', 9: '2:31.123', 10: '2', 11: 'F', 0x17: 'Zoë',
    0x18: 'D’Arcy',
  });
  assert.deepEqual(row, expected);
  assert.ok([...Object.values(header), ...Object.values(row)].every((v) => typeof v === 'string'));

  assert.equal(packetVariables(packet(), output({ eventNumber: 'blank' })).header[4], '');
  // gun with four decimals and no leading zero on the hour, truncated for 3 and 2 decimals
  const h = packetVariables(packet({ gunTicks: 9 * 36e6 + 5 * 6e5 + 3 * 1e4 + 1238 }), output()).header;
  assert.deepEqual([h[13], h[14], h[15]], ['9:05:03.1238', '9:05:03.123', '9:05:03.12']);
  const noGun = packetVariables(packet({ gunTicks: null, runnerCount: undefined }), output()).header;
  assert.deepEqual([noGun[8], noGun[13], noGun[14], noGun[15]], ['', '', '', '']);
  assert.equal(packetVariables(packet({ gender: 'x' }), output()).rows[0][11], '');
});

test('precision rounds CS and LS up like FinishLynx', () => {
  const p = packet({ csTicks: 3_123_410, lsTicks: 1_511_201 }); // 5:12.341, 2:31.1201
  const at = (precision) => packetVariables(p, output({ precision })).rows[0];
  assert.deepEqual([at(1)[8], at(1)[9]], ['5:12.4', '2:31.2']);
  assert.deepEqual([at(2)[8], at(2)[9]], ['5:12.35', '2:31.13']);
  assert.deepEqual([at(3)[8], at(3)[9]], ['5:12.341', '2:31.121']);
  assert.equal(at(7)[8], '5:12.341'); // not 1, 2 or 3 -> thousandths
  assert.equal(at('2')[8], '5:12.35');
});

test('tcp-client sends the XCScore.lss packet byte-exact in windows-1252 with CRLF', async (t) => {
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [output({ port: sink.port })]);
  m.sync();
  const statusEvent = once(m, 'status');
  // sent before the script has even been read: it waits for the script instead of being lost
  assert.equal(m.send(packet()), 1);
  await until(() => sink.bytes().length >= encodeCp1252(XC_PACKET).length, 'the packet');
  const bytes = sink.bytes();
  assert.deepEqual(bytes, encodeCp1252(XC_PACKET));
  assert.ok(bytes.includes(0x92) && bytes.includes(0x96) && bytes.includes(0xeb), 'windows-1252 bytes');
  assert.ok(!bytes.includes(0xe2), 'no UTF-8');
  assert.deepEqual([...bytes.subarray(-4)], [0x7d, 0x7d, 0x0d, 0x0a]);
  assert.ok(logs.includes(`[out TrackScore] ${XC_PACKET.replace('\r\n', '\\0d\\0a')}`), logs.join('\n'));

  m.send(packet({ bib: '77', place: 8 }));
  await until(() => sink.packets().length === 2, 'the second packet');
  assert.deepEqual(bibs(sink.packets()), ['1234', '77']);
  assert.equal(sink.conns.length, 1, 'one connection for both');
  for (const p of sink.packets()) JSON.parse(p);

  await until(() => statusOf(m).sent === 2, 'sent count');
  const s = statusOf(m);
  assert.equal(s.state, 'connected');
  assert.equal(s.clients, 1);
  assert.equal(s.queued, 0);
  assert.equal(s.target, `127.0.0.1:${sink.port}`);
  assert.equal(s.scriptOk, true);
  assert.equal(s.scriptError, null);
  assert.equal(s.lastError, null);
  assert.equal(s.scriptInfo.mid, null);
  assert.ok(s.scriptInfo.sections.some((x) => x.name === 'Results'));
  assert.equal(typeof s.lastSentAt, 'number');
  assert.ok(Array.isArray((await statusEvent)[0]), "'status' carries OutputStatus[]");
});

test("eventNumber 'blank' sends \"EN\":\"\" and stays valid JSON", async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port, eventNumber: 'blank' })]);
  m.send(packet());
  await until(() => sink.packets().length === 1, 'the packet');
  assert.equal(sink.packets()[0], encodeCp1252(XC_PACKET.replace('"EN":3', '"EN":""')).toString('latin1'));
  assert.equal(JSON.parse(sink.packets()[0]).D.EN, '');
});

test('MID override replaces the meet id of Karmarush-Track.lss', async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [
    output({ id: 'live', name: 'Live', port: sink.port, script: KARMARUSH, mid: '9001' }),
    output({ id: 'plain', name: 'Plain', port: sink.port, script: KARMARUSH }),
    output({ id: 'typo', name: 'Typo', port: sink.port, script: KARMARUSH, mid: '90x1', enabled: false }),
  ]);
  assert.equal(m.send(packet()), 2);
  await until(() => sink.packets().length === 2, 'both packets');
  const mids = sink.packets().map((p) => JSON.parse(p).D.MID).sort();
  assert.deepEqual(mids, [8132, 9001]);
  const live = sink.packets().find((p) => p.includes('"MID":9001'));
  assert.ok(live.startsWith('{"T":"T","D":{"MID":9001,"EN":3,"R":1,"H":1,"S":"UNOFFICIAL",'), live);
  assert.equal(statusOf(m, 'live').scriptInfo.mid, '8132'); // the panel offers the override because of this
  await m.checkScripts('typo'); // read in parallel with the others; it may still be loading
  const typo = m.preview('typo', null);
  assert.match(typo.text, /"MID":8132,/);
  assert.match(typo.warnings.join('\n'), /MID override "90x1" is not a number/);
});

test('precision 1 goes out on the wire rounded up', async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port, precision: 1 })]);
  m.send(packet({ csTicks: 3_123_410, lsTicks: 1_511_201 }));
  await until(() => sink.packets().length === 1, 'the packet');
  const d = JSON.parse(sink.packets()[0]).D;
  assert.deepEqual([d.CS, d.LS], ['5:12.4', '2:31.2']);
});

test('races filter: an output only sends the races it lists ([] = all)', async (t) => {
  const one = await tcpSink(t);
  const all = await tcpSink(t);
  const { m } = manager(t, [
    output({ id: 'one', name: 'Girls only', port: one.port, races: ['r1'] }),
    output({ id: 'all', name: 'Everything', port: all.port, races: [] }),
  ]);
  assert.equal(m.send(packet({ raceId: 'r2', race: RACE2, bib: '501' })), 1);
  assert.equal(m.send(packet({ bib: '101' })), 2);
  await until(() => all.packets().length === 2 && one.packets().length === 1, 'packets');
  await pause(50);
  assert.deepEqual(bibs(one.packets()), ['101']);
  assert.deepEqual(bibs(all.packets()), ['501', '101']);
  assert.equal(JSON.parse(all.packets()[0]).D.EN, 4);
});

test('tcp-client queues while the target is down and flushes in order on connect', async (t) => {
  const port = await freePort();
  const { m, logs } = manager(t, [output({ port })]);
  // The script first: packets given while it loads wait in the output and also count as queued, so without this the
  // wait below could end before any of them reached the connection's queue (review-core F10, flaky under load).
  m.sync();
  await m.checkScripts();
  for (const bib of ['101', '102', '103']) m.send(packet({ bib }));
  await until(() => statusOf(m).queued === 3 && statusOf(m).lastError, 'three queued packets');
  const down = statusOf(m);
  assert.equal(down.state, 'connecting');
  assert.match(down.lastError, /refused/);
  assert.equal(down.sent, 0);
  assert.ok(logs.some((l) => l.startsWith('[out TrackScore] queued (not connected')), logs.join('\n'));
  // one log line for the failure, not one per retry
  await pause(150);
  assert.equal(logs.filter((l) => l.includes('cannot connect')).length, 1);

  const sink = await tcpSink(t, port);
  await until(() => sink.packets().length === 3, 'the flush');
  assert.deepEqual(bibs(sink.packets()), ['101', '102', '103']);
  await until(() => statusOf(m).sent === 3, 'sent count');
  const up = statusOf(m);
  assert.equal(up.state, 'connected');
  assert.equal(up.queued, 0);
  assert.equal(up.lastError, null);
  assert.ok(logs.some((l) => /connected to .*; sending 3 queued packets/.test(l)), logs.join('\n'));
});

test('the queue keeps the newest packets when it is full and logs each one dropped', async (t) => {
  const port = await freePort();
  const { m, logs } = manager(t, [output({ port })], { maxQueue: 2 });
  m.sync();
  await m.checkScripts();
  for (const bib of ['101', '102', '103']) m.send(packet({ bib }));
  await until(() => statusOf(m).queued === 2 && statusOf(m).dropped === 1, 'a full queue');
  assert.ok(logs.some((l) => /not sent \(queue full at 2 packets.*"BIB":"101"/.test(l)), logs.join('\n'));
  const sink = await tcpSink(t, port);
  await until(() => sink.packets().length === 2, 'the flush');
  assert.deepEqual(bibs(sink.packets()), ['102', '103']);
});

test('tcp-client reconnects after the server restarts', async (t) => {
  const first = await tcpSink(t);
  const port = first.port;
  const { m, logs } = manager(t, [output({ port })]);
  m.send(packet({ bib: '1' }));
  await until(() => first.packets().length === 1, 'packet 1');
  await first.close();
  await until(() => statusOf(m).state === 'connecting', 'the drop to be noticed');
  assert.match(statusOf(m).lastError, /lost/);
  m.send(packet({ bib: '2' }));
  m.send(packet({ bib: '3' }));
  assert.equal(statusOf(m).queued, 2);
  const second = await tcpSink(t, port);
  // Packet 1 was taken by the connection that dropped less than a minute ago: it goes again, first (review-core F5).
  await until(() => second.packets().length === 3, 'packet 1 again, then 2 and 3');
  assert.deepEqual(bibs(second.packets()), ['1', '2', '3']);
  await until(() => statusOf(m).state === 'connected' && statusOf(m).sent === 4, 'connected again');
  assert.ok(logs.some((l) => /lost .*reconnecting/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /sending the 1 packet of the minute before the connection dropped again/.test(l)), logs.join('\n'));
});

/**
 * A TrackScore stand-in that can hang (stop reading) and be killed (connection reset), like r8_tcp_drop.mjs: it
 * records the bib of every packet it really read.
 */
async function hangingTarget(t, port = 0) {
  const got = [];
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => conns.delete(sock));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        got.push(/"BIB":"([^"]*)"/.exec(buf.slice(0, i))?.[1]);
        buf = buf.slice(i + 2);
      }
    });
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if (attempt > 20 || err.code !== 'EADDRINUSE') throw err;
      await pause(50);
    }
  }
  const target = {
    port: server.address().port,
    got,
    hang: () => { for (const s of conns) s.pause(); },
    async kill() {
      for (const s of conns) (s.resetAndDestroy ? s.resetAndDestroy() : s.destroy());
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
  t.after(() => target.kill().catch(() => {}));
  return target;
}

test('a target that stops reading and is then reset gets the last minute again on reconnect (review-core F5)', async (t) => {
  const first = await hangingTarget(t);
  const { m, logs } = manager(t, [output({ port: first.port })]);
  // Packets like the engine's: acknowledged once, and current while nothing replaced them (isCurrent).
  const current = new Map();
  const acks = [];
  const send = (bib) => {
    const p = packet({ bib: String(bib), place: bib });
    current.set(String(bib), p);
    Object.defineProperty(p, 'isCurrent', { value: () => current.get(String(bib)) === p });
    assert.equal(m.deliver('o1', p, (ok) => acks.push([bib, ok])), true);
  };
  for (let b = 1; b <= 20; b++) send(b);
  await until(() => first.got.length === 20, 'the first 20 read');
  // TrackScore hangs: 20 more go into the buffers and are acknowledged, but never read.
  first.hang();
  for (let b = 21; b <= 40; b++) send(b);
  await until(() => acks.length === 40, 'all 40 acknowledged');
  assert.ok(acks.every(([, ok]) => ok));
  assert.equal(first.got.length, 20);
  // Meanwhile bib 30's split was replaced by a newer packet and bib 35 finished: neither old packet may go again.
  current.set('30', null);
  current.delete('35');
  await first.kill(); // TrackScore is killed: the connection is reset
  await until(() => statusOf(m).state === 'connecting', 'the drop to be noticed');
  const second = await hangingTarget(t, first.port);
  await until(() => second.got.length === 38, 'the minute before the drop, again');
  await pause(100);
  const want = Array.from({ length: 40 }, (_, i) => String(i + 1)).filter((b) => b !== '30' && b !== '35');
  assert.deepEqual(second.got, want, 'in their original order; the first 20 again too (a repeat changes nothing)');
  assert.equal(acks.length, 40, 'nothing is acknowledged twice');
  assert.ok(logs.some((l) => /sending the 40 packets of the minute before the connection dropped again/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /not sent again, out of date.*"BIB":"35"/.test(l)), 'bib 35 finished meanwhile');
  assert.equal(statusOf(m).queued, 0);
});

test('only what the dropped connection took in its last minute goes again (redeliverMs)', async (t) => {
  const first = await hangingTarget(t);
  const { m } = manager(t, [output({ port: first.port })], { redeliverMs: 400 });
  for (let b = 1; b <= 3; b++) m.send(packet({ bib: String(b) }));
  await until(() => first.got.length === 3, 'the first 3');
  await pause(600); // older than the window by the time the connection drops
  for (let b = 4; b <= 6; b++) m.send(packet({ bib: String(b) }));
  await until(() => first.got.length === 6, 'all 6 read');
  await first.kill();
  await until(() => statusOf(m).state === 'connecting', 'the drop to be noticed');
  const second = await hangingTarget(t, first.port);
  await until(() => second.got.length === 3, 'the last 3 again');
  await pause(100);
  assert.deepEqual(second.got, ['4', '5', '6']);
  // the operator presses Reconnect (TrackScore looks stuck): the last minute goes again as well
  m.reconnect('o1');
  await until(() => statusOf(m).state === 'connected', 'connected again');
  await until(() => second.got.length === 6, 'a manual reconnect sends the last minute again too');
  assert.deepEqual(second.got.slice(3), ['4', '5', '6']);
});

test('reconnect() re-dials now; an unknown output id throws', async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port })]);
  m.sync();
  await until(() => statusOf(m).state === 'connected', 'connected');
  m.reconnect('o1');
  await until(() => sink.conns.length === 2 && sink.conns[0].closed, 'a new connection');
  m.send(packet());
  await until(() => sink.conns[1].chunks.length > 0, 'the packet on the new connection');
  assert.equal(Buffer.concat(sink.conns[1].chunks).toString('latin1'), encodeCp1252(XC_PACKET).toString('latin1'));
  assert.throws(() => m.reconnect('nope'), /no output with id "nope"/);
  assert.throws(() => m.preview('nope'), (err) => err.code === 'ENOOUTPUT');
});

test('fixing the IP or port mid-race delivers what was queued for the wrong one', async (t) => {
  const wrong = await freePort();
  const sink = await tcpSink(t);
  const { m, config } = manager(t, [output({ port: wrong })]);
  m.send(packet({ bib: '11' }));
  m.send(packet({ bib: '12' }));
  await until(() => statusOf(m).queued === 2, 'queued');
  config.outputs = [output({ port: sink.port })];
  m.sync();
  await until(() => sink.packets().length === 2, 'the flush');
  assert.deepEqual(bibs(sink.packets()), ['11', '12']);
});

test('tcp-server mode broadcasts each packet to every connected client', async (t) => {
  const { m, logs } = manager(t, [output({ id: 'srv', name: 'Board', mode: 'tcp-server', host: '127.0.0.1', port: 0 })]);
  m.sync();
  // the script first: a packet given while it is still being read waits for it instead (flaky under load otherwise)
  await m.checkScripts();
  const port = await until(() => statusOf(m, 'srv').state === 'listening' && statusOf(m, 'srv').localPort, 'listening');

  // nobody connected: nothing is kept for later, but the log says so
  m.send(packet({ bib: '9' }));
  assert.ok(logs.some((l) => l.startsWith('[out Board] not sent (no client is connected)')), logs.join('\n'));
  assert.equal(statusOf(m, 'srv').dropped, 1);

  const clients = [];
  for (let i = 0; i < 2; i++) {
    const sock = net.connect(port, '127.0.0.1');
    const c = { sock, chunks: [] };
    sock.on('data', (d) => c.chunks.push(d));
    sock.on('error', () => {});
    t.after(() => sock.destroy());
    clients.push(c);
  }
  await until(() => statusOf(m, 'srv').clients === 2, 'two clients');
  m.send(packet());
  const want = encodeCp1252(XC_PACKET);
  await until(() => clients.every((c) => Buffer.concat(c.chunks).length === want.length), 'both clients');
  for (const c of clients) assert.deepEqual(Buffer.concat(c.chunks), want);

  clients[0].sock.end();
  await until(() => statusOf(m, 'srv').clients === 1, 'one client left');
  m.send(packet({ bib: '55' }));
  await until(() => split(Buffer.concat(clients[1].chunks)).length === 2, 'the second packet');
  assert.deepEqual(bibs(split(Buffer.concat(clients[1].chunks))), ['1234', '55']);
  assert.equal(split(Buffer.concat(clients[0].chunks)).length, 1);
  // sent counts acknowledged writes; the write callback may come after the client already has the bytes
  const s = await until(() => statusOf(m, 'srv').sent === 2 && statusOf(m, 'srv'), 'sent count');
  assert.equal(s.sent, 2);
  assert.equal(s.state, 'listening');
});

test('udp sends one datagram per packet', async (t) => {
  const rx = dgram.createSocket('udp4');
  const got = [];
  rx.on('message', (msg) => got.push(msg));
  await new Promise((resolve) => rx.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => rx.close(resolve)));
  const { m } = manager(t, [output({ id: 'u', name: 'UDP board', mode: 'udp', port: rx.address().port })]);
  m.send(packet());
  m.send(packet({ bib: '88' }));
  await until(() => got.length === 2, 'two datagrams');
  assert.deepEqual(got[0], encodeCp1252(XC_PACKET));
  assert.deepEqual(bibs(got.map((b) => b.toString('latin1'))), ['1234', '88']);
  await until(() => statusOf(m, 'u').sent === 2, 'sent count');
  assert.equal(statusOf(m, 'u').state, 'connected');
});

test('a missing script is a clear scriptError, nothing is sent, and the file is picked up once it exists', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'XCScore.lss');
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [output({ port: sink.port, script: path })]);
  m.sync();
  await m.checkScripts();
  let s = statusOf(m);
  assert.equal(s.scriptOk, false);
  assert.match(s.scriptError, /Script file not found: .*XCScore\.lss/);
  assert.equal(s.state, 'error');
  assert.equal(s.lastError, s.scriptError);
  assert.equal(m.send(packet()), 1);
  await pause(100);
  assert.equal(sink.bytes().length, 0);
  assert.equal(statusOf(m).dropped, 1);
  assert.ok(logs.some((l) => l.startsWith('[out TrackScore] not sent (script error: Script file not found')), logs.join('\n'));
  assert.equal(logs.filter((l) => l.includes('This output sends nothing until the script is fixed')).length, 1);
  const preview = m.preview('o1', null);
  assert.equal(preview.text, '');
  assert.match(preview.warnings[0], /not found/);

  copyFileSync(XC, path);
  await m.checkScripts();
  s = statusOf(m);
  assert.equal(s.scriptOk, true);
  assert.equal(s.scriptError, null);
  m.send(packet());
  await until(() => sink.packets().length === 1, 'the packet');
  assert.deepEqual(sink.bytes(), encodeCp1252(XC_PACKET));
});

test('a script edited on disk is reloaded; if it disappears the last good copy keeps sending', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'board.lss');
  copyFileSync(XC, path);
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [output({ port: sink.port, script: `"${path}"` })], { scriptPollMs: 25 });
  m.send(packet({ bib: '1' }));
  await until(() => sink.packets().length === 1, 'packet 1');
  assert.ok(!sink.packets()[0].includes('MID'));

  writeFileSync(path, readFileSync(KARMARUSH)); // the poll notices the new mtime and size
  await until(() => statusOf(m).scriptInfo.mid === '8132', 'the reload');
  assert.ok(logs.some((l) => l.includes('script changed on disk, reloaded')), logs.join('\n'));
  m.send(packet({ bib: '2' }));
  await until(() => sink.packets().length === 2, 'packet 2');
  assert.ok(sink.packets()[1].startsWith('{"T":"T","D":{"MID":8132,'), sink.packets()[1]);

  rmSync(path);
  await until(() => statusOf(m).warnings.some((w) => /still using the copy loaded at/.test(w)), 'the re-read warning');
  assert.equal(statusOf(m).scriptOk, true);
  m.send(packet({ bib: '3' }));
  await until(() => sink.packets().length === 3, 'packet 3');
  assert.match(sink.packets()[2], /"MID":8132,.*"BIB":"3"/);
});

test('a script with no section for the stage, or a folder, is a scriptError', async (t) => {
  const dir = tempDir(t);
  const headerOnly = join(dir, 'header-only.lss');
  writeFileSync(headerOnly, ';;StartListHeader\r\n\\13\\00{\r\n');
  mkdirSync(join(dir, 'folder.lss'));
  const sink = await tcpSink(t);
  const { m } = manager(t, [
    output({ id: 'a', port: sink.port, script: headerOnly }),
    output({ id: 'b', port: sink.port, script: join(dir, 'folder.lss') }),
    output({ id: 'c', port: sink.port, script: '' }),
  ]);
  m.sync();
  await m.checkScripts();
  assert.match(statusOf(m, 'a').scriptError, /has no ;;Results section, so this output would send nothing \(the file has ;;StartListHeader\)/);
  assert.match(statusOf(m, 'b').scriptError, /folder, not a \.lss file/);
  assert.match(statusOf(m, 'c').scriptError, /No script file is chosen/);
  assert.equal(m.send(packet()), 3);
  await pause(100);
  assert.equal(sink.bytes().length, 0);
  for (const id of ['a', 'b', 'c']) assert.equal(statusOf(m, id).state, 'error');
});

test('preview shows exactly what would be sent, and flags invalid JSON', async (t) => {
  const sink = await tcpSink(t);
  const { m, config } = manager(t, [output({ port: sink.port })]);
  m.sync();
  await m.checkScripts();
  const sample = m.preview('o1', null);
  assert.equal(sample.isJson, true);
  assert.deepEqual(sample.jsonErrors, []);
  assert.match(sample.text, /^\{"T":"T","D":\{"EN":3,"R":1,"H":1,"S":"UNOFFICIAL","DS":"","DN":"Girls Varsity 5K",/);
  assert.match(sample.text, /"BIB":"1234","N":"Quill","AF":"Lakeside HS",.*"L2G":"2","CS":"5:12.345"/);
  assert.ok(sample.display.endsWith('}}\\0d\\0a'), sample.display);
  assert.ok(!sample.display.includes('\r'));
  const real = m.preview('o1', packet());
  assert.equal(real.text, XC_PACKET);
  assert.equal(sink.bytes().length, 0, 'a preview sends nothing');

  // XCScore's ;;StartedHeader emits a stray comma: still sent, but the card says why TrackScore ignores it
  config.outputs = [output({ port: sink.port, stage: 'started' })];
  const started = m.preview('o1', null);
  assert.equal(started.jsonErrors.length, 1);
  assert.match(statusOf(m).warnings.join('\n'), /not valid JSON/);
  m.send(packet());
  await until(() => sink.packets().length === 1, 'the packet');
  assert.ok(sink.packets()[0].startsWith('{"T":"T","D":{,"EN":3'));
  assert.match(statusOf(m).lastError, /not valid JSON/);
  assert.equal(statusOf(m).state, 'connected');

  // the sample uses the first race the output sends
  config.outputs = [output({ port: sink.port, races: ['r2'] })];
  assert.match(m.preview('o1').text, /"EN":4,.*"DN":"Boys Varsity 5K"/);
  assert.equal(samplePacket({ races: [] }, {}).race.name, 'Sample Race 5K');
});

test('a "Command=LayoutDraw;Name=Start List" in the rendered packet is warned about', async (t) => {
  const dir = tempDir(t);
  const rearm = join(dir, 'rearm.lss');
  writeFileSync(rearm, [
    ';;ResultsHeader', '\\13\\00Command=LayoutDraw;Name=Start List;\\0a', ';;Results', '\\14\\03{"BIB":"%s"}\\0d\\0a', '',
  ].join('\r\n'));
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [
    output({ id: 'bad', name: 'Bad', port: sink.port, script: rearm }),
    output({ id: 'track', name: 'Track', port: sink.port, script: TRACK }),
  ]);
  m.sync();
  await m.checkScripts();
  const bad = m.preview('bad', null);
  assert.equal(bad.text, 'Command=LayoutDraw;Name=Start List;\n{"BIB":"1234"}\r\n');
  assert.match(bad.warnings[0], /Name=Start List".*re-arm.*may wipe the live race/);
  assert.match(statusOf(m, 'bad').warnings.join('\n'), /re-arm/);
  assert.ok(logs.some((l) => l.startsWith('[out Bad] warning: Every packet contains')), logs.join('\n'));

  // the track script's ;;TimeArmed has a Start List line too, but only its Results layout is ever sent
  const track = m.preview('track', null);
  assert.ok(track.text.startsWith('Command=LayoutDraw;Name=Results;\n{"T":"T","D":{"EN":3,'), track.text);
  assert.deepEqual(track.jsonErrors, []);
  assert.ok(!track.warnings.some((w) => /re-arm/.test(w)));
  assert.deepEqual(statusOf(m, 'track').warnings, []);
});

test('disabled outputs and bad settings send nothing and say why', async (t) => {
  const sink = await tcpSink(t);
  const { m, config } = manager(t, [
    output({ id: 'off', port: sink.port, enabled: false }),
    output({ id: 'port', port: 'abc' }),
    output({ id: 'mode', mode: 'serial', port: sink.port }),
  ]);
  assert.equal(m.send(packet()), 2);
  await m.checkScripts();
  await pause(100);
  assert.equal(sink.conns.length, 0);
  assert.equal(statusOf(m, 'off').state, 'disabled');
  assert.equal(statusOf(m, 'port').state, 'error');
  assert.match(statusOf(m, 'port').lastError, /"abc" is not a port number/);
  assert.match(statusOf(m, 'mode').lastError, /Unknown connection type "serial"/);

  config.outputs = [output({ id: 'off', port: sink.port, enabled: true })];
  m.sync();
  assert.equal(m.status().length, 1);
  await until(() => statusOf(m, 'off').state === 'connected', 'enabled and connected');
});

test('deliver() acknowledges once the socket took the bytes, never synchronously; refuses what the output cannot take', async (t) => {
  const dir = tempDir(t);
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [
    output({ port: sink.port }),
    output({ id: 'off', name: 'Off', port: sink.port, enabled: false }),
    output({ id: 'bad', name: 'Bad', port: sink.port, script: join(dir, 'missing.lss') }),
  ]);
  m.sync();
  await m.checkScripts();
  const acks = [];
  assert.equal(m.deliver('o1', packet(), (ok) => acks.push(ok)), true);
  assert.deepEqual(acks, [], 'not from inside deliver()');
  await until(() => acks.length === 1, 'the acknowledgement');
  assert.deepEqual(acks, [true]);
  await until(() => sink.packets().length === 1, 'the packet'); // the receiving end may see it a moment later
  assert.deepEqual(sink.bytes(), encodeCp1252(XC_PACKET));
  assert.equal(m.deliver('off', packet(), () => acks.push('off')), false);
  assert.equal(m.deliver('bad', packet(), () => acks.push('bad')), false);
  assert.equal(m.deliver('bad', packet(), () => acks.push('bad')), false);
  assert.equal(m.deliver('nope', packet(), () => acks.push('nope')), false);
  await pause(20);
  assert.deepEqual(acks, [true], 'a refused packet is never acknowledged');
  assert.equal(logs.filter((l) => l.startsWith('[out Bad] not taking packets (script error: Script file not found')).length, 1,
    'one line per reason, not one per packet');
  const s = statusOf(m);
  assert.deepEqual([s.sent, s.behind, s.lagSec], [1, 0, 0]);
});

test('laps-to-go safety (DESIGN 9.15 L6): a packet with laps to go < 1 or > the split count, or a finish time, is refused, logged and counted', async (t) => {
  const sink = await tcpSink(t);
  const { m, logs } = manager(t, [output({ port: sink.port })]);
  m.sync();
  await m.checkScripts();
  const acks = [];
  const bad = [
    packet({ bib: '1', lapsToGo: 0 }), // "finished" to TrackScore: it would overwrite the finish place
    packet({ bib: '2', lapsToGo: -1 }),
    packet({ bib: '3', lapsToGo: 4 }), // more than the race's 3 splits
    packet({ bib: '4', lapsToGo: 3, splitCount: 2 }),
    packet({ bib: '5', lapsToGo: '2' }),
    packet({ bib: '6', lapsToGo: 2.5 }),
    packet({ bib: '7', lapsToGo: undefined }),
    packet({ bib: '8', lapsToGo: 3, race: { ...RACE, splits: RACE.splits.slice(0, 2) } }), // the race now has 2 splits
  ];
  for (const p of bad) assert.equal(m.deliver('o1', p, (ok) => acks.push(ok)), false, `bib ${p.bib}`);
  assert.equal(m.deliver('o1', packet({ bib: '9', lapsToGo: 1 }), (ok) => acks.push(ok)), true, 'the last split, L2G 1, is fine');
  await until(() => sink.packets().length === 1, 'the good packet');
  assert.deepEqual(bibs(sink.packets()), ['9'], 'nothing refused reached the wire');
  assert.deepEqual(acks, [true]);
  const s = statusOf(m);
  assert.equal(s.refused, bad.length);
  assert.match(s.refusedReason, /^Refused a packet that must never be sent: laps to go 3 is more than the race's 2 splits \(bib 8 at 2K\)/);
  assert.equal(s.warnings[0], s.refusedReason, 'the card says so first');
  assert.equal(logs.filter((l) => /^\[out TrackScore\] ERROR refused a packet that must never be sent/.test(l)).length, bad.length, 'each one is logged');
  assert.match(logs.find((l) => l.includes('bib 1')), /laps to go 0 would mean "finished" to TrackScore and Karmarush/);
  // a finish time in \14\06 would make the runner a finisher: never on the wire either
  const p = packet();
  const vars = packetVariables(p);
  assert.equal(packetProblem(p, vars), null);
  vars.rows[0][0x06] = '15:03.968';
  assert.match(packetProblem(p, vars), /has a finish time, which would make the runner a finisher/);
  // send() (tools) goes through the same check
  assert.equal(m.send(packet({ bib: '10', lapsToGo: 0 })), 1);
  await pause(30);
  assert.deepEqual(bibs(sink.packets()), ['9']);
  assert.equal(statusOf(m).refused, bad.length + 1);
});

test('a packet given while the script is still being read waits for it, then is acknowledged', async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port })]);
  const acks = [];
  assert.equal(m.deliver('o1', packet({ bib: '7' }), (ok) => acks.push(ok)), true);
  await until(() => acks.length === 1, 'the acknowledgement');
  assert.deepEqual(acks, [true]);
  // acknowledged = the socket took it; the receiving end may see it a moment later
  await until(() => sink.packets().length === 1, 'the packet');
  assert.deepEqual(bibs(sink.packets()), ['7']);
});

test('packets for a target that is down are behind, with an age; at stop they are dropped and the log says so (race-day-sim F1, F3)', async (t) => {
  const port = await freePort();
  const { m, logs } = manager(t, [output({ port })]);
  m.sync();
  await m.checkScripts();
  const acks = [];
  for (const bib of ['1', '2', '3']) assert.equal(m.deliver('o1', packet({ bib }), (ok) => acks.push(ok)), true);
  await pause(150);
  const s = statusOf(m);
  assert.deepEqual([s.queued, s.behind], [3, 3]);
  assert.ok(s.lagSec >= 0.1, `lagSec ${s.lagSec}`);
  assert.deepEqual(m.undelivered(), [{ name: 'TrackScore', behind: 3 }]);
  await m.stop();
  await until(() => acks.length === 3, 'the acknowledgements');
  assert.deepEqual(acks, [false, false, false], 'not delivered: the engine sends them after the next start');
  assert.ok(logs.some((l) => /stopped with 3 packets not sent; they are sent when Split Relay starts again/.test(l)), logs.join('\n'));
});

test('a queued packet that is out of date when the target is back is not written', async (t) => {
  const port = await freePort();
  const { m, logs } = manager(t, [output({ port })]);
  m.sync();
  await m.checkScripts();
  let current = true;
  const acks = [];
  const old = packet({ bib: '1' });
  Object.defineProperty(old, 'isCurrent', { value: () => current });
  m.deliver('o1', old, (ok) => acks.push(['1', ok]));
  m.deliver('o1', packet({ bib: '2' }), (ok) => acks.push(['2', ok]));
  await until(() => statusOf(m).queued === 2, 'two queued');
  current = false; // the runner finished while TrackScore was unreachable
  const sink = await tcpSink(t, port);
  await until(() => sink.packets().length === 1 && acks.length === 2, 'the flush');
  await pause(30);
  assert.deepEqual(bibs(sink.packets()), ['2']);
  assert.deepEqual(acks.sort(), [['1', false], ['2', true]]);
  assert.ok(logs.some((l) => /not sent, out of date by the time it could go out/.test(l)), logs.join('\n'));
});

test('a connected output keeps its backlog in its queue, where a packet that went out of date is still held back (race-day-sim F3)', async (t) => {
  // A slow output (live results over a tent uplink) would otherwise get its whole backlog written into the socket at
  // once: nothing there can be held back any more, and the status could not see it (measured: "behind 0" while the
  // target was 548 packets behind). socketBacklogBytes 1 = one packet in the socket at a time, so this test does not
  // depend on how much the OS buffers.
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port })], { socketBacklogBytes: 1 });
  m.sync();
  await m.checkScripts();
  await until(() => statusOf(m).state === 'connected', 'the connection');
  let current = true;
  const acks = [];
  m.deliver('o1', packet({ bib: '1' }), (ok) => acks.push(['1', ok]));
  const two = packet({ bib: '2' });
  Object.defineProperty(two, 'isCurrent', { value: () => current });
  m.deliver('o1', two, (ok) => acks.push(['2', ok]));
  m.deliver('o1', packet({ bib: '3' }), (ok) => acks.push(['3', ok]));
  const s = statusOf(m);
  assert.deepEqual([s.state, s.queued, s.behind], ['connected', 2, 3], 'the backlog shows while connected');
  current = false; // bib 2 finished while it waited behind bib 1
  await until(() => acks.length === 3 && sink.packets().length === 2, 'the queue to drain');
  assert.deepEqual(bibs(sink.packets()), ['1', '3'], 'in order, without the packet that went out of date');
  assert.deepEqual(acks, [['1', true], ['2', false], ['3', true]]);
  assert.equal(statusOf(m).behind, 0);
});

test('tcp-server acknowledges a packet only when a client took it; udp when the datagram went', async (t) => {
  const rx = dgram.createSocket('udp4');
  await new Promise((resolve) => rx.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => rx.close(resolve)));
  const { m } = manager(t, [
    output({ id: 'srv', name: 'Board', mode: 'tcp-server', host: '127.0.0.1', port: 0 }),
    output({ id: 'u', name: 'UDP board', mode: 'udp', port: rx.address().port }),
  ]);
  m.sync();
  await m.checkScripts();
  const port = await until(() => statusOf(m, 'srv').localPort, 'listening');
  await until(() => statusOf(m, 'u').state === 'connected', 'udp open');
  const acks = [];
  m.deliver('srv', packet({ bib: '1' }), (ok) => acks.push(['srv', ok]));
  m.deliver('u', packet({ bib: '2' }), (ok) => acks.push(['u', ok]));
  await until(() => acks.length === 2, 'two acknowledgements');
  assert.deepEqual(acks.sort(), [['srv', false], ['u', true]], 'nobody was connected to the board');
  const sock = net.connect(port, '127.0.0.1');
  sock.on('data', () => {});
  sock.on('error', () => {});
  t.after(() => sock.destroy());
  await until(() => statusOf(m, 'srv').clients === 1, 'a client');
  m.deliver('srv', packet({ bib: '3' }), (ok) => acks.push(['srv', ok]));
  await until(() => acks.length === 3, 'the third acknowledgement');
  assert.deepEqual(acks[2], ['srv', true]);
});

test('an unknown gender sends no LICENCE, so TrackScore keeps the gender FinishLynx gave (review-edges F11)', async (t) => {
  const sink = await tcpSink(t);
  const { m } = manager(t, [output({ port: sink.port }), output({ id: 'live', name: 'Live', port: sink.port, script: KARMARUSH })]);
  m.send(packet({ gender: '' }));
  m.send(packet({ gender: 'F', bib: '2' }));
  await until(() => sink.packets().length === 4, 'four packets');
  const xc = sink.packets().filter((p) => !p.includes('"MID"'));
  assert.equal(xc.find((p) => p.includes('"BIB":"1234"')), encodeCp1252(XC_PACKET.replace(',"LICENCE":"F"', '')).toString('latin1'));
  assert.equal('LICENCE' in JSON.parse(xc.find((p) => p.includes('"BIB":"1234"'))).D, false);
  assert.equal(JSON.parse(xc.find((p) => p.includes('"BIB":"2"'))).D.LICENCE, 'F');
  for (const p of sink.packets()) JSON.parse(p);
  assert.equal(m.preview('o1', packet({ gender: '' })).isJson, true);
});

test('stop() closes every connection, listener and socket', async (t) => {
  const kinds = ['TCPSocketWrap', 'TCPServerWrap', 'UDPWrap'];
  const count = () => process.getActiveResourcesInfo().filter((k) => kinds.includes(k)).length;
  const baseline = count();
  const sink = await tcpSink(t);
  const rx = dgram.createSocket('udp4');
  await new Promise((resolve) => rx.bind(0, '127.0.0.1', resolve));
  let rxOpen = true;
  t.after(() => rxOpen && rx.close());
  const { m } = manager(t, [
    output({ id: 'client', port: sink.port }),
    output({ id: 'server', mode: 'tcp-server', host: '127.0.0.1', port: 0 }),
    output({ id: 'udp', mode: 'udp', port: rx.address().port }),
    output({ id: 'down', port: await freePort() }),
  ]);
  m.sync();
  const port = await until(() => statusOf(m, 'server').localPort, 'listening');
  const board = net.connect(port, '127.0.0.1');
  board.on('error', () => {});
  board.on('data', () => {}); // a reader that never reads would never see the server's FIN
  t.after(() => board.destroy());
  let boardClosed = false;
  board.on('close', () => {
    boardClosed = true;
  });
  await until(() => statusOf(m, 'server').clients === 1 && statusOf(m, 'client').state === 'connected' &&
    statusOf(m, 'udp').state === 'connected', 'everything up');
  m.send(packet());
  await until(() => sink.packets().length === 1, 'the packet');

  await m.stop();
  await until(() => sink.conns[0].closed && boardClosed, 'the peers to see the close');
  assert.equal(m.send(packet()), 0);
  // the listening port is free again
  const again = net.createServer();
  await new Promise((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => again.close(resolve));
  await sink.close();
  rxOpen = false;
  await new Promise((resolve) => rx.close(resolve));
  // <= : the baseline may include a handle of the previous test that was still closing
  const closed = await until(() => count() <= baseline, 'handles to close').catch(() => false);
  assert.ok(closed, `still open: ${process.getActiveResourcesInfo().join(', ')}`);
  await m.stop(); // a second stop is harmless
});

test('9.26: laps to go is checked against the splits that are sent, and the sample packet is one that could go out', () => {
  const race = { ...RACE, splits: [{ id: 's1', name: '4K' }, { id: 's2', name: '4.2K', collectOnly: true }, { id: 's3', name: '5K' }] };
  // 4K of two sent splits: laps to go 2 of 2
  const ok = packet({ race, splitId: 's1', splitName: '4K', splitIndex: 0, splitCount: 2, lapsToGo: 2 });
  assert.equal(packetProblem(ok, packetVariables(ok)), null);
  assert.equal(packetVariables(ok).rows[0][0x0a], '2');
  // a packet that counted the split that is not sent would file 4K a column early on the boards: refused
  const three = packet({ race, splitId: 's1', splitName: '4K', splitIndex: 0, splitCount: 3, lapsToGo: 3 });
  assert.match(packetProblem(three, packetVariables(three)), /^laps to go 3 is more than the race's 2 splits \(bib 1234 at 4K\)$/);
  // and one for the split that is not sent has no laps to go at all
  const none = packet({ race, splitId: 's2', splitName: '4.2K', splitIndex: -1, splitCount: 2, lapsToGo: null });
  assert.match(packetProblem(none, packetVariables(none)), /is not a whole number/);
  const sample = samplePacket({ races: [{ ...race, splits: [race.splits[1], race.splits[0], race.splits[2]] }] }, {});
  assert.deepEqual([sample.splitCount, sample.splitIndex, sample.lapsToGo, sample.splitName, sample.splitId], [2, 1, 1, '5K', 's3']);
  assert.equal(packetProblem(sample, packetVariables(sample)), null);
});
