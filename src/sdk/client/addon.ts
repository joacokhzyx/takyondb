/**
 * ============================================================================
 * File: addon.ts
 * Description: Locates and loads the compiled N-API addon.
 * Author/Maintainer: TakyonDB Team
 * License: MIT. See LICENSE for details.
 * ============================================================================
 *
 * Why this file exists
 * --------------------
 * `new TakyonDB(bindings)` requires a native addon, but the published npm
 * package used to ship only `dist/`. Nothing in the SDK knew where that
 * addon was supposed to come from, and every E2E script and benchmark
 * hardcoded the same repo-relative path (`../zig-out/bin/takyondb_bridge.node`),
 * which cannot exist inside `node_modules`. So `npm install takyondb` gave
 * you a package whose documented quickstart could not run.
 *
 * This module is the single place that knows how to find the addon. It is
 * deliberately lazy: requiring this file touches no filesystem and loads no
 * native code, so the unit tests (which pass a mock `TakyonBindings`) keep
 * working on machines with no compiled binary.
 *
 * A note on SharedArrayBuffer
 * ---------------------------
 * The addon hands back an external `ArrayBuffer` (one `mmap` per V8 isolate),
 * not a `SharedArrayBuffer`: Node exposes no way to wrap a raw pointer in a
 * SAB, and `Atomics.wait` requires one. So multi-worker access is mediated
 * by the mapped pages themselves, not by V8 atomics. See docs/sdk.md.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import type { TakyonBindings } from './proxy';

/** One prebuild per platform+arch. The addon is N-API, so it is not tied to a Node version. */
export type AddonPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64' | 'win32-x64';

export const SUPPORTED_PLATFORMS: readonly AddonPlatform[] = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
];

export interface LoadBindingsOptions {
    /** Exact path to the addon. Highest priority; skips the search. */
    addonPath?: string;
    /** Environment to read `TAKYON_ADDON_PATH` from. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
    /**
     * Package root to resolve the bundled `prebuilds/` against. Defaults to
     * the directory of the installed `takyondb` package. Only useful for
     * tests and for unusual layouts.
     */
    packageRoot?: string;
}

export interface AddonResolution {
    /** The path that was loaded, or the best candidate when resolution failed. */
    path: string;
    /** Which strategy produced it. */
    source: 'explicit' | 'env' | 'prebuilds' | 'node-gyp' | 'flat' | 'dev-zig-out';
    /** Every path probed, in order. Useful when a user reports a load failure. */
    probed: string[];
}

const ADDON_BASENAME = 'takyondb_bridge.node';

function currentPlatform(): string {
    return `${process.platform}-${process.arch}`;
}

/**
 * Lazily create a `require` that works in both the CommonJS build output and
 * an ESM test runner (vitest), where a bare `require` does not exist.
 */
let cachedRequire: NodeRequire | undefined;
function nodeRequire(): (id: string) => unknown {
    if (cachedRequire === undefined) {
        // `__filename` in the published CJS build; cwd is the fallback for
        // ESM contexts where it does not exist.
        const base = typeof __filename === 'string' ? __filename : `${process.cwd()}/index.js`;
        cachedRequire = createRequire(base);
    }
    const req = cachedRequire;
    return (id: string) => req(id);
}
/**
 * Find the installed package root by walking up from this module.
 *
 * Robust to the compiled layout changing (`dist/client/addon.js` today) and
 * to the package being vendored inside another `node_modules`.
 */
function findPackageRoot(start: string): string {
    let dir = start;
    for (let i = 0; i < 10; i++) {
        try {
            const pkgPath = path.join(dir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
                if (pkg.name === 'takyondb') return dir;
            }
        } catch {
            // Unreadable dir: keep walking.
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return start;
}

/** Every path we are willing to try, in priority order. */
export function addonCandidates(options: LoadBindingsOptions = {}): string[] {
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
    const root = options.packageRoot ?? findPackageRoot(__dirname);
    const out: string[] = [];

    if (options.addonPath) out.push(options.addonPath);
    if (env.TAKYON_ADDON_PATH) out.push(env.TAKYON_ADDON_PATH);
    out.push(path.join(root, 'prebuilds', currentPlatform(), ADDON_BASENAME));
    out.push(path.join(root, 'build', 'Release', ADDON_BASENAME));
    out.push(path.join(root, ADDON_BASENAME));
    // In-repo development: the monorepo builds the addon into zig-out/.
    // `root` is <repo>/src/sdk/ts when running from the working tree, so go
    // up three levels to reach the repository root.
    for (const up of [path.join(root, '..', '..', '..'), path.join(root, '..', '..')]) {
        out.push(path.join(up, 'zig-out', 'bin', ADDON_BASENAME));
    }
    return out;
}

/**
 * Report which search strategy a candidate path came from. Exported for
 * diagnostics: when a user reports that the wrong binary was picked up, this
 * says whether the env var or the prebuild won.
 */
export function classifyAddonSource(candidate: string, options: LoadBindingsOptions = {}): AddonResolution['source'] {
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});
    const root = options.packageRoot ?? findPackageRoot(__dirname);
    if (options.addonPath && path.resolve(candidate) === path.resolve(options.addonPath)) return 'explicit';
    if (env.TAKYON_ADDON_PATH && path.resolve(candidate) === path.resolve(env.TAKYON_ADDON_PATH)) {
        return 'env';
    }
    if (candidate.includes(`${path.sep}prebuilds${path.sep}`)) return 'prebuilds';
    if (candidate.includes(`${path.sep}build${path.sep}Release${path.sep}`)) return 'node-gyp';
    if (candidate.includes(`${path.sep}zig-out${path.sep}`)) return 'dev-zig-out';
    return 'flat';
}

