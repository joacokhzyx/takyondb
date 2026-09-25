// ============================================================================
// File: scrub.zig
// Description: Background scrubber over sealed KV record envelopes.
//   Walks a contiguous buffer of `record_crc`-sealed envelopes without
//   schema knowledge: each step reads the declared length, verifies CRC,
//   and advances. Stops at the first truncated tail or bad header and
//   reports `{ ok, corrupt, bytes, truncated }` so the daemon can log,
//   metric, and optionally quarantine. Pure and allocation-free; the
//   periodic daemon wiring (interval, metrics, quarantine) is future.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const rcrc = @import("record_crc.zig");

/// Scrub result over one contiguous extent.
pub const Report = struct {
    ok: usize = 0,
    corrupt: usize = 0,
    bytes: usize = 0,
    truncated: bool = false,
};

/// Scans `buf` of concatenated sealed envelopes. Never panics.
pub fn scrub(buf: []const u8) Report {
    var rep = Report{};
    var off: usize = 0;
    while (off < buf.len) {
        const rest = buf[off..];
        const plen = rcrc.declaredLen(rest) orelse {
            // Bad header: if the tail is all zeros (unwritten bump space),
            // stop cleanly instead of counting a corrupt record.
            if (isZeroed(rest)) break;
            rep.corrupt += 1;
            break;
        };
        const need = rcrc.sealedLen(plen);
        if (rest.len < need) {
            rep.truncated = true;
            break;
        }
        if (rcrc.verify(rest[0..need])) {
            rep.ok += 1;
        } else {
            rep.corrupt += 1;
            break; // cannot resync without schema; stop at first corrupt
        }
        rep.bytes += need;
        off += need;
    }
    return rep;
}

fn isZeroed(buf: []const u8) bool {
    for (buf) |b| {
        if (b != 0) return false;
    }
    return true;
}

test "scrub counts sealed records" {
    var arena: [256]u8 = [_]u8{0} ** 256;
    var off: usize = 0;
    off += try rcrc.seal(arena[off..], "alpha");
    off += try rcrc.seal(arena[off..], "beta!");
    const rep = scrub(arena[0..off]);
    try std.testing.expectEqual(@as(usize, 2), rep.ok);
    try std.testing.expectEqual(@as(usize, 0), rep.corrupt);
    try std.testing.expectEqual(off, rep.bytes);
    try std.testing.expect(!rep.truncated);
}

test "scrub stops at corruption and truncation" {
    var arena: [256]u8 = [_]u8{0} ** 256;
    var off: usize = 0;
    off += try rcrc.seal(arena[off..], "ok");
    const bad_off = off;
    off += try rcrc.seal(arena[off..], "tamper-me");
    arena[bad_off + rcrc.SEALED_OVERHEAD] ^= 0x01;
    var rep = scrub(arena[0..off]);
    try std.testing.expectEqual(@as(usize, 1), rep.ok);
    try std.testing.expectEqual(@as(usize, 1), rep.corrupt);

    var arena2: [256]u8 = [_]u8{0} ** 256;
    var off2: usize = 0;
    off2 += try rcrc.seal(arena2[off2..], "full");
    off2 += try rcrc.seal(arena2[off2..], "second");
    // Truncated tail: cut the second envelope mid-payload.
    const cut = off2 - 2;
    rep = scrub(arena2[0..cut]);
    try std.testing.expectEqual(@as(usize, 1), rep.ok);
    try std.testing.expect(rep.truncated);
}

test "scrub ignores zeroed tail" {
    var arena: [64]u8 = [_]u8{0} ** 64;
    const n = try rcrc.seal(arena[0..], "x");
    const rep = scrub(arena[0..64]);
    try std.testing.expectEqual(@as(usize, 1), rep.ok);
    try std.testing.expectEqual(@as(usize, 0), rep.corrupt);
    try std.testing.expectEqual(n, rep.bytes);
}
