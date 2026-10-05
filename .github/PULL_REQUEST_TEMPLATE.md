# Pull Request

## What this changes, and why

The problem before the diff. A reviewer who has to infer the intent from
the diff is reviewing two things at once.

## Gate and layer

Which roadmap gate this serves, and which layer it touches: engine,
substrate, model (kv, document, relational, cache), cache tier, SDK,
daemon, docs, packaging. If it serves none, say why it is still worth
merging.

## Verification

- [ ] `bash scripts/verify.sh --fast` (or the full `scripts/verify.sh`)
- [ ] `zig fmt --check src/ build.zig`
- [ ] `zig build test`
- [ ] `npm --prefix src/sdk/ts test`
- [ ] E2E or benchmarks, if applicable:

## Contracts touched

Check every one that applies. Each is a decision that is expensive to
reverse, which is why they are listed rather than assumed.

- [ ] `src/core/memory/layout.zig` offsets or mirrored constants
- [ ] The WAL sector format, the log record `kind` byte, or the snapshot
      footer
- [ ] The ring's delta tags or slot size
- [ ] The public SDK surface
- [ ] A file format, or CI release jobs

## Numbers

If the PR carries a performance or energy claim, it carries the method
and the hardware. "Faster" with no harness is not a claim this repository
publishes. If you found a defect you did not fix, say so in
`CHANGELOG.md` under *Known gaps* with the test that pins it.

## Checklist

- [ ] Conventional Commits + DCO sign-off (`git commit -s`)
- [ ] A regression test that could have failed, in the same commit
- [ ] `CHANGELOG.md` updated if user-facing
- [ ] No binaries, caches or `data.takyon*` files included
