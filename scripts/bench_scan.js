#!/usr/bin/env node
// Native scan bench vs a live daemon: point lookups vs prefix scans vs
// bounded ranges over one keyspace. Requires `zig build` first.
// Usage: `node scripts/bench_scan.js [num_keys]` (default 10000).
// Output: JSON with hardware, workload, and per-op p50/avg timings.
// Informational, not a CI gate.
const { join } = require('path');
const os = require('os');
const { performance } = require('perf_hooks');

const ARENA_SIZE = 64 * 1024 * 1024;
const N = Number(process.argv[2] || 10000);

const ADDON_PATH = join(__dirname, '../zig-out/bin/takyondb_bridge.node');
const takyondb = require(ADDON_PATH);

function fail(msg) {
  console.error(`[Bench Scan] FAILURE: ${msg}`);
  process.exit(1);
}

async function run() {
  const fs = require('fs');
  try { fs.unlinkSync(join(__dirname, '../data.takyon')); } catch (e) {}
  try { fs.unlinkSync(join(__dirname, '../data.takyon.snap')); } catch (e) {}
  if (process.platform === 'linux') {
    try { fs.unlinkSync('/dev/shm/TakyonDB_Master'); } catch (e) {}
  }

  const { spawn } = require('child_process');
  const daemonBin = join(__dirname, process.platform === 'win32' ? '../zig-out/bin/takyondb.exe' : '../zig-out/bin/takyondb');
  let daemon;
  try {
    daemon = spawn(daemonBin, [String(ARENA_SIZE)], { detached: true, stdio: 'ignore' });
  } catch (e) {
    return fail(`cannot spawn daemon (run 'zig build' first): ${e.message}`);
  }
  daemon.unref();
  await new Promise((r) => setTimeout(r, 1000));

  const mem = takyondb.initSharedMemory(ARENA_SIZE);
  if (!mem) return fail('shared memory connect failed');

  const pad = (i, w) => i.toString().padStart(w, '0');
  const tIns = performance.now();
  for (let i = 0; i < N; i++) {
    if (takyondb.insert_index(`B-${pad(i, 5)}`, 300000 + i * 64) !== 0) return fail(`insert ${i}`);
  }
  const insertMs = performance.now() - tIns;

  const timeIt = (fn, iters) => {
    // Warmup, then timed iterations.
    fn();
    const s = performance.now();
    for (let i = 0; i < iters; i++) fn();
    return (performance.now() - s) / iters;
  };

  const pointMs = timeIt(() => {
    const o = takyondb.search_index(`B-${pad(N >> 1, 5)}`);
    if (o < 0) throw new Error('point lookup missed');
  }, 1000);

  const fullRes = takyondb.scan_prefix('B-', N + 16);
  if (fullRes.length !== N) return fail(`full scan: want ${N}, got ${fullRes.length}`);
  const fullMs = timeIt(() => takyondb.scan_prefix('B-', N + 16), 20);

  const rangeRes = takyondb.scan_range('B-', '00100', '00199', N);
  if (rangeRes.length !== 100) return fail(`range scan: want 100, got ${rangeRes.length}`);
  const rangeMs = timeIt(() => takyondb.scan_range('B-', '00100', '00199', N), 50);

  const narrowRes = takyondb.scan_prefix('B-000', 2048);
  if (narrowRes.length === 0) return fail('narrow scan empty');
  const narrowMs = timeIt(() => takyondb.scan_prefix('B-000', 2048), 50);

  daemon.kill();
  try { takyondb.disconnect_shm(); } catch (e) {}

  console.log(
    JSON.stringify(
      {
        suite: 'native-scan',
        hardware: {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          cpu_model: (os.cpus()[0] || {}).model || 'unknown',
          node: process.version,
        },
        workload: { keys: N, arena_mb: ARENA_SIZE / 1048576, seeded: true },
        methodology:
          'Live daemon + N-API addon. Timings are avg ms per call via performance.now() after warmup. Informational, not a CI gate.',
        results: {
          insert_avg_ms: insertMs / N,
          point_lookup_avg_ms: pointMs,
          full_scan_avg_ms: fullMs,
          full_scan_per_hit_us: (fullMs * 1000) / N,
          range_100_avg_ms: rangeMs,
          narrow_scan_avg_ms: narrowMs,
        },
      },
      null,
      2,
    ),
  );
}

run();
