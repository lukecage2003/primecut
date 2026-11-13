/**
 * Perceptual image fingerprint (difference hash, 64 bits): each bit says whether a pixel of a 9×8
 * grey thumbnail is brighter than its right neighbour. Re-encoded, resized or slightly recompressed
 * copies of a picture differ by a few bits; different pictures by ~32.
 */
export function dHash(gray9x8: Uint8Array): string {
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray9x8[y * 9 + x]! > gray9x8[y * 9 + x + 1]! ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Groups near-identical pictures; each id maps to its group's representative (largest image). */
export function duplicateGroups(items: { id: string; phash?: string; area: number }[], maxDistance = 6): Map<string, string> {
  const rep = new Map<string, string>();
  const reps: { id: string; phash: string; area: number }[] = [];
  for (const it of [...items].sort((a, b) => b.area - a.area)) {
    if (!it.phash) {
      rep.set(it.id, it.id);
      continue;
    }
    const g = reps.find((r) => hamming(r.phash, it.phash!) <= maxDistance);
    if (g) rep.set(it.id, g.id);
    else {
      reps.push({ id: it.id, phash: it.phash, area: it.area });
      rep.set(it.id, it.id);
    }
  }
  return rep;
}
