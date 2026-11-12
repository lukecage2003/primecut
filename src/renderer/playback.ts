/** Transport clock: drives the playhead from a monotonic clock while playing. */
import { rateToNumber, sequenceDuration } from '../core';
import { currentSequence, store } from './store';

let raf = 0;
let t0 = 0;
let f0 = 0;
let direction = 1;

export function play(dir = 1) {
  const e = store.state.editor;
  if (!e) return;
  const seq = currentSequence(e);
  const end = sequenceDuration(seq);
  if (end === 0) return;
  let start = e.playhead;
  if (dir > 0 && start >= end) start = 0;
  direction = dir;
  t0 = performance.now();
  f0 = start;
  store.setEditor({ playing: true, playhead: start });
  cancelAnimationFrame(raf);
  const fps = rateToNumber(seq.settings.frameRate);
  const step = () => {
    const cur = store.state.editor;
    if (!cur || !cur.playing) return;
    const f = Math.floor(f0 + direction * ((performance.now() - t0) / 1000) * fps);
    const endNow = sequenceDuration(currentSequence(cur));
    if (f >= endNow || f < 0) {
      store.setEditor({ playing: false, playhead: Math.max(0, Math.min(f, endNow)) });
      return;
    }
    if (f !== cur.playhead) store.setEditor({ playhead: f });
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

export function pause() {
  cancelAnimationFrame(raf);
  if (store.state.editor?.playing) store.setEditor({ playing: false });
}

export function togglePlay() {
  if (store.state.editor?.playing) pause();
  else play(1);
}

export function playDirection(): number {
  return direction;
}
