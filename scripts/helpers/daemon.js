'use strict';

// Daemon process lifecycle for the E2E suites.
//
// Why CommonJS `.js` and not `.ts`: nine of the ten suites are committed
// `.js` files that CI runs with plain `node` (no ts-node), so a `.ts`
// helper would be unusable by them. That is why the previous
// `helpers/daemon.ts` was dead code that nothing imported.
//
// What this fixes, in order of blast radius:
//
//  1. Guaranteed teardown. Every suite used to call `daemon.kill('SIGKILL')`
//     on the happy path only, so the first failing assertion left a daemon
//     spinning forever at ~25% CPU, holding the SHM segment and the admin
//     TCP port. That poisoned every later suite in the same runner (the
//     classic symptom was `admin SCAN` answering `OK 0`) and burned CI
//     minutes. `withDaemon()` makes cleanup unconditional.
//  2. Real readiness instead of a blind `sleep(1000)`. The daemon prints a
//     ready marker on stderr; we match it. A slow CI host no longer gets a
//     fixed guess, and a daemon that dies on startup fails loudly with its
//     output instead of silently timing out later.
//  3. `stop()` awaits the real exit, so the SHM segment and the port are
//     provably released before the next suite starts.
//
// Zig's `std.debug.print` writes to stderr, so both pipes are captured.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Readiness markers the daemon prints on stderr (src/server/main.zig). */
const READY = {
  /** SHM mapped, ring buffer live, WAL flusher anchored. */
  server: /Server ready\. Waiting for connections/,
  /** Server ready AND the admin TCP endpoint is bound. */
  admin: /Admin endpoint listening on 127\.0\.0\.1:(\d+)/,
};

const DEFAULT_READY_TIMEOUT_MS = Number(process.env.TAKYON_READY_TIMEOUT_MS || 30000);

/** Single source of truth for the daemon binary path (win32 name swap). */
function daemonBin() {
  const name = process.platform === 'win32' ? 'takyondb.exe' : 'takyondb';
  return path.join(REPO_ROOT, 'zig-out', 'bin', name);
}

/** Spawned daemons this process is responsible for, so we can never leak one. */
const tracked = new Set();

/**
 * Spawn the daemon and resolve once it reports ready.
 *
 * Rejects (after killing the child) if the binary is missing, the process
 * exits before the ready marker, or the marker does not arrive in time.
 */
async function startDaemon(options = {}) {
  const {
    args = [],
    bin = daemonBin(),
    cwd = REPO_ROOT,
    env = process.env,
    readyPattern = READY.server,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options;

  if (!fs.existsSync(bin)) {
    throw new Error(
      `daemon binary not found at ${bin}\n` + `Build it first: zig build -Doptimize=ReleaseSafe (from ${REPO_ROOT})`
    );
  }

  const proc = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { proc, output: '', adminPort: null, stop: null };
  tracked.add(handle);

  let output = '';
  const onChunk = (chunk) => {
    output += chunk.toString();
    handle.output = output;
    const admin = READY.admin.exec(output);
    if (admin) handle.adminPort = Number(admin[1]);
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);

  handle.stop = (signal = 'SIGKILL') => stopDaemon(handle, signal);

  const exited = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    proc.once('error', () => resolve({ code: null, signal: null }));
  });

  const spawnError = new Promise((_, reject) => {
    proc.once('error', (err) => reject(new Error(`failed to spawn daemon: ${err.message}`)));
  });

  const ready = new Promise((resolve) => {
    const check = () => {
      if (readyPattern instanceof RegExp) {
        if (readyPattern.test(output)) {
          resolve();
          return true;
        }
      } else if (output.includes(String(readyPattern))) {
        resolve();
        return true;
      }
      return false;
    };
    if (!check()) {
      proc.stdout.on('data', check);
      proc.stderr.on('data', check);
    }
  });

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `daemon not ready within ${readyTimeoutMs}ms ` +
            `(pattern ${readyPattern})\n--- daemon output ---\n${output.slice(-2000)}`
        )
      );
    }, readyTimeoutMs);
    if (timer.unref) timer.unref();
  });

  try {
    await Promise.race([ready, exited.then(({ code, signal }) => {
      throw new Error(
        `daemon exited before ready (code=${code} signal=${signal})\n` +
          `--- daemon output ---\n${output.slice(-2000)}`
      );
    }), spawnError, timeout]);
  } catch (err) {
    await stopDaemon(handle, 'SIGKILL');
    throw err;
  }

  // Only now release the event loop. The readiness wait above depends on
  // the child's pipes, so unref'ing earlier would leave nothing keeping Node
  // alive and the parent would exit silently mid-await. After this point the
  // caller's own work keeps the loop alive, and a finished bench can exit
  // without hanging on a child nobody reads; the exit safety net reaps the
  // daemon if the parent goes first.
  if (typeof proc.unref === 'function') proc.unref();
  if (proc.stdout && typeof proc.stdout.unref === 'function') proc.stdout.unref();
  if (proc.stderr && typeof proc.stderr.unref === 'function') proc.stderr.unref();

  return handle;
}

