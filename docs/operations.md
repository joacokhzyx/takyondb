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
* Recovery + WAL paths are the relative files `data.takyon` (plus
  `data.takyon.snap`) in the daemon's **working directory** — run from the
  repo root unless you intend to create them elsewhere.
* Shared segment: `Local\TakyonDB_Master` (Windows) /
  `/TakyonDB_Master` (POSIX shm). Single-tenant: the bridge's name argument
  is fixed inside the engine.
* Shutdown: `SIGINT`/`Ctrl+C` triggers a graceful WAL drain + shutdown;
  the daemon owns the segment name and unlinks it on the way out
  (`SIGKILL` skips it — recovery path is snapshot + WAL replay).

## Admin TCP endpoint (`127.0.0.1:7723`, `--port`)

Line-based ASCII: one line in, one line out, then close. Covered by
`scripts/e2e_admin_scan_test.js`.

| Command | Response |
| --- | --- |
| `PING` | `PONG` |
| `HEALTH` | `OK uptime_s=<n> arena=<bytes> ring=<depth>` |
| `METRICS` | `METRICS ring_depth=<d> wal_bytes=<b> wal_segments=<n> uptime_s=<u> fl_quarantined=<q> fl_reused=<r> fl_dropped=<x>` (`fl_*` = ART freelist: quarantined orphans, opt-in reuses, dropped overflows) |
| `CHECKPOINT` | `QUEUED` (or `FULL` when the ring is full) |
| `SCAN <prefix> [max]` | `OK <n> <o1>,<o2>,...` (offsets with prefix; default 64, cap 128) |
| `RANGE <prefix> <lo> <hi> [max]` | same, suffix in [`lo`, `hi`]; `-` = unbounded |
| other | `ERR unknown command` (malformed SCAN/RANGE get `ERR bad ...`) |

`SCAN`/`RANGE` read the daemon's own lock-free ART view (best-effort
under concurrent writers). Prefixes with spaces are not expressible
through the space-split protocol — use the N-API `scan_prefix` then.

## Packaging (built in CI from `zig-out/`, never committed)

| OS | Script | Output |
| --- | --- | --- |
| Linux | `packaging/linux/build_deb.sh` | `takyondb_1.0.0_amd64.deb` — installs `takyondb` to `/usr/local/bin`, bridge `.so` to `/usr/local/lib`, systemd unit from `packaging/linux/takyondb.service` |
| macOS | `packaging/macos/build_pkg.sh` | `TakyonDB-1.0.0.pkg` — installs `takyondb` to `/usr/local/bin`, LaunchDaemon from `com.takyondb.daemon.plist` |
| Windows | `iscc packaging/windows/installer.iss` | `TakyonDB-Setup-v1.0.0.exe` — installs `takyondb.exe` + `takyondb_bridge.dll` (bundles `LICENSE` + `README.md`; MIT-only since license migration) |

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
