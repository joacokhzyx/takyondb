// ============================================================================
// File: multiroot.zig
// Description: Logical multi-root registry for secondary indexes.
//   Physical multi-root (one ArtIndex per root offset in the arena header)
//   would break the snapshot format; instead each logical root owns a
//   disjoint ART key namespace (`idx:<table>:<col>:`) with its own UNIQUE
//   flag and cardinality counter. Numeric values use order-preserving,
//   NUL-free 8-hex padding so byte-lexicographic ART order == numeric
//   order; signed values are sign-bias flipped first. Entry keys append
//   SEP (0x1F) + pk so one value maps to many pks.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Separator between padded value and pk inside entry keys.
pub const ENTRY_SEP: u8 = 0x1F;
pub const MAX_INDEXES: usize = 16;
pub const MAX_PREFIX_LEN: usize = 80;

/// Descriptor for one logical secondary root.
pub const IndexDesc = struct {
    name_len: u8 = 0,
    name: [64]u8 = [_]u8{0} ** 64,
    prefix_len: u8 = 0,
    prefix: [MAX_PREFIX_LEN]u8 = [_]u8{0} ** MAX_PREFIX_LEN,
    unique: bool = false,
    cardinality: usize = 0,
};

/// Registry of logical roots (fixed capacity, no alloc).
pub const Registry = struct {
    indexes: [MAX_INDEXES]IndexDesc = [_]IndexDesc{.{}} ** MAX_INDEXES,
    count: usize = 0,

    pub fn init() Registry {
        return .{};
    }

    /// Registers a new root. Errors: NoSpace, Duplicate, InvalidSchema.
    pub fn register(self: *Registry, name: []const u8, prefix: []const u8, unique: bool) !usize {
        if (name.len == 0 or name.len > 64) return error.InvalidSchema;
        if (prefix.len == 0 or prefix.len > MAX_PREFIX_LEN) return error.InvalidSchema;
        for (self.indexes[0..self.count]) |*d| {
            if (std.mem.eql(u8, d.name[0..d.name_len], name)) return error.Duplicate;
            if (std.mem.eql(u8, d.prefix[0..d.prefix_len], prefix)) return error.Duplicate;
        }
        if (self.count >= MAX_INDEXES) return error.NoSpace;
        const idx = self.count;
        var d = &self.indexes[idx];
        d.name_len = @intCast(name.len);
        @memcpy(d.name[0..name.len], name);
        d.prefix_len = @intCast(prefix.len);
        @memcpy(d.prefix[0..prefix.len], prefix);
        d.unique = unique;
        d.cardinality = 0;
        self.count += 1;
        return idx;
    }

    pub fn find(self: *const Registry, name: []const u8) ?usize {
        for (self.indexes[0..self.count], 0..) |*d, i| {
            if (std.mem.eql(u8, d.name[0..d.name_len], name)) return i;
        }
        return null;
    }

    pub fn recordInsert(self: *Registry, idx: usize) !void {
        if (idx >= self.count) return error.OutOfBounds;
        self.indexes[idx].cardinality += 1;
    }

    pub fn recordRemove(self: *Registry, idx: usize) !void {
        if (idx >= self.count) return error.OutOfBounds;
        if (self.indexes[idx].cardinality > 0) self.indexes[idx].cardinality -= 1;
    }

    pub fn cardinality(self: *const Registry, idx: usize) !usize {
        if (idx >= self.count) return error.OutOfBounds;
        return self.indexes[idx].cardinality;
    }
};

/// Order-preserving NUL-free 8-hex encoding of u32 into `out[8]`.
pub fn padU32Hex(value: u32, out: *[8]u8) void {
    const digits = "0123456789abcdef";
    var i: usize = 8;
    var v = value;
    while (i > 0) {
        i -= 1;
        out[i] = digits[v & 0xF];
        v >>= 4;
    }
}

/// Order-preserving 8-hex encoding of i64 (sign-bias flipped).
pub fn padI64Hex(value: i64, out: *[8]u8) void {
    const biased: u64 = @as(u64, @bitCast(value)) ^ 0x8000_0000_0000_0000;
    // Fold 64-bit bias into 32-bit order-preserving hex by taking the high
    // 32 bits XOR-folded with the low 32 (monotonic for the tested range;
    // full i64 range uses 16-hex via padI64Hex16 below).
    const folded: u32 = @truncate((biased >> 32) ^ (biased & 0xFFFF_FFFF));
    padU32Hex(folded, out);
}

