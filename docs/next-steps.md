# What is next

Deliberately short, and ordered by what blocks a real user. Everything
else is either a gate in [../ROADMAP.md](../ROADMAP.md) or history in
[CHANGELOG.md](../CHANGELOG.md); this page is only what is *not* done,
with the behaviour you get today.

If a limit here is fixed, delete the entry and record it in the changelog.

## The limits that shape what the engine can be

### No durability call

A write returns once the change is in the ring. The `fsync` happens later
on the flusher thread, and there is no `commit()` an application can call
to ask for it. The crash-recovery E2E covers the snapshot-plus-residual
path; the window between the return and the `fsync` is not a stated bound
anywhere. Gate 2.

### No reclaim, so no eviction

Deleting a record removes its index entry and frees nothing: both the
record region and the string region are bump allocators. Orphaned index
nodes are quarantined with reuse disabled by default. Nothing compacts
strings unless something starts the vacuum thread, and the daemon never
does — it is reachable through the C ABI only. That is also why there is
no TTL and no memory ceiling policy yet. Gate 3.

### A full ring fails after the bytes are already written

The ring holds a fixed capacity that the daemon creates with no flag to
change it. A push into a full ring returns a failure, the SDK throws, and
by then the client has already written the value into the arena. There is
no wait, no retry, no typed error and no saturation counter in `METRICS`,
so an operator cannot see it without writing a harness. Gate 2.

## What the substrate does not do yet

Region sizes are configuration now, so `record_bytes` is a number in
`takyon.json` rather than a compile-time constant. Three things follow,
and none of them is "the gate is not finished":

* **The arena is still fixed at startup.** Regions are configurable; the
  mapping is not. Growing a live segment needs `mremap` on POSIX or a new
  section on Windows, with a generation counter so clients re-attach.
  Nothing that needs it has needed it yet.
* **A layout change costs the snapshot.** The footer carries the region
  table, so a snapshot taken with one table cannot be restored into an
  arena with another. That is the correct behaviour -- the extent lengths
  alone cannot say where the bytes belong -- and it means shrinking a
  region voids the snapshot.
* **A layout version 2 segment is refused.** Its header has no table, and
  guessing one does not fail, it corrupts. The upgrade step is to remove
  the shared segment; the data is in the log and the snapshot, not in the
  segment.

## Native path coverage

* The relational **filter** and **aggregation** paths in TypeScript do
  not reach the Zig SIMD kernels. `pushdown.ts` exports them with an
  identical TypeScript fallback and parity tests, but nothing in the
  query path calls them, so `benchmarks/relational/bench.js` does not
  measure them. See [relational/performance.md](relational/performance.md).
* The arena-to-kernel handoff is not zero-copy: the TypeScript side still
  columnarizes rows into a `Float64Array` before calling the kernel.
* Secondary indexes use logical multi-root namespaces with hex-padded
  keys; per-root physical arenas are future work.
* Row checksums and the extent scrubber are implemented and exposed
  (`verify_record`, `scrub_records`), but the daemon's write path does
  not seal every row and no periodic scrub is scheduled.
* Native scans return at most 4096 offsets and take no cursor, so a table
  larger than that cannot be read through the native path. The TypeScript
  path can, because it owns the iteration. Gate 4.

## Alloc reduction on hot paths

Known allocation sites, in rough order of cost:

* `Table.scan()` copies every row, so a full scan of *n* rows allocates
  *n* objects. `QueryBuilder` then sorts, slices and maps on top.
* The key-value path creates a `Proxy`, a handler object and a target per
  `find()` and per `insert()`.
* `filter.ts` calls `Object.entries(where)` per row and compiles a
  `new RegExp` per row *per predicate* for `like`.
* `catalog_record.ts` constructs a `TextEncoder` per table and per column
  name.

The TypeScript-side hot paths are pooled where measurement showed it paid
to be; see [performance-truth.md](performance-truth.md) for which of those
numbers survived a reproducibility check.

## Prebuild coverage

`linux-arm64` and `darwin-x64` have no prebuild: the CI matrix builds
`linux-x64`, `darwin-arm64` and `win32-x64`. `loadBindings()` reports the
gap explicitly rather than failing at `require` time. Fixing it means
adding runners to the matrix or publishing per-platform packages.

## Verification gaps

* No coverage measurement is wired up. The structural intent is in
  [verify.md](verify.md#what-is-deliberately-not-gated): every Zig module
  carries inline tests, every TypeScript module a sibling test file, and a
  module without one is visible in review. Nothing measures or reports it.
* Benchmarks are recorded, not gated. Shared CI runners are not a stable
  reference, so a timing gate would be flaky by construction, which also
  means a large regression is only caught by a human reading the artifact.
* Only Linux is exercised end to end locally. The Windows and macOS legs
  are cross-compiled by `scripts/verify.sh` and run in CI.
