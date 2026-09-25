#!/usr/bin/env node
'use strict';

// Isolated measurement of the pooling optimization.
//
// Both arms execute the SAME code against the SAME bytes. The only
// difference is where the helper objects come from:
//
//   pooled  - one TextEncoder, one TextDecoder and one reusable scratch
//             ArrayBuffer for the whole run (what src/sdk/client/proxy.ts
//             does).
//   per-op  - a new TextEncoder / TextDecoder / scratch buffer per call.
//
// This exists because the pooling claim could not be reproduced: the
// benchmark that used to be cited for it had no baseline arm, and a
// whole-path "per-op" comparison is not a valid control (an allocation-heavy
// path that skips the record proxy, schema walk and key namespacing is just
// a different, faster algorithm, not a slower version of the same one).
//
// Scoped deliberately: this measures the codec/scratch cost only. It is not
// a claim about insert or find end to end.
//
// Usage: node scripts/bench_pooling.js [iters] [--reps=N] [--json]

const { performance } = require('perf_hooks');
const os = require('os');
const fs = require('fs');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return dflt;
    return hit.includes('=') ? hit.split('=')[1] : true;
};
const positional = argv.filter((a) => !a.startsWith('--'));
const N = Number(positional[0] || 200000);
const REPS = Number(flag('reps', 5));
const WARMUP = Number(flag('warmup', 20000));
const AS_JSON = Boolean(flag('json', false));

const SCRATCH_BYTES = 256;
const STRINGS = [
    'user-0',
    'user-1',
    'a-rather-longer-username-than-the-scratch-buffer-holds',
    'user-2',
    'Bob',
    'user-3',
    'x'.repeat(300), // Forces the grow path, exercised by both arms.
];

// --- arm A: pooled -----------------------------------------------------------
const pooledEncoder = new TextEncoder();
const pooledDecoder = new TextDecoder('utf-8');
const pooledScratch = new ArrayBuffer(SCRATCH_BYTES);
const pooledScratchU8 = new Uint8Array(pooledScratch);
const pooledScratchView = new DataView(pooledScratch);

function pooledEncode(value) {
    // Mirrors proxy.ts: encodeInto a reusable scratch, grow only on overflow.
    let need = value.length * 4;
    if (need > pooledScratchU8.length) {
        const grown = new Uint8Array(need);
        grown.set(pooledScratchU8);
        return { bytes: pooledEncoder.encodeInto(value, grown).written, out: grown };
    }
    return { bytes: pooledEncoder.encodeInto(value, pooledScratchU8).written, out: pooledScratchU8 };
}

function pooledDecode(buf, off, len) {
    return pooledDecoder.decode(new Uint8Array(buf, off, len));
}

// --- arm B: per-operation ----------------------------------------------------
function perOpEncode(value) {
    const enc = new TextEncoder();
    const scratch = new Uint8Array(value.length * 4);
    return { bytes: enc.encodeInto(value, scratch).written, out: scratch };
}

function perOpDecode(buf, off, len) {
    const dec = new TextDecoder('utf-8');
    return dec.decode(new Uint8Array(buf, off, len));
}

// --- harness -----------------------------------------------------------------
const staging = new ArrayBuffer(1 << 20);
const stagingU8 = new Uint8Array(staging);
let cursor = 0;
const encoded = [];
for (const s of STRINGS) {
    const enc = new TextEncoder().encode(s);
    stagingU8.set(enc, cursor);
    encoded.push({ off: cursor, len: enc.length, text: s });
    cursor += enc.length;
}

function measure(fn, n) {
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const e = encoded[i % encoded.length];
        const t0 = performance.now();
        // Same logical work for both arms: encode one value, decode it back.
        const enc = fn.encode(e.text);
        const round = fn.decode(staging, e.off, e.len);
        if (round.length === 0 && enc.bytes === 0) throw new Error('empty round trip');
        samples[i] = performance.now() - t0;
    }
    const sorted = Array.from(samples).sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 1000;
    return {
        avg_us: (sorted.reduce((a, b) => a + b, 0) / n) * 1000,
        p50_us: p(0.5),
        p95_us: p(0.95),
        p99_us: p(0.99),
    };
}

function main() {
    if (!Number.isInteger(N) || N <= 0) {
        console.error('iters must be a positive integer');
        process.exit(2);
    }
    const arms = {
        pooled: { encode: pooledEncode, decode: pooledDecode },
        per_op: { encode: perOpEncode, decode: perOpDecode },
    };

    measure(arms.pooled, WARMUP);
    measure(arms.per_op, WARMUP);

    const results = {};
    for (const [name, fn] of Object.entries(arms)) {
        const runs = [];
        for (let rep = 0; rep < REPS; rep++) runs.push(measure(fn, N));
        results[name] = {
            avg_us: Math.min(...runs.map((r) => r.avg_us)),
            p50_us: Math.min(...runs.map((r) => r.p50_us)),
            p95_us: Math.min(...runs.map((r) => r.p95_us)),
            p99_us: Math.min(...runs.map((r) => r.p99_us)),
        };
    }

    const delta = (a, b) => (a === 0 ? 0 : ((b - a) / a) * 100);
    const comparison = {
        avg_us: delta(results.per_op.avg_us, results.pooled.avg_us),
        p50_us: delta(results.per_op.p50_us, results.pooled.p50_us),
        p95_us: delta(results.per_op.p95_us, results.pooled.p95_us),
        p99_us: delta(results.per_op.p99_us, results.pooled.p99_us),
    };

    const report = {
        suite: 'pooling-delta',
        hardware: {
            platform: os.platform(),
            arch: os.arch(),
            cpu_model: (os.cpus()[0] || {}).model || 'unknown',
            cpus: os.cpus().length,
            node: process.version,
        },
        workload: { iters: N, reps: REPS, warmup: WARMUP, distinct_strings: STRINGS.length },
        methodology:
            'Isolated codec/scratch comparison. Both arms run identical logic (UTF-8 encode via encodeInto into a ' +
            'scratch buffer, then decode back) on the same staging bytes; the only difference is whether the ' +
            'TextEncoder/TextDecoder/scratch buffer are shared for the run or constructed per call. Best of REPS. ' +
            'This is NOT an end-to-end insert/find comparison: a per-op path that also skips the record proxy and ' +
            'schema walk is a different algorithm, not a slower copy of the same one.',
        results,
        comparison_delta_pct: comparison,
    };

    if (AS_JSON) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const f = (v) => v.toFixed(4).padStart(10);
        console.log(`pooling-delta  (${report.hardware.cpu_model}, ${report.hardware.cpus}x, node ${report.hardware.node})`);
        console.log(`workload: ${N} iters x ${REPS} reps (warmup ${WARMUP}), ${STRINGS.length} distinct strings\n`);
        console.log(`  ${'metric'.padEnd(8)}${'pooled us'.padStart(12)}${'per-op us'.padStart(12)}${'delta'.padStart(10)}`);
        for (const m of ['avg_us', 'p50_us', 'p95_us', 'p99_us']) {
            console.log(`  ${m.padEnd(8)}${f(results.pooled[m])}${f(results.per_op[m])}${`${comparison[m].toFixed(1)}%`.padStart(10)}`);
        }
        console.log('\nnegative delta = pooled is faster. Scope: codec/scratch only, not end-to-end.');
    }

    if (process.env.BENCH_JSON_PATH) {
        fs.writeFileSync(process.env.BENCH_JSON_PATH, JSON.stringify(report, null, 2));
    }
}

main();
