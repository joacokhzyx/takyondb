// ============================================================================
// File: fuzz_surface.zig
// Description: Deterministic sweep over the C-ABI surface (no std fuzz in
//   this toolchain). Xorshift-generated offsets/sizes/keys/ops must never
//   panic: engine-gated entrypoints return -1 while down, pure kernels
//   validate pointers and bounds. Catches validation gaps that unit tests
//   with hand-picked values miss.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const exports = @import("exports.zig");

fn xorshift(state: *u64) u64 {
    var x = state.*;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    state.* = x;
    return x;
}

test "fuzz engine-gated entrypoints never panic while down" {
    // While the engine is down every gated call must fail closed (-1),
    // never panic on arbitrary offsets/sizes. (No unit test connects the
    // engine, so arena_ready is false here.)
    var rng: u64 = 0x123456789ABCDEF;
    var keybuf: [300]u8 = undefined;
    for (&keybuf) |*b| b.* = 0xAA;
    var scratch: [64]u8 = undefined;
    for (&scratch) |*b| b.* = 0xAA;
    var i: usize = 0;
    while (i < 2000) : (i += 1) {
        const r = xorshift(&rng);
        const off: u32 = @truncate(r >> 17);
        const size: u32 = @truncate((r >> 3) % 80);
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_write_delta(off, size, &scratch));
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_notify_arena(off, size));
        const keylen: u32 = @truncate(r % 300);
        var out: [4]u32 = undefined;
        // keylen == 0 is rejected; keylen > 256 is rejected; else -1 (down).
        const rc = exports.takyon_scan_prefix(&keybuf, keylen, &out, 4);
        try std.testing.expect(rc == -1 or rc >= 0);
        const rrc = exports.takyon_remove_index(&keybuf, if (keylen == 0) @as(u32, 1) else keylen);
        try std.testing.expect(rrc == -1 or rrc == 0 or rrc == 1);
    }
}

test "shm names resolve to OS form with validation" {
    var buf: [128]u8 = undefined;
    // Null, empty, and legacy sentinel all mean the default segment.
    try std.testing.expectEqualStrings(if (@import("builtin").os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master", try exports.resolveShmName(null, &buf));
    try std.testing.expectEqualStrings(if (@import("builtin").os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master", try exports.resolveShmName("", &buf));
    try std.testing.expectEqualStrings(if (@import("builtin").os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master", try exports.resolveShmName("shm://local", &buf));
    // Custom basenames pass through with the OS prefix.
    const custom = try exports.resolveShmName("tenant-a.db1", &buf);
    if (@import("builtin").os.tag == .windows) {
        try std.testing.expectEqualStrings("Local\\tenant-a.db1", custom);
    } else {
        try std.testing.expectEqualStrings("/tenant-a.db1", custom);
    }
    // Bad names fail closed: separators, slashes, spaces, NUL-hostile bytes.
    try std.testing.expectError(error.InvalidSchema, exports.resolveShmName("a/b", &buf));
    try std.testing.expectError(error.InvalidSchema, exports.resolveShmName("a b", &buf));
    try std.testing.expectError(error.InvalidSchema, exports.resolveShmName("a:b", &buf));
    var long: [66]u8 = [_]u8{'x'} ** 66;
    long[65] = 0;
    try std.testing.expectError(error.InvalidSchema, exports.resolveShmName(long[0..65 :0], &buf));
}

test "fuzz pure kernels validate bounds" {
    var rng: u64 = 0xFEDCBA987654321;
    var vals: [64]u32 = undefined;
    var fvals: [64]f64 = undefined;
    for (&vals, 0..) |*v, k| v.* = @truncate(k * 2654435761);
    for (&fvals, 0..) |*v, k| v.* = @as(f64, @floatFromInt(k)) * 1.5;
    var out: [64]u32 = undefined;
    var i: usize = 0;
    while (i < 1000) : (i += 1) {
        const r = xorshift(&rng);
        const len: u32 = @truncate(r % 40); // always within the 64-slot buffers
        const op: u8 = @truncate((r >> 8) % 8); // 6..7 are invalid
        const rc_u = exports.takyon_filter_u32(&vals, len, op, 7, &out, 64);
        if (op > 5) {
            try std.testing.expectEqual(@as(i32, -1), rc_u);
        } else {
            try std.testing.expect(rc_u >= 0 and rc_u <= 40);
        }
        const rc_f = exports.takyon_filter_f64(&fvals, len, op, 7.5, &out, 64);
        if (op > 5) {
            try std.testing.expectEqual(@as(i32, -1), rc_f);
        } else {
            try std.testing.expect(rc_f >= 0 and rc_f <= 40);
        }
        // Null pointers fail closed.
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_filter_u32(null, 4, 0, 7, &out, 64));
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_filter_u32(&vals, 4, 0, 7, null, 64));
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_verify_record(null, 10));
        const val_bytes: [*]const u8 = @ptrCast(&vals);
        try std.testing.expectEqual(@as(i32, -1), exports.takyon_verify_record(val_bytes, 0));
    }
}
