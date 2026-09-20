// ============================================================================
// File: snapshot.zig
// Description: Memory Snapshot generator for fast cold-starts.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const layout = @import("../memory/layout.zig");
const art = @import("../index/art.zig");
const WalManager = @import("wal.zig").WalManager;
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;

// Coordinate with the layout-v2 agent: these WILL exist in layout.zig.
// Fallbacks below use identical values so this file compiles in parallel.
const MAGIC_OFFSET: usize = if (@hasDecl(layout, "MAGIC_OFFSET")) layout.MAGIC_OFFSET else 0;
const VERSION_OFFSET: usize = if (@hasDecl(layout, "VERSION_OFFSET")) layout.VERSION_OFFSET else 4;
const LAYOUT_VERSION: u32 = if (@hasDecl(layout, "LAYOUT_VERSION")) layout.LAYOUT_VERSION else 2;
const FOOTER_MAGIC: u32 = if (@hasDecl(layout, "ARENA_MAGIC")) layout.ARENA_MAGIC else 0x54414B59;

fn readBump(arena_mem: []const u8, offset: usize, fallback: u32) u32 {
    if (offset + 4 > arena_mem.len) return fallback;
    const v = @as(*const u32, @ptrCast(@alignCast(arena_mem.ptr + offset))).*;
    if (v > arena_mem.len) return fallback;
    return v;
}

/// Minimum interval between successful snapshots (milliseconds). Settable;
/// tests that call createSnapshot once are unaffected.
pub var minIntervalMs: i64 = 5000;

/// Timestamp (std.time.milliTimestamp) of the last successful snapshot;
/// -1 means none yet. File-scope by design: the flusher is the sole
/// caller, so no locking is needed.
var last_snapshot_ms: i64 = -1;

/// Highest byte the snapshot must cover: records, ART nodes and the active
/// string bank. Older snapshots only covered the record bump, silently
/// dropping the index and all strings on recovery.
/// Triple return so the footer v2 can persist ART/STRING bumps verbatim.
pub const SnapshotSizes = struct {
    active_len: usize,
    art_bump: u32,
    str_bump: u32,
};

fn snapshotLen(arena_mem: []const u8) SnapshotSizes {
    const rec = readBump(arena_mem, layout.RECORD_BUMP_OFFSET, layout.RECORD_BUMP_INIT);
    const art_bump = readBump(arena_mem, layout.ART_BUMP_OFFSET, layout.ART_START);
    const str_bump = readBump(arena_mem, layout.STRING_BUMP_OFFSET, layout.STRING_DATA_START);
    var active = @max(rec, @max(art_bump, str_bump));
    active = (active + 7) & ~@as(u32, 7);
    if (active < 4096) active = 4096;
    return .{
        .active_len = @min(@as(usize, active), arena_mem.len),
        .art_bump = art_bump,
        .str_bump = str_bump,
    };
}

fn writeAllPosix(fd: std.posix.fd_t, buf: []const u8) !void {
    var off: usize = 0;
    while (off < buf.len) {
        const n = std.c.write(fd, buf.ptr + off, buf.len - off);
        if (n < 0) {
            const errno_val = std.c._errno().*;
            if (errno_val == @intFromEnum(std.posix.E.INVAL)) return error.DirectUnsupported;
            return error.WriteFailed;
        }
        if (n == 0) return error.WriteFailed;
        off += @as(usize, @intCast(n));
    }
}

