#!/usr/bin/env node
// Relational smoke: exercises Database/Table/Query without daemon.
const { execSync } = require('child_process');
execSync('npm run test:unit -- ../client/relational', { cwd: 'src/sdk/ts', stdio: 'inherit' });
console.log('[relational-e2e] ok');
