# Query API

The whole surface is small: a database holds tables, a table holds rows, a
`QueryBuilder` reads one table. Every snippet below is executed by
`node scripts/examples_check.js`.

## Database

```typescript
const db = new RelationalDatabase();
```

Constructed empty. There is no client argument, because the relational
engine holds no reference to the arena; the bridge to the engine is
`ArtMirror` and `NativeSecondaryIndex`, described in
[indexes.md](indexes.md).

| Method | Behaviour |
|---|---|
| `createTable(name, columns)` | Returns a `RelationalTable`. Throws `TableExistsError` if the name is taken |
| `dropTable(name)` | Removes the table and its rows. Throws `TableNotFoundError` if absent — dropping nothing is an error, not a no-op |
| `table(name)` | Looks a table up. Throws if absent |
| `listTables()` | Every table name, in creation order |

## Table

`createTable` takes an ordered array of column definitions, 1 to 32 of
them, with exactly one primary key:

```typescript
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
  { name: 'balance', type: 'float64', nullable: true },
]);
```

| Method | Behaviour |
|---|---|
| `insert(row)` | Returns the stored row. Enforces `NOT NULL` and `UNIQUE` |
| `findByPk(value)` | The row, or `null` |
| `scan(where?)` | Every matching row. Copies each row, so a scan of *n* rows allocates *n* objects |
| `update(pk, patch)` | Merges a patch, returns the row or `null` |
| `delete(pk)` | `true` if it was there |
| `count()` | Row count, optionally filtered |
| `name`, `schema` | The table's name and compiled schema |

## QueryBuilder

```typescript
import { QueryBuilder } from 'takyondb';

new QueryBuilder(users)
  .where({ age: { gte: 18 }, name: { like: 'A%' } })
  .select(['id', 'age'])
  .orderBy('age', 'desc')
  .limit(10)
  .offset(5)
  .all();
```

Each method returns the builder, so they chain in any order. `all()`
materializes; nothing runs until a terminal method is called.

| Method | Behaviour |
|---|---|
| `where(clause)` | Predicates, `AND` by juxtaposition and `OR` by array |
| `select(cols)` | Projection |
| `orderBy(col, dir)` | One column, `asc` or `desc` |
| `limit(n)`, `offset(n)` | Windowing, applied after ordering |
| `all()` | The rows |
| `count()` | How many the clause matches |
| `agg(fn, column?)` | `count`, `sum`, `avg`, `min`, `max` |
| `matches(row)` | The clause against one row |

### Predicates

```typescript
{ age: { gte: 18 } }                  // eq ne gt gte lt lte in like
{ age: { gte: 18 }, city: 'Rosario' } // AND
{ age: { gte: 18 }, age: { lt: 30 } } // not OR: use the array form
```

`OR` is an array of clauses. `like` is a SQL pattern with `%` and `_`, and
the pattern's literal characters are escaped before the regular expression
is built, so a `.` in a pattern matches a literal dot.

Ordering and grouping only ever match numbers; `like` only ever matches
strings. A type mismatch does not throw, it simply does not match.

Aggregations stream over the matching rows rather than materializing
them, and `avg` uses compensated summation.

## Joins

```typescript
import { hashJoin } from 'takyondb';

hashJoin(db.table('orders'), db.table('users'), 'user_id', 'id');
```

A hash join with `this` on the left. Column collisions resolve in favour
of the right-hand row, and the result type is declared rather than
inferred, so the compiler tells you which columns exist.

## Transactions

```typescript
import { Transaction } from 'takyondb';

const tx = new Transaction(db);
tx.insert('users', { id: 'u3', age: 22 });
tx.update('users', 'u3', { age: 23 });
tx.delete('users', 'u9');
tx.commit();
```

A `Transaction` takes the database and **table names**, not table
objects, and buffers the operations. `commit()` validates the whole batch
first and applies it in order; `rollback()` discards it. That is a batch
with all-or-nothing validation, not an isolation level: nothing is rolled
back if an apply step fails midway, and there is no snapshot isolation.
[limits.md](limits.md) says so, and it is the reason the class says so in
its own header.

## SQL

```typescript
import { executeSql, executeQuery, parseSelect } from 'takyondb';

executeQuery(db, "SELECT id, age FROM users WHERE age >= 18 ORDER BY age DESC LIMIT 10");
executeSql(db, "INSERT INTO users (id, age) VALUES ('u1', 28)");
```

`executeSql` handles any supported statement and returns a discriminated
result; `executeQuery` is the `SELECT`-only shorthand. The grammar is in
[sql-subset.md](sql-subset.md). The parser is exported on its own —
`parseSelect`, `parseInsert`, `parseUpdate`, `parseDelete`,
`parseCreateTable`, `parseJoin`, `parseLiteral`, `classifyStatement` — so a
caller can validate a statement without executing it.

## Native kernels

`pushdown.ts` exports `pushFilterU32`, `pushFilterF64`, `pushSum`,
`pushSumSelected`, `pushMinSelected`, `pushMaxSelected` and `columnize`,
each with an identical TypeScript fallback and parity tests between the
two.

No query calls them. They exist, they are tested against their fallbacks,
and they are unreachable from the query path, which is why
[performance.md](performance.md) says the relational benchmark does not
measure them.
