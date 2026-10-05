<div align="center">
  <img src="assets/logo.png" alt="TakyonDB Logo" width="200" />
  <h1>TakyonDB</h1>
  <p><strong>One engine, one arena, one process: the data layer a server runs on.</strong></p>
</div>

---

## The mission

A server that stores data usually runs more than one process to do it: a
database for rows, a cache for hot values, and glue in between that
carries bytes from one to the other. Each of those costs a process, a
port, a connection pool, and memory that stays resident while nothing is
happening.

Takyon is an attempt to collapse that into one engine over one mapped
arena. The mission, what it would replace, and what it cannot do yet are
written down in [docs/mission.md](docs/mission.md). The design behind it
is in [docs/infrastructure.md](docs/infrastructure.md).

## What exists today

Experimental and pre-alpha. A Zig storage daemon, a C++ N-API bridge, and
a TypeScript SDK over one shared arena.

* **Key-value collections** with a compiled schema, addressed through an
  adaptive radix tree in shared memory.
* **A relational layer** — tables, filters, joins, aggregations,
  transactions and a `SELECT` subset. Its rows currently live in a
  JavaScript `Map`, not in the arena. See
  [docs/relational/](docs/relational/).
* **Durability** — a checksummed write-ahead log with a logical record for
  index writes, verified snapshots that carry only the extents in use,
  and recovery from both.
* **An idle daemon that sleeps.** `scripts/e2e_idle_cpu_test.js` fails
  the build if it stops.

What it does not do yet is listed, with the file that documents each gap,
in [docs/mission.md](docs/mission.md#what-we-do-not-claim-yet). There is
no cache tier, no eviction, no explicit durability call, and region sizes
are still compile-time constants.

---

## Quickstart

```
$ ./zig-out/bin/takyondb
[TakyonDB-Daemon] Starting TakyonDB Standalone Server...
[TakyonDB-Daemon] Admin endpoint listening on 127.0.0.1:7723

$ printf 'PING\n' | nc 127.0.0.1 7723
PONG
```

The admin endpoint answers one command per connection, then closes. The
full command set is in [docs/operations.md](docs/operations.md).

### 1. Build the daemon

Needs Zig 0.14.1, the version CI pins.

```bash
zig build -Doptimize=ReleaseSafe
./zig-out/bin/takyondb            # 64 MiB arena, default data dir
./zig-out/bin/takyondb --help     # flags, admin protocol, signals
```

Or install a packaged build:

```bash
# Debian/Ubuntu
sudo apt install ./TakyonDB_0.1.0_amd64.deb
# macOS
sudo installer -pkg TakyonDB-0.1.0.pkg -target /
# Windows: run TakyonDB-Setup-v0.1.0.exe
```

### 2. Install the SDK

```bash
npm install takyondb
```

The package ships a prebuilt N-API addon for your platform, so no
toolchain is needed. On a platform with no prebuild yet, the error says
so and lists the alternatives.

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

The arena size must match the daemon's. `new TakyonDB()` defaults to
64 MiB, so run the daemon with no arguments, or pass `--data-dir` for the
WAL and snapshots.

The daemon owns durability. A mapping without one is memory that
disappears with the last process, and a write returns once the change is
queued, not once it is on disk.

`pack_smoke.js` exercises this whole flow: it packs the tarball, installs
it outside this repository, and runs the same code against a live daemon
on all three CI platforms.

---

## How it is put together

One shared arena holds a lock-free ring for mutations, a fixed-length
record region, the radix index, and a region for variable-length
strings. A client maps it and addresses the bytes; the daemon drains the
ring into the log and takes snapshots. The byte map is in
[docs/architecture/README.md](docs/architecture/README.md), and it is
defined once in `src/core/memory/layout.zig` and mirrored in
`src/sdk/client/layout.ts`.

The arena is mapped rather than copied between processes, so data
written through one mapping is resident once and shared by every other
mapper. That is the narrow claim that survives measurement, and it is
about the mapping, not about the read path. What the read path costs,
including the per-record allocations in the SDK around it, is in
[docs/performance-truth.md](docs/performance-truth.md).

## Relational

```typescript
import { RelationalDatabase, QueryBuilder } from 'takyondb';

const db = new RelationalDatabase();
const users = db.createTable('users', [
  { name: 'id', type: 'string', primaryKey: true },
  { name: 'age', type: 'uint32' },
]);
users.insert({ id: 'u1', age: 28 });
new QueryBuilder(users).where({ age: { gte: 18 } }).all();
```

Tables use namespaced index keys, zero-copy scans, hash joins,
single-pass aggregations, batch transactions and a minimal `SELECT`
parser. The Zig core mirrors the types, catalog, row, filter, aggregate,
scan, query, join and transaction layers with tests.

## Benchmarks

Every published number has a harness, a workload and a hardware record.
Reproduce them yourself:

| Harness | What it measures |
|---|---|
| `node scripts/benchmark_chaos.js` | Saturated multi-worker run against a live daemon |
| `node scripts/bench_scan.js [n]` | Native prefix and range scans vs point lookups |
| `node scripts/bench_relational.js` | Seeded relational workload over the TypeScript engine |
| `node --expose-gc scripts/bench_proxy.js [n]` | TypeScript SDK overhead only, mocked bridge |
| `node scripts/bench_pooling.js [n]` | The pooling optimization in isolation |

Absolute numbers are machine specific and are not a target. What each
one includes, and what it does not, is in
[docs/performance-truth.md](docs/performance-truth.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/) with a DCO
sign-off (`git commit -s`).

Verify before handing work over:

```bash
bash scripts/verify.sh --fast    # everything except the E2E suites
bash scripts/verify.sh           # the same gates CI runs
```

## License

TakyonDB is licensed under the [MIT License](LICENSE).

<div align="center">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Windows, Linux, macOS" />
  <img src="https://img.shields.io/badge/Zig-0.14.1-orange.svg" alt="Zig 0.14.1" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-blue.svg" alt="TypeScript ready" />
</div>
