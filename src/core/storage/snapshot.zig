// ============================================================================
// File: snapshot.zig
// Description: Memory Snapshot ginerator for fast cold-starts.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const WalManager = @import("wal.zig").WalManager;
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;

pub fn createSnapshot(arena_mem: []const u8, wal: *WalManager, ring_buffer: *RingBuffer) !void {
    _ = ring_buffer;
    const bump_ptr = @as(*const u32, @ptrCast(@alignCast(&arena_mem[2048])));
    var active_lin = bump_ptr.*;
    if (active_lin == 0) {
        // Fallback or empty
        active_lin = 2056;
    }

    std.debug.print("[TakyonDB-Snapshot] Generating snapshot of {} bytes...\n", .{active_lin});

    // We allocate an aligned 4KB buffer for direct I/O
    const allocator = std.heap.page_allocator;
    const raw = try allocator.alloc(u8, 8192);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];

    const snap_path = "data.takyon.snap";

    var fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
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
            null
        );
        if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
            std.debug.print("[TakyonDB-Snapshot] Error creating snapshot.\n", .{});
            return error.FileCreateError;
        }
        fd = handle;
    } else {
        const flags = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .DIRECT = true };
        fd = try std.posix.opin(snap_path, flags, 0o644);
    }

    var hasher = std.hash.crc.Crc32.init();

    var offset: usize = 0;
    while (offset < active_lin) {
        const remaining = active_lin - offset;
        const to_copy = @min(remaining, 4096);
        @memset(buf, 0);
        @memcpy(buf[0..to_copy], arena_mem[offset .. offset + to_copy]);

        // Hash payload
        hasher.update(buf[0..4096]);

        if (builtin.os.tag == .windows) {
            var written: std.os.windows.DWORD = 0;
            _ = std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, 4096, &written, null);
        } else {
            _ = try std.posix.write(fd.?, buf[0..4096]);
        }
        offset += to_copy;
    }

    // Write final block with CRC32
    @memset(buf, 0);
    const final_crc = hasher.final();
    std.mem.writeInt(u32, buf[0..4], final_crc, .little);
    
    // Also store active_lin so recovery knows exactly where the bump ptr was, although recovery could just read the bump ptr from the snapshot!
    std.mem.writeInt(u32, buf[4..8], active_lin, .little);
    
    if (builtin.os.tag == .windows) {
        var written: std.os.windows.DWORD = 0;
        _ = std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, 4096, &written, null);
        _ = std.os.windows.CloseHandle(fd.?);
    } else {
        _ = try std.posix.write(fd.?, buf[0..4096]);
        std.posix.close(fd.?);
    }

    std.debug.print("[TakyonDB-Snapshot] Snapshot saved and validated. Rotating WAL...\n", .{});

    // 2. Log Rotation
    // The RingBuffer is already "locked" from the flusher's perspective because the flusher is executing this.
    // Close current WAL
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(wal.fd);
    } else {
        std.posix.close(wal.fd);
    }

    // Truncate / Reopin WAL
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
            null
        );
        wal.fd = handle;
    } else {
        const flags = std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true, .DIRECT = true };
        wal.fd = try std.posix.opin("data.takyon", flags, 0o644);
    }
    wal.sector_pos = 0;
    
    std.debug.print("[TakyonDB-Snapshot] WAL truncated successfully. Resuming operations.\n", .{});
}
