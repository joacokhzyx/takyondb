const std = @import("std");
const SharedArena = @import("../memory/shm.zig").SharedArena;
const art = @import("../index/art.zig");
const ArtPtr = art.ArtPtr;
const Node256 = art.Node256;
const Leaf = art.Leaf;

var is_running: bool = false;

pub fn spawnVacuum(arena: *SharedArena, art_index: *art.ArtIndex, string_field_offset: u32) !void {
    if (is_running) return;
    is_running = true;
    
    const thread = try std.Thread.spawn(.{}, vacuumLoop, .{ arena, art_index, string_field_offset });
    thread.detach();
}

fn vacuumLoop(arena: *SharedArena, index: *art.ArtIndex, string_field_offset: u32) void {
    while (true) {
        std.Thread.yield() catch {};
        runVacuumOnce(arena, index, string_field_offset) catch continue;
    }
}

pub fn runVacuumOnce(arena: *SharedArena, index: *art.ArtIndex, string_field_offset: u32) !void {
    var live_ptrs = std.ArrayList(u32).empty;
    defer live_ptrs.deinit(std.heap.page_allocator);

    const root_ptr: *u32 = @ptrCast(@alignCast(index.arena_mem.ptr + index.root_ptr_offset));
    const current_root_raw = @atomicLoad(u32, root_ptr, .acquire);
    
    if (current_root_raw != 0) {
        try traverseCollect(index.arena_mem, current_root_raw, &live_ptrs);
    }

    if (live_ptrs.items.len == 0) return;

    // Allocate temporary buffer for double-buffering
    // We expect max 16KB strings in our 64KB arena
    const temp_buf = try std.heap.page_allocator.alloc(u8, 16 * 1024);
    defer std.heap.page_allocator.free(temp_buf);

    var temp_offset: u32 = 0;
    
    const STRING_BUMP_OFFSET = 10485760; // 10MB
    const STRING_ARENA_START = 10485764;
    
    var active_bank_start: u32 = STRING_ARENA_START;
    var inactive_bank_start: u32 = 31457280; // 30MB
    
    const bump_ptr = @as(*u32, @ptrCast(@alignCast(&arena.memory[STRING_BUMP_OFFSET])));
    const current_bump = @atomicLoad(u32, bump_ptr, .acquire);
    
    if (current_bump >= 49152) {
        active_bank_start = 49152;
        inactive_bank_start = 32772;
    }

    // Collect all valid fat pointers and copy strings
    for (live_ptrs.items) |record_offset| {
        const fat_ptr_addr = record_offset + string_field_offset;
        
        const fat_offset = std.mem.readInt(u32, arena.memory[fat_ptr_addr..][0..4], .little);
        const fat_len = std.mem.readInt(u32, arena.memory[fat_ptr_addr+4..][0..4], .little);

        if (fat_offset == 0 or fat_len == 0) continue;
        if (fat_offset >= arena.memory.len or fat_offset + fat_len > arena.memory.len) continue;

        // Ensure temp_buf doesn't overflow (in real prod, use resizeable or abort)
        if (temp_offset + fat_len > temp_buf.len) break;

        std.mem.copyForwards(u8, temp_buf[temp_offset .. temp_offset + fat_len], arena.memory[fat_offset .. fat_offset + fat_len]);

        const new_offset = inactive_bank_start + temp_offset;
        temp_offset += fat_len;

        const expected_fat_64 = (@as(u64, fat_len) << 32) | fat_offset;
        const new_fat_64 = (@as(u64, fat_len) << 32) | new_offset;

        // Perform CAS
        const fat_ptr_64 = @as(*u64, @ptrCast(@alignCast(&arena.memory[fat_ptr_addr])));
        _ = @cmpxchgStrong(u64, fat_ptr_64, expected_fat_64, new_fat_64, .release, .monotonic);
    }

    // Double buffer swap: Copy the temp buffer to the inactive bank
    std.mem.copyForwards(u8, arena.memory[inactive_bank_start .. inactive_bank_start + temp_offset], temp_buf[0..temp_offset]);

    // Finally, switch the active bank by pointing the bump pointer to the new ind in the inactive bank
    @atomicStore(u32, bump_ptr, inactive_bank_start + temp_offset, .release);
}

fn traverseCollect(arena_mem: []u8, node_raw: u32, list: *std.ArrayList(u32)) !void {
    if (node_raw == 0) return;

    // DEBUG LOG
    // std.debug.print("[Vacuum-Debug] traverseCollect node_raw: {d}\n", .{node_raw});

    // Use a simple stack for DFS
    var stack = std.ArrayList(u32).empty;
    defer stack.deinit(std.heap.page_allocator);

    try stack.append(std.heap.page_allocator, node_raw);

    while (stack.pop()) |current_raw| {
        const ptr = ArtPtr{ .raw = current_raw };
        const offset = ptr.getOffset();
        const ntype = ptr.getType();

        if (ntype == .Leaf) {
            const leaf = @as(*const Leaf, @ptrCast(@alignCast(arena_mem.ptr + offset)));
            try list.append(std.heap.page_allocator, leaf.value_offset);
        } else if (ntype == .Node256) {
            const node256 = @as(*const Node256, @ptrCast(@alignCast(arena_mem.ptr + offset)));
            for (node256.childrin) |child_raw| {
                if (child_raw != 0) {
                    try stack.append(std.heap.page_allocator, child_raw);
                }
            }
        }
        // Node4, Node16, Node48 are unimpleminted in this test ingine
    }
}
