// ============================================================================
// File: recovery.zig
// Description: Isomorphic crash recovery bootloader for TakyonDB.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const layout = @import("../memory/layout.zig");
const WalEntryHeader = @import("wal.zig").WalEntryHeader;
/// Payload bytes per 4K sector (wal.zig owns the value; the trailing 4
/// bytes hold the CRC32 the replay validates).
const SECTOR_PAYLOAD = @import("wal.zig").SECTOR_PAYLOAD;
/// Record kind byte; records above MAX_ENTRY_KIND come from a newer format.
const MAX_ENTRY_KIND = @import("wal.zig").MAX_ENTRY_KIND;
const EntryKind = @import("wal.zig").EntryKind;
const ArtIndex = @import("../index/art.zig").ArtIndex;
/// Unified entry limit (wal.zig owns the value); replay stops the entry
/// scan on lengths above it as corrupt.
const MAX_ENTRY_LEN = @import("wal.zig").MAX_ENTRY_LEN;
/// Segment index cap shared with wal.zig rotation/cleanup.
const MAX_SEGMENTS = @import("wal.zig").MAX_SEGMENTS;
/// The snapshot writer owns the on-disk format, so the reader imports its
/// constants rather than restating them: a second copy of the footer field
/// offsets is exactly the kind of thing that silently rots. recovery.zig
/// already depends on snapshot.zig transitively (wal.zig imports it).
const snap = @import("snapshot.zig");

// Coordinate with the layout-v2 agent: these WILL exist in layout.zig.
// Fallbacks use identical values so this file compiles in parallel.
const MAGIC_OFFSET: usize = if (@hasDecl(layout, "MAGIC_OFFSET")) layout.MAGIC_OFFSET else 0;
const VERSION_OFFSET: usize = if (@hasDecl(layout, "VERSION_OFFSET")) layout.VERSION_OFFSET else 4;
const LAYOUT_VERSION: u32 = if (@hasDecl(layout, "LAYOUT_VERSION")) layout.LAYOUT_VERSION else 2;
const FOOTER_MAGIC: u32 = if (@hasDecl(layout, "ARENA_MAGIC")) layout.ARENA_MAGIC else 0x54414B59;

/// The extents a verified snapshot restored, in the writer's canonical
/// order. `len == 0` means that region was empty at snapshot time and the
/// snapshot carried nothing for it.
pub const SnapshotMeta = struct {
    extents: [snap.EXTENT_COUNT]snap.Extent,
    /// The region table this snapshot was written against, read from its
    /// footer. Recovery refuses a snapshot whose table is not the one it is
    /// restoring into, so this is the value that was already checked rather
    /// than a diagnostic.
    regions: layout.Regions,

    pub fn record(self: SnapshotMeta) snap.Extent {
        return self.extents[snap.EXT_REC];
    }

    pub fn art(self: SnapshotMeta) snap.Extent {
        return self.extents[snap.EXT_ART];
    }

    pub fn strings(self: SnapshotMeta) snap.Extent {
        return self.extents[snap.EXT_STR];
    }
};

/// Logical index operations recovered from the WAL, held until the arena
/// replay is finished.
///
/// Two properties force the buffering. First, an `index_op` payload points
/// into the sector buffer, which is overwritten on the next read, so the key
/// has to be copied out. Second, and more important, the ops cannot be
/// applied as they are read: replaying one allocates ART nodes from the ART
/// bump, and `finalize` writes the bump word from the maxima we are still
/// computing. Applying them at the end, before finalize folds in the arena's
/// post-replay bump, is what keeps the two from fighting.
const IndexOps = struct {
    /// Keys, concatenated; `IndexOp.key_offset` indexes into this. The
    /// allocator is assigned by the caller, since a zero-initialized
    /// ArrayList has none and recovery runs before the GPA is reachable
    /// from here.
    keys: std.ArrayList(u8),
    ops: std.ArrayList(IndexOp),

    const IndexOp = struct {
        key_offset: u32,
        key_len: u16,
        value_offset: u32,
    };

    fn deinit(self: *IndexOps) void {
        self.keys.deinit();
        self.ops.deinit();
    }

    /// Best-effort: a log we cannot buffer the keys from is a log whose
    /// index we cannot rebuild, and recovery must not abort over it. The
    /// arena bytes have already been restored, so a partial index is still
    /// better than none, and the shortfall is reported by applyIndexOps.
    fn add(self: *IndexOps, key: []const u8, value_offset: u32) void {
        const at = self.keys.items.len;
        self.keys.appendSlice(key) catch return;
        self.ops.append(.{
            .key_offset = @intCast(at),
            .key_len = @intCast(key.len),
            .value_offset = value_offset,
        }) catch {
            _ = self.keys.shrinkRetainingCapacity(at);
        };
    }
};

/// Re-applies recovered index operations to the ART.
///
/// Replaying a logical insert is idempotent: the ART overwrites an existing
/// key's leaf rather than duplicating it, and with freelist reuse off (the
/// default) the allocator is a monotonic bump, so applying the same log twice
/// produces the same index. Keys that the snapshot already contained are
/// re-inserted, which allocates a second leaf and orphans the first; that
/// costs a little arena space after recovery and is preferred over trying to
/// detect which keys a snapshot already had.
fn applyIndexOps(art_index: *ArtIndex, index_ops: *IndexOps, regions: layout.Regions, rec_max: u32) u32 {
    var applied: u32 = 0;
    var skipped: u32 = 0;
    for (index_ops.ops.items) |op| {
        const start = op.key_offset;
        const end = start + op.key_len;
        if (end > index_ops.keys.items.len) continue; // Truncated blob; skip.
        // An index operation whose record never reached the log is dropped.
        //
        // Deltas are independent ring entries, so the index operation -- the
        // first one pushed for a record -- can be in the log while the value
        // deltas behind it were still queued when the process died. Keeping
        // the entry would leave a key resolving to an offset the record bump
        // does not cover, and the next allocation would land on it: the key
        // would then read somebody else's record. rec_max is the highest
        // record byte the log actually contains, so `value_offset < rec_max`
        // is the test for "the log describes these bytes".
        if (op.value_offset < regions.record_start or op.value_offset >= rec_max) {
            skipped += 1;
            continue;
        }
        art_index.insert(index_ops.keys.items[start..end], op.value_offset) catch |err| {
            std.debug.print("[TakyonDB-Bootloader] Skipped index replay for a key that no longer fits: {s}\\n", .{@errorName(err)});
            continue;
        };
        applied += 1;
    }
    if (index_ops.ops.items.len > 0) {
        std.debug.print(
            "[TakyonDB-Bootloader] Replayed {d}/{d} index operations from the WAL{s}.\\n",
            .{
                applied,
                index_ops.ops.items.len,
                if (skipped > 0) "; the rest named records the log never received" else "",
            },
        );
    }
    return applied;
}

/// u32 views of the derived boundaries. The engine stores these offsets as
/// u32 words, so every caller that needs one as a word goes through here
/// rather than casting the usize return at each use site.
fn artStartOf(regions: layout.Regions) u32 {
    return @intCast(regions.artStart());
}

fn stringDataStartOf(regions: layout.Regions) u32 {
    return @intCast(regions.stringDataStart());
}

fn readWord(arena_mem: []const u8, offset: usize, fallback: u32) u32 {
    if (offset + 4 > arena_mem.len) return fallback;
    return @as(*const u32, @ptrCast(@alignCast(arena_mem.ptr + offset))).*;
}

fn align8(v: u32) u32 {
    return (v + 7) & ~@as(u32, 7);
}

const OsFd = if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t;

fn closeFd(fd: OsFd) void {
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(fd);
    } else {
        _ = std.c.close(fd);
    }
}

/// Opens an existing file for reading (Direct I/O where available).
/// Returns null when the file does not exist.
fn openExisting(path: [:0]const u8) ?OsFd {
    if (builtin.os.tag == .windows) {
        var path_w: [256]u16 = undefined;
        const utf16_len = std.unicode.utf8ToUtf16Le(&path_w, path) catch return null;
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0x80000000))), // GENERIC_READ
            1, // FILE_SHARE_READ
            null,
            3, // OPEN_EXISTING
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null,
        );
        if (handle == std.os.windows.INVALID_HANDLE_VALUE) return null;
        return handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            std.posix.O{ .ACCMODE = .RDONLY, .DIRECT = true }
        else
            std.posix.O{ .ACCMODE = .RDONLY };
        var raw_fd = std.c.open(path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) {
            // Retry buffered: the file may live on a filesystem without
            // Direct I/O support, or be smaller than one sector.
            const plain = std.posix.O{ .ACCMODE = .RDONLY };
            raw_fd = std.c.open(path.ptr, plain, @as(c_uint, 0o644));
            if (raw_fd < 0) return null;
        }
        return @as(std.posix.fd_t, raw_fd);
    }
}

/// Reads exactly one 4K block. Returns false on EOF or error.
fn readBlock(fd: OsFd, buf: *[4096]u8) bool {
    if (builtin.os.tag == .windows) {
        var read_bytes: std.os.windows.DWORD = 0;
        if (std.os.windows.kernel32.ReadFile(fd, buf.ptr, 4096, &read_bytes, null) == 0) return false;
        if (read_bytes != 4096) return false;
        return true;
    } else {
        var off: usize = 0;
        while (off < 4096) {
            const n = std.c.read(fd, buf.ptr + off, 4096 - off);
            if (n <= 0) return false;
            off += @as(usize, @intCast(n));
        }
        return true;
    }
}

fn blocksFor(byte_len: usize) usize {
    return (byte_len + 4095) / 4096;
}

