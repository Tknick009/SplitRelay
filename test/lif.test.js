import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLif, lifFileName, mergeLif, LifSync, pathKind, fullPathProblem } from '../src/lif.js';
import { decodeCp1252, encodeCp1252 } from '../src/cp1252.js';
import { parseTod, parseRaceTime as rt } from '../src/timefmt.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lif');
const GUN = parseTod('12:58:49.2595');
const race3 = { id: 'r_boys', name: 'Boys Gold 5K', eventNumber: '3', round: '1', heat: '1' };

const runner = (last, first, team, gender, splits) => ({ first, last, team, gender, splits: splits.map((s) => (s ? rt(s) : null)) });

/** Relay crossings for the 003-1-01.lif fixture: two splits, every case the merge has to handle. */
function boysRunners() {
  return new Map([
    ['101', runner('Ashford', 'Nolan', 'Riverside', 'M', ['4:55.339', '10:08.670'])],
    ['214', runner('O’Brennan', 'Liam', 'Lakeview', 'M', ['4:55.372', '10:08.773'])],
    ['377', runner('Whitfield, Jr.', 'Owen', 'Hollow Creek', 'M', [null, '10:21.803'])], // missed the first mat
    ['458', runner('Zoë-Marsh', 'Theo', '', 'M', ['5:01.323', null])], // Lynx has the bib as 0458
    ['610', runner('Quill', 'Asher', 'Lakeview', 'M', ['5:19.837', null])], // DNF row in Lynx
    ['702', runner('Rourke', 'Ezra', 'Hollow Creek', 'M', ['5:37.589', '11:04.465'])], // blank-place row in Lynx
    ['801', runner('Vance', 'Silas', 'Lakeview', 'M', ['5:10.000', '10:40.250'])], // not in Lynx
    ['802', runner('Kettering "JK"', 'Jonah', 'North, East Academy', 'M', ['5:12.500', '10:39.900'])],
    ['803', runner('Tolland', 'Rhys', '', '', ['5:30.000', null])],
    ['804', runner('Brandt', 'Callum', 'Riverside', 'M', [null, '11:00.000'])],
    ['805', runner('Nobody', 'Here', '', 'M', [null, null])], // in the map but never crossed a mat
  ]);
}

const readFixture = (name) => fsp.readFile(path.join(FIXTURES, name));
const lines = (text) => text.split('\r\n').slice(0, -1);

/** Raw fields with quotes kept, to check that untouched fields really are untouched. */
function rawFields(line) {
  const out = [];
  let start = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ',' && !q) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

test('parseLif reads the FinishLynx layout: header, 19-field rows, quoted fields, non-finishers', async () => {
  const { header, rows } = parseLif(decodeCp1252(await readFixture('003-1-01.lif')));
  assert.deepEqual(header.fields, ['3', '1', '1', 'Boys Gold 5K', '', '', '', '', '', '', '12:58:49.2595']);
  assert.equal(header.line, '3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595');
  assert.equal(rows.length, 7);
  for (const r of rows) assert.equal(r.fields.length, 19, r.line);
  assert.equal(rows[2].fields[3], 'Whitfield, Jr.');
  assert.equal(rows[1].fields[3], 'O’Brennan');
  assert.deepEqual([rows[3].bib, rows[3].place, rows[3].time], ['0458', '4', '15:31.552']);
  assert.deepEqual([rows[5].place, rows[5].bib, rows[5].time], ['DNF', '610', '']);
  assert.deepEqual([rows[6].place, rows[6].bib], ['', '702']);

  const real = '1,5713,,Last,First,Team,15:03.968,M,15:03.97,,"4:55.339 (4:55.339),10:08.670 (5:13.331),15:03.968 (4:55.298)",12:58:49.260,,,,15:03.97,15:03.97,,5:01.33';
  const one = parseLif(`1,1,1,Boys Gold,,,,,,,12:58:49.2595\r\n\r\n${real}\n`);
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].fields.length, 19);
  assert.equal(one.rows[0].fields[10], '4:55.339 (4:55.339),10:08.670 (5:13.331),15:03.968 (4:55.298)');
  assert.equal(one.rows[0].fields[18], '5:01.33');
  assert.equal(one.rows[0].line, real);

  // A first line that is a full row is not a header, even without a first name.
  const noHeader = parseLif('1,12,,Solo,,,15:00.000,M,,,15:00.000 (15:00.000),12:00:00.000,,,,,,,15:00.00\r\n');
  assert.equal(noHeader.header, null);
  assert.equal(noHeader.rows.length, 1);
  assert.deepEqual(parseLif(''), { header: null, rows: [] });
});

test('lifFileName follows FinishLynx: event 3 digits, round, heat 2 digits', () => {
  assert.equal(lifFileName('3', '1', '1'), '003-1-01.lif');
  assert.equal(lifFileName(12, 2, 3), '012-2-03.lif');
  assert.equal(lifFileName('003', '01', '01'), '003-1-01.lif');
  assert.equal(lifFileName('1234', '1', '12'), '1234-1-12.lif');
  assert.equal(lifFileName('7', '', ''), '007-1-01.lif');
  assert.equal(lifFileName('3A', '1', '1'), '03A-1-01.lif');
  assert.equal(lifFileName('3/4', '1', '1'), '034-1-01.lif');
});

test('mergeLif into a FinishLynx file: field 10 and 18 rebuilt, everything else untouched', async () => {
  const lynxText = decodeCp1252(await readFixture('003-1-01.lif'));
  const out = mergeLif({ lynxText, race: race3, gunTicks: GUN, splitCount: 2, runners: boysRunners() });
  const inLines = lines(lynxText);
  const got = lines(out);

  assert.equal(got[0], inLines[0], 'header verbatim');
  assert.equal(got[1], '1,101,,Ashford,Nolan,Riverside,15:03.968,M,15:03.97,,"4:55.339 (4:55.339),10:08.670 (5:13.331),15:03.968 (4:55.298)",12:58:49.260,,,,15:03.97,15:03.97,,5:01.33');
  assert.equal(got[2], '2,214,,O’Brennan,Liam,Lakeview,15:05.709,M,same time,,"4:55.372 (4:55.372),10:08.773 (5:13.401),15:05.709 (4:56.936)",12:58:49.260,,,,1.74,1.74,,5:01.91');
  // Missed mat: an empty slot keeps the second split on the second mat.
  assert.equal(got[3], '3,377,,"Whitfield, Jr.",Owen,Hollow Creek,15:20.004,M,same time,,",10:21.803 (10:21.803),15:20.004 (4:58.201)",12:58:49.260,,,,16.04,16.04,,7:40.01');
  assert.equal(got[4], '4,0458,,Zoë-Marsh,Theo,Unattached,15:31.552,M,same time,,"5:01.323 (5:01.323),,15:31.552 (10:30.229)",12:58:49.260,,,,27.59,27.59,,7:45.78');
  assert.equal(got[5], inLines[5], 'a runner without relay crossings is byte-for-byte');
  // Non-finishers: trailing empty slot dropped, a single entry is written bare as FinishLynx does.
  assert.equal(got[6], 'DNF,610,,Quill,Asher,Lakeview,,M,,,5:19.837 (5:19.837),12:58:49.260,,,,,,,5:19.84');
  assert.equal(got[7], ',702,,Rourke,Ezra,Hollow Creek,,M,,,"5:37.589 (5:37.589),11:04.465 (5:26.876)",12:58:49.260,,,,,,,5:32.24');

  for (let i = 1; i <= 7; i++) {
    const a = rawFields(got[i]);
    const b = rawFields(inLines[i]);
    assert.equal(a.length, 19);
    for (let f = 0; f < 19; f++) if (f !== 10 && f !== 18) assert.equal(a[f], b[f], `row ${i} field ${f}`);
  }

  // Relay-only runners, after every Lynx row: furthest split first, then time there; 805 never crossed a mat.
  assert.deepEqual(got.slice(8), [
    ",802,,Kettering 'JK',Jonah,\"North, East Academy\",,M,,,\"5:12.500 (5:12.500),10:39.900 (5:27.400)\",12:58:49.260,,,,,,,5:19.95",
    ',801,,Vance,Silas,Lakeview,,M,,,"5:10.000 (5:10.000),10:40.250 (5:30.250)",12:58:49.260,,,,,,,5:20.13',
    ',804,,Brandt,Callum,Riverside,,M,,,",11:00.000 (11:00.000)",12:58:49.260,,,,,,,11:00.00',
    ',803,,Tolland,Rhys,,,,,,5:30.000 (5:30.000),12:58:49.260,,,,,,,5:30.00',
  ]);
  for (const l of got.slice(8)) assert.equal(rawFields(l).length, 19);
  assert.ok(!out.includes('805'));
});

