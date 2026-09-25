#!/usr/bin/env node
// Proxy hot-path bench: SDK overhead only (mocked bridge, no daemon).
// Requires SDK dist: `cd src/sdk/ts && npm run build`.
// Usage: `node scripts/bench_proxy.js [iters]` (default 20000).
// Reports insert/find throughput; heap delta is informational
// (run with --expose-gc for a gc() between phases).
const { performance } = require('perf_hooks');
const os = require('os');

const { join } = require('path');
const dist = join(__dirname, '..', 'src', 'sdk', 'ts', 'dist');
const { TakyonDB } = require(join(dist, 'takyon'));
const { TakyonSchema } = require(join(dist, 'client', 'schema'));
const { RECORD_BUMP_INIT, RECORD_BUMP_OFFSET, STRING_BUMP_OFFSET, STRING_DATA_START } = require(
  join(dist, 'client', 'layout'),
);

const N = Number(process.argv[2] || 20000);
const SIZE = 64 * 1024 * 1024;

function mockBindings() {
  const buffer = new ArrayBuffer(SIZE);
  const view = new DataView(buffer);
  view.setUint32(RECORD_BUMP_OFFSET, RECORD_BUMP_INIT, true);
  view.setUint32(STRING_BUMP_OFFSET, STRING_DATA_START, true);
  const store = new Map();
  return {
    initSharedMemory: () => buffer,
    pushDelta: () => 0,
    notifyArena: () => 0,
    verifyTestValue: () => 0,
    insert_index: (k, v) => {
      store.set(k, v);
      return 0;
    },
    search_index: (k) => store.get(k) ?? -1,
    remove_index: (k) => (store.delete(k) ? 1 : 0),
    trigger_checkpoint: () => 0,
    start_vacuum: () => 0,
  };
}

function percentile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function main() {
  if (global.gc) global.gc();
  const heap0 = process.memoryUsage().heapUsed;
  const db = new TakyonDB(mockBindings(), SIZE);
  const users = db.collection(
    'users',
    new TakyonSchema({ username: 'string', age: 'uint32', score: 'float64' }),
  );

  const tIns = performance.now();
  for (let i = 0; i < N; i++) {
    users.insert(`u${i}`, { username: `user-${i}`, age: i % 100, score: i * 1.5 });
  }
  const insertMs = performance.now() - tIns;

  const samples = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    const r = users.find(`u${i}`);
    if (!r || r.age !== i % 100) throw new Error('mismatch');
    r.age = (i + 1) % 100;
    if (i % 3 === 0) void r.username;
    samples.push(performance.now() - s);
  }
  if (global.gc) global.gc();
  const heap1 = process.memoryUsage().heapUsed;

  console.log(
    JSON.stringify(
      {
        suite: 'proxy-hot-path',
        hardware: {
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          node: process.version,
        },
        workload: { iters: N, ops: 'insert(mixed) + find + update + string-read/3' },
        methodology:
          'Mocked bridge (in-memory ArrayBuffer, no daemon): measures SDK overhead only. Per-op wall times via performance.now(). Informational, not a CI gate.',
        results: {
          insert_total_ms: insertMs,
          insert_avg_us: (insertMs * 1000) / N,
          find_update_p50_us: percentile(samples, 0.5) * 1000,
          find_update_p99_us: percentile(samples, 0.99) * 1000,
          heap_delta_mb: (heap1 - heap0) / 1048576,
        },
      },
      null,
      2,
    ),
  );
}

main();
