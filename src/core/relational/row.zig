// ============================================================================
// File: row.zig
// Description: Physical row header with null bitmap and field accessors.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Row magic and version for the fixed header.
pub const ROW_MAGIC: u32 = 0x54524F57; // "TROW"
pub const ROW_VERSION: u16 = 1;

/// Null bitmap lives at offset 0 (u32 LE, 1 bit per column, 1 = NULL).
pub fn setNull(bitmap: *u32, index: usize) void {
    bitmap.* |= @as(u32, 1) << @intCast(index % 32);
}

pub fn clearNull(bitmap: *u32, index: usize) void {
    bitmap.* &= ~(@as(u32, 1) << @intCast(index % 32));
}

pub fn isNull(bitmap: u32, index: usize) bool {
    return (bitmap & (@as(u32, 1) << @intCast(index % 32))) != 0;
}

test "row null bitmap round-trips" {
    var b: u32 = 0;
    setNull(&b, 3);
    try std.testing.expect(isNull(b, 3));
    try std.testing.expect(!isNull(b, 2));
    clearNull(&b, 3);
    try std.testing.expect(!isNull(b, 3));
}
