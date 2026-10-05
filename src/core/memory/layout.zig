// ============================================================================
// File: layout.zig
// Description: Single source of truth for the SharedArena memory map.
//   All producers/consumers (daemon, C-ABI, SDKs, WAL, snapshots) must use
//   these offsets. Do NOT hardcode magic numbers elsewhere.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Global header: the arena's own metadata, at the very front of the
/// segment. Layout version 3 fills it with the region table; before that it
/// held only the magic and the version, which is why the table's field
/// *offsets* are compile-time constants while its *values* are not.
pub const GLOBAL_RESERVED: usize = 1024;

/// Magic + version header at the very start of the arena. Validated on
/// every attach; written once by the creating server.
pub const MAGIC_OFFSET: usize = 0;
pub const VERSION_OFFSET: usize = 4;

// --- Region table field offsets (v3) ---------------------------------------
//
// Fixed addresses, runtime values. A header has to be parseable before
// anything in it can be trusted, so these cannot move with the regions
// they describe.

/// Total mapped size the table was built for.
pub const ARENA_BYTES_OFFSET: usize = 8;
/// Ring slot count.
pub const RING_CAPACITY_OFFSET: usize = 12;
/// First byte available to records.
pub const RECORD_START_OFFSET: usize = 16;
/// Size of the record region.
pub const RECORD_BYTES_OFFSET: usize = 20;
/// Offset of the index root pointer.
pub const ART_ROOT_OFFSET_FIELD: usize = 24;
/// Size of the index region.
pub const ART_BYTES_OFFSET: usize = 28;
/// Offset of the string bump word.
pub const STRING_START_OFFSET: usize = 32;
/// Size of the string region.
pub const STRING_BYTES_OFFSET: usize = 36;
/// Monotonic millisecond clock shared by every process on the segment.
/// Written as a monotonic maximum by whichever process advances it. Zero
/// until the cache gate uses it; nothing reads it yet.
pub const CLOCK_MS_OFFSET: usize = 40;
/// Reserved flags, zero.
pub const FLAGS_OFFSET: usize = 44;

/// First byte after the header proper. The rest of the first kilobyte
/// stays reserved so a later version has somewhere to go.
pub const HEADER_BYTES: usize = 48;

pub const LAYOUT_VERSION: u32 = 3;

/// The layout version this build refuses to attach to, named so the error
/// can be specific. A v2 segment carries no region table, so attaching to
/// one would mean guessing the regions, and a wrong guess corrupts the
/// arena rather than failing.
pub const LAYOUT_VERSION_NO_TABLE: u32 = 2;

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

// ============================================================================
// Region table
//
// The values behind the offsets above. Every consumer of a region boundary
// takes one of these instead of a compile-time constant, which is what
// makes a 2 GiB arena with a small index possible at all: before this, the
// record region ended wherever the index root happened to sit and a larger
// arena bought nothing.
// ============================================================================

/// Why a region table was refused. Every case names the field, because the
/// alternative is a startup failure whose message says "invalid layout" at
/// a moment when the operator has three files open.
pub const RegionError = error{
    /// The arena is smaller than the regions it must contain.
    RegionsExceedArena,
    /// `ring_capacity` is not a power of two, which the MPMC ring requires.
    RingCapacityNotPowerOfTwo,
    /// The record region does not start after the ring it follows.
    RecordStartInsideRing,
    /// A region runs into the next one.
    RegionsOverlap,
    /// The index root is not where the table says, or is misaligned.
    ArtRootMisplaced,
    /// The string region leaves no room for its bump word.
    StringRegionTooSmall,
    /// The arena is smaller than the header needs.
    HeaderTooSmall,
};

