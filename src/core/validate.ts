import { type Project, SCHEMA_VERSION, clipEnd } from './model';

/** Structural validation of a project. Returns human-readable issues; empty = valid. */
export function validateProject(p: Project): string[] {
  const issues: string[] = [];
  if (p.schemaVersion !== SCHEMA_VERSION) issues.push(`schemaVersion ${p.schemaVersion} != ${SCHEMA_VERSION}`);
  if (!p.sequences[p.activeSequenceId]) issues.push('activeSequenceId does not reference a sequence');
  const clipIds = new Set<string>();
  for (const seq of Object.values(p.sequences)) {
    const { frameRate, width, height } = seq.settings;
    if (!(frameRate.num > 0 && frameRate.den > 0)) issues.push(`${seq.name}: invalid frame rate`);
    if (!(width > 0 && height > 0) || width % 2 || height % 2) issues.push(`${seq.name}: invalid resolution ${width}x${height}`);
    for (const t of seq.tracks) {
      let prevEnd = -Infinity;
      for (const c of t.clips) {
        const where = `${seq.name}/${t.name}/${c.name}`;
        if (clipIds.has(c.id)) issues.push(`${where}: duplicate clip id`);
        clipIds.add(c.id);
        if (!Number.isInteger(c.start) || c.start < 0) issues.push(`${where}: invalid start ${c.start}`);
        if (!Number.isInteger(c.duration) || c.duration < 1) issues.push(`${where}: invalid duration ${c.duration}`);
        if (!(c.sourceIn >= -1e-9)) issues.push(`${where}: negative source in`);
        if (c.start < prevEnd) issues.push(`${where}: overlaps previous clip`);
        prevEnd = clipEnd(c);
        const m = p.media[c.mediaId];
        if (!m) issues.push(`${where}: references missing media ${c.mediaId}`);
        else if (t.kind === 'audio' && !m.probe.audio) issues.push(`${where}: audio clip on media without audio`);
      }
    }
  }
  return issues;
}
