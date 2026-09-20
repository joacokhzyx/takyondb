// ============================================================================
// File: layout.zig
// Description: Single source of truth for the SharedArena memory map.
//   All producers/consumers (daemon, C-ABI, SDKs, WAL, snapshots) must use
//   these offsets. Do NOT hardcode magic numbers elsewhere.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Global header (magic + version + size). Reserved for future use.
pub const GLOBAL_RESERVED: usize = 1024;

/// Magic + version header at the very start of the arena (Wave-1 memory-map
/// v2). Validated on every attach; written once by the creating server.
pub const MAGIC_OFFSET: usize = 0;
pub const VERSION_OFFSET: usize = 4;
pub const LAYOUT_VERSION: u32 = 2;

/// RingBuffer header footprint: 3x cache lines (192B) due to align(64) on
/// each of head/tail/capacity. Must stay in sync with RingBuffer.Header
/// (checked by comptime assert in ring_buffer.zig).
pub const RING_HEADER_BYTES: usize = 192;

/// RingBuffer lives right after the global header. The header itself is
/// `RingBuffer.Header` (3x cache lines); slots follow immediately.
pub const RING_OFFSET: usize = 1024;

/// Default slot count. 16 was far too small for 100k+ op benchmarks and
/// caused silent WAL drops. 4096 x 64B = 256KB.
pub const RING_DEFAULT_CAPACITY: usize = 4096;

/// Byte size of one delta slot on the wire.
pub const DELTA_SIZE: usize = 64;

/// u32 bump pointer (little-endian) for fixed-length record allocation.
/// Shared by `takyon.ts` and snapshot/recovery. There is exactly ONE record
/// bump word; do not introduce competing bumps. It sits right after the
/// ring (header + default-capacity slots); records start 8 bytes later so
/// the bump word never aliases record data.
pub const RECORD_BUMP_OFFSET: usize = RING_OFFSET + ringBytes(RING_DEFAULT_CAPACITY);
pub const RECORD_BUMP_INIT: u32 = RECORD_START;

/// Fixed-length record arena. Grows from RECORD_START up to ART_ROOT_OFFSET,
/// so both the legacy 32KB layout and the 1MB chaos layout fit.
pub const RECORD_START: usize = RECORD_BUMP_OFFSET + 8;
pub const ART_ROOT_OFFSET: usize = 2097152;
pub const ART_BUMP_OFFSET: usize = ART_ROOT_OFFSET + 4;
pub const ART_START: usize = ART_ROOT_OFFSET + 8;

/// Variable-length UTF-8 string arena (bump allocator, see proxy.ts).
pub const STRING_ARENA_START: usize = 10 * 1024 * 1024;
pub const STRING_BUMP_OFFSET: usize = STRING_ARENA_START;
pub const STRING_DATA_START: usize = STRING_ARENA_START + 4;

/// Minimum arena size that can host records + ART + strings.
pub const MIN_ARENA_SIZE: usize = 16 * 1024 * 1024;

/// Magic for future header validation.
pub const ARENA_MAGIC: u32 = 0x54414B59; // "TAKY"

/// Bytes needed to host a RingBuffer with `capacity` slots starting at
/// RING_OFFSET (header + slots), for bounds checking before init.
pub fn ringBytes(capacity: usize) usize {
    // Header is 3 cache lines (RING_HEADER_BYTES) due to align(64) on each usize.
    return RING_HEADER_BYTES + capacity * 64 + capacity * 8;
}

/// Lowest arena size that fits the given ring capacity plus ART root.
pub fn minArenaForCapacity(capacity: usize) usize {
    return RING_OFFSET + ringBytes(capacity) + 1024;
}

test "layout sanity" {
    try std.testing.expect(RECORD_START > RECORD_BUMP_OFFSET + 4);
    try std.testing.expect(ART_ROOT_OFFSET > RECORD_START);
    try std.testing.expect(STRING_ARENA_START > ART_ROOT_OFFSET);
    try std.testing.expect(MIN_ARENA_SIZE >= STRING_ARENA_START);
    try std.testing.expect(ringBytes(16) == 192 + 16 * 64 + 16 * 8);
    try std.testing.expect(MAGIC_OFFSET == 0);
    try std.testing.expect(VERSION_OFFSET == 4);
    try std.testing.expect(RECORD_BUMP_OFFSET == 296128);
    try std.testing.expect(RECORD_START == 296136);
    try std.testing.expect(@as(usize, RECORD_BUMP_INIT) == RECORD_START);
    try std.testing.expect(RECORD_START + 8 < ART_ROOT_OFFSET);
}
