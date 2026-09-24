// ============================================================================
// File: art.zig
// Description: Lock-free Adaptive Radix Tree index over SharedArena.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Cache line alignment to avoid false sharing
pub const CACHE_LINE = 64;

/// Largest key accepted by the index (mirrors SDK MAX_KEY_LEN).
pub const MAX_KEY_LEN: usize = 256;

/// Reserved byte marking "end of key" inside inner nodes. Keys must be
/// non-empty, NUL-free and at most MAX_KEY_LEN bytes; this lets a key that
/// is a strict prefix of another key live in the same tree without any
/// extra terminator fields in the node layouts.
pub const TERMINATOR: u8 = 0x00;

/// Shrink thresholds: a node shrinks to the next smaller type when its
/// child count drops to (or below) the threshold after a delete.
/// Levels are positional (level d indexes key[d]); shrinking only swaps
/// the node type in place at the same level via parent-link CAS and never
/// bypasses a level (no chain compression).
pub const SHRINK_256_TO_48: u16 = 32;
pub const SHRINK_48_TO_16: u8 = 10;
pub const SHRINK_16_TO_4: u8 = 3;

pub const ArtError = error{
    InvalidKey,
    OutOfMemory,
    UnsupportedNodeType,
    LockContention,
};

/// Tagged pointer for ART nodes.
/// We use the lowest 3 bits (values 0-7) to store the node type,
/// since node allocations are 8-byte aligned.
pub const NodeType = enum(u8) {
    Node4 = 0,
    Node16 = 1,
    Node48 = 2,
    Node256 = 3,
    Leaf = 4,
};

/// Tagged pointer representation (32-bit offset into SharedArena)
pub const ArtPtr = packed struct {
    raw: u32,

    pub inline fn empty() ArtPtr {
        return .{ .raw = 0 };
    }

    pub inline fn isEmpty(self: ArtPtr) bool {
        return self.raw == 0;
    }

    pub inline fn new(offset: u32, ntype: NodeType) ArtPtr {
        std.debug.assert(offset % 8 == 0); // Must be 8-byte aligned
        return .{ .raw = offset | @intFromEnum(ntype) };
    }

    pub inline fn getType(self: ArtPtr) NodeType {
        return @enumFromInt(@as(u8, @truncate(self.raw & 0x7)));
    }

    pub inline fn getOffset(self: ArtPtr) u32 {
        return self.raw & ~@as(u32, 0x7);
    }

    pub inline fn asRaw(self: ArtPtr) u32 {
        return self.raw;
    }
};

/// Node4: up to 4 children
pub const Node4 = extern struct {
    count: u8,
    pad: [3]u8,
    keys: [4]u8,
    children: [4]u32, // store raw u32 for atomic ops

    pub inline fn isFull(self: *const Node4) bool {
        return self.count >= 4;
    }

    pub fn findPos(self: *const Node4, key_byte: u8) ?usize {
        var i: usize = 0;
        while (i < self.count) : (i += 1) {
            if (self.keys[i] == key_byte) return i;
        }
        return null;
    }
};

/// Node16: up to 16 children (uses SIMD for searching)
pub const Node16 = extern struct {
    count: u8,
    pad: [15]u8,
    keys: [16]u8,
    children: [16]u32,

    pub inline fn isFull(self: *const Node16) bool {
        return self.count >= 16;
    }

    pub fn search(self: *const Node16, key_byte: u8) ?u8 {
        const Vector16 = @Vector(16, u8);
        const keys_vec: Vector16 = self.keys;
        const target_vec: Vector16 = @splat(key_byte);

        const cmp_mask = keys_vec == target_vec;

        // Zero loops allowed! Use SIMD select and reduce to generate the bitmask
        const bit_values: @Vector(16, u16) = .{
            1 << 0, 1 << 1, 1 << 2,  1 << 3,  1 << 4,  1 << 5,  1 << 6,  1 << 7,
            1 << 8, 1 << 9, 1 << 10, 1 << 11, 1 << 12, 1 << 13, 1 << 14, 1 << 15,
        };
        const zeros: @Vector(16, u16) = @splat(0);

        const bitmask_vec = @select(u16, cmp_mask, bit_values, zeros);
        const bitmask = @reduce(.Or, bitmask_vec);

        if (bitmask != 0) {
            return @as(u8, @intCast(@ctz(bitmask)));
        }
        return null;
    }

    /// SIMD search restricted to populated slots. Slots at index >= count
    /// may hold stale bytes, so the raw result must be range-checked.
    pub fn findPos(self: *const Node16, key_byte: u8) ?usize {
        if (self.search(key_byte)) |idx| {
            if (idx < self.count) return idx;
        }
        return null;
    }
};

/// Node48: up to 48 children (uses a 256-byte array for fast indexing).
/// child_index[byte] is 0 when absent, otherwise slot+1. Index 0 doubles
/// as the TERMINATOR slot because keys never contain NUL bytes.
pub const Node48 = extern struct {
    count: u8,
    pad: [15]u8,
    child_index: [256]u8,
    children: [48]u32,

    pub inline fn isFull(self: *const Node48) bool {
        return self.count >= 48;
    }

    pub inline fn findSlot(self: *const Node48, key_byte: u8) ?usize {
        const s = self.child_index[key_byte];
        if (s == 0) return null;
        return @as(usize, s - 1);
    }
};

/// Node256: up to 256 children (direct addressing).
/// Slot 0 doubles as the TERMINATOR slot (keys are NUL-free).
pub const Node256 = extern struct {
    count: u16,
    pad: [6]u8,
    pad2: [8]u8,
    children: [256]u32,

    pub fn insertLockFree(self: *Node256, key_byte: u8, child_raw: u32) bool {
        // Lock-free CAS to insert a child
        const child_ptr = &self.children[key_byte];
        const current = @atomicLoad(u32, child_ptr, .acquire);
        if (current != 0) return false; // Already taken

        return @cmpxchgStrong(u32, child_ptr, 0, child_raw, .release, .monotonic) == null;
    }
};

/// Leaf node
pub const Leaf = extern struct {
    key_len: u32,
    value_offset: u32,
    // key follows inline
};

/// Maximum restart attempts for structural delete races before giving up.
const MAX_DELETE_RETRIES: u8 = 32;

/// Deepest parent-link chain: one slot per key byte plus the terminator level.
const MAX_DEPTH: usize = MAX_KEY_LEN + 1;

fn validateKey(key: []const u8) ArtError!void {
    if (key.len == 0 or key.len > MAX_KEY_LEN) return error.InvalidKey;
    if (std.mem.indexOfScalar(u8, key, TERMINATOR) != null) return error.InvalidKey;
}

fn leafKeyBytes(arena_mem: []u8, leaf_offset: u32, key_len: u32) ArtError![]u8 {
    const start = @as(usize, leaf_offset) + @sizeOf(Leaf);
    const end = start + @as(usize, key_len);
    if (end > arena_mem.len) return error.OutOfMemory;
    return arena_mem[start..end];
}

fn leafKeyEql(arena_mem: []u8, leaf_offset: u32, key: []const u8) ArtError!bool {
    const leaf: *const Leaf = @ptrCast(@alignCast(arena_mem.ptr + leaf_offset));
    if (leaf.key_len != key.len) return false;
    const stored = try leafKeyBytes(arena_mem, leaf_offset, leaf.key_len);
    return std.mem.eql(u8, stored, key);
}

