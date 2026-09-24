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

// The engine owns exactly ONE process-wide SHM mapping. Every connect with
// a matching size shares it (refcounted); the mapping is released only by
// an explicit takyon_disconnect_shm(). This is deliberate: V8 may garbage
// collect any individual ArrayBuffer at any time, so GC-driven unmapping
// would pull live memory out from under concurrent workers (use-after-
// unmap, silently failing calls, and reused address ranges aliasing as
// corrupt index nodes). The N-API finalizer is therefore a no-op.
var engine_mutex = std.Thread.Mutex{};
var engine_refs: usize = 0;

/// Initializes the TakyonDB engine context.
export fn takyon_init() callconv(.c) i32 {
    return 0;
}

export fn takyon_connect_shm(name_ptr: [*:0]const u8, size: usize) callconv(.c) ?*anyopaque {
    _ = name_ptr;
    const shm_name = if (builtin.os.tag == .windows) "Local\\TakyonDB_Master" else "/TakyonDB_Master";

    engine_mutex.lock();
    defer engine_mutex.unlock();

    if (arena_ready) {
        // Engine already mapped: share it. Sizes must agree; a second size
        // would need multi-tenant segments (future work), so fail loudly.
        if (arena.memory.len != size) return null;
        engine_refs += 1;
        ring_buffer = RingBuffer.init(arena.memory[layout.RING_OFFSET..], layout.RING_DEFAULT_CAPACITY, false) catch return null;
        art_index = art.ArtIndex.init(arena.memory, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
        return arena.memory.ptr;
    }

    // Connect to existing SHM block if server daemon is running; otherwise initialize SHM block directly (for autonomous E2E tests).
    // Track whether we created the segment so the ring header is initialized exactly once.
    var created: bool = false;
    arena = SharedArena.init(shm_name, size, .read_write) catch blk: {
        created = true;
        break :blk SharedArena.init(shm_name, size, .server) catch return null;
    };
    arena_ready = true;
    engine_refs = 1;

    if (arena.memory.len < layout.RING_OFFSET) {
        var owned = arena;
        owned.close();
        arena_ready = false;
        engine_refs = 0;
        return null;
    }
    ring_buffer = RingBuffer.init(arena.memory[layout.RING_OFFSET..], layout.RING_DEFAULT_CAPACITY, created) catch {
        var owned = arena;
        owned.close();
        arena_ready = false;
        engine_refs = 0;
        return null;
    };
    ring_ready = true;

    // Initialize ART Index (see layout.zig for the canonical offsets).
    art_index = art.ArtIndex.init(arena.memory, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);

    // Initialize Vacuum thread implicitly here? No, start it explicitly.

    return arena.memory.ptr;
}

/// Explicit full teardown of the process-wide engine mapping: unmaps the
/// segment, closes its OS handle and invalidates engine state. Safe to
/// call when disconnected (no-op). Call only when no thread will touch
/// the engine afterwards (end of process/tests).
export fn takyon_disconnect_shm() callconv(.c) void {
    engine_mutex.lock();
    defer engine_mutex.unlock();
    if (!arena_ready) return;
    engine_refs = 0;
    var owned = arena;
    owned.close();
    arena.memory = &[0]u8{};
    arena.handle = null;
    arena_ready = false;
    ring_ready = false;
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

/// Removes a key from the ART index.
/// Returns: 1 if the key was present and deleted, 0 if the key was not
/// found, -1 on error (!arena_ready, key_len 0 or >256, or remove failed).
export fn takyon_remove_index(key_ptr: [*]const u8, key_len: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    const key = key_ptr[0..key_len];
    const deleted = art_index.remove(key) catch return -1;
    return if (deleted) @as(i32, 1) else @as(i32, 0);
}

/// Collects up to `out_cap` value offsets whose keys start with `key`.
/// Returns the count written, or -1 on error (!arena_ready, bad key_len,
/// or out_cap == 0). Never writes past `out_cap` entries.
export fn takyon_scan_prefix(key_ptr: [*]const u8, key_len: u32, out_ptr: [*]u32, out_cap: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    if (out_cap == 0) return -1;
    const key = key_ptr[0..key_len];
    const out = out_ptr[0..out_cap];
    const n = art_index.scanPrefix(key, out);
    return @as(i32, @intCast(n));
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
    // size==0 is rejected: WAL uses header.length==0 as end-of-log sentinel.
    if (size == 0 or size > 48) return -1;
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
    // size==0 is rejected: WAL uses header.length==0 as end-of-log sentinel.
    if (size == 0) return -1;
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
