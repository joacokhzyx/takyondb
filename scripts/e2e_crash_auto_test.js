// E2E: crash recovery, fully self-driving (no operator SIGKILL needed).
// Boots the daemon on an isolated --data-dir, inserts 5000 SNAP keys,
// checkpoints, writes a residual WAL payload, SIGKILLs the daemon,
// reboots it, and verifies snapshot keys + residual bytes survived.
// Replaces the manual e2e_crash_recovery_test.ts flow for automation.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const { startDaemon, stopDaemon, waitForFileStable } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;
const N = 5000;
const RESIDUAL_OFFSET = 3000000;
const RESIDUAL_SIZE = 4086; // +6B header = 4092: one full sector flush

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

function fail(msg) {
  console.error(`[E2E Crash] FAILURE: ${msg}`);
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

function connect() {
  const mem = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem) fail('shared memory connect failed');
  return mem;
}

async function run() {
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'takyon-crash-'));
  cleanShm();

  console.log('[E2E Crash] Phase 1: boot, insert, checkpoint, residual...');
  let daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  connect();

  const pad = (i) => i.toString().padStart(5, '0');
  for (let i = 0; i < N; i++) {
    if (takyondb.insert_index(`SNAP-${pad(i)}`, 4096 + i * 64) !== 0) {
      await stopDaemon(daemon);
      return fail(`insert SNAP-${pad(i)}`);
    }
  }
  if (takyondb.trigger_checkpoint() !== 0) {
    await stopDaemon(daemon);
    return fail('checkpoint not queued');
  }
  // Wait for the snapshot artifact instead of guessing how long the
  // checkpoint takes: a fixed sleep either wastes time or gets SIGKILLed
  // mid-write on a loaded host.
  await waitForFileStable(join(dataDir, 'data.takyon.snap'), {
    minSize: 4096,
    label: 'snapshot',
  });

  const view = new DataView(connect());
  for (let i = 0; i < RESIDUAL_SIZE; i++) view.setUint8(RESIDUAL_OFFSET + i, 0xaa);
  if (takyondb.notifyArena(RESIDUAL_OFFSET, RESIDUAL_SIZE) !== 0) {
    await stopDaemon(daemon);
    return fail('residual notifyArena');
  }
  // The residual delta must reach the WAL before the crash, otherwise the
  // suite would "pass" a recovery it never actually exercised. Wait for
  // the WAL to stop growing rather than sleeping a fixed second.
  await waitForFileStable(join(dataDir, 'data.takyon'), {
    minSize: 4096,
    label: 'WAL after residual',
  });

  console.log('[E2E Crash] SIGKILLing daemon...');
  await stopDaemon(daemon);
  try { takyondb.disconnect_shm(); } catch (e) {}
  cleanShm();

  console.log('[E2E Crash] Phase 2: reboot and verify...');
  daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  const mem2 = connect();

  let errors = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (takyondb.search_index(`SNAP-${pad(i)}`) < 0) errors++;
  }
  console.log(`[E2E Crash] Verified ${N - errors}/${N} snapshot keys in ${(performance.now() - t0).toFixed(1)} ms.`);

  const v2 = new DataView(mem2);
  let residualOk = true;
  for (let i = 0; i < RESIDUAL_SIZE; i++) {
    if (v2.getUint8(RESIDUAL_OFFSET + i) !== 0xaa) {
      residualOk = false;
      break;
    }
  }

  await stopDaemon(daemon);
  try { takyondb.disconnect_shm(); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (errors > 0 || !residualOk) return fail(`${errors} keys missing, residual ok: ${residualOk}`);
  console.log('[E2E Crash] SUCCESS: snapshot keys and residual WAL survived SIGKILL.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
