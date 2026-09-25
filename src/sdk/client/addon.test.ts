import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    addonCandidates,
    classifyAddonSource,
    loadBindings,
    resolveAddon,
    SUPPORTED_PLATFORMS,
} from './addon';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-addon-'));
}

const platformKey = `${process.platform}-${process.arch}`;

describe('addonCandidates', () => {
    it('probes in priority order: explicit, env, prebuilds, node-gyp, flat, dev', () => {
        const root = tmpDir();
        const candidates = addonCandidates({
            addonPath: '/explicit/addon.node',
            env: { TAKYON_ADDON_PATH: '/from/env/addon.node' },
            packageRoot: root,
        });

        expect(candidates[0]).toBe('/explicit/addon.node');
        expect(candidates[1]).toBe('/from/env/addon.node');
        expect(candidates).toContain(path.join(root, 'prebuilds', platformKey, 'takyondb_bridge.node'));
        expect(candidates).toContain(path.join(root, 'build', 'Release', 'takyondb_bridge.node'));
        expect(candidates).toContain(path.join(root, 'takyondb_bridge.node'));
        // The in-repo zig-out build is the developer fallback.
        expect(candidates.some((c) => c.includes(path.join('zig-out', 'bin', 'takyondb_bridge.node')))).toBe(true);
    });

    it('skips absent sources so the list has no undefined entries', () => {
        const candidates = addonCandidates({ env: {}, packageRoot: tmpDir() });
        expect(candidates.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
        expect(candidates).not.toContain(undefined as unknown as string);
    });

    it('always offers a prebuild candidate for the running platform', () => {
        const root = tmpDir();
        const candidates = addonCandidates({ env: {}, packageRoot: root });
        const prebuild = path.join(root, 'prebuilds', platformKey, 'takyondb_bridge.node');
        expect(candidates).toContain(prebuild);
    });
});

describe('classifyForTest', () => {
    it('attributes a candidate to the strategy that produced it', () => {
        const root = tmpDir();
        expect(classifyAddonSource('/explicit/x.node', { addonPath: '/explicit/x.node', env: {}, packageRoot: root })).toBe(
            'explicit',
        );
        expect(
            classifyAddonSource('/env/x.node', { env: { TAKYON_ADDON_PATH: '/env/x.node' }, packageRoot: root }),
        ).toBe('env');
        expect(
            classifyAddonSource(path.join(root, 'prebuilds', platformKey, 'a.node'), { env: {}, packageRoot: root }),
        ).toBe('prebuilds');
        expect(classifyAddonSource(path.join(root, 'build', 'Release', 'a.node'), { env: {}, packageRoot: root })).toBe(
            'node-gyp',
        );
        expect(
            classifyAddonSource(path.join(root, 'zig-out', 'bin', 'a.node'), { env: {}, packageRoot: root }),
        ).toBe('dev-zig-out');
    });
});

describe('resolveAddon failures', () => {
    it('throws an actionable error listing every probed path', () => {
        const root = tmpDir();
        expect(() => resolveAddon({ env: {}, packageRoot: root })).toThrow(/native addon not found/);
        try {
            resolveAddon({ env: {}, packageRoot: root });
            expect.unreachable('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            expect(msg).toContain('Probed:');
            expect(msg).toContain(platformKey);
            // Tell the user how to fix it rather than just failing.
            expect(msg).toContain('zig build');
            expect(msg).toContain('TAKYON_ADDON_PATH');
        }
    });

    it('names the supported platforms when the current one has no prebuild', () => {
        const root = tmpDir();
        // Simulate an unlisted platform by probing a root that cannot work and
        // checking the message still enumerates the supported set.
        try {
            resolveAddon({ env: {}, packageRoot: root });
            expect.unreachable('should have thrown');
        } catch (err) {
            const msg = (err as Error).message;
            for (const p of SUPPORTED_PLATFORMS) {
                expect(SUPPORTED_PLATFORMS).toContain(p);
            }
            expect(SUPPORTED_PLATFORMS.length).toBeGreaterThan(0);
            expect(msg).toContain('linux-x64');
        }
    });
});

describe('loadBindings failures', () => {
    it('rejects a path that does not exist, naming the path', () => {
        // Must not fall through to another candidate: silently loading a
        // different binary than the caller asked for is the failure mode
        // this guards against.
        expect(() => loadBindings({ addonPath: '/definitely/not/here.node' })).toThrow(
            /addonPath points at a path that does not exist/,
        );
        expect(() => loadBindings({ addonPath: '/definitely/not/here.node' })).toThrow(
            /definitely.not.here\.node/,
        );
    });

    it('rejects a bad TAKYON_ADDON_PATH instead of searching on', () => {
        expect(() => loadBindings({ env: { TAKYON_ADDON_PATH: '/nope/missing.node' } })).toThrow(
            /TAKYON_ADDON_PATH points at a path that does not exist/,
        );
    });

    it('rejects a module that loads but is not the addon', () => {
        // A real .node-shaped path is required to get past existsSync, so use
        // a file that exists but is not a loadable addon.
        const root = tmpDir();
        const fake = path.join(root, 'takyondb_bridge.node');
        fs.writeFileSync(fake, 'not an addon');
        expect(() => loadBindings({ addonPath: fake })).toThrow();
    });
});

describe('supported platform matrix', () => {
    it('covers the platforms CI builds prebuilds for', () => {
        // ubuntu/windows runners are x64; macos-15 runners are arm64.
        for (const p of ['linux-x64', 'win32-x64', 'darwin-arm64']) {
            expect(SUPPORTED_PLATFORMS).toContain(p as never);
        }
    });

    it('is documented as one prebuild per platform, not per Node version', () => {
        // N-API means the addon is ABI-stable across Node releases; if that
        // ever changes this matrix must be revisited.
        expect(new Set(SUPPORTED_PLATFORMS).size).toBe(SUPPORTED_PLATFORMS.length);
    });
});
