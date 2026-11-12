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
