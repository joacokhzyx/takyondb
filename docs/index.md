# Documentation index

Everything under `docs/`, grouped by what you are trying to do. `node
scripts/docs_check.js` verifies every link and anchor on this page, and CI
runs it.

## Start here

| Page | What it answers |
|---|---|
| [../README.md](../README.md) | What TakyonDB is, and a quickstart you can run |
| [quickstart-relational.md](quickstart-relational.md) | Relational engine quickstart |
| [sdk.md](sdk.md) | The TypeScript SDK: schemas, layouts, key rules, lifecycle, how the addon is found |
| [structure.md](structure.md) | How the repository is laid out |
| [verify.md](verify.md) | How to run the checks locally |

## Operating it

| Page | What it answers |
|---|---|
| [operations.md](operations.md) | Running the daemon: flags, admin protocol, signals |
| [release.md](release.md) | Cutting a release, pre-tag checklist, publishing |
| [versioning.md](versioning.md) | Version policy and compatibility |
| [cicd.md](cicd.md) | What CI does and why each gate exists |
| [packaging-relational.md](packaging-relational.md) | Platform packages and the npm distribution |
| [support.md](support.md) | Where to ask and what to include |
| [../SECURITY.md](../SECURITY.md) | Attack surface, supported versions, reporting |
| [relational/security.md](relational/security.md) | Security notes for the relational layer |

## Architecture

| Page | What it answers |
|---|---|
| [architecture/index.md](architecture/index.md) | Index of the architecture deep dives |
| [architecture/README.md](architecture/README.md) | Arena layout, ring buffer, ART, WAL, vacuum |
| [architecture/catalog.md](architecture/catalog.md) | Table catalog and DDL persistence |
| [architecture/relational-overview.md](architecture/relational-overview.md) | How the relational layer maps onto the KV engine |
| [architecture/relational-core.md](architecture/relational-core.md) | The Zig relational core |
| [architecture/relational-sdk.md](architecture/relational-sdk.md) | The TypeScript relational layer |

## Relational engine

| Page | What it answers |
|---|---|
| [relational/README.md](relational/README.md) | Index of the relational docs |
| [relational/vision.md](relational/vision.md) | Goals and non-goals |
| [relational/data-model.md](relational/data-model.md) | Types, schemas, rows, tables |
| [relational/query-api.md](relational/query-api.md) | `QueryBuilder`, predicates, projections, ordering |
| [relational/sql-subset.md](relational/sql-subset.md) | The supported `SELECT` subset |
| [relational/transactions.md](relational/transactions.md) | Batch transactions and isolation |
| [relational/indexes.md](relational/indexes.md) | Primary and secondary indexes, ranges |
| [relational/performance.md](relational/performance.md) | What the relational paths actually cost, and what they do not include |
| [relational/limits.md](relational/limits.md) | Known limits and sizes |
| [relational/api.md](relational/api.md) | API surface |
| [relational/operations.md](relational/operations.md) | Backup, maintenance, catalog |
| [relational/migration.md](relational/migration.md) | Migrating between versions |
| [relational/security.md](relational/security.md) | Security notes for the relational layer |
| [relational/troubleshooting.md](relational/troubleshooting.md) | Common failures |
| [relational/faq.md](relational/faq.md) | Questions and answers |
| [relational/glossary.md](relational/glossary.md) | Terms |

## Tests, benchmarks and metrics

| Page | What it answers |
|---|---|
| [performance-truth.md](performance-truth.md) | Every published number: how to reproduce it and what it excludes |
| [bench-relational.md](bench-relational.md) | Relational benchmark harnesses |
| [testing-relational.md](testing-relational.md) | Relational test strategy |
| [e2e.md](e2e.md) | The E2E suites and how to run them |
| [e2e-relational.md](e2e-relational.md) | Relational E2E suites |
| [coverage.md](coverage.md) | What is and is not covered, measured |
| [metrics.md](metrics.md) | Generated project counts |

## Project and process

| Page | What it answers |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Code of conduct |
| [clean-code.md](clean-code.md) | Code style rules |
| [STYLEGUIDE.md](STYLEGUIDE.md) | Documentation style |
| [styleguide-relational.md](styleguide-relational.md) | Relational documentation style |
| [pr-checklist.md](pr-checklist.md) | What a pull request should include |
| [open-source.md](open-source.md) | Open-source stance |
| [governance.md](governance.md) | Decision making |
| [roadmap-visual.md](roadmap-visual.md) | Roadmap at a glance |
| [roadmap-relational.md](roadmap-relational.md) | Relational roadmap |
| [executive-roadmap.md](executive-roadmap.md) | Roadmap for a non-engineer audience |
| [conduct-summary.md](conduct-summary.md) | Summary of the code of conduct |
| [license-note.md](license-note.md) | Licensing notes |
| [thanks.md](thanks.md) | Credits |
| [final-status.md](final-status.md) | Current verified state |
| [next-steps.md](next-steps.md) | What is next |
| [autonomy-log.md](autonomy-log.md) | Record of autonomous work sessions |
