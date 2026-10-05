// ============================================================================
// File: energy.zig
// Description: Optional package energy sampler for the daemon.
//   Reads the platform's energy counter when one exists and accumulates
//   microjoules. When no counter is readable the sampler has no thread and
//   every accessor returns zero with source `.none`: joules are never
//   synthesized from CPU time, cycle counts or a per-core wattage.
// Author/Maintainer: TakyonDB Contributors
// License: MIT. See LICENSE for details.
// ============================================================================

const std = @import("std");
const builtin = @import("builtin");

/// Where a reading came from. The name is what `METRICS` and the startup
/// log publish, so a reader never has to guess whether a number is
/// measured or derived.
pub const Source = enum {
    /// No readable counter on this host. Microjoules stay zero.
    none,
    /// A package-level RAPL domain: every process on the socket, not this
    /// daemon alone.
    rapl_package,
    /// A non-package RAPL domain (a core or uncore subdomain).
    rapl_subunit,

    pub fn name(self: Source) []const u8 {
        return switch (self) {
            .none => "none",
            .rapl_package => "rapl-package",
            .rapl_subunit => "rapl-subunit",
        };
    }
};

/// Default root of the Linux powercap sysfs tree. Only Linux implements a
/// counter; every other platform reports `.none` rather than approximating.
pub const POWERCAP_ROOT: []const u8 = "/sys/class/powercap";

/// Domains are probed in this order. `intel-rapl:0` is the package on the
/// usual layout and the nested path is the one some kernels expose instead.
/// A package domain is preferred over a subunit because it is the closest
/// thing to "the energy this machine spent", and its limits are stated
/// wherever a number from it is published.
const PROBE_DIRS = [_][]const u8{
    "intel-rapl:0",
    "intel-rapl/intel-rapl:0",
    "intel-rapl:0:0",
};

const COUNTER_FILE = "energy_uj";
const RANGE_FILE = "max_energy_range_uj";

/// Sampling period. One hertz is what the counter resolution and the
/// measurement harnesses assume; a faster period would add wakeups to prove
/// nothing.
pub const DEFAULT_INTERVAL_NS: u64 = std.time.ns_per_s;

/// A counter the process can read, together with the range it wraps at.
pub const Sensor = struct {
    /// Directory holding `energy_uj` and `max_energy_range_uj`. Owned by
    /// the sensor; freed by `deinit`.
    dir: []u8,
    max_range_uj: u64,
    source: Source,

    pub fn deinit(self: Sensor, allocator: std.mem.Allocator) void {
        allocator.free(self.dir);
    }
};

fn readCounter(dir: []const u8) ?u64 {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir, COUNTER_FILE }) catch return null;
    var f = std.fs.cwd().openFile(path, .{}) catch return null;
    defer f.close();
    var buf: [64]u8 = undefined;
    const n = f.read(&buf) catch return null;
    const text = std.mem.trim(u8, buf[0..n], " \t\r\n");
    if (text.len == 0) return null;
    return std.fmt.parseInt(u64, text, 10) catch null;
}

fn readRange(dir: []const u8) ?u64 {
    var path_buf: [std.fs.max_path_bytes]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ dir, RANGE_FILE }) catch return null;
    var f = std.fs.cwd().openFile(path, .{}) catch return null;
    defer f.close();
    var buf: [64]u8 = undefined;
    const n = f.read(&buf) catch return null;
    const text = std.mem.trim(u8, buf[0..n], " \t\r\n");
    if (text.len == 0) return null;
    return std.fmt.parseInt(u64, text, 10) catch null;
}

/// Finds a readable counter under `root`. Returns null when the directory
/// does not exist, the counter is unreadable, or the platform has no such
/// tree — which is the normal case in a container and on every
/// non-Linux host.
pub fn findSensor(allocator: std.mem.Allocator, root: []const u8) !?Sensor {
    if (builtin.os.tag != .linux) return null;
    for (PROBE_DIRS, 0..) |sub, i| {
        var dir_buf: [std.fs.max_path_bytes]u8 = undefined;
        const dir = std.fmt.bufPrint(&dir_buf, "{s}/{s}", .{ root, sub }) catch continue;
        const max_range = readRange(dir) orelse continue;
        if (readCounter(dir) == null) continue;
        return Sensor{
            .dir = try allocator.dupe(u8, dir),
            .max_range_uj = max_range,
            // The first two probes are package domains; the nested `0:0`
            // form is a subdomain.
            .source = if (i == 2) .rapl_subunit else .rapl_package,
        };
    }
    return null;
}

/// What a reader gets. `microjoules` is the gross accumulation since the
/// sampler started; attribution to this daemon, to a route or to a
/// workload belongs to the harness, which knows what else was running.
pub const Report = struct {
    source: Source,
    microjoules: u64,
    samples: u64,
    read_errors: u64,
};

