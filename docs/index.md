# Documentation index

Everything under `docs/`, grouped by the question you arrived with rather
than by subsystem. `node scripts/docs_check.js` verifies every link and
anchor on this page, and CI runs it.

## Should I use this

| Page | What it answers |
|---|---|
| [../README.md](../README.md) | What Takyon is, a quickstart you can run, and when not to use it |
| [mission.md](mission.md) | Why the project exists, what it replaces, and what it does not claim yet |

## Run it

| Page | What it answers |
|---|---|
| [operations.md](operations.md) | Daemon flags, the admin protocol, signals, energy counters, packaging |
| [sdk.md](sdk.md) | The TypeScript SDK: schemas, keys, lifecycle, how the addon is found |
| [versioning.md](versioning.md) | Version policy and compatibility |
| [relational/README.md](relational/README.md) | The relational model: quickstart, glossary, harnesses, test strategy |
| [relational/query-api.md](relational/query-api.md) | `QueryBuilder`, joins, transactions, the SQL entry points |
| [relational/indexes.md](relational/indexes.md) | Key namespaces, `ArtMirror`, native secondary indexes |

## Understand it

| Page | What it answers |
|---|---|
| [infrastructure.md](infrastructure.md) | The four layers, and the design behind each roadmap gate |
| [architecture/README.md](architecture/README.md) | The arena map, the ring, the index, the WAL, recovery, vacuum |
| [architecture/models.md](architecture/models.md) | How each model maps onto the arena, and which key namespace it owns |

## The relational model

| Page | What it answers |
|---|---|
| [relational/vision.md](relational/vision.md) | What the model is, what is true today, what is not |
| [relational/data-model.md](relational/data-model.md) | Types, schemas, rows, tables |
| [relational/query-api.md](relational/query-api.md) | `QueryBuilder`, predicates, projections, ordering, batch transactions |
| [relational/indexes.md](relational/indexes.md) | Primary and secondary indexes, ranges |
| [relational/sql-subset.md](relational/sql-subset.md) | The supported `SELECT` subset |
| [relational/operations.md](relational/operations.md) | Catalog, backup, migration |
| [relational/limits.md](relational/limits.md) | Sizes and shapes, and the gate that relaxes each one |
| [relational/performance.md](relational/performance.md) | What each relational path costs, and what the benchmark does not measure |

## Trust it

| Page | What it answers |
|---|---|
| [performance-truth.md](performance-truth.md) | Every published number: how to reproduce it and what it excludes |
| energy.md | How an energy claim is measured, and what hardware that needs |
| [next-steps.md](next-steps.md) | What is not done, and what you get today instead |
| [../ROADMAP.md](../ROADMAP.md) | The seven gates, and the experiment that closes each one |
| [metrics.md](metrics.md) | Generated project counts |

## Change it

| Page | What it answers |
|---|---|
| [verify.md](verify.md) | The checks, what each one catches, and what CI adds |
| [e2e.md](e2e.md) | What an E2E suite owes, and how to register one |
| [relational/troubleshooting.md](relational/troubleshooting.md) | Common failures, and the questions the docs do not answer |
| [STYLEGUIDE.md](STYLEGUIDE.md) | Naming, formatting, headers, tests |
| [release.md](release.md) | Cutting a release, and the repository's public metadata |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute, what is asked first, governance, support |
| [../SECURITY.md](../SECURITY.md) | Attack surface, supported versions, private reporting |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Code of conduct |

---

## The repository

Where the code lives and what each directory is responsible for. Generated
counts are in [metrics.md](metrics.md).

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
