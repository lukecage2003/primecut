# User guide (v0.1)

## Create or open a project
On the Dashboard, type a name, choose a location and a sequence preset (HD 30/29.97/25/23.976,
UHD 30, Vertical 1080×1920), then **Create project**. A folder is created containing the project
file, `Autosave/`, `Backups/` and `Cache/`. **Open project…** or click a recent project to reopen.

If the app closed unexpectedly, reopening the project offers to **Recover** the newer autosave.
Media that moved with the project folder is found automatically; missing media is marked
**OFFLINE** in the library — click **Locate…** to relink (other missing files in the same folder
are relinked too).

## Import
Click **Import** or drop files on the Media panel. Files are referenced, never copied or modified.
Badges: duration, `VFR` (variable frame rate), `PROXY` (a preview proxy is in use).

## Edit
- Add a clip at the playhead: double-click it or press **+** on its card. Or drag it onto a track.
- Video files with sound create a linked video + audio pair (🔗); unlink in the Inspector.
- Click the ruler to move the playhead. Space plays/pauses, **J/K/L** play back/pause/forward,
  ←/→ step one frame (Shift: 10), Home/End jump.

| Key | Action |
|---|---|
| V | Selection tool: drag to move (also to another track), drag clip edges to trim |
| C | Razor: click a clip to cut it there |
| B | Ripple edit: trim and shift the following clips |
| N | Rolling edit: drag a cut between two adjacent clips |
| Y | Slip: change the part of the source shown |
| U | Slide: move a clip between its neighbours |
| S or Ctrl+K | Split at playhead (selected clips under the playhead, else all unlocked tracks) |
| Delete / Shift+Delete | Delete / ripple delete selection |
| M | Add marker (double-click a marker to delete it) |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S | Save |
| + / − / Ctrl+wheel | Zoom |

Track headers: 🔒 lock, ◉ show/hide video track, ♪/M mute audio track.
Inspector: scale, position, rotation, opacity (video) and gain (audio). Double-click a slider to reset.

## Export
**Export** → choose the output file → pick **Quality** (default), **Deep Quality** or **Balanced**,
codec and encoder → **Export**. Progress appears in **Tasks**; the file is verified before it
appears under its final name. **Show in folder** reveals it.

## Settings & diagnostics (⚙)
Theme, performance profile, autosave interval, and a read-only hardware report (CPU, RAM, GPU,
verified hardware encoders, FFmpeg build in use).

## Script-to-Video with your real scripts (v0.5)

**Script.** *Load script (PDF, .txt, .md)* accepts your production PDFs directly: timed headings
(`0:00 - 1:35 | INTRODUCTION`), `VISUELS —`, `Montage :`, `Texte : « … »`, `Source(s) comics :` and
annexes (`SOURCES`, `FICHE DE RIGUEUR`, `RÉALISATION`) are recognised; only the narration is synced
and subtitled. The converted script appears in the text box: check it and correct it if needed.

**Word-level sync (recommended).** Install one engine, once:
- *faster-whisper*: install Python 3.10+, then `python -m pip install faster-whisper`
  (add `nvidia-cublas-cu12 nvidia-cudnn-cu12` for the RTX GPU). Get a Whisper model folder in
  CTranslate2 format (e.g. “faster-whisper-small”, ≈ 0.5 GB, or “-medium”, ≈ 1.5 GB; MIT licence).
- or *whisper.cpp*: download a release build (CUDA build for NVIDIA) and a `ggml-*.bin` model.

Then in **Settings → Local transcription**: tick *Use local transcription*, select the engine and
the model, press **Check**. The narration is transcribed on your PC, never uploaded; the result is
cached in the project.

**Sound.** Music placed with the generator is lowered under the voice automatically (Inspector →
select the music clip → *Lower this track under* / *Ducking depth*). Procedural whooshes/impacts go
on the `SFX` track; delete them or lower the track if you don't want them (*Learn from my edits*
remembers it).

**Diagnostics.** Settings → *Save diagnostics report…* writes a JSON file (GPU/VRAM, CPU, RAM,
free space, a real 1080p encode benchmark, verified hardware encoders). Nothing is sent anywhere.
