// ============================================================================
// File: snapshot.zig
// Description: Memory Snapshot generator for fast cold-starts.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");
const layout = @import("../memory/layout.zig");
const art = @import("../index/art.zig");
const WalManager = @import("wal.zig").WalManager;
const RingBuffer = @import("../ipc/ring_buffer.zig").RingBuffer;

// Coordinate with the layout-v2 agent: these WILL exist in layout.zig.
// Fallbacks below use identical values so this file compiles in parallel.
const MAGIC_OFFSET: usize = if (@hasDecl(layout, "MAGIC_OFFSET")) layout.MAGIC_OFFSET else 0;
const VERSION_OFFSET: usize = if (@hasDecl(layout, "VERSION_OFFSET")) layout.VERSION_OFFSET else 4;
const LAYOUT_VERSION: u32 = if (@hasDecl(layout, "LAYOUT_VERSION")) layout.LAYOUT_VERSION else 2;
const FOOTER_MAGIC: u32 = if (@hasDecl(layout, "ARENA_MAGIC")) layout.ARENA_MAGIC else 0x54414B59;

/// Every I/O unit of a snapshot file, payload and footer alike. Direct I/O
/// refuses anything else, so the payload is padded to a multiple of this.
pub const BLOCK: usize = 4096;

// ============================================================================
// On-disk snapshot format
// ============================================================================
//
// A snapshot is a sequence of `BLOCK`-sized blocks: the payload, then one
// footer block. The payload is the concatenation of the arena's IN-USE
// extents (below), packed with no padding between them; only the final
// payload block is zero-padded to a block boundary. The footer block is
// also the last thing read and the first thing validated, which is why it
// holds everything needed to interpret the payload.
//
//   v1  crc[0..4], active_len[4..8], zero tail. No magic, no version.
//   v2  magic, version (= arena LAYOUT_VERSION), crc, active_len,
//       art_bump, str_bump, zero tail. Payload: ONE contiguous arena
//       prefix [0, active_len) rounded up to a block.
//   v3  magic, format_version, crc, layout_version, flags, then the
//       length of each of the EXTENT_COUNT extents, zero tail. Payload:
//       those extents, packed.
//
// v2 -> v3 is breaking and the version word is the only thing that says so:
// in v2 the three words after the CRC are active_len / art_bump /
// str_bump, in v3 they are extent lengths. Reinterpreting a v2 footer
// under v3 rules would restore a plausible-looking arena at wrong offsets
// (and would have kept writing 10 MB per checkpoint for an empty
// database), so recovery rejects v2 by version, loudly. v1 is rejected
// too, as it always was: it has no magic to check at all.
//
// This file is the definition of that format; recovery.zig imports the
// constants so the reader cannot drift from the writer.
pub const SNAPSHOT_VERSION: u32 = 3;
/// The last contiguous-prefix format. Named only so recovery can report
/// "your snapshot is a v2, delete it or downgrade" instead of a generic
/// mismatch. This build does not read it.
pub const CONTIGUOUS_V2_VERSION: u32 = 2;

/// One contiguous run of arena bytes a snapshot carries. `len == 0` means
/// the region has nothing in use and contributes no payload at all.
pub const Extent = struct {
    start: u32,
    len: u32,

    pub fn end(self: Extent) u32 {
        return self.start + self.len;
    }
};

/// Extent indices. This is also the on-disk order, so extent `i`'s length
/// is footer word `FOOTER_FIRST_LEN_OFF + 4*i`.
pub const EXT_HDR: usize = 0;
pub const EXT_REC: usize = 1;
pub const EXT_ART: usize = 2;
pub const EXT_STR: usize = 3;
pub const EXTENT_COUNT: usize = 4;

/// First byte of each extent.
///
/// Three of the four are bump words (for the ART, the root word that sits
/// immediately before its bump), so each extent runs from its region's own
/// bookkeeping word up to that region's bump. Carrying the bump word
/// inside the extent is what makes the allocator state itself survive: a
/// snapshot that restored only the data bytes would come back with a bump
/// pointing at whatever the arena happened to hold.
///
/// The fourth is the global header, a fixed GLOBAL_RESERVED bytes. It is
/// not a bump region, but it IS reachable from the write path:
/// `takyon_notify_arena` bounds-checks a delta only against the arena
/// length, so a logged write into [0, RING_OFFSET) exists, and dropping
/// it would turn that write into silent loss once the WAL is truncated.
///
/// The ring region [RING_OFFSET, RECORD_BUMP_OFFSET) is deliberately NOT
/// an extent. It is the IPC channel rather than data, it is a quarter of
/// a megabyte of padding and seq counters, and recovery's finalize()
/// already zeroes all of it. Writing it out and then zeroing it on the
/// way back in would be pure waste.
/// First byte of each extent, for a given region table. Layout version 3
/// made these runtime values: the extent boundaries are the same numbers
/// the header carries, so a snapshot and the arena it came from cannot
/// disagree about where a region begins.
pub fn extentStarts(regions: layout.Regions) [EXTENT_COUNT]usize {
    return .{
        0, // global header: [0, RING_OFFSET)
        regions.recordBumpOffset(), // record bump word + records
        regions.art_root, // ART root + ART bump word + ART nodes
        regions.string_start, // string bump word + string bytes
    };
}

/// Smallest non-zero length each extent can have: the bytes between a
/// region's bookkeeping word and its first allocation (the header is a
/// fixed GLOBAL_RESERVED bytes and is always all of it or nothing). The
/// writer cannot produce anything shorter, so a footer claiming one is
/// corrupt and is refused rather than half-restored.
pub fn extentMinLens(regions: layout.Regions) [EXTENT_COUNT]u32 {
    return .{
        @intCast(layout.RING_OFFSET),
        // The record bump word up to the first record byte. Derived rather
        // than fixed at 8: `record_start` is a configured value, and a
        // constant here would refuse a legitimate table.
        @intCast(regions.record_start - regions.recordBumpOffset()),
        8, // ART root + ART bump word, up to the first node
        4, // string bump word, up to the first payload byte
    };
}

