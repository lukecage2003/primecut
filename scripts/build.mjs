// Builds main + preload (esbuild, CommonJS for Electron) and the renderer (Vite).
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import fs from 'node:fs';

const dev = process.argv.includes('--dev');
fs.rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron', '@napi-rs/canvas', 'pdfjs-dist'], sourcemap: dev ? 'inline' : false, logLevel: 'warning' };
await esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
await esbuild({ ...common, entryPoints: ['src/preload/pcorePreload.ts'], outfile: 'dist/preload/pcore.js' });
// P-CORE render page (browser bundle with Three.js) for the hidden render window
await esbuild({ bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', entryPoints: ['src/pcore/renderPage.ts'], outfile: 'dist/pcore/render.js', sourcemap: false, logLevel: 'warning' });
fs.mkdirSync('dist/pcore', { recursive: true });
fs.writeFileSync('dist/pcore/render.html', '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><script src="render.js"></script></body>');
await vite({ configFile: 'vite.config.ts', logLevel: 'warn', mode: dev ? 'development' : 'production' });
console.log('build ok');
