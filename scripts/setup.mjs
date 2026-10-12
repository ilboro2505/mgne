import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, root, run, suffix } from './tooling.mjs';

export function setup() {
  run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
  if (!existsSync(join(root, 'Cargo.lock'))) run('cargo', ['generate-lockfile']);
  const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  const version = lock.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/)?.[1];
  if (!version) throw new Error('В Cargo.lock отсутствует wasm-bindgen. Проверьте зависимости ядра.');
  const installRoot = join(root, '.tools', 'wasm-bindgen');
  const binary = join(installRoot, 'bin', `wasm-bindgen${suffix}`);
  if (existsSync(binary)) {
    const installed = run(binary, ['--version'], { stdio: 'pipe', encoding: 'utf8' }).stdout.trim();
    if (installed === `wasm-bindgen ${version}`) return binary;
  }
  run('cargo', ['install', 'wasm-bindgen-cli', '--version', version, '--locked', '--root', installRoot]);
  return binary;
}

if (process.argv[1] && fileIsMain()) main(setup);
function fileIsMain() { return pathToFileURL(process.argv[1]).href === import.meta.url; }
