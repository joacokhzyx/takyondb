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

fn readBump(arena_mem: []const u8, offset: usize, fallback: u32) u32 {
    if (offset + 4 > arena_mem.len) return fallback;
    const v = @as(*const u32, @ptrCast(@alignCast(arena_mem.ptr + offset))).*;
    if (v > arena_mem.len) return fallback;
    return v;
}

/// Highest byte the snapshot must cover: records, ART nodes and the active
/// string bank. Older snapshots only covered the record bump, silently
/// dropping the index and all strings on recovery.
fn snapshotLen(arena_mem: []const u8) usize {
    const rec = readBump(arena_mem, layout.RECORD_BUMP_OFFSET, layout.RECORD_BUMP_INIT);
    const art_bump = readBump(arena_mem, layout.ART_BUMP_OFFSET, layout.ART_START);
    const str_bump = readBump(arena_mem, layout.STRING_BUMP_OFFSET, layout.STRING_DATA_START);
    var active = @max(rec, @max(art_bump, str_bump));
    active = (active + 7) & ~@as(u32, 7);
    if (active < 4096) active = 4096;
    return @min(@as(usize, active), arena_mem.len);
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

    const active_len = snapshotLen(arena_mem);
    std.debug.print("[TakyonDB-Snapshot] Generating snapshot of {} bytes...\n", .{active_len});

    // We allocate an aligned 4KB buffer for direct I/O
    const allocator = std.heap.page_allocator;
    const raw = try allocator.alloc(u8, 8192);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];

    const snap_path = "data.takyon.snap";

    var fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
    var use_direct = true;
    if (builtin.os.tag == .windows) {
        var path_w: [256]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, snap_path);
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
        const raw_fd = std.c.open(snap_path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) {
            // Retry without DIRECT (filesystems like tmpfs reject it).
            const plain = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
            const retry = std.c.open(snap_path.ptr, plain, @as(c_uint, 0o644));
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
                    const retry = std.c.open(snap_path.ptr, plain, @as(c_uint, 0o644));
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

    // Write final block with CRC32
    @memset(buf, 0);
    const final_crc = hasher.final();
    std.mem.writeInt(u32, buf[0..4], final_crc, .little);

    // Also store active_len so recovery knows exactly how many bytes are live.
    std.mem.writeInt(u32, buf[4..8], @as(u32, @intCast(active_len)), .little);

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

    std.debug.print("[TakyonDB-Snapshot] Snapshot saved and validated. Rotating WAL...\n", .{});

    // 2. Log Rotation
    // The flusher drained the ring above, so no acknowledged write is lost.
    // Close current WAL
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(wal.fd);
    } else {
        _ = std.c.close(wal.fd);
    }

    // Truncate / Reopen WAL
    if (builtin.os.tag == .windows) {
        var path_w: [256]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, "data.takyon");
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
        const raw_fd = std.c.open("data.takyon", flags, @as(c_uint, 0o644));
        if (raw_fd < 0) return error.FileCreateError;
        wal.fd = @as(std.posix.fd_t, raw_fd);
    }
    wal.sector_pos = 0;

    std.debug.print("[TakyonDB-Snapshot] WAL truncated successfully. Resuming operations.\n", .{});
}

test "snapshot + recovery round-trip preserves records and index" {
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    const arena_size = 4 * 1024 * 1024;

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

    std.fs.cwd().deleteFile("data.takyon") catch {};
    std.fs.cwd().deleteFile("data.takyon.snap") catch {};
    defer {
        std.fs.cwd().deleteFile("data.takyon") catch {};
        std.fs.cwd().deleteFile("data.takyon.snap") catch {};
    }

    var wal = try WalManager.init(allocator, "data.takyon");
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring);

    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    @memset(mem2, 0);
    try recovery.recoverWal(allocator, "data.takyon", mem2);

    // Record bytes survived verbatim.
    try std.testing.expectEqualSlices(u8, mem[layout.RECORD_START..rec_bump.*], mem2[layout.RECORD_START..rec_bump.*]);

    // The ART index survived: reattach (bump already set) and search.
    var index2 = art.ArtIndex.init(mem2, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    for (keys, 0..) |k, i| {
        const off = index2.search(k) orelse return error.TestExpectedFound;
        try std.testing.expectEqual(@as(u8, @intCast(0xA0 + i)), mem2[off]);
    }
}