pub const ArtIndex = struct {
    arena_mem: []u8,
    root_ptr_offset: usize,
    bump_alloc_offset: usize,

    pub fn init(arena_mem: []u8, root_ptr_offset: usize, bump_alloc_offset: usize, arena_start: u32) ArtIndex {
        const bump_ptr: *u32 = @ptrCast(@alignCast(arena_mem.ptr + bump_alloc_offset));
        _ = @cmpxchgStrong(u32, bump_ptr, 0, arena_start, .monotonic, .monotonic);
        return .{
            .arena_mem = arena_mem,
            .root_ptr_offset = root_ptr_offset,
            .bump_alloc_offset = bump_alloc_offset,
        };
    }

    fn u32Slot(self: *ArtIndex, byte_offset: usize) ArtError!*u32 {
        if (byte_offset + @sizeOf(u32) > self.arena_mem.len) return error.OutOfMemory;
        std.debug.assert(byte_offset % 4 == 0);
        return @ptrCast(@alignCast(self.arena_mem.ptr + byte_offset));
    }

    fn nodeAt(self: *ArtIndex, offset: u32, comptime T: type) ArtError!*T {
        if (@as(usize, offset) + @sizeOf(T) > self.arena_mem.len) return error.OutOfMemory;
        return @ptrCast(@alignCast(self.arena_mem.ptr + offset));
    }

    pub fn allocNode(self: *ArtIndex, size: u32) ArtError!u32 {
        const align_mask: u32 = 7;
        const aligned_size = (size + align_mask) & ~align_mask;
        const bump_ptr = try self.u32Slot(self.bump_alloc_offset);
        var cur = @atomicLoad(u32, bump_ptr, .monotonic);
        while (true) {
            const end = @as(usize, cur) + aligned_size;
            if (end > self.arena_mem.len) return error.OutOfMemory;
            if (@cmpxchgStrong(u32, bump_ptr, cur, @as(u32, @intCast(end)), .monotonic, .monotonic)) |actual| {
                cur = actual;
            } else {
                return cur;
            }
        }
    }

    fn allocZeroed(self: *ArtIndex, size: u32) ArtError!u32 {
        const off = try self.allocNode(size);
        @memset(self.arena_mem[off .. off + size], 0);
        return off;
    }

    fn allocLeaf(self: *ArtIndex, key: []const u8, value_offset: u32) ArtError!u32 {
        const leaf_size = @as(u32, @intCast(@sizeOf(Leaf) + key.len));
        const off = try self.allocNode(leaf_size);
        const leaf = try self.nodeAt(off, Leaf);
        leaf.key_len = @as(u32, @intCast(key.len));
        leaf.value_offset = value_offset;
        const dst = try leafKeyBytes(self.arena_mem, off, leaf.key_len);
        std.mem.copyForwards(u8, dst, key);
        return off;
    }

    /// Current root node type, or null when the tree is empty.
    pub fn rootType(self: *ArtIndex) ArtError!?NodeType {
        const root_slot = try self.u32Slot(self.root_ptr_offset);
        const raw = @atomicLoad(u32, root_slot, .acquire);
        if (raw == 0) return null;
        const ptr = ArtPtr{ .raw = raw };
        return ptr.getType();
    }

    /// Inserts or overwrites a key. Keys must be non-empty, NUL-free and
    /// at most 256 bytes. Concurrent inserts of distinct keys are lock-free;
    /// concurrent insert + remove on overlapping keys is NOT safe (the
    /// daemon model never deletes; see remove()).
    pub fn insert(self: *ArtIndex, key: []const u8, value_offset: u32) ArtError!void {
        try validateKey(key);
        if (@as(usize, value_offset) >= self.arena_mem.len) return error.InvalidKey;

        const root_slot = try self.u32Slot(self.root_ptr_offset);

        if (@atomicLoad(u32, root_slot, .acquire) == 0) {
            const off = try self.allocZeroed(@sizeOf(Node4));
            const want = ArtPtr.new(off, .Node4).asRaw();
            _ = @cmpxchgStrong(u32, root_slot, 0, want, .release, .monotonic);
        }

        const new_leaf_off = try self.allocLeaf(key, value_offset);
        const new_leaf_raw = ArtPtr.new(new_leaf_off, .Leaf).asRaw();

        restart: while (true) {
            var depth: usize = 0;
            var link: *u32 = root_slot;
            var cur_raw = @atomicLoad(u32, root_slot, .acquire);
            if (cur_raw == 0) continue :restart;

            while (true) {
                // The parent link must still hold this node; otherwise a
                // concurrent grow replaced it and we are reading an orphan.
                if (@atomicLoad(u32, link, .acquire) != cur_raw) continue :restart;
                const cur = ArtPtr{ .raw = cur_raw };
                const noff = cur.getOffset();
                const slot_byte: u8 = if (depth < key.len) key[depth] else TERMINATOR;

                switch (cur.getType()) {
                    .Leaf => {
                        // Only reachable if the root itself is a leaf.
                        if (try leafKeyEql(self.arena_mem, noff, key)) {
                            const leaf = try self.nodeAt(noff, Leaf);
                            @atomicStore(u32, &leaf.value_offset, value_offset, .release);
                            return;
                        }
                        const chain = try self.buildSplit(noff, key, new_leaf_raw, 0);
                        if (@cmpxchgStrong(u32, link, cur_raw, chain, .release, .monotonic) == null) return;
                        continue :restart;
                    },
                    .Node4 => {
                        const node = try self.nodeAt(noff, Node4);
                        if (node.findPos(slot_byte)) |pos| {
                            const cres = try self.descendOrSplit(&node.children[pos], key, value_offset, new_leaf_raw, depth);
                            if (cres.done) return;
                            if (cres.child_raw) |child| {
                                link = &node.children[pos];
                                cur_raw = child;
                                depth += 1;
                                continue;
                            }
                            continue :restart;
                        }
                        if (node.isFull()) {
                            const grown = try self.growNode(cur_raw, .Node4, noff);
                            if (@cmpxchgStrong(u32, link, cur_raw, grown, .release, .monotonic) == null) {
                                cur_raw = grown;
                                continue;
                            }
                            continue :restart;
                        }
                        // Claim a slot via count CAS so concurrent inserts
                        // into the same node do not lose updates.
                        var c = @atomicLoad(u8, &node.count, .acquire);
                        const slot: usize = while (c < 4) {
                            if (@cmpxchgStrong(u8, &node.count, c, c + 1, .release, .monotonic) == null) break c;
                            c = @atomicLoad(u8, &node.count, .acquire);
                            // Re-check: a racing writer may have added our byte.
                            if (node.findPos(slot_byte) != null) continue :restart;
                        } else continue :restart; // Filled concurrently; retry (grow path).
                        node.keys[slot] = slot_byte;
                        @atomicStore(u32, &node.children[slot], new_leaf_raw, .release);
                        return;
                    },
                    .Node16 => {
                        const node = try self.nodeAt(noff, Node16);
                        if (node.findPos(slot_byte)) |pos| {
                            const cres = try self.descendOrSplit(&node.children[pos], key, value_offset, new_leaf_raw, depth);
                            if (cres.done) return;
                            if (cres.child_raw) |child| {
                                link = &node.children[pos];
                                cur_raw = child;
                                depth += 1;
                                continue;
                            }
                            continue :restart;
                        }
                        if (node.isFull()) {
                            const grown = try self.growNode(cur_raw, .Node16, noff);
                            if (@cmpxchgStrong(u32, link, cur_raw, grown, .release, .monotonic) == null) {
                                cur_raw = grown;
                                continue;
                            }
                            continue :restart;
                        }
                        var c = @atomicLoad(u8, &node.count, .acquire);
                        const slot: usize = while (c < 16) {
                            if (@cmpxchgStrong(u8, &node.count, c, c + 1, .release, .monotonic) == null) break c;
                            c = @atomicLoad(u8, &node.count, .acquire);
                            if (node.findPos(slot_byte) != null) continue :restart;
                        } else continue :restart;
                        node.keys[slot] = slot_byte;
                        @atomicStore(u32, &node.children[slot], new_leaf_raw, .release);
                        return;
                    },
                    .Node48 => {
                        const node = try self.nodeAt(noff, Node48);
                        if (node.findSlot(slot_byte)) |slot| {
                            const cres = try self.descendOrSplit(&node.children[slot], key, value_offset, new_leaf_raw, depth);
                            if (cres.done) return;
                            if (cres.child_raw) |child| {
                                link = &node.children[slot];
                                cur_raw = child;
                                depth += 1;
                                continue;
                            }
                            continue :restart;
                        }
                        if (node.isFull()) {
                            const grown = try self.growNode(cur_raw, .Node48, noff);
                            if (@cmpxchgStrong(u32, link, cur_raw, grown, .release, .monotonic) == null) {
                                cur_raw = grown;
                                continue;
                            }
                            continue :restart;
                        }
                        var c = @atomicLoad(u8, &node.count, .acquire);
                        const slot: usize = while (c < 48) {
                            if (@cmpxchgStrong(u8, &node.count, c, c + 1, .release, .monotonic) == null) break c;
                            c = @atomicLoad(u8, &node.count, .acquire);
                            if (node.findSlot(slot_byte) != null) continue :restart;
                        } else continue :restart;
                        node.child_index[slot_byte] = @as(u8, @intCast(slot + 1));
                        @atomicStore(u32, &node.children[slot], new_leaf_raw, .release);
                        return;
                    },
                    .Node256 => {
                        const node = try self.nodeAt(noff, Node256);
                        const slot_ptr = &node.children[slot_byte];
                        const child = @atomicLoad(u32, slot_ptr, .acquire);
                        if (child != 0) {
                            const cres = try self.descendOrSplit(slot_ptr, key, value_offset, new_leaf_raw, depth);
                            if (cres.done) return;
                            if (cres.child_raw) |next| {
                                link = slot_ptr;
                                cur_raw = next;
                                depth += 1;
                                continue;
                            }
                            continue :restart;
                        }
                        if (node.insertLockFree(slot_byte, new_leaf_raw)) {
                            _ = @atomicRmw(u16, &node.count, .Add, 1, .monotonic);
                            return;
                        }
                        continue :restart;
                    },
                }
            }
        }
    }

    const DescendResult = struct {
        done: bool,
        child_raw: ?u32,
    };

    /// Handles an occupied child slot: overwrites on full-key match,
    /// otherwise splits the leaf. Returns done=true when the insert
    /// completed, or the inner-node child to descend into.
    fn descendOrSplit(
        self: *ArtIndex,
        child_slot: *u32,
        key: []const u8,
        value_offset: u32,
        new_leaf_raw: u32,
        depth: usize,
    ) ArtError!DescendResult {
        const child = @atomicLoad(u32, child_slot, .acquire);
        if (child == 0) return .{ .done = false, .child_raw = null };
        const cart = ArtPtr{ .raw = child };
        if (cart.getType() != .Leaf) return .{ .done = false, .child_raw = child };
        if (try leafKeyEql(self.arena_mem, cart.getOffset(), key)) {
            const leaf = try self.nodeAt(cart.getOffset(), Leaf);
            @atomicStore(u32, &leaf.value_offset, value_offset, .release);
            return .{ .done = true, .child_raw = null };
        }
        const chain = try self.buildSplit(cart.getOffset(), key, new_leaf_raw, depth);
        if (@cmpxchgStrong(u32, child_slot, child, chain, .release, .monotonic) == null) {
            return .{ .done = true, .child_raw = null };
        }
        return .{ .done = false, .child_raw = null };
    }

    /// Builds a split chain replacing an existing leaf that collides with
    /// the new key. `depth` is the level of the slot being replaced: both
    /// keys share bytes [0..depth]. Returns the raw pointer of the chain top.
    fn buildSplit(
        self: *ArtIndex,
        existing_leaf_off: u32,
        key: []const u8,
        new_leaf_raw: u32,
        depth: usize,
    ) ArtError!u32 {
        const existing_leaf: *const Leaf = @ptrCast(@alignCast(self.arena_mem.ptr + existing_leaf_off));
        const existing_key = try leafKeyBytes(self.arena_mem, existing_leaf_off, existing_leaf.key_len);

        var p: usize = depth + 1;
        while (p < existing_key.len and p < key.len and existing_key[p] == key[p]) : (p += 1) {}
        // Defensive: p can never exceed either key in a genuine split.
        if (p > key.len or p > existing_key.len) return error.UnsupportedNodeType;

        const existing_raw = ArtPtr.new(existing_leaf_off, .Leaf).asRaw();

        // Final Node4 holding the two divergent leaves.
        const fork_off = try self.allocZeroed(@sizeOf(Node4));
        const fork = try self.nodeAt(fork_off, Node4);
        if (p >= existing_key.len or p >= key.len) {
            // Prefix case: shorter key parks under TERMINATOR.
            if (existing_key.len < key.len) {
                fork.keys[0] = TERMINATOR;
                fork.children[0] = existing_raw;
                fork.keys[1] = key[p];
                fork.children[1] = new_leaf_raw;
            } else {
                fork.keys[0] = TERMINATOR;
                fork.children[0] = new_leaf_raw;
                fork.keys[1] = existing_key[p];
                fork.children[1] = existing_raw;
            }
        } else {
            fork.keys[0] = existing_key[p];
            fork.children[0] = existing_raw;
            fork.keys[1] = key[p];
            fork.children[1] = new_leaf_raw;
        }
        fork.count = 2;

        // Chain single-child Node4s for the shared bytes [depth+1 .. p).
        // Every i in range satisfies i < key.len (see bound above).
        var top_raw = ArtPtr.new(fork_off, .Node4).asRaw();
        var i: usize = p;
        while (i > depth + 1) {
            i -= 1;
            const link_off = try self.allocZeroed(@sizeOf(Node4));
            const link_node = try self.nodeAt(link_off, Node4);
            link_node.keys[0] = key[i];
            link_node.children[0] = top_raw;
            link_node.count = 1;
            top_raw = ArtPtr.new(link_off, .Node4).asRaw();
        }
        return top_raw;
    }

    /// Upgrades a full node to the next size. The new node copies every
    /// entry (including TERMINATOR entries); the caller swaps the parent
    /// link with CAS.
    fn growNode(self: *ArtIndex, cur_raw: u32, ntype: NodeType, noff: u32) ArtError!u32 {
        switch (ntype) {
            .Node4 => {
                const src = try self.nodeAt(noff, Node4);
                if (src.count > 4) {
                    std.debug.print("ART-CORRUPT Node4 off={d} count={d}\n", .{ noff, src.count });
                    return error.UnsupportedNodeType;
                }
                const dst_off = try self.allocZeroed(@sizeOf(Node16));
                const dst = try self.nodeAt(dst_off, Node16);
                std.mem.copyForwards(u8, dst.keys[0..src.count], src.keys[0..src.count]);
                std.mem.copyForwards(u32, dst.children[0..src.count], src.children[0..src.count]);
                dst.count = src.count;
                return ArtPtr.new(dst_off, .Node16).asRaw();
            },
            .Node16 => {
                const src = try self.nodeAt(noff, Node16);
                if (src.count > 16) {
                    std.debug.print("ART-CORRUPT Node16 off={d} count={d} keys={any}\n", .{ noff, src.count, src.keys });
                    return error.UnsupportedNodeType;
                }
                const dst_off = try self.allocZeroed(@sizeOf(Node48));
                const dst = try self.nodeAt(dst_off, Node48);
                var i: usize = 0;
                while (i < src.count) : (i += 1) {
                    dst.child_index[src.keys[i]] = @as(u8, @intCast(i + 1));
                    dst.children[i] = src.children[i];
                }
                dst.count = src.count;
                return ArtPtr.new(dst_off, .Node48).asRaw();
            },
            .Node48 => {
                const src = try self.nodeAt(noff, Node48);
                if (src.count > 48) {
                    std.debug.print("ART-CORRUPT Node48 off={d} count={d}\n", .{ noff, src.count });
                    return error.UnsupportedNodeType;
                }
                const dst_off = try self.allocZeroed(@sizeOf(Node256));
                const dst = try self.nodeAt(dst_off, Node256);
                var b: usize = 0;
                var n: u16 = 0;
                while (b < 256) : (b += 1) {
                    const s = src.child_index[b];
                    if (s != 0) {
                        dst.children[b] = src.children[s - 1];
                        n += 1;
                    }
                }
                dst.count = n;
                return ArtPtr.new(dst_off, .Node256).asRaw();
            },
            else => return cur_raw,
        }
    }

    pub fn search(self: *ArtIndex, key: []const u8) ?u32 {
        if (key.len == 0 or key.len > MAX_KEY_LEN) return null;
        if (std.mem.indexOfScalar(u8, key, TERMINATOR) != null) return null;
        const root_slot = self.u32Slot(self.root_ptr_offset) catch return null;
        var cur_raw = @atomicLoad(u32, root_slot, .acquire);
        if (cur_raw == 0) return null;
        var depth: usize = 0;

        while (true) {
            const ptr = ArtPtr{ .raw = cur_raw };
            const noff = ptr.getOffset();
            if (@as(usize, noff) >= self.arena_mem.len) return null;
            const slot_byte: u8 = if (depth < key.len) key[depth] else TERMINATOR;

            switch (ptr.getType()) {
                .Leaf => {
                    if (@as(usize, noff) + @sizeOf(Leaf) > self.arena_mem.len) return null;
                    const leaf: *const Leaf = @ptrCast(@alignCast(self.arena_mem.ptr + noff));
                    if (leaf.key_len != key.len) return null;
                    const stored = leafKeyBytes(self.arena_mem, noff, leaf.key_len) catch return null;
                    if (std.mem.eql(u8, stored, key)) return leaf.value_offset;
                    return null;
                },
                .Node4 => {
                    if (@as(usize, noff) + @sizeOf(Node4) > self.arena_mem.len) return null;
                    const node: *const Node4 = @ptrCast(@alignCast(self.arena_mem.ptr + noff));
                    if (node.count > 4) return null;
                    var found: ?u32 = null;
                    var i: usize = 0;
                    while (i < node.count) : (i += 1) {
                        if (node.keys[i] == slot_byte) {
                            found = @atomicLoad(u32, @constCast(&node.children[i]), .acquire);
                            break;
                        }
                    }
                    const child = found orelse return null;
                    if (child == 0) return null;
                    cur_raw = child;
                    depth += 1;
                },
                .Node16 => {
                    if (@as(usize, noff) + @sizeOf(Node16) > self.arena_mem.len) return null;
                    const node: *const Node16 = @ptrCast(@alignCast(self.arena_mem.ptr + noff));
                    if (node.count > 16) return null;
                    const pos = node.findPos(slot_byte) orelse return null;
                    const child = @atomicLoad(u32, @constCast(&node.children[pos]), .acquire);
                    if (child == 0) return null;
                    cur_raw = child;
                    depth += 1;
                },
                .Node48 => {
                    if (@as(usize, noff) + @sizeOf(Node48) > self.arena_mem.len) return null;
                    const node: *const Node48 = @ptrCast(@alignCast(self.arena_mem.ptr + noff));
                    if (node.count > 48) return null;
                    const s = node.child_index[slot_byte];
                    if (s == 0 or s > node.count) return null;
                    const child = @atomicLoad(u32, @constCast(&node.children[s - 1]), .acquire);
                    if (child == 0) return null;
                    cur_raw = child;
                    depth += 1;
                },
                .Node256 => {
                    if (@as(usize, noff) + @sizeOf(Node256) > self.arena_mem.len) return null;
                    const node: *const Node256 = @ptrCast(@alignCast(self.arena_mem.ptr + noff));
                    const child = @atomicLoad(u32, @constCast(&node.children[slot_byte]), .acquire);
                    if (child == 0) return null;
                    cur_raw = child;
                    depth += 1;
                },
            }
        }
    }

    /// Maximum nodes visited per prefix scan (corrupt-cycle guard, like vacuum).
    const MAX_SCAN_VISITS: usize = 65536;

    /// Collects value_offsets of every leaf whose key starts with `prefix`.
    /// Writes at most `out.len` offsets and returns the count written.
    /// Returns 0 for invalid prefixes, empty trees, or corrupt nodes.
    /// Best-effort under concurrency (tolerates racing grow/shrink like search).
    pub fn scanPrefix(self: *ArtIndex, prefix: []const u8, out: []u32) usize {
        if (prefix.len == 0 or prefix.len > MAX_KEY_LEN) return 0;
        if (std.mem.indexOfScalar(u8, prefix, TERMINATOR) != null) return 0;
        if (out.len == 0) return 0;
        const root_slot = self.u32Slot(self.root_ptr_offset) catch return 0;
        var cur_raw = @atomicLoad(u32, root_slot, .acquire);
        if (cur_raw == 0) return 0;

        // Descend exactly prefix.len levels; the subtree below holds every match.
        var depth: usize = 0;
        while (depth < prefix.len) {
            const ptr = ArtPtr{ .raw = cur_raw };
            if (ptr.getType() == .Leaf) {
                // Degenerate single-leaf tree: match iff the key starts with prefix.
                if (!self.leafStartsWith(ptr.getOffset(), prefix)) return 0;
                const leaf = self.nodeAt(ptr.getOffset(), Leaf) catch return 0;
                out[0] = @atomicLoad(u32, &leaf.value_offset, .acquire);
                return 1;
            }
            const child = self.childAt(ptr.getType(), ptr.getOffset(), prefix[depth]) catch return 0;
            if (child == 0) return 0;
            cur_raw = child;
            depth += 1;
        }

        // DFS over the subtree with an explicit stack (no allocator).
        const Frame = struct {
            raw: u32,
            pos: usize,
        };
        var stack: [MAX_DEPTH]Frame = undefined;
        var sp: usize = 1;
        stack[0] = .{ .raw = cur_raw, .pos = 0 };
        var found: usize = 0;
        var budget: usize = MAX_SCAN_VISITS;

        while (sp > 0 and found < out.len and budget > 0) {
            budget -= 1;
            const top = &stack[sp - 1];
            const ptr = ArtPtr{ .raw = top.raw };
            if (ptr.getType() == .Leaf) {
                sp -= 1;
                if (!self.leafStartsWith(ptr.getOffset(), prefix)) continue;
                const leaf = self.nodeAt(ptr.getOffset(), Leaf) catch continue;
                out[found] = @atomicLoad(u32, &leaf.value_offset, .acquire);
                found += 1;
                continue;
            }
            if (self.nextChild(ptr.getType(), ptr.getOffset(), &top.pos)) |c| {
                if (c.raw == 0) continue;
                if (sp >= MAX_DEPTH) break; // Pathological depth; stop.
                stack[sp] = .{ .raw = c.raw, .pos = 0 };
                sp += 1;
            } else {
                sp -= 1; // Exhausted or unreadable: pop.
            }
        }
        return found;
    }

    /// True when the leaf key at `leaf_off` starts with `prefix`.
    /// Returns false on any out-of-bounds data (never panics on arena bytes).
    fn leafStartsWith(self: *ArtIndex, leaf_off: u32, prefix: []const u8) bool {
        const leaf = self.nodeAt(leaf_off, Leaf) catch return false;
        if (leaf.key_len < prefix.len) return false;
        const stored = leafKeyBytes(self.arena_mem, leaf_off, leaf.key_len) catch return false;
        return std.mem.startsWith(u8, stored, prefix);
    }

    /// Point child lookup shared by scanPrefix descent (strict like search).
    /// Returns 0 when the slot is empty; errors on out-of-bounds nodes.
    fn childAt(self: *ArtIndex, ntype: NodeType, noff: u32, byte: u8) ArtError!u32 {
        switch (ntype) {
            .Leaf => return error.UnsupportedNodeType,
            .Node4 => {
                const node = try self.nodeAt(noff, Node4);
                if (node.count > 4) return error.UnsupportedNodeType;
                const pos = node.findPos(byte) orelse return 0;
                return @atomicLoad(u32, &node.children[pos], .acquire);
            },
            .Node16 => {
                const node = try self.nodeAt(noff, Node16);
                if (node.count > 16) return error.UnsupportedNodeType;
                const pos = node.findPos(byte) orelse return 0;
                return @atomicLoad(u32, &node.children[pos], .acquire);
            },
            .Node48 => {
                const node = try self.nodeAt(noff, Node48);
                if (node.count > 48) return error.UnsupportedNodeType;
                const s = node.child_index[byte];
                if (s == 0 or s > node.count) return 0;
                return @atomicLoad(u32, &node.children[s - 1], .acquire);
            },
            .Node256 => {
                const node = try self.nodeAt(noff, Node256);
                return @atomicLoad(u32, &node.children[byte], .acquire);
            },
        }
    }

    /// Iterates children of a node in deterministic order (key order for
    /// Node4/Node16, byte order for Node48/Node256). Advances `*pos` past
    /// the returned child and reports the branch byte taken. Returns null
    /// when exhausted or the node is unreadable (caller pops).
    /// Skips empty/stale slots best-effort.
    const Child = struct {
        raw: u32,
        byte: u8,
    };

    fn nextChild(self: *ArtIndex, ntype: NodeType, noff: u32, pos: *usize) ?Child {
        switch (ntype) {
            .Leaf => return null,
            .Node4 => {
                const node = self.nodeAt(noff, Node4) catch return null;
                const c: usize = @min(node.count, 4);
                while (pos.* < c) {
                    const i = pos.*;
                    pos.* += 1;
                    const child = @atomicLoad(u32, &node.children[i], .acquire);
                    if (child != 0) return .{ .raw = child, .byte = node.keys[i] };
                }
                return null;
            },
            .Node16 => {
                const node = self.nodeAt(noff, Node16) catch return null;
                const c: usize = @min(node.count, 16);
                while (pos.* < c) {
                    const i = pos.*;
                    pos.* += 1;
                    const child = @atomicLoad(u32, &node.children[i], .acquire);
                    if (child != 0) return .{ .raw = child, .byte = node.keys[i] };
                }
                return null;
            },
            .Node48 => {
                const node = self.nodeAt(noff, Node48) catch return null;
                while (pos.* < 256) {
                    const b = pos.*;
                    pos.* += 1;
                    const s = node.child_index[b];
                    if (s == 0 or s > 48) continue;
                    const child = @atomicLoad(u32, &node.children[s - 1], .acquire);
                    if (child != 0) return .{ .raw = child, .byte = @intCast(b) };
                }
                return null;
            },
            .Node256 => {
                const node = self.nodeAt(noff, Node256) catch return null;
                while (pos.* < 256) {
                    const b = pos.*;
                    pos.* += 1;
                    const child = @atomicLoad(u32, &node.children[b], .acquire);
                    if (child != 0) return .{ .raw = child, .byte = @intCast(b) };
                }
                return null;
            },
        }
    }

    /// True when `suffix` lies within [`lo`, `hi`] (lexicographic, unsigned
    /// bytes). An empty bound means unbounded on that side.
    fn suffixInBounds(suffix: []const u8, lo: []const u8, hi: []const u8) bool {
        if (lo.len > 0 and std.mem.order(u8, suffix, lo) == .lt) return false;
        if (hi.len > 0 and std.mem.order(u8, suffix, hi) == .gt) return false;
        return true;
    }

    /// Collects value_offsets of leaves whose key starts with `prefix` and
    /// whose remaining suffix lies within [`lo`, `hi`]. Empty `lo`/`hi` are
    /// unbounded. Writes at most `out.len` offsets, returns the count.
    /// Returns 0 for invalid input (`lo > hi`, bad lengths, NUL bytes),
    /// empty trees, or corrupt nodes. Subtrees provably above `hi` are
    /// pruned during the ordered DFS; complexity is O(matching subtree).
    pub fn scanRange(self: *ArtIndex, prefix: []const u8, lo: []const u8, hi: []const u8, out: []u32) usize {
        if (prefix.len == 0 or prefix.len > MAX_KEY_LEN) return 0;
        if (lo.len > MAX_KEY_LEN or hi.len > MAX_KEY_LEN) return 0;
        if (std.mem.indexOfScalar(u8, prefix, TERMINATOR) != null) return 0;
        if (std.mem.indexOfScalar(u8, lo, TERMINATOR) != null) return 0;
        if (std.mem.indexOfScalar(u8, hi, TERMINATOR) != null) return 0;
        if (lo.len > 0 and hi.len > 0 and std.mem.order(u8, lo, hi) == .gt) return 0;
        if (out.len == 0) return 0;
        const root_slot = self.u32Slot(self.root_ptr_offset) catch return 0;
        var cur_raw = @atomicLoad(u32, root_slot, .acquire);
        if (cur_raw == 0) return 0;

        var depth: usize = 0;
        while (depth < prefix.len) {
            const ptr = ArtPtr{ .raw = cur_raw };
            if (ptr.getType() == .Leaf) {
                if (!self.leafInRange(ptr.getOffset(), prefix, lo, hi)) return 0;
                const leaf = self.nodeAt(ptr.getOffset(), Leaf) catch return 0;
                out[0] = @atomicLoad(u32, &leaf.value_offset, .acquire);
                return 1;
            }
            const child = self.childAt(ptr.getType(), ptr.getOffset(), prefix[depth]) catch return 0;
            if (child == 0) return 0;
            cur_raw = child;
            depth += 1;
        }

        const Frame = struct {
            raw: u32,
            pos: usize,
            depth: usize,
        };
        var stack: [MAX_DEPTH]Frame = undefined;
        var path: [MAX_DEPTH]u8 = undefined;
        var sp: usize = 1;
        stack[0] = .{ .raw = cur_raw, .pos = 0, .depth = prefix.len };
        var found: usize = 0;
        var budget: usize = MAX_SCAN_VISITS;

        while (sp > 0 and found < out.len and budget > 0) {
            budget -= 1;
            const top = &stack[sp - 1];
            const ptr = ArtPtr{ .raw = top.raw };
            if (ptr.getType() == .Leaf) {
                sp -= 1;
                if (!self.leafInRange(ptr.getOffset(), prefix, lo, hi)) continue;
                const leaf = self.nodeAt(ptr.getOffset(), Leaf) catch continue;
                out[found] = @atomicLoad(u32, &leaf.value_offset, .acquire);
                found += 1;
                continue;
            }
            // Prune subtrees provably above hi: every key below extends path,
            // so path > hi implies the whole subtree is out of range.
            if (hi.len > 0 and top.depth >= prefix.len) {
                const p = path[prefix.len..top.depth];
                if (std.mem.order(u8, p, hi) == .gt) {
                    sp -= 1;
                    continue;
                }
            }
            const child_depth = top.depth + 1;
            if (self.nextChild(ptr.getType(), ptr.getOffset(), &top.pos)) |c| {
                if (c.raw == 0) continue;
                if (sp >= MAX_DEPTH or child_depth >= MAX_DEPTH) break;
                path[top.depth] = c.byte;
                stack[sp] = .{ .raw = c.raw, .pos = 0, .depth = child_depth };
                sp += 1;
            } else {
                sp -= 1;
            }
        }
        return found;
    }

    /// True when the leaf key starts with `prefix` and its suffix is in bounds.
    fn leafInRange(self: *ArtIndex, leaf_off: u32, prefix: []const u8, lo: []const u8, hi: []const u8) bool {
        const leaf = self.nodeAt(leaf_off, Leaf) catch return false;
        if (leaf.key_len < prefix.len) return false;
        const stored = leafKeyBytes(self.arena_mem, leaf_off, leaf.key_len) catch return false;
        if (!std.mem.startsWith(u8, stored, prefix)) return false;
        return suffixInBounds(stored[prefix.len..], lo, hi);
    }

    /// Removes a key, returning true when a leaf was deleted. Fully emptied
    /// Node4/Node16 nodes are unlinked (never the root). Must NOT run
    /// concurrently with insert() on overlapping keys; concurrent search()
    /// may transiently miss during the operation.
    pub fn remove(self: *ArtIndex, key: []const u8) ArtError!bool {
        try validateKey(key);
        const root_slot = try self.u32Slot(self.root_ptr_offset);

        var attempt: u8 = 0;
        restart: while (true) {
            if (attempt >= MAX_DELETE_RETRIES) return error.LockContention;
            attempt += 1;

            var cur_raw = @atomicLoad(u32, root_slot, .acquire);
            if (cur_raw == 0) return false;

            // Legacy root leaf: compare and clear the root slot.
            const root_ptr = ArtPtr{ .raw = cur_raw };
            if (root_ptr.getType() == .Leaf) {
                const noff = root_ptr.getOffset();
                if (!(leafKeyEql(self.arena_mem, noff, key) catch false)) return false;
                if (@cmpxchgStrong(u32, root_slot, cur_raw, 0, .release, .monotonic) == null) return true;
                continue :restart;
            }

            // Record the slot holding each node along the path.
            var links: [MAX_DEPTH]*u32 = undefined;
            var raws: [MAX_DEPTH]u32 = undefined;
            var types: [MAX_DEPTH]NodeType = undefined;
            var level: usize = 0;
            var depth: usize = 0;

            links[0] = root_slot;
            raws[0] = cur_raw;
            const root_typed = ArtPtr{ .raw = cur_raw };
            types[0] = root_typed.getType();

            // Descend to the parent of the target leaf.
            while (true) {
                if (@atomicLoad(u32, links[level], .acquire) != cur_raw) continue :restart;
                const ptr = ArtPtr{ .raw = cur_raw };
                if (ptr.getType() == .Leaf) return error.UnsupportedNodeType; // Corrupt tree.
                const noff = ptr.getOffset();
                if (@as(usize, noff) >= self.arena_mem.len) return error.OutOfMemory;
                const slot_byte: u8 = if (depth < key.len) key[depth] else TERMINATOR;

                const child: u32 = switch (ptr.getType()) {
                    .Leaf => unreachable,
                    .Node4 => blk: {
                        const node = try self.nodeAt(noff, Node4);
                        if (node.count > 4) return error.UnsupportedNodeType;
                        const pos = node.findPos(slot_byte) orelse return false;
                        break :blk @atomicLoad(u32, &node.children[pos], .acquire);
                    },
                    .Node16 => blk: {
                        const node = try self.nodeAt(noff, Node16);
                        if (node.count > 16) return error.UnsupportedNodeType;
                        const pos = node.findPos(slot_byte) orelse return false;
                        break :blk @atomicLoad(u32, &node.children[pos], .acquire);
                    },
                    .Node48 => blk: {
                        const node = try self.nodeAt(noff, Node48);
                        if (node.count > 48) return error.UnsupportedNodeType;
                        const s = node.findSlot(slot_byte) orelse return false;
                        if (s >= node.count) return error.UnsupportedNodeType;
                        break :blk @atomicLoad(u32, &node.children[s], .acquire);
                    },
                    .Node256 => blk: {
                        const node = try self.nodeAt(noff, Node256);
                        break :blk @atomicLoad(u32, &node.children[slot_byte], .acquire);
                    },
                };
                if (child == 0) return false;
                const cart = ArtPtr{ .raw = child };
                if (cart.getType() == .Leaf) {
                    if (!(leafKeyEql(self.arena_mem, cart.getOffset(), key) catch false)) return false;
                    self.deleteChild(ptr.getType(), noff, slot_byte) catch continue :restart;
                    self.collapseEmpty(links[0 .. level + 1], raws[0 .. level + 1], types[0 .. level + 1]);
                    return true;
                }
                level += 1;
                if (level >= MAX_DEPTH) return error.InvalidKey;
                links[level] = self.childSlotPtr(ptr.getType(), noff, slot_byte) catch continue :restart;
                if (@atomicLoad(u32, links[level], .acquire) != child) continue :restart;
                raws[level] = child;
                types[level] = cart.getType();
                cur_raw = child;
                depth += 1;
            }
        }
    }

    /// Slot address holding `slot_byte` inside a node. Caller must have
    /// already confirmed the entry exists.
    fn childSlotPtr(self: *ArtIndex, ntype: NodeType, noff: u32, slot_byte: u8) ArtError!*u32 {
        switch (ntype) {
            .Node4 => {
                const node = try self.nodeAt(noff, Node4);
                const pos = node.findPos(slot_byte) orelse return error.OutOfMemory;
                return &node.children[pos];
            },
            .Node16 => {
                const node = try self.nodeAt(noff, Node16);
                const pos = node.findPos(slot_byte) orelse return error.OutOfMemory;
                return &node.children[pos];
            },
            .Node48 => {
                const node = try self.nodeAt(noff, Node48);
                const s = node.findSlot(slot_byte) orelse return error.OutOfMemory;
                return &node.children[s];
            },
            .Node256 => {
                const node = try self.nodeAt(noff, Node256);
                return &node.children[slot_byte];
            },
            .Leaf => return error.UnsupportedNodeType,
        }
    }

    /// Deletes the entry for slot_byte from an inner node (swap-remove).
    /// Shrinking is intentionally left out except via collapseEmpty.
    fn deleteChild(self: *ArtIndex, ntype: NodeType, noff: u32, slot_byte: u8) ArtError!void {
        switch (ntype) {
            .Node4 => {
                const node = try self.nodeAt(noff, Node4);
                const pos = node.findPos(slot_byte) orelse return error.OutOfMemory;
                const last = @as(usize, node.count) - 1;
                node.keys[pos] = node.keys[last];
                node.children[pos] = node.children[last];
                node.keys[last] = 0;
                node.children[last] = 0;
                @atomicStore(u8, &node.count, @as(u8, @intCast(last)), .release);
            },
            .Node16 => {
                const node = try self.nodeAt(noff, Node16);
                const pos = node.findPos(slot_byte) orelse return error.OutOfMemory;
                const last = @as(usize, node.count) - 1;
                node.keys[pos] = node.keys[last];
                node.children[pos] = node.children[last];
                node.keys[last] = 0;
                node.children[last] = 0;
                @atomicStore(u8, &node.count, @as(u8, @intCast(last)), .release);
            },
            .Node48 => {
                const node = try self.nodeAt(noff, Node48);
                const s = node.findSlot(slot_byte) orelse return error.OutOfMemory;
                const last = @as(usize, node.count) - 1;
                if (s != last) {
                    node.children[s] = node.children[last];
                    // Fix the index pointing at the moved slot.
                    var b: usize = 0;
                    while (b < 256) : (b += 1) {
                        if (node.child_index[b] == last + 1) {
                            node.child_index[b] = @as(u8, @intCast(s + 1));
                            break;
                        }
                    }
                }
                node.child_index[slot_byte] = 0;
                @atomicStore(u8, &node.count, @as(u8, @intCast(last)), .release);
            },
            .Node256 => {
                const node = try self.nodeAt(noff, Node256);
                @atomicStore(u32, &node.children[slot_byte], 0, .release);
                const c = @atomicLoad(u16, &node.count, .acquire);
                if (c > 0) @atomicStore(u16, &node.count, c - 1, .release);
            },
            .Leaf => return error.UnsupportedNodeType,
        }
    }

    /// Builds a fresh Node48 copying every occupied slot of a Node256
    /// (including TERMINATOR slot 0 via child_index rebuild). Returns the
    /// new node raw pointer. The caller swaps the parent link with CAS;
    /// the old Node256 is orphaned (leaked until a freelist is added),
    /// the same way the grow path orphans the old node.
    fn shrink256to48(self: *ArtIndex, noff: u32) ArtError!u32 {
        const src = try self.nodeAt(noff, Node256);
        const dst_off = try self.allocZeroed(@sizeOf(Node48));
        const dst = try self.nodeAt(dst_off, Node48);
        var slot: usize = 0;
        var b: usize = 0;
        while (b < 256) : (b += 1) {
            const child = @atomicLoad(u32, &src.children[b], .acquire);
            if (child != 0) {
                if (slot >= 48) return error.UnsupportedNodeType;
                dst.child_index[b] = @as(u8, @intCast(slot + 1));
                dst.children[slot] = child;
                slot += 1;
            }
        }
        dst.count = @as(u8, @intCast(slot));
        return ArtPtr.new(dst_off, .Node48).asRaw();
    }

    /// Builds a fresh Node16 copying every occupied entry of a Node48
    /// (including TERMINATOR byte 0x00). The old Node48 is orphaned on CAS
    /// success (leaked until a freelist is added), like the grow path.
    fn shrink48to16(self: *ArtIndex, noff: u32) ArtError!u32 {
        const src = try self.nodeAt(noff, Node48);
        const dst_off = try self.allocZeroed(@sizeOf(Node16));
        const dst = try self.nodeAt(dst_off, Node16);
        var n: usize = 0;
        var b: usize = 0;
        while (b < 256) : (b += 1) {
            const s = src.child_index[b];
            if (s != 0) {
                if (s > 48) return error.UnsupportedNodeType;
                const child = @atomicLoad(u32, &src.children[s - 1], .acquire);
                if (child == 0) continue;
                if (n >= 16) return error.UnsupportedNodeType;
                dst.keys[n] = @as(u8, @intCast(b));
                dst.children[n] = child;
                n += 1;
            }
        }
        dst.count = @as(u8, @intCast(n));
        return ArtPtr.new(dst_off, .Node16).asRaw();
    }

    /// Builds a fresh Node4 copying the occupied entries of a Node16
    /// (including TERMINATOR entries). The old Node16 is orphaned on CAS
    /// success (leaked until a freelist is added), like the grow path.
    fn shrink16to4(self: *ArtIndex, noff: u32) ArtError!u32 {
        const src = try self.nodeAt(noff, Node16);
        const c = @atomicLoad(u8, &src.count, .acquire);
        if (c > 4) return error.UnsupportedNodeType;
        const dst_off = try self.allocZeroed(@sizeOf(Node4));
        const dst = try self.nodeAt(dst_off, Node4);
        var i: usize = 0;
        while (i < c) : (i += 1) {
            dst.keys[i] = src.keys[i];
            dst.children[i] = @atomicLoad(u32, &src.children[i], .acquire);
        }
        dst.count = c;
        return ArtPtr.new(dst_off, .Node4).asRaw();
    }

    /// Unlinks fully emptied nodes bottom-up and shrinks underfull nodes
    /// in place at the same level via parent-link CAS. `links[i]` is the
    /// slot holding the node described by `raws[i]`/`types[i]`; links[0] is
    /// the root slot and is never cleared (an empty root is kept).
    /// ART levels are positional (level d indexes key[d]), so this never
    /// bypasses a level (no chain compression): it only swaps the node type
    /// at the same level. Shrinking orphans the old (bigger) node the same
    /// way the grow path does (leaked until a freelist/reclamation pass is
    /// added). Stops at the first concurrently modified level (link mismatch
    /// or CAS failure).
    fn collapseEmpty(self: *ArtIndex, links: []*u32, raws: []u32, types: []NodeType) void {
        var i: usize = links.len;
        while (i > 0) {
            i -= 1;
            const cur = @atomicLoad(u32, links[i], .acquire);
            if (cur != raws[i]) break; // Changed concurrently; stop.
            const ptr = ArtPtr{ .raw = cur };
            if (ptr.getType() != types[i]) break;
            const noff = ptr.getOffset();
            const is_root = (i == 0);
            switch (ptr.getType()) {
                .Node4 => {
                    const node = self.nodeAt(noff, Node4) catch break;
                    if (node.count != 0) break;
                    if (is_root) break; // Never clear the root slot.
                    if (@cmpxchgStrong(u32, links[i], cur, 0, .release, .monotonic) != null) break;
                },
                .Node16 => {
                    const node = self.nodeAt(noff, Node16) catch break;
                    const c = @atomicLoad(u8, &node.count, .acquire);
                    if (c == 0) {
                        if (is_root) break; // Never clear the root slot.
                        if (@cmpxchgStrong(u32, links[i], cur, 0, .release, .monotonic) != null) break;
                    } else if (c <= SHRINK_16_TO_4) {
                        const shrunk = self.shrink16to4(noff) catch break;
                        if (@cmpxchgStrong(u32, links[i], cur, shrunk, .release, .monotonic) != null) break;
                    } else break;
                },
                .Node48 => {
                    const node = self.nodeAt(noff, Node48) catch break;
                    const c = @atomicLoad(u8, &node.count, .acquire);
                    if (c == 0) {
                        if (is_root) break; // Never clear the root slot.
                        if (@cmpxchgStrong(u32, links[i], cur, 0, .release, .monotonic) != null) break;
                    } else if (c <= SHRINK_48_TO_16) {
                        const shrunk = self.shrink48to16(noff) catch break;
                        if (@cmpxchgStrong(u32, links[i], cur, shrunk, .release, .monotonic) != null) break;
                    } else break;
                },
                .Node256 => {
                    const node = self.nodeAt(noff, Node256) catch break;
                    const c = @atomicLoad(u16, &node.count, .acquire);
                    if (c == 0) {
                        if (is_root) break; // Never clear the root slot.
                        if (@cmpxchgStrong(u32, links[i], cur, 0, .release, .monotonic) != null) break;
                    } else if (c <= SHRINK_256_TO_48) {
                        const shrunk = self.shrink256to48(noff) catch break;
                        if (@cmpxchgStrong(u32, links[i], cur, shrunk, .release, .monotonic) != null) break;
                    } else break;
                },
                .Leaf => break,
            }
        }
    }
};

