import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const suffix = process.platform === 'win32' ? '.exe' : '';
const localCargo = join(root, '.tools', 'cargo');
export const env = { ...process.env };
if (existsSync(join(localCargo, 'bin', `cargo${suffix}`))) {
  env.CARGO_HOME = localCargo;
  env.RUSTUP_HOME = join(root, '.tools', 'rustup');
  env.PATH = `${join(localCargo, 'bin')}${delimiter}${env.PATH ?? ''}`;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) {
    throw new Error(`Не удалось запустить ${command}: ${result.error.message}. Для Rust установите rustup: https://rustup.rs`);
  }
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status ?? result.signal}`);
  return result;
}

export function main(action) {
  try { action(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
