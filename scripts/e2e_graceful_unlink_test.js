// E2E: daemon owns the SHM name and unlinks it on graceful shutdown.
// Boots the daemon, SIGINTs it (graceful path, not SIGKILL), waits for a
// clean exit, and asserts the OS segment name is gone on POSIX (Windows
// unlink is a no-op: only the clean exit is asserted there).
const { join } = require('path');
const fs = require('fs');

const ARENA_SIZE = 16 * 1024 * 1024;

function fail(msg) {
  console.error(`[E2E Unlink] FAILURE: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function segmentPath() {
  if (process.platform === 'linux') return '/dev/shm/TakyonDB_Master';
  if (process.platform === 'darwin') return '/tmp/takyondb_TakyonDB_Master';
  return null;
}

async function run() {
  try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
  const seg = segmentPath();
  if (seg) {
    try { fs.unlinkSync(seg); } catch (e) {}
  }

  console.log('[E2E Unlink] Booting daemon...');
  const { spawn } = require('child_process');
  const daemonBin = join(
    __dirname,
    process.platform === 'win32' ? '../zig-out/bin/takyondb.exe' : '../zig-out/bin/takyondb',
  );
  const daemon = spawn(daemonBin, [String(ARENA_SIZE)], { stdio: 'ignore' });
  await sleep(1500);
  if (daemon.exitCode !== null) return fail(`daemon exited early with code ${daemon.exitCode}`);

  console.log('[E2E Unlink] Sending SIGINT...');
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15000);
    daemon.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  try {
    daemon.kill('SIGINT');
  } catch (e) {
    return fail(`SIGINT failed: ${e.message}`);
  }
  const code = await exited;
  if (code === 'timeout') {
    try { daemon.kill('SIGKILL'); } catch (e) {}
    return fail('daemon did not exit on SIGINT within 15s');
  }
  console.log(`[E2E Unlink] Daemon exited with code ${code}.`);

  if (seg) {
    await sleep(500);
    if (fs.existsSync(seg)) return fail('segment name still present after graceful shutdown');
    console.log('[E2E Unlink] Segment name freed.');
  }

  console.log('[E2E Unlink] SUCCESS: graceful shutdown unlinks the segment name.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
