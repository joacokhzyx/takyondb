// ============================================================================
// File: query.zig
// Description: Query plan nodes for filter, projection, limit.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Plan node kinds (phase 1: in-memory execution descriptors).
pub const PlanKind = enum(u8) {
    SeqScan = 0,
    Filter = 1,
    Project = 2,
    Limit = 3,
};

/// Limit parameters with validation.
pub const LimitSpec = struct {
    limit: usize,
    offset: usize = 0,

    pub fn applyLen(self: LimitSpec, total: usize) usize {
        if (self.offset >= total) return 0;
        const rest = total - self.offset;
        return @min(rest, self.limit);
    }
};

test "limit spec clamps ranges" {
    const l = LimitSpec{ .limit = 10, .offset = 5 };
    try std.testing.expectEqual(@as(usize, 5), l.applyLen(10));
    try std.testing.expectEqual(@as(usize, 0), l.applyLen(3));
}