test "ART insert, search and overwrite" {
    var buf: [64 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    try idx.insert("hello", 100);
    try std.testing.expectEqual(@as(?u32, 100), idx.search("hello"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("hell"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("helloo"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("other"));

    // Overwrite keeps a single entry.
    try idx.insert("hello", 200);
    try std.testing.expectEqual(@as(?u32, 200), idx.search("hello"));
    try std.testing.expect(try idx.rootType() == .Node4);
}

test "ART prefix keys share terminator slots" {
    var buf: [64 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    try idx.insert("AB", 1);
    try idx.insert("ABC", 2);
    try idx.insert("ABCD", 3);
    try std.testing.expectEqual(@as(?u32, 1), idx.search("AB"));
    try std.testing.expectEqual(@as(?u32, 2), idx.search("ABC"));
    try std.testing.expectEqual(@as(?u32, 3), idx.search("ABCD"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("A"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("ABCDE"));

    try std.testing.expect(try idx.remove("ABC"));
    try std.testing.expectEqual(@as(?u32, null), idx.search("ABC"));
    try std.testing.expectEqual(@as(?u32, 1), idx.search("AB"));
    try std.testing.expectEqual(@as(?u32, 3), idx.search("ABCD"));
    try std.testing.expect(!(try idx.remove("ABC")));
}

test "ART grows Node4 -> Node16 -> Node48 -> Node256" {
    var buf: [512 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    // 17 single-byte keys force root growth 4 -> 16 -> 48.
    var i: u8 = 1;
    while (i <= 17) : (i += 1) {
        const k = [_]u8{i};
        try idx.insert(k[0..], @as(u32, 1000) + i);
    }
    try std.testing.expect(try idx.rootType() == .Node48);
    i = 1;
    while (i <= 17) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, @as(u32, 1000) + i), idx.search(k[0..]));
    }

    // 49 keys push the root to Node256.
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try idx.insert(k[0..], @as(u32, 1000) + i);
    }
    try std.testing.expect(try idx.rootType() == .Node256);
    i = 1;
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, @as(u32, 1000) + i), idx.search(k[0..]));
    }

    // Delete back down; remaining keys stay reachable.
    i = 1;
    while (i <= 40) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expect(try idx.remove(k[0..]));
    }
    i = 41;
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, @as(u32, 1000) + i), idx.search(k[0..]));
    }
}

