// ============================================================================
// File: persist.zig
// Description: Catalog persistence codec for `__catalog__` snapshot cover.
//   Fixed layout (LE, no alloc): header 8B (magic u32 + version u16 +
//   col_count u16) + table 65B (len u8 + name[64]) + per-column 67B
//   (len u8 + name[64] + type u8 + flags u8: bit0 nullable, bit1 pk,
//   bit2 unique). Table name lives in the ART key (`__catalog__:<table>`);
//   the payload repeats it so recovery can cross-check key vs content.
//   Records ride the normal ART + WAL + snapshot path, so verified
//   snapshots already cover DDL. Recovery decodes catalog keys first
//   (two-pass: catalog before data).
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const catalog = @import("catalog.zig");
const rtypes = @import("types.zig");

/// Catalog record magic for `__catalog__` entries.
pub const CATALOG_MAGIC: u32 = 0x54434154; // "TCAT"
pub const CATALOG_VERSION: u16 = 1;
pub const MAX_TABLE_NAME: usize = 64;
pub const MAX_COLUMNS: usize = 32;
pub const TABLE_FIELD_LEN: usize = 65;
pub const COLUMN_REC_LEN: usize = 67;
pub const HEADER_LEN: usize = 8;

/// Validates a catalog payload length (fixed header + columns).
pub fn validCatalogLen(len: usize) bool {
    return len >= 8 and len <= 4096;
}

/// Encoded length for a table with `col_count` columns.
pub fn encodedLen(col_count: usize) usize {
    return HEADER_LEN + TABLE_FIELD_LEN + col_count * COLUMN_REC_LEN;
}

fn flagOf(c: catalog.ColumnDef) u8 {
    var f: u8 = 0;
    if (c.nullable) f |= 0x01;
    if (c.primary_key) f |= 0x02;
    if (c.unique) f |= 0x04;
    return f;
}

/// Encodes a table descriptor into `out`. Returns bytes written.
/// Errors: InvalidSchema (bad names/counts), NoSpace (out too small).
pub fn encode(out: []u8, table: []const u8, cols: []const catalog.ColumnDef) !usize {
    if (table.len == 0 or table.len > MAX_TABLE_NAME) return error.InvalidSchema;
    if (cols.len == 0 or cols.len > MAX_COLUMNS) return error.InvalidSchema;
    const need = encodedLen(cols.len);
    if (out.len < need) return error.NoSpace;
    std.mem.writeInt(u32, out[0..4], CATALOG_MAGIC, .little);
    std.mem.writeInt(u16, out[4..6], CATALOG_VERSION, .little);
    std.mem.writeInt(u16, out[6..8], @intCast(cols.len), .little);
    out[8] = @intCast(table.len);
    @memcpy(out[9 .. 9 + table.len], table);
    @memset(out[9 + table.len .. 9 + MAX_TABLE_NAME], 0);
    var off: usize = HEADER_LEN + TABLE_FIELD_LEN;
    for (cols) |c| {
        if (c.name.len == 0 or c.name.len > MAX_TABLE_NAME) return error.InvalidSchema;
        out[off] = @intCast(c.name.len);
        @memcpy(out[off + 1 .. off + 1 + c.name.len], c.name);
        @memset(out[off + 1 + c.name.len .. off + 1 + MAX_TABLE_NAME], 0);
        out[off + 65] = @intFromEnum(c.col_type);
        out[off + 66] = flagOf(c);
        off += COLUMN_REC_LEN;
    }
    return need;
}

/// Decoded view into a catalog payload (borrows slices, no alloc).
pub const Decoded = struct {
    table: []const u8,
    col_count: usize,
};

