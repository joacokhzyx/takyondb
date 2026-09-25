#!/usr/bin/env node
'use strict';

// Generates docs/metrics.md from the tree, so the counts cannot drift.
//
// Every number in that page used to be typed by hand and went stale: it
// claimed "5 harnesses" and "40+ docs" while the repository had moved on,
// and docs/release.md quoted a different test count than docs/final-status.md.
// This is the single source for the project's shape, and CI runs it in
// --check mode so a drift fails the build instead of misleading a reader.
//
// Usage:
//   node scripts/project_stats.js           # write docs/metrics.md
//   node scripts/project_stats.js --json    # print JSON only
//   node scripts/project_stats.js --check   # fail if docs/metrics.md differs

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const METRICS_DOC = path.join(REPO_ROOT, 'docs', 'metrics.md');
const MARKER_START = '<!-- generated:stats:start -->';
const MARKER_END = '<!-- generated:stats:end -->';

function walk(dir, filter, out = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'zig-out' || e.name === 'dist' ||
            e.name === '.zig-cache') {
            continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, filter, out);
        else if (filter(full)) out.push(full);
    }
    return out;
}

const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join('/');

function countFiles(extensions, roots) {
    const files = [];
    for (const r of roots) walk(path.join(REPO_ROOT, r), (f) => extensions.some((e) => f.endsWith(e)), files);
    return files;
}

function countLines(files) {
    let total = 0;
    for (const f of files) {
        try {
            total += fs.readFileSync(f, 'utf8').split('\n').length;
        } catch {
            // Unreadable: skip rather than undercount silently.
        }
    }
    return total;
}

function collect() {
    const zig = countFiles(['.zig'], ['src']);
    const zigTests = zig.filter((f) => /^\s*test\s+"/m.test(fs.readFileSync(f, 'utf8')));
    const zigTestCount = zigTests.reduce(
        (n, f) => n + (fs.readFileSync(f, 'utf8').match(/^\s*test\s+"/gm) || []).length,
        0,
    );

    const ts = countFiles(['.ts'], ['src/sdk', 'scripts', 'benchmarks', 'examples']);
    const tsProd = ts.filter((f) => !f.endsWith('.test.ts'));
    const tsTestFiles = ts.filter((f) => f.endsWith('.test.ts'));
    const tsTestCount = tsTestFiles.reduce(
        (n, f) => n + (fs.readFileSync(f, 'utf8').match(/\b(it|test)\s*\(/g) || []).length,
        0,
    );

    const docs = countFiles(['.md'], ['docs']).concat(
        countFiles(['.md'], ['.']).filter((f) => {
            const r = rel(f);
            return !r.startsWith('docs/') && !r.includes('/') && r.endsWith('.md');
        }),
    );

    const scripts = countFiles(['.js', '.ts', '.sh', '.mjs'], ['scripts']);
    const benches = countFiles(['.js'], ['scripts', 'benchmarks']).filter((f) => /bench/.test(f));
    const e2e = countFiles(['.js', '.ts'], ['scripts']).filter((f) => /e2e_/.test(f));
    const examples = countFiles(['.ts'], ['examples']);
    const workflows = countFiles(['.yml', '.yaml'], ['.github']);

    // Deliberately no doc *line* count: docs/metrics.md is itself a doc, so
    // writing the count changes the count and the check can never converge.
    // Page count is stable and is what the page claims.
    return {
        code: {
            zig_files: zig.length,
            zig_lines: countLines(zig),
            ts_files: ts.length,
            ts_prod_files: tsProd.length,
            ts_lines: countLines(tsProd),
        },
        tests: {
            zig_test_files: zigTests.length,
            zig_tests: zigTestCount,
            ts_test_files: tsTestFiles.length,
            ts_tests: tsTestCount,
            e2e_scripts: e2e.length,
        },
        docs: {
            pages: docs.length,
        },
        harnesses: {
            bench_scripts: benches.length,
            scripts_total: scripts.length,
            examples: examples.length,
            workflows: workflows.length,
        },
    };
}

function render(stats) {
    const { code, tests, docs, harnesses } = stats;
    return [
        MARKER_START,
        '',
        '| Area | Count |',
        '|---|---|',
        `| Zig source files | ${code.zig_files} (${code.zig_lines} lines) |`,
        `| TypeScript source files | ${code.ts_prod_files} prod (${code.ts_lines} lines) |`,
        `| Zig tests | ${tests.zig_tests} in ${tests.zig_test_files} files |`,
        `| TypeScript unit tests | ${tests.ts_tests} in ${tests.ts_test_files} files |`,
        `| E2E suites | ${tests.e2e_scripts} scripts |`,
        `| Documentation pages | ${docs.pages} |`,
        `| Benchmark harnesses | ${harnesses.bench_scripts} |`,
        `| Runnable examples | ${harnesses.examples} |`,
        `| CI workflows | ${harnesses.workflows} |`,
        '',
        MARKER_END,
    ].join('\n');
}

function main() {
    const args = process.argv.slice(2);
    const stats = collect();

    if (args.includes('--json')) {
        console.log(JSON.stringify({ ...stats, node: process.version, platform: `${os.platform()}-${os.arch()}` }, null, 2));
        return;
    }

    const block = render(stats);

    if (args.includes('--check')) {
        let current = '';
        try {
            current = fs.readFileSync(METRICS_DOC, 'utf8');
        } catch {
            console.error(`project-stats: ${rel(METRICS_DOC)} is missing`);
            process.exit(1);
        }
        const start = current.indexOf(MARKER_START);
        const end = current.indexOf(MARKER_END);
        const existing = start === -1 || end === -1 ? null : current.slice(start, end + MARKER_END.length);
        if (existing !== block) {
            console.error('project-stats: docs/metrics.md is out of date.');
            console.error('Regenerate it with: node scripts/project_stats.js');
            console.error('\n--- current ---\n' + (existing || '(no generated block)'));
            console.error('\n--- expected ---\n' + block);
            process.exit(1);
        }
        console.log('[project-stats] docs/metrics.md is up to date.');
        return;
    }

    let doc = fs.readFileSync(METRICS_DOC, 'utf8');
    const start = doc.indexOf(MARKER_START);
    const end = doc.indexOf(MARKER_END);
    if (start === -1 || end === -1) {
        doc = `${doc.trimEnd()}\n\n${block}\n`;
    } else {
        doc = doc.slice(0, start) + block + doc.slice(end + MARKER_END.length);
    }
    fs.writeFileSync(METRICS_DOC, doc);
    console.log(`[project-stats] wrote ${rel(METRICS_DOC)}`);
    console.log(block);
}

main();
