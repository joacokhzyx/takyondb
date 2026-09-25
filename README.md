<div align="center">
  <img src="assets/logo.png" alt="TakyonDB Logo" width="200" />
  <h1>TakyonDB</h1>
  <p><strong>Insanely fast, zero-copy, lock-free in-memory database bridging Zig and Node.js</strong></p>
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  [![Platform: Windows | Linux | macOS](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)]()
  [![Zig](https://img.shields.io/badge/Zig-0.12+-orange.svg)]()
  [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)]()
</div>

---

## ⚡ What is TakyonDB?

TakyonDB is an experimental, ultra-low latency memory-mapped database that obliterates standard Inter-Process Communication (IPC) bottlenecks. By leveraging a **Zero-Copy Architecture**, Node.js clients and the Zig-based storage daemon read and write to the exact same physical memory segments seamlessly. 

Instead of serializing and deserializing JSON over TCP sockets (like Redis or Memcached), TakyonDB lets your TypeScript code read and write the mapped arena directly through a `DataView`.

> **On `SharedArrayBuffer`.** The addon hands your process an external
> `ArrayBuffer` over the mapped region — one `mmap` per V8 isolate — not a
> `SharedArrayBuffer`. Node exposes no way to wrap a raw pointer in a SAB, so
> cross-worker access is mediated by the mapped pages themselves rather than by
> V8 atomics, and `Atomics.wait` is not available on this buffer. Writes are
> handed to the engine through a lock-free MPMC ring using Zig-level atomics.
> Older revisions of this README claimed `SharedArrayBuffer`; that was never
> true. See [docs/sdk.md](docs/sdk.md#lifecycle-and-memory-mapping).

### Key Features
- **Zero-Copy Reads/Writes**: No JSON parsing, no TCP overhead, no context switching.
- **Lock-Free Adaptive Radix Tree (ART)**: Deeply optimized indexing structure allowing multiple Node.js workers to query the database concurrently without blocking.
- **O(1) Isomorphic Startup**: Instant crash recovery. The state is snapshotted and memory-mapped directly from the SSD, restoring gigabytes of data in milliseconds.
- **Checksummed Write-Ahead Log (WAL)**: Every disk sector carries a CRC32 so torn writes are detected and truncated on recovery. This is corruption *detection*, not cryptographic integrity — CRC32 does not defend against deliberate tampering. See [SECURITY.md](SECURITY.md).
- **Native TypeScript SDK**: Fluent, strongly-typed API that hides the complex C-ABI memory math.

---

## 🏗 Architecture

TakyonDB maps a single chunk of memory (`SharedArena`, minimum 64MB) containing:
1. **IPC RingBuffer (`1024 + 256 KB`)**: Lock-free queue (192B header + 4096 x 64B slots by default) where Node.js pushes mutations.
2. **Record Arena (`4096 - 2 MB`)**: Bump-allocated fixed-length rows, growing from `RECORD_START` up to `ART_ROOT_OFFSET`.
3. **ART Index (`2 MB +`)**: Full `Node4 → 16 → 48 → 256` radix tree with tagged pointers rooted at `2 MB`.
4. **Strings Arena (`10 MB +`)**: A bump-allocator for variable-length UTF-8 strings (bump word at `10 MB`, data from `10 MB + 4`).
5. **Vacuum banks**: The string region is split in halves for double-buffered compaction by the background Vacuum thread.

<div align="center">
  <em>(See <code>docs/architecture/</code> for deeper technical dives)</em>
</div>

---

## 📦 Quickstart

The whole flow below is exercised by `scripts/pack_smoke.js`, which packs the
tarball, installs it into a directory outside this repository, and runs the same
code against a live daemon on all three CI platforms. If it works there, it
works from npm.

### 1. Start the daemon

The storage engine runs as an independent daemon. Either install a packaged
build:

```bash
# Debian/Ubuntu
sudo apt install ./TakyonDB_0.1.0_amd64.deb
# macOS
sudo installer -pkg TakyonDB-0.1.0.pkg -target /
# Windows: run TakyonDB-Setup-v0.1.0.exe
```

…or build it from source (needs Zig 0.14.1, the version CI pins):

```bash
zig build -Doptimize=ReleaseSafe
./zig-out/bin/takyondb            # 64 MiB arena, default data dir
./zig-out/bin/takyondb --help     # flags, admin protocol, signals
```

### 2. Install the SDK

```bash
npm install takyondb
```

The package ships a prebuilt N-API addon for your platform, so no toolchain is
needed. If you are on a platform with no prebuild yet, the error tells you
exactly that and lists the alternatives.

### 3. Connect

```typescript
import { TakyonDB, TakyonSchema } from 'takyondb';

const UserSchema = new TakyonSchema({
    username: 'string',
    age: 'uint32',
    balance: 'float64',
});

// The addon is located and loaded for you (prebuilds/<platform>-<arch>).
// Pass bindings explicitly to inject a mock or a custom build:
//   new TakyonDB(loadBindings({ addonPath: '/path/to/takyondb_bridge.node' }))
const takyon = new TakyonDB();
const users = takyon.collection('users', UserSchema);

users.insert('user_123', { username: 'Alice', age: 28, balance: 1500.5 });

const alice = users.find('user_123');
console.log(alice?.username); // "Alice"
console.log(alice?.age);      // 28
```

The arena size must match the daemon's. `new TakyonDB()` defaults to 64 MiB, so
run the daemon with no arguments (or `--data-dir` for the WAL and snapshots).

### 4. Talk to the daemon over the admin port

```bash
printf 'PING\nMETRICS\n' | nc 127.0.0.1 7723
# PONG
# METRICS ring_depth=0 wal_bytes=1130496 wal_segments=0 uptime_s=12 ...
```

> Status: pre-alpha. KV (`Collection`) plus relational
> (`RelationalDatabase` / `Table` / `QueryBuilder`, SQL subset) in
> `src/sdk/client/relational/` and `src/core/relational/`.
> See [docs/relational/](docs/relational/) and
> [docs/architecture/](docs/architecture/).

---

## 🧮 Relational (new)

```typescript
import { RelationalDatabase } from 'takyondb';
import { QueryBuilder } from 'takyondb';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);
users.insert({ id: 'u1', age: 28 });
new QueryBuilder(users).where({ age: { gte: 18 } }).all();
```

Tables use namespaced ART keys (`tbl:/idx:/__catalog__`), zero-copy scans,
hash joins, single-pass aggs, batch tx, and a minimal `SELECT` parser.
Zig core mirrors types/catalog/row/filter/agg/scan/query/join/tx with tests.

---

## 🧪 Benchmarks

Reproduce them yourself; every harness prints its hardware, workload and
methodology, and writes a JSON record to `$BENCH_JSON_PATH` when set.

| Harness | What it measures |
|---|---|
| `node scripts/benchmark_chaos.js` | Saturated multi-worker run: 4 `worker_threads`, 200 000 ops (20 % read / 40 % insert / 40 % update), vacuum running, a checkpoint every 500 ms, against a live daemon. |
| `node scripts/bench_scan.js [n]` | Native prefix and range scans vs point lookups, through the N-API addon against a live daemon. |
| `node scripts/bench_relational.js` | Seeded relational workload (insert/scan/filter/join/agg) over the TypeScript engine. |
| `node --expose-gc scripts/bench_proxy.js [n]` | TypeScript SDK overhead only, mocked bridge. Absolute cost of the shipped hot path. |
| `node scripts/bench_pooling.js [n]` | The pooling optimization in isolation: shared vs per-operation codec/scratch. |

A run of the chaos harness on a 2× AMD EPYC 7763 (Linux, Node 24) with
ReleaseSafe:

| Metric | Latency |
|--------|---------|
| **p50** | `0.002 ms` |
| **p95** | `0.004 ms` |
| **p99** | `0.011 ms` |

**Absolute numbers are machine specific and are not a target.** They are here
so you can check your own hardware, not to be compared across machines. The
one portable result is the isolated pooling delta in `bench_pooling.js`
(-22 % to -73 % depending on percentile, averaged over identical code paths).
Full methodology, including what each number does *not* include, is in
[docs/performance-truth.md](docs/performance-truth.md).

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for our code of conduct and development guidelines.
Ensure all commits follow the **Conventional Commits** specification and sign off with `git commit -s` (DCO).

## 📄 License

TakyonDB is licensed under the [MIT License](LICENSE).