// Footer word offsets. MAGIC_OFFSET/VERSION_OFFSET (layout-v2) coincide
// with the first two, which is why they are used for those words.
const FOOTER_MAGIC_OFF: usize = MAGIC_OFFSET;
const FOOTER_VERSION_OFF: usize = VERSION_OFFSET;
const FOOTER_CRC_OFF: usize = 8;
const FOOTER_LAYOUT_OFF: usize = 12;
const FOOTER_FLAGS_OFF: usize = 16;
/// First footer word holding an extent length; extent `i` is at
/// `FOOTER_FIRST_LEN_OFF + 4*i`.
pub const FOOTER_FIRST_LEN_OFF: usize = 20;
/// First footer word holding the region table, in the same order as
/// `layout.Regions`: arena_bytes, ring_capacity, record_start,
/// record_bytes, art_root, art_bytes, string_start, string_bytes.
///
/// This is the reason a snapshot has to carry the table and not just the
/// lengths. The lengths say how much of each region is in use; without the
/// boundaries there is no way to know where to put those bytes back, and
/// guessing from this build's constants would restore a snapshot taken on a
/// differently-configured arena into the wrong offsets. Recovery refuses a
/// snapshot whose table is not the one it is restoring into.
pub const FOOTER_REGIONS_OFF: usize = FOOTER_FIRST_LEN_OFF + 4 * EXTENT_COUNT;
/// Words of region table in the footer.
pub const FOOTER_REGION_WORDS: usize = 8;
/// First byte of a v3 footer that must be zero. v2's zero tail starts at
/// 24, v1's at 8, so the tail length alone tells the shapes apart.
pub const FOOTER_V3_TAIL_OFF: usize = FOOTER_REGIONS_OFF + 4 * FOOTER_REGION_WORDS;
/// Zero tail of a v2 (contiguous prefix) footer.
pub const FOOTER_V2_TAIL_OFF: usize = 24;
/// Zero tail of a v1 footer: it had no magic, no version and no flags.
pub const FOOTER_V1_TAIL_OFF: usize = 8;

comptime {
    if (FOOTER_V3_TAIL_OFF > BLOCK) @compileError("v3 footer no longer fits in one block");
    if (FOOTER_V3_TAIL_OFF <= FOOTER_V2_TAIL_OFF) @compileError("v3 and v2 footers must have different zero tails");
}

fn readBump(arena_mem: []const u8, offset: usize, fallback: u32) u32 {
    if (offset + 4 > arena_mem.len) return fallback;
    const v = @as(*const u32, @ptrCast(@alignCast(arena_mem.ptr + offset))).*;
    if (v > arena_mem.len) return fallback;
    return v;
}

/// The in-use extent of one bump-allocated region: from the region's
/// bookkeeping word up to its bump.
///
/// Yields a zero-length extent (not a bogus one) when the arena is too
/// small to hold the bump word, or when the stored bump is at or below
/// the region's first byte. The second case is what a still-zeroed bump
/// word looks like before the allocator has ever run, and it must not
/// underflow the length.
/// Writes the region table into a footer block, in `layout.Regions` field
/// order. The order is a contract with `readFooterRegions` and with the
/// reader in recovery.zig; both sides name the fields, never the numbers.
fn writeFooterRegions(buf: []u8, regions: layout.Regions) void {
    const words = [_]u32{
        regions.arena_bytes,  regions.ring_capacity, regions.record_start,
        regions.record_bytes, regions.art_root,      regions.art_bytes,
        regions.string_start, regions.string_bytes,
    };
    for (words, 0..) |w, i| {
        std.mem.writeInt(u32, buf[FOOTER_REGIONS_OFF + 4 * i ..][0..4], w, .little);
    }
}

/// Reads the region table out of a footer block.
pub fn readFooterRegions(footer: []const u8) ?layout.Regions {
    if (footer.len < FOOTER_V3_TAIL_OFF) return null;
    return .{
        .arena_bytes = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 0 ..][0..4], .little),
        .ring_capacity = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 4 ..][0..4], .little),
        .record_start = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 8 ..][0..4], .little),
        .record_bytes = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 12 ..][0..4], .little),
        .art_root = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 16 ..][0..4], .little),
        .art_bytes = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 20 ..][0..4], .little),
        .string_start = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 24 ..][0..4], .little),
        .string_bytes = std.mem.readInt(u32, footer[FOOTER_REGIONS_OFF + 28 ..][0..4], .little),
    };
}

fn bumpExtent(arena_mem: []const u8, starts: [EXTENT_COUNT]usize, region: usize, word_offset: usize, init: u32) Extent {
    const start: u32 = @intCast(starts[region]);
    if (word_offset + 4 > arena_mem.len) return .{ .start = start, .len = 0 };
    const bump = readBump(arena_mem, word_offset, init);
    if (bump <= start or bump > arena_mem.len) return .{ .start = start, .len = 0 };
    return .{ .start = start, .len = bump - start };
}

/// The extents a snapshot of `arena_mem` must carry, in on-disk order.
///
/// The previous design took one length, `max(record, art, string)` bump,
/// and copied the arena prefix up to it. For an idle database that is
/// STRING_DATA_START, ~10.5 MB of pure zeros per checkpoint: 15.1 GB/day
/// of writes for a database holding nothing. The three bumps are
/// independent, so the extents are computed per region and an empty
/// database costs 1 KiB (the header) + 20 bytes of bump words.
pub fn snapshotExtents(arena_mem: []const u8, regions: layout.Regions) [EXTENT_COUNT]Extent {
    const starts = extentStarts(regions);
    var ext: [EXTENT_COUNT]Extent = undefined;
    ext[EXT_HDR] = if (arena_mem.len >= layout.RING_OFFSET)
        .{ .start = 0, .len = @intCast(layout.RING_OFFSET) }
    else
        .{ .start = 0, .len = 0 };
    ext[EXT_REC] = bumpExtent(arena_mem, starts, EXT_REC, regions.recordBumpOffset(), regions.record_start);
    ext[EXT_ART] = bumpExtent(arena_mem, starts, EXT_ART, regions.artBumpOffset(), @intCast(regions.artStart()));
    ext[EXT_STR] = bumpExtent(arena_mem, starts, EXT_STR, regions.string_start, @intCast(regions.stringDataStart()));
    return ext;
}

/// Payload bytes before block padding.
pub fn payloadBytes(ext: [EXTENT_COUNT]Extent) usize {
    var total: usize = 0;
    for (ext) |e| total += e.len;
    return total;
}

/// Blocks the payload occupies once padded.
pub fn payloadBlocks(payload: usize) usize {
    return (payload + BLOCK - 1) / BLOCK;
}

/// Renders the payload block that starts at payload offset `at` into
/// `out`, which is zero-filled first so the final block's tail is zeros.
///
/// The walk is the definition of the packed layout: extent `i` occupies
/// payload bytes [sum of the previous lengths, +len). recovery.zig's
/// `placePayloadBlock` is the mirror image of this function, and the
/// snapshot/recovery round-trip test is what keeps them in step.
pub fn renderPayloadBlock(arena_mem: []const u8, ext: [EXTENT_COUNT]Extent, at: usize, out: []u8) void {
    @memset(out, 0);
    const block_end = at + out.len;
    var p0: usize = 0;
    for (ext) |e| {
        const p1 = p0 + e.len;
        if (p1 > at and p0 < block_end and e.len != 0) {
            const from = @max(at, p0);
            const to = @min(block_end, p1);
            const src = @as(usize, e.start) + (from - p0);
            @memcpy(out[from - at ..][0 .. to - from], arena_mem[src..][0 .. to - from]);
        }
        p0 = p1;
        if (p0 >= block_end) break;
    }
}

/// Minimum interval between successful snapshots (milliseconds). Settable;
/// tests that call createSnapshot more than once in a process set it to 0
/// so the process-wide throttle below cannot skip the second call.
pub var minIntervalMs: i64 = 5000;