/// One arena's region boundaries. Values are byte offsets and byte sizes.
pub const Regions = struct {
    /// Total mapped size these regions were built for.
    arena_bytes: u32,
    /// Ring slots. A power of two, at least 16.
    ring_capacity: u32,
    /// First byte available to records.
    record_start: u32,
    /// Size of the record region.
    record_bytes: u32,
    /// Offset of the index root pointer word.
    art_root: u32,
    /// Size of the index region.
    art_bytes: u32,
    /// Offset of the string bump word.
    string_start: u32,
    /// Size of the string region.
    string_bytes: u32,

    /// Offset of the single shared record bump word. Derived, not stored:
    /// it is a function of the ring capacity, and a second copy of that
    /// arithmetic in the header is a second thing that can disagree.
    pub fn recordBumpOffset(self: Regions) usize {
        return RING_OFFSET + ringBytes(self.ring_capacity);
    }

    /// First byte of the index region, after the root and bump words.
    pub fn artStart(self: Regions) usize {
        return self.art_root + 8;
    }

    /// Offset of the index bump word.
    pub fn artBumpOffset(self: Regions) usize {
        return self.art_root + 4;
    }

    /// First byte of string payloads, after the bump word.
    pub fn stringDataStart(self: Regions) usize {
        return self.string_start + 4;
    }

    /// Byte offset of the arena's shared clock. Not read by anything yet.
    pub fn clockOffset() usize {
        return CLOCK_MS_OFFSET;
    }
};

/// The table this build would write with no configuration at all. Every
/// value is the constant it replaces, so a missing config file has to be
/// indistinguishable from today's behaviour -- otherwise the first release
/// with a config file is also a behaviour change, and nobody can tell which
/// of their problems is which.
pub fn defaultRegions(arena_bytes: usize) Regions {
    const arena: u32 = @intCast(arena_bytes);
    const ring_end: u32 = @intCast(RING_OFFSET + ringBytes(RING_DEFAULT_CAPACITY));
    const rec_start_u32: u32 = ring_end + 8;
    // The three boundary constants are `usize`; the table is u32 because
    // every word in the header is one.
    const record_start_const: u32 = RECORD_START;
    const art_root_const: u32 = ART_ROOT_OFFSET;
    const string_start_const: u32 = STRING_ARENA_START;

    if (arena >= STRING_ARENA_START) {
        return .{
            .arena_bytes = arena,
            .ring_capacity = RING_DEFAULT_CAPACITY,
            .record_start = record_start_const,
            .record_bytes = art_root_const - record_start_const,
            .art_root = art_root_const,
            .art_bytes = string_start_const - art_root_const,
            .string_start = string_start_const,
            .string_bytes = arena - string_start_const,
        };
    }

    // Smaller than the constants describe. Only synthetic arenas get here --
    // the engine refuses anything under MIN_ARENA_SIZE, and the WAL tests
    // build a few-hundred-kilobyte one to count sectors. Scaling the same
    // structure down is better than the two alternatives: returning the
    // constants anyway produces a table that underflows on the first
    // subtraction, and panicking on a legal argument is a worse contract
    // than returning something `validateRegions` can judge.
    if (arena < ring_end + 64) {
        // Too small even for the default ring. Shrink the ring to the
        // largest power of two that leaves room for the three regions; a
        // 256 KiB arena cannot hold 4096 slots, and returning a table whose
        // record start is past the end of the mapping would just move the
        // failure to whoever validated it.
        var cap: usize = 16;
        while (cap < RING_DEFAULT_CAPACITY) {
            if (RING_OFFSET + ringBytes(cap * 2) + 64 > arena) break;
            cap *= 2;
        }
        const small_ring_end: u32 = @intCast(RING_OFFSET + ringBytes(cap));
        if (arena < small_ring_end + 64) {
            // Not enough for any legal ring. Return a table that fails
            // validation with a named error rather than one that indexes
            // past the mapping.
            return .{
                .arena_bytes = arena,
                .ring_capacity = 16,
                .record_start = small_ring_end,
                .record_bytes = 0,
                .art_root = small_ring_end,
                .art_bytes = 0,
                .string_start = small_ring_end,
                .string_bytes = 0,
            };
        }
        const s_rec_start: u32 = small_ring_end + 8;
        const s_spare: u32 = arena - s_rec_start;
        const s_rec_bytes: u32 = std.mem.alignForward(u32, s_spare / 4, 8);
        const s_art_root: u32 = s_rec_start + s_rec_bytes;
        const s_art_bytes: u32 = std.mem.alignForward(u32, (s_spare - s_rec_bytes) / 2, 8);
        const s_str_start: u32 = s_art_root + s_art_bytes;
        return .{
            .arena_bytes = arena,
            .ring_capacity = @intCast(cap),
            .record_start = s_rec_start,
            .record_bytes = s_rec_bytes,
            .art_root = s_art_root,
            .art_bytes = s_art_bytes,
            .string_start = s_str_start,
            .string_bytes = arena - s_str_start,
        };
    }
    const rec_start = rec_start_u32;
    const spare = arena - rec_start;
    const rec_bytes = std.mem.alignForward(u32, spare / 4, 8);
    const art_root: u32 = @intCast(rec_start + rec_bytes);
    const art_bytes: u32 = std.mem.alignForward(u32, (spare - rec_bytes) / 2, 8);
    const str_start: u32 = @intCast(art_root + art_bytes);
    return .{
        .arena_bytes = arena,
        .ring_capacity = RING_DEFAULT_CAPACITY,
        .record_start = rec_start,
        .record_bytes = rec_bytes,
        .art_root = art_root,
        .art_bytes = art_bytes,
        .string_start = str_start,
        .string_bytes = arena - str_start,
    };
}

