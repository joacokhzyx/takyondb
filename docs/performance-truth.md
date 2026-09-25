# Performance truth

Every number TakyonDB publishes should be reproducible by you, with its
methodology and hardware attached. This page is the contract; the harnesses
listed here are the only sources of the numbers.

## Reproduce

```bash
# 1. Build once (ReleaseSafe, the configuration CI measures).
zig build -Doptimize=ReleaseSafe

# 2. Run any harness. Each prints hardware, workload and methodology, and
#    writes a JSON record to $BENCH_JSON_PATH when that variable is set.
node scripts/benchmark_chaos.js
node scripts/bench_scan.js 3000
node scripts/bench_relational.js
node --expose-gc scripts/bench_proxy.js 20000
node scripts/bench_pooling.js
```

Build the SDK dist first for the TypeScript-only harnesses
(`npm --prefix src/sdk/ts ci && npm --prefix src/sdk/ts run build`).

## The harnesses

| Harness | Measures | Includes | Does not include |
|---|---|---|---|
| `benchmark_chaos.js` | Saturated concurrency: 4 `worker_threads`, 200 000 ops, 20 % read / 40 % insert / 40 % update, vacuum running, checkpoint every 500 ms | The N-API call and the arena work around it | The worker's own thread scheduling and cross-worker interleaving, which are not deterministic |
| `bench_scan.js` | Native prefix scan, bounded range scan and point lookup through the addon against a live daemon | Native scan paths and the FFI boundary | TypeScript SDK overhead (it calls the addon directly) |
| `bench_relational.js` | Seeded insert/scan/filter/join/agg over the TypeScript relational engine | The pure-TS engine | The native SIMD pushdown kernels, which this path does not reach |
| `bench_proxy.js` | TypeScript SDK overhead with a mocked bridge | The JS the SDK runs around the FFI boundary | Any native call, the daemon, and the index implementation |
| `bench_pooling.js` | The pooling optimization, in isolation | Codec/scratch cost only | End-to-end `insert`/`find` — see below |

`BENCH_REPS` and `BENCH_WARMUP` tune the relational harness; `--reps` and
`--warmup` tune the two proxy harnesses.

## What the pooling number does and does not say

Pooling (one `TextEncoder`/`TextDecoder`/scratch buffer per client instead of
per operation) is the one optimization whose effect is portable across
machines, because both arms run identical code and differ only in where the
helper objects come from. Measured on a 2× AMD EPYC 7763, Node 24:

| Metric | pooled | per-op | delta |
|---|---|---|---|
| avg | 0.71 µs | 1.35 µs | −47.8 % |
| p50 | 0.44 µs | 1.01 µs | −56.4 % |
| p95 | 1.36 µs | 1.76 µs | −22.7 % |
| p99 | 1.64 µs | 6.03 µs | −72.8 % |

This is scoped to the codec/scratch path. An earlier revision of this document
quoted −32 % insert / −54 % p50 / −55 % p99 for the whole hot path. That could
not be reproduced by any harness, and building a baseline arm showed why: a
"per-operation" control has to perform the *same* work to be comparable, and
once it does (same schema walk, same record proxy, same namespaced key) the
only remaining difference is allocation. Go any further and the control simply
skips work, which makes it a faster algorithm rather than a slower copy of the
same one. Those three numbers were therefore removed rather than restated.

## Reference run

Chaos harness, 2× AMD EPYC 7763, Linux, Node 24, ReleaseSafe:

| Metric | Latency |
|---|---|
| p50 | 0.002 ms |
| p95 | 0.004 ms |
| p99 | 0.011 ms |
| max | ~42 ms (one-off: checkpoint and vacuum interference) |

The SDK hot path with a mocked bridge, same machine, 20 000 iterations × 3
repetitions: insert 4.38 µs/op (228 k ops/s), find+update 1.01 µs p50 / 2.25 µs
p95 / 3.66 µs p99 (187 k ops/s).

## Rules

* Absolute numbers are machine specific. They are a record of one run, not a
  target, and not comparable across machines or across optimization modes.
  Bench the same build you intend to ship: `ReleaseFast` and `ReleaseSafe` are
  different binaries, and a bare `zig build` is `Debug`.
* Nothing is quoted without the hardware and the workload that produced it.
  A harness that cannot report its environment is a bug.
* Nothing is timed that was not part of the thing being measured. The chaos
  harness used to construct a `TextEncoder` plus an `ArrayBuffer`, `DataView`
  and `Uint8Array` per operation *inside* its timed region, so its published
  p99 was partly a measurement of V8 allocation; hoisting those objects moved
  p99 from ~0.019–0.057 ms to ~0.011–0.012 ms.
* A CI bench gates on correctness and completion, not on timing. Shared
  runners are not a stable reference, and a timing gate would be flaky by
  construction.
