import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePpl, NamesFile } from '../src/ppl.js';
import { encodeCp1252 } from '../src/cp1252.js';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(5);
  }
}

// Invented athletes, laid out like a real FinishLynx Lynx.ppl: 8 fields, CRLF, no header.
const PPL = [
  '101,Arbuckle,Tessa,Lakeside HS,F,,,',
  '102,"Brandt, Jr.",Owen,"Hill, Dale & Vale",M,,,',
  '103,O\'Malley,Siobhán,Northfield Academy,f,,,',
  '104,"Quote ""Q"" Quill",Ida,Ridge,X,,,',
  '',
  '105,Stray"Quote,Bo,Glen Prep,m,,,',
].join('\r\n') + '\r\n';

describe('parsePpl', () => {
  test('8-field CRLF file with quoted commas, doubled quotes and stray quotes', () => {
    const m = parsePpl(PPL);
    assert.equal(m.size, 5);
    assert.deepEqual(m.get('101'), { first: 'Tessa', last: 'Arbuckle', team: 'Lakeside HS', gender: 'F' });
    assert.deepEqual(m.get('102'), { first: 'Owen', last: 'Brandt, Jr.', team: 'Hill, Dale & Vale', gender: 'M' });
    assert.deepEqual(m.get('103'), { first: 'Siobhán', last: "O'Malley", team: 'Northfield Academy', gender: 'F' });
    assert.deepEqual(m.get('104'), { first: 'Ida', last: 'Quote "Q" Quill', team: 'Ridge', gender: '' });
    assert.deepEqual(m.get('105'), { first: 'Bo', last: 'Stray"Quote', team: 'Glen Prep', gender: 'M' });
  });

  test('header line skipped only when field 0 is ID / Bib / Number', () => {
    for (const h of ['ID', 'Bib', 'number', 'BIB']) {
      const m = parsePpl(`${h},Last,First,Team,Gender\r\n7,Ames,Kit,Pine,F\r\n`);
      assert.equal(m.size, 1, h);
      assert.equal(m.get('7').last, 'Ames');
    }
    // Only the first line can be a header.
    assert.equal(parsePpl('7,Ames,Kit,Pine,F\r\nBib,x,y,z,M\r\n').get('Bib').last, 'x');
  });

  test('LF and CR line ends, BOM, short lines, empty bibs, nameless lines, duplicates', () => {
    const m = parsePpl('\uFEFF1,Aa,Bb\n2,Cc\r3\r,Nobody,Here\n4,,,,F\n1,Later,Dup,,M\n');
    assert.deepEqual([...m.keys()], ['1', '2']);
    assert.deepEqual(m.get('1'), { first: 'Bb', last: 'Aa', team: '', gender: '' }); // first line for a bib wins
    assert.deepEqual(m.get('2'), { first: '', last: 'Cc', team: '', gender: '' });
    assert.equal(parsePpl('').size, 0);
    assert.equal(parsePpl(/** @type {any} */ (undefined)).size, 0);
  });

  test('gender normalised to M / F / blank', () => {
    const m = parsePpl('1,A,B,C,M\r\n2,A,B,C,F\r\n3,A,B,C,male\r\n4,A,B,C,Girls\r\n5,A,B,C,\r\n6,A,B,C,U\r\n');
    assert.deepEqual([...m.values()].map((e) => e.gender), ['M', 'F', 'M', 'F', '', '']);
  });
});