test "ART rejects invalid keys and reports OOM" {
    var buf: [64 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    try std.testing.expectError(error.InvalidKey, idx.insert("", 1));
    try std.testing.expectError(error.InvalidKey, idx.insert("a\x00b", 1));
    var long: [257]u8 = undefined;
    @memset(&long, 'x');
    try std.testing.expectError(error.InvalidKey, idx.insert(long[0..], 1));
    try std.testing.expect(idx.search("") == null);

    var tiny: [32]u8 = undefined;
    @memset(&tiny, 0);
    var small = ArtIndex.init(tiny[0..], 0, 4, 8);
    try std.testing.expectError(error.OutOfMemory, small.insert("k", 1));
}

test "ART bulk insert/search 2000 keys" {
    var buf: [8 * 1024 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    var keybuf: [16]u8 = undefined;
    var n: usize = 0;
    while (n < 2000) : (n += 1) {
        const k = try std.fmt.bufPrint(keybuf[0..], "ID-{d:0>5}", .{n});
        try idx.insert(k, @as(u32, @intCast(5000 + n)));
    }
    n = 0;
    while (n < 2000) : (n += 1) {
        const k = try std.fmt.bufPrint(keybuf[0..], "ID-{d:0>5}", .{n});
        try std.testing.expectEqual(@as(?u32, @intCast(5000 + n)), idx.search(k));
    }
}

test "ART shrink root Node256 -> Node48 on delete" {
    var buf: [512 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    var i: u8 = 1;
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try idx.insert(k[0..], @as(u32, 1000) + i);
    }
    try std.testing.expect(try idx.rootType() == .Node256);

    // Delete to 30 remaining: 30 <= SHRINK_256_TO_48 (32) so root shrinks to Node48.
    i = 1;
    while (i <= 19) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expect(try idx.remove(k[0..]));
    }
    try std.testing.expect(try idx.rootType() == .Node48);
    i = 20;
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, @as(u32, 1000) + i), idx.search(k[0..]));
    }

    // Delete 40 total (9 remaining): 9 <= SHRINK_48_TO_16 (10) so it
    // cascades further to Node16. Remaining keys stay reachable.
    i = 20;
    while (i <= 40) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expect(try idx.remove(k[0..]));
    }
    try std.testing.expect(try idx.rootType() == .Node16);
    i = 41;
    while (i <= 49) : (i += 1) {
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, @as(u32, 1000) + i), idx.search(k[0..]));
    }

    // Delete-then-reinsert works after shrink (grows back).
    i = 1;
    while (i <= 40) : (i += 1) {
        const k = [_]u8{i};
        try idx.insert(k[0..], @as(u32, 2000) + i);
    }
    i = 1;
    while (i <= 49) : (i += 1) {
        const expected: u32 = if (i <= 40) @as(u32, 2000) + i else @as(u32, 1000) + i;
        const k = [_]u8{i};
        try std.testing.expectEqual(@as(?u32, expected), idx.search(k[0..]));
    }
}

