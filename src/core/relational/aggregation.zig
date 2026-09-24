// ============================================================================
// File: aggregation.zig
// Description: Single-pass aggregations over column values.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Aggregation functions.
pub const AggFn = enum(u8) {
    Count = 0,
    Sum = 1,
    Avg = 2,
    Min = 3,
    Max = 4,
};

/// Accumulator for streaming aggregation (Kahan-friendly for f64 later).
pub const Acc = struct {
    count: usize = 0,
    sum: f64 = 0,
    min: f64 = std.math.inf(f64),
    max: f64 = -std.math.inf(f64),

    pub fn add(self: *Acc, v: f64) void {
        self.count += 1;
        self.sum += v;
        if (v < self.min) self.min = v;
        if (v > self.max) self.max = v;
    }

    pub fn result(self: *const Acc, fn_kind: AggFn) f64 {
        return switch (fn_kind) {
            .Count => @floatFromInt(self.count),
            .Sum => self.sum,
            .Avg => if (self.count == 0) 0 else self.sum / @as(f64, @floatFromInt(self.count)),
            .Min => if (self.count == 0) 0 else self.min,
            .Max => if (self.count == 0) 0 else self.max,
        };
    }
};

test "aggregation accumulator" {
    var a = Acc{};
    a.add(10);
    a.add(20);
    try std.testing.expectEqual(@as(f64, 30), a.result(.Sum));
    try std.testing.expectEqual(@as(f64, 15), a.result(.Avg));
    try std.testing.expectEqual(@as(f64, 10), a.result(.Min));
    try std.testing.expectEqual(@as(f64, 20), a.result(.Max));
    try std.testing.expectEqual(@as(f64, 2), a.result(.Count));
}
