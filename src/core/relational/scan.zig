// ============================================================================
// File: scan.zig
// Description: Zero-copy scan cursors over record ranges.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Scan cursor over a contiguous offset list (offsets into SharedArena).
pub const ScanCursor = struct {
    offsets: []const u32,
    pos: usize = 0,

    pub fn next(self: *ScanCursor) ?u32 {
        if (self.pos >= self.offsets.len) return null;
        const v = self.offsets[self.pos];
        self.pos += 1;
        return v;
    }

    pub fn reset(self: *ScanCursor) void {
        self.pos = 0;
    }
};

test "scan cursor iterates offsets" {
    const list = [_]u32{ 10, 20, 30 };
    var c = ScanCursor{ .offsets = &list };
    try std.testing.expectEqual(@as(?u32, 10), c.next());
    try std.testing.expectEqual(@as(?u32, 20), c.next());
    try std.testing.expectEqual(@as(?u32, 30), c.next());
    try std.testing.expectEqual(@as(?u32, null), c.next());
}