test "ART shrink Node16 subtree -> Node4 on delete" {
    var buf: [64 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    // 5 two-byte keys sharing first byte 'Q' force the child to Node16.
    const prefix: u8 = 'Q';
    var j: u8 = 1;
    while (j <= 5) : (j += 1) {
        const k = [_]u8{ prefix, j };
        try idx.insert(k[0..], @as(u32, 3000) + j);
    }
    j = 1;
    while (j <= 5) : (j += 1) {
        const k = [_]u8{ prefix, j };
        try std.testing.expectEqual(@as(?u32, @as(u32, 3000) + j), idx.search(k[0..]));
    }

    // Delete 2 -> 3 remaining (<= SHRINK_16_TO_4) so the child shrinks to Node4.
    var d: u8 = 4;
    while (d <= 5) : (d += 1) {
        const k = [_]u8{ prefix, d };
        try std.testing.expect(try idx.remove(k[0..]));
    }
    j = 1;
    while (j <= 3) : (j += 1) {
        const k = [_]u8{ prefix, j };
        try std.testing.expectEqual(@as(?u32, @as(u32, 3000) + j), idx.search(k[0..]));
    }
    d = 4;
    while (d <= 5) : (d += 1) {
        const k = [_]u8{ prefix, d };
        try std.testing.expectEqual(@as(?u32, null), idx.search(k[0..]));
    }

    // Reinsert after shrink works.
    d = 4;
    while (d <= 5) : (d += 1) {
        const k = [_]u8{ prefix, d };
        try idx.insert(k[0..], @as(u32, 3100) + d);
    }
    j = 1;
    while (j <= 5) : (j += 1) {
        const expected: u32 = if (j <= 3) @as(u32, 3000) + j else @as(u32, 3100) + j;
        const k = [_]u8{ prefix, j };
        try std.testing.expectEqual(@as(?u32, expected), idx.search(k[0..]));
    }
}

test "ART shrink Node48 subtree on delete to few keys" {
    var buf: [128 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    // 20 entries sharing first byte 'X', including prefix key "X"
    // (terminator entry) to exercise terminator copying on shrink.
    try idx.insert("X", 4000);
    var j: u8 = 1;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        try idx.insert(k[0..], @as(u32, 4000) + j);
    }
    try std.testing.expectEqual(@as(?u32, 4000), idx.search("X"));
    j = 1;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        try std.testing.expectEqual(@as(?u32, @as(u32, 4000) + j), idx.search(k[0..]));
    }

    // Delete down to 2 keys: exercises 48 -> 16 -> 4 shrinking across removes.
    j = 2;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        try std.testing.expect(try idx.remove(k[0..]));
    }
    try std.testing.expectEqual(@as(?u32, 4000), idx.search("X"));
    {
        const k = [_]u8{ 'X', 1 };
        try std.testing.expectEqual(@as(?u32, 4001), idx.search(k[0..]));
    }
    j = 2;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        try std.testing.expectEqual(@as(?u32, null), idx.search(k[0..]));
    }

    // Reinsert after shrink works.
    j = 2;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        try idx.insert(k[0..], @as(u32, 4100) + j);
    }
    try std.testing.expectEqual(@as(?u32, 4000), idx.search("X"));
    j = 1;
    while (j <= 19) : (j += 1) {
        const k = [_]u8{ 'X', j };
        const expected: u32 = if (j == 1) @as(u32, 4001) else @as(u32, 4100) + j;
        try std.testing.expectEqual(@as(?u32, expected), idx.search(k[0..]));
    }
}

