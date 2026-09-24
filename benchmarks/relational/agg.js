// Bench: relational aggregation throughput (runs the real seeded suite).
const { execSync } = require('child_process');
execSync(`node ${__dirname}/bench.js agg`, { stdio: 'inherit' });
