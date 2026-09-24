// ============================================================================
// File: executor.zig
// Description: Plan execution limits and result windowing.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Maximum rows a single executor call returns (backpressure).
pub const MAX_RESULT_ROWS: usize = 10_000;

/// Clamps a requested limit to the executor maximum.
pub fn clampLimit(requested: usize) usize {
    return @min(requested, MAX_RESULT_ROWS);
}

test "executor clamps limits" {
    try std.testing.expectEqual(@as(usize, 10), clampLimit(10));
    try std.testing.expectEqual(MAX_RESULT_ROWS, clampLimit(1_000_000));
}
