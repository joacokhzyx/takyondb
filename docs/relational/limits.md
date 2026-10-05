# Relational limits

Sizes and shapes the relational layer enforces today. Everything here is a
current bound, not a design decision; the constants live in
`src/sdk/client/relational/` and `src/core/relational/`, and the roadmap
gate that relaxes them is named on each row.

| Limit | Value | Where | Relaxed by |
|---|---|---|---|
| Columns per table | `1..32` | `schema.ts`, `persist.zig` | Not planned; the 4-byte null bitmap is sized by it |
| Table name | Must match `[a-zA-Z_][a-zA-Z0-9_]*` | `schema.ts` | Not planned |
| Primary key | `1..256 B` UTF-8, NUL-free | inherited from the index | Gate 1 |
| Secondary indexes per table | `16` | `multiroot.zig` (`MAX_INDEXES`) | Not planned |
| Index key prefix | `80 B`, plus a `0x1F` separator | `multiroot.zig` | Not planned |
| Results per query call | `10 000` rows | `executor.zig` (`MAX_RESULT_ROWS`) | Gate 4 |
| Native scan results per call | `4096` offsets, no cursor | the N-API bridge | Gate 4 |
| Row storage | In the JavaScript heap, not in the arena | `table.ts` | Gate 4 |
| Catalog records | Binary codec in Zig, JSON sidecar in the SDK | `persist.zig`, `catalog_store.ts` | — |

Two of these are not limits of the design but consequences of a choice
that has not been made yet, and both are why Gate 1 comes before the rest:
the primary key length comes from the index, and the result caps come from
a scan that cannot be resumed.
