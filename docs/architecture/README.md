# TakyonDB Architecture

This page is the byte-level reference: where things live in the shared
arena and what each component guarantees. It is deliberately not a status
report. Open limits are in [../next-steps.md](../next-steps.md), the work
that is planned is in [../../ROADMAP.md](../../ROADMAP.md), and what
changed is in [../../CHANGELOG.md](../../CHANGELOG.md).

## SharedArena map (canonical)

Defined in `src/core/memory/layout.zig` and mirrored by
`src/sdk/client/layout.ts`. Do not hardcode offsets elsewhere; the Zig file
pins the absolute values with `comptime` assertions.

| Region | Offset | Size | Notes |
| --- | --- | --- | --- |
| Global header | `0 .. 1024` | 1 KiB | Arena magic and layout version. Otherwise reserved |
| Ring header | `1024` | 192 B | Three cache lines: head, tail and capacity, each aligned to 64 |
| Ring slots | `1216 ..` | `capacity * 64 B` | One `DeltaMessage` per slot |
| Ring sequence numbers | after the slots | `capacity * 8 B` | Per-slot sequence, the Vyukov protocol's ordering word |
| Record bump word | `296128` | 4 B | `RECORD_BUMP_OFFSET`; initialized to `RECORD_START` |
| Record arena | `296136 .. 2097152` | — | Fixed-length rows, bump-allocated, capped where the index begins |
| ART root / bump / nodes | `2097152 / +4 / +8` | — | `ART_ROOT_OFFSET`, `ART_BUMP_OFFSET`, `ART_START`; region ends at 10 MiB |
| String bump word | `10485760` | 4 B | `STRING_BUMP_OFFSET` |
| String data | `10485764 ..` | — | Variable-length UTF-8, bump-allocated |

`296128` is `1024` plus the ring footprint at the default capacity:
`192 + 4096*64 + 4096*8`.

`MIN_ARENA_SIZE` is 16 MiB. The daemon's default is 64 MiB, which is what
`--help` reports as the default and what the SDK defaults to. Every region
boundary above is a compile-time constant; that is the substrate
Gate in [../infrastructure.md](../infrastructure.md) replaces with header
values.

## IPC

A client maps the segment and pushes `DeltaMessage` (64 B) structs into the
ring. The tag decides what the daemon does with the message:

| Tag | Meaning |
| --- | --- |
| `DELTA_INLINE` | `data[0..size]` is the payload to write at `offset`, `size` in `1..=48` |
| `DELTA_ARENA` | `arena[offset .. offset+size]` is the payload |
| `DELTA_CHECKPOINT` | Drain the ring, then snapshot |
| `DELTA_INDEX_OP` | Bind the key at `offset` to the value in `data[0..4]` |

The ring holds `RING_DEFAULT_CAPACITY` slots and the daemon creates it at
that capacity; there is no flag for it. A push into a full ring fails
rather than waiting, and the SDK turns that into a throw after the bytes
have already been written into the arena by the client. Back-pressure is
Gate 2 of the roadmap.

Index operations travel logically rather than as bytes: the tree is a bump
allocator that also writes child slots into existing nodes, so replaying
arena deltas cannot rebuild it. The key and the value offset go in the log
and replay re-applies them, which is idempotent.

## Durability

* **WAL** (`src/core/storage/wal.zig`): deltas accumulate in a 4 KiB sector
  buffer, `4092 B` of payload plus a little-endian CRC32. Each sector is
  written and then synced (`fsync`, or `FlushFileBuffers` on Windows). A
  sector is either exactly full or padded by at least `MIN_PADDING`, and
  the reader depends on that. The file is opened with `O_DIRECT` where
  supported and downgraded to buffered I/O when the filesystem refuses it.
  A delta that fails validation is dropped with a message rather than
  panicking, and the ring is drained completely before a checkpoint so the
  snapshot covers every acknowledged write. The flusher sleeps on a
  bounded backoff when the ring is empty.
* **Snapshot** (`src/core/storage/snapshot.zig`): sparse, format v3. Three
  extents are packed into blocks — records, index, strings — each starting
  with its own bump word, so a restored allocator points into data that
  was actually written. The footer in the last block carries the magic, the
  format version, a CRC over the payload, the arena layout version, flags,
  one length per extent, and zero padding. The file is synced, and the
  containing directory is synced, before the log is rotated.
* **Recovery** (`src/core/storage/recovery.zig`): two passes, both
  required. The first finds the footer and counts blocks; the second
  scatters the payload while hashing it and checks the CRC before
  trusting any of it. Zero padding inside a sector ends that batch, not
  the log. A format this build does not speak is refused by version rather
  than reinterpreted: a version 2 snapshot is one contiguous prefix image,
  and reading its bump words as extent lengths would restore an arena at
  the wrong offsets. Extent lengths must be provably extents of this
  arena, and a footer taken on a different arena layout is refused.

## Index

An adaptive radix tree with tagged 32-bit pointers
(`src/core/index/art.zig`): `Node4 → 16 → 48 → 256` growth with
CAS-claimed slots, overwrite in place, removal with empty-node unlinking,
prefix keys through a reserved terminator byte, and bounded bump
allocation that returns an error instead of writing out of bounds.

Two properties are load-bearing and are stated where they are enforced:
the ART is lock-free but its allocator never reclaims unless the freelist
is enabled, and `insert` concurrent with `remove` on overlapping keys is
not safe. The daemon never deletes.

## Vacuum

String-region compaction (`src/core/memory/vacuum.zig`): a stoppable
background thread that polls every 100 ms, walks all node types with
corruption guards, collects live string references, compacts them into
whichever half of the string region the bump pointer is not using, and
swizzles the fat pointers before publishing. It requires external
quiescence for overlapping removal and insertion.

Nothing in the daemon schedules it. It is reachable through the C ABI, so
a client can start it, and a database that deletes records does not get
string compaction unless something asks for it.

## SHM lifecycle

`SharedArena` (`src/core/memory/shm.zig`) owns an OS handle: a file
descriptor on POSIX, a file-mapping handle on Windows. Connecting registers
each mapping so a disconnect cannot pull live memory out from under another
client. The name is `Local\TakyonDB_Master` on Windows and
`/TakyonDB_Master` on POSIX; the daemon owns it and unlinks it on a
graceful shutdown, which is skipped by design on a crash so the next start
can recover.

A client attaches with a single `shm_open` and one `mmap`, and there is no
per-query connection because there is no per-query protocol.
