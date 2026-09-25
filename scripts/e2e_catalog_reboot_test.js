// E2E: catalog reboot without the JSON sidecar.
// Boots the daemon on an isolated --data-dir, persists two table descriptors
// as __catalog__ ART records (payloads in the string arena) via
// CatalogRecordStore, checkpoints, SIGKILLs, reboots on the same data-dir,
// and verifies both descriptors decode identically (two-pass: catalog first).
// Requires the SDK dist first: `cd src/sdk/ts && npm run build`.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const ARENA_SIZE = 16 * 1024 * 1024;

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);
const { CatalogRecordStore } = require('../src/sdk/ts/dist/client/relational/catalog_record');

const USERS = [
  { name: 'id', type: 'uint32', primaryKey: true, unique: true },
  { name: 'age', type: 'uint32', nullable: true },
];
const ORDERS = [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'user_id', type: 'string' },
];

function fail(msg) {
  console.error(`[E2E Catalog] FAILURE: ${msg}`);
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

function sameColumns(a, b) {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return (
      c.name === d.name &&
      c.type === d.type &&
      !!c.nullable === !!d.nullable &&
      !!c.primaryKey === !!d.primaryKey &&
      !!c.unique === !!d.unique
    );
  });
}

async function run() {
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'takyon-catalog-'));
  cleanShm();

  console.log('[E2E Catalog] Phase 1: boot, save DDL, checkpoint...');
  let daemon = spawnDaemon(dataDir);
  await sleep(1000);
  const mem = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem) fail('shared memory connect failed');
  const store = new CatalogRecordStore(takyondb, mem);
  const usersOff = store.save('users', USERS);
  const ordersOff = store.save('orders', ORDERS);
  console.log(`[E2E Catalog] Saved users@${usersOff} orders@${ordersOff}.`);
  if (takyondb.trigger_checkpoint() !== 0) {
    daemon.kill('SIGKILL');
    return fail('checkpoint not queued');
  }
  await sleep(2500); // snapshot + WAL rotation

  console.log('[E2E Catalog] SIGKILLing daemon...');
  daemon.kill('SIGKILL');
  await sleep(1000);
  try { takyondb.disconnect_shm(); } catch (e) {}
  cleanShm();

  console.log('[E2E Catalog] Phase 2: reboot and load DDL first...');
  daemon = spawnDaemon(dataDir);
  await sleep(1000);
  const mem2 = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem2) fail('reboot connect failed');
  const store2 = new CatalogRecordStore(takyondb, mem2);

  const users = store2.load('users');
  const orders = store2.load('orders');
  if (!users || users.table !== 'users' || !sameColumns(users.columns, USERS)) {
    daemon.kill('SIGKILL');
    return fail(`users descriptor mismatch: ${JSON.stringify(users)}`);
  }
  if (!orders || orders.table !== 'orders' || !sameColumns(orders.columns, ORDERS)) {
    daemon.kill('SIGKILL');
    return fail(`orders descriptor mismatch: ${JSON.stringify(orders)}`);
  }
  if (store2.load('missing') !== null) {
    daemon.kill('SIGKILL');
    return fail('missing table should load null');
  }

  daemon.kill('SIGKILL');
  try { takyondb.disconnect_shm(); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log('[E2E Catalog] SUCCESS: DDL survived SIGKILL via __catalog__ records.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
