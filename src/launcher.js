// Split Relay's launcher (DESIGN 9.28): start.bat starts this, and this starts Split Relay itself (src\main.js) in the
// same window, with the same options. It is here for one thing: after "Install update" Split Relay stops with a code
// that says "start me again", and the launcher starts the new version. When that version does not come up, the
// launcher puts back the program files kept before the update and starts the old version, so a bad update never
// leaves a timer without Split Relay.
//
//   node src\launcher.js [--data <folder>] [--port <panel port>] [--no-open]
//
// It stays in memory while the program files change, so it imports only update.js (which imports only zip.js).

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESTART_CODE, readPending, rollBack } from './update.js';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(APP_DIR, 'src', 'main.js');

/** The data folder the options name (as main.js reads them), else "data" next to src. */
export function dataDirOf(argv, appDir = APP_DIR) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data' && argv[i + 1]) return path.resolve(argv[i + 1]);
    if (argv[i].startsWith('--data=') && argv[i].length > 7) return path.resolve(argv[i].slice(7));
  }
  return path.join(appDir, 'data');
}

/**
 * What the launcher does when Split Relay has stopped: 'restart' (an update asked for it), 'rollback' (an update was
 * put in place and the new version stopped with an error before it was up), or 'exit'.
 * @param {number|null} code Split Relay's exit code (null: it was killed)
 * @param {boolean} pending an update is in place that has not come up yet
 * @param {number} restarts how many times Split Relay was started again in the last minute
 */
export function nextStep(code, pending, restarts) {
  if (restarts >= 4) return 'exit';
  if (code === RESTART_CODE) return 'restart';
  if (pending && code !== 0) return 'rollback';
  return 'exit';
}

function run(argv) {
  const dataDir = dataDirOf(argv);
  const starts = [];
  // Ctrl+C reaches Split Relay itself (the same window): it saves and stops, and the launcher follows it
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(sig, () => {});
    } catch { /* that signal does not exist on this OS */ }
  }
  const start = () => {
    const child = spawn(process.execPath, [MAIN, ...argv], { stdio: 'inherit', env: { ...process.env, SPLITRELAY_LAUNCHER: '1' }, windowsHide: false });
    child.on('error', (err) => {
      console.error(`\n  Split Relay could not be started: ${err?.message ?? err}\n`);
      process.exit(1);
    });
    child.on('exit', (code) => {
      const now = Date.now();
      while (starts.length && now - starts[0] > 60000) starts.shift();
      let pending = null;
      try {
        pending = readPending(dataDir);
      } catch { /* no update folder */ }
      const step = nextStep(code, !!pending, starts.length);
      if (step === 'restart') {
        starts.push(now);
        console.log(`\n  Starting Split Relay again${pending ? ` (version ${pending.to})` : ''}…\n`);
        start();
        return;
      }
      if (step === 'rollback') {
        starts.push(now);
        console.error(`\n  Split Relay ${pending.to} did not start (code ${code ?? 'none'}). Putting version ${pending.from} back…`);
        try {
          rollBack(APP_DIR, dataDir, `it stopped with code ${code ?? 'none'} before it was up`);
          console.error(`  Version ${pending.from} is back. Starting it…\n`);
        } catch (err) {
          console.error(`  That failed: ${err?.message ?? err}`);
          console.error(`  Copy the folder ${path.join(dataDir, 'update', 'backup')} over the Split Relay folder by hand, or unpack the Split Relay zip again.\n`);
          process.exit(code ?? 1);
        }
        start();
        return;
      }
      process.exit(code ?? 1);
    });
  };
  start();
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const ran = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === ran.toLowerCase() : me === ran;
}

if (isEntryPoint()) {
  process.title = 'Split Relay';
  run(process.argv.slice(2));
}
