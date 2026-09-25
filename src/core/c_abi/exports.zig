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
const column = @import("../relational/column.zig");
const rfilter = @import("../relational/filter.zig");
const rcrc = @import("../memory/record_crc.zig");
const scrub = @import("../memory/scrub.zig");

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
pub export fn takyon_init() callconv(.c) i32 {
    return 0;
}

/// Default segment basename (namespaced per-OS below). Custom names arrive
/// via `name_ptr` ("shm://local" from the current bridge means default).
pub const DEFAULT_SHM_BASENAME = "TakyonDB_Master";

/// Resolves a caller segment name to its OS form. Empty, null, or the
/// legacy `"shm://local"` sentinel mean the default segment.Basename rules:
/// 1..64 chars of `[A-Za-z0-9._-]`; POSIX gets a leading `/`, Windows a
/// `Local\` prefix. Full name-keyed multi-tenancy (one mapping per name)
/// is future; the engine still owns a single mapping and rejects a second
/// name while attached.
pub fn resolveShmName(name_ptr: ?[*:0]const u8, out: *[128]u8) ![]u8 {
    const raw = if (name_ptr) |p| std.mem.span(p) else "";
    const base = if (raw.len == 0 or std.mem.eql(u8, raw, "shm://local")) DEFAULT_SHM_BASENAME else raw;
    if (base.len == 0 or base.len > 64) return error.InvalidSchema;
    for (base) |b| {
        const ok = (b >= 'a' and b <= 'z') or (b >= 'A' and b <= 'Z') or (b >= '0' and b <= '9') or b == '.' or b == '_' or b == '-';
        if (!ok) return error.InvalidSchema;
    }
    if (builtin.os.tag == .windows) {
        const prefix = "Local\\";
        const total = prefix.len + base.len;
        if (total > out.len) return error.NoSpace;
        @memcpy(out[0..prefix.len], prefix);
        @memcpy(out[prefix.len..][0..base.len], base);
        return out[0..total];
    }
    if (1 + base.len > out.len) return error.NoSpace;
    out[0] = '/';
    @memcpy(out[1..][0..base.len], base);
    return out[0 .. 1 + base.len];
}

var engine_name_buf: [128]u8 = [_]u8{0} ** 128;
var engine_name_len: usize = 0;

