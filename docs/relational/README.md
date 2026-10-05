# The relational model

One of the models over the arena (see
[../architecture/models.md](../architecture/models.md)). Tables with typed
schemas, a query builder, joins, aggregations, batch transactions and a
`SELECT` subset, written in TypeScript.

This page is the entry point: what it does, how to run it, what it costs,
and the terms it uses. The reference pages behind it are
[data-model.md](data-model.md), [query-api.md](query-api.md),
[indexes.md](indexes.md), [sql-subset.md](sql-subset.md),
[operations.md](operations.md), [limits.md](limits.md) and
[performance.md](performance.md). [vision.md](vision.md) is the honest
version of the same subject: what is true today and what is not.

## Five minutes

The relational layer is pure TypeScript. It needs no daemon, no addon and
no shared memory, so it is the fastest thing in this repository to try:

```bash
node scripts/examples_check.js    # typechecks AND runs every example
```

Ten runnable programs live in `examples/relational/`. `quickstart.ts` is
the shortest path through the whole surface; `query.ts`, `join.ts`,
`aggregation.ts`, `transactions.ts`, `sql.ts` and `secondary-index.ts` are
one subject each.

```typescript
import { RelationalDatabase, QueryBuilder } from 'takyondb';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);

users.insert({ id: 'u1', age: 20 });
users.insert({ id: 'u2', age: 30 });

new QueryBuilder(users)
  .where({ age: { gte: 21 } })
  .orderBy('age', 'desc')
  .limit(1)
  .all();
// [{ id: 'u2', age: 30 }]
```

Note there is no `takyon` argument and no `db.from()`. The database is
constructed empty and a query is built over a table. An earlier revision
of this page documented both, and neither existed.

## What it is not

Not a connection to the arena. Rows are a `Map<string, Row>` of plain
JavaScript objects, so the data is lost with the process. The *schema* is
durable — it is written as `__catalog__:<table>` records and survives a
`SIGKILL` with no JSON sidecar — but that is the catalog, not the rows.

That distinction is the reason this model is described as "phase 1" in
the code and as "not in the arena" in [vision.md](vision.md). Moving the
rows into sealed arena records is Gate 4 of the roadmap, and
[performance.md](performance.md) says what it costs today as a result.

## Harnesses

| Command | What it measures |
|---|---|
| `npm --prefix src/sdk/ts run test:relational` | The relational unit tests |
| `node scripts/bench_relational.js` | Seeded insert, scan, filter, join, aggregate. A CI gate on completion, not on a number |
| `node scripts/e2e_scan_test.js` | Native prefix and range scans against a live daemon |
| `node scripts/e2e_catalog_reboot_test.js` | DDL surviving a `SIGKILL` through the arena catalog |

The relational benchmark measures the TypeScript engine, and it says so in
its own methodology line. It does not measure the native pushdown kernels,
because the query path does not reach them.

## Test strategy

Every module has a sibling `*.test.ts`: types, schema, codec, table,
query, join, aggregation, transactions, the SQL parser, constraints,
persistence, the native secondary index and the catalog record. The Zig
core has inline `test "..."` blocks for its own modules, aggregated by
`src/core/test.zig`.

The tests assert against the behaviour the code has, not against a plan.
When this page and a test disagree, the test is right until someone
changes the code deliberately.

## Glossary

| Term | Meaning here |
|---|---|
| Arena | The mapped shared memory region: records, strings, one index |
| Model | A view over the arena. Key-value, document, relational, cache |
| Row | A plain JavaScript object today; a sealed arena record after Gate 4 |
| `tbl:` namespace | Primary keys: `tbl:<table>:<pk>` to a record offset |
| `idx:` namespace | Secondary indexes: `idx:<table>:<col>:<value>` to a primary key |
| `__catalog__:` | Persisted table definitions |
| Logical root | A disjoint key prefix inside the one physical index tree |
| Mirror | `ArtMirror`, which publishes relational primary keys into the engine's index so they share its durability |
| Pushdown | Calling a native kernel instead of looping in JavaScript. Exported, not reached from the query path |
| Zero-copy | Today: the index entry maps a key to an offset in mapped memory. Not: a row read that allocates nothing |
