# E2E suites

An E2E suite is the only kind of test here that can catch a bug the unit
suites structurally cannot: the engine is a daemon, a mapped segment, a
write-ahead log and a crash. Each property that matters most here was
found by one of these, not by reading code.

This page describes what a suite owes. **It does not list the suites**:
the list lives in `scripts/run-e2e.js`, and the count in
[metrics.md](metrics.md) is generated from the tree. An earlier revision
enumerated them by hand and said "all seven suites" while the runner held
fourteen, which is the way a list like that rots.

## Running them

```bash
zig build -Doptimize=ReleaseSafe      # the suites need a ReleaseSafe build
cd scripts && npm run test:e2e        # every suite, timeouts enforced
```

A single suite runs the same way the runner runs it:

```bash
node scripts/e2e_scan_test.js                                  # plain JS
cd scripts && NODE_PATH=../src/sdk/ts/node_modules \
  node -r ts-node/register/transpile-only e2e_zerocopy_test.ts  # TypeScript
```

Typecheck only, without running anything:
`cd scripts && npm run typecheck`.

## What a suite must do

1. **Own its daemon.** `startDaemon` / `withDaemon` from
   `scripts/helpers/daemon.js`. Never spawn one by hand: `withDaemon`
   guarantees teardown on every exit path, and a suite that leaks a daemon
   holds the shared segment and the admin port, which poisons every suite
   after it. That happened, and the symptom was a later suite passing
   against a stranger's arena.
2. **Use an isolated `--data-dir`.** Suites share `data.takyon` in the
   working directory, and the WAL seeds its byte counters from the live
   file size, so a leftover file silently shifts every accounting
   assertion.
3. **Fail loudly.** A non-zero exit and a message naming the assertion.
   A suite that prints a failure and exits 0 is worse than no suite.
4. **Assert something that can distinguish success from a broken
   system.** The question to ask of every assertion: what would this print
   if the thing under test were completely broken? One crash-recovery
   suite used to connect twice and disconnect once, so its "reboot" phase
   re-read the process's own pre-crash memory and passed for any daemon
   that started at all. A whole class of durability bugs was hidden behind
   that.
5. **Clean up after itself**, including when an assertion fails.

## Registering one

Add an entry to `SUITES` in `scripts/run-e2e.js`:

```js
{ name: 'short-descriptive-name', file: 'e2e_thing_test.js', ts: false },
```

`ts: true` runs it through `ts-node`. `needsDist: true` builds the SDK
first, for suites that import from `dist`. The runner reads the list to
print the suite count, so nothing else needs updating — that is why the
count in the harness output is computed rather than typed, and why this
page does not list them either.

`xfail: 'reason'` marks a suite that pins a known-open defect. It still
runs, still has to fail, and the harness prints the reason — and reports
an **XPASS** if it starts passing, so the marker cannot outlive the fix.
Delete the marker when the suite is green.

If the suite needs a CI job of its own, that goes in a workflow, and the
workflow name is a link target people paste: renaming one means fixing
every reference to it in the same commit.

## The properties only a suite can check

Three of them have no unit-test equivalent, and each one exists because it
was wrong once:

| Property | Suite | What it caught |
|---|---|---|
| A daemon at idle must not burn CPU | `e2e_idle_cpu_test.js` | Two background loops using `yield` as their idle action, holding 1.8 cores forever |
| A killed daemon must recover what it acknowledged | `e2e_crash_auto_test.js` | Index writes that were never logged, so a key indexed after the last checkpoint was gone after a crash |
| A torn log must not abort the daemon | `e2e_corruption_test.ts` | An offset parsed out of payload bytes overflowing `u32`, panicking before the daemon served a single request |

The energy suite is the fourth kind: it asserts the *absence* of a
number. With no readable energy counter the daemon must report zero
microjoules, because a figure invented from CPU time is not a measurement.
See [energy.md](energy.md).

The randomized one is the fifth kind, and the most productive per line
written. `e2e_crash_property_test.js` generates mutations from a seed,
keeps the mutation log outside the process, `SIGKILL`s the daemon at
advancing points, and asserts what survived. A deterministic suite proves
one path; this one found four recovery bugs in recovery, each of which a
reasoned-about test had agreed was correct. It is currently `xfail`: it
finds a fifth. See [next-steps.md](next-steps.md).

## Prerequisites and known constraints

* `zig-out/bin/takyondb{,_bridge.node}` must exist. Build them first; a
  bare `zig build` is a Debug build and these suites need the one you ship.
* Do not run two suites concurrently against the same working directory.
* Arena sizes are per-suite constants, chosen to fit what the suite
  writes.
* Every `worker_thread` maps the segment with `initSharedMemory`. There is
  no `SharedArrayBuffer`: Node exposes no way to wrap a raw pointer in
  one, so each worker gets an external `ArrayBuffer` over the same pages.
  [sdk.md](sdk.md) has the details.
* Only Linux runs the whole set locally. The Windows and macOS legs are
  cross-compiled by `scripts/verify.sh` and run in CI, and
  `e2e_idle_cpu_test.js` skips where `/proc` is absent.
