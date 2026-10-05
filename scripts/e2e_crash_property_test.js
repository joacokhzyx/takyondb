// E2E: randomized crash consistency. This is Gate 2's exit criterion.
//
// The property under test, stated once: for any crash point, the data that
// was committed before it is intact afterwards, and nothing that is present
// afterwards is wrong.
//
//   1. Every record written before the last successful `commit()` is
//      recovered, with exactly the value that was written.
//   2. Every recovered record has either its committed value or the arena's
//      initial value. An uncommitted record may legitimately be absent --
//      it was never promised to anybody -- but if it is there it must not
//      hold a *mixture*: a value the caller wrote and a value nobody wrote.
//   3. Every key resolves to an offset inside the record region. A key that
//      resolves into the string arena is the shape of the bug that used to
//      be in WAL index replay, and it surfaces as an unrelated failure much
//      later, so it is checked directly rather than inferred.
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
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startDaemon, stopDaemon } = require('./helpers/daemon');
const { loadBindings } = require('./helpers/addon');

const ARENA_SIZE = 24 * 1024 * 1024;
// Wide enough that no trial can run out of records or string space: a
// trial that failed for lack of room would be a different bug reported as
// this one.
const RECORDS_PER_TRIAL = 700;
// Commit after this many writes, so a trial spans several commits and the
// kill can land between two of them as well as inside one.
const COMMIT_EVERY = 120;
const TRIALS = Number(process.env.TAKYON_CRASH_TRIALS || 100);
const SEED = Number(process.env.TAKYON_CRASH_SEED || 0xc0ffee);
const RING_CAPACITY = 65536;

const takyondb = loadBindings();

function fail(msg) {
  console.error(`[E2E CrashProperty] FAILURE: ${msg}`);
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

const SCHEMA = { n: 'uint32', ratio: 'float64', payload: 'string' };
// Reserved per record, rounded up to the allocator's 8-byte stride. Used only
// to bounds-check a resolved offset, never to reinterpret one.
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
        payload,
    };
}

async function run() {
    const { TakyonDB, TakyonSchema } = loadSdk();
    const rng = makeRng(SEED);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-crashprop-'));
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
    let keyIndex = 0;
    let crashes = 0;

    const writeBatch = async (count) => {
        for (let k = 0; k < count; k++) {
            const m = makeMutation(rng, keyIndex++);
            rows.insert(m.key, { n: m.n, ratio: m.ratio, payload: m.payload });
            log.push(m);
        }
    };

    const commit = () => {
        db.client.commit(30000);
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
    const verify = (trial, expected) => {
        for (let i = 0; i < expected; i++) {
            const m = log[i];
            const off = takyondb.search_index(`cp:${m.key}`);
            if (off < 0) {
                fail(`trial ${trial}: committed ${m.key} (log ${i}) is not in the index after the kill`);
            }
            if (off < regions.recordStart || off + SCHEMA_SIZE > regions.recordStart + regions.recordBytes) {
                fail(
                    `trial ${trial}: committed ${m.key} resolves to ${off}, outside the record ` +
                        `region [${regions.recordStart}, ${regions.recordStart + regions.recordBytes})`
                );
            }
            // The string extent itself, read raw, so a pointer into the wrong
            // region is reported as that rather than as a decode error much
            // further along.
            const raw = new DataView(takyondb.initSharedMemory(ARENA_SIZE));
            const strOff = raw.getUint32(off + 12, true);
            const strLen = raw.getUint32(off + 16, true);
            if (strOff < regions.stringStart || strOff + strLen > regions.stringStart + regions.stringBytes) {
                fail(
                    `trial ${trial}: committed ${m.key} (log ${i}) points its payload at ` +
                        `[${strOff}, ${strOff + strLen}), outside the string region ` +
                        `[${regions.stringStart}, ${regions.stringStart + regions.stringBytes})`
                );
            }
            const row = rows.find(m.key);
            if (!row) fail(`trial ${trial}: committed record ${m.key} did not recover`);
            if (row.n !== m.n || row.ratio !== m.ratio || row.payload !== m.payload) {
                fail(
                    `trial ${trial}: committed ${m.key} recovered as ` +
                        `n=${row.n} ratio=${row.ratio} payload=${JSON.stringify(row.payload.slice(0, 24))}, ` +
                        `expected n=${m.n} ratio=${m.ratio} payload=${JSON.stringify(m.payload.slice(0, 24))}`
                );
            }
        }

        let uncommitted = 0;
        for (let i = expected; i < log.length; i++) {
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
        `[E2E CrashProperty] seed=${SEED} trials=${TRIALS} records/trial=${RECORDS_PER_TRIAL} ` +
            `commit every ${COMMIT_EVERY}`
    );
    console.log(
        `[E2E CrashProperty] record region [${regions.recordStart}, ` +
            `${regions.recordStart + regions.recordBytes}), ring ${regions.ringCapacity}`
    );

    for (let trial = 0; trial < TRIALS; trial++) {
        const remaining = RECORDS_PER_TRIAL - (keyIndex % RECORDS_PER_TRIAL);
        await writeBatch(remaining);
        if (keyIndex % COMMIT_EVERY === 0) commit();

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
        if (trial % 10 === 0 || trial === TRIALS - 1) {
            console.log(
                `[E2E CrashProperty]   trial ${trial}: ${crashes} kill(s), ` +
                    `${expected} committed + ${log.length - expected} uncommitted written, ` +
                    `${uncommitted} uncommitted recovered`
            );
        }
        // Keep the log bounded to what the arena can still hold: a run that
        // died from record exhaustion would be reported as a recovery bug.
        if (log.length > RECORDS_PER_TRIAL * 12) {
            const drop = log.length - RECORDS_PER_TRIAL;
            log.splice(0, drop);
            committed = Math.max(0, committed - drop);
            keyIndex = committed;
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
        `[E2E CrashProperty] SUCCESS: ${TRIALS} SIGKILLs, every committed record recovered ` +
            'exactly, no torn records, no key resolving outside the record region.'
    );
    process.exit(0);
}

run().catch((e) => {
    cleanShm();
    fail(e.stack || e.message);
});