/**
 * Native project storage (.psproj).
 *
 * Layout of a project folder:
 *   <dir>/<name>.psproj          main document (JSON envelope with sha256 checksum)
 *   <dir>/Autosave/<name>.autosave.psproj
 *   <dir>/Backups/<name>-<stamp>.psproj   rotating snapshots taken before each save
 *   <dir>/Cache/{thumbs,peaks,proxies}    disposable, regenerated on demand
 *
 * All writes are atomic (temp file + fsync + rename) so a crash never leaves a truncated file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type MediaAsset, type Project, migrateProject, validateProject } from '../core';
import { fingerprintFile } from './media';

export const PROJECT_EXT = '.psproj';
export const FORMAT_ID = 'primestone-project';
export const MAX_BACKUPS = 20;

export interface Envelope {
  format: typeof FORMAT_ID;
  schemaVersion: number;
  appVersion: string;
  savedAt: string;
  checksum: string;
  project: Project;
}

export class ProjectFileError extends Error {
  constructor(message: string, readonly kind: 'not-found' | 'corrupt' | 'checksum' | 'version' | 'invalid') {
    super(message);
    this.name = 'ProjectFileError';
  }
}

export function projectPaths(file: string) {
  const dir = path.dirname(file);
  const base = path.basename(file, PROJECT_EXT);
  return {
    dir,
    base,
    autosave: path.join(dir, 'Autosave', `${base}.autosave${PROJECT_EXT}`),
    backups: path.join(dir, 'Backups'),
    cache: path.join(dir, 'Cache'),
  };
}

function checksumOf(projectJson: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(projectJson, 'utf8').digest('hex');
}

export function serialize(project: Project, appVersion: string): string {
  const projectJson = JSON.stringify(project);
  const env: Envelope = {
    format: FORMAT_ID,
    schemaVersion: project.schemaVersion,
    appVersion,
    savedAt: new Date().toISOString(),
    checksum: checksumOf(projectJson),
    project,
  };
  // The checksum covers the compact project JSON, which we re-derive on load.
  return JSON.stringify(env, null, 1);
}

export async function atomicWrite(file: string, data: string | Uint8Array) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

export interface ParsedProject {
  project: Project;
  savedAt: string;
  appVersion: string;
  issues: string[];
}

export function parse(text: string, opts: { ignoreChecksum?: boolean } = {}): ParsedProject {
  let env: Partial<Envelope>;
  try {
    env = JSON.parse(text);
  } catch (e) {
    throw new ProjectFileError(`Project file is not valid JSON (${(e as Error).message})`, 'corrupt');
  }
  if (env.format !== FORMAT_ID || !env.project) throw new ProjectFileError('Not a Primestone project file', 'corrupt');
  if (!opts.ignoreChecksum && env.checksum !== checksumOf(JSON.stringify(env.project))) {
    throw new ProjectFileError('Project checksum mismatch: the file was modified or damaged', 'checksum');
  }
  let project: Project;
  try {
    project = migrateProject(env.project);
  } catch (e) {
    throw new ProjectFileError((e as Error).message, 'version');
  }
  return { project, savedAt: env.savedAt ?? '', appVersion: env.appVersion ?? '', issues: validateProject(project) };
}

export async function readProjectFile(file: string, opts?: { ignoreChecksum?: boolean }): Promise<ParsedProject> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    throw new ProjectFileError(`Cannot read ${file}`, 'not-found');
  }
  return parse(text, opts);
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Saves the project: snapshot previous version into Backups, atomic write, clear autosave. */
export async function saveProject(file: string, project: Project, appVersion: string): Promise<{ savedAt: string }> {
  const p = projectPaths(file);
  if (fs.existsSync(file)) {
    await fsp.mkdir(p.backups, { recursive: true });
    await fsp.copyFile(file, path.join(p.backups, `${p.base}-${stamp()}${PROJECT_EXT}`));
    await rotateBackups(p.backups, p.base);
  }
  const withRel = withRelativePaths(project, p.dir);
  const text = serialize(withRel, appVersion);
  await atomicWrite(file, text);
  await fsp.rm(p.autosave, { force: true });
  return { savedAt: (JSON.parse(text) as Envelope).savedAt };
}

