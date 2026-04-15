# VoxType - Project Guide

## Overview

VoxType is a local Wispr Flow alternative for Windows. Press a hotkey, speak, release — text appears at your cursor. Built as a single Electron app that **owns the lifecycle of all bundled services** (Whisper STT, Kokoro TTS) — they spawn as child processes when VoxType starts and die when it quits. One scheduled task. No `.bat`/`.vbs` wrappers. No voice-mode MCP server.

## Project Structure

```
voicemode-windows/                  # repo IS the install directory
├── setup.ps1                       # Installer — installs venvs, builds VoxType, registers one scheduled task
├── uninstall.ps1                   # Removes task + (optionally) install dir + user data
├── voxtype/                        # Electron app
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json / tsconfig.node.json
│   ├── electron-builder.json
│   ├── src/
│   │   ├── main/
│   │   │   ├── index.ts            # App entry, IPC, pipeline, service lifecycle
│   │   │   ├── services.ts         # Child process manager (Whisper + Kokoro)
│   │   │   ├── debug-log.ts        # Truncates ~/.voxtype/{debug.log,sessions.jsonl} on startup, tees console
│   │   │   ├── hotkey.ts           # uiohook-napi: custom hotkeys, auto-repeat suppression
│   │   │   ├── stt.ts              # POST audio to Whisper child
│   │   │   ├── llm.ts              # POST transcript (+ screenshot) to LM Studio with JSON schema
│   │   │   ├── kokoro-voice.ts     # Kokoro voice catalog + preload helper
│   │   │   ├── whisper-model.ts    # Whisper model catalog
│   │   │   ├── screen-capture.ts   # desktopCapturer + cursor marker overlay
│   │   │   ├── typer.ts            # Clipboard + Ctrl+V via PowerShell
│   │   │   ├── tray.ts             # Grouped tray menu (Services / Recording / History / Pill)
│   │   │   ├── preload.ts          # contextBridge for renderer
│   │   │   ├── vad.ts              # Energy-based VAD
│   │   │   └── history.ts          # ~/.voxtype/history.json (last 20 entries)
│   │   ├── renderer/               # React UI (audio capture + pill overlay)
│   │   └── shared/types.ts         # AppSettings + IPC channels
│   ├── resources/
│   │   ├── icon.png
│   │   └── system-prompt.md        # LLM cleanup prompt — hot-reloaded, edit freely
│   └── dist/                       # Built output (electron loads from here)
├── README.md
├── CLAUDE.md                       # This file
├── LICENSE
└── .gitignore
```

## Install Directory Layout (after setup.ps1)

```
~/.voicemode-windows/                # repo + install (same dir)
├── stt-venv/                        # faster-whisper-server (Python venv)
├── tts-venv/                        # Kokoro PyTorch (Python venv) — optional
├── Kokoro-FastAPI/                  # Cloned repo + 313 MB model — optional
├── voxtype/                         # See above; built in place
└── (no .bat, no .vbs, no patches/, no configure-claude.ps1)

~/.voxtype/
├── settings.json                    # Persistent
├── history.json                     # Persistent — last 20 entries, shown in tray
├── debug.log                        # Truncated on every launch
└── sessions.jsonl                   # Truncated on every launch
```

`~/.voicemode/` is a legacy directory from the old voice-mode MCP integration. VoxType no longer reads or writes it. Safe to delete via `uninstall.ps1`.

## Architecture: VoxType owns its services

```
Scheduled Task: VoxType-Dictation
  └─ launches: electron.exe dist/main/main/index.js
       └─ on app.ready:
            ├─ if settings.whisperEnabled → spawn Whisper child (faster-whisper-server.exe)
            ├─ if settings.kokoroEnabled → spawn Kokoro child (uvicorn)
            ├─ build tray (status badges refresh every 5 s)
            └─ start hotkey listener
       └─ on app.before-quit:
            └─ taskkill /T (with timeout) → /F all child processes
```

`services.ts` is the only module that calls `spawn` / `taskkill`. It tracks each managed child:

```ts
interface Managed {
  proc: ChildProcess | null;
  config: WhisperConfig | KokoroConfig;
  ready: boolean;          // healthcheck passed
  stopping: boolean;       // suppresses auto-restart during intentional stop
  restartCount: number;    // exponential backoff on crash
  restartTimer: Timeout | null;
}
```

Healthcheck polls `http://127.0.0.1:<port>/health` until 200 (or 60 s timeout). Auto-restart on unexpected exit uses exponential backoff (1 s, 2 s, 4 s, … capped at 30 s).

Pattern adapted from telecode (`main.py:113-128`) — same SIGTERM-then-SIGKILL approach via `taskkill /T` and `taskkill /T /F`.

## VoxType Pipeline

1. **Hotkey down** (`hotkey.ts`) → `START_RECORDING` IPC to renderer
2. **Renderer** captures from pre-warmed mic stream, monitors RMS for auto-stop
3. **Hotkey up / silence** → audio Buffer sent back via `AUDIO_DATA` IPC
4. **`handleAudioData` in `index.ts`** kicks off in parallel:
   - Screen capture (`screen-capture.ts`) — only if `enhanceEnabled && screenContext`
   - Whisper transcription (`stt.ts`)
5. **VAD gate** drops empty/silent recordings before sending to Whisper
6. **LLM enhance** (`llm.ts`) — JSON-schema response with `{screen_context, cursor_focus, edit_plan, output}`. Only `output` is shown.
7. **Type at cursor** (`typer.ts`) — clipboard write + `Ctrl+V` via PowerShell
8. **Session record** appended to `~/.voxtype/sessions.jsonl`

