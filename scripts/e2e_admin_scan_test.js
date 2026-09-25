// E2E: admin SCAN/RANGE over TCP against a live daemon.
// Boots the daemon, inserts keys via the N-API addon, then validates the
// line protocol: PING, SCAN <prefix> [max], RANGE <prefix> <lo> <hi> [max]
// and unknown-command handling.
const net = require('net');

const ARENA_SIZE = 16 * 1024 * 1024;

const { READY, withDaemon } = require('./helpers/daemon');

const takyondb = require('./helpers/addon').loadBindings();

function fail(msg) {
  console.error(`[E2E Admin] FAILURE: ${msg}`);
  process.exitCode = 1;
}

// `port` is the port the daemon reported it actually bound, not a guess: if
// a stray daemon still holds the default, binding fails loudly at startup
// instead of silently proxying our commands to a stranger that answers
// "OK 0" against an unrelated arena.
function cmd(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(payload + '\n'));
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
  try { fs.unlinkSync(require('path').join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(require('path').join(__dirname, '../data.takyon.snap')); } catch (e) {}
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }

  console.log('[E2E Admin] Starting TakyonDB daemon in background...');
  // withDaemon guarantees the daemon dies on every exit path, including a
  // failing assertion (which used to leak a spinning daemon that poisoned
  // the rest of the run).
  await withDaemon({ args: [String(ARENA_SIZE)], readyPattern: READY.admin }, async (daemon) => {
    const port = daemon.adminPort;

    const memoryBuffer = takyondb.initSharedMemory(ARENA_SIZE);
    if (!memoryBuffer) {
      fail('Failed to connect to shared memory');
      return;
    }

    const pad = (i) => i.toString().padStart(3, '0');
    for (let i = 0; i < 40; i++) {
      if (takyondb.insert_index(`adm:${pad(i)}`, 300000 + i * 64) !== 0) {
        return fail(`insert adm:${pad(i)}`);
      }
    }

    if ((await cmd(port, 'PING')) !== 'PONG') return fail('PING');
    if ((await cmd(port, 'BOGUS')) !== 'ERR unknown command') return fail('unknown command');

    const metrics = await cmd(port, 'METRICS');
    if (!/^METRICS ring_depth=\d+ wal_bytes=\d+ wal_segments=\d+ uptime_s=\d+ fl_quarantined=\d+ fl_reused=\d+ fl_dropped=\d+$/.test(metrics)) {
      return fail(`METRICS shape: ${metrics.slice(0, 80)}`);
    }

    const full = await cmd(port, 'SCAN adm: 64');
    const offsets = full.startsWith('OK 40 ') ? full.slice(6).split(',').map(Number) : [];
    if (offsets.length !== 40 || new Set(offsets).size !== 40) return fail(`full scan: ${full.slice(0, 40)}`);

    const capped = await cmd(port, 'SCAN adm: 5');
    if (!capped.startsWith('OK 5 ') || capped.slice(5).split(',').length !== 5) {
      return fail(`capped scan: ${capped.slice(0, 40)}`);
    }

    const range = await cmd(port, 'RANGE adm: 010 019 64');
    const rOffsets = range.startsWith('OK 10 ') ? range.slice(6).split(',').map(Number) : [];
    const want = [];
    for (let i = 10; i <= 19; i++) want.push(300000 + i * 64);
    rOffsets.sort((a, b) => a - b);
    if (rOffsets.length !== 10 || !rOffsets.every((v, i) => v === want[i])) {
      return fail(`range scan: ${range.slice(0, 60)}`);
    }

    const unbounded = await cmd(port, 'RANGE adm: - - 64');
    if (!unbounded.startsWith('OK 40 ')) return fail(`unbounded range: ${unbounded.slice(0, 20)}`);

    if ((await cmd(port, 'SCAN adm: 0')) !== 'ERR bad scan (want: SCAN <prefix> [max 1..128])') {
      return fail('bad max not rejected');
    }
    if ((await cmd(port, 'SCAN adm: 999')) !== 'ERR bad scan (want: SCAN <prefix> [max 1..128])') {
      return fail('over-cap max not rejected');
    }
  });

  try { takyondb.disconnect_shm(); } catch (e) {}
  console.log('[E2E Admin] SUCCESS: admin SCAN/RANGE passed.');
  process.exit(process.exitCode || 0);
}

run().catch((e) => {
  console.error(`[E2E Admin] FAILURE: ${e.message}`);
  process.exit(1);
});
