import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RaceStore } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { parseTod } from '../src/timefmt.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the read journal: appended synchronously, read back in order, next to the races folder by default', (t) => {
  const data = tempDir(t);
  const store = new RaceStore({ dir: path.join(data, 'races') });
  t.after(() => store.closeJournal());
  assert.equal(store.journalFile, path.join(data, 'reads.jsonl'));
  assert.deepEqual(store.loadJournal(), [], 'no journal yet');
  store.appendJournal({ t: 'read', seq: 1, bib: '254' });
  // on disk at once, before anything else happens: another reader sees it straight away
  assert.equal(fs.readFileSync(store.journalFile, 'utf8'), '{"t":"read","seq":1,"bib":"254"}\n');
  store.appendJournal({ t: 'route', seq: 1, raceId: 'r_a' });
  assert.deepEqual(new RaceStore({ dir: path.join(data, 'races') }).loadJournal(),
    [{ t: 'read', seq: 1, bib: '254' }, { t: 'route', seq: 1, raceId: 'r_a' }]);
  const other = new RaceStore({ dir: path.join(data, 'x'), journalFile: path.join(data, 'elsewhere', 'j.jsonl') });
  other.appendJournal({ t: 'clear', raceId: 'r', seq: 0 });
  other.closeJournal();
  assert.ok(fs.existsSync(path.join(data, 'elsewhere', 'j.jsonl')));
});

test('a torn last line is skipped with a log line, and the next record starts on a line of its own', (t) => {
  const data = tempDir(t);
  const file = path.join(data, 'reads.jsonl');
  fs.writeFileSync(file, '{"t":"read","seq":1}\r\nnot json\n{"t":"read","seq":2}\n{"t":"read","se');
  const lines = [];
  const store = new RaceStore({ dir: path.join(data, 'races'), log: (l) => lines.push(l) });
  t.after(() => store.closeJournal());
  assert.deepEqual(store.loadJournal().map((r) => r.seq), [1, 2]);
  assert.ok(lines.some((l) => /last line of .*reads\.jsonl was cut off/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /skipped 1 damaged line/.test(l)), lines.join('\n'));
  store.appendJournal({ t: 'read', seq: 3 });
  assert.deepEqual(store.loadJournal().map((r) => r.seq), [1, 2, 3], 'the torn line did not swallow the new record');
});

test('appendJournalMany writes the reads of a whole chunk with one write, in order (revision 3)', (t) => {
  const data = tempDir(t);
  const store = new RaceStore({ dir: path.join(data, 'races') });
  t.after(() => store.closeJournal());
  const writes = [];
  const real = fs.writeSync;
  fs.writeSync = (...args) => {
    writes.push(args);
    return real(...args);
  };
  try {
    store.appendJournalMany(Array.from({ length: 1300 }, (_, i) => ({ t: 'read', seq: i + 1, bib: String(i + 1), location: 'Ünïcödé 1K' })));
    store.appendJournalMany([]);
  } finally {
    fs.writeSync = real;
  }
  assert.equal(writes.length, 1, 'one write for 1300 reads, nothing for none');
  const back = store.loadJournal();
  assert.deepEqual(back.map((r) => r.seq), Array.from({ length: 1300 }, (_, i) => i + 1));
  assert.equal(back[0].location, 'Ünïcödé 1K');
});

test('closeJournal lets go of the file; appending again reopens it', (t) => {
  const data = tempDir(t);
  const store = new RaceStore({ dir: path.join(data, 'races') });
  store.appendJournal({ t: 'read', seq: 1 });
  store.closeJournal();
  fs.renameSync(store.journalFile, `${store.journalFile}.moved`); // Windows refuses this while the file is open
  store.appendJournal({ t: 'read', seq: 2 });
  store.closeJournal();
  assert.deepEqual(store.loadJournal(), [{ t: 'read', seq: 2 }]);
});

test('an engine on the real store comes back from a hard kill with every read (race-day-sim F2)', (t) => {
  const data = tempDir(t);
  const config = { filter: { holdSec: 2, tagWindowSec: 10 }, outputs: [], races: [{ id: 'r1', name: 'R', gun: '10:00:00',
    contests: [], active: true, finishSources: [], splits: [{ id: 's1', name: '1K', sources: ['1K-A', '1K-B'] }] }] };
  const store1 = new RaceStore({ dir: path.join(data, 'races') });
  const e1 = new Engine({ getConfig: () => config, store: store1, autoStart: false });
  e1.handleRead({ location: '1K-A', bib: '1100', tod: parseTod('10:05:04.000') });
  e1.handleRead({ location: '1K-B', bib: '1101', tod: parseTod('10:05:04.300') });
  // killed: no stop(), no flush; the second process opens the same files
  const store2 = new RaceStore({ dir: path.join(data, 'races') });
  t.after(() => {
    store1.closeJournal();
    store2.closeJournal();
  });
  const e2 = new Engine({ getConfig: () => config, store: store2, autoStart: false });
  assert.deepEqual(e2.crossings('r1').map((c) => c.bib), ['1100', '1101']);
  // seq carries on: a read after the restart is not mistaken for an old one
  e2.handleRead({ location: '1K-A', bib: '1102', tod: parseTod('10:05:05') });
  assert.deepEqual(store2.loadJournal().filter((r) => r.t === 'read').map((r) => r.seq), [1, 2, 3]);
});
