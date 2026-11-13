import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureLog, log, logger, pruneLogs, readLogs, recentLogs } from '../../src/engine/log';
import { TaskOrchestrator } from '../../src/engine/tasks';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pslog-'));

describe('technical log', () => {
  it('writes JSON lines with category, level, correlation, and masks the home folder', () => {
    const dir = tmp();
    configureLog({ dir, minLevel: 'info', maxFileBytes: 5e6 });
    logger('ffmpeg', 'corr-essai').error('échec', { file: path.join(os.homedir(), 'Vidéos', 'a.mp4') });
    log('debug', 'app', 'filtré'); // under minLevel
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', cat: 'ffmpeg', corr: 'corr-essai', msg: 'échec' });
    expect(JSON.stringify(lines[0])).not.toContain(os.homedir());
    expect(lines[0].data.file).toMatch(/^~/);
    expect(readLogs(1, 'warn').map((e) => e.msg)).toContain('échec');
  });

  it('rotates by size and prunes old days', () => {
    const dir = tmp();
    configureLog({ dir, minLevel: 'info', maxFileBytes: 400, keepDays: 14 });
    for (let i = 0; i < 20; i++) log('info', 'app', `ligne ${i} ${'x'.repeat(40)}`);
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((f) => fs.statSync(path.join(dir, f)).size < 1000)).toBe(true);
    fs.writeFileSync(path.join(dir, 'primestone-2020-01-01.log'), '{}\n');
    fs.writeFileSync(path.join(dir, 'autre.txt'), 'garder');
    pruneLogs();
    expect(fs.existsSync(path.join(dir, 'primestone-2020-01-01.log'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'autre.txt'))).toBe(true);
  });

  it('never throws when the folder is unusable', () => {
    configureLog({ dir: path.join(tmp(), 'f.log', 'x') });
    expect(() => log('error', 'app', 'ok')).not.toThrow();
  });

  it('correlates the start, end and failure of a task with its id', async () => {
    configureLog({ dir: '' });
    const o = new TaskOrchestrator();
    const ok = o.submit({ label: 'tâche ok', type: 'test', run: async () => 1 } as never);
    await ok.promise;
    const bad = o.submit({ label: 'tâche ko', type: 'test', run: async () => { throw new Error('boum'); } } as never);
    await bad.promise.catch(() => {});
    const r = recentLogs('info');
    const okId = r.find((e) => e.msg === 'début : tâche ok')!.corr;
    expect(r.filter((e) => e.corr === okId).map((e) => e.msg)).toEqual(['début : tâche ok', 'terminé : tâche ok']);
    const fail = r.find((e) => e.msg.startsWith('échec : tâche ko'))!;
    expect(fail.level).toBe('error');
    expect(fail.msg).toContain('boum');
  });
});
