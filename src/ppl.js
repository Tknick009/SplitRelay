// FinishLynx's people file (Lynx.ppl). TrackScore keeps the latest non-empty name it hears for a runner, so the names
// we send on a split must be FinishLynx's own strings, byte for byte, or the finish packet and the split packet will
// fight over the runner's name. Reading the same file FinishLynx reads is the only way to get those strings.

import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import { decodeCp1252 } from './cp1252.js';
import { normalizeGender } from './input.js';
import { fullPathProblem } from './lif.js';

/** @typedef {{ first: string, last: string, team: string, gender: 'M'|'F'|'' }} PplEntry */
/** @typedef {{ path: string, loaded: boolean, count: number, error: string | null, loadedAt: number | null }} NamesStatus */

// Registration exports sometimes keep their header row; FinishLynx itself writes none.
const HEADER = /^(id|bib|bib ?#|bib ?no\.?|number|no\.?)$/i;

/**
 * One CSV line -> trimmed fields. Quotes only count at the start of a field, so a stray `"` inside a name (odd bytes
 * in real files) cannot swallow the commas after it; `""` inside quotes is a literal quote.
 * @param {string} line
 */
function splitCsvLine(line) {
  const fields = [];
  const n = line.length;
  let i = 0;
  for (;;) {
    let j = i;
    while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
    let value = '';
    if (line[j] === '"') {
      j++;
      while (j < n) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') { value += '"'; j += 2; continue; }
          j++;
          break;
        }
        value += line[j++];
      }
    } else {
      j = i;
    }
    // Text after a closing quote (or an unquoted field) runs to the next comma.
    const end = line.indexOf(',', j);
    value += end === -1 ? line.slice(j) : line.slice(j, end);
    fields.push(value.trim());
    if (end === -1) return fields;
    i = end + 1;
  }
}

/**
 * Lynx.ppl text -> names by bib. Fields: 0 bib, 1 last, 2 first, 3 affiliation, 4 gender; the rest are ignored.
 * Lines with no name and no team are skipped (an entry would only blank the names the stream gives us). When a bib is
 * listed twice the first line wins.
 * @param {string} text
 * @returns {Map<string, PplEntry>}
 */
export function parsePpl(text) {
  /** @type {Map<string, PplEntry>} */
  const out = new Map();
  let first = true;
  for (const line of String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (!line.trim()) continue;
    const f = splitCsvLine(line);
    if (first) {
      first = false;
      if (HEADER.test(f[0])) continue;
    }
    const bib = f[0];
    if (!bib || out.has(bib)) continue;
    const entry = { first: f[2] ?? '', last: f[1] ?? '', team: f[3] ?? '', gender: normalizeGender(f[4]) };
    if (entry.first || entry.last || entry.team) out.set(bib, entry);
  }
  return out;
}

/** "0254" and "254" are the same runner; RR12 has no leading zeros, a hand-made people file might. */
function canonicalBib(bib) {
  const s = String(bib ?? '').trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s.toUpperCase();
}

const MAX_BYTES = 50 * 1024 * 1024;
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function readErrorMessage(err, path) {
  const code = err && err.code;
  if (code === 'ENOENT') return `Names file not found: ${path}`;
  if (code === 'EISDIR') return `${path} is a folder — choose the .ppl file inside it`;
  if (code === 'EACCES' || code === 'EPERM') return `Windows won't let Split Relay read ${path} (permission denied)`;
  if (code === 'EBUSY') return `${path} is locked by another program — trying again`;
  if (code === 'ETOOBIG') return `${path} is too big to be a FinishLynx people file`;
  return `Can't read the names file ${path}: ${err && err.message ? err.message : String(err)}`;
}

/**
 * The names file, kept current while FinishLynx or the operator edits it. Polled (not fs.watch) because it usually
 * lives on a network share where watch events are unreliable. A file that goes missing or unreadable keeps the names
 * already loaded — losing every name mid-race over a network blip would be worse than slightly stale names.
 * Emits 'change' (NamesStatus) whenever the names or the status change.
 */
export class NamesFile extends EventEmitter {
  #path;
  #pollMs;
  /** @type {Map<string, PplEntry> | null} */
  #map = null;
  /** @type {Map<string, PplEntry>} */
  #canon = new Map();
  #error = null;
  #loadedAt = null;
  /** size:mtime of the loaded file; unchanged means no re-read. */
  #key = null;
  #running = false;
  #timer = null;
  #busy = null;
  #again = false;
  /** Bumped by setPath so a read of the old path that is still in flight cannot install its result. */
  #gen = 0;