fn isFooterV3Shape(buf: *const [4096]u8) bool {
    for (buf[snap.FOOTER_V3_TAIL_OFF..]) |b| {
        if (b != 0) return false;
    }
    return true;
}

fn isFooterV2Shape(buf: *const [4096]u8) bool {
    for (buf[snap.FOOTER_V2_TAIL_OFF..]) |b| {
        if (b != 0) return false;
    }
    return true;
}

fn isLegacyV1Shape(buf: *const [4096]u8) bool {
    for (buf[snap.FOOTER_V1_TAIL_OFF..]) |b| {
        if (b != 0) return false;
    }
    return true;
}

/// Rebuilds the writer's extent table from the footer's length words and
/// checks every bound a length could break.
///
/// The starts are not stored: an extent always begins at its layout
/// constant, so they are re-derived here and the lengths are validated
/// against the region each one must stay inside. A footer is a file on
/// disk, so nothing in it is trusted until it has been proved to be
/// describable as extents of *this* arena.
fn extentsFromFooter(buf: *const [4096]u8, arena_len: usize, regions: layout.Regions) ?[snap.EXTENT_COUNT]snap.Extent {
    const starts = snap.extentStarts(regions);
    const min_lens = snap.extentMinLens(regions);
    var extents: [snap.EXTENT_COUNT]snap.Extent = undefined;
    for (0..snap.EXTENT_COUNT) |i| {
        const len = std.mem.readInt(u32, buf[snap.FOOTER_FIRST_LEN_OFF + 4 * i ..][0..4], .little);
        const start: usize = starts[i];
        if (start > arena_len) {
            // This arena is too small to hold the region at all: nothing
            // can be claimed for it.
            extents[i] = .{ .start = @intCast(start), .len = 0 };
            continue;
        }
        const end = start + @as(usize, len);
        if (end > arena_len) return null;
        // A length the writer could never have produced means the footer
        // is not describing this format; refuse it instead of restoring a
        // region it admits it does not cover in full.
        if (len != 0 and len < min_lens[i]) return null;
        extents[i] = .{ .start = @intCast(start), .len = len };
    }
    // Strictly ascending and disjoint: the packed payload walk, and the
    // gap fill in zeroOutsideExtents, both depend on it.
    for (extents[1..], 0..) |e, i| {
        const earlier = extents[i];
        if (e.start < earlier.start) return null;
        if (e.len != 0 and earlier.len != 0 and e.start < earlier.end()) return null;
    }
    return extents;
}

/// Scatters one payload block back into the arena.
///
/// The mirror image of snapshot.zig's `renderPayloadBlock`, and the reason
/// this format is self-describing: the extents are contiguous, ordered and
/// disjoint, so one block of the packed payload maps to at most one
/// contiguous run in each extent and the split is a pure function of the
/// lengths.
fn placePayloadBlock(arena_mem: []u8, extents: [snap.EXTENT_COUNT]snap.Extent, at: usize, block: *const [4096]u8) void {
    const block_end = at + block.len;
    var p0: usize = 0;
    for (extents) |e| {
        const p1 = p0 + e.len;
        if (p1 > at and p0 < block_end and e.len != 0) {
            const from = @max(at, p0);
            const to = @min(block_end, p1);
            const dst = @as(usize, e.start) + (from - p0);
            const n = to - from;
            if (dst + n <= arena_mem.len) {
                @memcpy(arena_mem[dst..][0..n], block[from - at ..][0..n]);
            }
        }
        p0 = p1;
        if (p0 >= block_end) break;
    }
}

/// Zeroes every byte a restored snapshot did not bring back.
///
/// This is the price of a partial snapshot and it is not optional. The
/// arena being recovered into is normally the *surviving* shared segment,
/// which still holds the previous incarnation's bytes; a snapshot that
/// covers only its extents would otherwise leave every one of them
/// readable, just unreachable through the allocator. Unreachable is not
/// the same as absent: one stray offset read and a stale record looks
/// exactly like data. Zeroing makes the outcome of a recovery independent
/// of what the arena held beforehand, which is what lets the round-trip
/// test assert byte equality against a freshly written source arena.
///
/// Cost is one pass over the unused space, once per boot, and it shrinks to
/// nothing as the database fills up (the ranges are the tails of the three
/// regions, not the regions themselves).
fn zeroOutsideExtents(arena_mem: []u8, extents: [snap.EXTENT_COUNT]snap.Extent) void {
    // Clamp to the arena before filling gaps: on an arena too small to hold
    // a region at all, that region starts past the end and must collapse
    // onto it, or everything after the last region that does fit would be
    // skipped instead of zeroed.
    var cursor: usize = 0;
    for (extents) |e| {
        const start = @min(@as(usize, e.start), arena_mem.len);
        if (start > cursor) @memset(arena_mem[cursor..start], 0);
        cursor = @max(cursor, @min(@as(usize, e.end()), arena_mem.len));
    }
    if (cursor < arena_mem.len) @memset(arena_mem[cursor..], 0);
}

/// Blanks the extents a refused snapshot had already scattered into the
/// arena, so that rejecting a snapshot leaves a known-empty region rather
/// than a mixture of old and new bytes. The zeroing zeroOutsideExtents did
/// is deliberately not undone: bytes left over from the previous
/// incarnation are not a better starting point than a region known to be
/// empty, and the WAL replay that follows writes every byte it owns.
fn undoRestore(arena_mem: []u8, extents: [snap.EXTENT_COUNT]snap.Extent) void {
    for (extents) |e| {
        if (e.len != 0 and e.end() <= arena_mem.len) @memset(arena_mem[e.start..e.end()], 0);
    }
}

/// `art_index` is optional because it is only meaningful for an arena large
/// enough to contain the ART region at all. A small test arena (16 KB) has
/// no room for nodes rooted at ART_ROOT_OFFSET, and `ArtIndex.init` would
/// panic on the out-of-range bump word rather than return an error. Passing
/// null skips the index replay, which is correct: such an arena cannot hold
/// index operations.
pub fn recoverWal(allocator: std.mem.Allocator, path: [:0]const u8, arena_mem: []u8, art_index: ?*ArtIndex, regions: layout.Regions) !void {
    var rec_max: u32 = regions.record_start;
    var art_max: u32 = @intCast(regions.artStart());
    var str_max: u32 = @intCast(regions.stringDataStart());
    var index_ops = IndexOps{
        .keys = std.ArrayList(u8).init(allocator),
        .ops = std.ArrayList(IndexOps.IndexOp).init(allocator),
    };
    defer index_ops.deinit();

    // Phase 1: snapshot with CRC verification (two passes).
    var restored_snapshot = false;
    if (try loadSnapshot(allocator, path, arena_mem, regions)) |meta| {
        restored_snapshot = true;
        // Seed maxima from the restored bump words, so all three arenas
        // survive even with no further WAL replay. Each extent ends at its
        // region's bump by construction, so its end is a second, redundant
        // witness: it is used when the extent could not carry the word
        // itself (a truncated region, or a small arena with no bump word
        // at all) and can only ever agree with the word otherwise.
        const arena_rec = readWord(arena_mem, regions.recordBumpOffset(), regions.record_start);
        const arena_art = readWord(arena_mem, regions.artBumpOffset(), artStartOf(regions));
        const arena_str = readWord(arena_mem, regions.string_start, stringDataStartOf(regions));
        rec_max = @max(rec_max, @max(arena_rec, meta.record().end()));
        art_max = @max(arena_art, meta.art().end());
        art_max = @max(art_max, artStartOf(regions));
        str_max = @max(arena_str, meta.strings().end());
        str_max = @max(str_max, stringDataStartOf(regions));
        // Clamp seeds to arena bounds: a larger arena image truncated here
        // must not push bumps past the end.
        if (rec_max > arena_mem.len) rec_max = @as(u32, @intCast(arena_mem.len));
        if (art_max > arena_mem.len) art_max = @as(u32, @intCast(arena_mem.len));
        if (str_max > arena_mem.len) str_max = @as(u32, @intCast(arena_mem.len));
    }

    // Phase 1b: with no snapshot, the index is rebuilt from nothing.
    //
    // The ART lives in the arena, so it survived the crash holding every key
    // the previous incarnation had indexed -- including the ones whose index
    // operation never reached the log. The record bump below is derived from
    // the log alone and lands below those entries, so the next allocation
    // reuses offsets they still point at and a surviving key resolves to
    // somebody else's record: a read returns another row's values rather
    // than failing, which is the worst shape a recovery bug can take.
    //
    // Discarding the tree first removes the class. A snapshot is the
    // exception because its payload *is* the index, restored above.
    if (!restored_snapshot) resetIndex(arena_mem, regions);

    // Phase 2: WAL delta replay.
    var tally = SegmentTally{};
    replayWal(allocator, path, arena_mem, &rec_max, &art_max, &str_max, &index_ops, regions, &tally);

    // Phase 3: re-apply logical index operations. Must run before finalize,
    // which overwrites the ART bump from art_max; rebuilding the index moves
    // that bump, so the post-replay value is folded back in below.
    if (index_ops.ops.items.len > 0) {
        if (art_index) |idx| {
            _ = applyIndexOps(idx, &index_ops, regions, rec_max);
            const arena_art = readWord(arena_mem, regions.artBumpOffset(), artStartOf(regions));
            if (arena_art > art_max) art_max = arena_art;
        } else {
            std.debug.print(
                "[TakyonDB-Bootloader] WAL holds {d} index operation(s) but this arena has no ART region; the index is not rebuilt.\n",
                .{index_ops.ops.items.len},
            );
        }
    }

    finalize(arena_mem, rec_max, art_max, str_max, regions, &tally);
}

