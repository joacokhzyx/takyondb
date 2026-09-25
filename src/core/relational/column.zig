// ============================================================================
// File: column.zig
// Description: Vectorized column kernels for predicate pushdown.
//   Filters compare 8 lanes per instruction and emit dense index runs
//   (selection vectors); sums use Kahan compensation. All operate on
//   borrowed zero-copy slices with no allocation and no NaN special
//   casing (NaN never matches Eq, always matches Ne — IEEE semantics).
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const rfilter = @import("filter.zig");

/// Lanes per SIMD step for 32-bit columns.
pub const LANES_32: usize = 8;

/// Writes indices `i` with `values[i] <op> target` into `out` (dense run).
/// Returns the count written (capped by `out.len`). Pure and allocation-free.
pub fn filterU32(values: []const u32, op: rfilter.CmpOp, target: u32, out: []u32) usize {
    var n: usize = 0;
    var i: usize = 0;
    const top = (values.len / LANES_32) * LANES_32;
    const splat: @Vector(LANES_32, u32) = @splat(target);
    while (i < top and n < out.len) : (i += LANES_32) {
        const v: @Vector(LANES_32, u32) = values[i..][0..LANES_32].*;
        const mask: @Vector(LANES_32, bool) = switch (op) {
            .Eq => v == splat,
            .Ne => v != splat,
            .Gt => v > splat,
            .Gte => v >= splat,
            .Lt => v < splat,
            .Lte => v <= splat,
        };
        var lane: usize = 0;
        while (lane < LANES_32 and n < out.len) : (lane += 1) {
            if (mask[lane]) {
                out[n] = @intCast(i + lane);
                n += 1;
            }
        }
    }
    while (i < values.len and n < out.len) : (i += 1) {
        const match = switch (op) {
            .Eq => values[i] == target,
            .Ne => values[i] != target,
            .Gt => values[i] > target,
            .Gte => values[i] >= target,
            .Lt => values[i] < target,
            .Lte => values[i] <= target,
        };
        if (match) {
            out[n] = @intCast(i);
            n += 1;
        }
    }
    return n;
}

/// Writes indices `i` with `values[i] <op> target` into `out` (dense run).
/// f64 variant (scalar; NaN never matches Eq, always matches Ne).
pub fn filterF64(values: []const f64, op: rfilter.CmpOp, target: f64, out: []u32) usize {
    var n: usize = 0;
    var i: usize = 0;
    while (i < values.len and n < out.len) : (i += 1) {
        const v = values[i];
        const match = switch (op) {
            .Eq => v == target,
            .Ne => v != target,
            .Gt => v > target,
            .Gte => v >= target,
            .Lt => v < target,
            .Lte => v <= target,
        };
        if (match) {
            out[n] = @intCast(i);
            n += 1;
        }
    }
    return n;
}

/// Kahan-compensated sum over a selection vector (no allocation).
/// `sel[0..sel_len]` holds indices into `values`; out-of-bounds entries stop the scan.
pub fn kahanSumSelected(values: []const f64, sel: []const u32, sel_len: usize) f64 {
    var sum: f64 = 0;
    var c: f64 = 0;
    const n = @min(sel_len, sel.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const idx: usize = sel[i];
        if (idx >= values.len) break;
        const v = values[idx];
        const y = v - c;
        const t = sum + y;
        c = (t - sum) - y;
        sum = t;
    }
    return sum;
}

/// Min over a selection vector; 0 when empty (matches TS aggregate()).
pub fn minSelected(values: []const f64, sel: []const u32, sel_len: usize) f64 {
    const n = @min(sel_len, sel.len);
    var i: usize = 0;
    // Skip out-of-bounds leading entries.
    while (i < n) : (i += 1) {
        const idx: usize = sel[i];
        if (idx < values.len) break;
    }
    if (i >= n) return 0;
    var m = values[sel[i]];
    i += 1;
    while (i < n) : (i += 1) {
        const idx: usize = sel[i];
        if (idx >= values.len) break;
        if (values[idx] < m) m = values[idx];
    }
    return m;
}

/// Max over a selection vector; 0 when empty (matches TS aggregate()).
pub fn maxSelected(values: []const f64, sel: []const u32, sel_len: usize) f64 {
    const n = @min(sel_len, sel.len);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const idx: usize = sel[i];
        if (idx < values.len) break;
    }
    if (i >= n) return 0;
    var m = values[sel[i]];
    i += 1;
    while (i < n) : (i += 1) {
        const idx: usize = sel[i];
        if (idx >= values.len) break;
        if (values[idx] > m) m = values[idx];
    }
    return m;
}

/// Kahan-compensated sum over a borrowed slice (no allocation).
pub fn kahanSum(values: []const f64) f64 {
    var sum: f64 = 0;
    var c: f64 = 0;
    for (values) |v| {
        const y = v - c;
        const t = sum + y;
        c = (t - sum) - y;
        sum = t;
    }
    return sum;
}