/// Timestamp (std.time.milliTimestamp) of the last successful snapshot;
/// -1 means none yet. File-scope by design: the flusher is the sole
/// caller, so no locking is needed.
var last_snapshot_ms: i64 = -1;

fn writeAllPosix(fd: std.posix.fd_t, buf: []const u8) !void {
    var off: usize = 0;
    while (off < buf.len) {
        const n = std.c.write(fd, buf.ptr + off, buf.len - off);
        if (n < 0) {
            const errno_val = std.c._errno().*;
            if (errno_val == @intFromEnum(std.posix.E.INVAL)) return error.DirectUnsupported;
            return error.WriteFailed;
        }
        if (n == 0) return error.WriteFailed;
        off += @as(usize, @intCast(n));
    }
}

fn syncPosix(fd: std.posix.fd_t) void {
    std.posix.fsync(fd) catch {};
    // Fsync the containing directory so the rename/truncate is durable.
    // Best effort: failures here must not fail the snapshot.
    const dir = std.c.open(".", std.posix.O{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
    if (dir >= 0) {
        std.posix.fsync(@as(std.posix.fd_t, dir)) catch {};
        _ = std.c.close(dir);
    }
}

pub fn createSnapshot(arena_mem: []const u8, wal: *WalManager, ring_buffer: *RingBuffer, regions: layout.Regions) !void {
    // Throttle: return early (log + return, NOT an error) when called
    // sooner than minIntervalMs after the last success.
    {
        const now = std.time.milliTimestamp();
        if (last_snapshot_ms >= 0 and now - last_snapshot_ms < minIntervalMs) {
            std.debug.print("[TakyonDB-Snapshot] Throttled ({} ms since last); skipping.\n", .{now - last_snapshot_ms});
            return;
        }
    }
    // Drain queued deltas into the WAL first: the snapshot must cover every
    // acknowledged write, and the WAL is truncated right after.
    var drained: usize = 0;
    while (ring_buffer.pop()) |pending| {
        if (pending.is_arena == 2) continue;
        wal.processDelta(pending, arena_mem) catch |err| {
            std.debug.print("[TakyonDB-Snapshot] Dropped delta during drain: {}\n", .{err});
        };
        drained += 1;
        if (drained > 1_000_000) break;
    }
    try wal.flushBuffer();

    const extents = snapshotExtents(arena_mem, regions);
    const payload = payloadBytes(extents);
    const blocks = payloadBlocks(payload);
    std.debug.print(
        "[TakyonDB-Snapshot] Generating snapshot: {d} in-use byte(s) in {d} block(s) (hdr={d} rec={d} art={d} str={d})...\n",
        .{ payload, blocks, extents[EXT_HDR].len, extents[EXT_REC].len, extents[EXT_ART].len, extents[EXT_STR].len },
    );

    // We allocate an aligned 4KB buffer for direct I/O
    const allocator = std.heap.page_allocator;
    const raw = try allocator.alloc(u8, 8192);
    defer allocator.free(raw);
    const addr = @intFromPtr(raw.ptr);
    const aligned_addr = (addr + 4095) & ~@as(usize, 4095);
    const buf = @as([*]u8, @ptrFromInt(aligned_addr))[0..BLOCK];

    // Derive snapshot + tmp paths from the WAL path (no hardcoding).
    // wal.path is an owned [:0]u8 (see wal.zig); stack buffers are fine
    // because WalManager dupes on init and we only borrow here.
    var snap_buf: [4096]u8 = undefined;
    const snap_path = try std.fmt.bufPrintZ(&snap_buf, "{s}.snap", .{wal.path});
    var tmp_buf: [4096]u8 = undefined;
    const tmp_path = try std.fmt.bufPrintZ(&tmp_buf, "{s}.snap.tmp", .{snap_path});

    var fd: ?(if (builtin.os.tag == .windows) std.os.windows.HANDLE else std.posix.fd_t) = null;
    var use_direct = true;
    if (builtin.os.tag == .windows) {
        var path_w: [1024]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, tmp_path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0x40000000))), // GENERIC_WRITE
            0, // No sharing
            null,
            2, // CREATE_ALWAYS
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null,
        );
        if (handle == std.os.windows.INVALID_HANDLE_VALUE) {
            std.debug.print("[TakyonDB-Snapshot] Error creating snapshot.\n", .{});
            return error.FileCreateError;
        }
        fd = handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true, .DIRECT = true }
        else
            std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
        const raw_fd = std.c.open(tmp_path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) {
            // Retry without DIRECT (filesystems like tmpfs reject it).
            const plain = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
            const retry = std.c.open(tmp_path.ptr, plain, @as(c_uint, 0o644));
            if (retry < 0) return error.FileCreateError;
            fd = @as(std.posix.fd_t, retry);
            use_direct = false;
        } else {
            fd = @as(std.posix.fd_t, raw_fd);
        }
    }
    const Crc32 = if (@hasDecl(std.hash.crc, "Crc32"))
        std.hash.crc.Crc32
    else if (@hasDecl(std.hash.crc, "Crc32Ieee"))
        std.hash.crc.Crc32Ieee
    else
        std.hash.Crc32;

    var hasher = Crc32.init();

    // Payload: the extents, packed. `at` is a payload offset, not an arena
    // offset, so the retry below restarts the whole payload and the hash
    // rather than resuming mid-stream.
    var at: usize = 0;
    while (at < payload) {
        renderPayloadBlock(arena_mem, extents, at, buf);

        // Hash payload
        hasher.update(buf);

        if (builtin.os.tag == .windows) {
            var written: std.os.windows.DWORD = 0;
            if (std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, BLOCK, &written, null) == 0 or written != BLOCK) {
                _ = std.os.windows.CloseHandle(fd.?);
                return error.WriteFailed;
            }
        } else {
            writeAllPosix(fd.?, buf) catch |err| {
                if (err == error.DirectUnsupported and use_direct) {
                    // Reopen buffered and restart the snapshot.
                    _ = std.c.close(fd.?);
                    const plain = std.posix.O{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true };
                    const retry = std.c.open(tmp_path.ptr, plain, @as(c_uint, 0o644));
                    if (retry < 0) return error.FileCreateError;
                    fd = @as(std.posix.fd_t, retry);
                    use_direct = false;
                    at = 0;
                    hasher = Crc32.init();
                    continue;
                }
                _ = std.c.close(fd.?);
                return err;
            };
        }
        at += BLOCK;
    }

    // Footer v3 in the final 4K block:
    //   magic u32 [0..4], format version u32 [4..8], crc u32 [8..12],
    //   arena layout version u32 [12..16], flags u32 [16..20],
    //   then one u32 length per extent [20..36], rest zeros.
    // The lengths, not starts: an extent always begins at its layout
    // constant, so a start would be a second source of truth for a
    // constant the arena already owns.
    @memset(buf, 0);
    const final_crc = hasher.final();
    std.mem.writeInt(u32, buf[FOOTER_MAGIC_OFF..][0..4], FOOTER_MAGIC, .little);
    std.mem.writeInt(u32, buf[FOOTER_VERSION_OFF..][0..4], SNAPSHOT_VERSION, .little);
    std.mem.writeInt(u32, buf[FOOTER_CRC_OFF..][0..4], final_crc, .little);
    std.mem.writeInt(u32, buf[FOOTER_LAYOUT_OFF..][0..4], LAYOUT_VERSION, .little);
    std.mem.writeInt(u32, buf[FOOTER_FLAGS_OFF..][0..4], 0, .little);
    for (extents, 0..) |e, i| {
        std.mem.writeInt(u32, buf[FOOTER_FIRST_LEN_OFF + 4 * i ..][0..4], e.len, .little);
    }
    writeFooterRegions(buf, regions);

    if (builtin.os.tag == .windows) {
        var written: std.os.windows.DWORD = 0;
        if (std.os.windows.kernel32.WriteFile(fd.?, buf.ptr, BLOCK, &written, null) == 0 or written != BLOCK) {
            _ = std.os.windows.CloseHandle(fd.?);
            return error.WriteFailed;
        }
        _ = std.os.windows.kernel32.FlushFileBuffers(fd.?);
        _ = std.os.windows.CloseHandle(fd.?);
    } else {
        writeAllPosix(fd.?, buf) catch {
            _ = std.c.close(fd.?);
            return error.WriteFailed;
        };
        // Sync data AND directory before rotating the WAL: a snapshot that
        // is still in the page cache is worthless after a crash.
        syncPosix(fd.?);
        _ = std.c.close(fd.?);
    }
    fd = null;

    // Atomically publish tmp -> final so a crash never leaves a torn snap.
    // POSIX rename(2) is atomic. Windows cannot atomically replace via
    // rename: delete the destination first, then rename.
    // WINDOWS CRASH WINDOW: if we crash between delete and rename, the
    // snapshot is missing but the WAL is still intact (it is truncated
    // only below, after a successful rename), so recovery falls back to
    // WAL-only replay and stays correct.
    if (builtin.os.tag == .windows) {
        std.fs.cwd().deleteFile(snap_path) catch {};
    }
    std.fs.cwd().rename(tmp_path, snap_path) catch |err| {
        std.fs.cwd().deleteFile(tmp_path) catch {};
        std.debug.print("[TakyonDB-Snapshot] Atomic publish failed: {}\n", .{err});
        return error.RenameFailed;
    };
    // Best-effort directory fsync so the rename is durable (POSIX only;
    // the whole block is comptime-skipped on Windows where std.c.open
    // takes a void O and would not compile).
    if (builtin.os.tag != .windows) {
        const dir = std.c.open(".", std.posix.O{ .ACCMODE = .RDONLY }, @as(c_uint, 0));
        if (dir >= 0) {
            std.posix.fsync(@as(std.posix.fd_t, dir)) catch {};
            _ = std.c.close(dir);
        }
    }

    std.debug.print("[TakyonDB-Snapshot] Snapshot saved and validated. Rotating WAL...\n", .{});

    // The snapshot covers every acknowledged write, so archived WAL
    // segments are stale: best-effort delete `<wal>.000000..` until the
    // first missing N (cap 100000, mirroring wal.zig MAX_SEGMENTS).
    {
        const base = wal.path[0..wal.path.len];
        var n: u32 = 0;
        var sbuf: [4096]u8 = undefined;
        while (n < 100_000) : (n += 1) {
            if (sbuf.len < base.len + 8) break;
            @memcpy(sbuf[0..base.len], base);
            sbuf[base.len] = '.';
            var v = n;
            var i: usize = 6;
            while (i > 0) : (i -= 1) {
                sbuf[base.len + i] = @as(u8, @intCast(v % 10)) + '0';
                v /= 10;
            }
            const seg = sbuf[0 .. base.len + 7];
            std.fs.cwd().deleteFile(seg) catch |err| {
                if (err == error.FileNotFound) break; // first missing: stop
                continue; // best effort: keep trying higher indexes
            };
        }
    }
    // 2. Log Rotation
    // The flusher drained the ring above, so no acknowledged write is lost.
    // Close current WAL
    if (builtin.os.tag == .windows) {
        _ = std.os.windows.CloseHandle(wal.fd);
    } else {
        _ = std.c.close(wal.fd);
    }

    // Truncate / Reopen WAL at its owned path (no hardcoding).
    const wal_path: [:0]const u8 = wal.path;
    if (builtin.os.tag == .windows) {
        var path_w: [1024]u16 = undefined;
        const utf16_len = try std.unicode.utf8ToUtf16Le(&path_w, wal_path);
        path_w[utf16_len] = 0;
        const handle = std.os.windows.kernel32.CreateFileW(
            @as([*:0]const u16, @ptrCast(&path_w)),
            @as(std.os.windows.ACCESS_MASK, @bitCast(@as(u32, 0xC0000000))), // GENERIC_READ | GENERIC_WRITE
            1, // FILE_SHARE_READ
            null,
            2, // CREATE_ALWAYS (truncates)
            0x80 | 0x20000000, // FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING
            null,
        );
        wal.fd = handle;
    } else {
        const flags = if (comptime builtin.os.tag == .linux)
            if (wal.direct)
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true, .DIRECT = true }
            else
                std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true }
        else
            std.posix.O{ .ACCMODE = .RDWR, .CREAT = true, .TRUNC = true, .APPEND = true };
        const raw_fd = std.c.open(wal_path.ptr, flags, @as(c_uint, 0o644));
        if (raw_fd < 0) return error.FileCreateError;
        wal.fd = @as(std.posix.fd_t, raw_fd);
    }
    wal.sector_pos = 0;
    // Fresh empty live file: reset the segment byte counter and restart
    // rotation suffixes at 0. Segments stay dense-from-0, which is what
    // makes recovery's stop-at-first-missing scan exact.
    wal.bytes_written = 0;
    wal.next_segment = 0;

    last_snapshot_ms = std.time.milliTimestamp();
    std.debug.print("[TakyonDB-Snapshot] WAL truncated successfully. Resuming operations.\n", .{});
}

