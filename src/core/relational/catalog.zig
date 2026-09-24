// ============================================================================
// File: catalog.zig
// Description: In-memory table catalog with DDL validation.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const rtypes = @import("types.zig");

/// Single column definition (fixed-size metadata, no heap strings owned).
pub const ColumnDef = struct {
    name: []const u8,
    col_type: rtypes.RelationalType,
    nullable: bool = false,
    primary_key: bool = false,
    unique: bool = false,
};

/// Table descriptor with compiled offsets (4B null bitmap + columns).
pub const TableDef = struct {
    name: []const u8,
    columns: []const ColumnDef,
    total_size: usize,
    pk_index: usize,

    pub fn init(name: []const u8, columns: []const ColumnDef) !TableDef {
        if (columns.len == 0 or columns.len > 32) return error.InvalidSchema;
        var pk_count: usize = 0;
        var pk_index: usize = 0;
        var offset: usize = 4;
        for (columns, 0..) |c, i| {
            if (c.name.len == 0 or c.name.len > 64) return error.InvalidSchema;
            if (c.primary_key) {
                pk_count += 1;
                pk_index = i;
                if (c.nullable) return error.InvalidSchema;
            }
            offset += rtypes.typeSize(c.col_type);
        }
        if (pk_count != 1) return error.InvalidSchema;
        return .{ .name = name, .columns = columns, .total_size = offset, .pk_index = pk_index };
    }
};

test "catalog validates single pk" {
    const cols = [_]ColumnDef{
        .{ .name = "id", .col_type = .String, .primary_key = true },
        .{ .name = "age", .col_type = .Uint32 },
    };
    const t = try TableDef.init("users", &cols);
    try std.testing.expectEqual(@as(usize, 0), t.pk_index);
    try std.testing.expect(t.total_size > 8);
}

test "catalog rejects missing pk" {
    const cols = [_]ColumnDef{
        .{ .name = "a", .col_type = .Uint32 },
    };
    try std.testing.expectError(error.InvalidSchema, TableDef.init("t", &cols));
}