test "column filterU32 covers all operators" {
    const vals = [_]u32{ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };
    var out: [12]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 1), filterU32(&vals, .Eq, 5, out[0..]));
    try std.testing.expectEqual(@as(u32, 4), out[0]);
    try std.testing.expectEqual(@as(usize, 11), filterU32(&vals, .Ne, 5, out[0..]));
    try std.testing.expectEqual(@as(usize, 2), filterU32(&vals, .Gt, 10, out[0..]));
    try std.testing.expectEqual(@as(usize, 3), filterU32(&vals, .Gte, 10, out[0..]));
    try std.testing.expectEqual(@as(usize, 1), filterU32(&vals, .Lt, 2, out[0..]));
    try std.testing.expectEqual(@as(usize, 2), filterU32(&vals, .Lte, 2, out[0..]));
}

test "column filterU32 truncates and handles edges" {
    const vals = [_]u32{ 7, 7, 7, 7, 7, 7, 7, 7, 7 };
    var tiny: [3]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 3), filterU32(&vals, .Eq, 7, tiny[0..]));
    try std.testing.expectEqual(@as(usize, 0), filterU32(&vals, .Eq, 8, tiny[0..]));
    try std.testing.expectEqual(@as(usize, 0), filterU32(&[_]u32{}, .Eq, 7, tiny[0..]));
    try std.testing.expectEqual(@as(usize, 0), filterU32(&vals, .Eq, 7, tiny[0..0]));
    // Non-multiple-of-8 length exercises the scalar tail.
    const odd = [_]u32{ 1, 2, 3, 4, 5, 6, 7, 8, 9 };
    var out: [9]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 1), filterU32(&odd, .Eq, 9, out[0..]));
    try std.testing.expectEqual(@as(u32, 8), out[0]);
}

test "column filterF64 covers all operators" {
    const vals = [_]f64{ 1.5, 2.5, 3.5, 4.5 };
    var out: [4]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 1), filterF64(&vals, .Eq, 2.5, out[0..]));
    try std.testing.expectEqual(@as(u32, 1), out[0]);
    try std.testing.expectEqual(@as(usize, 3), filterF64(&vals, .Ne, 2.5, out[0..]));
    try std.testing.expectEqual(@as(usize, 2), filterF64(&vals, .Gt, 2.5, out[0..]));
    try std.testing.expectEqual(@as(usize, 1), filterF64(&vals, .Lt, 2.0, out[0..]));
    // NaN semantics: never Eq, always Ne.
    const nan = std.math.nan(f64);
    const with_nan = [_]f64{ nan, 1.0 };
    try std.testing.expectEqual(@as(usize, 0), filterF64(&with_nan, .Eq, nan, out[0..]));
    try std.testing.expectEqual(@as(usize, 2), filterF64(&with_nan, .Ne, nan, out[0..]));
}

test "column selected aggs match full-slice semantics" {
    const vals = [_]f64{ 10.0, 20.0, 30.0, 40.0 };
    const sel_all = [_]u32{ 0, 1, 2, 3 };
    try std.testing.expectEqual(@as(f64, 100.0), kahanSumSelected(&vals, &sel_all, 4));
    try std.testing.expectEqual(@as(f64, 10.0), minSelected(&vals, &sel_all, 4));
    try std.testing.expectEqual(@as(f64, 40.0), maxSelected(&vals, &sel_all, 4));
    const sel_some = [_]u32{ 1, 3 };
    try std.testing.expectEqual(@as(f64, 60.0), kahanSumSelected(&vals, &sel_some, 2));
    try std.testing.expectEqual(@as(f64, 20.0), minSelected(&vals, &sel_some, 2));
    try std.testing.expectEqual(@as(f64, 40.0), maxSelected(&vals, &sel_some, 2));
    // Empty selection mirrors TS aggregate(): 0.
    try std.testing.expectEqual(@as(f64, 0), kahanSumSelected(&vals, &sel_all, 0));
    try std.testing.expectEqual(@as(f64, 0), minSelected(&vals, &sel_all, 0));
    try std.testing.expectEqual(@as(f64, 0), maxSelected(&vals, &sel_all, 0));
    // Out-of-bounds entries stop the scan.
    const sel_oob = [_]u32{ 0, 99, 1 };
    try std.testing.expectEqual(@as(f64, 10.0), kahanSumSelected(&vals, &sel_oob, 3));
}

test "column kahanSum keeps small addends" {
    var vals: [11]f64 = undefined;
    vals[0] = 1e16;
    var i: usize = 1;
    while (i < vals.len) : (i += 1) {
        vals[i] = 1.0;
    }
    var naive: f64 = 0;
    for (vals) |v| naive += v;
    try std.testing.expect(naive != 10000000000000010.0);
    try std.testing.expectEqual(@as(f64, 10000000000000010.0), kahanSum(&vals));
    try std.testing.expectEqual(@as(f64, 0), kahanSum(&[_]f64{}));
}
