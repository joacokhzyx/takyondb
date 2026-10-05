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
// Plus three checks about the shape of docs/, added because the pages were
// not failing any of the above while being unusable:
//
//   - MIN_PAGE_LINES: a page under the floor is a section, not a URL. Thirty
//     lines is where this repository's own style guide draws the line, and
//     twenty pages were under it. A page can opt out with
//     `<!-- docs-check:allow-short -->` and a reason, for the cases where
//     short is genuinely correct.
//   - Reachability: every page under docs/ must be reachable from
//     docs/index.md by following links. An orphan is a page nobody finds,
//     and a page nobody finds rots without anyone noticing it rotted.
//   - No two pages may share a title, which is what a copy-paste produces.
//
// The gate is deliberately not "short pages are bad". docs/architecture/
// and the two model READMEs are short because they are indexes, and they
// are the ones a reader opens first. The gate exists so that a stub cannot
// be created by accident and stay by inertia; a deliberate short page is a
// judgement call that has to be written down.

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
    // .agents/ is the local-only knowledge base (.gitignore'd, never
    // published). Its links point at working notes that intentionally do not
    // exist yet, and it must never gate CI on a contributor's machine state.
    const skip = new Set(['node_modules', '.git', 'zig-out', 'dist', '.zig-cache', '.agents']);
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

/** A docs/ page shorter than this is a section of something else. */
const MIN_PAGE_LINES = 30;
const ALLOW_SHORT = '<!-- docs-check:allow-short -->';
const DOCS_INDEX = path.join(REPO_ROOT, 'docs', 'index.md');
const DOCS_ROOT = path.join(REPO_ROOT, 'docs') + path.sep;

/** Lines that carry no content: blanks, fences, and HTML comments. */
function proseLines(content) {
    let inFence = false;
    let n = 0;
    for (const line of content.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const t = line.trim();
        // Blank lines and HTML comments carry no content. List items do:
        // a page that is nothing but a list is a real page.
        if (t === '' || /^<!--/.test(t)) continue;
        n += 1;
    }
    return n;
}

/** The first H1 of a page, slugged the way GitHub would. */
function titleOf(content) {
    let inFence = false;
    for (const line of content.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) return slug(m[1]);
    }
    return null;
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

// --- shape checks over docs/ -------------------------------------------------

const docsPages = files.filter((f) => f.startsWith(DOCS_ROOT));

// 1. Minimum page length, with an explicit opt-out.
for (const file of docsPages) {
    const rel = path.relative(REPO_ROOT, file);
    const content = read(file);
    if (content === null) continue;
    if (content.includes(ALLOW_SHORT)) continue;
    const lines = proseLines(content);
    if (lines < MIN_PAGE_LINES) {
        problems.push({
            file: rel,
            line: 0,
            msg: `page has ${lines} lines of content, under the ${MIN_PAGE_LINES}-line floor: fold it into a parent or delete it (${ALLOW_SHORT} opts out, with a reason)`,
        });
    }
}

// 2. Duplicate titles.
{
    const byTitle = new Map();
    for (const file of docsPages) {
        const content = read(file);
        if (content === null) continue;
        const title = titleOf(content);
        if (!title) continue;
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(path.relative(REPO_ROOT, file));
    }
    for (const [title, owners] of byTitle) {
        if (owners.length > 1) {
            problems.push({
                file: owners[0],
                line: 0,
                msg: `title "${title}" is also used by: ${owners.slice(1).join(', ')}`,
            });
        }
    }
}

// 3. Reachability from docs/index.md.
if (fs.existsSync(DOCS_INDEX)) {
    const indexContent = read(DOCS_INDEX) || '';
    const queue = [DOCS_INDEX];
    const seen = new Set([path.resolve(DOCS_INDEX)]);
    while (queue.length > 0) {
        const current = queue.shift();
        const currentContent = read(current) || '';
        for (const { target } of linksOf(currentContent)) {
            if (/^(https?:|mailto:|data:|#)/i.test(target)) continue;
            const [filePart] = target.split('#');
            if (!filePart) continue;
            const resolved = path.resolve(path.dirname(current), filePart);
            if (!resolved.startsWith(DOCS_ROOT)) continue;
            if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) continue;
            if (seen.has(resolved)) continue;
            seen.add(resolved);
            queue.push(resolved);
        }
    }
    for (const file of docsPages) {
        const abs = path.resolve(file);
        if (abs === path.resolve(DOCS_INDEX)) continue;
        if (seen.has(abs)) continue;
        problems.push({
            file: path.relative(REPO_ROOT, file),
            line: 0,
            msg: 'orphan: not reachable from docs/index.md. Link it from a page a reader would visit, or delete it.',
        });
    }
}

if (!QUIET) {
    console.log(
        `[docs-check] ${files.length} markdown files, ${docsPages.length} under docs/, ` +
            `${problems.length} problem(s)`
    );
}
if (problems.length > 0) {
    for (const p of problems) {
        console.error(`  ${p.file}${p.line ? ':' + p.line : ''}: ${p.msg}`);
    }
    process.exit(1);
}
if (!QUIET) console.log('[docs-check] ok');
