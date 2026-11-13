/**
 * pmedia:// — streams local media files to the renderer with HTTP Range support so <video>
 * can seek. Read-only; only regular files are served.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { MEDIA_SCHEME } from '../shared/api';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
};

export function registerSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
  ]);
}

export function registerMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url);
    const file = decodeURIComponent(url.pathname.slice(1));
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) throw new Error();
    } catch {
      return new Response('Not found', { status: 404 });
    }
    // media only: the renderer never needs other files, so nothing else on the disk is served
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return new Response('Forbidden', { status: 403 });
    const range = req.headers.get('range');
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m?.[1] ? Number(m[1]) : 0;
      let end = m?.[2] ? Number(m[2]) : st.size - 1;
      if (!m?.[1] && m?.[2]) {
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = String(end - start + 1);
      const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers });
    }
    headers['Content-Length'] = String(st.size);
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers });
  });
}
