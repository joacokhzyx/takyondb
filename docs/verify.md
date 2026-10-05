# How to verify

`scripts/verify.sh` runs the same gates CI runs, in the same order, and
reports every failure instead of stopping at the first. Run it from the
repository root.

```bash
bash scripts/verify.sh --fast    # everything except the E2E suites
bash scripts/verify.sh           # the full set, needs a ReleaseSafe build
```

`--fast` is the loop to use while editing. The full run is what to run
before handing work over.

## What each gate covers

| Gate | What it catches |
|---|---|
| `zig version` | A toolchain other than the one CI pins |
| `zig fmt --check` | Unformatted Zig |
| `zig build test` | Engine unit tests |
| `npm --prefix src/sdk/ts test` | `tsc --noEmit` plus the TypeScript unit tests |
| `tsc -p scripts/tsconfig.json` | Type errors in the harnesses themselves |
| `docs_check` | Broken relative links, dead anchors, unterminated fences |
| `project_stats --check` | `docs/metrics.md` drifting from the tree |
| `check_version` | The SDK version, the Zig version and the packagers disagreeing |
| Cross-compile | Platform-specific compile errors, without waiting for CI |
| `run-e2e` | The suites in `scripts/e2e_*.{js,ts}` against a live daemon |
| `examples_check` | An example that does not compile or run |
| `pack_smoke` | A published tarball that cannot be installed and used |

Every gate prints the counts it produced, so there is no number in this
repository that has to be kept in step by hand.

## Prerequisites

* Zig 0.14.1 on `PATH`.
* Node 22 or newer.
* `npm ci --prefix src/sdk/ts` once, so the TypeScript toolchain and the
  type definitions exist.

The E2E suites need a `ReleaseSafe` build and start their own daemons;
they clean up after themselves, including on failure.

## Before measuring anything

Build with `-Doptimize=ReleaseSafe`. A bare `zig build` is a Debug build,
and `ReleaseSafe` and `ReleaseFast` are different binaries. Measuring a
different binary than the one you ship is how the numbers in this
repository once stopped being reproducible; the method is written down in
[performance-truth.md](performance-truth.md).
