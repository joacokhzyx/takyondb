# Contributing to Takyon

Thanks for looking. Read this before you write code: most of it is about
what this project will not accept, and that is the part that saves you
the time.

## What this project is

Takyon is the data layer a server runs on: storage, indexes, cache and
queries in one process over one mapped arena, so a server spends less CPU,
memory and energy than it runs a database and a cache beside it. That is
in [docs/mission.md](docs/mission.md), the design behind it is in
[docs/infrastructure.md](docs/infrastructure.md), and the open limits are
in [docs/next-steps.md](docs/next-steps.md). Read the mission before you
propose a feature: work that does not serve it is a valid contribution,
but it should be argued for as such rather than assumed welcome.

The engine is pre-alpha. Not production-ready, not exposed to untrusted
networks or processes, no replication, one segment per operator.

## The rule everything else follows

**Never publish a claim you cannot reproduce.**

That means: every number in prose comes from a harness in this repository
or is linked to one; every performance adjective is attached to that
number; a limit is written down in [docs/next-steps.md](docs/next-steps.md)
rather than left to be discovered; and when a claim turns out to be false,
it is retracted in the open, in the same document, with the reason.

This is not decoration. It is why the numbers here are worth reading at
all. `docs/performance-truth.md` documents a benchmark the project had to
retract and why; `README.md` carries a correction about
`SharedArrayBuffer` that an earlier revision got wrong; the chaos
benchmark was withdrawn for a while because it reported percentiles over a
workload that silently dropped 85% of its writes.

"A test that cannot fail is worse than no test." If a suite's assertions
cannot tell success from a broken system, fix the suite or mark it `xfail`
with the reason. Never weaken an assertion to get a green build.

## Where the code is

```
src/core/            the engine, in Zig: arena, index, ring, WAL, recovery
src/server/main.zig  the daemon
src/sdk/             the TypeScript SDK and the N-API bridge
docs/                reference, mission and design pages, indexed in docs/index.md
scripts/             checks, E2E suites and benchmark harnesses
```

Two invariants a change can break without a compiler noticing:

* The arena map lives in `src/core/memory/layout.zig` and is mirrored in
  `src/sdk/client/layout.ts`. The Zig file pins its absolute values with
  `comptime` assertions. If the two disagree, one is wrong.
* `src/core/c_abi/exports.zig` is a trust boundary. Every export
  validates its arguments and returns a failure rather than trusting the
  caller.

## Before you start

Ask first, in an issue, if your change touches any of these. Each one is
an on-disk or published contract, and the cost of reversing it is not
proportional to the diff:

* region offsets in `layout.zig`, or the WAL sector format, or the log
  record `kind` byte, or the snapshot footer
* the ring's delta tags or slot size
* anything that breaks the public SDK API
* CI release jobs, or publishing

Tell us which gate it serves. There are seven, in
[ROADMAP.md](ROADMAP.md), and each one has an experiment that closes it.
If your change serves none of them, that is a legitimate contribution and
also a conversation worth having first.

## Working on it

```bash
zig build -Doptimize=ReleaseSafe   # before anything: a bare `zig build` is Debug
npm ci --prefix src/sdk/ts

bash scripts/verify.sh --fast      # the loop while you edit
bash scripts/verify.sh             # the same gates CI runs, plus E2E
```

`verify.sh` reports every failure rather than stopping at the first, so
read the summary. If you touch benchmark numbers, `ReleaseSafe` is not
optional: measuring a different binary than the one you ship is how the
numbers in this repository once stopped being reproducible.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
with a DCO sign-off, `git commit -s`. The commit message says what broke,
what the fix is, and what you measured. If you found a defect and did not
fix it, that goes in `CHANGELOG.md` under *Known gaps* with the test that
pins it.

## Style

* Zig: `zig fmt`, `snake_case` functions and fields, `PascalCase` types.
  No magic numbers; use the `layout` constants, which is why they exist.
* TypeScript: prettier and ESLint. `npm --prefix src/sdk/ts run lint`.
* Comments earn their place by saying what the code cannot: why, what
  breaks otherwise, what the history was. A comment that would still be
  true after renaming the function to its own first line is deleted.
* Documentation: [docs/STYLEGUIDE.md](docs/STYLEGUIDE.md) for naming and
  formatting, US English, no emoji outside the README badge row.
* Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Governance and support

One maintainer, decisions by argument, and a repository whose credibility
is worth more than a green board. Questions go in issues and
discussions; security reports do not, and
[SECURITY.md](SECURITY.md) says where they go instead.

Licensed under the [MIT License](LICENSE). Contributing means agreeing
that your contribution carries the same license.
