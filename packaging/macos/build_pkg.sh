#!/usr/bin/env bash
# macOS installer package.
#
# Ships the daemon AND the N-API bridge. The bridge used to be omitted here
# while Linux and Windows both packaged it, so a macOS install gave you a
# daemon you could not talk to from Node: the SDK resolves the addon under
# <root>/lib/node_modules/takyondb/prebuilds/<platform>-<arch>/, which is the
# path the npm package uses, so the .pkg installs the bridge next to the
# daemon and the npm tarball supplies the JS half.
set -euo pipefail

# Single source of truth for the version: src/sdk/ts/package.json. It used to
# be hardcoded here as 1.0.0 while the SDK said 0.1.0, and nothing caught it.
VERSION="$(node -p "require('../../src/sdk/ts/package.json').version")"

PKG_NAME="TakyonDB-${VERSION}.pkg"
ROOT_DIR="pkg_root"
PREFIX="usr/local"
LIB_DIR="${PREFIX}/lib"
BIN_DIR="${PREFIX}/bin"
DOC_DIR="${PREFIX}/share/doc/takyondb"

echo "Building macOS Installer Package for TakyonDB v${VERSION}..."

rm -rf "${ROOT_DIR}"
mkdir -p "${ROOT_DIR}/${BIN_DIR}"
mkdir -p "${ROOT_DIR}/${LIB_DIR}"
mkdir -p "${ROOT_DIR}/Library/LaunchDaemons"
mkdir -p "${ROOT_DIR}/${DOC_DIR}"

DAEMON="../../zig-out/bin/takyondb"
[ -f "${DAEMON}" ] || { echo "error: ${DAEMON} not found (run: zig build -Doptimize=ReleaseSafe)" >&2; exit 1; }
cp "${DAEMON}" "${ROOT_DIR}/${BIN_DIR}/"
chmod 755 "${ROOT_DIR}/${BIN_DIR}/takyondb"

# The bridge ships under lib/ with its real extension. zig-out/bin/takyondb_bridge.node
# and zig-out/lib/libtakyondb_bridge.dylib are the same object; the .node name is
# what Node's require() expects, and it is also the filename the SDK's prebuild
# lookup uses, so install it under the .node name and keep lib/ as the load path.
BRIDGE=""
for candidate in ../../zig-out/lib/libtakyondb_bridge.dylib ../../zig-out/bin/takyondb_bridge.node; do
  if [ -f "${candidate}" ]; then BRIDGE="${candidate}"; break; fi
done
if [ -z "${BRIDGE}" ]; then
  echo "error: no N-API bridge found in zig-out (run: zig build -Doptimize=ReleaseSafe)" >&2
  exit 1
fi
cp "${BRIDGE}" "${ROOT_DIR}/${LIB_DIR}/takyondb_bridge.node"
chmod 755 "${ROOT_DIR}/${LIB_DIR}/takyondb_bridge.node"
echo "packaged bridge from ${BRIDGE}"

cp "com.takyondb.daemon.plist" "${ROOT_DIR}/Library/LaunchDaemons/"
cp "../../README.md" "${ROOT_DIR}/${DOC_DIR}/"
cp "../../LICENSE" "${ROOT_DIR}/${DOC_DIR}/copyright"

pkgbuild --root "${ROOT_DIR}" \
         --identifier "com.takyondb.daemon" \
         --version "${VERSION}" \
         --install-location "/" \
         "${PKG_NAME}"

echo "macOS package created: ${PKG_NAME}"
echo "contents:"
pkgutil --expand "${PKG_NAME}" "${PKG_NAME}.expanded" >/dev/null 2>&1 || true
find "${ROOT_DIR}" -type f | sed 's/^/  /'
