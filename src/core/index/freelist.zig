// ============================================================================
// File: freelist.zig
// Description: Node freelist for ART reclamation (quarantine + opt-in reuse).
//   Grow/shrink paths orphan the old node on CAS success; without
//   reclamation that is abandoned bump memory. This module quarantines
//   orphaned offsets in size-segregated LIFO stacks (one per node size)
//   behind a mutex, with counters for observability. Reuse is opt-in
//   (`reuse_enabled`, default false): lock-free readers may still hold
//   orphaned pointers, so reuse requires external quiescence — the same
//   contract `remove()` already documents. The daemon keeps the default
//   (accounting only); single-threaded embeds and tests can opt in, and
//   vacuum is the natural future drain point.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

pub const CLASSES: usize = 4;
pub const STACK_CAP: usize = 1024;

/// Node sizes served, in class order (must match art.zig @sizeOf values
/// passed by callers; classOf() maps any other size to null = unserved).
var class_sizes: [CLASSES]u32 = [_]u32{ 0, 0, 0, 0 };
var stacks: [CLASSES][STACK_CAP]u32 = [_][STACK_CAP]u32{[_]u32{0} ** STACK_CAP} ** CLASSES;
var tops: [CLASSES]usize = [_]usize{0} ** CLASSES;
var mtx = std.Thread.Mutex{};
var dropped: usize = 0;
var quarantined_total: usize = 0;
var reused_total: usize = 0;

/// When true, allocNode may pop exact-size entries (requires quiescence).
pub var reuse_enabled: bool = false;

/// 8-byte alignment used by ArtIndex.allocNode; classes and lookups must
/// use aligned sizes so reuse hits exact-size entries.
pub fn alignSize(size: u32) u32 {
    return (size + 7) & ~@as(u32, 7);
}

/// Registers the 4 node class sizes (idempotent, first call wins).
pub fn initClasses(sizes: [CLASSES]u32) void {
    mtx.lock();
    defer mtx.unlock();
    if (class_sizes[0] != 0) return;
    class_sizes = sizes;
}

fn classOf(size: u32) ?usize {
    for (class_sizes, 0..) |s, i| {
        if (s != 0 and s == size) return i;
    }
    return null;
}

/// Quarantines an orphaned node offset. Unknown sizes and overflows are
/// counted as dropped (never a leak of correctness, only of memory).
pub fn quarantine(off: u32, size: u32) void {
    mtx.lock();
    defer mtx.unlock();
    quarantined_total += 1;
    const ci = classOf(size) orelse {
        dropped += 1;
        return;
    };
    if (tops[ci] >= STACK_CAP) {
        dropped += 1;
        return;
    }
    stacks[ci][tops[ci]] = off;
    tops[ci] += 1;
}

/// Pops an exact-size offset, or null. Honors `reuse_enabled`.
pub fn reuse(size: u32) ?u32 {
    if (!reuse_enabled) return null;
    mtx.lock();
    defer mtx.unlock();
    const ci = classOf(size) orelse return null;
    if (tops[ci] == 0) return null;
    tops[ci] -= 1;
    reused_total += 1;
    return stacks[ci][tops[ci]];
}

pub const Stats = struct {
    quarantined: usize,
    reused: usize,
    dropped: usize,
    depths: [CLASSES]usize,
};

pub fn stats() Stats {
    mtx.lock();
    defer mtx.unlock();
    return .{
        .quarantined = quarantined_total,
        .reused = reused_total,
        .dropped = dropped,
        .depths = tops,
    };
}

/// Test seam: resets all state (never use outside tests).
pub fn resetForTests() void {
    mtx.lock();
    defer mtx.unlock();
    class_sizes = [_]u32{ 0, 0, 0, 0 };
    tops = [_]usize{0} ** CLASSES;
    dropped = 0;
    quarantined_total = 0;
    reused_total = 0;
    reuse_enabled = false;
}

test "freelist quarantines and reuses per size class" {
    resetForTests();
    defer resetForTests();
    initClasses([_]u32{ 32, 64, 128, 256 });
    quarantine(1000, 32);
    quarantine(2000, 64);
    quarantine(3000, 999); // unknown size -> dropped
    var st = stats();
    try std.testing.expectEqual(@as(usize, 3), st.quarantined);
    try std.testing.expectEqual(@as(usize, 1), st.dropped);
    // Reuse is gated.
    try std.testing.expect(reuse(32) == null);
    reuse_enabled = true;
    try std.testing.expectEqual(@as(?u32, 1000), reuse(32));
    try std.testing.expectEqual(@as(?u32, 2000), reuse(64));
    try std.testing.expect(reuse(32) == null); // empty
    try std.testing.expect(reuse(999) == null); // unknown class
    st = stats();
    try std.testing.expectEqual(@as(usize, 2), st.reused);
}

test "freelist drops on overflow without panic" {
    resetForTests();
    defer resetForTests();
    initClasses([_]u32{ 8, 16, 24, 32 });
    var i: u32 = 0;
    while (i < STACK_CAP + 10) : (i += 1) {
        quarantine(5000 + i, 8);
    }
    const st = stats();
    try std.testing.expectEqual(@as(usize, STACK_CAP), st.depths[0]);
    try std.testing.expectEqual(@as(usize, 10), st.dropped);
}
