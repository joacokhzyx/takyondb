// E2E: crash recovery across MULTIPLE padded WAL sectors.
// Each batch is separated by a wait for the WAL to stop growing, so the
// flusher writes it as its own padded (partial) sector. This is the shape
// of any real log under load: the flusher empties the ring between bursts.
// SIGKILL, reboot, and every batch must be back.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const { startDaemon, stopDaemon, waitForFileStable } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;
const BATCHES = 5;
const BATCH_SIZE = 200;          // 200B per entry * 5 = 1000B of payload
const BASE = 4 * 1024 * 1024;    // well past the record arena
const SECTOR = 4096;

const { loadBindings } = require('./helpers/addon');
const takyondb = loadBindings();

function fail(msg) {
  console.error(`[E2E MultiSector] FAILURE: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// takyon_connect_shm refcounts (exports.zig) and returns the SAME mapping
// while the count is above zero; takyon_disconnect_shm only unmaps on the
// last call. So the disconnect count must match the connect count, or the
// "reboot" phase keeps reading this process's pre-crash memory and the
// suite passes without ever exercising recovery. Track it explicitly.
let shmRefs = 0;
function connect() {
  const mem = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem) fail('shared memory connect failed');
  shmRefs++;
  return mem;
}
function disconnectAll() {
  while (shmRefs > 0) {
    takyondb.disconnect_shm();
    shmRefs--;
  }
}

function cleanShm() {
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }
}

async function run() {
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'takyon-multisec-'));
  cleanShm();
  const walPath = join(dataDir, 'data.takyon');

  console.log(`[E2E MultiSector] Phase 1: ${BATCHES} flushed batches, no checkpoint...`);
  let daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  const view = new DataView(connect());

  let lastSize = 0;

  for (let b = 0; b < BATCHES; b++) {
    const off = BASE + b * (BATCH_SIZE + 16);
    for (let i = 0; i < BATCH_SIZE; i++) {
      view.setUint8(off + i, (b * 31 + i) & 0xff);
    }
    if (takyondb.notifyArena(off, BATCH_SIZE) !== 0) {
      await stopDaemon(daemon);
      return fail(`notifyArena for batch ${b}`);
    }
    // Wait for the flusher to drain and pad a sector for this batch alone.
    // Without the wait the batches coalesce into one sector and the suite
    // would not exercise the multi-sector path at all.
    await waitForFileStable(walPath, { minSize: SECTOR, label: `batch ${b}` });
    const size = fs.statSync(walPath).size;
    if (size <= lastSize) {
      await stopDaemon(daemon);
      return fail(`WAL did not grow for batch ${b} (still ${size})`);
    }
    lastSize = size;
  }

  const sectors = lastSize / SECTOR;
  console.log(`[E2E MultiSector] WAL is ${lastSize} bytes (${sectors} sector(s)).`);
  if (sectors < 2) {
    await stopDaemon(daemon);
    return fail(`WAL has ${sectors} sector(s); the multi-sector path was not exercised`);
  }

  console.log('[E2E MultiSector] SIGKILLing daemon...');
  await stopDaemon(daemon);
  disconnectAll();
  cleanShm();

  console.log('[E2E MultiSector] Phase 2: reboot and verify every batch...');
  daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  const view2 = new DataView(connect());

  let bad = 0;
  const perBatch = [];
  for (let b = 0; b < BATCHES; b++) {
    const off = BASE + b * (BATCH_SIZE + 16);
    let batchBad = 0;
    for (let i = 0; i < BATCH_SIZE; i++) {
      if (view2.getUint8(off + i) !== ((b * 31 + i) & 0xff)) batchBad++;
    }
    perBatch.push(batchBad === 0 ? 'ok' : `${batchBad} bad`);
    bad += batchBad;
  }
  console.log(`[E2E MultiSector] Per batch: ${perBatch.join(', ')}`);

  await stopDaemon(daemon);
  disconnectAll();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (bad > 0) return fail(`${bad} bytes lost across ${BATCHES} flushed batches`);
  console.log('[E2E MultiSector] SUCCESS: all batches survived SIGKILL.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
