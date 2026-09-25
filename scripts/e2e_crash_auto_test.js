// E2E: crash recovery, fully self-driving (no operator SIGKILL needed).
// Boots the daemon on an isolated --data-dir, inserts 5000 SNAP keys,
// checkpoints, writes a residual WAL payload, SIGKILLs the daemon,
// reboots it, and verifies snapshot keys + residual bytes survived.
// Replaces the manual e2e_crash_recovery_test.ts flow for automation.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

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

function spawnDaemon(dataDir) {
  const { spawn } = require('child_process');
  const daemonBin = join(
    __dirname,
    process.platform === 'win32' ? '../zig-out/bin/takyondb.exe' : '../zig-out/bin/takyondb',
  );
  const daemon = spawn(daemonBin, [String(ARENA_SIZE), '--data-dir', dataDir], {
    detached: true,
    stdio: 'ignore',
  });
  daemon.unref();
  return daemon;
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
  let daemon = spawnDaemon(dataDir);
  await sleep(1000);
  connect();

  const pad = (i) => i.toString().padStart(5, '0');
  for (let i = 0; i < N; i++) {
    if (takyondb.insert_index(`SNAP-${pad(i)}`, 4096 + i * 64) !== 0) {
      daemon.kill('SIGKILL');
      return fail(`insert SNAP-${pad(i)}`);
    }
  }
  if (takyondb.trigger_checkpoint() !== 0) {
    daemon.kill('SIGKILL');
    return fail('checkpoint not queued');
  }
  await sleep(2000); // snapshot + WAL rotation

  const view = new DataView(connect());
  for (let i = 0; i < RESIDUAL_SIZE; i++) view.setUint8(RESIDUAL_OFFSET + i, 0xaa);
  if (takyondb.notifyArena(RESIDUAL_OFFSET, RESIDUAL_SIZE) !== 0) {
    daemon.kill('SIGKILL');
    return fail('residual notifyArena');
  }
  await sleep(1000); // flusher writes the sector to disk

  console.log('[E2E Crash] SIGKILLing daemon...');
  daemon.kill('SIGKILL');
  await sleep(1000);
  cleanShm();

  console.log('[E2E Crash] Phase 2: reboot and verify...');
  daemon = spawnDaemon(dataDir);
  await sleep(1000);
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

  daemon.kill();
  try { takyondb.disconnect_shm(); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (errors > 0 || !residualOk) return fail(`${errors} keys missing, residual ok: ${residualOk}`);
  console.log('[E2E Crash] SUCCESS: snapshot keys and residual WAL survived SIGKILL.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
