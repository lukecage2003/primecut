// Builds main + preload (esbuild, CommonJS for Electron) and the renderer (Vite).
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import fs from 'node:fs';

const dev = process.argv.includes('--dev');
fs.rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'], sourcemap: dev ? 'inline' : false, logLevel: 'warning' };
await esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
await vite({ configFile: 'vite.config.ts', logLevel: 'warn', mode: dev ? 'development' : 'production' });
console.log('build ok');
