# The models on the arena

One engine, several models over it. This page is the map between them:
which region each model writes into, which key namespace it owns, and
where each one actually lives today rather than where it is going to.

The engine itself is in [README.md](README.md) in this directory: the byte
map, the ring, the index, the log, recovery and vacuum.

## The shared parts

Everything below shares three regions of the same mapped arena and one
radix index over all of it.

| Shared part | Where | Owner |
|---|---|---|
| Records | Fixed-length region, bump-allocated | Every model |
| Strings | Variable-length region, bump-allocated | Every model |
| Index | One radix tree, disjoint key prefixes per model | Every model |
| Durability | One write-ahead log, one snapshot format, one recovery | Every model |

Sharing the index is why logical roots exist at all
(`src/core/relational/multiroot.zig`): one physical tree with disjoint
prefixes, rather than one tree per model, because one tree per model
would mean one snapshot format per model.

## The key namespaces

| Namespace | Owner | Points at |
|---|---|---|
| `<collection>:<key>` | Key-value collections (`src/sdk/takyon.ts`) | A record offset |
| `tbl:<table>:<pk>` | The relational model | A record offset |
| `idx:<table>:<col>:<padded-value><SEP><pk>` | Secondary indexes | A primary key |
| `__catalog__:<table>` | The relational catalog | A serialized table definition |
| `cache:<ns>:<key>` | The cache tier (Gate 3, designed) | A record offset |

Prefix keys are why ordered scans are cheap: `scanPrefix` walks the
subtree under a prefix with an explicit stack, no allocator, a
corruption budget, and zero for a corrupt node rather than a panic. The
range variant prunes subtrees provably above the upper bound, so its cost
is the matching subtree rather than the keyspace. Both are exposed
through `takyon_scan_prefix` / `takyon_scan_range` in the C ABI,
`scan_prefix` / `scan_range` in the N-API bridge, and `ArtMirror` in the
SDK.

Secondary index keys are order-preserving and NUL-free: numbers are
zero-padded hex, signed values are sign-bias flipped first, and the entry
key appends a separator plus the primary key so one value can map to many
rows. Byte-lexicographic order in the tree is therefore numeric order,
which is what makes a range lookup on a secondary index possible without
sorting anything.

## The relational model

Declared in `src/core/relational/` (Zig) and `src/sdk/client/relational/`
(TypeScript). What each module does:

| Zig | Responsibility |
|---|---|
| `types.zig` | Physical types and their sizes |
| `catalog.zig` | A `TableDef` with one primary key |
| `row.zig` | Null bitmap, magic and version, sealed 12-byte headers with CRC32, tamper tests |
| `filter.zig` | Integer and float matching, no allocation |
| `aggregation.zig` | Streaming accumulator |
| `scan.zig` | A cursor over record offsets |
| `query.zig` | `PlanKind` and `LimitSpec` |
| `join.zig` | Probe by binary search |
| `tx.zig` | A logical batch |
| `multiroot.zig` | The logical root registry, key encoding |
| `persist.zig` | The binary catalog codec |
| `column.zig` | Vectorized kernels: an eight-lane filter and Kahan summation over borrowed slices |

The catalog is the part that already crossed over. A `CREATE TABLE`
survives a restart because the schema is written as a
`__catalog__:<table>` record with a fixed binary encoding — magic, version,
columns — in both languages, and that record is covered by the snapshot
and rebuilt by recovery. A JSON sidecar (`catalog_store.ts`) still exists
as an operational bridge, and the reboot suite proves the DDL survives a
`SIGKILL` with no sidecar at all.

The rows have not crossed over, and this is the important asymmetry: the
engine holds descriptors and kernels, while the rows live in a JavaScript
`Map` inside the process. The row format `row.zig` specifies is not what
any query reads, and the kernels in `column.zig` are reachable only from
the C ABI, not from the query path. [vision.md](../relational/vision.md)
states that as a gap rather than a design, and
[../infrastructure.md](../infrastructure.md) is what moves it.

## What this directory does not claim

The scan entry points return a bounded number of offsets and take no
cursor, so a table larger than that bound cannot be read through the
native path. The TypeScript path can, because it owns the iteration. That
is a limit with an owner, and it is in
[../next-steps.md](../next-steps.md) rather than here.
