# TakyonDB roadmap

Seven gates between where the project is and the mission in
[docs/mission.md](docs/mission.md). Each one has an exit criterion that
can be run rather than argued about, and a design behind it in
[docs/infrastructure.md](docs/infrastructure.md).

Two other pages carry the load this one used to: open limits are in
[docs/next-steps.md](docs/next-steps.md), and what shipped is in
[CHANGELOG.md](CHANGELOG.md). A roadmap is a list of things that are not
true yet, so this page deliberately holds no counts and no dates that
nobody regenerates.

## Where the project stands

A Zig storage daemon, a C++ N-API bridge and a TypeScript SDK over one
shared arena. Key-value collections, a relational layer that currently
keeps its rows in a JavaScript `Map`, a checksummed write-ahead log,
verified snapshots, and an idle daemon that sleeps.

The mission is larger than the engine. Three of the seven gates below
exist because region sizes are compile-time constants, there is no
durability call, and there is no cache tier. Estimates are engineering
judgments, not commitments, and they exclude review time.

## Gate 0: truth

Not a phase. A standing gate: every published number has a harness, a
workload and a hardware record, and every claim in `README.md` either
names a mechanism in the code or a measurement.

Closed today by `docs/performance-truth.md`, `scripts/docs_check.js`,
the generated `docs/metrics.md` and the CI gates that keep them honest.

## Gate 1: a substrate that is configured, not compiled

**In the way:** every other gate. The record region ended where the index
root began no matter how large the arena was, the index was a fixed
region, and the error a caller saw on exhaustion named a constant they
could not change.

**Shipped.** Arena layout v3: region boundaries are header values read
and validated on attach; `takyon.json` configures them, and its absence
changes nothing; the snapshot footer carries the table so recovery can
refuse a snapshot whose regions are not the arena's; startup refuses an
impossible configuration with the relation that failed named. The engine,
the C ABI, the vacuum, the log flusher, snapshots, recovery and the
TypeScript SDK all read the table instead of a constant.

**Exit criterion:** a large arena holding far more records than the
default layout could, through the shipped SDK, with a checkpoint and a
crash-recovery round trip. `scripts/e2e_regions_test.js` runs it, sizes
itself to the host's shared memory, prints the plan it ran next to the
gate's numbers, and refuses to run on a host too small to prove the
property.

The gate asks for 2 GiB and 500,000 records. On a 64 MiB `/dev/shm` the
suite runs 150,000 records in a configured region that the default layout
would have capped at 56,281 -- the property, at the scale the machine
allows. Growing a segment with `mremap` or a new section is still future
work: regions are configurable, but the arena is still fixed at startup.

## Gate 2: an explicit durability contract

**In the way:** every claim about being a database, and the cache tier,
because a cache that cannot be told what to keep is a cache that writes
everything to disk.

**Deliverable:** a `commit()` an application can call; a push that waits
when the ring is full and raises a typed back-pressure error instead of
throwing from a proxy trap; saturation counters in `METRICS`; and the
invariant that a mutation is never reported as failed after its bytes
are in the arena.

**Exit criterion:** a randomized crash-consistency property test. A
deterministic generator, a mutation log kept outside the process,
`kill -9` at uniformly random points, and an assertion after restart
that the recovered arena matches the log, over payload sizes chosen so
sector boundaries land in every position, a hundred trials minimum.

**Rough size:** three days, and the test is most of it.

## Gate 3: the cache tier

**In the way:** the mission. A server that still needs a second process
for hot values has not been unburdened.

**Deliverable:** an embedded tier over the same arena and the same index
— TTL, per-namespace eviction policy, a volatile write policy that keeps
cache mutations out of the log, an amortized sweeper on the flusher's
existing backoff, and hit, miss, eviction and byte counters in
`METRICS`. It depends on reclaim that does not exist yet: a record free
list, index-node reuse turned on, and the quiescence contract the index
comments already require.

**Exit criterion:** the same workload against `redis-server` and against
this tier, on one host, at the same durability setting, publishing hit
rate, CPU-seconds per operation, resident memory and bytes written per
operation. The gate closes when the tier holds the same hit rate at a
lower total cost, and the comparison is published either way.

