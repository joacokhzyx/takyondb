# Repository structure

Where the code lives and what each directory is responsible for. Generated
counts for the tree are in [metrics.md](metrics.md); how to reproduce them
is in [verify.md](verify.md).

```
src/core/            the engine, in Zig
  memory/            the arena map, the shared segment, records, vacuum
  index/             the radix tree and the node freelist
  ipc/               the lock-free ring
  storage/           the write-ahead log, snapshots, recovery
  relational/        the relational core: types, catalog, row, filter,
                     aggregates, scan, query, join, transaction
  c_abi/             the exported C boundary and its fuzz harness
src/server/main.zig  the daemon: recovery, the log flusher, the admin endpoint
src/sdk/             the TypeScript SDK
  takyon.ts          key-value collections over the mapped arena
  client/            the bridge loader, the layout mirror, the record proxy
  client/relational/ the relational engine in TypeScript
  bindings/          the N-API bridge, written in C++
  ts/                the npm package: package.json, tsconfig, dist build
docs/                reference, mission and design pages, indexed in index.md
scripts/             checks, E2E suites and benchmark harnesses
examples/            runnable examples, including the relational ones
benchmarks/          benchmark workloads
packaging/           per-platform installers built in CI
```

## Rules that cut across directories

* The arena map is defined once, in `src/core/memory/layout.zig`, and
  mirrored in `src/sdk/client/layout.ts`. The Zig file pins the values with
  `comptime` assertions; if the two disagree, one of them is wrong and a
  test says so.
* `src/core/c_abi/exports.zig` is the trust boundary. Every export
  validates its arguments and returns a failure rather than trusting the
  caller.
* Zig and TypeScript are two languages and cannot share a file, so
  `scripts/check_version.js` and the layout mirror are what make "one
  source of truth" true rather than aspirational.
* `.agents/` is a local knowledge base. It is gitignored, never published,
  and never gates CI.
