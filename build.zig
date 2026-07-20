const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Core module (pure Zig engine) used by daemon & tests
    const core_mod = b.createModule(.{
        .root_source_file = b.path("src/core/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Addon module (Zig engine + C++ Node-API bridge)
    const addon_mod = b.createModule(.{
        .root_source_file = b.path("src/core/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    addon_mod.addCSourceFile(.{
        .file = b.path("src/sdk/bindings/binding.cc"),
        .flags = &[_][]const u8{"-std=c++17"},
    });
    addon_mod.link_libc = true;
    addon_mod.link_libcpp = true;
    addon_mod.addIncludePath(b.path("src/sdk/ts/node_modules/node-api-headers/include"));

    if (target.result.os.tag == .windows) {
        addon_mod.addObjectFile(b.path("lib/node.lib"));
    }

    const addon = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "takyondb_bridge",
        .root_module = addon_mod,
    });
    addon.linker_allow_shlib_undefined = true; // Essential for N-API on POSIX

    // Install the dynamic library artifact to zig-out/lib
    b.installArtifact(addon);

    // Also install a copy named exactly 'takyondb_bridge.node' in zig-out/bin for Node.js scripts
    const install_node = b.addInstallFileWithDir(addon.getEmittedBin(), .bin, "takyondb_bridge.node");
    b.getInstallStep().dependOn(&install_node.step);

    // Standalone Daemon (Server)
    const exe = b.addExecutable(.{
        .name = "takyondb",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/server/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    exe.root_module.addImport("core", core_mod);
    b.installArtifact(exe);

    // Tests module
    const core_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/core/test.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_core_tests = b.addRunArtifact(core_tests);
    const test_step = b.step("test", "Run library tests");
    test_step.dependOn(&run_core_tests.step);
}
