'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SDK_NODE_MODULES = path.join(__dirname, '..', 'src', 'sdk', 'ts', 'node_modules');
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || process.env.E2E_TIMEOUT || 120000);

const SUITES = [
  { name: 'zerocopy', file: 'e2e_zerocopy_test.ts', ts: true },
  { name: 'crash', file: 'e2e_crash_auto_test.js', ts: false },
  { name: 'corruption', file: 'e2e_corruption_test.ts', ts: true },
  { name: 'vacuum', file: 'e2e_vacuum_test.js', ts: false },
  { name: 'scan', file: 'e2e_scan_test.js', ts: false },
  { name: 'admin-scan', file: 'e2e_admin_scan_test.js', ts: false },
  { name: 'chaos', file: 'benchmark_chaos.js', ts: false },
];

function cleanStaleShm() {
  // Suites must be isolated: a leftover POSIX segment from a previous
  // suite carries a foreign layout (or no magic at all), and the daemon
  // rightly refuses to truncate/reuse it (BadVersion/SizeMismatch).
  // Windows named mappings die with their processes; nothing to do there.
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const fs = require('fs');
  if (process.platform === 'linux') {
    try {
      fs.unlinkSync('/dev/shm/TakyonDB_Master');
    } catch (e) {
      // Absent segment: nothing to clean.
    }
  }
  if (process.platform === 'darwin') {
    try {
      fs.unlinkSync('/tmp/takyondb_TakyonDB_Master');
    } catch (e) {
      // Absent file: nothing to clean.
    }
  }
}

function runSuite(suite, timeoutMs) {
  return new Promise((resolve) => {
    cleanStaleShm();
    const scriptPath = path.join(__dirname, suite.file);
    const args = suite.ts ? ['-r', 'ts-node/register/transpile-only', scriptPath] : [scriptPath];
    const nodePath = [SDK_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: { ...process.env, NODE_PATH: nodePath },
      stdio: 'inherit',
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[run-e2e] TIMEOUT: suite '${suite.name}' exceeded ${timeoutMs}ms; killing...`);
      try {
        child.kill('SIGKILL');
      } catch (e) {
        console.error(`[run-e2e] kill failed for '${suite.name}': ${e && e.message ? e.message : e}`);
      }
      resolve({ name: suite.name, file: suite.file, status: 'TIMEOUT', code: null, durationMs: timeoutMs });
    }, timeoutMs);

    const start = Date.now();
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`[run-e2e] ERROR spawning suite '${suite.name}': ${err && err.message ? err.message : err}`);
      resolve({ name: suite.name, file: suite.file, status: 'FAIL', code: null, durationMs: Date.now() - start });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code === 0) {
        resolve({ name: suite.name, file: suite.file, status: 'PASS', code, durationMs });
      } else {
        resolve({
          name: suite.name,
          file: suite.file,
          status: 'FAIL',
          code: signal ? `signal ${signal}` : code,
          durationMs,
        });
      }
    });
  });
}

async function main() {
  console.log(`[run-e2e] Running ${SUITES.length} suites (per-suite timeout ${TIMEOUT_MS}ms, cwd=scripts/)...`);
  const results = [];
  for (const suite of SUITES) {
    console.log(`\n[run-e2e] --- suite '${suite.name}' (${suite.file}) ---`);
    const res = await runSuite(suite, TIMEOUT_MS);
    console.log(`[run-e2e] suite '${res.name}': ${res.status} (code=${res.code}, ${res.durationMs}ms)`);
    results.push(res);
  }

  console.log('\n[run-e2e] Summary:');
  console.log('Suite       | Status  | Code       | Duration(ms)');
  console.log('------------|---------|------------|-------------');
  for (const r of results) {
    const codeStr = String(r.code === null || r.code === undefined ? '-' : r.code);
    console.log(`${r.name.padEnd(11)} | ${r.status.padEnd(7)} | ${codeStr.padEnd(10)} | ${r.durationMs}`);
  }

  const failed = results.filter((r) => r.status !== 'PASS');
  if (failed.length > 0) {
    console.error(`\n[run-e2e] FAILED: ${failed.length}/${results.length} suites failed (${failed.map((r) => r.name).join(', ')})`);
    process.exitCode = 1;
  } else {
    console.log(`\n[run-e2e] All ${results.length} suites passed.`);
  }
}

main().catch((err) => {
  console.error('[run-e2e] Fatal error:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
