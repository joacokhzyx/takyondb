// ============================================================================
// File: exports.zig
// Description: C-ABI exports exposing the ingine to SDKs via dynamic library.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const SharedArena = @import("../memory/shm.zig").SharedArena;
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;
const DeltaMessage = @import("../ipc/ring_buffer.zig").DeltaMessage;
const art = @import("../index/art.zig");

// Global statics for E2E Zero-Copy Test
var global_mem: [4096]u8 = undefined;
var ring_buffer: RingBuffer = undefined;
var arena: SharedArena = undefined;
var art_index: art.ArtIndex = undefined;

/// Initializes the TakyonDB ingine context.
export fn takyon_init() callconv(.c) i32 {
    return 0;
}

export fn takyon_connect_shm(name_ptr: [*:0]const u8, size: usize) callconv(.c) ?*anyopaque {
    _ = name_ptr;
    const shm_name = if (builtin.os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master";
    
    // Connect to existing SHM block if server daemon is running; otherwise initialize SHM block directly (for autonomous E2E tests).
    arena = SharedArena.init(shm_name, size, false) catch
        SharedArena.init(shm_name, size, true) catch return null;
    
    ring_buffer = RingBuffer.init(arena.memory[1024..], 16, false) catch return null;
    
    // Initialize ART Index (root at offset 64, bump allocator at offset 8192, nodes start at 8200)
    art_index = art.ArtIndex.init(arena.memory, 2097152, 2097156, 2097160);
    
    // Initialize Vacuum thread implicitly here? No, start it explicitly.
    
    return arena.memory.ptr;
}

export fn takyon_insert_index(key_ptr: [*]const u8, key_len: u32, value_offset: u32) callconv(.c) i32 {
    const key = key_ptr[0..key_len];
    art_index.insert(key, value_offset) catch return -1;
    return 0;
}

export fn takyon_search_index(key_ptr: [*]const u8, key_len: u32) callconv(.c) i32 {
    const key = key_ptr[0..key_len];
    if (art_index.search(key)) |value_offset| {
        return @as(i32, @bitCast(value_offset)); // Assumes value_offset <= i32.MAX for simplicity, or we can use i64 if needed
    }
    return -1; // Not found
}

pub inline fn rdtsc() u64 {
    if (builtin.cpu.arch == .x86_64 or builtin.cpu.arch == .x86) {
        var low: u32 = undefined;
        var high: u32 = undefined;
        asm volatile ("rdtsc"
            : [low] "={eax}" (low),
              [high] "={edx}" (high),
        );
        return (@as(u64, high) << 32) | low;
    } else if (builtin.cpu.arch == .aarch64) {
        var val: u64 = undefined;
        asm volatile ("mrs %[v], cntvct_el0"
            : [v] "=r" (val),
        );
        return val;
    } else {
        return 0;
    }
}

/// Dispatches a raw mutation delta directly into the C-ABI.
export fn takyon_write_delta(offset: u32, size: u32, data_ptr: [*]const u8) callconv(.c) i32 {
    const t0 = rdtsc();

    var delta = DeltaMessage{
        .offset = offset,
        .size = size,
        .is_arena = 0,
        .data = undefined,
    };
    
    // Copy the mutated bytes from the N-API buffer into the delta payload
    std.mem.copyForwards(u8, &delta.data, data_ptr[0..size]);
    
    // Push the mutation into the RingBuffer
    const pushed = ring_buffer.push(delta);
    
    const t1 = rdtsc();

    if (pushed) {
        std.debug.print("[TakyonDB-Core] Delta ({} bytes) written to RingBuffer. RDTSC Latency: {} CPU cycles.\n", .{ size, t1 - t0 });
        return 0; // Success
    }
    return -1; // Buffer full
}

export fn takyon_notify_arena(offset: u32, size: u32) callconv(.c) i32 {
    const t0 = rdtsc();

    const delta = DeltaMessage{
        .offset = offset,
        .size = size,
        .is_arena = 1,
        .data = undefined,
    };
    
    const pushed = ring_buffer.push(delta);
    const t1 = rdtsc();

    if (pushed) {
        std.debug.print("[TakyonDB-Core] Arena Delta ({} bytes) in RingBuffer. RDTSC Latency: {} CPU cycles.\n", .{ size, t1 - t0 });
        return 0; // Success
    }
    return -1; // Buffer full
}

export fn takyon_trigger_checkpoint() callconv(.c) i32 {
    const delta = DeltaMessage{
        .offset = 0,
        .size = 0,
        .is_arena = 2,
        .data = undefined,
    };
    
    if (ring_buffer.push(delta)) {
        return 0; // Success
    }
    return -1; // Buffer full
}

/// E2E Verification function: Pops the RingBuffer and returns the processed value as i32
export fn takyon_verify_test_value() callconv(.c) i32 {
    if (ring_buffer.pop()) |delta| {
        if (delta.size == 4) {
            var val: i32 = undefined;
            std.mem.copyForwards(u8, std.mem.asBytes(&val), delta.data[0..4]);
            return val;
        }
        return 1; // Wrong size
    }
    return -2; // Ring buffer was empty
}

const vacuum = @import("../memory/vacuum.zig");

export fn takyon_start_vacuum(string_field_offset: u32) callconv(.c) i32 {
    vacuum.spawnVacuum(&arena, &art_index, string_field_offset) catch return -1;
    return 0;
}
