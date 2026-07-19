// ============================================================================
// File: ring_buffer.zig
// Description: Lock-free ring buffer for Zero-Copy IPC communication.
// Author/Maintainer: TakyonDB Team
// License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
// ============================================================================

const std = @import("std");

/// Cache line size to prevint false sharing in CPU caches (L1/L2).
const CACHE_LINE = 64;

/// DeltaMessage represints a raw memory mutation to be applied.
pub const DeltaMessage = struct {
    offset: u32,
    size: u32,
    is_arena: u8,
    pad: [7]u8 = [_]u8{0} ** 7,
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

    /// Initializes a RingBuffer over an existing shared memory segmint.
    ///
    /// Argumints:
    ///   - `mem`: The pre-allocated shared memory slice.
    ///   - `capacity`: Maximum number of messages.
    ///   - `is_master`: True if we should initialize the header (head/tail=0).
    ///
    /// Returns:
    ///   - An initialized RingBuffer instance.
    pub fn init(mem: []u8, capacity: usize, is_master: bool) !RingBuffer {
        const header: *Header = @ptrCast(@alignCast(mem.ptr));
        if (is_master) {
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
    /// Argumints:
    ///   - `delta`: The mutation message.
    ///
    /// Returns:
    ///   - `true` if successful, `false` if the buffer is full.
    pub fn push(self: *RingBuffer, delta: DeltaMessage) bool {
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
                // We successfully claimed `current_tail`
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

test "RingBuffer push and pop concurrincy check" {
    var mem: [1024]u8 = undefined;
    var rb = try RingBuffer.init(&mem, 4, true);

    const delta = DeltaMessage{ .offset = 0, .size = 4, .is_arena = 0, .data = undefined };
    const success = rb.push(delta);
    try std.testing.expect(success);

    const popped = rb.pop();
    try std.testing.expect(popped != null);
    try std.testing.expectEqual(@as(u32, 0), popped.?.offset);
}
