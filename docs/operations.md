# TakyonDB Operations

Relational ops reuse the same daemon: see `relational/operations.md`
and `relational/backup.md` for checkpoint/backup flows.

## Daemon CLI

```bash
zig build run -Doptimize=ReleaseSafe [-- <mem_bytes>]
# e.g. ./zig-out/bin/takyondb 67108864
```

* Single optional positional arg: arena size in bytes, default `64 * 1024 * 1024`.
  Non-numeric input logs a warning and falls back to 64 MB.
* `--data-dir`, `--checkpoint-sec`, `--port`, `--config`, `--no-energy`
  and `--energy-root` are the flags. `takyondb --help` lists them with
  their defaults; see [Region sizes](#region-sizes) for `--config` and
  [Energy counters](#energy-counters) for the last two.
* Recovery + WAL paths are the relative files `data.takyon` (plus
  `data.takyon.snap`) in the daemon's **working directory** — run from the
  repo root unless you intend to create them elsewhere.
* Shared segment: `Local\TakyonDB_Master` (Windows) /
  `/TakyonDB_Master` (POSIX shm). Single-tenant: the bridge's name argument
  is fixed inside the engine.
* Shutdown: `SIGINT`/`Ctrl+C` triggers a graceful WAL drain + shutdown;
  the daemon owns the segment name and unlinks it on the way out
  (`SIGKILL` skips it — recovery path is snapshot + WAL replay).

## Region sizes

The arena is three regions -- records, index, strings -- and their sizes
are configuration, not compile-time constants. Before arena layout v3
the record region ended wherever the index root sat at 2 MiB, so a larger
arena bought a larger string region and nothing else.

The daemon stamps the table into the segment header, and every client
reads it from there. A client that assumed the old constants would write
records into the index.

```bash
cat > takyon.json <<'EOF'
{
  "regions": {
    "record_bytes": 268435456,
    "art_bytes": 536870912,
    "ring_capacity": 65536
  },
  "checkpoint_sec": 60,
  "admin_port": 7723,
  "energy": true
}
EOF

./zig-out/bin/takyondb 1073741824 --data-dir /var/lib/takyondb --config takyon.json
```

| Key | Meaning | Default |
|---|---|---|
| `regions.record_bytes` | Bytes for the record region | Whatever the arena has left after the index and strings |
| `regions.art_bytes` | Bytes for the index region | 8 MiB, or half of what is left behind the records |
| `regions.string_bytes` | Reserved for strings; the index grows to fill the rest | The remainder |
| `regions.ring_capacity` | Ring slots. A power of two, at least 16 | 4096 |
| `data_dir`, `checkpoint_sec`, `admin_port`, `energy` | The matching flags | The flag defaults |

Three rules that are not obvious:

* **Sizes are honoured in the order records, index, strings, and the
  boundaries are derived from them.** Asking for 64 MiB of records moves
  the index root after them. An operator who wants big records is not
  also doing arithmetic about where the index lands.
* **Unknown keys are refused.** A typo in `record_bytes` that silently
  kept the default is the failure this file exists to remove.
* **Every default equals the constant it replaces.** No file, an empty
  file and a file full of defaults produce the same arena.

A configuration that cannot describe the arena is refused at startup,
with the relation that failed named:

```text
[TakyonDB-Daemon] ERROR: the region table is not valid for this arena (RegionsOverlap).
  Every region is a size in takyon.json; the boundaries are derived from them.
```

The arena size itself always comes from the command line, never from the
file. A file that disagreed with an explicit flag would be silently
overriding a decision the operator made in front of it.

### Changing regions on an existing database

A snapshot records the region table it was written with, and recovery
refuses a snapshot whose table is not the one it is restoring into --
the extent lengths alone cannot say where those bytes belong. So:

* **Growing a region** is safe. Start the daemon with the new table; there
  is no snapshot to disagree with yet.
* **Shrinking or moving a region** means the existing snapshot is void.
  Start the daemon without the old snapshot file (or with the log only)
  and let it rebuild from the write-ahead log.

## Admin TCP endpoint (`127.0.0.1:7723`, `--port`)

Line-based ASCII: one line in, one line out, then close. Covered by
`scripts/e2e_admin_scan_test.js`.

| Command | Response |
| --- | --- |
| `PING` | `PONG` |
| `HEALTH` | `OK uptime_s=<n> arena=<bytes> ring=<depth>` |
| `METRICS` | `METRICS ring_depth=<d> wal_bytes=<b> wal_segments=<n> uptime_s=<u> fl_quarantined=<q> fl_reused=<r> fl_dropped=<x> energy_source=<s> energy_uj=<j> energy_samples=<k> energy_read_errors=<e>` (`fl_*` = ART freelist: quarantined orphans, opt-in reuses, dropped overflows. `energy_*` = the platform energy counter; see [Energy counters](#energy-counters)) |
| `CHECKPOINT` | `QUEUED` (or `FULL` when the ring is full) |
| `SCAN <prefix> [max]` | `OK <n> <o1>,<o2>,...` (offsets with prefix; default 64, cap 128) |
| `RANGE <prefix> <lo> <hi> [max]` | same, suffix in [`lo`, `hi`]; `-` = unbounded |
| other | `ERR unknown command` (malformed SCAN/RANGE get `ERR bad ...`) |

`SCAN`/`RANGE` read the daemon's own lock-free ART view (best-effort
under concurrent writers). Prefixes with spaces are not expressible
through the space-split protocol — use the N-API `scan_prefix` then.

## Energy counters

The daemon samples the platform's energy counter when one is readable,
and reports what it found in `METRICS` and in its startup line.

| Field | Meaning |
| --- | --- |
| `energy_source` | `none`, `rapl-package` or `rapl-subunit` |
| `energy_uj` | Microjoules accumulated since start. **Always 0 when the source is `none`** |
| `energy_samples` | Readings folded in. The first is a baseline, not a delta |
| `energy_read_errors` | Readings that failed; a non-zero value on a readable counter is a bug to report |

Two properties matter more than the numbers:

* **A joule figure is never synthesized.** With no readable counter there
  is no sampler thread, no allocation and no syscall, and `energy_uj`
  reads zero. CPU seconds are not converted into joules with a universal
  factor, because processor power depends on the hardware, the frequency
  policy and the system state. `scripts/e2e_energy_test.js` fails the
  build if a zero-sourced reading ever reports microjoules.
* **A package counter is the whole socket, not this process.**
  `rapl-package` measures every process on the CPU package, so the
  daemon reports the gross accumulation and leaves attribution to the
  harness, which knows what else was running. A per-route or per-process
  joule figure computed from it is an estimate and has to be labelled as
  one.

Only the Linux `powercap` tree is implemented
(`/sys/class/powercap/intel-rapl:0`). Windows, macOS and containers
without the counter report `none`.

Flags:

| Flag | Effect |
| --- | --- |
| `--no-energy` | Probe but do not sample. For harnesses that must isolate the sampler's own cost |
| `--energy-root <dir>` | Read the counter from another tree. The seam `scripts/e2e_energy_test.js` uses to exercise the sensor path on a runner with no RAPL |

## Packaging (built in CI from `zig-out/`, never committed)

| OS | Script | Output |
| --- | --- | --- |
| Linux | `packaging/linux/build_deb.sh` | `takyondb_<version>_amd64.deb` — installs `takyondb` to `/usr/local/bin`, bridge `.so` to `/usr/local/lib`, systemd unit from `packaging/linux/takyondb.service` |
| macOS | `packaging/macos/build_pkg.sh` | `TakyonDB-<version>.pkg` — installs `takyondb` to `/usr/local/bin`, LaunchDaemon from `com.takyondb.daemon.plist` |
| Windows | `iscc packaging/windows/installer.iss` | `TakyonDB-Setup-v<version>.exe` — installs `takyondb.exe` + `takyondb_bridge.dll` (bundles `LICENSE` + `README.md`) |

Every packager reads the version from `src/sdk/ts/package.json`;
`scripts/check_version.js` fails the build if one ever hardcodes it again.
The current version is in [versioning.md](versioning.md).

CI uploads `packaging/{windows/Output/*.exe,linux/*.deb,macos/*.pkg}` plus
`zig-out/bin/*` and `zig-out/lib/*` as `installers-<os>` artifacts.

## Release / NPM_TOKEN

On tags `v*.*.*`, the `release` job downloads all installer artifacts,
rebuilds the SDK (`src/sdk/ts`: `npm ci && npm run build`), publishes to
NPM (`npm publish --access public` using `secrets.NPM_TOKEN` as
`NODE_AUTH_TOKEN`), and creates a GitHub Release with generated notes + all
artifacts. A missing/invalid `NPM_TOKEN` secret fails the publish step but
not the artifact build.

## Logs

The daemon has **no log files**: all output (`[TakyonDB-Daemon]`,
`[WAL]`, `[TakyonDB-Snapshot]`, `[TakyonDB-Bootloader]`, CRC warnings) goes
to stdout/stderr via `std.debug.print`. E2E harnesses either pipe
(corruption/crash-recovery) or ignore (vacuum/chaos) daemon stdio. The
systemd unit and LaunchDaemon plist (`packaging/linux/takyondb.service`,
`packaging/macos/com.takyondb.daemon.plist`) define service-level log
capture; `NPM_TOKEN` lives only in GitHub Actions secrets, never on disk.
