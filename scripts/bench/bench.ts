/**
 * Primestone benchmark against HUMAN annotations (no circular, synthetic relevance). Formats and
 * protocol: docs/BENCHMARK.md. Every result states how many annotated items it rests on; with no
 * annotation there is no score.
 *
 *   npm run bench -- pages    <pages.json> <images-dir> [--ocr fra+eng] [--out dir]
 *   npm run bench -- search   <queries.json> <media-folder> [--ocr fra+eng] [--out dir]
 *   npm run bench -- script   <script-annotation.json> [--out dir]
 *   npm run bench -- template <project.psproj> [sequence name] > judgements.json
 *   npm run bench -- shots    <judgements.json> [--out dir]
 *
 * Media stay on this computer; only scores are written (docs/benchmark/ when --out is given).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPagePanels, scanMediaFolders } from '../../src/engine/production';
import { readProjectFile } from '../../src/engine/projectStore';
import { probeMedia } from '../../src/engine/probe';
import { findTesseract, ocrImage } from '../../src/engine/ocr';
import { EntityIndex, SEED_KNOWLEDGE, parseScript, scriptEntities } from '../../src/production';
import { analyseNarrative } from '../../src/production/narrative';
import { searchEntries } from '../../src/production/search';
import { type JudgementsFile, type PagesFile, type QueriesFile, type ScriptAnnotation, cer, cohenKappa, matchBoxes, ndcgAtK, recallAtK, scoreJudgements, scorePanels, spearman } from '../../src/bench/metrics';

const args = process.argv.slice(2);
const flag = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
const [cmd, a1, a2] = pos;
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8')) as T;
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)} %` : 'n/a');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

function save(name: string, result: unknown) {
  const out = flag('--out');
  const body = { benchmark: name, at: new Date().toISOString(), machine: `${os.cpus()[0]?.model ?? '?'} · ${os.cpus().length} threads · ${Math.round(os.totalmem() / 2 ** 30)} Go`, result };
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const f = path.join(out, `${name}-${body.at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(f, JSON.stringify(body, null, 2));
    console.log(`résultat enregistré : ${f}`);
  }
}

async function pages(file: string, dir: string) {
  const ann = readJson<PagesFile>(file);
  if (ann.format !== 'primestone-bench/pages@1') throw new Error('format attendu : primestone-bench/pages@1');
  const ocrLang = flag('--ocr');
  if (ocrLang && !findTesseract()) throw new Error('--ocr demandé mais Tesseract est introuvable');
  const items: { truth: typeof ann.pages[number]['panels']; predicted: typeof ann.pages[number]['panels'] }[] = [];
  const cers: number[] = [];
  const conf: { c: number; ok: boolean }[] = [];
  for (const p of ann.pages) {
    const f = path.join(dir, p.file);
    const { probe } = await probeMedia(f);
    const v = probe.video!;
    const det = await detectPagePanels(f, v.width, v.height);
    const predicted = det?.panels ?? [{ x: 0, y: 0, w: 1, h: 1 }];
    items.push({ truth: p.panels, predicted });
    const strict = matchBoxes(predicted, p.panels, 0.8).length;
    conf.push({ c: det?.confidence ?? 0, ok: p.panels.length > 0 && strict / p.panels.length >= 0.85 });
    if (ocrLang && p.texts?.length) {
      const o = await ocrImage(f, { enabled: true, languages: ocrLang });
      cers.push(cer(o.text, p.texts.map((t) => t.text).join('\n')));
    }
    process.stdout.write('.');
  }
  console.log('');
  const s = scorePanels(items);
  const hi = conf.filter((x) => x.c >= 0.7);
  const result = { annotator: ann.annotator, ...s, ocrPages: cers.length, ocrMeanCer: cers.length ? cers.reduce((a, b) => a + b, 0) / cers.length : null, confidenceCalibration: { highConfidencePages: hi.length, highConfidenceCorrect: hi.filter((x) => x.ok).length } };
  console.log(`B1 cases · ${s.pages} page(s), ${s.truthPanels} case(s) annotée(s)`);
  console.log(`  précision ${pct(s.precision)} · rappel ${pct(s.recall)} (IoU ≥ 0,5) · IoU moyenne ${num(s.meanIou)} · ordre de lecture τ ${num(s.readingOrderTau)}`);
  console.log(`  pages au critère (≥ 85 % des cases à IoU ≥ 0,8) : ${s.pagesMeetingCriterion}/${s.pages}`);
  console.log(`  confiance ≥ 0,7 : ${hi.filter((x) => x.ok).length}/${hi.length} pages réellement correctes`);
  if (cers.length) console.log(`  OCR : CER moyen ${pct(result.ocrMeanCer!)} sur ${cers.length} page(s)`);
  save('B1-pages', result);
}

async function search(file: string, folder: string) {
  const q = readJson<QueriesFile>(file);
  if (q.format !== 'primestone-bench/queries@1') throw new Error('format attendu : primestone-bench/queries@1');
  const ocrLang = flag('--ocr');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-bench-'));
  const scan = await scanMediaFolders([folder], tmp, new Set(), undefined, 100000, { indexFile: path.join(tmp, 'index.json'), ocr: ocrLang ? { enabled: true, languages: ocrLang } : undefined });
  const rel = (p: string) => path.relative(folder, p).split(path.sep).join('/');
  const rows = q.queries.map((x) => {
    const ranked = searchEntries(scan.assets, x.query, 50).map((h) => rel(h.item.path));
    return { query: x.query, relevant: x.relevant.length, recall10: recallAtK(ranked, x.relevant, 10), ndcg10: ndcgAtK(ranked, x.relevant, 10) };
  });
  const ok = rows.filter((r) => Number.isFinite(r.recall10));
  const mean = (k: 'recall10' | 'ndcg10') => (ok.length ? ok.reduce((a, r) => a + r[k], 0) / ok.length : NaN);
  console.log(`B2 recherche · ${ok.length} requête(s) annotée(s) · ${scan.assets.length} média(s) · OCR ${ocrLang ? `activé (${scan.stats.ocr} lus)` : 'désactivé'}`);
  console.log(`  rappel@10 ${pct(mean('recall10'))} · nDCG@10 ${num(mean('ndcg10'))}`);
  console.log('  (recherche dans noms, étiquettes, dossiers, descriptions et texte OCR : aucune analyse des pixels)');
  save('B2-recherche', { annotator: q.annotator, media: scan.assets.length, ocr: !!ocrLang, recall10: mean('recall10'), ndcg10: mean('ndcg10'), rows });
  fs.rmSync(tmp, { recursive: true, force: true });
}

function script(file: string) {
  const a = readJson<ScriptAnnotation>(file);
  if (a.format !== 'primestone-bench/script@1') throw new Error('format attendu : primestone-bench/script@1');
  const text = fs.readFileSync(path.resolve(path.dirname(file), a.script), 'utf8');
  const parsed = parseScript(text);
  const n = analyseNarrative(parsed);
  const byTitle = new Map(n.map((x) => [x.title.trim().toLowerCase(), x]));
  const pairs = a.sections.map((s) => ({ s, p: byTitle.get(s.title.trim().toLowerCase()) })).filter((x) => x.p);
  const kappa = cohenKappa(pairs.map((x) => x.s.fn), pairs.map((x) => x.p!.fn));
  const acc = pairs.length ? pairs.filter((x) => x.s.fn === x.p!.fn).length / pairs.length : NaN;
  const rho = spearman(pairs.map((x) => x.s.intensity), pairs.map((x) => x.p!.intensity));
  const idx = new EntityIndex([...SEED_KNOWLEDGE, ...scriptEntities(parsed)]);
  let tp = 0;
  let fn = 0;
  let found = 0;
  for (const { s, p } of pairs) {
    const sentText = parsed.sentences.filter((x) => p!.sentences.includes(x.index)).map((x) => x.text).join(' ');
    const names = new Set(idx.find(sentText).filter((e) => e.kind !== 'unknown').map((e) => e.name.toLowerCase()));
    found += names.size;
    for (const e of s.entities) (names.has(e.toLowerCase()) ? tp++ : fn++);
  }
  console.log(`B3 script · ${pairs.length}/${a.sections.length} section(s) appariée(s) par titre`);
  console.log(`  fonction narrative : exactitude ${pct(acc)} · κ ${num(kappa)} · intensité ρ de Spearman ${num(rho)}`);
  console.log(`  entités : rappel ${pct(tp / Math.max(1, tp + fn))} · précision ${pct(found ? tp / found : NaN)}`);
  save('B3-script', { annotator: a.annotator, sections: pairs.length, accuracy: acc, kappa, spearmanIntensity: rho, entityRecall: tp / Math.max(1, tp + fn), entityPrecision: found ? tp / found : null });
}

async function template(file: string, seqName?: string) {
  const { project } = await readProjectFile(file, { ignoreChecksum: true });
  const seqs = Object.values(project.sequences).filter((s) => s.production);
  const seq = seqName ? seqs.find((s) => s.name === seqName) : project.sequences[project.activeSequenceId]?.production ? project.sequences[project.activeSequenceId] : seqs.at(-1);
  if (!seq?.production) throw new Error('aucune version générée dans ce projet');
  const r = seq.settings.frameRate;
  const sec = (f: number) => +((f * r.den) / r.num).toFixed(2);
  const ds = seq.production.edg?.decisions.filter((d) => d.kind === 'visuel') ?? [];
  const out: JudgementsFile = {
    format: 'primestone-bench/judgements@1',
    annotator: '',
    project: project.name,
    sequence: seq.name,
    shots: ds.map((d) => ({
      decisionId: d.id,
      start: sec(d.anchor.start),
      end: sec(d.anchor.end),
      text: d.anchor.text,
      media: d.chosen.mediaId ? (project.media[d.chosen.mediaId]?.path ?? null) : null,
      confidence: d.chosen.generated || !d.chosen.mediaId ? null : d.confidence,
      metadataOnly: !d.chosen.evidence.some((e) => e.basis === 'texte-ocr' || e.basis === 'description' || e.basis === 'utilisateur'),
    })),
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

function shots(file: string) {
  const j = readJson<JudgementsFile>(file);
  if (j.format !== 'primestone-bench/judgements@1') throw new Error('format attendu : primestone-bench/judgements@1');
  const s = scoreJudgements(j);
  console.log(`B4 plans · ${s.rated}/${s.shots} plan(s) noté(s) par ${j.annotator || '(annotateur non renseigné)'}`);
  console.log(`  note moyenne ${num(s.meanRating)} / 5 · plans pertinents (≥ 4) ${pct(s.relevantShare)} · images trompeuses ${s.misleading}`);
  console.log(`  noms seuls ${num(s.byBasis.metadataOnly)} / 5 · contenu (description, OCR, votre choix) ${num(s.byBasis.content)} / 5`);
  for (const b of s.byConfidence) console.log(`  confiance ${b.band} : ${b.n} plan(s), note ${num(b.mean)}`);
  if (j.overall) console.log(`  jugement global : ${j.overall}${j.retouchMinutes != null ? ` · ${j.retouchMinutes} min de retouche` : ''}`);
  save('B4-plans', { annotator: j.annotator, project: j.project, sequence: j.sequence, ...s, overall: j.overall ?? null, retouchMinutes: j.retouchMinutes ?? null });
}

async function main() {
  if (cmd === 'pages' && a1 && a2) return pages(a1, a2);
  if (cmd === 'search' && a1 && a2) return search(a1, a2);
  if (cmd === 'script' && a1) return script(a1);
  if (cmd === 'template' && a1) return template(a1, a2);
  if (cmd === 'shots' && a1) return shots(a1);
  console.log('Usage : npm run bench -- pages|search|script|template|shots … (voir docs/BENCHMARK.md)');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(`Erreur : ${(e as Error).message}`);
  process.exitCode = 1;
});
