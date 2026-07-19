// ============================================================================
// File: test.zig
// Description: Cintralized test aggregator for all TakyonDB core modules.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

comptime {
    _ = @import("memory/shm.zig");
    _ = @import("ipc/ring_buffer.zig");
    _ = @import("storage/wal.zig");
    _ = @import("c_abi/exports.zig");
}