/// Empties the index region and re-seeds its bump word.
///
/// Called only when no snapshot was restored, so the tree is rebuilt purely
/// from the log's index operations. The region is zeroed rather than just
/// the root word so a node the next allocation lands on cannot inherit a
/// subtree, and a zero root is exactly the empty-tree state a rebuild starts
/// from.
///
/// The bump word is written back afterwards, which is the part that is easy
/// to miss: `ArtIndex.init` runs *before* recovery and claims the bump with a
/// compare-and-set that only fires on zero, so it will never run again. Left
/// at zero, the next node allocation starts at arena offset 0 -- the global
/// header -- and the rebuilt index writes over the region table. finalize
/// rewrites the bump from the replayed maximum, but only after the replay has
/// already allocated through it.
fn resetIndex(arena_mem: []u8, regions: layout.Regions) void {
    const art_start = regions.art_root;
    const art_end = art_start + regions.art_bytes;
    if (art_end > arena_mem.len) return; // Nothing sane to clear.
    @memset(arena_mem[art_start..art_end], 0);
    const bump_off = regions.artBumpOffset();
    if (bump_off + 4 <= arena_mem.len) {
        const bump: *u32 = @ptrCast(@alignCast(&arena_mem[bump_off]));
        bump.* = @intCast(regions.artStart());
    }
}

/// Loads and verifies the snapshot. Returns the extents it restored, or
/// null when no (valid) snapshot exists. A corrupt snapshot never poisons
/// the arena: it is skipped with a warning and the WAL still replays.
/// Snap path is derived from the WAL `path` arg as `<wal>.snap`.
///
/// Two passes, both mandatory. Pass 1 scans every block to find the footer
/// (which is last) and to count blocks, so the extents and the expected
/// block count are known before a single byte is written to the arena.
/// Pass 2 re-reads and scatters the payload while hashing it, and the CRC
/// from the footer is checked before the result is trusted. Splitting it
/// this way is what makes a torn snapshot detectable instead of
/// half-applied.
fn loadSnapshot(allocator: std.mem.Allocator, wal_path: [:0]const u8, arena_mem: []u8, regions: layout.Regions) !?SnapshotMeta {
    var snap_buf: [4096]u8 = undefined;
    const snap_path = try std.fmt.bufPrintZ(&snap_buf, "{s}.snap", .{wal_path});
    const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
        std.hash.crc.Crc32
    else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
        std.hash.crc.Crc32Ieee
    else
        std.hash.Crc32;

    const raw = try allocator.alloc(u8, 4096 + 4095);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as(*[4096]u8, @ptrFromInt(aligned_addr));

    // Pass 1: scan block count and remember the last block.
    const fd_scan = openExisting(snap_path) orelse return null;
    var blocks: usize = 0;
    var last: [4096]u8 = undefined;
    var truncated = false;
    while (readBlock(fd_scan, buf)) {
        blocks += 1;
        last = buf.*;
        if (blocks > blocksFor(arena_mem.len) + 1) {
            truncated = true;
            break;
        }
    }
    closeFd(fd_scan);
    if (truncated or blocks == 0) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot oversized or empty; ignoring.\n", .{});
        return null;
    }

    // Footer v3 in the last block:
    //   magic u32 [0..4], format version u32 [4..8], crc u32 [8..12],
    //   arena layout version u32 [12..16], flags u32 [16..20], then one u32
    //   length per extent [20..36], rest zeros.
    // Trusted only once magic, format version, layout version and the zero
    // tail all agree AND every length is provably the length of an extent
    // of THIS arena (extentsFromFooter).
    const footer_magic = std.mem.readInt(u32, last[MAGIC_OFFSET .. MAGIC_OFFSET + 4][0..4], .little);
    const footer_ver = std.mem.readInt(u32, last[VERSION_OFFSET .. VERSION_OFFSET + 4][0..4], .little);
    if (footer_ver == snap.CONTIGUOUS_V2_VERSION and isFooterV2Shape(&last)) {
        // Named explicitly, because this is the case that matters. A v2
        // snapshot is one contiguous arena prefix and its [16..20) /
        // [20..24) words are the ART and string BUMPS, not extent lengths.
        // Reading them as lengths would restore a plausible-looking arena
        // built from the wrong offsets, which is far worse than starting
        // over from the WAL - and there is no way to convert a v2 file in
        // place, because its payload is the 10 MB prefix image and this
        // build no longer knows how to interpret one. So the honest
        // outcome is a loud refusal plus WAL-only replay, which can only
        // recover what the WAL still holds. The name is printed because
        // the operator's next action (delete the file, or downgrade the
        // binary) depends on which format is sitting there.
        std.debug.print(
            "[TakyonDB-Bootloader] Snapshot is format v2 (one contiguous arena prefix of {d} bytes, with art/str bumps in the length words); this build only reads sparse v{d}. Rejecting it rather than reinterpreting its words as extents: that would restore the wrong offsets. Falling back to WAL-only replay, which can only recover what the WAL still holds.\n",
            .{ std.mem.readInt(u32, last[12..16], .little), snap.SNAPSHOT_VERSION },
        );
        return null;
    }
    if (footer_magic != FOOTER_MAGIC or footer_ver != snap.SNAPSHOT_VERSION) {
        if (isLegacyV1Shape(&last)) {
            std.debug.print("[TakyonDB-Bootloader] Snapshot is legacy v1 footer; rejecting as corrupt, WAL-only recovery.\n", .{});
        } else {
            std.debug.print("[TakyonDB-Bootloader] Snapshot footer magic/version mismatch; ignoring.\n", .{});
        }
        return null;
    }
    if (!isFooterV3Shape(&last)) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot has no v3 footer; ignoring.\n", .{});
        return null;
    }
    const footer_layout = std.mem.readInt(u32, last[12..16], .little);
    if (footer_layout != LAYOUT_VERSION) {
        std.debug.print(
            "[TakyonDB-Bootloader] Snapshot was taken on arena layout v{d} but this build speaks v{d}; ignoring.\n",
            .{ footer_layout, LAYOUT_VERSION },
        );
        return null;
    }
    // The table the snapshot was written against must be the table this
    // arena is using. The lengths alone cannot say where those bytes go: a
    // snapshot of a 2 GiB arena with a 256 MiB index region and a snapshot
    // of a 64 MiB one produce the same four numbers, and scattering the
    // first at the second's offsets corrupts the arena without failing.
    const snap_regions = snap.readFooterRegions(&last) orelse {
        std.debug.print("[TakyonDB-Bootloader] Snapshot footer carries no region table; ignoring.\n", .{});
        return null;
    };
    layout.validateRegions(snap_regions, arena_mem.len) catch |err| {
        std.debug.print(
            "[TakyonDB-Bootloader] Snapshot region table is not valid for this arena ({s}); ignoring.\n",
            .{@errorName(err)},
        );
        return null;
    };
    if (!std.meta.eql(snap_regions, regions)) {
        std.debug.print(
            "[TakyonDB-Bootloader] Snapshot was taken with a different region table than this arena uses; ignoring. Start the daemon with the same takyon.json it was written with, or delete the snapshot and let the log replay.\n",
            .{},
        );
        return null;
    }
    const claimed_crc = std.mem.readInt(u32, last[8..12], .little);
    const extents = extentsFromFooter(&last, arena_mem.len, regions) orelse {
        std.debug.print("[TakyonDB-Bootloader] Snapshot extents are not extents of this arena; ignoring.\n", .{});
        return null;
    };
    const payload: usize = blk: {
        var n: usize = 0;
        for (extents) |e| n += e.len;
        break :blk n;
    };
    // The file must be exactly the payload plus the footer block: one block
    // short is a torn tail, one block long is a stale or spliced footer,
    // and neither may be reinterpreted.
    if (blocks - 1 != blocksFor(payload)) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot size mismatch; ignoring.\n", .{});
        return null;
    }
    const data_blocks = blocks - 1;

    // Pass 2: scatter the payload while hashing, then verify the CRC.
    const fd = openExisting(snap_path) orelse return null;
    defer closeFd(fd);

    // Everything the extents do not cover is zeroed BEFORE the copy. The
    // arena being recovered into is normally the surviving shared segment,
    // still full of the previous incarnation's bytes, and a partial
    // snapshot would otherwise leave every one of them readable; see
    // zeroOutsideExtents for why unreachable is not good enough.
    zeroOutsideExtents(arena_mem, extents);

    std.debug.print("[TakyonDB-Bootloader] Recovering from Snapshot...\n", .{});
    var hasher = Crc32.init();
    var i: usize = 0;
    while (i < data_blocks) : (i += 1) {
        if (!readBlock(fd, buf)) {
            std.debug.print("[TakyonDB-Bootloader] Snapshot shrank mid-read; ignoring.\n", .{});
            undoRestore(arena_mem, extents);
            return null;
        }
        placePayloadBlock(arena_mem, extents, i * 4096, buf);
        hasher.update(buf);
    }
    if (hasher.final() != claimed_crc) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot CRC mismatch; ignoring snapshot.\n", .{});
        undoRestore(arena_mem, extents);
        return null;
    }
    return SnapshotMeta{ .extents = extents, .regions = regions };
}

/// Formats `<base>.NNNNNN` (zero-padded 6 digits, sentinel-terminated)
/// into `out`. Mirrors wal.zig's private formatter (kept local so replay
/// never depends on WAL writer internals).
fn formatSegmentPathZ(out: *[4096]u8, base: []const u8, n: u32) ![:0]u8 {
    if (out.len < base.len + 8) return error.NoSpace;
    @memcpy(out[0..base.len], base);
    out[base.len] = '.';
    var v = n;
    var i: usize = 6;
    while (i > 0) : (i -= 1) {
        out[base.len + i] = @as(u8, @intCast(v % 10)) + '0';
        v /= 10;
    }
    out[base.len + 7] = 0;
    return out[0 .. base.len + 7 :0];
}

