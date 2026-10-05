# What the relational paths cost

This page is deliberately mostly about what is *not* measured, because
the interesting number in this layer is the distance between the engine
and the query.

## Point read by primary key

The same radix tree the key-value path uses, reached through the addon:
`tbl:<table>:<pk>` to a record offset, via `ArtMirror`.

There is **no measurement of the relational primary-key path on its own.**
The chaos benchmark's p50 belongs to the key-value path and is a
reference, not a measurement of this one.
[../performance-truth.md](../performance-truth.md) has the number and what
it excludes.

## Scan

`table.scan()` is `O(n)` over rows **and it allocates**: it copies every
row, so a scan of *n* rows allocates *n* objects. A projection reduces the
work done afterwards; it does not avoid the copy.

The native scan path does not copy — it returns record offsets out of the
index — which is why the two are not interchangeable. It is also bounded:
at most 4096 offsets per call, no cursor. The TypeScript path has no such
bound because it owns the iteration.

## Filter

Predicates run against JavaScript objects. Not a `DataView` comparison,
not allocation-free.

The clause is compiled **once per query** rather than once per row: the
previous version called `Object.entries(where)` for every row and built a
`new RegExp` for every `like` predicate of every row. Measured over 20,000
rows, three runs per state, full range: **3122–5207 µs before, 735–754 µs
after**, about 4.3x, with non-overlapping ranges. `in` with eight or more
elements compiles a `Set` once for the same reason.

The SIMD path (`filterU32` / `filterF64` in
`src/core/relational/column.zig`) exists, is exported through the C ABI
and the N-API layer, and is **not called by the relational filter**.

## Join

A hash join: `Map<value, rows[]>` to build, then a streaming probe. Both
sides call `scan()`, so both sides copy every row before the probe starts.

## Aggregates

Single-pass, in TypeScript. `Math.min(...values)` and `Math.max(...values)`
spread onto the call stack and are a hazard for a wide column; iterating
in a loop avoids the limit.

The Zig kernels (`kahanSum`, `kahanSumSelected`, `minSelected`,
`maxSelected`) exist, are exported, and have an identical TypeScript
fallback in `pushdown.ts` with parity tests. Columnarizing arena rows into
a `Float64Array` before calling them is still future work: today the
TypeScript side does that copy, so the kernel would not be reading arena
memory anyway.

## Strings

The engine's bump allocator and vacuum, double-buffered. The relational
layer adds nothing to it.

## What the benchmark measures

`node scripts/bench_relational.js` measures the TypeScript engine. Its
methodology line says "no IPC/daemon, no native pushdown", and that is the
honest scope: **it does not measure the SIMD kernels**, because no query
reaches them.

It reports its hardware, its per-table seeds and its methodology in the
JSON record. CI gates it on completion, not on a number: shared runners
are not a stable timing reference, and a timing gate would be flaky by
construction.
