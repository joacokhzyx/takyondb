// ============================================================================
// File: exports.zig
// Description: C-ABI exports exposing the engine to SDKs via dynamic library.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const SharedArena = @import("../memory/shm.zig").SharedArena;
const layout = @import("../memory/layout.zig");
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;
const DeltaMessage = @import("../ipc/ring_buffer.zig").DeltaMessage;
const art = @import("../index/art.zig");

// Global statics for E2E Zero-Copy Test
var ring_buffer: RingBuffer = undefined;
var ring_ready: bool = false;
var arena: SharedArena = undefined;
var arena_ready: bool = false;
var art_index: art.ArtIndex = undefined;

// Base-address -> owned arena registry backing takyon_disconnect_shm.
// Lets the N-API finalizer (and explicit closes) unmap + close instead of
// leaking an fd/handle per connect.
var shm_mappings = std.AutoHashMap(usize, SharedArena).init(std.heap.page_allocator);
var shm_mappings_mutex = std.Thread.Mutex{};

/// Initializes the TakyonDB engine context.
export fn takyon_init() callconv(.c) i32 {
    return 0;
}

export fn takyon_connect_shm(name_ptr: [*:0]const u8, size: usize) callconv(.c) ?*anyopaque {
    _ = name_ptr;
    const shm_name = if (builtin.os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master";

    // Connect to existing SHM block if server daemon is running; otherwise initialize SHM block directly (for autonomous E2E tests).
    // Track whether we created the segment so the ring header is initialized exactly once.
    var created: bool = false;
    arena = SharedArena.init(shm_name, size, false) catch blk: {
        created = true;
        break :blk SharedArena.init(shm_name, size, true) catch return null;
    };
    arena_ready = true;

    if (arena.memory.len < layout.RING_OFFSET) return null;
    ring_buffer = RingBuffer.init(arena.memory[layout.RING_OFFSET..], layout.RING_DEFAULT_CAPACITY, created) catch {
        var owned = arena;
        owned.close();
        return null;
    };
    ring_ready = true;

    // Initialize ART Index (see layout.zig for the canonical offsets).
    art_index = art.ArtIndex.init(arena.memory, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);

    // Initialize Vacuum thread implicitly here? No, start it explicitly.

    shm_mappings_mutex.lock();
    shm_mappings.put(@intFromPtr(arena.memory.ptr), arena) catch {};
    shm_mappings_mutex.unlock();

    return arena.memory.ptr;
}

/// Unmaps a segment previously returned by takyon_connect_shm and closes
/// its OS handle. Safe to call with null or unknown pointers (no-op).
/// Called by the N-API ArrayBuffer finalizer; explicit closes welcome.
export fn takyon_disconnect_shm(base: ?*anyopaque) callconv(.c) void {
    const ptr = base orelse return;
    const addr = @intFromPtr(ptr);
    shm_mappings_mutex.lock();
    const owned = shm_mappings.fetchRemove(addr);
    shm_mappings_mutex.unlock();
    if (owned) |kv| {
        var mapping = kv.value;
        mapping.close();
        if (@intFromPtr(arena.memory.ptr) == addr) {
            arena.memory = &[0]u8{};
            arena.handle = null;
            arena_ready = false;
            ring_ready = false;
        }
    }
}

export fn takyon_insert_index(key_ptr: [*]const u8, key_len: u32, value_offset: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    if (value_offset >= arena.memory.len) return -1;
    const key = key_ptr[0..key_len];
    art_index.insert(key, value_offset) catch return -1;
    return 0;
}

export fn takyon_search_index(key_ptr: [*]const u8, key_len: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    const key = key_ptr[0..key_len];
    if (art_index.search(key)) |value_offset| {
        // -1 is reserved for "not found"; refuse offsets that alias it.
        if (value_offset >= 0x7FFFFFFF) return -1;
        return @as(i32, @intCast(value_offset));
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
    if (!ring_ready or !arena_ready) return -1;
    // Delta payload is a fixed 48B inline buffer. Anything larger belongs in
    // the string arena and must go through takyon_notify_arena.
    if (size > 48) return -1;
    if (@as(usize, offset) + @as(usize, size) > arena.memory.len) return -1;

    var delta = DeltaMessage{
        .offset = offset,
        .size = size,
        .is_arena = 0,
        .data = undefined,
    };

    // Copy the mutated bytes from the N-API buffer into the delta payload
    std.mem.copyForwards(u8, delta.data[0..size], data_ptr[0..size]);

    // Push the mutation into the RingBuffer
    const pushed = ring_buffer.push(delta);

    if (pushed) {
        return 0; // Success
    }
    return -1; // Buffer full
}

export fn takyon_notify_arena(offset: u32, size: u32) callconv(.c) i32 {
    if (!ring_ready or !arena_ready) return -1;
    if (@as(usize, offset) + @as(usize, size) > arena.memory.len) return -1;

    const delta = DeltaMessage{
        .offset = offset,
        .size = size,
        .is_arena = 1,
        .data = undefined,
    };

    const pushed = ring_buffer.push(delta);

    if (pushed) {
        return 0; // Success
    }
    return -1; // Buffer full
}

export fn takyon_trigger_checkpoint() callconv(.c) i32 {
    if (!ring_ready) return -1;
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
    if (!ring_ready) return -2;
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
    if (!arena_ready) return -1;
    if (@as(usize, string_field_offset) >= arena.memory.len) return -1;
    vacuum.spawnVacuum(&arena, &art_index, string_field_offset) catch return -1;
    return 0;
}

export fn takyon_stop_vacuum() callconv(.c) void {
    vacuum.stopVacuum();
}
