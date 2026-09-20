{
  "targets": [
    {
      "target_name": "takyondb_bridge",
      "sources": [ "binding.cc" ],
      "conditions": [
        ['OS=="win"', {
          "libraries": [
            "<(module_root_dir)/../../../zig-out/lib/takyondb.lib"
          ]
        }],
        ['OS!="win"', {
          "libraries": [
            "-L<(module_root_dir)/../../../zig-out/lib", "-ltakyondb"
          ]
        }]
      ]
    }
  ]
}
