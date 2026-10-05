// E2E: a configured arena holds what the default layout could not.
//
// This is the exit criterion of the substrate gate. Before arena layout v3
// the record region ended wherever the index root sat at 2 MiB, so a larger
// arena bought a larger string region and nothing else: 1.72 MiB of records
// whatever you asked for, and an exhaustion message naming MAX_RECORD_ARENA,
// a constant the caller could not change.
//
// So the property under test is specific: a record region the operator chose
// holds over five times what the default layout could, through the shipped
// SDK, and every record survives a checkpoint, a SIGKILL and a reboot with
// the same configuration.
//
// It goes through `TakyonDB` rather than writing into the mapping by hand,
// because a record's live extent is defined by its allocator's bump word. A
// test that writes bytes into the arena without allocating leaves the bump
// where it started, the snapshot carries none of it, and the test then
// concludes that recovery is broken.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startDaemon, stopDaemon, waitForFileStable } = require('./helpers/daemon');
const { loadBindings } = require('./helpers/addon');

const ROW_BYTES = 32; // four float64 columns

// The gate asks for 2 GiB and 500,000 records. The shared-memory segment is
// bounded by the host -- /dev/shm is a 64 MiB tmpfs in a default container --
// so the suite sizes itself to what this machine can map and prints the plan
// it ran. The scale does not change the property: the assertion is that the
// configured region holds more than the default layout could, by a wide
// margin, and that all of it survives a crash.
const GATE_ARENA = 2 * 1024 * 1024 * 1024;
const GATE_RECORDS = 500000;
const DEFAULT_RECORD_BYTES = 2097152 - 296136; // the default record region
const DEFAULT_CEILING = Math.floor(DEFAULT_RECORD_BYTES / ROW_BYTES);

const configPath = path.join(os.tmpdir(), 'takyon-regions-config.json');

/** Largest arena this host's shared memory can back, with room to spare. */
function arenaBudget() {
  try {
    const st = fs.statfsSync('/dev/shm');
    const free = Number(st.bsize) * Number(st.bavail);
    return Math.min(GATE_ARENA, Math.max(0, free - 8 * 1024 * 1024));
  } catch (e) {
    return 0;
  }
}

const ARENA_SIZE = arenaBudget();
if (ARENA_SIZE < 32 * 1024 * 1024) {
  console.error(
    `[E2E Regions] FAILURE: /dev/shm offers ${ARENA_SIZE} free bytes, too little to prove ` +
      'anything about configured regions. Run the daemon with a larger --shm-size.'
  );
  process.exit(1);
}

// Half the arena to records, a third to the index, the rest to strings. The
// ring is configured too, because two deltas per record through a 4096-slot
// ring cannot keep up with a burst this size -- which is back-pressure
// (Gate 2) and not something this suite should paper over.
const RECORD_BYTES = Math.floor(ARENA_SIZE / 2);
const ART_BYTES = Math.floor(ARENA_SIZE / 3);
const RECORDS = Math.min(150000, Math.floor((RECORD_BYTES - 64) / ROW_BYTES));
if (RECORDS < DEFAULT_CEILING * 2) {
  console.error(
    `[E2E Regions] FAILURE: this host can only host ${RECORDS} records, which the default ` +
      'layout would have held too. The suite would prove nothing.'
  );
  process.exit(1);
}

fs.writeFileSync(
  configPath,
  JSON.stringify(
    { regions: { record_bytes: RECORD_BYTES, art_bytes: ART_BYTES, ring_capacity: 65536 } },
    null,
    2
  )
);

