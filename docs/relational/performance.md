# Rendimiento relacional

- Lectura punto PK: mismo coste que KV actual (`p50 ~0.007ms` en chaos).
- Scan: `O(n)` zero-copy, sin deserializar, proyección temprana.
- Filtro: comparación directa en `DataView`, sin alloc (pooled).
- Join hash: build en `Map<val,pk[]>`, probe streaming.
- Agregación: single-pass en TS; kernel Zig `kahanSum` en
  `src/core/relational/column.zig` (wiring a arena futuro).
- Strings: bump + vacuum double-buffer ya existente.

Benchmarks: `benchmarks/relational/bench.js` (harness real, seeded) +
per-op wrappers (`insert/scan/filter/join/agg.js`).
Metodología publicada, no marketing. Ver `performance-truth` en ROADMAP.

## Cómo correr

```bash
cd src/sdk/ts && npm run build   # dist requerido por el bench
node benchmarks/relational/bench.js all        # todas las suites
node benchmarks/relational/filter.js           # una suite
node scripts/bench_relational.js               # entrada CI
```

Workload: `20k` filas seeded (`LCG 42`), `p50/p95/p99` vía
`performance.now()`, reporte de hardware (`platform/arch/cpus/node`)
en cada salida JSON. Informativo, no gate de CI.
