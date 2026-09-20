// ============================================================================
// File: vacuum.zig
// Description: String-arena garbage collector (double-buffer compaction).
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const SharedArena = @import("../memory/shm.zig").SharedArena;
const layout = @import("../memory/layout.zig");
const art = @import("../index/art.zig");
const ArtPtr = art.ArtPtr;
const Leaf = art.Leaf;

pub const VacuumError = error{
    ArenaTooSmall,
    AlreadyRunning,
    OutOfMemory,
};

var running = std.atomic.Value(bool).init(false);
var vacuum_thread: ?std.Thread = null;
var vacuum_mutex = std.Thread.Mutex{};
var vacuum_offsets: ?[]u32 = null;

/// Starts the background vacuum thread. Returns AlreadyRunning if one is
/// active. Stop it with stopVacuum() (joins the thread; no more detached
/// infinite threads).
pub fn spawnVacuumMulti(arena: *SharedArena, art_index: *art.ArtIndex, offsets: []const u32) !void {
    vacuum_mutex.lock();
    defer vacuum_mutex.unlock();
    if (running.load(.acquire)) return error.AlreadyRunning;
    const allocator = std.heap.page_allocator;
    const dup = allocator.dupe(u32, offsets) catch return error.OutOfMemory;
    vacuum_offsets = dup;
    running.store(true, .release);
    vacuum_thread = std.Thread.spawn(.{}, vacuumLoopMulti, .{ arena, art_index, @as([]const u32, dup) }) catch |err| {
        allocator.free(dup);
        vacuum_offsets = null;
        running.store(false, .release);
        vacuum_thread = null;
        return err;
    };
}

pub fn spawnVacuum(arena: *SharedArena, art_index: *art.ArtIndex, string_field_offset: u32) !void {
    var tmp = [_]u32{string_field_offset};
    return spawnVacuumMulti(arena, art_index, tmp[0..]);
}

pub fn stopVacuum() void {
    vacuum_mutex.lock();
    const th = vacuum_thread;
    vacuum_thread = null;
    const offs = vacuum_offsets;
    vacuum_offsets = null;
    vacuum_mutex.unlock();
    running.store(false, .release);
    if (th) |t| t.join();
    if (offs) |o| {
        std.heap.page_allocator.free(o);
    }
}

fn vacuumLoop(arena: *SharedArena, index: *art.ArtIndex, string_field_offset: u32) void {
    var tmp = [_]u32{string_field_offset};
    vacuumLoopMulti(arena, index, tmp[0..]);
}

fn vacuumLoopMulti(arena: *SharedArena, index: *art.ArtIndex, offsets: []const u32) void {
    while (running.load(.acquire)) {
        runVacuumOnceMulti(arena, index, offsets) catch {};
        // Back off: compaction is periodic maintenance, not a hot loop.
        std.Thread.sleep(100 * std.time.ns_per_ms);
    }
}

const LiveString = struct {
    fat_addr: usize,
    offset: u32,
    len: u32,
};

/// Minimum arena size that can host the double-buffered string region.
pub fn minArenaForVacuum() usize {
    return layout.STRING_DATA_START + 8192;
}

pub fn runVacuumOnce(arena: *SharedArena, index: *art.ArtIndex, string_field_offset: u32) !void {
    var tmp = [_]u32{string_field_offset};
    return runVacuumOnceMulti(arena, index, tmp[0..]);
}

