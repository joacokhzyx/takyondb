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

## What CI runs that this script does not

Two workflows, and the matrix is not a default one:

| Workflow | Platform notes |
|---|---|
| `Takyon CI` | `ubuntu-latest`, `windows-2022`, `macos-15`. The macOS and Windows versions are pinned rather than `-latest` because Zig 0.14.1 predates the macOS 26 SDK and its test binaries fail to link `libSystem` there, and because that Zig's standard library does not compile against the VS2026 SDK on `windows-2025`. Both revisit when the toolchain moves |
| `Takyon Relational Suite` | The relational layer: native scan, refcount, graceful unlink, crash recovery, corruption, catalog reboot, the seeded bench, and the examples |

Platform details that exist only in CI:

* Line endings are enforced through `.gitattributes`, so a Windows
  checkout cannot rewrite a Zig file.
* `lib/node.lib` is untracked and fetched per build on Windows; it is the
  only binary the build needs from outside.
* Stale shared memory is removed between suites. A leftover POSIX segment
  from a differently-sized run carries a foreign layout, and the engine
  rightly refuses it.
* `NPM_TOKEN` exists only in Actions and never on disk.
* Artifacts are installers plus `zig-out/bin` and `zig-out/lib`, and the
  release job publishes the SDK and creates the GitHub release from them.

## What is deliberately not gated

* **Coverage percentage.** There is none measured, so there is none to
  enforce. The intent instead is structural: every Zig module carries
  inline `test "..."` blocks aggregated by `src/core/test.zig`, and every
  TypeScript module has a sibling `*.test.ts`. A new module without one
  is the gap, and it is visible in review.
* **Benchmark timing.** Shared runners are not a stable reference, so a
  timing gate would be flaky by construction. The relational bench is a
  gate on *completion*, not on a number; a regression shows up as a human
  reading the artifact.

## Before measuring anything

Build with `-Doptimize=ReleaseSafe`. A bare `zig build` is a Debug build,
and `ReleaseSafe` and `ReleaseFast` are different binaries. Measuring a
different binary than the one you ship is how the numbers in this
repository once stopped being reproducible; the method is written down in
[performance-truth.md](performance-truth.md).
