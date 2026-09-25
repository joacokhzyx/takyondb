# Performance truth (relacional incluido)

- KV chaos: `p50 0.007ms/p95 0.011ms/p99 0.018ms` (NVMe, 200k ops).
- SDK hot paths (`scripts/bench_proxy.js`, mocked bridge, 20k ops,
  AMD EPYC 9V74, Node 24): pooled DataView/codecs/scratch vs per-op
  allocation — insert `5.68µs -> 3.86µs` (-32%), find+update p50
  `2.08µs -> 0.95µs` (-54%), p99 `5.89µs -> 2.66µs` (-55%).
  Reproducible: `cd src/sdk/ts && npm run build && node --expose-gc
  scripts/bench_proxy.js 20000`.
- Relacional: `benchmarks/relational/bench.js` (seeded, 20k filas) y
  `scripts/bench_scan.js` vs daemon vivo, ambos con hardware report.
- Sin números marketing: cada bench incluye workload + hardware report.
