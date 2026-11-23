// Updates from GitHub (DESIGN 9.28). At start Split Relay asks GitHub once for the newest release of its repository.
// When that is newer than this copy the panel says so, and "Install update" downloads the release's zip, checks it,
// keeps a copy of the program files as they are, puts the new ones in their place and starts Split Relay again
// (src/launcher.js). Nothing is ever installed by itself, the data folder is never touched, and a version that does
// not start is taken out again by the launcher, which puts the kept copy back.
//
// This file is also loaded by the launcher, which keeps running while the program files change under it: it imports
// nothing but Node's own modules and zip.js.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readZip } from './zip.js';

/** The repository the releases are published in (owner/name on github.com). */
export const UPDATE_REPO = 'Tknick009/SplitRelay';
export const GITHUB_API = 'https://api.github.com';
/** The exit code that asks the launcher to start Split Relay again (an update was installed). */
export const RESTART_CODE = 75;
/** The folders a release owns: a file in them that the new version no longer has is removed. The data folder is not one. */
export const MANAGED_DIRS = ['src', 'public', 'lynx', 'test'];
/** A release's zip is a few MB; anything much larger is not one. */
export const MAX_DOWNLOAD = 60 * 1024 * 1024;
const CHECK_TIMEOUT_MS = 8000;
const DOWNLOAD_TIMEOUT_MS = 180000;
const NOTES_MAX = 6000;

export class UpdateError extends Error {
  /** @param {string} message in words, for the operator @param {number} [status] */
  constructor(message, status = 409) {
    super(message);
    this.code = 'UPDATE';
    this.status = status;
  }
}

/** "9.28.0" or "v9.28.0" -> [9, 28, 0]; null for anything else. */
export function parseVersion(v) {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** < 0 when a is older than b, 0 when the same, > 0 when newer; a version that can't be read counts as oldest. */
export function compareVersions(a, b) {
  const x = parseVersion(a) ?? [-1, -1, -1];
  const y = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** ">=18.17" (package.json engines.node) against a Node version: whether it is new enough; true when unreadable. */
export function nodeIsEnough(range, node = process.versions.node) {
  const m = /^\s*>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(range ?? ''));
  if (!m) return true;
  const want = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  const have = String(node).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  return true;
}

/**
 * GitHub's answer for a release -> what Split Relay keeps of it, or null when it is not a release with a readable
 * version. The zip is the asset named SplitRelay-<version>.zip, else the only .zip asset, else GitHub's own zip of
 * the source (whose files sit in one top folder: unpacked without it).
 * @param {any} json
 */
export function releaseOf(json) {
  if (!json || typeof json !== 'object' || json.draft === true || json.prerelease === true) return null;
  const v = parseVersion(json.tag_name);
  if (!v) return null;
  const version = v.join('.');
  const assets = (Array.isArray(json.assets) ? json.assets : []).filter((a) => a && typeof a.name === 'string' && /\.zip$/i.test(a.name) && typeof a.browser_download_url === 'string');
  const named = assets.find((a) => a.name.toLowerCase() === `splitrelay-${version}.zip`) ?? (assets.length === 1 ? assets[0] : null);
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(named?.digest ?? ''));
  const zip = named ? { url: named.browser_download_url, name: named.name, size: Number.isFinite(named.size) ? named.size : null, sha256: digest ? digest[1].toLowerCase() : null }
    : typeof json.zipball_url === 'string' ? { url: json.zipball_url, name: `SplitRelay-${version}-source.zip`, size: null, sha256: null } : null;
  return {
    version,
    name: String(json.name ?? '').trim() || `Split Relay ${version}`,
    notes: String(json.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, NOTES_MAX),
    publishedAt: Date.parse(json.published_at) || null,
    pageUrl: typeof json.html_url === 'string' && json.html_url.startsWith('https://github.com/') ? json.html_url : null,
    zip,
  };
}

/** The files of a release zip without the one top folder GitHub's source zips have; as they are when there is none. */
export function stripTopFolder(files) {
  if (!files.length || files.some((f) => !f.name.includes('/'))) return files;
  const top = files[0].name.slice(0, files[0].name.indexOf('/') + 1);
  if (!files.every((f) => f.name.startsWith(top))) return files;
  return files.map((f) => ({ name: f.name.slice(top.length), data: f.data }));
}

/**
 * Whether these files are a Split Relay release of the version asked for, that this PC can run: a sentence saying why
 * not, or null.
 * @param {{ name: string, data: Buffer }[]} files @param {string} version
 */
