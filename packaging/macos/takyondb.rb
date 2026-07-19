class Takyondb < Formula
  desc "Insanely fast, zero-copy, lock-free in-memory database"
  homepage "https://github.com/joacokhzyx/takyondb"
  url "https://github.com/joacokhzyx/takyondb/archive/refs/tags/v1.0.0.tar.gz"
  license "AGPL-3.0-only"

  depends_on "zig" => :build

  def install
    system "zig", "build", "-Doptimize=ReleaseSafe"
    bin.install "zig-out/bin/takyondb"
  end

  service do
    run [opt_bin/"takyondb", "67108864"]
    keep_alive true
    working_dir var
    log_path var/"log/takyondb.log"
    error_log_path var/"log/takyondb.err"
  end

  test do
    system "#{bin}/takyondb", "--help"
  end
end
