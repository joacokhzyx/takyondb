#!/usr/bin/env node
// Runs the real relational bench (requires SDK dist built).
// Build first: `cd src/sdk/ts && npm run build`.
const { execSync } = require('child_process');
const { join } = require('path');
execSync(`node ${join(__dirname, '..', 'benchmarks', 'relational', 'bench.js')} all`, {
  stdio: 'inherit',
});
