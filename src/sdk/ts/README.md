# TakyonDB TypeScript SDK (`takyondb`)

TypeScript wrapper for the TakyonDB ultra-low-latency storage engine
(zero-copy shared-memory client + fluent collection API).

## Runtime requirements

- Anything touching shared memory (`TakyonDB`, `TakyonClient`,
  collections, `ArtMirror`) needs two things the NPM tarball does NOT
  ship: the compiled N-API addon (`zig-out/bin/takyondb_bridge.node`,
  via `zig build`) and a running daemon (`zig build run`). Pass the
  addon as `bindings`; see `scripts/e2e_*.{js,ts}` for wiring examples.
- Pure-TS modules work standalone: `RelationalDatabase` + tables,
  queries, joins, SQL subset (`client/relational/`), schemas, catalog
  persistence, and key namespacing need no daemon.

## Scripts

Run from this directory (`src/sdk/ts`):

- `npm run build` — compile the SDK (`tsc -p tsconfig.build.json`) into `dist/`.
- `npm run test` / `npm run test:unit` — typecheck (`tsc --noEmit`) and/or run the
  vitest suite (`vitest run`, tests live in `../client/*.test.ts`).
- `npm run lint` — run ESLint over `client/`, `takyon.ts`, and `index.ts`
  (0 errors required; warnings ok).

## Docs

See the repo docs (`docs/`) and the root `README.md`:
https://github.com/joacokhzyx/takyondb#readme