// ============================================================================
// Tests
// ============================================================================

const test_helpers = struct {
    /// Opens a ring over `mem` for a test. `capacity` must be a power of two.
    fn initRing(mem: []u8, capacity: usize) !RingBuffer {
        return RingBuffer.init(mem[layout.RING_OFFSET..], capacity, true);
    }

    /// Stamps the global header and the three bump words exactly as a
    /// booted-but-empty server would. A test that leaves the bump words at
    /// zero is not measuring the same thing a live daemon snapshots: the
    /// strings region, for instance, then looks empty because nothing ever
    /// initialised it rather than because it holds no data.
    fn initEmptyArena(mem: []u8) void {
        std.mem.writeInt(u32, mem[layout.MAGIC_OFFSET..][0..4], layout.ARENA_MAGIC, .little);
        std.mem.writeInt(u32, mem[layout.VERSION_OFFSET..][0..4], layout.LAYOUT_VERSION, .little);
        std.mem.writeInt(u32, mem[layout.RECORD_BUMP_OFFSET..][0..4], layout.RECORD_BUMP_INIT, .little);
        std.mem.writeInt(u32, mem[layout.ART_BUMP_OFFSET..][0..4], layout.ART_START, .little);
        std.mem.writeInt(u32, mem[layout.STRING_BUMP_OFFSET..][0..4], layout.STRING_DATA_START, .little);
    }

    /// Asserts every byte is `want`, naming the first that is not. A
    /// per-byte expectEqual across a 16 MiB arena costs more test time
    /// than the assertion is worth, and the useful part of the failure is
    /// the offset, not the byte count.
    fn expectAll(bytes: []const u8, want: u8) !void {
        for (bytes, 0..) |b, i| {
            if (b == want) continue;
            std.debug.print("[test] offset {d} is 0x{x}, expected 0x{x}\n", .{ i, b, want });
            return error.TestExpectedEqual;
        }
    }

    /// Asserts `needle` appears nowhere: the "nothing leaked in" half of
    /// expectAll, for a pattern rather than a fill.
    fn expectAbsent(bytes: []const u8, needle: u8) !void {
        if (std.mem.indexOfScalar(u8, bytes, needle)) |at| {
            std.debug.print("[test] byte 0x{x} reappeared at offset {d}\n", .{ needle, at });
            return error.TestExpectedEqual;
        }
    }

    /// `<wal>` and `<wal>.snap` inside a private temp dir. The caller owns
    /// both returned paths (both are allocator-owned) and the tmpDir.
    fn paths(allocator: std.mem.Allocator, dirpath: []const u8, stem: []const u8) ![2][:0]u8 {
        const wal_path = try std.fmt.allocPrintZ(allocator, "{s}/{s}", .{ dirpath, stem });
        errdefer allocator.free(wal_path);
        const snap_path = try std.fmt.allocPrintZ(allocator, "{s}.snap", .{wal_path});
        return .{ wal_path, snap_path };
    }
};

