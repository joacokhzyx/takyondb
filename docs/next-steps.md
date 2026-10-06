# What is next

Deliberately short, and ordered by what blocks a real user. Everything
else is either a gate in [../ROADMAP.md](../ROADMAP.md) or history in
[CHANGELOG.md](../CHANGELOG.md); this page is only what is *not* done,
with the behaviour you get today.

If a limit here is fixed, delete the entry and record it in the changelog.

## The limits that shape what the engine can be

### The flusher can wedge, and it did twice in a hundred runs

`commit()` timed out after 30s on two of the hundred-trial runs, with
`durable_tail` frozen at 1432 while the client had pushed some 78000 deltas
past it: no back-pressure, no dropped deltas, and a ring with plenty of
room. So the flusher thread stopped consuming rather than the client
stopped waiting -- but nothing in the daemon says so. `METRICS` reports
`wal_bytes`, which distinguishes the two cases when someone looks, and the
crash-property suite now prints the ring counters and the daemon's own
metrics line when `commit()` gives up, so a recurrence arrives with its
diagnosis attached rather than as a bare timeout.

The likely mechanism is a failed sector write: `writeToBuffer` copies into
the sector buffer and only resets `sector_pos` after `writeSector`
succeeds, so a write that fails leaves the buffer full, the next copy
computes zero free space, and the loop makes no progress. It has not been
reproduced on demand, so this entry is a lead and not a conclusion. What
is not a lead: the flusher has no way to report that it is stuck, and a
durability barrier that can hang forever with no diagnosis is worth fixing
regardless of what causes it.

### No reclaim, so no eviction

Deleting a record removes its index entry and frees nothing: both the
record region and the string region are bump allocators. Orphaned index
nodes are quarantined with reuse disabled by default. Nothing compacts
strings unless something starts the vacuum thread, and the daemon never
does — it is reachable through the C ABI only. That is also why there is
no TTL and no memory ceiling policy yet. Gate 3.

### The ring still cannot be resized after the segment exists

A push into a full ring now waits (250 ms by default, backing off), then
raises `BackpressureError`, a type distinct from every other failure
because it means "in mapped memory, not in the log". Saturation, wait time
and dropped-delta counts are in `METRICS` and in `client.ringStats()`.

What is still fixed: the ring capacity is decided when the segment is
created, from `regions.ring_capacity` in `takyon.json`. A daemon that
cannot drain the ring fast enough will refuse writes, and the only lever
is a restart with a bigger ring. The 250 ms wait is a number, not a
policy: it is not derived from a measured flush latency, and on a slow
filesystem a legitimate burst can still be refused. Gate 2.

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
