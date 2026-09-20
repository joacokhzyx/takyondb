// ============================================================================
// File: ring_buffer.zig
// Description: Lock-free ring buffer for Zero-Copy IPC communication.
// Author/Maintainer: TakyonDB Team
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const layout = @import("../memory/layout.zig");

/// Cache line size to prevent false sharing in CPU caches (L1/L2).
const CACHE_LINE = 64;

/// DeltaMessage represents a raw memory mutation to be applied.
pub const DeltaMessage = struct {
    offset: u32,
    size: u32,
    is_arena: u8,
    pad: [7]u8 = [7]u8{ 0, 0, 0, 0, 0, 0, 0 },
    data: [48]u8, // Fixed size, padding struct to exactly 64 bytes total
};

pub const RingBuffer = struct {
    header: *Header,
    buffer: [*]DeltaMessage,
    seqs: [*]u64,
    capacity: usize,
    mask: usize,

    pub const Header = extern struct {
        head: usize align(CACHE_LINE),
        tail: usize align(CACHE_LINE),
        capacity: usize align(CACHE_LINE),
    };

    /// Initializes a RingBuffer over an existing shared memory segment.
    ///
    /// Classic Vyukov bounded MPMC (power-of-two capacity).
    /// Memory: [Header 192B][slots: capacity x DeltaMessage(64B)][seqs: capacity x u64].
    ///
    /// Arguments:
    ///   - `mem`: The pre-allocated shared memory slice (must start at RING_OFFSET).
    ///   - `capacity`: Maximum number of messages (must be >=2 and power-of-two).
    ///   - `is_master`: True if we should initialize the header (head/tail/capacity).
    ///     When false, the existing header capacity is reused; if it is zero
    ///     (autonomous fallback without a daemon) it is initialized to `capacity`.
    ///
    /// Returns:
    ///   - An initialized RingBuffer instance.
    ///
    /// Errors:
    ///   - `error.NoSpace` if `mem` is smaller than header + slots + seqs.
    ///   - `error.InvalidCapacity` if capacity is <2 or not a power of two.
    ///   - `error.Unaligned` if `mem` is not 64-byte aligned (the header
    ///     separates head/tail/capacity onto individual cache lines).
    pub fn init(mem: []u8, capacity: usize, is_master: bool) !RingBuffer {
        if (capacity < 2 or (capacity & (capacity - 1)) != 0) return error.InvalidCapacity;
        if (@intFromPtr(mem.ptr) % CACHE_LINE != 0) return error.Unaligned;
        if (mem.len < @sizeOf(Header)) return error.NoSpace;
        const header: *Header = @ptrCast(@alignCast(mem.ptr));
        var effective: usize = capacity;
        var do_init: bool = false;
        if (is_master) {
            header.head = 0;
            header.tail = 0;
            header.capacity = capacity;
            do_init = true;
        } else if (header.capacity == 0) {
            // Autonomous mode (no daemon created the header yet). Claim it
            // instead of leaving capacity as garbage.
            header.head = 0;
            header.tail = 0;
            header.capacity = capacity;
            do_init = true;
        } else {
            effective = header.capacity;
            if (effective < 2 or (effective & (effective - 1)) != 0) return error.InvalidCapacity;
        }
        const needed = layout.ringBytes(effective);
        if (mem.len < needed) return error.NoSpace;
        const buf_ptr: [*]DeltaMessage = @ptrCast(@alignCast(mem.ptr + @sizeOf(Header)));
        const seqs_ptr: [*]u64 = @ptrCast(@alignCast(mem.ptr + @sizeOf(Header) + effective * @sizeOf(DeltaMessage)));
        if (do_init) {
            var i: usize = 0;
            while (i < effective) : (i += 1) {
                seqs_ptr[i] = @as(u64, i);
            }
        }
        return RingBuffer{
            .header = header,
            .buffer = buf_ptr,
            .seqs = seqs_ptr,
            .capacity = effective,
            .mask = effective - 1,
        };
    }

    /// Approximate number of queued items (tail-head via atomics).
    pub fn depth(self: *const RingBuffer) usize {
        const head = @atomicLoad(usize, &self.header.head, .acquire);
        const tail = @atomicLoad(usize, &self.header.tail, .acquire);
        return tail - head;
    }

    /// Pushes a delta to the ring buffer (Vyukov MPMC).
    ///
    /// Arguments:
    ///   - `delta`: The mutation message.
    ///
    /// Returns:
    ///   - `true` if successful, `false` if the buffer is full.
    ///
    /// NOTE: full -> false (no header drop accounting; Header ABI unchanged,
    /// stats-in-header deferred). Callers must size capacity generously (see
    /// `layout.RING_DEFAULT_CAPACITY`) and retry on `false`.
    pub fn push(self: *RingBuffer, delta: DeltaMessage) bool {
        const cap = self.capacity;
        if (cap == 0) return false;
        const mask = self.mask;
        var pos = @atomicLoad(usize, &self.header.tail, .acquire);
        while (true) {
            const slot = pos & mask;
            const s = @atomicLoad(u64, &self.seqs[slot], .acquire);
            const pos_u64: u64 = @as(u64, pos);
            if (s == pos_u64) {
                const res = @cmpxchgStrong(usize, &self.header.tail, pos, pos + 1, .release, .monotonic);
                if (res == null) {
                    self.buffer[slot] = delta;
                    @atomicStore(u64, &self.seqs[slot], pos_u64 + 1, .release);
                    return true;
                } else {
                    pos = @atomicLoad(usize, &self.header.tail, .acquire);
                }
            } else if (s < pos_u64) {
                return false; // Buffer full
            } else {
                pos = @atomicLoad(usize, &self.header.tail, .acquire);
            }
        }
    }

    /// Pops a delta from the ring buffer (Vyukov MPMC).
    ///
    /// Returns:
    ///   - The `DeltaMessage` if available, or `null` if empty.
    pub fn pop(self: *RingBuffer) ?DeltaMessage {
        const cap = self.capacity;
        if (cap == 0) return null;
        const mask = self.mask;
        const cap_u64: u64 = @as(u64, cap);
        var pos = @atomicLoad(usize, &self.header.head, .acquire);
        while (true) {
            const slot = pos & mask;
            const s = @atomicLoad(u64, &self.seqs[slot], .acquire);
            const pos_u64: u64 = @as(u64, pos);
            if (s == pos_u64 + 1) {
                const res = @cmpxchgStrong(usize, &self.header.head, pos, pos + 1, .release, .monotonic);
                if (res == null) {
                    const msg = self.buffer[slot];
                    @atomicStore(u64, &self.seqs[slot], pos_u64 + cap_u64, .release);
                    return msg;
                } else {
                    pos = @atomicLoad(usize, &self.header.head, .acquire);
                }
            } else if (s < pos_u64 + 1) {
                return null; // Empty
            } else {
                pos = @atomicLoad(usize, &self.header.head, .acquire);
            }
        }
    }
};

