import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import init, { Simulation } from '../web/src/wasm/mgne_core.js';
import { root, env, suffix, run } from '../scripts/tooling.mjs';

await init({ module_or_path: readFileSync(join(root, 'web/src/wasm/mgne_core_bg.wasm')) });
run('cargo', ['build', '--locked', '-p', 'mgne-cli']);
const binary = join(root, 'target/debug', `mgne${suffix}`);
const fixture = (name) => join(root, 'examples', `${name}.json`);
const config = (name) => readFileSync(fixture(name), 'utf8');

function native(command, input, count) {
  const result = spawnSync(binary, [command, command === 'run' ? '--config' : '--snapshot', input, '--events', String(count)],
    { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

// Native and WASM transcendental functions need not be bit-identical. Compare
// structural event identity exactly, and numbers with a documented tolerance.
function close(actual, expected, path = '$') {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    assert.ok(Number.isFinite(actual), path);
    assert.ok(Math.abs(actual - expected) <= 1e-10 + 1e-11 * Math.abs(expected), `${path}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((value, index) => close(actual[index], value, `${path}[${index}]`));
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const key of Object.keys(expected)) close(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

for (const name of ['ring', 'refractory-ring', 'detector-ring', 'oscillator', 'silent-detector']) {
  test(`native/WASM: ${name}, 1000 event groups`, () => {
    const simulation = new Simulation(config(name));
    try { close(JSON.parse(simulation.step(1000)), native('run', fixture(name), 1000)); }
    finally { simulation.free(); }
  });
}

test('long ring run keeps native/WASM event identities through numerical phase convergence', () => {
  const simulation = new Simulation(config('ring'));
  try { close(JSON.parse(simulation.step(12000)), native('run', fixture('ring'), 12000)); }
  finally { simulation.free(); }
});

test('causal cascade preserves distinct positive intervals at the same rounded timestamp', () => {
  const file = join(root, 'tests/fixtures/causal-cascade.json');
  const simulation = new Simulation(readFileSync(file, 'utf8'));
  try {
    const actual = JSON.parse(simulation.step(2));
    close(actual, native('run', file, 2));
    assert.deepEqual(actual.events.map(event => event.spikes), [['source'], ['target']]);
    assert.equal(actual.events[0].time, actual.events[1].time);
    assert.ok(actual.events[1].delta > 0);
    assert.ok(Number.isFinite(actual.snapshot.timeCorrection));
    const restored = Simulation.fromSnapshot(JSON.stringify(actual.snapshot));
    try { close(JSON.parse(restored.step(200)), JSON.parse(simulation.step(200))); }
    finally { restored.free(); }
  } finally { simulation.free(); }
});

test('WASM analytical oscillator period and no artificial event in a silent detector', () => {
  const oscillator = new Simulation(config('oscillator'));
  const silent = new Simulation(config('silent-detector'));
  try {
    const result = JSON.parse(oscillator.step(10));
    const times = result.events.filter(event => event.spikes.length).map(event => event.time);
    const firstSpike = 2 * Math.log(20 / 3);
    close(times[0], firstSpike);
    times.slice(1).forEach((time, index) => close(time - times[index], 3 + firstSpike));
    const quiet = JSON.parse(silent.step(1000));
    assert.equal(quiet.halted, true);
    assert.equal(quiet.snapshot.time, 0);
    assert.deepEqual(quiet.events, []);
  } finally { oscillator.free(); silent.free(); }
});

test('WASM rejects wrapping or fractional counts without changing state', () => {
  const simulation = new Simulation(config('ring'));
  try {
    const initial = simulation.snapshot();
    for (const count of [-1, 0.5, NaN, Infinity, 100001, 2 ** 32]) assert.throws(() => simulation.step(count));
    assert.equal(simulation.snapshot(), initial);
    assert.deepEqual(JSON.parse(simulation.step(0)).events, []);
  } finally { simulation.free(); }
});

test('cross-runtime snapshots resume the same trajectory in both directions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mgne-parity-'));
  const fromNative = Simulation.fromSnapshot(JSON.stringify(native('run', fixture('detector-ring'), 37).snapshot));
  const original = new Simulation(config('detector-ring'));
  try {
    const checkpoint = JSON.parse(original.step(37)).snapshot;
    const file = join(directory, 'snapshot.json');
    writeFileSync(file, JSON.stringify(checkpoint));
    const continued = JSON.parse(original.step(200));
    close(JSON.parse(fromNative.step(200)), continued);
    close(native('resume', file, 200), continued);
  } finally { fromNative.free(); original.free(); rmSync(directory, { recursive: true, force: true }); }
});
