# Testing relacional

- TS: `cd src/sdk/ts && npm run test:relational` (18 archivos, 53+ tests).
- Zig: `zig build test` (41/42, 1 fallo preexistente en vacuum).
- E2E: `node scripts/e2e_relational_test.js`.
- Checks: `node scripts/check_relational.js`, `node scripts/docs_check.js`.
