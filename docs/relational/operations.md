# Catalog, backup and migration

## The catalog is durable; the rows are not

This is the first thing to know, because it decides what a backup has to
include.

A table's **definition** is written as a `__catalog__:<table>` record with
a fixed binary encoding — magic, version, table name, then one record per
column — in both the Zig core (`persist.zig`) and the SDK
(`catalog_record.ts`). Those records live in the arena, so they are
covered by the snapshot and rebuilt by recovery, and a reboot suite
proves the DDL survives a `SIGKILL` with no JSON sidecar.

A table's **rows** are a JavaScript `Map` inside the process. Nothing
recovers them. Restoring the catalog without the rows gives you the tables
and none of the data, which is the correct shape for a backup and not
what anybody wants on a restore.

## The catalog API

```typescript
import {
  bootCatalog, saveCatalog, loadCatalogDefs, restoreCatalog, snapshotCatalog,
  CatalogRecordStore,
} from 'takyondb';
```

| Call | What it does |
|---|---|
| `CatalogRecordStore.save(table, columns)` | Encodes the definition into the arena. Returns the record offset |
| `CatalogRecordStore.load(table)` | Decodes it back, or `null` |
| `bootCatalog(db, defs)` | Creates tables if absent. Idempotent |
| `snapshotCatalog(db)` | The catalog as plain data, for writing elsewhere |
| `saveCatalog(db, path)` | Writes a JSON sidecar. Write-then-rename |
| `loadCatalogDefs(path)` | Reads it back |
| `restoreCatalog(db, path)` | Recreates the tables from the sidecar |

The JSON sidecar is an **operational bridge**, not the storage format: it
is the only version a human can read and diff, and it exists so a
deployment can be reconstructed from a file. The arena records are the
ones recovery uses.

## Backup

1. Force a checkpoint: `printf 'CHECKPOINT\n' | nc 127.0.0.1 7723`, or
   `client.triggerCheckpoint()` from the SDK. The daemon answers `QUEUED`,
   or `FULL` when the ring could not take it.
2. Wait for `ring_depth=0` in `METRICS`. The checkpoint drains the ring
   before it snapshots, so a non-zero depth means the copy is not yet
   complete.
3. Copy `data.takyon` and `data.takyon.snap` from the `--data-dir`. With
   the daemon stopped is better; a live copy is a copy of a moving target.
4. Copy the catalog sidecar if you use one:
   `saveCatalog(db, '<data-dir>/catalog.json')`. Without it, a restart
   recovers arena contents but not the schemas.

## Restore

1. Put the files back and start the daemon. Recovery verifies the snapshot
   CRC before trusting it and replays the log on top.
2. `restoreCatalog(db, '<data-dir>/catalog.json')`. It is idempotent, so
   running it against a database that already has the tables is harmless.

## Migrating from key-value to relational

Nothing forces this, and it is not a one-way door: the two models coexist
in the same arena under disjoint key namespaces.

| | Key-value | Relational |
|---|---|---|
| Key | `users:alice` | `tbl:users:alice` |
| Owned by | `Collection` | `ArtMirror` |
| Durability | The log | The log, once the row exists in the arena |

Both go through the same write-ahead log and the same snapshots, so a
migration is a data movement, not a storage-engine change.

The way to do it today: create the `RelationalTable`, then walk the
source collection's keys and insert. The native range scan helps if the
keys are contiguous; otherwise the application already knows its own
primary keys.

Without downtime on a single node: write to both during the migration,
verify the counts, then drop the old collection. Dropping removes the
index entry and reclaims nothing — both allocators only grow — so a
migration leaves its source bytes behind. That is a limit, not a bug, and
it is in [../next-steps.md](../next-steps.md).

## Routine operation

The relational layer uses the same daemon and the same flags as
everything else: `--data-dir`, `--checkpoint-sec`, `--port`. `HEALTH` and
`METRICS` report the engine's counters, and after a large batch a
`CHECKPOINT` is worth sending explicitly rather than waiting for the
timer. The full daemon surface is in [../operations.md](../operations.md).
