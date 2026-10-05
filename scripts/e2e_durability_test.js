// E2E: a committed write survives a crash, and a refused one says so.
//
// This is the exit criterion of the durability gate. Before it, the SDK had
// no way to state "this write is durable" other than taking a checkpoint: a
// write was in mapped memory the instant it returned, but the only proof it
// would survive a kill was a full snapshot, which costs far more than the
// durability it buys. Worse, a full ring made a push throw a generic Error
// after the caller had *already written the bytes through the mapping*, so
// the honest response to the error -- retry -- and the one the code invited
// -- assume nothing happened -- disagreed about the state of the data.
//
// So two properties are under test, and they are the whole gate:
//
//   1. After `commit()` returns, the records are in the log and fsync'd. The
//      daemon is SIGKILLed with no checkpoint and no graceful shutdown, and
//      every committed record comes back after a reboot.
//   2. A burst larger than the ring, with nothing draining it, surfaces
//      `BackpressureError` -- a distinct type that says "in memory, not in
//      the log" -- instead of a generic error that says nothing.
//
// The automatic checkpoint is pushed an hour out for the whole run. Without
// that, a 60s timer could snapshot the arena, and the recovery assertion
// below would pass while testing the snapshot path instead of the WAL one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startDaemon, stopDaemon } = require('./helpers/daemon');
const { loadBindings } = require('./helpers/addon');

const ARENA_SIZE = 16 * 1024 * 1024;
const RECORDS = 4000;
// A 65536-slot ring for the daemon phase. Each record queues two deltas, so
// 4000 records is 8000 slots against a default ring of 4096, and the flusher
// on a container filesystem cannot always drain that between the commits
// below. Widening the ring is the honest way to keep this suite about
// durability: the refusal half of the gate runs with no daemon at all and
// uses the default ring, which is where a full ring is supposed to happen.
const RING_CAPACITY = 65536;
// Enough that a burst of two deltas per record outruns the ring on its own.
// The ring holds 4096 slots by default, so this cannot fit in it.
const SATURATING_RECORDS = 6000;
// A large ring would make the saturation case wait out the whole push
// timeout before reporting anything, so the arena stays at the default
// layout and the test is sized against it.
const COMMIT_TIMEOUT_MS = 20000;

const takyondb = loadBindings();