// Wave-1 memory-map v2: the header footprint is owned by layout.zig.
// Fail the build (not production) if the struct ever drifts.
comptime {
    if (@sizeOf(RingBuffer.Header) != layout.RING_HEADER_BYTES) {
        @compileError("RingBuffer.Header size drifted from layout.RING_HEADER_BYTES");
    }
}

test "RingBuffer push and pop concurrency check" {
    var mem: [1024]u8 align(CACHE_LINE) = undefined;
    var rb = try RingBuffer.init(mem[0..], 4, true);

    const delta = DeltaMessage{ .offset = 0, .size = 4, .is_arena = 0, .data = undefined };
    const success = rb.push(delta);
    try std.testing.expect(success);

    const popped = rb.pop();
    try std.testing.expect(popped != null);
    try std.testing.expectEqual(@as(u32, 0), popped.?.offset);
}

test "RingBuffer wrap-around" {
    var mem: [4096]u8 align(CACHE_LINE) = undefined;
    var rb = try RingBuffer.init(mem[0..], 4, true);
    // Sequential push/pop 100 items (exercises counter wrap past capacity).
    var i: usize = 0;
    while (i < 100) : (i += 1) {
        const d = DeltaMessage{
            .offset = @as(u32, @intCast(i)),
            .size = @as(u32, @intCast(i)),
            .is_arena = 0,
            .data = [_]u8{0} ** 48,
        };
        try std.testing.expect(rb.push(d));
        const m = rb.pop();
        try std.testing.expect(m != null);
        try std.testing.expectEqual(@as(u32, @intCast(i)), m.?.offset);
    }
    try std.testing.expectEqual(@as(usize, 0), rb.depth());
    // Burst fill/drain 25 rounds x 4 slots = 100 items.
    var round: usize = 0;
    while (round < 25) : (round += 1) {
        var k: usize = 0;
        while (k < 4) : (k += 1) {
            const d = DeltaMessage{
                .offset = @as(u32, @intCast(round * 4 + k)),
                .size = 1,
                .is_arena = 0,
                .data = [_]u8{0} ** 48,
            };
            try std.testing.expect(rb.push(d));
        }
        // Full now.
        const full = DeltaMessage{ .offset = 0, .size = 1, .is_arena = 0, .data = [_]u8{0} ** 48 };
        try std.testing.expect(!rb.push(full));
        k = 0;
        while (k < 4) : (k += 1) {
            const m = rb.pop();
            try std.testing.expect(m != null);
            try std.testing.expectEqual(@as(u32, @intCast(round * 4 + k)), m.?.offset);
        }
        try std.testing.expect(rb.pop() == null);
    }
    try std.testing.expectEqual(@as(usize, 0), rb.depth());
}

