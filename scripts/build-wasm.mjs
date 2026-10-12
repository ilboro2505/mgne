import { join } from 'node:path';
import { setup } from './setup.mjs';
import { main, root, run } from './tooling.mjs';

main(() => {
  const bindgen = setup();
  run('cargo', ['build', '--locked', '--release', '-p', 'mgne-core', '--target', 'wasm32-unknown-unknown', '--features', 'wasm']);
  run(bindgen, [join(root, 'target/wasm32-unknown-unknown/release/mgne_core.wasm'), '--target', 'web', '--out-dir', join(root, 'web/src/wasm')]);
});
