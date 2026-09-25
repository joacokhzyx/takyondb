# TakyonDB SDK Reference

TypeScript SDK entry point: `src/sdk/index.ts` (re-exports `client/schema`,
`client/layout`, `client/proxy`, `takyon`, `client/relational`). Canonical offsets live in
`src/sdk/client/layout.ts`, mirroring `src/core/memory/layout.zig` — never
hardcode them. Native calls go through the N-API addon
(`zig-out/bin/takyondb_bridge.node`, built via `zig build`).

## TakyonSchema

`new TakyonSchema({ field: type, ... })` — field types are `uint8` (1B),
`uint32` (4B, little-endian), `float64` (8B), `string` (8B fat pointer:
u32 offset + u32 len). Offsets are packed sequentially; `schema.totalSize`
is the record byte size. Throws on empty definitions and unknown types.

## TakyonClient

`new TakyonClient(bindings, size)` — maps shared memory via
`bindings.initSharedMemory(size)`; throws if the size is not a positive
integer or the mapping returns null. Exposes `getBuffer()`,
`getBindings()`, and:

* `triggerCheckpoint(): boolean` — `true` iff `trigger_checkpoint() === 0`.
* `startVacuum(stringOffset): boolean` — `true` iff `start_vacuum() === 0`.
* `stopVacuum(): boolean` — `false` when `bindings.stop_vacuum` is absent;
  otherwise `true` iff it returns `0` (native `takyon_stop_vacuum` is void;
  the bridge always returns `0`).
* `createProxy(schema, baseOffset)` — bounds-checked `DataView` proxy.
  Scalar writes go straight into the buffer and `pushDelta` the bytes;
  string writes bump-allocate in the string arena, `notifyArena`, then
  `pushDelta` the 8-byte fat pointer. Throws on out-of-range offsets,
  oversized fields (`> MAX_DELTA_INLINE` = 48), string-arena OOM, corrupt
  string pointers, and failed `pushDelta`/`notifyArena` (ring full).

## TakyonDB / Collection

`new TakyonDB(bindings, memorySize = 64MB)` wraps a `TakyonClient`.
`db.collection(name, schema)` returns a `Collection`; `db.allocateRecordOffset(size)`
bump-allocates from the single shared word at `RECORD_BUMP_OFFSET`
(`Atomics`-guarded, init `RECORD_BUMP_INIT`) and throws past
`ART_ROOT_OFFSET`. Collection names namespace the ART keyspace:
`insert`/`find` map `key` to `` `${name}:${key}` ``, so `name` must be
non-empty and NUL-free, and identical keys in different collections
are isolated from each other.

* `collection.insert(key, data)` — validates the key, allocates a record,
  calls `insert_index` (throws on nonzero), then assigns fields through a
  proxy. Partial `data` is allowed; `undefined` values are skipped.
* `collection.find(key)` — returns a live proxy or `null` when
  `search_index` returns `< 0` (not found / invalid).

## TakyonBindings

```ts
interface TakyonBindings {
    initSharedMemory(size: number): ArrayBuffer | null;
    pushDelta(offset: number, data: Uint8Array): number;
    notifyArena(offset: number, size: number): number;
    verifyTestValue(): number;
    insert_index(key: string, value_offset: number): number;
    search_index(key: string): number;
    remove_index(key: string): number;
    scan_prefix?(prefix: string, max_results?: number): Uint32Array;
    scan_range?(prefix: string, lo?: string, hi?: string, max_results?: number): Uint32Array;
    trigger_checkpoint(): number;
    start_vacuum(string_offset: number): number;
    stop_vacuum?(): number;
}
```

## Error-code semantics

Native `0` = success; nonzero = failure (JS wrappers throw or return
`false`/`null` as above). `-1` per method (`src/core/c_abi/exports.zig`):