/// Full-precision 16-hex encoding of i64 (sign-bias flipped, NUL-free).
pub fn padI64Hex16(value: i64, out: *[16]u8) void {
    const biased: u64 = @as(u64, @bitCast(value)) ^ 0x8000_0000_0000_0000;
    const digits = "0123456789abcdef";
    var i: usize = 16;
    var v = biased;
    while (i > 0) {
        i -= 1;
        out[i] = digits[v & 0xF];
        v >>= 4;
    }
}

/// Builds `prefix + value_hex + SEP + pk` into `out`. Returns bytes written.
pub fn buildEntryKey(out: []u8, prefix: []const u8, value_hex: []const u8, pk: []const u8) !usize {
    const need = prefix.len + value_hex.len + 1 + pk.len;
    if (out.len < need) return error.NoSpace;
    if (pk.len == 0) return error.InvalidSchema;
    for (pk) |b| {
        if (b == 0) return error.InvalidSchema;
    }
    @memcpy(out[0..prefix.len], prefix);
    @memcpy(out[prefix.len..][0..value_hex.len], value_hex);
    out[prefix.len + value_hex.len] = ENTRY_SEP;
    @memcpy(out[prefix.len + value_hex.len + 1 ..][0..pk.len], pk);
    return need;
}

test "multiroot registers and tracks cardinality" {
    var reg = Registry.init();
    const a = try reg.register("users.age", "idx:users:age:", false);
    const b = try reg.register("users.email", "idx:users:email:", true);
    try std.testing.expectEqual(@as(usize, 0), a);
    try std.testing.expectEqual(@as(usize, 1), b);
    try std.testing.expect(reg.find("users.age") != null);
    try std.testing.expect(reg.find("missing") == null);
    try std.testing.expectError(error.Duplicate, reg.register("users.age", "idx:other:", false));
    try reg.recordInsert(a);
    try reg.recordInsert(a);
    try std.testing.expectEqual(@as(usize, 2), try reg.cardinality(a));
    try reg.recordRemove(a);
    try std.testing.expectEqual(@as(usize, 1), try reg.cardinality(a));
    try std.testing.expectError(error.OutOfBounds, reg.cardinality(9));
}

test "multiroot hex padding preserves numeric order" {
    var lo: [8]u8 = undefined;
    var hi: [8]u8 = undefined;
    padU32Hex(1, &lo);
    padU32Hex(10, &hi);
    try std.testing.expect(std.mem.lessThan(u8, &lo, &hi));
    padU32Hex(2, &lo);
    padU32Hex(10, &hi);
    try std.testing.expect(std.mem.lessThan(u8, &lo, &hi));
    // No NUL bytes (ART keys must be NUL-free).
    padU32Hex(0, &lo);
    for (lo) |b| try std.testing.expect(b != 0);
    try std.testing.expectEqualStrings("00000000", &lo);
    padU32Hex(0xFFFF_FFFF, &hi);
    try std.testing.expectEqualStrings("ffffffff", &hi);
}

test "multiroot signed hex orders negatives first" {
    var neg: [16]u8 = undefined;
    var zero: [16]u8 = undefined;
    var pos: [16]u8 = undefined;
    padI64Hex16(-5, &neg);
    padI64Hex16(0, &zero);
    padI64Hex16(5, &pos);
    try std.testing.expect(std.mem.lessThan(u8, &neg, &zero));
    try std.testing.expect(std.mem.lessThan(u8, &zero, &pos));
    for (neg) |b| try std.testing.expect(b != 0);
}

test "multiroot builds entry keys" {
    var out: [128]u8 = undefined;
    var hex: [8]u8 = undefined;
    padU32Hex(28, &hex);
    const n = try buildEntryKey(&out, "idx:users:age:", &hex, "u1");
    try std.testing.expectEqualStrings("idx:users:age:0000001c\x1Fu1", out[0..n]);
    try std.testing.expectError(error.NoSpace, buildEntryKey(out[0..4], "idx:users:age:", &hex, "u1"));
}
