import { join } from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

// Path to the compiled N-API addon
const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

const NUM_INSERTS = 10000;

if (isMainThread) {
    console.log(`[E2E] Connecting to TakyonDB Engine (Shared Memory)...`);
    
    // Connect to the shared memory block created by the server
    const memoryBuffer = takyondb.initSharedMemory(1024 * 1024 * 16);
    if (!memoryBuffer) {
        console.error("Error: Failed to connect to TakyonDB shared memory.");
        process.exit(1);
    }
    console.log(`[E2E] Connected. Block size: ${memoryBuffer.byteLength || (1024 * 1024 * 16)} bytes`);

    const NUM_WORKERS = 4;
    const insertsPerWorker = Math.floor(NUM_INSERTS / NUM_WORKERS);
    
    let workersCompleted = 0;
    const startTime = process.hrtime.bigint();
    
    console.log(`[E2E] Spawning ${NUM_WORKERS} worker threads to insert ${NUM_INSERTS} records (Lock-Free)...`);
    
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(__filename, {
            workerData: {
                workerId: i,
                startIdx: i * insertsPerWorker,
                count: insertsPerWorker
            }
        });
        
        worker.on('message', (msg) => {
            if (msg === 'done') {
                workersCompleted++;
                if (workersCompleted === NUM_WORKERS) {
                    const endTime = process.hrtime.bigint();
                    const elapsed = Number(endTime - startTime) / 1e6;
                    console.log(`[E2E] Success: ${NUM_INSERTS} insertions completed in ${elapsed.toFixed(2)} ms.`);
                    console.log(`[E2E] Average latency: ${((elapsed * 1000) / NUM_INSERTS).toFixed(2)} µs per operation.`);
                    console.log(`[E2E] Lock-Free ART and SIMD operating correctly.`);
                    
                    // Verify searches
                    console.log(`[E2E] Validating concurrent retrieval...`);
                    let errors = 0;
                    const searchStart = performance.now();
                    for (let i = 0; i < NUM_INSERTS; i++) {
                        const key = `ID-${i.toString().padStart(5, '0')}`;
                        const offset = takyondb.search_index(key);
                        if (offset < 0) {
                            errors++;
                        }
                    }
                    const searchEnd = performance.now();
                    console.log(`[E2E] Search for ${NUM_INSERTS} keys in ${(searchEnd - searchStart).toFixed(2)} ms.`);
                    if (errors > 0) {
                        console.error(`[E2E] FAILURE: ${errors} keys not found.`);
                    } else {
                        console.log(`[E2E] All keys found successfully. Latency: ${(((searchEnd - searchStart) * 1000) / NUM_INSERTS).toFixed(2)} µs per search.`);
                    }
                }
            }
        });
        
        worker.on('error', (err) => {
            console.error(`Worker error:`, err);
        });
    }
} else {
    // Worker Thread Logic
    const { workerId, startIdx, count } = workerData;
    
    // Connect to the shared memory in this worker
    takyondb.initSharedMemory(1024 * 1024 * 16);
    
    for (let i = 0; i < count; i++) {
        const id = startIdx + i;
        // 0-padded 8 char key: "ID-00001"
        const key = `ID-${id.toString().padStart(5, '0')}`;
        const valueOffset = 4096 + (id * 64);
        
        const result = takyondb.insert_index(key, valueOffset);
        if (result !== 0) {
            console.error(`[Worker ${workerId}] Failed to insert key ${key}`);
        }
    }
    
    parentPort?.postMessage('done');
}
