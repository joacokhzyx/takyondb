// ============================================================================
// File: filter.zig
// Description: Predicate operators and zero-alloc row matching.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Comparison operators for scan filters.
pub const CmpOp = enum(u8) {
    Eq = 0,
    Ne = 1,
    Gt = 2,
    Gte = 3,
    Lt = 4,
    Lte = 5,
};

/// Matches int64 values (covers bool/int/timestamp fast paths).
pub fn matchInt(value: i64, op: CmpOp, target: i64) bool {
    return switch (op) {
        .Eq => value == target,
        .Ne => value != target,
        .Gt => value > target,
        .Gte => value >= target,
        .Lt => value < target,
        .Lte => value <= target,
    };
}

/// Matches float64 values.
pub fn matchFloat(value: f64, op: CmpOp, target: f64) bool {
    return switch (op) {
        .Eq => value == target,
        .Ne => value != target,
        .Gt => value > target,
        .Gte => value >= target,
        .Lt => value < target,
        .Lte => value <= target,
    };
}

test "filter int comparisons" {
    try std.testing.expect(matchInt(20, .Eq, 20));
    try std.testing.expect(!matchInt(20, .Gte, 21));
    try std.testing.expect(matchInt(30, .Gt, 20));
}

test "filter float comparisons" {
    try std.testing.expect(matchFloat(1.5, .Lt, 2.0));
    try std.testing.expect(!matchFloat(1.5, .Eq, 1.6));
}