/// Multi-segment replay: replays the live `path` first, then
/// `path.000000`, `path.000001`, ... in order while files exist (stops at
/// the first missing N; capped at MAX_SEGMENTS). Each segment replays with
/// identical CRC/stop rules via replayOneSegment; the rec/art/str maxima
/// accumulate across all segments.
fn replayWal(
    allocator: std.mem.Allocator,
    path: [:0]const u8,
    arena_mem: []u8,
    rec_max: *u32,
    art_max: *u32,
    str_max: *u32,
    index_ops: *IndexOps,
    regions: layout.Regions,
    tally: *SegmentTally,
) void {
    tally.segments += 1;
    replayOneSegment(allocator, path, arena_mem, rec_max, art_max, str_max, index_ops, regions, tally);
    var n: u32 = 0;
    while (n < MAX_SEGMENTS) : (n += 1) {
        var sbuf: [4096]u8 = undefined;
        const seg = formatSegmentPathZ(&sbuf, path[0..path.len], n) catch break;
        const probe = openExisting(seg) orelse break; // stop at first missing N
        closeFd(probe);
        tally.segments += 1;
        replayOneSegment(allocator, seg, arena_mem, rec_max, art_max, str_max, index_ops, regions, tally);
    }
}

/// What one segment replay actually saw.
///
/// A crash-consistency failure reports itself as "this key is not in the
/// index", and that is the end of the diagnostic: the entry was never
/// written, it was written and not read, or it was read and refused. These
/// counters are what separate the three, and they are worth their cost
/// because the alternative is guessing.
const SegmentTally = struct {
    segments: u32 = 0,
    sectors: u32 = 0,
    byte_deltas: u32 = 0,
    index_ops: u32 = 0,
    /// Set when the replay stopped before end-of-file, with the sector it
    /// stopped on. A padded sector is a normal stop; a CRC failure or an
    /// out-of-arena offset is not, and this is where the two are told apart.
    stopped_at_sector: ?u32 = null,
    stop_reason: []const u8 = "end of file",
};

/// Replays one WAL file's entries onto the arena. Stops at the first
/// corrupt sector or entry; everything before it is valid by CRC.
/// Tracks THREE maxima by offset range:
///   < ART_ROOT_OFFSET     -> record max
///   < STRING_ARENA_START  -> ART max
///   else                  -> STRING max
fn replayOneSegment(
    allocator: std.mem.Allocator,
    path: [:0]const u8,
    arena_mem: []u8,
    rec_max: *u32,
    art_max: *u32,
    str_max: *u32,
    index_ops: *IndexOps,
    regions: layout.Regions,
    tally: *SegmentTally,
) void {
    // Buffer layout. The low CARRY_REGION bytes hold the tail of an entry
    // split across sector boundaries; the final page is the sector just
    // read. CARRY_REGION is three sectors rather than one on purpose: an
    // entry may be up to MAX_ENTRY_LEN payload plus its header, which spans
    // three 4K sectors, and the carry is measured across the pending
    // leftover AND the sector just read. With a one-page carry region,
    // `CARRY_REGION - carry_len` underflowed and aborted the daemon on a
    // real log; carryTail now also refuses to propagate a tail too long
    // to be a real entry, so the region is provably large enough.
    const raw = allocator.alloc(u8, CARRY_REGION + 4096 + 4095) catch return;
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0 .. CARRY_REGION + 4096];

    const fd = openExisting(path) orelse return;
    defer closeFd(fd);

    const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
        std.hash.crc.Crc32
    else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
        std.hash.crc.Crc32Ieee
    else
        std.hash.Crc32;

    var leftover_len: usize = 0;
    var sector_idx: u32 = 0;

    while (true) {
        // Read directly into the last 4KB page of our aligned buffer.
        if (!readBlock(fd, @ptrCast(&buf[CARRY_REGION]))) break;
        tally.sectors += 1;

        // Validation: torn write / corruption.
        const crc = Crc32.hash(buf[CARRY_REGION .. CARRY_REGION + SECTOR_PAYLOAD]);
        const expected_crc = std.mem.readInt(u32, buf[CARRY_REGION + SECTOR_PAYLOAD ..][0..4], .little);
        if (crc != expected_crc) {
            std.debug.print("[WARNING] CRC32 corruption detected in sector {d}. Truncating recovery. Starting database with valid prior records.\n", .{sector_idx});
            tally.stopped_at_sector = sector_idx;
            tally.stop_reason = "CRC mismatch";
            break;
        }
        sector_idx += 1;

        const start_idx = CARRY_REGION - leftover_len;
        // The active stream only includes the 4092 bytes of payload
        const end_idx = CARRY_REGION + SECTOR_PAYLOAD;
        var cursor: usize = start_idx;
        // Bytes at the end of this sector that begin an entry continuing
        // into the next one. Padding is deliberately NOT carried: see
        // carryTail.
        var carry_len: usize = 0;

        while (cursor < end_idx) {
            const available = end_idx - cursor;
            if (available < @sizeOf(WalEntryHeader)) {
                carry_len = carryTail(.at_boundary, buf, cursor, end_idx);
                break; // Need more bytes for header next read
            }

            var header: WalEntryHeader = undefined;
            std.mem.copyForwards(u8, std.mem.asBytes(&header), buf[cursor .. cursor + @sizeOf(WalEntryHeader)]);

            if (header.length == 0) {
                // Zero padding: this batch ended at an entry boundary.
                // The next sector is a NEW batch, not the end of the log,
                // so stop scanning this sector only and keep reading.
                // Aborting the whole segment here silently discarded every
                // entry written after the first padded sector.
                break;
            }
            if (@as(u32, header.length) > MAX_ENTRY_LEN) {
                carry_len = carryTail(.bad_length, buf, cursor, end_idx);
                break; // Corrupt length; stop.
            }
            if (@as(u8, @intFromEnum(header.kind)) > MAX_ENTRY_KIND) {
                // A kind this build does not know means the log was written
                // by a newer format. Stop rather than guess: interpreting
                // the record as the wrong shape would produce a
                // plausible-looking but wrong arena, which is worse than
                // recovering a prefix.
                std.debug.print("[TakyonDB-Bootloader] WAL record kind {d} is newer than this build understands; stopping recovery.\n", .{@as(u8, @intFromEnum(header.kind))});
                carry_len = carryTail(.unknown_kind, buf, cursor, end_idx);
                break;
            }

            if (available < @sizeOf(WalEntryHeader) + header.length) {
                carry_len = carryTail(.mid_entry, buf, cursor, end_idx);
                break; // Need more bytes for payload next read
            }

            const payload_start = cursor + @sizeOf(WalEntryHeader);
            const payload_end = payload_start + header.length;

            if (header.kind == .index_op) {
                // A logical index write, not a byte copy. The payload is the
                // key and `offset` is the value it binds to, so there is
                // nothing to restore into the arena here: the ART is rebuilt
                // from these in applyIndexOps once the whole log is read.
                // Deliberately not touching the maxima — `offset` is a value
                // offset, not an arena extent, and folding it into art_max
                // would push the ART bump to a value nothing allocated.
                index_ops.add(buf[payload_start..payload_end], header.offset);
                tally.index_ops += 1;
                cursor += @sizeOf(WalEntryHeader) + header.length;
                continue;
            }

            // Widen before adding. A misaligned or corrupt scan can present
            // an offset near 2^32, and `offset + length` in u32 panics in
            // Debug builds — a log file must never be able to abort the
            // daemon. Widen to usize, bounds-check against the arena, and
            // treat anything out of range as the end of the valid prefix.
            const end_offset: usize = @as(usize, header.offset) + @as(usize, header.length);
            if (end_offset > arena_mem.len) {
                // A header naming an offset past the arena is what a stream
                // that lost its place looks like: the bytes here are payload,
                // not a header. The position and the bytes are reported so
                // the desync can be located exactly rather than inferred.
                tally.stopped_at_sector = sector_idx;
                tally.stop_reason = "entry extends past the arena";
                std.debug.print(
                    "[WARNING] Lost the stream at sector {d}, cursor {d} of {d} (carried {d} in). " ++
                        "Read offset={d} length={d} kind={d}.\n",
                    .{
                        sector_idx,
                        cursor - start_idx,
                        SECTOR_PAYLOAD,
                        leftover_len,
                        header.offset,
                        header.length,
                        @as(u8, @intFromEnum(header.kind)),
                    },
                );
                break; // Out of arena; stop.
            }

            // Rehydrate isomorphic memory directly to SharedArena
            std.mem.copyForwards(
                u8,
                arena_mem[@as(usize, header.offset)..end_offset],
                buf[payload_start..payload_end],
            );
            tally.byte_deltas += 1;

            // Track THREE maxima by offset range. Ring/header writes below
            // ART_ROOT_OFFSET fold into the record max but stay below
            // RECORD_BUMP_INIT, so they never move the bump.
            const bounded: u32 = @intCast(end_offset);
            if (header.offset < regions.art_root) {
                if (bounded > rec_max.*) rec_max.* = bounded;
            } else if (header.offset < regions.string_start) {
                if (bounded > art_max.*) art_max.* = bounded;
            } else {
                if (bounded > str_max.*) str_max.* = bounded;
            }

            cursor += @sizeOf(WalEntryHeader) + header.length;
        }

        // Carry a genuinely split entry to the front of the next sector so
        // its header is re-read in the right place.
        leftover_len = carry_len;
        if (leftover_len > 0) {
            std.mem.copyForwards(u8, buf[CARRY_REGION - leftover_len .. CARRY_REGION], buf[end_idx - leftover_len .. end_idx]);
        }
    }
}

