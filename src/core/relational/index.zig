// ============================================================================
// File: index.zig
// Description: Secondary index key helpers for ART namespaces.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Prefix lengths for namespaced keys (validated by SDK, checked here).
pub const TBL_PREFIX = "tbl:";
pub const IDX_PREFIX = "idx:";
pub const CATALOG_PREFIX = "__catalog__:";

/// True when a key belongs to the relational namespace.
pub fn isRelationalKey(key: []const u8) bool {
    return std.mem.startsWith(u8, key, TBL_PREFIX) or
        std.mem.startsWith(u8, key, IDX_PREFIX) or
        std.mem.startsWith(u8, key, CATALOG_PREFIX);
}

/// True when a key is a catalog record (`__catalog__:<table>`).
pub fn isCatalogKey(key: []const u8) bool {
    if (!std.mem.startsWith(u8, key, CATALOG_PREFIX)) return false;
    return key.len > CATALOG_PREFIX.len;
}

/// Writes `__catalog__:<table>` into `out`. Returns bytes written or error.NoSpace.
pub fn catalogKey(out: []u8, table: []const u8) !usize {
    if (table.len == 0 or table.len > 64) return error.InvalidSchema;
    if (out.len < CATALOG_PREFIX.len + table.len) return error.NoSpace;
    @memcpy(out[0..CATALOG_PREFIX.len], CATALOG_PREFIX);
    @memcpy(out[CATALOG_PREFIX.len..][0..table.len], table);
    return CATALOG_PREFIX.len + table.len;
}

test "index detects relational keys" {
    try std.testing.expect(isRelationalKey("tbl:users:u1"));
    try std.testing.expect(isRelationalKey("idx:users:age:28"));
    try std.testing.expect(!isRelationalKey("users:alice"));
}

test "index builds catalog keys" {
    var buf: [128]u8 = undefined;
    const n = try catalogKey(&buf, "users");
    try std.testing.expectEqualStrings("__catalog__:users", buf[0..n]);
    try std.testing.expect(isCatalogKey(buf[0..n]));
    try std.testing.expect(!isCatalogKey("__catalog__:"));
    try std.testing.expect(!isCatalogKey("tbl:users:u1"));
    try std.testing.expectError(error.InvalidSchema, catalogKey(&buf, ""));
    var tiny: [4]u8 = undefined;
    try std.testing.expectError(error.NoSpace, catalogKey(&tiny, "users"));
}
