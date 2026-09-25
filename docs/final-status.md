# Estado final (verificado)

- Commits: `375` en `main` (todo `Conventional + DCO`), pusheado.
  Solo queda `main` como rama activa (codespace duplicada eliminada).
- TS: `27` archivos test, `97` tests verdes (`tsc --noEmit` + `vitest`);
  ESLint 0 errores.
- Zig: `zig build test` exit 0 en Linux (`74/74` tests incl. pushdown,
  catálogo, multi-root, scrubber, freelist, fuzz, shm names + unlink);
  `zig fmt --check` limpio.
- CI: `TakyonDB CI` (ubuntu/windows-2022/macos-15: fmt, tests, E2E,
  chaos, packaging) + `Relational Checks` (scan/refcount/unlink/crash/
  catalog/corruption E2E, benches + bench:relational gate).
- Runner local `run-e2e`: 10 suites (zerocopy, crash, catalog, corruption,
  vacuum, scan, admin-scan, refcount, unlink, chaos) con prebuild de dist
  y teardown SIGKILL sin zombies.
- Motor relacional: tablas/schemas/queries/joins/aggs/tx/SQL-subset
  ejecutable, ART `scanPrefix/scanRange` nativos + C-ABI + N-API + admin
  TCP, pushdown SIMD + aggs vectorizadas (con fallback TS), secundarios
  ART con raíces lógicas + rangos numéricos, catálogo `__catalog__`
  durable con reboot E2E tras SIGKILL, benches seeded.
- Integridad: filas selladas + envelopes TREC + scrubber (Zig + N-API +
  espejo TS), fuzz C-ABI determinista, freelist ART con cuarentena y
  contadores en METRICS, refcount de engine, teardown seam con inyección
  de fallos, daemon dueño del segmento (unlink en graceful).
- Docs: `40+` páginas + `docs/index.md`; `CHANGELOG` al día;
  `docs/release.md` trae el pre-tag checklist (incl. nota de drift de
  versiones para alinear al cortar el tag).
