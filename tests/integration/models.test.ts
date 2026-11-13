import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ModelEntry, downloadEntry, modelPath } from '../../src/engine/models';
import { tmpDir } from './fixtures';

// a local server standing in for the model host: supports Range, can cut the connection mid-way
const payload = crypto.randomBytes(3 * 1024 * 1024 + 123);
let server: http.Server;
let base = '';
let cutAfter = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const from = range ? Number(range[1]) : 0;
    const body = payload.subarray(from);
    res.writeHead(range ? 206 : 200, { 'Content-Length': body.length });
    if (cutAfter && !range) {
      res.write(body.subarray(0, cutAfter), () => setTimeout(() => res.destroy(), 50)); // simulated network failure
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const entry = (sha1: string): ModelEntry => ({ id: 'test', kind: 'whisper-ggml', label: 'Test', file: 'ggml-test.bin', sizeBytes: payload.length, sha1, url: '', license: 'test', source: 'local', note: '' });
const sha1 = crypto.createHash('sha1').update(payload).digest('hex');

describe('model manager', () => {
  it('downloads with progress, verifies the SHA-1 and marks the model as verified', async () => {
    const dir = tmpDir('ps-models-');
    const seen: number[] = [];
    const p = await downloadEntry(dir, entry(sha1), { url: `${base}/m.bin`, onProgress: (d) => seen.push(d) });
    expect(fs.readFileSync(p).equals(payload)).toBe(true);
    expect(seen.at(-1)).toBe(payload.length);
    expect(fs.readFileSync(`${p}.verified`, 'utf8')).toBe(`${sha1} ${payload.length}`);
    expect(fs.existsSync(`${p}.part`)).toBe(false);
  });
  it('resumes an interrupted download where it stopped', async () => {
    const dir = tmpDir('ps-models-');
    cutAfter = 1024 * 1024;
    try {
      await expect(downloadEntry(dir, entry(sha1), { url: `${base}/m.bin` })).rejects.toThrow();
    } finally {
      cutAfter = 0;
    }
    const part = `${modelPath(dir, entry(sha1))}.part`;
    expect(fs.statSync(part).size).toBeGreaterThan(0);
    expect(fs.statSync(part).size).toBeLessThan(payload.length);
    const p = await downloadEntry(dir, entry(sha1), { url: `${base}/m.bin` });
    expect(fs.readFileSync(p).equals(payload)).toBe(true);
  });
  it('rejects and deletes a file whose SHA-1 does not match', async () => {
    const dir = tmpDir('ps-models-');
    await expect(downloadEntry(dir, entry('0'.repeat(40)), { url: `${base}/m.bin` })).rejects.toThrow(/SHA-1/);
    const p = modelPath(dir, entry('0'.repeat(40)));
    expect(fs.existsSync(p) || fs.existsSync(`${p}.part`)).toBe(false);
    expect(path.basename(p)).toBe('ggml-test.bin');
  });
});
