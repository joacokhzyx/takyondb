// E2E: randomized crash consistency. This is Gate 2's exit criterion.
//
// The property under test, stated once: for any crash point, the data that
// was committed before it is intact afterwards, and nothing that is present
// afterwards is wrong.
//
//   1. Every record written before the last successful `commit()` is
//      recovered, with exactly the value that was written.
//   2. Every key that resolves resolves INSIDE the record region, and every
//      string pointer a committed record holds points inside the string
//      region. A key that resolves to the wrong place, or a fat pointer that
//      names memory outside the arena's string region, is the shape several
//      real bugs here took, and each of them surfaced much later as an
//      unrelated failure, so both are checked directly rather than inferred.
//   3. An uncommitted record may legitimately be absent -- it was never
//      promised to anybody -- and it may be partial, because the log is a
//      prefix at sector granularity. Its bytes are therefore not asserted.
//      What is asserted is 2: if the key resolves at all, it resolves to a
//      record, not to a string or to another record's bytes.
//
// The generator is a seeded PRNG and the mutation log lives in this process,
// outside the daemon, so a failing trial can be replayed exactly with
// --seed and --trials. The kill point advances through the run rather than
// being drawn per trial, so consecutive trials crash at different phases:
// early in a burst, after a commit, during the flush of a full sector, and
// so on. Payload sizes vary from 1 byte to a few hundred, which is what puts
// WAL entries across every position inside the 4092-byte sector payload --
// including the split-entry path a fixed size never reaches.
//
// What this does not claim: the run proves nothing about hardware that lies
// about fsync, about a power cut rather than a process kill, or about the
// ~5-second window a filesystem's own write cache can hold acknowledged
// writes. `kill -9` is the strongest failure this harness can inject.
//
// Bisection: TAKYON_CRASH_MODE removes one ingredient at a time, so a failure
// names its own cause instead of requiring a guess.
//
//   full     the suite as written.
//   single   one crash and no allocation after the recovery. A failure here
//            is recovery alone and cannot be an allocator interaction.
//   noalloc  many crashes and recoveries, nothing written after the first
//            trial. Recovery alone, over time; if this passes and `full`
//            fails, the damage needs a write after a recovery.
//   scalar   the full shape minus the string field, so nothing goes through
//            the string arena or a fat pointer.
//
// The workload is identical in every mode -- the generator draws the same
// numbers whether or not the schema has the field -- so `scalar` differs
// from `full` by one field and not by a different run.
const fs = require('fs');
const os = require('os');
const path = require('path');

const net = require('net');

const { startDaemon, stopDaemon } = require('./helpers/daemon');
const { loadBindings } = require('./helpers/addon');

/** One admin command, or null. Used only on the failure path. */
function admin(port, command, timeoutMs = 3000) {
    return new Promise((resolve) => {
        let out = '';
        const socket = net.connect(port, '127.0.0.1', () => socket.write(`${command}\n`));
        const done = (v) => {
            socket.destroy();
            resolve(v);
        };
        const timer = setTimeout(() => done(out || null), timeoutMs);
        socket.on('data', (c) => (out += c.toString()));
        socket.on('end', () => {
            clearTimeout(timer);
            done(out);
        });
        socket.on('error', () => {
            clearTimeout(timer);
            done(null);
        });
    });
}

const ARENA_SIZE = 24 * 1024 * 1024;
// Wide enough that no trial can run out of records or string space: a
// trial that failed for lack of room would be a different bug reported as
// this one.
const RECORDS_PER_TRIAL = 700;
// Commit after this many writes, so a trial spans several commits and the
// kill can land between two of them as well as inside one.
const COMMIT_EVERY = 120;
// How much of the committed tail is checked in full after every crash, and
// the stride for checking older records. Both exist so a hundred trials do
// not turn verification into the slowest part of the run.
const VERIFY_WINDOW = 1500;
const VERIFY_STRIDE = 37;
const TRIALS = Number(process.env.TAKYON_CRASH_TRIALS || 100);
const SEED = Number(process.env.TAKYON_CRASH_SEED || 0xc0ffee);
const RING_CAPACITY = 65536;

const MODE = process.env.TAKYON_CRASH_MODE || 'full';
const MODES = ['full', 'single', 'noalloc', 'scalar'];
if (!MODES.includes(MODE)) {
  console.error(`[E2E CrashProperty] unknown mode '${MODE}'; expected one of ${MODES.join(', ')}`);
  process.exit(1);
}

