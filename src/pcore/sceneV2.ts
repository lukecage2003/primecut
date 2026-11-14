/**
 * P-CORE V2 scene (browser / WebGL2, Three.js MIT). Five independent layers around the official
 * logo — never a generic symbol: the core is the traced silhouette of the brand artwork, with the
 * artwork itself on the front face.
 *   A. Core: deeper bevelled extrusion, mirror-gold physical material (clearcoat), luminous edges
 *      that follow the exact silhouette, fragments that land exactly in place.
 *   B. Inner structure: concentric rings, radial spokes and circuit traces behind the logo, revealed
 *      and pulsed by the animation.
 *   C. Orbital system: thin 3D rings on distinct planes, arc segments, a graduated ring.
 *   D. Energy field: particles organised in shells and spiral arms (never random noise), energy waves.
 *   E. Atmosphere: halo, light shafts, haze.
 * Pure function of (setup, frame): any frame renders alone, re-renders are identical.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LayerId, PCoreV2Settings } from './v2/config';
import type { PCoreFrameV2 } from './v2/animation';
import type { LogoShape } from './scene';

export interface SceneV2Setup {
  width: number;
  height: number;
  shape: LogoShape;
  artwork: HTMLImageElement | ImageBitmap;
  v2: PCoreV2Settings;
  seed: number;
  composition: 'core' | 'floating' | 'minimal';
  budget: { particles: number; ringSegments: number; shafts: number; inner: number; bevelSegments: number; hudBars?: number };
}

const rnd = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

function radial(stops: [number, string][], size = 256): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft vertical beam (light shaft) texture. */
function beam(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  const h = g.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.5, 'rgba(255,255,255,1)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(0.15, 'rgba(0,0,0,1)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 64, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Sutherland–Hodgman clip (same as V1, for the fragments). */
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

const additive = (color: THREE.ColorRepresentation, opacity: number) => ({ color: new THREE.Color(color), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

export class PCoreSceneV2 {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private root = new THREE.Group();
  private groups: Record<LayerId, THREE.Group> = { core: new THREE.Group(), inner: new THREE.Group(), orbital: new THREE.Group(), energy: new THREE.Group(), atmosphere: new THREE.Group(), hud: new THREE.Group() };
  // HUD (holographic data matrix)
  private bars!: THREE.InstancedMesh;
  private nBars = 0;
  private sweep!: THREE.Mesh;
  private segRing!: THREE.Mesh;
  private segRing2!: THREE.Mesh;
  private grid!: THREE.Mesh;
  private brackets!: THREE.LineSegments;
  private readout!: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mesh: THREE.Mesh; last: string };
  private tmp = new THREE.Object3D();
  // core
  private logo = new THREE.Group();
  private whole: THREE.Mesh;
  private pieces: { mesh: THREE.Mesh; dir: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private frontMat: THREE.MeshStandardMaterial;
  private sideMat: THREE.MeshPhysicalMaterial;
  private edges: THREE.LineLoop[] = [];
  private coreLight: THREE.PointLight;
  private key!: THREE.DirectionalLight;
  // inner
  private innerLines: THREE.LineSegments;
  private innerMat: THREE.LineBasicMaterial;
  private innerCount: number;
  // orbital
  private rings: { mesh: THREE.Mesh; plane: THREE.Group; speed: number; tilt: number; base: number }[] = [];
  private arcs: { mesh: THREE.Mesh; speed: number }[] = [];
  private ticks: THREE.LineSegments;
  // energy
  private points: THREE.Points;
  private pBase: Float32Array;
  private pCount: number;
  private waves: THREE.Mesh[] = [];
  // atmosphere
  private halo: THREE.Sprite;
  private readBuf: Uint8Array | null = null;
  private haze: THREE.Sprite;
  private shafts: THREE.Mesh[] = [];

  constructor(readonly canvas: HTMLCanvasElement, private setup: SceneV2Setup) {
    const { width, height, v2, budget } = setup;
    const col = v2.identity.colors;
    const r = rnd(setup.seed || 7);
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 50);
    this.camera.position.set(0, 0, 4.2);
    const key = new THREE.DirectionalLight(0xfff3d6, 2.4);
    key.position.set(-2.2, 3, 4);
    this.key = key;
    const rim = new THREE.DirectionalLight(new THREE.Color(col.gold), 3);
    rim.position.set(3, -1.2, -2);
    const top = new THREE.DirectionalLight(0xffffff, 0.8);
    top.position.set(0.5, 4, 1);
    this.coreLight = new THREE.PointLight(new THREE.Color(col.light), 0, 3, 2);
    this.coreLight.position.set(0, 0, 0.6);
    this.scene.add(key, rim, top, new THREE.AmbientLight(0xffffff, 0.18), this.coreLight, this.root);
    for (const g of Object.values(this.groups)) this.root.add(g);

    // ---------- A. core: official silhouette, extruded, bevelled, mirror-gold sides
    const tex = new THREE.Texture(setup.artwork as HTMLImageElement);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const { bbox, width: iw, height: ih } = setup.shape;
    const S = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    tex.repeat.set(S / iw, S / ih);
    tex.offset.set(cx / iw, 1 - cy / ih);
    const depth = Math.max(0.06, Math.min(0.24, v2.identity.depth));
    this.frontMat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.3, metalness: 0.45, roughness: 0.28, envMapIntensity: 1.2 });
    this.sideMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(col.gold), metalness: 1, roughness: 0.42 - 0.3 * v2.identity.metal, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 });
    const poly = setup.shape.outer;
    const toShape = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const whole = toShape(poly);
    for (const h of setup.shape.holes ?? []) whole.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    const wg = new THREE.ExtrudeGeometry(whole, { depth, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.009, bevelSegments: budget.bevelSegments + 1, curveSegments: 8 });
    wg.translate(0, 0, -depth / 2);
    this.whole = new THREE.Mesh(wg, [this.frontMat, this.sideMat]);
    this.logo.add(this.whole);
    // fragments (4×5 jittered grid, exact in place at fragment = 0)
    for (let gx = 0; gx < 4; gx++)
      for (let gy = 0; gy < 5; gy++) {
        const x0 = -0.5 + gx / 4, x1 = -0.5 + (gx + 1) / 4, y0 = -0.5 + gy / 5, y1 = -0.5 + (gy + 1) / 5;
        const part = clipRect(poly, x0, y0, x1, y1);
        if (part.length < 3) continue;
        const geo = new THREE.ExtrudeGeometry(toShape(part), { depth, bevelEnabled: false, curveSegments: 4 });
        geo.translate(0, 0, -depth / 2);
        const mesh = new THREE.Mesh(geo, [this.frontMat, this.sideMat]);
        mesh.visible = false;
        const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
        this.pieces.push({ mesh, dir: c.clone().normalize().multiplyScalar(0.5 + r() * 0.6).add(new THREE.Vector3(0, 0, (r() - 0.3) * 0.9)), spin: new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(2.4) });
        this.logo.add(mesh);
      }
    // luminous edges on the exact silhouette (front and back faces)
    for (const z of [depth / 2 + 0.02, -depth / 2 - 0.02]) {
      const pts = poly.map(([x, y]) => new THREE.Vector3(x, y, z));
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial(additive(col.light, 0.6)));
      this.edges.push(loop);
      this.logo.add(loop);
    }
    this.groups.core.add(this.logo);

    // ---------- B. inner structure (behind the logo): concentric rings, spokes, circuit traces
    const seg: number[] = [];
    const ringN = 2 + budget.inner + v2.identity.innerDetail;
    for (let k = 0; k < ringN; k++) {
      const rad = 0.62 + (k / Math.max(1, ringN - 1)) * 0.3;
      const n = 48 + k * 12;
      const gapAt = r() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        if (Math.abs(((a0 - gapAt + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.35) continue; // a gap per ring
        seg.push(Math.cos(a0) * rad, Math.sin(a0) * rad, 0, Math.cos(a1) * rad, Math.sin(a1) * rad, 0);
      }
    }
    const spokes = 12 + 6 * v2.identity.innerDetail;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + 0.13;
      const r0 = 0.6 + (i % 3) * 0.03, r1 = 0.78 + (i % 2) * 0.08;
      seg.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0);
      if (budget.inner >= 2 && i % 2 === 0) {
        // circuit trace: a radial then tangential step ending on a node
        const a2 = a + 0.12 * (i % 4 === 0 ? 1 : -1);
        seg.push(Math.cos(a) * r1, Math.sin(a) * r1, 0, Math.cos(a2) * (r1 + 0.04), Math.sin(a2) * (r1 + 0.04), 0);
      }
    }
    this.innerCount = seg.length / 3;
    const ig = new THREE.BufferGeometry();
    ig.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    this.innerMat = new THREE.LineBasicMaterial(additive(col.gold, 0.4));
    this.innerLines = new THREE.LineSegments(ig, this.innerMat);
    this.innerLines.position.z = -depth / 2 - 0.12;
    this.groups.inner.add(this.innerLines);

    // ---------- C. orbital system: rings on distinct 3D planes, arcs, graduated ring
    const nRings = Math.max(2, Math.min(6, Math.round(v2.identity.rings)));
    for (let i = 0; i < nRings; i++) {
      const base = 0.82 + i * 0.09;
      const plane = new THREE.Group();
      const tilt = (i % 2 ? 1 : -1) * (0.25 + 0.18 * i);
      plane.rotation.set(tilt, (i * 0.7) % 1.2, 0);
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(base, 0.0035 + 0.0015 * (i % 2), 6, budget.ringSegments), new THREE.MeshBasicMaterial(additive(i % 2 ? col.gold : col.light, 0.7)));
      plane.add(mesh);
      this.rings.push({ mesh, plane, speed: (i % 2 ? -1 : 1) * (0.6 + 0.25 * i), tilt, base });
      this.groups.orbital.add(plane);
    }
    for (let i = 0; i < 4; i++) {
      const rad = 0.9 + i * 0.07;
      const len = Math.PI * (0.18 + 0.12 * (i % 3));
      const m = new THREE.Mesh(new THREE.RingGeometry(rad - 0.012, rad + 0.012, Math.round(budget.ringSegments / 3), 1, r() * Math.PI * 2, len), new THREE.MeshBasicMaterial({ ...additive(col.light, 0.6), side: THREE.DoubleSide }));
      m.position.z = -0.2;
      this.arcs.push({ mesh: m, speed: (i % 2 ? 1 : -1) * (0.3 + 0.1 * i) });
      this.groups.orbital.add(m);
    }
    const tp: number[] = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const r0 = 1.24, r1 = r0 + (i % 10 === 0 ? 0.05 : 0.02);
      tp.push(Math.cos(a) * r0, Math.sin(a) * r0, -0.25, Math.cos(a) * r1, Math.sin(a) * r1, -0.25);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    this.ticks = new THREE.LineSegments(tg, new THREE.LineBasicMaterial(additive(col.gold, 0.35)));
    this.groups.orbital.add(this.ticks);

    // ---------- D. energy field: shells (Fibonacci) and spiral arms, deterministic
    this.pCount = Math.round(budget.particles * Math.max(0.3, Math.min(1.5, v2.animation.particles)));
    this.pBase = new Float32Array(this.pCount * 5);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < this.pCount; i++) {
      const shell = i % 3 !== 2;
      if (shell) {
        // points on a few spherical shells, flattened (disc-like) so they frame the logo
        const k = i / this.pCount;
        const yy = 1 - 2 * ((i * 0.618) % 1);
        const rr = Math.sqrt(1 - yy * yy);
        const th = golden * i;
        const R = 0.95 + 0.35 * ((i % 4) / 3);
        this.pBase.set([Math.cos(th) * rr * R, yy * R * 0.55, Math.sin(th) * rr * R * 0.35, 0, k], i * 5);
      } else {
        // spiral arm: radius grows with the angle
        const arm = i % 4;
        const s = r();
        const a = arm * (Math.PI / 2) + s * Math.PI * 2.2;
        const R = 0.7 + s * 0.85;
        this.pBase.set([Math.cos(a) * R, Math.sin(a) * R, (r() - 0.5) * 0.15, 1, a], i * 5);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pCount * 3), 3));
    const dot = radial([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']], 64);
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.016, map: dot, ...additive(col.light, 0.8) }));
    this.groups.energy.add(this.points);
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, Math.round(budget.ringSegments / 2)), new THREE.MeshBasicMaterial({ ...additive(col.light, 0), side: THREE.DoubleSide }));
      w.position.z = -0.1;
      w.visible = false;
      this.waves.push(w);
      this.groups.energy.add(w);
    }

    // ---------- E. atmosphere: halo, haze, light shafts
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial([[0, 'rgba(255,255,255,0.9)'], [0.3, 'rgba(255,255,255,0.25)'], [1, 'rgba(255,255,255,0)']]), ...additive(col.gold, 0.3) }));
    this.halo.position.z = -0.5;
    this.haze = new THREE.Sprite(new THREE.SpriteMaterial({ map: radial([[0, 'rgba(255,255,255,0.5)'], [0.6, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]), ...additive(col.gold, 0.15) }));
    this.haze.position.z = -0.8;
    this.groups.atmosphere.add(this.haze, this.halo);
    const bt = beam();
    for (let i = 0; i < budget.shafts; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16 + 0.08 * (i % 3), 1.9), new THREE.MeshBasicMaterial({ map: bt, ...additive(col.light, 0), side: THREE.DoubleSide }));
      const a = (i / budget.shafts) * Math.PI * 2 + 0.2;
      m.geometry.translate(0, 0.95, 0);
      m.rotation.z = a;
      m.position.z = -0.45;
      this.shafts.push(m);
      this.groups.atmosphere.add(m);
    }
    // ---------- F. HUD: holographic data matrix around the core (original design)
    this.buildHud(col, budget.hudBars ?? 72);
    // frame: the whole entity fits ~92 % of the shorter side
    const fitH = 2 * Math.tan(THREE.MathUtils.degToRad(15)) * 4.2;
    this.root.scale.setScalar(Math.min(1, width / height) * (fitH / 2.75));
  }

  private buildHud(col: { gold: string; light: string }, bars: number) {
    const g = this.groups.hud;
    // radial spectrum: one thin bar per band, mirrored around the circle
    this.nBars = bars;
    this.bars = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.011, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(additive(col.light, 0.75)), bars);
    this.bars.position.z = -0.3;
    g.add(this.bars);
    // segmented rings (dashes) turning in opposite directions
    const dashTex = (n: number, duty: number) => {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 8;
      const x = c.getContext('2d')!;
      x.fillStyle = '#fff';
      for (let i = 0; i < n; i++) x.fillRect((i / n) * 1024, 0, (duty / n) * 1024, 8);
      const tx = new THREE.CanvasTexture(c);
      tx.wrapS = THREE.RepeatWrapping;
      return tx;
    };
    const ringUV = (inner: number, outer: number, segs: number) => {
      const geo = new THREE.RingGeometry(inner, outer, segs, 1);
      const pos = geo.attributes.position!;
      const uv = geo.attributes.uv!;
      for (let i = 0; i < pos.count; i++) {
        const a = Math.atan2(pos.getY(i), pos.getX(i));
        uv.setXY(i, (a + Math.PI) / (2 * Math.PI), Math.hypot(pos.getX(i), pos.getY(i)) > (inner + outer) / 2 ? 1 : 0);
      }
      return geo;
    };
    this.segRing = new THREE.Mesh(ringUV(1.3, 1.33, 256), new THREE.MeshBasicMaterial({ map: dashTex(90, 0.55), ...additive(col.gold, 0.6), side: THREE.DoubleSide }));
    this.segRing2 = new THREE.Mesh(ringUV(0.7, 0.715, 200), new THREE.MeshBasicMaterial({ map: dashTex(24, 0.75), ...additive(col.light, 0.45), side: THREE.DoubleSide }));
    this.segRing.position.z = this.segRing2.position.z = -0.32;
    g.add(this.segRing, this.segRing2);
    // radar sweep: a fading wedge turning around the core
    const sc = document.createElement('canvas');
    sc.width = 512;
    sc.height = 8;
    const sx = sc.getContext('2d')!;
    const grad = sx.createLinearGradient(0, 0, 512, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.92, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0.9)');
    sx.fillStyle = grad;
    sx.fillRect(0, 0, 512, 8);
    const sweepTex = new THREE.CanvasTexture(sc);
    this.sweep = new THREE.Mesh(ringUV(0.75, 1.28, 128), new THREE.MeshBasicMaterial({ map: sweepTex, ...additive(col.light, 0.25), side: THREE.DoubleSide }));
    this.sweep.position.z = -0.4;
    g.add(this.sweep);
    // matrix grid behind (hexagonal cells, radial fade)
    const gc = document.createElement('canvas');
    gc.width = gc.height = 512;
    const gx = gc.getContext('2d')!;
    gx.strokeStyle = 'rgba(255,255,255,0.55)';
    gx.lineWidth = 1;
    const r = 18;
    for (let row = 0; row < 20; row++)
      for (let q = 0; q < 18; q++) {
        const cx = q * r * 1.732 + (row % 2) * r * 0.866;
        const cy = row * r * 1.5;
        gx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          gx.lineTo(cx + r * 0.9 * Math.cos(a), cy + r * 0.9 * Math.sin(a));
        }
        gx.closePath();
        gx.stroke();
      }
    gx.globalCompositeOperation = 'destination-in';
    const fade = gx.createRadialGradient(256, 256, 60, 256, 256, 256);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    gx.fillStyle = fade;
    gx.fillRect(0, 0, 512, 512);
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 2.7), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(gc), ...additive(col.gold, 0.12) }));
    this.grid.position.z = -0.9;
    g.add(this.grid);
    // targeting brackets (tighten when the core concentrates)
    const bp: number[] = [];
    for (const [sxn, syn] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const x0 = 0.62 * sxn, y0 = 0.62 * syn;
      bp.push(x0, y0, 0, x0 - 0.14 * sxn, y0, 0, x0, y0, 0, x0, y0 - 0.14 * syn, 0);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    this.brackets = new THREE.LineSegments(bg, new THREE.LineBasicMaterial(additive(col.light, 0.7)));
    this.brackets.position.z = 0.15;
    g.add(this.brackets);
    // readouts (state, voice level, time) drawn into a small texture, updated only when they change
    const rc = document.createElement('canvas');
    rc.width = 512;
    rc.height = 96;
    const tex = new THREE.CanvasTexture(rc);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.26), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    mesh.position.set(0, -1.12, 0.1);
    this.readout = { canvas: rc, tex, mesh, last: '' };
    g.add(mesh);
  }

  private renderHud(f: PCoreFrameV2, L: number) {
    const h = f.hud;
    const spec = h?.spectrum ?? [];
    const nb = spec.length || 1;
    const base = 1.04 + 0.06 * f.pose.orbSpread;
    for (let i = 0; i < this.nBars; i++) {
      // bands mirrored around the circle (low band at the top, high bands meet at the bottom)
      const k = i / this.nBars;
      const m = k < 0.5 ? k * 2 : (1 - k) * 2;
      const v = spec.length ? spec[Math.min(nb - 1, Math.floor(m * nb))]! : 0;
      const len = 0.02 + 0.3 * v * v * L + 0.05 * v * L;
      const a = Math.PI / 2 - k * Math.PI * 2;
      this.tmp.position.set(Math.cos(a) * base, Math.sin(a) * base, 0);
      this.tmp.rotation.set(0, 0, a - Math.PI / 2);
      this.tmp.scale.set(1, len, 1);
      this.tmp.updateMatrix();
      this.bars.setMatrixAt(i, this.tmp.matrix);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    (this.bars.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (0.5 + 0.45 * (h?.level ?? 0)) * L);
    this.segRing.rotation.z = f.orbPhase * 0.12;
    this.segRing2.rotation.z = -f.orbPhase * 0.3;
    (this.segRing.material as THREE.MeshBasicMaterial).opacity = Math.min(0.8, 0.45 * L);
    (this.segRing2.material as THREE.MeshBasicMaterial).opacity = Math.min(0.7, (0.25 + 0.3 * f.pose.innerReveal) * L);
    this.sweep.rotation.z = -(h?.scan ?? 0);
    (this.sweep.material as THREE.MeshBasicMaterial).opacity = Math.min(0.5, (0.12 + 0.2 * f.pose.coreGlow) * L);
    (this.grid.material as THREE.MeshBasicMaterial).opacity = Math.min(0.3, (0.06 + 0.1 * (h?.level ?? 0)) * L);
    this.grid.rotation.z = f.orbPhase * 0.02;
    const lock = 1 - 0.25 * (h?.lock ?? 0);
    this.brackets.scale.setScalar(lock * (1 + 0.04 * f.pose.orbSpread));
    (this.brackets.material as THREE.LineBasicMaterial).opacity = Math.min(1, (0.35 + 0.5 * (h?.lock ?? 0)) * L);
    // readouts: state + voice level + time code (redrawn only when the text changes)
    const tt = h?.t ?? 0;
    const text = `${h?.label ?? ''}|VOIX ${String(Math.round((h?.level ?? 0) * 100)).padStart(3, ' ')} %|${String(Math.floor(tt / 60)).padStart(2, '0')}:${(tt % 60).toFixed(1).padStart(4, '0')}`;
    if (text !== this.readout.last) {
      const [label, vox, tc] = text.split('|');
      const c = this.readout.canvas.getContext('2d')!;
      c.clearRect(0, 0, 512, 96);
      c.fillStyle = this.setup.v2.identity.colors.light;
      c.font = '600 30px "Segoe UI", "DejaVu Sans", sans-serif';
      c.textAlign = 'center';
      c.fillText(label!, 256, 38);
      c.font = '22px "Consolas", "DejaVu Sans Mono", monospace';
      c.fillStyle = 'rgba(232,176,0,0.9)';
      c.fillText(`${vox}   ·   ${tc}`, 256, 78);
      this.readout.tex.needsUpdate = true;
      this.readout.last = text;
    }
    (this.readout.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, 0.8 * L);
  }

  render(f: PCoreFrameV2, t: number) {
    const p = f.pose;
    const L = f.layers;
    const minimal = this.setup.composition === 'minimal';
    const floating = this.setup.composition === 'floating';
    for (const k of Object.keys(this.groups) as LayerId[]) this.groups[k].visible = L[k] > 0.001 && !(minimal && (k === 'energy' || k === 'atmosphere'));
    if (floating) this.groups.orbital.visible = this.groups.orbital.visible && L.orbital > 0.6;
    // supporting presence (corner, side): the data matrix would compete with the picture
    if (floating) this.groups.hud.visible = false;
    // A. core
    this.logo.rotation.set(f.rotX, f.rotY, f.rotZ ?? 0);
    // the key light travels slowly so reflections glide across the gold (the metal looks alive)
    const la = -0.9 + 0.55 * Math.sin(t * 0.21) + 0.3 * f.rotY;
    this.key.position.set(4.6 * Math.sin(la), 3 + 0.8 * Math.sin(t * 0.13), 4.6 * Math.cos(la));
    this.logo.position.y = f.floatY;
    this.logo.scale.setScalar(f.scale);
    const frag = f.fragment < 0.01 ? 0 : f.fragment;
    this.whole.visible = frag === 0;
    for (const pc of this.pieces) {
      pc.mesh.visible = frag > 0;
      pc.mesh.position.copy(pc.dir).multiplyScalar(frag * 0.5);
      pc.mesh.rotation.set(pc.spin.x * frag * 0.6, pc.spin.y * frag * 0.6, pc.spin.z * frag * 0.6);
    }
    this.frontMat.emissiveIntensity = (0.18 + 0.3 * p.coreGlow) * L.core;
    for (const e of this.edges) {
      (e.material as THREE.LineBasicMaterial).opacity = Math.min(1, this.setup.v2.identity.edge * (0.25 + 0.9 * p.edge) * L.core) * (frag > 0 ? 0 : 1);
    }
    this.coreLight.intensity = 0.8 * p.coreGlow * L.core;
    // B. inner structure: progressive reveal (draw range) + pulse
    const reveal = Math.max(0, Math.min(1, p.innerReveal));
    this.innerLines.geometry.setDrawRange(0, Math.floor((this.innerCount * reveal) / 2) * 2);
    this.innerMat.opacity = Math.min(0.85, (0.18 + 0.4 * reveal + 0.3 * Math.min(1, p.innerPulse)) * L.inner);
    this.innerLines.rotation.z = f.innerPhase;
    this.innerLines.scale.setScalar(1 + 0.04 * Math.min(1, p.innerPulse));
    // C. orbital
    for (const [i, rg] of this.rings.entries()) {
      rg.plane.rotation.x = rg.tilt * (0.6 + p.orbTilt);
      rg.mesh.rotation.z = f.orbPhase * rg.speed + i;
      rg.mesh.scale.setScalar(0.88 + 0.22 * p.orbSpread);
      (rg.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.85, p.orbOpacity * (i % 2 ? 0.4 : 0.65) * L.orbital);
    }
    for (const a of this.arcs) {
      a.mesh.rotation.z = f.orbPhase * a.speed;
      a.mesh.scale.setScalar(0.9 + 0.2 * p.orbSpread);
      (a.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.7, 0.4 * p.orbOpacity * L.orbital);
    }
    this.ticks.rotation.z = -f.orbPhase * 0.15;
    (this.ticks.material as THREE.LineBasicMaterial).opacity = 0.3 * p.orbOpacity * L.orbital;
    // D. energy field: shells breathe with the spread, spiral arms flow in/out with energyFlow
    const pos = (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const vis = Math.floor(this.pCount * Math.max(0.04, Math.min(1, p.energyDensity)));
    const b = this.pBase;
    for (let i = 0; i < this.pCount; i++) {
      const o = i * 5;
      if (i >= vis) {
        pos[i * 3] = pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = 100;
        continue;
      }
      if (b[o + 3] === 0) {
        const rot = f.orbPhase * 0.25;
        const x0 = b[o]!, z0 = b[o + 2]!;
        const k = 1 + 0.18 * p.orbSpread + 0.15 * Math.max(0, p.energyFlow);
        pos[i * 3] = (x0 * Math.cos(rot) - z0 * Math.sin(rot)) * k;
        pos[i * 3 + 1] = b[o + 1]! * k;
        pos[i * 3 + 2] = (x0 * Math.sin(rot) + z0 * Math.cos(rot)) * k - 0.2;
      } else {
        // spiral: radius drifts outward (flow > 0) or inward (flow < 0), wrapping smoothly
        const R0 = Math.hypot(b[o]!, b[o + 1]!);
        const drift = ((((R0 - 0.7) / 0.85 + f.swirlPhase * 0.15 * Math.sign(p.energyFlow || 1) * (0.3 + Math.abs(p.energyFlow))) % 1) + 1) % 1;
        const R = 0.7 + drift * 0.85;
        const a = b[o + 4]! + f.swirlPhase + drift * 1.2;
        pos[i * 3] = Math.cos(a) * R;
        pos[i * 3 + 1] = Math.sin(a) * R;
        pos[i * 3 + 2] = b[o + 2]! - 0.15;
      }
    }
    this.points.geometry.getAttribute('position').needsUpdate = true;
    const pm = this.points.material as THREE.PointsMaterial;
    pm.size = 0.024 + 0.014 * Math.min(1, p.energyDensity);
    pm.opacity = Math.min(0.95, 0.8 * L.energy);
    for (const [i, w] of this.waves.entries()) {
      const wv = f.waves[i];
      w.visible = !!wv && L.energy > 0;
      if (!wv) continue;
      const k = wv.age / 2.2;
      w.scale.setScalar(0.4 + 1.3 * k);
      (w.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - k) * 0.45 * wv.amp * L.energy);
    }
    // E. atmosphere
    const hs = 1.15 + 0.6 * p.halo;
    this.halo.scale.set(hs, hs, 1);
    (this.halo.material as THREE.SpriteMaterial).opacity = Math.min(0.55, (0.1 + 0.3 * p.halo) * L.atmosphere);
    this.haze.scale.set(2.6, 2.6, 1);
    (this.haze.material as THREE.SpriteMaterial).opacity = Math.min(0.2, 0.12 * p.haze * L.atmosphere);
    for (const [i, s] of this.shafts.entries()) {
      s.rotation.z = (i / this.shafts.length) * Math.PI * 2 + 0.2 + f.orbPhase * 0.05;
      const flick = 0.75 + 0.25 * Math.sin(t * 0.9 + i * 2.1);
      (s.material as THREE.MeshBasicMaterial).opacity = Math.min(0.45, 0.32 * p.shafts * flick * L.atmosphere);
      s.scale.y = 0.7 + 0.5 * p.shafts;
    }
    if (this.groups.hud.visible) this.renderHud(f, L.hud);
    this.renderer.render(this.scene, this.camera);
  }

  /** Straight-alpha RGBA (same conversion as V1: additive light becomes coverage). */
  readPixels(out?: Uint8Array): Uint8Array {
    const { width: w, height: h } = this.setup;
    const gl = this.renderer.getContext();
    // one read buffer for the whole render (no per-frame allocation)
    const buf = (this.readBuf ??= new Uint8Array(w * h * 4));
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const res = out ?? new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      const dst = y * w * 4;
      for (let x = 0; x < w * 4; x += 4) {
        const r = buf[src + x]!, g = buf[src + x + 1]!, bb = buf[src + x + 2]!;
        const a = Math.max(buf[src + x + 3]!, r, g, bb);
        if (a === 0) {
          res[dst + x] = res[dst + x + 1] = res[dst + x + 2] = res[dst + x + 3] = 0;
          continue;
        }
        res[dst + x] = Math.min(255, Math.round((r * 255) / a));
        res[dst + x + 1] = Math.min(255, Math.round((g * 255) / a));
        res[dst + x + 2] = Math.min(255, Math.round((bb * 255) / a));
        res[dst + x + 3] = a;
      }
    }
    return res;
  }
}
