// ============================================================================
// File: record_crc.zig
// Description: Sealed KV record envelope with CRC32 (tamper-evident).
//   Layout LE (10B header + payload): [0..4] magic (TREC), [4..6] version,
//   [6..10] payload_len u32, [10..14] crc32 over header[0..10] ++ payload.
//   The daemon write path still stores raw schema fields (format migration
//   is future); this codec ships first so new paths and tests can seal
//   records and the scrubber can verify them without schema knowledge.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

pub const REC_MAGIC: u32 = 0x54524543; // "TREC"
pub const REC_VERSION: u16 = 1;
pub const HEADER_LEN: usize = 10;
pub const CRC_LEN: usize = 4;
pub const SEALED_OVERHEAD: usize = HEADER_LEN + CRC_LEN;

const RecCrc32 = if (@hasDecl(std.hash.crc, "Crc32"))
    std.hash.crc.Crc32
else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
    std.hash.crc.Crc32Ieee
else
    std.hash.Crc32;

/// Sealed length for a payload (header + crc + payload).
pub fn sealedLen(payload_len: usize) usize {
    return SEALED_OVERHEAD + payload_len;
}

/// Seals `payload` into `out` (must fit sealedLen). Returns bytes written.
pub fn seal(out: []u8, payload: []const u8) !usize {
    const need = sealedLen(payload.len);
    if (out.len < need) return error.NoSpace;
    if (payload.len > 0xFFFF_FFFF) return error.InvalidSchema;
    std.mem.writeInt(u32, out[0..4], REC_MAGIC, .little);
    std.mem.writeInt(u16, out[4..6], REC_VERSION, .little);
    std.mem.writeInt(u32, out[6..10], @intCast(payload.len), .little);
    var h = RecCrc32.init();
    h.update(out[0..HEADER_LEN]);
    h.update(payload);
    std.mem.writeInt(u32, out[HEADER_LEN..][0..4], h.final(), .little);
    @memcpy(out[SEALED_OVERHEAD..][0..payload.len], payload);
    return need;
}

/// Verifies one sealed envelope. False on any defect, never panics.
pub fn verify(buf: []const u8) bool {
    if (buf.len < SEALED_OVERHEAD) return false;
    if (std.mem.readInt(u32, buf[0..4], .little) != REC_MAGIC) return false;
    if (std.mem.readInt(u16, buf[4..6], .little) != REC_VERSION) return false;
    const plen: usize = std.mem.readInt(u32, buf[6..10], .little);
    if (buf.len < SEALED_OVERHEAD + plen) return false;
    var h = RecCrc32.init();
    h.update(buf[0..HEADER_LEN]);
    h.update(buf[SEALED_OVERHEAD .. SEALED_OVERHEAD + plen]);
    return std.mem.readInt(u32, buf[HEADER_LEN..][0..4], .little) == h.final();
}

/// Payload length declared by the envelope, or null when no valid header.
pub fn declaredLen(buf: []const u8) ?usize {
    if (buf.len < HEADER_LEN) return null;
    if (std.mem.readInt(u32, buf[0..4], .little) != REC_MAGIC) return null;
    if (std.mem.readInt(u16, buf[4..6], .little) != REC_VERSION) return null;
    return std.mem.readInt(u32, buf[6..10], .little);
}

test "record envelope seals and verifies" {
    var out: [64]u8 = undefined;
    const payload = [_]u8{ 1, 2, 3, 4, 5 };
    const n = try seal(&out, &payload);
    try std.testing.expectEqual(sealedLen(5), n);
    try std.testing.expect(verify(out[0..n]));
    try std.testing.expectEqual(@as(?usize, 5), declaredLen(out[0..n]));
}

test "record envelope rejects tampering and truncation" {
    var out: [64]u8 = undefined;
    const n = try seal(&out, "hello");
    var bad_crc = out;
    bad_crc[HEADER_LEN] ^= 0x01;
    try std.testing.expect(!verify(bad_crc[0..n]));
    var bad_magic = out;
    bad_magic[0] ^= 0xFF;
    try std.testing.expect(!verify(bad_magic[0..n]));
    var bad_payload = out;
    bad_payload[SEALED_OVERHEAD] ^= 0x01;
    try std.testing.expect(!verify(bad_payload[0..n]));
    try std.testing.expect(!verify(out[0 .. n - 1]));
    try std.testing.expect(!verify(out[0..0]));
    try std.testing.expectError(error.NoSpace, seal(out[0..4], "hello"));
}
