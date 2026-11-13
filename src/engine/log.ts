/**
 * Structured technical log. One JSON object per line in `<dir>/primestone-YYYY-MM-DD.log`:
 * { t, level, cat, msg, corr?, data? }. Categories by module, severity levels, correlation id (a task
 * id ties every line of one operation together), daily files rotated by size and age. The user's
 * home folder is written as "~" so a shared log does not expose the account name. Logging never
 * throws: a full disk or a read-only folder must not break a production.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 'app' | 'task' | 'ffmpeg' | 'production' | 'export' | 'voice' | 'transcription' | 'models' | 'pcore' | 'media' | 'ui';

export interface LogEntry {
  t: string;
  level: LogLevel;
  cat: LogCategory;
  msg: string;
  corr?: string;
  data?: Record<string, unknown>;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const opts = { dir: '', minLevel: 'info' as LogLevel, maxFileBytes: 5 * 1024 * 1024, keepDays: 14 };
const recent: LogEntry[] = [];
const home = os.homedir();

/** Masks the home folder; keeps the rest of a path (useful to diagnose) */
export function redact(s: string): string {
  return home && home.length > 2 ? s.split(home).join('~') : s;
}

export function configureLog(o: Partial<typeof opts>) {
  Object.assign(opts, o);
  if (opts.dir) {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      pruneLogs();
    } catch {
      /* logging stays in memory */
    }
  }
}

function fileFor(d = new Date()) {
  return path.join(opts.dir, `primestone-${d.toISOString().slice(0, 10)}.log`);
}

/** Deletes logs older than keepDays. */
export function pruneLogs(now = Date.now()) {
  if (!opts.dir) return;
  for (const f of fs.readdirSync(opts.dir)) {
    const m = /^primestone-(\d{4}-\d{2}-\d{2})(\.\d+)?\.log$/.exec(f);
    if (m && now - Date.parse(m[1]!) > opts.keepDays * 86400000) fs.rmSync(path.join(opts.dir, f), { force: true });
  }
}

export function log(level: LogLevel, cat: LogCategory, msg: string, data?: Record<string, unknown>, corr?: string) {
  if (RANK[level] < RANK[opts.minLevel]) return;
  const e: LogEntry = { t: new Date().toISOString(), level, cat, msg: redact(msg), ...(corr ? { corr } : {}), ...(data ? { data: JSON.parse(redact(JSON.stringify(data))) } : {}) };
  recent.push(e);
  if (recent.length > 500) recent.shift();
  if (!opts.dir) return;
  try {
    const f = fileFor();
    const st = fs.existsSync(f) ? fs.statSync(f) : null;
    if (st && st.size > opts.maxFileBytes) {
      // size rotation within the day: .1, .2 … (older first)
      let n = 1;
      while (fs.existsSync(f.replace(/\.log$/, `.${n}.log`))) n++;
      fs.renameSync(f, f.replace(/\.log$/, `.${n}.log`));
    }
    fs.appendFileSync(f, JSON.stringify(e) + '\n');
  } catch {
    /* never throw from logging */
  }
}

export const logger = (cat: LogCategory, corr?: string) => ({
  debug: (m: string, d?: Record<string, unknown>) => log('debug', cat, m, d, corr),
  info: (m: string, d?: Record<string, unknown>) => log('info', cat, m, d, corr),
  warn: (m: string, d?: Record<string, unknown>) => log('warn', cat, m, d, corr),
  error: (m: string, d?: Record<string, unknown>) => log('error', cat, m, d, corr),
});

/** Latest entries in memory (this session), newest last. */
export function recentLogs(minLevel: LogLevel = 'info', limit = 200): LogEntry[] {
  return recent.filter((e) => RANK[e.level] >= RANK[minLevel]).slice(-limit);
}

/** Errors and warnings of the last days, read back from the files (for the diagnostics report). */
export function readLogs(days = 3, minLevel: LogLevel = 'warn', limit = 500): LogEntry[] {
  if (!opts.dir || !fs.existsSync(opts.dir)) return recentLogs(minLevel, limit);
  const files = fs.readdirSync(opts.dir).filter((f) => /^primestone-.*\.log$/.test(f)).sort().slice(-days * 3);
  const out: LogEntry[] = [];
  for (const f of files)
    for (const line of fs.readFileSync(path.join(opts.dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (RANK[e.level] >= RANK[minLevel]) out.push(e);
      } catch {
        /* truncated line */
      }
    }
  return out.slice(-limit);
}

export function logDir() {
  return opts.dir;
}
