# Relational benchmarks

Methodology in `docs/relational/performance.md`.
Run `node bench.js all` for the full seeded suite (insert/scan/filter/join/agg,
20k rows, LCG 42, p50/p95/p99 + hardware report); per-op wrappers
(`insert/scan/filter/join/agg.js`) or `node scripts/bench_relational.js` as CI entry.
