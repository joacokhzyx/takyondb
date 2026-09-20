// ============================================================================
// File: wal.zig
// Description: Write-Ahead Log persisting memory deltas asynchronously.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;
const DeltaMessage = @import("../ipc/ring_buffer.zig").DeltaMessage;
const snapshot = @import("snapshot.zig");

pub const WalEntryHeader = packed struct {
    offset: u32,
    length: u16,
};

/// Payload bytes per 4K sector; the trailing 4 bytes hold a CRC32.
pub const SECTOR_PAYLOAD: usize = 4092;
pub const SECTOR_SIZE: usize = 4096;

/// Largest single entry the log accepts (notifyArena payloads peak ~4KB).
pub const MAX_ENTRY_LEN: u32 = 8192;

/// WalManager handles persisting memory deltas asynchronously to disk,
/// bypassing the OS Page Cache via Direct I/O where applicable.
pub const WalManager = struct {
    fd: if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t,
    running: std.atomic.Value(bool),
    flusher_thread: ?std.Thread,
    sector_buffer: []u8,
    sector_pos: usize,
    /// Raw backing allocation for sector_buffer (freed on shutdown).
    backing: []u8,
    allocator: std.mem.Allocator,
    /// Owned path copy (dupeZ on init, freed on shutdown) used to reopen
    /// the file (daemon/test literals are borrowed by callers).
    path: [:0]u8,
    /// False once Direct I/O proved unsupported (tmpfs, etc.).
    direct: bool,

    /// Initializes the WAL engine targeting a specific file.
    pub fn init(allocator: std.mem.Allocator, path: [:0]const u8) !WalManager {
        const owned: [:0]u8 = try allocator.dupeZ(u8, path);
        errdefer allocator.free(owned);
        const raw = try allocator.alloc(u8, 8192);
        errdefer allocator.free(raw);
        const addr = @intFromPtr(raw.ptr);
        const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
        const sector_buffer = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];
        if (builtin.os.tag == .windows) {
            var path_w: [256]u16 = undefined;
            const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, owned);
            path_w[utf16_len] = 0;
            const access_mask = @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0xC0000000))); // GENERIC_READ | GENERIC_WRITE
            const share_mode: u32 = 1; // FILE_SHARE_READ
            const creation_disposition: u32 = 4; // OPEN_ALWAYS
            const flags_attributes: u32 = 0x80 | 0x20000000; // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING

            const handle = std.os.windows.kernel32.CreateFileW(
                @as([*:0]const u16, @ptrCast(&path_w)),
                access_mask,
                share_mode,
                null,
                creation_disposition,
                flags_attributes,
                null,
            );
            if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
                return error.FileOpenError;
            }
            // Seek to end of file to append new deltas
            var file_size: i64 = 0;
            _ = std.os.windows.kernel32.GetFileSizeEx(handle, &file_size);
            if (file_size > 0) {
                var new_ptr: i64 = 0;
                _ = std.os.windows.kernel32.SetFilePointerEx(handle, file_size, &new_ptr, std.os.windows.FILE_BEGIN);
            }

            return WalManager{
                .fd = handle,
                .running = std.atomic.Value(bool).init(true),
                .flusher_thread = null,
                .sector_buffer = sector_buffer,
                .sector_pos = 0,
                .backing = raw,
                .allocator = allocator,
                .path = owned,
                .direct = true,
            };
        } else {
            const fd = try openAppend(owned, true);
            return WalManager{
                .fd = fd,
                .running = std.atomic.Value(bool).init(true),
                .flusher_thread = null,
                .sector_buffer = sector_buffer,
                .sector_pos = 0,
                .backing = raw,
                .allocator = allocator,
                .path = owned,
                .direct = true,
            };
        }
    }

    fn openAppend(path: [:0]const u8, direct: bool) !std.posix.fd_t {
        const flags = if (comptime builtin.os.tag == .linux)
            if (direct)
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true, .DIRECT = true }
            else
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true }
        else
            std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true };
        const raw_fd = std.c.open(path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) return error.OpenFailed;
        return @as(std.posix.fd_t, raw_fd);
    }

    /// Reopens the file without Direct I/O after the filesystem rejected
    /// it (EINVAL on write, e.g. tmpfs). Keeps the append offset.
    fn downgradeDirect(self: *WalManager) void {
        if (builtin.os.tag == .windows) {
            self.direct = false;
            return;
        }
        _ = std.c.close(self.fd);
        if (openAppend(self.path, false)) |fd| {
            self.fd = fd;
            self.direct = false;
            std.debug.print("[WAL] Direct I/O unsupported; continuing buffered.\n", .{});
        } else |_| {
            // Keep the old fd; subsequent writes will keep failing loudly.
        }
    }

    /// Spawns the background Flusher thread for lock-free RingBuffer consumption.
    pub fn spawnWalFlusher(self: *WalManager, ring_buffer: *RingBuffer, arena_mem: []const u8) !void {
        self.flusher_thread = try std.Thread.spawn(.{}, flusherLoop, .{ self, ring_buffer, arena_mem });
    }

    /// Shuts down the background flusher and closes the file.
    pub fn shutdown(self: *WalManager) void {
        self.running.store(false, .release);
        if (self.flusher_thread) |th| {
            th.join();
            self.flusher_thread = null;
        }

        self.flushBuffer() catch {};

        if (builtin.os.tag == .windows) {
            _ = std.os.windows.CloseHandle(self.fd);
        } else {
            _ = std.c.close(self.fd);
        }
        self.allocator.free(self.backing);
        self.backing = &.{};
        self.sector_buffer = &.{};
        // Free the owned path copy (dupeZ on init). Reset to an empty
        // sentinel so a second shutdown does not double-free caller memory.
        if (self.path.len > 0) {
            self.allocator.free(self.path);
        }
        self.path = @constCast(@as([:0]const u8, ""));
    }

    fn syncFile(self: *WalManager) void {
        if (builtin.os.tag == .windows) {
            _ = std.os.windows.kernel32.FlushFileBuffers(self.fd);
        } else {
            std.posix.fsync(self.fd) catch {};
        }
    }

    fn writeSector(self: *WalManager) !void {
        if (builtin.os.tag == .windows) {
            var written: std.os.windows.DWORD = 0;
            if (std.os.windows.kernel32.WriteFile(self.fd, self.sector_buffer.ptr, 4096, &written, null) == 0) {
                std.debug.print("[WAL] WriteFile failed with error: {d}\n", .{std.os.windows.kernel32.GetLastError()});
                return error.WriteFailed;
            }
            if (written != 4096) return error.WriteFailed;
        } else {
            const n = std.c.write(self.fd, self.sector_buffer.ptr, 4096);
            if (n < 0) {
                const errno_val = std.c._errno().*;
                if (self.direct and errno_val == @intFromEnum(std.posix.E.INVAL)) {
                    self.downgradeDirect();
                    const retry = std.c.write(self.fd, self.sector_buffer.ptr, 4096);
                    if (retry != 4096) return error.WriteFailed;
                } else {
                    return error.WriteFailed;
                }
            } else if (n != 4096) {
                return error.WriteFailed;
            }
        }
    }

    pub fn flushBuffer(self: *WalManager) !void {
        if (self.sector_pos == 0) return;

        // Pad the rest of the payload buffer with zeros
        @memset(self.sector_buffer[self.sector_pos..4092], 0);

        // Calculate CRC32 and store at the end
        const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
            std.hash.crc.Crc32
        else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
            std.hash.crc.Crc32Ieee
        else
            std.hash.Crc32;
        const crc = Crc32.hash(self.sector_buffer[0..4092]);
        std.mem.writeInt(u32, self.sector_buffer[4092..4096][0..4], crc, .little);

        try self.writeSector();
        // Durability: a WAL that is not synced is just a rumor.
        self.syncFile();
        self.sector_pos = 0;
    }

    pub fn writeToBuffer(self: *WalManager, bytes: []const u8) !void {
        var offset: usize = 0;
        while (offset < bytes.len) {
            const space = 4092 - self.sector_pos;
            const to_copy = @min(space, bytes.len - offset);
            @memcpy(self.sector_buffer[self.sector_pos .. self.sector_pos + to_copy], bytes[offset .. offset + to_copy]);
            self.sector_pos += to_copy;
            offset += to_copy;

            if (self.sector_pos == 4092) {
                try self.flushBuffer();
            }
        }
    }

    /// Validates and persists one delta. Corrupt offsets/sizes (possible
    /// from a compromised or buggy producer) are dropped, never replayed
    /// into panics.
    pub fn processDelta(self: *WalManager, delta: DeltaMessage, arena_mem: []const u8) !void {
        if (delta.is_arena == 1) {
            if (delta.size > MAX_ENTRY_LEN) return error.CorruptDelta;
            if (@as(usize, delta.offset) + delta.size > arena_mem.len) return error.CorruptDelta;
            const header = WalEntryHeader{
                .offset = delta.offset,
                .length = @as(u16, @intCast(delta.size)),
            };
            try self.writeToBuffer(std.mem.asBytes(&header));
            try self.writeToBuffer(arena_mem[delta.offset .. delta.offset + delta.size]);
        } else if (delta.is_arena == 0) {
            if (delta.size > 48) return error.CorruptDelta;
            const header = WalEntryHeader{
                .offset = delta.offset,
                .length = @as(u16, @intCast(delta.size)),
            };
            try self.writeToBuffer(std.mem.asBytes(&header));
            try self.writeToBuffer(delta.data[0..delta.size]);
        }
        // is_arena == 2 (checkpoint) is handled by the loop, not here.
    }

    /// Background consumer loop with exponential backoff to avoid CPU
    /// starvation while remaining lock-free.
    fn flusherLoop(self: *WalManager, ring_buffer: *RingBuffer, arena_mem: []const u8) void {
        var backoff_counter: u32 = 0;

        while (self.running.load(.acquire)) {
            if (ring_buffer.pop()) |delta| {
                backoff_counter = 0;

                if (delta.is_arena == 2) {
                    // Checkpoint: drain everything queued before snapshotting
                    // so the snapshot covers all acknowledged writes.
                    while (ring_buffer.pop()) |pending| {
                        if (pending.is_arena == 2) continue;
                        self.processDelta(pending, arena_mem) catch |err| {
                            std.debug.print("[WAL] Dropped delta during drain: {}\n", .{err});
                        };
                    }
                    self.flushBuffer() catch {};
                    snapshot.createSnapshot(arena_mem, self, ring_buffer) catch |err| {
                        std.debug.print("[WAL] Error creating snapshot: {}\n", .{err});
                    };
                } else {
                    self.processDelta(delta, arena_mem) catch |err| {
                        std.debug.print("[WAL] Dropped corrupt delta: {}\n", .{err});
                    };
                }
            } else {
                self.flushBuffer() catch {};

                backoff_counter += 1;
                if (backoff_counter < 1000) {
                    std.atomic.spinLoopHint();
                } else {
                    std.Thread.yield() catch {};
                }
            }
        }
    }
};

