const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { join } = require('path');
const { performance } = require('perf_hooks');

const { startDaemon } = require('./helpers/daemon');
const { loadBindings } = require('./helpers/addon');

let takyondb;
try {
    takyondb = loadBindings();
} catch (e) {
    if (isMainThread) {
        console.error(`Failed to load TakyonDB addon: ${e && e.message ? e.message : e}`);
        process.exit(1);
    }
}

const TOTAL_WORKERS = 4;
const OPERATIONS_PER_WORKER = 50000;
const MEMORY_SIZE = 64 * 1024 * 1024; // 64MB for stress test
const FIELD_OFFSET_USERNAME = 0;
const RECORD_SIZE = 8;
const MAX_RECORDS = 50000;
const RECORD_ARENA_START = 1048576; // 1MB

if (isMainThread) {
    // ----------------------------------------------------
    // MAIN THREAD - Chaos Orchestrator
    // ----------------------------------------------------
    const fs = require('fs');
    try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
    try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
    // Isolate from previous suites (foreign-size segments are refused).
    if (process.platform === 'linux') {
        try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
    }
    if (process.platform === 'darwin') {
        try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
    }

    console.log(`[Chaos] Starting TakyonDB daemon...`);
    // Explicit arena size instead of the daemon default: the two numbers
    // lived in different files and a mismatch is a hard connect failure.
    // startDaemon replaces the blind `setTimeout(..., 1000)` with a real
    // readiness handshake, and the helper's exit safety net guarantees the
    // daemon dies even on the early-exit paths below.
    startDaemon({ args: [String(MEMORY_SIZE)] }).then((daemon) => {
        const memoryBuffer = takyondb.initSharedMemory(MEMORY_SIZE);
        if (!memoryBuffer) {
            console.error("[Chaos] Failed to map shared memory");
            process.exit(1);
        }
        console.log(`[Chaos] Memory mapped. Spawning ${TOTAL_WORKERS} workers...`);
        
        takyondb.start_vacuum(FIELD_OFFSET_USERNAME);

        let completed = 0;
        const latencies = [];
        let writeAttempts = 0;
        let dropped = 0;

        for (let i = 0; i < TOTAL_WORKERS; i++) {
            const worker = new Worker(__filename, {
                workerData: { workerId: i, ops: OPERATIONS_PER_WORKER }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'done') {
                    latencies.push(...msg.latencies);
                    writeAttempts += msg.writes_attempted || 0;
                    dropped += msg.dropped || 0;
                    completed++;
                    if (completed === TOTAL_WORKERS) {
                        analyzeResults(latencies, writeAttempts, dropped);
                        daemon.proc.kill('SIGKILL');
                        process.exit(process.exitCode || 0);
                    }
                }
            });
            worker.on('error', (err) => {
                console.error(`Worker error:`, err);
                daemon.proc.kill('SIGKILL');
                process.exit(1);
            });
        }
        
        // Simulating Chaos Checkpoints
        const chaosInterval = setInterval(() => {
            console.log(`[Chaos] Triggering Checkpoint...`);
            takyondb.trigger_checkpoint();
        }, 500);
        
        setTimeout(() => clearInterval(chaosInterval), 5000);
    }).catch((e) => {
        console.error(`[Chaos] FAILURE: ${e.message}`);
        process.exit(1);
    });

    function analyzeResults(lats, writeOps, droppedOps) {
        if (!Array.isArray(lats) || lats.length === 0) {
            console.error('[Chaos] FAILURE: no latency samples were collected');
            process.exitCode = 1;
            return;
        }

        // A latency figure only means something if every operation it
        // summarizes actually landed. The previous version of this harness
        // ignored the return value of notifyArena/pushDelta, so 171,156 of
        // 200,000 writes were discarded by a full ring while the report still
        // claimed 200,000 operations — and the README quoted its p50. Fail the
        // run instead of publishing a number derived from dropped work.
        const dropRate = writeOps > 0 ? droppedOps / writeOps : 0;
        if (droppedOps > 0) {
            console.error(
                `[Chaos] FAILURE: ${droppedOps}/${writeOps} writes were dropped after ` +
                `exhausting the ring's back-pressure budget (${(dropRate * 100).toFixed(2)}%). ` +
                `The percentiles below would describe only the writes that survived, so this run ` +
                `is not publishable. Raise the arena size or lower the op count.`
            );
            process.exitCode = 1;
        }

        lats.sort((a, b) => a - b);
        const p50 = lats[Math.floor(lats.length * 0.5)];
        const p95 = lats[Math.floor(lats.length * 0.95)];
        const p99 = lats[Math.floor(lats.length * 0.99)];
        const max = lats[lats.length - 1];
        
        // Hardware report: the README quotes these percentiles, and without
        // this they cannot be attributed to any machine, so "ran on consumer
        // hardware" was not checkable by anyone.
        const os = require('os');
        const hardware = {
            platform: os.platform(),
            arch: os.arch(),
            cpu_model: (os.cpus()[0] || {}).model || 'unknown',
            cpus: os.cpus().length,
            totalmem_mb: Math.round(os.totalmem() / 1048576),
            node: process.version,
        };
        
        console.log(`\n========================================`);
        console.log(`[Chaos Benchmark Results]`);
        console.log(`Hardware: ${hardware.cpu_model} (${hardware.cpus}x ${hardware.arch}, node ${hardware.node})`);
        console.log(`Workload: ${TOTAL_WORKERS} worker_threads, ${OPERATIONS_PER_WORKER} ops each,`);
        console.log(`          20% read / 40% insert / 40% update (seeded LCG per worker),`);
        console.log(`          vacuum running and a checkpoint every 500ms.`);
        console.log(`Total Operations: ${lats.length}`);
        console.log(`Writes dropped:  ${droppedOps} / ${writeOps} write ops`);
        console.log(`p50 Latency: ${p50.toFixed(3)} ms`);
        console.log(`p95 Latency: ${p95.toFixed(3)} ms`);
        console.log(`p99 Latency: ${p99.toFixed(3)} ms`);
        console.log(`Max Latency: ${max.toFixed(3)} ms`);
        console.log(`========================================\n`);
        
        const report = {
            suite: 'chaos-saturated',
            hardware,
            workload: {
                workers: TOTAL_WORKERS,
                ops_per_worker: OPERATIONS_PER_WORKER,
                mix: '20% read / 40% insert / 40% update',
                seed: 'LCG 12345 + workerId per worker',
                note: 'per-worker sequence is deterministic; cross-worker interleaving is not',
            },
            methodology:
                'Saturated multi-worker run against a live daemon through the N-API addon. Per-op wall time via ' +
                'performance.now() around the addon call, pooled into one sample set. Helper objects (TextEncoder, ' +
                'delta pointer buffer) are hoisted per worker so the numbers reflect engine cost rather than V8 ' +
                'allocation. Absolute values are machine and scheduler specific.',
            results: {
                ops: lats.length,
                writes_dropped: droppedOps,
                writes_attempted: writeOps,
                p50_ms: p50,
                p95_ms: p95,
                p99_ms: p99,
                max_ms: max,
            },
        };
        if (process.env.BENCH_JSON_PATH) {
            require('fs').writeFileSync(process.env.BENCH_JSON_PATH, JSON.stringify(report, null, 2));
        }
    }

} else {
    // ----------------------------------------------------
    // WORKER THREAD - Saturation
    // ----------------------------------------------------
    const { workerId, ops } = workerData;
    const memoryBuffer = takyondb.initSharedMemory(MEMORY_SIZE);
    
    // Quick pseudo-random
    let seed = 12345 + workerId;
    function random() {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    }

    const latencies = new Float64Array(ops);
    // Writes that exhausted the ring's back-pressure budget. Reported to the
    // orchestrator, which refuses to publish a run that lost writes.
    let dropped = 0;
    // Write operations attempted (insert + update branches). Counted rather
    // than derived from the op mix so the drop rate has an exact denominator.
    let writeAttempts = 0;

    // How long a single push may wait for the ring to drain before the op is
    // counted as dropped. Sized to outlast a checkpoint: createSnapshot
    // serializes the whole arena, and at 64 MiB that is tens of MB written
    // while the flusher is not draining the ring.
    const PUSH_BACKPRESSURE_TIMEOUT_MS = 3000;
    
    // Worker-scoped, reused for every op. These used to be constructed inside
    // the timed region (a TextEncoder plus an 8-byte ArrayBuffer + DataView +
    // Uint8Array per operation), so the published p50/p95/p99 figures were
    // measuring V8 allocation and GC as much as the engine. Constructing a
    // TextEncoder is expensive enough to dominate an op; hoisting it is what
    // the SDK itself does, and it is what makes this number about the engine.
    const encoder = new TextEncoder();
    const STRING_BUMP_OFFSET = 10485760;
    const STRING_ARENA_START = 10485764;
    const bumpArray = new Uint32Array(memoryBuffer, STRING_BUMP_OFFSET, 1);
    const deltaPtrBuf = new ArrayBuffer(8);
    const deltaPtrView = new DataView(deltaPtrBuf);
    const deltaPtrBytes = new Uint8Array(deltaPtrBuf);
    
    for (let i = 0; i < ops; i++) {
        const start = performance.now();
        
        // Random operation: Insert or Update or Read
        const opType = random();
        const recordIndex = Math.floor(random() * MAX_RECORDS);
        const recordOffset = RECORD_ARENA_START + (recordIndex * RECORD_SIZE);
        const key = `user:${recordIndex}`;
        
        if (opType < 0.2) {
            // Read
            takyondb.search_index(key);
        } else if (opType < 0.6) {
            // Insert
            takyondb.insert_index(key, recordOffset);
            writeAttempts++;
            if (!updateString(recordOffset, `Value_${workerId}_${i}`)) dropped++;
        } else {
            // Update
            writeAttempts++;
            if (!updateString(recordOffset, `Updated_${workerId}_${i}`)) dropped++;
        }
        
        latencies[i] = performance.now() - start;
    }
    
    parentPort.postMessage({
        type: 'done',
        latencies: Array.from(latencies),
        writes_attempted: writeAttempts,
        dropped,
    });
    
    function pushWithBackpressure(push) {
        // Deadline rather than attempt count: a real client blocks until the
        // ring drains, and what it should report on failure is "I waited and
        // it never came back", not "I gave up after N tries". The pause grows
        // so a flusher that is mid-checkpoint (which writes the whole arena)
        // gets a chance to finish without the client burning a core.
        const deadline = performance.now() + PUSH_BACKPRESSURE_TIMEOUT_MS;
        let pauseMs = 0;
        for (;;) {
            if (push() === 0) return true;
            if (performance.now() >= deadline) return false;
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(waiter, 0, 0, pauseMs);
            if (pauseMs < 4) pauseMs += 1;
        }
    }
    
    function updateString(recordOffset, value) {
        const bytes = encoder.encode(value);
        const strLen = bytes.length;
        
        Atomics.compareExchange(bumpArray, 0, 0, STRING_ARENA_START);
        const allocatedOffset = Atomics.add(bumpArray, 0, strLen);
        
        const dest = new Uint8Array(memoryBuffer, allocatedOffset, strLen);
        dest.set(bytes);
        
        if (!pushWithBackpressure(() => takyondb.notifyArena(allocatedOffset, strLen))) {
            return false;
        }
        
        // Reused scratch instead of a fresh ArrayBuffer + DataView per op.
        deltaPtrView.setUint32(0, allocatedOffset, true);
        deltaPtrView.setUint32(4, strLen, true);
        return pushWithBackpressure(() => takyondb.pushDelta(recordOffset + FIELD_OFFSET_USERNAME, deltaPtrBytes));
    }
}