/// Validates header + bounds and returns the table/column count.
/// Full per-column validation happens in `decodeColumn`.
pub fn decodeHeader(buf: []const u8) !Decoded {
    if (buf.len < HEADER_LEN + TABLE_FIELD_LEN) return error.Corrupt;
    if (std.mem.readInt(u32, buf[0..4], .little) != CATALOG_MAGIC) return error.Corrupt;
    if (std.mem.readInt(u16, buf[4..6], .little) != CATALOG_VERSION) return error.Corrupt;
    const n = std.mem.readInt(u16, buf[6..8], .little);
    if (n == 0 or n > MAX_COLUMNS) return error.Corrupt;
    if (buf.len < encodedLen(n)) return error.Corrupt;
    const tlen = buf[8];
    if (tlen == 0 or tlen > MAX_TABLE_NAME) return error.Corrupt;
    return .{ .table = buf[9 .. 9 + tlen], .col_count = n };
}

/// Decoded single column (name borrows from the payload).
pub const DecodedColumn = struct {
    name: []const u8,
    col_type: rtypes.RelationalType,
    nullable: bool,
    primary_key: bool,
    unique: bool,
};

/// Decodes column `i` (bounds-checked, NUL-padded names rejected on mismatch).
pub fn decodeColumn(buf: []const u8, i: usize) !DecodedColumn {
    const h = try decodeHeader(buf);
    if (i >= h.col_count) return error.OutOfBounds;
    const off = HEADER_LEN + TABLE_FIELD_LEN + i * COLUMN_REC_LEN;
    const nlen = buf[off];
    if (nlen == 0 or nlen > MAX_TABLE_NAME) return error.Corrupt;
    const name = buf[off + 1 .. off + 1 + nlen];
    // Padding after the name must be zero (tamper-evident).
    for (buf[off + 1 + nlen .. off + 1 + MAX_TABLE_NAME]) |b| {
        if (b != 0) return error.Corrupt;
    }
    const tbyte = buf[off + 65];
    if (tbyte > @intFromEnum(rtypes.RelationalType.TimestampMs)) return error.Corrupt;
    const flags = buf[off + 66];
    if (flags & 0xF8 != 0) return error.Corrupt;
    return .{
        .name = name,
        .col_type = @enumFromInt(tbyte),
        .nullable = flags & 0x01 != 0,
        .primary_key = flags & 0x02 != 0,
        .unique = flags & 0x04 != 0,
    };
}

test "persist validates catalog lengths" {
    try std.testing.expect(validCatalogLen(64));
    try std.testing.expect(!validCatalogLen(4));
    try std.testing.expect(!validCatalogLen(8192));
}

test "persist encodes and decodes a table" {
    const cols = [_]catalog.ColumnDef{
        .{ .name = "id", .col_type = .Uint32, .primary_key = true, .unique = true },
        .{ .name = "age", .col_type = .Uint32, .nullable = true },
    };
    var buf: [4096]u8 = undefined;
    const n = try encode(&buf, "users", &cols);
    try std.testing.expectEqual(encodedLen(2), n);
    const h = try decodeHeader(buf[0..n]);
    try std.testing.expectEqualStrings("users", h.table);
    try std.testing.expectEqual(@as(usize, 2), h.col_count);
    const c0 = try decodeColumn(buf[0..n], 0);
    try std.testing.expectEqualStrings("id", c0.name);
    try std.testing.expectEqual(rtypes.RelationalType.Uint32, c0.col_type);
    try std.testing.expect(c0.primary_key and c0.unique and !c0.nullable);
    const c1 = try decodeColumn(buf[0..n], 1);
    try std.testing.expectEqualStrings("age", c1.name);
    try std.testing.expect(c1.nullable and !c1.primary_key);
}

test "persist rejects tampered payloads" {
    const cols = [_]catalog.ColumnDef{
        .{ .name = "id", .col_type = .Uint32, .primary_key = true },
    };
    var buf: [4096]u8 = undefined;
    const n = try encode(&buf, "t", &cols);
    // Bad magic.
    buf[0] ^= 0xFF;
    try std.testing.expectError(error.Corrupt, decodeHeader(buf[0..n]));
    buf[0] ^= 0xFF;
    // Non-zero padding after the column name.
    buf[HEADER_LEN + TABLE_FIELD_LEN + 3] = 0xAA;
    try std.testing.expectError(error.Corrupt, decodeColumn(buf[0..n], 0));
}
