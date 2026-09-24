# Coverage relacional

- TS: cada módulo tiene `*.test.ts` (types, schema, table, query, join, tx, sql...).
- Zig: cada módulo tiene `test "..."` inline, agregado en `test.zig`.
- Objetivo: mantener verde + añadir tests por cada nuevo tipo/operador.
