# Performance truth (relacional incluido)

- KV chaos: `p50 0.007ms/p95 0.011ms/p99 0.018ms` (NVMe, 200k ops).
- Relacional fase 1 hereda punto PK; scans/filtros/joins medidos en
  `benchmarks/relational/` (placeholders con metodología publicada).
- Sin números marketing: cada bench incluye workload + hardware report
  cuando se publique `bench:relational` reproducible.