test "ART scanPrefix collects namespaced subtrees" {
    var buf: [256 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    try idx.insert("tbl:users:u1", 100);
    try idx.insert("tbl:users:u2", 200);
    try idx.insert("tbl:orders:o1", 300);
    // Prefix key "tbl:users" itself must also match via the terminator slot.
    try idx.insert("tbl:users", 50);

    var out: [8]u32 = undefined;
    const n = idx.scanPrefix("tbl:users", out[0..]);
    try std.testing.expectEqual(@as(usize, 3), n);
    std.mem.sort(u32, out[0..n], {}, comptime std.sort.asc(u32));
    try std.testing.expectEqualSlices(u32, &[_]u32{ 50, 100, 200 }, out[0..n]);

    const m = idx.scanPrefix("tbl:orders:", out[0..]);
    try std.testing.expectEqual(@as(usize, 1), m);
    try std.testing.expectEqual(@as(u32, 300), out[0]);

    // No match, empty/invalid prefixes, and zero-capacity output.
    try std.testing.expectEqual(@as(usize, 0), idx.scanPrefix("tbl:missing", out[0..]));
    try std.testing.expectEqual(@as(usize, 0), idx.scanPrefix("", out[0..]));
    try std.testing.expectEqual(@as(usize, 0), idx.scanPrefix("tbl:users", out[0..0]));

    // Truncation: cap 2 of 3 matches reports exactly 2.
    var tiny: [2]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 2), idx.scanPrefix("tbl:users", tiny[0..]));
}

