// Evaluation only (not used by the app). Usage: npx tsx scripts/eval/hesitations-acoustic.ts narration.wav transcript.json out.json
// Prototype: voiced, pitch-stable stretches not covered by any transcript word = candidate filled pauses.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const [audio, transcriptFile, outFile] = process.argv.slice(2);
const SR = 16000, HOP = 160, WIN = 640; // 10 ms hop, 40 ms window
const pcm = new Float32Array(new Uint8Array(execFileSync('ffmpeg', ['-v', 'error', '-i', audio!, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })).buffer);
const tj = JSON.parse(fs.readFileSync(transcriptFile!, 'utf8'));
const words: { text: string; start: number; end: number }[] = tj.words ?? tj;
const n = Math.floor((pcm.length - WIN) / HOP);
const db = new Float32Array(n), f0 = new Float32Array(n), voi = new Float32Array(n);
for (let i = 0; i < n; i++) {
  const o = i * HOP;
  let e = 0;
  for (let k = 0; k < WIN; k++) e += pcm[o + k]! ** 2;
  db[i] = 10 * Math.log10(e / WIN + 1e-12);
  // normalised autocorrelation, 70–350 Hz
  let best = 0, lag = 0;
  for (let L = Math.floor(SR / 350); L <= Math.floor(SR / 70); L++) {
    let c = 0, a = 0, b = 0;
    for (let k = 0; k < WIN - L; k += 2) { c += pcm[o + k]! * pcm[o + k + L]!; a += pcm[o + k]! ** 2; b += pcm[o + k + L]! ** 2; }
    const r = c / Math.sqrt(a * b + 1e-12);
    if (r > best) { best = r; lag = L; }
  }
  voi[i] = best; f0[i] = lag ? SR / lag : 0;
}
const sorted = Array.from(db).sort((a, b) => a - b);
const floor = sorted[Math.floor(n * 0.1)]!, speech = sorted[Math.floor(n * 0.7)]!;
const gate = floor + 0.5 * (speech - floor);
const covered = new Uint8Array(n);
for (const w of words) for (let i = Math.max(0, Math.floor((w.start - 0.03) * 100)); i < Math.min(n, Math.ceil((w.end + 0.03) * 100)); i++) covered[i] = 1;
const cands: any[] = [];
let i = 0;
while (i < n) {
  if (covered[i] || db[i]! < gate || voi[i]! < 0.6) { i++; continue; }
  let j = i;
  while (j < n && !covered[j] && db[j]! >= gate - 3 && voi[j]! >= 0.5) j++;
  const dur = (j - i) / 100;
  if (dur >= 0.15 && dur <= 1.6) {
    const fs_ = Array.from(f0.slice(i, j)).filter((x) => x > 0).map((x) => 12 * Math.log2(x / 100));
    const m = fs_.reduce((a, b) => a + b, 0) / fs_.length;
    const sd = Math.sqrt(fs_.reduce((a, b) => a + (b - m) ** 2, 0) / fs_.length);
    cands.push({ start: i / 100, end: j / 100, dur: +dur.toFixed(2), f0sd: +sd.toFixed(2), voicing: +(Array.from(voi.slice(i, j)).reduce((a, b) => a + b, 0) / (j - i)).toFixed(2) });
  }
  i = j;
}
const filled = cands.filter((c) => c.f0sd < 1.5 && c.voicing > 0.75);
fs.writeFileSync(outFile!, JSON.stringify({ minutes: pcm.length / SR / 60, all: cands, filled }, null, 1));
console.log(`${(pcm.length / SR / 60).toFixed(1)} min : ${cands.length} plages voisées hors mots, ${filled.length} candidates « euh » (hauteur stable)`);
