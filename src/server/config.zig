// ============================================================================
// File: config.zig
// Description: Optional startup configuration for the daemon.
//   One JSON file, every key optional, every default equal to the constant
//   it replaces. A missing file has to be indistinguishable from no
//   configuration at all, or the first release that can be configured is
//   also a behaviour change and nobody can tell which of their problems is
//   which.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const layout = @import("core").layout;

pub const ConfigError = error{
    /// The file could not be read.
    Unreadable,
    /// The file is not valid JSON, or a value has the wrong type.
    Malformed,
};

/// Region overrides. Sizes, not offsets: an operator states how much room a
/// region needs, and the boundaries fall out of that. Stating offsets
/// instead would make every operator arithmetic that the engine already
/// does and can check.
pub const RegionOverrides = struct {
    /// Bytes for the record region. Must leave the index root reachable:
    /// records end where the index begins.
    record_bytes: ?u32 = null,
    /// Bytes for the index region.
    art_bytes: ?u32 = null,
    /// Bytes for the string region.
    string_bytes: ?u32 = null,
    /// Ring slots. A power of two, at least 16.
    ring_capacity: ?u32 = null,
};

pub const Config = struct {
    /// Defaults to ".".
    data_dir: ?[]const u8 = null,
    /// Defaults to 60. Zero disables automatic checkpoints.
    checkpoint_sec: ?u32 = null,
    /// Defaults to 7723.
    admin_port: ?u16 = null,
    /// Defaults to true. False is the same as `--no-energy`.
    energy: ?bool = null,
    /// Region overrides, applied on top of the default table.
    regions: ?RegionOverrides = null,
};

/// Every key is optional and unknown keys are refused. Refusing an unknown
/// key is deliberate: a typo in `record_bytes` that silently kept the
/// default is the failure mode this file exists to remove, and a key this
/// build does not know about is far more likely a typo than a forward-
/// compatible extension.
fn parse(allocator: std.mem.Allocator, bytes: []const u8) !Config {
    var parsed = std.json.parseFromSlice(struct {
        data_dir: ?[]const u8 = null,
        checkpoint_sec: ?u32 = null,
        admin_port: ?u16 = null,
        energy: ?bool = null,
        regions: ?struct {
            record_bytes: ?u32 = null,
            art_bytes: ?u32 = null,
            string_bytes: ?u32 = null,
            ring_capacity: ?u32 = null,
        } = null,
    }, allocator, bytes, .{ .ignore_unknown_fields = false }) catch return error.Malformed;
    defer parsed.deinit();

    return .{
        .data_dir = parsed.value.data_dir,
        .checkpoint_sec = parsed.value.checkpoint_sec,
        .admin_port = parsed.value.admin_port,
        .energy = parsed.value.energy,
        .regions = if (parsed.value.regions) |r| RegionOverrides{
            .record_bytes = r.record_bytes,
            .art_bytes = r.art_bytes,
            .string_bytes = r.string_bytes,
            .ring_capacity = r.ring_capacity,
        } else null,
    };
}

/// Reads a configuration file. A missing file is not an error: it returns
/// an empty configuration, which is the documented default.
pub fn load(allocator: std.mem.Allocator, path: []const u8) !Config {
    const file = std.fs.cwd().openFile(path, .{}) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return error.Unreadable,
    };
    defer file.close();
    const bytes = file.readToEndAlloc(allocator, 64 * 1024) catch return error.Unreadable;
    defer allocator.free(bytes);
    return parse(allocator, bytes);
}

/// Lays out the regions for an arena, honouring the operator's sizes.
///
/// The three sizes are honoured in the order records, index, strings, and
/// **the boundaries are derived from them**. An earlier shape kept the
/// default index root and applied sizes on top, which made
/// `record_bytes: 67108864` invalid on a 256 MiB arena: records were asked
/// to end where the index began, two MiB in. An operator asking for 64 MiB
/// of records means "put the index after them", and refusing that is the
/// configuration refusing to be usable.
///
/// With nothing requested, every value is the constant it replaces: the
/// default path reproduces today's layout exactly, so a daemon with no
/// config file cannot be distinguished from one with an empty one.
pub fn regionsFor(defaults: layout.Regions, over: ?RegionOverrides) layout.Regions {
    const o = over orelse return defaults;

    // The ring comes first and is not negotiable: the record bump word sits
    // immediately after it, so a larger ring pushes everything else along.
    var r = defaults;
    if (o.ring_capacity) |v| r.ring_capacity = v;
    const ring_end: u32 = @intCast(layout.RING_OFFSET + layout.ringBytes(r.ring_capacity));
    const rec_start: u32 = ring_end + 8;

    // Round each requested size up to the 8-byte grid the index root needs.
    const rec_bytes: u32 = if (o.record_bytes) |v|
        std.mem.alignForward(u32, v, 8)
    else if (rec_start >= defaults.record_start)
        // A larger ring pushed the record start along; there is nothing to
        // carry over, and subtracting the difference would underflow.
        defaults.record_bytes
    else
        defaults.record_bytes + (defaults.record_start - rec_start);
    // Saturating, so an oversized request reaches `validateRegions` as a
    // named error instead of wrapping here.
    const art_root: u32 = if (rec_start + rec_bytes < rec_start)
        std.math.maxInt(u32)
    else
        rec_start + rec_bytes;

    // The index takes what it was asked for, or its default share if that
    // still fits behind the records; the strings take the rest, because a
    // string region that ends before the end of the arena is arithmetic
    // nobody wants to do by hand.
    const remaining = if (art_root >= defaults.arena_bytes) 0 else defaults.arena_bytes - art_root;
    const art_bytes: u32 = if (o.art_bytes) |v| v else @min(defaults.art_bytes, @max(8, remaining / 2));

    // An operator who asked for more records than the arena has gets a
    // table that fails `validateRegions` with a named error, not a
    // subtraction that panics here.
    const str_start: u32 = if (art_root + art_bytes >= defaults.arena_bytes)
        defaults.arena_bytes
    else
        art_root + art_bytes;

    r.record_start = rec_start;
    r.record_bytes = rec_bytes;
    r.art_root = art_root;
    r.art_bytes = art_bytes;
    r.string_start = str_start;
    r.string_bytes = if (str_start >= defaults.arena_bytes) 0 else defaults.arena_bytes - str_start;
    return r;
}

