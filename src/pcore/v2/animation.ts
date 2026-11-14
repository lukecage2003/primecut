/**
 * P-CORE V2 Advanced Animation Engine (pure, deterministic). Combines:
 * - a continuous base (sleeping ↔ active core, from the voice activity, smoothed),
 * - the director's cues, blended by priority with entry/exit envelopes (several at once),
 * - measured voice reactions (envelope, high band, attacks),
 * - organic micro-motion (deterministic smooth noise, calmer when the core concentrates),
 * then follows the result with critically damped springs (inertia: nothing jumps), integrates
 * rotations from speeds, and emits energy waves. One frame per video frame.
 */
import type { VoiceFrame } from '../audio';
import type { PCoreFrame, PCoreState } from '../expression';
import type { LayerId, PCoreV2Settings } from './config';
import type { PCoreCue } from './director';
import { BASE_POSE, EXPRESSIONS, type ExpressionId, POSE_KEYS, type Pose, envelope } from './expressions';

export interface PCoreFrameV2 extends PCoreFrame {
  v: 2;
  /** Dominant expression (highest weight) and the weights of the active ones. */
  expr: ExpressionId;
  mix: { id: ExpressionId; w: number }[];
  pose: Pose;
  /** Phases (rad) integrated from speeds. */
  orbPhase: number;
  innerPhase: number;
  swirlPhase: number;
  /** Energy waves: age (s) and amplitude, most recent first. */
  waves: { age: number; amp: number }[];
  /** Final per-layer intensity (layer setting × focus), 0 when the layer is off. */
  layers: Record<LayerId, number>;
  /** Roll of the core (rad) — part of the organic motion. */
  rotZ: number;
  /** HUD data: smoothed voice spectrum (measured), readouts, scan phase. */
  hud: { spectrum: number[]; level: number; scan: number; lock: number; t: number; label: string };
}

const STATE_OF: Record<ExpressionId, PCoreState> = {
  dormant: 'idle', awakening: 'listening', active: 'speaking', 'deep-focus': 'focus', 'energy-expansion': 'intense', 'orbital-motion': 'speaking',
  fragmentation: 'transition', reconstruction: 'transition', revelation: 'reveal', 'cinematic-transition': 'transition', silence: 'silence', 'final-stabilization': 'listening',
};

/** State shown by the HUD readout (French, upper case). */
const HUD_LABEL: Record<ExpressionId, string> = {
  dormant: 'VEILLE', awakening: 'ÉVEIL', active: 'ANALYSE VOCALE', 'deep-focus': 'CONCENTRATION', 'energy-expansion': 'EXPANSION', 'orbital-motion': 'ORBITES', fragmentation: 'DÉCOMPOSITION',
  reconstruction: 'RECONSTRUCTION', revelation: 'RÉVÉLATION', 'cinematic-transition': 'TRANSITION', silence: 'SILENCE', 'final-stabilization': 'STABILISATION',
};

/** Deterministic smooth noise in [-1, 1] (sum of incommensurate sines). */
export function smoothNoise(t: number, seed: number): number {
  const a = Math.sin(t * 0.37 + seed * 1.7) * 0.5 + Math.sin(t * 0.83 + seed * 2.9) * 0.3 + Math.sin(t * 1.61 + seed * 4.3) * 0.2;
  return a;
}

const RANGE: Partial<Record<keyof Pose, [number, number]>> = { fragment: [0, 1], focus: [0, 1], scale: [0.85, 1.2] };

