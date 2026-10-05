# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- **The project has a mission, and the docs now measure it against the
  code.** TakyonDB described itself as an experimental zero-copy
  database, which is a mechanism and not a reason to exist, and it left
  the reader to guess what the project was for. `docs/mission.md` states
  it: Takyon is the data layer a server runs on, with storage, indexes,
  cache and queries in one process over one arena, so a server spends
  less CPU, memory and energy than it does running a database and a
  cache beside it.

  **Nothing about the engine changed.** No code, no on-disk format, no
  wire contract, no package or segment name. `Takyon` is the product and
  `TakyonDB` is the engine inside it; the repository, the npm package and
  the daemon binary keep the `takyondb` name.

  The mission is larger than the engine, so the same entry retires the
  claims that could not survive it. The README no longer opens with
  "insanely fast, zero-copy, lock-free": "zero-copy" now names what is
  mapped and shared and points at `docs/performance-truth.md` for read
  path cost, and "lock-free" is gone from the user-facing description
  because what a caller experiences is a bounded ring that can refuse a
  write. The Debian control file, the systemd unit, the Homebrew formula
  and the npm description carried the same adjectives and now say what
  the package is.

  New pages: `docs/mission.md` (the mission, what it would replace, and
  a "what we do not claim yet" section that names every gap with the
  file documenting it) and `docs/infrastructure.md` (the four layers and
  the design behind each roadmap gate). `ROADMAP.md` is now seven gates,
  each with the experiment that closes it, and its former non-goal "SQL
  is not a goal, this stays a KV + index engine" is replaced by "Gate 4
  decides how far the query surface goes".

  **Known gaps added by this change:** the cache tier that removes Redis
  from a server's architecture does not exist, so the claim is a Gate 3
  design rather than a feature; and the energy claim has no power
  measurement behind it yet, which is Gate 5. Both are stated in
  `docs/mission.md` and neither is described as shipped.

### Removed

- **Three documentation pages that contradicted each other.**
  `docs/roadmap-visual.md`, `docs/executive-roadmap.md` and
  `docs/final-status.md` duplicated `ROADMAP.md` and `CHANGELOG.md` while
  carrying hand-written counts — the exact failure that made
  `docs/final-status.md` claim 375 commits and 97 TypeScript tests when
  the tree held 133 and 75. `docs/next-steps.md` is where an open limit
  belongs and says so.

### Fixed

- **Pages that stated limits the code does not enforce.**
  `docs/architecture/README.md` claimed a 64 MiB minimum arena when the
  constant is 16 MiB, placed the record bump word at offset 2048 when it
  is 296128, documented a v1 snapshot footer that recovery now rejects,
  and listed four items as missing that shipped long ago (index
  shrink-on-delete and the node freelist, the Vyukov ring, C-ABI
  fuzzing, and `shm_unlink` ownership). `docs/operations.md` printed an
  installer version that disagreed with the canonical one.
  `docs/verify.md`, `docs/structure.md` and `docs/relational/limits.md`
  now state commands and bounds the code enforces instead of counts that
  were stale.