/// Checks every relation between the regions. This runs before anything
/// reads or writes the arena, because the failure mode of a bad table is
/// silent corruption rather than an error.
pub fn validateRegions(r: Regions, mapped_bytes: usize) RegionError!void {
    if (mapped_bytes < HEADER_BYTES) return error.HeaderTooSmall;
    if (r.arena_bytes != mapped_bytes) return error.RegionsExceedArena;

    if (r.ring_capacity < 16 or !std.math.isPowerOfTwo(r.ring_capacity)) {
        return error.RingCapacityNotPowerOfTwo;
    }

    const ring_end: usize = r.recordBumpOffset();
    // The record bump word sits immediately after the ring, and the first
    // record byte must clear it.
    if (r.record_start < ring_end + 8) return error.RecordStartInsideRing;

    const record_end: usize = @as(usize, r.record_start) + r.record_bytes;
    if (record_end > r.art_root) return error.RegionsOverlap;

    // The root word, its bump word and the first node are eight bytes.
    // Tagged pointers in the index pack a tag into the low bits of a u32,
    // so the root must be four-byte aligned at minimum; eight keeps the
    // bump word and the first node naturally aligned.
    if (r.art_root % 8 != 0) return error.ArtRootMisplaced;
    const art_end: usize = @as(usize, r.art_root) + r.art_bytes;
    if (art_end > r.string_start) return error.RegionsOverlap;

    // Four bytes for the bump word before any payload can exist.
    if (r.string_bytes < 8) return error.StringRegionTooSmall;
    const string_end: usize = @as(usize, r.string_start) + r.string_bytes;
    if (string_end > r.arena_bytes) return error.RegionsExceedArena;

    // Every region must be addressable in the mapping, and the ring must
    // fit before the record region starts at all.
    if (ring_end + 8 > r.record_start) return error.RecordStartInsideRing;
}

/// Writes the table into a mapped arena. The magic and version are written
/// here too, so a header is only ever produced in one place.
pub fn writeRegions(mem: []u8, r: Regions) void {
    std.debug.assert(mem.len >= HEADER_BYTES);
    std.mem.writeInt(u32, mem[MAGIC_OFFSET..][0..4], ARENA_MAGIC, .little);
    std.mem.writeInt(u32, mem[VERSION_OFFSET..][0..4], LAYOUT_VERSION, .little);
    std.mem.writeInt(u32, mem[ARENA_BYTES_OFFSET..][0..4], r.arena_bytes, .little);
    std.mem.writeInt(u32, mem[RING_CAPACITY_OFFSET..][0..4], r.ring_capacity, .little);
    std.mem.writeInt(u32, mem[RECORD_START_OFFSET..][0..4], r.record_start, .little);
    std.mem.writeInt(u32, mem[RECORD_BYTES_OFFSET..][0..4], r.record_bytes, .little);
    std.mem.writeInt(u32, mem[ART_ROOT_OFFSET_FIELD..][0..4], r.art_root, .little);
    std.mem.writeInt(u32, mem[ART_BYTES_OFFSET..][0..4], r.art_bytes, .little);
    std.mem.writeInt(u32, mem[STRING_START_OFFSET..][0..4], r.string_start, .little);
    std.mem.writeInt(u32, mem[STRING_BYTES_OFFSET..][0..4], r.string_bytes, .little);
}

