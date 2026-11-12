/**
 * Time primitives.
 *
 * Timeline positions are integer frames in the sequence timebase. Frame rates are
 * rationals (e.g. 30000/1001) so NTSC rates are exact. Source positions are stored
 * in seconds (double), which keeps VFR sources and mismatched source rates simple
 * while the timeline itself stays frame-exact.
 */
export interface Rational {
  num: number;
  den: number;
}

export const FPS = {
  f23976: { num: 24000, den: 1001 },
  f24: { num: 24, den: 1 },
  f25: { num: 25, den: 1 },
  f2997: { num: 30000, den: 1001 },
  f30: { num: 30, den: 1 },
  f50: { num: 50, den: 1 },
  f5994: { num: 60000, den: 1001 },
  f60: { num: 60, den: 1 },
} as const satisfies Record<string, Rational>;

export function rateToNumber(r: Rational): number {
  return r.num / r.den;
}

export function framesToSeconds(frames: number, rate: Rational): number {
  return (frames * rate.den) / rate.num;
}

/** Converts seconds to the frame index that contains that instant (with a small epsilon for float noise). */
export function secondsToFrames(seconds: number, rate: Rational, mode: 'floor' | 'round' | 'ceil' = 'round'): number {
  const exact = (seconds * rate.num) / rate.den;
  const eps = 1e-6;
  switch (mode) {
    case 'floor':
      return Math.floor(exact + eps);
    case 'ceil':
      return Math.ceil(exact - eps);
    default:
      return Math.round(exact);
  }
}

/** Parses "30000/1001", "29.97", "25" into a rational. Common NTSC decimals are snapped to exact rationals. */
export function parseRate(input: string | number): Rational | null {
  if (typeof input === 'number') return fromDecimal(input);
  const s = input.trim();
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    return reduce({ num: a, den: b });
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return fromDecimal(n);
}

function fromDecimal(n: number): Rational | null {
  if (!(n > 0)) return null;
  for (const r of Object.values(FPS)) {
    if (Math.abs(rateToNumber(r) - n) < 0.002) return { ...r };
  }
  if (Number.isInteger(n)) return { num: n, den: 1 };
  return reduce({ num: Math.round(n * 1000), den: 1000 });
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function reduce(r: Rational): Rational {
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

export function ratesEqual(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

function isDropFrameRate(rate: Rational): boolean {
  return rate.den === 1001 && (rate.num === 30000 || rate.num === 60000);
}

/** SMPTE timecode. Uses drop-frame (;) for 29.97/59.94. */
export function framesToTimecode(frames: number, rate: Rational): string {
  const neg = frames < 0;
  let f = Math.abs(Math.trunc(frames));
  const nominal = Math.round(rateToNumber(rate));
  const pad = (n: number) => String(n).padStart(2, '0');
  let sep = ':';
  if (isDropFrameRate(rate)) {
    sep = ';';
    const drop = nominal === 30 ? 2 : 4;
    const framesPer10Min = Math.round(rateToNumber(rate) * 600);
    const framesPerMin = nominal * 60 - drop;
    const d = Math.floor(f / framesPer10Min);
    const m = f % framesPer10Min;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / framesPerMin) : 0);
  }
  const ff = f % nominal;
  const totalSec = Math.floor(f / nominal);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${neg ? '-' : ''}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/** Parses HH:MM:SS:FF or HH:MM:SS;FF back to frames (inverse of framesToTimecode). */
export function timecodeToFrames(tc: string, rate: Rational): number | null {
  const m = /^(-)?(\d+):(\d{1,2}):(\d{1,2})[:;.](\d{1,2})$/.exec(tc.trim());
  if (!m) return null;
  const [, neg, h, mi, s, fr] = m;
  const nominal = Math.round(rateToNumber(rate));
  const hh = Number(h), mm = Number(mi), ss = Number(s), ff = Number(fr);
  if (mm > 59 || ss > 59 || ff >= nominal) return null;
  let frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (isDropFrameRate(rate)) {
    const drop = nominal === 30 ? 2 : 4;
    const totalMinutes = hh * 60 + mm;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return neg ? -frames : frames;
}
