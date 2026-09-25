'use strict';

// Single resolution point for the N-API addon inside the E2E/bench scripts.
//
// The same literal path ('../zig-out/bin/takyondb_bridge.node') was
// copy-pasted into thirteen scripts. This delegates to the SDK's own loader
// so there is one search algorithm, and falls back to the in-repo zig-out
// build when the SDK dist has not been built yet (some suites do not need
// it, and requiring a build step to run one suite would be a regression).
//
// Scripts in the published package should use `loadBindings()` from
// 'takyondb' instead; this exists for the repo's own harnesses.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SDK_ADDON = path.join(REPO_ROOT, 'src', 'sdk', 'ts', 'dist', 'client', 'addon');
const ZIG_OUT_ADDON = path.join(REPO_ROOT, 'zig-out', 'bin', 'takyondb_bridge.node');

function loadBindings() {
    if (fs.existsSync(`${SDK_ADDON}.js`)) {
        // Same code path a published consumer takes, prebuilds included.
        return require(SDK_ADDON).loadBindings();
    }
    if (!fs.existsSync(ZIG_OUT_ADDON)) {
        throw new Error(
            `TakyonDB addon not found.\n` +
                `Looked for the built SDK loader (${SDK_ADDON}.js) and ${ZIG_OUT_ADDON}.\n` +
                `Build both with: zig build -Doptimize=ReleaseSafe && npm --prefix src/sdk/ts run build`
        );
    }
    return require(ZIG_OUT_ADDON);
}

module.exports = { loadBindings, REPO_ROOT, ZIG_OUT_ADDON };