test('mergeLif output: CRLF everywhere, a CRLF after the last line, windows-1252 bytes preserved', async () => {
  const input = await readFixture('003-1-01.lif');
  const outBuf = encodeCp1252(mergeLif({ lynxText: decodeCp1252(input), race: race3, gunTicks: GUN, splitCount: 2, runners: boysRunners() }));
  const text = outBuf.toString('latin1');
  assert.ok(text.endsWith('\r\n'));
  assert.equal(/(?<!\r)\n|\r(?!\n)/.test(text), false, 'no bare LF or CR');

  const split = (buf) => {
    const parts = [];
    let start = 0;
    for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0d && buf[i + 1] === 0x0a) { parts.push(buf.subarray(start, i)); start = i + 2; }
    return parts;
  };
  const inRows = split(input);
  const outRows = split(outBuf);
  assert.ok(outRows[0].equals(inRows[0]));
  assert.ok(outRows[5].equals(inRows[5]), 'unrelated row identical in bytes');
  assert.ok(outRows[2].includes(Buffer.from([0x4f, 0x92, 0x42])), 'O’B stays 0x92');
  assert.ok(outRows[4].includes(Buffer.from([0x5a, 0x6f, 0xeb])), 'Zoë stays 0xEB');

  // A Lynx file with no relay crossings at all comes back exactly as it went in.
  assert.ok(encodeCp1252(mergeLif({ lynxText: decodeCp1252(input), race: race3, gunTicks: GUN, splitCount: 2, runners: new Map() })).equals(input));
});

test('mergeLif: short rows are padded to 19 fields; the finish leg keeps the finish precision', () => {
  const lynxText = '5,1,1,Open,,,,,,,15:29:07.6505\r\n' +
    '1,9,,Short,Row,Team,20:00.000,F,,,20:00.000 (20:00.000)\r\n' +
    '2,10,,Hand,Timed,Team,32:20.85,F,same time,,32:20.85 (32:20.85),15:29:07.651,,,,1.00,1.00,,32:20.85\r\n';
  const runners = new Map([
    ['9', runner('Short', 'Row', 'Team', 'F', ['6:40.000', '13:20.000'])],
    ['10', runner('Hand', 'Timed', 'Team', 'F', ['9:00.677', '20:02.498'])],
  ]);
  const got = lines(mergeLif({ lynxText, race: {}, gunTicks: parseTod('15:29:07.6505'), splitCount: 2, runners }));
  assert.equal(got[1], '1,9,,Short,Row,Team,20:00.000,F,,,"6:40.000 (6:40.000),13:20.000 (6:40.000),20:00.000 (6:40.000)",,,,,,,,6:40.00');
  assert.equal(rawFields(got[1]).length, 19);
  // As FinishLynx writes a hand time: "32:20.85 (12:18.36)", rounded up; average 1940.85 / 3 -> 10:46.95.
  assert.equal(got[2], '2,10,,Hand,Timed,Team,32:20.85,F,same time,,"9:00.677 (9:00.677),20:02.498 (11:01.821),32:20.85 (12:18.36)",15:29:07.651,,,,1.00,1.00,,10:46.95');
});

test('mergeLif fillPlaces numbers relay-only rows only while nobody has finished', () => {
  const runners = new Map([
    ['1', runner('Aa', 'Bb', '', 'F', ['5:00.000', null])],
    ['2', runner('Cc', 'Dd', '', 'F', ['4:59.000', '9:58.000'])],
  ]);
  const dnfOnly = '9,1,1,Girls,,,,,,,10:00:00.0000\r\nDNF,77,,Gone,Early,,,F,,,,10:00:00.000,,,,,,,\r\n';
  const a = lines(mergeLif({ lynxText: dnfOnly, race: {}, gunTicks: parseTod('10:00:00'), splitCount: 2, runners, fillPlaces: true }));
  assert.deepEqual(a.slice(2).map((l) => rawFields(l).slice(0, 2)), [['1', '2'], ['2', '1']]);
  assert.equal(a[1], 'DNF,77,,Gone,Early,,,F,,,,10:00:00.000,,,,,,,');

  const withFinisher = dnfOnly + '1,50,,Fast,One,,17:00.000,F,17:00.00,,17:00.000 (17:00.000),10:00:00.000,,,,17:00.00,17:00.00,,17:00.00\r\n';
  const b = lines(mergeLif({ lynxText: withFinisher, race: {}, gunTicks: parseTod('10:00:00'), splitCount: 2, runners, fillPlaces: true }));
  assert.deepEqual(b.slice(3).map((l) => rawFields(l).slice(0, 2)), [['', '2'], ['', '1']]);

  const off = lines(mergeLif({ lynxText: dnfOnly, race: {}, gunTicks: parseTod('10:00:00'), splitCount: 2, runners }));
  assert.deepEqual(off.slice(2).map((l) => rawFields(l)[0]), ['', '']);
});

test('mergeLif without a FinishLynx file synthesises one from the race', () => {
  const runners = new Map([
    ['21', runner('Lark', 'Wren', 'Pine, Ridge', 'F', ['6:01.000', null])],
    ['22', runner('Moss', 'Fern\u0007', 'Oak "Hill"', 'F', ['5:58.500', '12:01.250'])],
  ]);
  const race = { eventNumber: '4', round: '', heat: '2', name: 'Girls Gold, 5K' };
  const out = mergeLif({ lynxText: null, race, gunTicks: parseTod('9:29:20.1938'), splitCount: 2, runners, fillPlaces: true });
  assert.deepEqual(lines(out), [
    '4,1,2,"Girls Gold, 5K",,,,,,,9:29:20.1938',
    "1,22,,Moss,Fern,Oak 'Hill',,F,,,\"5:58.500 (5:58.500),12:01.250 (6:02.750)\",9:29:20.194,,,,,,,6:00.63",
    '2,21,,Lark,Wren,"Pine, Ridge",,F,,,6:01.000 (6:01.000),9:29:20.194,,,,,,,6:01.00',
  ]);
  assert.ok(out.endsWith('\r\n'));
  // The header must read back as a header for both downstream parsers: first-name field empty.
  assert.equal(parseLif(out).header.fields[4], '');
  assert.equal(parseLif(out).header.fields.length, 11);
  // No gun yet: the start time stays blank instead of inventing one.
  assert.equal(lines(mergeLif({ lynxText: '', race, gunTicks: null, splitCount: 2, runners: new Map() }))[0], '4,1,2,"Girls Gold, 5K",,,,,,,');
});