export function releaseProblem(files, version, node = process.versions.node) {
  const by = new Map(files.map((f) => [f.name, f]));
  for (const need of ['package.json', 'start.bat', 'src/main.js', 'src/launcher.js', 'src/update.js', 'public/index.html', 'public/app.js']) {
    if (!by.has(need)) return `The download is not a complete Split Relay (it has no ${need}).`;
  }
  let pkg;
  try {
    pkg = JSON.parse(by.get('package.json').data.toString('utf8'));
  } catch {
    return 'The download is not a Split Relay release (its package.json can\'t be read).';
  }
  if (pkg?.name !== 'split-relay') return 'The download is not Split Relay.';
  if (compareVersions(pkg.version, version) !== 0) return `The download says it is version ${String(pkg.version).slice(0, 20)}, not ${version}.`;
  if (!nodeIsEnough(pkg.engines?.node, node)) {
    return `Split Relay ${version} needs Node.js ${String(pkg.engines.node).replace(/^\s*>=\s*/, '')} or newer, and this PC has ${node}. Install the LTS version from https://nodejs.org first, then install the update.`;
  }
  for (const f of files) {
    if (f.name.startsWith('data/') || f.name.startsWith('node_modules/') || f.name.startsWith('.git/')) return `The download holds "${f.name}", which a Split Relay release never does.`;
  }
  return null;
}

// ---- files ---------------------------------------------------------------------------------------------------------

