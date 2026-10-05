# Takyon as data infrastructure

This is the design behind [mission.md](mission.md): four layers over one
engine, and the order they have to be built in. It is a set of
decisions, not a description of the tree. What exists today is in
[architecture/README.md](architecture/README.md); what is missing is in
[next-steps.md](next-steps.md); the order is in
[../ROADMAP.md](../ROADMAP.md).

Each gate below states the decision, the reason, and the experiment that
closes it. Where a decision changes an on-disk or wire contract, the
repository's contribution boundaries apply: it needs sign-off before
implementation, not after.

---

## The shape

```
Takyon                                  the product
└── TakyonDB                            the engine
    ├── arena                           records, strings, radix index
    ├── WAL + snapshots                 durability
    └── substrate                       regions and capacities, decided at start
        ├── model: key-value            shipped
        ├── model: document             codec over the same records
        ├── model: relational           rows move into the arena
        └── model: cache                TTL, eviction, volatile writes
```

One engine. Four models are views over the same mapped pages, selected
per namespace. None of them brings a second process, a second index or
a second log.

The order is not aesthetic. Three of the four layers cannot be built
correctly on today's substrate, because the regions they need are
compile-time constants.

---

## Gate 1: a substrate that is configured, not compiled

### The problem

`src/core/memory/layout.zig` fixes every region boundary as a
compile-time constant. `ART_ROOT_OFFSET` is 2 MiB, the string arena
starts at 10 MiB, and the record region is whatever lies between them.
The record allocator in `src/sdk/takyon.ts` therefore has a ceiling
that does not move when the caller asks for a bigger arena, and its
out-of-memory message tells the user to change a constant they cannot
change. The index has the same problem in reverse: eight MiB whether
the workload needs forty keys or four million.

The same file already reserves 1 KiB at offset 0 for a global header
and writes only the arena magic and layout version into it. The space
for a runtime layout is allocated and unused.

### The decision

Region boundaries become header values. Their *field offsets* stay
compile-time constants, so the header can always be parsed; their
*values* are read from the mapped segment and validated on attach.

| Field | Meaning | Today |
|---|---|---|
| `arena_bytes` | Total mapped size | passed as the daemon's positional argument |
| `ring_capacity` | Slots in the ring | `RING_DEFAULT_CAPACITY` |
| `record_start`, `record_bytes` | Fixed-length record region | derived from constants |
| `art_root`, `art_bytes` | Radix index region | `ART_ROOT_OFFSET`, up to the string arena |
| `string_start`, `string_bytes` | Variable-length region | `STRING_ARENA_START` |
| `clock_ms` | Monotonic clock, see the cache gate | does not exist |

`LAYOUT_VERSION` goes from 2 to 3. An attach that reads version 2 uses
the compile-time defaults and says so; an attach that reads a version
it does not know refuses, because a wrong region table silently
corrupts the arena rather than failing.

`src/sdk/client/layout.ts` keeps mirroring the *field offsets*, so the
TypeScript client and the Zig engine still have exactly one place that
knows the map. The change stays inside the rule that the two files must
agree.

The snapshot footer gains the region table alongside the extent lengths
it already carries, and recovery refuses a footer whose layout version
does not match. `docs/relational/migration.md` gets the upgrade note: a
version 2 snapshot cannot be converted, only deleted and rebuilt.

### Configuration

One file, `takyon.json`, read by the daemon at startup. CLI flags
override it, and the absence of the file changes nothing, because every
key has a default equal to today's constant.

```json
{
  "arena_bytes": 268435456,
  "ring_capacity": 16384,
  "regions": { "record_bytes": 67108864, "art_bytes": 134217728 },
  "checkpoint_sec": 60,
  "admin_port": 7723,
  "namespaces": {
    "cache:session": { "model": "cache", "durability": "never", "policy": "allkeys-lru" },
    "app:users": { "model": "relational" }
  }
}
```

JSON rather than TOML because `std.json` is in the Zig standard library
and a second parser is a second thing to audit.

Every field is validated at startup against the constraint it
violates, and a bad configuration exits with a message naming the
field, the value and the limit. It does not fail later, at the first
insert that happens to cross the boundary.

### The experiment that closes it

