// E2E: index entries written AFTER a checkpoint must survive SIGKILL.
//
// The snapshot captures the whole arena, ART region included, so keys that
// existed at checkpoint time recover. An index entry written afterwards
// lives in shared memory and in the log, and rebuilding it on restart is
// what this suite pins.
//
// The entry is only worth rebuilding if the record it names is there too,
// so each key is written the way `Collection.insert` writes one: the index
// operation first, then the record's bytes. An index operation whose record
// never reached the log is dropped on purpose -- a key that resolves to
// bytes nobody wrote reads as somebody else's data, which is worse than a
// missing key. This suite used to insert index entries with no records
// behind them at all, and passed because those entries pointed into the
// ring region and nothing ever checked what they resolved to.
const { join } = require('path');
const fs = require('fs');
const os = require('os');

const { startDaemon, stopDaemon, waitForFileStable } = require('./helpers/daemon');

const ARENA_SIZE = 16 * 1024 * 1024;
const PRE = 300;    // indexed before the checkpoint
const POST = 200;   // indexed after it
const pad = (i) => `IDX-${i.toString().padStart(5, '0')}`;
// One 8-byte record per key, inside the record region. The region starts
// after the ring, whose size depends on the configured capacity, so the
// offset is derived from the segment's own table rather than guessed.
const RECORD_START_OFFSET = 16; // layout.RECORD_START_OFFSET
let recordStart = 0;
const recordOffset = (i) => recordStart + i * 8;
const RECORD_BYTES = 8;

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

/** The record payload for key `i`: derived, so a recovered record that
 * belongs to another key is visible as wrong bytes rather than as a
 * plausible value. */
function payloadFor(i) {
    const b = Buffer.alloc(RECORD_BYTES);
    b.writeUInt32LE((i * 2654435761) >>> 0, 0);
    b.writeUInt32LE(0x5a5a5a5a, 4);
    return new Uint8Array(b);
}

/**
 * First byte available to records, read from the segment header.
 *
 * Offset 16 of the header is `RECORD_START_OFFSET` (layout.zig), which the
 * daemon writes from the configured ring capacity. Reading it rather than
 * recomputing it here is the point: a suite that hardcodes a ring size
 * tests the default layout and nothing else.
 */
function readRecordStart() {
    const mem = connect();
    const at = new DataView(mem).getUint32(RECORD_START_OFFSET, true);
    if (at < 1024 || at > mem.byteLength) fail(`record start ${at} is not a plausible offset`);
    return at;
}

/** Resolves once the log is larger than `path`'s size right now. */
async function waitForWalGrowth(path, timeoutMs = 15000) {
    const before = fs.existsSync(path) ? fs.statSync(path).size : 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const now = fs.existsSync(path) ? fs.statSync(path).size : 0;
        if (now > before) return now;
        await new Promise((r) => setTimeout(r, 20));
    }
    fail(`the WAL did not grow past ${before} bytes after ${POST} post-checkpoint writes`);
    return before;
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

  recordStart = readRecordStart();

  // Before the checkpoint, and after it: the same two writes each time.
  const writeKey = async (i, when) => {
    if (takyondb.insert_index(pad(i), recordOffset(i)) !== 0) {
      await stopDaemon(daemon);
      return fail(`insert_index ${when} ${i}`);
    }
    // The record's bytes, in the same order Collection.insert writes them:
    // the index operation names the record, then the record is written.
    // pushDelta takes the offset and the payload; the length is the array's.
    if (takyondb.pushDelta(recordOffset(i), payloadFor(i)) !== 0) {
      await stopDaemon(daemon);
      return fail(`pushDelta ${when} ${i}`);
    }
  };

  for (let i = 0; i < PRE; i++) await writeKey(i, 'pre-checkpoint');

  if (takyondb.trigger_checkpoint() !== 0) {
    await stopDaemon(daemon);
    return fail('checkpoint not queued');
  }
  await waitForFileStable(join(dataDir, 'data.takyon.snap'), {
    minSize: 4096, label: 'snapshot',
  });

  // After the checkpoint. The log is truncated by the checkpoint, so what is
  // written now is what has to come back from replay.
  for (let i = PRE; i < PRE + POST; i++) await writeKey(i, 'post-checkpoint');

  // The log must have grown, or this suite is asserting something the daemon
  // did not do. Waiting for the file to grow is the precondition; the size
  // afterwards is the diagnostic.
  await waitForWalGrowth(join(dataDir, 'data.takyon'));
  const walPath = join(dataDir, 'data.takyon');
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  console.log(`[E2E IndexPersist] WAL after ${POST} post-checkpoint inserts: ${walSize} bytes.`);

  // Sanity: the keys must be readable BEFORE the crash, or the suite would
  // be testing a broken client rather than a broken recovery. The offset
  // must be the one written, not merely a plausible number.
  for (let i = 0; i < PRE + POST; i++) {
    if (takyondb.search_index(pad(i)) !== recordOffset(i)) {
      await stopDaemon(daemon);
      return fail(`key ${pad(i)} resolves to ${takyondb.search_index(pad(i))}, expected ${recordOffset(i)}`);
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
  let wrongOffset = null;
  for (let i = 0; i < PRE; i++) if (takyondb.search_index(pad(i)) < 0) preMissing++;
  for (let i = PRE; i < PRE + POST; i++) if (takyondb.search_index(pad(i)) < 0) postMissing++;
  // Presence is not enough: a key that resolves to a plausible-but-wrong
  // offset reads as another row. The offset has to be the one written.
  for (let i = 0; i < PRE + POST && wrongOffset === null; i++) {
    const off = takyondb.search_index(pad(i));
    if (off !== recordOffset(i)) wrongOffset = `${pad(i)} -> ${off}, expected ${recordOffset(i)}`;
  }

  console.log(`[E2E IndexPersist] pre-checkpoint: ${PRE - preMissing}/${PRE} recovered, ` +
              `post-checkpoint: ${POST - postMissing}/${POST} recovered.`);

  await stopDaemon(daemon);
  disconnectAll();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  if (preMissing > 0) return fail(`${preMissing} pre-checkpoint keys lost (snapshot path regressed)`);
  if (postMissing > 0) {
    return fail(
      `${postMissing} post-checkpoint keys lost: the log replay did not re-apply their index ` +
        'operations (or dropped them for naming a record the log never received)'
    );
  }
  if (wrongOffset !== null) return fail(`recovered key resolves to the wrong record: ${wrongOffset}`);
  console.log('[E2E IndexPersist] SUCCESS: all index keys survived SIGKILL.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
