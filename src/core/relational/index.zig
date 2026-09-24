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

test "index detects relational keys" {
    try std.testing.expect(isRelationalKey("tbl:users:u1"));
    try std.testing.expect(isRelationalKey("idx:users:age:28"));
    try std.testing.expect(!isRelationalKey("users:alice"));
}
