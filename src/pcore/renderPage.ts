/** P-CORE render page (hidden window): pulls frame parameters, renders, returns straight-alpha RGBA. */
import type { PCoreFrame } from './expression';
import { type LogoShape, PCoreScene, type SceneSetup } from './scene';
import { PCoreSceneV2, type SceneV2Setup } from './sceneV2';
import type { PCoreFrameV2 } from './v2/animation';

interface Host {
  job(): Promise<{ width: number; height: number; shape: LogoShape; artwork: string; settings: SceneSetup['settings']; seed: number; composition: SceneSetup['composition']; particles?: number; v2?: SceneV2Setup['v2']; budget?: SceneV2Setup['budget'] }>;
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
    // V2 jobs (new productions) use the layered scene; V1 jobs (older projects) the original one
    const scene: { render(p: never, t: number): void; readPixels(o?: Uint8Array): Uint8Array } = job.v2 && job.budget ? new PCoreSceneV2(canvas, { ...job, v2: job.v2, budget: job.budget, artwork: img }) : new PCoreScene(canvas, { ...job, artwork: img });
    const px = new Uint8Array(job.width * job.height * 4);
    for (;;) {
      const batch = await host.next();
      if (!batch.length) break;
      for (const f of batch) {
        scene.render(f.p as unknown as never & PCoreFrameV2, f.t);
        await host.frame(scene.readPixels(px));
      }
    }
  } catch (e) {
    host.fail(String((e as Error)?.stack ?? e));
  }
})();
