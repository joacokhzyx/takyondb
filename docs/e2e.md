# TakyonDB E2E Tests

Relational smoke runs without daemon: see `e2e-relational.md`
(`scripts/e2e_relational_test.js`).

E2E suites exercise the real daemon (`zig-out/bin/takyondb[.exe]`) plus the
compiled N-API addon (`zig-out/bin/takyondb_bridge.node`). Run them via the
harness (all seven suites, timeouts enforced, nonzero exit on failure):

```bash
zig build -Doptimize=ReleaseSafe   # daemon + bridge
cd scripts && npm run test:e2e
```

Or typecheck without running: `cd scripts && npm run typecheck`.
Single suites: `node scripts/e2e_vacuum_test.js`,
`node scripts/e2e_scan_test.js`, `node scripts/e2e_admin_scan_test.js`,
`node scripts/e2e_crash_auto_test.js`,
`node scripts/benchmark_chaos.js`, or (from `scripts/` with `NODE_PATH`
pointing at `src/sdk/ts/node_modules`) `node -r ts-node/transpile-only
scripts/e2e_zerocopy_test.ts` and `e2e_corruption_test.ts`. Note:
`e2e_zerocopy_test.js` is self-contained and is what CI runs; the stale
`e2e_corruption_test.js` companion (it required nonexistent TS paths)
was removed — run the `.ts` via ts-node. Shared spawn/timeout helpers
live in `scripts/helpers/daemon.ts`.

CI (`build-and-test`) currently runs only `e2e_zerocopy_test.js` and
`benchmark_chaos.js` on all three OSes.

## Prerequisites (all suites)

* `zig-out/bin/takyondb{,_bridge.node}` must exist (`zig build`).
* Stale state must be removed first: suites delete `./data.takyon` (and
  `data.takyon.snap` where applicable) relative to the repo root at startup —
  do not run two suites concurrently against the same files.
* Suites that spawn the daemon expect it at
  `zig-out/bin/takyondb` (`takyondb.exe` on Windows) and give it ~1 s to map
  shared memory before connecting.
* Memory sizes are per-suite constants (16 MB for zerocopy/crash-recovery,
  64 MB for vacuum/chaos); each `worker_thread` re-maps via
  `initSharedMemory` (no shared `SharedArrayBuffer` yet).

## Suites

1. **Zero-copy (`scripts/e2e_zerocopy_test.{ts,js}`)** — 4 workers insert
   10 000 `ID-xxxxx` keys via `insert_index` (value offsets `4096 + id*64`),
   then the main thread `search_index`es all 10 000. Asserts zero insert
   failures, zero missing keys, and reports insert/search latency.
2. **Corruption (`scripts/e2e_corruption_test.{ts,js}`)** — boots the daemon,
   writes a healthy delta, SIGKILLs it, overwrites 5 bytes of `data.takyon`
   at offset 20 with `0xFF` (simulated torn write), and reboots. Asserts the
   daemon logs `CRC32 corruption detected` and truncates the bad sector
   without panicking.
3. **Crash recovery (`scripts/e2e_crash_auto_test.js`)** — fully
   self-driving on an isolated `--data-dir`: phase 1 inserts 5000
   `SNAP-xxxxx` keys, checkpoints, writes 4086 bytes of `0xAA` residual
   payload + `notifyArena`, SIGKILLs the daemon itself, reboots, and
   asserts all 5000 snapshot keys resolve **and** the residual WAL bytes
   are intact. (The legacy `e2e_crash_recovery_test.ts` needs a manual
   SIGKILL and is kept for interactive debugging only.)
4. **Vacuum (`scripts/e2e_vacuum_test.js`)** — boots the daemon on the real
   64 MB layout, inserts `user:1`, starts vacuum, and performs 20 000 string
   updates. Asserts no string-arena OOM (compaction keeps up) and the final
   read equals `Generation_X_19999`.
5. **Chaos benchmark (`scripts/benchmark_chaos.js`)** — 4 workers × 50 000
   mixed read/insert/update ops with periodic checkpoints and vacuum
   running. Asserts completion (kills the daemon, exits 0) and reports
   p50/p95/p99/max latency; numbers are informational, not gates.
6. **Scan (`scripts/e2e_scan_test.js`)** — boots the daemon, inserts 2000
   `SCAN-xxxxx` + 500 `OTHER-xxxxx` keys, and asserts native
   `scan_prefix` returns exact sets plus truncation/empty cases, and
   `scan_range` returns exact bounded ranges.
7. **Admin scan (`scripts/e2e_admin_scan_test.js`)** — boots the daemon,
   inserts 40 keys, and asserts the TCP admin protocol (`PING`, unknown
   command, full/capped scans, bounded/unbounded ranges, bad-arg
   rejections).
8. **Catalog reboot (`scripts/e2e_catalog_reboot_test.js`)** — boots the
   daemon on an isolated `--data-dir`, persists `users` + `orders`
   descriptors as `__catalog__` records via `CatalogRecordStore`,
   checkpoints, SIGKILLs, reboots, and asserts both descriptors decode
   identically with no JSON sidecar (requires the SDK dist build).
9. **Refcount (`scripts/e2e_refcount_test.js`)** — boots the daemon,
   connects twice over one mapping, drops the first client, and asserts
   the second still reads/writes; then drops it and asserts a fresh
   connect works (guards use-after-unmap on shared mappings).
10. **Graceful unlink (`scripts/e2e_graceful_unlink_test.js`)** — boots
    the daemon, SIGINTs it, and asserts a clean exit plus the freed OS
    segment name on POSIX (Windows unlink is a no-op: only the exit is
    asserted there).
