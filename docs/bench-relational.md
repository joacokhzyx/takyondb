# Benchmarks relacionales

- `benchmarks/relational/*.js`: insert/scan/filter/join/agg (TS engine).
- `scripts/bench_scan.js [n]`: nativo vs daemon vivo (point vs prefix
  scan vs rango acotado + hardware report). Requiere `zig build`.
- Metodología en `docs/relational/performance.md`.
