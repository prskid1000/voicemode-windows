# VoxType

Local voice dictation overlay for Windows. Press a hotkey, speak, release — text appears at your cursor in any app.

A self-hosted [Wispr Flow](https://wisprflow.ai) alternative. Everything runs on your machine: speech-to-text via [faster-whisper-server](https://github.com/fedirz/faster-whisper-server), optional cleanup via any local LLM in [LM Studio](https://lmstudio.ai), and (optional) TTS via [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). No cloud, no telemetry.

VoxType is a single Electron app that **owns** the Whisper and Kokoro child processes — they spawn when VoxType starts and die when it quits. One scheduled task, one tray icon, no per-service wrappers.

## Quick start

```powershell
git clone https://github.com/prskid1000/voicemode-windows.git "$env:USERPROFILE\.voicemode-windows"
cd "$env:USERPROFILE\.voicemode-windows"
.\setup.ps1
```

Setup will:
1. Install Whisper STT (`stt-venv`)
2. Install Kokoro TTS (`tts-venv` + Kokoro-FastAPI clone + 313 MB model) — skip with `-SkipKokoro`
3. Build the VoxType Electron app in place
4. Register a single scheduled task `VoxType-Dictation` that auto-starts at logon
5. Start VoxType immediately

That's it. Look for the tray icon, press **Ctrl+Win**, speak, release.

## Prerequisites

| Dependency | Why |
|---|---|
| Windows 10 / 11 | Target OS |
| Python 3.10+ | Whisper + Kokoro venvs |
| Node.js 18+ | Build VoxType (Electron) |
| Git | Clone Kokoro-FastAPI |
| ffmpeg (optional) | Some audio codecs |
| NVIDIA GPU + CUDA | Strongly recommended for Kokoro; Whisper works on CPU |
| [LM Studio](https://lmstudio.ai) (optional) | LLM cleanup of raw transcripts |

## How it works

```
                  Scheduled Task: VoxType-Dictation
                              │
                              ▼
                    electron.exe → VoxType
                    │                    │
                    ▼                    ▼
              spawns child         spawns child       (external)
              ┌──────────┐       ┌──────────┐       ┌──────────┐
              │ Whisper  │       │  Kokoro  │       │ LM Studio│
              │   :6600  │       │   :6500  │       │  :1234   │
              └──────────┘       └──────────┘       └──────────┘
```

VoxType is the parent. It launches Whisper (always, by default) and Kokoro (off by default — toggle from tray) as children, healthchecks them, restarts them on crash, and kills them cleanly when you quit. LM Studio is the only thing VoxType does not manage — it's a separate user app you launch yourself.

## VoxType pipeline

1. **Hotkey down** → start recording (mic stream pre-warmed at app start, no cold-start delay)
2. **Hotkey up** (or 2 s of silence in toggle mode) → audio sent to Whisper
3. **VAD gate** drops empty/silent recordings before they hit Whisper
4. **Transcription** returned (~0.5–1 s for 3 s of audio on a small model)
5. **LLM enhance** (optional) — raw transcript + screenshot of the active display + cursor marker sent to LM Studio with a structured-output schema; cleaned text returned
6. **Type at cursor** via clipboard → `Ctrl+V` (works in every Windows app)

## Tray menu

```
VoxType
├─ ◉ Hold to talk
├─ ◉ Toggle on/off
├─ Hotkey: Ctrl+Win              (click to rebind — single key like F9 also OK)
├─ Services
│   ├─ Whisper (STT) — ● ready
│   │   ├─ ☑ Enabled
│   │   ├─ Model: Tiny / Base / Small / Medium / Large v3
│   │   ├─ Device: GPU / CPU
│   │   └─ Restart now
│   ├─ Kokoro (TTS) — ○ off
│   │   ├─ ☐ Enabled
│   │   ├─ Voice: 15 curated voices
│   │   ├─ Device: GPU / CPU
│   │   └─ Restart now
│   └─ LM Studio (LLM)
│       ├─ ☑ Enhance transcript
│       ├─ ☑ Screen context (vision)
│       ├─ Model: (auto-detected)
│       ├─ Auto-unload after: Off / 5 / 10 / 15 / 30 / 60 min
│       ├─ ☑ Preload on startup
│       └─ Refresh models
├─ Recording
│   ├─ ☑ Auto-stop on silence
│   ├─ ☑ Skip silence (VAD)
│   └─ ☐ Append mode (preserve clipboard)
├─ History
│   ├─ ☑ Save history
│   └─ Recent (last 10 — click to copy)
├─ Pill
│   ├─ Show / Hide pill
│   └─ Reset position
└─ Quit
```

Status badges (`● ready` / `… starting` / `○ off`) refresh every 5 seconds.

## LLM enhancement (optional)

If LM Studio is running on `http://127.0.0.1:1234` with any model loaded, VoxType will send the raw Whisper transcript + a screenshot of your active display (with a red marker drawn at the cursor) to the LLM with a JSON-schema-constrained structured response:

```json
{
  "screen_context": "≤200 chars — active app + general UI",
  "cursor_focus":   "≤150 chars — what's at the red cursor marker",
  "edit_plan":      "≤300 chars — terse bullets of the edits applied",
  "output":         "the cleaned transcript (only field shown to user)"
}
```

The system prompt lives in [`voxtype/resources/system-prompt.md`](voxtype/resources/system-prompt.md) — edit it freely, no rebuild needed (read fresh on every call).

Vision-capable models (e.g. Qwen2.5-VL, Llama 3.2 Vision) get the screenshot to disambiguate names like "this function", "rename this to foo", correct casing of identifiers visible on screen, etc. Text-only models still work; they just ignore the image.

Disable from tray > Services > LM Studio if you want raw Whisper output.

## Logs and data

Everything VoxType writes lives under `~/.voxtype/`:

| File | Purpose | Lifecycle |
|---|---|---|
| `settings.json` | All tray settings | Persistent |
| `history.json` | Last 20 dictations (raw + enhanced) | Persistent — shown in tray |
| `debug.log` | Full main-process stdout/stderr (incl. Whisper/Kokoro child output) | **Truncated on every launch** |
| `sessions.jsonl` | One JSON per dictation: timings, model, screenshot flag, errors | **Truncated on every launch** |

The `debug.log` truncation matches telecode's pattern — every launch starts with a fresh log so you don't have to scroll past last week's noise to debug today's issue.

## Hotkey rebinding

Tray > `Hotkey: Ctrl+Win` opens capture mode:
1. Release every key on your keyboard so capture arms (avoids menu keystrokes leaking in)
2. Press one key alone (`F9`) or two keys together (`Ctrl+Space`)
3. Release

The new combo persists across restarts.

## Whisper models

| Model | Speed | Accuracy | VRAM |
|---|---|---|---|
| Tiny | Fastest | Basic | ~1 GB |
| Base | Fast | Good | ~1 GB |
| Small (default) | Balanced | Great | ~2 GB |
| Medium | Slower | Better | ~5 GB |
| Large v3 | Slowest | Best | ~10 GB |

Switching models in the tray restarts the Whisper child process — first dictation after switch downloads the model if it's new.

## Uninstall

```powershell
.\uninstall.ps1
```

Stops VoxType, removes the scheduled task, kills any orphaned child processes, optionally removes:
- `~/.voxtype/` (user settings + history + logs)
- `~/.voicemode/` (legacy directory from old voice-mode MCP, if present)
- `~/.voicemode-windows/` (install dir, ~3 GB with Kokoro)

## Known limits

- **Vision models add latency.** Screen-context cleanup adds 1–3 s on a 7 B vision model. Disable "Screen context" in tray for snappier text-only cleanup.
- **First Whisper run is slow.** New model downloads on first request — minutes for Large v3.
- **No Linux/macOS.** Windows-specific (uiohook keycodes, taskkill, electron transparent flags).

## Credits

- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) — fedirz
- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) — remsky
- [Wispr Flow](https://wisprflow.ai) — inspiration

## License

MIT
