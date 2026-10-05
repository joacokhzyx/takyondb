# Versioning

## The rule

The version lives in one file: `src/sdk/ts/package.json`. Zig cannot read
it, so `src/core/version.zig` mirrors it, and `scripts/check_version.js`
fails CI when the two disagree, when a packager hardcodes a version
instead of reading it, or when `SECURITY.md` and this page stop mentioning
the current one.

Bump both files in the same commit. `node scripts/check_version.js --print`
prints the canonical value.

## Current version

`0.1.0`, pre-alpha. It has never been published as a release, and the
maintainer's position is that it is not one yet. There are no git tags at
all: a `v1.0.0` tag once existed from before the SDK was versioned, it
never had a release behind it, and it was deleted because it claimed a
version the project does not hold.

The arena layout version moves independently of the package version. It is
`3`; it was `2` for the whole of `0.1.0`, and the difference is a break
in the on-disk contract rather than a release.

## Semver, honestly applied

Takyon is pre-alpha, so the guarantee is about the shape of a release, not
about stability within one. The parts that break in practice are named:

* **The arena map.** `src/core/memory/layout.zig` is an on-disk contract,
  mirrored in `layout.ts`. Changing an offset needs a layout version bump
  and the recovery path's refusal to reinterpret what it does not
  understand.

  **Layout version 3, in `[Unreleased]`, is a break.** The region
  boundaries moved from compile-time constants into the segment header, so
  a v2 segment carries no table and cannot be attached to. The daemon
  refuses it and says so; an operator removes the shared segment, which
  costs nothing because the data lives in the WAL and the snapshot, not in
  the segment. A v2 *snapshot* is refused by version for the same reason
  it always was, and its recovery falls back to log-only replay.
* **The WAL sector format**, including the `kind` byte on a log record.
  Pre-existing logs have to keep replaying, which is why the byte sits in
  former padding.
* **The snapshot footer.** Format v3 replaced v2, and a v2 file cannot be
  converted in place: its payload *is* the prefix image the current build
  no longer knows how to read. Recovery refuses it by version and falls
  back to log-only replay.
* **The public SDK surface.** Anything a caller imports.
* **The ring's delta tags.**

## What does not break

* The key-value API and the relational API are separate surfaces under
  separate key namespaces. The relational layer does not change what
  `Collection` means, and adding the relational model did not change the
  key-value model.
* A model added to the arena does not migrate the others.

## Deprecations

A breaking change is marked `feat!:` in the commit subject, says what
replaces it in `CHANGELOG.md` under the version it lands in, and lands
with a migration note in [relational/operations.md](relational/operations.md)
when it touches stored data. The rule that matters: a format change must
be able to say what happens to a file written by the previous version,
because "just delete it and replay" is only acceptable when the log still
holds what the snapshot does not.
