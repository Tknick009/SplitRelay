// DESIGN 9.28: updates from GitHub. The zip reader, the release rules, the updater against a stand-in for GitHub (a
// fetch of our own, folders in the temp folder), the launcher's decisions, and the panel's routes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readZip, crc32, safeEntryName, ZipError } from '../src/zip.js';
import {
  Updater, UpdateError, parseVersion, compareVersions, nodeIsEnough, releaseOf, stripTopFolder, releaseProblem, readPending, rollBack,
  RESTART_CODE,
} from '../src/update.js';
import { nextStep, dataDirOf } from '../src/launcher.js';
import { startApp } from '../src/main.js';

/** A zip file of our own making: [name, text|Buffer, { store?, crc?, flags? }] per entry; a name ending in "/" is a folder. */
function makeZip(entries, { comment = '' } = {}) {
  const locals = [];
  const central = [];
  let at = 0;
  for (const [name, content = '', opts = {}] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const store = opts.store === true || name.endsWith('/');
    const body = store ? data : zlib.deflateRawSync(data);
    const crc = opts.crc ?? crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(opts.flags ?? 0, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(opts.flags ?? 0, 8);
    cd.writeUInt16LE(store ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(at, 42);
    locals.push(local, nameBuf, body);
    central.push(cd, nameBuf);
    at += 30 + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(central);
  const commentBuf = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  end.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, dir, end, commentBuf]);
}

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sr-update-${name}-`));
const put = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const get = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
};

/** The files of a Split Relay release of a version, small but complete by releaseProblem's rules. */
const releaseFiles = (version, extra = []) => [
  ['package.json', JSON.stringify({ name: 'split-relay', version, engines: { node: '>=18.17' } })],
  ['start.bat', '@echo off\r\nrem start\r\n'],
  ['README.md', `Split Relay ${version}\n`],
  ['src/main.js', `export const V = '${version}';\n`],
  ['src/launcher.js', '// launcher\n'],
  ['src/update.js', '// update\n'],
  ['public/index.html', `<title>${version}</title>\n`],
  ['public/app.js', `export const V = '${version}';\n`],
  ...extra,
];

/** A stand-in for GitHub: the newest release and its zip, served to the Updater's fetch. */
function fakeGitHub({ version, zip, notes = 'What changed.', status = 200, digest = true, fail = null }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (fail) throw fail;
    if (String(url).endsWith('/releases/latest')) {
      if (status !== 200) return new Response('{}', { status });
      return Response.json({ tag_name: `v${version}`, name: `Split Relay ${version}`, body: notes, published_at: '2026-11-23T20:00:00Z',
        html_url: `https://github.com/Tknick009/SplitRelay/releases/tag/v${version}`,
        assets: [{ name: `SplitRelay-${version}.zip`, browser_download_url: `http://github.test/dl/SplitRelay-${version}.zip`, size: zip.length,
          ...(digest ? { digest: `sha256:${typeof digest === 'string' ? digest : crypto.createHash('sha256').update(zip).digest('hex')}` } : {}) }] });
    }
    return new Response(zip, { status: 200, headers: { 'content-length': String(zip.length) } });
  };
  return { fetchImpl, calls };
}

/** A program folder as version 9.27.0 was, with a data folder inside it, and an Updater on it. */
function installed(gh, { version = '9.27.0', git = false } = {}) {
  const appDir = tmp('app');
  for (const [name, text] of releaseFiles(version, [['src/old-only.js', '// only in the old version\n'], ['test/a.test.js', '// old test\n']])) put(appDir, name, text);
  const dataDir = path.join(appDir, 'data');
  put(dataDir, 'config.json', '{"mine":true}');
  put(dataDir, 'reads.jsonl', '{"t":"read"}\n');
  if (git) fs.mkdirSync(path.join(appDir, '.git'));
  const lines = [];
  const make = (v = version, opts = {}) => new Updater({ appDir, dataDir, version: v, apiBase: 'http://github.test', fetchImpl: gh.fetchImpl, log: (l) => lines.push(l), ...opts });
  return { appDir, dataDir, lines, make, updater: make() };
}

