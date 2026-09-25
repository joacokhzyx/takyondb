// E2E: admin SCAN/RANGE over TCP against a live daemon.
// Boots the daemon, inserts keys via the N-API addon, then validates the
// line protocol: PING, SCAN <prefix> [max], RANGE <prefix> <lo> <hi> [max]
// and unknown-command handling.
const { join } = require('path');
const net = require('net');

const ARENA_SIZE = 16 * 1024 * 1024;
const PORT = 7723;

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

function fail(msg) {
  console.error(`[E2E Admin] FAILURE: ${msg}`);
  process.exitCode = 1;
}

function cmd(payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(payload + '\n'));
    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) sock.end();
    });
    sock.on('close', () => resolve(data.trim()));
    sock.on('error', reject);
    setTimeout(() => reject(new Error(`timeout on ${payload}`)), 5000);
  });
}

async function run() {
  const fs = require('fs');
  try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }

  console.log('[E2E Admin] Starting TakyonDB daemon in background...');
  const { spawn } = require('child_process');
  const daemonBin = join(__dirname, process.platform === 'win32' ? '../zig-out/bin/takyondb.exe' : '../zig-out/bin/takyondb');
  const daemon = spawn(daemonBin, [String(ARENA_SIZE)], { detached: true, stdio: 'ignore' });
  daemon.unref();
  await new Promise((r) => setTimeout(r, 1000));

  const memoryBuffer = takyondb.initSharedMemory(ARENA_SIZE);
  if (!memoryBuffer) {
    console.error('[E2E Admin] Failed to connect to shared memory');
    process.exit(1);
  }

  const pad = (i) => i.toString().padStart(3, '0');
  for (let i = 0; i < 40; i++) {
    if (takyondb.insert_index(`adm:${pad(i)}`, 300000 + i * 64) !== 0) return fail(`insert adm:${pad(i)}`);
  }

  if ((await cmd('PING')) !== 'PONG') return fail('PING');
  if ((await cmd('BOGUS')) !== 'ERR unknown command') return fail('unknown command');

  const full = await cmd('SCAN adm: 64');
  const offsets = full.startsWith('OK 40 ') ? full.slice(6).split(',').map(Number) : [];
  if (offsets.length !== 40 || new Set(offsets).size !== 40) return fail(`full scan: ${full.slice(0, 40)}`);

  const capped = await cmd('SCAN adm: 5');
  if (!capped.startsWith('OK 5 ') || capped.slice(5).split(',').length !== 5) {
    return fail(`capped scan: ${capped.slice(0, 40)}`);
  }

  const range = await cmd('RANGE adm: 010 019 64');
  const rOffsets = range.startsWith('OK 10 ') ? range.slice(6).split(',').map(Number) : [];
  const want = [];
  for (let i = 10; i <= 19; i++) want.push(300000 + i * 64);
  rOffsets.sort((a, b) => a - b);
  if (rOffsets.length !== 10 || !rOffsets.every((v, i) => v === want[i])) {
    return fail(`range scan: ${range.slice(0, 60)}`);
  }

  const unbounded = await cmd('RANGE adm: - - 64');
  if (!unbounded.startsWith('OK 40 ')) return fail(`unbounded range: ${unbounded.slice(0, 20)}`);

  if ((await cmd('SCAN adm: 0')) !== 'ERR bad scan (want: SCAN <prefix> [max 1..128])') {
    return fail('bad max not rejected');
  }
  if ((await cmd('SCAN adm: 999')) !== 'ERR bad scan (want: SCAN <prefix> [max 1..128])') {
    return fail('over-cap max not rejected');
  }

  daemon.kill('SIGKILL');
  try { takyondb.disconnect_shm(); } catch (e) {}
  console.log('[E2E Admin] SUCCESS: admin SCAN/RANGE passed.');
  process.exit(0);
}

run().catch((e) => {
  console.error(`[E2E Admin] FAILURE: ${e.message}`);
  process.exit(1);
});