pub fn runVacuumOnceMulti(arena: *SharedArena, index: *art.ArtIndex, offsets: []const u32) !void {
    const allocator = std.heap.page_allocator;
    if (arena.memory.len < minArenaForVacuum()) return error.ArenaTooSmall;
    if (layout.STRING_BUMP_OFFSET + 4 > arena.memory.len) return error.ArenaTooSmall;

    // 1. Collect live record offsets from every node type.
    var live_records = std.ArrayList(u32).init(allocator);
    defer live_records.deinit();

    const root_ptr: *u32 = @ptrCast(@alignCast(index.arena_mem.ptr + index.root_ptr_offset));
    const current_root_raw = @atomicLoad(u32, root_ptr, .acquire);
    if (current_root_raw != 0) {
        try traverseCollect(index.arena_mem, current_root_raw, &live_records);
    }
    if (live_records.items.len == 0) return;

    // 2. First pass: gather live (offset, len) pairs and size the temp buffer.
    // Multi-column: one pass per column offset, same validation as the
    // legacy single-column pass.
    var live_strings = std.ArrayList(LiveString).init(allocator);
    defer live_strings.deinit();

    var total_len: usize = 0;
    for (offsets) |string_field_offset| {
        for (live_records.items) |record_offset| {
            const fat_addr = @as(usize, record_offset) + string_field_offset;
            if (fat_addr + 8 > arena.memory.len) continue;
            const fat_offset = std.mem.readInt(u32, arena.memory[fat_addr..][0..4], .little);
            const fat_len = std.mem.readInt(u32, arena.memory[fat_addr + 4 ..][0..4], .little);
            if (fat_offset == 0 or fat_len == 0) continue;
            if (@as(usize, fat_offset) + fat_len > arena.memory.len) continue;
            if (total_len + fat_len > arena.memory.len) break; // Corrupt lengths; stop.
            total_len += fat_len;
            try live_strings.append(.{ .fat_addr = fat_addr, .offset = fat_offset, .len = fat_len });
        }
    }
    if (live_strings.items.len == 0) return;

    // 3. Double-buffer geometry: split the string region into two banks and
    // compact into whichever bank the bump pointer is NOT using.
    const region = arena.memory.len - layout.STRING_DATA_START;
    const bank_size = region / 2;
    if (bank_size == 0) return error.ArenaTooSmall;
    const bank0 = layout.STRING_DATA_START;
    const bank1 = layout.STRING_DATA_START + bank_size;

    const bump_ptr: *u32 = @ptrCast(@alignCast(&arena.memory[layout.STRING_BUMP_OFFSET]));
    const current_bump = @atomicLoad(u32, bump_ptr, .acquire);
    const dst_bank = if (@as(usize, current_bump) >= bank1) bank0 else bank1;
    if (total_len > bank_size) return error.OutOfMemory;

    const temp_buf = try allocator.alloc(u8, total_len);
    defer allocator.free(temp_buf);

    // 4. Copy live strings into temp, CAS-swizzle their fat pointers.
    var temp_offset: usize = 0;
    for (live_strings.items) |s| {
        std.mem.copyForwards(
            u8,
            temp_buf[temp_offset .. temp_offset + s.len],
            arena.memory[s.offset .. s.offset + s.len],
        );
        const new_offset = @as(u32, @intCast(dst_bank + temp_offset));
        temp_offset += s.len;

        const expected_fat_64 = (@as(u64, s.len) << 32) | s.offset;
        const new_fat_64 = (@as(u64, s.len) << 32) | new_offset;
        if (s.fat_addr % 8 == 0) {
            const fat_ptr_64: *u64 = @ptrCast(@alignCast(&arena.memory[s.fat_addr]));
            _ = @cmpxchgStrong(u64, fat_ptr_64, expected_fat_64, new_fat_64, .release, .monotonic);
        } else {
            // Unaligned fat pointer: single-writer check-then-write. The
            // daemon model never compacts while writers are active.
            const cur_off = std.mem.readInt(u32, arena.memory[s.fat_addr..][0..4], .little);
            const cur_len = std.mem.readInt(u32, arena.memory[s.fat_addr + 4 ..][0..4], .little);
            if (cur_off == s.offset and cur_len == s.len) {
                std.mem.writeInt(u32, arena.memory[s.fat_addr..][0..4], new_offset, .little);
            }
        }
    }

    // 5. Publish: copy temp into the destination bank, then swing the bump.
    std.mem.copyForwards(u8, arena.memory[dst_bank .. dst_bank + temp_offset], temp_buf[0..temp_offset]);
    @atomicStore(u32, bump_ptr, @as(u32, @intCast(dst_bank + temp_offset)), .release);
}

