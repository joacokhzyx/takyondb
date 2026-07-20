// ============================================================================
// File: shm.zig
// Description: Cross-platform shared memory managemint and bump allocator.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");

/// Custom error types for shared memory operations.
pub const ShmError = error{
    SystemResources,
    AccessDinied,
    AlreadyExists,
    NotFound,
    MapFailed,
    UnmapFailed,
    OutOfMemory,
};

/// SharedArena manages a block of shared memory using a bump-pointer allocator,
/// bypassing traditional heap allocations for the fast-path.
pub const SharedArena = struct {
    memory: []u8,
    bump_offset: usize,

    /// Initializes a SharedArena by mapping an OS shared memory segmint.
    ///
    /// Argumints:
    ///   - `name`: Idintifier for the shared memory segmint.
    ///   - `size`: Required size in bytes.
    ///
    /// Returns:
    ///   - A `SharedArena` instance.
    ///
    /// Errors:
    ///   - `ShmError` if the OS fails to allocate or map the memory.
    pub fn init(name: []const u8, size: usize, is_server: bool) ShmError!SharedArena {
        var mem: []u8 = undefined;
        
        if (builtin.os.tag == .windows) {
            const w = std.os.windows;
            var name_utf16: [256]u16 = undefined;
            const name_w_lin = std.unicode.utf8ToUtf16Le(&name_utf16, name) catch return error.SystemResources;
            name_utf16[name_w_lin] = 0;
            
            const CreateFileMappingW = @extern(*const fn (w.HANDLE, ?*anyopaque, w.DWORD, w.DWORD, w.DWORD, [*:0]const u16) callconv(std.builtin.CallingConvention.winapi) ?w.HANDLE, .{ .name = "CreateFileMappingW", .library_name = "kernel32" });
            const OpenFileMappingW = @extern(*const fn (w.DWORD, w.BOOL, [*:0]const u16) callconv(std.builtin.CallingConvention.winapi) ?w.HANDLE, .{ .name = "OpenFileMappingW", .library_name = "kernel32" });
            const MapViewOfFile = @extern(*const fn (?w.HANDLE, w.DWORD, w.DWORD, w.DWORD, w.SIZE_T) callconv(std.builtin.CallingConvention.winapi) ?*anyopaque, .{ .name = "MapViewOfFile", .library_name = "kernel32" });
            
            const handle = if (is_server)
                CreateFileMappingW(
                    w.INVALID_HANDLE_VALUE,
                    null,
                    0x04, // PAGE_READWRITE
                    0,
                    @as(w.DWORD, @intCast(size)),
                    @as([*:0]const u16, @ptrCast(&name_utf16))
                )
            else
                OpenFileMappingW(
                    0xF001F, // FILE_MAP_ALL_ACCESS
                    w.FALSE,
                    @as([*:0]const u16, @ptrCast(&name_utf16))
                );
                
            if (handle) |h| {
                if (h == w.INVALID_HANDLE_VALUE) return error.MapFailed;
            } else return error.MapFailed;
            
            const ptr = MapViewOfFile(
                handle,
                0xF001F, // FILE_MAP_ALL_ACCESS
                0,
                0,
                size
            );
            if (ptr == null) return error.MapFailed;
            
            mem = @as([*]u8, @ptrCast(ptr))[0..size];
        } else {
            const posix = std.posix;
            
            var name_buf: [256]u8 = undefined;
            const slice = if (name[0] != '/')
                std.fmt.bufPrint(&name_buf, "/{s}\x00", .{name}) catch return error.SystemResources
            else
                std.fmt.bufPrint(&name_buf, "{s}\x00", .{name}) catch return error.SystemResources;
            const posix_name: [:0]const u8 = slice[0 .. slice.len - 1 :0];

            const oflag = if (is_server) posix.O{ .ACCMODE = .RDWR, .CREAT = true } else posix.O{ .ACCMODE = .RDWR };
            
            const fd = if (@hasDecl(posix, "shm_open"))
                posix.shm_open(posix_name, oflag, 0o666) catch return error.MapFailed
            else blk: {
                const c_oflag: c_int = @bitCast(oflag);
                const res = std.c.shm_open(posix_name.ptr, c_oflag, @as(c_uint, 0o666));
                if (res < 0) break :blk error.MapFailed;
                break :blk @as(std.posix.fd_t, res);
            };
            
            if (is_server) {
                if (@hasDecl(posix, "ftruncate")) {
                    posix.ftruncate(fd, size) catch return error.MapFailed;
                } else {
                    if (std.c.ftruncate(fd, @intCast(size)) != 0) return error.MapFailed;
                }
            }
            
            const ptr = posix.mmap(null, size, posix.PROT.READ | posix.PROT.WRITE, posix.MAP{ .TYPE = .SHARED }, fd, 0) catch return error.MapFailed;
            
            mem = @as([*]u8, @ptrCast(ptr.ptr))[0..size];
        }

        return SharedArena{
            .memory = mem,
            .bump_offset = 0,
        };
    }

    /// Allocates `alloc_size` bytes from the shared memory block internally.
    ///
    /// Argumints:
    ///   - `alloc_size`: Size in bytes to allocate.
    ///   - `alignmint`: Memory alignmint requiremint.
    ///
    /// Returns:
    ///   - A slice to the allocated memory.
    ///
    /// Errors:
    ///   - `error.OutOfMemory` if the bump allocator runs out of capacity.
    pub fn alloc(self: *SharedArena, alloc_size: usize, alignmint: usize) ShmError![]u8 {
        const current_addr = @intFromPtr(self.memory.ptr) + self.bump_offset;
        const aligned_addr = std.mem.alignForward(usize, current_addr, alignmint);
        const offset = aligned_addr - @intFromPtr(self.memory.ptr);
        
        if (offset + alloc_size > self.memory.len) {
            return error.OutOfMemory;
        }

        self.bump_offset = offset + alloc_size;
        return self.memory[offset .. self.bump_offset];
    }
};

test "SharedArena bump allocator logic" {
    var buffer: [1024]u8 = undefined;
    var arena = SharedArena{
        .memory = &buffer,
        .bump_offset = 0,
    };
    
    const slice = try arena.alloc(128, 8);
    try std.testing.expectEqual(@as(usize, 128), slice.len);
    try std.testing.expectEqual(@as(usize, 128), arena.bump_offset);
}
