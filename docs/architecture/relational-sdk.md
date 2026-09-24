# Relational SDK (TypeScript)

Módulos en `src/sdk/client/relational/`:

- `types/column/schema`: tipos, validación, offsets.
- `codec/filter`: validación de filas, predicados.
- `table/database`: PK map + catálogo DDL.
- `query/aggregation/join`: builder, aggs, hash join.
- `transaction/secondary_index`: batches, lookups.
- `sql/executor`: subset SELECT compilado a builder.

Testeado con `vitest` (mock bridge sin SHM real). Publicado en
`dist/` vía `tsconfig.build.json`. Exportado desde `src/sdk/index.ts`.
