# Testing relacional

- TS: `cd src/sdk/ts && npm run test:relational` (23 archivos, 69 tests).
- Zig: `zig build test` (73/73 en Linux, incl. relacional + pushdown +
  catálogo + multi-root + scrubber + freelist + fuzz).
- E2E: `node scripts/e2e_relational_test.js`.
- Checks: `node scripts/check_relational.js`, `node scripts/docs_check.js`.
