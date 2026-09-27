// E2E: index entries written AFTER a checkpoint must survive SIGKILL.
//
// The snapshot captures the whole arena, ART region included, so keys that
// existed at checkpoint time recover. takyon_insert_index does not emit a
// WAL delta, so anything indexed afterwards lives only in shared memory and
// is lost on crash. This suite pins that gap so it cannot come back quietly.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const { startDaemon, stopDaemon, waitForFileStable } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;
const PRE = 300;    // indexed before the checkpoint
const POST = 200;   // indexed after it
const pad = (i) => `IDX-${i.toString().padStart(5, '0')}`;

const { loadBindings } = require('./helpers/addon');
const takyondb = loadBindings();

function fail(msg) {
  console.error(`[E2E IndexPersist] FAILURE: ${msg}`);
  process.exit(1);
}

let shmRefs = 0;
function connect() {
  const mem = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem) fail('shared memory connect failed');
  shmRefs++;
  return mem;
}
function disconnectAll() {
  while (shmRefs > 0) { takyondb.disconnect_shm(); shmRefs--; }
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
  const dataDir = fs.mkdtempSync(join(os.tmpdir(), 'takyon-idxpersist-'));
  cleanShm();

  console.log('[E2E IndexPersist] Phase 1: index keys, checkpoint, more index keys...');
  let daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  connect();

  // Before the checkpoint. Value offsets only need to be in range; the
  // suite is about index reachability, not record contents.
  for (let i = 0; i < PRE; i++) {
    if (takyondb.insert_index(pad(i), 4096 + i * 64) !== 0) {
      await stopDaemon(daemon);
      return fail(`insert_index pre-checkpoint ${i}`);
    }
  }

  if (takyondb.trigger_checkpoint() !== 0) {
    await stopDaemon(daemon);
    return fail('checkpoint not queued');
  }
  await waitForFileStable(join(dataDir, 'data.takyon.snap'), {
    minSize: 4096, label: 'snapshot',
  });

  // After the checkpoint. Nothing else touches the WAL from here.
  for (let i = PRE; i < PRE + POST; i++) {
    if (takyondb.insert_index(pad(i), 4096 + i * 64) !== 0) {
      await stopDaemon(daemon);
      return fail(`insert_index post-checkpoint ${i}`);
    }
  }
  // Do NOT wait for the WAL to grow: takyon_insert_index emits no delta, so
  // after the checkpoint truncates the log there is nothing to wait for. The
  // file size is reported as the diagnostic instead of being a precondition.
  await new Promise((r) => setTimeout(r, 1000));
  const walPath = join(dataDir, 'data.takyon');
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  console.log(`[E2E IndexPersist] WAL after ${POST} post-checkpoint inserts: ${walSize} bytes.`);

  // Sanity: the keys must be readable BEFORE the crash, or the suite would
  // be testing a broken client rather than a broken recovery.
  for (let i = 0; i < PRE + POST; i++) {
    if (takyondb.search_index(pad(i)) < 0) {
      await stopDaemon(daemon);
      return fail(`key ${pad(i)} not visible before the crash`);
    }
  }

  console.log('[E2E IndexPersist] SIGKILLing daemon...');
  await stopDaemon(daemon);
  disconnectAll();
  cleanShm();

  console.log('[E2E IndexPersist] Phase 2: reboot and verify...');
  daemon = await startDaemon({ args: [String(ARENA_SIZE), '--data-dir', dataDir] });
  connect();

  let preMissing = 0, postMissing = 0;
  for (let i = 0; i < PRE; i++) if (takyondb.search_index(pad(i)) < 0) preMissing++;
  for (let i = PRE; i < PRE + POST; i++) if (takyondb.search_index(pad(i)) < 0) postMissing++;

  console.log(`[E2E IndexPersist] pre-checkpoint: ${PRE - preMissing}/${PRE} recovered, ` +
              `post-checkpoint: ${POST - postMissing}/${POST} recovered.`);

  await stopDaemon(daemon);
  disconnectAll();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (preMissing > 0) return fail(`${preMissing} pre-checkpoint keys lost (snapshot path regressed)`);
  if (postMissing > 0) {
    return fail(`${postMissing} post-checkpoint keys lost: takyon_insert_index writes no WAL delta`);
  }
  console.log('[E2E IndexPersist] SUCCESS: all index keys survived SIGKILL.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