/// Bytes reserved at the front of the replay buffer for a split entry's
/// carried tail. Three sectors: an entry is at most MAX_ENTRY_LEN payload
/// plus a header, and carryTail caps the tail at exactly that, so the
/// region can never be overrun.
const CARRY_REGION: usize = 3 * 4096;

/// How many bytes at the end of a sector have to be carried into the next one.
///
/// A sector is written one of two ways. A FULL sector has no padding and may
/// end mid-entry, so its tail must be carried. A PADDED sector ends at an
/// entry boundary and its zero tail must NOT be carried: prepending those
/// zeros to the next sector would shift its framing, and the misaligned
/// `length` read then trips the MAX_ENTRY_LEN check and throws away every
/// entry behind it.
///
/// Telling the two apart from the bytes alone is a guess, and this reader made
/// it for years: an all-zero tail was taken to be padding. It is wrong for
/// any entry whose carried bytes happen to be zero, and an eight-zero-byte
/// inline delta is a `float64` field set to 0.0 or a `uint32` set to 0, both
/// of which the SDK writes routinely. Dropping that carry leaves the next
/// sector being parsed from the middle of an entry, where its bytes are read
/// as a header: the framing is lost for the rest of that sector, and every
/// entry behind it is applied to offsets the log never named.
///
/// So the rule uses the writer's own guarantee instead of the content. The
/// idle flush path refuses to emit a sector whose slack is under
/// MIN_PADDING, so a padded sector always leaves at least that many bytes:
/// a tail SHORTER than MIN_PADDING cannot be padding and is carried whatever
/// it contains. For a longer tail the content test is safe, because only
/// padding is long enough to reach it.
/// Why the scan of a sector stopped. See carryTail for what it decides.
const Stop = enum {
    /// Fewer bytes than a header remain at an entry boundary.
    at_boundary,
    /// A complete header said the entry is longer than the sector.
    mid_entry,
    /// The header claimed a length this build cannot accept.
    bad_length,
    /// The header named an entry kind this build does not know.
    unknown_kind,
};

fn carryTail(stop: Stop, buf: []const u8, cursor: usize, end_idx: usize) usize {
    const MIN_PADDING = @import("wal.zig").MIN_PADDING;
    const tail = end_idx - cursor;
    // A tail longer than a whole entry is corrupt framing, not a split: the
    // length that produced it was never valid, so the scan has already lost
    // its place. Carrying it forward only propagates the damage, and an
    // unbounded tail is what overflowed the carry region before it was sized
    // to three sectors. Drop it.
    if (tail > MAX_ENTRY_LEN + @sizeOf(WalEntryHeader)) return 0;
    // Too short for the writer to have padded, so it is an entry that
    // continues -- including when a header is the thing being split.
    if (tail < MIN_PADDING) return tail;
    // A header said the entry is longer than this sector.
    if (stop != .at_boundary) return tail;
    // Long enough to be padding: only an all-zero run qualifies.
    for (buf[cursor..end_idx]) |b| {
        if (b != 0) return tail; // An entry header starting here.
    }
    return 0;
}

fn recordPayloadOffset(regions: layout.Regions, len: usize) !u32 {
    const at: usize = regions.record_start + 8;
    if (at + len > @as(usize, regions.record_start) + regions.record_bytes) return error.PayloadTooBig;
    return @intCast(at);
}

/// `report` is null for the callers that do not want the tally (tests that
/// assert on the arena, and any future path that replays speculatively).
fn finalize(
    arena_mem: []u8,
    rec_max: u32,
    art_max: u32,
    str_max: u32,
    regions: layout.Regions,
    report: ?*const SegmentTally,
) void {
    // Idempotent: writing the same aligned maxima twice changes nothing.
    // Each bump is clamped to its init and 8-aligned; out-of-range bumps
    // on small arenas (tests) are skipped instead of panicking.
    //
    // Each bump is written from what the log proves was written, not from
    // what the arena happens to contain. The arena is a superset: the
    // process died holding writes that never reached the log, and with no
    // snapshot those are unreachable anyway, because resetIndex has already
    // emptied the tree the keys lived in. Handing that space back out is
    // what keeps an arena from growing without bound across crashes.
    const rec_bump_off = regions.recordBumpOffset();
    const art_bump_off = regions.artBumpOffset();
    const str_bump_off = regions.string_start;
    if (rec_bump_off + 4 <= arena_mem.len) {
        const bump_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[rec_bump_off])));
        bump_ptr.* = align8(@max(rec_max, regions.record_start));
    }
    if (art_bump_off + 4 <= arena_mem.len) {
        const art_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[art_bump_off])));
        art_ptr.* = align8(@max(art_max, artStartOf(regions)));
    }
    if (str_bump_off + 4 <= arena_mem.len) {
        const str_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[str_bump_off])));
        str_ptr.* = align8(@max(str_max, stringDataStartOf(regions)));
    }

    // 3. IPC channel cleanup: clear the full ring region.
    if (layout.RING_OFFSET <= rec_bump_off and rec_bump_off <= arena_mem.len) {
        @memset(arena_mem[layout.RING_OFFSET..rec_bump_off], 0);
    }

    std.debug.print("[TakyonDB-Bootloader] Isomorphic recovery completed. Bumps rec={} art={} str={}.\n", .{ rec_max, art_max, str_max });
    if (report) |t| {
        std.debug.print(
            "[TakyonDB-Bootloader] Replay saw {d} sector(s) across {d} segment(s): " ++
                "{d} byte delta(s), {d} index operation(s); stopped at sector {any} ({s}).\n",
            .{ t.sectors, t.segments, t.byte_deltas, t.index_ops, t.stopped_at_sector, t.stop_reason },
        );
    }
}

test "WAL multi-sector entry round-trip (5000B payload)" {
    const WalManager = @import("wal.zig").WalManager;
    const WalHeader = @import("wal.zig").WalEntryHeader;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/roundtrip.takyon", .{dirpath});

    // 6-byte header + 5000B payload = 5006B > 4092B sector payload,
    // so the entry always spans two sectors on disk.
    const payload_len: usize = 5000;
    const arena_size: usize = 65536;
    const regions = layout.defaultRegions(arena_size);
    const payload_off = try recordPayloadOffset(regions, payload_len);

    var payload: [5000]u8 = undefined;
    for (&payload, 0..) |*b, i| b.* = @as(u8, @intCast((i * 31 + 7) % 251));

    var wal = try WalManager.init(allocator, path);
    const header = WalHeader{ .offset = payload_off, .length = @as(u16, @intCast(payload_len)), .kind = .arena_write };
    try wal.writeToBuffer(std.mem.asBytes(&header));
    try wal.writeToBuffer(&payload);
    try wal.flushBuffer();
    wal.shutdown();

    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    try recoverWal(allocator, path, arena, null, regions);
    try std.testing.expectEqualSlices(u8, &payload, arena[payload_off .. payload_off + payload_len]);
}

/// Writes one WAL entry the way processDelta does: 6-byte header then
/// payload, both through the byte-stream writer.
fn writeEntry(wal: anytype, offset: u32, payload: []const u8) !void {
    try writeEntryOfKind(wal, offset, payload, .arena_write);
}

fn writeEntryOfKind(wal: anytype, offset: u32, payload: []const u8, kind: EntryKind) !void {
    const header = WalEntryHeader{ .offset = offset, .length = @as(u16, @intCast(payload.len)), .kind = kind };
    try wal.writeToBuffer(std.mem.asBytes(&header));
    try wal.writeToBuffer(payload);
}

test "WAL replay survives MULTIPLE partial sectors" {
    // Regression: every flush that does not fill a sector writes zero
    // padding after the last entry, and the replay parser must treat that
    // padding as the end of ONE batch rather than the end of the whole log.
    // It used to abort the entire segment at the first padded sector, so
    // only the first batch was ever recovered and the loss was silent.
    //
    // The single-batch case is covered by the 5000B round-trip test above;
    // that test writes one entry, so the only padding is in the final
    // sector and there is nothing after it to lose.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/multi-partial.takyon", .{dirpath});

    // Three batches, each flushed separately so each becomes its own
    // padded (partial) sector. Payload byte is unique per batch+index so
    // a wrong-extent read cannot accidentally match.
    const batches = 3;
    const per_batch = 4;
    const arena_size: usize = 16384;
    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, batches * per_batch * 8);

    var wal = try WalManager.init(allocator, path);
    for (0..batches) |b| {
        for (0..per_batch) |i| {
            const idx = b * per_batch + i;
            const off: u32 = base + @as(u32, @intCast(idx * 8));
            const byte = [_]u8{@intCast(0xA0 + idx)};
            try writeEntry(&wal, off, &byte);
        }
        try wal.flushBuffer();
    }
    wal.shutdown();

    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    try recoverWal(allocator, path, arena, null, regions);

    for (0..batches) |b| {
        for (0..per_batch) |i| {
            const idx = b * per_batch + i;
            const off: usize = base + idx * 8;
            try std.testing.expectEqual(
                @as(u8, @intCast(0xA0 + idx)),
                arena[off],
            );
        }
    }
}

