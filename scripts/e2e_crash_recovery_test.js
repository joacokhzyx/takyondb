const { join } = require('path');
const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

const NUM_INSERTS_BEFORE = 5000;
const RESIDUAL_OFFSET = 3000000; // An offset far in the arena
const RESIDUAL_SIZE = 4086; // 4086 + 6 byte header = 4092 (perfect sector flush)

async function run() {
    const isVerification = process.argv.includes('--verify');

    if (isVerification) {
        console.log(`[E2E] Fase de Verificación Post-Crash...`);
        const memoryBuffer = takyondb.initSharedMemory(1024 * 1024 * 16);
        if (!memoryBuffer) {
            console.error("Fallo al conectar post-crash");
            process.exit(1);
        }

        // 1. Verify 5000 records from Snapshot
        let errors = 0;
        const searchStart = performance.now();
        for (let i = 0; i < NUM_INSERTS_BEFORE; i++) {
            const key = `SNAP-${i.toString().padStart(5, '0')}`;
            const offset = takyondb.search_index(key);
            if (offset < 0) {
                errors++;
            }
        }
        const searchEnd = performance.now();
        console.log(`[E2E] Búsqueda de ${NUM_INSERTS_BEFORE} claves (Snapshot ART Index) in ${searchEnd - searchStart} ms.`);
        
        // 2. Verify Residual WAL Data
        const view = new DataView(memoryBuffer);
        let validResidual = true;
        for (let i = 0; i < RESIDUAL_SIZE; i++) {
            if (view.getUint8(RESIDUAL_OFFSET + i) !== 0xAA) {
                validResidual = false;
                break;
            }
        }

        if (errors > 0 || !validResidual) {
            console.error(`[E2E] FALLO: ${errors} claves no incontradas, Residual Válido: ${validResidual}`);
            process.exit(1);
        } else {
            console.log(`[E2E] ÉXITO: Snapshot ART y WAL Residual recuperados perfectaminte post-crash.`);
            process.exit(0);
        }
    }

    console.log(`[E2E] Fase de Inserción y Snapshot...`);
    const memoryBuffer = takyondb.initSharedMemory(1024 * 1024 * 16);
    if (!memoryBuffer) {
        console.error("Fallo al conectar");
        process.exit(1);
    }

    // 1. Insert 5000 records
    for (let i = 0; i < NUM_INSERTS_BEFORE; i++) {
        const key = `SNAP-${i.toString().padStart(5, '0')}`;
        const valOffset = 4096 + (i * 64);
        takyondb.insert_index(key, valOffset);
    }
    console.log(`[E2E] Insertados ${NUM_INSERTS_BEFORE} registros.`);

    // 2. Trigger Checkpoint
    console.log(`[E2E] Disparando Checkpoint (Snapshot)...`);
    takyondb.trigger_checkpoint();

    // Wait a bit to insure flusher creates the snapshot and rotates WAL
    await new Promise(r => setTimeout(r, 1000));

    // 3. Insert Residual Data directly to Shared Memory
    const view = new DataView(memoryBuffer);
    for (let i = 0; i < RESIDUAL_SIZE; i++) {
        view.setUint8(RESIDUAL_OFFSET + i, 0xAA);
    }
    
    // Notify Arena to push a delta of EXACTLY 4086 bytes (this will trigger a flush immediately)
    takyondb.notifyArena(RESIDUAL_OFFSET, RESIDUAL_SIZE);
    console.log(`[E2E] Insertados ${RESIDUAL_SIZE} bytes adicionales (WAL residual).`);
    
    // Wait for the flusher to write it to disk before we crash
    await new Promise(r => setTimeout(r, 500));
    
    console.log(`[E2E] Fase de inserción completada. Por favor, mata el proceso del Daemon (SIGKILL) y luego corre este script con --verify.`);
}

run();
