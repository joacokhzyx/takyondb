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

// Coordinate with the layout-v2 agent: these WILL exist in layout.zig.
// Fallbacks use identical values so this file compiles in parallel.
const MAGIC_OFFSET: usize = if (@hasDecl(layout, "MAGIC_OFFSET")) layout.MAGIC_OFFSET else 0;
const VERSION_OFFSET: usize = if (@hasDecl(layout, "VERSION_OFFSET")) layout.VERSION_OFFSET else 4;
const LAYOUT_VERSION: u32 = if (@hasDecl(layout, "LAYOUT_VERSION")) layout.LAYOUT_VERSION else 2;
const FOOTER_MAGIC: u32 = if (@hasDecl(layout, "ARENA_MAGIC")) layout.ARENA_MAGIC else 0x54414B59;

pub const SnapshotMeta = struct {
    active_len: u32,
    art_bump: u32,
    str_bump: u32,
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
fn applyIndexOps(art_index: *ArtIndex, index_ops: *IndexOps) u32 {
    var applied: u32 = 0;
    for (index_ops.ops.items) |op| {
        const start = op.key_offset;
        const end = start + op.key_len;
        if (end > index_ops.keys.items.len) continue; // Truncated blob; skip.
        art_index.insert(index_ops.keys.items[start..end], op.value_offset) catch |err| {
            std.debug.print("[TakyonDB-Bootloader] Skipped index replay for a key that no longer fits: {s}\\n", .{@errorName(err)});
            continue;
        };
        applied += 1;
    }
    if (index_ops.ops.items.len > 0) {
        std.debug.print("[TakyonDB-Bootloader] Replayed {d}/{d} index operations from the WAL.\\n", .{ applied, index_ops.ops.items.len });
    }
    return applied;
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

fn isFooterV2Shape(buf: *const [4096]u8) bool {
    for (buf[24..4096]) |b| {
        if (b != 0) return false;
    }
    return true;
}

fn isLegacyV1Shape(buf: *const [4096]u8) bool {
    for (buf[8..4096]) |b| {
        if (b != 0) return false;
    }
    return true;
}

/// `art_index` is optional because it is only meaningful for an arena large
/// enough to contain the ART region at all. A small test arena (16 KB) has
/// no room for nodes rooted at ART_ROOT_OFFSET, and `ArtIndex.init` would
/// panic on the out-of-range bump word rather than return an error. Passing
/// null skips the index replay, which is correct: such an arena cannot hold
/// index operations.
pub fn recoverWal(allocator: std.mem.Allocator, path: [:0]const u8, arena_mem: []u8, art_index: ?*ArtIndex) !void {
    var rec_max: u32 = layout.RECORD_BUMP_INIT;
    var art_max: u32 = layout.ART_START;
    var str_max: u32 = layout.STRING_DATA_START;
    var index_ops = IndexOps{
        .keys = std.ArrayList(u8).init(allocator),
        .ops = std.ArrayList(IndexOps.IndexOp).init(allocator),
    };
    defer index_ops.deinit();

    // Phase 1: snapshot with CRC verification (two passes).
    if (try loadSnapshot(allocator, path, arena_mem)) |meta| {
        // Seed maxima from the snapshot footer + copied bump words so all
        // three arenas survive even with no further WAL replay.
        const arena_rec = readWord(arena_mem, layout.RECORD_BUMP_OFFSET, layout.RECORD_BUMP_INIT);
        const arena_art = readWord(arena_mem, layout.ART_BUMP_OFFSET, layout.ART_START);
        const arena_str = readWord(arena_mem, layout.STRING_BUMP_OFFSET, layout.STRING_DATA_START);
        rec_max = @max(rec_max, arena_rec);
        art_max = @max(meta.art_bump, arena_art);
        art_max = @max(art_max, layout.ART_START);
        str_max = @max(meta.str_bump, arena_str);
        str_max = @max(str_max, layout.STRING_DATA_START);
        // Clamp seeds to arena bounds: a larger arena image truncated here
        // must not push bumps past the end.
        if (rec_max > arena_mem.len) rec_max = @as(u32, @intCast(arena_mem.len));
        if (art_max > arena_mem.len) art_max = @as(u32, @intCast(arena_mem.len));
        if (str_max > arena_mem.len) str_max = @as(u32, @intCast(arena_mem.len));
        _ = meta.active_len;
    }

    // Phase 2: WAL delta replay.
    replayWal(allocator, path, arena_mem, &rec_max, &art_max, &str_max, &index_ops);

    // Phase 3: re-apply logical index operations. Must run before finalize,
    // which overwrites the ART bump from art_max; rebuilding the index moves
    // that bump, so the post-replay value is folded back in below.
    if (index_ops.ops.items.len > 0) {
        if (art_index) |idx| {
            _ = applyIndexOps(idx, &index_ops);
            const arena_art = readWord(arena_mem, layout.ART_BUMP_OFFSET, layout.ART_START);
            if (arena_art > art_max) art_max = arena_art;
        } else {
            std.debug.print(
                "[TakyonDB-Bootloader] WAL holds {d} index operation(s) but this arena has no ART region; the index is not rebuilt.\n",
                .{index_ops.ops.items.len},
            );
        }
    }

    finalize(arena_mem, rec_max, art_max, str_max);
}

/// Loads and verifies the snapshot. Returns footer metadata, or null when
/// no (valid) snapshot exists. A corrupt snapshot never poisons the arena:
/// it is skipped with a warning and the WAL still replays.
/// Snap path is derived from the WAL `path` arg as `<wal>.snap`.
fn loadSnapshot(allocator: std.mem.Allocator, wal_path: [:0]const u8, arena_mem: []u8) !?SnapshotMeta {
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

    // Footer v2 in the last block:
    //   magic u32 [0..4], version u32 [4..8], crc u32 [8..12],
    //   active_len u32 [12..16], art_bump u32 [16..20],
    //   str_bump u32 [20..24], rest zeros.
    // Only trusted when the file size matches the claimed length.
    // Old v1 footers (crc[0..4] + active[4..8] + zeros) carry no magic/
    // version and are rejected as corrupt: log + WAL-only recovery.
    const footer_magic = std.mem.readInt(u32, last[MAGIC_OFFSET .. MAGIC_OFFSET + 4][0..4], .little);
    const footer_ver = std.mem.readInt(u32, last[VERSION_OFFSET .. VERSION_OFFSET + 4][0..4], .little);
    if (footer_magic != FOOTER_MAGIC or footer_ver != LAYOUT_VERSION) {
        if (isLegacyV1Shape(&last)) {
            std.debug.print("[TakyonDB-Bootloader] Snapshot is legacy v1 footer; rejecting as corrupt, WAL-only recovery.\n", .{});
        } else {
            std.debug.print("[TakyonDB-Bootloader] Snapshot footer magic/version mismatch; ignoring.\n", .{});
        }
        return null;
    }
    if (!isFooterV2Shape(&last)) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot has no v2 footer; ignoring.\n", .{});
        return null;
    }
    const claimed_crc = std.mem.readInt(u32, last[8..12], .little);
    const claimed_active = std.mem.readInt(u32, last[12..16], .little);
    const claimed_art = std.mem.readInt(u32, last[16..20], .little);
    const claimed_str = std.mem.readInt(u32, last[20..24], .little);
    if (claimed_active == 0 or claimed_active > arena_mem.len) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot footer out of range; ignoring.\n", .{});
        return null;
    }
    if (claimed_art > arena_mem.len or claimed_str > arena_mem.len) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot footer bumps out of range; ignoring.\n", .{});
        return null;
    }
    if (blocks - 1 != blocksFor(claimed_active)) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot size mismatch; ignoring.\n", .{});
        return null;
    }
    const data_blocks = blocks - 1;

    // Pass 2: copy data blocks while hashing, then verify the CRC.
    const fd = openExisting(snap_path) orelse return null;
    defer closeFd(fd);

    std.debug.print("[TakyonDB-Bootloader] Recovering from Snapshot...\n", .{});
    var hasher = Crc32.init();
    var i: usize = 0;
    while (i < data_blocks) : (i += 1) {
        if (!readBlock(fd, buf)) {
            std.debug.print("[TakyonDB-Bootloader] Snapshot shrank mid-read; ignoring.\n", .{});
            return null;
        }
        const cursor = i * 4096;
        if (cursor + 4096 <= arena_mem.len) {
            @memcpy(arena_mem[cursor .. cursor + 4096], buf);
        }
        hasher.update(buf);
    }
    if (hasher.final() != claimed_crc) {
        std.debug.print("[TakyonDB-Bootloader] Snapshot CRC mismatch; ignoring snapshot.\n", .{});
        @memset(arena_mem[0..@min(@as(usize, claimed_active), arena_mem.len)], 0);
        return null;
    }
    return SnapshotMeta{
        .active_len = claimed_active,
        .art_bump = claimed_art,
        .str_bump = claimed_str,
    };
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
) void {
    replayOneSegment(allocator, path, arena_mem, rec_max, art_max, str_max, index_ops);
    var n: u32 = 0;
    while (n < MAX_SEGMENTS) : (n += 1) {
        var sbuf: [4096]u8 = undefined;
        const seg = formatSegmentPathZ(&sbuf, path[0..path.len], n) catch break;
        const probe = openExisting(seg) orelse break; // stop at first missing N
        closeFd(probe);
        replayOneSegment(allocator, seg, arena_mem, rec_max, art_max, str_max, index_ops);
    }
}

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
) void {
    // Buffer layout. The low CARRY_REGION bytes hold the tail of an entry
    // split across sector boundaries; the final page is the sector just
    // read. CARRY_REGION is three sectors rather than one on purpose: an
    // entry may be up to MAX_ENTRY_LEN payload plus its header, which spans
    // three 4K sectors, and the carry is measured across the pending
    // leftover AND the sector just read. With a one-page carry region,
    // `CARRY_REGION - carry_len` underflowed and aborted the daemon on a
    // real log; carryLenFrom now also refuses to propagate a tail too long
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

        // Validation: torn write / corruption.
        const crc = Crc32.hash(buf[CARRY_REGION .. CARRY_REGION + SECTOR_PAYLOAD]);
        const expected_crc = std.mem.readInt(u32, buf[CARRY_REGION + SECTOR_PAYLOAD ..][0..4], .little);
        if (crc != expected_crc) {
            std.debug.print("[WARNING] CRC32 corruption detected in sector {d}. Truncating recovery. Starting database with valid prior records.\n", .{sector_idx});
            break;
        }
        sector_idx += 1;

        const start_idx = CARRY_REGION - leftover_len;
        // The active stream only includes the 4092 bytes of payload
        const end_idx = CARRY_REGION + SECTOR_PAYLOAD;
        var cursor: usize = start_idx;
        // Bytes at the end of this sector that begin an entry continuing
        // into the next one. Padding is deliberately NOT carried: see
        // carryLenFrom.
        var carry_len: usize = 0;

        while (cursor < end_idx) {
            const available = end_idx - cursor;
            if (available < @sizeOf(WalEntryHeader)) {
                carry_len = carryLenFrom(buf, cursor, end_idx);
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
                carry_len = carryLenFrom(buf, cursor, end_idx);
                break; // Corrupt length; stop.
            }
            if (@as(u8, @intFromEnum(header.kind)) > MAX_ENTRY_KIND) {
                // A kind this build does not know means the log was written
                // by a newer format. Stop rather than guess: interpreting
                // the record as the wrong shape would produce a
                // plausible-looking but wrong arena, which is worse than
                // recovering a prefix.
                std.debug.print("[TakyonDB-Bootloader] WAL record kind {d} is newer than this build understands; stopping recovery.\n", .{@as(u8, @intFromEnum(header.kind))});
                carry_len = carryLenFrom(buf, cursor, end_idx);
                break;
            }

            if (available < @sizeOf(WalEntryHeader) + header.length) {
                carry_len = carryLenFrom(buf, cursor, end_idx);
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
                cursor += @sizeOf(WalEntryHeader) + header.length;
                continue;
            }

            // Widen before adding. A misaligned or corrupt scan can present
            // an offset near 2^32, and `offset + length` in u32 panics in
            // Debug builds — a log file must never be able to abort the
            // daemon. Widen to usize, bounds-check against the arena, and
            // treat anything out of range as the end of the valid prefix.
            const end_offset: usize = @as(usize, header.offset) + @as(usize, header.length);
            if (end_offset > arena_mem.len) break; // Out of arena; stop.

            // Rehydrate isomorphic memory directly to SharedArena
            std.mem.copyForwards(
                u8,
                arena_mem[@as(usize, header.offset)..end_offset],
                buf[payload_start..payload_end],
            );

            // Track THREE maxima by offset range. Ring/header writes below
            // ART_ROOT_OFFSET fold into the record max but stay below
            // RECORD_BUMP_INIT, so they never move the bump.
            const bounded: u32 = @intCast(end_offset);
            if (header.offset < layout.ART_ROOT_OFFSET) {
                if (bounded > rec_max.*) rec_max.* = bounded;
            } else if (header.offset < layout.STRING_ARENA_START) {
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
/// plus a header, and carryLenFrom caps the tail at exactly that, so the
/// region can never be overrun.
const CARRY_REGION: usize = 3 * 4096;

/// How many bytes at the end of a sector are the beginning of an entry
/// that continues in the next sector, and so must be carried forward.
///
/// A sector is written one of two ways. A FULL sector has no padding and
/// may end mid-entry, so its tail must be carried. A PADDED sector ends
/// at an entry boundary and its zero tail must NOT be carried: those
/// zeros would be prepended to the next sector and shift its entry
/// framing, and the misaligned `length` read then trips the
/// MAX_ENTRY_LEN check and throws away every entry behind it.
///
/// The two are told apart by content. flushBuffer zero-fills the padding,
/// and an all-zero header (offset 0, length 0) is never emitted:
/// takyon_notify_arena and takyon_push_delta both reject size == 0
/// precisely so the parser can use it as a terminator. So an all-zero
/// tail is padding.
///
/// When a real entry *is* split with an all-zero tail, dropping it costs
/// at most that entry's carried bytes. Carrying instead would misalign
/// the following sector, so this is the cheaper of the two failures.
fn carryLenFrom(buf: []u8, cursor: usize, end_idx: usize) usize {
    const tail = end_idx - cursor;
    // A tail longer than one whole entry is corrupt framing, not a split:
    // the length that produced it was never valid, so the scan has already
    // lost its place. Carrying it forward only propagates the damage, and an
    // unbounded tail is what overflowed the carry region before it was sized
    // to three sectors. Drop it.
    if (tail > MAX_ENTRY_LEN + @sizeOf(WalEntryHeader)) return 0;
    for (buf[cursor..end_idx]) |b| {
        if (b != 0) return tail; // Real split entry: carry it.
    }
    return 0;
}

fn finalize(arena_mem: []u8, rec_max: u32, art_max: u32, str_max: u32) void {
    // Idempotent: writing the same aligned maxima twice changes nothing.
    // Each bump is clamped to its init and 8-aligned; out-of-range bumps
    // on small arenas (tests) are skipped instead of panicking.
    if (layout.RECORD_BUMP_OFFSET + 4 <= arena_mem.len) {
        const bump_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[layout.RECORD_BUMP_OFFSET])));
        bump_ptr.* = align8(@max(rec_max, layout.RECORD_BUMP_INIT));
    }
    if (layout.ART_BUMP_OFFSET + 4 <= arena_mem.len) {
        const art_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[layout.ART_BUMP_OFFSET])));
        art_ptr.* = align8(@max(art_max, layout.ART_START));
    }
    if (layout.STRING_BUMP_OFFSET + 4 <= arena_mem.len) {
        const str_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[layout.STRING_BUMP_OFFSET])));
        str_ptr.* = align8(@max(str_max, layout.STRING_DATA_START));
    }

    // 3. IPC channel cleanup: clear the full ring region.
    if (layout.RING_OFFSET <= layout.RECORD_BUMP_OFFSET and layout.RECORD_BUMP_OFFSET <= arena_mem.len) {
        @memset(arena_mem[layout.RING_OFFSET..layout.RECORD_BUMP_OFFSET], 0);
    }

    std.debug.print("[TakyonDB-Bootloader] Isomorphic recovery completed. Bumps rec={} art={} str={}.\n", .{ rec_max, art_max, str_max });
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
    const payload_off: u32 = 8000;
    const payload_len: usize = 5000;
    const arena_size: usize = 16384;

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
    try recoverWal(allocator, path, arena, null);
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

    var wal = try WalManager.init(allocator, path);
    for (0..batches) |b| {
        for (0..per_batch) |i| {
            const idx = b * per_batch + i;
            const off: u32 = @intCast(1000 + idx * 8);
            const byte = [_]u8{@intCast(0xA0 + idx)};
            try writeEntry(&wal, off, &byte);
        }
        try wal.flushBuffer();
    }
    wal.shutdown();

    const arena = try allocator.alloc(u8, arena_size);
    defer allocator.free(arena);
    @memset(arena, 0);
    try recoverWal(allocator, path, arena, null);

    for (0..batches) |b| {
        for (0..per_batch) |i| {
            const idx = b * per_batch + i;
            const off: usize = 1000 + idx * 8;
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
    const arena_size: usize = 65536;

    var wal = try WalManager.init(allocator, path);
    var written: usize = 0;
    while (written < total) {
        const n = @min(per_batch, total - written);
        for (0..n) |i| {
            const idx = written + i;
            const off: u32 = @intCast(1000 + idx * 4);
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
    try recoverWal(allocator, path, arena, null);

    // Count how many entries actually landed, in order to report the
    // shortfall instead of failing on the first mismatch.
    var recovered: usize = 0;
    while (recovered < total) : (recovered += 1) {
        const off: usize = 1000 + recovered * 4;
        if (arena[off] != @as(u8, @intCast(recovered % 251))) break;
    }
    try std.testing.expectEqual(@as(usize, total), recovered);
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

    const arena_size: usize = 65536;
    const total = 600;
    // Vary the payload so the sector lands on every slack in 1..5 across
    // runs, and keep entries small enough that a full sector holds many.
    const payload_len = 5;

    var wal = try WalManager.init(allocator, path);
    for (0..total) |i| {
        const off: u32 = @intCast(2000 + i * 8);
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
    try recoverWal(allocator, path, arena, null);

    var recovered: usize = 0;
    while (recovered < total) : (recovered += 1) {
        const off: usize = 2000 + recovered * 8;
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
    const keys = [_][]const u8{ "alpha", "bravo", "charlie", "delta", "echo" };
    const values = [_]u32{ 4096, 4160, 4224, 4288, 4352 };
    var wal = try WalManager.init(allocator, path);
    for (keys, 0..) |key, i| {
        try writeEntryOfKind(&wal, values[i], key, .index_op);
    }
    try wal.flushBuffer();
    wal.shutdown();

    // Round 2: a fresh arena, as after SIGKILL.
    @memset(arena, 0);
    var art_index = ArtIndex.init(arena, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    try recoverWal(allocator, path, arena, &art_index);

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
        try recoverWal(allocator, path, arena, null);
    }
}
