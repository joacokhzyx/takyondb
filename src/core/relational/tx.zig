// ============================================================================
// File: tx.zig
// Description: Logical batch transaction markers for WAL grouping.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Transaction state machine (phase 1 logical, phase 2 WAL markers).
pub const TxState = enum(u8) {
    Active = 0,
    Committing = 1,
    Committed = 2,
    Aborted = 3,
};

/// Batch descriptor with op count and state.
pub const TxBatch = struct {
    state: TxState = .Active,
    op_count: usize = 0,

    pub fn add(self: *TxBatch) void {
        self.op_count += 1;
    }

    pub fn commit(self: *TxBatch) void {
        self.state = .Committed;
    }

    pub fn abort(self: *TxBatch) void {
        self.state = .Aborted;
        self.op_count = 0;
    }
};

test "tx batch commits and aborts" {
    var b = TxBatch{};
    b.add();
    b.add();
    try std.testing.expectEqual(@as(usize, 2), b.op_count);
    b.commit();
    try std.testing.expect(b.state == .Committed);
    var c = TxBatch{};
    c.add();
    c.abort();
    try std.testing.expect(c.state == .Aborted);
    try std.testing.expectEqual(@as(usize, 0), c.op_count);
}