test "RingBuffer rejects non-pow2 capacity" {
    var mem: [8192]u8 align(CACHE_LINE) = undefined;
    try std.testing.expectError(error.InvalidCapacity, RingBuffer.init(mem[0..], 3, true));
    try std.testing.expectError(error.InvalidCapacity, RingBuffer.init(mem[0..], 100000, true));
    try std.testing.expectError(error.InvalidCapacity, RingBuffer.init(mem[0..], 0, true));
    try std.testing.expectError(error.InvalidCapacity, RingBuffer.init(mem[0..], 1, true));
}

const StressCfg = struct {
    n_producers: usize = 4,
    n_consumers: usize = 2,
    per_producer: usize = 20000,
    capacity: usize = 4096,
};

const ProducerCtx = struct {
    rb: *RingBuffer,
    prod_id: u32,
    count: usize,
};

fn stressProducer(ctx: *ProducerCtx) void {
    var seq: usize = 0;
    while (seq < ctx.count) : (seq += 1) {
        const d = DeltaMessage{
            .offset = ctx.prod_id,
            .size = @as(u32, @intCast(seq)),
            .is_arena = 0,
            .data = [_]u8{0} ** 48,
        };
        while (!ctx.rb.push(d)) {
            std.Thread.yield() catch {};
        }
    }
}

const ConsumerCtx = struct {
    rb: *RingBuffer,
    seen: *[4][20000]bool,
    mutex: *std.Thread.Mutex,
    total: *std.atomic.Value(usize),
    expected: usize,
};

fn stressConsumer(ctx: *ConsumerCtx) void {
    while (ctx.total.load(.acquire) < ctx.expected) {
        if (ctx.rb.pop()) |msg| {
            const prod = msg.offset;
            const seq = msg.size;
            ctx.mutex.lock();
            // Validate and record; duplicates or out-of-range fail loudly.
            if (prod >= 4 or seq >= 20000) {
                ctx.mutex.unlock();
                std.debug.panic("MPMC stress: corrupt msg prod={d} seq={d}\n", .{ prod, seq });
            }
            if (ctx.seen[prod][seq]) {
                ctx.mutex.unlock();
                std.debug.panic("MPMC stress: duplicate prod={d} seq={d}\n", .{ prod, seq });
            }
            ctx.seen[prod][seq] = true;
            _ = ctx.total.fetchAdd(1, .release);
            ctx.mutex.unlock();
        } else {
            std.Thread.yield() catch {};
        }
    }
}

test "RingBuffer MPMC stress" {
    const cfg = StressCfg{};
    const total_expected = cfg.n_producers * cfg.per_producer;
    const bytes = layout.ringBytes(cfg.capacity);
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    const mem_raw = try arena.allocator().alloc(u8, bytes + 64);
    const mem_start = std.mem.alignForward(usize, @intFromPtr(mem_raw.ptr), 64);
    const mem = @as([*]u8, @ptrFromInt(mem_start))[0..bytes];
    var rb = try RingBuffer.init(mem, cfg.capacity, true);

    var seen: [4][20000]bool = undefined;
    for (&seen) |*row| {
        @memset(row, false);
    }
    var mutex = std.Thread.Mutex{};
    var total = std.atomic.Value(usize).init(0);

    var pctx: [4]ProducerCtx = undefined;
    for (&pctx, 0..) |*c, idx| {
        c.* = .{ .rb = &rb, .prod_id = @as(u32, @intCast(idx)), .count = cfg.per_producer };
    }
    var cctx: [2]ConsumerCtx = undefined;
    for (&cctx) |*c| {
        c.* = .{ .rb = &rb, .seen = &seen, .mutex = &mutex, .total = &total, .expected = total_expected };
    }

    var producers: [4]std.Thread = undefined;
    for (&producers, 0..) |*th, idx| {
        th.* = try std.Thread.spawn(.{}, stressProducer, .{&pctx[idx]});
    }
    var consumers: [2]std.Thread = undefined;
    for (&consumers, 0..) |*th, idx| {
        th.* = try std.Thread.spawn(.{}, stressConsumer, .{&cctx[idx]});
    }
    for (&producers) |*th| th.join();
    for (&consumers) |*th| th.join();

    try std.testing.expectEqual(total_expected, total.load(.acquire));
    for (seen, 0..) |row, p| {
        for (row, 0..) |v, s| {
            if (!v) {
                std.debug.print("missing prod={d} seq={d}\n", .{ p, s });
                try std.testing.expect(false);
            }
        }
    }
    try std.testing.expectEqual(@as(usize, 0), rb.depth());
}
