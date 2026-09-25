// ============================================================================
// File: shm.zig
// Description: Cross-platform shared memory managemint and bump allocator.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const layout = @import("layout.zig");

/// Custom error types for shared memory operations.
pub const ShmError = error{
    SystemResources,
    AccessDinied,
    AlreadyExists,
    NotFound,
    MapFailed,
    UnmapFailed,
    OutOfMemory,
    BadVersion,
    SizeMismatch,
};

/// Failure-injection seam for teardown paths (munmap/CloseHandle).
/// Tests set `inject_teardown_error` to simulate an OS unmap/close
/// failure; `close()` then skips the syscall but still invalidates local
/// state, so error paths are exercisable without real mappings.
/// Counters are process-wide for test assertions.
pub var inject_teardown_error: bool = false;
pub var unmap_calls: usize = 0;
pub var close_calls: usize = 0;

/// Unmaps `mem` through the injection seam (no-op under injection).
pub fn unmapSegment(mem: []u8) void {
    unmap_calls += 1;
    if (inject_teardown_error) return;
    if (builtin.os.tag == .windows) {
        const w = std.os.windows;
        const UnmapViewOfFile = @extern(*const fn (?*const anyopaque) callconv(std.builtin.CallingConvention.winapi) w.BOOL, .{ .name = "UnmapViewOfFile", .library_name = "kernel32" });
        _ = UnmapViewOfFile(@as(?*const anyopaque, @ptrCast(mem.ptr)));
    } else {
        const aligned: []align(std.heap.page_size_min) u8 = @alignCast(mem);
        std.posix.munmap(aligned);
    }
}

/// Closes `handle` through the injection seam (no-op under injection).
pub fn closeHandle(handle: OsHandle) void {
    close_calls += 1;
    if (inject_teardown_error) return;
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(handle);
    } else {
        std.posix.close(handle);
    }
}

/// OS handle owning the mapping, for explicit cleanup via close().
/// Clients unmap + close without unlinking: the daemon owns the name.
pub const OsHandle = if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t;

/// How a SharedArena mapping is opened (Wave-1 memory-map v2).
///   - `server`: create-or-attach with read/write access. The creating
///     server stamps the magic+version header; an attaching server verifies
///     size and header first (SizeMismatch / BadVersion on drift).
///   - `read_write`: attach to an existing segment with read/write access.
///   - `read_only`: attach to an existing segment with read-only access
///     (POSIX O_RDONLY + PROT_READ; Windows FILE_MAP_READ).
pub const OpenMode = enum { server, read_write, read_only };

/// Attach-open retry budget. Reopening an existing segment sporadically
/// fails with EACCES on macOS/Windows CI runners (object-lifecycle races,
/// AV holds); genuine errors surface unchanged after the budget, so this
/// rides out transients without masking real failures. NotFound always
/// fails fast (a missing segment is definitive).
const ATTACH_RETRIES: u8 = 5;

