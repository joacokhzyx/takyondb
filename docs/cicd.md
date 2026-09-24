# CI/CD

- `ci.yml`: Zig 0.14.1, fmt, `zig build test`, SDK typecheck+unit, E2E zero-copy
  + chaos, packaging (deb/pkg/exe), release to NPM on tags.
- `relational.yml`: fmt + Zig tests + TS relational unit tests +
  `zig build -Doptimize=ReleaseSafe` + scan E2E + scan bench (verificado
  en local con la misma secuencia).
- Artifacts: installers + `zig-out/bin/*` + `zig-out/lib/*`.
- Secrets: `NPM_TOKEN` only in Actions, never on disk.
