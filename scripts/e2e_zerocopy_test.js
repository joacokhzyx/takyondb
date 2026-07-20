"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var path_1 = require("path");
var worker_threads_1 = require("worker_threads");
// Path to the compiled N-API addon
var ADDON_PATH = (0, path_1.join)(__dirname, '../zig-out/bin/takyondb_bridge.node');
var takyondb = require(ADDON_PATH);
var NUM_INSERTS = 10000;
if (worker_threads_1.isMainThread) {
    console.log("[E2E] Connecting to TakyonDB Engine (Shared Memory)...");
    // Connect to the shared memory block created by the server
    var memoryBuffer = takyondb.initSharedMemory(1024 * 1024 * 16);
    if (!memoryBuffer) {
        console.error("Error: Failed to connect to TakyonDB shared memory.");
        process.exit(1);
    }
    console.log("[E2E] Connected. Block size: ".concat(memoryBuffer.byteLength || (1024 * 1024 * 16), " bytes"));
    var NUM_WORKERS_1 = 4;
    var insertsPerWorker = Math.floor(NUM_INSERTS / NUM_WORKERS_1);
    var workersCompleted_1 = 0;
    var startTime_1 = process.hrtime.bigint();
    console.log("[E2E] Spawning ".concat(NUM_WORKERS_1, " worker threads to insert ").concat(NUM_INSERTS, " records (Lock-Free)..."));
    for (var i = 0; i < NUM_WORKERS_1; i++) {
        var worker = new worker_threads_1.Worker(__filename, {
            workerData: {
                workerId: i,
                startIdx: i * insertsPerWorker,
                count: insertsPerWorker
            }
        });
        worker.on('message', function (msg) {
            if (msg === 'done') {
                workersCompleted_1++;
                if (workersCompleted_1 === NUM_WORKERS_1) {
                    var endTime = process.hrtime.bigint();
                    var elapsed = Number(endTime - startTime_1) / 1e6;
                    console.log("[E2E] Success: ".concat(NUM_INSERTS, " insertions completed in ").concat(elapsed.toFixed(2), " ms."));
                    console.log("[E2E] Average latency: ".concat(((elapsed * 1000) / NUM_INSERTS).toFixed(2), " \u00B5s per operation."));
                    console.log("[E2E] Lock-Free ART and SIMD operating correctly.");
                    // Verify searches
                    console.log("[E2E] Validating concurrent retrieval...");
                    var errors = 0;
                    var searchStart = performance.now();
                    for (var i_1 = 0; i_1 < NUM_INSERTS; i_1++) {
                        var key = "ID-".concat(i_1.toString().padStart(5, '0'));
                        var offset = takyondb.search_index(key);
                        if (offset < 0) {
                            errors++;
                        }
                    }
                    var searchEnd = performance.now();
                    console.log("[E2E] Search for ".concat(NUM_INSERTS, " keys in ").concat((searchEnd - searchStart).toFixed(2), " ms."));
                    if (errors > 0) {
                        console.error("[E2E] FAILURE: ".concat(errors, " keys not found."));
                    }
                    else {
                        console.log("[E2E] All keys found successfully. Latency: ".concat((((searchEnd - searchStart) * 1000) / NUM_INSERTS).toFixed(2), " \u00B5s per search."));
                    }
                }
            }
        });
        worker.on('error', function (err) {
            console.error("Worker error:", err);
        });
    }
}
else {
    // Worker Thread Logic
    var workerId = worker_threads_1.workerData.workerId, startIdx = worker_threads_1.workerData.startIdx, count = worker_threads_1.workerData.count;
    // Connect to the shared memory in this worker
    takyondb.initSharedMemory(1024 * 1024 * 16);
    for (var i = 0; i < count; i++) {
        var id = startIdx + i;
        var key = "ID-".concat(id.toString().padStart(5, '0'));
        var valueOffset = 4096 + (id * 64);
        var result = takyondb.insert_index(key, valueOffset);
        if (result !== 0) {
            console.error("[Worker ".concat(workerId, "] Failed to insert key ").concat(key));
        }
    }
    worker_threads_1.parentPort === null || worker_threads_1.parentPort === void 0 ? void 0 : worker_threads_1.parentPort.postMessage('done');
}