test "empty 64 MiB arena snapshots to kilobytes, not megabytes" {
    // The regression this whole change exists for. The old footer carried a
    // single "active_len = max(record, art, string) bump" and copied the
    // arena prefix up to it, so an idle 64 MiB database wrote 10,493,952
    // bytes on every checkpoint: 15.1 GB/day of zeros. The bound here is
    // deliberately far below the arena size rather than "smaller than
    // before", so any future return to prefix-shaped snapshots fails.
    const allocator = std.heap.page_allocator;
    const arena_size: usize = 64 * 1024 * 1024;

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    @memset(mem, 0);
    test_helpers.initEmptyArena(mem);

    var ring = try test_helpers.initRing(mem, 64);
    _ = &ring;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    const paths = try test_helpers.paths(allocator, dirpath, "empty.takyon");
    defer allocator.free(paths[0]);
    defer allocator.free(paths[1]);

    // The throttle is process-wide; a second createSnapshot in the same
    // test binary would otherwise be skipped outright.
    const saved_interval = minIntervalMs;
    minIntervalMs = 0;
    defer minIntervalMs = saved_interval;

    var wal = try WalManager.init(allocator, paths[0]);
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring, layout.defaultRegions(mem.len));

    const snap = try std.fs.cwd().openFile(paths[1], .{});
    defer snap.close();
    const st = try snap.stat();

    // 1 KiB header + 8 (record bump word) + 8 (art root + bump) + 4
    // (string bump word) = 1044 payload bytes, one data block, one footer.
    try std.testing.expectEqual(@as(u64, 2 * BLOCK), st.size);
    try std.testing.expect(st.size < 16 * 1024);
    try std.testing.expect(st.size * 1000 < arena_size);
    std.debug.print("[test] empty 64 MiB arena -> {d} byte snapshot\n", .{st.size});
}

