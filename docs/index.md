# Documentation index

Everything under `docs/`, grouped by the question you arrived with rather
than by subsystem. `node scripts/docs_check.js` verifies every link and
anchor on this page, and CI runs it.

## Should I use this

| Page | What it answers |
|---|---|
| [../README.md](../README.md) | What Takyon is, a quickstart you can run, and when not to use it |
| [mission.md](mission.md) | Why the project exists, what it replaces, and what it does not claim yet |

## Run it

| Page | What it answers |
|---|---|
| [operations.md](operations.md) | Daemon flags, the admin protocol, signals, energy counters, packaging |
| [sdk.md](sdk.md) | The TypeScript SDK: schemas, keys, lifecycle, how the addon is found |
| [versioning.md](versioning.md) | Version policy and compatibility |
| [relational/README.md](relational/README.md) | The relational model: quickstart, glossary, harnesses, test strategy |

## Understand it

| Page | What it answers |
|---|---|
| [infrastructure.md](infrastructure.md) | The four layers, and the design behind each roadmap gate |
| [architecture/README.md](architecture/README.md) | The arena map, the ring, the index, the WAL, recovery, vacuum |
| [structure.md](structure.md) | How the repository is laid out |

## The relational model

| Page | What it answers |
|---|---|
| [relational/vision.md](relational/vision.md) | What the model is, what is true today, what is not |
| [relational/data-model.md](relational/data-model.md) | Types, schemas, rows, tables |
| [relational/query-api.md](relational/query-api.md) | `QueryBuilder`, predicates, projections, ordering, batch transactions |
| [relational/indexes.md](relational/indexes.md) | Primary and secondary indexes, ranges |
| [relational/sql-subset.md](relational/sql-subset.md) | The supported `SELECT` subset |
| [relational/operations.md](relational/operations.md) | Catalog, backup, migration |
| [relational/limits.md](relational/limits.md) | Sizes and shapes, and the gate that relaxes each one |

## Trust it

| Page | What it answers |
|---|---|
| [performance-truth.md](performance-truth.md) | Every published number: how to reproduce it and what it excludes |
| [energy.md](energy.md) | How an energy claim is measured, and what hardware that needs |
| [relational/performance.md](relational/performance.md) | What the relational paths cost, and what they do not include |
| [next-steps.md](next-steps.md) | What is not done, and what you get today instead |
| [../ROADMAP.md](../ROADMAP.md) | The seven gates, and the experiment that closes each one |
| [metrics.md](metrics.md) | Generated project counts |

## Change it

| Page | What it answers |
|---|---|
| [verify.md](verify.md) | The checks, what each one catches, and what CI adds |
| [e2e.md](e2e.md) | What an E2E suite has to be, and how to register one |
| [relational/troubleshooting.md](relational/troubleshooting.md) | Common failures, and the questions the docs do not answer |
| [STYLEGUIDE.md](STYLEGUIDE.md) | Naming, formatting, headers, tests |
| [release.md](release.md) | Cutting a release, and the repository's public metadata |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute, what is asked first, governance, support |
| [../SECURITY.md](../SECURITY.md) | Attack surface, supported versions, private reporting |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Code of conduct |
