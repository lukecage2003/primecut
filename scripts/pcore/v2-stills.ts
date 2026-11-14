/**
 * Contact sheet of P-CORE V2 frames from a narration window, with the real engine (director + renderer).
 * Run: node scripts/pcore/run-electron.mjs scripts/pcore/v2-stills.ts -- <narration> <out.png> --start 30 --dur 12 --preset hud [--size 540]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { renderPCore } from '../../src/main/pcoreRender';
import { DEFAULT_PCORE_SETTINGS } from '../../src/pcore/expression';
import { presetSettings, type PresetId } from '../../src/pcore/v2/config';
import { directPCore } from '../../src/pcore/v2/director';
import { analyzeVoice } from '../../src/pcore/audio';
import { decodePcm, pcoreFramesV2 } from '../../src/engine/pcore';
import { ffmpeg } from '../../src/engine/ffmpeg';

if (process.env.PRIMESTONE_SOFTWARE_GL === '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.on('window-all-closed', () => undefined);
const args = process.argv.slice(2).filter((a) => a !== '--no-sandbox');
const flag = (k: string, d: string) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1]! : d);
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
app.whenReady().then(async () => {
  try {
    const [narr, out] = pos as [string, string];
    const start = Number(flag('--start', '0'));
    const dur = Number(flag('--dur', '10'));
    const size = Number(flag('--size', '540'));
    const v2 = presetSettings(flag('--preset', 'hud') as PresetId);
    const pcm = await decodePcm(narr, start, dur, 4000);
    const cues = directPCore({ voice: analyzeVoice(pcm, 4000, { fps: 10 }), fps: 10, settings: v2 }).cues.map((c) => ({ ...c, start: c.start + start }));
    const frames = await pcoreFramesV2(narr, { offsetSec: start, durationSec: dur, fps: 30, cues, v2 });
    const pick = frames.filter((_, i) => i % 30 === 15);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcore-stills-'));
    await renderPCore({ width: size, height: size, fps: { num: 30, den: 1 }, frames: pick, settings: DEFAULT_PCORE_SETTINGS, composition: 'core', seed: 7, format: 'png-sequence', quality: 'standard', output: path.join(dir, 'seq'), v2 });
    const cols = Math.min(5, pick.length);
    await ffmpeg(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, 'seq', 'pcore_%06d.png'), '-vf', `premultiply=inplace=1,scale=360:360,tile=${cols}x${Math.ceil(pick.length / cols)}:color=0x050505`, '-frames:v', '1', out]);
    console.log('OK', out, cues.map((c) => `${c.start.toFixed(1)} ${c.expression}`).join(' | '));
    app.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    app.exit(1);
  }
});
