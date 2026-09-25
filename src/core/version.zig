// ============================================================================
// File: version.zig
// Description: Single source of truth for the TakyonDB version string.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================
//
// Why this file exists: the version used to be hardcoded in five unrelated
// places (the npm `package.json` said 0.1.0 while the Debian, macOS and
// Windows packagers and the historical v1.0.0 git tag all said 1.0.0), so a
// release could not be cut without manually syncing them.
//
// `src/sdk/ts/package.json` is the canonical value for the SDK/release
// pipeline. This constant is the canonical value for the Zig artifacts. They
// are two languages, so they cannot literally share one file, but
// `scripts/check_version.js` fails CI when they drift — that is what makes
// "one source of truth" true in practice rather than aspirational.

/// SDK version. Keep in sync with src/sdk/ts/package.json (enforced by
/// scripts/check_version.js in CI).
pub const version = "0.1.0";

/// Short product name, used in `--version` / `--help` output.
pub const name = "TakyonDB";

const std = @import("std");

test "version matches the semver shape the release pipeline expects" {
    // No 'v' prefix, three dot-separated numeric components.
    var parts = std.mem.splitScalar(u8, version, '.');
    var count: usize = 0;
    while (parts.next()) |part| {
        count += 1;
        for (part) |c| try std.testing.expect(std.ascii.isDigit(c));
        try std.testing.expect(part.len > 0);
    }
    try std.testing.expectEqual(@as(usize, 3), count);
}