/// Accumulates a package counter on a background thread.
///
/// With no sensor there is no thread, no allocation and no syscalls: the
/// point is that an idle daemon on a host without a counter pays nothing,
/// which is the same property `scripts/e2e_idle_cpu_test.js` gates.
pub const Sampler = struct {
    sensor: ?Sensor,
    allocator: std.mem.Allocator,
    interval_ns: u64,
    accumulated_uj: std.atomic.Value(u64),
    last_uj: std.atomic.Value(u64),
    last_valid: std.atomic.Value(bool),
    samples: std.atomic.Value(u64),
    read_errors: std.atomic.Value(u64),
    running: std.atomic.Value(bool),
    thread: ?std.Thread,

    /// Probes for a counter and returns a sampler that is not yet sampling.
    /// `root` exists so a test can point the probe at a fixture tree
    /// instead of the real sysfs.
    ///
    /// Probing and spawning are separate on purpose. The thread reads the
    /// sampler through a pointer, so the sampler has to live at a stable
    /// address; a function that returned one by value while a thread held
    /// a pointer to its own stack copy would sample freed memory. This is
    /// the same reason `WalManager` has `init` and `spawnWalFlusher`.
    pub fn probe(allocator: std.mem.Allocator, interval_ns: u64, root: []const u8) !Sampler {
        return init(allocator, interval_ns, try findSensor(allocator, root));
    }

    /// Starts the background thread. A no-op with no sensor, so a host
    /// without a counter spawns nothing and reads nothing.
    pub fn spawn(self: *Sampler) !void {
        if (self.sensor == null) return;
        std.debug.assert(self.thread == null);
        self.running.store(true, .release);
        self.thread = try std.Thread.spawn(.{}, sampleLoop, .{self});
    }

    /// Builds a sampler around an already-probed sensor. Private so the
    /// pointer lifetime above cannot be got wrong from outside.
    fn init(allocator: std.mem.Allocator, interval_ns: u64, sensor: ?Sensor) Sampler {
        return Sampler{
            .sensor = sensor,
            .allocator = allocator,
            .interval_ns = if (interval_ns == 0) DEFAULT_INTERVAL_NS else interval_ns,
            .accumulated_uj = std.atomic.Value(u64).init(0),
            .last_uj = std.atomic.Value(u64).init(0),
            .last_valid = std.atomic.Value(bool).init(false),
            .samples = std.atomic.Value(u64).init(0),
            .read_errors = std.atomic.Value(u64).init(0),
            .running = std.atomic.Value(bool).init(false),
            .thread = null,
        };
    }

    /// Stops the thread and frees the sensor path. Idempotent: a second
    /// call is a no-op, so the daemon's shutdown path can call it without
    /// coordinating.
    pub fn stop(self: *Sampler) void {
        self.running.store(false, .release);
        if (self.thread) |th| {
            th.join();
            self.thread = null;
        }
        if (self.sensor) |s| {
            s.deinit(self.allocator);
            self.sensor = null;
        }
    }

    pub fn source(self: *const Sampler) Source {
        const s = self.sensor orelse return .none;
        return s.source;
    }

    pub fn report(self: *const Sampler) Report {
        const s = self.sensor orelse return Report{
            .source = .none,
            .microjoules = 0,
            .samples = 0,
            .read_errors = 0,
        };
        return Report{
            .source = s.source,
            .microjoules = self.accumulated_uj.load(.acquire),
            .samples = self.samples.load(.acquire),
            .read_errors = self.read_errors.load(.acquire),
        };
    }

    /// Folds one raw counter reading into the accumulation. Public because
    /// the wrap rule is the part worth testing directly: a counter that
    /// resets must contribute the tail plus the head, never a negative span
    /// and never a doubled range.
    pub fn observe(self: *Sampler, raw: u64, max_range_uj: u64) void {
        const prev = self.last_uj.load(.acquire);
        const had_prev = self.last_valid.load(.acquire);
        self.last_uj.store(raw, .release);
        self.last_valid.store(true, .release);
        _ = self.samples.fetchAdd(1, .monotonic);
        if (!had_prev) return;
        const delta: u64 = if (raw >= prev)
            raw - prev
        else
            (max_range_uj - prev) + raw;
        _ = self.accumulated_uj.fetchAdd(delta, .monotonic);
    }

    fn sampleLoop(self: *Sampler) void {
        const sensor = self.sensor.?;
        while (self.running.load(.acquire)) {
            if (readCounter(sensor.dir)) |raw| {
                self.observe(raw, sensor.max_range_uj);
            } else {
                _ = self.read_errors.fetchAdd(1, .monotonic);
            }
            // Sleep, never spin: a sampler that spins to sample energy
            // spends the energy it is measuring.
            std.time.sleep(self.interval_ns);
        }
    }
};

