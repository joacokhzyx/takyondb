# Troubleshooting relacional

- `insert_index failed`: PK duplicada o arena llena (revisa `METRICS`).
- `Out of record memory`: aumenta arena (`-- 67108864`) o compacta.
- `SELECT` vacío: revisa `where` (tipos estrictos: `28` vs `'28'`).
- Tests: `cd src/sdk/ts && npm run test:unit -- ../client/relational`.
