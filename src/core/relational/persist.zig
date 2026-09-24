// ============================================================================
// File: persist.zig
// Description: Catalog persistence markers for snapshot coverage.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Catalog record magic for `__catalog__` entries.
pub const CATALOG_MAGIC: u32 = 0x54434154; // "TCAT"
pub const CATALOG_VERSION: u16 = 1;

/// Validates a catalog payload length (fixed header + columns).
pub fn validCatalogLen(len: usize) bool {
    return len >= 8 and len <= 4096;
}

test "persist validates catalog lengths" {
    try std.testing.expect(validCatalogLen(64));
    try std.testing.expect(!validCatalogLen(4));
    try std.testing.expect(!validCatalogLen(8192));
}
