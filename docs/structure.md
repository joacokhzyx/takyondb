# Estructura de carpetas (relacional incluido)

```
src/core/relational/   # Zig: types/catalog/row/filter/agg/scan/query/join/tx/index/persist/sql/executor
src/sdk/client/relational/  # TS: mismo dominio + tests + README
docs/relational/       # visión, modelo, API, ops, límites, FAQ
docs/architecture/     # overviews + catalog + core/sdk
examples/relational/   # quickstart/join/tx/query/agg/sql
benchmarks/relational/ # insert/scan/filter/join/agg
scripts/               # e2e_relational, bench_relational, checks
.github/workflows/     # ci.yml + relational.yml
```
