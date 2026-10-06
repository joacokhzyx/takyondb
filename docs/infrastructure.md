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

`src/core/memory/layout.zig` fixed every region boundary as a
compile-time constant. `ART_ROOT_OFFSET` was 2 MiB, the string arena
started at 10 MiB, and the record region was whatever lay between them.
The record allocator therefore had a ceiling that did not move when the
caller asked for a bigger arena, and its out-of-memory message named a
constant the user could not change. The index had the same problem in
reverse: eight MiB whether the workload needed forty keys or four
million.

The same file already reserved 1 KiB at offset 0 for a global header
and wrote only the arena magic and layout version into it. The space for
a runtime layout was allocated and unused.

### The decision, shipped as arena layout v3

Region boundaries are header values. Their *field offsets* stayed
compile-time constants, so the header can always be parsed before
anything inside it is trusted; their *values* are read from the mapping
and checked against it before the first read or write.

| Field | Meaning | Default |
|---|---|---|
| `arena_bytes` | Total mapped size | the daemon's positional argument |
| `ring_capacity` | Slots in the ring | 4096 |
| `record_start`, `record_bytes` | Fixed-length record region | derived from the arena |
| `art_root`, `art_bytes` | Radix index region | 8 MiB |
| `string_start`, `string_bytes` | Variable-length region | the remainder |
| `clock_ms` | Monotonic clock, for the cache gate | reserved, unread |

`validateRegions` checks every relation between the regions -- ring
capacity is a power of two, records start after the ring, no region runs
into the next, the index root is eight-byte aligned, the string bump word
has room and is aligned -- because the failure mode of a bad table is
silent corruption rather than an error.

A version 2 arena is refused rather than adapted to. Its header carries
no table, so attaching would mean guessing the regions. A version it does
not know at all is refused for the same reason the snapshot footer
refuses one.

`src/sdk/client/layout.ts` mirrors the field offsets and the rules, and
the SDK reads the table from the mapping at attach -- a client that fell
back to the constants would write records into whatever the configured
arena put at 2 MiB, which is now the index.

### What the snapshot needed

The footer carries the region table alongside the extent lengths. The
lengths alone cannot say where those bytes belong: a snapshot of a 2 GiB
arena and one of a 64 MiB arena produce the same four numbers, and
scattering the first at the second's offsets corrupts the arena instead
of failing. Recovery refuses a snapshot whose table is not the one it is
restoring into, and says which file to delete.

### Configuration

`src/server/config.zig`: one JSON file, every key optional, every default
the constant it replaces. CLI flags override it, and no file is
indistinguishable from an empty one. Unknown keys are refused, because a
typo in `record_bytes` that silently kept the default is the failure this
file exists to remove.

```json
{
  "regions": { "record_bytes": 268435456, "art_bytes": 536870912, "ring_capacity": 65536 },
  "checkpoint_sec": 60,
  "admin_port": 7723,
  "energy": true
}
```

Sizes are honoured in the order records, index, strings and the
boundaries are derived from them. An earlier shape kept the default index
root and applied sizes on top, which made a 64 MiB record region
impossible on any arena: records were asked to end where the index
began. Asking for room means putting the index after it.

The arena size itself is never read from the file. A file that disagreed
with an explicit flag would be silently overriding a decision the
operator made in front of it.

### The experiment that closes it

Shipped, and run by `scripts/e2e_regions_test.js`: a large arena holding
far more records than the default layout could, through the shipped SDK,
with a checkpoint, a SIGKILL and a reboot with the same configuration,
every record recovered with its value. The suite sizes itself to the
host's shared memory, prints the plan it ran next to the gate's numbers,
and refuses to run on a host too small to prove the property.

Growing a live segment is still future work. Regions are configurable;
the mapping is fixed at startup.

---

## Gate 2: an explicit durability contract

### The problem

A write returns once the change is in the ring. The `fsync` happens
later on the flusher thread. There is no call an application can make
to say "this one must be on disk", and the ring is bounded, so a write
that arrives when the ring is full fails — after the bytes have already
been written into the arena by the client.

### The decision, as built

* **`commit()` is a read barrier, not a log record.** It reads the ring's
  published producer position and waits for the flusher to publish
  durability at least that far. A barrier *delta* would have needed a new
  entry kind in the write-path protocol, and a log reader that does not
  recognise that kind stops replaying at it -- losing the tail of every
  log written by a newer daemon. A read barrier needs no format change.
* **The durable position lives in the ring header** (`durable_tail`,
  alongside `ring_saturated_total`, `ring_saturated_wait_ns` and
  `deltas_dropped`). In the ring region because that is what recovery
  zeroes: a stale marker left over from a previous incarnation would
  satisfy every barrier before a single byte was written. The header
  grows to seven cache lines, one per field, because the producer, the
  consumer and the flusher all write it and a shared line would be false
  sharing on the hottest counters in the system.
* **The flusher publishes the ring's *consumer* position, not its
  producer position.** Everything below `head` is in a synced sector at
  the moment of the call; `tail` also counts deltas a client pushed while
  that sector was being written, which are in no sector at all. This one
  line is the difference between `commit()` being a claim and being a
  sleep.
* **A push into a full ring waits** (250 ms, backing off from 50 us) and
  then raises `BackpressureError`, a distinct type meaning "in mapped
  memory, not in the log". The 250 ms is a number, not a policy; see
  [next-steps.md](next-steps.md).
* **`commit()` refuses clearly when nothing is logging** (native code
  `-3`, "no daemon is logging this data directory"). Claiming success
  there would be the worst available outcome: the caller would believe
  writes that nothing on the host is writing are durable.
* A checkpoint delta is queued without waiting. It carries no arena
  mutation, so there is nothing the caller has already done for a refusal
  to contradict.

### The experiment that closes it

A write-path property test: a deterministic generator, a mutation log
written outside the process, `kill -9` at uniformly random points, and
an assertion after restart that the recovered arena matches the log.
Payload sizes chosen so that sector boundaries land in every possible
position. It runs at least a hundred trials, because the bug class
this replaces only appeared on some runs.

That test is `scripts/e2e_crash_property_test.js`, and it passes: a
hundred trials, 70,000 committed records, every one recovered exactly.
It caught five bugs, and the fifth is the one that shows what a
randomized property test is for. The reader told padding from a split
entry by looking at the bytes -- an all-zero tail is padding -- and the
tail of a split entry is zero whenever the entry's payload is: an
eight-zero-byte inline delta is a `float64` field set to 0.0 or a `uint32`
set to 0, both of which the SDK writes routinely. Dropping that carry
left the next sector being parsed from the middle of an entry, where its
bytes were read as a header, so every entry behind it in that sector was
applied to offsets the log never named. The rule is now the writer's own
guarantee instead of a guess: the idle flush refuses to emit a sector
whose slack is under `MIN_PADDING`, so a tail shorter than that cannot be
padding and is carried whatever it contains.

No deterministic test would have found that one, because it takes a
specific payload length at a specific byte position in a specific sector,
after a specific amount of concurrent traffic. The other four -- a key's
string address logged where the format wanted its record address, an index
surviving a crash with entries whose records were gone, an index
operation naming a record the log never received, and the
producer-position publication above -- were all in the same suite and all
looked like working code.

Two limits remain and are in [next-steps.md](next-steps.md): the flusher
can wedge with nothing in the daemon to report it, and the whole argument
rests on `fsync` meaning what it says.

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
