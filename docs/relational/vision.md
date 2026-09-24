# TakyonDB Relacional — Visión

TakyonDB evoluciona de motor KV + índice ART a base de datos **relacional**
extremadamente eficiente, sin copiar arquitecturas lentas existentes.

## Principios (no negociables)

1. **Zero-copy primero:** filas como structs fijos en `SharedArena`, leídos
   vía `DataView`/`TypedArrays`. Nada de serializar JSON por TCP.
2. **Lock-free:** ART como PK + índices secundarios namespaced
   (`tabla:pk`, `idx:tabla:col:valor->pk`). MPMC ring con secuencias Vyukov.
3. **Durabilidad existente:** WAL segmentado + snapshots atómicos + recovery
   verificado + vacuum. Lo relacional reutiliza esto, no lo reinventa.
4. **No copiar:** sin B-tree con locks globales, sin row-by-row
   interpreted overhead, sin planner monolítico. Ejecución vectorizada y
   predicate pushdown en Zig donde duele, API fluida en TS donde es ergonomía.
5. **Single-node primero:** clustering/replicación es no-objetivo hasta que
   single-node sea verdad medible (`npm run bench` reproducible).

## Qué será relacional en Takyon

- Tablas con schema tipado, PK, `NOT NULL`, `UNIQUE`, `FK` (fase 1 lógica).
- `INSERT/SELECT/UPDATE/DELETE`, filtros, proyección, `LIMIT/OFFSET`,
  `ORDER BY`, agregaciones (`COUNT/SUM/AVG/MIN/MAX`), `JOIN` (hash + nested loop).
- Subset SQL compilado a plan de scan (sin copiar Postgres).
- Transacciones por lotes (batch atómico vía ring + checkpoint).
- Catálogo persistido en arena (records especiales, cubiertos por snapshot).

## Qué no será

- SQL completo, triggers, stored procedures, clustering.
- ORM pesado. El SDK expone `Table/Database/QueryBuilder` zero-copy.

Ver `data-model.md`, `query-api.md`, `indexes.md`, `transactions.md`.