/** Every file under a folder, as paths relative to `root` with forward slashes. */
function listFiles(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function writeFileIn(root, rel, data) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sr-new`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function removeEmptyDirs(root, rel) {
  let dir = path.dirname(path.join(root, ...rel.split('/')));
  while (dir.length > root.length && dir.startsWith(root)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

const readJson = (file) => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
};

/** Where the update's own files are kept: <data folder>\update. */
export const updateDir = (dataDir) => path.join(dataDir, 'update');
const pendingFile = (dataDir) => path.join(updateDir(dataDir), 'pending.json');
const installedFile = (dataDir) => path.join(updateDir(dataDir), 'installed.json');
const rolledBackFile = (dataDir) => path.join(updateDir(dataDir), 'rolled-back.json');
const backupDirOf = (dataDir) => path.join(updateDir(dataDir), 'backup');

/** The update that was put in place and has not started yet: { from, to, at, added }, or null. */
export const readPending = (dataDir) => readJson(pendingFile(dataDir));

/**
 * Puts the program files back as they were before the pending update (the copy kept in <data>\update\backup): the
 * files the update added are removed, the kept ones are copied back. Used when putting the new files in place fails,
 * and by the launcher when the new version does not start.
 * @returns {{ restored: number, removed: number }}
 */
export function restoreBackup(appDir, dataDir, pending = readPending(dataDir)) {
  const backup = backupDirOf(dataDir);
  const kept = listFiles(backup);
  if (!kept.length) throw new Error('the copy of the program kept before the update is missing');
  let removed = 0;
  for (const rel of Array.isArray(pending?.added) ? pending.added : []) {
    if (typeof rel !== 'string' || rel.includes('..') || rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) continue;
    if (!MANAGED_DIRS.some((d) => rel.startsWith(`${d}/`)) && rel.includes('/')) continue;
    try {
      fs.unlinkSync(path.join(appDir, ...rel.split('/')));
      removed++;
      removeEmptyDirs(appDir, rel);
    } catch { /* it was not written */ }
  }
  let restored = 0;
  for (const rel of kept) {
    const data = fs.readFileSync(path.join(backup, ...rel.split('/')));
    const target = path.join(appDir, ...rel.split('/'));
    let same = false;
    try {
      same = fs.readFileSync(target).equals(data);
    } catch { /* it is gone */ }
    if (same) continue;
    writeFileIn(appDir, rel, data);
    restored++;
  }
  return { restored, removed };
}

/**
 * The launcher's part when the new version did not start: the kept copy is put back and a note is left for the panel
 * ("the update to 9.29.0 did not start, Split Relay went back to 9.28.0").
 * @returns {{ from: string, to: string }|null} null when there was nothing to take back
 */
export function rollBack(appDir, dataDir, why, now = Date.now()) {
  const pending = readPending(dataDir);
  if (!pending) return null;
  restoreBackup(appDir, dataDir, pending);
  fs.mkdirSync(updateDir(dataDir), { recursive: true });
  fs.writeFileSync(rolledBackFile(dataDir), `${JSON.stringify({ from: pending.from, to: pending.to, at: now, why: String(why ?? '') }, null, 2)}\n`);
  fs.rmSync(pendingFile(dataDir), { force: true });
  return { from: pending.from, to: pending.to };
}

// ---- the updater ---------------------------------------------------------------------------------------------------

/**
 * @typedef {{ current: string, repo: string, releasesUrl: string, state: 'idle'|'checking'|'installing'|'restart-needed'|'restarting',
 *   checkedAt: number|null, error: string|null, available: boolean,
 *   latest: { version: string, name: string, notes: string, publishedAt: number|null, pageUrl: string|null }|null,
 *   canInstall: boolean, cannotWhy: string|null, restartsItself: boolean,
 *   installed: { from: string, to: string, at: number }|null, rolledBack: { from: string, to: string, at: number, why: string }|null }} UpdateStatus
 */

export class Updater {
  #appDir;
  #dataDir;
  #version;
  #repo;
  #api;
  #fetch;
  #log;
  #now;
  #restartsItself;
  #state = 'idle';
  #checkedAt = null;
  #error = null;
  #latest = null;
  #checking = null;
  #onChange;
  /** the notes kept in <data>/update: the update this version came with, and one that was taken back */
  #installed = null;
  #rolledBack = null;

  /**
   * @param {{ appDir: string, dataDir: string, version: string, repo?: string, apiBase?: string, fetchImpl?: typeof fetch,
   *   log?: (line: string) => void, now?: () => number, restartsItself?: boolean, onChange?: () => void }} opts
   *   apiBase: GitHub's API, or a stand-in for it in a test. restartsItself: Split Relay was started by its launcher,
   *   which starts it again after an update.
   */
  constructor({ appDir, dataDir, version, repo = UPDATE_REPO, apiBase = GITHUB_API, fetchImpl = globalThis.fetch, log = () => {}, now = Date.now,
    restartsItself = false, onChange = () => {} }) {
    this.#appDir = path.resolve(appDir);
    this.#dataDir = path.resolve(dataDir);
    this.#version = String(version ?? '');
    this.#repo = repo;
    this.#api = String(apiBase).replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#log = log;
    this.#now = now;
    this.#restartsItself = restartsItself;
    this.#onChange = onChange;
    this.#installed = readJson(installedFile(this.#dataDir));
    this.#rolledBack = readJson(rolledBackFile(this.#dataDir));
  }

  /** A copy that is a git checkout is updated with git: files put over it would look like local changes to git. */
  get #isCheckout() {
    return fs.existsSync(path.join(this.#appDir, '.git'));
  }

  /** @returns {UpdateStatus} */
  status() {
    const latest = this.#latest;
    const available = !!latest && compareVersions(latest.version, this.#version) > 0;
    let cannotWhy = null;
    if (available) {
      if (this.#isCheckout) cannotWhy = 'This copy of Split Relay is a development copy (its folder has a .git folder): it is updated with git, not from here.';
      else if (!latest.zip) cannotWhy = 'This release has no download Split Relay can install. Get it from the releases page.';
    }
    const installed = this.#installed;
    const rolled = this.#rolledBack;
    return {
      current: this.#version, repo: this.#repo, releasesUrl: `https://github.com/${this.#repo}/releases`,
      state: this.#state, checkedAt: this.#checkedAt, error: this.#error, available,
      latest: latest ? { version: latest.version, name: latest.name, notes: latest.notes, publishedAt: latest.publishedAt, pageUrl: latest.pageUrl } : null,
      canInstall: available && !cannotWhy, cannotWhy, restartsItself: this.#restartsItself,
      installed: installed && compareVersions(installed.to, this.#version) === 0 ? { from: String(installed.from), to: String(installed.to), at: Number(installed.at) || 0 } : null,
      rolledBack: rolled ? { from: String(rolled.from), to: String(rolled.to), at: Number(rolled.at) || 0, why: String(rolled.why ?? '') } : null,
    };
  }

  /**
   * Once Split Relay is up: an update that was waiting for its first start is marked as installed (the launcher then
   * no longer takes it back).
   */
  confirmStarted() {
    const pending = readPending(this.#dataDir);
    if (!pending) return null;
    try {
      if (compareVersions(pending.to, this.#version) === 0) {
        fs.writeFileSync(installedFile(this.#dataDir), `${JSON.stringify({ from: pending.from, to: pending.to, at: this.#now() }, null, 2)}\n`);
        fs.rmSync(rolledBackFile(this.#dataDir), { force: true });
        this.#installed = readJson(installedFile(this.#dataDir));
        this.#rolledBack = null;
        this.#log(`[update] Split Relay ${pending.to} started: the update from ${pending.from} is in place`);
      }
      fs.rmSync(pendingFile(this.#dataDir), { force: true });
    } catch (err) {
      this.#log(`[update] could not note the update as installed: ${err?.message ?? err}`);
    }
    return pending;
  }

  /** "Hide" on the note that an update was taken back. */
  dismissRolledBack() {
    fs.rmSync(rolledBackFile(this.#dataDir), { force: true });
    this.#rolledBack = null;
    this.#onChange();
  }

  async #get(url, { accept, timeout }) {
    let res;
    try {
      res = await this.#fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout),
        headers: { Accept: accept, 'User-Agent': `SplitRelay/${this.#version || '0'}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (err) {
      const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new UpdateError(slow ? 'GitHub did not answer in time. Split Relay runs as it is; check again when this PC has internet.'
        : 'Could not reach GitHub (no internet on this PC?). Split Relay runs as it is; check again when it has internet.', 503);
    }
    return res;
  }

  /**
   * Asks GitHub for the newest release. Never throws: what went wrong is in status().error, in words. One check at a
   * time: a second call while one runs waits for the same answer.
   * @returns {Promise<UpdateStatus>}
   */
  check() {
    if (this.#checking) return this.#checking;
    if (this.#state !== 'idle') return Promise.resolve(this.status());
    this.#state = 'checking';
    this.#onChange();
    this.#checking = (async () => {
      try {
        const res = await this.#get(`${this.#api}/repos/${this.#repo}/releases/latest`, { accept: 'application/vnd.github+json', timeout: CHECK_TIMEOUT_MS });
        if (res.status === 404) {
          // no release has been published (or the repository is not there): nothing newer
          this.#latest = null;
        } else if (res.status === 403 || res.status === 429) {
          throw new UpdateError('GitHub is not answering update checks from this network right now (too many in the last hour). Check again later.', 503);
        } else if (!res.ok) {
          throw new UpdateError(`GitHub answered the update check with an error (${res.status}). Check again later.`, 502);
        } else {
          let json = null;
          try {
            json = await res.json();
          } catch { /* not JSON */ }
          const rel = releaseOf(json);
          if (!rel) throw new UpdateError('GitHub\'s answer to the update check could not be read. Check again later.', 502);
          this.#latest = rel;
        }
        this.#error = null;
        this.#checkedAt = this.#now();
        const s = this.status();
        this.#log(s.available ? `[update] Split Relay ${s.latest.version} is available (this copy is ${s.current})`
          : `[update] checked: this copy (${s.current}) is the newest${s.latest ? '' : ' (no release is published yet)'}`);
      } catch (err) {
        this.#error = err instanceof UpdateError ? err.message : `The update check failed: ${err?.message ?? err}`;
        this.#checkedAt = this.#now();
        this.#log(`[update] ${this.#error}`);
      } finally {
        this.#state = 'idle';
        this.#checking = null;
        this.#onChange();
      }
      return this.status();
    })();
    return this.#checking;
  }

  async #download(zip) {
    const res = await this.#get(zip.url, { accept: 'application/octet-stream', timeout: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok) throw new UpdateError(`The download of the update failed (GitHub answered ${res.status}). Try again in a moment.`, 502);
    // only GitHub's own servers (a stand-in for them in a test is on the API's own address)
    if (this.#api === GITHUB_API) {
      let host = '';
      try {
        const u = new URL(res.url);
        host = u.protocol === 'https:' ? u.hostname : '';
      } catch { /* no URL */ }
      if (!(host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com'))) {
        throw new UpdateError('The download of the update did not come from GitHub, so it was not used.', 502);
      }
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_DOWNLOAD) throw new UpdateError('The download is far larger than a Split Relay release, so it was not used.', 502);
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch {
      throw new UpdateError('The download of the update was cut off. Try again in a moment.', 503);
    }
    if (buf.length > MAX_DOWNLOAD) throw new UpdateError('The download is far larger than a Split Relay release, so it was not used.', 502);
    if (zip.size !== null && buf.length !== zip.size) throw new UpdateError('The download of the update is not complete. Try again in a moment.', 503);
    if (zip.sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== zip.sha256) {
      throw new UpdateError('The download does not match the check GitHub publishes for it, so it was not used. Try again in a moment.', 502);
    }
    return buf;
  }

  /**
   * Downloads the newest release, checks it, keeps a copy of the program files as they are and puts the new ones in
   * their place. Split Relay then has to start again: the caller stops it with RESTART_CODE when the launcher runs it.
   * Throws UpdateError in words; when putting the files in place fails, the kept copy is put back first.
   * @returns {Promise<{ from: string, to: string, changed: number, removed: number }>}
   */
  async install() {
    if (this.#state !== 'idle') throw new UpdateError(this.#state === 'checking' ? 'The update check is still running. Try again in a moment.' : 'An update is being installed already.');
    const s = this.status();
    if (!s.available) throw new UpdateError('There is no newer version to install.');
    if (!s.canInstall) throw new UpdateError(s.cannotWhy);
    const rel = this.#latest;
    this.#state = 'installing';
    this.#onChange();
    try {
      this.#log(`[update] installing Split Relay ${rel.version} over ${this.#version}: downloading ${rel.zip.name}`);
      const buf = await this.#download(rel.zip);
      let files;
      try {
        files = stripTopFolder(readZip(buf));
      } catch (err) {
        throw new UpdateError(`${err?.code === 'ZIP' ? err.message : `The download could not be unpacked: ${err?.message ?? err}`} Nothing was changed.`, 502);
      }
      const problem = releaseProblem(files, rel.version);
      if (problem) throw new UpdateError(`${problem} Nothing was changed.`, 502);

      // the new files next to the data first, and every program file of theirs checked by Node itself
      const dir = updateDir(this.#dataDir);
      const staging = path.join(dir, 'staging');
      fs.rmSync(staging, { recursive: true, force: true });
      for (const f of files) writeFileIn(staging, f.name, f.data);
      for (const f of files) {
        if (!/^src\/[^/]+\.js$/.test(f.name)) continue;
        const r = spawnSync(process.execPath, ['--check', path.join(staging, ...f.name.split('/'))], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        if (r.status !== 0) throw new UpdateError(`The new version's ${f.name} does not pass Node's check, so it was not installed. Nothing was changed.`, 502);
      }

      // a copy of the program as it is now: the managed folders and the files next to them that the release replaces
      const backup = backupDirOf(this.#dataDir);
      fs.rmSync(backup, { recursive: true, force: true });
      const next = new Set(files.map((f) => f.name));
      const mine = [...MANAGED_DIRS.flatMap((d) => listFiles(this.#appDir, d)), ...files.filter((f) => !f.name.includes('/')).map((f) => f.name)]
        .filter((rel2, i, all) => all.indexOf(rel2) === i && fs.existsSync(path.join(this.#appDir, ...rel2.split('/'))));
      for (const rel2 of mine) writeFileIn(backup, rel2, fs.readFileSync(path.join(this.#appDir, ...rel2.split('/'))));
      const have = new Set(mine);
      const added = files.map((f) => f.name).filter((n) => !have.has(n));
      const gone = mine.filter((n) => n.includes('/') && !next.has(n));
      const pending = { from: this.#version, to: rel.version, at: this.#now(), added };
      fs.writeFileSync(pendingFile(this.#dataDir), `${JSON.stringify(pending, null, 2)}\n`);

      let changed = 0;
      try {
        for (const f of files) {
          const target = path.join(this.#appDir, ...f.name.split('/'));
          let same = false;
          try {
            same = fs.readFileSync(target).equals(f.data);
          } catch { /* new */ }
          if (same) continue;
          writeFileIn(this.#appDir, f.name, f.data);
          changed++;
        }
        for (const rel2 of gone) {
          fs.rmSync(path.join(this.#appDir, ...rel2.split('/')), { force: true });
          removeEmptyDirs(this.#appDir, rel2);
        }
      } catch (err) {
        let back = 'The program files were put back as they were.';
        try {
          restoreBackup(this.#appDir, this.#dataDir, pending);
          fs.rmSync(pendingFile(this.#dataDir), { force: true });
        } catch (err2) {
          back = `Putting the old files back failed too (${err2?.message ?? err2}): copy the folder ${backup} over the Split Relay folder by hand.`;
        }
        throw new UpdateError(`The new files could not be put in place (${err?.message ?? err}). ${back}`, 500);
      }
      fs.rmSync(staging, { recursive: true, force: true });
      this.#log(`[update] Split Relay ${rel.version} is in place (${changed} files changed, ${gone.length} removed); the files of ${this.#version} are kept in ${backup}`);
      this.#state = this.#restartsItself ? 'restarting' : 'restart-needed';
      return { from: this.#version, to: rel.version, changed, removed: gone.length };
    } catch (err) {
      this.#state = 'idle';
      this.#log(`[update] not installed: ${err?.message ?? err}`);
      throw err instanceof UpdateError ? err : new UpdateError(`The update could not be installed: ${err?.message ?? err}`, 500);
    } finally {
      this.#onChange();
    }
  }
}
