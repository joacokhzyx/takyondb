#!/usr/bin/env node
'use strict';

// Proves the published package is actually installable and usable.
//
// The defect this closes: `npm install takyondb` shipped only `dist/`, with
// no native addon, and nothing in CI ever installed the tarball, so the
// documented quickstart could not run and nobody noticed until a user tried.
//
// What this does, end to end, on each CI OS:
//   1. npm pack the package (with prebuilds/<platform>-<arch>/ assembled, as
//      the release job does).
//   2. Install that tarball into a temp dir OUTSIDE the repository, so the
//      monorepo's SDK and node_modules cannot satisfy any require() and hide
//      a packaging mistake.
//   3. Start the daemon binary and drive the *installed* package: load the
//      addon through the public API, insert, find, update, delete, plus a
//      native prefix scan.
//   4. Assert the relational engine works too, since it needs no addon.
//
// Usage: node scripts/pack_smoke.js [--keep]

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startDaemon, stopDaemon, waitForNoStrays } = require('./helpers/daemon');

const REPO_ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(REPO_ROOT, 'src', 'sdk', 'ts');
const KEEP = process.argv.includes('--keep');

const PLATFORM_KEY = `${process.platform}-${process.arch}`;

function step(msg) {
    console.log(`[pack-smoke] ${msg}`);
}

function fail(msg) {
    console.error(`[pack-smoke] FAIL: ${msg}`);
    process.exit(1);
}

function rmrf(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
        // Best effort.
    }
}

function cleanShm() {
    if (process.platform === 'linux') {
        try {
            fs.unlinkSync('/dev/shm/TakyonDB_Master');
        } catch (e) {}
    } else if (process.platform === 'darwin') {
        try {
            fs.unlinkSync('/tmp/takyondb_TakyonDB_Master');
        } catch (e) {}
    }
}

/** Mirror the release job: stage the freshly built addon as a prebuild. */
function assemblePrebuild() {
    const source = path.join(REPO_ROOT, 'zig-out', 'bin', 'takyondb_bridge.node');
    if (!fs.existsSync(source)) {
        fail(`addon not built at ${source} (run: zig build -Doptimize=ReleaseSafe)`);
    }
    const dest = path.join(PKG_DIR, 'prebuilds', PLATFORM_KEY);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(source, path.join(dest, 'takyondb_bridge.node'));
    step(`assembled prebuilds/${PLATFORM_KEY}/takyondb_bridge.node`);
}

/**
 * Build the SDK dist before packing.
 *
 * `npm pack` does not compile TypeScript, so a job that only ran `npm ci`
 * packed a tarball with no dist/ at all: the very first CI run of this
 * harness failed on all three platforms with "Cannot find module
 * .../takyondb/dist/index.js". That is precisely the class of defect this
 * job exists to catch, and it would have shipped a package whose main entry
 * point did not exist. Building here makes the harness self-contained.
 */
function buildDist() {
    step('building the SDK dist (npm pack does not compile TypeScript)');
    execFileSync('npm', ['run', 'build'], {
        cwd: PKG_DIR,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    const entry = path.join(PKG_DIR, 'dist', 'index.js');
    if (!fs.existsSync(entry)) {
        fail(`dist/index.js missing after build: the tarball would have no entry point`);
    }
}

function pack() {
    step('npm pack');
    const out = execFileSync('npm', ['pack', '--pack-destination', REPO_ROOT], {
        cwd: PKG_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });
    const lines = out.trim().split('\n');
    const tarball = path.resolve(REPO_ROOT, lines[lines.length - 1].trim());
    if (!fs.existsSync(tarball)) fail(`npm pack did not produce ${tarball}`);
    step(`packed ${path.basename(tarball)}`);
    return tarball;
}

function installInto(tarball, dest) {
    step(`installing the tarball into a clean dir outside the repo: ${dest}`);
    fs.mkdirSync(dest, { recursive: true });
    // `npm init -y` first so npm does not walk up and find the monorepo.
    fs.writeFileSync(
        path.join(dest, 'package.json'),
        JSON.stringify({ name: 'pack-smoke-consumer', version: '1.0.0', private: true }, null, 2)
    );
    execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
        cwd: dest,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });
}