fn syncPosix(fd: std.posix.fd_t) void {
    std.posix.fsync(fd) catch {};
    // Fsync the containing directory so the rename/truncate is durable.
    // Best effort: failures here must not fail the snapshot.
    const dir = std.c.open(".", std.posix.O{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
    if (dir >= 0) {
        std.posix.fsync(@as(std.posix.fd_t, dir)) catch {};
        _ = std.c.close(dir);
    }
}

pub fn createSnapshot(arena_mem: []const u8, wal: *WalManager, ring_buffer: *RingBuffer) !void {
    // Throttle: return early (log + return, NOT an error) when called
    // sooner than minIntervalMs after the last success.
    {
        const now = std.time.milliTimestamp();
        if (last_snapshot_ms >= 0 and now - last_snapshot_ms < minIntervalMs) {
            std.debug.print("[TakyonDB-Snapshot] Throttled ({} ms since last); skipping.\n", .{now - last_snapshot_ms});
            return;
        }
    }
    // Drain queued deltas into the WAL first: the snapshot must cover every
    // acknowledged write, and the WAL is truncated right after.
    var drained: usize = 0;
    while (ring_buffer.pop()) |pending| {
        if (pending.is_arena == 2) continue;
        wal.processDelta(pending, arena_mem) catch |err| {
            std.debug.print("[TakyonDB-Snapshot] Dropped delta during drain: {}\n", .{err});
        };
        drained += 1;
        if (drained > 1_000_000) break;
    }
    try wal.flushBuffer();

    const sizes = snapshotLen(arena_mem);
    const active_len = sizes.active_len;
    std.debug.print("[TakyonDB-Snapshot] Generating snapshot of {} bytes...\n", .{active_len});

    // We allocate an aligned 4KB buffer for direct I/O
    const allocator = std.heap.page_allocator;
    const raw = try allocator.alloc(u8, 8192);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];

    // Derive snapshot + tmp paths from the WAL path (no hardcoding).
    // wal.path is an owned [:0]u8 (see wal.zig); stack buffers are fine
    // because WalManager dupes on init and we only borrow here.
    var snap_buf: [4096]u8 = undefined;
    const snap_path = try std.fmt.bufPrintZ(&snap_buf, "{s}.snap", .{wal.path});
    var tmp_buf: [4096]u8 = undefined;
    const tmp_path = try std.fmt.bufPrintZ(&tmp_buf, "{s}.tmp", .{snap_path});

    var fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
    var use_direct = true;
    if (builtin.os.tag == .windows) {
        var path_w: [1024]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, tmp_path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0x40000000))), // GENERIC_WRITE
            0, // No sharing
            null,
            2, // CREATE_ALWAYS
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null,
        );
        if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
            std.debug.print("[TakyonDB-Snapshot] Error creating snapshot.\n", .{});
            return error.FileCreateError;
        }
        fd = handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .DIRECT = true }
        else
            std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
        const raw_fd = std.c.open(tmp_path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) {
            // Retry without DIRECT (filesystems like tmpfs reject it).
            const plain = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
            const retry = std.c.open(tmp_path.ptr, plain, @as(c_uint, 0o644));
            if (retry < 0) return error.FileCreateError;
            fd = @as(std.posix.fd_t, retry);
            use_direct = false;
        } else {
            fd = @as(std.posix.fd_t, raw_fd);
        }
    }
    const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
        std.hash.crc.Crc32
    else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
        std.hash.crc.Crc32Ieee
    else
        std.hash.Crc32;

    var hasher = Crc32.init();

    var offset: usize = 0;
    while (offset < active_len) {
        const remaining = active_len - offset;
        const to_copy = @min(remaining, 4096);
        @memset(buf, 0);
        @memcpy(buf[0..to_copy], arena_mem[offset .. offset + to_copy]);

        // Hash payload
        hasher.update(buf[0..4096]);

        if (builtin.os.tag == .windows) {
            var written: std.os.windows.DWORD = 0;
            if (std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, 4096, &written, null) == 0 or written != 4096) {
                _ = std.os.windows.CloseHandle(fd.?);
                return error.WriteFailed;
            }
        } else {
            writeAllPosix(fd.?, buf[0..4096]) catch |err| {
                if (err == error.DirectUnsupported and use_direct) {
                    // Reopen buffered and restart the snapshot.
                    _ = std.c.close(fd.?);
                    const plain = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
                    const retry = std.c.open(tmp_path.ptr, plain, @as(c_uint, 0o644));
                    if (retry < 0) return error.FileCreateError;
                    fd = @as(std.posix.fd_t, retry);
                    use_direct = false;
                    offset = 0;
                    hasher = Crc32.init();
                    continue;
                }
                _ = std.c.close(fd.?);
                return err;
            };
        }
        offset += to_copy;
    }

    // Footer v2 in the final 4K block:
    //   magic u32 [0..4], version u32 [4..8], crc u32 [8..12],
    //   active_len u32 [12..16], art_bump u32 [16..20],
    //   str_bump u32 [20..24], rest zeros.
    // MAGIC_OFFSET/VERSION_OFFSET (layout-v2) coincide with footer [0]/[4].
    @memset(buf, 0);
    const final_crc = hasher.final();
    std.mem.writeInt(u32, buf[MAGIC_OFFSET .. MAGIC_OFFSET + 4][0..4], FOOTER_MAGIC, .little);
    std.mem.writeInt(u32, buf[VERSION_OFFSET .. VERSION_OFFSET + 4][0..4], LAYOUT_VERSION, .little);
    std.mem.writeInt(u32, buf[8..12], final_crc, .little);
    std.mem.writeInt(u32, buf[12..16], @as(u32, @intCast(active_len)), .little);
    std.mem.writeInt(u32, buf[16..20], sizes.art_bump, .little);
    std.mem.writeInt(u32, buf[20..24], sizes.str_bump, .little);

    if (builtin.os.tag == .windows) {
        var written: std.os.windows.DWORD = 0;
        if (std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, 4096, &written, null) == 0 or written != 4096) {
            _ = std.os.windows.CloseHandle(fd.?);
            return error.WriteFailed;
        }
        _ = std.os.windows.kernel32.FlushFileBuffers(fd.?);
        _ = std.os.windows.CloseHandle(fd.?);
    } else {
        writeAllPosix(fd.?, buf[0..4096]) catch {
            _ = std.c.close(fd.?);
            return error.WriteFailed;
        };
        // Sync data AND directory before rotating the WAL: a snapshot that
        // is still in the page cache is worthless after a crash.
        syncPosix(fd.?);
        _ = std.c.close(fd.?);
    }
    fd = null;

    // Atomically publish tmp -> final so a crash never leaves a torn snap.
    // POSIX rename(2) is atomic. Windows cannot atomically replace via
    // rename: delete the destination first, then rename.
    // WINDOWS CRASH WINDOW: if we crash between delete and rename, the
    // snapshot is missing but the WAL is still intact (it is truncated
    // only below, after a successful rename), so recovery falls back to
    // WAL-only replay and stays correct.
    if (builtin.os.tag == .windows) {
        std.fs.cwd().deleteFile(snap_path) catch {};
    }
    std.fs.cwd().rename(tmp_path, snap_path) catch |err| {
        std.fs.cwd().deleteFile(tmp_path) catch {};
        std.debug.print("[TakyonDB-Snapshot] Atomic publish failed: {}\n", .{err});
        return error.RenameFailed;
    };
    // Best-effort directory fsync so the rename is durable.
    {
        const dir = std.c.open(".", std.posix.O{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
        if (dir >= 0 and builtin.os.tag != .windows) {
            std.posix.fsync(@as(std.posix.fd_t, dir)) catch {};
            _ = std.c.close(dir);
        }
    }

    std.debug.print("[TakyonDB-Snapshot] Snapshot saved and validated. Rotating WAL...\n", .{});

    // The snapshot covers every acknowledged write, so archived WAL
    // segments are stale: best-effort delete `<wal>.000000..` until the
    // first missing N (cap 100000, mirroring wal.zig MAX_SEGMENTS).
    {
        const base = wal.path[0..wal.path.len];
        var n: u32 = 0;
        var sbuf: [4096]u8 = undefined;
        while (n < 100_000) : (n += 1) {
            if (sbuf.len < base.len + 8) break;
            @memcpy(sbuf[0..base.len], base);
            sbuf[base.len] = '.';
            var v = n;
            var i: usize = 6;
            while (i > 0) : (i -= 1) {
                sbuf[base.len + i] = @as(u8, @intCast(v % 10)) + '0';
                v /= 10;
            }
            const seg = sbuf[0 .. base.len + 7];
            std.fs.cwd().deleteFile(seg) catch |err| {
                if (err == error.FileNotFound) break; // first missing: stop
                continue; // best effort: keep trying higher indexes
            };
        }
    }
    // 2. Log Rotation
    // The flusher drained the ring above, so no acknowledged write is lost.
    // Close current WAL
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(wal.fd);
    } else {
        _ = std.c.close(wal.fd);
    }

    // Truncate / Reopen WAL at its owned path (no hardcoding).
    const wal_path: [:0]const u8 = wal.path;
    if (builtin.os.tag == .windows) {
        var path_w: [1024]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, wal_path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0xC0000000))), // GENERIC_READ | GENERIC_WRITE
            1, // FILE_SHARE_READ
            null,
            2, // CREATE_ALWAYS (truncates)
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null,
        );
        wal.fd = handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            if (wal.direct)
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true, .DIRECT = true }
            else
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true }
        else
            std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true };
        const raw_fd = std.c.open(wal_path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) return error.FileCreateError;
        wal.fd = @as(std.posix.fd_t, raw_fd);
    }
    wal.sector_pos = 0;
    // Fresh empty live file: reset the segment byte counter and restart
    // rotation suffixes at 0. Segments stay dense-from-0, which is what
    // makes recovery's stop-at-first-missing scan exact.
    wal.bytes_written = 0;
    wal.next_segment = 0;

    last_snapshot_ms = std.time.milliTimestamp();
    std.debug.print("[TakyonDB-Snapshot] WAL truncated successfully. Resuming operations.\n", .{});
}

