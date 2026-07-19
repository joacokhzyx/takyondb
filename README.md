<div align="center">
  <img src="assets/logo.png" alt="TakyonDB Logo" width="200" />
  <h1>TakyonDB</h1>
  <p><strong>Insanely fast, zero-copy, lock-free in-memory database bridging Zig and Node.js</strong></p>
  
  [![License: AGPLv3 / Commercial](https://img.shields.io/badge/License-AGPLv3%20%2F%20Commercial-blue.svg)](#-license--pricing)
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

TakyonDB maps a single chunk of memory (`SharedArena`) containing:
1. **IPC RingBuffer (`0 - 128 KB`)**: Lock-free queue where Node.js pushes mutations.
2. **Record Arena (`1 MB - 2 MB`)**: Packed fixed-length columns (like tabular data).
3. **ART Index (`2 MB - 10 MB`)**: Tagged pointers and SIMD-optimized nodes for lightning-fast queries.
4. **Strings Arena (`10 MB - 64 MB`)**: A bump-allocator for variable-length UTF-8 strings.
5. **Inactive Bank**: Reserved double-buffering space for the asynchronous Vacuum thread.

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
import { TakyonClient } from 'takyondb';

const schema = {
    name: 'users',
    fields: {
        username: { type: 'string', size: 32 },
        age: { type: 'u32', size: 4 },
        balance: { type: 'f64', size: 8 }
    }
};

const takyon = new TakyonClient('takyondb_shared_memory', 64 * 1024 * 1024);
const users = takyon.collection('users', schema);

// Write (Zero-Copy push to RingBuffer)
users.insert('user_123', {
    username: 'Alice',
    age: 28,
    balance: 1500.50
});

// Read (Direct memory read via TypedArrays, ~50 CPU cycles)
const alice = users.get('user_123');
console.log(alice.username); // "Alice"
console.log(alice.age);      // 28
```

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
Ensure all commits follow the **Conventional Commits** specification. Note that all contributors must sign a Contributor License Agreement (CLA) to retain our dual-licensing model.

## 📄 License & Pricing

TakyonDB uses a **Dual-Licensing Model**:

1. **Open Source (Free)**: Licensed under the [GNU AGPLv3](LICENSE). 
   Ideal for independent developers, students, and open-source projects. *Note: If you modify and run TakyonDB as part of a SaaS or cloud service, the AGPLv3 requires you to open-source your entire application stack.*
   
2. **Commercial License ($10 / month)**: 
   For companies and closed-source projects that do not wish to open-source their proprietary code. By paying the monthly license fee, you receive an explicit legal exception to the AGPLv3, allowing you to use TakyonDB in a commercial/private setting without the copyleft obligations.
