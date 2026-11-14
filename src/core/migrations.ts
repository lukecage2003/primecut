/**
 * Project schema migrations. Each entry upgrades a raw document from version N to N+1.
 * Documents newer than this build are refused rather than silently downgraded.
 */
import { type Project, type Sequence, SCHEMA_VERSION } from './model';
import { graphFromShots } from './edg';

export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

type AnyRec = Record<string, unknown>;

/** Registry: key = version being migrated *from*. */
export const MIGRATIONS: Record<number, Migration> = {
  /** v1 → v2: transitions per track, fade in/out per clip. */
  1: (doc) => {
    for (const seq of Object.values((doc.sequences ?? {}) as Record<string, AnyRec>)) {
      for (const t of (seq.tracks ?? []) as AnyRec[]) {
        t.transitions ??= [];
        for (const c of (t.clips ?? []) as AnyRec[]) {
          c.fadeIn ??= 0;
          c.fadeOut ??= 0;
        }
      }
    }
    return doc;
  },
  /** v2 → v3: clip camera motion, sequence captions (media rights/tags are optional). */
  2: (doc) => {
    for (const seq of Object.values((doc.sequences ?? {}) as Record<string, AnyRec>)) {
      seq.captions ??= [];
      for (const t of (seq.tracks ?? []) as AnyRec[]) for (const c of (t.clips ?? []) as AnyRec[]) c.motion ??= { kind: 'none', amount: 0 };
    }
    return doc;
  },
  /** v3 → v4: edit decision graph for generated versions (rebuilt from their production record; nothing removed). */
  3: (doc) => {
    for (const seq of Object.values((doc.sequences ?? {}) as Record<string, AnyRec>)) {
      const p = seq.production as AnyRec | undefined;
      if (!p || p.edg || !Array.isArray(p.shots)) continue;
      try {
        p.edg = graphFromShots(seq as unknown as Sequence);
      } catch {
        /* a damaged production record keeps working without a graph */
      }
    }
    return doc;
  },
};

export class MigrationError extends Error {}

export function migrateProject(raw: unknown, migrations: Record<number, Migration> = MIGRATIONS, target = SCHEMA_VERSION): Project {
  if (!raw || typeof raw !== 'object') throw new MigrationError('Project document is not an object');
  let doc = raw as Record<string, unknown>;
  const sv = doc.schemaVersion;
  if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1) throw new MigrationError('Missing or invalid schemaVersion');
  let v: number = sv;
  if (v > target) throw new MigrationError(`Project was saved by a newer version (schema ${v}); this build supports up to ${target}`);
  while (v < target) {
    const m = migrations[v];
    if (!m) throw new MigrationError(`No migration from schema ${v}`);
    doc = m(structuredClone(doc));
    v = v + 1;
    doc.schemaVersion = v;
  }
  return doc as unknown as Project;
}