const CONSUMER = `
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

// Resolve ONLY from node_modules: no monorepo fallback, or this test proves
// nothing about the published artifact.
const installed = path.join(__dirname, 'node_modules', 'takyondb');
const takyondb = require(installed);

function check(what, fn) {
    try {
        fn();
        console.log('  ok ' + what);
    } catch (err) {
        console.error('  FAIL ' + what + ': ' + (err && err.message ? err.message : err));
        process.exitCode = 1;
    }
}

check('public API is importable from the installed package', () => {
    for (const name of ['TakyonDB', 'TakyonSchema', 'RelationalDatabase', 'QueryBuilder', 'loadBindings']) {
        assert.ok(takyondb[name], 'missing export: ' + name);
    }
});

check('relational engine works with no native addon', () => {
    const db = new takyondb.RelationalDatabase();
    const users = db.createTable('users', [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'age', type: 'uint32' },
    ]);
    users.insert({ id: 'u1', age: 28 });
    users.insert({ id: 'u2', age: 41 });
    const all = new takyondb.QueryBuilder(users).all();
    assert.strictEqual(all.length, 2, 'expected 2 rows, got ' + all.length);
    const adults = new takyondb.QueryBuilder(users).where({ age: { gte: 40 } }).all();
    assert.strictEqual(adults.length, 1, 'expected 1 adult, got ' + adults.length);
});

// Native path: the whole point of the prebuild.
let db = null;
check('loadBindings() finds the bundled prebuild', () => {
    const resolution = takyondb.resolveAddon();
    console.log('     resolved via ' + resolution.source + ': ' + resolution.path);
    assert.ok(resolution.path.includes(path.join('prebuilds', process.platform + '-' + process.arch)),
        'expected a bundled prebuild, got ' + resolution.path);
    db = new takyondb.TakyonDB();
});

if (db) {
    const Arena = 16 * 1024 * 1024;
    const UserSchema = new takyondb.TakyonSchema({ username: 'string', age: 'uint32' });
    const users = db.collection('smoke', UserSchema);

    check('insert + find round-trips through shared memory', () => {
        users.insert('u1', { username: 'Alice', age: 28 });
        users.insert('u2', { username: 'Bob', age: 41 });
        const alice = users.find('u1');
        assert.ok(alice, 'u1 not found');
        assert.strictEqual(alice.username, 'Alice');
        assert.strictEqual(alice.age, 28);
    });

    check('update is visible', () => {
        users.update('u1', { age: 29 });
        assert.strictEqual(users.find('u1').age, 29);
    });

    check('delete removes the row', () => {
        users.delete('u2');
        assert.strictEqual(users.find('u2'), null, 'u2 should be gone');
    });

    check('native prefix scan works', () => {
        const bindings = takyondb.loadBindings();
        // Distinct namespace: collection('smoke') already owns the 'smoke:'
        // prefix, so reusing it would count that row too.
        for (let i = 0; i < 50; i++) {
            assert.strictEqual(bindings.insert_index('scanprobe:' + String(i).padStart(3, '0'), 400000 + i * 64), 0);
        }
        const hits = Array.from(bindings.scan_prefix('scanprobe:', 128));
        assert.strictEqual(hits.length, 50, 'expected 50 scan hits, got ' + hits.length);
        const ranged = Array.from(bindings.scan_range('scanprobe:', '010', '019', 64));
        assert.strictEqual(ranged.length, 10, 'expected 10 ranged hits, got ' + ranged.length);
    });

    check('admin TCP endpoint answers PING and METRICS', () => {
        const net = require('net');
        const port = Number(process.env.TAKYON_ADMIN_PORT);
        assert.ok(port > 0, 'TAKYON_ADMIN_PORT not provided to the consumer');
        const reply = (payload) => new Promise((resolve, reject) => {
            const sock = net.connect(port, '127.0.0.1', () => sock.write(payload + '\\n'));
            let data = '';
            sock.on('data', (c) => { data += c.toString(); if (data.includes('\\n')) sock.end(); });
            sock.on('close', () => resolve(data.trim()));
            sock.on('error', reject);
            setTimeout(() => reject(new Error('timeout on ' + payload)), 5000);
        });
        // Await inside a sync check() is not possible, so drive it with an
        // explicit promise chain and surface the failure via exitCode.
        return reply('PING')
            .then((pong) => {
                assert.strictEqual(pong, 'PONG', 'expected PONG, got ' + pong);
                return reply('METRICS');
            })
            .then((metrics) => {
                assert.ok(/^METRICS ring_depth=\\d+/.test(metrics), 'unexpected METRICS: ' + metrics);
                console.log('     ' + metrics);
            })
            .catch((err) => {
                console.error('  FAIL admin TCP: ' + err.message);
                process.exitCode = 1;
            });
    });
}
`;

async function main() {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-pack-smoke-'));
    const consumer = path.join(workdir, 'consumer');
    let tarball = null;
    let daemon = null;
    let exitCode = 0;

    try {
        buildDist();
        assemblePrebuild();
        tarball = pack();
        installInto(tarball, consumer);

        step('running the consumer against the installed package');
        const daemonBin = path.join(
            REPO_ROOT,
            'zig-out',
            'bin',
            process.platform === 'win32' ? 'takyondb.exe' : 'takyondb'
        );
        if (!fs.existsSync(daemonBin)) fail(`daemon binary not found at ${daemonBin}`);
        cleanShm();
        // 64 MiB on both sides: the consumer constructs `new TakyonDB()` with
        // no arguments, i.e. the documented default, so the daemon must run
        // with the same default or the connect is refused (SizeMismatch).
        daemon = await startDaemon({ args: [String(64 * 1024 * 1024)] });

        fs.writeFileSync(path.join(consumer, 'smoke.js'), CONSUMER);
        try {
            execFileSync(process.execPath, ['smoke.js'], {
                cwd: consumer,
                stdio: 'inherit',
                env: { ...process.env, TAKYON_ADMIN_PORT: String(daemon.adminPort || 7723) },
            });
        } catch (e) {
            console.error('[pack-smoke] FAIL: the consumer script reported failures');
            exitCode = 1;
        }

        if (daemon) {
            await stopDaemon(daemon);
            daemon = null;
        }
        cleanShm();
    } catch (err) {
        console.error(`[pack-smoke] FAIL: ${err && err.stack ? err.stack : err}`);
        exitCode = 1;
    } finally {
        if (daemon) await stopDaemon(daemon);
        cleanShm();
        if (tarball) rmrf(tarball);
        rmrf(path.join(PKG_DIR, 'prebuilds'));
        const strays = await waitForNoStrays({ graceMs: 2000 });
        if (strays.pids.length > 0) {
            console.error(`[pack-smoke] FAIL: stray daemons left behind: ${strays.pids.join(', ')}`);
            exitCode = 1;
        }
        if (KEEP) {
            step(`--keep: leaving ${workdir}`);
        } else {
            rmrf(workdir);
        }
    }

    if (exitCode === 0) {
        console.log('[pack-smoke] SUCCESS: the published package installs and works.');
    }
    // Set exitCode instead of calling process.exit: stdout is asynchronous
    // when it is a pipe or a file, so exiting immediately truncates the
    // final line (and any FAIL diagnostics) on the way out.
    process.exitCode = exitCode;
}

main();
