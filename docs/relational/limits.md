# Relational limits

Sizes and shapes the relational layer enforces today. Everything here is a
current bound, not a design decision; the constants live in
`src/sdk/client/relational/` and `src/core/relational/`, and the roadmap
gate that relaxes them is named on each row. A limit with no gate is a
decision someone has to argue about.

| Limit | Value | Where | Relaxed by |
|---|---|---|---|
| Columns per table | `1..32` | `schema.ts`, `persist.zig` | Not planned; the 4-byte null bitmap is sized by it |
| Table name | Must match `[a-zA-Z_][a-zA-Z0-9_]*` | `schema.ts` | Not planned |
| Primary key | `1..256 B` UTF-8, NUL-free | inherited from the index | Not planned; it is the index key rule |
| Secondary indexes per table | `16` | `multiroot.zig` (`MAX_INDEXES`) | Not planned |
| Index key prefix | `80 B`, plus a `0x1F` separator | `multiroot.zig` | Not planned |
| Results per query call | `10 000` rows | `executor.zig` (`MAX_RESULT_ROWS`) | Gate 4 |
| Native scan results per call | `4096` offsets, no cursor | the N-API bridge | Gate 4 |
| Row storage | In the JavaScript heap, not in the arena | `table.ts` | Gate 4 |
| Row checksum | Sealed by `row.zig`, not written by the daemon's write path | `row.zig` | Gate 4 |
| Index reuse | Quarantined orphans, reuse disabled by default | `freelist.zig` | Gate 3 |
| Reclaim | A delete frees nothing; both allocators only grow | `takyon.ts` | Gate 3 |
| Catalog records | Binary codec in Zig, JSON sidecar in the SDK | `persist.zig`, `catalog_store.ts` | — |

## Which of these are design and which are unfinished

Four rows are limits of the design: the column count is sized by the null
bitmap, and the index prefix, the index count and the identifier pattern
are consequences of keys having to survive a byte-oriented tree.

The rest are consequences of a choice that has not been made yet, and they
are why Gate 1 comes before the others:

* **The primary key length** comes from the index. Gate 1 made the region
  boundaries configurable, and this row is still where it was, which is
  the honest outcome: the key rule was never a region problem.
* **The result caps** come from a scan that cannot be resumed. A cursor
  would lift the 4096 bound on its own, so the cap is a missing feature
  rather than a shape.
* **Row storage and the unwritten checksum** are the same gap twice: the
  rows are in the process's heap, so the sealed format the Zig side
  specifies is not what any query reads.
* **No reclaim** means no eviction, and therefore no cache tier. Gate 3
  depends on it.

## Checking a bound at runtime

`NativeSecondaryIndex.cardinality` defaults to 4096 results per call and
`ArtMirror.scanTable` to 1024, both smaller than the native ceiling. A
caller that needs the real count has to walk; there is no count that does
not walk today.

