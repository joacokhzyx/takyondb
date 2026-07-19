const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const core_mod = b.createModule(.{
        .root_source_file = b.path("src/core/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const addon = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "takyondb_bridge",
        .root_module = core_mod,
    });
    addon.linker_allow_shlib_undefined = true; // Essential for N-API on POSIX

    // Force the output name to have .node extension
    if (target.result.os.tag == .windows) {
        addon.out_filename = b.fmt("{s}.node", .{addon.name});
    } else {
        addon.out_filename = b.fmt("lib{s}.node", .{addon.name});
    }

    // Compile C++ Bridge
    addon.root_module.addCSourceFile(.{
        .file = b.path("src/sdk/bindings/binding.cc"),
        .flags = &[_][]const u8{"-std=c++17"},
    });
    addon.root_module.link_libc = true;
    addon.root_module.link_libcpp = true;
    
    // Add Node-API headers
    addon.root_module.addIncludePath(b.path("src/sdk/ts/node_modules/node-api-headers/include"));

    // On Windows, link against our local copy of node.lib
    if (target.result.os.tag == .windows) {
        addon.root_module.addObjectFile(b.path("lib/node.lib"));
    }

    b.installArtifact(addon);

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
