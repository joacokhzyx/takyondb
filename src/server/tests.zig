// ============================================================================
// File: tests.zig
// Description: Test aggregator for the server module. The daemon's own
//   startup, arguments and signal handling are what `scripts/run-e2e.js`
//   exercises against a live process; what is testable in isolation lives
//   in the modules this file pulls in.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

comptime {
    _ = @import("config.zig");
}
