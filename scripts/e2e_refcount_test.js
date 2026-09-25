// E2E: engine refcount across two clients sharing one mapping.
// Boots the daemon, connects twice (refs=2), inserts via client A, drops
// client A (one disconnect), and asserts client B still reads/writes.
// Then drops B (last disconnect tears down) and asserts a fresh connect
// works again. Guards the use-after-unmap class on shared mappings.
const { join } = require('path');
const fs = require('fs');

const { startDaemon, stopDaemon } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;

const { loadBindings } = require('./helpers/addon');
const takyondb = loadBindings();

function fail(msg) {
  console.error(`[E2E Refcount] FAILURE: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }

  console.log('[E2E Refcount] Booting daemon...');
  // Explicit kills below stay (they are the suite's own intent); the helper
  // adds a readiness handshake instead of a blind sleep plus an exit safety
  // net that reaps the daemon even if a path forgets to kill it.
  const daemon = await startDaemon({ args: [String(ARENA_SIZE)] });

  const memA = takyondb.initSharedMemory(ARENA_SIZE);
  if (!memA) return fail('client A connect failed');
  const memB = takyondb.initSharedMemory(ARENA_SIZE);
  if (!memB) {
    await stopDaemon(daemon);
    return fail('client B shared connect failed');
  }

  if (takyondb.insert_index('ref:a', 300000) !== 0) {
    await stopDaemon(daemon);
    return fail('insert via shared mapping');
  }

  // Drop client A: the mapping must survive for B (refs 2 -> 1).
  takyondb.disconnect_shm();
  if (takyondb.search_index('ref:a') !== 300000) {
    await stopDaemon(daemon);
    return fail('client B lost the mapping after A disconnected');
  }
  if (takyondb.insert_index('ref:b', 300064) !== 0 || takyondb.search_index('ref:b') !== 300064) {
    await stopDaemon(daemon);
    return fail('client B cannot write after A disconnected');
  }

  // Drop B: last disconnect tears down. A fresh connect must work again.
  takyondb.disconnect_shm();
  const memC = takyondb.initSharedMemory(ARENA_SIZE);
  if (!memC) {
    await stopDaemon(daemon);
    return fail('fresh connect after full teardown failed');
  }
  if (takyondb.search_index('ref:b') !== 300064) {
    await stopDaemon(daemon);
    return fail('fresh mapping lost prior inserts');
  }

  await stopDaemon(daemon);
  try { takyondb.disconnect_shm(); } catch (e) {}
  console.log('[E2E Refcount] SUCCESS: shared mapping survives partial disconnect.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
