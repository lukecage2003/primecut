// Bundles an Electron script (scripts/pcore/*.ts) next to the built app (dist/) and runs it with Electron.
// Usage: node scripts/pcore/run-electron.mjs scripts/pcore/v2-validate.ts -- args…
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const [entry, ...rest] = process.argv.slice(2);
const args = rest[0] === '--' ? rest.slice(1) : rest;
const out = path.resolve('dist/tools', path.basename(entry).replace(/\.ts$/, '.js'));
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, external: ['electron', '@napi-rs/canvas', 'pdfjs-dist'], logLevel: 'error' });
const electron = createRequire(import.meta.url)('electron');
const r = spawnSync(electron, [out, ...args, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { stdio: 'inherit' });
process.exit(r.status ?? 1);