/// Iterative DFS over ALL node types with corruption guards: out-of-range
/// offsets are skipped and traversal is visit-budgeted so a corrupt cycle
/// cannot hang the collector.
fn traverseCollect(arena_mem: []u8, node_raw: u32, list: *std.ArrayList(u32)) !void {
    const allocator = std.heap.page_allocator;
    var stack = std.ArrayList(u32).init(allocator);
    defer stack.deinit();

    try stack.append(node_raw);
    // Each node is >= 8 bytes; this budget can never be exhausted by a tree
    // that fits in the arena, but stops corrupt cycles.
    var budget: usize = arena_mem.len / 8 + 16;

    while (stack.pop()) |current_raw| {
        if (budget == 0) break;
        budget -= 1;
        if (current_raw == 0) continue;
        const ptr = ArtPtr{ .raw = current_raw };
        const offset = ptr.getOffset();
        if (@as(usize, offset) >= arena_mem.len) continue;

        switch (ptr.getType()) {
            .Leaf => {
                if (@as(usize, offset) + @sizeOf(Leaf) > arena_mem.len) continue;
                const leaf: *const Leaf = @ptrCast(@alignCast(arena_mem.ptr + offset));
                try list.append(leaf.value_offset);
            },
            .Node4 => {
                if (@as(usize, offset) + @sizeOf(art.Node4) > arena_mem.len) continue;
                const node: *const art.Node4 = @ptrCast(@alignCast(arena_mem.ptr + offset));
                const n = @min(node.count, 4);
                var i: usize = 0;
                while (i < n) : (i += 1) {
                    if (node.children[i] != 0) try stack.append(node.children[i]);
                }
            },
            .Node16 => {
                if (@as(usize, offset) + @sizeOf(art.Node16) > arena_mem.len) continue;
                const node: *const art.Node16 = @ptrCast(@alignCast(arena_mem.ptr + offset));
                const n = @min(node.count, 16);
                var i: usize = 0;
                while (i < n) : (i += 1) {
                    if (node.children[i] != 0) try stack.append(node.children[i]);
                }
            },
            .Node48 => {
                if (@as(usize, offset) + @sizeOf(art.Node48) > arena_mem.len) continue;
                const node: *const art.Node48 = @ptrCast(@alignCast(arena_mem.ptr + offset));
                const n = @min(node.count, 48);
                var i: usize = 0;
                while (i < n) : (i += 1) {
                    if (node.children[i] != 0) try stack.append(node.children[i]);
                }
            },
            .Node256 => {
                if (@as(usize, offset) + @sizeOf(art.Node256) > arena_mem.len) continue;
                const node: *const art.Node256 = @ptrCast(@alignCast(arena_mem.ptr + offset));
                for (node.children) |child_raw| {
                    if (child_raw != 0) try stack.append(child_raw);
                }
            },
        }
    }
}

