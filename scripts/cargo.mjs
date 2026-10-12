import { main, run } from './tooling.mjs';
main(() => run('cargo', process.argv.slice(2)));
