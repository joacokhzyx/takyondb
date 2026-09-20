# TakyonDB Architecture

This directory holds technical deep-dives. Start here for the big picture.

## SharedArena map (canonical)

Defined in `src/core/memory/layout.zig`, mirrored by
`src/sdk/client/layout.ts`. Do not hardcode offsets elsewhere.

| Region | Offset | Notes |
| --- | --- | --- |
| Global header (reserved) | `0 .. 1024` | Magic/version (future; see `ARENA_MAGIC`) |
| RingBuffer | `1024 ..` | Header (192B = 3 cache lines) + `RING_DEFAULT_CAPACITY` (4096) x 64B slots = 256KB |
| Record bump (u32) | `2048` | Single shared bump word, init `4096` (`RECORD_BUMP_INIT`) |
| Record arena | `4096 .. 2097152` | Fixed-length rows, bump-allocated; capped by `ART_ROOT_OFFSET` (2MB) |
| ART root / bump / start | `2097152 / +4 / +8` | Lock-free radix index (`ART_ROOT_OFFSET` / `ART_BUMP_OFFSET` / `ART_START`) |
| String arena | `10MB ..` | Bump word at `10MB` (`STRING_BUMP_OFFSET`), data from `10MB+4` (`STRING_DATA_START`) |

Minimum supported arena: `64MB` (`MIN_ARENA_SIZE`).

## IPC

Node.js pushes `DeltaMessage` (64B) structs into the lock-free RingBuffer;
the Zig flusher drains them into the arena + WAL. Capacity defaults to 4096
slots (256KB). Callers must retry on full.

## Durability (current, Loop 2 shipped)

* WAL (`src/core/storage/wal.zig`): deltas accumulate in a 4K sector
  buffer — 4092B payload + 4B little-endian CRC32. Each full sector is
  written then `fsync`ed (`syncFile`; `FlushFileBuffers` on Windows), so
  a WAL that is not synced is never trusted. Opens with `O_DIRECT` on
  Linux and automatically falls back to buffered I/O (`downgradeDirect`
  on `EINVAL`, e.g. tmpfs) with a retry. The flusher drops corrupt
  deltas (`CorruptDelta`: oversized or out-of-bounds offset/size) instead
  of panicking, and drains the whole ring before a checkpoint so the
  snapshot covers all acknowledged writes. `size == 0` payloads are
  rejected because `header.length == 0` is the end-of-log sentinel.
* Snapshot (`src/core/storage/snapshot.zig`): covers records + ART +
  string banks (`snapshotLen` = live `active_len`, not the whole 64MB).
  Written with `O_DIRECT` where supported (buffered retry), followed by
  an 8-byte footer block — `crc32[0..4] + active_len[4..8]` + zero pad —
  then `fsync` of the file **and** an `fsync` of the containing directory
  **before** the WAL is rotated/truncated.
* Recovery (`src/core/storage/recovery.zig`): snapshot first (two-pass —
  footer CRC is actually verified; missing/bad footer or CRC mismatch
  means the snapshot is ignored), then WAL replay with per-sector CRC
  truncation at the first corrupt sector.

## Index (current, Loop 2 shipped)

Adaptive Radix Tree with tagged 32-bit pointers (`src/core/index/art.zig`):
full `Node4 → 16 → 48 → 256` growth with CAS-claimed slots,
overwrite-in-place, `remove()` with empty-node unlinking, prefix keys via
a reserved terminator byte (keys must be NUL-free), bounded bump
allocation (`OutOfMemory` instead of OOB), and unit tests including a
2000-key bulk round-trip.

## Vacuum (current, Loop 2 shipped)

String-arena GC (`src/core/memory/vacuum.zig`): stoppable background
thread (`spawnVacuum` / `stopVacuum`, 100 ms backoff, `AlreadyRunning`
guard) that traverses **all** node types with corruption guards
(out-of-range offsets skipped, visit budget stops corrupt cycles),
collects live `(offset, len)` string pairs, compacts them via an
exact-size temp buffer into whichever half of the split string region
(two banks of `(arena_len - STRING_DATA_START) / 2`) the bump pointer is
**not** using, CAS-swizzles 8-byte-aligned fat pointers (check-then-write
for unaligned), then publishes by copying temp → destination bank and
swinging the bump. Requires external quiescence for overlapping
`remove()`/`insert()` — the daemon never deletes.

## SHM lifecycle (current, Loop 2 shipped)

`SharedArena` (`src/core/memory/shm.zig`) owns an OS handle (fd on
POSIX, file-mapping handle on Windows). `takyon_connect_shm` registers
each mapping in a base-address → arena registry;
`takyon_disconnect_shm` unmaps + closes (safe no-op on null/unknown).
The N-API `ArrayBuffer` finalizer calls it on GC, ending the old
per-connect fd/handle leak. Clients unmap + close without unlinking —
the daemon owns the segment name (`Local\TakyonDB_Master` on Windows,
`/TakyonDB_Master` on POSIX).

## STILL missing (see ROADMAP "correctness hardening")

* ART shrink-on-delete (`256 → 48 → 16 → 4`) + node freelist —
  unlinked nodes are abandoned bump memory until compaction lands.
* MPMC ring with per-slot sequence numbers (Vyukov), replacing
  claim-then-publish.
* Fuzzing of the C-ABI surface (arbitrary offsets/sizes/keys) in CI.
* `shm_unlink` ownership + multi-tenant segments (bridge name arg is
  currently fixed inside the engine).
* `munmap`/`CloseHandle` failure-injection tests.
