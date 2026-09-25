# Rendimiento relacional

- Lectura punto PK: mismo coste que KV actual (`p50 ~0.007ms` en chaos).
- Scan: `O(n)` zero-copy, sin deserializar, proyección temprana.
- Filtro: comparación directa en `DataView`, sin alloc (pooled).
- Join hash: build en `Map<val,pk[]>`, probe streaming.
- Agregación: single-pass en TS; kernels Zig `kahanSum/kahanSumSelected/
  minSelected/maxSelected` en `src/core/relational/column.zig` expuestos vía
  C-ABI (`takyon_filter_u32/f64`, `takyon_agg_*_selected`) + N-API
  (`filter_u32/f64`, `agg_sum*`) y `pushdown.ts` con fallback TS idéntico
  (cero-copy arena→kernel como trabajo futuro: hoy el TS columnariza filas).
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

Nativo (requiere `zig build`):

```bash
node scripts/bench_scan.js 10000  # point vs prefix scan vs rango
```

Workload: `20k` filas seeded (`LCG 42`), `p50/p95/p99` vía
`performance.now()`, reporte de hardware (`platform/arch/cpus/node`)
en cada salida JSON. Corre como gate en `Relational Checks` (tras el
build de dist); los números son metodología publicada, no marketing.
