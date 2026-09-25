# Release relacional

- Versionado semver en `src/sdk/ts/package.json` (`0.1.0` actual).
- Tags `v*.*.*` disparan `release` (NPM + GitHub Release con artifacts).
- CHANGELOG `Unreleased/Added` ya registra fase 1 relacional.
- NPM: nombre `takyondb` libre (404 verificado); `prepack` copia
  `LICENSE` al tarball; lo nativo (addon + daemon) NO viaja en NPM —
  el SDK README lo declara (ver `src/sdk/ts/README.md`).
