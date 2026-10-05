// E2E: the energy counter is reported honestly, in both directions.
//
// Two claims are checked, and both can fail:
//
//   1. With no readable counter (every CI runner, and every container), the
//      daemon reports `energy_source=none` with zero microjoules and zero
//      samples. A daemon that published a joule count without a sensor
//      would be synthesizing energy from CPU time, which is the one thing
//      the measurement contract forbids.
//   2. With a readable counter, the daemon names the source and accumulates.
//      The counter is a fixture tree passed through `--energy-root`, because
//      a test cannot write to /sys/class/powercap and a host without RAPL
//      would otherwise leave this path with no coverage at all.
//
// Without (2) the sampler would be exercised only on the machines that
// happen to have the sensor, which is how untested code reaches a claim.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ARENA_SIZE = 16 * 1024 * 1024;

const { READY, withDaemon } = require('./helpers/daemon');

function fail(msg) {
  console.error(`[E2E Energy] FAILURE: ${msg}`);
  process.exit(1);
}

function cmd(port, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(payload + '\n'));
    let data = '';
    sock.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) sock.end();
    });
    sock.on('close', () => resolve(data.trim()));
    sock.on('error', reject);
    setTimeout(() => reject(new Error(`timeout on ${payload}`)), 5000);
  });
}

function parseMetrics(line) {
  const fields = {};
  for (const part of line.split(/\s+/).slice(1)) {
    const i = part.indexOf('=');
    if (i > 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  return fields;
}

/**
 * Builds a powercap-shaped fixture. Fixed-width values so overwriting the
 * counter in place never leaves a half-written file for the sampler to
 * fail to parse.
 */
function makeFixtureRoot(dir, initialValue) {
  const domain = path.join(dir, 'intel-rapl:0');
  fs.mkdirSync(domain, { recursive: true });
  fs.writeFileSync(path.join(domain, 'max_energy_range_uj'), `${Number.MAX_SAFE_INTEGER}\n`);
  fs.writeFileSync(path.join(domain, 'energy_uj'), `${String(initialValue).padStart(20, '0')}\n`);
  return domain;
}

function bump(domain, value) {
  const fd = fs.openSync(path.join(domain, 'energy_uj'), 'r+');
  try {
    fs.writeSync(fd, `${String(value).padStart(20, '0')}\n`, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function noSensor() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-energy-'));
  console.log('[E2E Energy] Daemon against the real sysfs root (no fixture)...');
  await withDaemon(
    { args: [String(ARENA_SIZE), '--data-dir', dataDir], readyPattern: READY.admin },
    async (daemon) => {
      const m = parseMetrics(await cmd(daemon.adminPort, 'METRICS'));
      console.log(
        `[E2E Energy] host sensor: source=${m.energy_source} uj=${m.energy_uj} samples=${m.energy_samples}`
      );
      if (m.energy_source === 'none') {
        if (m.energy_uj !== '0') return fail(`energy_uj=${m.energy_uj} with no sensor`);
        if (m.energy_samples !== '0') return fail(`energy_samples=${m.energy_samples} with no sensor`);
        console.log('[E2E Energy] OK: no sensor means zero joules and zero samples.');
      } else {
        // This host has a counter, so the honest-reporting claim is checked
        // through the fixture run below instead.
        console.log('[E2E Energy] SKIP: this host has a readable counter.');
      }
    }
  );
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function withSensor() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-energy-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-powercap-'));
  const domain = makeFixtureRoot(root, 1000);

  console.log('[E2E Energy] Daemon against a fixture counter tree...');
  await withDaemon(
    {
      args: [String(ARENA_SIZE), '--data-dir', dataDir, '--energy-root', root],
      readyPattern: READY.admin,
    },
    async (daemon) => {
      const port = daemon.adminPort;

      // Wait for the first sample before moving the counter: a sampler that
      // only ever sees one value accumulates nothing, and this suite would
      // not be able to tell that from a sampler that is wired up wrong.
      let first = parseMetrics(await cmd(port, 'METRICS'));
      let spins = 0;
      while (Number(first.energy_samples) < 1 && spins < 30) {
        spins += 1;
        await sleep(200);
        first = parseMetrics(await cmd(port, 'METRICS'));
      }
      if (first.energy_source !== 'rapl-package') {
        return fail(`expected a fixture counter to be named, got energy_source=${first.energy_source}`);
      }
      if (Number(first.energy_samples) < 1) return fail('sampler never took a reading');

      bump(domain, 7500);

      let m = first;
      spins = 0;
      while (Number(m.energy_uj) === 0 && spins < 30) {
        spins += 1;
        await sleep(200);
        m = parseMetrics(await cmd(port, 'METRICS'));
      }
      if (Number(m.energy_uj) <= 0) {
        return fail(`counter moved to 7500 but energy_uj stayed ${m.energy_uj}`);
      }
      if (m.energy_read_errors !== '0') {
        return fail(`${m.energy_read_errors} read errors against a readable counter`);
      }
      console.log(`[E2E Energy] OK: source=${m.energy_source} uj=${m.energy_uj} samples=${m.energy_samples}`);
    }
  );

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

async function disabled() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-energy-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takyon-powercap-'));
  makeFixtureRoot(root, 1000);

  console.log('[E2E Energy] Daemon with --no-energy against a fixture counter...');
  await withDaemon(
    {
      args: [String(ARENA_SIZE), '--data-dir', dataDir, '--energy-root', root, '--no-energy'],
      readyPattern: READY.admin,
    },
    async (daemon) => {
      await sleep(1200);
      const m = parseMetrics(await cmd(daemon.adminPort, 'METRICS'));
      if (m.energy_samples !== '0') {
        return fail(`--no-energy still sampled: energy_samples=${m.energy_samples}`);
      }
      if (m.energy_uj !== '0') return fail(`--no-energy still accumulated: energy_uj=${m.energy_uj}`);
      console.log('[E2E Energy] OK: --no-energy spawns no sampler.');
    }
  );

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

async function run() {
  await noSensor();
  await withSensor();
  await disabled();
  console.log('[E2E Energy] SUCCESS: energy reporting is honest in both directions.');
  process.exit(0);
}

run().catch((e) => fail(e.message));
