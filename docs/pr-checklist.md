# Checklist de PR relacional

- [ ] Header MIT + `zig fmt` / ESLint verdes.
- [ ] Tests nuevos (`*.test.ts` o `test "..."` Zig).
- [ ] E2E/CI: suite en `run-e2e.js` + workflow si toca daemon/ABI
  (los E2E con dist requieren prebuild, ver suite `catalog`).
- [ ] Docs (`docs/relational/` o `docs/architecture/` si aplica).
- [ ] `git commit -s` con Conventional Commits.