export async function writeAutosave(file: string, project: Project, appVersion: string) {
  const p = projectPaths(file);
  await atomicWrite(p.autosave, serialize(withRelativePaths(project, p.dir), appVersion));
}

/** Returns autosave contents when it is newer than the saved project file. */
export async function findRecovery(file: string): Promise<ParsedProject | null> {
  const p = projectPaths(file);
  if (!fs.existsSync(p.autosave)) return null;
  try {
    const auto = await readProjectFile(p.autosave);
    const mainSavedAt = fs.existsSync(file) ? (await readProjectFile(file, { ignoreChecksum: true })).savedAt : '';
    return auto.savedAt > mainSavedAt ? auto : null;
  } catch {
    return null;
  }
}

export async function discardAutosave(file: string) {
  await fsp.rm(projectPaths(file).autosave, { force: true });
}

async function rotateBackups(dir: string, base: string) {
  const files = (await fsp.readdir(dir)).filter((f) => f.startsWith(`${base}-`) && f.endsWith(PROJECT_EXT)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) await fsp.rm(path.join(dir, f), { force: true });
}

export async function listBackups(file: string): Promise<string[]> {
  const p = projectPaths(file);
  if (!fs.existsSync(p.backups)) return [];
  return (await fsp.readdir(p.backups))
    .filter((f) => f.startsWith(`${p.base}-`) && f.endsWith(PROJECT_EXT))
    .sort()
    .reverse()
    .map((f) => path.join(p.backups, f));
}

function withRelativePaths(project: Project, dir: string): Project {
  const media: Record<string, MediaAsset> = {};
  for (const [id, m] of Object.entries(project.media)) media[id] = { ...m, relativePath: path.relative(dir, m.path) };
  return { ...project, media };
}

export type MediaStatus = 'online' | 'relocated' | 'changed' | 'missing';

export interface MediaResolution {
  id: string;
  status: MediaStatus;
  path: string;
}

/**
 * Resolves every media reference: original absolute path, then the path relative to the
 * project folder (handles moved project folders). Size+partial hash detect replaced files.
 */
export async function resolveMedia(project: Project, projectFile: string): Promise<MediaResolution[]> {
  const dir = path.dirname(projectFile);
  const out: MediaResolution[] = [];
  for (const m of Object.values(project.media)) {
    const candidates = [m.path];
    if (m.relativePath) candidates.push(path.resolve(dir, m.relativePath));
    let res: MediaResolution = { id: m.id, status: 'missing', path: m.path };
    for (const [i, c] of candidates.entries()) {
      if (!fs.existsSync(c)) continue;
      const fp = await fingerprintFile(c).catch(() => null);
      if (!fp) continue;
      const same = fp.size === m.fingerprint.size && fp.partialHash === m.fingerprint.partialHash;
      res = { id: m.id, status: same ? (i === 0 ? 'online' : 'relocated') : 'changed', path: c };
      if (same) break;
    }
    out.push(res);
  }
  return out;
}

/** Validates a candidate replacement file for a missing asset (same size + content hash). */
export async function checkRelinkCandidate(asset: MediaAsset, candidate: string): Promise<boolean> {
  const fp = await fingerprintFile(candidate).catch(() => null);
  return !!fp && fp.size === asset.fingerprint.size && fp.partialHash === asset.fingerprint.partialHash;
}

/** Searches a folder tree (bounded depth) for files matching missing assets by name + fingerprint. */
export async function searchForMissing(assets: MediaAsset[], root: string, maxDepth = 4): Promise<Record<string, string>> {
  const wanted = new Map<string, MediaAsset[]>();
  for (const a of assets) {
    const k = a.name.toLowerCase();
    wanted.set(k, [...(wanted.get(k) ?? []), a]);
  }
  const found: Record<string, string> = {};
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        for (const a of wanted.get(e.name.toLowerCase()) ?? []) {
          if (!found[a.id] && (await checkRelinkCandidate(a, full))) found[a.id] = full;
        }
      }
    }
  }
  await walk(root, 0);
  return found;
}