function fail(msg) {
  console.error(`[E2E Durability] FAILURE: ${msg}`);
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

const Schema = { a: 'float64', b: 'float64', c: 'float64', d: 'float64' };
const pad = (i) => `DUR-${i.toString().padStart(6, '0')}`;

/** The dist build, not the sources: this suite is about what npm ships. */
function loadSdk() {
  return require(path.join(__dirname, '..', 'src', 'sdk', 'ts', 'dist', 'index.js'));
}

async function testCommittedWritesSurviveKill(Sdk) {
  const { TakyonDB, TakyonSchema } = Sdk;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-durability-'));
  cleanShm();

  const configPath = path.join(dataDir, 'takyon.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ regions: { ring_capacity: RING_CAPACITY } }, null, 2)
  );

  const args = [
    String(ARENA_SIZE),
    '--data-dir',
    dataDir,
    '--config',
    configPath,
    '--checkpoint-sec',
    '3600', // no automatic snapshot for the length of this run
  ];
  let daemon = await startDaemon({ args, readyPattern: /Server ready/ });

  let db = new TakyonDB(takyondb, ARENA_SIZE);
  let lastDurable = 0;

  // The daemon's table is the authority, so a config the SDK ignored would
  // show up here rather than as a mysterious back-pressure failure later.
  const ringCapacity = db.client.getRegions().ringCapacity;
  if (ringCapacity !== RING_CAPACITY) {
    fail(`ring capacity is ${ringCapacity}, expected the configured ${RING_CAPACITY}`);
  }

  /**
   * A barrier, then a check on what the barrier is supposed to have
   * achieved. The counter must not move backwards either: a durability
   * marker that forgets its own progress would let a later commit appear
   * satisfied without anything being written.
   */
  const commitThrough = (upto) => {
    db.client.commit(COMMIT_TIMEOUT_MS);
    const st = db.client.ringStats();
    if (st.durable_tail === 0) fail('commit() returned but durable_tail is still 0');
    if (st.durable_tail < lastDurable) {
      fail(`durable_tail went backwards: ${lastDurable} -> ${st.durable_tail}`);
    }
    if (st.dropped_total !== 0) fail(`${st.dropped_total} delta(s) were dropped by the flusher`);
    lastDurable = st.durable_tail;
    console.log(
      `[E2E Durability]   commit(${upto}): durable through ${st.durable_tail}, ` +
        `saturated ${st.saturated_total} time(s)`
    );
  };

  const schema = new TakyonSchema(Schema);
  const rows = db.collection('durability', schema);

  // A commit per thousand rather than per record: the property is that a
  // commit is a barrier, and a barrier every thousand still proves every
  // record before it is durable. One commit per record would measure fsync
  // latency instead of the contract.
  console.log(`[E2E Durability] writing ${RECORDS} records with a commit every 1000`);
  for (let start = 0; start < RECORDS; start += 1000) {
    const end = Math.min(start + 1000, RECORDS);
    for (let i = start; i < end; i++) rows.insert(pad(i), { a: i });
    commitThrough(end);
  }

  // Readable right now, with no daemon cooperation: Takyon writes in place.
  for (let i = 0; i < RECORDS; i++) {
    const row = rows.find(pad(i));
    if (!row) fail(`record ${pad(i)} is not readable before the crash`);
    if (row.a !== i) fail(`record ${pad(i)} reads a=${row.a} before the crash`);
  }

  const snapPath = path.join(dataDir, 'data.takyon.snap');
  console.log(
    `[E2E Durability] SIGKILL with no checkpoint; snapshot present: ${fs.existsSync(snapPath)}`
  );

  db.client.shutdownEngine();
  daemon.proc.kill('SIGKILL');
  await stopDaemon(daemon);

  daemon = await startDaemon({ args, readyPattern: /Server ready/ });
  db = new TakyonDB(takyondb, ARENA_SIZE);
  const recovered = db.collection('durability', schema);

  let found = 0;
  for (let i = 0; i < RECORDS; i++) {
    const row = recovered.find(pad(i));
    if (!row) fail(`committed record ${pad(i)} did not survive SIGKILL`);
    if (row.a !== i) fail(`committed record ${pad(i)} recovered with a=${row.a}`);
    found++;
  }
  const snapPathAfter = fs.existsSync(snapPath);
  console.log(
    `[E2E Durability] recovered ${found}/${RECORDS} committed records ` +
      `(snapshot file present after reboot: ${snapPathAfter})`
  );

  db.client.shutdownEngine();
  await stopDaemon(daemon);
  cleanShm();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return { committed: found, durableTail: lastDurable };
}

/**
 * The refusal half: nothing is draining the ring, so a burst bigger than it
 * has to be reported. Which is reported matters -- a caller cannot apply
 * back-pressure to an error it cannot recognize.
 */
async function testSaturationIsTyped(Sdk) {
  const { TakyonDB, TakyonSchema, BackpressureError } = Sdk;
  cleanShm();

  // No daemon: the ring is mapped but nothing pops it, so it fills and stays
  // full. This is the deterministic version of the saturation case; the
  // committed-writes case above cannot rely on timing for it.
  // The refusal half needs a segment nobody drains *and* nobody is holding.
  // The engine mapping is process-wide and reference counted, so if the
  // detach below is missing the second half would silently reuse the first
  // half's segment and this suite would pass for the wrong reason.
  if (typeof takyondb.disconnect_shm !== 'function') {
    fail('the addon does not export disconnect_shm, so the engine mapping cannot be released');
  }
  const db = new TakyonDB(takyondb, ARENA_SIZE);
  const regions = db.client.getRegions();
  if (regions.ringCapacity === RING_CAPACITY) {
    fail(
      'the segment still carries the daemon phase ring capacity, so this is the same ' +
        'mapping rather than a fresh one'
    );
  }
  console.log(
    `[E2E Durability] fresh segment, ring capacity ${regions.ringCapacity}, nothing draining it`
  );
  const rows = db.collection('saturation', new TakyonSchema(Schema));

  let thrown = null;
  let accepted = 0;
  for (let i = 0; i < SATURATING_RECORDS; i++) {
    try {
      rows.insert(pad(i), { a: i });
      accepted = i + 1;
    } catch (e) {
      thrown = e;
      break;
    }
  }

  if (!thrown) {
    const stats = db.client.ringStats();
    fail(
      `${SATURATING_RECORDS} records went through a ` +
        `${db.client.getRegions().ringCapacity}-slot ring with nothing draining it and no ` +
        `error was raised (ring stats: ${JSON.stringify(stats)}). A full ring that reports ` +
        'success is silent data loss.'
    );
  }
  if (!(thrown instanceof BackpressureError)) {
    fail(
      'a saturated ring surfaced ' +
        `${thrown.constructor.name} rather than BackpressureError, so a caller cannot ` +
        `recognize it: ${thrown.message}`
    );
  }
  if (thrown.durable !== false) {
    fail('BackpressureError claims durable = true; by construction it is false');
  }
  const st = db.client.ringStats();
  console.log(
    `[E2E Durability] ring full after ${accepted} records: BackpressureError, ` +
      `saturated ${st.saturated_total} time(s), dropped ${st.dropped_total}`
  );
  if (st.saturated_total === 0) {
    fail('a BackpressureError was raised but the saturation counter never moved');
  }
  if (st.dropped_total !== 0) {
    fail(`${st.dropped_total} delta(s) were dropped; a refusal must not also lose data`);
  }

  // commit() must refuse too, and say why. Claiming success here would be
  // the single worst outcome: the caller would believe writes that nothing
  // on this host is writing are durable.
  let commitError = null;
  try {
    db.client.commit(200);
  } catch (e) {
    commitError = e;
  }
  if (!commitError) {
    fail('commit() succeeded with no daemon logging this directory');
  }
  if (commitError instanceof BackpressureError) {
    fail('commit() reported back-pressure when the real cause is that nothing is being logged');
  }
  if (!/durab/i.test(commitError.message)) {
    fail(`commit() refused for an unclear reason: ${commitError.message}`);
  }
  console.log(`[E2E Durability] commit() without a daemon: ${commitError.message}`);

  db.client.shutdownEngine();
  cleanShm();
  return { accepted, saturated: st.saturated_total };
}

async function run() {
  const Sdk = loadSdk();
  console.log('[E2E Durability] Gate 2: committed writes are durable; refusals are typed.');
  const committed = await testCommittedWritesSurviveKill(Sdk);
  const sat = await testSaturationIsTyped(Sdk);
  console.log(
    `[E2E Durability] SUCCESS: ${committed.committed} committed records survived SIGKILL ` +
      `(durable through ${committed.durableTail}), and a full ring raised BackpressureError ` +
      `at record ${sat.accepted}.`
  );
  process.exit(0);
}

run().catch((e) => {
  cleanShm();
  fail(e.stack || e.message);
});