/**
 * Kill the daemon and resolve only once it is really gone.
 *
 * Awaiting the exit is the point: the SHM segment and the admin port stay
 * held by the kernel until the process dies, so the next suite would
 * otherwise connect to a dying daemon.
 */
async function stopDaemon(handle, signal = 'SIGKILL') {
  const { proc } = handle;
  if (proc.exitCode !== null || proc.signalCode !== null) {
    tracked.delete(handle);
    return;
  }
  // startDaemon() unref'd the child so a finished bench can exit without
  // hanging on it. That makes awaiting the 'exit' event unsafe: if the child
  // is the only thing holding the event loop open, Node drains the loop and
  // exits while this promise is still pending, silently skipping every
  // cleanup step after it. Re-ref for the duration of the wait, then drop it
  // again.
  if (typeof proc.ref === 'function') proc.ref();
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill(signal);
  } catch {
    // Already gone.
  }
  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, 2000);
  await exited;
  clearTimeout(killer);
  if (typeof proc.unref === 'function') proc.unref();
  tracked.delete(handle);
}

/**
 * Run `fn` with a started daemon and always stop it.
 *
 * Use this instead of manual spawn/kill: the `finally` is what stops a
 * failing assertion from leaking a daemon into the rest of the run.
 */
async function withDaemon(options, fn) {
  const handle = await startDaemon(options);
  try {
    return await fn(handle);
  } finally {
    await stopDaemon(handle);
  }
}

// Safety net: whatever happens (early return, throw, Ctrl-C), no daemon
// this process started may outlive it.
function installExitSafetyNet() {
  const killAll = () => {
    for (const handle of Array.from(tracked)) {
      try {
        handle.proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      killAll();
      process.exit(1);
    });
  }
}
installExitSafetyNet();

/**
 * Live `takyondb` daemons not started by this process.
 *
 * A stray means a previous suite leaked one; such a daemon holds the SHM
 * segment and the admin port and makes later suites report `OK 0`. Used by
 * the runner to turn a silent poison into an explicit failure.
 */
function listStrayDaemons() {
  const out = { platform: os.platform(), pids: [] };
  try {
    if (os.platform() === 'win32') {
      const { execFileSync } = require('child_process');
      const text = execFileSync('tasklist', ['/FI', 'IMAGENAME eq takyondb.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      out.pids = (text.match(/\d+/g) || []).map(Number);
    } else {
      const { execFileSync } = require('child_process');
      const text = execFileSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' });
      out.pids = text
        .split('\n')
        .filter((line) => /takyondb$/.test(line.trim()))
        .map((line) => Number(line.trim().split(/\s+/)[0]))
        .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
    }
  } catch {
    // ps/tasklist unavailable: report nothing rather than failing a suite.
  }
  out.pids = out.pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  return out;
}

/**
 * Resolve once `target` exists and has stopped growing.
 *
 * Replaces blind `sleep(2000)` waits in the crash/catalog suites. A
 * checkpoint and a WAL flush are both asynchronous (queued on the ring,
 * applied by the WAL flusher), so any fixed delay is a guess: too short and
 * the SIGKILL lands mid-write, which surfaced as "bad catalog magic" on a
 * loaded host. Polling the artifact the engine actually produces makes the
 * suite deterministic instead of timing-dependent.
 */
async function waitForFileStable(target, options = {}) {
  const { timeoutMs = 30000, minSize = 1, pollMs = 100, label = 'file' } = options;
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    let size = -1;
    try {
      size = fs.statSync(target).size;
    } catch (e) {
      size = -1; // Not written yet.
    }
    // Non-empty and unchanged across two consecutive polls: the writer is
    // done.
    if (size >= minSize && size === lastSize) return size;
    lastSize = size;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `${label} ${target} did not settle within ${timeoutMs}ms ` +
      `(last size ${lastSize}, min expected ${minSize})`
  );
}

/**
 * Poll until no stray daemons remain, or the window expires.
 *
 * A raw listStrayDaemons() check right after a suite finishes races with
 * SIGKILL delivery: the signal has been sent but the kernel has not reaped
 * the process yet, so a correctly reaped daemon can still show up. A
 * genuinely leaked daemon (the bug this guards against) never goes away, so
 * a short grace window separates "dying" from "leaked" without weakening
 * the check.
 */
async function waitForNoStrays(options = {}) {
  const { graceMs = 3000, pollMs = 100 } = options;
  const deadline = Date.now() + graceMs;
  let strays = listStrayDaemons();
  while (strays.pids.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    strays = listStrayDaemons();
  }
  return strays;
}

module.exports = {
  REPO_ROOT,
  READY,
  daemonBin,
  startDaemon,
  stopDaemon,
  withDaemon,
  waitForFileStable,
  listStrayDaemons,
  waitForNoStrays,
  DEFAULT_READY_TIMEOUT_MS,
};