test "WAL replay survives many flushed batches (2000 entries)" {
    // Same defect at scale: the chaos benchmark flushes continuously, so
    // a real log is a long run of padded sectors. Assert the count, not a
    // spot check, so a partial recovery cannot pass by luck.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/many-batches.takyon", .{dirpath});

    const total = 2000;
    const per_batch = 7;
    // Big enough that the record region holds all 2000 four-byte entries.
    const arena_size: usize = 1024 * 1024;

    var wal = try WalManager.init(allocator, path);
    // 2000 entries at four bytes each, so the record region has to be big
    // enough to hold them: a payload spread across two regions would come
    // back with a bump word in the middle, which is a fixture problem, not a
    // replay one.
    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, total * 4);

    var written: usize = 0;
    while (written < total) {
        const n = @min(per_batch, total - written);
        for (0..n) |i| {
            const idx = written + i;
            const off: u32 = base + @as(u32, @intCast(idx * 4));
            const byte = [_]u8{@intCast(idx % 251)};
            try writeEntry(&wal, off, &byte);
        }
        written += n;
        try wal.flushBuffer();
    }
    wal.shutdown();

    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    try recoverWal(allocator, path, arena, null, regions);

    // Count how many entries actually landed, in order to report the
    // shortfall instead of failing on the first mismatch.
    var recovered: usize = 0;
    while (recovered < total) : (recovered += 1) {
        const off: usize = base + recovered * 4;
        if (arena[off] != @as(u8, @intCast(recovered % 251))) break;
    }
    try std.testing.expectEqual(@as(usize, total), recovered);
}

test "WAL fidelity: every entry position inside a sector restores byte-exact" {
    // The sweep the other tests are a sample of. Each of them puts one entry
    // in one place: a 5000B payload that always splits at the same offset, a
    // boundary test that only varies the sector's slack. What none of them
    // does is move an entry's START across the sector boundary, and that is
    // the dimension the reader is actually fragile on -- it has to decide,
    // per sector, whether the tail is a split entry to carry forward or zero
    // padding to drop, and it decides by content.
    //
    // So: place a filler of a chosen length so the next entry starts at byte
    // `pad` of the sector payload, then write entries of a chosen size until
    // the log spans several sectors, replay, and compare every byte written.
    // A reader that mis-carries, mis-parses or mis-offsets shows up as a
    // mismatch rather than as a truncated tail nobody notices.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/fidelity.takyon", .{dirpath});

    const arena_size: usize = 1024 * 1024;
    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, 8192);

    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);

    // Derived from the index so a mismatch names the entry that is wrong.
    const pattern = struct {
        fn byteAt(seed: u32, i: usize) u8 {
            return @intCast((@as(usize, seed) * 37 + i * 131 + 11) % 251 + 1);
        }
    }.byteAt;

    // Every position where an entry of this size has its header or its
    // payload crossing the boundary, plus the exact-fill position.
    const sizes = [_]usize{ 8, 48 };
    var checked: usize = 0;
    var header_straddles: usize = 0;
    var payload_straddles: usize = 0;
    var exact_fills: usize = 0;
    for (sizes) |size_in| {
        const size = size_in;
        const first_pad = SECTOR_PAYLOAD - size - @sizeOf(WalEntryHeader) + 1;
        var pad = first_pad;
        while (pad <= SECTOR_PAYLOAD) : (pad += 1) {
            // A zero-length entry is the padding terminator and is never
            // emitted, so the filler cannot be empty.
            if (pad < @sizeOf(WalEntryHeader) + 1) continue;
            const entry_end = pad + @sizeOf(WalEntryHeader) + size;
            if (pad + @sizeOf(WalEntryHeader) > SECTOR_PAYLOAD) {
                header_straddles += 1;
            } else if (entry_end > SECTOR_PAYLOAD) {
                payload_straddles += 1;
            } else {
                exact_fills += 1;
            }
            std.fs.cwd().deleteFile(path) catch {};

            @memset(arena, 0);
            var wal = try WalManager.init(allocator, path);

            // The filler: header plus payload, totalling exactly `pad` bytes
            // of the sector payload, so the next entry starts at `pad`.
            const filler_len = pad - @sizeOf(WalEntryHeader);
            const filler_off: u32 = base;
            var filler: [SECTOR_PAYLOAD]u8 = undefined;
            for (filler[0..filler_len], 0..) |*b, i| b.* = pattern(1, i);
            try writeEntry(&wal, filler_off, filler[0..filler_len]);

            // Enough entries of this size to cross the boundary and fill the
            // sector it lands in.
            var written: usize = 0;
            var at: u32 = @intCast(base + filler_len);
            while (written < 8) : (written += 1) {
                var payload: [48]u8 = undefined;
                for (payload[0..size], 0..) |*b, i| b.* = pattern(@intCast(100 + written), i);
                try writeEntry(&wal, at, payload[0..size]);
                at += @intCast(@sizeOf(WalEntryHeader) + size);
            }
            try wal.flushBuffer();
            wal.shutdown();

            @memset(arena, 0);
            try recoverWal(allocator, path, arena, null, regions);

            // Every byte written must come back. Compare against the bytes
            // this iteration wrote, not against a count.
            for (filler[0..filler_len], 0..) |b, i| {
                if (arena[filler_off + i] != b) {
                    std.debug.print(
                        "[test] size={d} pad={d}: filler byte {d} is 0x{x:0>2}, expected 0x{x:0>2}\n",
                        .{ size, pad, i, arena[filler_off + i], b },
                    );
                    return error.TestExpectedEqual;
                }
            }
            var entry: usize = 0;
            var entry_at: usize = base + filler_len;
            while (entry < 8) : (entry += 1) {
                for (0..size) |i| {
                    const want = pattern(@intCast(100 + entry), i);
                    if (arena[entry_at + i] != want) {
                        std.debug.print(
                            "[test] size={d} pad={d}: entry {d} byte {d} is 0x{x:0>2}, expected 0x{x:0>2}\n",
                            .{ size, pad, entry, i, arena[entry_at + i], want },
                        );
                        return error.TestExpectedEqual;
                    }
                }
                entry_at += @sizeOf(WalEntryHeader) + size;
            }
            checked += 1;
        }
    }

    // If the sweep silently degenerated, it would pass for the wrong reason,
    // which is the failure mode this test exists to avoid. So the two reader
    // paths it exists to cover are counted as they run: an entry whose HEADER
    // crosses the boundary, and one whose PAYLOAD crosses it. Both must be
    // non-zero, or the sweep proved less than it claims.
    try std.testing.expect(header_straddles > 0);
    try std.testing.expect(payload_straddles > 0);
    try std.testing.expect(checked == header_straddles + payload_straddles - exact_fills);
}

test "WAL replay does not carry padding past a full sector" {
    // The reader's two cases are told apart by the writer's guarantee: a
    // sector is either exactly full (its tail is a split entry, carry it)
    // or padded by at least MIN_PADDING (its tail is padding, drop it). A
    // tail of 1..5 bytes is ambiguous, so the idle flush path refuses to
    // emit one. This test drives that exact boundary: it fills sectors to
    // within 1..5 bytes of the payload limit and then keeps going, so the
    // writer has to choose between a short padded sector and a split entry.
    //
    // The old reader guessed by content, and on a full sector whose split
    // entry continued with zero bytes it dropped the carry and read the next
    // sector's payload as a header, which aborted the daemon on a real log.
    const WalManager = @import("wal.zig").WalManager;
    const MIN_PADDING = @import("wal.zig").MIN_PADDING;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/boundary.takyon", .{dirpath});

    const arena_size: usize = 1024 * 1024;
    const total = 600;
    // Vary the payload so the sector lands on every slack in 1..5 across
    // runs, and keep entries small enough that a full sector holds many.
    const payload_len = 5;

    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, total * (8 + payload_len));

    var wal = try WalManager.init(allocator, path);
    for (0..total) |i| {
        const off: u32 = base + @as(u32, @intCast(i * 8));
        const bytes = [_]u8{@intCast(i % 251)} ** payload_len;
        try writeEntry(&wal, off, &bytes);
        // Non-forced flush: this is the path that must never emit an
        // ambiguous short tail.
        try wal.flushIfUnambiguous();
    }
    try wal.flushBuffer();
    wal.shutdown();

    // Every entry written must come back. A dropped carry shows up here as
    // a missing or mismatched byte, not as a silent truncation.
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    try recoverWal(allocator, path, arena, null, regions);

    var recovered: usize = 0;
    while (recovered < total) : (recovered += 1) {
        const off: usize = base + recovered * 8;
        if (arena[off] != @as(u8, @intCast(recovered % 251))) break;
    }
    try std.testing.expectEqual(@as(usize, total), recovered);
    // The guarantee is only sound if a padding run is long enough to hold a
    // whole entry header, so pin that relationship rather than the literal.
    try std.testing.expect(@sizeOf(WalEntryHeader) <= MIN_PADDING);
}