| Method | `-1` means |
| --- | --- |
| `insert_index` | arena not ready, `key_len` 0 or > 256, `value_offset` out of arena, or ART insert failed (e.g. OOM) |
| `search_index` | arena not ready, bad key length, **not found**, or hit offset aliasing `0x7FFFFFFF` (reserved) |
| `scan_prefix` | bridge throws `RangeError` for bad prefix/`max_results` (1..4096) and `Error` when the engine is not ready; returns `Uint32Array` (possibly empty) otherwise |
| `scan_range` | like `scan_prefix` over keys with suffix in [`lo`, `hi`] (empty = unbounded); inverted bounds return empty, never an error |
| `pushDelta` (`takyon_write_delta`) | ring/arena not ready, `size` 0 or > 48, `offset + size` out of arena, or ring full |
| `notifyArena` | ring/arena not ready, `size == 0`, `offset + size` out of arena, or ring full |
| `trigger_checkpoint` | ring not ready or ring full (checkpoint is a ring sentinel, `is_arena == 2`) |
| `start_vacuum` | arena not ready, bad `string_field_offset`, or vacuum already running / OOM |

Other codes: `initSharedMemory` returns `null` (not `-1`) on mapping failure
and throws `RangeError` for size 0 or > 1 GiB (`binding.cc`); `pushDelta`
throws `TypeError`/`RangeError` before native code for non-`Uint8Array` or
length outside 1..48; `verifyTestValue` returns `-2` for not-ready/empty and
`1` for wrong-size payloads; `stop_vacuum` is void natively (bridge returns
`0` unconditionally).

## Key constraints

Keys must be **1..256 UTF-8 bytes** (`MAX_KEY_LEN` / `TAKYON_MAX_KEY`) and
**NUL-free** — the ART uses a reserved terminator byte for prefix keys, and
`binding.cc` rejects embedded NULs with `RangeError` instead of truncating.
Caution: `Collection.insert` checks JS `key.length` (UTF-16 code units), so
a multibyte key can pass that check yet be rejected by the bridge's byte
count. Empty keys are rejected at both layers.

## Lifecycle and memory mapping

**Where the mapping comes from.** `initSharedMemory` returns an *external*
`ArrayBuffer` wrapping the mapped region, one `mmap` per V8 isolate. It is
**not** a `SharedArrayBuffer`: Node exposes no API to wrap a raw pointer in
one, so every `worker_thread` re-maps the same segment and gets its own
`ArrayBuffer` object over the same physical pages. Consequently `Atomics.wait`
and `Atomics.notify` are not available on this buffer (the spec requires a
shared one and throws otherwise). The bump pointers *are* manipulated with
`Atomics.compareExchange`/`Atomics.add`, but cross-worker correctness comes
from the shared pages, not from V8-level atomics. The IPC ring is a Vyukov
MPMC queue with per-slot sequence numbers driven by Zig-level atomics.

**Teardown is explicit, and the GC finalizer is deliberately a no-op.**
`ArrayBufferFinalizer` in `src/sdk/bindings/binding.cc` does nothing, on
purpose: the engine owns one process-wide mapping guarded by a refcount, and
V8 may collect any single worker's buffer (workers routinely discard theirs
right after connecting). Unmapping there once pulled live memory out from
under concurrent workers — use-after-unmap, silent `-1`s, and reused address
ranges aliasing as corrupt index nodes.

Use the refcounted teardown instead:

```ts
// Last disconnect tears the mapping down; earlier ones only drop a reference.
takyondb.disconnect_shm();            // or takyon.client.shutdownEngine()
```

`TakyonClient.shutdownEngine()` returns a boolean and delegates to the same
`disconnect_shm` entry point. A partial disconnect is safe while other clients
still hold the mapping; the last one unmaps.

**Finding the addon.** `loadBindings()` resolves the binary from, in order:
an explicit `addonPath`, `TAKYON_ADDON_PATH`, the bundled
`prebuilds/<platform>-<arch>/`, a `node-gyp` style `build/Release`, a flat
copy, then the in-repo `zig-out/bin` build. An explicit path that does not
exist fails immediately rather than falling through, so you never silently get
a different binary than you asked for. The addon is N-API, so there is one
binary per platform+arch and not per Node release.

Prebuilds are published for `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64` and `win32-x64` as far as CI produces them; on any other
platform `loadBindings()` says so explicitly and lists the supported set
instead of failing at `require` time.
