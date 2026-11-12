// Downloads a pinned-series FFmpeg build for Windows packaging into vendor/ffmpeg.
// Explicit build step only (never run by the app). Integrity is checked against the release's
// checksums.sha256. Usage: node scripts/fetch-ffmpeg.mjs [gpl|lgpl]
// gpl  → includes libx264/libx265 (Quality CPU encoding). Redistribution obligations: docs/LICENSES.md
// lgpl → no x264/x265; exports then need a verified hardware encoder or a user-supplied FFmpeg.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const variant = process.argv[2] ?? 'gpl';
if (!['gpl', 'lgpl'].includes(variant)) throw new Error('variant must be gpl or lgpl');
const SERIES = '8.1';
const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const name = `ffmpeg-n${SERIES}-latest-win64-${variant}-${SERIES}.zip`;
const dest = path.resolve('vendor/ffmpeg');

async function get(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const sums = (await get(`${base}/checksums.sha256`)).toString();
const expected = sums.split('\n').find((l) => l.trim().endsWith(name))?.split(/\s+/)[0];
if (!expected) throw new Error(`${name} not listed in checksums.sha256`);
console.log(`downloading ${name}…`);
const zip = await get(`${base}/${name}`);
const actual = crypto.createHash('sha256').update(zip).digest('hex');
if (actual !== expected) throw new Error(`checksum mismatch: ${actual} != ${expected}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-'));
const zipPath = path.join(tmp, name);
fs.writeFileSync(zipPath, zip);
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${tmp}'`], { stdio: 'inherit' });
} else {
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmp], { stdio: 'inherit' });
}
const root = path.join(tmp, name.replace(/\.zip$/, ''));
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of ['ffmpeg.exe', 'ffprobe.exe']) fs.copyFileSync(path.join(root, 'bin', f), path.join(dest, f));
fs.copyFileSync(path.join(root, 'LICENSE.txt'), path.join(dest, 'LICENSE.txt'));
fs.writeFileSync(
  path.join(dest, 'SOURCE.txt'),
  `FFmpeg ${SERIES} (${variant}) built by BtbN/FFmpeg-Builds\nArchive: ${base}/${name}\nsha256: ${expected}\nSource code: https://github.com/FFmpeg/FFmpeg/tree/release/${SERIES}\nBuild scripts: https://github.com/BtbN/FFmpeg-Builds\n`,
);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`FFmpeg ${variant} installed in ${dest}`);
