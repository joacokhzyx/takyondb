# E2E relacional

- `scripts/e2e_relational_test.js`: smoke de `Database/Table/Query` sin daemon.
- `scripts/e2e_scan_test.js`: scan nativo contra daemon vivo (2000 claves
  `SCAN-xxxxx` + 500 `OTHER-xxxxx`; valida set exacto, prefijo estrecho,
  truncado y prefijo vacío). Registrado en `run-e2e.js` (`scan`).
- `scripts/check_relational.js`: `zig fmt --check` + unit tests relacionales.
- CI `relational.yml` corre ambos en cada push/PR a `main`.