pub export fn takyon_connect_shm(name_ptr: [*:0]const u8, size: usize) callconv(.c) ?*anyopaque {
    var name_buf: [128]u8 = undefined;
    const shm_name = resolveShmName(name_ptr, &name_buf) catch return null;

    engine_mutex.lock();
    defer engine_mutex.unlock();

    if (arena_ready) {
        // Engine already mapped: share it. Sizes and names must agree; a
        // second segment needs name-keyed multi-tenant mappings (future),
        // so fail loudly.
        if (arena.memory.len != size) return null;
        if (engine_name_len != shm_name.len or !std.mem.eql(u8, engine_name_buf[0..engine_name_len], shm_name)) return null;
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
    @memcpy(engine_name_buf[0..shm_name.len], shm_name);
    engine_name_len = shm_name.len;

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
pub export fn takyon_disconnect_shm() callconv(.c) void {
    engine_mutex.lock();
    defer engine_mutex.unlock();
    if (!arena_ready) return;
    engine_refs = 0;
    engine_name_len = 0;
    var owned = arena;
    owned.close();
    arena.memory = &[0]u8{};
    arena.handle = null;
    arena_ready = false;
    ring_ready = false;
}

pub export fn takyon_insert_index(key_ptr: [*]const u8, key_len: u32, value_offset: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    if (value_offset >= arena.memory.len) return -1;
    const key = key_ptr[0..key_len];
    art_index.insert(key, value_offset) catch return -1;
    return 0;
}

pub export fn takyon_search_index(key_ptr: [*]const u8, key_len: u32) callconv(.c) i32 {
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
pub export fn takyon_remove_index(key_ptr: [*]const u8, key_len: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    const key = key_ptr[0..key_len];
    const deleted = art_index.remove(key) catch return -1;
    return if (deleted) @as(i32, 1) else @as(i32, 0);
}

/// Collects up to `out_cap` value offsets whose keys start with `key`.
/// Returns the count written, or -1 on error (!arena_ready, bad key_len,
/// or out_cap == 0). Never writes past `out_cap` entries.
pub export fn takyon_scan_prefix(key_ptr: [*]const u8, key_len: u32, out_ptr: [*]u32, out_cap: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    if (out_cap == 0) return -1;
    const key = key_ptr[0..key_len];
    const out = out_ptr[0..out_cap];
    const n = art_index.scanPrefix(key, out);
    return @as(i32, @intCast(n));
}

/// Like takyon_scan_prefix but only keys whose suffix after `key` lies
/// within [`lo`, `hi`] (lexicographic). Empty `lo`/`hi` (len 0, pointer
/// may be null) means unbounded on that side. Returns the count written,
/// or -1 on error (!arena_ready, bad lengths, `lo > hi`, out_cap == 0).
pub export fn takyon_scan_range(key_ptr: [*]const u8, key_len: u32, lo_ptr: ?[*]const u8, lo_len: u32, hi_ptr: ?[*]const u8, hi_len: u32, out_ptr: [*]u32, out_cap: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (key_len == 0 or key_len > 256) return -1;
    if (lo_len > 256 or hi_len > 256) return -1;
    if (out_cap == 0) return -1;
    const key = key_ptr[0..key_len];
    const lo: []const u8 = if (lo_len == 0) &[_]u8{} else (lo_ptr orelse return -1)[0..lo_len];
    const hi: []const u8 = if (hi_len == 0) &[_]u8{} else (hi_ptr orelse return -1)[0..hi_len];
    const out = out_ptr[0..out_cap];
    const n = art_index.scanRange(key, lo, hi, out);
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
pub export fn takyon_write_delta(offset: u32, size: u32, data_ptr: [*]const u8) callconv(.c) i32 {
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

pub export fn takyon_notify_arena(offset: u32, size: u32) callconv(.c) i32 {
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

pub export fn takyon_trigger_checkpoint() callconv(.c) i32 {
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
pub export fn takyon_verify_test_value() callconv(.c) i32 {
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

/// Pushdown kernel: filter u32 column with SIMD (`column.filterU32`).
/// `op` is `rfilter.CmpOp` as u8 (0=Eq..5=Lte). Returns count written or -1 on error.
pub export fn takyon_filter_u32(values_ptr: ?[*]const u32, len: u32, op: u8, target: u32, out_ptr: ?[*]u32, out_cap: u32) callconv(.c) i32 {
    if (op > 5) return -1;
    if (len == 0) return 0;
    if (out_cap == 0) return -1;
    const values = (values_ptr orelse return -1)[0..len];
    const out = (out_ptr orelse return -1)[0..out_cap];
    const cmp: rfilter.CmpOp = @enumFromInt(op);
    const n = column.filterU32(values, cmp, target, out);
    return @as(i32, @intCast(n));
}

/// Pushdown kernel: filter f64 column (`column.filterF64`). Same contract as u32.
pub export fn takyon_filter_f64(values_ptr: ?[*]const f64, len: u32, op: u8, target: f64, out_ptr: ?[*]u32, out_cap: u32) callconv(.c) i32 {
    if (op > 5) return -1;
    if (len == 0) return 0;
    if (out_cap == 0) return -1;
    const values = (values_ptr orelse return -1)[0..len];
    const out = (out_ptr orelse return -1)[0..out_cap];
    const cmp: rfilter.CmpOp = @enumFromInt(op);
    const n = column.filterF64(values, cmp, target, out);
    return @as(i32, @intCast(n));
}

/// Pushdown kernel: Kahan sum over f64 column. Returns 0 on empty; NaN on bad pointer.
pub export fn takyon_agg_sum_f64(values_ptr: ?[*]const f64, len: u32) callconv(.c) f64 {
    if (len == 0) return 0;
    const values = (values_ptr orelse return std.math.nan(f64))[0..len];
    return column.kahanSum(values);
}

/// Pushdown kernel: Kahan sum over a selection vector. OOB entries stop the scan.
pub export fn takyon_agg_sum_selected(values_ptr: ?[*]const f64, values_len: u32, sel_ptr: ?[*]const u32, sel_len: u32) callconv(.c) f64 {
    if (sel_len == 0) return 0;
    const values = if (values_len == 0) &[_]f64{} else (values_ptr orelse return std.math.nan(f64))[0..values_len];
    const sel = (sel_ptr orelse return std.math.nan(f64))[0..sel_len];
    return column.kahanSumSelected(values, sel, sel_len);
}

/// Pushdown kernel: min over a selection vector (0 when empty, mirrors TS).
pub export fn takyon_agg_min_selected(values_ptr: ?[*]const f64, values_len: u32, sel_ptr: ?[*]const u32, sel_len: u32) callconv(.c) f64 {
    if (sel_len == 0) return 0;
    const values = if (values_len == 0) &[_]f64{} else (values_ptr orelse return std.math.nan(f64))[0..values_len];
    const sel = (sel_ptr orelse return std.math.nan(f64))[0..sel_len];
    return column.minSelected(values, sel, sel_len);
}

/// Pushdown kernel: max over a selection vector (0 when empty, mirrors TS).
pub export fn takyon_agg_max_selected(values_ptr: ?[*]const f64, values_len: u32, sel_ptr: ?[*]const u32, sel_len: u32) callconv(.c) f64 {
    if (sel_len == 0) return 0;
    const values = if (values_len == 0) &[_]f64{} else (values_ptr orelse return std.math.nan(f64))[0..values_len];
    const sel = (sel_ptr orelse return std.math.nan(f64))[0..sel_len];
    return column.maxSelected(values, sel, sel_len);
}

/// Scrubber: verifies one sealed KV envelope.
/// Returns 1 when valid, 0 when corrupt, -1 on bad args (null/empty).
pub export fn takyon_verify_record(buf_ptr: ?[*]const u8, len: u32) callconv(.c) i32 {
    if (len == 0) return -1;
    const buf = (buf_ptr orelse return -1)[0..len];
    return if (rcrc.verify(buf)) @as(i32, 1) else @as(i32, 0);
}

/// Scrubber: walks concatenated sealed envelopes in a caller buffer.
/// Writes ok/corrupt/bytes/truncated counts; returns 0 or -1 on bad args.
pub export fn takyon_scrub_records(buf_ptr: ?[*]const u8, len: u32, ok_out: ?*u32, corrupt_out: ?*u32, bytes_out: ?*u32, truncated_out: ?*u32) callconv(.c) i32 {
    const ok_p = ok_out orelse return -1;
    const corrupt_p = corrupt_out orelse return -1;
    const bytes_p = bytes_out orelse return -1;
    const trunc_p = truncated_out orelse return -1;
    if (len == 0) return -1;
    const buf = (buf_ptr orelse return -1)[0..len];
    const rep = scrub.scrub(buf);
    ok_p.* = @intCast(rep.ok);
    corrupt_p.* = @intCast(rep.corrupt);
    bytes_p.* = @intCast(rep.bytes);
    trunc_p.* = if (rep.truncated) @as(u32, 1) else @as(u32, 0);
    return 0;
}

pub export fn takyon_start_vacuum(string_field_offset: u32) callconv(.c) i32 {
    if (!arena_ready) return -1;
    if (@as(usize, string_field_offset) >= arena.memory.len) return -1;
    vacuum.spawnVacuum(&arena, &art_index, string_field_offset) catch return -1;
    return 0;
}

pub export fn takyon_stop_vacuum() callconv(.c) void {
    vacuum.stopVacuum();
}