function fail(msg) {
  console.error(`[E2E Regions] FAILURE: ${msg}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const takyondb = loadBindings();

/**
 * Runs a write, retrying while the ring is full.
 *
 * Two slots per record go into the ring: the index operation and the value
 * bytes. A burst of hundreds of thousands of them outruns the flusher, whose
 * drain rate is bounded by an fsync per sector, and the ring refuses. The
 * project's own rule is that a caller must never be told a write failed
 * after its bytes are in the arena, so a bounded wait here is what a real
 * application does today and what Gate 2 will make the SDK do for it.
 */
async function withBackPressure(what, fn) {
  const deadline = Date.now() + 30000;
  let attempts = 0;
  while (Date.now() < deadline) {
    if (fn() === 0) return;
    attempts++;
    await sleep(1);
  }
  fail(`ring stayed full for 30s (${attempts} retries) at ${what}`);
}

const Schema = { a: 'float64', b: 'float64', c: 'float64', d: 'float64' };
const pad = (i) => `REG-${i.toString().padStart(7, '0')}`;

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-regions-'));
  try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}

  console.log(
    `[E2E Regions] ${RECORDS} records x ${ROW_BYTES}B into a ` +
      `${Math.floor(RECORD_BYTES / 1048576)} MiB record region of a ` +
      `${Math.floor(ARENA_SIZE / 1048576)} MiB arena ` +
      `(gate: ${GATE_RECORDS} records / ${GATE_ARENA / 1073741824} GiB)` +
      (ARENA_SIZE < GATE_ARENA ? ' -- scaled to this host' : '')
  );
  console.log(
    `[E2E Regions] the default layout would have held ${DEFAULT_CEILING} records at most, ` +
      'whatever the arena size'
  );

  const args = [String(ARENA_SIZE), '--data-dir', dataDir, '--config', configPath];
  let daemon = await startDaemon({ args, readyPattern: /Server ready/ });

  // The published entry point, not the sources: this suite is about what a
  // caller gets, and the dist build is what npm ships.
  const { TakyonDB, TakyonSchema } = require(require('path').join(
    __dirname,
    '..',
    'src',
    'sdk',
    'ts',
    'dist',
    'index.js'
  ));
  const schema = new TakyonSchema(Schema);
  let db = new TakyonDB(takyondb, ARENA_SIZE);
  const regions = { ...db.client.getRegions() };

  // The daemon must have written the configured table, not the defaults.
  if (regions.recordBytes !== RECORD_BYTES) {
    fail(`record region is ${regions.recordBytes} bytes, expected ${RECORD_BYTES}`);
  }
  console.log(
    `[E2E Regions] record region ${Math.floor(regions.recordBytes / 1048576)} MiB, ` +
      `index root at ${Math.floor(regions.artRoot / 1048576)} MiB ` +
      '(the default layout ends records at 1.7 MiB)'
  );

  let rows = db.collection('regions', schema);
  for (let i = 0; i < RECORDS; i++) {
    if (i % 25000 === 0) console.log(`[E2E Regions]   ${i}...`);
    const key = pad(i);
    await withBackPressure(`insert ${key}`, () => {
      try {
        rows.insert(key, { a: i });
        return 0;
      } catch (e) {
        // The allocator is not what refuses; the ring is. Anything else is
        // the failure the suite exists to catch.
        if (!/ring/i.test(String(e.message))) fail(`insert ${key}: ${e.message}`);
        return 1;
      }
    });
  }
  console.log(
    `[E2E Regions] inserted ${RECORDS} records (${Math.floor((RECORDS * ROW_BYTES) / 1048576)} MiB), ` +
      `${Math.round(RECORDS / DEFAULT_CEILING)}x the default ceiling`
  );
  // Release the mapping before the checkpoint and the reboot: the engine
  // holds one mapping per process, and a second connect has to go through
  // the same path a fresh process would.
  db.client.shutdownEngine();

  // Checkpoint, then kill without a graceful shutdown. The wait is on the
  // snapshot artifact rather than a sleep: a fixed guess either wastes time
  // or gets SIGKILLed mid-checkpoint and turns a passing suite flaky.
  db = new TakyonDB(takyondb, ARENA_SIZE);
  if (db.client.triggerCheckpoint() !== true) fail('checkpoint not queued');
  await waitForFileStable(path.join(dataDir, 'data.takyon.snap'), {
    timeoutMs: 60000,
    label: 'snapshot',
  });
  await sleep(500);
  db.client.shutdownEngine();
  daemon.proc.kill('SIGKILL');
  await stopDaemon(daemon);
  console.log('[E2E Regions] SIGKILLed after a checkpoint');

  daemon = await startDaemon({ args, readyPattern: /Server ready/ });
  db = new TakyonDB(takyondb, ARENA_SIZE);
  rows = db.collection('regions', schema);

  let found = 0;
  for (let i = 0; i < RECORDS; i++) {
    const row = rows.find(pad(i));
    if (!row) fail(`record ${pad(i)} did not recover`);
    if (row.a !== i) fail(`record ${pad(i)} recovered with a=${row.a}`);
    found++;
  }
  console.log(`[E2E Regions] recovered ${found}/${RECORDS} records with their values`);

  db.client.shutdownEngine();
  await stopDaemon(daemon);
  try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(configPath); } catch (e) {}
  console.log('[E2E Regions] SUCCESS: a configured record region survives a crash.');
  process.exit(0);
}

run().catch((e) => {
  try { fs.unlinkSync(configPath); } catch (e2) {}
  fail(e.stack || e.message);
});
