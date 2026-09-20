# TakyonDB Architecture

This directory holds technical deep-dives. Start here for the big picture.

## SharedArena map (canonical)

Defined in `src/core/memory/layout.zig`, mirrored by
`src/sdk/client/layout.ts`. Do not hardcode offsets elsewhere.

| Region | Offset | Notes |
| --- | --- | --- |
| Global header (reserved) | `0 .. 1024` | Magic/version (future) |
| RingBuffer | `1024 ..` | Header (192B) + `RING_DEFAULT_CAPACITY` x 64B slots |
| Record bump (u32) | `2048` | Single shared bump word, init `4096` |
| Record arena | `4096 .. 2097152` | Fixed-length rows, bump-allocated |
| ART root / bump / start | `2097152 / +4 / +8` | Lock-free radix index (Node256 only for now) |
| String arena | `10MB ..` | Bump word at `10MB`, data from `10MB+4` |

Minimum supported arena: `64MB` (`MIN_ARENA_SIZE`).

## IPC

Node.js pushes `DeltaMessage` (64B) structs into the lock-free RingBuffer;
the Zig flusher drains them into the arena + WAL. Capacity defaults to 4096
slots (256KB). Callers must retry on full.

## Durability

* WAL: 4092B payload + 4B CRC32 per 4K sector, Direct I/O where supported.
* Snapshot: full arena copy + footer (`crc + active_len`).
* Recovery: snapshot first, then WAL replay with CRC truncation.

Current gaps (see CHANGELOG): no `fsync` yet, snapshot CRC not verified on
load, no quiesce around checkpoints.

## Index

Adaptive Radix Tree with tagged 32-bit pointers. Only `Node256` + `Leaf`
insert/search paths are implemented; overwrites are ignored and
`Node4/16/48` return `UnsupportedNodeType`. Each key byte costs one Node256
until path compression lands.