## LLM Structured Output

System prompt at `voxtype/resources/system-prompt.md` (read fresh on every call — no rebuild needed for prompt tweaks).

Schema enforced by LM Studio's grammar-constrained decoding (`response_format: json_schema, strict: true`):

```json
{
  "screen_context": "string, maxLength 200",
  "cursor_focus":   "string, maxLength 150",
  "edit_plan":      "string, maxLength 300",
  "output":         "string, unbounded"
}
```

Scratch fields are bounded so the model can't blather and truncate the actual transcript. Scratch values are logged to `debug.log` for debugging.

Cursor marker (red ring + dot at the OS cursor position) is painted onto the captured bitmap before JPEG encoding — Electron's `desktopCapturer` doesn't include the OS cursor on Windows.

## Tray Menu (grouped)

| Top-level | Submenu |
|---|---|
| `◉ Hold to talk` / `◉ Toggle on/off` | (radio) |
| `Hotkey: …` | Click to rebind (single key or two-key combo) |
| `Services ▶` | Whisper, Kokoro, LM Studio (each with Enabled toggle, Model/Voice picker, Device GPU/CPU, Restart now) |
| `Recording ▶` | Auto-stop on silence, VAD, Append mode |
| `History ▶` | Save toggle + last 10 entries |
| `Pill ▶` | Show/Hide, Reset position |
| `Quit` | |

Status badges (`● ready` / `… starting` / `○ off`) live-poll `services.ts` and refresh every 5 s.

## Key Design Decisions

- **VoxType owns Whisper + Kokoro lifecycles** — not separate scheduled tasks. One task to install, one to uninstall, one to debug. Children die with parent (taskkill /T).
- **No .bat/.vbs wrappers** — `electron.exe` is a GUI binary so the scheduled task launches it directly. No console window appears, no shell layer to debug.
- **Whisper auto-spawns; Kokoro is opt-in.** VoxType itself doesn't consume TTS — Kokoro is provided for users who want a local TTS endpoint (e.g. for other apps). Default off saves ~3 GB of VRAM.
- **JSON Schema for LLM output** — grammar-constrained decoding makes structured output impossible to break. Per-field `maxLength` keeps scratch fields tiny so they don't eat the `output` budget.
- **System prompt as a separate file** — `resources/system-prompt.md` is read fresh on every enhance call. No rebuild needed to tweak prompt.
- **Debug log truncates on launch** — matches telecode pattern; each VoxType run starts with a fresh log.
- **History is separate from debug** — `~/.voxtype/history.json` stays persistent (user-visible in tray); `debug.log` and `sessions.jsonl` are scoped to the current run.
- **Hotkey auto-repeat suppression** — Windows fires `keydown` continuously while a key is held; `hotkey.ts` ignores repeats so toggle mode doesn't flip-flop.
- **Mic pre-warming** — `getUserMedia()` called once at app start so the first dictation is instant.
- **Cursor marker in screenshots** — Electron's `desktopCapturer` skips the OS cursor on Windows; we paint a red ring + dot ourselves at the cursor position before encoding.

## Common Tasks

### Run VoxType in dev mode
```powershell
cd voxtype && npm run dev
```

### Build VoxType after editing src/
```powershell
cd voxtype && npm run build:main && npx vite build
```

### Tail logs while debugging
```powershell
Get-Content -Path "$env:USERPROFILE\.voxtype\debug.log" -Wait -Tail 50
```

### Manually start / stop / restart
```powershell
schtasks /run /tn VoxType-Dictation
schtasks /end /tn VoxType-Dictation
```

### Test bundled services directly (when VoxType is running)
```powershell
curl http://127.0.0.1:6600/health   # Whisper
curl http://127.0.0.1:6500/health   # Kokoro (only if enabled in tray)
```

## Workflow Rules

- **Always rebuild VoxType `dist/` after committing source changes.** The repo and install location are the same directory, and the scheduled task launches `dist/main/main/index.js`. Source edits in `voxtype/src/` have no effect at runtime until `npm run build:main` (and `npx vite build` for renderer changes) is executed. After every commit that touches `voxtype/src/`, run the build immediately so the next launch picks up the change.
- **System prompt edits don't need a rebuild** — `resources/system-prompt.md` is read at runtime.
- **Don't delete `~/.voxtype/history.json`** when debugging — that's user-visible data. Use `debug.log` and `sessions.jsonl` for diagnostics.

## Dependencies

| Component | Version | Source |
|-----------|---------|--------|
| Electron | 35.x | npm |
| React | 19.x | npm |
| uiohook-napi | 1.5.x | npm |
| Tailwind CSS | 4.x | npm |
| faster-whisper-server | 0.0.2 | PyPI |
| Kokoro-FastAPI | 0.3.x | GitHub (remsky/Kokoro-FastAPI) |
| PyTorch | 2.8.x+cu129 | pytorch.org |

## Known Limitations

- **First model download is slow** — Whisper Large v3 can take minutes the first time it's selected.
- **Vision models add latency** — screen-context cleanup adds 1–3 s on a 7 B vision LLM. Disable in tray > Services > LM Studio > Screen context for snappier text-only cleanup.
- **Windows only** — uiohook keycodes, `taskkill`, transparent-window flags are all Windows-specific.
- **Small LLM hallucination** — 0.8 B models occasionally rewrite instead of clean up. Temperature 0 + structured output mitigate but don't eliminate.
