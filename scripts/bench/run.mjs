// Bundles scripts/bench/bench.ts with esbuild (already a dev dependency) and runs it: no extra tool.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bench-')), 'bench.cjs');
await build({ entryPoints: [path.join(here, 'bench.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, external: ['electron'], logLevel: 'error' });
const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd(), env: { ...process.env, PRIMESTONE_ROOT: path.resolve(here, '../..') } });
process.exit(r.status ?? 1);