// ---------------------------------------------------------------------------------------------------------------
// LifSync, against real folders in the temp directory

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what = 'condition', timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const tryRead = (file) => fsp.readFile(file).catch(() => null);

async function setup(t, { races = [race3], data = {}, lif = {}, fs, opts = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'splitrelay-lif-'));
  const inputDir = path.join(root, 'Lynx');
  const outputDir = path.join(root, 'Merged');
  await fsp.mkdir(inputDir);
  const config = { lif: { enabled: true, inputDir, outputDir, fillPlaces: false, ...lif }, races };
  const logs = [];
  const calls = [];
  const statuses = [];
  const instances = [];
  const make = (extra = {}) => {
    const s = new LifSync({
      getConfig: () => config,
      getRaceData: (id) => {
        calls.push(id);
        return data[id];
      },
      log: (l) => logs.push(l),
      pollMs: 20, settleMs: 5, debounceMs: 40, backoffMs: 300, refreshMs: 600_000, staleMs: 100, renameRetryMs: 5,
      fs, ...opts, ...extra,
    });
    s.on('status', (st) => statuses.push(st));
    instances.push(s);
    return s;
  };
  const sync = make();
  t.after(async () => {
    // Every instance stops (and finishes its scan) before the folders go, or one could recreate them.
    await Promise.all(instances.map((s) => s.stop()));
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const out = (name) => tryRead(path.join(outputDir, name));
  return { root, inputDir, outputDir, config, logs, calls, statuses, sync, make, out };
}

const boysData = () => ({ r_boys: { splitCount: 2, gun: GUN, runners: boysRunners() } });

test('LifSync merges the matching race, copies other .lif files byte-for-byte, ignores the rest', async (t) => {
  // The race is typed with leading zeros; the Lynx header says 3,1,1.
  const race = { ...race3, eventNumber: '003', round: '01', heat: '1' };
  const env = await setup(t, { races: [race], data: boysData() });
  const lynx = await readFixture('003-1-01.lif');
  const other = await readFixture('011-1-01.lif');
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), lynx);
  await fsp.writeFile(path.join(env.inputDir, '011-1-01.lif'), other);
  await fsp.writeFile(path.join(env.inputDir, 'notes.txt'), 'not a results file');
  env.sync.start();

  const merged = await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  const expected = encodeCp1252(mergeLif({ lynxText: decodeCp1252(lynx), race, gunTicks: GUN, splitCount: 2, runners: boysRunners() }));
  assert.ok(merged.equals(expected));
  assert.ok((await waitFor(() => env.out('011-1-01.lif'), 'copied file')).equals(other));
  assert.deepEqual((await fsp.readdir(env.outputDir)).sort(), ['003-1-01.lif', '011-1-01.lif']);

  await waitFor(() => env.sync.status().state === 'ok', 'state ok');
  const st = env.sync.status();
  assert.equal(st.enabled, true);
  assert.equal(st.error, null);
  assert.ok(st.lastScanAt > 0);
  const [m, c] = st.files;
  assert.deepEqual({ ...m, writtenAt: typeof m.writtenAt }, {
    name: '003-1-01.lif', eventNumber: '003', round: '01', heat: '1', raceId: 'r_boys', raceName: 'Boys Gold 5K',
    lynxName: 'Boys Gold 5K', rows: 11, splitsAdded: 15, writtenAt: 'number', copiedOnly: false, synthesized: false,
    error: null, note: null,
  });
  assert.equal(c.name, '011-1-01.lif');
  assert.equal(c.copiedOnly, true);
  assert.equal(c.raceId, null);
  assert.equal(c.eventNumber, '11');
  assert.equal(c.lynxName, 'Girls Open 6K – Seeded');
  assert.ok(env.statuses.length > 0, 'emits status');
  assert.deepEqual((await fsp.readdir(env.inputDir)).sort(), ['003-1-01.lif', '011-1-01.lif', 'notes.txt'], 'nothing written into the Lynx folder');
});

test('LifSync rewrites nothing that has not changed, also after a restart', async (t) => {
  const env = await setup(t, { data: boysData() });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  const writes = () => env.logs.filter((l) => /\] (wrote|copied) /.test(l)).length;
  assert.equal(writes(), 1);
  const { mtimeMs } = await fsp.stat(path.join(env.outputDir, '003-1-01.lif'));
  await sleep(150);
  assert.equal(writes(), 1);
  await env.sync.stop();

  const again = env.make();
  again.start();
  await waitFor(() => again.status().files.length === 1, 'second instance scanned');
  await sleep(60);
  assert.equal(writes(), 1, 'an identical file on disk is left alone');
  assert.equal((await fsp.stat(path.join(env.outputDir, '003-1-01.lif'))).mtimeMs, mtimeMs);
  // lif-ground-truth F6: the file is there and current, so the panel must not say "not yet".
  assert.equal(again.status().files[0].writtenAt, Math.floor(mtimeMs), 'writtenAt is the time the file was written');
});

test('LifSync uses a FinishLynx file only once two reads agree', async (t) => {
  let writing = true;
  let n = 0;
  const fs = {
    ...fsp,
    readFile: async (file, ...rest) => {
      const buf = await fsp.readFile(file, ...rest);
      // FinishLynx "still writing": every read sees different bytes.
      return writing && path.basename(String(file)) === '003-1-01.lif' ? Buffer.concat([buf, Buffer.from(`${n++}\r\n`)]) : buf;
    },
  };
  const env = await setup(t, { data: boysData(), fs });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  await fsp.writeFile(path.join(env.inputDir, '011-1-01.lif'), await readFixture('011-1-01.lif'));
  env.sync.start();
  await waitFor(() => env.out('011-1-01.lif'), 'the steady file');
  await sleep(150);
  assert.equal(await env.out('003-1-01.lif'), null, 'a file that changes between reads is not used');
  assert.ok(n >= 4);
  writing = false;
  const merged = await waitFor(() => env.out('003-1-01.lif'), 'merged file after it settled');
  assert.ok(!decodeCp1252(merged).includes('\r\n0\r\n'));
  assert.equal(lines(decodeCp1252(merged)).length, 12);
});

test('LifSync waits for a file that stops mid-line until it is complete', async (t) => {
  const env = await setup(t, { data: boysData(), opts: { staleMs: 60_000 } });
  const full = await readFixture('003-1-01.lif');
  const file = path.join(env.inputDir, '003-1-01.lif');
  await fsp.writeFile(file, full.subarray(0, 300)); // header and part of the second row: FinishLynx mid-write
  env.sync.start();
  await waitFor(() => env.sync.status().lastScanAt, 'a scan');
  await sleep(150);
  assert.equal(await env.out('003-1-01.lif'), null);
  await fsp.writeFile(file, full);
  const merged = await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  assert.equal(lines(decodeCp1252(merged)).length, 12);
});

