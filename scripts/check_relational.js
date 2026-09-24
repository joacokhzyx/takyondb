#!/usr/bin/env node
// Runs relational unit tests + Zig relational tests (fast, no daemon).
const { execSync } = require('child_process');
execSync('zig fmt --check src/core/relational', { stdio: 'inherit' });
execSync('npm run test:unit -- ../client/relational', { cwd: 'src/sdk/ts', stdio: 'inherit' });
console.log('[check-relational] ok');
