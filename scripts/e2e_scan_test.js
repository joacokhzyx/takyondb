// E2E: native prefix scan against a live daemon.
// Boots the daemon, inserts 2000 SCAN-xxxxx + 500 OTHER-xxxxx keys via the
// N-API addon, then validates takyon_scan_prefix end to end.
const { join } = require('path');

const ARENA_SIZE = 16 * 1024 * 1024;
const N_SCAN = 2000;
const N_OTHER = 500;

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

function fail(msg) {
  console.error(`[E2E Scan] FAILURE: ${msg}`);
  process.exitCode = 1;
}

async function run() {
  const fs = require('fs');
  try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
  // A stale POSIX segment from another run carries a foreign size/layout;
  // the engine refuses to truncate/reuse it, so unlink first (Linux only).
  // Same for the macOS file-backed segment.
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }
  if (process.platform === 'darwin') {
    try { fs.unlinkSync('/tmp/takyondb_TakyonDB_Master'); } catch (e) {}
  }

  console.log('[E2E Scan] Starting TakyonDB daemon in background...');
  const { spawn } = require('child_process');
  const daemonBin = join(__dirname, process.platform === 'win32' ? '../zig-out/bin/takyondb.exe' : '../zig-out/bin/takyondb');
  const daemon = spawn(daemonBin, [String(ARENA_SIZE)], { detached: true, stdio: 'ignore' });
  daemon.unref();
  await new Promise((r) => setTimeout(r, 1000));

  const memoryBuffer = takyondb.initSharedMemory(ARENA_SIZE);
  if (!memoryBuffer) {
    console.error('[E2E Scan] Failed to connect to shared memory');
    process.exit(1);
  }

  const pad = (i) => i.toString().padStart(5, '0');
  const expected = new Set();
  for (let i = 0; i < N_SCAN; i++) {
    const off = 300000 + i * 64;
    if (takyondb.insert_index(`SCAN-${pad(i)}`, off) !== 0) return fail(`insert SCAN-${pad(i)}`);
    expected.add(off);
  }
  for (let i = 0; i < N_OTHER; i++) {
    if (takyondb.insert_index(`OTHER-${pad(i)}`, 900000 + i * 64) !== 0) return fail(`insert OTHER-${pad(i)}`);
  }

  // Full prefix scan.
  const t0 = performance.now();
  const got = Array.from(takyondb.scan_prefix('SCAN-', N_SCAN + 16));
  const dt = performance.now() - t0;
  if (got.length !== N_SCAN) return fail(`expected ${N_SCAN} hits, got ${got.length}`);
  for (const o of got) {
    if (!expected.has(o)) return fail(`unexpected offset ${o}`);
    expected.delete(o);
  }
  if (expected.size !== 0) return fail(`${expected.size} offsets missing`);
  console.log(`[E2E Scan] Full scan: ${N_SCAN} offsets in ${dt.toFixed(2)} ms.`);

  // Narrower prefix and truncation.
  const narrow = Array.from(takyondb.scan_prefix('SCAN-000', 1024));
  if (narrow.length === 0 || narrow.length >= N_SCAN) return fail(`narrow scan returned ${narrow.length}`);
  const capped = Array.from(takyondb.scan_prefix('SCAN-', 10));
  if (capped.length !== 10) return fail(`capped scan returned ${capped.length}`);
  const empty = Array.from(takyondb.scan_prefix('ZZZ-', 16));
  if (empty.length !== 0) return fail(`empty scan returned ${empty.length}`);

  // Bounded range scan over the zero-padded suffixes.
  const range = Array.from(takyondb.scan_range('SCAN-', '00010', '00019', 64)).sort((a, b) => a - b);
  const want = [];
  for (let i = 10; i <= 19; i++) want.push(300000 + i * 64);
  if (range.length !== want.length || !range.every((v, i) => v === want[i])) {
    return fail(`range scan mismatch: got ${range.length}, want ${want.length}`);
  }
  if (Array.from(takyondb.scan_range('SCAN-', '', '', N_SCAN + 16)).length !== N_SCAN) {
    return fail('unbounded range scan mismatch');
  }
  if (Array.from(takyondb.scan_range('SCAN-', '00019', '00010', 16)).length !== 0) {
    return fail('inverted range should be empty');
  }

  daemon.kill('SIGKILL');
  try { takyondb.disconnect_shm(); } catch (e) {}
  console.log('[E2E Scan] SUCCESS: native prefix scan passed.');
  process.exit(0);
}

run();
