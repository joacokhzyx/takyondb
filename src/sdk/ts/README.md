# TakyonDB TypeScript SDK (`takyondb`)

TypeScript wrapper for the TakyonDB ultra-low-latency storage engine
(zero-copy shared-memory client + fluent collection API).

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
