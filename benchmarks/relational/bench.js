#!/usr/bin/env node
// Real relational micro-benchmark over the TS engine (in-memory, zero-serdes).
// Requires the SDK dist first: `cd src/sdk/ts && npm run build`.
// Usage: `node bench.js [insert|scan|filter|join|agg|all]` (default: all).
// Workload is seeded (LCG) so runs are reproducible. Runs as a CI gate
// (`Relational Checks` fails on crash/hang); reported numbers stay
// informational until hardware-pinned thresholds land.
const { performance } = require('perf_hooks');
const os = require('os');

const rel = '../../src/sdk/ts/dist/client/relational';
const { RelationalDatabase } = require(`${rel}/database`);
const { QueryBuilder } = require(`${rel}/query`);
const { hashJoin } = require(`${rel}/join`);
const { Transaction } = require(`${rel}/transaction`);

const N = 20000;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function percentiles(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const at = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { p50_ms: at(0.5), p95_ms: at(0.95), p99_ms: at(0.99), max_ms: a[a.length - 1] };
}

function seedUsers(db, n) {
  const users = db.createTable('users', [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'age', type: 'uint32' },
    { name: 'balance', type: 'float64', nullable: true },
  ]);
  const rand = lcg(42);
  const tx = new Transaction(db);
  for (let i = 0; i < n; i++) {
    tx.insert('users', {
      id: `u${i}`,
      age: 10 + Math.floor(rand() * 70),
      balance: Math.floor(rand() * 100000) / 100,
    });
  }
  tx.commit();
  return users;
}

function seedOrders(db, n) {
  const orders = db.createTable('orders', [
    { name: 'id', type: 'string', primaryKey: true },
    { name: 'user_id', type: 'string' },
  ]);
  const rand = lcg(7);
  const tx = new Transaction(db);
  for (let i = 0; i < n; i++) {
    tx.insert('orders', { id: `o${i}`, user_id: `u${Math.floor(rand() * n)}` });
  }
  tx.commit();
  return orders;
}

const suites = {
  insert() {
    const db = new RelationalDatabase();
    db.createTable('users', [
      { name: 'id', type: 'string', primaryKey: true },
      { name: 'age', type: 'uint32' },
    ]);
    const t = db.table('users');
    const samples = [];
    for (let i = 0; i < N; i++) {
      const s = performance.now();
      t.insert({ id: `u${i}`, age: i % 100 });
      samples.push(performance.now() - s);
    }
    return { ops: N, ...percentiles(samples) };
  },
  scan() {
    const db = new RelationalDatabase();
    const users = seedUsers(db, N);
    const samples = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      const rows = users.scan();
      samples.push(performance.now() - s);
      if (rows.length !== N) throw new Error('scan row count mismatch');
    }
    return { ops: 20, rows_per_op: N, ...percentiles(samples) };
  },
  filter() {
    const db = new RelationalDatabase();
    const users = seedUsers(db, N);
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      const rows = new QueryBuilder(users).where({ age: { gte: 18 } }).all();
      samples.push(performance.now() - s);
      if (rows.length === 0) throw new Error('filter returned nothing');
    }
    return { ops: 50, ...percentiles(samples) };
  },
  join() {
    const db = new RelationalDatabase();
    seedUsers(db, N);
    const orders = seedOrders(db, N);
    const users = db.table('users');
    const samples = [];
    for (let i = 0; i < 10; i++) {
      const s = performance.now();
      const rows = hashJoin(orders, users, 'user_id', 'id');
      samples.push(performance.now() - s);
      if (rows.length === 0) throw new Error('join returned nothing');
    }
    return { ops: 10, ...percentiles(samples) };
  },
  agg() {
    const db = new RelationalDatabase();
    const users = seedUsers(db, N);
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now();
      const v = new QueryBuilder(users).agg('avg', 'balance');
      samples.push(performance.now() - s);
      if (!Number.isFinite(v)) throw new Error('agg not finite');
    }
    return { ops: 50, ...percentiles(samples) };
  },
};

function hardware() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model ?? 'unknown',
    totalmem_mb: Math.round(os.totalmem() / 1048576),
    node: process.version,
  };
}

function main() {
  const only = process.argv[2] || 'all';
  const names = only === 'all' ? Object.keys(suites) : [only];
  for (const n of names) if (!suites[n]) throw new Error(`unknown suite '${n}'`);
  const results = {};
  for (const n of names) results[n] = suites[n]();
  console.log(
    JSON.stringify(
      {
        suite: 'relational',
        hardware: hardware(),
        workload: { rows: N, seeded: true, seed: 42 },
        methodology:
          'Seeded in-memory workload over the TS relational engine (no IPC/daemon). Per-op wall times via performance.now(); p50/p95/p99 over samples. CI gate on green completion; numbers informational until hardware-pinned thresholds land.',
        results,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) main();

module.exports = { suites };
