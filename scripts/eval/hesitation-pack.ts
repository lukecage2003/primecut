// Evaluation only (not used by the app): builds a listening pack to annotate hesitations.
// Usage: npx tsx scripts/eval/hesitation-pack.ts narration.wav transcript.json outDir [controls=30]
// Candidates of every method (transcript fillers/repetitions, acoustic broad and strict) + random
// control windows (to estimate what all methods miss). Each item: stable id, clip with 1 s context,
// the methods that proposed it. annotate.html works offline (file://) and saves annotations.json.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectDisfluencies } from '../../src/production/disfluency';

const [audio, transcriptFile, outDir, nControls = '30'] = process.argv.slice(2);
if (!audio || !transcriptFile || !outDir) throw new Error('usage: hesitation-pack.ts narration.wav transcript.json outDir [controls]');
fs.mkdirSync(path.join(outDir, 'clips'), { recursive: true });
const tj = JSON.parse(fs.readFileSync(transcriptFile, 'utf8'));
const words = tj.words ?? tj;
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio]).toString());
const acousticFile = path.join(outDir, 'acoustic.json');
execFileSync('npx', ['tsx', path.join(__dirname, 'hesitations-acoustic.ts'), audio, transcriptFile, acousticFile], { stdio: 'inherit' });
const ac = JSON.parse(fs.readFileSync(acousticFile, 'utf8')) as { all: { start: number; end: number; dur: number; f0sd: number; voicing: number }[] };
type Item = { id: string; start: number; end: number; methods: string[]; kind: 'candidate' | 'control' };
const items: Item[] = [];
const add = (start: number, end: number, method: string, kind: Item['kind'] = 'candidate') => {
  const near = items.find((i) => i.kind === kind && Math.abs(i.start - start) < 0.3);
  if (near) return void (near.methods.includes(method) || near.methods.push(method));
  items.push({ id: '', start, end, methods: [method], kind });
};
for (const d of detectDisfluencies(words)) add(d.start, d.end, `transcription:${d.kind}`);
for (const c of ac.all) {
  add(c.start, c.end, 'acoustique-large');
  if (c.dur >= 0.25 && c.f0sd < 1.0 && c.voicing > 0.75) add(c.start, c.end, 'acoustique-stricte');
}
// deterministic pseudo-random control windows (3 s), away from candidates
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
for (let k = 0, tries = 0; k < Number(nControls) && tries < 1000; tries++) {
  const s = rnd() * Math.max(0, dur - 3);
  if (items.some((i) => Math.abs(i.start - s) < 3)) continue;
  add(s, s + 3, 'contrôle', 'control');
  k++;
}
const base = path.basename(audio);
items.sort((a, b) => a.start - b.start);
for (const it of items) {
  it.id = crypto.createHash('sha256').update(`${base}|${it.kind}|${it.start.toFixed(2)}`).digest('hex').slice(0, 10);
  const from = Math.max(0, it.start - 1), to = Math.min(dur, it.end + 1);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', from.toFixed(3), '-t', (to - from).toFixed(3), '-i', audio, '-ac', '1', '-c:a', 'pcm_s16le', path.join(outDir, 'clips', `${it.id}.wav`)]);
}
fs.writeFileSync(path.join(outDir, 'items.json'), JSON.stringify({ audio: base, durationSec: dur, created: new Date().toISOString(), items }, null, 1));
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Annotation des hésitations</title>
<style>body{font:14px system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;background:#111;color:#eee}
.it{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;padding:12px;border:1px solid #333;border-radius:14px;margin:10px 0}
.it.done{border-color:#4a4}.m{color:#aaa;font-size:12px}label{margin-right:10px}button{padding:8px 16px;border-radius:999px;border:0;background:#ffc400;font-weight:600}</style>
<h1>Annotation des hésitations — ${base}</h1>
<p>Écoutez chaque extrait (1 s de contexte de chaque côté). Le passage proposé est au milieu. Pour les <b>contrôles</b> (3 s au hasard),
indiquez s'il contient une hésitation. Rien n'est envoyé : le bouton enregistre un fichier <code>annotations.json</code>, à placer dans ce dossier.</p>
<p><input type="file" id="load" accept=".json"> reprendre des annotations · <button id="save">Enregistrer les annotations</button> <span id="count"></span></p>
<div id="list"></div>
<script>const ITEMS=${JSON.stringify(items)};const L=['euh / hésitation','répétition','respiration','mot normal','autre / bruit'];const ann={};
function draw(){const el=document.getElementById('list');el.innerHTML='';for(const it of ITEMS){const d=document.createElement('div');d.className='it'+(ann[it.id]?' done':'');
d.innerHTML='<div><b>'+it.start.toFixed(1)+' s</b><div class="m">'+(it.kind==='control'?'contrôle':'candidate')+'<br>'+it.id+'</div></div><div><audio controls preload="none" src="clips/'+it.id+'.wav"></audio><div class="m">proposé par : '+it.methods.join(', ')+'</div><div>'+
L.map(l=>'<label><input type="radio" name="'+it.id+'" value="'+l+'"'+(ann[it.id]===l?' checked':'')+'> '+l+'</label>').join('')+'</div></div>';
d.querySelectorAll('input').forEach(i=>i.onchange=()=>{ann[it.id]=i.value;draw();});el.appendChild(d);}
document.getElementById('count').textContent=Object.keys(ann).length+' / '+ITEMS.length+' annotés';}
document.getElementById('save').onclick=()=>{const b=new Blob([JSON.stringify({audio:${JSON.stringify(base)},annotations:ann},null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='annotations.json';a.click();};
document.getElementById('load').onchange=async e=>{const j=JSON.parse(await e.target.files[0].text());Object.assign(ann,j.annotations||{});draw();};draw();</script></html>`;
fs.writeFileSync(path.join(outDir, 'annotate.html'), html);
console.log(`${items.filter((i) => i.kind === 'candidate').length} candidate(s), ${items.filter((i) => i.kind === 'control').length} contrôle(s) → ${outDir}/annotate.html`);
