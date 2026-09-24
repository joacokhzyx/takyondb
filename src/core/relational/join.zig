// ============================================================================
// File: join.zig
// Description: Hash join helpers over sorted key streams.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Joined pair of arena offsets (left row, right row).
pub const JoinedPair = struct {
    left: u32,
    right: u32,
};

/// Counts matches for a probe key in a sorted build list (binary search).
pub fn countMatches(sorted_keys: []const u64, probe: u64) usize {
    var lo: usize = 0;
    var hi: usize = sorted_keys.len;
    var count: usize = 0;
    while (lo < hi) {
        const mid = lo + (hi - lo) / 2;
        if (sorted_keys[mid] == probe) {
            count += 1;
            // Count duplicates linearly (small fan-out in phase 1).
            var l = mid;
            while (l > lo and sorted_keys[l - 1] == probe) : (l -= 1) {
                count += 1;
            }
            var r = mid + 1;
            while (r < hi and sorted_keys[r] == probe) : (r += 1) {
                count += 1;
            }
            return count;
        } else if (sorted_keys[mid] < probe) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return count;
}

test "join counts probe matches" {
    const keys = [_]u64{ 1, 2, 2, 3 };
    try std.testing.expectEqual(@as(usize, 2), countMatches(&keys, 2));
    try std.testing.expectEqual(@as(usize, 0), countMatches(&keys, 9));
}
