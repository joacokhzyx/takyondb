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

Instead of serializing and deserializing JSON over TCP sockets (like Redis or Memcached), TakyonDB allows your TypeScript code to manipulate C-structs directly in V8 memory via `SharedArrayBuffer` and hardware-level atomic operations.

### Key Features
- **Zero-Copy Reads/Writes**: No JSON parsing, no TCP overhead, no context switching.
- **Lock-Free Adaptive Radix Tree (ART)**: Deeply optimized indexing structure allowing multiple Node.js workers to query the database concurrently without blocking.
- **O(1) Isomorphic Startup**: Instant crash recovery. The state is snapshotted and memory-mapped directly from the SSD, restoring gigabytes of data in milliseconds.
- **Cryptographic Write-Ahead Log (WAL)**: All disk blocks are protected by CRC32 signatures to prevent torn writes and ensure data integrity.
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

### 1. Start the Daemon (Zig)
The storage engine runs as an independent daemon.
```bash
zig build run -Doptimize=ReleaseSafe
```

### 2. Install & Connect via TypeScript (Node.js)

```bash
npm install takyondb
```

```typescript
import { TakyonDB, TakyonSchema } from 'takyondb';

const UserSchema = new TakyonSchema({
    username: 'string',
    age: 'uint32',
    balance: 'float64',
});

// `bindings` is the compiled N-API addon (zig-out/bin/takyondb_bridge.node).
// See scripts/e2e_*.ts for wiring examples.
declare const bindings: import('takyondb').TakyonBindings;

const takyon = new TakyonDB(bindings, 64 * 1024 * 1024);
const users = takyon.collection('users', UserSchema);

// Write (zero-copy push to RingBuffer)
users.insert('user_123', {
    username: 'Alice',
    age: 28,
    balance: 1500.50
});

// Read (direct memory read via TypedArrays)
const alice = users.find('user_123');
console.log(alice?.username); // "Alice"
console.log(alice?.age);      // 28
```

> Status: pre-alpha. The memory map is defined in
> `src/core/memory/layout.zig` / `src/sdk/client/layout.ts`. The addon
> exposes an external `ArrayBuffer` (not yet a real `SharedArrayBuffer`);
> each `worker_thread` re-maps the segment. See `docs/architecture/`.

---

## 🧪 Benchmarks

In our `Chaos Engine` stress test using 4 concurrent V8 `worker_threads` (100% saturation, 200,000 operations):

| Metric | Latency |
|--------|---------|
| **p50** | `0.007 ms` |
| **p95** | `0.011 ms` |
| **p99** | `0.018 ms` |

*Note: Benchmarks ran on consumer hardware (NVMe SSD). Wait times are effectively bounded by CPU L3 cache speeds rather than OS networking stacks.*

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for our code of conduct and development guidelines.
Ensure all commits follow the **Conventional Commits** specification and sign off with `git commit -s` (DCO).

## 📄 License

TakyonDB is licensed under the [MIT License](LICENSE).