test "ART scanPrefix over grown and shrunk trees" {
    var buf: [512 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    // 40 single-byte suffixes force root growth past Node48.
    var i: u8 = 1;
    while (i <= 40) : (i += 1) {
        const k = [_]u8{ 'k', i };
        try idx.insert(k[0..], @as(u32, 5000) + i);
    }
    var out: [64]u32 = undefined;
    const n = idx.scanPrefix("k", out[0..]);
    try std.testing.expectEqual(@as(usize, 40), n);

    // Delete most; remaining keys stay reachable via scan after shrink.
    i = 1;
    while (i <= 35) : (i += 1) {
        const k = [_]u8{ 'k', i };
        try std.testing.expect(try idx.remove(k[0..]));
    }
    const m = idx.scanPrefix("k", out[0..]);
    try std.testing.expectEqual(@as(usize, 5), m);
    std.mem.sort(u32, out[0..m], {}, comptime std.sort.asc(u32));
    try std.testing.expectEqualSlices(u32, &[_]u32{ 5036, 5037, 5038, 5039, 5040 }, out[0..m]);
}

test "ART scanRange bounds suffixes" {
    var buf: [256 * 1024]u8 = undefined;
    @memset(&buf, 0);
    var idx = ArtIndex.init(buf[0..], 0, 4, 8);

    var keybuf: [16]u8 = undefined;
    var n: usize = 0;
    while (n < 40) : (n += 1) {
        const k = try std.fmt.bufPrint(keybuf[0..], "r:{d:0>3}", .{n});
        try idx.insert(k, @as(u32, @intCast(6000 + n)));
    }
    try idx.insert("s:001", 9999);

    var out: [64]u32 = undefined;
    // Closed range over zero-padded suffixes.
    const m = idx.scanRange("r:", "005", "010", out[0..]);
    try std.testing.expectEqual(@as(usize, 6), m);
    std.mem.sort(u32, out[0..m], {}, comptime std.sort.asc(u32));
    try std.testing.expectEqualSlices(u32, &[_]u32{ 6005, 6006, 6007, 6008, 6009, 6010 }, out[0..m]);

    // Unbounded sides behave like a full prefix scan.
    try std.testing.expectEqual(@as(usize, 40), idx.scanRange("r:", "", "", out[0..]));
    try std.testing.expectEqual(@as(usize, 40), idx.scanRange("r:", "", "999", out[0..]));
    try std.testing.expectEqual(@as(usize, 40), idx.scanRange("r:", "000", "", out[0..]));

    // Degenerate and invalid inputs.
    try std.testing.expectEqual(@as(usize, 0), idx.scanRange("r:", "010", "005", out[0..]));
    try std.testing.expectEqual(@as(usize, 0), idx.scanRange("r:", "zzz", "zzz", out[0..]));
    try std.testing.expectEqual(@as(usize, 0), idx.scanRange("", "000", "999", out[0..]));
    var tiny: [3]u32 = undefined;
    try std.testing.expectEqual(@as(usize, 3), idx.scanRange("r:", "000", "039", tiny[0..]));
}