test('LifSync believes a .lif without a final line break once it has stayed the same', async (t) => {
  const env = await setup(t, { opts: { staleMs: 80 } });
  const text = Buffer.from('20,1,1,Relay,,,,,,,11:00:00.0000\r\n1,5,,A,B,,4:00.000,M,,,4:00.000 (4:00.000),11:00:00.000,,,,,,,4:00.00');
  await fsp.writeFile(path.join(env.inputDir, '020-1-01.lif'), text);
  env.sync.start();
  assert.ok((await waitFor(() => env.out('020-1-01.lif'), 'copied file')).equals(text));
});

test('LifSync re-merges after markDirty, debounced, and keeps up with a steady stream of reads', async (t) => {
  const data = boysData();
  // review-core F11: the debounce is far from every wait below, and the test waits for log lines rather than reading
  // the output file in a loop (on Windows a reader holding the file makes the rename fail, and the retry is a second
  // rebuild that has nothing to do with debouncing).
  const env = await setup(t, { data, opts: { debounceMs: 150 } });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  const wrote = () => env.logs.filter((l) => l.includes('wrote 003-1-01.lif')).length;
  const failedWrites = () => env.logs.filter((l) => l.includes("Couldn't write")).length;
  env.sync.start();
  await waitFor(() => wrote() === 1, 'merged file');
  await waitFor(() => env.sync.status().state === 'ok', 'the first scan finished');
  const callsBefore = env.calls.length;

  await sleep(100);
  assert.equal(env.calls.length, callsBefore, 'nothing is rebuilt while nothing changed');

  data.r_boys.runners.set('523', runner('Pemberton', 'Caleb', 'Riverside', 'M', ['5:20.000', '10:41.000']));
  for (let i = 0; i < 5; i++) env.sync.markDirty('r_boys');
  await waitFor(() => wrote() === 2, 'the re-merge');
  await sleep(200); // longer than the debounce: a second rebuild would have happened by now
  const merged = await env.out('003-1-01.lif');
  assert.ok(decodeCp1252(merged).includes('"5:20.000 (5:20.000),10:41.000 (5:21.000),16:02.100 (5:21.100)"'));
  assert.equal(env.calls.length, callsBefore + 1 + failedWrites(), 'five markDirty calls, one rebuild');

  // A read every 10 ms must not starve the file: it is rewritten while the reads keep coming.
  const r702 = data.r_boys.runners.get('702');
  let stop = false;
  const pump = (async () => {
    for (let i = 0; !stop && i < 60; i++) {
      r702.splits[1] = rt('11:04.465') + i * 10;
      env.sync.markDirty('r_boys');
      await sleep(10);
    }
  })();
  const startWrites = env.logs.filter((l) => l.includes('wrote 003')).length;
  await waitFor(() => env.logs.filter((l) => l.includes('wrote 003')).length > startWrites + 1, 'rewrites during the stream', 2000);
  stop = true;
  await pump;
});

test('LifSync synthesises a file for a race FinishLynx has no file for, and gives way when one appears', async (t) => {
  const girls = { id: 'r_girls', name: 'Girls Gold 5K', eventNumber: '4', round: '1', heat: '1' };
  const quiet = { id: 'r_quiet', name: 'Not started', eventNumber: '5', round: '1', heat: '1' };
  const gun = parseTod('9:29:20.1938');
  const data = {
    r_girls: { splitCount: 2, gun, runners: new Map([['31', runner('Lark', 'Wren', 'Pine', 'F', ['6:01.000', null])]]) },
    r_quiet: { splitCount: 2, gun: null, runners: new Map() },
  };
  const env = await setup(t, { races: [girls, quiet], data });
  env.sync.start();
  const synth = await waitFor(() => env.out('004-1-01.lif'), 'synthesised file');
  assert.deepEqual(lines(decodeCp1252(synth)), [
    '4,1,1,Girls Gold 5K,,,,,,,9:29:20.1938',
    ',31,,Lark,Wren,Pine,,F,,,6:01.000 (6:01.000),9:29:20.194,,,,,,,6:01.00',
  ]);
  await waitFor(() => env.sync.status().state === 'ok', 'state ok');
  const f = env.sync.status().files;
  assert.equal(f.length, 1, 'a race without crossings gets no file');
  assert.equal(f[0].synthesized, true);
  assert.equal(f[0].raceId, 'r_girls');

  // FinishLynx writes its own file under a different name: ours goes, the real one is merged.
  await fsp.writeFile(path.join(env.inputDir, 'Girls4.lif'),
    '4,1,1,Girls Gold 5K,,,,,,,9:29:20.1938\r\n1,31,,Lark,Wren,Pine,19:40.500,F,19:40.50,,19:40.500 (19:40.500),9:29:20.194,,,,19:40.50,19:40.50,,19:40.50\r\n');
  const real = await waitFor(() => env.out('Girls4.lif'), 'merged real file');
  assert.equal(lines(decodeCp1252(real))[1], '1,31,,Lark,Wren,Pine,19:40.500,F,19:40.50,,"6:01.000 (6:01.000),,19:40.500 (13:39.500)",9:29:20.194,,,,19:40.50,19:40.50,,9:50.25');
  await waitFor(async () => (await env.out('004-1-01.lif')) === null, 'synthesised file removed');
  assert.deepEqual(env.sync.status().files.map((x) => [x.name, x.synthesized]), [['Girls4.lif', false]]);
});

test('LifSync keeps merging from the last copy when the FinishLynx file vanishes for a moment', async (t) => {
  const env = await setup(t, { data: boysData() });
  const file = path.join(env.inputDir, '003-1-01.lif');
  await fsp.writeFile(file, await readFixture('003-1-01.lif'));
  env.sync.start();
  const before = await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  await fsp.unlink(file);
  await sleep(100);
  env.sync.markDirty('r_boys');
  await sleep(100);
  assert.ok((await env.out('003-1-01.lif')).equals(before), 'finishers are not dropped');
  assert.equal(env.sync.lynxStart('r_boys'), GUN);
});

test('LifSync refuses an output folder that is the FinishLynx folder or inside it', async (t) => {
  const env = await setup(t, { data: boysData() });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  // The same folder spelled differently (Windows paths ignore case).
  env.config.lif.outputDir = (process.platform === 'win32' ? env.inputDir.toUpperCase() : env.inputDir) + path.sep;
  env.sync.start();
  await waitFor(() => env.sync.status().state === 'error', 'error state');
  assert.match(env.sync.status().error, /must not be the FinishLynx folder or a folder inside it/);

  env.config.lif.outputDir = path.join(env.inputDir, 'merged');
  await sleep(80);
  assert.equal(env.sync.status().state, 'error');
  assert.deepEqual(await fsp.readdir(env.inputDir), ['003-1-01.lif'], 'nothing written inside the Lynx folder');

  env.config.lif.outputDir = env.outputDir;
  await waitFor(() => env.out('003-1-01.lif'), 'merged file once the folder is fixed');
  await waitFor(() => env.sync.status().state === 'ok', 'state ok');
});