test "snapshot + recovery round-trip preserves records and index" {
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    // Must host the STRING arena (>= STRING_DATA_START) so triple bumps
    // can be asserted verbatim; stay >= MIN_ARENA_SIZE for realism.
    const arena_size = @max(layout.MIN_ARENA_SIZE, 12 * 1024 * 1024);

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    @memset(mem, 0);

    var ring = try test_helpers.initRing(mem, 64);
    var index = art.ArtIndex.init(mem, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);

    // Three fixed records with marker patterns.
    const rec_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.RECORD_BUMP_OFFSET));
    rec_bump.* = layout.RECORD_BUMP_INIT;
    const keys = [_][]const u8{ "alpha", "beta", "gamma" };
    for (keys, 0..) |k, i| {
        const off = rec_bump.*;
        @memset(mem[off .. off + 64], @as(u8, @intCast(0xA0 + i)));
        rec_bump.* = off + 64;
        try index.insert(k, off);
    }

    // Seed the STRING bank with a marker so str_bump survival is meaningful.
    const str_bump_ptr: *u32 = @ptrCast(@alignCast(mem.ptr + layout.STRING_BUMP_OFFSET));
    str_bump_ptr.* = layout.STRING_DATA_START;
    const str_data_len = 128;
    @memset(mem[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len], 0x5A);
    str_bump_ptr.* = layout.STRING_DATA_START + str_data_len;

    const exp_rec: u32 = rec_bump.*;
    const art_bump_ptr: *const u32 = @ptrCast(@alignCast(mem.ptr + layout.ART_BUMP_OFFSET));
    const exp_art_raw: u32 = art_bump_ptr.*;
    const exp_str: u32 = str_bump_ptr.*;
    const exp_art_aligned: u32 = (exp_art_raw + 7) & ~@as(u32, 7);

    // Filesystem state lives in a per-test temp dir. A cwd-relative
    // "data.takyon" was shared with the other storage tests: on Windows a
    // handle held by an earlier test makes deleteFile fail, so stale WAL
    // bytes leaked into this test (the second casualty of the flaky WAL
    // flusher test). tmpDir cleanup also removes the .snap and .snap.tmp
    // sidecars for free, so the explicit deletes are no longer needed.
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    const paths = try test_helpers.paths(allocator, dirpath, "snapshot_rt.takyon");
    defer allocator.free(paths[0]);
    defer allocator.free(paths[1]);
    const wal_path = paths[0];
    const snap_path = paths[1];

    const saved_interval = minIntervalMs;
    minIntervalMs = 0;
    defer minIntervalMs = saved_interval;

    var wal = try WalManager.init(allocator, wal_path);
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring, layout.defaultRegions(mem.len));

    // Footer v3 sanity: magic/format/crc/layout/flags, one length per
    // extent, and a zero tail whose length is what distinguishes v3 from
    // the v2 and v1 shapes recovery must refuse.
    {
        const snap_file = try std.fs.cwd().openFile(snap_path, .{});
        defer snap_file.close();
        const stat = try snap_file.stat();
        try std.testing.expectEqual(@as(u64, 0), stat.size % BLOCK);
        var footer: [BLOCK]u8 = undefined;
        try snap_file.seekTo(stat.size - BLOCK);
        try snap_file.reader().readNoEof(&footer);
        try std.testing.expectEqual(FOOTER_MAGIC, std.mem.readInt(u32, footer[0..4], .little));
        try std.testing.expectEqual(SNAPSHOT_VERSION, std.mem.readInt(u32, footer[4..8], .little));
        try std.testing.expectEqual(LAYOUT_VERSION, std.mem.readInt(u32, footer[12..16], .little));
        try std.testing.expectEqual(@as(u32, 0), std.mem.readInt(u32, footer[16..20], .little));
        const ext = snapshotExtents(mem, layout.defaultRegions(mem.len));
        for (ext, 0..) |e, i| {
            try std.testing.expectEqual(e.len, std.mem.readInt(u32, footer[20 + 4 * i ..][0..4], .little));
        }
        for (footer[FOOTER_V3_TAIL_OFF..]) |b| try std.testing.expectEqual(@as(u8, 0), b);
        // The three data regions really are in use, so this snapshot is not
        // accidentally the empty-above case.
        try std.testing.expect(ext[EXT_REC].len > 0);
        try std.testing.expect(ext[EXT_ART].len > 0);
        try std.testing.expect(ext[EXT_STR].len > 0);
    }

    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    @memset(mem2, 0);
    const regions = layout.defaultRegions(mem2.len);
    var art_index = art.ArtIndex.init(mem2, regions.art_root, regions.artBumpOffset(), @intCast(regions.artStart()));
    try recovery.recoverWal(allocator, wal_path, mem2, &art_index, regions);

    // Record bytes survived verbatim.
    try std.testing.expectEqualSlices(u8, mem[layout.RECORD_START..exp_rec], mem2[layout.RECORD_START..exp_rec]);
    // String bytes survived verbatim.
    try std.testing.expectEqualSlices(
        u8,
        mem[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len],
        mem2[layout.STRING_DATA_START .. layout.STRING_DATA_START + str_data_len],
    );

    // Triple bumps survived (8-aligned, >= init).
    const rec2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.RECORD_BUMP_OFFSET))).*;
    const art2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.ART_BUMP_OFFSET))).*;
    const str2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.STRING_BUMP_OFFSET))).*;
    try std.testing.expectEqual((exp_rec + 7) & ~@as(u32, 7), rec2);
    try std.testing.expectEqual(exp_art_aligned, art2);
    try std.testing.expectEqual((exp_str + 7) & ~@as(u32, 7), str2);
    try std.testing.expect(rec2 >= layout.RECORD_BUMP_INIT);
    try std.testing.expect(art2 >= layout.ART_START);
    try std.testing.expect(str2 >= layout.STRING_DATA_START);

    // The ART index survived: reattach (bump already set) and search.
    var index2 = art.ArtIndex.init(mem2, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    for (keys, 0..) |k, i| {
        const off = index2.search(k) orelse return error.TestExpectedFound;
        try std.testing.expectEqual(@as(u8, @intCast(0xA0 + i)), mem2[off]);
    }
}

