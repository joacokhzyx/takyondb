// TEMPORARY CI diagnostic (remove once the macOS shm_open EACCES puzzle
// is solved): replicates SharedArena.init's open sequence with raw errno
// prints, to tell "OS denies reopen" apart from "Zig flag/errno bug".
// Run on macOS with: zig run -lc scripts/ci-probe-zig-shm.zig
const std = @import("std");

// Same libc symbol, but with a 32-bit mode like a C compiler would pass.
extern "c" fn my_shm_open(name: [*:0]const u8, flag: c_int, mode: c_uint) c_int;

pub fn main() !void {
    const posix = std.posix;
    const excl: c_int = @bitCast(posix.O{ .ACCMODE = .RDWR, .CREAT = true, .EXCL = true });
    const rw: c_int = @bitCast(posix.O{ .ACCMODE = .RDWR });
    const ro: c_int = @bitCast(posix.O{ .ACCMODE = .RDONLY });
    std.debug.print("zig-flags excl={d} rw={d} ro={d} (darwin truth: 2562 2 0)\n", .{ excl, rw, ro });
    std.debug.print("stale-errno={d}\n", .{std.c._errno().*});

    const name: [*:0]const u8 = "/takyon_zigprobe";
    _ = std.c.shm_unlink(name);

    const e1 = std.c.shm_open(name, excl, @as(std.c.mode_t, 0o666));
    std.debug.print("create fd={d} errno={d}\n", .{ e1, std.c._errno().* });
    if (e1 >= 0) std.posix.close(e1);

    const e2 = std.c.shm_open(name, excl, @as(std.c.mode_t, 0o666));
    std.debug.print("recreate fd={d} errno={d} (want EXIST={d})\n", .{ e2, std.c._errno().*, @as(c_int, @intFromEnum(posix.E.EXIST)) });
    if (e2 >= 0) std.posix.close(e2);

    const e3 = std.c.shm_open(name, rw, @as(std.c.mode_t, 0o666));
    std.debug.print("reopen-rw fd={d} errno={d}\n", .{ e3, std.c._errno().* });
    if (e3 >= 0) std.posix.close(e3);

    const e4 = std.c.shm_open(name, ro, @as(std.c.mode_t, 0o666));
    std.debug.print("reopen-ro fd={d} errno={d}\n", .{ e4, std.c._errno().* });
    if (e4 >= 0) std.posix.close(e4);

    _ = std.c.shm_unlink(name);

    // Discriminant: identical call through a c_uint-mode extern.
    const mname: [*:0]const u8 = "/takyon_myprobe";
    _ = std.c.shm_unlink(mname);
    const m1 = my_shm_open(mname, rw, 0o666);
    std.debug.print("my-create fd={d} errno={d}\n", .{ m1, std.c._errno().* });
    if (m1 >= 0) std.posix.close(m1);
    const m2 = my_shm_open(mname, rw, 0o666);
    std.debug.print("my-reopen fd={d} errno={d}\n", .{ m2, std.c._errno().* });
    if (m2 >= 0) std.posix.close(m2);
    _ = std.c.shm_unlink(mname);
}
