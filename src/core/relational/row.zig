// ============================================================================
// File: row.zig
// Description: Physical row header with null bitmap and field accessors.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Row magic and version for the fixed header.
pub const ROW_MAGIC: u32 = 0x54524F57; // "TROW"
pub const ROW_VERSION: u16 = 1;

/// CRC32 type with the same std-version shim as the WAL.
const RowCrc32 = if (@hasDecl(std.hash.crc, "Crc32"))
    std.hash.crc.Crc32
else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
    std.hash.crc.Crc32Ieee
else
    std.hash.Crc32;

/// Sealed header layout (12 bytes, little-endian):
///   [0..4]  magic (ROW_MAGIC)
///   [4..6]  version (ROW_VERSION)
///   [6..8]  reserved (zero)
///   [8..12] crc32 over header[0..8] ++ payload
/// The null bitmap lives in the payload (first u32 after the header).
pub const HEADER_LEN: usize = 12;

/// Initializes magic/version/reserved. Returns error.OutOfMemory when short.
pub fn initHeader(buf: []u8) error{OutOfMemory}!void {
    if (buf.len < HEADER_LEN) return error.OutOfMemory;
    std.mem.writeInt(u32, buf[0..4], ROW_MAGIC, .little);
    std.mem.writeInt(u16, buf[4..6], ROW_VERSION, .little);
    std.mem.writeInt(u16, buf[6..8], 0, .little);
    std.mem.writeInt(u32, buf[8..12], 0, .little);
}

/// Seals a payload-carrying buffer: CRC over header[0..8] ++ payload.
/// Call after writing the payload. Never panics on arena bytes.
pub fn seal(buf: []u8) error{OutOfMemory}!void {
    if (buf.len < HEADER_LEN) return error.OutOfMemory;
    var h = RowCrc32.init();
    h.update(buf[0..8]);
    h.update(buf[HEADER_LEN..]);
    std.mem.writeInt(u32, buf[8..12], h.final(), .little);
}

/// Verifies magic, version, and CRC. False on any defect, never panics.
pub fn verify(buf: []const u8) bool {
    if (buf.len < HEADER_LEN) return false;
    if (std.mem.readInt(u32, buf[0..4], .little) != ROW_MAGIC) return false;
    if (std.mem.readInt(u16, buf[4..6], .little) != ROW_VERSION) return false;
    var h = RowCrc32.init();
    h.update(buf[0..8]);
    h.update(buf[HEADER_LEN..]);
    return std.mem.readInt(u32, buf[8..12], .little) == h.final();
}

/// Null bitmap lives at offset 0 (u32 LE, 1 bit per column, 1 = NULL).
pub fn setNull(bitmap: *u32, index: usize) void {
    bitmap.* |= @as(u32, 1) << @intCast(index % 32);
}

pub fn clearNull(bitmap: *u32, index: usize) void {
    bitmap.* &= ~(@as(u32, 1) << @intCast(index % 32));
}

pub fn isNull(bitmap: u32, index: usize) bool {
    return (bitmap & (@as(u32, 1) << @intCast(index % 32))) != 0;
}

test "row null bitmap round-trips" {
    var b: u32 = 0;
    setNull(&b, 3);
    try std.testing.expect(isNull(b, 3));
    try std.testing.expect(!isNull(b, 2));
    clearNull(&b, 3);
    try std.testing.expect(!isNull(b, 3));
}

test "row seal and verify round-trips" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 0xAB);
    try initHeader(buf[0..]);
    // Payload: null bitmap + a field, then seal.
    std.mem.writeInt(u32, buf[HEADER_LEN..][0..4], 0, .little);
    std.mem.writeInt(u32, buf[HEADER_LEN + 4 ..][0..4], 0xDEADBEEF, .little);
    try seal(buf[0..]);
    try std.testing.expect(verify(buf[0..]));
}

test "row verify rejects tampering and truncation" {
    var buf: [32]u8 = undefined;
    @memset(&buf, 0);
    try initHeader(buf[0..]);
    try seal(buf[0..]);
    try std.testing.expect(verify(buf[0..]));

    var bad = buf;
    bad[HEADER_LEN] ^= 0x01; // payload bit flip
    try std.testing.expect(!verify(bad[0..]));
    bad = buf;
    bad[0] ^= 0xFF; // magic corruption
    try std.testing.expect(!verify(bad[0..]));
    bad = buf;
    bad[4] +%= 1; // version bump
    try std.testing.expect(!verify(bad[0..]));
    bad = buf;
    bad[8] ^= 0x01; // crc slot corruption
    try std.testing.expect(!verify(bad[0..]));

    try std.testing.expect(!verify(buf[0..HEADER_LEN]));
    try std.testing.expect(!verify(buf[0..0]));
    try std.testing.expectError(error.OutOfMemory, initHeader(buf[0..4]));
    try std.testing.expectError(error.OutOfMemory, seal(buf[0..4]));
}