/// Opens an existing POSIX segment with bounded transient tolerance.
/// See ATTACH_RETRIES.
fn openAttach(posix_name: [:0]const u8, flags: c_int) ShmError!std.posix.fd_t {
    var attempt: u8 = 0;
    while (true) : (attempt += 1) {
        const res = std.c.shm_open(posix_name.ptr, flags, @as(c_uint, 0o666));
        if (res >= 0) return res;
        const err = mapPosixOpenErr(lastErrno());
        if (err == error.NotFound or attempt >= ATTACH_RETRIES) return err;
        if (err != error.AccessDinied and err != error.MapFailed) return err;
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
}

/// Normalizes a segment name to POSIX `shm_open` form (leading `/`).
fn posixName(name: []const u8, buf: *[256]u8) ShmError![:0]const u8 {
    if (name.len == 0 or name.len > 255) return error.SystemResources;
    const slice = if (name[0] != '/')
        std.fmt.bufPrint(buf, "/{s}\x00", .{name}) catch return error.SystemResources
    else
        std.fmt.bufPrint(buf, "{s}\x00", .{name}) catch return error.SystemResources;
    return slice[0 .. slice.len - 1 :0];
}

/// Normalizes a segment name to a macOS file-backed path (/tmp).
/// Strips one leading `/` (so daemon names like `/TakyonDB_Master` work)
/// and rejects any remaining `/` to prevent path escape.
fn macosPath(name: []const u8, buf: *[512]u8) ShmError![]const u8 {
    var clean = name;
    if (clean.len > 0 and clean[0] == '/') clean = clean[1..];
    if (clean.len == 0 or clean.len > 200) return error.SystemResources;
    if (std.mem.indexOfScalar(u8, clean, '/') != null) return error.SystemResources;
    return std.fmt.bufPrint(buf, "/tmp/takyondb_{s}", .{clean}) catch return error.SystemResources;
}

/// Granular mapping of POSIX `shm_open` errno values to ShmError.
fn mapPosixOpenErr(e: std.posix.E) ShmError {
    return switch (e) {
        .EXIST => error.AlreadyExists,
        .ACCES => error.AccessDinied,
        .NOENT => error.NotFound,
        else => error.MapFailed,
    };
}

fn lastErrno() std.posix.E {
    const n: c_int = std.c._errno().*;
    return @enumFromInt(@as(u16, @intCast(n)));
}

/// Stamps the ARENA_MAGIC + LAYOUT_VERSION header (u32 little-endian).
fn writeHeader(mem: []u8) void {
    std.mem.writeInt(u32, mem[layout.MAGIC_OFFSET..][0..4], layout.ARENA_MAGIC, .little);
    std.mem.writeInt(u32, mem[layout.VERSION_OFFSET..][0..4], layout.LAYOUT_VERSION, .little);
}

/// Verifies the ARENA_MAGIC + LAYOUT_VERSION header.
fn checkHeader(mem: []u8) bool {
    if (mem.len < layout.VERSION_OFFSET + 4) return false;
    const magic = std.mem.readInt(u32, mem[layout.MAGIC_OFFSET..][0..4], .little);
    const version = std.mem.readInt(u32, mem[layout.VERSION_OFFSET..][0..4], .little);
    return magic == layout.ARENA_MAGIC and version == layout.LAYOUT_VERSION;
}

/// SharedArena manages a block of shared memory using a bump-pointer allocator,
/// bypassing traditional heap allocations for the fast-path.
pub const SharedArena = struct {
    memory: []u8,
    bump_offset: usize,
    handle: ?OsHandle = null,

    /// Initializes a SharedArena by mapping an OS shared memory segmint.
    ///
    /// Argumints:
    ///   - `name`: Idintifier for the shared memory segmint.
    ///   - `size`: Required size in bytes (must be >= layout.MIN_ARENA_SIZE).
    ///   - `mode`: Open mode (server create-or-attach, client RW, client RO).
    ///
    /// Returns:
    ///   - A `SharedArena` instance.
    ///
    /// Errors:
    ///   - `ShmError` if the OS fails to allocate or map the memory.
    pub fn init(name: []const u8, size: usize, mode: OpenMode) ShmError!SharedArena {
        if (size < layout.MIN_ARENA_SIZE) return error.OutOfMemory;
        if (name.len == 0 or name.len > 255) return error.SystemResources;
        var mem: []u8 = undefined;
        var handle: ?OsHandle = null;

        if (builtin.os.tag == .windows) {
            const w = std.os.windows;
            var name_utf16: [256]u16 = undefined;
            const name_w_lin = std.unicode.utf8ToUtf16Le(&name_utf16, name) catch return error.SystemResources;
            name_utf16[name_w_lin] = 0;

            const CreateFileMappingW = @extern(*const fn (w.HANDLE, ?*anyopaque, w.DWORD, w.DWORD, w.DWORD, [*:0]const u16) callconv(std.builtin.CallingConvention.winapi) ?w.HANDLE, .{ .name = "CreateFileMappingW", .library_name = "kernel32" });
            const OpenFileMappingW = @extern(*const fn (w.DWORD, w.BOOL, [*:0]const u16) callconv(std.builtin.CallingConvention.winapi) ?w.HANDLE, .{ .name = "OpenFileMappingW", .library_name = "kernel32" });
            const MapViewOfFile = @extern(*const fn (?w.HANDLE, w.DWORD, w.DWORD, w.DWORD, w.SIZE_T) callconv(std.builtin.CallingConvention.winapi) ?*anyopaque, .{ .name = "MapViewOfFile", .library_name = "kernel32" });
            const UnmapViewOfFile = @extern(*const fn (?*const anyopaque) callconv(std.builtin.CallingConvention.winapi) w.BOOL, .{ .name = "UnmapViewOfFile", .library_name = "kernel32" });

            const FILE_MAP_READ: w.DWORD = 0x0004;
            const FILE_MAP_ALL_ACCESS: w.DWORD = 0xF001F;
            const access: w.DWORD = if (mode == .read_only) FILE_MAP_READ else FILE_MAP_ALL_ACCESS;
            const win_name = @as([*:0]const u16, @ptrCast(&name_utf16));

            var win_handle: w.HANDLE = undefined;
            var created = false;
            if (mode == .server) {
                const h = CreateFileMappingW(w.INVALID_HANDLE_VALUE, null, 0x04, // PAGE_READWRITE
                    0, @as(w.DWORD, @intCast(size)), win_name);
                if (h == null or h.? == w.INVALID_HANDLE_VALUE) return error.MapFailed;
                win_handle = h.?;
                created = (w.GetLastError() != .ALREADY_EXISTS);
            } else {
                var attempt: u8 = 0;
                while (true) : (attempt += 1) {
                    const h = OpenFileMappingW(access, w.FALSE, win_name);
                    if (h != null and h.? != w.INVALID_HANDLE_VALUE) {
                        win_handle = h.?;
                        break;
                    }
                    const err = switch (w.GetLastError()) {
                        .FILE_NOT_FOUND, .PATH_NOT_FOUND => error.NotFound,
                        .ACCESS_DENIED => error.AccessDinied,
                        else => error.MapFailed,
                    };
                    // Same transient tolerance as POSIX openAttach; a
                    // missing segment is definitive and fails fast.
                    if (err == error.NotFound or attempt >= ATTACH_RETRIES) return err;
                    if (err != error.AccessDinied and err != error.MapFailed) return err;
                    std.Thread.sleep(5 * std.time.ns_per_ms);
                }
            }

            // Map the whole section (size 0) and learn its real size via
            // VirtualQuery: GetFileSizeEx is meaningless for pagefile-backed
            // sections (it fails, wedging every attach on SizeMismatch).
            const ptr = MapViewOfFile(win_handle, access, 0, 0, 0);
            if (ptr == null) {
                w.CloseHandle(win_handle);
                return error.MapFailed;
            }
            var mbi: w.MEMORY_BASIC_INFORMATION = std.mem.zeroes(w.MEMORY_BASIC_INFORMATION);
            _ = w.VirtualQuery(ptr, &mbi, @sizeOf(w.MEMORY_BASIC_INFORMATION)) catch {
                _ = UnmapViewOfFile(@as(?*const anyopaque, @ptrCast(ptr)));
                w.CloseHandle(win_handle);
                return error.MapFailed;
            };
            const mapped = @as([*]u8, @ptrCast(ptr.?))[0..size];

            if (!created) {
                // Attach paths must agree on the segment size exactly
                // (mirrors the POSIX fstat check below).
                if (mbi.RegionSize != size) {
                    _ = UnmapViewOfFile(@as(?*const anyopaque, @ptrCast(ptr)));
                    w.CloseHandle(win_handle);
                    return error.SizeMismatch;
                }
                if (!checkHeader(mapped)) {
                    _ = UnmapViewOfFile(@as(?*const anyopaque, @ptrCast(ptr)));
                    w.CloseHandle(win_handle);
                    return error.BadVersion;
                }
                if (mode == .server) writeHeader(mapped);
            } else {
                writeHeader(mapped);
            }

            mem = mapped;
            handle = win_handle;
        } else if (builtin.os.tag == .macos) {
            // File-backed mappings: macOS shm_open deterministically
            // denies reopening existing objects (EACCES, 5/5 CI runs;
            // raw-libc controls succeed, root cause unidentified after
            // exhaustive diagnosis). Regular files share the identical
            // zero-copy mmap semantics with boring, reliable open().
            const posix = std.posix;
            var path_buf: [512]u8 = undefined;
            const path = try macosPath(name, &path_buf);

            const is_server_m = mode == .server;
            const read_only_m = mode == .read_only;

            var created_m = false;
            var file_m: std.fs.File = undefined;
            if (is_server_m) {
                file_m = std.fs.cwd().createFile(path, .{ .read = true, .truncate = false, .exclusive = false, .mode = 0o666 }) catch |err| return switch (err) {
                    error.AccessDenied => error.AccessDinied,
                    else => error.MapFailed,
                };
                const end = file_m.getEndPos() catch {
                    file_m.close();
                    return error.MapFailed;
                };
                if (end == 0) {
                    created_m = true;
                    file_m.setEndPos(size) catch {
                        file_m.close();
                        return error.MapFailed;
                    };
                } else if (end != size) {
                    file_m.close();
                    return error.SizeMismatch;
                }
            } else {
                file_m = std.fs.cwd().openFile(path, .{ .mode = if (read_only_m) .read_only else .read_write }) catch |err| return switch (err) {
                    error.FileNotFound => error.NotFound,
                    error.AccessDenied => error.AccessDinied,
                    else => error.MapFailed,
                };
                const end = file_m.getEndPos() catch {
                    file_m.close();
                    return error.MapFailed;
                };
                if (end != size) {
                    file_m.close();
                    return error.SizeMismatch;
                }
            }

            const prot_m: u32 = if (read_only_m) posix.PROT.READ else (posix.PROT.READ | posix.PROT.WRITE);
            const mapped_m = posix.mmap(
                null,
                size,
                prot_m,
                .{ .TYPE = .SHARED },
                file_m.handle,
                0,
            ) catch |err| {
                file_m.close();
                return switch (err) {
                    error.AccessDenied => error.AccessDinied,
                    error.OutOfMemory => error.OutOfMemory,
                    else => error.MapFailed,
                };
            };
            mem = mapped_m[0..size];

            if (created_m) {
                writeHeader(mem);
            } else {
                if (!checkHeader(mem)) {
                    const aligned: []align(std.heap.page_size_min) u8 = @alignCast(mem);
                    posix.munmap(aligned);
                    file_m.close();
                    return error.BadVersion;
                }
                if (is_server_m) writeHeader(mem);
            }
            handle = file_m.handle;
        } else {
            const posix = std.posix;

            var name_buf: [256]u8 = undefined;
            const posix_name = try posixName(name, &name_buf);

            const is_server = mode == .server;
            const read_only = mode == .read_only;

            // Server path: open-or-create WITHOUT O_EXCL. Background: on
            // macOS, an O_EXCL|O_CREAT that fails EEXIST deterministically
            // poisons the immediate fallback reopen with EACCES (5/5 CI
            // runs; a raw-libc control without O_EXCL always succeeds).
            // So attach first; truncate only when the object is missing
            // or empty. An empty pre-existing object means a crashed
            // creator: adopting it self-heals instead of wedging forever
            // on SizeMismatch. A double creator race is benign (identical
            // size + header bytes) and never excluded servers anyway.
            var created = false;
            var fd: posix.fd_t = undefined;
            if (is_server) {
                const c_crw: c_int = @bitCast(posix.O{ .ACCMODE = .RDWR, .CREAT = true });
                fd = try openAttach(posix_name, c_crw);
                const st = posix.fstat(fd) catch {
                    posix.close(fd);
                    return error.MapFailed;
                };
                if (st.size == 0) {
                    created = true;
                    posix.ftruncate(fd, @as(u64, @intCast(size))) catch |err| {
                        posix.close(fd);
                        return switch (err) {
                            error.AccessDenied => error.AccessDinied,
                            else => error.MapFailed,
                        };
                    };
                } else if (st.size != @as(@TypeOf(st.size), @intCast(size))) {
                    posix.close(fd);
                    return error.SizeMismatch;
                }
            } else {
                const c_flag: c_int = if (read_only)
                    @bitCast(posix.O{ .ACCMODE = .RDONLY })
                else
                    @bitCast(posix.O{ .ACCMODE = .RDWR });
                fd = try openAttach(posix_name, c_flag);
            }

            // Attach paths must agree on the segment size exactly.
            if (!created) {
                const st = posix.fstat(fd) catch {
                    posix.close(fd);
                    return error.MapFailed;
                };
                if (st.size != @as(@TypeOf(st.size), @intCast(size))) {
                    posix.close(fd);
                    return error.SizeMismatch;
                }
            }

            // Portable mmap through std.posix: shared, backed by the shm fd.
            // Read-only clients get a PROT_READ-only view. Linux-only path
            // (macOS uses file-backed mappings above).
            const prot: u32 = if (read_only) posix.PROT.READ else (posix.PROT.READ | posix.PROT.WRITE);
            const mapped = posix.mmap(
                null,
                size,
                prot,
                .{ .TYPE = .SHARED },
                fd,
                0,
            ) catch |err| {
                posix.close(fd);
                return switch (err) {
                    error.AccessDenied => error.AccessDinied,
                    error.OutOfMemory => error.OutOfMemory,
                    else => error.MapFailed,
                };
            };
            mem = mapped[0..size];

            if (created) {
                writeHeader(mem);
            } else {
                if (!checkHeader(mem)) {
                    const aligned: []align(std.heap.page_size_min) u8 = @alignCast(mem);
                    posix.munmap(aligned);
                    posix.close(fd);
                    return error.BadVersion;
                }
                // Re-stamp the identical header (no-op when verified).
                if (is_server) writeHeader(mem);
            }
            handle = fd;
        }

        return SharedArena{
            .memory = mem,
            .bump_offset = 0,
            .handle = handle,
        };
    }

    /// Removes the OS name for `name` (POSIX `shm_unlink`, macOS file
    /// delete; no-op on Windows) so a segment can be explicitly torn down,
    /// e.g. between tests. Does not unmap existing mappings; they must
    /// still be closed.
    pub fn unlink(name: []const u8) void {
        if (builtin.os.tag == .windows) return;
        if (builtin.os.tag == .macos) {
            var path_buf: [512]u8 = undefined;
            const path = macosPath(name, &path_buf) catch return;
            std.fs.deleteFileAbsolute(path) catch {};
            return;
        }
        var name_buf: [256]u8 = undefined;
        const posix_name = posixName(name, &name_buf) catch return;
        _ = std.c.shm_unlink(posix_name.ptr);
    }

    /// Unmaps the segment and closes the OS handle. Only valid for arenas
    /// created by init() (handle != null); views over foreign memory are
    /// left untouched. Never unlinks the name: the daemon owns it.
    /// Teardown goes through the injection seam (unmapSegment/closeHandle).
    pub fn close(self: *SharedArena) void {
        const h = self.handle orelse {
            self.memory = &[0]u8{};
            return;
        };
        if (self.memory.len > 0) {
            unmapSegment(self.memory);
            closeHandle(h);
        } else {
            closeHandle(h);
        }
        self.memory = &[0]u8{};
        self.bump_offset = 0;
        self.handle = null;
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
        return self.memory[offset..self.bump_offset];
    }
};

test "SharedArena bump allocator logic" {
    var buffer: [1024]u8 = undefined;
    var arena = SharedArena{
        .memory = &buffer,
        .bump_offset = 0,
        .handle = null,
    };

    const slice = try arena.alloc(128, 8);
    try std.testing.expectEqual(@as(usize, 128), slice.len);
    try std.testing.expectEqual(@as(usize, 128), arena.bump_offset);
}

test "shm server create then second server attaches with shared content" {
    const tname = "takyon_w1_attach";
    SharedArena.unlink(tname);
    defer SharedArena.unlink(tname);

    var a = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    defer a.close();
    try std.testing.expect(checkHeader(a.memory));

    a.memory[4096] = 0xAB;
    a.memory[4097] = 0xCD;

    // Second server init must attach (O_EXCL AlreadyExists fallback),
    // verify size + magic, and observe the same content.
    var b = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    defer b.close();
    try std.testing.expectEqual(@as(u8, 0xAB), b.memory[4096]);
    try std.testing.expectEqual(@as(u8, 0xCD), b.memory[4097]);
}

test "shm read_only open of missing segment fails" {
    const tname = "takyon_w1_missing_ro";
    SharedArena.unlink(tname);
    if (SharedArena.init(tname, layout.MIN_ARENA_SIZE, .read_only)) |arena| {
        var a = arena;
        a.close();
        SharedArena.unlink(tname);
        try std.testing.expect(false);
    } else |err| {
        try std.testing.expect(err == error.NotFound or err == error.MapFailed);
    }
}

test "shm read_only mapping observes server writes" {
    const tname = "takyon_w1_ro";
    SharedArena.unlink(tname);
    defer SharedArena.unlink(tname);

    var srv = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    defer srv.close();
    srv.memory[8192] = 0x5A;

    var ro = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .read_only);
    defer ro.close();
    try std.testing.expectEqual(@as(u8, 0x5A), ro.memory[8192]);
}