describe('the zip reader', () => {
  test('reads stored and deflated files, skips folders, and takes a comment at the end', () => {
    const big = 'line of text\n'.repeat(5000);
    const zip = makeZip([['src/', ''], ['src/a.js', 'export const a = 1;\n'], ['public/b.txt', big], ['c.bin', Buffer.from([0, 1, 2, 255]), { store: true }]], { comment: '61f4c1b48e2f' });
    const files = readZip(zip);
    assert.deepEqual(files.map((f) => f.name), ['src/a.js', 'public/b.txt', 'c.bin']);
    assert.equal(files[0].data.toString(), 'export const a = 1;\n');
    assert.equal(files[1].data.toString(), big);
    assert.deepEqual([...files[2].data], [0, 1, 2, 255]);
  });

  test('a damaged, cut or unsuitable file is refused in words', () => {
    const zip = makeZip([['a.txt', 'hello hello hello hello']]);
    assert.throws(() => readZip(Buffer.from('not a zip at all, just some text')), ZipError);
    assert.throws(() => readZip(zip.subarray(0, zip.length - 5)), /not a zip file, or it was cut short/);
    assert.throws(() => readZip(makeZip([['a.txt', 'hello', { crc: 12345 }]])), /fails its check/);
    assert.throws(() => readZip(makeZip([['a.txt', 'hello', { flags: 1 }]])), /encrypted/);
    assert.throws(() => readZip(makeZip([['a.txt', 'one'], ['A.TXT', 'two']])), /twice/);
    const flipped = Buffer.from(zip);
    flipped[35] ^= 0xff; // inside the packed bytes
    assert.throws(() => readZip(flipped), ZipError);
  });

  test('a name that would leave the folder is never unpacked', () => {
    for (const bad of ['../evil.js', 'src/../../evil.js', '/abs.js', 'C:/abs.js', 'src\\evil.js', 'src//x.js', 'con.txt', 'src/aux', 'a./b', 'x\u0001y']) {
      assert.equal(safeEntryName(bad), null, bad);
      assert.throws(() => readZip(makeZip([[bad, 'x']])), /not safe to unpack/, bad);
    }
    assert.equal(safeEntryName('src/engine.js'), 'src/engine.js');
    assert.equal(safeEntryName('public/icons/'), 'public/icons');
    assert.equal(safeEntryName('.gitignore'), '.gitignore');
  });
});

