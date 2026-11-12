# Build guide

## Requirements
- Node.js 22+ and npm.
- FFmpeg 6.1+ with ffprobe (libx264 recommended). Resolution order used by the app:
  1. `PRIMESTONE_FFMPEG_DIR` (folder containing `ffmpeg[.exe]` and `ffprobe[.exe]`)
  2. bundled `vendor/ffmpeg/` (dev) or `resources/ffmpeg/` (installed app)
  3. system `PATH`
- Linux headless test runs: `xvfb-run`.

## Develop

```bash
npm install
```

```bash
npm run build && npm start
```

`npm run build` bundles `src/main` and `src/preload` with esbuild and `src/renderer` with Vite into `dist/`.
Set `PRIMESTONE_DEVTOOLS=1` to keep the default menu (and DevTools shortcut).
Set `PRIMESTONE_USER_DATA=<dir>` to isolate settings/recent projects (used by tests).

## Test

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build && xvfb-run -a -s "-screen 0 1600x1000x24" npx playwright test --trace off
```

(On Windows/macOS run `npx playwright test --trace off` without xvfb.)

## Windows installer

```bash
npm run fetch:ffmpeg
```

```bash
npm run dist:win
```

`fetch:ffmpeg` downloads the BtbN FFmpeg 8.1 GPL build, checks its sha256 against the release's
checksum list, and installs `ffmpeg.exe`, `ffprobe.exe`, `LICENSE.txt` and `SOURCE.txt` into
`vendor/ffmpeg/`, which electron-builder copies to `resources/ffmpeg/`. Use
`node scripts/fetch-ffmpeg.mjs lgpl` for an LGPL build (no x264/x265; see LICENSES.md).
The installer (NSIS, per-user, choice of directory) is written to `release/`.
CI (`.github/workflows/ci.yml`) runs the same steps on `windows-latest` and uploads the installer.
