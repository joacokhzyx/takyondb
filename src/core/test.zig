// ============================================================================
// File: test.zig
// Description: Cintralized test aggregator for all TakyonDB core modules.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================

comptime {
    _ = @import("memory/shm.zig");
    _ = @import("memory/layout.zig");
    _ = @import("memory/vacuum.zig");
    _ = @import("memory/record_crc.zig");
    _ = @import("memory/scrub.zig");
    _ = @import("ipc/ring_buffer.zig");
    _ = @import("index/art.zig");
    _ = @import("storage/wal.zig");
    _ = @import("storage/snapshot.zig");
    _ = @import("storage/recovery.zig");
    _ = @import("relational/types.zig");
    _ = @import("relational/catalog.zig");
    _ = @import("relational/row.zig");
    _ = @import("relational/filter.zig");
    _ = @import("relational/aggregation.zig");
    _ = @import("relational/scan.zig");
    _ = @import("relational/query.zig");
    _ = @import("relational/join.zig");
    _ = @import("relational/tx.zig");
    _ = @import("relational/index.zig");
    _ = @import("relational/multiroot.zig");
    _ = @import("relational/persist.zig");
    _ = @import("relational/sql.zig");
    _ = @import("relational/executor.zig");
    _ = @import("relational/column.zig");
    _ = @import("c_abi/exports.zig");
}
