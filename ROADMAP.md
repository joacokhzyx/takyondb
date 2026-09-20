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
- [x] Durable WAL: `fsync` per sector, Direct I/O with buffered fallback,
      corrupt-delta filtering, drain-before-checkpoint
- [x] Verified snapshots: full-arena coverage (records + ART + strings),
      CRC check on load, `fsync` + directory sync before WAL rotation
- [x] Recovery round-trip test (snapshot → reboot → records + index intact)
- [x] Stoppable vacuum with full ART traversal and double-buffer compaction
- [x] SHM lifecycle: `takyon_disconnect_shm`, N-API finalizer, no fd leaks
- [x] Hardened N-API bridge (every status checked, no key truncation)
- [x] SDK unit tests (schema, layout, proxy with mocked bridge)
- [x] Modern toolchain: ESLint 9, typescript-eslint 8, `@types/node` 22

## Next: correctness hardening

- [ ] ART shrink on delete (`256 → 48 → 16 → 4`) + node freelist
- [ ] MPMC ring with per-slot sequence numbers (Vyukov), replacing
      claim-then-publish
- [ ] Fuzz the C-ABI surface (arbitrary offsets/sizes/keys) in CI
- [ ] `shm_unlink` ownership + multi-tenant segments (named arenas)
- [ ] `munmap`/`CloseHandle` failure injection tests

## Next: performance truth

- [ ] Reproducible `npm run bench` (pinned workload + hardware report)
- [ ] `SharedArrayBuffer` real + `Atomics.wait/notify` instead of
      external `ArrayBuffer` re-mapping per worker
- [ ] Zero-alloc hot paths in the SDK (pooled `DataView`/`TextEncoder`)
- [ ] Published p50/p95/p99 with methodology, not marketing numbers

## Next: operability

- [ ] Daemon TCP/admin protocol (health, metrics, graceful drain)
- [ ] Checksums on record headers, background scrubber
- [ ] Packaging from CI artifacts only (no committed binaries)

## Non-goals (for now)

- SQL / query language (stays a KV + index engine)
- Clustering / replication (single-node durability first)