const testing = std.testing;

test "an absent file is an empty configuration" {
    const cfg = try load(testing.allocator, "no-such-takyon.json");
    try testing.expect(cfg.data_dir == null);
    try testing.expect(cfg.regions == null);
    try testing.expect(cfg.checkpoint_sec == null);
}

test "every key is optional" {
    const cfg = try parse(testing.allocator, "{}");
    try testing.expect(cfg.data_dir == null);
    try testing.expect(cfg.admin_port == null);
    try testing.expect(cfg.energy == null);
    try testing.expect(cfg.regions == null);
}

test "region overrides are read as sizes, not offsets" {
    const cfg = try parse(testing.allocator,
        \\{"regions":{"record_bytes":67108864,"art_bytes":134217728,"ring_capacity":16384}}
    );
    const o = cfg.regions.?;
    try testing.expectEqual(@as(?u32, 67108864), o.record_bytes);
    try testing.expectEqual(@as(?u32, 134217728), o.art_bytes);
    try testing.expectEqual(@as(?u32, 16384), o.ring_capacity);
    try testing.expectEqual(@as(?u32, null), o.string_bytes);
}

test "an unknown key is refused rather than ignored" {
    // A typo in record_bytes that silently kept the default is the whole
    // reason this file exists.
    try testing.expectError(error.Malformed, parse(testing.allocator,
        \\{"regions":{"record_byte":1024}}
    ));
    try testing.expectError(error.Malformed, parse(testing.allocator,
        \\{"checkpoint_sec":"sixty"}
    ));
    try testing.expectError(error.Malformed, parse(testing.allocator, "not json"));
}

test "no overrides reproduces today's layout exactly" {
    const defaults = layout.defaultRegions(64 * 1024 * 1024);
    const r = regionsFor(defaults, null);
    try testing.expectEqualSlices(u8, std.mem.asBytes(&defaults), std.mem.asBytes(&r));
    // Also with an empty override struct, which is what an empty config
    // file parses to.
    const empty = regionsFor(defaults, .{});
    try testing.expectEqualSlices(u8, std.mem.asBytes(&defaults), std.mem.asBytes(&empty));
}

test "a bigger record region moves the index after it" {
    const defaults = layout.defaultRegions(256 * 1024 * 1024);
    const r = regionsFor(defaults, .{ .record_bytes = 64 * 1024 * 1024 });

    // The point of the whole gate: 64 MiB of records on a 256 MiB arena,
    // which the default layout could not express.
    try testing.expectEqual(@as(u32, 64 * 1024 * 1024), r.record_bytes);
    try testing.expect(r.art_root >= r.record_start + r.record_bytes);
    try testing.expectEqual(@as(u32, r.record_start + r.record_bytes), r.art_root);
    try testing.expectEqual(@as(u32, 0), r.art_root % 8);
    try testing.expect(r.string_start > r.art_root);
    try testing.expectEqual(defaults.arena_bytes, r.arena_bytes);
    try layout.validateRegions(r, 256 * 1024 * 1024);
}

test "a record region that does not fit is caught by validation" {
    const defaults = layout.defaultRegions(64 * 1024 * 1024);
    const r = regionsFor(defaults, .{ .record_bytes = 128 * 1024 * 1024 });
    // The string region collapses to nothing, which is the symptom an
    // operator sees; the relation that actually failed is the overlap.
    try testing.expectEqual(@as(u32, 0), r.string_bytes);
    try testing.expectError(error.RegionsOverlap, layout.validateRegions(r, 64 * 1024 * 1024));
}

test "a ring too large for its arena is caught by validation" {
    const defaults = layout.defaultRegions(64 * 1024 * 1024);
    // A 1M-slot ring needs ~67 MiB of ring, which does not fit beside the
    // regions in a 64 MiB arena. The failure has to arrive at validation as
    // a named error, not as an underflow while computing one.
    const r = regionsFor(defaults, .{ .ring_capacity = 1 << 20 });
    try testing.expectEqual(@as(u32, 0), r.string_bytes);
    try testing.expectError(error.RegionsOverlap, layout.validateRegions(r, 64 * 1024 * 1024));
}

test "a ring capacity that is not a power of two is refused" {
    const defaults = layout.defaultRegions(64 * 1024 * 1024);
    const r = regionsFor(defaults, .{ .ring_capacity = 3000 });
    try testing.expectError(error.RingCapacityNotPowerOfTwo, layout.validateRegions(r, 64 * 1024 * 1024));
}
