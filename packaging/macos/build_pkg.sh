#!/usr/bin/env bash
set -e

VERSION="1.0.0"
PKG_NAME="TakyonDB-${VERSION}.pkg"
ROOT_DIR="pkg_root"

echo "Building macOS Installer Package for TakyonDB v${VERSION}..."

rm -rf "${ROOT_DIR}"
mkdir -p "${ROOT_DIR}/usr/local/bin"
mkdir -p "${ROOT_DIR}/Library/LaunchDaemons"

cp "../../zig-out/bin/takyondb" "${ROOT_DIR}/usr/local/bin/"
cp "com.takyondb.daemon.plist" "${ROOT_DIR}/Library/LaunchDaemons/"

chmod 755 "${ROOT_DIR}/usr/local/bin/takyondb"

pkgbuild --root "${ROOT_DIR}" \
         --identifier "com.takyondb.daemon" \
         --version "${VERSION}" \
         --install-location "/" \
         "${PKG_NAME}"

echo "macOS package created: ${PKG_NAME}"