describe('versions and releases', () => {
  test('versions compare by their numbers', () => {
    assert.deepEqual(parseVersion('v9.28.0'), [9, 28, 0]);
    assert.equal(parseVersion('9.28'), null);
    assert.equal(parseVersion('latest'), null);
    assert.ok(compareVersions('9.28.0', '9.27.9') > 0);
    assert.ok(compareVersions('9.9.0', '9.10.0') < 0);
    assert.equal(compareVersions('v9.28.0', '9.28.0'), 0);
    assert.ok(compareVersions('', '0.1.0') < 0, 'a copy with no readable version is older than any release');
  });

  test('the Node.js a release needs is compared with this PC\'s', () => {
    assert.equal(nodeIsEnough('>=18.17', '18.17.0'), true);
    assert.equal(nodeIsEnough('>=18.17', '18.16.1'), false);
    assert.equal(nodeIsEnough('>=22', '20.11.0'), false);
    assert.equal(nodeIsEnough('>=18.17', '22.20.0'), true);
    assert.equal(nodeIsEnough(undefined, '18.0.0'), true);
  });

  test('a release is read from GitHub\'s answer: its own zip first, GitHub\'s source zip else', () => {
    const base = { tag_name: 'v9.28.0', name: 'Split Relay 9.28.0', body: 'Notes\r\nmore', published_at: '2026-11-23T20:00:00Z', html_url: 'https://github.com/Tknick009/SplitRelay/releases/tag/v9.28.0',
      zipball_url: 'https://api.github.com/repos/Tknick009/SplitRelay/zipball/v9.28.0' };
    const sha = 'a'.repeat(64);
    const r = releaseOf({ ...base, assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/x' },
      { name: 'SplitRelay-9.28.0.zip', browser_download_url: 'https://github.com/dl.zip', size: 1234, digest: `sha256:${sha}` }] });
    assert.equal(r.version, '9.28.0');
    assert.equal(r.notes, 'Notes\nmore');
    assert.deepEqual(r.zip, { url: 'https://github.com/dl.zip', name: 'SplitRelay-9.28.0.zip', size: 1234, sha256: sha });
    assert.equal(releaseOf({ ...base, assets: [] }).zip.url, base.zipball_url);
    assert.equal(releaseOf({ ...base, draft: true }), null);
    assert.equal(releaseOf({ ...base, prerelease: true }), null);
    assert.equal(releaseOf({ ...base, tag_name: 'nightly' }), null);
    assert.equal(releaseOf({ ...base, html_url: 'https://elsewhere.example/x' }).pageUrl, null);
    assert.equal(releaseOf(null), null);
  });

  test('GitHub\'s source zip has one top folder: the files are taken without it', () => {
    const files = [{ name: 'Tknick009-SplitRelay-abc123/package.json', data: Buffer.from('{}') }, { name: 'Tknick009-SplitRelay-abc123/src/main.js', data: Buffer.from('x') }];
    assert.deepEqual(stripTopFolder(files).map((f) => f.name), ['package.json', 'src/main.js']);
    const flat = [{ name: 'package.json', data: Buffer.from('{}') }, { name: 'src/main.js', data: Buffer.from('x') }];
    assert.equal(stripTopFolder(flat), flat);
  });

  test('only a complete Split Relay of the version asked for, that this PC can run, is a release', () => {
    const files = (v, extra = []) => releaseFiles(v, extra).map(([name, text]) => ({ name, data: Buffer.from(text) }));
    assert.equal(releaseProblem(files('9.28.0'), '9.28.0'), null);
    assert.match(releaseProblem(files('9.28.0').filter((f) => f.name !== 'src/launcher.js'), '9.28.0'), /no src\/launcher\.js/);
    assert.match(releaseProblem(files('9.29.0'), '9.28.0'), /says it is version 9\.29\.0, not 9\.28\.0/);
    assert.match(releaseProblem(files('9.28.0', [['data/config.json', '{}']]), '9.28.0'), /never does/);
    assert.match(releaseProblem(files('9.28.0'), '9.28.0', '18.2.0'), /needs Node\.js 18\.17 or newer, and this PC has 18\.2\.0/);
    const other = files('9.28.0').map((f) => (f.name === 'package.json' ? { name: f.name, data: Buffer.from('{"name":"something-else","version":"9.28.0"}') } : f));
    assert.equal(releaseProblem(other, '9.28.0'), 'The download is not Split Relay.');
  });
});

