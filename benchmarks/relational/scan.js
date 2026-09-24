// Bench: relational scan throughput (runs the real seeded suite).
const { execSync } = require('child_process');
execSync(`node ${__dirname}/bench.js scan`, { stdio: 'inherit' });
