# What is next

Deliberately short, and ordered by what blocks a real user. The long
checklists of finished work live in [../ROADMAP.md](../ROADMAP.md) and
[CHANGELOG.md](../CHANGELOG.md); this page is only what is *not* done.

## Prebuild coverage

`linux-arm64` and `darwin-x64` have no prebuild: the CI matrix builds
`linux-x64`, `darwin-arm64` (macos-15 runners are Apple Silicon) and
`win32-x64`. `loadBindings()` reports the gap explicitly rather than failing at
`require` time. Fixing it means adding `ubuntu-24.04-arm` and `macos-13` to the
matrix, or publishing per-platform packages.

## Native path coverage

* The relational **filter** and **aggregation** paths in TypeScript do not
  reach the Zig SIMD pushdown kernels. `pushdown.ts` exports
  `pushFilterU32/F64`, `pushSum*`, `pushMin/MaxSelected` and `columnize` with an
  identical TS fallback and parity tests, but nothing in the query path calls
  them, so `benchmarks/relational/bench.js` does not measure the kernels. See
  [relational/performance.md](relational/performance.md).
* The arena→kernel handoff is not zero-copy yet: the TS side still columnarizes
  rows into a `Float64Array` before calling into the kernel.
* Secondary indexes use logical multi-root ART namespaces with hex-padded keys;
  per-root physical arenas are future work.
* Row checksums and the extent scrubber are implemented and exposed
  (`verify_record`, `scrub_records`), but the daemon's write path does not seal
  every row yet and no periodic scrub is scheduled.

## Alloc reduction on hot paths

Known allocation sites, in rough order of cost:

* `Table.scan()` copies every row (`{...r}`), so a full scan of *n* rows
  allocates *n* objects. `QueryBuilder` then sorts, slices and maps on top.
* `filter.ts` calls `Object.entries(where)` per row and compiles a
  `new RegExp` per row *per predicate* for `like`.
* `aggregation.ts` uses `Math.min(...vals)` / `Math.max(...vals)`, which
  Makefan onto the call stack and are a hazard for wide columns.
* `catalog_record.ts` constructs a `TextEncoder` per table and per column name.
* The KV path creates a `Proxy`, a handler object and a target per `find()`
  and `insert()`.

## Durability

The WAL persists whole 4 KiB sectors on an idle timer, so an ungraceful exit
can lose whatever is still buffered in the current sector. The crash-recovery
E2E covers the snapshot-plus-residual path; the window itself is not currently
documented as a stated bound.

## Verification gaps

* No coverage measurement is wired up. [coverage.md](coverage.md) describes the
  intent; nothing enforces or reports it.
* Benchmarks are recorded, not gated. Shared CI runners are not a stable
  reference, so a timing gate would be flaky by construction, but that also
  means a large regression is only caught by a human reading the artifact.
* Only Linux can be exercised end to end locally. The Windows and macOS legs
  are cross-compiled by `scripts/verify.sh` and run in CI.