test "WAL index_op records rebuild the ART on replay" {
    // takyon_insert_index mutates the ART in shared memory and writes no
    // arena bytes, so before format v2 every key indexed after the last
    // snapshot was lost on crash. These records carry the key so recovery
    // can re-apply the operation.
    //
    // The arena has to be full size here: ArtIndex.init resolves the bump
    // word at ART_ROOT_OFFSET, so a 16 KB test arena cannot host the tree at
    // all. That is why recoverWal takes an optional index.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/indexop.takyon", .{dirpath});

    const arena_size = layout.STRING_ARENA_START + (1 * 1024 * 1024);
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);

    // Round 1: the "crashed" writer. Keys live at value_offset, payload is
    // the key, exactly as processDelta encodes a DELTA_INDEX_OP.
    // The record bytes travel too, in the same order the client pushes them:
    // the index operation first, then the value. A log with only the index
    // operations is the crash-in-the-middle case, and it is covered by its
    // own test below.
    // Offsets inside the record region, where a record actually lives. The
    // replay's index pass now requires that: an entry naming an offset below
    // the record region describes bytes that are not a record at all.
    const regions = layout.defaultRegions(arena.len);
    const keys = [_][]const u8{ "alpha", "bravo", "charlie", "delta", "echo" };
    var values: [keys.len]u32 = undefined;
    const bytes = [_]u8{ 0xAA, 0xBB };
    var wal = try WalManager.init(allocator, path);
    for (keys, 0..) |key, i| {
        values[i] = @intCast(regions.record_start + 8 + i * 64);
        try writeEntryOfKind(&wal, values[i], key, .index_op);
        try writeEntryOfKind(&wal, values[i], &bytes, .arena_write);
    }
    try wal.flushBuffer();
    wal.shutdown();

    // Round 2: a fresh arena, as after SIGKILL.
    @memset(arena, 0);
    var art_index = ArtIndex.init(arena, regions.art_root, regions.artBumpOffset(), @intCast(regions.artStart()));
    try recoverWal(allocator, path, arena, &art_index, regions);

    for (keys, 0..) |key, i| {
        const found = art_index.search(key) orelse {
            std.debug.print("[test] key '{s}' missing after replay\n", .{key});
            return error.TestExpectedEqual;
        };
        try std.testing.expectEqual(values[i], found);
    }

    // A key that was never logged must NOT be findable: this asserts the
    // replay is driven by the log and not by leftover arena bytes.
    try std.testing.expect(art_index.search("foxtrot") == null);
}

test "an index operation whose record never reached the log is dropped" {
    // Deltas are independent ring entries, so the index operation -- the
    // first thing pushed for a record -- can be durable while the value
    // deltas behind it were still queued at the crash. Applying it anyway
    // leaves a key resolving to an offset above the record bump, which the
    // next allocation then reuses: the key reads somebody else's record
    // instead of failing. The entry has to go.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/orphan.takyon", .{dirpath});

    const arena_size = layout.STRING_ARENA_START + (1 * 1024 * 1024);
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);

    const regions = layout.defaultRegions(arena.len);
    const kept_at: u32 = @intCast(regions.record_start + 8);
    const orphan_at: u32 = @intCast(regions.record_start + 4096);

    // "kept" gets its bytes; "orphan" only gets the index operation.
    const kept_bytes = [_]u8{ 1, 2, 3, 4 };
    var wal = try WalManager.init(allocator, path);
    try writeEntryOfKind(&wal, kept_at, "kept", .index_op);
    try writeEntryOfKind(&wal, kept_at, &kept_bytes, .arena_write);
    try writeEntryOfKind(&wal, orphan_at, "orphan", .index_op);
    try wal.flushBuffer();
    wal.shutdown();

    var art_index = ArtIndex.init(arena, regions.art_root, regions.artBumpOffset(), @intCast(regions.artStart()));
    try recoverWal(allocator, path, arena, &art_index, regions);

    try std.testing.expectEqual(@as(?u32, kept_at), art_index.search("kept"));
    try std.testing.expect(art_index.search("orphan") == null);
}

test "REPLAY: a captured log is framed the way the writer framed it" {
    // Offline frame checker, driven by TAKYON_WAL_REPLAY=<path to a .takyon>.
    // A crash-consistency failure is timing-dependent: the run that caught one
    // cannot be re-triggered on demand, so the suite keeps the log and this is
    // how it gets looked at.
    //
    // The invariant is the writer's, not the reader's. `writeToBuffer` either
    // fills the sector exactly (4092 bytes of entry data) or the flush pads
    // the remainder with zeros, and the idle path refuses to pad with fewer
    // than MIN_PADDING bytes left. So every sector is exactly one of:
    //
    //   full     the entries consume the whole payload, possibly ending
    //            mid-entry -- the rest of that entry opens the next sector;
    //   padded   the entries stop at a boundary and at least MIN_PADDING zero
    //            bytes follow;
    //   neither  anything else, which is where the writer and this reader
    //            disagree and where a desync begins.
    //
    // Deliberately independent of replayOneSegment: this carries a split
    // entry forward unconditionally, because a partial entry at the end of a
    // sector means the sector was filled and padding is only ever written at a
    // boundary. Where the two disagree about that is the finding.
    const SECTOR_SIZE: usize = @import("wal.zig").SECTOR_SIZE;
    const MIN_PADDING: usize = @import("wal.zig").MIN_PADDING;
    const CARRY: usize = 3 * SECTOR_SIZE;
    const path_z = std.posix.getenv("TAKYON_WAL_REPLAY") orelse return error.SkipZigTest;
    const path: []const u8 = path_z;

    var f = try std.fs.cwd().openFile(path, .{});
    defer f.close();
    const size = try f.getEndPos();
    std.debug.print("[replay] {s}: {d} bytes, {d} sector(s)\n", .{ path, size, size / SECTOR_SIZE });

    const Crc32 = std.hash.crc.Crc32;
    // Two regions, like the engine's: the carry in front, the sector read
    // directly into the back page.
    var buf: [CARRY + SECTOR_SIZE]u8 = undefined;
    var leftover: usize = 0;
    var sector: u32 = 0;
    var bad: u32 = 0;
    var total_entries: u32 = 0;

    while (true) {
        const got = f.readAll(buf[CARRY..]) catch 0;
        if (got < SECTOR_SIZE) break;

        const crc = Crc32.hash(buf[CARRY..][0..SECTOR_PAYLOAD]);
        const want = std.mem.readInt(u32, buf[CARRY + SECTOR_PAYLOAD ..][0..4], .little);
        if (crc != want) {
            std.debug.print("[replay] sector {d}: CRC mismatch\n", .{sector});
            bad += 1;
            sector += 1;
            continue;
        }

        const start_idx = CARRY - leftover;
        const end_idx = CARRY + SECTOR_PAYLOAD;
        var cursor: usize = start_idx;
        var entries: usize = 0;
        var split_at: ?usize = null;

        while (cursor < end_idx) {
            const available = end_idx - cursor;
            if (available < @sizeOf(WalEntryHeader)) {
                split_at = cursor;
                break;
            }
            var header: WalEntryHeader = undefined;
            std.mem.copyForwards(u8, std.mem.asBytes(&header), buf[cursor..][0..@sizeOf(WalEntryHeader)]);
            if (header.length == 0) break; // padding
            if (header.length > MAX_ENTRY_LEN) {
                std.debug.print(
                    "[replay] sector {d}: entry {d} at payload byte {d} claims length {d}\n",
                    .{ sector, entries, cursor - start_idx, header.length },
                );
                split_at = cursor;
                break;
            }
            if (available < @sizeOf(WalEntryHeader) + header.length) {
                split_at = cursor;
                break;
            }
            cursor += @sizeOf(WalEntryHeader) + header.length;
            entries += 1;
        }
        total_entries += @intCast(entries);

        const label: []const u8 = blk: {
            if (split_at != null) break :blk "full (split)";
            if (cursor == end_idx) break :blk "full";
            const rest = end_idx - cursor;
            var all_zero = true;
            for (buf[cursor..end_idx]) |b| {
                if (b != 0) {
                    all_zero = false;
                    break;
                }
            }
            if (all_zero and rest >= MIN_PADDING) break :blk "padded";
            break :blk "NEITHER";
        };
        std.debug.print(
            "[replay] sector {d}: {d} entr(ies), carried {d} in, stopped at payload byte {d}, {s}\n",
            .{ sector, entries, leftover, cursor - start_idx, label },
        );
        if (std.mem.eql(u8, label, "NEITHER")) bad += 1;

        // Unconditional carry, as described above. The tail is what is left of
        // the window from the split point, not the distance to it.
        leftover = if (split_at) |sp| end_idx - sp else 0;
        if (leftover > 0) {
            const from = end_idx - leftover;
            var i: usize = 0;
            while (i < leftover) : (i += 1) buf[CARRY - leftover + i] = buf[from + i];
        }
        sector += 1;
    }
    std.debug.print(
        "[replay] {d} sector(s), {d} entr(ies), {d} sector(s) not framed the way the writer framed them\n",
        .{ sector, total_entries, bad },
    );

    // And the engine on the same file, so the two are compared rather than
    // trusted. `recoverWal` prints its own tally; the counts must agree with
    // the framing above, because an entry the framing sees and the replay
    // does not is an entry that was silently dropped.
    const allocator = std.testing.allocator;
    const arena_size: usize = 24 * 1024 * 1024;
    const regions = layout.defaultRegions(arena_size);
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    const pz = try allocator.dupeZ(u8, path);
    defer allocator.free(pz);
    try recoverWal(allocator, pz, arena, null, regions);
    if (bad != 0) {
        std.debug.print("[replay] {d} sector(s) are misframed, so the replay above is not comparable\n", .{bad});
    }
}