describe('the updater', () => {
  test('a newer release on GitHub is found; nothing is asked of GitHub but the release', async () => {
    const gh = fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.28.0')), notes: 'Swapped bibs.' });
    const { updater, lines } = installed(gh);
    assert.equal(updater.status().available, false);
    assert.equal(updater.status().checkedAt, null);
    const s = await updater.check();
    assert.equal(s.available, true);
    assert.equal(s.canInstall, true);
    assert.equal(s.current, '9.27.0');
    assert.deepEqual([s.latest.version, s.latest.notes, s.latest.pageUrl], ['9.28.0', 'Swapped bibs.', 'https://github.com/Tknick009/SplitRelay/releases/tag/v9.28.0']);
    assert.equal(s.error, null);
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0].url, 'http://github.test/repos/Tknick009/SplitRelay/releases/latest');
    assert.equal(gh.calls[0].headers['User-Agent'], 'SplitRelay/9.27.0', 'nothing about the PC or its user goes to GitHub');
    assert.match(lines.at(-1), /9\.28\.0 is available \(this copy is 9\.27\.0\)/);
  });

  test('the same or an older release is not an update; no release at all is not an error', async () => {
    const same = installed(fakeGitHub({ version: '9.27.0', zip: Buffer.alloc(0) }));
    const s = await same.updater.check();
    assert.deepEqual([s.available, s.error, s.latest.version], [false, null, '9.27.0']);
    await assert.rejects(same.updater.install(), /no newer version/);
    const none = installed(fakeGitHub({ version: '9.28.0', zip: Buffer.alloc(0), status: 404 }));
    const n = await none.updater.check();
    assert.deepEqual([n.available, n.error, n.latest], [false, null, null]);
  });

  test('no internet, a slow answer, too many checks: said in words, and Split Relay goes on', async () => {
    const off = installed(fakeGitHub({ version: '9.28.0', zip: Buffer.alloc(0), fail: new TypeError('fetch failed') }));
    assert.match((await off.updater.check()).error, /Could not reach GitHub \(no internet on this PC\?\)/);
    const slow = installed(fakeGitHub({ version: '9.28.0', zip: Buffer.alloc(0), fail: Object.assign(new Error('t'), { name: 'TimeoutError' }) }));
    assert.match((await slow.updater.check()).error, /did not answer in time/);
    const limited = installed(fakeGitHub({ version: '9.28.0', zip: Buffer.alloc(0), status: 403 }));
    assert.match((await limited.updater.check()).error, /too many in the last hour/);
    assert.equal(off.updater.status().available, false);
    assert.equal(off.updater.status().state, 'idle');
  });

  test('Install update: the new files are in place, the old ones are kept, the data folder is untouched', async () => {
    const zip = makeZip(releaseFiles('9.28.0', [['src/new-only.js', '// new in 9.28\n'], ['public/icons/new.svg', '<svg/>']]));
    const gh = fakeGitHub({ version: '9.28.0', zip });
    const { appDir, dataDir, updater, make } = installed(gh);
    await updater.check();
    const done = await updater.install();
    assert.deepEqual([done.from, done.to], ['9.27.0', '9.28.0']);
    assert.equal(get(appDir, 'src/main.js'), "export const V = '9.28.0';\n");
    assert.equal(JSON.parse(get(appDir, 'package.json')).version, '9.28.0');
    assert.equal(get(appDir, 'src/new-only.js'), '// new in 9.28\n');
    assert.equal(get(appDir, 'public/icons/new.svg'), '<svg/>');
    assert.equal(get(appDir, 'src/old-only.js'), null, 'a program file the new version no longer has is removed');
    assert.equal(get(appDir, 'test/a.test.js'), null);
    assert.equal(get(appDir, 'start.bat'), '@echo off\r\nrem start\r\n');
    assert.equal(get(dataDir, 'config.json'), '{"mine":true}');
    assert.equal(get(dataDir, 'reads.jsonl'), '{"t":"read"}\n');
    assert.equal(get(dataDir, 'update/backup/src/main.js'), "export const V = '9.27.0';\n");
    assert.equal(get(dataDir, 'update/backup/src/old-only.js'), '// only in the old version\n');
    assert.equal(fs.existsSync(path.join(dataDir, 'update', 'staging')), false);
    assert.deepEqual(readPending(dataDir).added.sort(), ['public/icons/new.svg', 'src/new-only.js']);
    assert.equal(updater.status().state, 'restart-needed', 'started without the launcher: it says to start Split Relay again');
    assert.equal(done.changed, 7, 'files that are the same (start.bat, the launcher, update.js) are not written again');

    // the new version comes up: the update is in for good
    const next = make('9.28.0');
    next.confirmStarted();
    assert.equal(readPending(dataDir), null);
    assert.deepEqual([next.status().installed.from, next.status().installed.to], ['9.27.0', '9.28.0']);
    assert.equal(rollBack(appDir, dataDir, 'late'), null, 'nothing is taken back once the new version has started');
  });

  test('with the launcher, Split Relay says it starts again by itself', async () => {
    const gh = fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.28.0')) });
    const { make } = installed(gh);
    const u = make('9.27.0', { restartsItself: true });
    await u.check();
    await u.install();
    assert.equal(u.status().state, 'restarting');
    assert.equal(RESTART_CODE, 75);
  });

  test('the new version does not start: the launcher puts the old files back, and the panel says so', async () => {
    const gh = fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.28.0', [['src/new-only.js', '// new\n']])) });
    const { appDir, dataDir, updater, make } = installed(gh);
    await updater.check();
    await updater.install();
    assert.deepEqual(rollBack(appDir, dataDir, 'it stopped with code 1 before it was up', 1795460000000), { from: '9.27.0', to: '9.28.0' });
    assert.equal(get(appDir, 'src/main.js'), "export const V = '9.27.0';\n");
    assert.equal(JSON.parse(get(appDir, 'package.json')).version, '9.27.0');
    assert.equal(get(appDir, 'src/old-only.js'), '// only in the old version\n');
    assert.equal(get(appDir, 'test/a.test.js'), '// old test\n');
    assert.equal(get(appDir, 'src/new-only.js'), null, 'what the update added is gone again');
    assert.equal(get(dataDir, 'config.json'), '{"mine":true}');
    assert.equal(readPending(dataDir), null);
    const old = make('9.27.0');
    old.confirmStarted();
    assert.deepEqual(old.status().rolledBack, { from: '9.27.0', to: '9.28.0', at: 1795460000000, why: 'it stopped with code 1 before it was up' });
    old.dismissRolledBack();
    assert.equal(old.status().rolledBack, null);
    assert.equal(make('9.27.0').status().rolledBack, null);
  });

  test('a download that is not what GitHub published, or not a Split Relay, changes nothing', async () => {
    const good = makeZip(releaseFiles('9.28.0'));
    const cases = [
      [fakeGitHub({ version: '9.28.0', zip: good, digest: 'b'.repeat(64) }), /does not match the check GitHub publishes/],
      [fakeGitHub({ version: '9.28.0', zip: Buffer.from('<html>Sign in to the venue wifi</html>'), digest: false }), /not a zip file/],
      [fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.29.0')), digest: false }), /says it is version 9\.29\.0/],
      [fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.28.0').filter(([n]) => n !== 'public/app.js')), digest: false }), /no public\/app\.js/],
      [fakeGitHub({ version: '9.28.0', zip: makeZip([...releaseFiles('9.28.0').filter(([n]) => n !== 'src/main.js'), ['src/main.js', 'this is not (javascript']]), digest: false }), /does not pass Node's check/],
    ];
    for (const [gh, words] of cases) {
      const { appDir, dataDir, updater } = installed(gh);
      await updater.check();
      await assert.rejects(updater.install(), (err) => err instanceof UpdateError && words.test(err.message) && /Nothing was changed|Try again/.test(err.message), String(words));
      assert.equal(get(appDir, 'src/main.js'), "export const V = '9.27.0';\n");
      assert.equal(get(appDir, 'src/old-only.js'), '// only in the old version\n');
      assert.equal(readPending(dataDir), null);
      assert.equal(updater.status().state, 'idle');
    }
  });

  test('a development copy (a git checkout) is told about the update, and is not changed from here', async () => {
    const gh = fakeGitHub({ version: '9.28.0', zip: makeZip(releaseFiles('9.28.0')) });
    const { appDir, updater } = installed(gh, { git: true });
    const s = await updater.check();
    assert.equal(s.available, true);
    assert.equal(s.canInstall, false);
    assert.match(s.cannotWhy, /development copy .* updated with git/);
    await assert.rejects(updater.install(), /development copy/);
    assert.equal(get(appDir, 'src/main.js'), "export const V = '9.27.0';\n");
  });
});

describe('the launcher', () => {
  test('it starts Split Relay again after an update, takes back one that does not start, and else stops with it', () => {
    assert.equal(nextStep(75, true, 0), 'restart');
    assert.equal(nextStep(75, false, 0), 'restart');
    assert.equal(nextStep(1, true, 0), 'rollback');
    assert.equal(nextStep(null, true, 1), 'rollback', 'killed before it was up');
    assert.equal(nextStep(0, true, 0), 'exit', 'stopped by the operator (Ctrl+C) before it was up: nothing is taken back');
    assert.equal(nextStep(1, false, 0), 'exit');
    assert.equal(nextStep(0, false, 0), 'exit');
    assert.equal(nextStep(75, true, 4), 'exit', 'never a loop of restarts');
  });

  test('it finds the data folder the options name, as Split Relay does', () => {
    const app = path.resolve('some', 'folder');
    assert.equal(dataDirOf([], app), path.join(app, 'data'));
    assert.equal(dataDirOf(['--no-open', '--data', 'D:\\SR'], app), path.resolve('D:\\SR'));
    assert.equal(dataDirOf(['--data=other'], app), path.resolve('other'));
    assert.equal(dataDirOf(['--port', '5591'], app), path.join(app, 'data'));
  });
});

describe('the panel\'s routes', () => {
  const call = async (port, method, url) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { Origin: `http://127.0.0.1:${port}` } });
    return { status: res.status, json: await res.json() };
  };

  test('the state carries the version and the check; Check and Install work through the panel; a running race refuses Install', async () => {
    // (a version far above this copy's own, whatever package.json says)
    const gh = fakeGitHub({ version: '99.0.0', zip: makeZip(releaseFiles('99.0.0')) });
    const appDir = tmp('panel-app');
    for (const [name, text] of releaseFiles('0.0.1')) put(appDir, name, text);
    const dataDir = tmp('panel-data');
    const app = await startApp({ dataDir, panelPort: 0, inputPort: 0, quiet: true, update: { appDir, apiBase: 'http://github.test', fetchImpl: gh.fetchImpl } });
    try {
      const port = app.panelPort;
      let r = await call(port, 'GET', '/api/state');
      assert.equal(typeof r.json.app.version, 'string');
      assert.equal(r.json.update.available, false);
      assert.equal(r.json.update.checkedAt, null, 'a test, or any use of Split Relay as a module, never calls GitHub by itself');
      assert.equal(gh.calls.length, 0);
      r = await call(port, 'POST', '/api/update/check');
      assert.equal(r.status, 200);
      assert.equal(r.json.update.available, true);
      assert.equal(r.json.update.latest.version, '99.0.0');
      assert.equal(r.json.update.blocked, null);

      // a race with a gun typed a moment ago is running: Install waits
      const now = new Date();
      const gun = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.000`;
      const added = await fetch(`http://127.0.0.1:${port}/api/races`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
        body: JSON.stringify({ name: 'Open', splits: [{ name: '1K' }] }) });
      const st = await added.json();
      const race = st.config.races.find((x) => x.name === 'Open');
      assert.ok(race, JSON.stringify(st).slice(0, 300));
      const g = await fetch(`http://127.0.0.1:${port}/api/races/${race.id}/gun`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ gun }) });
      assert.equal(g.status, 200);
      r = await call(port, 'POST', '/api/update/install');
      assert.equal(r.status, 409);
      assert.match(r.json.error, /Open is running\. Installing restarts Split Relay/);
      assert.equal(get(appDir, 'src/main.js'), "export const V = '0.0.1';\n");
      assert.match((await call(port, 'GET', '/api/state')).json.update.blocked, /Open is running/);

      // the race is over (its gun cleared): Install goes through
      await fetch(`http://127.0.0.1:${port}/api/races/${race.id}/gun`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ gun: '' }) });
      r = await call(port, 'POST', '/api/update/install');
      assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
      assert.deepEqual([r.json.updateDone.to, r.json.updateDone.restarts], ['99.0.0', false]);
      assert.equal(r.json.update.state, 'restart-needed');
      assert.equal(get(appDir, 'src/main.js'), "export const V = '99.0.0';\n");
      assert.equal(fs.existsSync(path.join(dataDir, 'update', 'pending.json')), true);
    } finally {
      await app.stop();
    }
  });
});