  /** @param {{ path?: string, pollMs?: number }} [opts] */
  constructor({ path = '', pollMs = 5000 } = {}) {
    super();
    this.#path = String(path ?? '').trim();
    this.#pollMs = pollMs;
  }

  /** Begin polling. The returned promise settles after the first load attempt (it never rejects). */
  start() {
    this.#running = true;
    return this.#check();
  }

  stop() {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Switch to another file ('' = none). The same path again forces a re-read. Settles after the load attempt.
   * @param {string} path
   */
  setPath(path) {
    const p = String(path ?? '').trim();
    this.#gen++;
    this.#key = null;
    if (p !== this.#path) {
      this.#path = p;
      this.#map = null;
      this.#canon = new Map();
      this.#error = null;
      this.#loadedAt = null;
      this.#emitChange();
    }
    return this.#running ? this.#check() : Promise.resolve();
  }

  /** Read the file now (also when stopped). */
  reload() {
    this.#key = null;
    return this.#check();
  }

  /**
   * @param {string | number} bib
   * @returns {PplEntry | undefined}
   */
  lookup(bib) {
    if (!this.#map) return undefined;
    const b = String(bib ?? '').trim();
    return this.#map.get(b) ?? this.#canon.get(canonicalBib(b));
  }

  /** @returns {NamesStatus} */
  status() {
    return {
      path: this.#path,
      loaded: this.#map !== null,
      count: this.#map ? this.#map.size : 0,
      error: this.#error,
      loadedAt: this.#loadedAt,
    };
  }

  /** One check at a time: a slow share must not pile up overlapping reads. A request during a check re-runs it. */
  #check() {
    if (this.#busy) {
      this.#again = true;
      return this.#busy;
    }
    this.#busy = (async () => {
      do {
        this.#again = false;
        try {
          await this.#checkOnce();
        } catch (err) {
          this.#setError(readErrorMessage(err, this.#path));
        }
      } while (this.#again);
    })().finally(() => {
      this.#busy = null;
      this.#schedule();
    });
    return this.#busy;
  }

  #schedule() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#check();
    }, this.#pollMs);
    this.#timer.unref?.();
  }

  async #checkOnce() {
    const gen = this.#gen;
    const path = this.#path;
    if (!path) return;
    // Settings refuse such a path now; one saved before that would read a file on this PC's own drive (a network
    // path that lost a backslash) and show its names as if they were FinishLynx's.
    const problem = fullPathProblem(path, 'the names file', 'C:\\Lynx\\Lynx.ppl');
    if (problem) {
      this.#setError(problem);
      return;
    }
    let st;
    try {
      st = await fsp.stat(path);
      if (st.isDirectory()) throw Object.assign(new Error('is a directory'), { code: 'EISDIR' });
      if (st.size > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'ETOOBIG' });
    } catch (err) {
      if (gen === this.#gen) this.#setError(readErrorMessage(err, path));
      return;
    }
    if (gen !== this.#gen) return;
    const key = `${st.size}:${st.mtimeMs}`;
    if (key === this.#key && this.#map) {
      this.#setError(null);
      return;
    }
    let buf;
    let after;
    try {
      buf = await fsp.readFile(path);
      after = await fsp.stat(path);
    } catch (err) {
      if (gen === this.#gen) this.#setError(readErrorMessage(err, path));
      return;
    }
    if (gen !== this.#gen) return;
    // Caught mid-save (an editor or FinishLynx rewriting it): leave the key alone so the next poll reads it again.
    if (buf.length !== after.size || `${after.size}:${after.mtimeMs}` !== key) return;
    const body = UTF8_BOM.every((b, i) => buf[i] === b) ? buf.subarray(3) : buf;
    const map = parsePpl(decodeCp1252(body));
    const canon = new Map();
    for (const [bib, entry] of map) {
      Object.freeze(entry);
      const c = canonicalBib(bib);
      if (!canon.has(c)) canon.set(c, entry);
    }
    this.#map = map;
    this.#canon = canon;
    this.#key = key;
    this.#loadedAt = Date.now();
    this.#error = null;
    this.#emitChange();
  }

  #setError(message) {
    const text = message && this.#map ? `${message} (still using the ${this.#map.size} names loaded earlier)` : message;
    if (text === this.#error) return;
    this.#error = text;
    this.#emitChange();
  }

  #emitChange() {
    try {
      this.emit('change', this.status());
    } catch (err) {
      console.error("[names] 'change' listener failed:", err);
    }
  }
}