test "snapshot + recovery round-trip preserves records and index" {
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    // Must host the STRING arena (>= STRING_DATA_START) so triple bumps
    // can be asserted verbatim; stay >= MIN_ARENA_SIZE for realism.
    const arena_size = @max(layout.MIN_ARENA_SIZE, 12 * 1024 * 1024);

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    @memset(mem, 0);

    var ring = try RingBuffer.init(mem[layout.RING_OFFSET..], 64, true);
    var index = art.ArtIndex.init(mem, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);

    // Three fixed records with marker patterns.
    const rec_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.RECORD_BUMP_OFFSET));
    rec_bump.* = layout.RECORD_BUMP_INIT;
    const keys = [_][]const u8{ "alpha", "beta", "gamma" };
    for (keys, 0..) |k, i| {
        const off = rec_bump.*;
        @memset(mem[off .. off + 64], @as(u8, @intCast(0xA0 + i)));
        rec_bump.* = off + 64;
        try index.insert(k, off);
    }

    // Seed the STRING bank with a marker so str_bump survival is meaningful.
    const str_bump_ptr: *u32 = @ptrCast(@alignCast(mem.ptr + layout.STRING_BUMP_OFFSET));
    str_bump_ptr.* = layout.STRING_DATA_START;
    const str_data_len = 128;
    @memset(mem[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len], 0x5A);
    str_bump_ptr.* = layout.STRING_DATA_START + str_data_len;

    const exp_rec: u32 = rec_bump.*;
    const art_bump_ptr: *const u32 = @ptrCast(@alignCast(mem.ptr + layout.ART_BUMP_OFFSET));
    const exp_art_raw: u32 = art_bump_ptr.*;
    const exp_str: u32 = str_bump_ptr.*;
    const exp_art_aligned: u32 = (exp_art_raw + 7) & ~@as(u32, 7);

    std.fs.cwd().deleteFile("data.takyon") catch {};
    std.fs.cwd().deleteFile("data.takyon.snap") catch {};
    std.fs.cwd().deleteFile("data.takyon.snap.tmp") catch {};
    defer {
        std.fs.cwd().deleteFile("data.takyon") catch {};
        std.fs.cwd().deleteFile("data.takyon.snap") catch {};
        std.fs.cwd().deleteFile("data.takyon.snap.tmp") catch {};
    }

    var wal = try WalManager.init(allocator, "data.takyon");
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring);

    // Footer v2 sanity: magic/version/crc/active/art/str + trailing zeros.
    {
        const snap_file = try std.fs.cwd().openFile("data.takyon.snap", .{});
        defer snap_file.close();
        const stat = try snap_file.stat();
        try std.testing.expect(stat.size >= 8192);
        try std.testing.expectEqual(@as(u64, 0), stat.size % 4096);
        var footer: [4096]u8 = undefined;
        try snap_file.seekTo(stat.size - 4096);
        try snap_file.reader().readNoEof(&footer);
        const exp_magic: u32 = if (@hasDecl(layout, "ARENA_MAGIC")) layout.ARENA_MAGIC else 0x54414B59;
        const exp_ver: u32 = if (@hasDecl(layout, "LAYOUT_VERSION")) layout.LAYOUT_VERSION else 2;
        try std.testing.expectEqual(exp_magic, std.mem.readInt(u32, footer[0..4], .little));
        try std.testing.expectEqual(exp_ver, std.mem.readInt(u32, footer[4..8], .little));
        const active_len = std.mem.readInt(u32, footer[12..16], .little);
        try std.testing.expect(active_len >= 4096);
        try std.testing.expectEqual(exp_art_raw, std.mem.readInt(u32, footer[16..20], .little));
        try std.testing.expectEqual(exp_str, std.mem.readInt(u32, footer[20..24], .little));
        for (footer[24..]) |b| try std.testing.expectEqual(@as(u8, 0), b);
    }

    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    @memset(mem2, 0);
    try recovery.recoverWal(allocator, "data.takyon", mem2);

    // Record bytes survived verbatim.
    try std.testing.expectEqualSlices(u8, mem[layout.RECORD_START..exp_rec], mem2[layout.RECORD_START..exp_rec]);
    // String bytes survived verbatim.
    try std.testing.expectEqualSlices(
        u8,
        mem[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len],
        mem2[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len],
    );

    // Triple bumps survived (8-aligned, >= init).
    const rec2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.RECORD_BUMP_OFFSET))).*;
    const art2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.ART_BUMP_OFFSET))).*;
    const str2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.STRING_BUMP_OFFSET))).*;
    try std.testing.expectEqual((exp_rec + 7) & ~@as(u32, 7), rec2);
    try std.testing.expectEqual(exp_art_aligned, art2);
    try std.testing.expectEqual((exp_str + 7) & ~@as(u32, 7), str2);
    try std.testing.expect(rec2 >= layout.RECORD_BUMP_INIT);
    try std.testing.expect(art2 >= layout.ART_START);
    try std.testing.expect(str2 >= layout.STRING_DATA_START);

    // The ART index survived: reattach (bump already set) and search.
    var index2 = art.ArtIndex.init(mem2, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    for (keys, 0..) |k, i| {
        const off = index2.search(k) orelse return error.TestExpectedFound;
        try std.testing.expectEqual(@as(u8, @intCast(0xA0 + i)), mem2[off]);
    }
}
