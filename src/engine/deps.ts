/**
 * Identifies failing dependencies: each external component the app relies on, whether it was found,
 * its version and, when it is not usable, what to do. Read-only (runs `-version` only).
 */
import fs from 'node:fs';
import { ffmpegPaths, run } from './ffmpeg';
import { ffmpegCapabilities } from './ffmpegCaps';
import { MODEL_CATALOG, modelStatus } from './models';
import { bundledWhisperCli } from './transcribe';

export interface DependencyState {
  name: string;
  ok: boolean;
  detail: string;
}

async function version(bin: string) {
  try {
    const r = await run(bin, ['-version'], { collectStdout: true });
    return { ok: true, detail: r.stdout.toString().split('\n')[0]?.trim() || 'trouvé' };
  } catch (e) {
    return { ok: false, detail: `introuvable ou inutilisable (${(e as Error).message.slice(0, 160)}) — réinstallez Primestone ou indiquez FFmpeg dans les réglages` };
  }
}

export async function dependencyReport(modelsDir?: string): Promise<DependencyState[]> {
  const p = ffmpegPaths();
  const out: DependencyState[] = [
    { name: 'FFmpeg', ...(await version(p.ffmpeg)) },
    { name: 'FFprobe', ...(await version(p.ffprobe)) },
  ];
  if (out[0]!.ok) {
    const c = await ffmpegCapabilities().catch((e) => ({ missing: [{ kind: 'erreur', name: (e as Error).message.slice(0, 120) }], licence: null, nonfree: false }));
    out.push(
      c.missing.length
        ? { name: 'Fonctions FFmpeg', ok: false, detail: `manquantes : ${c.missing.slice(0, 8).map((m) => m.name).join(', ')}${c.missing.length > 8 ? '…' : ''} — certains exports ou effets échoueront` }
        : { name: 'Fonctions FFmpeg', ok: true, detail: `toutes présentes (${c.licence ?? 'licence ?'}${c.nonfree ? ', non redistribuable' : ''})` },
    );
  }
  const w = bundledWhisperCli();
  out.push(
    w && fs.existsSync(w)
      ? { name: 'whisper.cpp (transcription intégrée)', ok: true, detail: 'présent' }
      : { name: 'whisper.cpp (transcription intégrée)', ok: false, detail: 'absent de l’installation : la transcription intégrée est indisponible (réinstallez Primestone)' },
  );
  if (modelsDir) {
    const st = await modelStatus(modelsDir).catch(() => []);
    const ok = st.filter((s) => s.present && s.verified);
    const broken = st.filter((s) => s.present && !s.verified);
    out.push({
      name: 'Modèles de transcription',
      ok: ok.length > 0 && broken.length === 0,
      detail:
        (ok.length ? `vérifiés : ${ok.map((s) => s.id).join(', ')}` : 'aucun modèle installé (Réglages → Transcription)') +
        (broken.length ? ` ; non vérifiés ou corrompus : ${broken.map((s) => s.id).join(', ')} (supprimez-les puis retéléchargez)` : '') +
        ` ; catalogue : ${MODEL_CATALOG.length}`,
    });
  }
  return out;
}
