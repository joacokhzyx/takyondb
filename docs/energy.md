# Measuring energy

Takyon's central claim is that a server running Takyon spends less energy
than a server running a database and a cache beside it. That is a claim
about joules, so it is measured in joules or it is not claimed. This page
is the contract, and it says what has to exist before a figure can be
published.

The rule that shapes everything else: **a number without its method is not
a measurement.** Every figure in this repository carries the host, the
workload and the instrumentation that produced it, or it is deleted.

## What the daemon provides, and what it does not

The daemon owns the counter and nothing else. `METRICS` reports:

| Field | Meaning |
| --- | --- |
| `energy_source` | `none`, `rapl-package` or `rapl-subunit` |
| `energy_uj` | Gross microjoules accumulated since daemon start |
| `energy_samples` | Readings folded in; the first is a baseline |
| `energy_read_errors` | Failed reads, which on a readable counter is a bug |

What it deliberately does **not** provide:

* **No per-process attribution.** `rapl-package` is the whole CPU
  package: every process on the socket, including the shell, the harness
  and whatever else the machine is doing. The daemon reports gross
  accumulation; the harness knows what else ran and does the subtraction.
* **No idle baseline.** Subtracting a baseline from a load run is an
  estimate, and the conditions under which it is defensible have to be
  recorded with the result. The daemon cannot tell an idle machine from a
  busy one.
* **No device energy.** Bytes written to an SSD cost energy, and that
  energy is not in a CPU package counter at all. See below.
* **No synthesized joules.** With no readable counter the sampler does not
  exist, and `energy_uj` reads zero. CPU seconds are never multiplied by
  an assumed watts-per-core, because that figure depends on the silicon,
  the frequency policy and the system state. Proxy metrics are labelled as
  proxies, never presented as energy.

## What hardware this needs

Nothing can be measured here without one of these. In order of what makes
a claim publishable:

| Requirement | What it gives | Notes |
| --- | --- | --- |
| A Linux host with `/sys/class/powercap/intel-rapl:0/energy_uj` readable | Real microjoules for the CPU package | Intel silicon. The file is root-readable by default and the packaged systemd unit already runs as root. AMD has no mainline RAPL |
| Exclusive use of that host during the measurement window | Removes the "what else was running" objection | Alternating windows per system on a quiet machine, with the neighbours idle |
| A second, comparable host for the competitors | Avoids cross-machine comparison entirely | Not required if the windows are exclusive and interleaved |
| An external wall meter | Whole-box watts, including the parts no CPU counter sees | The only instrument that can measure the SSD and the fans |
| Device-level counters (NVMe SMART energy, or a `powertop`-class tool) | Energy per byte written | The axis where a write-amplification difference turns into joules |

A container is not a measurement host. `perf_event_paranoid`, missing
`powercap`, and a shared kernel all take the counter away, and no amount
of CPU-time accounting substitutes for it.

Two flags exist so a harness can isolate the instrument from the thing it
measures: `--no-energy` skips the sampler entirely, and `--energy-root`
points the probe at another tree, which is how
`scripts/e2e_energy_test.js` exercises the sensor path on a runner that
has no sensor.

## The required test record

Every published comparison records:

* source revision and toolchain, including the optimization mode;
* operating system and kernel version;
* CPU model, core count, frequency policy, and the counter path;
* memory capacity and what else was resident on the host;
* the runtime configuration of every system compared: arena size,
  checkpoint interval, durability setting, worker count, cache size,
  `maxmemory`, connection count;
* the workload: request or operation shape, payload size, client
  location, warm-up, duration, and repetitions;
* the raw numbers, the median, the spread, and the runs that were
  discarded with the reason;
* the instrument, or the statement that there was none.

## The order to measure in

1. Establish functional equivalence: every system returns the correct
   answer for the same input. A faster wrong answer is not a result.
2. Match the durability setting. An asynchronous acknowledgment measured
   against a synchronous commit compares two contracts and the number is
   meaningless. This is not hypothetical here; it is the single most
   important line on this page.
3. Warm up until compilation, connection setup and page cache no longer
   dominate.
4. Measure latency and throughput at several rates.
5. Measure CPU time and resident memory on the same runs.
6. Measure energy last, once the resource numbers are stable.
7. Repeat the whole thing and publish the raw results next to the
   summary.

## Interpreting results

```text
energy per operation = measured joules / completed operations
cpu time per operation = cpu-seconds / completed operations
idle power = joules accumulated while no client was attached / wall time
```

Report both absolute and normalized figures, and report idle cost
separately from per-operation cost. For a database that is mostly waiting,
idle cost is the term that dominates the total, and a per-operation figure
alone hides it.

## What the repository instruments today

| Instrument | What it measures |
| --- | --- |
| `scripts/e2e_idle_cpu_test.js` | Idle CPU cores, from `/proc`, with no client attached |
| `scripts/e2e_energy_test.js` | That the energy reporting is honest with and without a counter |
| `scripts/benchmark_chaos.js` | Saturated multi-worker latency, with its own drop accounting |
| `scripts/bench_scan.js` | Native scan and lookup paths against a live daemon |
| `docs/performance-truth.md` | Every published number, with what it excludes |

The four-way comparison the mission needs — TakyonDB against an embedded
SQLite, `redis-server` and a server database, at one durability setting —
does not exist yet. Until it does, the honest statement about energy is
the CPU accounting that does exist, labelled as a proxy.
