# Relational examples

Ten runnable programs. All of them are typechecked **and executed** by
`node scripts/examples_check.js`, which runs in the `Relational Checks`
workflow, so an example cannot silently rot.

Run them all:

```bash
node scripts/examples_check.js
```

Run one:

```bash
cd scripts
NODE_PATH=../src/sdk/ts/node_modules \
  node -r ts-node/register/transpile-only ../examples/relational/query.ts
```

| File | Shows |
|---|---|
| [quickstart.ts](quickstart.ts) | Create a table, insert, query, and the same through the `SELECT` subset |
| [query.ts](query.ts) | Filter, sort, limit and projection with `QueryBuilder` |
| [sql.ts](sql.ts) | The supported `SELECT` subset via `executeSelect` |
| [join.ts](join.ts) | `hashJoin` over two tables |
| [aggregation.ts](aggregation.ts) | `sum`, `min`, `max`, `count`, `avg` |
| [transactions.ts](transactions.ts) | Atomic batch insert and rollback |
| [constraints.ts](constraints.ts) | Uniqueness and constraint validation |
| [secondary-index.ts](secondary-index.ts) | Secondary indexes and column lookup |
| [catalog.ts](catalog.ts) | Save DDL to a durable catalog and restore it |
| [persist.ts](persist.ts) | Idempotent catalog boot |

The engine used by these examples is pure TypeScript and needs no native addon.
For the shared-memory path (ART, WAL, native scans) see the
[quickstart](../../README.md#-quickstart) and [sdk](../../docs/sdk.md).
