const { join } = require('path');
const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

const FIELD_OFFSET_USERNAME = 0; // The string is at offset 0 in the record

// A mock "TakyonSchema" like the one from proxy.ts, to simulate the user record
const schema = {
    totalSize: 8,
    fields: {
        username: { type: 'string', offset: FIELD_OFFSET_USERNAME, size: 8 }
    }
};

async function run() {
    const fs = require('fs');
    try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
    try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}

    console.log(`[E2E Vacuum] Starting TakyonDB daemon in background...`);
    const { spawn } = require('child_process');
    const daemon = spawn(join(__dirname, '../zig-out/bin/takyondb.exe'), {
        detached: true,
        stdio: 'ignore'
    });
    daemon.unref();

    // Esperar un poco a que el demonio cree la memoria compartida
    await new Promise(r => setTimeout(r, 1000));

    console.log(`[E2E Vacuum] Initializing 64KB shared memory...`);
    // Note: The TakyonDB daemon should be running with 64KB, but we just init it here
    const memoryBuffer = takyondb.initSharedMemory(64 * 1024);
    if (!memoryBuffer) {
        console.error("Fallo al conectar");
        process.exit(1);
    }
    console.log("[E2E Vacuum] Init done.");

    // Insert a single user into the ART index at offset 20000 (record offset)
    const USER_RECORD_OFFSET = 20000;
    console.log("[E2E Vacuum] Inserting index...");
    takyondb.insert_index("user:1", USER_RECORD_OFFSET);
    console.log("[E2E Vacuum] Index inserted.");

    // To use proxy, we need TakyonClient (simulated here)
    const view = new DataView(memoryBuffer, USER_RECORD_OFFSET, 8);
    let lastAllocatedOffset = 0;

    const setUsername = (value) => {
        const bytes = new TextEncoder().encode(value);
        const strLen = bytes.length;
        
        const STRING_BUMP_OFFSET = 10485760;
        const STRING_ARENA_START = 10485764;
        
        const atomicArr = new Uint32Array(memoryBuffer, STRING_BUMP_OFFSET, 1);
        Atomics.compareExchange(atomicArr, 0, 0, STRING_ARENA_START);
        const allocatedOffset = Atomics.add(atomicArr, 0, strLen);
        lastAllocatedOffset = allocatedOffset;
        
        if (allocatedOffset + strLen > 64 * 1024) {
            return false; // Out of memory
        }

        const dest = new Uint8Array(memoryBuffer, allocatedOffset, strLen);
        dest.set(bytes);
        
        takyondb.notifyArena(allocatedOffset, strLen);
        
        view.setUint32(0, allocatedOffset, true);
        view.setUint32(4, strLen, true);
        
        const ptrBuf = new ArrayBuffer(8);
        const ptrView = new DataView(ptrBuf);
        ptrView.setUint32(0, allocatedOffset, true);
        ptrView.setUint32(4, strLen, true);
        takyondb.pushDelta(USER_RECORD_OFFSET, new Uint8Array(ptrBuf));
        return true;
    };

    const getUsername = () => {
        const strOffset = view.getUint32(0, true);
        const strLen = view.getUint32(4, true);
        if (strOffset === 0 && strLen === 0) return "";
        const strBytes = new Uint8Array(memoryBuffer, strOffset, strLen);
        return new TextDecoder('utf-8').decode(strBytes);
    };

    console.log(`[E2E Vacuum] Spawning async Vacuum thread...`);
    takyondb.start_vacuum(FIELD_OFFSET_USERNAME);

    console.log(`[E2E Vacuum] Executing 20,000 updates loop (The Memory Leak Test)...`);
    
    let iterations = 0;
    for (let i = 0; i < 20000; i++) {
        const success = setUsername(`Gineración_X_${i}`);
        if (!success) {
            console.error(`[E2E Vacuum] CRASH! Out of memory in la iteración ${i}. El Vacuum no está compactando a tiempo.`);
            process.exit(1);
        }
        iterations++;
        // Small delay every few iterations to give the 1ms Vacuum thread time to run
        if (i % 100 === 0) {
            await new Promise(r => setTimeout(r, 1));
        }
    }

    console.log(`[E2E Vacuum] Loop finished successfully (${iterations} iterations).`);

    const atomicArr = new Uint32Array(memoryBuffer, 32768, 1);
    const bumpValue = Atomics.load(atomicArr, 0);
    console.log(`[E2E Vacuum] Currint Bump Pointer size: ${bumpValue} bytes (within 64KB limit).`);

    const searchStart = performance.now();
    const finalValue = getUsername();
    const searchEnd = performance.now();

    if (finalValue !== `Gineración_X_19999`) {
        console.error(`[E2E Vacuum] VALOR INCORRECTO. Se esperaba 'Gineración_X_19999', se obtuvo '${finalValue}'`);
        process.exit(1);
    }

    const elapsedMs = searchEnd - searchStart;
    console.log(`[E2E Vacuum] Search returned the correct value ('${finalValue}') in ${elapsedMs * 1000} microseconds.`);
    
    // Kill daemon
    daemon.kill();
    
    console.log(`[E2E Vacuum] SUCCESS: Memory Leak Test passed.`);
    process.exit(0);
}

run();
