// ============================================================================
// File: main.zig
// Description: TakyonDB Standalone Daemon (Server) Entrypoint.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

const std = @import("std");
const core = @import("core");
const SharedArena = core.shm.SharedArena;
const RingBuffer = core.ring_buffer.RingBuffer;
const WalManager = core.wal.WalManager;

var server_running: std.atomic.Value(bool) = std.atomic.Value(bool).init(true);
var global_wal: ?*WalManager = null;

fn handleSigInt(sig: c_int) callconv(.C) void {
    _ = sig;
    std.debug.print("\n[TakyonDB-Daemon] Señal SIGINT recibida. Apagando servidor...\n", .{});
    server_running.store(false, .release);
}

pub fn main() !void {
    std.debug.print("[TakyonDB-Daemon] Iniciando TakyonDB Standalone Server...\n", .{});
    
    // Register SIGINT handler (stub for Windows - Windows needs SetConsoleCtrlHandler usually)
    const builtin = @import("builtin");
    if (builtin.os.tag == .windows) {
        // Simple Windows Ctrl+C handler
        _ = std.os.windows.kernel32.SetConsoleCtrlHandler(windowsCtrlCHandler, std.os.windows.TRUE);
    } else {
        std.posix.sigaction(std.posix.SIG.INT, &std.posix.Sigaction{
            .handler = .{ .handler = handleSigInt },
            .mask = std.posix.empty_sigset,
            .flags = 0,
        }, null);
    }

    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // 1. Create Named Shared Memory Block
    // In cross-platform mode we use Local\TakyonDB_Master on Windows and /dev/shm on POSIX
    const shm_name = if (builtin.os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master";
    
    std.debug.print("[TakyonDB-Daemon] Solicitando bloque de memoria compartida: {s}\n", .{shm_name});
    var arena = try SharedArena.init(shm_name, 64 * 1024 * 1024, true);
    
    // 2. Bootloader: Recover from disk
    const recoverWal = core.recovery.recoverWal;
    try recoverWal(allocator, "data.takyon", arena.memory);
    
    // 3. Initialize Lock-Free RingBuffer inside the shared memory block
    // We reserve the first 1024 bytes for future metadata/headers.
    var rb = try RingBuffer.init(arena.memory[1024..], 16, true);
    std.debug.print("[TakyonDB-Daemon] RingBuffer inicializado in cabecera de memoria.\n", .{});
    
    // 4. Start WAL Flusher
    var wal = try WalManager.init(allocator, "data.takyon");
    global_wal = &wal;
    try wal.spawnWalFlusher(&rb, arena.memory);
    std.debug.print("[TakyonDB-Daemon] WAL Flusher corriindo y anclado al bloque.\n", .{});
    
    std.debug.print("[TakyonDB-Daemon] Servidor listo. Waiting for connections...\n", .{});

    // 4. Spin wait / Evint loop until termination
    while (server_running.load(.acquire)) {
        std.Thread.yield() catch {};
    }
    
    // 5. Graceful shutdown
    std.debug.print("[TakyonDB-Daemon] Apagando WAL Flusher y volcando deltas residuales...\n", .{});
    wal.shutdown();
    std.debug.print("[TakyonDB-Daemon] TakyonDB detinido exitosaminte.\n", .{});
}

fn windowsCtrlCHandler(fdwCtrlType: std.os.windows.DWORD) callconv(std.builtin.CallingConvention.winapi) std.os.windows.BOOL {
    _ = fdwCtrlType;
    std.debug.print("\n[TakyonDB-Daemon] Señal CTRL+C recibida. Apagando servidor...\n", .{});
    server_running.store(false, .release);
    return std.os.windows.TRUE;
}
