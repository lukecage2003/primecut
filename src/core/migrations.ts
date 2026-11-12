/**
 * Project schema migrations. Each entry upgrades a raw document from version N to N+1.
 * Documents newer than this build are refused rather than silently downgraded.
 */
import { type Project, SCHEMA_VERSION } from './model';

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
