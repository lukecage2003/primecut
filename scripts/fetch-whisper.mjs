// Builds a pinned whisper.cpp CLI (MIT) into vendor/whisper for packaging. Explicit build step only
// (never run by the app). Same source tag on every platform, self-contained binary: no OpenMP
// (ggml's own thread pool), static C/C++ runtime. SOURCE.json records tag, commit and SHA-256 for the
// third-party register (docs/THIRD_PARTY.md). Usage: node scripts/fetch-whisper.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAG = 'v1.9.5';
const REPO = 'https://github.com/ggml-org/whisper.cpp';
const win = process.platform === 'win32';
const dest = path.resolve('vendor/whisper');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-')), 'src');
execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', TAG, REPO, src], { stdio: 'inherit' });
const commit = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim();
const build = path.join(src, 'build');
const flags = ['-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_OPENMP=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_SDL2=OFF'];
if (win) flags.push('-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
else flags.push('-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc');
execFileSync('cmake', ['-S', src, '-B', build, ...flags], { stdio: 'inherit' });
execFileSync('cmake', ['--build', build, '--config', 'Release', '-j', String(os.cpus().length), '--target', 'whisper-cli'], { stdio: 'inherit' });
const exe = win ? 'whisper-cli.exe' : 'whisper-cli';
const built = [path.join(build, 'bin', 'Release', exe), path.join(build, 'bin', exe)].find((p) => fs.existsSync(p));
if (!built) throw new Error(`${exe} not produced by the build`);
fs.copyFileSync(built, path.join(dest, exe));
if (!win) fs.chmodSync(path.join(dest, exe), 0o755);
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(dest, 'LICENSE-whisper.cpp.txt'));
const source = { tag: TAG, commit, url: REPO, build: `from source, static, CPU (${process.platform}-${process.arch})`, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, exe))).digest('hex') };
fs.writeFileSync(path.join(dest, 'SOURCE.json'), JSON.stringify(source, null, 1));
console.log('whisper.cpp ready in', dest, source);
