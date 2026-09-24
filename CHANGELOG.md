# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Fixed `vacuum WAL-logged relocation` test (overlapping 8B fat pointers
  at `OFF_A=16/OFF_B=20`): `OFF_B` is now 28 (disjoint, still unaligned).
  `zig build test` is fully green.
- Real seeded relational bench (`benchmarks/relational/bench.js` +
  per-op wrappers, `scripts/bench_relational.js`): insert/scan/filter/
  join/agg over 20k rows with p50/p95/p99 + hardware report.
- `ArtMirror` (`src/sdk/client/relational/mirror.ts`): mirrors relational
  PKs into the engine ART (`tbl:<table>:<pk>`), reusing WAL/snapshots.
- Bounded range scan (`ArtIndex.scanRange` with hi pruning,
  `takyon_scan_range`, N-API `scan_range`, `ArtMirror.scanRange`,
  E2E vs live daemon).
- Vectorized kernels (`src/core/relational/column.zig`: 8-lane SIMD
  `filterU32` with selection vectors, Kahan `kahanSum`; arena wiring
  explicitly future).
- Native scan bench (`scripts/bench_scan.js`) and CI coverage
  (`relational.yml` builds ReleaseSafe, runs scan E2E + bench).
- Relational phase 1 (TS): `Database/Table/Query/Join/Agg/Tx/SQL` in
  `src/sdk/client/relational/` with 20+ vitest cases, exported from index,
  included in `dist` build.
- Relational phase 1 (Zig): `types/catalog/row/filter/aggregation/scan/
  query/join/tx` in `src/core/relational/` wired into `test.zig` + `lib.zig`.
- Docs: `docs/relational/` (vision, data-model, query-api, indexes,
  transactions, performance, sql-subset, migration) + architecture overviews.
- Examples/benchmarks placeholders for relational quickstart and bench.

### Changed
- License migrated from AGPLv3 / Commercial dual-licensing to **MIT**.
  Removed `COMMERCIAL_LICENSE.md` and the CLA requirement (replaced by DCO sign-off).
- Untracked runtime/binaries from git: `.zig-cache/`, `data.takyon*`,
  `lib/node.lib`, `src/sdk/client/*.js`.
- `build.zig`: added missing `zig build run` step for the daemon.
- CI now triggers on `main`, pins Zig `0.14.1`, and runs
  `zig fmt --check`, `zig build test`, and `tsc --noEmit`.
- Added canonical memory map `src/core/memory/layout.zig` mirrored by
  `src/sdk/client/layout.ts` (ring at 1024, records from 4096 to 2MB,
  strings at 10MB).
- `RingBuffer`: capacity is never left as garbage in autonomous mode,
  added bounds checks, fixed unit-test slice type.
- C-ABI (`exports.zig`): validates `size <= 48`, `offset + size`,
  `key_len`, and arena readiness; removed `debug.print` from the fast path;
  fixed `search` `-1` aliasing and ring capacity (16 -> 4096).
- Daemon (`main.zig`) and WAL test use `RING_DEFAULT_CAPACITY`.
- SDK: fixed `tsconfig` include, `binding.gyp` source (`binding.cc`),
  `find()` not-found check (`< 0`), record/string bump offsets,
  input validation, and `e2e_corruption_test.ts` `openSync` typo.
- Fixed all Zig `0.14.1` incompatibilities (`@fence`, `PROT`/`MAP`
  bit-casts, unmanaged `ArrayList`, test alignment); `zig build test`
  is green.
- Full ART: `Node4 → 16 → 48 → 256` growth with CAS-claimed slots,
  overwrite-in-place, `remove()` with empty-node unlinking, prefix keys
  via a reserved terminator byte (keys must be NUL-free), bounded
  bump allocation (`OutOfMemory` instead of OOB), and 5 unit tests
  including a 2000-key bulk round-trip.
- Durable WAL: `fsync` per sector, Direct I/O with automatic buffered
  fallback (`EINVAL` → reopen), corrupt-delta filtering in the flusher,
  drain-before-checkpoint, and no more swallowed write errors.
- Verified snapshots: coverage spans records + ART + string banks,
  footer CRC is actually checked on load (two-pass), `fsync` + directory
  sync precede WAL rotation, plus a snapshot→recovery round-trip test.
- Vacuum: stoppable thread (`stopVacuum` + `takyon_stop_vacuum`),
  traversal across all node types with corruption guards, exact-size
  temp buffers, bank geometry derived from arena size, 100 ms backoff.
- SHM lifecycle: `SharedArena.close()`, `takyon_disconnect_shm`, and an
  N-API `ArrayBuffer` finalizer end the per-connect fd/handle leak.
- Hardened `binding.cc`: every `napi_status` checked, keys longer than
  256 bytes rejected instead of truncated, `TypedArray` validated,
  `NODE_GYP_MODULE_NAME` fallback so `zig build` and `node-gyp` agree.
- SDK unit tests with vitest (9 tests: schema, layout, mocked proxy),
  `tsconfig.build.json` (tests excluded from `dist`), `test:unit` script.
- Toolchain: ESLint 9 flat config, typescript-eslint 8, `@types/node` 22,
  `npm audit fix` (only a dev-only `@vitest/mocker` moderate remains).
- `e2e_vacuum_test.js` fixed for the real 64MB layout; added `ROADMAP.md`.

### Added
- `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  `docs/architecture/README.md`, `ROADMAP.md`.
- `src/sdk/client/layout.ts` shared constants.

### Known limitations
- ART has no shrink-on-delete and no freelist (unlinked nodes are
  abandoned bump memory until compaction work lands).
- MPMC ring still needs per-slot sequence numbers for full rigor.
- Addon exposes an external `ArrayBuffer`, not a true `SharedArrayBuffer`.
- Vacuum `remove()`/`insert()` on overlapping keys need external
  quiescence (the daemon never deletes).
