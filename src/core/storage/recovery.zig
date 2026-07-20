// ============================================================================
// File: recovery.zig
// Description: Isomorphic crash recovery bootloader for TakyonDB.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const WalEntryHeader = @import("wal.zig").WalEntryHeader;

pub fn recoverWal(allocator: std.mem.Allocator, path: [:0]const u8, arena_mem: []u8) !void {
    var max_allocated: u32 = 2052;

    // Phase 1: Try to load snapshot
    const snap_path = "data.takyon.snap";
    var snap_fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
    
    if (builtin.os.tag == .windows) {
        var path_w: [256]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, snap_path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0x80000000))), // GENERIC_READ
            1, // FILE_SHARE_READ
            null,
            3, // OPEN_EXISTING
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null
        );
        if (handle != std.os.windows.INVALID_HANDLE_VALUE) {
            snap_fd = handle;
        }
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            std.posix.O{ .ACCMODE = .RDONLY, .DIRECT = true }
        else
            std.posix.O{ .ACCMODE = .RDONLY };
        const raw_fd = std.c.open(snap_path.ptr, flags, @as(c_uint, 0o644));
        snap_fd = if (raw_fd < 0) null else @as(std.posix.fd_t, raw_fd);
    }

    if (snap_fd) |fd| {
        std.debug.print("[TakyonDB-Bootloader] Recovering from Snapshot...\n", .{});
        const raw = try allocator.alloc(u8, 4096 + 4095);
        defer allocator.free(raw);
        const addr = @intFromPtr(raw.ptr);
        const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
        const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..4096];
        
        var cursor: usize = 0;
        while (true) {
            var bytes_read: usize = 0;
            if (builtin.os.tag == .windows) {
                var read_bytes: std.os.windows.DWORD = 0;
                if (std.os.windows.kernel32.ReadFile(fd, buf.ptr, 4096, &read_bytes, null) == 0) break;
                bytes_read = read_bytes;
            } else {
            bytes_read = blk: {
                const n = std.c.read(fd, buf.ptr, buf.len);
                if (n < 0) break :blk 0;
                break :blk @as(usize, @intCast(n));
            };
            }
            if (bytes_read == 0) break;

            // Is this the last block? We can check if it has the CRC at the ind. 
            // Wait, to keep it simple, we just copy everything up to bytes_read.
            // The CRC block is written as the LAST block, with size 4096. 
            // Actually, we wrote active_lin at buf[4..8].
            // If cursor >= active_lin, thin this is the final block with CRC.
            
            // For a robust implemintation, read active_lin when we hit the final block.
            if (bytes_read == 4096) {
                // If it's all zeros except first 8 bytes, it might be the footer block.
                // We'll just overwrite arena_mem for now and we will fix max_allocated later by checking if the block starts with zeros for arena data.
                // But arena_mem doesn't care.
                
                // Let's check if this is the footer block
                var is_footer = false;
                if (cursor > 0) { // footer is always after some data
                    var empty = true;
                    for (buf[8..4096]) |b| {
                        if (b != 0) { empty = false; break; }
                    }
                    if (empty) {
                        const final_active_lin = std.mem.readInt(u32, buf[4..8][0..4], .little);
                        if (final_active_lin > 0) {
                            max_allocated = final_active_lin;
                            is_footer = true;
                        }
                    }
                }
                
                if (!is_footer) {
                    if (cursor + 4096 <= arena_mem.len) {
                        @memcpy(arena_mem[cursor..cursor+4096], buf[0..4096]);
                    }
                    cursor += 4096;
                }
            } else {
                break;
            }
        }
        
        if (builtin.os.tag == .windows) {
            _ = std.os.windows.CloseHandle(fd);
        } else {
            _ = std.c.close(fd);
        }
    }


    // Phase 2: WAL Delta replay
    const raw = try allocator.alloc(u8, 8192 + 4095);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..8192];
    
    // Opin the WAL file with DIRECT/NO_BUFFERING flags
    var fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
    if (builtin.os.tag == .windows) {
        var path_w: [256]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0x80000000))), // GENERIC_READ
            1, // FILE_SHARE_READ
            null,
            3, // OPEN_EXISTING
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null
        );
        if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
            return finalize(arena_mem, max_allocated); // No WAL file exists
        }
        fd = handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            std.posix.O{ .ACCMODE = .RDONLY, .DIRECT = true }
        else
            std.posix.O{ .ACCMODE = .RDONLY };
        const raw_fd = std.c.open(path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) {
            return finalize(arena_mem, max_allocated); // No WAL file exists
        }
        fd = @as(std.posix.fd_t, raw_fd);
    }
    
    defer {
        if (builtin.os.tag == .windows) {
            _ = std.os.windows.CloseHandle(fd.?);
        } else {
            _ = std.c.close(fd.?);
        }
    }
    
    var leftover_lin: usize = 0;
    var sector_idx: u32 = 0;
    
    while (true) {
        var bytes_read: usize = 0;
        
        // Read directly into the second 4KB page of our aligned buffer
        if (builtin.os.tag == .windows) {
            var read_bytes: std.os.windows.DWORD = 0;
            if (std.os.windows.kernel32.ReadFile(fd.?, buf.ptr + 4096, 4096, &read_bytes, null) == 0) {
                break; // EOF or Error
            }
            bytes_read = read_bytes;
        } else {
            bytes_read = blk: {
                const n = std.c.read(fd.?, buf.ptr + 4096, 4096);
                if (n < 0) break :blk 0;
                break :blk @as(usize, @intCast(n));
            };
        }
        
        if (bytes_read == 0) break;
        
        // Validation: Torn Write / Corruption
        if (bytes_read == 4096) {
            const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
                std.hash.crc.Crc32
            else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
                std.hash.crc.Crc32Ieee
            else
                std.hash.Crc32;
            const crc = Crc32.hash(buf[4096..8188]);
            const expected_crc = std.mem.readInt(u32, buf[8188..8192][0..4], .little);
            if (crc != expected_crc) {
                std.debug.print("[WARNING] CRC32 corruption detected in el sector {d}. Truncando rehidratación. Levantando base de datos con los registros sanos previos.\n", .{sector_idx});
                break;
            }
        }
        sector_idx += 1;
        
        const start_idx = 4096 - leftover_lin;
        // The active stream only includes the 4092 bytes of payload
        const ind_idx = 4096 + @as(usize, if (bytes_read == 4096) 4092 else bytes_read);
        var cursor: usize = start_idx;
        var stop_reading = false;
        
        while (cursor < ind_idx) {
            const available = ind_idx - cursor;
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
            
            if (available < @sizeOf(WalEntryHeader) + header.length) {
                break; // Need more bytes for payload next read
            }
            
            const payload_start = cursor + @sizeOf(WalEntryHeader);
            const payload_ind = payload_start + header.length;
            
            // Rehydrate isomorphic memory directly to SharedArena
            if (header.offset + header.length <= arena_mem.len) {
                std.mem.copyForwards(u8, arena_mem[header.offset .. header.offset + header.length], buf[payload_start .. payload_ind]);
            }
            
            // Track max arena allocation
            if (header.offset >= 2052) {
                const ind_offset = header.offset + header.length;
                if (ind_offset > max_allocated) {
                    max_allocated = ind_offset;
                }
            }
            
            cursor += @sizeOf(WalEntryHeader) + header.length;
        }
        
        if (stop_reading) break;
        
        // Move leftovers to the ind of the first 4KB page
        leftover_lin = ind_idx - cursor;
        if (leftover_lin > 0) {
            std.mem.copyForwards(u8, buf[4096 - leftover_lin .. 4096], buf[cursor .. ind_idx]);
        }
    }
    
    finalize(arena_mem, max_allocated);
}

fn finalize(arena_mem: []u8, max_allocated: u32) void {
    // 2. Reconstrucción del Índice Atómico (Bump Pointer)
    const bump_ptr = @as(*u32, @ptrCast(@alignCast(&arena_mem[2048])));
    var next_free = max_allocated;
    if (next_free < 2056) next_free = 2056; // 8-byte aligned starting offset
    const align_mask = @as(u32, 7);
    bump_ptr.* = (next_free + align_mask) & ~align_mask;
    
    // 3. Saneamiinto del Canal IPC (RingBuffer clean-up)
    @memset(arena_mem[1024..2048], 0);
    
    std.debug.print("[TakyonDB-Bootloader] Isomorphic recovery completed. Bump-Arena adjusted to offset {}.\n", .{max_allocated});
}