A 2 GiB arena holding 500,000 records of a realistic width, through the
shipped SDK, with a checkpoint and a crash-recovery round trip. It
passes when the record region is set by configuration rather than by a
constant, and when a configuration that cannot fit is refused at
startup with a message that names the field.

---

## Gate 2: an explicit durability contract

### The problem

A write returns once the change is in the ring. The `fsync` happens
later on the flusher thread. There is no call an application can make
to say "this one must be on disk", and the ring is bounded, so a write
that arrives when the ring is full fails — after the bytes have already
been written into the arena by the client.

### The decision

* `commit()` pushes a barrier and, optionally, waits for the flusher to
  acknowledge it. A caller that needs durability asks for it per
  transaction instead of per write.
* A push that finds the ring full waits, with a bound, and raises a
  typed back-pressure error rather than a generic `Error` from a proxy
  trap.
* `ring_full_total`, `ring_full_wait_ns` and `deltas_dropped` appear in
  `METRICS`. An operator must be able to see saturation without writing
  a harness.
* A write is never reported as failed once its bytes are in the arena.
  Either the caller is told before the mutation is applied, or the
  mutation is queued and the caller is told it was accepted.

### The experiment that closes it

A write-path property test: a deterministic generator, a mutation log
written outside the process, `kill -9` at uniformly random points, and
an assertion after restart that the recovered arena matches the log.
Payload sizes chosen so that sector boundaries land in every possible
position. It runs at least a hundred trials, because the bug class
this replaces only appeared on some runs.

---

## Gate 3: the cache tier, which is what removes Redis

### The decision

The cache lives inside the same process and the same arena as
everything else. No daemon, no port, no wire protocol.

This is the deliberate half of "Redis out of the picture". The other
half — speaking RESP so unmodified clients connect — is a different
product with a different cost profile: a network server is exactly the
kind of always-resident, idle-drawing process the mission exists to
remove, and this repository already gates its own daemon's idle cost
with `scripts/e2e_idle_cpu_test.js`. Compatibility with an existing
client library is not on the roadmap, and saying so now is cheaper than
retracting it later.

### Entries

A cache entry is a record in the record region with a sealed envelope,
reusing the existing record envelope and CRC rather than inventing a
second integrity format:

| Field | Purpose |
|---|---|
| `flags` | model tag, durability tag |
| `expires_at_ms` | absolute deadline, or 0 for none |
| `version` | bumped on every write, for the reclaim contract |
| `value_off`, `value_len` | bytes in the string region |
| `hits` | recency and frequency counters live here |

Keys are namespaced `cache:<ns>:<key>` in the same radix index that
serves every other model, because the logical multi-root registry
already exists and disjoint prefixes already share one tree.

### Clock

Expiry is decided against `clock_ms` in the global header, maintained
as a monotonic maximum by whichever process advances it. A client that
maps a segment without a daemon must not decide that entries expired
because its own clock started at zero.

### Policies

`noeviction` is the default: a full arena is an error the caller sees,
not silent data loss. `allkeys-lru`, `allkeys-lfu` and `volatile-lru`
are selectable per namespace. `volatile-lru` only considers entries that
have a deadline, which is the policy a session cache wants.

### Reclaim

Eviction is only possible if freed bytes are reused, and today they are
not: the record region is a bump allocator with no free list, and
orphaned index nodes are quarantined with reuse disabled by default.
This gate therefore includes a record free list and turns on index-node
reuse.

That work is bounded by an invariant already written down: concurrent
`insert` and `remove` on overlapping keys is not safe in the index
today, so reclamation needs the quiescence contract the index comments
describe before eviction can run against live readers. Epoch-based
reuse is the intended mechanism.

### Durable writes are off by default

A cache namespace is volatile: its mutations are never written to the
log, because a cache entry that outlives a crash is not what a cache is
for. This requires one bit of policy on the ring's delta tag, which is
a write-path contract change and therefore needs sign-off before
implementation. It is the single most valuable line in this gate: it is
what makes the cost of a cache write zero bytes on disk.

### The sweeper

No new thread. The flusher already wakes on a bounded backoff when the
ring is empty, so expiration and eviction run there with an amortized
budget: a bounded number of entries per wake. The daemon's idle cost
stays inside the limit `scripts/e2e_idle_cpu_test.js` already enforces.