describe('NamesFile', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'split-relay-ppl-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('loads a windows-1252 file with odd bytes; lookup and status', async () => {
    const path = join(dir, 'Lynx.ppl');
    // 0x92 = right single quote, 0xE9 = é, 0x81 = undefined in windows-1252 (kept as U+0081, never an error).
    const bytes = Buffer.concat([
      encodeCp1252('201,D’Arcy,Renée,Crest Valley,F,,,\r\n'),
      Buffer.from([0x32, 0x30, 0x32, 0x2c, 0x4b, 0x81, 0x6c, 0x2c, 0x41, 0x6c, 0x2c, 0x54, 0x2c, 0x4d, 0x0d, 0x0a]), // 202,K\x81l,Al,T,M
      encodeCp1252('0203,Zed,Ann,Moor,F,,,\r\n'),
    ]);
    await writeFile(path, bytes);
    const names = new NamesFile({ path, pollMs: 30 });
    const changes = [];
    names.on('change', (s) => changes.push(s));
    try {
      await names.start();
      const st = names.status();
      assert.equal(st.path, path);
      assert.equal(st.loaded, true);
      assert.equal(st.count, 3);
      assert.equal(st.error, null);
      assert.ok(st.loadedAt > 0);
      assert.ok(changes.length >= 1);
      assert.deepEqual(names.lookup('201'), { first: 'Renée', last: 'D’Arcy', team: 'Crest Valley', gender: 'F' });
      assert.equal(names.lookup(202).last, 'K\u0081l');
      // Leading zeros do not matter either way.
      assert.equal(names.lookup('203').last, 'Zed');
      assert.equal(names.lookup('0201').first, 'Renée');
      assert.equal(names.lookup('999'), undefined);
      assert.equal(names.lookup(''), undefined);
    } finally {
      names.stop();
    }
  });

  test('a UTF-8 BOM is not glued to the first bib', async () => {
    const path = join(dir, 'bom.ppl');
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encodeCp1252('1,First,Line,T,M\r\n')]));
    const names = new NamesFile({ path });
    await names.reload();
    assert.equal(names.lookup('1').last, 'First');
  });

  test('reloads when the file changes and emits change', async () => {
    const path = join(dir, 'live.ppl');
    await writeFile(path, encodeCp1252('1,Ash,Lee,Oak,M\r\n'));
    const names = new NamesFile({ path, pollMs: 25 });
    let changes = 0;
    names.on('change', () => { changes++; });
    try {
      await names.start();
      assert.equal(names.lookup('1').last, 'Ash');
      const before = changes;
      await writeFile(path, encodeCp1252('1,Ashby,Lee,Oak,M\r\n2,Birch,Max,Elm,F\r\n'));
      await waitFor(() => names.status().count === 2, 'reload');
      assert.equal(names.lookup('1').last, 'Ashby');
      assert.equal(names.lookup('2').team, 'Elm');
      assert.ok(changes > before);
      // Unchanged file: no further reloads.
      const settled = changes;
      const loadedAt = names.status().loadedAt;
      await pause(120);
      assert.equal(changes, settled);
      assert.equal(names.status().loadedAt, loadedAt);
    } finally {
      names.stop();
    }
  });

  test('missing file -> status error, no throw; appears later -> loads', async () => {
    const path = join(dir, 'not-yet.ppl');
    const names = new NamesFile({ path, pollMs: 25 });
    try {
      await assert.doesNotReject(names.start());
      const st = names.status();
      assert.equal(st.loaded, false);
      assert.equal(st.count, 0);
      assert.match(st.error, /not found/);
      assert.ok(st.error.includes(path));
      assert.equal(names.lookup('1'), undefined);
      await writeFile(path, encodeCp1252('1,Late,Comer,Bay,F\r\n'));
      await waitFor(() => names.status().loaded, 'load after the file appears');
      assert.equal(names.status().error, null);
      assert.equal(names.lookup('1').last, 'Late');
    } finally {
      names.stop();
    }
  });

  test('a file that disappears after loading keeps the names and reports the error', async () => {
    const path = join(dir, 'vanish.ppl');
    await writeFile(path, encodeCp1252('5,Keep,Me,Here,M\r\n'));
    const names = new NamesFile({ path, pollMs: 25 });
    try {
      await names.start();
      await unlink(path);
      await waitFor(() => names.status().error, 'error');
      assert.match(names.status().error, /not found.*still using the 1 names/);
      assert.equal(names.status().loaded, true);
      assert.equal(names.lookup('5').last, 'Keep');
      await writeFile(path, encodeCp1252('5,Keep,Me,Here,M\r\n'));
      await waitFor(() => names.status().error === null, 'error cleared');
    } finally {
      names.stop();
    }
  });

  test('a folder instead of a file is a clear error', async () => {
    const folder = join(dir, 'a-folder');
    await mkdir(folder);
    const names = new NamesFile({ path: folder });
    await names.start();
    names.stop();
    assert.match(names.status().error, /is a folder/);
  });

  test('setPath switches files, clears the old names and accepts an empty path', async () => {
    const a = join(dir, 'a.ppl');
    const b = join(dir, 'b.ppl');
    await writeFile(a, encodeCp1252('1,Alpha,A,TA,M\r\n'));
    await writeFile(b, encodeCp1252('2,Bravo,B,TB,F\r\n3,Charlie,C,TC,M\r\n'));
    const names = new NamesFile({ path: a, pollMs: 25 });
    try {
      await names.start();
      assert.equal(names.lookup('1').last, 'Alpha');
      await names.setPath(b);
      assert.equal(names.status().path, b);
      assert.equal(names.status().count, 2);
      assert.equal(names.lookup('1'), undefined);
      assert.equal(names.lookup('3').last, 'Charlie');
      await names.setPath('');
      assert.deepEqual(names.status(), { path: '', loaded: false, count: 0, error: null, loadedAt: null });
      assert.equal(names.lookup('3'), undefined);
      await names.setPath(join(dir, 'nope.ppl'));
      assert.match(names.status().error, /not found/);
    } finally {
      names.stop();
    }
  });

  test('a path that is not a full path is reported, not read from this drive (review-edges F3)', { skip: process.platform !== 'win32' }, async () => {
    // "\Lynx\Lynx.ppl" is the root of the drive Split Relay started on, not the network share that was meant.
    for (const [p, re] of [['\\Lynx\\Lynx.ppl', /single backslash\. A network path starts with two backslashes/],
      ['Lynx.ppl', /Type the full path of the names file/]]) {
      const names = new NamesFile({ path: p });
      await names.start();
      names.stop();
      const st = names.status();
      assert.equal(st.loaded, false, p);
      assert.match(st.error, re, p);
    }
  });

  test('stop() stops polling', async () => {
    const path = join(dir, 'stopped.ppl');
    await writeFile(path, encodeCp1252('1,One,O,T,M\r\n'));
    const names = new NamesFile({ path, pollMs: 20 });
    await names.start();
    names.stop();
    await writeFile(path, encodeCp1252('1,Changed,O,T,M\r\n2,Two,T,T,F\r\n'));
    await pause(120);
    assert.equal(names.lookup('1').last, 'One');
    assert.equal(names.status().count, 1);
  });
});
