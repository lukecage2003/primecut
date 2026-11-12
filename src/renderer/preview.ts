/**
 * Preview engine: renders the sequence at the playhead using one media element per visible clip.
 *
 * - Video layers are stacked in track order (V1 bottom) and laid out with the same fit/transform
 *   math as the exporter, so the viewer matches the render.
 * - Audio clips play through Web Audio gain nodes (supports gain above 0 dB).
 * - While playing, a monotonic clock drives the playhead; elements are re-seeked only when they
 *   drift by more than ~3 frames. While paused, elements are seeked exactly to the frame.
 * - Clips starting within the next 2 s are pre-loaded and pre-seeked to avoid gaps on cuts.
 */
import { type Clip, type MediaAsset, type Project, type Sequence, framesToSeconds, motionAt, planSequence, rampAt, rateToNumber } from '../core';
import { mediaUrl } from '../shared/api';

interface Layer {
  clipId: string;
  mediaId: string;
  el: HTMLVideoElement | HTMLImageElement | HTMLAudioElement;
  gain?: GainNode;
  lastUsed: number;
}

const DRIFT_PLAYING = 0.1;
const PRELOAD_SEC = 2;

export class PreviewEngine {
  private layers = new Map<string, Layer>();
  private audioCtx: AudioContext | null = null;
  private scale = 1;
  private tick = 0;

  constructor(private stage: HTMLDivElement, private resolveSrc: (m: MediaAsset) => string | null) {}

  setScale(s: number) {
    this.scale = s;
  }

  private ctx(): AudioContext {
    this.audioCtx ??= new AudioContext({ latencyHint: 'playback' });
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
    return this.audioCtx;
  }

  private ensure(clip: Clip, media: MediaAsset, kind: 'video' | 'audio'): Layer | null {
    const key = `${kind}:${clip.id}`;
    let l = this.layers.get(key);
    const src = this.resolveSrc(media);
    if (!src) return null;
    if (l && l.mediaId !== media.id) {
      this.dispose(key);
      l = undefined;
    }
    if (!l) {
      let el: Layer['el'];
      if (kind === 'video' && media.kind === 'image') {
        el = document.createElement('img');
        el.src = src;
      } else if (kind === 'video') {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        v.src = src;
        el = v;
      } else {
        const a = document.createElement('audio');
        a.preload = 'auto';
        a.src = src;
        el = a;
      }
      el.dataset.clip = clip.id;
      el.style.display = 'none';
      if (kind === 'video') this.stage.appendChild(el);
      l = { clipId: clip.id, mediaId: media.id, el, lastUsed: this.tick };
      if (kind === 'audio') {
        try {
          const ac = this.ctx();
          const node = ac.createMediaElementSource(el as HTMLAudioElement);
          const gain = ac.createGain();
          node.connect(gain).connect(ac.destination);
          l.gain = gain;
        } catch {
          /* falls back to element volume */
        }
      }
      this.layers.set(key, l);
    }
    l.lastUsed = this.tick;
    return l;
  }

  private dispose(key: string) {
    const l = this.layers.get(key);
    if (!l) return;
    if (l.el instanceof HTMLMediaElement) {
      l.el.pause();
      l.el.removeAttribute('src');
      l.el.load();
    }
    l.el.remove();
    l.gain?.disconnect();
    this.layers.delete(key);
  }