### Metrics

`cache_hits`, `cache_misses`, `cache_evictions`, `cache_expired`,
`cache_bytes` and `cache_sweep_steps` in `METRICS` and in the startup
log. A hit rate nobody can read is not an operating feature.

### Surface

Binary-safe `get`, `set`, `setex`, `del`, `incr`, `ttl` and a resumable
`scan`. Hashes and atomic counters. Sets, lists, sorted sets, scripting,
pub/sub, streams and replication are not in this tier; each is a
different data structure with a different reclaim story.

### The experiment that closes it

The same workload against `redis-server` and against this tier on one
host at the same durability setting: hit rate, CPU-seconds per
operation, resident memory, and bytes written per operation. The tier
passes when it holds the same hit rate at a lower total cost. If it
does not, the comparison is published anyway.

---

## Gate 4: the relational engine in the arena

### The decision

Rows become sealed records in the mapped arena, using the row format
that is already specified and tested on the Zig side, and the query
path executes over them instead of over a JavaScript `Map`.

The pieces exist and are unconnected: the row format with its checksum,
the scan entry points that return record offsets in order, the SIMD
filter and compensated-sum kernels, and an order-preserving encoding
for secondary index keys. What is missing is an executor that walks
arena rows into a selection vector, plus a cursor so a scan can be
resumed instead of returning a bounded page that cannot be continued.

### The experiment that closes it

A one-million-row scan through the shipped query path with the native
kernels reached, and a table larger than the current scan cap read
end to end through a cursor.

---

## Gate 5: measuring energy instead of inferring it

### The decision

Shipped. `src/core/energy.zig` reads the platform's energy counter at
1 Hz, folds each reading into an accumulation, handles the counter's
wrap, and reports `energy_source`, `energy_uj`, `energy_samples` and
`energy_read_errors` in `METRICS`. With no sensor it owns no thread, no
allocation and no syscall, and the joule fields read zero rather than an
estimate.

Two seams make it testable and attributable: `--no-energy` skips sampling
so a harness can isolate the instrument, and `--energy-root` points the
probe at another tree so the sensor path runs on a runner that has no
sensor. `scripts/e2e_energy_test.js` uses the second one, and fails if a
zero-sourced reading ever reports microjoules.

### What is still open

The report format and the comparison. `docs/energy.md` states the full
contract and, more usefully, what hardware it needs: a Linux host with a
readable package counter and exclusive use during the measurement window.
A container is not a measurement host, which is why this gate cannot be
closed from a codespace.

### The experiment that closes it

The four-way comparison this repository has never run: TakyonDB, an
embedded SQLite, `redis-server` and a server database, on one host, one
workload, one durability setting, with the CPU accounting published
whether or not a sensor exists.

---

## Gate 6: more than one language

### The decision

A Zig client library, then a versioned C header over the existing C
ABI, then bindings for other languages on top of that header. The C
ABI is the trust boundary today, and every export validates its
arguments and returns a failure rather than trusting the caller;
publishing it as a supported surface means publishing that contract,
including which functions are safe to call without a daemon.

---

## Dependencies

| Gate | Needs | Blocks |
|---|---|---|
| 2 Durability | Gate 1 for the region table | Every claim about being a database |
| 3 Cache | Gate 1 for the layout, Gate 2 for the write contract | The Redis comparison |
| 4 Relational | Gate 1 for row regions | Calling the engine relational |
| 5 Energy | Gates 3 and 4 to have something to compare | Publishing an energy claim |
| 6 Languages | A stable C ABI | Any runtime that is not Node |

Gate 2 does not wait for Gate 1 to finish; it can start on the current
constants and land its tests first.

---

## What this design does not decide

* How far the SQL surface goes. The relational engine has a `SELECT`
  subset today; whether that grows is a separate argument.
* Configuration format ergonomics beyond the file above, including
  whether environments need overrides.
* Wire protocols of any kind, including RESP.
* Multi-tenancy and replication. Both are excluded until the
  single-node engine is honest about cost and durability.
* Whether the models share one record encoding or one per model. The
  first is cheaper to build; the second avoids a flag in every entry.
