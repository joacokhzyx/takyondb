# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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

### Added
- `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  `docs/architecture/README.md`.
- `src/sdk/client/layout.ts` shared constants.

### Known limitations
- ART only implements `Node256` insertions; `Node4/16/48`, delete/update,
  and path compression are still missing.
- MPSC ring still needs per-slot sequence numbers for full rigor.
- WAL/snapshot lack `fsync` + snapshot CRC verification + quiesce.
- Vacuum is not production-safe (no epoch protection / stop signal).
- Addon exposes an external `ArrayBuffer`, not a true `SharedArrayBuffer`.
