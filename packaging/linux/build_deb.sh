#!/usr/bin/env bash
set -e

# Single source of truth for the version: src/sdk/ts/package.json. This used
# to be hardcoded here as 1.0.0 while the SDK said 0.1.0, and nothing caught
# it; scripts/check_version.js now fails CI if it is ever pinned again.
VERSION="$(node -p "require('../../src/sdk/ts/package.json').version")"
ARCH="amd64"
PKG_DIR="takyondb_${VERSION}_${ARCH}"

echo "Building Debian Package for TakyonDB v${VERSION}..."

rm -rf "${PKG_DIR}"
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/usr/local/bin"
mkdir -p "${PKG_DIR}/usr/local/lib"
mkdir -p "${PKG_DIR}/etc/systemd/system"
mkdir -p "${PKG_DIR}/usr/share/doc/takyondb"

# Control file
cat <<EOF > "${PKG_DIR}/DEBIAN/control"
Package: takyondb
Version: ${VERSION}
Section: database
Priority: optional
Architecture: ${ARCH}
Maintainer: TakyonDB Team <maintainers@takyondb.io>
Description: The data layer for servers: storage, indexes and queries in
 one process over one shared-memory arena. TakyonDB is a Zig engine with
 an N-API bridge and a TypeScript SDK, with a checksummed write-ahead log
 and verified snapshots.
EOF

# Post-install script
cat <<EOF > "${PKG_DIR}/DEBIAN/postinst"
#!/bin/sh
set -e
systemctl daemon-reload || true
echo "TakyonDB installed successfully. Enable service using: systemctl enable --now takyondb"
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# Copy binaries & assets
cp "../../zig-out/bin/takyondb" "${PKG_DIR}/usr/local/bin/"
cp "../../zig-out/lib/libtakyondb_bridge.so" "${PKG_DIR}/usr/local/lib/" 2>/dev/null || true
cp "takyondb.service" "${PKG_DIR}/etc/systemd/system/"
cp "../../README.md" "${PKG_DIR}/usr/share/doc/takyondb/"
cp "../../LICENSE" "${PKG_DIR}/usr/share/doc/takyondb/copyright"

chmod 755 "${PKG_DIR}/usr/local/bin/takyondb"

# Build .deb
dpkg-deb --build --root-owner-group "${PKG_DIR}"
echo "Debian package created: ${PKG_DIR}.deb"
