# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

TakyonDB is pre-alpha. Do not expose the daemon or shared-memory segment to
untrusted networks or processes.

## Attack Surface Notes

* The Zig core uses `mmap` / `CreateFileMapping` shared memory and raw
  pointer arithmetic. All C-ABI entry points validate `offset`/`size`/
  `key_len`, but fuzzing coverage is still limited.
* The Node-API addon (`binding.cc`) runs in-process. Treat malformed
  `ArrayBuffer` offsets as untrusted input.
* The WAL uses CRC32 to detect torn writes, not cryptographic integrity.
  It does not protect against malicious tampering.

## Reporting a Vulnerability

Open a GitHub issue with the `security` label, or contact the maintainers
privately. Please include:

1. Affected version / commit
2. OS and architecture
3. Minimal reproducer (Zig or TypeScript)
4. Impact assessment

We aim to acknowledge reports within 72 hours.
