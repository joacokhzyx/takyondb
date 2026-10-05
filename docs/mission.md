# The mission

Takyon is the data layer a server runs on. One process, one engine, one
mapped arena for storage, indexes, cache and queries, so a server spends
far less CPU, memory and energy than it does running a database and a
cache beside it.

That is the whole mission. Every feature below has to earn its place
against it, and every claim on this page is either a mechanism you can
read in the code or a measurement you can reproduce from
[performance-truth.md](performance-truth.md).

## Naming

| Name | What it is |
|---|---|
| **Takyon** | The product: the data layer a server runs on |
| **TakyonDB** | The engine inside it: arena, radix index, write-ahead log, snapshots |

The repository, the npm package and the daemon binary keep the
`takyondb` name. Nothing in this change renames an artifact, an
on-disk format or a segment name.

## Why the mission is one sentence

A server that needs storage rarely needs exactly one thing. It needs a
place for rows, a place for documents, a place to put a hot value that
would otherwise be recomputed, and a place to query the first two.
Today that is three processes: a database, a cache, and whatever glue
carries bytes between them. Each one costs a process, a port, a
connection pool, a serialization format, and RAM that is resident even
when it is idle.

The cost of the arrangement is not the query. It is the fixed cost of
everything that has to be alive to answer one. `docs/next-steps.md`
records where that cost is still being paid inside this project; the
mission is to stop paying it, and to publish the measurement each time
we do.

## What we are trying to replace, and on which axes

Not "databases". Specific tools, each paid for on a specific axis.

| Today a server runs | What it costs | Axis we would win on | Measured today? |
|---|---|---|---|
| A cache daemon beside the app | A second process, its own resident memory, bytes written to satisfy a durability mode most caches never need | resident memory per server, idle CPU, bytes written per cache write | No. There is no cache tier yet; it is designed in [infrastructure.md](infrastructure.md). |
| An embedded SQL database inside the app process | CPU per query, page writes per transaction | CPU per query, bytes written per mutation | Partly. See the harnesses table in [performance-truth.md](performance-truth.md). |
| A separate database server | A process, a port, a network hop per query, a pool | CPU per query, RAM per instance | Not measured on the same host and workload. |

The third row is the honest one: TakyonDB has been compared against an
embedded SQLite on the same host, and against nothing else. No
four-way comparison exists, and the roadmap does not schedule one until
there is a cache tier to compare and a durability setting that does not
drop writes. A comparison that puts the two systems on different
contracts is not a comparison.

## Why "SQL or NoSQL" is the wrong question

Choosing relational or not, SQL or not, is a choice about *one shape of
data*. A server holds more than one shape, and paying a separate
process per shape is what the mission removes.

Takyon's answer is one engine with four layers on top of it:

| Layer | What it is | Status |
|---|---|---|
| Engine | Arena, radix index, WAL, snapshots | Shipped. `docs/architecture/README.md` |
| Substrate | Region layout, capacities and policies decided at startup instead of at compile time | Designed, not built. See [infrastructure.md](infrastructure.md) |
| Models | Key-value, document, relational, cache — views over the same arena, selected per namespace | Key-value and a TypeScript relational engine ship; document and cache are designed |
| Cache | TTL, eviction and a volatile write policy inside the same process | Designed, not built |

Each model is a view, not a second engine. The arena, the index and the
log are shared, so a cache entry and a table row cost the same bytes in
the same mapped pages, and neither one needs its own process.

## Who it is for

Someone who runs a server and is currently paying for three processes to
store a few gigabytes. They want one binary and one process, they care
what it draws when nothing is happening, and they would rather read a
table of limits than a page of adjectives.

## What Takyon is not

* It is not a multi-tenant hosted service, and it will not grow to be
  one. One segment is one database for one operator.
* It is not a cluster. Replication and failover are not on the roadmap
  until the single-node engine is honest about its own durability and
  its own cost.
* It is not a drop-in Redis replacement. There is no wire protocol and
  no server to point an existing client at. A cache tier that can remove
  Redis from a server's architecture is one thing; speaking RESP to
  unmodified clients is a different product with a different cost, and
  this is not it.
* It is not a PostgreSQL replacement. There is no wire protocol, no
  planner, no multi-version concurrency control, and no expectation of
  matching an OLTP engine's throughput.

## What we do not claim yet

This section is the reason the rest of the page can be trusted. Each
entry is a limit that a reader can verify today, with the page that
documents it.

* **No explicit durability contract.** A write returns once the change
  is in the ring, not once it is on disk, and there is no `commit()` to
  ask for the second one. See [next-steps.md](next-steps.md) and
  [operations.md](operations.md).
* **No eviction, no TTL, no memory ceiling policy.** A delete removes
  the index entry and reclaims nothing: both allocators only grow.
* **The relational engine is not in the arena.** Its rows are a
  JavaScript `Map`. Tables, joins and aggregations work and are tested,
  but their rows are lost with the process, and the native pushdown
  kernels are not reached from the query path. See
  [relational/performance.md](relational/performance.md).
* **Region sizes are compile-time constants.** The record region ends
  where the index root begins (`src/core/memory/layout.zig`), so a
  larger arena does not buy more records. The error message names a
  constant the user cannot change.
* **Scans are capped and cannot be resumed.** A native prefix or range
  scan returns a bounded number of offsets and takes no cursor, so a
  table larger than the cap cannot be read through the native path.
* **One language.** There is a TypeScript SDK. Other languages would
  have to bind the C ABI themselves.

Every one of these is a gate in [../ROADMAP.md](../ROADMAP.md), not a
maybe.

## How we will prove it

The claim "a server consumes much less" is a claim about energy and
time, so it is measured like one. The rules are already
[performance-truth.md](performance-truth.md)'s; they extend to joules
as follows.

* Every comparison publishes the hardware, the kernel, the toolchain,
  the optimization mode, the workload, the client location and the
  number of repetitions, or it is not published.
* Both sides of a comparison run the same workload and the same
  durability setting. Asynchronous acknowledgment against a synchronous
  commit compares two contracts and the number is meaningless.
* Without a power sensor, the report says so and publishes CPU time,
  resident memory and throughput as proxies. CPU seconds are never
  converted to joules with a universal factor, because processor power
  depends on hardware, frequency and system state.
* Idle cost is measured with no client attached, because for a database
  that is mostly waiting, idle cost is the number that dominates.
* The runs where the result is bad are published with the good ones.

## The gates

The roadmap is seven gates, each with an exit criterion that can be
executed rather than argued about: truth, substrate, durability and
back-pressure, cache, relational in the arena, energy measurement, and
language surfaces. [../ROADMAP.md](../ROADMAP.md) states each one and
names the experiment that closes it.

## Relationship to Orbit

[Orbit](https://github.com/joacokhzyx/orbit-lang) is a language for
APIs and microservices built on the same bet: software can be small,
fast and honest at the same time. Takyon applies it to data instead of
to code. The shared rule is the last one on this page — publish what
works, publish what does not, and publish how it was measured.
