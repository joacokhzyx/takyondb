#!/usr/bin/env node
'use strict';

// Runs every file in examples/relational/ as a program.
//
// The examples were never executed by anything. The docs listed one of the
// eleven and called three of them "upcoming" although they already existed,
// and a broken example is indistinguishable from a feature that does not
// work. Examples that only typecheck still rot silently the moment an API
// changes shape, so this runs them and fails on a non-zero exit.
//
// Usage: node scripts/examples_check.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples', 'relational');
const TSC = path.join(REPO_ROOT, 'src', 'sdk', 'ts', 'node_modules', '.bin', 'tsc');
const SDK_NODE_MODULES = path.join(REPO_ROOT, 'src', 'sdk', 'ts', 'node_modules');
// Same wiring run-e2e.js uses: resolve ts-node by module name through
// NODE_PATH, and run with cwd=scripts so ts-node picks up a consistent
// tsconfig. Passing an absolute -r path instead makes ts-node fall back to
// its own defaults and fail on a module/moduleResolution mismatch.
const EXAMPLES_CWD = path.join(REPO_ROOT, 'scripts');

function main() {
    if (!fs.existsSync(EXAMPLES_DIR)) {
        console.error(`[examples] no ${path.relative(REPO_ROOT, EXAMPLES_DIR)} directory`);
        process.exit(1);
    }
    if (!fs.existsSync(SDK_NODE_MODULES)) {
        console.error('[examples] node_modules not found; run: npm ci --prefix src/sdk/ts');
        process.exit(1);
    }

    // Typecheck everything first, in one pass, so an API change that breaks a
    // type is reported once instead of per example. The SDK sources live
    // outside this directory, so @types/node has to be pointed at explicitly
    // (same reason scripts/tsconfig.json sets typeRoots).
    if (fs.existsSync(TSC)) {
        const typesDir = path.join(REPO_ROOT, 'src', 'sdk', 'ts', 'node_modules', '@types');
        const files = fs
            .readdirSync(EXAMPLES_DIR)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => path.join(EXAMPLES_DIR, f));
        try {
            execFileSync(TSC, ['--noEmit', '--strict', '--target', 'ES2022', '--module', 'commonjs',
                '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck',
                '--typeRoots', typesDir, '--types', 'node', ...files], {
                stdio: 'inherit',
            });
            console.log(`[examples] typecheck ok (${files.length} files)`);
        } catch (e) {
            console.error('[examples] typecheck FAILED');
            process.exit(1);
        }
    }

    const examples = fs
        .readdirSync(EXAMPLES_DIR)
        .filter((f) => f.endsWith('.ts'))
        .sort();

    let failed = 0;
    for (const f of examples) {
        const full = path.join(EXAMPLES_DIR, f);
        try {
            execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', full], {
                cwd: EXAMPLES_CWD,
                stdio: 'pipe',
                timeout: 60000,
                env: {
                    ...process.env,
                    NODE_PATH: [SDK_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
                },
            });
            console.log(`[examples] ok    ${f}`);
        } catch (e) {
            failed++;
            console.error(`[examples] FAIL  ${f}`);
            const out = `${e.stdout || ''}${e.stderr || ''}`.trim().split('\n').slice(-12);
            for (const line of out) console.error(`          ${line}`);
        }
    }

    console.log(`\n[examples] ${examples.length - failed}/${examples.length} examples ran`);
    if (failed > 0) {
        console.error(`[examples] ${failed} example(s) failed`);
        process.exit(1);
    }
}

main();
