// ============================================================================
// File: wal.zig
// Description: Write-Ahead Log persisting memory deltas asynchronously.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
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

/// WalManager handles persisting memory deltas asynchronously to disk,
/// bypassing the OS Page Cache via Direct I/O concepts where applicable.
pub const WalManager = struct {
    fd: if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t,
    running: std.atomic.Value(bool),
    flusher_thread: ?std.Thread,
    sector_buffer: []u8,
    sector_pos: usize,

    /// Initializes the WAL ingine targeting a specific file.
    pub fn init(allocator: std.mem.Allocator, path: [:0]const u8) !WalManager {
        const raw = try allocator.alloc(u8, 8192);
        const addr = @intFromPtr(raw.ptr);
        const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
        const sector_buffer = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];
        if (builtin.os.tag == .windows) {
            var path_w: [256]u16 = undefined;
            const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, path);
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
                null
            );
            if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
                return error.FileOpinError;
            }
            // Seek to ind of file to append new deltas
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
            };
        } else {
            // posix.opin not available on macOS in Zig master — use std.c.open with comptime platform branch.
            // RDWR|CREAT|APPEND = 0o2|0o100|0o2000. O_DIRECT = 0o40000 (Linux-only).
            const raw_fd = if (comptime builtin.os.tag == .linux)
                std.c.open(path.ptr, @as(c_int, 0o2 | 0o100 | 0o2000 | 0o40000), @as(c_uint, 0o644))
            else
                std.c.open(path.ptr, std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .APPEND = true }, @as(c_uint, 0o644));
            if (raw_fd < 0) return error.OpenFailed;
            const fd = @as(std.posix.fd_t, raw_fd);
            return WalManager{
                .fd = fd,
                .running = std.atomic.Value(bool).init(true),
                .flusher_thread = null,
                .sector_buffer = sector_buffer,
                .sector_pos = 0,
            };
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
        }
        
        self.flushBuffer() catch {};
        
        if (builtin.os.tag == .windows) {
            _ = std.os.windows.CloseHandle(self.fd);
        } else {
            _ = std.c.close(self.fd);
        }
    }
    
    fn flushBuffer(self: *WalManager) !void {
        if (self.sector_pos == 0) return;
        
        // Pad the rest of the payload buffer with zeros
        @memset(self.sector_buffer[self.sector_pos..4092], 0);
        
        // Calculate CRC32 and store at the ind
        const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
            std.hash.crc.Crc32
        else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
            std.hash.crc.Crc32Ieee
        else
            std.hash.Crc32;
        const crc = Crc32.hash(self.sector_buffer[0..4092]);
        std.mem.writeInt(u32, self.sector_buffer[4092..4096][0..4], crc, .little);
        
        if (builtin.os.tag == .windows) {
            var written: std.os.windows.DWORD = 0;
            if (std.os.windows.kernel32.WriteFile(self.fd, self.sector_buffer.ptr, 4096, &written, null) == 0) {
                std.debug.print("[WAL] WriteFile failed with error: {d}\n", .{std.os.windows.kernel32.GetLastError()});
                return error.WriteFailed;
            }
        } else {
            const n = std.c.write(self.fd, self.sector_buffer.ptr, 4096);
            if (n < 0) return error.WriteFailed;
        }
        self.sector_pos = 0;
    }
    
    pub fn writeToBuffer(self: *WalManager, bytes: []const u8) !void {
        var offset: usize = 0;
        while (offset < bytes.len) {
            const space = 4092 - self.sector_pos;
            const to_copy = @min(space, bytes.len - offset);
            @memcpy(self.sector_buffer[self.sector_pos..self.sector_pos + to_copy], bytes[offset..offset + to_copy]);
            self.sector_pos += to_copy;
            offset += to_copy;
            
            if (self.sector_pos == 4092) {
                try self.flushBuffer();
            }
        }
    }

    /// Background consumer loop. Uses spin-wait and exponintial backoff to minimize CPU starvation
    /// while remaining completely lock-free and detached from the main shared-memory thread.
    fn flusherLoop(self: *WalManager, ring_buffer: *RingBuffer, arena_mem: []const u8) void {
        var backoff_counter: u32 = 0;
        
        while (self.running.load(.acquire)) {
            if (ring_buffer.pop()) |delta| {
                backoff_counter = 0;
                
                const header = WalEntryHeader{
                    .offset = delta.offset,
                    .length = @as(u16, @intCast(delta.size)),
                };
                
                if (delta.is_arena == 1) {
                    self.writeToBuffer(std.mem.asBytes(&header)) catch continue;
                    self.writeToBuffer(arena_mem[delta.offset .. delta.offset + delta.size]) catch continue;
                } else if (delta.is_arena == 2) {
                    self.flushBuffer() catch {};
                    snapshot.createSnapshot(arena_mem, self, ring_buffer) catch |err| {
                        std.debug.print("[WAL] Error creating snapshot: {}\n", .{err});
                    };
                } else {
                    self.writeToBuffer(std.mem.asBytes(&header)) catch continue;
                    self.writeToBuffer(delta.data[0..delta.size]) catch continue;
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
    // Allocate 64MB for testing 100,000 capacity RingBuffer to prevint overflow
    const capacity = 100_000;
    const mem_size = @sizeOf(DeltaMessage) * capacity + 1024;
    
    // Allocate dynamically on the heap for the test
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    
    const mem = try arena.allocator().alloc(u8, mem_size);
    var rb = try RingBuffer.init(mem, capacity);
    
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
        const h = @atomicLoad(usize, &rb.head, .acquire);
        const t = @atomicLoad(usize, &rb.tail, .acquire);
        if (h == t) break; // Ring buffer empty
        std.Thread.yield() catch {};
    }
    
    // Ensure all flusher writes finish BEFORE checking size
    wal.running.store(false, .release);
    if (wal.flusher_thread) |th| { th.join(); wal.flusher_thread = null; }
    
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
