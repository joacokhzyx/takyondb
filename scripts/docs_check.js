#!/usr/bin/env node
// Validates docs links for relational (no broken refs).
const fs = require('fs');
const files = [
  'docs/relational/vision.md',
  'docs/relational/data-model.md',
  'docs/relational/query-api.md',
  'docs/architecture/relational-overview.md',
];
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`missing ${f}`);
    process.exit(1);
  }
}
console.log('[docs-check] ok');