The work below shipped under [0.1.0](#010---2026-09-25).

### Added

- **The public TypeScript surface is documented.** Every exported symbol and
  public class member in `src/sdk/` now carries JSDoc with `@param`,
  `@returns` and `@throws` where they apply, so the contracts appear in editor
  hovers and generated declarations rather than only in `docs/sdk.md`. The SDK
  previously had exactly one `@param` and no `@returns` or `@throws` across
  4,956 lines, and 49% of exports had no doc comment at all. The 26
  boilerplate file banners are gone: 871 lines repo-wide that were 42% of all
  comments in `src/` and repeated the filename the reader can already see,
  replaced by a one-line statement of what each module is for.

  Documenting the surface against the C-ABI rather than from memory turned up
  ten places where `docs/sdk.md` and the code disagree, including two methods
  whose return values the doc described backwards. Those are fixed in the
  JSDoc now and queued for the `docs/` pass.

### Changed

- **A snapshot now covers only the extents in use, not the whole arena.**
  `createSnapshot` serialized the entire mapped region, so an idle 64 MiB
  arena wrote **10,493,952 bytes** on every checkpoint — 15.1 GB/day of
  rewrites for a database holding nothing, which is the single most
  destructive behaviour in the project. The same run now writes **8,192
  bytes**, a 1281x reduction, and recovery got faster as a side effect
  because it no longer reads 21 MB to restore an empty database: median
  boot over 5 runs went from 581 ms to 36.9 ms.

  The four regions (global header, record bank, ART bank, string bank) are
  packed into 4 KiB blocks carrying only their live extent, with the bump
  word included at the head of each extent so the restored allocator
  points into data that was actually written rather than at whatever the
  shared segment happened to hold. The ring is deliberately not carried:
  `finalize` zeroes it and the daemon re-initializes it as master.

  Format v3, with a version word in the footer. v2 is refused **by version,
  never reinterpreted**: in v2 the three words after the CRC are
  `active_len / art_bump / str_bump` and in v3 they are extent lengths, so
  reading one under the other's rules restores a plausible-looking arena
  at the wrong offsets. A v2 file is rejected with a message that names the
  version and the consequence.

  **Upgrade note:** a v2 snapshot cannot be read by this build and cannot be
  converted in place, because its payload *is* the 10 MB prefix image.
  Recovery falls back to WAL-only replay, and since the previous run
  truncated the WAL after its successful snapshot, that path can lose data
  the old snapshot still held. Delete the stale `.snap` — or downgrade —
  after upgrading. No compatibility reader is shipped, because reading v2
  correctly means keeping the prefix-copy path alive permanently.

  Bytes outside the restored extents are zeroed rather than left alone:
  recovery runs against the surviving shared segment, so a stale record and
  a real one are otherwise indistinguishable. If the snapshot is rejected
  mid-restore, the extents already scattered are blanked, and the WAL replay
  that follows rewrites every byte it owns.

### Fixed

- **Index writes are now durable.** `takyon_insert_index` mutated the ART in
  shared memory and emitted nothing to the log, so a key indexed after the
  last checkpoint was gone after a crash: the snapshot carries the ART as of
  when it ran, and the arena holds no bytes that say which key points where.
  Measured with the `index-persist` E2E suite before the change, 300/300 keys
  indexed before the checkpoint recovered and **0/200** indexed after it did,
  with a 0-byte WAL. Both are now 300/300 and 200/200.

  The ART is a bump allocator whose insert writes both newly allocated nodes
  and child slots into pre-existing ones, so the write set is one contiguous
  range plus scattered 4-byte stores and replaying arena deltas cannot
  rebuild the tree. The fix is a **logical** record instead: `WalEntryHeader`
  gains a `kind` byte, `index_op` records carry the key and the value offset
  as a payload, and `recoverWal` re-applies them into the ART after the arena
  replay and before the bump words are written. Replay is idempotent, so
  applying the same log twice yields the same index.

  Two properties make this cheap rather than a format break. The `kind` byte
  occupies what used to be zeroed struct padding, so every pre-existing log
  reads back as `arena_write` and old files replay without migration; and an
  unrecognised `kind` stops recovery instead of being reinterpreted, because
  guessing the record shape would produce a plausible but wrong arena.

  `takyon_insert_index` now allocates the key in the string arena and pushes
  the delta *before* mutating the ART, so a full ring returns -1 with the
  index untouched rather than leaving an entry no log describes. The string
  allocator seeds its bump word on first use: a client that maps the segment
  itself never runs the recovery that would have seeded it, and allocating
  from a zero bump hands out offset 0 — the ring header — which corrupts head,
  tail and capacity and surfaces much later as an inexplicable fault inside
  the index.

  `recoverWal` takes an optional `*ArtIndex`, because a 16 KB test arena has
  no room for nodes rooted at `ART_ROOT_OFFSET` and `ArtIndex.init` panics on
  the out-of-range bump word rather than returning an error.
- **A malformed WAL could abort the daemon on start.** Two problems in the
  replay path, both reachable from ordinary data once the parser stopped
  truncating at the first padded sector.
  - `header.offset + header.length` was evaluated in `u32`. A scan that lost
    its place read a near-`2^32` offset out of payload bytes, and the
    addition panicked, killing the daemon with `thread … panic: integer
    overflow` before it could serve a single request. The sum is now widened
    to `usize`, bounds-checked against the arena, and an out-of-range entry
    ends the valid prefix instead of trapping.
  - The carry region for an entry split across sectors was one 4K page, but a
    maximum-size entry (8192 bytes) spans three sectors, so the carried tail
    could exceed a page and `CARRY_REGION - leftover_len` underflowed. The
    region is now three sectors and a tail longer than one whole entry is
    treated as corrupt framing rather than propagated.

  Reproduced against a real 6 MB / 1489-sector log left by the chaos
  benchmark: the daemon panicked on every start. It now recovers the log
  (record bump 1,448,576 and string bump 12,690,476, versus the 296,136 /
  10,485,764 init values it stopped at before).
- **The writer no longer emits sectors the reader cannot classify.** The
  replay parser has to tell a *full* sector (tail is a split entry, carry it
  forward) from a *padded* one (tail is padding, drop it), and content alone
  cannot: on a full sector whose split entry continues with zero bytes,
  guessing "padding" dropped the carry and the next sector was read as a
  header. `flushBuffer` now takes a `force` flag, and the idle/timer path
  uses `flushIfUnambiguous`, which refuses to write a sector whose slack is
  shorter than one entry header. At most 7 bytes wait for the next delta
  instead, and a forced flush may still write a short tail because it only
  happens at shutdown, on the last sector, where there is nothing after it to
  misalign. `MIN_PADDING` is derived from `@sizeOf(WalEntryHeader)` rather
  than written as a literal, because that size is 8 and not 6 — a packed
  struct takes the alignment of its widest field. The constant is load-bearing
  for the whole scheme, and the hardcoded 6 would have reintroduced the
  ambiguity the fix exists to remove.
- **The chaos benchmark was publishing numbers derived from dropped writes.**
  `notifyArena` and `pushDelta` return -1 when the ring is full, which is
  back-pressure, and the SDK treats it as a hard failure
  (`src/sdk/client/proxy.ts` throws). The harness ignored both return values,
  so **171,156 of 200,000 writes were silently discarded** and the report
  still claimed 200,000 operations — and the README quoted that run's p50.
  Writes now retry against a deadline, so the number describes a client that
  actually committed its work, the drop count is reported with an exact
  denominator, and a run that loses any write exits non-zero instead of
  publishing. On the reference host the retry also absorbed the transient
  stalls that a checkpoint causes (it serializes the whole arena while the
  flusher is not draining), which moved p99 from 1.085 ms to 0.206 ms; the
  p50 is unchanged at 0.002 ms.
- **An idle daemon no longer holds 1.8 cores.** Both background loops used
  `Thread.yield` and `spinLoopHint` as their idle action, and neither blocks:
  the admin/checkpoint loop in `main.zig` and the WAL flusher in `wal.zig`
  each spun flat out with nothing to do. Measured on a 2-vCPU host with zero
  clients attached, the daemon consumed **1.81 cores**, so a database that was
  doing nothing drew more power than a working set in page cache. The flusher
  now sleeps on a bounded exponential backoff (50µs doubling to 2ms, reset on
  the first delta), and the admin loop sleeps in 100ms slices between its 10s
  metrics tick and the checkpoint deadline. Same measurement after the fix:
  **0.006 cores**, a ~300x reduction, with the flusher's added durability
  latency still well under one fsync. The new `idle-cpu` E2E suite reads the
  daemon's own CPU accounting and fails above 0.1 cores, so a loop that
  regresses to spinning is caught instead of quietly costing money.
- **WAL recovery no longer discards every write after the first padded
  sector.** `flushBuffer` zero-fills the unused tail of any sector it does
  not fill, and the flusher calls it whenever the ring drains, so a real log
  is a run of padded sectors. The replay parser read that zero padding as an
  all-zero entry header, set a `stop_reading` flag, and then broke out of the
  **sector** loop rather than just the inner entry scan. The result: recovery
  kept the entries of the first sector and silently dropped the rest. Measured
  on a log of 2000 entries written in 286 flushed batches, **7 of 2000 were
  recovered**; a 5-batch run lost 797 of 1000 bytes after `SIGKILL`, with no
  warning on stdout. Zero padding now ends the current batch only, and
  `carryLenFrom` decides whether a sector tail is padding (drop it) or a
  genuinely split entry (carry it to the next sector) by checking for the
  all-zero header that the producers refuse to emit — `takyon_notify_arena`
  and `takyon_push_delta` both reject `size == 0` for exactly this reason.
  Carrying padding is not an option: prepending those zeros to the next
  sector shifts its framing, the misaligned length read then trips
  `MAX_ENTRY_LEN`, and everything behind it is lost too. Regression coverage
  is `recovery.zig` "WAL replay survives MULTIPLE partial sectors" (3
  batches), "…many flushed batches (2000 entries)", and the E2E suite
  `wal-multisector`.
- **The crash-recovery E2E suites were not testing recovery.**
  `takyon_connect_shm` reference-counts and returns the *same* mapping while
  the count is above zero; `takyon_disconnect_shm` only unmaps on the last
  call. `e2e_crash_auto_test.js` connected twice and disconnected once, so the
  mapping was never released and its "reboot" phase re-read this process's
  own pre-crash shared memory. The suite passed for any daemon that started,
  including one that recovered nothing, which is why the WAL defect above
  survived a green CI. Both call sites now count connections explicitly and
  drain the count, so the post-crash phase reads a genuinely fresh mapping.

  The pre-existing crash suites also crafted their payload to fill exactly
  one sector (`RESIDUAL_SIZE = 4086`, "+6B header = 4092"), so even once
  unmapping was fixed they could not reach the multi-sector path. The new
  `wal-multisector` suite writes 5 separately flushed batches and asserts the
  WAL really is multi-sector before it trusts the result. That residual is
  now 4084, which plus the 8-byte header is exactly one full sector, so the
  suite tests the path its comment describes; the previous 4086 overflowed by
  two bytes and quietly split the entry across two sectors instead.

  `e2e_crash_recovery_test.ts` and `e2e_crash_recovery_test.js` are removed.
  They were superseded by `e2e_crash_auto_test.js`, never registered in
  `run-e2e.js`, carried the same unbalanced-refcount flaw, and had not been
  run by anything.
- **`scripts/verify.sh` no longer miscounts its own E2E suites.** The step
  label hardcoded "10 suites" and had been wrong since the eleventh was
  added. The count is now read from `run-e2e.js` at run time, so a label
  cannot drift away from reality again.

### Known gaps

- **The index is durable only with a daemon attached.** With `takyondb`
  running, every index write is now WAL-logged and replayed into the ART, so
  a key indexed after the last checkpoint survives a crash. In the autonomous
  path — where the client creates the shared segment itself and no daemon owns
  the data directory — there is no log writer at all, so nothing this process
  sends can become durable, and the ART is lost on restart exactly as before.
  That is not a silent downgrade: in that mode record *bytes* are equally
  volatile, because no WAL is being written either. The distinction is now
  explicit in `takyon_insert_index` rather than implied by silence.

## [0.1.0] - 2026-09-25

First versioned release. Pre-alpha: the engine, the SDK, the daemon and the
installer packages are all installable and tested, but the API is not frozen
and the daemon must not be exposed to untrusted networks or processes (see
[SECURITY.md](SECURITY.md)).

### Fixed

- **Windows CI no longer fails at random.** `TakyonDB CI` failed 5 of the last
  20 runs, every one on `windows-2022`, always the same two Zig tests. The
  flusher test asserted the on-disk size after stopping the loop, but the
  trailing partial sector is only written by `flushBuffer`, which the loop
  calls from its idle branch: a timing race that slower hosts lose. It now
  flushes explicitly after the join, and gained a portable
  `bytes_written == expected sectors` invariant (previously the only sector
  accounting check was Windows-gated, so Linux and macOS verified nothing).
  The ten cwd-relative `data.takyon` paths shared by `wal.zig` and
  `snapshot.zig` moved to `std.testing.tmpDir`: `WalManager` seeds
  `bytes_written` from the live file size, so a leftover file silently shifted
  every count, and on Windows an open handle makes `deleteFile` fail.
- **E2E suites no longer leak daemons.** Every suite called
  `daemon.kill('SIGKILL')` only on the happy path, so the first failing
  assertion left a daemon spinning at ~25% CPU holding the SHM segment and the
  admin port. Six were alive after one local run, and the signature symptom
  was `admin SCAN` answering `OK 0`. `scripts/helpers/daemon.js` replaces the
  dead `daemon.ts` with a real readiness handshake, a `stop()` that awaits the
  actual exit, a `withDaemon()` try/finally, and a process-exit safety net;
  `run-e2e.js` now fails a suite that leaked one.
- **No more blind waits in the E2E suites.** The crash and catalog suites
  slept 1000-2500 ms and hoped; on a loaded host the SIGKILL landed mid-write,
  which is what produced "bad catalog magic". They now poll the artifact the
  engine actually produces (snapshot on disk, WAL settled). Suite time fell
  from ~28 s to ~7 s (crash 6075->874 ms, catalog 5578->666 ms,
  admin-scan 6085->78 ms) purely from removing the fixed waits.
- **The published tarball is no longer publishable without an entry point.**
  `npm pack` does not compile TypeScript, so a job that ran only `npm ci`
  produced a package with no `dist/` at all. `src/sdk/ts/scripts/prepack.mjs`
  refuses to pack without `dist/index.js` and the addon loader.
- `scripts/` typecheck was red: `e2e_corruption_test.ts` did not implement
  `remove_index`.
- `stopDaemon()` awaited the child's `exit` event on a process `startDaemon()`
  had `unref`'d, so Node could exit silently with code 0 and skip every
  cleanup step after that await.
- `std.process.args()` is unimplemented on Windows in Zig 0.14.1; the daemon
  argument probe uses `argsWithAllocator`.

### Added

- **`npm install takyondb` works.** The package shipped only `dist/`, with no
  native addon and no code that knew where one came from; the README
  quickstart declared `bindings` with no runtime value and pointed at a
  repo-relative `zig-out` path that cannot exist inside `node_modules`.
  - `loadBindings()` resolves the addon from an explicit path,
    `TAKYON_ADDON_PATH`, the bundled `prebuilds/<platform>-<arch>/`, a
    `node-gyp` `build/Release`, a flat copy, then the in-repo `zig-out`
    build. An explicit path that does not exist fails immediately rather than
    falling through, so you never silently get a different binary than you
    asked for. Errors list every probed path, the platform, the supported
    platforms and three concrete fixes.
  - `new TakyonDB()` auto-loads when no bindings are passed; passing them still
    works, so the mock seam used by the tests is untouched.
  - The release job assembles `prebuilds/` from each OS artifact
    (`linux-x64`, `darwin-arm64`, `win32-x64`) and refuses to publish unless
    `npm pack --dry-run` shows all three plus the loader. The addon is N-API,
    so one binary per platform covers every Node release.
  - `scripts/pack_smoke.js` packs the tarball, installs it into a directory
    outside the repository, and drives the installed package (loadBindings,
    insert/find/update/delete through shared memory, native prefix and range
    scan, the admin TCP protocol, and the addon-free relational path). It runs
    as a `pack-smoke` job on all three OSes and caught the missing `dist/` on
    its first run.
  - The macOS `.pkg` now packages the N-API bridge; it previously shipped the
    daemon only, so a macOS install produced a daemon Node could not talk to.
- **`--version` and `--help` on the daemon**, answered before any side effect
  (no segment, no WAL, no port bind), so packaging scripts and operators can
  interrogate the binary safely.
- `src/core/version.zig` is the Zig side of the version source of truth, with
  a test for its shape.
- `scripts/verify.sh` replays the CI matrix locally in one command, including
  cross-compiling the daemon for `x86_64-windows` and `aarch64-macos` so
  platform-specific compile errors surface in seconds instead of a CI
  round-trip.
- `scripts/docs_check.js` is a real checker: it resolves every relative link
  and anchor in every markdown file, validates code fences, and runs in CI.
  It was a stub that asserted four files existed and was not wired in.
  `docs/index.md` was rewritten as a full, verified index; building it
  surfaced two genuinely broken references (`docs/security.md` and
  `relational/index.md`, which is `README.md`).
- `scripts/project_stats.js` generates `docs/metrics.md` and `--check` fails
  CI on drift, so the project counts cannot go stale again.
- `scripts/check_version.js` makes version drift a build failure.
- `scripts/examples_check.js` typechecks and *runs* all ten relational
  examples, and is wired into CI.
- `scripts/bench_pooling.js` measures the pooling optimization in isolation,
  where both arms run identical code. This is what makes the pooling claim
  re-derivable: avg -47.8%, p50 -56.4%, p95 -22.7%, p99 -72.8%.
- `timeout-minutes` on the CI bench steps, so a hang reports as a timeout
  instead of consuming the 6 h job budget.

### Changed

- The thirteen E2E and bench scripts that hardcoded the addon path now go
  through `scripts/helpers/addon.js`, which delegates to the SDK loader.
- `benchmark_chaos.js` hoisted a `TextEncoder`, an `ArrayBuffer`, a `DataView`
  and a `Uint8Array` out of its timed region, so its percentiles measure the
  engine rather than V8 allocation: p99 0.019-0.057 ms -> 0.011-0.012 ms. It
  also now reports its hardware, which the README's table previously lacked
  entirely, so those numbers could not be attributed to any machine.
- `bench_proxy.js` now reports absolute cost of the shipped hot path with full
  methodology, warmup, repetitions, throughput and p95. It no longer claims a
  pooling delta, because that delta is not measurable at that level: a
  per-operation control has to do the same work to be comparable, and go any
  further and it is simply a faster algorithm.
- `benchmarks/relational/bench.js` reports its per-table LCG seeds verbatim
  (it claimed a single seed of 42 while `seedOrders` used 7, so a run could
  not be reproduced from its own output) and adds a warmup pass plus
  repetitions.
- The daemon `--version` string and the Linux, macOS and Windows packagers all
  read the version from `src/sdk/ts/package.json`. The packagers said `1.0.0`
  while the SDK said `0.1.0`, reconciled only by a manual checklist item.
- Removed `src/sdk/bindings/binding.gyp` and the `node-gyp` devDependency:
  nothing referenced the gyp file, it linked `zig-out/lib/takyondb.lib` on
  Windows which `build.zig` never emits, and it offered a second build path
  that could not work.

### Documentation

- Removed the `SharedArrayBuffer` claim from the README and documented the
  real mechanism: the addon returns an external `ArrayBuffer` (one `mmap` per
  V8 isolate), because Node has no way to wrap a raw pointer in a SAB, so
  `Atomics.wait` is structurally unavailable on it.
- Corrected `docs/sdk.md`, which claimed the mapping is unmapped by the
  `ArrayBuffer` finalizer (it is a deliberate no-op, and
  `client.shutdownEngine()` is the explicit teardown) and that no close API
  exists.
- Corrected `docs/relational/performance.md`, which promised a `DataView`
  comparison with no allocation; the filter is `matchesWhere` over JS objects
  and compiles a `new RegExp` per row and per predicate.
- Rewrote `docs/performance-truth.md`: every harness, what each one does and
  does not include, how to reproduce each, and the reference run.
- The README quickstart is now the flow `pack_smoke` executes: install, start
  the daemon, connect, query, and talk to the admin port.
- `examples/relational/` documented all ten examples instead of one, and
  `quickstart.ts` no longer imports `../src/...` (which resolved to nothing).
- `CHANGELOG.md` gained its first released-version section; until now it had
  167 lines under `Unreleased` and no released heading at all.

### Known issues

- `linux-arm64` and `darwin-x64` have no prebuild: the CI matrix builds
  `linux-x64`, `darwin-arm64` and `win32-x64`. On the other two,
  `loadBindings()` says so explicitly instead of failing at `require` time.
- The relational filter and aggregation paths in TypeScript do not reach the
  Zig SIMD pushdown kernels yet, so the relational benchmark does not measure
  them. See `docs/relational/performance.md`.
- A historical `v1.0.0` git tag exists from before the SDK was versioned; it
  does not correspond to this release. It is left in place rather than
  rewritten.
- CI timings are recorded, not gated: shared runners are not a stable
  reference and a timing gate would be flaky by construction.


---

<details>
<summary>Full entry-by-entry history of the cycle that became 0.1.0</summary>

These are the original detailed entries that accumulated under `Unreleased`
before this release was cut. They are kept verbatim so the record of *when*
each capability landed is not lost; the summary above groups them by theme.

### Added
- Daemon owns the SHM name: graceful shutdown unlinks the segment (mappings
  persist until close; crash exits still leave it for recovery). Covered by
  unlink idempotency tests + `e2e_graceful_unlink_test.js` (in CI + runner).
- Reference-counted engine detach: `takyon_disconnect_shm` no longer unmaps
  while other clients hold the mapping (second client previously lost it —
  use-after-unmap class). Covered by `e2e_refcount_test.js` (in CI + runner).
- E2E daemons now die via SIGKILL on teardown: plain `kill()` left zombies
  holding the SHM segment and TCP port, poisoning the next suite
  (`admin SCAN` saw `OK 0` after `scan`). Verified back-to-back with no strays.
- E2E SHM isolation per suite: `vacuum`/`chaos`/`zerocopy` harnesses now
  unlink stale segments at start like the other suites (vacuum needs 64MB;
  a leftover 16MB segment failed the connect).
- `CatalogRecordStore` + self-driving reboot E2E: DDL persists as
  `__catalog__` ART records (payloads in the string arena) and survives a
  real SIGKILL with no JSON sidecar (wired into `relational.yml` after the
  dist build and into the local `run-e2e` runner).
- Pushdown wired end-to-end: `filterF64` + selected-vector aggs
  (`kahanSumSelected/minSelected/maxSelected`) in `column.zig`, C-ABI
  `takyon_filter_u32/f64` + `takyon_agg_*_selected` (strict op validation),
  N-API `filter_u32/f64` + `agg_sum*` , TS `pushdown.ts` with identical
  fallback + parity tests, exported from the relational barrel.
- Fixed `__catalog__` record codec (Zig `persist.zig`
  `encode/decodeHeader/decodeColumn` + `catalogKey/isCatalogKey` plus TS
  mirror `catalog_record.ts` with the same LE layout, round-trip and tamper
  tests) plus the reboot path above.
- Logical multi-root secondaries: `multiroot.zig` registry (UNIQUE flags,
  cardinality, order-preserving NUL-free hex pads) + TS `padU32Hex/
  padI64Hex16`, `lookupNumericRange` (no caller zero-pad) and `cardinality()`
  on `NativeSecondaryIndex`. Physical per-root arenas remain future.
- Record integrity: sealed TREC envelope (`record_crc.zig`) +
  allocation-free extent scrubber (`scrub.zig`) + C-ABI/N-API
  `verify_record`/`scrub_records` + TS mirror `scrub.ts` (fallback tested).
  Daemon write-path migration and periodic scrub wiring are future.
- ART node freelist: size-segregated quarantine (`freelist.zig`) fed by all
  10 grow/shrink orphan points in `art.zig`, stats observable, opt-in reuse
  behind the quiescence contract (default off; epoch reclamation future).
- C-ABI hardening: deterministic 3000-case xorshift sweep (`fuzz_surface.zig`)
  over gated entrypoints + pure kernels, SHM name resolution with validation
  (`resolveShmName`, OS namespacing, share-match reject), teardown injection
  seam (`unmapSegment`/`closeHandle` + counters) with failure tests.
- CI: seeded `bench:relational` runs as a gate after the dist build.
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
- Durable secondary indexes (`NativeSecondaryIndex` over engine ART
  with exact + range lookup, optional UNIQUE).
- Durable catalog DDL (`saveCatalog/loadCatalogDefs/restoreCatalog`:
  versioned JSON with atomic write + revalidation on restore).
- Full SQL-subset CRUD: `CREATE TABLE`, `INSERT`, `UPDATE`/`DELETE`
  (WHERE required), `ORDER BY`, `COUNT(*)`, `JOIN` via `executeSql`
  (every documented line executes literally).
- NPM release readiness: `takyondb` name free on the registry, `prepack`
  stages LICENSE into the tarball (was silently dropped), SDK README
  documents runtime requirements (addon + daemon vs pure-TS modules).
- Admin `SCAN`/`RANGE` over TCP: the daemon serves its lock-free ART
  view remotely (`OK <n> <offsets>`), covered by E2E vs live daemon.
- Self-driving crash E2E (`e2e_crash_auto_test.js`, in the harness):
  5000 snapshot keys + residual WAL verified across a real SIGKILL.
- Corruption E2E in CI (`relational.yml` runs the torn-write suite
  via ts-node from `scripts/`, matching the harness invocation).
- Sealed relational row headers (`row.zig`: 12B magic+version+CRC32
  with tamper/truncation tests) and a deterministic 1500-key ART sweep
  (insert/search/remove/scan cross-check, fixed seed).
- Pooled SDK hot paths (shared DataView/codecs/scratch, lazy views):
  measured insert -32%, find+update p50/p99 -54%/-55%.
- CI: `.gitattributes` forces LF (Windows `zig fmt` was red since day
  one); `macos-15` pinned for Zig 0.14.1 linker compat, no fail-fast.
- CI: `windows-2022` pinned (0.14.1 std does not compile on the
  windows-2025 VS2026 SDK); Windows `node.lib` fetched from nodejs.org
  (untracked by design, required to link the addon).
- CI: stale-SHM cleanup between E2E and chaos (size-mismatch wedge).
- SHM attach fixes: POSIX open-first without `O_EXCL` (macOS poisoned
  the `O_EXCL`-fail → immediate-reopen sequence with EACCES; also
  self-heals crashed creates); Windows size check via `VirtualQuery`
  (`GetFileSizeEx` is meaningless for pagefile-backed sections).
- SHM tests: hold creator mapped on Windows (names die with the last
  handle there); POSIX dir-fsync block is comptime-gated for Windows.
- WAL test: size math counts sector CRC overhead and the idle flush.
- SHM attach fixes: POSIX open-first without `O_EXCL` (macOS poisoned
  the `O_EXCL`-fail → immediate-reopen sequence with EACCES; also
  self-heals crashed creates); Windows size check via `VirtualQuery`
  (`GetFileSizeEx` is meaningless for pagefile-backed sections).
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

</details>
