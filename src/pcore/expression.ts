/**
 * P-CORE Expression Engine (pure, deterministic). Voice features + optional semantic/manual events
 * → one parameter frame per video frame for the renderer. States blend smoothly (configurable
 * transition time); rotations are integrated from speeds so motion never jumps.
 */
import type { VoiceFrame } from './audio';

export type PCoreState = 'idle' | 'listening' | 'speaking' | 'emphasis' | 'intense' | 'silence' | 'transition' | 'focus' | 'reveal';
export const PCORE_STATES: PCoreState[] = ['idle', 'listening', 'speaking', 'emphasis', 'intense', 'silence', 'transition', 'focus', 'reveal'];

export interface PCoreEvent {
  time: number;
  duration: number;
  state: 'reveal' | 'focus' | 'transition' | 'emphasis' | 'intense';
  source: 'semantic' | 'marker';
  label?: string;
}

export interface PCoreSettings {
  /** Overall energy of the animation (0.3 … 1.5). */
  intensity: number;
  /** Blend time between states (ms). */
  transitionMs: number;
  /** Envelope level above which the voice counts as "speaking" (else "listening"). */
  speakingLevel: number;
  /** Transient strength that triggers EMPHASIS. */
  emphasisOnset: number;
  /** Sustained level (1 s average) that triggers INTENSE. */
  intenseLevel: number;
  /** Seconds of silence before falling back to IDLE. */
  idleAfter: number;
  /** Use semantic events from the script (questions, reveals, section changes). */
  semantic: boolean;
  colors: { primary: string; dark: string; gold: string; white: string };
  /** Rings / particles / energy lines on or off (appearance). */
  rings: boolean;
  particles: boolean;
  lines: boolean;
}

export const DEFAULT_PCORE_SETTINGS: PCoreSettings = {
  intensity: 1,
  transitionMs: 450,
  speakingLevel: 0.35,
  emphasisOnset: 0.25,
  intenseLevel: 0.72,
  idleAfter: 1.6,
  semantic: true,
  colors: { primary: '#FFD400', dark: '#050505', gold: '#E8B000', white: '#FFFFFF' },
  rings: true,
  particles: true,
  lines: true,
};

/** Renderer parameters for one frame. Angles in radians, the rest 0..1 unless noted. */
export interface PCoreFrame {
  state: PCoreState;
  energy: number;
  glow: number;
  ringSpread: number;
  ringAngle: number;
  particles: number;
  burst: number;
  rotY: number;
  rotX: number;
  floatY: number;
  scale: number;
  fragment: number;
  trail: number;
  low: number;
  high: number;
}

type Target = Pick<PCoreFrame, 'glow' | 'ringSpread' | 'particles' | 'burst' | 'scale' | 'fragment' | 'trail'> & { spin: number; ySpin: number; tilt: number };

const TARGETS: Record<PCoreState, Target> = {
  idle: { glow: 0.25, ringSpread: 0.15, particles: 0.1, burst: 0, scale: 0.96, fragment: 0, trail: 0, spin: 0.06, ySpin: 0, tilt: 0.25 },
  silence: { glow: 0.3, ringSpread: 0.2, particles: 0.15, burst: 0, scale: 0.97, fragment: 0, trail: 0, spin: 0.08, ySpin: 0, tilt: 0.2 },
  listening: { glow: 0.45, ringSpread: 0.35, particles: 0.3, burst: 0, scale: 1, fragment: 0, trail: 0, spin: 0.18, ySpin: 0, tilt: 0.12 },
  speaking: { glow: 0.65, ringSpread: 0.55, particles: 0.5, burst: 0, scale: 1.02, fragment: 0, trail: 0.1, spin: 0.3, ySpin: 0, tilt: 0.1 },
  emphasis: { glow: 0.9, ringSpread: 0.8, particles: 0.75, burst: 0.6, scale: 1.07, fragment: 0, trail: 0.3, spin: 0.5, ySpin: 0, tilt: 0.05 },
  intense: { glow: 1, ringSpread: 1, particles: 1, burst: 0.4, scale: 1.1, fragment: 0, trail: 0.5, spin: 0.8, ySpin: 0, tilt: 0.05 },
  focus: { glow: 0.55, ringSpread: 0.3, particles: 0.2, burst: 0, scale: 1.04, fragment: 0, trail: 0, spin: 0.12, ySpin: 0, tilt: 0 },
  transition: { glow: 0.7, ringSpread: 0.9, particles: 0.8, burst: 0.3, scale: 1, fragment: 1, trail: 0.4, spin: 0.4, ySpin: 0, tilt: 0.1 },
  reveal: { glow: 1, ringSpread: 1, particles: 1, burst: 1, scale: 1.12, fragment: 0, trail: 1, spin: 0.6, ySpin: 1, tilt: 0 },
};

