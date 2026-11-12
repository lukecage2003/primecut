/** P-CORE render page (hidden window): pulls frame parameters, renders, returns straight-alpha RGBA. */
import type { PCoreFrame } from './expression';
import { type LogoShape, PCoreScene, type SceneSetup } from './scene';

interface Host {
  job(): Promise<{ width: number; height: number; shape: LogoShape; artwork: string; settings: SceneSetup['settings']; seed: number; composition: SceneSetup['composition'] }>;
  next(): Promise<{ i: number; t: number; p: PCoreFrame }[]>;
  frame(pixels: Uint8Array): Promise<void>;
  fail(message: string): void;
}
const host = (window as unknown as { pcoreHost: Host }).pcoreHost;

(async () => {
  try {
    const job = await host.job();
    const img = new Image();
    img.src = job.artwork;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = job.width;
    canvas.height = job.height;
    const scene = new PCoreScene(canvas, { ...job, artwork: img });
    const px = new Uint8Array(job.width * job.height * 4);
    for (;;) {
      const batch = await host.next();
      if (!batch.length) break;
      for (const f of batch) {
        scene.render(f.p, f.t);
        await host.frame(scene.readPixels(px));
      }
    }
  } catch (e) {
    host.fail(String((e as Error)?.stack ?? e));
  }
})();
