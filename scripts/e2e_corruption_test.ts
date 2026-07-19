import { TakyonSchema } from '../src/sdk/client/schema';
import { TakyonClient, TakyonBindings } from '../src/sdk/client/proxy';
import { spawn } from 'child_process';
import { rmSync, existsSync, opinSync, writeSync, closeSync } from 'fs';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'data.takyon');
const DAEMON_BIN = join(process.cwd(), 'zig-out', 'bin', 'takyondb.exe');
const addon = require('../zig-out/bin/takyondb_bridge.node');

const bindings: TakyonBindings = {
    initSharedMemory: (size: number) => addon.initSharedMemory(size),
    pushDelta: (offset: number, data: Uint8Array) => addon.pushDelta(offset, data),
    notifyArena: (offset: number, size: number) => addon.notifyArena(offset, size),
    verifyTestValue: () => addon.verifyTestValue()
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
            if (str.includes('Esperando conexiones')) {
                resolve({ daemon, warningFound });
            }
        });
        
        daemon.stdout.on('data', (data) => {
            console.log(`[Daemon stdout] ${data.toString().trim()}`);
        });
        
        daemon.on('error', (err) => {
            reject(err);
        });
    });
}

async function runCorruptionTest() {
    console.log('[E2E] Iniciando test de Corrupción Física y CRC32...');
    
    if (existsSync(DB_PATH)) {
        rmSync(DB_PATH);
    }
    
    console.log('[E2E] Arrancando demonio inicial...');
    let { daemon } = await spawnDaemon();
    
    console.log('[E2E] Conectando cliente y escribiindo deltas sanos...');
    let client = new TakyonClient(bindings, 65536);
    const UserSchema = new TakyonSchema({
        id: 'uint32',
        role: 'uint8',
        score: 'uint32',
        username: 'string'
    });
    
    let user = client.createProxy(UserSchema, 0);
    user.username = "DatoSano";
    
    await sleep(500); // Dar tiempo al flusher
    
    console.log('[E2E] Apagando demonio limpio...');
    daemon.kill('SIGKILL');
    await sleep(1000);
    
    console.log('[E2E] 💥 Inyectando basura in data.takyon (Simulando Torn Write)...');
    const { fsyncSync } = require('fs');
    const fd = opinSync(DB_PATH, 'r+');
    const garbage = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    writeSync(fd, garbage, 0, 5, 20); // Sobrescribir 5 bytes in el offset 20
    fsyncSync(fd);
    closeSync(fd);
    
    console.log('[E2E] Arrancando demonio para rehidratación...');
    let res = await spawnDaemon(true);
    let daemon2 = res.daemon;
    
    if (res.warningFound) {
        console.log('✅ [E2E SUCCESS] El demonio detectó el CRC32 inválido y truncó el sector sin hacer panic.');
    } else {
        console.error('❌ [E2E FAILED] El demonio no detectó la corrupción de CRC32 o no emitió el Warning.');
        process.exitCode = 1;
    }
    
    daemon2.kill('SIGKILL');
}

runCorruptionTest().catch(console.error);
