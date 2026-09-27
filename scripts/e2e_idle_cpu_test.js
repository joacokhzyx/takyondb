// E2E: an idle daemon must not burn CPU.
//
// The admin loop and the WAL flusher both used Thread.yield()/spinLoopHint
// as their idle action. Yielding is not waiting: both return immediately, so
// a daemon with zero clients held ~1.3 cores continuously. This suite reads
// the daemon's own CPU accounting and fails if the idle cost is not near
// zero. Linux-only, because it reads /proc.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const { startDaemon, stopDaemon } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;
const SETTLE_MS = 1500;   // let the boot work drain before measuring
const SAMPLE_MS = 5000;   // measurement window
const HZ = 100;           // Linux USER_HZ
const MAX_IDLE_CORES = 0.10;

function fail(msg) {
  console.error(`[E2E IdleCpu] FAILURE: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanShm() {
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }
}

// utime + stime from /proc/<pid>/stat, in clock ticks. Field 14 and 15 are
// positional after the (comm) field, which may itself contain spaces, so
// parse from the last ')' rather than splitting the whole line.
function cpuTicks(pid) {
  const line = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const after = line.slice(line.lastIndexOf(')') + 2).split(' ');
  return parseInt(after[11], 10) + parseInt(after[12], 10);
}

async function run() {
  if (process.platform !== 'linux') {
    console.log('[E2E IdleCpu] SKIP: needs /proc (Linux only).');
    process.exit(0);
  }

  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'takyon-idlecpu-'));
  cleanShm();

  console.log('[E2E IdleCpu] Booting daemon with no clients...');
  const daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  const pid = daemon && daemon.proc && daemon.proc.pid;
  if (!pid) return fail('daemon handle did not expose a pid');

  await sleep(SETTLE_MS);
  const before = cpuTicks(pid);
  const wallStart = Date.now();
  await sleep(SAMPLE_MS);
  const after = cpuTicks(pid);
  const wallSeconds = (Date.now() - wallStart) / 1000;

  const coreSeconds = (after - before) / HZ;
  const cores = coreSeconds / wallSeconds;
  console.log(
    `[E2E IdleCpu] idle cost: ${coreSeconds.toFixed(2)} CPU-seconds over ` +
    `${wallSeconds.toFixed(1)}s = ${cores.toFixed(3)} cores.`
  );

  await stopDaemon(daemon);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (cores > MAX_IDLE_CORES) {
    return fail(
      `idle daemon used ${cores.toFixed(3)} cores (limit ${MAX_IDLE_CORES}). ` +
      `A loop is spinning instead of sleeping.`
    );
  }
  console.log('[E2E IdleCpu] SUCCESS: idle daemon is not spinning.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
