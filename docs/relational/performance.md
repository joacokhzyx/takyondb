# Rendimiento relacional

- Lectura punto PK: mismo coste que KV actual (`p50 ~0.007ms` en chaos).
- Scan: `O(n)` zero-copy, sin deserializar, proyección temprana.
- Filtro: comparación directa en `DataView`, sin alloc (pooled).
- Join hash: build en `Map<val,pk[]>`, probe streaming.
- Agregación: single-pass, `float64` con Kahan fase 2.
- Strings: bump + vacuum double-buffer ya existente.

Benchmarks: `benchmarks/relational/*.js` (insert/scan/filter/join/agg).
Metodología publicada, no marketing. Ver `performance-truth` en ROADMAP.