const takyondb = loadBindings();

// Where the log of a failing run is left, so the failure can be replayed
// offline instead of re-hunted. A crash-consistency bug is timing-dependent:
// the run that caught it cannot be re-triggered on demand, and without its
// log the only way back is dozens of attempts.
let dataDirForFailure = null;

function fail(msg) {
  console.error(`[E2E CrashProperty] FAILURE: ${msg}`);
  if (dataDirForFailure) {
    console.error(`[E2E CrashProperty] The failing data directory is kept: ${dataDirForFailure}`);
    console.error(
        '[E2E CrashProperty] Replay it offline with: TAKYON_WAL_REPLAY=' +
            `${dataDirForFailure}/data.takyon zig build test`
    );
  }
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

/**
 * mulberry32: small, seeded, and identical across Node versions, which is
 * the only property that matters here. A generator whose output depends on
 * the runtime would make a failing trial unreplayable, which is the one
 * thing a crash test has to guarantee.
 */
function makeRng(seed) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WITH_STRING = MODE !== 'scalar';
const SCHEMA = WITH_STRING
  ? { n: 'uint32', ratio: 'float64', payload: 'string' }
  : { n: 'uint32', ratio: 'float64' };
// Read from the compiled schema at run time, never written here: a check
// that hardcodes an offset is a check that can drift from the layout it is
// checking, and this one has already been wrong once.
const SCHEMA_SIZE = 24;
const pad = (i) => `CP-${i.toString().padStart(7, '0')}`;

/** Load the dist build, which is what a consumer gets. */
function loadSdk() {
    return require(path.join(__dirname, '..', 'src', 'sdk', 'ts', 'dist', 'index.js'));
}

/**
 * Builds one record's mutation.
 *
 * The payload length is what decides where the WAL entry lands relative to
 * the sector boundary, so the distribution is deliberately wide and skewed
 * toward the small sizes that put a boundary in the middle of the log's
 * padding and split entries.
 */
function makeMutation(rng, i) {
    const r = rng();
    let len;
    if (r < 0.5) len = 1 + Math.floor(rng() * 8);
    else if (r < 0.85) len = 9 + Math.floor(rng() * 40);
    else len = 49 + Math.floor(rng() * 260);
    // A repeating alphabet so a corrupted record is visible as a byte-level
    // difference rather than only as a length difference.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let payload = '';
    for (let k = 0; k < len; k++) payload += alphabet[Math.floor(rng() * alphabet.length)];
    return {
        key: pad(i),
        n: i % 0xffffffff,
        ratio: (rng() - 0.5) * 1e6,
        // Drawn in every mode so the sequence of random numbers a run
        // consumes does not depend on the mode: `scalar` must differ from
        // `full` by one field, not by a different workload.
        payload: WITH_STRING ? payload : '',
    };
}

async function run() {
    const { TakyonDB, TakyonSchema } = loadSdk();
    const rng = makeRng(SEED);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-crashprop-'));
    dataDirForFailure = dataDir;
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
        // Automatic snapshots would make recovery read the snapshot instead
        // of the log, which is a different code path and would let this
        // suite pass while the log path stayed broken.
        '--checkpoint-sec',
        '3600',
    ];

    cleanShm();
    let daemon = await startDaemon({ args, readyPattern: /Server ready/ });
    const schema = new TakyonSchema(SCHEMA);
    let db = new TakyonDB(takyondb, ARENA_SIZE);
    let rows = db.collection('cp', schema);
    const regions = db.client.getRegions();

    // The mutation log, kept here rather than in the engine: it is the
    // oracle, and an oracle inside the system under test is not an oracle.
    const log = [];
    let committed = 0;
    // Keys are never reused. An earlier version trimmed the log and reset
    // keyIndex to match, which made `insert` overwrite records it had already
    // written: the key still resolved and `n` still matched, because a
    // repeated key carries a repeated index, while `ratio` and `payload`
    // were drawn fresh -- so the oracle reported the engine's correct
    // behaviour as data loss. Bounding the oracle by dropping keys is not
    // available; bounding it by verifying a window is, below.
    let keyIndex = 0;
    let crashes = 0;

    const writeBatch = async (count) => {
        for (let k = 0; k < count; k++) {
            const m = makeMutation(rng, keyIndex++);
            rows.insert(
                m.key,
                WITH_STRING ? { n: m.n, ratio: m.ratio, payload: m.payload } : { n: m.n, ratio: m.ratio }
            );
            log.push(m);
        }
    };

    const commit = async () => {
        try {
            db.client.commit(30000);
        } catch (e) {
            // The ring counters say which side stopped moving: a ring with a
            // backlog means the flusher stalled, an empty ring means the
            // barrier is not seeing progress it should.
            const stats = db.client.ringStats();
            // The daemon's own counters decide which side stopped: `wal_bytes`
            // still climbing means the flusher is alive and the barrier is not
            // being published; frozen means the flusher thread itself is stuck.
            const metrics = daemon.adminPort ? await admin(daemon.adminPort, 'METRICS') : null;
            fail(
                `commit() failed: ${e.message}\n` +
                    `  ring: ${JSON.stringify(stats)}\n` +
                    `  daemon: ${metrics ? metrics.trim() : 'no answer'}\n` +
                    `  keys written: ${keyIndex}, committed prefix: ${committed}`
            );
        }
        committed = log.length;
    };

    /**
     * Checks the two claims recovery makes, and only those.
     *
     * A record written before the last successful `commit()` is recovered
     * exactly. That is the whole contract `commit()` sells, so it is
     * asserted on every record every trial.
     *
     * A record written after it may be absent, present and exact, or present
     * and partial -- and reading a partial one can fail, because the log is a
     * prefix at sector granularity and the arena keeps whatever the dead
     * process left in it. So uncommitted keys are checked through
     * `search_index` only: an offset that lands outside the record region
     * would mean the index points at something that is not a record, and
     * that is asserted regardless of commitment.
     */
    // Which committed records to check. Everything inside the recent window,
    // plus a fixed stride over everything older, so a long run still checks
    // its early records -- those are the ones a rewound bump or a stale index
    // would break -- without the cost growing with the run.
    const shouldVerify = (i, expected) => i >= expected - VERIFY_WINDOW || i % VERIFY_STRIDE === 0;

    const verify = (trial, expected) => {
        // A delta the flusher discarded is a delta the log never received,
        // and `commit()` still returned for the record that carried it: the
        // barrier publishes the ring's consumed position, which advances when
        // a delta is popped, not when it is written. If this counter is ever
        // non-zero, every committed-data assertion below is void, so it is
        // checked first and by name.
        const ringStats = db.client.ringStats();
        if (ringStats.dropped_total !== 0) {
            fail(
                `trial ${trial}: the flusher dropped ${ringStats.dropped_total} delta(s). A dropped ` +
                    'delta is one the log never received, so no committed record is durable.'
            );
        }
        for (let i = 0; i < expected; i++) {
            if (!shouldVerify(i, expected)) continue;
            const m = log[i];
            const off = takyondb.search_index(`cp:${m.key}`);
            if (off < 0) {
                // The daemon's own boot log, because "the key is gone" has
                // three distinct causes that look identical from here: the
                // index operation never reached the log, it was replayed and
                // refused, or it was replayed and the ART insert failed.
                // The bootloader counts the first two, so its words decide
                // which question to ask next.
                // Unfiltered: the interesting line may be a WARNING about a
                // truncated sector rather than a bootloader line, and a
                // filter that hides it hides the answer.
                const boot = (daemon.output || '').split('\n').slice(-14).join('\n      ');
                fail(
                    `trial ${trial}: committed ${m.key} (log ${i}) is not in the index after ` +
                        `the kill\n      daemon said:\n      ${boot}`
                );
            }
            if (off < regions.recordStart || off + SCHEMA_SIZE > regions.recordStart + regions.recordBytes) {
                fail(
                    `trial ${trial}: committed ${m.key} resolves to ${off}, outside the record ` +
                        `region [${regions.recordStart}, ${regions.recordStart + regions.recordBytes})`
                );
            }
            // The string extent itself, read raw, so a pointer into the wrong
            // region is reported as that rather than as a decode error much
            // further along. The offsets come from the compiled schema.
            if (WITH_STRING) {
                const raw = new DataView(takyondb.initSharedMemory(ARENA_SIZE));
                const at = off + schema.fields.payload.offset;
                const strOff = raw.getUint32(at, true);
                const strLen = raw.getUint32(at + 4, true);
                if (strOff < regions.stringStart || strOff + strLen > regions.stringStart + regions.stringBytes) {
                    fail(
                        `trial ${trial}: committed ${m.key} (log ${i}) points its payload at ` +
                            `[${strOff}, ${strOff + strLen}), outside the string region ` +
                            `[${regions.stringStart}, ${regions.stringStart + regions.stringBytes})`
                    );
                }
            }
            const row = rows.find(m.key);
            if (!row) fail(`trial ${trial}: committed record ${m.key} did not recover`);
            const got = WITH_STRING
                ? `${row.n}|${row.ratio}|${row.payload}`
                : `${row.n}|${row.ratio}`;
            const want = WITH_STRING
                ? `${m.n}|${m.ratio}|${m.payload}`
                : `${m.n}|${m.ratio}`;
            if (got !== want) {
                fail(
                    `trial ${trial}: committed ${m.key} (log ${i}) recovered as ${got.slice(0, 80)}, ` +
                        `expected ${want.slice(0, 80)}`
                );
            }
        }

        let uncommitted = 0;
        for (let i = expected; i < log.length; i++) {
            if (!shouldVerify(i, expected)) continue;
            const m = log[i];
            const off = takyondb.search_index(`cp:${m.key}`);
            if (off < 0) continue;
            uncommitted++;
            if (off < regions.recordStart || off + SCHEMA_SIZE > regions.recordStart + regions.recordBytes) {
                fail(
                    `trial ${trial}: uncommitted ${m.key} (log ${i}) resolves to ${off}, outside the ` +
                        `record region [${regions.recordStart}, ${regions.recordStart + regions.recordBytes})`
                );
            }
        }
        return uncommitted;
    };

    console.log(
        `[E2E CrashProperty] mode=${MODE} seed=${SEED} trials=${TRIALS} ` +
            `records/trial=${RECORDS_PER_TRIAL} commit every ${COMMIT_EVERY} ` +
            `string field: ${WITH_STRING ? 'yes' : 'no'}`
    );
    console.log(
        `[E2E CrashProperty] record region [${regions.recordStart}, ` +
            `${regions.recordStart + regions.recordBytes}), ring ${regions.ringCapacity}`
    );

    // Commits happen at every COMMIT_EVERY boundary and once more at the end
    // of each trial. Keying a commit to an exact multiple of the batch size
    // meant a trial whose length was not a divisor of it committed nothing at
    // all: the committed-data assertion went vacuous and the suite still
    // reported a pass. Every trial now ends with at least one commit.
    let nextCommit = COMMIT_EVERY;
    // `noalloc` writes only in the first trial, so recovery is exercised
    // repeatedly with nothing allocated in between. `single` then stops.
    const writeInTrial = (trial) => MODE !== 'noalloc' || trial === 0;
    const trialsToRun = MODE === 'single' ? 1 : TRIALS;

    for (let trial = 0; trial < trialsToRun; trial++) {
        if (writeInTrial(trial)) {
            const target = RECORDS_PER_TRIAL - (keyIndex % RECORDS_PER_TRIAL);
            const trialStart = keyIndex;
            while (nextCommit <= trialStart + target) {
                await writeBatch(nextCommit - keyIndex);
                await commit();
                nextCommit += COMMIT_EVERY;
            }
            await writeBatch(trialStart + target - keyIndex);
            await commit();
        }

        // Kill without a graceful shutdown: no drain, no checkpoint, no
        // unlink. This is the only kind of kill the property is about.
        const expected = committed;
        db.client.shutdownEngine();
        daemon.proc.kill('SIGKILL');
        await stopDaemon(daemon);
        crashes++;

        daemon = await startDaemon({ args, readyPattern: /Server ready/ });
        db = new TakyonDB(takyondb, ARENA_SIZE);
        rows = db.collection('cp', schema);

        const uncommitted = verify(trial, expected);
        if (trial % 10 === 0 || trial === trialsToRun - 1) {
            console.log(
                `[E2E CrashProperty]   trial ${trial}: ${crashes} kill(s), ` +
                    `${expected} committed + ${log.length - expected} uncommitted written, ` +
                    `${uncommitted} uncommitted recovered`
            );
        }
        await sleep(5);
    }

    // Finish clean so the suite leaves no live daemon behind.
    commit();
    db.client.shutdownEngine();
    await stopDaemon(daemon);
    cleanShm();
    fs.rmSync(dataDir, { recursive: true, force: true });

    console.log(
        `[E2E CrashProperty] SUCCESS: ${crashes} SIGKILL(s) in mode '${MODE}', every committed ` +
            'record recovered exactly, and no key resolving outside its region.'
    );
    process.exit(0);
}

run().catch((e) => {
    cleanShm();
    fail(e.stack || e.message);
});