/** Resolve the addon path without loading it. Throws if nothing is found. */
export function resolveAddon(options: LoadBindingsOptions = {}): AddonResolution {
    const platform = currentPlatform();
    const supported = (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
    const env = options.env ?? (typeof process !== 'undefined' ? process.env : {});

    // An explicitly requested location that does not exist is a hard failure.
    // Falling through to another candidate would silently load a different
    // binary than the caller asked for, which is far worse than an error:
    // `loadBindings({ addonPath })` would appear to work while ignoring the
    // argument. Same reasoning for TAKYON_ADDON_PATH: setting it is an
    // explicit statement of intent.
    const requested: Array<{ value: string; source: AddonResolution['source'] }> = [];
    if (options.addonPath) requested.push({ value: options.addonPath, source: 'explicit' });
    if (env.TAKYON_ADDON_PATH) {
        requested.push({ value: env.TAKYON_ADDON_PATH, source: 'env' });
    }
    for (const req of requested) {
        if (!fs.existsSync(req.value)) {
            throw new Error(
                `TakyonDB addon ${req.source === 'explicit' ? 'addonPath' : 'TAKYON_ADDON_PATH'} ` +
                    `points at a path that does not exist: ${req.value}\n` +
                    `Build it with: zig build -Doptimize=ReleaseSafe`
            );
        }
    }

    const probed: string[] = [];
    for (const candidate of addonCandidates(options)) {
        probed.push(candidate);
        try {
            if (fs.existsSync(candidate)) {
                return { path: candidate, source: classifyAddonSource(candidate, options), probed };
            }
        } catch {
            // Permission or race: treat as absent and keep looking.
        }
    }

    const lines = [
        `TakyonDB native addon not found for ${platform}.`,
        supported
            ? `The addon is built and bundled per platform; none of these paths exist:`
            : `Platform ${platform} has no bundled prebuild. Supported platforms: ${SUPPORTED_PLATFORMS.join(', ')}.`,
        '',
        'Probed:',
        ...probed.map((p) => `  - ${p}`),
        '',
        'Fixes:',
        '  - Build it from source:  zig build -Doptimize=ReleaseSafe   (then run from the repo)',
        '  - Point at an existing build:  TAKYON_ADDON_PATH=/path/to/takyondb_bridge.node',
        '  - Reinstall the package so its prebuild is present.',
    ];
    throw new Error(lines.join('\n'));
}

/** Shape check: a wrong file that loads but is not our addon should fail here, not later. */
function assertLooksLikeBindings(mod: unknown, path: string): TakyonBindings {
    const required = ['initSharedMemory', 'insert_index', 'search_index', 'pushDelta'];
    if (mod === null || typeof mod !== 'object') {
        throw new Error(`${path} loaded but did not export an object (got ${typeof mod}).`);
    }
    const missing = required.filter((k) => typeof (mod as Record<string, unknown>)[k] !== 'function');
    if (missing.length > 0) {
        throw new Error(
            `${path} loaded but is not a TakyonDB addon: missing ${missing.join(', ')}. ` +
                `This usually means a stale or foreign binary is on the path.`
        );
    }
    return mod as TakyonBindings;
}

/**
 * Load the native addon.
 *
 * Search order: explicit path, `TAKYON_ADDON_PATH`, the bundled
 * `prebuilds/<platform>-<arch>/` copy, a `node-gyp` style `build/Release`,
 * a flat copy, then the in-repo `zig-out/bin` build.
 *
 * @example
 * ```ts
 * import { loadBindings, TakyonDB } from 'takyondb';
 * const db = new TakyonDB(loadBindings(), 64 * 1024 * 1024);
 * ```
 */
export function loadBindings(options: LoadBindingsOptions = {}): TakyonBindings {
    const resolution = resolveAddon(options);
    const req = nodeRequire();
    let mod: unknown;
    try {
        mod = req(resolution.path);
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
            `Failed to load the TakyonDB addon from ${resolution.path} ` +
                `(source: ${resolution.source}).\n${reason}\n` +
                `A prebuild that does not match this platform or Node ABI will fail ` +
                `here; rebuild it with: zig build -Doptimize=ReleaseSafe`
        );
    }
    return assertLooksLikeBindings(mod, resolution.path);
}