  /** Renders the frame. `playing` lets media elements run freely with drift correction. */
  render(project: Project, seq: Sequence, frame: number, playing: boolean) {
    this.tick++;
    const rate = seq.settings.frameRate;
    const fps = rateToNumber(rate);
    const { width: W, height: H } = seq.settings;
    const visible = new Set<string>();
    let z = 1;

    const plan = planSequence(seq, project.media);
    for (const it of plan) {
      const { clip, media, kind } = it;
      const active = it.start <= frame && frame < it.end;
      const upcoming = !active && playing && it.start > frame && it.start - frame < PRELOAD_SEC * fps;
      if (!active && !upcoming) continue;
      const l = this.ensure(clip, media, kind);
      if (!l) continue;
      const key = `${kind}:${clip.id}`;
      visible.add(key);
      const el = l.el;
      if (upcoming) {
        // pre-seek to the item's first frame, paused and hidden
        if (el instanceof HTMLMediaElement) {
          el.style.display = 'none';
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - it.sourceIn) > 0.05 && !el.seeking) el.currentTime = Math.max(0, it.sourceIn);
        }
        continue;
      }
      const t = it.sourceIn + framesToSeconds(frame - it.start, rate) * clip.speed;
      const ramp = rampAt(it, frame);
      if (kind === 'video' && clip.fill === 'blur' && media.kind === 'image') {
        z = this.background(clip, media, W, H, z, ramp, visible);
      }
      if (kind === 'video') {
        this.layout(el as HTMLElement, media, clip, W, H, z++, ramp, (frame - it.start + 0.5) / Math.max(1, it.end - it.start));
        el.style.display = 'block';
      }
      if (el instanceof HTMLMediaElement) {
        if (kind === 'audio') {
          const lin = Math.pow(10, clip.gainDb / 20) * ramp;
          if (l.gain) l.gain.gain.value = lin;
          else el.volume = Math.min(1, lin);
        }
        if (playing) {
          if (Math.abs(el.currentTime - t) > DRIFT_PLAYING && !el.seeking) el.currentTime = t;
          if (el.paused) void el.play().catch(() => undefined);
        } else {
          if (!el.paused) el.pause();
          // Seek to the middle of the frame so decoders land on the intended frame.
          const target = t + 0.5 / fps;
          if (Math.abs(el.currentTime - target) > 0.25 / fps && !el.seeking) el.currentTime = target;
        }
      }
    }

    for (const [key, l] of this.layers) {
      if (visible.has(key)) continue;
      if (l.el instanceof HTMLMediaElement && !l.el.paused) l.el.pause();
      (l.el as HTMLElement).style.display = 'none';
      if (this.tick - l.lastUsed > 600) this.dispose(key);
    }
  }

  private layout(el: HTMLElement, media: MediaAsset, clip: Clip, W: number, H: number, z: number, ramp: number, progress: number) {
    const v = media.probe.video!;
    const rot = v.rotation % 180 !== 0;
    const w = rot ? v.height : v.width;
    const h = rot ? v.width : v.height;
    const tr = clip.transform;
    const fit = Math.min(W / w, H / h) * tr.scale;
    const ow = w * fit;
    const oh = h * fit;
    const x = (W - ow) / 2 + tr.x;
    const y = (H - oh) / 2 + tr.y;
    const s = this.scale;
    el.style.width = `${ow * s}px`;
    el.style.height = `${oh * s}px`;
    // Ken Burns identical to the exporter: scale by zoom, crop window offset by pan, clip to the box.
    const m = motionAt(clip.motion, progress);
    const cx = ((ow * m.zoom - ow) / 2) * (1 + m.panX);
    const cy = ((oh * m.zoom - oh) / 2) * (1 + m.panY);
    const half = `${(ow * s) / 2}px, ${(oh * s) / 2}px`;
    el.style.transformOrigin = '0 0';
    el.style.transform =
      `translate(${x * s}px, ${y * s}px) translate(${half}) rotate(${tr.rotation}deg) translate(-${half.replace(', ', ', -')})` +
      (m.zoom !== 1 ? ` translate(${-cx * s}px, ${-cy * s}px) scale(${m.zoom})` : '');
    if (m.zoom !== 1) {
      const l = cx / m.zoom;
      const t = cy / m.zoom;
      const w = ow / m.zoom;
      const h = oh / m.zoom;
      el.style.clipPath = `inset(${t * s}px ${(ow - l - w) * s}px ${(oh - t - h) * s}px ${l * s}px)`;
    } else el.style.clipPath = '';
    el.style.opacity = String(tr.opacity * ramp);
    el.style.zIndex = String(z);
  }

  /** Blurred cover-scaled copy behind a still that does not fill the frame (matches the exporter). */
  private background(clip: Clip, media: MediaAsset, W: number, H: number, z: number, ramp: number, visible: Set<string>): number {
    const key = `bg:${clip.id}`;
    let l = this.layers.get(key);
    const src = this.resolveSrc(media);
    if (!src) return z;
    if (!l) {
      const img = document.createElement('img');
      img.src = src;
      img.style.objectFit = 'cover';
      this.stage.appendChild(img);
      l = { clipId: clip.id, mediaId: media.id, el: img, lastUsed: this.tick };
      this.layers.set(key, l);
    }
    l.lastUsed = this.tick;
    visible.add(key);
    const el = l.el as HTMLElement;
    const s = this.scale;
    el.style.width = `${W * s}px`;
    el.style.height = `${H * s}px`;
    el.style.transform = '';
    el.style.clipPath = '';
    el.style.filter = `blur(${(H / 40) * s * 0.8}px) brightness(0.82) saturate(0.85)`;
    el.style.opacity = String(ramp);
    el.style.zIndex = String(z);
    el.style.display = 'block';
    return z + 1;
  }

  /** True once every visible video layer has decoded the requested frame. */
  isSettled(): boolean {
    for (const l of this.layers.values()) {
      if (l.el instanceof HTMLVideoElement && l.el.style.display === 'block' && (l.el.seeking || l.el.readyState < 2)) return false;
    }
    return true;
  }

  pauseAll() {
    for (const l of this.layers.values()) if (l.el instanceof HTMLMediaElement) l.el.pause();
  }

  destroy() {
    for (const k of [...this.layers.keys()]) this.dispose(k);
    void this.audioCtx?.close();
  }

  static srcFor(media: MediaAsset, proxies: Record<string, string>, status: string | undefined): string | null {
    if (status === 'missing' || status === 'changed') return null;
    const p = proxies[media.id];
    return mediaUrl(p ?? media.path);
  }
}
