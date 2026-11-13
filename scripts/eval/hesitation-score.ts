// Evaluation only: precision / recall / false alarms per method from an annotated pack.
// Usage: npx tsx scripts/eval/hesitation-score.ts packDir [annotations.json]
import fs from 'node:fs';
import path from 'node:path';
const [dir, annFile] = process.argv.slice(2);
const { items, durationSec } = JSON.parse(fs.readFileSync(path.join(dir!, 'items.json'), 'utf8'));
const { annotations } = JSON.parse(fs.readFileSync(annFile ?? path.join(dir!, 'annotations.json'), 'utf8'));
const isH = (l?: string) => l === 'euh / hésitation' || l === 'répétition';
const done = items.filter((i: any) => annotations[i.id]);
const controls = done.filter((i: any) => i.kind === 'control');
const missedInControls = controls.filter((i: any) => isH(annotations[i.id])).length;
const methods = [...new Set(items.flatMap((i: any) => i.methods))].filter((m) => m !== 'contrôle') as string[];
const truths = done.filter((i: any) => i.kind === 'candidate' && isH(annotations[i.id]));
// hesitations outside every candidate, estimated from the random controls (3 s each)
const missRate = controls.length ? missedInControls / (controls.length * 3) : NaN; // per second of audio
const estMissed = missRate * durationSec;
console.log(`annotés : ${done.length}/${items.length} ; hésitations confirmées parmi les candidates : ${truths.length} ; dans les contrôles : ${missedInControls}/${controls.length}`);
for (const m of methods) {
  const prop = done.filter((i: any) => i.kind === 'candidate' && i.methods.includes(m));
  const tp = prop.filter((i: any) => isH(annotations[i.id])).length;
  const fp = prop.length - tp;
  const recall = truths.length + estMissed > 0 ? tp / (truths.length + estMissed) : NaN;
  console.log(`${m.padEnd(28)} proposées ${String(prop.length).padStart(3)} · précision ${(prop.length ? tp / prop.length : NaN).toFixed(2)} · rappel estimé ${recall.toFixed(2)} · fausses alarmes ${(fp / (durationSec / 60)).toFixed(2)}/min`);
}
if (controls.length < 20) console.log('⚠ moins de 20 contrôles annotés : le rappel estimé est très incertain.');
