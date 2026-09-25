// Pre-publish guard: refuse to produce a tarball that cannot be installed.
//
// `npm pack` does not compile TypeScript, so a job that ran only `npm ci`
// would publish a package whose `main` (dist/index.js) does not exist. That
// shipped as a CI failure the first time pack-smoke ran, on all three
// platforms, and nothing before it noticed.
//
// Runs on every `npm pack` / `npm publish`. Copying LICENSE still happens
// here so the license ships with the package.
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  ['dist/index.js', 'the package entry point (run: npm run build)'],
  ['dist/client/addon.js', 'the native addon loader'],
];

let bad = 0;
for (const [rel, why] of required) {
  const p = join(root, rel);
  if (!existsSync(p)) {
    console.error(`prepack: missing ${rel} - ${why}`);
    bad++;
  }
}

// A prebuild is platform specific, so only warn when none is staged: a
// maintainer packing on one platform cannot stage the others, and the
// release job assembles all three before publishing.
if (!existsSync(join(root, 'prebuilds'))) {
  console.warn(
    'prepack: warning - no prebuilds/ directory staged. A consumer on this platform ' +
      'will get an actionable "addon not found" error instead of a working addon. ' +
      'The release job stages prebuilds/<platform>-<arch>/ from the CI artifacts.'
  );
}

if (bad > 0) {
  console.error(`prepack: refusing to pack (${bad} required file(s) missing).`);
  process.exit(1);
}

const licenseSrc = join(root, '..', '..', 'LICENSE');
if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, join(root, 'LICENSE'));
  console.log(`prepack: staged LICENSE (${statSync(join(root, 'LICENSE')).size} bytes)`);
}
console.log('prepack: ok');
