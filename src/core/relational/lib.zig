// ============================================================================
// File: lib.zig
// Description: Barrel for the relational core modules.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

pub const rtypes = @import("types.zig");
pub const catalog = @import("catalog.zig");
pub const row = @import("row.zig");
pub const rfilter = @import("filter.zig");
pub const aggregation = @import("aggregation.zig");
pub const scan = @import("scan.zig");
pub const query = @import("query.zig");
pub const join = @import("join.zig");
pub const tx = @import("tx.zig");
pub const index = @import("index.zig");
pub const persist = @import("persist.zig");
pub const sql = @import("sql.zig");
pub const executor = @import("executor.zig");
pub const column = @import("column.zig");
