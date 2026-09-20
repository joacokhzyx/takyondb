// ============================================================================
// File: main.zig
// Description: TakyonDB Standalone Daemon (Server) Entrypoint.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const core = @import("core");
const SharedArena = core.shm.SharedArena;
const layout = core.layout;
const RingBuffer = core.ring_buffer.RingBuffer;
const DeltaMessage = core.ring_buffer.DeltaMessage;
const WalManager = core.wal.WalManager;

var server_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(true);
var global_wal: ?*WalManager = null;

fn handleSigInt(sig: c_int) callconv(.c) void {
    _ = sig;
    std.debug.print("\n[TakyonDB-Daemon] SIGINT signal received. Shutting down server...\n", .{});
    server_running.store(false, .release);
}

fn initArenaCompat(name: []const u8, size: usize) !SharedArena {
    return try SharedArena.init(name, size, .server);
}

pub fn main() !void {
    std.debug.print("[TakyonDB-Daemon] Starting TakyonDB Standalone Server...\n", .{});

    // Register SIGINT handler (stub for Windows - Windows needs SetConsoleCtrlHandler usually)
    const builtin = @import("builtin");
    if (builtin.os.tag == .windows) {
        // Simple Windows Ctrl+C handler
        _ = std.os.windows.kernel32.SetConsoleCtrlHandler(windowsCtrlCHandler, std.os.windows.TRUE);
    } else {
        std.posix.sigaction(std.posix.SIG.INT, &std.posix.Sigaction{
            .handler = .{ .handler = @ptrCast(&handleSigInt) },
            .mask = std.mem.zeroes(std.posix.sigset_t),
            .flags = 0,
        }, null);
    }

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Read memory size from CLI arguments (Default 64MB).
    // Back-compat: the first positional arg stays mem_size bytes.
    // --data-dir <dir> may appear anywhere in args; default ".".
    var mem_size: usize = 64 * 1024 * 1024;
    var data_dir: []const u8 = ".";
    var checkpoint_sec: usize = 60;
    var args = try std.process.argsWithAllocator(allocator);
    defer args.deinit();
    _ = args.skip(); // skip executable name
    var is_first = true;
    while (args.next()) |arg| {
        if (std.mem.eql(u8, arg, "--data-dir")) {
            if (args.next()) |dir| {
                data_dir = dir;
            } else {
                std.debug.print("[TakyonDB-Daemon] ERROR: --data-dir requires a directory argument\n", .{});
                std.process.exit(1);
            }
        } else if (std.mem.startsWith(u8, arg, "--data-dir=")) {
            data_dir = arg["--data-dir=".len..];
            if (data_dir.len == 0) {
                std.debug.print("[TakyonDB-Daemon] ERROR: --data-dir requires a non-empty directory argument\n", .{});
                std.process.exit(1);
            }
        } else if (std.mem.eql(u8, arg, "--checkpoint-sec")) {
            if (args.next()) |val| {
                checkpoint_sec = std.fmt.parseInt(usize, val, 10) catch {
                    std.debug.print("[TakyonDB-Daemon] ERROR: --checkpoint-sec requires a numeric argument\n", .{});
                    std.process.exit(1);
                };
            } else {
                std.debug.print("[TakyonDB-Daemon] ERROR: --checkpoint-sec requires a numeric argument\n", .{});
                std.process.exit(1);
            }
        } else if (std.mem.startsWith(u8, arg, "--checkpoint-sec=")) {
            const val = arg["--checkpoint-sec=".len..];
            if (val.len == 0) {
                std.debug.print("[TakyonDB-Daemon] ERROR: --checkpoint-sec requires a numeric argument\n", .{});
                std.process.exit(1);
            }
            checkpoint_sec = std.fmt.parseInt(usize, val, 10) catch {
                std.debug.print("[TakyonDB-Daemon] ERROR: --checkpoint-sec requires a numeric argument\n", .{});
                std.process.exit(1);
            };
        } else if (is_first and arg.len > 0 and arg[0] != '-') {
            if (std.fmt.parseInt(usize, arg, 10)) |parsed_size| {
                mem_size = parsed_size;
                std.debug.print("[TakyonDB-Daemon] Dynamic Memory Limit set to: {d} bytes\n", .{mem_size});
            } else |_| {
                std.debug.print("[TakyonDB-Daemon] Invalid memory size provided, defaulting to 64MB\n", .{});
            }
        }
        is_first = false;
    }

    if (mem_size < layout.MIN_ARENA_SIZE) {
        std.debug.print("[TakyonDB-Daemon] ERROR: memory size {d} bytes is below minimum {d} bytes (MIN_ARENA_SIZE); increase the first argument.\n", .{ mem_size, layout.MIN_ARENA_SIZE });
        std.process.exit(1);
    }

    // Build wal/snap paths by joining <data-dir> + "data.takyon".
    // WalManager owns a dupeZ copy; snapshot/recovery derive "<wal>.snap".
    var wal_path_buf: [4096]u8 = undefined;
    const wal_path: [:0]const u8 = blk: {
        if (std.mem.eql(u8, data_dir, ".")) {
            break :blk try std.fmt.bufPrintZ(&wal_path_buf, "data.takyon", .{});
        } else {
            const stripped = if (data_dir.len > 0 and data_dir[data_dir.len - 1] == '/')
                data_dir[0 .. data_dir.len - 1]
            else
                data_dir;
            break :blk try std.fmt.bufPrintZ(&wal_path_buf, "{s}/data.takyon", .{stripped});
        }
    };
    std.debug.print("[TakyonDB-Daemon] Data directory: {s} (WAL: {s})\n", .{ data_dir, wal_path });

    // 1. Create Named Shared Memory Block
    // In cross-platform mode we use Local\TakyonDB_Master on Windows and /dev/shm on POSIX
    const shm_name = if (builtin.os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master";

    std.debug.print("[TakyonDB-Daemon] Requesting shared memory block: {s}\n", .{shm_name});
    var arena = try initArenaCompat(shm_name, mem_size);

    // 2. Bootloader: Recover from disk
    const recoverWal = core.recovery.recoverWal;
    try recoverWal(allocator, wal_path, arena.memory);

    // 3. Initialize Lock-Free RingBuffer inside the shared memory block
    // We reserve the first 1024 bytes for future metadata/headers.
    var rb = try RingBuffer.init(arena.memory[layout.RING_OFFSET..], layout.RING_DEFAULT_CAPACITY, true);
    std.debug.print("[TakyonDB-Daemon] RingBuffer initialized in memory header.\n", .{});

    // 4. Start WAL Flusher
    var wal = try WalManager.init(allocator, wal_path);
    global_wal = &wal;
    try wal.spawnWalFlusher(&rb, arena.memory);
    std.debug.print("[TakyonDB-Daemon] WAL Flusher running and anchored to block.\n", .{});

    std.debug.print("[TakyonDB-Daemon] Server ready. Waiting for connections...\n", .{});

    // 4. Spin wait / Evint loop until termination.
    // Every 10s log ring depth; every checkpoint_sec push an is_arena==2
    // checkpoint delta (flusher owns snapshotting). 0 disables checkpoints.
    var last_metrics = std.time.milliTimestamp();
    var last_checkpoint = std.time.milliTimestamp();
    while (server_running.load(.acquire)) {
        const now = std.time.milliTimestamp();
        if (now - last_metrics >= 10_000) {
            last_metrics = now;
            std.debug.print("[TakyonDB-Daemon] Ring depth: {d}\n", .{rb.depth()});
        }
        if (checkpoint_sec != 0 and now - last_checkpoint >= @as(i64, @intCast(checkpoint_sec * 1000))) {
            last_checkpoint = now;
            const ckpt = DeltaMessage{ .offset = 0, .size = 0, .is_arena = 2, .data = [_]u8{0} ** 48 };
            if (rb.push(ckpt)) {
                std.debug.print("[TakyonDB-Daemon] Checkpoint triggered.\n", .{});
            } else {
                std.debug.print("[TakyonDB-Daemon] Checkpoint skipped (ring full).\n", .{});
            }
        }
        std.Thread.yield() catch {};
    }

    // 5. Graceful shutdown
    std.debug.print("[TakyonDB-Daemon] Shutting down WAL Flusher and flushing residual deltas...\n", .{});
    wal.shutdown();
    std.debug.print("[TakyonDB-Daemon] TakyonDB stopped successfully.\n", .{});
}

fn windowsCtrlCHandler(fdwCtrlType: std.os.windows.DWORD) callconv(std.builtin.CallingConvention.winapi) std.os.windows.BOOL {
    _ = fdwCtrlType;
    std.debug.print("\n[TakyonDB-Daemon] Señal CTRL+C recibida. Apagando servidor...\n", .{});
    server_running.store(false, .release);
    return std.os.windows.TRUE;
}
