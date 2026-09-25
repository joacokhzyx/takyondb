# TakyonDB Roadmap

Where the project stands and what comes next. Checked items are done and
covered by tests/CI; unchecked items are the "something very big" pipeline.

## Done (shipped)

- [x] MIT license, lean repo (no binaries/caches in git), contribution docs
- [x] Reproducible CI on `main`: Zig `0.14.1`, `zig fmt --check`,
      `zig build test`, `tsc --noEmit`, `vitest run`
- [x] Canonical memory map (`layout.zig` ↔ `layout.ts`), no magic numbers
- [x] Full ART: `Node4 → 16 → 48 → 256` growth, overwrite, delete,
      prefix keys via terminator byte, OOM handling, unit tests
- [x] ART shrink on delete (`256 → 48 → 16 → 4`) with type cascade
- [x] MPMC ring with per-slot sequence numbers (Vyukov)
- [x] Durable WAL: `fsync` per sector, Direct I/O with buffered fallback,
      corrupt-delta filtering, drain-before-checkpoint, segmented rotation
- [x] Verified snapshots: full-arena coverage (records + ART + strings),
      CRC check on load, `fsync` + directory sync before WAL rotation
- [x] Recovery round-trip test (snapshot → reboot → records + index intact)
- [x] Stoppable vacuum with full ART traversal and double-buffer compaction,
      multi-column compaction
- [x] SHM lifecycle: `takyon_disconnect_shm`, N-API finalizer, no fd leaks
- [x] Hardened N-API bridge (every status checked, no key truncation)
- [x] SDK unit tests (schema, layout, proxy with mocked bridge)
- [x] Daemon TCP/admin protocol (`PING/HEALTH/METRICS/CHECKPOINT`), `--data-dir`,
      `--checkpoint-sec`, `--port`, periodic checkpoints
- [x] Modern toolchain: ESLint 9, typescript-eslint 8, `@types/node` 22
- [x] Relational phase 1 (TS): tables, schemas, queries, joins, aggs, tx,
      SQL subset, 20+ unit tests green
- [x] Relational phase 1 (Zig): types, catalog, row, filter, agg, scan,
      query, join, tx with unit tests wired into `zig build test`

## Next: correctness hardening

- [ ] Node freelist (unlinked ART nodes still await reclamation)
- [ ] Fuzz the C-ABI surface (arbitrary offsets/sizes/keys) in CI
      (first step shipped: deterministic 1500-key ART sweep in `art.zig`)
- [ ] `shm_unlink` ownership + multi-tenant segments (named arenas)
- [ ] `munmap`/`CloseHandle` failure injection tests

## Next: relational hardening (zero-copy, no copy-paste SQL engines)

- [x] Native prefix scan (`ArtIndex.scanPrefix` + `takyon_scan_prefix` +
      N-API `scan_prefix` + `ArtMirror.scanTable`, E2E vs daemon vivo)
- [x] Bounded range scan (`ArtIndex.scanRange` with hi pruning +
      `takyon_scan_range` + N-API `scan_range` + `ArtMirror.scanRange`)
- [x] Pushdown kernels (`column.zig`: SIMD `filterU32`, Kahan `kahanSum`;
      arena wiring future)
- [x] Multi-root ART for secondary indexes (logical roots: disjoint
      `idx:<table>:<col>:` namespaces + `multiroot.zig` registry with UNIQUE
      flags + cardinality + order-preserving hex pads; padded numeric range
      + cardinality in `NativeSecondaryIndex`; physical per-root arenas future)
- [x] Predicate pushdown (SIMD filter) + vectorized aggregation in Zig
      (`column.zig` filterU32/filterF64 + selected aggs via C-ABI/N-API
      `pushdown.ts` with TS fallback; zero-copy arena wiring future)
- [ ] Persistent catalog records (`__catalog__:<table>`) with snapshot cover
      (shipped: fixed codec Zig + TS + `catalogKey`; pending: reboot E2E without JSON)
- [x] Row checksums for relational rows (`row.zig` sealed 12B header
      with CRC32 + tamper tests; background scrubber future)
- [ ] `npm run bench:relational` reproducible (insert/scan/filter/join/agg)

## Next: performance truth

- [x] Reproducible `npm run bench` (pinned workload + hardware report;
      `scripts/bench_proxy.js` pooled vs per-op + `bench_scan.js` vs daemon vivo)
- [ ] `SharedArrayBuffer` real + `Atomics.wait/notify` instead of
      external `ArrayBuffer` re-mapping per worker
- [x] Zero-alloc hot paths in the SDK (pooled `DataView`/`TextEncoder`/codecs/scratch;
      measured insert -32%, find+update p50/p99 -54%/-55%)
- [x] Published p50/p95/p99 with methodology, not marketing numbers
      (`docs/performance-truth.md`: KV chaos + pooled proxy + seeded relational)

## Next: operability

- [x] Daemon TCP/admin protocol (PING/HEALTH/METRICS/CHECKPOINT plus
      SCAN/RANGE over the native index; graceful drain on SIGINT)
- [x] Checksums on record headers, background scrubber (shipped: sealed
      TREC envelope `record_crc.zig` + allocation-free `scrub.zig` walker +
      C-ABI/N-API `verify_record`/`scrub_records` + TS mirror `scrub.ts`;
      daemon write-path migration + periodic scrub wiring future)
- [x] Packaging from CI artifacts only (no committed binaries;
      `packaging/{linux,macos,windows}` + `ci.yml` artifacts + release job)

## Non-goals (for now)

- SQL / query language (stays a KV + index engine)
- Clustering / replication (single-node durability first)
