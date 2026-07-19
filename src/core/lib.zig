// ============================================================================
// File: lib.zig
// Description: Root module for the TakyonDB dynamic library.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

comptime {
    _ = @import("c_abi/exports.zig");
}

pub const shm = @import("memory/shm.zig");
pub const ring_buffer = @import("ipc/ring_buffer.zig");
pub const wal = @import("storage/wal.zig");
pub const recovery = @import("storage/recovery.zig");
pub const art = @import("index/art.zig");
