---
name: Bug report
about: Something measurable is wrong
labels: bug
---

## What happens

The observation first, then the reproduction. A report that starts with
the cause is usually wrong about the cause.

## Reproduction

OS / architecture:
Zig version (`zig version`):
Node version (`node --version`):
Commit:
Arena size and daemon flags:

```bash
# the smallest thing that shows it
```

## Expected instead

What you expected, and what you based that on: a documented behaviour, a
prior version, or your own reading of the code.

## Output

```
paste the daemon's stderr, or the test output
```

## Which layer

This decides who reads it first and whether the fix belongs in the
engine, the SDK or the daemon. Mark one:

- [ ] Engine: arena, radix index, WAL, snapshot, recovery
- [ ] SDK: schema, proxy, layout mirror, relational TypeScript
- [ ] Daemon: lifecycle, admin endpoint, flags
- [ ] Packaging or CI

## Should a test have caught this

If a test exists that should have failed and did not, that is the more
valuable half of this report, and it is a defect of its own: the suite
printed a pass for a broken system. Say which suite and what it asserted.

If no test covers this, say so. That is not an excuse, it is the scope of
the fix.
