# E2E relacional

- `scripts/e2e_relational_test.js`: smoke de `Database/Table/Query` sin daemon.
- `scripts/check_relational.js`: `zig fmt --check` + unit tests relacionales.
- CI `relational.yml` corre ambos en cada push/PR a `main`.
