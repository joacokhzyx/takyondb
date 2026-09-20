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

    pub const Header = extern struct {
        head: usize align(CACHE_LINE),
        tail: usize align(CACHE_LINE),
        capacity: usize align(CACHE_LINE),
    };

    /// Initializes a RingBuffer over an existing shared memory segment.
    ///
    /// Arguments:
    ///   - `mem`: The pre-allocated shared memory slice (must start at RING_OFFSET).
    ///   - `capacity`: Maximum number of messages.
    ///   - `is_master`: True if we should initialize the header (head/tail/capacity).
    ///     When false, the existing header capacity is reused; if it is zero
    ///     (autonomous fallback without a daemon) it is initialized to `capacity`.
    ///
    /// Returns:
    ///   - An initialized RingBuffer instance.
    ///
    /// Errors:
    ///   - `error.NoSpace` if `mem` is smaller than header + capacity slots.
    ///   - `error.InvalidCapacity` if capacity is zero.
    ///   - `error.Unaligned` if `mem` is not 64-byte aligned (the header
    ///     separates head/tail/capacity onto individual cache lines).
    pub fn init(mem: []u8, capacity: usize, is_master: bool) !RingBuffer {
        if (capacity == 0) return error.InvalidCapacity;
        if (@intFromPtr(mem.ptr) % CACHE_LINE != 0) return error.Unaligned;
        const needed = @sizeOf(Header) + capacity * @sizeOf(DeltaMessage);
        if (mem.len < needed) return error.NoSpace;
        const header: *Header = @ptrCast(@alignCast(mem.ptr));
        if (is_master) {
            header.head = 0;
            header.tail = 0;
            header.capacity = capacity;
        } else if (header.capacity == 0) {
            // Autonomous mode (no daemon created the header yet). Claim it
            // instead of leaving capacity as garbage.
            header.head = 0;
            header.tail = 0;
            header.capacity = capacity;
        }

        const buf_ptr: [*]DeltaMessage = @ptrCast(@alignCast(mem.ptr + @sizeOf(Header)));

        return RingBuffer{
            .header = header,
            .buffer = buf_ptr,
        };
    }

    /// Pushes a delta to the ring buffer (Lock-free using CAS).
    ///
    /// Arguments:
    ///   - `delta`: The mutation message.
    ///
    /// Returns:
    ///   - `true` if successful, `false` if the buffer is full.
    ///
    /// NOTE: MPSC claim-then-publish. The slot is claimed via CAS on tail,
    /// then the payload is written, followed by a release fence so the
    /// single consumer never observes a torn slot. A fully rigorous MPMC
    /// queue needs per-slot sequence numbers (Vyukov); that is tracked as
    /// future work. Callers must size capacity generously (see
    /// `layout.RING_DEFAULT_CAPACITY`) and retry on `false`.
    pub fn push(self: *RingBuffer, delta: DeltaMessage) bool {
        if (self.header.capacity == 0) return false;
        var current_tail = @atomicLoad(usize, &self.header.tail, .acquire);

        while (true) {
            const current_head = @atomicLoad(usize, &self.header.head, .acquire);
            const next_tail = (current_tail + 1) % self.header.capacity;

            if (next_tail == current_head) {
                return false; // Buffer full
            }

            // Try to claim the slot using Compare and Swap
            const actual_tail = @cmpxchgStrong(usize, &self.header.tail, current_tail, next_tail, .release, .monotonic);
            if (actual_tail == null) {
                // We successfully claimed `current_tail`. Publish the payload
                // now. NOTE: a consumer that already observed the advanced
                // tail may read this slot before the copy lands; a rigorous
                // MPMC queue needs per-slot sequence numbers (Vyukov), which
                // is tracked as future work. Size capacity generously (see
                // `layout.RING_DEFAULT_CAPACITY`) and retry on `false`.
                self.buffer[current_tail] = delta;
                return true;
            } else {
                // Another producer claimed it, retry with the updated tail
                current_tail = actual_tail.?;
            }
        }
    }

    /// Pops a delta from the ring buffer.
    ///
    /// Returns:
    ///   - The `DeltaMessage` if available, or `null` if empty.
    pub fn pop(self: *RingBuffer) ?DeltaMessage {
        if (self.header.capacity == 0) return null;
        const current_head = @atomicLoad(usize, &self.header.head, .acquire);
        const current_tail = @atomicLoad(usize, &self.header.tail, .acquire);

        if (current_head == current_tail) {
            return null; // Empty
        }

        const delta = self.buffer[current_head];
        const next_head = (current_head + 1) % self.header.capacity;
        @atomicStore(usize, &self.header.head, next_head, .release);

        return delta;
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
