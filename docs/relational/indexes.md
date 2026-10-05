# Indexes

The relational model shares the engine's one radix index instead of
building a parallel structure. A relational primary key is published into
that index under a namespaced key, which is what makes it share the log,
the snapshots and recovery rather than living in a second map with a
second durability story.

## The namespaces

| Key | Points at |
|---|---|
| `tbl:<table>:<pk>` | A record offset |
| `idx:<table>:<col>:<padded value><U+001F><pk>` | A record offset, one entry per `(value, pk)` |
| `__catalog__:<table>` | A serialized table definition |

One physical tree, disjoint prefixes. The registry that describes each
logical root lives in `src/core/relational/multiroot.zig`, with a `UNIQUE`
flag and a cardinality counter per root. A tree per root would mean a
snapshot format per root, which is the reason the logical arrangement
exists.

The `U+001F` separator is what lets one value map to many primary keys: the
value is the prefix, and the separator terminates it. Values are padded so
that byte order equals numeric order — unsigned values get fixed-width
hex, signed values get sign-bias flipping first — which is what makes a
numeric range lookup possible without sorting anything. `padU32Hex` and
`padI64Hex16` are exported, and the padding is NUL-free so it survives the
key rules.

## Primary keys: ArtMirror

`ArtMirror` publishes a relational primary key into the engine's index
through `insert_index`, `search_index` and `remove_index`.

```typescript
const mirror = new ArtMirror();
mirror.mirrorPk('users', 'u1', offset);   // tbl:users:u1 -> offset
mirror.lookupPk('users', 'u1');           // the offset, or null
mirror.unmirrorPk('users', 'u1');         // true if it was there
mirror.syncTable(table, (pk) => offset);  // publish a whole table
```

The record offsets must be real: allocate them with
`TakyonDB.allocateRecordOffset`, or an entry will point at bytes that were
never written. `mirrorPk` throws rather than inventing an offset.

`scanTable` and `scanRange` read the engine's index through the native
scan path and return record offsets, not rows.

## Secondary indexes: two implementations

**In-memory**, for a table that lives in the TypeScript engine:

```typescript
lookupByColumn(table, 'city', 'Rosario');   // matching primary keys
assertUnique(table, 'email', value);         // throws on a duplicate
```

**Native**, publishing into the engine's index so the entries share the
log and the snapshots:

```typescript
const idx = new NativeSecondaryIndex(bindings, 'users', 'age', { unique: true });
idx.add(30, 'u2', offset);
idx.lookup(30);                 // record offsets
idx.lookupRange(20, 40);        // ordered scan over the padded keys
idx.lookupNumericRange(20, 40); // the same, as numbers
idx.remove(30, 'u2');
idx.cardinality();
```

The first argument is the engine bindings, because the entries go into the
engine's index rather than a local structure. `{ unique: true }` costs a
scan of that value's entries on every `add`, which is the price of
enforcing one row per value.

Maintenance is synchronous, inside the same ring and the same durability
path as the write itself. There is no background indexer that could race
a reader and be half a rebuild when the process dies.

Both implementations default to a bounded number of results per call. The
bound is a limit, not a design: the native scans return at most 4096
offsets and take no cursor, which is why
[limits.md](limits.md) marks that row as Gate 4 rather than as settled.

## What this buys, and what it does not

It buys one durability path. A relational primary key and a key-value
record are the same kind of thing to the log, which means a crash test
written for one is a crash test for both.

It does not buy the rows. The index points into mapped memory that the
relational engine does not own, so today those offsets are a promise
rather than a row. [vision.md](vision.md) states it, and
[../next-steps.md](../next-steps.md) tracks it as Gate 4.