/** Narrative cues found in the aligned script (local, rule-based; no external service). */
export function semanticEvents(sentences: { start: number; end: number; text: string; section?: number }[]): PCoreEvent[] {
  const ev: PCoreEvent[] = [];
  // \b does not see accented letters: use Unicode letter look-arounds
  const REVEAL = /(?<!\p{L})(r[ée]v[ée]l\p{L}*|en r[ée]alit[ée]|la v[ée]rit[ée]|secret|d[ée]couvr\p{L}*|finalement|surprise|c'est l[àa] que|tout change|le twist|en fait)(?!\p{L})/iu;
  const EXPLAIN = /(?<!\p{L})(autrement dit|c'est-[àa]-dire|pour comprendre|le principe|fonctionne|m[ée]canisme|structure)(?!\p{L})/iu;
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1];
    if (prev && s.section !== undefined && prev.section !== s.section) ev.push({ time: Math.max(0, s.start - 0.6), duration: 1.4, state: 'transition', source: 'semantic', label: 'new section' });
    const t = s.text.replace(/[’]/g, "'");
    if (REVEAL.test(t)) ev.push({ time: s.start, duration: Math.min(3, Math.max(1.6, s.end - s.start)), state: 'reveal', source: 'semantic', label: 'reveal' });
    else if (/\?\s*$/.test(t)) ev.push({ time: s.start, duration: Math.max(1, s.end - s.start), state: 'focus', source: 'semantic', label: 'question' });
    else if (EXPLAIN.test(t)) ev.push({ time: s.start, duration: Math.max(1, s.end - s.start), state: 'focus', source: 'semantic', label: 'explanation' });
    else if (/!\s*$/.test(t)) ev.push({ time: s.start, duration: Math.min(1.5, s.end - s.start), state: 'emphasis', source: 'semantic', label: 'exclamation' });
  });
  return ev;
}

/** Timeline markers named "P-CORE: REVEAL" (or FOCUS / TRANSITION / EMPHASIS / INTENSE). */
export function markerEvents(markers: { frame: number; name: string }[], fps: number): PCoreEvent[] {
  const out: PCoreEvent[] = [];
  for (const m of markers) {
    const r = /^p-?core\s*:\s*(reveal|focus|transition|emphasis|intense)(?:\s+(\d+(?:\.\d+)?)s?)?/i.exec(m.name.trim());
    if (r) out.push({ time: m.frame / fps, duration: r[2] ? Number(r[2]) : r[1]!.toLowerCase() === 'reveal' ? 2.5 : 1.5, state: r[1]!.toLowerCase() as PCoreEvent['state'], source: 'marker', label: m.name });
  }
  return out;
}

export function voiceState(f: VoiceFrame, avg1s: number, s: PCoreSettings): PCoreState {
  if (!f.speaking) return f.silenceFor >= s.idleAfter ? 'idle' : 'silence';
  if (avg1s >= s.intenseLevel && f.rate >= 2) return 'intense';
  if (f.onset >= s.emphasisOnset && f.env >= s.speakingLevel) return 'emphasis';
  return f.env >= s.speakingLevel ? 'speaking' : 'listening';
}

