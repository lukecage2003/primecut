// Puts a pinned whisper.cpp CLI (MIT) into vendor/whisper for packaging. Explicit build step only
// (never run by the app). Windows: the official release archive (CPU build, x64). Linux: a static
// build from the tagged source. SOURCE.json records version, origin and SHA-256 for the
// third-party register (docs/THIRD_PARTY.md). Usage: node scripts/fetch-whisper.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAG = 'v1.9.5';
const dest = path.resolve('vendor/whisper');
fs.mkdirSync(dest, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
let source;

if (process.platform === 'win32') {
  const name = 'whisper-bin-x64.zip';
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/${name}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const zip = Buffer.from(await r.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  const zipPath = path.join(tmp, name);
  fs.writeFileSync(zipPath, zip);
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${tmp}\\x'`], { stdio: 'inherit' });
  // the archive holds a Release/ folder: whisper-cli.exe and the DLLs it needs
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(path.join(tmp, 'x'));
  const cli = files.find((f) => path.basename(f).toLowerCase() === 'whisper-cli.exe');
  if (!cli) throw new Error('whisper-cli.exe not found in the release archive');
  for (const f of files.filter((f) => path.dirname(f) === path.dirname(cli) && /\.(dll|exe)$/i.test(f) && !/(-bench|-server|-stream|-command|-talk|quantize|test)/i.test(path.basename(f)))) fs.copyFileSync(f, path.join(dest, path.basename(f)));
  source = { tag: TAG, url, sha256, build: 'official release, CPU x64' };
} else {
  const src = path.join(tmp, 'src');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp', src], { stdio: 'inherit' });
  const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('cmake', ['-S', src, '-B', path.join(src, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF'], { stdio: 'inherit' });
  execFileSync('cmake', ['--build', path.join(src, 'build'), '-j', String(os.cpus().length), '--target', 'whisper-cli'], { stdio: 'inherit' });
  fs.copyFileSync(path.join(src, 'build', 'bin', 'whisper-cli'), path.join(dest, 'whisper-cli'));
  fs.chmodSync(path.join(dest, 'whisper-cli'), 0o755);
  source = { tag: TAG, commit, url: 'https://github.com/ggml-org/whisper.cpp', build: 'static, from source, CPU', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, 'whisper-cli'))).digest('hex') };
}
// the MIT licence text of the exact tag travels with the binary
const lic = await fetch(`https://raw.githubusercontent.com/ggml-org/whisper.cpp/${TAG}/LICENSE`);
if (!lic.ok) throw new Error(`LICENSE: HTTP ${lic.status}`);
fs.writeFileSync(path.join(dest, 'LICENSE-whisper.cpp.txt'), await lic.text());
fs.writeFileSync(path.join(dest, 'SOURCE.json'), JSON.stringify(source, null, 1));
console.log('whisper.cpp ready in', dest, source);