test "WAL Lock-Free Flusher Integration" {
    // 1. Setup
    // Allocate 64MB for testing 100,000 capacity RingBuffer to prevent overflow
    const capacity = 100_000;
    const mem_size = @sizeOf(DeltaMessage) * capacity + 1024;

    // Allocate dynamically on the heap for the test
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();

    const mem_raw = try arena.allocator().alloc(u8, mem_size + 64);
    const mem_start = std.mem.alignForward(usize, @intFromPtr(mem_raw.ptr), 64);
    const mem = @as([*]u8, @ptrFromInt(mem_start))[0..mem_size];
    var rb = try RingBuffer.init(mem, capacity, true);

    var wal = try WalManager.init(arena.allocator(), "data.takyon");
    // No defer shutdown, we do it explicitly

    // 2. Spawn flusher background thread
    try wal.spawnWalFlusher(&rb, mem);

    // 3. Inject 100,000 deltas from Producer thread (main test thread)
    var timer = try std.time.Timer.start();

    var i: u32 = 0;
    while (i < 100_000) : (i += 1) {
        var delta = DeltaMessage{
            .offset = i * 4,
            .size = 4,
            .is_arena = 0,
            .data = undefined,
        };
        delta.data[0] = 0xAA;
        delta.data[1] = 0xBB;
        delta.data[2] = 0xCC;
        delta.data[3] = 0xDD;

        // Push until successful (lock-free)
        while (!rb.push(delta)) {
            std.atomic.spinLoopHint();
        }
    }

    // 4. Wait for consumer to flush everything
    while (true) {
        const h = @atomicLoad(usize, &rb.header.head, .acquire);
        const t = @atomicLoad(usize, &rb.header.tail, .acquire);
        if (h == t) break; // Ring buffer empty
        std.Thread.yield() catch {};
    }

    // Ensure all flusher writes finish BEFORE checking size
    wal.running.store(false, .release);
    if (wal.flusher_thread) |th| {
        th.join();
        wal.flusher_thread = null;
    }

    if (builtin.os.tag == .windows) {
        var size: i64 = 0;
        _ = std.os.windows.kernel32.GetFileSizeEx(wal.fd, &size);
        const padded_writes = (100_000 * (@sizeOf(WalEntryHeader) + 4));
        const expected_size = @as(i64, @intCast((padded_writes + 4095) / 4096 * 4096));
        try std.testing.expectEqual(expected_size, size);
    }

    const elapsed = timer.read();
    std.debug.print("\n[TakyonDB-Test] 100,000 deltas persisted in {} ms.\n", .{elapsed / std.time.ns_per_ms});

    wal.shutdown();
}