const testing = std.testing;

/// Writes the counter fixture without truncating, so a reader never sees a
/// half-written file. Zero padded to a fixed width for the same reason.
fn writeCounter(sub: *std.fs.Dir, value: u64) !void {
    var f = try sub.openFile(COUNTER_FILE, .{ .mode = .write_only });
    defer f.close();
    try f.seekTo(0);
    try f.writer().print("{d:0>20}\n", .{value});
}

test "a wrapped counter contributes the tail plus the head" {
    // Getting the wrap rule wrong is the difference between an undercount
    // and a number that jumps by the full range on every wrap, so this
    // drives `observe` directly instead of going through the thread.
    const allocator = testing.allocator;
    var s = Sampler.init(
        allocator,
        0,
        Sensor{ .dir = try allocator.dupe(u8, "/nonexistent"), .max_range_uj = 2_000_000, .source = .rapl_package },
    );
    defer s.stop();

    s.observe(1_000_000, 2_000_000);
    try testing.expectEqual(@as(u64, 0), s.report().microjoules); // first reading is a baseline
    s.observe(1_000_500, 2_000_000);
    try testing.expectEqual(@as(u64, 500), s.report().microjoules);

    // Wrap: 1_000_500 -> 1_000_100 means (2_000_000 - 1_000_500) + 1_000_100.
    s.observe(1_000_100, 2_000_000);
    try testing.expectEqual(@as(u64, 500 + 1_999_600), s.report().microjoules);
    try testing.expectEqual(@as(u64, 3), s.report().samples);
}

test "no sensor means no thread, no joules and a named source" {
    // This is the assertion the mission's energy claim rests on: without a
    // readable sensor there is no joule figure to quote, so the sampler
    // must report none and zero rather than an estimate.
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try tmp.dir.realpath(".", &dirbuf);

    try testing.expectEqual(@as(?Sensor, null), try findSensor(testing.allocator, root));

    var s = try Sampler.probe(testing.allocator, DEFAULT_INTERVAL_NS, root);
    defer s.stop();
    try s.spawn();
    try testing.expectEqual(Source.none, s.source());
    try testing.expect(s.thread == null);
    const r = s.report();
    try testing.expectEqual(Source.none, r.source);
    try testing.expectEqual(@as(u64, 0), r.microjoules);
    try testing.expectEqualStrings("none", r.source.name());
}

test "a readable counter accumulates and stop is idempotent" {
    // The fixture tree is what lets this run on a host with no sensor.
    if (builtin.os.tag == .windows) return error.SkipZigTest;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    var dirbuf: [std.fs.max_path_bytes]u8 = undefined;
    const root = try tmp.dir.realpath(".", &dirbuf);

    try tmp.dir.makePath("intel-rapl:0");
    var sub = try tmp.dir.openDir("intel-rapl:0", .{});
    defer sub.close();
    {
        var range = try sub.createFile(RANGE_FILE, .{ .truncate = true });
        defer range.close();
        try range.writer().print("{d}\n", .{std.math.maxInt(u64)});
    }
    // Fixed width, so overwriting the counter in place never leaves a value
    // the sampler cannot parse. A truncated file mid-write would read as a
    // parse error, which is a different test.
    var empty = try sub.createFile(COUNTER_FILE, .{ .truncate = true });
    empty.close();
    try writeCounter(&sub, 1000);

    const sensor = (try findSensor(testing.allocator, root)).?;
    defer sensor.deinit(testing.allocator);
    try testing.expectEqual(Source.rapl_package, sensor.source);

    // A short interval so the test does not spend a second per sample. The
    // sampler sleeps between readings either way.
    var s = try Sampler.probe(testing.allocator, 2 * std.time.ns_per_ms, root);
    defer s.stop();
    try s.spawn();
    try testing.expectEqual(Source.rapl_package, s.source());

    // Wait until the thread has a baseline reading before moving the
    // counter. Rewriting it first would leave every sample equal, and a
    // sampler that accumulates zero because it never saw a change is a
    // sampler this test would then be unable to distinguish from a broken
    // one.
    var spins: usize = 0;
    while (s.report().samples < 2 and spins < 500) : (spins += 1) {
        std.time.sleep(2 * std.time.ns_per_ms);
    }
    try testing.expect(s.report().samples >= 2);

    try writeCounter(&sub, 7500);

    spins = 0;
    while (s.report().microjoules == 0 and spins < 500) : (spins += 1) {
        std.time.sleep(2 * std.time.ns_per_ms);
    }

    const r = s.report();
    try testing.expect(r.microjoules > 0);
    try testing.expectEqual(@as(u64, 0), r.read_errors);

    s.stop();
    s.stop(); // idempotent, and the deferred stop above must not trip
}