test('LifSync survives a missing FinishLynx folder, backs off, and recovers', async (t) => {
  let listings = 0;
  const fs = { ...fsp, readdir: (...a) => { listings++; return fsp.readdir(...a); } };
  const env = await setup(t, { data: boysData(), fs, opts: { backoffMs: 250 } });
  await fsp.rm(env.inputDir, { recursive: true });
  env.sync.start();
  await waitFor(() => env.sync.status().state === 'error', 'error state');
  assert.match(env.sync.status().error, /FinishLynx folder not found/);
  assert.ok(env.logs.some((l) => l.includes('FinishLynx folder not found')));
  await sleep(200);
  assert.ok(listings <= 2, `backed off (${listings} listings in 200 ms at a 20 ms poll)`);

  await fsp.mkdir(env.inputDir);
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  await waitFor(() => env.out('003-1-01.lif'), 'merged file after recovery');
  await waitFor(() => env.sync.status().state === 'ok', 'state ok');
  assert.equal(env.logs.filter((l) => l.includes('not found')).length, 1, 'the error is logged once, not every poll');
});

test('LifSync writes temp + rename and retries while a reader holds the file', async (t) => {
  const renames = [];
  let failures = ['EBUSY', 'EBUSY', 'EPERM'];
  const fs = {
    ...fsp,
    rename: async (from, to) => {
      renames.push([path.basename(String(from)), path.basename(String(to))]);
      const code = failures.shift();
      if (code) throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
      return fsp.rename(from, to);
    },
  };
  const data = boysData();
  const env = await setup(t, { data, fs });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  assert.equal(renames.length, 4);
  for (const [from, to] of renames) {
    assert.equal(to, '003-1-01.lif');
    assert.match(from, /^003-1-01\.lif\.~\d+-\d+\.tmp$/);
  }
  await waitFor(() => env.sync.status().state === 'ok', 'state ok');

  // Locked for good: an error in the status, no temp files left behind, and it recovers once the lock goes.
  failures = new Array(1000).fill('EBUSY');
  data.r_boys.runners.set('523', runner('Pemberton', 'Caleb', 'Riverside', 'M', ['5:20.000', '10:41.000']));
  env.sync.markDirty('r_boys');
  await waitFor(() => env.sync.status().state === 'error', 'error state');
  assert.match(env.sync.status().error, /Couldn't write 003-1-01\.lif: EBUSY/);
  assert.equal(env.sync.status().files[0].error, "Couldn't write 003-1-01.lif: EBUSY (another program has it open; trying again)");
  assert.equal(env.logs.filter((l) => l.includes("Couldn't write")).length, 1, 'logged once while it persists');
  for (let i = 0; i < 5; i++) {
    // Each attempt cleans up after itself: at most the one temp file of the attempt under way.
    await sleep(15);
    assert.ok((await fsp.readdir(env.outputDir)).filter((n) => n.endsWith('.tmp')).length <= 1);
  }
  failures = [];
  await waitFor(() => env.sync.status().state === 'ok', 'recovered');
  assert.deepEqual(await fsp.readdir(env.outputDir), ['003-1-01.lif']);
});

test('lynxStart reads the start time from the matching FinishLynx header, even with merging off', async (t) => {
  const other = { id: 'r_other', name: 'Other', eventNumber: '9', round: '1', heat: '1' };
  const env = await setup(t, { races: [race3, other], data: boysData(), lif: { enabled: false } });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => env.sync.lynxStart('r_boys') !== null, 'lynxStart');
  assert.equal(env.sync.lynxStart('r_boys'), parseTod('12:58:49.2595'));
  assert.equal(env.sync.lynxStart('r_other'), null);
  assert.equal(env.sync.lynxStart('r_missing'), null);
  assert.equal(env.sync.status().state, 'off');
  assert.deepEqual(env.sync.status().files, []);
  assert.equal(await fsp.stat(env.outputDir).catch(() => null), null, 'nothing written while off');

  env.config.lif.enabled = true;
  await waitFor(() => env.out('003-1-01.lif'), 'merged once switched on');
  await env.sync.stop();
  const scans = env.sync.status().lastScanAt;
  await sleep(80);
  assert.equal(env.sync.status().lastScanAt, scans, 'stop() stops polling');
});

test('LifSync: waiting with nothing to write; a FinishLynx file under the made-up name simply takes over', async (t) => {
  const data = { r_boys: { splitCount: 2, gun: GUN, runners: new Map() } };
  const env = await setup(t, { data });
  env.sync.start();
  await waitFor(() => env.sync.status().state === 'waiting', 'waiting state');
  assert.deepEqual(env.sync.status().files, []);
  assert.equal(await fsp.stat(env.outputDir).then((s) => s.isDirectory()), true, 'output folder created');

  data.r_boys.runners = boysRunners();
  env.sync.markDirty('r_boys');
  const synth = await waitFor(() => env.out('003-1-01.lif'), 'synthesised file');
  assert.equal(lines(decodeCp1252(synth))[0], '3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595');
  assert.equal(env.sync.status().files[0].synthesized, true);

  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  const merged = await waitFor(async () => {
    const b = await env.out('003-1-01.lif');
    return b && decodeCp1252(b).startsWith('3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595\r\n1,101,') && b;
  }, 'merged file');
  assert.equal(lines(decodeCp1252(merged)).length, 12);
  await waitFor(() => env.sync.status().files[0]?.synthesized === false, 'status shows the merge');
  assert.deepEqual(await fsp.readdir(env.outputDir), ['003-1-01.lif']);
});

test('LifSync puts back an output file someone deleted, at the next full refresh', async (t) => {
  const env = await setup(t, { data: boysData(), opts: { refreshMs: 100 } });
  await fsp.writeFile(path.join(env.inputDir, '011-1-01.lif'), await readFixture('011-1-01.lif'));
  env.sync.start();
  const first = await waitFor(() => env.out('011-1-01.lif'), 'copied file');
  await fsp.unlink(path.join(env.outputDir, '011-1-01.lif'));
  assert.ok((await waitFor(() => env.out('011-1-01.lif'), 'copied again')).equals(first));
});

// ---------------------------------------------------------------------------------------------------------------
// Revision 2 (DESIGN.md section 9.6, 9.8, 9.10)

test('mergeLif rounds each split to the printed thousandth before working out legs and the average', () => {
  // lif-ground-truth F3: race times are tod - gun, and the gun has a 0.1 ms digit. FinishLynx prints 4:55.3385 as
  // 4:55.339 and its legs are differences of the printed cumulatives: the finish leg is 4:55.298, not 4:55.299.
  const lynxText = '3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595\r\n' +
    '1,101,,Ashford,Nolan,Riverside,15:03.968,M,15:03.97,,15:03.968 (15:03.968),12:58:49.260,,,,15:03.97,15:03.97,,15:03.97\r\n';
  const s1 = parseTod('13:03:44.598') - GUN; // 4:55.3385
  const s2 = parseTod('13:08:57.929') - GUN; // 10:08.6695
  assert.equal(s1 % 10, 5, 'the test needs a split between two thousandths');
  const runners = new Map([
    ['101', { first: 'Nolan', last: 'Ashford', team: 'Riverside', gender: 'M', splits: [s1, s2] }],
    ['900', { first: 'A', last: 'B', team: '', gender: 'M', splits: [s1 + 7, s2 + 11] }], // relay-only, 0.7 and 1.1 ms on
  ]);
  const got = lines(mergeLif({ lynxText, race: race3, gunTicks: GUN, splitCount: 2, runners }));
  const f = rawFields(got[1]);
  assert.equal(f[10], '"4:55.339 (4:55.339),10:08.670 (5:13.331),15:03.968 (4:55.298)"');
  assert.equal(f[18], '5:01.33');
  const r = rawFields(got[2]);
  // 4:55.3392 -> 4:55.340, 10:08.6706 -> 10:08.671: the leg is the difference of those, 5:13.331.
  assert.equal(r[10], '"4:55.340 (4:55.340),10:08.671 (5:13.331)"');
  assert.equal(r[18], '5:04.34'); // 10:08.671 / 2 = 5:04.3355 -> 5:04.335 -> 5:04.34
});

