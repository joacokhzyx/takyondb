// ============================================================================
// File: types.zig
// Description: Relational physical types reusing zero-copy arena layout.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Physical column types. Fixed types map to 1/2/4/8B LE; variable types
/// use an 8B fat pointer (u32 offset + u32 len) in the string arena.
pub const RelationalType = enum(u8) {
    Bool = 0,
    Int8 = 1,
    Int16 = 2,
    Int32 = 3,
    Int64 = 4,
    Uint8 = 5,
    Uint16 = 6,
    Uint32 = 7,
    Float32 = 8,
    Float64 = 9,
    String = 10,
    Bytes = 11,
    TimestampMs = 12,
};

/// Byte size of the fixed encoding, or 8 for fat pointers.
pub fn typeSize(t: RelationalType) usize {
    return switch (t) {
        .Bool, .Int8, .Uint8 => 1,
        .Int16, .Uint16 => 2,
        .Int32, .Uint32, .Float32 => 4,
        .Int64, .Float64, .TimestampMs => 8,
        .String, .Bytes => 8,
    };
}

/// True for variable-length types stored via fat pointer.
pub fn isVariable(t: RelationalType) bool {
    return t == .String or t == .Bytes;
}

test "relational types sizes" {
    try std.testing.expectEqual(@as(usize, 1), typeSize(.Bool));
    try std.testing.expectEqual(@as(usize, 4), typeSize(.Int32));
    try std.testing.expectEqual(@as(usize, 8), typeSize(.Float64));
    try std.testing.expectEqual(@as(usize, 8), typeSize(.String));
    try std.testing.expect(isVariable(.String));
    try std.testing.expect(!isVariable(.Uint32));
}