**Rough size:** three to five weeks, most of it in reclaim.

**Not in this gate:** a wire protocol, sets, lists, sorted sets,
scripting, pub/sub, streams, replication.

## Gate 4: the relational engine in the arena

**In the way:** the word "relational" in the project's own description.
Tables, joins and aggregations work, but their rows are JavaScript
objects that do not survive the process, and the native kernels are not
reached from the query path.

**Deliverable:** rows as sealed records in the mapped arena using the
format the Zig side already specifies and tests; an executor that walks
arena rows into a selection vector; a scan cursor so a table larger than
the current per-call cap can be read end to end.

**Exit criterion:** a one-million-row scan through the shipped query
path with the native filter and aggregate kernels reached.

**Rough size:** three to six weeks.

## Gate 5: measuring energy instead of inferring it

**In the way:** the mission's central claim. Until a power sensor or an
explicitly labelled proxy backs it, "a server consumes much less" is an
assertion.

**Shipped:** the sampler. `src/core/energy.zig` reads the platform
energy counter at 1 Hz, handles the counter's wrap, reports
`energy_source`, `energy_uj`, `energy_samples` and `energy_read_errors`
in `METRICS`, and owns no thread at all when no counter is readable.
Joules are never derived from CPU time.
`scripts/e2e_energy_test.js` covers both directions on any host.

**Still open:** the report format and the comparison itself. A published
figure needs hardware, toolchain, workload, repetitions and spread, and
the exit criterion is the comparison this repository has never run —
TakyonDB, an embedded SQLite, `redis-server` and a server database — on
one host, one workload, one durability setting. That needs a host with a
readable counter and exclusive use during the measurement window; see
[docs/energy.md](docs/energy.md).

**Rough size:** the sampler is done; the comparison is days of harness
time plus the waiting for a measurement host.

## Gate 6: more than one language

**In the way:** "any technology" is a claim about languages as much as
about data models, and today there is one SDK.

**Deliverable:** a Zig client library, then a versioned C header over the
existing C ABI, then bindings on top of that header. Publishing the ABI
means publishing the trust-boundary contract: which exports validate
their arguments, which return a failure rather than trusting the caller,
and which are safe to call with no daemon running.

**Exit criterion:** a Zig program opens a mapped segment, performs a
write and a read against a running daemon, and recovers after a restart.

## Not on any gate

| Excluded | Until |
|---|---|
| A wire protocol, including RESP compatibility | The mission needs a cache tier, not a Redis clone. Deciding otherwise is a different product. |
| Multi-tenancy and named segments per tenant | One segment is one database for one operator. |
| Replication, clustering, failover | The single-node engine does not yet state its own durability contract honestly. |
| Full SQL or PostgreSQL compatibility | Gate 4 decides how far the query surface goes, and that argument has not happened yet. |
| An ORM | The SDK is the interface. |
| Sets, lists, sorted sets, scripting, pub/sub, streams | Each needs its own reclaim story. |

## Shipped foundations

Summarized here so the shape of the engine is legible; the entries with
their measurements are in [CHANGELOG.md](CHANGELOG.md).

* Arena with a single canonical map, mirrored between Zig and TypeScript.
* Adaptive radix tree with growth, shrink, prefix keys and bounded
  allocation.
* Lock-free MPMC ring with per-slot sequence numbers.
* Write-ahead log with per-sector checksums, `fsync` discipline, direct
  I/O with a buffered fallback, and a logical record for index writes.
* Verified snapshots carrying only the extents in use, with a versioned
  footer that refuses what it cannot read.
* Recovery from snapshot plus log, including a malformed-log path that
  cannot abort the daemon.
* Daemon lifecycle: shared-memory ownership, graceful unlink, an admin
  endpoint, and idle loops that sleep instead of spinning.
* Relational layer in TypeScript and a Zig core, with tests on both
  sides, an SQL subset, hash joins, aggregations and a durable catalog.
* Test and measurement infrastructure: unit suites on both languages,
  E2E suites against a live daemon, and benchmark harnesses that report
  their own hardware.
