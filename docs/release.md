# Release relacional

- Versionado semver en `src/sdk/ts/package.json` (`0.1.0` actual).
- Tags `v*.*.*` disparan `release` (NPM + GitHub Release con artifacts).
- CHANGELOG `Unreleased/Added` ya registra fase 1 relacional.
- NPM: nombre `takyondb` libre (404 verificado); `prepack` copia
  `LICENSE` al tarball; lo nativo (addon + daemon) NO viaja en NPM —
  el SDK README lo declara (ver `src/sdk/ts/README.md`).

## Pre-tag checklist (antes de cortar la versión estable)

- [ ] Matriz verde en `main`: `zig fmt --check`, `zig build test`
  (`73/73`), `npm test` en `src/sdk/ts` (`27` archivos / `97` tests),
  ESLint 0 errores, `run-e2e` local (8 suites incl. `catalog`).
- [ ] CI verde en los 3 OS (`TakyonDB CI` + `Relational Checks`).
- [ ] Alinear versiones: hoy el SDK dice `0.1.0` pero los instaladores
  (`build_deb.sh`, `build_pkg.sh`, `installer.iss`, `takyondb.rb`) y el
  tag histórico dicen `1.0.0` (326 commits atrás). El número del próximo
  tag debe propagarse a los 5 lugares + `CHANGELOG` (`Unreleased` →
  versión) en el mismo PR.
- [ ] `NPM_TOKEN` válido en secrets (sin él falla solo el paso publish,
  los artifacts igual se adjuntan al Release).
- [ ] Tras el tag: verificar el Release de GitHub trae
  `.exe/.deb/.pkg` + `zig-out/bin|lib` y que `npm view takyondb`
  muestra la versión.
