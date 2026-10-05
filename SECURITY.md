# Security Policy

## Supported Versions

Current version: `0.1.0`. The canonical value lives in
`src/sdk/ts/package.json`; `scripts/check_version.js` fails CI if this table
drifts from it.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

TakyonDB is pre-alpha. Do not expose the daemon or shared-memory segment to
untrusted networks or processes, and do not rely on it for data you cannot
lose yet: it has no replication, and a single segment is a single disk's
worth of durability.

## Attack Surface Notes

* The Zig core uses `mmap` / `CreateFileMapping` shared memory and raw
  pointer arithmetic. All C-ABI entry points validate `offset`/`size`/
  `key_len`, and `scripts`-driven fuzzing covers the gated entrypoints and
  the pure kernels, but the covered surface is not the whole surface.
* The Node-API addon (`binding.cc`) runs in-process. Treat malformed
  `ArrayBuffer` offsets as untrusted input.
* The WAL uses CRC32 to detect torn writes, not cryptographic integrity.
  It does not protect against malicious tampering: an attacker who can
  write to the data directory can write a log that passes its own CRC.
* Every client maps the arena read-write, including readers. There is no
  read-only mapping in practice, so a client process that is compromised
  can modify any record any other client can see.
* The admin endpoint binds `127.0.0.1` and speaks line-based ASCII with no
  authentication. Anything that can reach that port can read keys through
  `SCAN` and `RANGE`, and can trigger a checkpoint.
* The relational catalog and rows live in the same arena with the same
  bounds checks as the key-value path; there is no additional isolation
  between models.

## Reporting a Vulnerability

**Use GitHub's private vulnerability reporting**: Security →
Report a vulnerability on this repository. It opens a private thread with
the maintainer, so the details never land in the public issue tracker.

This page used to say "open an issue with the `security` label". The label
did not exist, which meant the policy was a dead end: the one thing a
reporter should never do, put a vulnerability in public, was what the
policy asked for. The label exists now, for issues that are *about*
security without being exploits, and private reporting is the path for
the rest.

Please include:

1. Affected version or commit
2. OS and architecture
3. Minimal reproducer, as Zig or TypeScript
4. Impact assessment, and whether the data at risk is reachable from an
   untrusted party

Reports are acknowledged within 72 hours. There is no bounty and no
disclosure SLA beyond that; this is an early project with one maintainer,
and pretending otherwise would be worse than saying it.