test "a split entry is carried even when its carried bytes are all zero" {
    // The regression, at the level it actually lives. The reader used to
    // decide "padding or split?" from the bytes -- an all-zero tail is
    // padding -- and dropped the carry when they were zero. But the writer
    // only ever pads from sector_pos, which is at an entry boundary, so a
    // scan that stopped mid-entry is looking at a real entry whatever those
    // bytes are. And "all zero" is a perfectly ordinary payload: an inline
    // delta of eight zero bytes is a float64 field set to 0.0 or a uint32
    // set to 0, both written routinely by the SDK.
    //
    // Dropping it left the next sector being parsed from the middle of an
    // entry, its payload read as a header, and every entry behind it applied
    // to offsets the log never named -- a corruption that surfaced hundreds
    // of committed records later as keys that were simply gone.
    const allocator = std.testing.allocator;

    var buf: [64]u8 = [_]u8{0} ** 64;
    const end = buf.len;

    // Mid-entry: eight zero payload bytes at the end of the sector.
    @memset(&buf, 0);
    try std.testing.expectEqual(@as(usize, 8), carryTail(.mid_entry, &buf, 56, end));

    // The case that actually broke: fewer bytes than the writer's minimum
    // padding, all of them zero. A sector cannot have been padded with less
    // than MIN_PADDING left -- the idle flush refuses to -- so these are the
    // first bytes of an entry, and dropping them loses the framing for the
    // whole of the next sector. One byte is enough; this is what a sector
    // whose last entry's header is split across the boundary looks like.
    for (0..8) |kept| {
        @memset(&buf, 0);
        try std.testing.expectEqual(
            @as(usize, kept),
            carryTail(.at_boundary, &buf, end - kept, end),
        );
    }

    // Eight or more zero bytes at a boundary are padding, and stay dropped:
    // carrying them would prepend zeros to the next sector and misalign it
    // just as badly.
    try std.testing.expectEqual(
        @as(usize, 0),
        carryTail(.at_boundary, &buf, 56, end),
    );

    // A boundary with a non-zero byte has an entry header starting there.
    buf[63] = 1;
    try std.testing.expectEqual(
        @as(usize, 8),
        carryTail(.at_boundary, &buf, 56, end),
    );

    // A corrupt length and an unknown kind are also mid-entry stops: the
    // header was read, so the bytes after it belong to an entry.
    @memset(&buf, 0);
    try std.testing.expectEqual(@as(usize, 8), carryTail(.bad_length, &buf, 56, end));
    try std.testing.expectEqual(@as(usize, 8), carryTail(.unknown_kind, &buf, 56, end));

    // A tail longer than a whole entry is a scan that already lost its place,
    // and is dropped rather than propagated.
    var big: [MAX_ENTRY_LEN + 64]u8 = [_]u8{7} ** (MAX_ENTRY_LEN + 64);
    try std.testing.expectEqual(
        @as(usize, 0),
        carryTail(.mid_entry, &big, 0, big.len),
    );
    _ = allocator;
}

test "a split entry whose carried bytes start with zero is still carried" {
    // The reader drops a carried tail whose bytes are all zero, on the
    // reasoning that padding is zero-filled and a real entry is not. That
    // reasoning is wrong in exactly one case, and it is the case the crash
    // property test found: an entry whose payload begins with a zero byte --
    // a uint32 field whose low byte is 0, an inline delta of arbitrary bytes
    // -- has a *valid, complete* header saying how long it is, and the tail
    // is dropped anyway. The next sector is then parsed from the middle of
    // that entry, its payload is read as a header, and everything behind it
    // in that sector is written to offsets the log never named.
    //
    // So: build the log so the split entry's carried bytes are zero, put
    // entries behind it, and compare every byte.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/zero-tail.takyon", .{dirpath});

    const arena_size: usize = 1024 * 1024;
    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, 8192);
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);

    // Three bytes of this entry's PAYLOAD land at the end of the sector, and
    // all three are zero. The entry has to start early enough that its header
    // fits whole and only its payload is cut -- that is the case where the
    // reader has already read a valid header saying how long the entry is,
    // and the tail is where the header's offset and length are not.
    const carried = 3;
    const payload_len = 12;
    const start = SECTOR_PAYLOAD - @sizeOf(WalEntryHeader) - carried;

    var wal = try WalManager.init(allocator, path);

    // Filler so the entry of interest starts at `start` of the sector.
    const filler_len = start - @sizeOf(WalEntryHeader);
    var filler: [SECTOR_PAYLOAD]u8 = undefined;
    for (filler[0..filler_len], 0..) |*b, i| b.* = @intCast((i * 7 + 3) % 251 + 1);
    try writeEntry(&wal, @intCast(base), filler[0..filler_len]);

    // The split entry: leading zeros, then a distinguishable tail.
    var victim: [12]u8 = [_]u8{0} ** 12;
    for (victim[carried..], carried..) |*b, i| b.* = @intCast(200 + i);
    try writeEntry(&wal, @intCast(base + filler_len), &victim);

    // Entries behind it, in the next sector. If the carry was dropped, these
    // are read from the wrong offsets and this comparison fails.
    var behind: usize = 0;
    var at: u32 = @intCast(base + filler_len + payload_len);
    while (behind < 12) : (behind += 1) {
        var payload: [8]u8 = undefined;
        for (&payload, 0..) |*b, i| b.* = @intCast(behind * 11 + i + 1);
        try writeEntry(&wal, at, &payload);
        at += @sizeOf(WalEntryHeader) + payload.len;
    }
    try wal.flushBuffer();
    wal.shutdown();

    try recoverWal(allocator, path, arena, null, regions);

    for (victim, 0..) |b, i| {
        if (arena[base + filler_len + i] != b) {
            std.debug.print(
                "[test] the split entry's byte {d} is 0x{x:0>2}, expected 0x{x:0>2}\n",
                .{ i, arena[base + filler_len + i], b },
            );
            return error.TestExpectedEqual;
        }
    }
    var check = base + filler_len + payload_len;
    for (0..12) |k| {
        for (0..8) |i| {
            const want: u8 = @intCast(k * 11 + i + 1);
            if (arena[check + i] != want) {
                std.debug.print(
                    "[test] the entry behind the split one ({d}) reads 0x{x:0>2}, expected 0x{x:0>2}\n",
                    .{ k, arena[check + i], want },
                );
                return error.TestExpectedEqual;
            }
        }
        check += @sizeOf(WalEntryHeader) + 8;
    }
}

test "WAL fidelity fuzz: random valid logs restore byte-exact (128 streams)" {
    // The complement of the fuzz below. That one feeds the parser arbitrary
    // bytes and asserts it survives; it cannot assert anything about what
    // came back, because there is no right answer for random input. This one
    // feeds it random *valid* logs -- random entry sizes, random offsets,
    // random interleaving of forced and padded flushes -- and asserts the
    // restored arena equals what was written.
    //
    // The reason both exist: the reader decides per sector whether the tail
    // is a split entry to carry or zero padding to drop, and it decides by
    // content. A hand-written case fixes that decision; a random stream
    // produces every mixture of the two, including the ones nobody would
    // write on purpose.
    const WalManager = @import("wal.zig").WalManager;
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/fidelity-fuzz.takyon", .{dirpath});

    var prng = std.Random.DefaultPrng.init(0x5eed_1234);
    const rnd = prng.random();

    const arena_size: usize = 1024 * 1024;
    const regions = layout.defaultRegions(arena_size);
    const base = try recordPayloadOffset(regions, 16 * 1024);
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    // What was written, kept beside the arena to compare against. The
    // oracle lives outside the system under test, which is the only place an
    // oracle can live.
    const expect = try allocator.alloc(u8, 16 * 1024);
    defer allocator.free(expect);

    var stream: usize = 0;
    while (stream < 128) : (stream += 1) {
        std.fs.cwd().deleteFile(path) catch {};
        @memset(arena, 0);
        @memset(expect, 0);

        var wal = try WalManager.init(allocator, path);
        var at: u32 = @intCast(base);
        const limit: u32 = @intCast(base + 16 * 1024);
        // A handful of large entries per stream, so splits land in the middle
        // of a payload and not only in a header.
        const big = stream % 5 == 0;

        var entry: usize = 0;
        while (entry < 48 and at + 64 < limit) : (entry += 1) {
            const size = if (big)
                rnd.intRangeAtMost(usize, 1, 600)
            else
                rnd.intRangeAtMost(usize, 1, 48);
            if (at + size > limit) break;
            for (expect[at - base ..][0..size]) |*b| {
                b.* = rnd.int(u8);
            }
            try writeEntry(&wal, at, expect[at - base ..][0..size]);
            at += @intCast(size);
            // Roughly every third entry stops the batch, which is what makes
            // the next sector padded rather than full.
            if (rnd.intRangeAtMost(u8, 0, 2) == 0) try wal.flushIfUnambiguous();
        }
        try wal.flushBuffer();
        wal.shutdown();

        try recoverWal(allocator, path, arena, null, regions);

        const written = at - @as(u32, @intCast(base));
        for (expect[0..written], 0..) |b, i| {
            if (arena[base + i] != b) {
                std.debug.print(
                    "[test] stream {d}: byte {d} is 0x{x:0>2}, expected 0x{x:0>2}\n",
                    .{ stream, i, arena[base + i], b },
                );
                return error.TestExpectedEqual;
            }
        }
        // Nothing beyond what was written may have been touched: a reader
        // that ran past the log would restore bytes from a sector that was
        // never written.
        for (expect[written..], written..) |b, i| {
            if (arena[base + i] != b) {
                std.debug.print("[test] stream {d}: byte {d} past the log was written\n", .{ stream, i });
                return error.TestExpectedEqual;
            }
        }
    }
}

test "WAL framing fuzz never fails fatally (256 random files)" {
    const allocator = std.testing.allocator;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    var pathbuf: [std.fs.max_path_bytes]u8 = undefined;
    const path = try std.fmt.bufPrintZ(&pathbuf, "{s}/fuzz.takyon", .{dirpath});

    var prng = std.Random.DefaultPrng.init(0x12345678);
    const rnd = prng.random();

    const arena_size: usize = 65536;
    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);

    var raw: [9000]u8 = undefined;
    var i: usize = 0;
    while (i < 256) : (i += 1) {
        const size = rnd.intRangeAtMost(usize, 0, 9000);
        rnd.bytes(raw[0..size]);
        try tmp.dir.writeFile(.{ .sub_path = "fuzz.takyon", .data = raw[0..size] });
        @memset(arena, 0);
        // Arbitrary bytes must never fail fatally: the parser stops at the
        // first bad CRC/length and returns with whatever prefix was valid
        // (possibly an empty arena).
        try recoverWal(allocator, path, arena, null, layout.defaultRegions(arena.len));
    }
}
