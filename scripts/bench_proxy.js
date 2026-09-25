#!/usr/bin/env node
'use strict';

// SDK hot-path bench: measures TypeScript overhead only (mocked bridge, no
// daemon, no native call), so what is timed is the JS the SDK executes
// around the FFI boundary.
//
// This reports ABSOLUTE numbers for the shipped SDK, with the full
// methodology and hardware needed to interpret them.
//
// It deliberately does not publish a "pooled vs per-op" delta. The previous
// docs quoted -32% insert / -54% p50 / -55% p99 for pooling, but no harness
// could reproduce them. Writing a baseline arm here showed why: an
// allocation-heavy reference has to do the *same work* to be comparable, and
// the moment it does (same schema walk, same record proxy, same namespaced
// key) the only remaining difference is the allocation strategy. Broader
// than that, a "per-op" path that skips the proxy and validation is simply a
// faster algorithm, and comparing it to the SDK says nothing about pooling.
//
// The isolated pooling delta lives in bench_pooling.js, where both arms run
// identical code and differ only in how the helper objects are obtained.
//
// Usage:
//   node scripts/bench_proxy.js [iters] [--reps=N] [--warmup=N] [--json]
//
// Requires the SDK dist: npm --prefix src/sdk/ts run build

const { performance } = require('perf_hooks');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dist = path.join(__dirname, '..', 'src', 'sdk', 'ts', 'dist');
const { TakyonDB } = require(path.join(dist, 'takyon'));
const { TakyonSchema } = require(path.join(dist, 'client', 'schema'));
const {
    RECORD_BUMP_INIT,
    RECORD_BUMP_OFFSET,
    STRING_BUMP_OFFSET,
    STRING_DATA_START,
} = require(path.join(dist, 'client', 'layout'));

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return dflt;
    return hit.includes('=') ? hit.split('=')[1] : true;
};
const positional = argv.filter((a) => !a.startsWith('--'));
const N = Number(positional[0] || 20000);
const REPS = Number(flag('reps', 3));
const WARMUP = Number(flag('warmup', Math.min(2000, Math.floor(N / 10))));
const AS_JSON = Boolean(flag('json', false));

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

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function runOnce(n) {
    if (global.gc) global.gc();
    const heap0 = process.memoryUsage().heapUsed;
    const db = new TakyonDB(mockBindings(), SIZE);
    const users = db.collection(
        'users',
        new TakyonSchema({ username: 'string', age: 'uint32', score: 'float64' }),
    );

    const tIns = performance.now();
    for (let i = 0; i < n; i++) {
        users.insert(`u${i}`, { username: `user-${i}`, age: i % 100, score: i * 1.5 });
    }
    const insertMs = performance.now() - tIns;

    const samples = [];
    for (let i = 0; i < n; i++) {
        const s = performance.now();
        const r = users.find(`u${i}`);
        if (!r || r.age !== i % 100) throw new Error('value mismatch');
        r.age = (i + 1) % 100;
        if (i % 3 === 0) void r.username;
        samples.push(performance.now() - s);
    }
    if (global.gc) global.gc();
    const heapDelta = (process.memoryUsage().heapUsed - heap0) / 1048576;
    samples.sort((a, b) => a - b);
    return { insertMs, samples, heapDelta };
}

function main() {
    if (!Number.isInteger(N) || N <= 0) {
        console.error('iters must be a positive integer');
        process.exit(2);
    }

    // Warmup so JIT tiering does not land inside a timed rep.
    runOnce(WARMUP);

    const runs = [];
    for (let rep = 0; rep < REPS; rep++) runs.push(runOnce(N));

    // Best insert total: the least noise-sensitive estimator for a phase that
    // is dominated by steady-state work.
    const insertMs = Math.min(...runs.map((r) => r.insertMs));
    const samples = runs.flatMap((r) => r.samples).sort((a, b) => a - b);
    const findTotalMs = samples.reduce((a, b) => a + b, 0);
    const pct = (p) => percentile(samples, p) * 1000;

    const report = {
        suite: 'proxy-hot-path',
        hardware: {
            platform: os.platform(),
            arch: os.arch(),
            cpu_model: (os.cpus()[0] || {}).model || 'unknown',
            cpus: os.cpus().length,
            totalmem_mb: Math.round(os.totalmem() / 1048576),
            node: process.version,
        },
        workload: {
            iters: N,
            reps: REPS,
            warmup: WARMUP,
            ops: 'insert(mixed) + find + update + string-read/3',
        },
        methodology:
            'Mocked bridge (in-memory ArrayBuffer, no daemon, no native call): measures TypeScript SDK overhead only. ' +
            'Warmed up, then REPS timed repetitions; insert reports the best rep, percentiles merge all reps. ' +
            'Absolute numbers are machine specific and only comparable within the same hardware/build: treat the ' +
            'JSON as a record, not a target. The pooling delta is measured separately in bench_pooling.js, where ' +
            'both arms run identical code.',
        results: {
            insert_total_ms: insertMs,
            insert_avg_us: (insertMs * 1000) / N,
            insert_throughput_ops_s: Math.round(N / (insertMs / 1000)),
            find_update_avg_us: (findTotalMs * 1000) / N,
            find_update_p50_us: pct(0.5),
            find_update_p95_us: pct(0.95),
            find_update_p99_us: pct(0.99),
            find_update_throughput_ops_s: Math.round(N / (findTotalMs / 1000)),
            heap_delta_mb: runs[0].heapDelta,
        },
    };

    if (AS_JSON) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const r = report.results;
        console.log(
            `proxy-hot-path  (${report.hardware.cpu_model}, ${report.hardware.cpus}x, node ${report.hardware.node})`,
        );
        console.log(`workload: ${N} iters x ${REPS} reps (warmup ${WARMUP}), mocked bridge\n`);
        console.log(`  insert      ${r.insert_total_ms.toFixed(2)} ms total, ${r.insert_avg_us.toFixed(3)} us/op, ${r.insert_throughput_ops_s} ops/s`);
        console.log(`  find+update ${r.find_update_avg_us.toFixed(3)} us/op, ${r.find_update_throughput_ops_s} ops/s`);
        console.log(`  find+update p50 ${r.find_update_p50_us.toFixed(3)} us  p95 ${r.find_update_p95_us.toFixed(3)} us  p99 ${r.find_update_p99_us.toFixed(3)} us`);
        console.log(`  heap delta  ${r.heap_delta_mb.toFixed(2)} MB`);
    }

    if (process.env.BENCH_JSON_PATH) {
        fs.writeFileSync(process.env.BENCH_JSON_PATH, JSON.stringify(report, null, 2));
    }
}

main();
