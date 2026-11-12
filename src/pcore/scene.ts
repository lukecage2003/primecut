/**
 * P-CORE 3D scene (browser / WebGL, Three.js MIT). Pure function of (setup, frame params, time):
 * nothing is simulated across frames, so any frame can be rendered alone and re-renders are
 * identical. The official logo silhouette (traced from the brand image) is extruded; its front face
 * carries the official artwork, its sides are gold metal. The logo is built from fragments that sit
 * exactly in place at fragment = 0 (decomposition / reconstruction).
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { PCoreFrame, PCoreSettings } from './expression';

export interface LogoShape {
  outer: [number, number][];
  holes: [number, number][][];
  width: number;
  height: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface SceneSetup {
  width: number;
  height: number;
  shape: LogoShape;
  /** Official logo artwork (image with alpha) for the front face. */
  artwork: HTMLImageElement | ImageBitmap;
  settings: PCoreSettings;
  seed: number;
  /** 'core' (rings + particles), 'floating' (logo alone, discreet), 'minimal'. */
  composition: 'core' | 'floating' | 'minimal';
  /** Particle density factor (quality level). */
  particles?: number;
}

const rnd = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

/** Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle. */
function clipRect(poly: [number, number][], x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const edges: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i]!;
      const b = src[(i + 1) % src.length]!;
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PCoreScene {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  private logo = new THREE.Group();
  private pieces: { mesh: THREE.Mesh; dir: THREE.Vector3; spin: THREE.Vector3; center: THREE.Vector3 }[] = [];
  private rings: { mesh: THREE.Mesh; speed: number; base: number }[] = [];
  private particles: THREE.Points;
  private pBase: Float32Array;
  private trail: THREE.Points;
  private lines: THREE.LineSegments;
  private halo: THREE.Sprite;
  private frontMat: THREE.MeshStandardMaterial;
  private whole!: THREE.Mesh;
  private n = 1400;

  constructor(readonly canvas: HTMLCanvasElement, private setup: SceneSetup) {
    const { width, height, settings } = setup;
    this.n = Math.round(1400 * Math.max(0.25, Math.min(2, setup.particles ?? 1)));
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 50);
    this.camera.position.set(0, 0, 4.2);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-2, 3, 4);
    const rim = new THREE.DirectionalLight(new THREE.Color(settings.colors.gold), 2.5);
    rim.position.set(3, -1, -2);
    this.scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.25), this.root);
    this.root.add(this.logo);

    // --- logo: official silhouette, extruded, cut into fragments
    const tex = new THREE.Texture(setup.artwork as HTMLImageElement);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const { bbox, width: iw, height: ih } = setup.shape;
    const S = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    // shape coordinates (normalised by S) → artwork UV
    tex.repeat.set(S / iw, S / ih);
    tex.offset.set(cx / iw, 1 - cy / ih);
    this.frontMat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.35, metalness: 0.35, roughness: 0.32, envMapIntensity: 1.1 });
    const sideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(settings.colors.gold), metalness: 1, roughness: 0.28, envMapIntensity: 1.4 });
    const r = rnd(setup.seed || 7);
    const NX = 4;
    const NY = 5;
    const poly = setup.shape.outer;
    for (let gx = 0; gx < NX; gx++)
      for (let gy = 0; gy < NY; gy++) {
        // jittered grid so the cracks look organic but stay deterministic
        const x0 = -0.5 + gx / NX;
        const x1 = -0.5 + (gx + 1) / NX;
        const y0 = -0.5 + gy / NY;
        const y1 = -0.5 + (gy + 1) / NY;
        const part = clipRect(poly, x0, y0, x1, y1);
        if (part.length < 3) continue;
        const sh = new THREE.Shape(part.map(([x, y]) => new THREE.Vector2(x, y)));
        const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.11, bevelEnabled: false, curveSegments: 4 });
        geo.translate(0, 0, -0.055);
        const mesh = new THREE.Mesh(geo, [this.frontMat, sideMat]);
        const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
        const dir = c.clone().normalize().multiplyScalar(0.6 + r() * 0.6).add(new THREE.Vector3(0, 0, (r() - 0.3) * 0.8));
        this.pieces.push({ mesh, dir, spin: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(2.4), center: c });
        this.logo.add(mesh);
      }
    // the intact logo (one mesh, bevelled) is shown at rest; fragments only while (de)composing
    const whole = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
    const wg = new THREE.ExtrudeGeometry(whole, { depth: 0.11, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.008, bevelSegments: 3, curveSegments: 6 });
    wg.translate(0, 0, -0.055);
    this.whole = new THREE.Mesh(wg, [this.frontMat, sideMat]);
    this.logo.add(this.whole);
    // halo behind the logo
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(settings.colors.primary), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.5 }));
    this.halo.position.z = -0.4;
    this.root.add(this.halo);
    // holographic ring arcs
    const ringMat = (op: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(settings.colors.primary), transparent: true, opacity: op, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
    const ringDefs = [
      [0.78, 0.006, 0, Math.PI * 2, 0.06],
      [0.86, 0.014, 0.3, Math.PI * 0.55, 0.25],
      [0.86, 0.014, 3.6, Math.PI * 0.4, 0.25],
      [0.98, 0.004, 0, Math.PI * 2, -0.04],
      [1.06, 0.02, 1.2, Math.PI * 0.25, -0.18],
      [1.06, 0.02, 4.4, Math.PI * 0.35, -0.18],
      [1.18, 0.003, 0, Math.PI * 2, 0.03],
    ] as const;
    ringDefs.forEach(([rad, w, start, len, speed], i) => {
      const geo = new THREE.RingGeometry(rad - w, rad + w, 128, 1, start, len);
      const m = new THREE.Mesh(geo, ringMat(i % 3 === 0 ? 0.35 : 0.75));
      m.position.z = -0.15 - i * 0.02;
      this.rings.push({ mesh: m, speed, base: rad });
      if (settings.rings && setup.composition === 'core') this.root.add(m);
    });
    // tick marks ring (segments)
    // particles: deterministic orbits (base radius, angle, height, speed)
    this.pBase = new Float32Array(this.n * 4);
    const pos = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      this.pBase[i * 4] = 0.55 + Math.pow(r(), 0.7) * 0.9;
      this.pBase[i * 4 + 1] = r() * Math.PI * 2;
      this.pBase[i * 4 + 2] = (r() - 0.5) * 0.5;
      this.pBase[i * 4 + 3] = (0.15 + r() * 0.6) * (r() < 0.5 ? -1 : 1);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.018, map: glowTexture(), color: new THREE.Color(settings.colors.primary), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    if (settings.particles && setup.composition !== 'minimal') this.root.add(this.particles);
    // sparkle trail (helix sweeping around the logo)
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(260 * 3), 3));
    this.trail = new THREE.Points(tg, new THREE.PointsMaterial({ size: 0.03, map: glowTexture(), color: new THREE.Color('#FFF4C2'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.root.add(this.trail);
    // energy lines (radial)
    const lp = new Float32Array(64 * 6);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const r0 = 0.9 + (i % 3) * 0.03;
      lp.set([Math.cos(a) * r0, Math.sin(a) * r0, -0.2, Math.cos(a) * (r0 + 0.06 + (i % 4) * 0.03), Math.sin(a) * (r0 + 0.06 + (i % 4) * 0.03), -0.2], i * 6);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: new THREE.Color(settings.colors.primary), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    if (settings.lines && setup.composition === 'core') this.root.add(this.lines);
    // frame the logo + rings: the whole entity fits ~90% of the shorter side
    const fitH = 2 * Math.tan(THREE.MathUtils.degToRad(15)) * 4.2;
    const aspect = width / height;
    this.root.scale.setScalar(Math.min(1, aspect) * (fitH / 2.6));
  }

  render(p: PCoreFrame, t: number) {
    const comp = this.setup.composition;
    // logo transform
    this.logo.rotation.set(p.rotX, p.rotY + (comp === 'floating' ? 0.18 * Math.sin(t * 0.45) : 0), 0);
    this.logo.position.y = p.floatY;
    this.logo.scale.setScalar(p.scale);
    const f = p.fragment < 0.01 ? 0 : p.fragment;
    this.whole.visible = f === 0;
    for (const pc of this.pieces) {
      pc.mesh.visible = f > 0;
      pc.mesh.position.copy(pc.dir).multiplyScalar(f * 0.5);
      pc.mesh.rotation.set(pc.spin.x * f * 0.6, pc.spin.y * f * 0.6, pc.spin.z * f * 0.6);
    }
    this.frontMat.emissiveIntensity = 0.3 + 0.45 * p.glow;
    // halo
    const hs = 1.6 + 1.4 * p.glow + 0.6 * p.burst;
    this.halo.scale.set(hs, hs, 1);
    (this.halo.material as THREE.SpriteMaterial).opacity = (comp === 'minimal' ? 0.25 : 0.35) + 0.5 * p.glow;
    // rings
    for (const [i, rg] of this.rings.entries()) {
      rg.mesh.rotation.z = p.ringAngle * rg.speed * 4 + i;
      rg.mesh.scale.setScalar(0.92 + 0.16 * p.ringSpread + 0.05 * Math.sin(t * 2 + i) * p.energy);
      (rg.mesh.material as THREE.MeshBasicMaterial).opacity = (i % 3 === 0 ? 0.25 : 0.55) * (0.5 + 0.7 * p.glow);
    }
    // particles: orbit + burst outward + audio shimmer (high band)
    const pos = (this.particles.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const vis = Math.floor(this.n * Math.max(0.05, p.particles));
    for (let i = 0; i < this.n; i++) {
      const b = this.pBase;
      const rad = b[i * 4]! * (1 + 0.5 * p.burst * (b[i * 4]! - 0.4)) * (1 + 0.04 * p.high * Math.sin(t * 9 + i));
      const a = b[i * 4 + 1]! + t * b[i * 4 + 3]! * (0.4 + p.energy);
      const on = i < vis ? 1 : 0;
      pos[i * 3] = Math.cos(a) * rad * on;
      pos[i * 3 + 1] = Math.sin(a) * rad * on;
      pos[i * 3 + 2] = b[i * 4 + 2]! - 0.1 + (on ? 0 : 100);
    }
    this.particles.geometry.getAttribute('position').needsUpdate = true;
    (this.particles.material as THREE.PointsMaterial).size = 0.014 + 0.012 * p.energy;
    // trail: a sparkling arc sweeping around the logo when trail > 0
    const tp = (this.trail.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const head = t * 2.2;
    for (let i = 0; i < 260; i++) {
      const u = i / 260;
      const a = head - u * 2.6;
      const rr = 0.72 + 0.05 * Math.sin(i * 12.9898);
      const on = p.trail > 0.02 && u < p.trail ? 1 : 0;
      tp[i * 3] = Math.cos(a) * rr * on;
      tp[i * 3 + 1] = (Math.sin(a * 0.5) * 0.45 + 0.02 * Math.sin(i * 78.233)) * on;
      tp[i * 3 + 2] = Math.sin(a) * 0.35 * on + (on ? 0 : 100);
    }
    this.trail.geometry.getAttribute('position').needsUpdate = true;
    (this.trail.material as THREE.PointsMaterial).opacity = Math.min(1, p.trail * 1.4);
    // energy lines follow the voice
    (this.lines.material as THREE.LineBasicMaterial).opacity = 0.1 + 0.6 * p.energy;
    this.lines.rotation.z = -p.ringAngle * 0.5;
    this.lines.scale.setScalar(0.95 + 0.1 * p.ringSpread);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Straight-alpha RGBA of the current frame, top row first. Additive light (glow, particles) is
   * converted to coverage (alpha = max(alpha, brightness)) so it survives compositing.
   */
  readPixels(out?: Uint8Array): Uint8Array {
    const { width: w, height: h } = this.setup;
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const res = out ?? new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const r = buf[src + x]!;
        const g = buf[src + x + 1]!;
        const b = buf[src + x + 2]!;
        const a = Math.max(buf[src + x + 3]!, r, g, b);
        if (a === 0) {
          res[dst + x] = res[dst + x + 1] = res[dst + x + 2] = res[dst + x + 3] = 0;
          continue;
        }
        res[dst + x] = Math.min(255, Math.round((r * 255) / a));
        res[dst + x + 1] = Math.min(255, Math.round((g * 255) / a));
        res[dst + x + 2] = Math.min(255, Math.round((b * 255) / a));
        res[dst + x + 3] = a;
      }
    }
    return res;
  }
}