test('mergeLif drops a split that is not before the finish or not after the splits before it', () => {
  // lif-ground-truth F1: runners who missed a mat in the race and crossed it later (after finishing).
  const lynxText = '11,1,1,Open,,,,,,,10:00:00.0000\r\n' +
    '83,5101,,Missed,Two,Team,16:59.297,M,,,16:59.297 (16:59.297),10:00:00.000,,,,,,,16:59.30\r\n' +
    '40,5580,,Missed,One,Team,15:44.429,M,,,15:44.429 (15:44.429),10:00:00.000,,,,,,,15:44.43\r\n' +
    '41,5600,,Late,Gun,Team,16:00.000,M,,,16:00.000 (16:00.000),10:00:00.000,,,,,,,16:00.00\r\n';
  const runners = new Map([
    ['5101', runner('Missed', 'Two', 'Team', 'M', ['5:19.794', '23:39.297'])], // 2K read 400 s after the finish
    ['5580', runner('Missed', 'One', 'Team', 'M', ['20:44.429', '10:24.628'])], // 1K mat walked over after finishing
    ['5600', { first: 'Gun', last: 'Late', team: 'Team', gender: 'M', splits: [-12_000_000, rt('8:00.000')] }],
    ['7001', runner('On', 'Course', '', 'M', ['20:44.429', '10:24.628'])], // relay-only, no finish
    ['7002', { first: 'Warm', last: 'Up', team: '', gender: 'M', splits: [-3_000_000, null] }], // nothing usable
  ]);
  const out = mergeLif({ lynxText, race: {}, gunTicks: parseTod('10:00:00'), splitCount: 2, runners });
  const got = lines(out);
  assert.equal(rawFields(got[1])[10], '"5:19.794 (5:19.794),,16:59.297 (11:39.503)"');
  assert.equal(rawFields(got[1])[18], '8:29.65', 'average over the two entries that are left');
  assert.equal(rawFields(got[2])[10], '",10:24.628 (10:24.628),15:44.429 (5:19.801)"');
  assert.equal(rawFields(got[3])[10], '",8:00.000 (8:00.000),16:00.000 (8:00.000)"', 'a split before the gun is never written');
  // Without a finish the later split is the one kept, as the engine keeps it.
  assert.equal(rawFields(got[4])[10], '",10:24.628 (10:24.628)"');
  assert.equal(got.length, 5, 'a runner with nothing usable gets no row');
  assert.ok(!out.includes('7002'));
  // Every cumulative is increasing in every row, so neither downstream reader sees splits out of order.
  for (const l of got.slice(1)) {
    const cums = rawFields(l)[10].replace(/"/g, '').split(',').filter(Boolean).map((e) => rt(e.split(' ')[0]));
    for (let i = 1; i < cums.length; i++) assert.ok(cums[i] > cums[i - 1], l);
  }
});

test('pathKind and fullPathProblem: drive letters and \\\\server\\share only', () => {
  const w = (p) => pathKind(p, 'win32');
  assert.equal(w('C:\\Lynx\\Merged'), 'drive');
  assert.equal(w('c:/lynx'), 'drive');
  assert.equal(w('\\\\192.168.0.5\\Lynx\\Merged'), 'unc');
  assert.equal(w('//timing-pc/Lynx'), 'unc');
  assert.equal(w('\\192.168.0.5\\Lynx\\Merged'), 'root-relative');
  assert.equal(w('/Lynx'), 'root-relative');
  assert.equal(w('\\\\192.168.0.5'), 'unc-incomplete');
  assert.equal(w('C:Lynx'), 'drive-relative');
  assert.equal(w('Merged'), 'relative');
  assert.equal(w('  '), 'empty');
  assert.equal(pathKind('/home/timer/lynx', 'linux'), 'posix');
  // review-edges F3: the message says what went wrong, in the words the design gives.
  assert.match(fullPathProblem('\\192.168.0.5\\Lynx\\Merged', 'the merged .lif folder', 'C:\\Lynx\\Merged', 'win32'),
    /starts with a single backslash\. A network path starts with two backslashes/);
  assert.match(fullPathProblem('Merged', 'the merged .lif folder', 'C:\\Lynx\\Merged', 'win32'), /Type the full path of the merged \.lif folder/);
  assert.equal(fullPathProblem('\\\\srv\\share\\x', 'x', 'y', 'win32'), null);
  assert.equal(fullPathProblem('', 'x', 'y', 'win32'), null);
});

test('LifSync refuses a root-relative output folder and creates only the last folder level', async (t) => {
  const env = await setup(t, { data: boysData() });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  if (process.platform === 'win32') {
    // A UNC path that lost one backslash: Windows would put it on this PC's own drive.
    env.config.lif.outputDir = '\\192.168.0.5\\Lynx\\Merged-SplitRelayTest';
    env.sync.start();
    await waitFor(() => env.sync.status().state === 'error', 'error state');
    assert.match(env.sync.status().error, /single backslash/);
    assert.equal(await fsp.stat(path.resolve('\\192.168.0.5')).catch(() => null), null, 'nothing made on this drive');
    await env.sync.stop();
  }
  // review-edges F3: a typo in the middle of the path is an error, not a new folder tree.
  const typo = path.join(env.root, 'Lynks', 'Merged');
  env.config.lif.outputDir = typo;
  const s2 = env.make();
  s2.start();
  await waitFor(() => s2.status().state === 'error' && /does not exist/.test(s2.status().error), 'error for the missing parent');
  assert.match(s2.status().error, /Lynks.*does not exist.*only makes the last folder/);
  assert.equal(await fsp.stat(path.join(env.root, 'Lynks')).catch(() => null), null, 'nothing created');
  // The last level alone is made.
  env.config.lif.outputDir = env.outputDir;
  await waitFor(() => env.out('003-1-01.lif'), 'merged file in the new folder');
  assert.ok(env.logs.some((l) => l.includes('made the merged .lif folder')));
});

test('LifSync refuses an output folder that reaches the FinishLynx folder under another name', async (t) => {
  const env = await setup(t, { data: boysData() });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  const alias = path.join(env.root, 'LynxAlias');
  try {
    // A junction needs no rights on Windows; it stands in for \\localhost\C$\..., a mapped drive or a second share.
    await fsp.symlink(env.inputDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot make a folder link here: ${err.code}`);
    return;
  }
  for (const out of [alias, path.join(alias, 'merged')]) {
    env.config.lif.outputDir = out;
    const s = env.make();
    s.start();
    await waitFor(() => s.status().state === 'error', `error state for ${out}`);
    assert.match(s.status().error, /must not be the FinishLynx folder or a folder inside it/);
    await s.stop();
  }
  assert.deepEqual(await fsp.readdir(env.inputDir), ['003-1-01.lif'], 'nothing written into the FinishLynx folder');
});

test('LifSync identity check: a UNC alias with the same volume and file id is refused, file ids of 0 are not trusted', async (t) => {
  // Simulates \\localhost\C$\...\Lynx: different text, same folder (review-edges F7).
  const real = await fsp.mkdtemp(path.join(os.tmpdir(), 'splitrelay-alias-'));
  t.after(() => fsp.rm(real, { recursive: true, force: true }));
  let idsOf = () => null;
  const fs = {
    ...fsp,
    stat: async (p, opts) => {
      const st = await fsp.stat(p, opts);
      const ids = opts?.bigint ? idsOf(String(p)) : null;
      return ids ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, ids) : st;
    },
  };
  const env = await setup(t, { data: boysData(), fs });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  // The "share" is another real folder whose ids say it is the FinishLynx folder.
  const share = path.join(real, 'share-of-lynx');
  await fsp.mkdir(share);
  idsOf = (p) => {
    const q = path.resolve(p).toLowerCase();
    return q === env.inputDir.toLowerCase() || q === share.toLowerCase() ? { dev: 7n, ino: 42n } : null;
  };
  env.config.lif.outputDir = path.join(share, 'merged');
  env.sync.start();
  await waitFor(() => env.sync.status().state === 'error', 'error state');
  assert.match(env.sync.status().error, /must not be the FinishLynx folder/);
  assert.equal(await fsp.stat(path.join(share, 'merged')).catch(() => null), null, 'nothing made inside it');
  await env.sync.stop();

  // A file system that reports no file ids (0) must not make every folder look like the FinishLynx folder.
  idsOf = () => ({ dev: 0n, ino: 0n });
  env.config.lif.outputDir = env.outputDir;
  const s2 = env.make();
  s2.start();
  await waitFor(() => env.out('003-1-01.lif'), 'merged file');
});

test('LifSync leaves a merged file with splits alone while the race has no gun time, then catches up', async (t) => {
  // review-core F9 / DESIGN 9.3.6: raceData() is null while the gun is not set.
  const data = boysData();
  const env = await setup(t, { data });
  const lynxFile = path.join(env.inputDir, '003-1-01.lif');
  await fsp.writeFile(lynxFile, await readFixture('003-1-01.lif'));
  env.sync.start();
  const merged = await waitFor(() => env.out('003-1-01.lif'), 'merged file');

  data.r_boys = null; // the gun was cleared
  env.sync.markDirty('r_boys');
  // FinishLynx adds a finisher meanwhile: the file still keeps its splits.
  const more = Buffer.concat([await readFixture('003-1-01.lif'),
    Buffer.from('6,805,,Nobody,Here,,16:30.000,M,same time,,16:30.000 (16:30.000),12:58:49.260,,,,1:26.04,1:26.04,,16:30.00\r\n')]);
  await fsp.writeFile(lynxFile, more);
  await waitFor(() => env.sync.status().files[0]?.note, 'the status says why the file waits');
  await sleep(100);
  assert.ok((await env.out('003-1-01.lif')).equals(merged), 'not rewritten without its splits');
  assert.match(env.sync.status().files[0].note, /no gun time/);

  // The gun is set again: the file catches up, splits and new finisher together.
  data.r_boys = { splitCount: 2, gun: GUN, runners: boysRunners() };
  env.sync.markDirty('r_boys');
  const after = await waitFor(async () => {
    const b = await env.out('003-1-01.lif');
    return b && decodeCp1252(b).includes(',805,') && b;
  }, 'the merge with the new finisher');
  assert.ok(decodeCp1252(after).includes('"4:55.339 (4:55.339),10:08.670 (5:13.331),15:03.968 (4:55.298)"'));
  await waitFor(() => env.sync.status().files[0]?.note === null, 'the note goes');
});

test('LifSync copies a FinishLynx file as it is while its race never had a gun time', async (t) => {
  // A race set up in Split Relay whose gun was never set: TrackScore watching the merged folder must still get the
  // finishes (there are no splits to lose).
  const data = { r_boys: null };
  const env = await setup(t, { data });
  const lynx = await readFixture('003-1-01.lif');
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), lynx);
  env.sync.start();
  assert.ok((await waitFor(() => env.out('003-1-01.lif'), 'copied file')).equals(lynx));
  await waitFor(() => env.sync.status().files.length === 1, 'status');
  assert.match(env.sync.status().files[0].note, /no gun time/);
  // FinishLynx keeps writing: the copy follows.
  const more = Buffer.concat([lynx, Buffer.from('6,805,,Nobody,Here,,16:30.000,M,,,16:30.000 (16:30.000),12:58:49.260,,,,,,,16:30.00\r\n')]);
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), more);
  await waitFor(async () => (await env.out('003-1-01.lif'))?.equals(more), 'copy updated');
  assert.deepEqual(await fsp.readdir(env.outputDir), ['003-1-01.lif']);
});

test('lynxFinishers: finishers from the FinishLynx file, a finishers event when they change', async (t) => {
  const boys = { ...race3 };
  const other = { id: 'r_other', name: 'Other', eventNumber: '9', round: '1', heat: '1' };
  const env = await setup(t, { races: [boys, other], data: boysData(), lif: { enabled: false } });
  const events = [];
  env.sync.on('finishers', (id) => events.push(id));
  const file = path.join(env.inputDir, '003-1-01.lif');
  await fsp.writeFile(file, await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => events.length === 1, 'finishers event');
  assert.deepEqual(events, ['r_boys']);
  // Numeric place and a time only (DNF 610 and blank-place 702 are not finishers); "0458" is bib 458.
  assert.deepEqual(env.sync.lynxFinishers('r_boys'), new Map([
    ['101', rt('15:03.968')], ['214', rt('15:05.709')], ['377', rt('15:20.004')], ['458', rt('15:31.552')],
    ['523', rt('16:02.100')],
  ]));
  assert.deepEqual(env.sync.lynxFinishers('r_other'), new Map());
  assert.deepEqual(env.sync.lynxFinishers('r_missing'), new Map());
  env.sync.lynxFinishers('r_boys').clear(); // a copy: the caller cannot change what LifSync knows
  assert.equal(env.sync.lynxFinishers('r_boys').size, 5);
  // their places too (DESIGN 9.17 P4: a finisher's made-up split goes out with the finish place)
  assert.deepEqual(env.sync.lynxPlaces('r_boys'), new Map([['101', 1], ['214', 2], ['377', 3], ['458', 4], ['523', 5]]));
  assert.deepEqual(env.sync.lynxPlaces('r_other'), new Map());
  assert.equal(env.sync.lynxName('r_boys'), 'Boys Gold 5K');
  assert.equal(env.sync.lynxName('r_other'), null);

  // The same finishers written again (FinishLynx saves often): no event. A new finisher: one event.
  await fsp.writeFile(file, Buffer.concat([await readFixture('003-1-01.lif'), Buffer.from('\r\n')]));
  await sleep(150);
  assert.equal(events.length, 1);
  await fsp.writeFile(file, Buffer.concat([await readFixture('003-1-01.lif'),
    Buffer.from('6,610,,Quill,Asher,Lakeview,17:00.000,M,,,17:00.000 (17:00.000),12:58:49.260,,,,,,,17:00.00\r\n')]));
  await waitFor(() => events.length === 2, 'second finishers event');
  assert.equal(env.sync.lynxFinishers('r_boys').get('610'), rt('17:00.000'));
  assert.equal(env.sync.lynxPlaces('r_boys').get('610'), 6);
  // FinishLynx re-orders two finishers (a photo read again): the times stay, the places change: an event
  const swapped = (await readFixture('003-1-01.lif')).toString('latin1').replace(/^1,101,/m, '2,101,').replace(/^2,214,/m, '1,214,');
  await fsp.writeFile(file, Buffer.concat([Buffer.from(swapped, 'latin1'),
    Buffer.from('6,610,,Quill,Asher,Lakeview,17:00.000,M,,,17:00.000 (17:00.000),12:58:49.260,,,,,,,17:00.00\r\n')]));
  await waitFor(() => events.length === 3, 'event for changed places');
  assert.deepEqual([env.sync.lynxPlaces('r_boys').get('101'), env.sync.lynxPlaces('r_boys').get('214')], [2, 1]);

  // The race's event number changes: it no longer matches the file, so nobody has finished in it.
  boys.eventNumber = '33';
  await waitFor(() => events.length === 4, 'event after the race stopped matching');
  assert.equal(env.sync.lynxFinishers('r_boys').size, 0);
});

test('LifSync: two races on the same event are reported, the file is merged with the first only', async (t) => {
  const twin = { ...race3, id: 'r_twin', name: 'Twin' };
  const env = await setup(t, { races: [race3, twin], data: boysData() });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => env.out('003-1-01.lif'), 'merged file');
  assert.ok(env.logs.some((l) => /"Boys Gold 5K" and "Twin" all use event 3-1-1/.test(l)));
  assert.equal(env.sync.status().files[0].raceId, 'r_boys');
});

test('9.16 F5: a FinishLynx folder with no .lif files yet is "waiting" in words; a missing folder keeps the wrong-path words', async (t) => {
  const env = await setup(t, { data: { r_boys: { splitCount: 2, gun: GUN, runners: new Map() } } });
  env.sync.start();
  await waitFor(() => env.sync.status().state === 'waiting', 'waiting state');
  let st = env.sync.status();
  assert.equal(st.error, null);
  assert.equal(st.message, `No FinishLynx .lif files in ${env.inputDir} yet. They appear when FinishLynx saves a race; ` +
    'a race with splits and a gun time gets a merged file of its own before that.');
  assert.doesNotMatch(st.message, /not found|check the path/i);
  // FinishLynx has begun its first file (still empty)
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), '');
  await waitFor(() => env.sync.status().message === `Waiting for FinishLynx to finish writing 003-1-01.lif in ${env.inputDir}.`, 'the writing message');
  assert.equal(env.sync.status().state, 'waiting');
  // the folder gone: that is a wrong path (or a share that is down), and it says so
  await fsp.rm(env.inputDir, { recursive: true });
  await waitFor(() => env.sync.status().state === 'error', 'error state');
  st = env.sync.status();
  assert.match(st.error, /^FinishLynx folder not found: .*Check the path/);
  assert.equal(st.message, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Revision 10 (DESIGN 9.18 R4): a fresh read of FinishLynx's folder before Play and the Review's sends

test('LifSync.freshScan reads the FinishLynx folder now, not at the next poll, and waits for a file being written', async (t) => {
  const reads = new Map();
  const partial = new Set();
  // a file FinishLynx is writing: the two reads of one look differ (then it is complete)
  const fs = { ...fsp, readFile: async (p, ...a) => {
    const name = path.basename(String(p));
    reads.set(name, (reads.get(name) ?? 0) + 1);
    if (partial.has(name)) {
      partial.delete(name);
      return Buffer.from('3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595\r\n1,101,,A');
    }
    return fsp.readFile(p, ...a);
  } };
  // a poll a minute apart: only freshScan can see the new finisher in time
  const env = await setup(t, { data: boysData(), lif: { enabled: false }, fs, opts: { pollMs: 60_000, settleMs: 20, quietMs: 300 } });
  const events = [];
  env.sync.on('finishers', (id) => events.push(id));
  const file = path.join(env.inputDir, '003-1-01.lif');
  await fsp.writeFile(file, await readFixture('003-1-01.lif'));
  env.sync.start();
  await waitFor(() => events.length === 1, 'first read');
  assert.equal(env.sync.lynxFinishers('r_boys').has('610'), false);

  // nothing changed: one quick look
  let r = await env.sync.freshScan();
  assert.deepEqual([r.scanned, r.settled], [true, true]);

  // FinishLynx finishes bib 610; the next poll is a minute away
  const plus610 = Buffer.concat([await readFixture('003-1-01.lif'),
    Buffer.from('6,610,,Quill,Asher,Lakeview,17:00.000,M,,,17:00.000 (17:00.000),12:58:49.260,,,,,,,17:00.00\r\n')]);
  await fsp.writeFile(file, plus610);
  partial.add('003-1-01.lif'); // the first look catches it half written
  r = await env.sync.freshScan({ timeoutMs: 3000 });
  assert.deepEqual([r.scanned, r.settled], [true, true]);
  assert.equal(events.length, 2, "'finishers' came before freshScan resolved");
  assert.equal(env.sync.lynxFinishers('r_boys').get('610'), rt('17:00.000'));
  assert.equal(env.sync.lynxPlaces('r_boys').get('610'), 6);
  assert.ok(r.ms >= 250 && r.ms < 2000, `${r.ms} ms: it found something new, so it waited for the folder to be quiet`);

  // FinishLynx saves the next finisher while the folder is read (it sends a finish to TrackScore a moment before it
  // saves it): the quiet wait catches it
  const plus702 = Buffer.concat([plus610, Buffer.from('7,702,,Rourke,Ezra,Hollow Creek,17:30.000,M,,,17:30.000 (17:30.000),12:58:49.260,,,,,,,17:30.00\r\n')]);
  await fsp.writeFile(file, Buffer.concat([plus610, Buffer.from('\r\n')]));
  const pending = env.sync.freshScan({ timeoutMs: 3000 });
  await sleep(120);
  await fsp.writeFile(file, plus702);
  r = await pending;
  assert.deepEqual([r.scanned, r.settled], [true, true]);
  assert.equal(env.sync.lynxPlaces('r_boys').get('702'), 7, 'the finisher saved during the read is known');
});

test('LifSync.freshScan gives up after timeoutMs while a file never settles, and is a no-op without a FinishLynx folder', async (t) => {
  let n = 0;
  // every look at the file finds it different: FinishLynx (or a copy) never stops writing it
  const fs = { ...fsp, readFile: async (p) => Buffer.from(`3,1,1,Boys Gold 5K,,,,,,,12:58:49.2595\r\n${n++}`) };
  const env = await setup(t, { data: boysData(), lif: { enabled: false }, fs, opts: { pollMs: 60_000, settleMs: 20 } });
  await fsp.writeFile(path.join(env.inputDir, '003-1-01.lif'), 'x');
  env.sync.start();
  const t0 = Date.now();
  const r = await env.sync.freshScan({ timeoutMs: 300 });
  const took = Date.now() - t0;
  assert.deepEqual([r.scanned, r.settled], [true, false]);
  assert.ok(took >= 250 && took < 2000, `${took} ms`);

  env.config.lif.inputDir = '';
  const none = await env.sync.freshScan();
  assert.deepEqual([none.scanned, none.settled], [false, true]);
  await env.sync.stop();
  assert.deepEqual((await env.sync.freshScan()).scanned, false, 'stopped: nothing to read');
});
