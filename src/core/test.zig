// ============================================================================
// File: test.zig
// Description: Cintralized test aggregator for all TakyonDB core modules.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================

comptime {
    _ = @import("memory/shm.zig");
    _ = @import("memory/layout.zig");
    _ = @import("ipc/ring_buffer.zig");
    _ = @import("index/art.zig");
    _ = @import("storage/wal.zig");
    _ = @import("storage/recovery.zig");
    _ = @import("c_abi/exports.zig");
}