test "shm unlink removes segment" {
    const tname = "takyon_w1_unlink";
    SharedArena.unlink(tname);

    var srv = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    srv.close();
    SharedArena.unlink(tname);

    if (SharedArena.init(tname, layout.MIN_ARENA_SIZE, .read_only)) |arena| {
        var a = arena;
        a.close();
        SharedArena.unlink(tname);
        try std.testing.expect(false);
    } else |err| {
        try std.testing.expect(err == error.NotFound or err == error.MapFailed);
    }
}

test "shm unlink is idempotent and silent on missing names" {
    // Ownership contract: unlink never fails the caller (daemon shutdown
    // calls it unconditionally). Missing names and double unlinks are
    // silent no-ops on every platform.
    SharedArena.unlink("takyon_w1_nonexistent_xyz");
    SharedArena.unlink("takyon_w1_nonexistent_xyz");
    const tname = "takyon_w1_unlink_idem";
    SharedArena.unlink(tname);
    var srv = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    srv.close();
    SharedArena.unlink(tname);
    SharedArena.unlink(tname);
}

test "shm corrupted magic yields BadVersion" {
    const tname = "takyon_w1_badver";
    SharedArena.unlink(tname);
    defer SharedArena.unlink(tname);

    var srv = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    defer srv.close();
    // Windows named sections die with the last handle (no unlink
    // equivalent), so only POSIX proves persistence across close; on
    // Windows the creator stays mapped (attach-while-open works there).
    if (builtin.os.tag != .windows) srv.close();

    // Corrupt the 8-byte magic header through a plain RW attach.
    var rw = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .read_write);
    @memset(rw.memory[0..8], 0xFF);
    rw.close();

    try std.testing.expectError(error.BadVersion, SharedArena.init(tname, layout.MIN_ARENA_SIZE, .read_write));
    try std.testing.expectError(error.BadVersion, SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server));
}

