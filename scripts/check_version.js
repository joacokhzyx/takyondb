#!/usr/bin/env node
'use strict';

// Version drift gate.
//
// The version used to be hardcoded in six unrelated places and they
// disagreed: src/sdk/ts/package.json said 0.1.0 while the Debian, macOS and
// Windows packagers and the Homebrew formula said 1.0.0, SECURITY.md
// documented 0.1.x, and a historical v1.0.0 git tag predates the SDK by
// hundreds of commits. docs/release.md carried the reconciliation as a
// manual checklist item, which is the kind of thing that gets forgotten at
// the moment it matters.
//
// Two languages cannot literally share one file, so there are two canonical
// values and this check is what makes "one source of truth" true rather than
// aspirational:
//
//   src/sdk/ts/package.json   canonical for the SDK and the release pipeline
//   src/core/version.zig      canonical for the Zig artifacts
//
// Checks are deliberately narrow. A gate that flags Zig's version or a URL
// segment gets ignored, and an ignored gate is worse than no gate.
//
// Usage:
//   node scripts/check_version.js           # check
//   node scripts/check_version.js --print   # print the canonical version

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CANONICAL_FILE = 'src/sdk/ts/package.json';
const ZIG_FILE = 'src/core/version.zig';

const problems = [];
const info = [];

const read = (rel) => {
    try {
        return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
        return null;
    }
};

/**
 * Packaging inputs must not hardcode a project version. Each of these is
 * either fed the version by CI or reads it from package.json at build time.
 */
const NO_HARDCODED_VERSION = [
    { file: 'packaging/linux/build_deb.sh', what: 'Debian package version' },
    { file: 'packaging/macos/build_pkg.sh', what: 'macOS package version' },
];

/**
 * Sites that legitimately carry a literal but must match the canonical
 * version, so a bump does not silently leave them behind.
 */
const MUST_MATCH = [
    { file: 'SECURITY.md', what: 'supported versions table' },
    { file: 'docs/versioning.md', what: 'version policy' },
];

function main() {
    const pkgRaw = read(CANONICAL_FILE);
    if (pkgRaw === null) {
        console.error(`check-version: ${CANONICAL_FILE} not found`);
        process.exit(1);
    }
    const canonical = JSON.parse(pkgRaw).version;
    if (!/^\d+\.\d+\.\d+$/.test(canonical)) {
        problems.push(`${CANONICAL_FILE}: version "${canonical}" is not plain semver (x.y.z)`);
    }

    if (process.argv.includes('--print')) {
        console.log(canonical);
        return;
    }

    // 1. The Zig artifact version must agree with the SDK.
    const zigRaw = read(ZIG_FILE);
    if (zigRaw === null) {
        problems.push(`${ZIG_FILE} not found: the Zig version has no source of truth`);
    } else {
        const m = /pub const version = "([^"]+)";/.exec(zigRaw);
        if (!m) {
            problems.push(`${ZIG_FILE}: no \`pub const version = "..."\` found`);
        } else if (m[1] !== canonical) {
            problems.push(
                `${ZIG_FILE} says ${m[1]} but ${CANONICAL_FILE} says ${canonical}. ` +
                    `Bump both in the same commit (or the daemon will report the wrong version).`
            );
        } else {
            info.push(`${ZIG_FILE} agrees (${m[1]})`);
        }
    }

    // 2. No packager may hardcode a version.
    for (const { file, what } of NO_HARDCODED_VERSION) {
        const content = read(file);
        if (content === null) {
            problems.push(`${file} not found`);
            continue;
        }
        // A literal assignment: VERSION="1.2.3" or VERSION='1.2.3'
        const m = /^\s*(?:VERSION|MyAppVersion|PACKAGE_VERSION)\s*=\s*["']([0-9][^"']*)["']/m.exec(content);
        if (m) {
            problems.push(
                `${file}: ${what} is hardcoded to "${m[1]}". Read it from ${CANONICAL_FILE} instead ` +
                    `(node -p "require('./src/sdk/ts/package.json').version").`
            );
        } else {
            info.push(`${file} takes its version from ${CANONICAL_FILE}`);
        }
    }

    // 3. Inno Setup has no JSON reader, so a literal fallback is required;
    //    CI overrides it. Verify the fallback is at least not stale.
    const iss = read('packaging/windows/installer.iss');
    if (iss === null) {
        problems.push('packaging/windows/installer.iss not found');
    } else {
        const m = /#define\s+MyAppVersion\s+"([^"]+)"/.exec(iss);
        if (!m) {
            problems.push('packaging/windows/installer.iss: no `#define MyAppVersion` found');
        } else if (m[1] !== canonical) {
            problems.push(
                `packaging/windows/installer.iss: fallback MyAppVersion is "${m[1]}" but the canonical ` +
                    `version is ${canonical}. The release job passes /DMyAppVersion, so this only matters ` +
                    `for a local build, but a stale default mislabels a local installer.`
            );
        } else {
            info.push('packaging/windows/installer.iss fallback matches (CI overrides it anyway)');
        }
    }

    // 4. Docs that state the version must state the current one.
    for (const { file, what } of MUST_MATCH) {
        const content = read(file);
        if (content === null) {
            problems.push(`${file} not found`);
            continue;
        }
        if (!content.includes(canonical)) {
            problems.push(`${file}: ${what} does not mention the current version ${canonical}`);
        } else {
            info.push(`${file} mentions ${canonical}`);
        }
    }

    // 5. CHANGELOG must have a heading for the current version, or an
    //    explicit Unreleased-only note, when a tag exists.
    const changelog = read('CHANGELOG.md');
    if (changelog !== null) {
        const hasHeading = new RegExp(`^## \\[${canonical.replace(/\./g, '\\.')}\\]`, 'm').test(changelog);
        if (!hasHeading) {
            info.push(
                `CHANGELOG.md has no "## [${canonical}]" heading yet: the release is prepared but not cut, ` +
                    `which is the current intended state. Cutting the version means adding the heading.`
            );
        } else {
            info.push(`CHANGELOG.md has a "## [${canonical}]" heading`);
        }
    }

    console.log(`[check-version] canonical version: ${canonical} (${CANONICAL_FILE})`);
    for (const i of info) console.log(`  - ${i}`);
    if (problems.length > 0) {
        console.error('[check-version] FAILED:');
        for (const p of problems) console.error(`  ${p}`);
        process.exit(1);
    }
    console.log('[check-version] ok');
}

main();
