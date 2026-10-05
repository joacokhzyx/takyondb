# Cutting a release

The version has one canonical home: `src/sdk/ts/package.json`. The Zig side
mirrors it in `src/core/version.zig`, and `scripts/check_version.js` fails CI
if those two disagree, if a packager hardcodes a version, or if `SECURITY.md`
and `docs/versioning.md` stop mentioning the current one. Nothing here needs
to be reconciled by hand any more.

## Pre-tag checklist

Run it, don't read it. Each step below is a command that CI also runs, so
`scripts/verify.sh` is the whole checklist.

```bash
scripts/verify.sh                 # everything CI runs, plus pack_smoke
node scripts/check_version.js     # version consistency
node scripts/docs_check.js        # links and anchors
node scripts/project_stats.js     # regenerate docs/metrics.md after any count change
```

Then, mechanically:

1. **Bump the version** in `src/sdk/ts/package.json` and `src/core/version.zig`
   in the same commit. `node scripts/check_version.js --print` prints the
   canonical value for reference.
2. **Move `Unreleased` to a version heading** in `CHANGELOG.md`:
   `## [0.1.0] - YYYY-MM-DD`. `check_version.js` reports whether the heading
   exists yet.
3. **Confirm CI is green on the three OSes**, including the `pack-smoke` job.
   That job installs the real tarball and uses it, so it is the gate that the
   package is actually installable rather than merely buildable.
4. **Confirm `NPM_TOKEN`** is present in repository secrets. Without it only
   the publish step fails; the GitHub Release still gets its artifacts.
5. Tag `v*.*.*` and push. The tag triggers the `release` job, which
   assembles the prebuilds, verifies the tarball contents, publishes to npm
   and creates the GitHub Release.

## After the tag

* `gh release view` should list `.exe`, `.deb`, `.pkg` plus `zig-out/bin` and
  `zig-out/lib`.
* `npm view takyondb version` should match the tag.
* `npm install takyondb` in a scratch directory should give a package whose
  `loadBindings()` resolves `prebuilds/<platform>-<arch>/`.

## What the release job does, in order

1. Builds the daemon and the N-API addon on `ubuntu-latest`, `windows-2022`
   and `macos-15` (ReleaseSafe), and uploads the installers plus `zig-out/*`.
2. `pack-smoke` runs on each of those, packing the tarball, installing it
   clean and driving it.
3. On a tag, `release` downloads the artifacts, assembles
   `prebuilds/{linux-x64,darwin-arm64,win32-x64}/takyondb_bridge.node` into the
   package, refuses to publish unless `npm pack --dry-run` shows all three
   prebuilds and the loader, then publishes and creates the Release.

## Notes

* The daemon defaults to a 64 MiB arena and `--data-dir .`. The SDK's default
  arena size matches, so `new TakyonDB()` and a bare `takyondb` line up; a
  mismatch is refused with `SizeMismatch`.
* A `v1.0.0` tag once existed from before the SDK was versioned. It never
  had a release behind it and it claimed a version the project does not
  hold, so it has been deleted from the remote and from local clones. The
  commit it pointed at is still reachable in the branch history. Nothing
  to reconcile at the next tag.

## Repository metadata

The strings a visitor sees before reading a single line of code. They live
here because they are part of the identity, and a repository that changes
its name without changing these is describing something that does not
exist. Applying them needs repository admin rights, which is why they are
written down instead of being changed silently by a release script.

**Description** (Settings → General → Description):

```text
One engine, one arena, one process. Takyon's bet: a server should not need a database and a cache to store data, and software can be small, fast and honest at the same time.
```

**Topics** (Settings → General → Topics). Ten, because they are how the
project is found, and a misspelled one is worse than a missing one:

```text
database  embedded-database  key-value  storage-engine  cache
shared-memory  zig  typescript  nodejs  performance
```

**Labels.** The defaults plus these, so an issue or a pull request can say
which gate it serves and which area it touches:

```text
gate:truth          gate:substrate      gate:durability   gate:cache
gate:relational     gate:energy         gate:languages
area:engine         area:sdk            area:daemon       area:docs
area:packaging      security
```

`security` exists because `SECURITY.md` tells reporters to use it. It did
not exist before, which is the kind of gap a policy page should not have.

**Private vulnerability reporting** (Settings → Security → Enable). It is
the path `SECURITY.md` asks for, and it keeps a report out of the public
issue tracker from the first message.