/// Reads the magic, the version and the table out of a mapped arena.
///
/// The version is checked before the table is read, and an arena without
/// the table is refused rather than defaulted: guessing the regions of an
/// arena built for different ones does not fail, it corrupts. The caller
/// gets the version it found in `found_version` so it can say which.
pub fn readRegions(mem: []const u8) error{ HeaderTooSmall, NoRegionTable, BadMagic }!Regions {
    if (mem.len < HEADER_BYTES) return error.HeaderTooSmall;
    const magic = std.mem.readInt(u32, mem[MAGIC_OFFSET..][0..4], .little);
    if (magic != ARENA_MAGIC) return error.BadMagic;
    const version = std.mem.readInt(u32, mem[VERSION_OFFSET..][0..4], .little);
    if (version < 3) return error.NoRegionTable;
    return .{
        .arena_bytes = std.mem.readInt(u32, mem[ARENA_BYTES_OFFSET..][0..4], .little),
        .ring_capacity = std.mem.readInt(u32, mem[RING_CAPACITY_OFFSET..][0..4], .little),
        .record_start = std.mem.readInt(u32, mem[RECORD_START_OFFSET..][0..4], .little),
        .record_bytes = std.mem.readInt(u32, mem[RECORD_BYTES_OFFSET..][0..4], .little),
        .art_root = std.mem.readInt(u32, mem[ART_ROOT_OFFSET_FIELD..][0..4], .little),
        .art_bytes = std.mem.readInt(u32, mem[ART_BYTES_OFFSET..][0..4], .little),
        .string_start = std.mem.readInt(u32, mem[STRING_START_OFFSET..][0..4], .little),
        .string_bytes = std.mem.readInt(u32, mem[STRING_BYTES_OFFSET..][0..4], .little),
    };
}

/// Reads the layout version alone, for a caller that only needs to decide
/// whether the arena is one it can read.
pub fn readVersion(mem: []const u8) ?u32 {
    if (mem.len < VERSION_OFFSET + 4) return null;
    return std.mem.readInt(u32, mem[VERSION_OFFSET..][0..4], .little);
}

test "the default table reproduces today's constants exactly" {
    const r = defaultRegions(64 * 1024 * 1024);
    try std.testing.expectEqual(@as(u32, 4096), r.ring_capacity);
    try std.testing.expectEqual(@as(u32, @intCast(RECORD_START)), r.record_start);
    try std.testing.expectEqual(@as(u32, ART_ROOT_OFFSET), r.art_root);
    try std.testing.expectEqual(@as(u32, STRING_ARENA_START), r.string_start);
    try std.testing.expectEqual(RECORD_BUMP_OFFSET, r.recordBumpOffset());
    try std.testing.expectEqual(ART_BUMP_OFFSET, r.artBumpOffset());
    try std.testing.expectEqual(ART_START, r.artStart());
    try std.testing.expectEqual(STRING_BUMP_OFFSET, r.string_start);
    try std.testing.expectEqual(STRING_DATA_START, r.stringDataStart());
    try validateRegions(r, 64 * 1024 * 1024);
}

test "the table round-trips through a mapped arena" {
    // Deliberately nothing like the defaults: a 64-slot ring and regions
    // that do not sit on the powers of two the constants use. A round-trip
    // test that only ever writes defaults would pass even if the table were
    // ignored and the constants re-read.
    var mem: [1024 * 1024]u8 = undefined;
    @memset(&mem, 0);

    const arena: u32 = mem.len;
    const record_start: u32 = @intCast(RING_OFFSET + ringBytes(64) + 8);
    const art_root: u32 = 512 * 1024;
    const string_start: u32 = 768 * 1024;
    const given = Regions{
        .arena_bytes = arena,
        .ring_capacity = 64,
        .record_start = record_start,
        .record_bytes = art_root - record_start,
        .art_root = art_root,
        .art_bytes = string_start - art_root,
        .string_start = string_start,
        .string_bytes = arena - string_start,
    };
    try validateRegions(given, mem.len);

    writeRegions(&mem, given);
    const back = try readRegions(&mem);

    try std.testing.expectEqual(given.arena_bytes, back.arena_bytes);
    try std.testing.expectEqual(given.ring_capacity, back.ring_capacity);
    try std.testing.expectEqual(given.record_start, back.record_start);
    try std.testing.expectEqual(given.record_bytes, back.record_bytes);
    try std.testing.expectEqual(given.art_root, back.art_root);
    try std.testing.expectEqual(given.art_bytes, back.art_bytes);
    try std.testing.expectEqual(given.string_start, back.string_start);
    try std.testing.expectEqual(given.string_bytes, back.string_bytes);
    try std.testing.expectEqual(given.recordBumpOffset(), back.recordBumpOffset());
    try validateRegions(back, mem.len);
}