export function animateV2(voice: VoiceFrame[], fps: number, cues: PCoreCue[], settings: PCoreV2Settings, seed = 7, timeOffset = 0, spectrum?: Float32Array[], chapters: { time: number; title: string }[] = []): PCoreFrameV2[] {
  const an = settings.animation;
  const id = settings.identity;
  const live = cues.filter((c) => c.state !== 'désactivée').sort((a, b) => EXPRESSIONS[a.expression].priority - EXPRESSIONS[b.expression].priority || a.start - b.start);
  const dormant: Pose = { ...BASE_POSE, ...EXPRESSIONS.dormant.pose(0, 1, 0) };
  const active: Pose = { ...BASE_POSE, ...EXPRESSIONS.active.pose(0, 1, 0) };
  // springs: ω from the inertia (response ≈ inertia seconds); fragment reacts faster so pieces land exactly
  const omega = (resp: number) => (2 * Math.PI) / Math.max(0.08, resp * 2.2);
  const dt = 1 / fps;
  const x: Pose = { ...dormant };
  const v: Record<string, number> = Object.fromEntries(POSE_KEYS.map((k) => [k, 0]));
  let act = 0;
  let rotYSpring = 0;
  let rotYVel = 0;
  let orbPhase = seed * 0.37;
  let innerPhase = seed * 0.11;
  let swirlPhase = 0;
  // waves: from the cues (planned) and from the strongest attacks of this voice (rate-limited)
  const cueWaves = live.flatMap((c) => (EXPRESSIONS[c.expression].waves?.(c.variant) ?? []).map((u) => ({ t: c.start + u * c.duration, amp: Math.min(1.3, c.intensity) })));
  const onsets = voice.filter((f) => f.speaking).map((f) => f.onset).sort((a, b) => a - b);
  const onsetTop = onsets[Math.floor(onsets.length * 0.985)] ?? 1;
  const waves: { t: number; amp: number }[] = [];
  let lastVoiceWave = -Infinity;
  const out: PCoreFrameV2[] = [];
  const nb = spectrum?.[0]?.length ?? 24;
  const spec = new Float32Array(nb);
  let level = 0;
  let scan = seed * 0.5;
  // organic life of the core: syllable pulses (scale/edge) and accent nods (yaw kicks), both with springs
  const spoken = voice.filter((f) => f.speaking).map((f) => f.onset).sort((a, b) => a - b);
  const pulseAt = spoken[Math.floor(spoken.length * 0.82)] ?? 1;
  const nodAt = spoken[Math.floor(spoken.length * 0.96)] ?? 1;
  let pulse = 0;
  let pulseTarget = 0;
  let nod = 0;
  let nodVel = 0;
  let nodTarget = 0;
  let nodSign = 1;
  let lastNod = -Infinity;
  let lastPulse = -Infinity;
  for (let i = 0; i < voice.length; i++) {
    const f = voice[i]!;
    const t = timeOffset + i / fps;
    // ---- base: activity follows speech slowly (attack 0.35 s, release 1.2 s), dormant after long silences
    const want = f.speaking ? 0.55 + 0.45 * f.env : f.silenceFor > 4 ? 0 : 0.35;
    act += (want - act) * (1 - Math.exp(-dt / (want > act ? 0.35 : 1.2)));
    const target: Pose = { ...dormant };
    for (const k of POSE_KEYS) target[k] = dormant[k] + (active[k] - dormant[k]) * act;
    // ---- cues blended by priority (several expressions compose)
    const mix: { id: ExpressionId; w: number }[] = [{ id: act > 0.5 ? 'active' : 'dormant', w: 0.3 }];
    let turns = 0;
    for (const c of live) {
      const def = EXPRESSIONS[c.expression];
      const u = (t - c.start) / c.duration;
      const tr = def.turns?.(c.variant) ?? 0;
      // turns always end on a whole number: the logo is never left showing its back (mirrored artwork)
      const whole = Math.max(0, Math.round(tr));
      if (whole && u > 0) turns += whole * (u >= 1 ? 1 : u * u * (3 - 2 * u));
      if (u < 0 || u > 1) continue;
      const w = envelope(def, u);
      if (w <= 0) continue;
      const p = def.pose(u, c.intensity, c.variant);
      for (const k of Object.keys(p) as (keyof Pose)[]) target[k] += (p[k]! - target[k]) * w;
      mix.push({ id: c.expression, w });
    }
    // ---- measured voice reactions (loudness drives amplitude, never the choice of expression)
    const e = f.speaking ? f.env : 0;
    const R = settings.narrative.reaction * an.intensity;
    target.coreGlow += 0.25 * e * R;
    target.orbSpin += 0.12 * e * R;
    target.energyDensity += 0.18 * f.high * e * R;
    target.innerPulse += 0.35 * f.onset * R;
    target.scale += 0.015 * e * R;
    // ---- organic micro-motion: calm at rest, quieter when concentrating
    const micro = an.micro * (1 - 0.6 * target.focus);
    target.tiltX += 0.05 * micro * smoothNoise(t, seed);
    target.orbTilt += 0.06 * micro * smoothNoise(t * 0.8, seed + 3);
    // ---- springs
    const w0 = omega(an.inertia);
    for (const k of POSE_KEYS) {
      const om = k === 'fragment' ? omega(an.inertia * 0.55) : k === 'innerPulse' ? omega(an.inertia * 0.35) : w0;
      // critically damped: a = ω²(target − x) − 2ω·v (semi-implicit Euler, 2 substeps)
      for (let s = 0; s < 2; s++) {
        const h = dt / 2;
        v[k] = v[k]! + (om * om * (target[k] - x[k]) - 2 * om * v[k]!) * h;
        x[k] += v[k]! * h;
      }
      const r = RANGE[k];
      if (r) x[k] = Math.max(r[0], Math.min(r[1], x[k]));
    }
    // a fragment at rest is exactly 0: the intact logo is shown, never a near-closed crack
    if (x.fragment < 0.004 && target.fragment === 0) x.fragment = 0;
    // ---- rotations: turns (whole or half) followed with inertia, yaw offset from the pose, micro sway
    const rotTarget = turns * Math.PI * 2;
    const om = omega(an.inertia * 0.8);
    rotYVel += (om * om * (rotTarget - rotYSpring) - 2 * om * rotYVel) * dt;
    rotYSpring += rotYVel * dt;
    // visible, slow 3D sway (≈ ±13° yaw, ±4° pitch at rotation 1), calmer when concentrating, livelier when speaking
    const sway = an.rotation * (1 - 0.5 * x.focus) * (0.75 + 0.35 * act);
    const yawSway = sway * (0.17 * Math.sin((2 * Math.PI * t) / 7.3 + seed) + 0.06 * smoothNoise(t * 0.35, seed + 7));
    const pitchSway = sway * (0.06 * Math.sin((2 * Math.PI * t) / 9.1 + seed * 0.5) + 0.02 * smoothNoise(t * 0.4, seed + 9));
    // syllable pulses: a short swell on the narrator's stressed syllables (≥ 0.18 s apart)
    if (f.speaking && f.onset >= pulseAt && f.onset > 0.02 && t - lastPulse > 0.18) {
      pulseTarget = Math.min(1, pulseTarget + 0.6 * Math.min(1, f.onset / Math.max(1e-3, nodAt)));
      lastPulse = t;
    }
    // a swell, not a flash: quick (≈ 60 ms) rise, 0.2 s fall
    pulse += (pulseTarget - pulse) * (1 - Math.exp(-dt / 0.06));
    pulseTarget *= Math.exp(-dt / 0.2);
    // accent nods: on the strongest attacks, a small turn to one side, then back (spring, alternating sides)
    if (f.speaking && f.onset >= nodAt && f.onset > 0.03 && t - lastNod > 1.6) {
      nodTarget = 0.13 * nodSign * an.rotation * settings.narrative.reaction;
      nodSign = -nodSign;
      lastNod = t;
    }
    if (t - lastNod > 0.35) nodTarget = 0;
    const omN = omega(0.25 + 0.3 * an.inertia);
    nodVel += (omN * omN * (nodTarget - nod) - 1.4 * omN * nodVel) * dt;
    nod += nodVel * dt;
    const rotY = rotYSpring + an.rotation * (x.spinY + 0.06 * micro * smoothNoise(t * 0.6, seed + 7)) + yawSway + nod;
    x.tiltX += pitchSway;
    orbPhase += x.orbSpin * an.speed * 2 * Math.PI * dt;
    innerPhase += (x.innerSpin + 0.01) * an.speed * 2 * Math.PI * dt;
    swirlPhase += x.swirl * an.speed * dt;
    // ---- waves
    for (const cw of cueWaves) if (cw.t >= t - dt / 2 && cw.t < t + dt / 2) waves.push({ t, amp: cw.amp });
    if (f.speaking && f.onset >= onsetTop && f.onset > 0.05 && t - lastVoiceWave > 2.5 && settings.narrative.sensitivity >= 0.6) {
      waves.push({ t, amp: 0.35 * R });
      lastVoiceWave = t;
    }
    while (waves.length && t - waves[0]!.t > 2.6) waves.shift();
    // ---- layers: setting × enabled × focus (concentration dims the periphery)
    const L = id.layers;
    const on = (k: LayerId) => (L[k].enabled ? L[k].intensity : 0);
    const layers: Record<LayerId, number> = { core: on('core'), inner: on('inner'), orbital: on('orbital') * (1 - 0.45 * x.focus), energy: on('energy') * (1 - 0.6 * x.focus), atmosphere: on('atmosphere') * (1 - 0.3 * x.focus), hud: on('hud') };
    // HUD: the measured spectrum of the voice (fast attack, slower release: readable, no flicker)
    const sf = spectrum?.[i];
    for (let b = 0; b < nb; b++) {
      const target = f.speaking ? (sf ? sf[b]! : e * (0.6 + 0.4 * Math.sin(b * 0.7 + t * 3))) : 0;
      spec[b] = spec[b]! + (target - spec[b]!) * (target > spec[b]! ? 0.55 : 0.12);
    }
    level += ((f.speaking ? f.env : 0) - level) * 0.25;
    scan += (0.35 + 0.6 * x.orbSpin) * an.speed * 2 * Math.PI * dt;
    const dominant = mix.reduce((a, b) => (b.w >= a.w ? b : a), mix[0]!).id;
    out.push({
      v: 2,
      expr: dominant,
      mix: mix.filter((m) => m.w > 0.05).slice(-3),
      pose: { ...x, edge: Math.min(1, x.edge + 0.35 * pulse), coreGlow: Math.min(1.2, x.coreGlow + 0.12 * pulse) },
      orbPhase,
      innerPhase,
      swirlPhase,
      waves: waves.map((w) => ({ age: t - w.t, amp: w.amp })).reverse().slice(0, 4),
      layers,
      hud: { spectrum: Array.from(spec, (q) => +q.toFixed(3)), level: +level.toFixed(3), scan, lock: x.focus, t, label: chapters.find((c) => t >= c.time && t < c.time + 4.5)?.title.toUpperCase() ?? HUD_LABEL[dominant] },
      // V1-compatible fields (graphs, placement, older readers)
      state: STATE_OF[dominant],
      energy: e,
      glow: Math.min(1, x.coreGlow),
      ringSpread: x.orbSpread,
      ringAngle: orbPhase,
      particles: x.energyDensity,
      burst: Math.max(0, x.energyFlow),
      rotY,
      rotX: x.tiltX,
      rotZ: sway * 0.025 * Math.sin((2 * Math.PI * t) / 11.3 + seed * 2),
      floatY: (0.012 + 0.018 * an.micro) * Math.sin((2 * Math.PI * t) / 5.7 + seed) * (1 - x.fragment),
      scale: x.scale * (1 + 0.035 * pulse * settings.narrative.reaction),
      fragment: x.fragment,
      trail: x.swirl,
      low: f.low,
      high: f.high,
    });
  }
  return out;
}

/** Largest per-frame change of the visible parameters (used to prove there is no jump). */
export function maxStep(frames: PCoreFrameV2[]): Record<string, number> {
  const keys = ['coreGlow', 'scale', 'orbSpread', 'energyDensity', 'halo', 'shafts', 'fragment'] as const;
  const m: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (let i = 1; i < frames.length; i++) for (const k of keys) m[k] = Math.max(m[k]!, Math.abs(frames[i]!.pose[k] - frames[i - 1]!.pose[k]));
  m.rotY = 0;
  for (let i = 1; i < frames.length; i++) m.rotY = Math.max(m.rotY, Math.abs(frames[i]!.rotY - frames[i - 1]!.rotY));
  return m;
}
