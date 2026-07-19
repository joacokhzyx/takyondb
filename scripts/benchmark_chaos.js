const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { join } = require('path');
const { performance } = require('perf_hooks');

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
let takyondb;
try {
    takyondb = require(ADDON_PATH);
} catch (e) {
    if (isMainThread) {
        console.error("Failed to load TakyonDB addon. Did you compile it?");
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

    console.log(`[Chaos] Starting TakyonDB daemon...`);
    const { spawn } = require('child_process');
    const daemon = spawn(join(__dirname, '../zig-out/bin/takyondb.exe'), {
        detached: true,
        stdio: 'ignore'
    });
    daemon.unref();

    // Wait for daemon
    setTimeout(() => {
        const memoryBuffer = takyondb.initSharedMemory(MEMORY_SIZE);
        if (!memoryBuffer) {
            console.error("[Chaos] Failed to map shared memory");
            process.exit(1);
        }
        console.log(`[Chaos] Memory mapped. Spawning ${TOTAL_WORKERS} workers...`);
        
        takyondb.start_vacuum(FIELD_OFFSET_USERNAME);

        let completed = 0;
        const latencies = [];

        for (let i = 0; i < TOTAL_WORKERS; i++) {
            const worker = new Worker(__filename, {
                workerData: { workerId: i, ops: OPERATIONS_PER_WORKER }
            });

            worker.on('message', (msg) => {
                if (msg.type === 'done') {
                    latencies.push(...msg.latencies);
                    completed++;
                    if (completed === TOTAL_WORKERS) {
                        analyzeResults(latencies);
                        daemon.kill();
                        process.exit(0);
                    }
                }
            });
            worker.on('error', (err) => {
                console.error(`Worker error:`, err);
                daemon.kill();
                process.exit(1);
            });
        }
        
        // Simulating Chaos Checkpoints
        const chaosInterval = setInterval(() => {
            console.log(`[Chaos] Triggering Checkpoint...`);
            takyondb.trigger_checkpoint();
        }, 500);
        
        setTimeout(() => clearInterval(chaosInterval), 5000);
        
    }, 1000);

    function analyzeResults(lats) {
        lats.sort((a, b) => a - b);
        const p50 = lats[Math.floor(lats.length * 0.5)];
        const p95 = lats[Math.floor(lats.length * 0.95)];
        const p99 = lats[Math.floor(lats.length * 0.99)];
        const max = lats[lats.length - 1];
        
        console.log(`\n========================================`);
        console.log(`[Chaos Benchmark Results]`);
        console.log(`Total Operations: ${lats.length}`);
        console.log(`p50 Latency: ${p50.toFixed(3)} ms`);
        console.log(`p95 Latency: ${p95.toFixed(3)} ms`);
        console.log(`p99 Latency: ${p99.toFixed(3)} ms`);
        console.log(`Max Latency: ${max.toFixed(3)} ms`);
        console.log(`========================================\n`);
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
            updateString(recordOffset, `Value_${workerId}_${i}`);
        } else {
            // Update
            updateString(recordOffset, `Updated_${workerId}_${i}`);
        }
        
        latencies[i] = performance.now() - start;
    }
    
    parentPort.postMessage({ type: 'done', latencies: Array.from(latencies) });
    
    function updateString(recordOffset, value) {
        const bytes = new TextEncoder().encode(value);
        const strLen = bytes.length;
        
        const STRING_BUMP_OFFSET = 10485760;
        const STRING_ARENA_START = 10485764;
        
        const atomicArr = new Uint32Array(memoryBuffer, STRING_BUMP_OFFSET, 1);
        Atomics.compareExchange(atomicArr, 0, 0, STRING_ARENA_START);
        const allocatedOffset = Atomics.add(atomicArr, 0, strLen);
        
        const dest = new Uint8Array(memoryBuffer, allocatedOffset, strLen);
        dest.set(bytes);
        
        takyondb.notifyArena(allocatedOffset, strLen);
        
        const ptrBuf = new ArrayBuffer(8);
        const ptrView = new DataView(ptrBuf);
        ptrView.setUint32(0, allocatedOffset, true);
        ptrView.setUint32(4, strLen, true);
        takyondb.pushDelta(recordOffset + FIELD_OFFSET_USERNAME, new Uint8Array(ptrBuf));
    }
}
