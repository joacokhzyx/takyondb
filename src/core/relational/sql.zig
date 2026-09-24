// ============================================================================
// File: sql.zig
// Description: SQL subset token kinds for the minimal parser.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Supported statements in the subset.
pub const StmtKind = enum(u8) {
    Select = 0,
    Insert = 1,
    Update = 2,
    Delete = 3,
    CreateTable = 4,
    Unsupported = 255,
};

/// Classifies the leading keyword (case-insensitive, ASCII only).
pub fn classify(sql: []const u8) StmtKind {
    var i: usize = 0;
    while (i < sql.len and (sql[i] == ' ' or sql[i] == '\t' or sql[i] == '\n')) : (i += 1) {}
    if (i + 6 <= sql.len and std.ascii.eqlIgnoreCase(sql[i .. i + 6], "select")) return .Select;
    if (i + 6 <= sql.len and std.ascii.eqlIgnoreCase(sql[i .. i + 6], "insert")) return .Insert;
    if (i + 6 <= sql.len and std.ascii.eqlIgnoreCase(sql[i .. i + 6], "update")) return .Update;
    if (i + 6 <= sql.len and std.ascii.eqlIgnoreCase(sql[i .. i + 6], "delete")) return .Delete;
    if (i + 6 <= sql.len and std.ascii.eqlIgnoreCase(sql[i .. i + 6], "create")) return .CreateTable;
    return .Unsupported;
}

test "sql classifies statements" {
    try std.testing.expect(classify("SELECT * FROM t") == .Select);
    try std.testing.expect(classify("  insert into t values (1)") == .Insert);
    try std.testing.expect(classify("DROP TABLE t") == .Unsupported);
}
