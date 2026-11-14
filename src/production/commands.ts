/**
 * Edit instructions in plain French ("plans plus courts", "baisse la musique", "logo en haut à gauche",
 * "enlève les sous-titres", "voix plus naturelle"…), typed or spoken (transcribed locally), turned into
 * precise preference changes. Pure and deterministic: every change is listed before it is applied, and an
 * instruction that is not understood is reported as such (nothing is guessed).
 */
import type { ProductionPreferences } from './preferences';

export interface CommandResult {
  prefs: ProductionPreferences;
  /** What will change, in plain words. */
  changes: string[];
  /** Parts of the instruction that were not understood. */
  unknown: string[];
  /** P-CORE placement changes (corner, size), applied to the P-CORE settings. */
  placement?: { corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'; badgeScale?: number };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const MORE = /\b(plus|augmente|monte|hausse|davantage|renforce|accentue|allonge|rallonge)\b/;
const LESS = /\b(moins|baisse|diminue|reduis|reduit|attenue|raccourcis|raccourcit)\b/;
const OFF = /\b(enleve|retire|supprime|coupe|desactive|sans|pas de|plus de|cache|arrete)\b/;
const ON = /\b(remets|ajoute|active|mets|affiche|avec|garde)\b/;

/** Number in the instruction ("de 3 db", "à 4 secondes", "deux secondes"). */
function amount(s: string): number | null {
  const words: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
  const m = s.match(/(-?\d+(?:[.,]\d+)?)/);
  if (m) return Number(m[1]!.replace(',', '.'));
  for (const [w, v] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`).test(s)) return v;
  return null;
}

export function applyCommand(text: string, prefs: ProductionPreferences): CommandResult {
  const next: ProductionPreferences = { ...prefs, motionWeights: { ...prefs.motionWeights } };
  const changes: string[] = [];
  const unknown: string[] = [];
  let placement: CommandResult['placement'];
  // one instruction per clause ("plans plus courts et baisse la musique, puis enlève les titres")
  const clauses = norm(text)
    .split(/[.;!?\n]|,|\bet puis\b|\bpuis\b|\bensuite\b|\bet\b(?=\s+(?:mets|enleve|retire|baisse|monte|augmente|diminue|change|plus|moins|ajoute|remets|coupe|fais|rends|garde|active|desactive|voix|logo|musique|plans?|sous))/)
    .map((c) => c.trim())
    .filter((c) => c.length > 1);
  for (const c of clauses) {
    const n = amount(c);
    const more = MORE.test(c), less = LESS.test(c), off = OFF.test(c), on = ON.test(c) && !off;
    let understood = true;
    if (/\b(plans?|coupes|rythme|cuts)\b/.test(c) && !/\bcase/.test(c)) {
      // shot length: "plans plus courts", "plans de 3 secondes", "rythme plus rapide"
      let target = next.shotTarget;
      if (n !== null && /\bsec|\bs\b|seconde/.test(c)) target = n;
      else if (/court|rapide|dynamique|nerveux|vite/.test(c) || (less && !/lent/.test(c))) target = next.shotTarget * 0.75;
      else if (/long|lent|calme|pose/.test(c) || more) target = next.shotTarget * 1.3;
      else understood = false;
      if (understood) {
        target = +clamp(target, 1.5, 12).toFixed(2);
        next.shotTarget = target;
        next.shotMin = +clamp(Math.min(next.shotMin, target * 0.6), 1, target).toFixed(2);
        next.shotMax = +clamp(Math.max(target * 1.6, next.shotMin), target, 16).toFixed(2);
        changes.push(`durée des plans visée : ${target} s (de ${next.shotMin} à ${next.shotMax} s)`);
      }
    } else if (/\b(cases?|lecture)\b/.test(c)) {
      // panel reading speed: "lis les cases plus lentement", "2 secondes par case"
      let v = next.secondsPerPanel;
      if (n !== null) v = n;
      else if (/lent|long|plus de temps/.test(c) || more) v *= 1.3;
      else if (/vite|rapide|court/.test(c) || less) v *= 0.75;
      else if (off) ((next.panelReading = false), changes.push('lecture case par case désactivée'));
      else if (on) ((next.panelReading = true), changes.push('lecture case par case activée'));
      else understood = false;
      if (understood && v !== next.secondsPerPanel) {
        next.secondsPerPanel = +clamp(v, 0.8, 6).toFixed(2);
        changes.push(`${next.secondsPerPanel} s par case`);
      }
    } else if (/\bmusique|\bmusic/.test(c)) {
      if (off) ((next.musicFromLibrary = false), changes.push('pas de musique automatique'));
      else {
        let db = next.musicRelativeDb;
        if (n !== null && /db|decibel/.test(c)) db += (less ? -1 : 1) * Math.abs(n);
        else if (less || /doucement|discrete|basse/.test(c)) db -= 4;
        else if (more || /fort/.test(c)) db += 4;
        else if (on) ((next.musicFromLibrary = true), changes.push('musique automatique depuis votre bibliothèque'));
        else understood = false;
        if (db !== next.musicRelativeDb) {
          next.musicRelativeDb = clamp(Math.round(db), -35, -8);
          changes.push(`musique à ${next.musicRelativeDb} dB sous la voix`);
        }
      }
    } else if (/sous.?titre/.test(c)) {
      if (off) ((next.subtitles = false), changes.push('sous-titres retirés'));
      else if (on || more) ((next.subtitles = true), changes.push('sous-titres affichés'));
      else understood = false;
    } else if (/\btitres?\b|chapitre/.test(c)) {
      if (off) ((next.sectionTitles = false), changes.push('titres de section retirés'));
      else if (on) ((next.sectionTitles = true), changes.push('titres de section affichés'));
      else understood = false;
    } else if (/\bnoms?\b|cartouche|lower/.test(c)) {
      if (off) ((next.lowerThirds = false), changes.push('noms à l’écran retirés'));
      else if (on) ((next.lowerThirds = true), changes.push('noms à l’écran affichés'));
      else understood = false;
    } else if (/\b(bruitages?|effets? sonores?|sfx|sons?)\b/.test(c) && !/\bvoix\b/.test(c)) {
      if (off) ((next.sfx = false), changes.push('effets sonores retirés'));
      else if (on) ((next.sfx = true), changes.push('effets sonores ajoutés'));
      else if (less || more) ((next.sfxDb = clamp(next.sfxDb + (less ? -4 : 4), -30, 0)), changes.push(`effets sonores à ${next.sfxDb} dB`));
      else understood = false;
    } else if (/\bvoix\b|narration/.test(c)) {
      if (/radio|pro|chaude|presente|broadcast/.test(c)) ((next.voiceStyle = 'radio'), changes.push('voix radio'));
      else if (/naturel/.test(c)) ((next.voiceStyle = 'natural'), changes.push('voix naturelle (corrections seulement)'));
      else if (/euh|hesitation|repetition|parasite|bafouill/.test(c)) ((next.cutDisfluencies = !off), changes.push(off ? 'hésitations gardées' : 'hésitations et répétitions coupées'));
      else if (/pause|blanc|silence/.test(c)) ((next.tightenPauses = !off && !more), changes.push(next.tightenPauses ? 'longues pauses resserrées' : 'pauses gardées'));
      else if (less || more) ((next.narrationLufs = clamp(next.narrationLufs + (less ? -2 : 2), -24, -9)), changes.push(`volume final ${next.narrationLufs} LUFS`));
      else understood = false;
    } else if (/euh|hesitation|repetition|mots? parasites?|bafouill/.test(c)) {
      next.cutDisfluencies = !off || /coupe|enleve|retire|supprime/.test(c);
      changes.push(next.cutDisfluencies ? 'hésitations et répétitions coupées' : 'hésitations gardées');
    } else if (/pauses?|blancs?|silences?/.test(c)) {
      next.tightenPauses = /resserre|raccourci|coupe|enleve|supprime|moins/.test(c);
      changes.push(next.tightenPauses ? 'longues pauses resserrées' : 'pauses gardées');
    } else if (/\b(logo|p.?core|pecore)\b/.test(c)) {
      placement = { ...placement };
      const corner = /haut/.test(c) ? (/gauche/.test(c) ? 'top-left' : /droite/.test(c) ? 'top-right' : null) : /bas/.test(c) ? (/gauche/.test(c) ? 'bottom-left' : /droite/.test(c) ? 'bottom-right' : null) : null;
      if (corner) ((placement.corner = corner), changes.push(`logo ${corner.replace('top', 'en haut').replace('bottom', 'en bas').replace('-left', ' à gauche').replace('-right', ' à droite')}`));
      if (/petit/.test(c) || (less && !corner)) ((placement.badgeScale = 0.15), changes.push('logo plus petit'));
      else if (/grand|gros/.test(c) || (more && !corner)) ((placement.badgeScale = 0.26), changes.push('logo plus grand'));
      if (off) ((next.pcore = 'off'), changes.push('P-CORE retiré'));
      else if (on && !corner && !placement.badgeScale) ((next.pcore = next.pcore === 'off' ? 'hero' : next.pcore), changes.push('P-CORE présent'));
      if (!corner && !placement.badgeScale && !off && !on) understood = false;
    } else if (/mouvement|zoom|camera|travelling|panoramique/.test(c)) {
      let a = next.motionAmount;
      if (off) a = 0;
      else if (less || /doux|leger|calme/.test(c)) a *= 0.6;
      else if (more || /fort|dynamique/.test(c)) a *= 1.5;
      else understood = false;
      if (understood) ((next.motionAmount = +clamp(a, 0, 0.35).toFixed(3)), changes.push(`mouvement de caméra : ${Math.round(next.motionAmount * 100)} %`));
    } else if (/fondus?|transitions?|enchaine/.test(c)) {
      if (off) ((next.dissolveShare = 0), (next.sectionDissolveFrames = 0), changes.push('coupes franches, sans fondus'));
      else if (more || on) ((next.dissolveShare = clamp(next.dissolveShare + 0.25, 0, 1)), (next.sectionDissolveFrames = Math.max(15, next.sectionDissolveFrames)), changes.push(`fondus : ${Math.round(next.dissolveShare * 100)} % des coupes`));
      else if (less) ((next.dissolveShare = clamp(next.dissolveShare - 0.25, 0, 1)), changes.push(`fondus : ${Math.round(next.dissolveShare * 100)} % des coupes`));
      else understood = false;
    } else if (/ordre des pages|mode histoire|dans l ordre|suivre (le|l) (livre|comic)/.test(c)) {
      next.storyOrder = off ? 'off' : 'on';
      changes.push(off ? 'images choisies passage par passage' : 'pages dans l’ordre du livre');
    } else if (/images? (libres|internet|web)|cherche.* internet/.test(c)) {
      next.webImages = !off;
      changes.push(off ? 'pas de recherche sur Internet' : 'recherche d’images libres sur Internet (mots-clés seulement)');
    } else understood = false;
    if (!understood) unknown.push(c);
  }
  return { prefs: next, changes, unknown, ...(placement && Object.keys(placement).length ? { placement } : {}) };
}