test "sparse snapshot restores every byte and index key into a dirty arena" {
    // The failure mode a partial snapshot introduces: recovery restores
    // only the in-use extents, so an arena that already held bytes from a
    // previous incarnation would keep every byte the snapshot did not
    // overwrite. Those bytes are unreachable through the allocator (the
    // bumps bound all three regions) but they are still readable, and a
    // stale record that looks like data is exactly the class of bug that
    // survives a smoke test. So the recovery arena here is deliberately
    // full of garbage, and the assertions are: every restored byte equals
    // the source, every byte outside the extents is zero.
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    const arena_size: usize = layout.MIN_ARENA_SIZE;

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    // Non-zero filler everywhere, so "restored" and "left alone" cannot be
    // confused: the header extent, the three regions and the ring all have
    // to be dealt with deliberately. The ART region is the exception - in a
    // real arena it is only ever written by the allocator, and a garbage
    // root word is not a tree - so it is blanked first, which also leaves
    // the unallocated part of the ART region as a real test of the zeroing.
    for (mem, 0..) |*b, i| b.* = @as(u8, @truncate(i * 31 + 7));
    @memset(mem[layout.ART_ROOT_OFFSET..layout.STRING_ARENA_START], 0);
    test_helpers.initEmptyArena(mem);

    var ring = try test_helpers.initRing(mem, 64);
    var index = art.ArtIndex.init(mem, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);

    // Records: a run that crosses a 4 KiB block boundary inside the
    // record region, so the packed payload has to stitch two extents into
    // one on-disk block at least once.
    const rec_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.RECORD_BUMP_OFFSET));
    rec_bump.* = layout.RECORD_BUMP_INIT;
    const rec_span: u32 = 5000; // > BLOCK
    const rec_off: u32 = @intCast(std.mem.alignForward(usize, layout.RECORD_START, 64));
    for (mem[@as(usize, rec_off)..][0..rec_span], 0..) |*b, i| b.* = @as(u8, @truncate(i ^ 0xA5));
    rec_bump.* = rec_off + rec_span;

    // Strings: keys plus a payload blob, also crossing a block boundary.
    const str_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.STRING_BUMP_OFFSET));
    str_bump.* = layout.STRING_DATA_START;
    const keys = [_][]const u8{
        "user:1001",           "user:1002",           "user:1003",
        "order:2001",          "order:2002",          "order:2003",
        "telemetry:gauge:cpu", "telemetry:gauge:mem",
    };
    var key_offsets: [keys.len]u32 = undefined;
    for (keys, 0..) |k, i| {
        const at: u32 = str_bump.*;
        @memcpy(mem[@as(usize, at)..][0..k.len], k);
        key_offsets[i] = at;
        str_bump.* = at + @as(u32, @intCast(k.len));
    }
    // An unaligned run at the end, so the string extent is neither a
    // multiple of the block size nor of 8.
    const blob_off: u32 = str_bump.*;
    const blob_len: u32 = 5003;
    for (mem[@as(usize, blob_off)..][0..blob_len], 0..) |*b, i| b.* = @as(u8, @truncate(i * 7 + 1));
    str_bump.* = blob_off + blob_len;

    // Index keys bound to the record offsets.
    for (keys, 0..) |k, i| try index.insert(k, rec_off + @as(u32, @intCast(i * 64)));

    const exp_rec: u32 = rec_bump.*;
    const exp_art: u32 = @as(*const u32, @ptrCast(@alignCast(mem.ptr + layout.ART_BUMP_OFFSET))).*;
    const exp_str: u32 = str_bump.*;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    const paths = try test_helpers.paths(allocator, dirpath, "sparse.takyon");
    defer allocator.free(paths[0]);
    defer allocator.free(paths[1]);

    const saved_interval = minIntervalMs;
    minIntervalMs = 0;
    defer minIntervalMs = saved_interval;

    var wal = try WalManager.init(allocator, paths[0]);
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring, layout.defaultRegions(mem.len));

    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    // Poison: nothing here may survive unless the snapshot put it back.
    @memset(mem2, 0xCD);
    const regions = layout.defaultRegions(mem2.len);
    var art_index = art.ArtIndex.init(mem2, regions.art_root, regions.artBumpOffset(), @intCast(regions.artStart()));
    try recovery.recoverWal(allocator, paths[0], mem2, &art_index, regions);

    const ext = snapshotExtents(mem, layout.defaultRegions(mem.len));
    try std.testing.expect(ext[EXT_REC].len > BLOCK);
    try std.testing.expect(ext[EXT_STR].len > BLOCK);

    // Every byte inside an extent came back exactly, and every byte
    // outside one is zero.
    //
    // The one deliberate exception is the allocator word at the head of
    // each bump extent. The snapshot does carry it, but finalize() re-derives
    // it as an 8-aligned maximum, so its low three bits are recovery's to
    // decide rather than the snapshot's; the bumps are asserted separately
    // below. The ART root pointer in front of the ART bump is data, not an
    // allocator word, so it is compared like every other byte.
    var cursor: usize = 0;
    for (ext, 0..) |e, i| {
        const start: usize = e.start;
        const end: usize = e.end();
        const skip: usize = if (i == EXT_HDR) 0 else 4;
        try std.testing.expectEqualSlices(u8, mem[start + skip .. end], mem2[start + skip .. end]);
        if (cursor < start) try test_helpers.expectAll(mem2[cursor..start], 0);
        cursor = end;
    }
    try test_helpers.expectAll(mem2[cursor..], 0);
    try std.testing.expectEqualSlices(
        u8,
        mem[layout.ART_ROOT_OFFSET..][0..4],
        mem2[layout.ART_ROOT_OFFSET..][0..4],
    );

    // The whole picture in one shot: the recovered arena is byte-identical
    // to the source over every byte the source had in use, which is the
    // round-trip property. The ring is excluded because it is not one of
    // those bytes: recovery finalizes it to zero on purpose.
    try std.testing.expectEqualSlices(u8, mem[0..layout.RING_OFFSET], mem2[0..layout.RING_OFFSET]);
    try std.testing.expectEqualSlices(u8, mem[layout.RECORD_BUMP_OFFSET..exp_rec], mem2[layout.RECORD_BUMP_OFFSET..exp_rec]);
    for (mem2[layout.RING_OFFSET..layout.RECORD_BUMP_OFFSET]) |b| {
        try std.testing.expectEqual(@as(u8, 0), b);
    }
    try std.testing.expectEqualSlices(
        u8,
        mem[layout.STRING_ARENA_START + 4 .. exp_str],
        mem2[layout.STRING_ARENA_START + 4 .. exp_str],
    );
    // The header extent rode along, so the magic survived the poison. The
    // rest of GLOBAL_RESERVED came with it, which is the point of carrying
    // the whole 1 KiB rather than just the 8 bytes anyone reads today.
    try std.testing.expectEqual(layout.ARENA_MAGIC, std.mem.readInt(u32, mem2[0..4], .little));
    try std.testing.expectEqual(layout.LAYOUT_VERSION, std.mem.readInt(u32, mem2[4..8], .little));
    try std.testing.expectEqualSlices(u8, mem[0..layout.RING_OFFSET], mem2[0..layout.RING_OFFSET]);

    // Bumps and index.
    const rec2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.RECORD_BUMP_OFFSET))).*;
    const art2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.ART_BUMP_OFFSET))).*;
    const str2: u32 = @as(*const u32, @ptrCast(@alignCast(mem2.ptr + layout.STRING_BUMP_OFFSET))).*;
    try std.testing.expectEqual((exp_rec + 7) & ~@as(u32, 7), rec2);
    try std.testing.expectEqual((exp_art + 7) & ~@as(u32, 7), art2);
    try std.testing.expectEqual((exp_str + 7) & ~@as(u32, 7), str2);

    var index2 = art.ArtIndex.init(mem2, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    for (keys, 0..) |k, i| {
        const found = index2.search(k) orelse return error.TestExpectedFound;
        try std.testing.expectEqual(rec_off + @as(u32, @intCast(i * 64)), found);
        // The value the key points at is the record byte pattern.
        try std.testing.expectEqual(@as(u8, @truncate(i * 64 ^ 0xA5)), mem2[found]);
    }
    // Every key came back byte for byte, in the string arena the snapshot
    // claimed it did.
    for (keys, 0..) |k, i| {
        const ko: usize = key_offsets[i];
        try std.testing.expectEqualSlices(u8, k, mem2[ko..][0..k.len]);
        try std.testing.expect(ko + k.len <= exp_str);
    }
    // A key the snapshot never held must not be findable, and the first
    // byte past the string extent must be zero.
    try std.testing.expect(index2.search("user:9999") == null);
    try std.testing.expectEqual(@as(u8, 0), mem2[@as(usize, exp_str)]);
}