test "shm size mismatch rejected" {
    const tname = "takyon_w1_sizemismatch";
    SharedArena.unlink(tname);
    defer SharedArena.unlink(tname);

    var srv = try SharedArena.init(tname, layout.MIN_ARENA_SIZE, .server);
    defer srv.close();
    // Same platform-lifecycle note as the BadVersion test above: only
    // POSIX proves persistence across close.
    if (builtin.os.tag != .windows) srv.close();

    const bigger = layout.MIN_ARENA_SIZE + 4096;
    try std.testing.expectError(error.SizeMismatch, SharedArena.init(tname, bigger, .server));
    try std.testing.expectError(error.SizeMismatch, SharedArena.init(tname, bigger, .read_write));
}

test "shm tiny size rejected" {
    try std.testing.expectError(error.OutOfMemory, SharedArena.init("takyon_w1_tiny", 1024, .server));
    try std.testing.expectError(error.OutOfMemory, SharedArena.init("takyon_w1_tiny", 0, .server));
    try std.testing.expectError(error.OutOfMemory, SharedArena.init("takyon_w1_tiny", layout.MIN_ARENA_SIZE - 1, .read_only));
}

test "shm teardown seam counts and injects failures" {
    const base_unmaps = unmap_calls;
    const base_closes = close_calls;
    var scratch: [64]u8 = [_]u8{0xAB} ** 64;
    // Normal path records calls without touching real mappings.
    inject_teardown_error = true;
    defer {
        inject_teardown_error = false;
    }
    unmapSegment(&scratch);
    try std.testing.expectEqual(base_unmaps + 1, unmap_calls);
    // close() on a handle-less view is a no-op (no seam calls).
    var view = SharedArena{
        .memory = scratch[0..],
        .handle = null,
        .bump_offset = 0,
    };
    view.close();
    try std.testing.expectEqual(base_unmaps + 1, unmap_calls);
    try std.testing.expectEqual(base_closes, close_calls);
    try std.testing.expectEqual(@as(usize, 0), view.memory.len);
}
