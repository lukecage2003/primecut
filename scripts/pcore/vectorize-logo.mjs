// Traces the official logo's silhouette from the reference image into a polygon (outer contour +
// holes) used by P-CORE's 3D extrusion. Usage: node scripts/pcore/vectorize-logo.mjs <alpha raw> <w> <h> <out.json>
import fs from 'node:fs';
const [file, W, H, out] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]];
// input: 8-bit alpha plane of the transparent logo (ffmpeg -vf alphaextract -f rawvideo)
const alpha = fs.readFileSync(file);
const m = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) m[i] = alpha[i] >= 128 ? 1 : 0;
// keep the largest 4-connected component (drops specks), fill nothing else
const lab = new Int32Array(W * H).fill(-1);
let best = -1, bestN = 0;
for (let s = 0; s < W * H; s++) {
  if (!m[s] || lab[s] >= 0) continue;
  const st = [s]; lab[s] = s; let n = 0;
  while (st.length) { const p = st.pop(); n++; const x = p % W, y = (p / W) | 0;
    for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (q >= 0 && m[q] && lab[q] < 0) { lab[q] = s; st.push(q); } }
  if (n > bestN) { bestN = n; best = s; }
}
for (let i = 0; i < W * H; i++) m[i] = lab[i] === best ? 1 : 0;
const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? m[y * W + x] : 0);
// marching squares contour on pixel corners; returns closed loops
function trace(val) {
  const visited = new Set(); const loops = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // boundary edge start: pixel inside (val) with outside above
    if (at(x, y) !== val || at(x, y - 1) === val) continue;
    const key = `${x},${y},0`; if (visited.has(key)) continue;
    // follow edges keeping inside on the right (Square tracing on edge grid)
    const loop = []; let cx = x, cy = y, dir = 0; // dir 0 = east along top edge
    for (let guard = 0; guard < 4 * W * H; guard++) {
      visited.add(`${cx},${cy},${dir}`); loop.push([cx, cy]);
      const dx = [1, 0, -1, 0][dir], dy = [0, 1, 0, -1][dir];
      const nx = cx + dx, ny = cy + dy;
      // pixels ahead-left and ahead-right relative to the edge
      const L = [[nx, ny - 1], [nx, ny], [nx - 1, ny], [nx - 1, ny - 1]][dir];
      const R = [[nx, ny], [nx - 1, ny], [nx - 1, ny - 1], [nx, ny - 1]][dir];
      const inL = at(L[0], L[1]) === val, inR = at(R[0], R[1]) === val;
      cx = nx; cy = ny;
      if (inL && inR) dir = (dir + 3) % 4; else if (!inR) dir = (dir + 1) % 4;
      if (cx === x && cy === y && dir === 0) break;
    }
    loops.push(loop);
  }
  return loops;
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)]; let dmax = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) { const p = pts[i];
    const d = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
    if (d > dmax) { dmax = d; idx = i; } }
  if (dmax <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
const area = (l) => l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
const outer = trace(1).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))[0];
// holes = background regions enclosed by the logo (not connected to the image border)
const bg = new Uint8Array(W * H); const st = [];
for (let x = 0; x < W; x++) { st.push(x, (H - 1) * W + x); } for (let y = 0; y < H; y++) { st.push(y * W, y * W + W - 1); }
while (st.length) { const p = st.pop(); if (bg[p] || m[p]) continue; bg[p] = 1; const x = p % W, y = (p / W) | 0;
  if (x > 0) st.push(p - 1); if (x < W - 1) st.push(p + 1); if (y > 0) st.push(p - W); if (y < H - 1) st.push(p + W); }
for (let i = 0; i < W * H; i++) if (!m[i] && !bg[i]) m[i] = 2; // enclosed background
const holes = trace(2).filter((l) => Math.abs(area(l)) > 200);
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const [x, y] of outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
const S = Math.max(maxX - minX, maxY - minY), cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
const simplify = (l) => { // closed loop: split at the point farthest from the start, simplify both halves
  let far = 0, fd = 0; l.forEach((p, i) => { const d = Math.hypot(p[0] - l[0][0], p[1] - l[0][1]); if (d > fd) { fd = d; far = i; } });
  return [...rdp(l.slice(0, far + 1), 1.2).slice(0, -1), ...rdp([...l.slice(far), l[0]], 1.2).slice(0, -1)];
};
const norm = (l) => simplify(l).map(([x, y]) => [+((x - cx) / S).toFixed(5), +(-(y - cy) / S).toFixed(5)]);
const res = { source: 'logo-gold.webp', width: W, height: H, bbox: { minX, minY, maxX, maxY }, outer: norm(outer), holes: holes.map(norm) };
fs.writeFileSync(out, JSON.stringify(res));
console.log('outer pts', res.outer.length, 'holes', res.holes.map((h) => h.length), 'bbox', res.bbox);