test "vacuum multi-column relocates both string columns" {
    const allocator = std.heap.page_allocator;
    const mem_size = layout.STRING_DATA_START + 1024 * 1024;
    const mem = try allocator.alloc(u8, mem_size);
    defer allocator.free(mem);
    @memset(mem, 0);

    var arena = SharedArena{ .memory = mem, .bump_offset = 0, .handle = null };
    var idx = art.ArtIndex.init(mem, 0, 4, 8);

    const OFF_A: u32 = 16;
    const OFF_B: u32 = 32;
    const rec0: u32 = 4096;
    const rec1: u32 = 4160;

    const bank0 = layout.STRING_DATA_START;
    const region = mem.len - layout.STRING_DATA_START;
    const bank_size = region / 2;
    const bank1 = layout.STRING_DATA_START + bank_size;

    const s00 = "alpha-one";
    const s01 = "beta-two-longer";
    const s10 = "gamma";
    const s11 = "delta-fourth";

    var cursor: usize = bank0;
    // rec0 col A
    std.mem.copyForwards(u8, mem[cursor .. cursor + s00.len], s00);
    const old00: u32 = @intCast(cursor);
    std.mem.writeInt(u32, mem[@as(usize, rec0) + OFF_A ..][0..4], old00, .little);
    std.mem.writeInt(u32, mem[@as(usize, rec0) + OFF_A + 4 ..][0..4], @intCast(s00.len), .little);
    cursor += s00.len;
    // rec0 col B
    std.mem.copyForwards(u8, mem[cursor .. cursor + s01.len], s01);
    const old01: u32 = @intCast(cursor);
    std.mem.writeInt(u32, mem[@as(usize, rec0) + OFF_B ..][0..4], old01, .little);
    std.mem.writeInt(u32, mem[@as(usize, rec0) + OFF_B + 4 ..][0..4], @intCast(s01.len), .little);
    cursor += s01.len;
    // rec1 col A
    std.mem.copyForwards(u8, mem[cursor .. cursor + s10.len], s10);
    const old10: u32 = @intCast(cursor);
    std.mem.writeInt(u32, mem[@as(usize, rec1) + OFF_A ..][0..4], old10, .little);
    std.mem.writeInt(u32, mem[@as(usize, rec1) + OFF_A + 4 ..][0..4], @intCast(s10.len), .little);
    cursor += s10.len;
    // rec1 col B
    std.mem.copyForwards(u8, mem[cursor .. cursor + s11.len], s11);
    const old11: u32 = @intCast(cursor);
    std.mem.writeInt(u32, mem[@as(usize, rec1) + OFF_B ..][0..4], old11, .little);
    std.mem.writeInt(u32, mem[@as(usize, rec1) + OFF_B + 4 ..][0..4], @intCast(s11.len), .little);
    cursor += s11.len;

    // Bump points inside bank0 so the inactive bank is bank1.
    std.mem.writeInt(u32, mem[layout.STRING_BUMP_OFFSET..][0..4], @intCast(cursor), .little);

    try idx.insert("a", rec0);
    try idx.insert("b", rec1);

    var cols = [_]u32{ OFF_A, OFF_B };
    try runVacuumOnceMulti(&arena, &idx, cols[0..]);

    const new00 = std.mem.readInt(u32, mem[@as(usize, rec0) + OFF_A ..][0..4], .little);
    const new01 = std.mem.readInt(u32, mem[@as(usize, rec0) + OFF_B ..][0..4], .little);
    const new10 = std.mem.readInt(u32, mem[@as(usize, rec1) + OFF_A ..][0..4], .little);
    const new11 = std.mem.readInt(u32, mem[@as(usize, rec1) + OFF_B ..][0..4], .little);
    const len00 = std.mem.readInt(u32, mem[@as(usize, rec0) + OFF_A + 4 ..][0..4], .little);
    const len01 = std.mem.readInt(u32, mem[@as(usize, rec0) + OFF_B + 4 ..][0..4], .little);
    const len10 = std.mem.readInt(u32, mem[@as(usize, rec1) + OFF_A + 4 ..][0..4], .little);
    const len11 = std.mem.readInt(u32, mem[@as(usize, rec1) + OFF_B + 4 ..][0..4], .little);

    try std.testing.expectEqual(@as(u32, @intCast(s00.len)), len00);
    try std.testing.expectEqual(@as(u32, @intCast(s01.len)), len01);
    try std.testing.expectEqual(@as(u32, @intCast(s10.len)), len10);
    try std.testing.expectEqual(@as(u32, @intCast(s11.len)), len11);

    // All four fat pointers must have moved into the inactive bank.
    for ([_]u32{ new00, new01, new10, new11 }) |no| {
        try std.testing.expect(no >= @as(u32, @intCast(bank1)));
        try std.testing.expect(@as(usize, no) < bank1 + bank_size);
    }
    try std.testing.expect(new00 != old00);
    try std.testing.expect(new01 != old01);
    try std.testing.expect(new10 != old10);
    try std.testing.expect(new11 != old11);

    try std.testing.expect(std.mem.eql(u8, mem[new00 .. new00 + s00.len], s00));
    try std.testing.expect(std.mem.eql(u8, mem[new01 .. new01 + s01.len], s01));
    try std.testing.expect(std.mem.eql(u8, mem[new10 .. new10 + s10.len], s10));
    try std.testing.expect(std.mem.eql(u8, mem[new11 .. new11 + s11.len], s11));
}