test "a v2 contiguous-prefix snapshot is rejected, not reinterpreted" {
    // v2 and v3 share a magic, and in both the word after the CRC is a
    // length: v2's is the arena prefix length, v3's is the header extent
    // length. The word after THAT is where they stop agreeing, because v2
    // put the ART and string bumps there. Rejected loudly by version, this
    // file is not read; the test pins that it is not read by checking the
    // one thing a misread would change - whether recovery touched the arena
    // at all.
    //
    // (For the record, the backstop agrees: read as lengths, v2's string
    // bump lands past the end of any arena this build accepts, because the
    // slack above STRING_ARENA_START is always smaller than
    // STRING_DATA_START. The version gate is the primary defence; the
    // range check is only why a mistake here would still not corrupt.)
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    const arena_size = layout.MIN_ARENA_SIZE;
    const Crc32 = std.hash.Crc32;

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    @memset(mem, 0);
    test_helpers.initEmptyArena(mem);

    // Something worth restoring, so "ignored" is visible.
    const rec_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.RECORD_BUMP_OFFSET));
    rec_bump.* = layout.RECORD_START;
    @memset(mem[layout.RECORD_START..][0..9000], 0xEE);
    rec_bump.* = layout.RECORD_START + 9000;
    var index = art.ArtIndex.init(mem, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    try index.insert("ghost", layout.RECORD_START);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    const paths = try test_helpers.paths(allocator, dirpath, "v2.takyon");
    defer allocator.free(paths[0]);
    defer allocator.free(paths[1]);

    // Hand-build exactly what the previous format wrote: the arena prefix
    // as data blocks, then a v2 footer whose [16..20) and [20..24] are the
    // ART and string bumps.
    const art_bump: u32 = @as(*const u32, @ptrCast(@alignCast(mem.ptr + layout.ART_BUMP_OFFSET))).*;
    const str_bump: u32 = @as(*const u32, @ptrCast(@alignCast(mem.ptr + layout.STRING_BUMP_OFFSET))).*;
    const active_len = blk: {
        const a = @max(rec_bump.*, @max(art_bump, str_bump));
        break :blk (a + 7) & ~@as(u32, 7);
    };
    {
        var f = try std.fs.cwd().createFile(paths[1], .{ .truncate = true });
        defer f.close();
        var hasher = Crc32.init();
        var block: [BLOCK]u8 = undefined;
        var written: usize = 0;
        while (written < active_len) : (written += BLOCK) {
            @memset(&block, 0);
            const n = @min(active_len - written, BLOCK);
            @memcpy(block[0..n], mem[written..][0..n]);
            hasher.update(&block);
            try f.writeAll(&block);
        }
        @memset(&block, 0);
        std.mem.writeInt(u32, block[0..4], layout.ARENA_MAGIC, .little);
        std.mem.writeInt(u32, block[4..8], 2, .little); // v2: the arena layout version
        std.mem.writeInt(u32, block[8..12], hasher.final(), .little);
        std.mem.writeInt(u32, block[12..16], active_len, .little);
        std.mem.writeInt(u32, block[16..20], art_bump, .little);
        std.mem.writeInt(u32, block[20..24], str_bump, .little);
        try f.writeAll(&block);
    }

    // There is no WAL here at all (createSnapshot was never called, so
    // nothing created or truncated one), which means the only route any of
    // the 0xEE bytes could take into the arena is a snapshot read.
    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    @memset(mem2, 0xCD);
    try recovery.recoverWal(allocator, paths[0], mem2, null, layout.defaultRegions(mem2.len));

    // Not one byte of the rejected payload exists in the arena, and not
    // one byte of the poison is left either: recovery returned before
    // touching a single extent. The only writes the arena did see are the
    // three bump words and the ring, which finalize performs on every
    // recovery whether or not a snapshot was found.
    try test_helpers.expectAbsent(mem2, 0xEE);
    try test_helpers.expectAbsent(mem2, layout.ARENA_MAGIC & 0xFF);
    try test_helpers.expectAll(mem2[0..layout.RING_OFFSET], 0xCD);
    try test_helpers.expectAll(mem2[layout.RING_OFFSET..layout.RECORD_BUMP_OFFSET], 0);
    try test_helpers.expectAll(mem2[layout.RECORD_BUMP_OFFSET + 4 .. layout.ART_ROOT_OFFSET], 0xCD);
    try test_helpers.expectAll(mem2[layout.ART_BUMP_OFFSET + 4 .. layout.STRING_ARENA_START], 0xCD);
    try test_helpers.expectAll(mem2[layout.STRING_BUMP_OFFSET + 4 ..], 0xCD);
    try std.testing.expectEqual(@as(u32, layout.RECORD_BUMP_INIT), readBump(mem2, layout.RECORD_BUMP_OFFSET, 0));
    try std.testing.expectEqual(@as(u32, layout.ART_START), readBump(mem2, layout.ART_BUMP_OFFSET, 0));
    // finalize re-derives the bumps as 8-aligned maxima, so the string one
    // is STRING_DATA_START rounded up even though nothing allocated.
    try std.testing.expectEqual(
        @as(u32, (layout.STRING_DATA_START + 7) & ~@as(usize, 7)),
        readBump(mem2, layout.STRING_BUMP_OFFSET, 0),
    );
}

test "a torn snapshot is detected by the two-pass CRC and applied to nothing" {
    // The two-pass read is the only thing standing between a half-written
    // snapshot and a half-restored arena: pass 2 scatters the payload while
    // hashing and the result is discarded unless it matches the footer.
    // Flipping one byte in the middle of the payload has to be enough.
    const recovery = @import("recovery.zig");
    const allocator = std.heap.page_allocator;
    const arena_size = layout.MIN_ARENA_SIZE;

    const mem = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem);
    @memset(mem, 0);
    test_helpers.initEmptyArena(mem);

    var ring = try test_helpers.initRing(mem, 64);
    const rec_bump: *u32 = @ptrCast(@alignCast(mem.ptr + layout.RECORD_BUMP_OFFSET));
    rec_bump.* = layout.RECORD_START;
    @memset(mem[layout.RECORD_START..][0..9000], 0xEE);
    rec_bump.* = layout.RECORD_START + 9000;
    var index = art.ArtIndex.init(mem, layout.ART_ROOT_OFFSET, layout.ART_BUMP_OFFSET, layout.ART_START);
    try index.insert("torn", layout.RECORD_START);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const dirpath = try tmp.dir.realpath(".", &dirbuf);
    const paths = try test_helpers.paths(allocator, dirpath, "torn.takyon");
    defer allocator.free(paths[0]);
    defer allocator.free(paths[1]);

    const saved_interval = minIntervalMs;
    minIntervalMs = 0;
    defer minIntervalMs = saved_interval;

    var wal = try WalManager.init(allocator, paths[0]);
    defer wal.shutdown();
    try createSnapshot(mem, &wal, &ring, layout.defaultRegions(mem.len));

    // Flip one byte in the middle of the record extent's first data block.
    // The footer is untouched, so the only thing that can catch this is the
    // CRC over the payload.
    {
        var f = try std.fs.cwd().openFile(paths[1], .{ .mode = .read_write });
        defer f.close();
        const flip_at: u64 = BLOCK / 2; // block 0 is hdr+rec: the record data starts at 1024
        var byte: [1]u8 = undefined;
        try f.seekTo(flip_at);
        try f.reader().readNoEof(&byte);
        byte[0] ^= 0xFF;
        try f.seekTo(flip_at);
        try f.writeAll(&byte);
    }

    const mem2 = try allocator.alloc(u8, arena_size);
    defer allocator.free(mem2);
    @memset(mem2, 0xCD);
    try recovery.recoverWal(allocator, paths[0], mem2, null, layout.defaultRegions(mem2.len));

    // Rejected, and because the extents had already been scattered, they
    // are blanked rather than left holding half a payload. What is left is
    // a known-empty arena for the WAL to rebuild: no poison, no payload
    // byte, and the allocator back at its initial bumps.
    try test_helpers.expectAbsent(mem2, 0xCD);
    try test_helpers.expectAbsent(mem2, 0xEE);
    try test_helpers.expectAll(mem2[layout.RECORD_START..][0..9000], 0);
    try std.testing.expectEqual(@as(u32, layout.RECORD_BUMP_INIT), readBump(mem2, layout.RECORD_BUMP_OFFSET, 0));
    try std.testing.expectEqual(@as(u32, layout.ART_START), readBump(mem2, layout.ART_BUMP_OFFSET, 0));
    // finalize re-derives the bumps as 8-aligned maxima, so the string one
    // is STRING_DATA_START rounded up even though nothing allocated.
    try std.testing.expectEqual(
        @as(u32, (layout.STRING_DATA_START + 7) & ~@as(usize, 7)),
        readBump(mem2, layout.STRING_BUMP_OFFSET, 0),
    );
}
