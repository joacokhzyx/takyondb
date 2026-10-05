# The relational layer, as one model over one engine

The project is not a relational database with a key-value store attached,
and the relational layer is not a separate engine. It is one of the model
views described in [../infrastructure.md](../infrastructure.md), over the
same arena, the same radix index and the same log as everything else.

That framing decides the questions worth asking. Not "which SQL features
does it have", but: what does this model cost, what does it share with the
others, and what is true today.

## What is true today

* Tables with typed schemas, a primary key, uniqueness checks and
  `NOT NULL`, created and dropped through the SDK.
* A query builder with predicates, projections, ordering, limits and
  offsets; hash joins; single-pass aggregates; batch transactions.
* A `SELECT` subset parsed into the same plan the builder produces.
* A catalog persisted as records in the arena and covered by snapshots,
  so a table's shape survives a restart.
* A Zig core mirroring the types, catalog, row, filter, aggregate, scan,
  query, join and transaction layers, with unit tests wired into
  `zig build test`.
* Native prefix and range scans over the radix index, and order-preserving
  key encoding so a secondary index supports numeric range lookups.

## What is not true today

Stated plainly, because a vision page that only describes the target is
marketing.

* **The rows are not in the arena.** `RelationalTable` holds a
  `Map<string, Row>` of plain JavaScript objects. Tables, joins and
  aggregates work and are tested, and the data is lost with the process.
  The catalog persists the schema; the rows do not.
* **The native kernels are not reached from the query path.** The
  vectorized filter and aggregate kernels exist in Zig and are exported,
  with a TypeScript fallback that has parity tests. No query calls them, so
  the relational benchmark does not measure them and says so.
* **The Zig executor is not an executor.** The core holds descriptors and
  helpers, and the row format it specifies is not what any query reads.
* **A scan cannot be resumed.** Native scans return a bounded number of
  offsets and take no cursor, so a table larger than that bound cannot be
  read through the native path. The TypeScript path can, because it owns
  the iteration.

## Principles that survive the change of mission

1. **One arena, shared.** A relational row and a key-value record cost the
   same bytes in the same mapped pages. A second storage format in the same
   process defeats the reason the process exists.
2. **Do not copy slow architectures.** No B-tree behind a global lock, no
   row-at-a-time interpreter, no monolithic planner. Work goes in Zig where
   it is per-row and stays in the SDK where it is ergonomics.
3. **Reuse durability, do not reinvent it.** Tables inherit the log, the
   snapshots and the recovery path. A table format that needs its own
   journal is a table format that will lose data differently from
   everything else in the arena.
4. **Single node first.** Clustering is not a goal until the single-node
   engine can state its own durability and cost honestly.

## Current scope, and what reviews it

| Not in scope now | Reviewed by |
|---|---|
| Full SQL, triggers, stored procedures | Gate 4 decides how far the query surface goes |
| An ORM | Not planned; the SDK is the interface |
| Clustering and replication | Not planned until Gate 2 closes |
| Streaming queries | Not planned |

"Not in scope now" is not "never". Each row names the gate that reopens it,
because a non-goal without an owner is a decision nobody made.

Reference: [README.md](README.md), [data-model.md](data-model.md),
[query-api.md](query-api.md), [indexes.md](indexes.md),
[operations.md](operations.md), [performance.md](performance.md),
[limits.md](limits.md).
