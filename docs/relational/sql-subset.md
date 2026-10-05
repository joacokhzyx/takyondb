# The SQL subset

A parser and an executor for five statement kinds. It compiles to the same
plan the query builder produces; it does not attempt to be a SQL engine.

## Supported

```sql
CREATE TABLE users (id STRING PRIMARY KEY, age UINT32, balance FLOAT64);
INSERT INTO users (id, age) VALUES ('u1', 28);
SELECT id, age FROM users WHERE age >= 18 ORDER BY age DESC LIMIT 10;
SELECT COUNT(*) FROM users WHERE age < 30;
UPDATE users SET balance = 99.5 WHERE id = 'u1';
DELETE FROM users WHERE id = 'u1';
SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE age > 20;
```

## Semantics

* `UPDATE` and `DELETE` require a `WHERE` clause. A statement without one
  is rejected rather than applied to every row by accident.
* Literals: single-quoted strings with `''` as the escape, numbers,
  `TRUE`, `FALSE`, `NULL`.
* `COUNT(*)` returns `[{ count: n }]`.
* A join merges the rows and the right-hand row wins a column collision.
* `CREATE TABLE` types: `BOOL`, `INT8` `INT16` `INT32` `INT64`, `UINT8`
  `UINT16` `UINT32`, `FLOAT32` `FLOAT64`, `STRING`, `BYTES`,
  `TIMESTAMP_MS`, with `PRIMARY KEY`, `NOT NULL` and `UNIQUE`. Every other
  column is nullable.

## Entry points

```typescript
import { executeSql, executeQuery, executeSelect, executeJoin } from 'takyondb';

executeQuery(db, "SELECT id, age FROM users WHERE age >= 18");
executeSql(db, "INSERT INTO users (id, age) VALUES ('u1', 28)");
```

`executeSql` accepts any supported statement and returns a discriminated
result. `executeQuery` is the `SELECT`-only shorthand, and `executeSelect`
and `executeJoin` are the two read-only forms.

The parser is exported separately, so a caller can validate without
executing: `classifyStatement`, `parseSelect`, `parseInsert`,
`parseUpdate`, `parseDelete`, `parseCreateTable`, `parseJoin`,
`parseLiteral`, `isCountStar`.

## What it refuses

Subqueries, triggers, stored procedures, `ALTER`, exotic types, and any
clause order the grammar does not define. Every refusal throws a
`QueryError` naming what could not be parsed, including the offending text:

```text
unsupported SELECT: SELECT a, FROM t WHERE
column/value count mismatch in: INSERT INTO t (a, b) VALUES (1)
unterminated string in: 'abc
```

## Scope

This is a subset by decision, not by accident: the goal is that the
common query compiles to a scan, not that a standard is covered. How far
the surface should grow is Gate 4's argument and has not happened —
[vision.md](vision.md) says what is out of scope now and who reopens it.
