// What the relay must not lose, on disk. data\reads.jsonl is the read journal (DESIGN.md 9.1): every read RR12 sent,
// appended synchronously before the read is used, so a relay killed mid-race rebuilds everything from it.
// data\races\<raceId>.json holds what each output was given (its ledger), so a restart sends nothing twice. The engine
// debounces those saves; this module only makes each one atomic (temp file + rename) and keeps them in order, because
// a half-written file after a power cut would cost the whole race.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Windows refuses a rename while another program (an antivirus scanner, the search indexer, an editor) has the
// target open; that clears within moments.
const RENAME_RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

let tmpSeq = 0;

// The journal's write buffer: a TCP chunk of reads (about 1,300) fits; one that grew past the maximum is let go.
const JOURNAL_BUFFER = 512 * 1024;
const JOURNAL_BUFFER_MAX = 4 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Write a file so that readers only ever see the old or the new contents: a temp file beside it (a rename cannot
 * cross volumes), flushed to disk, then renamed over the target. The temp name does not end in the target's
 * extension, so nothing watching the folder picks it up.
 * @param {string} file
 * @param {string | Buffer} data
 * @param {{ retries?: number, retryMs?: number }} [opts]
 */
export async function writeFileAtomic(file, data, { retries = 10, retryMs = 100 } = {}) {
  const tmp = `${file}.~${process.pid}-${++tmpSeq}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data);
      // A laptop that loses power right after a save must not come back with an empty file.
      await fh.datasync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= retries) {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(retryMs);
    }
  }
}

/** "2026-10-17-101502" for the names of files moved aside. */
export function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * Race ids come from the config, which a person may have edited; only plain ids become file names directly, anything
 * else (slashes, dots, reserved names) gets a stable hash so it can never point outside the folder.
 * @param {string} raceId
 */
export function raceFileName(raceId) {
  const id = String(raceId ?? '');
  if (/^[A-Za-z0-9_-]{1,80}$/.test(id) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(id)) return `${id}.json`;
  return `x_${crypto.createHash('sha1').update(id).digest('hex').slice(0, 20)}.json`;
}

/**
 * The engine's store (DESIGN.md 4.5, 9.1): `load`, `appendJournal` and `loadJournal` are synchronous; `save` and
 * `remove` return promises that never need to be awaited for correctness. Saves of one race are written in call order
 * and coalesced: while one write is under way only the newest data waits behind it.
 */
export class RaceStore {
  #dir;
  #journalFile;
  #log;
  /** raceId -> promise of the write chain for that race */
  #chains = new Map();
  /** raceId -> newest data not yet written (undefined = nothing waiting) */
  #latest = new Map();
  /** The journal stays open while the relay runs: opening the file for every read would cost more than the write. */
  #fd = null;
  /** The file ends in a torn line (power cut mid-write): the next record must start on a line of its own. */
  #needsNewline = false;
  /** Reused for every append (appendJournalMany). */
  #buf = Buffer.allocUnsafe(JOURNAL_BUFFER);

  /**
   * @param {{ dir: string, journalFile?: string, log?: (line: string) => void }} opts
   *   journalFile defaults to reads.jsonl next to the races folder (data\reads.jsonl)
   */
  constructor({ dir, journalFile, log = () => {} }) {
    this.#dir = path.resolve(dir);
    this.#journalFile = journalFile ? path.resolve(journalFile) : path.join(path.dirname(this.#dir), 'reads.jsonl');
    this.#log = typeof log === 'function' ? log : () => {};
    fs.mkdirSync(this.#dir, { recursive: true });
    this.#sweepTemps();
  }

  /** The folder the race files live in. */
  get dir() {
    return this.#dir;
  }

  /** The read journal file. */
  get journalFile() {
    return this.#journalFile;
  }

  /**
   * Append one record to the read journal, synchronously: when this returns, the record survives the process being
   * killed. Throws on a write error (the engine logs it and carries on).
   * @param {object} rec
   */
  appendJournal(rec) {
    this.appendJournalMany([rec]);
  }

  /**
   * Append several records with ONE synchronous write (the reads of one TCP chunk): when this returns, they all
   * survive the process being killed. A whole RR12 Replay chunk costs one disk write instead of one per read.
   * @param {object[]} recs
   */
  appendJournalMany(recs) {
    if (!Array.isArray(recs) || !recs.length) return;
    // The records go straight into one reusable buffer: a chunk's worth joined into one string would be a third of a
    // megabyte, which the JavaScript heap only frees at its next full collection.
    let buf = this.#buf;
    let len = 0;
    const put = (s) => {
      if (len + s.length * 3 > buf.length) {
        const bigger = Buffer.allocUnsafe(Math.max(buf.length * 2, len + s.length * 3));
        buf.copy(bigger, 0, 0, len);
        buf = bigger;
      }
      len += buf.write(s, len, 'utf8');
    };
    if (this.#needsNewline) put('\n');
    for (const rec of recs) put(`${JSON.stringify(rec)}\n`);
    // a buffer grown for one huge chunk is not kept for the rest of the meet
    this.#buf = buf.length <= JOURNAL_BUFFER_MAX ? buf : Buffer.allocUnsafe(JOURNAL_BUFFER);
    try {
      if (this.#fd === null) {
        fs.mkdirSync(path.dirname(this.#journalFile), { recursive: true });
        this.#fd = fs.openSync(this.#journalFile, 'a');
      }
      // writeSync may write less than asked (a full disk, a network share); what is left goes out in the same call
      let off = 0;
      while (off < len) off += fs.writeSync(this.#fd, buf, off, len - off);
      this.#needsNewline = false;
    } catch (err) {
      // A share that went away, a full disk: open it again next time rather than write to a dead handle forever.
      this.closeJournal();
      // Part of the text may be on disk: the next record starts on a line of its own (a blank line is skipped).
      this.#needsNewline = true;
      throw err;
    }
  }

  /**
   * Every record in the journal, in order. A torn last line (power cut mid-write) is skipped with a log line; so is any
   * other line that is not a record, which can only be damage.
   * @returns {object[]}
   */
  loadJournal() {
    let text;
    try {
      text = fs.readFileSync(this.#journalFile, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.split('\n');
    const torn = !text.endsWith('\n') && text.length > 0;
    this.#needsNewline = torn;
    const records = [];
    let damaged = 0;
    lines.forEach((raw, i) => {
      const line = raw.replace(/\r$/, '').trim();
      if (!line) return;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
          records.push(rec);
          return;
        }
      } catch {
        // counted below
      }
      if (torn && i === lines.length - 1) {
        this.#log(`[store] the last line of ${this.#journalFile} was cut off (power cut or a crash while writing); skipped it`);
      } else damaged++;
    });
    if (damaged) this.#log(`[store] skipped ${damaged} damaged line${damaged === 1 ? '' : 's'} in ${this.#journalFile}`);
    return records;
  }

  /** Close the journal (at shutdown; also lets a test delete its folder on Windows). The next append opens it again. */
  closeJournal() {
    if (this.#fd === null) return;
    try {
      fs.closeSync(this.#fd);
    } catch {
      // already gone
    }
    this.#fd = null;
  }

  /**
   * The saved data of a race, or null when there is none. A file that cannot be read is moved aside (never
   * overwritten, so it can still be rescued by hand) and the race starts empty.
   * @param {string} raceId
   * @returns {any}
   */
  load(raceId) {
    const file = path.join(this.#dir, raceFileName(raceId));
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      this.#log(`[store] could not read ${file}: ${err?.message ?? err}`);
      return null;
    }
    try {
      const data = JSON.parse(text.replace(/^﻿/, ''));
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      const aside = file.replace(/\.json$/, `.broken-${fileStamp()}.json`);
      try {
        fs.renameSync(file, aside);
        this.#log(`[store] ${file} is damaged (${err.message}); moved it to ${aside} and started this race empty`);
      } catch (e) {
        this.#log(`[store] ${file} is damaged (${err.message}) and could not be moved aside: ${e?.message ?? e}`);
      }
      return null;
    }
  }

  /**
   * Save a race's data (any JSON-safe value). Resolves when it is on disk; rejects with the write error.
   * @param {string} raceId
   * @param {any} data
   * @returns {Promise<void>}
   */
  save(raceId, data) {
    const id = String(raceId);
    this.#latest.set(id, { data });
    return this.#enqueue(id, async () => {
      const job = this.#latest.get(id);
      if (!job) return; // an earlier write in this chain already took the newest data
      this.#latest.delete(id);
      if (job.removed) return;
      await writeFileAtomic(path.join(this.#dir, raceFileName(id)), `${JSON.stringify(job.data)}\n`);
    });
  }

  /**
   * Forget a deleted race. The file is moved to races\deleted rather than erased: a race deleted by mistake on race
   * day can still be recovered by hand.
   * @param {string} raceId
   * @returns {Promise<void>}
   */
  remove(raceId) {
    const id = String(raceId);
    this.#latest.set(id, { removed: true });
    return this.#enqueue(id, async () => {
      this.#latest.delete(id);
      const name = raceFileName(id);
      const file = path.join(this.#dir, name);
      const deletedDir = path.join(this.#dir, 'deleted');
      try {
        await fsp.mkdir(deletedDir, { recursive: true });
        await fsp.rename(file, path.join(deletedDir, name.replace(/\.json$/, `-${fileStamp()}.json`)));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    });
  }

  /** Resolves once every save and remove asked for so far has finished (before shutdown). Never rejects. */
  async flush() {
    while (this.#chains.size) {
      await Promise.all([...this.#chains.values()].map((p) => p.catch(() => {})));
    }
  }

  #enqueue(id, task) {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(task);
    const tracked = run.finally(() => {
      if (this.#chains.get(id) === tracked) this.#chains.delete(id);
    });
    // Neither the chain nor a caller that does not wait may raise an unhandled rejection: that would stop the process.
    tracked.catch(() => {});
    run.catch(() => {});
    this.#chains.set(id, tracked);
    return run;
  }

  /** Temp files left by a crash or a power cut are never anything but half a save. */
  #sweepTemps() {
    try {
      for (const name of fs.readdirSync(this.#dir)) {
        if (/\.~\d+-\d+\.tmp$/.test(name)) fs.rmSync(path.join(this.#dir, name), { force: true });
      }
    } catch {
      // only tidiness
    }
  }
}
