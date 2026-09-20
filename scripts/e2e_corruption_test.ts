import { TakyonSchema } from '../src/sdk/client/schema';
import { TakyonClient, TakyonBindings } from '../src/sdk/client/proxy';
import { spawn } from 'child_process';
import { rmSync, existsSync, openSync, writeSync, closeSync } from 'fs';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'data.takyon');
const DAEMON_BIN = join(__dirname, '..', 'zig-out', 'bin', process.platform === 'win32' ? 'takyondb.exe' : 'takyondb');
const addon = require('../zig-out/bin/takyondb_bridge.node');

const bindings: TakyonBindings = {
    initSharedMemory: (size: number) => addon.initSharedMemory(size),
    pushDelta: (offset: number, data: Uint8Array) => addon.pushDelta(offset, data),
    notifyArena: (offset: number, size: number) => addon.notifyArena(offset, size),
    verifyTestValue: () => addon.verifyTestValue(),
    insert_index: (key: string, value_offset: number) => addon.insert_index(key, value_offset),
    search_index: (key: string) => addon.search_index(key),
    trigger_checkpoint: () => addon.trigger_checkpoint(),
    start_vacuum: (string_offset: number) => addon.start_vacuum(string_offset),
    stop_vacuum: () => addon.stop_vacuum(),
    disconnect_shm: () => addon.disconnect_shm(),
};

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function spawnDaemon(expectWarning: boolean = false): Promise<any> {
    return new Promise((resolve, reject) => {
        const daemon = spawn(DAEMON_BIN, [], { stdio: 'pipe' });
        
        let warningFound = false;
        
        daemon.stderr.on('data', (data) => {
            const str = data.toString();
            console.log(`[Daemon] ${str.trim()}`);
            if (str.includes('CRC32 corruption detected')) {
                warningFound = true;
            }
            if (str.includes('TakyonDB Server listening') || str.includes('Waiting for connections') || str.includes('Esperando')) {
                resolve({ daemon, warningFound });
            }
        });

        daemon.stdout.on('data', (data) => {
            const str = data.toString();
            console.log(`[Daemon stdout] ${str.trim()}`);
            if (str.includes('Server ready') || str.includes('Waiting for connections')) {
                resolve({ daemon, warningFound });
            }
        });
        
        daemon.on('error', (err) => {
            reject(err);
        });
    });
}

async function runCorruptionTest() {
    console.log('[E2E] Starting Physical Corruption & CRC32 Test...');
    
    if (existsSync(DB_PATH)) {
        rmSync(DB_PATH);
    }
    
    console.log('[E2E] Starting initial daemon...');
    let { daemon } = await spawnDaemon();
    
    console.log('[E2E] Connecting client and writing healthy deltas...');
    // Map the full arena: the shared 4096-slot ring alone needs 256KB,
    // and string writes live at 10MB. A smaller mapping cannot host them.
    let client = new TakyonClient(bindings, 64 * 1024 * 1024);
    const UserSchema = new TakyonSchema({
        id: 'uint32',
        role: 'uint8',
        score: 'uint32',
        username: 'string'
    });
    
    let user = client.createProxy(UserSchema, 0);
    user.username = "HealthyData";
    
    await sleep(500); // Give flusher time
    
    console.log('[E2E] Shutting down daemon cleanly...');
    daemon.kill('SIGKILL');
    await sleep(1000);
    
    console.log('[E2E] 💥 Injecting garbage into data.takyon (Simulating Torn Write)...');
    const { fsyncSync } = require('fs');
    const fd = openSync(DB_PATH, 'r+');
    const garbage = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    writeSync(fd, garbage, 0, 5, 20); // Overwrite 5 bytes at offset 20
    fsyncSync(fd);
    closeSync(fd);
    
    console.log('[E2E] Starting daemon for rehydration...');
    let res = await spawnDaemon(true);
    let daemon2 = res.daemon;
    
    if (res.warningFound) {
        console.log('✅ [E2E SUCCESS] The daemon detected invalid CRC32 and truncated the sector without panicking.');
    } else {
        console.error('❌ [E2E FAILED] Daemon did not detect CRC32 corruption or emit warning.');
        process.exitCode = 1;
    }
    
    daemon2.kill('SIGKILL');
}

runCorruptionTest().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
