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

pub fn recoverWal(allocator: std.mem.Allocator, path: [:0]const u8, arena_mem: []u8) !void {
    var rec_max: u32 = layout.RECORD_BUMP_INIT;
    var art_max: u32 = layout.ART_START;
    var str_max: u32 = layout.STRING_DATA_START;

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
    replayWal(allocator, path, arena_mem, &rec_max, &art_max, &str_max);

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

/// Replays WAL entries onto the arena. Stops at the first corrupt sector
/// or entry; everything before it is valid by CRC.
/// Tracks THREE maxima by offset range:
///   < ART_ROOT_OFFSET     -> record max
///   < STRING_ARENA_START  -> ART max
///   else                  -> STRING max
fn replayWal(
    allocator: std.mem.Allocator,
    path: [:0]const u8,
    arena_mem: []u8,
    rec_max: *u32,
    art_max: *u32,
    str_max: *u32,
) void {
    const raw = allocator.alloc(u8, 8192 + 4095) catch return;
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..8192];

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
        // Read directly into the second 4KB page of our aligned buffer.
        if (!readBlock(fd, buf[4096..8192])) break;

        // Validation: torn write / corruption.
        const crc = Crc32.hash(buf[4096..8188]);
        const expected_crc = std.mem.readInt(u32, buf[8188..8192][0..4], .little);
        if (crc != expected_crc) {
            std.debug.print("[WARNING] CRC32 corruption detected in sector {d}. Truncating recovery. Starting database with valid prior records.\n", .{sector_idx});
            break;
        }
        sector_idx += 1;

        const start_idx = 4096 - leftover_len;
        // The active stream only includes the 4092 bytes of payload
        const end_idx = 4096 + 4092;
        var cursor: usize = start_idx;
        var stop_reading = false;

        while (cursor < end_idx) {
            const available = end_idx - cursor;
            if (available < @sizeOf(WalEntryHeader)) {
                break; // Need more bytes for header next read
            }

            var header: WalEntryHeader = undefined;
            std.mem.copyForwards(u8, std.mem.asBytes(&header), buf[cursor .. cursor + @sizeOf(WalEntryHeader)]);

            if (header.length == 0) {
                // End of active WAL (zero padding hit)
                stop_reading = true;
                break;
            }
            if (header.length > 16384) break; // Corrupt length; stop.

            if (available < @sizeOf(WalEntryHeader) + header.length) {
                break; // Need more bytes for payload next read
            }

            const payload_start = cursor + @sizeOf(WalEntryHeader);
            const payload_end = payload_start + header.length;

            // Rehydrate isomorphic memory directly to SharedArena
            if (header.offset + header.length <= arena_mem.len) {
                std.mem.copyForwards(u8, arena_mem[header.offset .. header.offset + header.length], buf[payload_start..payload_end]);
            }

            // Track THREE maxima by offset range. Ring/header writes below
            // ART_ROOT_OFFSET fold into the record max but stay below
            // RECORD_BUMP_INIT, so they never move the bump.
            const end_offset = header.offset + header.length;
            if (header.offset < layout.ART_ROOT_OFFSET) {
                if (end_offset > rec_max.*) rec_max.* = end_offset;
            } else if (header.offset < layout.STRING_ARENA_START) {
                if (end_offset > art_max.*) art_max.* = end_offset;
            } else {
                if (end_offset > str_max.*) str_max.* = end_offset;
            }

            cursor += @sizeOf(WalEntryHeader) + header.length;
        }

        if (stop_reading) break;

        // Move leftovers to the end of the first 4KB page
        leftover_len = end_idx - cursor;
        if (leftover_len > 0) {
            std.mem.copyForwards(u8, buf[4096 - leftover_len .. 4096], buf[cursor..end_idx]);
        }
    }
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
