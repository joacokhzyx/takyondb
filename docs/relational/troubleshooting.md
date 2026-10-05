# When it does not work

Failure modes and the questions this directory does not answer. Every
entry names the cause, because "it returned nothing" is not a diagnosis.

## Errors

**`insert_index failed`** — either the key is already in the index or the
arena has no room. `METRICS` separates them: watch `ring_depth` for a full
ring and the region counters for exhaustion.

**`Out of record memory. Increase MAX_RECORD_ARENA.`** — the message names
a compile-time constant the caller cannot change. The record region ends
where the index root begins, so a larger arena does not buy more records.
This is a limit with an owner: Gate 1 of the roadmap, in
[../next-steps.md](../next-steps.md).

**`SizeMismatch` at startup** — a shared segment from a previous run with
a different size is still in the namespace. On Linux,
`rm /dev/shm/TakyonDB_Master`. This is the daemon refusing to reuse a
segment whose layout is not the one it was built for.

**`TableExistsError` / `TableNotFoundError`** — `createTable` on a name
that is taken, or `dropTable` on one that is absent. Dropping a table that
is not there is an error rather than a silent no-op, on purpose.

**A `SELECT` returns nothing** — the filter compares types strictly. `28`
does not match `'28'`, and `like` only ever matches strings while
ordering comparisons only ever match numbers. A mismatch does not throw;
it just does not match.

**A native scan returns fewer rows than the table has** — it is capped, at
4096 offsets, and takes no cursor, so there is no way to continue past the
cap from that path. The TypeScript path has no cap because it owns the
iteration.

**The tables exist after a restart but are empty** — that is the
documented behaviour, not a bug. The catalog is durable; the rows are in
the process's heap. [operations.md](operations.md) has the backup
consequences.

## Questions this directory does not answer

**Does it replace Postgres?** No. One node, a `SELECT` subset, and a row
format that is not in the arena yet.

**Does it break the key-value path?** No. The models coexist in one arena
under disjoint key namespaces, `users:alice` beside `tbl:users:alice`.

**Does it need its own daemon?** No. Same daemon, same log, same
snapshots.

**Is clustering planned?** Not until the single-node engine states its own
durability contract honestly. That is Gate 2, and it is not done.

**Is the SIMD path used?** No. The kernels exist, are exported and have
parity tests, and no query calls them.
[performance.md](performance.md) says what that costs.

## Running the tests

```bash
cd src/sdk/ts && npm run test:relational    # the relational unit tests
node scripts/e2e_catalog_reboot_test.js     # DDL survives a SIGKILL
node scripts/bench_relational.js            # seeded workload
```

A failing relational test is usually the test being right. When this page
and a test disagree, the test wins until someone changes the code on
purpose.