test "an arena with no region table is refused, not guessed" {
    var mem: [4096]u8 = undefined;
    @memset(&mem, 0);
    // A v2 header: magic present, version 2, no table behind it.
    std.mem.writeInt(u32, mem[MAGIC_OFFSET..][0..4], ARENA_MAGIC, .little);
    std.mem.writeInt(u32, mem[VERSION_OFFSET..][0..4], LAYOUT_VERSION_NO_TABLE, .little);

    try std.testing.expectError(error.NoRegionTable, readRegions(&mem));
    try std.testing.expectEqual(@as(?u32, LAYOUT_VERSION_NO_TABLE), readVersion(&mem));
}

test "a foreign arena is refused before the table is read" {
    var mem: [4096]u8 = undefined;
    @memset(&mem, 0xFF);
    try std.testing.expectError(error.BadMagic, readRegions(&mem));
}

test "validation rejects every way a table can be wrong" {
    const good = defaultRegions(64 * 1024 * 1024);

    // A ring capacity the MPMC ring cannot use.
    var r = good;
    r.ring_capacity = 1000;
    try std.testing.expectError(error.RingCapacityNotPowerOfTwo, validateRegions(r, 64 * 1024 * 1024));
    r.ring_capacity = 8;
    try std.testing.expectError(error.RingCapacityNotPowerOfTwo, validateRegions(r, 64 * 1024 * 1024));

    // Records starting inside the ring: the bump word has nowhere to go.
    r = good;
    r.record_start = RING_OFFSET;
    try std.testing.expectError(error.RecordStartInsideRing, validateRegions(r, 64 * 1024 * 1024));

    // Records running into the index root.
    r = good;
    r.record_bytes = @intCast(ART_ROOT_OFFSET - RECORD_START + 1);
    try std.testing.expectError(error.RegionsOverlap, validateRegions(r, 64 * 1024 * 1024));

    // The index running into the string region.
    r = good;
    r.art_bytes = @intCast(STRING_ARENA_START - ART_ROOT_OFFSET + 1);
    try std.testing.expectError(error.RegionsOverlap, validateRegions(r, 64 * 1024 * 1024));

    // A misaligned index root, which would make tagged pointers lie.
    r = good;
    r.art_root = ART_ROOT_OFFSET + 4;
    try std.testing.expectError(error.ArtRootMisplaced, validateRegions(r, 64 * 1024 * 1024));

    // A string region too small for its own bump word.
    r = good;
    r.string_bytes = 4;
    try std.testing.expectError(error.StringRegionTooSmall, validateRegions(r, 64 * 1024 * 1024));

    // A table built for a different arena size than the one mapped.
    try std.testing.expectError(error.RegionsExceedArena, validateRegions(good, 128 * 1024 * 1024));

    // A mapping too small to hold a header at all.
    try std.testing.expectError(error.HeaderTooSmall, validateRegions(good, 16));
}

test "the default table is valid for a small synthetic arena too" {
    // The WAL and recovery tests build arenas of a few hundred kilobytes.
    // Getting a valid table out of this helper for them is what keeps
    // `defaultRegions` a total function instead of one that panics on a
    // legal argument.
    const sizes = [_]usize{
        layout_min_for_tests(),
        256 * 1024,
        1024 * 1024,
        8 * 1024 * 1024,
        MIN_ARENA_SIZE,
        64 * 1024 * 1024,
    };
    for (sizes) |n| {
        const r = defaultRegions(n);
        try std.testing.expectEqual(@as(u32, @intCast(n)), r.arena_bytes);
        try validateRegions(r, n);
    }
}

fn layout_min_for_tests() usize {
    return RING_OFFSET + ringBytes(RING_DEFAULT_CAPACITY) + 4096;
}
