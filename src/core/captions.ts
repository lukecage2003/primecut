/**
 * Caption utilities: line breaking for subtitles and ASS (libass) document generation used by the
 * exporter. The preview draws the same captions as HTML with matching styles.
 */
import type { Caption, CaptionStyle, Sequence } from './model';
import { framesToSeconds } from './time';

/** Splits text into at most `maxLines` lines of ~maxChars, balanced. Returns null if it does not fit. */
export function wrapLines(text: string, maxChars = 42, maxLines = 2): string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) return null;
  if (lines.length === 2) {
    // balance two lines
    const all = words.join(' ');
    let best = lines;
    let bestDiff = Math.abs(lines[0]!.length - lines[1]!.length);
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length > maxChars || b.length > maxChars) continue;
      const d = Math.abs(a.length - b.length);
      if (d < bestDiff) {
        best = [a, b];
        bestDiff = d;
      }
    }
    void all;
    return best;
  }
  return lines;
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

export const CAPTION_FONT = 'Arial';

/** Relative caption metrics (fractions of frame height) shared with the preview. */
export const CAPTION_METRICS: Record<CaptionStyle, { size: number; marginV: number }> = {
  subtitle: { size: 0.048, marginV: 0.07 },
  title: { size: 0.085, marginV: 0 },
  // name cards sit above two lines of subtitles (0.07 + 2 × 0.048 × 1.25 + gap), never on them
  'lower-third': { size: 0.045, marginV: 0.2 },
  placeholder: { size: 0.04, marginV: 0 },
};

/**
 * Reference size for caption text: the frame height in landscape and square formats; in portrait
 * (9:16, 4:5) 1.2 × the width, so text keeps a readable size without overflowing the narrow frame.
 */
export function captionBase(W: number, H: number): number {
  return H > W ? Math.min(H, W * 1.2) : H;
}

/**
 * Characters per subtitle line that really fit the frame at the subtitle size (average glyph ≈ 0.55
 * em, 88 % of the width usable), capped at 42 — so the line breaks decided by the edit are the ones
 * shown, never re-wrapped into 3 or 4 lines by the renderer.
 */
export function subtitleChars(W: number, H: number): number {
  const font = CAPTION_METRICS.subtitle.size * captionBase(W, H);
  return Math.max(16, Math.min(42, Math.floor((W * 0.88) / (font * 0.55))));
}

export function captionsToAss(seq: Sequence, captions: Caption[] = seq.captions, offsetFrames = 0): string {
  const { width: W, height: H, frameRate: r } = seq.settings;
  const base = captionBase(W, H);
  const px = (f: number) => Math.round(f * base);
  const style = (name: string, s: CaptionStyle, primary: string, outline: string, back: string, bold: number, align: number, borderStyle: number, marginL = 0.05) =>
    `Style: ${name},${CAPTION_FONT},${px(CAPTION_METRICS[s].size)},${primary},&H000000FF,${outline},${back},${bold},0,0,0,100,100,0,0,${borderStyle},${Math.max(1, Math.round(H / 360))},${Math.round(H / 540)},${align},${Math.round(W * marginL)},${Math.round(W * marginL)},${px(CAPTION_METRICS[s].marginV)},1`;
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // colours are &HAABBGGRR
    style('subtitle', 'subtitle', '&H00FFFFFF', '&H00000000', '&H80000000', -1, 2, 1),
    style('title', 'title', '&H0000C4FF', '&H00000000', '&HA0000000', -1, 5, 1),
    style('lower-third', 'lower-third', '&H0000C4FF', '&H40101010', '&H00000000', -1, 1, 3),
    style('placeholder', 'placeholder', '&H00D0D0D0', '&H00303030', '&H00303030', 0, 5, 3, 0.15),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of [...captions].sort((a, b) => a.start - b.start)) {
    const s = framesToSeconds(c.start - offsetFrames, r);
    const e = framesToSeconds(c.end - offsetFrames, r);
    if (e <= 0) continue;
    const fade = c.style === 'title' || c.style === 'lower-third' ? '{\\fad(250,250)}' : '';
    let text = assEscape(c.text);
    if (c.style === 'lower-third') {
      // name in accent yellow, second line (publisher/role) smaller and white
      const [first, ...rest] = text.split('\\N');
      text = rest.length ? `${first}\\N{\\c&HFFFFFF&\\fs${Math.round(px(CAPTION_METRICS['lower-third'].size) * 0.7)}\\b0}${rest.join('\\N')}` : first!;
    }
    lines.push(`Dialogue: ${c.style === 'subtitle' ? 1 : 0},${assTime(Math.max(0, s))},${assTime(e)},${c.style},,0,0,0,,${fade}${text}`);
  }
  return lines.join('\n') + '\n';
}

/** Subtitle files (SRT / WebVTT) from the sequence's subtitle captions, in sequence time. */
export function captionsToSubtitleFile(seq: Sequence, format: 'srt' | 'vtt', styles: CaptionStyle[] = ['subtitle']): string {
  const r = seq.settings.frameRate;
  const stamp = (f: number) => {
    const ms = Math.max(0, Math.round((f * r.den * 1000) / r.num));
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const h = Math.floor(ms / 3600000);
    const m = Math.floor(ms / 60000) % 60;
    const sec = Math.floor(ms / 1000) % 60;
    return `${p(h)}:${p(m)}:${p(sec)}${format === 'srt' ? ',' : '.'}${p(ms % 1000, 3)}`;
  };
  const cues = seq.captions.filter((c) => styles.includes(c.style) && c.text.trim() && c.end > c.start).sort((a, b) => a.start - b.start);
  const body = cues.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${stamp(c.start)} --> ${stamp(c.end)}\n${c.text.trim().replace(/\r/g, '').replace(format === 'vtt' ? /-->/g : /$^/, '→')}\n`).join('\n');
  return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}


/**
 * Folder for the subtitle files of an export: never next to the video with the same name, because
 * players load such files automatically on top of the burned-in subtitles (double subtitles).
 */
export function subtitleDir(videoPath: string): string {
  const base = videoPath.replace(/\.[^.\\/]+$/, '');
  return `${base} — sous-titres (pour YouTube, TikTok)`;
}
