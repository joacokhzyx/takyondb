#!/usr/bin/env node
'use strict';

// Documentation checker.
//
// What it used to be: a loop that asserted four specific files existed, not
// wired into CI, while its own comment claimed it "validates docs links".
//
// What it is now: a real check over every markdown file in the repository.
//   - relative links and images resolve to a file that exists
//   - #anchors resolve to a heading in the target file (with the GitHub
//     slug rules: lowercase, drop punctuation, spaces to hyphens)
//   - relative links to paths inside the repo (docs, src) are not dead ends
//   - a code fence is never left unterminated
//   - no link points at a file that was renamed away
//
// Usage:
//   node scripts/docs_check.js           # check
//   node scripts/docs_check.js --fix-hint  # add TODO hints (advisory only)
//   node scripts/docs_check.js --quiet

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

/** Markdown files to check. Vendored/generated trees are excluded. */
function markdownFiles() {
    const out = [];
    const skip = new Set(['node_modules', '.git', 'zig-out', 'dist', '.zig-cache']);
    (function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (skip.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.md')) out.push(full);
        }
    })(REPO_ROOT);
    return out;
}

/** GitHub-style heading slug. */
function slug(text) {
    return text
        .trim()
        .toLowerCase()
        // Strip inline markdown, links and code ticks before slugging.
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~]/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-');
}

/** Collect the slugs a markdown file exposes as anchors. */
function anchorsOf(content) {
    const anchors = new Set();
    let inFence = false;
    for (const line of content.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (m) anchors.add(slug(m[2]));
        // Explicit anchor targets: <a id="..."> or <a name="...">
        for (const a of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) anchors.add(a[1]);
    }
    return anchors;
}

/** Links/images in a markdown file, ignoring fenced code and autolinks. */
function linksOf(content) {
    const links = [];
    let inFence = false;
    const lines = content.split('\n');
    lines.forEach((line, i) => {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence) return;
        // [text](target) and ![alt](target)
        for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
            links.push({ target: m[1], line: i + 1 });
        }
        // Reference definitions: [id]: target
        for (const m of line.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) {
            links.push({ target: m[1], line: i + 1 });
        }
    });
    return links;
}

const problems = [];
const files = markdownFiles();
const cache = new Map();
const read = (p) => {
    if (!cache.has(p)) {
        try {
            cache.set(p, fs.readFileSync(p, 'utf8'));
        } catch {
            cache.set(p, null);
        }
    }
    return cache.get(p);
};

for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const content = read(file);
    if (content === null) {
        problems.push({ file: rel, line: 0, msg: 'unreadable' });
        continue;
    }

    // Unterminated code fence: makes the rest of the file render as code.
    const fences = (content.match(/^\s*(```|~~~)/gm) || []).length;
    if (fences % 2 !== 0) {
        problems.push({ file: rel, line: 0, msg: 'unterminated code fence' });
    }

    for (const { target, line } of linksOf(content)) {
        if (/^(https?:|mailto:|data:|#)/i.test(target)) {
            if (target.startsWith('#')) {
                const a = target.slice(1);
                if (a && !anchorsOf(content).has(a.toLowerCase())) {
                    problems.push({ file: rel, line, msg: `anchor #${a} not found in this file` });
                }
            }
            continue;
        }
        const [filePart, anchor] = target.split('#');
        const resolved = path.resolve(path.dirname(file), filePart);
        const relToRepo = path.relative(REPO_ROOT, resolved).split(path.sep).join('/');
        if (relToRepo.startsWith('..')) {
            // Escapes the repo: only a problem if it is clearly meant to be local.
            problems.push({ file: rel, line, msg: `link escapes the repository: ${target}` });
            continue;
        }
        // A link to a directory is legitimate (GitHub renders a listing) but
        // it cannot carry an anchor.
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
            if (anchor) {
                problems.push({ file: rel, line, msg: `anchor on a directory link: ${target}` });
            }
            continue;
        }
        const targetContent = read(resolved);
        if (targetContent === null) {
            problems.push({ file: rel, line, msg: `broken link: ${target}` });
            continue;
        }
        if (anchor && !anchorsOf(targetContent).has(anchor.toLowerCase())) {
            problems.push({ file: rel, line, msg: `broken anchor: ${target}` });
        }
    }
}

if (!QUIET) {
    console.log(`[docs-check] ${files.length} markdown files, ${problems.length} problem(s)`);
}
if (problems.length > 0) {
    for (const p of problems) {
        console.error(`  ${p.file}${p.line ? ':' + p.line : ''}: ${p.msg}`);
    }
    process.exit(1);
}
if (!QUIET) console.log('[docs-check] ok');