export function expressionTrack(voice: VoiceFrame[], fps: number, events: PCoreEvent[] = [], settings: Partial<PCoreSettings> = {}): PCoreFrame[] {
  const s = { ...DEFAULT_PCORE_SETTINGS, ...settings };
  const evs = [...events].filter((e) => s.semantic || e.source === 'marker').sort((a, b) => a.time - b.time);
  // thresholds adapt to the narrator: emphasis = this voice's strongest attacks (top ~6 %), intense =
  // its loudest sustained passages (top ~10 %). The settings stay as floors (sensitivity).
  const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : 0);
  const spoken = voice.filter((v) => v.speaking);
  const avg1: number[] = [];
  {
    let acc = 0;
    voice.forEach((v, i) => {
      acc += v.env - (i >= fps ? voice[i - fps]!.env : 0);
      if (v.speaking) avg1.push(acc / Math.min(i + 1, fps));
    });
  }
  const adapted: PCoreSettings = { ...s, emphasisOnset: Math.max(s.emphasisOnset, q(spoken.map((v) => v.onset), 0.97)), intenseLevel: Math.max(s.intenseLevel, q(avg1, 0.9)) };
  // a new voice state must last this long before it is shown (no flicker between syllables)
  const dwell = Math.max(1, Math.round(0.3 * fps));
  let shown: PCoreState = 'idle';
  let cand: PCoreState = 'idle';
  let candFor = 0;
  // an emphasis is an event: at most one every 1.2 s
  let sinceEmphasis = Infinity;
  const k = 1 - Math.exp(-1 / ((s.transitionMs / 1000) * fps / 3));
  const cur: Target = { ...TARGETS.idle };
  const out: PCoreFrame[] = [];
  let ringAngle = 0;
  let rotY = 0;
  let emphasisHold = 0;
  let lastState: PCoreState = 'idle';
  const win: number[] = [];
  for (let i = 0; i < voice.length; i++) {
    const v = voice[i]!;
    const t = i / fps;
    win.push(v.env);
    if (win.length > fps) win.shift();
    const avg = win.reduce((a, b) => a + b, 0) / win.length;
    let state = voiceState(v, avg, adapted);
    sinceEmphasis++;
    if (state === 'emphasis' && emphasisHold === 0) {
      if (sinceEmphasis < 1.2 * fps) state = v.env >= adapted.speakingLevel ? 'speaking' : 'listening';
      else sinceEmphasis = 0;
    }
    // short emphases are shown at once and held so they are visible (≥ 0.25 s)
    if (state === 'emphasis') emphasisHold = Math.round(0.25 * fps);
    else if (emphasisHold > 0 && v.speaking) {
      emphasisHold--;
      state = 'emphasis';
    }
    if (state === 'emphasis') shown = cand = state;
    else {
      if (state === cand) candFor++;
      else (cand = state), (candFor = 1);
      if (candFor >= dwell || shown === 'emphasis') shown = cand;
      state = shown;
    }
    const ev = evs.find((e) => t >= e.time && t < e.time + e.duration);
    if (ev && (ev.source === 'marker' || ev.state === 'transition' || ev.state === 'reveal' || v.speaking)) state = ev.state;
    const tg = TARGETS[state];
    for (const key of Object.keys(cur) as (keyof Target)[]) cur[key] += (tg[key] - cur[key]) * k;
    // reveal: one full turn on Y over the event; otherwise Y returns to the front
    if (ev?.state === 'reveal') rotY = ((t - ev.time) / ev.duration) * Math.PI * 2;
    else rotY += (Math.atan2(Math.sin(-rotY), Math.cos(-rotY)) * k) / 1;
    ringAngle += ((cur.spin * s.intensity + v.env * 0.25) * 2 * Math.PI) / fps;
    const I = s.intensity;
    const live = v.speaking ? v.env : 0;
    out.push({
      state,
      energy: Math.min(1, live * I),
      glow: Math.min(1, cur.glow * (0.7 + 0.5 * live) * I),
      ringSpread: Math.min(1, cur.ringSpread * (0.8 + 0.4 * live)),
      ringAngle,
      particles: s.particles ? Math.min(1, cur.particles * I) : 0,
      burst: cur.burst * I,
      rotY,
      rotX: cur.tilt * 0.15 * Math.sin(t * 0.7) + 0.04 * live * Math.sin(t * 3.1),
      floatY: 0.02 * Math.sin(t * 1.1) * (1 - cur.fragment),
      scale: cur.scale * (1 + 0.04 * live * I),
      fragment: cur.fragment,
      trail: cur.trail * I,
      low: v.low,
      high: v.high,
    });
    lastState = state;
  }
  void lastState;
  return out;
}
