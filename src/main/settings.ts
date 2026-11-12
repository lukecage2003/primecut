import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings, RecentProject } from '../shared/api';
import { atomicWrite } from '../engine/projectStore';
import { DEFAULT_TRANSCRIBER } from '../engine/transcribe';

const file = () => path.join(app.getPath('userData'), 'settings.json');
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

export function defaultSettings(): AppSettings {
  return {
    theme: 'dark',
    performanceProfile: 'quality',
    autosaveSeconds: 60,
    projectsDir: path.join(app.getPath('documents'), 'Primestone Projects'),
    transcriber: { ...DEFAULT_TRANSCRIBER },
  };
}

export function loadSettings(): AppSettings {
  try {
    const d = defaultSettings();
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { ...d, ...j, transcriber: { ...d.transcriber, ...(j.transcriber ?? {}) } };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...loadSettings(), ...patch };
  next.autosaveSeconds = Math.max(10, Math.min(3600, Number(next.autosaveSeconds) || 60));
  await atomicWrite(file(), JSON.stringify(next, null, 2));
  return next;
}

type StoredRecent = Omit<RecentProject, 'exists'>;

function readRecent(): StoredRecent[] {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
  } catch {
    return [];
  }
}

export function listRecent(): RecentProject[] {
  return readRecent().map((r) => ({ ...r, exists: fs.existsSync(r.file) }));
}

export async function pushRecent(f: string, name: string) {
  const list = [{ file: f, name, openedAt: new Date().toISOString() }, ...readRecent().filter((r) => r.file !== f)].slice(0, 15);
  await atomicWrite(recentFile(), JSON.stringify(list, null, 2));
}

export async function forgetRecent(f: string) {
  await atomicWrite(recentFile(), JSON.stringify(readRecent().filter((r) => r.file !== f), null, 2));
}
